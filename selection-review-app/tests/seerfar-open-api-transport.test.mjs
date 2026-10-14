import assert from "node:assert/strict";
import test from "node:test";

import { createSeerfarKeywordProviderAdapter } from "../lib/keyword-evidence-provider-adapter.mjs";
import { prepareKeywordEvidence } from "../lib/keyword-evidence-orchestrator.mjs";
import { SeerfarTransportError, buildSeerfarCategoryPayload, buildSeerfarProductPayload, buildSeerfarReversePayload, createSeerfarOpenApiTransport, SEERFAR_OPEN_API_BASE } from "../lib/seerfar-open-api-transport.mjs";
import { verifySeerfarMarketEntryReplay } from './fixtures/seerfar-market-entry-replay.mjs';

const NOW = "2026-08-24T06:00:00.000Z";
function response(step, records = null, extras = {}) {
  const data = step.startsWith("quota") ? { creditLimit: 100, creditUsed: step === "quota_before" ? 20 : 35 } : { records: records ?? [{ query: "mechanical music box" }] };
  return { status: 200, json: { code: 200, data }, requestId: `request:${step}`, completedAt: NOW, ...extras };
}
function plan(overrides = {}) { return { operation: "reverse_keywords", platform: "ozon", skuIds: ["123", "456"], factRefs: ["fact:mechanism"], competitorRefs: ["competitor:123", "competitor:456"], matchType: "exact_match", attemptId: "attempt:seerfar:1", queryId: "query:seerfar:1", startedAt: NOW, receiptId: "receipt:seerfar:1", ...overrides }; }
function request(overrides = {}) { return { queryText: "SKU-TARGET", locale: "ru-RU", targetPlatform: "ozon", exactSku: "SKU-TARGET", fulfillment: "rfbs", identity: { candidateId: "CX-NON-TRAIN-SEERFAR", dataRevision: 2 }, seerfarRequest: plan(), attemptLimit: 1, ...overrides }; }

test("只允许固定HTTPS域名和七个端点族，不接受任意URL、平台或操作", async () => {
  const urls = [];
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake-test-key", httpTransport: async (req) => { urls.push(req.url); return response(req.step); }, clock: { now: () => 0 }, sleep: async () => {} });
  await transport(request());
  assert.deepEqual(urls, [`${SEERFAR_OPEN_API_BASE}/open-api/quota`, `${SEERFAR_OPEN_API_BASE}/open-api/keyword/backSearch/ozon`, `${SEERFAR_OPEN_API_BASE}/open-api/quota`]);
  const invalid = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", httpTransport: async () => { throw new Error("不得调用"); } });
  await assert.rejects(() => invalid(request({ targetPlatform: "evil", seerfarRequest: plan({ platform: "evil" }) })), /REQUEST_PLAN_INVALID|ENDPOINT_NOT_ALLOWED/);
  await assert.rejects(() => createSeerfarOpenApiTransport({ secretProvider: async () => "fake", httpTransport: async () => response("quota_before") })(request({ seerfarRequest: plan({ operation: "arbitrary_url", url: "https://evil.test" }) })), /REQUEST_PLAN_INVALID/);
});

