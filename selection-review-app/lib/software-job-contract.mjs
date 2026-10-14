import { A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, A_SUPPLIER_IMAGE_SEARCH_CAPABILITY, assertASupplierImageSearchScope, readASupplierImageSearchTerminal } from "./a-supplier-image-search-contract.mjs";
export { A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, A_SUPPLIER_IMAGE_SEARCH_CAPABILITY };
import { A_PRODUCT_DETAIL_JOB_TYPE, A_PRODUCT_DETAIL_CAPABILITY, assertAProductDetailScope, readAProductDetailTerminal } from "./a-product-detail-contract.mjs";
export { A_PRODUCT_DETAIL_JOB_TYPE, A_PRODUCT_DETAIL_CAPABILITY };
import { A_DISCOVERY_JOB_TYPE, A_DISCOVERY_CAPABILITY, getADiscoveryCapability, assertADiscoveryScope, readADiscoveryTerminal } from "./a-discovery-contract.mjs";
export { A_DISCOVERY_JOB_TYPE, A_DISCOVERY_CAPABILITY };
import { isDeepStrictEqual } from "node:util";
import {
  PRODUCTION_CONTRACT_MAX_DEPTH,
  PRODUCTION_CONTRACT_MAX_NODES,
  fingerprintCanonicalRecord,
  assertCanonicalC1AuthorizationId
} from "./production-contract-primitives.mjs";
import { validateC2StableAssetTransportResult } from "./c2-asset-lifecycle.mjs";
import { normalizeC1SourceIdentity } from "./c1-product-plan.mjs";
import { assertAuthorizedC1Execution, assertC1ProviderOutcome, assertC1ServiceTiming, validateC1AiAccounting, validateC1AiDraftRequest, validateC1AiDraftReceipt } from "./c1-ai-draft-contract.mjs";
import { assertSafeRuntimeRecord, workerSatisfiesCapabilities, WORKER_CAPABILITIES } from "./runtime-identity.mjs";
import { normalizeDESoftwareJobScope } from "./d-e-software-job-scope.mjs";
import { isDESoftwareJob, assertDEJobAdmissionDecision } from "./d-e-software-job-admission.mjs";
import { readDProductionJobTerminal, readEReadbackJobTerminal, readDAssetTransportJobTerminal, readDPreparationJobTerminal, isReconciledDERequest } from "./d-e-software-job-results.mjs";
import { assertDProductionPreparation } from "./d-production-preparation-contract.mjs";
import { OZON_ACCOUNT_READ_JOB_TYPE, OZON_ACCOUNT_READ_CAPABILITY, assertOzonAccountReadScope, readOzonAccountReadTerminal } from "./ozon-account-read-contract.mjs";
import { D_PLATFORM_OBSERVATION_JOB_TYPE, assertDPlatformObservationScope, assertDPlatformObservationAdmission,
  readDPlatformObservationJobTerminal, readDPlatformStoppedJobTerminal, readDInitialImportStoppedJobTerminal,
  readDOwnerStockRegisteredJobTerminal } from './d-platform-observation-contract.mjs';
export { D_PLATFORM_OBSERVATION_JOB_TYPE };
export { OZON_ACCOUNT_READ_JOB_TYPE, OZON_ACCOUNT_READ_CAPABILITY };

export const EXTERNAL_REQUEST_STATES = Object.freeze(["not_sent", "in_flight", "failed", "unknown_outcome", "succeeded"]);
export const SOFTWARE_JOB_STATUSES = Object.freeze(["queued", "claimed", "waiting_platform", "completed", "failed", "unknown_outcome"]);
export const SOFTWARE_JOB_RESULT_ENVELOPE_VERSION = "software-job-result-envelope-v1";
export const SOFTWARE_JOB_PREPARATION_RESULT_VERSION = "software-job-result-envelope-v2";
export const C2_STABLE_ASSET_TRANSPORT_JOB_TYPE = "c2_stable_asset_transport";
export const C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE = "c1_paid_keyword_evidence";
export const C1_AI_DRAFT_JOB_TYPE = "c1_ai_draft";
export const D_PRODUCTION_EXECUTION_JOB_TYPE = "d_production_execution";
export const E_INDEPENDENT_READBACK_JOB_TYPE = "e_independent_readback";
export const D_PRODUCTION_EXECUTION_CAPABILITY = "ozon-production-execution";
export const E_INDEPENDENT_READBACK_CAPABILITY = "ozon-independent-readback";
export const C1_AI_DRAFT_CAPABILITY = "ai-draft-gateway";
export const C2_STABLE_ASSET_TRANSPORT_CAPABILITY = "stable-asset-transport";
export const C1_PAID_KEYWORD_EVIDENCE_CAPABILITY = "seerfar-open-api";
export const C1_PAID_KEYWORD_PROVIDER = "seerfar_open_api";
export const C1_PAID_KEYWORD_POINTS = 15;
export const SOFTWARE_JOB_TYPES = Object.freeze([
  A_DISCOVERY_JOB_TYPE, A_PRODUCT_DETAIL_JOB_TYPE, A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,
  D_PLATFORM_OBSERVATION_JOB_TYPE,
  OZON_ACCOUNT_READ_JOB_TYPE,
  C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_AI_DRAFT_JOB_TYPE,
  D_PRODUCTION_EXECUTION_JOB_TYPE,
  E_INDEPENDENT_READBACK_JOB_TYPE
]);
export const SOFTWARE_JOB_REQUIRED_CAPABILITIES_BY_TYPE = Object.freeze({
  [A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE]: Object.freeze([A_SUPPLIER_IMAGE_SEARCH_CAPABILITY]),
  [A_PRODUCT_DETAIL_JOB_TYPE]: Object.freeze([A_PRODUCT_DETAIL_CAPABILITY]),
  [A_DISCOVERY_JOB_TYPE]: Object.freeze([A_DISCOVERY_CAPABILITY]),
  [D_PLATFORM_OBSERVATION_JOB_TYPE]: Object.freeze([E_INDEPENDENT_READBACK_CAPABILITY]),
  [OZON_ACCOUNT_READ_JOB_TYPE]: Object.freeze([OZON_ACCOUNT_READ_CAPABILITY]),
  [C2_STABLE_ASSET_TRANSPORT_JOB_TYPE]: Object.freeze([C2_STABLE_ASSET_TRANSPORT_CAPABILITY]),
  [C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE]: Object.freeze([C1_PAID_KEYWORD_EVIDENCE_CAPABILITY]),
  [C1_AI_DRAFT_JOB_TYPE]: Object.freeze([C1_AI_DRAFT_CAPABILITY]),
  [D_PRODUCTION_EXECUTION_JOB_TYPE]: Object.freeze([D_PRODUCTION_EXECUTION_CAPABILITY]),
  [E_INDEPENDENT_READBACK_JOB_TYPE]: Object.freeze([E_INDEPENDENT_READBACK_CAPABILITY])
});
export const SOFTWARE_JOB_APPLICATION_DISPOSITIONS = Object.freeze([
  "applied",
  "revision_conflict_not_applied",
  "result_recorded_no_candidate_mutation"
]);
export const SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE = [
  "^(?=.{1,256}$)",
  "(?!.*[\\u0000-\\u001f\\s?#@=&\\\\])",
  "(?!(?:[Ff][Ii][Ll][Ee]:|[Hh][Tt][Tt][Pp][Ss]?:|/|\\\\|[A-Za-z]:[\\\\/]))",
  "(?!.*//)",
  "[A-Za-z0-9][A-Za-z0-9._:~-]*$"
].join("");
const SOFTWARE_JOB_STRICT_REF_PATTERN = new RegExp(SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE);
const SOFTWARE_JOB_RESULT_ENVELOPE_MAX_STRING_BYTES = 65_536;
const SOFTWARE_JOB_RESULT_ENVELOPE_MAX_TOTAL_STRING_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();
const RESERVED_STABLE_ASSET_HOST_SUFFIXES = Object.freeze([
  "localhost",
  "local",
  "localdomain",
  "lan",
  "home",
  "internal"
]);

export function isReservedSoftwareJobHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized) || /^\[[0-9a-f:.]+\]$/i.test(normalized)) return true;
  return RESERVED_STABLE_ASSET_HOST_SUFFIXES.some((suffix) =>
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  );
}

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`SOFTWARE_JOB_INVALID: ${label}不能为空`);
  return normalized;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("SOFTWARE_JOB_INVALID: revision无效");
  return value;
}

export function normalizeSoftwareJobPreparationSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 || value.kind !== 'account_preparation' ||
      !Object.hasOwn(value, 'preparationId') || !Object.hasOwn(value, 'revision')) {
    throw new Error('SOFTWARE_JOB_PREPARATION_SUBJECT_INVALID');
  }
  return Object.freeze({ kind: 'account_preparation', preparationId: strictRef(value.preparationId, 'subject.preparationId'),
    revision: revision(value.revision) });
}

export function isAccountPreparationSoftwareJob(job) {
  return job?.schemaVersion === 'software-job-v2' && job.jobType === OZON_ACCOUNT_READ_JOB_TYPE &&
    job.subject?.kind === 'account_preparation' && !Object.hasOwn(job, 'candidateId') && !Object.hasOwn(job, 'skuPackageId');
}

export function normalizeSoftwareJobDiscoverySubject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
      value.kind !== "discovery_batch" || !Object.hasOwn(value, "batchId") || !Object.hasOwn(value, "revision")) {
    throw new Error("SOFTWARE_JOB_DISCOVERY_SUBJECT_INVALID");
  }
  return Object.freeze({ kind: "discovery_batch", batchId: strictRef(value.batchId, "subject.batchId"), revision: revision(value.revision) });
}
export function isADiscoverySoftwareJob(job) {
  return job?.schemaVersion === "software-job-v3" && job.jobType === A_DISCOVERY_JOB_TYPE &&
    job.subject?.kind === "discovery_batch" && !Object.hasOwn(job, "candidateId") && !Object.hasOwn(job, "skuPackageId");
}
export function normalizeSoftwareJobACandidateSubject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
      value.kind !== "a_candidate" || !Object.hasOwn(value, "candidateId") || !Object.hasOwn(value, "revision")) {
    throw new Error("SOFTWARE_JOB_A_CANDIDATE_SUBJECT_INVALID");
  }
  return Object.freeze({ kind: "a_candidate", candidateId: strictRef(value.candidateId, "subject.candidateId"), revision: revision(value.revision) });
}
export function isAProductDetailSoftwareJob(job) {
  return job?.schemaVersion === "software-job-v3" && job.jobType === A_PRODUCT_DETAIL_JOB_TYPE &&
    job.subject?.kind === "a_candidate" && !Object.hasOwn(job, "candidateId") && !Object.hasOwn(job, "skuPackageId");
}
export function isASupplierImageSearchSoftwareJob(job) {
  return job?.schemaVersion === "software-job-v3" && job.jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE &&
    job.subject?.kind === "a_candidate" && !Object.hasOwn(job, "candidateId") && !Object.hasOwn(job, "skuPackageId");
}
function isVersionThreeSubjectJob(job) { return isADiscoverySoftwareJob(job) || isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job); }
function isSubjectSoftwareJob(job) { return isAccountPreparationSoftwareJob(job) || isVersionThreeSubjectJob(job); }
function normalizeJobSubject(value) {
  if (value?.kind === "a_candidate") return normalizeSoftwareJobACandidateSubject(value);
  return value?.kind === "discovery_batch" ? normalizeSoftwareJobDiscoverySubject(value) : normalizeSoftwareJobPreparationSubject(value);
}
function resultEnvelopeVersion(job) {
  return isVersionThreeSubjectJob(job) ? "software-job-result-envelope-v3" :
    isAccountPreparationSoftwareJob(job) ? SOFTWARE_JOB_PREPARATION_RESULT_VERSION : SOFTWARE_JOB_RESULT_ENVELOPE_VERSION;
}

export function supportedSoftwareJobVersion(job) {
  if (isASupplierImageSearchSoftwareJob(job)) {
    const subject = normalizeSoftwareJobACandidateSubject(job.subject);
    if (subject.revision !== job.revision) return false;
    assertASupplierImageSearchScope(job.scopeBinding, job); return true;
  }
  if (isAProductDetailSoftwareJob(job)) {
    const subject = normalizeSoftwareJobACandidateSubject(job.subject);
    if (subject.revision !== job.revision) return false;
    assertAProductDetailScope(job.scopeBinding, job); return true;
  }
  if (isADiscoverySoftwareJob(job)) {
    const subject = normalizeSoftwareJobDiscoverySubject(job.subject);
    if (subject.revision !== job.revision) return false;
    assertADiscoveryScope(job.scopeBinding, job);
    return isDeepStrictEqual(job.requiredCapabilities, [getADiscoveryCapability(job.scopeBinding)]);
  }
  if (job?.schemaVersion === 'software-job-v1') return ![A_DISCOVERY_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE].includes(job.jobType) && !Object.hasOwn(job, 'subject');
  if (!isAccountPreparationSoftwareJob(job)) return false;
  const subject = normalizeSoftwareJobPreparationSubject(job.subject);
  if (subject.revision !== job.revision) return false;
  assertOzonAccountReadScope(job.scopeBinding, job);
  return true;
}

function iso(value, label) {
  const normalized = text(value, label);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`SOFTWARE_JOB_INVALID: ${label}无效`);
  return new Date(normalized).toISOString();
}

function strictRef(value, label) {
  const normalized = text(value, label);
  if (!SOFTWARE_JOB_STRICT_REF_PATTERN.test(normalized)) {
    throw new Error(`SOFTWARE_JOB_INVALID: ${label}必须是有界opaque引用`);
  }
  return normalized;
}

