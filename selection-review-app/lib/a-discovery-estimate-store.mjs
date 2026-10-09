import { authorizeOperation } from './runtime-identity.mjs';
import { ADiscoveryError, assertADiscoveryBatch } from './a-discovery-contract.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { resolveLifecycleBProfitRule } from './lifecycle-b-evidence-runtime.mjs';
import { readADiscoveryBatchMarketProducts } from './discovery-title-translation-store.mjs';
import { estimateDiscoveredProduct, describeEstimate, estimateOutcomeForPool } from './a-discovery-estimate.mjs';

export const A_DISCOVERY_ESTIMATE_SCHEMA_VERSION = 'a-discovery-estimate-record-v1';
export const A_DISCOVERY_ESTIMATE_COLLECTION = 'aDiscoveryEstimates';

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const requireValue = (condition, code) => { if (!condition) throw new ADiscoveryError(code); };
const plainText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL_CHARACTERS.test(value);
const optionalText = (value, max) => value === null || plainText(value, max);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const productId = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
export const aDiscoveryEstimateKey = ({ batchId, revision, productId: id }) => `${batchId}:${revision}:${id}`;

/** One saved estimate per market product and batch revision; the numbers stay beside the inputs that produced them. */
export function assertADiscoveryEstimateRecord(record, { batchId, revision, productId: id }) {
  const inputs = ['fxSourceRef', 'fxRateDate', 'commissionSourceRef', 'tariffRuleVersion', 'costPolicyVersion', 'packagingRmbDefault'];
  requireValue(closed(record, ['schemaVersion', 'batchId', 'revision', 'productId', 'estimatedAt', 'inputs', 'estimate']) &&
    record.schemaVersion === A_DISCOVERY_ESTIMATE_SCHEMA_VERSION && record.batchId === batchId && isCanonicalFrozenRef(batchId) &&
    record.revision === revision && Number.isSafeInteger(revision) && revision >= 0 && record.productId === id && productId(id) &&
    instant(record.estimatedAt) && closed(record.inputs, inputs) &&
    optionalText(record.inputs.fxSourceRef, 400) && optionalText(record.inputs.fxRateDate, 40) &&
    optionalText(record.inputs.commissionSourceRef, 400) && optionalText(record.inputs.tariffRuleVersion, 120) &&
    optionalText(record.inputs.costPolicyVersion, 120) && typeof record.inputs.packagingRmbDefault === 'number' &&
    Number.isFinite(record.inputs.packagingRmbDefault) && record.inputs.packagingRmbDefault >= 0 &&
    isObject(record.estimate) && record.estimate.schemaVersion === 'a-discovery-estimate-v1' &&
    record.estimate.productId === id && ['ok', 'negative', 'incomplete'].includes(record.estimate.status) &&
    Array.isArray(record.estimate.missing), 'ESTIMATE_RECORD_INVALID');
  return structuredClone(record);
}

/** Read-only accessor: the view must never create the collection while rendering. */
export function readADiscoveryEstimates(document) {
  const runtime = document?.runtime;
  if (!isObject(runtime) || !Object.hasOwn(runtime, A_DISCOVERY_ESTIMATE_COLLECTION)) return {};
  const value = runtime[A_DISCOVERY_ESTIMATE_COLLECTION];
  requireValue(isObject(value), 'ESTIMATE_REPOSITORY_INVALID');
  return value;
}

/** The saved outcome for one product, or null when this batch revision was never estimated. */
export function readADiscoveryEstimateOutcome(document, { batchId, revision, productId: id }) {
  const estimates = readADiscoveryEstimates(document);
  const key = aDiscoveryEstimateKey({ batchId, revision, productId: id });
  if (!Object.hasOwn(estimates, key)) return null;
  return estimateOutcomeForPool(assertADiscoveryEstimateRecord(estimates[key], { batchId, revision, productId: id }).estimate);
}

