import { estimateDiscoveredProduct } from './a-discovery-estimate.mjs';
import { profitAtPurchase, supplierDraftEstimateProduct } from './supplier-draft.mjs';

/**
 * 选规格 — what each captured specification of one 1688 offer is actually worth.
 *
 * The owner's 找货 declaration prices one imaginary average parcel. A real offer is 24 different parcels: the page
 * gives every specification its own price and its own shipping weight, so every specification has its own freight and
 * its own profit. This module works those out, one specification at a time.
 *
 * It computes nothing itself. Each row goes through exactly the engine and the inputs the 找货 estimate already uses
 * — `estimateDiscoveredProduct` with the official FX, the official commission, the saved GUOO rows, the store's cost
 * policy and the owner's own declared packing size, domestic freight and target price — and then through the single
 * `profitAtPurchase` formula. The only two things that change per row are the two facts the page itself declared:
 * that specification's goods price and that specification's weight.
 *
 * A specification whose weight the page never declared is left empty, never filled in from the owner's packed weight
 * or from a neighbouring specification: a borrowed weight would produce a freight and a profit that are simply not
 * about this specification. 2026-09-13 proved it on the dog raincoat: eight sizes from 103 g to 240 g, so one borrowed
 * weight would have mispriced the freight of every small size.
 *
 * The one exception is not the software's to take — see 同重同价声明 below. The owner may state, for one capture, that
 * its specifications are the same goods in different colours and are to be priced at the weight and goods price he
 * declared in 找货. Where he has stated it, the gap is filled from HIS declaration and every row says so
 * (`weightBasis` / `priceBasis` = `owner_declared`). Where he has not, nothing changes by a single byte.
 */
export const SKU_CHOICE_TABLE_SCHEMA_VERSION = 'sku-choice-table-v1';

/** A combined "黄色>XL" label is a worse column than the declared 颜色 and 尺码 it was built from. */
const COMBINED_ATTRIBUTE_KEY = '规格';
const MAX_SPECIFICATION_COLUMNS = 3;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * The kilograms this specification ships at, exactly as the capture kept them.
 * Anything else — no weight, a weight in another unit, a non-positive number — is "not declared", not a default.
 */
export function capturedSkuWeightKg(sku) {
  const weight = sku?.weight;
  if (finite(weight) && weight > 0) return weight;
  if (!isObject(weight) || String(weight.unit ?? '').trim().toLowerCase() !== 'kg') return null;
  return finite(weight.value) && weight.value > 0 ? weight.value : null;
}

/* ── 同重同价声明 ──────────────────────────────────────────────────────────────────────────────────────────────────
 * 主人 2026-09-16 的场景：小猫战术背心采回来 5 个规格，全是「均码」，只差颜色，重量和货价一个都没采到。同一件货的五
 * 个颜色，重量本来就该一样，而他在「找货」里已经填了打包重量和货价——可是整张表整列还是「待补」，死在这里。
 *
 * 解法不是让软件偷偷借一个数，是让主人签字。这份记录就是那一次签字本身：
 *   - 它只有主人显式声明才存在。没有它的时候，上面那条「不借重量」的规矩一个字都不让。
 *   - 它只对签字时那一次采集（captureId）有效。重新采过之后它自动失效，主人重新看一眼再签。
 *   - 它永远不覆盖真实数据：页面采到了重量或货价的那一行，用的还是采到的那一份。
 *   - 它不把数字抄进记录里当事实，只说「按我在找货里填的算」，所以「找货」改了，这张表跟着改，两处永远是同一个数。
 *     签字当时找货写的是多少，留在 basisAtDeclaration 里，作为这一次签字的存档。
 */
export const SKU_UNIFORM_SUPPLY_RECORD_VERSION = 'candidate-sku-uniform-supply-v1';
export const SKU_UNIFORM_SUPPLY_STEP_VERSION = 'sku-uniform-supply-step-v1';
export const SKU_UNIFORM_SUPPLY_LABEL = '同重同价声明';
/** 这一行的重量／货价是主人声明的，不是采到的。表里每一行都要能说出这句话。 */
export const OWNER_DECLARED_WEIGHT_SOURCE = 'owner_declared:supplierDraftV1.packedWeightKg';
export const OWNER_DECLARED_PRICE_SOURCE = 'owner_declared:supplierDraftV1.goodsPriceRmb';

