import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveFinalUploads } from "./ozon-seller-api-de-adapter.mjs";
import { uploadAliyunOssFinalAssets } from "./aliyun-oss-asset-transport.mjs";
import { createProductionPlan, projectProductionPlanInputs, fingerprintProductionAuthorization, validateProductionPlanAuthorizationBinding } from "./production-plan.mjs";
import { assertValidProductionAuthorization } from "./production-authorization.mjs";
import { assertCurrentProductionExecutionBinding } from "./platform-write-preflight.mjs";
import { assetTransportPrewriteFailure, isAssetTransportPrewriteFailure, isProductionExecutionPrewriteFailure } from "./production-execution-failure.mjs";
import { isCanonicalFrozenRef, dProductionJobRound } from "./production-contract-primitives.mjs";

export const ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION = "aliyun-oss-d-asset-integration-v1";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function currentSku(candidate) {
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  if (!skuPackage) throw new Error("OSS_D_SKU_PACKAGE_MISSING: 当前商品缺少新版SKU生命周期包");
  if (!skuPackage.productionAuthorization) throw new Error("OSS_D_AUTHORIZATION_MISSING: 尚未取得主人精确生产授权");
  if (skuPackage.productionRecord) throw new Error("OSS_D_ALREADY_PRODUCED: 当前SKU已有生产记录");
  return skuPackage;
}

function assertVerifiedAssetTransport(assetTransport, finalUploads) {
  if (assetTransport?.status !== "verified" || assetTransport.mode !== "preapproved_stable_https" ||
      !nonEmpty(assetTransport.evidenceRef) || !Array.isArray(assetTransport.approvedHosts) ||
      !Array.isArray(assetTransport.resolvedAssets) || assetTransport.resolvedAssets.length !== finalUploads.length ||
      assetTransport.resolvedAssets.some((asset, index) => asset.assetId !== finalUploads[index].assetId) ||
      resolveFinalUploads({ finalUploads, adapterCapabilities: { status: "ready", assetTransport } }).status !== "ready") {
    throw new Error("OSS_D_RECEIPT_INVALID: OSS素材回执与正式素材清单不一致");
  }
}

function assertSoftwareJobReference(candidate, softwareJobRef) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const savedJobRequired = sku?.dHandoff?.schemaVersion === "c2-d-handoff-v2";
  if (!savedJobRequired) {
    if (softwareJobRef !== null) throw new Error("OSS_D_SAVED_HANDOFF_REQUIRED");
    return false;
  }
  const fields = ["jobId", "revision", "workerId", "leaseId"];
  if (!softwareJobRef || typeof softwareJobRef !== "object" || Array.isArray(softwareJobRef) ||
      Object.keys(softwareJobRef).length !== fields.length || fields.some(field => !Object.hasOwn(softwareJobRef, field)) ||
      ![softwareJobRef.jobId, softwareJobRef.workerId, softwareJobRef.leaseId].every(isCanonicalFrozenRef) ||
      !Number.isSafeInteger(softwareJobRef.revision) || softwareJobRef.revision < 0 ||
      sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2" || sku.dHandoff.softwareJobCreated !== true ||
      softwareJobRef.revision !== sku.dHandoff.softwareJobRef?.resultRevision ||
      dProductionJobRound(sku.dHandoff.softwareJobRef.jobId, fingerprintProductionAuthorization(sku.productionAuthorization)) !== 1 ||
      dProductionJobRound(softwareJobRef.jobId, fingerprintProductionAuthorization(sku.productionAuthorization)) === null) {
    throw new Error("OSS_D_SOFTWARE_JOB_REFERENCE_REQUIRED");
  }
  return true;
}

/**
 * 生成必须先持久化的单次OSS素材传输意图。本函数不读取钥匙串、不上传文件。
 */
