import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createC1DraftRuntimeServices } from '../lib/c1-draft-runtime-services.mjs';
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext, createLocalDevelopmentActor } from '../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { c1DraftPreparedCandidate, c1DraftPaidReceipt } from './fixtures/c1-draft-source-fixture.mjs';
import { KEYWORD_NOW } from './fixtures/c1-keyword-planning-fixture.mjs';

const binding = Object.freeze({ schemaVersion: 'c1-draft-service-binding-v1', provider: 'terra', modelVersion: 'gpt-5.6-terra',
  credentialAlias: 'gateway-alias:synthetic', workerId: 'worker:synthetic:c1', workerVersion: 'worker-version:1',
  gatewayOrigin: 'http://127.0.0.1:4318', configurationVersion: 'configuration:synthetic:1', leaseDurationMs: 90_000 });
const owner = createActorContext({ userId: 'owner:synthetic', sessionId: 'session:synthetic', actorType: 'human', roles: ['owner'],
  source: 'authenticated_identity_provider', authenticatedAt: KEYWORD_NOW });

async function fixture(t, { json = false, unknown = false, interruptApply = false } = {}) {
  const candidate = c1DraftPreparedCandidate();
  const document = { candidates: [candidate], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } };
  let repository, filePath;
  if (json) {
    const directory = await mkdtemp(path.join(tmpdir(), 'c1-runtime-services-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    filePath = path.join(directory, 'state.json'); await writeFile(filePath, JSON.stringify(document));
    repository = createJsonBusinessStateRepository({ filePath });
  } else repository = createMemoryBusinessStateRepository(document);
  let reads = 0;
  const observedRepository = { ...repository,
    async readSnapshot() { reads += 1; return repository.readSnapshot(); },
    transact(mutator) { return repository.transact(interrupted(mutator)); },
    // Single-product writes (the C2 apply among them) lock only that product; the failure is injected there too.
    transactCandidates(candidateIds, mutator) { return repository.transactCandidates(candidateIds, interrupted(mutator)); }
  };
  function interrupted(mutator) {
    return async current => {
      const result = await mutator(current);
      if (interruptApply && result.document.candidates[0].lifecycleV11.skuPackage.businessPhase === 'C2') throw new Error('SYNTHETIC_APPLY_STORAGE_FAILURE');
      return result;
    };
  }
  const calls = []; let submitted;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    const saved = await repository.readSnapshot(); const job = saved.runtime.softwareJobs[0];
    assert.equal(job.externalRequestState, 'in_flight');
    assert.equal(job.workerId, binding.workerId);
    if (options.method === 'POST') {
      assert.equal(url, `${binding.gatewayOrigin}/v1/inference-jobs`);
      submitted = JSON.parse(options.body);
      assert.equal(submitted.sourceBinding.softwareJobId, job.jobId);
      assert.equal(submitted.sourceBinding.requestFingerprint, saved.candidates[0].lifecycleV11.c1AiDraftRequestV1.requestFingerprint);
      assert.equal(Object.hasOwn(submitted, 'paymentAuthorization'), false);
      return new Response(JSON.stringify({ jobId: 'gateway:synthetic:one', status: 'queued', sourceBinding: submitted.sourceBinding }), { status: 202 });
    }
    assert.equal(url, `${binding.gatewayOrigin}/v1/inference-jobs/gateway%3Asynthetic%3Aone`);
    assert.equal(job.progressRef, 'gateway:synthetic:one');
    if (unknown) throw new Error('synthetic transport uncertainty');
    const request = saved.candidates[0].lifecycleV11.c1AiDraftRequestV1;
    const { output } = c1DraftPaidReceipt({ request, authorizedExecution: { jobId: job.jobId } });
    return new Response(JSON.stringify({ jobId: 'gateway:synthetic:one', sourceBinding: submitted.sourceBinding,
      candidateId: submitted.candidateId, skuPackageId: submitted.skuPackageId, dataRevision: submitted.dataRevision,
      businessPhase: 'C1', taskType: submitted.taskType, model: submitted.model, status: 'completed', attempt: 1,
      startedAt: KEYWORD_NOW, completedAt: KEYWORD_NOW,
      receipt: { receiptVersion: 'inference-receipt-v1', providerRequestId: 'provider:synthetic:one', requestHash: 'a'.repeat(64),
        requestedAt: KEYWORD_NOW, completedAt: KEYWORD_NOW, validation: { schemaValid: true, strictJson: true }, output } }));
  };
  function compose({ repo = observedRepository, serviceBindings = [binding] } = {}) {
    const registry = createLocalDevelopmentWorkerRegistry({ clock: () => KEYWORD_NOW });
    const services = createC1DraftRuntimeServices({ repository: repo, runtimeMode: 'local_development', serverClock: () => KEYWORD_NOW,
      workerRegistry: registry, serviceBindings, fetchImpl, gatewayWait: async () => {}, gatewayTimeoutMs: 5000 });
    return { services, registry };
  }
  const prepareInput = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, idempotencyKey: 'prepare:synthetic', auditEventId: 'audit:prepare:synthetic' };
  const approve = prepared => ({ actor: owner, input: { candidateId: candidate.id, expectedRevision: prepared.candidate.dataRevision,
    requestRef: prepared.result.requestRef, requestFingerprint: prepared.result.requestFingerprint, confirmPaidCall: true,
    expiresAt: null, idempotencyKey: 'approve:synthetic', auditEventId: 'audit:approve:synthetic' } });
  const trigger = enqueued => ({ candidateId: candidate.id, expectedRevision: enqueued.result.softwareJobRef.revision, jobId: enqueued.result.softwareJobRef.jobId });
  return { repository, compose, candidate, prepareInput, approve, trigger, calls, filePath, reads: () => reads,
  };
}