test("Skill已验证的product/category/reverse payload保持边界且Ozon普通类目ID拒绝", () => {
  assert.deepEqual(buildSeerfarProductPayload({ platform: "ozon", sku: "123", dateRange: "past_30_days" }), { sku: "123", dateRange: "past_30_days" });
  assert.deepEqual(buildSeerfarProductPayload({ platform: "wb", sku: "123", dateRange: "past_30_days" }), { sku: "123", dateRange: "past_30_days", includeFbs: true });
  assert.throws(() => buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17028712", fulfillment: "rfbs" }), /NOT_COMPOSITE/);
  assert.doesNotThrow(() => buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17027494_17028712", fulfillment: "rfbs" }));
  const category = buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17027494_17028712_93366", fulfillment: "rfbs" });
  assert.throws(() => buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17027494_bad", fulfillment: "rfbs" }), /NOT_COMPOSITE/);
  assert.deepEqual(category.page, { pageNumber: 1, pageSize: 20, orders: [{ field: "revenue", direction: "DESC" }] });
  const reverse = buildSeerfarReversePayload({ skuIds: ["123", "ABC"] });
  assert.deepEqual(reverse.skuIds, [123, "ABC"]);
  assert.equal(reverse.page.pageSize, "100");
});

test("配额前后、请求号、端点类别、点数、数据时间和脱敏引用进入回执", async () => {
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake-test-key", httpTransport: async (req) => response(req.step), clock: { now: () => 0 }, sleep: async () => {} });
  const receipt = await transport(request());
  assert.deepEqual([receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent], [80, 65, 15]);
  assert.deepEqual(receipt.evidence.requestIds, ["request:quota_before", "request:reverse_keywords", "request:quota_after"]);
  assert.equal(receipt.evidence.endpointCategory, "reverse_keywords");
  assert.equal(receipt.evidence.dataObservedAt, NOW);
  assert.match(receipt.evidence.evidenceRef, /^seerfar:reverse_keywords:[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(receipt).includes("fake-test-key"), false);
});

test("每个步骤一次且以注入clock/sleep执行3秒限频，无真实等待和自动重试", async () => {
  let now = 0; const waits = []; const steps = [];
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => now }, sleep: async (ms) => { waits.push(ms); now += ms; }, httpTransport: async (req) => { steps.push([req.step, req.attempt, req.redirect]); return response(req.step); } });
  await transport(request());
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(steps, [["quota_before", 1, "error"], ["reverse_keywords", 1, "error"], ["quota_after", 1, "error"]]);
  await assert.rejects(() => transport(request()), /ATTEMPT_LIMIT_EXCEEDED/);
});

test("HTTP、超时、配额、登录、stale和schema失败保持精确技术语义且不重试", async () => {
  const cases = [
    [401, null, "login_required"], [429, null, "quota_or_rate_limit"], [500, null, "provider_server_error"],
    [null, { code: "network_timeout" }, "network_timeout"], [null, { code: "network_error" }, "network_error"], [null, { code: "stale_result" }, "stale_result"], [null, { failureKind: "schema_error" }, "schema_error"]
  ];
  for (const [status, thrown, expected] of cases) {
    let targetCalls = 0;
    const openApiTransport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => {
      if (req.step === "quota_before") return response(req.step);
      targetCalls += 1;
      if (thrown) throw new SeerfarTransportError(thrown.code ?? thrown.failureKind);
      return response(req.step, null, { status });
    }});
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport });
    if(expected === "schema_error") await assert.rejects(()=>adapter.providers.seerfarApi({input:input(),attemptLimit:1}),error=>error instanceof SeerfarTransportError && error.code === "schema_error");
    else { const receipt = await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 });
    assert.equal(receipt.attempt.failureClass, expected); }
    assert.equal(targetCalls, 1);
  }
});

test("失败回执保留脱敏步骤，正式查询或额度后检失败可判定结果未知", async () => {
  for (const [failedStep, expectedStage] of [["reverse_keywords", "target_request"], ["quota_after", "quota_after"]]) {
    const transport = createSeerfarOpenApiTransport({
      secretProvider: async () => "fake",
      clock: { now: () => 0 },
      sleep: async () => {},
      httpTransport: async (req) => {
        if (req.step === failedStep) throw new SeerfarTransportError("network_error");
        return response(req.step);
      }
    });
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: transport });
    const receipt = await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 });
    assert.equal(receipt.attempt.failureClass, "network_error");
    assert.equal(receipt.attempt.failureStage, expectedStage);
    assert.equal(JSON.stringify(receipt).includes("fake"), false);
  }
});

test("true_empty仅来自明确完成且records严格为空，缺records属于schema失败", async () => {
  const empty = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => response(req.step, req.step === "reverse_keywords" ? [] : null) });
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: empty });
  assert.equal((await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 })).attempt.failureClass, "true_empty");
  const missing = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => req.step === "reverse_keywords" ? { ...response(req.step), json: { code: 200, data: {} } } : response(req.step) });
  const missingAdapter = createSeerfarKeywordProviderAdapter({ openApiTransport: missing });
  await assert.rejects(()=>missingAdapter.providers.seerfarApi({input:input(),attemptLimit:1}),error=>error instanceof SeerfarTransportError && error.code === "schema_error");
});

