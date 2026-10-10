import { STORE_PLATFORMS, resolveConfiguredStoreRef } from "./store-binding.mjs";
import { EXTRA_HANDLING_FEE_LABEL, extraHandlingFeesConsistency } from "./extra-handling-fees.mjs";
const TARGET_STORES = new Set(Object.keys(STORE_PLATFORMS));
const RISK_STATUSES = new Set(["clear", "needs_confirmation"]);
const POWERED_VALUES = new Set([true, false, "unknown"]);
const OPTIONAL_NUMERIC_FIELDS = new Set([
  "purchasePriceRmb",
  "domesticShippingRmb",
  "packagingCostRmb",
  "moq",
  "netWeightKg",
  "packedWeightKg",
  "expectedPriceRub",
  "sellerRevenueCny"
]);
const OPTIONAL_TEXT_FIELDS = new Set([
  "productName",
  "materialsAndAge",
  "notes"
]);
const OPTIONAL_URL_FIELDS = new Set([
  "productUrl",
  "sourceUrl",
  "competitorUrl",
  "imageUrl"
]);
const USER_EDITABLE_FIELDS = Object.freeze([
  "targetStore",
  "productUrl",
  "productName",
  "sourceUrl",
  "competitorUrl",
  "purchasePriceRmb",
  "domesticShippingRmb",
  "packagingCostRmb",
  "moq",
  "netWeightKg",
  "packedWeightKg",
  "dimensionsCm",
  "materialsAndAge",
  "powered",
  "complianceStatus",
  "authorizationStatus",
  "expectedPriceRub",
  "sellerRevenueCny",
  "imageUrl",
  "notes",
  "acceptedTestRisk"
]);
const PROTECTED_RISK_FIELDS = new Set(["complianceStatus", "authorizationStatus"]);

function inputError(status, message, code) {
  return Object.assign(new Error(message), { status, extra: code ? { code } : {} });
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(400, `${label}必须是对象`, "candidate_input_invalid");
  }
  return value;
}

function store(value) {
  if (typeof value !== "string") {
    throw inputError(400, "请选择目标店铺", "candidate_store_invalid");
  }
  const normalized = value.trim();
  if (!TARGET_STORES.has(normalized)) throw inputError(400, "请选择目标店铺", "candidate_store_invalid");
  return normalized;
}

function text(value, field, { maxLength, multiline = false }) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw inputError(400, `${field}文本无效`, "candidate_text_invalid");
  }
  const normalized = value.trim();
  const invalidControlPattern = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (normalized.length > maxLength || invalidControlPattern.test(normalized)) {
    throw inputError(400, `${field}文本无效`, "candidate_text_invalid");
  }
  return normalized;
}

function optionalUrl(value, field) {
  const normalized = text(value, field, { maxLength: 2_000 });
  if (!normalized) return "";
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw inputError(400, `${field}必须是HTTP/HTTPS链接`, "candidate_url_invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw inputError(400, `${field}必须是HTTP/HTTPS链接且不能包含凭据`, "candidate_url_invalid");
  }
  return parsed.toString();
}

function optionalNumber(value, field, { integer = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw inputError(400, `${field}必须是非负数字`, "candidate_number_invalid");
  }
  if (integer && !Number.isInteger(value)) throw inputError(400, `${field}必须是非负整数`, "candidate_number_invalid");
  return value;
}

