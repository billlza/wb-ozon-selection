import { captureNumber, captureText, cleanCaptureAttributes, canonicalSupplierImageUrl } from "./capture-evidence-sanitization.mjs";

const MAX_SKUS = 200;
const MAX_ATTRIBUTES = 120;
// Same ceiling the collector already applies to the page's own kilogram field; a heavier number is a parsing
// accident, not a parcel this shop ships.
const MAX_SKU_WEIGHT_KG = 1000;

function text(value, limit = 500) {
  return captureText(value, limit);
}

function finite(value) {
  return captureNumber(value);
}

function nonNegative(value) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function cleanObject(value, limit = MAX_ATTRIBUTES) {
  return cleanCaptureAttributes(value, limit);
}

/**
 * The shipping weight the page declares for one SKU, in kilograms.
 *
 * It is the only per-SKU fact that decides that SKU's own freight, so it must survive the DTO boundary instead of
 * being rebuilt later from the owner's single packed weight. The discipline is the one price and stock already use:
 * a closed shape ({value, unit:"kg"} or a bare number of kilograms), a positive value inside a sane range, and a
 * named source. Anything else is dropped — a page that ships no usable weight is a page with one fewer fact, never
 * a rejected capture, because the other 23 specifications on the same page are still true.
 */
function skuWeightKg(value) {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value)
    ? (text(value.unit, 20).toLowerCase() === "kg" ? value.value : null)
    : value;
  const number = positive(raw);
  return number !== null && number <= MAX_SKU_WEIGHT_KG ? number : null;
}

export function extract1688OfferId(value) {
  const raw = text(value, 3000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    // Recognize mobile identity for the caller's capture-required gate, but never
    // authorize mobile-page evidence (normalize1688CaptureSource remains narrower).
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["detail.1688.com", "m.1688.com"].includes(url.hostname)) return "";
    return url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
  } catch {
    return "";
  }
}

export function normalize1688CaptureSource(value) {
  const raw = text(value, 3000);
  if (!raw) return { type: "invalid", sourceUrl: "", offerId: "" };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return { type: "invalid", sourceUrl: "", offerId: "" };
    }
    if (url.hostname === "detail.1688.com") {
      const offerId = url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
      return offerId
        ? { type: "detail", sourceUrl: `https://detail.1688.com/offer/${offerId}.html`, offerId }
        : { type: "invalid", sourceUrl: "", offerId: "" };
    }
    if (url.hostname === "qr.1688.com") {
      const token = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,160})\/?$/)?.[1] || "";
      return token
        ? { type: "short", sourceUrl: `https://qr.1688.com/s/${token}`, offerId: "" }
        : { type: "invalid", sourceUrl: "", offerId: "" };
    }
  } catch {
    return { type: "invalid", sourceUrl: "", offerId: "" };
  }
  return { type: "invalid", sourceUrl: "", offerId: "" };
}

const FAILURE_DIAGNOSTIC_ENUMS = Object.freeze({
  finalHostClass: new Set(["detail_1688", "mobile_1688", "login_1688", "verification_1688", "other_1688", "external", "invalid"]),
  finalPathType: new Set(["offer_detail", "mobile_offer", "login", "verification", "redirect_intermediate", "other"]),
  redirectClassification: new Set(["allowed_detail", "login_required", "verification_required", "mobile_page", "intermediate_page", "non_whitelisted_destination", "different_offer", "detail_load_timeout", "tab_unavailable", "address_unavailable"]),
  navigationStage: new Set(["redirect_observed", "page_complete", "timeout"])
});

const FAILURE_DIAGNOSTIC_OPTIONAL_ENUMS = Object.freeze({
  tabObservation: new Set(["current_url", "pending_url", "tab_unavailable", "address_unavailable"]),
  lastObservedClassification: new Set(["allowed_detail", "login_required", "verification_required", "mobile_page", "intermediate_page", "non_whitelisted_destination", "different_offer", "detail_load_timeout", "tab_unavailable", "address_unavailable"])
});

const FAILURE_RESULT_KEYS = new Set([
  "captureId",
  "token",
  "dataRevision",
  "status",
  "failureCode",
  "observedAt",
  "failureDiagnostics"
]);