function sha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`SOFTWARE_JOB_INVALID: ${label}必须是sha256`);
  return normalized;
}

export function assertSoftwareJobStrictRef(value, label = "softwareJobRef") {
  return strictRef(value, label);
}

export function assertBoundedResultEnvelopeStructure(value, label = "resultEnvelope") {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  let nodeCount = 0;
  let totalStringBytes = 0;
  const addStringBytes = (text) => {
    const bytes = TEXT_ENCODER.encode(text).length;
    totalStringBytes += bytes;
    if (bytes > SOFTWARE_JOB_RESULT_ENVELOPE_MAX_STRING_BYTES ||
        totalStringBytes > SOFTWARE_JOB_RESULT_ENVELOPE_MAX_TOTAL_STRING_BYTES) {
      throw new Error(`SOFTWARE_JOB_RESULT_ENVELOPE_INVALID: ${label}字符串超过资源上限`);
    }
  };
  while (stack.length > 0) {
    const current = stack.pop();
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > PRODUCTION_CONTRACT_MAX_NODES) {
      throw new Error(`SOFTWARE_JOB_RESULT_ENVELOPE_INVALID: ${label}超过资源上限`);
    }
    if (typeof current.value === "string") {
      addStringBytes(current.value);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) throw new Error(`SOFTWARE_JOB_RESULT_ENVELOPE_INVALID: ${label}不得包含循环引用`);
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else {
      for (const [key, item] of Object.entries(current.value)) {
        addStringBytes(key);
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

function boundedText(value, label) {
  const normalized = text(value, label);
  if (normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`SOFTWARE_JOB_INVALID: ${label}必须是有界文本`);
  }
  return normalized;
}

function normalizeStoreRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["mappingVersion", "platformStoreId", "stableStoreId"])) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding.storeRef无效");
  }
  return Object.freeze({
    stableStoreId: strictRef(value.stableStoreId, "scopeBinding.storeRef.stableStoreId"),
    platformStoreId: strictRef(value.platformStoreId, "scopeBinding.storeRef.platformStoreId"),
    mappingVersion: strictRef(value.mappingVersion, "scopeBinding.storeRef.mappingVersion")
  });
}

function normalizeWorkerCapabilitiesSnapshot(capabilities, label = "workerCapabilitiesSnapshot") {
  if (!Array.isArray(capabilities) || capabilities.some((item) => !WORKER_CAPABILITIES.includes(item))) {
    throw new Error(`SOFTWARE_JOB_INVALID: ${label}无效`);
  }
  return Object.freeze([...new Set(capabilities)].sort());
}

function normalizeC2ScopeBinding(value, { candidateId, skuPackageId, revision: resultRevision }) {
  const allowed = [
    "schemaVersion", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "platform", "storeRef",
    "supplierSkuId", "variantKey", "sideEffectScope", "authorizationRef", "credentialAlias", "inputFingerprint",
    "stagedAssetManifestFingerprint", "ownerStagingConfirmationRef", "allowedStableAssetHosts"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== "software-job-scope-v1" ||
      value.candidateId !== candidateId || value.skuPackageId !== skuPackageId ||
      !Number.isInteger(value.sourceRevision) || value.sourceRevision < 0 ||
      value.resultRevision !== value.sourceRevision + 1 || value.resultRevision !== resultRevision ||
      value.sideEffectScope !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      !Array.isArray(value.allowedStableAssetHosts) || value.allowedStableAssetHosts.length === 0 ||
      value.allowedStableAssetHosts.length > 16) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding无效");
  }
  const hosts = [...new Set(value.allowedStableAssetHosts.map((host) => String(host).trim().toLowerCase()))].sort();
  if (hosts.length !== value.allowedStableAssetHosts.length || hosts.some((host) =>
    host.length > 253 || !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) ||
    isReservedSoftwareJobHost(host))) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding.allowedStableAssetHosts无效");
  }
  return Object.freeze({
    schemaVersion: "software-job-scope-v1",
    candidateId: strictRef(value.candidateId, "scopeBinding.candidateId"),
    skuPackageId: strictRef(value.skuPackageId, "scopeBinding.skuPackageId"),
    sourceRevision: value.sourceRevision,
    resultRevision: value.resultRevision,
    platform: strictRef(value.platform, "scopeBinding.platform"),
    storeRef: normalizeStoreRef(value.storeRef),
    supplierSkuId: strictRef(value.supplierSkuId, "scopeBinding.supplierSkuId"),
    variantKey: boundedText(value.variantKey, "scopeBinding.variantKey"),
    sideEffectScope: value.sideEffectScope,
    authorizationRef: strictRef(value.authorizationRef, "scopeBinding.authorizationRef"),
    credentialAlias: strictRef(value.credentialAlias, "scopeBinding.credentialAlias"),
    inputFingerprint: sha256(value.inputFingerprint, "scopeBinding.inputFingerprint"),
    stagedAssetManifestFingerprint: sha256(value.stagedAssetManifestFingerprint, "scopeBinding.stagedAssetManifestFingerprint"),
    ownerStagingConfirmationRef: strictRef(value.ownerStagingConfirmationRef, "scopeBinding.ownerStagingConfirmationRef"),
    allowedStableAssetHosts: Object.freeze(hosts)
  });
}

function normalizeC1ScopeBinding(value, { candidateId, skuPackageId, revision: resultRevision }) {
  const allowed = [
    "schemaVersion", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "platform", "targetStore",
    "supplierSkuId", "variantKey", "sideEffectScope", "authorizationRef", "credentialAlias", "inputFingerprint",
    "planningEvidenceFingerprint", "runtimeInputFingerprint", "seerfarRequestFingerprint", "salesSnapshotFingerprint",
    "supplySnapshotFingerprint", "profitModelFingerprint", "c1FactsFingerprint", "pointBudgetEvidenceRef",
    "quotaEvidenceRef", "pointsAuthorized", "provider"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== "software-job-scope-v1" ||
      value.candidateId !== candidateId || value.skuPackageId !== skuPackageId ||
      !Number.isInteger(value.sourceRevision) || value.sourceRevision < 0 ||
      value.resultRevision !== value.sourceRevision + 1 || value.resultRevision !== resultRevision ||
      value.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      value.provider !== C1_PAID_KEYWORD_PROVIDER ||
      value.pointsAuthorized !== C1_PAID_KEYWORD_POINTS) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding无效");
  }
  return Object.freeze({
    schemaVersion: "software-job-scope-v1",
    candidateId: strictRef(value.candidateId, "scopeBinding.candidateId"),
    skuPackageId: strictRef(value.skuPackageId, "scopeBinding.skuPackageId"),
    sourceRevision: value.sourceRevision,
    resultRevision: value.resultRevision,
    platform: strictRef(value.platform, "scopeBinding.platform"),
    targetStore: strictRef(value.targetStore, "scopeBinding.targetStore"),
    supplierSkuId: strictRef(value.supplierSkuId, "scopeBinding.supplierSkuId"),
    variantKey: boundedText(value.variantKey, "scopeBinding.variantKey"),
    sideEffectScope: value.sideEffectScope,
    authorizationRef: strictRef(value.authorizationRef, "scopeBinding.authorizationRef"),
    credentialAlias: strictRef(value.credentialAlias, "scopeBinding.credentialAlias"),
    inputFingerprint: sha256(value.inputFingerprint, "scopeBinding.inputFingerprint"),
    planningEvidenceFingerprint: sha256(value.planningEvidenceFingerprint, "scopeBinding.planningEvidenceFingerprint"),
    runtimeInputFingerprint: sha256(value.runtimeInputFingerprint, "scopeBinding.runtimeInputFingerprint"),
    seerfarRequestFingerprint: sha256(value.seerfarRequestFingerprint, "scopeBinding.seerfarRequestFingerprint"),
    salesSnapshotFingerprint: sha256(value.salesSnapshotFingerprint, "scopeBinding.salesSnapshotFingerprint"),
    supplySnapshotFingerprint: sha256(value.supplySnapshotFingerprint, "scopeBinding.supplySnapshotFingerprint"),
    profitModelFingerprint: sha256(value.profitModelFingerprint, "scopeBinding.profitModelFingerprint"),
    c1FactsFingerprint: sha256(value.c1FactsFingerprint, "scopeBinding.c1FactsFingerprint"),
    pointBudgetEvidenceRef: strictRef(value.pointBudgetEvidenceRef, "scopeBinding.pointBudgetEvidenceRef"),
    quotaEvidenceRef: strictRef(value.quotaEvidenceRef, "scopeBinding.quotaEvidenceRef"),
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    provider: C1_PAID_KEYWORD_PROVIDER
  });
}

export function normalizeC1AiDraftScopeBinding(value, { candidateId, skuPackageId, revision: resultRevision } = {}) {
  const fields = ["schemaVersion", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "sourceSkuRevision",
    "identity", "variantKey", "sideEffectScope", "authorizationRef", "credentialAlias", "inputFingerprint", "requestFingerprint", "provider"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(field => !Object.hasOwn(value, field)) || value.schemaVersion !== "software-job-scope-v1" ||
      value.sideEffectScope !== C1_AI_DRAFT_JOB_TYPE || value.candidateId !== candidateId || value.skuPackageId !== skuPackageId ||
      !Number.isInteger(value.sourceRevision) || value.sourceRevision < 0 || value.resultRevision !== value.sourceRevision + 1 ||
      value.resultRevision !== resultRevision || !Number.isInteger(value.sourceSkuRevision) || value.sourceSkuRevision < 0 ||
      value.inputFingerprint !== value.requestFingerprint || !["terra", "sol"].includes(value.provider)) {
    throw new Error("SOFTWARE_JOB_INVALID: c1_ai_draft scopeBinding无效");
  }
  const identity = normalizeC1SourceIdentity(value.identity, "softwareJob.scopeBinding.identity");
  if (identity.candidateId !== candidateId || identity.skuPackageId !== skuPackageId) {
    throw new Error("SOFTWARE_JOB_INVALID: c1_ai_draft G1身份不匹配");
  }
  assertCanonicalC1AuthorizationId(value.authorizationRef, "softwareJob.scopeBinding.authorizationRef");
  return Object.freeze({
    schemaVersion: "software-job-scope-v1", candidateId: strictRef(candidateId, "candidateId"),
    skuPackageId: strictRef(skuPackageId, "skuPackageId"), sourceRevision: value.sourceRevision,
    resultRevision: value.resultRevision, sourceSkuRevision: value.sourceSkuRevision, identity,
    variantKey: boundedText(value.variantKey, "scopeBinding.variantKey"), sideEffectScope: C1_AI_DRAFT_JOB_TYPE,
    authorizationRef: value.authorizationRef, credentialAlias: strictRef(value.credentialAlias, "scopeBinding.credentialAlias"),
    inputFingerprint: sha256(value.inputFingerprint, "scopeBinding.inputFingerprint"),
    requestFingerprint: sha256(value.requestFingerprint, "scopeBinding.requestFingerprint"), provider: value.provider
  });
}

function normalizeScopeBinding(value, identity, jobType) {
  if (jobType === D_PLATFORM_OBSERVATION_JOB_TYPE) {
    const scope=assertDPlatformObservationScope(value);
    if(scope.candidateId!==identity.candidateId||scope.skuPackageId!==identity.skuPackageId||scope.revision!==identity.revision)throw new Error('SOFTWARE_JOB_OBSERVATION_SCOPE_CONFLICT');
    return structuredClone(scope);
  }
  if (jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE) return assertASupplierImageSearchScope(value, { ...identity, jobType, scopeBinding: value });
  if (jobType === A_PRODUCT_DETAIL_JOB_TYPE) return assertAProductDetailScope(value, { ...identity, jobType, scopeBinding: value });
  if (jobType === A_DISCOVERY_JOB_TYPE) return assertADiscoveryScope(value, { ...identity, jobType, scopeBinding: value });
  if (jobType === OZON_ACCOUNT_READ_JOB_TYPE) return assertOzonAccountReadScope(value, { ...identity, jobType });
  if (value === null || value === undefined) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding必须绑定具体领域副作用");
  }
  if (jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE) return normalizeC2ScopeBinding(value, identity);
  if (jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) return normalizeC1ScopeBinding(value, identity);
  if (jobType === C1_AI_DRAFT_JOB_TYPE) return normalizeC1AiDraftScopeBinding(value, identity);
  if ([D_PRODUCTION_EXECUTION_JOB_TYPE, E_INDEPENDENT_READBACK_JOB_TYPE].includes(jobType)) {
    return normalizeDESoftwareJobScope(value, { ...identity, jobType });
  }
  throw new Error("SOFTWARE_JOB_INVALID: jobType不支持");
}