const textOf = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const positive = value => (finite(value) && value > 0 ? value : null);

/** 主人在「找货」里填的那两个数，就是这份声明说的「按我填的算」。缺一个就是缺一个，不补。 */
export function ownerDeclaredSupplyBasis(draft) {
  return Object.freeze({
    packedWeightKg: positive(draft?.packedWeightKg),
    goodsPriceRmb: positive(draft?.goodsPriceRmb)
  });
}

/** 这一次采集里，这些规格的编号。签字签的是这一批，不是「这件商品以后所有的采集」。 */
function capturedSkuIds(capture) {
  return (Array.isArray(capture?.skuChoices) ? capture.skuChoices : [])
    .map(sku => textOf(sku?.sourceSkuId)).filter(id => id !== null);
}

/**
 * 主人签下的那一次声明。缺采集、缺规格、缺找货数字都不给签——签不出意义的字，不如当场说清楚为什么。
 */
export function buildOwnerSkuUniformSupplyRecord({ candidate, declaredAt }) {
  const candidateId = textOf(candidate?.id);
  const revision = Number(candidate?.dataRevision);
  if (candidateId === null || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('SKU_UNIFORM_SUPPLY_CANDIDATE_INVALID: 这件商品没有可用的编号或数据修订号');
  }
  if (typeof declaredAt !== 'string' || !Number.isFinite(Date.parse(declaredAt))) {
    throw new Error('SKU_UNIFORM_SUPPLY_DECLARED_AT_INVALID: 声明时间无效');
  }
  const capture = isObject(candidate?.sourceCapture) ? candidate.sourceCapture : null;
  const captureId = textOf(capture?.captureId);
  const sourceSkuIds = capturedSkuIds(capture);
  if (captureId === null || sourceSkuIds.length === 0) {
    throw new Error(`SKU_UNIFORM_SUPPLY_CAPTURE_MISSING: 这件商品现在没有一批可以声明的采集规格，先采集一次再来签${SKU_UNIFORM_SUPPLY_LABEL}。`);
  }
  const basis = ownerDeclaredSupplyBasis(candidate?.supplierDraftV1);
  if (basis.packedWeightKg === null || basis.goodsPriceRmb === null) {
    throw new Error(`SKU_UNIFORM_SUPPLY_DRAFT_MISSING: ${SKU_UNIFORM_SUPPLY_LABEL}说的是「按我在找货里填的算」，` +
      '所以要先在「找货」里填好打包重量和货价，这份声明才有东西可指。');
  }
  return {
    schemaVersion: SKU_UNIFORM_SUPPLY_RECORD_VERSION,
    declaredBy: 'owner',
    declaredAt,
    declaredRevision: revision,
    captureId,
    capturedAt: textOf(capture.observedAt),
    sourceSkuIds,
    // 存档用：签字当时「找货」写的是多少。算钱永远读当时的找货记录本身，不读这里，两处才不会各说各的。
    basisAtDeclaration: { packedWeightKg: basis.packedWeightKg, goodsPriceRmb: basis.goodsPriceRmb },
    headline: `这 ${sourceSkuIds.length} 个规格是同一件货的不同规格，没采到重量和货价的按你在「找货」里填的 ` +
      `${basis.packedWeightKg} 公斤 / ¥${basis.goodsPriceRmb.toFixed(2)} 算。`,
    sourceRef: `owner-sku-uniform-supply:${candidateId}:${revision}:${declaredAt}`
  };
}

/**
 * 这件商品现在有没有一份生效的声明。
 *   absent     — 没签过。整张表照旧，「待补」还是「待补」。
 *   in_force   — 签过，而且签的就是现在这一批采集。
 *   superseded — 签过，但那是上一次采集的事；重采之后它不再生效，也不静悄悄地消失。
 *   invalid    — 存着一份不是本软件写下的记录。不当成没有，也不拿来算钱。
 */
