import { validPrerequisitePolicy, isCurrentInventoryPrerequisitePolicy } from "./ozon-inventory-prerequisite-policy.mjs";
export { assertOzonInventoryPrerequisitePolicy } from "./ozon-inventory-prerequisite-policy.mjs";
import { OzonDEHttpTransportError } from "./ozon-de-http-configuration.mjs";
import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { isCanonicalFrozenRef, assertNoProductionSecrets } from "./production-contract-primitives.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { observedMediaSequence, observedWarehouseAvailableStock, isObservedHttpsMediaUrl } from "./e-stage-readback.mjs";
import { assertCurrentDExecutionContext, isStoreIdentityAnchored, productionExecutionPrewriteFailure } from "./platform-write-preflight.mjs";
import { blockingImportErrors } from "./ozon-import-error-level.mjs";
import { assertDExecutableRequest } from './d-executable-request-contract.mjs';
import { projectProductionPlanImportPayload } from './production-plan.mjs';
import { buildOzonSellerBatchImportRequests } from './ozon-seller-api-production-adapter.mjs';

export const OZON_SELLER_API_DE_ADAPTER_VERSION = "ozon-seller-api-de-adapter-v3";
export const OZON_PRODUCT_IMPORT_ENDPOINT = "/v3/product/import";
export const OZON_PRODUCT_IMPORT_INFO_ENDPOINT = "/v1/product/import/info";
export const OZON_INVENTORY_WRITE_ENDPOINT = "/v2/products/stocks";

export const OZON_DE_LEGACY_READBACK_ENDPOINTS = Object.freeze({
  attributes: "/v4/product/info/attributes",
  info: "/v3/product/info/list",
  prices: "/v5/product/info/prices",
  stocks: "/v4/product/info/stocks",
  stateFailed: "/v3/product/list"
});
const READBACK_ENDPOINTS = Object.freeze({
  attributes: "/v4/product/info/attributes", info: "/v3/product/info/list", prices: "/v5/product/info/prices",
  stocks: "/v2/product/info/stocks-by-warehouse/fbs"
});
const BLOCKED_ASSET_HOSTS = Object.freeze(["tmpfiles.org"]);
const EXACT_WAREHOUSE_READ_LIMIT = 10;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isExternalNumericId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPersistedNumericId(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function gap(code, field, message) {
  return { code, field, message };
}

function verifiedEvidence(value) {
  return isObject(value) && value.status === "verified" && nonEmpty(value.protocolVersion) && nonEmpty(value.evidenceRef);
}

function normalizedHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
}

