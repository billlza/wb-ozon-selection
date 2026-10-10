export { readDProductionJobWaiting } from "./d-platform-observation-contract.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertDEJobAdmissionDecision } from "./d-e-software-job-admission.mjs";
import { assertDProductionRecordSource, assertDProductionReceiptChain, assertDProductionJobScope, createEReadbackJobScope } from "./d-e-software-job-scope.mjs";
import { fingerprintCanonicalRecord, isCanonicalFrozenRef, dProductionJobRound } from "./production-contract-primitives.mjs";
import { assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { assertEReadbackAttempt } from "./e-readback-attempt.mjs";
import { validateSystemCreatedVerificationRecord } from "./e-stage-readback.mjs";
import { assertDAssetTransportCursor, assertDCheckpointSources } from "./d-production-job-cursor.mjs";
import { isDProductionPrewriteFailure, productionJobPrewriteCode, isAssetTransportPrewriteFailure, isDProductionUnknownReason } from "./production-execution-failure.mjs";
import { assertDProductionPreparation } from "./d-production-preparation-contract.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function requireCondition(condition, code) { if (!condition) throw new Error(`DE_JOB_RESULT_${code}`); }
function time(value) {
  requireCondition(typeof value === "string" && Number.isFinite(Date.parse(value)), "TIME_INVALID");
  return Date.parse(value);
}

export function isReconciledDERequest(job) {
  return ["d_production_execution", "e_independent_readback"].includes(job?.jobType) &&
    job.status === "unknown_outcome" && job.externalRequestState === "unknown_outcome" && job.attempt === 1 &&
    ["service_restart_after_external_request", "lease_expired_after_external_request"].includes(job.failureClass) &&
    isCanonicalFrozenRef(job.externalRequestRef) && job.resultRef === null && job.resultEnvelope === null &&
    typeof job.completedAt === "string" && Number.isFinite(Date.parse(job.completedAt));
}

export function readDAssetTransportJobTerminal({ candidate, job, observedAt }) {
  const reconciled = isReconciledDERequest(job);
  requireCondition(job?.jobType === "d_production_execution" && job.attempt === 1 &&
    (["claimed", "waiting_platform"].includes(job.status) || reconciled), "JOB_INVALID");
  assertDEJobAdmissionDecision(job, job.admissionDecision);
  const sku = candidate?.lifecycleV11?.skuPackage, state = sku?.dAssetTransport, intent = state?.intent;
  const authorization = intent?.productionPlan?.sourceAuthorization, scope = job.scopeBinding;
  requireCondition(candidate?.id === job.candidateId && sku?.skuPackageId === job.skuPackageId && sku.productionRecord === null &&
    sku.dSoftwareExecution == null && state?.schemaVersion === "aliyun-oss-d-asset-state-v1" && state.executionRevision === 2 &&
    ["verified", "failed", "unknown_outcome"].includes(state.status) &&
    isDeepStrictEqual(state.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId }) &&
    intent?.schemaVersion === "aliyun-oss-d-asset-integration-v1" && intent.candidateId === job.candidateId && intent.skuPackageId === job.skuPackageId &&
    intent.authorizationId === scope.authorizationRef && intent.authorizationFingerprint === scope.authorizationFingerprint &&
    authorization?.authorizationId === scope.authorizationRef && fingerprintCanonicalRecord(authorization) === scope.authorizationFingerprint &&
    job.ownerUserId === authorization.authorizedByActorId && job.requestedByUserId === authorization.authorizedByActorId &&
    intent.productionPlanId === intent.productionPlan.planId && intent.candidateDataRevision === job.revision &&
    intent.persistedCandidateRevision === job.revision + 1 && intent.attempt === 1 && intent.attemptLimit === 1 &&
    intent.mustPersistBeforeUpload === true && intent.automaticRetry === false && intent.retryAllowed === false &&
    intent.platformWrites === 0 && state.automaticRetry === false && state.platformWrites === 0 &&
    intent.assetsFinalUploadsVersion === authorization.lockedScope.finalManifestVersion &&
    isDeepStrictEqual(intent.finalUploadAssetIds, authorization.lockedScope.finalUploads.map(asset => asset.assetId)), "ASSET_SOURCE_CONFLICT");
  requireCondition(time(intent.startedAt) >= time(job.startedAt) && time(intent.persistedAt) >= time(intent.startedAt) &&
    time(intent.completedAt) >= time(intent.persistedAt) && time(state.settledAt) >= time(intent.completedAt) &&
    time(observedAt) >= time(state.settledAt), "TIME_CONFLICT");
  assertSafeRuntimeRecord(state, "dAssetJobResult.sourceState");
  const requestSent = job.status === "waiting_platform" && job.externalRequestState === "in_flight" || reconciled;
  const requestNotSent = job.status === "claimed" && job.externalRequestState === "not_sent" && job.externalRequestRef === null;
  requireCondition(requestNotSent || requestSent && job.externalRequestRef === `d-production-request:${scope.authorizationFingerprint}`, "REQUEST_STATE_CONFLICT");
  if (state.status === "verified") {
    requireCondition(requestSent, "REQUEST_NOT_STARTED");
    assertDAssetTransportCursor(state, authorization, candidate.id, observedAt, { requireContinuation: false });
    const current = !reconciled && state.continuationBlocked === false && candidate.dataRevision === job.revision + 2 &&
      isDeepStrictEqual(sku.productionAuthorization, authorization) && isDeepStrictEqual(sku.g1Identity, scope.identity) &&
      sku.dataRevision === scope.resultSkuRevision && sku.supplierSkuId === scope.identity.supplierSkuId &&
      sku.targetPlatform === scope.identity.platform && sku.targetStore === scope.identity.storeRef.stableStoreId &&
      sku.variantKey === scope.variantKey && candidate.targetStore === scope.identity.storeRef.stableStoreId &&
      isDeepStrictEqual(candidate.storeRef, scope.identity.storeRef);
    return Object.freeze({ status: current ? "progress" : "failed", externalRequestState: "succeeded",
      failureClass: current ? null : "d-assets-source-conflict", continuationBlocked: !current });
  }
  requireCondition(state.assetTransport === null && intent.status === state.status, "ASSET_RESULT_CONFLICT");
  if (state.status === "failed") {
    requireCondition(intent.externalRequestState === "not_attempted" && intent.ossWrites === 0 &&
      isAssetTransportPrewriteFailure({ layer: intent.failureLayer, code: intent.failureCode }) && requestNotSent,
      "ASSET_PREWRITE_SOURCE_CONFLICT");
    return Object.freeze({ status: "failed", externalRequestState: "not_sent", failureClass: "d-assets-prewrite-rejected", continuationBlocked: true });
  }
  requireCondition(intent.ossWrites === "unknown" && intent.failureLayer === "aliyun_oss_asset_transport" &&
    typeof intent.failureCode === "string" && /^[A-Z][A-Z0-9_]{1,100}$/.test(intent.failureCode), "ASSET_UNKNOWN_SOURCE_CONFLICT");
  return Object.freeze({ status: requestNotSent ? "failed" : "unknown_outcome",
    externalRequestState: requestNotSent ? "not_sent" : "unknown_outcome",
    failureClass: requestNotSent ? "d-assets-error-before-external-request" : "d-assets-outcome-unknown", continuationBlocked: true });
}

