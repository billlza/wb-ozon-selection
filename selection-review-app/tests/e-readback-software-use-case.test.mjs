import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createActorContext, createLocalDevelopmentActor } from "../lib/runtime-identity.mjs";
import { createSystemEReadbackSoftwareRuntime, EReadbackRuntimeUnavailableError, assertEReadbackAttempt } from "../lib/e-readback-software-use-case.mjs";
import { validateSystemCreatedVerificationRecord } from "../lib/e-stage-readback.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { systemEReadbackFixture as fixture } from "./helpers/e-readback-fixture.mjs";

const at = "2026-08-22T07:30:00.000Z";
const actor = createActorContext({ userId: "synthetic-owner", sessionId: "synthetic-session-e",
  actorType: "human", source: "authenticated_identity_provider", roles: ["owner"], authenticatedAt: at });
const schemaValidator = await loadPublishedSchemaValidator();
const validateSavedAttempt = schemaValidator.getSchema("e-readback-attempt-v1");

function runtime(repository, readPlatform) {
  const checkedRepository = { ...repository, transact: mutator => repository.transact(async document => {
    const outcome = await mutator(document);
    if (outcome.changed) for (const candidate of outcome.document.candidates) {
      for (const attempt of candidate.lifecycleV11?.skuPackage?.readbackHistory ?? []) {
        if (attempt.schemaVersion !== "e-readback-attempt-v1") continue;
        assert.equal(validateSavedAttempt(attempt), true, JSON.stringify(validateSavedAttempt.errors));
        assertEReadbackAttempt(attempt);
      }
    }
    return outcome;
  }) };
  return createSystemEReadbackSoftwareRuntime({ repository: checkedRepository, runtimeMode: "local_development", serverClock: () => at, readPlatform });
}

test("E独立读取前已保存意图，并发重放不读平台；真实观察匹配后才发布验证", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  let reads = 0;
  const service = runtime(repository, async request => {
    reads += 1;
    const saved = await repository.readSnapshot();
    const attempt = saved.candidates[0].lifecycleV11.skuPackage.readbackHistory[0];
    assert.equal(attempt.status, "in_flight");
    assert.equal(attempt.externalRequestState, "in_flight");
    assert.equal(saved.candidates[0].lifecycleV11.skuPackage.eVerificationRecord, null);
    assert.equal(request.writeAllowed, false);
    assert.equal(request.mode, "independent_read_only");
    assert.deepEqual(request.storeRef, f.candidate.storeRef);
    assert.equal(request.warehouseId, f.candidate.lifecycleV11.skuPackage.productionRecord.readbackExpectation.warehouseId);
    return f.observation;
  });
  const results = await Promise.all([service.run({ actor, input: f.input }), service.run({ actor, input: f.input })]);
  assert.deepEqual(new Set(results.map(result => result.status)), new Set(["verified", "idempotent_replay"]));
  assert.equal(reads, 1);
  const saved = await repository.readSnapshot();
  const candidate = saved.candidates[0];
  const sku = candidate.lifecycleV11.skuPackage;
  assert.equal(candidate.workflowStatus, "listed");
  assert.equal(candidate.dataRevision, f.candidate.dataRevision + 1);
  assert.equal(sku.businessPhase, "E");
  assert.equal(sku.readbackHistory[0].applicationDisposition, "applied");
  assert.equal(validateSystemCreatedVerificationRecord(sku.eVerificationRecord, sku.productionRecord).valid, true);
  assert.deepEqual(sku.readbackHistory[0].result.observation, f.observation);
  assert.deepEqual(saved.candidates[1], f.untouched);
  assert.deepEqual(saved.dispatches, f.document.dispatches);
  assert.deepEqual(sku.productionRecord, f.candidate.lifecycleV11.skuPackage.productionRecord);
  assert.equal((await service.run({ actor, input: f.input })).status, "idempotent_replay");
  assert.equal(reads, 1);
});

test("未配置读取器、开发身份、额外观察字段和错店铺均在读取前拒绝", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  const before = await repository.readSnapshot();
  await assert.rejects(() => runtime(repository, null).run({ actor, input: f.input }), EReadbackRuntimeUnavailableError);
  let reads = 0;
  const service = runtime(repository, async () => { reads += 1; return f.observation; });
  await assert.rejects(() => service.run({ actor: createLocalDevelopmentActor({ userId: "synthetic-owner", at }), input: f.input }), /AUTHENTICATED_ACTOR_REQUIRED/);
  await assert.rejects(() => service.run({ actor, input: { ...f.input, observation: f.observation } }), /INPUT_INVALID/);
  await assert.rejects(() => service.run({ actor, input: { ...f.input, expectedCandidateRevision: f.input.expectedCandidateRevision + 1 } }), /REVISION_CONFLICT/);
  assert.deepEqual(await repository.readSnapshot(), before);
  const wrong = structuredClone(f.document);
  wrong.candidates[0].storeRef.platformStoreId = "another-store";
  const wrongRepository = createMemoryBusinessStateRepository(wrong);
  await assert.rejects(() => runtime(wrongRepository, async () => { reads += 1; }).run({ actor, input: f.input }), /SOURCE_SCOPE_CONFLICT/);
  assert.deepEqual(await wrongRepository.readSnapshot(), wrong);
  assert.equal(reads, 0);
});

