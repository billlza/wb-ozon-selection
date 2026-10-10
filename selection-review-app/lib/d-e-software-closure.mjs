import { assertDExecutableRequest } from "./d-executable-request-contract.mjs";
export { assertDExecutableRequest, assertHistoricalDExecutableRequest } from "./d-executable-request-contract.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { fingerprintCanonicalRecord as sha256 } from "./production-contract-primitives.mjs";
import {
  assertCurrentProductionAuthorization, PRODUCTION_AUTHORIZATION_VERSION
} from "./production-authorization.mjs";
import {
  assertValidProductionPlan,
  projectProductionPlanInputs,
  projectProductionPlanImportPayload,
  fingerprintProductionAuthorization,
  fingerprintProductionPlan,
  validateProductionPlanAuthorizationBinding
} from "./production-plan.mjs";
import { assertCurrentPlatformWritePreflight, assertCurrentProductionExecutionBinding, assertCurrentDExecutionContext, isStoreIdentityAnchored } from "./platform-write-preflight.mjs";
import { buildOzonSellerImportRequest } from "./ozon-seller-api-production-adapter.mjs";
import { resolveFinalUploads as resolveOzonFinalUploads } from "./ozon-seller-api-de-adapter.mjs";
import { formatDReadbackMismatchReason } from "./production-execution-failure.mjs";
import {
  PRODUCTION_RECORD_VERSION,
  assertValidProductionRecord
} from "./draft-production-execution.mjs";
import { verifySystemCreatedListing, systemCreatedReadbackGaps, projectProductionReadbackExpectation,
  observedMediaSequence, observedWarehouseAvailableStock, validateProductionReadbackExpectation } from "./e-stage-readback.mjs";

export const D_SOFTWARE_EXECUTION_VERSION = "d-software-execution-v2";
export const E_SYSTEM_READBACK_VERSION = "e-system-readback-v1";

const REQUIRED_WRITE_FIELDS = Object.freeze([
  "create_product",
  "title",
  "attributes",
  "price",
  "stock",
  "assets.finalUploads",
  "publish_scope"
]);


function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function gap(code, field, message) {
  return { code, field, message };
}

function validPreflight(plan, inputs, preflight, gaps) {
  if (preflight.sourceProductionPlanId !== plan.planId ||
      preflight.sourceProductionPlanFingerprint !== fingerprintProductionPlan(plan)) {
    gaps.push(gap("preflight_stale", "platformWritePreflight", "前检不属于当前ProductionPlan"));
  }
  // 同 draft 写入口：仓库反推下 observedStoreRef 恒为 null，身份靠 verifiedVia 那条锚成立；其余路径不变。
  if (preflight.targetPlatform !== inputs.platform || preflight.storeIdentity.expectedStore !== inputs.store ||
      preflight.storeIdentity.observedStore !== inputs.store || preflight.storeIdentity.status !== "matched" ||
      !sameStoreRef(preflight.storeIdentity.expectedStoreRef, inputs.storeRef) ||
      !isStoreIdentityAnchored({ via: preflight.storeIdentity.verifiedVia, observedStoreRef: preflight.storeIdentity.observedStoreRef, expectedStoreRef: inputs.storeRef })) {
    gaps.push(gap("store_identity_not_ready", "platformWritePreflight.storeIdentity", "Seller API店铺身份未与授权店铺一致"));
  }
  if (preflight.permission.status !== "verified" || preflight.connectionStatus.api.status !== "connected") {
    gaps.push(gap("seller_api_not_ready", "platformWritePreflight.connectionStatus.api", "Seller API权限或连接未验证"));
  }
  if (preflight.priceCurrency.status !== "matched" || preflight.priceCurrency.expected !== "CNY") {
    gaps.push(gap("price_currency_not_ready", "platformWritePreflight.priceCurrency", "Ozon中国卖家写入币种必须验证为CNY"));
  }
  const missing = REQUIRED_WRITE_FIELDS.filter((field) => !preflight.effectiveWritableFields.includes(field));
  if (missing.length > 0) gaps.push(gap("write_fields_not_ready", "platformWritePreflight.effectiveWritableFields", `平台当前不可写：${missing.join(",")}`));
}