export function createSoftwareJobEnvelope({
  jobId,
  candidateId,
  skuPackageId,
  subject,
  revision: sourceRevision,
  jobType,
  createdAt,
  requestedByUserId,
  ownerUserId,
  requiredCapabilities,
  idempotencyKey,
  scopeBinding = null
}) {
  const normalizedJobType = strictRef(jobType, "jobType");
  if (!SOFTWARE_JOB_TYPES.includes(normalizedJobType)) {
    throw new Error("SOFTWARE_JOB_INVALID: jobType不支持");
  }
  const expectedCapabilities = normalizedJobType === A_DISCOVERY_JOB_TYPE
    ? [getADiscoveryCapability(scopeBinding)] : SOFTWARE_JOB_REQUIRED_CAPABILITIES_BY_TYPE[normalizedJobType];
  if (!Array.isArray(requiredCapabilities) ||
      JSON.stringify([...new Set(requiredCapabilities)].sort()) !== JSON.stringify(expectedCapabilities) ||
      requiredCapabilities.some((item) => !WORKER_CAPABILITIES.includes(item))) {
    throw new Error("SOFTWARE_JOB_INVALID: requiredCapabilities无效");
  }
  const preparationSubject = subject === undefined ? null : normalizeJobSubject(subject);
  const discovery = [A_DISCOVERY_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE].includes(normalizedJobType);
  if ([A_PRODUCT_DETAIL_JOB_TYPE,A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE].includes(normalizedJobType) && preparationSubject?.kind !== "a_candidate") throw new Error("SOFTWARE_JOB_A_CANDIDATE_SUBJECT_INVALID");
  if (normalizedJobType === A_DISCOVERY_JOB_TYPE && preparationSubject?.kind !== "discovery_batch") throw new Error("SOFTWARE_JOB_DISCOVERY_SUBJECT_INVALID");
  if (preparationSubject !== null && (![OZON_ACCOUNT_READ_JOB_TYPE,A_DISCOVERY_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE].includes(normalizedJobType) ||
      (normalizedJobType === OZON_ACCOUNT_READ_JOB_TYPE && preparationSubject.kind !== "account_preparation") ||
      candidateId !== undefined || skuPackageId !== undefined || preparationSubject.revision !== sourceRevision)) {
    throw new Error('SOFTWARE_JOB_PREPARATION_SUBJECT_INVALID');
  }
  const identity = preparationSubject === null ? {
    candidateId: strictRef(candidateId, "candidateId"),
    skuPackageId: strictRef(skuPackageId, "skuPackageId"),
    revision: revision(sourceRevision)
  } : { subject: preparationSubject, revision: revision(sourceRevision), schemaVersion: discovery ? 'software-job-v3' : 'software-job-v2' };
  return Object.freeze({
    schemaVersion: preparationSubject === null ? "software-job-v1" : discovery ? "software-job-v3" : "software-job-v2",
    jobId: strictRef(jobId, "jobId"),
    ...(preparationSubject === null ? { candidateId: identity.candidateId, skuPackageId: identity.skuPackageId } : { subject: preparationSubject }),
    revision: identity.revision,
    jobType: normalizedJobType,
    status: "queued",
    createdAt: iso(createdAt, "createdAt"),
    startedAt: null,
    lastProgressAt: null,
    completedAt: null,
    requestedByUserId: strictRef(requestedByUserId, "requestedByUserId"),
    ownerUserId: strictRef(ownerUserId, "ownerUserId"),
    requiredCapabilities: expectedCapabilities,
    workerId: null,
    workerVersion: null,
    workerCapabilitiesSnapshot: Object.freeze([]),
    leaseId: null,
    leaseExpiresAt: null,
    attempt: 0,
    idempotencyKey: strictRef(idempotencyKey, "idempotencyKey"),
    externalRequestState: "not_sent",
    externalRequestRef: null,
    progressRef: null,
    resultRef: null,
    resultEnvelope: null,
    failureClass: null,
    automaticRetryAllowed: false,
    admissionDecision: null,
    scopeBinding: normalizeScopeBinding(scopeBinding, identity, normalizedJobType)
  });
}

export function claimSoftwareJobLease({ job, worker, leaseId, serverTime, leaseDurationMs }) {
  assertSoftwareJobPreparationEvidence(job);
  if (!supportedSoftwareJobVersion(job) || job.status !== "queued" || job.attempt !== 0) {
    throw new Error("SOFTWARE_JOB_CLAIM_REJECTED: 作业不是可领取状态");
  }
  if (!worker || worker.status !== "online" || !workerSatisfiesCapabilities(worker, job.requiredCapabilities)) {
    throw new Error("SOFTWARE_JOB_CLAIM_REJECTED: Worker能力或状态不满足");
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 30 * 60 * 1000) {
    throw new Error("SOFTWARE_JOB_CLAIM_REJECTED: leaseDurationMs无效");
  }
  const startedAt = iso(serverTime, "serverTime");
  return Object.freeze({
    ...structuredClone(job),
    status: "claimed",
    startedAt,
    lastProgressAt: startedAt,
    workerId: strictRef(worker.workerId, "workerId"),
    workerVersion: strictRef(worker.version, "workerVersion"),
    workerCapabilitiesSnapshot: normalizeWorkerCapabilitiesSnapshot(worker.capabilities),
    leaseId: strictRef(leaseId, "leaseId"),
    leaseExpiresAt: new Date(Date.parse(startedAt) + leaseDurationMs).toISOString(),
    attempt: 1
  });
}

export function bindSoftwareJobAdmissionDecision(job, decision) {
  if(job?.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE){
    assertDPlatformObservationAdmission(job,decision);assertSafeRuntimeRecord(decision,'softwareJob.admissionDecision');
    return Object.freeze({...structuredClone(job),admissionDecision:structuredClone(decision)});
  }
  if (isDESoftwareJob(job)) {
    assertDEJobAdmissionDecision(job, decision);
    assertSafeRuntimeRecord(decision, "softwareJob.admissionDecision");
    return Object.freeze({ ...structuredClone(job), admissionDecision: Object.freeze(structuredClone(decision)) });
  }
  const preparation = isSubjectSoftwareJob(job);
  if (!supportedSoftwareJobVersion(job) || !job.scopeBinding ||
      !decision || decision.schemaVersion !== (isVersionThreeSubjectJob(job) ? "software-job-admission-v3" : preparation ? "software-job-admission-v2" : "software-job-admission-v1") ||
      decision.jobId !== job.jobId || decision.candidateId !== job.candidateId ||
      decision.skuPackageId !== job.skuPackageId || decision.revision !== job.revision ||
      (preparation && (!isDeepStrictEqual(decision.subject, job.subject) || Object.hasOwn(decision, 'candidateId') || Object.hasOwn(decision, 'skuPackageId'))) ||
      decision.jobType !== job.jobType || decision.authorizationRef !== job.scopeBinding.authorizationRef ||
      decision.credentialAlias !== job.scopeBinding.credentialAlias ||
      !/^[a-f0-9]{64}$/.test(String(decision.authorizationFingerprint || "")) ||
      !/^[a-f0-9]{64}$/.test(String(decision.credentialBindingFingerprint || ""))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_DECISION_INVALID");
  }
  const normalizedDecision = structuredClone(decision);
  assertSafeRuntimeRecord(normalizedDecision, "softwareJob.admissionDecision");
  return Object.freeze({
    ...structuredClone(job),
    admissionDecision: Object.freeze(normalizedDecision)
  });
}

export function softwareJobRequiresDomainSettlement(job) {
  return isDESoftwareJob(job) || job?.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE || job?.jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE || job?.jobType === A_PRODUCT_DETAIL_JOB_TYPE || job?.jobType === A_DISCOVERY_JOB_TYPE || job?.jobType === OZON_ACCOUNT_READ_JOB_TYPE || job?.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
    job?.scopeBinding?.sideEffectScope === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
    job?.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
    job?.scopeBinding?.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
    job?.jobType === C1_AI_DRAFT_JOB_TYPE || job?.scopeBinding?.sideEffectScope === C1_AI_DRAFT_JOB_TYPE;
}

function assertActiveLease(job, { workerId, leaseId, serverTime }) {
  if (job.workerId !== strictRef(workerId, "workerId") || job.leaseId !== strictRef(leaseId, "leaseId")) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: Worker或租约不匹配");
  }
  const observedAt = iso(serverTime, "serverTime");
  if (!job.leaseExpiresAt || Date.parse(observedAt) > Date.parse(job.leaseExpiresAt)) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: 租约已过期");
  }
  return observedAt;
}

/** The caller must read the job in its current repository transaction. This does not grant a domain action. */
export function assertSoftwareJobExecutionLease({ job, workerId, leaseId, serverTime }) {
  if (!supportedSoftwareJobVersion(job) || !["claimed", "waiting_platform"].includes(job.status) || job.attempt !== 1) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: 作业不是本轮已领取状态");
  }
  if (job.status === "claimed" ? job.externalRequestState !== "not_sent" || job.externalRequestRef !== null
    : job.externalRequestState !== "in_flight" || typeof job.externalRequestRef !== "string" || !job.externalRequestRef) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: 执行状态与外部请求状态冲突");
  }
  return assertActiveLease(job, { workerId, leaseId, serverTime });
}