function blockedHost(host) {
  return BLOCKED_ASSET_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function normalizeStore(value) {
  return String(value || "").trim().toLowerCase();
}

export function inspectAdapterCapabilities({
  store,
  storeRef,
  warehouseRef,
  credentialAlias,
  warehouseId,
  storeIdentity,
  productImport,
  assetTransport,
  inventoryWrite,
  independentReadback,
  inspectedAt
}) {
  const gaps = [];
  const normalizedStore = normalizeStore(store);
  if (!nonEmpty(normalizedStore)) gaps.push(gap("store_missing", "store", "缺少目标店铺"));
  if (!isCompleteStoreRef(storeRef, normalizedStore) || !isCanonicalFrozenRef(warehouseRef) || !isCanonicalFrozenRef(credentialAlias)) gaps.push(gap("execution_binding_missing", "storeRef", "缺少完整店铺、仓库引用或凭据别名"));
  if (!isPersistedNumericId(warehouseId)) gaps.push(gap("warehouse_missing", "warehouseId", "缺少当前店铺的准确仓库ID"));
  if (!nonEmpty(inspectedAt) || Number.isNaN(Date.parse(inspectedAt))) gaps.push(gap("inspection_time_invalid", "inspectedAt", "能力检查时间无效"));

  // 身份锚点由 isStoreIdentityAnchored 统一判定：仓库反推要求 observedStoreRef 恒为 null（Ozon 不发店铺编号），
  // 其余路径（含未声明和未知值）仍按原来的店铺引用比对。
  if (!isObject(storeIdentity) || storeIdentity.status !== "verified" ||
      normalizeStore(storeIdentity.expectedStore) !== normalizedStore ||
      normalizeStore(storeIdentity.observedStore) !== normalizedStore ||
      !isStoreIdentityAnchored({ via: storeIdentity.verifiedVia, observedStoreRef: storeIdentity.observedStoreRef, expectedStoreRef: storeRef }) ||
      storeIdentity.credentialAlias !== credentialAlias || !nonEmpty(storeIdentity.evidenceRef)) {
    gaps.push(gap("store_identity_not_verified", "storeIdentity", "店铺身份证据未与目标店铺一致"));
  }
  if (!verifiedEvidence(productImport) || productImport.endpoint !== OZON_PRODUCT_IMPORT_ENDPOINT ||
      productImport.statusEndpoint !== OZON_PRODUCT_IMPORT_INFO_ENDPOINT) {
    gaps.push(gap("product_import_not_verified", "productImport", "商品导入和任务回执协议未验证"));
  }
  const approvedHosts = Array.isArray(assetTransport?.approvedHosts)
    ? [...new Set(assetTransport.approvedHosts.map((host) => String(host).toLowerCase().replace(/\.$/u, "")))]
    : [];
  if (!verifiedEvidence(assetTransport) || assetTransport.mode !== "preapproved_stable_https" || approvedHosts.length === 0 ||
      approvedHosts.some((host) => blockedHost(host))) {
    gaps.push(gap("asset_transport_not_verified", "assetTransport", "缺少已批准的稳定HTTPS素材能力"));
  }
  // prerequisitePolicy 只在真发库存那一步用得上（它的 priceSent.acceptedValues 至今没有官方来源）。
  // 以前把它算进“能力就绪”，于是一个发库存才需要的未知把商品导入本身也挡住了。这项检查没有删掉，
  // 只是挪到真正用它的那一步：observePriceSent 会抛 OZON_DE_INVENTORY_POLICY_NOT_VERIFIED，
  // executeRemainingInventory 会返回 inventory_prerequisite_policy_not_verified，
  // lib/d-e-runtime-services.mjs 还会以 inventory_policy_missing 拒掉整个续跑。
  if (!verifiedEvidence(inventoryWrite) || inventoryWrite.endpoint !== OZON_INVENTORY_WRITE_ENDPOINT ||
      !isPersistedNumericId(inventoryWrite.warehouseId) || inventoryWrite.warehouseId !== warehouseId || inventoryWrite.warehouseRef !== warehouseRef ||
      inventoryWrite.credentialAlias !== credentialAlias || !sameStoreRef(inventoryWrite.storeRef, storeRef)) {
    gaps.push(gap("inventory_write_not_verified", "inventoryWrite", "库存协议或仓库证据未锁定"));
  }
  if (!verifiedEvidence(independentReadback) || independentReadback.protocolVersion !== "ozon-independent-readback-v2" ||
      JSON.stringify(independentReadback.endpoints) !== JSON.stringify(READBACK_ENDPOINTS)) {
    gaps.push(gap("independent_readback_not_verified", "independentReadback", "完整独立回读协议未验证"));
  }

  const status = gaps.length === 0 ? "ready" : "not_ready";
  const capabilities = {
    status,
    platform: "ozon",
    store: normalizedStore,
    storeRef: isCompleteStoreRef(storeRef, normalizedStore) ? structuredClone(storeRef) : null,
    warehouseRef, credentialAlias,
    warehouseId: isPersistedNumericId(warehouseId) ? warehouseId : null,
    adapterVersion: OZON_SELLER_API_DE_ADAPTER_VERSION,
    protocolVersion: "ozon-single-sku-d-e-v3",
    inspectedAt,
    evidenceRef: status === "ready" ? `ozon-adapter-capabilities:${digest({
      store: normalizedStore, storeRef, warehouseRef, credentialAlias,
      warehouseId,
      storeIdentity,
      productImport,
      assetTransport,
      inventoryWrite,
      independentReadback
    })}` : null,
    storeIdentity: isObject(storeIdentity) ? structuredClone(storeIdentity) : null,
    productImport: {
      status: status === "ready" ? "verified" : (productImport?.status || "unknown"),
      endpoint: OZON_PRODUCT_IMPORT_ENDPOINT,
      statusEndpoint: OZON_PRODUCT_IMPORT_INFO_ENDPOINT,
      protocolVersion: productImport?.protocolVersion || null,
      evidenceRef: productImport?.evidenceRef || null,
      maxItemsPerRequest: productImport?.maxItemsPerRequest ?? null,
      validUntil: productImport?.validUntil ?? null
    },
    assetTransport: {
      status: status === "ready" ? "verified" : (assetTransport?.status || "unknown"),
      mode: assetTransport?.mode || null,
      protocolVersion: assetTransport?.protocolVersion || null,
      evidenceRef: assetTransport?.evidenceRef || null,
      approvedHosts,
      resolvedAssets: structuredClone(assetTransport?.resolvedAssets || [])
    },
    inventoryWrite: {
      status: status === "ready" ? "verified" : (inventoryWrite?.status || "unknown"),
      endpoint: OZON_INVENTORY_WRITE_ENDPOINT,
      storeRef: isCompleteStoreRef(storeRef, normalizedStore) ? structuredClone(storeRef) : null, warehouseRef, credentialAlias,
      warehouseId: isPersistedNumericId(warehouseId) ? warehouseId : null,
      prerequisitePolicy: validPrerequisitePolicy(inventoryWrite?.prerequisitePolicy) ? structuredClone(inventoryWrite.prerequisitePolicy) : null,
      protocolVersion: inventoryWrite?.protocolVersion || null,
      evidenceRef: inventoryWrite?.evidenceRef || null
    },
    independentReadback: {
      status: status === "ready" ? "verified" : (independentReadback?.status || "unknown"),
      endpoints: structuredClone(READBACK_ENDPOINTS),
      protocolVersion: independentReadback?.protocolVersion || null,
      evidenceRef: independentReadback?.evidenceRef || null
    },
    gaps
  };
  return freeze(capabilities);
}

export function resolveFinalUploads({ finalUploads, adapterCapabilities }) {
  const gaps = [];
  if (adapterCapabilities?.status !== "ready" || adapterCapabilities?.assetTransport?.status !== "verified") {
    gaps.push(gap("asset_transport_not_ready", "adapterCapabilities.assetTransport", "素材传输能力未验证"));
  }
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    gaps.push(gap("final_uploads_missing", "finalUploads", "缺少最终素材"));
  }
  const approvedHosts = new Set(adapterCapabilities?.assetTransport?.approvedHosts || []);
  const resolvedById = new Map((adapterCapabilities?.assetTransport?.resolvedAssets || []).map((item) => [item.assetId, item]));
  const seen = new Set();
  const resolvedAssets = (finalUploads || []).map((asset, index) => {
    const resolved = resolvedById.get(asset?.assetId);
    const host = normalizedHost(resolved?.platformAcceptedUrl);
    const expectedOrder = index + 1;
    if (!nonEmpty(asset?.assetId) || seen.has(asset.assetId)) {
      gaps.push(gap("final_asset_identity_invalid", `finalUploads.${index}`, "素材ID缺失或重复"));
    } else {
      seen.add(asset.assetId);
    }
    if (asset?.ownerConfirmed !== true || asset?.productionEligible !== true ||
        (asset?.lifecycleArea !== undefined && asset.lifecycleArea !== "finalUploads")) {
      gaps.push(gap("final_asset_not_confirmed", `finalUploads.${asset?.assetId || index}`, "只能使用主人确认的finalUploads"));
    }
    if (!resolved || resolved.authorizationStatus !== "approved" || resolved.stable !== true ||
        !nonEmpty(resolved.evidenceRef) || !host || blockedHost(host) || !approvedHosts.has(host)) {
      gaps.push(gap("platform_asset_url_not_approved", `finalUploads.${asset?.assetId || index}`, "素材没有能力证据认可的稳定HTTPS地址"));
    }
    if (resolved && (resolved.sha256 !== asset?.sha256 || resolved.order !== expectedOrder || asset?.order !== expectedOrder)) {
      gaps.push(gap("platform_asset_binding_mismatch", `finalUploads.${asset?.assetId || index}`, "素材哈希或顺序与确认清单不一致"));
    }
    return {
      assetId: asset?.assetId || "",
      sourceAssetRef: asset?.assetRef || null,
      platformAcceptedUrl: resolved?.platformAcceptedUrl || null,
      sha256: asset?.sha256 || null,
      order: expectedOrder,
      role: asset?.role || (index === 0 ? "main" : "detail"),
      evidenceRef: resolved?.evidenceRef || null,
      ownerConfirmed: true,
      productionEligible: true
    };
  });
  return freeze({
    status: gaps.length === 0 ? "ready" : "not_ready",
    resolvedAssets: gaps.length === 0 ? resolvedAssets : [],
    gaps
  });
}

function unknownOutcome(layer, reason, progress = {}) {
  return freeze({
    status: "unknown_outcome",
    layer,
    reason,
    writeOccurred: "unknown",
    ...structuredClone(progress),
    retryAllowed: false
  });
}

