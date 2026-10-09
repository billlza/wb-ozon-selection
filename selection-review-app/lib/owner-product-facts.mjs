import { isDeepStrictEqual } from 'node:util';
import { sameStoreRef } from './store-binding.mjs';
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, isCanonicalFrozenRef } from './production-contract-primitives.mjs';

export class OwnerProductFactsError extends Error {
  constructor(code) { super(code); this.name = 'OwnerProductFactsError'; this.code = code; }
}
const fail = code => { throw new OwnerProductFactsError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 240 &&
  !/[\u0000-\u001f\u007f]/.test(value) && !['unknown', 'null', 'undefined', 'not_applicable'].includes(value.toLowerCase());
export const OWNER_PRODUCT_FACT_LABELS = Object.freeze({ productForm: '商品形态', intendedUses: '适用对象', closureType: '闭合方式', adjustable: '是否可调', detachable: '是否可拆' });
const FACT_FIELDS = Object.keys(OWNER_PRODUCT_FACT_LABELS);
const RECORD_FIELDS = ['schemaVersion', 'declarationId', 'status', 'sourceIdentity', 'variantKey', 'sourceSupplySnapshotId',
  'sourceCandidateRevision', 'resultCandidateRevision', 'sourceSkuRevision', 'facts', 'confirmedByUserId', 'sourceInstructionRef',
  'confirmedAt', 'productionAuthorizationGranted'];
function validFacts(facts) {
  return exact(facts, FACT_FIELDS) && ['productForm', 'closureType'].every(key => facts[key] === null || text(facts[key])) &&
    ['adjustable', 'detachable'].every(key => facts[key] === null || typeof facts[key] === 'boolean') &&
    (facts.intendedUses === null || (Array.isArray(facts.intendedUses) && facts.intendedUses.length > 0 && facts.intendedUses.length <= 20 &&
      facts.intendedUses.every(text) && new Set(facts.intendedUses).size === facts.intendedUses.length));
}
function validOrigin(userId, instructionRef) {
  return (text(userId) && instructionRef === null) || (userId === null && instructionRef === 'source:user_response_annotations');
}
function sourceFor(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage, identity = sku?.g1Identity, supply = sku?.selectedSupplySnapshot;
  if (!candidate || !Number.isSafeInteger(candidate.dataRevision) || candidate.dataRevision < 0 || !isCanonicalFrozenRef(candidate.id) ||
      !sku || !Number.isSafeInteger(sku.dataRevision) || sku.dataRevision < 1 || !text(sku.variantKey) ||
      identity?.schemaVersion !== 'g1-identity-v1' || identity.candidateId !== candidate.id || identity.skuPackageId !== sku.skuPackageId ||
      identity.supplierSkuId !== sku.supplierSkuId || identity.platform !== candidate.targetPlatform || identity.platform !== sku.targetPlatform ||
      !sameStoreRef(identity.storeRef, candidate.storeRef) || identity.storeRef.stableStoreId !== candidate.targetStore ||
      !isCanonicalFrozenRef(sku.skuPackageId) || !isCanonicalFrozenRef(sku.supplierSkuId) ||
      !isCanonicalFrozenRef(supply?.snapshotId) || supply.ownerSupplyConfirmation?.status !== 'confirmed' ||
      [supply.supplierSku, supply.ownerSupplyConfirmation].some(item => !object(item) || item.supplierSkuId !== sku.supplierSkuId || item.variantKey !== sku.variantKey)) {
    fail('OWNER_PRODUCT_FACTS_SOURCE_MISMATCH');
  }
  return { sku, identity, supply };
}
function validateRecord(record, candidate, source) {
  if (!exact(record, RECORD_FIELDS) || record.schemaVersion !== 'owner-product-facts-v1' || record.status !== 'saved_for_new_plan' ||
      !validFacts(record.facts) || !validOrigin(record.confirmedByUserId, record.sourceInstructionRef) || !timestamp(record.confirmedAt) ||
      !Number.isSafeInteger(record.sourceCandidateRevision) || record.sourceCandidateRevision < 0 ||
      record.resultCandidateRevision !== record.sourceCandidateRevision + 1 || record.resultCandidateRevision > candidate.dataRevision ||
      !Number.isSafeInteger(record.sourceSkuRevision) || record.sourceSkuRevision < 1 || record.sourceSkuRevision > source.sku.dataRevision ||
      record.declarationId !== `owner-product-facts:${candidate.id}:${record.resultCandidateRevision}` ||
      !isDeepStrictEqual(record.sourceIdentity, source.identity) || record.variantKey !== source.sku.variantKey ||
      record.sourceSupplySnapshotId !== source.supply.snapshotId || record.productionAuthorizationGranted !== false) {
    fail('OWNER_PRODUCT_FACTS_RECORD_INVALID');
  }
  assertNoRawPersistenceKeys(record, 'ownerProductFacts');
  assertNoProductionSecrets(record, 'ownerProductFacts');
}

/** Only this saved declaration supplies these facts; absence is not a negative claim.
 * Later candidate/SKU revisions can reuse it while its exact supply identity holds. */
export function readOwnerProductFacts(candidate) {
  const record = candidate?.lifecycleV11?.ownerProductFactsV1;
  if (record === undefined) return null;
  validateRecord(record, candidate, sourceFor(candidate));
  return structuredClone(record);
}

/** Pure preparation. An explicit annotation is supported for isolated previews;
 * the authenticated save use case never accepts that provenance from input. */
export function prepareOwnerProductFacts({ candidate, facts, confirmedByUserId = null, sourceInstructionRef = null, confirmedAt }) {
  const source = sourceFor(candidate), { sku } = source;
  if (!['C1', 'C2'].includes(sku.businessPhase) ||
      ['productionAuthorization', 'productionRecord', 'dHandoff', 'dAssetTransport', 'externalListingRecord', 'eVerificationRecord']
        .some(key => sku[key] !== undefined && sku[key] !== null) || sku.productionConfirmationCard?.ownerDecision) {
    fail('OWNER_PRODUCT_FACTS_PHASE_REJECTED');
  }
  if (!validFacts(facts) || !validOrigin(confirmedByUserId, sourceInstructionRef) || !timestamp(confirmedAt)) fail('OWNER_PRODUCT_FACTS_INPUT_INVALID');
  const previous = readOwnerProductFacts(candidate), history = candidate.lifecycleV11.ownerProductFactsHistoryV1;
  if (history !== undefined && (!Array.isArray(history) || previous === null)) fail('OWNER_PRODUCT_FACTS_HISTORY_INVALID');
  let lastRevision = -1;
  for (const record of history ?? []) {
    validateRecord(record, candidate, source);
    if (record.resultCandidateRevision <= lastRevision || record.resultCandidateRevision >= previous.resultCandidateRevision) fail('OWNER_PRODUCT_FACTS_HISTORY_INVALID');
    lastRevision = record.resultCandidateRevision;
  }
  if (previous && Date.parse(confirmedAt) < Date.parse(previous.confirmedAt)) fail('OWNER_PRODUCT_FACTS_TIME_INVALID');
  const declaration = { schemaVersion: 'owner-product-facts-v1', declarationId: `owner-product-facts:${candidate.id}:${candidate.dataRevision + 1}`,
    status: 'saved_for_new_plan', sourceIdentity: structuredClone(source.identity), variantKey: sku.variantKey,
    sourceSupplySnapshotId: source.supply.snapshotId, sourceCandidateRevision: candidate.dataRevision,
    resultCandidateRevision: candidate.dataRevision + 1, sourceSkuRevision: sku.dataRevision, facts: structuredClone(facts),
    confirmedByUserId, sourceInstructionRef, confirmedAt, productionAuthorizationGranted: false };
  const next = structuredClone(candidate);
  if (previous) next.lifecycleV11.ownerProductFactsHistoryV1 = [...(history ?? []), previous];
  next.lifecycleV11.ownerProductFactsV1 = declaration;
  next.dataRevision += 1; next.updatedAt = confirmedAt; next.lastModifiedBy = confirmedByUserId ?? sourceInstructionRef;
  readOwnerProductFacts(next);
  return { candidate: next, declaration: structuredClone(declaration) };
}