export function recordSoftwareJobProgress({ job, workerId, leaseId, progressRef, serverTime }) {
  if (!supportedSoftwareJobVersion(job) || job.status !== "claimed" || job.attempt !== 1) {
    throw new Error("SOFTWARE_JOB_PROGRESS_REJECTED: 作业不是已领取状态");
  }
  const observedAt = assertActiveLease(job, { workerId, leaseId, serverTime });
  const next = {
    ...structuredClone(job),
    lastProgressAt: observedAt,
    progressRef: strictRef(progressRef, "progressRef")
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

/** D/E may have several ordered checkpoints in one claimed attempt; this never starts or repeats an external action. */
export function recordDESoftwareJobProgress({ job, workerId, leaseId, progressRef, serverTime }) {
  if (!isDESoftwareJob(job)) throw new Error("SOFTWARE_JOB_PROGRESS_REJECTED: D/E作业必需");
  const observedAt = assertSoftwareJobExecutionLease({ job, workerId, leaseId, serverTime });
  const next = { ...structuredClone(job), lastProgressAt: observedAt, progressRef: strictRef(progressRef, "progressRef") };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

export function markSoftwareJobExternalRequestStarted({ job, workerId, leaseId, externalRequestRef, serverTime }) {
  if (!supportedSoftwareJobVersion(job) || job.status !== "claimed" || job.attempt !== 1 || job.externalRequestState !== "not_sent") {
    throw new Error("SOFTWARE_JOB_EXTERNAL_REQUEST_REJECTED: 作业不能开始外部请求");
  }
  const observedAt = assertActiveLease(job, { workerId, leaseId, serverTime });
  const next = {
    ...structuredClone(job),
    status: "waiting_platform",
    lastProgressAt: observedAt,
    ...([C2_STABLE_ASSET_TRANSPORT_JOB_TYPE, C1_AI_DRAFT_JOB_TYPE].includes(job.jobType)
      ? { progressRef: strictRef(externalRequestRef, "externalRequestRef") } : {}),
    externalRequestState: "in_flight",
    externalRequestRef: strictRef(externalRequestRef, "externalRequestRef")
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

/** Records an already-issued request's gateway identity; it grants no new execution permission. */
export function recordC1GatewayAcceptance({ job, workerId, leaseId, requestFingerprint, gatewayJobId, serverTime }) {
  if (!job || job.schemaVersion !== "software-job-v1" || job.jobType !== C1_AI_DRAFT_JOB_TYPE || job.attempt !== 1 ||
      job.scopeBinding?.sideEffectScope !== C1_AI_DRAFT_JOB_TYPE || job.scopeBinding.requestFingerprint !== requestFingerprint ||
      job.workerId !== strictRef(workerId, "workerId") || job.leaseId !== strictRef(leaseId, "leaseId") ||
      !job.externalRequestRef || !job.lastProgressAt || job.externalRequestState === "not_sent") {
    throw new Error("C1_GATEWAY_ACCEPTANCE_SCOPE_REJECTED");
  }
  const gatewayRef = strictRef(gatewayJobId, "gatewayJobId");
  if (gatewayRef === job.externalRequestRef) throw new Error("C1_GATEWAY_ACCEPTANCE_ID_INVALID");
  const observedAt = iso(serverTime, "serverTime");
  if (Date.parse(observedAt) < Date.parse(iso(job.lastProgressAt, "lastProgressAt"))) throw new Error("C1_GATEWAY_ACCEPTANCE_TIME_INVALID");
  if (job.progressRef === gatewayRef) return Object.freeze({ changed: false, job: Object.freeze(structuredClone(job)) });
  const recoveringIssuedRequest = job.status === "unknown_outcome" && job.externalRequestState === "unknown_outcome" &&
    ["service_restart_after_external_request", "lease_expired_after_external_request"].includes(job.failureClass) &&
    job.resultEnvelope === null && job.resultRef === null;
  if (!(job.status === "waiting_platform" && job.externalRequestState === "in_flight") && !recoveringIssuedRequest) {
    throw new Error("C1_GATEWAY_ACCEPTANCE_STATE_REJECTED");
  }
  if (job.progressRef !== job.externalRequestRef) throw new Error("C1_GATEWAY_ACCEPTANCE_CONFLICT");
  const next = { ...structuredClone(job), progressRef: gatewayRef };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze({ changed: true, job: Object.freeze(next) });
}

function restartOrLeaseReconciliationContext(job, serverTime) {
  if (!supportedSoftwareJobVersion(job) ||
      !["claimed", "waiting_platform"].includes(job.status) ||
      job.attempt !== 1 ||
      job.completedAt !== null ||
      job.resultRef !== null ||
      job.resultEnvelope !== null ||
      !job.startedAt ||
      !job.lastProgressAt ||
      !job.workerId ||
      !job.leaseId ||
      !job.leaseExpiresAt) {
    throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
  }
  const observedAt = iso(serverTime, "serverTime");
  const startedAt = iso(job.startedAt, "startedAt");
  const lastProgressAt = iso(job.lastProgressAt, "lastProgressAt");
  const leaseExpiresAt = iso(job.leaseExpiresAt, "leaseExpiresAt");
  strictRef(job.workerId, "workerId");
  strictRef(job.leaseId, "leaseId");
  if (Date.parse(observedAt) < Date.parse(startedAt) ||
      Date.parse(observedAt) < Date.parse(lastProgressAt)) {
    throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
  }
  if (job.status === "claimed") {
    if (job.externalRequestState !== "not_sent" || job.externalRequestRef !== null) {
      throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
    }
    return Object.freeze({ observedAt, leaseExpiresAt, requestWasSent: false });
  }
  if (job.externalRequestState !== "in_flight" || !job.externalRequestRef) {
    throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
  }
  strictRef(job.externalRequestRef, "externalRequestRef");
  return Object.freeze({ observedAt, leaseExpiresAt, requestWasSent: true });
}

function reconciledSoftwareJob(job, { observedAt, requestWasSent, failureClass }) {
  const preserveC2RequestStart = job.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE && requestWasSent;
  const next = {
    ...structuredClone(job),
    status: requestWasSent ? "unknown_outcome" : "failed",
    completedAt: observedAt,
    lastProgressAt: preserveC2RequestStart ? job.lastProgressAt : observedAt,
    ...(preserveC2RequestStart ? { progressRef: job.externalRequestRef } : {}),
    externalRequestState: requestWasSent ? "unknown_outcome" : "not_sent",
    failureClass,
    automaticRetryAllowed: false
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

export function reconcileSoftwareJobAfterRestart({ job, serverTime }) {
  const context = restartOrLeaseReconciliationContext(job, serverTime);
  return reconciledSoftwareJob(job, {
    observedAt: context.observedAt,
    requestWasSent: context.requestWasSent,
    failureClass: context.requestWasSent ? "service_restart_after_external_request" : "service_restart_before_external_request"
  });
}

export function reconcileExpiredSoftwareJobLease({ job, serverTime }) {
  const context = restartOrLeaseReconciliationContext(job, serverTime);
  if (Date.parse(context.observedAt) <= Date.parse(context.leaseExpiresAt)) {
    throw new Error("SOFTWARE_JOB_LEASE_NOT_EXPIRED");
  }
  return reconciledSoftwareJob(job, {
    observedAt: context.observedAt,
    requestWasSent: context.requestWasSent,
    failureClass: context.requestWasSent ? "lease_expired_after_external_request" : "lease_expired_before_external_request"
  });
}

function normalizeResultEnvelope(envelope, job, applicationDisposition) {
  assertBoundedResultEnvelopeStructure(envelope);
  const preparation = isSubjectSoftwareJob(job);
  const allowedKeys = [
    "schemaVersion", "resultRef", "jobId", "jobType", ...(preparation ? ['subject'] : ['candidateId', 'skuPackageId']), "revision",
    "workerId", "leaseId", "externalRequestRef", "externalRequestState", "payloadKind", "payload",
    "payloadFingerprint", "applicationDisposition", "recordedAt"
  ];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).some((key) => !allowedKeys.includes(key)) ||
      envelope.schemaVersion !== resultEnvelopeVersion(job) ||
      !(envelope.externalRequestState === "succeeded" || (job.jobType === C1_AI_DRAFT_JOB_TYPE && ["failed", "unknown_outcome"].includes(envelope.externalRequestState)) ||
        (job.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE && ["not_sent","unknown_outcome"].includes(envelope.externalRequestState)) ||
        (job.jobType===D_PRODUCTION_EXECUTION_JOB_TYPE&&job.platformContinuation?.schemaVersion==="d-platform-continuation-v1"&&envelope.externalRequestState==="unknown_outcome")) ||
      envelope.jobId !== job.jobId || envelope.jobType !== job.jobType ||
      envelope.payloadKind !== job.jobType ||
      envelope.candidateId !== job.candidateId || envelope.skuPackageId !== job.skuPackageId ||
      (preparation && !isDeepStrictEqual(envelope.subject, job.subject)) ||
      envelope.revision !== job.revision || envelope.workerId !== job.workerId ||
      envelope.leaseId !== job.leaseId || envelope.externalRequestRef !== job.externalRequestRef ||
      !SOFTWARE_JOB_APPLICATION_DISPOSITIONS.includes(applicationDisposition) ||
      !SOFTWARE_JOB_APPLICATION_DISPOSITIONS.includes(envelope.applicationDisposition) ||
      (["failed", "unknown_outcome"].includes(envelope.externalRequestState) &&
        (applicationDisposition !== "result_recorded_no_candidate_mutation" || envelope.applicationDisposition !== "result_recorded_no_candidate_mutation")) ||
      !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
  }
  const payload = structuredClone(envelope.payload);
  const payloadFingerprint = fingerprintCanonicalRecord(payload);
  if (envelope.payloadFingerprint !== payloadFingerprint) throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
  const normalized = {
    schemaVersion: resultEnvelopeVersion(job),
    resultRef: strictRef(envelope.resultRef, "resultEnvelope.resultRef"),
    jobId: strictRef(envelope.jobId, "resultEnvelope.jobId"),
    jobType: strictRef(envelope.jobType, "resultEnvelope.jobType"),
    ...(preparation ? { subject: normalizeJobSubject(envelope.subject) }
      : { candidateId: strictRef(envelope.candidateId, "resultEnvelope.candidateId"), skuPackageId: strictRef(envelope.skuPackageId, "resultEnvelope.skuPackageId") }),
    revision: revision(envelope.revision),
    workerId: job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE&&job.attempt===0&&job.externalRequestState==='not_sent'&&envelope.workerId===null ? null : strictRef(envelope.workerId, "resultEnvelope.workerId"),
    leaseId: ((job.jobType===D_PRODUCTION_EXECUTION_JOB_TYPE&&job.platformContinuation?.schemaVersion==='d-platform-continuation-v1')||(job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE&&job.attempt===0&&job.externalRequestState==='not_sent'))&&job.leaseId===null&&envelope.leaseId===null ? null : strictRef(envelope.leaseId, "resultEnvelope.leaseId"),
    externalRequestRef: ((job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE&&envelope.externalRequestState==="not_sent")||(job.jobType===D_PRODUCTION_EXECUTION_JOB_TYPE&&job.platformContinuation?.schemaVersion==='d-platform-continuation-v1'))&&envelope.externalRequestRef===null ? null : strictRef(envelope.externalRequestRef, "resultEnvelope.externalRequestRef"),
    externalRequestState: envelope.externalRequestState,
    payloadKind: strictRef(envelope.payloadKind, "resultEnvelope.payloadKind"),
    payload,
    payloadFingerprint,
    applicationDisposition,
    recordedAt: iso(envelope.recordedAt, "resultEnvelope.recordedAt")
  };
  assertSafeRuntimeRecord(normalized, "softwareJob.resultEnvelope");
  return Object.freeze(normalized);
}

export function createSoftwareJobResultEnvelope({
  job,
  resultRef,
  payloadKind,
  payload,
  recordedAt,
  applicationDisposition = "result_recorded_no_candidate_mutation",
  externalRequestState = "succeeded"
}) {
  assertBoundedResultEnvelopeStructure(payload, "resultEnvelope.payload");
  const payloadFingerprint = fingerprintCanonicalRecord(payload);
  return normalizeResultEnvelope({
    schemaVersion: resultEnvelopeVersion(job),
    resultRef,
    jobId: job?.jobId,
    jobType: job?.jobType,
    ...(isSubjectSoftwareJob(job) ? { subject: job.subject } : { candidateId: job?.candidateId, skuPackageId: job?.skuPackageId }),
    revision: job?.revision,
    workerId: job?.workerId,
    leaseId: job?.leaseId,
    externalRequestRef: job?.externalRequestRef,
    externalRequestState,
    payloadKind,
    payload,
    payloadFingerprint,
    applicationDisposition,
    recordedAt
  }, job, applicationDisposition);
}

function issuedRequestTerminalTime(job, { workerId, leaseId, serverTime }) {
  if (job.workerId !== strictRef(workerId, "workerId") || job.leaseId !== strictRef(leaseId, "leaseId")) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: Worker或租约不匹配");
  }
  const observedAt = iso(serverTime, "serverTime");
  if (!job.startedAt || !job.lastProgressAt || !job.leaseExpiresAt ||
      Date.parse(observedAt) < Date.parse(iso(job.lastProgressAt, "lastProgressAt")) ||
      Date.parse(job.lastProgressAt) < Date.parse(iso(job.startedAt, "startedAt")) ||
      Date.parse(iso(job.leaseExpiresAt, "leaseExpiresAt")) <= Date.parse(job.startedAt)) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 终态登记时间无效或倒退");
  }
  return observedAt;
}

function assertC1AiJobRequest(job, request) {
  const scope = normalizeC1AiDraftScopeBinding(job.scopeBinding, job);
  if (!validateC1AiDraftRequest(request).valid || request.sourceSkuRevision !== scope.sourceSkuRevision ||
      request.requestFingerprint !== scope.requestFingerprint || request.provider !== scope.provider ||
      request.identity.variantKey !== scope.variantKey ||
      fingerprintCanonicalRecord(normalizeC1SourceIdentity(request.sourceIdentity)) !== fingerprintCanonicalRecord(scope.identity)) {
    throw new Error("SOFTWARE_JOB_C1_AI_RESULT_INVALID: 请求不属于已保存作业");
  }
}

function assertC1AiDraftResult(job, envelope, applicationDisposition, completedAt, requestStartedAt = job.lastProgressAt, { allowApplied = false } = {}) {
  const payload = envelope.payload;
  const fields = ["schemaVersion", "request", "receipt"];
  if ((!allowApplied && (applicationDisposition === "applied" || envelope.applicationDisposition === "applied")) ||
      !payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== fields.length ||
      fields.some(field => !Object.hasOwn(payload, field)) || payload.schemaVersion !== "c1-ai-draft-software-result-v1") {
    throw new Error("SOFTWARE_JOB_C1_AI_RESULT_INVALID: 作业只登记回执，不应用候选");
  }
  const { request, receipt } = payload;
  assertC1AiJobRequest(job, request);
  if (envelope.externalRequestState !== "succeeded" || receipt?.softwareJobId !== job.jobId ||
      !validateC1AiDraftReceipt({ request, receipt }).valid ||
      Date.parse(receipt.startedAt) < Date.parse(requestStartedAt) ||
      Date.parse(receipt.completedAt) > Date.parse(envelope.recordedAt) || Date.parse(envelope.recordedAt) > Date.parse(completedAt)) {
    throw new Error("SOFTWARE_JOB_C1_AI_RESULT_INVALID: 回执不属于已保存的精确草稿请求");
  }
}

function assertC1AiDraftFailureResult(job, envelope, { externalRequestState, failureClass, completedAt, requestStartedAt = job.lastProgressAt }) {
  const payload = envelope.payload;
  const fields = ["schemaVersion", "request", "accounting", "errorCode"];
  if (payload && Object.hasOwn(payload, "providerOutcome")) fields.push("providerOutcome");
  if (payload && Object.hasOwn(payload, "serviceTiming")) fields.push("serviceTiming");
  if (envelope.applicationDisposition !== "result_recorded_no_candidate_mutation" ||
      envelope.externalRequestState !== externalRequestState ||
      !payload || Object.keys(payload).length !== fields.length || fields.some(field => !Object.hasOwn(payload, field)) ||
      payload.schemaVersion !== "c1-ai-draft-software-failure-v1" || payload.errorCode !== failureClass ||
      !validateC1AiAccounting(payload.accounting).valid ||
      (payload.accounting.gatewayJobId !== null && payload.accounting.gatewayJobId !== envelope.resultRef) ||
      Date.parse(envelope.recordedAt) < Date.parse(requestStartedAt) || Date.parse(envelope.recordedAt) > Date.parse(completedAt)) {
    throw new Error("SOFTWARE_JOB_C1_AI_FAILURE_RESULT_INVALID");
  }
  strictRef(payload.errorCode, "c1Failure.errorCode");
  if (Object.hasOwn(payload, "providerOutcome") && payload.providerOutcome !== null) {
    const provider = assertC1ProviderOutcome(payload.providerOutcome);
    const gatewayResult = provider.externalRequestState === "not_sent" ? "failed" : provider.externalRequestState;
    if (gatewayResult !== externalRequestState) throw new Error("SOFTWARE_JOB_C1_AI_FAILURE_RESULT_INVALID: 网关与供应商请求终态冲突");
  }
  if (Object.hasOwn(payload, "serviceTiming")) {
    const timing = assertC1ServiceTiming(payload.serviceTiming, { gatewayJobId: envelope.resultRef });
    if (timing.gatewayJobId !== payload.accounting.gatewayJobId || externalRequestState === "unknown_outcome" ||
        Date.parse(timing.startedAt) < Date.parse(job.startedAt) ||
        Date.parse(timing.startedAt) < Date.parse(payload.request.requestedAt) ||
        Date.parse(timing.completedAt) > Date.parse(envelope.recordedAt)) {
      throw new Error("SOFTWARE_JOB_C1_AI_FAILURE_TIMING_INVALID");
    }
  }
  assertC1AiJobRequest(job, payload.request);
}

/** Project only a durably admitted request-start record, never a client authorization DTO. */
export function projectC1AiSoftwareJobAuthorizedExecution(job, request) {
  if (job?.jobType !== C1_AI_DRAFT_JOB_TYPE || job.status !== "waiting_platform" ||
      job.externalRequestState !== "in_flight" || job.attempt !== 1 || !job.externalRequestRef || !job.workerId || !job.leaseId) {
    throw new Error("SOFTWARE_JOB_C1_AI_EXECUTION_NOT_STARTED");
  }
  const scope = normalizeC1AiDraftScopeBinding(job.scopeBinding, job);
  bindSoftwareJobAdmissionDecision(job, job.admissionDecision);
  return assertAuthorizedC1Execution({ request, authorizedExecution: {
    schemaVersion: "c1-ai-authorized-execution-v1", jobId: job.jobId, jobType: C1_AI_DRAFT_JOB_TYPE,
    candidateRevision: job.revision, sourceSkuRevision: scope.sourceSkuRevision, identity: structuredClone(scope.identity),
    requestFingerprint: scope.requestFingerprint, status: "waiting_platform", externalRequestState: "in_flight",
    authorizationRef: { authorizationId: scope.authorizationRef, authorizationType: "paid_ai_draft",
      scope: { candidateId: job.candidateId, skuPackageId: job.skuPackageId, platform: scope.identity.platform,
        storeRef: scope.identity.storeRef.stableStoreId, sourceRevision: scope.sourceSkuRevision, jobType: C1_AI_DRAFT_JOB_TYPE } }
  } });
}

/** Read and validate a previously persisted receipt; this does not settle or apply it. */
export function readCompletedC1AiSoftwareJobResult(job, { allowApplied = false } = {}) {
  if (typeof allowApplied !== "boolean") throw new TypeError("SOFTWARE_JOB_C1_AI_READ_OPTIONS_INVALID");
  if (job?.jobType !== C1_AI_DRAFT_JOB_TYPE || job.status !== "completed" || job.externalRequestState !== "succeeded" ||
      job.attempt !== 1 || !job.resultEnvelope || (!allowApplied && job.resultEnvelope.applicationDisposition === "applied") ||
      job.resultRef !== job.resultEnvelope.resultRef || !job.startedAt || !job.completedAt) {
    throw new Error("SOFTWARE_JOB_C1_AI_SAVED_RESULT_REQUIRED");
  }
  const envelope = normalizeResultEnvelope(job.resultEnvelope, job, job.resultEnvelope.applicationDisposition);
  assertC1AiDraftResult(job, envelope, envelope.applicationDisposition, iso(job.completedAt, "completedAt"), iso(job.startedAt, "startedAt"), { allowApplied });
  const { request, receipt } = envelope.payload;
  const authorizedExecution = projectC1AiSoftwareJobAuthorizedExecution({ ...job, status: "waiting_platform", externalRequestState: "in_flight" }, request);
  return Object.freeze({ request: structuredClone(request), receipt: structuredClone(receipt),
    settledExecution: { schemaVersion: "c1-ai-settled-execution-v1", authorizedExecution, softwareJobId: job.jobId,
      gatewayJobId: receipt.gatewayJobId, status: "completed", externalRequestState: "succeeded", receiptRef: receipt.receiptId } });
}

/** Eligibility for an explicit read of a durably accepted gateway request.
 * Restart records without a bound failure receipt are intentionally excluded. */
export function isC1AiDraftReconciliationPending(job) {
  const envelope = job?.resultEnvelope, payload = envelope?.payload;
  return job?.jobType === C1_AI_DRAFT_JOB_TYPE && job.status === "unknown_outcome" &&
    job.externalRequestState === "unknown_outcome" && job.attempt === 1 &&
    job.failureClass === "C1_AI_GATEWAY_DEADLINE_EXCEEDED" &&
    typeof job.progressRef === "string" && job.progressRef.length > 0 && job.progressRef !== job.externalRequestRef &&
    envelope?.externalRequestState === "unknown_outcome" && envelope.resultRef === job.progressRef && job.resultRef === job.progressRef &&
    payload?.schemaVersion === "c1-ai-draft-software-failure-v1" && payload.errorCode === job.failureClass &&
    payload.accounting?.gatewayJobId === job.progressRef;
}

export function readC1AiDraftReconciliationSource(job) {
  if (!isC1AiDraftReconciliationPending(job)) throw new Error("C1_DRAFT_RECONCILIATION_NOT_ELIGIBLE");
  const envelope = normalizeResultEnvelope(job.resultEnvelope, job, "result_recorded_no_candidate_mutation");
  assertC1AiDraftFailureResult(job, envelope, { externalRequestState: job.externalRequestState,
    failureClass: job.failureClass, completedAt: iso(job.completedAt, "completedAt"), requestStartedAt: iso(job.startedAt, "startedAt") });
  const request = envelope.payload.request;
  // This is a historical execution projection, never permission to resend it.
  const authorizedExecution = projectC1AiSoftwareJobAuthorizedExecution({ ...job,
    status: "waiting_platform", externalRequestState: "in_flight" }, request);
  return Object.freeze({ request: structuredClone(request), authorizedExecution, gatewayJobId: job.progressRef });
}

export function beginC1AiDraftResultReconciliation({ job, workerId, leaseId, leaseDurationMs, serverTime }) {
  const source = readC1AiDraftReconciliationSource(job);
  const observedAt = iso(serverTime, "serverTime");
  if (job.workerId !== strictRef(workerId, "workerId") || !Number.isInteger(leaseDurationMs) ||
      leaseDurationMs < 1000 || leaseDurationMs > 1_800_000 || Date.parse(observedAt) < Date.parse(job.completedAt)) {
    throw new Error("C1_DRAFT_RECONCILIATION_SCOPE_INVALID");
  }
  strictRef(leaseId, "leaseId");
  const previous = job.c1ResultReconciliation;
  if (previous !== undefined && (previous?.schemaVersion !== "c1-ai-result-reconciliation-v1" ||
      previous.gatewayJobId !== source.gatewayJobId || previous.requestFingerprint !== source.request.requestFingerprint ||
      previous.sourceRevision !== job.revision || previous.ownerUserId !== job.ownerUserId ||
      !previous.readAttempt || previous.readAttempt.workerId !== workerId ||
      !["in_flight", "pending", "read_failed"].includes(previous.readAttempt.status) ||
      !Number.isSafeInteger(previous.readAttempt.sequence) || previous.readAttempt.sequence < 1 ||
      !Number.isFinite(Date.parse(previous.readAttempt.startedAt)) ||
      !(Date.parse(previous.readAttempt.expiresAt) > Date.parse(previous.readAttempt.startedAt)) ||
      previous.priorOutcome !== null)) throw new Error("C1_DRAFT_RECONCILIATION_RECORD_INVALID");
  if (previous?.readAttempt.status === "in_flight" && Date.parse(previous.readAttempt.expiresAt) > Date.parse(observedAt)) {
    return Object.freeze({ changed: false, acquired: false, job: structuredClone(job) });
  }
  const sequence = previous === undefined ? 1 : previous.readAttempt.sequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("C1_DRAFT_RECONCILIATION_RECORD_INVALID");
  const next = structuredClone(job);
  next.c1ResultReconciliation = { schemaVersion: "c1-ai-result-reconciliation-v1", gatewayJobId: source.gatewayJobId,
    requestFingerprint: source.request.requestFingerprint, sourceRevision: job.revision, ownerUserId: job.ownerUserId,
    readAttempt: { attemptId: `${leaseId}:${sequence}`, sequence, workerId, status: "in_flight", startedAt: observedAt,
      expiresAt: new Date(Date.parse(observedAt) + leaseDurationMs).toISOString(), completedAt: null },
    observation: null, priorOutcome: null };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze({ changed: true, acquired: true, job: Object.freeze(next), ...source });
}

/** Reconcile only the accepted C1 request. Generic settlement rules remain strict. */
export function settleC1AiDraftResultReconciliation({ job, workerId, attemptId, observationStatus, resultEnvelope = null,
  failureClass = null, applicationDisposition = "result_recorded_no_candidate_mutation", serverTime }) {
  const source = readC1AiDraftReconciliationSource(job);
  const saved = job.c1ResultReconciliation;
  if (saved?.schemaVersion !== "c1-ai-result-reconciliation-v1" || saved.readAttempt.status !== "in_flight" ||
      saved.readAttempt.workerId !== strictRef(workerId, "workerId") || saved.readAttempt.attemptId !== strictRef(attemptId, "attemptId") ||
      saved.gatewayJobId !== source.gatewayJobId || saved.requestFingerprint !== source.request.requestFingerprint || saved.sourceRevision !== job.revision) {
    throw new Error("C1_DRAFT_RECONCILIATION_LEASE_CONFLICT");
  }
  const completedAt = iso(serverTime, "serverTime");
  if (Date.parse(completedAt) < Date.parse(saved.readAttempt.startedAt) ||
      !["pending", "read_failed", "completed", "failed"].includes(observationStatus)) throw new Error("C1_DRAFT_RECONCILIATION_RESULT_INVALID");
  const next = structuredClone(job);
  next.c1ResultReconciliation.readAttempt = { ...next.c1ResultReconciliation.readAttempt,
    status: observationStatus, completedAt };
  next.c1ResultReconciliation.observation = { status: observationStatus, failureCode: failureClass === null ? null : strictRef(failureClass, "failureClass") };
  if (["pending", "read_failed"].includes(observationStatus)) {
    if (resultEnvelope !== null || (observationStatus === "read_failed" && failureClass === null)) throw new Error("C1_DRAFT_RECONCILIATION_RESULT_INVALID");
  } else {
    const envelope = normalizeResultEnvelope(resultEnvelope, job, applicationDisposition);
    if (!isDeepStrictEqual(envelope.payload.request, source.request)) throw new Error("C1_DRAFT_RECONCILIATION_REQUEST_CONFLICT");
    if (observationStatus === "completed") {
      assertC1AiDraftResult(job, envelope, applicationDisposition, completedAt, iso(job.startedAt, "startedAt"));
      if (envelope.payload.receipt.gatewayJobId !== source.gatewayJobId || failureClass !== null) throw new Error("C1_DRAFT_RECONCILIATION_GATEWAY_CONFLICT");
    } else {
      if (!["failed", "succeeded"].includes(envelope.externalRequestState) || envelope.resultRef !== source.gatewayJobId ||
          envelope.payload.accounting?.gatewayJobId !== source.gatewayJobId) throw new Error("C1_DRAFT_RECONCILIATION_GATEWAY_CONFLICT");
      assertC1AiDraftFailureResult(job, envelope, { externalRequestState: envelope.externalRequestState, failureClass, completedAt });
    }
    next.c1ResultReconciliation.priorOutcome = { status: job.status, externalRequestState: job.externalRequestState,
      failureClass: job.failureClass, completedAt: job.completedAt, resultRef: job.resultRef, resultEnvelope: structuredClone(job.resultEnvelope) };
    next.status = observationStatus;
    next.externalRequestState = envelope.externalRequestState;
    next.failureClass = failureClass;
    next.completedAt = completedAt;
    next.lastProgressAt = completedAt;
    next.resultRef = envelope.resultRef;
    next.resultEnvelope = structuredClone(envelope);
  }
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

function settleSoftwareJobCore({
  job,
  workerId,
  leaseId,
  status,
  externalRequestState,
  serverTime,
  resultRef = null,
  resultEnvelope = null,
  applicationDisposition = "result_recorded_no_candidate_mutation",
  failureClass = null,
  externalRequestRef = job?.externalRequestRef ?? null,
  domainSettlementValidated = false,
  c1KeywordFailureValidated = false
}) {
  assertSoftwareJobPreparationEvidence(job);
  if ((isDESoftwareJob(job) || job?.jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE || job?.jobType === A_PRODUCT_DETAIL_JOB_TYPE || job?.jobType === A_DISCOVERY_JOB_TYPE || job?.jobType === OZON_ACCOUNT_READ_JOB_TYPE || job?.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE) && !domainSettlementValidated) throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED");
  if (!supportedSoftwareJobVersion(job) || !["claimed", "waiting_platform"].includes(job.status) || job.attempt !== 1) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 作业不是已领取状态");
  }
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE) {
    normalizeC1AiDraftScopeBinding(job.scopeBinding, job);
    bindSoftwareJobAdmissionDecision(job, job.admissionDecision);
  }
  // Recording the outcome of this already-issued request does not renew its
  // lease or grant permission to issue another request.
  const c1AiRequestWasSent = job.jobType === C1_AI_DRAFT_JOB_TYPE && job.status === "waiting_platform" && job.externalRequestState === "in_flight";
  const c2RequestWasSent = job.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE && job.status === "waiting_platform" &&
    job.externalRequestState === "in_flight" && typeof job.externalRequestRef === "string" && job.externalRequestRef.length > 0;
  const completedAt = c1KeywordFailureValidated || c1AiRequestWasSent || c2RequestWasSent || ((isDESoftwareJob(job) || job.jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE || job.jobType === A_PRODUCT_DETAIL_JOB_TYPE || job.jobType === A_DISCOVERY_JOB_TYPE || job.jobType === OZON_ACCOUNT_READ_JOB_TYPE || job.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE) && domainSettlementValidated)
    ? issuedRequestTerminalTime(job, { workerId, leaseId, serverTime })
    : assertActiveLease(job, { workerId, leaseId, serverTime });
  if (!['completed', 'failed', 'unknown_outcome'].includes(status) || !EXTERNAL_REQUEST_STATES.includes(externalRequestState)) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 终态无效");
  }
  let normalizedEnvelope = null;
  if (status === "completed") {
    if (softwareJobRequiresDomainSettlement(job) && job.jobType !== C1_AI_DRAFT_JOB_TYPE && !domainSettlementValidated) {
      throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED");
    }
    if (job.status !== "waiting_platform" || job.externalRequestState !== "in_flight" || externalRequestState !== "succeeded" || !resultEnvelope) {
      throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 完成态必须从已持久化in_flight收口且有结果封套");
    }
    if (job.jobType === C1_AI_DRAFT_JOB_TYPE && resultEnvelope.applicationDisposition === "applied") {
      throw new Error("SOFTWARE_JOB_C1_AI_RESULT_INVALID: 作业只登记回执，不应用候选");
    }
    normalizedEnvelope = normalizeResultEnvelope(resultEnvelope, job, applicationDisposition);
    if (job.jobType === C1_AI_DRAFT_JOB_TYPE) assertC1AiDraftResult(job, normalizedEnvelope, applicationDisposition, completedAt);
    if (resultRef !== null && resultRef !== undefined && resultRef !== normalizedEnvelope.resultRef) {
      throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
    }
    resultRef = normalizedEnvelope.resultRef;
  }
  if (status === "unknown_outcome" && (job.status !== "waiting_platform" || job.externalRequestState !== "in_flight" || externalRequestState !== "unknown_outcome")) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 结果未知必须从已持久化in_flight收口");
  }
  if (status === "failed") {
    if (!failureClass) throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 失败态必须提供failureClass");
    const validFailureTransition =
      (job.status === "claimed" && job.externalRequestState === "not_sent" && externalRequestState === "not_sent") ||
      (job.status === "waiting_platform" && job.externalRequestState === "in_flight" && externalRequestState === "failed") ||
      (job.jobType === D_PRODUCTION_EXECUTION_JOB_TYPE && domainSettlementValidated &&
        job.status === "waiting_platform" && job.externalRequestState === "in_flight" && ["not_sent", "succeeded"].includes(externalRequestState)) ||
      ([A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_DISCOVERY_JOB_TYPE,OZON_ACCOUNT_READ_JOB_TYPE,D_PLATFORM_OBSERVATION_JOB_TYPE].includes(job.jobType) && domainSettlementValidated && job.status === "waiting_platform" &&
        job.externalRequestState === "in_flight" && ["not_sent", "succeeded"].includes(externalRequestState)) ||
      (c1AiRequestWasSent && externalRequestState === "succeeded" && resultEnvelope !== null) ||
      (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && job.status === "waiting_platform" &&
        job.externalRequestState === "in_flight" && externalRequestState === "succeeded" &&
        failureClass === "c1-paid-keyword-local-preparation-failed" && resultRef === null && resultEnvelope === null);
    if (!validFailureTransition) throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 失败态与已持久化外部请求状态不一致");
  }
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE && status !== "completed" && resultEnvelope !== null) {
    if (!c1AiRequestWasSent || resultEnvelope.applicationDisposition === "applied" || applicationDisposition === "applied") {
      throw new Error("SOFTWARE_JOB_C1_AI_FAILURE_RESULT_INVALID");
    }
    normalizedEnvelope = normalizeResultEnvelope(resultEnvelope, job, applicationDisposition);
    assertC1AiDraftFailureResult(job, normalizedEnvelope, { externalRequestState, failureClass, completedAt });
    if (resultRef !== null && resultRef !== undefined && resultRef !== normalizedEnvelope.resultRef) throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
    resultRef = normalizedEnvelope.resultRef;
  }
  if(job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE&&status!=='completed'&&resultEnvelope!==null){
    if(!domainSettlementValidated||resultEnvelope.externalRequestState!==externalRequestState||applicationDisposition!=='result_recorded_no_candidate_mutation')throw new Error('SOFTWARE_JOB_OBSERVATION_RESULT_INVALID');
    normalizedEnvelope=normalizeResultEnvelope(resultEnvelope,job,applicationDisposition);
    if(resultRef!==normalizedEnvelope.resultRef)throw new Error('SOFTWARE_JOB_OBSERVATION_RESULT_INVALID');
  }
  const persistedExternalRequestRef = job.externalRequestRef ?? null;
  if ((externalRequestRef ?? null) !== persistedExternalRequestRef) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: externalRequestRef不得由结算调用覆盖");
  }
  const next = {
    ...structuredClone(job),
    status,
    lastProgressAt: completedAt,
    completedAt,
    externalRequestState,
    externalRequestRef: persistedExternalRequestRef,
    resultRef: resultRef ? strictRef(resultRef, "resultRef") : null,
    resultEnvelope: normalizedEnvelope ? structuredClone(normalizedEnvelope) : null,
    failureClass: failureClass ? strictRef(failureClass, "failureClass") : null,
    automaticRetryAllowed: false
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

export function settleSoftwareJob(settlement) {
  return settleSoftwareJobCore({
    ...settlement,
    domainSettlementValidated: false,
    c1KeywordFailureValidated: false
  });
}

export function softwareJobsInDocument(document) {
  if (!document.runtime || typeof document.runtime !== "object" || Array.isArray(document.runtime)) document.runtime = {};
  if (!Array.isArray(document.runtime.softwareJobs)) document.runtime.softwareJobs = [];
  return document.runtime.softwareJobs;
}

export function sameSoftwareJobIdentity(left, right) {
  return left.schemaVersion === right.schemaVersion && isDeepStrictEqual(left.subject, right.subject) &&
    left.jobId === right.jobId && left.candidateId === right.candidateId &&
    left.skuPackageId === right.skuPackageId && left.revision === right.revision && left.jobType === right.jobType &&
    left.requestedByUserId === right.requestedByUserId && left.ownerUserId === right.ownerUserId &&
    (left.resultEnvelope ?? null) === null && (right.resultEnvelope ?? null) === null &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left.requiredCapabilities) === JSON.stringify(right.requiredCapabilities) &&
    JSON.stringify(left.scopeBinding) === JSON.stringify(right.scopeBinding);
}