function rethrowProgrammingError(error) {
  if ([TypeError, ReferenceError, SyntaxError, RangeError, EvalError, URIError, AggregateError].some(Type => error instanceof Type)) throw error;
}

function transportPrewriteCode(error) {
  if (!(error instanceof OzonDEHttpTransportError) || error.externalRequestState !== "not_sent" || error.requestTransmission !== "not_attempted") return null;
  if (typeof error.code !== "string" || error.code.length > 120 ||
      !/^(?:OZON_DE_HTTP_[A-Z0-9_]+|OZON_DE_CREDENTIAL_(?:VALUE_INVALID|READ_FAILED|READER_UNAVAILABLE))$/.test(error.code)) {
    throw new TypeError("OZON_DE_TRANSPORT_ERROR_CONTRACT_INVALID");
  }
  return error.code;
}

function knownPrewriteRejection(message) {
  return freeze({
    status: "rejected_before_write",
    writeOccurred: false,
    code: "adapter_request_invalid",
    message,
    retryAllowed: false
  });
}

function batchPrewriteCode(error) {
  if (error?.constructor !== Error) return null;
  const code = error.message.split(':', 1)[0];
  return /^(?:OZON_BATCH|D_BATCH_IMPORT)_[A-Z0-9_]{1,100}$/.test(code) ? code : null;
}

function batchPrewriteRejection(reasonCode) {
  return freeze({ status: 'rejected_before_write', writeOccurred: false,
    requestTransmission: 'not_attempted', reasonCode, retryAllowed: false });
}

function validateExecutionRequest(request, capabilities) {
  if (request?.executionProtocolVersion !== "ozon-single-sku-d-e-v3") return "D_EXECUTION_PROTOCOL_RECONFIRMATION_REQUIRED";
  if (request?.sourceAuthorizationVersion !== "production-authorization-v1.2") return "PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED";
  if (!isObject(request) || request.platform !== "ozon" || normalizeStore(request.store) !== capabilities.store) return "平台或店铺与能力证据不一致";
  if (!sameStoreRef(request.storeRef, capabilities.storeRef) || request.warehouseRef !== capabilities.warehouseRef || request.credentialAlias !== capabilities.credentialAlias) return "完整店铺、仓库或凭据绑定与能力证据不一致";
  if (!nonEmpty(request.executionKey) || request.idempotencyKey !== request.executionKey) return "缺少唯一执行键";
  if (!nonEmpty(request.merchantSku) || !nonEmpty(request.supplierSkuId)) return "merchantSku与supplierSku未唯一锁定";
  if (request.stock !== 100 || request.inventoryWrite?.stock !== 100) return "新品库存必须锁定100";
  if (request.inventoryWrite?.endpoint !== OZON_INVENTORY_WRITE_ENDPOINT ||
      !isPersistedNumericId(request.inventoryWrite?.warehouseId) || request.inventoryWrite.warehouseId !== capabilities.warehouseId) return "库存端点或仓库与能力证据不一致";
  if (request.productImport?.endpoint !== OZON_PRODUCT_IMPORT_ENDPOINT || request.productImport?.body?.items?.length !== 1) return "商品导入请求必须只包含一个SKU";
  if (String(request.productImport.body.items[0]?.offer_id || "") !== request.merchantSku) return "导入offer与锁定merchantSku不一致";
  return null;
}

function receipt(prefix, payload) {
  return `${prefix}:${digest(payload)}`;
}

function itemForOffer(items, offerId) {
  return Array.isArray(items) ? items.find((item) => typeof item?.offer_id === "string" && item.offer_id === offerId) : null;
}

function readbackItemForOffer(items, offerId, name, { optional = false } = {}) {
  const matches = Array.isArray(items) ? items.filter(item => item?.offer_id === offerId) : [];
  if (!Array.isArray(items) || matches.length > 1 || (!optional && matches.length !== 1)) {
    throw new Error(`OZON_DE_READBACK_IDENTITY_MISMATCH: ${name}`);
  }
  return matches[0] ?? null;
}

function observedWarehouseId(value) {
  return isExternalNumericId(value) ? String(value) : "unknown";
}

function observedStockQuantity(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
}

function productIdOf(item) {
  if (!isObject(item)) return "";
  const fields = ["product_id", "id"].filter(field => Object.hasOwn(item, field));
  if (fields.length === 0 || fields.some(field => !isExternalNumericId(item[field]))) return "";
  const value = item[fields[0]];
  return fields.every(field => item[field] === value) ? String(value) : "";
}

/**
 * 导入任务错误明细：逐条按官方合同的 v1ItemError 规范化后落盘。
 *
 * 结构出自 docs/contracts/ozon-de-20260908/official-de-structural-openapi.json：
 *   GetImportProductsInfoResponseResultItem.errors : array of v1ItemError
 *   v1ItemError = { code, message, state, level, field, attribute_id, attribute_name }
 *
 * 为什么必须落：2026-09-24 背心停在 unknown_outcome 时，观察记录里只有 errorCount: 2，
 * 错误正文当场就丢了，主人只能去卖家后台翻——而「停下来却留不下能看懂的原因」
 * 正是这一轮要治的毛病。下面的 observedErrors() 是 E 侧的对应物，本来就整份保留，
 * 两侧口径长期不一致，这次一并对齐。
 *
 * 只落合同里有的字段，逐项限长，不落原始响应整包，不落任何凭据。
 */
function observedImportErrors(item) {
  if (!Array.isArray(item?.errors)) return "unknown";
  const text = (value, max) => typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, max) : null;
  return item.errors.slice(0, 50).map(entry => ({
    code: text(entry?.code, 128),
    message: text(entry?.message, 512),
    state: text(entry?.state, 128),
    level: text(entry?.level, 64),
    field: text(entry?.field, 128),
    attributeId: Number.isSafeInteger(entry?.attribute_id) ? entry.attribute_id : null,
    attributeName: text(entry?.attribute_name, 256)
  }));
}

function observedErrors(infoItem) {
  if (!Array.isArray(infoItem?.errors)) return "unknown";
  const safeCode = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value : "unclassified";
  const errors = infoItem.errors.slice(0, 50).map(entry => ({
    code: safeCode(entry?.code), level: safeCode(entry?.level)
  }));
  if (infoItem.errors.length > 50) errors[49] = { code: "additional_errors", level: "unknown" };
  return errors;
}

function saleStatus(infoItem) {
  if (infoItem?.is_archived === true) return "archived";
  // status_name is a human display label with no verified machine-state mapping.
  return "unknown";
}

