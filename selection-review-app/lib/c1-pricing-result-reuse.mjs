import { isDeepStrictEqual as equal } from "node:util";
import { assertValidC1ProductPlan, verifyC1ProductFacts, collectC1UnknownManifest, validateC1ProductPlan } from "./c1-product-plan.mjs";
import { mergeC1AiDraftReceipt } from "./c1-ai-draft-contract.mjs";
import { assertC1SkuRightsReviewEvidence, projectC1SkuRightsReviewFacts, C1SkuRightsReviewError } from "./c1-sku-rights-review.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";

export const C1_PRICING_REUSE_VERSION = "c1-pricing-result-reuse-v1";
export const C1_PRICING_REUSE_REFERENCE_VERSION = "c1-pricing-result-reuse-reference-v1";
export class C1PricingReuseError extends Error {
  constructor(code) { super(code); this.name = "C1PricingReuseError"; this.code = code; }
}
const fail = code => { throw new C1PricingReuseError(code); };
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const FACTS = ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment", "categoryRestrictions", "platformCompliance"];
const CONTENT = ["seoTitleDraft", "descriptionDraft", "bulletPointsDraft", "searchKeywordsDraft", "seoEvidenceLayer", "keywordEvidenceRefs"];
const FIELDS = ["schemaVersion", "observedAt", "sourcePlan", "sourceIdentity", "request", "receipt", "settledExecution", "targetPlanId", "targetProfitModelVersion", "resultSkuRevision"];

export function assertC1PricingReuseRecordSource(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== FIELDS.length ||
      FIELDS.some(key => !Object.hasOwn(record, key)) || record.schemaVersion !== C1_PRICING_REUSE_VERSION || !instant(record.observedAt) ||
      !Number.isSafeInteger(record.resultSkuRevision)) fail("C1_PRICING_REUSE_RECORD_INVALID");
  const source = record.sourcePlan;
  if (!source || source.draftOnlySeo?.pricingReuseRecord !== undefined || source.status !== "seo_draft_ready") fail("C1_PRICING_REUSE_SOURCE_INVALID");
  if (!validateC1ProductPlan(source).valid) fail("C1_PRICING_REUSE_SOURCE_INVALID");
  const { request, receipt, settledExecution } = record;
  if (!request || !receipt || !settledExecution) fail("C1_PRICING_REUSE_SOURCE_MISSING");
  // Validate the original completion using its original plan and revision. No request is sent or rewritten.
  mergeC1AiDraftReceipt({ skuPackage: { c1ProductPlan: source, g1Identity: record.sourceIdentity,
    skuPackageId: source.identity.skuPackageId, supplierSkuId: source.identity.supplierSkuId,
    targetPlatform: source.identity.targetPlatform, targetStore: source.identity.targetStore,
    dataRevision: request.sourceSkuRevision + 1 }, request, receipt, settledExecution, mergedAt: record.observedAt });
  if (Date.parse(record.observedAt) < Date.parse(receipt.completedAt)) fail("C1_PRICING_REUSE_TIME_INVALID");
  const keywords = request.keywordEvidence;
  if (!instant(keywords.observedAt) || Date.parse(keywords.observedAt) > Date.parse(request.requestedAt)) fail("C1_PRICING_REUSE_KEYWORDS_TIME_INVALID");
  if (keywords.expiresAt !== undefined) {
    if (!instant(keywords.expiresAt) || Date.parse(keywords.expiresAt) <= Date.parse(record.observedAt)) fail("C1_PRICING_REUSE_KEYWORDS_EXPIRED");
  } else if (keywords.collectionMode !== "current_frozen_facts_no_volume") fail("C1_PRICING_REUSE_KEYWORDS_VALIDITY_MISSING");
  try {
    assertC1SkuRightsReviewEvidence({ review: source.inputSnapshots.skuRightsReview, plan: source,
      sourceIdentity: record.sourceIdentity, observedAt: record.observedAt });
  } catch (error) {
    if (error instanceof C1SkuRightsReviewError && error.code === "C1_SKU_RIGHTS_REVIEW_EXPIRED") fail("C1_PRICING_REUSE_RIGHTS_EXPIRED");
    if (error instanceof C1SkuRightsReviewError && error.code === "C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID") fail("C1_PRICING_REUSE_RIGHTS_NOT_YET_VALID");
    throw error;
  }
  if (source.inputSnapshots.skuRightsReview.rights.status !== "verified") fail("C1_PRICING_REUSE_RIGHTS_UNVERIFIED");
}

