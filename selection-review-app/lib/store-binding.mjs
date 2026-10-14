import { storePlatformMap } from "./store-registry.mjs";

// 店铺属于哪个平台，统一从 store-registry 查。
export const STORE_PLATFORMS = Object.freeze(storePlatformMap());
const REF_FIELDS = Object.freeze(["stableStoreId", "platformStoreId", "mappingVersion"]);
const PLACEHOLDERS = new Set(["unknown", "null", "undefined", "not_applicable", "missing"]);

function exactObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function isCompleteStoreRef(value, targetStore) {
  return exactObject(value, REF_FIELDS) && value.stableStoreId === targetStore &&
    REF_FIELDS.every(field => typeof value[field] === "string" && value[field].trim() === value[field] &&
      value[field].length > 0 && value[field].length <= 200 && !/[\u0000-\u0020\u007f]/.test(value[field]) &&
      !PLACEHOLDERS.has(value[field].toLowerCase()));
}

export function sameStoreRef(left, right) {
  return isCompleteStoreRef(left, left?.stableStoreId) && isCompleteStoreRef(right, right?.stableStoreId) &&
    REF_FIELDS.every(field => left[field] === right[field]);
}

export function resolveConfiguredStoreRef(bindings, targetStore) {
  if (!Object.hasOwn(STORE_PLATFORMS, targetStore)) throw new Error("STORE_BINDING_INVALID: 未知内部店铺键");
  const binding = bindings.find(item => item.targetStore === targetStore);
  return binding ? structuredClone(binding.storeRef) : null;
}

export function assertCandidateStoreBinding(candidate, bindings) {
  const configured = resolveConfiguredStoreRef(bindings, candidate.targetStore);
  if (!configured || !sameStoreRef(candidate.storeRef, configured)) {
    throw Object.assign(new Error("店铺身份未配置或保存的映射已变化；请配置店铺身份后明确保存店铺选择"), {
      status: 409, extra: { code: "candidate_store_binding_unavailable" }
    });
  }
}