export function findSoftwareJobInDocument(document, jobId) {
  const job = softwareJobsInDocument(document).find((entry) => entry.jobId === jobId) || null;
  assertSoftwareJobPreparationEvidence(job);
  return job;
}

function assertSoftwareJobPreparationEvidence(job) {
  if (job && Object.hasOwn(job, "preparationEvidence")) {
    if (job.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || job.attempt !== 1 || job.status === "queued") {
      throw new Error("SOFTWARE_JOB_PREPARATION_SOURCE_CONFLICT");
    }
    const original=job.preparationEvidence;
    if(job.platformContinuation?.schemaVersion==='d-platform-continuation-v1'){
      if(original.status!=='ready'||original.continuationBlocked!==false||!original.completedAt||original.result?.capabilities?.adapterVersion!=='ozon-seller-api-de-adapter-v3'||original.result.capabilities.protocolVersion!=='ozon-single-sku-d-e-v3')throw new Error('SOFTWARE_JOB_PREPARATION_SOURCE_CONFLICT');
    }
    // 续写会换租约，准备证据仍记着当初的持有者；交叉校验已不比对 workerId/leaseId，
    // 所以这里不必再把 job 的持有者替换成证据里的（原替换写法已删）。
    assertDProductionPreparation(original,{job});
  }
}