export function readSkuUniformSupplyDeclaration(candidate) {
  const record = candidate?.skuUniformSupplyV1;
  if (record === undefined || record === null) return { status: 'absent', record: null, reason: '' };
  if (!isObject(record) || record.schemaVersion !== SKU_UNIFORM_SUPPLY_RECORD_VERSION ||
      record.declaredBy !== 'owner' || textOf(record.captureId) === null || textOf(record.sourceRef) === null ||
      !Array.isArray(record.sourceSkuIds) || record.sourceSkuIds.length === 0) {
    return { status: 'invalid', record: null,
      reason: `已保存的${SKU_UNIFORM_SUPPLY_LABEL}不是本软件写下的格式，这张表现在按没有声明算；要用的话请重新声明一次。` };
  }
  const captureId = textOf(candidate?.sourceCapture?.captureId);
  if (captureId === null) {
    return { status: 'superseded', record,
      reason: `这件商品现在没有可用的采集结果，你签的那次${SKU_UNIFORM_SUPPLY_LABEL}没有可指的规格。` };
  }
  if (textOf(record.captureId) !== captureId) {
    return { status: 'superseded', record,
      reason: `你签的那次${SKU_UNIFORM_SUPPLY_LABEL}是对上一次采集说的。这一批规格是重新采回来的，所以它不再生效——` +
        '这一次采到了什么就按什么算，缺的话可以再签一次。' };
  }
  return { status: 'in_force', record, reason: '' };
}

/** 算钱那条路上唯一认的入口：生效的那一份，或者 null。 */
export function inForceSkuUniformSupply(candidate) {
  const read = readSkuUniformSupplyDeclaration(candidate);
  return read.status === 'in_force' ? read.record : null;
}

/**
 * Which specification columns this offer actually has, read from the captured attributes themselves.
 * Columns that differ between specifications are the ones worth a column; when nothing differs the first declared
 * attribute still names what the owner is looking at.
 */
export function skuChoiceColumns(choices) {
  const keys = [];
  const distinct = new Map();
  for (const sku of Array.isArray(choices) ? choices : []) {
    for (const [key, value] of Object.entries(isObject(sku?.attributes) ? sku.attributes : {})) {
      if (typeof key !== 'string' || key.trim() === '') continue;
      if (!distinct.has(key)) { keys.push(key); distinct.set(key, new Set()); }
      distinct.get(key).add(String(value));
    }
  }
  const varying = keys.filter(key => distinct.get(key).size > 1);
  const chosen = varying.length > 0 ? varying : keys.slice(0, 1);
  const specific = chosen.filter(key => key !== COMBINED_ATTRIBUTE_KEY);
  return (specific.length > 0 ? specific : chosen).slice(0, MAX_SPECIFICATION_COLUMNS);
}

/** How this one specification reads out loud, for a headline that has to name it. */
export function skuChoiceLabel(row) {
  const values = Array.isArray(row?.values) ? row.values.filter(value => typeof value === 'string' && value !== '') : [];
  if (values.length > 0) return values.join(' · ');
  const attributes = isObject(row?.attributes) ? Object.values(row.attributes).filter(value => typeof value === 'string' && value !== '') : [];
  if (attributes.length > 0) return attributes.join(' · ');
  return typeof row?.propPath === 'string' && row.propPath !== '' ? row.propPath : String(row?.sourceSkuId ?? '');
}

/**
 * 这一行实际按哪个重量、哪个货价算，以及那两个数是采到的还是主人声明的。
 *
 * 顺序永远是「采到的优先」：页面给了就用页面给的，声明只填页面没给的那一半。所以同一张表里可以一半是采集、一半是声明，
 * 各走各的，而一份声明永远盖不掉一个真实数据。`basis` 是 null 的时候（没签字），这里和 2026-09-16 之前逐字相同。
 */
function resolveOneSkuFacts(sku, basis) {
  const capturedKg = capturedSkuWeightKg(sku);
  const capturedPrice = finite(sku?.priceCny) && sku.priceCny > 0 ? sku.priceCny : null;
  const declaredKg = capturedKg === null ? (basis?.packedWeightKg ?? null) : null;
  const declaredPrice = capturedPrice === null ? (basis?.goodsPriceRmb ?? null) : null;
  return {
    weightKg: capturedKg ?? declaredKg,
    priceCny: capturedPrice ?? declaredPrice,
    weightDeclaredByOwner: declaredKg !== null,
    priceDeclaredByOwner: declaredPrice !== null
  };
}

