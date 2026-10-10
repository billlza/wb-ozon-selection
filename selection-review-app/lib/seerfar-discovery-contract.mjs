import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';

export const SEERFAR_DISCOVERY_CONTRACT_VERSION = 'seerfar-category-discovery-v1';
export const SEERFAR_DISCOVERY_CAPABILITY = 'seerfar-category-discovery-api';
/** New market results are written at this version; older saved results stay readable at their own version. */
export const SEERFAR_MARKET_RESULT_SCHEMA_VERSION = 'seerfar-discovery-market-result-v3';
const MARKET_RESULT_SCHEMA_VERSIONS = Object.freeze(['seerfar-discovery-market-result-v1',
  'seerfar-discovery-market-result-v2', SEERFAR_MARKET_RESULT_SCHEMA_VERSION]);
// v2 added the provider's review facts and the response date window; v3 adds the provider's declared
// weight, volume and dimension text. Each version keeps its own closed key set: a field the older
// response never carried stays absent on read and is never filled in with a guessed value.
const MARKET_REVIEW_FACT_VERSIONS = Object.freeze(['seerfar-discovery-market-result-v2', SEERFAR_MARKET_RESULT_SCHEMA_VERSION]);
const MARKET_PACKAGE_FACT_VERSIONS = Object.freeze([SEERFAR_MARKET_RESULT_SCHEMA_VERSION]);
const MARKET_DIMENSION_MM = /^\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?$/;
export const SEERFAR_DISCOVERY_STEPS = Object.freeze(['quota_before', 'category_detail', 'quota_after']);
export const SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES = Object.freeze(['EVIDENCE_UNAVAILABLE', 'EVIDENCE_UNVERIFIED',
  'EVIDENCE_REVOKED', 'EVIDENCE_SUPERSEDED', 'EVIDENCE_NOT_EFFECTIVE', 'EVIDENCE_EXPIRED', 'EVIDENCE_AMBIGUOUS', 'EVIDENCE_INVALID']);
export class SeerfarDiscoveryContractError extends Error {
  constructor(code) { super(`A_DISCOVERY_${code}`); this.name = 'SeerfarDiscoveryContractError'; this.code = code; }
}
const closed = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const requireValue = (value, code) => { if (!value) throw new SeerfarDiscoveryContractError(code); };
const ref = value => isCanonicalFrozenRef(value) && !['unknown', 'null', 'undefined'].includes(value);
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const points = value => Number.isFinite(value) && value >= 0;
const measure = value => value === null || points(value);
// The provider writes the three sides as one millimetre string; it is kept literal, never split into numbers here.
const dimensionMm = value => value === null || typeof value === 'string' && value.length <= 64 && MARKET_DIMENSION_MM.test(value.trim());
const time = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
const clone = value => { assertSafeRuntimeRecord(value); return structuredClone(value); };

// Owner-declared query conditions. Each bound stays in the provider's own unit: price in RUB, weight in
// grams, volume in litres and sales as units in the response date window. A bound is never converted,
// rounded or inferred: a sub-key the owner did not declare is absent, which is not the same as "no limit
// because the provider said so". An absent `filters` key means the owner declared no condition at all.
export const SEERFAR_FILTER_KEYS = Object.freeze(['priceRub', 'weightGrams', 'volumeLitres', 'salesCount']);
const FILTER_LABELS = Object.freeze({ priceRub: ['售价', '卢布'], weightGrams: ['重量', '克'],
  volumeLitres: ['体积', '升'], salesCount: ['销量', '件'] });
const filterBound = value => value === null || points(value);
const filterRange = value => closed(value, ['min', 'max']) && filterBound(value.min) && filterBound(value.max) &&
  (value.min !== null || value.max !== null) && (value.min === null || value.max === null || value.min <= value.max);
export function isSeerfarFilters(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => SEERFAR_FILTER_KEYS.includes(key) && filterRange(value[key]));
}
const sameFilters = (left, right) => left === null || right === null ? left === right :
  Object.keys(left).length === Object.keys(right).length &&
  SEERFAR_FILTER_KEYS.filter(key => Object.hasOwn(left, key))
    .every(key => Object.hasOwn(right, key) && left[key].min === right[key].min && left[key].max === right[key].max);

/** Display-only Chinese line for the desk; it never changes, adds or drops a condition that was sent. */
export function describeSeerfarFilters(filters) {
  if (filters === null || filters === undefined) return '无筛选条件';
  requireValue(isSeerfarFilters(filters), 'INPUT_INVALID');
  return SEERFAR_FILTER_KEYS.filter(key => Object.hasOwn(filters, key)).map(key => {
    const [label, unit] = FILTER_LABELS[key], { min, max } = filters[key];
    const bounds = min !== null && max !== null ? `${min}-${max}` : min !== null ? `≥${min}` : `≤${max}`;
    return `${label} ${bounds} ${unit}`;
  }).join(' · ');
}

