import { createFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertC2FrozenContractCurrent, confirmFinalUploads, fingerprintC2SourceC1 } from "./c2-asset-lifecycle.mjs";
import { assertValidC1ProductPlan, verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { createC1SupplierFactRevision } from "./confirmed-supplier-inputs.mjs";
import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";

import { createC2SoftwareContainer, prepareC2FinalUploadManifest } from "./c2-software-orchestrator.mjs";

const FACT_FIELDS = ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment", "categoryRestrictions", "platformCompliance"];
const PREVIOUS_C1_REFERENCE_FIELDS = ["c1AiDraftRequestV1", "c1AiDraftJobRefV1", "c1LocalDraftSourceV1", "c1KeywordPlanningLocalMaterialV1", "c1KeywordPlanningLocalMaterialProductionV1", "c1SoftwareEvidenceV1", "k3KeywordEvidenceSnapshotV1", "k3CurrentBindingV1", "c1ContentReviewV1", "c1EditorialContentReviewV1", "c1ColorDictionaryReadsV1", "c1FinalPlanRevisionPreparation", "c1FinalPlanRevisionCompletion"];
const CONTENT_FIELDS = ["seoTitleDraft", "descriptionDraft", "bulletPointsDraft", "searchKeywordsDraft", "seoEvidenceLayer"];
export class C1FinalPlanRevisionError extends Error {
  constructor(code) { super(code); this.name = "C1FinalPlanRevisionError"; this.code = code; }
}
const fail = code => { throw new C1FinalPlanRevisionError(code); };

export function hasUnsettledC1ColorDictionaryRead(lifecycle) {
  return Object.values(lifecycle?.c1ColorDictionaryReadsV1 ?? {})
    .some(record => ['request_sent', 'unknown_outcome'].includes(record?.status));
}

/** Exact archival projection shared by preparation and its atomic persistence boundary. */
export function buildC1FinalPlanHistoryReferences(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) fail("C1_FINAL_REVISION_INPUT_INVALID");
  const references = { c2UploadDraft: structuredClone(lifecycle.c2UploadDraft ?? null) };
  for (const key of PREVIOUS_C1_REFERENCE_FIELDS) {
    if (Object.hasOwn(lifecycle, key)) references[key] = structuredClone(lifecycle[key]);
  }
  return references;
}
export function clearC1FinalPlanActiveReferences(lifecycle) {
  if (hasUnsettledC1ColorDictionaryRead(lifecycle)) fail('C1_COLOR_DICTIONARY_READ_UNSETTLED');
  for (const key of PREVIOUS_C1_REFERENCE_FIELDS) delete lifecycle[key];
}

