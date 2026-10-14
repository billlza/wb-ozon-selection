import { isDeepStrictEqual } from "node:util";
import { C1_SEO_REVIEW_OUTPUT_VERSION } from "./c1-seo-review-contract.mjs";
import { validateC1AiDraftRequest, validateC1AiDraftReceipt, assertAuthorizedC1Execution, assertCurrentC1AiDraftRequest,
  assertC1ProviderOutcome, assertC1ServiceTiming, mergeC1AiDraftReceipt } from "./c1-ai-draft-contract.mjs";
import { assertValidC1ProductPlan } from "./c1-product-plan.mjs";
import { fingerprintCanonicalRecord, assertNoRawPersistenceKeys, assertNoProductionSecrets } from "./production-contract-primitives.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export class C1EditorialSourceError extends Error {
  constructor(code) { super(code); this.name = "C1EditorialSourceError"; this.code = code; }
}
const fail = code => { throw new C1EditorialSourceError(code); };

/** Receipt/job provenance only. No job transition, admission or external request is performed. */
export function editorialSourceScopeIssue(sourceJob, request, receipt, sourceMode = "rejected") {
  if (!["rejected", "completed"].includes(sourceMode)) return "SOURCE_MODE_INVALID";
  const completed = sourceMode === "completed";
  const envelope = sourceJob?.resultEnvelope, payload = envelope?.payload, scope = sourceJob?.scopeBinding;
  const expectedStatus = completed ? "completed" : "failed";
  const expectedResultRef = completed ? receipt?.receiptId : receipt?.gatewayJobId;
  if (sourceJob?.schemaVersion !== "software-job-v1" || sourceJob.jobType !== "c1_ai_draft" || sourceJob.status !== expectedStatus || sourceJob.attempt !== 1 ||
      sourceJob.externalRequestState !== "succeeded" || envelope?.externalRequestState !== "succeeded" ||
      (completed ? sourceJob.failureClass !== null || payload?.schemaVersion !== "c1-ai-draft-software-result-v1" :
        sourceJob.failureClass !== "C1_AI_GATEWAY_RECEIPT_REJECTED" || payload?.schemaVersion !== "c1-ai-draft-software-failure-v1" ||
        payload.errorCode !== sourceJob.failureClass)) return completed ? "SOURCE_COMPLETED_JOB_REQUIRED" : "SOURCE_REJECTED_JOB_REQUIRED";
  if (!isDeepStrictEqual(payload.request, request) || sourceJob.jobId !== receipt?.softwareJobId ||
      sourceJob.progressRef !== receipt.gatewayJobId || sourceJob.resultRef !== expectedResultRef ||
      envelope.resultRef !== expectedResultRef ||
      (completed ? !isDeepStrictEqual(payload.receipt, receipt) : !isDeepStrictEqual(payload.accounting, receipt.accounting)) ||
      scope?.variantKey !== request.identity.variantKey || envelope.payloadFingerprint !== fingerprintCanonicalRecord(payload)) {
    return "SOURCE_RECEIPT_BINDING_MISMATCH";
  }
  const payloadKeys = completed ? ["schemaVersion", "request", "receipt"] : ["schemaVersion", "request", "accounting", "errorCode",
    ...(own(payload, "providerOutcome") ? ["providerOutcome"] : []), ...(own(payload, "serviceTiming") ? ["serviceTiming"] : [])];
  const envelopeKeys = ["schemaVersion", "resultRef", "jobId", "jobType", "candidateId", "skuPackageId", "revision", "workerId",
    "leaseId", "externalRequestRef", "externalRequestState", "payloadKind", "payload", "payloadFingerprint", "applicationDisposition", "recordedAt"];
  if (!closed(payload, payloadKeys) || !closed(envelope, envelopeKeys) || envelope.schemaVersion !== "software-job-result-envelope-v1" ||
      envelope.applicationDisposition !== (completed ? "applied" : "result_recorded_no_candidate_mutation") || envelope.payloadKind !== "c1_ai_draft" ||
      ["jobId", "jobType", "candidateId", "skuPackageId", "revision", "workerId", "leaseId", "externalRequestRef"].some(key => envelope[key] !== sourceJob[key]) ||
      !instant(sourceJob.startedAt) || !instant(sourceJob.completedAt) || !instant(envelope.recordedAt) ||
      Date.parse(sourceJob.startedAt) < Date.parse(request.requestedAt) || Date.parse(envelope.recordedAt) < Date.parse(sourceJob.startedAt) ||
      Date.parse(envelope.recordedAt) > Date.parse(sourceJob.completedAt) || Date.parse(receipt.completedAt) > Date.parse(envelope.recordedAt)) {
    return completed ? "SOURCE_COMPLETED_ENVELOPE_INVALID" : "SOURCE_FAILURE_ENVELOPE_INVALID";
  }
  const scopeKeys = ["schemaVersion", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "sourceSkuRevision",
    "identity", "variantKey", "sideEffectScope", "authorizationRef", "credentialAlias", "inputFingerprint", "requestFingerprint", "provider"];
  const admission = sourceJob.admissionDecision;
  if (!closed(scope, scopeKeys) || scope.schemaVersion !== "software-job-scope-v1" || scope.sideEffectScope !== "c1_ai_draft" ||
      scope.candidateId !== sourceJob.candidateId || scope.skuPackageId !== sourceJob.skuPackageId ||
      !Number.isSafeInteger(scope.sourceRevision) || scope.sourceRevision < 0 || scope.resultRevision !== scope.sourceRevision + 1 ||
      scope.resultRevision !== sourceJob.revision || scope.inputFingerprint !== request.requestFingerprint ||
      scope.requestFingerprint !== request.requestFingerprint || scope.provider !== request.provider ||
      !boundedText(scope.credentialAlias, 256) || !boundedText(sourceJob.externalRequestRef, 256) ||
      !boundedText(sourceJob.workerId, 256) || !boundedText(sourceJob.leaseId, 256) ||
      admission?.schemaVersion !== "software-job-admission-v1" || admission.jobId !== sourceJob.jobId ||
      admission.candidateId !== sourceJob.candidateId || admission.skuPackageId !== sourceJob.skuPackageId ||
      admission.revision !== sourceJob.revision || admission.jobType !== sourceJob.jobType ||
      admission.authorizationRef !== scope.authorizationRef || admission.credentialAlias !== scope.credentialAlias ||
      !/^[a-f0-9]{64}$/.test(admission.authorizationFingerprint ?? "") ||
      !/^[a-f0-9]{64}$/.test(admission.credentialBindingFingerprint ?? "")) return "SOURCE_EXECUTION_BINDING_INVALID";
  try {
    if (payload.providerOutcome !== undefined && payload.providerOutcome !== null &&
        assertC1ProviderOutcome(payload.providerOutcome).externalRequestState !== "succeeded") return "SOURCE_FAILURE_ENVELOPE_INVALID";
    if (payload.serviceTiming !== undefined) {
      const timing = assertC1ServiceTiming(payload.serviceTiming, { gatewayJobId: receipt.gatewayJobId });
      if (Date.parse(timing.startedAt) < Date.parse(sourceJob.startedAt) ||
          Date.parse(timing.completedAt) > Date.parse(envelope.recordedAt)) return "SOURCE_FAILURE_ENVELOPE_INVALID";
    }
    assertAuthorizedC1Execution({ request, authorizedExecution: {
      schemaVersion: "c1-ai-authorized-execution-v1", jobId: sourceJob.jobId, jobType: "c1_ai_draft",
      candidateRevision: sourceJob.revision, sourceSkuRevision: scope.sourceSkuRevision, identity: scope.identity,
      requestFingerprint: scope.requestFingerprint, status: "waiting_platform", externalRequestState: "in_flight",
      authorizationRef: { authorizationId: scope.authorizationRef, authorizationType: "paid_ai_draft", scope: {
        candidateId: sourceJob.candidateId, skuPackageId: sourceJob.skuPackageId, platform: scope.identity?.platform,
        storeRef: scope.identity?.storeRef?.stableStoreId, sourceRevision: scope.sourceSkuRevision, jobType: "c1_ai_draft" } }
    } });
  } catch (error) {
    if (error instanceof Error && /^(?:C1_AI_|C1_SERVICE_TIMING_|C1_SOURCE_|C1_G1_|PRODUCTION_AUTHORIZATION_)/.test(error.message)) return "SOURCE_EXECUTION_BINDING_INVALID";
    throw error;
  }
  return null;
}

