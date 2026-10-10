import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStoreSeeds, storeSalesWindows } from '../lib/store-sales-seeds.mjs';
import { createOzonStoreSalesReader, storeSalesRoutes } from '../lib/ozon-store-sales-reader.mjs';
import { createStoreSalesSeedService, storeSeedsForPlan } from '../lib/store-sales-seed-service.mjs';
import { seerfarCategoryMatches } from '../lib/seerfar-web-discovery-contract.mjs';

// Every SKU, title, count and key below is synthetic.
const POLICY = { maxSeeds: 3, hotMinUnits: 3, risingMinUnits: 2, risingMinRatio: 2, potentialMinViews: 2000, potentialMinToCartRate: 0.01, potentialMaxUnits: 1 };
const totals = (units, revenueRmb, views, toCart) => ({ units, revenueRmb, views, toCart });
const row = (sku, recent, prior, extra = {}) => ({ sku, title: `Synthetic item ${sku}`, recent, prior, offerId: `offer-${sku}`, listedPriceRmb: 100,
  hasStock: true, ...extra });

test('the windows are the 28 days before the business date and the 28 before those', () => {
  assert.deepEqual(storeSalesWindows('2026-10-10'), { recent: { from: '2026-09-12', to: '2026-10-09' }, prior: { from: '2026-08-15', to: '2026-09-11' } });
});

test('seeds come from the data: best sellers, then rising items, then items people add to cart but rarely buy', () => {
  const rows = [
    row('1001', totals(12, 1032, 7816, 60), totals(22, 1980, 14918, 90)),   // best seller, falling
    row('1002', totals(4, 1600, 8000, 40), totals(9, 3600, 10790, 50)),     // also a best seller
    row('1003', totals(2, 160, 900, 5), totals(0, 0, 400, 1)),              // rising from nothing
    row('1004', totals(1, 529, 8168, 95), totals(5, 1970, 10790, 80)),      // looked at and carted, barely bought
    row('1005', totals(0, 0, 1500, 30), totals(0, 0, 900, 4)),              // too few views to count
    row('1006', totals(1, 50, 3000, 10), totals(1, 50, 2000, 5))            // nothing stands out
  ];
  const { seeds, skipped } = pickStoreSeeds({ rows, policy: POLICY, rubPerCny: 11.5 });
  assert.deepEqual(seeds.map(seed => [seed.kind, seed.marketProductId]), [['hot', '1001'], ['hot', '1002'], ['rising', '1003']]);
  assert.equal(seeds[0].priceRmb, 86);
  assert.equal(seeds[0].priceRub, 989);
  assert.equal(seeds[0].evidence, '近 28 天 12 件，前 28 天 22 件');
  // The fourth match is kept out by maxSeeds, with its reason.
  assert.deepEqual(skipped.map(entry => [entry.sku, entry.kind]), [['1004', 'potential']]);
  const wider = pickStoreSeeds({ rows, policy: { ...POLICY, maxSeeds: 5 }, rubPerCny: 11.5 });
  assert.equal(wider.seeds[3].evidence, '近 28 天曝光 8168、加购 95、只卖了 1 件');
  assert.throws(() => pickStoreSeeds({ rows, policy: POLICY, rubPerCny: 0 }), /STORE_SALES_SEED_INPUT_INVALID/);
});

test('a seed with no sale and no listed price is skipped with its reason, never priced by guess', () => {
  const { seeds, skipped } = pickStoreSeeds({ rows: [row('2001', totals(0, 0, 5000, 80), totals(0, 0, 0, 0), { listedPriceRmb: null })],
    policy: POLICY, rubPerCny: 11.5 });
  assert.deepEqual(seeds, []);
  assert.match(skipped[0].reason, /成交价或标价/);
});

