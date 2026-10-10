/**
 * Seerfar 自动选品方案 B（主人 2026-10-10 定）的"去哪里搜"：店铺档案、季节节日日历和本店销量数据挑出的爆款，各自只产出一条
 * 会员前台「热销榜单选品」的查询条件。这里不碰网络、不碰候选池，也不决定任何商品能不能做；筛选在
 * seerfar-selection-screening.mjs，读页面在插件，收进候选在 seerfar-web-round.mjs。
 *
 * 档案和日历是版本化配置（data/seerfar-selection/），改类目、改窗口、改每轮收几个都不改代码（AGENTS.md §11）。
 */
import { SEERFAR_WEB_PAGE_SIZE } from './seerfar-web-discovery-contract.mjs';

export const STORE_SELECTION_PROFILE_SCHEMA = 'seerfar-store-selection-profile-v1';
export const SEASON_CALENDAR_SCHEMA = 'seerfar-season-calendar-v1';
export const SEERFAR_QUERY_ROUTES = Object.freeze(['store_category', 'season', 'hot_similar']);
export const SEERFAR_QUERY_ROUTE_LABELS = Object.freeze({ store_category: '店铺类目', season: '季节节日', hot_similar: '本店爆款找相似' });
const STORES = Object.freeze(['miska', 'dandanshu']);