test("同数异图、错误仓库与平台审核未完成均保存真实缺口，不能标为上架", async () => {
  const f = await fixture();
  for (const alter of [
    observation => { observation.mediaObservation.images[0] = "https://assets.example.com/another.jpg"; },
    observation => { observation.inventoryObservation.rows[0].warehouseId = "80001"; },
    observation => { observation.moderationStatus = "in_moderation"; observation.saleStatus = "not_for_sale"; }
  ]) {
    const repository = createMemoryBusinessStateRepository(f.document);
    const observation = structuredClone(f.observation);
    alter(observation);
    const result = await runtime(repository, async () => observation).run({ actor, input: f.input });
    const sku = result.candidate.lifecycleV11.skuPackage;
    assert.equal(result.status, "not_verified");
    assert.equal(sku.eVerificationRecord, null);
    assert.equal(result.attempt.externalRequestState, "succeeded");
    assert.ok(result.attempt.result.gaps.length > 0);
    assert.deepEqual(result.attempt.result.observation, observation);
    assert.notEqual(result.candidate.workflowStatus, "listed");
  }
});

test("读取错误保存未知，错误消息不进入记录；重启后的同一来源不再查询", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  let reads = 0;
  const result = await runtime(repository, async () => { reads += 1; throw new Error("untrusted-provider-detail"); }).run({ actor, input: f.input });
  assert.equal(result.status, "unknown_outcome");
  assert.equal(result.attempt.externalRequestState, "unknown_outcome");
  assert.equal(result.attempt.result.eVerificationRecord, null);
  const saved = await repository.readSnapshot();
  assert.equal(JSON.stringify(saved).includes("untrusted-provider-detail"), false);
  const restarted = runtime(repository, async () => { reads += 1; return f.observation; });
  assert.equal((await restarted.run({ actor, input: f.input })).status, "idempotent_replay");
  assert.equal(reads, 1);
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test("回读期间仅备注变化可应用；源记录变化保留已取得观察但不应用", async () => {
  const f = await fixture();
  for (const sourceChanged of [false, true]) {
    const repository = createMemoryBusinessStateRepository(f.document);
    const result = await runtime(repository, async () => {
      await repository.transact(document => {
        document.candidates[0].notes = "主人刚保存的备注";
        document.candidates[0].dataRevision += 1;
        if (sourceChanged) document.candidates[0].lifecycleV11.skuPackage.productionRecord.platformProductId = "910002";
        return { changed: true, document, result: null };
      });
      return f.observation;
    }).run({ actor, input: f.input });
    assert.equal(result.candidate.notes, "主人刚保存的备注");
    assert.deepEqual(result.attempt.result.observation, f.observation);
    assert.equal(result.attempt.applicationDisposition, sourceChanged ? "source_conflict_not_applied" : "applied");
    assert.equal(result.status, sourceChanged ? "not_applied" : "verified");
    assert.equal(result.candidate.lifecycleV11.skuPackage.eVerificationRecord === null, sourceChanged);
  }
});

test("意图落盘失败零查询，终态落盘失败保留in_flight且不重复发请求", async () => {
  const f = await fixture();
  for (const failAt of [1, 3]) {
    const repository = createMemoryBusinessStateRepository(f.document);
    let transactions = 0;
    let reads = 0;
    const failingRepository = { ...repository, transact: async mutator => {
      transactions += 1;
      if (transactions === failAt) throw new Error("E_TEST_PERSISTENCE_FAILED");
      return repository.transact(mutator);
    } };
    const service = runtime(failingRepository, async () => { reads += 1; return f.observation; });
    await assert.rejects(() => service.run({ actor, input: f.input }), /E_TEST_PERSISTENCE_FAILED/);
    assert.equal(reads, failAt === 1 ? 0 : 1);
    const saved = await repository.readSnapshot();
    assert.equal(saved.candidates[0].lifecycleV11.skuPackage.eVerificationRecord, null);
    if (failAt === 1) assert.deepEqual(saved, f.document);
    else {
      assert.equal(service.view(saved.candidates[0]).status, "unknown_outcome");
      assert.equal(service.view(saved.candidates[0]).live, false);
      const restarted = runtime(repository, async () => { reads += 1; return f.observation; });
      assert.equal((await restarted.run({ actor, input: f.input })).status, "idempotent_replay");
      assert.equal(reads, 1);
    }
  }
});

test("JSON保存及重新构造服务回读同一E验证，历史记录与其他商品逐字节保留", async () => {
  const f = await fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "e-readback-test-"));
  try {
    const filePath = path.join(directory, "state.json");
    f.document.candidates[0].lifecycleV11.skuPackage.readbackHistory.push({ legacy: "read-only-history" });
    await fs.writeFile(filePath, JSON.stringify(f.document));
    const repository = createJsonBusinessStateRepository({ filePath });
    let reads = 0;
    await runtime(repository, async () => { reads += 1; return f.observation; }).run({ actor, input: f.input });
    const bytes = await fs.readFile(filePath, "utf8");
    const restartedRepository = createJsonBusinessStateRepository({ filePath });
    const result = await runtime(restartedRepository, async () => { reads += 1; return f.observation; }).run({ actor, input: f.input });
    assert.equal(result.status, "idempotent_replay");
    assert.equal(result.attempt.applicationDisposition, "applied");
    assert.equal(reads, 1);
    assert.equal(await fs.readFile(filePath, "utf8"), bytes);
    assert.deepEqual(result.candidate.lifecycleV11.skuPackage.readbackHistory[0], { legacy: "read-only-history" });
    assert.deepEqual(JSON.parse(bytes).candidates[1], f.untouched);
    assert.equal(validateSystemCreatedVerificationRecord(result.candidate.lifecycleV11.skuPackage.eVerificationRecord,
      result.candidate.lifecycleV11.skuPackage.productionRecord).valid, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("读取超时取消底层查询并保存未知，不采用迟到结果或自动再查询", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  let reads = 0;
  let aborted = false;
  let resolveRead;
  const service = createSystemEReadbackSoftwareRuntime({ repository, runtimeMode: "local_development", serverClock: () => at,
    maxReadDurationMs: 20, readPlatform: async (_request, { signal }) => {
      reads += 1;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise(resolve => { resolveRead = resolve; });
    } });
  const result = await service.run({ actor, input: f.input });
  assert.equal(result.status, "unknown_outcome");
  assert.equal(aborted, true);
  const saved = await repository.readSnapshot();
  resolveRead(f.observation);
  await Promise.resolve();
  assert.deepEqual(await repository.readSnapshot(), saved);
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.eVerificationRecord, null);
  await service.run({ actor, input: f.input });
  assert.equal(reads, 1);
});

test("已保存记录格式错误不能被作为有效重放或成功读取", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  await runtime(repository, async () => f.observation).run({ actor, input: f.input });
  const valid = await repository.readSnapshot();
  for (const alter of [
    attempt => { attempt.extra = true; },
    attempt => { attempt.applicationDisposition = "pending"; },
    attempt => { attempt.result.sourceProductionRecordId = "another-record"; },
    attempt => { attempt.result.eVerificationRecord = null; },
    attempt => { attempt.result.gaps = ["missing_evidence"]; },
    attempt => { attempt.result.outcome = null; },
    attempt => { attempt.result.verifiedAt = "2026-08-22T07:00:00.000Z"; },
    attempt => { attempt.result.observation.mediaObservation.images = []; },
    attempt => { attempt.candidateId = "another-candidate"; }
  ]) {
    const document = structuredClone(valid);
    alter(document.candidates[0].lifecycleV11.skuPackage.readbackHistory[0]);
    let reads = 0;
    const corrupted = createMemoryBusinessStateRepository(document);
    await assert.rejects(() => runtime(corrupted, async () => { reads += 1; return f.observation; }).run({ actor, input: f.input }), /E_READBACK_ATTEMPT_INVALID|E_READBACK_ATTEMPT_SCOPE_CONFLICT|E_READBACK_RESULT_INVALID/);
    assert.deepEqual(await corrupted.readSnapshot(), document);
    assert.equal(reads, 0);
  }
});

