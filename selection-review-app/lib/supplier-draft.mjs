import { normalizeSupplierCaptureSource } from './source-capture.mjs';
import { estimateDiscoveredProduct, parseSizeLimitCm, parseWeightLimitKg, pricingGuidance, roundDownCents } from './a-discovery-estimate.mjs';

/**
 * The owner's own supply plan for one product, before any extension capture exists.
 * `declaredBy: 'owner'` travels with the record: the owner saved this plan. Who gave each number is recorded too.
 * The plan the owner typed by hand is `provenance: 'owner_declared'` throughout. The plan saved from the 「做这件」
 * card mixes numbers the software read (the 1688 search card price, a Seerfar weight, …) with the few the owner typed,
 * so it carries `fieldSources` per field and is `owner_accepted_software_read` — no later card may present a number
 * the software read as one the owner declared (AGENTS.md §4.4, §5.3).
 * The module validates and arithmetically closes the declaration; it invents no price, freight or weight.
 */
export const SUPPLIER_DRAFT_SCHEMA_VERSION = 'supplier-draft-v1';
export const SUPPLIER_DRAFT_ESTIMATE_SCHEMA_VERSION = 'supplier-draft-estimate-v1';
export const SUPPLIER_DRAFT_INPUT_KEYS = Object.freeze([
  'dataRevision', 'sourceUrl', 'goodsPriceRmb', 'domesticShippingRmb', 'packedWeightKg',
  'dimensionsCm', 'targetSalePriceRub', 'note'
]);
const DIMENSION_KEYS = Object.freeze(['length', 'width', 'height']);
const DIMENSION_LABELS = Object.freeze({ length: '长度', width: '宽度', height: '高度' });
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_NOTE_LENGTH = 1000;

export class SupplierDraftError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'SupplierDraftError';
    this.status = status;
    this.code = code;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = (message, code) => { throw new SupplierDraftError(400, message, code); };
const cents = value => Math.round(value * 100) / 100;
const trimNumber = value => (typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(3)) : null);

function positive(value, label, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) reject(`${label}必须是大于0的数字`, code);
  return value;
}

function nonNegative(value, label, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) reject(`${label}必须是不小于0的数字，免运费请填0`, code);
  return value;
}

/** 包装长宽高（厘米），三项都要、都大于 0，多一项也不收。 */
function normalizeDimensionsCm(value) {
  if (!isObject(value)) reject('包装尺寸必须填写长宽高', 'supplier_draft_dimensions_invalid');
  for (const key of Object.keys(value)) {
    if (!DIMENSION_KEYS.includes(key)) reject('包装尺寸包含未声明字段', 'supplier_draft_dimensions_invalid');
  }
  const dimensionsCm = {};
  for (const key of DIMENSION_KEYS) {
    dimensionsCm[key] = positive(value[key], `包装${DIMENSION_LABELS[key]}`, 'supplier_draft_dimensions_invalid');
  }
  return dimensionsCm;
}

/** Closed input: an undeclared key is a rejected submission, never a silently ignored one. */
export function normalizeSupplierDraftInput(input) {
  if (!isObject(input)) reject('找货资料必须是对象', 'supplier_draft_input_invalid');
  for (const key of Object.keys(input)) {
    if (!SUPPLIER_DRAFT_INPUT_KEYS.includes(key)) reject('找货资料包含未声明字段', 'supplier_draft_field_forbidden');
  }
  if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
    reject('保存找货资料必须提供当前数据修订号', 'supplier_draft_revision_required');
  }
  const source = normalizeSupplierCaptureSource(input.sourceUrl);
  if (source.type === 'invalid') {
    reject('货源链接必须是1688商品详情链接或分享短链，或拼多多商品链接或分享短链', 'supplier_draft_source_url_invalid');
  }
  const goodsPriceRmb = cents(positive(input.goodsPriceRmb, '货价', 'supplier_draft_goods_price_invalid'));
  const domesticShippingRmb = cents(nonNegative(input.domesticShippingRmb, '国内运费', 'supplier_draft_domestic_shipping_invalid'));
  const packedWeightKg = positive(input.packedWeightKg, '打包重量', 'supplier_draft_weight_invalid');
  const dimensionsCm = normalizeDimensionsCm(input.dimensionsCm);
  const targetSalePriceRub = positive(input.targetSalePriceRub, '目标成交价RUB', 'supplier_draft_target_price_invalid');
  let note = null;
  if (input.note !== undefined && input.note !== null && input.note !== '') {
    if (typeof input.note !== 'string' || input.note.length > MAX_NOTE_LENGTH || CONTROL_CHARACTERS.test(input.note)) {
      reject('备注文本无效', 'supplier_draft_note_invalid');
    }
    note = input.note.trim() === '' ? null : input.note.trim();
  }
  return Object.freeze({
    dataRevision: input.dataRevision,
    sourceUrl: source.sourceUrl,
    sourceUrlType: source.type,
    offerId: source.offerId === '' ? null : source.offerId,
    goodsPriceRmb,
    domesticShippingRmb,
    allInPurchaseRmb: cents(goodsPriceRmb + domesticShippingRmb),
    packedWeightKg,
    dimensionsCm: Object.freeze(dimensionsCm),
    targetSalePriceRub,
    note
  });
}

