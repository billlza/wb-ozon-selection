import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { authorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { createDAssetTransportSoftwareRuntime } from "../lib/d-asset-transport-software-use-case.mjs";
import { createPersistableAliyunOssAssetIntent, executeAliyunOssAssetIntent } from "../lib/aliyun-oss-d-asset-integration.mjs";
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { AliyunOssLocalPreparationError } from "../lib/production-execution-failure.mjs";

const clone = value => structuredClone(value);
const validator = await loadPublishedSchemaValidator();
const validateSku = validator.getSchema("product-lifecycle-v1.1");
const validateJob = validator.getSchema("software-job-v1.schema.json");

async function fixture({ filePath = null } = {}) {
  const d = await savedDProductionJobFixture();
  let repository = d.repository, jobStore = d.jobStore;
  const configuration = clone(d.job.admissionDecision.executionBindingSnapshot);
  const createStore = target => createRepositoryBackedSoftwareJobStore({ businessStateRepository: target,
    serverClock: d.input.serverClock, workerRegistry: d.registry, resolveDEExecutionBinding: () => clone(configuration) });
  if (filePath !== null) {
    await fs.writeFile(filePath, JSON.stringify(await repository.readSnapshot()));
    repository = createJsonBusinessStateRepository({ filePath }); jobStore = createStore(repository);
  }
  const runArgs = { actor: d.input.actor, input: { candidateId: d.candidate.id, expectedCandidateRevision: d.candidate.dataRevision },
    softwareJobContext: { ...d.input.softwareJobContext, jobStore } };
  const puts = [], commits = []; let uploads = 0, configurationReads = 0;
  const upload = ({ onStart = async () => {}, onPut = async () => {} } = {}) => async ({ finalUploads, beforePublicWrite }) => {
    uploads += 1; await onStart();
    for (const { assetId, order, sha256 } of finalUploads) {
      await beforePublicWrite({ assetId, order, sha256 });
      commits.push(await repository.readSnapshot()); puts.push(assetId); await onPut({ assetId, order, sha256 });
    }
    // Injected provider receipt for these exact synthetic assets; no file, credential or network access occurs.
    return { status: "verified", mode: "preapproved_stable_https", protocolVersion: "aliyun-oss-final-assets-v1",
      evidenceRef: "oss:synthetic:saved-job", approvedHosts: ["assets.example.com"], resolvedAssets: finalUploads.map(asset => ({
        assetId: asset.assetId, sha256: asset.sha256, order: asset.order, role: asset.role,
        platformAcceptedUrl: `https://assets.example.com/saved/${asset.sha256}.jpg`, stable: true, authorizationStatus: "approved",
        evidenceRef: `oss:synthetic:${asset.assetId}` })) };
  };
  const runtime = (overrides = {}) => createDAssetTransportSoftwareRuntime({ repository, runtimeMode: "local_development", serverClock: d.input.serverClock,
    upload: upload(), resolveLocalAsset: async () => { throw new Error("Synthetic uploader does not read files"); },
    loadCurrentProductionBinding: () => { configurationReads += 1; return clone(d.currentProductionBinding); }, ...overrides });
  return { d, repository, jobStore, createStore, configuration, runArgs, puts, commits, upload, runtime,
    counts: () => ({ uploads, configurationReads }) };
}

function stateOf(document, jobId) {
  const candidate = document.candidates[0], sku = candidate.lifecycleV11.skuPackage;
  return { candidate, sku, state: sku.dAssetTransport, job: document.runtime.softwareJobs.find(job => job.jobId === jobId) };
}

function assertPublished(document) {
  assert.deepEqual(validateSkuLifecyclePackage(document.candidates[0].lifecycleV11.skuPackage), { valid: true, errors: [] });
  assert.equal(validateSku(document.candidates[0].lifecycleV11.skuPackage), true, JSON.stringify(validateSku.errors));
  for (const job of document.runtime.softwareJobs) assert.equal(validateJob(job), true, JSON.stringify(validateJob.errors));
}

test("formal local preparation failure is not_sent only before the first persisted public request", async () => {
  for (const afterWrite of [false, true]) {
    const f = await fixture();
    const result = await f.runtime({ upload: f.upload({
      onStart: async () => { if (!afterWrite) throw new AliyunOssLocalPreparationError("OSS_CREDENTIAL_UNAVAILABLE"); },
      onPut: async () => { if (afterWrite) throw new AliyunOssLocalPreparationError("OSS_CREDENTIAL_UNAVAILABLE"); }
    }) }).run(f.runArgs);
    const document = await f.repository.readSnapshot(), saved = stateOf(document, f.d.job.jobId);
    assertPublished(document);
    assert.equal(result.status, afterWrite ? "unknown_outcome" : "failed");
    assert.equal(saved.job.externalRequestState, afterWrite ? "unknown_outcome" : "not_sent");
    assert.equal(saved.state.intent.ossWrites, afterWrite ? "unknown" : 0);
    if (!afterWrite) assert.equal(saved.state.intent.failureLayer, "asset_preparation");
    assert.equal(f.puts.length, afterWrite ? 1 : 0);
  }
  const f = await fixture(), failure = new TypeError("OSS_CREDENTIAL_UNAVAILABLE");
  await assert.rejects(f.runtime({ upload: async () => { throw failure; } }).run(f.runArgs), error => error === failure);
  const saved = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
  assert.equal(saved.job.externalRequestState, "not_sent");
  assert.equal(saved.state.status, "in_flight");
});

test("construction is inert and one saved PA/D job atomically owns OSS intent, every write gate and verified receipts", async () => {
  const f = await fixture(), before = await f.repository.readSnapshot(), transactionStates = [];
  const repository = { ...f.repository, transact: mutator => f.repository.transact(async document => {
    const result = await mutator(document);
    if (result.changed) { assertPublished(result.document); transactionStates.push(clone(result.document)); }
    return result;
  }) };
  const runtime = f.runtime({ repository });
  assert.deepEqual(f.counts(), { uploads: 0, configurationReads: 0 }); assert.deepEqual(await f.repository.readSnapshot(), before);
  const outcome = await runtime.run(f.runArgs);
  assert.equal(outcome.status, "verified"); assert.equal(f.counts().uploads, 1);
  assert.equal(f.puts.length, 2); assert.equal(transactionStates.length, 4);
  const intent = stateOf(transactionStates[0], f.d.job.jobId);
  assert.equal(intent.candidate.dataRevision, f.d.job.revision + 1); assert.equal(intent.state.executionRevision, 1);
  assert.deepEqual(intent.state.softwareJobRef, { jobId: f.d.job.jobId, revision: f.d.job.revision,
    workerId: f.d.worker.workerId, leaseId: f.d.job.leaseId });
  assert.equal(Object.hasOwn(intent.state.intent, "softwareJobRef"), false);
  assert.equal(intent.job.status, "claimed"); assert.equal(intent.job.externalRequestState, "not_sent"); assert.match(intent.job.progressRef, /:intent_persisted$/);
  for (const [index, document] of f.commits.entries()) {
    const saved = stateOf(document, f.d.job.jobId);
    assert.equal(saved.job.status, "waiting_platform"); assert.equal(saved.job.externalRequestState, "in_flight");
    assert.equal(saved.job.externalRequestRef, `d-production-request:${f.d.job.scopeBinding.authorizationFingerprint}`);
    assert.equal(saved.job.revision, f.d.job.revision); assert.equal(saved.candidate.dataRevision, f.d.job.revision + 1);
    assert.equal(saved.job.progressRef, `d-assets:${f.d.job.scopeBinding.authorizationFingerprint}:public_write:${index + 1}`);
  }
  const saved = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
  assert.equal(saved.candidate.dataRevision, f.d.job.revision + 2); assert.equal(saved.state.executionRevision, 2);
  assert.equal(saved.state.continuationBlocked, false); assert.equal(saved.state.intent.ossWrites, 2);
  assert.equal(saved.job.status, "waiting_platform"); assert.equal(saved.job.resultEnvelope, null);
  assert.equal(saved.sku.productionRecord, null); assert.equal(saved.sku.eVerificationRecord, null); assert.equal(Object.hasOwn(saved.sku, "dSoftwareExecution"), false);
  assert.deepEqual(saved.sku.productionAuthorization, f.d.candidate.lifecycleV11.skuPackage.productionAuthorization);
});

test("verified OSS receipts plus synthetic D completion preserve one job and one E handoff without a second request mark", async () => {
  const f = await fixture(); await f.runtime().run(f.runArgs);
  const source = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
  f.d.input.adapterCapabilities.assetTransport = clone(source.state.assetTransport);
  const outcome = await runPersistedDExecution({ ...f.d.input, expectedCandidateRevision: source.candidate.dataRevision,
    productionPlan: source.state.intent.productionPlan, createAdapter: createSyntheticDCompletionAdapter });
  assert.equal(outcome.status, "succeeded");
  const saved = await f.repository.readSnapshot(), d = saved.runtime.softwareJobs.find(job => job.jobId === f.d.job.jobId);
  assert.equal(d.status, "completed"); assert.equal(d.revision, f.d.job.revision); assert.equal(d.attempt, 1);
  assert.equal(d.externalRequestRef, source.job.externalRequestRef);
  assert.equal(saved.runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback").length, 1);
  assert.equal(f.counts().uploads, 1); assert.equal(f.puts.length, 2); assert.equal(f.d.calls.length, 0); assertPublished(saved);
});

test("concurrency and JSON restart return the stored intent or receipt and never resume an upload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saved-oss-job-"));
  try {
    const filePath = path.join(directory, "state.json"), f = await fixture({ filePath });
    let release, announce;
    const pending = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { announce = resolve; });
    const runtime = f.runtime({ upload: f.upload({ onStart: async () => { announce(); await pending; } }) });
    const first = runtime.run(f.runArgs);
    await Promise.race([entered, first.then(() => { throw new Error("Upload never entered its injected boundary"); })]);
    try {
      assert.equal((await runtime.run(f.runArgs)).status, "idempotent_replay");
      const repository = createJsonBusinessStateRepository({ filePath });
      const restarted = f.runtime({ repository });
      const args = { ...f.runArgs, softwareJobContext: { ...f.runArgs.softwareJobContext, jobStore: f.createStore(repository) } };
      assert.equal((await restarted.run(args)).status, "idempotent_replay");
      release(); assert.equal((await first).status, "verified");
      f.d.advance(60_001); f.configuration.serviceConfigurationVersion = "service-config:later";
      const bytes = await fs.readFile(filePath, "utf8");
      assert.equal((await restarted.run(args)).status, "idempotent_replay");
      assert.equal(await fs.readFile(filePath, "utf8"), bytes); assert.equal(f.counts().uploads, 1); assert.equal(f.puts.length, 2);
    } finally { release(); await first; }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("closed input and exact registered holder are required; new owner confirmation and old v1 handoff cannot bypass saved work", async () => {
  const f = await fixture(), before = await f.repository.readSnapshot(), runtime = f.runtime();
  for (const [alter, expected] of [
    [args => { args.input.ownerDecision = { confirmed: true }; }, /SOFTWARE_INPUT_INVALID/],
    [args => { args.softwareJobContext.extra = true; }, /SOFTWARE_JOB_CONTEXT_INVALID/],
    [args => { delete args.softwareJobContext; }, /SOFTWARE_JOB_CONTEXT_INVALID/],
    [args => { args.actor = f.d.owner.args.actor; }, /REGISTERED_WORKER_REQUIRED/],
    [args => { args.softwareJobContext.workerId = "worker:other"; }, /REGISTERED_WORKER_REQUIRED/],
    [args => { args.softwareJobContext.leaseId = "lease:other"; }, /SOFTWARE_JOB_LEASE_REJECTED/],
    [args => { args.input.expectedCandidateRevision += 1; }, /OSS_D_REVISION_CONFLICT/]
  ]) {
    const args = { ...f.runArgs, input: clone(f.runArgs.input), softwareJobContext: { ...f.runArgs.softwareJobContext } }; alter(args);
    await assert.rejects(() => runtime.run(args), expected); assert.deepEqual(await f.repository.readSnapshot(), before);
  }
  const candidate = before.candidates[0], pa = candidate.lifecycleV11.skuPackage.productionAuthorization;
  const oldOwnerInput = { confirmed: true, confirmedBy: "owner", authorizationId: pa.authorizationId, skuPackageId: pa.lockedScope.skuPackageId,
    finalUploadAssetIds: pa.lockedScope.finalUploads.map(asset => asset.assetId) };
  assert.throws(() => createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision,
    ownerDecision: oldOwnerInput, startedAt: f.d.input.serverClock() }), /SOFTWARE_JOB_REFERENCE_REQUIRED/);
  const legacy = authorizedProductionFixture(), oldRepository = createMemoryBusinessStateRepository({ candidates: [{
    id: legacy.candidateId, dataRevision: legacy.candidateRevision, lifecycleV11: { skuPackage: legacy.skuPackage } }] });
  await assert.rejects(() => f.runtime({ repository: oldRepository }).run({ ...f.runArgs,
    input: { candidateId: legacy.candidateId, expectedCandidateRevision: legacy.candidateRevision } }), /SAVED_HANDOFF_REQUIRED/);
  assert.deepEqual(f.counts(), { uploads: 0, configurationReads: 0 });
});

