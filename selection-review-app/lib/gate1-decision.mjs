import { buildSupplierDraftV1, normalizeSupplierDraftInput, SupplierDraftError } from './supplier-draft.mjs';
import { GATE1_SKIP_REASONS, gate1PickTag } from './gate1-preselect.mjs';

/**
 * 「做这件」（关口 1）的三个决定：做、不做、正式利润没过线之后怎么办。
 *
 * 做：主人在一张卡上认了 Ozon 同款、1688 同款和货源。卡上的数由软件从找同款结果里读，读不到的只问缺的那一项；
 * 认下来的东西存成一份找货方案（supplierDraftV1，后面的采集、选规格、算利润都读它），另存一份关口 1 记录说清楚每个数
 * 从哪来、哪几格是主人改过的。这一步不确认供货、不下单、不碰平台，正式利润仍由 B 阶段算（AGENTS.md §4.4、§5）。
 *
 * 不做：原因写进店铺档案（lib/store-profile.mjs 的 recordSkipReason，由服务端在同一次事务里调用），商品退出正常处理。
 *
 * 正式利润没过线：做过关口 1 的商品不再直接淘汰，而是回到「需要你处理」，写明差多少，由主人选换货源、改售价或不做。
 * 换货源和改售价是主人明确要求的一轮新评审：旧的一轮整份追加进 gate1RoundsV1 保留，不覆盖（AGENTS.md §3.5）。
 */
export const GATE1_DECISION_SCHEMA_VERSION = 'gate1-decision-v1';
export const GATE1_SHORTFALL_SCHEMA_VERSION = 'gate1-shortfall-v1';
export const GATE1_SHORTFALL_CHOICES = Object.freeze({ change_supplier: '换货源', change_price: '改售价', skip: '不做' });
const ACCEPT_KEYS = Object.freeze(['dataRevision', 'ozonProductId', 'matchOfferId', 'supplierOfferId', 'facts']);
const FACT_KEYS = Object.freeze(['domesticShippingRmb', 'packedWeightKg', 'dimensionsCm', 'targetSalePriceRub']);
const SKIP_KEYS = Object.freeze(['dataRevision', 'reason', 'note']);
const SHORTFALL_KEYS = Object.freeze(['dataRevision', 'choice', 'reason', 'note']);
const OPEN_STATUSES = Object.freeze(['awaiting_user_direction', 'needs_user_data', 'codex_processing']);
const ID = /^[A-Za-z0-9_-]{1,40}$/u;
const FACT_LABELS = Object.freeze({ goodsPriceRmb: '货价', domesticShippingRmb: '国内运费', packedWeightKg: '打包重量',
  dimensionsCm: '包装长宽高', targetSalePriceRub: '目标成交价' });

export class Gate1Error extends Error {
  constructor(status, message, code, details = {}) {
    super(message);
    this.name = 'Gate1Error';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = (message, code, details) => { throw new Gate1Error(400, message, code, details); };
const conflict = (message, code, details) => { throw new Gate1Error(409, message, code, details); };
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function revision(input) {
  if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) reject('必须带上当前数据修订号', 'gate1_revision_required');
  return input.dataRevision;
}

function closedObject(input, keys, message, code) {
  if (!isObject(input) || Object.keys(input).some(key => !keys.includes(key))) reject(message, code);
  return input;
}

function optionalId(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) reject(`${label}无效`, 'gate1_input_invalid');
  return value;
}

/** 做这件：只收这几样。facts 只放软件读不到、主人在卡上补的那几项。 */
export function normalizeGate1AcceptInput(input) {
  closedObject(input, ACCEPT_KEYS, '做这件只接受修订号、选中的同款和货源，以及读不到时补的几项', 'gate1_input_invalid');
  const supplierOfferId = optionalId(input.supplierOfferId, '货源');
  if (supplierOfferId === null) reject('先选一家货源', 'gate1_supplier_required');
  const facts = {};
  if (input.facts !== undefined) {
    closedObject(input.facts, FACT_KEYS, '补的资料包含未声明字段', 'gate1_input_invalid');
    if (input.facts.domesticShippingRmb !== undefined) {
      if (!nonNegative(input.facts.domesticShippingRmb)) reject('国内运费必须是不小于 0 的数字，包邮填 0', 'gate1_fact_invalid');
      facts.domesticShippingRmb = input.facts.domesticShippingRmb;
    }
    for (const key of ['packedWeightKg', 'targetSalePriceRub']) {
      if (input.facts[key] === undefined) continue;
      if (!positive(input.facts[key])) reject(`${FACT_LABELS[key]}必须是大于 0 的数字`, 'gate1_fact_invalid');
      facts[key] = input.facts[key];
    }
    if (input.facts.dimensionsCm !== undefined) {
      const dims = closedObject(input.facts.dimensionsCm, ['length', 'width', 'height'], '包装尺寸只收长宽高', 'gate1_fact_invalid');
      if (!['length', 'width', 'height'].every(key => positive(dims[key]))) reject('长宽高都必须是大于 0 的厘米数', 'gate1_fact_invalid');
      facts.dimensionsCm = { length: dims.length, width: dims.width, height: dims.height };
    }
  }
  return Object.freeze({ dataRevision: revision(input), ozonProductId: optionalId(input.ozonProductId, 'Ozon 同款'),
    matchOfferId: optionalId(input.matchOfferId, '1688 同款'), supplierOfferId, facts: Object.freeze(facts) });
}

