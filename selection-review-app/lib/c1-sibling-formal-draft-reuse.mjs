import { isDeepStrictEqual } from 'node:util';
import { mergeC1AiDraftReceipt } from './c1-ai-draft-contract.mjs';
import { assertC1EditorialPlan } from './c1-editorial-review-contract.mjs';
import { assertValidC1ProductPlan, collectC1UnknownManifest } from './c1-product-plan.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { assertC1SiblingNeutralReuse, C1_SIBLING_NEUTRAL_REUSE_VERSION } from './c1-sibling-neutral-copy.mjs';

export const C1_SIBLING_FORMAL_REUSE_VERSION = 'c1-sibling-formal-reuse-v1';
export const C1_SIBLING_FORMAL_REFERENCE_VERSION = 'c1-sibling-formal-reference-v1';
const CONTENT = ['seoTitleDraft', 'descriptionDraft', 'bulletPointsDraft', 'searchKeywordsDraft', 'seoEvidenceLayer', 'keywordEvidenceRefs'];
const fail = code => { throw new Error(code); };
const factAt = (plan, path) => path.split('.').reduce((value, key) => value?.[key], plan);
const factMeaningAt = (plan, path) => {
  const fact = factAt(plan, path);
  if (!fact || fact.verificationStatus !== 'confirmed' || !Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) {
    fail('C1_SIBLING_SHARED_FACT_NOT_CONFIRMED');
  }
  return fact.value;
};

function adoptedFactPaths(plan) {
  const pieces = [plan.seoTitleDraft, plan.descriptionDraft, ...plan.bulletPointsDraft, ...plan.searchKeywordsDraft.keywords];
  for (const piece of pieces) {
    if (!Array.isArray(piece.factRefs) || !Array.isArray(piece.assertions) ||
        piece.factRefs.length !== piece.assertions.length ||
        !isDeepStrictEqual([...piece.factRefs].sort(), piece.assertions.map(item => item.factPath).sort()) ||
        piece.assertions.some(item => !isDeepStrictEqual(item.value, factMeaningAt(plan, item.factPath)))) {
      fail('C1_SIBLING_SHARED_ASSERTION_DIFFERENCE');
    }
  }
  const paths = pieces.flatMap(piece => piece.factRefs);
  if (paths.length === 0 || paths.some(path => typeof path !== 'string' || !path)) fail('C1_SIBLING_SHARED_FACT_REFS_REQUIRED');
  return [...new Set(paths)].sort();
}

function assertSource(record) {
  if (record?.schemaVersion !== C1_SIBLING_FORMAL_REUSE_VERSION || !record.sourcePlan ||
      !record.sourceIdentity || !['provider_receipt', 'owner_confirmed_editorial'].includes(record.sourceKind) ||
      !record.targetIdentity || !record.targetPlanId || !Number.isSafeInteger(record.resultSkuRevision) ||
      !Array.isArray(record.adoptedFactPaths) || !record.sourceFactFingerprint || !record.targetFactFingerprint ||
      !record.sourceCandidateId || !Number.isSafeInteger(record.sourceCandidateRevision) ||
      !Number.isSafeInteger(record.targetCandidateRevision) ||
      record.sourceCandidateId !== record.sourceIdentity.candidateId ||
      record.sourceIdentity.candidateId === record.targetIdentity.candidateId ||
      record.sourceIdentity.skuPackageId === record.targetIdentity.skuPackageId) fail('C1_SIBLING_SHARED_RECORD_INVALID');
  const source = record.sourcePlan;
  assertValidC1ProductPlan(source);
  if (source.status !== 'seo_draft_ready') fail('C1_SIBLING_SHARED_SOURCE_NOT_FORMAL');
  if (record.sourceKind === 'provider_receipt') {
    if (!record.request || !record.receipt || !record.settledExecution ||
        source.draftOnlySeo?.formalProviderResultAccepted !== true || source.draftOnlySeo?.sourceType !== undefined) {
      fail('C1_SIBLING_SHARED_SOURCE_NOT_FORMAL');
    }
    // Replay the saved original against its own identity. Never manufacture a target request or receipt.
    mergeC1AiDraftReceipt({ skuPackage: { c1ProductPlan: source, g1Identity: record.sourceIdentity,
      skuPackageId: source.identity.skuPackageId, supplierSkuId: source.identity.supplierSkuId,
      targetPlatform: source.identity.targetPlatform, targetStore: source.identity.targetStore,
      dataRevision: record.request.sourceSkuRevision + 1 }, request: record.request,
      receipt: record.receipt, settledExecution: record.settledExecution, mergedAt: record.observedAt });
  } else {
    if (record.request !== null || record.receipt !== null || record.settledExecution !== null) fail('C1_SIBLING_SHARED_EDITORIAL_PROVIDER_IMPERSONATION');
    assertC1EditorialPlan({ plan: source, identity: record.sourceIdentity,
      resultSkuRevision: source.draftOnlySeo?.editorialSource?.ownerConfirmation?.resultSkuRevision });
  }
  if (record.sourceIdentity.platform !== record.targetIdentity.platform ||
      !isDeepStrictEqual(record.sourceIdentity.storeRef, record.targetIdentity.storeRef) ||
      !isDeepStrictEqual(record.adoptedFactPaths, adoptedFactPaths(source))) fail('C1_SIBLING_SHARED_SOURCE_SCOPE_MISMATCH');
  const sourceFacts = Object.fromEntries(record.adoptedFactPaths.map(path => [path, factMeaningAt(source, path)]));
  if (fingerprintCanonicalRecord(sourceFacts) !== record.sourceFactFingerprint) fail('C1_SIBLING_SHARED_SOURCE_FACT_CHANGED');
}

