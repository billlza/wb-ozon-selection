import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { isOzonProductionConnectionRequirements } from "./ozon-production-strategy.mjs";
export const PLATFORM_WRITE_PREFLIGHT_VERSION = "platform-write-preflight-v1.2";
export const LEGACY_PLATFORM_WRITE_PREFLIGHT_VERSION = "platform-write-preflight-v1.1";
const PERMISSION_STATUSES = new Set(["verified", "denied", "permission_required", "unknown"]);
const CONNECTION_STATUSES = new Set(["connected", "unavailable", "system_error", "permission_required", "unknown"]);
const IMAGE_PERMISSION_STATUSES = new Set(["verified", "denied", "permission_required", "unknown"]);
const TECHNICAL_STATUSES = new Set(["completed", "system_error", "permission_required", "data_unavailable"]);
/** The anchors a store identity may stand on. Optional on a record: an absent value reads as "platform_store_id",
 * the original rule, so results written before owner decision 2026-09-16 keep validating unchanged. */
export const STORE_IDENTITY_PATHS = new Set(["platform_store_id", "scoped_warehouse", "none"]);
/** Of those names, the two that can hold an identity at all. 'none' names the absence of an anchor, and a name
 * nobody recognizes is not an anchor either, so neither can ever hold one — whatever is filed beside it. */
const ANCHORING_STORE_IDENTITY_PATHS = new Set(["platform_store_id", "scoped_warehouse"]);

/**
 * 单独导出，是为了让"根本没有锚点可站"和"站上去了但对不上"能分开说，它们该有不同的下场：
 * 前者在最早能判断的那道门就砍掉，而且真要落成结论时诚实的词是"未核验"，不是"核过了两边不一致"。
 */
export function canStoreIdentityPathAnchor(via) {
  return ANCHORING_STORE_IDENTITY_PATHS.has(via ?? "platform_store_id");
}

/**
 * 全仓唯一一处回答"这个身份结论到底站在哪条锚上、锚住了没有"。前检、前检合同、适配器能力检查、
 * 草稿写入前检和 D/E 收口全部调这里，避免同一判断出现第二种写法。
 * 能锚住的只有两条路：
 * 'platform_store_id'（缺失值按它读，旧记录不回归）按原规则比对观察到的店铺引用；
 * 'scoped_warehouse'（主人2026-09-16决定）站在"这把钥匙能读到该仓"加上主人亲自核对的仓库归属上；
 * Ozon 不发布店铺编号，所以这条锚只在 observedStoreRef 保持 null 时成立——旁边再挂一个店铺引用
 * 是伪造，不是更强的证据。
 * 'none' 的字面意思就是没有锚点，所以永远不算锚住：Ozon 从不返回店铺编号，一条 'none' 记录旁边
 * 那个"对得上的"observedStoreRef 只可能是人手填进去的，认它就等于给伪造开了门。认不出来的锚点名
 * 同理——叫不出名字的锚不是锚。
 */
