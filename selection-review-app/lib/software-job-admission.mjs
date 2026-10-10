import { A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, assertASupplierImageSearchScope, assertASupplierImageSearchSource, assertASupplierImageSearchAuthorization, assertASupplierImageSearchCredential } from "./a-supplier-image-search-contract.mjs";
import { A_PRODUCT_DETAIL_JOB_TYPE, assertAProductDetailScope, assertAProductDetailCandidateSource, assertAProductDetailAuthorization, assertAProductDetailCredential } from "./a-product-detail-contract.mjs";
import { A_DISCOVERY_JOB_TYPE, assertADiscoveryScope, assertADiscoveryBatchSource,
  assertADiscoveryAuthorization, assertADiscoveryCredential } from "./a-discovery-contract.mjs";
import { D_PLATFORM_OBSERVATION_JOB_TYPE, assertDPlatformObservationScope, createDPlatformObservationAdmission } from './d-platform-observation-contract.mjs';
import { fingerprintCanonicalRecord, dProductionJobRound } from "./production-contract-primitives.mjs";
import { assertSafeRuntimeRecord, workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { legacyKeywordJobBlocksPaidExecution } from "./keyword-evidence-software-job-state.mjs";
import { normalizeC1SourceIdentity } from "./c1-product-plan.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { assertC1AiDraftPaymentAuthorization } from "./c1-ai-draft-contract.mjs";
import { assertCurrentC1AiDraftRequestSources } from "./c1-ai-draft-request-source.mjs";
import { isDESoftwareJob, deSoftwareJobScopeKey, createDEJobAdmissionDecision } from "./d-e-software-job-admission.mjs";
import { OZON_ACCOUNT_READ_JOB_TYPE, assertOzonAccountReadScope, assertOzonAccountReadSubject,
  assertOzonAccountReadAuthorization, assertOzonAccountReadCredential } from './ozon-account-read-contract.mjs';
import {
  C1_AI_DRAFT_JOB_TYPE,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER,
  C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
  SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE,
  assertSoftwareJobStrictRef,
  sameSoftwareJobIdentity, assertCompletedADiscoveryJobResult,
  isAccountPreparationSoftwareJob, isADiscoverySoftwareJob, isAProductDetailSoftwareJob, isASupplierImageSearchSoftwareJob,
  bindSoftwareJobAdmissionDecision,
  isReservedSoftwareJobHost,
  normalizeC1AiDraftScopeBinding,
  softwareJobsInDocument
} from "./software-job-contract.mjs";

export const SOFTWARE_JOB_ADMISSION_DECISION_VERSION = "software-job-admission-v1";
export const SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION = "software-job-authorization-record-v1";
export const SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION = "software-job-credential-binding-v1";
export { SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE };

const OCCUPYING_STATUSES = new Set(["queued", "claimed", "waiting_platform", "unknown_outcome"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label) {
  return assertSoftwareJobStrictRef(value, label);
}

function iso(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  return new Date(normalized).toISOString();
}

function sha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  return normalized;
}

function boundedVariantKey(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  return normalized;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeHosts(hosts, label) {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 16) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  const normalized = [...new Set(hosts.map((host) => String(host).trim().toLowerCase()))].sort();
  if (normalized.length !== hosts.length || normalized.some((host) =>
    host.length > 253 || !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) ||
    isReservedSoftwareJobHost(host))) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  return Object.freeze(normalized);
}

function assertUniqueNormalizedRecords(records, keys, code) {
  for (const key of keys) {
    const seen = new Set();
    for (const record of records) {
      const value = record[key];
      if (value === null || value === undefined) continue;
      if (seen.has(value)) throw new Error(code);
      seen.add(value);
    }
  }
}

function normalizeStoreRef(value, label) {
  if (!isObject(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["mappingVersion", "platformStoreId", "stableStoreId"])) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  return Object.freeze({
    stableStoreId: text(value.stableStoreId, `${label}.stableStoreId`),
    platformStoreId: text(value.platformStoreId, `${label}.platformStoreId`),
    mappingVersion: text(value.mappingVersion, `${label}.mappingVersion`)
  });
}

function runtimeCollection(document, key) {
  const value = document?.runtime?.[key];
  return Array.isArray(value) ? value : [];
}

export function softwareJobAuthorizationRecordsInDocument(document) {
  return runtimeCollection(document, "softwareJobAuthorizationRecords");
}

export function softwareJobCredentialBindingsInDocument(document) {
  return runtimeCollection(document, "softwareJobCredentialBindings");
}

