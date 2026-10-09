import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';

/**
 * Seerfar member-website route for A-stage market discovery (owner decision 2026-09-10): the owner's own browser session
 * runs the 热销榜单选品 search, the extension captures the page's search response, and this contract turns those raw
 * records into strict market products for the A importer. It is not the Open API contract (no quota steps, no point
 * cost) and must never be re-labelled as one.
 */
export const SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION = 'seerfar-member-web-discovery-v1';
export const SEERFAR_WEB_DISCOVERY_PROVIDER = 'seerfar_web';
export const SEERFAR_WEB_SEARCH_PAGE = 'https://www.seerfar.cn/admin/product-search';
export const SEERFAR_WEB_SEARCH_ENDPOINT = 'https://www.seerfar.cn/product-report/product/search';
export const SEERFAR_WEB_PAGE_SIZE = 20;
export const SEERFAR_WEB_SELLER_TYPES = Object.freeze(['cross_border', 'local', 'all']);
export const SEERFAR_WEB_DATE_RANGES = Object.freeze(['last_30_days']);
/** Raw sellerType observed on 2026-09-10 for rows filtered as 跨境卖家; other values stay unmapped. */
export const SEERFAR_WEB_RAW_SELLER_TYPE_CROSS_BORDER = 1;
export const SEERFAR_WEB_FULFILLMENTS = Object.freeze(['FBP', 'RFBS', 'FBS', 'FBO']);

export class SeerfarWebDiscoveryContractError extends Error {
  constructor(code, detail = null) {
    super(`A_DISCOVERY_WEB_${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'SeerfarWebDiscoveryContractError';
    this.code = code;
  }
}
const closed = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const requireValue = (value, code, detail) => { if (!value) throw new SeerfarWebDiscoveryContractError(code, detail); };
const ref = value => isCanonicalFrozenRef(value) && !['unknown', 'null', 'undefined'].includes(value);
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const time = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
const clone = value => { assertSafeRuntimeRecord(value); return structuredClone(value); };
const categoryPathText = value => text(value, 500) && value.trim() === value && value.split(' > ').every(segment => segment.trim().length > 0);

export function assertSeerfarWebDiscoveryRequest(request) {
  requireValue(closed(request, ['requestId', 'provider', 'contractVersion', 'platform', 'pageUrl', 'categoryPaths', 'sellerType', 'dateRange', 'maxRecords']) &&
    ref(request.requestId) && request.provider === SEERFAR_WEB_DISCOVERY_PROVIDER && request.contractVersion === SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION &&
    request.platform === 'ozon' && request.pageUrl === SEERFAR_WEB_SEARCH_PAGE &&
    Array.isArray(request.categoryPaths) && request.categoryPaths.length > 0 && request.categoryPaths.length <= 20 &&
    request.categoryPaths.every(categoryPathText) && new Set(request.categoryPaths).size === request.categoryPaths.length &&
    SEERFAR_WEB_SELLER_TYPES.includes(request.sellerType) && SEERFAR_WEB_DATE_RANGES.includes(request.dateRange) &&
    Number.isSafeInteger(request.maxRecords) && request.maxRecords >= 1 && request.maxRecords <= SEERFAR_WEB_PAGE_SIZE, 'REQUEST_INVALID');
  return clone(request);
}

function ozonProductId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,17}$/.test(value) ? value : null;
}

function ozonProductUrl(value, productId) {
  if (typeof value !== 'string' || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'www.ozon.ru' || url.username || url.password || url.port || url.search || url.hash) return null;
  return url.pathname.replace(/\/$/, '') === `/product/${productId}` ? `https://www.ozon.ru/product/${productId}` : null;
}

function ozonImageUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) return undefined;
  let url;
  try { url = new URL(value); } catch { return undefined; }
  return url.protocol === 'https:' && url.hostname === 'ir.ozone.ru' && !url.username && !url.password && !url.port ? `${url.origin}${url.pathname}` : undefined;
}

