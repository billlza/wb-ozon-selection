import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './fixtures/c1-local-draft-source-fixture.mjs';
import { c1DraftPaidReceipt } from './fixtures/c1-draft-source-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createC1DraftSoftwareUseCase } from '../lib/c1-draft-software-use-case.mjs';
import { createC1DraftSoftwareRuntime } from '../lib/c1-draft-software-runtime.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { C1AiGatewayError } from '../lib/c1-ai-gateway.mjs';
import { isC1AiDraftReconciliationPending, readC1AiDraftReconciliationSource, settleSoftwareJob } from '../lib/software-job-contract.mjs';

async function fixture({ read = null } = {}) {
  const base = Date.parse(LOCAL_DRAFT_AT); let tick = 0, posts = 0, gets = 0;
  const clock = () => new Date(base + (++tick) * 10).toISOString();
  const repository = createMemoryBusinessStateRepository({ candidates: [createSavedLocalPreparationCandidate()] });
  const registry = createLocalDevelopmentWorkerRegistry({ clock });
  const workerId = 'worker:reconcile';
  registry.register({ workerId, capabilities: ['ai-draft-gateway'], version: '1', observedAt: clock() });
  const owner = createActorContext({ userId: 'owner:reconcile', sessionId: 'session:owner', actorType: 'human', roles: ['owner'],
    source: 'authenticated_identity_provider', authenticatedAt: clock() });
  const worker = createActorContext({ userId: workerId, sessionId: 'session:worker', actorType: 'worker', roles: ['operator'],
    source: 'registered_runtime_worker', authenticatedAt: clock() });
  const useCase = createC1DraftSoftwareUseCase({ repository, runtimeMode: 'local_development', serverClock: clock, workerRegistry: registry,
    executionBinding: { provider: 'terra', modelVersion: 'gpt-5.6-terra', credentialAlias: 'gateway:reconcile', allowedWorkerIds: [workerId] },
    requestGateway: async ({ authorizedExecution, onGatewayJobAccepted }) => {
      posts += 1;
      const gatewayJobId = `gateway:${authorizedExecution.jobId}`;
      await onGatewayJobAccepted({ gatewayJobId });
      throw new C1AiGatewayError('C1_AI_GATEWAY_DEADLINE_EXCEEDED', 'gateway_status', 'synthetic deadline', { jobId: gatewayJobId });
    },
    readGatewayResult: async input => {
      gets += 1;
      const saved = (await repository.readSnapshot()).runtime.softwareJobs[0];
      assert.equal(saved.status, 'unknown_outcome');
      assert.equal(saved.c1ResultReconciliation.readAttempt.status, 'in_flight');
      assert.equal(input.gatewayJobId, saved.progressRef);
      assert.equal(input.authorizedExecution.status, 'waiting_platform');
      assert.equal(input.totalTimeoutMs, Math.min(60_000, saved.c1ResultReconciliation.readAttempt.expiresAt
        ? Date.parse(saved.c1ResultReconciliation.readAttempt.expiresAt) - Date.parse(saved.c1ResultReconciliation.readAttempt.startedAt) : 0));
      const response = () => ({ status: 'receipt_ready', jobId: input.gatewayJobId, request: input.request,
        receipt: c1DraftPaidReceipt(input, clock()) });
      return read ? read({ input, response, repository, clock }) : response();
    } });
  let candidate = (await repository.readSnapshot()).candidates[0];
  await useCase.prepareLocal({ actor: owner, input: { candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    idempotencyKey: 'prepare:reconcile', auditEventId: 'audit:prepare:reconcile' } });
  candidate = (await repository.readSnapshot()).candidates[0];
  const request = candidate.lifecycleV11.c1AiDraftRequestV1;
  await useCase.authorizeAndEnqueue({ actor: owner, input: { candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    requestRef: request.requestId, requestFingerprint: request.requestFingerprint, confirmPaidCall: true, expiresAt: null,
    idempotencyKey: 'authorize:reconcile', auditEventId: 'audit:authorize:reconcile' } });
  candidate = (await repository.readSnapshot()).candidates[0];
  const execution = { workerActor: worker, leaseId: 'read:lease', leaseDurationMs: 60_000 };
  const runtime = createC1DraftSoftwareRuntime({ useCase, loadSavedExecution: async () => execution });
  const trigger = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, jobId: candidate.lifecycleV11.c1AiDraftJobRefV1.jobId };
  assert.equal((await runtime.continueSavedCurrent(trigger)).status, 'unknown_outcome');
  const before = await repository.readSnapshot();
  assert.ok(Date.parse(before.runtime.softwareJobs[0].resultEnvelope.recordedAt) < Date.parse(before.runtime.softwareJobs[0].completedAt));
  return { repository, runtime, useCase, registry, owner, worker, execution, trigger, before, calls: () => ({ posts, gets }),
    advance: ms => { tick += ms / 10; registry.heartbeat({ workerId, capabilities: ['ai-draft-gateway'], version: '1' }); } };
}