export function readDPreparationJobTerminal({ document, candidate, job, observedAt }) {
  const reconciled = isReconciledDERequest(job);
  const requestNotSent = job?.status === "claimed" && job.externalRequestState === "not_sent" && job.externalRequestRef === null;
  requireCondition(job?.jobType === "d_production_execution" && job.attempt === 1 &&
    (requestNotSent || job.status === "waiting_platform" && job.externalRequestState === "in_flight" || reconciled), "JOB_INVALID");
  assertDEJobAdmissionDecision(job, job.admissionDecision);
  const evidence = assertDProductionPreparation(job.preparationEvidence, { job });
  // Only the immutable saved evidence selects request semantics. Historical v1 means external_read.
  const preflightRequestMode = Object.hasOwn(evidence, "requestMode") ? evidence.requestMode : "external_read";
  requireCondition(!requestNotSent || preflightRequestMode === "persisted_evidence_only", "REQUEST_STATE_CONFLICT");
  requireCondition(evidence.status !== "in_flight" && (requestNotSent || job.externalRequestRef === `d-production-request:${job.scopeBinding.authorizationFingerprint}`),
    "REQUEST_SOURCE_CONFLICT");
  requireCondition(time(evidence.startedAt) >= time(job.startedAt) && time(observedAt) >= time(evidence.completedAt), "TIME_CONFLICT");
  // 冻结源按授权找，不按作业号找：同一份授权可能跑过不止一轮受控执行，冻结输入始终是同一份。
  const originals = document.runtime.idempotencyRecords.filter(entry =>
    entry.action === "create_single_owner_production_authorization_and_d_handoff" &&
    entry.result?.productionAuthorization?.authorizationId === job.scopeBinding.authorizationRef &&
    dProductionJobRound(entry.result?.softwareJobRef?.jobId, job.scopeBinding.authorizationFingerprint) === 1);
  requireCondition(originals.length === 1, "AUTHORIZATION_SOURCE_CONFLICT");
  const source = originals[0].candidateSnapshot;
  assertDProductionJobScope({ scope: job.scopeBinding, candidate: source, observedAt: job.createdAt });
  const authorization = source.lifecycleV11.skuPackage.productionAuthorization, scope = job.scopeBinding;
  requireCondition(job.ownerUserId === authorization.authorizedByActorId && job.requestedByUserId === authorization.authorizedByActorId &&
    candidate?.id === job.candidateId && candidate.lifecycleV11?.skuPackage?.skuPackageId === job.skuPackageId, "AUTHORIZATION_OWNER_CONFLICT");
  const sku = candidate.lifecycleV11.skuPackage;
  requireCondition(sku.dSoftwareExecution == null && sku.productionRecord === null, "PREPARATION_ALREADY_ADVANCED");
  if (preflightRequestMode === "persisted_evidence_only" && !requestNotSent && !reconciled) {
    assertDAssetTransportCursor(sku.dAssetTransport, authorization, candidate.id, observedAt, { requireContinuation: false });
    requireCondition(sku.dAssetTransport.status === "verified", "ASSET_SOURCE_CONFLICT");
  }
  if (evidence.result !== null) {
    const preflight = evidence.result.platformWritePreflight;
    requireCondition(preflight.storeIdentity.expectedStore === scope.identity.storeRef.stableStoreId &&
      isDeepStrictEqual(preflight.storeIdentity.expectedStoreRef, scope.identity.storeRef) &&
      preflight.priceCurrency.expected === authorization.lockedScope.platformWritePrice.currency &&
      isDeepStrictEqual(preflight.authorizedWriteFields, authorization.lockedScope.allowedWriteFields), "PREFLIGHT_SOURCE_CONFLICT");
  }
  const current = !reconciled && evidence.continuationBlocked === false && candidate.dataRevision === evidence.sourceCandidateRevision &&
    isDeepStrictEqual(sku.productionAuthorization, authorization) && isDeepStrictEqual(sku.g1Identity, scope.identity) &&
    sku.dataRevision === scope.resultSkuRevision && sku.supplierSkuId === scope.identity.supplierSkuId &&
    sku.targetPlatform === scope.identity.platform && sku.targetStore === scope.identity.storeRef.stableStoreId &&
    sku.variantKey === scope.variantKey && candidate.targetStore === scope.identity.storeRef.stableStoreId &&
    isDeepStrictEqual(candidate.storeRef, scope.identity.storeRef);
  const completedRequestState = requestNotSent ? "not_sent" : "succeeded";
  if (evidence.status === "unknown_outcome") return Object.freeze(preflightRequestMode === "persisted_evidence_only" && !reconciled
    ? { status: "failed", externalRequestState: completedRequestState, failureClass: "d-production-local-preflight-unavailable", continuationBlocked: true }
    : { status: "unknown_outcome", externalRequestState: "unknown_outcome", failureClass: "d-production-preflight-outcome-unknown", continuationBlocked: true });
  if (evidence.status === "not_ready") return Object.freeze({ status: "failed", externalRequestState: completedRequestState,
    failureClass: "d-production-preflight-not-ready", continuationBlocked: true });
  return Object.freeze({ status: current ? "progress" : "failed", externalRequestState: completedRequestState,
    failureClass: current ? null : "d-production-preparation-context-changed", continuationBlocked: !current });
}