function normalizeC2AuthorizationRecord(record) {
  const allowedKeys = [
    "schemaVersion", "authorizationId", "status", "action", "candidateId", "skuPackageId", "sourceRevision",
    "resultRevision", "platform", "storeRef", "supplierSkuId", "variantKey", "sideEffectScope",
    "stagedAssetManifestFingerprint", "ownerStagingConfirmationRef", "allowedStableAssetHosts",
    "authorizedByUserId", "authorizedAt", "expiresAt", "maxUses", "useCount", "consumedByJobId", "consumedAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION ||
      record.status !== "active" || record.action !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      record.sideEffectScope !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      !Number.isInteger(record.sourceRevision) || record.sourceRevision < 0 ||
      record.resultRevision !== record.sourceRevision + 1 ||
      record.maxUses !== 1 || ![0, 1].includes(record.useCount)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const consumedByJobId = record.consumedByJobId === null ? null : text(record.consumedByJobId, "authorization.consumedByJobId");
  const consumedAt = record.consumedAt === null ? null : iso(record.consumedAt, "authorization.consumedAt");
  if ((record.useCount === 0 && (consumedByJobId !== null || consumedAt !== null)) ||
      (record.useCount === 1 && (consumedByJobId === null || consumedAt === null))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION,
    authorizationId: text(record.authorizationId, "authorization.authorizationId"),
    status: "active",
    action: record.action,
    candidateId: text(record.candidateId, "authorization.candidateId"),
    skuPackageId: text(record.skuPackageId, "authorization.skuPackageId"),
    sourceRevision: record.sourceRevision,
    resultRevision: record.resultRevision,
    platform: text(record.platform, "authorization.platform"),
    storeRef: normalizeStoreRef(record.storeRef, "authorization.storeRef"),
    supplierSkuId: text(record.supplierSkuId, "authorization.supplierSkuId"),
    variantKey: boundedVariantKey(record.variantKey, "authorization.variantKey"),
    sideEffectScope: record.sideEffectScope,
    stagedAssetManifestFingerprint: sha256(record.stagedAssetManifestFingerprint, "authorization.stagedAssetManifestFingerprint"),
    ownerStagingConfirmationRef: text(record.ownerStagingConfirmationRef, "authorization.ownerStagingConfirmationRef"),
    allowedStableAssetHosts: normalizeHosts(record.allowedStableAssetHosts, "authorization.allowedStableAssetHosts"),
    authorizedByUserId: text(record.authorizedByUserId, "authorization.authorizedByUserId"),
    authorizedAt: iso(record.authorizedAt, "authorization.authorizedAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "authorization.expiresAt"),
    maxUses: 1,
    useCount: record.useCount,
    consumedByJobId,
    consumedAt
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.authorizationRecord");
  return normalized;
}

function normalizeC1AuthorizationRecord(record) {
  const allowedKeys = [
    "schemaVersion", "authorizationId", "status", "action", "authorizationSubject", "candidateId", "skuPackageId",
    "sourceRevision", "resultRevision", "platform", "targetStore", "supplierSkuId", "variantKey", "sideEffectScope",
    "provider", "credentialAlias", "inputFingerprint", "planningEvidenceFingerprint", "runtimeInputFingerprint",
    "seerfarRequestFingerprint", "salesSnapshotFingerprint", "supplySnapshotFingerprint", "profitModelFingerprint",
    "c1FactsFingerprint", "pointBudgetEvidenceRef", "quotaEvidenceRef", "pointsAuthorized", "authorizedByUserId",
    "authorizedAt", "expiresAt", "maxUses", "useCount", "consumedByJobId", "consumedAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION ||
      record.status !== "active" || record.action !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      record.provider !== C1_PAID_KEYWORD_PROVIDER ||
      record.authorizationSubject !== "c1_paid_keyword_evidence:seerfar_open_api_once" ||
      record.pointsAuthorized !== C1_PAID_KEYWORD_POINTS ||
      !Number.isInteger(record.sourceRevision) || record.sourceRevision < 0 ||
      record.resultRevision !== record.sourceRevision + 1 ||
      record.maxUses !== 1 || ![0, 1].includes(record.useCount)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const consumedByJobId = record.consumedByJobId === null ? null : text(record.consumedByJobId, "authorization.consumedByJobId");
  const consumedAt = record.consumedAt === null ? null : iso(record.consumedAt, "authorization.consumedAt");
  if ((record.useCount === 0 && (consumedByJobId !== null || consumedAt !== null)) ||
      (record.useCount === 1 && (consumedByJobId === null || consumedAt === null))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION,
    authorizationId: text(record.authorizationId, "authorization.authorizationId"),
    status: "active",
    action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationSubject: "c1_paid_keyword_evidence:seerfar_open_api_once",
    candidateId: text(record.candidateId, "authorization.candidateId"),
    skuPackageId: text(record.skuPackageId, "authorization.skuPackageId"),
    sourceRevision: record.sourceRevision,
    resultRevision: record.resultRevision,
    platform: text(record.platform, "authorization.platform"),
    targetStore: text(record.targetStore, "authorization.targetStore"),
    supplierSkuId: text(record.supplierSkuId, "authorization.supplierSkuId"),
    variantKey: boundedVariantKey(record.variantKey, "authorization.variantKey"),
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    provider: C1_PAID_KEYWORD_PROVIDER,
    credentialAlias: text(record.credentialAlias, "authorization.credentialAlias"),
    inputFingerprint: sha256(record.inputFingerprint, "authorization.inputFingerprint"),
    planningEvidenceFingerprint: sha256(record.planningEvidenceFingerprint, "authorization.planningEvidenceFingerprint"),
    runtimeInputFingerprint: sha256(record.runtimeInputFingerprint, "authorization.runtimeInputFingerprint"),
    seerfarRequestFingerprint: sha256(record.seerfarRequestFingerprint, "authorization.seerfarRequestFingerprint"),
    salesSnapshotFingerprint: sha256(record.salesSnapshotFingerprint, "authorization.salesSnapshotFingerprint"),
    supplySnapshotFingerprint: sha256(record.supplySnapshotFingerprint, "authorization.supplySnapshotFingerprint"),
    profitModelFingerprint: sha256(record.profitModelFingerprint, "authorization.profitModelFingerprint"),
    c1FactsFingerprint: sha256(record.c1FactsFingerprint, "authorization.c1FactsFingerprint"),
    pointBudgetEvidenceRef: text(record.pointBudgetEvidenceRef, "authorization.pointBudgetEvidenceRef"),
    quotaEvidenceRef: text(record.quotaEvidenceRef, "authorization.quotaEvidenceRef"),
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    authorizedByUserId: text(record.authorizedByUserId, "authorization.authorizedByUserId"),
    authorizedAt: iso(record.authorizedAt, "authorization.authorizedAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "authorization.expiresAt"),
    maxUses: 1,
    useCount: record.useCount,
    consumedByJobId,
    consumedAt
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.authorizationRecord");
  return normalized;
}

function c1AiDraftRecordScope(record) {
  const scope = record.scopeBinding;
  return normalizeC1AiDraftScopeBinding(scope, {
    candidateId: scope?.candidateId, skuPackageId: scope?.skuPackageId, revision: scope?.resultRevision
  });
}

function normalizeC1AiDraftAuthorizationRecord(record) {
  const fields = ["schemaVersion", "authorizationId", "authorizationType", "status", "action", "scopeBinding",
    "authorizedByUserId", "authorizedAt", "expiresAt", "maxUses", "useCount", "consumedByJobId", "consumedAt"];
  if (isObject(record) && Object.hasOwn(record, "paymentAuthorization")) fields.push("paymentAuthorization");
  if (!isObject(record) || Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field)) ||
      record.schemaVersion !== SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION || record.status !== "active" ||
      record.authorizationType !== "paid_ai_draft" || record.action !== C1_AI_DRAFT_JOB_TYPE ||
      record.maxUses !== 1 || ![0, 1].includes(record.useCount)) throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  const scopeBinding = c1AiDraftRecordScope(record);
  const consumedByJobId = record.consumedByJobId === null ? null : text(record.consumedByJobId, "authorization.consumedByJobId");
  const consumedAt = record.consumedAt === null ? null : iso(record.consumedAt, "authorization.consumedAt");
  if (record.authorizationId !== scopeBinding.authorizationRef ||
      (record.useCount === 0 && (consumedByJobId !== null || consumedAt !== null)) ||
      (record.useCount === 1 && (consumedByJobId === null || consumedAt === null))) throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION, authorizationId: record.authorizationId,
    authorizationType: "paid_ai_draft", status: "active", action: C1_AI_DRAFT_JOB_TYPE, scopeBinding,
    authorizedByUserId: text(record.authorizedByUserId, "authorization.authorizedByUserId"),
    authorizedAt: iso(record.authorizedAt, "authorization.authorizedAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "authorization.expiresAt"),
    maxUses: 1, useCount: record.useCount, consumedByJobId, consumedAt,
    ...(Object.hasOwn(record, "paymentAuthorization") ? { paymentAuthorization: assertC1AiDraftPaymentAuthorization(record.paymentAuthorization, { scopeBinding }) } : {})
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.authorizationRecord");
  return normalized;
}

function normalizeAuthorizationRecord(record) {
  if (record?.action === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE) return assertASupplierImageSearchAuthorization(record);
  if (record?.action === A_PRODUCT_DETAIL_JOB_TYPE) return assertAProductDetailAuthorization(record);
  if (record?.action === A_DISCOVERY_JOB_TYPE) return assertADiscoveryAuthorization(record);
  if (record?.action === OZON_ACCOUNT_READ_JOB_TYPE) return assertOzonAccountReadAuthorization(record);
  if (record?.action === C1_AI_DRAFT_JOB_TYPE) return normalizeC1AiDraftAuthorizationRecord(record);
  if (record?.action === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || record?.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    return normalizeC1AuthorizationRecord(record);
  }
  return normalizeC2AuthorizationRecord(record);
}

function normalizeC2CredentialBinding(record) {
  const allowedKeys = [
    "schemaVersion", "bindingId", "credentialAlias", "status", "provider", "platform", "storeRef",
    "sideEffectScope", "allowedStableAssetHosts", "allowedWorkerIds", "redaction", "boundAt", "expiresAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION ||
      record.status !== "active" || record.redaction !== "credential_alias_only" ||
      record.sideEffectScope !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      !Array.isArray(record.allowedWorkerIds) || record.allowedWorkerIds.length === 0 || record.allowedWorkerIds.length > 32) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  }
  const workerIds = [...new Set(record.allowedWorkerIds.map((workerId) => text(workerId, "credential.allowedWorkerIds")))].sort();
  if (workerIds.length !== record.allowedWorkerIds.length) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION,
    bindingId: text(record.bindingId, "credential.bindingId"),
    credentialAlias: text(record.credentialAlias, "credential.credentialAlias"),
    status: "active",
    provider: text(record.provider, "credential.provider"),
    platform: text(record.platform, "credential.platform"),
    storeRef: normalizeStoreRef(record.storeRef, "credential.storeRef"),
    sideEffectScope: record.sideEffectScope,
    allowedStableAssetHosts: normalizeHosts(record.allowedStableAssetHosts, "credential.allowedStableAssetHosts"),
    allowedWorkerIds: Object.freeze(workerIds),
    redaction: "credential_alias_only",
    boundAt: iso(record.boundAt, "credential.boundAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "credential.expiresAt")
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.credentialBinding");
  return normalized;
}

function normalizeC1CredentialBinding(record) {
  const allowedKeys = [
    "schemaVersion", "bindingId", "credentialAlias", "status", "provider", "platform", "targetStore",
    "sideEffectScope", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "inputFingerprint",
    "planningEvidenceFingerprint", "runtimeInputFingerprint", "seerfarRequestFingerprint", "allowedWorkerIds",
    "redaction", "boundAt", "expiresAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION ||
      record.status !== "active" || record.redaction !== "credential_alias_only" ||
      record.provider !== C1_PAID_KEYWORD_PROVIDER ||
      record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      !Number.isInteger(record.sourceRevision) || record.sourceRevision < 0 ||
      record.resultRevision !== record.sourceRevision + 1 ||
      !Array.isArray(record.allowedWorkerIds) || record.allowedWorkerIds.length === 0 || record.allowedWorkerIds.length > 32) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  }
  const workerIds = [...new Set(record.allowedWorkerIds.map((workerId) => text(workerId, "credential.allowedWorkerIds")))].sort();
  if (workerIds.length !== record.allowedWorkerIds.length) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION,
    bindingId: text(record.bindingId, "credential.bindingId"),
    credentialAlias: text(record.credentialAlias, "credential.credentialAlias"),
    status: "active",
    provider: C1_PAID_KEYWORD_PROVIDER,
    platform: text(record.platform, "credential.platform"),
    targetStore: text(record.targetStore, "credential.targetStore"),
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: text(record.candidateId, "credential.candidateId"),
    skuPackageId: text(record.skuPackageId, "credential.skuPackageId"),
    sourceRevision: record.sourceRevision,
    resultRevision: record.resultRevision,
    inputFingerprint: sha256(record.inputFingerprint, "credential.inputFingerprint"),
    planningEvidenceFingerprint: sha256(record.planningEvidenceFingerprint, "credential.planningEvidenceFingerprint"),
    runtimeInputFingerprint: sha256(record.runtimeInputFingerprint, "credential.runtimeInputFingerprint"),
    seerfarRequestFingerprint: sha256(record.seerfarRequestFingerprint, "credential.seerfarRequestFingerprint"),
    allowedWorkerIds: Object.freeze(workerIds),
    redaction: "credential_alias_only",
    boundAt: iso(record.boundAt, "credential.boundAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "credential.expiresAt")
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.credentialBinding");
  return normalized;
}

function normalizeC1AiDraftCredentialBinding(record) {
  const fields = ["schemaVersion", "bindingId", "credentialAlias", "status", "provider", "sideEffectScope", "scopeBinding",
    "allowedWorkerIds", "redaction", "boundAt", "expiresAt"];
  if (!isObject(record) || Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field)) ||
      record.schemaVersion !== SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION || record.status !== "active" ||
      record.sideEffectScope !== C1_AI_DRAFT_JOB_TYPE || record.redaction !== "credential_alias_only" ||
      !Array.isArray(record.allowedWorkerIds) || record.allowedWorkerIds.length === 0 || record.allowedWorkerIds.length > 32) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  }
  const scopeBinding = c1AiDraftRecordScope(record);
  const allowedWorkerIds = [...new Set(record.allowedWorkerIds.map(value => text(value, "credential.allowedWorkerIds")))].sort();
  if (allowedWorkerIds.length !== record.allowedWorkerIds.length || record.provider !== scopeBinding.provider ||
      record.credentialAlias !== scopeBinding.credentialAlias) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION, bindingId: text(record.bindingId, "credential.bindingId"),
    credentialAlias: scopeBinding.credentialAlias, status: "active", provider: scopeBinding.provider,
    sideEffectScope: C1_AI_DRAFT_JOB_TYPE, scopeBinding, allowedWorkerIds: Object.freeze(allowedWorkerIds),
    redaction: "credential_alias_only", boundAt: iso(record.boundAt, "credential.boundAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "credential.expiresAt")
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.credentialBinding");
  return normalized;
}

function normalizeCredentialBinding(record) {
  if (record?.sideEffectScope === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE) return assertASupplierImageSearchCredential(record);
  if (record?.sideEffectScope === A_PRODUCT_DETAIL_JOB_TYPE) return assertAProductDetailCredential(record);
  if (record?.sideEffectScope === A_DISCOVERY_JOB_TYPE) return assertADiscoveryCredential(record);
  if (record?.sideEffectScope === OZON_ACCOUNT_READ_JOB_TYPE) return assertOzonAccountReadCredential(record);
  if (record?.sideEffectScope === C1_AI_DRAFT_JOB_TYPE) return normalizeC1AiDraftCredentialBinding(record);
  if (record?.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || record?.provider === C1_PAID_KEYWORD_PROVIDER) {
    return normalizeC1CredentialBinding(record);
  }
  return normalizeC2CredentialBinding(record);
}

function assertScope(value) {
  if (!isObject(value) || value.schemaVersion !== "software-job-scope-v1") {
    throw new Error("SOFTWARE_JOB_ADMISSION_SCOPE_REQUIRED");
  }
  return value;
}

function scopeForJob(job) {
  if (isASupplierImageSearchSoftwareJob(job)) return assertASupplierImageSearchScope(job.scopeBinding, job);
  if (isAProductDetailSoftwareJob(job)) return assertAProductDetailScope(job.scopeBinding, job);
  if (isADiscoverySoftwareJob(job)) return assertADiscoveryScope(job.scopeBinding, job);
  return job.jobType === OZON_ACCOUNT_READ_JOB_TYPE ? assertOzonAccountReadScope(job.scopeBinding, job) : assertScope(job.scopeBinding);
}

function candidateForJob(document, job) {
  if (isASupplierImageSearchSoftwareJob(job)) {
    const candidate = document.candidates.find(value => value.id === job.subject.candidateId);
    if (!candidate) throw new Error("A_SUPPLIER_IMAGE_SEARCH_CANDIDATE_NOT_FOUND");
    const source = assertASupplierImageSearchSource({ document, candidate, scope: assertASupplierImageSearchScope(job.scopeBinding, job) });
    if (source.sourceJob !== null) assertCompletedADiscoveryJobResult({ job: source.sourceJob, receipt: source.sourceReceipt });
    if (job.ownerUserId !== job.requestedByUserId) throw new Error("A_SUPPLIER_IMAGE_SEARCH_OWNER_CONFLICT");
    return candidate;
  }
  if (isAProductDetailSoftwareJob(job)) {
    const candidate = document.candidates.find(value => value.id === job.subject.candidateId);
    if (!candidate) throw new Error("A_PRODUCT_DETAIL_CANDIDATE_NOT_FOUND");
    assertAProductDetailCandidateSource(candidate, assertAProductDetailScope(job.scopeBinding, job));
    if (job.ownerUserId !== job.requestedByUserId) throw new Error("A_PRODUCT_DETAIL_OWNER_CONFLICT");
    return candidate;
  }
  if (isADiscoverySoftwareJob(job)) {
    const batch = document.runtime?.aDiscoveryBatches?.[job.subject.batchId];
    if (!batch) throw new Error("A_DISCOVERY_BATCH_NOT_FOUND");
    assertADiscoveryBatchSource(batch, assertADiscoveryScope(job.scopeBinding, job));
    if (batch.ownerUserId !== job.ownerUserId || job.ownerUserId !== job.requestedByUserId) throw new Error("A_DISCOVERY_OWNER_CONFLICT");
    return batch;
  }
  if (isAccountPreparationSoftwareJob(job)) {
    const preparation = document.runtime?.ozonAccountPreparations?.[job.subject.preparationId];
    if (!preparation) throw new Error('SOFTWARE_JOB_ADMISSION_PREPARATION_NOT_FOUND');
    assertOzonAccountReadSubject(preparation, assertOzonAccountReadScope(job.scopeBinding, job));
    if (preparation.createdByUserId !== job.ownerUserId || job.ownerUserId !== job.requestedByUserId) {
      throw new Error('SOFTWARE_JOB_ADMISSION_PREPARATION_OWNER_MISMATCH');
    }
    return preparation;
  }
  if (!Array.isArray(document?.candidates)) throw new Error("SOFTWARE_JOB_ADMISSION_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === job.candidateId);
  if (!candidate) throw new Error("SOFTWARE_JOB_ADMISSION_CANDIDATE_NOT_FOUND");
  if (job.jobType === OZON_ACCOUNT_READ_JOB_TYPE) assertOzonAccountReadSubject(candidate,assertOzonAccountReadScope(job.scopeBinding,job));
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && legacyKeywordJobBlocksPaidExecution(candidate)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_LEGACY_OUTCOME_UNRESOLVED");
  }
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE) {
    const scope = normalizeC1AiDraftScopeBinding(job.scopeBinding, job);
    const sku = candidate.lifecycleV11?.skuPackage;
    if (!sku || sku.businessPhase !== "C1" || sku.c1ProductPlan?.status !== "facts_checked" ||
        candidate.targetStore !== scope.identity.storeRef.stableStoreId || !sameStoreRef(candidate.storeRef, scope.identity.storeRef) ||
        sku.skuPackageId !== job.skuPackageId || sku.dataRevision !== scope.sourceSkuRevision ||
        sku.variantKey !== scope.variantKey || sku.supplierSkuId !== scope.identity.supplierSkuId ||
        sku.targetPlatform !== scope.identity.platform || sku.targetStore !== scope.identity.storeRef.stableStoreId ||
        !sameJson(normalizeC1SourceIdentity(sku.g1Identity), scope.identity)) {
      throw new Error("SOFTWARE_JOB_ADMISSION_C1_SOURCE_MISMATCH");
    }
  }
  return candidate;
}

export function normalizeSoftwareJobScopeKey(job) {
  if (isASupplierImageSearchSoftwareJob(job)) {
    const scope = assertASupplierImageSearchScope(job.scopeBinding, job);
    return `a-supplier-image-search-scope:${scope.candidateId}:${scope.resultRevision}`;
  }
  if (isAProductDetailSoftwareJob(job)) {
    const scope = assertAProductDetailScope(job.scopeBinding, job);
    return `a-product-detail-scope:${scope.candidateId}:${scope.resultRevision}:${scope.requestIndex}`;
  }
  if (isADiscoverySoftwareJob(job)) {
    const scope = assertADiscoveryScope(job.scopeBinding, job);
    return `a-discovery-scope:${scope.batchId}:${scope.resultRevision}:${scope.requestIndex}`;
  }
  if(job?.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE){const scope=assertDPlatformObservationScope(job.scopeBinding);return `d-observation-scope:${scope.sourceDJobId}:${scope.queryIndex}`;}
  if (isDESoftwareJob(job)) return deSoftwareJobScopeKey(job);
  const scope = scopeForJob(job);
  if([A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_DISCOVERY_JOB_TYPE,OZON_ACCOUNT_READ_JOB_TYPE].includes(job.jobType)){
    const normalized=assertOzonAccountReadScope(scope,job);
    if (isAccountPreparationSoftwareJob(job)) return `software-job-scope:${fingerprintCanonicalRecord({jobType:job.jobType,
      subject:normalized.subject,bindingId:normalized.bindingId,configurationVersion:normalized.configurationVersion})}`;
    return `software-job-scope:${fingerprintCanonicalRecord({jobType:job.jobType,candidateId:normalized.candidateId,
      skuPackageId:normalized.skuPackageId,sourceRevision:normalized.sourceRevision,storeRef:normalized.storeRef,
      bindingId:normalized.bindingId,configurationVersion:normalized.configurationVersion})}`;
  }
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE) {
    const normalized = normalizeC1AiDraftScopeBinding(scope, job);
    return `software-job-scope:${fingerprintCanonicalRecord({
      schemaVersion: "software-job-normalized-scope-v1", jobType: C1_AI_DRAFT_JOB_TYPE,
      identity: normalized.identity, variantKey: normalized.variantKey, sideEffectScope: C1_AI_DRAFT_JOB_TYPE
    })}`;
  }
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || scope.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    const identity = {
      schemaVersion: "software-job-normalized-scope-v1",
      jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      candidateId: text(scope.candidateId, "scope.candidateId"),
      skuPackageId: text(scope.skuPackageId, "scope.skuPackageId"),
      platform: text(scope.platform, "scope.platform"),
      targetStore: text(scope.targetStore, "scope.targetStore"),
      supplierSkuId: text(scope.supplierSkuId, "scope.supplierSkuId"),
      variantKey: boundedVariantKey(scope.variantKey, "scope.variantKey"),
      sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      provider: C1_PAID_KEYWORD_PROVIDER
    };
    return `software-job-scope:${fingerprintCanonicalRecord(identity)}`;
  }
  const identity = {
    schemaVersion: "software-job-normalized-scope-v1",
    jobType: text(job.jobType, "job.jobType"),
    candidateId: text(scope.candidateId, "scope.candidateId"),
    skuPackageId: text(scope.skuPackageId, "scope.skuPackageId"),
    platform: text(scope.platform, "scope.platform"),
    stableStoreId: text(scope.storeRef?.stableStoreId, "scope.storeRef.stableStoreId"),
    supplierSkuId: text(scope.supplierSkuId, "scope.supplierSkuId"),
    variantKey: boundedVariantKey(scope.variantKey, "scope.variantKey"),
    sideEffectScope: text(scope.sideEffectScope, "scope.sideEffectScope")
  };
  return `software-job-scope:${fingerprintCanonicalRecord(identity)}`;
}

