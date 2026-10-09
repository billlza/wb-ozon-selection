import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { prepareProductionCommercialDraft, ProductionCommercialDraftError } from './production-commercial-draft.mjs';

export function createProductionCommercialDraftUseCase({ repository, runtimeMode, serverClock }) {
  return Object.freeze({ async save({ actor, input }) {
    authorizeOperation({ actor, requiredRoles: ['owner'] });
    if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') throw new ProductionCommercialDraftError('PRODUCTION_COMMERCIAL_DRAFT_OWNER_REQUIRED');
    const keys = ['candidateId', 'skuPackageId', 'expectedRevision', 'merchantSku', 'stock'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length ||
        keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        ![input.candidateId, input.skuPackageId].every(value => typeof value === 'string' && value.trim())) {
      throw new ProductionCommercialDraftError('PRODUCTION_COMMERCIAL_DRAFT_INPUT_INVALID');
    }
    const key = `commercial-draft:${input.candidateId}:${input.expectedRevision}`;
    return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'], action: 'save_production_commercial_draft',
      candidateId: input.candidateId, skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
      idempotencyKey: key, inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }), auditEventId: `${key}:audit`,
      serverClock, includeMerchantSkuClaims: true,
      mutate: ({ candidate, merchantSkuClaims, observedAt }) => {
        if (candidate.lifecycleV11?.skuPackage?.skuPackageId !== input.skuPackageId) throw new ProductionCommercialDraftError('PRODUCTION_COMMERCIAL_DRAFT_SOURCE_MISMATCH');
        const prepared = prepareProductionCommercialDraft({ candidate, merchantSku: input.merchantSku, stock: input.stock,
          savedByUserId: actor.userId, savedAt: observedAt, merchantSkuClaims });
        prepared.candidate.dataRevision = candidate.dataRevision;
        return { candidate: prepared.candidate, result: { draft: prepared.draft, productionAuthorized: false, externalRequests: 0, platformWrites: 0 } };
      } });
  } });
}