/**
 * Where each number of a plan saved from the 「做这件」 card came from: `owner` is typed by the owner on that card,
 * anything else is what the software read there. Closed on both sides, so a caller cannot slip in a source no page
 * knows how to say out loud.
 */
export const SUPPLIER_DRAFT_FIELD_SOURCES = Object.freeze({
  goodsPriceRmb: Object.freeze({ '1688_image_search': '1688 搜图卡片上的价' }),
  domesticShippingRmb: Object.freeze({ '1688_price_note': '1688 价格说明里写的运费' }),
  packedWeightKg: Object.freeze({ captured: '采到的规格里最重的那个', seerfar: 'Seerfar 记录的同类商品重量', declared: '之前存下的重量' }),
  dimensionsCm: Object.freeze({ captured: '采到的尺寸', seerfar_volume: 'Seerfar 记录的同类商品尺寸' }),
  targetSalePriceRub: Object.freeze({ ozon_match: 'Ozon 同款现价', market_record: '市场记录的售价' })
});
export const SUPPLIER_DRAFT_OWNER_ORIGIN_LABEL = '你填的';

function normalizeFieldSources(fieldSources) {
  const keys = Object.keys(SUPPLIER_DRAFT_FIELD_SOURCES);
  if (!isObject(fieldSources) || Object.keys(fieldSources).length !== keys.length ||
      keys.some(key => fieldSources[key] !== 'owner' && !Object.hasOwn(SUPPLIER_DRAFT_FIELD_SOURCES[key], fieldSources[key]))) {
    throw new SupplierDraftError(500, '找货方案的字段来源无效', 'supplier_draft_field_sources_invalid');
  }
  return Object.freeze(Object.fromEntries(keys.map(key => [key, fieldSources[key]])));
}

/** The saved record. `provenance`, `declaredBy` and `fieldSources` are part of the data, not of the presentation layer. */
export function buildSupplierDraftV1(normalized, { declaredAt, fieldSources = null } = {}) {
  if (typeof declaredAt !== 'string' || !Number.isFinite(Date.parse(declaredAt))) {
    throw new SupplierDraftError(500, '保存找货资料缺少有效时间', 'supplier_draft_clock_invalid');
  }
  const sources = fieldSources === null ? null : normalizeFieldSources(fieldSources);
  const ownerOnly = sources === null || Object.values(sources).every(source => source === 'owner');
  return Object.freeze({
    schemaVersion: SUPPLIER_DRAFT_SCHEMA_VERSION,
    declaredBy: 'owner',
    declaredAt,
    sourceUrl: normalized.sourceUrl,
    sourceUrlType: normalized.sourceUrlType,
    offerId: normalized.offerId,
    goodsPriceRmb: normalized.goodsPriceRmb,
    domesticShippingRmb: normalized.domesticShippingRmb,
    allInPurchaseRmb: normalized.allInPurchaseRmb,
    packedWeightKg: normalized.packedWeightKg,
    dimensionsCm: { ...normalized.dimensionsCm },
    targetSalePriceRub: normalized.targetSalePriceRub,
    note: normalized.note,
    provenance: ownerOnly ? 'owner_declared' : 'owner_accepted_software_read',
    ...(sources === null ? {} : { fieldSources: sources })
  });
}