function scopeOccupies(job) {
  if (isADiscoverySoftwareJob(job) || isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job)) return true;
  return OCCUPYING_STATUSES.has(job.status) ||
    job.externalRequestState === "in_flight" ||
    (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && job.status === "failed" && job.externalRequestState === "succeeded") ||
    (job.jobType === C1_AI_DRAFT_JOB_TYPE && job.status === "failed" && job.externalRequestState === "succeeded") ||
    ([C1_AI_DRAFT_JOB_TYPE, C2_STABLE_ASSET_TRANSPORT_JOB_TYPE].includes(job.jobType) && job.status === "completed" && job.externalRequestState === "succeeded" &&
      job.attempt === 1 && typeof job.externalRequestRef === "string" && job.externalRequestRef.length > 0 &&
      job.resultEnvelope?.applicationDisposition === "result_recorded_no_candidate_mutation") ||
    (job.status === "completed" && job.resultEnvelope?.applicationDisposition === "revision_conflict_not_applied");
}

/**
 * 同一授权只允许有一条可能写平台的 D 路径。已经停在「失败，且一个请求都没发出去」的旧轮次
 * 不再是这样一条路径，所以主人明确再派一轮时它不算冲突；除此以外一律按冲突拒绝。
 */
function supersededDProductionRound(existing, job) {
  const fingerprint = job.scopeBinding.authorizationFingerprint;
  return job.jobType === "d_production_execution" && existing.jobType === job.jobType &&
    typeof fingerprint === "string" && existing.jobId !== job.jobId &&
    dProductionJobRound(existing.jobId, fingerprint) !== null && dProductionJobRound(job.jobId, fingerprint) !== null &&
    dProductionJobRound(existing.jobId, fingerprint) < dProductionJobRound(job.jobId, fingerprint) &&
    existing.status === "failed" && existing.externalRequestState === "not_sent" &&
    existing.externalRequestRef === null && existing.resultEnvelope === null;
}

