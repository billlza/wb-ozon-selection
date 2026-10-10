import { createHash } from "node:crypto";

export class SeerfarTransportError extends Error {
  constructor(code, { httpStatus = null, failureStage = null } = {}) {
    if (!['credential_missing','credential_access_denied','network_timeout','network_error','schema_error','login_required','quota_or_rate_limit','provider_server_error','stale_result'].includes(code)) throw new TypeError('SEERFAR_ERROR_CODE_INVALID');
    super(code); this.name='SeerfarTransportError'; this.code=code; this.httpStatus=httpStatus; this.failureStage=failureStage;
  }
}
export const SEERFAR_OPEN_API_BASE = "https://api.seerfar.cn";
export const SEERFAR_MIN_INTERVAL_MS = 3000;
const PATHS = Object.freeze({
  quota: "/open-api/quota",
  product_detail: { ozon: "/open-api/product/detail/search/ozon", wb: "/open-api/product/detail/search/wb" },
  category_detail: { ozon: "/open-api/category/detail/search/ozon", wb: "/open-api/category/detail/search/wb" },
  reverse_keywords: { ozon: "/open-api/keyword/backSearch/ozon", wb: "/open-api/keyword/backSearch/wb" }
});
const SECRET_FIELD = /(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i;

function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function iso(v) { return nonEmpty(v) && !Number.isNaN(Date.parse(v)); }
function safeRef(value) { return createHash("sha256").update(String(value)).digest("hex").slice(0, 20); }
function assertNoSecrets(value, path = "value") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`SEERFAR_TRANSPORT_SECRET_FIELD_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}
function walk(value, visit) { visit(value); if (Array.isArray(value)) value.forEach((x) => walk(x, visit)); else if (isObject(value)) Object.values(value).forEach((x) => walk(x, visit)); }
function records(body) {
  let found = null;
  walk(body?.data, (value) => {
    if (found || !isObject(value)) return;
    for (const key of ["records", "productList"]) if (Array.isArray(value[key])) { found = value[key]; break; }
  });
  return found;
}
function quotaRemaining(body) {
  let remaining = null, limit = null, used = null;
  walk(body?.data, (value) => {
    if (!isObject(value)) return;
    for (const [key, raw] of Object.entries(value)) {
      if (!Number.isFinite(raw)) continue;
      const k = key.toLowerCase();
      if (["remaining", "remain", "balance", "available"].includes(k)) remaining = raw;
      if (["creditlimit", "quota", "total"].includes(k)) limit = raw;
      if (["creditused", "used", "usage"].includes(k)) used = raw;
    }
  });
  if (remaining === null && Number.isFinite(limit) && Number.isFinite(used)) remaining = limit - used;
  return Number.isFinite(remaining) ? remaining : null;
}
function range() { return { min: null, max: null }; }
// The provider's own filter slots and their units: price is RUB, weight is grams, volume is litres and
// monthlySales counts units in the response date window. Owner conditions are copied into the slot as
// given; no unit conversion, no rounding and no extra slot is filled from a declared one.
const CATEGORY_FILTER_SLOTS = Object.freeze({ priceRub: "price", weightGrams: "weight", volumeLitres: "volume", salesCount: "monthlySales" });
function filterBound(value) { return value === null || Number.isFinite(value) && value >= 0; }
function categoryFilterSlots(filters) {
  if (filters === undefined || filters === null) return {};
  if (!isObject(filters) || Object.keys(filters).length === 0 ||
    Object.keys(filters).some((key) => !Object.hasOwn(CATEGORY_FILTER_SLOTS, key))) throw new Error("SEERFAR_CATEGORY_FILTERS_INVALID");
  const slots = {};
  for (const [key, slot] of Object.entries(CATEGORY_FILTER_SLOTS)) {
    if (!Object.hasOwn(filters, key)) continue;
    const declared = filters[key];
    if (!isObject(declared) || Object.keys(declared).length !== 2 || !Object.hasOwn(declared, "min") || !Object.hasOwn(declared, "max") ||
      !filterBound(declared.min) || !filterBound(declared.max) || declared.min === null && declared.max === null ||
      declared.min !== null && declared.max !== null && declared.min > declared.max) throw new Error("SEERFAR_CATEGORY_FILTERS_INVALID");
    slots[slot] = { min: declared.min, max: declared.max };
  }
  return slots;
}
/** Read back from the payload that was actually sent, so the echo cannot drift from the request. */
function appliedCategoryFilters(payload) {
  const entries = Object.entries(CATEGORY_FILTER_SLOTS)
    .filter(([, slot]) => payload[slot].min !== null || payload[slot].max !== null)
    .map(([key, slot]) => [key, { min: payload[slot].min, max: payload[slot].max }]);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function marketSchema(condition) {
  if (!condition) throw new SeerfarTransportError('schema_error');
}
function marketText(value, max) {
  return nonEmpty(value) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function marketUrl(value) {
  marketSchema(marketText(value, 2048));
  let url;
  try { url = new URL(value); }
  catch (error) { if (error instanceof TypeError) throw new SeerfarTransportError('schema_error'); throw error; }
  marketSchema(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash);
  return url;
}
function marketMetric(row, field, integer = false) {
  if (!Object.hasOwn(row, field) || row[field] === null) return null;
  marketSchema(Number.isFinite(row[field]) && row[field] >= 0 && (!integer || Number.isSafeInteger(row[field])));
  return row[field];
}
const MARKET_DIMENSION_MM = /^\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?$/;
// The provider writes the three sides as one millimetre string; real responses use the multiplication sign
// ("487×223×1498", 2026-07-27 capture) while fixtures use "600x450x150". Both separators are accepted; the string is kept literal:
// no unit conversion, no reordering and no guess about which side is length.
function marketDimension(row) {
  if (!Object.hasOwn(row, 'dimension') || row.dimension === null) return null;
  marketSchema(typeof row.dimension === 'string' && row.dimension.length <= 64 && MARKET_DIMENSION_MM.test(row.dimension.trim()));
  return row.dimension.trim();
}
function marketDate(value) {
  if (value === undefined || value === null) return null;
  marketSchema(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  return value;
}
function marketCategory(info) {
  if (info === undefined || info === null) return null;
  marketSchema(isObject(info) && Array.isArray(info.fullCategoryId) && info.fullCategoryId.length > 0 &&
    info.fullCategoryId.length <= 20 && info.fullCategoryId.every(id => marketText(id, 64)));
  const paths = {};
  for (const field of ['titlePath', 'cnTitlePath', 'enTitlePath']) {
    marketSchema(marketText(info[field], 2000));
    paths[field] = info[field];
  }
  return { fullCategoryId: [...info.fullCategoryId], ...paths };
}
// The recovered category responses use data.productList. Do not borrow the keyword
// container search or guess that product_detail has this same contract.
function categoryMarketResult(body, platform, payload, evidenceRef) {
  marketSchema(isObject(body.data) && typeof body.data.id === 'string' && body.data.id === payload.categoryId &&
    Array.isArray(body.data.productList) &&
    body.data.productList.length <= payload.page.pageSize && typeof body.data.hasNextPage === 'boolean' &&
    (body.data.productList.length > 0 || body.data.hasNextPage === false));
  const marketProducts = body.data.productList.map((row, index) => {
    marketSchema(isObject(row) && Number.isSafeInteger(row.sku) && row.sku > 0 && marketText(row.title, 2000));
    const productId = String(row.sku), url = marketUrl(row.productUrl);
    marketSchema(platform === 'ozon'
      ? url.hostname === 'www.ozon.ru' && url.pathname === `/product/${productId}`
      : url.hostname === 'www.wildberries.ru' && url.pathname === `/catalog/${productId}/detail.aspx`);
    marketUrl(row.imageUrl);
    marketSchema(Number.isFinite(row.price) && row.price > 0);
    return { productId, platform, productUrl: row.productUrl, title: row.title, imageUrl: row.imageUrl,
      price: row.price, currency: null, salesCount: marketMetric(row, 'sales', true), revenue: marketMetric(row, 'revenue'),
      categoryPath: marketCategory(row.categoryInfo), sellerIdentity: 'unknown',
      reviewCount: marketMetric(row, 'reviewCount', true), reviewRating: marketMetric(row, 'reviewRating'),
      rawSellerType: marketMetric(row, 'sellerType', true),
      // The provider declares weight in grams and volume in litres; both stay in the provider's own unit here.
      weightGrams: marketMetric(row, 'weight'), volumeLitres: marketMetric(row, 'volume'), dimensionMm: marketDimension(row),
      providerRecordRef: `${evidenceRef}#product-${index}` };
  });
  marketSchema(new Set(marketProducts.map(row => row.productId)).size === marketProducts.length);
  const dateRange = { startDate: marketDate(body.data.startDate), endDate: marketDate(body.data.endDate) };
  marketSchema(dateRange.startDate === null || dateRange.endDate === null || dateRange.startDate <= dateRange.endDate);
  return { marketProducts, dateRange, appliedFilters: appliedCategoryFilters(payload),
    collection: { pageNumber: payload.page.pageNumber, pageSize: payload.page.pageSize, hasNextPage: body.data.hasNextPage } };
}

