import { readFile } from 'node:fs/promises';

export class OzonCommissionReferenceError extends Error {
  constructor(code, cause) {
    super(`OZON_COMMISSION_REFERENCE_${code}`, cause === undefined ? undefined : { cause });
    this.name = 'OzonCommissionReferenceError';
    this.code = code;
  }
}

const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const closedOptional = (value, required, optional) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !/[\x00-\x1f\x7f]/u.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const hex64 = value => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const rate = value => value === null || (Number.isFinite(value) && value >= 0 && value <= 1);
const normalizeText = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
const check = (condition, code) => { if (!condition) throw new OzonCommissionReferenceError(code); };
const gap = (code, field, blocking = true) => ({ code, field, blocking });

const RATE_FIELD_NAMES = Object.freeze(['rfbs_le1500', 'rfbs_1500_5000', 'rfbs_gt5000', 'fbp_le1500', 'fbp_1500_5000', 'fbp_gt5000']);
const PRICE_TIER_KEYS = Object.freeze(['le1500', '1500_5000', 'gt5000']);
const CATALOG_TOP_KEYS = Object.freeze(['schemaVersion', 'platform', 'sellerRegion', 'effectiveFrom', 'sourceUrl', 'sourcePage',
  'fileSha256', 'fileLastModified', 'downloadedAt', 'priceTiersRub', 'salesSchemes', 'sheets']);
const SHEET_NAMES = Object.freeze(['MP Tree Tarifs CN', 'Full ChinaHK']);
const MP_TREE_ROW_KEYS = Object.freeze(['row', 'blockRu', 'blockEn', 'blockZh', 'mpCategoryRu', 'mpCategoryEn', 'mpCategoryZh', ...RATE_FIELD_NAMES]);
const FULL_CHINA_HK_ROW_KEYS = Object.freeze(['row', 'typeRu', 'typeZh', 'typeEn', 'category3Ru', 'category3Zh', 'category3En',
  'mpCategoryRu', 'mpCategoryZh', 'mpCategoryEn', 'brand', ...RATE_FIELD_NAMES]);
const TYPE_IDENTITY_KEYS = Object.freeze(['typeRu', 'typeZh', 'typeEn']);
const SCOPE_REQUIRED_KEYS = Object.freeze(['platform', 'sellerRegion', 'salesScheme', 'priceRub', 'typeIdentity']);
const SCOPE_OPTIONAL_KEYS = Object.freeze(['mpCategoryZh']);
const VERSION_STATE_KEYS = Object.freeze(['fileSha256', 'effectiveFrom', 'status']);

function assertRow(row, keys) {
  const textKeys = keys.filter(key => key !== 'row' && !RATE_FIELD_NAMES.includes(key));
  check(closed(row, keys) && positiveInt(row.row) && textKeys.every(key => text(row[key])) &&
    RATE_FIELD_NAMES.every(field => rate(row[field])), 'CATALOG_INVALID');
}

function assertPriceTiers(tiers) {
  check(closed(tiers, PRICE_TIER_KEYS) && PRICE_TIER_KEYS.every(key => Array.isArray(tiers[key]) && tiers[key].length === 2 &&
    Number.isFinite(tiers[key][0]) && tiers[key][0] >= 0 &&
    (tiers[key][1] === null || (Number.isFinite(tiers[key][1]) && tiers[key][1] > tiers[key][0]))), 'CATALOG_INVALID');
  // The 3 tier names are load-bearing: row rate columns are suffixed with exactly these keys.
  check(tiers.le1500[0] === 0 && tiers.gt5000[1] === null &&
    tiers['1500_5000'][0] > tiers.le1500[1] && tiers.gt5000[0] > tiers['1500_5000'][1], 'CATALOG_INVALID');
}

function assertCatalog(catalog) {
  check(closed(catalog, CATALOG_TOP_KEYS) && catalog.schemaVersion === 'ozon-official-commission-reference-v1' &&
    catalog.platform === 'ozon' && text(catalog.sellerRegion) && dateOnly(catalog.effectiveFrom) &&
    text(catalog.sourceUrl) && text(catalog.sourcePage) && hex64(catalog.fileSha256) &&
    instant(catalog.fileLastModified) && instant(catalog.downloadedAt), 'CATALOG_INVALID');
  assertPriceTiers(catalog.priceTiersRub);
  check(Array.isArray(catalog.salesSchemes) && catalog.salesSchemes.length === 2 &&
    new Set(catalog.salesSchemes).size === 2 && catalog.salesSchemes.every(scheme => ['rfbs', 'fbp'].includes(scheme)), 'CATALOG_INVALID');
  check(closed(catalog.sheets, SHEET_NAMES) && SHEET_NAMES.every(name =>
    closed(catalog.sheets[name], ['rows']) && Array.isArray(catalog.sheets[name].rows)), 'CATALOG_INVALID');
  catalog.sheets['MP Tree Tarifs CN'].rows.forEach(row => assertRow(row, MP_TREE_ROW_KEYS));
  catalog.sheets['Full ChinaHK'].rows.forEach(row => assertRow(row, FULL_CHINA_HK_ROW_KEYS));
}