/** Display-only estimate summaries for the view; the stored receipt keeps only what the provider returned. */
export function attachADiscoveryEstimates(receipt, estimates, { batchId, revision }) {
  if (!isObject(receipt) || !Array.isArray(receipt.steps)) return receipt;
  for (const step of receipt.steps) {
    const products = step?.result?.products;
    if (!Array.isArray(products)) continue;
    for (const product of products) {
      if (!productId(product?.productId)) continue;
      const key = aDiscoveryEstimateKey({ batchId, revision, productId: product.productId });
      if (!isObject(estimates) || !Object.hasOwn(estimates, key)) continue;
      const { estimate } = assertADiscoveryEstimateRecord(estimates[key], { batchId, revision, productId: product.productId });
      const chosen = estimate.freight?.chosen ?? null;
      product.estimate = {
        status: estimate.status, outcome: estimateOutcomeForPool(estimate), summary: describeEstimate(estimate),
        maximumAllInPurchaseRmb: estimate.ceiling === null ? null : estimate.ceiling.maximumAllInPurchaseRmb,
        freight: { route: chosen?.route ?? null, chargeableKg: chosen?.chargeableKg ?? null, freightRmb: chosen?.freightRmb ?? null,
          oversize: estimate.freight?.oversize === true },
        commissionRate: estimate.commission?.rate ?? null,
        // Display-only figures for the owner's card: revenue at the official FX and the profit at the midpoint of the purchase range.
        revenueCny: estimate.revenueCny ?? null,
        unitProfitAtMidRmb: estimate.ceiling?.unitProfitAtMidRmb ?? null,
        marginAtMid: estimate.ceiling?.marginAtMid ?? null
      };
    }
  }
  return receipt;
}

/** Ozon's official table is keyed by the leaf type name, which is the last segment of the provider's Chinese category path. */
export function typeZhFromCategoryPath(categoryPath) {
  const path = categoryPath?.cnTitlePath;
  if (!plainText(path, 2000)) return null;
  const leaf = path.split('>').pop().trim();
  return plainText(leaf, 200) ? leaf : null;
}

const commissionGap = (code, field) => ({ rate: null, tier: null, sourceRef: null, gaps: [{ code, field, blocking: true }] });
const commissionTiersGap = (code, field) => ({ tiers: [], sourceRef: null, gaps: [{ code, field, blocking: true }] });

/** Store cost rules saved by the owner win; the injected defaults only fill fields a saved rule never carried. */
function storeRuleFor(document, targetStore, fallbackRules) {
  const saved = isObject(document?.rules) ? document.rules : {};
  const rules = { ...fallbackRules, ...saved,
    ozonMiska: { ...fallbackRules?.ozonMiska, ...saved.ozonMiska },
    ozonDandanshu: { ...fallbackRules?.ozonDandanshu, ...saved.ozonDandanshu } };
  return resolveLifecycleBProfitRule({ targetStore }, rules);
}

/** A saved, still-current official FX pack is preferred over any new read; expired or invalidated packs are never reused. */
function savedExchangeRate(document, at) {
  const packs = Array.isArray(document?.evidencePacks) ? document.evidencePacks : [];
  const current = packs.filter(pack => isObject(pack) && pack.kind === 'exchange_rate' && pack.status === 'active' &&
    pack.scope?.pair === 'RUB/CNY' && instant(pack.checkedAt) && instant(pack.expiresAt) &&
    Date.parse(pack.checkedAt) <= Date.parse(at) && Date.parse(at) < Date.parse(pack.expiresAt) &&
    positive(pack.evidenceData?.rubPerCny));
  if (current.length === 0) return null;
  const pack = current.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
  return { rubPerCny: pack.evidenceData.rubPerCny, rateDate: pack.evidenceData.rateDate ?? null,
    sourceRef: plainText(pack.sourceRef, 400) ? pack.sourceRef : plainText(pack.id, 400) ? pack.id : null };
}

/**
 * The official inputs every A-stage estimate shares: commission, FX and freight, each resolved from the same reader
 * the B stage uses. Any caller that estimates one product (the owner's supplier draft) or a whole batch resolves them
 * here, so the two paths can never drift into different numbers for the same product.
 */
