import { isDeepStrictEqual } from "node:util";
import { validateProductionAuthorizationRecord } from "./product-lifecycle-schema.mjs";
import { PRODUCTION_AUTHORIZATION_VERSION, isProductionExecutionBinding } from "./production-authorization-preparation.mjs";
import { normalizeC1SourceIdentity } from "./c1-product-plan.mjs";
import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { validateProductionRecord, validateProductionReadbackExpectation } from "./production-record-contract.mjs";
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, fingerprintCanonicalRecord, isCanonicalFrozenRef, isOpaqueProductionSourceRef } from "./production-contract-primitives.mjs";
import { sameStoreRef } from "./store-binding.mjs";

export const D_E_SOFTWARE_JOB_SCOPE_VERSION = "software-job-scope-v1";
const D_SCOPE = "d_production_execution";
const E_SCOPE = "e_independent_readback";
const CHECKPOINT_ORDER = ["import_intent", "import_task_received", "import_result_observed", "stock_intent",
  "stock_receipt_observed", "independent_readback_observed"];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export class DEJobScopeError extends Error {
  constructor(code) { super(code); this.name = "DEJobScopeError"; this.code = code; }
}

function requireCondition(condition, code) {
  if (!condition) throw new DEJobScopeError(code);
}

function timestamp(value) {
  requireCondition(typeof value === "string" && Number.isFinite(Date.parse(value)), "DE_JOB_SCOPE_TIME_INVALID");
  return Date.parse(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const COMMON_SCOPE_FIELDS = Object.freeze([
  "schemaVersion", "sideEffectScope", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "sourceSkuRevision", "resultSkuRevision",
  "identity", "variantKey", "authorizationRef", "authorizationFingerprint", "productionBinding", "warehouseRef", "credentialAlias", "merchantSku", "inputFingerprint"
]);
const E_SOURCE_FIELDS = Object.freeze([
  "authorizationSourceRevision", "authorizationResultRevision", "sourceProductionRecordId", "sourceProductionRecordFingerprint",
  "sourceProductionPlanId", "sourceProductionPlanFingerprint", "sourceExecutionKey", "requestReceiptRef", "inventoryReceiptRef", "platformProductId"
]);
const revisionValue = value => Number.isSafeInteger(value) && value >= 0;
const fingerprintValue = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const placeholderRef = value => ["unknown", "null", "undefined", "not_applicable", "missing"].includes(value.toLowerCase());
const canonicalSourceRef = value => isCanonicalFrozenRef(value) && !placeholderRef(value);

function boundedScopeText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Structural envelope contract only; current candidate/source semantics remain in the create/assert functions below. */
export function normalizeDESoftwareJobScope(scope, { candidateId, skuPackageId, revision, jobType } = {}) {
  requireCondition([D_SCOPE, E_SCOPE].includes(jobType), "DE_JOB_SCOPE_TYPE_INVALID");
  const fields = jobType === D_SCOPE ? COMMON_SCOPE_FIELDS : [...COMMON_SCOPE_FIELDS, ...E_SOURCE_FIELDS];
  requireCondition(isObject(scope) && Object.keys(scope).length === fields.length && fields.every(field => Object.hasOwn(scope, field)) &&
    scope.schemaVersion === D_E_SOFTWARE_JOB_SCOPE_VERSION && scope.sideEffectScope === jobType, "DE_JOB_SCOPE_SHAPE_INVALID");
  // PA IDs embed SKU and owner-decision IDs; actual current IDs already exceed
  // the 256-character leaf-reference limit. They are opaque, never URLs to visit.
  requireCondition(isOpaqueProductionSourceRef(scope.authorizationRef) && boundedScopeText(scope.variantKey, 256), "DE_JOB_SCOPE_REFERENCE_INVALID");
  if (jobType === E_SCOPE) requireCondition([scope.sourceProductionRecordId, scope.sourceProductionPlanId].every(isOpaqueProductionSourceRef),
    "DE_JOB_SCOPE_REFERENCE_INVALID");
  for (const field of ["candidateId", "skuPackageId", "warehouseRef", "credentialAlias", "merchantSku"]) {
    requireCondition(canonicalSourceRef(scope[field]),
      "DE_JOB_SCOPE_REFERENCE_INVALID");
  }
  assertNoRawPersistenceKeys(scope, "deSoftwareJobScope");
  assertNoProductionSecrets(scope, "deSoftwareJobScope");
  const identity = normalizeC1SourceIdentity(scope.identity, "deSoftwareJobScope.identity");
  requireCondition(scope.candidateId === candidateId && scope.skuPackageId === skuPackageId &&
    identity.candidateId === candidateId && identity.skuPackageId === skuPackageId && identity.platform === "ozon" &&
    sameStoreRef(identity.storeRef, identity.storeRef), "DE_JOB_SCOPE_IDENTITY_CONFLICT");
  requireCondition(isProductionExecutionBinding(scope.productionBinding), "DE_JOB_SCOPE_PRODUCTION_BINDING_INVALID");
  requireCondition([scope.sourceRevision, scope.resultRevision, scope.sourceSkuRevision, scope.resultSkuRevision, revision].every(revisionValue) &&
    scope.resultRevision === revision, "DE_JOB_SCOPE_REVISION_CONFLICT");
  requireCondition(fingerprintValue(scope.authorizationFingerprint) && fingerprintValue(scope.inputFingerprint), "DE_JOB_SCOPE_FINGERPRINT_INVALID");
  if (jobType === D_SCOPE) {
    requireCondition(scope.resultRevision === scope.sourceRevision + 1 && scope.resultSkuRevision === scope.sourceSkuRevision + 1,
      "DE_JOB_SCOPE_REVISION_CONFLICT");
    requireCondition(scope.inputFingerprint === scope.authorizationFingerprint, "DE_JOB_SCOPE_FINGERPRINT_INVALID");
  } else {
    requireCondition(scope.resultRevision === scope.sourceRevision && scope.resultSkuRevision === scope.sourceSkuRevision &&
      [scope.authorizationSourceRevision, scope.authorizationResultRevision].every(revisionValue) &&
      scope.authorizationResultRevision === scope.authorizationSourceRevision + 1 && scope.sourceRevision > scope.authorizationResultRevision,
    "DE_JOB_SCOPE_REVISION_CONFLICT");
    requireCondition([scope.sourceProductionRecordFingerprint, scope.sourceProductionPlanFingerprint].every(fingerprintValue) &&
      scope.inputFingerprint === scope.sourceProductionRecordFingerprint, "DE_JOB_SCOPE_FINGERPRINT_INVALID");
    requireCondition(scope.sourceProductionPlanId === `production-plan:${scope.authorizationRef}:${scope.authorizationFingerprint.slice(0, 12)}` &&
      [scope.sourceExecutionKey, scope.requestReceiptRef, scope.inventoryReceiptRef].every(canonicalSourceRef) &&
      typeof scope.platformProductId === "string" && /^[1-9][0-9]{0,15}$/.test(scope.platformProductId) &&
      Number.isSafeInteger(Number(scope.platformProductId)), "DE_JOB_SCOPE_REFERENCE_INVALID");
  }
  return freeze({ ...structuredClone(scope), identity });
}

function sourceAuthorization(candidate, observedAt, phases) {
  const observed = timestamp(observedAt);
  requireCondition(isObject(candidate) && Number.isSafeInteger(candidate.dataRevision) && candidate.dataRevision >= 0 &&
    isObject(candidate.lifecycleV11?.skuPackage), "DE_JOB_SCOPE_CANDIDATE_INVALID");
  const sku = candidate.lifecycleV11.skuPackage;
  const authorization = sku.productionAuthorization;
  requireCondition(isObject(authorization), "DE_JOB_SCOPE_AUTHORIZATION_REQUIRED");
  const validation = validateProductionAuthorizationRecord(authorization, {
    candidateId: candidate.id, skuPackage: sku, lifecycleState: "persisted"
  });
  requireCondition(validation.valid && authorization.schemaVersion === PRODUCTION_AUTHORIZATION_VERSION,
    "DE_JOB_SCOPE_AUTHORIZATION_INVALID");
  requireCondition(timestamp(authorization.authorizedAt) <= observed &&
    candidate.dataRevision >= authorization.resultCandidateRevision, "DE_JOB_SCOPE_REVISION_OR_TIME_CONFLICT");
  requireCondition(candidate.targetStore === sku.targetStore && sameStoreRef(candidate.storeRef, sku.g1Identity.storeRef) &&
    sku.targetPlatform === "ozon" && phases.includes(sku.businessPhase), "DE_JOB_SCOPE_IDENTITY_CONFLICT");
  requireCondition(sku.externalListingRecord === null && sku.eVerificationRecord === null && Array.isArray(sku.readbackHistory),
    "DE_JOB_SCOPE_DOWNSTREAM_CONFLICT");
  return { sku, authorization };
}

function commonScope(candidate, authorization, sideEffectScope) {
  const scope = authorization.lockedScope;
  const authorizationFingerprint = fingerprintCanonicalRecord(authorization);
  return {
    schemaVersion: D_E_SOFTWARE_JOB_SCOPE_VERSION, sideEffectScope,
    candidateId: candidate.id, skuPackageId: scope.skuPackageId,
    sourceRevision: authorization.sourceCandidateRevision, resultRevision: authorization.resultCandidateRevision,
    sourceSkuRevision: authorization.authorizedDataRevision, resultSkuRevision: authorization.resultDataRevision,
    identity: structuredClone(authorization.sourceIdentity), variantKey: scope.variantKey,
    authorizationRef: authorization.authorizationId, authorizationFingerprint,
    productionBinding: structuredClone(authorization.executionBinding),
    warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias, merchantSku: scope.merchantSku,
    inputFingerprint: authorizationFingerprint
  };
}

function safeScope(scope) {
  assertNoProductionSecrets(scope);
  assertNoRawPersistenceKeys(scope);
  return freeze(scope);
}

/** Initial PA handoff only. A scope describes its saved source; it grants no transport permission. */
export function createDProductionJobScope({ candidate, observedAt }) {
  const { sku, authorization } = sourceAuthorization(candidate, observedAt, ["C2", "D"]);
  requireCondition(candidate.dataRevision === authorization.resultCandidateRevision && sku.productionRecord === null &&
    sku.dSoftwareExecution == null && sku.dAssetTransport == null && sku.readbackHistory.length === 0,
  "DE_JOB_SCOPE_D_ALREADY_ADVANCED");
  assertCurrentC1SkuRightsReview({ plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity, observedAt });
  assertCurrentC1SkuRightsReview({ plan: authorization.lockedScope.finalCardInputSnapshot.c1Snapshot,
    sourceIdentity: authorization.sourceIdentity, observedAt });
  return safeScope(commonScope(candidate, authorization, D_SCOPE));
}

/** Strictly compare a queued D source; later D execution cursors belong to the D execution contract. */
export function assertDProductionJobScope({ scope, candidate, observedAt }) {
  const expected = createDProductionJobScope({ candidate, observedAt });
  requireCondition(isDeepStrictEqual(scope, expected), "DE_JOB_SCOPE_D_SOURCE_CONFLICT");
  return expected;
}

function sourceProductionRecord(candidate, sku, authorization, observedAt) {
  const record = assertDProductionRecordSource({ record: sku.productionRecord, authorization, observedAt });
  requireCondition(record?.skuPackageId === sku.skuPackageId && record.supplierSkuId === sku.supplierSkuId &&
    record.platform === sku.targetPlatform && record.store === sku.targetStore && sameStoreRef(record.storeRef, sku.g1Identity.storeRef),
  "DE_JOB_SCOPE_PRODUCTION_RECORD_SOURCE_CONFLICT");
  return record;
}

/** A receipt is checked against its frozen authorization even when today's candidate has moved on. */
export function assertDProductionRecordSource({ record, authorization, observedAt }) {
  requireCondition(validateProductionRecord(record).valid && record.executionMode === "single_sku_seller_api" &&
    validateProductionReadbackExpectation(record.readbackExpectation), "DE_JOB_SCOPE_PRODUCTION_RECORD_INVALID");
  assertNoProductionSecrets(record);
  assertNoRawPersistenceKeys(record);
  const locked = authorization.lockedScope;
  requireCondition(record.sourceAuthorizationId === authorization.authorizationId &&
    record.sourceAuthorizationFingerprint === fingerprintCanonicalRecord(authorization) &&
    record.skuPackageId === locked.skuPackageId && record.supplierSkuId === locked.supplierSkuId &&
    record.platform === locked.platform && record.store === locked.storeRef.stableStoreId && sameStoreRef(record.storeRef, locked.storeRef) &&
    /^[1-9][0-9]*$/.test(record.platformProductId) &&
    record.merchantSku === locked.merchantSku && record.warehouseRef === locked.warehouseRef && record.credentialAlias === locked.credentialAlias &&
    record.readbackExpectation.warehouseId === authorization.executionBinding.warehouseId &&
    isDeepStrictEqual(record.expectedPrice, locked.platformWritePrice) && record.expectedStock === locked.stock &&
    isDeepStrictEqual(record.finalUploadAssetIds, locked.finalUploads.map(asset => asset.assetId)) &&
    record.readbackExpectation.media.every((asset, index) => asset.sha256 === locked.finalUploads[index].sha256 && asset.order === locked.finalUploads[index].order) &&
    timestamp(record.createdAt) >= timestamp(authorization.authorizedAt) && timestamp(record.createdAt) <= timestamp(observedAt),
  "DE_JOB_SCOPE_PRODUCTION_RECORD_SOURCE_CONFLICT");
  return record;
}

function assertSavedDReceipts(candidate, sku, authorization, record) {
  const state = sku.dSoftwareExecution;
  requireCondition(isObject(state) && state.continuationBlocked === false && state.expectedCandidateRevision === candidate.dataRevision,
    "DE_JOB_SCOPE_D_RECEIPT_SOURCE_CONFLICT");
  assertDProductionReceiptChain({ state, authorization, record, candidateId: candidate.id });
}

export function assertDProductionReceiptChain({ state, authorization, record, candidateId }) {
  requireCondition(isObject(state) && ["d-software-execution-state-v1","d-software-execution-state-v2"].includes(state.schemaVersion) &&
    state.status === "succeeded" && state.step === "independent_readback_observed" &&
    state.candidateId === candidateId && state.authorizationId === authorization.authorizationId &&
    state.executionKey === record.executionKey && state.productionPlanId === record.sourceProductionPlanId &&
    Number.isSafeInteger(state.candidateDataRevision) && state.candidateDataRevision >= authorization.resultCandidateRevision &&
    state.expectedCandidateRevision === state.candidateDataRevision + 1 &&
    state.executionRevision === CHECKPOINT_ORDER.length + 2 &&
    state.attempt?.status === "succeeded" && state.attempt.executionKey === record.executionKey &&
    isDeepStrictEqual(state.attempt.productionRecord, record) && isObject(state.productionPlan) &&
    state.productionPlan.planId === record.sourceProductionPlanId &&
    isDeepStrictEqual(state.productionPlan.sourceAuthorization, authorization) &&
    fingerprintCanonicalRecord(state.productionPlan) === record.sourceProductionPlanFingerprint &&
    Array.isArray(state.checkpoints) && state.checkpoints.every(isObject) &&
    isDeepStrictEqual(state.checkpoints.map(event => event.kind), CHECKPOINT_ORDER),
  "DE_JOB_SCOPE_D_RECEIPT_SOURCE_CONFLICT");
  const [, task, imported, stockIntent, inventory, readback] = state.checkpoints;
  requireCondition(/^[1-9][0-9]*$/.test(task.taskId) && imported.taskId === task.taskId && inventory.taskId === task.taskId &&
    imported.status === "imported" && imported.itemCount === 1 && imported.errorCount === 0 &&
    imported.productId === record.platformProductId && imported.merchantSku === record.merchantSku &&
    (state.platformContinuation?.requestReceiptRef ?? imported.requestReceiptRef) === record.requestReceiptRef && record.platformWriteEvidenceRef === record.requestReceiptRef &&
    stockIntent.taskId === task.taskId && stockIntent.productId === record.platformProductId && stockIntent.merchantSku === record.merchantSku &&
    stockIntent.warehouseId === record.readbackExpectation.warehouseId && stockIntent.stock === record.stockWritten &&
    inventory.productId === record.platformProductId && inventory.merchantSku === record.merchantSku &&
    inventory.updated === true && inventory.itemCount === 1 && inventory.errorCount === 0 &&
    inventory.warehouseId === record.readbackExpectation.warehouseId &&
    inventory.inventoryReceiptRef === record.inventoryReceiptRef &&
    isObject(readback.observation) && readback.observation.platformEvidenceRef === record.platformReadbackEvidenceRef &&
    record.platformEvidenceRef === record.platformReadbackEvidenceRef &&
    isDeepStrictEqual(readback.observation, state.attempt.immediateReadback), "DE_JOB_SCOPE_D_RECEIPT_SOURCE_CONFLICT");
}

/** Derive E work from the saved D terminal result; readbackHistory remains the sole E evidence collection. */
export function createEReadbackJobScope({ candidate, observedAt }) {
  const { sku, authorization } = sourceAuthorization(candidate, observedAt, ["C2", "D", "E"]);
  const record = sourceProductionRecord(candidate, sku, authorization, observedAt);
  assertSavedDReceipts(candidate, sku, authorization, record);
  const fingerprint = fingerprintCanonicalRecord(record);
  return safeScope({
    ...commonScope(candidate, authorization, E_SCOPE),
    sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision,
    sourceSkuRevision: sku.dataRevision, resultSkuRevision: sku.dataRevision,
    authorizationSourceRevision: authorization.sourceCandidateRevision, authorizationResultRevision: authorization.resultCandidateRevision,
    sourceProductionRecordId: record.productionRecordId, sourceProductionRecordFingerprint: fingerprint,
    sourceProductionPlanId: record.sourceProductionPlanId, sourceProductionPlanFingerprint: record.sourceProductionPlanFingerprint,
    sourceExecutionKey: record.executionKey, requestReceiptRef: record.requestReceiptRef, inventoryReceiptRef: record.inventoryReceiptRef,
    platformProductId: record.platformProductId, inputFingerprint: fingerprint
  });
}

export function assertEReadbackJobScope({ scope, candidate, observedAt }) {
  const expected = createEReadbackJobScope({ candidate, observedAt });
  requireCondition(isDeepStrictEqual(scope, expected), "DE_JOB_SCOPE_E_SOURCE_CONFLICT");
  return expected;
}