export function assertC1SiblingFormalReuse({ plan, resultSkuRevision }) {
  const record = plan?.draftOnlySeo?.siblingFormalReuseRecord;
  if (record?.schemaVersion === C1_SIBLING_NEUTRAL_REUSE_VERSION) {
    return assertC1SiblingNeutralReuse({ plan, resultSkuRevision });
  }
  assertSource(record);
  if (plan.c1PlanId !== record.targetPlanId || resultSkuRevision !== record.resultSkuRevision ||
      !isDeepStrictEqual(plan.identity, record.targetPlanIdentity) ||
      plan.inputRefs.platformSchemaEvidenceId !== record.sourcePlan.inputRefs.platformSchemaEvidenceId ||
      !isDeepStrictEqual(plan.inputSnapshots.platformSchemaRules, record.sourcePlan.inputSnapshots.platformSchemaRules) ||
      !isDeepStrictEqual(plan.platformCategory.categoryName.value, record.sourcePlan.platformCategory.categoryName.value) ||
      !isDeepStrictEqual(plan.platformCategory.descriptionCategoryId.value, record.sourcePlan.platformCategory.descriptionCategoryId.value) ||
      !isDeepStrictEqual(plan.platformCategory.typeId.value, record.sourcePlan.platformCategory.typeId.value) ||
      !isDeepStrictEqual(plan.unknownManifest, collectC1UnknownManifest(plan))) fail('C1_SIBLING_SHARED_TARGET_CONFLICT');
  const targetFacts = Object.fromEntries(record.adoptedFactPaths.map(path => [path, factMeaningAt(plan, path)]));
  if (fingerprintCanonicalRecord(targetFacts) !== record.targetFactFingerprint ||
      record.targetFactFingerprint !== record.sourceFactFingerprint) fail('C1_SIBLING_SHARED_FACT_DIFFERENCE');
  for (const piece of [plan.seoTitleDraft, plan.descriptionDraft, ...plan.bulletPointsDraft, ...plan.searchKeywordsDraft.keywords]) {
    if (!isDeepStrictEqual([...piece.factRefs].sort(), piece.assertions.map(item => item.factPath).sort()) ||
        piece.assertions.some(item => !isDeepStrictEqual(item.value, factMeaningAt(record.sourcePlan, item.factPath)) ||
          !isDeepStrictEqual(item.value, factMeaningAt(plan, item.factPath)))) {
      fail('C1_SIBLING_SHARED_ASSERTION_DIFFERENCE');
    }
  }
  for (const key of CONTENT) if (!isDeepStrictEqual(plan[key], record.sourcePlan[key])) fail('C1_SIBLING_SHARED_CONTENT_CHANGED');
  if (!isDeepStrictEqual(plan.draftOnlySeo, { status: 'draft_only', sourceType: 'sibling_shared_formal_provider',
    formalProviderResultAccepted: false, reason: null, siblingFormalReuseRecord: record })) fail('C1_SIBLING_SHARED_DRAFT_CHANGED');
  return record;
}