const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const boundedText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 60 &&
  value.every(ref => boundedText(ref, 500)) && new Set(value).size === value.length;

// Missing evidenceRef fields alone may be restored from an exact frozen value.
// Every other key, array position and scalar must already match, even for an
// assertion that the editorial plan does not select.
function matchesFrozenEditorialValue(value, frozen) {
  if (isDeepStrictEqual(value, frozen)) return true;
  if (Array.isArray(value) || Array.isArray(frozen)) return Array.isArray(value) && Array.isArray(frozen) &&
    value.length === frozen.length && value.every((child, index) => matchesFrozenEditorialValue(child, frozen[index]));
  if (!object(value) || !object(frozen)) return false;
  return Object.keys(value).every(key => own(frozen, key)) && Object.keys(frozen).every(key =>
    own(value, key) ? matchesFrozenEditorialValue(value[key], frozen[key]) : key === "evidenceRef" && boundedText(frozen[key], 500));
}

/** An explicit maintenance review can propose different wording, but cannot
 * prove that wording semantically correct or grant permission to adopt it.
 * V1 repairs rejected output with full item coverage. V2 proposes bounded
 * bilingual edits to an applied result, with a separate versioned adoption source. */
export function assessC1DraftEditorialContent(input) {
  const base = { schemaVersion: "c1-draft-editorial-assessment-v1", status: "blocked", reasons: [],
    originalValidation: null, editedValidation: null, editedVersion: null };
  const blocked = (code, details = {}) => ({ ...base, reasons: [{ code, ...details }] });
  if (!closed(input, ["request", "receipt", "sourceJob", "correctionPlan"])) return blocked("EDITORIAL_INPUT_INVALID");
  const { request, receipt, sourceJob, correctionPlan } = input;
  const revision = correctionPlan?.schemaVersion === "c1-draft-editorial-plan-v2";
  try {
    assertNoRawPersistenceKeys(correctionPlan, "correctionPlan", { errorCode: "C1_EDITORIAL_INPUT_REJECTED" });
    assertNoProductionSecrets(correctionPlan, "correctionPlan");
  } catch (error) {
    if (!(error instanceof Error) || !/^(?:C1_EDITORIAL_INPUT_REJECTED|PRODUCTION_AUTHORIZATION_SECRET_REJECTED|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)(?::|$)/.test(error.message)) throw error;
    return blocked("EDITORIAL_PLAN_UNSAFE_OR_OVERSIZED");
  }
  if (!closed(correctionPlan, ["schemaVersion", "requestFingerprint", "sourceOutputFingerprint", "sourceSoftwareJobId", "items"]) ||
      !["c1-draft-editorial-plan-v1", "c1-draft-editorial-plan-v2"].includes(correctionPlan.schemaVersion) || !Array.isArray(correctionPlan.items) ||
      correctionPlan.items.length < (revision ? 1 : 2) || correctionPlan.items.length > 62) return blocked("EDITORIAL_PLAN_INVALID");
  // The bounded walk above has already rejected cycles/excessive depth. Reject
  // non-JSON values explicitly before measuring or copying the submitted plan.
  const pending = [correctionPlan];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object" || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return blocked("EDITORIAL_PLAN_INVALID");
    pending.push(...Object.values(value));
  }
  if (Buffer.byteLength(JSON.stringify(correctionPlan), "utf8") > 256_000) return blocked("EDITORIAL_PLAN_UNSAFE_OR_OVERSIZED");
  const requestValidation = validateC1AiDraftRequest(request);
  if (!requestValidation.valid) return blocked("REQUEST_INVALID", { errors: requestValidation.errors });
  base.originalValidation = validateC1AiDraftReceipt({ request, receipt });
  if (revision && (request.outputContractVersion !== C1_SEO_REVIEW_OUTPUT_VERSION || !base.originalValidation.valid)) {
    return blocked("EDITORIAL_VALID_BILINGUAL_SOURCE_REQUIRED");
  }
  if (correctionPlan.requestFingerprint !== request.requestFingerprint || correctionPlan.sourceOutputFingerprint !== receipt?.outputFingerprint ||
      correctionPlan.sourceSoftwareJobId !== sourceJob?.jobId) return blocked("EDITORIAL_PLAN_SCOPE_MISMATCH");
  const issue = editorialSourceScopeIssue(sourceJob, request, receipt, revision ? "completed" : "rejected");
  if (issue) return blocked(issue);
  const immutableErrors = base.originalValidation.errors.filter(error =>
    !/^output\.(?:title|description|bulletPoints|searchKeywords|items)(?:\.|\[|:)/.test(error));
  if (immutableErrors.length) return blocked("UNSUPPORTED_OR_UNTRUSTED_RECEIPT_DEFECT", { errors: immutableErrors });
  if (!object(receipt.output) || !Array.isArray(receipt.output.bulletPoints) || !Array.isArray(receipt.output.searchKeywords) ||
      receipt.output.bulletPoints.length > 10 || receipt.output.searchKeywords.length > 50) return blocked("EDITORIAL_SOURCE_OUTPUT_INVALID");
  const originals = [["output.title", receipt.output.title], ["output.description", receipt.output.description],
    ...["bulletPoints", "searchKeywords"].flatMap(field => receipt.output[field].map((item, index) => [`output.${field}[${index}]`, item]))];
  const plans = new Map();
  for (const item of correctionPlan.items) {
    if (!closed(item, ["path", "originalText", "originalFactRefs", "originalAssertions", "correctedText", "factPaths", "explanation", "sourceRefs",
      ...(revision ? ["originalReviewZh", "correctedReviewZh"] : [])]) ||
        !boundedText(item.path, 500) || !boundedText(item.originalText, 6000) || !boundedText(item.correctedText, 6000) ||
        !boundedText(item.explanation, 2000) || !refs(item.factPaths) || !refs(item.sourceRefs) ||
        !Array.isArray(item.originalFactRefs) || !Array.isArray(item.originalAssertions) ||
        (revision && (!boundedText(item.originalReviewZh, 6000) || !boundedText(item.correctedReviewZh, 6000)))) return blocked("EDITORIAL_ITEM_INVALID");
    if (plans.has(item.path)) return blocked("EDITORIAL_DUPLICATE_ITEM", { path: item.path });
    plans.set(item.path, item);
  }
  if (revision) {
    if ([...plans.keys()].some(path => !originals.some(([originalPath]) => path === originalPath))) return blocked("EDITORIAL_PATH_INVALID");
  } else if (plans.size !== originals.length || originals.some(([path]) => !plans.has(path))) return blocked("EDITORIAL_ITEM_COVERAGE_REQUIRED");
  const facts = new Map(request.verifiedFacts.map(fact => [fact.factPath, fact]));
  if (facts.size !== request.verifiedFacts.length) return blocked("DUPLICATE_FACT_PATH");
  const requestEvidence = new Set([request.competitorTextEvidence.evidenceRef, request.keywordEvidence.evidenceId,
    ...request.keywordEvidence.keywords.map(keyword => keyword.keywordEvidenceRef)]);
  const changes = [];
  for (const [path, original] of originals) {
    const plan = plans.get(path);
    if (revision && !plan) continue;
    const reviewOutput = request.outputContractVersion === C1_SEO_REVIEW_OUTPUT_VERSION;
    const originalKeys = ["text", "factRefs", "keywordRefs", "assertions", ...(reviewOutput ? ["reviewZh",
      ...(path.startsWith("output.searchKeywords[") ? ["keywordRole"] : [])] : [])];
    if (!closed(original, originalKeys) || !refs(original.factRefs) ||
        !Array.isArray(original.assertions) || original.assertions.length === 0 || original.assertions.length > 60) return blocked("EDITORIAL_SOURCE_ITEM_INVALID", { path });
    if (plan.originalText !== original.text || !isDeepStrictEqual(plan.originalFactRefs, original.factRefs) ||
        !isDeepStrictEqual(plan.originalAssertions, original.assertions) ||
        (revision && plan.originalReviewZh !== original.reviewZh)) return blocked("EDITORIAL_ORIGINAL_VALUE_CONFLICT", { path });
    if (!revision && reviewOutput && plan.correctedText !== original.text) return blocked("EDITORIAL_TRANSLATION_REFRESH_REQUIRED", { path });
    const declared = new Set();
    for (const assertion of original.assertions) {
      const fact = facts.get(assertion?.factPath);
      if (!closed(assertion, ["factPath", "value"]) || !fact || !matchesFrozenEditorialValue(assertion.value, fact.value)) {
        return blocked("EDITORIAL_ORIGINAL_ASSERTION_INVALID", { path });
      }
      declared.add(assertion.factPath);
    }
    if (plan.factPaths.some(factPath => revision ? !facts.has(factPath) : !declared.has(factPath))) return blocked("EDITORIAL_UNDECLARED_FACT", { path });
    const selected = plan.factPaths.map(factPath => facts.get(factPath));
    if (!revision && original.factRefs.some(ref => !selected.some(fact => facts.has(ref) ? fact.factPath === ref : fact.evidenceRefs.includes(ref)))) {
      return blocked("EDITORIAL_ORIGINAL_REFERENCE_UNCOVERED", { path });
    }
    const evidence = new Set([...requestEvidence, ...selected.flatMap(fact => fact.evidenceRefs)]);
    if (plan.sourceRefs.some(ref => !evidence.has(ref)) || selected.some(fact => revision ? fact.evidenceRefs.some(ref => !plan.sourceRefs.includes(ref)) : !fact.evidenceRefs.some(ref => plan.sourceRefs.includes(ref)))) {
      return blocked("EDITORIAL_EVIDENCE_INSUFFICIENT", { path });
    }
    // An explicit translation is reviewed data, not an automated semantic proof.
    const after = { ...structuredClone(original), text: plan.correctedText, ...(revision ? { reviewZh: plan.correctedReviewZh } : {}), factRefs: [...plan.factPaths],
      assertions: selected.map(fact => ({ factPath: fact.factPath, value: structuredClone(fact.value) })) };
    if (revision && isDeepStrictEqual(original, after)) return blocked("EDITORIAL_NO_CHANGE", { path });
    changes.push({ path, changed: !isDeepStrictEqual(original, after), before: structuredClone(original), after,
      explanation: plan.explanation, sourceRefs: [...plan.sourceRefs] });
  }
  const draft = structuredClone(receipt);
  const revised = new Map(changes.map(change => [change.path, change.after]));
  for (const field of ["title", "description"]) if (revised.has(`output.${field}`)) draft.output[field] = revised.get(`output.${field}`);
  for (const field of ["bulletPoints", "searchKeywords"]) draft.output[field] = draft.output[field].map((item, index) =>
    revised.has(`output.${field}[${index}]`) ? revised.get(`output.${field}[${index}]`) : item);
  draft.outputFingerprint = fingerprintCanonicalRecord(draft.output);
  base.editedValidation = validateC1AiDraftReceipt({ request, receipt: draft });
  if (!base.editedValidation.valid) return blocked("FULL_RECEIPT_VALIDATION_FAILED", { errors: base.editedValidation.errors });
  const version = { schemaVersion: revision ? "c1-draft-editorial-version-v2" : "c1-draft-editorial-version-v1", requestId: request.requestId,
    sourceSoftwareJobId: sourceJob.jobId, sourceGatewayJobId: receipt.gatewayJobId,
    sourceCandidateId: sourceJob.candidateId, sourceSkuPackageId: sourceJob.skuPackageId, sourceCandidateRevision: sourceJob.revision,
    sourceIdentity: structuredClone(request.sourceIdentity), sourceVariantKey: request.identity.variantKey,
    requestFingerprint: request.requestFingerprint, sourceReceiptId: receipt.receiptId,
    sourceOutputFingerprint: receipt.outputFingerprint, outputContractVersion: request.outputContractVersion ?? null,
    correctionPlan: structuredClone(correctionPlan), changes: structuredClone(changes),
    output: structuredClone(draft.output), outputFingerprint: draft.outputFingerprint, validation: structuredClone(base.editedValidation),
    semanticValidation: { status: "maintenance_review_recorded", automatedSemanticProof: false },
    status: "proposal_only", providerReceiptReplaced: false, productionApproved: false, automaticApplicationAllowed: false };
  return { ...base, status: "editorial_proposed", editedVersion: { ...version,
    editorialVersionId: `c1-draft-editorial:${fingerprintCanonicalRecord(version)}` } };
}

