import { isCanonicalFrozenRef } from "./production-contract-primitives.mjs";

// Official 2025-06-26 removal; the source and later changes are archived in
// docs/contracts/ozon-stock-changes-20260922.json. This says nothing about price readiness.
export const OZON_STOCK_QUANT_SIZE_REMOVAL_REF = "official:ozon-seller-api:stocks-quant-size-removed:2025-06-26";

function closed(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function isExternalNumericId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export function validPrerequisitePolicy(policy) {
  return closed(policy, ["schemaVersion", "policyId", "version", "officialEvidenceRef", "priceSent", "reserved", "stockRequest"]) &&
    ["ozon-inventory-prerequisite-policy-v1", "ozon-inventory-prerequisite-policy-v2"].includes(policy.schemaVersion) &&
    [policy.policyId, policy.version, policy.officialEvidenceRef].every(isCanonicalFrozenRef) &&
    closed(policy.priceSent, ["endpoint", "field", "acceptedValues"]) && policy.priceSent.endpoint === "/v3/product/info/list" &&
    policy.priceSent.field === "statuses.status" && Array.isArray(policy.priceSent.acceptedValues) &&
    policy.priceSent.acceptedValues.length > 0 && policy.priceSent.acceptedValues.length <= 16 &&
    policy.priceSent.acceptedValues.every(value => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)) &&
    new Set(policy.priceSent.acceptedValues).size === policy.priceSent.acceptedValues.length &&
    closed(policy.reserved, ["endpoint", "sourceProtocol"]) && policy.reserved.endpoint === "/v2/product/info/stocks-by-warehouse/fbs" &&
    policy.reserved.sourceProtocol === "ozon-product-stocks-by-warehouse-fbs-v2" &&
    (policy.schemaVersion === "ozon-inventory-prerequisite-policy-v1"
      ? closed(policy.stockRequest, ["identityField", "quantSize"]) &&
        (policy.stockRequest.quantSize === null || isExternalNumericId(policy.stockRequest.quantSize))
      : closed(policy.stockRequest, ["identityField", "quantSize", "officialEvidenceRef"]) &&
        policy.stockRequest.quantSize === "not_applicable" &&
        policy.stockRequest.officialEvidenceRef === OZON_STOCK_QUANT_SIZE_REMOVAL_REF) &&
    ["offer_id", "product_id"].includes(policy.stockRequest.identityField);
}

/** Historical v1 evidence stays readable. Only its already-omitted field can still be executed. */
export function isCurrentInventoryPrerequisitePolicy(policy) {
  return validPrerequisitePolicy(policy) && (policy.schemaVersion === "ozon-inventory-prerequisite-policy-v2" ||
    policy.stockRequest.quantSize === null);
}

export function assertOzonInventoryPrerequisitePolicy(policy) {
  if (!validPrerequisitePolicy(policy)) throw new Error("OZON_DE_INVENTORY_POLICY_INVALID");
  return freeze(structuredClone(policy));
}