export function assertSeerfarDiscoveryRequest(request) {
  const filtered = Object.hasOwn(request ?? {}, 'filters');
  requireValue(closed(request, ['requestId', 'method', 'platform', 'categoryId', 'fulfillment', 'pageNumber', 'pageSize',
    'categoryEvidenceRef', 'contractEvidenceRef', ...(filtered ? ['filters'] : [])]) &&
    request.method === 'category_detail' && request.platform === 'ozon' &&
    ref(request.requestId) && text(request.categoryId, 256) && /^\d+(?:_\d+)+$/.test(request.categoryId) &&
    text(request.fulfillment, 64) && request.pageNumber === 1 && request.pageSize === 20 &&
    ref(request.categoryEvidenceRef) && ref(request.contractEvidenceRef) &&
    (!filtered || isSeerfarFilters(request.filters)), 'INPUT_INVALID');
  return clone(request);
}

export function assertSeerfarDiscoveryBudget(budget) {
  requireValue(closed(budget, ['unit', 'maxRequests', 'maxCredits', 'policyRef', 'policyVersion', 'costEvidenceRef', 'estimatedPointsByStep']) &&
    budget.unit === 'seerfar_points' && budget.maxRequests === 3 && points(budget.maxCredits) &&
    ['policyRef', 'policyVersion', 'costEvidenceRef'].every(key => ref(budget[key])) &&
    closed(budget.estimatedPointsByStep, SEERFAR_DISCOVERY_STEPS) &&
    SEERFAR_DISCOVERY_STEPS.every(step => points(budget.estimatedPointsByStep[step])) &&
    SEERFAR_DISCOVERY_STEPS.reduce((sum, step) => sum + budget.estimatedPointsByStep[step], 0) <= budget.maxCredits, 'BUDGET_INVALID');
  return clone(budget);
}

function evidenceTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Approved evidence declarations are separate from the one-use spending authorization. */
export function assertSeerfarDiscoveryEvidence(record) {
  requireValue(closed(record, ['schemaVersion', 'evidenceId', 'version', 'status', 'verifiedAt', 'effectiveFrom', 'expiresAt',
    'supersededBy', 'category', 'protocol', 'billing']) && record.schemaVersion === 'seerfar-discovery-evidence-v1' &&
    ref(record.evidenceId) && ref(record.version) && ['unverified', 'active', 'revoked', 'superseded'].includes(record.status) &&
    ['verifiedAt', 'effectiveFrom', 'expiresAt'].every(key => record[key] === null || evidenceTime(record[key])) &&
    (record.status !== 'active' || record.verifiedAt !== null) &&
    (record.status === 'superseded' ? ref(record.supersededBy) && record.supersededBy !== record.evidenceId : record.supersededBy === null) &&
    (record.effectiveFrom === null || record.expiresAt === null || Date.parse(record.effectiveFrom) < Date.parse(record.expiresAt)), 'EVIDENCE_INVALID');
  const { category, protocol, billing } = record;
  requireValue(closed(category, ['evidenceRef', 'sourceRef', 'platform', 'categoryId', 'fulfillment']) &&
    ref(category.evidenceRef) && ref(category.sourceRef) && category.platform === 'ozon' &&
    typeof category.categoryId === 'string' && /^\d+(?:_\d+)+$/.test(category.categoryId) && text(category.categoryId, 256) &&
    text(category.fulfillment, 64), 'EVIDENCE_INVALID');
  requireValue(closed(protocol, ['evidenceRef', 'sourceRef', 'contractVersion', 'method', 'pageNumber', 'pageSize']) &&
    ref(protocol.evidenceRef) && ref(protocol.sourceRef) && protocol.contractVersion === SEERFAR_DISCOVERY_CONTRACT_VERSION &&
    protocol.method === 'category_detail' && protocol.pageNumber === 1 && protocol.pageSize === 20, 'EVIDENCE_INVALID');
  requireValue(closed(billing, ['evidenceRef', 'sourceRef', 'policyRef', 'policyVersion', 'unit', 'estimatedPointsByStep']) &&
    ['evidenceRef', 'sourceRef', 'policyRef', 'policyVersion'].every(key => ref(billing[key])) && billing.unit === 'seerfar_points' &&
    closed(billing.estimatedPointsByStep, SEERFAR_DISCOVERY_STEPS) &&
    SEERFAR_DISCOVERY_STEPS.every(step => points(billing.estimatedPointsByStep[step])), 'EVIDENCE_INVALID');
  return clone(record);
}