const OWNER_KEYS = ["schemaVersion", "candidateId", "skuPackageId", "sourceCandidateRevision", "resultCandidateRevision",
  "sourceSkuRevision", "resultSkuRevision", "editorialVersionId", "outputFingerprint", "confirmedByUserId", "actorType",
  "role", "source", "confirmedAt", "productionAuthorizationGranted"];
const DRAFT_KEYS = ["status", "sourceType", "formalProviderResultAccepted", "reason", "editorialSource"];
const CONTENT_FIELDS = ["seoTitleDraft", "descriptionDraft", "bulletPointsDraft", "searchKeywordsDraft", "seoEvidenceLayer"];
const SOURCE_JOB_FIELDS = ["schemaVersion", "jobId", "candidateId", "skuPackageId", "revision", "jobType", "status",
  "attempt", "externalRequestState", "failureClass", "progressRef", "resultRef", "scopeBinding", "admissionDecision",
  "externalRequestRef", "workerId", "leaseId", "startedAt", "completedAt", "resultEnvelope"];
const SOURCE_ADMISSION_FIELDS = ["schemaVersion", "jobId", "candidateId", "skuPackageId", "revision", "jobType",
  "authorizationRef", "credentialAlias", "authorizationFingerprint", "credentialBindingFingerprint"];