test("current source, lease, registry and full configuration are checked before the first intent and any upload", async () => {
  for (const change of [f => f.d.advance(60_001), f => f.d.registry.markOffline(f.d.worker.workerId),
    f => f.d.changeServiceVersion(), f => { f.d.currentProductionBinding.warehouseId = "10002"; }]) {
    const f = await fixture(); change(f); const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.runtime().run(f.runArgs), /SOFTWARE_JOB_LEASE_REJECTED|WORKER_REGISTRY_WORKER_NOT_CURRENT|SOFTWARE_JOB_ADMISSION_DE_|PRODUCTION_EXECUTION_BINDING_DRIFT/);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 0); assert.equal(f.puts.length, 0);
  }
});

test("an awaited first write gate saves a precise known block with zero puts and preserves the job's not_sent fact", async () => {
  const f = await fixture();
  const result = await f.runtime({ upload: f.upload({ onStart: async () => { await Promise.resolve(); f.d.changeServiceVersion(); } }) }).run(f.runArgs);
  assert.equal(result.status, "failed"); assert.equal(f.puts.length, 0);
  const saved = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
  assert.equal(saved.state.intent.failureLayer, "production_admission"); assert.equal(saved.state.intent.failureCode, "SOFTWARE_JOB_ADMISSION_DE_BINDING_CHANGED");
  assert.equal(saved.state.intent.externalRequestState, "not_attempted"); assert.equal(saved.state.intent.ossWrites, 0);
  assert.equal(saved.job.status, "failed"); assert.equal(saved.job.externalRequestState, "not_sent"); assert.equal(saved.job.externalRequestRef, null);
  assert.equal(saved.candidate.dataRevision, f.d.job.revision + 2); assertPublished(await f.repository.readSnapshot());
  const before = await f.repository.readSnapshot(); assert.equal((await f.runtime().run(f.runArgs)).status, "idempotent_replay");
  assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 1);
});

