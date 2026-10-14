import test from 'node:test';
import assert from 'node:assert/strict';
import { SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION, SEERFAR_WEB_DISCOVERY_PROVIDER, SEERFAR_WEB_SEARCH_PAGE, SEERFAR_WEB_SEARCH_ENDPOINT,
  SEERFAR_WEB_PAGE_SIZE, SeerfarWebDiscoveryContractError, assertSeerfarWebDiscoveryRequest, normalizeSeerfarWebRecord,
  buildSeerfarWebDiscoveryResult, assertSeerfarWebDiscoveryResult } from '../lib/seerfar-web-discovery-contract.mjs';

// Every SKU, seller, price, category id and metric below is a synthetic stand-in shaped like the 2026-09-10 member-site
// search response (see the local trial notes); nothing here is a real product, seller or authorized query.
const PET_BED = '宠物用品 > 携带和睡眠配件 > 宠物躺床';
const PET_HOUSE = '宠物用品 > 携带和睡眠配件 > 宠物屋';
const evidenceRef = 'seerfar-web:synthetic-capture-1';
const capturedAt = '2026-09-10T03:47:47.688Z';
const CONTROL_CHARACTER_TITLE = `bad${String.fromCharCode(7)}title`;

function request(overrides = {}) {
  return { requestId: 'request:synthetic-web-1', provider: SEERFAR_WEB_DISCOVERY_PROVIDER, contractVersion: SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION,
    platform: 'ozon', pageUrl: SEERFAR_WEB_SEARCH_PAGE, categoryPaths: [PET_BED, PET_HOUSE], sellerType: 'cross_border', dateRange: 'last_30_days',
    maxRecords: 20, ...overrides };
}

function rawRecord(sku, overrides = {}) {
  return {
    sku, title: `Synthetic pet bed ${sku}`, productUrl: `https://www.ozon.ru/product/${sku}`, brandId: 1, brandName: 'Synthetic brand', brandUrl: null,
    imageUrl: `https://ir.ozone.ru/s3/multimedia-1-x/wc250/${sku}.jpg`, sellerId: 4242, sellerName: 'Synthetic seller', sellers: 1,
    fulfillment: ['RFBS', 'FBS'], weight: 850, questionsAndAnswers: 3, upTime: 1735689600000, upDays: 250, upMonths: 8, price: 1290, profit: null,
    multipleProfit: null, grossMargin: 42.5, reviewCount: 41, reviewRating: 4.8, reviewIncr: null, ratingsRate: null, sales: 120, originSales: null,
    salesRate: 12.5, revenue: 154800, revenueRate: 9.1,
    categoryInfo: { category: { id: '100_200_301', enTitle: 'Pet Bed', title: 'Лежанка', cnTitle: '宠物躺床', pid: '100_200', level: 3, disabled: false,
      crossBorderSellable: true, children: null }, fullCategoryId: ['100', '100_200', '100_200_301'],
      titlePath: 'Товары для животных > Аксессуары для переноски и сна > Лежанка', cnTitlePath: PET_BED, enTitlePath: 'Pet Supplies > Carry and Sleep > Pet Bed' },
    volume: 12.4, dimension: '600x450x150', labels: [], variants: 3, variationIds: [1, 2, 3], variationsRelationId: null, sellerType: 1,
    sessionCount: 900, sessionCountSearch: 300, drr: 4.2, convToCartSearch: 1.1, discount: 15, promoRevenueShare: 20, convViewToOrder: 2.2,
    convToCartPdp: 3.3, returnCancellationRate: 1.5, orderConversionRate: 2.0, naturalRank: null, adRank: null, categoryRank: null, views: 5000,
    missedRevenue: 100, ...overrides
  };
}

function capture(records, overrides = {}) {
  return { pageUrl: SEERFAR_WEB_SEARCH_PAGE, endpoint: SEERFAR_WEB_SEARCH_ENDPOINT, httpStatus: 200, capturedAt, resultCountLabel: '共5000条记录', records, ...overrides };
}

