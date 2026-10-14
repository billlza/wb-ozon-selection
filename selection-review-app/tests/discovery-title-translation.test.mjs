import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryTitleTranslator, DiscoveryTitleTranslationError, buildDiscoveryTitleTranslationRequest,
  DISCOVERY_TITLE_TRANSLATION_MODEL } from '../lib/discovery-title-translation.mjs';
import { createADiscoveryTitleTranslationUseCase, readDiscoveryTitleTranslations, attachDiscoveryTitleTranslations } from '../lib/discovery-title-translation-store.mjs';
import { createADiscoveryRuntimeFixture } from './fixtures/a-discovery-runtime-fixture.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';

// Everything below is synthetic: fake gateway responses, synthetic products, no network.
const GATEWAY = 'http://127.0.0.1:4318';
const items = [{ productId: '101', title: 'Лежанка для кошек' }, { productId: '102', title: 'Домик для собак 50x40' }];
const zh = { 101: '猫躺床', 102: '狗屋 50x40' };
function fakeGateway({ output = () => items.map(item => ({ productId: item.productId, titleZh: zh[item.productId] })), postStatus = 200, pollsBeforeDone = 1,
  usage = { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }, model = DISCOVERY_TITLE_TRANSLATION_MODEL, taskType = 'discovery_title_translation', neverFinish = false } = {}) {
  const calls = []; let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if ((init.method ?? 'GET') === 'POST') return new Response(JSON.stringify({ jobId: 'job:synthetic-1', status: 'queued', model, taskType }), { status: postStatus, headers: { 'content-type': 'application/json' } });
    polls += 1;
    if (neverFinish || polls < pollsBeforeDone) return new Response(JSON.stringify({ jobId: 'job:synthetic-1', status: 'running', model, taskType }), { status: 200 });
    return new Response(JSON.stringify({ jobId: 'job:synthetic-1', status: 'completed', model, taskType, receipt: { output: output(), usage, completedAt: '2026-09-10T08:00:00.000Z' } }), { status: 200 });
  };
  return { fetchImpl, calls };
}
const translator = (gateway, overrides = {}) => createDiscoveryTitleTranslator({ gatewayUrl: GATEWAY, fetchImpl: gateway.fetchImpl, now: () => '2026-09-10T08:00:00.000Z', wait: async () => {}, ...overrides });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof DiscoveryTitleTranslationError && error.code === code);

test('one inference job carries all titles and the strict JSON answer maps back in request order', async () => {
  const gateway = fakeGateway({ pollsBeforeDone: 2 });
  const result = await translator(gateway).translateTitles({ items });
  assert.deepEqual(result.translations, [{ productId: '101', titleZh: '猫躺床' }, { productId: '102', titleZh: '狗屋 50x40' }]);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 60, totalTokens: 180 });
  assert.equal(result.model, DISCOVERY_TITLE_TRANSLATION_MODEL); assert.equal(result.jobId, 'job:synthetic-1');
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1);
  const request = gateway.calls[0].body;
  assert.equal(request.taskType, 'discovery_title_translation'); assert.equal(request.model, DISCOVERY_TITLE_TRANSLATION_MODEL);
  assert.match(request.input.text, /只输出一个严格的JSON数组/); assert.equal(request.outputSchema.maxItems, 20);
  assert.deepEqual(buildDiscoveryTitleTranslationRequest(items).outputSchema.items.required, ['productId', 'titleZh']);
});

test('gateway and output faults stop with one closed code and never invent a title', async () => {
  await rejectsCode(translator(fakeGateway({ output: () => [{ productId: '101', titleZh: '猫躺床' }] })).translateTitles({ items }), 'OUTPUT_INVALID');
  await rejectsCode(translator(fakeGateway({ output: () => 'not json at all' })).translateTitles({ items }), 'OUTPUT_INVALID');
  await rejectsCode(translator(fakeGateway({ output: () => items.map(item => ({ productId: item.productId, titleZh: '' })) })).translateTitles({ items }), 'OUTPUT_INVALID');
  await rejectsCode(translator(fakeGateway({ output: () => items.map(item => ({ productId: item.productId, titleZh: 'x', extra: 1 })) })).translateTitles({ items }), 'OUTPUT_INVALID');
  await rejectsCode(translator(fakeGateway({ postStatus: 500 })).translateTitles({ items }), 'GATEWAY_FAILED');
  await rejectsCode(translator(fakeGateway({ model: 'gpt-other' })).translateTitles({ items }), 'GATEWAY_FAILED');
  await rejectsCode(translator(fakeGateway()).translateTitles({ items: Array.from({ length: 21 }, (_, i) => ({ productId: String(1000 + i), title: 'Товар' })) }), 'INPUT_INVALID');
  await rejectsCode(translator(fakeGateway()).translateTitles({ items: [] }), 'INPUT_INVALID');
  await rejectsCode(translator(fakeGateway()).translateTitles({ items: [{ productId: '1', title: 'a', more: true }] }), 'INPUT_INVALID');
  let tick = 0;
  await rejectsCode(translator(fakeGateway({ neverFinish: true }), { now: () => { tick += 600; return tick; }, timeoutMs: 1000, maxStatusReads: 50 }).translateTitles({ items }), 'TIMEOUT');
  assert.throws(() => createDiscoveryTitleTranslator({ gatewayUrl: 'ftp://x', fetchImpl: async () => new Response('{}') }), error => error.code === 'INPUT_INVALID');
});

