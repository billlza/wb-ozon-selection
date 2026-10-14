import { completeC1FinalPlanRevision } from "./c1-final-plan-revision-preparation.mjs";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { fingerprintC2SourceC1 } from "./c2-asset-lifecycle.mjs";
import { createC2SoftwareContainer } from "./c2-software-orchestrator.mjs";
import { mergeC1AiDraftReceipt, validateC1AiDraftRequest } from "./c1-ai-draft-contract.mjs";
import { readCompletedC1AiSoftwareJobResult } from "./software-job-contract.mjs";
import { isC1LocalDraftSourceVersion } from "./c1-local-draft-source.mjs";
import { assertC1EditorialPlan } from "./c1-editorial-review-contract.mjs";
import { gate1AutopilotMayAct, isGate1AutopilotActor } from "./gate1-autopilot.mjs";

export const C1_CONTENT_FORWARD_SCHEMA_VERSION = "c1-content-forward-v1";

export class C1ContentReviewError extends Error {
  constructor(code) { super(code); this.name = "C1ContentReviewError"; this.code = code; }
}

// Use the existing C1 -> C2 snapshot identity to detect stale displayed content.
export { fingerprintC2SourceC1 as fingerprintC1ReviewContent };

function participatesInContentReview(lifecycle) {
  return lifecycle !== null && typeof lifecycle === "object" && (
    Object.hasOwn(lifecycle, "c1LocalDraftSourceV1") || Object.hasOwn(lifecycle, "c1ContentReviewV1") || Object.hasOwn(lifecycle, "c1ContentForwardV1") ||
    lifecycle.c1AiDraftRequestV1?.keywordEvidence?.collectionMode === "local_preparation");
}

/** Check enrollment evidence without re-running paid admission against the
 * already merged SKU revision. Missing enrollment is historical, broken
 * enrollment is a source error; neither can grant confirmation. */
function assertContentReviewEnrollment(candidate) {
  const lifecycle = candidate.lifecycleV11;
  if (!participatesInContentReview(lifecycle)) throw new C1ContentReviewError("C1_CONTENT_REVIEW_WORKFLOW_NOT_APPLICABLE");
  const source = lifecycle.c1LocalDraftSourceV1, request = lifecycle.c1AiDraftRequestV1;
  const sku = lifecycle.skuPackage, binding = request?.keywordEvidence?.sourceBindings;
  if (!isC1LocalDraftSourceVersion(source?.schemaVersion) || source.schemaVersion !== binding?.sourceVersion || !validateC1AiDraftRequest(request).valid ||
      request.keywordEvidence.collectionMode !== "local_preparation" || source.candidateId !== candidate.id ||
      source.skuPackageId !== sku?.skuPackageId || request.sourceIdentity.candidateId !== candidate.id ||
      request.sourceIdentity.skuPackageId !== source.skuPackageId || source.preparedSkuRevision !== request.sourceSkuRevision ||
      source.sourceFingerprint !== binding?.sourceFingerprint || source.materialFingerprint !== binding.materialFingerprint ||
      source.sourceSkuRevision !== binding.sourceSkuRevision) throw new C1ContentReviewError("C1_CONTENT_REVIEW_SOURCE_INVALID");
  const { sourceFingerprint, ...sourceCore } = source;
  if (sourceFingerprint !== fingerprintCanonicalRecord(sourceCore)) throw new C1ContentReviewError("C1_CONTENT_REVIEW_SOURCE_INVALID");
  if (Object.hasOwn(lifecycle, "c1ContentReviewV1") && lifecycle.c1ContentReviewV1?.schemaVersion !== "c1-content-review-v1") {
    throw new C1ContentReviewError("C1_CONTENT_REVIEW_RECORD_INVALID");
  }
}