// The original software job remains in its repository. This bounded source DTO
// keeps only the fields needed to prove the result's binding. Its payload
// shares the single frozen request (and completed receipt) in this record,
// without duplicating their potentially large content in every C2 snapshot.
function storeSourceBundle(bundle) {
  const completed = bundle.correctionPlan.schemaVersion === "c1-draft-editorial-plan-v2";
  const stored = structuredClone(bundle);
  stored.sourceJob = Object.fromEntries(SOURCE_JOB_FIELDS.map(key => [key, structuredClone(bundle.sourceJob[key])]));
  stored.sourceJob.schemaVersion = completed ? "c1-editorial-completed-job-v1" : "c1-editorial-rejected-job-v1";
  stored.sourceJob.admissionDecision = Object.fromEntries(SOURCE_ADMISSION_FIELDS.map(key => [key, bundle.sourceJob.admissionDecision[key]]));
  delete stored.sourceJob.resultEnvelope.payload.request;
  if (completed) delete stored.sourceJob.resultEnvelope.payload.receipt;
  return stored;
}

function restoreSourceBundle(bundle, sourceVersion) {
  const completed = sourceVersion === "c1-editorial-source-v2";
  if (!closed(bundle, ["request", "receipt", "sourceJob", "correctionPlan"]) ||
      !closed(bundle.sourceJob, SOURCE_JOB_FIELDS) ||
      bundle.sourceJob.schemaVersion !== (completed ? "c1-editorial-completed-job-v1" : "c1-editorial-rejected-job-v1") ||
      bundle.correctionPlan?.schemaVersion !== (completed ? "c1-draft-editorial-plan-v2" : "c1-draft-editorial-plan-v1") ||
      !closed(bundle.sourceJob.admissionDecision, SOURCE_ADMISSION_FIELDS) ||
      !object(bundle.sourceJob.resultEnvelope?.payload) || own(bundle.sourceJob.resultEnvelope.payload, "request") ||
      (completed && (!closed(bundle.sourceJob.resultEnvelope.payload, ["schemaVersion"]) ||
        bundle.sourceJob.resultEnvelope.payload.schemaVersion !== "c1-ai-draft-software-result-v1"))) {
    fail("C1_EDITORIAL_SOURCE_INVALID");
  }
  const restored = structuredClone(bundle);
  restored.sourceJob.schemaVersion = "software-job-v1";
  restored.sourceJob.resultEnvelope.payload.request = structuredClone(restored.request);
  if (completed) restored.sourceJob.resultEnvelope.payload.receipt = structuredClone(restored.receipt);
  return restored;
}