test("假密钥仅进入注入HTTP头，供应商未知配额保留null且秘密响应拒绝", async () => {
  let seenHeader = null;
  const unknown = createSeerfarOpenApiTransport({ secretProvider: async () => "fake-only", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => { seenHeader = req.headers.Authorization; const r = response(req.step); if (req.step.startsWith("quota")) r.json.data = {}; return r; } });
  const receipt = await unknown(request());
  assert.equal(seenHeader, "Bearer fake-only");
  assert.deepEqual([receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent], [null, null, null]);
  assert.equal(JSON.stringify(receipt).includes("fake-only"), false);
  const unsafe = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => req.step === "reverse_keywords" ? { ...response(req.step), json: { code: 200, data: { records: [], access_token: "leak" } } } : response(req.step) });
  const unsafeAdapter = createSeerfarKeywordProviderAdapter({ openApiTransport: unsafe });
  await assert.rejects(()=>unsafeAdapter.providers.seerfarApi({input:input(),attemptLimit:1}),error=>error instanceof SeerfarTransportError && error.code === "schema_error");
});

function input() {
  return { identity: { candidateId: "CX-NON-TRAIN-SEERFAR", parentOpportunityId: "op:1", skuPackageId: "sku:1", dataRevision: 2 }, bindings: { salesSnapshot: { snapshotId: "sales:2", version: "sales-v1", fingerprint: "sales-fp" }, supplySkuFacts: { version: "supply-v1", fingerprint: "supply-fp" } },
    platform: "ozon", exactSku: "SKU-TARGET", fulfillment: "rfbs", locale: "ru-RU", seerfarRequest: plan(), businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:2" }, now: NOW,
    policy: { browserAllowed: false, browserPreauthorized: false }, healthPolicy: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", ttlMs: 3600000, suspectedSystemicFailure: false, standardSkus: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], lastProof: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", provedAt: NOW } },
    frozenEvidence: { productFactTerms: [{ term: "hand crank", sourceRefs: ["supply:2"], factRefs: ["fact:mechanism"], sourceTrust: "owner" }], comparables: [], seedEvidence: [] }, reusableSnapshot: null };
}

test("普通非火车SKU可与provider adapter和K2联跑且保持零业务副作用", async () => {
  const openApiTransport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => response(req.step) });
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport });
  const orchestratorInput = input();
  orchestratorInput.policy = { browserAllowed: true, browserPreauthorized: true };
  const prepared = await prepareKeywordEvidence(orchestratorInput, adapter.providers);
  assert.equal(prepared.result, "source_candidates_ready");
  assert.deepEqual(prepared.businessEffect, { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 });
  assert.deepEqual([prepared.execution.seerfarApiCalls, prepared.execution.browserCalls, prepared.execution.automaticRetries], [1, 0, 0]);
});

test("密钥缺失是typed零请求错误，未知secret异常不冒登录失败",async()=>{
 const unknown=new Error('synthetic internal defect');
 for(const missing of [true,false]) {
  let calls=0;const transport=createSeerfarOpenApiTransport({secretProvider:async()=>{if(missing)return '';throw unknown;},httpTransport:async()=>{calls++;}});
  const adapter=createSeerfarKeywordProviderAdapter({openApiTransport:transport});
  await assert.rejects(()=>adapter.providers.seerfarApi({input:input(),attemptLimit:1}),error=>missing?error instanceof SeerfarTransportError&&error.code==='credential_missing':error===unknown);
  assert.equal(calls,0);
 }
});
test('密钥不可用不触发另一浏览器路径或伪零结果',async()=>{
 let browserCalls=0;
 const adapter=createSeerfarKeywordProviderAdapter({openApiTransport:createSeerfarOpenApiTransport({secretProvider:async()=>'',httpTransport:async()=>assert.fail('no HTTP')}),browserTransport:async()=>{browserCalls++;}});
 const i=input();i.policy={browserAllowed:true,browserPreauthorized:true};
 await assert.rejects(()=>prepareKeywordEvidence(i,adapter.providers),error=>error instanceof SeerfarTransportError&&error.code==='credential_missing');
 assert.equal(browserCalls,0);
});

test('非空损坏记录不能过滤成true_empty；未知错误不能冒供应商故障',async()=>{
 for(const rows of [[null],[{}],[{query:'  '}]]) {
  const transport=createSeerfarOpenApiTransport({secretProvider:async()=>'fake',sleep:async()=>{},httpTransport:async req=>response(req.step,rows)});
  await assert.rejects(()=>transport(request()),e=>e instanceof SeerfarTransportError&&e.code==='schema_error');
 }
 for(const stage of ['secret','http']) {
  const failure=new TypeError('synthetic unknown defect');
  const transport=createSeerfarOpenApiTransport({secretProvider:async()=>{if(stage==='secret')throw failure;return 'fake';},httpTransport:async()=>{throw failure;}});
  await assert.rejects(()=>transport(request()),e=>e===failure);
 }
});

