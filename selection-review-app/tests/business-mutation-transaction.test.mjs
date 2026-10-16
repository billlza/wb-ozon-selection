import { createAProductDetailContractFixture } from "./fixtures/a-product-detail-contract-fixture.mjs";
import { createSeerfarDiscoveryRuntimeFixture } from "./fixtures/seerfar-discovery-runtime-fixture.mjs";
import { createOzonAccountDiscoveryScope } from "../lib/ozon-account-read-contract.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeBusinessMutation, executeSoftwareJobSettlementMutation } from "../lib/business-mutation-transaction.mjs";
import { prepareC1FactKeywordRuntime } from "../lib/c1-fact-keyword-runtime.mjs";
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { enqueueC1PaidKeywordEvidenceJob, prepareC1KeywordSoftwareExecution } from "../lib/c1-keyword-software-use-case.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_CAPABILITY,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER,
  createAProductDetailJobForScope,
  createSoftwareJobEnvelope,
  createSoftwareJobResultEnvelope
} from "../lib/software-job-contract.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createActorContext, createLocalDevelopmentActor, createWorkerDescriptor } from "../lib/runtime-identity.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { KEYWORD_NOW } from "./fixtures/c1-keyword-planning-fixture.mjs";
import { c1PaidKeywordSettlementCandidate, prepareC1PaidKeywordSettlementFixture, c1PaidKeywordFixtureReceipt } from "./fixtures/c1-paid-keyword-settlement-fixture.mjs";

const NOW = "2026-08-25T04:00:00.000Z";
const LOCKED = "2026-08-25T04:02:00.000Z";

function setup() {
  return createMemoryBusinessStateRepository({
    meta: { continuousAutomationEnabled: false },
    candidates: [{ id: "C-1", dataRevision: 7, workflowStatus: "a_waiting_owner" }]
  });
}

function input(repository, overrides = {}) {
  return {
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW, userId: "owner-1" }),
    requiredRoles: ["owner"],
    action: "confirm_supply",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 7,
    idempotencyKey: "C-1:7:confirm_supply",
    inputFingerprint: "sha256:confirm-supply-v1",
    auditEventId: "audit:C-1:7:confirm_supply",
    authorizationRef: "owner-confirmation:C-1:7",
    serverTime: NOW,
    mutate: ({ candidate }) => ({
      candidate: { ...candidate, workflowStatus: "b_ready" },
      result: { status: "confirmed" }
    }),
    ...overrides
  };
}

test("业务状态、幂等记录和审计在同一Repository事务中原子提交", async () => {
  const repository = setup();
  const result = await executeBusinessMutation(input(repository));
  assert.deepEqual([result.status, result.candidate.dataRevision, result.candidate.workflowStatus], ["committed", 8, "b_ready"]);
  const stored = await repository.readSnapshot();
  assert.equal(stored.runtime.operationAudit.length, 1);
  assert.equal(stored.runtime.idempotencyRecords.length, 1);
  assert.deepEqual([stored.runtime.operationAudit[0].sourceRevision, stored.runtime.operationAudit[0].resultRevision], [7, 8]);
});

test("业务决定读取当前事务证据，不能使用页面旧快照或改写共享证据", async () => {
  const repository = setup();
  await repository.transact(document => {
    document.evidencePacks = [{ id: "fx-current", status: "active", details: { rate: 12 } }];
    return { changed: true, document, result: null };
  });
  const pageSnapshot = await repository.readSnapshot();
  await repository.transact(document => {
    document.evidencePacks[0].status = "expired";
    return { changed: true, document, result: null };
  });
  assert.equal(pageSnapshot.evidencePacks[0].status, "active");
  await assert.rejects(executeBusinessMutation(input(repository, {
    mutate: ({ candidate, evidencePacks }) => {
      assert.equal(evidencePacks[0].status, "expired");
      if (evidencePacks[0].status !== "active") throw new Error("CURRENT_FX_EVIDENCE_EXPIRED");
      return { candidate, result: { status: "confirmed" } };
    }
  })), /CURRENT_FX_EVIDENCE_EXPIRED/);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 7);
  await executeBusinessMutation(input(repository, {
    mutate: ({ candidate, evidencePacks }) => {
      evidencePacks[0].details.rate = 999;
      evidencePacks.push({ id: "untrusted-mutation" });
      return { candidate, result: { status: "evidence-reviewed" } };
    }
  }));
  assert.deepEqual((await repository.readSnapshot()).evidencePacks,
    [{ id: "fx-current", status: "expired", details: { rate: 12 } }]);
});

test("JSON事务持久化失败时业务状态、审计和幂等记录全部回滚", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "business-mutation-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "business-state.json");
  const initialDocument = {
    meta: { continuousAutomationEnabled: false },
    candidates: [{ id: "C-1", dataRevision: 7, workflowStatus: "a_waiting_owner" }],
    runtime: { operationAudit: [], idempotencyRecords: [] }
  };
  await writeFile(filePath, JSON.stringify(initialDocument), "utf8");
  const repository = createJsonBusinessStateRepository({
    filePath,
    atomicWriter: async () => { throw new Error("simulated_atomic_replace_failure"); }
  });
  await assert.rejects(() => executeBusinessMutation(input(repository)), /simulated_atomic_replace_failure/);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), initialDocument);
});

test("明确请求关联作业时只提供锁内当前SKU副本，普通业务动作不读取作业上下文", async () => {
  const repository = setup();
  const related = transportJob();
  const otherInput = transportJobInput();
  otherInput.jobId = "software-job:c2-transport:other:8";
  otherInput.idempotencyKey = "C-other:7:c2-transport";
  otherInput.candidateId = "C-other";
  otherInput.skuPackageId = "sku:C-other:S-1";
  otherInput.scopeBinding.candidateId = otherInput.candidateId;
  otherInput.scopeBinding.skuPackageId = otherInput.skuPackageId;
  const other = createSoftwareJobEnvelope({ ...otherInput, createdAt: NOW });
  await repository.transact(document => {
    document.runtime = { softwareJobs: [related, other] };
    return { changed: true, document, result: null };
  });
  await executeBusinessMutation(input(repository, { includeRelatedSoftwareJobs: true,
    mutate: ({ candidate, relatedSoftwareJobs }) => {
      assert.deepEqual(relatedSoftwareJobs, [related]);
      relatedSoftwareJobs[0].status = "failed";
      return { candidate, result: { observedJobId: relatedSoftwareJobs[0].jobId } };
    }
  }));
  assert.deepEqual((await repository.readSnapshot()).runtime.softwareJobs, [related, other]);
  const malformed = setup();
  await malformed.transact(document => {
    document.runtime = { softwareJobs: "damaged" };
    return { changed: true, document, result: null };
  });
  const before = await malformed.readSnapshot();
  await assert.rejects(executeBusinessMutation(input(malformed, { includeRelatedSoftwareJobs: true })), /BUSINESS_MUTATION_JOB_CONTEXT_INVALID/);
  assert.deepEqual(await malformed.readSnapshot(), before);
  await executeBusinessMutation(input(malformed, { mutate: context => {
    assert.equal(Object.hasOwn(context, "relatedSoftwareJobs"), false);
    return { candidate: context.candidate, result: { currentSkuOnly: true } };
  } }));
});

test("相同幂等键并发调用只执行一次，参数漂移和同revision不同写入都拒绝", async () => {
  const repository = setup();
  let calls = 0;
  const mutation = input(repository, {
    mutate: async ({ candidate }) => {
      calls += 1;
      return { candidate: { ...candidate, workflowStatus: "b_ready" }, result: { calls } };
    }
  });
  const [first, replay] = await Promise.all([
    executeBusinessMutation(mutation), executeBusinessMutation(mutation)
  ]);
  assert.deepEqual(new Set([first.status, replay.status]), new Set(["committed", "idempotent_replay"]));
  assert.equal(calls, 1);
  await assert.rejects(() => executeBusinessMutation(input(repository, {
    inputFingerprint: "sha256:tampered"
  })), /BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => executeBusinessMutation(input(repository, {
    idempotencyKey: "C-1:7:another-write",
    auditEventId: "audit:C-1:7:another-write"
  })), /BUSINESS_MUTATION_REVISION_CONFLICT/);
});

test("变更函数失败或输出秘密时不留半套状态", async () => {
  const repository = setup();
  await assert.rejects(() => executeBusinessMutation(input(repository, {
    mutate: () => { throw new Error("domain failed"); }
  })), /domain failed/);
  await assert.rejects(() => executeBusinessMutation(input(repository, {
    mutate: ({ candidate }) => ({ candidate, result: { apiKey: "must-not-persist" } })
  })), /不得保存秘密字段/);
  const stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, 7);
  assert.equal(stored.runtime?.operationAudit?.length || 0, 0);
  assert.equal(stored.runtime?.idempotencyRecords?.length || 0, 0);
  await assert.rejects(() => executeBusinessMutation(input(repository, {
    runtimeMode: "unknown_runtime"
  })), /BUSINESS_MUTATION_RUNTIME_MODE_INVALID/);
});