function resolveAssets(plan, capabilities, gaps) {
  const resolution = resolveOzonFinalUploads({ finalUploads: plan.finalUploads, adapterCapabilities: capabilities });
  if (resolution.status !== "ready") gaps.push(...resolution.gaps);
  return resolution.resolvedAssets;
}

function validateCapabilities(plan, capabilities, gaps) {
  if (!isObject(capabilities) || capabilities.platform !== "ozon" || capabilities.store !== plan.store ||
      !sameStoreRef(capabilities.storeRef, plan.storeRef) || capabilities.warehouseRef !== plan.warehouseRef || capabilities.credentialAlias !== plan.credentialAlias ||
      !nonEmpty(capabilities.adapterVersion) || !nonEmpty(capabilities.evidenceRef)) {
    gaps.push(gap("adapter_capabilities_missing", "adapterCapabilities", "缺少当前Ozon店铺Seller API能力证据"));
    return;
  }
  if (capabilities.productImport?.status !== "verified" || !nonEmpty(capabilities.productImport.evidenceRef)) {
    gaps.push(gap("product_import_protocol_not_ready", "adapterCapabilities.productImport", "商品导入协议未验证"));
  }
  if (capabilities.assetTransport?.status !== "verified" || !nonEmpty(capabilities.assetTransport.evidenceRef)) {
    gaps.push(gap("asset_transport_protocol_not_ready", "adapterCapabilities.assetTransport", "最终素材URL或上传能力未经Ozon当前协议验证"));
  }
  const inventory = capabilities.inventoryWrite;
  if (!isObject(inventory) || inventory.status !== "verified" || !nonEmpty(inventory.endpoint) ||
      !nonEmpty(inventory.warehouseId) || !sameStoreRef(inventory.storeRef, plan.storeRef) || inventory.warehouseRef !== plan.warehouseRef || inventory.credentialAlias !== plan.credentialAlias || !nonEmpty(inventory.protocolVersion) || !nonEmpty(inventory.evidenceRef)) {
    gaps.push(gap("inventory_protocol_not_ready", "adapterCapabilities.inventoryWrite", "库存100所需接口、仓库和协议证据未锁定"));
  }
  if (capabilities.independentReadback?.status !== "verified" || !nonEmpty(capabilities.independentReadback.evidenceRef)) {
    gaps.push(gap("readback_protocol_not_ready", "adapterCapabilities.independentReadback", "Seller API独立回读协议未验证"));
  }
}

