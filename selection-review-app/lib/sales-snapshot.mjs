export const SALES_SNAPSHOT_SCHEMA_VERSION = "sales-snapshot-v1.1";
export const MOCK_OZON_COLLECTOR_VERSION = "mock-ozon-sales-snapshot-v1";
export const REAL_OZON_COLLECTOR_VERSION = "real-ozon-sales-snapshot-v1";
export const TERRA_AUXILIARY_DRAFT_VERSION = "terra-a-sales-draft-v1";
export const OZON_COLLECTION_RESULT_VERSION = "ozon-sales-collection-result-v1";
/**
 * A market snapshot derived from one already-saved Seerfar category-detail receipt. It is not a page read: every
 * number is exactly what the provider reported for that product in that receipt, and the two evidence refs
 * (providerRecordRef and receiptId) say which saved record it came from.
 */
export const SEERFAR_CATEGORY_DETAIL_SOURCE = "seerfar_category_detail";
export const SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION = "seerfar-category-detail-v1";
export const SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE = "provider_category_result_read_only";
/** Closed key set for the derived snapshot: nothing beyond the provider's own reported facts may be saved here. */
export const SEERFAR_CATEGORY_DETAIL_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "snapshotId", "platform", "source", "marketScope", "sellerType", "sellerIdentityEvidence",
  "productUrl", "title", "imageRefs", "currentPrice", "currency", "priceCurrencySource", "categoryPath",
  "attributes", "marketMetrics", "evidenceRefs", "collectedAt", "evidenceRef", "collectorVersion",
  "collectorMode", "readOnly"
]);
const SEERFAR_MARKET_METRIC_KEYS = Object.freeze(["salesCount", "salesWindow", "revenue", "reviewCount", "reviewRating"]);
export const UNKNOWN = "unknown";

export function extractOzonProductId(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)ozon\.ru$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})(?:\/|$)/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export const SELLER_TYPES = Object.freeze([
  "cross_border_cn",
  "local_ru",
  "other_cross_border",
  "unknown"
]);

export const MARKET_SCOPES = Object.freeze([
  "ozon_cn_cross_border",
  "ozon_general_market",
  "unknown"
]);