export function createPersistableAliyunOssAssetIntent({
  candidate,
  expectedDataRevision,
  ownerDecision,
  softwareJobRef = null,
  startedAt
}) {
  if (!candidate || !nonEmpty(candidate.id)) throw new Error("OSS_D_CANDIDATE_MISSING: 缺少候选");
  if (!Number.isInteger(expectedDataRevision) || Number(candidate.dataRevision) !== expectedDataRevision) {
    throw new Error("OSS_D_REVISION_CONFLICT: 商品资料已变化");
  }
  if (!isoDate(startedAt)) throw new Error("OSS_D_TIME_INVALID: 启动时间无效");
  const skuPackage = currentSku(candidate);
  const authorization = skuPackage.productionAuthorization;
  const savedJob = assertSoftwareJobReference(candidate, softwareJobRef);
  const plan = createProductionPlan({ productionAuthorization: authorization, candidateId: candidate.id, candidateRevision: expectedDataRevision, skuPackage, createdAt: startedAt });
  const inputs = projectProductionPlanInputs(plan);
  if (inputs.platform !== "ozon") throw new Error("OSS_D_PLATFORM_UNSUPPORTED: 当前素材通道只接入Ozon D阶段");
  if (savedJob && ownerDecision !== undefined) throw new Error("OSS_D_SECOND_OWNER_DECISION_REJECTED");
  if (!savedJob && (!ownerDecision || ownerDecision.confirmed !== true || ownerDecision.confirmedBy !== "owner")) {
    throw new Error("OSS_D_OWNER_CONFIRMATION_REQUIRED: 缺少主人本轮精确素材传输确认");
  }
  if (!savedJob && (ownerDecision.authorizationId !== authorization.authorizationId || ownerDecision.skuPackageId !== skuPackage.skuPackageId)) {
    throw new Error("OSS_D_SCOPE_MISMATCH: 授权或SKU不一致");
  }
  const expectedAssetIds = inputs.finalUploads.map((asset) => asset.assetId);
  if (!savedJob && JSON.stringify(ownerDecision.finalUploadAssetIds) !== JSON.stringify(expectedAssetIds)) {
    throw new Error("OSS_D_SCOPE_MISMATCH: 最终素材集合或顺序不一致");
  }
  const intentCore = {
    candidateId: candidate.id,
    candidateDataRevision: expectedDataRevision,
    skuPackageId: skuPackage.skuPackageId,
    authorizationId: authorization.authorizationId,
    authorizationFingerprint: fingerprintProductionAuthorization(authorization),
    productionPlanId: plan.planId,
    productionPlan: structuredClone(plan),
    assetsFinalUploadsVersion: inputs.assetsFinalUploadsVersion,
    finalUploadAssetIds: expectedAssetIds,
    startedAt
  };
  return freeze({
    schemaVersion: ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION,
    intentId: `oss-asset-intent:${digest(intentCore)}`,
    ...intentCore,
    status: "awaiting_persistence",
    attempt: 1,
    attemptLimit: 1,
    mustPersistBeforeUpload: true,
    persistedAt: null,
    automaticRetry: false,
    retryAllowed: false,
    ossWrites: 0,
    platformWrites: 0
  });
}

export function markAliyunOssAssetIntentPersisted({ intent, persistedAt, persistedCandidateRevision = intent?.candidateDataRevision }) {
  if (!intent || intent.schemaVersion !== ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION || intent.status !== "awaiting_persistence") {
    throw new Error("OSS_D_INTENT_INVALID: 素材传输意图无效");
  }
  if (!isoDate(persistedAt)) throw new Error("OSS_D_TIME_INVALID: 持久化时间无效");
  if (!Number.isInteger(persistedCandidateRevision) || persistedCandidateRevision < intent.candidateDataRevision) {
    throw new Error("OSS_D_REVISION_CONFLICT: 持久化后的候选修订号无效");
  }
  return freeze({ ...structuredClone(intent), status: "in_flight", persistedAt, persistedCandidateRevision });
}

/**
 * 只在意图已经持久化后执行一次OSS上传。任何失败均按结果未知停止，不自动重试。
 */