/** Revalidates the frozen source while preserving its original execution outcome. */
export function assertC1EditorialSource({ draftOnlySeo, identity, resultSkuRevision }) {
  if (!closed(draftOnlySeo, DRAFT_KEYS) || draftOnlySeo.status !== "draft_only" ||
      draftOnlySeo.sourceType !== "owner_confirmed_editorial" || draftOnlySeo.formalProviderResultAccepted !== false ||
      draftOnlySeo.reason !== null) fail("C1_EDITORIAL_SOURCE_INVALID");
  const record = draftOnlySeo.editorialSource;
  if (!closed(record, ["schemaVersion", "bundle", "ownerConfirmation"]) ||
      !["c1-editorial-source-v1", "c1-editorial-source-v2"].includes(record.schemaVersion)) fail("C1_EDITORIAL_SOURCE_INVALID");
  assertNoRawPersistenceKeys(record, "c1EditorialSource");
  assertNoProductionSecrets({ frozenC1Handoff: { draftOnlySeo } }, "c1EditorialSource");
  const completed = record.schemaVersion === "c1-editorial-source-v2";
  const bundle = restoreSourceBundle(record.bundle, record.schemaVersion);
  const assessment = assessC1DraftEditorialContent(bundle);
  if (assessment.status !== "editorial_proposed") {
    fail("C1_EDITORIAL_VERSION_REPLAY_CONFLICT");
  }
  const { request, receipt, sourceJob } = bundle;
  const owner = record.ownerConfirmation, version = assessment.editedVersion;
  if (!isDeepStrictEqual(identity, request.sourceIdentity) || !Number.isSafeInteger(resultSkuRevision) ||
      resultSkuRevision !== request.sourceSkuRevision + (completed ? 2 : 1)) fail("C1_EDITORIAL_SOURCE_SCOPE_CONFLICT");
  if (!closed(owner, OWNER_KEYS) || owner.schemaVersion !== "c1-editorial-owner-confirmation-v1" ||
      owner.candidateId !== identity.candidateId || owner.skuPackageId !== identity.skuPackageId ||
      !Number.isSafeInteger(owner.sourceCandidateRevision) || owner.sourceCandidateRevision < sourceJob.revision + (completed ? 1 : 0) ||
      owner.resultCandidateRevision !== owner.sourceCandidateRevision + 1 ||
      owner.sourceSkuRevision !== request.sourceSkuRevision + (completed ? 1 : 0) || owner.resultSkuRevision !== resultSkuRevision ||
      owner.editorialVersionId !== version.editorialVersionId || owner.outputFingerprint !== version.outputFingerprint ||
      !boundedText(owner.confirmedByUserId, 256) || owner.actorType !== "human" || owner.role !== "owner" ||
      owner.source !== "authenticated_identity_provider" || !instant(owner.confirmedAt) ||
      !instant(sourceJob.completedAt) || Date.parse(owner.confirmedAt) < Date.parse(sourceJob.completedAt) ||
      Date.parse(owner.confirmedAt) < Date.parse(receipt.completedAt) || owner.productionAuthorizationGranted !== false) {
    fail("C1_EDITORIAL_OWNER_CONFIRMATION_INVALID");
  }
  return { ...record, bundle, editedVersion: version };
}