/** The complete record remains in the sibling C1 snapshot of the frozen card. */
export function createC1PricingReuseReference({ record, identity, resultSkuRevision, targetPlanId, targetProfitModelVersion }) {
  assertC1PricingReuseRecordSource(record);
  if (!equal(record.sourceIdentity, identity) || record.resultSkuRevision !== resultSkuRevision ||
      record.targetPlanId !== targetPlanId || record.targetProfitModelVersion !== targetProfitModelVersion) {
    fail("C1_PRICING_REUSE_REFERENCE_SOURCE_MISMATCH");
  }
  return {
    schemaVersion: C1_PRICING_REUSE_REFERENCE_VERSION,
    sourceIdentity: structuredClone(identity),
    resultSkuRevision,
    targetPlanId,
    targetProfitModelVersion,
    recordFingerprint: fingerprintCanonicalRecord(record)
  };
}

function assertFactsUnchanged(source, target) {
  if (!equal(source.identity, target.identity) ||
      !equal(source.inputSnapshots.confirmedSupplierSkuSnapshot, target.inputSnapshots.confirmedSupplierSkuSnapshot)) fail("C1_PRICING_REUSE_SUPPLY_CHANGED");
  const { collectedAt: sourceCollectedAt, ...sourceRules } = source.inputSnapshots.platformSchemaRules;
  const { collectedAt: targetCollectedAt, ...targetRules } = target.inputSnapshots.platformSchemaRules;
  if (!equal(sourceRules, targetRules) || !instant(targetCollectedAt) || Date.parse(targetCollectedAt) < Date.parse(sourceCollectedAt)) fail("C1_PRICING_REUSE_SCHEMA_CHANGED");
  const expected = Object.fromEntries(FACTS.map(key => [key, structuredClone(source[key])]));
  expected.exactSkuVerification.verifiedAt = target.exactSkuVerification.verifiedAt;
  expected.schemaSnapshot.collectedAt = { ...expected.schemaSnapshot.collectedAt, value: targetCollectedAt };
  // A newly selected market sample may supply the same category path. Its value must remain equal;
  // only that explicit source pointer and the two passed-profit references can change.
  const oldPath = expected.platformCategory.categoryPath, newPath = target.platformCategory.categoryPath;
  if (!equal({ ...oldPath, sourceRefs: [] }, { ...newPath, sourceRefs: [] }) ||
      !equal(oldPath.sourceRefs, [`${source.inputRefs.salesSnapshotId}#/categoryPath`]) ||
      !equal(newPath.sourceRefs, [`${target.inputRefs.salesSnapshotId}#/categoryPath`])) fail("C1_PRICING_REUSE_MARKET_FACT_CHANGED");
  oldPath.sourceRefs = structuredClone(newPath.sourceRefs);
  const oldProfit = `${source.inputRefs.profitModelVersion}#/result`, newProfit = `${target.inputRefs.profitModelVersion}#/result`;
  for (const field of ["status", "profitGate"]) expected.platformCompliance[field].sourceRefs = expected.platformCompliance[field].sourceRefs.map(ref => ref === oldProfit ? newProfit : ref);
  for (const key of FACTS) if (!equal(expected[key], target[key])) fail("C1_PRICING_REUSE_FACT_CHANGED");
}

/** Pure replay validation of a historical result reuse record, including frozen C2 reads. */
export function assertC1PricingResultReuse({ plan, resultSkuRevision }) {
  const record = plan?.draftOnlySeo?.pricingReuseRecord;
  assertC1PricingReuseRecordSource(record);
  if (record.targetPlanId !== plan.c1PlanId || record.targetProfitModelVersion !== plan.inputRefs.profitModelVersion ||
      record.resultSkuRevision !== resultSkuRevision || record.resultSkuRevision <= record.request.sourceSkuRevision + 1 ||
      plan.factsVerifiedAt !== record.observedAt || plan.exactSkuVerification?.verifiedAt !== record.observedAt ||
      Date.parse(plan.inputSnapshots.platformSchemaRules.collectedAt) > Date.parse(record.observedAt) ||
      plan.inputSnapshots.profitModel.result !== "passed" || plan.inputSnapshots.profitModel.profitModelVersion !== record.targetProfitModelVersion ||
      !equal(plan.inputSnapshots.skuRightsReview, record.sourcePlan.inputSnapshots.skuRightsReview)) fail("C1_PRICING_REUSE_TARGET_CONFLICT");
  assertFactsUnchanged(record.sourcePlan, plan);
  if (!equal(plan.unknownManifest, collectC1UnknownManifest(plan))) fail("C1_PRICING_REUSE_FACT_CHANGED");
  for (const key of CONTENT) if (!equal(plan[key], record.sourcePlan[key])) fail("C1_PRICING_REUSE_CONTENT_CHANGED");
  const { pricingReuseRecord, ...draft } = plan.draftOnlySeo;
  if (!equal(draft, record.sourcePlan.draftOnlySeo)) fail("C1_PRICING_REUSE_PROVIDER_CHANGED");
  return record;
}