test('a declared category is a run of whole path segments', () => {
  assert.equal(seerfarCategoryMatches('家居 > 收藏品 > 摆件', '收藏品'), true);
  assert.equal(seerfarCategoryMatches('家居 > 收藏品 > 摆件', '家居 > 收藏品'), true);
  assert.equal(seerfarCategoryMatches('家居 > 收藏品 > 摆件', '收藏'), false);
  assert.equal(seerfarCategoryMatches('家居 > 收藏品 > 摆件', '收藏品 > 家居'), false);
});

const discoveryBindings = [{ bindingId: 'ozon-discovery:miska', configurationVersion: 'cfg-1', platform: 'ozon', targetStore: 'miska', storeName: 'Synthetic store',
  credentialAlias: 'ozon-credential:miska', workerId: 'worker:miska', workerVersion: 'v1', leaseDurationMs: 60000 }];
const credentialBindings = [{ credentialAlias: 'ozon-credential:miska', keychainService: 'synthetic-service', keychainAccount: 'synthetic-account', clientId: '1234567' }];

function fakeOzon(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers, method: init.method });
    const next = responses.shift();
    return { status: next.status ?? 200, text: async () => JSON.stringify(next.body ?? {}) };
  };
  return { calls, fetchImpl };
}
const analytics = entries => ({ body: { result: { data: entries.map(([id, name, metrics]) => ({ dimensions: [{ id, name }], metrics })), totals: [] } } });

test('the reader sends three read-only requests with the store key and normalizes them', async () => {
  const routes = storeSalesRoutes({ discoveryBindings, credentialBindings });
  assert.deepEqual(Object.keys(routes), ['miska']);
  const { calls, fetchImpl } = fakeOzon([
    analytics([['1001', 'Synthetic coat', [12, 1032, 7816, 60]]]),
    analytics([['1001', 'Synthetic coat', [22, 1980, 14918, 90]], ['1002', 'Synthetic bed', [3, 300, 900, 4]]]),
    { body: { items: [{ id: 1, offer_id: 'coat-1', name: 'Coat', price: '89.00', currency_code: 'CNY', stocks: { has_stock: false }, sources: [{ sku: 1001 }] }] } }
  ]);
  const gaps = [];
  const reader = createOzonStoreSalesReader({ routes, fetchImpl, readSecret: async () => 'synthetic-api-key', sleep: async ms => { gaps.push(ms); } });
  const body = await reader.read({ targetStore: 'miska', windows: storeSalesWindows('2026-10-10'), readAt: '2026-10-10T03:00:00.000Z' });
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/v1/analytics/data', '/v1/analytics/data', '/v3/product/info/list']);
  assert.ok(calls.every(call => call.method === 'POST' && call.headers['Client-Id'] === '1234567' && call.headers['Api-Key'] === 'synthetic-api-key'));
  assert.deepEqual(calls[0].body.metrics, ['ordered_units', 'revenue', 'hits_view', 'hits_tocart']);
  assert.equal(calls[0].body.date_from, '2026-09-12');
  assert.deepEqual(gaps, [65000]);
  assert.deepEqual(body.rows.find(entry => entry.sku === '1001'), { sku: '1001', title: 'Synthetic coat', recent: totals(12, 1032, 7816, 60),
    prior: totals(22, 1980, 14918, 90), offerId: 'coat-1', listedPriceRmb: 89, hasStock: false });
  assert.deepEqual(body.rows.find(entry => entry.sku === '1002').recent, totals(0, 0, 0, 0));
  assert.equal(body.source.write, false);
  assert.equal(JSON.stringify(body).includes('synthetic-api-key'), false);
});

