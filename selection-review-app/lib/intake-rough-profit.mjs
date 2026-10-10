import { estimateDiscoveredProduct } from "./a-discovery-estimate.mjs";
import { categoryDefaultDimensions } from "./category-default-dimensions.mjs";
import { profitAtPurchase } from "./supplier-draft.mjs";

/**
 * 录入流水线最后一步的粗算：贴进来的拼多多 / 1688 货，在主人点「做这件」之前先估一个每件大概赚多少。
 *
 * 只是粗算，永远标 assumed：
 *   - 货源价：这件自己的货源（拼多多拼单价 / 1688 价）里有货的最低价；1688 找同款里首图一致、一件起订、更便宜的，就用那一家。
 *   - 售价：Ozon 以图搜里首图一致的最低价；没有一致的，取很像的那几条的中位价当参考。
 *   - 重量：货源页上读到的规格重量（取最重的那个，宁可算贵）；读不到就空着，等「做这件」时只问这一项。
 *   - 尺寸：按类目常见大小假设（lib/category-default-dimensions.mjs），国欧线路按物流表的申报价限价挑。
 *   - 佣金：还不知道 Ozon 类目，只在标题明确是官方佣金表里核对过的几类时按那一类估；认不出来就空着。
 * 正式利润照旧在「做这件」之后按真实尺寸、真实类目佣金重算（AGENTS.md §5）；这里的数不进 B，也不决定任何通过。
 */
export const INTAKE_ROUGH_PROFIT_SCHEMA = "intake-rough-profit-v1";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

/** 官方佣金表里已经用真实商品核对过的类型名；标题里认得出来才按它估，其余一律空着，不拿别的类目的费率顶。 */
const COMMISSION_TYPE_GUESSES = Object.freeze([
  { typeZh: "宠物服装", keywords: ["宠物衣", "宠物服", "狗衣", "狗狗衣", "猫衣", "猫咪衣", "宠物背心", "狗背心", "宠物雨衣", "狗雨衣", "宠物卫衣", "狗狗卫衣"] },
  { typeZh: "宠物躺床", keywords: ["宠物窝", "猫窝", "狗窝", "宠物床", "猫床", "狗床", "宠物垫", "猫垫", "狗垫"] },
  { typeZh: "娃娃服装", keywords: ["娃娃衣", "娃衣", "娃娃服"] },
  { typeZh: "音乐盒", keywords: ["音乐盒", "八音盒"] },
  { typeZh: "立体拼图", keywords: ["立体拼图", "3d拼图"] }
]);

export function roughCommissionTypeZh(title) {
  const value = text(title, 800).toLowerCase().replace(/\s+/g, "");
  if (!value) return null;
  return COMMISSION_TYPE_GUESSES.find((rule) => rule.keywords.some((word) => value.includes(word)))?.typeZh ?? null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2 * 100) / 100;
}

/** 这件自己的货源价：有货的规格里最低的拼单价 / 1688 价；规格上没价时用一件起批的阶梯价。 */
function ownSourcePurchase(capture, sourceKind) {
  const skus = (Array.isArray(capture?.skuChoices) ? capture.skuChoices : []).filter((sku) => sku?.inStock !== false && positive(sku?.priceCny));
  let goods = null;
  let skuId = null;
  if (skus.length) {
    const cheapest = skus.reduce((low, sku) => (sku.priceCny < low.priceCny ? sku : low));
    goods = cheapest.priceCny;
    skuId = cheapest.sourceSkuId ?? null;
  } else {
    const ranges = (Array.isArray(capture?.priceRanges) ? capture.priceRanges : []).filter((range) => positive(range?.priceCny));
    const onePiece = ranges.filter((range) => range.minimumQuantity === null || range.minimumQuantity <= 1);
    const pool = onePiece.length ? onePiece : ranges;
    if (pool.length) goods = Math.min(...pool.map((range) => range.priceCny));
  }
  if (goods === null) return null;
  const freight = capture?.pageFields?.unitDomesticFreightCny;
  const freightKnown = typeof freight === "number" && Number.isFinite(freight) && freight >= 0;
  return { rmb: Math.round((goods + (freightKnown ? freight : 0)) * 100) / 100, basis: sourceKind === "pinduoduo" ? "pinduoduo" : "1688_link",
    offerId: text(capture?.offerId, 80) || null, skuId, domesticFreightIncluded: freightKnown };
}

/** 1688 找同款里首图一致、一件起订、标了价的，最便宜的那一家（主人自己贴的那家不算）。 */
function matchedSupplierPurchase(record) {
  if (!isObject(record) || record.status !== "compared") return null;
  const usable = (Array.isArray(record.results) ? record.results : []).filter((item) => item?.similarity === "identical" &&
    item.isSourceOffer !== true && item.quantityBegin === 1 && positive(item.priceCny));
  if (!usable.length) return null;
  const cheapest = usable.reduce((low, item) => (item.priceCny < low.priceCny ? item : low));
  return { rmb: cheapest.priceCny, basis: "1688_match", offerId: cheapest.offerId, skuId: null, domesticFreightIncluded: false };
}

