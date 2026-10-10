import { canonicalImageSearchSourceUrl, classifySupplierSource, imageSearchUrl, normalizeOzonSearchQuery, ozonSearchUrl } from "./source-routing.js";

export const SUPPLIER_CAPTURE_REQUEST_TYPE = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
export const SUPPLIER_CAPTURE_MODE = "a_supplier_capture";
export const IMAGE_MATCH_REQUEST_TYPE = "SELECTION_REVIEW_1688_IMAGE_MATCH_REQUEST";
export const IMAGE_MATCH_MODE = "a_supplier_image_match";
export const IMAGE_MATCH_MAX_RESULTS = 20;
export const OZON_IMAGE_MATCH_REQUEST_TYPE = "SELECTION_REVIEW_OZON_IMAGE_MATCH_REQUEST";
export const OZON_IMAGE_MATCH_MODE = "ozon_same_product_match";
export const OZON_IMAGE_MATCH_MAX_RESULTS = 36;
export function isImageMatchJob(payload) {
  return payload?.mode === IMAGE_MATCH_MODE;
}
export function isOzonImageMatchJob(payload) {
  return payload?.mode === OZON_IMAGE_MATCH_MODE;
}
export function isOzonCaptureJob(payload) {
  return typeof payload?.productUrl === "string" && typeof payload?.expectedProductId === "string";
}

export function isReviewSender(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "http://127.0.0.1:4317" && !url.username && !url.password;
  } catch { return false; }
}

export function validateCaptureStartSignal(message) {
  const valid = message && typeof message === "object" && !Array.isArray(message) &&
    Object.keys(message).length === 2 &&
    [SUPPLIER_CAPTURE_REQUEST_TYPE, "SELECTION_REVIEW_OZON_CAPTURE_REQUEST", IMAGE_MATCH_REQUEST_TYPE, OZON_IMAGE_MATCH_REQUEST_TYPE]
      .includes(message.type) &&
    typeof message.captureId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(message.captureId);
  return valid ? { ok: true } : { ok: false, code: "start_signal_invalid" };
}

export function canonicalOzonCaptureSource(value, expectedProductId) {
  if (typeof value !== "string" || typeof expectedProductId !== "string" || !/^\d{7,}$/.test(expectedProductId)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.ozon.ru" || url.username || url.password || url.port) return null;
    const productId = url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})\/?$/)?.[1];
    return productId === expectedProductId ? `https://www.ozon.ru/product/${productId}/` : null;
  } catch { return null; }
}

// A capture id is minted by the service as SCJ-<uuid>. A candidate id carries its record type as a prefix —
// `candidate:2e417eaf-…` — so the colon is part of the real shape, not something to defend against. Demanding the
// capture id's charset from it made every real supplier job arrive invalid and be dropped before a page was opened
// (owner, four capture attempts on 2026-09-11/12). Both patterns still exclude whitespace, slashes and separators.
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,160}$/;

function validJobIdentity(payload) {
  return typeof payload.captureId === "string" && CAPTURE_ID_PATTERN.test(payload.captureId) &&
    typeof payload.candidateId === "string" && CANDIDATE_ID_PATTERN.test(payload.candidateId) &&
    typeof payload.token === "string" && payload.token.length > 0 && payload.token.length <= 512;
}

export function validateOzonCaptureRequest({ payload, manifestVersion = "" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !validJobIdentity(payload)) return { ok: false, code: "request_payload_missing" };
  if (payload.mode !== undefined || payload.sourceUrl !== undefined) return { ok: false, code: "capture_mode_invalid" };
  if (!Number.isSafeInteger(payload.dataRevision) || payload.dataRevision < 0) return { ok: false, code: "revision_invalid" };
  if (payload.attempt !== undefined && payload.attempt !== 1) return { ok: false, code: "attempt_invalid" };
  if (payload.requiredExtensionVersion !== undefined && payload.requiredExtensionVersion !== manifestVersion) return { ok: false, code: "extension_version_mismatch" };
  const sourceUrl = canonicalOzonCaptureSource(payload.productUrl, payload.expectedProductId);
  return sourceUrl ? { ok: true, sourceUrl } : { ok: false, code: "source_url_invalid" };
}

/**
 * 1688 找同款作业：只搜服务端锁定的那一张首图（拼多多、1688 或 Ozon 图床），搜索地址必须就是由这张图拼出来的那一个。
 * 不带 sourceUrl、productUrl、expectedProductId，所以既不会被当成供应采集，也不会被当成 Ozon 读页面。
 */
