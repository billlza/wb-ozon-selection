export { PRODUCTION_EXECUTION_BINDING_FAILURE_CODES, productionExecutionPrewriteFailure, isProductionExecutionPrewriteFailure } from "./production-execution-failure.mjs";
import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { createHash } from "node:crypto";
import { assertValidProductionPlan, fingerprintProductionPlan, fingerprintProductionAuthorization, projectProductionPlanInputs, projectProductionPlanImportPayload } from "./production-plan.mjs";
import { isDeepStrictEqual } from "node:util";
import { buildOzonSellerImportRequest } from "./ozon-seller-api-production-adapter.mjs";
import { assertCurrentProductionAuthorization } from "./production-authorization.mjs";
import { isRuntimeConfigurationTimestamp, normalizeProductionBindings } from "./runtime-configuration.mjs";
import { ozonProductionConnectionRequirements } from "./ozon-production-strategy.mjs";

import { PLATFORM_WRITE_PREFLIGHT_VERSION, STORE_IDENTITY_PATHS, assertValidPlatformWritePreflight, canStoreIdentityPathAnchor, isStoreIdentityAnchored, platformWritePreflightTechnicalStatus } from "./platform-write-preflight-contract.mjs";
export { PLATFORM_WRITE_PREFLIGHT_VERSION, validatePlatformWritePreflight, assertValidPlatformWritePreflight, assertCurrentPlatformWritePreflight, isStoreIdentityAnchored } from "./platform-write-preflight-contract.mjs";
/** Checks the current non-secret configuration against the owner's frozen execution scope. */
export function assertCurrentProductionExecutionBinding({ productionAuthorization, currentProductionBinding, checkedAt }) {
  if (!isRuntimeConfigurationTimestamp(checkedAt)) throw new Error("PRODUCTION_EXECUTION_BINDING_TIME_INVALID: 执行前检时间无效");
  assertCurrentProductionAuthorization(productionAuthorization, { observedAt: checkedAt });
  if (!currentProductionBinding) throw new Error("PRODUCTION_EXECUTION_BINDING_REQUIRED: 缺少当前服务端生产配置");
  if (Date.parse(checkedAt) < Date.parse(productionAuthorization.authorizedAt)) {
    throw new Error("PRODUCTION_EXECUTION_BINDING_TIME_INVALID: 执行前检时间无效");
  }
  const scope = productionAuthorization.lockedScope;
  // The expected store is taken from the authorization, never inferred from the configuration being checked.
  const [binding] = normalizeProductionBindings([currentProductionBinding], [{
    targetStore: scope.storeRef.stableStoreId, platform: scope.platform, storeRef: scope.storeRef
  }]);
  const expected = productionAuthorization.executionBinding;
  if (["bindingId", "configurationVersion", "warehouseId"].some(field => binding[field] !== expected[field]) ||
      binding.platform !== scope.platform || !sameStoreRef(binding.storeRef, scope.storeRef) ||
      binding.warehouseRef !== scope.warehouseRef || binding.credentialAlias !== scope.credentialAlias) {
    throw new Error("PRODUCTION_EXECUTION_BINDING_DRIFT: 当前生产配置已变化，须重新取得主人确认");
  }
  const now = Date.parse(checkedAt);
  if (now < Date.parse(binding.verification.checkedAt) || now >= Date.parse(binding.verification.expiresAt)) {
    throw new Error("PRODUCTION_EXECUTION_BINDING_UNVERIFIED: 当前店铺仓库配置核验不在有效期内");
  }
  return binding;
}

/** Only service-owned execution context can connect a request to the saved authorization. */
export function assertCurrentDExecutionContext({ request, executionContext }) {
  if (!executionContext || Object.keys(executionContext).length !== 3 ||
      !["productionPlan", "currentProductionBinding", "serverClock"].every(field => Object.hasOwn(executionContext, field)) ||
      typeof executionContext.serverClock !== "function") throw new Error("D_EXECUTION_CONTEXT_REQUIRED");
  const { productionPlan, currentProductionBinding, serverClock } = executionContext;
  assertValidProductionPlan(productionPlan);
  const binding = assertCurrentProductionExecutionBinding({ productionAuthorization: productionPlan.sourceAuthorization,
    currentProductionBinding, checkedAt: serverClock() });
  const inputs = projectProductionPlanInputs(productionPlan);
  const authorization = productionPlan.sourceAuthorization;
  const expected = {
    candidateId: inputs.candidateId, sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    sourceAuthorizationId: authorization.authorizationId, sourceAuthorizationVersion: authorization.schemaVersion,
    sourceAuthorizationFingerprint: fingerprintProductionAuthorization(authorization), platform: inputs.platform,
    store: inputs.store, storeRef: inputs.storeRef, warehouseRef: inputs.warehouseRef, credentialAlias: inputs.credentialAlias,
    skuPackageId: inputs.skuPackageId, supplierSkuId: inputs.sku.supplierSkuId, merchantSku: inputs.sku.merchantSku,
    platformWritePrice: inputs.platformWritePrice, stock: inputs.stock, assetsFinalUploadsVersion: inputs.assetsFinalUploadsVersion,
    publishScope: inputs.publishScope, exclusions: inputs.exclusions
  };
  if (!request || Object.entries(expected).some(([field, value]) => !isDeepStrictEqual(request[field], value)) ||
      request.inventoryWrite?.warehouseId !== binding.warehouseId || request.inventoryWrite.stock !== inputs.stock ||
      !Array.isArray(request.allowedWriteFields) || request.allowedWriteFields.some(field => !inputs.allowedWriteFields.includes(field))) {
    throw new Error("D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH");
  }
  const importRequest = buildOzonSellerImportRequest(projectProductionPlanImportPayload({ productionPlan, resolvedFinalUploads: request.finalUploads }));
  if (!isDeepStrictEqual(request.productImport, importRequest)) throw new Error("D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH: 导入字段不属于冻结计划");
  return binding;
}

