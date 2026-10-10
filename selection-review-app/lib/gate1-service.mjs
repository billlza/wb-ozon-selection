import { gate1BrandRisk, gate1OzonOptions, gate1Preselection, gate1SupplierOptions } from './gate1-preselect.mjs';
import { buildGate1RoughProfit, gate1PackageFacts } from './gate1-rough-profit.mjs';
import {
  Gate1Error, applyGate1Elimination, buildGate1Acceptance, buildGate1Skip, gate1Marker, gate1Open, gate1ShortfallPending,
  normalizeGate1AcceptInput, normalizeGate1ShortfallInput, normalizeGate1SkipInput, reopenGate1Round
} from './gate1-decision.mjs';

/**
 * 「做这件」卡的服务端：给商品页的那份显示数据，和三条写入路（做、不做、利润没过线之后怎么办）。
 *
 * 所有依赖由 server.mjs 注入：数据读写、时钟、官方输入（汇率、佣金、物流表、本店成本规则）、店铺档案的 recordSkipReason。
 * 这里不开浏览器、不派插件作业、不调 AI、不写平台。每一条写入都校验当前修订号，并在同一次 mutateData 里把记录、
 * 店铺档案那一条和历史一起存下（AGENTS.md §3.4）。
 */
export const GATE1_VIEW_SCHEMA_VERSION = 'gate1-view-v1';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function capturedWeightGrams(candidate) {
  const choices = Array.isArray(candidate?.sourceCapture?.skuChoices) ? candidate.sourceCapture.skuChoices : [];
  const weights = choices.map(item => (item?.weight?.unit === 'kg' && positive(item.weight.value) ? item.weight.value * 1000 : null))
    .filter(value => value !== null);
  return weights.length ? Math.round(Math.max(...weights)) : null;
}

function marketBrand(product) {
  if (typeof product?.brand === 'string') return product.brand;
  if (Array.isArray(product?.brand?.brandName)) return product.brand.brandName.find(name => typeof name === 'string') ?? null;
  return null;
}

function decisionSummary(decision) {
  if (!isObject(decision)) return null;
  return structuredClone(decision);
}