const FAILURE_CODES = new Set([
  "extension_not_installed",
  "extension_background_unavailable",
  "extension_version_mismatch",
  "extension_job_unclaimed",
  "service_restarted_before_claim",
  "unknown_outcome",
  "request_origin_invalid",
  "request_payload_missing",
  "capture_mode_invalid",
  "revision_invalid",
  "source_url_invalid",
  "short_link_resolution_not_allowed",
  "expected_offer_invalid",
  "site_login_required",
  "site_verification_required",
  "wrong_offer",
  "short_link_resolution_failed",
  "structured_data_unavailable",
  "sku_ambiguous",
  "exact_price_unavailable",
  "sku_limit_exceeded",
  "timeout",
  "revision_conflict",
  "server_rejected",
  "invalid_capture",
  "system_error"
]);

export function sanitizeSourceCaptureFailureDiagnostics(input) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("capture_failure_diagnostics_invalid");
  const allowedKeys = new Set([
    ...Object.keys(FAILURE_DIAGNOSTIC_ENUMS),
    ...Object.keys(FAILURE_DIAGNOSTIC_OPTIONAL_ENUMS),
    "observedOfferId"
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error("capture_failure_diagnostics_invalid");
  const normalized = {};
  for (const [field, allowed] of Object.entries(FAILURE_DIAGNOSTIC_ENUMS)) {
    const value = String(input[field] || "");
    if (!allowed.has(value)) throw new Error("capture_failure_diagnostics_invalid");
    normalized[field] = value;
  }
  for (const [field, allowed] of Object.entries(FAILURE_DIAGNOSTIC_OPTIONAL_ENUMS)) {
    if (input[field] === null || input[field] === undefined || input[field] === "") continue;
    const value = String(input[field]);
    if (!allowed.has(value)) throw new Error("capture_failure_diagnostics_invalid");
    normalized[field] = value;
  }
  const observedOfferId = input.observedOfferId === null || input.observedOfferId === undefined
    ? null
    : String(input.observedOfferId);
  if (observedOfferId !== null && !/^\d+$/.test(observedOfferId)) throw new Error("capture_failure_diagnostics_invalid");
  if (observedOfferId !== null && (normalized.finalHostClass !== "detail_1688" || normalized.finalPathType !== "offer_detail")) {
    throw new Error("capture_failure_diagnostics_invalid");
  }
  if (normalized.redirectClassification === "different_offer" && observedOfferId === null) {
    throw new Error("capture_failure_diagnostics_invalid");
  }
  if (normalized.redirectClassification === "allowed_detail") throw new Error("capture_failure_diagnostics_invalid");
  const validClassificationShape = {
    login_required: normalized.finalHostClass === "login_1688" && normalized.finalPathType === "login",
    verification_required: normalized.finalHostClass === "verification_1688" && normalized.finalPathType === "verification",
    mobile_page: normalized.finalHostClass === "mobile_1688" && ["mobile_offer", "other"].includes(normalized.finalPathType),
    intermediate_page: normalized.finalHostClass === "other_1688" && normalized.finalPathType === "redirect_intermediate",
    non_whitelisted_destination: ["other_1688", "detail_1688", "external", "invalid"].includes(normalized.finalHostClass) && normalized.finalPathType === "other",
    different_offer: normalized.finalHostClass === "detail_1688" && normalized.finalPathType === "offer_detail",
    detail_load_timeout: normalized.finalHostClass === "detail_1688" && normalized.finalPathType === "offer_detail" && normalized.navigationStage === "timeout",
    tab_unavailable: normalized.finalHostClass === "invalid" && normalized.finalPathType === "other" && normalized.navigationStage === "timeout" && normalized.tabObservation === "tab_unavailable",
    address_unavailable: normalized.finalHostClass === "invalid" && normalized.finalPathType === "other" && normalized.navigationStage === "timeout" && normalized.tabObservation === "address_unavailable"
  }[normalized.redirectClassification];
  if (!validClassificationShape) throw new Error("capture_failure_diagnostics_invalid");
  normalized.observedOfferId = observedOfferId;
  return normalized;
}

export function sanitizeSourceCaptureFailureResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("capture_failure_diagnostics_invalid");
  if (Object.keys(input).some((key) => !FAILURE_RESULT_KEYS.has(key))) throw new Error("capture_failure_diagnostics_invalid");
  if (input.status !== "failed") throw new Error("capture_failure_diagnostics_invalid");
  const failureCode = text(input.failureCode, 120) || "structured_data_unavailable";
  if (!FAILURE_CODES.has(failureCode)) throw new Error("capture_failure_diagnostics_invalid");
  const observedAt = text(input.observedAt, 80);
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) throw new Error("capture_failure_diagnostics_invalid");
  return {
    failureCode,
    observedAt: new Date(observedAt).toISOString(),
    failureDiagnostics: sanitizeSourceCaptureFailureDiagnostics(input.failureDiagnostics)
  };
}