/** Pure preparation for the existing C1 -> SEO -> C2 flow. No receipt or owner decision is invented. */
export function prepareC1FinalPlanRevision({ candidate, expectedRevision, preparedAt }) {
  if (!candidate || !Number.isSafeInteger(expectedRevision) || candidate.dataRevision !== expectedRevision ||
      !isRuntimeConfigurationTimestamp(preparedAt)) fail("C1_FINAL_REVISION_INPUT_INVALID");
  const life = candidate.lifecycleV11, previous = life?.skuPackage;
  if (hasUnsettledC1ColorDictionaryRead(life)) fail('C1_COLOR_DICTIONARY_READ_UNSETTLED');
  if (!previous || previous.businessPhase !== "C2" || previous.c2FinalAssets?.status !== "completed" ||
      !previous.productionConfirmationCard || previous.c1ProductPlan?.status !== "seo_draft_ready") fail("C1_FINAL_REVISION_SOURCE_NOT_FINAL");
  assertValidLifecyclePackage(previous);
  if (["productionAuthorization", "productionRecord", "dAssetTransport", "dHandoff", "externalListingRecord", "eVerificationRecord"]
      .some(key => previous[key] !== undefined && previous[key] !== null) || previous.productionConfirmationCard.ownerDecision !== null) {
    fail("C1_FINAL_REVISION_DOWNSTREAM_STATE_REJECTED");
  }
  // Rebuild the existing card at its original timestamp, using the same replay
  // boundary as owner preparation. This clone is never persisted or authorized.
  const originalInputs = structuredClone(previous);
  originalInputs.productionConfirmationCard = null;
  assertC2FrozenContractCurrent(originalInputs);
  const rebuiltCard = createFinalProductPlanConfirmationCard({ skuPackage: originalInputs,
    createdAt: previous.productionConfirmationCard.createdAt }).confirmationCard;
  if (!isDeepStrictEqual(rebuiltCard, previous.productionConfirmationCard)) fail("C1_FINAL_REVISION_SOURCE_CARD_CHANGED");
  assertCurrentC1SkuRightsReview({ plan: previous.c1ProductPlan, sourceIdentity: previous.g1Identity, observedAt: preparedAt });
  if (Date.parse(preparedAt) < Date.parse(previous.productionConfirmationCard.createdAt)) fail("C1_FINAL_REVISION_TIME_INVALID");
  const preparationId = `final-plan-revision:${previous.skuPackageId}:${expectedRevision + 1}`;
  if ((life.c1FinalPlanRevisionHistory ?? []).some(item => item.preparationId === preparationId)) fail("C1_FINAL_REVISION_ID_CONFLICT");
  const targetC1PlanId = `${previous.c1ProductPlan.c1PlanId}:facts:${expectedRevision + 1}`;
  const next = structuredClone(candidate), sku = next.lifecycleV11.skuPackage, plan = sku.c1ProductPlan;
  const sourceFactsRevision = createC1SupplierFactRevision({ candidate, revisionId: `${preparationId}:facts`, targetC1PlanId, preparedAt });
  const declaredFacts = sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1?.facts;
  if (!sourceFactsRevision.records.length && !Object.values(declaredFacts ?? {}).some(value => value !== null)) {
    fail("C1_FINAL_REVISION_NO_CONFIRMED_FACTS");
  }
  // Original snapshots and the input revision retain their identities. The new
  // source-facts record is a separate, replayable input to the existing verifier.
  plan.c1PlanId = targetC1PlanId;
  plan.supersedes = { c1PlanId: previous.c1ProductPlan.c1PlanId, historyRef: preparationId };
  plan.sourceFactsRevision = sourceFactsRevision;
  plan.status = "inputs_ready"; plan.createdAt = preparedAt;
  plan.factVerificationVersion = null; plan.factsVerifiedAt = null;
  plan.draftOnlySeo = null; plan.keywordEvidenceRefs = []; plan.unknownManifest = [];
  for (const field of [...FACT_FIELDS, ...CONTENT_FIELDS]) plan[field] = null;
  const rights = structuredClone(plan.inputSnapshots.skuRightsReview);
  delete plan.inputSnapshots.skuRightsReview;
  delete sku.c1RightsReviewRecord;
  sku.c2FinalAssets = null; sku.productionConfirmationCard = null;
  sku.businessPhase = "C1"; sku.businessResult = "pending"; sku.technicalStatus = "completed"; sku.ownerAction = "none";
  sku.dataRevision += 1;
  sku.audit.updatedAt = preparedAt;
  sku.audit.history.push({ event: "c1_final_plan_revision_prepared", at: preparedAt, preparationId,
    sourceC1PlanId: previous.c1ProductPlan.c1PlanId, targetC1PlanId, sourceRevision: previous.dataRevision,
    resultRevision: sku.dataRevision, externalCalls: 0, productionAuthorized: false });
  assertValidC1ProductPlan(plan);
  const checked = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights, verifiedAt: preparedAt }).skuPackage;
  next.lifecycleV11.skuPackage = structuredClone(checked);
  next.dataRevision += 1; next.updatedAt = preparedAt; next.lastModifiedBy = "software";
  const preparation = { schemaVersion: "c1-final-plan-revision-preparation-v1", status: "facts_prepared", preparationId,
    candidateId: candidate.id, sourceCandidateRevision: expectedRevision, sourceSkuRevision: previous.dataRevision,
    resultCandidateRevision: next.dataRevision, resultSkuRevision: checked.dataRevision,
    skuPackageId: previous.skuPackageId, supplierSkuId: previous.supplierSkuId, variantKey: previous.variantKey,
    sourceC1PlanId: previous.c1ProductPlan.c1PlanId, targetC1PlanId,
    sourceCardId: previous.productionConfirmationCard.cardId, historyRef: preparationId, preparedAt,
    sourceFinalAssetCount: previous.c2FinalAssets.assets.finalUploads.length,
    sourceFinalManifestSha256: previous.c2FinalAssets.ownerFinalUploadConfirmation.approvedManifestSha256,
    sourceFactsRevisionId: sourceFactsRevision.revisionId,
    productionAuthorized: false, externalCalls: 0, paidCalls: 0, oldHistoryOverwritten: false };
  const previousC1References = buildC1FinalPlanHistoryReferences(life);
  clearC1FinalPlanActiveReferences(next.lifecycleV11);
  next.lifecycleV11.c1FinalPlanRevisionPreparation = preparation;
  const historyRecord = { schemaVersion: "c1-final-plan-revision-history-v1", preparationId, candidateId: candidate.id,
    sourceCandidateRevision: expectedRevision, sourceSkuRevision: previous.dataRevision,
    previousSkuPackage: structuredClone(previous), previousC1References };
  next.lifecycleV11.c1FinalPlanRevisionHistory = [...(life.c1FinalPlanRevisionHistory ?? []), {
    schemaVersion: "c1-final-plan-revision-history-ref-v1", preparationId, sourceCandidateRevision: expectedRevision, sourceSkuRevision: previous.dataRevision,
    sourceIdentity: structuredClone(previous.g1Identity), variantKey: previous.variantKey,
    sourceC1PlanId: previous.c1ProductPlan.c1PlanId,
    sourceFinalAssets: { assets: { finalUploads: structuredClone(previous.c2FinalAssets.assets.finalUploads) },
      ownerFinalUploadConfirmation: structuredClone(previous.c2FinalAssets.ownerFinalUploadConfirmation),
      effectiveVideoRequirement: structuredClone(previous.c2FinalAssets.effectiveVideoRequirement),
      sourceC1Fingerprint: previous.c2FinalAssets.targetContext.sourceC1Fingerprint }
  }];
  if (!isDeepStrictEqual(checked.profitModels, previous.profitModels) ||
      !isDeepStrictEqual(checked.selectedSupplySnapshot, previous.selectedSupplySnapshot) ||
      !isDeepStrictEqual(checked.c1ProductPlan.inputSnapshots.platformSchemaRules, previous.c1ProductPlan.inputSnapshots.platformSchemaRules)) {
    fail("C1_FINAL_REVISION_FROZEN_INPUT_CHANGED");
  }
  const mappingGaps = checked.c1ProductPlan.productAttributes.ozonAttributes.filter(item => item.fact.verificationStatus === "unknown")
    .map(item => ({ code: "C1_FINAL_REVISION_ATTRIBUTE_MAPPING_REQUIRED", fieldKey: item.fieldKey, reason: item.fact.reason }));
  return { candidate: next, preparation: structuredClone(preparation), historyRecord, mappingGaps,
    nextStep: "prepare_new_c1_seo_request", finalCardCreated: false, productionAuthorized: false };
}