export class SeerfarSelectionPlanError extends Error {
  constructor(code, detail = '') {
    super(`SEERFAR_SELECTION_PLAN_${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'SeerfarSelectionPlanError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new SeerfarSelectionPlanError(code, detail); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
/** Same shape the member-site contract accepts: Chinese path segments joined by " > ". */
const categoryPath = value => text(value, 500) && value.split(' > ').every(segment => segment.trim().length > 0 && segment.trim() === segment);
const positiveNumberOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
const monthDay = value => typeof value === 'string' && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
const uniquePaths = (paths, field) => {
  if (!Array.isArray(paths) || paths.length > 20 || !paths.every(categoryPath) || new Set(paths).size !== paths.length) fail('CONFIG_INVALID', field);
  return [...paths];
};

function priceBand(value, field) {
  if (value === null) return null;
  if (!isObject(value) || Object.keys(value).length !== 2 || !positiveNumberOrNull(value.min) || !positiveNumberOrNull(value.max) ||
      (value.min !== null && value.max !== null && value.min > value.max)) fail('CONFIG_INVALID', field);
  return { min: value.min, max: value.max };
}

export const SEED_POLICY_FIELDS = Object.freeze(['maxSeeds', 'hotMinUnits', 'risingMinUnits', 'risingMinRatio', 'potentialMinViews',
  'potentialMinToCartRate', 'potentialMaxUnits']);

/**
 * How the store's own sales pick "爆款" seeds (store-sales-seeds.mjs). Values are config, not rules: a store with a few
 * orders a day needs low lines, and they change with the store, not with the code.
 */
export function assertSeedPolicy(policy) {
  if (!isObject(policy) || Object.keys(policy).length !== SEED_POLICY_FIELDS.length || !SEED_POLICY_FIELDS.every(field => Object.hasOwn(policy, field))) {
    fail('CONFIG_INVALID', 'seedPolicy fields');
  }
  const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (!count(policy.maxSeeds, 10) || policy.maxSeeds < 1 || !count(policy.hotMinUnits, 100000) || policy.hotMinUnits < 1 ||
      !count(policy.risingMinUnits, 100000) || policy.risingMinUnits < 1 ||
      !(typeof policy.risingMinRatio === 'number' && policy.risingMinRatio > 1 && policy.risingMinRatio <= 100) ||
      !count(policy.potentialMinViews, 10000000) ||
      !(typeof policy.potentialMinToCartRate === 'number' && policy.potentialMinToCartRate > 0 && policy.potentialMinToCartRate < 1) ||
      !count(policy.potentialMaxUnits, 100000)) fail('CONFIG_INVALID', 'seedPolicy values');
  return { ...policy };
}

/** One store's standing search profile. Empty categoryPaths is allowed: the store simply has no store-category query yet. */
export function assertStoreSelectionProfile(profile) {
  const fields = ['schemaVersion', 'targetStore', 'version', 'categoryPaths', 'excludedCategoryPaths', 'priceRub', 'maxWeightGrams',
    'minMonthlySales', 'picksPerRound', 'similarPriceBandRate', 'seedPolicy', 'note'];
  if (!isObject(profile) || Object.keys(profile).length !== fields.length || !fields.every(field => Object.hasOwn(profile, field))) fail('CONFIG_INVALID', 'profile fields');
  if (profile.schemaVersion !== STORE_SELECTION_PROFILE_SCHEMA || !STORES.includes(profile.targetStore) || !text(profile.version, 80)) fail('CONFIG_INVALID', 'profile identity');
  const categoryPaths = uniquePaths(profile.categoryPaths, 'categoryPaths');
  const excludedCategoryPaths = uniquePaths(profile.excludedCategoryPaths, 'excludedCategoryPaths');
  if (categoryPaths.some(path => excludedCategoryPaths.includes(path))) fail('CONFIG_INVALID', 'a category is both searched and excluded');
  if (!positiveNumberOrNull(profile.maxWeightGrams)) fail('CONFIG_INVALID', 'maxWeightGrams');
  if (!Number.isSafeInteger(profile.minMonthlySales) || profile.minMonthlySales < 0) fail('CONFIG_INVALID', 'minMonthlySales');
  if (!Number.isSafeInteger(profile.picksPerRound) || profile.picksPerRound < 1 || profile.picksPerRound > SEERFAR_WEB_PAGE_SIZE) fail('CONFIG_INVALID', 'picksPerRound');
  if (typeof profile.similarPriceBandRate !== 'number' || !(profile.similarPriceBandRate > 0 && profile.similarPriceBandRate < 1)) fail('CONFIG_INVALID', 'similarPriceBandRate');
  if (profile.note !== null && !text(profile.note, 400)) fail('CONFIG_INVALID', 'note');
  return { ...structuredClone(profile), categoryPaths, excludedCategoryPaths, priceRub: priceBand(profile.priceRub, 'priceRub'),
    seedPolicy: assertSeedPolicy(profile.seedPolicy) };
}

/** Seasonal and holiday windows. A window is "on" between prepareFrom and prepareUntil (month-day, may wrap the year end). */
export function assertSeasonCalendar(calendar) {
  if (!isObject(calendar) || Object.keys(calendar).length !== 3 || calendar.schemaVersion !== SEASON_CALENDAR_SCHEMA ||
      !text(calendar.version, 80) || !Array.isArray(calendar.windows) || calendar.windows.length > 60) fail('CONFIG_INVALID', 'calendar');
  const fields = ['windowId', 'label', 'prepareFrom', 'prepareUntil', 'stores', 'categoryPaths', 'note'];
  const ids = new Set();
  const windows = calendar.windows.map((window, index) => {
    if (!isObject(window) || Object.keys(window).length !== fields.length || !fields.every(field => Object.hasOwn(window, field)) ||
        !/^[a-z0-9-]{1,60}$/.test(window.windowId) || ids.has(window.windowId) || !text(window.label, 60) ||
        !monthDay(window.prepareFrom) || !monthDay(window.prepareUntil) || !Array.isArray(window.stores) || window.stores.length === 0 ||
        !window.stores.every(store => STORES.includes(store)) || new Set(window.stores).size !== window.stores.length ||
        (window.note !== null && !text(window.note, 400))) fail('CONFIG_INVALID', `window #${index}`);
    ids.add(window.windowId);
    return { ...structuredClone(window), categoryPaths: uniquePaths(window.categoryPaths, `window ${window.windowId} categoryPaths`) };
  });
  return { schemaVersion: calendar.schemaVersion, version: calendar.version, windows };
}

/** Month-day comparison on the business date; a window like 12-20 → 02-10 wraps the year end. */
export function seasonWindowActive(window, businessDate) {
  if (typeof businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) fail('INPUT_INVALID', 'businessDate');
  const today = businessDate.slice(5);
  return window.prepareFrom <= window.prepareUntil
    ? today >= window.prepareFrom && today <= window.prepareUntil
    : today >= window.prepareFrom || today <= window.prepareUntil;
}

export const SEED_KINDS = Object.freeze({ hot: '卖得最多', rising: '销量在涨', potential: '加购多、下单少' });

/**
 * A seed picked from the store's own sales (store-sales-seeds.mjs), already priced in roubles for the Seerfar price band.
 * `evidence` is the one line the page shows for why it was picked.
 */
