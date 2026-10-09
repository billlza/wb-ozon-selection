import { assertSiblingPreparationMatchesFinal } from './sibling-preparation-consistency.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation, assertSafeBusinessMutationCandidate, assertSafeRuntimeRecord,
  createOperationAuditEvent } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord, assertNoProductionSecrets } from './production-contract-primitives.mjs';
import { resolveProductionOwnerPreparation } from './production-owner-preparation.mjs';
import { createProductionAuthorization } from './production-authorization.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { merchantSkuClaimsForStore } from './business-mutation-transaction.mjs';

export const D_BATCH_PRODUCTION_AUTHORIZATION_VERSION = 'd-batch-production-authorization-v2';
export const D_BATCH_POST_IMPORT_SCOPE_VERSION = 'd-batch-post-import-scope-v1';
const CENTRAL_MODES = new Set(['central_test', 'central_production']);
const text = value => typeof value === 'string' && value.trim().length > 0;

function assertBatchInput(input) {
  if (!input || Object.keys(input).sort().join() !== 'confirmAll,excludedOfferIds,members,parentCandidateId,parentRevision,postImportScope' ||
      input.confirmAll !== true || !text(input.parentCandidateId) ||
      !Number.isSafeInteger(input.parentRevision) || input.parentRevision < 1 ||
      !Array.isArray(input.members) || input.members.length === 0 || !Array.isArray(input.excludedOfferIds) ||
      input.excludedOfferIds.some(value => !text(value)) || new Set(input.excludedOfferIds).size !== input.excludedOfferIds.length ||
      input.members.some(member => !member || Object.keys(member).sort().join() !== 'candidateId,ownerInput' || !text(member.candidateId) ||
        !member.ownerInput || typeof member.ownerInput !== 'object') ||
      new Set(input.members.map(member => member.candidateId)).size !== input.members.length) {
    throw new Error('D_BATCH_AUTHORIZATION_INPUT_INVALID');
  }
  const scope = input.postImportScope;
  if (!scope || Object.keys(scope).sort().join() !== 'eReadbackOfferIds,inventoryAction,schemaVersion' ||
      scope.schemaVersion !== D_BATCH_POST_IMPORT_SCOPE_VERSION ||
      !['create_only','write_authorized_stock'].includes(scope.inventoryAction) ||
      !Array.isArray(scope.eReadbackOfferIds) ||
      scope.eReadbackOfferIds.length !== input.members.length ||
      scope.eReadbackOfferIds.some((offerId, index) => offerId !== input.members[index].ownerInput.merchantSku)) {
    throw new Error('D_BATCH_POST_IMPORT_SCOPE_INVALID');
  }
  assertNoProductionSecrets(input, 'dBatchAuthorizationInput');
}