export function assertNoSoftwareJobScopeConflict(document, job) {
  if (!job?.scopeBinding) return;
  const targetScope = normalizeSoftwareJobScopeKey(job);
  for (const existing of softwareJobsInDocument(document)) {
    if (sameSoftwareJobIdentity(existing, job)) continue;
    if (!existing?.scopeBinding) continue;
    if (isDESoftwareJob(job) && existing.jobType === job.jobType &&
        existing.scopeBinding.authorizationRef === job.scopeBinding.authorizationRef &&
        !supersededDProductionRound(existing, job)) {
      throw new Error("SOFTWARE_JOB_SCOPE_CONFLICT");
    }
    if (normalizeSoftwareJobScopeKey(existing) === targetScope && scopeOccupies(existing)) {
      throw new Error("SOFTWARE_JOB_SCOPE_CONFLICT");
    }
  }
}

function assertRecordCurrent(record, observedAt, code) {
  if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.parse(observedAt)) throw new Error(code);
}

function assertRecordNotFuture(record, observedAt, field, code) {
  if (Date.parse(record[field]) > Date.parse(observedAt)) throw new Error(code);
}

function assertRecordTimeOrder(leftValue, rightValue, code) {
  if (Date.parse(leftValue) > Date.parse(rightValue)) throw new Error(code);
}