test("between assets the current gate prevents another put, preserves unknown and never starts D automatically", async () => {
  const f = await fixture();
  const result = await f.runtime({ upload: f.upload({ onPut: async () => { f.d.changeServiceVersion(); } }) }).run(f.runArgs);
  assert.equal(result.status, "unknown_outcome"); assert.equal(f.puts.length, 1);
  const saved = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
  assert.equal(saved.state.intent.failureCode, "SOFTWARE_JOB_ADMISSION_DE_BINDING_CHANGED"); assert.equal(saved.state.intent.ossWrites, "unknown");
  assert.equal(saved.job.status, "unknown_outcome"); assert.equal(saved.job.externalRequestState, "unknown_outcome");
  assert.equal(Object.hasOwn(saved.sku, "dSoftwareExecution"), false); assert.equal(saved.sku.productionRecord, null);
  const before = await f.repository.readSnapshot(); assert.equal((await f.runtime().run(f.runArgs)).status, "idempotent_replay");
  assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 1); assertPublished(before);
});

test("actual late receipts survive lease expiry and concurrent source changes, while changed source cannot continue D", async () => {
  for (const [blocked, change] of [
    [false, async f => f.d.advance(60_001)],
    [true, async f => f.repository.transact(document => { document.candidates[0].dataRevision += 1; document.candidates[0].notes = "素材上传期间的新备注";
      return { changed: true, document }; })]
  ]) {
    const f = await fixture();
    const result = await f.runtime({ upload: f.upload({ onPut: async asset => { if (asset.order === 2) await change(f); } }) }).run(f.runArgs);
    assert.equal(result.status, "verified"); assert.equal(f.puts.length, 2);
    const saved = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
    assert.equal(saved.state.continuationBlocked, blocked); assert.equal(saved.state.assetTransport.resolvedAssets.length, 2);
    assert.equal(saved.job.status, blocked ? "failed" : "waiting_platform"); assert.equal(saved.job.revision, f.d.job.revision);
    if (blocked) assert.equal(saved.job.externalRequestState, "succeeded");
    assert.equal(Object.hasOwn(saved.sku, "dSoftwareExecution"), false); assertPublished(await f.repository.readSnapshot());
    const before = await f.repository.readSnapshot(); assert.equal((await f.runtime().run(f.runArgs)).status, "idempotent_replay");
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 1);
  }
});