export function prepareSingleSkuDExecution({
  productionPlan,
  productionAuthorization,
  platformWritePreflight,
  adapterCapabilities,
  currentProductionBinding,
  preparedAt
}) {
  assertValidProductionPlan(productionPlan);
  assertCurrentProductionAuthorization(productionAuthorization, { observedAt: preparedAt });
  assertCurrentPlatformWritePreflight(platformWritePreflight);
  if (!isoDateTime(preparedAt)) throw new Error("D_SOFTWARE_INPUT_INVALID: 准备时间无效");
  const binding = validateProductionPlanAuthorizationBinding(productionPlan, productionAuthorization);
  if (!binding.valid) throw new Error("D_SOFTWARE_AUTHORIZATION_DRIFT: ProductionPlan与主人授权不一致");
  const executionBinding = assertCurrentProductionExecutionBinding({ productionAuthorization, currentProductionBinding, checkedAt: preparedAt });

  const inputs = projectProductionPlanInputs(productionPlan);
  const authorizationFingerprint = fingerprintProductionAuthorization(productionAuthorization);
  const gaps = [];
  if (inputs.platform !== "ozon" || inputs.executionStrategy?.primaryPath !== "seller_api") {
    gaps.push(gap("unsupported_platform_path", "platform", "首期D软件执行只支持Ozon Seller API"));
  }
  if (inputs.publishScope !== "create_and_allow_validation_moderation") {
    gaps.push(gap("seller_api_publish_scope_not_ready", "publishScope", "当前Ozon Seller API导入路径只支持创建并进入校验/审核"));
  }
  if (inputs.stock !== 100) gaps.push(gap("stock_not_locked", "stock", "新品库存必须由授权快照锁定为100"));
  const missingFields = REQUIRED_WRITE_FIELDS.filter((field) => !inputs.allowedWriteFields.includes(field));
  if (missingFields.length > 0) gaps.push(gap("authorization_write_scope_incomplete", "allowedWriteFields", `主人授权未覆盖：${missingFields.join(",")}`));
  validPreflight(productionPlan, inputs, platformWritePreflight, gaps);
  validateCapabilities(inputs, adapterCapabilities, gaps);
  if (adapterCapabilities?.inventoryWrite?.warehouseId !== executionBinding.warehouseId) {
    gaps.push(gap("authorized_warehouse_mismatch", "adapterCapabilities.inventoryWrite.warehouseId", "库存接口仓库不属于主人冻结的生产配置"));
  }
  const assets = resolveAssets(inputs, adapterCapabilities, gaps);

  const common = {
    schemaVersion: D_SOFTWARE_EXECUTION_VERSION,
    preparedAt,
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    sourceAuthorizationId: productionAuthorization.authorizationId,
    sourceAuthorizationFingerprint: authorizationFingerprint,
    platform: inputs.platform,
    store: inputs.store,
    storeRef: structuredClone(inputs.storeRef), warehouseRef: inputs.warehouseRef, credentialAlias: inputs.credentialAlias,
    skuPackageId: inputs.skuPackageId,
    merchantSku: inputs.sku.merchantSku,
    supplierSkuId: inputs.sku.supplierSkuId,
    assetsFinalUploadsVersion: inputs.assetsFinalUploadsVersion,
    publishScope: inputs.publishScope,
    exclusions: structuredClone(inputs.exclusions),
    allowedWriteFields: structuredClone(inputs.allowedWriteFields),
    gaps,
    executionPolicy: {
      path: "ozon_seller_api",
      batchSize: 1,
      attemptLimit: 1,
      automaticRetry: false,
      browserFallback: false,
      manualFallback: false,
      codexDispatch: false,
      nextSkuAutomaticStart: false
    }
  };
  if (gaps.length > 0) return deepFreeze({ ...common, status: "not_ready", executableRequest: null });

  let importRequest;
  try {
    importRequest = buildOzonSellerImportRequest(projectProductionPlanImportPayload({ productionPlan, resolvedFinalUploads: assets }));
  } catch (error) {
    return deepFreeze({
      ...common,
      status: "not_ready",
      gaps: [gap("ozon_import_payload_not_ready", "executableRequest.productImport", error.message)],
      executableRequest: null
    });
  }
  const requestCore = {
    executionProtocolVersion: "ozon-single-sku-d-e-v3",
    candidateId: inputs.candidateId,
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: common.sourceProductionPlanFingerprint,
    sourceAuthorizationId: productionAuthorization.authorizationId,
    sourceAuthorizationFingerprint: authorizationFingerprint,
    platform: "ozon",
    sourceAuthorizationVersion: productionAuthorization.schemaVersion,
    store: inputs.store,
    storeRef: structuredClone(inputs.storeRef), warehouseRef: inputs.warehouseRef, credentialAlias: inputs.credentialAlias,
    skuPackageId: inputs.skuPackageId,
    merchantSku: inputs.sku.merchantSku,
    supplierSkuId: inputs.sku.supplierSkuId,
    platformWritePrice: structuredClone(inputs.platformWritePrice),
    stock: 100,
    assetsFinalUploadsVersion: inputs.assetsFinalUploadsVersion,
    finalUploads: assets,
    publishScope: inputs.publishScope,
    exclusions: structuredClone(inputs.exclusions),
    allowedWriteFields: [...REQUIRED_WRITE_FIELDS],
    productImport: importRequest,
    inventoryWrite: {
      endpoint: adapterCapabilities.inventoryWrite.endpoint,
      warehouseId: adapterCapabilities.inventoryWrite.warehouseId,
      protocolVersion: adapterCapabilities.inventoryWrite.protocolVersion,
      evidenceRef: adapterCapabilities.inventoryWrite.evidenceRef,
      stock: 100
    },
    independentReadback: {
      evidenceRef: adapterCapabilities.independentReadback.evidenceRef,
      expectedPrice: structuredClone(inputs.platformWritePrice),
      expectedStock: 100,
      expectedImageCount: assets.length,
      expectation: projectProductionReadbackExpectation({ finalUploads: assets, warehouseId: adapterCapabilities.inventoryWrite.warehouseId })
    },
    protocolEvidence: {
      adapter: adapterCapabilities.evidenceRef,
      productImport: adapterCapabilities.productImport.evidenceRef,
      assetTransport: adapterCapabilities.assetTransport.evidenceRef,
      inventoryWrite: adapterCapabilities.inventoryWrite.evidenceRef,
      independentReadback: adapterCapabilities.independentReadback.evidenceRef
    }
  };
  const executionKey = `d-execution:${sha256({
    sourceAuthorizationFingerprint: authorizationFingerprint,
    sourceProductionPlanFingerprint: common.sourceProductionPlanFingerprint,
    requestCore
  })}`;
  return deepFreeze({
    ...common,
    status: "ready",
    gaps: [],
    executableRequest: { ...requestCore, executionKey, idempotencyKey: executionKey }
  });
}