export function createGate1Service({ readData, mutateData, now, estimateInputs, readDiscoveryMarketRecord, recordSkipReason,
  storeProfileConfig, addHistory, publicCandidate, assertSafeCandidate, supplierDraftEstimate, categoryDefaultDimensionMm = null }) {
  for (const [name, value] of Object.entries({ readData, mutateData, now, readDiscoveryMarketRecord, recordSkipReason, addHistory,
    publicCandidate, assertSafeCandidate, supplierDraftEstimate })) {
    if (typeof value !== 'function') throw new TypeError(`GATE1_DEPENDENCY_INVALID:${name}`);
  }
  if (!isObject(estimateInputs)) throw new TypeError('GATE1_DEPENDENCY_INVALID:estimateInputs');

  /** 卡上的选项、软件先选的、粗算和品牌那一行。只读已保存的记录和官方输入，不碰平台。 */
  async function evidence(document, candidate) {
    const ozonOptions = gate1OzonOptions(candidate);
    const supplierOptions = gate1SupplierOptions(candidate);
    const preselection = gate1Preselection(candidate);
    const market = readDiscoveryMarketRecord({ document, candidate });
    const product = market?.status === 'available' ? market.product : null;
    const marketPriceRub = positive(product?.price) ? product.price : positive(candidate.expectedPriceRub) ? candidate.expectedPriceRub : null;
    const categoryPath = product?.categoryPath ?? null;
    const packageFacts = gate1PackageFacts({
      capturedWeightGrams: capturedWeightGrams(candidate), marketWeightGrams: product?.weightGrams ?? null,
      declaredWeightKg: candidate.packedWeightKg ?? null, marketDimensionMm: product?.dimensionMm ?? null,
      categoryDefaultDimensionMm: typeof categoryDefaultDimensionMm === 'function' ? categoryDefaultDimensionMm(categoryPath) : null
    });
    const supplierById = id => supplierOptions.find(row => row.offerId === id) ?? null;
    const ozonById = id => ozonOptions.find(row => row.productId === id) ?? null;
    const brand = marketBrand(product);
    return { ozonOptions, supplierOptions, preselection, marketPriceRub, categoryPath, packageFacts, marketBrand: brand,
      brandRisk: gate1BrandRisk({ marketBrand: brand, ozonTitle: ozonById(preselection.ozonProductId)?.title,
        supplierTitle: supplierById(preselection.supplierOfferId)?.title }) };
  }

  async function roughProfit(document, candidate, facts) {
    let storeRule;
    try { storeRule = estimateInputs.storeRule(document, candidate.targetStore); }
    catch { return null; }
    const at = now();
    const [fx, freight] = [await estimateInputs.resolveExchangeRate(document, at), await estimateInputs.resolveFreightRows()];
    const prices = [...facts.ozonOptions.map(row => ({ key: row.productId, priceRub: row.priceRub })),
      { key: 'market', priceRub: facts.marketPriceRub }];
    try {
      return await buildGate1RoughProfit({
        prices, suppliers: facts.supplierOptions, packageFacts: facts.packageFacts, categoryPath: facts.categoryPath, storeRule, fx,
        resolveCommission: priceRub => estimateInputs.resolveCommission({ categoryPath: facts.categoryPath, price: priceRub }, at),
        tariffRows: freight.rows, assumptions: estimateInputs.assumptions, builtAt: at,
        inputs: { fxSourceRef: fx?.sourceRef ?? null, tariffRuleVersion: freight.ruleVersion,
          costPolicyVersion: typeof storeRule?.pricingPolicyVersion === 'string' ? storeRule.pricingPolicyVersion : null }
      });
    } catch { return null; }
  }

  /** 商品页读的那一份。卡没打开时只给已经存下的决定和差额，不去算钱。 */
  async function view(document, candidate) {
    const base = { schemaVersion: GATE1_VIEW_SCHEMA_VERSION, candidateId: candidate.id, dataRevision: candidate.dataRevision,
      targetStore: candidate.targetStore ?? null, decision: decisionSummary(candidate.gate1DecisionV1),
      shortfall: gate1ShortfallPending(candidate) ? structuredClone(candidate.gate1ShortfallV1) : null,
      reopen: isObject(candidate.gate1ReopenV1) ? structuredClone(candidate.gate1ReopenV1) : null,
      rounds: Array.isArray(candidate.gate1RoundsV1) ? candidate.gate1RoundsV1.length : 0 };
    if (!gate1Open(candidate)) return { ...base, open: false };
    const facts = await evidence(document, candidate);
    return { ...base, open: true, ozonOptions: facts.ozonOptions, supplierOptions: facts.supplierOptions,
      preselection: facts.preselection, marketPriceRub: facts.marketPriceRub, marketBrand: facts.marketBrand,
      packageFacts: facts.packageFacts, brandRisk: facts.brandRisk, roughProfit: await roughProfit(document, candidate, facts) };
  }

  function revisionGuard(current, dataRevision) {
    if (!current) throw new Gate1Error(404, '候选不存在', 'candidate_not_found');
    if (Number(current.dataRevision) !== dataRevision) {
      throw new Gate1Error(409, '商品资料已变化，请刷新后再点', 'revision_conflict', { currentRevision: current.dataRevision });
    }
  }

  function finishWrite(current, at) {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = at;
    current.lastModifiedBy = 'user';
    assertSafeCandidate(current);
  }

  /** 做这件。先按读取时的那一版算好方案和估算，再在事务里核对修订号没变才一起写。 */
  async function accept({ candidateId, input: raw, actor }) {
    const input = normalizeGate1AcceptInput(raw);
    const snapshot = await readData();
    const seen = snapshot.candidates.find(item => item.id === candidateId);
    revisionGuard(seen, input.dataRevision);
    const facts = await evidence(snapshot, seen);
    const profit = await roughProfit(snapshot, seen, facts);
    const at = now();
    const built = buildGate1Acceptance({ candidate: seen, input, ozonOptions: facts.ozonOptions, supplierOptions: facts.supplierOptions,
      preselection: facts.preselection, marketPriceRub: facts.marketPriceRub, packageFacts: facts.packageFacts,
      brandRisk: gate1BrandRisk({ marketBrand: facts.marketBrand,
        ozonTitle: facts.ozonOptions.find(row => row.productId === input.ozonProductId)?.title,
        supplierTitle: facts.supplierOptions.find(row => row.offerId === input.supplierOfferId)?.title }),
      roughProfit: profit, decidedAt: at, decidedBy: actor?.userId ?? null });
    const estimate = await supplierDraftEstimate(snapshot, seen, built.draft);
    return mutateData(data => {
      const current = data.candidates.find(item => item.id === candidateId);
      revisionGuard(current, input.dataRevision);
      current.supplierDraftV1 = structuredClone(built.draft);
      current.supplierDraftEstimateV1 = estimate === null ? null : structuredClone(estimate);
      // 老卡片读的是这几列，和保存找货方案那条路一样一起填上，什么都不倒退。
      current.sourceUrl = built.draft.sourceUrl;
      current.purchasePriceRmb = built.draft.allInPurchaseRmb;
      current.domesticShippingRmb = built.draft.domesticShippingRmb;
      current.packedWeightKg = built.draft.packedWeightKg;
      current.dimensionsCm = { ...built.draft.dimensionsCm };
      current.expectedPriceRub = built.draft.targetSalePriceRub;
      current.gate1DecisionV1 = structuredClone(built.decision);
      current.gate1 = gate1Marker(built.decision);
      current.gate1ReopenV1 = null;
      addHistory(current, 'user', 'gate1Accepted', built.history, at);
      finishWrite(current, at);
      return { candidate: publicCandidate(current, data.rules), decision: structuredClone(built.decision) };
    });
  }

  /** 不做的那一套写入：店铺档案一条、关口 1 记录一条、商品退出正常处理、一句历史。 */
  function writeSkip(data, current, input, actor, at, from) {
    if (!storeProfileConfig) throw new Gate1Error(503, '店铺档案配置读不出来，这次没有记下不做的原因', 'store_profile_config_unavailable');
    // 没有店铺档案的店（比如还没起草档案的 WB）照样能不做，只是原因没有档案可记；这一点写进历史，不假装记过。
    let record = null;
    try {
      record = recordSkipReason(data, { targetStore: current.targetStore, candidateId: current.id, dataRevision: input.dataRevision,
        reason: input.reason, note: input.note, actor, at, config: storeProfileConfig });
    } catch (error) {
      if (error?.code !== 'STORE_UNKNOWN') throw error;
    }
    const decision = buildGate1Skip({ candidate: current, input, decidedAt: at, decidedBy: actor?.userId ?? null,
      skipRecordId: record?.skipId ?? null, from });
    current.gate1DecisionV1 = structuredClone(decision);
    current.gate1 = gate1Marker(decision);
    applyGate1Elimination(current, { reasonLabel: decision.reasonLabel, at });
    addHistory(current, 'user', 'gate1Skipped', `主人不做这件：${decision.reasonLabel}${decision.note ? `（${decision.note}）` : ''}；` +
      `${record ? '原因已记进店铺档案' : '这家店还没有店铺档案，原因只记在这件商品上'}，未派发任务、未访问平台，可以在「已淘汰」里恢复`, at);
    return decision;
  }

  async function skip({ candidateId, input: raw, actor }) {
    const input = normalizeGate1SkipInput(raw);
    return mutateData(data => {
      const current = data.candidates.find(item => item.id === candidateId);
      revisionGuard(current, input.dataRevision);
      if (!gate1Open(current)) throw new Gate1Error(409, '这件商品现在不在「做这件」这一步', 'gate1_not_open');
      const at = now();
      const decision = writeSkip(data, current, input, actor, at, 'gate1');
      finishWrite(current, at);
      return { candidate: publicCandidate(current, data.rules), decision: structuredClone(decision) };
    });
  }

  /** 正式利润没过线之后主人的选择。 */
  async function shortfall({ candidateId, input: raw, actor }) {
    const input = normalizeGate1ShortfallInput(raw);
    return mutateData(data => {
      const current = data.candidates.find(item => item.id === candidateId);
      revisionGuard(current, input.dataRevision);
      if (!gate1ShortfallPending(current)) throw new Gate1Error(409, '这件商品现在没有等你决定的利润差额', 'gate1_shortfall_not_pending');
      const at = now();
      if (input.choice === 'skip') {
        current.gate1ShortfallV1 = { ...current.gate1ShortfallV1, resolvedAt: at, resolution: 'skip' };
        writeSkip(data, current, input, actor, at, 'shortfall');
      } else {
        reopenGate1Round(current, { choice: input.choice, at, decidedBy: actor?.userId ?? null });
        addHistory(current, 'user', 'gate1Reopened', `正式利润没过线，主人选${input.choice === 'change_price' ? '改售价' : '换货源'}：` +
          '上一轮的方案和利润记录已整份留存，「做这件」卡重新打开；未派发任务、未访问平台', at);
      }
      finishWrite(current, at);
      return { candidate: publicCandidate(current, data.rules) };
    });
  }

  return Object.freeze({ view, accept, skip, shortfall });
}