function dimensions(value) {
  if (value === null || value === undefined) return { length: null, width: null, height: null };
  assertPlainObject(value, "dimensionsCm");
  const allowed = new Set(["length", "width", "height"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw inputError(400, "dimensionsCm包含未声明字段", "candidate_dimensions_invalid");
  }
  return {
    length: optionalNumber(value.length, "dimensionsCm.length"),
    width: optionalNumber(value.width, "dimensionsCm.width"),
    height: optionalNumber(value.height, "dimensionsCm.height")
  };
}

function patchDimensions(value, currentDimensions) {
  if (value === null) return { length: null, width: null, height: null };
  assertPlainObject(value, "dimensionsCm");
  const allowed = new Set(["length", "width", "height"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw inputError(400, "dimensionsCm包含未声明字段", "candidate_dimensions_invalid");
  }
  const current = currentDimensions && typeof currentDimensions === "object" && !Array.isArray(currentDimensions)
    ? currentDimensions
    : {};
  return {
    length: Object.hasOwn(value, "length") ? optionalNumber(value.length, "dimensionsCm.length") : current.length ?? null,
    width: Object.hasOwn(value, "width") ? optionalNumber(value.width, "dimensionsCm.width") : current.width ?? null,
    height: Object.hasOwn(value, "height") ? optionalNumber(value.height, "dimensionsCm.height") : current.height ?? null
  };
}

function riskStatus(value, field) {
  if (typeof value !== "string") {
    throw inputError(400, `${field}只能是clear或needs_confirmation`, "candidate_risk_status_invalid");
  }
  const normalized = value.trim();
  if (!RISK_STATUSES.has(normalized)) throw inputError(400, `${field}只能是clear或needs_confirmation`, "candidate_risk_status_invalid");
  return normalized;
}

function normalizeField(field, value) {
  if (field === "targetStore") return store(value);
  if (OPTIONAL_URL_FIELDS.has(field)) return optionalUrl(value, field);
  if (OPTIONAL_NUMERIC_FIELDS.has(field)) return optionalNumber(value, field, { integer: field === "moq" });
  if (field === "dimensionsCm") return dimensions(value);
  if (OPTIONAL_TEXT_FIELDS.has(field)) {
    return text(value, field, { maxLength: field === "notes" ? 10_000 : 500, multiline: field === "notes" });
  }
  if (field === "powered") {
    if (!POWERED_VALUES.has(value)) throw inputError(400, "powered只能是true、false或unknown", "candidate_powered_invalid");
    return value;
  }
  if (field === "acceptedTestRisk") {
    if (typeof value !== "boolean") {
      throw inputError(400, "acceptedTestRisk必须是布尔值", "candidate_boolean_invalid");
    }
    return value;
  }
  if (PROTECTED_RISK_FIELDS.has(field)) return riskStatus(value, field);
  throw inputError(400, "候选字段不允许写入", "candidate_field_forbidden");
}

export function candidateStoreFrozen(candidate) {
  return Boolean(
    candidate?.lifecycleV11?.skuPackage ||
    candidate?.listingPreparation ||
    candidate?.bPassedAt ||
    candidate?.cCompletedAt ||
    ["ready_to_list", "listed", "eliminated"].includes(candidate?.workflowStatus)
  );
}

export function candidateProductionFactsFrozen(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  return Boolean(sku?.productionConfirmationCard || sku?.productionAuthorization || sku?.productionRecord);
}

export function normalizeCandidateUserCreateInput(input) {
  assertPlainObject(input, "candidate");
  const normalized = {};
  for (const [field, value] of Object.entries(input)) {
    if (!USER_EDITABLE_FIELDS.includes(field)) {
      throw inputError(400, "候选字段不允许写入", "candidate_field_forbidden");
    }
    if (PROTECTED_RISK_FIELDS.has(field)) {
      riskStatus(value, field);
      throw inputError(400, "合规/IP授权状态不能通过普通新增候选设置", "candidate_risk_status_create_forbidden");
    }
    normalized[field] = normalizeField(field, value);
  }
  normalized.targetStore = store(normalized.targetStore);
  if (!String(normalized.productUrl || "").trim()) throw inputError(400, "请填写商品链接", "candidate_product_url_required");
  normalized.complianceStatus = "needs_confirmation";
  normalized.authorizationStatus = "needs_confirmation";
  return Object.freeze(normalized);
}

export function normalizeCandidateCodexCreateInput(input) {
  assertPlainObject(input, "candidate");
  const normalized = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === "group" || field === "purchaseCeiling" || field === "sourceSearchAttempts") {
      normalized[field] = structuredClone(value);
      continue;
    }
    if (!USER_EDITABLE_FIELDS.includes(field)) {
      throw inputError(400, "候选字段不允许写入", "candidate_field_forbidden");
    }
    normalized[field] = normalizeField(field, value);
  }
  normalized.targetStore = store(normalized.targetStore);
  if (!String(normalized.productUrl || "").trim()) throw inputError(400, "Codex候选必须提供真实商品链接", "candidate_product_url_required");
  if (!["clear", "needs_confirmation"].includes(normalized.complianceStatus)) {
    throw inputError(400, "Codex候选合规状态只能是clear或needs_confirmation", "candidate_risk_status_invalid");
  }
  if (!["clear", "needs_confirmation"].includes(normalized.authorizationStatus)) {
    throw inputError(400, "Codex候选权利/IP状态只能是clear或needs_confirmation", "candidate_risk_status_invalid");
  }
  return Object.freeze(normalized);
}