test('reader failures stop at the first failing request with their layer and how many requests went out', async () => {
  const routes = storeSalesRoutes({ discoveryBindings, credentialBindings });
  for (const [responses, code, sent] of [[[{ status: 403 }], 'permission_required', 1], [[{ status: 429 }], 'rate_limited', 1],
    [[analytics([]), { status: 500 }], 'platform_error', 2], [[{ body: { result: {} } }], 'response_invalid', 1]]) {
    const { calls, fetchImpl } = fakeOzon(responses);
    const reader = createOzonStoreSalesReader({ routes, fetchImpl, readSecret: async () => 'k', sleep: async () => {} });
    await assert.rejects(reader.read({ targetStore: 'miska', windows: storeSalesWindows('2026-10-10'), readAt: 'x' }),
      error => error.code === code && error.requestsSent === sent);
    assert.equal(calls.length, sent);
  }
  const { calls, fetchImpl } = fakeOzon([]);
  const noKey = createOzonStoreSalesReader({ routes, fetchImpl, readSecret: async () => { throw new Error('locked'); }, sleep: async () => {} });
  await assert.rejects(noKey.read({ targetStore: 'miska', windows: storeSalesWindows('2026-10-10'), readAt: 'x' }), error => error.code === 'credential_unavailable');
  assert.equal(calls.length, 0);
  await assert.rejects(noKey.read({ targetStore: 'dandanshu', windows: storeSalesWindows('2026-10-10'), readAt: 'x' }), error => error.code === 'not_configured');
});

