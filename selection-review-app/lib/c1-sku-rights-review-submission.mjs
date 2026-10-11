import { isDeepStrictEqual } from "node:util";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { assertValidC1ProductPlan, assertC1RightsReviewStage, normalizeC1SourceIdentity, replaceC1ProductPlanForRightsReview } from "./c1-product-plan.mjs";
import { C1SkuRightsReviewError, createC1SkuRightsReviewRecord, buildC1SkuRightsReviewRecordView } from "./c1-sku-rights-review.mjs";
import { isCanonicalFrozenRef, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { createActorContext } from "./runtime-identity.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { gate1AutopilotMayAct, isGate1AutopilotActor } from "./gate1-autopilot.mjs";
import { gate1RightsDeclarationCurrent, gate1RightsOwnerDeclaration } from "./gate1-rights-declaration.mjs";

const INPUT_FIELDS = ["candidateId", "skuPackageId", "expectedRevision", "idempotencyKey", "expectedC1PlanId", "replacesC1PlanId",
  "brand", "rights", "reviewedAt", "expiresAt"];
const GATE1_APPLY_FIELDS = ["candidateId", "skuPackageId", "expectedRevision", "expectedC1PlanId", "idempotencyKey", "auditEventId"];
const C1_JOB_TYPES = new Set(["c1_paid_keyword_evidence", "c1_ai_draft"]);
const C1_ARTIFACT_FIELDS = Object.freeze([
  "c1AiDraftRequestV1", "c1AiDraftJobRefV1", "c1KeywordPlanningEvidenceV1", "c1KeywordPlanningProductionV1",
  "c1KeywordPlanningLocalMaterialProductionV1", "c1KeywordPlanningLocalMaterialV1", "c1KeywordPlanningSourceRecordV1",
  "c1KeywordSoftwareJobPlanV1", "c1PaidKeywordEvidenceInputArtifactRefV1", "c1PaidKeywordEvidenceJobRefV1",
  "c1PaidKeywordEvidenceQueuedAt", "c1PaidKeywordEvidenceRuntimeInputV1", "c1PaidKeywordEvidenceSeerfarRequestV1",
  "c1PaidKeywordEvidenceSettlementV1", "keywordEvidenceSoftwareJobV1", "keywordEvidencePreparationV1",
  "k3KeywordEvidenceSnapshotV1", "k3CurrentBindingV1", "c1SoftwareEvidenceV1", "c1FactKeywordRuntimeReceiptV1",
  "c1KeywordEvidenceAutoTriggerV1"
]);

function reject(code) { throw new C1SkuRightsReviewError(code); }
function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function currentRef(value) {
  return isCanonicalFrozenRef(value) && !["unknown", "not_applicable", "null", "undefined", "missing"].includes(value.toLowerCase());
}

function assertInput(input) {
  if (!exact(input, INPUT_FIELDS) || !["candidateId", "skuPackageId", "idempotencyKey", "expectedC1PlanId"].every(field => currentRef(input[field])) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision === Number.MAX_SAFE_INTEGER ||
      (input.replacesC1PlanId !== null && !currentRef(input.replacesC1PlanId)) ||
      !exact(input.brand, ["status", "name"]) || !exact(input.rights, ["status", "basis"])) reject("C1_RIGHTS_INPUT_INVALID");
}

function assertCandidateScope(candidate, input) {
  const sku = candidate.lifecycleV11?.skuPackage;
  if (!sku || candidate.id !== input.candidateId || sku.skuPackageId !== input.skuPackageId) reject("C1_RIGHTS_SCOPE_MISMATCH");
  assertValidLifecyclePackage(sku);
  const plan = sku.c1ProductPlan;
  assertValidC1ProductPlan(plan);
  const identity = normalizeC1SourceIdentity(sku.g1Identity);
  if (identity.candidateId !== candidate.id || identity.skuPackageId !== sku.skuPackageId ||
      identity.supplierSkuId !== sku.supplierSkuId || identity.platform !== sku.targetPlatform ||
      candidate.targetPlatform !== sku.targetPlatform || candidate.targetStore !== sku.targetStore ||
      !sameStoreRef(candidate.storeRef, identity.storeRef) || plan.identity.skuPackageId !== sku.skuPackageId ||
      plan.identity.supplierSkuId !== sku.supplierSkuId || plan.identity.variantKey !== sku.variantKey ||
      plan.identity.targetPlatform !== sku.targetPlatform || plan.identity.targetStore !== sku.targetStore ||
      plan.frozenInputRefs?.candidateId !== candidate.id || !sameStoreRef(plan.inputSnapshots.platformSchemaRules.storeRef, identity.storeRef)) {
    reject("C1_RIGHTS_SCOPE_MISMATCH");
  }
  assertC1RightsReviewStage(sku);
  if (plan.c1PlanId !== input.expectedC1PlanId) reject("C1_RIGHTS_PLAN_CONFLICT");
  return sku;
}

function assertNoActiveC1Jobs(jobs, candidate, sku) {
  if (!Array.isArray(jobs)) reject("C1_RIGHTS_JOB_CONTEXT_REQUIRED");
  const relevant = new Map();
  for (const job of jobs) {
    if (!job || typeof job !== "object" || job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId) {
      reject("C1_RIGHTS_JOB_CONTEXT_INVALID");
    }
    if (!C1_JOB_TYPES.has(job.jobType)) continue;
    if (!currentRef(job.jobId) || relevant.has(job.jobId)) reject("C1_RIGHTS_JOB_CONTEXT_INVALID");
    relevant.set(job.jobId, job);
    if (!["completed", "failed"].includes(job.status) || !["not_sent", "failed", "succeeded"].includes(job.externalRequestState) ||
        (job.status === "completed" && job.externalRequestState !== "succeeded")) reject("C1_RIGHTS_ACTIVE_JOB_BLOCKED");
  }
  for (const field of ["c1AiDraftJobRefV1", "c1PaidKeywordEvidenceJobRefV1"]) {
    if (!Object.hasOwn(candidate.lifecycleV11, field)) continue;
    const reference = candidate.lifecycleV11[field];
    if (!reference || !relevant.has(reference.jobId)) reject("C1_RIGHTS_JOB_CONTEXT_INVALID");
  }
}

function archiveC1(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  const c1Artifacts = {};
  for (const field of C1_ARTIFACT_FIELDS) {
    if (Object.hasOwn(candidate.lifecycleV11, field)) c1Artifacts[field] = structuredClone(candidate.lifecycleV11[field]);
  }
  return { c1ProductPlan: structuredClone(sku.c1ProductPlan), sourceSkuRevision: sku.dataRevision,
    c1RightsReviewRecord: Object.hasOwn(sku, "c1RightsReviewRecord") ? structuredClone(sku.c1RightsReviewRecord) : null,
    listingPreparation: Object.hasOwn(candidate, "listingPreparation") ? structuredClone(candidate.listingPreparation) : null,
    c1Artifacts };
}

/** One authenticated declaration and, when explicitly requested, one new C1 review, in the existing transaction. */
export function createC1SkuRightsReviewUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode)) reject("C1_RIGHTS_RUNTIME_MODE_INVALID");
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  if (typeof serverClock !== "function") reject("C1_RIGHTS_SERVER_CLOCK_REQUIRED");
  return Object.freeze({
    async submit({ actor, input }) {
      if (actor?.actorType !== "human" || actor.source !== "authenticated_identity_provider" || !Array.isArray(actor.roles) || !actor.roles.includes("owner")) {
        reject("C1_RIGHTS_OWNER_REQUIRED");
      }
      const owner = createActorContext(actor);
      assertInput(input);
      const frozen = structuredClone(input);
      return executeBusinessMutation({ repository, runtimeMode, actor: owner, requiredRoles: ["owner"],
        action: "c1_sku_rights_review_submit", candidateId: frozen.candidateId, skuPackageId: frozen.skuPackageId,
        expectedRevision: frozen.expectedRevision, idempotencyKey: frozen.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord({ input: frozen, declaredByUserId: owner.userId }),
        auditEventId: `c1-rights-audit:${frozen.idempotencyKey}`, serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate, observedAt, relatedSoftwareJobs }) => {
          const before = assertCandidateScope(candidate, frozen);
          assertNoActiveC1Jobs(relatedSoftwareJobs, candidate, before);
          const isFrozen = before.c1ProductPlan.status !== "inputs_ready" || Object.hasOwn(before.c1ProductPlan.inputSnapshots, "skuRightsReview");
          if (isFrozen && frozen.replacesC1PlanId === null) reject("C1_RIGHTS_REPLACEMENT_REQUIRED");
          if (frozen.replacesC1PlanId !== null && frozen.replacesC1PlanId !== before.c1ProductPlan.c1PlanId) reject("C1_RIGHTS_PLAN_CONFLICT");
          let supersededC1 = null;
          let sku = structuredClone(before);
          if (frozen.replacesC1PlanId !== null) {
            supersededC1 = archiveC1(candidate);
            sku = structuredClone(replaceC1ProductPlanForRightsReview({ skuPackage: before,
              expectedC1PlanId: frozen.replacesC1PlanId,
              historyRef: `business-idempotency:${frozen.idempotencyKey}#/result/supersededC1`, createdAt: observedAt }).skuPackage);
            for (const field of C1_ARTIFACT_FIELDS) delete candidate.lifecycleV11[field];
            candidate.lifecycleV11.status = "c1_inputs_ready";
            if (Object.hasOwn(candidate, "listingPreparation")) {
              candidate.listingPreparation = { ...candidate.listingPreparation, status: "c1_inputs_ready",
                reason: "当前C1已创建新的权利评审轮次，旧草稿与执行证据仅保留历史。", decisionItems: [], writeOccurred: false, platformWrites: 0 };
            }
          }
          const record = createC1SkuRightsReviewRecord({ plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity,
            sourceCandidateRevision: candidate.dataRevision, declaredByUserId: owner.userId, declaredAt: observedAt,
            ownerDeclaration: { brand: frozen.brand, rights: frozen.rights, reviewedAt: frozen.reviewedAt, expiresAt: frozen.expiresAt } });
          const rightsView = buildC1SkuRightsReviewRecordView({ record, plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity, observedAt });
          sku.c1RightsReviewRecord = record;
          sku.ownerAction = rightsView.status === "verified" ? "none" : "review_compliance_risk";
          sku.audit.updatedAt = observedAt;
          sku.audit.history.push({ event: "c1_sku_rights_owner_declaration_saved", at: observedAt, recordId: record.recordId,
            sourceCandidateRevision: candidate.dataRevision, resultCandidateRevision: candidate.dataRevision + 1 });
          if (!isDeepStrictEqual(before.profitModels, sku.profitModels) || before.activeProfitModelVersion !== sku.activeProfitModelVersion ||
              !isDeepStrictEqual(before.selectedSupplySnapshot, sku.selectedSupplySnapshot)) reject("C1_RIGHTS_PROTECTED_DATA_CHANGED");
          assertValidLifecyclePackage(sku);
          candidate.lifecycleV11.skuPackage = sku;
          return { candidate, result: { schemaVersion: "c1-sku-rights-review-submission-v1", rightsReviewRecord: structuredClone(record),
            rightsView, c1PlanId: sku.c1ProductPlan.c1PlanId, supersededC1, externalCalls: 0, paidCalls: 0 } };
        }
      });
    },
    /**
     * 「做这件」许可里的「按卡上的声明记下品牌与权利」：主人在「做这件」卡上声明过（lib/gate1-rights-declaration.mjs），
     * C1 计划刚生成、还没有声明记录时，软件身份把那份声明原样记成这件商品的权利评审。声明人是主人，品牌、权利、核对时间
     * 和有效期一字不改；不替换已冻结的计划（那会作废旧草稿，只能主人来），声明过期或换了一轮「做这件」就不记。
     */
    async applyGate1Declaration({ actor, input }) {
      if (!isGate1AutopilotActor(actor)) reject("C1_RIGHTS_GATE1_SOFTWARE_ONLY");
      const software = createActorContext(actor);
      if (!exact(input, GATE1_APPLY_FIELDS) || !["candidateId", "skuPackageId", "idempotencyKey", "auditEventId", "expectedC1PlanId"].every(field => currentRef(input[field])) ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) reject("C1_RIGHTS_INPUT_INVALID");
      const frozen = structuredClone(input);
      return executeBusinessMutation({ repository, runtimeMode, actor: software, requiredRoles: ["operator"],
        action: "c1_sku_rights_gate1_declaration_apply", candidateId: frozen.candidateId, skuPackageId: frozen.skuPackageId,
        expectedRevision: frozen.expectedRevision, idempotencyKey: frozen.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord({ input: frozen, actorUserId: software.userId }),
        auditEventId: frozen.auditEventId, serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate, observedAt, relatedSoftwareJobs }) => {
          if (!gate1AutopilotMayAct(software, candidate, "c1_apply_rights")) reject("C1_RIGHTS_GATE1_GRANT_REQUIRED");
          const declaration = gate1RightsDeclarationCurrent(candidate, observedAt);
          if (declaration === null) reject("C1_RIGHTS_GATE1_DECLARATION_UNAVAILABLE");
          const before = assertCandidateScope(candidate, { ...frozen, replacesC1PlanId: null });
          assertNoActiveC1Jobs(relatedSoftwareJobs, candidate, before);
          if (before.c1ProductPlan.status !== "inputs_ready" || Object.hasOwn(before.c1ProductPlan.inputSnapshots, "skuRightsReview")) {
            reject("C1_RIGHTS_GATE1_PLAN_FROZEN");
          }
          if (before.c1RightsReviewRecord !== undefined && before.c1RightsReviewRecord !== null) reject("C1_RIGHTS_GATE1_ALREADY_DECLARED");
          const sku = structuredClone(before);
          const record = createC1SkuRightsReviewRecord({ plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity,
            sourceCandidateRevision: candidate.dataRevision, declaredByUserId: declaration.declaredByUserId, declaredAt: observedAt,
            ownerDeclaration: gate1RightsOwnerDeclaration(declaration) });
          const rightsView = buildC1SkuRightsReviewRecordView({ record, plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity, observedAt });
          sku.c1RightsReviewRecord = record;
          sku.ownerAction = rightsView.status === "verified" ? "none" : "review_compliance_risk";
          sku.audit.updatedAt = observedAt;
          sku.audit.history.push({ event: "c1_sku_rights_owner_declaration_saved", at: observedAt, recordId: record.recordId,
            sourceCandidateRevision: candidate.dataRevision, resultCandidateRevision: candidate.dataRevision + 1 });
          if (!isDeepStrictEqual(before.profitModels, sku.profitModels) || before.activeProfitModelVersion !== sku.activeProfitModelVersion ||
              !isDeepStrictEqual(before.selectedSupplySnapshot, sku.selectedSupplySnapshot)) reject("C1_RIGHTS_PROTECTED_DATA_CHANGED");
          assertValidLifecyclePackage(sku);
          candidate.lifecycleV11.skuPackage = sku;
          candidate.updatedAt = observedAt;
          candidate.lastModifiedBy = "software";
          return { candidate, result: { schemaVersion: "c1-sku-rights-review-gate1-apply-v1", rightsReviewRecord: structuredClone(record),
            rightsView, c1PlanId: sku.c1ProductPlan.c1PlanId, gate1DeclarationId: declaration.declarationId,
            externalCalls: 0, paidCalls: 0, aiCalls: 0, platformWrites: 0 } };
        }
      });
    }
  });
}