async function enqueue(f, services) {
  const prepared = await services.prepareCurrent({ actor: owner, input: f.prepareInput });
  const approval = f.approve(prepared);
  return { approval, enqueued: await services.authorizeAndEnqueue(approval) };
}

test('构建只注册配置Worker，零候选读取、零网关调用，不探测凭据', async t => {
  const f = await fixture(t); const { services, registry } = f.compose();
  assert.equal(f.reads(), 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(registry.snapshot().map(worker => ({ id: worker.workerId, version: worker.version, capabilities: worker.capabilities, current: worker.heartbeatCurrent })),
    [{ id: binding.workerId, version: binding.workerVersion, capabilities: ['ai-draft-gateway'], current: true }]);
  assert.deepEqual(services.configurationView, [{ provider: binding.provider, modelVersion: binding.modelVersion, configurationVersion: binding.configurationVersion }]);
  assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs.length, 0);
});

test('未配置明确阻塞且无授权、作业或外呼；错误注册表在构造边界拒绝', async t => {
  const f = await fixture(t); const { services, registry } = f.compose({ serviceBindings: [] });
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => services.prepareCurrent({ actor: owner, input: f.prepareInput }), /C1_DRAFT_RUNTIME_NOT_CONFIGURED/);
  assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.calls.length, 0); assert.deepEqual(registry.snapshot(), []);
  assert.throws(() => createC1DraftRuntimeServices({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => KEYWORD_NOW,
    workerRegistry: { register() {}, heartbeat() {} }, serviceBindings: [binding] }), /C1_DRAFT_SERVICE_DEPENDENCY_INVALID/);
  for (const changed of [{ ...binding, provider: 'sol' }, { ...binding, quote: {} }]) assert.throws(() => f.compose({ serviceBindings: [changed] }), /C1_DRAFT_SERVICE_CONFIGURATION_INVALID/);
});

test('必须认证主人确认同一保存请求；并发只发送一次，先保存回执再原子推进C2', async t => {
  const f = await fixture(t); const { services } = f.compose();
  const prepared = await services.prepareCurrent({ actor: owner, input: f.prepareInput });
  const approval = f.approve(prepared); const before = await f.repository.readSnapshot();
  await assert.rejects(() => services.authorizeAndEnqueue({ ...approval, actor: createLocalDevelopmentActor({ userId: owner.userId, at: KEYWORD_NOW }) }), /AUTHENTICATED_OWNER_REQUIRED/);
  await assert.rejects(() => services.authorizeAndEnqueue({ ...approval, input: { ...approval.input, requestFingerprint: 'b'.repeat(64) } }), /SAVED_REQUEST_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.calls.length, 0);
  const enqueued = await services.authorizeAndEnqueue(approval);
  assert.equal((await services.authorizeAndEnqueue(approval)).status, 'idempotent_replay');
  const results = await Promise.allSettled([services.continueSavedCurrent(f.trigger(enqueued)), services.continueSavedCurrent(f.trigger(enqueued))]);
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value.status === 'applied'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.length, 2);
  const saved = await f.repository.readSnapshot(); assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(saved.runtime.softwareJobs[0].status, 'completed'); assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.payload.receipt.gatewayJobId, 'gateway:synthetic:one');
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.businessPhase, 'C2');
  assert.equal((await services.continueSavedCurrent(f.trigger(enqueued))).status, 'idempotent_replay'); assert.equal(f.calls.length, 2);
});

