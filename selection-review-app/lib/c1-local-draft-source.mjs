import { isDeepStrictEqual } from "node:util";
import { assertC1SupplierFactRevisionProjection, readConfirmedSupplierTextReferences } from "./confirmed-supplier-inputs.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { produceC1LocalPreparation, C1_LOCAL_PREPARATION_VERSION } from "./c1-keyword-planning-local-material.mjs";
import { verifyC1ProductFacts, applyC1SkuAttributeScopeReview } from "./c1-product-plan.mjs";
import { resolveC1SkuRightsReviewForFacts, assertCurrentC1SkuRightsReview, C1_SKU_RIGHTS_REVIEW_FAILURE_CODES } from "./c1-sku-rights-review.mjs";
import { projectC1CompetitorTextSnapshot } from "./c1-software-input-preparation.mjs";
import { createC1SeoReferenceContext } from "./c1-seo-review-contract.mjs";
import { C1_SEO_REFERENCE_CONTEXT_VERSION, C1_SUPPLIER_REFERENCE_CONTEXT_VERSION, resolveC1ImageTextEvidenceForRequest, savedC1CompetitorDescriptions } from "./c1-seo-reference-context.mjs";

export const C1_LOCAL_DRAFT_SOURCE_VERSION = "c1-local-draft-source-v2";
const LEGACY_SOURCE_VERSION = "c1-local-draft-source-v1";
export const isC1LocalDraftSourceVersion = version => [LEGACY_SOURCE_VERSION, C1_LOCAL_DRAFT_SOURCE_VERSION].includes(version);
export const C1_LOCAL_WRITING_RULES_VERSION = "c1-local-writing-rules-v1";
export const C1_LOCAL_DRAFT_FAILURE_CODES = Object.freeze([
  "C1_LOCAL_DRAFT_INPUT_INVALID", "C1_LOCAL_DRAFT_MATERIAL_INVALID", "C1_LOCAL_DRAFT_SKU_REVISION_DRIFT",
  "C1_LOCAL_DRAFT_MATERIAL_DRIFT", "C1_LOCAL_DRAFT_RIGHTS_REQUIRED", "C1_LOCAL_DRAFT_WRITING_RULES_MISSING",
  "C1_LOCAL_DRAFT_SOURCE_DRIFT", "C1_LOCAL_DRAFT_KEYWORD_SCOPE_INVALID", "C1_LOCAL_DRAFT_KEYWORD_FACT_DRIFT",
  "C1_LOCAL_DRAFT_TITLE_KEYWORD_MISSING", "C1_LOCAL_DRAFT_FACT_SCOPE_INVALID",
  "C1_SEO_REFERENCE_CONTEXT_INVALID", "C1_SEO_REFERENCE_CONTEXT_VERSION_REQUIRED",
  "C1_AI_FACT_DEFINITIONS_INVALID", "C1_AI_FACT_DEFINITIONS_SOURCE_DRIFT",
  "OWNER_PRODUCT_FACTS_SOURCE_MISMATCH", "OWNER_PRODUCT_FACTS_RECORD_INVALID",
  "C1_SUPPLIER_FACT_REVISION_OWNER_SOURCE_MISMATCH", "C1_SUPPLIER_FACT_REVISION_OWNER_TIME_INVALID",
  "C1_SUPPLIER_FACT_REVISION_OWNER_PROJECTION_CHANGED",
  "CONFIRMED_SUPPLIER_TEXT_SOURCE_MISMATCH", "CONFIRMED_SUPPLIER_TEXT_INVALID",
  "CONFIRMED_SUPPLIER_SNAPSHOT_MISMATCH", "CONFIRMED_VARIANT_CAPTURE_MISMATCH", "CONFIRMED_VARIANT_IDENTITY_MISMATCH",
  "CONFIRMED_VARIANT_ATTRIBUTE_INVALID", "CONFIRMED_VARIANT_OWNER_SELECTION_MISSING", "CONFIRMED_BRAND_SOURCE_MISMATCH",
  "CONFIRMED_CARGO_RECORD_INVALID", "CONFIRMED_CARGO_SOURCE_MISMATCH",
  "C1_IMAGE_TEXT_CANDIDATE_INVALID", "C1_IMAGE_TEXT_LINEAGE_INVALID", "C1_IMAGE_TEXT_MANIFEST_UNCONFIRMED",
  "C1_IMAGE_TEXT_MANIFEST_INVALID", "C1_IMAGE_TEXT_ASSET_IDENTITY_INVALID", "C1_IMAGE_TEXT_EVIDENCE_INVALID",
  "C1_IMAGE_TEXT_MANIFEST_CHANGED", "C1_IMAGE_TEXT_RECEIPT_MISMATCH", "C1_IMAGE_TEXT_SOURCE_IDENTITY_MISMATCH",
  "C1_LOCAL_PREPARATION_INPUT_INVALID", "C1_LOCAL_PREPARATION_PHASE_REJECTED", "C1_LOCAL_PREPARATION_IDENTITY_INVALID",
  "C1_INPUT_PREPARATION_SALES_INVALID", "C1_RIGHTS_RECORD_INVALID", "C1_RIGHTS_RECORD_DECLARATION_MISMATCH", "C1_RIGHTS_SOURCE_EVIDENCE_INVALID",
  "C1_ATTRIBUTE_SCOPE_PHASE_REJECTED", "C1_ATTRIBUTE_SCOPE_REVIEW_INVALID", "C1_ATTRIBUTE_SCOPE_SOURCE_MISMATCH",
  "C1_AI_LOCAL_SEO_RULES_INVALID", "C1_AI_LOCAL_RULES_SOURCE_MISMATCH", ...C1_SKU_RIGHTS_REVIEW_FAILURE_CODES
]);
const FIELDS_BY_PURPOSE = Object.freeze({ title: ["title"], attributes: ["searchKeywords"], description: ["description", "bulletPoints"] });
const SAFE_FACT_PATHS = Object.freeze(["exactSkuVerification.supplierSkuId", "exactSkuVerification.variantKey",
  "productAttributes.weight", "productAttributes.dimensions", "platformCompliance.skuRightsReview.brand", "platformCompliance.skuRightsReview.rights"]);
