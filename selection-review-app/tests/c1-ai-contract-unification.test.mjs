import test from 'node:test';
import { addSyntheticC1Review } from './fixtures/c1-seo-review-fixture.mjs';
import assert from 'node:assert/strict';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { buildRequest, receipt, nonTrainSkuPackage, authorizedExecution } from './fixtures/c1-ai-draft-fixture.mjs';
import { C1_AI_DRAFT_OUTPUT_CONTRACT_VERSION, validateC1AiDraftRequest, validateC1AiDraftReceipt,
  validateC1AiDraftOutput, resolveC1AiDraftOutputContract, assertC1ServiceTiming } from '../lib/c1-ai-draft-contract.mjs';
import { buildC1GatewayJob, runC1SavedDraftRequestThroughGateway, C1AiGatewayError } from '../lib/c1-ai-gateway.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './fixtures/c1-local-draft-source-fixture.mjs';
import { prepareC1LocalDraftSource } from '../lib/c1-local-draft-source.mjs';
import { prepareCurrentC1AiDraftRequest } from '../lib/c1-ai-draft-request-source.mjs';

// Deliberately hand-written expected output. It is independent of schema generation.
const item = text => ({ text, factRefs: ['platformCategory.categoryName'], keywordRefs: ['keyword:fixture:sink-organizer'],
  assertions: [{ factPath: 'platformCategory.categoryName', value: 'Органайзер для раковины' }] });
const fixedOutput = () => ({ status: 'draft_only', locale: 'ru-RU', claimCoverage: 'complete', unsupportedClaims: [],
  title: item('Органайзер для раковины'), description: item('Органайзер для кухонной раковины.'),
  bulletPoints: [item('Для организации пространства у раковины.')], searchKeywords: [item('органайзер для раковины')] });
function withOutput(request, output) { return receipt(request, { output, outputFingerprint: fingerprintCanonicalRecord(output) }); }
function reseal(request) {
  const core = structuredClone(request); delete core.requestId; delete core.requestFingerprint;
  request.requestFingerprint = fingerprintCanonicalRecord(core);
  request.requestId = `c1-ai-request:${request.identity.c1PlanId}:${request.requestFingerprint.slice(0, 16)}`;
  return request;
}

test('新请求冻结唯一版本/结构/说明，独立固定输出通过领域与发布schema', async () => {
  const request = buildRequest();
  assert.equal(request.outputContractVersion, C1_AI_DRAFT_OUTPUT_CONTRACT_VERSION);
  assert.equal(validateC1AiDraftRequest(request).valid, true);
  assert.equal(validateC1AiDraftOutput({ request, output: fixedOutput() }).valid, true);
  assert.equal(validateC1AiDraftReceipt({ request, receipt: withOutput(request, fixedOutput()) }).valid, true);
  const ajv = await loadPublishedSchemaValidator();
  assert.equal(ajv.validate('c1-ai-draft-request-v1', request), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.compile(request.outputContractSnapshot.outputSchema)(fixedOutput()), true);
  assert.match(request.outputContractSnapshot.instructions.join('\n'), /不是evidenceRefs/);
});

test('显式legacy重建保留原指纹和原验收；新旧混用不能通过', () => {
  const old = buildRequest({ outputContractVersion: null }), current = buildRequest();
  assert.equal(old.requestFingerprint, 'a52a49619671c4c68ba7aa12c3a3a163bb82fc676d7c17de83b882c1a9e65c34');
  assert.equal(Object.hasOwn(old, 'outputContractSnapshot'), false);
  assert.equal(validateC1AiDraftRequest(old).valid, true);
  assert.equal(validateC1AiDraftReceipt({ request: old, receipt: withOutput(old, fixedOutput()) }).valid, true);
  assert.notEqual(current.requestFingerprint, old.requestFingerprint);
  assert.equal(validateC1AiDraftReceipt({ request: current, receipt: withOutput(old, fixedOutput()) }).valid, false);
  // Legacy retains its historical factRefs/assertions correspondence behavior.
  const historical = fixedOutput(); historical.title.factRefs = ['productAttributes.material'];
  assert.equal(validateC1AiDraftReceipt({ request: old, receipt: withOutput(old, historical) }).valid, true);
  assert.equal(validateC1AiDraftReceipt({ request: current, receipt: withOutput(current, historical) }).valid, false);
});

