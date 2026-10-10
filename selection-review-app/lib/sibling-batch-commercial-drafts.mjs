import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { merchantSkuClaimsForStore } from './business-mutation-transaction.mjs';
import { prepareProductionCommercialDraft } from './production-commercial-draft.mjs';
import { assertSafeBusinessMutationCandidate, authorizeOperation, createOperationAuditEvent } from './runtime-identity.mjs';
import { sameStoreRef } from './store-binding.mjs';

const centralModes = new Set(['central_test', 'central_production']);
const validText = value => typeof value === 'string' && value.trim().length > 0;

/** Save only the selected siblings' commercial drafts, with no platform or price mutation. */
export async function saveSiblingBatchCommercialDrafts({ repository, runtimeMode, actor, input, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (centralModes.has(runtimeMode)) assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' || typeof serverClock !== 'function') {
    throw new Error('SIBLING_BATCH_COMMERCIAL_OWNER_REQUIRED');
  }
  if (!input || Object.keys(input).sort().join() !== 'members,parentCandidateId,parentRevision' ||
      !validText(input.parentCandidateId) || !Number.isSafeInteger(input.parentRevision) ||
      !Array.isArray(input.members) || input.members.length === 0 || input.members.length > 100 ||
      input.members.some(member => !member || Object.keys(member).sort().join() !==
        'candidateId,expectedRevision,merchantSku,skuPackageId,stock' || !validText(member.candidateId) ||
        !validText(member.skuPackageId) || !validText(member.merchantSku) ||
        !Number.isSafeInteger(member.expectedRevision) || !Number.isSafeInteger(member.stock) || member.stock < 0) ||
      new Set(input.members.map(member => member.candidateId)).size !== input.members.length ||
      new Set(input.members.map(member => member.merchantSku)).size !== input.members.length) {
    throw new Error('SIBLING_BATCH_COMMERCIAL_INPUT_INVALID');
  }
  return repository.transact(document => {
    if (!Array.isArray(document.candidates) || !Array.isArray(document.runtime?.operationAudit)) {
      throw new Error('SIBLING_BATCH_COMMERCIAL_STORE_INVALID');
    }
    const byCandidateId = new Map();
    const positionByCandidateId = new Map();
    for (const [position, candidate] of document.candidates.entries()) {
      if (byCandidateId.has(candidate.id)) throw new Error('SIBLING_BATCH_COMMERCIAL_CANDIDATE_NOT_UNIQUE');
      byCandidateId.set(candidate.id, candidate);
      positionByCandidateId.set(candidate.id, position);
    }
    const parent = byCandidateId.get(input.parentCandidateId);
    if (!parent || parent.dataRevision !== input.parentRevision) throw new Error('SIBLING_BATCH_COMMERCIAL_PARENT_CHANGED');
    const selected = parent.sourceCapture?.selectedSkuIds;
    const parentSkuId = parent.lifecycleV11?.skuPackage?.supplierSkuId;
    if (!Array.isArray(selected) || !validText(parentSkuId) || !selected.includes(parentSkuId) ||
        new Set(selected).size !== selected.length) throw new Error('SIBLING_BATCH_COMMERCIAL_SELECTION_INVALID');
    const expected = selected.filter(sourceSkuId => sourceSkuId !== parentSkuId);
    if (expected.length !== input.members.length) throw new Error('SIBLING_BATCH_COMMERCIAL_MEMBERS_CHANGED');
    const members = input.members.map((member, index) => {
      const candidate = byCandidateId.get(member.candidateId);
      const sku = candidate?.lifecycleV11?.skuPackage;
      if (!candidate || candidate.dataRevision !== member.expectedRevision ||
          candidate.siblingSourceV1?.parentCandidateId !== parent.id ||
          candidate.siblingSourceV1?.supplierSkuId !== expected[index] ||
          sku?.supplierSkuId !== expected[index] || sku?.skuPackageId !== member.skuPackageId ||
          candidate.targetPlatform !== parent.targetPlatform || !sameStoreRef(candidate.storeRef, parent.storeRef) ||
          candidate.sourceUrl !== parent.sourceUrl ||
          candidate.sourceCapture?.offerId !== parent.sourceCapture?.offerId ||
          sku.productionAuthorization || sku.productionRecord || sku.dSoftwareExecution ||
          sku.technicalStatus === 'unknown_outcome') {
        throw new Error('SIBLING_BATCH_COMMERCIAL_MEMBER_CHANGED');
      }
      return { member, candidate };
    });
    const claimsByMerchantSku=new Map();
    for(const claim of merchantSkuClaimsForStore(document,{...parent,id:null})){
      const claims=claimsByMerchantSku.get(claim.merchantSku)??[];
      claims.push(claim);claimsByMerchantSku.set(claim.merchantSku,claims);
    }
    const savedAt = serverClock();
    const prepared = members.map(({ member, candidate }) => prepareProductionCommercialDraft({ candidate,
      merchantSku: member.merchantSku, stock: member.stock, savedByUserId: actor.userId,
      savedAt, merchantSkuClaims: (claimsByMerchantSku.get(member.merchantSku)??[])
        .filter(claim=>claim.candidateId!==candidate.id) }));
    for (const [index, { candidate }] of members.entries()) {
      const updated = prepared[index].candidate;
      assertSafeBusinessMutationCandidate(updated);
      document.candidates[positionByCandidateId.get(candidate.id)] = updated;
      document.runtime.operationAudit.push(createOperationAuditEvent({
        eventId: `audit:batch-commercial:${candidate.id}:${updated.dataRevision}`,
        action: 'save_sibling_batch_commercial_draft', actor, candidateId: candidate.id,
        skuPackageId: input.members[index].skuPackageId, sourceRevision: candidate.dataRevision,
        resultRevision: updated.dataRevision, fromState: candidate.lifecycleV11?.skuPackage?.businessPhase ?? 'C1',
        toState: updated.lifecycleV11?.skuPackage?.businessPhase ?? 'C1',
        idempotencyKey: `batch-commercial:${parent.id}:${input.parentRevision}:${candidate.id}:${candidate.dataRevision}`,
        serverTime: savedAt
      }));
    }
    return { changed: true, document, result: { members: prepared.map(({ candidate, draft }) => ({
      candidateId: candidate.id, resultRevision: candidate.dataRevision, draftId: draft.draftId })),
      externalRequests: 0, platformWrites: 0 } };
  });
}
