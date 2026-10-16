import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakeCredentialStore } from '../lib/credential-store.mjs';
import { SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT, SEERFAR_ACCOUNT_KEYCHAIN_SERVICE, createSeerfarAccountVault } from '../lib/seerfar-account-identity.mjs';
import { SEERFAR_WEB_SEARCH_ENDPOINT, SEERFAR_WEB_SEARCH_PAGE } from '../lib/seerfar-web-discovery-contract.mjs';
import { createSeerfarWebRoundService } from '../lib/seerfar-web-round-service.mjs';

// Synthetic products only, shaped like the 2026-09-10 member-site search response.
const CLOTHING = '宠物用品 > 宠物服装和靴子 > 宠物服装';
const AT = '2026-10-10T03:00:00.000Z';
const ORIGIN = 'chrome-extension://synthetic-extension-id';
const owner = { userId: 'user:owner' };

const config = {
  profiles: { miska: { schemaVersion: 'seerfar-store-selection-profile-v1', targetStore: 'miska', version: 'miska-test-1', positioning: '合成测试店', categoryPaths: [CLOTHING],
    excludedCategoryPaths: [], priceRub: { min: 800, max: null }, maxWeightGrams: 1000, presaleMaxDays: 14, minMonthlySales: 20, picksPerRound: 2,
    similarPriceBandRate: 0.3, seedPolicy: { maxSeeds: 3, hotMinUnits: 3, risingMinUnits: 2, risingMinRatio: 2, potentialMinViews: 2000, potentialMinToCartRate: 0.01, potentialMaxUnits: 1 }, note: null } },
  calendar: { schemaVersion: 'seerfar-season-calendar-v1', version: 'season-test-1', windows: [] }
};
const estimateInputs = {
  assumptions: { packagingRmbDefault: 3 },
  storeRule: () => ({ advertisingReserveRate: 0, returnOpsReserveRate: 0.03, damageLossReserveRate: 0.02, withdrawalFeeRate: 0.012, labelCostRmb: 0.5,
    fixedOtherRmb: 0, minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either' }),
  resolveExchangeRate: async () => ({ rubPerCny: 12 }),
  resolveFreightRows: async () => ({ rows: [{ route: 'synthetic-small', evidenceData: { perKgRmb: 40, perParcelRmb: 15, weightLimit: '0.001-2KG',
    sizeLimit: '三边之和不超150CM，单边最大尺寸不超60CM' } }] }),
  resolveCommission: async () => ({ rate: 0.12 })
};

function raw(sku, overrides = {}) {
  return { sku, title: `Synthetic dog coat ${sku}`, productUrl: `https://www.ozon.ru/product/${sku}`,
    imageUrl: `https://ir.ozone.ru/s3/multimedia-1-x/wc250/${sku}.jpg`, price: 1200, sales: 50, revenue: 60000, reviewCount: 10, reviewRating: 4.8,
    sellerType: 1, sellerId: 42, sellerName: 'Synthetic seller', fulfillment: ['RFBS'], weight: 250, volume: 1.2, dimension: '300x200x50', variants: 3,
    upTime: Date.parse('2026-09-01T00:00:00Z'),
    categoryInfo: { category: { id: '1_2_3' }, fullCategoryId: ['1', '1_2', '1_2_3'], titlePath: 'Товары для животных > Одежда > Одежда для собак',
      cnTitlePath: CLOTHING, enTitlePath: 'Pet Supplies > Clothing > Pet Clothing' }, ...overrides };
}
const capture = records => ({ pageUrl: SEERFAR_WEB_SEARCH_PAGE, endpoint: SEERFAR_WEB_SEARCH_ENDPOINT, httpStatus: 200, capturedAt: AT,
  resultCountLabel: '共812条记录', records });

function harness(overrides = {}) {
  let document = { meta: {}, runtime: {}, candidates: [], ...overrides.document };
  const transact = async mutator => {
    const draft = structuredClone(document);
    const result = await mutator(draft);
    document = draft;
    return result;
  };
  const service = createSeerfarWebRoundService({
    readData: async () => structuredClone(document), mutateData: transact,
    mutateDataWhenChanged: async mutator => {
      const draft = structuredClone(document);
      const outcome = await mutator(draft);
      if (outcome?.changed) document = draft;
      return outcome?.result;
    },
    now: () => AT, businessDate: () => '2026-10-10', estimateInputs, storeBindings: [], config, requiredExtensionVersion: '1.5.0', ...overrides.options
  });
  return { service, read: () => document };
}

test('one round end to end: start, claim, result, two candidates in the shared intake shape', async () => {
  const { service, read } = harness();
  const plan = service.view(read()).plans.miska;
  assert.equal(plan.queries[0].route, 'store_category');
  const started = await service.startRound({ actor: owner, targetStore: 'miska', queryId: plan.queries[0].queryId });
  assert.equal(started.round.status, 'waiting_extension');
  assert.equal(JSON.stringify(started).includes('token'), false);
  await assert.rejects(service.claim(started.captureJob.jobId, '1.3.0', ORIGIN), error => error.code === 'EXTENSION_VERSION_MISMATCH');
  const { captureJob } = await service.claim(started.captureJob.jobId, '1.5.0', ORIGIN);
  assert.deepEqual(captureJob.categoryPaths, [CLOTHING]);
  assert.equal(captureJob.pageUrl, SEERFAR_WEB_SEARCH_PAGE);
  await assert.rejects(service.claim(started.captureJob.jobId, '1.5.0', ORIGIN), error => error.code === 'NOT_CLAIMABLE');
  await assert.rejects(service.acceptResult({ roundId: captureJob.roundId, claimant: ORIGIN,
    input: { captureId: captureJob.captureId, token: 'wrong', status: 'captured', capture: capture([]) } }), error => error.code === 'TOKEN_INVALID');
  const round = await service.acceptResult({ roundId: captureJob.roundId, claimant: ORIGIN, input: { captureId: captureJob.captureId, token: captureJob.token,
    status: 'captured', capture: capture([raw('1001', { sales: 80 }), raw('1002', { sales: 60 }), raw('1003', { sales: 30 })]), requestTemplate: { pageNum: 1 } } });
  assert.equal(round.status, 'completed');
  assert.equal(round.importedCandidateIds.length, 2);
  const candidates = read().candidates;
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].source, 'software');
  assert.match(candidates[0].productUrl, /^https:\/\/www\.ozon\.ru\/product\/100[12]$/);
  assert.match(candidates[0].imageUrl, /^https:\/\/ir\.ozone\.ru\//);
  assert.equal(candidates[0].seerfarWebDiscoveryEvidence.exactSkuMatch, 'unknown');
  // A second result for the same claim is refused: one result per claim.
  await assert.rejects(service.acceptResult({ roundId: captureJob.roundId, claimant: ORIGIN, input: { captureId: captureJob.captureId, token: captureJob.token,
    status: 'captured', capture: capture([raw('1004')]) } }), error => error.code === 'SESSION_INVALID');
  // The same query is not run twice on one business day.
  await assert.rejects(service.startRound({ actor: owner, targetStore: 'miska', queryId: plan.queries[0].queryId }), error => error.code === 'ALREADY_RUN_TODAY');
});

test('a failed or off-scope page closes the round with its reason and creates nothing', async () => {
  const { service, read } = harness();
  const queryId = service.view(read()).plans.miska.queries[0].queryId;
  let started = await service.startRound({ actor: owner, targetStore: 'miska', queryId });
  let { captureJob } = await service.claim(started.captureJob.jobId, '1.5.0', ORIGIN);
  let round = await service.acceptResult({ roundId: captureJob.roundId, claimant: ORIGIN,
    input: { captureId: captureJob.captureId, token: captureJob.token, status: 'failed', failureCode: 'site_login_required' } });
  assert.equal(round.failure.reason, 'Seerfar 没登录，插件停在了登录页');
  // A failed round does not count as run today.
  started = await service.startRound({ actor: owner, targetStore: 'miska', queryId });
  ({ captureJob } = await service.claim(started.captureJob.jobId, '1.5.0', ORIGIN));
  round = await service.acceptResult({ roundId: captureJob.roundId, claimant: ORIGIN, input: { captureId: captureJob.captureId, token: captureJob.token,
    status: 'captured', capture: capture([raw('1001', { categoryInfo: { ...raw('1').categoryInfo, cnTitlePath: '宠物用品 > 别的' } })]) } });
  assert.equal(round.failure.code, 'scope_mismatch');
  assert.equal(read().candidates.length, 0);
});

test('an unclaimed job closes itself, and a restart closes rounds whose job is gone', async () => {
  const { service, read } = harness({ options: { queueTtlMs: 20 } });
  const queryId = service.view(read()).plans.miska.queries[0].queryId;
  const started = await service.startRound({ actor: owner, targetStore: 'miska', queryId });
  await assert.rejects(service.startRound({ actor: owner, targetStore: 'miska', queryId }), error => error.code === 'CAPTURE_BUSY');
  await delay(60);
  assert.equal(read().runtime.seerfarWebRounds[started.round.roundId].failure.code, 'extension_job_unclaimed');

  const leftover = harness({ document: { runtime: { seerfarWebRounds: { 'seerfar-web-round:x': {
    ...read().runtime.seerfarWebRounds[started.round.roundId], roundId: 'seerfar-web-round:x', status: 'capturing', failure: null, completedAt: null } } } } });
  assert.deepEqual(await leftover.service.reconcileRoundsAfterRestart(), ['seerfar-web-round:x']);
  assert.equal(leftover.read().runtime.seerfarWebRounds['seerfar-web-round:x'].failure.code, 'capture_job_lost');
});

test('the newest completed store-sales snapshot adds one find-similar query per seed; owners mark nothing by hand', async () => {
  const snapshot = (id, status, startedAt, seeds) => ({ snapshotId: id, targetStore: 'miska', status, startedAt, seeds });
  const seed = sku => ({ seedId: `hot:${sku}`, kind: 'hot', marketProductId: sku, title: `Synthetic best seller ${sku}`, priceRub: 1000,
    evidence: '近 28 天 4 件，前 28 天 1 件', priceRmb: 85, offerId: null, hasStock: true, kindLabel: '卖得最多' });
  const { service, read } = harness({ document: { runtime: { storeSalesSnapshots: {
    a: snapshot('a', 'completed', '2026-10-08T00:00:00.000Z', [seed('3001')]),
    b: snapshot('b', 'completed', '2026-10-09T00:00:00.000Z', [seed('3002')]),
    c: snapshot('c', 'failed', '2026-10-10T00:00:00.000Z', []) } } } });
  const similar = service.view(read()).plans.miska.queries.filter(query => query.route === 'hot_similar');
  assert.deepEqual(similar.map(query => query.excludeMarketProductIds), [['3002']]);
  assert.deepEqual(similar[0].priceRub, { min: 700, max: 1300 });
  assert.deepEqual(similar[0].categoryPaths, [CLOTHING]);
  assert.equal(typeof service.markHotItem, 'undefined');
});

// Synthetic account values; the fake store stands in for the OS keychain.
const ACCOUNT = { accountId: '80012345', phone: '13812345678', email: 'owner.test@qq.com' };
const KEYCHAIN_ENTRY = { service: SEERFAR_ACCOUNT_KEYCHAIN_SERVICE, account: SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT };
async function capturedRound(service, read, input) {
  const queryId = service.view(read()).plans.miska.queries[0].queryId;
  const started = await service.startRound({ actor: owner, targetStore: 'miska', queryId });
  const { captureJob } = await service.claim(started.captureJob.jobId, '1.5.0', ORIGIN);
  return service.acceptResult({ roundId: captureJob.roundId, claimant: ORIGIN, input: { captureId: captureJob.captureId, token: captureJob.token,
    status: 'captured', capture: capture([raw('1001', { sales: 80 })]), ...input } });
}
const keychainValue = async store => JSON.parse(Buffer.from(await store.readSecret(KEYCHAIN_ENTRY), 'base64').toString('utf8'));

test('the account fields go to the keychain and the data file keeps only their masks, from the current extension or an older one', async () => {
  const store = createFakeCredentialStore();
  const { service, read } = harness({ options: { accountVault: createSeerfarAccountVault({ credentialStore: store }) } });
  // The current extension: search conditions and the three account fields arrive apart.
  let round = await capturedRound(service, read, { requestTemplate: { categoryIds: ['1_2_3'], pageNum: 1 }, accountIdentity: ACCOUNT });
  assert.equal(round.status, 'completed');
  assert.deepEqual(round.accountIdentity, { schemaVersion: 'seerfar-web-account-identity-v1', status: 'saved', fields: ['accountId', 'phone', 'email'],
    masked: { accountId: '80****45', phone: '138****5678', email: 'o***@qq.com' }, sameAsPrevious: null, location: 'fake_credential_store', failure: null });
  assert.deepEqual(await keychainValue(store), { schemaVersion: 'seerfar-web-account-v1', ...ACCOUNT, savedAt: AT });
  for (const full of Object.values(ACCOUNT)) assert.equal(JSON.stringify(read()).includes(full), false, full);

  // An older extension build posts the page's whole request body; the server does the same split itself.
  const older = harness({ options: { accountVault: createSeerfarAccountVault({ credentialStore: store }) } });
  round = await capturedRound(older.service, older.read, { requestTemplate: { categoryIds: ['1_2_3'], pageNum: 1, memberId: 80012345,
    phone: '138-1234-5678', token: 'synthetic-session-token', sig: 'synthetic-signature', nonce: 'n-1' } });
  assert.equal(round.accountIdentity.sameAsPrevious, true);
  assert.deepEqual(round.accountIdentity.fields, ['accountId', 'phone']);
  const saved = Object.values(older.read().runtime.seerfarWebRounds)[0];
  assert.deepEqual(saved.requestTemplate, { categoryIds: ['1_2_3'], pageNum: 1 });
  for (const leaked of ['80012345', '13812345678', '138-1234-5678', 'synthetic-session-token', 'synthetic-signature']) {
    assert.equal(JSON.stringify(older.read()).includes(leaked), false, leaked);
  }
});

test('a keychain that cannot be used, or a vault that breaks, still lets the round collect its products', async () => {
  // No vault (a runtime without one): the round says the fields were not saved.
  let { service, read } = harness();
  let round = await capturedRound(service, read, { requestTemplate: { pageNum: 1 }, accountIdentity: ACCOUNT });
  assert.equal(round.status, 'completed');
  assert.equal(round.importedCandidateIds.length, 1);
  assert.deepEqual([round.accountIdentity.status, round.accountIdentity.failure.code], ['not_saved', 'store_unavailable']);

  const denied = createFakeCredentialStore([{ ...KEYCHAIN_ENTRY, failure: 'credential_access_denied' }]);
  ({ service, read } = harness({ options: { accountVault: createSeerfarAccountVault({ credentialStore: denied }) } }));
  round = await capturedRound(service, read, { accountIdentity: ACCOUNT });
  assert.deepEqual([round.status, round.accountIdentity.failure.code], ['completed', 'access_denied']);
  assert.equal(denied.calls.length, 1, 'one read, no retry');

  const logs = [];
  ({ service, read } = harness({ options: { log: (...args) => logs.push(args),
    accountVault: { save: async () => { throw new TypeError(`synthetic defect ${ACCOUNT.phone}`); } } } }));
  round = await capturedRound(service, read, { accountIdentity: ACCOUNT });
  assert.deepEqual([round.status, round.accountIdentity.failure.code], ['completed', 'system_error']);
  assert.equal(JSON.stringify(logs).includes(ACCOUNT.phone), false, 'the log names the failure, never the values');

  // Nothing to save: no store is asked at all.
  const untouched = createFakeCredentialStore();
  ({ service, read } = harness({ options: { accountVault: createSeerfarAccountVault({ credentialStore: untouched }) } }));
  round = await capturedRound(service, read, { requestTemplate: { pageNum: 1 } });
  assert.equal(round.accountIdentity.status, 'not_in_request');
  assert.equal(untouched.calls.length, 0);
  assert.throws(() => harness({ options: { accountVault: {} } }), /SEERFAR_WEB_ROUND_SERVICE_DEPENDENCY_INVALID/);
});

test('a restart cuts request templates saved before the allowlist down to their search conditions', async () => {
  const { service: seed, read: seedRead } = harness();
  const queryId = seed.view(seedRead()).plans.miska.queries[0].queryId;
  const started = await seed.startRound({ actor: owner, targetStore: 'miska', queryId });
  const base = seedRead().runtime.seerfarWebRounds[started.round.roundId];
  const oldTemplate = { pageNum: 1, categoryIds: ['1_2_3'], memberId: 80012345, phone: '13812345678', email: 'owner.test@qq.com', nonce: 'n' };
  const leftover = harness({ document: { runtime: { seerfarWebRounds: {
    'seerfar-web-round:done': { ...base, roundId: 'seerfar-web-round:done', status: 'completed', completedAt: AT, requestTemplate: oldTemplate },
    'seerfar-web-round:clean': { ...base, roundId: 'seerfar-web-round:clean', status: 'completed', completedAt: AT, requestTemplate: { pageNum: 1 } },
    'seerfar-web-round:empty': { ...base, roundId: 'seerfar-web-round:empty', status: 'completed', completedAt: AT, requestTemplate: { memberId: 1 } }
  } } } });
  assert.deepEqual(await leftover.service.reconcileRoundsAfterRestart(), []);
  const rounds = leftover.read().runtime.seerfarWebRounds;
  assert.deepEqual(rounds['seerfar-web-round:done'].requestTemplate, { pageNum: 1, categoryIds: ['1_2_3'] });
  assert.deepEqual(rounds['seerfar-web-round:clean'].requestTemplate, { pageNum: 1 });
  assert.equal(rounds['seerfar-web-round:empty'].requestTemplate, null);
  assert.equal(rounds['seerfar-web-round:done'].status, 'completed');
  for (const full of Object.values(ACCOUNT)) assert.equal(JSON.stringify(leftover.read()).includes(full), false, full);
  // Already clean: the second restart writes nothing.
  const before = leftover.read();
  await leftover.service.reconcileRoundsAfterRestart();
  assert.equal(leftover.read(), before);
});