export function buildSeerfarProductPayload({ platform, sku, dateRange }) {
  if (!["ozon", "wb"].includes(platform) || !nonEmpty(sku) || !nonEmpty(dateRange)) throw new Error("SEERFAR_PRODUCT_INPUT_INVALID");
  const payload = { sku, dateRange };
  if (platform === "wb") payload.includeFbs = true;
  return payload;
}

export function buildSeerfarCategoryPayload({ platform, categoryId, fulfillment, filters = null }) {
  if (!["ozon", "wb"].includes(platform) || !nonEmpty(categoryId) || !nonEmpty(fulfillment)) throw new Error("SEERFAR_CATEGORY_INPUT_INVALID");
  if (platform === "ozon" && !/^\d+(?:_\d+)+$/.test(categoryId)) throw new Error("SEERFAR_OZON_CATEGORY_ID_NOT_COMPOSITE");
  const slots = categoryFilterSlots(filters);
  const payload = {
    categoryId, date: null, reviewCount: range(), reviewRating: range(), questionsAndAnswers: range(), price: range(),
    monthlyRevenue: range(), monthlySales: range(), monthlySalesRate: range(), weight: range(), volume: range(), grossMargin: range(), variants: range(),
    creationDate: null, fulfillment, skus: [], sellerName: [], brand: { type: 0, brandName: [] }, keywords: [],
    page: { pageNumber: 1, pageSize: 20, orders: [{ field: "revenue", direction: "DESC" }] }
  };
  if (platform === "ozon") Object.assign(payload, { drr: range(), convToCartPdp: range(), returnCancellationRate: range(), labels: [], filterRemoveProduct: true, tag: "" });
  // Declared conditions replace their own empty slot in place; every other slot stays an empty range.
  Object.assign(payload, slots);
  return payload;
}

