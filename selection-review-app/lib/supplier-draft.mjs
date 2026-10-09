import { normalize1688CaptureSource } from './source-capture.mjs';
import { estimateDiscoveredProduct, parseSizeLimitCm, parseWeightLimitKg, pricingGuidance, roundDownCents } from './a-discovery-estimate.mjs';

/**
 * The owner's own supply plan for one product, before any extension capture exists.
 * Everything here is declared by the owner and labelled as such: `provenance: 'owner_declared'` and `declaredBy:
 * 'owner'` travel with the record so no later card can present these numbers as captured platform evidence.
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

/** Closed input: an undeclared key is a rejected submission, never a silently ignored one. */
export function normalizeSupplierDraftInput(input) {
  if (!isObject(input)) reject('找货资料必须是对象', 'supplier_draft_input_invalid');
  for (const key of Object.keys(input)) {
    if (!SUPPLIER_DRAFT_INPUT_KEYS.includes(key)) reject('找货资料包含未声明字段', 'supplier_draft_field_forbidden');
  }
  if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
    reject('保存找货资料必须提供当前数据修订号', 'supplier_draft_revision_required');
  }
  const source = normalize1688CaptureSource(input.sourceUrl);
  if (source.type === 'invalid') {
    reject('1688链接必须是detail.1688.com商品详情链接或qr.1688.com分享短链', 'supplier_draft_source_url_invalid');
  }
  const goodsPriceRmb = cents(positive(input.goodsPriceRmb, '货价', 'supplier_draft_goods_price_invalid'));
  const domesticShippingRmb = cents(nonNegative(input.domesticShippingRmb, '国内运费', 'supplier_draft_domestic_shipping_invalid'));
  const packedWeightKg = positive(input.packedWeightKg, '打包重量', 'supplier_draft_weight_invalid');
  if (!isObject(input.dimensionsCm)) reject('包装尺寸必须填写长宽高', 'supplier_draft_dimensions_invalid');
  for (const key of Object.keys(input.dimensionsCm)) {
    if (!DIMENSION_KEYS.includes(key)) reject('包装尺寸包含未声明字段', 'supplier_draft_dimensions_invalid');
  }
  const dimensionsCm = {};
  for (const key of DIMENSION_KEYS) {
    dimensionsCm[key] = positive(input.dimensionsCm[key], `包装${DIMENSION_LABELS[key]}`, 'supplier_draft_dimensions_invalid');
  }
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

/** The saved record. `provenance` and `declaredBy` are part of the data, not of the presentation layer. */
export function buildSupplierDraftV1(normalized, { declaredAt }) {
  if (typeof declaredAt !== 'string' || !Number.isFinite(Date.parse(declaredAt))) {
    throw new SupplierDraftError(500, '保存找货资料缺少有效时间', 'supplier_draft_clock_invalid');
  }
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
    provenance: 'owner_declared'
  });
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