test('递增时间的历史deadline可只读对账，保留原失败，原授权与attempt仅1，成功后重入零GET', async () => {
  const f = await fixture();
  const original = f.before.runtime.softwareJobs[0];
  assert.equal(isC1AiDraftReconciliationPending(original), true);
  assert.equal(readC1AiDraftReconciliationSource(original).gatewayJobId, original.progressRef);
  assert.equal((await f.runtime.reconcileSavedCurrent(f.trigger)).status, 'applied');
  const saved = await f.repository.readSnapshot(), job = saved.runtime.softwareJobs[0];
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(job.attempt, 1);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords, f.before.runtime.softwareJobAuthorizationRecords);
  assert.equal(job.c1ResultReconciliation.priorOutcome.failureClass, original.failureClass);
  assert.deepEqual(job.c1ResultReconciliation.priorOutcome.resultEnvelope, original.resultEnvelope);
  assert.equal(job.c1ResultReconciliation.readAttempt.status, 'completed');
  assert.equal(job.resultEnvelope.applicationDisposition, 'applied');
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.businessPhase, 'C1');
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, 'seo_draft_ready');
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.equal((await f.runtime.reconcileSavedCurrent(f.trigger)).status, 'idempotent_replay');
  assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
});

test('同job不同lease并发只一次GET，其余pending；未完成不改变原unknown或候选', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture({ read: async ({ input }) => { entered(); await held; return { status: 'pending', jobId: input.gatewayJobId, request: input.request }; } });
  const first = f.runtime.reconcileSavedCurrent(f.trigger);
  await started;
  f.execution.leaseId = 'different:lease';
  assert.deepEqual(await f.runtime.reconcileSavedCurrent(f.trigger), { status: 'pending', jobId: f.trigger.jobId, reconciliationInProgress: true });
  release(); assert.equal((await first).status, 'pending');
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.candidates, f.before.candidates);
  assert.deepEqual(saved.runtime.softwareJobs[0].resultEnvelope, f.before.runtime.softwareJobs[0].resultEnvelope);
  assert.equal(saved.runtime.softwareJobs[0].status, 'unknown_outcome');
  assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
});

test('已知读失败保留unknown，明确供应商失败保存失败终态，未知错误仍抛出', async () => {
  for (const kind of ['read', 'provider', 'unknown']) {
    const f = await fixture({ read: async ({ input }) => {
      if (kind === 'unknown') throw new Error('unexpected reader defect');
      throw new C1AiGatewayError(kind === 'read' ? 'C1_AI_GATEWAY_STATUS_UNAVAILABLE' : 'C1_AI_PROVIDER_FAILED', 'gateway_status', 'synthetic failure',
        { jobId: input.gatewayJobId, externalRequestState: kind === 'read' ? 'unknown_outcome' : 'failed' });
    } });
    if (kind === 'unknown') await assert.rejects(f.runtime.reconcileSavedCurrent(f.trigger), /unexpected reader defect/);
    else assert.equal((await f.runtime.reconcileSavedCurrent(f.trigger)).status, kind === 'read' ? 'unknown_outcome' : 'failed');
    const saved = await f.repository.readSnapshot(), job = saved.runtime.softwareJobs[0];
    assert.deepEqual(saved.candidates, f.before.candidates);
    assert.equal(job.status, kind === 'provider' ? 'failed' : 'unknown_outcome');
    if (kind !== 'provider') assert.deepEqual(job.resultEnvelope, f.before.runtime.softwareJobs[0].resultEnvelope);
    else assert.deepEqual(job.c1ResultReconciliation.priorOutcome.resultEnvelope, f.before.runtime.softwareJobs[0].resultEnvelope);
    assert.equal(job.attempt, 1);
    assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
  }
});

test('错误候选/修订/请求/网关绑定或非registered worker全部在GET前拒绝', async () => {
  for (const kind of ['revision', 'candidate', 'request', 'gateway', 'worker']) {
    const f = await fixture();
    if (kind === 'revision') f.trigger.expectedRevision += 1;
    if (kind === 'candidate') f.trigger.candidateId = 'candidate:other';
    if (kind === 'worker') f.execution.workerActor = { ...f.worker, userId: 'worker:unregistered' };
    if (['request', 'gateway'].includes(kind)) await f.repository.transact(document => {
      if (kind === 'request') document.candidates[0].lifecycleV11.c1AiDraftRequestV1.requestId = 'wrong';
      else document.runtime.softwareJobs[0].progressRef = 'gateway:other';
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.runtime.reconcileSavedCurrent(f.trigger));
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.deepEqual(f.calls(), { posts: 1, gets: 0 });
  }
});

test('读取期间candidate revision改变只保存原回执，拒绝应用且不覆盖备注', async () => {
  const f = await fixture({ read: async ({ repository, response }) => {
    await repository.transact(document => { document.candidates[0].dataRevision += 1; document.candidates[0].notes = 'concurrent note'; return { changed: true, document, result: null }; });
    return response();
  } });
  await assert.rejects(f.runtime.reconcileSavedCurrent(f.trigger), /REVISION_CONFLICT/);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.candidates[0].notes, 'concurrent note');
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, 'facts_checked');
  assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, 'revision_conflict_not_applied');
  assert.equal(saved.runtime.softwareJobs[0].status, 'completed');
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
});

