import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SeerfarSelectionPlanError, assertSeasonCalendar, assertStoreSelectionProfile, planSeerfarQueries,
  seasonWindowActive } from '../lib/seerfar-selection-plan.mjs';
import { loadSeerfarSelectionConfig } from '../lib/seerfar-selection-config.mjs';

const CLOTHING = '宠物用品 > 宠物服装和靴子 > 宠物服装';
const BED = '宠物用品 > 携带和睡眠配件 > 宠物躺床';

function profile(overrides = {}) {
  return { schemaVersion: 'seerfar-store-selection-profile-v1', targetStore: 'miska', version: 'miska-test-1', positioning: '合成测试店', categoryPaths: [CLOTHING, BED],
    excludedCategoryPaths: [], priceRub: { min: 800, max: null }, maxWeightGrams: 1000, presaleMaxDays: 14, minMonthlySales: 20, picksPerRound: 5,
    similarPriceBandRate: 0.3, seedPolicy: { maxSeeds: 3, hotMinUnits: 3, risingMinUnits: 2, risingMinRatio: 2, potentialMinViews: 2000, potentialMinToCartRate: 0.01, potentialMaxUnits: 1 }, note: null, ...overrides };
}
function calendar(windows) {
  return { schemaVersion: 'seerfar-season-calendar-v1', version: 'season-test-1', windows };
}
function window(overrides = {}) {
  return { windowId: 'winter', label: '冬季', prepareFrom: '09-01', prepareUntil: '12-10', stores: ['miska'], categoryPaths: [CLOTHING], note: null, ...overrides };
}
const rejects = (fn, code) => assert.throws(fn, error => error instanceof SeerfarSelectionPlanError && error.code === code);

test('the shipped profiles and calendar are valid and plan real queries for both stores today', async () => {
  const config = await loadSeerfarSelectionConfig();
  assert.deepEqual(Object.keys(config.profiles).sort(), ['dandanshu', 'miska']);
  for (const [store, routes] of [['miska', ['store_category', 'season', 'season']], ['dandanshu', ['store_category', 'season']]]) {
    const plan = planSeerfarQueries({ businessDate: '2026-10-10', profile: config.profiles[store], calendar: config.calendar });
    assert.deepEqual(plan.queries.map(query => query.route), routes, store);
    assert.deepEqual(plan.gaps, []);
    assert.ok(plan.queries.every(query => query.sellerType === 'cross_border' && query.dateRange === 'last_30_days'));
  }
});

test('season windows switch on by month-day and wrap the year end', () => {
  const wrap = window({ prepareFrom: '12-20', prepareUntil: '02-05' });
  assert.equal(seasonWindowActive(wrap, '2026-12-25'), true);
  assert.equal(seasonWindowActive(wrap, '2027-01-31'), true);
  assert.equal(seasonWindowActive(wrap, '2027-02-06'), false);
  assert.equal(seasonWindowActive(window(), '2026-08-31'), false);
  assert.equal(seasonWindowActive(window(), '2026-12-10'), true);
  rejects(() => seasonWindowActive(window(), '10-10'), 'INPUT_INVALID');
});

test('store, season and best-seller routes each produce one query in reading order', () => {
  const plan = planSeerfarQueries({ businessDate: '2026-10-10', profile: profile(), calendar: calendar([window(), window({ windowId: 'spring', prepareFrom: '02-15', prepareUntil: '05-15' })]),
    seeds: [{ seedId: 'hot:3001', kind: 'hot', marketProductId: '3001', title: 'Синтетический жилет', priceRub: 1000, evidence: '近 28 天 4 件，前 28 天 1 件' }] });
  assert.deepEqual(plan.queries.map(query => [query.route, query.queryId]), [
    ['store_category', 'store_category:miska:miska-test-1'], ['season', 'season:winter:season-test-1'], ['hot_similar', 'hot_similar:hot:3001']]);
  // Similar items are searched in the store's own categories; the seed's Seerfar category is never guessed.
  assert.deepEqual(plan.queries[2].categoryPaths, [CLOTHING, BED]);
  assert.match(plan.queries[2].reason, /卖得最多：近 28 天 4 件/);
  assert.deepEqual(plan.queries[2].priceRub, { min: 700, max: 1300 });
  assert.deepEqual(plan.queries[2].excludeMarketProductIds, ['3001']);
  assert.deepEqual(plan.gaps, []);
});

test('excluded categories never get searched and an empty window is reported, not skipped silently', () => {
  const plan = planSeerfarQueries({ businessDate: '2026-10-10', profile: profile({ categoryPaths: [BED], excludedCategoryPaths: [CLOTHING] }),
    calendar: calendar([window()]) });
  assert.deepEqual(plan.queries.map(query => query.route), ['store_category']);
  assert.equal(plan.gaps[0].code, 'WINDOW_CATEGORIES_EMPTY');
  // A store with seeds but no categories says why similar-search is off.
  const empty = planSeerfarQueries({ businessDate: '2026-10-10', profile: profile({ categoryPaths: [] }), calendar: calendar([]), seeds: [{ seedId: 'hot:3001', kind: 'hot', marketProductId: '3001', title: 'Синтетический жилет', priceRub: 1000, evidence: '近 28 天 4 件，前 28 天 1 件' }] });
  assert.deepEqual(empty.queries, []);
  assert.deepEqual(empty.gaps.map(gap => [gap.route, gap.code]), [['store_category', 'PROFILE_CATEGORIES_EMPTY'], ['hot_similar', 'PROFILE_CATEGORIES_EMPTY']]);
});

test('profiles and calendars are closed shapes', () => {
  for (const bad of [profile({ extra: 1 }), profile({ targetStore: 'wb' }), profile({ categoryPaths: [CLOTHING, CLOTHING] }),
    profile({ excludedCategoryPaths: [CLOTHING] }), profile({ picksPerRound: 0 }), profile({ picksPerRound: 21 }),
    profile({ priceRub: { min: 900, max: 800 } }), profile({ similarPriceBandRate: 1 }), profile({ categoryPaths: ['宠物用品 >  宠物服装'] }),
    profile({ seedPolicy: undefined }), profile({ seedPolicy: { ...profile().seedPolicy, risingMinRatio: 1 } }),
    profile({ seedPolicy: { ...profile().seedPolicy, maxSeeds: 0 } }), profile({ seedPolicy: { ...profile().seedPolicy, extra: 1 } })]) {
    rejects(() => assertStoreSelectionProfile(bad), 'CONFIG_INVALID');
  }
  for (const bad of [calendar([window({ prepareFrom: '13-01' })]), calendar([window(), window()]), calendar([window({ stores: [] })])]) {
    rejects(() => assertSeasonCalendar(bad), 'CONFIG_INVALID');
  }
});

test('the shipped config files are plain JSON with no secrets or store ids', async () => {
  for (const name of ['store-profiles.json', 'season-calendar.json']) {
    const raw = await readFile(new URL(`../data/seerfar-selection/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(raw, /token|cookie|password|sellerId|clientId/i);
  }
});