function priceOneSku({ facts, draft, storeRule, fx, commission, tariffRows, assumptions, marketProduct }) {
  const { weightKg, priceCny } = facts;
  if (weightKg === null) return { status: 'weight_missing', missing: ['规格重量'], estimate: null, profit: null, allInPurchaseRmb: null };
  if (priceCny === null) return { status: 'price_missing', missing: ['货价'], estimate: null, profit: null, allInPurchaseRmb: null };
  // The owner's declared packing size, domestic freight and target price stay exactly as saved; only the weight and
  // the goods price come from this specification.
  const product = {
    ...supplierDraftEstimateProduct(draft, {
      productId: marketProduct?.productId ?? null,
      categoryPath: marketProduct?.categoryPath ?? null
    }),
    weightGrams: Number((weightKg * 1000).toFixed(3))
  };
  const estimate = estimateDiscoveredProduct({ product, storeRule, fx, commission, tariffRows, assumptions });
  const allInPurchaseRmb = Math.round((priceCny + draft.domesticShippingRmb) * 100) / 100;
  const profit = profitAtPurchase({ estimate, allInPurchaseRmb });
  return {
    status: profit === null ? 'not_priced' : 'ok',
    missing: profit === null ? [...estimate.missing] : [],
    estimate,
    profit,
    allInPurchaseRmb
  };
}

/**
 * The whole table, sorted the way the owner reads it: most profitable specification first.
 * Rows the software could not price keep their captured facts and sit at the end, marked, rather than being hidden
 * or filled in.
 */
