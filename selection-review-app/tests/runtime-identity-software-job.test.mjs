import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  assertSafeRuntimeRecord,
  assertRuntimeProductionEntityReferenceContext,
  createActorContext,
  createLocalDevelopmentActor,
  createOperationAuditEvent,
  createWorkerDescriptor
} from "../lib/runtime-identity.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_CAPABILITY,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER,
  claimSoftwareJobLease,
  createSoftwareJobEnvelope,
  markSoftwareJobExternalRequestStarted,
  settleSoftwareJob
} from "../lib/software-job-contract.mjs";

import { authorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";
import { createProductionPlan } from "../lib/production-plan.mjs";
import { normalizeProductionEntities, restoreProductionEntities } from "../lib/production-entity-storage.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";

const NOW = "2026-08-25T02:00:00.000Z";

test("身份与作业Schema冻结多人运行必需字段", async () => {
  const identitySchema = JSON.parse(await readFile(new URL("../schema/runtime-identity-v1.schema.json", import.meta.url), "utf8"));
  const jobSchema = JSON.parse(await readFile(new URL("../schema/software-job-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(identitySchema.$defs.actorContext.required, [
    "schemaVersion", "userId", "sessionId", "actorType", "roles", "source", "authenticatedAt"
  ]);
  for (const field of [
    "ownerUserId", "workerId", "workerVersion", "workerCapabilitiesSnapshot", "leaseExpiresAt",
    "idempotencyKey", "externalRequestState", "resultEnvelope", "admissionDecision"
  ]) {
    assert.ok(jobSchema.required.includes(field), field);
  }
  assert.ok(jobSchema.required.includes("scopeBinding"));
  assert.ok(jobSchema.properties.status.enum.includes("waiting_platform"));
  assert.equal(jobSchema.properties.resultEnvelope.oneOf[1].$ref, "software-job-admission-v1.schema.json#/$defs/softwareJobResultEnvelope");
  assert.ok(jobSchema.properties.requiredCapabilities.items.enum.includes("stable-asset-transport"));
  assert.ok(identitySchema.$defs.workerDescriptor.properties.capabilities.items.enum.includes("stable-asset-transport"));
  assert.equal(jobSchema.properties.automaticRetryAllowed.const, false);
  const localFailureRule = jobSchema.allOf.find((rule) => rule.if.properties.status?.const === "failed");
  assert.deepEqual(localFailureRule.if, { properties: { status: { const: "failed" }, externalRequestState: { const: "succeeded" } }, required: ["status", "externalRequestState"] });
  assert.equal(jobSchema.additionalProperties, false);
  assert.deepEqual(localFailureRule.then, {
    oneOf: [
      { properties: {
        jobType: { const: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE },
        failureClass: { const: "c1-paid-keyword-local-preparation-failed" },
        resultRef: { type: "null" }, resultEnvelope: { type: "null" }
      } },
      { properties: {
        jobType: { const: "ozon_account_read" },
        failureClass: { $ref: "#/$defs/strictRef" },
        resultRef: { type: "null" }, resultEnvelope: { type: "null" }
      } },
      { properties: {
        jobType: { const: "c1_ai_draft" },
        resultEnvelope: { $ref: "software-job-admission-v1.schema.json#/$defs/softwareJobResultEnvelope" }
      } },
      { properties: {
        jobType: { const: "d_production_execution" },
        failureClass: { enum: [
          "d-production-prewrite-rejected", "d-production-preflight-not-ready",
          "d-production-preparation-context-changed", "d-production-local-preflight-unavailable",
          "d-assets-source-conflict", "d-error-before-external-request"
        ] },
        resultRef: { type: "null" }, resultEnvelope: { type: "null" }
      } },
      { required: ["platformContinuation"], properties: {
        jobType: { const: "d_production_execution" },
        resultEnvelope: { $ref: "#/$defs/dPlatformStopResultEnvelope" },
        failureClass: { $ref: "#/$defs/strictRef" },
        platformContinuation: { $ref: "d-software-execution-state-v2.schema.json#/$defs/platformContinuation" }
      } }
    ]
  });
});

function job() {
  const scopeBinding = {
    schemaVersion: "software-job-scope-v1",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    sourceRevision: 23,
    resultRevision: 24,
    platform: "ozon",
    targetStore: "dandanshu",
    supplierSkuId: "supplier-sku-1",
    variantKey: "white",
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationRef: "c1-paid-keyword-authz-runtime",
    credentialAlias: "seerfar-open-api-alias-runtime",
    inputFingerprint: "a".repeat(64),
    planningEvidenceFingerprint: "b".repeat(64),
    runtimeInputFingerprint: "c".repeat(64),
    seerfarRequestFingerprint: "d".repeat(64),
    salesSnapshotFingerprint: "e".repeat(64),
    supplySnapshotFingerprint: "f".repeat(64),
    profitModelFingerprint: "1".repeat(64),
    c1FactsFingerprint: "2".repeat(64),
    pointBudgetEvidenceRef: "config:seerfar-budget-15",
    quotaEvidenceRef: "seerfar-quota:80",
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    provider: C1_PAID_KEYWORD_PROVIDER
  };
  return createSoftwareJobEnvelope({
    jobId: "job:C-1:24:c1-keyword",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    revision: 24,
    jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    createdAt: NOW,
    requestedByUserId: "owner-1",
    ownerUserId: "operator-1",
    requiredCapabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    idempotencyKey: "C-1:24:c1_paid_keyword_evidence",
    scopeBinding
  });
}

test("开发身份是显式身份而非匿名owner，正式审计记录用户、角色、revision和外部终态", () => {
  const actor = createLocalDevelopmentActor({ at: NOW });
  assert.equal(actor.userId, "local-development-owner");
  assert.equal(actor.source, "development_default");
  const event = createOperationAuditEvent({
    eventId: "audit-1",
    action: "confirm_supply",
    actor,
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    sourceRevision: 24,
    resultRevision: 25,
    fromState: "a_waiting_owner",
    toState: "b_ready",
    authorizationRef: "owner-confirmation-1",
    externalRequestState: "not_sent",
    idempotencyKey: "C-1:24:confirm_supply",
    serverTime: NOW
  });
  assert.deepEqual([event.actor.userId, event.sourceRevision, event.resultRevision, event.externalRequestState], ["local-development-owner", 24, 25, "not_sent"]);
  assert.throws(() => createActorContext({
    userId: "owner", sessionId: "session", actorType: "human", roles: ["owner"], source: "cookie: secret", authenticatedAt: NOW
  }), /不得包含秘密/);
  assert.throws(() => createOperationAuditEvent({
    eventId: "audit-secret",
    action: "confirm_supply",
    actor,
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    sourceRevision: 24,
    resultRevision: 25,
    fromState: "a_waiting_owner",
    toState: "b_ready",
    externalRequestRef: "https://service.example/result?access_token=secret-value",
    idempotencyKey: "C-1:24:confirm_supply",
    serverTime: NOW
  }), /不得包含秘密/);
  for (const unsafe of [
    { accessToken: "secret-value" },
    { clientSecret: "secret-value" },
    { cookieJar: { session: "secret-value" } },
    { safeRef: "https://service.example/result?X-Amz-Credential=secret-value" },
    { resultRef: "file:///tmp/result.json" },
    { resultRef: "file%3A%2F%2F%2Ftmp%2Fresult.json" },
    { externalRequestRef: "/Users/example/request.json" },
    { externalRequestRef: "%2FUsers%2Fexample%2Frequest.json" },
    { evidenceRef: "http://localhost:4173/result" },
    { evidenceRef: "https%3A%2F%2Flocalhost%3A4173%2Fresult" }
  ]) assert.throws(() => assertSafeRuntimeRecord(unsafe), /不得.*秘密|不得保存本机路径或回环地址/);
});

test("只有能力匹配的Worker可领取，租约由中央服务时间生成且同一作业只能尝试一次", () => {
  const wrongWorker = createWorkerDescriptor({
    workerId: "worker-image", capabilities: ["image-processing"], version: "1.0.0", observedAt: NOW
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version: "1.0.0", observedAt: NOW
  });
  assert.throws(() => claimSoftwareJobLease({ job: job(), worker: wrongWorker, leaseId: "lease-1", serverTime: NOW, leaseDurationMs: 60_000 }), /能力或状态不满足/);

  const claimed = claimSoftwareJobLease({ job: job(), worker, leaseId: "lease-1", serverTime: NOW, leaseDurationMs: 60_000 });
  assert.deepEqual([claimed.status, claimed.workerId, claimed.attempt, claimed.leaseExpiresAt], ["claimed", "worker-seerfar-open-api-1", 1, "2026-08-25T02:01:00.000Z"]);
  assert.equal(claimed.workerVersion, "1.0.0");
  assert.deepEqual(claimed.workerCapabilitiesSnapshot, [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY]);
  assert.throws(() => claimSoftwareJobLease({ job: claimed, worker, leaseId: "lease-2", serverTime: NOW, leaseDurationMs: 60_000 }), /不是可领取状态/);
  assert.throws(() => settleSoftwareJob({
    job: claimed,
    workerId: "worker-seerfar-open-api-1",
    leaseId: "lease-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:premature",
    serverTime: NOW
  }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED|in_flight/);
  assert.throws(() => settleSoftwareJob({
    job: claimed, workerId: "worker-other", leaseId: "lease-1", status: "completed", externalRequestState: "succeeded", serverTime: NOW
  }), /Worker或租约不匹配/);
});

test("Worker掉线后的结果未知必须持久化unknown_outcome且禁止自动重试", () => {
  const worker = createWorkerDescriptor({
    workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version: "1.0.0", observedAt: NOW
  });
  const claimed = claimSoftwareJobLease({ job: job(), worker, leaseId: "lease-1", serverTime: NOW, leaseDurationMs: 60_000 });
  const inFlight = markSoftwareJobExternalRequestStarted({
    job: claimed,
    workerId: "worker-seerfar-open-api-1",
    leaseId: "lease-1",
    externalRequestRef: "request:worker-seerfar-open-api:1",
    serverTime: NOW
  });
  const settled = settleSoftwareJob({
    job: inFlight,
    workerId: "worker-seerfar-open-api-1",
    leaseId: "lease-1",
    status: "unknown_outcome",
    externalRequestState: "unknown_outcome",
    externalRequestRef: "request:worker-seerfar-open-api:1",
    serverTime: "2026-08-25T02:00:20.000Z"
  });
  assert.equal(settled.status, "unknown_outcome");
  assert.equal(settled.automaticRetryAllowed, false);
  assert.equal(settled.attempt, 1);
});

test("仅C1明确外部成功后的本地准备失败保留succeeded，不可冒充领域完成", () => {
  const worker = createWorkerDescriptor({ workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version: "1.0.0", observedAt: NOW });
  const claimed = claimSoftwareJobLease({ job: job(), worker, leaseId: "lease-1", serverTime: NOW, leaseDurationMs: 60_000 });
  const inFlight = markSoftwareJobExternalRequestStarted({ job: claimed, workerId: worker.workerId, leaseId: "lease-1", externalRequestRef: "request:c1:1", serverTime: NOW });
  const input = { job: inFlight, workerId: worker.workerId, leaseId: "lease-1", status: "failed", externalRequestState: "succeeded", failureClass: "c1-paid-keyword-local-preparation-failed", serverTime: NOW };
  const result = settleSoftwareJob(input);
  assert.equal(result.status, "failed");
  assert.equal(result.externalRequestState, "succeeded");
  assert.equal(result.resultEnvelope, null);
  assert.equal(result.automaticRetryAllowed, false);
  assert.throws(() => settleSoftwareJob({ ...input, failureClass: "generic-failure" }), /失败态与/);
  assert.throws(() => settleSoftwareJob({ ...input, job: { ...inFlight, jobType: "c2_asset_generation" } }), /失败态与/);
  assert.throws(() => settleSoftwareJob({ ...input, job: claimed }), /失败态与/);
  assert.throws(() => settleSoftwareJob({ ...input, resultRef: "receipt:unvalidated" }), /失败态与/);
  assert.throws(() => settleSoftwareJob({ ...input, resultEnvelope: {} }), /失败态与/);
});


test("改价复用只识别声明的原授权引用，秘密与旁路字段仍拒绝", () => {
  const authorizationId = "authorization:c1-ai-draft:reuse-123";
  const ref = { providerJobRef: { authorizationRef: { authorizationId } } };
  const record = { schemaVersion: "c1-pricing-result-reuse-v1", sourcePlan: {
    draftOnlySeo: structuredClone(ref), seoEvidenceLayer: structuredClone(ref)
  }, settledExecution: { authorizedExecution: { authorizationRef: { authorizationId } } } };
  const plan = { schemaVersion: "c1-product-plan-v1.1", draftOnlySeo: { pricingReuseRecord: record } };
  assert.doesNotThrow(() => assertSafeRuntimeRecord(plan));
  const secret = structuredClone(plan);
  secret.draftOnlySeo.pricingReuseRecord.settledExecution.authorizedExecution.authorizationRef.authorizationId = "Bearer private-value";
  assert.throws(() => assertSafeRuntimeRecord(secret), /秘密|授权/);
  assert.throws(() => assertSafeRuntimeRecord({ ...plan, extra: { authorizationId } }), /秘密/);
  const unknown = structuredClone(plan);
  unknown.draftOnlySeo.pricingReuseRecord.schemaVersion = "c1-pricing-result-reuse-v999";
  assert.throws(() => assertSafeRuntimeRecord(unknown), /秘密/);
});

test("新版 D 容器只放行正式 C1 不透明授权路径，未知版本和旁路秘密仍拒绝", () => {
  const fixture = authorizedProductionFixture();
  const productionPlan = structuredClone(createProductionPlan(fixture));
  const sourceAuthorization = productionPlan.sourceAuthorization;
  const snapshot = sourceAuthorization.lockedScope.finalCardInputSnapshot;
  // Keep the real production identity and storage shape; isolate the opaque-ID safety classification.
  snapshot.c1Snapshot.seoEvidenceLayer = { providerJobRef: { authorizationRef: { authorizationId: "authorization:c1-ai-draft:opaque-123" } } };
  sourceAuthorization.sourceFinalCardInputFingerprint = fingerprintCanonicalRecord(snapshot);
  for (const schemaVersion of ["d-software-execution-state-v1", "d-software-execution-state-v2"]) {
    const state = { schemaVersion, productionPlan };
    assert.doesNotThrow(() => assertSafeRuntimeRecord(state));
    const packed = normalizeProductionEntities(state);
    assert.doesNotThrow(() => assertRuntimeProductionEntityReferenceContext(restoreProductionEntities(packed.value, packed.records)));
    assert.throws(() => assertRuntimeProductionEntityReferenceContext(restoreProductionEntities({ body: packed.value }, packed.records)), error =>
      error.message.startsWith("RUNTIME_IDENTITY_INVALID:") && error.cause.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"));
    assert.throws(() => assertSafeRuntimeRecord({ body: state }), error =>
      error.message.startsWith("RUNTIME_IDENTITY_INVALID:") && error.cause.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"));
    assert.doesNotThrow(() => assertSafeRuntimeRecord({ id: fixture.candidateId, lifecycleV11: { skuPackage: { g1Identity: structuredClone(sourceAuthorization.sourceIdentity), dSoftwareExecution: state } } }));
    assert.throws(() => assertSafeRuntimeRecord({ ...state, extra: { authorizationId: "authorization:c1-ai-draft:opaque-123" } }), /秘密/);
    const secret = structuredClone(state);
    secret.productionPlan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.seoEvidenceLayer.providerJobRef.authorizationRef.authorizationId = "Bearer private-value";
    assert.throws(() => assertSafeRuntimeRecord(secret), /秘密|授权/);
  }
  assert.throws(() => assertSafeRuntimeRecord({ schemaVersion: "d-software-execution-state-v999", productionPlan }), /秘密/);
});