export const TECHNICAL_COLLECTION_STATUSES = Object.freeze([
  "completed",
  "data_acquisition_failed"
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

function validUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nullableNonNegative(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * The derived Seerfar snapshot keeps closed keys, an explicit source type and both provenance refs, so a number
 * saved here can never be confused with a real page read or silently gain fields nobody evidenced.
 */
function validateSeerfarCategoryDetailSnapshot(snapshot, errors) {
  const keys = Object.keys(snapshot);
  if (keys.length !== SEERFAR_CATEGORY_DETAIL_SNAPSHOT_KEYS.length ||
      SEERFAR_CATEGORY_DETAIL_SNAPSHOT_KEYS.some((key) => !Object.hasOwn(snapshot, key))) {
    push(errors, "$", `${SEERFAR_CATEGORY_DETAIL_SOURCE}快照只能保存声明的固定字段`);
  }
  if (snapshot.collectorMode !== SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE ||
      snapshot.collectorVersion !== SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION) {
    push(errors, "collectorMode", "查询结果快照必须声明只读的品类查询采集模式");
  }
  if (snapshot.sellerType !== UNKNOWN) push(errors, "sellerType", "查询结果没有卖家身份证据，只能是unknown");
  if (snapshot.priceCurrencySource !== "ozon_platform_currency") {
    push(errors, "priceCurrencySource", "必须写明售价币种依据的是平台币种约定");
  }
  const metrics = snapshot.marketMetrics;
  if (!isObject(metrics)) {
    push(errors, "marketMetrics", "必须是对象");
  } else {
    const metricKeys = Object.keys(metrics);
    if (metricKeys.length !== SEERFAR_MARKET_METRIC_KEYS.length ||
        SEERFAR_MARKET_METRIC_KEYS.some((key) => !Object.hasOwn(metrics, key))) {
      push(errors, "marketMetrics", "只能保存服务商回报的固定指标字段");
    }
    if (!(metrics.salesCount === null || (Number.isSafeInteger(metrics.salesCount) && metrics.salesCount >= 0))) {
      push(errors, "marketMetrics.salesCount", "必须是服务商回报的非负整数销量或null");
    }
    if (!(metrics.reviewCount === null || (Number.isSafeInteger(metrics.reviewCount) && metrics.reviewCount >= 0))) {
      push(errors, "marketMetrics.reviewCount", "必须是非负整数评价数或null");
    }
    if (!nullableNonNegative(metrics.revenue)) push(errors, "marketMetrics.revenue", "必须是非负数或null");
    if (!nullableNonNegative(metrics.reviewRating)) push(errors, "marketMetrics.reviewRating", "必须是非负数或null");
    if (metrics.salesWindow !== null) {
      const window = metrics.salesWindow;
      if (!isObject(window) || Object.keys(window).length !== 2 ||
          !["startDate", "endDate"].every((key) => Object.hasOwn(window, key)) ||
          !["startDate", "endDate"].every((key) => window[key] === null || isoDate(window[key]))) {
        push(errors, "marketMetrics.salesWindow", "销量统计区间必须是服务商声明的起止日期或null");
      }
    }
  }
  if (!Array.isArray(snapshot.evidenceRefs) || snapshot.evidenceRefs.length !== 2 ||
      snapshot.evidenceRefs.some((item) => !nonEmptyString(item)) ||
      new Set(snapshot.evidenceRefs).size !== 2) {
    push(errors, "evidenceRefs", "必须同时保留服务商记录引用和回执引用");
  }
}

export function validateSalesSnapshot(snapshot) {
  const errors = [];
  if (!isObject(snapshot)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (snapshot.schemaVersion !== SALES_SNAPSHOT_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `必须是${SALES_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(snapshot.snapshotId)) push(errors, "snapshotId", "必须是非空字符串");
  if (snapshot.platform !== "ozon") push(errors, "platform", "SalesSnapshot只接受ozon");
  if (!MARKET_SCOPES.includes(snapshot.marketScope)) push(errors, "marketScope", "市场范围值无效");
  if (!SELLER_TYPES.includes(snapshot.sellerType)) push(errors, "sellerType", "卖家类型值无效");

  if (!isObject(snapshot.sellerIdentityEvidence)) {
    push(errors, "sellerIdentityEvidence", "必须是对象");
  } else {
    if (!["verified", "unverified"].includes(snapshot.sellerIdentityEvidence.status)) {
      push(errors, "sellerIdentityEvidence.status", "必须是verified或unverified");
    }
    if (!Array.isArray(snapshot.sellerIdentityEvidence.signals)) {
      push(errors, "sellerIdentityEvidence.signals", "必须是数组");
    }
    if (!nonEmptyString(snapshot.sellerIdentityEvidence.evidenceRef)) {
      push(errors, "sellerIdentityEvidence.evidenceRef", "必须是非空字符串");
    }
    if (snapshot.sellerType === UNKNOWN && snapshot.sellerIdentityEvidence.status !== "unverified") {
      push(errors, "sellerIdentityEvidence.status", "sellerType为unknown时不得标记身份已验证");
    }
    if (snapshot.sellerType !== UNKNOWN && snapshot.sellerIdentityEvidence.status !== "verified") {
      push(errors, "sellerIdentityEvidence.status", "明确卖家类型必须有已验证身份依据");
    }
  }

  if (!validUrl(snapshot.productUrl)) push(errors, "productUrl", "必须是有效HTTP(S)链接");
  if (!nonEmptyString(snapshot.title)) push(errors, "title", "必须是非空字符串");
  if (!Array.isArray(snapshot.imageRefs)) {
    push(errors, "imageRefs", "必须是数组");
  } else if (snapshot.imageRefs.some((item) => !nonEmptyString(item))) {
    push(errors, "imageRefs", "图片引用必须都是非空字符串");
  }
  if (!(snapshot.currentPrice === UNKNOWN || (Number.isFinite(snapshot.currentPrice) && snapshot.currentPrice > 0))) {
    push(errors, "currentPrice", "必须是正数或unknown");
  }
  if (!(snapshot.currency === UNKNOWN || /^[A-Z]{3}$/.test(String(snapshot.currency)))) {
    push(errors, "currency", "必须是三位货币代码或unknown");
  }
  if (!(snapshot.categoryPath === UNKNOWN || nonEmptyString(snapshot.categoryPath))) {
    push(errors, "categoryPath", "必须是非空字符串或unknown");
  }
  if (snapshot.platformCategoryEvidence !== undefined) {
    const category = snapshot.platformCategoryEvidence;
    if (!isObject(category)) {
      push(errors, "platformCategoryEvidence", "必须是对象");
    } else {
      if (category.status !== "verified") push(errors, "platformCategoryEvidence.status", "必须是verified");
      if (!Number.isInteger(category.descriptionCategoryId) || category.descriptionCategoryId <= 0) {
        push(errors, "platformCategoryEvidence.descriptionCategoryId", "必须是准确正整数");
      }
      if (!Number.isInteger(category.typeId) || category.typeId <= 0) {
        push(errors, "platformCategoryEvidence.typeId", "必须是准确正整数");
      }
      if (!nonEmptyString(category.categoryToken)) push(errors, "platformCategoryEvidence.categoryToken", "必须是稳定类目token");
      if (category.sourceSnapshotId !== snapshot.snapshotId) {
        push(errors, "platformCategoryEvidence.sourceSnapshotId", "必须指向当前销售快照");
      }
      if (!Array.isArray(category.sourceEvidenceRefs) ||
          category.sourceEvidenceRefs.length < 2 ||
          category.sourceEvidenceRefs.some((item) => !nonEmptyString(item))) {
        push(errors, "platformCategoryEvidence.sourceEvidenceRefs", "必须同时保留佣金和Schema证据引用");
      }
      if (!isoDateTime(category.verifiedAt)) push(errors, "platformCategoryEvidence.verifiedAt", "必须有有效核验时间");
    }
  }
  if (!isObject(snapshot.attributes)) push(errors, "attributes", "必须是对象");
  if (snapshot.auxiliaryDrafts !== undefined) {
    if (!Array.isArray(snapshot.auxiliaryDrafts)) {
      push(errors, "auxiliaryDrafts", "必须是数组");
    } else {
      const seenDraftIds = new Set();
      snapshot.auxiliaryDrafts.forEach((draft, index) => {
        const path = `auxiliaryDrafts[${index}]`;
        if (!isObject(draft)) return push(errors, path, "必须是对象");
        if (draft.schemaVersion !== TERRA_AUXILIARY_DRAFT_VERSION) push(errors, `${path}.schemaVersion`, "版本无效");
        if (!nonEmptyString(draft.draftId) || seenDraftIds.has(draft.draftId)) push(errors, `${path}.draftId`, "必须非空且不得重复");
        seenDraftIds.add(draft.draftId);
        if (draft.provider !== "terra") push(errors, `${path}.provider`, "只允许terra");
        if (draft.status !== "draft" || draft.authoritative !== false || draft.mayOverrideObservedFields !== false) {
          push(errors, path, "只能保存不可覆盖真实字段的辅助草稿");
        }
        if (!nonEmptyString(draft.modelVersion) || !isoDateTime(draft.generatedAt)) push(errors, path, "缺模型版本或生成时间");
        if (!Array.isArray(draft.publicTextEvidenceRefs) || draft.publicTextEvidenceRefs.length === 0 || draft.publicTextEvidenceRefs.some((item) => !nonEmptyString(item))) {
          push(errors, `${path}.publicTextEvidenceRefs`, "必须引用公开文字证据");
        }
        if (!Array.isArray(draft.authorizedImageRefs) || draft.authorizedImageRefs.some((item) => !snapshot.imageRefs.includes(item))) {
          push(errors, `${path}.authorizedImageRefs`, "只能引用快照内获准图片");
        }
        if (!isObject(draft.output)) push(errors, `${path}.output`, "必须是结构化草稿");
      });
    }
  }
  if (!isoDateTime(snapshot.collectedAt)) push(errors, "collectedAt", "必须是有效时间");
  if (!nonEmptyString(snapshot.evidenceRef)) push(errors, "evidenceRef", "必须是非空字符串");
  const validCollectorPair =
    (snapshot.collectorMode === "mock_only" && snapshot.collectorVersion === MOCK_OZON_COLLECTOR_VERSION) ||
    (snapshot.collectorMode === "real_page_read_only" && snapshot.collectorVersion === REAL_OZON_COLLECTOR_VERSION) ||
    (snapshot.collectorMode === "provider_api_read_only" && snapshot.collectorVersion === "linkfox-detail-93a1dbf-v1") ||
    (snapshot.collectorMode === SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE &&
      snapshot.collectorVersion === SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION);
  if (!validCollectorPair) {
    push(errors, "collectorMode", "采集模式与采集器版本不匹配");
  }
  if (snapshot.readOnly !== true) push(errors, "readOnly", "必须为true");
  // Only a snapshot that declares a source type is judged by that source's rules; page reads keep their own shape.
  if (snapshot.source === SEERFAR_CATEGORY_DETAIL_SOURCE) validateSeerfarCategoryDetailSnapshot(snapshot, errors);
  else if (snapshot.source !== undefined) push(errors, "source", "销售快照来源类型无效");
  return { valid: errors.length === 0, errors };
}

export function attachTerraAuxiliaryDraft(snapshot, draft) {
  assertValidSalesSnapshot(snapshot);
  if (!isObject(draft)) throw new TypeError("A_TERRA_DRAFT_INVALID: Terra草稿必须是对象");
  if (draft.provider !== "terra") throw new Error("A_TERRA_DRAFT_PROVIDER_REJECTED: A阶段只允许Terra辅助整理");
  if (draft.status !== "draft" || draft.authoritative !== false || draft.mayOverrideObservedFields !== false) {
    throw new Error("A_TERRA_DRAFT_BOUNDARY_REJECTED: Terra输出只能是不可覆盖真实字段的辅助草稿");
  }
  if (!nonEmptyString(draft.modelVersion) || !isoDateTime(draft.generatedAt)) {
    throw new Error("A_TERRA_DRAFT_TRACE_MISSING: 必须保存模型版本和生成时间");
  }
  if (!Array.isArray(draft.publicTextEvidenceRefs) || draft.publicTextEvidenceRefs.length === 0 || draft.publicTextEvidenceRefs.some((item) => !nonEmptyString(item))) {
    throw new Error("A_TERRA_DRAFT_TEXT_SCOPE_INVALID: 必须引用已采集公开文字证据");
  }
  const imageRefs = Array.isArray(draft.authorizedImageRefs) ? draft.authorizedImageRefs : [];
  if (imageRefs.some((item) => !snapshot.imageRefs.includes(item))) {
    throw new Error("A_TERRA_DRAFT_IMAGE_SCOPE_INVALID: Terra只能读取销售快照中获准的图片引用");
  }
  if (!isObject(draft.output)) throw new Error("A_TERRA_DRAFT_OUTPUT_INVALID: 草稿输出必须是结构化对象");
  const next = structuredClone(snapshot);
  next.auxiliaryDrafts ||= [];
  const draftId = nonEmptyString(draft.draftId) ? draft.draftId.trim() : `terra:${snapshot.snapshotId}:${draft.modelVersion}:${draft.generatedAt}`;
  const record = {
    schemaVersion: TERRA_AUXILIARY_DRAFT_VERSION,
    draftId,
    provider: "terra",
    modelVersion: draft.modelVersion.trim(),
    generatedAt: new Date(draft.generatedAt).toISOString(),
    status: "draft",
    authoritative: false,
    mayOverrideObservedFields: false,
    publicTextEvidenceRefs: [...new Set(draft.publicTextEvidenceRefs)],
    authorizedImageRefs: [...new Set(imageRefs)],
    output: structuredClone(draft.output)
  };
  const existing = next.auxiliaryDrafts.find((item) => item.draftId === draftId);
  if (existing) {
    if (!sameJson(existing, record)) throw new Error("A_TERRA_DRAFT_ID_CONFLICT: 同一草稿ID内容不一致");
    return deepFreeze(next);
  }
  next.auxiliaryDrafts.push(record);
  for (const key of Object.keys(snapshot)) {
    if (key !== "auxiliaryDrafts" && !sameJson(snapshot[key], next[key])) throw new Error(`A_TERRA_DRAFT_OBSERVED_FIELD_CHANGED: ${key}`);
  }
  assertValidSalesSnapshot(next);
  return deepFreeze(next);
}

export function assertValidSalesSnapshot(snapshot) {
  const result = validateSalesSnapshot(snapshot);
  if (!result.valid) {
    const detail = result.errors.map((item) => `${item.path}: ${item.message}`).join("；");
    throw new Error(`SalesSnapshot校验失败：${detail}`);
  }
  return snapshot;
}

export function collectMockOzonSalesSnapshot(fixture) {
  if (!isObject(fixture)) throw new TypeError("模拟Ozon输入必须是对象");
  if (fixture.sourceMode !== "mock_ozon_fixture") {
    throw new Error("5A只允许mock_ozon_fixture，不得连接真实平台");
  }
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: fixture.snapshotId,
    platform: "ozon",
    marketScope: fixture.marketScope,
    sellerType: fixture.sellerType,
    sellerIdentityEvidence: structuredClone(fixture.sellerIdentityEvidence),
    productUrl: fixture.productUrl,
    title: fixture.title,
    imageRefs: structuredClone(fixture.imageRefs),
    currentPrice: fixture.currentPrice,
    currency: fixture.currency,
    categoryPath: fixture.categoryPath,
    attributes: structuredClone(fixture.attributes),
    collectedAt: fixture.collectedAt,
    evidenceRef: fixture.evidenceRef,
    collectorVersion: MOCK_OZON_COLLECTOR_VERSION,
    collectorMode: "mock_only",
    readOnly: true
  };
  assertValidSalesSnapshot(snapshot);
  return deepFreeze(snapshot);
}

function normalizedCountry(value) {
  if (!nonEmptyString(value)) return UNKNOWN;
  const normalized = value.trim().toLowerCase();
  if (["cn", "chn", "china", "中国", "китай"].includes(normalized)) return "CN";
  if (["ru", "rus", "russia", "俄罗斯", "россия"].includes(normalized)) return "RU";
  return normalized.toUpperCase();
}

/**
 * 只有页面直接给出的卖家注册地/发货主体国家可确认卖家类型。
 * 店名、语言、商品产地或普通“中国发货”文案都不足以证明卖家身份。
 */
export function classifyOzonSellerIdentity(signals = []) {
  const safeSignals = Array.isArray(signals) ? structuredClone(signals) : [];
  const directSignal = safeSignals.find((signal) =>
    isObject(signal) &&
    ["seller_registered_country", "seller_legal_country"].includes(signal.field) &&
    nonEmptyString(signal.value) &&
    nonEmptyString(signal.sourcePath)
  );

  if (!directSignal) {
    return deepFreeze({
      sellerType: UNKNOWN,
      status: "unverified",
      signals: safeSignals
    });
  }

  const country = normalizedCountry(directSignal.value);
  const sellerType = country === "CN"
    ? "cross_border_cn"
    : country === "RU"
      ? "local_ru"
      : "other_cross_border";

  return deepFreeze({ sellerType, status: "verified", signals: safeSignals });
}

export function collectRealOzonSalesSnapshot(observation) {
  if (!isObject(observation)) throw new TypeError("真实Ozon页面观察必须是对象");
  if (observation.sourceMode !== "real_ozon_page_observation") {
    throw new Error("5B只接受real_ozon_page_observation");
  }
  if (observation.technicalStatus !== "completed") {
    throw new Error("页面未成功读取时不得生成SalesSnapshot");
  }

  const identity = classifyOzonSellerIdentity(observation.sellerIdentitySignals);
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: observation.snapshotId,
    platform: "ozon",
    marketScope: MARKET_SCOPES.includes(observation.marketScope) ? observation.marketScope : UNKNOWN,
    sellerType: identity.sellerType,
    sellerIdentityEvidence: {
      status: identity.status,
      signals: structuredClone(identity.signals),
      evidenceRef: observation.sellerIdentityEvidenceRef
    },
    productUrl: observation.productUrl,
    title: observation.title,
    imageRefs: structuredClone(observation.imageRefs),
    currentPrice: observation.currentPrice,
    currency: observation.currency,
    categoryPath: observation.categoryPath,
    attributes: structuredClone(observation.attributes),
    collectedAt: observation.collectedAt,
    evidenceRef: observation.evidenceRef,
    collectorVersion: REAL_OZON_COLLECTOR_VERSION,
    collectorMode: "real_page_read_only",
    readOnly: true
  };
  assertValidSalesSnapshot(snapshot);
  return deepFreeze(snapshot);
}

export function createOzonCollectionFailure(observation) {
  if (!isObject(observation)) throw new TypeError("Ozon采集失败记录必须是对象");
  if (!nonEmptyString(observation.collectionId)) throw new Error("collectionId必须是非空字符串");
  if (!nonEmptyString(observation.sourceCandidateId)) throw new Error("sourceCandidateId必须是非空字符串");
  if (!validUrl(observation.productUrl)) throw new Error("productUrl必须是有效HTTP(S)链接");
  if (!nonEmptyString(observation.collectedAt) || !isoDateTime(observation.collectedAt)) {
    throw new Error("collectedAt必须是有效时间");
  }
  if (!nonEmptyString(observation.failureLayer) || !nonEmptyString(observation.reason)) {
    throw new Error("失败层和失败原因必须明确");
  }

  return deepFreeze({
    schemaVersion: OZON_COLLECTION_RESULT_VERSION,
    collectionId: observation.collectionId,
    sourceCandidateId: observation.sourceCandidateId,
    sourceDataRevision: observation.sourceDataRevision ?? UNKNOWN,
    productUrl: observation.productUrl,
    collectedAt: observation.collectedAt,
    technicalStatus: "data_acquisition_failed",
    businessStateEffect: "unchanged",
    snapshot: null,
    failure: {
      layer: observation.failureLayer,
      reason: observation.reason,
      retryAttempted: false
    },
    evidenceRef: observation.evidenceRef,
    readOnly: true
  });
}
