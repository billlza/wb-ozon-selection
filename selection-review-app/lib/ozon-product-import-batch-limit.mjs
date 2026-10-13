import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fields = ['schemaVersion','evidenceRef','sourceUrl','operationId','endpoint','sourceStatement',
  'itemsConstraint','maxItemsPerRequest','observedAt','validUntil'];
const sourceUrl = 'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3';
const evidenceDirectory = new URL('../docs/contracts/', import.meta.url);
// One file per check of the official page, named by the day it was checked; the newest one is the current record.
const evidenceFile = /^ozon-product-import-batch-limit-(\d{8})\.json$/;
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const checkedDay = value => value.slice(0, 10).replaceAll('-', '');
const day = value => value.slice(0, 10);

/**
 * One versioned public per-request limit. It is neither an account method grant nor a daily quota.
 * How long one check of the official page stays good is written in the record by whoever checked it, not in code
 * (AGENTS.md 13.2): the record used to have to match dates fixed here, so once they passed on 2026-10-05 every new batch
 * failed and no data change could fix it (review P0-4). A fresh check is a new dated record beside the old one.
 */
export function assertOzonProductImportBatchLimitEvidence(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value,field)) ||
      value.schemaVersion !== 'ozon-product-import-batch-limit-evidence-v1' ||
      value.sourceUrl !== sourceUrl || value.operationId !== 'ProductAPI_ImportProductsV3' ||
      value.endpoint !== '/v3/product/import' ||
      value.sourceStatement !== 'В одном запросе можно передать до 100 товаров.' ||
      value.itemsConstraint !== 'items Array of objects <= 100 items' ||
      value.maxItemsPerRequest !== 100 || !iso(value.observedAt) || !iso(value.validUntil) ||
      Date.parse(value.observedAt) >= Date.parse(value.validUntil) ||
      value.evidenceRef !== `official:ozon-product-import-batch-limit:${checkedDay(value.observedAt)}`) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

/** A record holds from the moment it was checked until its own end, never before or after. */
export function ozonProductImportBatchLimitCurrent(evidence, at) {
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= Date.parse(evidence.observedAt) && time < Date.parse(evidence.validUntil);
}

/**
 * The gate in front of every new batch: a batch is only created while this record is current, because it could never be
 * sent otherwise and its products would stay held by it. `evidence` is null when the record could not be read. The owner
 * sentence says what was checked, until when, and that nothing was saved, held or sent.
 */
export function assertOzonProductImportBatchLimitCurrent(evidence, at) {
  if (evidence !== null && ozonProductImportBatchLimitCurrent(evidence, at)) return;
  const fact = 'Ozon「一次最多导入 100 件」这条官方规定';
  const why = evidence === null ? `${fact}的核对记录读不出来或格式不对`
    : Date.parse(at) < Date.parse(evidence.observedAt) ? `${fact}的核对记录要到 ${day(evidence.observedAt)} 才生效`
      : `${fact}的核对记录已经在 ${day(evidence.validUntil)} 到期（${day(evidence.observedAt)} 核对的）`;
  throw Object.assign(new Error('D_BATCH_IMPORT_LIMIT_NOT_CURRENT'), { code: 'D_BATCH_IMPORT_LIMIT_NOT_CURRENT',
    ownerMessage: `这批没有保存，也没有发给 Ozon，这些规格都没有被占用：${why}。需要技术维护重新核对 Ozon 官方文档、` +
      '存一条新的核对记录，之后再点一次确认就行。' });
}

/** Reads only the newest checked-in public record; no account request or external network access. */
export async function loadOzonProductImportBatchLimitEvidence({ directory = evidenceDirectory } = {}) {
  const root = typeof directory === 'string' ? directory : fileURLToPath(directory);
  const newest = (await readdir(root)).filter(name => evidenceFile.test(name)).sort().at(-1);
  if (newest === undefined) throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID');
  const evidence = assertOzonProductImportBatchLimitEvidence(JSON.parse(await readFile(path.join(root, newest), 'utf8')));
  // The file's day and the record's own check day are the same day, so an edited old file cannot pose as a new check.
  if (checkedDay(evidence.observedAt) !== evidenceFile.exec(newest)[1]) throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID');
  return evidence;
}