test("候选正文包含驼峰秘密字段时整笔事务回滚", async () => {
  const repository = setup();
  const before = await repository.readSnapshot();
  await assert.rejects(() => executeBusinessMutation({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW }),
    requiredRoles: ["owner"],
    action: "unsafe_candidate_write",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 7,
    idempotencyKey: "C-1:7:unsafe",
    inputFingerprint: "unsafe-input",
    auditEventId: "audit-unsafe",
    serverTime: NOW,
    mutate: ({ candidate }) => {
      candidate.integration = { accessToken: "must-not-persist" };
      return { candidate, result: { status: "unsafe" } };
    }
  }), /不得保存秘密字段/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

function transportJobInput() {
  return {
    jobId: "software-job:c2-transport:C-1:8",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    revision: 8,
    jobType: "c2_stable_asset_transport",
    requestedByUserId: "owner-1",
    ownerUserId: "owner-1",
    requiredCapabilities: ["stable-asset-transport"],
    idempotencyKey: "C-1:7:c2-transport",
    scopeBinding: {
      schemaVersion: "software-job-scope-v1",
      candidateId: "C-1",
      skuPackageId: "sku:C-1:S-1",
      sourceRevision: 7,
      resultRevision: 8,
      platform: "ozon",
      storeRef: { stableStoreId: "store:ozon:one", platformStoreId: "seller-one", mappingVersion: "stores-v1" },
      supplierSkuId: "supplier-sku-1",
      variantKey: "white",
      sideEffectScope: "c2_stable_asset_transport",
      authorizationRef: "transport-authz:c2:1",
      credentialAlias: "credential-alias:oss:one",
      inputFingerprint: "a".repeat(64),
      stagedAssetManifestFingerprint: "b".repeat(64),
      ownerStagingConfirmationRef: "owner-confirmation:c2-staging:1",
      allowedStableAssetHosts: ["assets.example.com"]
    }
  };
}

function transportJob({ createdAt = NOW } = {}) {
  return createSoftwareJobEnvelope({ ...transportJobInput(), createdAt });
}

function transportCandidateRepository() {
  const job = transportJob();
  return createMemoryBusinessStateRepository({
    candidates: [{
      id: "C-1",
      dataRevision: 7,
      workflowStatus: "c2_waiting_final_uploads",
      lifecycleV11: { skuPackage: {
        skuPackageId: job.skuPackageId,
        variantKey: job.scopeBinding.variantKey,
        g1Identity: {
          candidateId: job.candidateId, skuPackageId: job.skuPackageId,
          platform: job.scopeBinding.platform, storeRef: structuredClone(job.scopeBinding.storeRef),
          supplierSkuId: job.scopeBinding.supplierSkuId
        },
        c2FinalAssets: { stableAssetTransport: null }
      } }
    }],
    runtime: {
      operationAudit: [],
      idempotencyRecords: [],
      softwareJobs: [],
      softwareJobAuthorizationRecords: [transportAuthorizationRecord(job)],
      softwareJobCredentialBindings: [transportCredentialBinding(job)]
    }
  });
}

function transportAuthorizationRecord(job = transportJob()) {
  return {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: job.scopeBinding.authorizationRef,
    status: "active",
    action: job.jobType,
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    sourceRevision: job.scopeBinding.sourceRevision,
    resultRevision: job.scopeBinding.resultRevision,
    platform: job.scopeBinding.platform,
    storeRef: structuredClone(job.scopeBinding.storeRef),
    supplierSkuId: job.scopeBinding.supplierSkuId,
    variantKey: job.scopeBinding.variantKey,
    sideEffectScope: job.scopeBinding.sideEffectScope,
    stagedAssetManifestFingerprint: job.scopeBinding.stagedAssetManifestFingerprint,
    ownerStagingConfirmationRef: job.scopeBinding.ownerStagingConfirmationRef,
    allowedStableAssetHosts: structuredClone(job.scopeBinding.allowedStableAssetHosts),
    authorizedByUserId: "owner-1",
    authorizedAt: NOW,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null
  };
}

function transportCredentialBinding(job = transportJob(), workerIds = ["worker-transport-1"]) {
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:oss:one",
    credentialAlias: job.scopeBinding.credentialAlias,
    status: "active",
    provider: "oss",
    platform: job.scopeBinding.platform,
    storeRef: structuredClone(job.scopeBinding.storeRef),
    sideEffectScope: job.scopeBinding.sideEffectScope,
    allowedStableAssetHosts: structuredClone(job.scopeBinding.allowedStableAssetHosts),
    allowedWorkerIds: workerIds,
    redaction: "credential_alias_only",
    boundAt: NOW,
    expiresAt: null
  };
}

function transportWorkerRegistry(clock = () => NOW) {
  const registry = createLocalDevelopmentWorkerRegistry({ clock, heartbeatTtlMs: 60_000 });
  registry.register({
    workerId: "worker-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: clock()
  });
  return registry;
}

function c1PaidKeywordReadyCandidate() {
  return c1PaidKeywordSettlementCandidate();
}

function c1PaidKeywordPreparation(candidate) {
  return prepareC1KeywordSoftwareExecution({
    candidate,
    clientInput: { dataRevision: candidate.dataRevision },
    plannedAt: KEYWORD_NOW
  });
}

function c1PaidKeywordAuthorizationRecord(scope) {
  return {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: scope.authorizationRef,
    status: "active",
    action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationSubject: "c1_paid_keyword_evidence:seerfar_open_api_once",
    candidateId: scope.candidateId,
    skuPackageId: scope.skuPackageId,
    sourceRevision: scope.sourceRevision,
    resultRevision: scope.resultRevision,
    platform: scope.platform,
    targetStore: scope.targetStore,
    supplierSkuId: scope.supplierSkuId,
    variantKey: scope.variantKey,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    provider: C1_PAID_KEYWORD_PROVIDER,
    credentialAlias: scope.credentialAlias,
    inputFingerprint: scope.inputFingerprint,
    planningEvidenceFingerprint: scope.planningEvidenceFingerprint,
    runtimeInputFingerprint: scope.runtimeInputFingerprint,
    seerfarRequestFingerprint: scope.seerfarRequestFingerprint,
    salesSnapshotFingerprint: scope.salesSnapshotFingerprint,
    supplySnapshotFingerprint: scope.supplySnapshotFingerprint,
    profitModelFingerprint: scope.profitModelFingerprint,
    c1FactsFingerprint: scope.c1FactsFingerprint,
    pointBudgetEvidenceRef: scope.pointBudgetEvidenceRef,
    quotaEvidenceRef: scope.quotaEvidenceRef,
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    authorizedByUserId: "owner-1",
    authorizedAt: KEYWORD_NOW,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null
  };
}

function c1PaidKeywordCredentialBinding(scope, workerIds = ["worker-seerfar-open-api-1"]) {
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:seerfar-open-api:dandanshu",
    credentialAlias: scope.credentialAlias,
    status: "active",
    provider: C1_PAID_KEYWORD_PROVIDER,
    platform: scope.platform,
    targetStore: scope.targetStore,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: scope.candidateId,
    skuPackageId: scope.skuPackageId,
    sourceRevision: scope.sourceRevision,
    resultRevision: scope.resultRevision,
    inputFingerprint: scope.inputFingerprint,
    planningEvidenceFingerprint: scope.planningEvidenceFingerprint,
    runtimeInputFingerprint: scope.runtimeInputFingerprint,
    seerfarRequestFingerprint: scope.seerfarRequestFingerprint,
    allowedWorkerIds: workerIds,
    redaction: "credential_alias_only",
    boundAt: KEYWORD_NOW,
    expiresAt: null
  };
}

function c1PaidKeywordRepository({ candidate = c1PaidKeywordReadyCandidate(), preparation = c1PaidKeywordPreparation(candidate) } = {}) {
  return createMemoryBusinessStateRepository({
    candidates: [candidate],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [],
      softwareJobCredentialBindings: [],
      operationAudit: [],
      idempotencyRecords: []
    }
  });
}

function c1PaidKeywordWorkerRegistry(clock = () => KEYWORD_NOW) {
  const registry = createLocalDevelopmentWorkerRegistry({ clock, heartbeatTtlMs: 60_000 });
  registry.register({
    workerId: "worker-seerfar-open-api-1",
    capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    version: "1.0.0",
    observedAt: clock()
  });
  return registry;
}

function c1PaidKeywordWorker() {
  return createWorkerDescriptor({
    workerId: "worker-seerfar-open-api-1",
    capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    version: "1.0.0",
    observedAt: KEYWORD_NOW
  });
}