/** Canonical handoffs reference the complete source in the same frozen C1
 * snapshot. This is an exact projection, not a standalone proof of adoption. */
export function createC1EditorialDraftReference(input) {
  const record = assertC1EditorialSource(input);
  if (record.schemaVersion !== "c1-editorial-source-v2") fail("C1_EDITORIAL_REFERENCE_COMPLETED_SOURCE_REQUIRED");
  const { request, receipt, sourceJob } = record.bundle;
  return {
    status: "draft_only", sourceType: "owner_confirmed_editorial", formalProviderResultAccepted: false, reason: null,
    editorialSource: {
      schemaVersion: "c1-editorial-source-reference-v1", sourceSchemaVersion: record.schemaVersion,
      requestId: request.requestId, requestFingerprint: request.requestFingerprint,
      sourceReceiptId: receipt.receiptId, sourceSoftwareJobId: sourceJob.jobId,
      sourceOutputFingerprint: receipt.outputFingerprint,
      editorialVersionId: record.editedVersion.editorialVersionId, outputFingerprint: record.editedVersion.outputFingerprint,
      ownerConfirmation: structuredClone(record.ownerConfirmation)
    }
  };
}

function editorialContent(record) {
  const { editedVersion: version, ownerConfirmation: owner, bundle: { request, receipt, sourceJob } } = record;
  const output = version.output;
  const field = item => ({ status: "draft_only", text: item.text,
    ...(request.outputContractVersion === C1_SEO_REVIEW_OUTPUT_VERSION ? { reviewZh: item.reviewZh } : {}), factRefs: [...item.factRefs],
    keywordEvidenceRefs: [...item.keywordRefs], assertions: structuredClone(item.assertions), productionApproved: false });
  return {
    seoTitleDraft: field(output.title), descriptionDraft: field(output.description),
    bulletPointsDraft: output.bulletPoints.map(field),
    searchKeywordsDraft: { status: "draft_only", keywords: output.searchKeywords.map(item => ({ query: item.text,
      factRefs: [...item.factRefs], evidenceRefs: [...item.keywordRefs],
      ...(request.outputContractVersion === C1_SEO_REVIEW_OUTPUT_VERSION ? { reviewZh: item.reviewZh, keywordRole: item.keywordRole } : {}), assertions: structuredClone(item.assertions) })), productionApproved: false },
    keywordEvidenceRefs: [...new Set([output.title, output.description, ...output.bulletPoints, ...output.searchKeywords].flatMap(item => item.keywordRefs))],
    seoEvidenceLayer: { draftVersion: version.schemaVersion, sourceType: "owner_confirmed_editorial",
      editorialVersionId: version.editorialVersionId, requestId: request.requestId, requestFingerprint: request.requestFingerprint,
      sourceReceiptId: receipt.receiptId, sourceSoftwareJobId: sourceJob.jobId, sourceGatewayJobId: receipt.gatewayJobId,
      sourceOutputFingerprint: receipt.outputFingerprint, outputFingerprint: version.outputFingerprint,
      createdAt: owner.confirmedAt, executionStatus: "draft_only", finalApprovalGranted: false,
      ...(version.schemaVersion === "c1-draft-editorial-version-v2" ? { outputContractVersion: request.outputContractVersion,
        ...(request.factDefinitionsVersion ? { factDefinitionsVersion: request.factDefinitionsVersion } : {}) } : {}),
      ...(request.outputContractVersion === C1_SEO_REVIEW_OUTPUT_VERSION ? { russianAttributes: structuredClone(output.russianAttributes) } : {}),
      ...(["c1-seo-reference-context-v2", "c1-seo-reference-context-v3"].includes(request.referenceContext?.schemaVersion) ? { categoryPathReview: structuredClone(output.categoryPathReview) } : {}) }
  };
}