const rejects = (fn, code) => assert.throws(fn, error => error instanceof SeerfarWebDiscoveryContractError && error.code === code);

test('request contract is closed and scoped to the member-site search page', () => {
  const declared = request();
  const accepted = assertSeerfarWebDiscoveryRequest(declared);
  assert.deepEqual(accepted, declared);
  assert.notEqual(accepted, declared);
  accepted.categoryPaths.push('x');
  assert.equal(declared.categoryPaths.length, 2);
  for (const bad of [
    request({ extra: true }), request({ provider: 'seerfar' }), request({ contractVersion: 'seerfar-category-discovery-v1' }), request({ platform: 'wb' }),
    request({ pageUrl: 'https://www.seerfar.cn/admin/other' }), request({ categoryPaths: [] }), request({ categoryPaths: [PET_BED, PET_BED] }),
    request({ categoryPaths: [' ' + PET_BED] }), request({ sellerType: 'chinese' }), request({ dateRange: 'last_7_days' }),
    request({ maxRecords: SEERFAR_WEB_PAGE_SIZE + 1 }), request({ maxRecords: 0 }), request({ requestId: 'bad ref' })
  ]) rejects(() => assertSeerfarWebDiscoveryRequest(bad), 'REQUEST_INVALID');
});

test('a raw search record becomes one strict market product and page-only fields are dropped', () => {
  const product = normalizeSeerfarWebRecord(rawRecord(2107989735), 0, evidenceRef);
  assert.deepEqual(product, {
    productId: '2107989735', platform: 'ozon', productUrl: 'https://www.ozon.ru/product/2107989735', title: 'Synthetic pet bed 2107989735',
    imageUrl: 'https://ir.ozone.ru/s3/multimedia-1-x/wc250/2107989735.jpg', price: 1290, currency: 'RUB', salesCount: 120, revenue: 154800,
    categoryPath: { fullCategoryId: ['100', '100_200', '100_200_301'], titlePath: 'Товары для животных > Аксессуары для переноски и сна > Лежанка',
      cnTitlePath: PET_BED, enTitlePath: 'Pet Supplies > Carry and Sleep > Pet Bed' },
    sellerIdentity: 'unknown', providerRecordRef: `${evidenceRef}#product-0`, reviewCount: 41, reviewRating: 4.8, rawSellerType: 1,
    webMetrics: { sellerId: 4242, sellerName: 'Synthetic seller', fulfillment: ['RFBS', 'FBS'], grossMarginPercent: 42.5, salesRatePercent: 12.5,
      revenueRatePercent: 9.1, weightGrams: 850, volumeLitres: 12.4, dimensionMm: '600x450x150', variantCount: 3, returnCancellationRatePercent: 1.5,
      views: 5000, sessionCount: 900, listedAt: '2025-01-01T00:00:00.000Z' }
  });
  const sparse = normalizeSeerfarWebRecord(rawRecord('77', { sales: null, revenue: undefined, reviewCount: null, reviewRating: null, sellerType: null,
    sellerId: null, sellerName: '', fulfillment: null, grossMargin: null, salesRate: null, revenueRate: null, weight: null, volume: null, dimension: null,
    variants: null, returnCancellationRate: null, views: null, sessionCount: null, upTime: null, imageUrl: '' }), 3, evidenceRef);
  assert.equal(sparse.productId, '77');
  assert.equal(sparse.imageUrl, null);
  assert.equal(sparse.salesCount, null);
  assert.equal(sparse.rawSellerType, null);
  assert.deepEqual(sparse.webMetrics.fulfillment, []);
  assert.equal(sparse.webMetrics.listedAt, null);
  assert.equal(sparse.providerRecordRef, `${evidenceRef}#product-3`);
  // Image links are canonicalized like the capture sanitizer does: query, port and credentials never enter the record.
  const stripped = normalizeSeerfarWebRecord(rawRecord(8, { imageUrl: 'https://ir.ozone.ru/8.jpg?token=x' }), 0, evidenceRef);
  assert.equal(stripped.imageUrl, 'https://ir.ozone.ru/8.jpg');
});