export function enqueueSoftwareJobInDocument(document, job) {
  assertSoftwareJobPreparationEvidence(job);
  assertSafeRuntimeRecord(job, "softwareJob");
  const jobs = softwareJobsInDocument(document);
  const existing = jobs.find((entry) => entry.idempotencyKey === job.idempotencyKey);
  if (existing) {
    if (!sameSoftwareJobIdentity(existing, job)) throw new Error("SOFTWARE_JOB_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ changed: false, job: structuredClone(existing) });
  }
  if (jobs.some((entry) => entry.jobId === job.jobId)) throw new Error("SOFTWARE_JOB_ID_CONFLICT");
  jobs.push(structuredClone(job));
  return Object.freeze({ changed: true, job: structuredClone(job) });
}

function settleSoftwareJobInDocumentCore(document, settlement, serverTime, { domainSettlementValidated = false } = {}) {
  const jobs = softwareJobsInDocument(document);
  const index = jobs.findIndex((entry) => entry.jobId === settlement.jobId);
  if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
  const next = settleSoftwareJobCore({
    job: jobs[index],
    workerId: settlement.workerId,
    leaseId: settlement.leaseId,
    status: settlement.status,
    externalRequestState: settlement.externalRequestState,
    resultRef: settlement.resultRef,
    resultEnvelope: settlement.resultEnvelope,
    applicationDisposition: settlement.applicationDisposition,
    failureClass: settlement.failureClass,
    externalRequestRef: settlement.externalRequestRef,
    serverTime,
    domainSettlementValidated
  });
  jobs[index] = structuredClone(next);
  return next;
}

export function settleSoftwareJobInDocument(document, settlement, serverTime) {
  return settleSoftwareJobInDocumentCore(document, settlement, serverTime);
}

/** D terminal data must already be present in this same transaction; generic callers cannot supply a completion. */
export function settleDProductionSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  const candidate = document.candidates?.find(entry => entry.id === job?.candidateId);
  const terminal = readDProductionJobTerminal({ candidate, job, observedAt });
  if (isReconciledDERequest(job)) {
    issuedRequestTerminalTime(job, { workerId, leaseId, serverTime: observedAt });
    if (Date.parse(observedAt) < Date.parse(job.completedAt)) throw new Error("DE_JOB_RESULT_TIME_CONFLICT");
    return Object.freeze({ job: structuredClone(job), eScope: null, reconciliationRequired: true });
  }
  const resultEnvelope = terminal.payload === null ? null : createSoftwareJobResultEnvelope({ job,
    resultRef: `d-production-result:${fingerprintCanonicalRecord(terminal.payload)}`, payloadKind: job.jobType,
    payload: terminal.payload, recordedAt: observedAt, applicationDisposition: terminal.applicationDisposition });
  const settled = settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, status: terminal.status,
    externalRequestState: terminal.externalRequestState, resultRef: resultEnvelope?.resultRef ?? null,
    resultEnvelope, applicationDisposition: terminal.applicationDisposition, failureClass: terminal.failureClass,
    externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
  return Object.freeze({ job: settled, eScope: terminal.eScope });
}

/** The independent history must be saved in the same transaction before recording the E job's outcome. */
export function settleEReadbackSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  const candidate = document.candidates?.find(entry => entry.id === job?.candidateId);
  const terminal = readEReadbackJobTerminal({ candidate, job, observedAt });
  if (isReconciledDERequest(job)) {
    issuedRequestTerminalTime(job, { workerId, leaseId, serverTime: observedAt });
    if (Date.parse(observedAt) < Date.parse(job.completedAt)) throw new Error("DE_JOB_RESULT_TIME_CONFLICT");
    return structuredClone(job);
  }
  const resultEnvelope = terminal.payload === null ? null : createSoftwareJobResultEnvelope({ job,
    resultRef: `e-readback-result:${fingerprintCanonicalRecord(terminal.payload)}`, payloadKind: job.jobType,
    payload: terminal.payload, recordedAt: observedAt, applicationDisposition: terminal.applicationDisposition });
  return settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, status: terminal.status,
    externalRequestState: terminal.externalRequestState, resultRef: resultEnvelope?.resultRef ?? null,
    resultEnvelope, applicationDisposition: terminal.applicationDisposition, failureClass: terminal.failureClass,
    externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
}

/** OSS is a step of the original D job, so a verified receipt records progress rather than a second job. */
export function settleDAssetTransportSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  const candidate = document.candidates?.find(entry => entry.id === job?.candidateId);
  const terminal = readDAssetTransportJobTerminal({ candidate, job, observedAt });
  issuedRequestTerminalTime(job, { workerId, leaseId, serverTime: observedAt });
  if (isReconciledDERequest(job)) {
    if (Date.parse(observedAt) < Date.parse(job.completedAt)) throw new Error("DE_JOB_RESULT_TIME_CONFLICT");
    return Object.freeze({ job: structuredClone(job), continuationBlocked: true, reconciliationRequired: true });
  }
  if (terminal.status === "progress") {
    const next = { ...structuredClone(job), lastProgressAt: observedAt,
      progressRef: `d-assets:${job.scopeBinding.authorizationFingerprint}:verified` };
    assertSafeRuntimeRecord(next, "softwareJob");
    const jobs = softwareJobsInDocument(document), index = jobs.findIndex(entry => entry.jobId === jobId);
    jobs[index] = next;
    return Object.freeze({ job: structuredClone(next), continuationBlocked: false, reconciliationRequired: false });
  }
  const settled = settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, status: terminal.status,
    externalRequestState: terminal.externalRequestState, failureClass: terminal.failureClass,
    externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
  return Object.freeze({ job: settled, continuationBlocked: true, reconciliationRequired: false });
}

export function settleDPreparationSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  const candidate = document.candidates?.find(entry => entry.id === job?.candidateId);
  const terminal = readDPreparationJobTerminal({ document, candidate, job, observedAt });
  issuedRequestTerminalTime(job, { workerId, leaseId, serverTime: observedAt });
  if (isReconciledDERequest(job)) {
    if (Date.parse(observedAt) < Date.parse(job.completedAt)) throw new Error("DE_JOB_RESULT_TIME_CONFLICT");
    return Object.freeze({ job: structuredClone(job), continuationBlocked: true, reconciliationRequired: true });
  }
  if (terminal.status === "progress") {
    const next = { ...structuredClone(job), lastProgressAt: observedAt,
      progressRef: `d-preparation:${job.scopeBinding.authorizationFingerprint}:ready` };
    assertSafeRuntimeRecord(next, "softwareJob");
    const jobs = softwareJobsInDocument(document), index = jobs.findIndex(entry => entry.jobId === jobId);
    jobs[index] = next;
    return Object.freeze({ job: structuredClone(next), continuationBlocked: false, reconciliationRequired: false });
  }
  const settled = settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, status: terminal.status,
    externalRequestState: terminal.externalRequestState, failureClass: terminal.failureClass,
    externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
  return Object.freeze({ job: settled, continuationBlocked: true, reconciliationRequired: false });
}

const D_PRE_SEND_STOP_FAILURE_CLASS = /^d-production-guard-rejected:[A-Z][A-Z0-9_]{1,100}$/;

