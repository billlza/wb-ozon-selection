import test from 'node:test';
import assert from 'node:assert/strict';
import { SEERFAR_WEB_SEARCH_ENDPOINT, SEERFAR_WEB_SEARCH_PAGE } from '../lib/seerfar-web-discovery-contract.mjs';
import { estimateDiscoveredProduct } from '../lib/a-discovery-estimate.mjs';
import { planSeerfarQueries } from '../lib/seerfar-selection-plan.mjs';
import { screenSeerfarProducts } from '../lib/seerfar-selection-screening.mjs';
import { claimSeerfarWebRound, completeSeerfarWebRound, createSeerfarWebRoundRecord, failSeerfarWebRound, normalizeSeerfarWebCapture,
  sameQueryRoundToday, sanitizeSeerfarRequestTemplate, seerfarWebCandidateEvidence, seerfarWebEstimateProduct,
  seerfarWebRoundPublic } from '../lib/seerfar-web-round.mjs';
import { seerfarAccountIdentityFailure } from '../lib/seerfar-account-identity.mjs';
import { buildSeerfarCategoryPayload } from '../lib/seerfar-open-api-transport.mjs';
import { assertSafeRuntimeRecord } from '../lib/runtime-identity.mjs';

// Every SKU, seller, price and metric below is synthetic, shaped like the 2026-09-10 member-site search response.
const CLOTHING = '宠物用品 > 宠物服装和靴子 > 宠物服装';
const BED = '宠物用品 > 携带和睡眠配件 > 宠物躺床';
const AT = '2026-10-10T03:00:00.000Z';

const profile = { schemaVersion: 'seerfar-store-selection-profile-v1', targetStore: 'miska', version: 'miska-test-1', positioning: '合成测试店', categoryPaths: [CLOTHING],
  excludedCategoryPaths: [BED], priceRub: { min: 800, max: null }, maxWeightGrams: 1000, presaleMaxDays: 14, minMonthlySales: 20, picksPerRound: 2,
  similarPriceBandRate: 0.3, seedPolicy: { maxSeeds: 3, hotMinUnits: 3, risingMinUnits: 2, risingMinRatio: 2, potentialMinViews: 2000, potentialMinToCartRate: 0.01, potentialMaxUnits: 1 }, note: null };
const calendar = { schemaVersion: 'seerfar-season-calendar-v1', version: 'season-test-1', windows: [] };