export async function executeAliyunOssAssetIntent({
  persistedIntent,
  candidate,
  currentProductionBinding,
  upload = uploadAliyunOssFinalAssets,
  resolveLocalAsset,
  serverClock,
  softwareJobRef = null,
  beforePublicWrite: beforeSavedJobPublicWrite = null
}) {
  if (!persistedIntent || persistedIntent.schemaVersion !== ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION ||
      persistedIntent.status !== "in_flight" || !isoDate(persistedIntent.persistedAt)) {
    throw new Error("OSS_D_INTENT_NOT_PERSISTED: OSS写入前必须先持久化单次意图");
  }
  if (typeof serverClock !== "function") throw new Error("OSS_D_SERVER_CLOCK_REQUIRED");
  let lastObservedAt = persistedIntent.persistedAt;
  const clockValue = () => {
    const value = serverClock();
    if (!isoDate(value) || Date.parse(value) < Date.parse(lastObservedAt)) throw new Error("OSS_D_TIME_INVALID: 执行时间无效");
    lastObservedAt = value;
    return value;
  };
  const observedAt = clockValue();
  const skuPackage = currentSku(candidate);
  const authorization = skuPackage.productionAuthorization;
  const savedJob = assertSoftwareJobReference(candidate, softwareJobRef);
  const acceptsPrewriteFailure = savedJob ? isAssetTransportPrewriteFailure : isProductionExecutionPrewriteFailure;
  if (savedJob ? typeof beforeSavedJobPublicWrite !== "function" ||
      !isDeepStrictEqual(skuPackage.dAssetTransport?.softwareJobRef, softwareJobRef) : beforeSavedJobPublicWrite !== null) {
    throw new Error("OSS_D_SOFTWARE_JOB_WRITE_GATE_REQUIRED");
  }
  const plan = persistedIntent.productionPlan;
  assertValidProductionAuthorization(authorization);
  if (!validateProductionPlanAuthorizationBinding(plan, authorization).valid) throw new Error("OSS_D_BINDING_DRIFT: 正式授权已变化");
  const inputs = projectProductionPlanInputs(plan);
  const bindings = [
    [candidate.id, persistedIntent.candidateId],
    [Number(candidate.dataRevision), persistedIntent.persistedCandidateRevision],
    [skuPackage.skuPackageId, persistedIntent.skuPackageId],
    [authorization.authorizationId, persistedIntent.authorizationId],
    [fingerprintProductionAuthorization(authorization), persistedIntent.authorizationFingerprint],
    [plan.planId, persistedIntent.productionPlanId],
    [inputs.assetsFinalUploadsVersion, persistedIntent.assetsFinalUploadsVersion]
  ];
  if (bindings.some(([actual, expected]) => actual !== expected) ||
      JSON.stringify(inputs.finalUploads.map((asset) => asset.assetId)) !== JSON.stringify(persistedIntent.finalUploadAssetIds)) {
    throw new Error("OSS_D_BINDING_DRIFT: 持久化后商品、授权或素材发生变化");
  }
  try {
    if (!savedJob) assertCurrentProductionExecutionBinding({ productionAuthorization: authorization, currentProductionBinding, checkedAt: observedAt });
  } catch (error) {
    const failure = assetTransportPrewriteFailure(error);
    if (!failure || !acceptsPrewriteFailure(failure)) throw error;
    return freeze({ status: "failed",
      intent: { ...structuredClone(persistedIntent), status: "failed", completedAt: observedAt,
        externalRequestState: "not_attempted", failureLayer: failure.layer, failureCode: failure.code, ossWrites: 0 },
      assetTransport: null, retryAllowed: false, automaticRetry: false, platformWrites: 0 });
  }

  let publicWriteAttempts = 0;
  let gateFailure = null;
  let gateError = null;
  let gateFailed = false;
  let uploadReturned = false;
  const beforePublicWrite = async asset => {
    if (gateFailed) throw gateError;
    try {
      const expected = inputs.finalUploads[publicWriteAttempts];
      if (!expected || !asset || Object.keys(asset).length !== 3 ||
          ["assetId", "order", "sha256"].some(field => asset[field] !== expected[field])) throw new Error("OSS_D_WRITE_GATE_SCOPE_INVALID");
      if (savedJob) await beforeSavedJobPublicWrite(asset);
      else assertCurrentProductionExecutionBinding({ productionAuthorization: authorization, currentProductionBinding, checkedAt: clockValue() });
    } catch (error) {
      gateError = error;
      gateFailed = true;
      gateFailure = assetTransportPrewriteFailure(error);
      throw error;
    }
    publicWriteAttempts += 1;
  };
  try {
    const assetTransport = await upload({
      candidateId: candidate.id,
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: candidate.dataRevision,
      finalUploads: inputs.finalUploads,
      resolveLocalAsset,
      beforePublicWrite,
      now: clockValue
    });
    uploadReturned = true;
    if (gateFailed) throw gateError;
    if (publicWriteAttempts !== inputs.finalUploads.length) throw new Error("OSS_D_UPLOAD_GATE_NOT_OBSERVED");
    assertVerifiedAssetTransport(assetTransport, inputs.finalUploads);
    const completedAt = clockValue();
    return freeze({
      status: "verified",
      intent: { ...structuredClone(persistedIntent), status: "completed", completedAt, ossWrites: assetTransport.resolvedAssets.length },
      assetTransport: structuredClone(assetTransport),
      retryAllowed: false,
      automaticRetry: false,
      platformWrites: 0
    });
  } catch (error) {
    if (gateFailed && (!gateFailure || !acceptsPrewriteFailure(gateFailure))) throw gateError;
    if (savedJob && uploadReturned && !gateFailed) throw error;
    if (savedJob && [TypeError, ReferenceError, SyntaxError, RangeError, EvalError, URIError].some(Type => error instanceof Type)) throw error;
    const prewriteFailure = gateFailure || assetTransportPrewriteFailure(error);
    const completedAt = clockValue();
    if (publicWriteAttempts === 0 && prewriteFailure && acceptsPrewriteFailure(prewriteFailure)) {
      return freeze({ status: "failed", intent: { ...structuredClone(persistedIntent), status: "failed", completedAt,
        externalRequestState: "not_attempted", failureLayer: prewriteFailure.layer, failureCode: prewriteFailure.code, ossWrites: 0 },
      assetTransport: null, retryAllowed: false, automaticRetry: false, platformWrites: 0 });
    }
    return freeze({
      status: "unknown_outcome",
      intent: {
        ...structuredClone(persistedIntent),
        status: "unknown_outcome",
        completedAt,
        failureLayer: "aliyun_oss_asset_transport",
        failureCode: /^[A-Z][A-Z0-9_]{1,100}$/.test(String(error?.message).split(":", 1)[0]) ? String(error.message).split(":", 1)[0] : "OSS_D_UPLOAD_FAILED",
        ossWrites: "unknown"
      },
      assetTransport: null,
      retryAllowed: false,
      automaticRetry: false,
      platformWrites: 0
    });
  }
}

