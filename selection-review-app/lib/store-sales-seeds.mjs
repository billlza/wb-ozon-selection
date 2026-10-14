/**
 * 本店爆款从数据里挑，不由主人手标（主人 2026-10-10：「这个不应该我来给，你要看数据」）。
 *
 * 输入是本店只读 Seller API 读回来的近 28 天和前 28 天按 SKU 汇总（ozon-store-sales-reader.mjs 归一化后的行），
 * 输出是几件"拿来找相似"的种子：卖得最多、销量在涨、看和加购的人多却没怎么下单。全部是固定规则加版本化门槛
 * （店铺档案 seedPolicy），不用 AI，也不改变任何商品的业务状态。两家店每天只有几单，所以这些是"值得去找相似"的
 * 线索，不是统计结论。
 */
import { SEED_KINDS, assertSeedPolicy } from './seerfar-selection-plan.mjs';

export const STORE_SALES_SNAPSHOT_SCHEMA = 'ozon-store-sales-snapshot-v1';
export const STORE_SALES_WINDOW_DAYS = 28;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round2 = value => Math.round(value * 100) / 100;

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Recent = the 28 days before the business date (today is not complete yet); prior = the 28 days before that. */
export function storeSalesWindows(businessDate) {
  if (typeof businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new TypeError('STORE_SALES_BUSINESS_DATE_INVALID');
  const days = STORE_SALES_WINDOW_DAYS;
  return { recent: { from: addDays(businessDate, -days), to: addDays(businessDate, -1) },
    prior: { from: addDays(businessDate, -2 * days), to: addDays(businessDate, -days - 1) } };
}

function assertWindowTotals(value) {
  return isObject(value) && count(value.units) && money(value.revenueRmb) && count(value.views) && count(value.toCart);
}

/** One normalized SKU row; anything the API did not give stays null instead of being guessed. */
export function assertStoreSalesRow(row) {
  if (!isObject(row) || typeof row.sku !== 'string' || !/^[1-9]\d{0,17}$/.test(row.sku) || typeof row.title !== 'string' || !row.title ||
      row.title.length > 2000 || !assertWindowTotals(row.recent) || !assertWindowTotals(row.prior) ||
      !(row.offerId === null || typeof row.offerId === 'string' && row.offerId.length <= 200) ||
      !(row.listedPriceRmb === null || money(row.listedPriceRmb)) || !(row.hasStock === null || typeof row.hasStock === 'boolean')) {
    throw new TypeError('STORE_SALES_ROW_INVALID');
  }
  return row;
}

function unitPriceRmb(row) {
  if (row.recent.units > 0 && row.recent.revenueRmb > 0) return round2(row.recent.revenueRmb / row.recent.units);
  if (row.prior.units > 0 && row.prior.revenueRmb > 0) return round2(row.prior.revenueRmb / row.prior.units);
  return row.listedPriceRmb && row.listedPriceRmb > 0 ? row.listedPriceRmb : null;
}

function evidenceFor(kind, row) {
  if (kind === 'potential') {
    return `近 28 天曝光 ${row.recent.views}、加购 ${row.recent.toCart}、只卖了 ${row.recent.units} 件`;
  }
  return `近 28 天 ${row.recent.units} 件，前 28 天 ${row.prior.units} 件`;
}

/**
 * rows: assertStoreSalesRow rows for one store. rubPerCny: the rate used to put the seed's price on Seerfar's rouble
 * scale (Ozon CN seller prices are in CNY). Returns the seeds in the order they are searched, plus every SKU that met a
 * line but was not used, with its reason.
 */
export function pickStoreSeeds({ rows, policy, rubPerCny }) {
  if (!Array.isArray(rows) || rows.length > 5000 || !(typeof rubPerCny === 'number' && Number.isFinite(rubPerCny) && rubPerCny > 0)) {
    throw new TypeError('STORE_SALES_SEED_INPUT_INVALID');
  }
  const lines = assertSeedPolicy(policy);
  rows.forEach(assertStoreSalesRow);
  const byUnits = (left, right) => right.recent.units - left.recent.units || right.recent.revenueRmb - left.recent.revenueRmb || left.sku.localeCompare(right.sku);
  const hot = rows.filter(row => row.recent.units >= lines.hotMinUnits).sort(byUnits);
  const rising = rows.filter(row => row.recent.units >= lines.risingMinUnits && row.recent.units >= lines.risingMinRatio * Math.max(row.prior.units, 1))
    .sort((left, right) => (right.recent.units - right.prior.units) - (left.recent.units - left.prior.units) || byUnits(left, right));
  const toCartRate = row => row.recent.views > 0 ? row.recent.toCart / row.recent.views : 0;
  const potential = rows.filter(row => row.recent.views >= lines.potentialMinViews && toCartRate(row) >= lines.potentialMinToCartRate &&
    row.recent.units <= lines.potentialMaxUnits).sort((left, right) => right.recent.toCart - left.recent.toCart || left.sku.localeCompare(right.sku));

  const seeds = [], skipped = [], used = new Set();
  for (const [kind, list] of [['hot', hot], ['rising', rising], ['potential', potential]]) {
    for (const row of list) {
      if (used.has(row.sku)) continue;
      used.add(row.sku);
      const priceRmb = unitPriceRmb(row);
      if (priceRmb === null) { skipped.push({ sku: row.sku, title: row.title, kind, reason: '读不到这件的成交价或标价，定不了找相似的价格带' }); continue; }
      if (seeds.length >= lines.maxSeeds) { skipped.push({ sku: row.sku, title: row.title, kind, reason: `这一次最多用 ${lines.maxSeeds} 件，排在后面` }); continue; }
      seeds.push({ seedId: `${kind}:${row.sku}`, kind, marketProductId: row.sku, title: row.title, priceRub: round2(priceRmb * rubPerCny),
        evidence: evidenceFor(kind, row), priceRmb, offerId: row.offerId, hasStock: row.hasStock, kindLabel: SEED_KINDS[kind] });
    }
  }
  return { seeds, skipped };
}

/** The seed fields planSeerfarQueries accepts; the rest stays on the snapshot for the page. */
export function planSeed(seed) {
  return { seedId: seed.seedId, kind: seed.kind, marketProductId: seed.marketProductId, title: seed.title, priceRub: seed.priceRub, evidence: seed.evidence };
}