export function beginDSoftwareExecution({ preparedExecution, startedAt }) {
  if (!isObject(preparedExecution) || preparedExecution.schemaVersion !== D_SOFTWARE_EXECUTION_VERSION ||
      preparedExecution.status !== "ready" || !isObject(preparedExecution.executableRequest)) {
    throw new Error("D_SOFTWARE_NOT_READY: 只有ready请求可以开始执行");
  }
  if (!isoDateTime(startedAt)) throw new Error("D_SOFTWARE_INPUT_INVALID: 开始时间无效");
  const request = assertDExecutableRequest(preparedExecution.executableRequest);
  return deepFreeze({
    schemaVersion: D_SOFTWARE_EXECUTION_VERSION,
    attemptId: `d-attempt:${sha256({ executionKey: request.executionKey })}`,
    executionKey: request.executionKey,
    status: "in_flight",
    startedAt,
    request: structuredClone(request),
    persistBeforeWrite: true,
    attemptNumber: 1,
    retryAllowed: false,
    productionRecord: null
  });
}

export function markDSoftwareUnknownOutcome({ executionAttempt, reason, markedAt }) {
  if (!isObject(executionAttempt) || executionAttempt.status !== "in_flight" || !nonEmpty(reason) || !isoDateTime(markedAt)) {
    throw new Error("D_SOFTWARE_UNKNOWN_OUTCOME_INVALID: 只能把已持久化的in_flight执行标记为unknown_outcome");
  }
  return deepFreeze({
    ...structuredClone(executionAttempt),
    status: "unknown_outcome",
    markedAt,
    reason,
    retryAllowed: false,
    productionRecord: null
  });
}

function readbackMatches(request, observation) {
  const errors = [];
  if (!isObject(observation)) return ["observation"];
  for (const [field, expected] of [
    ["platform", request.platform],
    ["store", request.store],
    ["skuPackageId", request.skuPackageId],
    ["merchantSku", request.merchantSku],
    ["supplierSkuId", request.supplierSkuId]
  ]) if (String(observation[field] || "") !== String(expected)) errors.push(field);
  if (!sameStoreRef(observation.storeRef, request.storeRef) || observation.warehouseRef !== request.warehouseRef || observation.credentialAlias !== request.credentialAlias) errors.push("executionBinding");
  if (!nonEmpty(String(observation.platformProductId || ""))) errors.push("platformProductId");
  if (!isObject(observation.currentPrice) || observation.currentPrice.amount !== request.platformWritePrice.amount ||
      observation.currentPrice.currency !== request.platformWritePrice.currency) errors.push("currentPrice");
  if (observation.currentStock !== 100) errors.push("currentStock");
  if (observation.imageCount !== request.finalUploads.length) errors.push("imageCount");
  // D proves the authorized creation and stock write. CDN identity, image order and sale eligibility
  // remain E acceptance checks; keep the original observed media and statuses in immediateReadback.
  const media = observedMediaSequence(observation.mediaObservation);
  if (media === null) errors.push("media_identity_unverified");
  else {
    if (new Set(media).size !== media.length) errors.push("media_duplicate");
    if (media.length !== request.finalUploads.length || observation.imageCount !== media.length) errors.push("imageCount");
  }
  const stock = observedWarehouseAvailableStock(observation.inventoryObservation, request.inventoryWrite.warehouseId,
    { productId: observation.platformProductId, offerId: observation.merchantSku });
  if (stock === "unknown") errors.push("warehouse_identity_or_quantity_unverified");
  else if (stock !== observation.currentStock) errors.push("warehouse_stock_mismatch");
  if (![observation.moderationStatus, observation.validationStatus, observation.saleStatus].every(nonEmpty)) errors.push("platformStatus");
  if (!Array.isArray(observation.errors) || observation.errors.length !== 0 || !nonEmpty(observation.platformEvidenceRef)) errors.push("platformEvidence");
  return errors;
}