test('unexpected raw values fail closed instead of being coerced', () => {
  const cases = [
    rawRecord(0), rawRecord('12a'), rawRecord(5, { productUrl: 'https://www.ozon.ru/product/6' }), rawRecord(5, { productUrl: 'http://www.ozon.ru/product/5' }),
    rawRecord(5, { productUrl: 'https://www.ozon.ru/product/5?tracking=1' }), rawRecord(5, { title: '' }), rawRecord(5, { title: CONTROL_CHARACTER_TITLE }),
    rawRecord(5, { imageUrl: 'https://cdn.example.test/5.jpg' }), rawRecord(5, { imageUrl: 'http://ir.ozone.ru/5.jpg' }), rawRecord(5, { price: 0 }),
    rawRecord(5, { price: '1290' }), rawRecord(5, { sales: -1 }), rawRecord(5, { sales: 1.5 }), rawRecord(5, { revenue: -10 }), rawRecord(5, { reviewRating: 5.5 }),
    rawRecord(5, { sellerType: '1' }), rawRecord(5, { fulfillment: ['DBS'] }), rawRecord(5, { fulfillment: ['FBS', 'FBS'] }), rawRecord(5, { fulfillment: 'FBS' }),
    rawRecord(5, { categoryInfo: null }), rawRecord(5, { categoryInfo: { ...rawRecord(5).categoryInfo, fullCategoryId: [] } }),
    rawRecord(5, { categoryInfo: { ...rawRecord(5).categoryInfo, fullCategoryId: ['100', '100_200', '100_200_999'] } }),
    rawRecord(5, { categoryInfo: { ...rawRecord(5).categoryInfo, cnTitlePath: '' } }), rawRecord(5, { sellerName: 'x'.repeat(201) }),
    rawRecord(5, { upTime: 'yesterday' }), rawRecord(5, { views: true }), null, [], 'record'
  ];
  for (const raw of cases) rejects(() => normalizeSeerfarWebRecord(raw, 0, evidenceRef), 'RECORD_INVALID');
  rejects(() => normalizeSeerfarWebRecord(rawRecord(5), -1, evidenceRef), 'RECORD_INVALID');
  rejects(() => normalizeSeerfarWebRecord(rawRecord(5), 0, 'bad ref'), 'RECORD_INVALID');
});

test('build accepts only a whole page capture and bounds it by the declared request', () => {
  const declared = request({ maxRecords: 2 });
  const result = buildSeerfarWebDiscoveryResult({ request: declared, capture: capture([rawRecord(1), rawRecord(2), rawRecord(3)]), evidenceRef });
  assert.equal(result.status, 'candidates_found');
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products.map(product => product.productId), ['1', '2']);
  assert.deepEqual(result.collection, { pageNumber: 1, pageSize: SEERFAR_WEB_PAGE_SIZE, hasNextPage: false });
  assert.deepEqual(result.categoryPaths, declared.categoryPaths);
  assert.equal(result.sellerTypeFilter, 'cross_border');
  assert.equal(result.evidenceRef, evidenceRef);
  assert.deepEqual(assertSeerfarWebDiscoveryResult(result, declared), result);

  const fullPage = buildSeerfarWebDiscoveryResult({ request: request(), capture: capture(Array.from({ length: 20 }, (_, i) => rawRecord(i + 1))), evidenceRef });
  assert.equal(fullPage.products.length, 20);
  assert.equal(fullPage.collection.hasNextPage, true);

  const empty = buildSeerfarWebDiscoveryResult({ request: request(), capture: capture([], { resultCountLabel: '共0条记录' }), evidenceRef });
  assert.equal(empty.status, 'true_empty');
  assert.deepEqual(empty.products, []);

  for (const bad of [
    capture([rawRecord(1)], { httpStatus: 500 }), capture([rawRecord(1)], { endpoint: 'https://www.seerfar.cn/product-report/product/export' }),
    capture([rawRecord(1)], { pageUrl: 'https://www.seerfar.cn/admin/other' }), capture([rawRecord(1)], { capturedAt: 'today' }),
    capture([rawRecord(1)], { resultCountLabel: '' }), capture([rawRecord(1)], { extra: 1 }), capture(Array.from({ length: 21 }, (_, i) => rawRecord(i + 1))),
    capture('records'), { ...capture([rawRecord(1)]), records: undefined }
  ]) rejects(() => buildSeerfarWebDiscoveryResult({ request: request(), capture: bad, evidenceRef }), 'CAPTURE_INVALID');
  rejects(() => buildSeerfarWebDiscoveryResult({ request: request(), capture: capture([rawRecord(1)]), evidenceRef: 'bad ref' }), 'CAPTURE_INVALID');
  rejects(() => buildSeerfarWebDiscoveryResult({ request: request({ maxRecords: 40 }), capture: capture([]), evidenceRef }), 'REQUEST_INVALID');
});