function assertScope(scope) {
  check(closedOptional(scope, SCOPE_REQUIRED_KEYS, SCOPE_OPTIONAL_KEYS) && scope.platform === 'ozon' &&
    scope.sellerRegion === 'CN' && ['rfbs', 'fbp'].includes(scope.salesScheme) &&
    Number.isFinite(scope.priceRub) && scope.priceRub > 0 &&
    closedOptional(scope.typeIdentity, [], TYPE_IDENTITY_KEYS) && Object.keys(scope.typeIdentity).length > 0 &&
    Object.keys(scope.typeIdentity).every(key => text(scope.typeIdentity[key])) &&
    (!Object.hasOwn(scope, 'mpCategoryZh') || text(scope.mpCategoryZh)), 'INPUT_INVALID');
}

function assertVersionStateShape(versionState) {
  check(closed(versionState, VERSION_STATE_KEYS) && hex64(versionState.fileSha256) &&
    dateOnly(versionState.effectiveFrom) && ['active', 'invalidated'].includes(versionState.status), 'INPUT_INVALID');
}

async function readCatalog(catalogPath) {
  const bytes = await readFile(catalogPath);
  check(bytes.length <= 32 * 1024 * 1024, 'CATALOG_UNREADABLE');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new OzonCommissionReferenceError('CATALOG_UNREADABLE', error);
  }
}

/** Boundaries come from the catalog itself; the 1500/5000 RUB cut points are never hardcoded here. */
function resolvePriceTier(priceTiersRub, priceRub) {
  if (priceRub <= priceTiersRub.le1500[1]) return 'le1500';
  if (priceRub <= priceTiersRub['1500_5000'][1]) return '1500_5000';
  return 'gt5000';
}

const typeIdentityMatches = (row, typeIdentity) => Object.keys(typeIdentity).every(field =>
  normalizeText(row[field]) === normalizeText(typeIdentity[field]));

const projectMatchedRow = row => ({ row: row.row, typeRu: row.typeRu, typeZh: row.typeZh, typeEn: row.typeEn,
  category3Zh: row.category3Zh, mpCategoryZh: row.mpCategoryZh, brand: row.brand });

/**
 * Local lookup only. The caller supplies the catalog path and its current
 * repository-tracked version state on every call; this function owns no
 * status store or hidden cache. A returned rate is reference material, and
 * every blocking gap must be resolved before it feeds a formal B evidence pack.
 */
export async function readOzonCommissionReference({ catalogPath, scope, versionState, asOf } = {}) {
  check(text(catalogPath) && instant(asOf), 'INPUT_INVALID');
  assertScope(scope);
  assertVersionStateShape(versionState);
  const catalog = await readCatalog(catalogPath);
  assertCatalog(catalog);

  const priceTier = resolvePriceTier(catalog.priceTiersRub, scope.priceRub);
  const source = {
    sourceUrl: catalog.sourceUrl, sourcePage: catalog.sourcePage, effectiveFrom: catalog.effectiveFrom,
    fileSha256: catalog.fileSha256, fileLastModified: catalog.fileLastModified, downloadedAt: catalog.downloadedAt,
    catalogSchemaVersion: catalog.schemaVersion
  };
  const base = {
    schemaVersion: 'ozon-commission-reference-read-v1', platform: 'ozon', sellerRegion: scope.sellerRegion,
    salesScheme: scope.salesScheme, priceRub: scope.priceRub, priceTier, source,
    versionState: structuredClone(versionState), checkedAt: asOf
  };
  const blocked = (code, field, matchedRows = []) => ({ ...base, commissionRate: null, matchedRows, gaps: [gap(code, field)] });

  // Version identity for this catalog is its content hash plus effective date; there is no
  // separate catalogId/catalogVersion pair the way the WB reference source carries one.
  if (versionState.fileSha256 !== catalog.fileSha256 || versionState.effectiveFrom !== catalog.effectiveFrom) {
    return blocked('CATALOG_VERSION_MISMATCH', 'versionState');
  }
  if (versionState.status === 'invalidated') return blocked('CATALOG_VERSION_INVALIDATED', 'versionState.status');
  if (Date.parse(asOf) < Date.parse(`${catalog.effectiveFrom}T00:00:00.000Z`)) return blocked('NOT_YET_EFFECTIVE', 'source.effectiveFrom');

  const typeMatches = catalog.sheets['Full ChinaHK'].rows.filter(row => typeIdentityMatches(row, scope.typeIdentity) &&
    (!Object.hasOwn(scope, 'mpCategoryZh') || normalizeText(row.mpCategoryZh) === normalizeText(scope.mpCategoryZh)));
  if (typeMatches.length === 0) return blocked('TYPE_NOT_FOUND', 'scope.typeIdentity');

  const allCandidates = typeMatches.filter(row => row.brand === 'All');
  if (allCandidates.length === 0) return blocked('BRAND_SPECIFIC_ONLY', 'matchedRows', typeMatches.map(projectMatchedRow));

  const matchedRows = allCandidates.map(projectMatchedRow);
  const distinctRateSets = new Set(allCandidates.map(row => JSON.stringify(RATE_FIELD_NAMES.map(field => row[field]))));
  if (distinctRateSets.size > 1) return blocked('TYPE_AMBIGUOUS', 'scope.mpCategoryZh', matchedRows);

  const rateField = `${scope.salesScheme}_${priceTier}`;
  const commissionRate = allCandidates[0][rateField];
  if (commissionRate === null) return { ...base, commissionRate: null, matchedRows, gaps: [gap('RATE_MISSING', `matchedRows.${rateField}`)] };

  return { ...base, commissionRate, matchedRows, gaps: [] };
}