/** 不做这件：一个原因码，「其他」要带一句话。 */
export function normalizeGate1SkipInput(input) {
  closedObject(input, SKIP_KEYS, '不做这件只接受修订号、原因和一句备注', 'gate1_input_invalid');
  return Object.freeze({ dataRevision: revision(input), ...skipReason(input) });
}

function skipReason(input) {
  if (!Object.hasOwn(GATE1_SKIP_REASONS, input.reason)) reject('不做的原因只能选：尺寸太大、利润太薄、品牌风险、不想做这类、其他', 'gate1_reason_invalid');
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') reject('备注只能是文字', 'gate1_note_invalid');
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;
  if (note !== null && (note.length > 200 || /\p{Cc}/u.test(note))) reject('备注最多 200 个字的一行文字', 'gate1_note_invalid');
  if (input.reason === 'other' && note === null) reject('选「其他」时写一句为什么', 'gate1_note_required');
  return { reason: input.reason, note };
}

/** 正式利润没过线之后：换货源、改售价或不做；不做还要一个原因。 */
export function normalizeGate1ShortfallInput(input) {
  closedObject(input, SHORTFALL_KEYS, '只接受修订号、选择，以及不做时的原因', 'gate1_input_invalid');
  if (!Object.hasOwn(GATE1_SHORTFALL_CHOICES, input.choice)) reject('只能选换货源、改售价或不做', 'gate1_choice_invalid');
  if (input.choice !== 'skip') {
    if (input.reason !== undefined || input.note !== undefined) reject('换货源和改售价不带原因', 'gate1_input_invalid');
    return Object.freeze({ dataRevision: revision(input), choice: input.choice });
  }
  return Object.freeze({ dataRevision: revision(input), choice: 'skip', ...skipReason({ reason: input.reason ?? 'thin_profit', note: input.note }) });
}

/**
 * 卡在不在：还没做过关口 1、也还没走到 A 确认之后；老商品已经有手填的找货方案的，不再弹这张卡。
 * 正式利润没过线、主人选了换货源或改售价之后，卡重新打开（gate1ReopenV1）。
 */
export function gate1Open(candidate) {
  if (!isObject(candidate) || candidate.workflowStatus === 'eliminated' || !OPEN_STATUSES.includes(candidate.workflowStatus)) return false;
  if (candidate.lifecycleV11?.aConfirmationReceipt || candidate.lifecycleV11?.skuPackage) return false;
  // 做过的不再弹；不做之后又从「已淘汰」里恢复的，卡回来让主人重新判断。
  if (candidate.gate1DecisionV1?.decision === 'accept') return false;
  return candidate.supplierDraftV1 == null || isObject(candidate.gate1ReopenV1);
}

/**
 * 录入流水线（A）看 candidate.gate1 存不存在来判断「过没过第一关」，在就不再替它补搜。
 * 只是个标记；做没做、选了什么都在 gate1DecisionV1。重开一轮也保留，因为主人还在这张卡上挑，不需要流水线再动它。
 */
export function gate1Marker(decision) {
  return Object.freeze({ schemaVersion: 'gate1-marker-v1', decision: decision.decision, decidedAt: decision.decidedAt,
    roundIndex: decision.roundIndex ?? 0, record: 'gate1DecisionV1' });
}

/** 正式利润没过线、等主人选怎么办的那一刻。 */
export function gate1ShortfallPending(candidate) {
  return isObject(candidate?.gate1ShortfallV1) && candidate.gate1ShortfallV1.resolvedAt == null &&
    candidate.workflowStatus !== 'eliminated';
}

function dimensionsFromMm(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const [length, width, height] = value.trim().split(/[x×]/u).map(item => Math.round(Number(item) / 10 * 10) / 10);
  return [length, width, height].every(positive) ? { length, width, height } : null;
}

