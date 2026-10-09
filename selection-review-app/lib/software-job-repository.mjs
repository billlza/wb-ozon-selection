import { A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES, ASupplierImageSearchError,
  assertASupplierImageSearchScope, assertASupplierImageSearchSource, assertASupplierImageSearchAdmission,
  assertASupplierImageSearchReceipt, nextASupplierImageSearchRequest, interruptASupplierImageSearchReceipt } from "./a-supplier-image-search-contract.mjs";
import { isASupplierImageSearchSoftwareJob, createASupplierImageSearchJobForScope, settleASupplierImageSearchSoftwareJobInDocument } from "./software-job-contract.mjs";
export { createASupplierImageSearchJobForScope } from "./software-job-contract.mjs";
import { A_PRODUCT_DETAIL_JOB_TYPE, A_PRODUCT_DETAIL_FAILURE_CLASSES, AProductDetailError, assertAProductDetailScope, assertAProductDetailCandidateSource,
  assertAProductDetailSource, assertAProductDetailAdmission, assertAProductDetailReceipt, nextAProductDetailRequest, interruptAProductDetailReceipt } from "./a-product-detail-contract.mjs";
import { isAProductDetailSoftwareJob, createAProductDetailJobForScope, settleAProductDetailSoftwareJobInDocument, assertCompletedADiscoveryJobResult } from "./software-job-contract.mjs";
export { createAProductDetailJobForScope } from "./software-job-contract.mjs";
import { A_DISCOVERY_JOB_TYPE, ADiscoveryError, assertADiscoveryScope, assertADiscoveryBatchSource,
  assertADiscoveryAdmission, assertADiscoveryReceipt, nextADiscoveryRequest, interruptADiscoveryReceipt, isSeerfarADiscoveryScope } from "./a-discovery-contract.mjs";