export function isStoreIdentityAnchored({ via, observedStoreRef, expectedStoreRef }) {
  const path = via ?? "platform_store_id";
  if (!canStoreIdentityPathAnchor(path)) return false;
  if (path === "scoped_warehouse") return observedStoreRef === null;
  return sameStoreRef(expectedStoreRef, observedStoreRef);
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

function push(errors, path, message) {
  errors.push({ path, message });
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function validateConnection(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是对象");
    return;
  }
  if (!CONNECTION_STATUSES.has(value.status)) push(errors, `${path}.status`, "连接状态无效");
  if (!nonEmptyString(value.checkedVia)) push(errors, `${path}.checkedVia`, "必须说明检查路径");
  if (!nonEmptyString(value.evidenceRef)) push(errors, `${path}.evidenceRef`, "必须保存证据引用");
}

export function platformWritePreflightTechnicalStatus(inspection, requiredConnections) {
  const statuses = requiredConnections.map(name => inspection.connections[name].status);
  if (inspection.permissionStatus === "permission_required" || inspection.imagePermissionStatus === "permission_required" || statuses.includes("permission_required")) return "permission_required";
  if (statuses.includes("system_error") || statuses.includes("unavailable")) return "system_error";
  if (statuses.includes("unknown") || inspection.permissionStatus === "unknown" || inspection.storeIdentityStatus === "unverified") return "data_unavailable";
  return "completed";
}

export function validatePlatformWritePreflight(preflight) {
  const errors = [];
  if (!isObject(preflight)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (![PLATFORM_WRITE_PREFLIGHT_VERSION, LEGACY_PLATFORM_WRITE_PREFLIGHT_VERSION].includes(preflight.schemaVersion)) push(errors, "schemaVersion", "前检版本无效");
  if (preflight.schemaVersion === PLATFORM_WRITE_PREFLIGHT_VERSION &&
      (preflight.targetPlatform !== "ozon" || !isOzonProductionConnectionRequirements(preflight.connectionRequirements))) {
    push(errors, "connectionRequirements", "必须保存当前正式API路线及完整连接合同");
  }
  if (preflight.schemaVersion === LEGACY_PLATFORM_WRITE_PREFLIGHT_VERSION && Object.hasOwn(preflight, "connectionRequirements")) {
    push(errors, "connectionRequirements", "旧版前检不得附加新路线解释");
  }
  for (const field of ["preflightId", "sourceProductionPlanId", "sourceProductionPlanFingerprint", "targetPlatform", "checkedAt"]) {
    if (!nonEmptyString(preflight[field])) push(errors, field, "必须是非空字符串");
  }
  if (!isoDateTime(preflight.checkedAt)) push(errors, "checkedAt", "必须是有效时间");
  if (!isObject(preflight.storeIdentity) || !nonEmptyString(preflight.storeIdentity.expectedStore) || !nonEmptyString(preflight.storeIdentity.observedStore) || !["matched", "mismatched", "unverified"].includes(preflight.storeIdentity.status) || !nonEmptyString(preflight.storeIdentity.evidenceRef)) {
    push(errors, "storeIdentity", "必须保存预期店铺、观察店铺、匹配状态和证据");
  }
  const identity = preflight.storeIdentity;
  if (!isCompleteStoreRef(identity?.expectedStoreRef, identity?.expectedStore) ||
      !(identity.observedStoreRef === null || isCompleteStoreRef(identity.observedStoreRef, identity.observedStore))) push(errors, "storeIdentity", "必须保存完整预期店铺引用和已观察引用或明确未验证");
  // 'scoped_warehouse' asserts the platform publishes no store number; a record carrying one alongside it is
  // internally inconsistent, so verifiedVia stays a trustworthy statement of where the conclusion came from.
  if (Object.hasOwn(identity ?? {}, "verifiedVia") && (!STORE_IDENTITY_PATHS.has(identity.verifiedVia) ||
      (identity.verifiedVia === "scoped_warehouse" && identity.observedStoreRef !== null))) push(errors, "storeIdentity.verifiedVia", "店铺身份证据路径无效");
  // 'matched' still needs an anchor, but there are now two of them: the observed store ref, or the scoped warehouse
  // (owner decision 2026-09-16) which by construction carries no observed store ref. A bare claim anchors on neither.
  if (identity?.status === "matched" && (identity.expectedStore !== identity.observedStore ||
      !isStoreIdentityAnchored({ via: identity.verifiedVia, observedStoreRef: identity.observedStoreRef, expectedStoreRef: identity.expectedStoreRef }))) {
    push(errors, "storeIdentity.status", "同名店铺不能替代完整店铺身份匹配");
  }
  if (!isObject(preflight.permission) || !PERMISSION_STATUSES.has(preflight.permission.status) || !nonEmptyString(preflight.permission.evidenceRef)) {
    push(errors, "permission", "必须保存权限状态和证据");
  }
  if (!isObject(preflight.connectionStatus)) {
    push(errors, "connectionStatus", "必须是对象");
  } else {
    validateConnection(preflight.connectionStatus.api, "connectionStatus.api", errors);
    validateConnection(preflight.connectionStatus.sellerBackend, "connectionStatus.sellerBackend", errors);
  }
  if (!stringArray(preflight.authorizedWriteFields) || preflight.authorizedWriteFields.length === 0) push(errors, "authorizedWriteFields", "必须继承生产计划授权字段");
  if (!stringArray(preflight.platformWritableFields)) push(errors, "platformWritableFields", "必须是字符串数组");
  if (!stringArray(preflight.effectiveWritableFields)) push(errors, "effectiveWritableFields", "必须是字符串数组");
  if (stringArray(preflight.effectiveWritableFields) && stringArray(preflight.authorizedWriteFields) && preflight.effectiveWritableFields.some((field) => !preflight.authorizedWriteFields.includes(field))) {
    push(errors, "effectiveWritableFields", "不得超出生产计划授权字段");
  }
  if (stringArray(preflight.effectiveWritableFields) && stringArray(preflight.platformWritableFields) && preflight.effectiveWritableFields.some((field) => !preflight.platformWritableFields.includes(field))) {
    push(errors, "effectiveWritableFields", "不得超出平台现场可写字段");
  }
  if (!isObject(preflight.imagePermission) || !IMAGE_PERMISSION_STATUSES.has(preflight.imagePermission.status) || !nonEmptyString(preflight.imagePermission.evidenceRef)) {
    push(errors, "imagePermission", "必须保存图片权限状态和证据");
  }
  if (!isObject(preflight.priceCurrency) || !nonEmptyString(preflight.priceCurrency.expected) || !nonEmptyString(preflight.priceCurrency.observed) || !["matched", "mismatched", "unverified"].includes(preflight.priceCurrency.status) || !nonEmptyString(preflight.priceCurrency.evidenceRef)) {
    push(errors, "priceCurrency", "必须保存平台价格字段币种核验");
  }
  if (!Array.isArray(preflight.risks) || preflight.risks.some((risk) => !isObject(risk) || !nonEmptyString(risk.code) || !nonEmptyString(risk.message))) {
    push(errors, "risks", "风险必须是带代码和说明的数组");
  }
  if (!TECHNICAL_STATUSES.has(preflight.technicalStatus)) push(errors, "technicalStatus", "技术状态无效");
  if (preflight.schemaVersion === PLATFORM_WRITE_PREFLIGHT_VERSION && errors.length === 0 &&
      preflight.technicalStatus !== platformWritePreflightTechnicalStatus({ connections: preflight.connectionStatus,
        permissionStatus: preflight.permission.status, imagePermissionStatus: preflight.imagePermission.status,
        storeIdentityStatus: preflight.storeIdentity.status }, preflight.connectionRequirements.requiredConnections)) {
    push(errors, "technicalStatus", "技术状态必须来自当前路线实际必需连接与检查结果");
  }
  if (preflight.businessStateEffect !== "none") push(errors, "businessStateEffect", "技术检查不得影响商品业务状态");
  if (preflight.readyForPlatformWrite !== false) push(errors, "readyForPlatformWrite", "第13B-1阶段不得进入真实写入");
  if (preflight.productCreated !== false) push(errors, "productCreated", "不得创建商品");
  if (preflight.imagesUploaded !== 0) push(errors, "imagesUploaded", "不得上传图片");
  if (preflight.inventoryModified !== false) push(errors, "inventoryModified", "不得修改库存");
  if (preflight.storeDataModified !== false) push(errors, "storeDataModified", "不得修改店铺数据");
  if (preflight.productionRecordCreated !== false) push(errors, "productionRecordCreated", "不得生成生产记录");
  if (preflight.platformWrites !== 0) push(errors, "platformWrites", "不得产生平台写入");
  return { valid: errors.length === 0, errors };
}

export function assertValidPlatformWritePreflight(preflight) {
  const result = validatePlatformWritePreflight(preflight);
  if (!result.valid) throw new Error(`PlatformWritePreflight校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return preflight;
}

/** Historical records remain readable, but cannot authorize a current execution. */
export function assertCurrentPlatformWritePreflight(preflight) {
  assertValidPlatformWritePreflight(preflight);
  if (preflight.schemaVersion !== PLATFORM_WRITE_PREFLIGHT_VERSION) throw new Error("PLATFORM_PREFLIGHT_VERSION_OUTDATED: 当前执行需要新版前检");
  return preflight;
}
