import { authorizeOperation } from './runtime-identity.mjs';
import { ADiscoveryError, assertADiscoveryBatch, assertADiscoveryReceipt, readADiscoveryMarketResult } from './a-discovery-contract.mjs';
import { isADiscoverySoftwareJob } from './software-job-contract.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH, DISCOVERY_TITLE_TRANSLATION_MAX_TITLES } from './discovery-title-translation.mjs';

export const DISCOVERY_TITLE_TRANSLATION_SCHEMA_VERSION = 'a-discovery-title-translation-v1';
export const DISCOVERY_TITLE_TRANSLATION_COLLECTION = 'aDiscoveryTitleTranslations';

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const requireValue = (condition, code) => { if (!condition) throw new ADiscoveryError(code); };
const plainText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL_CHARACTERS.test(value);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

/** One display-only Chinese title per market product; it never replaces the observed provider title. */
export function assertDiscoveryTitleTranslationRecord(record, { productId }) {
  const fields = ['schemaVersion', 'productId', 'sourceTitle', 'titleZh', 'model', 'jobId', 'translatedAt', 'usage'];
  requireValue(closed(record, fields) && record.schemaVersion === DISCOVERY_TITLE_TRANSLATION_SCHEMA_VERSION &&
    record.productId === productId && typeof productId === 'string' && /^[1-9][0-9]*$/.test(productId) &&
    plainText(record.sourceTitle, 500) && plainText(record.titleZh, DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH) &&
    plainText(record.model, 120) && plainText(record.jobId, 200) &&
    typeof record.translatedAt === 'string' && Number.isFinite(Date.parse(record.translatedAt)) &&
    closed(record.usage, ['inputTokens', 'outputTokens', 'totalTokens']) &&
    Object.values(record.usage).every(tokenCount), 'TITLE_TRANSLATION_RECORD_INVALID');
  return structuredClone(record);
}

/** Read-only accessor: the view must never create the collection while rendering. */
export function readDiscoveryTitleTranslations(document) {
  const runtime = document?.runtime;
  if (!isObject(runtime) || !Object.hasOwn(runtime, DISCOVERY_TITLE_TRANSLATION_COLLECTION)) return {};
  const value = runtime[DISCOVERY_TITLE_TRANSLATION_COLLECTION];
  requireValue(isObject(value), 'TITLE_TRANSLATION_REPOSITORY_INVALID');
  return value;
}

/** Display-only titles for the view; the stored receipt keeps the provider's own title untouched. */
export function attachDiscoveryTitleTranslations(receipt, translations) {
  if (!isObject(receipt) || !Array.isArray(receipt.steps)) return receipt;
  for (const step of receipt.steps) {
    const products = step?.result?.products;
    if (!Array.isArray(products)) continue;
    for (const product of products) {
      const record = translations[product?.productId];
      if (isObject(record) && record.sourceTitle === product.title && plainText(record.titleZh, DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH)) {
        product.titleZh = record.titleZh;
      }
    }
  }
  return receipt;
}

/**
 * Market products of a completed batch, in provider order; supplier searches carry no Russian marketplace title.
 * `full` adds the price, category and package facts an estimate needs; a provider that never returned one keeps null.
 */
export function readADiscoveryBatchMarketProducts({ document, batch, full = false }) {
  const jobs = Array.isArray(document?.runtime?.softwareJobs) ? document.runtime.softwareJobs : [];
  const receipts = isObject(document?.runtime?.aDiscoveryReceipts) ? document.runtime.aDiscoveryReceipts : {};
  const products = [], seen = new Set();
  for (const job of jobs) {
    if (!isADiscoverySoftwareJob(job) || job.subject.batchId !== batch.batchId || job.revision !== batch.revision) continue;
    if (job.status !== 'completed' || job.externalRequestState !== 'succeeded') continue;
    if (job.scopeBinding?.request?.method === 'supplier_search') continue;
    if (!Object.hasOwn(receipts, job.jobId)) continue;
    const result = readADiscoveryMarketResult(assertADiscoveryReceipt(receipts[job.jobId], job));
    if (result.status !== 'candidates_found' || !Array.isArray(result.products)) continue;
    for (const product of result.products) {
      if (typeof product?.productId !== 'string' || !/^[1-9][0-9]*$/.test(product.productId) || seen.has(product.productId)) continue;
      if (!plainText(product.title, 500)) continue;
      seen.add(product.productId);
      products.push(full
        ? { productId: product.productId, title: product.title, price: product.price, categoryPath: product.categoryPath ?? null,
          weightGrams: product.weightGrams ?? null, volumeLitres: product.volumeLitres ?? null, dimensionMm: product.dimensionMm ?? null }
        : { productId: product.productId, title: product.title });
    }
  }
  return products;
}