const LADDER_SCOPE_REQUIRED_KEYS = Object.freeze(['platform', 'sellerRegion', 'salesScheme', 'typeIdentity']);

function assertLadderScope(scope) {
  check(closedOptional(scope, LADDER_SCOPE_REQUIRED_KEYS, SCOPE_OPTIONAL_KEYS) && scope.platform === 'ozon' &&
    scope.sellerRegion === 'CN' && ['rfbs', 'fbp'].includes(scope.salesScheme) &&
    closedOptional(scope.typeIdentity, [], TYPE_IDENTITY_KEYS) && Object.keys(scope.typeIdentity).length > 0 &&
    Object.keys(scope.typeIdentity).every(key => text(scope.typeIdentity[key])) &&
    (!Object.hasOwn(scope, 'mpCategoryZh') || text(scope.mpCategoryZh)), 'INPUT_INVALID');
}

/**
 * Every price tier of one product type in one read, with the ruble band each rate applies to.
 * The same catalog, the same matching and the same gap vocabulary as the single-price read above; the only difference
 * is that no price is supplied, so all tiers come back at once. A caller that has to answer "what would this product
 * earn at some other price" needs the whole ladder, and reading it here keeps the 1500/5000 RUB cut points where they
 * belong — in the official table — instead of copying them into the caller.
 */
export async function readOzonCommissionReferenceTiers({ catalogPath, scope, versionState, asOf } = {}) {
  check(text(catalogPath) && instant(asOf), 'INPUT_INVALID');
  assertLadderScope(scope);
  assertVersionStateShape(versionState);
  const catalog = await readCatalog(catalogPath);
  assertCatalog(catalog);

  const source = {
    sourceUrl: catalog.sourceUrl, sourcePage: catalog.sourcePage, effectiveFrom: catalog.effectiveFrom,
    fileSha256: catalog.fileSha256, fileLastModified: catalog.fileLastModified, downloadedAt: catalog.downloadedAt,
    catalogSchemaVersion: catalog.schemaVersion
  };
  const base = {
    schemaVersion: 'ozon-commission-reference-tiers-read-v1', platform: 'ozon', sellerRegion: scope.sellerRegion,
    salesScheme: scope.salesScheme, source, versionState: structuredClone(versionState), checkedAt: asOf
  };
  const blocked = (code, field, matchedRows = []) => ({ ...base, tiers: [], matchedRows, gaps: [gap(code, field)] });

  if (versionState.fileSha256 !== catalog.fileSha256 || versionState.effectiveFrom !== catalog.effectiveFrom) {
    return blocked('CATALOG_VERSION_MISMATCH', 'versionState');
  }
  if (versionState.status === 'invalidated') return blocked('CATALOG_VERSION_INVALIDATED', 'versionState.status');
  if (Date.parse(asOf) < Date.parse(`${catalog.effectiveFrom}T00:00:00.000Z`)) return blocked('NOT_YET_EFFECTIVE', 'source.effectiveFrom');

  const typeMatches = catalog.sheets['Full ChinaHK'].rows.filter(row => typeIdentityMatches(row, scope.typeIdentity) &&
    (!Object.hasOwn(scope, 'mpCategoryZh') || normalizeText(row.mpCategoryZh) === normalizeText(scope.mpCategoryZh)));
  if (typeMatches.length === 0) return blocked('TYPE_NOT_FOUND', 'scope.typeIdentity');
  const allCandidates = typeMatches.filter(row => row.brand === 'All');
  if (allCandidates.length === 0) return blocked('BRAND_SPECIFIC_ONLY', 'matchedRows', typeMatches.map(projectMatchedRow));
  const matchedRows = allCandidates.map(projectMatchedRow);
  const distinctRateSets = new Set(allCandidates.map(row => JSON.stringify(RATE_FIELD_NAMES.map(field => row[field]))));
  if (distinctRateSets.size > 1) return blocked('TYPE_AMBIGUOUS', 'scope.mpCategoryZh', matchedRows);

  const row = allCandidates[0];
  const tiers = [];
  const missing = [];
  for (const tier of PRICE_TIER_KEYS) {
    const rateField = `${scope.salesScheme}_${tier}`;
    const rate = row[rateField];
    if (rate === null) { missing.push(rateField); continue; }
    const [minRub, maxRub] = catalog.priceTiersRub[tier];
    tiers.push({ tier, rate, minRub, maxRub });
  }
  return { ...base, tiers, matchedRows, gaps: missing.map(field => gap('RATE_MISSING', `matchedRows.${field}`, false)) };
}
