import { productionAuthorizationInputFixture } from "./helpers/c2-software-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CENTRAL_PERSISTENCE_ERROR,
  assertBusinessStateRepositoryBoundary,
  assertCentralPersistenceBoundary,
  createConfiguredBusinessStateRepository,
  createJsonBusinessStateRepository,
  createMemoryBusinessStateRepository,
  initialBusinessStateDocument
} from "../lib/business-state-repository.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";

const AUTH_TIME = "2026-08-22T07:00:00.000Z";

async function countSourceParses(source, run) {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = function (text, ...args) {
    if (text === source) count += 1;
    return parse.call(this, text, ...args);
  };
  try { await run(() => count); }
  finally { JSON.parse = parse; }
}

test("JSON snapshot reuse still reads the file and never shares mutable DTOs", async () => {
  const source = JSON.stringify({ candidates: [{ id: "cache-test", nested: { value: 1 } }],
    runtime: { idempotencyRecords: [{ result: { nested: { value: 2 } } }] } });
  let reads = 0;
  const repository = createJsonBusinessStateRepository({ filePath: "synthetic-state.json",
    fileSystem: { async readFile() { reads += 1; return source; } } });
  await countSourceParses(source, async parsed => {
    const first = await repository.readSnapshot();
    first.candidates[0].nested.value = 99;
    first.runtime.idempotencyRecords[0].result.nested.value = 99;
    const second = await repository.readSnapshot();
    assert.equal(second.candidates[0].nested.value, 1);
    assert.equal(second.runtime.idempotencyRecords[0].result.nested.value, 2);
    second.candidates[0].nested.value = 88;
    assert.equal((await repository.readSnapshot()).candidates[0].nested.value, 1);
    assert.equal(reads, 3);
    assert.equal(parsed(), 1);
  });
});

test("warm JSON snapshots observe atomic replacement and reject damaged or missing sources", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "snapshot-cache-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  const source = JSON.stringify({ candidates: [{ id: "fresh-file", dataRevision: 1 }] });
  await writeFile(filePath, source);
  const repository = createJsonBusinessStateRepository({ filePath });
  await repository.readSnapshot();
  await repository.readSnapshot();
  const replacement = `${filePath}.replacement`;
  await writeFile(replacement, source.replace('"dataRevision":1', '"dataRevision":2'));
  await rename(replacement, filePath);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
  await writeFile(filePath, "{");
  await assert.rejects(repository.readSnapshot(), SyntaxError);
  await writeFile(filePath, JSON.stringify({ candidates: [], productionEntityRecords: [{}] }));
  await assert.rejects(repository.readSnapshot(), /PRODUCTION_ENTITY_SHAPE_INVALID/);
  await rm(filePath);
  await assert.rejects(repository.readSnapshot(), error => error.code === "ENOENT");
  await writeFile(filePath, source);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 1);
});

test("snapshot reuse cannot publish no-op mutations, failed writes or failed transactions", async () => {
  let source = JSON.stringify({ candidates: [{ id: "transaction-cache", dataRevision: 1 }] });
  let rejectWrite = true;
  const repository = createJsonBusinessStateRepository({ filePath: "synthetic-state.json",
    fileSystem: { async readFile() { return source; } },
    atomicWriter: async (_file, document) => {
      if (rejectWrite) throw new Error("SYNTHETIC_ATOMIC_WRITE_FAILED");
      source = JSON.stringify(document);
    } });
  await repository.readSnapshot();
  await repository.transact(document => {
    document.candidates[0].dataRevision = 2;
    return { changed: false, result: "not_saved" };
  });
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 1);
  await assert.rejects(repository.transact(() => { throw new Error("SYNTHETIC_MUTATOR_FAILED"); }), /SYNTHETIC_MUTATOR_FAILED/);
  await assert.rejects(repository.transact(document => {
    document.candidates[0].dataRevision = 2;
    return { changed: true, document, result: "save" };
  }), /SYNTHETIC_ATOMIC_WRITE_FAILED/);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 1);
  rejectWrite = false;
  await repository.transact(document => {
    document.candidates[0].dataRevision = 2;
    return { changed: true, document, result: "saved" };
  });
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
});