function authorizationFingerprintSnapshot(record) {
  const { maxUses: _maxUses, useCount: _useCount, consumedByJobId: _consumedByJobId, consumedAt: _consumedAt, ...snapshot } = record;
  return snapshot;
}

function assertAuthorizationMatchesJob(record, job, observedAt) {
  const scope = scopeForJob(job);
  if([A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_DISCOVERY_JOB_TYPE,OZON_ACCOUNT_READ_JOB_TYPE].includes(job.jobType)){
    if(record.action!==job.jobType||record.authorizationId!==scope.authorizationRef||!sameJson(record.scopeBinding,scope)||
      record.authorizedByUserId!==job.ownerUserId||record.authorizedByUserId!==job.requestedByUserId)throw new Error('SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH');
    assertRecordNotFuture(record,observedAt,'authorizedAt','SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE');
    assertRecordCurrent(record,observedAt,'SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED');
    if(record.consumedAt!==null)assertRecordNotFuture(record,observedAt,'consumedAt','SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE');
    return;
  }
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE) {
    if (record.action !== C1_AI_DRAFT_JOB_TYPE || record.authorizationType !== "paid_ai_draft" ||
        record.authorizationId !== scope.authorizationRef || !sameJson(record.scopeBinding, scope)) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH");
    }
    if (record.authorizedByUserId !== job.ownerUserId || record.authorizedByUserId !== job.requestedByUserId) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
    }
    assertRecordNotFuture(record, observedAt, "authorizedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE");
    if (record.consumedAt !== null) {
      assertRecordTimeOrder(record.authorizedAt, record.consumedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_PRECEDES_AUTHORIZATION");
      assertRecordNotFuture(record, observedAt, "consumedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE");
    }
    assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED");
    return;
  }
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    if (record.authorizationId !== scope.authorizationRef || record.action !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
        record.authorizationSubject !== "c1_paid_keyword_evidence:seerfar_open_api_once" ||
        record.candidateId !== job.candidateId || record.skuPackageId !== job.skuPackageId ||
        record.sourceRevision !== scope.sourceRevision || record.resultRevision !== scope.resultRevision ||
        record.resultRevision !== job.revision || record.platform !== scope.platform ||
        record.targetStore !== scope.targetStore || record.supplierSkuId !== scope.supplierSkuId ||
        record.variantKey !== scope.variantKey || record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
        record.provider !== C1_PAID_KEYWORD_PROVIDER || record.credentialAlias !== scope.credentialAlias ||
        record.inputFingerprint !== scope.inputFingerprint ||
        record.planningEvidenceFingerprint !== scope.planningEvidenceFingerprint ||
        record.runtimeInputFingerprint !== scope.runtimeInputFingerprint ||
        record.seerfarRequestFingerprint !== scope.seerfarRequestFingerprint ||
        record.salesSnapshotFingerprint !== scope.salesSnapshotFingerprint ||
        record.supplySnapshotFingerprint !== scope.supplySnapshotFingerprint ||
        record.profitModelFingerprint !== scope.profitModelFingerprint ||
        record.c1FactsFingerprint !== scope.c1FactsFingerprint ||
        record.pointBudgetEvidenceRef !== scope.pointBudgetEvidenceRef ||
        record.quotaEvidenceRef !== scope.quotaEvidenceRef ||
        record.pointsAuthorized !== C1_PAID_KEYWORD_POINTS) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH");
    }
    if (record.authorizedByUserId !== job.ownerUserId || record.authorizedByUserId !== job.requestedByUserId) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
    }
    assertRecordNotFuture(record, observedAt, "authorizedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE");
    if (record.consumedAt !== null) {
      assertRecordTimeOrder(record.authorizedAt, record.consumedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_PRECEDES_AUTHORIZATION");
      assertRecordNotFuture(record, observedAt, "consumedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE");
    }
    assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED");
    return;
  }
  if (record.authorizationId !== scope.authorizationRef || record.action !== job.jobType ||
      record.candidateId !== job.candidateId || record.skuPackageId !== job.skuPackageId ||
      record.sourceRevision !== scope.sourceRevision || record.resultRevision !== scope.resultRevision ||
      record.resultRevision !== job.revision || record.platform !== scope.platform ||
      record.supplierSkuId !== scope.supplierSkuId || record.variantKey !== scope.variantKey ||
      record.sideEffectScope !== scope.sideEffectScope ||
      record.stagedAssetManifestFingerprint !== scope.stagedAssetManifestFingerprint ||
      record.ownerStagingConfirmationRef !== scope.ownerStagingConfirmationRef ||
      !sameJson(record.storeRef, scope.storeRef) ||
      !sameJson(record.allowedStableAssetHosts, scope.allowedStableAssetHosts)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH");
  }
  if (record.authorizedByUserId !== job.ownerUserId || record.authorizedByUserId !== job.requestedByUserId) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
  }
  assertRecordNotFuture(record, observedAt, "authorizedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE");
  if (record.consumedAt !== null) {
    assertRecordTimeOrder(record.authorizedAt, record.consumedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_PRECEDES_AUTHORIZATION");
    assertRecordNotFuture(record, observedAt, "consumedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE");
  }
  assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED");
}