/** The content and all frozen facts must remain identical to the approved version and original request. */
function assertEditorialContent({ plan, identity, resultSkuRevision, snapshot }) {
  if (!snapshot) assertValidC1ProductPlan(plan);
  const record = assertC1EditorialSource({ draftOnlySeo: plan.draftOnlySeo, identity, resultSkuRevision });
  if (plan.status !== "seo_draft_ready") fail("C1_EDITORIAL_PLAN_NOT_READY");
  const expected = editorialContent(record);
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(plan[key], value)) fail("C1_EDITORIAL_CONTENT_CONFLICT");
  }
  // This read-only projection checks original facts at their source revision;
  // it neither rewrites a receipt nor reopens a paid job.
  const sourcePlan = structuredClone(plan);
  if (snapshot) {
    // C2 intentionally freezes a content/facts projection, not the plan's
    // transport bookkeeping. Supply the omitted protocol constants solely to
    // reuse the source-fact validator; these are never persisted as new facts.
    Object.assign(sourcePlan, { schemaVersion: "c1-product-plan-v1.1", createdAt: record.bundle.request.requestedAt,
      externalAccesses: [], profitRecalculated: false, skuReplaced: false, finalSeo: null, finalAttributes: null,
      complianceDecision: null, generatedAssets: null, productionPayload: null });
  }
  sourcePlan.status = "facts_checked"; sourcePlan.draftOnlySeo = null; sourcePlan.keywordEvidenceRefs = [];
  for (const key of CONTENT_FIELDS) sourcePlan[key] = null;
  assertCurrentC1AiDraftRequest({ request: record.bundle.request, skuPackage: {
    g1Identity: identity, c1ProductPlan: sourcePlan, skuPackageId: identity.skuPackageId,
    supplierSkuId: identity.supplierSkuId, targetPlatform: identity.platform, targetStore: identity.storeRef.stableStoreId,
    businessPhase: "C1", dataRevision: record.bundle.request.sourceSkuRevision
  } });
  return record;
}