function c1PaidKeywordWorkerActor() {
  return createActorContext({
    userId: "worker-seerfar-open-api-1",
    sessionId: "session:c1-paid-keyword",
    actorType: "worker",
    roles: ["operator"],
    source: "worker",
    authenticatedAt: KEYWORD_NOW
  });
}

async function enqueueAndStartC1PaidKeywordJob(repository, candidate) {
  const enqueueResult = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:c1-paid-keyword" }),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW
  });
  assert.equal(enqueueResult.status, "committed");
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => KEYWORD_NOW,
    workerRegistry: c1PaidKeywordWorkerRegistry()
  });
  const jobId = enqueueResult.result.softwareJobRef.jobId;
  const worker = c1PaidKeywordWorker();
  await store.claim({ jobId, worker, leaseId: "lease:c1-paid-keyword", leaseDurationMs: 60_000 });
  await store.markExternalRequestStarted({
    jobId,
    workerId: worker.workerId,
    leaseId: "lease:c1-paid-keyword",
    externalRequestRef: "request:c1-paid-keyword:1"
  });
  return {
    enqueueResult,
    worker,
    job: await store.get(jobId)
  };
}

async function c1PaidKeywordPreparedPayload({ job, candidate, overrides = {} }) {
  const prepared = await prepareC1PaidKeywordSettlementFixture({
    candidateId: job.candidateId,
    skuPackage: candidate.lifecycleV11.skuPackage,
    input: candidate.lifecycleV11.c1PaidKeywordEvidenceRuntimeInputV1
  });
  return { ...structuredClone(prepared), ...structuredClone(overrides) };
}

async function c1PaidKeywordResultEnvelope({ job, candidate, resultRef = "receipt:c1-paid-keyword:1", payloadOverrides = {} }) {
  return createSoftwareJobResultEnvelope({
    job,
    resultRef,
    payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    payload: {
      schemaVersion: "c1-paid-keyword-evidence-worker-result-v1",
      prepared: await c1PaidKeywordPreparedPayload({ job, candidate, overrides: payloadOverrides }),
      triggerReceipt: null,
      providerReceipt: c1PaidKeywordFixtureReceipt()
    },
    recordedAt: KEYWORD_NOW,
    applicationDisposition: "applied"
  });
}

function settleC1TestEnvelope(repository, job, resultEnvelope) {
  return executeSoftwareJobSettlementMutation({
    repository, runtimeMode: "local_development", actor: c1PaidKeywordWorkerActor(), requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence", candidateId: job.candidateId, skuPackageId: job.skuPackageId,
    expectedRevision: job.revision, idempotencyKey: "settle:c1:attack", inputFingerprint: "c1:attack",
    auditEventId: "audit:c1:attack", authorizationRef: job.scopeBinding.authorizationRef,
    serverTime: KEYWORD_NOW, serverClock: () => KEYWORD_NOW,
    settlement: {
      jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId, status: "completed",
      externalRequestState: "succeeded", resultRef: resultEnvelope.resultRef, resultEnvelope,
      failureClass: null, externalRequestRef: job.externalRequestRef
    }, expectedJobScopeBinding: job.scopeBinding
  });
}

test("C1 settlement拒绝改写冻结身份、A/B、阶段及自洽重算后的恶意嵌套证据", async () => {
  for (const attack of ["supplier", "phase", "profit", "snapshot", "nested", "metrics", "rules", "receipt", "raw-provider", "provider-scope"]) {
    const candidate = await c1PaidKeywordReadyCandidate();
    const repository = c1PaidKeywordRepository({ candidate });
    const { job } = await enqueueAndStartC1PaidKeywordJob(repository, candidate);
    const current = (await repository.readSnapshot()).candidates[0];
    let prepared = await c1PaidKeywordPreparedPayload({ job, candidate: current });
    const providerReceipt = c1PaidKeywordFixtureReceipt();
    if (attack === "supplier") prepared.result.skuPackage.supplierSkuId = "foreign-supplier";
    if (attack === "phase") prepared.result.skuPackage.businessPhase = "D";
    if (attack === "profit") prepared.result.skuPackage.c1ProductPlan.inputSnapshots.profitModel.unitProfitRmb = 999999;
    if (attack === "snapshot") prepared.result.skuPackage.c1ProductPlan.inputSnapshots.salesSnapshot.currentPrice = 1;
    if (attack === "nested") prepared.result.evidenceStage.evidence.extraDecision = { approved: true };
    if (attack === "receipt") prepared.receipt.inputFingerprint = "e".repeat(64);
    if (attack === "raw-provider") providerReceipt.providerEvidence = { rawResponse: "untrusted response" };
    if (attack === "provider-scope") providerReceipt.attempt.targetPlatform = "wb";
    if (["metrics", "rules"].includes(attack)) {
      const forgedInput = structuredClone(current.lifecycleV11.c1PaidKeywordEvidenceRuntimeInputV1);
      forgedInput.providerEvidence.seerfarApiReceipt = providerReceipt;
      if (attack === "metrics") {
        const component = forgedInput.providerEvidence.keywordMetricEvidence.candidates[0].components.semanticMatch;
        component.value = 99;
        component.rawValue = 99;
      } else forgedInput.frozenSeoRules.titleMaxLength += 1;
      // The real pipeline recomputes every nested fingerprint; this is not a stale-hash negative case.
      prepared = structuredClone(await prepareC1FactKeywordRuntime({ candidateId: job.candidateId,
        skuPackage: current.lifecycleV11.skuPackage, input: forgedInput, preparedAt: KEYWORD_NOW }));
      assert.equal(prepared.result.status, "ready_for_atomic_persist");
    }
    const before = await repository.readSnapshot();
    await assert.rejects(async () => {
      const envelope = createSoftwareJobResultEnvelope({ job, resultRef: `receipt:c1:attack-${attack}`,
        payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
        payload: { schemaVersion: "c1-paid-keyword-evidence-worker-result-v1", prepared, triggerReceipt: null, providerReceipt },
        recordedAt: KEYWORD_NOW, applicationDisposition: "applied" });
      return settleC1TestEnvelope(repository, job, envelope);
    }, /C1_|RUNTIME_IDENTITY_INVALID/, attack);
    assert.deepEqual(await repository.readSnapshot(), before, attack);
  }
});

