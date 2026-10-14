import { sameStoreRef } from "./store-binding.mjs";
import { createHash } from "node:crypto";
import {
  assertValidProductionPlan,
  projectProductionPlanInputs,
  fingerprintProductionAuthorization,
  fingerprintProductionPlan,
  validateProductionPlanAuthorizationBinding
} from "./production-plan.mjs";
import {
  assertCurrentProductionAuthorization,
  DRAFT_ONLY_PUBLISH_SCOPE,
  VALIDATION_MODERATION_PUBLISH_SCOPE,
  PRODUCTION_WRITE_FIELDS
} from "./production-authorization.mjs";
import { assertValidPlatformWritePreflight, assertCurrentProductionExecutionBinding, isStoreIdentityAnchored } from "./platform-write-preflight.mjs";
import { PRODUCTION_RECORD_VERSION, DRAFT_WRITE_FIELDS, MODERATION_WRITE_FIELDS, assertValidProductionRecord } from "./production-record-contract.mjs";
export { PRODUCTION_RECORD_VERSION, validateProductionReadbackExpectation, validateProductionRecord, assertValidProductionRecord } from "./production-record-contract.mjs";

function writeFieldsFor(plan) {
  return plan.publishScope === VALIDATION_MODERATION_PUBLISH_SCOPE ? MODERATION_WRITE_FIELDS : DRAFT_WRITE_FIELDS;
}

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

function containsUnknown(value) {
  if (value === "unknown") return true;
  if (Array.isArray(value)) return value.some(containsUnknown);
  if (!isObject(value)) return false;
  if (value.verificationStatus === "unknown" || value.status === "unknown") return true;
  return Object.values(value).some(containsUnknown);
}

function requiredAttributesKnown(attributes) {
  const fields = attributes?.requiredPlatformFields;
  return Array.isArray(fields) && fields.length > 0 && fields.every((field) =>
    isObject(field) && isObject(field.fact) && !containsUnknown(field.fact)
  );
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function categoryValue(category, key) {
  const field = category?.[key];
  if (isObject(field) && "value" in field) return field.value;
  return field;
}

function validateDraftInputs(productionPlan, preflight) {
  const inputs = projectProductionPlanInputs(productionPlan);
  if (![DRAFT_ONLY_PUBLISH_SCOPE, VALIDATION_MODERATION_PUBLISH_SCOPE].includes(inputs.publishScope)) {
    throw new Error("DRAFT_SCOPE_REJECTED: 生产范围无效");
  }
  if (inputs.allowedWriteFields.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field))) {
    throw new Error("DRAFT_SCOPE_REJECTED: 生产计划包含未授权字段");
  }
  const requiredWriteFields = writeFieldsFor(inputs);
  const missing = requiredWriteFields.filter((field) => !inputs.allowedWriteFields.includes(field));
  if (missing.length > 0) throw new Error(`DRAFT_SCOPE_REJECTED: 授权缺少草稿创建字段 ${missing.join(",")}`);
  if (!requiredAttributesKnown(inputs.attributes)) throw new Error("DRAFT_DATA_GAP: 平台必填属性仍有unknown，禁止真实创建");
  if (inputs.stock !== 100) throw new Error("DRAFT_DATA_GAP: 新品库存必须锁定为100");
  if (!Array.isArray(inputs.finalUploads) || inputs.finalUploads.length === 0 ||
      inputs.finalUploads.some((asset) => !nonEmptyString(asset.assetId) || !nonEmptyString(asset.assetRef) || asset.ownerConfirmed !== true || asset.productionEligible !== true)) {
    throw new Error("DRAFT_DATA_GAP: 最终上传素材未完整锁定");
  }
  const descriptionCategoryId = categoryValue(inputs.platformCategory, "descriptionCategoryId");
  const typeId = categoryValue(inputs.platformCategory, "typeId");
  if (!nonEmptyString(String(descriptionCategoryId || "")) || descriptionCategoryId === "unknown" ||
      !nonEmptyString(String(typeId || "")) || typeId === "unknown") {
    throw new Error("DRAFT_DATA_GAP: 平台类目或商品类型未锁定");
  }
  if (preflight.sourceProductionPlanId !== productionPlan.planId ||
      preflight.sourceProductionPlanFingerprint !== fingerprintProductionPlan(productionPlan)) {
    throw new Error("DRAFT_PREFLIGHT_STALE: 前置检查不属于当前ProductionPlan");
  }
  // 仓库反推下 observedStoreRef 恒为 null（Ozon 不发店铺编号），身份靠 verifiedVia 指的那条锚成立；
  // 非仓库锚点仍按原来的观察引用比对。expectedStoreRef 与授权店铺的比对不变。
  if (preflight.technicalStatus !== "completed" ||
      preflight.storeIdentity.status !== "matched" || !sameStoreRef(preflight.storeIdentity.expectedStoreRef, inputs.storeRef) ||
      !isStoreIdentityAnchored({ via: preflight.storeIdentity.verifiedVia, observedStoreRef: preflight.storeIdentity.observedStoreRef, expectedStoreRef: inputs.storeRef }) ||
      preflight.permission.status !== "verified" ||
      preflight.priceCurrency?.status !== "matched" ||
      preflight.connectionStatus.api.status !== "connected") {
    throw new Error("DRAFT_PREFLIGHT_NOT_READY: 平台连接、店铺身份或权限检查未通过");
  }
  const unavailable = requiredWriteFields.filter((field) => !preflight.effectiveWritableFields.includes(field));
  if (unavailable.length > 0) throw new Error(`DRAFT_PREFLIGHT_NOT_READY: 平台当前不可写字段 ${unavailable.join(",")}`);
}

