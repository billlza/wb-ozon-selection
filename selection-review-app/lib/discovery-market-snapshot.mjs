import { readADiscoveryMarketResult } from './a-discovery-contract.mjs';
import {
  SALES_SNAPSHOT_SCHEMA_VERSION,
  SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE,
  SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION,
  SEERFAR_CATEGORY_DETAIL_SOURCE,
  UNKNOWN,
  validateSalesSnapshot
} from './sales-snapshot.mjs';

/**
 * A discovered candidate never went through an Ozon page read, so it has no SalesSnapshot and every card that asks for
 * one blocks. This adapter projects the market facts the provider already returned in the saved discovery receipt into
 * one SalesSnapshot entry. It reads only what is already persisted: no provider call, no page read, no new number.
 * The snapshot says exactly where each figure came from (providerRecordRef inside the receipt, plus the receipt id),
 * and it is never presented as an independent platform observation.
 */
export const DISCOVERY_MARKET_SNAPSHOT_SOURCE = SEERFAR_CATEGORY_DETAIL_SOURCE;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() !== '' ? value : null);
const nullableNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const nullableInteger = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export function discoveryMarketSnapshotId({ receiptId, marketProductId }) {
  return `sales-snapshot:${DISCOVERY_MARKET_SNAPSHOT_SOURCE}:${receiptId}:${marketProductId}`;
}

/** The v2 discovery evidence a Seerfar-imported candidate carries; anything else has no market receipt to read. */
export function readDiscoveryMarketEvidenceRef(candidate) {
  const evidence = candidate?.aDiscoveryEvidenceV2;
  if (!isObject(evidence) || evidence.provider !== 'seerfar' || evidence.platform !== 'ozon') return null;
  const marketProductId = text(evidence.marketProductId);
  const marketReceiptRef = text(evidence.marketReceiptRef);
  if (marketProductId === null || marketReceiptRef === null) return null;
  return { batchId: text(evidence.batchId), marketProductId, marketReceiptRef };
}

/** The saved receipt and the one market row inside it; the same readers the import and estimate stores use. */
export function readDiscoveryMarketRecord({ document, candidate }) {
  const reference = readDiscoveryMarketEvidenceRef(candidate);
  if (reference === null) return { status: 'no_discovery_evidence', product: null, receipt: null, reference: null };
  const receipts = document?.runtime?.aDiscoveryReceipts;
  if (!isObject(receipts)) return { status: 'receipt_missing', product: null, receipt: null, reference };
  const receipt = Object.values(receipts).find(value => isObject(value) && value.receiptId === reference.marketReceiptRef) ?? null;
  if (receipt === null) return { status: 'receipt_missing', product: null, receipt: null, reference };
  let result;
  try { result = readADiscoveryMarketResult(receipt); }
  catch { return { status: 'receipt_unreadable', product: null, receipt: null, reference }; }
  const product = Array.isArray(result?.products)
    ? result.products.find(value => value?.productId === reference.marketProductId) ?? null
    : null;
  if (product === null) return { status: 'market_row_missing', product: null, receipt: null, reference };
  return { status: 'available', product, receipt, result, reference };
}

/**
 * One SalesSnapshot built from one saved market row. Ozon quotes in roubles, which is why the estimate module already
 * calls the same figure priceRub; the snapshot records that the currency came from the platform convention and not
 * from the provider, because the provider's own record leaves the currency field empty.
 */
export function buildDiscoveryMarketSalesSnapshot({ product, receipt, result = null }) {
  if (!isObject(product) || !isObject(receipt)) throw new TypeError('DISCOVERY_MARKET_SNAPSHOT_INPUT_INVALID');
  const providerRecordRef = text(product.providerRecordRef);
  const receiptId = text(receipt.receiptId);
  const collectedAt = text(receipt.completedAt);
  if (providerRecordRef === null || receiptId === null || collectedAt === null) {
    throw new Error('DISCOVERY_MARKET_SNAPSHOT_EVIDENCE_MISSING: 查询回执缺少记录引用或完成时间');
  }
  const category = isObject(product.categoryPath) ? text(product.categoryPath.cnTitlePath) : null;
  const window = isObject(result?.dateRange)
    ? { startDate: result.dateRange.startDate ?? null, endDate: result.dateRange.endDate ?? null }
    : null;
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: discoveryMarketSnapshotId({ receiptId, marketProductId: product.productId }),
    platform: 'ozon',
    source: DISCOVERY_MARKET_SNAPSHOT_SOURCE,
    marketScope: 'ozon_general_market',
    // The category result carries no seller registration evidence, so the seller stays explicitly unknown.
    sellerType: UNKNOWN,
    sellerIdentityEvidence: { status: 'unverified', signals: [], evidenceRef: providerRecordRef },
    productUrl: product.productUrl,
    title: product.title,
    imageRefs: text(product.imageUrl) === null ? [] : [product.imageUrl],
    currentPrice: product.price,
    currency: 'RUB',
    priceCurrencySource: 'ozon_platform_currency',
    categoryPath: category ?? UNKNOWN,
    attributes: {},
    marketMetrics: {
      salesCount: nullableInteger(product.salesCount),
      salesWindow: window,
      revenue: nullableNumber(product.revenue),
      reviewCount: nullableInteger(product.reviewCount),
      reviewRating: nullableNumber(product.reviewRating)
    },
    evidenceRefs: [providerRecordRef, receiptId],
    collectedAt,
    evidenceRef: providerRecordRef,
    collectorVersion: SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION,
    collectorMode: SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE,
    readOnly: true
  };
  const validation = validateSalesSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(`DISCOVERY_MARKET_SNAPSHOT_INVALID: ${validation.errors.map(item => `${item.path}: ${item.message}`).join('；')}`);
  }
  return Object.freeze(snapshot);
}

/** The snapshot the cards should treat as current: the newest entry that still validates. */
export function currentSalesSnapshot(candidate) {
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .filter(snapshot => validateSalesSnapshot(snapshot).valid)
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0] ?? null;
}

/**
 * Idempotent write for the owner's first visit to the product page. An existing valid snapshot always wins: a real
 * page read or a provider detail read must never be replaced by this projection of a search result.
 */
export function ensureDiscoveryMarketSalesSnapshot({ document, candidate }) {
  if (!isObject(candidate)) throw new TypeError('DISCOVERY_MARKET_SNAPSHOT_CANDIDATE_INVALID');
  const existing = currentSalesSnapshot(candidate);
  if (existing !== null) return { changed: false, status: 'existing_valid_snapshot', snapshot: existing };
  const record = readDiscoveryMarketRecord({ document, candidate });
  if (record.status !== 'available') return { changed: false, status: record.status, snapshot: null };
  const snapshot = buildDiscoveryMarketSalesSnapshot(record);
  const saved = Array.isArray(candidate.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [];
  candidate.salesSnapshotsV11 = [
    ...saved.filter(entry => entry?.snapshotId !== snapshot.snapshotId),
    structuredClone(snapshot)
  ];
  return { changed: true, status: 'derived_from_discovery_receipt', snapshot };
}