test('缺版本/快照、未知版本、重新计算指纹的快照篡改均失败，无legacy fallback', () => {
  const mutations = [r => { delete r.outputContractVersion; }, r => { delete r.outputContractSnapshot; },
    r => { r.outputContractVersion = 'unrecognized'; }, r => { r.outputContractSnapshot.instructions = ['changed']; },
    r => { r.outputContractSnapshot.outputSchema.properties.title.properties.factRefs.items = { type: 'string' }; },
    r => { r.outputContractSnapshot.outputSchema.anyOf = [{}]; }];
  for (const change of mutations) {
    const request = structuredClone(buildRequest()); change(request); reseal(request);
    assert.equal(validateC1AiDraftRequest(request).valid, false);
    assert.throws(() => buildC1GatewayJob({ candidateId: request.sourceIdentity.candidateId, dataRevision: 12, request }), /C1_AI_GATEWAY_REQUEST_INVALID/);
  }
  assert.throws(() => buildRequest({ outputContractVersion: 'unrecognized' }), /C1_AI_OUTPUT_CONTRACT_VERSION_INVALID/);
});

test('事实路径枚举、完整assertion值、同项绑定与额外字段都严格验收', () => {
  const request = buildRequest();
  const mutations = [o => { o.title.factRefs = [request.verifiedFacts[0].evidenceRefs[0]]; },
    o => { o.title.assertions[0].value = 'invented'; }, o => { o.title.assertions[0].factPath = 'missing.fact'; },
    o => { o.title.factRefs = ['productAttributes.material']; }, o => { o.title.assertions[0].extra = true; },
    o => { o.title.keywordRefs = ['wrong-keyword']; }, o => { o.title = { text: 'bad' }; }, o => { o.extra = true; }];
  for (const change of mutations) {
    const output = fixedOutput(); change(output);
    assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
    assert.equal(validateC1AiDraftReceipt({ request, receipt: withOutput(request, output) }).valid, false);
  }
});

test('assertion对象内证据必须完整保留；来源证据缺失无法建立合同', () => {
  const skuPackage = nonTrainSkuPackage();
  skuPackage.c1ProductPlan.productAttributes.dimensions.value.evidenceRef = 'supplier:dimensions:1';
  const request = buildRequest({ skuPackage });
  const fact = request.verifiedFacts.find(f => f.factPath === 'productAttributes.dimensions');
  const output = fixedOutput(); output.title.factRefs = [fact.factPath]; output.title.assertions = [{ factPath: fact.factPath, value: structuredClone(fact.value) }];
  assert.equal(validateC1AiDraftOutput({ request, output }).valid, true);
  delete output.title.assertions[0].value.evidenceRef;
  assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
  const invalidRequest = structuredClone(request); invalidRequest.verifiedFacts[0].evidenceRefs = []; reseal(invalidRequest);
  assert.equal(validateC1AiDraftRequest(invalidRequest).valid, false);
  assert.throws(() => resolveC1AiDraftOutputContract(invalidRequest), /FACTS_INVALID/);
});

async function interceptedRun({ change = () => {} } = {}) {
  const request = buildRequest(), execution = authorizedExecution(request), calls = [];
  const promise = runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: execution,
    gatewayUrl: 'http://127.0.0.1:4318', onGatewayJobAccepted: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, body: JSON.parse(options.body) });
      const body = calls[0].body;
      assert.deepEqual(body.outputSchema, request.outputContractSnapshot.outputSchema);
      assert.equal(body.sourceBinding.requestFingerprint, request.requestFingerprint);
      for (const instruction of request.outputContractSnapshot.instructions) assert.ok(body.input.text.includes(instruction));
      const job = { ...body, jobId: 'gateway:contract:1', status: 'completed', attempt: 1,
        startedAt: '2026-08-22T02:01:00.000Z', completedAt: '2026-08-22T02:01:01.000Z',
        receipt: { receiptVersion: 'inference-receipt-v1', requestHash: 'a'.repeat(64), providerRequestId: 'provider:contract:1',
          validation: { schemaValid: true }, usage: 'unknown', output: fixedOutput() } };
      change(job); return Response.json(job);
    } });
  return { promise, calls, request };
}

test('真实POST构建被注入fetch截获：schema逐字段等于持久快照，合格回执通过', async () => {
  const f = await interceptedRun(); const result = await f.promise;
  assert.equal(result.status, 'receipt_ready');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'POST');
});

test('网关宣称schemaValid仍不能放行错事实；拒绝回执带可信服务时间', async () => {
  const f = await interceptedRun({ change: job => { job.receipt.output.title.assertions[0].value = 'invented'; } });
  await assert.rejects(f.promise, error => {
    assert.ok(error instanceof C1AiGatewayError); assert.equal(error.code, 'C1_AI_GATEWAY_RECEIPT_REJECTED');
    assert.deepEqual(error.serviceTiming, { schemaVersion: 'c1-service-timing-v1', gatewayJobId: 'gateway:contract:1',
      startedAt: '2026-08-22T02:01:00.000Z', completedAt: '2026-08-22T02:01:01.000Z' });
    assert.equal(Object.hasOwn(error, 'receipt'), false); return true;
  });
  assert.equal(f.calls.length, 1);
});