const digest = fingerprintCanonicalRecord;
function fail(code) { throw new Error(code); }
function atPath(value, path) { return path.split(".").reduce((node, key) => node?.[key], value); }
function withoutFingerprint(value, field) { const copy = structuredClone(value); delete copy[field]; return copy; }
function confirmed(fact) { return fact?.verificationStatus === "confirmed" && fact.value !== "unknown" && Array.isArray(fact.sourceRefs) && fact.sourceRefs.length > 0; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

function materialFor(candidate) {
  if (!candidate || !Number.isInteger(candidate.dataRevision)) fail("C1_LOCAL_DRAFT_INPUT_INVALID");
  const material = candidate.lifecycleV11?.c1KeywordPlanningLocalMaterialV1;
  const sku = candidate.lifecycleV11?.skuPackage;
  if (material?.schemaVersion !== C1_LOCAL_PREPARATION_VERSION || material.status !== "ready_for_review" ||
      material.preparationOnly !== true || material.candidateId !== candidate.id || material.skuPackageId !== sku?.skuPackageId ||
      material.supplierSkuId !== sku.supplierSkuId || material.variantKey !== sku.variantKey ||
      material.targetPlatform !== sku.targetPlatform || material.targetStore !== sku.targetStore ||
      !isDeepStrictEqual(material.variantAttributes, candidate.sourceCapture?.skuChoices?.find(item => String(item.sourceSkuId) === sku.supplierSkuId)?.attributes ?? {}) ||
      !Number.isInteger(material.sourceCandidateRevision) || material.resultCandidateRevision !== material.sourceCandidateRevision + 1 ||
      material.resultCandidateRevision > candidate.dataRevision ||
      material.materialFingerprint !== digest(withoutFingerprint(material, "materialFingerprint"))) fail("C1_LOCAL_DRAFT_MATERIAL_INVALID");
  return material;
}

function allowedFactPaths(plan, material, version) {
  const paths = SAFE_FACT_PATHS.filter(path => confirmed(atPath(plan, path)));
  if (version === C1_LOCAL_DRAFT_SOURCE_VERSION) {
    for (const path of ["batteryAssessment.containsBattery", "batteryAssessment.batteryType", "batteryAssessment.assessment"]) {
      if (confirmed(atPath(plan, path))) paths.push(path);
    }
    const projection = assertC1SupplierFactRevisionProjection({ plan, sourceIdentity: plan.sourceFactsRevision?.sourceIdentity });
    if (projection.ownerFacts !== undefined) {
      projection.ownerFacts.forEach((attribute, index) => {
        if (confirmed(attribute.fact)) paths.push(`productAttributes.ownerDeclaredFacts.${index}.fact`);
      });
    }
    plan.productAttributes.supplierAttributes.forEach((attribute, index) => {
      if (Object.hasOwn(projection.attributeSources, attribute.fieldKey) && confirmed(attribute.fact)) {
        paths.push(`productAttributes.supplierAttributes.${index}.fact`);
      }
    });
  }
  for (const attribute of material.attributes) {
    if (attribute.status !== "confirmed") continue;
    const index = (plan.productAttributes.ozonAttributes ?? []).findIndex(item => String(item.fieldKey) === attribute.fieldKey);
    if (index >= 0 && confirmed(plan.productAttributes.ozonAttributes[index].fact)) paths.push(`productAttributes.ozonAttributes.${index}.fact`);
  }
  return [...new Set(paths)].sort();
}

function writingRules(material) {
  if (!Array.isArray(material.writingRules) || !material.writingRules.length || material.writingRules.some(rule => typeof rule !== "string" || !rule.trim()) ||
      typeof material.skillRef !== "string" || !material.skillRef.trim()) fail("C1_LOCAL_DRAFT_WRITING_RULES_MISSING");
  return { rulesVersion: C1_LOCAL_WRITING_RULES_VERSION, locale: "ru-RU", evidenceRef: `local-preparation:${material.materialFingerprint}`,
    frozenAt: material.producedAt, titleMaxLength: null, descriptionMaxLength: null, bulletPointLimit: null,
    limitsStatus: "not_verified", prohibitedClaims: [], writingRules: [...material.writingRules], skillRef: material.skillRef };
}

/** Pure preparation. The caller persists the returned SKU and source in the same
 * transaction as the formal request; this does not authorize or create an AI job. */
export function prepareC1LocalDraftSource({ candidate, preparedAt, sourceVersion = C1_LOCAL_DRAFT_SOURCE_VERSION }) {
  if (typeof preparedAt !== "string" || !Number.isFinite(Date.parse(preparedAt)) || new Date(preparedAt).toISOString() !== preparedAt) fail("C1_LOCAL_DRAFT_INPUT_INVALID");
  if (!isC1LocalDraftSourceVersion(sourceVersion)) fail("C1_LOCAL_DRAFT_INPUT_INVALID");
  const material = materialFor(candidate);
  const sku = candidate.lifecycleV11.skuPackage;
  if (material.sourceSkuRevision !== sku.dataRevision) fail("C1_LOCAL_DRAFT_SKU_REVISION_DRIFT");
  const comparisonCandidate = { ...candidate, dataRevision: material.sourceCandidateRevision };
  const rebuilt = produceC1LocalPreparation({ candidate: comparisonCandidate, expectedRevision: material.sourceCandidateRevision, producedAt: material.producedAt });
  if (rebuilt.status !== "ready" || !isDeepStrictEqual(rebuilt.material, material) ||
      rebuilt.production.inputFingerprint !== candidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1?.inputFingerprint) fail("C1_LOCAL_DRAFT_MATERIAL_DRIFT");
  const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt: preparedAt });
  if (rights.status !== "verified") fail(rights.code ?? "C1_LOCAL_DRAFT_RIGHTS_REQUIRED");
  const checkedSku = sku.c1ProductPlan.status === "inputs_ready"
    ? verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights.review, verifiedAt: preparedAt }).skuPackage : structuredClone(sku);
  const scopeReview = { schemaVersion: "c1-sku-attribute-scope-review-v1", evidenceRef: `local-preparation:${material.materialFingerprint}`,
    attributes: material.attributes.filter(attribute => attribute.status === "scope_unresolved").map(attribute => ({
      fieldKey: attribute.fieldKey, sourceFactPath: sku.ozonAttributeMappingsV1.mappings.find(mapping => String(mapping.attributeId) === attribute.fieldKey).sourceFactPath
    })) };
  const preparedSku = applyC1SkuAttributeScopeReview({ skuPackage: checkedSku, scopeReview, reviewedAt: preparedAt }).skuPackage;
  assertCurrentC1SkuRightsReview({ plan: preparedSku.c1ProductPlan, sourceIdentity: preparedSku.g1Identity, observedAt: preparedAt });
  const sourceEvidence = { schemaVersion: sourceVersion, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    materialFingerprint: material.materialFingerprint, sourceSkuRevision: material.sourceSkuRevision, preparedSkuRevision: preparedSku.dataRevision,
    preparedSkuFingerprint: digest(preparedSku), preparedAt, frozenSeoRules: writingRules(material),
    allowedFactPaths: allowedFactPaths(preparedSku.c1ProductPlan, material, sourceVersion) };
  sourceEvidence.sourceFingerprint = digest(sourceEvidence);
  return freeze({ skuPackage: preparedSku, sourceEvidence });
}