test("restart reconciliation keeps unknown job unchanged while a late JSON receipt is saved and blocked", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saved-oss-late-"));
  try {
    const filePath = path.join(directory, "state.json"), f = await fixture({ filePath }); let reconciledJob;
    const result = await f.runtime({ upload: f.upload({ onPut: async asset => {
      if (asset.order !== 2) return;
      f.d.advance(60_001);
      const repository = createJsonBusinessStateRepository({ filePath });
      await f.createStore(repository).reconcileAfterRestart(); reconciledJob = stateOf(await repository.readSnapshot(), f.d.job.jobId).job;
      assert.equal(reconciledJob.status, "unknown_outcome");
    } }) }).run(f.runArgs);
    assert.equal(result.status, "verified");
    const bytes = await fs.readFile(filePath, "utf8");
    const repository = createJsonBusinessStateRepository({ filePath }), restored = await repository.readSnapshot();
    const saved = stateOf(restored, f.d.job.jobId);
    assert.deepEqual(saved.job, reconciledJob); assert.equal(saved.state.intent.ossWrites, 2);
    assert.equal(saved.state.continuationBlocked, true); assert.equal(saved.state.blockReason, "software_job_reconciliation_required");
    assert.equal(saved.state.assetTransport.resolvedAssets.length, 2); assert.equal(Object.hasOwn(saved.sku, "dSoftwareExecution"), false); assertPublished(restored);
    const replay = await f.runtime({ repository }).run({ ...f.runArgs, softwareJobContext: { ...f.runArgs.softwareJobContext, jobStore: f.createStore(repository) } });
    assert.equal(replay.status, "idempotent_replay"); assert.equal(await fs.readFile(filePath, "utf8"), bytes); assert.equal(f.counts().uploads, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("late asset receipts cannot treat inconsistent current SKU identity fields as permission to continue D", async () => {
  for (const [field, replacement] of [["supplierSkuId", "supplier-sku:changed"], ["targetPlatform", "wb"], ["targetStore", "store:changed"]]) {
    const f = await fixture();
    const result = await f.runtime({ upload: f.upload({ onPut: async asset => {
      if (asset.order !== 2) return;
      // Simulate a corrupt current duplicate identity while the original frozen PA/G1 remains intact.
      await f.repository.transact(document => {
        document.candidates[0].lifecycleV11.skuPackage[field] = replacement;
        return { changed: true, document };
      });
    } }) }).run(f.runArgs);
    assert.equal(result.status, "verified"); assert.equal(f.puts.length, 2);
    const saved = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
    assert.equal(saved.sku[field], replacement); assert.equal(saved.state.continuationBlocked, true);
    assert.equal(saved.state.assetTransport.resolvedAssets.length, 2);
    assert.equal(saved.job.status, "failed"); assert.equal(saved.job.externalRequestState, "succeeded");
    assert.equal(saved.job.failureClass, "d-assets-source-conflict"); assert.equal(Object.hasOwn(saved.sku, "dSoftwareExecution"), false);
    assert.equal(validateJob(saved.job), true, JSON.stringify(validateJob.errors));
    assert.deepEqual(saved.sku.productionAuthorization, f.d.candidate.lifecycleV11.skuPackage.productionAuthorization);
    const before = await f.repository.readSnapshot();
    assert.equal((await f.runtime().run(f.runArgs)).status, "idempotent_replay");
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 1);
  }
});

test("unknown callback/storage errors propagate unchanged; known upload failure is recorded and replay never retries", async () => {
  for (const failAt of [1, 2, 4]) {
    const f = await fixture(), unexpected = new TypeError("synthetic storage implementation failure"); let transactions = 0;
    const repository = { ...f.repository, transact: mutator => {
      if (++transactions === failAt) return Promise.reject(unexpected);
      return f.repository.transact(mutator);
    } };
    await assert.rejects(() => f.runtime({ repository }).run(f.runArgs), error => error === unexpected);
    const before = await f.repository.readSnapshot(), saved = stateOf(before, f.d.job.jobId);
    assert.equal(f.puts.length, failAt === 4 ? 2 : 0); assert.equal(saved.job.status, failAt === 4 ? "waiting_platform" : "claimed");
    if (failAt !== 1) {
      assert.equal(saved.state.status, "in_flight"); assert.equal((await f.runtime().run(f.runArgs)).status, "idempotent_replay");
      assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 1);
    }
  }
  const f = await fixture();
  const result = await f.runtime({ upload: f.upload({ onPut: async () => { throw new Error("OSS_PUBLIC_READBACK_FAILED: synthetic unavailable body"); } }) }).run(f.runArgs);
  assert.equal(result.status, "unknown_outcome"); assert.equal(f.puts.length, 1);
  const before = await f.repository.readSnapshot(); assert.equal(stateOf(before, f.d.job.jobId).job.status, "unknown_outcome");
  assert.equal((await f.runtime().run(f.runArgs)).status, "idempotent_replay"); assert.equal(f.counts().uploads, 1);
  assert.equal(JSON.stringify(before).includes("synthetic unavailable body"), false); assertPublished(before);
});

test("a callback programming error cannot impersonate a known gate code or permit a second upload", async () => {
  const f = await fixture(), unexpected = new TypeError("SOFTWARE_JOB_LEASE_REJECTED"); let checks = 0;
  const jobStore = { ...f.jobStore, assertDEExecutionInDocument(input) {
    if (++checks === 2) throw unexpected;
    return f.jobStore.assertDEExecutionInDocument(input);
  } };
  const args = { ...f.runArgs, softwareJobContext: { ...f.runArgs.softwareJobContext, jobStore } };
  await assert.rejects(() => f.runtime().run(args), error => error === unexpected);
  const before = await f.repository.readSnapshot(), saved = stateOf(before, f.d.job.jobId);
  assert.equal(saved.state.status, "in_flight"); assert.equal(saved.job.status, "claimed"); assert.equal(saved.job.externalRequestState, "not_sent");
  assert.equal(f.puts.length, 0); assert.equal((await f.runtime().run(args)).status, "idempotent_replay");
  assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.counts().uploads, 1);
});