export function validateImageMatchRequest({ payload, manifestVersion = "" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !validJobIdentity(payload)) return { ok: false, code: "request_payload_missing" };
  if (payload.mode !== IMAGE_MATCH_MODE || payload.sourceUrl !== undefined || payload.productUrl !== undefined ||
      payload.expectedProductId !== undefined) return { ok: false, code: "capture_mode_invalid" };
  if (!Number.isSafeInteger(payload.dataRevision) || payload.dataRevision < 0) return { ok: false, code: "revision_invalid" };
  if (payload.attempt !== 1) return { ok: false, code: "attempt_invalid" };
  if (payload.requiredExtensionVersion !== manifestVersion || !manifestVersion) return { ok: false, code: "extension_version_mismatch" };
  if (payload.maxResults !== IMAGE_MATCH_MAX_RESULTS) return { ok: false, code: "request_payload_missing" };
  const imageUrl = canonicalImageSearchSourceUrl(payload.imageUrl);
  const searchUrl = imageSearchUrl(payload.imageUrl);
  if (!imageUrl || imageUrl !== payload.imageUrl || !searchUrl || searchUrl !== payload.searchUrl) return { ok: false, code: "image_url_invalid" };
  return { ok: true, imageUrl, searchUrl };
}

/**
 * 在 Ozon 找同款作业：只在 Ozon 站内搜服务端锁定的那几个词，搜索地址必须就是由这几个词拼出来的那一个。
 * 不带 sourceUrl、productUrl、expectedProductId、imageUrl，所以不会被当成别的作业。
 */
export function validateOzonImageMatchRequest({ payload, manifestVersion = "" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !validJobIdentity(payload)) return { ok: false, code: "request_payload_missing" };
  if (payload.mode !== OZON_IMAGE_MATCH_MODE || payload.sourceUrl !== undefined || payload.productUrl !== undefined ||
      payload.expectedProductId !== undefined || payload.imageUrl !== undefined) return { ok: false, code: "capture_mode_invalid" };
  if (!Number.isSafeInteger(payload.dataRevision) || payload.dataRevision < 0) return { ok: false, code: "revision_invalid" };
  if (payload.attempt !== 1) return { ok: false, code: "attempt_invalid" };
  if (payload.requiredExtensionVersion !== manifestVersion || !manifestVersion) return { ok: false, code: "extension_version_mismatch" };
  if (payload.maxResults !== OZON_IMAGE_MATCH_MAX_RESULTS) return { ok: false, code: "request_payload_missing" };
  const query = normalizeOzonSearchQuery(payload.query);
  const searchUrl = ozonSearchUrl(payload.query);
  if (!query || query !== payload.query || !searchUrl || searchUrl !== payload.searchUrl) return { ok: false, code: "search_query_invalid" };
  return { ok: true, query, searchUrl };
}

const ERROR_MESSAGES = Object.freeze({
  request_origin_invalid: "采集请求不是来自本机评审台",
  request_payload_missing: "采集请求缺少必要字段",
  capture_mode_invalid: "采集模式无效",
  revision_invalid: "采集修订号无效",
  extension_version_mismatch: "采集作业要求的插件版本与当前版本不一致",
  source_url_invalid: "1688或拼多多来源链接不在允许范围内",
  short_link_resolution_not_allowed: "当前作业未授权解析1688或拼多多短链",
  expected_offer_invalid: "精确商品链接与作业锁定的商品编号不一致",
  image_url_invalid: "找同款要搜的首图或搜索地址不在允许范围内",
  search_query_invalid: "在 Ozon 找同款要搜的词或搜索地址不在允许范围内"
});

export function captureRequestErrorMessage(code) {
  return ERROR_MESSAGES[code] || "采集请求未通过安全校验";
}

export function validateSupplierCaptureRequest({ payload, senderUrl = "", manifestVersion = "" } = {}) {
  if (senderUrl && !isReviewSender(senderUrl)) {
    return { ok: false, code: "request_origin_invalid" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "request_payload_missing" };
  }
  if (!validJobIdentity(payload) || typeof payload.sourceUrl !== "string") {
    return { ok: false, code: "request_payload_missing" };
  }
  if (payload.mode !== SUPPLIER_CAPTURE_MODE) {
    return { ok: false, code: "capture_mode_invalid" };
  }
  if (!Number.isSafeInteger(payload.dataRevision) || payload.dataRevision < 0) {
    return { ok: false, code: "revision_invalid" };
  }
  if (payload.attempt !== 1) return { ok: false, code: "attempt_invalid" };
  if (payload.requiredExtensionVersion !== manifestVersion || !manifestVersion) {
    return { ok: false, code: "extension_version_mismatch" };
  }
  const source = classifySupplierSource(payload.sourceUrl);
  if (!source) return { ok: false, code: "source_url_invalid" };
  if (typeof payload.expectedOfferId !== "string") return { ok: false, code: "expected_offer_invalid" };
  if (source.type === "short") {
    if (payload.allowShortLinkResolution !== true || String(payload.expectedOfferId || "").trim()) {
      return { ok: false, code: "short_link_resolution_not_allowed" };
    }
  } else if (String(payload.expectedOfferId || "") !== source.offerId) {
    return { ok: false, code: "expected_offer_invalid" };
  }
  return { ok: true, source };
}