/** Ozon 售价参考：首图一致的最低价；没有一致的，取很像的中位价。 */
function ozonSalePrice(record) {
  if (!isObject(record) || record.status !== "compared") return null;
  const results = Array.isArray(record.results) ? record.results : [];
  const identical = results.filter((item) => item?.similarity === "identical" && positive(item.priceRub));
  if (identical.length) {
    const cheapest = identical.reduce((low, item) => (item.priceRub < low.priceRub ? item : low));
    return { rub: cheapest.priceRub, basis: "ozon_identical", productId: cheapest.productId ?? null, sampleCount: identical.length };
  }
  const similar = results.filter((item) => item?.similarity === "similar" && positive(item.priceRub));
  if (!similar.length) return null;
  return { rub: median(similar.map((item) => item.priceRub)), basis: "ozon_similar", productId: null, sampleCount: similar.length };
}

/** 粗算要用的事实，全部从这件商品已经存下的记录里读；读不到的写进 missing，不猜。 */
export function intakeRoughProfitPlan(candidate) {
  const capture = candidate?.sourceCapture?.status === "captured_waiting_owner_selection" ? candidate.sourceCapture : null;
  const sourceKind = candidate?.intake?.sourceKind;
  const own = capture ? ownSourcePurchase(capture, sourceKind) : null;
  const matched = matchedSupplierPurchase(candidate?.supplierImageMatch);
  const purchase = own && matched ? (matched.rmb < own.rmb ? matched : own) : own ?? matched;
  const salePrice = ozonSalePrice(candidate?.ozonImageMatch);
  const weights = (Array.isArray(capture?.skuChoices) ? capture.skuChoices : [])
    .map((sku) => (sku?.weight?.unit === "kg" && positive(sku.weight.value) ? sku.weight.value : null)).filter((value) => value !== null);
  const title = text(capture?.title, 800) || text(candidate?.productName, 800);
  const dimensions = categoryDefaultDimensions({ title });
  const commissionTypeZh = roughCommissionTypeZh(title);
  const missing = [];
  if (!purchase) missing.push("货源价");
  if (!salePrice) missing.push("Ozon 售价");
  if (!weights.length) missing.push("重量");
  if (!dimensions) missing.push("尺寸（认不出类目，没有常见大小可以假设）");
  if (!commissionTypeZh) missing.push("佣金（要先确认 Ozon 类目）");
  return { purchase, salePrice, weightKg: weights.length ? Math.max(...weights) : null, dimensions, commissionTypeZh, title, missing };
}

/**
 * 按计划算出 candidate.roughProfit。storeRule / fx / commission / tariffRows / packagingRmbDefault 由调用方用和找货、
 * 选规格同一套解析器读出来（lib/a-discovery-estimate-store.mjs），这里不碰网络。
 */
export function buildIntakeRoughProfit({ plan, storeRule, fx, commission, tariffRows, packagingRmbDefault, estimatedAt }) {
  const base = {
    schemaVersion: INTAKE_ROUGH_PROFIT_SCHEMA,
    assumed: true,
    estimatedAt,
    purchaseRmb: plan.purchase?.rmb ?? null,
    purchaseBasis: plan.purchase?.basis ?? null,
    purchaseOfferId: plan.purchase?.offerId ?? null,
    domesticFreightIncluded: plan.purchase?.domesticFreightIncluded ?? false,
    salePriceRub: plan.salePrice?.rub ?? null,
    priceBasis: plan.salePrice?.basis ?? null,
    priceProductId: plan.salePrice?.productId ?? null,
    priceSampleCount: plan.salePrice?.sampleCount ?? 0,
    weightKg: plan.weightKg,
    dimensionsBasis: plan.dimensions ? "category_default" : null,
    dimensionsLabel: plan.dimensions?.label ?? null,
    commissionTypeZh: plan.commissionTypeZh,
    commissionRate: null,
    revenueCny: null,
    freightRmb: null,
    route: null,
    profitPerUnitRmb: null,
    marginRate: null,
    passes: null
  };
  const missing = [...plan.missing];
  if (missing.length) return { ...base, status: "incomplete", missing };
  let estimate;
  try {
    estimate = estimateDiscoveredProduct({
      product: { productId: plan.salePrice.productId, price: plan.salePrice.rub, weightGrams: Math.round(plan.weightKg * 1000), dimensionMm: null },
      storeRule, fx, commission, tariffRows,
      assumptions: { packagingRmbDefault, allowAssumedDimensions: true, defaultDimensionsCm: plan.dimensions, enforcePriceLimit: true }
    });
  } catch (error) {
    return { ...base, status: "incomplete", missing: [`粗算没算成：${text(error?.message, 120)}`] };
  }
  const chosen = estimate.freight?.chosen ?? null;
  const known = { ...base, commissionRate: estimate.commission?.rate ?? null, revenueCny: estimate.revenueCny ?? null,
    freightRmb: chosen?.freightRmb ?? null, route: chosen?.route ?? null, dimensionsBasis: estimate.freight?.dimensionsBasis ?? base.dimensionsBasis };
  if (estimate.status === "incomplete") return { ...known, status: "incomplete", missing: [...estimate.missing] };
  const profit = profitAtPurchase({ estimate, allInPurchaseRmb: plan.purchase.rmb });
  if (!profit) return { ...known, status: "incomplete", missing: ["粗算没算成"] };
  return { ...known, status: profit.unitProfitRmb < 0 ? "negative" : "ok", profitPerUnitRmb: profit.unitProfitRmb,
    marginRate: profit.marginRate, passes: profit.passes, missing: [] };
}