test("saved low-level execution cannot omit its exact job ref or async gate, and a malformed upload result is not a normal failure", async () => {
  const f = await fixture();
  const repository = { ...f.repository, transact: async mutator => {
    const result = await f.repository.transact(mutator);
    if (result.status === "admitted") throw new TypeError("synthetic stop after intent");
    return result;
  } };
  await assert.rejects(() => f.runtime({ repository }).run(f.runArgs), /synthetic stop after intent/);
  const { candidate, state } = stateOf(await f.repository.readSnapshot(), f.d.job.jobId);
  const args = { candidate, persistedIntent: state.intent, serverClock: f.d.input.serverClock, upload: f.upload() };
  await assert.rejects(() => executeAliyunOssAssetIntent(args), /SOFTWARE_JOB_REFERENCE_REQUIRED/);
  await assert.rejects(() => executeAliyunOssAssetIntent({ ...args, softwareJobRef: state.softwareJobRef }), /SOFTWARE_JOB_WRITE_GATE_REQUIRED/);
  assert.equal(f.counts().uploads, 0);
  const g = await fixture();
  await assert.rejects(() => g.runtime({ upload: async () => ({ status: "verified" }) }).run(g.runArgs), /OSS_D_UPLOAD_GATE_NOT_OBSERVED/);
  const saved = stateOf(await g.repository.readSnapshot(), g.d.job.jobId);
  assert.equal(saved.state.status, "in_flight"); assert.equal(saved.job.status, "claimed"); assert.equal(saved.job.externalRequestState, "not_sent");
});