function assertCredentialMatchesJob(record, job, observedAt, workerId = null) {
  const scope = scopeForJob(job);
  if([A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_DISCOVERY_JOB_TYPE,OZON_ACCOUNT_READ_JOB_TYPE].includes(job.jobType)){
    if(record.sideEffectScope!==job.jobType||record.credentialAlias!==scope.credentialAlias||!sameJson(record.scopeBinding,scope))throw new Error('SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH');
    if(workerId!==null&&!record.allowedWorkerIds.includes(workerId))throw new Error('SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND');
    assertRecordNotFuture(record,observedAt,'boundAt','SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE');
    assertRecordCurrent(record,observedAt,'SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED');return;
  }
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE) {
    if (record.sideEffectScope !== C1_AI_DRAFT_JOB_TYPE || record.credentialAlias !== scope.credentialAlias ||
        record.provider !== scope.provider || !sameJson(record.scopeBinding, scope)) {
      throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
    }
    if (workerId !== null && !record.allowedWorkerIds.includes(workerId)) throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND");
    assertRecordNotFuture(record, observedAt, "boundAt", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE");
    assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED");
    return;
  }
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    if (record.credentialAlias !== scope.credentialAlias || record.platform !== scope.platform ||
        record.targetStore !== scope.targetStore || record.provider !== C1_PAID_KEYWORD_PROVIDER ||
        record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
        record.candidateId !== job.candidateId || record.skuPackageId !== job.skuPackageId ||
        record.sourceRevision !== scope.sourceRevision || record.resultRevision !== scope.resultRevision ||
        record.inputFingerprint !== scope.inputFingerprint ||
        record.planningEvidenceFingerprint !== scope.planningEvidenceFingerprint ||
        record.runtimeInputFingerprint !== scope.runtimeInputFingerprint ||
        record.seerfarRequestFingerprint !== scope.seerfarRequestFingerprint) {
      throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
    }
    if (workerId !== null && !record.allowedWorkerIds.includes(workerId)) {
      throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND");
    }
    assertRecordNotFuture(record, observedAt, "boundAt", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE");
    assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED");
    return;
  }
  if (record.credentialAlias !== scope.credentialAlias || record.platform !== scope.platform ||
      record.sideEffectScope !== scope.sideEffectScope ||
      !sameJson(record.storeRef, scope.storeRef) ||
      !sameJson(record.allowedStableAssetHosts, scope.allowedStableAssetHosts)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
  }
  if (workerId !== null && !record.allowedWorkerIds.includes(workerId)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND");
  }
  assertRecordNotFuture(record, observedAt, "boundAt", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE");
  assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED");
}

function assertAuthorizationUseForPhase(record, job, phase) {
  if (phase === "enqueue_before_candidate_commit" || phase === "enqueue_current") {
    if (record.useCount !== 0 || record.consumedByJobId !== null || record.consumedAt !== null) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED");
    }
    return;
  }
  if (["claim", "external_request"].includes(phase) &&
      (record.useCount !== 1 || record.consumedByJobId !== job.jobId || record.consumedAt === null)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_CONSUMED_BY_JOB");
  }
}