/** Domain state is the sole result source; callers cannot supply a fabricated completion payload. */
export function readDProductionJobTerminal({ candidate, job, observedAt }) {
  const reconciled = isReconciledDERequest(job);
  requireCondition(job?.jobType === "d_production_execution" && job.attempt === 1 &&
    (["claimed", "waiting_platform"].includes(job.status) || reconciled), "JOB_INVALID");
  assertDEJobAdmissionDecision(job, job.admissionDecision);
  const sku = candidate?.lifecycleV11?.skuPackage;
  const state = sku?.dSoftwareExecution;
  const request = state?.attempt?.request;
  const authorization = state?.productionPlan?.sourceAuthorization;
  requireCondition(candidate?.id === job.candidateId && sku?.skuPackageId === job.skuPackageId &&
    object(state) && ["d-software-execution-state-v1","d-software-execution-state-v2"].includes(state.schemaVersion) && state.candidateId === job.candidateId &&
    ["succeeded", "failed", "unknown_outcome"].includes(state.status) && state.attempt?.status === state.status &&
    isDeepStrictEqual(state.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId }) &&
    isCanonicalFrozenRef(state.executionKey) && state.attempt.executionKey === state.executionKey && request?.executionKey === state.executionKey &&
    request.sourceAuthorizationId === job.scopeBinding.authorizationRef && request.sourceAuthorizationFingerprint === job.scopeBinding.authorizationFingerprint &&
    object(authorization) && authorization.authorizationId === job.scopeBinding.authorizationRef &&
    job.ownerUserId === authorization.authorizedByActorId && job.requestedByUserId === authorization.authorizedByActorId &&
    fingerprintCanonicalRecord(authorization) === job.scopeBinding.authorizationFingerprint &&
    state.productionPlanId === state.productionPlan.planId && request.sourceProductionPlanId === state.productionPlanId &&
    request.sourceProductionPlanFingerprint === fingerprintCanonicalRecord(state.productionPlan), "SOURCE_CONFLICT");
  const terminalAt = state.status === "unknown_outcome" ? state.attempt.markedAt : state.attempt.completedAt;
  requireCondition(time(state.attempt.startedAt) >= time(job.startedAt) && time(terminalAt) >= time(state.attempt.startedAt) &&
    time(state.settledAt) >= time(terminalAt) && time(observedAt) >= time(state.settledAt), "TIME_CONFLICT");
  assertSafeRuntimeRecord(state, "dJobResult.sourceState");
  if (state.status !== "succeeded") {
    requireCondition(state.attempt.productionRecord === null && sku.productionRecord === null, "FAILED_RECORD_CONFLICT");
    const checkpointCount = state.checkpoints?.length;
    const blockedCheckpoint = state.continuationBlocked === true && ([0, 3].includes(checkpointCount) ||
      state.schemaVersion === 'd-software-execution-state-v2' && request.executionProtocolVersion === 'ozon-single-sku-d-e-v3' && checkpointCount === 1) &&
      state.executionRevision === checkpointCount + 3 &&
      (state.blockReason === "candidate_changed_during_production" || productionJobPrewriteCode({ code: state.blockReason }) !== null);
    assertDCheckpointSources(state, request, observedAt, { terminal: true, blockedCheckpoint });
    if (state.status === "failed") {
      requireCondition(isDProductionPrewriteFailure(state.attempt.failure) && checkpointCount <= 1 && state.platformWrites === 0 &&
        (checkpointCount === 0 || state.attempt.failure.layer === "seller_api" || blockedCheckpoint) &&
        (state.attempt.failure.layer !== "production_admission" || blockedCheckpoint && state.blockReason === state.attempt.failure.code),
        "PREWRITE_FAILURE_SOURCE_CONFLICT");
    } else {
      requireCondition(isDProductionUnknownReason(state.attempt.reason) && state.platformWrites === (checkpointCount === 0 ? 0 : "unknown"),
        "UNKNOWN_SOURCE_CONFLICT");
    }
    const notSent = job.status === "claimed" && job.externalRequestState === "not_sent" && job.externalRequestRef === null;
    requireCondition(!notSent || checkpointCount === 0, "REQUEST_STATE_CONFLICT");
    let assetsCompleted = false;
    if (sku.dAssetTransport != null) {
      assertDAssetTransportCursor(sku.dAssetTransport, authorization, candidate.id, observedAt);
      requireCondition(sku.dAssetTransport.status === "verified", "ASSET_SOURCE_CONFLICT");
      assetsCompleted = true;
    }
    let preparationCompleted = false;
    if (job.preparationEvidence !== undefined) {
      const evidence = assertDProductionPreparation(job.preparationEvidence, { job });
      requireCondition(evidence.status === "ready" && evidence.continuationBlocked === false &&
        evidence.sourceProductionPlanId === state.productionPlanId &&
        evidence.sourceProductionPlanFingerprint === fingerprintCanonicalRecord(state.productionPlan) &&
        time(evidence.completedAt) <= time(state.attempt.startedAt), "PREPARATION_SOURCE_CONFLICT");
      preparationCompleted = true;
    }
    requireCondition(notSent || job.externalRequestRef === `d-production-request:${job.scopeBinding.authorizationFingerprint}`, "REQUEST_SOURCE_CONFLICT");
    const dRequestNotSent = checkpointCount === 0;
    return Object.freeze({ status: state.status === "unknown_outcome" && !dRequestNotSent ? "unknown_outcome" : "failed",
      externalRequestState: notSent ? "not_sent" : state.status === "unknown_outcome" && !dRequestNotSent ? "unknown_outcome" :
        assetsCompleted || preparationCompleted ? "succeeded" : "not_sent",
      failureClass: state.status === "unknown_outcome" ? (dRequestNotSent ? "d-error-before-external-request" : "d-production-outcome-unknown") : "d-production-prewrite-rejected",
      payload: null, applicationDisposition: "result_recorded_no_candidate_mutation", eScope: null });
  }
  requireCondition(((job.status === "waiting_platform" && job.externalRequestState === "in_flight") || reconciled) &&
    job.externalRequestRef === `d-production-request:${job.scopeBinding.authorizationFingerprint}`, "REQUEST_NOT_STARTED");
  const record = assertDProductionRecordSource({ record: sku.productionRecord, authorization, observedAt });
  assertDProductionReceiptChain({ state, authorization, record, candidateId: job.candidateId });
  const current = !reconciled && state.continuationBlocked === false && candidate.dataRevision === state.expectedCandidateRevision &&
    isDeepStrictEqual(sku.productionAuthorization, authorization) && isDeepStrictEqual(sku.g1Identity, job.scopeBinding.identity) &&
    sku.dataRevision === job.scopeBinding.resultSkuRevision &&
    candidate.targetStore === job.scopeBinding.identity.storeRef.stableStoreId &&
    isDeepStrictEqual(candidate.storeRef, job.scopeBinding.identity.storeRef) && sku.variantKey === job.scopeBinding.variantKey &&
    sku.supplierSkuId === job.scopeBinding.identity.supplierSkuId && sku.targetPlatform === job.scopeBinding.identity.platform &&
    sku.targetStore === job.scopeBinding.identity.storeRef.stableStoreId;
  const eScope = current ? createEReadbackJobScope({ candidate, observedAt }) : null;
  const payload = Object.freeze({ schemaVersion: "d-production-job-result-v1", executionKey: state.executionKey,
    executionRevision: state.executionRevision, sourceAuthorizationFingerprint: job.scopeBinding.authorizationFingerprint,
    productionRecordId: record.productionRecordId, productionRecordFingerprint: fingerprintCanonicalRecord(record),
    candidateRevision: candidate.dataRevision, continuationBlocked: !current });
  return Object.freeze({ status: "completed", externalRequestState: "succeeded", failureClass: null, payload,
    applicationDisposition: current ? "applied" : "revision_conflict_not_applied", eScope });
}