/** Reuse an unchanged, already signed asset manifest after a new formal SEO
 * receipt. The old signature timestamp is preserved; reuse has its own audit. */
export function completeC1FinalPlanRevision({ candidate, historyRecord, expectedRevision, completedAt }) {
  if (!candidate || candidate.dataRevision !== expectedRevision || !Number.isSafeInteger(expectedRevision) ||
      !isRuntimeConfigurationTimestamp(completedAt)) fail("C1_FINAL_REVISION_INPUT_INVALID");
  const life = candidate.lifecycleV11, prep = life?.c1FinalPlanRevisionPreparation, current = life?.skuPackage;
  const history = life?.c1FinalPlanRevisionHistory?.filter(item => item.preparationId === prep?.historyRef);
  if (!prep || prep.schemaVersion !== "c1-final-plan-revision-preparation-v1" || prep.candidateId !== candidate.id ||
      prep.resultCandidateRevision > expectedRevision || !Array.isArray(history) || history.length !== 1 ||
      current?.c1ProductPlan?.status !== "seo_draft_ready" || current.c1ProductPlan.c1PlanId !== prep.targetC1PlanId ||
      current.c1ProductPlan.sourceFactsRevision?.revisionId !== prep.sourceFactsRevisionId ||
      current.c1ProductPlan.supersedes?.historyRef !== prep.historyRef ||
      current.c1ProductPlan.supersedes?.c1PlanId !== prep.sourceC1PlanId ||
      Date.parse(completedAt) < Date.parse(prep.preparedAt) || life.c1FinalPlanRevisionCompletion !== undefined) {
    fail("C1_FINAL_REVISION_COMPLETION_SOURCE_MISMATCH");
  }
  if (historyRecord?.schemaVersion !== "c1-final-plan-revision-history-v1" || historyRecord.preparationId !== prep.historyRef ||
      historyRecord.candidateId !== candidate.id || historyRecord.sourceCandidateRevision !== prep.sourceCandidateRevision ||
      historyRecord.sourceSkuRevision !== prep.sourceSkuRevision) fail("C1_FINAL_REVISION_HISTORY_REQUIRED");
  const previous = historyRecord.previousSkuPackage, plan = current.c1ProductPlan;
  if (history[0].schemaVersion !== "c1-final-plan-revision-history-ref-v1" || !isDeepStrictEqual(history[0].sourceIdentity, previous?.g1Identity) || history[0].variantKey !== previous?.variantKey ||
      history[0].sourceC1PlanId !== previous?.c1ProductPlan?.c1PlanId ||
      !isDeepStrictEqual(history[0].sourceFinalAssets, { assets: { finalUploads: previous?.c2FinalAssets?.assets?.finalUploads },
        ownerFinalUploadConfirmation: previous?.c2FinalAssets?.ownerFinalUploadConfirmation,
        effectiveVideoRequirement: previous?.c2FinalAssets?.effectiveVideoRequirement,
        sourceC1Fingerprint: previous?.c2FinalAssets?.targetContext?.sourceC1Fingerprint })) fail("C1_FINAL_REVISION_HISTORY_REQUIRED");
  if (previous?.productionConfirmationCard?.cardId !== prep.sourceCardId || previous.c1ProductPlan.c1PlanId !== prep.sourceC1PlanId ||
      previous.dataRevision !== prep.sourceSkuRevision || history[0].sourceCandidateRevision !== prep.sourceCandidateRevision ||
      !isDeepStrictEqual(previous.g1Identity, current.g1Identity) || previous.variantKey !== current.variantKey ||
      !isDeepStrictEqual(previous.selectedSupplySnapshot, current.selectedSupplySnapshot) ||
      !isDeepStrictEqual(previous.profitModels, current.profitModels) || previous.activeProfitModelVersion !== current.activeProfitModelVersion ||
      !isDeepStrictEqual(previous.c1ProductPlan.inputSnapshots, plan.inputSnapshots)) fail("C1_FINAL_REVISION_COMPLETION_SOURCE_MISMATCH");
  const original = structuredClone(previous);
  original.productionConfirmationCard = null;
  assertC2FrozenContractCurrent(original);
  if (!isDeepStrictEqual(createFinalProductPlanConfirmationCard({ skuPackage: original,
    createdAt: previous.productionConfirmationCard.createdAt }).confirmationCard, previous.productionConfirmationCard)) {
    fail("C1_FINAL_REVISION_SOURCE_CARD_CHANGED");
  }
  assertValidC1ProductPlan(plan);
  const review = plan.draftOnlySeo?.sourceType === "owner_confirmed_editorial"
    ? life.c1EditorialContentReviewV1 : life.c1ContentReviewV1;
  const expectedReviewSchema = plan.draftOnlySeo?.sourceType === "owner_confirmed_editorial"
    ? "c1-editorial-content-review-v1" : "c1-content-review-v1";
  if (review?.schemaVersion !== expectedReviewSchema || review.status !== "confirmed" ||
      review.candidateId !== candidate.id || review.skuPackageId !== current.skuPackageId ||
      review.contentFingerprint !== fingerprintC2SourceC1(current) || review.productionAuthorizationGranted !== false ||
      typeof review.confirmedByUserId !== "string" || !review.confirmedByUserId.trim() ||
      !isRuntimeConfigurationTimestamp(review.confirmedAt) || Date.parse(review.confirmedAt) > Date.parse(completedAt) ||
      !Number.isSafeInteger(review.sourceRevision) || review.sourceRevision > expectedRevision ||
      review.resultRevision !== review.sourceRevision + 1 ||
      (expectedReviewSchema === "c1-content-review-v1" && review.receiptRef !== plan.seoEvidenceLayer.aiReceiptId)) {
    fail("C1_FINAL_REVISION_CONTENT_CONFIRMATION_REQUIRED");
  }
  assertCurrentC1SkuRightsReview({ plan, sourceIdentity: current.g1Identity, observedAt: completedAt });
  const oldC2 = previous.c2FinalAssets, confirmation = oldC2.ownerFinalUploadConfirmation;
  const initialized = createC2SoftwareContainer({ skuPackage: current, expectedDataRevision: current.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: completedAt }).skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: initialized, expectedDataRevision: initialized.dataRevision,
    finalUploadAssets: oldC2.assets.finalUploads, ownerVideoRequirement: oldC2.ownerVideoRequirement, preparedAt: completedAt });
  if (manifest.manifestSha256 !== confirmation.approvedManifestSha256 || manifest.manifestSha256 !== prep.sourceFinalManifestSha256 ||
      manifest.assets.length !== prep.sourceFinalAssetCount || !isDeepStrictEqual(manifest.assets, oldC2.assets.finalUploads) ||
      !isDeepStrictEqual(manifest.effectiveVideoRequirement, oldC2.effectiveVideoRequirement)) {
    fail("C1_FINAL_REVISION_ASSET_CONFIRMATION_CHANGED");
  }
  const completed = structuredClone(confirmFinalUploads({ skuPackage: initialized, finalUploadAssets: manifest.assets,
    ownerVideoRequirement: manifest.ownerVideoRequirement, ownerDecision: confirmation,
    confirmedAt: confirmation.confirmedAt, observedAt: completedAt }).skuPackage);
  if (!isDeepStrictEqual(completed.c2FinalAssets.ownerFinalUploadConfirmation, confirmation)) fail("C1_FINAL_REVISION_ASSET_CONFIRMATION_CHANGED");
  const sourceConfirmationRef = `${prep.historyRef}#/previousSkuPackage/c2FinalAssets/ownerFinalUploadConfirmation`;
  completed.c2FinalAssets.updatedAt = completedAt;
  completed.audit.updatedAt = completedAt;
  completed.audit.history.push({ event: "c2_final_uploads_confirmation_reused", at: completedAt, reusedAt: completedAt,
    sourceConfirmationRef, originalConfirmedAt: confirmation.confirmedAt, preparationId: prep.preparationId,
    approvedManifestSha256: confirmation.approvedManifestSha256, newOwnerSignature: false, productionAuthorizationCreated: false });
  const final = createFinalProductPlanConfirmationCard({ skuPackage: completed, createdAt: completedAt }).skuPackage;
  if (!isDeepStrictEqual(final.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.sourceFactsRevision,
      plan.sourceFactsRevision)) fail("C1_FINAL_REVISION_FINAL_SNAPSHOT_CHANGED");
  const next = structuredClone(candidate);
  next.lifecycleV11.skuPackage = structuredClone(final);
  next.dataRevision += 1; next.updatedAt = completedAt; next.lastModifiedBy = "software";
  next.lifecycleV11.c1FinalPlanRevisionCompletion = { schemaVersion: "c1-final-plan-revision-completion-v1",
    preparationId: prep.preparationId, sourceCandidateRevision: expectedRevision, resultCandidateRevision: next.dataRevision,
    sourceSkuRevision: current.dataRevision, resultSkuRevision: final.dataRevision, sourceConfirmationRef,
    originalConfirmedAt: confirmation.confirmedAt, reusedAt: completedAt, confirmationCardId: final.productionConfirmationCard.cardId,
    productionAuthorized: false, newOwnerSignature: false };
  return { candidate: next, completion: structuredClone(next.lifecycleV11.c1FinalPlanRevisionCompletion),
    finalCardCreated: true, productionAuthorized: false };
}
