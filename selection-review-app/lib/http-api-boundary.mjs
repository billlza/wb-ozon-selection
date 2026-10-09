import { timingSafeEqual } from "node:crypto";

const JSON_CONTENT_TYPE_PATTERN = /^(?:application\/json|[^;/\s]+\/[^;/\s]+\+json)(?:\s*;.*)?$/i;
const CHROME_EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_FETCH_SITES = new Set(["same-origin", "none"]);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function boundaryError(status, message, code) {
  return Object.assign(new Error(message), { status, extra: code ? { code } : {} });
}

function responseStatus(error) {
  const status = Number(error?.status || 500);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export function normalizeHttpErrorResponse(error) {
  const status = responseStatus(error);
  if (status >= 500) {
    return Object.freeze({
      status,
      body: Object.freeze({ message: "服务器错误" }),
      shouldLogStack: true
    });
  }
  return Object.freeze({
    status,
    body: Object.freeze({
      message: error?.message || "请求无效",
      ...(error?.extra || {})
    }),
    shouldLogStack: false
  });
}

function normalizeOrigin(value, label = "origin") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw boundaryError(403, `${label}无效`, "api_origin_invalid");
  }
  const pathSegment = parsed.pathname || "/";
  if (parsed.username || parsed.password || pathSegment !== "/" || parsed.search || parsed.hash) {
    throw boundaryError(403, `${label}必须是纯origin`, "api_origin_invalid");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeChromeExtensionOrigin(value) {
  const origin = normalizeOrigin(value, "extensionOrigin");
  if (!CHROME_EXTENSION_ORIGIN_PATTERN.test(origin)) {
    throw boundaryError(403, "Chrome扩展来源无效", "extension_origin_invalid");
  }
  return origin;
}

export function normalizeAllowedChromeExtensionOrigins(values = []) {
  const origins = Array.isArray(values) ? values : String(values || "").split(",");
  return Object.freeze([
    ...new Set(
      origins
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .map((entry) => normalizeChromeExtensionOrigin(entry))
    )
  ]);
}

function hostFromOrigin(origin) {
  return new URL(origin).host.toLowerCase();
}

function normalizeHost(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || /[\u0000-\u001f\s/@?#]/.test(raw)) {
    throw boundaryError(400, "请求Host无效", "api_host_invalid");
  }
  try {
    return new URL(`http://${raw}`).host.toLowerCase();
  } catch {
    throw boundaryError(400, "请求Host无效", "api_host_invalid");
  }
}

export function parseHttpRequestTarget(rawTarget, hostHeader, { fallbackHost = "127.0.0.1:4317" } = {}) {
  const host = normalizeHost(hostHeader || fallbackHost);
  let requestUrl;
  try {
    requestUrl = new URL(String(rawTarget || "/"), `http://${host}`);
  } catch {
    throw boundaryError(400, "请求路径无效", "request_target_invalid");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch (error) {
    if (error instanceof URIError) {
      throw boundaryError(400, "请求路径编码无效", "request_path_encoding_invalid");
    }
    throw error;
  }
  if (!pathname.startsWith("/") || /[\u0000-\u001f\u007f]/.test(pathname)) {
    throw boundaryError(400, "请求路径无效", "request_path_invalid");
  }
  return Object.freeze({ requestUrl, pathname });
}

function isExtensionEndpoint(pathname) {
  return pathname === "/api/extension/heartbeat" ||
    /^\/api\/extension\/capture-jobs\/[A-Za-z0-9_-]{1,160}\/claim$/.test(String(pathname || "")) ||
    /^\/api\/candidates\/[^/]+\/(?:source-capture|sales-capture|image-match)\/result$/.test(String(pathname || ""));
}

function isBinaryBodyEndpoint(pathname) {
  return /^\/api\/candidates\/[^/]+\/lifecycle\/c2\/final-assets\/upload$/.test(String(pathname || ""));
}

function assertJsonContentType(headers) {
  const contentType = String(headers["content-type"] || "").trim();
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw boundaryError(415, "写请求必须使用application/json", "json_content_type_required");
  }
}

export function isTrustedInternalApiRequest(headers, expectedToken) {
  if (!expectedToken) return false;
  const provided = String(headers["x-selection-review-internal-token"] || "");
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(String(expectedToken));
  return providedBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(providedBuffer, expectedBuffer);
}

export function assertTrustedApiRequest({
  method,
  pathname,
  headers = {},
  trustedServiceOrigins = [],
  allowedReviewOrigins = [],
  allowedExtensionOrigins = [],
  internalRequestToken = ""
}) {
  const host = normalizeHost(headers.host);
  const trustedHosts = new Set(
    [...trustedServiceOrigins, ...allowedReviewOrigins]
      .filter(Boolean)
      .map((origin) => hostFromOrigin(normalizeOrigin(origin, "trustedOrigin")))
  );
  if (!trustedHosts.has(host)) {
    throw boundaryError(403, "请求Host不在评审台可信来源内", "api_host_forbidden");
  }

  const upperMethod = String(method || "").toUpperCase();
  const origin = headers.origin ? normalizeOrigin(headers.origin, "origin") : "";
  const fetchSite = String(headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (!MUTATING_METHODS.has(upperMethod) && upperMethod !== "OPTIONS") return true;
  if (MUTATING_METHODS.has(upperMethod) && !isBinaryBodyEndpoint(pathname)) {
    assertJsonContentType(headers);
  }

  if (isTrustedInternalApiRequest(headers, internalRequestToken)) return true;

  if (isExtensionEndpoint(pathname)) {
    const allowed = new Set(allowedExtensionOrigins.map((entry) => normalizeChromeExtensionOrigin(entry)));
    if (!origin || !allowed.has(origin)) {
      throw boundaryError(403, "只接受已配置的本机Chrome扩展来源", "extension_origin_forbidden");
    }
    return true;
  }

  if (!origin) {
    throw boundaryError(403, "写请求必须来自评审台页面来源", "api_origin_required");
  }
  const allowed = new Set(allowedReviewOrigins.map((entry) => normalizeOrigin(entry, "allowedOrigin")));
  if (!allowed.has(origin)) {
    throw boundaryError(403, "写请求拒绝非评审台页面来源", "api_origin_forbidden");
  }
  if (!fetchSite || !SAFE_FETCH_SITES.has(fetchSite)) {
    throw boundaryError(403, "写请求拒绝跨站浏览器来源", "api_fetch_site_forbidden");
  }
  return true;
}

export async function readJsonRequestBody(req, { maxBytes = 2_000_000, requireJsonContentType = false } = {}) {
  const declaredLength = Number(req?.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw boundaryError(413, "请求内容过大", "request_body_too_large");
  }
  const contentType = String(req?.headers?.["content-type"] || "").trim();
  if (requireJsonContentType && !JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw boundaryError(415, "写请求必须使用application/json", "json_content_type_required");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw boundaryError(413, "请求内容过大", "request_body_too_large");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw boundaryError(415, "写请求必须使用application/json", "json_content_type_required");
  }
  let raw;
  try {
    raw = TEXT_DECODER.decode(Buffer.concat(chunks, bytes));
  } catch {
    throw boundaryError(400, "请求正文不是完整UTF-8", "request_body_utf8_invalid");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw boundaryError(400, "请求不是有效JSON", "request_body_json_invalid");
  }
}
