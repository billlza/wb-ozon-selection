import { normalize1688CaptureSource, normalizePinduoduoCaptureSource, supplierCapturePlatform } from "./source-capture.mjs";

export const SUPPLIER_OPTION_SCHEMA_VERSION = "product-lifecycle-v1.1";
export const SUPPLIER_SOURCE_PLATFORMS = Object.freeze(["1688", "pinduoduo"]);
export const UNKNOWN = "unknown";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validOfferId(value) {
  return typeof value === "string" && /^\d{1,40}$/.test(value);
}

function validSupplierProductUrl(value, offerId, platform) {
  if (!nonEmptyString(value) || !validOfferId(offerId)) return false;
  const normalize = platform === "pinduoduo" ? normalizePinduoduoCaptureSource : normalize1688CaptureSource;
  const source = normalize(value);
  // Frozen supply evidence must already be canonical. Never repair a supplied
  // URL by stripping credentials, query/fragment or resolving a different offer.
  return source.type === "detail" && source.sourceUrl === value && source.offerId === offerId;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function positiveOrUnknown(value) {
  return value === UNKNOWN || (Number.isFinite(value) && value > 0);
}

function nonNegativeOrUnknown(value) {
  return value === UNKNOWN || (Number.isFinite(value) && value >= 0);
}

function descriptiveFactOrUnknown(value) {
  return nonEmptyString(value) || isObject(value);
}

function weightOrUnknown(value) {
  if (nonEmptyString(value)) return true;
  if (Number.isFinite(value)) return value >= 0;
  return isObject(value) && Number.isFinite(value.value) && value.value >= 0 && nonEmptyString(value.unit);
}

function dimensionsOrUnknown(value) {
  if (nonEmptyString(value)) return true;
  return isObject(value) && [value.length, value.width, value.height].every((dimension) => Number.isFinite(dimension) && dimension > 0);
}

function directOrUnknown(value) {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function variantToken(value) {
  return String(value).trim().replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("=", "%3D");
}

function meaningfulVariantText(value) {
  return nonEmptyString(value) && ![UNKNOWN, "null", "undefined"].includes(value.trim().toLowerCase());
}

export function derivedVariantKey(sku) {
  if (meaningfulVariantText(sku.propPath)) return sku.propPath.trim();
  const attributes = isObject(sku.attributes) ? sku.attributes : {};
  const attributeKey = Object.entries(attributes)
    .filter(([key, value]) => nonEmptyString(key) && (
      meaningfulVariantText(value) || Number.isFinite(value)
    ))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${variantToken(key)}=${variantToken(value)}`)
    .join("|");
  return attributeKey || String(sku.sourceSkuId);
}

export function validateSupplierSku(sku, path = "SupplierSKU") {
  const errors = [];
  if (!isObject(sku)) return { valid: false, errors: [{ path, message: "必须是对象" }] };
  if (!nonEmptyString(sku.supplierSkuId)) push(errors, `${path}.supplierSkuId`, "必须是非空字符串");
  if (!nonEmptyString(sku.variantKey)) push(errors, `${path}.variantKey`, "必须是非空字符串");
  if (!isObject(sku.attributes)) push(errors, `${path}.attributes`, "必须是对象");
  if (!positiveOrUnknown(sku.unitProductPrice)) {
    push(errors, `${path}.unitProductPrice`, "必须是正数或unknown");
  }
  if (!nonNegativeOrUnknown(sku.unitDomesticFreight)) {
    push(errors, `${path}.unitDomesticFreight`, "必须是非负数或unknown");
  }
  if (!nonNegativeOrUnknown(sku.actualPurchaseCost)) {
    push(errors, `${path}.actualPurchaseCost`, "必须是非负数或unknown");
  }
  if (!weightOrUnknown(sku.weight)) push(errors, `${path}.weight`, "必须是非负重量、带单位的重量对象、原始文字或unknown");
  if (!dimensionsOrUnknown(sku.dimensions)) push(errors, `${path}.dimensions`, "必须是正数长宽高对象、原始文字或unknown");
  for (const field of ["material", "powerProfile"]) {
    if (!descriptiveFactOrUnknown(sku[field])) push(errors, `${path}.${field}`, "必须是事实对象、非空文字或unknown");
  }
  if (!(sku.imageRefs === UNKNOWN || (Array.isArray(sku.imageRefs) && sku.imageRefs.length > 0 && sku.imageRefs.every(nonEmptyString)))) {
    push(errors, `${path}.imageRefs`, "必须是非空字符串数组或unknown");
  }
  return { valid: errors.length === 0, errors };
}

export function validateSupplierOption(option) {
  const errors = [];
  if (!isObject(option)) return { valid: false, errors: [{ path: "SupplierOption", message: "必须是对象" }] };
  if (!nonEmptyString(option.supplierOptionId)) {
    push(errors, "SupplierOption.supplierOptionId", "必须是非空字符串");
  }
  if (!SUPPLIER_SOURCE_PLATFORMS.includes(option.sourcePlatform)) {
    push(errors, "SupplierOption.sourcePlatform", "6A只接受1688或拼多多");
  }
  if (!validSupplierProductUrl(option.productUrl, option.offerId, option.sourcePlatform)) {
    push(errors, "SupplierOption.productUrl", "必须是与offerId一致、且属于该来源平台的规范HTTPS商品详情链接");
  }
  if (!validOfferId(option.offerId)) push(errors, "SupplierOption.offerId", "必须是1至40位数字字符串");
  if (!(option.supplierSalesEvidence === UNKNOWN || isObject(option.supplierSalesEvidence))) {
    push(errors, "SupplierOption.supplierSalesEvidence", "必须是证据对象或unknown");
  }
  if (!(option.supplierBadges === UNKNOWN || (Array.isArray(option.supplierBadges) && option.supplierBadges.every(nonEmptyString)))) {
    push(errors, "SupplierOption.supplierBadges", "必须是非空字符串数组或unknown");
  }
  if (!Array.isArray(option.supplierSkus) || option.supplierSkus.length === 0) {
    push(errors, "SupplierOption.supplierSkus", "必须至少包含一个SupplierSKU");
  } else {
    const ids = new Set();
    option.supplierSkus.forEach((sku, index) => {
      const result = validateSupplierSku(sku, `SupplierOption.supplierSkus[${index}]`);
      errors.push(...result.errors);
      if (isObject(sku) && nonEmptyString(sku.supplierSkuId)) {
        if (ids.has(sku.supplierSkuId)) push(errors, `SupplierOption.supplierSkus[${index}].supplierSkuId`, "不得重复");
        ids.add(sku.supplierSkuId);
      }
    });
  }
  if (!isoDateTime(option.captureTime)) push(errors, "SupplierOption.captureTime", "必须是有效时间");
  if (!nonEmptyString(option.evidenceRef)) push(errors, "SupplierOption.evidenceRef", "必须是非空字符串");
  return { valid: errors.length === 0, errors };
}

export function assertValidSupplierOption(option) {
  const result = validateSupplierOption(option);
  if (!result.valid) {
    const detail = result.errors.map((item) => `${item.path}: ${item.message}`).join("；");
    throw new Error(`SupplierOption校验失败：${detail}`);
  }
  return option;
}

/**
 * 将现有 sanitize1688Evidence 输出只读适配为新版供应数据结构。
 * 本适配器只复制直接字段，不用阶梯价补SKU价，也不计算或倒推国内运费与到手成本。
 */
export function adapt1688CaptureToSupplierOption(evidence, { evidenceRef } = {}) {
  if (!isObject(evidence)) throw new TypeError("1688采集证据必须是对象");
  if (!Array.isArray(evidence.skus) || evidence.skus.length === 0) {
    throw new Error("1688采集证据缺少SKU");
  }

  const supplierSkus = evidence.skus.map((sku) => {
    if (!isObject(sku) || !nonEmptyString(sku.sourceSkuId)) {
      throw new Error("1688采集证据包含无效SKU");
    }
    const directPrice = Number.isFinite(sku.priceCny) && sku.priceCny > 0
      ? sku.priceCny
      : UNKNOWN;
    return {
      supplierSkuId: sku.sourceSkuId,
      variantKey: derivedVariantKey(sku),
      attributes: isObject(sku.attributes) ? structuredClone(sku.attributes) : {},
      unitProductPrice: directPrice,
      unitDomesticFreight: UNKNOWN,
      actualPurchaseCost: UNKNOWN,
      weight: directOrUnknown(sku.weight),
      dimensions: directOrUnknown(sku.dimensions),
      material: directOrUnknown(sku.material),
      powerProfile: directOrUnknown(sku.powerProfile),
      imageRefs: nonEmptyString(sku.imageUrl) ? [sku.imageUrl] : UNKNOWN
    };
  });

  // The captured canonical address decides the platform; a Pinduoduo goods page can never be filed as a 1688 offer.
  const platform = supplierCapturePlatform(evidence.sourceUrl) === "pinduoduo" ? "pinduoduo" : "1688";
  const option = {
    supplierOptionId: `supplier-option:${platform}:${evidence.offerId}`,
    sourcePlatform: platform,
    productUrl: evidence.sourceUrl,
    offerId: evidence.offerId,
    supplierSalesEvidence: isObject(evidence.supplierSalesEvidence)
      ? structuredClone(evidence.supplierSalesEvidence)
      : UNKNOWN,
    supplierBadges: Array.isArray(evidence.supplierBadges) && evidence.supplierBadges.length
      ? evidence.supplierBadges.filter(nonEmptyString).map((item) => item.trim())
      : UNKNOWN,
    supplierSkus,
    captureTime: evidence.observedAt,
    evidenceRef
  };
  assertValidSupplierOption(option);
  return deepFreeze(option);
}