test("E逐项复用完整G1合同，缺版本、额外字段及跨SKU全部零读取", async t => {
  const f = await fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "e-invalid-g1-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [alter, expectedError, rejectAtStorageRead] of [
    [identity => { delete identity.schemaVersion; }, error =>
      error.message.startsWith("RUNTIME_IDENTITY_INVALID:") &&
      error.cause?.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"), true],
    [identity => { identity.extra = "not_allowed"; }, /C1_G1_IDENTITY_REQUIRED|E_READBACK_SOURCE_SCOPE_CONFLICT/],
    [identity => { identity.supplierSkuId = "another-sku"; }, /C1_G1_IDENTITY_REQUIRED|E_READBACK_SOURCE_SCOPE_CONFLICT/],
    [identity => { identity.storeRef.mappingVersion = "another-version"; }, /C1_G1_IDENTITY_REQUIRED|E_READBACK_SOURCE_SCOPE_CONFLICT/]
  ]) {
    const document = structuredClone(f.document);
    alter(document.candidates[0].lifecycleV11.skuPackage.g1Identity);
    let reads = 0;
    let writes = 0;
    const filePath = path.join(directory, "state.json");
    const originalBytes = JSON.stringify(document);
    if (rejectAtStorageRead) await fs.writeFile(filePath, originalBytes);
    const repository = rejectAtStorageRead
      ? createJsonBusinessStateRepository({ filePath, atomicWriter: async () => { writes += 1; throw new Error("unexpected E test write"); } })
      : createMemoryBusinessStateRepository(document);
    await assert.rejects(() => runtime(repository, async () => { reads += 1; return f.observation; }).run({ actor, input: f.input }), expectedError);
    if (rejectAtStorageRead) {
      await assert.rejects(() => repository.readSnapshot(), expectedError);
      assert.equal(await fs.readFile(filePath, "utf8"), originalBytes);
      assert.equal(writes, 0);
    } else assert.deepEqual(await repository.readSnapshot(), document);
    assert.equal(reads, 0);
  }
});