/**
 * Closes a D job that was claimed and then rejected by a guard before any execution intent, external request or
 * domain write existed. The holder check below is the proof that nothing was sent: every external request first
 * persists `markSoftwareJobExternalRequestStarted`, and every domain step first persists its own state. The lease
 * may already have expired — recording a terminal failure is a safe stop, never a renewed lease or a retry.
 */
export function settleDProductionPreSendStopInDocument(document, { jobId, workerId, leaseId, failureClass }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  const sku = document.candidates?.find(entry => entry.id === job?.candidateId)?.lifecycleV11?.skuPackage;
  if (job?.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || job.status !== "claimed" || job.attempt !== 1 ||
      job.externalRequestState !== "not_sent" || job.externalRequestRef !== null || job.completedAt !== null ||
      job.resultRef !== null || job.resultEnvelope !== null || Object.hasOwn(job, "preparationEvidence") ||
      (job.platformContinuation ?? null) !== null || typeof failureClass !== "string" ||
      !D_PRE_SEND_STOP_FAILURE_CLASS.test(failureClass) ||
      !sku || (sku.dAssetTransport ?? null) !== null || (sku.dSoftwareExecution ?? null) !== null || sku.productionRecord !== null) {
    throw new Error("SOFTWARE_JOB_D_PRE_SEND_STOP_INVALID");
  }
  return settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, status: "failed",
    externalRequestState: "not_sent", failureClass, externalRequestRef: null }, observedAt,
    { domainSettlementValidated: true });
}

export function settleDPlatformStoppedSoftwareJobInDocument(document,{candidate,jobId,interruptedInventory=false},observedAt){
  const job=findSoftwareJobInDocument(document,jobId);
  if(job?.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE||(interruptedInventory?job.status!=='claimed'||job.externalRequestState!=='not_sent'||candidate.lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation.status!=='inventory_not_sent_interrupted':job.status!=='waiting_platform'||job.externalRequestState!=='succeeded'||job.leaseId!==null||job.leaseExpiresAt!==null))throw new Error('SOFTWARE_JOB_D_PLATFORM_STOP_INVALID');
  const terminal=readDPlatformStoppedJobTerminal({candidate,job,observedAt});
  return persistDPlatformStoppedJob(document,job,terminal,observedAt);
}

/**
 * 登记档结算：作业记 completed，但回执里明写没有库存写入回执、没有生产记录、没有排 E。
 * 与 stopped 档共用落盘逻辑，只是结果前缀不同——两者都不产生 productionRecord。
 */
export function settleDOwnerStockRegisteredSoftwareJobInDocument(document,{candidate,jobId},observedAt){
  const job=findSoftwareJobInDocument(document,jobId);
  if(job?.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE||job.status!=='waiting_platform'||
    job.externalRequestState!=='succeeded'||job.leaseId!==null||job.leaseExpiresAt!==null){
    throw new Error('SOFTWARE_JOB_D_OWNER_STOCK_INVALID');
  }
  const terminal=readDOwnerStockRegisteredJobTerminal({candidate,job,observedAt});
  return persistDPlatformStoppedJob(document,job,terminal,observedAt,'d-owner-stock-registered');
}

function persistDPlatformStoppedJob(document,job,terminal,observedAt,prefix='d-platform-stop'){
  const resultRef=`${prefix}:${fingerprintCanonicalRecord(terminal.payload)}`;
  const resultEnvelope=createSoftwareJobResultEnvelope({job,resultRef,payloadKind:job.jobType,payload:terminal.payload,
    externalRequestState:terminal.externalRequestState,recordedAt:observedAt});
  const next={...structuredClone(job),status:terminal.status,externalRequestState:terminal.externalRequestState,
    completedAt:observedAt,lastProgressAt:observedAt,failureClass:terminal.failureClass,resultRef,resultEnvelope};
  assertSafeRuntimeRecord(next,'softwareJob');
  const jobs=softwareJobsInDocument(document);jobs[jobs.findIndex(value=>value.jobId===job.jobId)]=next;
  return next;
}

/** A late initial acceptance is recorded by its original holder; this grants no new lease or observation. */
export function settleDInitialImportStoppedSoftwareJobInDocument(document,{jobId,workerId,leaseId},observedAt){
  const job=findSoftwareJobInDocument(document,jobId);
  if(job?.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE||job.status!=='waiting_platform'||job.externalRequestState!=='in_flight'||
    job.attempt!==1||job.completedAt!==null)throw new Error('SOFTWARE_JOB_D_INITIAL_IMPORT_STOP_INVALID');
  const completedAt=issuedRequestTerminalTime(job,{workerId,leaseId,serverTime:observedAt});
  const candidate=document.candidates.find(value=>value.id===job.candidateId);
  const terminal=readDInitialImportStoppedJobTerminal({candidate,job,observedAt:completedAt});
  if(terminal.status!=='failed'||terminal.externalRequestState!=='succeeded')throw new Error('SOFTWARE_JOB_D_INITIAL_IMPORT_STOP_INVALID');
  const source={...structuredClone(job),platformContinuation:structuredClone(candidate.lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation)};
  return persistDPlatformStoppedJob(document,source,terminal,completedAt);
}

export function settleDPlatformObservationSoftwareJobInDocument(document,{jobId,workerId,leaseId},observedAt){
  const job=findSoftwareJobInDocument(document,jobId);
  const terminal=readDPlatformObservationJobTerminal({document,job,observedAt});
  const resultRef=`d-observation-result:${job.scopeBinding.inputFingerprint}`;
  const resultEnvelope=createSoftwareJobResultEnvelope({job,resultRef,payloadKind:D_PLATFORM_OBSERVATION_JOB_TYPE,payload:terminal.payload,
    externalRequestState:terminal.externalRequestState,recordedAt:observedAt});
  if(job.status==='queued'){
    const completedAt=iso(observedAt,'observedAt');
    if(job.attempt!==0||job.workerId!==null||job.leaseId!==null||job.leaseExpiresAt!==null||job.externalRequestState!=='not_sent'||job.externalRequestRef!==null||
      terminal.status!=='failed'||terminal.externalRequestState!=='not_sent'||terminal.disposition!=='blocked'||
      Date.parse(completedAt)<Date.parse(iso(job.createdAt,'createdAt')))throw new Error('SOFTWARE_JOB_OBSERVATION_REJECTION_INVALID');
    const settled={...structuredClone(job),status:'failed',completedAt,lastProgressAt:completedAt,failureClass:terminal.failureClass,resultRef,resultEnvelope};
    assertSafeRuntimeRecord(settled,'softwareJob');
    const jobs=softwareJobsInDocument(document);jobs[jobs.findIndex(value=>value.jobId===jobId)]=settled;
    return {job:settled,terminal};
  }
  const settled=settleSoftwareJobInDocumentCore(document,{jobId,workerId,leaseId,status:terminal.status,externalRequestState:terminal.externalRequestState,
    failureClass:terminal.failureClass,resultRef,resultEnvelope,applicationDisposition:terminal.applicationDisposition,externalRequestRef:job.externalRequestRef},observedAt,{domainSettlementValidated:true});
  return {job:settled,terminal};
}

export function createADiscoveryJobForScope({ scope, ownerUserId, createdAt }) {
  scope = assertADiscoveryScope(scope);
  const key = `a-discovery:${scope.batchId}:${scope.resultRevision}:${scope.requestIndex}`;
  return createSoftwareJobEnvelope({ jobId: key, subject: { kind: "discovery_batch", batchId: scope.batchId, revision: scope.resultRevision },
    revision: scope.resultRevision, jobType: A_DISCOVERY_JOB_TYPE, createdAt, requestedByUserId: ownerUserId,
    ownerUserId, requiredCapabilities: [getADiscoveryCapability(scope)], idempotencyKey: key, scopeBinding: scope });
}
export function assertCompletedADiscoveryJobResult({ job, receipt }) {
  if (!isADiscoverySoftwareJob(job)) throw new Error("A_DISCOVERY_JOB_REQUIRED");
  const terminal = readADiscoveryTerminal(receipt, job);
  if (terminal.status !== "completed" || job.status !== "completed" || job.externalRequestState !== "succeeded" ||
      job.resultRef !== receipt.receiptId || job.completedAt !== receipt.completedAt) {
    throw new Error("A_DISCOVERY_COMPLETED_RESULT_CONFLICT");
  }
  const expected = createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId,
    payloadKind: A_DISCOVERY_JOB_TYPE, payload: { schemaVersion: "a-discovery-job-result-v1", receiptRef: receipt.receiptId,
      scopeFingerprint: fingerprintCanonicalRecord(receipt.scope) }, recordedAt: receipt.completedAt });
  if (!isDeepStrictEqual(job.resultEnvelope, expected)) throw new Error("A_DISCOVERY_COMPLETED_RESULT_CONFLICT");
  return structuredClone(expected);
}
export function settleADiscoverySoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  if (!isADiscoverySoftwareJob(job)) throw new Error("A_DISCOVERY_JOB_REQUIRED");
  const receipt = document.runtime.aDiscoveryReceipts?.[jobId];
  const terminal = readADiscoveryTerminal(receipt, job);
  const resultEnvelope = terminal.status === "completed" ? createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId,
    payloadKind: A_DISCOVERY_JOB_TYPE, payload: { schemaVersion: "a-discovery-job-result-v1", receiptRef: receipt.receiptId,
      scopeFingerprint: fingerprintCanonicalRecord(receipt.scope) }, recordedAt: observedAt }) : null;
  return settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, ...terminal, resultEnvelope,
    resultRef: resultEnvelope?.resultRef ?? null, externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
}

export function createAProductDetailJobForScope({ scope, ownerUserId, createdAt }) {
  scope = assertAProductDetailScope(scope);
  const key = `a-product-detail:${scope.candidateId}:${scope.resultRevision}:${scope.requestIndex}`;
  return createSoftwareJobEnvelope({ jobId: key, subject: { kind: "a_candidate", candidateId: scope.candidateId, revision: scope.resultRevision },
    revision: scope.resultRevision, jobType: A_PRODUCT_DETAIL_JOB_TYPE, createdAt, requestedByUserId: ownerUserId,
    ownerUserId, requiredCapabilities: [A_PRODUCT_DETAIL_CAPABILITY], idempotencyKey: key, scopeBinding: scope });
}
export function assertCompletedAProductDetailJobResult({ job, receipt }) {
  if (!isAProductDetailSoftwareJob(job)) throw new Error("A_PRODUCT_DETAIL_JOB_REQUIRED");
  const terminal = readAProductDetailTerminal(receipt, job);
  if (terminal.status !== "completed" || job.status !== "completed" || job.externalRequestState !== "succeeded" ||
      job.resultRef !== receipt.receiptId || job.completedAt !== receipt.completedAt) {
    throw new Error("A_PRODUCT_DETAIL_COMPLETED_RESULT_CONFLICT");
  }
  const expected = createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId,
    payloadKind: A_PRODUCT_DETAIL_JOB_TYPE, payload: { schemaVersion: "a-product-detail-job-result-v1", receiptRef: receipt.receiptId,
      scopeFingerprint: fingerprintCanonicalRecord(receipt.scope) }, recordedAt: receipt.completedAt });
  if (!isDeepStrictEqual(job.resultEnvelope, expected)) throw new Error("A_PRODUCT_DETAIL_COMPLETED_RESULT_CONFLICT");
  return structuredClone(expected);
}
export function settleAProductDetailSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  if (!isAProductDetailSoftwareJob(job)) throw new Error("A_PRODUCT_DETAIL_JOB_REQUIRED");
  const receipt = document.runtime.aProductDetailReceipts?.[jobId];
  const terminal = readAProductDetailTerminal(receipt, job);
  const resultEnvelope = terminal.status === "completed" ? createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId,
    payloadKind: A_PRODUCT_DETAIL_JOB_TYPE, payload: { schemaVersion: "a-product-detail-job-result-v1", receiptRef: receipt.receiptId,
      scopeFingerprint: fingerprintCanonicalRecord(receipt.scope) }, recordedAt: observedAt }) : null;
  return settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, ...terminal, resultEnvelope,
    resultRef: resultEnvelope?.resultRef ?? null, externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
}

export function createASupplierImageSearchJobForScope({ scope, ownerUserId, createdAt }) {
  scope = assertASupplierImageSearchScope(scope);
  const key = `a-supplier-image-search:${scope.candidateId}:${scope.resultRevision}`;
  return createSoftwareJobEnvelope({ jobId: key, subject: { kind: "a_candidate", candidateId: scope.candidateId, revision: scope.resultRevision },
    revision: scope.resultRevision, jobType: A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, createdAt, requestedByUserId: ownerUserId,
    ownerUserId, requiredCapabilities: [A_SUPPLIER_IMAGE_SEARCH_CAPABILITY], idempotencyKey: key, scopeBinding: scope });
}
export function assertCompletedASupplierImageSearchJobResult({ job, receipt }) {
  if (!isASupplierImageSearchSoftwareJob(job)) throw new Error("A_SUPPLIER_IMAGE_SEARCH_JOB_REQUIRED");
  const terminal = readASupplierImageSearchTerminal(receipt, job);
  if (terminal.status !== "completed" || job.status !== "completed" || job.externalRequestState !== "succeeded" ||
      job.resultRef !== receipt.receiptId || job.completedAt !== receipt.completedAt) {
    throw new Error("A_SUPPLIER_IMAGE_SEARCH_COMPLETED_RESULT_CONFLICT");
  }
  const expected = createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId,
    payloadKind: A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, payload: { schemaVersion: "a-supplier-image-search-job-result-v1", receiptRef: receipt.receiptId,
      scopeFingerprint: fingerprintCanonicalRecord(receipt.scope) }, recordedAt: receipt.completedAt });
  if (!isDeepStrictEqual(job.resultEnvelope, expected)) throw new Error("A_SUPPLIER_IMAGE_SEARCH_COMPLETED_RESULT_CONFLICT");
  return structuredClone(expected);
}
export function settleASupplierImageSearchSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job = findSoftwareJobInDocument(document, jobId);
  if (!isASupplierImageSearchSoftwareJob(job)) throw new Error("A_SUPPLIER_IMAGE_SEARCH_JOB_REQUIRED");
  const receipt = document.runtime.aSupplierImageSearchReceipts?.[jobId];
  const terminal = readASupplierImageSearchTerminal(receipt, job);
  const resultEnvelope = terminal.status === "completed" ? createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId,
    payloadKind: A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, payload: { schemaVersion: "a-supplier-image-search-job-result-v1", receiptRef: receipt.receiptId,
      scopeFingerprint: fingerprintCanonicalRecord(receipt.scope) }, recordedAt: observedAt }) : null;
  return settleSoftwareJobInDocumentCore(document, { jobId, workerId, leaseId, ...terminal, resultEnvelope,
    resultRef: resultEnvelope?.resultRef ?? null, externalRequestRef: job.externalRequestRef }, observedAt, { domainSettlementValidated: true });
}