import { isADiscoverySoftwareJob, createADiscoveryJobForScope, settleADiscoverySoftwareJobInDocument } from "./software-job-contract.mjs";
export { createADiscoveryJobForScope } from "./software-job-contract.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { assertCurrentC1AiDraftRequest } from "./c1-ai-draft-contract.mjs";
import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary } from "./business-state-repository.mjs";
import { assertSafeRuntimeRecord, workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { assertWorkerRegistryBoundary } from "./worker-registry.mjs";
import { isDESoftwareJob } from "./d-e-software-job-admission.mjs";
import { assertCurrentDJobExecutionCursor } from "./d-production-job-cursor.mjs";
import { assertDProductionJobReference, assertEReadbackJobReference } from "./d-e-software-job-handoff.mjs";
import { assertDProductionPreparation, markDProductionPreparationUnknown } from "./d-production-preparation-contract.mjs";
import { readDAssetTransportJobTerminal } from "./d-e-software-job-results.mjs";
import { D_PLATFORM_OBSERVATION_JOB_TYPE, assertDPlatformObservationJobSource, assertDPlatformObservationSend,
  assertDPlatformObservationScope, readDProductionJobWaiting, recordDPlatformObservationInDocument as recordObservation,
  resumeDRemainingInventoryInDocument, reconcileDRemainingInventoryInDocument, rejectDPlatformObservationInDocument, rejectDRemainingInventoryInDocument,
  registerOwnerWrittenInventoryInDocument } from './d-platform-observation-contract.mjs';
import {
  SOFTWARE_JOB_TYPES,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  createSoftwareJobResultEnvelope,
  readC1PaidKeywordSourceForSettlement,
  settleC1PaidKeywordFailureSoftwareJobInDocument,
  createSoftwareJobEnvelope,
  settleDPlatformObservationSoftwareJobInDocument,
  settleDPlatformStoppedSoftwareJobInDocument, settleDOwnerStockRegisteredSoftwareJobInDocument,
  settleDInitialImportStoppedSoftwareJobInDocument,
  D_PRODUCTION_EXECUTION_JOB_TYPE,
  E_INDEPENDENT_READBACK_JOB_TYPE,
  bindSoftwareJobAdmissionDecision,
  assertSoftwareJobExecutionLease,
  assertSoftwareJobStrictRef,
  claimSoftwareJobLease,
  enqueueSoftwareJobInDocument,
  findSoftwareJobInDocument,
  markSoftwareJobExternalRequestStarted,
  recordSoftwareJobProgress,
  recordC1GatewayAcceptance,
  C1_AI_DRAFT_JOB_TYPE,
  beginC1AiDraftResultReconciliation,
  settleC1AiDraftResultReconciliation,
  readC1AiDraftReconciliationSource,
  reconcileExpiredSoftwareJobLease,
  reconcileSoftwareJobAfterRestart,
  sameSoftwareJobIdentity,
  isAccountPreparationSoftwareJob,
  softwareJobsInDocument,
  softwareJobRequiresDomainSettlement,
  settleSoftwareJobInDocument,
  settleDPreparationSoftwareJobInDocument,
  settleOzonAccountReadSoftwareJobInDocument
} from "./software-job-contract.mjs";
import {
  assertSoftwareJobAdmittedForClaim,
  bindSoftwareJobAdmissionForEnqueue,
  assertSoftwareJobAdmittedForExternalRequest
} from "./software-job-admission.mjs";

import { OZON_ACCOUNT_READ_JOB_TYPE, interruptOzonAccountReadReceipt, assertOzonAccountReadSubject, assertOzonAccountReadScope } from './ozon-account-read-contract.mjs';

/** Pure completion proof shared by the automatic handoff and explicit local recovery. */
export function assertC1PaidKeywordContinuationResult({ candidate, job }) {
  const lifecycle = candidate?.lifecycleV11;
  if (!candidate || !job || job.schemaVersion !== "software-job-v1" ||
      job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || job.status !== "completed" ||
      job.externalRequestState !== "succeeded" || job.resultEnvelope?.applicationDisposition !== "applied" ||
      candidate.id !== job.candidateId || candidate.dataRevision !== job.revision + 1 ||
      lifecycle?.skuPackage?.skuPackageId !== job.skuPackageId || lifecycle.skuPackage.businessPhase !== "C1" ||
      lifecycle.c1AiDraftJobRefV1 || lifecycle.c1AiDraftRequestV1 || lifecycle.skuPackage.c1ProductPlan?.status === "seo_draft_ready") {
    throw new Error("C1_PAID_KEYWORD_CONTINUATION_SOURCE_CONFLICT");
  }
  const envelope = job.resultEnvelope, settlement = lifecycle.c1PaidKeywordEvidenceSettlementV1;
  const rebuilt = createSoftwareJobResultEnvelope({ job, resultRef: job.resultRef, payloadKind: job.jobType,
    payload: envelope.payload, recordedAt: envelope.recordedAt, applicationDisposition: "applied" });
  if (!isDeepStrictEqual(envelope, rebuilt) || settlement?.schemaVersion !== "c1-paid-keyword-evidence-settlement-v1" ||
      settlement.jobId !== job.jobId || settlement.resultRef !== job.resultRef ||
      settlement.resultFingerprint !== fingerprintCanonicalRecord(envelope.payload) || settlement.settledAt !== job.completedAt ||
      !lifecycle.c1SoftwareEvidenceV1 || !isDeepStrictEqual(lifecycle.c1SoftwareEvidenceV1, envelope.payload.prepared?.result?.evidenceStage?.evidence)) {
    throw new Error("C1_PAID_KEYWORD_CONTINUATION_SOURCE_CONFLICT");
  }
  return { jobId: job.jobId, candidateId: candidate.id, resultRevision: candidate.dataRevision };
}

export class C1PaidKeywordExecutionBlockedError extends Error {
  constructor(code) { super(code); this.name = "C1PaidKeywordExecutionBlockedError"; this.code = code; }
}

const KEYWORD_EXECUTION_BLOCKS = new Set([
  "SOFTWARE_JOB_REVISION_CONFLICT", "SOFTWARE_JOB_SKU_CONFLICT", "SOFTWARE_JOB_CANDIDATE_NOT_FOUND",
  "SOFTWARE_JOB_LEASE_REJECTED", "WORKER_REGISTRY_WORKER_NOT_CURRENT",
  "SOFTWARE_JOB_ADMISSION_REVISION_CONFLICT", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_CONSUMED_BY_JOB", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE", "SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND",
  "SOFTWARE_JOB_ADMISSION_WORKER_CAPABILITY_REQUIRED", "SOFTWARE_JOB_ADMISSION_LEGACY_OUTCOME_UNRESOLVED"
]);

const A_DISCOVERY_FAILURE_BY_CODE = Object.freeze({
  "SOFTWARE_JOB_REVISION_CONFLICT": "BATCH_CHANGED",
  "SOFTWARE_JOB_ADMISSION_REVISION_CONFLICT": "BATCH_CHANGED",
  "SOFTWARE_JOB_CLAIM_REJECTED": "BATCH_CHANGED",
  "A_DISCOVERY_BATCH_CHANGED": "BATCH_CHANGED",
  "A_DISCOVERY_SEQUENCE_INVALID": "BATCH_CHANGED",
  "A_DISCOVERY_BATCH_NOT_FOUND": "BATCH_CHANGED",
  "A_DISCOVERY_OWNER_CONFLICT": "BATCH_CHANGED",
  "A_DISCOVERY_PREVIOUS_REQUEST_NOT_COMPLETED": "BATCH_CHANGED",
  "A_DISCOVERY_ALREADY_ATTEMPTED": "BATCH_CHANGED",
  "WORKER_REGISTRY_WORKER_NOT_CURRENT": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_WORKER_CAPABILITY_REQUIRED": "CREDENTIAL_BINDING_INVALID",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE": "AUTHORIZATION_INVALID",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED": "AUTHORIZATION_INVALID",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_CONSUMED_BY_JOB": "AUTHORIZATION_INVALID",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH": "AUTHORIZATION_INVALID",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED": "AUTHORIZATION_EXPIRED",
  "A_DISCOVERY_AUTHORIZATION_EXPIRED": "AUTHORIZATION_EXPIRED",
  "SOFTWARE_JOB_LEASE_REJECTED": "LEASE_EXPIRED"
});
export class ADiscoveryExecutionBlockedError extends Error {
  constructor(code) {
    super(code);
    this.name = "ADiscoveryExecutionBlockedError";
    this.code = code;
    const failureClass = A_DISCOVERY_FAILURE_BY_CODE[code];
    if (!failureClass) throw new Error("A_DISCOVERY_EXECUTION_BLOCK_CODE_INVALID");
    this.failureClass = failureClass;
  }
}
const A_DISCOVERY_EXECUTION_BLOCKS = new Set([
  "SOFTWARE_JOB_REVISION_CONFLICT", "WORKER_REGISTRY_WORKER_NOT_CURRENT", "SOFTWARE_JOB_ADMISSION_REVISION_CONFLICT",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_CONSUMED_BY_JOB",
  "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH",
  "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE", "SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND",
  "SOFTWARE_JOB_ADMISSION_WORKER_CAPABILITY_REQUIRED",
  "SOFTWARE_JOB_CLAIM_REJECTED: 作业不是可领取状态", "SOFTWARE_JOB_CLAIM_REJECTED: Worker能力或状态不满足",
  "SOFTWARE_JOB_LEASE_REJECTED: Worker或租约不匹配", "SOFTWARE_JOB_LEASE_REJECTED: 租约已过期",
  "SOFTWARE_JOB_LEASE_REJECTED: 作业不是本轮已领取状态", "SOFTWARE_JOB_LEASE_REJECTED: 执行状态与外部请求状态冲突"
]);
function throwADiscoveryExecutionError(error) {
  if (error instanceof ADiscoveryExecutionBlockedError) throw error;
  if (error instanceof ADiscoveryError && ["BATCH_CHANGED", "AUTHORIZATION_EXPIRED", "SEQUENCE_INVALID"].includes(error.code)) {
    throw new ADiscoveryExecutionBlockedError(error.message);
  }
  if (error instanceof Error && A_DISCOVERY_EXECUTION_BLOCKS.has(error.message)) {
    throw new ADiscoveryExecutionBlockedError(error.message.split(":")[0]);
  }
  throw error;
}
export class AProductDetailExecutionBlockedError extends Error {
  constructor(code, failureClass) {
    super(code);
    if (!A_PRODUCT_DETAIL_FAILURE_CLASSES.includes(failureClass)) throw new Error("A_PRODUCT_DETAIL_EXECUTION_BLOCK_CODE_INVALID");
    this.name = "AProductDetailExecutionBlockedError"; this.code = code; this.failureClass = failureClass;
  }
}
function throwAProductDetailExecutionError(error) {
  if (error instanceof AProductDetailExecutionBlockedError) throw error;
  if (error instanceof AProductDetailError && ["CANDIDATE_CHANGED", "AUTHORIZATION_EXPIRED", "SEQUENCE_INVALID"].includes(error.code)) {
    throw new AProductDetailExecutionBlockedError(error.message, error.code === "AUTHORIZATION_EXPIRED" ? error.code : "CANDIDATE_CHANGED");
  }
  if (error instanceof Error && A_DISCOVERY_EXECUTION_BLOCKS.has(error.message)) {
    const code = error.message.split(":")[0], failure = A_DISCOVERY_FAILURE_BY_CODE[code];
    throw new AProductDetailExecutionBlockedError(code, failure === "BATCH_CHANGED" ? "CANDIDATE_CHANGED" : failure);
  }
  throw error;
}
function detailReceipts(document, job, { excludeCurrent = false } = {}) {
  return Object.values(document.runtime.aProductDetailReceipts ?? {}).filter(receipt =>
    receipt.scope.candidateId === job.subject.candidateId && receipt.scope.sourceRevision === job.revision &&
    (!excludeCurrent || receipt.jobId !== job.jobId)).map(receipt => {
      const source = findSoftwareJobInDocument(document, receipt.jobId);
      if (!isAProductDetailSoftwareJob(source)) throw new Error("A_PRODUCT_DETAIL_RECEIPT_JOB_REQUIRED");
      assertAProductDetailReceipt(receipt, source);
      if (receipt.jobId !== job.jobId && source.status !== "completed") {
        throw new AProductDetailExecutionBlockedError("A_PRODUCT_DETAIL_PREVIOUS_REQUEST_NOT_COMPLETED", "CANDIDATE_CHANGED");
      }
      return receipt;
    });
}
export class ASupplierImageSearchExecutionBlockedError extends Error {
  constructor(code, failureClass) {
    super(code);
    if (!A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(failureClass)) throw new Error("A_SUPPLIER_IMAGE_SEARCH_EXECUTION_BLOCK_CODE_INVALID");
    this.name = "ASupplierImageSearchExecutionBlockedError"; this.code = code; this.failureClass = failureClass;
  }
}
function throwASupplierImageSearchExecutionError(error) {
  if (error instanceof ASupplierImageSearchExecutionBlockedError) throw error;
  if (error instanceof ASupplierImageSearchError && (["SEQUENCE_INVALID"].includes(error.code) || A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(error.code))) {
    throw new ASupplierImageSearchExecutionBlockedError(error.message, error.code === "SEQUENCE_INVALID" ? "CANDIDATE_CHANGED" : error.code);
  }
  if (error instanceof Error && A_DISCOVERY_EXECUTION_BLOCKS.has(error.message)) {
    const code = error.message.split(":")[0], failure = A_DISCOVERY_FAILURE_BY_CODE[code];
    throw new ASupplierImageSearchExecutionBlockedError(code, failure === "BATCH_CHANGED" ? "CANDIDATE_CHANGED" : failure);
  }
  throw error;
}
function imageSearchReceipts(document, job, { excludeCurrent = false } = {}) {
  return Object.values(document.runtime.aSupplierImageSearchReceipts ?? {}).filter(receipt =>
    receipt.scope.candidateId === job.subject.candidateId && receipt.scope.sourceRevision === job.revision &&
    (!excludeCurrent || receipt.jobId !== job.jobId)).map(receipt => {
      const source = findSoftwareJobInDocument(document, receipt.jobId);
      if (!isASupplierImageSearchSoftwareJob(source)) throw new Error("A_SUPPLIER_IMAGE_SEARCH_RECEIPT_JOB_REQUIRED");
      assertASupplierImageSearchReceipt(receipt, source);
      if (receipt.jobId !== job.jobId && source.status !== "completed") {
        throw new ASupplierImageSearchExecutionBlockedError("A_SUPPLIER_IMAGE_SEARCH_PREVIOUS_REQUEST_NOT_COMPLETED", "CANDIDATE_CHANGED");
      }
      return receipt;
    });
}
function assertDetailSourceInDocument(document, candidate, scope) {
  assertAProductDetailSource({ document, candidate, scope });
  for (const jobId of [scope.discoverySource.marketJobId, scope.discoverySource.supplierJobId]) {
    const job = findSoftwareJobInDocument(document, jobId);
    assertCompletedADiscoveryJobResult({ job, receipt: document.runtime.aDiscoveryReceipts[jobId] });
  }
}
function batchReceipts(document, job, { excludeCurrent = false } = {}) {
  const receipts = Object.values(document.runtime.aDiscoveryReceipts || {}).filter(receipt =>
    receipt.scope?.batchId === job.subject.batchId && receipt.scope?.sourceRevision === job.revision &&
    (!excludeCurrent || receipt.jobId !== job.jobId));
  for (const receipt of receipts) {
    const source = findSoftwareJobInDocument(document, receipt.jobId);
    if (!source || !isADiscoverySoftwareJob(source)) throw new Error("A_DISCOVERY_RECEIPT_JOB_REQUIRED");
    assertADiscoveryReceipt(receipt, source);
    if (receipt.jobId !== job.jobId && source.status !== "completed") throw new ADiscoveryExecutionBlockedError("A_DISCOVERY_PREVIOUS_REQUEST_NOT_COMPLETED");
  }
  return receipts;
}

function clone(value) {
  return structuredClone(value);
}

/** Account reads never resume after a stopped process, including gaps between completed methods. */
function reconcileAccountRead(document,job,observedAt){
  if(job.jobType!==OZON_ACCOUNT_READ_JOB_TYPE)return null;
  const receipt=document.runtime.ozonAccountReadReceipts?.[job.jobId];
  if(receipt===undefined){
    if(job.status!=='claimed'||job.externalRequestState!=='not_sent')throw new Error('OZON_ACCOUNT_READ_RECEIPT_REQUIRED');
    return null;
  }
  document.runtime.ozonAccountReadReceipts[job.jobId]=interruptOzonAccountReadReceipt(receipt,job,observedAt,'ozon-account-read-interrupted-no-retry');
  return settleOzonAccountReadSoftwareJobInDocument(document,{jobId:job.jobId,workerId:job.workerId,leaseId:job.leaseId},observedAt);
}

/** Recover a stopped local computation only after proving the preceding OSS request succeeded. */
function reconcileLocalPreparationAfterVerifiedAssets(document, job, observedAt) {
  if (job.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || job.status !== "waiting_platform" ||
      job.preparationEvidence?.requestMode !== "persisted_evidence_only" || job.preparationEvidence.status !== "in_flight") return null;
  assertDProductionPreparation(job.preparationEvidence, { job });
  const candidates = document.candidates.filter(candidate => candidate.id === job.candidateId);
  if (candidates.length !== 1) throw new Error("SOFTWARE_JOB_CANDIDATE_NOT_FOUND");
  const candidate = candidates[0], sku = candidate.lifecycleV11?.skuPackage;
  if (sku?.dAssetTransport?.status !== "verified" || sku.dSoftwareExecution != null || sku.productionRecord !== null) return null;
  const assetResult = readDAssetTransportJobTerminal({ candidate, job, observedAt });
  if (assetResult.externalRequestState !== "succeeded") throw new Error("SOFTWARE_JOB_LOCAL_PREPARATION_ASSETS_UNVERIFIED");
  const jobs = softwareJobsInDocument(document), index = jobs.findIndex(entry => entry.jobId === job.jobId);
  jobs[index] = { ...job, preparationEvidence: markDProductionPreparationUnknown({ evidence: job.preparationEvidence, completedAt: observedAt }) };
  return settleDPreparationSoftwareJobInDocument(document, { jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId }, observedAt).job;
}

function currentCandidate(document, job, observedAt) {
  if (isASupplierImageSearchSoftwareJob(job)) {
    const candidate = document.candidates.find(value => value.id === job.subject.candidateId);
    if (!candidate) throw new ASupplierImageSearchExecutionBlockedError("A_SUPPLIER_IMAGE_SEARCH_CANDIDATE_NOT_FOUND", "CANDIDATE_CHANGED");
    const source = assertASupplierImageSearchSource({ document, candidate, scope: assertASupplierImageSearchScope(job.scopeBinding, job) });
    if (source.sourceJob !== null) assertCompletedADiscoveryJobResult({ job: source.sourceJob, receipt: source.sourceReceipt });
    if (job.ownerUserId !== job.requestedByUserId) throw new Error("A_SUPPLIER_IMAGE_SEARCH_OWNER_CONFLICT");
    return candidate;
  }
  if (isAProductDetailSoftwareJob(job)) {
    const candidate = document.candidates.find(value => value.id === job.subject.candidateId);
    if (!candidate) throw new AProductDetailExecutionBlockedError("A_PRODUCT_DETAIL_CANDIDATE_NOT_FOUND", "CANDIDATE_CHANGED");
    assertAProductDetailCandidateSource(candidate, assertAProductDetailScope(job.scopeBinding, job));
    assertDetailSourceInDocument(document, candidate, job.scopeBinding);
    if (job.ownerUserId !== job.requestedByUserId) throw new Error("A_PRODUCT_DETAIL_OWNER_CONFLICT");
    return candidate;
  }
  if (isADiscoverySoftwareJob(job)) {
    const batch = document.runtime?.aDiscoveryBatches?.[job.subject.batchId];
    if (!batch) throw new ADiscoveryExecutionBlockedError("A_DISCOVERY_BATCH_NOT_FOUND");
    assertADiscoveryBatchSource(batch, assertADiscoveryScope(job.scopeBinding, job));
    if (batch.ownerUserId !== job.ownerUserId || job.ownerUserId !== job.requestedByUserId) throw new ADiscoveryExecutionBlockedError("A_DISCOVERY_OWNER_CONFLICT");
    return batch;
  }
  if(job?.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE)return assertDPlatformObservationJobSource({document,job,observedAt}).candidate;
  if (isAccountPreparationSoftwareJob(job)) {
    const preparation = document.runtime?.ozonAccountPreparations?.[job.subject.preparationId];
    if (!preparation) throw new Error('SOFTWARE_JOB_PREPARATION_NOT_FOUND');
    assertOzonAccountReadSubject(preparation, assertOzonAccountReadScope(job.scopeBinding, job));
    if (preparation.createdByUserId !== job.ownerUserId || job.ownerUserId !== job.requestedByUserId) {
      throw new Error('SOFTWARE_JOB_PREPARATION_OWNER_CONFLICT');
    }
    return preparation;
  }
  if (!Array.isArray(document.candidates)) throw new Error("SOFTWARE_JOB_STORE_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === job.candidateId);
  if (!candidate) throw new Error("SOFTWARE_JOB_CANDIDATE_NOT_FOUND");
  if (job.jobType === D_PRODUCTION_EXECUTION_JOB_TYPE) {
    assertDProductionJobReference({ document, candidate, job });
    assertCurrentDJobExecutionCursor({ candidate, job, observedAt });
  }
  else {
    if (Number(candidate.dataRevision) !== job.revision) throw new Error("SOFTWARE_JOB_REVISION_CONFLICT");
    if (job.jobType === E_INDEPENDENT_READBACK_JOB_TYPE) assertEReadbackJobReference({ document, candidate, job });
  }
  const candidateSkuIds = [
    candidate.lifecycleV11?.skuPackage?.skuPackageId,
    candidate.skuPackage?.skuPackageId,
    ...(Array.isArray(candidate.skuLifecyclePackages) ? candidate.skuLifecyclePackages.map((entry) => entry?.skuPackageId) : [])
  ].filter(Boolean);
  if (candidateSkuIds.length > 0 && !candidateSkuIds.includes(job.skuPackageId)) {
    throw new Error("SOFTWARE_JOB_SKU_CONFLICT");
  }
  return candidate;
}

function isWorkerSpecificAdmissionRejection(error) {
  return /(?:SOFTWARE_JOB_ADMISSION_(?:WORKER_NOT_BOUND|WORKER_CAPABILITY_REQUIRED)|WORKER_REGISTRY_WORKER_NOT_CURRENT)/.test(String(error?.message || error));
}

function isPerJobAdmissionRejection(error) {
  return /(?:^|[^A-Z0-9_])(?:SOFTWARE_JOB_ADMISSION_[A-Z0-9_]+|WORKER_REGISTRY_WORKER_NOT_CURRENT|SOFTWARE_JOB_REVISION_CONFLICT|SOFTWARE_JOB_CANDIDATE_NOT_FOUND|SOFTWARE_JOB_SKU_CONFLICT)(?:$|[^A-Z0-9_])/.test(String(error?.message || error));
}

function rejectionCode(error) {
  const match = String(error?.message || error).match(/(?:SOFTWARE_JOB_ADMISSION_[A-Z0-9_]+|WORKER_REGISTRY_WORKER_NOT_CURRENT|SOFTWARE_JOB_REVISION_CONFLICT|SOFTWARE_JOB_CANDIDATE_NOT_FOUND|SOFTWARE_JOB_SKU_CONFLICT)/);
  return match ? match[0] : "SOFTWARE_JOB_ASSIGNMENT_REJECTED";
}

function assignmentRejection(job, error) {
  const rejection = {
    schemaVersion: (isADiscoverySoftwareJob(job) || isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job)) ? "software-job-assignment-rejection-v3" : "software-job-assignment-rejection-v1",
    jobId: String(job?.jobId || ""),
    jobType: String(job?.jobType || ""),
    ...((isADiscoverySoftwareJob(job) || isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job)) ? { subject: clone(job.subject) } : { candidateId: String(job?.candidateId || ""), skuPackageId: String(job?.skuPackageId || "") }),
    revision: Number.isInteger(job?.revision) ? job.revision : null,
    reasonCode: (error instanceof ASupplierImageSearchExecutionBlockedError || error instanceof ADiscoveryExecutionBlockedError || error instanceof AProductDetailExecutionBlockedError) ? error.code : rejectionCode(error)
  };
  assertSafeRuntimeRecord(rejection, "softwareJob.assignmentRejection");
  return Object.freeze(rejection);
}

