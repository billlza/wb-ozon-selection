import { inspectLifecycleEvidenceValidity, isLifecycleEvidenceValidityMetadataValid } from "./lifecycle-evidence-validity.mjs";
import { resolveLifecycleBCostPolicy } from "./global-pricing-policy.mjs";
import { GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS } from "./guoo-tariff-reader.mjs";
import { isDeepStrictEqual } from "node:util";
import { buildExpectedEvidenceScope, evidenceScopeMatches, normalizeEvidenceScope } from "./lifecycle-evidence-scope.mjs";
import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { platformOfStore } from "./store-registry.mjs";
import { validateSalesSnapshot } from "./sales-snapshot.mjs";

export const LIFECYCLE_B_INPUT_BUNDLE_VERSION = "lifecycle-b-input-bundle-v1.2-cost-policy";
const LEGACY_B_INPUT_BUNDLE_VERSION = "lifecycle-b-input-bundle-v1.1";

const REQUIRED_KINDS = Object.freeze([
  "commission",
  "logistics_tariff",
  "exchange_rate",
  "schema"
]);

// Preserve only platform Schema content. Runtime identity and observation times
// are derived from the scope-checked evidence pack, never from its payload.
/**
 * 冻结进 C1 计划的 Schema 内容字段。**导出是为了让刷新那条路复用同一份清单**——
 * 两处各写一遍，早晚会漂：漏一个字段，刷新之后计划里就少一块内容，而且没人会报错。
 */
