/**
 * Seerfar 方案 B 的"怎么筛"：一页榜单结果里哪些值得收进来。全部是固定规则，不用 AI，不需要主人确认，结果只决定
 * "收不收进候选"，不是供货结论，也不是正式利润（AGENTS.md §4.2、§5）。每个没收的商品都带一行原因，页面原样显示。
 *
 * 利润只用 a-discovery-estimate.mjs 的粗算采购上限；调用方先算好再传进来，这里不读佣金、汇率或运费。
 */
import { roundDownCents } from './a-discovery-estimate.mjs';
import { SEERFAR_WEB_RAW_SELLER_TYPE_CROSS_BORDER, seerfarCategoryMatches } from './seerfar-web-discovery-contract.mjs';

export const SEERFAR_SCREENING_SCHEMA = 'seerfar-selection-screening-v1';
/** 上架不到这么多天算"新品"，只作标记显示，不加权（培训"近 90 天新品"口径）。 */
export const NEW_LISTING_DAYS = 90;

export const SCREENING_DROP_REASONS = Object.freeze({
  already_seen: '以前收过、做过或淘汰过这个商品，不重复收',
  hot_item_itself: '这就是拿来找相似的那件爆款本身',
  category_excluded: '店铺档案里写了不做这个类目',
  not_cross_border: '不是跨境卖家',
  price_out_of_band: '售价不在店铺档案的价格带里',
  weight_unknown: '页面没给重量，算不了运费',
  too_heavy: '超过店铺档案的重量上限',
  sales_below_line: '近 30 天销量低于店铺档案的销量线',
  estimate_incomplete: '粗算利润缺资料',
  profit_negative: '粗算下来最高能接受的采购价不到 0，怎么进货都亏',
  below_top_k: '过了全部筛选，但这一轮只收排在前面的几个'
});

const finite = value => typeof value === 'number' && Number.isFinite(value);

function drop(product, code, detail = '') {
  return { productId: product.productId, title: product.title, code, reason: detail ? `${SCREENING_DROP_REASONS[code]}（${detail}）` : SCREENING_DROP_REASONS[code] };
}

function newListing(product, businessTime) {
  const listed = product.webMetrics?.listedAt;
  if (typeof listed !== 'string') return false;
  return Date.parse(businessTime) - Date.parse(listed) <= NEW_LISTING_DAYS * 86400000;
}

/**
 * products: normalized member-site products (seerfar-web-discovery-contract.mjs).
 * estimates: Map productId → estimateDiscoveredProduct(...) result, computed by the caller for every product.
 * knownProductIds: Set of Ozon product ids already on any candidate, eliminated ones included.
 */
export function screenSeerfarProducts({ products, query, profile, knownProductIds, estimates, businessTime }) {
  if (!Array.isArray(products) || !query || !profile || !(knownProductIds instanceof Set) || !(estimates instanceof Map) ||
      !Number.isFinite(Date.parse(businessTime))) {
    throw new TypeError('SEERFAR_SCREENING_INPUT_INVALID');
  }
  const dropped = [], passed = [];
  const hotIds = new Set(query.excludeMarketProductIds || []);
  const band = query.priceRub;
  for (const product of products) {
    const weight = product.webMetrics?.weightGrams;
    if (hotIds.has(product.productId)) { dropped.push(drop(product, 'hot_item_itself')); continue; }
    if (knownProductIds.has(product.productId)) { dropped.push(drop(product, 'already_seen')); continue; }
    if (profile.excludedCategoryPaths.some(entry => seerfarCategoryMatches(product.categoryPath?.cnTitlePath, entry))) { dropped.push(drop(product, 'category_excluded', product.categoryPath.cnTitlePath)); continue; }
    if (query.sellerType === 'cross_border' && product.rawSellerType !== SEERFAR_WEB_RAW_SELLER_TYPE_CROSS_BORDER) { dropped.push(drop(product, 'not_cross_border')); continue; }
    if (band && ((band.min !== null && product.price < band.min) || (band.max !== null && product.price > band.max))) {
      dropped.push(drop(product, 'price_out_of_band', `${product.price} 卢布`)); continue;
    }
    if (!finite(weight) || weight <= 0) { dropped.push(drop(product, 'weight_unknown')); continue; }
    if (query.maxWeightGrams !== null && weight > query.maxWeightGrams) { dropped.push(drop(product, 'too_heavy', `${weight} 克`)); continue; }
    if (!Number.isSafeInteger(product.salesCount) || product.salesCount < profile.minMonthlySales) {
      dropped.push(drop(product, 'sales_below_line', product.salesCount === null ? '页面没给销量' : `${product.salesCount} 件`)); continue;
    }
    const estimate = estimates.get(product.productId);
    if (!estimate || estimate.status === 'incomplete') {
      dropped.push(drop(product, 'estimate_incomplete', Array.isArray(estimate?.missing) && estimate.missing.length ? `缺${estimate.missing.join('、')}` : '没有算'));
      continue;
    }
    if (estimate.status === 'negative') { dropped.push(drop(product, 'profit_negative', `${estimate.ceiling.maximumAllInPurchaseRmb} 元`)); continue; }
    const ceiling = estimate.ceiling.maximumAllInPurchaseRmb;
    // 能接受的采购价越高、卖得越多，越值得先去找货源；新品只作标记。
    passed.push({ product, ceilingRmb: ceiling, score: roundDownCents(ceiling * product.salesCount), newListing: newListing(product, businessTime) });
  }
  passed.sort((left, right) => right.score - left.score || (right.product.revenue ?? 0) - (left.product.revenue ?? 0) ||
    left.product.productId.localeCompare(right.product.productId));
  const kept = passed.slice(0, profile.picksPerRound).map((entry, index) => ({
    rank: index + 1, productId: entry.product.productId, title: entry.product.title, priceRub: entry.product.price,
    salesCount: entry.product.salesCount, weightGrams: entry.product.webMetrics.weightGrams, ceilingRmb: entry.ceilingRmb,
    score: entry.score, newListing: entry.newListing
  }));
  for (const entry of passed.slice(profile.picksPerRound)) dropped.push(drop(entry.product, 'below_top_k', `第 ${passed.indexOf(entry) + 1} 名`));
  return { schemaVersion: SEERFAR_SCREENING_SCHEMA, picksPerRound: profile.picksPerRound, minMonthlySales: profile.minMonthlySales,
    kept, dropped, counts: { total: products.length, kept: kept.length, dropped: dropped.length } };
}