export function assertC1EditorialPlan(input) { return assertEditorialContent({ ...input, snapshot: false }); }
export function assertC1EditorialSnapshot(input) { return assertEditorialContent({ ...input, snapshot: true }); }

/** Owner-confirmed pure C1 transition. Caller persists this and the C2 container atomically. */
export function applyC1EditorialReview({ skuPackage, bundle, editedVersion, ownerConfirmation, settledExecution = null }) {
  const completed = bundle?.correctionPlan?.schemaVersion === "c1-draft-editorial-plan-v2";
  if (!object(skuPackage) || skuPackage.c2FinalAssets !== null || skuPackage.productionAuthorization !== null ||
      skuPackage.productionRecord !== null || skuPackage.externalListingRecord !== null || skuPackage.eVerificationRecord !== null) {
    fail("C1_EDITORIAL_DOWNSTREAM_STATE_REJECTED");
  }
  if (completed) {
    if (!closed(ownerConfirmation, OWNER_KEYS)) fail("C1_EDITORIAL_OWNER_CONFIRMATION_INVALID");
    if (skuPackage.businessPhase !== "C1" || skuPackage.c1ProductPlan?.status !== "seo_draft_ready") {
      fail("C1_EDITORIAL_APPLIED_SOURCE_REQUIRED");
    }
    const assessment = assessC1DraftEditorialContent(bundle);
    if (assessment.status !== "editorial_proposed") fail("C1_EDITORIAL_VERSION_REPLAY_CONFLICT");
    const replay = mergeC1AiDraftReceipt({ skuPackage, request: bundle.request, receipt: bundle.receipt,
      settledExecution, mergedAt: ownerConfirmation?.confirmedAt });
    if (!replay.idempotent) fail("C1_EDITORIAL_APPLIED_SOURCE_REQUIRED");
  } else assertCurrentC1AiDraftRequest({ skuPackage, request: bundle?.request });
  if (skuPackage.variantKey !== bundle.request.identity.variantKey) fail("C1_EDITORIAL_SOURCE_SCOPE_CONFLICT");
  const draftOnlySeo = { status: "draft_only", sourceType: "owner_confirmed_editorial", formalProviderResultAccepted: false,
    reason: null, editorialSource: { schemaVersion: completed ? "c1-editorial-source-v2" : "c1-editorial-source-v1", bundle: storeSourceBundle(bundle),
      ownerConfirmation: structuredClone(ownerConfirmation) } };
  const record = assertC1EditorialSource({ draftOnlySeo, identity: skuPackage.g1Identity, resultSkuRevision: skuPackage.dataRevision + 1 });
  if (!isDeepStrictEqual(editedVersion, record.editedVersion)) fail("C1_EDITORIAL_VERSION_REPLAY_CONFLICT");
  const next = structuredClone(skuPackage);
  Object.assign(next.c1ProductPlan, editorialContent(record), { status: "seo_draft_ready", draftOnlySeo });
  next.dataRevision += 1; next.technicalStatus = "completed"; next.ownerAction = "none";
  next.audit.updatedAt = ownerConfirmation.confirmedAt;
  next.audit.history.push({ event: "c1_editorial_content_owner_confirmed", at: ownerConfirmation.confirmedAt,
    editorialVersionId: editedVersion.editorialVersionId, sourceSoftwareJobId: bundle.sourceJob.jobId,
    sourceReceiptId: bundle.receipt.receiptId, confirmedByUserId: ownerConfirmation.confirmedByUserId,
    providerReceiptReplaced: false, aiCalls: 0, platformWrites: 0, productionAuthorizationGranted: false });
  assertC1EditorialPlan({ plan: next.c1ProductPlan, identity: next.g1Identity, resultSkuRevision: next.dataRevision });
  return { skuPackage: next };
}
