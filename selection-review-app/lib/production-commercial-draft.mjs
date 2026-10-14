import { sameStoreRef } from './store-binding.mjs';

export class ProductionCommercialDraftError extends Error {
  constructor(code) { super(code); this.name = 'ProductionCommercialDraftError'; this.code = code; }
}
const fail = code => { throw new ProductionCommercialDraftError(code); };
const fields = ['schemaVersion', 'draftId', 'status', 'candidateId', 'skuPackageId', 'supplierSkuId', 'variantKey', 'platform', 'storeRef',
  'sourceCandidateRevision', 'resultCandidateRevision', 'sourceSkuRevision', 'merchantSku', 'stock', 'savedByUserId', 'sourceInstructionRef', 'savedAt',
  'productionAuthorizationGranted', 'localUniquenessScope', 'platformUniquenessVerified'];
export const isCommercialMerchantSku = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);
const ownerSource = (userId, instructionRef) =>
  (typeof userId === 'string' && userId.trim().length > 0 && instructionRef === null) ||
  (userId === null && instructionRef === 'source:user_response_annotations');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Shared by the displayed preview and the final authorization resolver. This
 * is an owner-saved commercial input, never a production authorization. */
export function readProductionCommercialDraft(candidate) {
  const record = candidate?.lifecycleV11?.productionCommercialDraftV1;
  if (record === undefined) return null;
  const sku = candidate.lifecycleV11.skuPackage;
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== fields.length ||
      fields.some(key => !Object.hasOwn(record, key)) || record.schemaVersion !== 'production-commercial-draft-v1' ||
      record.status !== 'saved_for_final_review' || !isCommercialMerchantSku(record.merchantSku) ||
      !Number.isSafeInteger(record.stock) || record.stock < 0 || !timestamp(record.savedAt) ||
      !ownerSource(record.savedByUserId, record.sourceInstructionRef) ||
      !Number.isSafeInteger(record.sourceCandidateRevision) || record.sourceCandidateRevision < 0 ||
      record.resultCandidateRevision !== record.sourceCandidateRevision + 1 || record.resultCandidateRevision > candidate.dataRevision ||
      !Number.isSafeInteger(record.sourceSkuRevision) || record.sourceSkuRevision < 1 || record.sourceSkuRevision > sku?.dataRevision ||
      record.draftId !== `commercial-draft:${candidate.id}:${record.resultCandidateRevision}` ||
      !Number.isSafeInteger(candidate.dataRevision) || !sku || !Number.isSafeInteger(sku.dataRevision) ||
      record.candidateId !== candidate.id || record.skuPackageId !== sku.skuPackageId || record.supplierSkuId !== sku.supplierSkuId ||
      record.variantKey !== sku.variantKey || record.platform !== candidate.targetPlatform || record.platform !== sku.targetPlatform ||
      !sameStoreRef(record.storeRef, candidate.storeRef) || !sameStoreRef(record.storeRef, sku.g1Identity?.storeRef) ||
      sku.g1Identity?.candidateId !== candidate.id || record.productionAuthorizationGranted !== false ||
      record.localUniquenessScope !== 'saved_local_records_only' || record.platformUniquenessVerified !== false) {
    fail('PRODUCTION_COMMERCIAL_DRAFT_INVALID');
  }
  return structuredClone(record);
}

export function prepareProductionCommercialDraft({ candidate, merchantSku, stock, savedByUserId = null, sourceInstructionRef = null, savedAt, merchantSkuClaims }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  if (!sku || !['C1', 'C2'].includes(sku.businessPhase) || sku.productionAuthorization || sku.productionRecord || sku.dHandoff ||
      sku.externalListingRecord || sku.productionConfirmationCard?.ownerDecision) fail('PRODUCTION_COMMERCIAL_DRAFT_PHASE_REJECTED');
  if (!isCommercialMerchantSku(merchantSku) || !Number.isSafeInteger(stock) || stock < 0 || !timestamp(savedAt) ||
      !ownerSource(savedByUserId, sourceInstructionRef) || !Array.isArray(merchantSkuClaims) || merchantSkuClaims.some(claim => !claim || typeof claim.candidateId !== 'string' ||
        typeof claim.merchantSku !== 'string' || !claim.merchantSku.trim())) fail('PRODUCTION_COMMERCIAL_DRAFT_INPUT_INVALID');
  if (merchantSkuClaims.some(claim => claim.merchantSku === merchantSku && claim.candidateId !== candidate.id)) {
    fail('PRODUCTION_COMMERCIAL_DRAFT_LOCAL_SKU_CONFLICT');
  }
  const record = { schemaVersion: 'production-commercial-draft-v1', draftId: `commercial-draft:${candidate.id}:${candidate.dataRevision + 1}`,
    status: 'saved_for_final_review', candidateId: candidate.id, skuPackageId: sku.skuPackageId, supplierSkuId: sku.supplierSkuId,
    variantKey: sku.variantKey, platform: sku.targetPlatform, storeRef: structuredClone(sku.g1Identity.storeRef),
    sourceCandidateRevision: candidate.dataRevision, resultCandidateRevision: candidate.dataRevision + 1, sourceSkuRevision: sku.dataRevision,
    merchantSku, stock, savedByUserId, sourceInstructionRef, savedAt, productionAuthorizationGranted: false,
    localUniquenessScope: 'saved_local_records_only', platformUniquenessVerified: false };
  const next = structuredClone(candidate);
  const previous = readProductionCommercialDraft(candidate);
  if (previous !== null) next.lifecycleV11.productionCommercialDraftHistoryV1 = [...(candidate.lifecycleV11.productionCommercialDraftHistoryV1 ?? []), previous];
  next.lifecycleV11.productionCommercialDraftV1 = record;
  next.dataRevision += 1; next.updatedAt = savedAt; next.lastModifiedBy = savedByUserId ?? sourceInstructionRef;
  readProductionCommercialDraft(next);
  return { candidate: next, draft: structuredClone(record) };
}