test('records outside the declared category or seller scope are rejected as scope mismatch', () => {
  const otherCategory = rawRecord(9, { categoryInfo: { ...rawRecord(9).categoryInfo, cnTitlePath: '宠物用品 > 宠物服装和靴子 > 宠物服装' } });
  rejects(() => buildSeerfarWebDiscoveryResult({ request: request(), capture: capture([rawRecord(1), otherCategory]), evidenceRef }), 'SCOPE_MISMATCH');
  rejects(() => buildSeerfarWebDiscoveryResult({ request: request(), capture: capture([rawRecord(1, { sellerType: 2 })]), evidenceRef }), 'SCOPE_MISMATCH');
  rejects(() => buildSeerfarWebDiscoveryResult({ request: request(), capture: capture([rawRecord(1, { sellerType: null })]), evidenceRef }), 'SCOPE_MISMATCH');
  const local = buildSeerfarWebDiscoveryResult({ request: request({ sellerType: 'all' }), capture: capture([rawRecord(1, { sellerType: 2 })]), evidenceRef });
  assert.equal(local.products[0].rawSellerType, 2);
});

test('stored results must stay canonical and bound to their request', () => {
  const declared = request();
  const result = buildSeerfarWebDiscoveryResult({ request: declared, capture: capture([rawRecord(1), rawRecord(2)]), evidenceRef });
  const tamper = mutate => { const copy = structuredClone(result); mutate(copy); return copy; };
  for (const [broken, code] of [
    [tamper(copy => { copy.products[0].price = 0; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.products[0].extra = true; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.products[0].providerRecordRef = `${evidenceRef}#product-9`; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.products[0].currency = null; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.products[0].webMetrics.listedAt = 'later'; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.products[1] = { ...copy.products[0] }; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.status = 'true_empty'; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.collection.pageNumber = 2; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.categoryPaths = [PET_BED]; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.provider = 'seerfar'; }), 'RESULT_INVALID'],
    [tamper(copy => { delete copy.resultCountLabel; }), 'RESULT_INVALID'],
    [tamper(copy => { copy.products[0].categoryPath.cnTitlePath = '宠物用品 > 其他'; }), 'SCOPE_MISMATCH'],
    [tamper(copy => { copy.products[0].rawSellerType = 2; }), 'SCOPE_MISMATCH']
  ]) rejects(() => assertSeerfarWebDiscoveryResult(broken, declared), code);
  rejects(() => assertSeerfarWebDiscoveryResult(result, request({ requestId: 'request:synthetic-web-2' })), 'RESULT_INVALID');
  rejects(() => assertSeerfarWebDiscoveryResult(result, request({ sellerType: 'all' })), 'RESULT_INVALID');
  rejects(() => assertSeerfarWebDiscoveryResult(result, request({ maxRecords: 1 })), 'RESULT_INVALID');
  const accepted = assertSeerfarWebDiscoveryResult(result, declared);
  assert.deepEqual(accepted, result);
  assert.notEqual(accepted, result);
});