function raw(sku, overrides = {}) {
  return { sku, title: `Synthetic dog coat ${sku}`, productUrl: `https://www.ozon.ru/product/${sku}`,
    imageUrl: `https://ir.ozone.ru/s3/multimedia-1-x/wc250/${sku}.jpg`, price: 1200, sales: 50, revenue: 60000, reviewCount: 10, reviewRating: 4.8,
    sellerType: 1, sellerId: 42, sellerName: 'Synthetic seller', fulfillment: ['RFBS'], grossMargin: null, salesRate: null, revenueRate: null,
    weight: 250, volume: 1.2, dimension: '300x200x50', variants: 3, returnCancellationRate: null, views: 1000, sessionCount: 300, upTime: Date.parse('2026-09-01T00:00:00Z'),
    categoryInfo: { category: { id: '1_2_3' }, fullCategoryId: ['1', '1_2', '1_2_3'], titlePath: 'Товары для животных > Одежда > Одежда для собак',
      cnTitlePath: CLOTHING, enTitlePath: 'Pet Supplies > Clothing > Pet Clothing' }, ...overrides };
}
function capture(records, overrides = {}) {
  return { pageUrl: SEERFAR_WEB_SEARCH_PAGE, endpoint: SEERFAR_WEB_SEARCH_ENDPOINT, httpStatus: 200, capturedAt: AT, resultCountLabel: '共812条记录', records, ...overrides };
}
// Official-looking inputs for the rough estimate only; numbers are synthetic.
const storeRule = { advertisingReserveRate: 0, returnOpsReserveRate: 0.03, damageLossReserveRate: 0.02, withdrawalFeeRate: 0.012, labelCostRmb: 0.5,
  fixedOtherRmb: 0, minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either' };
const tariffRows = [{ route: 'synthetic-small', evidenceData: { perKgRmb: 40, perParcelRmb: 15, weightLimit: '0.001-2KG', sizeLimit: '三边之和不超150CM，单边最大尺寸不超60CM' } }];
const estimate = product => estimateDiscoveredProduct({ product: seerfarWebEstimateProduct(product), storeRule, fx: { rubPerCny: 12 },
  commission: { rate: 0.12 }, tariffRows, assumptions: { packagingRmbDefault: 3 } });

function round() {
  const plan = planSeerfarQueries({ businessDate: '2026-10-10', profile, calendar });
  return createSeerfarWebRoundRecord({ targetStore: 'miska', businessDate: '2026-10-10', query: plan.queries[0], plan, requestedBy: 'user:owner',
    at: AT, captureId: 'SWR-00000000-0000-4000-8000-000000000001' });
}

test('a round carries one single-use read permit scoped to one result page', () => {
  const record = round();
  assert.equal(record.status, 'waiting_extension');
  assert.deepEqual(record.request.categoryPaths, [CLOTHING]);
  assert.equal(record.readPermit.maxPages, 1);
  assert.equal(record.readPermit.useCount, 0);
  const claimed = claimSeerfarWebRound(record, AT);
  assert.equal(claimed.readPermit.useCount, 1);
  assert.throws(() => claimSeerfarWebRound(claimed, AT), /NOT_CLAIMABLE/);
  assert.equal(failSeerfarWebRound(claimed, 'no_matching_search', AT).failure.reason, '等了 3 分钟，没收到这几个类目的搜索结果');
  assert.equal(failSeerfarWebRound(claimed, 'made_up', AT).failure.code, 'system_error');
});

test('the same query runs once per store and business day; a failed round can be run again', () => {
  const document = { runtime: { seerfarWebRounds: {} } };
  const record = round();
  document.runtime.seerfarWebRounds[record.roundId] = record;
  const key = { targetStore: 'miska', queryId: record.query.queryId, businessDate: '2026-10-10' };
  assert.equal(sameQueryRoundToday(document, key)?.roundId, record.roundId);
  assert.equal(sameQueryRoundToday(document, { ...key, businessDate: '2026-10-11' }), null);
  document.runtime.seerfarWebRounds[record.roundId] = failSeerfarWebRound(record, 'timeout', AT);
  assert.equal(sameQueryRoundToday(document, key), null);
});

test('screening drops each product with its own reason and keeps the top ones by ceiling × sales', () => {
  const record = claimSeerfarWebRound(round(), AT);
  const result = normalizeSeerfarWebCapture(record, capture([
    raw('1001', { price: 1500, sales: 80 }),          // kept #1
    raw('1002', { price: 1100, sales: 60 }),          // kept #2
    raw('1003', { price: 1000, sales: 30 }),          // passes but beyond top 2
    raw('1004'),                                       // already a candidate
    raw('1005', { price: 500 }),                       // below the price band
    raw('1006', { weight: null }),                     // no weight
    raw('1007', { weight: 1500 }),                     // too heavy
    raw('1008', { sales: 5 }),                         // below the sales line
    raw('1009', { price: 810, weight: 900, dimension: '590x400x300' }) // freight eats it all
  ]));
  assert.equal(result.status, 'candidates_found');
  const estimates = new Map(result.products.map(product => [product.productId, estimate(product)]));
  const screening = screenSeerfarProducts({ products: result.products, query: record.query, profile, knownProductIds: new Set(['1004']), estimates, businessTime: AT });
  assert.deepEqual(screening.kept.map(entry => entry.productId), ['1001', '1002']);
  assert.equal(screening.kept[0].newListing, true);
  assert.deepEqual(Object.fromEntries(screening.dropped.map(entry => [entry.productId, entry.code])), {
    1003: 'below_top_k', 1004: 'already_seen', 1005: 'price_out_of_band', 1006: 'weight_unknown', 1007: 'too_heavy', 1008: 'sales_below_line', 1009: 'profit_negative' });
  assert.equal(screening.counts.total, 9);
});

test('missing official inputs leave the product out with the gap named, never a guessed number', () => {
  const record = claimSeerfarWebRound(round(), AT);
  const result = normalizeSeerfarWebCapture(record, capture([raw('1001')]));
  const incomplete = estimateDiscoveredProduct({ product: seerfarWebEstimateProduct(result.products[0]), storeRule, fx: null, commission: null, tariffRows,
    assumptions: { packagingRmbDefault: 3 } });
  const screening = screenSeerfarProducts({ products: result.products, query: record.query, profile, knownProductIds: new Set(), estimates: new Map([['1001', incomplete]]), businessTime: AT });
  assert.equal(screening.kept.length, 0);
  assert.match(screening.dropped[0].reason, /缺汇率、官方佣金/);
});

test('a capture from another category or off-contract fails the round instead of being half-used', () => {
  const record = claimSeerfarWebRound(round(), AT);
  const otherCategory = raw('1001', { categoryInfo: { ...raw('1').categoryInfo, cnTitlePath: BED } });
  assert.equal(normalizeSeerfarWebCapture(record, capture([otherCategory])).error, 'scope_mismatch');
  assert.equal(normalizeSeerfarWebCapture(record, capture([raw('1001', { price: -1 })])).error, 'results_unverifiable');
  assert.equal(normalizeSeerfarWebCapture(record, capture([raw('1001')], { endpoint: 'https://www.seerfar.cn/other' })).error, 'results_unverifiable');
});

test('completing a round saves the page, the screening and one candidate per kept product in one go', () => {
  const record = claimSeerfarWebRound(round(), AT);
  const document = { runtime: { seerfarWebRounds: { [record.roundId]: record } }, candidates: [] };
  const result = normalizeSeerfarWebCapture(record, capture([raw('1001', { price: 1500, sales: 80 }), raw('1002', { price: 1100, sales: 60 }), raw('1003')]));
  const estimates = new Map(result.products.map(product => [product.productId, estimate(product)]));
  const evidences = [];
  const accountIdentity = seerfarAccountIdentityFailure({ accountId: '80012345', phone: '13812345678', email: null }, 'write_failed');
  const completed = completeSeerfarWebRound({ document, record, result, profile, knownProductIds: new Set(), estimates, at: AT,
    requestTemplate: { pageNum: 1, pageSize: 20, categoryIds: ['1_2_3'], sellerType: 1, token: 'should-go', userId: 9, filters: { salesMin: 10, authSign: 'x' },
      memberId: 80012345, phone: '13812345678', email: 'owner.test@qq.com' },
    accountIdentity, createCandidate: (product, entry) => {
      evidences.push(seerfarWebCandidateEvidence({ record, product, entry, candidateRevision: 1 }));
      return `candidate:${product.productId}`;
    } });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.importedCandidateIds, ['candidate:1001', 'candidate:1002']);
  assert.deepEqual(completed.requestTemplate, { pageNum: 1, pageSize: 20, categoryIds: ['1_2_3'], sellerType: 1, filters: { salesMin: 10 } });
  assert.equal(document.runtime.seerfarWebResults[record.roundId].products.length, 3);
  assert.equal(document.runtime.seerfarWebRounds[record.roundId].status, 'completed');
  assert.equal(evidences[0].exactSkuMatch, 'unknown');
  assert.equal(evidences[0].businessEffect, 'discovery_evidence_only');
  assert.equal(evidences[0].route, 'store_category');
  const view = seerfarWebRoundPublic(completed);
  assert.equal(view.requestTemplateCaptured, true);
  assert.equal(JSON.stringify(view).includes('readPermit'), false);
  // Only masks reach the round and the page; the full values never enter the data document.
  assert.deepEqual(view.accountIdentity, accountIdentity);
  assert.deepEqual(document.runtime.seerfarWebRounds[record.roundId].accountIdentity.masked, { accountId: '80****45', phone: '138****5678', email: null });
  for (const full of ['80012345', '13812345678', 'owner.test@qq.com']) assert.equal(JSON.stringify(document).includes(full), false, full);
  assert.throws(() => completeSeerfarWebRound({ document: { runtime: { seerfarWebRounds: {} }, candidates: [] }, record, result, profile,
    knownProductIds: new Set(), estimates, at: AT, accountIdentity: { ...accountIdentity, masked: { accountId: '80012345', phone: null, email: null } },
    createCandidate: () => 'candidate:x' }), /ACCOUNT_IDENTITY_INVALID/);
});