/**
 * 一格认下来的东西：主人选的那一条、软件先选的是哪一条、是不是主人改过的。
 */
function pick(options, idKey, chosenId, softwareId) {
  if (chosenId === null) return null;
  const row = options.find(item => item[idKey] === chosenId);
  if (!row) return undefined;
  return Object.freeze({ ...row, softwarePickId: softwareId ?? null, tag: gate1PickTag(softwareId ?? null, chosenId) });
}

/**
 * 卡上这一对（售价 × 货源）要存成找货方案的每一个数，以及它从哪来。读不到又没补的，列在 missing 里，一次说全。
 * 尺寸只认采到的和 Seerfar 的；类目常见尺寸只用于粗算，不进方案——正式算利润要真实尺寸（走查清单第 3 条）。
 */
export function gate1DraftFacts({ supplier, ozon, marketPriceRub, packageFacts, facts }) {
  const sources = {};
  const values = {};
  const missing = [];
  const take = (key, ownerValue, evidenceValue, evidenceSource) => {
    if (ownerValue !== undefined) { values[key] = ownerValue; sources[key] = 'owner'; return; }
    if (evidenceValue !== null && evidenceValue !== undefined) { values[key] = evidenceValue; sources[key] = evidenceSource; return; }
    missing.push(key);
  };
  take('goodsPriceRmb', undefined, supplier.priceCny, '1688_image_search');
  take('domesticShippingRmb', facts.domesticShippingRmb, supplier.domesticShippingRmb, '1688_price_note');
  const weightKg = positive(packageFacts?.weightGrams) ? Math.round(packageFacts.weightGrams) / 1000 : null;
  take('packedWeightKg', facts.packedWeightKg, weightKg, packageFacts?.weightBasis ?? null);
  const realDimensions = ['captured', 'seerfar_volume'].includes(packageFacts?.dimensionsBasis) ? dimensionsFromMm(packageFacts.dimensionMm) : null;
  take('dimensionsCm', facts.dimensionsCm, realDimensions, packageFacts?.dimensionsBasis ?? null);
  const price = ozon?.priceRub ?? null;
  take('targetSalePriceRub', facts.targetSalePriceRub, price ?? (positive(marketPriceRub) ? marketPriceRub : null),
    price !== null ? 'ozon_match' : 'market_record');
  return Object.freeze({ values: Object.freeze(values), sources: Object.freeze(sources), missing: Object.freeze(missing),
    missingLabels: Object.freeze(missing.map(key => FACT_LABELS[key])) });
}

/**
 * 做这件。返回要一起存的三样：找货方案、找货方案用的估算由调用方另算；关口 1 记录；历史那一句话。
 * 选中的东西不在这次找同款结果里、货源明确不能一件起订、或者缺资料，都在写之前拒绝。
 */