/**
 * 主人把方案里的包装尺寸改成实际的。「做这件」存下的尺寸常是 Seerfar 记录的同类商品尺寸，不是这件货量过的包装
 * （AGENTS.md §5.3）；主人量过或问过供应商之后在商品页上改。只换长宽高，这一项从此记成主人填的，别的数和它们的来源
 * 一个不动；返回新的一份方案，原来那份不改。输入是封闭的：只收修订号和长宽高。
 */
export const SUPPLIER_DRAFT_DIMENSIONS_INPUT_KEYS = Object.freeze(['dataRevision', 'dimensionsCm']);

export function normalizeSupplierDraftDimensionsInput(input) {
  if (!isObject(input) || Object.keys(input).some(key => !SUPPLIER_DRAFT_DIMENSIONS_INPUT_KEYS.includes(key))) {
    reject('改包装尺寸只接受当前数据修订号和长宽高', 'supplier_draft_field_forbidden');
  }
  if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
    reject('改包装尺寸必须提供当前数据修订号', 'supplier_draft_revision_required');
  }
  return Object.freeze({ dataRevision: input.dataRevision, dimensionsCm: Object.freeze(normalizeDimensionsCm(input.dimensionsCm)) });
}

export function reviseSupplierDraftDimensions(draft, { dimensionsCm, revisedAt, gate1Decision = null }) {
  if (!isObject(draft) || draft.schemaVersion !== SUPPLIER_DRAFT_SCHEMA_VERSION) {
    throw new SupplierDraftError(409, '这件商品还没有找货方案，先在「做这件」卡上点「做这件」', 'supplier_draft_missing');
  }
  if (typeof revisedAt !== 'string' || !Number.isFinite(Date.parse(revisedAt))) {
    throw new SupplierDraftError(500, '保存找货资料缺少有效时间', 'supplier_draft_clock_invalid');
  }
  const dimensions = normalizeDimensionsCm(dimensionsCm);
  const sources = Object.fromEntries(Object.values(supplierDraftOrigins(draft, { gate1Decision }))
    .map(origin => [origin.field, origin.source]));
  sources.dimensionsCm = 'owner';
  const normalizedSources = normalizeFieldSources(sources);
  return Object.freeze({
    ...draft,
    dimensionsCm: { ...dimensions },
    provenance: Object.values(normalizedSources).every(source => source === 'owner') ? 'owner_declared' : 'owner_accepted_software_read',
    fieldSources: normalizedSources,
    dimensionsRevisedAt: revisedAt
  });
}

/**
 * Who gave each number of a saved plan, as the page has to say it: `{ field, source, owner, label }`.
 * A plan without `fieldSources` was typed by hand — every number is the owner's — unless it is the plan a 「做这件」
 * decision saved before the plan carried its own sources: that decision kept them as `factSources`, written in the
 * same instant as the plan, so the decision of that very instant still says truthfully where each number came from.
 */
export function supplierDraftOrigins(draft, { gate1Decision = null } = {}) {
  let sources = isObject(draft?.fieldSources) ? draft.fieldSources : null;
  if (sources === null && gate1Decision?.decision === 'accept' && isObject(gate1Decision.factSources) &&
      typeof draft?.declaredAt === 'string' && gate1Decision.decidedAt === draft.declaredAt) {
    sources = gate1Decision.factSources;
  }
  return Object.freeze(Object.fromEntries(Object.keys(SUPPLIER_DRAFT_FIELD_SOURCES).map(field => {
    const source = sources?.[field] ?? 'owner';
    const label = source === 'owner' ? SUPPLIER_DRAFT_OWNER_ORIGIN_LABEL : SUPPLIER_DRAFT_FIELD_SOURCES[field][source] ?? '软件读的数';
    return [field, Object.freeze({ field, source, owner: source === 'owner', label })];
  })));
}

/** The declared package as the estimate module reads a product: millimetres, grams, and the owner's target price. */
export function supplierDraftEstimateProduct(draft, { productId = null, categoryPath = null } = {}) {
  const millimetres = key => Number((draft.dimensionsCm[key] * 10).toFixed(3));
  return {
    productId,
    price: draft.targetSalePriceRub,
    categoryPath,
    weightGrams: Number((draft.packedWeightKg * 1000).toFixed(3)),
    volumeLitres: null,
    dimensionMm: `${millimetres('length')}x${millimetres('width')}x${millimetres('height')}`
  };
}