const PERMISSION_STATUSES = new Set(["verified", "denied", "permission_required", "unknown"]);
const CONNECTION_STATUSES = new Set(["connected", "unavailable", "system_error", "permission_required", "unknown"]);
const IMAGE_PERMISSION_STATUSES = new Set(["verified", "denied", "permission_required", "unknown"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

/** An inspection that names no path is read under the original rule: identity comes from an observed store ref. */
function storeIdentityVia(inspection) {
  return inspection.storeIdentityVia ?? "platform_store_id";
}

function validateInspection(inspection) {
  if (!isObject(inspection)) throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 检查器必须返回结构化结果");
  if (!nonEmptyString(inspection.observedStore) || !["matched", "mismatched", "unverified"].includes(inspection.storeIdentityStatus) || !nonEmptyString(inspection.storeIdentityEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 店铺身份检查结果不完整");
  }
  if (!Object.hasOwn(inspection, "observedStoreRef") || !(inspection.observedStoreRef === null || isCompleteStoreRef(inspection.observedStoreRef, inspection.observedStore))) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 必须返回完整观察店铺身份或明确未验证");
  }
  // 'scoped_warehouse' asserts the platform publishes no store number, so a store ref alongside it is a contradiction.
  if (!STORE_IDENTITY_PATHS.has(storeIdentityVia(inspection)) ||
      (storeIdentityVia(inspection) === "scoped_warehouse" && inspection.observedStoreRef !== null)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 店铺身份证据路径无效");
  }
  if (!PERMISSION_STATUSES.has(inspection.permissionStatus) || !nonEmptyString(inspection.permissionEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 权限检查结果不完整");
  }
  for (const name of ["api", "sellerBackend"]) {
    const value = inspection.connections?.[name];
    if (!isObject(value) || !CONNECTION_STATUSES.has(value.status) || !nonEmptyString(value.checkedVia) || !nonEmptyString(value.evidenceRef)) {
      throw new Error(`PLATFORM_PREFLIGHT_INSPECTION_INVALID: ${name}连接检查结果不完整`);
    }
  }
  if (!stringArray(inspection.platformWritableFields)) throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 平台可写字段必须是字符串数组");
  if (!IMAGE_PERMISSION_STATUSES.has(inspection.imagePermissionStatus) || !nonEmptyString(inspection.imagePermissionEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 图片权限检查结果不完整");
  }
  if (!nonEmptyString(inspection.priceFieldCurrency) || !nonEmptyString(inspection.priceCurrencyEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 平台价格字段币种检查不完整");
  }
  if (!Array.isArray(inspection.risks)) throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 风险必须是数组");
}

/**
 * 第13B-1阶段只执行只读平台前检。所有商品字段来自ProductionPlan；检查器只提供当前技术证据。
 */
export async function runPlatformWritePreflight({ productionPlan, inspectPlatform, checkedAt }) {
  assertValidProductionPlan(productionPlan);
  if (typeof inspectPlatform !== "function") throw new Error("PLATFORM_PREFLIGHT_INSPECTOR_REQUIRED: 缺少只读平台检查器");
  if (!isoDateTime(checkedAt)) throw new Error("PLATFORM_PREFLIGHT_INPUT_GAP: 检查时间无效");
  const inputs = projectProductionPlanInputs(productionPlan);
  const connectionRequirements = ozonProductionConnectionRequirements(inputs.executionStrategy.primaryPath);
  const protectedPlan = structuredClone(productionPlan);
  const inspection = await inspectPlatform(deepFreeze({
    mode: "read_only_preflight",
    targetPlatform: inputs.platform,
    expectedStore: inputs.store,
    expectedStoreRef: structuredClone(inputs.storeRef),
    requestedWriteFields: structuredClone(inputs.allowedWriteFields),
    imageUploadRequested: inputs.allowedWriteFields.includes("assets.finalUploads"),
    productCreationRequested: inputs.allowedWriteFields.includes("create_product"),
    inventoryWriteRequested: inputs.allowedWriteFields.includes("stock"),
    expectedPlatformWriteCurrency: inputs.platformWritePrice.currency,
    platformWriteRequested: false
  }));
  validateInspection(inspection);
  if (JSON.stringify(protectedPlan) !== JSON.stringify(productionPlan)) throw new Error("PLATFORM_PREFLIGHT_PLAN_MUTATED: 检查器修改了ProductionPlan");

  const platformWritableFields = [...new Set(inspection.platformWritableFields)];
  const effectiveWritableFields = inputs.allowedWriteFields.filter((field) => platformWritableFields.includes(field));
  const risks = structuredClone(inspection.risks);
  // Two qualifying anchors, never a bare claim. 'platform_store_id' compares an observed store ref, as before.
  // 'scoped_warehouse' (owner decision 2026-09-16) stands on the warehouse read back with this key plus the
  // owner-verified warehouse-to-store binding, and therefore requires observedStoreRef to stay null — Ozon
  // publishes no store number, so a store ref alongside that claim would be a fabrication, not a stronger proof.
  const identityVia = storeIdentityVia(inspection);
  const warehouseAnchored = identityVia === "scoped_warehouse";
  const anchored = isStoreIdentityAnchored({ via: identityVia, observedStoreRef: inspection.observedStoreRef, expectedStoreRef: inputs.storeRef });
  // 锚不住的路径（'none'，以及叫不出名字的锚）根本没有可核的锚，所以诚实的词是"未核验"——"不一致"的意思是
  // 核过了、两边对不上，把"压根没核"说成"核出来不一致"，是在报告一次从未发生的核对。
  const storeStatus = inspection.storeIdentityStatus === "unverified" || !canStoreIdentityPathAnchor(identityVia) ||
      (!warehouseAnchored && inspection.observedStoreRef === null) ? "unverified"
    : inspection.storeIdentityStatus === "matched" && inspection.observedStore === inputs.store && anchored ? "matched" : "mismatched";
  if (storeStatus !== "matched") risks.push({ code: "store_identity_not_verified", message: "店铺身份尚未验证一致" });
  const priceCurrencyMatched = inspection.priceFieldCurrency === inputs.platformWritePrice.currency;
  if (!priceCurrencyMatched) risks.push({ code: "platform_price_currency_mismatch", message: `授权写入币种${inputs.platformWritePrice.currency}与平台字段币种${inspection.priceFieldCurrency}不一致` });
  if (effectiveWritableFields.length !== inputs.allowedWriteFields.length) risks.push({ code: "write_scope_not_fully_available", message: "平台当前权限不能覆盖全部授权字段" });
  const technicalStatus = platformWritePreflightTechnicalStatus({ ...inspection, storeIdentityStatus: storeStatus }, connectionRequirements.requiredConnections);
  if (technicalStatus !== "completed") risks.push({ code: `technical_${technicalStatus}`, message: "平台前置检查未完成，仅记录技术状态，不改变商品业务状态" });

  const preflight = {
    schemaVersion: PLATFORM_WRITE_PREFLIGHT_VERSION,
    preflightId: `platform-preflight:${productionPlan.planId}:${fingerprint({ schemaVersion: PLATFORM_WRITE_PREFLIGHT_VERSION, connectionRequirements, checkedAt, inspection }).slice(0, 12)}`,
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    targetPlatform: inputs.platform,
    connectionRequirements: structuredClone(connectionRequirements),
    storeIdentity: {
      expectedStore: inputs.store,
      observedStore: inspection.observedStore,
      expectedStoreRef: structuredClone(inputs.storeRef),
      observedStoreRef: structuredClone(inspection.observedStoreRef),
      status: storeStatus,
      // Recorded so the conclusion stays traceable to the anchor it came from, not only to its evidence ref.
      verifiedVia: identityVia,
      evidenceRef: inspection.storeIdentityEvidenceRef
    },
    permission: {
      status: inspection.permissionStatus,
      evidenceRef: inspection.permissionEvidenceRef
    },
    connectionStatus: structuredClone(inspection.connections),
    authorizedWriteFields: structuredClone(inputs.allowedWriteFields),
    platformWritableFields,
    effectiveWritableFields,
    imagePermission: {
      status: inspection.imagePermissionStatus,
      evidenceRef: inspection.imagePermissionEvidenceRef
    },
    priceCurrency: {
      expected: inputs.platformWritePrice.currency,
      observed: inspection.priceFieldCurrency,
      status: priceCurrencyMatched ? "matched" : "mismatched",
      evidenceRef: inspection.priceCurrencyEvidenceRef
    },
    risks,
    technicalStatus,
    businessStateEffect: "none",
    checkedAt,
    readyForPlatformWrite: false,
    productCreated: false,
    imagesUploaded: 0,
    inventoryModified: false,
    storeDataModified: false,
    productionRecordCreated: false,
    platformWrites: 0
  };
  assertValidPlatformWritePreflight(preflight);
  return deepFreeze(preflight);
}