function categoryData(platform = 'ozon', count = 20) {
  return { id: '100_200', hasNextPage: true, products: 300, productList: Array.from({ length: count }, (_, index) => {
    const sku = 7000000001 + index;
    return { sku, title: `Synthetic product ${index}`, imageUrl: `https://images.example.test/${sku}.jpg`,
      productUrl: platform === 'ozon' ? `https://www.ozon.ru/product/${sku}` : `https://www.wildberries.ru/catalog/${sku}/detail.aspx`,
      price: 50.25 + index, sales: index, revenue: 50.25 * index,
      categoryInfo: { fullCategoryId: ['100', '200'], titlePath: 'Дом / Хранение', cnTitlePath: '家居 / 收纳', enTitlePath: 'Home / Storage',
        category: { id: '200', pid: '100', title: 'Хранение', cnTitle: '收纳', enTitle: 'Storage', level: 2, disabled: false, crossBorderSellable: true, children: null } } };
  }) };
}
function categoryRequest(platform = 'ozon') {
  return request({ targetPlatform: platform, fulfillment: platform === 'ozon' ? 'rfbs' : 'FBS_OVERSEAS',
    seerfarRequest: plan({ operation: 'category_detail', platform, categoryId: '100_200' }) });
}
function categoryTransport(data, calls = []) {
  return createSeerfarOpenApiTransport({ secretProvider: async () => 'synthetic-category-key', sleep: async () => {},
    clock: { now: () => 0 }, httpTransport: async req => {
      calls.push(req.step);
      return req.step === 'category_detail' ? { ...response(req.step), json: { code: 200, data } } : response(req.step);
    } });
}

test('历史类目productList保留两平台20条商品、顺序和分页，不冒充关键词或已知币种', async () => {
  for (const platform of ['ozon', 'wb']) {
    const data = categoryData(platform), calls = [], receipt = await categoryTransport(data, calls)(categoryRequest(platform));
    assert.equal(receipt.observation.resultCount, 20); assert.equal(receipt.explicitEmpty, false);
    assert.deepEqual(receipt.candidates, []); assert.equal(receipt.marketProducts.length, 20);
    assert.deepEqual(receipt.collection, { pageNumber: 1, pageSize: 20, hasNextPage: true });
    for (const [index, product] of receipt.marketProducts.entries()) {
      const row = data.productList[index];
      assert.equal(product.productId, String(row.sku)); assert.equal(product.productUrl, row.productUrl);
      assert.equal(product.price, row.price); assert.equal(product.currency, null); assert.equal(product.sellerIdentity, 'unknown');
      assert.equal(product.title, row.title); assert.equal(product.imageUrl, row.imageUrl);
      assert.equal(product.salesCount, row.sales); assert.equal(product.revenue, row.revenue);
      assert.deepEqual(product.categoryPath.fullCategoryId, row.categoryInfo.fullCategoryId);
      assert.equal(Object.hasOwn(product.categoryPath, 'category'), false);
      assert.match(product.providerRecordRef, new RegExp(`#product-${index}$`));
    }
    assert.deepEqual(calls, ['quota_before', 'category_detail', 'quota_after']);
    assert.equal(JSON.stringify(receipt).includes('synthetic-category-key'), false);
  }
});

