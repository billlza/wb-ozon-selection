import { assertCurrentC1AiDraftRequest, validateC1AiDraftRequest, buildC1AiDraftRequest, C1_FACT_DEFINITIONS_VERSION, C1_GATEWAY_INPUT_ENCODING_VERSION } from "./c1-ai-draft-contract.mjs";
import { assertCanonicalFrozenRef, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { prepareC1SoftwareInputs } from "./c1-software-input-preparation.mjs";
import { createC1SoftwareEvidenceStage } from "./c1-software-evidence-stage.mjs";
import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { resolveC1LocalDraftInputs } from "./c1-local-draft-source.mjs";
import { C1_SEO_REVIEW_OUTPUT_VERSION } from "./c1-seo-review-contract.mjs";
import { C1_SEO_REFERENCE_CONTEXT_VERSION, C1_SUPPLIER_REFERENCE_CONTEXT_VERSION, createC1SeoReferenceContext, resolveC1ImageTextEvidenceForRequest,
  savedC1CompetitorDescriptions } from "./c1-seo-reference-context.mjs";
import { readConfirmedSupplierTextReferences } from "./confirmed-supplier-inputs.mjs";

function closed(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(code);
}
function assertRequest(request) {
  if (!validateC1AiDraftRequest(request).valid) throw new Error("C1_DRAFT_REQUEST_INVALID");
}

export function prepareCurrentC1AiDraftRequest(candidate, observedAt, contractOptions = {}) {
  const options = { gatewayInputEncodingVersion: C1_GATEWAY_INPUT_ENCODING_VERSION, factDefinitionsVersion: C1_FACT_DEFINITIONS_VERSION, outputContractVersion: C1_SEO_REVIEW_OUTPUT_VERSION, ...contractOptions };
  if (options.referenceContextVersion === undefined && options.factDefinitionsVersion === C1_FACT_DEFINITIONS_VERSION) {
    options.referenceContextVersion = C1_SUPPLIER_REFERENCE_CONTEXT_VERSION;
  }
  const lifecycle = candidate.lifecycleV11;
  const sku = lifecycle?.skuPackage;
  if (lifecycle?.c1LocalDraftSourceV1 !== undefined) {
    const inputs = resolveC1LocalDraftInputs(candidate, observedAt, { includeReferenceContext: options.outputContractVersion === C1_SEO_REVIEW_OUTPUT_VERSION,
      referenceContextVersion: options.referenceContextVersion });
    return buildC1AiDraftRequest({ skuPackage: sku, ...inputs, requestedAt: observedAt, ...options });
  }
  const evidence = lifecycle?.c1SoftwareEvidenceV1;
  if (!evidence || !lifecycle.k3KeywordEvidenceSnapshotV1 || !lifecycle.k3CurrentBindingV1 ||
      evidence.candidateId !== candidate.id || evidence.skuPackageId !== sku?.skuPackageId ||
      evidence.sourceSkuRevision !== sku.dataRevision ||
      fingerprintCanonicalRecord(evidence.k3KeywordEvidenceSnapshot) !== fingerprintCanonicalRecord(lifecycle.k3KeywordEvidenceSnapshotV1) ||
      fingerprintCanonicalRecord(evidence.k3CurrentBinding) !== fingerprintCanonicalRecord(lifecycle.k3CurrentBindingV1)) throw new Error("C1_DRAFT_EVIDENCE_REQUIRED");
  const inputs = { skuPackage: sku, frozenSeoRules: evidence.frozenSeoRules, k3KeywordEvidenceSnapshot: evidence.k3KeywordEvidenceSnapshot,
    k3CurrentBinding: evidence.k3CurrentBinding, frozenComplexityDecision: evidence.frozenComplexityDecision };
  const historical = prepareC1SoftwareInputs({ ...inputs, preparedAt: evidence.stagedAt });
  createC1SoftwareEvidenceStage({ ...inputs, candidateId: candidate.id, candidateRevision: evidence.sourceCandidateRevision,
    preparedInputs: historical, stagedAt: evidence.stagedAt, existingEvidence: evidence });
  assertCurrentC1SkuRightsReview({ plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity, observedAt });
  const prepared = prepareC1SoftwareInputs({ ...inputs, preparedAt: observedAt });
  if (prepared.status !== "ready") throw new Error("C1_DRAFT_EVIDENCE_NOT_CURRENT");
  const contextVersion = options.referenceContextVersion ?? C1_SEO_REFERENCE_CONTEXT_VERSION;
  const referenceContext = options.outputContractVersion === C1_SEO_REVIEW_OUTPUT_VERSION ? createC1SeoReferenceContext({
    competitorTextSnapshot: prepared.inputs.competitorTextSnapshot, categoryPathFact: sku.c1ProductPlan.platformCategory.categoryPath, contextVersion,
    ...([C1_SEO_REFERENCE_CONTEXT_VERSION, C1_SUPPLIER_REFERENCE_CONTEXT_VERSION].includes(contextVersion) ? { imageTextEvidence: resolveC1ImageTextEvidenceForRequest(candidate, observedAt),
      additionalDescriptions: savedC1CompetitorDescriptions(candidate, sku.c1ProductPlan, { competitorTextSnapshots: [] }) } : {}),
    ...(contextVersion === C1_SUPPLIER_REFERENCE_CONTEXT_VERSION ? { supplierTexts: readConfirmedSupplierTextReferences(candidate) } : {}) }) : undefined;
  return buildC1AiDraftRequest({ skuPackage: sku, ...prepared.inputs, ...(referenceContext ? { referenceContext } : {}), requestedAt: observedAt, ...options });
}

/** Validate current evidence at admission only; historical receipt settlement does not call this gate. */
export function assertCurrentC1AiDraftRequestSources({ candidate, request, observedAt }) {
  assertRequest(request);
  assertCurrentC1AiDraftRequest({ skuPackage: candidate.lifecycleV11.skuPackage, request });
  const options = { gatewayInputEncodingVersion: request.gatewayInputEncodingVersion ?? null, factDefinitionsVersion: request.factDefinitionsVersion ?? null, outputContractVersion: request.outputContractVersion ?? null,
    ...(request.referenceContext ? { referenceContextVersion: request.referenceContext.schemaVersion } : {}) };
  const expected = prepareCurrentC1AiDraftRequest(candidate, request.requestedAt, options);
  if (fingerprintCanonicalRecord(expected) !== fingerprintCanonicalRecord(request)) throw new Error("C1_DRAFT_REQUEST_SOURCE_CONFLICT");
  prepareCurrentC1AiDraftRequest(candidate, observedAt, options);
  return Object.freeze(structuredClone(request));
}

export function assertC1DraftExecutionBinding(binding) {
  closed(binding, ["provider", "modelVersion", "credentialAlias", "allowedWorkerIds"], "C1_DRAFT_EXECUTION_BINDING_INVALID");
  if (!["terra", "sol"].includes(binding.provider) || binding.modelVersion !== `gpt-5.6-${binding.provider}` ||
      !Array.isArray(binding.allowedWorkerIds) || binding.allowedWorkerIds.length < 1 || binding.allowedWorkerIds.length > 32 ||
      new Set(binding.allowedWorkerIds).size !== binding.allowedWorkerIds.length) throw new Error("C1_DRAFT_EXECUTION_BINDING_INVALID");
  assertCanonicalFrozenRef(binding.credentialAlias, "credentialAlias");
  binding.allowedWorkerIds.forEach(id => assertCanonicalFrozenRef(id, "workerId"));
  return Object.freeze({ ...binding, allowedWorkerIds: Object.freeze([...binding.allowedWorkerIds]) });
}