test("a delayed read across a write keeps snapshots isolated and observes the next file read", async () => {
  let source = JSON.stringify({ candidates: [{ id: "delayed-cache", dataRevision: 1 }] });
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const repository = createJsonBusinessStateRepository({ filePath: "synthetic-state.json",
    fileSystem: { async readFile() {
      const captured = source;
      if (++reads === 1) await gate;
      return captured;
    } }, atomicWriter: async (_file, document) => { source = JSON.stringify(document); } });
  const delayed = repository.readSnapshot();
  await repository.transact(document => {
    document.candidates[0].dataRevision = 2;
    return { changed: true, document, result: "saved" };
  });
  release();
  const old = await delayed;
  assert.equal(old.candidates[0].dataRevision, 1);
  old.candidates[0].dataRevision = 99;
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
  assert.equal(reads, 3);
});

test("oversized snapshot input remains readable without being retained for reuse", async () => {
  const source = JSON.stringify({ candidates: [], evidence: "x".repeat(32 * 1024 * 1024) });
  const repository = createJsonBusinessStateRepository({ filePath: "synthetic-state.json",
    fileSystem: { async readFile() { return source; } } });
  await countSourceParses(source, async parsed => {
    assert.equal((await repository.readSnapshot()).evidence.length, 32 * 1024 * 1024);
    assert.equal((await repository.readSnapshot()).evidence.length, 32 * 1024 * 1024);
    assert.equal(parsed(), 2);
  });
});

test("missing initial documents and read failures cannot return a cached successful snapshot", async () => {
  let initialRevision = 0, failure = "ENOENT";
  const repository = createJsonBusinessStateRepository({ filePath: "synthetic-state.json", initializeIfMissing: true,
    initialDocument: () => ({ candidates: [{ id: "initial-cache", dataRevision: ++initialRevision }] }),
    fileSystem: { async readFile() { throw Object.assign(new Error("SYNTHETIC_READ_FAILED"), { code: failure }); } } });
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 1);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
  failure = "EIO";
  await assert.rejects(repository.readSnapshot(), error => error.code === "EIO");
});

function authorizationFixture() {
  const source = productionAuthorizationInputFixture();
  const skuPackage = structuredClone(source.skuPackage);
  // Keep the shared producer's exact B input bundle and matching evidence; the repository test must reach the write boundary.
  const candidate = { ...structuredClone(source.candidate),
    lifecycleV11: { ...structuredClone(source.candidate.lifecycleV11), status: "c2_ready", platformWrites: 0, skuPackage },
    updatedAt: source.authorizedAt, lastModifiedBy: "owner" };
  const card = skuPackage.productionConfirmationCard;
  const preparation = skuPackage.c2FinalAssets.productionAuthorizationPreparation;
  const input = { contractVersion: "production-authorization-v1.2", dataRevision: candidate.dataRevision, skuRevision: skuPackage.dataRevision,
    cardId: card.cardId, cardRevision: card.cardRevision, sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint, bindingId: source.commercialDecision.executionBinding.bindingId, configurationVersion: source.commercialDecision.executionBinding.configurationVersion,
    merchantSku: source.commercialDecision.merchantSku, confirmExactScope: true };
  return { candidate, evidencePacks: structuredClone(source.evidencePacks), currentCommissionCatalogs: structuredClone(source.currentCommissionCatalogs), commercialDecision: structuredClone(source.commercialDecision), actor: source.ownerActor, preparation, input };
}

function authorizationArgs(fixture, repository) {
  return { repository, runtimeMode: "local_development", actor: fixture.actor, candidateId: fixture.candidate.id, input: fixture.input,
    resolveProductionAuthorizationDecision: () => structuredClone(fixture.commercialDecision), serverClock: () => AUTH_TIME };
}

async function repositoryContract(repository) {
  const initial = await repository.readSnapshot();
  assert.equal(initial.candidates[0].dataRevision, 1);
  const result = await repository.transact(async (document) => {
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: "saved" };
  });
  assert.equal(result, "saved");
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
  await repository.transact(async () => ({ changed: false, result: "unchanged" }));
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
}

