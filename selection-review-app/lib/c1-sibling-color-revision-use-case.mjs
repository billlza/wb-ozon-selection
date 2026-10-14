import { isDeepStrictEqual } from 'node:util';
import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { assertValidLifecyclePackage } from './product-lifecycle-schema.mjs';
import { replaceC1ProductPlanForRightsReview } from './c1-product-plan.mjs';
import { buildC1FinalPlanHistoryReferences, clearC1FinalPlanActiveReferences,
  hasUnsettledC1ColorDictionaryRead } from './c1-final-plan-revision-preparation.mjs';
import { assertSiblingSkuColorProjection } from './sibling-sku-card-guard.mjs';

const DOWNSTREAM = [
  'productionAuthorization', 'dHandoff', 'dAssetTransport', 'productionRecord',
  'externalListingRecord', 'eVerificationRecord'
];

export class C1SiblingColorRevisionError extends Error {
  constructor(code) { super(code); this.name = 'C1SiblingColorRevisionError'; this.code = code; }
}
const reject = code => { throw new C1SiblingColorRevisionError(code); };

/** A new C1 plan is the only way to reopen a frozen sibling mapping. */
export function prepareC1SiblingColorRevision({ candidate, expectedRevision, relatedSoftwareJobs, preparedAt }) {
  if (!candidate?.siblingSourceV1 || candidate.dataRevision !== expectedRevision ||
      !Number.isSafeInteger(expectedRevision) || !Number.isFinite(Date.parse(preparedAt)) ||
      !Array.isArray(relatedSoftwareJobs)) reject('C1_SIBLING_COLOR_REVISION_INPUT_INVALID');
  const life = candidate.lifecycleV11;
  if (hasUnsettledC1ColorDictionaryRead(life)) reject('C1_SIBLING_COLOR_REVISION_DICTIONARY_READ_UNSETTLED');
  const previous = life?.skuPackage;
  if (!previous || !['C1', 'C2'].includes(previous.businessPhase) ||
      !['facts_checked', 'seo_draft_ready'].includes(previous.c1ProductPlan?.status) ||
      previous.supplierSkuId !== candidate.siblingSourceV1.supplierSkuId) {
    reject('C1_SIBLING_COLOR_REVISION_SOURCE_INVALID');
  }
  if (DOWNSTREAM.some(key => previous[key] !== undefined && previous[key] !== null)) {
    reject('C1_SIBLING_COLOR_REVISION_PRODUCTION_STARTED');
  }
  if (relatedSoftwareJobs.some(job => !['completed', 'failed'].includes(job.status) ||
      ['sent', 'unknown_outcome'].includes(job.externalRequestState))) {
    reject('C1_SIBLING_COLOR_REVISION_JOB_UNSETTLED');
  }
  assertValidLifecyclePackage(previous);
  let mappingIncomplete = false;
  try { assertSiblingSkuColorProjection(candidate); }
  catch (error) {
    if (error.message !== 'SIBLING_COLOR_BINDING_INVALID') throw error;
    mappingIncomplete = true;
  }
  if (!mappingIncomplete) reject('C1_SIBLING_COLOR_REVISION_NOT_REQUIRED');
  const preparationId = `sibling-color-revision:${previous.skuPackageId}:${expectedRevision + 1}`;
  const next = structuredClone(candidate);
  const staged = structuredClone(previous);
  staged.businessPhase = 'C1';
  staged.c2FinalAssets = null;
  staged.productionConfirmationCard = null;
  const rebuilt = structuredClone(replaceC1ProductPlanForRightsReview({ skuPackage: staged,
    expectedC1PlanId: previous.c1ProductPlan.c1PlanId, historyRef: preparationId, createdAt: preparedAt }).skuPackage);
  if (!isDeepStrictEqual(rebuilt.profitModels, previous.profitModels) ||
      !isDeepStrictEqual(rebuilt.selectedSupplySnapshot, previous.selectedSupplySnapshot) ||
      !isDeepStrictEqual(rebuilt.c1ProductPlan.inputSnapshots.platformSchemaRules,
        previous.c1ProductPlan.inputSnapshots.platformSchemaRules)) {
    reject('C1_SIBLING_COLOR_REVISION_FROZEN_INPUT_CHANGED');
  }
  delete rebuilt.ozonAttributeMappingsV1;
  rebuilt.ownerAction = 'review_compliance_risk';
  next.lifecycleV11.skuPackage = rebuilt;
  const previousC1References = buildC1FinalPlanHistoryReferences(life);
  clearC1FinalPlanActiveReferences(next.lifecycleV11);
  delete next.lifecycleV11.c2UploadDraft;
  next.lifecycleV11.c1SiblingColorRevisionPreparation = {
    schemaVersion: 'c1-sibling-color-revision-preparation-v1', preparationId,
    sourceCandidateRevision: expectedRevision, sourceSkuRevision: previous.dataRevision,
    sourceC1PlanId: previous.c1ProductPlan.c1PlanId, targetC1PlanId: rebuilt.c1ProductPlan.c1PlanId,
    historyRef: preparationId, preparedAt, productionAuthorized: false
  };
  next.updatedAt = preparedAt;
  next.lastModifiedBy = 'software';
  const historyRecord = {
    schemaVersion: 'c1-sibling-color-revision-history-v1', preparationId,
    candidateId: candidate.id, sourceCandidateRevision: expectedRevision,
    sourceSkuRevision: previous.dataRevision,
    previousSkuPackage: structuredClone(previous), previousC1References
  };
  return { candidate: next, historyRecord, result: {
    ...next.lifecycleV11.c1SiblingColorRevisionPreparation,
    nextStep: 'confirm_c1_rights_and_map_color', externalCalls: 0,
    paidCalls: 0, platformWrites: 0, oldC2ConfirmationReused: false
  } };
}

export function createC1SiblingColorRevisionUseCase({ repository, runtimeMode, serverClock }) {
  return Object.freeze({ async prepare({ actor, input }) {
    authorizeOperation({ actor, requiredRoles: ['owner'] });
    if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
      reject('C1_SIBLING_COLOR_REVISION_OWNER_REQUIRED');
    }
    if (!input || Object.keys(input).sort().join(',') !== 'candidateId,expectedRevision,skuPackageId' ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        typeof input.candidateId !== 'string' || !input.candidateId ||
        typeof input.skuPackageId !== 'string' || !input.skuPackageId) {
      reject('C1_SIBLING_COLOR_REVISION_INPUT_INVALID');
    }
    const key = `sibling-color-revision:${input.candidateId}:${input.expectedRevision}`;
    return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
      action: 'prepare_sibling_color_revision', candidateId: input.candidateId,
      skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
      idempotencyKey: key, inputFingerprint: fingerprintCanonicalRecord(input),
      auditEventId: `${key}:audit`, serverClock, includeRelatedSoftwareJobs: true,
      mutate: ({ candidate, relatedSoftwareJobs, observedAt }) => {
        if (candidate.lifecycleV11?.skuPackage?.skuPackageId !== input.skuPackageId) {
          reject('C1_SIBLING_COLOR_REVISION_SOURCE_INVALID');
        }
        return prepareC1SiblingColorRevision({ candidate, expectedRevision: input.expectedRevision,
          relatedSoftwareJobs, preparedAt: observedAt });
      } });
  } });
}