function findValidatedAuthorization(document, job, observedAt) {
  const scope = scopeForJob(job);
  const records = softwareJobAuthorizationRecordsInDocument(document)
    .filter((entry) => entry?.authorizationId === scope.authorizationRef)
    .map(normalizeAuthorizationRecord);
  assertUniqueNormalizedRecords(records, ["authorizationId"], "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_DUPLICATE");
  const record = records
    .find((entry) => entry?.authorizationId === scope.authorizationRef);
  if (!record) throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED");
  assertAuthorizationMatchesJob(record, job, observedAt);
  return record;
}

function findValidatedCredential(document, job, observedAt, workerId = null) {
  const scope = scopeForJob(job);
  const namespaceCollisions = softwareJobCredentialBindingsInDocument(document)
    .filter((entry) => entry?.bindingId === scope.credentialAlias);
  if (namespaceCollisions.length > 0) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_NAMESPACE_COLLISION");
  }
  const aliasRecords = softwareJobCredentialBindingsInDocument(document)
    .filter((entry) => entry?.credentialAlias === scope.credentialAlias)
    .map(normalizeCredentialBinding);
  assertUniqueNormalizedRecords(aliasRecords, ["bindingId"], "SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE");
  const records = [A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,A_PRODUCT_DETAIL_JOB_TYPE,A_DISCOVERY_JOB_TYPE,C1_AI_DRAFT_JOB_TYPE,OZON_ACCOUNT_READ_JOB_TYPE].includes(job.jobType)
    ? aliasRecords.filter(record => record.sideEffectScope === job.jobType && sameJson(record.scopeBinding, scope))
    : job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE
    ? aliasRecords.filter((record) => record.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE &&
      record.candidateId === job.candidateId && record.skuPackageId === job.skuPackageId &&
      record.sourceRevision === scope.sourceRevision && record.resultRevision === scope.resultRevision &&
      record.inputFingerprint === scope.inputFingerprint)
    : aliasRecords;
  if (records.length === 0) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED");
  if (records.length !== 1) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE");
  assertUniqueNormalizedRecords(records, ["bindingId", "credentialAlias"], "SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE");
  const [record] = records;
  if (job.admissionDecision && record.bindingId !== job.admissionDecision.credentialBindingRef) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
  }
  assertCredentialMatchesJob(record, job, observedAt, workerId);
  return record;
}

function decisionStableProjection(decision) {
  return {
    schemaVersion: decision?.schemaVersion,
    admissionId: decision?.admissionId,
    jobId: decision?.jobId,
    candidateId: decision?.candidateId,
    skuPackageId: decision?.skuPackageId,
    subject: decision?.subject,
    revision: decision?.revision,
    jobType: decision?.jobType,
    normalizedScopeKey: decision?.normalizedScopeKey,
    authorizationRef: decision?.authorizationRef,
    authorizationFingerprint: decision?.authorizationFingerprint,
    credentialBindingRef: decision?.credentialBindingRef,
    credentialAlias: decision?.credentialAlias,
    credentialBindingFingerprint: decision?.credentialBindingFingerprint
  };
}

function assertStoredDecisionMatches(job, decision) {
  if (!["claim", "external_request"].includes(decision.phase)) return;
  if (!job.admissionDecision || !sameJson(decisionStableProjection(job.admissionDecision), decisionStableProjection(decision))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_DECISION_MISMATCH");
  }
}