export function buildSeerfarReversePayload({ skuIds }) {
  if (!Array.isArray(skuIds) || skuIds.length === 0 || skuIds.length > 20 || skuIds.some((x) => !(nonEmpty(x) || Number.isInteger(x)))) throw new Error("SEERFAR_REVERSE_SKUS_INVALID");
  const names = ["uniqQueriesWCa", "ca", "searchVolume", "searchChange30", "naturalRank", "adRank", "titleDensity", "wordCount", "products", "adRivalCount", "productViews", "conversionSharing", "sellers", "exposure", "conversion", "marketSpace"];
  return { ...Object.fromEntries(names.map((name) => [name, range()])), includeKeywords: [], excludeKeywords: [], type: [], matchType: 0,
    skuIds: skuIds.map((x) => typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x), historyDate: "", hasVariant: 0, page: { pageNumber: 1, pageSize: "100" } };
}

function endpoint(operation, platform) {
  if (operation === "quota") return { method: "GET", path: PATHS.quota, endpointCategory: "quota" };
  if (!PATHS[operation]?.[platform]) throw new Error("SEERFAR_ENDPOINT_NOT_ALLOWED");
  return { method: "POST", path: PATHS[operation][platform], endpointCategory: operation };
}
function payloadFor(plan, request) {
  if (plan.operation === "product_detail") return buildSeerfarProductPayload({ platform: request.targetPlatform, sku: request.exactSku, dateRange: plan.dateRange });
  if (plan.operation === "category_detail") return buildSeerfarCategoryPayload({ platform: request.targetPlatform, categoryId: plan.categoryId, fulfillment: request.fulfillment, filters: plan.filters ?? null });
  if (plan.operation === "reverse_keywords") return buildSeerfarReversePayload({ skuIds: plan.skuIds });
  throw new Error("SEERFAR_OPERATION_INVALID");
}