/** E reuses its saved attempt and the immutable D receipt; a changed current pointer cannot erase a late result. */
export function readEReadbackJobTerminal({ candidate, job, observedAt }) {
  const reconciled = isReconciledDERequest(job);
  requireCondition(job?.jobType === "e_independent_readback" && job.attempt === 1 &&
    (["claimed", "waiting_platform"].includes(job.status) || reconciled), "JOB_INVALID");
  assertDEJobAdmissionDecision(job, job.admissionDecision);
  const sku = candidate?.lifecycleV11?.skuPackage;
  requireCondition(candidate?.id === job.candidateId && sku?.skuPackageId === job.skuPackageId && Array.isArray(sku.readbackHistory), "SOURCE_CONFLICT");
  const attempts = sku.readbackHistory.filter(attempt => attempt?.softwareJobRef?.jobId === job.jobId);
  requireCondition(attempts.length === 1, "ATTEMPT_SOURCE_CONFLICT");
  const attempt = assertEReadbackAttempt(attempts[0]);
  const scope = job.scopeBinding;
  requireCondition(attempt.status !== "in_flight" && attempt.candidateId === job.candidateId && attempt.skuPackageId === job.skuPackageId &&
    attempt.requestedByUserId === job.workerId && attempt.sourceProductionRecordId === scope.sourceProductionRecordId &&
    isDeepStrictEqual(attempt.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId }), "ATTEMPT_SOURCE_CONFLICT");
  requireCondition(time(attempt.startedAt) >= time(job.startedAt) && time(observedAt) >= time(attempt.completedAt), "TIME_CONFLICT");
  const dState = sku.dSoftwareExecution;
  const authorization = dState?.productionPlan?.sourceAuthorization;
  requireCondition(authorization?.authorizationId === scope.authorizationRef && fingerprintCanonicalRecord(authorization) === scope.authorizationFingerprint,
    "AUTHORIZATION_SOURCE_CONFLICT");
  requireCondition(job.ownerUserId === authorization.authorizedByActorId && job.requestedByUserId === authorization.authorizedByActorId,
    "AUTHORIZATION_OWNER_CONFLICT");
  const record = assertDProductionRecordSource({ record: dState?.attempt?.productionRecord, authorization, observedAt });
  assertDProductionReceiptChain({ state: dState, authorization, record, candidateId: job.candidateId });
  requireCondition(record.productionRecordId === scope.sourceProductionRecordId && fingerprintCanonicalRecord(record) === scope.sourceProductionRecordFingerprint &&
    dState.executionKey === scope.sourceExecutionKey && dState.productionPlanId === scope.sourceProductionPlanId &&
    fingerprintCanonicalRecord(dState.productionPlan) === scope.sourceProductionPlanFingerprint &&
    record.requestReceiptRef === scope.requestReceiptRef && record.inventoryReceiptRef === scope.inventoryReceiptRef &&
    record.platformProductId === scope.platformProductId && attempt.sourceFingerprint === fingerprintCanonicalRecord({
      productionRecord: record, identity: scope.identity, variantKey: scope.variantKey }), "FROZEN_SOURCE_CONFLICT");
  const applied = attempt.applicationDisposition === "applied";
  if (attempt.externalRequestState !== "not_sent") requireCondition(job.externalRequestRef === `e-readback-request:${scope.inputFingerprint}`,
    "REQUEST_SOURCE_CONFLICT");
  if (applied) {
    requireCondition(!reconciled && candidate.dataRevision === job.revision + 1 && isDeepStrictEqual(sku.productionRecord, record) &&
      isDeepStrictEqual(sku.g1Identity, scope.identity) && sku.variantKey === scope.variantKey &&
      sku.dataRevision === scope.resultSkuRevision && sku.supplierSkuId === scope.identity.supplierSkuId &&
      sku.targetPlatform === scope.identity.platform && sku.targetStore === scope.identity.storeRef.stableStoreId &&
      candidate.targetStore === scope.identity.storeRef.stableStoreId && isDeepStrictEqual(candidate.storeRef, scope.identity.storeRef) &&
      sku.externalListingRecord === null && isDeepStrictEqual(sku.eVerificationRecord, attempt.result.eVerificationRecord) &&
      validateSystemCreatedVerificationRecord(attempt.result.eVerificationRecord, record).valid, "APPLICATION_SOURCE_CONFLICT");
  }
  if (attempt.externalRequestState !== "succeeded") {
    const notSent = attempt.externalRequestState === "not_sent";
    requireCondition(notSent ? job.status === "claimed" && job.externalRequestState === "not_sent" && job.externalRequestRef === null :
      (job.status === "waiting_platform" && job.externalRequestState === "in_flight") || reconciled, "REQUEST_STATE_CONFLICT");
    requireCondition(!applied, "APPLICATION_SOURCE_CONFLICT");
    return Object.freeze({ status: notSent ? "failed" : "unknown_outcome", externalRequestState: notSent ? "not_sent" : "unknown_outcome",
      failureClass: notSent ? "e-readback-expectation-invalid" : "e-readback-outcome-unknown", payload: null,
      applicationDisposition: "result_recorded_no_candidate_mutation" });
  }
  requireCondition((job.status === "waiting_platform" && job.externalRequestState === "in_flight") || reconciled, "REQUEST_NOT_STARTED");
  requireCondition(job.externalRequestRef === `e-readback-request:${scope.inputFingerprint}`, "REQUEST_SOURCE_CONFLICT");
  const payload = Object.freeze({ schemaVersion: "e-readback-job-result-v1", attemptId: attempt.attemptId,
    sourceProductionRecordId: record.productionRecordId, sourceProductionRecordFingerprint: scope.sourceProductionRecordFingerprint,
    attemptFingerprint: fingerprintCanonicalRecord(attempt), verificationStatus: attempt.result.status,
    candidateRevision: candidate.dataRevision, verificationApplied: applied });
  return Object.freeze({ status: "completed", externalRequestState: "succeeded", failureClass: null, payload,
    applicationDisposition: applied ? "applied" : attempt.applicationDisposition === "source_conflict_not_applied" ?
      "revision_conflict_not_applied" : "result_recorded_no_candidate_mutation" });
}