function priceOf(priceItem) {
  const amount = priceItem?.price?.price;
  const currency = priceItem?.price?.currency_code;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 && currency === "CNY" ? { amount, currency } : null;
}

async function persistExecutionCheckpoint(persistCheckpoint, event) {
        try {
          await persistCheckpoint(freeze(structuredClone(event)));
        } catch (cause) {
          const boundaryCode = cause.code || String(cause.message).split(":", 1)[0];
          if (["D_EXECUTION_CONTINUATION_BLOCKED", "D_CHECKPOINT_REVISION_CONFLICT", "D_CHECKPOINT_SEQUENCE_REJECTED",
            "D_CHECKPOINT_STOCK_SCOPE_REJECTED", "D_CHECKPOINT_TASK_ID_INVALID", "D_CHECKPOINT_TASK_ID_MISMATCH",
            "D_CHECKPOINT_INPUT_INVALID", "D_CHECKPOINT_OBSERVATION_REJECTED", "D_CHECKPOINT_EXECUTION_IDENTITY_INVALID"].includes(boundaryCode)) {
            const error = new Error(boundaryCode);
            error.code = boundaryCode;
            error.executionRevision = cause.executionRevision;
            throw error;
          }
          const error = new Error("D_CHECKPOINT_PERSISTENCE_FAILED: 平台执行已停止，必须核对最后持久记录");
          error.code = "D_CHECKPOINT_PERSISTENCE_FAILED";
          error.persistenceStage = "checkpoint";
          error.replacementState = cause.replacementState === "replacement_written_durability_unconfirmed"
            ? cause.replacementState : "unknown";
          error.checkpoint = freeze({ kind: event.kind,
            ...(/^[1-9][0-9]*$/.test(event.taskId) ? { taskId: event.taskId } : {}),
            ...(/^[1-9][0-9]*$/.test(event.productId) ? { productId: event.productId } : {}) });
          throw error;
        }
      }

function closed(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}


function inventoryBlocked(code) {
  return freeze({ status: "blocked", code, inventoryWriteState: "not_sent", retryAllowed: false });
}

function observationScope(query) {
  return Object.fromEntries(["platform", "store", "storeRef", "warehouseRef", "credentialAlias", "warehouseId", "taskId",
    "productId", "merchantSku", "supplierSkuId", "executionKey", "requestReceiptRef"].map(key => [key, structuredClone(query[key])]));
}

function assertObservationOptions(signal, beforeRequestSend) {
  if (signal !== undefined && !(signal instanceof AbortSignal) ||
      beforeRequestSend !== undefined && typeof beforeRequestSend !== "function") {
    throw new TypeError("OZON_DE_OBSERVATION_OPTIONS_INVALID");
  }
}

function assertObservationQuery(query, capabilities, { task = false, product = false } = {}) {
  const fields = ["platform", "store", "storeRef", "warehouseRef", "credentialAlias", "warehouseId", "writeAllowed",
    "merchantSku", "supplierSkuId", "executionKey", "requestReceiptRef", ...(task ? ["taskId"] : []), ...(product ? ["productId"] : [])];
  if (!closed(query, fields) || query.platform !== "ozon" || query.store !== capabilities.store || query.writeAllowed !== false ||
      !sameStoreRef(query.storeRef, capabilities.storeRef) || query.warehouseRef !== capabilities.warehouseRef ||
      query.credentialAlias !== capabilities.credentialAlias || query.warehouseId !== capabilities.warehouseId ||
      !isCanonicalFrozenRef(query.executionKey) || !isCanonicalFrozenRef(query.requestReceiptRef) ||
      !nonEmpty(query.merchantSku) || query.merchantSku.length > 50 || !nonEmpty(query.supplierSkuId) ||
      task && !isPersistedNumericId(query.taskId) || product && !isPersistedNumericId(query.productId)) {
    throw new Error("OZON_DE_OBSERVATION_SCOPE_REJECTED");
  }
  assertNoProductionSecrets(query);
}

function normalizeInventoryObservation(response) {
  const withinLimit = Array.isArray(response?.products) && response.products.length <= EXACT_WAREHOUSE_READ_LIMIT;
  return { sourceProtocol: "ozon-product-stocks-by-warehouse-fbs-v2",
    hasNext: withinLimit && typeof response.has_next === "boolean" ? response.has_next : "unknown",
    rows: withinLimit ? response.products.map(row => ({ warehouseId: observedWarehouseId(row?.warehouse_id),
      productId: productIdOf(row) || "unknown", sku: observedWarehouseId(row?.sku),
      offerId: nonEmpty(row?.offer_id) ? row.offer_id : "unknown", freeStock: observedStockQuantity(row?.free_stock),
      present: observedStockQuantity(row?.present), reserved: observedStockQuantity(row?.reserved) })) : [] };
}

function normalizeImportObservation(response, query, capabilities) {
  const items = response?.result?.items;
  const item = Array.isArray(items) && items.length === 1 ? itemForOffer(items, query.merchantSku) : null;
  const productId = productIdOf(item) || null;
  const statuses = ["pending", "imported", "failed", "skipped"];
  const status = statuses.includes(item?.status) ? item.status : "unknown";
  let gapCode = null;
  if (!item) gapCode = "import_task_identity_unverified";
  else if (!Array.isArray(item.errors) || (Object.hasOwn(item, "product_id") && item.product_id !== 0 && !isExternalNumericId(item.product_id) ||
      Object.hasOwn(item, "id") && (!isExternalNumericId(item.id) || productId === null))) {
    gapCode = "import_task_response_invalid";
  } else if (status === "unknown") gapCode = "import_task_status_unknown";
  // 只有「拦路的」错误才判结果未知：imported 且全部为警告时照常按 imported 走，
  // 警告本身已逐条落进 importObservation.errors 并在视图显示，不会被吞掉。
  else if (status !== "failed" && blockingImportErrors(item.errors).length > 0) gapCode = "import_task_errors_present";
  else if (status === "imported" && productId === null) gapCode = "import_task_identity_unverified";
  const classification = gapCode ? "unknown_outcome" :
    ({ pending: "waiting_platform", imported: "imported", failed: "platform_failed", skipped: "platform_skipped" })[status];
  const importObservation = { kind: "import_result_observed", taskId: query.taskId, productId,
    merchantSku: item ? item.offer_id : null, itemCount: Array.isArray(items) ? items.length : null,
    status, errorCount: Array.isArray(item?.errors) ? item.errors.length : null,
    errors: observedImportErrors(item),
    requestReceiptRef: receipt("ozon-import-observation", { query, classification, productId, status,
      errorCount: Array.isArray(item?.errors) ? item.errors.length : null, evidenceRef: capabilities.productImport.evidenceRef }) };
  return freeze({ classification, gapCode, importObservation,
    inventoryPrerequisites: { priceSent: "unknown", reservedObservation: "not_queried" } });
}