export function settleOzonAccountReadSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt) {
  const job=findSoftwareJobInDocument(document,jobId);
  if(job?.jobType!==OZON_ACCOUNT_READ_JOB_TYPE)throw new Error('OZON_ACCOUNT_READ_JOB_REQUIRED');
  const receipt=document.runtime.ozonAccountReadReceipts?.[jobId];
  const terminal=readOzonAccountReadTerminal(receipt,job);
  const resultEnvelope=terminal.status==='completed'?createSoftwareJobResultEnvelope({job,resultRef:receipt.receiptId,
    payloadKind:OZON_ACCOUNT_READ_JOB_TYPE,payload:{schemaVersion:'ozon-account-read-job-result-v1',receiptRef:receipt.receiptId,scopeFingerprint:receipt.scope.inputFingerprint},
    recordedAt:observedAt}):null;
  return settleSoftwareJobInDocumentCore(document,{jobId,workerId,leaseId,...terminal,resultEnvelope,
    resultRef:resultEnvelope?.resultRef??null,externalRequestRef:job.externalRequestRef},observedAt,{domainSettlementValidated:true});
}

export function settleC1PaidKeywordEvidenceSoftwareJobInDocument(document, settlement, serverTime) {
  const job = findSoftwareJobInDocument(document, settlement.jobId);
  if (!job) throw new Error("SOFTWARE_JOB_NOT_FOUND");
  if (job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      job.scopeBinding?.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_CONTEXT_INVALID");
  }
  if (settlement.status !== "completed" || settlement.resultEnvelope?.payloadKind !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_COMPLETED_REQUIRED");
  }
  return settleSoftwareJobInDocumentCore(document, settlement, serverTime, { domainSettlementValidated: true });
}

/** Frozen enqueue input is evidence for recording a stopped attempt, never authority to send again. */
export function readC1PaidKeywordSourceForSettlement(document, job) {
  if (job?.schemaVersion !== "software-job-v1" || job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    throw new Error("C1_PAID_KEYWORD_SOURCE_INVALID");
  }
  normalizeC1ScopeBinding(job.scopeBinding, job);
  const records = document.runtime?.idempotencyRecords?.filter(record =>
    record.action === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && record.candidateId === job.candidateId &&
    record.result?.softwareJobRef?.jobId === job.jobId);
  if (!records || records.length !== 1) throw new Error("C1_PAID_KEYWORD_FROZEN_SOURCE_REQUIRED");
  const record = records[0], candidate = record.candidateSnapshot, lifecycle = candidate?.lifecycleV11;
  const ref = lifecycle?.c1PaidKeywordEvidenceJobRefV1, artifact = lifecycle?.c1PaidKeywordEvidenceInputArtifactRefV1;
  const scope = job.scopeBinding;
  if (!candidate || candidate.id !== job.candidateId || candidate.dataRevision !== job.revision ||
      lifecycle?.skuPackage?.skuPackageId !== job.skuPackageId ||
      record.sourceRevision !== scope.sourceRevision || record.resultRevision !== job.revision ||
      record.idempotencyKey !== job.idempotencyKey || record.skuPackageId !== job.skuPackageId ||
      !ref || ref.jobId !== job.jobId || ref.jobType !== job.jobType || ref.candidateId !== job.candidateId ||
      ref.skuPackageId !== job.skuPackageId || ref.sourceRevision !== scope.sourceRevision ||
      ref.resultRevision !== job.revision || ref.inputFingerprint !== scope.inputFingerprint ||
      artifact?.schemaVersion !== "c1-paid-keyword-evidence-input-artifact-ref-v1" || artifact.immutable !== true ||
      artifact.jobId !== job.jobId || artifact.jobType !== job.jobType || artifact.candidateId !== job.candidateId ||
      artifact.skuPackageId !== job.skuPackageId || artifact.sourceRevision !== scope.sourceRevision || artifact.resultRevision !== job.revision ||
      artifact.runtimeInputFingerprint !== scope.runtimeInputFingerprint || artifact.seerfarRequestFingerprint !== scope.seerfarRequestFingerprint ||
      !lifecycle.c1PaidKeywordEvidenceRuntimeInputV1 || !lifecycle.c1PaidKeywordEvidenceSeerfarRequestV1 ||
      fingerprintCanonicalRecord(lifecycle.c1PaidKeywordEvidenceRuntimeInputV1) !== scope.runtimeInputFingerprint ||
      fingerprintCanonicalRecord(lifecycle.c1PaidKeywordEvidenceSeerfarRequestV1) !== scope.seerfarRequestFingerprint) {
    throw new Error("C1_PAID_KEYWORD_SOURCE_CONFLICT");
  }
  return { candidate, jobRef: ref, inputArtifactRef: artifact };
}

/** Only a failed original keyword attempt may record after its lease; generic settlement stays strict. */
export function settleC1PaidKeywordFailureSoftwareJobInDocument(document, settlement, serverTime) {
  const job = findSoftwareJobInDocument(document, settlement.jobId);
  readC1PaidKeywordSourceForSettlement(document, job);
  if (job.attempt !== 1 || !["failed", "unknown_outcome"].includes(settlement.status) ||
      !["claimed", "waiting_platform"].includes(job.status) ||
      settlement.resultRef != null || settlement.resultEnvelope != null) throw new Error("C1_PAID_KEYWORD_FAILURE_INVALID");
  issuedRequestTerminalTime(job, { ...settlement, serverTime });
  const next = settleSoftwareJobCore({ ...settlement, job, serverTime, domainSettlementValidated: false,
    c1KeywordFailureValidated: true });
  const jobs = softwareJobsInDocument(document);
  jobs[jobs.findIndex(entry => entry.jobId === job.jobId)] = structuredClone(next);
  return next;
}

export function readC2StableAssetTransportSourceForSettlement(document, job) {
  const records = document.runtime?.idempotencyRecords?.filter(entry =>
    entry.action === "enqueue_c2_stable_asset_transport" && entry.candidateId === job.candidateId &&
    entry.result?.softwareJobRef?.jobId === job.jobId
  );
  if (!records || records.length !== 1) throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_FROZEN_SOURCE_REQUIRED");
  const record = records[0];
  const candidate = record.candidateSnapshot;
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  const jobRef = skuPackage?.c2FinalAssets?.stableAssetTransport?.jobRef;
  const identity = skuPackage?.g1Identity;
  const transport = skuPackage?.c2FinalAssets?.stableAssetTransport;
  if (!candidate || !skuPackage || !jobRef ||
      candidate.id !== job.candidateId || candidate.dataRevision !== job.revision ||
      identity?.candidateId !== job.candidateId || identity?.skuPackageId !== job.skuPackageId ||
      identity?.platform !== job.scopeBinding?.platform || !isDeepStrictEqual(identity?.storeRef, job.scopeBinding?.storeRef) ||
      identity?.supplierSkuId !== job.scopeBinding?.supplierSkuId || skuPackage.variantKey !== job.scopeBinding?.variantKey ||
      transport.stagedAssetManifestFingerprint !== job.scopeBinding?.stagedAssetManifestFingerprint ||
      transport.ownerStagingConfirmation?.confirmationRef !== job.scopeBinding?.ownerStagingConfirmationRef ||
      record.sourceRevision !== job.scopeBinding?.sourceRevision || record.resultRevision !== job.revision ||
      record.inputFingerprint !== job.scopeBinding?.inputFingerprint ||
      jobRef.jobId !== job.jobId || jobRef.jobType !== job.jobType ||
      jobRef.candidateId !== job.candidateId || jobRef.skuPackageId !== job.skuPackageId ||
      jobRef.sourceRevision !== job.scopeBinding?.sourceRevision ||
      jobRef.resultRevision !== job.revision ||
      jobRef.inputFingerprint !== job.scopeBinding?.inputFingerprint) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_CONTEXT_INVALID");
  }
  return { skuPackage, jobRef };
}

export function isC2StableAssetTransportReconciledRequest(job) {
  return job?.schemaVersion === "software-job-v1" && job.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE &&
    job.status === "unknown_outcome" && job.externalRequestState === "unknown_outcome" && job.attempt === 1 &&
    ["service_restart_after_external_request", "lease_expired_after_external_request"].includes(job.failureClass) &&
    typeof job.externalRequestRef === "string" && job.externalRequestRef.length > 0 &&
    job.resultRef === null && job.resultEnvelope === null && typeof job.completedAt === "string";
}

function readPersistedC2RequestStartedAt(job) {
  const waitingRequest = job.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE &&
    job.status === "waiting_platform" && job.externalRequestState === "in_flight";
  if (!waitingRequest && !isC2StableAssetTransportReconciledRequest(job)) {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_REJECTED: 缺少已发请求或可追溯未知终态");
  }
  strictRef(job.externalRequestRef, "externalRequestRef");
  // Waiting jobs cannot record further progress, so this is the request start.
  // New reconciliations preserve it and bind the progress step to that request.
  if (waitingRequest || job.progressRef === job.externalRequestRef) return iso(job.lastProgressAt, "lastProgressAt");
  // Historical reconciliation overwrote the timestamp. Preserve the explicit gap.
  return null;
}

function validateC2StableAssetTransportJobResult(document, settlement, serverTime) {
  const jobs = softwareJobsInDocument(document);
  const job = jobs.find((entry) => entry.jobId === settlement.jobId);
  if (!job) throw new Error("SOFTWARE_JOB_NOT_FOUND");
  if (!softwareJobRequiresDomainSettlement(job)) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_NOT_REQUIRED");
  }
  if (settlement.status !== "completed") {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_COMPLETED_REQUIRED");
  }
  assertBoundedResultEnvelopeStructure(settlement.resultEnvelope, "softwareJob.domainSettlement.resultEnvelope");
  const observedAt = issuedRequestTerminalTime(job, { ...settlement, serverTime });
  const envelope = normalizeResultEnvelope(settlement.resultEnvelope, job, settlement.applicationDisposition ?? "result_recorded_no_candidate_mutation");
  if (settlement.externalRequestState !== "succeeded" || settlement.externalRequestRef !== job.externalRequestRef ||
      (settlement.resultRef !== null && settlement.resultRef !== undefined && settlement.resultRef !== envelope.resultRef)) {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_REJECTED: 回执不得覆盖原请求身份");
  }
  const reconciled = isC2StableAssetTransportReconciledRequest(job);
  const requestStartedAt = readPersistedC2RequestStartedAt(job);
  const earliestKnownTime = requestStartedAt ?? iso(job.startedAt, "startedAt");
  if (Date.parse(envelope.payload.verifiedAt) < Date.parse(earliestKnownTime) ||
      Date.parse(envelope.recordedAt) < Date.parse(earliestKnownTime)) {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_BEFORE_REQUEST");
  }
  if (reconciled && Date.parse(observedAt) < Date.parse(iso(job.completedAt, "completedAt"))) {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_REJECTED: 对账证据登记时间不得倒退");
  }
  const { skuPackage, jobRef } = readC2StableAssetTransportSourceForSettlement(document, job);
  validateC2StableAssetTransportResult({
    skuPackage,
    jobRef,
    transportResultEnvelope: {
      ...structuredClone(envelope),
      applicationDisposition: "applied"
    },
    allowedStableAssetHosts: job.scopeBinding.allowedStableAssetHosts,
    settledAt: serverTime
  });
  return { job, envelope, requestStartedAt };
}

export function validateC2StableAssetTransportReconciliationEvidence(document, settlement, serverTime) {
  const job = findSoftwareJobInDocument(document, settlement.jobId);
  if (!isC2StableAssetTransportReconciledRequest(job) || settlement.applicationDisposition !== "result_recorded_no_candidate_mutation") {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_REJECTED: 必须绑定原未知终态，禁止自动应用");
  }
  const { envelope, requestStartedAt } = validateC2StableAssetTransportJobResult(document, settlement, serverTime);
  return { transportResultEnvelope: envelope, reconciliationRequestStartedAt: requestStartedAt };
}

export function settleC2StableAssetTransportSoftwareJobInDocument(document, settlement, serverTime) {
  validateC2StableAssetTransportJobResult(document, settlement, serverTime);
  return settleSoftwareJobInDocumentCore(document, settlement, serverTime, {
    domainSettlementValidated: true
  });
}