test('serviceTiming时间与网关身份边界不允许猜测或错绑', () => {
  const value = { schemaVersion: 'c1-service-timing-v1', gatewayJobId: 'gateway:1', startedAt: '2026-08-22T02:01:00.000Z', completedAt: '2026-08-22T02:01:01.000Z' };
  assert.deepEqual(assertC1ServiceTiming(value, { gatewayJobId: 'gateway:1' }), value);
  assert.throws(() => assertC1ServiceTiming(value, { gatewayJobId: 'gateway:other' }), /C1_SERVICE_TIMING_INVALID/);
  assert.throws(() => assertC1ServiceTiming({ ...value, completedAt: 'invalid' }), /C1_SERVICE_TIMING_INVALID/);
  assert.throws(() => assertC1ServiceTiming({ ...value, completedAt: value.startedAt, startedAt: value.completedAt }), /C1_SERVICE_TIMING_INVALID/);
});

test('持久schema无共享对象别名，标题描述长度与关键词位置各自冻结', () => {
  const request = buildRequest(); const schema = request.outputContractSnapshot.outputSchema;
  const seen = new WeakSet();
  function walk(value) { if (!value || typeof value !== 'object') return; assert.equal(seen.has(value), false); seen.add(value); Object.values(value).forEach(walk); }
  walk(request.outputContractSnapshot);
  assert.equal(schema.properties.title.properties.text.maxLength, request.seoRules.titleMaxLength);
  assert.equal(schema.properties.description.properties.text.maxLength, request.seoRules.descriptionMaxLength);
  const copy = structuredClone(schema);
  copy.properties.description.properties.factRefs.items.enum.push('other');
  assert.equal(copy.properties.title.properties.factRefs.items.enum.includes('other'), false);
  copy.properties.searchKeywords.items.properties.text.maxLength = 1;
  assert.notEqual(copy.properties.bulletPoints.items.properties.text.maxLength, 1);
});

test('unknown供应结果即使带时间也不冒充可信生成完成时间', async () => {
  const f = await interceptedRun({ change: job => { job.status = 'failed'; job.failure = { code: 'PROVIDER_TIMEOUT', layer: 'transport' }; job.externalRequestState = 'unknown_outcome'; job.requestTransmission = 'attempted'; } });
  await assert.rejects(f.promise, error => {
    assert.ok(error instanceof C1AiGatewayError); assert.equal(error.code, 'PROVIDER_TIMEOUT');
    assert.equal(error.externalRequestState, 'unknown_outcome'); assert.equal(error.serviceTiming, null); return true;
  });
});

test('同scope终态回执非法或倒序时间转为有编号耗用的typed失败', async () => {
  for (const completedAt of ['invalid', '2026-08-22T02:00:00.000Z']) {
    const f = await interceptedRun({ change: job => { job.completedAt = completedAt; } });
    await assert.rejects(f.promise, error => {
      assert.ok(error instanceof C1AiGatewayError); assert.equal(error.code, 'C1_AI_GATEWAY_TIMING_INVALID');
      assert.equal(error.externalRequestState, 'succeeded'); assert.equal(error.accounting.gatewayJobId, 'gateway:contract:1');
      assert.equal(error.serviceTiming, null); return true;
    });
  }
});

test('本地仅标题词合同明确允许零搜索词，词用途不串位且未核实平台长度保持null', () => {
  const candidate = createSavedLocalPreparationCandidate({ titleOnly: true });
  const prepared = prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT });
  candidate.lifecycleV11.skuPackage = structuredClone(prepared.skuPackage);
  candidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(prepared.sourceEvidence);
  const request = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT);
  const schema = request.outputContractSnapshot.outputSchema;
  assert.equal(schema.properties.searchKeywords.minItems, 0);
  assert.equal(schema.properties.searchKeywords.maxItems, 0);
  assert.equal(request.seoRules.titleMaxLength, null);
  const keyword = request.keywordEvidence.keywords[0], fact = request.verifiedFacts.find(f => f.factPath === keyword.factRefs[0]);
  const cited = { text: '3D-пазл', factRefs: [fact.factPath], keywordRefs: [keyword.keywordEvidenceRef], assertions: [{ factPath: fact.factPath, value: structuredClone(fact.value) }] };
  const output = { status: 'draft_only', locale: 'ru-RU', claimCoverage: 'complete', unsupportedClaims: [], title: structuredClone(cited), description: structuredClone(cited), bulletPoints: [], searchKeywords: [] };
  addSyntheticC1Review(request, output);
  assert.equal(validateC1AiDraftOutput({ request, output }).valid, true);
  output.searchKeywords.push(structuredClone(cited));
  assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
});