test("C1 revision冲突的result-only分支同样拒绝恶意领域payload", async () => {
  const candidate = await c1PaidKeywordReadyCandidate();
  const repository = c1PaidKeywordRepository({ candidate });
  const { job } = await enqueueAndStartC1PaidKeywordJob(repository, candidate);
  const enqueued = (await repository.readSnapshot()).candidates[0];
  const prepared = await c1PaidKeywordPreparedPayload({ job, candidate: enqueued });
  prepared.result.skuPackage.businessPhase = "D";
  await repository.transact(async (document) => {
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  const envelope = createSoftwareJobResultEnvelope({ job, resultRef: "receipt:c1:old-malicious",
    payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    payload: { schemaVersion: "c1-paid-keyword-evidence-worker-result-v1", prepared, triggerReceipt: null, providerReceipt: c1PaidKeywordFixtureReceipt() },
    recordedAt: KEYWORD_NOW, applicationDisposition: "applied" });
  await assert.rejects(() => settleC1TestEnvelope(repository, job, envelope), /C1_FACT_KEYWORD_PERSISTENCE_RESULT_DRIFT/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("同店两个不同SKU可独立原子入队，共用alias但各自冻结凭据binding与一次授权", async () => {
  const first = await c1PaidKeywordSettlementCandidate({ candidateId: "CX-C1-FIRST", supplierSkuId: "MUSIC-WHITE" });
  const second = await c1PaidKeywordSettlementCandidate({ candidateId: "CX-C1-SECOND", supplierSkuId: "MUSIC-BLACK" });
  const repository = createMemoryBusinessStateRepository({ candidates: [first, second], runtime: {
    softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: []
  } });
  for (const candidate of [first, second]) {
    const outcome = await enqueueC1PaidKeywordEvidenceJob({ repository, runtimeMode: "local_development",
      actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:c1-two-skus" }),
      candidateId: candidate.id, expectedRevision: candidate.dataRevision, clientInput: { dataRevision: candidate.dataRevision },
      serverTime: KEYWORD_NOW, serverClock: () => KEYWORD_NOW });
    assert.equal(outcome.status, "committed");
  }
  const stored = await repository.readSnapshot();
  assert.equal(stored.runtime.softwareJobs.length, 2);
  assert.equal(stored.runtime.softwareJobCredentialBindings.length, 2);
  assert.equal(new Set(stored.runtime.softwareJobCredentialBindings.map((record) => record.credentialAlias)).size, 1);
  assert.equal(new Set(stored.runtime.softwareJobCredentialBindings.map((record) => record.bindingId)).size, 2);
  assert.deepEqual(stored.runtime.softwareJobAuthorizationRecords.map((record) => record.useCount), [1, 1]);
});

function mutableCountedClock(initialValue) {
  let value = initialValue;
  let calls = 0;
  return {
    clock: () => {
      calls += 1;
      return value;
    },
    set: (nextValue) => {
      value = nextValue;
    },
    calls: () => calls
  };
}

async function holdRepositoryQueue(repository) {
  let release;
  let blocker;
  const entered = new Promise((resolve) => {
    blocker = repository.transact(async () => {
      await new Promise((resume) => {
        release = resume;
        resolve();
      });
      return { changed: false, result: null };
    });
  });
  await entered;
  return { release, blocker };
}

async function completedEnvelope(repository, { resultRef = "receipt:c2-transport:1", applicationDisposition = "applied" } = {}) {
  const currentJob = (await repository.readSnapshot()).runtime.softwareJobs.find((entry) => entry.jobId === transportJob().jobId);
  return createSoftwareJobResultEnvelope({
    job: currentJob,
    resultRef,
    payloadKind: "c2_stable_asset_transport",
    payload: { schemaVersion: "test-c2-stable-asset-result-v1", status: "verified", value: "ok" },
    recordedAt: NOW,
    applicationDisposition
  });
}

async function enqueueTransportTransaction(repository, overrides = {}) {
  const job = transportJob();
  const jobRef = {
    schemaVersion: "c2-stable-asset-transport-job-ref-v1",
    jobId: job.jobId,
    jobType: job.jobType,
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    sourceRevision: 7,
    resultRevision: 8,
    inputFingerprint: "a".repeat(64)
  };
  return executeBusinessMutation({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW, userId: "owner-1" }),
    requiredRoles: ["owner"],
    action: "enqueue_c2_stable_asset_transport",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 7,
    idempotencyKey: job.idempotencyKey,
    inputFingerprint: "a".repeat(64),
    auditEventId: "audit:c2-transport:enqueue",
    authorizationRef: job.scopeBinding.authorizationRef,
    serverTime: Object.hasOwn(overrides, "serverTime") ? overrides.serverTime : NOW,
    serverClock: overrides.serverClock ?? (() => NOW),
    softwareJobEffect: {
      schemaVersion: "business-mutation-effect-v1",
      kind: "software_job",
      operation: "enqueue",
      jobInput: transportJobInput()
    },
    mutate: ({ candidate, observedAt }) => {
      // The transaction fixture freezes its exact job source; its intentionally
      // incomplete C2 domain must still reject every fabricated completed payload.
      candidate.lifecycleV11.skuPackage.c2FinalAssets.stableAssetTransport = {
        jobRef, stagedAt: observedAt,
        stagedAssetManifestFingerprint: job.scopeBinding.stagedAssetManifestFingerprint,
        ownerStagingConfirmation: { confirmationRef: job.scopeBinding.ownerStagingConfirmationRef }
      };
      candidate.workflowStatus = "c2_waiting_stable_transport";
      return { candidate, result: { status: "queued", jobRef } };
    }
  });
}

test("C2 jobRef、SoftwareJob、审计和幂等在同一事务提交且半套状态回滚", async () => {
  const repository = transportCandidateRepository();
  const first = await enqueueTransportTransaction(repository);
  assert.equal(first.status, "committed");
  const stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, 8);
  assert.equal(stored.runtime.softwareJobs.length, 1);
  assert.equal(stored.runtime.softwareJobs[0].revision, 8);
  assert.equal(stored.runtime.softwareJobs[0].admissionDecision.authorizationRef, transportJob().scopeBinding.authorizationRef);
  assert.equal(stored.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(stored.runtime.softwareJobAuthorizationRecords[0].consumedByJobId, transportJob().jobId);
  assert.equal(stored.runtime.softwareJobAuthorizationRecords[0].consumedAt, NOW);
  assert.equal(stored.runtime.idempotencyRecords.length, 1);
  assert.equal(stored.runtime.operationAudit.length, 1);
  assert.equal(Object.hasOwn(stored.runtime.idempotencyRecords[0].result, "softwareJob"), false);
  assert.equal((await enqueueTransportTransaction(repository)).status, "idempotent_replay");

  const brokenRepository = transportCandidateRepository();
  const before = await brokenRepository.readSnapshot();
  await assert.rejects(() => executeBusinessMutation({
    repository: brokenRepository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW }),
    requiredRoles: ["owner"],
    action: "enqueue_c2_stable_asset_transport",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 7,
    idempotencyKey: transportJob().idempotencyKey,
    inputFingerprint: "a".repeat(64),
    auditEventId: "audit:broken",
    serverTime: NOW,
    serverClock: () => NOW,
    softwareJobEffect: {
      schemaVersion: "business-mutation-effect-v1",
      kind: "software_job",
      operation: "enqueue",
      jobInput: transportJobInput()
    },
    mutate: ({ candidate }) => ({ candidate, result: { status: "missing-job-ref" } })
  }), /BUSINESS_MUTATION_HALF_STATE_REJECTED/);
  assert.deepEqual(await brokenRepository.readSnapshot(), before);
});

test("SoftwareJob effect必须是纯数据jobInput，函数型effect零执行且零写入", async () => {
  const repository = transportCandidateRepository();
  const before = await repository.readSnapshot();
  let calls = 0;
  await assert.rejects(() => executeBusinessMutation({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW }),
    requiredRoles: ["owner"],
    action: "enqueue_c2_stable_asset_transport",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 7,
    idempotencyKey: transportJob().idempotencyKey,
    inputFingerprint: "a".repeat(64),
    auditEventId: "audit:function-effect",
    serverTime: NOW,
    serverClock: () => NOW,
    softwareJobEffect: {
      schemaVersion: "business-mutation-effect-v1",
      kind: "software_job",
      operation: "enqueue",
      createJob: () => {
        calls += 1;
        return transportJob();
      }
    },
    mutate: ({ candidate }) => ({ candidate, result: { status: "must-not-run-function-effect" } })
  }), /BUSINESS_MUTATION_EFFECT_INVALID/);
  assert.equal(calls, 0);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("SoftwareJob jobInput夹带createdAt或时钟字段时拒绝且零写入", async () => {
  const scenarios = [
    ...["createdAt", "serverTime", "serverClock"].map((forbiddenClockField) => ({
      name: forbiddenClockField,
      jobInput: { ...transportJobInput(), [forbiddenClockField]: forbiddenClockField === "serverClock" ? "not-a-function" : NOW }
    })),
    {
      name: "nested-function",
      jobInput: {
        ...transportJobInput(),
        scopeBinding: { ...transportJobInput().scopeBinding, unsafeCallback: () => transportJob() }
      }
    }
  ];
  for (const scenario of scenarios) {
    const repository = transportCandidateRepository();
    const before = await repository.readSnapshot();
    await assert.rejects(() => executeBusinessMutation({
      repository,
      runtimeMode: "local_development",
      actor: createLocalDevelopmentActor({ at: NOW }),
      requiredRoles: ["owner"],
      action: "enqueue_c2_stable_asset_transport",
      candidateId: "C-1",
      skuPackageId: "sku:C-1:S-1",
      expectedRevision: 7,
      idempotencyKey: transportJob().idempotencyKey,
      inputFingerprint: "a".repeat(64),
      auditEventId: `audit:forbidden-job-input:${scenario.name}`,
      serverTime: NOW,
      serverClock: () => NOW,
      softwareJobEffect: {
        schemaVersion: "business-mutation-effect-v1",
        kind: "software_job",
        operation: "enqueue",
        jobInput: scenario.jobInput
      },
      mutate: ({ candidate }) => ({ candidate, result: { status: "must-not-accept-clock-field" } })
    }), /BUSINESS_MUTATION_EFFECT_INVALID/);
    assert.deepEqual(await repository.readSnapshot(), before, scenario.name);
  }
});

test("SoftwareJob enqueue排队跨过授权或凭据到期后按锁内serverClock拒绝且零写入", async () => {
  const expiresAt = "2026-08-25T04:01:00.000Z";
  for (const scenario of [
    {
      name: "authorization",
      mutate: (document) => { document.runtime.softwareJobAuthorizationRecords[0].expiresAt = expiresAt; },
      pattern: /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED/
    },
    {
      name: "credential",
      mutate: (document) => { document.runtime.softwareJobCredentialBindings[0].expiresAt = expiresAt; },
      pattern: /SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED/
    }
  ]) {
    const repository = transportCandidateRepository();
    await repository.transact(async (document) => {
      scenario.mutate(document);
      return { changed: true, document, result: null };
    });
    const before = await repository.readSnapshot();
    const { clock, set, calls } = mutableCountedClock(NOW);
    const { release, blocker } = await holdRepositoryQueue(repository);
    const pending = enqueueTransportTransaction(repository, { serverTime: NOW, serverClock: clock });
    assert.equal(calls(), 0, scenario.name);
    set(LOCKED);
    release();
    await blocker;
    await assert.rejects(pending, scenario.pattern, scenario.name);
    assert.equal(calls(), 1, scenario.name);
    assert.deepEqual(await repository.readSnapshot(), before, scenario.name);
  }
});

test("SoftwareJob enqueue在锁内取一次serverClock并把createdAt、stagedAt、audit和幂等时间同源持久化", async () => {
  for (const oldServerTime of [undefined, "not-a-date", NOW]) {
    const repository = transportCandidateRepository();
    const { clock, set, calls } = mutableCountedClock(NOW);
    const { release, blocker } = await holdRepositoryQueue(repository);
    const pending = enqueueTransportTransaction(repository, { serverTime: oldServerTime, serverClock: clock });
    assert.equal(calls(), 0);
    set(LOCKED);
    release();
    await blocker;
    const result = await pending;
    assert.equal(calls(), 1);
    assert.equal(result.status, "committed");
    const stored = await repository.readSnapshot();
    const job = stored.runtime.softwareJobs[0];
    assert.equal(job.createdAt, LOCKED);
    assert.equal(stored.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.stableAssetTransport.stagedAt, LOCKED);
    assert.equal(job.admissionDecision.observedAt, LOCKED);
    assert.equal(stored.runtime.softwareJobAuthorizationRecords[0].consumedAt, LOCKED);
    assert.equal(stored.runtime.operationAudit[0].serverTime, LOCKED);
    assert.equal(stored.runtime.idempotencyRecords[0].recordedAt, LOCKED);
  }

  const failedRepository = transportCandidateRepository();
  const before = await failedRepository.readSnapshot();
  await assert.rejects(() => enqueueTransportTransaction(failedRepository, {
    serverTime: NOW,
    serverClock: () => "not-a-date"
  }), /BUSINESS_MUTATION_CLOCK_INVALID:serverClock/);
  assert.deepEqual(await failedRepository.readSnapshot(), before);
});

test("SoftwareJob settlement排队跨过租约到期后按锁内serverClock拒绝且零写入", async () => {
  const repository = transportCandidateRepository();
  await enqueueTransportTransaction(repository);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => NOW,
    workerRegistry: transportWorkerRegistry()
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-transport-1", capabilities: ["stable-asset-transport"], version: "1.0.0", observedAt: NOW
  });
  await store.claim({ jobId: transportJob().jobId, worker, leaseId: "lease-expiring-settle", leaseDurationMs: 60_000 });
  const before = await repository.readSnapshot();
  const workerActor = createActorContext({
    userId: worker.workerId, sessionId: "session-expiring-settle", actorType: "worker", roles: ["operator"], source: "worker", authenticatedAt: NOW
  });
  const { clock, set, calls } = mutableCountedClock(NOW);
  const { release, blocker } = await holdRepositoryQueue(repository);
  const pending = executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: workerActor,
    requiredRoles: ["operator"],
    action: "settle_c2_stable_asset_transport",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 8,
    idempotencyKey: "settle:expired-lease",
    inputFingerprint: "expired-lease:fingerprint",
    auditEventId: "audit:settle:expired-lease",
    authorizationRef: transportJob().scopeBinding.authorizationRef,
    serverTime: NOW,
    serverClock: clock,
    settlement: {
      jobId: transportJob().jobId,
      workerId: worker.workerId,
      leaseId: "lease-expiring-settle",
      status: "failed",
      externalRequestState: "not_sent",
      failureClass: "transport_failed_before_request",
      externalRequestRef: null
    },
    expectedJobScopeBinding: transportJob().scopeBinding
  });
  assert.equal(calls(), 0);
  set(LOCKED);
  release();
  await blocker;
  await assert.rejects(pending, /租约已过期/);
  assert.equal(calls(), 1);
  const after = await repository.readSnapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(
    after.runtime.softwareJobs.map((entry) => [entry.jobId, entry.status, entry.externalRequestState, entry.externalRequestRef]),
    [[transportJob().jobId, "claimed", "not_sent", null]]
  );
});