export function normalizeSeerfarDiscoveryEvidenceRecords(records) {
  requireValue(Array.isArray(records) && records.length <= 20, 'EVIDENCE_INVALID');
  const checked = Array.from(records, assertSeerfarDiscoveryEvidence), identities = new Set(), references = new Set();
  for (const record of checked) {
    const identity = JSON.stringify([record.evidenceId, record.version]);
    const reference = JSON.stringify([record.category.evidenceRef, record.protocol.evidenceRef, record.billing.evidenceRef]);
    requireValue(!identities.has(identity) && !references.has(reference), 'EVIDENCE_AMBIGUOUS');
    identities.add(identity); references.add(reference);
  }
  return checked;
}

/** Resolve current evidence only for a new action; historical receipt reads do not call this. */
export function resolveSeerfarDiscoveryEvidence({ records, request, budget, now }) {
  assertSeerfarDiscoveryRequest(request);
  assertSeerfarDiscoveryBudget(budget);
  requireValue(evidenceTime(now), 'EVIDENCE_INVALID');
  const checked = normalizeSeerfarDiscoveryEvidenceRecords(records);
  const matches = checked.filter(record => record.category.evidenceRef === request.categoryEvidenceRef &&
    record.protocol.evidenceRef === request.contractEvidenceRef && record.billing.evidenceRef === budget.costEvidenceRef);
  requireValue(matches.length === 1, 'EVIDENCE_UNAVAILABLE');
  const record = matches[0], { category, protocol, billing } = record;
  requireValue(['platform', 'categoryId', 'fulfillment'].every(key => category[key] === request[key]) &&
    ['method', 'pageNumber', 'pageSize'].every(key => protocol[key] === request[key]) &&
    ['policyRef', 'policyVersion', 'unit'].every(key => billing[key] === budget[key]) &&
    SEERFAR_DISCOVERY_STEPS.every(step => billing.estimatedPointsByStep[step] === budget.estimatedPointsByStep[step]), 'EVIDENCE_INVALID');
  if (record.status !== 'active') throw new SeerfarDiscoveryContractError(`EVIDENCE_${record.status.toUpperCase()}`);
  const at = Date.parse(now);
  requireValue(Date.parse(record.verifiedAt) <= at && (record.effectiveFrom === null || Date.parse(record.effectiveFrom) <= at), 'EVIDENCE_NOT_EFFECTIVE');
  requireValue(record.expiresAt === null || at < Date.parse(record.expiresAt), 'EVIDENCE_EXPIRED');
  return record;
}

export function assertSeerfarDiscoveryBinding(binding) {
  requireValue(closed(binding, ['schemaVersion', 'provider', 'bindingId', 'configurationVersion', 'credentialAlias',
    'contractVersion', 'allowedMethods', 'timeoutMs', 'budgetPolicyRef']) && binding.schemaVersion === 'seerfar-discovery-binding-v1' &&
    binding.provider === 'seerfar' && binding.contractVersion === SEERFAR_DISCOVERY_CONTRACT_VERSION &&
    ['bindingId', 'configurationVersion', 'credentialAlias', 'budgetPolicyRef'].every(key => ref(binding[key])) &&
    Array.isArray(binding.allowedMethods) && binding.allowedMethods.length === 1 && binding.allowedMethods[0] === 'category_detail' &&
    Number.isSafeInteger(binding.timeoutMs) && binding.timeoutMs >= 1 && binding.timeoutMs <= 120000, 'BINDING_INVALID');
  return clone(binding);
}