export { enqueueSoftwareJobInDocument, findSoftwareJobInDocument, sameSoftwareJobIdentity, settleSoftwareJobInDocument };

const RESTART_FILTER_JOB_TYPES = Object.freeze([
  A_DISCOVERY_JOB_TYPE, A_PRODUCT_DETAIL_JOB_TYPE,
  D_PRODUCTION_EXECUTION_JOB_TYPE, D_PLATFORM_OBSERVATION_JOB_TYPE, E_INDEPENDENT_READBACK_JOB_TYPE
]);

export function createRepositoryBackedSoftwareJobStore({ businessStateRepository, serverClock = () => new Date().toISOString(), workerRegistry = null,
  resolveDEExecutionBinding = null } = {}) {
  const repositoryBoundary = assertBusinessStateRepositoryBoundary(businessStateRepository);
  if (typeof serverClock !== "function") throw new Error("SOFTWARE_JOB_STORE_CLOCK_REQUIRED");
  if (workerRegistry !== null) assertWorkerRegistryBoundary(workerRegistry);
  if (resolveDEExecutionBinding !== null && typeof resolveDEExecutionBinding !== "function") throw new Error("SOFTWARE_JOB_STORE_DE_BINDING_RESOLVER_INVALID");

  function reconcileObservation(document,job,observedAt){
    if(job.jobType!==D_PLATFORM_OBSERVATION_JOB_TYPE)return null;
    const result={schemaVersion:'d-platform-observation-failure-v1',status:'unknown_outcome',failureClass:'request_cancelled',
      requestSent:job.status==='waiting_platform'&&job.externalRequestState==='in_flight'};
    return store.recordDPlatformObservationInDocument({document,jobId:job.jobId,workerId:job.workerId,leaseId:job.leaseId,result,observedAt}).job;
  }
  function reconcileADiscovery(document, job, observedAt) {
    if (!isADiscoverySoftwareJob(job)) return null;
    const receipt = document.runtime.aDiscoveryReceipts?.[job.jobId];
    if (receipt === undefined) {
      if (job.status !== "claimed" || job.externalRequestState !== "not_sent") throw new Error("A_DISCOVERY_RECEIPT_REQUIRED");
      return null;
    }
    document.runtime.aDiscoveryReceipts[job.jobId] = interruptADiscoveryReceipt(receipt, job, observedAt, "CANCELLED");
    return settleADiscoverySoftwareJobInDocument(document, { jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId }, observedAt);
  }
  function reconcileAProductDetail(document, job, observedAt) {
    if (!isAProductDetailSoftwareJob(job)) return null;
    const receipt = document.runtime.aProductDetailReceipts?.[job.jobId];
    if (receipt === undefined) {
      if (job.status !== "claimed" || job.externalRequestState !== "not_sent") throw new Error("A_PRODUCT_DETAIL_RECEIPT_REQUIRED");
      return null;
    }
    document.runtime.aProductDetailReceipts[job.jobId] = interruptAProductDetailReceipt(receipt, job, observedAt, "CANCELLED");
    return settleAProductDetailSoftwareJobInDocument(document, { jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId }, observedAt);
  }
  function reconcileASupplierImageSearch(document, job, observedAt) {
    if (!isASupplierImageSearchSoftwareJob(job)) return null;
    const receipt = document.runtime.aSupplierImageSearchReceipts?.[job.jobId];
    if (receipt === undefined) {
      if (job.status !== "claimed" || job.externalRequestState !== "not_sent") throw new Error("A_SUPPLIER_IMAGE_SEARCH_RECEIPT_REQUIRED");
      return null;
    }
    document.runtime.aSupplierImageSearchReceipts[job.jobId] = interruptASupplierImageSearchReceipt(receipt, job, observedAt, "CANCELLED");
    return settleASupplierImageSearchSoftwareJobInDocument(document, { jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId }, observedAt);
  }
  function reconcileInventory(document,job,observedAt){
    if(job.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE)return null;
    const terminal=reconcileDRemainingInventoryInDocument({document,job,observedAt});
    if(terminal===null)return null;
    const candidate=document.candidates.find(value=>value.id===job.candidateId);
    job.platformContinuation=clone(candidate.lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation);
    return settleDPlatformStoppedSoftwareJobInDocument(document,{candidate,jobId:job.jobId,interruptedInventory:true},observedAt);
  }
  function parkedWaiting(document,job,observedAt){
    if(job.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE||job.status!=='waiting_platform'||job.externalRequestState!=='succeeded')return false;
    readDProductionJobWaiting({candidate:document.candidates.find(value=>value.id===job.candidateId),job,observedAt});return true;
  }
  function observedServerTime() {
    const raw = String(serverClock() ?? "").trim();
    const timestamp = Date.parse(raw);
    if (!raw || Number.isNaN(timestamp)) throw new Error("SOFTWARE_JOB_STORE_CLOCK_INVALID");
    return new Date(timestamp).toISOString();
  }

  function requireWorkerRegistry(job) {
    if (!softwareJobRequiresDomainSettlement(job)) return null;
    assertWorkerRegistryBoundary(workerRegistry);
    if (typeof workerRegistry.get !== "function" || typeof workerRegistry.snapshot !== "function") {
      throw new Error("WORKER_REGISTRY_BOUNDARY_REQUIRED");
    }
    return workerRegistry;
  }

  function registryWorkerForJob(job, workerId, { requireClaimSnapshot = false } = {}) {
    const registry = requireWorkerRegistry(job);
    if (!registry) return null;
    const snapshot = registry.snapshot();
    const snapshotWorker = snapshot.find((entry) => entry.workerId === workerId);
    const current = registry.get(workerId);
    if (!snapshotWorker || !current || snapshotWorker.heartbeatCurrent !== true ||
        current.status !== "online" ||
        snapshotWorker.status !== current.status ||
        snapshotWorker.version !== current.version ||
        JSON.stringify(snapshotWorker.capabilities) !== JSON.stringify(current.capabilities) ||
        !workerSatisfiesCapabilities(current, job.requiredCapabilities)) {
      throw new Error("WORKER_REGISTRY_WORKER_NOT_CURRENT");
    }
    if (requireClaimSnapshot &&
        (job.workerVersion !== current.version ||
         JSON.stringify(job.workerCapabilitiesSnapshot || []) !== JSON.stringify(current.capabilities))) {
      throw new Error("WORKER_REGISTRY_WORKER_NOT_CURRENT");
    }
    return current;
  }

  function registryWorkerForDescriptor(job, worker) {
    if (!softwareJobRequiresDomainSettlement(job)) return worker;
    if (!worker?.workerId) throw new Error("WORKER_REGISTRY_WORKER_NOT_CURRENT");
    return registryWorkerForJob(job, worker.workerId);
  }

  function currentExecutionBinding(candidate, job, worker, observedAt) {
    if (!isDESoftwareJob(job)&&job?.jobType!==D_PLATFORM_OBSERVATION_JOB_TYPE) return null;
    if (resolveDEExecutionBinding === null) throw new Error("SOFTWARE_JOB_ADMISSION_DE_BINDING_REQUIRED");
    // This injected boundary reads current configured metadata only. Admission validates the closed DTO.
    return resolveDEExecutionBinding({ candidate: clone(candidate), job: clone(job), worker: clone(worker), observedAt });
  }

  async function readJobs() {
    const document = await businessStateRepository.readSnapshot();
    return clone(document.runtime?.softwareJobs || []);
  }

  const discoveryReadDomain = Object.freeze({
    isJob: isADiscoverySoftwareJob, jobType: A_DISCOVERY_JOB_TYPE, subjectKey: "batchId", sourceKey: "batch",
    codePrefix: "A_DISCOVERY", requestPrefix: "a-discovery-request", receiptCollection: "aDiscoveryReceipts",
    createJob: createADiscoveryJobForScope, receipts: batchReceipts, assertReceipt: assertADiscoveryReceipt,
    settle: settleADiscoverySoftwareJobInDocument, Error: ADiscoveryExecutionBlockedError,
    throwExecutionError: throwADiscoveryExecutionError, block: code => new ADiscoveryExecutionBlockedError(code),
    admit: ({ document: _document, source, ...input }) => assertADiscoveryAdmission({ batch: source, ...input }),
    nextRequest: ({ source, receipts }) => nextADiscoveryRequest({ batch: source, receipts })
  });
  const productDetailReadDomain = Object.freeze({
    isJob: isAProductDetailSoftwareJob, jobType: A_PRODUCT_DETAIL_JOB_TYPE, subjectKey: "candidateId", sourceKey: "candidate",
    codePrefix: "A_PRODUCT_DETAIL", requestPrefix: "a-product-detail-request", receiptCollection: "aProductDetailReceipts",
    createJob: createAProductDetailJobForScope, receipts: detailReceipts, assertReceipt: assertAProductDetailReceipt,
    settle: settleAProductDetailSoftwareJobInDocument, Error: AProductDetailExecutionBlockedError,
    throwExecutionError: throwAProductDetailExecutionError, block: (code, failureClass) => new AProductDetailExecutionBlockedError(code, failureClass),
    admit: ({ source, ...input }) => assertAProductDetailAdmission({ candidate: source, ...input }),
    nextRequest: ({ source, ...input }) => nextAProductDetailRequest({ candidate: source, ...input })
  });
  const imageSearchReadDomain = Object.freeze({
    isJob: isASupplierImageSearchSoftwareJob, jobType: A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, subjectKey: "candidateId", sourceKey: "candidate",
    codePrefix: "A_SUPPLIER_IMAGE_SEARCH", requestPrefix: "a-supplier-image-search-request", receiptCollection: "aSupplierImageSearchReceipts",
    createJob: createASupplierImageSearchJobForScope, receipts: imageSearchReceipts, assertReceipt: assertASupplierImageSearchReceipt,
    settle: settleASupplierImageSearchSoftwareJobInDocument, Error: ASupplierImageSearchExecutionBlockedError,
    throwExecutionError: throwASupplierImageSearchExecutionError, block: (code, failureClass) => new ASupplierImageSearchExecutionBlockedError(code, failureClass),
    admit: ({ source, ...input }) => assertASupplierImageSearchAdmission({ candidate: source, ...input }),
    nextRequest: ({ source, ...input }) => nextASupplierImageSearchRequest({ candidate: source, ...input })
  });
  function enqueuePreSkuRead(domain, { document, job, observedAt }) {
      if (!domain.isJob(job)) throw new Error(`${domain.codePrefix}_JOB_REQUIRED`);
      const expected = domain.createJob({ scope: job.scopeBinding, ownerUserId: job.ownerUserId, createdAt: job.createdAt });
      if (!isDeepStrictEqual(job, expected)) throw new Error(`${domain.codePrefix}_JOB_INPUT_CONFLICT`);
      const existing = softwareJobsInDocument(document).filter(entry => entry.jobType === domain.jobType &&
        entry.subject?.[domain.subjectKey] === job.subject[domain.subjectKey] && entry.revision === job.revision && entry.scopeBinding.requestIndex === job.scopeBinding.requestIndex);
      if (existing.length) {
        if (existing.length !== 1 || existing[0].jobId !== job.jobId || !isDeepStrictEqual(existing[0].scopeBinding, job.scopeBinding) || existing[0].ownerUserId !== job.ownerUserId) {
          throw new Error(`${domain.codePrefix}_DUPLICATE_REQUEST_CONFLICT`);
        }
        return clone(existing[0]);
      }
      const source = currentCandidate(document, job, observedAt);
      const authorization = document.runtime.softwareJobAuthorizationRecords?.find(record => record.authorizationId === job.scopeBinding.authorizationRef);
      domain.admit({ document, source, scope: job.scopeBinding, authorization, receipts: domain.receipts(document, job), checkedAt: observedAt });
      const admitted = bindSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase: "enqueue_current" });
      return clone(enqueueSoftwareJobInDocument(document, admitted).job);
  }
  function assertPreSkuReadExecution(domain, { document, jobId, workerId, leaseId, observedAt, markRequestSent = false, requestStep = null }) {
      try {
        const job = findSoftwareJobInDocument(document, jobId);
        if (!domain.isJob(job)) throw new Error(`${domain.codePrefix}_JOB_REQUIRED`);
        const source = currentCandidate(document, job, observedAt);
        const worker = registryWorkerForJob(job, workerId, { requireClaimSnapshot: true });
        assertSoftwareJobExecutionLease({ job, workerId, leaseId, serverTime: observedAt });
        if (Date.parse(observedAt) >= Date.parse(job.leaseExpiresAt)) throw domain.block("SOFTWARE_JOB_LEASE_REJECTED", "LEASE_EXPIRED");
        const authorization = document.runtime.softwareJobAuthorizationRecords?.find(record => record.authorizationId === job.scopeBinding.authorizationRef);
        domain.admit({ document, source, scope: job.scopeBinding, authorization,
          receipts: domain.receipts(document, job, { excludeCurrent: true }), checkedAt: observedAt });
        const admissionDecision = assertSoftwareJobAdmittedForExternalRequest({ document, job, worker, workerId, observedAt });
        if (markRequestSent) {
          const receipt = document.runtime[domain.receiptCollection]?.[jobId];
          domain.assertReceipt(receipt, job);
          const seerfar = domain.isJob(job) && domain.jobType === A_DISCOVERY_JOB_TYPE && isSeerfarADiscoveryScope(job.scopeBinding);
          if (seerfar) {
            const methods = ['quota_before', 'category_detail', 'quota_after'];
            const index = receipt.steps.length - 1;
            if (receipt.status !== 'in_flight' || index < 0 || methods[index] !== requestStep ||
                receipt.steps[index].method !== requestStep || receipt.steps[index].sentAt !== null ||
                !receipt.steps.slice(0, index).every(step => step.externalRequestState === 'succeeded') ||
                job.externalRequestState !== (index === 0 ? 'not_sent' : 'in_flight')) {
              throw domain.block(`${domain.codePrefix}_ALREADY_ATTEMPTED`, 'ALREADY_ATTEMPTED');
            }
            if (index > 0) return { job: clone(job), [domain.sourceKey]: clone(source), scope: clone(job.scopeBinding), admissionDecision };
          } else if (requestStep !== null || receipt.status !== "in_flight" || receipt.steps.length !== 1 || receipt.steps[0].sentAt !== null || job.externalRequestState !== "not_sent") {
            throw domain.block(`${domain.codePrefix}_ALREADY_ATTEMPTED`, "ALREADY_ATTEMPTED");
          }
          const next = markSoftwareJobExternalRequestStarted({ job, workerId, leaseId, serverTime: observedAt,
            externalRequestRef: `${domain.requestPrefix}:${jobId}` });
          const jobs = softwareJobsInDocument(document); jobs[jobs.findIndex(entry => entry.jobId === jobId)] = clone(next);
          return { job: clone(next), [domain.sourceKey]: clone(source), scope: clone(job.scopeBinding), admissionDecision };
        }
        return { job: clone(job), [domain.sourceKey]: clone(source), scope: clone(job.scopeBinding), admissionDecision };
      } catch (error) { domain.throwExecutionError(error); }
  }
  function settlePreSkuRead(domain, { document, jobId, workerId, leaseId, observedAt }) {
      const original = findSoftwareJobInDocument(document, jobId);
      if (!domain.isJob(original) || original.workerId !== workerId || original.leaseId !== leaseId) throw new Error(`${domain.codePrefix}_HOLDER_CONFLICT`);
      if (["completed", "failed", "unknown_outcome"].includes(original.status)) {
        return { job: clone(original), nextJob: null, continuationBlocked: true, continuationBlocker: "ALREADY_SETTLED" };
      }
      const job = domain.settle(document, { jobId, workerId, leaseId }, observedAt);
      if (job.status !== "completed") return { job: clone(job), nextJob: null, continuationBlocked: true, continuationBlocker: job.failureClass };
      try {
        const source = currentCandidate(document, job, observedAt);
        const nextRequest = domain.nextRequest({ source, scope: job.scopeBinding, receipts: domain.receipts(document, job) });
        if (nextRequest === null) return { job: clone(job), nextJob: null, continuationBlocked: false, continuationBlocker: null };
        const index = job.scopeBinding.requestIndex + 1;
        const authorizations = document.runtime.softwareJobAuthorizationRecords.filter(record => record.action === domain.jobType &&
          record.scopeBinding[domain.subjectKey] === job.subject[domain.subjectKey] && record.scopeBinding.sourceRevision === job.revision && record.scopeBinding.requestIndex === index);
        if (authorizations.length !== 1) throw new Error(`${domain.codePrefix}_NEXT_AUTHORIZATION_REQUIRED`);
        const next = domain.createJob({ scope: authorizations[0].scopeBinding, ownerUserId: job.ownerUserId, createdAt: observedAt });
        if (!isDeepStrictEqual(next.scopeBinding.request, nextRequest)) throw new Error(`${domain.codePrefix}_NEXT_REQUEST_CONFLICT`);
        // Stage only queue/permit changes. A broken next step must not roll back
        // this request's accepted receipt, nor consume a permit without a job.
        const staged = { ...document, runtime: { ...document.runtime,
          softwareJobs: clone(document.runtime.softwareJobs),
          softwareJobAuthorizationRecords: clone(document.runtime.softwareJobAuthorizationRecords) } };
        const nextJob = enqueuePreSkuRead(domain, { document: staged, job: next, observedAt });
        document.runtime.softwareJobs = staged.runtime.softwareJobs;
        document.runtime.softwareJobAuthorizationRecords = staged.runtime.softwareJobAuthorizationRecords;
        return { job: clone(job), nextJob, continuationBlocked: false, continuationBlocker: null };
      } catch (error) {
        try { domain.throwExecutionError(error); }
        catch (classified) {
          if (!(classified instanceof domain.Error)) return { job: clone(job), nextJob: null,
            continuationBlocked: true, continuationBlocker: "UNEXPECTED_SYSTEM_ERROR", unexpectedContinuationError: classified };
          return { job: clone(job), nextJob: null, continuationBlocked: true, continuationBlocker: classified.code };
        }
      }
  }
  const store = {
    boundaryType: "software_job_store",
    persistenceClass: "business_state_repository",
    multiUserReady: repositoryBoundary.multiUserReady,
    async enqueue(job) {
      if (isDESoftwareJob(job)||job?.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE) throw new Error("SOFTWARE_JOB_DOMAIN_HANDOFF_REQUIRED");
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        if (isASupplierImageSearchSoftwareJob(job)) {
          const existing = softwareJobsInDocument(document).find(entry => entry.jobId === job.jobId);
          const enqueued = store.enqueueASupplierImageSearchInDocument({ document, job, observedAt });
          return { changed: !existing, ...(!existing ? { document } : {}), result: enqueued };
        }
        if (isAProductDetailSoftwareJob(job)) {
          const existing = softwareJobsInDocument(document).find(entry => entry.jobId === job.jobId);
          const enqueued = store.enqueueAProductDetailInDocument({ document, job, observedAt });
          return { changed: !existing, ...(!existing ? { document } : {}), result: enqueued };
        }
        if (isADiscoverySoftwareJob(job)) {
          const existing = softwareJobsInDocument(document).find(entry => entry.jobId === job.jobId);
          const enqueued = store.enqueueADiscoveryInDocument({ document, job, observedAt });
          return { changed: !existing, ...(!existing ? { document } : {}), result: enqueued };
        }
        currentCandidate(document, job, observedAt);
        const existing = softwareJobsInDocument(document).find((entry) => entry.idempotencyKey === job.idempotencyKey);
        if (existing) {
          const outcome = enqueueSoftwareJobInDocument(document, job);
          return { changed: outcome.changed, result: outcome.job };
        }
        const admittedJob = job.scopeBinding
          ? bindSoftwareJobAdmissionForEnqueue({
            document,
            job,
            observedAt,
            phase: "enqueue_current"
          })
          : job;
        const outcome = enqueueSoftwareJobInDocument(document, admittedJob);
        return { changed: outcome.changed, ...(outcome.changed ? { document } : {}), result: outcome.job };
      });
    },
    async get(jobId) {
      return (await readJobs()).find((entry) => entry.jobId === jobId) || null;
    },
    async findByIdempotencyKey(idempotencyKey) {
      return (await readJobs()).find((entry) => entry.idempotencyKey === idempotencyKey) || null;
    },
    async listAssignable({ worker, limit = 1, includeRejections = false, jobType = null }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("SOFTWARE_JOB_STORE_LIMIT_INVALID");
      if (jobType !== null && !SOFTWARE_JOB_TYPES.includes(jobType)) throw new Error("SOFTWARE_JOB_STORE_JOB_TYPE_INVALID");
      const observedAt = observedServerTime();
      const document = await businessStateRepository.readSnapshot();
      const revisions = new Map((document.candidates || []).map((candidate) => [candidate.id, Number(candidate.dataRevision)]));
      const assignable = [];
      const rejected = [];
      for (const job of clone(document.runtime?.softwareJobs || [])) {
        if (jobType !== null && job.jobType !== jobType) continue;
        if (job.status !== "queued" || job.attempt !== 0) continue;
        const currentRevision = isADiscoverySoftwareJob(job) ? document.runtime?.aDiscoveryBatches?.[job.subject.batchId]?.revision : isAccountPreparationSoftwareJob(job)
          ? document.runtime?.ozonAccountPreparations?.[job.subject.preparationId]?.revision : revisions.get((isAProductDetailSoftwareJob(job) || isASupplierImageSearchSoftwareJob(job)) ? job.subject.candidateId : job.candidateId);
        if (currentRevision !== job.revision) {
          rejected.push(assignmentRejection(job, new Error("SOFTWARE_JOB_REVISION_CONFLICT")));
          continue;
        }
        if (!softwareJobRequiresDomainSettlement(job) && !workerSatisfiesCapabilities(worker, job.requiredCapabilities)) continue;
        try {
          const trustedWorker = registryWorkerForDescriptor(job, worker);
          if (!workerSatisfiesCapabilities(trustedWorker, job.requiredCapabilities)) continue;
          const candidate = currentCandidate(document, job, observedAt);
          if (isASupplierImageSearchSoftwareJob(job)) assertASupplierImageSearchAdmission({ document, candidate, scope: job.scopeBinding,
            authorization: document.runtime.softwareJobAuthorizationRecords?.find(record => record.authorizationId === job.scopeBinding.authorizationRef),
            receipts: imageSearchReceipts(document, job, { excludeCurrent: true }), checkedAt: observedAt });
          if (isAProductDetailSoftwareJob(job)) assertAProductDetailAdmission({ document, candidate, scope: job.scopeBinding,
            authorization: document.runtime.softwareJobAuthorizationRecords?.find(record => record.authorizationId === job.scopeBinding.authorizationRef),
            receipts: detailReceipts(document, job, { excludeCurrent: true }), checkedAt: observedAt });
          if (isADiscoverySoftwareJob(job)) assertADiscoveryAdmission({ batch: candidate, scope: job.scopeBinding,
            authorization: document.runtime.softwareJobAuthorizationRecords?.find(record => record.authorizationId === job.scopeBinding.authorizationRef),
            receipts: batchReceipts(document, job, { excludeCurrent: true }), checkedAt: observedAt });
          const executionBinding = currentExecutionBinding(candidate, job, trustedWorker, observedAt);
          assertSoftwareJobAdmittedForClaim({ document, job, worker: trustedWorker, observedAt, executionBinding });
          if (assignable.length < limit) assignable.push(job);
        } catch (error) {
          if (isWorkerSpecificAdmissionRejection(error)) {
            if (includeRejections) rejected.push(assignmentRejection(job, error));
            continue;
          }
          if (isADiscoverySoftwareJob(job) && error instanceof ADiscoveryError && ["BATCH_CHANGED", "AUTHORIZATION_EXPIRED", "SEQUENCE_INVALID"].includes(error.code)) {
            rejected.push(assignmentRejection(job, new ADiscoveryExecutionBlockedError(error.message))); continue;
          }
          if (isASupplierImageSearchSoftwareJob(job) && error instanceof ASupplierImageSearchError && (["SEQUENCE_INVALID"].includes(error.code) || A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(error.code))) {
            try { throwASupplierImageSearchExecutionError(error); } catch (known) { rejected.push(assignmentRejection(job, known)); continue; }
          }
          if (isAProductDetailSoftwareJob(job) && error instanceof AProductDetailError && ["CANDIDATE_CHANGED", "AUTHORIZATION_EXPIRED", "SEQUENCE_INVALID"].includes(error.code)) {
            try { throwAProductDetailExecutionError(error); } catch (known) { rejected.push(assignmentRejection(job, known)); continue; }
          }
          if (error instanceof ASupplierImageSearchExecutionBlockedError || error instanceof AProductDetailExecutionBlockedError || error instanceof ADiscoveryExecutionBlockedError || isPerJobAdmissionRejection(error)) {
            rejected.push(assignmentRejection(job, error));
            continue;
          }
          throw error;
        }
      }
      if (includeRejections) {
        return Object.freeze({ assignable: clone(assignable), rejected: clone(rejected) });
      }
      return clone(assignable);
    },
    async listAssignableWithDiagnostics({ worker, limit = 1, jobType = null } = {}) {
      return store.listAssignable({ worker, limit, includeRejections: true, jobType });
    },
    async claim({ jobId, worker, leaseId, leaseDurationMs }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex((entry) => entry.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        const discovery = isADiscoverySoftwareJob(jobs[index]);
        try {
        const candidate = currentCandidate(document, jobs[index], observedAt);
        if (isASupplierImageSearchSoftwareJob(jobs[index])) assertASupplierImageSearchAdmission({ document, candidate, scope: jobs[index].scopeBinding,
          authorization: document.runtime.softwareJobAuthorizationRecords.find(record => record.authorizationId === jobs[index].scopeBinding.authorizationRef),
          receipts: imageSearchReceipts(document, jobs[index], { excludeCurrent: true }), checkedAt: observedAt });
        if (isAProductDetailSoftwareJob(jobs[index])) assertAProductDetailAdmission({ document, candidate, scope: jobs[index].scopeBinding,
          authorization: document.runtime.softwareJobAuthorizationRecords.find(record => record.authorizationId === jobs[index].scopeBinding.authorizationRef),
          receipts: detailReceipts(document, jobs[index], { excludeCurrent: true }), checkedAt: observedAt });
        if (discovery) assertADiscoveryAdmission({ batch: candidate, scope: jobs[index].scopeBinding,
          authorization: document.runtime.softwareJobAuthorizationRecords.find(record => record.authorizationId === jobs[index].scopeBinding.authorizationRef),
          receipts: batchReceipts(document, jobs[index], { excludeCurrent: true }), checkedAt: observedAt });
        const trustedWorker = registryWorkerForDescriptor(jobs[index], worker);
        const executionBinding = currentExecutionBinding(candidate, jobs[index], trustedWorker, observedAt);
        const decision = assertSoftwareJobAdmittedForClaim({ document, job: jobs[index], worker: trustedWorker, observedAt, executionBinding });
        const source = isDESoftwareJob(jobs[index])||jobs[index].jobType===D_PLATFORM_OBSERVATION_JOB_TYPE ? bindSoftwareJobAdmissionDecision(jobs[index], decision) : jobs[index];
        const claimed = claimSoftwareJobLease({
          job: source, worker: trustedWorker, leaseId, serverTime: observedAt, leaseDurationMs
        });
        jobs[index] = clone(claimed);
        return { changed: true, document, result: claimed };
        } catch (error) { if (isASupplierImageSearchSoftwareJob(jobs[index])) throwASupplierImageSearchExecutionError(error); if (isAProductDetailSoftwareJob(jobs[index])) throwAProductDetailExecutionError(error); if (discovery) throwADiscoveryExecutionError(error); throw error; }
      });
    },
    enqueueADiscoveryInDocument(input) { return enqueuePreSkuRead(discoveryReadDomain, input); },
    assertADiscoveryExecutionInDocument(input) { return assertPreSkuReadExecution(discoveryReadDomain, input); },
    settleADiscoveryInDocument(input) { return settlePreSkuRead(discoveryReadDomain, input); },
    enqueueAProductDetailInDocument(input) { return enqueuePreSkuRead(productDetailReadDomain, input); },
    assertAProductDetailExecutionInDocument(input) { return assertPreSkuReadExecution(productDetailReadDomain, input); },
    settleAProductDetailInDocument(input) { return settlePreSkuRead(productDetailReadDomain, input); },
    enqueueASupplierImageSearchInDocument(input) { return enqueuePreSkuRead(imageSearchReadDomain, input); },
    assertASupplierImageSearchExecutionInDocument(input) { return assertPreSkuReadExecution(imageSearchReadDomain, input); },
    settleASupplierImageSearchInDocument(input) { return settlePreSkuRead(imageSearchReadDomain, input); },
    settleDInitialImportStoppedInDocument({document,jobId,workerId,leaseId,observedAt}){
      return clone(settleDInitialImportStoppedSoftwareJobInDocument(document,{jobId,workerId,leaseId},observedAt));
    },
    /** 把一次被误停的导入执行放回 waiting_platform：作业侧与 parkDProductionWaiting 收敛到同一形状。 */
    recoverDInitialImportStoppedJobInDocument({document,jobId,observedAt}){
      const job=findSoftwareJobInDocument(document,jobId);
      const candidate=document.candidates.find(value=>value.id===job.candidateId);
      const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
      const next={...clone(job),status:'waiting_platform',externalRequestState:'succeeded',
        failureClass:null,resultRef:null,resultEnvelope:null,completedAt:null,
        leaseId:null,leaseExpiresAt:null,lastProgressAt:observedAt,
        platformContinuation:clone(state.platformContinuation)};
      // 作业与执行状态互指必须一致，否则观察链的 source() 会判来源冲突。
      state.softwareJobRef={...clone(state.softwareJobRef),workerId:next.workerId,leaseId:null};
      assertSafeRuntimeRecord(next,'softwareJob');
      const jobs=softwareJobsInDocument(document);jobs[jobs.findIndex(value=>value.jobId===jobId)]=next;
      const waiting=readDProductionJobWaiting({candidate,job:next,observedAt});
      return {job:clone(next),platformContinuation:waiting.platformContinuation};
    },
    parkDProductionWaitingInDocument({document,candidate,jobId,workerId,leaseId,observedAt}){
      const job=findSoftwareJobInDocument(document,jobId);
      assertSoftwareJobExecutionLease({job,workerId,leaseId,serverTime:observedAt});
      const current=candidate??document.candidates.find(value=>value.id===job.candidateId);
      const waiting=readDProductionJobWaiting({candidate:current,job,observedAt});
      const next={...clone(job),status:'waiting_platform',externalRequestState:'succeeded',completedAt:null,
        lastProgressAt:observedAt,leaseId:null,leaseExpiresAt:null,platformContinuation:clone(waiting.platformContinuation)};
      assertSafeRuntimeRecord(next,'softwareJob');
      const jobs=softwareJobsInDocument(document);jobs[jobs.findIndex(value=>value.jobId===jobId)]=next;return clone(next);
    },
    enqueueDPlatformObservationInDocument({document,candidate,sourceDJob,scope,policy,observedAt}){
      assertDPlatformObservationScope(scope);
      if(scope.sourceDJobId!==sourceDJob.jobId||!isDeepStrictEqual(scope.policy,policy))throw new Error('D_PLATFORM_OBSERVATION_ENQUEUE_SOURCE_CONFLICT');
      const duplicates=softwareJobsInDocument(document).filter(job=>job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE&&job.scopeBinding.sourceDJobId===sourceDJob.jobId&&job.scopeBinding.queryIndex===scope.queryIndex);
      if(duplicates.length){if(duplicates.length!==1||!isDeepStrictEqual(duplicates[0].scopeBinding,scope))throw new Error('D_PLATFORM_OBSERVATION_JOB_CONFLICT');return clone(duplicates[0]);}
      const job=createSoftwareJobEnvelope({jobId:`d-observation-job:${scope.inputFingerprint}`,candidateId:scope.candidateId,skuPackageId:scope.skuPackageId,
        revision:scope.revision,jobType:D_PLATFORM_OBSERVATION_JOB_TYPE,createdAt:observedAt,requestedByUserId:sourceDJob.requestedByUserId,
        ownerUserId:sourceDJob.ownerUserId,requiredCapabilities:['ozon-independent-readback'],idempotencyKey:`d-observation:${scope.inputFingerprint}`,scopeBinding:scope});
      assertDPlatformObservationJobSource({document,job,observedAt});
      const admitted=bindSoftwareJobAdmissionForEnqueue({document,job,observedAt,phase:'enqueue_current'});
      const outcome=enqueueSoftwareJobInDocument(document,admitted);
      const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
      state.platformContinuation.activeObservationJobId=admitted.jobId;
      state.attempt.platformContinuation=clone(state.platformContinuation);
      sourceDJob.platformContinuation=clone(state.platformContinuation);
      return clone(outcome.job);
    },
    assertDPlatformObservationExecutionInDocument({document,jobId,workerId,leaseId,observedAt}){
      const job=findSoftwareJobInDocument(document,jobId);
      const source=assertDPlatformObservationSend({document,job,workerId,leaseId,observedAt});
      const worker=registryWorkerForJob(job,workerId,{requireClaimSnapshot:true});
      assertSoftwareJobExecutionLease({job,workerId,leaseId,serverTime:observedAt});
      const executionBinding=currentExecutionBinding(source.candidate,job,worker,observedAt);
      const admissionDecision=assertSoftwareJobAdmittedForExternalRequest({document,job,worker,workerId,observedAt,executionBinding});
      return {job:clone(job),admissionDecision,worker};
    },
    recordDPlatformObservationInDocument({document,jobId,workerId,leaseId,result,observedAt}){
      const job=findSoftwareJobInDocument(document,jobId);
      if(job.workerId!==workerId||job.leaseId!==leaseId)throw new Error('D_PLATFORM_OBSERVATION_HOLDER_CONFLICT');
      const outcome=recordObservation({document,job,result,observedAt});
      const settled=settleDPlatformObservationSoftwareJobInDocument(document,{jobId,workerId,leaseId},observedAt);
      outcome.sourceDJob.platformContinuation=clone(outcome.state.platformContinuation);
      if(outcome.state.status==='failed'||outcome.state.status==='unknown_outcome'){
        settleDPlatformStoppedSoftwareJobInDocument(document,{candidate:outcome.candidate,jobId:outcome.sourceDJob.jobId},observedAt);
      }else if(outcome.nextScope!==null){
        store.enqueueDPlatformObservationInDocument({document,candidate:outcome.candidate,sourceDJob:outcome.sourceDJob,
          scope:outcome.nextScope,policy:outcome.nextScope.policy,observedAt});
      }
      return {job:clone(settled.job),disposition:settled.terminal.disposition};
    },
    async listDPlatformObservationJobs({limit=1}={}){
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('SOFTWARE_JOB_STORE_LIMIT_INVALID');
      const document=await businessStateRepository.readSnapshot(),at=observedServerTime();
      return clone((document.runtime.softwareJobs??[]).filter(job=>job.jobType===D_PLATFORM_OBSERVATION_JOB_TYPE&&job.status==='queued'&&
        Date.parse(job.scopeBinding.nextEligibleAt)<=Date.parse(at))
        .sort((a,b)=>a.scopeBinding.nextEligibleAt.localeCompare(b.scopeBinding.nextEligibleAt)).slice(0,limit));
    },
    async rejectDPlatformObservation({jobId,failureClass}){
      return businessStateRepository.transact(document=>{
        const observedAt=observedServerTime(),job=findSoftwareJobInDocument(document,jobId);
        const outcome=rejectDPlatformObservationInDocument({document,job,observedAt,failureClass});
        const settled=settleDPlatformObservationSoftwareJobInDocument(document,{jobId,workerId:null,leaseId:null},observedAt);
        outcome.sourceDJob.platformContinuation=clone(outcome.state.platformContinuation);
        settleDPlatformStoppedSoftwareJobInDocument(document,{candidate:outcome.candidate,jobId:outcome.sourceDJob.jobId},observedAt);
        return {changed:true,document,result:{job:clone(settled.job),disposition:settled.terminal.disposition}};
      });
    },
    async listDRemainingInventoryJobs({limit=1}={}){
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('SOFTWARE_JOB_STORE_LIMIT_INVALID');
      const document=await businessStateRepository.readSnapshot();
      return softwareJobsInDocument(document).filter(job=>job.jobType===D_PRODUCTION_EXECUTION_JOB_TYPE&&job.status==='waiting_platform'&&job.externalRequestState==='succeeded'&&
        job.attempt===1&&job.leaseId===null&&job.platformContinuation?.schemaVersion==='d-platform-continuation-v1'&&
        job.platformContinuation.status==='prerequisites_observed'&&job.platformContinuation.inventoryWriteState==='not_sent').slice(0,limit)
        .map(job=>({sourceDJobId:job.jobId,observationJobId:job.platformContinuation.observationHistory.at(-1).jobId}));
    },
    stopDRemainingInventoryBeforeSendInDocument({document,jobId,workerId,leaseId,observedAt}){
      const job=findSoftwareJobInDocument(document,jobId);
      assertSoftwareJobStrictRef(workerId,'workerId');
      assertSoftwareJobStrictRef(leaseId,'leaseId');
      if(job?.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE||job.status!=='claimed'||job.attempt!==1||
        job.workerId!==workerId||job.leaseId!==leaseId||job.externalRequestState!=='not_sent'||
        job.externalRequestRef!==null||job.completedAt!==null||
        ![observedAt,job.startedAt,job.lastProgressAt,job.leaseExpiresAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||
        Date.parse(job.lastProgressAt)<Date.parse(job.startedAt)||Date.parse(observedAt)<Date.parse(job.lastProgressAt)||
        Date.parse(job.leaseExpiresAt)<=Date.parse(job.lastProgressAt)){
        throw new Error('D_INVENTORY_PRE_SEND_STOP_HOLDER_INVALID');
      }
      const stopped=reconcileInventory(document,job,observedAt);
      if(stopped===null)throw new Error('D_INVENTORY_PRE_SEND_STOP_PROOF_REQUIRED');
      return clone(stopped);
    },
    async rejectDRemainingInventory({jobId,observationJobId,failureClass}){
      return businessStateRepository.transact(document=>{
        const observedAt=observedServerTime(),job=findSoftwareJobInDocument(document,jobId);
        rejectDRemainingInventoryInDocument({document,job,observationJobId,observedAt,failureClass});
        const candidate=document.candidates.find(value=>value.id===job.candidateId);
        job.platformContinuation=clone(candidate.lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation);
        const settled=settleDPlatformStoppedSoftwareJobInDocument(document,{candidate,jobId},observedAt);
        return {changed:true,document,result:clone(settled)};
      });
    },
    /** 主人自己填了库存：只登记、不写平台，不生成 productionRecord、不排 E。 */
    async registerOwnerWrittenInventory({jobId,observationJobId,verifyInventoryPrerequisiteSource,actorId}){
      return businessStateRepository.transact(document=>{
        const observedAt=observedServerTime(),job=findSoftwareJobInDocument(document,jobId);
        registerOwnerWrittenInventoryInDocument({document,job,observationJobId,observedAt,verifyInventoryPrerequisiteSource,actorId});
        const candidate=document.candidates.find(value=>value.id===job.candidateId);
        job.platformContinuation=clone(candidate.lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation);
        const settled=settleDOwnerStockRegisteredSoftwareJobInDocument(document,{candidate,jobId},observedAt);
        return {changed:true,document,result:clone(settled)};
      });
    },
    async claimDRemainingInventory({jobId,worker,leaseId,leaseDurationMs,observationJobId,verifyInventoryPrerequisiteSource}){
      return businessStateRepository.transact(document=>{
        const observedAt=observedServerTime(),job=findSoftwareJobInDocument(document,jobId);
        if(job?.jobType!==D_PRODUCTION_EXECUTION_JOB_TYPE||job.status!=='waiting_platform'||job.externalRequestState!=='succeeded'||job.leaseId!==null||job.attempt!==1)throw new Error('D_INVENTORY_CONTINUATION_JOB_INVALID');
        const trustedWorker=registryWorkerForDescriptor(job,worker);
        if(!Number.isSafeInteger(leaseDurationMs)||leaseDurationMs<1000||leaseDurationMs>1800000||typeof leaseId!=='string'||!leaseId)throw new Error('D_INVENTORY_CONTINUATION_LEASE_INVALID');
        const candidate=document.candidates.find(value=>value.id===job.candidateId);
        readDProductionJobWaiting({candidate,job,observedAt});
        assertSoftwareJobStrictRef(leaseId,'leaseId');
        const source=resumeDRemainingInventoryInDocument({document,job,workerId:trustedWorker.workerId,leaseId,observationJobId,
          verifyInventoryPrerequisiteSource,checkedAt:observedAt});
        const executionBinding=currentExecutionBinding(candidate,job,trustedWorker,observedAt);
        const decision=assertSoftwareJobAdmittedForExternalRequest({document,job,worker:trustedWorker,workerId:trustedWorker.workerId,observedAt,executionBinding});
        const next={...clone(bindSoftwareJobAdmissionDecision(job,decision)),status:'claimed',externalRequestState:'not_sent',externalRequestRef:null,
          workerId:trustedWorker.workerId,workerVersion:trustedWorker.version,workerCapabilitiesSnapshot:clone(trustedWorker.capabilities),leaseId,
          leaseExpiresAt:new Date(Date.parse(observedAt)+leaseDurationMs).toISOString(),lastProgressAt:observedAt,platformContinuation:clone(source.state.platformContinuation)};
        assertSafeRuntimeRecord(next,'softwareJob');const jobs=softwareJobsInDocument(document);jobs[jobs.findIndex(value=>value.jobId===jobId)]=next;
        return {changed:true,document,result:clone(next)};
      });
    },
    async recordProgress({ jobId, workerId, leaseId, progressRef }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex((entry) => entry.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        const candidate = currentCandidate(document, jobs[index], observedAt);
        const worker = registryWorkerForJob(jobs[index], workerId, { requireClaimSnapshot: true });
        assertSoftwareJobAdmittedForExternalRequest({
          document,
          job: jobs[index],
          workerId,
          worker,
          observedAt,
          executionBinding: currentExecutionBinding(candidate, jobs[index], worker, observedAt)
        });
        const next = recordSoftwareJobProgress({
          job: jobs[index], workerId, leaseId, progressRef, serverTime: observedAt
        });
        jobs[index] = clone(next);
        return { changed: true, document, result: next };
      });
    },
    async markExternalRequestStarted({ jobId, workerId, leaseId, externalRequestRef }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex((entry) => entry.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        const candidate = currentCandidate(document, jobs[index], observedAt);
        const worker = registryWorkerForJob(jobs[index], workerId, { requireClaimSnapshot: true });
        assertSoftwareJobAdmittedForExternalRequest({
          document,
          job: jobs[index],
          workerId,
          worker,
          observedAt,
          executionBinding: currentExecutionBinding(candidate, jobs[index], worker, observedAt)
        });
        const next = markSoftwareJobExternalRequestStarted({
          job: jobs[index], workerId, leaseId, externalRequestRef, serverTime: observedAt
        });
        jobs[index] = clone(next);
        return { changed: true, document, result: next };
      });
    },
    assertDEExecutionInDocument({ document, jobId, workerId, leaseId, observedAt }) {
      const job = findSoftwareJobInDocument(document, jobId);
      if (!isDESoftwareJob(job)) throw new Error("SOFTWARE_JOB_STORE_DE_JOB_REQUIRED");
      const candidate = currentCandidate(document, job, observedAt);
      const worker = registryWorkerForJob(job, workerId, { requireClaimSnapshot: true });
      assertSoftwareJobExecutionLease({ job, workerId, leaseId, serverTime: observedAt });
      const executionBinding = currentExecutionBinding(candidate, job, worker, observedAt);
      const admissionDecision = assertSoftwareJobAdmittedForExternalRequest({ document, job, workerId, worker, observedAt, executionBinding });
      return Object.freeze({ job: clone(job), candidate: clone(candidate), worker, admissionDecision });
    },
    assertC1PaidKeywordExecutionInDocument({ document, jobId, workerId, leaseId, observedAt }) {
      try {
        const job = findSoftwareJobInDocument(document, jobId);
        const frozen = readC1PaidKeywordSourceForSettlement(document, job);
        const candidate = currentCandidate(document, job, observedAt);
        const worker = registryWorkerForJob(job, workerId, { requireClaimSnapshot: true });
        assertSoftwareJobExecutionLease({ job, workerId, leaseId, serverTime: observedAt });
        const admissionDecision = assertSoftwareJobAdmittedForExternalRequest({ document, job, workerId, worker, observedAt });
        const source = frozen.candidate.lifecycleV11, current = candidate.lifecycleV11;
        const fields = ["skuPackage", "c1PaidKeywordEvidenceJobRefV1", "c1PaidKeywordEvidenceInputArtifactRefV1",
          "c1PaidKeywordEvidenceRuntimeInputV1", "c1PaidKeywordEvidenceSeerfarRequestV1", "c1KeywordPlanningEvidenceV1"];
        if (fields.some(field => !isDeepStrictEqual(current[field], source[field]))) {
          throw new C1PaidKeywordExecutionBlockedError("C1_PAID_KEYWORD_WORKER_SCOPE_DRIFT");
        }
        return Object.freeze({ job: clone(job), candidate: clone(candidate), worker, admissionDecision });
      } catch (error) {
        if (error instanceof C1PaidKeywordExecutionBlockedError) throw error;
        const code = error?.constructor === Error ? error.message.split(":", 1)[0] : null;
        if (KEYWORD_EXECUTION_BLOCKS.has(code)) throw new C1PaidKeywordExecutionBlockedError(code);
        throw error;
      }
    },
    settleC1PaidKeywordFailureInDocument({ document, jobId, workerId, leaseId, observedAt, status, externalRequestState, failureClass }) {
      const job = findSoftwareJobInDocument(document, jobId);
      readC1PaidKeywordSourceForSettlement(document, job);
      assertSoftwareJobStrictRef(workerId, "workerId"); assertSoftwareJobStrictRef(leaseId, "leaseId");
      if (job.workerId !== workerId || job.leaseId !== leaseId) throw new Error("SOFTWARE_JOB_LEASE_REJECTED");
      if (["completed", "failed", "unknown_outcome"].includes(job.status)) return clone(job);
      return clone(settleC1PaidKeywordFailureSoftwareJobInDocument(document, {
        jobId, workerId, leaseId, status, externalRequestState, failureClass,
        externalRequestRef: job.externalRequestRef, resultRef: null, resultEnvelope: null
      }, observedAt));
    },
    async listC1KeywordContinuationJobs({ limit = 1, jobId = null } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("SOFTWARE_JOB_STORE_LIMIT_INVALID");
      if (jobId !== null) assertSoftwareJobStrictRef(jobId, "jobId");
      const document = await businessStateRepository.readSnapshot(), result = [];
      for (const job of document.runtime?.softwareJobs || []) {
        if (job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || job.status !== "completed" ||
            job.externalRequestState !== "succeeded" || job.resultEnvelope?.applicationDisposition !== "applied" ||
            jobId !== null && job.jobId !== jobId) continue;
        const candidate = document.candidates.find(value => value.id === job.candidateId), lifecycle = candidate?.lifecycleV11;
        if (!candidate || candidate.dataRevision !== job.revision + 1 || lifecycle?.skuPackage?.skuPackageId !== job.skuPackageId ||
            candidate.executionRuntime?.exceptionCase?.status === "open" ||
            (candidate.executionRuntime?.technicalFailure?.status === "stopped" &&
              candidate.executionRuntime.technicalFailure.softwareJobId === job.jobId) ||
            lifecycle.skuPackage.businessPhase !== "C1" || lifecycle.c1AiDraftJobRefV1 || lifecycle.c1AiDraftRequestV1 ||
            lifecycle.skuPackage.c1ProductPlan?.status === "seo_draft_ready") continue;
        readC1PaidKeywordSourceForSettlement(document, job);
        result.push(assertC1PaidKeywordContinuationResult({ candidate, job }));
        if (result.length === limit) break;
      }
      return clone(result);
    },
    async recordC1GatewayAcceptance({ jobId, workerId, leaseId, requestFingerprint, gatewayJobId }) {
      return businessStateRepository.transact(document => {
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex(job => job.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        const outcome = recordC1GatewayAcceptance({ job: jobs[index], workerId, leaseId, requestFingerprint, gatewayJobId,
          serverTime: observedServerTime() });
        if (!outcome.changed) return { changed: false, result: outcome.job };
        jobs[index] = clone(outcome.job);
        return { changed: true, document, result: outcome.job };
      });
    },
    async beginC1AiDraftReconciliation({ candidateId, expectedRevision, jobId, workerId, leaseId, leaseDurationMs }) {
      return businessStateRepository.transact(document => {
        const job = findSoftwareJobInDocument(document, jobId);
        if (job?.jobType !== C1_AI_DRAFT_JOB_TYPE || job.candidateId !== candidateId || job.revision !== expectedRevision || job.workerId !== workerId) {
          throw new Error("C1_DRAFT_RECONCILIATION_SCOPE_INVALID");
        }
        registryWorkerForJob(job, workerId);
        if (job.c1ResultReconciliation && ["completed", "failed"].includes(job.status) &&
            job.c1ResultReconciliation.readAttempt.status === job.status) return { changed: false, result: { acquired: false, terminal: true, job: clone(job) } };
        const observedAt = observedServerTime();
        const candidate = currentCandidate(document, job, observedAt);
        const source = readC1AiDraftReconciliationSource(job);
        const ref = candidate.lifecycleV11?.c1AiDraftJobRefV1;
        if (ref?.jobId !== job.jobId || ref.candidateId !== job.candidateId || ref.skuPackageId !== job.skuPackageId ||
            ref.sourceRevision !== job.scopeBinding.sourceRevision || ref.resultRevision !== job.revision ||
            ref.inputFingerprint !== job.scopeBinding.inputFingerprint ||
            !isDeepStrictEqual(candidate.lifecycleV11.c1AiDraftRequestV1, source.request)) throw new Error("C1_DRAFT_RECONCILIATION_REQUEST_CONFLICT");
        assertCurrentC1AiDraftRequest({ skuPackage: candidate.lifecycleV11.skuPackage, request: source.request });
        // This reads the original consumed permission. It neither refreshes its
        // expiry nor consumes a second use for the already-issued request.
        if (!Array.isArray(document.runtime.softwareJobAuthorizationRecords) ||
            !Array.isArray(document.runtime.softwareJobCredentialBindings)) throw new Error("C1_DRAFT_RECONCILIATION_ADMISSION_CONFLICT");
        const authorizations = document.runtime.softwareJobAuthorizationRecords.filter(record => record.authorizationId === job.scopeBinding.authorizationRef);
        const credentials = document.runtime.softwareJobCredentialBindings.filter(record => record.credentialAlias === job.scopeBinding.credentialAlias && isDeepStrictEqual(record.scopeBinding, job.scopeBinding));
        if (authorizations.length !== 1 || authorizations[0].authorizationType !== "paid_ai_draft" ||
            authorizations[0].useCount !== 1 || authorizations[0].maxUses !== 1 || authorizations[0].consumedByJobId !== job.jobId ||
            !isDeepStrictEqual(authorizations[0].scopeBinding, job.scopeBinding) || credentials.length !== 1 ||
            !credentials[0].allowedWorkerIds.includes(workerId)) throw new Error("C1_DRAFT_RECONCILIATION_ADMISSION_CONFLICT");
        const outcome = beginC1AiDraftResultReconciliation({ job, workerId, leaseId, leaseDurationMs, serverTime: observedAt });
        if (outcome.changed) {
          const jobs = softwareJobsInDocument(document);
          jobs[jobs.findIndex(value => value.jobId === jobId)] = clone(outcome.job);
        }
        return { changed: outcome.changed, ...(outcome.changed ? { document } : {}), result: outcome };
      });
    },
    async settleC1AiDraftReconciliation({ jobId, workerId, attemptId, observationStatus, resultEnvelope = null, failureClass = null }) {
      return businessStateRepository.transact(document => {
        const job = findSoftwareJobInDocument(document, jobId);
        const candidate = document.candidates.find(value => value.id === job?.candidateId);
        const applicationDisposition = observationStatus === "completed" && (!candidate || candidate.dataRevision !== job.revision)
          ? "revision_conflict_not_applied" : "result_recorded_no_candidate_mutation";
        const next = settleC1AiDraftResultReconciliation({ job, workerId, attemptId, observationStatus, resultEnvelope,
          failureClass, applicationDisposition, serverTime: observedServerTime() });
        const jobs = softwareJobsInDocument(document);
        jobs[jobs.findIndex(value => value.jobId === jobId)] = clone(next);
        return { changed: true, document, result: next };
      });
    },
    async settle({ jobId, workerId, leaseId, status, externalRequestState, resultRef, resultEnvelope, failureClass, externalRequestRef }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const before = findSoftwareJobInDocument(document, jobId);
        const candidate = before ? (document.candidates || []).find((entry) => entry.id === before.candidateId) : null;
        const applicationDisposition = status === "completed" && candidate && Number(candidate.dataRevision) !== before.revision
          ? "revision_conflict_not_applied"
          : "result_recorded_no_candidate_mutation";
        const next = settleSoftwareJobInDocument(document, {
          jobId, workerId, leaseId, status, externalRequestState, resultRef, resultEnvelope,
          applicationDisposition, failureClass, externalRequestRef
        }, observedAt);
        return { changed: true, document, result: next };
      });
    },
    async listWaitingPlatform({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("SOFTWARE_JOB_STORE_LIMIT_INVALID");
      const document = await businessStateRepository.readSnapshot();
      return clone((document.runtime?.softwareJobs || [])
        .filter((job) => job.status === "waiting_platform" && job.externalRequestState === "in_flight")
        .slice(0, limit));
    },
    async reconcileAfterRestart({ jobTypes = null } = {}) {
      if (jobTypes !== null && (!Array.isArray(jobTypes) || jobTypes.length < 1 || jobTypes.length > RESTART_FILTER_JOB_TYPES.length ||
          new Set(jobTypes).size !== jobTypes.length || jobTypes.some(type => !RESTART_FILTER_JOB_TYPES.includes(type)))) {
        throw new Error("SOFTWARE_JOB_RESTART_FILTER_INVALID");
      }
      const selectedTypes = jobTypes === null ? null : new Set(jobTypes);
      return businessStateRepository.transact(async (document) => {
        const reconciledAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        let changed = false;
        const reconciled = [];
        for (let index = 0; index < jobs.length; index += 1) {
          const job = jobs[index];
          if (selectedTypes !== null && !selectedTypes.has(job.jobType)) continue;
          if (!["claimed", "waiting_platform"].includes(job.status)) continue;
          if(parkedWaiting(document,job,reconciledAt))continue;
          const generic = reconcileSoftwareJobAfterRestart({ job, serverTime: reconciledAt });
          const local = reconcileObservation(document,job,reconciledAt) ?? reconcileInventory(document,job,reconciledAt) ??
            reconcileASupplierImageSearch(document, job, reconciledAt) ?? reconcileAProductDetail(document, job, reconciledAt) ?? reconcileADiscovery(document, job, reconciledAt) ?? reconcileAccountRead(document, job, reconciledAt) ?? reconcileLocalPreparationAfterVerifiedAssets(document, job, reconciledAt);
          const next = local === null ? generic : local;
          jobs[index] = next;
          reconciled.push(next.jobId);
          changed = true;
        }
        return { changed, ...(changed ? { document } : {}), result: Object.freeze({ reconciled }) };
      });
    },
    async reconcileExpiredLeases() {
      return businessStateRepository.transact(async (document) => {
        const reconciledAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        let changed = false;
        const reconciled = [];
        for (let index = 0; index < jobs.length; index += 1) {
          const job = jobs[index];
          if (!["claimed", "waiting_platform"].includes(job.status)) continue;
          if(parkedWaiting(document,job,reconciledAt))continue;
          let next;
          try {
            next = reconcileExpiredSoftwareJobLease({ job, serverTime: reconciledAt });
          } catch (error) {
            if (String(error?.message || error) === "SOFTWARE_JOB_LEASE_NOT_EXPIRED") continue;
            throw error;
          }
          const local = reconcileObservation(document,job,reconciledAt) ?? reconcileInventory(document,job,reconciledAt) ??
            reconcileASupplierImageSearch(document, job, reconciledAt) ?? reconcileAProductDetail(document, job, reconciledAt) ?? reconcileADiscovery(document, job, reconciledAt) ?? reconcileAccountRead(document, job, reconciledAt) ?? reconcileLocalPreparationAfterVerifiedAssets(document, job, reconciledAt);
          if (local !== null) next = local;
          jobs[index] = next;
          reconciled.push(next.jobId);
          changed = true;
        }
        return { changed, ...(changed ? { document } : {}), result: Object.freeze({ reconciled }) };
      });
    }
  };
  return Object.freeze(store);
}