function assertSeed(item, index) {
  const fields = ['seedId', 'kind', 'marketProductId', 'title', 'priceRub', 'evidence'];
  if (!isObject(item) || Object.keys(item).length !== fields.length || !fields.every(field => Object.hasOwn(item, field)) ||
      !text(item.seedId, 160) || !Object.hasOwn(SEED_KINDS, item.kind) || !(typeof item.marketProductId === 'string' && /^[1-9]\d{0,17}$/.test(item.marketProductId)) ||
      !text(item.title, 2000) || !(typeof item.priceRub === 'number' && Number.isFinite(item.priceRub) && item.priceRub > 0) || !text(item.evidence, 300)) {
    fail('INPUT_INVALID', `seed #${index}`);
  }
  return structuredClone(item);
}

const round2 = value => Math.round(value * 100) / 100;

function query({ route, reason, categoryPaths, priceRub, maxWeightGrams, sourceRef, excludeMarketProductIds = [] }) {
  return { queryId: `${route}:${sourceRef}`, route, routeLabel: SEERFAR_QUERY_ROUTE_LABELS[route], reason, categoryPaths,
    sellerType: 'cross_border', dateRange: 'last_30_days', priceRub, maxWeightGrams, excludeMarketProductIds };
}

/**
 * Today's queries for one store, in the order the owner reads them: store categories, then seasonal windows, then
 * similar-to-best-seller. Nothing is dropped silently: a window that is on but has no categories yet comes back in
 * `gaps`, so the page can say "新年窗口还没配类目" instead of quietly searching nothing.
 */
export function planSeerfarQueries({ businessDate, profile, calendar, seeds = [] }) {
  const store = assertStoreSelectionProfile(profile);
  const season = assertSeasonCalendar(calendar);
  if (!Array.isArray(seeds) || seeds.length > 20) fail('INPUT_INVALID', 'seeds');
  const hot = seeds.map(assertSeed);
  const queries = [], gaps = [];
  const excluded = new Set(store.excludedCategoryPaths);
  if (store.categoryPaths.length) {
    queries.push(query({ route: 'store_category', reason: `本店主营类目（档案 ${store.version}）`, categoryPaths: store.categoryPaths,
      priceRub: store.priceRub, maxWeightGrams: store.maxWeightGrams, sourceRef: `${store.targetStore}:${store.version}` }));
  } else {
    gaps.push({ route: 'store_category', code: 'PROFILE_CATEGORIES_EMPTY', reason: '本店档案还没有填主营类目，店铺类目这条路先不搜。' });
  }
  for (const window of season.windows) {
    if (!window.stores.includes(store.targetStore) || !seasonWindowActive(window, businessDate)) continue;
    const paths = window.categoryPaths.filter(path => !excluded.has(path));
    if (!paths.length) {
      gaps.push({ route: 'season', code: 'WINDOW_CATEGORIES_EMPTY', windowId: window.windowId,
        reason: `「${window.label}」正在备货期，但还没配要搜的类目。` });
      continue;
    }
    queries.push(query({ route: 'season', reason: `「${window.label}」备货期（${window.prepareFrom} 至 ${window.prepareUntil}）`, categoryPaths: paths,
      priceRub: store.priceRub, maxWeightGrams: store.maxWeightGrams, sourceRef: `${window.windowId}:${season.version}` }));
  }
  if (hot.length && !store.categoryPaths.length) {
    gaps.push({ route: 'hot_similar', code: 'PROFILE_CATEGORIES_EMPTY', reason: '本店有爆款，但档案还没有主营类目，找相似先不搜。' });
  }
  for (const item of store.categoryPaths.length ? hot : []) {
    // Similar items are searched inside the store's own categories at the seed's price: Ozon category ids and Seerfar's
    // Chinese paths are not mapped anywhere, so the seed's own Seerfar category is not guessed.
    const rate = store.similarPriceBandRate;
    queries.push(query({ route: 'hot_similar',
      reason: `和本店爆款「${item.title.slice(0, 40)}」相似（${SEED_KINDS[item.kind]}：${item.evidence}），价格上下 ${Math.round(rate * 100)}%`,
      categoryPaths: store.categoryPaths, priceRub: { min: round2(item.priceRub * (1 - rate)), max: round2(item.priceRub * (1 + rate)) },
      maxWeightGrams: store.maxWeightGrams, sourceRef: item.seedId, excludeMarketProductIds: [item.marketProductId] }));
  }
  return { businessDate, targetStore: store.targetStore, profileVersion: store.version, calendarVersion: season.version, queries, gaps };
}