/** Revalidate the saved source before request creation and paid admission. */
export function resolveC1LocalDraftInputs(candidate, observedAt, { includeReferenceContext = false, referenceContextVersion } = {}) {
  const material = materialFor(candidate);
  const sku = candidate.lifecycleV11.skuPackage;
  const source = candidate.lifecycleV11.c1LocalDraftSourceV1;
  const plan = sku.c1ProductPlan;
  if (!isC1LocalDraftSourceVersion(source?.schemaVersion) || source.candidateId !== candidate.id || source.skuPackageId !== sku.skuPackageId ||
      source.materialFingerprint !== material.materialFingerprint || source.sourceSkuRevision !== material.sourceSkuRevision ||
      source.preparedSkuRevision !== sku.dataRevision || source.preparedSkuFingerprint !== digest(sku) ||
      source.sourceFingerprint !== digest(withoutFingerprint(source, "sourceFingerprint")) ||
      !isDeepStrictEqual(source.frozenSeoRules, writingRules(material)) || !isDeepStrictEqual(source.allowedFactPaths, allowedFactPaths(plan, material, source.schemaVersion))) fail("C1_LOCAL_DRAFT_SOURCE_DRIFT");
  assertCurrentC1SkuRightsReview({ plan, sourceIdentity: sku.g1Identity, observedAt });
  const evidenceId = `local-preparation:${material.materialFingerprint}`;
  const keywords = material.keywords.map((keyword, index) => {
    if (!source.allowedFactPaths.includes(keyword.factPath) || !Array.isArray(keyword.purposes) ||
        keyword.purposes.some(purpose => !Object.hasOwn(FIELDS_BY_PURPOSE, purpose))) fail("C1_LOCAL_DRAFT_KEYWORD_SCOPE_INVALID");
    const fact = atPath(plan, keyword.factPath);
    const value = typeof fact.value === "object" ? fact.value.value : fact.value;
    if (keyword.term !== value) fail("C1_LOCAL_DRAFT_KEYWORD_FACT_DRIFT");
    return { query: keyword.term, group: "confirmed_attribute", keywordEvidenceRef: `${evidenceId}#keywords/${index}`,
      relevanceStatus: "retained", factBindingPaths: [keyword.factPath], sourceRefs: [...keyword.sourceRefs],
      sourcePlatform: sku.targetPlatform, allowedOutputFields: [...new Set(keyword.purposes.flatMap(purpose => FIELDS_BY_PURPOSE[purpose]))] };
  });
  if (!keywords.some(keyword => keyword.allowedOutputFields.includes("title"))) fail("C1_LOCAL_DRAFT_TITLE_KEYWORD_MISSING");
  const competitorTextSnapshot = projectC1CompetitorTextSnapshot(plan);
  const contextVersion = referenceContextVersion ?? C1_SEO_REFERENCE_CONTEXT_VERSION;
  return { competitorTextSnapshot, seoRules: structuredClone(source.frozenSeoRules),
    ...(includeReferenceContext ? { referenceContext: createC1SeoReferenceContext({ competitorTextSnapshot, additionalTitles: material.competitorTextSnapshots,
      categoryPathFact: plan.platformCategory.categoryPath, contextVersion,
      ...([C1_SEO_REFERENCE_CONTEXT_VERSION, C1_SUPPLIER_REFERENCE_CONTEXT_VERSION].includes(contextVersion) ? { imageTextEvidence: resolveC1ImageTextEvidenceForRequest(candidate, observedAt),
        additionalDescriptions: savedC1CompetitorDescriptions(candidate, plan, material) } : {}),
      ...(contextVersion === C1_SUPPLIER_REFERENCE_CONTEXT_VERSION ? { supplierTexts: readConfirmedSupplierTextReferences(candidate) } : {}) }) } : {}),
    taskClassification: { complexity: "standard", preapprovedForSol: false, reason: "基于已确认属性和本地准备证据整理俄语草稿",
      markedBy: "software", markedAt: observedAt },
    keywordEvidence: { evidenceId, evidenceRef: evidenceId, status: "ready", targetPlatform: sku.targetPlatform,
      targetSkuPackageId: sku.skuPackageId, observedAt: material.producedAt, collectionMode: "local_preparation", sourcePlatform: sku.targetPlatform,
      sourceBindings: { sourceKind: "local_preparation", sourceVersion: source.schemaVersion,
        materialFingerprint: material.materialFingerprint, sourceFingerprint: source.sourceFingerprint,
        sourceSkuRevision: source.sourceSkuRevision, preparedSkuRevision: source.preparedSkuRevision, allowedFactPaths: [...source.allowedFactPaths] }, keywords } };
}

