import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { platformOfStore, storesOfPlatform } from "./store-registry.mjs";
import { DEFAULT_GUOO_TARIFF_PATH, guooTariffRuleVersionFromPath } from "./guoo-tariff-reader.mjs";
import { validateSalesSnapshot } from "./sales-snapshot.mjs";

export const LIFECYCLE_B_EVIDENCE_CONTEXT_VERSION = "lifecycle-b-evidence-context-v1.1";

const UNKNOWN = "unknown";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function known(value) {
  return value !== null && value !== undefined && String(value).trim() && String(value).trim().toLowerCase() !== UNKNOWN;
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function newestCategorySnapshot(candidate) {
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .filter((snapshot) => validateSalesSnapshot(snapshot).valid)
    .filter((snapshot) => snapshot.collectorMode === "real_page_read_only")
    .filter((snapshot) => known(snapshot.categoryPath))
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0] || null;
}

function submittedWeight(submission) {
  const value = Number(submission?.supplierConfirmation?.weightKg);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function candidateWeight(candidate) {
  const value = Number(candidate?.packedWeightKg);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function categorySelector(snapshot) {
  const attributes = isObject(snapshot?.attributes) ? snapshot.attributes : {};
  const descriptionCategoryId = Number(attributes.description_category_id ?? attributes.descriptionCategoryId);
  const typeId = Number(attributes.type_id ?? attributes.typeId);
  if (Number.isInteger(descriptionCategoryId) && descriptionCategoryId > 0 && Number.isInteger(typeId) && typeId > 0) {
    return `ozon:${descriptionCategoryId}:${typeId}`;
  }
  const typeValue = Object.entries(attributes).find(([key, value]) =>
    ["тип", "type", "商品类型"].includes(normalized(key)) && known(value)
  )?.[1];
  const path = String(snapshot?.categoryPath || "").trim();
  if (!known(typeValue)) return path;
  const normalizedParts = path.split(/\s*(?:>|\/|→)\s*/u).map(normalized).filter(Boolean);
  return normalizedParts.includes(normalized(typeValue)) ? path : `${path} > ${String(typeValue).trim()}`;
}

function mergeMissing(explicit, defaults) {
  const result = { ...structuredClone(explicit || {}) };
  for (const [key, value] of Object.entries(defaults)) {
    if (!known(result[key]) && known(value)) result[key] = value;
  }
  return result;
}

/**
 * 由服务端锁定B阶段技术证据范围。这里只补系统事实，不替换候选中已经明确保存的值。
 * 当前生产范围只支持Ozon RFBS和GUOO Economy Small；WB与超出轻小件范围的商品会明确停止。
 */
export function applyLifecycleBEvidenceContext(candidate, {
  submission = null,
  guooFilePath = DEFAULT_GUOO_TARIFF_PATH,
  route = "GUOO Economy Small"
} = {}) {
  if (!isObject(candidate) || !known(candidate.id) || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("B_EVIDENCE_CONTEXT_INVALID_CANDIDATE: 候选身份或修订号无效");
  }
  const before = JSON.stringify(candidate);
  const platform = platformOfStore(candidate.targetStore) ?? "ozon";
  if (platform !== "ozon") {
    throw new Error("B_EVIDENCE_CONTEXT_PLATFORM_UNSUPPORTED: 当前阶段尚未接入WB系统证据范围");
  }
  const store = normalized(candidate.targetStore);
  if (!store || !storesOfPlatform("ozon").includes(store)) {
    throw new Error("B_EVIDENCE_CONTEXT_STORE_UNSUPPORTED: 目标Ozon店铺未配置");
  }
  const categorySnapshot = newestCategorySnapshot(candidate);
  const explicit = isObject(candidate.lifecycleEvidenceContextV11)
    ? candidate.lifecycleEvidenceContextV11
    : {};
  const weightKg = submittedWeight(submission) || candidateWeight(candidate);
  if (!(weightKg > 0)) {
    throw new Error("B_EVIDENCE_CONTEXT_PACKAGING_REQUIRED: 尚未确认实际打包重量，不能选择物流线路");
  }
  if (route === "GUOO Economy Small" && weightKg > 2) {
    throw new Error("B_EVIDENCE_CONTEXT_ROUTE_UNRESOLVED: 当前重量超过GUOO Economy Small的2kg范围，系统尚未锁定其他线路");
  }
  if (!isCompleteStoreRef(candidate.storeRef, candidate.targetStore)) throw new Error("B_EVIDENCE_CONTEXT_STORE_IDENTITY_MISSING");
  if (explicit.storeRef !== undefined && !sameStoreRef(explicit.storeRef, candidate.storeRef)) throw new Error("B_EVIDENCE_CONTEXT_CONFLICT: 已保存店铺身份与候选映射不一致");
  const context = mergeMissing(explicit, {
    platform,
    store,
    storeRef: structuredClone(candidate.storeRef),
    category: categorySnapshot ? categorySelector(categorySnapshot) : null,
    salesScheme: "rfbs",
    route,
    logisticsRuleVersion: guooTariffRuleVersionFromPath(guooFilePath),
    exchangePair: "RUB/CNY",
    schemaRuleVersion: "ozon-current"
  });
  if (known(explicit.logisticsRuleVersion) && explicit.logisticsRuleVersion !== guooTariffRuleVersionFromPath(guooFilePath)) {
    throw new Error("B_EVIDENCE_CONTEXT_TARIFF_VERSION_CONFLICT: 历史资费范围不能用于新版本测算，须保留历史并建立新的评审修订");
  }
  if (known(explicit.route) && explicit.route !== route) {
    throw new Error("B_EVIDENCE_CONTEXT_ROUTE_CONFLICT: 已有线路与本轮比较结果不同，不能原地覆盖历史范围");
  }
  const required = [
    ["category", "当前类目"],
    ["salesScheme", "销售模式"],
    ["route", "物流线路"],
    ["logisticsRuleVersion", "物流资费版本"],
    ["exchangePair", "汇率币种对"],
    ["schemaRuleVersion", "Schema版本"]
  ];
  const missing = required.filter(([key]) => !known(context[key])).map(([, label]) => label);
  if (missing.length) {
    throw new Error(`B_EVIDENCE_CONTEXT_INCOMPLETE: ${missing.join("、")}`);
  }
  if (known(explicit.platform) && normalized(explicit.platform) !== platform) {
    throw new Error("B_EVIDENCE_CONTEXT_CONFLICT: 已保存平台与目标平台不一致");
  }
  if (known(explicit.store) && normalized(explicit.store) !== store) {
    throw new Error("B_EVIDENCE_CONTEXT_CONFLICT: 已保存店铺与目标店铺不一致");
  }
  const prepared = {
    ...structuredClone(candidate),
    lifecycleEvidenceContextV11: context
  };
  if (JSON.stringify(candidate) !== before) throw new Error("B_EVIDENCE_CONTEXT_INPUT_MUTATED");
  return Object.freeze({
    contextVersion: LIFECYCLE_B_EVIDENCE_CONTEXT_VERSION,
    candidate: prepared,
    context: structuredClone(context),
    sources: Object.freeze({
      platform: "candidate_target",
      store: "candidate_target",
      category: known(explicit.category) ? "explicit_context" : `sales_snapshot:${categorySnapshot.snapshotId}:category_and_type`,
      salesScheme: known(explicit.salesScheme) ? "explicit_context" : "server_policy:ozon_rfbs",
      route: known(explicit.route) ? "explicit_context" : route === "GUOO Economy Small"
        ? "server_policy:guoo_economy_small_upto_2kg" : "resolved_route_comparison",
      logisticsRuleVersion: known(explicit.logisticsRuleVersion) ? "explicit_context" : "current_guoo_filename",
      exchangePair: known(explicit.exchangePair) ? "explicit_context" : "server_policy:rub_cny",
      schemaRuleVersion: known(explicit.schemaRuleVersion) ? "explicit_context" : "server_policy:ozon_current"
    }),
    ownerActionRequired: false,
    platformWrites: 0
  });
}
