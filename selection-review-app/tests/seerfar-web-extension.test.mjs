import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SEERFAR_WEB_MODE, SEERFAR_WEB_SEARCH_ENDPOINT, SEERFAR_WEB_SEARCH_PAGE, classifySeerfarAddress, installSeerfarSearchHookInPage,
  pickSeerfarAccountIdentity as extensionIdentity, readSeerfarSearchCapturesInPage, runSeerfarWebCapture,
  sanitizeSeerfarRequestTemplate as extensionTemplate, validateSeerfarWebRequest } from '../extension/1688-capture/seerfar-web-capture.js';
import { buildSeerfarCategoryPayload } from '../lib/seerfar-open-api-transport.mjs';
import { pickSeerfarAccountIdentity } from '../lib/seerfar-account-identity.mjs';
import { sanitizeSeerfarRequestTemplate } from '../lib/seerfar-web-round.mjs';

const CLOTHING = '宠物用品 > 宠物服装和靴子 > 宠物服装';
function payload(overrides = {}) {
  return { captureId: 'SWR-00000000-0000-4000-8000-000000000001', jobId: 'SWR-00000000-0000-4000-8000-000000000001',
    roundId: 'seerfar-web-round:00000000-0000-4000-8000-000000000002', mode: SEERFAR_WEB_MODE, pageUrl: SEERFAR_WEB_SEARCH_PAGE,
    endpoint: SEERFAR_WEB_SEARCH_ENDPOINT, categoryPaths: [CLOTHING], sellerType: 'cross_border', maxRecords: 20, waitMs: 5000,
    requiredExtensionVersion: '1.4.2', attempt: 1, token: 'synthetic-token', ...overrides };
}
const record = (sku, path = CLOTHING) => ({ sku, title: `Synthetic ${sku}`, categoryInfo: { cnTitlePath: path } });

test('only the exact claimed job shape is accepted', () => {
  assert.equal(validateSeerfarWebRequest({ payload: payload(), manifestVersion: '1.4.2' }).ok, true);
  for (const [bad, code] of [[payload({ pageUrl: 'https://www.seerfar.cn/admin/other' }), 'source_url_invalid'],
    [payload({ endpoint: 'https://api.seerfar.cn/open-api/quota' }), 'source_url_invalid'], [payload({ attempt: 2 }), 'attempt_invalid'],
    [payload({ waitMs: 10 * 60 * 1000 }), 'request_payload_missing'], [payload({ sourceUrl: 'https://detail.1688.com/offer/1.html' }), 'capture_mode_invalid'],
    [payload({ categoryPaths: [] }), 'request_payload_missing']]) {
    assert.equal(validateSeerfarWebRequest({ payload: bad, manifestVersion: '1.4.2' }).code, code);
  }
  assert.equal(validateSeerfarWebRequest({ payload: payload(), manifestVersion: '1.3.0' }).code, 'extension_version_mismatch');
});

test('addresses are sorted into the search page, a login page or somewhere else', () => {
  assert.equal(classifySeerfarAddress('https://www.seerfar.cn/admin/product-search'), 'search_page');
  assert.equal(classifySeerfarAddress('https://www.seerfar.cn/admin/product-search/?tab=1'), 'search_page');
  assert.equal(classifySeerfarAddress('https://www.seerfar.cn/login?redirect=x'), 'login');
  assert.equal(classifySeerfarAddress('https://www.seerfar.cn/admin/shop-search'), 'other');
  assert.equal(classifySeerfarAddress('https://evil.example/admin/product-search'), 'other');
});