test("C1 paid keyword completed只能通过领域settlement事务落证据、收作业并保持零下游", async () => {
  const candidate = await c1PaidKeywordReadyCandidate();
  const repository = c1PaidKeywordRepository({ candidate });
  const { job, worker } = await enqueueAndStartC1PaidKeywordJob(repository, candidate);
  const enqueuedCandidate = (await repository.readSnapshot()).candidates[0];
  const resultEnvelope = await c1PaidKeywordResultEnvelope({ job, candidate: enqueuedCandidate });
  const result = await executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: c1PaidKeywordWorkerActor(),
    requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence",
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    expectedRevision: job.revision,
    idempotencyKey: "settle:c1-paid-keyword:completed",
    inputFingerprint: "c1-paid-keyword-settlement-completed",
    auditEventId: "audit:settle:c1-paid-keyword:completed",
    authorizationRef: job.scopeBinding.authorizationRef,
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW,
    settlement: {
      jobId: job.jobId,
      workerId: worker.workerId,
      leaseId: "lease:c1-paid-keyword",
      status: "completed",
      externalRequestState: "succeeded",
      resultRef: resultEnvelope.resultRef,
      resultEnvelope,
      failureClass: null,
      externalRequestRef: "request:c1-paid-keyword:1"
    },
    expectedJobScopeBinding: job.scopeBinding
  });
  assert.equal(result.status, "committed");
  assert.equal(result.result.status, "verified");
  assert.deepEqual([
    result.result.productionAuthorizationCreated,
    result.result.dHandoffCreated,
    result.result.productionPlanCreated,
    result.result.executionIntentCreated,
    result.result.platformWrites,
    result.result.candidateRevisionUnchanged
  ], [false, false, false, false, 0, false]);
  const stored = await repository.readSnapshot();
  const storedCandidate = stored.candidates[0];
  assert.equal(storedCandidate.dataRevision, job.revision + 1);
  assert.equal(storedCandidate.lifecycleV11.status, "c1_evidence_ready");
  assert.equal(storedCandidate.lifecycleV11.c1PaidKeywordEvidenceSettlementV1.jobId, job.jobId);
  assert.equal(storedCandidate.lifecycleV11.c1PaidKeywordEvidenceSettlementV1.resultFingerprint, resultEnvelope.payloadFingerprint);
  assert.equal(storedCandidate.lifecycleV11.c1SoftwareEvidenceV1.evidenceFingerprint, resultEnvelope.payload.prepared.result.evidenceStage.evidence.evidenceFingerprint);
  assert.equal(storedCandidate.lifecycleV11.c1FactKeywordRuntimeReceiptV1.skuPackageId, job.skuPackageId);
  for (const field of ["c1KeywordSoftwareJobPlanV1", "c1PaidKeywordEvidenceRuntimeInputV1", "c1PaidKeywordEvidenceSeerfarRequestV1"]) {
    assert.equal(Object.hasOwn(storedCandidate.lifecycleV11, field), false);
    assert.deepEqual(stored.runtime.idempotencyRecords[0].candidateSnapshot.lifecycleV11[field], enqueuedCandidate.lifecycleV11[field]);
  }
  assert.deepEqual(storedCandidate.lifecycleV11.c1PaidKeywordEvidenceInputArtifactRefV1, enqueuedCandidate.lifecycleV11.c1PaidKeywordEvidenceInputArtifactRefV1);
  assert.deepEqual(storedCandidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots, enqueuedCandidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots);
  assert.equal(stored.runtime.softwareJobs[0].status, "completed");
  assert.equal(stored.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "applied");
  assert.equal(stored.runtime.operationAudit.length, 2);
  assert.equal(stored.runtime.idempotencyRecords.length, 2);
});

