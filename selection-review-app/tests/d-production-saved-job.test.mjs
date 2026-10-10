import assert from "node:assert/strict";
import test from "node:test";
import { commitDExecutionIntent, persistDExecutionCheckpoint, runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { savedDProductionJobFixture as savedFixture } from "./fixtures/d-production-saved-job-fixture.mjs";

import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";

// Domain terminal fixtures use explicit checkpoint DTOs, never a fake synchronous seller implementation.
function syntheticCompletion(f, afterCheckpoint=async()=>{}) {
  f.syntheticFactories=0;f.syntheticCheckpoints=[];
  return async({request})=>{
    f.syntheticFactories++;
    return createSyntheticDCompletionAdapter({request,afterCheckpoint:async({event})=>{
      f.syntheticCheckpoints.push(event.kind);
      if(['import_intent','import_task_received','stock_intent'].includes(event.kind))f.commits.push(await f.repository.readSnapshot());
      await afterCheckpoint(event);
    }});
  };
}
const clone = value => structuredClone(value);

test("real PA and registered Worker plus synthetic terminal DTOs atomically complete D and queue independent E", async () => {
  const f = await savedFixture();
  const outcome = await runPersistedDExecution({ ...f.input, createAdapter: syntheticCompletion(f) });
  assert.equal(outcome.status, "succeeded"); assert.equal(f.syntheticFactories, 1);
  assert.deepEqual(f.syntheticCheckpoints,["import_intent","import_task_received","import_result_observed","stock_intent","stock_receipt_observed"]);
  assert.deepEqual(f.calls, []);
  for (const saved of f.commits) {
    const state = saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
    const job = saved.runtime.softwareJobs.find(entry => entry.jobId === f.job.jobId);
    assert.equal(state.softwareJobRef.jobId, f.job.jobId); assert.equal(state.softwareJobRef.revision, f.job.revision);
    assert.equal(job.revision, f.job.revision); assert.equal(job.attempt, 1); assert.equal(job.status, "waiting_platform");
    assert.equal(job.externalRequestRef, `d-production-request:${f.job.scopeBinding.authorizationFingerprint}`);
    assert.equal(saved.candidates[0].dataRevision, f.candidate.dataRevision + 1);
  }
  const saved = await f.repository.readSnapshot(), sku = saved.candidates[0].lifecycleV11.skuPackage;
  assert.equal(sku.dSoftwareExecution.checkpoints.length, 6); assert.equal(sku.dSoftwareExecution.executionRevision, 8);
  assert.equal(sku.dSoftwareExecution.platformWrites, 2); assert.ok(sku.productionRecord);
  assert.equal(sku.eVerificationRecord, null); assert.deepEqual(sku.readbackHistory, []);
  assert.equal(saved.runtime.softwareJobs.find(entry => entry.jobId === f.job.jobId).status, "completed");
  const eJobs = saved.runtime.softwareJobs.filter(entry => entry.jobType === "e_independent_readback");
  assert.equal(eJobs.length, 1); assert.equal(eJobs[0].status, "queued");
  assert.equal(eJobs[0].scopeBinding.sourceProductionRecordId, sku.productionRecord.productionRecordId);
});

test("saved D intent and first job progress commit together without declaring external transmission", async () => {
  const f = await savedFixture();
  const result = await commitDExecutionIntent(f.input);
  assert.equal(result.status, "committed");
  const saved = await f.repository.readSnapshot(), state = saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  const job = saved.runtime.softwareJobs.find(entry => entry.jobId === f.job.jobId);
  assert.equal(job.status, "claimed"); assert.equal(job.externalRequestState, "not_sent"); assert.equal(job.externalRequestRef, null);
  assert.match(job.progressRef, /:intent_persisted$/); assert.equal(job.revision, f.job.revision);
  assert.equal(state.expectedCandidateRevision, saved.candidates[0].dataRevision); assert.equal(state.executionRevision, 1);
  assert.deepEqual(state.softwareJobRef, { jobId: f.job.jobId, revision: f.job.revision, workerId: f.worker.workerId, leaseId: f.job.leaseId });
  assert.equal(f.calls.length, 0);
});

test("v2 checkpoints cannot downgrade to the old owner path by omitting or removing the saved job reference", async () => {
  const f = await savedFixture(), admitted = await commitDExecutionIntent(f.input);
  const args = { repository: f.repository, candidateId: f.input.candidateId, executionKey: admitted.result.executionKey,
    expectedExecutionRevision: 1, event: { kind: "import_intent" }, serverClock: f.input.serverClock };
  await assert.rejects(() => persistDExecutionCheckpoint(args), /D_EXECUTION_SOFTWARE_JOB_CONTEXT_INVALID/);
  await f.repository.transact(document => { delete document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.softwareJobRef;
    return { changed: true, document }; });
  await assert.rejects(() => persistDExecutionCheckpoint(args), /D_EXECUTION_SOFTWARE_JOB_CONTEXT_INVALID/);
  await assert.rejects(() => persistDExecutionCheckpoint({ ...args, softwareJobContext: f.input.softwareJobContext }), /D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
  assert.equal(f.calls.length, 0);
});

test("concurrent execution and restart replay create no second adapter, provider request or E job", async () => {
  const f = await savedFixture(), input = { ...f.input, createAdapter: f.createAdapter() };
  const results = await Promise.all([runPersistedDExecution(input), runPersistedDExecution(input)]);
  assert.equal(results.filter(result => result.status === "waiting_platform").length, 1);
  assert.equal(results.filter(result => result.status === "idempotent_replay").length, 1);
  f.advance(120_000); f.changeServiceVersion();
  const restartedStore = createRepositoryBackedSoftwareJobStore({ businessStateRepository: f.repository, serverClock: f.input.serverClock });
  const beforeReplay=await f.repository.readSnapshot();
  await assert.rejects(()=>runPersistedDExecution({ ...input, softwareJobContext: { ...f.input.softwareJobContext, jobStore: restartedStore } }), /D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(),beforeReplay);
  assert.equal(f.factories(), 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback").length, 0);
});

test("v2 rejects owner execution, second decisions, wrong Worker, context holder and stale candidate CAS with zero requests", async () => {
  const f = await savedFixture(), before = await f.repository.readSnapshot();
  for (const change of [input => { delete input.softwareJobContext; input.actor = f.owner.args.actor; },
    input => { input.ownerExecutionDecision = { confirmed: true }; }, input => { input.actor = f.owner.args.actor; },
    input => { input.actor = { ...input.actor, userId: "worker:other" }; }, input => { input.expectedCandidateRevision += 1; },
    input => { input.softwareJobContext = { ...input.softwareJobContext, leaseId: "lease:other" }; }]) {
    const input = { ...f.input }; change(input);
    await assert.rejects(() => runPersistedDExecution({ ...input, createAdapter: f.createAdapter() }));
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
  assert.equal(f.factories(), 0); assert.equal(f.calls.length, 0);
});

test("config, lease and candidate changes after import preserve receipts and stop stock write", async t => {
  for (const drift of ["configuration", "lease", "candidate"]) await t.test(drift,async()=>{
    const f = await savedFixture();
    const outcome = await runPersistedDExecution({ ...f.input, createAdapter: f.createAdapter(async call => {
      if (call.endpoint !== "/v3/product/import") return;
      if (drift === "configuration") f.changeServiceVersion();
      else if (drift === "lease") f.advance(60_001);
      else await f.repository.transact(document => { document.candidates[0].dataRevision += 1; return { changed: true, document }; });
    }) });
    assert.equal(outcome.status, "failed"); assert.deepEqual(f.calls, ["/v3/product/import"]);
    const saved = await f.repository.readSnapshot(), state = saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
    assert.deepEqual(state.checkpoints.map(event => event.kind), ["import_intent", "import_task_received"]);
    assert.equal(state.continuationBlocked, true);
    assert.equal(state.blockReason, drift === "lease" ? "lease_expired" : "context_changed");
    assert.equal(state.attempt.failure.code,state.blockReason);
    assert.equal(state.attempt.failure.layer,'platform_observation');
    assert.equal(state.platformWrites,1);
    assert.equal(state.attempt.platformResult.taskId,'501');
    assert.match(state.attempt.platformResult.requestReceiptRef,/^ozon-import-receipt:/);
    assert.equal(state.platformContinuation.taskId,'501');
    assert.equal(state.platformContinuation.requestReceiptRef,state.attempt.platformResult.requestReceiptRef);
    assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
    assert.equal(state.platformContinuation.status,'blocked');
    assert.deepEqual(state.platformContinuation.observationHistory,[]);
    assert.equal(saved.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
    assert.equal(saved.runtime.softwareJobs.filter(job=>job.jobType==='e_d_platform_observation').length,0);
    assert.equal(saved.runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback").length, 0);
    const stopped=saved.runtime.softwareJobs.find(job=>job.jobId===f.job.jobId);
    assert.equal(stopped.status,'failed');assert.equal(stopped.externalRequestState,'succeeded');
    assert.equal(stopped.failureClass,drift==='lease'?'d-initial-import-lease-expired':'d-initial-import-context-changed');
    const replay=await runPersistedDExecution({...f.input,createAdapter:f.createAdapter()});
    assert.equal(replay.status,'idempotent_replay');assert.equal(replay.executionStatus,'failed');
    assert.deepEqual(f.calls,['/v3/product/import']);assert.equal(f.factories(),1);
    assert.deepEqual(await f.repository.readSnapshot(),saved);
  });
});

test("unknown import outcome never replays a provider request", async () => {
  const f = await savedFixture(), input = { ...f.input, createAdapter: f.createAdapter(async () => { throw new Error("synthetic transport disconnect"); }) };
  assert.equal((await runPersistedDExecution(input)).status, "unknown_outcome");
  assert.equal((await runPersistedDExecution(input)).status, "idempotent_replay");
  assert.deepEqual(f.calls, ["/v3/product/import"]); assert.equal(f.factories(), 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs.find(job => job.jobId === f.job.jobId).status, "unknown_outcome");
  assert.equal(saved.runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback").length, 0);
});

test("synthetic late terminal receipts survive lease expiry; source changes retain ProductionRecord without queuing E", async () => {
  for (const drift of ["lease", "candidate"]) {
    const f = await savedFixture();
    const result = await runPersistedDExecution({ ...f.input, createAdapter: syntheticCompletion(f, async event => {
      if (event.kind !== "stock_intent") return;
      if (drift === "lease") f.advance(60_001);
      else await f.repository.transact(document => { document.candidates[0].dataRevision += 1; return { changed: true, document }; });
    }) });
    assert.equal(result.status, "succeeded"); assert.equal(f.syntheticCheckpoints.length, 5); assert.equal(f.calls.length, 0);
    const saved = await f.repository.readSnapshot(), sku = saved.candidates[0].lifecycleV11.skuPackage;
    assert.ok(sku.productionRecord); assert.equal(sku.dSoftwareExecution.checkpoints.length, 6);
    assert.equal(sku.dSoftwareExecution.continuationBlocked, drift === "candidate");
    const job = saved.runtime.softwareJobs.find(job => job.jobId === f.job.jobId);
    assert.equal(job.status, "completed"); assert.equal(job.externalRequestState, "succeeded");
    assert.equal(saved.runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback").length, drift === "lease" ? 1 : 0);
  }
});

test("saved replay rejects another plan, job reference or candidate revision without external work", async () => {
  const f = await savedFixture(); await commitDExecutionIntent(f.input);
  await assert.rejects(() => runPersistedDExecution({ ...f.input, expectedCandidateRevision: f.input.expectedCandidateRevision + 1,
    createAdapter: f.createAdapter() }), /D_EXECUTION_REPLAY_SOURCE_CONFLICT/);
  const changedPlan = clone(f.input.productionPlan); changedPlan.createdAt = new Date(Date.parse(changedPlan.createdAt) + 1).toISOString();
  await assert.rejects(() => runPersistedDExecution({ ...f.input, productionPlan: changedPlan, createAdapter: f.createAdapter() }), /D_EXECUTION_REPLAY_SOURCE_CONFLICT/);
  await f.repository.transact(document => { document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.softwareJobRef.jobId += "-other";
    return { changed: true, document }; });
  await assert.rejects(() => runPersistedDExecution({ ...f.input, createAdapter: f.createAdapter() }), /D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
  assert.equal(f.factories(), 0); assert.equal(f.calls.length, 0);
});

test("a known gate failure before the first write persists the precise block with zero provider requests", async () => {
  const f = await savedFixture(), factory = f.createAdapter();
  const result = await runPersistedDExecution({ ...f.input, createAdapter: async context => {
    f.changeServiceVersion(); return factory(context);
  } });
  assert.equal(result.status, "failed"); assert.equal(f.calls.length, 0);
  const saved = await f.repository.readSnapshot(), state = saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.continuationBlocked, true); assert.equal(state.blockReason, "SOFTWARE_JOB_ADMISSION_DE_BINDING_CHANGED");
  assert.deepEqual(state.checkpoints, []); assert.equal(state.platformWrites, 0);
  const job = saved.runtime.softwareJobs.find(job => job.jobId === f.job.jobId);
  assert.equal(job.status, "failed"); assert.equal(job.externalRequestState, "not_sent");
});

test("unexpected guard code failure propagates unchanged and does not fabricate a normal terminal result", async () => {
  const f = await savedFixture(), unexpected = new TypeError("synthetic unexpected guard implementation failure");
  let checks = 0;
  const jobStore = { ...f.jobStore, assertDEExecutionInDocument(input) {
    if (++checks === 2) throw unexpected;
    return f.jobStore.assertDEExecutionInDocument(input);
  } };
  await assert.rejects(() => runPersistedDExecution({ ...f.input,
    softwareJobContext: { ...f.input.softwareJobContext, jobStore }, createAdapter: f.createAdapter() }), error => error === unexpected);
  const saved = await f.repository.readSnapshot(), state = saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status, "in_flight"); assert.deepEqual(state.checkpoints, []); assert.equal(f.calls.length, 0);
  assert.equal(saved.runtime.softwareJobs.find(job => job.jobId === f.job.jobId).status, "claimed");
});

test("receipt persistence failure propagates and keeps the last certain checkpoint without running the next query", async () => {
  const f = await savedFixture();
  const repository = { ...f.repository, transact: mutator => f.repository.transact(async document => {
    const outcome = await mutator(document);
    if (outcome.changed && outcome.document?.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution?.step === "import_task_received") {
      throw new Error("synthetic storage replacement failed");
    }
    return outcome;
  }) };
  await assert.rejects(() => runPersistedDExecution({ ...f.input, repository, createAdapter: f.createAdapter() }),
    error => error.code === "D_CHECKPOINT_PERSISTENCE_FAILED");
  const saved = await f.repository.readSnapshot(), state = saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status, "in_flight"); assert.deepEqual(state.checkpoints.map(event => event.kind), ["import_intent"]);
  assert.deepEqual(f.calls, ["/v3/product/import"]);
  assert.equal(saved.runtime.softwareJobs.find(job => job.jobId === f.job.jobId).status, "waiting_platform");
});

test('confirmed D creation with unverified CDN media queues E once and preserves the raw pending observation', async () => {
  const f = await savedFixture();let factories = 0, observed;
  const input = { ...f.input, createAdapter: async ({ request }) => {
    factories++;
    const adapter = createSyntheticDCompletionAdapter({ request });
    return { ...adapter, readbackSellerApi: async query => {
      observed = structuredClone(await adapter.readbackSellerApi(query));
      observed.mediaObservation = { sourceProtocol: 'ozon-product-attributes-v4',
        primaryImageUrl: 'https://cdn.example.com/new/main.jpg', images: ['https://cdn.example.com/new/detail.jpg'] };
      observed.moderationStatus = 'in_moderation';observed.validationStatus = 'processing';observed.saleStatus = 'unknown';
      return observed;
    } };
  } };
  const results = await Promise.all([runPersistedDExecution(input), runPersistedDExecution(input)]);
  assert.equal(results.filter(value => value.status === 'succeeded').length, 1);
  assert.equal(results.filter(value => value.status === 'idempotent_replay').length, 1);
  assert.equal(factories, 1);
  const saved = await f.repository.readSnapshot(), sku = saved.candidates[0].lifecycleV11.skuPackage;
  assert.equal(sku.productionRecord.status, 'validation_or_moderation');
  assert.equal(sku.eVerificationRecord, null);
  assert.deepEqual(sku.dSoftwareExecution.attempt.immediateReadback, observed);
  assert.equal(saved.runtime.softwareJobs.filter(job => job.jobType === 'e_independent_readback').length, 1);
  assert.equal(saved.runtime.softwareJobs.find(job => job.jobType === 'e_independent_readback').status, 'queued');
  assert.equal((await runPersistedDExecution(input)).status, 'idempotent_replay');
  assert.equal(factories, 1);assert.deepEqual(await f.repository.readSnapshot(), saved);
});