const optionalInteger = value => value === null || value === undefined ? null : Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const optionalNumber = value => value === null || value === undefined ? null : Number.isFinite(value) ? value : undefined;
const optionalText = (value, max) => value === null || value === undefined || value === '' ? null : text(value, max) ? value : undefined;

/** One raw record of the page's search response becomes one strict market product; anything unexpected fails closed. */
export function normalizeSeerfarWebRecord(raw, index, evidenceRef) {
  requireValue(raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Number.isSafeInteger(index) && index >= 0 && ref(evidenceRef), 'RECORD_INVALID', `#${index}`);
  const productId = ozonProductId(raw.sku);
  requireValue(productId, 'RECORD_INVALID', `#${index} sku`);
  const productUrl = ozonProductUrl(raw.productUrl, productId);
  requireValue(productUrl, 'RECORD_INVALID', `#${index} productUrl`);
  requireValue(text(raw.title, 2000), 'RECORD_INVALID', `#${index} title`);
  const imageUrl = ozonImageUrl(raw.imageUrl);
  requireValue(imageUrl !== undefined, 'RECORD_INVALID', `#${index} imageUrl`);
  requireValue(Number.isFinite(raw.price) && raw.price > 0, 'RECORD_INVALID', `#${index} price`);
  const category = raw.categoryInfo;
  requireValue(category !== null && typeof category === 'object' && !Array.isArray(category) &&
    Array.isArray(category.fullCategoryId) && category.fullCategoryId.length > 0 && category.fullCategoryId.length <= 20 &&
    category.fullCategoryId.every(value => typeof value === 'string' && /^\d+(?:_\d+)*$/.test(value)) &&
    ['titlePath', 'cnTitlePath', 'enTitlePath'].every(key => categoryPathText(category[key])) &&
    category.category !== null && typeof category.category === 'object' && category.category.id === category.fullCategoryId.at(-1), 'RECORD_INVALID', `#${index} categoryInfo`);
  const fields = {
    salesCount: optionalInteger(raw.sales), revenue: optionalNumber(raw.revenue), reviewCount: optionalInteger(raw.reviewCount),
    reviewRating: optionalNumber(raw.reviewRating), rawSellerType: optionalInteger(raw.sellerType), sellerId: optionalInteger(raw.sellerId),
    sellerName: optionalText(raw.sellerName, 200), grossMarginPercent: optionalNumber(raw.grossMargin), salesRatePercent: optionalNumber(raw.salesRate),
    revenueRatePercent: optionalNumber(raw.revenueRate), weightGrams: optionalNumber(raw.weight), volumeLitres: optionalNumber(raw.volume),
    dimensionMm: optionalText(raw.dimension, 64), variantCount: optionalInteger(raw.variants),
    returnCancellationRatePercent: optionalNumber(raw.returnCancellationRate), views: optionalInteger(raw.views),
    sessionCount: optionalInteger(raw.sessionCount), listedAtMs: optionalInteger(raw.upTime)
  };
  for (const [key, value] of Object.entries(fields)) requireValue(value !== undefined, 'RECORD_INVALID', `#${index} ${key}`);
  requireValue(fields.revenue === null || fields.revenue >= 0, 'RECORD_INVALID', `#${index} revenue`);
  requireValue(fields.reviewRating === null || (fields.reviewRating >= 0 && fields.reviewRating <= 5), 'RECORD_INVALID', `#${index} reviewRating`);
  const fulfillment = raw.fulfillment === null || raw.fulfillment === undefined ? [] : raw.fulfillment;
  requireValue(Array.isArray(fulfillment) && fulfillment.length <= SEERFAR_WEB_FULFILLMENTS.length &&
    fulfillment.every(value => SEERFAR_WEB_FULFILLMENTS.includes(value)) && new Set(fulfillment).size === fulfillment.length, 'RECORD_INVALID', `#${index} fulfillment`);
  return {
    productId, platform: 'ozon', productUrl, title: raw.title, imageUrl, price: raw.price, currency: 'RUB',
    salesCount: fields.salesCount, revenue: fields.revenue,
    categoryPath: { fullCategoryId: [...category.fullCategoryId], titlePath: category.titlePath, cnTitlePath: category.cnTitlePath, enTitlePath: category.enTitlePath },
    sellerIdentity: 'unknown', providerRecordRef: `${evidenceRef}#product-${index}`,
    reviewCount: fields.reviewCount, reviewRating: fields.reviewRating, rawSellerType: fields.rawSellerType,
    webMetrics: {
      sellerId: fields.sellerId, sellerName: fields.sellerName, fulfillment: [...fulfillment], grossMarginPercent: fields.grossMarginPercent,
      salesRatePercent: fields.salesRatePercent, revenueRatePercent: fields.revenueRatePercent, weightGrams: fields.weightGrams,
      volumeLitres: fields.volumeLitres, dimensionMm: fields.dimensionMm, variantCount: fields.variantCount,
      returnCancellationRatePercent: fields.returnCancellationRatePercent, views: fields.views, sessionCount: fields.sessionCount,
      listedAt: fields.listedAtMs === null ? null : new Date(fields.listedAtMs).toISOString()
    }
  };
}

