import { readFile } from 'node:fs/promises';

const fields = ['schemaVersion','evidenceRef','sourceUrl','operationId','endpoint','sourceStatement',
  'itemsConstraint','maxItemsPerRequest','observedAt','validUntil'];
const sourceUrl = 'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3';
const observedAt = '2026-09-28T00:40:19.000Z';
const validUntil = '2026-10-05T00:40:19.000Z';
const evidenceUrl = new URL('../docs/contracts/ozon-product-import-batch-limit-20260928.json',import.meta.url);
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** One versioned public per-request limit. It is neither an account method grant nor a daily quota. */
export function assertOzonProductImportBatchLimitEvidence(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value,field)) ||
      value.schemaVersion !== 'ozon-product-import-batch-limit-evidence-v1' ||
      value.evidenceRef !== 'official:ozon-product-import-batch-limit:20260928' ||
      value.sourceUrl !== sourceUrl || value.operationId !== 'ProductAPI_ImportProductsV3' ||
      value.endpoint !== '/v3/product/import' ||
      value.sourceStatement !== 'В одном запросе можно передать до 100 товаров.' ||
      value.itemsConstraint !== 'items Array of objects <= 100 items' ||
      value.maxItemsPerRequest !== 100 || !iso(value.observedAt) || !iso(value.validUntil) ||
      value.observedAt !== observedAt || value.validUntil !== validUntil) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

/** Reads only the checked-in public fact; no account request or external network access. */
export async function loadOzonProductImportBatchLimitEvidence() {
  const data = JSON.parse(await readFile(evidenceUrl,'utf8'));
  return assertOzonProductImportBatchLimitEvidence(data);
}
