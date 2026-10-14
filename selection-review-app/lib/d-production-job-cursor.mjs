import { isDeepStrictEqual } from 'node:util';
import { assertDProductionJobScope } from './d-e-software-job-scope.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef, isCanonicalStableHttpsAssetRef } from './production-contract-primitives.mjs';
import { isCompleteStoreRef } from './store-binding.mjs';

export class DProductionJobCursorError extends Error {
  constructor(code) { super(code); this.name = 'DProductionJobCursorError'; this.code = code; }
}

const requireCondition = (condition, code) => { if (!condition) throw new DProductionJobCursorError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const steps = ['import_intent', 'import_task_received', 'import_result_observed', 'stock_intent', 'stock_receipt_observed', 'independent_readback_observed'];
const checkpointFields = [[], ['taskId'], ['taskId', 'productId', 'merchantSku', 'itemCount', 'status', 'errorCount', 'requestReceiptRef'],
  ['taskId', 'productId', 'merchantSku', 'warehouseId', 'stock'],
  ['taskId', 'productId', 'merchantSku', 'warehouseId', 'updated', 'itemCount', 'errorCount', 'inventoryReceiptRef'], ['observation']];
// r70 起 import_result_observed 还带 errors（错误明细）。**按可选处理**：
// 这一改之前落盘的 checkpoint 没有这个字段，把它列成必填会让历史记录整体判冲突。
const checkpointOptionalFields = [[], [], ['errors'], [], [], []];
const nullableCount = value => value === null || Number.isSafeInteger(value) && value >= 0;
const nullableId = value => value === null || positiveId(value);
const nullableRef = value => value === null || isCanonicalFrozenRef(value);
const observationRefs = ['platform', 'store', 'warehouseRef', 'credentialAlias', 'skuPackageId', 'supplierSkuId', 'merchantSku',
  'platformProductId', 'moderationStatus', 'validationStatus', 'saleStatus', 'platformEvidenceRef'];
const observationFields = [...observationRefs, 'storeRef', 'currentPrice', 'currentStock', 'imageCount', 'errors'];

function isSavedReadbackObservation(value) {
  return object(value) && observationFields.every(field => Object.hasOwn(value, field)) &&
    Object.keys(value).every(field => [...observationFields, 'mediaObservation', 'inventoryObservation'].includes(field)) &&
    observationRefs.every(field => isCanonicalFrozenRef(value[field])) && isCompleteStoreRef(value.storeRef, value.store) &&
    object(value.currentPrice) && Object.keys(value.currentPrice).length === 2 && Number.isFinite(value.currentPrice.amount) &&
    value.currentPrice.amount >= 0 && isCanonicalFrozenRef(value.currentPrice.currency) &&
    [value.currentStock, value.imageCount].every(count => count === 'unknown' || Number.isSafeInteger(count) && count >= 0) &&
    (value.errors === 'unknown' || Array.isArray(value.errors));
}

function time(value) {
  requireCondition(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'D_JOB_CURSOR_TIME_INVALID');
  return Date.parse(value);
}

function planSource(plan, authorization, observedAt) {
  requireCondition(object(plan) && plan.schemaVersion === 'production-plan-v1.1' &&
    isDeepStrictEqual(plan.sourceAuthorization, authorization) &&
    plan.planId === `production-plan:${authorization.authorizationId}:${fingerprintCanonicalRecord(authorization).slice(0, 12)}`,
  'D_JOB_CURSOR_PLAN_SOURCE_CONFLICT');
  requireCondition(time(plan.createdAt) >= time(authorization.authorizedAt) && time(plan.createdAt) <= time(observedAt), 'D_JOB_CURSOR_TIME_CONFLICT');
}

export function assertDAssetTransportCursor(state, authorization, candidateId, observedAt, { requireContinuation = true } = {}) {
  const intent = state.intent;
  requireCondition(state.schemaVersion === 'aliyun-oss-d-asset-state-v1' && ['in_flight', 'verified'].includes(state.status) &&
    state.automaticRetry === false && state.platformWrites === 0 && (!requireContinuation || state.continuationBlocked !== true) && object(intent),
  'D_JOB_CURSOR_ASSET_STOPPED');
  planSource(intent.productionPlan, authorization, observedAt);
  const assets = authorization.lockedScope.finalUploads;
  requireCondition(intent.schemaVersion === 'aliyun-oss-d-asset-integration-v1' && isCanonicalFrozenRef(intent.intentId) &&
    intent.candidateId === candidateId && intent.skuPackageId === authorization.lockedScope.skuPackageId &&
    intent.authorizationId === authorization.authorizationId && intent.authorizationFingerprint === fingerprintCanonicalRecord(authorization) &&
    intent.productionPlanId === intent.productionPlan.planId &&
    intent.assetsFinalUploadsVersion === authorization.lockedScope.finalManifestVersion &&
    isDeepStrictEqual(intent.finalUploadAssetIds, assets.map(asset => asset.assetId)) &&
    intent.candidateDataRevision === authorization.resultCandidateRevision &&
    intent.persistedCandidateRevision === intent.candidateDataRevision + 1 &&
    intent.attempt === 1 && intent.attemptLimit === 1 && intent.mustPersistBeforeUpload === true &&
    intent.automaticRetry === false && intent.retryAllowed === false && intent.platformWrites === 0,
  'D_JOB_CURSOR_ASSET_SOURCE_CONFLICT');
  requireCondition(time(intent.startedAt) >= time(intent.productionPlan.createdAt) && time(intent.persistedAt) >= time(intent.startedAt) &&
    time(intent.persistedAt) <= time(observedAt), 'D_JOB_CURSOR_TIME_CONFLICT');
  if (state.status === 'in_flight') {
    requireCondition(state.executionRevision === 1 && intent.status === 'in_flight' && intent.ossWrites === 0 && state.assetTransport === null,
      'D_JOB_CURSOR_ASSET_REVISION_CONFLICT');
    return intent.persistedCandidateRevision;
  }
  const receipt = state.assetTransport;
  requireCondition(state.executionRevision === 2 && (!requireContinuation || state.continuationBlocked === false && state.blockReason === null) &&
    intent.status === 'completed' && intent.ossWrites === assets.length && object(receipt) && receipt.status === 'verified' &&
    receipt.mode === 'preapproved_stable_https' && isCanonicalFrozenRef(receipt.evidenceRef) &&
    Array.isArray(receipt.resolvedAssets) && receipt.resolvedAssets.length === assets.length &&
    receipt.resolvedAssets.every((asset, index) => object(asset) && asset.assetId === assets[index].assetId &&
      asset.sha256 === assets[index].sha256 && asset.order === assets[index].order &&
      asset.authorizationStatus === 'approved' && asset.stable === true && isCanonicalStableHttpsAssetRef(asset.platformAcceptedUrl)),
  'D_JOB_CURSOR_ASSET_RECEIPT_CONFLICT');
  requireCondition(time(intent.completedAt) >= time(intent.persistedAt) && time(state.settledAt) >= time(intent.completedAt) &&
    time(state.settledAt) <= time(observedAt), 'D_JOB_CURSOR_TIME_CONFLICT');
  return intent.persistedCandidateRevision + 1;
}

export function assertDCheckpointSources(state, request, observedAt, { terminal = false, blockedCheckpoint = false } = {}) {
  requireCondition(Array.isArray(state.checkpoints) && state.checkpoints.length <= steps.length &&
    state.executionRevision === state.checkpoints.length + 1 + Number(terminal) + Number(blockedCheckpoint) &&
    state.step === (state.checkpoints.length === 0 ? 'intent_persisted' : steps[state.checkpoints.length - 1]),
  'D_JOB_CURSOR_CHECKPOINT_REVISION_CONFLICT');
  let previousTime = time(state.attempt.startedAt);
  for (const [index, checkpoint] of state.checkpoints.entries()) {
    requireCondition(object(checkpoint) && checkpoint.kind === steps[index] &&
      checkpointFields[index].every(field => Object.hasOwn(checkpoint, field)) &&
      Object.keys(checkpoint).every(field => field === 'kind' || field === 'observedAt' ||
        checkpointFields[index].includes(field) || checkpointOptionalFields[index].includes(field)) &&
      Object.keys(checkpoint).length >= checkpointFields[index].length + 2, 'D_JOB_CURSOR_CHECKPOINT_SEQUENCE_CONFLICT');
    const at = time(checkpoint.observedAt);
    requireCondition(at >= previousTime && at <= time(observedAt), 'D_JOB_CURSOR_TIME_CONFLICT'); previousTime = at;
  }
  const [, task, imported, stock, inventory, readback] = state.checkpoints;
  if (task) requireCondition(positiveId(task.taskId), 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  const finalImportObservation = terminal && state.status === 'unknown_outcome' && state.checkpoints.length === 3;
  const finalInventoryObservation = terminal && state.status === 'unknown_outcome' && state.checkpoints.length === 5;
  if (imported && finalImportObservation) requireCondition(imported.taskId === task.taskId && nullableId(imported.productId) &&
    nullableRef(imported.merchantSku) && nullableCount(imported.itemCount) && nullableCount(imported.errorCount) &&
    isCanonicalFrozenRef(imported.status) && isCanonicalFrozenRef(imported.requestReceiptRef), 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  if (imported && !finalImportObservation) requireCondition(imported.taskId === task.taskId && positiveId(imported.productId) &&
    imported.merchantSku === request.merchantSku && imported.status === 'imported' && imported.itemCount === 1 && imported.errorCount === 0 &&
    isCanonicalFrozenRef(imported.requestReceiptRef), 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  for (const checkpoint of [stock, finalInventoryObservation ? null : inventory].filter(Boolean)) requireCondition(checkpoint.taskId === task.taskId &&
    checkpoint.productId === imported.productId && checkpoint.merchantSku === request.merchantSku &&
    checkpoint.warehouseId === request.inventoryWrite.warehouseId, 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  if (stock) requireCondition(stock.stock === request.stock, 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  if (inventory && finalInventoryObservation) requireCondition(inventory.taskId === task.taskId && nullableId(inventory.productId) &&
    nullableRef(inventory.merchantSku) && nullableRef(inventory.warehouseId) && nullableCount(inventory.itemCount) && nullableCount(inventory.errorCount) &&
    [true, false, null].includes(inventory.updated) && isCanonicalFrozenRef(inventory.inventoryReceiptRef), 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  if (inventory && !finalInventoryObservation) requireCondition(inventory.updated === true && inventory.itemCount === 1 && inventory.errorCount === 0 &&
    isCanonicalFrozenRef(inventory.inventoryReceiptRef), 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  if (readback) {
    const observation = readback.observation;
    if (terminal && state.status === 'unknown_outcome') {
      requireCondition(isSavedReadbackObservation(observation), 'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
      return;
    }
    requireCondition(object(observation) && observation.platformProductId === imported.productId &&
      ['platform', 'store', 'warehouseRef', 'credentialAlias', 'skuPackageId', 'supplierSkuId', 'merchantSku'].every(field => observation[field] === request[field]) &&
      isDeepStrictEqual(observation.storeRef, request.storeRef) && isCanonicalFrozenRef(observation.platformEvidenceRef),
    'D_JOB_CURSOR_RECEIPT_SOURCE_CONFLICT');
  }
}

function executionCursor(state, assetState, authorization, candidateId, baseRevision, observedAt) {
  requireCondition(['d-software-execution-state-v1','d-software-execution-state-v2'].includes(state.schemaVersion) && state.status === 'in_flight' &&
    state.continuationBlocked === false && state.requestEncoding === 'ozon-fixed-protocols-v1' &&
    state.attemptLimit === 1 && state.automaticRetry === false && state.retryAllowed === false &&
    state.mustPersistBeforeSellerApi === true && state.canCallSellerApiBeforePersist === false,
  'D_JOB_CURSOR_EXECUTION_STOPPED');
  planSource(state.productionPlan, authorization, observedAt);
  const attempt = state.attempt, request = attempt?.request;
  requireCondition(state.candidateId === candidateId && state.authorizationId === authorization.authorizationId &&
    state.productionPlanId === state.productionPlan.planId && state.candidateDataRevision === baseRevision &&
    state.expectedCandidateRevision === baseRevision + 1 && object(attempt) && object(request) &&
    ['d-software-execution-v1','d-software-execution-v2'].includes(attempt.schemaVersion) && attempt.status === 'in_flight' && attempt.attemptNumber === 1 &&
    attempt.retryAllowed === false && attempt.persistBeforeWrite === true && attempt.productionRecord === null &&
    isCanonicalFrozenRef(attempt.attemptId) && isCanonicalFrozenRef(state.executionKey) &&
    attempt.executionKey === state.executionKey && request.executionKey === state.executionKey && request.idempotencyKey === state.executionKey &&
    request.candidateId === candidateId && request.sourceAuthorizationId === authorization.authorizationId &&
    request.sourceAuthorizationFingerprint === fingerprintCanonicalRecord(authorization) && request.sourceAuthorizationVersion === authorization.schemaVersion &&
    request.sourceProductionPlanId === state.productionPlan.planId && request.sourceProductionPlanFingerprint === fingerprintCanonicalRecord(state.productionPlan),
  'D_JOB_CURSOR_EXECUTION_SOURCE_CONFLICT');
  const locked = authorization.lockedScope;
  requireCondition(['platform', 'warehouseRef', 'credentialAlias', 'skuPackageId', 'supplierSkuId', 'merchantSku', 'stock', 'publishScope']
    .every(field => request[field] === locked[field]) && request.store === locked.storeRef.stableStoreId &&
    request.assetsFinalUploadsVersion === locked.finalManifestVersion && isDeepStrictEqual(request.storeRef, locked.storeRef) &&
    isDeepStrictEqual(request.platformWritePrice, locked.platformWritePrice) &&
    Array.isArray(request.finalUploads) && request.finalUploads.length === locked.finalUploads.length &&
    request.finalUploads.every((asset, index) => object(asset) && ['assetId', 'sha256', 'order'].every(field => asset[field] === locked.finalUploads[index][field])) &&
    request.inventoryWrite?.warehouseId === authorization.executionBinding.warehouseId,
  'D_JOB_CURSOR_EXECUTION_SOURCE_CONFLICT');
  if (assetState) requireCondition(isDeepStrictEqual(state.productionPlan, assetState.intent.productionPlan) &&
    request.finalUploads.every((asset, index) => asset.platformAcceptedUrl === assetState.assetTransport.resolvedAssets[index].platformAcceptedUrl) &&
    time(attempt.startedAt) >= time(assetState.settledAt),
  'D_JOB_CURSOR_ASSET_RECEIPT_CONFLICT');
  requireCondition(time(attempt.startedAt) >= time(state.productionPlan.createdAt) && time(attempt.startedAt) <= time(observedAt), 'D_JOB_CURSOR_TIME_CONFLICT');
  assertDCheckpointSources(state, request, observedAt);
  const continuation = state.platformContinuation;
  const acceptedImportBeforeInventory = state.schemaVersion === 'd-software-execution-state-v2' &&
    request.executionProtocolVersion === 'ozon-single-sku-d-e-v3' &&
    continuation?.schemaVersion === 'd-platform-continuation-v1' && continuation.status === 'inventory_running' &&
    continuation.inventoryWriteState === 'not_sent' && state.checkpoints.length === 3 &&
    isDeepStrictEqual(continuation, attempt.platformContinuation) && continuation.taskId === state.checkpoints[1].taskId &&
    continuation.productId === state.checkpoints[2].productId &&
    attempt.platformResult?.requestReceiptRef === continuation.requestReceiptRef &&
    continuation.observationHistory.some(record => record.queryKind === 'import_task' &&
      record.result.classification === 'imported' &&
      isDeepStrictEqual({...record.result.importObservation, observedAt:record.observedAt}, state.checkpoints[2]));
  requireCondition(state.platformWrites === (acceptedImportBeforeInventory ? 1 : state.checkpoints.length === 0 ? 0 : 'unknown'),
    'D_JOB_CURSOR_EXECUTION_SOURCE_CONFLICT');
  return state.expectedCandidateRevision;
}

/**
 * Pure source/CAS proof, not permission to send or resume a request. In the same
 * prewrite transaction, D admission must also validate the complete executable
 * request, current transport/configuration and Worker lease. This function
 * deliberately never imports those use cases or the generic job contract.
 * Existing D/OSS intents have no softwareJobId: their source is proven through
 * PA/plan/executionKey; atomic admission must separately enforce one job per PA.
 */
export function assertCurrentDJobExecutionCursor({ job, candidate, observedAt }) {
  time(observedAt);
  const sku = candidate?.lifecycleV11?.skuPackage, authorization = sku?.productionAuthorization;
  requireCondition(object(job) && object(candidate) && object(sku) && object(authorization) &&
    job.jobType === 'd_production_execution' && job.candidateId === candidate.id && job.skuPackageId === sku.skuPackageId &&
    job.revision === authorization.resultCandidateRevision, 'D_JOB_CURSOR_JOB_SOURCE_CONFLICT');
  requireCondition(sku.productionRecord === null && sku.externalListingRecord === null && sku.eVerificationRecord === null,
    'D_JOB_CURSOR_ALREADY_COMPLETED');
  // Reconstruct only the PA source projection after separately checking every
  // persisted advancement below. It neither changes nor migrates the candidate.
  const source = structuredClone(candidate);
  source.dataRevision = authorization.resultCandidateRevision;
  source.lifecycleV11.skuPackage.dAssetTransport = null;
  delete source.lifecycleV11.skuPackage.dSoftwareExecution;
  assertDProductionJobScope({ scope: job.scopeBinding, candidate: source, observedAt });
  let expectedRevision = authorization.resultCandidateRevision, stage = 'pa_saved';
  const assets = sku.dAssetTransport, execution = sku.dSoftwareExecution;
  if (assets != null) {
    requireCondition(object(assets), 'D_JOB_CURSOR_ASSET_SOURCE_CONFLICT');
    expectedRevision = assertDAssetTransportCursor(assets, authorization, candidate.id, observedAt);
    stage = assets.status === 'verified' ? 'oss_verified' : 'oss_in_flight';
  }
  if (execution != null) {
    requireCondition(object(execution) && (assets == null || assets.status === 'verified'), 'D_JOB_CURSOR_EXECUTION_SOURCE_CONFLICT');
    expectedRevision = executionCursor(execution, assets, authorization, candidate.id, expectedRevision, observedAt);
    stage = 'd_in_flight';
  }
  requireCondition(Number.isSafeInteger(candidate.dataRevision) && candidate.dataRevision === expectedRevision, 'D_JOB_CURSOR_CANDIDATE_REVISION_CONFLICT');
  return Object.freeze({ stage, authorizationCandidateRevision: job.revision, candidateRevision: expectedRevision,
    assetExecutionRevision: assets?.executionRevision ?? null, executionRevision: execution?.executionRevision ?? null,
    executionKey: execution?.executionKey ?? null });
}