function safeUrl(value) {
  requireValue(text(value, 2048), 'RESPONSE_INVALID');
  let url;
  try { url = new URL(value); }
  catch (error) { if (error instanceof TypeError) throw new SeerfarDiscoveryContractError('RESPONSE_INVALID'); throw error; }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash, 'RESPONSE_INVALID');
  return url;
}
function assertMarketProduct(product, index, result) {
  const reviewFacts = MARKET_REVIEW_FACT_VERSIONS.includes(result.schemaVersion);
  const packageFacts = MARKET_PACKAGE_FACT_VERSIONS.includes(result.schemaVersion);
  requireValue(closed(product, ['productId', 'platform', 'productUrl', 'title', 'imageUrl', 'price', 'currency',
    'salesCount', 'revenue', 'categoryPath', 'sellerIdentity', 'providerRecordRef',
    ...(reviewFacts ? ['reviewCount', 'reviewRating', 'rawSellerType'] : []),
    ...(packageFacts ? ['weightGrams', 'volumeLitres', 'dimensionMm'] : [])]) &&
    typeof product.productId === 'string' && /^[1-9]\d*$/.test(product.productId) && product.platform === 'ozon' &&
    text(product.title, 2000) && Number.isFinite(product.price) && product.price > 0 && product.currency === null &&
    (product.salesCount === null || Number.isSafeInteger(product.salesCount) && product.salesCount >= 0) &&
    (product.revenue === null || points(product.revenue)) && product.sellerIdentity === 'unknown' &&
    product.providerRecordRef === `${result.evidenceRef}#product-${index}`, 'RESPONSE_INVALID');
  if (reviewFacts) {
    requireValue(['reviewCount', 'rawSellerType'].every(key => product[key] === null || Number.isSafeInteger(product[key]) && product[key] >= 0) &&
      (product.reviewRating === null || points(product.reviewRating)), 'RESPONSE_INVALID');
  }
  if (packageFacts) {
    requireValue(measure(product.weightGrams) && measure(product.volumeLitres) && dimensionMm(product.dimensionMm), 'RESPONSE_INVALID');
  }
  const url = safeUrl(product.productUrl); safeUrl(product.imageUrl);
  requireValue(url.hostname === 'www.ozon.ru' && url.pathname === `/product/${product.productId}`, 'RESPONSE_INVALID');
  const category = product.categoryPath;
  if (category !== null) requireValue(closed(category, ['fullCategoryId', 'titlePath', 'cnTitlePath', 'enTitlePath']) &&
    Array.isArray(category.fullCategoryId) && category.fullCategoryId.length > 0 && category.fullCategoryId.length <= 20 &&
    category.fullCategoryId.every(value => text(value, 64)) && ['titlePath', 'cnTitlePath', 'enTitlePath'].every(key => text(category[key], 2000)), 'RESPONSE_INVALID');
}

export function assertSeerfarDiscoveryQuotaResult(result) {
  requireValue(closed(result, ['schemaVersion', 'provider', 'requestId', 'observedAt', 'remainingPoints', 'evidenceRef']) &&
    result.schemaVersion === 'seerfar-discovery-quota-result-v1' && result.provider === 'seerfar' &&
    ref(result.requestId) && time(result.observedAt) && points(result.remainingPoints) && ref(result.evidenceRef), 'RESPONSE_INVALID');
  return clone(result);
}

export function assertSeerfarDiscoveryMarketResult(result, request) {
  assertSeerfarDiscoveryRequest(request);
  // v3 results state the owner's conditions back: `appliedFilters` echoes exactly the request's filters
  // (null when none were declared). The key stays optional so a v3 result saved before this echo existed
  // still reads; an absent echo is silence about the conditions, never a claim that none were applied.
  const echoed = MARKET_PACKAGE_FACT_VERSIONS.includes(result?.schemaVersion) && Object.hasOwn(result ?? {}, 'appliedFilters');
  requireValue(closed(result, ['schemaVersion', 'provider', 'contractVersion', 'requestId', 'platform', 'categoryId', 'fulfillment',
    'observedAt', 'evidenceRef', 'status', 'products', 'collection',
    ...(MARKET_REVIEW_FACT_VERSIONS.includes(result?.schemaVersion) ? ['dateRange'] : []),
    ...(echoed ? ['appliedFilters'] : [])]) &&
    MARKET_RESULT_SCHEMA_VERSIONS.includes(result.schemaVersion) &&
    result.provider === 'seerfar' && result.contractVersion === SEERFAR_DISCOVERY_CONTRACT_VERSION &&
    ['requestId', 'platform', 'categoryId', 'fulfillment'].every(key => result[key] === request[key]) &&
    time(result.observedAt) && ref(result.evidenceRef) && Array.isArray(result.products) && result.products.length <= 20 &&
    result.status === (result.products.length ? 'candidates_found' : 'true_empty') &&
    closed(result.collection, ['pageNumber', 'pageSize', 'hasNextPage']) && result.collection.pageNumber === 1 &&
    result.collection.pageSize === 20 && typeof result.collection.hasNextPage === 'boolean' &&
    (result.products.length > 0 || result.collection.hasNextPage === false), 'RESPONSE_INVALID');
  if (echoed) {
    requireValue(result.appliedFilters === null || isSeerfarFilters(result.appliedFilters), 'RESPONSE_INVALID');
    requireValue(sameFilters(result.appliedFilters, Object.hasOwn(request, 'filters') ? request.filters : null), 'RESPONSE_INVALID');
  }
  if (MARKET_REVIEW_FACT_VERSIONS.includes(result.schemaVersion)) {
    const dates = result.dateRange;
    requireValue(closed(dates, ['startDate', 'endDate']) && ['startDate', 'endDate'].every(key => {
      const value = dates[key];
      return value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    }) && (dates.startDate === null || dates.endDate === null || dates.startDate <= dates.endDate), 'RESPONSE_INVALID');
  }
  result.products.forEach((product, index) => assertMarketProduct(product, index, result));
  requireValue(new Set(result.products.map(product => product.productId)).size === result.products.length, 'RESPONSE_INVALID');
  return clone(result);
}