export function normalizeCandidateUserPatchInput(input, currentCandidate, { storeBindings = [] } = {}) {
  assertPlainObject(input, "candidatePatch");
  const normalized = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === "dataRevision") continue;
    if (!USER_EDITABLE_FIELDS.includes(field)) {
      throw inputError(400, "候选字段不允许写入", "candidate_field_forbidden");
    }
    if (PROTECTED_RISK_FIELDS.has(field)) {
      const requested = normalizeField(field, value);
      if (requested !== currentCandidate?.[field]) {
        throw inputError(409, "合规/IP授权状态不能通过普通资料保存修改", "candidate_risk_status_patch_forbidden");
      }
      continue;
    }
    const next = field === "dimensionsCm"
      ? patchDimensions(value, currentCandidate?.dimensionsCm)
      : normalizeField(field, value);
    if (field === "targetStore" && next !== currentCandidate?.targetStore && candidateStoreFrozen(currentCandidate)) {
      throw inputError(409, "当前候选已冻结生命周期身份，不能通过普通资料保存换绑店铺", "candidate_store_frozen");
    }
    // packagingCostRmb 是这笔钱的权威总额；它旁边那份明细必须加得出它。总额单独被改掉就会让两个数分家，
    // 所以这条路直接拒绝，并把人指回明细那一处——软件不会替他把明细悄悄删掉或改写。
    // 明细本身已经坏掉的时候同样拒绝：那种商品更不能只改总额，得回「算利润」重新确认一次这份清单。
    if (field === "packagingCostRmb" && next !== currentCandidate?.packagingCostRmb) {
      const detail = extraHandlingFeesConsistency(currentCandidate);
      if (detail.status === "consistent") {
        throw inputError(409,
          `这件商品的${EXTRA_HANDLING_FEE_LABEL}有一份明细（合计 ¥${detail.totalRmb.toFixed(2)}）；要改金额请改那份明细，不能只改总额`,
          "candidate_extra_handling_fees_detail_conflict");
      }
      if (detail.status === "inconsistent") {
        throw inputError(409,
          `这件商品的${EXTRA_HANDLING_FEE_LABEL}明细和合计已经对不上（${detail.reason}）；请先在「算利润」里重新确认一次这份明细，不要只改总额`,
          "candidate_extra_handling_fees_detail_conflict");
      }
    }
    if (field !== "notes" && candidateProductionFactsFrozen(currentCandidate)) {
      const unchanged = field === "dimensionsCm"
        ? ["length", "width", "height"].every(dimension => next[dimension] === currentCandidate.dimensionsCm?.[dimension])
        : next === currentCandidate[field];
      if (!unchanged) throw inputError(409, "最终方案已冻结；采购、规格和价格事实不能通过普通资料保存改写", "candidate_production_facts_frozen");
      continue;
    }
    normalized[field] = next;
  }
  if (Object.hasOwn(normalized, "targetStore") && !candidateStoreFrozen(currentCandidate)) {
    normalized.storeRef = resolveConfiguredStoreRef(storeBindings, normalized.targetStore);
  }
  return Object.freeze(normalized);
}

export function candidateUserEditableFields() {
  return [...USER_EDITABLE_FIELDS];
}