export const C1_SCHEMA_CONTENT_FIELDS = Object.freeze([
  "categoryId", "categoryName", "descriptionCategoryId", "typeId", "writeBindings",
  "categoryRestrictions", "platformCompliance",
  // 类目的**全部**属性（含非必填）与字典号。requiredFields 只留必填，47 个属性到这里只剩 4 个，
  // 商品详情页因此填不满，字典属性也拿不到 dictionaryValueId。2026-09-17 由证据服务补出这一份。
  "attributes"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
}

function finite(value) {
  return Number.isFinite(value);
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function latestCategorySnapshot(candidate) {
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .filter((snapshot) => validateSalesSnapshot(snapshot).valid)
    .filter((snapshot) => snapshot.collectorMode === "real_page_read_only")
    .filter((snapshot) => nonEmptyString(snapshot?.categoryPath))
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0] || null;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundWeight(value) {
  return Number(value.toFixed(6));
}

function ceilToStep(value, step) {
  return roundWeight(Math.ceil((value - Number.EPSILON) / step) * step);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function error(path, message) {
  return { path, message };
}

function validateNonNegative(data, fields, errors) {
  for (const field of fields) {
    if (!finite(data[field]) || data[field] < 0) errors.push(error(field, "必须是非负数字"));
  }
}

function validateRate(data, field, errors) {
  if (!finite(data[field]) || data[field] < 0 || data[field] >= 1) {
    errors.push(error(field, "必须是0到1之间的数字"));
  }
}

// Historical unbound estimates remain readable, but never qualify for new input.
export function isCommissionEstimateAuthorizationForScope(value, { candidateId, candidateRevision, commissionRate }) {
  const keys = ["schemaVersion", "candidateId", "candidateRevision", "authorizationRef", "commissionRate"];
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    value.schemaVersion === "commission-estimate-authorization-v1" &&
    nonEmptyString(value.candidateId) && value.candidateId === candidateId &&
    Number.isSafeInteger(value.candidateRevision) && value.candidateRevision >= 1 && value.candidateRevision === candidateRevision &&
    nonEmptyString(value.authorizationRef) &&
    finite(value.commissionRate) && value.commissionRate >= 0 && value.commissionRate < 1 && value.commissionRate === commissionRate;
}

/**
 * 官方费表费率按本SKU已冻结成交价所在价格档取得，价格档不属于可复用的证据范围，
 * 所以命中行必须绑定取数时的候选、修订和成交价，别的SKU或改价后的修订都不能复用。
 */
export function isOfficialCommissionBindingForCandidate(value, { candidateId, candidateRevision }) {
  const keys = ["schemaVersion", "candidateId", "candidateRevision", "priceRub"];
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    value.schemaVersion === "ozon-official-commission-binding-v1" &&
    nonEmptyString(value.candidateId) && value.candidateId === candidateId &&
    Number.isSafeInteger(value.candidateRevision) && value.candidateRevision >= 1 && value.candidateRevision === candidateRevision &&
    finite(value.priceRub) && value.priceRub > 0;
}

/** Complete per-SKU costs supplied at freeze time, independently of reusable commission evidence. */
export function validateLifecycleBOtherCosts(otherCosts) {
  const errors = [];
  if (!isObject(otherCosts)) return { valid: false, errors: [error("otherCosts", "必须明确列出其他成本")] };
  validateNonNegative(otherCosts, ["packagingRmb", "labelRmb", "fixedOtherRmb", "minimumUnitProfitRmb"], errors);
  for (const field of ["advertisingRate", "returnReserveRate", "damageReserveRate", "withdrawalFeeRate", "targetMarginRate"]) {
    validateRate(otherCosts, field, errors);
  }
  if (!finite(otherCosts.priceIncrementCny) || otherCosts.priceIncrementCny <= 0) errors.push(error("priceIncrementCny", "必须是大于0的数字"));
  if (otherCosts.thresholdLogic !== "any") errors.push(error("thresholdLogic", "当前项目必须使用any"));
  if (!nonEmptyString(otherCosts.pricingPolicyVersion)) errors.push(error("pricingPolicyVersion", "必须保存定价政策版本"));
  return { valid: errors.length === 0, errors };
}

export function validateLifecycleEvidenceData(kind, evidenceData) {
  const errors = [];
  if (!isObject(evidenceData)) {
    return { valid: false, errors: [error("evidenceData", "必须是结构化对象")] };
  }
  if (kind === "commission") {
    if (!COMMISSION_EVIDENCE_MODES.includes(evidenceData.commissionEvidenceMode)) {
      errors.push(error("commissionEvidenceMode", "必须明确为exact、estimated或official_reference"));
    }
    if (!finite(evidenceData.commissionRate) || evidenceData.commissionRate < 0 || evidenceData.commissionRate >= 1) {
      errors.push(error("commissionRate", "必须是0到1之间的数字"));
    }
    // 官方费表命中的是一条已存版本的费率行：必须是正数费率，绑定本SKU，且不得同时冒充主人授权估算。
    if (evidenceData.commissionEvidenceMode === "official_reference") {
      if (!finite(evidenceData.commissionRate) || evidenceData.commissionRate <= 0 || evidenceData.commissionRate >= 1 ||
          evidenceData.estimateAuthorized === true || Object.hasOwn(evidenceData, "commissionEstimateAuthorization")) {
        errors.push(error("commissionEvidenceMode", "官方费表佣金必须是0到1之间的正数且不得携带估算授权"));
      }
      if (!isOfficialCommissionBindingForCandidate(evidenceData.officialCommissionBinding, {
        candidateId: evidenceData.officialCommissionBinding?.candidateId,
        candidateRevision: evidenceData.officialCommissionBinding?.candidateRevision
      })) errors.push(error("officialCommissionBinding", "官方费表费率必须绑定取数时的候选、修订与成交价"));
    } else if (Object.hasOwn(evidenceData, "officialCommissionBinding")) {
      errors.push(error("officialCommissionBinding", "只有官方费表证据才能携带费表绑定"));
    }
    if (Object.hasOwn(evidenceData, "commissionEstimateAuthorization") &&
        (evidenceData.commissionEvidenceMode !== "estimated" || !isCommissionEstimateAuthorizationForScope(evidenceData.commissionEstimateAuthorization, {
          candidateId: evidenceData.commissionEstimateAuthorization?.candidateId,
          candidateRevision: evidenceData.commissionEstimateAuthorization?.candidateRevision,
          commissionRate: evidenceData.commissionRate
        }))) errors.push(error("commissionEstimateAuthorization", "估算授权绑定无效"));
    if (Object.hasOwn(evidenceData, "otherCosts")) {
      errors.push(...validateLifecycleBOtherCosts(evidenceData.otherCosts).errors);
    }
  } else if (kind === "exchange_rate") {
    if (!finite(evidenceData.rubPerCny) || evidenceData.rubPerCny <= 0) {
      errors.push(error("rubPerCny", "必须是大于0的数字"));
    }
  } else if (kind === "schema") {
    if (!nonEmptyString(evidenceData.schemaRevision)) errors.push(error("schemaRevision", "必须是已确认版本"));
    if (!Array.isArray(evidenceData.requiredFields)) {
      errors.push(error("requiredFields", "必须是数组"));
    } else {
      const seen = new Set();
      evidenceData.requiredFields.forEach((field, index) => {
        if (!isObject(field)) {
          errors.push(error(`requiredFields[${index}]`, "必须是对象"));
          return;
        }
        if (!nonEmptyString(field.fieldKey)) errors.push(error(`requiredFields[${index}].fieldKey`, "必须是非空字符串"));
        if (!nonEmptyString(field.label)) errors.push(error(`requiredFields[${index}].label`, "必须是非空字符串"));
        if (field.required !== true) errors.push(error(`requiredFields[${index}].required`, "这里只保存平台必填字段"));
        if (field.sourceAttributeKeys !== undefined && (
          !Array.isArray(field.sourceAttributeKeys) || field.sourceAttributeKeys.some((key) => !nonEmptyString(key))
        )) errors.push(error(`requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组"));
        if (seen.has(field.fieldKey)) errors.push(error(`requiredFields[${index}].fieldKey`, "字段不得重复"));
        seen.add(field.fieldKey);
      });
    }
    // attributes 是 2026-09-17 新增的可选字段：老证据没有它，新证据给了就必须成形，
    // 不能让半成品一路溜到上架那一步才炸。
    if (Object.hasOwn(evidenceData, "attributes")) {
      if (!Array.isArray(evidenceData.attributes)) {
        errors.push(error("attributes", "必须是数组"));
      } else {
        const seenAttribute = new Set();
        evidenceData.attributes.forEach((attribute, index) => {
          if (!isObject(attribute)) {
            errors.push(error(`attributes[${index}]`, "必须是对象"));
            return;
          }
          if (!nonEmptyString(attribute.fieldKey)) errors.push(error(`attributes[${index}].fieldKey`, "必须是非空字符串"));
          if (!nonEmptyString(attribute.label)) errors.push(error(`attributes[${index}].label`, "必须是非空字符串"));
          if (typeof attribute.required !== "boolean") errors.push(error(`attributes[${index}].required`, "必须是布尔值"));
          if (!Number.isInteger(attribute.dictionaryId) || attribute.dictionaryId < 0) {
            errors.push(error(`attributes[${index}].dictionaryId`, "必须是非负整数，0表示无字典"));
          }
          if (seenAttribute.has(attribute.fieldKey)) errors.push(error(`attributes[${index}].fieldKey`, "属性不得重复"));
          seenAttribute.add(attribute.fieldKey);
        });
      }
    }
  } else if (kind === "logistics_tariff") {
    // 已经存下来的旧读取结果仍然带着这个状态：它的计费默认值是推定的，不是从报价公式核对来的。
    if (evidenceData.calculationRuleStatus === "legacy_unverified") {
      errors.push(error("calculationRuleStatus", "这份计费默认值是推定的、没有核对过报价公式，不能进入新正式计算"));
    }
    if (!["actual_weight", "max_actual_volume"].includes(evidenceData.chargeableWeightRule)) {
      errors.push(error("chargeableWeightRule", "必须明确为actual_weight或max_actual_volume"));
    }
    validateNonNegative(evidenceData, ["perKgRmb", "perParcelRmb", "minimumChargeableWeightKg"], errors);
    const roundingRule = evidenceData.weightRoundingRule ||
      (finite(evidenceData.weightRoundingKg) && evidenceData.weightRoundingKg > 0 ? "step" : null);
    if (roundingRule === "none") {
      if (evidenceData.weightRoundingKg !== null) errors.push(error("weightRoundingKg", "不取整时必须为null"));
    } else if (roundingRule === "step") {
      if (!finite(evidenceData.weightRoundingKg) || evidenceData.weightRoundingKg <= 0) {
        errors.push(error("weightRoundingKg", "按步长取整时必须是大于0的数字"));
      }
    } else {
      errors.push(error("weightRoundingRule", "必须明确为none或step"));
    }
    if (evidenceData.chargeableWeightRule === "max_actual_volume" &&
        (!finite(evidenceData.volumeDivisorCm3PerKg) || evidenceData.volumeDivisorCm3PerKg <= 0)) {
      errors.push(error("volumeDivisorCm3PerKg", "体积重规则必须明确大于0的除数"));
    }
  } else {
    errors.push(error("kind", "该类型不属于B阶段系统证据"));
  }
  return { valid: errors.length === 0, errors };
}

export function resolveLifecycleEvidenceContext(candidate) {
  if (!isObject(candidate)) {
    return deepFreeze({ ready: false, values: null, fields: [], missing: ["候选商品身份"] });
  }
  const context = isObject(candidate?.lifecycleEvidenceContextV11)
    ? candidate.lifecycleEvidenceContextV11
    : {};
  const platform = platformOfStore(candidate.targetStore) ?? "ozon";
  const explicitPlatform = nonEmptyString(context.platform) ? normalizedText(context.platform) : null;
  const explicitStore = nonEmptyString(context.store) ? normalizedText(context.store) : null;
  const targetStore = nonEmptyString(candidate.targetStore) ? normalizedText(candidate.targetStore) : null;
  const snapshot = latestCategorySnapshot(candidate);
  const explicitCategory = nonEmptyString(context.category) ? context.category : null;
  const definitions = [
    ["platform", "目标平台", platform, "candidate_target"],
    ["store", "目标店铺", candidate.targetStore, "candidate_target"],
    ["category", "当前类目", explicitCategory || snapshot?.categoryPath, explicitCategory ? "explicit_context" : snapshot ? `sales_snapshot:${snapshot.snapshotId}` : "missing"],
    ["salesScheme", "销售模式", context.salesScheme, nonEmptyString(context.salesScheme) ? "explicit_context" : "missing"],
    ["route", "物流线路", context.route, nonEmptyString(context.route) ? "explicit_context" : "missing"],
    ["logisticsRuleVersion", "物流资费版本", context.logisticsRuleVersion, nonEmptyString(context.logisticsRuleVersion) ? "explicit_context" : "missing"],
    ["exchangePair", "汇率币种对", context.exchangePair, nonEmptyString(context.exchangePair) ? "explicit_context" : "missing"],
    ["schemaRuleVersion", "Schema版本", context.schemaRuleVersion, nonEmptyString(context.schemaRuleVersion) ? "explicit_context" : "missing"]
  ];
  const fields = definitions.map(([key, label, value, source]) => ({
    key,
    label,
    value: nonEmptyString(value) ? String(value).trim() : null,
    normalizedValue: nonEmptyString(value) ? normalizedText(value) : null,
    source,
    status: nonEmptyString(value) ? "available" : "missing"
  }));
  const storeRef = candidate.storeRef ? structuredClone(candidate.storeRef) : null;
  fields.push({ key: "storeRef", label: "完整店铺身份", value: storeRef, normalizedValue: storeRef, source: "candidate_saved_mapping", status: isCompleteStoreRef(candidate.storeRef, candidate.targetStore) ? "available" : "missing" });
  const conflicts = new Set();
  if (context.storeRef !== undefined && !sameStoreRef(context.storeRef, candidate.storeRef)) conflicts.add("storeRef");
  if (explicitPlatform && explicitPlatform !== platform) conflicts.add("platform");
  if (explicitStore && explicitStore !== targetStore) conflicts.add("store");
  if (conflicts.size) {
    const conflictFields = fields.map((field) => conflicts.has(field.key)
      ? { ...field, status: "conflict", source: "explicit_context_conflict" }
      : field);
    return deepFreeze({
      ready: false,
      values: null,
      fields: conflictFields,
      missing: [...conflicts].map((key) => key === "platform" ? "目标平台适用范围冲突" : "目标店铺适用范围冲突")
    });
  }
  const values = Object.fromEntries(fields.map((field) => [field.key, field.normalizedValue]));
  const missing = fields.filter((field) => field.status === "missing").map((field) => field.label);
  return deepFreeze({
    ready: missing.length === 0,
    values: missing.length === 0 ? values : null,
    fields,
    missing
  });
}

function candidateContext(candidate) {
  const resolved = resolveLifecycleEvidenceContext(candidate);
  return resolved.ready ? resolved.values : null;
}

const WB_COMMISSION_SOURCE = "wb_official_commission_reference";
const OZON_OFFICIAL_COMMISSION_SOURCE = "ozon_official_commission_table";
export const COMMISSION_EVIDENCE_MODES = Object.freeze(["exact", "estimated", "official_reference"]);
const OZON_COMMISSION_PRICE_TIERS = Object.freeze(["le1500", "1500_5000", "gt5000"]);
const catalogText = value => nonEmptyString(value) && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const closedCatalog = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function normalizeCurrentCommissionCatalogs(records) {
  if (!Array.isArray(records) || records.length > 100) throw new Error("CURRENT_COMMISSION_CATALOGS_INVALID");
  const keys = new Set();
  return deepFreeze(records.map(record => {
    if (!closedCatalog(record, ["platform", "sellerRegion", "catalogId", "catalogVersion", "status"]) ||
        record.platform !== "wb" || record.sellerRegion !== "CN" || !catalogText(record.catalogId) ||
        !catalogText(record.catalogVersion) || !["active", "invalidated"].includes(record.status)) {
      throw new Error("CURRENT_COMMISSION_CATALOGS_INVALID");
    }
    const key = JSON.stringify([record.platform, record.sellerRegion, record.catalogId]);
    if (keys.has(key)) throw new Error("CURRENT_COMMISSION_CATALOGS_AMBIGUOUS");
    keys.add(key);
    return structuredClone(record);
  }));
}

function validCommissionCatalogRef(pack) {
  const ref = pack.commissionCatalogRef;
  return closedCatalog(ref, ["catalogId", "catalogVersion", "sellerRegion", "subjectId", "sourceField", "sourceReceiptRef", "effectiveFrom"]) &&
    ["catalogId", "catalogVersion", "sourceReceiptRef"].every(key => catalogText(ref[key])) &&
    ref.sellerRegion === "CN" && ref.sourceField === "kgvpChina" && Number.isSafeInteger(ref.subjectId) && ref.subjectId > 0 &&
    (ref.effectiveFrom === null || isoDateTime(ref.effectiveFrom)) && pack.scope?.platform === "wb" &&
    pack.scope.category === `wb:subject:${ref.subjectId}`;
}

/** Ozon官方佣金表命中行的版本引用：内容哈希、生效日期、来源地址、价格档和已匹配的类型名称缺一不可。 */
function validOzonCommissionCatalogRef(pack) {
  const ref = pack.commissionCatalogRef;
  return closedCatalog(ref, ["effectiveFrom", "fileSha256", "sourceUrl", "priceTier", "matchedRow"]) &&
    catalogText(ref.sourceUrl) && typeof ref.fileSha256 === "string" && /^[0-9a-f]{64}$/i.test(ref.fileSha256) &&
    typeof ref.effectiveFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ref.effectiveFrom) &&
    isoDateTime(`${ref.effectiveFrom}T00:00:00.000Z`) && OZON_COMMISSION_PRICE_TIERS.includes(ref.priceTier) &&
    closedCatalog(ref.matchedRow, ["typeRu", "typeZh", "mpCategoryZh"]) &&
    ["typeRu", "typeZh", "mpCategoryZh"].every(key => catalogText(ref.matchedRow[key])) &&
    pack.scope?.platform === "ozon";
}

export function isLifecycleEvidenceTraceValid(pack) {
  const base = nonEmptyString(pack?.id) && nonEmptyString(pack?.sourceType) && nonEmptyString(pack?.sourceRef) && isoDateTime(pack?.checkedAt);
  if (!base || !isLifecycleEvidenceValidityMetadataValid(pack)) return false;
  if (Object.hasOwn(pack, "commissionCatalogRef") && ![WB_COMMISSION_SOURCE, OZON_OFFICIAL_COMMISSION_SOURCE].includes(pack.sourceType)) return false;
  if (pack.sourceType === OZON_OFFICIAL_COMMISSION_SOURCE &&
      (pack.kind !== "commission" || !Object.hasOwn(pack, "commissionCatalogRef") || !validOzonCommissionCatalogRef(pack) ||
       pack.evidenceData?.commissionEvidenceMode !== "official_reference" ||
       !validateLifecycleEvidenceData("commission", pack.evidenceData).valid)) return false;
  if (pack.sourceType === WB_COMMISSION_SOURCE) {
    if (pack.kind !== "commission" || !validCommissionCatalogRef(pack) || pack.evidenceData?.commissionEvidenceMode !== "exact" ||
        !validateLifecycleEvidenceData("commission", pack.evidenceData).valid) return false;
    if (pack.expiresAt === null) return true;
  }
  return isoDateTime(pack.expiresAt) && Date.parse(pack.expiresAt) > Date.parse(pack.checkedAt);
}

export function inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs = [], asOf }) {
  const catalogs = normalizeCurrentCommissionCatalogs(currentCommissionCatalogs);
  const result = (status, message) => ({ available: ["not_applicable", "current"].includes(status), status, message });
  if (pack?.kind !== "commission" || pack.scope?.platform !== "wb") return result("not_applicable", "非WB佣金目录证据");
  if (!Object.hasOwn(pack, "commissionCatalogRef")) return result("missing_ref", "旧WB佣金证据缺少目录版本引用，不能用于新计算");
  if (pack.sourceType !== WB_COMMISSION_SOURCE || !validCommissionCatalogRef(pack) || !isLifecycleEvidenceTraceValid(pack) ||
      pack.status !== "active" || !isoDateTime(asOf)) return result("invalid", "WB佣金来源、目录引用或正式证据字段无效");
  const ref = pack.commissionCatalogRef;
  const declaration = catalogs.find(value => value.catalogId === ref.catalogId && value.sellerRegion === ref.sellerRegion);
  if (!declaration) return result("missing", "当前WB佣金目录版本尚未声明");
  if (declaration.status === "invalidated") return result("invalidated", "当前WB佣金目录已失效，不能复用");
  if (declaration.catalogVersion !== ref.catalogVersion) return result("version_mismatch", "WB佣金证据不属于当前采用的目录版本");
  if (Date.parse(pack.checkedAt) > Date.parse(asOf) || ref.effectiveFrom !== null && Date.parse(ref.effectiveFrom) > Date.parse(asOf))
    return result("not_effective", "WB佣金证据尚未取得或尚未生效");
  if (pack.expiresAt !== null && Date.parse(pack.expiresAt) <= Date.parse(asOf)) return result("expired", "WB佣金证据已超过明确有效期");
  return result("current", "WB佣金目录版本与适用证据已匹配；未知期限未补造");
}

function packCurrent(pack, asOfMs) {
  return isLifecycleEvidenceTraceValid(pack) && inspectLifecycleEvidenceValidity(pack, { asOf: asOfMs }).usable;
}

function eligiblePack(pack, kind, context, asOfMs, candidate, currentCommissionCatalogs) {
  if (pack?.kind !== kind || !packCurrent(pack, asOfMs)) return false;
  if (!inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs, asOf: new Date(asOfMs).toISOString() }).available) return false;
  // A stored GUOO reading whose billing rules were never checked against the row's own quote
  // cells inferred its defaults. Preserve those records, but never reuse one as a verified
  // input for a new formal calculation; only a reading that carries the checked stamp counts.
  if (kind === "logistics_tariff" && pack.sourceType === "guoo_current_tariff_xlsx" &&
      pack.evidenceData?.calculationRuleStatus !== GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS) return false;
  // 官方费表按本SKU成交价档取值，价格档不属于可复用的证据范围：只有绑定本候选本修订的命中行可用。
  if (kind === "commission" && pack.evidenceData?.commissionEvidenceMode === "official_reference" &&
      !isOfficialCommissionBindingForCandidate(pack.evidenceData.officialCommissionBinding, {
        candidateId: candidate.id, candidateRevision: candidate.dataRevision
      })) return false;
  if (!validateLifecycleEvidenceData(kind, pack.evidenceData).valid) return false;
  if (kind === "commission" && pack.evidenceData.commissionEvidenceMode === "estimated" &&
      !isCommissionEstimateAuthorizationForScope(pack.evidenceData.commissionEstimateAuthorization, {
        candidateId: candidate.id, candidateRevision: candidate.dataRevision, commissionRate: pack.evidenceData.commissionRate
      })) return false;
  return evidenceScopeMatches(kind, pack.scope, buildExpectedEvidenceScope(kind, context));
}

/**
 * 同时有几份合格佣金证据时谁说了算：平台实收的精确费率 > 官方费表命中的费率 > 主人授权的估算。
 * 按证据强度排，不按新旧——不然一份刚授权的估算会把一份能形成正式B的官方费表费率挤掉，
 * 把已经成立的正式B降级成条件测算。同一强度之内才比取得时间。
 */
const COMMISSION_EVIDENCE_STRENGTH = Object.freeze({ exact: 0, official_reference: 1, estimated: 2 });
const commissionStrength = (pack) => COMMISSION_EVIDENCE_STRENGTH[pack.evidenceData.commissionEvidenceMode] ?? 3;

function latestPack(packs, kind, context, asOfMs, candidate, currentCommissionCatalogs) {
  return packs
    .filter((pack) => eligiblePack(pack, kind, context, asOfMs, candidate, currentCommissionCatalogs))
    .sort((left, right) => {
      if (kind === "commission" && commissionStrength(left) !== commissionStrength(right)) {
        return commissionStrength(left) - commissionStrength(right);
      }
      return Date.parse(right.checkedAt) - Date.parse(left.checkedAt);
    })[0] || null;
}

export function inspectLifecycleBInputReadiness({ candidate, evidencePacks = [], asOf, currentCommissionCatalogs = [] }) {
  const catalogs = normalizeCurrentCommissionCatalogs(currentCommissionCatalogs);
  const checkedAt = isoDateTime(asOf) ? asOf : new Date().toISOString();
  const contextResolution = resolveLifecycleEvidenceContext(candidate);
  const context = contextResolution.ready ? contextResolution.values : null;
  const labels = {
    commission: "当前平台佣金与其他成本证据",
    logistics_tariff: "当前国际物流资费规则",
    exchange_rate: "当前汇率证据",
    schema: "当前平台Schema证据"
  };
  if (!context) {
    return deepFreeze({
      ready: false,
      contextReady: false,
      context: contextResolution,
      fields: REQUIRED_KINDS.map((kind) => ({
        key: kind,
        label: labels[kind],
        available: false,
        status: "waiting_context",
        evidencePackId: null,
        checkedAt: null,
        expiresAt: null,
        message: "先补齐上方证据适用范围"
      })),
      missing: contextResolution.missing.map((label) => `适用范围：${label}`),
      ownerMustProvide: false,
      checkedAt
    });
  }
  const fields = REQUIRED_KINDS.map((kind) => {
    const pack = latestPack(evidencePacks, kind, context, Date.parse(checkedAt), candidate, catalogs);
    if (pack) return {
      key: kind,
      label: labels[kind],
      available: true,
      status: inspectLifecycleEvidenceValidity(pack, { asOf: checkedAt }).status,
      evidencePackId: pack.id,
      checkedAt: pack.checkedAt,
      expiresAt: pack.expiresAt,
      sourceType: pack.sourceType,
      sourceRef: pack.sourceRef,
      scope: structuredClone(pack.scope),
      message: inspectLifecycleEvidenceValidity(pack, { asOf: checkedAt }).reason
    };
    const sameKind = evidencePacks
      .filter((item) => item?.kind === kind && item.status === "active")
      .sort((left, right) => Date.parse(right.checkedAt || 0) - Date.parse(left.checkedAt || 0));
    const exact = sameKind.find((item) => evidenceScopeMatches(kind, item.scope, buildExpectedEvidenceScope(kind, context)));
    let status = "missing";
    let message = "没有找到该类证据";
    const catalogValidity = exact ? inspectCommissionCatalogValidity({ pack: exact, currentCommissionCatalogs: catalogs, asOf: checkedAt }) : null;
    if (catalogValidity && !catalogValidity.available) {
      status = catalogValidity.status;
      message = catalogValidity.message;
    } else if (exact && kind === "logistics_tariff" && exact.sourceType === "guoo_current_tariff_xlsx" &&
        exact.evidenceData?.calculationRuleStatus !== GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS) {
      status = "legacy_unverified";
      message = "这份国欧读取结果的计费规则没有逐格核对过报价公式，不能用于新正式测算；需要按当前资费表重新读取一次";
    } else if (exact && !isObject(exact.evidenceData)) {
      status = "metadata_only";
      message = "只有摘要，没有可计算的结构化数据";
    } else if (exact && !isLifecycleEvidenceTraceValid(exact)) {
      status = "invalid";
      message = "证据来源或有效期不完整";
    } else if (exact && !inspectLifecycleEvidenceValidity(exact, { asOf: checkedAt }).usable) {
      status = inspectLifecycleEvidenceValidity(exact, { asOf: checkedAt }).status;
      message = inspectLifecycleEvidenceValidity(exact, { asOf: checkedAt }).reason;
    } else if (exact && !validateLifecycleEvidenceData(kind, exact.evidenceData).valid) {
      status = "invalid";
      message = "结构化证据字段不完整或无效";
    } else if (sameKind.length) {
      status = "scope_mismatch";
      message = "存在同类证据，但平台、店铺、类目、模式、线路或版本不匹配";
    }
    return {
      key: kind,
      label: labels[kind],
      available: false,
      status,
      evidencePackId: exact?.id || null,
      checkedAt: exact?.checkedAt || null,
      expiresAt: exact?.expiresAt || null,
      scope: exact?.scope ? structuredClone(exact.scope) : null,
      message
    };
  });
  return deepFreeze({
    ready: fields.every((field) => field.available),
    contextReady: true,
    context: contextResolution,
    fields,
    missing: fields.filter((field) => !field.available).map((field) => field.label),
    ownerMustProvide: false,
    checkedAt
  });
}

function requirePackaging(normalizedSubmission) {
  const supplier = normalizedSubmission?.supplierConfirmation;
  const dimensions = supplier?.dimensionsCm;
  if (!isObject(supplier) || !finite(supplier.weightKg) || supplier.weightKg <= 0 ||
      !isObject(dimensions) || [dimensions.length, dimensions.width, dimensions.height].some((value) => !finite(value) || value <= 0)) {
    throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 缺少已确认的重量或尺寸，不能计算国际运费");
  }
  return {
    weightKg: supplier.weightKg,
    dimensionsCm: {
      length: dimensions.length,
      width: dimensions.width,
      height: dimensions.height
    }
  };
}

export function calculateFreight(pack, packaging) {
  const tariff = pack.evidenceData;
  const volumeWeightKg = tariff.chargeableWeightRule === "max_actual_volume"
    ? roundWeight(
      packaging.dimensionsCm.length * packaging.dimensionsCm.width * packaging.dimensionsCm.height /
      tariff.volumeDivisorCm3PerKg
    )
    : null;
  const baseWeight = tariff.chargeableWeightRule === "max_actual_volume"
    ? Math.max(packaging.weightKg, volumeWeightKg, tariff.minimumChargeableWeightKg)
    : Math.max(packaging.weightKg, tariff.minimumChargeableWeightKg);
  const chargeableWeightKg = tariff.weightRoundingRule === "none"
    ? roundWeight(baseWeight)
    : ceilToStep(baseWeight, tariff.weightRoundingKg);
  return {
    evidenceId: pack.id,
    route: pack.scope.route,
    ruleVersion: pack.scope.ruleVersion,
    actualWeightKg: packaging.weightKg,
    volumeWeightKg,
    chargeableWeightKg,
    amountRmb: roundMoney(chargeableWeightKg * tariff.perKgRmb + tariff.perParcelRmb),
    formula: "chargeableWeightKg × perKgRmb + perParcelRmb",
    tariff: structuredClone(tariff)
  };
}

export function createLifecycleBInputBundle({ candidate, evidencePacks = [], normalizedSubmission, otherCosts, createdAt, currentCommissionCatalogs = [] }) {
  const catalogs = normalizeCurrentCommissionCatalogs(currentCommissionCatalogs);
  if (!isObject(candidate) || !candidate.id || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 候选身份或修订号无效");
  }
  if (!isoDateTime(createdAt)) throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 证据冻结时间无效");
  const readiness = inspectLifecycleBInputReadiness({ candidate, evidencePacks, asOf: createdAt, currentCommissionCatalogs: catalogs });
  if (!readiness.ready) throw new Error(`REAL_A_SYSTEM_EVIDENCE_GAP: ${readiness.missing.join("、")}`);
  const context = candidateContext(candidate);
  const packs = Object.fromEntries(REQUIRED_KINDS.map((kind) => [
    kind,
    latestPack(evidencePacks, kind, context, Date.parse(createdAt), candidate, catalogs)
  ]));
  const costValidation = validateLifecycleBOtherCosts(otherCosts);
  if (!costValidation.valid) throw new Error(`REAL_A_SYSTEM_EVIDENCE_GAP: ${costValidation.errors.map(item => `${item.path} ${item.message}`).join("；")}`);
  if (otherCosts.packagingRmb !== candidate.packagingCostRmb) throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 包材成本与当前候选不一致");
  const costPolicyContext = Object.fromEntries(["platform", "store", "storeRef", "salesScheme"].map(key => [key, structuredClone(context[key])]));
  const resolvedCosts = resolveLifecycleBCostPolicy({ snapshot: otherCosts.costPolicySnapshot, context: costPolicyContext, asOf: createdAt });
  if (Object.entries(resolvedCosts).some(([key, value]) => !["policyId", "policyVersion"].includes(key) && otherCosts[key] !== value) ||
      otherCosts.pricingPolicyVersion !== resolvedCosts.policyVersion) throw new Error("B_COST_POLICY_VALUES_MISMATCH");
  const { costPolicySnapshot, ...numericCosts } = otherCosts;
  const packaging = requirePackaging(normalizedSubmission);
  const bundle = {
    bundleVersion: LIFECYCLE_B_INPUT_BUNDLE_VERSION,
    bundleId: `b-input-bundle:${candidate.id}:${candidate.dataRevision}`,
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: candidate.dataRevision,
    createdAt,
    context: structuredClone(context),
    packagingSnapshot: packaging,
    sourcePackIds: REQUIRED_KINDS.map((kind) => packs[kind].id),
    platformFeeEvidence: {
      evidenceId: packs.commission.id,
      ...(packs.commission.commissionCatalogRef ? { commissionCatalogRef: structuredClone(packs.commission.commissionCatalogRef) } : {}),
      commissionRate: packs.commission.evidenceData.commissionRate,
      ...(packs.commission.evidenceData.commissionEvidenceMode === "estimated" ? {
        commissionEstimateAuthorization: structuredClone(packs.commission.evidenceData.commissionEstimateAuthorization)
      } : {}),
      ...(packs.commission.evidenceData.commissionEvidenceMode === "official_reference" ? {
        officialCommissionBinding: structuredClone(packs.commission.evidenceData.officialCommissionBinding)
      } : {}),
      commissionEvidenceMode: packs.commission.evidenceData.commissionEvidenceMode,
      estimateAuthorized: packs.commission.evidenceData.estimateAuthorized === true,
      exactCommissionRequiredAtC: packs.commission.evidenceData.exactCommissionRequiredAtC === true,
      otherCosts: structuredClone(numericCosts),
      costPolicySnapshot: structuredClone(costPolicySnapshot),
      costPolicyContext
    },
    logisticsEvidence: calculateFreight(packs.logistics_tariff, packaging),
    exchangeRateEvidence: {
      evidenceId: packs.exchange_rate.id,
      rubPerCny: packs.exchange_rate.evidenceData.rubPerCny
    },
    platformSchemaEvidence: {
      ...Object.fromEntries(C1_SCHEMA_CONTENT_FIELDS.filter(field => Object.hasOwn(packs.schema.evidenceData, field))
        .map(field => [field, structuredClone(packs.schema.evidenceData[field])])),
      evidenceId: packs.schema.id,
      platform: context.platform,
      store: context.store,
      storeRef: structuredClone(context.storeRef),
      ruleVersion: packs.schema.scope.ruleVersion,
      schemaRevision: packs.schema.evidenceData.schemaRevision,
      collectedAt: packs.schema.checkedAt,
      requiredFields: structuredClone(packs.schema.evidenceData.requiredFields)
    },
    browserSupplied: false,
    externalAccesses: []
  };
  assertValidLifecycleBInputBundle(bundle, { candidate, normalizedSubmission });
  return deepFreeze(bundle);
}

export function validateLifecycleBInputBundle(bundle, { candidate, normalizedSubmission } = {}) {
  const errors = [];
  if (!isObject(bundle)) return { valid: false, errors: [error("$", "必须是对象")] };
  if (![LIFECYCLE_B_INPUT_BUNDLE_VERSION, LEGACY_B_INPUT_BUNDLE_VERSION].includes(bundle.bundleVersion)) errors.push(error("bundleVersion", "版本不正确"));
  if (!nonEmptyString(bundle.bundleId)) errors.push(error("bundleId", "必须存在"));
  if (!isoDateTime(bundle.createdAt)) errors.push(error("createdAt", "必须是有效时间"));
  if (!Array.isArray(bundle.sourcePackIds) || bundle.sourcePackIds.length !== 4 || new Set(bundle.sourcePackIds).size !== 4) {
    errors.push(error("sourcePackIds", "必须唯一引用四类证据包"));
  }
  if (bundle.browserSupplied !== false) errors.push(error("browserSupplied", "系统证据不得来自浏览器提交"));
  if (!Array.isArray(bundle.externalAccesses) || bundle.externalAccesses.length !== 0) errors.push(error("externalAccesses", "B冻结阶段不得访问外部平台"));
  for (const field of ["platformFeeEvidence", "logisticsEvidence", "exchangeRateEvidence", "platformSchemaEvidence", "packagingSnapshot", "context"]) {
    if (!isObject(bundle[field])) errors.push(error(field, "必须是对象"));
  }
  if (!nonEmptyString(bundle.sourceCandidateId) || !Number.isSafeInteger(bundle.sourceCandidateRevision) || bundle.sourceCandidateRevision < 1) errors.push(error("sourceCandidateId", "必须保存候选身份与冻结修订"));
  if (!isCompleteStoreRef(bundle.context?.storeRef, bundle.context?.store) || !sameStoreRef(bundle.context?.storeRef, bundle.platformSchemaEvidence?.storeRef) ||
      bundle.context?.platform !== bundle.platformSchemaEvidence?.platform || bundle.context?.store !== bundle.platformSchemaEvidence?.store) errors.push(error("context.storeRef", "冻结证据必须保存一致的完整店铺身份"));
  for (const kind of REQUIRED_KINDS) {
    try { normalizeEvidenceScope(kind, buildExpectedEvidenceScope(kind, bundle.context || {})); }
    catch (caught) {
      if (caught.code !== "EVIDENCE_SCOPE_INVALID") throw caught;
      errors.push(error("context", `${kind}适用范围不完整`));
    }
  }
  for (const [kind, field] of [["commission", "platformFeeEvidence"], ["schema", "platformSchemaEvidence"], ["exchange_rate", "exchangeRateEvidence"]]) {
    for (const item of validateLifecycleEvidenceData(kind, bundle[field]).errors) errors.push(error(`${field}.${item.path}`, item.message));
  }
  if (!Object.hasOwn(bundle.platformFeeEvidence || {}, "otherCosts")) {
    errors.push(error("platformFeeEvidence.otherCosts", "必须明确列出其他成本"));
  }
  if (bundle.bundleVersion === LIFECYCLE_B_INPUT_BUNDLE_VERSION) {
    try {
      const context = Object.fromEntries(["platform", "store", "storeRef", "salesScheme"].map(key => [key, bundle.context?.[key]]));
      const costs = resolveLifecycleBCostPolicy({ snapshot: bundle.platformFeeEvidence?.costPolicySnapshot, context, asOf: bundle.createdAt });
      if (!isDeepStrictEqual(context, bundle.platformFeeEvidence.costPolicyContext) ||
          Object.entries(costs).some(([key, value]) => !["policyId", "policyVersion"].includes(key) && bundle.platformFeeEvidence.otherCosts?.[key] !== value) ||
          bundle.platformFeeEvidence.otherCosts?.pricingPolicyVersion !== costs.policyVersion) {
        errors.push(error("platformFeeEvidence.costPolicySnapshot", "冻结成本与政策或实际适用范围不一致"));
      }
    } catch (caught) {
      if (!caught.code?.startsWith("B_COST_POLICY_")) throw caught;
      errors.push(error("platformFeeEvidence.costPolicySnapshot", caught.code));
    }
  }
  if (isObject(bundle.platformFeeEvidence) && Object.hasOwn(bundle.platformFeeEvidence, "commissionCatalogRef")) {
    const frozenRef = { scope: bundle.context, commissionCatalogRef: bundle.platformFeeEvidence.commissionCatalogRef };
    const frozenRefValid = bundle.platformFeeEvidence.commissionEvidenceMode === "official_reference"
      ? validOzonCommissionCatalogRef(frozenRef)
      : validCommissionCatalogRef(frozenRef) && bundle.platformFeeEvidence.commissionEvidenceMode === "exact";
    if (!frozenRefValid) errors.push(error("platformFeeEvidence.commissionCatalogRef", "冻结佣金目录引用无效"));
  }
  const dimensions = bundle.packagingSnapshot?.dimensionsCm;
  if (!finite(bundle.packagingSnapshot?.weightKg) || bundle.packagingSnapshot.weightKg <= 0 || !isObject(dimensions) ||
      [dimensions?.length, dimensions?.width, dimensions?.height].some(value => !finite(value) || value <= 0)) errors.push(error("packagingSnapshot", "必须保存正数包装重量尺寸"));
  if (isObject(bundle.logisticsEvidence)) {
    for (const item of validateLifecycleEvidenceData("logistics_tariff", bundle.logisticsEvidence.tariff).errors) errors.push(error(`logisticsEvidence.tariff.${item.path}`, item.message));
    validateNonNegative(bundle.logisticsEvidence, ["amountRmb", "chargeableWeightKg", "actualWeightKg"], errors);
  }
  const evidenceIds = [bundle.platformFeeEvidence, bundle.logisticsEvidence, bundle.exchangeRateEvidence, bundle.platformSchemaEvidence].map(item => item?.evidenceId);
  if (evidenceIds.some(id => !nonEmptyString(id) || !bundle.sourcePackIds?.includes(id)) || new Set(evidenceIds).size !== 4) errors.push(error("sourcePackIds", "冻结证据必须逐一对应四个来源包"));
  if (bundle.platformFeeEvidence?.commissionEvidenceMode === "official_reference" && !isOfficialCommissionBindingForCandidate(
    bundle.platformFeeEvidence.officialCommissionBinding, {
      candidateId: bundle.sourceCandidateId, candidateRevision: bundle.sourceCandidateRevision
    })) errors.push(error("platformFeeEvidence.officialCommissionBinding", "官方费表绑定与冻结候选不一致"));
  if (bundle.platformFeeEvidence?.commissionEstimateAuthorization && !isCommissionEstimateAuthorizationForScope(
    bundle.platformFeeEvidence.commissionEstimateAuthorization, {
      candidateId: bundle.sourceCandidateId, candidateRevision: bundle.sourceCandidateRevision,
      commissionRate: bundle.platformFeeEvidence.commissionRate
    })) errors.push(error("platformFeeEvidence.commissionEstimateAuthorization", "估算授权与冻结候选不一致"));
  if (candidate) {
    if (!sameStoreRef(bundle.context?.storeRef, candidate.storeRef) || !sameStoreRef(bundle.platformSchemaEvidence?.storeRef, candidate.storeRef)) errors.push(error("context.storeRef", "证据店铺身份与当前候选不一致"));
    if (bundle.sourceCandidateId !== candidate.id) errors.push(error("sourceCandidateId", "候选不一致"));
    if (bundle.sourceCandidateRevision !== candidate.dataRevision) errors.push(error("sourceCandidateRevision", "候选修订号不一致"));
  }
  if (normalizedSubmission && isObject(bundle.packagingSnapshot)) {
    const expected = requirePackaging(normalizedSubmission);
    if (JSON.stringify(bundle.packagingSnapshot) !== JSON.stringify(expected)) errors.push(error("packagingSnapshot", "重量尺寸与主人确认值不一致"));
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidLifecycleBInputBundle(bundle, context) {
  const result = validateLifecycleBInputBundle(bundle, context);
  if (!result.valid) {
    throw new Error(`REAL_A_SYSTEM_EVIDENCE_GAP: ${result.errors.map((item) => `${item.path} ${item.message}`).join("；")}`);
  }
  return bundle;
}
