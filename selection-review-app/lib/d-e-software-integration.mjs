import { createDPlatformObservationScope, assertDPlatformObservationPolicy, stopDInitialImportContinuationInDocument } from "./d-platform-observation-contract.mjs";
import { encodeAttempt, decodeAttempt } from "./d-execution-request-codec.mjs";
import { productionJobPrewriteCode } from "./production-execution-failure.mjs";
import { isReconciledDERequest } from "./d-e-software-job-results.mjs";
import { createSoftwareExecutionRuntime, openExceptionCase } from "./software-execution-state.mjs";
import { isDeepStrictEqual } from "node:util";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary } from "./business-state-repository.mjs";
import { assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { readAuthorizedProductionSnapshot, assertCurrentProductionAuthorization } from "./production-authorization.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { validateSystemCreatedVerificationRecord } from "./e-stage-readback.mjs";
import { createProductionPlan, assertValidProductionPlan, validateProductionPlanAuthorizationBinding } from "./production-plan.mjs";
import { assertCurrentDExecutionContext, assertCurrentProductionExecutionBinding, productionExecutionPrewriteFailure } from "./platform-write-preflight.mjs";
import { assertDProductionJobReference, settleDProductionJobInDocument } from "./d-e-software-job-handoff.mjs";
import { findSoftwareJobInDocument, softwareJobsInDocument, bindSoftwareJobAdmissionDecision,
  recordDESoftwareJobProgress, markSoftwareJobExternalRequestStarted } from "./software-job-contract.mjs";
import {
  assertDExecutableRequest,
  beginDSoftwareExecution,
  executeDSoftwareAttempt,
  markDSoftwareUnknownOutcome,
  prepareSingleSkuDExecution
} from "./d-e-software-closure.mjs";

export const D_E_SOFTWARE_INTEGRATION_VERSION = "d-e-software-integration-v1";
export const D_SOFTWARE_EXECUTION_STATE_VERSION = "d-software-execution-state-v2";

function gap(code, field, message) {
  return { code, field, message };
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function base(status, overrides = {}) {
  return freeze({
    schemaVersion: D_E_SOFTWARE_INTEGRATION_VERSION,
    available: true,
    status,
    platform: null,
    store: null,
    skuPackageId: null,
    productionPlanId: null,
    productionAuthorizationId: null,
    assetTransportStatus: "not_started",
    assetTransportEvidenceRef: null,
    assetTransportResolvedCount: 0,
    productionRecordId: null,
    eVerificationId: null,
    gaps: [],
    canPrepareExecution: false,
    canExecutePlatformWrite: false,
    requiresExactOwnerExecutionAuthorization: true,
    executionIntentPersisted: false,
    automaticRetry: false,
    browserFallback: false,
    codexDispatch: false,
    platformWrites: 0,
    ...overrides
  });
}

function requiredText(value, code) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${code}: 字段不能为空`);
  return value;
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 构造事务内部草稿；只有 commitDExecutionIntent 编码并原子保存后才成为执行状态。
 */
function createDExecutionIntentDraft({
  candidateId,
  candidateDataRevision,
  expectedCandidateRevision,
  preparedExecution,
  ownerExecutionDecision,
  startedAt
}) {
  requiredText(candidateId, "D_EXECUTION_CANDIDATE_REQUIRED");
  if (!Number.isInteger(candidateDataRevision) || !Number.isInteger(expectedCandidateRevision) ||
      candidateDataRevision !== expectedCandidateRevision) {
    throw new Error("D_EXECUTION_REVISION_CONFLICT: 候选修订号已变化");
  }
  if (!preparedExecution || preparedExecution.schemaVersion !== "d-software-execution-v2" ||
      preparedExecution.status !== "ready" || !preparedExecution.executableRequest) {
    throw new Error("D_EXECUTION_NOT_READY: 当前D请求尚未准备完成");
  }
  if (!ownerExecutionDecision || ownerExecutionDecision.confirmed !== true) {
    throw new Error("D_EXECUTION_OWNER_CONFIRMATION_REQUIRED: 缺少主人本轮精确执行确认");
  }

  const request = preparedExecution.executableRequest;
  if (request.candidateId !== candidateId) throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 执行请求不属于当前候选");
  if (!sameStoreRef(ownerExecutionDecision.storeRef, request.storeRef)) throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 完整店铺身份不一致");
  const exactFields = [
    ["merchantSku", "merchantSku"], ["warehouseRef", "warehouseRef"], ["credentialAlias", "credentialAlias"],
    ["authorizationId", "sourceAuthorizationId"],
    ["productionPlanId", "sourceProductionPlanId"],
    ["store", "store"],
    ["skuPackageId", "skuPackageId"],
    ["supplierSkuId", "supplierSkuId"],
    ["publishScope", "publishScope"],
    ["assetsFinalUploadsVersion", "assetsFinalUploadsVersion"]
  ];
  for (const [decisionField, requestField] of exactFields) {
    if (typeof ownerExecutionDecision[decisionField] !== "string" || !ownerExecutionDecision[decisionField] || ownerExecutionDecision[decisionField] !== request[requestField]) {
      throw new Error(`D_EXECUTION_OWNER_SCOPE_MISMATCH: ${decisionField}与授权执行请求不一致`);
    }
  }
  if (!exactJson(ownerExecutionDecision.platformWritePrice, request.platformWritePrice)) {
    throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 后台写入价格与授权执行请求不一致");
  }
  if (ownerExecutionDecision.stock !== 100 || request.stock !== 100) {
    throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 新品库存必须精确锁定为100");
  }
  const decisionAssetIds = ownerExecutionDecision.finalUploadAssetIds;
  const requestAssetIds = Array.isArray(request.finalUploads) ? request.finalUploads.map((asset) => asset.assetId) : [];
  if (!Array.isArray(decisionAssetIds) || !exactJson(decisionAssetIds, requestAssetIds)) {
    throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 最终上传素材集合或顺序不一致");
  }

  const attempt = beginDSoftwareExecution({ preparedExecution, startedAt });
  return freeze({
    candidateId,
    candidateDataRevision,
    authorizationId: request.sourceAuthorizationId,
    productionPlanId: request.sourceProductionPlanId,
    executionKey: attempt.executionKey,
    status: "in_flight",
    attempt,
    mustPersistBeforeSellerApi: true,
    canCallSellerApiBeforePersist: false,
    attemptLimit: 1,
    automaticRetry: false,
    retryAllowed: false,
    platformWrites: 0
  });
}

/** 对当前格式的已存记录作只读投影；不保存、不恢复或重放写入。旧记录由页面按历史状态展示。 */
export function reconcilePersistedDExecutionOnRestart({ executionState, restartedAt }) {
  if (!executionState || !["d-software-execution-state-v1", D_SOFTWARE_EXECUTION_STATE_VERSION].includes(executionState.schemaVersion) ||
      executionState.requestEncoding !== "ozon-fixed-protocols-v1" || !Number.isInteger(executionState.executionRevision) ||
      executionState.executionRevision < 1 || !Array.isArray(executionState.checkpoints) ||
      !Number.isInteger(executionState.expectedCandidateRevision) || !executionState.productionPlan ||
      typeof executionState.continuationBlocked !== "boolean" || !CHECKPOINT_ORDER.includes(executionState.step) ||
      ![0, 1, 2, "unknown"].includes(executionState.platformWrites)) {
    throw new Error("D_EXECUTION_STATE_INVALID: 持久化D执行状态无效");
  }
  decodeAttempt(executionState.attempt, { historicalRead: true });
  if (executionState.status !== "in_flight") return executionState;
  const attempt = markDSoftwareUnknownOutcome({
    executionAttempt: executionState.attempt,
    reason: "service_restart_after_persist_before_terminal_receipt",
    markedAt: restartedAt
  });
  return freeze({
    ...structuredClone(executionState),
    status: "unknown_outcome",
    attempt,
    automaticRetry: false,
    retryAllowed: false,
    platformWrites: executionState.platformWrites
  });
}

/**
 * 4317 的第6C接缝只生成可见准备度。它不读取凭证、不访问平台、不持久化执行意图，
 * 更不会调用 Seller API。真正D执行必须由后续受控执行路由先原子保存单次intent。
 */
export function buildDESoftwareIntegrationView({ candidate, eReadbackRuntimeView = null, platformWritePreflight = null, adapterCapabilities = null, currentProductionBinding = null, inspectedAt, activeExecutionKey = null }) {
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  if (!skuPackage) return base("not_applicable", { available: false, requiresExactOwnerExecutionAuthorization: false });

  const common = {
    platform: skuPackage.targetPlatform || null,
    store: skuPackage.targetStore || null,
    skuPackageId: skuPackage.skuPackageId || null,
    productionAuthorizationId: skuPackage.productionAuthorization?.authorizationId || null,
    productionRecordId: skuPackage.productionRecord?.productionRecordId || null,
    eVerificationId: skuPackage.eVerificationRecord?.verificationId || null
  };
  const dAssetTransport = skuPackage.dAssetTransport || null;
  const assetCommon = {
    assetTransportStatus: dAssetTransport?.status || "not_started",
    assetTransportEvidenceRef: dAssetTransport?.assetTransport?.evidenceRef || null,
    assetTransportResolvedCount: Array.isArray(dAssetTransport?.assetTransport?.resolvedAssets)
      ? dAssetTransport.assetTransport.resolvedAssets.length
      : 0
  };
  Object.assign(common, assetCommon);
  const executionState = skuPackage.dSoftwareExecution;
  if (executionState) {
    common.platformWrites = executionState.platformWrites;
    common.executionIntentPersisted = true;
    common.productionPlanId = executionState.productionPlanId;
    common.execution = {
      executionKey: executionState.executionKey, executionRevision: executionState.executionRevision,
      startedAt: executionState.attempt?.startedAt || null,
      lastProgressAt: executionState.checkpoints?.at(-1)?.observedAt || executionState.attempt?.startedAt || null,
      step: executionState.step, taskId: executionState.checkpoints?.find(event => event.kind === "import_task_received")?.taskId || null,
      productId: executionState.checkpoints?.find(event => event.kind === "import_result_observed")?.productId || null,
      continuationBlocked: executionState.continuationBlocked === true
    };
  }

  if (eReadbackRuntimeView?.status === "source_conflict") {
    return base("e_source_conflict", { ...common, requiresExactOwnerExecutionAuthorization: false,
      gaps: [gap(eReadbackRuntimeView.sourceConflict, "eVerificationRecord", "历史验证的商品来源已变化，当前结果待核对；记录保留，不会自动重读或重写。")] });
  }
  if (skuPackage.eVerificationRecord && validateSystemCreatedVerificationRecord(skuPackage.eVerificationRecord, skuPackage.productionRecord).valid &&
      skuPackage.eVerificationRecord.skuPackageId === skuPackage.skuPackageId) {
    return base("listed_verified", { ...common, requiresExactOwnerExecutionAuthorization: false });
  }
  if (skuPackage.productionRecord) {
    return base("awaiting_e_readback", {
      ...common,
      gaps: [gap("e_readback_not_completed", "eVerificationRecord", "系统创建记录已存在，仍需独立E回读")],
      requiresExactOwnerExecutionAuthorization: false
    });
  }
  if (executionState) {
    const currentlyRunning = executionState.status === "in_flight" && activeExecutionKey === executionState.executionKey;
    const status = currentlyRunning ? "execution_in_progress" : executionState.status === "failed" ? "execution_failed" : "execution_result_unconfirmed";
    return base(status, { ...common, requiresExactOwnerExecutionAuthorization: false,
      gaps: currentlyRunning ? [] : [gap("execution_reconciliation_required", "dSoftwareExecution", executionState.continuationBlocked
        ? "执行期间资料发生变化，已保留平台回执；后续写入已停止，需要核对现有结果"
        : "本次没有运行这条执行记录；已发生的请求和回执需要核对，系统不会重复提交")] });
  }
  if (!skuPackage.productionAuthorization) {
    return base("awaiting_production_authorization", {
      ...common,
      gaps: [gap("production_authorization_missing", "productionAuthorization", "尚未取得主人精确生产授权")]
    });
  }

  let productionPlan;
  try {
    if (dAssetTransport?.intent) {
      productionPlan = dAssetTransport.intent.productionPlan;
      if (!validateProductionPlanAuthorizationBinding(productionPlan, skuPackage.productionAuthorization).valid) {
        throw new Error("D_PRODUCTION_PLAN_AUTHORIZATION_DRIFT");
      }
    } else {
      productionPlan = createProductionPlan({
        productionAuthorization: skuPackage.productionAuthorization, candidateId: candidate.id,
        candidateRevision: candidate.dataRevision, skuPackage, createdAt: inspectedAt
      });
    }
  } catch (error) {
    return base("authorization_not_runnable", {
      ...common,
      gaps: [gap("production_plan_not_ready", "productionAuthorization", error.message)]
    });
  }

  const planCommon = { ...common, productionPlanId: productionPlan.planId };
  const missing = [];
  if (dAssetTransport?.continuationBlocked === true) {
    missing.push(gap("asset_transport_scope_changed", "dAssetTransport", "上传期间商品资料发生变化，回执已保留，后续生产执行已停止"));
  }
  if (dAssetTransport?.status === "failed") {
    missing.push(gap("asset_transport_not_attempted", "dAssetTransport", "生产配置核验未通过，未尝试OSS上传；须重新确认当前生产配置"));
  } else if (dAssetTransport?.status === "unknown_outcome") {
    missing.push(gap("asset_transport_unknown_outcome", "dAssetTransport", "OSS素材传输结果未知，禁止自动重试；需要主人开启新的精确授权轮"));
  } else if (productionPlan.sourceAuthorization.lockedScope.finalUploads.some(asset => asset.assetRef.startsWith("local-asset:")) && dAssetTransport?.status !== "verified") {
    missing.push(gap("asset_transport_not_ready", "dAssetTransport", "最终素材尚未取得已验证的OSS稳定HTTPS地址"));
  }
  if (!platformWritePreflight) missing.push(gap("platform_preflight_missing", "platformWritePreflight", "尚未完成当前店铺Seller API只读前检"));
  if (!adapterCapabilities) missing.push(gap("adapter_capabilities_missing", "adapterCapabilities", "尚未取得当前店铺、仓库、素材、库存与独立回读能力证据"));
  if (!currentProductionBinding) missing.push(gap("production_execution_binding_missing", "currentProductionBinding", "尚未取得当前服务端已核验的店铺仓库配置"));
  if (missing.length > 0) return base("not_ready", { ...planCommon, gaps: missing });

  let prepared;
  try {
    prepared = prepareSingleSkuDExecution({
      productionPlan,
      productionAuthorization: skuPackage.productionAuthorization,
      platformWritePreflight,
      adapterCapabilities,
      currentProductionBinding,
      preparedAt: inspectedAt
    });
  } catch (error) {
    return base("not_ready", { ...planCommon, gaps: [gap("d_preparation_rejected", "dExecution", error.message)] });
  }
  if (prepared.status !== "ready") return base("not_ready", { ...planCommon, gaps: prepared.gaps });

  return base("ready_for_explicit_execution", {
    ...planCommon,
    canPrepareExecution: true,
    canExecutePlatformWrite: false
  });
}


// Only these two verified protocol identifiers replace transport endpoint strings in persisted D requests.

function skuOf(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  if (!sku) throw new Error("D_EXECUTION_SKU_REQUIRED");
  return sku;
}

function clockValue(clock) {
  if (typeof clock !== "function") throw new Error("D_EXECUTION_CLOCK_REQUIRED");
  const value = clock();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("D_EXECUTION_CLOCK_INVALID");
  return value;
}

// Repository I/O errors may contain local paths or transport details. Domain errors thrown
// by a transaction's mutator retain their own boundary; only repository failures are translated.
function dPersistenceBoundary(repository, stage) {
  assertBusinessStateRepositoryBoundary(repository);
  function persistenceFailure(cause) {
    const code = stage === "checkpoint" ? "D_CHECKPOINT_PERSISTENCE_FAILED" : "D_EXECUTION_PERSISTENCE_FAILED";
    const error = new Error(code);
    error.code = code;
    error.persistenceStage = stage;
    error.replacementState = cause?.code === "ATOMIC_JSON_DURABILITY_UNCONFIRMED" && cause.replaced === true
      ? "replacement_written_durability_unconfirmed" : "unknown";
    return error;
  }
  return {
    ...repository,
    async readSnapshot() {
      try { return await repository.readSnapshot(); }
      catch (cause) { throw persistenceFailure(cause); }
    },
    async transact(mutator) {
      let domainFailure;
      let mutatorFailed = false;
      try {
        return await repository.transact(async document => {
          try { return await mutator(document); }
          catch (error) { mutatorFailed = true; domainFailure = error; throw error; }
        });
      } catch (cause) {
        if (mutatorFailed && cause === domainFailure) throw cause;
        throw persistenceFailure(cause);
      }
    }
  };
}

function ownerDecisionFromAuthorizedRequest(request) {
  return { confirmed: true, authorizationId: request.sourceAuthorizationId, productionPlanId: request.sourceProductionPlanId,
    store: request.store, storeRef: structuredClone(request.storeRef), warehouseRef: request.warehouseRef,
    credentialAlias: request.credentialAlias, merchantSku: request.merchantSku, skuPackageId: request.skuPackageId,
    supplierSkuId: request.supplierSkuId, publishScope: request.publishScope, assetsFinalUploadsVersion: request.assetsFinalUploadsVersion,
    platformWritePrice: structuredClone(request.platformWritePrice), stock: request.stock,
    finalUploadAssetIds: request.finalUploads.map(asset => asset.assetId) };
}

// Both historical owner execution and saved-worker execution use this one full preparation boundary.
function prepareDExecutionState({ candidate, candidateId, expectedCandidateRevision, productionPlan, platformWritePreflight,
  adapterCapabilities, currentProductionBinding, ownerExecutionDecision, observedAt, savedWorker = false }) {
  const authorization = productionPlan.sourceAuthorization;
  const skuPackageId = authorization.lockedScope.skuPackageId;
  assertCurrentProductionAuthorization(authorization, { observedAt });
  const sku = skuOf(candidate);
  if (sku.dSoftwareExecution || sku.productionRecord || sku.externalListingRecord) throw new Error("D_EXECUTION_ALREADY_EXISTS");
  if (sku.skuPackageId !== skuPackageId || !validateProductionPlanAuthorizationBinding(productionPlan, sku.productionAuthorization).valid) {
    throw new Error("D_EXECUTION_AUTHORIZATION_DRIFT");
  }
  const assetState = sku.dAssetTransport;
  let authorizationCandidateRevision = candidate.dataRevision;
  if (assetState?.intent) {
    if (assetState.status !== "verified" || assetState.continuationBlocked || assetState.executionRevision !== 2 ||
        assetState.intent.candidateDataRevision !== sku.productionAuthorization.resultCandidateRevision ||
        candidate.dataRevision !== assetState.intent.persistedCandidateRevision + 1 ||
        assetState.intent.persistedCandidateRevision !== assetState.intent.candidateDataRevision + 1 ||
        !isDeepStrictEqual(assetState.intent.productionPlan, productionPlan)) throw new Error("D_EXECUTION_ASSET_PROGRESS_DRIFT");
    authorizationCandidateRevision = assetState.intent.candidateDataRevision;
  }
  readAuthorizedProductionSnapshot({ productionAuthorization: sku.productionAuthorization, candidateId,
    candidateRevision: authorizationCandidateRevision, skuPackage: sku, checkedAt: observedAt });
  const preparedExecution = prepareSingleSkuDExecution({ productionPlan, productionAuthorization: sku.productionAuthorization,
    platformWritePreflight, adapterCapabilities, currentProductionBinding, preparedAt: observedAt });
  if (savedWorker && preparedExecution.status === "ready") {
    assertDExecutableRequest(preparedExecution.executableRequest);
    assertCurrentDExecutionContext({ request: preparedExecution.executableRequest,
      executionContext: { productionPlan, currentProductionBinding, serverClock: () => observedAt } });
    ownerExecutionDecision = ownerDecisionFromAuthorizedRequest(preparedExecution.executableRequest);
  }
  const intent = createDExecutionIntentDraft({ candidateId, candidateDataRevision: candidate.dataRevision,
    expectedCandidateRevision, preparedExecution, ownerExecutionDecision, startedAt: observedAt });
  const state = { ...structuredClone(intent), schemaVersion: D_SOFTWARE_EXECUTION_STATE_VERSION,
    attempt: encodeAttempt(intent.attempt), requestEncoding: "ozon-fixed-protocols-v1",
    productionPlan: structuredClone(productionPlan), executionRevision: 1, expectedCandidateRevision: candidate.dataRevision + 1,
    step: "intent_persisted", continuationBlocked: false, checkpoints: [], platformWrites: 0 };
  sku.dSoftwareExecution = state;
  candidate.updatedAt = observedAt;
  return state;
}

function assertSoftwareJobContext(context) {
  if (!context || typeof context !== "object" || Object.keys(context).length !== 4 ||
      !["jobStore", "jobId", "workerId", "leaseId"].every(field => Object.hasOwn(context, field)) ||
      typeof context.jobStore?.assertDEExecutionInDocument !== "function" ||
      ![context.jobId, context.workerId, context.leaseId].every(isCanonicalFrozenRef)) throw new Error("D_EXECUTION_SOFTWARE_JOB_CONTEXT_INVALID");
}

function assertSavedJobHolder({ document, candidate, state, softwareJobContext }) {
  assertSoftwareJobContext(softwareJobContext);
  const ref = state?.softwareJobRef;
  const job = findSoftwareJobInDocument(document, softwareJobContext.jobId);
  if (!ref || Object.keys(ref).length !== 4 || !["jobId", "revision", "workerId", "leaseId"].every(field => Object.hasOwn(ref, field)) ||
      ref.jobId !== job.jobId || ref.revision !== job.revision || ref.workerId !== job.workerId || ref.leaseId !== job.leaseId ||
      ref.workerId !== softwareJobContext.workerId || ref.leaseId !== softwareJobContext.leaseId ||
      job.jobType !== "d_production_execution" || job.candidateId !== candidate.id || job.skuPackageId !== skuOf(candidate).skuPackageId ||
      job.scopeBinding.authorizationRef !== state.productionPlan.sourceAuthorization.authorizationId ||
      job.scopeBinding.authorizationFingerprint !== fingerprintCanonicalRecord(state.productionPlan.sourceAuthorization)) {
    throw new Error("D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT");
  }
  return job;
}

function assertCurrentWorkerBinding(guard, currentProductionBinding) {
  const snapshot = guard.admissionDecision.executionBindingSnapshot;
  if (!currentProductionBinding || !snapshot ||
      ["bindingId", "configurationVersion", "warehouseId"].some(field => currentProductionBinding[field] !== snapshot.productionBinding[field]) ||
      ["platform", "warehouseRef", "credentialAlias"].some(field => currentProductionBinding[field] !== snapshot[field]) ||
      !sameStoreRef(currentProductionBinding.storeRef, snapshot.storeRef) ||
      currentProductionBinding.verification?.evidenceRef !== snapshot.configurationEvidence.evidenceRef) {
    throw new Error("PRODUCTION_EXECUTION_BINDING_DRIFT: 当前D配置与已领取服务接线不一致");
  }
}

function saveJobProgress(document, guard, softwareJobContext, progressRef, observedAt, { external = false } = {}) {
  let job = bindSoftwareJobAdmissionDecision(guard.job, guard.admissionDecision);
  const { workerId, leaseId } = softwareJobContext;
  if (external && job.status === "claimed") job = markSoftwareJobExternalRequestStarted({ job, workerId, leaseId,
    externalRequestRef: `d-production-request:${job.scopeBinding.authorizationFingerprint}`, serverTime: observedAt });
  job = recordDESoftwareJobProgress({ job, workerId, leaseId, progressRef, serverTime: observedAt });
  const jobs = softwareJobsInDocument(document);
  const index = jobs.findIndex(entry => entry.jobId === job.jobId);
  if (index < 0) throw new Error("D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT");
  jobs[index] = structuredClone(job);
}

function executionAdmissionResult(candidate, state, status = "committed") {
  return { status, candidate: structuredClone(candidate), result: { executionKey: state.executionKey,
    executionRevision: state.executionRevision, status: state.status, platformWrites: state.platformWrites } };
}

/** First admission is atomic. Its replay result never grants permission to call a platform. */
export async function commitDExecutionIntent({ repository, runtimeMode, actor, candidateId, expectedCandidateRevision,
  productionPlan, platformWritePreflight, adapterCapabilities, currentProductionBinding, ownerExecutionDecision, serverClock,
  softwareJobContext = null }) {
  if (softwareJobContext !== null) {
    assertSoftwareJobContext(softwareJobContext);
    if (actor?.actorType !== "worker" || actor.source !== "registered_runtime_worker" || actor.userId !== softwareJobContext.workerId) {
      throw new Error("D_EXECUTION_REGISTERED_WORKER_REQUIRED");
    }
    if (ownerExecutionDecision !== undefined) throw new Error("D_EXECUTION_SECOND_OWNER_DECISION_REJECTED");
  } else if (actor?.actorType !== "human" || actor.source !== "authenticated_identity_provider" || !actor.roles?.includes("owner")) {
    throw new Error("D_EXECUTION_AUTHENTICATED_OWNER_REQUIRED");
  }
  repository = dPersistenceBoundary(repository, "admission");
  assertValidProductionPlan(productionPlan);
  if (softwareJobContext !== null) return repository.transact(document => {
    const observedAt = clockValue(serverClock);
    const candidate = document.candidates.find(entry => entry.id === candidateId), sku = skuOf(candidate);
    if (sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2") throw new Error("D_EXECUTION_SAVED_HANDOFF_REQUIRED");
    if (sku.dSoftwareExecution) {
      const state = sku.dSoftwareExecution;
      const job = assertSavedJobHolder({ document, candidate, state, softwareJobContext });
      assertDProductionJobReference({ document, candidate, job });
      if (expectedCandidateRevision !== state.candidateDataRevision || !isDeepStrictEqual(productionPlan, state.productionPlan) ||
          !validateProductionPlanAuthorizationBinding(state.productionPlan, sku.productionAuthorization).valid) throw new Error("D_EXECUTION_REPLAY_SOURCE_CONFLICT");
      assertCurrentProductionAuthorization(state.productionPlan.sourceAuthorization, { observedAt: state.attempt.startedAt });
      decodeAttempt(state.attempt, { historicalRead: true });
      return { changed: false, result: executionAdmissionResult(candidate, state, "idempotent_replay") };
    }
    const guard = softwareJobContext.jobStore.assertDEExecutionInDocument({ document, ...softwareJobContext, observedAt });
    if (guard.job.candidateId !== candidateId || candidate.dataRevision !== expectedCandidateRevision) throw new Error("D_EXECUTION_REVISION_CONFLICT");
    assertCurrentWorkerBinding(guard, currentProductionBinding);
    const state = prepareDExecutionState({ candidate, candidateId, expectedCandidateRevision, productionPlan, platformWritePreflight,
      adapterCapabilities, currentProductionBinding, observedAt, savedWorker: true });
    state.softwareJobRef = { jobId: guard.job.jobId, revision: guard.job.revision,
      workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId };
    candidate.dataRevision += 1;
    saveJobProgress(document, guard, softwareJobContext, `d-progress:${guard.job.scopeBinding.authorizationFingerprint}:intent_persisted`, observedAt);
    return { changed: true, document, result: executionAdmissionResult(candidate, state) };
  });
  const authorization = productionPlan.sourceAuthorization, skuPackageId = authorization.lockedScope.skuPackageId;
  const idempotencyKey = `d-start:${candidateId}:${authorization.authorizationId}`;
  return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], candidateId, skuPackageId,
    expectedRevision: expectedCandidateRevision, idempotencyKey,
    inputFingerprint: fingerprintCanonicalRecord({ candidateId, expectedCandidateRevision, productionPlan, ownerExecutionDecision }),
    auditEventId: `audit:${idempotencyKey}`, authorizationRef: authorization.authorizationId,
    action: "start_single_sku_production", externalRequestState: "not_sent", serverClock,
    mutate: ({ candidate, observedAt }) => {
      if (skuOf(candidate).dHandoff?.schemaVersion === "c2-d-handoff-v2") throw new Error("D_EXECUTION_SOFTWARE_JOB_CONTEXT_REQUIRED");
      const state = prepareDExecutionState({ candidate, candidateId, expectedCandidateRevision, productionPlan, platformWritePreflight,
        adapterCapabilities, currentProductionBinding, ownerExecutionDecision, observedAt });
      return { candidate, result: executionAdmissionResult(candidate, state).result };
    }
  });
}

const CHECKPOINT_FIELDS = Object.freeze({
  import_intent: [],
  import_task_received: ["taskId"],
  import_result_observed: ["taskId", "productId", "merchantSku", "itemCount", "status", "errorCount", "requestReceiptRef"],
  stock_intent: ["taskId", "productId", "merchantSku", "warehouseId", "stock"],
  stock_receipt_observed: ["taskId", "productId", "merchantSku", "warehouseId", "updated", "itemCount", "errorCount", "inventoryReceiptRef"],
  independent_readback_observed: ["observation"]
});
const CHECKPOINT_ORDER = Object.freeze(["intent_persisted", ...Object.keys(CHECKPOINT_FIELDS)]);

function assertCheckpoint(event) {
  const fields = CHECKPOINT_FIELDS[event?.kind];
  if (!fields || Object.keys(event).length !== fields.length + 1 || fields.some(field => !Object.hasOwn(event, field))) {
    throw new Error("D_CHECKPOINT_INPUT_INVALID");
  }
  try { assertSafeRuntimeRecord(event, "dExecution.checkpoint"); }
  catch {
    const error = new Error("D_CHECKPOINT_OBSERVATION_REJECTED: 平台观察不符合可保存回执规则");
    error.code = "D_CHECKPOINT_OBSERVATION_REJECTED";
    throw error;
  }
}

/** Receipts use execution CAS. Concurrent owner edits are preserved and prevent the next write. */
export async function persistDExecutionCheckpoint({ repository, candidateId, executionKey, expectedExecutionRevision, event, serverClock,
  softwareJobContext = null, currentProductionBinding = null }) {
  assertBusinessStateRepositoryBoundary(repository); assertCheckpoint(event);
  repository = dPersistenceBoundary(repository, "checkpoint");
  const outcome = await repository.transact(document => {
    const observedAt = clockValue(serverClock);
    const candidate = document.candidates.find(entry => entry.id === candidateId);
    const sku = skuOf(candidate);
    const state = sku.dSoftwareExecution;
    if (!state || state.executionKey !== executionKey || state.executionRevision !== expectedExecutionRevision ||
        state.status !== "in_flight" || state.requestEncoding !== "ozon-fixed-protocols-v1") throw new Error("D_CHECKPOINT_REVISION_CONFLICT");
    const savedJob = state.softwareJobRef || softwareJobContext !== null || sku.dHandoff?.schemaVersion === "c2-d-handoff-v2"
      ? assertSavedJobHolder({ document, candidate, state, softwareJobContext }) : null;
    const attempt = decodeAttempt(state.attempt);
    if (attempt.executionKey !== executionKey || attempt.request.executionKey !== executionKey ||
        attempt.attemptId !== beginDSoftwareExecution({ preparedExecution: { schemaVersion: "d-software-execution-v2", status: "ready", executableRequest: attempt.request }, startedAt: attempt.startedAt }).attemptId) {
      throw new Error("D_CHECKPOINT_EXECUTION_IDENTITY_INVALID");
    }
    if (CHECKPOINT_ORDER.indexOf(event.kind) !== CHECKPOINT_ORDER.indexOf(state.step) + 1) throw new Error("D_CHECKPOINT_SEQUENCE_REJECTED");
    const drifted = state.continuationBlocked || candidate.dataRevision !== state.expectedCandidateRevision ||
      !validateProductionPlanAuthorizationBinding(state.productionPlan, sku.productionAuthorization).valid;
    const writing = ["import_intent", "stock_intent"].includes(event.kind);
    let guard = null, blockCode = drifted ? "candidate_changed_during_production" : null;
    if (savedJob && writing && !drifted) {
      try {
        guard = softwareJobContext.jobStore.assertDEExecutionInDocument({ document, ...softwareJobContext, observedAt });
        assertCurrentWorkerBinding(guard, currentProductionBinding);
        assertCurrentDExecutionContext({ request: attempt.request,
          executionContext: { productionPlan: state.productionPlan, currentProductionBinding, serverClock: () => observedAt } });
      } catch (error) {
        blockCode = productionJobPrewriteCode(error);
        if (!blockCode) throw error;
      }
    }
    if (blockCode && writing) {
      state.continuationBlocked = true;
      state.blockReason = blockCode;
      state.executionRevision += 1;
      return { changed: true, document, result: { blocked: true, blockCode, executionRevision: state.executionRevision } };
    }
    const previous = state.checkpoints.at(-1);
    if (event.kind === "stock_intent" && (previous.status !== "imported" || previous.errorCount !== 0 || previous.itemCount !== 1 ||
        previous.merchantSku !== attempt.request.merchantSku || !/^[1-9][0-9]*$/.test(previous.productId) ||
        event.taskId !== previous.taskId || event.productId !== previous.productId || event.merchantSku !== attempt.request.merchantSku ||
        event.warehouseId !== attempt.request.inventoryWrite.warehouseId || event.stock !== attempt.request.stock)) throw new Error("D_CHECKPOINT_STOCK_SCOPE_REJECTED");
    if (event.kind === "import_task_received" && !/^[1-9][0-9]*$/.test(event.taskId)) throw new Error("D_CHECKPOINT_TASK_ID_INVALID");
    if (["import_result_observed", "stock_receipt_observed"].includes(event.kind) && event.taskId !== state.checkpoints.find(entry => entry.kind === "import_task_received").taskId) {
      throw new Error("D_CHECKPOINT_TASK_ID_MISMATCH");
    }
    state.checkpoints.push({ ...structuredClone(event), observedAt });
    state.step = event.kind; state.executionRevision += 1;
    if (state.platformContinuation && event.kind === "stock_intent") state.platformContinuation.inventoryWriteState = "intent_persisted";
    if (state.platformContinuation && event.kind === "stock_receipt_observed") state.platformContinuation.inventoryWriteState = event.updated === true && event.errorCount === 0 ? "succeeded" : "unknown";
    if (state.platformContinuation) state.attempt.platformContinuation = structuredClone(state.platformContinuation);
    state.continuationBlocked = drifted;
    if (drifted) state.blockReason = "candidate_changed_during_production";
    if (writing) state.platformWrites = "unknown";
    if (guard) saveJobProgress(document, guard, softwareJobContext,
      `d-progress:${savedJob.scopeBinding.authorizationFingerprint}:${event.kind}`, observedAt, { external: true });
    return { changed: true, document, result: { blocked: false, executionRevision: state.executionRevision } };
  });
  if (outcome.blocked) {
    const error = new Error("D_EXECUTION_CONTINUATION_BLOCKED: 商品资料已变化，已保存回执，禁止下一次写入");
    error.code = "D_EXECUTION_CONTINUATION_BLOCKED";
    error.blockCode = outcome.blockCode;
    error.executionRevision = outcome.executionRevision;
    throw error;
  }
  return outcome;
}



async function settleDExecution({ repository, candidateId, executionKey, expectedExecutionRevision, terminalAttempt, serverClock,
  softwareJobContext = null, platformObservationPolicy = null, currentProductionBinding = null }) {
  repository = dPersistenceBoundary(repository, "terminal");
  let unexpectedAcceptanceError;
  let hasUnexpectedAcceptanceError = false;
  const outcome = await repository.transact(document => {
    const settledAt = clockValue(serverClock);
    const candidate = document.candidates.find(entry => entry.id === candidateId);
    const sku = skuOf(candidate);
    const state = sku.dSoftwareExecution;
    if (!state || state.executionKey !== executionKey || state.executionRevision !== expectedExecutionRevision || state.status !== "in_flight") {
      throw new Error("D_EXECUTION_SETTLEMENT_CONFLICT");
    }
    if (state.softwareJobRef || softwareJobContext !== null || sku.dHandoff?.schemaVersion === "c2-d-handoff-v2") {
      assertSavedJobHolder({ document, candidate, state, softwareJobContext });
    }
    const persistedAttempt = decodeAttempt(state.attempt);
    if (terminalAttempt.attemptId !== persistedAttempt.attemptId || !isDeepStrictEqual(terminalAttempt.request, persistedAttempt.request) ||
        !["succeeded", "failed", "unknown_outcome", "waiting_platform"].includes(terminalAttempt.status)) throw new Error("D_EXECUTION_TERMINAL_RESULT_INVALID");
    if (terminalAttempt.status === "waiting_platform" && softwareJobContext !== null &&
        isReconciledDERequest(findSoftwareJobInDocument(document, softwareJobContext.jobId))) {
      if (state.schemaVersion !== D_SOFTWARE_EXECUTION_STATE_VERSION || state.step !== "import_task_received" ||
          state.checkpoints.length !== 2 || state.checkpoints[1].taskId !== terminalAttempt.platformResult.taskId) {
        throw new Error("D_PLATFORM_ACCEPTANCE_SOURCE_CONFLICT");
      }
      // A late acceptance is evidence for reconciliation, never permission to start a continuation.
      const acceptedAttempt = { ...structuredClone(persistedAttempt), platformResult: structuredClone(terminalAttempt.platformResult) };
      terminalAttempt = markDSoftwareUnknownOutcome({ executionAttempt: acceptedAttempt,
        reason: "initial_import_acceptance_after_reconciliation", markedAt: settledAt });
    }
    if (terminalAttempt.status === "waiting_platform") {
      if (state.step !== "import_task_received" || state.checkpoints.length !== 2 ||
          state.checkpoints[1].taskId !== terminalAttempt.platformResult.taskId || state.schemaVersion !== D_SOFTWARE_EXECUTION_STATE_VERSION) {
        throw new Error("D_PLATFORM_ACCEPTANCE_SOURCE_CONFLICT");
      }
      // Receipt recording is allowed after expiry; permission to continue is checked separately.
      // stopTrigger：停下时必须记清楚是哪一条判定、比较的是哪两个值。
      // 2026-09-24 背心停在 context_changed，记录里只有这一个词，两个人各查了一小时才定位到
      // 是「观察策略过期」。原因不该靠事后翻代码去猜。
      let stopReason = null, stopTrigger = null;
      const trip = (reason, condition, left, right) => { stopReason = reason; stopTrigger = { condition, left, right }; };
      if (state.continuationBlocked) trip("context_changed", "state.continuationBlocked", true, false);
      else if (candidate.dataRevision !== state.expectedCandidateRevision) {
        trip("context_changed", "candidate.dataRevision !== state.expectedCandidateRevision",
          candidate.dataRevision, state.expectedCandidateRevision);
      } else if (!validateProductionPlanAuthorizationBinding(state.productionPlan, sku.productionAuthorization).valid) {
        trip("context_changed", "productionPlan 与当前授权绑定校验不通过",
          state.productionPlan?.sourceAuthorization?.authorizationId ?? null, sku.productionAuthorization?.authorizationId ?? null);
      }
      const sourceDJob = softwareJobContext === null ? null : findSoftwareJobInDocument(document, softwareJobContext.jobId);
      if (sourceDJob && Date.parse(settledAt) >= Date.parse(sourceDJob.leaseExpiresAt)) {
        trip("lease_expired", "settledAt >= job.leaseExpiresAt", settledAt, sourceDJob.leaseExpiresAt);
      }
      if (platformObservationPolicy !== null && Date.parse(settledAt) >= Date.parse(platformObservationPolicy.expiresAt)) {
        trip("context_changed", "settledAt >= platformObservationPolicy.expiresAt", settledAt, platformObservationPolicy.expiresAt);
      }
      if (sourceDJob && stopReason === null) {
        try {
          const guard = softwareJobContext.jobStore.assertDEExecutionInDocument({ document, ...softwareJobContext, observedAt: settledAt });
          assertCurrentWorkerBinding(guard, currentProductionBinding);
          assertCurrentDExecutionContext({ request: persistedAttempt.request,
            executionContext: { productionPlan: state.productionPlan, currentProductionBinding, serverClock: () => settledAt } });
        } catch (error) {
          if (productionJobPrewriteCode(error)) trip("context_changed", "接受后守卫拒绝", productionJobPrewriteCode(error), null);
          else {
            unexpectedAcceptanceError = error;
            hasUnexpectedAcceptanceError = true;
            terminalAttempt = markDSoftwareUnknownOutcome({ executionAttempt: { ...structuredClone(persistedAttempt),
              platformResult: structuredClone(terminalAttempt.platformResult) },
              reason: "initial_import_acceptance_guard_system_failure", markedAt: settledAt });
          }
        }
      }
      if (!hasUnexpectedAcceptanceError) {
        state.attempt = encodeAttempt(terminalAttempt); state.status = "waiting_platform";
        state.platformContinuation = structuredClone(terminalAttempt.platformContinuation);
        state.executionRevision += 1; state.settledAt = settledAt;
        state.platformWrites = 1;
        if (sourceDJob && stopReason !== null) {
          state.stopTrigger = { schemaVersion: "d-initial-import-stop-trigger-v1", failureClass: stopReason,
            condition: stopTrigger.condition, left: stopTrigger.left, right: stopTrigger.right, settledAt };
          stopDInitialImportContinuationInDocument({ document, job: sourceDJob, workerId: softwareJobContext.workerId,
            leaseId: softwareJobContext.leaseId, observedAt: settledAt, failureClass: stopReason });
          softwareJobContext.jobStore.settleDInitialImportStoppedInDocument({ document, jobId: sourceDJob.jobId,
            workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId, observedAt: settledAt });
          assertSafeRuntimeRecord(state, "dExecution");
          return { changed: true, document, result: { status: state.status, candidate: structuredClone(candidate),
            executionRevision: state.executionRevision, platformWrites: 1 } };
        }
        if (softwareJobContext !== null) {
          softwareJobContext.jobStore.parkDProductionWaitingInDocument({ document, candidate, jobId:softwareJobContext.jobId,
            workerId:softwareJobContext.workerId, leaseId:softwareJobContext.leaseId, observedAt:settledAt });
        }
        if (softwareJobContext !== null && platformObservationPolicy !== null) {
          const sourceDJob = findSoftwareJobInDocument(document,softwareJobContext.jobId);
          const scope = createDPlatformObservationScope({document,candidate,sourceDJob,policy:platformObservationPolicy,
            queryIndex:1,nextEligibleAt:settledAt,observedAt:settledAt});
          softwareJobContext.jobStore.enqueueDPlatformObservationInDocument({document,candidate,sourceDJob,scope,policy:platformObservationPolicy,observedAt:settledAt});
        }
        assertSafeRuntimeRecord(state, "dExecution");
        return {changed:true,document,result:{status:state.status,candidate:structuredClone(candidate),executionRevision:state.executionRevision,platformWrites:1}};
      }
    }
    const encodedTerminal = encodeAttempt(terminalAttempt);
    if(state.platformContinuation) {
      state.platformContinuation.status = terminalAttempt.status === 'succeeded' ? 'completed' : terminalAttempt.status === 'unknown_outcome' ? 'unknown_outcome' : 'blocked';
      encodedTerminal.platformContinuation = structuredClone(state.platformContinuation);
    }
    state.attempt = encodedTerminal;
    state.status = terminalAttempt.status;
    state.executionRevision += 1; state.settledAt = settledAt;
    state.continuationBlocked = state.continuationBlocked || candidate.dataRevision !== state.expectedCandidateRevision ||
      !validateProductionPlanAuthorizationBinding(state.productionPlan, sku.productionAuthorization).valid;
    if (state.continuationBlocked && !state.blockReason) state.blockReason = "candidate_changed_during_production";
    if (terminalAttempt.status === "succeeded") {
      const imported = state.checkpoints.find(event => event.kind === "import_result_observed");
      const inventory = state.checkpoints.find(event => event.kind === "stock_receipt_observed");
      if (state.step !== "independent_readback_observed" || !terminalAttempt.productionRecord ||
          (state.platformContinuation?.requestReceiptRef ?? imported?.requestReceiptRef) !== terminalAttempt.productionRecord.requestReceiptRef ||
          imported.productId !== terminalAttempt.productionRecord.platformProductId ||
          inventory?.inventoryReceiptRef !== terminalAttempt.productionRecord.inventoryReceiptRef ||
          inventory.productId !== imported.productId || inventory.updated !== true || inventory.errorCount !== 0 || inventory.itemCount !== 1 ||
          inventory.warehouseId !== persistedAttempt.request.inventoryWrite.warehouseId) throw new Error("D_EXECUTION_TERMINAL_RECEIPTS_MISSING");
      if (sku.productionRecord) throw new Error("D_EXECUTION_PRODUCTION_RECORD_EXISTS");
      sku.productionRecord = structuredClone(terminalAttempt.productionRecord);
      state.platformWrites = 2;
    } else if (state.step === "intent_persisted" || terminalAttempt.status === "failed" && state.step === "import_intent") {
      state.platformWrites = 0;
    }
    assertSafeRuntimeRecord(state, "dExecution");
    if (state.softwareJobRef) settleDProductionJobInDocument({ document, candidate, jobId: softwareJobContext.jobId,
      workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId, observedAt: settledAt });
    if (hasUnexpectedAcceptanceError) {
      const job = findSoftwareJobInDocument(document, softwareJobContext.jobId);
      const prior = candidate.executionRuntime || createSoftwareExecutionRuntime({ candidateId: candidate.id,
        dataRevision: candidate.dataRevision, businessPhase: "D", stepId: "D_IMPORT_ACCEPTANCE", at: settledAt });
      if (prior.exceptionCase?.status !== "open") candidate.executionRuntime = openExceptionCase({ ...prior, businessPhase: "D", stepId: "D_IMPORT_ACCEPTANCE" }, {
        exceptionId: `exception:d-import-acceptance:${job.jobId}`, reasonCode: "system_failure", failureLayer: "d_import_acceptance",
        evidenceRefs: [state.attempt.platformResult.requestReceiptRef], skuPackageId: job.skuPackageId, softwareJobId: job.jobId,
        lastSuccessfulStepId: "import_task_received", externalRequestRefs: [job.externalRequestRef], unknownOutcome: true,
        sourceRevision: job.revision, at: settledAt });
    }
    return { changed: true, document, result: { status: state.status, candidate: structuredClone(candidate),
      executionRevision: state.executionRevision, platformWrites: state.platformWrites } };
  });
  if (hasUnexpectedAcceptanceError) throw unexpectedAcceptanceError;
  return outcome;
}

/** Only a fresh committed admission constructs an adapter; startup and replay never enter this function's execution branch. */
export async function runPersistedDExecution({ createAdapter, ...input }) {
  if (typeof createAdapter !== "function") throw new Error("D_EXECUTION_ADAPTER_FACTORY_REQUIRED");
  if (input.platformObservationPolicy != null) assertDPlatformObservationPolicy(input.platformObservationPolicy);
  const admission = await commitDExecutionIntent(input);
  if (admission.status === "idempotent_replay") {
    if (input.softwareJobContext) {
      const state = skuOf(admission.candidate).dSoftwareExecution;
      return { status: "idempotent_replay", candidate: admission.candidate, executionStatus: state.status, platformWrites: state.platformWrites };
    }
    const document = await dPersistenceBoundary(input.repository, "replay_read").readSnapshot();
    const candidate = document.candidates.find(entry => entry.id === input.candidateId);
    const state = skuOf(candidate).dSoftwareExecution;
    if (!state || state.executionKey !== admission.result.executionKey) throw new Error("D_EXECUTION_REPLAY_STATE_MISSING");
    decodeAttempt(state.attempt, { historicalRead: true });
    return { status: "idempotent_replay", candidate, executionStatus: state.status, platformWrites: state.platformWrites };
  }
  const state = skuOf(admission.candidate).dSoftwareExecution;
  const attempt = decodeAttempt(state.attempt);
  let executionRevision = state.executionRevision;
  let unexpectedCheckpointFailure = null, blockedCheckpointCode = null, importGuardBlocked = false;
  const persistCheckpoint = async event => {
    try {
      const saved = await persistDExecutionCheckpoint({ repository: input.repository, candidateId: input.candidateId,
        executionKey: state.executionKey, expectedExecutionRevision: executionRevision, event, serverClock: input.serverClock,
        softwareJobContext: input.softwareJobContext, currentProductionBinding: input.currentProductionBinding });
      executionRevision = saved.executionRevision;
    } catch (cause) {
      if (Number.isInteger(cause.executionRevision)) executionRevision = cause.executionRevision;
      const code = cause.code || String(cause.message).split(":", 1)[0];
      const boundary = code.startsWith("D_CHECKPOINT_") || code === "D_EXECUTION_CONTINUATION_BLOCKED";
      if (input.softwareJobContext && !boundary) { unexpectedCheckpointFailure = cause; throw cause; }
      if (code === "D_EXECUTION_CONTINUATION_BLOCKED") blockedCheckpointCode = cause.blockCode;
      const error = new Error(boundary ? code : "D_CHECKPOINT_PERSISTENCE_FAILED");
      error.code = boundary ? code : "D_CHECKPOINT_PERSISTENCE_FAILED";
      if (error.code === "D_CHECKPOINT_PERSISTENCE_FAILED") {
        error.persistenceStage = "checkpoint";
        error.replacementState = cause.replacementState === "replacement_written_durability_unconfirmed"
          ? cause.replacementState : "unknown";
        error.checkpoint = { kind: event.kind,
          ...(/^[1-9][0-9]*$/.test(event.taskId) ? { taskId: event.taskId } : {}),
          ...(/^[1-9][0-9]*$/.test(event.productId) ? { productId: event.productId } : {}) };
      }
      throw error;
    }
  };
  const beforeImportSend = async () => {
    if(!input.softwareJobContext)return;
    try {
      const outcome=await input.repository.transact(document=>{
        const candidate=document.candidates.find(value=>value.id === input.candidateId),current=skuOf(candidate).dSoftwareExecution;
        const job=assertSavedJobHolder({document,candidate,state:current,softwareJobContext:input.softwareJobContext});
        if(current.status !== 'in_flight' || current.executionKey !== state.executionKey || current.executionRevision !== executionRevision ||
          current.step !== 'import_intent' || current.checkpoints.length !== 1 || !['claimed','waiting_platform'].includes(job.status))
          throw new Error('D_CHECKPOINT_EXECUTION_IDENTITY_INVALID');
        let blockCode=current.continuationBlocked || candidate.dataRevision !== current.expectedCandidateRevision ||
          !validateProductionPlanAuthorizationBinding(current.productionPlan,skuOf(candidate).productionAuthorization).valid
          ? 'candidate_changed_during_production' : null;
        if(!blockCode) {
          try {
            const observedAt=clockValue(input.serverClock);
            const guard=input.softwareJobContext.jobStore.assertDEExecutionInDocument({document,...input.softwareJobContext,observedAt});
            assertCurrentWorkerBinding(guard,input.currentProductionBinding);
            assertCurrentDExecutionContext({request:attempt.request,executionContext:{productionPlan:current.productionPlan,
              currentProductionBinding:input.currentProductionBinding,serverClock:()=>observedAt}});
          }catch(error){blockCode=productionJobPrewriteCode(error);if(!blockCode)throw error;}
        }
        if(!blockCode)return {changed:false,document,result:{blocked:false}};
        current.continuationBlocked=true;current.blockReason=blockCode;current.executionRevision++;
        return {changed:true,document,result:{blocked:true,blockCode,executionRevision:current.executionRevision}};
      });
      if(outcome.blocked){
        blockedCheckpointCode=outcome.blockCode;executionRevision=outcome.executionRevision;importGuardBlocked=true;
        const error=new Error('D_EXECUTION_CONTINUATION_BLOCKED');error.code=error.message;throw error;
      }
    }catch(cause){
      if(cause.code === 'D_EXECUTION_CONTINUATION_BLOCKED')throw cause;
      unexpectedCheckpointFailure=cause;const error=new Error('D_CHECKPOINT_IMPORT_GUARD_FAILED');error.code=error.message;throw error;
    }
  };
  let terminalAttempt;
  try {
    assertCurrentProductionExecutionBinding({ productionAuthorization: state.productionPlan.sourceAuthorization,
      currentProductionBinding: input.currentProductionBinding, checkedAt: clockValue(input.serverClock) });
  } catch (error) {
    const failure = productionExecutionPrewriteFailure(error);
    if (!failure) throw error;
    terminalAttempt = freeze({ ...structuredClone(attempt), status: "failed", completedAt: clockValue(input.serverClock),
      failure: { ...failure, message: "当前生产执行条件核验未通过，未发起平台写入" }, retryAllowed: false, productionRecord: null });
    return settleDExecution({ repository: input.repository, candidateId: input.candidateId, executionKey: state.executionKey,
      expectedExecutionRevision: executionRevision, terminalAttempt, serverClock: input.serverClock, softwareJobContext: input.softwareJobContext, platformObservationPolicy: input.platformObservationPolicy, currentProductionBinding: input.currentProductionBinding });
  }
  const executionContext = Object.freeze({ productionPlan: freeze(structuredClone(state.productionPlan)),
    currentProductionBinding: freeze(structuredClone(input.currentProductionBinding)), serverClock: input.serverClock });
  try {
    const adapter = await createAdapter({ candidateId: input.candidateId, executionKey: state.executionKey, request: freeze(structuredClone(attempt.request)), executionContext });
    terminalAttempt = await executeDSoftwareAttempt({ executionAttempt: attempt, executionContext, executeSellerApi:(request,options)=>adapter.executeSellerApi(request,{...options,beforeRequestSend:beforeImportSend}),
      readbackSellerApi: adapter.readbackSellerApi, persistCheckpoint, completionClock: input.serverClock });
  } catch (error) {
    if (unexpectedCheckpointFailure) throw unexpectedCheckpointFailure;
    if (error.code === "D_CHECKPOINT_PERSISTENCE_FAILED") throw error;
    const prewriteFailure = productionExecutionPrewriteFailure(error);
    if (input.softwareJobContext && !prewriteFailure && error.code !== "D_EXECUTION_CONTINUATION_BLOCKED" &&
        error.code !== "D_CHECKPOINT_OBSERVATION_REJECTED") throw error;
    terminalAttempt = input.softwareJobContext && blockedCheckpointCode && (executionRevision === state.executionRevision + 1 || importGuardBlocked)
      ? freeze({ ...structuredClone(attempt), status: "failed", completedAt: clockValue(input.serverClock),
        failure: { layer: "production_admission", code: blockedCheckpointCode, message: "当前D写前门禁未通过，未发起平台写入" },
        retryAllowed: false, productionRecord: null })
      : prewriteFailure && executionRevision === state.executionRevision
      ? freeze({ ...structuredClone(attempt), status: "failed", completedAt: clockValue(input.serverClock),
        failure: { ...prewriteFailure, message: "当前生产执行条件核验未通过，未发起平台写入" }, retryAllowed: false, productionRecord: null })
      : markDSoftwareUnknownOutcome({ executionAttempt: attempt,
      reason: error.code === "D_EXECUTION_CONTINUATION_BLOCKED" ? "candidate_changed_during_production" :
        error.code === "D_CHECKPOINT_OBSERVATION_REJECTED" ? "platform_observation_rejected" : "execution_stopped_before_terminal_receipt",
      markedAt: clockValue(input.serverClock) });
  }
  return settleDExecution({ repository: input.repository, candidateId: input.candidateId, executionKey: state.executionKey,
    expectedExecutionRevision: executionRevision, terminalAttempt, serverClock: input.serverClock, softwareJobContext: input.softwareJobContext, platformObservationPolicy: input.platformObservationPolicy, currentProductionBinding: input.currentProductionBinding });
}

/** Continue only the never-sent inventory step of the original persisted D attempt. */
export async function runPersistedDRemainingInventory({repository,candidateId,softwareJobContext,createAdapter,serverClock,
  currentProductionBinding,observation,assertRemainingInventoryAuthorization}) {
  if(typeof createAdapter !== 'function' || typeof assertRemainingInventoryAuthorization !== 'function') throw new Error('D_INVENTORY_CONTINUATION_DEPENDENCY_REQUIRED');
  const document = await repository.readSnapshot(), candidate = document.candidates.find(value=>value.id===candidateId), state = skuOf(candidate).dSoftwareExecution;
  if(state?.schemaVersion !== D_SOFTWARE_EXECUTION_STATE_VERSION || state.status !== 'in_flight' ||
    state.platformContinuation?.status !== 'inventory_running' || state.step !== 'import_result_observed' || state.checkpoints.length !== 3) {
    throw new Error('D_INVENTORY_CONTINUATION_STATE_INVALID');
  }
  assertSavedJobHolder({document,candidate,state,softwareJobContext});
  const attempt = decodeAttempt(state.attempt), executionContext = {productionPlan:state.productionPlan,currentProductionBinding,serverClock};
  let executionRevision = state.executionRevision;
  const adapter = await createAdapter({executionContext,request:attempt.request});
  const persistCheckpoint = async event => {
    const saved = await persistDExecutionCheckpoint({repository,candidateId,executionKey:state.executionKey,
      expectedExecutionRevision:executionRevision,event,serverClock,currentProductionBinding,softwareJobContext});
    executionRevision = saved.executionRevision;
  };
  const terminalAttempt = await executeDSoftwareAttempt({executionAttempt:attempt,executionContext,persistCheckpoint,completionClock:serverClock,
    executeSellerApi:(request,options)=>adapter.executeRemainingInventory(request,{...options,observation,assertRemainingInventoryAuthorization}),
    readbackSellerApi:adapter.readbackSellerApi});
  return settleDExecution({repository,candidateId,executionKey:state.executionKey,expectedExecutionRevision:executionRevision,
    terminalAttempt,serverClock,softwareJobContext});
}