/** The raw shape a normalized product must have come from; proves a stored product is still canonical. */
function rawFromProduct(product) {
  const metrics = product.webMetrics && typeof product.webMetrics === 'object' ? product.webMetrics : {};
  const categoryPath = product.categoryPath && typeof product.categoryPath === 'object' ? product.categoryPath : {};
  return {
    sku: product.productId, productUrl: product.productUrl, title: product.title, imageUrl: product.imageUrl, price: product.price,
    sales: product.salesCount, revenue: product.revenue, reviewCount: product.reviewCount, reviewRating: product.reviewRating, sellerType: product.rawSellerType,
    sellerId: metrics.sellerId, sellerName: metrics.sellerName, fulfillment: metrics.fulfillment, grossMargin: metrics.grossMarginPercent,
    salesRate: metrics.salesRatePercent, revenueRate: metrics.revenueRatePercent, weight: metrics.weightGrams, volume: metrics.volumeLitres,
    dimension: metrics.dimensionMm, variants: metrics.variantCount, returnCancellationRate: metrics.returnCancellationRatePercent,
    views: metrics.views, sessionCount: metrics.sessionCount,
    upTime: typeof metrics.listedAt === 'string' ? Date.parse(metrics.listedAt) : null,
    categoryInfo: { category: { id: Array.isArray(categoryPath.fullCategoryId) ? categoryPath.fullCategoryId.at(-1) : null },
      fullCategoryId: categoryPath.fullCategoryId, titlePath: categoryPath.titlePath, cnTitlePath: categoryPath.cnTitlePath, enTitlePath: categoryPath.enTitlePath }
  };
}

const CAPTURE_FIELDS = Object.freeze(['pageUrl', 'endpoint', 'httpStatus', 'capturedAt', 'resultCountLabel', 'records']);

/** Build the strict result from the extension's raw capture; the owner's declared request bounds what is accepted. */
export function buildSeerfarWebDiscoveryResult({ request, capture, evidenceRef }) {
  const declared = assertSeerfarWebDiscoveryRequest(request);
  requireValue(closed(capture, CAPTURE_FIELDS) && capture.pageUrl === declared.pageUrl && capture.endpoint === SEERFAR_WEB_SEARCH_ENDPOINT &&
    capture.httpStatus === 200 && time(capture.capturedAt) && text(capture.resultCountLabel, 64) &&
    Array.isArray(capture.records) && capture.records.length <= SEERFAR_WEB_PAGE_SIZE && ref(evidenceRef), 'CAPTURE_INVALID');
  const products = capture.records.slice(0, declared.maxRecords).map((raw, index) => normalizeSeerfarWebRecord(raw, index, evidenceRef));
  const result = {
    schemaVersion: 'seerfar-web-discovery-result-v1', provider: SEERFAR_WEB_DISCOVERY_PROVIDER, contractVersion: SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION,
    requestId: declared.requestId, platform: 'ozon', pageUrl: declared.pageUrl, endpoint: SEERFAR_WEB_SEARCH_ENDPOINT,
    capturedAt: capture.capturedAt, evidenceRef, resultCountLabel: capture.resultCountLabel,
    categoryPaths: [...declared.categoryPaths], sellerTypeFilter: declared.sellerType, dateRangeFilter: declared.dateRange,
    status: products.length ? 'candidates_found' : 'true_empty', products,
    collection: { pageNumber: 1, pageSize: SEERFAR_WEB_PAGE_SIZE, hasNextPage: capture.records.length >= SEERFAR_WEB_PAGE_SIZE }
  };
  return assertSeerfarWebDiscoveryResult(result, declared);
}