async function completedBatch(products) {
  const f = createADiscoveryRuntimeFixture();
  const fetchImpl = async url => url.endsWith('/dld/productSearch') ? f.fetchImpl(url) :
    new Response(JSON.stringify({ code: '200', errcode: 200, total: products.length, products }));
  const { service } = f.create({ fetchImpl, onBatchReady: async () => ({ status: 'awaiting_test_import' }) });
  const created = await f.prepare(service);
  await f.authorize(service, created); await service.runDue(); await service.runDue(); await service.stop();
  const document = await f.repository.readSnapshot();
  const batch = document.runtime.aDiscoveryBatches[created.batch.batchId];
  const actor = createActorContext({ authenticatedAt: f.clock(), userId: batch.ownerUserId, sessionId: 'session:translation-test', actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider' });
  return { ...f, created, document, batch, actor, input: { batchId: batch.batchId, expectedRevision: batch.revision } };
}
const market = (id, title) => ({ sku: id, productUrl: `https://www.ozon.ru/product/${id}`, title, price: 297, currency: '₽' });

test('the use case translates only uncached market titles, persists records atomically and never touches receipts', async () => {
  const f = await completedBatch([market(2107989735, 'Органайзер для хранения'), market(2107989736, 'Коробка для обуви')]);
  let calls = 0;
  const fake = { maxTitlesPerCall: 20, async translateTitles({ items }) { calls += 1; return { translations: items.map(item => ({ productId: item.productId, titleZh: `中文 ${item.productId}` })),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, model: DISCOVERY_TITLE_TRANSLATION_MODEL, jobId: 'job:synthetic-2', completedAt: f.clock() }; } };
  const usecase = createADiscoveryTitleTranslationUseCase({ repository: f.repository, serverClock: f.clock, translator: fake });
  const first = await usecase.translateBatch({ actor: f.actor, input: f.input });
  assert.deepEqual(first, { translated: 2, cached: 0, remaining: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, model: DISCOVERY_TITLE_TRANSLATION_MODEL });
  const saved = await f.repository.readSnapshot();
  const records = readDiscoveryTitleTranslations(saved);
  assert.deepEqual(Object.keys(records).sort(), ['2107989735', '2107989736']);
  assert.equal(records['2107989735'].titleZh, '中文 2107989735'); assert.equal(records['2107989735'].sourceTitle, 'Органайзер для хранения');
  assert.equal(JSON.stringify(saved.runtime.aDiscoveryReceipts), JSON.stringify(f.document.runtime.aDiscoveryReceipts));
  const second = await usecase.translateBatch({ actor: f.actor, input: f.input });
  assert.deepEqual(second, { translated: 0, cached: 2, remaining: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: null });
  assert.equal(calls, 1);
  const receipt = structuredClone(Object.values(saved.runtime.aDiscoveryReceipts)[0]);
  attachDiscoveryTitleTranslations(receipt, records);
  const products = receipt.steps[0].result.products;
  assert.equal(products[0].titleZh, '中文 2107989735');
  const stale = structuredClone(receipt); stale.steps[0].result.products[0].title = 'Другой заголовок'; delete stale.steps[0].result.products[0].titleZh;
  attachDiscoveryTitleTranslations(stale, records); assert.equal(stale.steps[0].result.products[0].titleZh, undefined);
  await assert.rejects(usecase.translateBatch({ actor: f.actor, input: { ...f.input, extra: 1 } }), error => error.code === 'INPUT_INVALID');
  await assert.rejects(usecase.translateBatch({ actor: f.actor, input: { ...f.input, expectedRevision: 9 } }), error => error.code === 'BATCH_CHANGED');
  const stranger = createActorContext({ authenticatedAt: f.clock(), userId: 'user:someone-else', sessionId: 'session:other', actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider' });
  await assert.rejects(usecase.translateBatch({ actor: stranger, input: f.input }), error => error.code === 'OWNER_CONFLICT');
});

test('a translator failure persists nothing', async () => {
  const f = await completedBatch([market(2107989737, 'Полка настенная')]);
  const failing = { maxTitlesPerCall: 20, async translateTitles() { throw new DiscoveryTitleTranslationError('GATEWAY_FAILED', 'synthetic outage'); } };
  const usecase = createADiscoveryTitleTranslationUseCase({ repository: f.repository, serverClock: f.clock, translator: failing });
  const before = JSON.stringify(await f.repository.readSnapshot());
  await assert.rejects(usecase.translateBatch({ actor: f.actor, input: f.input }), error => error.code === 'GATEWAY_FAILED');
  assert.equal(JSON.stringify(await f.repository.readSnapshot()), before);
  assert.deepEqual(readDiscoveryTitleTranslations(await f.repository.readSnapshot()), {});
});