test("E验证记录使用实际读取返回后的可信完成时间", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  let currentTime = at;
  const completedAt = "2026-08-22T07:31:00.000Z";
  const service = createSystemEReadbackSoftwareRuntime({ repository, runtimeMode: "local_development", serverClock: () => currentTime,
    readPlatform: async () => { currentTime = completedAt; return f.observation; } });
  const result = await service.run({ actor, input: f.input });
  assert.equal(result.attempt.startedAt, at);
  assert.equal(result.attempt.completedAt, completedAt);
  assert.equal(result.attempt.result.verifiedAt, completedAt);
  assert.equal(result.candidate.lifecycleV11.skuPackage.eVerificationRecord.verifiedAt, completedAt);
});

test("已应用E来源变化只投影冲突并保留历史，执行仍拒绝重放", async () => {
  const f = await fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  await runtime(repository, async () => f.observation).run({ actor, input: f.input });
  const saved = await repository.readSnapshot();
  for (const alter of [
    sku => { sku.variantKey = "changed-variant"; },
    sku => { sku.g1Identity.storeRef.mappingVersion = "changed-version"; },
    sku => { sku.productionRecord.platformProductId = "910002"; },
    sku => { sku.productionRecord.productionRecordId = "changed-production-record"; },
    sku => { sku.eVerificationRecord.sourceRecordId = "changed-e-source"; },
    sku => { sku.productionRecord.productionRecordId = "changed-source"; sku.eVerificationRecord.sourceRecordId = "changed-source"; },
    sku => { sku.eVerificationRecord.platformEvidenceRef = "evidence:changed"; }
  ]) {
    const changed = structuredClone(saved);
    alter(changed.candidates[0].lifecycleV11.skuPackage);
    const currentRepository = createMemoryBusinessStateRepository(changed);
    let reads = 0;
    const service = runtime(currentRepository, async () => { reads += 1; return f.observation; });
    const view = service.view(changed.candidates[0]);
    assert.equal(view.status, "source_conflict");
    assert.equal(view.recordedStatus, "verified");
    assert.equal(view.currentVerified, false);
    assert.equal(view.sourceConflict, "E_READBACK_APPLIED_SOURCE_CONFLICT");
    assert.deepEqual(view.result, saved.candidates[0].lifecycleV11.skuPackage.readbackHistory[0].result);
    await assert.rejects(() => service.run({ actor, input: f.input }), /E_READBACK_APPLIED_SOURCE_CONFLICT/);
    assert.equal(reads, 0);
    assert.deepEqual(await currentRepository.readSnapshot(), changed);
  }
  const notesOnly = structuredClone(saved.candidates[0]);
  notesOnly.notes = "新的备注";
  assert.equal(runtime(repository, null).view(notesOnly).currentVerified, true);
  const corrupt = structuredClone(notesOnly);
  corrupt.lifecycleV11.skuPackage.readbackHistory[0].extra = true;
  assert.throws(() => runtime(repository, null).view(corrupt), /E_READBACK_ATTEMPT_INVALID/);
});