function failureObservation(error, base) {
  const code = error?.code;
  const serverLike = ["provider_or_schema_error", "provider_error", "schema_error", "http_error"].includes(error?.failureKind);
  return { ...base, completed: false, completedAt: null, resultCount: null,
    loginRequired: code === "login_required", quotaExceeded: code === "quota_or_rate_limit", timeout: code === "network_timeout", networkError: code === "network_error",
    stale: code === "stale_result", httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : (code === "provider_server_error" || serverLike) ? 500 : null,
    failureKind: ["login_required", "quota_or_rate_limit", "network_timeout", "network_error", "stale_result"].includes(code) ? code : error?.failureKind ?? "provider_or_schema_error" };
}

export function createSeerfarOpenApiTransport({ httpTransport, secretProvider, clock = { now: () => Date.now() }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), minIntervalMs = SEERFAR_MIN_INTERVAL_MS, onStepResult = null } = {}) {
  if (typeof httpTransport !== "function" || typeof secretProvider !== "function" || typeof clock?.now !== "function" || typeof sleep !== "function" || (onStepResult !== null && typeof onStepResult !== "function")) throw new Error("SEERFAR_TRANSPORT_DEPENDENCY_INVALID");
  let lastRequestAt = null;
  let transportCalls = 0;
  async function call({ method, path, body, token, step }) {
    if (!Object.values(PATHS).some((entry) => typeof entry === "string" ? entry === path : Object.values(entry).includes(path))) throw new Error("SEERFAR_ENDPOINT_NOT_ALLOWED");
    const now = clock.now();
    if (lastRequestAt !== null) { const wait = minIntervalMs - (now - lastRequestAt); if (wait > 0) await sleep(wait); }
    lastRequestAt = clock.now();
    const response = await httpTransport({ url: `${SEERFAR_OPEN_API_BASE}${path}`, method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body, redirect: "error", attempt: 1, step });
    if (!isObject(response) || !Number.isInteger(response.status) || !isObject(response.json) || !nonEmpty(response.requestId) || !iso(response.completedAt)) throw new SeerfarTransportError("schema_error");
    try { assertNoSecrets(response.json, "response"); }
    catch (error) { if (!(error instanceof Error) || !error.message.startsWith("SEERFAR_TRANSPORT_SECRET_FIELD_FORBIDDEN:")) throw error; throw new SeerfarTransportError("schema_error"); }
    if ([401, 403, 429].includes(response.status) || response.status >= 500) throw new SeerfarTransportError([401,403].includes(response.status)?"login_required":response.status===429?"quota_or_rate_limit":"provider_server_error",{httpStatus:response.status});
    if (response.status < 200 || response.status >= 300 || response.json.code !== 200) throw new SeerfarTransportError(response.json.code === 429 ? "quota_or_rate_limit" : "provider_server_error",{httpStatus:response.json.code === 429 ? 429 : 500});
    return response;
  }
  return async function seerfarOpenApiTransport(request) {
    transportCalls += 1;
    if (transportCalls > 1 || request?.attemptLimit !== 1) throw new Error("SEERFAR_TRANSPORT_ATTEMPT_LIMIT_EXCEEDED");
    assertNoSecrets(request, "request");
    const plan = request?.seerfarRequest;
    if (!isObject(plan) || !["product_detail", "category_detail", "reverse_keywords"].includes(plan.operation) || plan.platform !== request.targetPlatform) throw new Error("SEERFAR_REQUEST_PLAN_INVALID");
    const target = endpoint(plan.operation, plan.platform);
    const payload = payloadFor(plan, request);
    const base = { attemptId: plan.attemptId, provider: "seerfar-open-api", queryId: plan.queryId, requestId: null, receiptId: plan.receiptId ?? null, startedAt: plan.startedAt, traceRef: `seerfar:${target.endpointCategory}:${safeRef(plan.queryId)}` };
    const token = await secretProvider();
    if (!nonEmpty(token)) throw new SeerfarTransportError('credential_missing');
    let before = null, after = null, targetResponse = null, returned = null, market = null;
    let failureStage = "quota_before";
    try {
      before = await call({ ...endpoint("quota"), body: null, token, step: "quota_before" });
      if (onStepResult !== null) await onStepResult({ step: 'quota_before', requestId: before.requestId,
        completedAt: before.completedAt, evidenceRef: `${base.traceRef}:quota-before`, remainingPoints: quotaRemaining(before.json) });
      failureStage = "target_request";
      targetResponse = await call({ ...target, body: payload, token, step: target.endpointCategory });
      if (plan.operation === 'category_detail') {
        market = categoryMarketResult(targetResponse.json, plan.platform, payload, base.traceRef);
        returned = market.marketProducts;
      } else {
        returned=records(targetResponse.json);
        if(!Array.isArray(returned)||returned.some(row=>!isObject(row)||plan.operation==='reverse_keywords'&&!nonEmpty(row.query))) throw new SeerfarTransportError('schema_error');
      }
      if (onStepResult !== null) await onStepResult({ step: target.endpointCategory, requestId: targetResponse.requestId,
        completedAt: targetResponse.completedAt, evidenceRef: base.traceRef,
        ...(market === null ? { resultCount: returned.length } : market) });
      failureStage = "quota_after";
      after = await call({ ...endpoint("quota"), body: null, token, step: "quota_after" });
      if (onStepResult !== null) await onStepResult({ step: 'quota_after', requestId: after.requestId,
        completedAt: after.completedAt, evidenceRef: `${base.traceRef}:quota-after`, remainingPoints: quotaRemaining(after.json) });
    } catch (error) {
      if (!(error instanceof SeerfarTransportError)) throw error;
      error.failureStage=failureStage;
      if (error.code === 'schema_error') throw error;
      return { observation: failureObservation(error, { ...base, failureStage, requestId: targetResponse?.requestId ?? before?.requestId ?? null, receiptId: plan.receiptId ?? null }), candidates: [], pointsBefore: quotaRemaining(before?.json), pointsAfter: null, pointsSpent: null,
        evidence: { endpointCategory: target.endpointCategory, evidenceRef: base.traceRef, dataObservedAt: targetResponse?.completedAt ?? null, requestIds: [before?.requestId, targetResponse?.requestId].filter(Boolean), quotaBefore: quotaRemaining(before?.json), quotaAfter: null, pointsSpent: null, unknownFields: ["quotaAfter", "pointsSpent"] } };
    }
    const candidates = plan.operation === "reverse_keywords" ? returned.map((x, index) => ({ term: x.query.trim(), sourceRefs: [], factRefs: structuredClone(plan.factRefs ?? []), competitorRefs: structuredClone(plan.competitorRefs ?? []), sourceTrust: "seerfar_open_api", matchType: plan.matchType ?? "exact_match", providerRecordRef: `${base.traceRef}#record-${index}` })) : [];
    const beforePoints = quotaRemaining(before.json), afterPoints = quotaRemaining(after.json);
    const spent = Number.isFinite(beforePoints) && Number.isFinite(afterPoints) ? beforePoints - afterPoints : null;
    const explicitEmpty = returned.length === 0;
    return { observation: { ...base, requestId: targetResponse.requestId, receiptId: plan.receiptId ?? null, completed: true, completedAt: targetResponse.completedAt, resultCount: market === null ? candidates.length : market.marketProducts.length }, candidates,
      ...(market === null ? {} : market),
      pointsBefore: beforePoints, pointsAfter: afterPoints, pointsSpent: spent,
      evidence: { endpointCategory: target.endpointCategory, evidenceRef: base.traceRef, dataObservedAt: targetResponse.completedAt, requestIds: [before.requestId, targetResponse.requestId, after.requestId], quotaBefore: beforePoints, quotaAfter: afterPoints, pointsSpent: spent, unknownFields: [beforePoints, afterPoints, spent].some((x) => x === null) ? ["quota_or_points"] : [] },
      explicitEmpty };
  };
}