export function sourceCaptureFailureDestinationLabel(diagnostics, failureCode = "") {
  const classification = diagnostics?.redirectClassification;
  const labels = {
    login_required: "登录页",
    verification_required: "人机验证页",
    mobile_page: "移动页",
    intermediate_page: "中间跳转页",
    non_whitelisted_destination: "其他非白名单页面",
    different_offer: "不同商品",
    detail_load_timeout: "商品详情页加载超时",
    tab_unavailable: "采集标签已关闭或不可读取",
    address_unavailable: "页面地址仍未就绪"
  };
  if (labels[classification]) return labels[classification];
  return failureCode === "wrong_offer" ? "不同商品" : null;
}

export function sourceCaptureFailureMessage(code, detail = "") {
  const messages = {
    extension_not_installed: "未检测到本机1688采集扩展",
    extension_background_unavailable: "1688采集扩展已安装，但后台暂未响应",
    extension_version_mismatch: "1688采集扩展版本与当前作业要求不一致",
    extension_job_unclaimed: "1688采集作业等待插件领取超时",
    service_restarted_before_claim: "评审台服务重启前，1688采集作业尚未被插件领取",
    // Capture sessions live only in the process that created them, so a restart ends any job that had not answered yet.
    capture_job_lost: "服务已重启，这次采集不会再有结果，请重新申请采集",
    unknown_outcome: "插件领取作业后中断，当前采集结果未知",
    request_origin_invalid: "1688采集请求不是来自本机评审台",
    request_payload_missing: "1688采集请求缺少必要字段",
    capture_mode_invalid: "1688采集模式无效",
    revision_invalid: "1688采集修订号无效",
    source_url_invalid: "1688来源链接不在允许范围内",
    short_link_resolution_not_allowed: "当前作业未授权解析1688短链",
    expected_offer_invalid: "1688精确链接与作业锁定的offer不一致",
    site_login_required: "1688页面需要先登录",
    site_verification_required: "1688页面要求完成人机或安全验证",
    wrong_offer: "打开的1688商品与当前候选不是同一个offer",
    short_link_resolution_failed: "1688短链没有落到可核验的商品详情页",
    structured_data_unavailable: "页面已打开，但没有取得可核验的结构化商品数据",
    sku_ambiguous: "已取得商品数据，但目标规格无法唯一对应一个SKU",
    exact_price_unavailable: "已找到目标SKU，但没有取得该SKU的直接价格",
    sku_limit_exceeded: "商品SKU数量超过安全读取上限，未进行截断或猜测",
    timeout: "等待1688页面加载超时",
    revision_conflict: "商品资料已变化，本次采集结果已拒绝",
    server_rejected: "评审台拒绝了本次采集结果",
    invalid_capture: "采集结果格式无效",
    system_error: "采集器发生系统错误，已停止"
  };
  const base = messages[code] || "1688采集已停止";
  return detail ? `${base}：${text(detail, 800)}` : base;
}