/**
 * 第13B-2阶段唯一真实写入口：一个SKU，只创建draft，并严格写入授权中的库存与最终素材。
 */
export async function executeSingleSkuDraftCreation({
  productionPlan,
  productionAuthorization,
  platformWritePreflight,
  currentProductionBinding,
  createPlatformDraft,
  readbackPlatformDraft,
  executedAt
}) {
  assertValidProductionPlan(productionPlan);
  assertCurrentProductionAuthorization(productionAuthorization, { observedAt: executedAt });
  assertValidPlatformWritePreflight(platformWritePreflight);
  if (!isoDateTime(executedAt)) throw new Error("DRAFT_EXECUTION_INPUT_GAP: 执行时间无效");
  if (typeof createPlatformDraft !== "function") throw new Error("DRAFT_EXECUTION_ADAPTER_REQUIRED: 缺少真实平台草稿创建器");
  if (typeof readbackPlatformDraft !== "function") throw new Error("DRAFT_READBACK_ADAPTER_REQUIRED: 缺少独立草稿回读器");

  const binding = validateProductionPlanAuthorizationBinding(productionPlan, productionAuthorization);
  if (!binding.valid) throw new Error("DRAFT_AUTHORIZATION_VERSION_CHANGED: 授权版本或内容已变化，拒绝执行");
  validateDraftInputs(productionPlan, platformWritePreflight);
  assertCurrentProductionExecutionBinding({ productionAuthorization, currentProductionBinding, checkedAt: executedAt });

  const inputs = projectProductionPlanInputs(productionPlan);
  const protectedPlan = structuredClone(productionPlan);
  const protectedAuthorization = structuredClone(productionAuthorization);
  const moderationMode = inputs.publishScope === VALIDATION_MODERATION_PUBLISH_SCOPE;
  const payload = deepFreeze({
    mode: moderationMode ? "single_sku_create_and_moderate" : "single_sku_draft_only",
    platform: inputs.platform,
    store: inputs.store,
    skuPackageId: inputs.skuPackageId,
    supplierSkuId: inputs.sku.supplierSkuId,
    merchantSku: inputs.sku.merchantSku,
    variantKey: inputs.sku.variantKey,
    title: inputs.title,
    titleVersion: inputs.titleVersion,
    content: structuredClone(inputs.content),
    contentVersion: inputs.contentVersion,
    attributes: structuredClone(inputs.attributes),
    attributeVersion: inputs.attributeVersion,
    packing: structuredClone(inputs.packing),
    schemaWriteBindings: structuredClone(inputs.schemaWriteBindings),
    platformCategory: structuredClone(inputs.platformCategory),
    buyerTargetPrice: structuredClone(inputs.buyerTargetPrice),
    platformWritePrice: structuredClone(inputs.platformWritePrice),
    priceConversion: structuredClone(inputs.priceConversion),
    stock: inputs.stock,
    finalUploads: structuredClone(inputs.finalUploads),
    authorizedMedia: {
      fingerprint: inputs.authorizedMediaFingerprint,
      primaryImage: inputs.finalUploads[0]?.assetRef,
      images: inputs.finalUploads.slice(1).map(asset => asset.assetRef)
    },
    publishScope: inputs.publishScope,
    batchSize: 1,
    publish: false,
    activate: false,
    openAdvertising: false,
    writeInventory: !moderationMode,
    uploadImages: true
  });

  const platformResult = await createPlatformDraft(payload);
  if (JSON.stringify(protectedPlan) !== JSON.stringify(productionPlan) ||
      JSON.stringify(protectedAuthorization) !== JSON.stringify(productionAuthorization)) {
    throw new Error("DRAFT_EXECUTION_INPUT_MUTATED: 平台适配器修改了冻结输入");
  }
  const expectedStatus = moderationMode ? "validation_or_moderation" : "draft";
  if (!isObject(platformResult) || platformResult.status !== expectedStatus || !nonEmptyString(String(platformResult.productId || "")) || !nonEmptyString(platformResult.writeEvidenceRef)) {
    throw new Error(`DRAFT_PLATFORM_RESULT_INVALID: 平台必须返回${expectedStatus}状态、商品ID和写入证据引用`);
  }
  if (platformResult.published === true || platformResult.activated === true || (!moderationMode && platformResult.moderationSubmitted === true) || platformResult.advertisingOpened === true) {
    throw new Error("DRAFT_PLATFORM_SCOPE_VIOLATION: 平台返回了禁止的发布、激活、送审或广告变化");
  }

  const readback = await readbackPlatformDraft(deepFreeze({
    mode: moderationMode ? "independent_validation_moderation_readback" : "independent_draft_readback",
    platform: inputs.platform,
    store: inputs.store,
    productId: String(platformResult.productId),
    supplierSkuId: inputs.sku.supplierSkuId,
    merchantSku: inputs.sku.merchantSku,
    expectedTitle: inputs.title,
    expectedPrice: structuredClone(inputs.platformWritePrice),
    expectedStock: moderationMode ? null : inputs.stock,
    expectedFinalUploadAssetIds: inputs.finalUploads.map((asset) => asset.assetId),
    expectedMainImageAssetId: inputs.finalUploads[0].assetId
  }));
  if (!isObject(readback) || readback.status !== expectedStatus || String(readback.productId || "") !== String(platformResult.productId) ||
      readback.title !== inputs.title || (!moderationMode && readback.stock !== inputs.stock) || (moderationMode && readback.inventoryModified !== false) ||
      !isObject(readback.price) || readback.price.amount !== inputs.platformWritePrice.amount || readback.price.currency !== inputs.platformWritePrice.currency ||
      !sameStringArray(readback.finalUploadAssetIds, inputs.finalUploads.map((asset) => asset.assetId)) ||
      readback.mainImageAssetId !== inputs.finalUploads[0].assetId || !nonEmptyString(readback.evidenceRef) ||
      readback.published === true || readback.activated === true || (!moderationMode && readback.moderationSubmitted === true)) {
    throw new Error("DRAFT_READBACK_MISMATCH: 独立回读未证明授权状态、标题、价格、库存边界和最终素材完全一致");
  }

  const record = {
    schemaVersion: PRODUCTION_RECORD_VERSION,
    productionRecordId: `production-record:${inputs.skuPackageId}:${fingerprint(platformResult).slice(0, 12)}`,
    executionMode: moderationMode ? "single_sku_create_and_moderate" : "single_sku_draft_only",
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    sourceAuthorizationId: productionAuthorization.authorizationId,
    sourceAuthorizationFingerprint: fingerprintProductionAuthorization(productionAuthorization),
    platform: inputs.platform,
    store: inputs.store,
    skuPackageId: inputs.skuPackageId,
    supplierSkuId: inputs.sku.supplierSkuId,
    merchantSku: inputs.sku.merchantSku,
    platformProductId: String(platformResult.productId),
    platformOfferId: nonEmptyString(String(platformResult.offerId || "")) ? String(platformResult.offerId) : null,
    status: expectedStatus,
    writtenFields: [...writeFieldsFor(inputs)],
    platformEvidenceRef: readback.evidenceRef,
    platformWriteEvidenceRef: platformResult.writeEvidenceRef,
    platformReadbackEvidenceRef: readback.evidenceRef,
    createdAt: executedAt,
    businessStateEffect: moderationMode ? "D_created_entered_validation_moderation" : "D_draft_created",
    batchSize: 1,
    published: false,
    activated: false,
    advertisingOpened: false,
    inventoryModified: !moderationMode,
    stockWritten: moderationMode ? null : inputs.stock,
    imagesUploaded: inputs.finalUploads.length,
    finalUploadAssetIds: inputs.finalUploads.map((asset) => asset.assetId),
    mainImageAssetId: inputs.finalUploads[0].assetId,
    independentReadbackVerified: true
  };
  assertValidProductionRecord(record);
  return deepFreeze({
    flowVersion: "single-sku-draft-execution-v1.1",
    productionRecord: record,
    productionPlanChanged: false,
    productionAuthorizationChanged: false,
    otherSkuExecuted: false
  });
}