export function reuseC1PricingResult({ previousSkuPackage, revisedSkuPackage, previousRequest, previousReceipt, previousSettledExecution, observedAt }) {
  if (!instant(observedAt)) fail("C1_PRICING_REUSE_TIME_INVALID");
  const prior = previousSkuPackage?.c1ProductPlan, revised = revisedSkuPackage?.c1ProductPlan;
  if (!prior || !revised || prior.status !== "seo_draft_ready" || revised.status !== "inputs_ready" || revisedSkuPackage.businessPhase !== "C1" ||
      !equal(previousSkuPackage.g1Identity, revisedSkuPackage.g1Identity) || revisedSkuPackage.c2FinalAssets !== null ||
      revisedSkuPackage.productionAuthorization || revisedSkuPackage.productionRecord) fail("C1_PRICING_REUSE_STAGE_INVALID");
  const inherited = prior.draftOnlySeo?.pricingReuseRecord;
  if (inherited) assertC1PricingResultReuse({ plan: prior,
    resultSkuRevision: previousSkuPackage.c2FinalAssets?.softwareState?.sourceDataRevision ?? previousSkuPackage.dataRevision });
  const sourcePlan = inherited?.sourcePlan ?? prior;
  const request = previousRequest ?? inherited?.request, receipt = previousReceipt ?? inherited?.receipt,
    settledExecution = previousSettledExecution ?? inherited?.settledExecution;
  if (!request || !receipt || !settledExecution) fail("C1_PRICING_REUSE_SOURCE_MISSING");
  const record = { schemaVersion: C1_PRICING_REUSE_VERSION, observedAt, sourcePlan: structuredClone(sourcePlan),
    sourceIdentity: structuredClone(previousSkuPackage.g1Identity), request: structuredClone(request), receipt: structuredClone(receipt),
    settledExecution: structuredClone(settledExecution), targetPlanId: revised.c1PlanId,
    targetProfitModelVersion: revised.inputRefs.profitModelVersion, resultSkuRevision: revisedSkuPackage.dataRevision + 2 };
  assertC1PricingReuseRecordSource(record);
  const checked = verifyC1ProductFacts({ skuPackage: revisedSkuPackage, skuRightsReview: null, verifiedAt: observedAt }).skuPackage;
  const next = structuredClone(checked), plan = next.c1ProductPlan;
  plan.inputSnapshots.skuRightsReview = structuredClone(sourcePlan.inputSnapshots.skuRightsReview);
  plan.platformCompliance.skuRightsReview = projectC1SkuRightsReviewFacts(plan.inputSnapshots.skuRightsReview, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`);
  plan.draftOnlySeo = { ...structuredClone(sourcePlan.draftOnlySeo), pricingReuseRecord: record };
  plan.status = "seo_draft_ready";
  for (const key of CONTENT) plan[key] = structuredClone(sourcePlan[key]);
  plan.unknownManifest = collectC1UnknownManifest(plan);
  next.dataRevision += 1;
  next.audit.updatedAt = observedAt;
  next.audit.history.push({ event: "c1_historical_result_reused_after_pricing", at: observedAt,
    sourceC1PlanId: sourcePlan.c1PlanId, targetC1PlanId: plan.c1PlanId, providerCalls: 0, productionStarted: false });
  assertC1PricingResultReuse({ plan, resultSkuRevision: next.dataRevision });
  assertValidC1ProductPlan(plan);
  return { skuPackage: next, reuseRecord: structuredClone(record), externalAccesses: [], providerCalls: 0 };
}