/** Pure projection; malformed ready content is an error, never an empty draft. */
export function buildC1ContentReviewView(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { status: "invalid", reason: "C1_CONTENT_REVIEW_CANDIDATE_INVALID", canConfirm: false };
  }
  const sku = candidate.lifecycleV11?.skuPackage;
  if (sku?.c1ProductPlan?.draftOnlySeo?.sourceType === "owner_confirmed_editorial") {
    assertC1EditorialPlan({ plan: sku.c1ProductPlan, identity: sku.g1Identity,
      resultSkuRevision: sku.c1ProductPlan.draftOnlySeo.editorialSource?.ownerConfirmation?.resultSkuRevision });
    return { status: "not_ready", reason: "C1_CONTENT_REVIEW_EDITORIAL_SOURCE", canConfirm: false };
  }
  if (participatesInContentReview(candidate.lifecycleV11)) assertContentReviewEnrollment(candidate);
  if (!sku || sku.c1ProductPlan?.status !== "seo_draft_ready") {
    return { status: "not_ready", reason: "C1_CONTENT_REVIEW_FORMAL_DRAFT_REQUIRED", canConfirm: false };
  }
  if (!participatesInContentReview(candidate.lifecycleV11)) {
    return { status: "not_ready", reason: "C1_CONTENT_REVIEW_WORKFLOW_NOT_APPLICABLE", canConfirm: false };
  }
  const contentFingerprint = fingerprintC2SourceC1(sku);
  const review = candidate.lifecycleV11.c1ContentReviewV1;
  const reviewed = review?.status === "confirmed" && review.contentFingerprint === contentFingerprint &&
    review.candidateId === candidate.id && review.skuPackageId === sku.skuPackageId &&
    review.receiptRef === sku.c1ProductPlan.seoEvidenceLayer.aiReceiptId;
  // 软件按「做这件」的许可把写好的文案送进了传图：主人还没单独确认，文案在「上架」卡上和图片一起看。
  const forward = candidate.lifecycleV11.c1ContentForwardV1;
  const forwarded = !review && forward?.schemaVersion === C1_CONTENT_FORWARD_SCHEMA_VERSION && forward.contentFingerprint === contentFingerprint &&
    forward.candidateId === candidate.id && forward.skuPackageId === sku.skuPackageId && sku.businessPhase === "C2";
  const status = review ? (reviewed ? "confirmed" : "stale_confirmation")
    : forwarded ? "awaiting_listing"
    : sku.businessPhase === "C1" ? "awaiting_confirmation" : "confirmation_missing";
  return {
    status, canConfirm: status === "awaiting_confirmation", candidateId: candidate.id,
    expectedRevision: candidate.dataRevision, contentFingerprint,
    title: structuredClone(sku.c1ProductPlan.seoTitleDraft),
    description: structuredClone(sku.c1ProductPlan.descriptionDraft),
    bulletPoints: structuredClone(sku.c1ProductPlan.bulletPointsDraft),
    searchKeywords: structuredClone(sku.c1ProductPlan.searchKeywordsDraft),
    receiptRef: sku.c1ProductPlan.seoEvidenceLayer.aiReceiptId,
    review: review ? structuredClone(review) : null
  };
}

function assertInput(input) {
  const keys = ["candidateId", "expectedRevision", "contentFingerprint", "confirmed", "idempotencyKey", "auditEventId"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
      keys.some(key => !Object.hasOwn(input, key)) || input.confirmed !== true ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      ["candidateId", "idempotencyKey", "auditEventId"].some(key => typeof input[key] !== "string" || !input[key].trim()) ||
      typeof input.contentFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.contentFingerprint)) {
    throw new C1ContentReviewError("C1_CONTENT_REVIEW_INPUT_INVALID");
  }
}