/**
 * Why no route can carry this package, in the tariff table's own limits.
 * Every number comes from the saved GUOO rows through the estimate module's parsers; nothing is written in by hand.
 */
export function supplierDraftRouteBlock({ estimate, tariffRows }) {
  if (estimate?.freight?.status !== 'no_feasible_route') return null;
  const rows = Array.isArray(tariffRows) ? tariffRows : [];
  const sides = Array.isArray(estimate.freight.sidesCm) ? estimate.freight.sidesCm : null;
  const actualKg = estimate.freight.actualKg;
  const volumetricKg = estimate.freight.volumetricKg;
  const observedKg = actualKg ?? volumetricKg;
  const routes = [];
  let foldSideMaxCm = null;
  let bigParcelMinKg = null;
  for (const rejected of estimate.freight.rejectedRoutes ?? []) {
    const row = rows.find(value => value?.route === rejected.route) ?? null;
    const size = parseSizeLimitCm(row?.evidenceData?.sizeLimit ?? row?.sizeLimit);
    const weight = parseWeightLimitKg(row?.evidenceData?.weightLimit);
    let detail = rejected.reason;
    if (rejected.reason === 'side_outside_limit' && size?.sideMaxCm && sides) {
      detail = `单边最大 ${trimNumber(size.sideMaxCm[0])} 厘米，当前最长边 ${trimNumber(sides[0])} 厘米`;
      foldSideMaxCm = foldSideMaxCm === null ? size.sideMaxCm[0] : Math.max(foldSideMaxCm, size.sideMaxCm[0]);
    } else if (rejected.reason === 'size_sum_outside_limit' && size?.sumMaxCm !== null && sides) {
      detail = `三边之和不超 ${trimNumber(size.sumMaxCm)} 厘米，当前 ${trimNumber(sides[0] + sides[1] + sides[2])} 厘米`;
    } else if (rejected.reason === 'weight_outside_limit' && weight) {
      detail = `可走 ${trimNumber(weight.minKg)}-${trimNumber(weight.maxKg)} 公斤，当前 ${trimNumber(observedKg)} 公斤`;
      if (observedKg !== null && observedKg < weight.minKg) {
        bigParcelMinKg = bigParcelMinKg === null ? weight.minKg : Math.min(bigParcelMinKg, weight.minKg);
      }
    }
    routes.push({ route: rejected.route, reason: rejected.reason, detail });
  }
  const fold = foldSideMaxCm === null ? null : `需折叠到单边 ≤${trimNumber(foldSideMaxCm)} 厘米`;
  const big = bigParcelMinKg === null ? null : `按大件重量（≥${trimNumber(bigParcelMinKg)} 公斤）重新申报`;
  const advice = [fold, big].filter(Boolean).join('，或');
  return Object.freeze({
    code: 'no_feasible_route',
    message: advice === '' ? '当前尺寸重量没有可走的国欧线路。' : `当前尺寸重量没有可走的国欧线路，${advice}。`,
    foldSideMaxCm: foldSideMaxCm === null ? null : trimNumber(foldSideMaxCm),
    bigParcelMinKg: bigParcelMinKg === null ? null : trimNumber(bigParcelMinKg),
    routes: Object.freeze(routes.map(route => Object.freeze(route)))
  });
}

/**
 * What one all-in purchase price actually earns against one finished estimate.
 * `passes` follows the store's own thresholdPolicy: 'either' passes on the ¥ minimum or on the margin, 'both'
 * requires the two together. An estimate the software could not complete earns nothing here — it returns null rather
 * than a guessed number. This is the single profit formula in the A stage: the 找货 declaration and the per-variant
 * table both call it, so the two can never drift into different money for the same product.
 */