test("JSON与内存适配器遵守相同Repository契约，但不冒充中央多人存储", async () => {
  await repositoryContract(createMemoryBusinessStateRepository({ candidates: [{ id: "C-1", dataRevision: 1 }] }));

  const directory = await mkdtemp(path.join(os.tmpdir(), "central-state-repository-"));
  const filePath = path.join(directory, "candidates.json");
  await writeFile(filePath, JSON.stringify({ candidates: [{ id: "C-1", dataRevision: 1 }] }), "utf8");
  try {
    const repository = createJsonBusinessStateRepository({ filePath });
    await repositoryContract(repository);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).candidates[0].dataRevision, 2);
    assert.deepEqual(assertBusinessStateRepositoryBoundary(repository), {
      status: "business_state_repository_boundary_present",
      adapter: "json",
      concurrencyScope: "single_process",
      multiUserReady: false
    });
    assert.throws(() => assertCentralPersistenceBoundary(repository), new RegExp(CENTRAL_PERSISTENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSON适配器只在显式允许时初始化缺失文件，坏JSON必须失败", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "central-state-init-"));
  const missingPath = path.join(directory, "missing", "candidates.json");
  try {
    await assert.rejects(
      createJsonBusinessStateRepository({ filePath: missingPath }).readSnapshot(),
      /ENOENT/
    );

    const repository = createJsonBusinessStateRepository({
      filePath: missingPath,
      initializeIfMissing: true,
      initialDocument: () => initialBusinessStateDocument({ now: AUTH_TIME, title: "test state" })
    });
    const initial = await repository.readSnapshot();
    assert.deepEqual(initial.candidates, []);
    assert.equal(initial.meta.version, 2);
    assert.equal(initial.meta.title, "test state");
    await repository.transact(async (document) => {
      document.candidates.push({ id: "C-NEW", dataRevision: 1 });
      return { changed: true, document, result: "created" };
    });
    const persisted = JSON.parse(await readFile(missingPath, "utf8"));
    assert.equal(persisted.candidates[0].id, "C-NEW");

    const badJsonPath = path.join(directory, "bad.json");
    await writeFile(badJsonPath, "{not-json", "utf8");
    await assert.rejects(
      createJsonBusinessStateRepository({
        filePath: badJsonPath,
        initializeIfMissing: true
      }).readSnapshot(),
      /JSON/
    );
    assert.equal(await readFile(badJsonPath, "utf8"), "{not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("运行配置仓库默认不初始化缺失数据文件，只有显式开关才创建", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "central-state-config-init-"));
  const filePath = path.join(directory, "state", "candidates.json");
  const baseConfig = {
    schemaVersion: "selection-review-runtime-configuration-v1",
    stateAdapter: "json",
    dataFile: filePath
  };
  try {
    await assert.rejects(
      createConfiguredBusinessStateRepository({ ...baseConfig, initializeDataFile: false }).readSnapshot(),
      /ENOENT/
    );

    const repository = createConfiguredBusinessStateRepository({ ...baseConfig, initializeDataFile: true });
    await repository.transact(async (document) => {
      document.candidates.push({ id: "C-CONFIG", dataRevision: 1 });
      return { changed: true, document, result: "initialized" };
    });
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.candidates[0].id, "C-CONFIG");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("事务失败不留下半套业务状态，缺少Repository边界明确失败", async () => {
  const repository = createMemoryBusinessStateRepository({ candidates: [{ id: "C-1", dataRevision: 1 }], audit: [] });
  await assert.rejects(repository.transact(async (document) => {
    document.candidates[0].dataRevision = 2;
    document.audit.push({ eventId: "partial" });
    throw new Error("simulated_failure");
  }), /simulated_failure/);
  assert.deepEqual(await repository.readSnapshot(), { candidates: [{ id: "C-1", dataRevision: 1 }], audit: [] });
  assert.throws(() => assertCentralPersistenceBoundary({ readSnapshot() {} }), new RegExp(CENTRAL_PERSISTENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("一次主人确认在同一Repository事务保存准确决定、唯一授权和唯一D handoff", async () => {
  const fixture = authorizationFixture(); const { candidate, commercialDecision, preparation } = fixture;
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate], evidencePacks: fixture.evidencePacks, currentCommissionCatalogs: fixture.currentCommissionCatalogs, runtime: { operationAudit: [], idempotencyRecords: [] }, dispatches: [] });
  const args = authorizationArgs(fixture, repository);
  const first = await commitSingleOwnerProductionAuthorization(args);
  assert.equal(first.status, "committed");
  const stored = await repository.readSnapshot(); const nextCandidate = stored.candidates[0]; const nextSku = nextCandidate.lifecycleV11.skuPackage;
  assert.equal(nextCandidate.dataRevision, candidate.dataRevision + 1);
  assert.equal(nextSku.dataRevision, candidate.lifecycleV11.skuPackage.dataRevision + 1);
  assert.deepEqual(nextSku.c2FinalAssets.productionAuthorizationPreparation, preparation);
  assert.equal(nextSku.productionAuthorization.authorizationId, nextSku.dHandoff.productionAuthorizationId);
  assert.equal(nextSku.productionAuthorization.identity.merchantSku, commercialDecision.merchantSku);
  assert.deepEqual(nextSku.productionAuthorization.identity.storeRef, preparation.finalCardInputSnapshot.identity.storeRef);
  assert.equal(nextSku.productionAuthorization.lockedScope.mainImageAssetId, preparation.mainImageAssetId);
  assert.deepEqual(nextSku.productionAuthorization.lockedScope.finalUploads, preparation.finalUploads);
  assert.equal(nextSku.productionConfirmationCard.ownerDecision.ownerConfirmation.actorId, fixture.actor.userId);
  assert.equal(nextSku.productionAuthorization.authorizedByActorId, fixture.actor.userId);
  for (const field of ["productionPlanCreated", "executionIntentCreated", "dWritePermissionGranted"]) assert.equal(nextSku.dHandoff[field], false);
  assert.equal(nextSku.dHandoff.schemaVersion, "c2-d-handoff-v2"); assert.equal(nextSku.dHandoff.softwareJobCreated, true);
  assert.equal(stored.runtime.softwareJobs.length, 1);
  const job = stored.runtime.softwareJobs[0];
  assert.equal(job.jobType, "d_production_execution"); assert.equal(job.candidateId, candidate.id);
  assert.equal(job.skuPackageId, nextSku.skuPackageId); assert.equal(job.revision, nextCandidate.dataRevision);
  assert.equal(job.status, "queued"); assert.equal(job.attempt, 0); assert.equal(job.externalRequestState, "not_sent");
  assert.equal(job.workerId, null); assert.equal(job.leaseId, null); assert.equal(job.resultEnvelope, null);
  assert.equal(job.scopeBinding.authorizationRef, nextSku.productionAuthorization.authorizationId);
  assert.deepEqual(nextSku.dHandoff.softwareJobRef, { jobId: job.jobId, jobType: job.jobType, candidateId: job.candidateId,
    skuPackageId: job.skuPackageId, sourceRevision: candidate.dataRevision, resultRevision: nextCandidate.dataRevision,
    inputFingerprint: job.scopeBinding.inputFingerprint });
  assert.equal(job.admissionDecision.admissionKind, "domain_handoff"); assert.equal(job.admissionDecision.phase, "enqueue_current");
  assert.equal(job.admissionDecision.jobId, job.jobId); assert.equal(job.admissionDecision.executionBindingSnapshot, null);
  assert.equal(first.result.softwareJobCreated, true); assert.equal(first.result.softwareJobRef.jobId, job.jobId);
  assert.equal(nextSku.dHandoff.externalRequests, 0); assert.equal(nextSku.dHandoff.platformWrites, 0);
  assert.equal(stored.dispatches.length, 0); assert.equal(stored.runtime.operationAudit.length, 1); assert.equal(stored.runtime.idempotencyRecords.length, 1);
  const replay = await commitSingleOwnerProductionAuthorization({ ...args, serverClock: () => "2026-08-22T07:05:00.000Z" });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.result.productionAuthorization.authorizationId, first.result.productionAuthorization.authorizationId);
  assert.deepEqual(await repository.readSnapshot(), stored);
  await assert.rejects(commitSingleOwnerProductionAuthorization({ ...args, input: { ...args.input, merchantSku: "OTHER-SKU" } }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await repository.readSnapshot(), stored);
});

test("旧revision、缺图、未确认、秘密与unknown_outcome均零授权零handoff且原子回滚", async () => {
  const cases = [
    ["old revision", f => { f.input.dataRevision -= 1; }, /REVISION_CONFLICT/],
    ["incomplete images", f => { f.candidate.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalUploads = []; }, /^Error: PRODUCTION_AUTHORIZATION_PREPARATION_DRIFT:fingerprint$/],
    ["unconfirmed owner", f => { f.input.confirmExactScope = false; }, /RECONFIRMATION_REQUIRED/],
    ["unauthorized actor", f => { f.actor = createActorContext({ userId: "reviewer-1", sessionId: "session-review", actorType: "human", roles: ["reviewer"], source: "authenticated_identity_provider", authenticatedAt: AUTH_TIME }); }, /AUTHENTICATED_IDENTITY_REQUIRED/],
    ["secret key", f => { f.commercialDecision.credentialAlias = "accessToken=secret-value"; }, /SECRET_REJECTED/],
    ["secret url", f => { f.commercialDecision.warehouseRef = "https:\/\/user:pass@example.test/warehouse"; }, /SECRET_REJECTED/],
    ["unknown outcome", f => { f.candidate.lifecycleV11.skuPackage.dAssetTransport = {
      schemaVersion: "aliyun-oss-d-asset-state-v1", status: "unknown_outcome",
      intent: { schemaVersion: "aliyun-oss-d-asset-integration-v1", status: "unknown_outcome" }, assetTransport: null, automaticRetry: false, platformWrites: 0
    }; }, /C2_DOWNSTREAM_STATE_CONFLICT/ ]
  ];
  for (const [label, mutate, expected] of cases) {
    const fixture = authorizationFixture(); mutate(fixture);
    const document = { candidates: [fixture.candidate], evidencePacks: fixture.evidencePacks, currentCommissionCatalogs: fixture.currentCommissionCatalogs, runtime: { operationAudit: [], idempotencyRecords: [] }, dispatches: [] };
    const repository = createMemoryBusinessStateRepository(document);
    await assert.rejects(commitSingleOwnerProductionAuthorization(authorizationArgs(fixture, repository)), expected, label);
    const stored = await repository.readSnapshot(); assert.deepEqual(stored, document, label);
    assert.equal(stored.candidates[0].lifecycleV11.skuPackage.productionAuthorization, null, label);
    assert.equal(stored.candidates[0].lifecycleV11.skuPackage.dHandoff ?? null, null, label);
    assert.equal(stored.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard.ownerDecision, null, label);
    assert.equal(stored.dispatches.length, 0, label);
  }
});

test("授权事务持久化失败时决定、授权、handoff、审计与幂等记录全部不落盘", async () => {
  const fixture = authorizationFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "production-authorization-rollback-")); const filePath = path.join(directory, "state.json");
  const document = { candidates: [fixture.candidate], evidencePacks: fixture.evidencePacks, currentCommissionCatalogs: fixture.currentCommissionCatalogs, runtime: { operationAudit: [], idempotencyRecords: [] }, dispatches: [] };
  await writeFile(filePath, JSON.stringify(document), "utf8");
  try {
    let replaceAttempts = 0;
    const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async () => { replaceAttempts += 1; throw new Error("simulated_atomic_replace_failure"); } });
    await assert.rejects(commitSingleOwnerProductionAuthorization(authorizationArgs(fixture, repository)), /simulated_atomic_replace_failure/);
    assert.equal(replaceAttempts, 1, "valid production inputs must reach the atomic writer before its injected failure");
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), document);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