test('到期读取只能由显式动作再开，旧慢响应的attempt fencing不能覆盖新结果', async () => {
  let release, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture({ read: async ({ response }) => { calls += 1; if (calls === 1) { entered(); await held; } return response(); } });
  const first = f.runtime.reconcileSavedCurrent(f.trigger);
  await started;
  f.advance(61_000);
  assert.equal((await f.runtime.reconcileSavedCurrent(f.trigger)).status, 'applied');
  const saved = await f.repository.readSnapshot();
  release(); await assert.rejects(first, /C1_DRAFT_RECONCILIATION_NOT_ELIGIBLE|C1_DRAFT_RECONCILIATION_LEASE_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
  assert.deepEqual(f.calls(), { posts: 1, gets: 2 });
  assert.equal(saved.runtime.softwareJobs[0].c1ResultReconciliation.readAttempt.sequence, 2);
});

test('通用settle仍不能从unknown完成；无持久接受证据的restart记录不在对账范围', async () => {
  const f = await fixture(), job = f.before.runtime.softwareJobs[0];
  assert.throws(() => settleSoftwareJob({ job, workerId: job.workerId, leaseId: job.leaseId, status: 'completed', externalRequestState: 'succeeded', serverTime: job.completedAt }), /SOFTWARE_JOB_SETTLEMENT_REJECTED/);
  assert.equal(isC1AiDraftReconciliationPending({ ...job, resultEnvelope: null, resultRef: null, failureClass: 'service_restart_after_external_request' }), false);
});

test('原结果拒绝时保存同一网关的真实服务时间；首次等待和原失败不被覆盖', async () => {
  const f = await fixture({ read: async ({ input, repository, clock }) => {
    const job = (await repository.readSnapshot()).runtime.softwareJobs[0];
    throw new C1AiGatewayError('C1_AI_GATEWAY_RECEIPT_REJECTED', 'receipt', 'rejected citations', {
      jobId: input.gatewayJobId, externalRequestState: 'succeeded',
      serviceTiming: { schemaVersion: 'c1-service-timing-v1', gatewayJobId: input.gatewayJobId,
        startedAt: job.startedAt, completedAt: clock() }
    });
  } });
  const before = f.before.runtime.softwareJobs[0];
  assert.equal((await f.runtime.reconcileSavedCurrent(f.trigger)).status, 'failed');
  const after = await f.repository.readSnapshot(), job = after.runtime.softwareJobs[0];
  assert.equal(job.resultEnvelope.payload.serviceTiming.gatewayJobId, before.progressRef);
  assert.equal(job.resultEnvelope.payload.serviceTiming.startedAt, before.startedAt);
  assert.deepEqual(job.c1ResultReconciliation.priorOutcome.resultEnvelope, before.resultEnvelope);
  assert.equal(job.c1ResultReconciliation.priorOutcome.completedAt, before.completedAt);
  assert.deepEqual(after.candidates, f.before.candidates);
  assert.deepEqual(after.runtime.softwareJobAuthorizationRecords, f.before.runtime.softwareJobAuthorizationRecords);
  assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
});

test('服务耗时不能串用其他网关记录或早于原请求', async () => {
  for (const invalid of ['foreign_gateway', 'before_request']) {
    const f = await fixture({ read: async ({ input, repository, clock }) => {
      const job = (await repository.readSnapshot()).runtime.softwareJobs[0];
      throw new C1AiGatewayError('C1_AI_GATEWAY_RECEIPT_REJECTED', 'receipt', 'invalid timing', {
        jobId: input.gatewayJobId, externalRequestState: 'succeeded',
        serviceTiming: { schemaVersion: 'c1-service-timing-v1',
          gatewayJobId: invalid === 'foreign_gateway' ? 'gateway:foreign' : input.gatewayJobId,
          startedAt: invalid === 'before_request' ? '2020-01-01T00:00:00.000Z' : job.startedAt,
          completedAt: clock() }
      });
    } });
    await assert.rejects(f.runtime.reconcileSavedCurrent(f.trigger), /TIMING/);
    const after = await f.repository.readSnapshot();
    assert.deepEqual(after.candidates, f.before.candidates);
    assert.deepEqual(after.runtime.softwareJobs[0].resultEnvelope, f.before.runtime.softwareJobs[0].resultEnvelope);
    assert.deepEqual(after.runtime.softwareJobAuthorizationRecords, f.before.runtime.softwareJobAuthorizationRecords);
  }
});