export function buildSkuChoiceTable({
  choices, draft, storeRule, fx, commission, tariffRows, assumptions,
  marketProduct = null, selectedSkuIds = [], builtAt = null, inputs = {}, uniformSupply = null
}) {
  if (!isObject(draft)) throw new TypeError('SKU_CHOICE_TABLE_DRAFT_REQUIRED');
  const list = (Array.isArray(choices) ? choices : []).filter(sku => isObject(sku) && typeof sku.sourceSkuId === 'string' && sku.sourceSkuId !== '');
  const columns = skuChoiceColumns(list);
  const selected = [...new Set((Array.isArray(selectedSkuIds) ? selectedSkuIds : []).map(String))]
    .filter(id => list.some(sku => sku.sourceSkuId === id));
  // 只有主人签过、而且签的就是这一批采集的那份声明，才会走到这里；没有它的时候 basis 是 null，下面一个分支都不会开。
  const declaration = isObject(uniformSupply) && uniformSupply.schemaVersion === SKU_UNIFORM_SUPPLY_RECORD_VERSION
    ? uniformSupply : null;
  const basis = declaration === null ? null : ownerDeclaredSupplyBasis(draft);
  const appliedWeightSkuIds = [];
  const appliedPriceSkuIds = [];
  const rows = list.map((sku, index) => {
    const facts = resolveOneSkuFacts(sku, basis);
    if (facts.weightDeclaredByOwner) appliedWeightSkuIds.push(sku.sourceSkuId);
    if (facts.priceDeclaredByOwner) appliedPriceSkuIds.push(sku.sourceSkuId);
    const weightKg = facts.weightKg;
    const priced = priceOneSku({ facts, draft, storeRule, fx, commission, tariffRows, assumptions, marketProduct });
    const chosenRoute = priced.estimate?.freight?.chosen ?? null;
    const row = {
      order: index,
      sourceSkuId: sku.sourceSkuId,
      propPath: typeof sku.propPath === 'string' ? sku.propPath : null,
      attributes: isObject(sku.attributes) ? { ...sku.attributes } : {},
      values: columns.map(key => {
        const value = isObject(sku.attributes) ? sku.attributes[key] : undefined;
        return typeof value === 'string' ? value : finite(value) ? String(value) : null;
      }),
      imageUrl: typeof sku.imageUrl === 'string' ? sku.imageUrl : null,
      priceCny: facts.priceCny,
      stock: Number.isSafeInteger(sku.stock) && sku.stock >= 0 ? sku.stock : null,
      inStock: typeof sku.inStock === 'boolean' ? sku.inStock : null,
      weightKg,
      weightSource: facts.weightDeclaredByOwner ? OWNER_DECLARED_WEIGHT_SOURCE
        : typeof sku.weightSource === 'string' && sku.weightSource !== '' ? sku.weightSource : null,
      priceSource: facts.priceDeclaredByOwner ? OWNER_DECLARED_PRICE_SOURCE
        : typeof sku.priceSource === 'string' && sku.priceSource !== '' ? sku.priceSource : null,
      // 这一行的重量和货价，到底是采到的还是主人声明的。页面照这个说话，不去认字符串。
      weightBasis: weightKg === null ? null : facts.weightDeclaredByOwner ? 'owner_declared' : 'captured',
      priceBasis: facts.priceCny === null ? null : facts.priceDeclaredByOwner ? 'owner_declared' : 'captured',
      chargeableKg: chosenRoute?.chargeableKg ?? null,
      route: chosenRoute?.route ?? null,
      freightRmb: chosenRoute?.freightRmb ?? null,
      allInPurchaseRmb: priced.allInPurchaseRmb,
      // 算利润 has to show this one specification's profit as a list of deductions, and it has to ask "what would this
      // specification break even at". Both need the parts the row's own estimate already worked out, so the row carries
      // them out rather than letting a second place re-derive them from a neighbouring specification's estimate.
      revenueCny: priced.estimate?.revenueCny ?? null,
      commissionRate: priced.estimate?.commission?.rate ?? null,
      reserveRate: priced.estimate?.ceiling?.reserveRate ?? null,
      nonPurchaseFixedRmb: priced.estimate?.ceiling?.nonPurchaseFixedRmb ?? null,
      unitProfitRmb: priced.profit?.unitProfitRmb ?? null,
      marginRate: priced.profit?.marginRate ?? null,
      passes: priced.profit?.passes ?? null,
      status: priced.status,
      missing: priced.missing
    };
    row.label = skuChoiceLabel(row);
    return row;
  });
  // Most profitable first. A row without a profit has no place in that order, so it keeps its captured order at the end.
  const sorted = [...rows].sort((left, right) => {
    if (left.unitProfitRmb === null && right.unitProfitRmb === null) return left.order - right.order;
    if (left.unitProfitRmb === null) return 1;
    if (right.unitProfitRmb === null) return -1;
    return right.unitProfitRmb - left.unitProfitRmb || left.order - right.order;
  });
  const priced = sorted.filter(row => row.unitProfitRmb !== null);
  const best = priced[0] ?? null;
  const worst = priced.length > 1 ? priced[priced.length - 1] : null;
  const routes = [...new Set(priced.map(row => row.route).filter(route => typeof route === 'string' && route !== ''))];
  return Object.freeze({
    schemaVersion: SKU_CHOICE_TABLE_SCHEMA_VERSION,
    builtAt,
    columns,
    rows: sorted,
    total: sorted.length,
    pricedCount: priced.length,
    weightMissingCount: sorted.filter(row => row.status === 'weight_missing').length,
    best,
    worst,
    // "选错规格少赚多少" in the table's own two numbers, never a phrase written into the page.
    profitDropRate: best === null || worst === null || !(best.unitProfitRmb > 0)
      ? null
      : Math.round((best.unitProfitRmb - worst.unitProfitRmb) / best.unitProfitRmb * 10000) / 10000,
    selectedSkuIds: selected,
    // 这张表里有没有一部分数字是主人签字来的，签的是哪一次、顶了哪几行。没签过就是 null，整张表一如从前。
    uniformSupply: declaration === null ? null : Object.freeze({
      schemaVersion: SKU_UNIFORM_SUPPLY_RECORD_VERSION,
      declaredBy: 'owner',
      declaredAt: declaration.declaredAt ?? null,
      captureId: declaration.captureId,
      sourceRef: declaration.sourceRef,
      packedWeightKg: basis.packedWeightKg,
      goodsPriceRmb: basis.goodsPriceRmb,
      weightSource: OWNER_DECLARED_WEIGHT_SOURCE,
      priceSource: OWNER_DECLARED_PRICE_SOURCE,
      appliedWeightSkuIds: Object.freeze([...appliedWeightSkuIds]),
      appliedPriceSkuIds: Object.freeze([...appliedPriceSkuIds])
    }),
    sources: skuChoiceSources({ draft, storeRule, fx, commission, routes, inputs, assumptions })
  });
}

/**
 * 「选规格」上那一小块：这一批采到的规格缺不缺重量和货价、主人签过没有、签的是不是这一次，以及一次点击会声明什么。
 *
 * 它自己不算钱，整份来自已保存的记录和上面那张表。没有表就没有这一块——没有规格的时候没有事要主人做。
 */