/**
 * Owner-triggered display-only translation for one completed discovery batch.
 * Cached titles are never sent twice, and a gateway failure persists nothing.
 */
export function createADiscoveryTitleTranslationUseCase({ repository, serverClock, translator }) {
  if (typeof repository?.transact !== 'function' || typeof repository?.readSnapshot !== 'function' ||
      typeof serverClock !== 'function' || typeof translator?.translateTitles !== 'function') {
    throw new TypeError('A_DISCOVERY_TITLE_TRANSLATION_DEPENDENCY_INVALID');
  }
  const limit = Number.isSafeInteger(translator.maxTitlesPerCall) && translator.maxTitlesPerCall > 0
    ? Math.min(translator.maxTitlesPerCall, DISCOVERY_TITLE_TRANSLATION_MAX_TITLES) : DISCOVERY_TITLE_TRANSLATION_MAX_TITLES;
  return Object.freeze({
    async translateBatch({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ['owner'] });
      requireValue(actor.actorType === 'human' && actor.source === 'authenticated_identity_provider', 'AUTHENTICATED_OWNER_REQUIRED');
      requireValue(closed(input, ['batchId', 'expectedRevision']) && isCanonicalFrozenRef(input.batchId) &&
        Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'INPUT_INVALID');
      const document = await repository.readSnapshot();
      const batches = isObject(document?.runtime?.aDiscoveryBatches) ? document.runtime.aDiscoveryBatches : {};
      requireValue(Object.hasOwn(batches, input.batchId), 'BATCH_REQUIRED');
      const batch = assertADiscoveryBatch(batches[input.batchId]);
      requireValue(batch.ownerUserId === actor.userId, 'OWNER_CONFLICT');
      requireValue(batch.revision === input.expectedRevision, 'BATCH_CHANGED');
      const saved = readDiscoveryTitleTranslations(document);
      const products = readADiscoveryBatchMarketProducts({ document, batch });
      const pending = products.filter(product => {
        const record = saved[product.productId];
        return !(isObject(record) && record.sourceTitle === product.title);
      });
      const cached = products.length - pending.length;
      if (pending.length === 0) {
        return { translated: 0, cached, remaining: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: null };
      }
      const items = pending.slice(0, limit);
      const remaining = pending.length - items.length;
      const outcome = await translator.translateTitles({ items });
      const at = serverClock();
      requireValue(typeof at === 'string' && Number.isFinite(Date.parse(at)), 'TITLE_TRANSLATION_CLOCK_INVALID');
      const sourceTitles = new Map(items.map(item => [item.productId, item.title]));
      // Every record carries the whole call's token usage as its provenance; the route reports that call once, never a sum.
      const records = outcome.translations.map(translation => {
        requireValue(sourceTitles.has(translation.productId), 'TITLE_TRANSLATION_RESULT_CONFLICT');
        return assertDiscoveryTitleTranslationRecord({
          schemaVersion: DISCOVERY_TITLE_TRANSLATION_SCHEMA_VERSION,
          productId: translation.productId,
          sourceTitle: sourceTitles.get(translation.productId),
          titleZh: translation.titleZh,
          model: outcome.model,
          jobId: outcome.jobId,
          translatedAt: at,
          usage: { ...outcome.usage }
        }, { productId: translation.productId });
      });
      await repository.transact(currentDocument => {
        if (!isObject(currentDocument.runtime)) currentDocument.runtime = {};
        if (!Object.hasOwn(currentDocument.runtime, DISCOVERY_TITLE_TRANSLATION_COLLECTION)) {
          currentDocument.runtime[DISCOVERY_TITLE_TRANSLATION_COLLECTION] = {};
        }
        const store = currentDocument.runtime[DISCOVERY_TITLE_TRANSLATION_COLLECTION];
        requireValue(isObject(store), 'TITLE_TRANSLATION_REPOSITORY_INVALID');
        for (const record of records) store[record.productId] = structuredClone(record);
        return { changed: true, document: currentDocument, result: records.length };
      });
      return { translated: records.length, cached, remaining, usage: { ...outcome.usage }, model: outcome.model };
    }
  });
}