export function sanitize1688Evidence(input, expectedOfferId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_capture");
  const offerId = input.offerId;
  if (typeof offerId !== "string" || !/^\d{1,40}$/.test(offerId) || offerId !== String(expectedOfferId)) throw new Error("wrong_offer");
  const source = normalize1688CaptureSource(input.sourceUrl);
  if (source.type !== "detail" || source.offerId !== offerId) throw new Error("wrong_offer");
  const observedAt = text(input.observedAt, 80);
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) throw new Error("invalid_capture");
  const rawSkus = Array.isArray(input.skus) ? input.skus : [];
  if (!rawSkus.length) throw new Error("structured_data_unavailable");
  if (rawSkus.length > MAX_SKUS) throw new Error("sku_limit_exceeded");

  const seen = new Set();
  const skus = rawSkus.map((item) => {
    const sourceSkuId = text(item?.sourceSkuId, 160);
    if (!sourceSkuId || seen.has(sourceSkuId)) throw new Error("invalid_capture");
    seen.add(sourceSkuId);
    const priceCny = positive(item?.priceCny);
    const stockValue = nonNegative(item?.stock);
    const stock = Number.isSafeInteger(stockValue) ? stockValue : null;
    const priceSource = text(item?.priceSource, 180);
    const stockSource = text(item?.stockSource, 180);
    if (priceCny !== null && !priceSource) throw new Error("invalid_capture");
    if (stock !== null && !stockSource) throw new Error("invalid_capture");
    const weightKg = skuWeightKg(item?.weight);
    const weightSource = text(item?.weightSource, 180);
    const weightKept = weightKg !== null && weightSource !== "";
    return {
      sourceSkuId,
      propPath: text(item?.propPath, 600) || null,
      attributes: cleanObject(item?.attributes, 30),
      priceCny,
      priceSource: priceCny === null ? null : priceSource,
      stock,
      stockSource: stock === null ? null : stockSource,
      inStock: typeof item?.inStock === "boolean" ? item.inStock : stock === null ? null : stock > 0,
      weight: weightKept ? { value: weightKg, unit: "kg" } : null,
      weightSource: weightKept ? weightSource : null,
      imageUrl: canonicalSupplierImageUrl(item?.imageUrl)
    };
  });

  const priceRanges = (Array.isArray(input.priceRanges) ? input.priceRanges : [])
    .slice(0, 50)
    .map((range) => ({
      minimumQuantity: positive(range?.minimumQuantity),
      priceCny: positive(range?.priceCny),
      source: text(range?.source, 180)
    }))
    .filter((range) => range.priceCny !== null && range.source);

  const pageFields = input.pageFields && typeof input.pageFields === "object" && !Array.isArray(input.pageFields)
    ? input.pageFields
    : {};
  const unitProductPriceCny = positive(pageFields.unitProductPriceCny);
  const unitProductPriceSource = text(pageFields.unitProductPriceSource, 180);
  const unitDomesticFreightCny = nonNegative(pageFields.unitDomesticFreightCny);
  const unitDomesticFreightSource = text(pageFields.unitDomesticFreightSource, 180);
  if (unitProductPriceCny !== null && !unitProductPriceSource) throw new Error("invalid_capture");
  if (unitDomesticFreightCny !== null && !unitDomesticFreightSource) throw new Error("invalid_capture");

  return {
    offerId,
    sourceUrl: source.sourceUrl,
    title: text(input.title, 800),
    offerStatus: text(input.offerStatus, 120) || null,
    observedAt: new Date(observedAt).toISOString(),
    collectionMethod: "chrome_extension_structured_page_v1",
    titleSource: text(input.titleSource, 180) || null,
    offerIdSource: text(input.offerIdSource, 180) || null,
    pageSelectedSkuId: text(input.pageSelectedSkuId, 160) || null,
    priceRanges,
    pageFields: {
      unitProductPriceCny,
      unitProductPriceSource: unitProductPriceCny === null ? null : unitProductPriceSource,
      unitDomesticFreightCny,
      unitDomesticFreightSource: unitDomesticFreightCny === null ? null : unitDomesticFreightSource
    },
    supplierAttributes: cleanObject(input.supplierAttributes),
    skus
  };
}

function ambiguousQuantity(value) {
  const input = text(value, 3000);
  return /\d/u.test(input) && /[-,，~～〜−–—+<>≤≥≈±×*/]|(?:至|到|以上|以下|约)|\d[eE][+-]?\d/u.test(input);
}

function quantityTerms(value) {
  // Parse a whole quantity and its unit, never a substring of another quantity.
  // No unit conversion is inferred: 5cm, 15cm and 5mm remain different facts.
  const input = text(value, 3000);
  if (ambiguousQuantity(input)) return [];
  const units = /(?<![\d.a-z])\d+(?:\.\d+)?\s*(?:千克|公斤|厘米|毫米|毫升|kg|cm|mm|ml|片|件|个|只|套|支|枚|克|升|g|l)(?![a-z])/giu;
  return [...input.matchAll(units)].map(([term]) => term.toLowerCase().replace(/\s+/g, ""));
}

function desiredSkuQuantities(candidate) {
  const values = [
    candidate?.codexReview?.sourceSku?.variant,
    candidate?.codexReview?.sourceSku?.sku,
    candidate?.listingPreparation?.expectedSourceSku,
    candidate?.productName
  ].map((value) => text(value, 1000)).filter(Boolean);
  return { terms: [...new Set(values.flatMap(quantityTerms))], ambiguous: values.some(ambiguousQuantity) };
}