test('the in-page hook keeps only search responses and waits for the declared category', async () => {
  const responses = [];
  const fakeFetch = async (url, init) => {
    const body = responses.shift();
    return { status: 200, clone: () => ({ text: async () => JSON.stringify(body) }) };
  };
  globalThis.window = { fetch: fakeFetch };
  // The page's own request, as the page would send it through the wrapped function.
  const pageRequest = (url, init) => Reflect.apply(window.fetch, window, [url, init]);
  globalThis.location = { href: 'https://www.seerfar.cn/admin/product-search' };
  globalThis.document = { body: { innerText: '筛选结果 共 812 条记录' } };
  try {
    assert.equal(readSeerfarSearchCapturesInPage([CLOTHING], 20).status, 'hook_missing');
    installSeerfarSearchHookInPage('/product-report/product/search');
    assert.equal(installSeerfarSearchHookInPage('/product-report/product/search').already, true);
    responses.push({ data: { list: [record(1)] } });
    await pageRequest('https://www.seerfar.cn/other/api', {});            // not the search endpoint: ignored
    responses.push({ code: 0, data: { total: 5, list: [record(2, '宠物用品 > 别的')] } });
    await pageRequest('/product-report/product/search', { body: '{"categoryIds":["x"],"token":"t"}' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(readSeerfarSearchCapturesInPage([CLOTHING], 20).status, 'waiting');
    responses.push({ code: 0, data: { total: 812, list: [record(3), record(4)] } });
    await pageRequest('/product-report/product/search', { body: '{"categoryIds":["1_2_3"],"pageNum":1}' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const found = readSeerfarSearchCapturesInPage([CLOTHING], 1);
    assert.equal(found.status, 'captured');
    assert.deepEqual(found.records.map(item => item.sku), [3]);
    assert.equal(found.resultCountLabel, '共812条记录');
    assert.deepEqual(found.requestBody, { categoryIds: ['1_2_3'], pageNum: 1 });
  } finally {
    delete globalThis.window; delete globalThis.location; delete globalThis.document;
  }
});

function fakeChrome(addresses, reads) {
  const calls = { created: [], scripts: [] };
  let tabUrl;
  return { calls, api: {
    tabs: {
      create: async ({ url, active }) => { calls.created.push({ url, active }); tabUrl = addresses.shift() ?? url; return { id: 7 }; },
      get: async () => { const url = addresses.length ? addresses.shift() : tabUrl; tabUrl = url; return { id: 7, url, status: 'complete' }; }
    },
    scripting: { executeScript: async ({ func, world }) => {
      calls.scripts.push([func.name, world]);
      if (func.name === 'installSeerfarSearchHookInPage') return [{ result: { installed: true } }];
      return [{ result: reads.shift() ?? { status: 'waiting' } }];
    } }
  } };
}

test('a job opens the search page visibly, waits for the owner search and returns one page', async () => {
  const records = [record(9)];
  const { api, calls } = fakeChrome([], [{ status: 'waiting' }, { status: 'captured', records, requestBody: { pageNum: 1 }, capturedAt: '2026-10-10T03:00:00.000Z', resultCountLabel: '共812条记录' }]);
  const result = await runSeerfarWebCapture({ chromeApi: api, payload: payload(), sleep: async () => {}, clock: () => '2026-10-10T03:00:01.000Z' });
  assert.deepEqual(calls.created, [{ url: SEERFAR_WEB_SEARCH_PAGE, active: true }]);
  assert.ok(calls.scripts.every(([, world]) => world === 'MAIN'));
  assert.equal(result.status, 'captured');
  assert.deepEqual(result.capture, { pageUrl: SEERFAR_WEB_SEARCH_PAGE, endpoint: SEERFAR_WEB_SEARCH_ENDPOINT, httpStatus: 200,
    capturedAt: '2026-10-10T03:00:00.000Z', resultCountLabel: '共812条记录', records });
  assert.deepEqual(result.requestTemplate, { pageNum: 1 });
  assert.deepEqual(result.accountIdentity, { accountId: null, phone: null, email: null });
});

test('the postback carries the search conditions and the three account fields, never the rest of the page request', async () => {
  // Synthetic values throughout.
  const requestBody = { categoryIds: ['1_2_3'], sellerType: 1, page: { pageNumber: 1, pageSize: 20 }, memberId: 80012345,
    phone: '13812345678', email: 'owner.test@qq.com', token: 'synthetic-session-token', sig: 'synthetic-signature', nonce: 'n-1', timestamp: 1760000000000,
    params: ['sid-7f3a'] };
  const { api } = fakeChrome([], [{ status: 'captured', records: [record(9)], requestBody, capturedAt: '2026-10-10T03:00:00.000Z', resultCountLabel: '共812条记录' }]);
  const result = await runSeerfarWebCapture({ chromeApi: api, payload: payload(), sleep: async () => {}, clock: () => '2026-10-10T03:00:01.000Z' });
  assert.deepEqual(result.requestTemplate, { categoryIds: ['1_2_3'], sellerType: 1, page: { pageNumber: 1, pageSize: 20 }, params: [null] });
  assert.deepEqual(result.accountIdentity, { accountId: '80012345', phone: '13812345678', email: 'owner.test@qq.com' });
  const sent = JSON.stringify(result);
  for (const secret of ['synthetic-session-token', 'synthetic-signature', 'n-1', '1760000000000', 'sid-7f3a']) assert.equal(sent.includes(secret), false, secret);
});

test('the extension filters are the same as the server ones, case by case', () => {
  const bodies = [null, 'pageNum=1', ['pageNum', 1], {}, { pageNum: 1 },
    buildSeerfarCategoryPayload({ platform: 'ozon', categoryId: '17027494_17028712_93366', fulfillment: 'CROSS_BORDER', filters: { priceRub: { min: 800, max: null } } }),
    { categoryIds: ['1_2_3'], memberId: 80012345, shopId: 2, nonce: 'n', sig: 'abc', jwt: 'x', accountId: 'acc-9', phone: '138 1234 5678', email: ' A@QQ.com ',
      user: 'fallback', data: { userPhone: '+7 (912) 345-67-89', contact: { mail: 'x@y.ru' } }, token: { accountId: 'hidden' } },
    { keyword: 'owner@qq.com', brandName: ['https://a.example/x', 'token=abc', 'Bearer abcdef', 'Nike'], tag: '13812345678', sort: 'eyJhbGciOiJIUzI1NiJ9.e30',
      label: 'a1b2c3d4e5f6a7b8c9d0e1f2a3', priceMin: 13812345678, salesMax: 120, isNew: true, 'bad key': 1, Ticket: 't', x: 'x'.repeat(200) },
    { filters: { sessionId: 'x', price: { min: 1, max: 2 }, deep: { a: { b: { c: { d: { e: 1 } } } } } }, orders: [{ field: 'revenue', direction: 'DESC' }],
      dateRange: '2026-09-01~2026-10-01', updateTime: 1760000000000, headers: { Authorization: 'Bearer abc' }, credential: 'c', birthday: '2000-01-01' },
    { a: { b: { c: { d: { e: { phone: '13812345678' } } } } }, userId: 'eyJhbGciOiJIUzI1NiJ9.e30.sig', uid: -3, mobile: 'call me' },
    { params: ['sid-abc123', { categoryId: 17027494, user: 'u-1' }], data: 'sess-9f8e7d', query: 'dog coat', options: [true, 7],
      filters: [['price', 'gte', 100], { priceMin: 100 }], sort: ['sales', 'desc'], categoryIds: [['1_2', '1_2_3'], '4'] }];
  for (const body of bodies) {
    assert.deepEqual(extensionTemplate(body), sanitizeSeerfarRequestTemplate(body), JSON.stringify(body));
    assert.deepEqual(extensionIdentity(body), pickSeerfarAccountIdentity(body), JSON.stringify(body));
  }
});

test('a login page or another page ends the job with its reason, and waiting has a limit', async () => {
  let chrome = fakeChrome([SEERFAR_WEB_SEARCH_PAGE, 'https://www.seerfar.cn/login'], []);
  await assert.rejects(runSeerfarWebCapture({ chromeApi: chrome.api, payload: payload(), sleep: async () => {} }), error => error.code === 'site_login_required');
  chrome = fakeChrome([SEERFAR_WEB_SEARCH_PAGE, 'https://www.example.com/'], []);
  await assert.rejects(runSeerfarWebCapture({ chromeApi: chrome.api, payload: payload(), sleep: async () => {} }), error => error.code === 'navigation_rejected');
  chrome = fakeChrome([], []);
  await assert.rejects(runSeerfarWebCapture({ chromeApi: chrome.api, payload: payload({ waitMs: 1000 }), sleep: ms => new Promise(resolve => setTimeout(resolve, 300)) }),
    error => error.code === 'no_matching_search');
});

test('the manifest can reach the Seerfar member site and nothing new beyond it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/1688-capture/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '1.4.2');
  assert.ok(manifest.host_permissions.includes('https://www.seerfar.cn/*'));
  assert.equal(manifest.host_permissions.some(value => value.includes('api.seerfar.cn')), false);
  assert.deepEqual(manifest.permissions, ['alarms', 'scripting']);
});