/** 保存本次已发生的结果；并发资料变更只阻止后续执行，不丢弃上传回执。 */
export function settleAliyunOssAssetIntent({ candidate, persistedIntent, result, settledAt }) {
  if (!isoDate(settledAt)) throw new Error("OSS_D_TIME_INVALID: 结果保存时间无效");
  const sku = candidate?.lifecycleV11?.skuPackage;
  const state = sku?.dAssetTransport;
  if (!state || state.intent?.intentId !== persistedIntent?.intentId || state.intent.status !== "in_flight" ||
      state.executionRevision !== 1 || !isDeepStrictEqual(state.intent, persistedIntent) ||
      candidate.id !== persistedIntent.candidateId || sku.skuPackageId !== persistedIntent.skuPackageId) {
    throw new Error("OSS_D_SETTLEMENT_CONFLICT: 当前执行身份或修订不一致");
  }
  if (!result || Object.keys(result).length !== 6 ||
      ["status", "intent", "assetTransport", "retryAllowed", "automaticRetry", "platformWrites"].some(field => !Object.hasOwn(result, field)) ||
      !["verified", "unknown_outcome", "failed"].includes(result.status) || result.intent?.intentId !== persistedIntent.intentId ||
      !isoDate(result.intent.completedAt) ||
      Date.parse(result.intent.completedAt) < Date.parse(persistedIntent.persistedAt) || Date.parse(settledAt) < Date.parse(result.intent.completedAt) ||
      result.intent.status !== (result.status === "verified" ? "completed" : result.status) ||
      result.retryAllowed !== false || result.automaticRetry !== false || result.platformWrites !== 0) {
    throw new Error("OSS_D_SETTLEMENT_RESULT_INVALID: 上传结果不属于当前执行");
  }
  const expectedIntent = { ...structuredClone(persistedIntent), status: result.intent.status, completedAt: result.intent.completedAt,
    ossWrites: result.status === "verified" ? persistedIntent.finalUploadAssetIds.length : result.status === "failed" ? 0 : "unknown" };
  if (result.status === "verified") {
    assertVerifiedAssetTransport(result.assetTransport, projectProductionPlanInputs(persistedIntent.productionPlan).finalUploads);
  } else if (result.status === "failed") {
    if (result.assetTransport !== null || result.intent.externalRequestState !== "not_attempted" ||
        !isAssetTransportPrewriteFailure({ layer: result.intent.failureLayer, code: result.intent.failureCode })) {
      throw new Error("OSS_D_SETTLEMENT_RESULT_INVALID: 上传前失败必须记录明确原因和零请求");
    }
    expectedIntent.failureLayer = result.intent.failureLayer;
    expectedIntent.failureCode = result.intent.failureCode;
    expectedIntent.externalRequestState = "not_attempted";
  } else {
    if (result.assetTransport !== null || result.intent.failureLayer !== "aliyun_oss_asset_transport" ||
        !/^[A-Z][A-Z0-9_]{1,100}$/.test(result.intent.failureCode)) throw new Error("OSS_D_SETTLEMENT_RESULT_INVALID: 未知结果必须明确缺口");
    expectedIntent.failureLayer = result.intent.failureLayer;
    expectedIntent.failureCode = result.intent.failureCode;
  }
  if (!isDeepStrictEqual(result.intent, expectedIntent)) throw new Error("OSS_D_SETTLEMENT_RESULT_INVALID: 执行意图发生变化");
  const continuationBlocked = candidate.dataRevision !== persistedIntent.persistedCandidateRevision ||
    !validateProductionPlanAuthorizationBinding(persistedIntent.productionPlan, sku.productionAuthorization).valid;
  const next = structuredClone(candidate);
  next.lifecycleV11.skuPackage.dAssetTransport = {
    ...structuredClone(state), status: result.status, executionRevision: 2,
    intent: structuredClone(result.intent), assetTransport: structuredClone(result.assetTransport),
    continuationBlocked, blockReason: continuationBlocked ? "candidate_changed_during_asset_transport" : null,
    settledAt, automaticRetry: false, platformWrites: 0
  };
  return next;
}

export function reconcileAliyunOssAssetIntentAfterRestart({ persistedIntent, restartedAt }) {
  if (!persistedIntent || persistedIntent.schemaVersion !== ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION) {
    throw new Error("OSS_D_INTENT_INVALID: 素材传输意图无效");
  }
  if (!isoDate(restartedAt)) throw new Error("OSS_D_TIME_INVALID: 重启收口时间无效");
  if (persistedIntent.status !== "in_flight") return persistedIntent;
  return freeze({
    ...structuredClone(persistedIntent),
    status: "unknown_outcome",
    completedAt: restartedAt,
    failureLayer: "selection_review_service_restart",
    failureCode: "OSS_D_RESTART_UNKNOWN_OUTCOME",
    ossWrites: "unknown",
    automaticRetry: false,
    retryAllowed: false,
    platformWrites: 0
  });
}