export async function executeDSoftwareAttempt({ executionAttempt, executionContext, executeSellerApi, readbackSellerApi, persistCheckpoint, completedAt: suppliedCompletedAt, completionClock = null }) {
  if (!isObject(executionAttempt) || executionAttempt.schemaVersion !== D_SOFTWARE_EXECUTION_VERSION || executionAttempt.status !== "in_flight") {
    throw new Error("D_SOFTWARE_ATTEMPT_STATE_REJECTED: 只能执行一次in_flight状态；成功、失败或未知结果均禁止重复写入");
  }
  if (typeof executeSellerApi !== "function" || typeof readbackSellerApi !== "function" ||
      (completionClock === null ? !isoDateTime(suppliedCompletedAt) : typeof completionClock !== "function")) {
    throw new Error("D_SOFTWARE_EXECUTOR_INVALID: 缺少受控Seller API执行器、独立回读器或时间");
  }
  const completionTime = () => {
    const value = completionClock === null ? suppliedCompletedAt : completionClock();
    if (!isoDateTime(value) || Date.parse(value) < Date.parse(executionAttempt.startedAt)) throw new Error("D_SOFTWARE_COMPLETION_TIME_INVALID");
    return value;
  };
  const request = assertDExecutableRequest(executionAttempt.request);
  assertCurrentDExecutionContext({ request, executionContext });
  let platformResult;
  let completedAt;
  try {
    platformResult = await executeSellerApi(deepFreeze(structuredClone(request)), { persistCheckpoint });
  } catch (error) {
    if (error.code?.startsWith("D_CHECKPOINT_") || error.code === "D_EXECUTION_CONTINUATION_BLOCKED") throw error;
    completedAt = completionTime();
    return markDSoftwareUnknownOutcome({ executionAttempt, reason: "seller_api_transport_failed", markedAt: completedAt });
  }
  completedAt = completionTime();
  if (platformResult?.status === "rejected_before_write" && platformResult.writeOccurred === false) {
    return deepFreeze({
      ...structuredClone(executionAttempt),
      status: "failed",
      completedAt,
      failure: { layer: "seller_api", code: platformResult.code || "rejected_before_write", message: platformResult.message || "平台写前拒绝" },
      retryAllowed: false,
      productionRecord: null
    });
  }
  if (platformResult?.status === "waiting_platform") {
    if (Object.keys(platformResult).sort().join() !== ["status","taskId","productId","offerId","requestReceiptRef","inventoryWriteState","retryAllowed"].sort().join() ||
        !/^[1-9][0-9]*$/.test(platformResult.taskId) || !Number.isSafeInteger(Number(platformResult.taskId)) ||
        platformResult.productId !== null || platformResult.offerId !== request.merchantSku || !nonEmpty(platformResult.requestReceiptRef) ||
        platformResult.inventoryWriteState !== "not_sent" || platformResult.retryAllowed !== false) {
      throw new Error("D_PLATFORM_ACCEPTANCE_INVALID");
    }
    return deepFreeze({ ...structuredClone(executionAttempt), status: "waiting_platform", completedAt: null,
      platformResult: structuredClone(platformResult), productionRecord: null,
      platformContinuation: { schemaVersion: "d-platform-continuation-v1", status: "waiting_import", taskId: platformResult.taskId,
        requestReceiptRef: platformResult.requestReceiptRef, productId: null, inventoryWriteState: "not_sent",
        observationHistory: [], policy: null, queryCount: 0, activeObservationJobId: null } });
  }
  if (!isObject(platformResult) || platformResult.status !== "accepted" || !nonEmpty(String(platformResult.productId || "")) ||
      !nonEmpty(String(platformResult.offerId || "")) || !nonEmpty(platformResult.requestReceiptRef) ||
      !nonEmpty(platformResult.inventoryReceiptRef) || String(platformResult.offerId) !== request.merchantSku) {
    return deepFreeze({ ...markDSoftwareUnknownOutcome({ executionAttempt, reason: "seller_api_response_identity_or_receipt_missing", markedAt: completedAt }),
      platformResult: isObject(platformResult) ? structuredClone(platformResult) : null });
  }

  let observation;
  try {
    observation = await readbackSellerApi(deepFreeze({
      mode: "independent_read_only",
      platform: request.platform,
      store: request.store,
      skuPackageId: request.skuPackageId,
      storeRef: structuredClone(request.storeRef), warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias,
      warehouseId: request.inventoryWrite.warehouseId,
      platformProductId: String(platformResult.productId),
      merchantSku: request.merchantSku,
      supplierSkuId: request.supplierSkuId,
      writeAllowed: false
    }));
  } catch (error) {
    completedAt = completionTime();
    return deepFreeze({ ...markDSoftwareUnknownOutcome({ executionAttempt, reason: "independent_readback_failed", markedAt: completedAt }),
      platformResult: structuredClone(platformResult) });
  }
  if (typeof persistCheckpoint === "function") await persistCheckpoint({ kind: "independent_readback_observed", observation: structuredClone(observation) });
  completedAt = completionTime();
  const mismatches = readbackMatches(request, observation);
  if (String(observation?.platformProductId || "") !== String(platformResult.productId)) mismatches.push("platformProductId");
  if (mismatches.length > 0) {
    return deepFreeze({ ...markDSoftwareUnknownOutcome({ executionAttempt, reason: formatDReadbackMismatchReason(mismatches), markedAt: completedAt }),
      platformResult: structuredClone(platformResult), immediateReadback: structuredClone(observation) });
  }

  const record = {
    schemaVersion: PRODUCTION_RECORD_VERSION,
    productionRecordId: `production-record:${request.skuPackageId}:${sha256({ executionKey: request.executionKey, platformResult }).slice(0, 16)}`,
    executionMode: "single_sku_seller_api",
    executionKey: request.executionKey,
    sourceProductionPlanId: request.sourceProductionPlanId,
    sourceProductionPlanFingerprint: request.sourceProductionPlanFingerprint,
    sourceAuthorizationId: request.sourceAuthorizationId,
    sourceAuthorizationFingerprint: request.sourceAuthorizationFingerprint,
    platform: request.platform,
    store: request.store,
    storeRef: structuredClone(request.storeRef), warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias,
    skuPackageId: request.skuPackageId,
    supplierSkuId: request.supplierSkuId,
    merchantSku: request.merchantSku,
    platformProductId: String(platformResult.productId),
    platformOfferId: String(platformResult.offerId),
    status: "validation_or_moderation",
    writtenFields: [...REQUIRED_WRITE_FIELDS],
    platformEvidenceRef: observation.platformEvidenceRef,
    platformWriteEvidenceRef: platformResult.requestReceiptRef,
    platformReadbackEvidenceRef: observation.platformEvidenceRef,
    requestReceiptRef: platformResult.requestReceiptRef,
    inventoryReceiptRef: platformResult.inventoryReceiptRef,
    createdAt: completedAt,
    businessStateEffect: "D_created_entered_validation_moderation",
    batchSize: 1,
    // These fields record operations performed by this attempt; current sale status is independent readback evidence.
    published: false,
    activated: false,
    advertisingOpened: false,
    inventoryModified: true,
    stockWritten: 100,
    imagesUploaded: request.finalUploads.length,
    finalUploadAssetIds: request.finalUploads.map((asset) => asset.assetId),
    mainImageAssetId: request.finalUploads[0].assetId,
    expectedPrice: structuredClone(request.platformWritePrice),
    expectedStock: 100,
    expectedImageCount: request.finalUploads.length,
    readbackExpectation: structuredClone(request.independentReadback.expectation),
    independentReadbackVerified: true
  };
  assertValidProductionRecord(record);
  return deepFreeze({
    ...structuredClone(executionAttempt),
    status: "succeeded",
    completedAt,
    retryAllowed: false,
    platformResult: structuredClone(platformResult),
    immediateReadback: structuredClone(observation),
    productionRecord: record
  });
}

