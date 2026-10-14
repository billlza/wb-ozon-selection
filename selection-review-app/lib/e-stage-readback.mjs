import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { assertValidProductionRecord, validateProductionRecord, validateProductionReadbackExpectation } from "./production-record-contract.mjs";
import { createHash } from "node:crypto";
import { assertNoProductionSecrets } from "./production-contract-primitives.mjs";

export { validateProductionReadbackExpectation } from "./production-record-contract.mjs";

export const EXTERNAL_LISTING_RECORD_VERSION = "external-listing-record-v1.1";
export const E_VERIFICATION_RECORD_VERSION = "e-verification-record-v1.1";

const OUTCOMES = Object.freeze({
  SYSTEM_CREATED: "listed_verified",
  EXTERNAL_DISCOVERED: "externally_verified"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function knownOrNonNegativeInteger(value) {
  return value === "unknown" || (Number.isInteger(value) && value >= 0);
}

function validMoney(value) {
  return isObject(value) && Number.isFinite(value.amount) && value.amount >= 0 && nonEmpty(value.currency);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function positiveId(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

export function isObservedHttpsMediaUrl(value) {
  if (!nonEmpty(value) || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    assertNoProductionSecrets(value, "platformMediaUrl");
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** A projection of the frozen D request, never a second authorization input. */
export function projectProductionReadbackExpectation({ finalUploads, warehouseId }) {
  const value = { schemaVersion: "production-readback-expectation-v2", warehouseId, stockBasis: "free_stock",
    media: Array.isArray(finalUploads) ? finalUploads.map(asset => ({ assetId: asset.assetId, order: asset.order,
      sha256: asset.sha256, submittedUrl: asset.platformAcceptedUrl })) : [] };
  if (!validateProductionReadbackExpectation(value)) throw new Error("D_READBACK_EXPECTATION_INVALID");
  return freeze(value);
}

export function observedMediaSequence(media) {
  if (!exactKeys(media, ["sourceProtocol", "primaryImageUrl", "images"]) ||
      !["ozon-product-attributes-v4", "ozon-product-info-v3"].includes(media.sourceProtocol) ||
      !isObservedHttpsMediaUrl(media.primaryImageUrl) || !Array.isArray(media.images) || media.images.some(url => !isObservedHttpsMediaUrl(url))) return null;
  // The separate primary field can also be the leading entry of the platform list.
  // Only that leading repetition is structural; other duplicates remain observable.
  const details = media.images[0] === media.primaryImageUrl ? media.images.slice(1) : media.images;
  return [media.primaryImageUrl, ...details];
}

function validHistoricalInventoryObservation(inventory) {
  return exactKeys(inventory, ["sourceProtocol", "rows"]) && inventory.sourceProtocol === "ozon-product-stocks-v4" &&
    Array.isArray(inventory.rows) && inventory.rows.every(row => exactKeys(row, ["warehouseId", "type", "present", "reserved"]) &&
      (positiveId(row.warehouseId) || row.warehouseId === "unknown") && nonEmpty(row.type) &&
      [row.present, row.reserved].every(value => value === "unknown" || (Number.isSafeInteger(value) && value >= 0)));
}

const STOCK_OBSERVATION_PROTOCOL = "ozon-product-stocks-by-warehouse-fbs-v2";
const observedQuantity = value => value === "unknown" || (Number.isSafeInteger(value) && value >= 0);
const precisePositiveId = value => positiveId(value) && Number.isSafeInteger(Number(value));

function validInventoryObservation(inventory) {
  return exactKeys(inventory, ["sourceProtocol", "hasNext", "rows"]) && inventory.sourceProtocol === STOCK_OBSERVATION_PROTOCOL &&
    (typeof inventory.hasNext === "boolean" || inventory.hasNext === "unknown") && Array.isArray(inventory.rows) &&
    inventory.rows.every(row => exactKeys(row, ["warehouseId", "productId", "sku", "offerId", "freeStock", "present", "reserved"]) &&
      [row.warehouseId, row.productId, row.sku].every(value => precisePositiveId(value) || value === "unknown") &&
      nonEmpty(row.offerId) && [row.freeStock, row.present, row.reserved].every(observedQuantity));
}

/** Only the directly observed free_stock of one exact product/warehouse on a complete page is eligible. */
export function observedWarehouseAvailableStock(inventory, warehouseId, identity) {
  if (!precisePositiveId(warehouseId) || !precisePositiveId(identity?.productId) || !nonEmpty(identity?.offerId) ||
      !validInventoryObservation(inventory) || inventory.hasNext !== false) return "unknown";
  const rows = inventory.rows.filter(row => row.warehouseId === warehouseId && row.productId === identity.productId && row.offerId === identity.offerId);
  if (rows.length !== 1 || !precisePositiveId(rows[0].sku) ||
      ![rows[0].freeStock, rows[0].present, rows[0].reserved].every(value => Number.isSafeInteger(value) && value >= 0)) return "unknown";
  return rows[0].freeStock;
}

/** Content verification distinguishes unknown CDN identity from a proven change to known media. */
export function productionReadbackContentGaps(expectation, observation) {
  if (!validateProductionReadbackExpectation(expectation)) return ["readback_expectation_missing_or_invalid"];
  const gaps = productionReadbackMediaGaps(expectation, observation);
  const stock = observedWarehouseAvailableStock(observation?.inventoryObservation, expectation.warehouseId, { productId: observation?.platformProductId, offerId: observation?.merchantSku });
  if (stock === "unknown") gaps.push("warehouse_identity_or_quantity_unverified");
  else if (stock !== observation.currentStock) gaps.push("warehouse_stock_mismatch");
  return gaps;
}

/** Media evidence can be checked when the owner explicitly chose card creation without stock write. */
export function productionReadbackMediaGaps(expectation, observation) {
  if (!validateProductionReadbackExpectation(expectation)) return ["readback_expectation_missing_or_invalid"];
  const gaps = [];
  const sequence = observedMediaSequence(observation?.mediaObservation);
  if (!sequence) gaps.push("media_identity_unverified");
  else {
    const expectedUrls = expectation.media.map(asset => asset.submittedUrl);
    const observedUrls = new Set(sequence);
    const identitiesKnown = sequence.every(url => expectedUrls.includes(url));
    if (observedUrls.size !== sequence.length) gaps.push("media_duplicate");
    if (sequence.length !== expectedUrls.length) gaps.push("media_manifest_mismatch");
    if (!identitiesKnown) gaps.push("media_identity_unverified");
    // Compare placement only when both lists demonstrably contain the same assets.
    // A transformed URL alone proves neither that the main image changed nor that it stayed the same.
    const sameAssetSet = identitiesKnown && observedUrls.size === sequence.length && sequence.length === expectedUrls.length;
    if (sameAssetSet) {
      if (sequence[0] !== expectedUrls[0]) gaps.push("main_image_mismatch");
      if (JSON.stringify(sequence) !== JSON.stringify(expectedUrls)) gaps.push("media_order_or_set_mismatch");
    }
    if (observation.imageCount !== sequence.length) gaps.push("imageCount");
  }
  return gaps;
}

function validateObservedState(record, errors) {
  for (const field of ["platform", "store", "skuPackageId", "supplierSkuId", "platformProductId", "merchantSku", "saleStatus", "platformEvidenceRef"]) {
    if (!nonEmpty(record[field])) push(errors, field, "必须是非空字符串");
  }
  if (!validMoney(record.currentPrice)) push(errors, "currentPrice", "必须包含当前价格和币种");
  if (!knownOrNonNegativeInteger(record.currentStock)) push(errors, "currentStock", "必须是非负整数或unknown");
  if (!knownOrNonNegativeInteger(record.imageCount)) push(errors, "imageCount", "必须是非负整数或unknown");
  if (!(record.moderationStatus === "unknown" || nonEmpty(record.moderationStatus))) push(errors, "moderationStatus", "必须记录当前状态或unknown");
  if (!(record.validationStatus === "unknown" || nonEmpty(record.validationStatus))) push(errors, "validationStatus", "必须记录当前状态或unknown");
  if (!Array.isArray(record.errors) && record.errors !== "unknown") push(errors, "errors", "必须是错误数组或unknown");
}

export function validateExternalListingRecord(record) {
  const errors = [];
  if (!isObject(record)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (record.schemaVersion !== EXTERNAL_LISTING_RECORD_VERSION) push(errors, "schemaVersion", `必须是${EXTERNAL_LISTING_RECORD_VERSION}`);
  if (!nonEmpty(record.externalListingRecordId)) push(errors, "externalListingRecordId", "必须是非空字符串");
  if (!isoDate(record.discoveredAt)) push(errors, "discoveredAt", "必须是有效时间");
  if (!['seller_api', 'seller_portal'].includes(record.discoverySource)) push(errors, "discoverySource", "发现来源必须是Seller API或卖家后台");
  if (record.createdByCurrentRun !== false) push(errors, "createdByCurrentRun", "外部发现商品不得记为本轮创建");
  validateObservedState(record, errors);
  const decision = record.ownerPriceDecision;
  if (!isObject(decision) || decision.decision !== "keep_current_live_price" || decision.confirmedBy !== "owner" || !isoDate(decision.confirmedAt) || !validMoney(decision.price)) {
    push(errors, "ownerPriceDecision", "必须保存主人保留当前价格的精确决定");
  } else if (decision.price.amount !== record.currentPrice.amount || decision.price.currency !== record.currentPrice.currency) {
    push(errors, "ownerPriceDecision.price", "主人保留价格必须等于平台当前价格");
  }
  return { valid: errors.length === 0, errors };
}

function listedObservationGaps(observation, { historicalInventory = false } = {}) {
  if (!isObject(observation)) return ["observation"];
  const gaps = [];
  if (!isCompleteStoreRef(observation.storeRef, observation.store) || !nonEmpty(observation.warehouseRef) || !nonEmpty(observation.credentialAlias)) gaps.push("executionBinding");
  if (!Number.isSafeInteger(observation.currentStock) || observation.currentStock < 0) gaps.push("currentStock");
  if (!Number.isSafeInteger(observation.imageCount) || observation.imageCount < 1) gaps.push("imageCount");
  if (!validMoney(observation.currentPrice)) gaps.push("currentPrice");
  if (observation.moderationStatus !== "approved" || observation.validationStatus !== "success" ||
      !["on_sale", "active", "selling"].includes(observation.saleStatus)) gaps.push("listedStatus");
  if (!Array.isArray(observation.errors) || observation.errors.length !== 0) gaps.push("platformErrors");
  if (!nonEmpty(observation.platformEvidenceRef)) gaps.push("platformEvidenceRef");
  if (!observedMediaSequence(observation.mediaObservation)) gaps.push("media_identity_unverified");
  if (!(historicalInventory ? validHistoricalInventoryObservation(observation.inventoryObservation) : validInventoryObservation(observation.inventoryObservation))) gaps.push("warehouse_identity_or_quantity_unverified");
  return gaps;
}

export function systemCreatedReadbackGaps(productionRecord, observation) {
  assertValidProductionRecord(productionRecord);
  const gaps = listedObservationGaps(observation);
  if (!isObject(observation)) return gaps;
  for (const field of ["platform", "store", "skuPackageId", "supplierSkuId", "merchantSku", "platformProductId"]) {
    if (observation[field] !== productionRecord[field]) gaps.push(field);
  }
  if (!sameStoreRef(observation.storeRef, productionRecord.storeRef) || observation.warehouseRef !== productionRecord.warehouseRef || observation.credentialAlias !== productionRecord.credentialAlias) gaps.push("executionBinding");
  if (!validMoney(productionRecord.expectedPrice) || observation.currentPrice?.amount !== productionRecord.expectedPrice.amount ||
      observation.currentPrice?.currency !== productionRecord.expectedPrice.currency) gaps.push("currentPrice");
  if (observation.currentStock !== productionRecord.expectedStock) gaps.push("currentStock");
  if (observation.imageCount !== productionRecord.expectedImageCount) gaps.push("imageCount");
  gaps.push(...productionReadbackContentGaps(productionRecord.readbackExpectation, observation));
  return [...new Set(gaps)];
}

export function validateEVerificationRecord(record) {
  const errors = [];
  if (!isObject(record)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (record.schemaVersion !== E_VERIFICATION_RECORD_VERSION) push(errors, "schemaVersion", `必须是${E_VERIFICATION_RECORD_VERSION}`);
  for (const field of ["verificationId", "sourceRecordId", "platform", "store", "skuPackageId", "supplierSkuId", "platformProductId", "merchantSku", "platformEvidenceRef"]) {
    if (!nonEmpty(record[field])) push(errors, field, "必须是非空字符串");
  }
  if (!isoDate(record.verifiedAt)) push(errors, "verifiedAt", "必须是有效时间");
  if (!['system_created', 'external_discovered'].includes(record.verificationPath)) push(errors, "verificationPath", "E验证路径无效");
  if (!['ProductionRecord', 'ExternalListingRecord'].includes(record.sourceRecordType)) push(errors, "sourceRecordType", "来源记录类型无效");
  if (!Object.values(OUTCOMES).includes(record.outcome)) push(errors, "outcome", "E验证结果无效");
  const systemPath = record.verificationPath === "system_created";
  if (systemPath && (record.sourceRecordType !== "ProductionRecord" || record.outcome !== OUTCOMES.SYSTEM_CREATED || record.createdByCurrentRun !== true)) {
    push(errors, "verificationPath", "系统创建路径必须来自ProductionRecord并形成listed_verified");
  }
  if (!systemPath && (record.sourceRecordType !== "ExternalListingRecord" || record.outcome !== OUTCOMES.EXTERNAL_DISCOVERED || record.createdByCurrentRun !== false)) {
    push(errors, "verificationPath", "外部发现路径必须来自ExternalListingRecord并形成externally_verified");
  }
  validateObservedState(record, errors);
  if (systemPath) for (const field of listedObservationGaps(record, { historicalInventory: record.inventoryObservation?.sourceProtocol === "ozon-product-stocks-v4" })) push(errors, field, "系统创建的E记录必须具有完整且通过的独立回读");
  const priceDecision = record.ownerPriceDecision?.decision;
  if (!isObject(record.ownerPriceDecision) || record.ownerPriceDecision.confirmedBy !== "owner" ||
      (systemPath
        ? !["keep_current_live_price", "authorized_platform_write_price"].includes(priceDecision)
        : priceDecision !== "keep_current_live_price")) {
    push(errors, "ownerPriceDecision", "必须传递与验证路径一致的主人最终价格决定");
  }
  if (priceDecision === "authorized_platform_write_price" && !nonEmpty(record.ownerPriceDecision?.authorizationId)) push(errors, "ownerPriceDecision.authorizationId", "必须保存准确授权引用");
  if (priceDecision === "keep_current_live_price" && !isoDate(record.ownerPriceDecision?.confirmedAt)) push(errors, "ownerPriceDecision.confirmedAt", "必须保存主人保留价格的确认时间");
  if (systemPath && (!validMoney(record.ownerPriceDecision?.price) || record.ownerPriceDecision.price.amount !== record.currentPrice?.amount || record.ownerPriceDecision.price.currency !== record.currentPrice?.currency)) {
    push(errors, "ownerPriceDecision.price", "授权价格与独立回读不一致");
  }
  return { valid: errors.length === 0, errors };
}

export function validateSystemCreatedVerificationRecord(record, productionRecord) {
  const errors = [...validateEVerificationRecord(record).errors];
  const source = validateProductionRecord(productionRecord);
  for (const item of source.errors) errors.push({ path: `productionRecord.${item.path}`, message: item.message });
  if (source.valid && isObject(record)) {
    if (record.verificationPath !== "system_created" || record.sourceRecordId !== productionRecord.productionRecordId) push(errors, "sourceRecordId", "必须属于当前系统生产记录");
    if (record.ownerPriceDecision?.decision === "authorized_platform_write_price" && record.ownerPriceDecision.authorizationId !== productionRecord.sourceAuthorizationId) push(errors, "ownerPriceDecision.authorizationId", "价格决定必须来自当前生产授权");
    for (const field of systemCreatedReadbackGaps(productionRecord, record)) push(errors, field, "E记录与当前生产记录不一致");
    if (!isoDate(record.verifiedAt) || Date.parse(record.verifiedAt) < Date.parse(productionRecord.createdAt)) push(errors, "verifiedAt", "独立回读不能早于生产记录");
  }
  return { valid: errors.length === 0, errors };
}

function assertValid(result, label) {
  if (!result.valid) throw new Error(`${label}校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
}

function observedFields(observation) {
  return {
    platform: String(observation.platform || "").toLowerCase(),
    store: String(observation.store || "").toLowerCase(),
    skuPackageId: String(observation.skuPackageId || ""),
    supplierSkuId: String(observation.supplierSkuId || ""),
    platformProductId: String(observation.platformProductId || ""),
    merchantSku: String(observation.merchantSku || ""),
    currentPrice: structuredClone(observation.currentPrice),
    currentStock: observation.currentStock ?? "unknown",
    imageCount: observation.imageCount ?? "unknown",
    moderationStatus: observation.moderationStatus || "unknown",
    validationStatus: observation.validationStatus || "unknown",
    saleStatus: String(observation.saleStatus || ""),
    errors: observation.errors == null ? "unknown" : structuredClone(observation.errors),
    platformEvidenceRef: String(observation.platformEvidenceRef || ""),
    ...(observation.mediaObservation ? { mediaObservation: structuredClone(observation.mediaObservation) } : {}),
    ...(observation.inventoryObservation ? { inventoryObservation: structuredClone(observation.inventoryObservation) } : {})
  };
}

export function createExternalListingRecord({ observation, ownerPriceDecision, discoveredAt }) {
  const base = observedFields(observation);
  const record = {
    schemaVersion: EXTERNAL_LISTING_RECORD_VERSION,
    externalListingRecordId: `external-listing:${base.skuPackageId}:${fingerprint({ base, discoveredAt }).slice(0, 12)}`,
    discoverySource: observation.discoverySource,
    discoveredAt,
    createdByCurrentRun: false,
    ...base,
    ownerPriceDecision: structuredClone(ownerPriceDecision)
  };
  assertValid(validateExternalListingRecord(record), "ExternalListingRecord");
  return freeze(record);
}

export function verifyExternalListing({ externalListingRecord, verifiedObservation, verifiedAt }) {
  assertValid(validateExternalListingRecord(externalListingRecord), "ExternalListingRecord");
  const observed = observedFields(verifiedObservation);
  for (const field of ["platform", "store", "skuPackageId", "supplierSkuId", "platformProductId", "merchantSku"]) {
    if (observed[field] !== externalListingRecord[field]) throw new Error(`E_READBACK_IDENTITY_MISMATCH: ${field}与外部发现记录不一致`);
  }
  if (observed.currentPrice.amount !== externalListingRecord.currentPrice.amount || observed.currentPrice.currency !== externalListingRecord.currentPrice.currency) {
    throw new Error("E_READBACK_PRICE_MISMATCH: 当前价格与主人保留决定不一致");
  }
  const record = {
    schemaVersion: E_VERIFICATION_RECORD_VERSION,
    verificationId: `e-verification:${externalListingRecord.externalListingRecordId}:${fingerprint({ observed, verifiedAt }).slice(0, 12)}`,
    verificationPath: "external_discovered",
    sourceRecordType: "ExternalListingRecord",
    sourceRecordId: externalListingRecord.externalListingRecordId,
    outcome: OUTCOMES.EXTERNAL_DISCOVERED,
    createdByCurrentRun: false,
    verifiedAt,
    ...observed,
    ownerPriceDecision: structuredClone(externalListingRecord.ownerPriceDecision)
  };
  assertValid(validateEVerificationRecord(record), "EVerificationRecord");
  return freeze(record);
}

export function verifySystemCreatedListing({ productionRecord, verifiedObservation, verifiedAt, ownerPriceDecision }) {
  const gaps = systemCreatedReadbackGaps(productionRecord, verifiedObservation);
  if (gaps.length) throw new Error(`E_SYSTEM_READBACK_INCOMPLETE: ${gaps.join(",")}`);
  if (!isoDate(verifiedAt) || Date.parse(verifiedAt) < Date.parse(productionRecord.createdAt)) throw new Error("E_SYSTEM_READBACK_TIME_INVALID");
  const observed = observedFields(verifiedObservation);
  const record = {
    schemaVersion: E_VERIFICATION_RECORD_VERSION,
    verificationId: `e-verification:${productionRecord.productionRecordId}:${fingerprint({ observed, verifiedAt }).slice(0, 12)}`,
    verificationPath: "system_created",
    sourceRecordType: "ProductionRecord",
    sourceRecordId: productionRecord.productionRecordId,
    outcome: OUTCOMES.SYSTEM_CREATED,
    createdByCurrentRun: true,
    verifiedAt,
    ...observed,
    storeRef: structuredClone(verifiedObservation.storeRef), warehouseRef: verifiedObservation.warehouseRef, credentialAlias: verifiedObservation.credentialAlias,
    ownerPriceDecision: structuredClone(ownerPriceDecision)
  };
  assertValid(validateSystemCreatedVerificationRecord(record, productionRecord), "EVerificationRecord");
  return freeze(record);
}

export const E_VERIFICATION_OUTCOMES = OUTCOMES;