test("C1 paid keyword伪造completed payload时事务回滚且不把generic job当领域证据", async () => {
  const candidate = await c1PaidKeywordReadyCandidate();
  const repository = c1PaidKeywordRepository({ candidate });
  const { job, worker } = await enqueueAndStartC1PaidKeywordJob(repository, candidate);
  const enqueuedCandidate = (await repository.readSnapshot()).candidates[0];
  const forgedPrepared = await c1PaidKeywordPreparedPayload({ job, candidate: enqueuedCandidate });
  forgedPrepared.result.sourceCandidateRevision = job.revision - 1;
  const resultEnvelope = createSoftwareJobResultEnvelope({
    job,
    resultRef: "receipt:c1-paid-keyword:forged",
    payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    payload: {
      schemaVersion: "c1-paid-keyword-evidence-worker-result-v1",
      prepared: forgedPrepared,
      triggerReceipt: null,
      providerReceipt: c1PaidKeywordFixtureReceipt()
    },
    recordedAt: KEYWORD_NOW,
    applicationDisposition: "applied"
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: c1PaidKeywordWorkerActor(),
    requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence",
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    expectedRevision: job.revision,
    idempotencyKey: "settle:c1-paid-keyword:forged",
    inputFingerprint: "c1-paid-keyword-settlement-forged",
    auditEventId: "audit:settle:c1-paid-keyword:forged",
    authorizationRef: job.scopeBinding.authorizationRef,
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW,
    settlement: {
      jobId: job.jobId,
      workerId: worker.workerId,
      leaseId: "lease:c1-paid-keyword",
      status: "completed",
      externalRequestState: "succeeded",
      resultRef: resultEnvelope.resultRef,
      resultEnvelope,
      failureClass: null,
      externalRequestRef: "request:c1-paid-keyword:1"
    },
    expectedJobScopeBinding: job.scopeBinding
  }), /BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("C1 paid keyword completed payload含未知嵌套字段时拒绝并回滚", async () => {
  const candidate = await c1PaidKeywordReadyCandidate();
  const repository = c1PaidKeywordRepository({ candidate });
  const { job, worker } = await enqueueAndStartC1PaidKeywordJob(repository, candidate);
  const enqueuedCandidate = (await repository.readSnapshot()).candidates[0];
  const prepared = await c1PaidKeywordPreparedPayload({ job, candidate: enqueuedCandidate });
  prepared.result.providerDebug = { traceRef: "debug:unexpected" };
  const resultEnvelope = createSoftwareJobResultEnvelope({
    job,
    resultRef: "receipt:c1-paid-keyword:unexpected-payload",
    payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    payload: {
      schemaVersion: "c1-paid-keyword-evidence-worker-result-v1",
      prepared,
      triggerReceipt: null,
      providerReceipt: c1PaidKeywordFixtureReceipt()
    },
    recordedAt: KEYWORD_NOW,
    applicationDisposition: "applied"
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: c1PaidKeywordWorkerActor(),
    requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence",
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    expectedRevision: job.revision,
    idempotencyKey: "settle:c1-paid-keyword:unexpected-payload",
    inputFingerprint: "c1-paid-keyword-settlement-unexpected-payload",
    auditEventId: "audit:settle:c1-paid-keyword:unexpected-payload",
    authorizationRef: job.scopeBinding.authorizationRef,
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW,
    settlement: {
      jobId: job.jobId,
      workerId: worker.workerId,
      leaseId: "lease:c1-paid-keyword",
      status: "completed",
      externalRequestState: "succeeded",
      resultRef: resultEnvelope.resultRef,
      resultEnvelope,
      failureClass: null,
      externalRequestRef: "request:c1-paid-keyword:1"
    },
    expectedJobScopeBinding: job.scopeBinding
  }), /BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("C1 paid keyword旧revision完成回执只收口作业，不回写候选证据或推进下游", async () => {
  const candidate = await c1PaidKeywordReadyCandidate();
  const repository = c1PaidKeywordRepository({ candidate });
  const { job, worker } = await enqueueAndStartC1PaidKeywordJob(repository, candidate);
  await repository.transact(async (document) => {
    document.candidates[0].dataRevision = job.revision + 1;
    document.candidates[0].lifecycleV11.c1KeywordInterveningOwnerEditV1 = { observedAt: KEYWORD_NOW };
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  const resultEnvelope = await c1PaidKeywordResultEnvelope({ job, candidate: before.candidates[0] });
  const result = await executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: c1PaidKeywordWorkerActor(),
    requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence",
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    expectedRevision: job.revision,
    idempotencyKey: "settle:c1-paid-keyword:old-revision",
    inputFingerprint: "c1-paid-keyword-settlement-old-revision",
    auditEventId: "audit:settle:c1-paid-keyword:old-revision",
    authorizationRef: job.scopeBinding.authorizationRef,
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW,
    settlement: {
      jobId: job.jobId,
      workerId: worker.workerId,
      leaseId: "lease:c1-paid-keyword",
      status: "completed",
      externalRequestState: "succeeded",
      resultRef: resultEnvelope.resultRef,
      resultEnvelope,
      failureClass: null,
      externalRequestRef: "request:c1-paid-keyword:1"
    },
    expectedJobScopeBinding: job.scopeBinding
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(result.result, {
    status: "completed",
    candidateRevisionUnchanged: true,
    applicationDisposition: "revision_conflict_not_applied",
    productionAuthorizationCreated: false,
    dHandoffCreated: false,
    productionPlanCreated: false,
    executionIntentCreated: false,
    platformWrites: 0,
    softwareJobRef: {
      jobId: job.jobId,
      jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      candidateId: job.candidateId,
      skuPackageId: job.skuPackageId,
      revision: job.revision
    },
    resultEnvelope: {
      ...structuredClone(resultEnvelope),
      applicationDisposition: "revision_conflict_not_applied"
    }
  });
  const after = await repository.readSnapshot();
  assert.deepEqual(after.candidates[0], before.candidates[0]);
  assert.equal(after.runtime.softwareJobs[0].status, "completed");
  assert.equal(after.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "revision_conflict_not_applied");
});

test("SoftwareJob settlement未过期时锁内serverClock统一驱动job、audit和幂等时间", async () => {
  const settledAt = "2026-08-25T04:00:30.000Z";
  const repository = transportCandidateRepository();
  await enqueueTransportTransaction(repository);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => NOW,
    workerRegistry: transportWorkerRegistry()
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-transport-1", capabilities: ["stable-asset-transport"], version: "1.0.0", observedAt: NOW
  });
  await store.claim({ jobId: transportJob().jobId, worker, leaseId: "lease-valid-settle", leaseDurationMs: 60_000 });
  const candidateBefore = (await repository.readSnapshot()).candidates[0];
  const workerActor = createActorContext({
    userId: worker.workerId, sessionId: "session-valid-settle", actorType: "worker", roles: ["operator"], source: "worker", authenticatedAt: NOW
  });
  const { clock, set, calls } = mutableCountedClock(NOW);
  const { release, blocker } = await holdRepositoryQueue(repository);
  const pending = executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: workerActor,
    requiredRoles: ["operator"],
    action: "settle_c2_stable_asset_transport",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 8,
    idempotencyKey: "settle:valid-failed",
    inputFingerprint: "valid-failed:fingerprint",
    auditEventId: "audit:settle:valid-failed",
    authorizationRef: transportJob().scopeBinding.authorizationRef,
    serverTime: NOW,
    serverClock: clock,
    settlement: {
      jobId: transportJob().jobId,
      workerId: worker.workerId,
      leaseId: "lease-valid-settle",
      status: "failed",
      externalRequestState: "not_sent",
      failureClass: "transport_failed_before_request",
      externalRequestRef: null
    },
    expectedJobScopeBinding: transportJob().scopeBinding
  });
  assert.equal(calls(), 0);
  set(settledAt);
  release();
  await blocker;
  const result = await pending;
  assert.equal(calls(), 1);
  assert.equal(result.status, "committed");
  const stored = await repository.readSnapshot();
  const job = stored.runtime.softwareJobs[0];
  assert.deepEqual(stored.candidates[0], candidateBefore);
  assert.deepEqual([job.status, job.externalRequestState, job.lastProgressAt, job.completedAt], ["failed", "not_sent", settledAt, settledAt]);
  assert.equal(stored.runtime.operationAudit[0].serverTime, NOW);
  assert.equal(stored.runtime.operationAudit.at(-1).serverTime, settledAt);
  assert.equal(stored.runtime.idempotencyRecords.at(-1).recordedAt, settledAt);
});

test("伪造completed不能由事务调用方结果冒充，failed与unknown只收口作业且候选逐字不变", async () => {
  {
    const repository = transportCandidateRepository();
    await enqueueTransportTransaction(repository);
    const store = createRepositoryBackedSoftwareJobStore({
      businessStateRepository: repository,
      serverClock: () => NOW,
      workerRegistry: transportWorkerRegistry()
    });
    const worker = createWorkerDescriptor({
      workerId: "worker-transport-1", capabilities: ["stable-asset-transport"], version: "1.0.0", observedAt: NOW
    });
    await store.claim({ jobId: transportJob().jobId, worker, leaseId: "lease-completed", leaseDurationMs: 60_000 });
    await store.markExternalRequestStarted({
      jobId: transportJob().jobId,
      workerId: worker.workerId,
      leaseId: "lease-completed",
      externalRequestRef: "request:completed"
    });
    const before = await repository.readSnapshot();
    const forgedEnvelope = await completedEnvelope(repository);
    await assert.rejects(() => executeSoftwareJobSettlementMutation({
      repository,
      runtimeMode: "local_development",
      actor: createActorContext({
        userId: "worker-transport-1", sessionId: "session-completed", actorType: "worker", roles: ["operator"],
        source: "worker", authenticatedAt: NOW
      }),
      requiredRoles: ["operator"],
      action: "settle_c2_stable_asset_transport",
      candidateId: "C-1",
      skuPackageId: "sku:C-1:S-1",
      expectedRevision: 8,
      idempotencyKey: "settle:completed",
      inputFingerprint: "completed:fingerprint",
      auditEventId: "audit:settle:completed",
      authorizationRef: transportJob().scopeBinding.authorizationRef,
      serverTime: NOW,
      serverClock: () => NOW,
      settlement: {
        jobId: transportJob().jobId,
        workerId: "worker-transport-1",
        leaseId: "lease-completed",
        status: "completed",
        externalRequestState: "succeeded",
        resultRef: "receipt:c2-transport:1",
        resultEnvelope: forgedEnvelope,
        failureClass: null,
        externalRequestRef: "request:completed"
      },
      expectedJobScopeBinding: transportJob().scopeBinding,
      completedCandidateOutcome: {
        candidate: { ...before.candidates[0], workflowStatus: "c2_ready" },
        result: { status: "verified" }
      }
    }), /C2_STABLE_TRANSPORT|C2素材包校验失败/);
    assert.deepEqual(await repository.readSnapshot(), before);

    const cyclicEnvelope = structuredClone(forgedEnvelope);
    cyclicEnvelope.payload = { schemaVersion: "test-c2-stable-asset-result-v1" };
    cyclicEnvelope.payload.self = cyclicEnvelope.payload;
    cyclicEnvelope.payloadFingerprint = "0".repeat(64);
    await assert.rejects(() => executeSoftwareJobSettlementMutation({
      repository,
      runtimeMode: "local_development",
      actor: createActorContext({
        userId: "worker-transport-1", sessionId: "session-cyclic-envelope", actorType: "worker", roles: ["operator"],
        source: "worker", authenticatedAt: NOW
      }),
      requiredRoles: ["operator"],
      action: "settle_c2_stable_asset_transport",
      candidateId: "C-1",
      skuPackageId: "sku:C-1:S-1",
      expectedRevision: 8,
      idempotencyKey: "settle:cyclic-envelope",
      inputFingerprint: "cyclic-envelope:fingerprint",
      auditEventId: "audit:settle:cyclic-envelope",
      authorizationRef: transportJob().scopeBinding.authorizationRef,
      serverTime: NOW,
      serverClock: () => NOW,
      settlement: {
        jobId: transportJob().jobId,
        workerId: "worker-transport-1",
        leaseId: "lease-completed",
        status: "completed",
        externalRequestState: "succeeded",
        resultRef: "receipt:c2-transport:cyclic",
        resultEnvelope: cyclicEnvelope,
        failureClass: null,
        externalRequestRef: "request:completed"
      },
      expectedJobScopeBinding: transportJob().scopeBinding
    }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);
    assert.deepEqual(await repository.readSnapshot(), before);

    const oversizedEnvelope = structuredClone(forgedEnvelope);
    oversizedEnvelope.payload = {
      schemaVersion: "test-c2-stable-asset-result-v1",
      value: "x".repeat(65_537)
    };
    oversizedEnvelope.payloadFingerprint = "0".repeat(64);
    await assert.rejects(() => executeSoftwareJobSettlementMutation({
      repository,
      runtimeMode: "local_development",
      actor: createActorContext({
        userId: "worker-transport-1", sessionId: "session-oversized-envelope", actorType: "worker", roles: ["operator"],
        source: "worker", authenticatedAt: NOW
      }),
      requiredRoles: ["operator"],
      action: "settle_c2_stable_asset_transport",
      candidateId: "C-1",
      skuPackageId: "sku:C-1:S-1",
      expectedRevision: 8,
      idempotencyKey: "settle:oversized-envelope",
      inputFingerprint: "oversized-envelope:fingerprint",
      auditEventId: "audit:settle:oversized-envelope",
      authorizationRef: transportJob().scopeBinding.authorizationRef,
      serverTime: NOW,
      serverClock: () => NOW,
      settlement: {
        jobId: transportJob().jobId,
        workerId: "worker-transport-1",
        leaseId: "lease-completed",
        status: "completed",
        externalRequestState: "succeeded",
        resultRef: "receipt:c2-transport:oversized",
        resultEnvelope: oversizedEnvelope,
        failureClass: null,
        externalRequestRef: "request:completed"
      },
      expectedJobScopeBinding: transportJob().scopeBinding
    }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);
    assert.deepEqual(await repository.readSnapshot(), before);
  }

  for (const terminal of ["failed", "unknown_outcome"]) {
    const repository = transportCandidateRepository();
    await enqueueTransportTransaction(repository);
    const store = createRepositoryBackedSoftwareJobStore({
      businessStateRepository: repository,
      serverClock: () => NOW,
      workerRegistry: transportWorkerRegistry()
    });
    const worker = createWorkerDescriptor({
      workerId: "worker-transport-1", capabilities: ["stable-asset-transport"], version: "1.0.0", observedAt: NOW
    });
    await store.claim({ jobId: transportJob().jobId, worker, leaseId: `lease-${terminal}`, leaseDurationMs: 60_000 });
    await store.markExternalRequestStarted({
      jobId: transportJob().jobId,
      workerId: worker.workerId,
      leaseId: `lease-${terminal}`,
      externalRequestRef: `request:${terminal}`
    });
    const candidateBefore = (await repository.readSnapshot()).candidates[0];
    const workerActor = createActorContext({
      userId: "worker-transport-1", sessionId: `session-${terminal}`, actorType: "worker", roles: ["operator"],
      source: "worker", authenticatedAt: NOW
    });
    const result = await executeSoftwareJobSettlementMutation({
      repository,
      runtimeMode: "local_development",
      actor: workerActor,
      requiredRoles: ["operator"],
      action: "settle_c2_stable_asset_transport",
      candidateId: "C-1",
      skuPackageId: "sku:C-1:S-1",
      expectedRevision: 8,
      idempotencyKey: `settle:${terminal}`,
      inputFingerprint: `${terminal}:fingerprint`,
      auditEventId: `audit:settle:${terminal}`,
      authorizationRef: transportJob().scopeBinding.authorizationRef,
      serverTime: NOW,
      serverClock: () => NOW,
      settlement: {
        jobId: transportJob().jobId,
        workerId: "worker-transport-1",
        leaseId: `lease-${terminal}`,
        status: terminal,
        externalRequestState: terminal === "completed" ? "succeeded" : terminal === "unknown_outcome" ? "unknown_outcome" : "failed",
        resultRef: terminal === "completed" ? "receipt:c2-transport:1" : null,
        resultEnvelope: terminal === "completed" ? await completedEnvelope(repository) : null,
        failureClass: terminal === "failed" ? "transport_failed" : null,
        externalRequestRef: `request:${terminal}`
      },
      expectedJobScopeBinding: transportJob().scopeBinding,
      completedCandidateOutcome: null
    });
    assert.equal(result.status, "committed");
    const candidateAfter = (await repository.readSnapshot()).candidates[0];
    assert.deepEqual(candidateAfter, candidateBefore);
  }
});

test("旧candidate revision下伪造completed拒绝且回滚，failed仍只收口作业", async () => {
  const repository = transportCandidateRepository();
  await enqueueTransportTransaction(repository);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => NOW,
    workerRegistry: transportWorkerRegistry()
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-transport-1", capabilities: ["stable-asset-transport"], version: "1.0.0", observedAt: NOW
  });
  await store.claim({ jobId: transportJob().jobId, worker, leaseId: "lease-old", leaseDurationMs: 60_000 });
  await store.markExternalRequestStarted({
    jobId: transportJob().jobId,
    workerId: worker.workerId,
    leaseId: "lease-old",
    externalRequestRef: "request:old"
  });
  await repository.transact(async (document) => {
    document.candidates[0].dataRevision = 9;
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  const workerActor = createActorContext({
    userId: worker.workerId, sessionId: "session-old", actorType: "worker", roles: ["operator"], source: "worker", authenticatedAt: NOW
  });
  const base = {
    repository,
    runtimeMode: "local_development",
    actor: workerActor,
    requiredRoles: ["operator"],
    action: "settle_c2_stable_asset_transport",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    expectedRevision: 8,
    auditEventId: "audit:settle:old",
    authorizationRef: transportJob().scopeBinding.authorizationRef,
    serverTime: NOW,
    serverClock: () => NOW,
    mutateCompleted: ({ candidate }) => ({ candidate, result: { status: "verified" } })
  };
  const completedEnvelopeForOldRevision = await completedEnvelope(repository, {
    resultRef: "receipt:old",
    applicationDisposition: "applied"
  });
  await assert.rejects(() => executeSoftwareJobSettlementMutation({
    ...base,
    idempotencyKey: "settle:old:completed",
    inputFingerprint: "old-completed",
    settlement: {
      jobId: transportJob().jobId, workerId: worker.workerId, leaseId: "lease-old",
      status: "completed", externalRequestState: "succeeded", resultRef: "receipt:old",
      resultEnvelope: completedEnvelopeForOldRevision,
      externalRequestRef: "request:old"
    },
    expectedJobScopeBinding: transportJob().scopeBinding,
    completedCandidateOutcome: { candidate: before.candidates[0], result: { status: "verified" } }
  }), /C2_STABLE_TRANSPORT|C2素材包校验失败/);
  assert.deepEqual(await repository.readSnapshot(), before);

  const failedRepository = transportCandidateRepository();
  await enqueueTransportTransaction(failedRepository);
  const failedStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: failedRepository,
    serverClock: () => NOW,
    workerRegistry: transportWorkerRegistry()
  });
  await failedStore.claim({ jobId: transportJob().jobId, worker, leaseId: "lease-failed-old", leaseDurationMs: 60_000 });
  await failedStore.markExternalRequestStarted({
    jobId: transportJob().jobId,
    workerId: worker.workerId,
    leaseId: "lease-failed-old",
    externalRequestRef: "request:failed-old"
  });
  await failedRepository.transact(async (document) => {
    document.candidates[0].dataRevision = 9;
    return { changed: true, document, result: null };
  });
  const failedBefore = await failedRepository.readSnapshot();
  const failed = await executeSoftwareJobSettlementMutation({
    ...base,
    repository: failedRepository,
    idempotencyKey: "settle:old:failed",
    inputFingerprint: "old-failed",
    settlement: {
      jobId: transportJob().jobId, workerId: worker.workerId, leaseId: "lease-failed-old",
      status: "failed", externalRequestState: "failed", failureClass: "transport_failed", externalRequestRef: "request:failed-old"
    },
    expectedJobScopeBinding: transportJob().scopeBinding
  });
  assert.equal(failed.status, "committed");
  assert.deepEqual((await failedRepository.readSnapshot()).candidates[0], failedBefore.candidates[0]);
});

 test('business mutation reads current commission catalogs under lock and never writes callback-owned catalog copies', async () => {
  const repository = setup();
  const active = { platform: 'wb', sellerRegion: 'CN', catalogId: 'synthetic-wb-catalog', catalogVersion: 'synthetic-v1', status: 'active' };
  await repository.transact(document => { document.currentCommissionCatalogs = [active]; return { changed: true, document }; });
  const preparedSnapshot = await repository.readSnapshot();
  await repository.transact(document => { document.currentCommissionCatalogs[0].status = 'invalidated'; return { changed: true, document }; });
  const before = await repository.readSnapshot();
  assert.equal(preparedSnapshot.currentCommissionCatalogs[0].status, 'active');
  await assert.rejects(executeBusinessMutation(input(repository, {
    mutate: ({ currentCommissionCatalogs }) => {
      assert.deepEqual(currentCommissionCatalogs, [{ ...active, status: 'invalidated' }]);
      throw new Error('SYNTHETIC_CURRENT_COMMISSION_CATALOG_INVALIDATED');
    }
  })), /SYNTHETIC_CURRENT_COMMISSION_CATALOG_INVALIDATED/);
  assert.deepEqual(await repository.readSnapshot(), before);
  await executeBusinessMutation(input(repository, {
    mutate: ({ candidate, currentCommissionCatalogs }) => {
      currentCommissionCatalogs[0].status = 'active';
      currentCommissionCatalogs.push({ ...active, catalogId: 'callback-owned-injection' });
      return { candidate, result: { status: 'catalog-gap-reviewed' } };
    }
  }));
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.currentCommissionCatalogs, before.currentCommissionCatalogs);
  assert.equal(saved.candidates[0].dataRevision, before.candidates[0].dataRevision + 1);
});

function preparationHistoryJob() {
  const binding = { scopeRef: 'discovery:synthetic', bindingId: 'binding:synthetic', configurationVersion: 'config:synthetic',
    platform: 'ozon', targetStore: 'miska', storeIdentityStatus: 'unverified', credentialAlias: 'alias:synthetic',
    clientIdRef: 'client:synthetic', officialContractRefs: { roles: 'official:roles', seller_info: 'official:seller', warehouse_list: 'official:warehouse' } };
  const preparation = { schemaVersion: 'ozon-account-preparation-v1', preparationId: 'preparation:synthetic', revision: 0,
    createdByUserId: 'owner:synthetic', createdAt: NOW, updatedAt: NOW, binding, warehouseSelections: [] };
  const scope = createOzonAccountDiscoveryScope({ preparation, binding, authorizationRef: 'permission:synthetic', expiresAt: '2026-09-08T01:00:00.000Z' });
  return createSoftwareJobEnvelope({ jobId: 'job:preparation:synthetic', subject: scope.subject, revision: 0, jobType: 'ozon_account_read',
    createdAt: NOW, requestedByUserId: 'owner:synthetic', ownerUserId: 'owner:synthetic', requiredCapabilities: ['ozon-account-read'],
    idempotencyKey: 'preparation:synthetic:once', scopeBinding: scope });
}

test('关联作业读取允许v1/v2与真实合成Seerfar完成v3混存，仅返回目标SKU', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create(), created = await f.prepare(service);
  await f.authorize(service, created);
  const seerfar = (await f.repository.readSnapshot()).runtime.softwareJobs[0];
  assert.equal(seerfar.schemaVersion, 'software-job-v3');
  assert.equal(seerfar.status, 'completed');
  const preparation = preparationHistoryJob();
  assert.equal(preparation.schemaVersion, 'software-job-v2');
  const related = transportJob(), otherInput = transportJobInput();
  otherInput.jobId = 'job:unrelated:v1'; otherInput.candidateId = 'candidate:other'; otherInput.skuPackageId = 'sku:other';
  otherInput.idempotencyKey = 'candidate:other:7:c2-transport';
  otherInput.scopeBinding.candidateId = otherInput.candidateId; otherInput.scopeBinding.skuPackageId = otherInput.skuPackageId;
  const other = createSoftwareJobEnvelope({ ...otherInput, createdAt: NOW });
  const jobs = [seerfar, preparation, related, other], repository = setup();
  await repository.transact(document => { document.runtime = { softwareJobs: jobs }; return { changed: true, document, result: null }; });
  await executeBusinessMutation(input(repository, { includeRelatedSoftwareJobs: true, mutate: ({ candidate, relatedSoftwareJobs }) => {
    assert.deepEqual(relatedSoftwareJobs, [related]);
    return { candidate, result: { relatedJobIds: relatedSoftwareJobs.map(job => job.jobId) } };
  } }));
  assert.deepEqual((await repository.readSnapshot()).runtime.softwareJobs, jobs);
});

