import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { prepareC1FinalPlanRevision } from './c1-final-plan-revision-preparation.mjs';
export function createC1FinalPlanRevisionUseCase({ repository, runtimeMode, serverClock }) {
  return Object.freeze({ async prepare({ actor, input }) {
    authorizeOperation({ actor, requiredRoles: ['owner'] });
    if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') throw new Error('C1_FINAL_REVISION_OWNER_REQUIRED');
    if (!input || Object.keys(input).sort().join(',') !== 'candidateId,expectedRevision,skuPackageId' ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        typeof input.candidateId !== 'string' || !input.candidateId || typeof input.skuPackageId !== 'string' || !input.skuPackageId) throw new Error('C1_FINAL_REVISION_INPUT_INVALID');
    const key = `final-plan-revision:${input.candidateId}:${input.expectedRevision}`;
    return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'], action: 'prepare_final_plan_revision',
      candidateId: input.candidateId, skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
      idempotencyKey: key, inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: `${key}:audit`, serverClock,
      mutate: ({ candidate, observedAt }) => {
        if (candidate.lifecycleV11?.skuPackage?.skuPackageId !== input.skuPackageId) throw new Error('C1_FINAL_REVISION_SOURCE_MISMATCH');
        const result = prepareC1FinalPlanRevision({ candidate, expectedRevision: input.expectedRevision, preparedAt: observedAt });
        // The shared transaction owns the one candidate revision increment.
        result.candidate.dataRevision = candidate.dataRevision;
        return { candidate: result.candidate, finalPlanHistoryRecord: result.historyRecord, result: { ...result.preparation, mappingGaps: result.mappingGaps,
          nextStep: result.nextStep, finalCardCreated: false, productionAuthorized: false } };
      } });
  } });
}