function assertNoRestrictedC1Authorization(document, job) {
  if (job.jobType !== C1_AI_DRAFT_JOB_TYPE) return;
  const records = softwareJobAuthorizationRecordsInDocument(document);
  const restricted = records.some(record => isObject(record) && Object.hasOwn(record, "paymentAuthorization") &&
    (record.authorizationId === job.scopeBinding.authorizationRef ||
      (record.scopeBinding?.candidateId === job.candidateId && record.scopeBinding?.skuPackageId === job.skuPackageId &&
        record.action === C1_AI_DRAFT_JOB_TYPE)));
  if (restricted) throw new Error("C1_DRAFT_RESTRICTED_AUTHORIZATION_UNSUPPORTED");
}

export function validateSoftwareJobAdmission({ document, job, observedAt, phase, worker = null, workerId = null, executionBinding = null }) {
  if (!job?.scopeBinding) return null;
  const observed = iso(observedAt, "observedAt");
  if(job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE)return createDPlatformObservationAdmission({document,job,worker,executionBinding,phase,observedAt:observed});
  const candidate = candidateForJob(document, job);
  if (isDESoftwareJob(job)) {
    return createDEJobAdmissionDecision({ candidate, job, observedAt: observed, phase, worker, executionBinding });
  }
  const expectedRevision = phase === "enqueue_before_candidate_commit" ? job.scopeBinding.sourceRevision : job.revision;
  if (Number((isAccountPreparationSoftwareJob(job) || isADiscoverySoftwareJob(job)) ? candidate.revision : candidate.dataRevision) !== expectedRevision) throw new Error("SOFTWARE_JOB_ADMISSION_REVISION_CONFLICT");
  if (worker !== null) {
    if (!workerSatisfiesCapabilities(worker, job.requiredCapabilities)) throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_CAPABILITY_REQUIRED");
    workerId = worker.workerId;
  }
  assertNoRestrictedC1Authorization(document, job);
  const authorization = findValidatedAuthorization(document, job, observed);
  const credential = findValidatedCredential(document, job, observed, workerId);
  if (job.jobType === C1_AI_DRAFT_JOB_TYPE) {
    assertCurrentC1AiDraftRequestSources({ candidate, request: candidate.lifecycleV11.c1AiDraftRequestV1, observedAt: observed });
    if (candidate.lifecycleV11.c1AiDraftRequestV1.requestFingerprint !== job.scopeBinding.requestFingerprint) throw new Error("SOFTWARE_JOB_ADMISSION_C1_REQUEST_CONFLICT");
  }
  assertAuthorizationUseForPhase(authorization, job, phase);
  const authorizationFingerprint = fingerprintCanonicalRecord(authorizationFingerprintSnapshot(authorization));
  const credentialBindingFingerprint = fingerprintCanonicalRecord(credential);
  const decision = {
    schemaVersion: (isADiscoverySoftwareJob(job) || isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job)) ? 'software-job-admission-v3' : isAccountPreparationSoftwareJob(job) ? 'software-job-admission-v2' : SOFTWARE_JOB_ADMISSION_DECISION_VERSION,
    admissionId: `software-job-admission:${fingerprintCanonicalRecord({
      jobId: job.jobId,
      scopeKey: normalizeSoftwareJobScopeKey(job),
      authorizationFingerprint,
      credentialBindingFingerprint
    })}`,
    jobId: job.jobId,
    ...((isAccountPreparationSoftwareJob(job) || isADiscoverySoftwareJob(job) || isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job)) ? { subject: structuredClone(job.subject) } : { candidateId: job.candidateId, skuPackageId: job.skuPackageId }),
    revision: job.revision,
    jobType: job.jobType,
    normalizedScopeKey: normalizeSoftwareJobScopeKey(job),
    authorizationRef: authorization.authorizationId,
    authorizationFingerprint,
    credentialBindingRef: credential.bindingId,
    credentialAlias: credential.credentialAlias,
    credentialBindingFingerprint,
    phase,
    observedAt: observed
  };
  assertSafeRuntimeRecord(decision, "softwareJob.admissionDecision");
  assertStoredDecisionMatches(job, decision);
  return Object.freeze(decision);
}

export function assertSoftwareJobAdmittedForEnqueue({ document, job, observedAt, phase = "enqueue_current" }) {
  assertNoSoftwareJobScopeConflict(document, job);
  return validateSoftwareJobAdmission({ document, job, observedAt, phase });
}

export function consumeSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase = "enqueue_before_candidate_commit" }) {
  if (isDESoftwareJob(job)||job?.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE) {
    assertNoSoftwareJobScopeConflict(document, job);
    return validateSoftwareJobAdmission({ document, job, observedAt, phase });
  }
  if (!document?.runtime || !Array.isArray(document.runtime.softwareJobAuthorizationRecords)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED");
  }
  assertNoSoftwareJobScopeConflict(document, job);
  const decision = validateSoftwareJobAdmission({ document, job, observedAt, phase });
  const index = document.runtime.softwareJobAuthorizationRecords.findIndex((record) =>
    record?.authorizationId === job.scopeBinding.authorizationRef
  );
  if (index < 0) throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED");
  document.runtime.softwareJobAuthorizationRecords[index] = {
    ...structuredClone(document.runtime.softwareJobAuthorizationRecords[index]),
    useCount: 1,
    consumedByJobId: job.jobId,
    consumedAt: decision.observedAt
  };
  const consumed = findValidatedAuthorization(document, job, decision.observedAt);
  assertAuthorizationUseForPhase(consumed, job, "claim");
  return decision;
}

export function bindSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase = "enqueue_before_candidate_commit" }) {
  const decision = consumeSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase });
  return bindSoftwareJobAdmissionDecision(job, decision);
}

export function assertSoftwareJobAdmittedForClaim({ document, job, worker, observedAt, executionBinding = null }) {
  return validateSoftwareJobAdmission({ document, job, worker, observedAt, executionBinding, phase: "claim" });
}

export function assertSoftwareJobAdmittedForExternalRequest({ document, job, workerId, worker = null, observedAt, executionBinding = null }) {
  return validateSoftwareJobAdmission({ document, job, workerId, worker, observedAt, executionBinding, phase: "external_request" });
}