export async function runSystemCreatedEReadback({ productionRecord, readPlatform, verifiedAt, completionClock = null }) {
  assertValidProductionRecord(productionRecord);
  if (productionRecord.executionMode !== "single_sku_seller_api") throw new Error("E_SYSTEM_PATH_REQUIRED: 软件E回读只接受Seller API ProductionRecord");
  if (completionClock !== null && typeof completionClock !== "function") throw new Error("E_SYSTEM_READBACK_TIME_INVALID");
  const startedAt = completionClock === null ? verifiedAt : completionClock();
  if (!isoDateTime(startedAt)) throw new Error("E_SYSTEM_READBACK_TIME_INVALID");
  const completionTime = () => {
    const value = completionClock === null ? verifiedAt : completionClock();
    if (!isoDateTime(value) || Date.parse(value) < Date.parse(startedAt)) throw new Error("E_SYSTEM_READBACK_TIME_INVALID");
    return value;
  };
  if (!validateProductionReadbackExpectation(productionRecord.readbackExpectation)) return deepFreeze({
    schemaVersion: E_SYSTEM_READBACK_VERSION, status: "not_verified", outcome: null, verifiedAt: startedAt,
    sourceProductionRecordId: productionRecord.productionRecordId, gaps: ["readback_expectation_missing_or_invalid"],
    observation: {}, eVerificationRecord: null, automaticRetry: false, platformWrites: 0
  });
  if (typeof readPlatform !== "function") throw new Error("E_SYSTEM_READBACK_INPUT_INVALID: 缺少只读回读器或时间");
  let observation;
  try {
    observation = await readPlatform(deepFreeze({
      mode: "independent_read_only",
      sourceRecordType: "ProductionRecord",
      platform: productionRecord.platform,
      store: productionRecord.store,
      storeRef: structuredClone(productionRecord.storeRef), warehouseRef: productionRecord.warehouseRef, credentialAlias: productionRecord.credentialAlias,
      warehouseId: productionRecord.readbackExpectation.warehouseId,
      skuPackageId: productionRecord.skuPackageId,
      platformProductId: productionRecord.platformProductId,
      merchantSku: productionRecord.merchantSku,
      supplierSkuId: productionRecord.supplierSkuId,
      writeAllowed: false
    }));
  } catch {
    verifiedAt = completionTime();
    return deepFreeze({
      schemaVersion: E_SYSTEM_READBACK_VERSION,
      status: "not_verified",
      outcome: null,
      verifiedAt,
      sourceProductionRecordId: productionRecord.productionRecordId,
      gaps: ["technical_readback_failure:platform_read_failed"],
      observation: {},
      eVerificationRecord: null,
      automaticRetry: false,
      platformWrites: 0
    });
  }
  verifiedAt = completionTime();
  const mismatches = systemCreatedReadbackGaps(productionRecord, observation);
  if (mismatches.length > 0) return deepFreeze({
    schemaVersion: E_SYSTEM_READBACK_VERSION,
    status: "not_verified",
    outcome: null,
    verifiedAt,
    sourceProductionRecordId: productionRecord.productionRecordId,
    gaps: [...new Set(mismatches)],
    observation: structuredClone(observation),
    eVerificationRecord: null,
    automaticRetry: false,
    platformWrites: 0
  });
  const verification = verifySystemCreatedListing({
    productionRecord,
    verifiedObservation: observation,
    verifiedAt,
    ownerPriceDecision: {
      decision: "authorized_platform_write_price",
      confirmedBy: "owner",
      authorizationId: productionRecord.sourceAuthorizationId,
      price: structuredClone(productionRecord.expectedPrice)
    }
  });
  return deepFreeze({
    schemaVersion: E_SYSTEM_READBACK_VERSION,
    status: "verified",
    outcome: "listed_verified",
    verifiedAt,
    sourceProductionRecordId: productionRecord.productionRecordId,
    gaps: [],
    observation: structuredClone(observation),
    eVerificationRecord: verification,
    automaticRetry: false,
    platformWrites: 0
  });
}