/** One owner decision, one transaction, one independent authorization per member. */
export async function commitBatchOwnerProductionAuthorization({ repository, runtimeMode, actor, input,
  configuration, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (CENTRAL_MODES.has(runtimeMode)) assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' ||
      typeof serverClock !== 'function' || !configuration) throw new Error('D_BATCH_AUTHORIZATION_CONTEXT_INVALID');
  assertBatchInput(input);
  const inputFingerprint = fingerprintCanonicalRecord({ actorId: actor.userId, input });
  const batchId = `d-batch:${inputFingerprint.slice(0, 32)}`;
  return repository.transact(document => {
    const batches = document.runtime?.dProductionBatches ?? [];
    if (!Array.isArray(batches)) throw new Error('D_BATCH_STORE_INVALID');
    const prior = batches.find(batch => batch.batchId === batchId);
    if (prior) {
      if (prior.inputFingerprint !== inputFingerprint) throw new Error('D_BATCH_REPLAY_CONFLICT');
      return { changed: false, result: structuredClone(prior) };
    }
    const byCandidateId=new Map();
    for(const candidate of document.candidates){
      if(byCandidateId.has(candidate.id))throw new Error('D_BATCH_CANDIDATE_NOT_UNIQUE');
      byCandidateId.set(candidate.id,candidate);
    }
    const reservedMembers=batches.flatMap(batch=>batch.members);
    const reservedCandidateIds=new Set(reservedMembers.map(member=>member.candidateId));
    const reservedOfferIds=new Set(reservedMembers.map(member=>member.offerId));
    const parent=byCandidateId.get(input.parentCandidateId);
    const selected=parent?.sourceCapture?.selectedSkuIds;
    const firstSkuId=parent?.lifecycleV11?.skuPackage?.supplierSkuId;
    const firstOfferId=parent?.lifecycleV11?.skuPackage?.productionAuthorization?.lockedScope?.merchantSku;
    if(!parent||parent.dataRevision!==input.parentRevision||
        !Array.isArray(selected)||selected.length<2||new Set(selected).size!==selected.length||
        !text(firstSkuId)||!selected.includes(firstSkuId)||!text(firstOfferId)||
        input.excludedOfferIds.length!==1||input.excludedOfferIds[0]!==firstOfferId)
      throw new Error('D_BATCH_PARENT_SCOPE_CHANGED');
    const expectedSkuIds=selected.filter(skuId=>skuId!==firstSkuId);
    if(expectedSkuIds.length!==input.members.length)throw new Error('D_BATCH_SELECTED_MEMBERS_CHANGED');
    for(const [index,member] of input.members.entries()){
      const candidate=byCandidateId.get(member.candidateId);
      const sku=candidate?.lifecycleV11?.skuPackage;
      if(!candidate||candidate.siblingSourceV1?.parentCandidateId!==parent.id||
          candidate.siblingSourceV1?.supplierSkuId!==expectedSkuIds[index]||
          sku?.supplierSkuId!==expectedSkuIds[index]||
          candidate.sourceCapture?.offerId!==parent.sourceCapture?.offerId||
          candidate.sourceUrl!==parent.sourceUrl||
          candidate.targetPlatform!==parent.targetPlatform||
          !sameStoreRef(candidate.storeRef,parent.storeRef)||
          reservedCandidateIds.has(candidate.id))
        throw new Error('D_BATCH_SELECTED_MEMBERS_CHANGED');
    }
    const preparationDraft=(document.runtime?.siblingPreparationDrafts??[]).filter(record=>record.parentCandidateId===parent.id).at(-1);
    if (preparationDraft) assertSiblingPreparationMatchesFinal({parent,members:input.members.map(member=>byCandidateId.get(member.candidateId)),draft:preparationDraft,ownerInputs:input.members.map(member=>member.ownerInput)});
    const observedAt = serverClock();
    const evidencePacks = document.evidencePacks ?? [];
    const currentCommissionCatalogs = document.currentCommissionCatalogs ?? [];
    const prepared = [];
    for (const member of input.members) {
      const candidate = byCandidateId.get(member.candidateId);
      const sku = candidate.lifecycleV11?.skuPackage;
      if (!sku || sku.dSoftwareExecution || sku.productionRecord || sku.eVerificationRecord ||
          sku.technicalStatus === 'unknown_outcome' || candidate.lifecycleV11?.technicalStatus === 'unknown_outcome') {
        throw new Error('D_BATCH_MEMBER_ALREADY_STARTED');
      }
      const offerId = member.ownerInput.merchantSku;
      if (input.excludedOfferIds.includes(offerId)) throw new Error('D_BATCH_EXCLUDED_OFFER');
      const decision = resolveProductionOwnerPreparation({ candidate, input: member.ownerInput, configuration,
        evidencePacks, currentCommissionCatalogs, observedAt });
      const result = createProductionAuthorization({ candidate, evidencePacks, currentCommissionCatalogs,
        candidateId: candidate.id, sourceCandidateRevision: member.ownerInput.dataRevision,
        currentCandidateRevision: candidate.dataRevision, skuPackage: sku, commercialDecision: decision,
        ownerActor: actor, authorizedAt: observedAt });
      prepared.push({ candidate, sku, result, offerId });
    }
    const first = prepared[0];
    const claimsByMerchantSku=new Map();
    for(const claim of merchantSkuClaimsForStore(document,{...parent,id:null})){
      const claims=claimsByMerchantSku.get(claim.merchantSku)??[];
      claims.push(claim);claimsByMerchantSku.set(claim.merchantSku,claims);
    }
    const offerIds = new Set();
    for (const member of prepared) {
      if (offerIds.has(member.offerId)) throw new Error('D_BATCH_DUPLICATE_OFFER');
      offerIds.add(member.offerId);
      if (!text(first.candidate.sourceCapture?.offerId) ||
          member.candidate.sourceCapture?.offerId !== first.candidate.sourceCapture.offerId ||
          member.candidate.sourceUrl !== first.candidate.sourceUrl) throw new Error('D_BATCH_PRODUCT_FAMILY_MISMATCH');
      if (!sameStoreRef(member.candidate.storeRef, first.candidate.storeRef) ||
          member.candidate.targetPlatform !== first.candidate.targetPlatform) throw new Error('D_BATCH_STORE_SCOPE_MISMATCH');
      if ((claimsByMerchantSku.get(member.offerId)??[])
        .some(claim => claim.candidateId!==member.candidate.id)) throw new Error('D_BATCH_OFFER_RESERVED');
      if (reservedOfferIds.has(member.offerId)) throw new Error('D_BATCH_OFFER_RESERVED');
    }
    if (first.candidate.targetPlatform !== 'ozon') throw new Error('D_BATCH_PLATFORM_UNSUPPORTED');
    const members = prepared.map(({ candidate, sku, result, offerId }) => ({
      candidateId: candidate.id, skuPackageId: sku.skuPackageId, offerId,
      sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision + 1,
      authorizationId: result.productionAuthorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(result.productionAuthorization),
      status: 'authorized', taskId: null, productId: null, eVerificationId: null
    }));
    const batch = { schemaVersion: D_BATCH_PRODUCTION_AUTHORIZATION_VERSION, batchId,
      inputFingerprint, ownerActorId: actor.userId, confirmedAt: observedAt,
      storeRef: structuredClone(first.candidate.storeRef), excludedOfferIds: [...input.excludedOfferIds],
      postImportScope: structuredClone(input.postImportScope),
      status: 'authorized', externalRequestState: 'not_sent', members };
    assertSafeRuntimeRecord(batch, 'dBatchAuthorization');
    for (const { candidate, sku, result } of prepared) {
      candidate.lifecycleV11.skuPackage = structuredClone(result.skuPackage);
      candidate.lifecycleV11.status = 'production_authorized_awaiting_explicit_d_start';
      candidate.lifecycleV11.platformWrites = 0;
      candidate.dataRevision += 1;
      candidate.updatedAt = observedAt;
      candidate.lastModifiedBy = actor.userId;
      assertSafeBusinessMutationCandidate(candidate);
      document.runtime.operationAudit.push(createOperationAuditEvent({
        eventId: `audit:${batchId}:${candidate.id}`, action: 'authorize_batch_production_member', actor,
        candidateId: candidate.id, skuPackageId: sku.skuPackageId,
        sourceRevision: candidate.dataRevision - 1, resultRevision: candidate.dataRevision,
        fromState: 'awaiting_owner_business_confirmation', toState: 'production_authorized_awaiting_explicit_d_start',
        authorizationRef: result.productionAuthorization.authorizationId,
        idempotencyKey: batchId, serverTime: observedAt
      }));
    }
    document.runtime.dProductionBatches = [...batches, batch];
    return { changed: true, document, result: structuredClone(batch) };
  });
}