export function createC1SiblingFormalReference({ record, identity, resultSkuRevision }) {
  if (record?.schemaVersion !== C1_SIBLING_NEUTRAL_REUSE_VERSION) assertSource(record);
  if (!isDeepStrictEqual(record.targetIdentity, identity) || record.resultSkuRevision !== resultSkuRevision) fail('C1_SIBLING_SHARED_REFERENCE_CONFLICT');
  return { schemaVersion: C1_SIBLING_FORMAL_REFERENCE_VERSION, sourceCandidateId: record.sourceCandidateId,
    targetIdentity: structuredClone(identity), resultSkuRevision, recordFingerprint: fingerprintCanonicalRecord(record) };
}

export function projectC1SiblingFormalDraft({ sourcePlan, sourceIdentity, request, receipt, settledExecution,
  targetSkuPackage, sourceCandidateRevision, targetCandidateRevision, observedAt }) {
  const next = structuredClone(targetSkuPackage), plan = next.c1ProductPlan;
  if (next.businessPhase !== 'C1' || plan.status !== 'facts_checked') fail('C1_SIBLING_SHARED_STAGE_OR_PRODUCT_MISMATCH');
  const paths = adoptedFactPaths(sourcePlan);
  const sourceFacts = Object.fromEntries(paths.map(path => [path, factMeaningAt(sourcePlan, path)]));
  const targetFacts = Object.fromEntries(paths.map(path => [path, factMeaningAt(plan, path)]));
  if (!isDeepStrictEqual(sourceFacts, targetFacts)) fail('C1_SIBLING_SHARED_FACT_DIFFERENCE');
  const record = { schemaVersion: C1_SIBLING_FORMAL_REUSE_VERSION, observedAt,
    sourceKind: sourcePlan.draftOnlySeo?.sourceType === 'owner_confirmed_editorial'
      ? 'owner_confirmed_editorial' : 'provider_receipt',
    sourceCandidateId: sourceIdentity.candidateId, sourceCandidateRevision, targetCandidateRevision,
    sourcePlan: structuredClone(sourcePlan),
    sourceIdentity: structuredClone(sourceIdentity), request: request ? structuredClone(request) : null,
    receipt: receipt ? structuredClone(receipt) : null,
    settledExecution: settledExecution ? structuredClone(settledExecution) : null,
    targetIdentity: structuredClone(next.g1Identity), targetPlanIdentity: structuredClone(plan.identity),
    targetPlanId: plan.c1PlanId, resultSkuRevision: next.dataRevision + 1,
    adoptedFactPaths: paths, sourceFactFingerprint: fingerprintCanonicalRecord(sourceFacts),
    targetFactFingerprint: fingerprintCanonicalRecord(targetFacts) };
  for (const key of CONTENT) plan[key] = structuredClone(sourcePlan[key]);
  plan.status = 'seo_draft_ready';
  plan.draftOnlySeo = { status: 'draft_only', sourceType: 'sibling_shared_formal_provider',
    formalProviderResultAccepted: false, reason: null, siblingFormalReuseRecord: record };
  plan.unknownManifest = collectC1UnknownManifest(plan);
  next.dataRevision += 1;
  next.audit.updatedAt = observedAt;
  next.audit.history.push({ event: 'c1_sibling_formal_draft_reused', at: observedAt,
    sourceCandidateId: sourceIdentity.candidateId, providerCalls: 0, productionStarted: false });
  assertC1SiblingFormalReuse({ plan, resultSkuRevision: next.dataRevision });
  assertValidC1ProductPlan(plan);
  return { skuPackage: next, reuseRecord: record, providerCalls: 0 };
}