function serviceHarness({ read, rubPerCny = 11.5 } = {}) {
  let document = { runtime: {}, candidates: [] };
  const transact = async mutator => { const draft = structuredClone(document); const result = await mutator(draft); document = draft; return result; };
  const whenChanged = async mutator => { const draft = structuredClone(document); const outcome = await mutator(draft); if (outcome?.changed) document = draft; return outcome?.result; };
  const profile = { version: 'miska-test-1', seedPolicy: POLICY };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = { stores: () => ['miska'], read: async input => { await gate; return read(input); } };
  const service = createStoreSalesSeedService({ readData: async () => structuredClone(document), mutateData: transact, mutateDataWhenChanged: whenChanged,
    now: () => '2026-10-10T03:00:00.000Z', businessDate: () => '2026-10-10', reader, config: { profiles: { miska: profile, dandanshu: profile } },
    estimateInputs: { resolveExchangeRate: async () => (rubPerCny ? { rubPerCny, rateDate: '2026-10-10' } : null) } });
  return { service, release, document: () => document };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('one read per store and day: saved as running first, then a completed snapshot whose seeds feed the plan', async () => {
  const { service, release, document } = serviceHarness({ read: ({ targetStore, windows, readAt }) => ({ schemaVersion: 'ozon-store-sales-snapshot-v1', targetStore,
    readAt, windows, source: { platform: 'ozon', api: 'seller_api', endpoints: [], bindingId: 'b', write: false }, requestsSent: 3,
    rows: [row('1001', totals(12, 1032, 7816, 60), totals(22, 1980, 14918, 90))] }) });
  await assert.rejects(service.startRead({ actor: { userId: 'user:owner' }, targetStore: 'dandanshu' }), error => error.code === 'NOT_CONFIGURED');
  const started = await service.startRead({ actor: { userId: 'user:owner' }, targetStore: 'miska' });
  assert.equal(started.status, 'running');
  assert.equal(Object.values(document().runtime.storeSalesSnapshots)[0].status, 'running');
  await assert.rejects(service.startRead({ actor: { userId: 'user:owner' }, targetStore: 'miska' }), error => error.code === 'ALREADY_RUNNING');
  release(); await settle(); await settle();
  const saved = Object.values(document().runtime.storeSalesSnapshots)[0];
  assert.equal(saved.status, 'completed');
  assert.deepEqual(storeSeedsForPlan(document(), 'miska'), [{ seedId: 'hot:1001', kind: 'hot', marketProductId: '1001', title: 'Synthetic item 1001',
    priceRub: 989, evidence: '近 28 天 12 件，前 28 天 22 件' }]);
  assert.equal(service.view(document()).miska.readToday, true);
  await assert.rejects(service.startRead({ actor: { userId: 'user:owner' }, targetStore: 'miska' }), error => error.code === 'ALREADY_READ_TODAY');
});

test('a failed read is saved with its reason and not retried; a restart closes a read left running', async () => {
  const { OzonStoreSalesReadError } = await import('../lib/ozon-store-sales-reader.mjs');
  let reads = 0;
  const { service, release, document } = serviceHarness({ read: () => { reads += 1; throw new OzonStoreSalesReadError('rate_limited', { requestsSent: 1, httpStatus: 429 }); } });
  await service.startRead({ actor: { userId: 'user:owner' }, targetStore: 'miska' });
  release(); await settle(); await settle();
  const saved = Object.values(document().runtime.storeSalesSnapshots)[0];
  assert.deepEqual(saved.failure, { code: 'rate_limited', reason: 'Ozon 说请求太频繁，这次先停下', requestsSent: 1, httpStatus: 429 });
  assert.equal(reads, 1);
  assert.deepEqual(storeSeedsForPlan(document(), 'miska'), []);

  const leftover = serviceHarness({ read: () => ({}) });
  await leftover.service.startRead({ actor: { userId: 'user:owner' }, targetStore: 'miska' });
  const restarted = createStoreSalesSeedService({ readData: async () => structuredClone(leftover.document()), mutateData: async () => null,
    mutateDataWhenChanged: async mutator => { const draft = structuredClone(leftover.document()); const outcome = await mutator(draft); return outcome?.result; },
    now: () => '2026-10-10T04:00:00.000Z', businessDate: () => '2026-10-10', reader: null, config: { profiles: {} },
    estimateInputs: { resolveExchangeRate: async () => null } });
  assert.equal((await restarted.reconcileAfterRestart()).length, 1);
});

test('home to-dos: one blocker notice for a Seerfar logout, a rerun for other failed rounds, nothing once a later round worked', async () => {
  const { seerfarTodos } = await import('../lib/seerfar-todos.mjs');
  const round = (roundId, store, queryId, status, createdAt, failure = null) => ({ roundId, targetStore: store, businessDate: createdAt.slice(0, 10),
    query: { queryId, routeLabel: '店铺类目' }, status, createdAt, completedAt: createdAt, failure });
  const login = { code: 'site_login_required', reason: 'Seerfar 没登录，插件停在了登录页' };
  const todos = seerfarTodos({ businessDate: '2026-10-10', rounds: [
    round('r1', 'miska', 'q1', 'failed', '2026-10-10T01:00:00Z', login),
    round('r2', 'dandanshu', 'q2', 'failed', '2026-10-10T01:05:00Z', login),
    round('r3', 'miska', 'q3', 'failed', '2026-10-10T01:10:00Z', { code: 'no_matching_search', reason: '等了 3 分钟，没收到这几个类目的搜索结果' }),
    round('r4', 'miska', 'q4', 'failed', '2026-10-10T01:00:00Z', { code: 'timeout', reason: '插件超时了' }),
    round('r5', 'miska', 'q4', 'completed', '2026-10-10T02:00:00Z'),
    round('r6', 'miska', 'q5', 'failed', '2026-10-09T01:00:00Z', { code: 'timeout', reason: '插件超时了' })],
  storeSales: { miska: { readToday: false, latest: { snapshotId: 's1', status: 'failed', businessDate: '2026-10-10', completedAt: '2026-10-10T03:00:00Z',
    failure: { reason: 'Ozon 说请求太频繁，这次先停下' } } } } });
  assert.deepEqual(todos.map(todo => [todo.id, todo.kind, todo.severity, todo.store]), [
    ['seerfar:site:site_login_required', 'notice', 'blocker', null],
    ['seerfar:r3:failure', 'failure', 'action', 'miska'],
    ['seerfar:s1:failure', 'failure', 'action', 'miska']]);
  assert.deepEqual(todos[0].action, { key: 'rerun', label: '重跑这一轮', target: { view: 'desk', roundId: 'r2' } });
});