/** Read the exact applied original for review or a separate editorial proposal. */
export function readCurrentAppliedC1Draft(candidate, jobs) {
  const lifecycle = candidate.lifecycleV11;
  const ref = lifecycle.c1AiDraftJobRefV1;
  const matches = jobs.filter(job => job.jobId === ref?.jobId);
  const job = matches[0];
  if (matches.length !== 1 || job.jobType !== "c1_ai_draft" ||
      job.resultEnvelope?.applicationDisposition !== "applied" ||
      ref.jobType !== job.jobType || ref.candidateId !== candidate.id || ref.candidateId !== job.candidateId ||
      ref.skuPackageId !== lifecycle.skuPackage.skuPackageId || ref.skuPackageId !== job.skuPackageId ||
      ref.resultRevision !== job.revision || ref.sourceRevision !== job.scopeBinding?.sourceRevision ||
      ref.inputFingerprint !== job.scopeBinding?.inputFingerprint) {
    throw new C1ContentReviewError("C1_CONTENT_REVIEW_APPLIED_RECEIPT_REQUIRED");
  }
  const saved = readCompletedC1AiSoftwareJobResult(job, { allowApplied: true });
  if (fingerprintCanonicalRecord(lifecycle.c1AiDraftRequestV1) !== fingerprintCanonicalRecord(saved.request)) {
    throw new C1ContentReviewError("C1_CONTENT_REVIEW_REQUEST_CONFLICT");
  }
  return { job, ...saved };
}

/**
 * 「上架」那一下替主人记下的文案确认：内容就是软件送进传图时那一份（指纹没变才算），确认人是点「上架」的主人。
 * 记录的形状与主人单独确认时完全一样，只是确认发生在上架卡上，和图片确认在同一次保存里。
 */
export function buildC1ContentAcceptanceAtListing({ candidate, ownerUserId, confirmedAt }) {
  const lifecycle = candidate?.lifecycleV11, sku = lifecycle?.skuPackage, forward = lifecycle?.c1ContentForwardV1;
  if (!forward || lifecycle.c1ContentReviewV1) return null;
  if (forward.schemaVersion !== C1_CONTENT_FORWARD_SCHEMA_VERSION || forward.candidateId !== candidate.id ||
      forward.skuPackageId !== sku?.skuPackageId || forward.contentFingerprint !== fingerprintC2SourceC1(sku)) {
    throw new C1ContentReviewError("C1_CONTENT_FORWARD_CONTENT_CHANGED");
  }
  if (typeof ownerUserId !== "string" || !ownerUserId.trim()) throw new C1ContentReviewError("C1_CONTENT_REVIEW_AUTHENTICATED_OWNER_REQUIRED");
  return {
    schemaVersion: "c1-content-review-v1", reviewId: `c1-content-review:listing:${forward.forwardId}`,
    status: "confirmed", candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    platform: forward.platform, storeRef: structuredClone(forward.storeRef),
    sourceRevision: forward.sourceRevision, resultRevision: forward.resultRevision,
    sourceSkuRevision: forward.sourceSkuRevision, resultSkuRevision: forward.resultSkuRevision,
    contentFingerprint: forward.contentFingerprint, requestRef: forward.requestRef,
    receiptRef: forward.receiptRef, jobId: forward.jobId, payloadFingerprint: forward.payloadFingerprint,
    confirmedByUserId: ownerUserId, confirmedAt, productionAuthorizationGranted: false
  };
}