/** Validate every saved single-SKU scope before composing one batch import payload. */
export function projectPreparedBatchImportRequests({ members, excludedOfferIds, adapterCapabilities, checkedAt }) {
  const inputs = members.map(member => {
    assertDExecutableRequest(member.request);
    assertCurrentDExecutionContext({ request: member.request, executionContext: member.executionContext });
    if (!sameStoreRef(member.request.storeRef, adapterCapabilities.storeRef) ||
        member.request.warehouseRef !== adapterCapabilities.warehouseRef ||
        member.request.credentialAlias !== adapterCapabilities.credentialAlias) throw new Error('OZON_BATCH_STORE_SCOPE_MISMATCH');
    const resolution = resolveFinalUploads({
      finalUploads: member.executionContext.productionPlan.sourceAuthorization.lockedScope.finalUploads,
      adapterCapabilities });
    const mediaFields = ['assetId', 'sha256', 'order', 'role', 'platformAcceptedUrl'];
    if (resolution.status !== 'ready' || resolution.resolvedAssets.length !== member.request.finalUploads.length ||
        resolution.resolvedAssets.some((asset, index) => mediaFields.some(field =>
          !isDeepStrictEqual(asset[field], member.request.finalUploads[index][field])))) {
      throw new Error('OZON_BATCH_ASSET_SCOPE_MISMATCH');
    }
    return { colorKey: member.colorKey, modelKey: member.modelKey,
      sourceTechnicalStatus: member.sourceTechnicalStatus,
      payload: projectProductionPlanImportPayload({ productionPlan: member.executionContext.productionPlan,
        resolvedFinalUploads: member.request.finalUploads }) };
  });
  return buildOzonSellerBatchImportRequests({ members: inputs, excludedOfferIds,
    productImportCapability: adapterCapabilities.productImport, checkedAt });
}

