import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { prepareOwnerProductFacts, OwnerProductFactsError } from './owner-product-facts.mjs';

export function createOwnerProductFactsUseCase({ repository, runtimeMode, serverClock }) {
  if (!['local_development', 'central_test', 'central_production'].includes(runtimeMode) || typeof serverClock !== 'function') {
    throw new TypeError('OWNER_PRODUCT_FACTS_DEPENDENCY_INVALID');
  }
  if (runtimeMode === 'local_development') assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({ async save({ actor, input }) {
    authorizeOperation({ actor, requiredRoles: ['owner'] });
    if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') throw new OwnerProductFactsError('OWNER_PRODUCT_FACTS_OWNER_REQUIRED');
    const keys = ['candidateId', 'skuPackageId', 'expectedRevision', 'facts'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length ||
        keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        ![input.candidateId, input.skuPackageId].every(value => typeof value === 'string' && value.trim())) {
      throw new OwnerProductFactsError('OWNER_PRODUCT_FACTS_INPUT_INVALID');
    }
    input = structuredClone(input); actor = structuredClone(actor);
    const key = `owner-product-facts:${input.candidateId}:${input.expectedRevision}`;
    return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'], action: 'save_owner_product_facts',
      candidateId: input.candidateId, skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
      idempotencyKey: key, inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }), auditEventId: `${key}:audit`, serverClock,
      mutate: ({ candidate, observedAt }) => {
        if (candidate.lifecycleV11?.skuPackage?.skuPackageId !== input.skuPackageId) throw new OwnerProductFactsError('OWNER_PRODUCT_FACTS_SOURCE_MISMATCH');
        const prepared = prepareOwnerProductFacts({ candidate, facts: input.facts, confirmedByUserId: actor.userId, confirmedAt: observedAt });
        prepared.candidate.dataRevision = candidate.dataRevision;
        return { candidate: prepared.candidate, result: { declaration: prepared.declaration, productionAuthorized: false,
          newPlanCreated: false, externalRequests: 0, paidCalls: 0, platformWrites: 0 } };
      } });
  } });
}