test('JSON回执落盘后应用失败不吞异常；重启只应用回执，alias变化不重新用凭据', async t => {
  const f = await fixture(t, { json: true, interruptApply: true }); const { services } = f.compose();
  const { enqueued } = await enqueue(f, services);
  await assert.rejects(() => services.continueSavedCurrent(f.trigger(enqueued)), /SYNTHETIC_APPLY_STORAGE_FAILURE/);
  const saved = await f.repository.readSnapshot(); assert.equal(saved.runtime.softwareJobs[0].status, 'completed');
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.businessPhase, 'C1'); assert.ok(saved.runtime.softwareJobs[0].resultEnvelope.payload.receipt);
  const restartedRepository = createJsonBusinessStateRepository({ filePath: f.filePath });
  const restarted = f.compose({ repo: restartedRepository, serviceBindings: [{ ...binding, credentialAlias: 'gateway-alias:replacement' }] });
  assert.equal(f.calls.length, 2);
  assert.equal((await restarted.services.continueSavedCurrent(f.trigger(enqueued))).status, 'applied');
  assert.equal((await restartedRepository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.businessPhase, 'C2'); assert.equal(f.calls.length, 2);
});

test('accepted ID后的未知结果持久停止，重启及再次点击均不重发', async t => {
  const f = await fixture(t, { json: true, unknown: true }); const { services } = f.compose();
  const { enqueued } = await enqueue(f, services);
  assert.equal((await services.continueSavedCurrent(f.trigger(enqueued))).status, 'unknown_outcome');
  const restartedRepository = createJsonBusinessStateRepository({ filePath: f.filePath });
  const restarted = f.compose({ repo: restartedRepository });
  assert.equal((await restarted.services.continueSavedCurrent(f.trigger(enqueued))).status, 'stopped');
  const saved = await restartedRepository.readSnapshot(); assert.equal(saved.runtime.softwareJobs[0].progressRef, 'gateway:synthetic:one');
  assert.equal(saved.runtime.softwareJobs[0].externalRequestState, 'unknown_outcome'); assert.equal(f.calls.length, 2);
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.businessPhase, 'C1');
});

test('排队后服务alias或Worker漂移拒绝旧作业且零外呼，不能由新配置扩大旧许可', async t => {
  for (const change of [{ credentialAlias: 'gateway-alias:replacement' }, { workerId: 'worker:replacement' }]) {
    const f = await fixture(t); const { services } = f.compose(); const { enqueued } = await enqueue(f, services);
    const restarted = f.compose({ serviceBindings: [{ ...binding, ...change }] }); const before = await f.repository.readSnapshot();
    await assert.rejects(() => restarted.services.continueSavedCurrent(f.trigger(enqueued)), /SERVICE_BINDING_CONFLICT|WORKER/);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.calls.length, 0);
  }
});

test('owner explicitly resumes only the local keyword handoff after configuration, with no new paid execution',async()=>{
  const {createC1KeywordHandoffRetryFixture}=await import('./fixtures/c1-keyword-handoff-retry-fixture.mjs');
  const f=await createC1KeywordHandoffRetryFixture(),service=f.createServices();
  const result=await service.retryKeywordHandoff({actor:f.owner,input:f.input});
  assert.equal(result.status,'committed');assert.equal(result.result.status,'awaiting_paid_confirmation');
  assert.equal(result.result.schemaVersion,'c1-keyword-handoff-resumption-v1');
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(result.result.priorTechnicalFailure,f.document.candidates[0].executionRuntime.technicalFailure);
  assert.deepEqual(saved.runtime.softwareJobs,f.document.runtime.softwareJobs);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,f.document.runtime.softwareJobAuthorizationRecords);
  assert.equal(saved.candidates[0].dataRevision,f.input.expectedRevision+1);
  assert.equal(saved.candidates[0].executionRuntime.technicalFailure,null);
  assert.equal(saved.candidates[0].executionRuntime.status,'waiting_owner');
  assert.equal(saved.runtime.idempotencyRecords.at(-1).result.priorTechnicalFailure.failureId,f.input.failureId);
  assert.equal(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1.requestId,result.result.requestRef);
  const replay=await f.createServices().retryKeywordHandoff({actor:f.owner,input:f.input});
  assert.equal(replay.status,'idempotent_replay');assert.deepEqual(replay.result,result.result);
  assert.deepEqual(await f.repository.readSnapshot(),saved);assert.deepEqual(f.counts(),{keywordCalls:1,gatewayCalls:0});
});

test('missing draft configuration cannot clear the known keyword handoff failure',async()=>{
  const {createC1KeywordHandoffRetryFixture}=await import('./fixtures/c1-keyword-handoff-retry-fixture.mjs');
  const f=await createC1KeywordHandoffRetryFixture();
  await assert.rejects(f.createServices({serviceBindings:[]}).retryKeywordHandoff({actor:f.owner,input:f.input}),error=>error.code==='C1_DRAFT_RUNTIME_NOT_CONFIGURED');
  assert.deepEqual(await f.repository.readSnapshot(),f.document);assert.deepEqual(f.counts(),{keywordCalls:1,gatewayCalls:0});
});