test('类目真实空数组与缺失、损坏、重复身份和超页记录严格区分，失败不再读额度', async () => {
  const empty = await categoryTransport({ id: '100_200', productList: [], hasNextPage: false })(categoryRequest());
  assert.equal(empty.explicitEmpty, true); assert.equal(empty.observation.resultCount, 0); assert.deepEqual(empty.marketProducts, []);
  const invalid = [
    data => { delete data.productList; }, data => { data.productList = null; },
    data => { data.records = data.productList; delete data.productList; },
    data => { data.productList.push({ ...data.productList[0], sku: 8000000000 }); },
    data => { data.productList[1] = data.productList[0]; },
    data => { data.hasNextPage = 'true'; }, data => { delete data.hasNextPage; },
    data => { data.productList = []; data.hasNextPage = true; },
    data => { data.productList[0] = null; },
    ...[Number.MAX_SAFE_INTEGER + 1, '7000000001', 0].map(value => data => { data.productList[0].sku = value; }),
    ...['https://www.ozon.ru/product/8000000000', 'https://evil.test/product/7000000001',
      'https://www.ozon.ru/product/7000000001?token=unsafe', 'invalid'].map(value => data => { data.productList[0].productUrl = value; }),
    ...[0, -1, '50', Infinity].map(value => data => { data.productList[0].price = value; }),
    data => { data.productList[0].sales = 0.5; }, data => { data.productList[0].revenue = -1; },
    data => { data.productList[0].title = ' '; }, data => { data.productList[0].imageUrl = 'javascript:unsafe'; },
    data => { data.productList[0].categoryInfo.fullCategoryId = []; },
    data => { data.productList[0].categoryInfo.titlePath = null; }
  ];
  for (const mutate of invalid) {
    const data = categoryData(), calls = []; mutate(data);
    await assert.rejects(categoryTransport(data, calls)(categoryRequest()), error => error instanceof SeerfarTransportError &&
      error.code === 'schema_error' && error.failureStage === 'target_request');
    assert.deepEqual(calls, ['quota_before', 'category_detail']);
  }
});

test('商品可选销量与类目缺失保持null；输入错误在密钥与额度之前拒绝', async () => {
  const data = categoryData(); delete data.productList[0].sales; delete data.productList[0].revenue; delete data.productList[0].categoryInfo;
  const receipt = await categoryTransport(data)(categoryRequest());
  assert.deepEqual([receipt.marketProducts[0].salesCount, receipt.marketProducts[0].revenue, receipt.marketProducts[0].categoryPath], [null, null, null]);
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => assert.fail('no secret access'), httpTransport: async () => assert.fail('no request') });
  const invalid = categoryRequest(); invalid.seerfarRequest.categoryId = '200';
  await assert.rejects(transport(invalid), /NOT_COMPOSITE/);
});

test('商品查询误入关键词适配器时在调用transport前拒绝', async () => {
  for (const operation of ['category_detail', 'product_detail']) {
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: async () => assert.fail('no transport call') });
    await assert.rejects(adapter.providers.seerfarApi({ input: { ...input(), seerfarRequest: plan({ operation }) }, attemptLimit: 1 }), /KEYWORD_PROVIDER_OPERATION_INVALID/);
  }
});

test('类目响应经当前解析和候选工厂隔离落盘、冷读与A卡投影，保持待核验而无正式作业', async () => {
  for (const platform of ['ozon', 'wb']) {
    const result = await verifySeerfarMarketEntryReplay({ body: { code: 200, data: categoryData(platform) }, platform, categoryId: '100_200',
      sourceReference: 'synthetic category response', historicalDate: '2026-07-27', targetStore: platform === 'ozon' ? 'miska' : 'wb' });
    assert.equal(result.rows, 20); assert.equal(result.currentExternalRequests, 0);
    assert.equal(result.productionDiscoveryImporterExercised, false);
  }
});

 test('category review facts retain raw seller code and literal response dates without market inference', async () => {
  for (const platform of ['ozon', 'wb']) {
    const data = categoryData(platform);
    Object.assign(data, { startDate: '2026-07-01', endDate: '2026-07-27' });
    Object.assign(data.productList[0], { reviewCount: 0, reviewRating: 7.25, sellerType: 1 });
    const result = await categoryTransport(data)(categoryRequest(platform));
    assert.deepEqual(result.dateRange, { startDate: data.startDate, endDate: data.endDate });
    assert.deepEqual([result.marketProducts[0].reviewCount, result.marketProducts[0].reviewRating, result.marketProducts[0].rawSellerType, result.marketProducts[0].sellerIdentity], [0, 7.25, 1, 'unknown']);
    assert.deepEqual([result.marketProducts[1].reviewCount, result.marketProducts[1].reviewRating, result.marketProducts[1].rawSellerType], [null, null, null]);
  }
  for (const [field, value] of [['reviewCount', -1], ['reviewCount', 1.5], ['reviewCount', Number.MAX_SAFE_INTEGER + 1], ['reviewRating', '4.8'], ['reviewRating', Infinity], ['sellerType', '1'], ['sellerType', -1]]) {
    const data = categoryData(), calls = []; data.productList[0][field] = value;
    await assert.rejects(categoryTransport(data, calls)(categoryRequest()), /schema_error/);
    assert.deepEqual(calls, ['quota_before', 'category_detail']);
  }
  for (const range of [{startDate:'2026-02-30'}, {startDate:'2026-07-28',endDate:'2026-07-27'}, {endDate:'past_30_days'}]) {
    await assert.rejects(categoryTransport({...categoryData(), ...range})(categoryRequest()), /schema_error/);
  }
});