export function buildSkuUniformSupplyStep({ candidate, draft, table }) {
  if (!isObject(table) || !Array.isArray(table.rows) || table.rows.length === 0) return null;
  const read = readSkuUniformSupplyDeclaration(candidate);
  const basis = ownerDeclaredSupplyBasis(draft);
  const weightGapCount = table.rows.filter(row => row.status === 'weight_missing').length;
  const priceGapCount = table.rows.filter(row => row.status === 'price_missing').length;
  const gapCount = weightGapCount + priceGapCount;
  const applied = isObject(table.uniformSupply) ? table.uniformSupply : null;
  const draftReady = basis.packedWeightKg !== null && basis.goodsPriceRmb !== null;
  return Object.freeze({
    schemaVersion: SKU_UNIFORM_SUPPLY_STEP_VERSION,
    candidateId: textOf(candidate?.id),
    dataRevision: Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
    label: SKU_UNIFORM_SUPPLY_LABEL,
    status: read.status,
    declared: read.status === 'in_force',
    // 只有还有缺项、而且「找货」里那两个数都填了，这一次签字才有意义。别的时候连提议都不提。
    offered: read.status !== 'in_force' && gapCount > 0 && draftReady,
    blockedReason: read.status === 'in_force' || gapCount === 0 ? ''
      : !draftReady ? `${SKU_UNIFORM_SUPPLY_LABEL}说的是「按我在找货里填的算」，先在上面「找货」里填好打包重量和货价。` : '',
    // 上一次签的字为什么不算数（重新采过了 / 记录坏了）。没有就是空的，页面不会凭空说一句。
    lapsedReason: read.reason,
    total: table.rows.length,
    gapCount,
    weightGapCount,
    priceGapCount,
    basis: { packedWeightKg: basis.packedWeightKg, goodsPriceRmb: basis.goodsPriceRmb },
    declaredAt: read.status === 'in_force' ? (read.record.declaredAt ?? null) : null,
    declaredRevision: read.status === 'in_force' ? (read.record.declaredRevision ?? null) : null,
    basisAtDeclaration: read.status === 'in_force' && isObject(read.record.basisAtDeclaration)
      ? { ...read.record.basisAtDeclaration } : null,
    appliedWeightCount: applied === null ? 0 : applied.appliedWeightSkuIds.length,
    appliedPriceCount: applied === null ? 0 : applied.appliedPriceSkuIds.length,
    sourceRef: read.status === 'in_force' ? read.record.sourceRef : null
  });
}

/** Every number in the table, traced to the record it came from. Nothing here is written by the page. */
function skuChoiceSources({ draft, storeRule, fx, commission, routes, inputs, assumptions }) {
  const rate = key => (finite(storeRule?.[key]) ? storeRule[key] : 0);
  const reserveParts = {
    advertisingReserveRate: rate('advertisingReserveRate'),
    returnOpsReserveRate: rate('returnOpsReserveRate'),
    damageLossReserveRate: rate('damageLossReserveRate'),
    withdrawalFeeRate: rate('withdrawalFeeRate')
  };
  return Object.freeze({
    targetSalePriceRub: draft.targetSalePriceRub,
    rubPerCny: finite(fx?.rubPerCny) ? fx.rubPerCny : null,
    fxRateDate: typeof fx?.rateDate === 'string' ? fx.rateDate : null,
    fxSourceRef: typeof fx?.sourceRef === 'string' ? fx.sourceRef : null,
    commissionRate: finite(commission?.rate) ? commission.rate : null,
    commissionTier: typeof commission?.tier === 'string' ? commission.tier : null,
    commissionSourceRef: typeof commission?.sourceRef === 'string' ? commission.sourceRef : null,
    routes,
    tariffRuleVersion: typeof inputs?.tariffRuleVersion === 'string' ? inputs.tariffRuleVersion : null,
    domesticShippingRmb: draft.domesticShippingRmb,
    // 每单额外操作费：这张表实际是按哪个数算出来的。它从 2026-09-15 起是这件商品自己声明的合计，不再是项目假设值——
    // `extraHandlingDeclared` 说的就是这一点，页面必须照它说话，没声明的时候不能装作有声明。
    packagingRmbDefault: finite(assumptions?.packagingRmbDefault) ? assumptions.packagingRmbDefault : null,
    extraHandlingDeclared: assumptions?.extraHandlingDeclared === true,
    labelCostRmb: rate('labelCostRmb'),
    reserveParts,
    reserveRate: Math.round(Object.values(reserveParts).reduce((total, value) => total + value, 0) * 10000) / 10000,
    dimensionsCm: { ...draft.dimensionsCm }
  });
}
