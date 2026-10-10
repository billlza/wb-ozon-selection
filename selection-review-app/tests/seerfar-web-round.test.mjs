import test from 'node:test';
import assert from 'node:assert/strict';
import { SEERFAR_WEB_SEARCH_ENDPOINT, SEERFAR_WEB_SEARCH_PAGE } from '../lib/seerfar-web-discovery-contract.mjs';
import { estimateDiscoveredProduct } from '../lib/a-discovery-estimate.mjs';
import { planSeerfarQueries } from '../lib/seerfar-selection-plan.mjs';
import { screenSeerfarProducts } from '../lib/seerfar-selection-screening.mjs';
import { claimSeerfarWebRound, completeSeerfarWebRound, createSeerfarWebRoundRecord, failSeerfarWebRound, normalizeSeerfarWebCapture,
  sameQueryRoundToday, sanitizeSeerfarRequestTemplate, seerfarWebCandidateEvidence, seerfarWebEstimateProduct,
  seerfarWebRoundPublic } from '../lib/seerfar-web-round.mjs';

// Every SKU, seller, price and metric below is synthetic, shaped like the 2026-09-10 member-site search response.
const CLOTHING = '宠物用品 > 宠物服装和靴子 > 宠物服装';
const BED = '宠物用品 > 携带和睡眠配件 > 宠物躺床';
const AT = '2026-10-10T03:00:00.000Z';

const profile = { schemaVersion: 'seerfar-store-selection-profile-v1', targetStore: 'miska', version: 'miska-test-1', categoryPaths: [CLOTHING],
  excludedCategoryPaths: [BED], priceRub: { min: 800, max: null }, maxWeightGrams: 1000, minMonthlySales: 20, picksPerRound: 2,
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
  const completed = completeSeerfarWebRound({ document, record, result, profile, knownProductIds: new Set(), estimates, at: AT,
    requestTemplate: { pageNum: 1, pageSize: 20, categoryIds: ['1_2_3'], sellerType: 1, token: 'should-go', userId: 9, filters: { salesMin: 10, authSign: 'x' } },
    createCandidate: (product, entry) => {
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
});

test('request templates keep field names and short values only', () => {
  assert.deepEqual(sanitizeSeerfarRequestTemplate({ a: 'x'.repeat(200), 'bad key': 1, nested: { sessionId: 'x', ok: [1, 'y'] }, Ticket: 't' }),
    { a: null, nested: { ok: [1, 'y'] } });
});