test('request templates keep only the search conditions; account, identity and credential fields go whole', () => {
  assert.deepEqual(sanitizeSeerfarRequestTemplate({ keyword: 'x'.repeat(200), 'bad key': 1, filters: { sessionId: 'x', price: { min: 800, max: null } },
    Ticket: 't', nested: { ok: [1, 'y'] } }), { keyword: null, filters: { price: { min: 800, max: null } } });
  // The fields named in review item P1-22, and their usual cousins.
  const identity = { memberId: 1, shopId: 2, nonce: 'n', sig: 'abc', jwt: 'x', accountId: 3, phone: '13812345678', email: 'a@b.cn', userId: 4,
    uid: 5, customerId: 6, loginName: 'owner', mobile: '13812345678', timestamp: 1760000000000, t: 1, ts: 2, deviceId: 'd', openid: 'o',
    returnUrl: 'https://www.seerfar.cn/x', apiKey: 'k', appKey: 'k', signKey: 'k', expiresAt: 'x', headers: {}, cookie: 'c', authorization: 'Bearer x',
    credential: 'c', bearer: 'b', basic: 'b', password: 'p', ip: '127.0.0.1', birthday: '2000-01-01', nickname: 'n' };
  assert.equal(sanitizeSeerfarRequestTemplate(identity), null);
  assert.deepEqual(sanitizeSeerfarRequestTemplate({ categoryIds: ['1_2_3'], ...identity, filters: identity }), { categoryIds: ['1_2_3'], filters: {} });
  // A search key keeps its name but not a value that is an address, an assignment, a mail, a phone or a token.
  assert.deepEqual(sanitizeSeerfarRequestTemplate({ keyword: 'owner@qq.com', brandName: ['https://a.example/x', 'token=abc', 'Bearer abcdef', 'Nike'],
    tag: '13812345678', sort: 'eyJhbGciOiJIUzI1NiJ9.e30', label: 'a1b2c3d4e5f6a7b8c9d0e1f2a3', priceMin: 13812345678, salesMax: 120, isNew: true }),
    { keyword: null, brandName: [null, null, null, 'Nike'], tag: null, sort: null, label: null, priceMin: null, salesMax: 120, isNew: true });
  assert.equal(sanitizeSeerfarRequestTemplate(['pageNum', 1]), null);
  assert.equal(sanitizeSeerfarRequestTemplate('pageNum=1'), null);
});