export function buildGate1Acceptance({ candidate, input, ozonOptions, supplierOptions, preselection, marketPriceRub = null,
  packageFacts, brandRisk, roughProfit = null, decidedAt, decidedBy }) {
  if (!gate1Open(candidate)) conflict('这件商品现在不在「做这件」这一步', 'gate1_not_open');
  const supplier = pick(supplierOptions, 'offerId', input.supplierOfferId, preselection.supplierOfferId);
  if (!supplier) conflict('这家货源不在这次 1688 找同款的同款候选里，请刷新后再选', 'gate1_supplier_unknown');
  if (supplier.quantityBegin !== null && supplier.quantityBegin > 1) {
    conflict(`这家货源 ${supplier.quantityBegin} 件起批，不满足一件起订，不能当货源`, 'gate1_supplier_moq');
  }
  const ozon = pick(ozonOptions, 'productId', input.ozonProductId, preselection.ozonProductId);
  if (ozon === undefined) conflict('这个 Ozon 商品不在这次 Ozon 找同款的同款候选里，请刷新后再选', 'gate1_ozon_unknown');
  const match = pick(supplierOptions, 'offerId', input.matchOfferId, preselection.matchOfferId);
  if (match === undefined) conflict('这个 1688 同款不在这次找同款结果里，请刷新后再选', 'gate1_match_unknown');
  const facts = gate1DraftFacts({ supplier, ozon, marketPriceRub, packageFacts, facts: input.facts });
  if (facts.missing.length) {
    reject(`还缺：${facts.missingLabels.join('、')}。软件读不到这几项，请在卡上补上再点「做这件」`, 'gate1_facts_missing',
      { missing: facts.missing });
  }
  let draft;
  try {
    draft = buildSupplierDraftV1(normalizeSupplierDraftInput({ dataRevision: input.dataRevision, sourceUrl: supplier.sourceUrl,
      goodsPriceRmb: facts.values.goodsPriceRmb, domesticShippingRmb: facts.values.domesticShippingRmb,
      packedWeightKg: facts.values.packedWeightKg, dimensionsCm: facts.values.dimensionsCm,
      targetSalePriceRub: facts.values.targetSalePriceRub, note: '在「做这件」卡上认下的方案' }), { declaredAt: decidedAt });
  } catch (error) {
    if (error instanceof SupplierDraftError) reject(error.message, error.code);
    throw error;
  }
  const priceKey = ozon ? ozon.productId : 'market';
  const profit = roughProfit?.byPrice?.[priceKey]?.profits?.[supplier.offerId] ?? null;
  const strip = row => row === null ? null : Object.freeze({ id: row.productId ?? row.offerId, title: row.title, sourceUrl: row.sourceUrl,
    imageUrl: row.imageUrl, priceRub: row.priceRub ?? null, priceCny: row.priceCny ?? null, similarity: row.similarity,
    judgement: row.judgement, softwarePickId: row.softwarePickId, tag: row.tag });
  const decision = Object.freeze({
    schemaVersion: GATE1_DECISION_SCHEMA_VERSION,
    decision: 'accept',
    decidedAt,
    decidedBy,
    sourceRevision: input.dataRevision,
    targetStore: candidate.targetStore ?? null,
    picks: Object.freeze({ ozon: strip(ozon), match: strip(match), supplier: strip(supplier) }),
    supplierMoqVerified: supplier.moqOne,
    factSources: facts.sources,
    brandRisk: brandRisk ?? null,
    roughProfitAtDecision: profit === null ? null : Object.freeze({ ...profit, assumed: true }),
    ozonMatchCaptureId: candidate.ozonImageMatch?.captureId ?? null,
    supplierMatchCaptureId: candidate.supplierImageMatch?.captureId ?? null,
    roundIndex: Array.isArray(candidate.gate1RoundsV1) ? candidate.gate1RoundsV1.length : 0,
    ownerSupplyConfirmed: false
  });
  const changed = ['ozon', 'match', 'supplier'].filter(key => decision.picks[key]?.tag === 'owner');
  const history = `主人在「做这件」卡上认下：Ozon 同款${ozon ? ` ${ozon.productId}` : '没选'}，货源 1688 ${supplier.offerId}` +
    `${changed.length ? `（改过 ${changed.length} 格）` : '（都是软件先选的）'}；已存成找货方案。没有确认供货、没有下单、没有向平台写任何东西`;
  return { draft, decision, history };
}

/** 不做这件那一份关口 1 记录；店铺档案那一条由调用方在同一事务里用 recordSkipReason 写。 */
export function buildGate1Skip({ candidate, input, decidedAt, decidedBy, skipRecordId = null, from = 'gate1' }) {
  return Object.freeze({
    schemaVersion: GATE1_DECISION_SCHEMA_VERSION,
    decision: 'skip',
    from,
    decidedAt,
    decidedBy,
    sourceRevision: input.dataRevision,
    targetStore: candidate.targetStore ?? null,
    reason: input.reason,
    reasonLabel: GATE1_SKIP_REASONS[input.reason],
    note: input.note,
    storeSkipRecordId: skipRecordId,
    roundIndex: Array.isArray(candidate.gate1RoundsV1) ? candidate.gate1RoundsV1.length : 0
  });
}

/** 不做之后，商品和列表里的「淘汰」一样退出正常处理；恢复走原来那条恢复路。 */
export function applyGate1Elimination(current, { reasonLabel, at }) {
  current.eliminatedFromStatus = current.workflowStatus;
  current.workflowStatus = 'eliminated';
  current.eliminatedAt = at;
  current.eliminationReason = `主人不做：${reasonLabel}`;
}

/**
 * 正式利润差多少。门槛是「单件利润 ≥ X 元 或 利润率 ≥ Y%」任一项，所以差额取两条里更容易补上的那一条。
 */