test('category response identity must match even for empty results on either platform', async () => {
  for (const platform of ['ozon', 'wb']) for (const empty of [false, true]) {
    for (const id of [undefined, null, 200, [], '', '100_201']) {
      const data = categoryData(platform);
      if (id === undefined) delete data.id; else data.id = id;
      if (empty) { data.productList = []; data.hasNextPage = false; }
      const calls = [];
      await assert.rejects(categoryTransport(data, calls)(categoryRequest(platform)), error =>
        error instanceof SeerfarTransportError && error.code === 'schema_error' && error.failureStage === 'target_request');
      assert.deepEqual(calls, ['quota_before', 'category_detail']);
    }
  }
});

test('category rows keep the provider weight, volume and dimension text as v3 package facts and reject malformed ones', async () => {
  const data = categoryData('ozon', 2);
  Object.assign(data.productList[0], { weight: 850, volume: 12.4, dimension: '600x450x150' });
  Object.assign(data.productList[1], { weight: null, dimension: null });
  const result = await categoryTransport(data)(categoryRequest());
  assert.equal(result.marketProducts[0].weightGrams, 850); assert.equal(result.marketProducts[0].volumeLitres, 12.4);
  assert.equal(result.marketProducts[0].dimensionMm, '600x450x150');
  assert.equal(result.marketProducts[1].weightGrams, null); assert.equal(result.marketProducts[1].volumeLitres, null); assert.equal(result.marketProducts[1].dimensionMm, null);
  for (const bad of [{ dimension: 600 }, { dimension: '60x45' }, { weight: -5 }, { volume: '12' }]) {
    const broken = categoryData('ozon', 1); Object.assign(broken.productList[0], bad);
    await assert.rejects(categoryTransport(broken)(categoryRequest()), error => error.code === 'schema_error');
  }
});

const EMPTY_RANGE = { min: null, max: null };
// Provider units: price RUB, weight grams, volume litres, monthlySales units in the response date window.
const OWNER_FILTERS = { priceRub: { min: 800, max: null }, weightGrams: { min: null, max: 1000 },
  volumeLitres: { min: 0.5, max: 12.4 }, salesCount: { min: 30, max: null } };
function filteredCategoryRequest(filters, platform = 'ozon') {
  const built = categoryRequest(platform);
  built.seerfarRequest.filters = filters;
  return built;
}

test('owner filters fill only their own provider slot, in the provider unit, leaving every other slot empty', () => {
  for (const platform of ['ozon', 'wb']) {
    const fulfillment = platform === 'ozon' ? 'rfbs' : 'FBS_OVERSEAS';
    const none = buildSeerfarCategoryPayload({ platform, categoryId: '100_200', fulfillment });
    for (const slot of ['price', 'weight', 'volume', 'monthlySales', 'monthlyRevenue', 'monthlySalesRate',
      'reviewCount', 'reviewRating', 'questionsAndAnswers', 'grossMargin', 'variants']) assert.deepEqual(none[slot], EMPTY_RANGE, slot);
    const payload = buildSeerfarCategoryPayload({ platform, categoryId: '100_200', fulfillment, filters: OWNER_FILTERS });
    assert.deepEqual(payload.price, { min: 800, max: null });
    assert.deepEqual(payload.weight, { min: null, max: 1000 });
    assert.deepEqual(payload.volume, { min: 0.5, max: 12.4 });
    assert.deepEqual(payload.monthlySales, { min: 30, max: null });
    // Nothing else moved: same keys, same order, same values once the four declared slots are emptied again.
    assert.deepEqual(Object.keys(payload), Object.keys(none));
    assert.deepEqual({ ...payload, price: EMPTY_RANGE, weight: EMPTY_RANGE, volume: EMPTY_RANGE, monthlySales: EMPTY_RANGE }, none);
  }
  const single = buildSeerfarCategoryPayload({ platform: 'ozon', categoryId: '100_200', fulfillment: 'rfbs', filters: { salesCount: { min: 30, max: null } } });
  assert.deepEqual(single.monthlySales, { min: 30, max: null });
  assert.deepEqual([single.price, single.weight, single.volume, single.monthlyRevenue], Array(4).fill(EMPTY_RANGE));
  for (const invalid of [{}, [], { unknownFilter: { min: 1, max: null } }, { monthlySales: { min: 1, max: null } },
    { priceRub: { min: -1, max: null } }, { priceRub: { min: 900, max: 800 } }, { priceRub: { min: null, max: null } },
    { priceRub: { min: 800 } }, { priceRub: { min: 800, max: null, extra: 1 } }, { priceRub: { min: '800', max: null } },
    { priceRub: null }, { priceRub: { min: Infinity, max: null } }]) {
    assert.throws(() => buildSeerfarCategoryPayload({ platform: 'ozon', categoryId: '100_200', fulfillment: 'rfbs', filters: invalid }),
      /SEERFAR_CATEGORY_FILTERS_INVALID/, JSON.stringify(invalid));
  }
});