test('the open API category request shape survives the allowlist, so the same query can be built again', () => {
  const body = buildSeerfarCategoryPayload({ platform: 'ozon', categoryId: '17027494_17028712_93366', fulfillment: 'CROSS_BORDER',
    filters: { priceRub: { min: 800, max: null }, weightGrams: { min: null, max: 1000 } } });
  const template = sanitizeSeerfarRequestTemplate({ ...body, sellerType: 1, dateRange: 30, memberId: 80012345, phone: '13812345678' });
  const { skus: _skus, sellerName: _sellerName, ...searchConditions } = body;
  assert.deepEqual(template, { ...searchConditions, sellerType: 1, dateRange: 30 });
  // Cleaning twice changes nothing, which is what lets old rounds be cleaned on restart.
  assert.deepEqual(sanitizeSeerfarRequestTemplate(template), template);
});

test('a request whose keys or values the record check refuses no longer leaves the round stuck in capturing', () => {
  const record = claimSeerfarWebRound(round(), AT);
  const document = { runtime: { seerfarWebRounds: { [record.roundId]: record } }, candidates: [] };
  const result = normalizeSeerfarWebCapture(record, capture([raw('1001', { price: 1500, sales: 80 })]));
  const estimates = new Map(result.products.map(product => [product.productId, estimate(product)]));
  const completed = completeSeerfarWebRound({ document, record, result, profile, knownProductIds: new Set(), estimates, at: AT,
    requestTemplate: { credential: 'x', bearer: 'y', basic: 'z', headers: { Authorization: 'Bearer abc' }, categoryIds: ['1_2_3'],
      filters: { keyword: 'Basic dXNlcjpwYXNz', sort: 'sales' } },
    createCandidate: product => `candidate:${product.productId}` });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.requestTemplate, { categoryIds: ['1_2_3'], filters: { keyword: null, sort: 'sales' } });
  assert.equal(completed.accountIdentity, null);
  assert.doesNotThrow(() => assertSafeRuntimeRecord(completed));
});