export function createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities, executionContext = null }) {
  if (typeof requestJson !== "function") throw new Error("OZON_DE_ADAPTER_TRANSPORT_REQUIRED: 缺少受控requestJson");
  if (!isObject(adapterCapabilities) || adapterCapabilities.status !== "ready" || adapterCapabilities.platform !== "ozon" ||
      adapterCapabilities.adapterVersion !== OZON_SELLER_API_DE_ADAPTER_VERSION || adapterCapabilities.protocolVersion !== "ozon-single-sku-d-e-v3" ||
      !nonEmpty(adapterCapabilities.store) || !nonEmpty(adapterCapabilities.evidenceRef) ||
      !isCompleteStoreRef(adapterCapabilities.storeRef, adapterCapabilities.store) || !isCanonicalFrozenRef(adapterCapabilities.warehouseRef) || !isCanonicalFrozenRef(adapterCapabilities.credentialAlias) ||
      !isPersistedNumericId(adapterCapabilities.warehouseId) || adapterCapabilities.inventoryWrite?.warehouseId !== adapterCapabilities.warehouseId) {
    throw new Error("OZON_DE_ADAPTER_CAPABILITIES_NOT_READY: 店铺隔离能力证据未就绪");
  }
  if (adapterCapabilities.inventoryWrite.prerequisitePolicy != null && !validPrerequisitePolicy(adapterCapabilities.inventoryWrite.prerequisitePolicy)) {
    throw new Error("OZON_DE_INVENTORY_POLICY_INVALID");
  }
  const capabilities = structuredClone(adapterCapabilities);

  async function call({ endpoint, body, write, executionKey }, options) {
    return requestJson(freeze({
      platform: "ozon",
      store: capabilities.store,
      storeRef: structuredClone(capabilities.storeRef), warehouseRef: capabilities.warehouseRef, credentialAlias: capabilities.credentialAlias,
      method: "POST",
      endpoint,
      body: structuredClone(body),
      write,
      executionKey: executionKey || null
    }), options);
  }

  return freeze({
    adapterVersion: OZON_SELLER_API_DE_ADAPTER_VERSION,
    store: capabilities.store,
    capabilities,

    async executeSellerApi(request, { persistCheckpoint, signal, beforeRequestSend } = {}) {
      assertObservationOptions(signal, beforeRequestSend);
      const invalid = validateExecutionRequest(request, capabilities);
      if (invalid) return knownPrewriteRejection(invalid);
      request = freeze(structuredClone(request));
      if (typeof persistCheckpoint !== "function") return knownPrewriteRejection("D_CHECKPOINT_REQUIRED: 缺少持久化检查点");
      try { assertCurrentDExecutionContext({ request, executionContext }); }
      catch (error) {
        const failure = productionExecutionPrewriteFailure(error);
        if (!failure) throw error;
        return knownPrewriteRejection(failure.code);
      }
      const resolution = resolveFinalUploads({ finalUploads: executionContext.productionPlan.sourceAuthorization.lockedScope.finalUploads,
        adapterCapabilities: capabilities });
      const mediaFields = ["assetId", "sha256", "order", "role", "platformAcceptedUrl"];
      if (resolution.status !== "ready" || resolution.resolvedAssets.some((asset, index) =>
        mediaFields.some(field => !isDeepStrictEqual(asset[field], request.finalUploads[index][field])))) {
        return knownPrewriteRejection("D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH");
      }
      const checkpoint = event => persistExecutionCheckpoint(persistCheckpoint, event);
      await checkpoint({ kind: "import_intent" });
      try { assertCurrentDExecutionContext({ request, executionContext }); }
      catch (error) {
        const failure = productionExecutionPrewriteFailure(error);
        if (!failure) throw error;
        return knownPrewriteRejection(failure.code);
      }
      let importResponse, runningImportGuard = false;
      try {
        importResponse = await call({
          endpoint: OZON_PRODUCT_IMPORT_ENDPOINT,
          body: request.productImport.body,
          write: true,
          executionKey: request.executionKey
        }, { signal, beforeRequestSend: async () => {
          runningImportGuard = true;
          assertCurrentDExecutionContext({ request, executionContext });
          if (beforeRequestSend) await beforeRequestSend();
          signal?.throwIfAborted();
          runningImportGuard = false;
        } });
      } catch (error) {
        if (runningImportGuard) throw error;
        rethrowProgrammingError(error);
        const prewriteCode = transportPrewriteCode(error);
        if (prewriteCode !== null) return knownPrewriteRejection(prewriteCode);
        return unknownOutcome("product_import_transport", "request_failed");
      }
      const observedTaskId = importResponse?.result?.task_id;
      if (!isExternalNumericId(observedTaskId)) return unknownOutcome("product_import_receipt", "task_id_missing");
      const taskId = String(observedTaskId);
      await checkpoint({ kind: "import_task_received", taskId });

      return freeze({ status: "waiting_platform", taskId, productId: null, offerId: request.merchantSku,
        requestReceiptRef: receipt("ozon-import-receipt", { taskId, executionKey: request.executionKey,
          storeRef: capabilities.storeRef, evidenceRef: capabilities.productImport.evidenceRef }),
        inventoryWriteState: "not_sent", retryAllowed: false });
    },

    async executeBatchImport({ batchId, members, excludedOfferIds, chunkIndex },
      { persistCheckpoint, signal, beforeRequestSend } = {}) {
      assertObservationOptions(signal, beforeRequestSend);
      if (!isCanonicalFrozenRef(batchId) || !Array.isArray(members) || members.length === 0 ||
          !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || typeof persistCheckpoint !== 'function') {
        throw new Error('OZON_BATCH_EXECUTION_INPUT_INVALID');
      }
      const project = checkedAt => projectPreparedBatchImportRequests({ members, excludedOfferIds,
        adapterCapabilities: capabilities, checkedAt });
      const requests = project(members[0].executionContext.serverClock());
      const batchRequest = requests[chunkIndex];
      if (!batchRequest) throw new Error('OZON_BATCH_CHUNK_NOT_FOUND');
      await persistCheckpoint({ kind: 'batch_import_intent', batchId, chunkIndex,
        offerIds: batchRequest.offerIds, limitEvidenceRef: batchRequest.limitEvidenceRef });
      let currentRequests;
      try { currentRequests = project(members[0].executionContext.serverClock()); }
      catch (error) {
        rethrowProgrammingError(error);
        const code = batchPrewriteCode(error);
        if (code !== null) return batchPrewriteRejection(code);
        throw error;
      }
      if (!isDeepStrictEqual(currentRequests[chunkIndex], batchRequest))
        return batchPrewriteRejection('OZON_BATCH_SCOPE_CHANGED_AFTER_INTENT');
      let response, runningGuard = false;
      try {
        response = await call({ endpoint: OZON_PRODUCT_IMPORT_ENDPOINT, body: batchRequest.body,
          write: true, executionKey: `${batchId}:${chunkIndex}` }, { signal, beforeRequestSend: async () => {
          runningGuard = true;
          const currentRequests = project(members[0].executionContext.serverClock());
          if (!isDeepStrictEqual(currentRequests[chunkIndex], batchRequest)) throw new Error('OZON_BATCH_SCOPE_CHANGED_BEFORE_SEND');
          if (beforeRequestSend) await beforeRequestSend();
          signal?.throwIfAborted();
          runningGuard = false;
        } });
      } catch (error) {
        if (runningGuard) {
          rethrowProgrammingError(error);
          const code = batchPrewriteCode(error);
          if (code !== null) return batchPrewriteRejection(code);
          throw error;
        }
        rethrowProgrammingError(error);
        const prewriteCode = transportPrewriteCode(error);
        if (prewriteCode !== null) return batchPrewriteRejection(prewriteCode);
        return unknownOutcome('product_batch_import_transport', 'request_failed',
          { batchId, chunkIndex, offerIds: batchRequest.offerIds });
      }
      const observedTaskId = response?.result?.task_id;
      if (!isExternalNumericId(observedTaskId)) return unknownOutcome('product_batch_import_receipt', 'task_id_missing',
        { batchId, chunkIndex, offerIds: batchRequest.offerIds });
      const taskId = String(observedTaskId);
      await persistCheckpoint({ kind: 'batch_import_task_received', batchId, chunkIndex,
        taskId, offerIds: batchRequest.offerIds });
      return freeze({ status: 'waiting_platform', batchId, chunkIndex, taskId,
        offerIds: batchRequest.offerIds, requestReceiptRef: receipt('ozon-batch-import-receipt',
          { batchId, chunkIndex, taskId, offerIds: batchRequest.offerIds }), retryAllowed: false });
    },

    async observeBatchImportTask({ batchId, chunkIndex, taskId, offerIds }, { signal, beforeRequestSend } = {}) {
      assertObservationOptions(signal, beforeRequestSend);
      if (!isCanonicalFrozenRef(batchId) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
          !isPersistedNumericId(taskId) || !Array.isArray(offerIds) || offerIds.length === 0 ||
          offerIds.some(offerId => !nonEmpty(offerId)) || new Set(offerIds).size !== offerIds.length) {
        throw new Error('OZON_BATCH_OBSERVATION_SCOPE_REJECTED');
      }
      const response = await call({ endpoint: OZON_PRODUCT_IMPORT_INFO_ENDPOINT,
        body: { task_id: Number(taskId) }, write: false, executionKey: `${batchId}:${chunkIndex}` },
      { signal, beforeRequestSend });
      signal?.throwIfAborted();
      const items = response?.result?.items;
      if (!Array.isArray(items)) throw new Error('OZON_BATCH_OBSERVATION_IDENTITY_UNVERIFIED');
      const hasExtraItem = items.some(item => !offerIds.includes(item?.offer_id));
      const results = offerIds.map(merchantSku => {
        const matches = items.filter(item => item.offer_id === merchantSku);
        const query = { batchId, chunkIndex, taskId, merchantSku };
        const observation = normalizeImportObservation({ result: { items: hasExtraItem ? [] : matches } }, query, capabilities);
        return { offerId: merchantSku, classification: observation.classification,
          gapCode: hasExtraItem ? 'batch_import_extra_offer' : observation.gapCode,
          importObservation: observation.importObservation };
      });
      return freeze({ batchId, chunkIndex, taskId, results });
    },

    async observeImportTask(query, { signal, beforeRequestSend } = {}) {
      assertObservationQuery(query, capabilities, { task: true });
      assertObservationOptions(signal, beforeRequestSend);
      query = freeze(structuredClone(query));
      signal?.throwIfAborted();
      const response = await call({ endpoint: OZON_PRODUCT_IMPORT_INFO_ENDPOINT,
        body: { task_id: Number(query.taskId) }, write: false, executionKey: query.executionKey }, { signal, beforeRequestSend });
      signal?.throwIfAborted();
      return normalizeImportObservation(response, query, capabilities);
    },

    async observePriceSent(query, { signal, beforeRequestSend } = {}) {
      assertObservationQuery(query, capabilities, { task: true, product: true });
      assertObservationOptions(signal, beforeRequestSend);
      const policy = capabilities.inventoryWrite.prerequisitePolicy;
      if (!validPrerequisitePolicy(policy)) throw new Error("OZON_DE_INVENTORY_POLICY_NOT_VERIFIED");
      if (!isCurrentInventoryPrerequisitePolicy(policy)) throw new Error("OZON_DE_INVENTORY_POLICY_OUTDATED");
      query = freeze(structuredClone(query));
      signal?.throwIfAborted();
      const response = await call({ endpoint: READBACK_ENDPOINTS.info, body: { offer_id: [query.merchantSku] },
        write: false, executionKey: query.executionKey }, { signal, beforeRequestSend });
      signal?.throwIfAborted();
      const item = Array.isArray(response?.items) && response.items.length === 1 ? itemForOffer(response.items, query.merchantSku) : null;
      const priceSent = item && productIdOf(item) === query.productId && Array.isArray(item.errors) && item.errors.length === 0 &&
        item.is_archived === false && item.is_autoarchived === false &&
        typeof item.statuses?.status === "string" && policy.priceSent.acceptedValues.includes(item.statuses.status) ? "verified" : "unknown";
      const scope = observationScope(query);
      return freeze({ scope, policy: structuredClone(policy), priceSent,
        requestReceiptRef: receipt("ozon-price-sent-observation", { scope, policy, priceSent }) });
    },

    async observeInventoryPrerequisites(query, { signal, beforeRequestSend } = {}) {
      assertObservationQuery(query, capabilities, { task: true, product: true });
      assertObservationOptions(signal, beforeRequestSend);
      query = freeze(structuredClone(query));
      signal?.throwIfAborted();
      const response = await call({ endpoint: READBACK_ENDPOINTS.stocks,
        body: { offer_id: [query.merchantSku], limit: EXACT_WAREHOUSE_READ_LIMIT, cursor: "" },
        write: false, executionKey: query.executionKey }, { signal, beforeRequestSend });
      signal?.throwIfAborted();
      const inventoryObservation = normalizeInventoryObservation(response);
      const matched = inventoryObservation.rows.every(row => row.productId === query.productId && row.offerId === query.merchantSku);
      const available = matched ? observedWarehouseAvailableStock(inventoryObservation, query.warehouseId,
        { productId: query.productId, offerId: query.merchantSku }) : "unknown";
      return freeze({ scope: observationScope(query), policy: structuredClone(capabilities.inventoryWrite.prerequisitePolicy ?? null),
        priceSent: "unknown", inventoryObservation,
        reservedObservation: available === "unknown" ? "unknown" : "observed",
        requestReceiptRef: receipt("ozon-inventory-prerequisites", { query, inventoryObservation,
          evidenceRef: capabilities.independentReadback.evidenceRef }) });
    },

    async executeRemainingInventory(request, { observation, persistCheckpoint, beforeRequestSend,
      assertRemainingInventoryAuthorization, signal } = {}) {
      const invalid = validateExecutionRequest(request, capabilities);
      if (invalid) return inventoryBlocked(invalid);
      assertObservationOptions(signal, beforeRequestSend);
      if (typeof persistCheckpoint !== "function" || typeof assertRemainingInventoryAuthorization !== "function") {
        return inventoryBlocked("inventory_continuation_authorization_required");
      }
      const policy = capabilities.inventoryWrite.prerequisitePolicy;
      if (!validPrerequisitePolicy(policy)) return inventoryBlocked("inventory_prerequisite_policy_not_verified");
      if (!isCurrentInventoryPrerequisitePolicy(policy)) return inventoryBlocked("inventory_prerequisite_policy_outdated");
      const price = observation?.priceSentObservation, stock = observation?.inventoryPrerequisiteObservation;
      if (!closed(observation, ["priceSentObservation", "inventoryPrerequisiteObservation"]) ||
          !closed(price, ["scope", "policy", "priceSent", "requestReceiptRef"]) ||
          !closed(stock, ["scope", "policy", "priceSent", "inventoryObservation", "reservedObservation", "requestReceiptRef"]) ||
          !isDeepStrictEqual(price.scope, stock.scope) || !isDeepStrictEqual(price.policy, policy) || !isDeepStrictEqual(stock.policy, policy) ||
          price.priceSent !== "verified" || stock.priceSent !== "unknown" || stock.reservedObservation !== "observed" ||
          !isCanonicalFrozenRef(price.requestReceiptRef) || !isCanonicalFrozenRef(stock.requestReceiptRef)) {
        return inventoryBlocked("inventory_prerequisites_not_verified");
      }
      const scope = freeze(structuredClone(price.scope));
      assertObservationQuery({ ...scope, writeAllowed: false }, capabilities, { task: true, product: true });
      if (["platform", "store", "storeRef", "warehouseRef", "credentialAlias", "merchantSku", "supplierSkuId", "executionKey"]
        .some(key => !isDeepStrictEqual(scope[key], request[key])) ||
          !Array.isArray(stock.inventoryObservation?.rows) ||
          !stock.inventoryObservation.rows.every(row => row.productId === scope.productId && row.offerId === scope.merchantSku) ||
          observedWarehouseAvailableStock(stock.inventoryObservation, scope.warehouseId,
            { productId: scope.productId, offerId: scope.merchantSku }) === "unknown") {
        return inventoryBlocked("inventory_prerequisites_not_verified");
      }
      request = freeze(structuredClone(request)); observation = freeze(structuredClone(observation));
      signal?.throwIfAborted();
      assertCurrentDExecutionContext({ request, executionContext });
      await assertRemainingInventoryAuthorization();
      const checkpoint = event => persistExecutionCheckpoint(persistCheckpoint, event);
      await checkpoint({ kind: "stock_intent", taskId: scope.taskId, productId: scope.productId,
        merchantSku: scope.merchantSku, warehouseId: scope.warehouseId, stock: request.stock });
      const row = { [policy.stockRequest.identityField]: policy.stockRequest.identityField === "offer_id" ? scope.merchantSku : Number(scope.productId),
        stock: request.stock, warehouse_id: Number(scope.warehouseId) };
      let runningGuard = false, response;
      try {
        response = await call({ endpoint: OZON_INVENTORY_WRITE_ENDPOINT, body: { stocks: [row] }, write: true,
          executionKey: request.executionKey }, { signal, beforeRequestSend: async () => {
          runningGuard = true;
          assertCurrentDExecutionContext({ request, executionContext });
          await assertRemainingInventoryAuthorization();
          if (beforeRequestSend) await beforeRequestSend();
          signal?.throwIfAborted();
          runningGuard = false;
        } });
      } catch (error) {
        if (runningGuard) throw error;
        rethrowProgrammingError(error);
        const code = transportPrewriteCode(error);
        if (code !== null) return inventoryBlocked(code);
        if (!(error instanceof OzonDEHttpTransportError)) throw error;
        return unknownOutcome("inventory_write_transport", "request_failed", { taskId: scope.taskId, productId: scope.productId,
          requestReceiptRef: scope.requestReceiptRef });
      }
      const items = response?.result, item = itemForOffer(items, scope.merchantSku);
      const inventoryObservation = { kind: "stock_receipt_observed", taskId: scope.taskId, productId: productIdOf(item) || null,
        merchantSku: item ? item.offer_id : null, warehouseId: observedWarehouseId(item?.warehouse_id) === "unknown" ? null : String(item.warehouse_id),
        updated: typeof item?.updated === "boolean" ? item.updated : null, itemCount: Array.isArray(items) ? items.length : null,
        errorCount: Array.isArray(item?.errors) ? item.errors.length : null,
        inventoryReceiptRef: receipt("ozon-inventory-receipt", { item, policy, scope }) };
      await checkpoint(inventoryObservation);
      if (!item || items.length !== 1 || inventoryObservation.productId !== scope.productId || inventoryObservation.warehouseId !== scope.warehouseId ||
          inventoryObservation.updated !== true || inventoryObservation.errorCount !== 0) {
        return unknownOutcome("inventory_write_receipt", "inventory_receipt_incomplete_or_identity_mismatch",
          { taskId: scope.taskId, productId: scope.productId, inventoryObservation });
      }
      return freeze({ status: "accepted", taskId: scope.taskId, productId: scope.productId, offerId: scope.merchantSku,
        requestReceiptRef: scope.requestReceiptRef, inventoryReceiptRef: inventoryObservation.inventoryReceiptRef, retryAllowed: false });
    },

    async readbackSellerApi(query, { signal } = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("OZON_DE_READBACK_SIGNAL_INVALID: 取消信号必须是AbortSignal");
      }
      const store = normalizeStore(query?.store);
      const offerId = String(query?.merchantSku || "");
      const supplierSkuId = String(query?.supplierSkuId || "");
      const expectedProductId = query?.platformProductId;
      if (query?.platform !== "ozon" || store !== capabilities.store || query?.writeAllowed !== false ||
          !sameStoreRef(query.storeRef, capabilities.storeRef) || query.warehouseRef !== capabilities.warehouseRef || query.credentialAlias !== capabilities.credentialAlias ||
          query.warehouseId !== capabilities.inventoryWrite.warehouseId || !isPersistedNumericId(query.warehouseId) ||
          !nonEmpty(offerId) || !nonEmpty(supplierSkuId) || !isPersistedNumericId(expectedProductId)) {
        throw new Error("OZON_DE_READBACK_SCOPE_REJECTED: 店铺或商品身份未锁定");
      }
      const requests = [
        ["attributes", READBACK_ENDPOINTS.attributes, { filter: { offer_id: [offerId], visibility: "ALL" }, limit: 10, sort_dir: "ASC" }],
        ["info", READBACK_ENDPOINTS.info, { offer_id: [offerId] }],
        ["prices", READBACK_ENDPOINTS.prices, { cursor: "", filter: { offer_id: [offerId], visibility: "ALL" }, limit: 10 }],
        ["stocks", READBACK_ENDPOINTS.stocks, { offer_id: [offerId], limit: EXACT_WAREHOUSE_READ_LIMIT, cursor: "" }]
      ];
      const responses = {};
      const matchedItems = {};
      for (const [name, endpoint, body] of requests) {
        signal?.throwIfAborted();
        responses[name] = await call({ endpoint, body, write: false }, { signal });
        signal?.throwIfAborted();
        if (name === "stocks") continue;
        const items = name === "attributes" ? responses[name]?.result : responses[name]?.items;
        matchedItems[name] = readbackItemForOffer(items, offerId, name);
        if (matchedItems[name] && productIdOf(matchedItems[name]) !== expectedProductId) {
          throw new Error(`OZON_DE_READBACK_IDENTITY_MISMATCH: ${name}`);
        }
      }
      const { info: infoItem, prices: priceItem } = matchedItems;
      const currentPrice = priceOf(priceItem);
      const stockResponse = responses.stocks;
      const inventoryObservation = normalizeInventoryObservation(stockResponse);
      const scopeMatches = inventoryObservation.rows.every(row => row.productId === expectedProductId && row.offerId === offerId);
      const currentStock = scopeMatches ? observedWarehouseAvailableStock(inventoryObservation, query.warehouseId, { productId: expectedProductId, offerId }) : "unknown";
      if (!currentPrice) throw new Error("OZON_DE_READBACK_PRICE_INVALID: 未取得CNY当前价格");
      // info/list has unambiguous string-array media fields. Preserve its returned list;
      // neither CDN identity nor correspondence to the submitted order is inferred here.
      const mediaObservation = { sourceProtocol: "ozon-product-info-v3",
        primaryImageUrl: Array.isArray(infoItem.primary_image) && infoItem.primary_image.length === 1 &&
          isObservedHttpsMediaUrl(infoItem.primary_image[0]) ? infoItem.primary_image[0] : "unknown",
        images: Array.isArray(infoItem.images) && infoItem.images.every(isObservedHttpsMediaUrl) ? structuredClone(infoItem.images) : "unknown" };
      const images = observedMediaSequence(mediaObservation);
      const errors = observedErrors(infoItem);
      const observation = {
        platform: "ozon",
        store: capabilities.store,
        storeRef: structuredClone(capabilities.storeRef), warehouseRef: capabilities.warehouseRef, credentialAlias: capabilities.credentialAlias,
        skuPackageId: String(query.skuPackageId || ""),
        supplierSkuId,
        merchantSku: offerId,
        platformProductId: expectedProductId,
        currentPrice,
        currentStock,
        imageCount: images ? images.length : "unknown",
        mediaObservation,
        inventoryObservation,
        moderationStatus: nonEmpty(infoItem.statuses?.moderate_status) ? infoItem.statuses.moderate_status : "unknown",
        validationStatus: nonEmpty(infoItem.statuses?.validation_status) ? infoItem.statuses.validation_status : "unknown",
        saleStatus: saleStatus(infoItem),
        errors,
        platformEvidenceRef: receipt("ozon-independent-readback", {
          store: capabilities.store,
          offerId,
          expectedProductId,
          currentPrice,
          currentStock,
          mediaObservation,
          inventoryObservation,
          warehouseId: query.warehouseId,
          statuses: infoItem.statuses,
          errors,
          evidenceRef: capabilities.independentReadback.evidenceRef
        })
      };
      return freeze(observation);
    }
  });
}

export const OZON_DE_READBACK_ENDPOINTS = READBACK_ENDPOINTS;