export function profitAtPurchase({ estimate, allInPurchaseRmb }) {
  if (!isObject(estimate) || estimate.status === 'incomplete' || !isObject(estimate.ceiling)) return null;
  if (typeof allInPurchaseRmb !== 'number' || !Number.isFinite(allInPurchaseRmb) || allInPurchaseRmb < 0) return null;
  const policy = estimate.costPolicy;
  const reserveRate = estimate.commission.rate + policy.advertisingReserveRate + policy.returnOpsReserveRate +
    policy.damageLossReserveRate + policy.withdrawalFeeRate;
  const unitProfitRmb = roundDownCents(estimate.revenueCny * (1 - reserveRate) - estimate.ceiling.nonPurchaseFixedRmb - allInPurchaseRmb);
  const marginRate = estimate.revenueCny > 0 ? Math.round(unitProfitRmb / estimate.revenueCny * 10000) / 10000 : null;
  const meetsMinimumUnitProfit = unitProfitRmb >= policy.minimumUnitProfitRmb;
  const meetsTargetMargin = marginRate !== null && marginRate >= policy.targetMarginRate;
  return {
    allInPurchaseRmb,
    revenueCny: estimate.revenueCny,
    unitProfitRmb,
    marginRate,
    thresholdPolicy: policy.thresholdPolicy,
    minimumUnitProfitRmb: policy.minimumUnitProfitRmb,
    targetMarginRate: policy.targetMarginRate,
    meetsMinimumUnitProfit,
    meetsTargetMargin,
    passes: policy.thresholdPolicy === 'both'
      ? meetsMinimumUnitProfit && meetsTargetMargin
      : meetsMinimumUnitProfit || meetsTargetMargin,
    withinPurchaseCeiling: allInPurchaseRmb <= estimate.ceiling.maximumAllInPurchaseRmb
  };
}

/**
 * The purchase ceiling for the declared package plus the profit the declared purchase price actually reaches.
 * An input the software could not evidence keeps the estimate incomplete and the profit null; it never becomes a
 * guessed number.
 */
export function buildSupplierDraftEstimate({ draft, storeRule, fx, commission, commissionTiers = null, tariffRows, assumptions, estimatedAt, inputs = {}, marketProduct = null }) {
  if (!isObject(draft)) throw new SupplierDraftError(500, '找货资料无效', 'supplier_draft_invalid');
  const product = supplierDraftEstimateProduct(draft, {
    productId: marketProduct?.productId ?? null,
    categoryPath: marketProduct?.categoryPath ?? null
  });
  const estimate = estimateDiscoveredProduct({ product, storeRule, fx, commission, tariffRows, assumptions });
  const profit = profitAtPurchase({ estimate, allInPurchaseRmb: draft.allInPurchaseRmb });
  // Owner question 2026-09-11: "目标成交价应该平台算给我看". Same FX, same reserves, same freight and the same official
  // rate ladder as the estimate above, read backwards into the prices that break even and that clear the threshold.
  // Without a usable rate ladder there is no guidance at all; a guessed rate would be worse than an empty panel.
  const guidance = estimate.status === 'incomplete' || estimate.ceiling === null
    ? null
    : pricingGuidance({
      fx: estimate.fx,
      tiers: Array.isArray(commissionTiers?.tiers) ? commissionTiers.tiers : [],
      costs: { allInPurchaseRmb: draft.allInPurchaseRmb, nonPurchaseFixedRmb: estimate.ceiling.nonPurchaseFixedRmb },
      policy: estimate.costPolicy,
      marketPriceRub: typeof marketProduct?.price === 'number' && Number.isFinite(marketProduct.price) ? marketProduct.price : null
    });
  return Object.freeze({
    schemaVersion: SUPPLIER_DRAFT_ESTIMATE_SCHEMA_VERSION,
    estimatedAt,
    declaredAt: draft.declaredAt ?? null,
    inputs: {
      fxSourceRef: inputs.fxSourceRef ?? null,
      fxRateDate: inputs.fxRateDate ?? null,
      commissionSourceRef: inputs.commissionSourceRef ?? null,
      tariffRuleVersion: inputs.tariffRuleVersion ?? null,
      costPolicyVersion: inputs.costPolicyVersion ?? null,
      packagingRmbDefault: assumptions.packagingRmbDefault,
      commissionTiersSourceRef: commissionTiers?.sourceRef ?? null
    },
    estimate,
    profitAtDeclaredPurchase: profit,
    pricingGuidance: guidance === null || guidance.status !== 'ok' ? null : guidance,
    routeBlock: supplierDraftRouteBlock({ estimate, tariffRows })
  });
}