export function createADiscoveryEstimateInputs({ rules, readers, configuration }) {
  if (!isObject(rules) || ['commission', 'fx', 'tariff'].some(key => typeof readers?.[key] !== 'function') ||
      !isObject(configuration) || !(typeof configuration.packagingRmbDefault === 'number' && Number.isFinite(configuration.packagingRmbDefault) &&
      configuration.packagingRmbDefault >= 0)) {
    throw new TypeError('A_DISCOVERY_ESTIMATE_DEPENDENCY_INVALID');
  }
  const reference = isObject(configuration.ozonCommissionReference) ? configuration.ozonCommissionReference : null;
  const tariffFile = plainText(configuration.guooTariffFile, 4096) ? configuration.guooTariffFile : null;
  const assumptions = { packagingRmbDefault: configuration.packagingRmbDefault };

  async function resolveCommission(product, at) {
    const typeZh = typeZhFromCategoryPath(product.categoryPath);
    if (typeZh === null) return commissionGap('CATEGORY_PATH_MISSING', 'product.categoryPath');
    if (reference === null) return commissionGap('REFERENCE_NOT_CONFIGURED', 'configuration.ozonCommissionReference');
    if (!isObject(reference.versionState)) return commissionGap('VERSION_STATE_NOT_CONFIGURED', 'configuration.ozonCommissionReference.versionState');
    let read;
    try {
      read = await readers.commission({ catalogPath: reference.catalogPath, versionState: structuredClone(reference.versionState), asOf: at,
        scope: { platform: 'ozon', sellerRegion: reference.sellerRegion, salesScheme: 'rfbs', priceRub: product.price, typeIdentity: { typeZh } } });
    } catch (error) {
      return commissionGap(plainText(error?.code, 120) ? error.code : 'REFERENCE_UNREADABLE', 'configuration.ozonCommissionReference.catalogPath');
    }
    const sourceRef = plainText(read?.source?.fileSha256, 200) && plainText(read?.source?.effectiveFrom, 40)
      ? `ozon-official-commission:${read.source.effectiveFrom}:sha256:${read.source.fileSha256}` : null;
    return { rate: typeof read?.commissionRate === 'number' ? read.commissionRate : null, tier: read?.priceTier ?? null,
      sourceRef, gaps: Array.isArray(read?.gaps) ? structuredClone(read.gaps) : [] };
  }

  /**
   * The whole official rate ladder for one product type: every price band with the rate that applies inside it.
   * Same table, same version gate and same gap vocabulary as resolveCommission; it exists because pricing guidance has
   * to answer "what would this earn at another price", and the band edges must come from the table, never from code.
   */
  async function resolveCommissionTiers(product, at) {
    const typeZh = typeZhFromCategoryPath(product.categoryPath);
    if (typeZh === null) return commissionTiersGap('CATEGORY_PATH_MISSING', 'product.categoryPath');
    if (typeof readers.commissionTiers !== 'function') return commissionTiersGap('TIER_READER_NOT_CONFIGURED', 'readers.commissionTiers');
    if (reference === null) return commissionTiersGap('REFERENCE_NOT_CONFIGURED', 'configuration.ozonCommissionReference');
    if (!isObject(reference.versionState)) return commissionTiersGap('VERSION_STATE_NOT_CONFIGURED', 'configuration.ozonCommissionReference.versionState');
    let read;
    try {
      read = await readers.commissionTiers({ catalogPath: reference.catalogPath, versionState: structuredClone(reference.versionState), asOf: at,
        scope: { platform: 'ozon', sellerRegion: reference.sellerRegion, salesScheme: 'rfbs', typeIdentity: { typeZh } } });
    } catch (error) {
      return commissionTiersGap(plainText(error?.code, 120) ? error.code : 'REFERENCE_UNREADABLE', 'configuration.ozonCommissionReference.catalogPath');
    }
    const sourceRef = plainText(read?.source?.fileSha256, 200) && plainText(read?.source?.effectiveFrom, 40)
      ? `ozon-official-commission:${read.source.effectiveFrom}:sha256:${read.source.fileSha256}` : null;
    return { tiers: Array.isArray(read?.tiers) ? structuredClone(read.tiers) : [], sourceRef,
      gaps: Array.isArray(read?.gaps) ? structuredClone(read.gaps) : [] };
  }

  async function resolveFreightRows() {
    if (tariffFile === null) return { rows: [], ruleVersion: null };
    try {
      const catalog = await readers.tariff({ filePath: tariffFile });
      const ruleVersion = plainText(catalog?.ruleVersion, 120) ? catalog.ruleVersion : null;
      const rows = Array.isArray(catalog?.rows) ? catalog.rows.map(row => ({ ...row, ruleVersion })) : [];
      return { rows, ruleVersion };
    } catch { return { rows: [], ruleVersion: null }; }
  }

  async function resolveExchangeRate(document, at) {
    const saved = savedExchangeRate(document, at);
    if (saved !== null) return saved;
    try {
      const read = await readers.fx({ scope: { pair: 'RUB/CNY' } });
      if (!positive(read?.evidenceData?.rubPerCny)) return null;
      return { rubPerCny: read.evidenceData.rubPerCny, rateDate: read.evidenceData.rateDate ?? null,
        sourceRef: plainText(read.sourceRef, 400) ? read.sourceRef : null };
    } catch { return null; }
  }

  return Object.freeze({ assumptions, resolveCommission, resolveCommissionTiers, resolveFreightRows, resolveExchangeRate,
    storeRule: (document, targetStore) => storeRuleFor(document, targetStore, rules) });
}