function skuQuantityTerms(sku) {
  // IDs and machine prop paths are not a source of human specification facts.
  const values = Object.values(sku.attributes || {});
  return values.some(ambiguousQuantity) ? null : new Set(values.flatMap(quantityTerms));
}

export function resolveCapturedSku(candidate, evidence, requestedSkuId = "") {
  const explicit = text(requestedSkuId, 160);
  if (explicit) {
    const selected = evidence.skus.find((sku) => sku.sourceSkuId === explicit) || null;
    if (!selected) return { status: "invalid_selection", choices: evidence.skus };
    if (!(selected.priceCny > 0)) return { status: "exact_price_unavailable", selected, choices: evidence.skus };
    return { status: "matched", selected, matchTerms: [], choices: evidence.skus };
  }

  const { terms, ambiguous } = desiredSkuQuantities(candidate);
  const skuQuantities = evidence.skus.map(skuQuantityTerms);
  // An ambiguous alternative is unresolved, not a proven non-match. Removing it
  // must never turn another SKU into an apparently unique automatic selection.
  const canAutoMatch = terms.length > 0 && !ambiguous && skuQuantities.every((quantities) => quantities !== null);
  const matches = canAutoMatch
    ? evidence.skus.filter((_sku, index) => terms.every((term) => skuQuantities[index].has(term)))
    : [];
  if (matches.length !== 1) {
    return { status: "needs_selection", choices: evidence.skus, matches, matchTerms: terms };
  }
  if (!(matches[0].priceCny > 0)) {
    return { status: "exact_price_unavailable", selected: matches[0], choices: evidence.skus, matchTerms: terms };
  }
  return { status: "matched", selected: matches[0], choices: evidence.skus, matchTerms: terms };
}

export function resolveCapturedSkus(evidence, requestedSkuIds = []) {
  const requested = [...new Set(
    (Array.isArray(requestedSkuIds) ? requestedSkuIds : [requestedSkuIds])
      .map((item) => text(item, 160))
      .filter(Boolean)
  )];
  if (!requested.length) return { status: "needs_selection", selected: [], choices: evidence.skus };
  const byId = new Map(evidence.skus.map((sku) => [sku.sourceSkuId, sku]));
  const selected = requested.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length !== requested.length) return { status: "invalid_selection", selected: [], choices: evidence.skus };
  return {
    status: "matched",
    selected,
    choices: evidence.skus,
    missingDirectPriceSkuIds: selected.filter((sku) => !(sku.priceCny > 0)).map((sku) => sku.sourceSkuId)
  };
}

export function sourceCaptureForDispatch(sourceCapture) {
  if (!sourceCapture || sourceCapture.status !== "verified") return null;
  const selectedSkus = Array.isArray(sourceCapture.selectedSkus)
    ? sourceCapture.selectedSkus
    : sourceCapture.selectedSku ? [sourceCapture.selectedSku] : [];
  return {
    captureId: text(sourceCapture.captureId, 100),
    status: "verified",
    offerId: text(sourceCapture.offerId, 40),
    sourceUrl: text(sourceCapture.sourceUrl, 2000),
    title: text(sourceCapture.title, 800),
    observedAt: text(sourceCapture.observedAt, 80),
    collectionMethod: text(sourceCapture.collectionMethod, 120),
    matchTerms: Array.isArray(sourceCapture.matchTerms) ? sourceCapture.matchTerms.map((item) => text(item, 100)).slice(0, 20) : [],
    selectedSkus: selectedSkus.map((sku) => {
      const weightKg = skuWeightKg(sku.weight);
      return {
        sourceSkuId: text(sku.sourceSkuId, 160),
        propPath: text(sku.propPath, 600) || null,
        attributes: cleanObject(sku.attributes, 30),
        priceCny: positive(sku.priceCny),
        priceSource: text(sku.priceSource, 180) || null,
        stock: nonNegative(sku.stock),
        stockSource: text(sku.stockSource, 180) || null,
        inStock: sku.inStock ?? null,
        weight: weightKg === null ? null : { value: weightKg, unit: "kg" },
        weightSource: weightKg === null ? null : text(sku.weightSource, 180) || null
      };
    }),
    missingDirectPriceSkuIds: selectedSkus.filter((sku) => !(sku.priceCny > 0)).map((sku) => text(sku.sourceSkuId, 160)),
    priceRanges: Array.isArray(sourceCapture.priceRanges) ? sourceCapture.priceRanges.slice(0, 50) : [],
    supplierAttributes: cleanObject(sourceCapture.supplierAttributes)
  };
}
