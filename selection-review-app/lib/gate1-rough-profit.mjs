import { estimateDiscoveredProduct } from './a-discovery-estimate.mjs';
import { profitAtPurchase } from './supplier-draft.mjs';

/**
 * 「做这件」卡上的粗算利润：和 Seerfar 粗算、找货估算同一套公式（estimateDiscoveredProduct + profitAtPurchase），
 * 不另写一套（走查清单第 6 条）。它永远是估算：assumed 恒为 true，不是正式利润，也不推进任何阶段（AGENTS.md §5.1）。
 *
 * 一张卡上主人可以换 Ozon 同款（售价跟着变）和换货源（进价跟着变），所以这里按「每个可选的 Ozon 价 × 每个可选的货源」
 * 各算一次，页面只按主人当前选的那一对取数，不在浏览器里再算钱。两边都有上限，算的次数有界。
 */
export const GATE1_ROUGH_PROFIT_SCHEMA_VERSION = 'gate1-rough-profit-v1';
export const GATE1_MAX_PRICE_OPTIONS = 8;
export const GATE1_MAX_SUPPLIER_OPTIONS = 10;
const MISSING_LABELS = Object.freeze({ 汇率: '汇率', 官方佣金: '官方佣金', 包装尺寸重量: '重量和尺寸', 可行物流线路: '可走的物流线路' });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * 粗算用的重量和尺寸，以及它们是从哪来的。重量优先用采到的，其次 Seerfar 记录；尺寸读不到时用调用方给的类目常见尺寸
 * （走查清单第 3 条），并标成 category_default。正式算利润时仍要真实尺寸，这里不替主人补。
 */
export function gate1PackageFacts({ capturedWeightGrams = null, marketWeightGrams = null, declaredWeightKg = null,
  capturedDimensionMm = null, marketDimensionMm = null, categoryDefaultDimensionMm = null } = {}) {
  const weightGrams = positive(capturedWeightGrams) ? capturedWeightGrams
    : positive(marketWeightGrams) ? marketWeightGrams
      : positive(declaredWeightKg) ? Math.round(declaredWeightKg * 1000) : null;
  const weightBasis = positive(capturedWeightGrams) ? 'captured' : positive(marketWeightGrams) ? 'seerfar' : positive(declaredWeightKg) ? 'declared' : null;
  const dimension = [['captured', capturedDimensionMm], ['seerfar_volume', marketDimensionMm], ['category_default', categoryDefaultDimensionMm]]
    .find(([, value]) => typeof value === 'string' && value.trim() !== '') ?? null;
  return Object.freeze({ weightGrams, weightBasis, dimensionMm: dimension?.[1] ?? null, dimensionsBasis: dimension?.[0] ?? null });
}

function summarize(estimate, packageFacts) {
  // 有重量没尺寸时物流表每条线都会因为「尺寸缺」被拒，估算说的是「没有可走线路」；真正缺的是尺寸，照这个说。
  const missing = estimate.missing.map(item => (item === '可行物流线路' && packageFacts.dimensionMm === null ? '尺寸'
    : MISSING_LABELS[item] ?? item));
  return Object.freeze({
    status: estimate.status,
    priceRub: estimate.priceRub,
    revenueCny: estimate.revenueCny,
    commissionRate: estimate.commission.rate,
    freightRmb: estimate.freight.chosen?.freightRmb ?? null,
    route: estimate.freight.chosen?.route ?? null,
    maximumAllInPurchaseRmb: estimate.ceiling?.maximumAllInPurchaseRmb ?? null,
    missing: Object.freeze(missing)
  });
}

/**
 * 按每一个售价、每一个货源算一次。`resolveCommission(priceRub)` 由调用方给：佣金按价格档位取，不同售价可能落在不同档。
 * 售价或货源一个都没有时返回的格子是空的，页面照实说「还算不了」。
 */
export async function buildGate1RoughProfit({ prices, suppliers, packageFacts, categoryPath = null, storeRule, fx,
  resolveCommission, tariffRows, assumptions, builtAt, inputs = {} }) {
  if (typeof resolveCommission !== 'function') throw new TypeError('GATE1_COMMISSION_RESOLVER_REQUIRED');
  const priceList = (Array.isArray(prices) ? prices : []).filter(item => isObject(item) && positive(item.priceRub))
    .slice(0, GATE1_MAX_PRICE_OPTIONS);
  const supplierList = (Array.isArray(suppliers) ? suppliers : []).filter(item => isObject(item) && typeof item.offerId === 'string')
    .slice(0, GATE1_MAX_SUPPLIER_OPTIONS);
  const byPrice = {};
  for (const price of priceList) {
    const commission = await resolveCommission(price.priceRub);
    const estimate = estimateDiscoveredProduct({
      product: { productId: price.key, price: price.priceRub, categoryPath, weightGrams: packageFacts.weightGrams,
        volumeLitres: null, dimensionMm: packageFacts.dimensionMm },
      storeRule, fx, commission, tariffRows, assumptions
    });
    const profits = {};
    for (const supplier of supplierList) {
      const profit = supplier.allInPurchaseRmb === null ? null : profitAtPurchase({ estimate, allInPurchaseRmb: supplier.allInPurchaseRmb });
      profits[supplier.offerId] = profit === null ? null : Object.freeze({
        allInPurchaseRmb: profit.allInPurchaseRmb, unitProfitRmb: profit.unitProfitRmb, marginRate: profit.marginRate,
        passes: profit.passes, minimumUnitProfitRmb: profit.minimumUnitProfitRmb, targetMarginRate: profit.targetMarginRate,
        thresholdPolicy: profit.thresholdPolicy, shippingAssumedZero: supplier.shippingKnown !== true
      });
    }
    byPrice[price.key] = Object.freeze({ estimate: summarize(estimate, packageFacts), profits: Object.freeze(profits) });
  }
  return Object.freeze({
    schemaVersion: GATE1_ROUGH_PROFIT_SCHEMA_VERSION,
    assumed: true,
    builtAt,
    weightBasis: packageFacts.weightBasis,
    dimensionsBasis: packageFacts.dimensionsBasis,
    weightGrams: packageFacts.weightGrams,
    byPrice: Object.freeze(byPrice),
    inputs: Object.freeze({ fxSourceRef: inputs.fxSourceRef ?? null, tariffRuleVersion: inputs.tariffRuleVersion ?? null,
      costPolicyVersion: inputs.costPolicyVersion ?? null })
  });
}