/** Owner review of saved formal content only; this grants no production authorization. */
export function createC1ContentReviewUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") {
    throw new TypeError("C1_CONTENT_REVIEW_DEPENDENCY_INVALID");
  }
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    async confirm({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      assertInput(input);
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new C1ContentReviewError("C1_CONTENT_REVIEW_AUTHENTICATED_OWNER_REQUIRED");
      }
      const snapshot = await repository.readSnapshot();
      const target = snapshot.candidates.find(candidate => candidate.id === input.candidateId);
      if (!target?.lifecycleV11?.skuPackage) throw new C1ContentReviewError("C1_CONTENT_REVIEW_CANDIDATE_NOT_FOUND");
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "c1_confirm_saved_content", candidateId: input.candidateId,
        skuPackageId: target.lifecycleV11.skuPackage.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }),
        auditEventId: input.auditEventId, serverClock, includeRelatedSoftwareJobs: true, includeFinalPlanHistory: true,
        mutate: ({ candidate, relatedSoftwareJobs, finalPlanHistoryRecord, observedAt }) => {
          assertContentReviewEnrollment(candidate);
          const sku = candidate.lifecycleV11.skuPackage;
          if (sku.businessPhase !== "C1" || sku.c1ProductPlan?.status !== "seo_draft_ready" ||
              candidate.lifecycleV11.c1ContentReviewV1) throw new C1ContentReviewError("C1_CONTENT_REVIEW_PHASE_REJECTED");
          if (fingerprintC2SourceC1(sku) !== input.contentFingerprint) {
            throw new C1ContentReviewError("C1_CONTENT_REVIEW_CONTENT_CONFLICT");
          }
          const { job, request, receipt, settledExecution } = readCurrentAppliedC1Draft(candidate, relatedSoftwareJobs);
          // This replay validation proves the displayed draft still equals the saved formal receipt.
          const validated = mergeC1AiDraftReceipt({ skuPackage: sku, request, receipt, settledExecution, mergedAt: observedAt });
          if (!validated.idempotent) throw new C1ContentReviewError("C1_CONTENT_REVIEW_SAVED_CONTENT_REQUIRED");
          const c2 = createC2SoftwareContainer({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
            assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: observedAt });
          const review = {
            schemaVersion: "c1-content-review-v1", reviewId: `c1-content-review:${input.auditEventId}`,
            status: "confirmed", candidateId: candidate.id, skuPackageId: sku.skuPackageId,
            platform: sku.targetPlatform, storeRef: structuredClone(sku.g1Identity.storeRef),
            sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision + 1,
            sourceSkuRevision: sku.dataRevision, resultSkuRevision: c2.skuPackage.dataRevision,
            contentFingerprint: input.contentFingerprint, requestRef: request.requestId,
            receiptRef: receipt.receiptId, jobId: job.jobId, payloadFingerprint: job.resultEnvelope.payloadFingerprint,
            confirmedByUserId: actor.userId, confirmedAt: observedAt, productionAuthorizationGranted: false
          };
          candidate.lifecycleV11.c1ContentReviewV1 = review;
          candidate.lifecycleV11.skuPackage = structuredClone(c2.skuPackage);
          let finalCardCreated = false;
          if (candidate.lifecycleV11.c1FinalPlanRevisionPreparation) {
            const completed = completeC1FinalPlanRevision({ candidate, historyRecord: finalPlanHistoryRecord,
              expectedRevision: candidate.dataRevision, completedAt: observedAt });
            // executeBusinessMutation owns the one atomic candidate increment.
            completed.candidate.dataRevision = candidate.dataRevision;
            candidate = completed.candidate;
            finalCardCreated = true;
          }
          candidate.updatedAt = observedAt;
          candidate.lastModifiedBy = "owner";
          return { candidate, result: { schemaVersion: "c1-content-review-result-v1", status: "confirmed",
            reviewRef: review.reviewId, contentFingerprint: review.contentFingerprint, receiptRef: review.receiptRef,
            c2Started: true, finalCardCreated, externalCalls: 0, aiCalls: 0, paidCalls: 0, platformWrites: 0, codexDispatches: 0 } };
        }
      });
    },
    /**
     * 「做这件」许可里的「文案写好后进入传图」：软件身份把已经保存、已经核过回执的文案送进 C2，好让主人传图。
     * 不替主人确认文案——那一步留到「上架」卡上，和图片一起（buildC1ContentAcceptanceAtListing）。改版方案不走这里。
     */
    async forwardToListing({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "expectedRevision", "idempotencyKey", "auditEventId"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
          keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          ["candidateId", "idempotencyKey", "auditEventId"].some(key => typeof input[key] !== "string" || !input[key].trim())) {
        throw new C1ContentReviewError("C1_CONTENT_FORWARD_INPUT_INVALID");
      }
      if (!isGate1AutopilotActor(actor)) throw new C1ContentReviewError("C1_CONTENT_FORWARD_SOFTWARE_ONLY");
      authorizeOperation({ actor, requiredRoles: ["operator"] });
      const snapshot = await repository.readSnapshot();
      const target = snapshot.candidates.find(candidate => candidate.id === input.candidateId);
      if (!target?.lifecycleV11?.skuPackage) throw new C1ContentReviewError("C1_CONTENT_REVIEW_CANDIDATE_NOT_FOUND");
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["operator"],
        action: "c1_forward_saved_content_to_listing", candidateId: input.candidateId,
        skuPackageId: target.lifecycleV11.skuPackage.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord({ input, actorUserId: actor.userId }),
        auditEventId: input.auditEventId, serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate, relatedSoftwareJobs, observedAt }) => {
          if (!gate1AutopilotMayAct(actor, candidate, "c1_forward_copy")) throw new C1ContentReviewError("C1_CONTENT_FORWARD_AUTOPILOT_GRANT_REQUIRED");
          const lifecycle = candidate.lifecycleV11;
          if (lifecycle.c1FinalPlanRevisionPreparation) throw new C1ContentReviewError("C1_CONTENT_FORWARD_REVISION_NEEDS_OWNER");
          assertContentReviewEnrollment(candidate);
          const sku = lifecycle.skuPackage;
          if (sku.businessPhase !== "C1" || sku.c1ProductPlan?.status !== "seo_draft_ready" ||
              lifecycle.c1ContentReviewV1 || lifecycle.c1ContentForwardV1) throw new C1ContentReviewError("C1_CONTENT_REVIEW_PHASE_REJECTED");
          const contentFingerprint = fingerprintC2SourceC1(sku);
          const { job, request, receipt, settledExecution } = readCurrentAppliedC1Draft(candidate, relatedSoftwareJobs);
          const validated = mergeC1AiDraftReceipt({ skuPackage: sku, request, receipt, settledExecution, mergedAt: observedAt });
          if (!validated.idempotent) throw new C1ContentReviewError("C1_CONTENT_REVIEW_SAVED_CONTENT_REQUIRED");
          const c2 = createC2SoftwareContainer({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
            assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: observedAt });
          const forward = {
            schemaVersion: C1_CONTENT_FORWARD_SCHEMA_VERSION, forwardId: `c1-content-forward:${input.auditEventId}`,
            status: "forwarded_for_listing", candidateId: candidate.id, skuPackageId: sku.skuPackageId,
            platform: sku.targetPlatform, storeRef: structuredClone(sku.g1Identity.storeRef),
            sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision + 1,
            sourceSkuRevision: sku.dataRevision, resultSkuRevision: c2.skuPackage.dataRevision,
            contentFingerprint, requestRef: request.requestId, receiptRef: receipt.receiptId, jobId: job.jobId,
            payloadFingerprint: job.resultEnvelope.payloadFingerprint, forwardedBy: actor.userId, forwardedAt: observedAt,
            ownerContentConfirmation: "at_listing", productionAuthorizationGranted: false
          };
          lifecycle.c1ContentForwardV1 = forward;
          lifecycle.skuPackage = structuredClone(c2.skuPackage);
          candidate.updatedAt = observedAt;
          candidate.lastModifiedBy = "software";
          return { candidate, result: { schemaVersion: "c1-content-forward-result-v1", status: "forwarded",
            forwardRef: forward.forwardId, contentFingerprint, c2Started: true,
            externalCalls: 0, aiCalls: 0, paidCalls: 0, platformWrites: 0, codexDispatches: 0 } };
        }
      });
    }
  });
}