// A job bound to another candidate is that candidate's record and is not read here (AGENTS 3.4); a corrupt job this
// candidate's action can see (its own, or one bound to no candidate) still stops it.
test('未知作业版本或损坏subject身份不能被跳过，事务不写入', async () => {
  for (const mutate of [job => { job.schemaVersion = 'software-job-v99'; },
    job => { job.subject.revision += 1; }, job => { job.candidateId = 'C-1'; }]) {
    const repository = setup(), job = structuredClone(preparationHistoryJob()); mutate(job);
    await repository.transact(document => { document.runtime = { softwareJobs: [job] }; return { changed: true, document, result: null }; });
    const before = await repository.readSnapshot();
    await assert.rejects(executeBusinessMutation(input(repository, { includeRelatedSoftwareJobs: true })), /BUSINESS_MUTATION_JOB_CONTEXT_INVALID|SOFTWARE_JOB_|OZON_ACCOUNT_/);
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});


test("同候选preSKU v3作业仍进入关联上下文，不能因无sku字段漏过活跃作业", async () => {
  const repository = setup(), base = createAProductDetailContractFixture().scope;
  const make = candidateId => createAProductDetailJobForScope({ scope: { ...base, candidateId, sourceRevision: 7, resultRevision: 7 },
    ownerUserId: "owner:synthetic", createdAt: NOW });
  const related = make("C-1"), unrelated = make("C-other");
  await repository.transact(document => { document.runtime = { softwareJobs: [related, unrelated] }; return { changed: true, document, result: null }; });
  await executeBusinessMutation(input(repository, { includeRelatedSoftwareJobs: true, mutate: ({ candidate, relatedSoftwareJobs }) => {
    assert.deepEqual(relatedSoftwareJobs, [related]);
    assert.equal(relatedSoftwareJobs[0].status, "queued");
    assert.equal(Object.hasOwn(relatedSoftwareJobs[0], "skuPackageId"), false);
    return { candidate, result: { observed: related.jobId } };
  } }));
});