export function gate1ShortfallFromProfitModel(profitModel, { at }) {
  const thresholds = isObject(profitModel?.thresholds) ? profitModel.thresholds : {};
  const unit = Number(profitModel?.unitProfitRmb);
  const priceCny = Number(profitModel?.recommendedSalePriceCny);
  const minimumUnit = Number(thresholds.minimumUnitProfitRmb);
  const minimumMargin = Number(thresholds.minimumProfitMargin);
  const gaps = [];
  if (Number.isFinite(unit) && Number.isFinite(minimumUnit)) gaps.push(minimumUnit - unit);
  if (Number.isFinite(unit) && Number.isFinite(minimumMargin) && Number.isFinite(priceCny) && priceCny > 0) gaps.push(minimumMargin * priceCny - unit);
  const shortfallRmb = gaps.length ? Math.max(0, Math.ceil(Math.min(...gaps) * 100) / 100) : null;
  return Object.freeze({
    schemaVersion: GATE1_SHORTFALL_SCHEMA_VERSION,
    recordedAt: at,
    profitModelVersion: profitModel?.profitModelVersion ?? null,
    unitProfitRmb: Number.isFinite(unit) ? unit : null,
    profitMargin: Number.isFinite(Number(profitModel?.profitMargin)) ? Number(profitModel.profitMargin) : null,
    minimumUnitProfitRmb: Number.isFinite(minimumUnit) ? minimumUnit : null,
    minimumProfitMargin: Number.isFinite(minimumMargin) ? minimumMargin : null,
    recommendedSalePriceRub: Number.isFinite(Number(profitModel?.recommendedSalePriceRub)) ? Number(profitModel.recommendedSalePriceRub) : null,
    shortfallRmb,
    choices: Object.freeze(Object.keys(GATE1_SHORTFALL_CHOICES)),
    resolvedAt: null,
    resolution: null
  });
}

export function gate1ShortfallLine(shortfall) {
  const unit = shortfall.unitProfitRmb === null ? '没算出' : `¥${shortfall.unitProfitRmb.toFixed(2)}`;
  const margin = shortfall.profitMargin === null ? '' : `、利润率 ${(shortfall.profitMargin * 100).toFixed(1)}%`;
  const gap = shortfall.shortfallRmb === null ? '' : `，离门槛还差每件 ¥${shortfall.shortfallRmb.toFixed(2)}`;
  return `正式利润没过线：每件赚 ${unit}${margin}${gap}。选换货源、改售价或不做。`;
}

/**
 * B 阶段正式利润没过线时调用。做过关口 1 的商品回到「需要你处理」，等主人选；返回 false 表示这件不归关口 1 管，
 * 调用方照旧淘汰。B 的利润记录本身（lifecycleV11）不动：结论还是「利润不通过」，这里只改主人下一步。
 */
export function applyGate1Shortfall(current, { profitModel, at }) {
  if (current?.gate1DecisionV1?.decision !== 'accept') return false;
  const shortfall = gate1ShortfallFromProfitModel(profitModel, { at });
  current.gate1ShortfallV1 = shortfall;
  current.workflowStatus = 'needs_user_data';
  current.neededFields = [gate1ShortfallLine(shortfall)];
  return true;
}

/**
 * 换货源 / 改售价：主人明确要求的一轮新评审。旧的一轮（关口 1 记录、找货方案、B 的利润记录、差额）整份追加进
 * gate1RoundsV1，不改写；当前商品回到关口 1，卡重新打开。不派任务、不访问平台。
 */
export function reopenGate1Round(current, { choice, at, decidedBy }) {
  const shortfall = current.gate1ShortfallV1;
  const previous = current.gate1DecisionV1;
  const round = structuredClone({
    closedAt: at,
    closedBy: decidedBy,
    choice,
    decision: previous ?? null,
    shortfall: { ...shortfall, resolvedAt: at, resolution: choice },
    supplierDraftV1: current.supplierDraftV1 ?? null,
    supplierDraftEstimateV1: current.supplierDraftEstimateV1 ?? null,
    lifecycleV11: current.lifecycleV11 ?? null
  });
  current.gate1RoundsV1 = [...(Array.isArray(current.gate1RoundsV1) ? current.gate1RoundsV1 : []), round];
  current.gate1ReopenV1 = Object.freeze({
    choice, at, roundIndex: current.gate1RoundsV1.length,
    previousSupplierOfferId: previous?.picks?.supplier?.id ?? null,
    previousOzonProductId: previous?.picks?.ozon?.id ?? null,
    previousTargetSalePriceRub: current.supplierDraftV1?.targetSalePriceRub ?? null,
    shortfallRmb: shortfall?.shortfallRmb ?? null
  });
  current.gate1DecisionV1 = null;
  current.gate1ShortfallV1 = null;
  current.supplierDraftV1 = null;
  current.supplierDraftEstimateV1 = null;
  delete current.lifecycleV11;
  current.bPassedAt = null;
  current.workflowStatus = 'needs_user_data';
  current.neededFields = [choice === 'change_price' ? '上一轮正式利润没过线：在「做这件」卡上改售价后重新做这件。'
    : '上一轮正式利润没过线：在「做这件」卡上换一家货源后重新做这件。'];
}