export function assertSeerfarWebDiscoveryResult(result, request) {
  const declared = assertSeerfarWebDiscoveryRequest(request);
  requireValue(closed(result, ['schemaVersion', 'provider', 'contractVersion', 'requestId', 'platform', 'pageUrl', 'endpoint', 'capturedAt', 'evidenceRef',
    'resultCountLabel', 'categoryPaths', 'sellerTypeFilter', 'dateRangeFilter', 'status', 'products', 'collection']) &&
    result.schemaVersion === 'seerfar-web-discovery-result-v1' && result.provider === SEERFAR_WEB_DISCOVERY_PROVIDER &&
    result.contractVersion === SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION && result.requestId === declared.requestId && result.platform === 'ozon' &&
    result.pageUrl === declared.pageUrl && result.endpoint === SEERFAR_WEB_SEARCH_ENDPOINT && time(result.capturedAt) && ref(result.evidenceRef) &&
    text(result.resultCountLabel, 64) && Array.isArray(result.categoryPaths) && result.categoryPaths.length === declared.categoryPaths.length &&
    result.categoryPaths.every((value, index) => value === declared.categoryPaths[index]) &&
    result.sellerTypeFilter === declared.sellerType && result.dateRangeFilter === declared.dateRange &&
    Array.isArray(result.products) && result.products.length <= declared.maxRecords &&
    result.status === (result.products.length ? 'candidates_found' : 'true_empty') &&
    closed(result.collection, ['pageNumber', 'pageSize', 'hasNextPage']) && result.collection.pageNumber === 1 &&
    result.collection.pageSize === SEERFAR_WEB_PAGE_SIZE && typeof result.collection.hasNextPage === 'boolean', 'RESULT_INVALID');
  result.products.forEach((product, index) => {
    requireValue(closed(product, ['productId', 'platform', 'productUrl', 'title', 'imageUrl', 'price', 'currency', 'salesCount', 'revenue', 'categoryPath',
      'sellerIdentity', 'providerRecordRef', 'reviewCount', 'reviewRating', 'rawSellerType', 'webMetrics']), 'RESULT_INVALID', `#${index}`);
    let canonical;
    try { canonical = normalizeSeerfarWebRecord(rawFromProduct(product), index, result.evidenceRef); }
    catch (error) { throw new SeerfarWebDiscoveryContractError('RESULT_INVALID', `#${index} not canonical (${error.message})`); }
    requireValue(JSON.stringify(canonical) === JSON.stringify(product), 'RESULT_INVALID', `#${index} not canonical`);
    requireValue(declared.categoryPaths.includes(product.categoryPath.cnTitlePath), 'SCOPE_MISMATCH', `${product.productId} ${product.categoryPath.cnTitlePath}`);
    if (declared.sellerType === 'cross_border') requireValue(product.rawSellerType === SEERFAR_WEB_RAW_SELLER_TYPE_CROSS_BORDER, 'SCOPE_MISMATCH', `${product.productId} sellerType`);
  });
  requireValue(new Set(result.products.map(product => product.productId)).size === result.products.length, 'RESULT_INVALID', 'duplicate productId');
  return clone(result);
}