export function selectLocalDraftFacts(facts, keywordEvidence) {
  if (keywordEvidence?.collectionMode !== "local_preparation") return facts;
  const binding = keywordEvidence.sourceBindings;
  const allowed = binding?.allowedFactPaths;
  if (binding?.sourceKind !== "local_preparation" || !isC1LocalDraftSourceVersion(binding.sourceVersion) ||
      !/^[a-f0-9]{64}$/.test(binding.materialFingerprint) || !/^[a-f0-9]{64}$/.test(binding.sourceFingerprint) ||
      keywordEvidence.evidenceId !== `local-preparation:${binding.materialFingerprint}` ||
      !Number.isInteger(binding.sourceSkuRevision) || binding.sourceSkuRevision < 0 ||
      !Number.isInteger(binding.preparedSkuRevision) || binding.preparedSkuRevision < binding.sourceSkuRevision ||
      !Array.isArray(allowed) || !allowed.length || new Set(allowed).size !== allowed.length ||
      allowed.some(path => !SAFE_FACT_PATHS.includes(path) && !/^productAttributes\.ozonAttributes\.\d+\.fact$/.test(path) &&
        !(binding.sourceVersion === C1_LOCAL_DRAFT_SOURCE_VERSION && (/^productAttributes\.(supplierAttributes|ownerDeclaredFacts)\.\d+\.fact$/.test(path) ||
          ["batteryAssessment.containsBattery", "batteryAssessment.batteryType", "batteryAssessment.assessment"].includes(path)))) ||
      allowed.some(path => !facts.some(fact => fact.factPath === path))) fail("C1_LOCAL_DRAFT_FACT_SCOPE_INVALID");
  return facts.filter(fact => allowed.includes(fact.factPath));
}