test('a filtered category run sends the declared ranges and echoes them back with the v3 market result', async () => {
  const bodies = [], steps = [];
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => 'synthetic-category-key', sleep: async () => {},
    clock: { now: () => 0 }, onStepResult: async step => { steps.push(step); },
    httpTransport: async req => { bodies.push(req.body);
      return req.step === 'category_detail' ? { ...response(req.step), json: { code: 200, data: categoryData('ozon', 2) } } : response(req.step); } });
  const receipt = await transport(filteredCategoryRequest(OWNER_FILTERS));
  assert.deepEqual(bodies[1].price, { min: 800, max: null });
  assert.deepEqual(bodies[1].weight, { min: null, max: 1000 });
  assert.deepEqual(bodies[1].volume, { min: 0.5, max: 12.4 });
  assert.deepEqual(bodies[1].monthlySales, { min: 30, max: null });
  assert.deepEqual(receipt.appliedFilters, OWNER_FILTERS);
  assert.equal(receipt.marketProducts.length, 2);
  const marketStep = steps.find(step => step.step === 'category_detail');
  assert.deepEqual(marketStep.appliedFilters, OWNER_FILTERS);
  assert.deepEqual(steps.filter(step => step.step !== 'category_detail').map(step => step.appliedFilters), [undefined, undefined]);

  for (const declared of [undefined, null]) {
    const plainBodies = [];
    const plain = createSeerfarOpenApiTransport({ secretProvider: async () => 'synthetic-category-key', sleep: async () => {},
      clock: { now: () => 0 }, httpTransport: async req => { plainBodies.push(req.body);
        return req.step === 'category_detail' ? { ...response(req.step), json: { code: 200, data: categoryData('ozon', 2) } } : response(req.step); } });
    const built = categoryRequest();
    if (declared === null) built.seerfarRequest.filters = null;
    const unfiltered = await plain(built);
    assert.equal(unfiltered.appliedFilters, null);
    for (const slot of ['price', 'weight', 'volume', 'monthlySales']) assert.deepEqual(plainBodies[1][slot], EMPTY_RANGE, slot);
  }

  const guard = createSeerfarOpenApiTransport({ secretProvider: async () => assert.fail('no secret access'),
    httpTransport: async () => assert.fail('no request') });
  await assert.rejects(guard(filteredCategoryRequest({ priceRub: { min: 900, max: 800 } })), /SEERFAR_CATEGORY_FILTERS_INVALID/);
});

test('real responses write the three sides with the multiplication sign; it is accepted and kept literal (2026-07-27 capture, 2026-09-11 RESPONSE_INVALID)', async () => {
  const data = categoryData('ozon');
  Object.assign(data.productList[0], { weight: 23400, volume: 162.685, dimension: '487×223×1498' });
  Object.assign(data.productList[1], { weight: 216, volume: 1.132, dimension: '149×146×52' });
  const result = await categoryTransport(data)(categoryRequest('ozon'));
  assert.equal(result.marketProducts[0].dimensionMm, '487×223×1498'); assert.equal(result.marketProducts[0].weightGrams, 23400);
  assert.equal(result.marketProducts[1].dimensionMm, '149×146×52');
  for (const bad of [{ dimension: '487×223' }, { dimension: '487*223*1498' }, { dimension: '487××223×1498' }]) {
    const broken = categoryData('ozon'); Object.assign(broken.productList[0], bad);
    await assert.rejects(() => categoryTransport(broken)(categoryRequest('ozon')), error => error instanceof SeerfarTransportError && error.code === 'schema_error');
  }
});
