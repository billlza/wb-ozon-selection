import { isCompleteStoreRef } from "./store-binding.mjs";
import { isCanonicalFrozenRef, isCanonicalStableHttpsAssetRef } from "./production-contract-primitives.mjs";

export const PRODUCTION_RECORD_VERSION = "production-record-v1.1";

/** Structural contract shared by production records and the D/E readback matcher. */
function validateReadbackExpectationVersion(value, version, stockBasis) {
  const exactKeys = (entry, keys) => isObject(entry) && Object.keys(entry).length === keys.length && keys.every(key => Object.hasOwn(entry, key));
  if (!exactKeys(value, ["schemaVersion", "media", "warehouseId", "stockBasis"]) ||
      value.schemaVersion !== version || typeof value.warehouseId !== "string" ||
      !/^[1-9][0-9]*$/.test(value.warehouseId) || value.stockBasis !== stockBasis ||
      !Array.isArray(value.media) || value.media.length < 1) return false;
  const ids = new Set();
  const urls = new Set();
  return value.media.every((asset, index) => {
    if (!exactKeys(asset, ["assetId", "order", "sha256", "submittedUrl"]) || asset.order !== index + 1 ||
        !isCanonicalFrozenRef(asset.assetId) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !isCanonicalStableHttpsAssetRef(asset.submittedUrl) || ids.has(asset.assetId) || urls.has(asset.submittedUrl)) return false;
    ids.add(asset.assetId); urls.add(asset.submittedUrl); return true;
  });
}

/** Current execution gate; v1 records remain readable below but cannot authorize a new E read. */
export function validateProductionReadbackExpectation(value) {
  return validateReadbackExpectationVersion(value, "production-readback-expectation-v2", "free_stock");
}

function validateHistoricalReadbackExpectation(value) {
  return validateProductionReadbackExpectation(value) ||
    validateReadbackExpectationVersion(value, "production-readback-expectation-v1", "present_minus_reserved");
}

export const DRAFT_WRITE_FIELDS = Object.freeze([
  "create_product",
  "title",
  "attributes",
  "price",
  "stock",
  "assets.finalUploads",
  "publish_scope"
]);
export const MODERATION_WRITE_FIELDS = Object.freeze([
  "create_product",
  "title",
  "attributes",
  "price",
  "assets.finalUploads",
  "publish_scope"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateProductionRecord(record) {
  const errors = [];
  if (!isObject(record)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (record.schemaVersion !== PRODUCTION_RECORD_VERSION) push(errors, "schemaVersion", `必须是${PRODUCTION_RECORD_VERSION}`);
  for (const field of [
    "productionRecordId", "sourceProductionPlanId", "sourceProductionPlanFingerprint",
    "sourceAuthorizationId", "sourceAuthorizationFingerprint", "platform", "store",
    "skuPackageId", "supplierSkuId", "platformProductId", "platformEvidenceRef", "createdAt"
  ]) if (!nonEmptyString(record[field])) push(errors, field, "必须是非空字符串");
  if (!isoDateTime(record.createdAt)) push(errors, "createdAt", "必须是有效时间");
  if (!["draft", "validation_or_moderation"].includes(record.status)) push(errors, "status", "D执行阶段无效");
  if (!["single_sku_draft_only", "single_sku_create_and_moderate", "single_sku_seller_api"].includes(record.executionMode)) push(errors, "executionMode", "只能执行单SKU授权范围");
  const expectedFields = record.executionMode === "single_sku_create_and_moderate" ? MODERATION_WRITE_FIELDS : DRAFT_WRITE_FIELDS;
  if (!sameStringArray(record.writtenFields, expectedFields)) push(errors, "writtenFields", "写入字段与授权范围不一致");
  if (!["D_draft_created", "D_created_entered_validation_moderation"].includes(record.businessStateEffect)) push(errors, "businessStateEffect", "业务效果无效");
  if (record.batchSize !== 1) push(errors, "batchSize", "只能创建一个SKU");
  if (record.published !== false || record.activated !== false || record.advertisingOpened !== false) push(errors, "status", "本轮不得执行独立发布、激活或广告操作");
  if (record.executionMode === "single_sku_draft_only" && (record.inventoryModified !== true || record.stockWritten !== 100)) push(errors, "inventoryModified", "草稿模式必须记录库存100已写入");
  if (record.executionMode === "single_sku_create_and_moderate" && (record.inventoryModified !== false || record.stockWritten !== null)) push(errors, "inventoryModified", "旧校验/审核模式必须记录库存未写");
  if (record.executionMode === "single_sku_seller_api") {
    for (const field of ["merchantSku", "requestReceiptRef", "inventoryReceiptRef", "executionKey", "warehouseRef", "credentialAlias"]) {
      if (!nonEmptyString(record[field])) push(errors, field, "Seller API软件执行记录必须保存非空值");
    }
    if (!isCompleteStoreRef(record.storeRef, record.store)) push(errors, "storeRef", "必须保存已执行的完整店铺身份");
    if (!nonEmptyString(record.platformOfferId) || record.platformOfferId !== record.merchantSku) push(errors, "platformOfferId", "平台offer必须等于锁定merchantSku");
    if (record.inventoryModified !== true || !Number.isSafeInteger(record.stockWritten) || record.stockWritten < 0) push(errors, "inventoryModified", "Seller API软件执行必须记录已写入的授权库存");
    if (!isObject(record.expectedPrice) || !Number.isFinite(record.expectedPrice.amount) || !nonEmptyString(record.expectedPrice.currency)) push(errors, "expectedPrice", "必须锁定E回读价格");
    if (record.expectedStock !== record.stockWritten) push(errors, "expectedStock", "E回读库存必须等于本次写入的授权库存");
    if (record.expectedImageCount !== record.imagesUploaded) push(errors, "expectedImageCount", "必须锁定E回读图片数");
    // Historical records remain readable; E separately requires the precise projection.
    if (Object.hasOwn(record, "readbackExpectation")) {
      const expectation = record.readbackExpectation;
      if (!validateHistoricalReadbackExpectation(expectation) ||
          !sameStringArray(expectation.media.map(asset => asset.assetId), record.finalUploadAssetIds)) {
        push(errors, "readbackExpectation", "精确回读期望必须完整并属于已写入的有序素材集合");
      }
    }
  }
  if (!Number.isInteger(record.imagesUploaded) || record.imagesUploaded < 1) push(errors, "imagesUploaded", "必须记录草稿内最终图片写入数量");
  if (!Array.isArray(record.finalUploadAssetIds) || record.finalUploadAssetIds.length !== record.imagesUploaded || record.finalUploadAssetIds.some((item) => !nonEmptyString(item))) push(errors, "finalUploadAssetIds", "必须按顺序记录已写入的最终素材");
  if (!nonEmptyString(record.mainImageAssetId) || record.mainImageAssetId !== record.finalUploadAssetIds?.[0]) push(errors, "mainImageAssetId", "首图必须是最终素材顺序第一张");
  if (record.independentReadbackVerified !== true || !nonEmptyString(record.platformWriteEvidenceRef) || !nonEmptyString(record.platformReadbackEvidenceRef)) push(errors, "independentReadbackVerified", "草稿创建后必须保存独立回读证据");
  return { valid: errors.length === 0, errors };
}

export function assertValidProductionRecord(record) {
  const result = validateProductionRecord(record);
  if (!result.valid) throw new Error(`ProductionRecord校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return record;
}