/**
 * Owner-triggered A-stage purchase-ceiling estimate for one completed discovery batch.
 * Every input is resolved once per call and stamped into each saved record, so a number can always be traced back to
 * the official commission table, the official FX evidence and the saved GUOO tariff rows that produced it. An input
 * that cannot be resolved becomes a recorded gap: the product ends up as "needs data", never as an invented number.
 */
export function createADiscoveryEstimateUseCase({ repository, serverClock, rules, readers, configuration }) {
  if (typeof repository?.transact !== 'function' || typeof repository?.readSnapshot !== 'function' || typeof serverClock !== 'function') {
    throw new TypeError('A_DISCOVERY_ESTIMATE_DEPENDENCY_INVALID');
  }
  const { assumptions, resolveCommission, resolveFreightRows, resolveExchangeRate } =
    createADiscoveryEstimateInputs({ rules, readers, configuration });

  return Object.freeze({
    async estimateBatch({ actor, input }) {
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
      const at = serverClock();
      requireValue(instant(at), 'ESTIMATE_CLOCK_INVALID');
      const storeRule = storeRuleFor(document, batch.targetStore, rules);
      const products = readADiscoveryBatchMarketProducts({ document, batch, full: true });
      const inputs = { fxSourceRef: null, fxRateDate: null, commissionSourceRef: null, tariffRuleVersion: null,
        costPolicyVersion: plainText(storeRule.pricingPolicyVersion, 120) ? storeRule.pricingPolicyVersion : null,
        packagingRmbDefault: assumptions.packagingRmbDefault };
      if (products.length === 0) return { estimated: 0, negative: 0, needsData: 0, inputs };
      // One read per input for the whole batch; the commission table is read once per distinct type and price.
      const fx = await resolveExchangeRate(document, at);
      const freight = await resolveFreightRows();
      const commissions = new Map();
      for (const product of products) {
        const key = `${typeZhFromCategoryPath(product.categoryPath) ?? ''}\n${product.price}`;
        if (!commissions.has(key)) commissions.set(key, await resolveCommission(product, at));
      }
      inputs.fxSourceRef = fx?.sourceRef ?? null;
      inputs.fxRateDate = fx?.rateDate ?? null;
      inputs.tariffRuleVersion = freight.ruleVersion;
      inputs.commissionSourceRef = [...commissions.values()].map(value => value.sourceRef).find(value => value !== null) ?? null;
      const records = products.map(product => {
        const commission = commissions.get(`${typeZhFromCategoryPath(product.categoryPath) ?? ''}\n${product.price}`);
        const estimate = estimateDiscoveredProduct({ product, storeRule, fx, commission, tariffRows: freight.rows, assumptions });
        return assertADiscoveryEstimateRecord({ schemaVersion: A_DISCOVERY_ESTIMATE_SCHEMA_VERSION, batchId: batch.batchId,
          revision: batch.revision, productId: product.productId, estimatedAt: at,
          inputs: { ...inputs, commissionSourceRef: commission.sourceRef }, estimate },
        { batchId: batch.batchId, revision: batch.revision, productId: product.productId });
      });
      await repository.transact(currentDocument => {
        if (!isObject(currentDocument.runtime)) currentDocument.runtime = {};
        if (!Object.hasOwn(currentDocument.runtime, A_DISCOVERY_ESTIMATE_COLLECTION)) currentDocument.runtime[A_DISCOVERY_ESTIMATE_COLLECTION] = {};
        const store = currentDocument.runtime[A_DISCOVERY_ESTIMATE_COLLECTION];
        requireValue(isObject(store), 'ESTIMATE_REPOSITORY_INVALID');
        for (const record of records) {
          store[aDiscoveryEstimateKey({ batchId: record.batchId, revision: record.revision, productId: record.productId })] = structuredClone(record);
        }
        return { changed: true, document: currentDocument, result: records.length };
      });
      const outcomes = records.map(record => estimateOutcomeForPool(record.estimate));
      return { estimated: records.length, negative: outcomes.filter(outcome => outcome === 'excluded_negative').length,
        needsData: outcomes.filter(outcome => outcome === 'needs_data').length, inputs };
    }
  });
}
