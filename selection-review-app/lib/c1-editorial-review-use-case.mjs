import { completeC1FinalPlanRevision } from "./c1-final-plan-revision-preparation.mjs";
import { isDeepStrictEqual } from "node:util";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { assessC1DraftEditorialCorrection } from "./c1-draft-recovery-assessment.mjs";
import { assertCurrentC1AiDraftRequestSources } from "./c1-ai-draft-request-source.mjs";
import { applyC1EditorialReview, assertC1EditorialPlan, C1EditorialSourceError } from "./c1-editorial-review-contract.mjs";
import { createC2SoftwareContainer } from "./c2-software-orchestrator.mjs";
import { fingerprintC2SourceC1 } from "./c2-asset-lifecycle.mjs";
import { readCurrentAppliedC1Draft } from "./c1-content-review-use-case.mjs";
import { mergeC1AiDraftReceipt } from "./c1-ai-draft-contract.mjs";

export class C1EditorialReviewError extends Error {
  constructor(code, details = null) { super(code); this.name = "C1EditorialReviewError"; this.code = code; this.details = details; }
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nonEmpty = value => typeof value === "string" && value.trim().length > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(code, details) { throw new C1EditorialReviewError(code, details); }
const sourceValidationError = error => error instanceof C1EditorialSourceError ||
  (error instanceof Error && /^(?:C1_AI_|C1_DRAFT_|C1_LOCAL_DRAFT_|C1_SKU_RIGHTS_|C1_CONTENT_REVIEW_|SOFTWARE_JOB_C1_AI_|C1_CANONICAL_GATE_BLOCKED|C1ProductPlan校验失败)/.test(error.message));
function assessedVersion(bundle) {
  const result = assessC1DraftEditorialCorrection(bundle);
  if (result.status !== "editorial_proposed" || result.editedVersion?.status !== "proposal_only" || result.editedValidation?.valid !== true) {
    fail("C1_EDITORIAL_REVIEW_PROPOSAL_BLOCKED", result.reasons);
  }
  return result.editedVersion;
}
function assertObservedAt(value) {
  if (!nonEmpty(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("C1_EDITORIAL_REVIEW_TIME_INVALID");
}

function assertCurrentCompletedProposal({ candidate, sourceJob, proposalBundle, observedAt }) {
  assertObservedAt(observedAt);
  if (proposalBundle?.correctionPlan?.schemaVersion !== "c1-draft-editorial-plan-v2") {
    fail("C1_EDITORIAL_PREVIEW_VERSION_REQUIRED");
  }
  const version = assessedVersion(proposalBundle);
  const lifecycle = candidate?.lifecycleV11, sku = lifecycle?.skuPackage;
  if (!object(candidate) || !object(sku) || !Number.isSafeInteger(candidate.dataRevision) ||
      candidate.dataRevision <= sourceJob?.revision || sku.businessPhase !== "C1" ||
      sku.c1ProductPlan?.status !== "seo_draft_ready" ||
      ["c2FinalAssets", "productionAuthorization", "productionRecord", "externalListingRecord", "eVerificationRecord"]
        .some(key => sku[key] !== null) ||
      Object.hasOwn(lifecycle, "c1ContentReviewV1") || Object.hasOwn(lifecycle, "c1EditorialContentReviewV1")) {
    fail("C1_EDITORIAL_PREVIEW_SOURCE_CONFLICT");
  }
  if (!isDeepStrictEqual(sourceJob, proposalBundle.sourceJob)) fail("C1_EDITORIAL_PREVIEW_SOURCE_CONFLICT");
  const original = readCurrentAppliedC1Draft(candidate, [sourceJob]);
  if (!isDeepStrictEqual(original.request, proposalBundle.request) || !isDeepStrictEqual(original.receipt, proposalBundle.receipt)) {
    fail("C1_EDITORIAL_PREVIEW_SOURCE_CONFLICT");
  }
  const replay = mergeC1AiDraftReceipt({ skuPackage: sku, request: original.request, receipt: original.receipt,
    settledExecution: original.settledExecution, mergedAt: observedAt });
  if (!replay.idempotent) fail("C1_EDITORIAL_PREVIEW_APPLIED_ORIGINAL_REQUIRED");
  return version;
}

/** Read-only maintenance preview. The completed provider receipt remains the
 * saved original; this function cannot adopt a proposal or advance C1/C2. */
export function buildC1CompletedEditorialPreview(input) {
  const version = assertCurrentCompletedProposal(input);
  const { candidate, proposalBundle: { receipt } } = input;
  const sku = candidate.lifecycleV11.skuPackage;
  return {
    schemaVersion: "c1-completed-editorial-preview-v1", status: "proposal_only", canConfirm: false,
    candidateId: candidate.id, skuPackageId: sku.skuPackageId, expectedRevision: candidate.dataRevision,
    editorialVersionId: version.editorialVersionId, outputFingerprint: version.outputFingerprint,
    sourceReceiptId: receipt.receiptId, sourceOutputFingerprint: receipt.outputFingerprint,
    content: structuredClone(version.output), changes: structuredClone(version.changes),
    semanticValidation: structuredClone(version.semanticValidation),
    providerReceiptReplaced: false, productionAuthorized: false
  };
}
function assertCurrentProposal({ candidate, sourceJob, proposalBundle, observedAt }) {
  if (proposalBundle?.correctionPlan?.schemaVersion === "c1-draft-editorial-plan-v2") {
    return assertCurrentCompletedProposal({ candidate, sourceJob, proposalBundle, observedAt });
  }
  assertObservedAt(observedAt);
  const version = assessedVersion(proposalBundle), request = proposalBundle.request;
  const lifecycle = candidate?.lifecycleV11, sku = lifecycle?.skuPackage, ref = lifecycle?.c1AiDraftJobRefV1;
  if (!candidate || candidate.id !== request.sourceIdentity.candidateId || sku?.skuPackageId !== request.identity.skuPackageId ||
      !Number.isSafeInteger(candidate.dataRevision) || candidate.dataRevision < proposalBundle.sourceJob.revision ||
      sku.businessPhase !== "C1" || sku.c1ProductPlan?.status !== "facts_checked" ||
      Object.hasOwn(lifecycle, "c1EditorialContentReviewV1") || Object.hasOwn(lifecycle, "c1ContentReviewV1")) fail("C1_EDITORIAL_REVIEW_SOURCE_CONFLICT");
  if (!isDeepStrictEqual(sourceJob, proposalBundle.sourceJob) || !isDeepStrictEqual(lifecycle.c1AiDraftRequestV1, request) ||
      ref?.jobId !== sourceJob.jobId || ref.jobType !== sourceJob.jobType || ref.candidateId !== candidate.id ||
      ref.skuPackageId !== sku.skuPackageId || ref.sourceRevision !== sourceJob.scopeBinding.sourceRevision ||
      ref.resultRevision !== sourceJob.revision || ref.inputFingerprint !== request.requestFingerprint) fail("C1_EDITORIAL_REVIEW_SOURCE_CONFLICT");
  try { assertCurrentC1AiDraftRequestSources({ candidate, request, observedAt }); }
  catch (error) {
    if (!sourceValidationError(error)) throw error;
    fail("C1_EDITORIAL_REVIEW_CURRENT_FACTS_INVALID", { sourceCode: error.code ?? error.message.split(/[:：]/)[0] });
  }
  return version;
}
function confirmedView(candidate) {
  const sku = candidate.lifecycleV11.skuPackage, record = candidate.lifecycleV11.c1EditorialContentReviewV1;
  if (!object(sku) || !object(sku.c1ProductPlan)) fail("C1_EDITORIAL_REVIEW_RECORD_INVALID");
  const source = sku.c1ProductPlan?.draftOnlySeo?.editorialSource;
  if (!closed(record, ["schemaVersion", "status", "reviewId", "candidateId", "skuPackageId", "editorialVersionId", "outputFingerprint",
      "sourceSoftwareJobId", "requestFingerprint", "sourceOutputFingerprint", "sourceRevision", "resultRevision", "sourceSkuRevision", "editorialSkuRevision",
      "resultSkuRevision", "confirmedByUserId", "confirmedAt", "contentFingerprint", "productionAuthorizationGranted"]) ||
      record.schemaVersion !== "c1-editorial-content-review-v1" || record.status !== "confirmed" || record.productionAuthorizationGranted !== false ||
      !object(source) || !object(source.ownerConfirmation) || record.editorialVersionId !== source.ownerConfirmation.editorialVersionId ||
      record.outputFingerprint !== source.ownerConfirmation.outputFingerprint || record.candidateId !== candidate.id ||
      record.skuPackageId !== sku.skuPackageId || record.confirmedByUserId !== source.ownerConfirmation.confirmedByUserId ||
      record.confirmedAt !== source.ownerConfirmation.confirmedAt) fail("C1_EDITORIAL_REVIEW_RECORD_INVALID");
  const verified = assertC1EditorialPlan({ plan: sku.c1ProductPlan, identity: sku.g1Identity, resultSkuRevision: source.ownerConfirmation.resultSkuRevision });
  if (record.sourceSoftwareJobId !== verified.bundle.sourceJob.jobId || record.requestFingerprint !== verified.bundle.request.requestFingerprint ||
      record.sourceOutputFingerprint !== verified.bundle.receipt.outputFingerprint || record.sourceRevision !== verified.ownerConfirmation.sourceCandidateRevision ||
      record.resultRevision !== verified.ownerConfirmation.resultCandidateRevision || record.sourceSkuRevision !== verified.ownerConfirmation.sourceSkuRevision ||
      record.editorialSkuRevision !== verified.ownerConfirmation.resultSkuRevision || record.resultSkuRevision !== record.editorialSkuRevision + 1 ||
      candidate.dataRevision < record.resultRevision || sku.dataRevision < record.resultSkuRevision) fail("C1_EDITORIAL_REVIEW_RECORD_INVALID");
  if (record.contentFingerprint !== fingerprintC2SourceC1(sku)) fail("C1_EDITORIAL_REVIEW_CONTENT_CONFLICT");
  return { status: "confirmed", canConfirm: false, candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    editorialVersionId: record.editorialVersionId, outputFingerprint: record.outputFingerprint,
    finalCardCreated: Boolean(candidate.lifecycleV11.c1FinalPlanRevisionCompletion),
    content: structuredClone(verified.editedVersion.output), changes: structuredClone(verified.editedVersion.changes),
    semanticValidation: structuredClone(verified.editedVersion.semanticValidation), review: structuredClone(record) };
}

/** Pure view. Loading a proposal never adopts content or creates C2. */
export function buildC1EditorialReviewView({ candidate, sourceJob, proposalBundle = null, observedAt }) {
  if (!object(candidate)) return { status: "invalid", reason: "C1_EDITORIAL_REVIEW_CANDIDATE_INVALID", canConfirm: false };
  try {
    if (Object.hasOwn(candidate.lifecycleV11 ?? {}, "c1EditorialContentReviewV1")) return confirmedView(candidate);
    if (proposalBundle === null || proposalBundle.request?.sourceIdentity?.candidateId !== candidate.id) return { status: "not_applicable", canConfirm: false };
    const version = assertCurrentProposal({ candidate, sourceJob, proposalBundle, observedAt });
    return { status: "awaiting_confirmation", canConfirm: true, candidateId: candidate.id, expectedRevision: candidate.dataRevision,
      editorialVersionId: version.editorialVersionId, outputFingerprint: version.outputFingerprint,
      restoresConfirmedAssets: Boolean(candidate.lifecycleV11.c1FinalPlanRevisionPreparation),
      content: structuredClone(version.output), changes: structuredClone(version.changes), semanticValidation: structuredClone(version.semanticValidation) };
  } catch (error) {
    if (sourceValidationError(error)) return { status: "blocked", reason: "C1_EDITORIAL_REVIEW_SOURCE_INVALID", canConfirm: false };
    if (!(error instanceof C1EditorialReviewError)) throw error;
    return { status: "blocked", reason: error.code, details: error.details, canConfirm: false };
  }
}
function assertInput(input) {
  if (!closed(input, ["candidateId", "expectedRevision", "editorialVersionId", "outputFingerprint", "confirmed", "idempotencyKey", "auditEventId"]) ||
      input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !["candidateId", "editorialVersionId", "idempotencyKey", "auditEventId"].every(key => nonEmpty(input[key])) || !digest(input.outputFingerprint)) {
    fail("C1_EDITORIAL_REVIEW_INPUT_INVALID");
  }
}

export function createC1EditorialReviewUseCase({ repository, runtimeMode, serverClock, proposalBundle = null }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") throw new TypeError("C1_EDITORIAL_REVIEW_DEPENDENCY_INVALID");
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository); else assertCentralPersistenceBoundary(repository);
  const bundle = proposalBundle === null ? null : structuredClone(proposalBundle);
  if (bundle !== null) assessedVersion(bundle);
  return Object.freeze({
    async confirm({ actor, input }) {
      actor = structuredClone(actor); input = structuredClone(input);
      assertInput(input); authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") fail("C1_EDITORIAL_REVIEW_AUTHENTICATED_OWNER_REQUIRED");
      if (bundle === null) fail("C1_EDITORIAL_REVIEW_PROPOSAL_REQUIRED");
      const snapshot = await repository.readSnapshot(), target = snapshot.candidates.find(candidate => candidate.id === input.candidateId);
      if (!target?.lifecycleV11?.skuPackage) fail("C1_EDITORIAL_REVIEW_CANDIDATE_NOT_FOUND");
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], action: "c1_confirm_editorial_content",
        candidateId: input.candidateId, skuPackageId: target.lifecycleV11.skuPackage.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }),
        auditEventId: input.auditEventId, serverClock, includeRelatedSoftwareJobs: true, includeFinalPlanHistory: true,
        mutate: ({ candidate, relatedSoftwareJobs, finalPlanHistoryRecord, observedAt }) => {
          const matches = relatedSoftwareJobs.filter(job => job.jobId === bundle.sourceJob.jobId);
          if (matches.length !== 1) fail("C1_EDITORIAL_REVIEW_SOURCE_CONFLICT");
          const version = assertCurrentProposal({ candidate, sourceJob: matches[0], proposalBundle: bundle, observedAt });
          if (version.editorialVersionId !== input.editorialVersionId || version.outputFingerprint !== input.outputFingerprint) fail("C1_EDITORIAL_REVIEW_CONTENT_CONFLICT");
          const sku = candidate.lifecycleV11.skuPackage;
          const ownerConfirmation = { schemaVersion: "c1-editorial-owner-confirmation-v1", candidateId: candidate.id, skuPackageId: sku.skuPackageId,
            sourceCandidateRevision: candidate.dataRevision, resultCandidateRevision: candidate.dataRevision + 1,
            sourceSkuRevision: sku.dataRevision, resultSkuRevision: sku.dataRevision + 1,
            editorialVersionId: version.editorialVersionId, outputFingerprint: version.outputFingerprint, confirmedByUserId: actor.userId,
            actorType: "human", role: "owner", source: "authenticated_identity_provider", confirmedAt: observedAt, productionAuthorizationGranted: false };
          let applied;
          try {
            const settledExecution = bundle.correctionPlan.schemaVersion === "c1-draft-editorial-plan-v2"
              ? readCurrentAppliedC1Draft(candidate, matches).settledExecution : null;
            applied = applyC1EditorialReview({ skuPackage: sku, bundle, editedVersion: version, ownerConfirmation, settledExecution });
          }
          catch (error) {
            if (!sourceValidationError(error)) throw error;
            fail("C1_EDITORIAL_REVIEW_SOURCE_INVALID", { sourceCode: error.code });
          }
          const c2 = createC2SoftwareContainer({ skuPackage: applied.skuPackage, expectedDataRevision: applied.skuPackage.dataRevision,
            assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: observedAt });
          const record = { schemaVersion: "c1-editorial-content-review-v1", status: "confirmed", reviewId: `c1-editorial-review:${input.auditEventId}`,
            candidateId: candidate.id, skuPackageId: sku.skuPackageId, editorialVersionId: version.editorialVersionId, outputFingerprint: version.outputFingerprint,
            sourceSoftwareJobId: matches[0].jobId, requestFingerprint: bundle.request.requestFingerprint, sourceOutputFingerprint: bundle.receipt.outputFingerprint,
            sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision + 1,
            sourceSkuRevision: sku.dataRevision, editorialSkuRevision: applied.skuPackage.dataRevision, resultSkuRevision: c2.skuPackage.dataRevision,
            confirmedByUserId: actor.userId, confirmedAt: observedAt, contentFingerprint: fingerprintC2SourceC1(c2.skuPackage), productionAuthorizationGranted: false };
          candidate.lifecycleV11.c1EditorialContentReviewV1 = record;
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
          candidate.updatedAt = observedAt; candidate.lastModifiedBy = "owner";
          return { candidate, result: { schemaVersion: "c1-editorial-review-result-v1", status: "confirmed", reviewRef: record.reviewId,
            editorialVersionId: version.editorialVersionId, outputFingerprint: version.outputFingerprint, c2Started: true, finalCardCreated,
            externalCalls: 0, aiCalls: 0, paidCalls: 0, platformWrites: 0, codexDispatches: 0 } };
        } });
    }
  });
}
