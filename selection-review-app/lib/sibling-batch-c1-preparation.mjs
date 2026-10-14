import { c1CopyFields } from './sibling-preparation-consistency.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation, assertSafeBusinessMutationCandidate } from './runtime-identity.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { createC1SkuRightsReviewRecord, resolveC1SkuRightsReviewForFacts } from './c1-sku-rights-review.mjs';
import { verifyC1ProductFacts } from './c1-product-plan.mjs';
import { C1_OZON_ATTRIBUTE_MAPPING_VERSION } from './c1-ozon-attribute-mapping-use-case.mjs';
import { resolveSavedC1ColorDictionaryValue } from './c1-color-dictionary-read-use-case.mjs';
import { assertSiblingSkuColorProjection } from './sibling-sku-card-guard.mjs';
import { readCurrentAppliedC1Draft } from './c1-content-review-use-case.mjs';
import { projectC1SiblingNeutralDraft } from './c1-sibling-neutral-copy.mjs';
import { createC2SoftwareContainer } from './c2-software-orchestrator.mjs';
import { isDeepStrictEqual } from 'node:util';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';

const fail = code => { throw new Error(code); };
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;

function mapColors(candidate, dictionarySource, evidencePacks, ownerId, at, values) {
  const sku = structuredClone(candidate.lifecycleV11.skuPackage);
  const plan = sku.c1ProductPlan;
  const schema = plan.inputSnapshots.platformSchemaRules;
  if (sku.businessPhase !== 'C1' || plan.status !== 'inputs_ready' || !Array.isArray(schema.attributes)) {
    fail('SIBLING_BATCH_C1_MAPPING_INPUT_INVALID');
  }
  if (!text(candidate.sourceCapture?.skuChoices?.[0]?.attributes?.颜色)) fail('SIBLING_BATCH_C1_SUPPLIER_COLOR_REQUIRED');
  if (!values || !(text(values['10096']) || Array.isArray(values['10096']) && values['10096'].length > 0 && values['10096'].every(text))) fail('SIBLING_BATCH_C1_OFFICIAL_COLOR_REQUIRED');
  if (!text(values['10097'])) fail('SIBLING_BATCH_C1_COLOR_NAME_REQUIRED');
  const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt: at });
  if (rights.status !== 'verified') fail('SIBLING_BATCH_C1_RIGHTS_NOT_VERIFIED');
  const inMemory = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights.review, verifiedAt: at }).skuPackage;
  const facts = inMemory.c1ProductPlan.productAttributes.supplierAttributes
    .map((item, index) => ({ item, index })).filter(({ item }) => item.fieldKey === '颜色' &&
      item.fact?.verificationStatus === 'confirmed' && item.fact.value === candidate.sourceCapture?.skuChoices?.[0]?.attributes?.颜色);
  if (facts.length !== 1) fail('SIBLING_BATCH_C1_COLOR_FACT_MISSING');
  const sourceFactPath = `productAttributes.supplierAttributes.${facts[0].index}.fact`;
  const mappings = ['10096', '10097'].map(attributeId => {
    const attributes = schema.attributes.filter(item => String(item.fieldKey) === attributeId);
    if (attributes.length !== 1) fail('SIBLING_BATCH_C1_SCHEMA_COLOR_MISSING');
    const attribute = attributes[0];
    const value = values[attributeId];
    if (attribute.dictionaryId > 0 && (!isDeepStrictEqual(schema, dictionarySource.lifecycleV11?.skuPackage?.c1ProductPlan?.inputSnapshots?.platformSchemaRules) ||
        !sameStoreRef(candidate.storeRef, dictionarySource.storeRef))) fail('SIBLING_BATCH_C1_DICTIONARY_SCOPE_DIFFERENCE');
    if (Array.isArray(value)) {
      if (attributeId !== '10096' || attribute.dictionaryId <= 0 || attribute.isCollection !== true ||
          !Number.isSafeInteger(attribute.maxValueCount) || value.length > attribute.maxValueCount || new Set(value).size !== value.length) fail('SIBLING_BATCH_C1_COLOR_COLLECTION_SCHEMA_REQUIRED');
      const resolvedValues = value.map(item => resolveSavedC1ColorDictionaryValue({ candidate: dictionarySource, evidencePacks, attributeId, value: item, observedAt: at }));
      return { attributeId, attributeLabel: attribute.label ?? null, dictionaryId: attribute.dictionaryId, value, dictionaryValueId: null,
        dictionaryValues: resolvedValues.map((item,i) => ({ value: value[i], dictionaryValueId: item.dictionaryValueId })),
        dictionaryEvidenceRef: resolvedValues[0].sourceRef, dictionaryEvidenceRefs: resolvedValues.map(item => item.sourceRef), sourceFactPath, sourceFactValue: facts[0].item.fact.value };
    }
    const resolved = attribute.dictionaryId > 0
      ? resolveSavedC1ColorDictionaryValue({ candidate: dictionarySource, evidencePacks, attributeId, value, observedAt: at })
      : { dictionaryValueId: null, sourceRef: `${schema.evidenceId}#/attributes/${attributeId}` };
    return { attributeId, attributeLabel: attribute.label ?? null, dictionaryId: attribute.dictionaryId,
      value, dictionaryValueId: resolved.dictionaryValueId, sourceFactPath,
      sourceFactValue: facts[0].item.fact.value, dictionaryEvidenceRef: resolved.sourceRef };
  });
  sku.ozonAttributeMappingsV1 = { schemaVersion: C1_OZON_ATTRIBUTE_MAPPING_VERSION,
    schemaRevision: schema.schemaRevision, confirmationRef: `owner-ozon-attribute-mapping:${candidate.id}:${candidate.dataRevision}`,
    confirmedBy: ownerId, confirmedAt: at, mappings };
  const verified = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights.review, verifiedAt: at }).skuPackage;
  assertSiblingSkuColorProjection({ ...candidate, lifecycleV11: { ...candidate.lifecycleV11, skuPackage: verified } });
  return verified;
}

function validateInput(actor, input, serverClock, requireConfirmation) {
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' ||
      typeof serverClock !== 'function' || !input || !text(input.parentCandidateId) ||
      !Number.isSafeInteger(input.parentRevision) || (requireConfirmation && input.confirmed !== true) ||
      !text(input.dictionarySourceCandidateId) ||
      !input.rightsDeclaration || !Array.isArray(input.members) || input.members.length === 0 ||
      input.members.length > 100 || new Set(input.members.map(item => item.candidateId)).size !== input.members.length) {
    fail('SIBLING_BATCH_C1_INPUT_INVALID');
  }
}

function assertBatchScope(document, input) {
    const parents = document.candidates.filter(item => item.id === input.parentCandidateId);
    if (parents.length !== 1 || parents[0].dataRevision !== input.parentRevision) fail('SIBLING_BATCH_C1_PARENT_CHANGED');
    const parent = parents[0];
    const selected = parent.sourceCapture?.selectedSkuIds?.filter(id => id !== parent.lifecycleV11?.skuPackage?.supplierSkuId);
    const memberSkuIds = input.members.map(member =>
      document.candidates.find(item => item.id === member.candidateId)?.siblingSourceV1?.supplierSkuId);
    if (!Array.isArray(selected) || selected.length !== input.members.length ||
        new Set(selected).size !== selected.length || new Set(memberSkuIds).size !== memberSkuIds.length ||
        !memberSkuIds.every(id => selected.includes(id))) {
      fail('SIBLING_BATCH_C1_SCOPE_MISMATCH');
    }
    for (const member of input.members) {
      const child = document.candidates.find(item => item.id === member.candidateId);
      if (child?.siblingSourceV1?.parentCandidateId !== parent.id ||
          child.sourceCapture?.captureId !== parent.sourceCapture?.captureId ||
          child.sourceCapture?.offerId !== parent.sourceCapture?.offerId ||
          child.lifecycleV11?.skuPackage?.supplierSkuId !== child.siblingSourceV1.supplierSkuId ||
          !sameStoreRef(child.storeRef, parent.storeRef)) fail('SIBLING_BATCH_C1_MEMBER_CONFLICT');
    }
    return { parent, selected };
}

function prepareBatch(document, actor, input, serverClock) {
    const { parent, selected } = assertBatchScope(document, input);
    const sourcePlan = parent.lifecycleV11?.skuPackage?.c1ProductPlan;
    const source = sourcePlan?.draftOnlySeo?.sourceType === 'owner_confirmed_editorial'
      ? { request: null, receipt: null, settledExecution: null }
      : readCurrentAppliedC1Draft(parent, document.runtime?.softwareJobs ?? []);
    const at = serverClock();
    const dictionarySources = document.candidates.filter(item => item.id === input.dictionarySourceCandidateId);
    if (dictionarySources.length !== 1 || !input.members.some(member => member.candidateId === input.dictionarySourceCandidateId) ||
        dictionarySources[0].lifecycleV11?.skuPackage?.c1ProductPlan?.status !== 'inputs_ready') {
      fail('SIBLING_BATCH_C1_DICTIONARY_SOURCE_INVALID');
    }
    const dictionarySource = dictionarySources[0];
    const prepared = input.members.map(member => {
      const matches = document.candidates.filter(item => item.id === member.candidateId);
      if (matches.length !== 1) fail('SIBLING_BATCH_C1_MEMBER_CONFLICT');
      const child = matches[0];
      const sku = child.lifecycleV11?.skuPackage;
      if (child.dataRevision !== member.candidateRevision ||
          child.siblingSourceV1?.parentCandidateId !== parent.id ||
          !selected.includes(child.siblingSourceV1.supplierSkuId) ||
          child.sourceCapture?.captureId !== parent.sourceCapture?.captureId ||
          child.sourceCapture?.offerId !== parent.sourceCapture?.offerId ||
          sku?.supplierSkuId !== child.siblingSourceV1.supplierSkuId ||
          sku.c1ProductPlan?.status !== 'inputs_ready' ||
          sku.c1RightsReviewRecord || !sameStoreRef(child.storeRef, parent.storeRef)) {
        fail('SIBLING_BATCH_C1_MEMBER_CONFLICT');
      }
      const current = structuredClone(child);
      current.lifecycleV11.skuPackage.c1RightsReviewRecord = createC1SkuRightsReviewRecord({
        plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity, sourceCandidateRevision: child.dataRevision,
        declaredByUserId: actor.userId, declaredAt: at,
        ownerDeclaration: { ...(member.rightsDeclaration ?? input.rightsDeclaration), reviewedAt: at } });
      const facts = mapColors(current, dictionarySource, document.evidencePacks ?? [], actor.userId, at, member.colorMappings);
      const drafted = projectC1SiblingNeutralDraft({ sourcePlan, sourceIdentity: parent.lifecycleV11.skuPackage.g1Identity,
        request: source.request, receipt: source.receipt, settledExecution: source.settledExecution,
        targetSkuPackage: facts, sourceCandidateRevision: parent.dataRevision,
        targetCandidateRevision: child.dataRevision, observedAt: at });
      const c2 = createC2SoftwareContainer({ skuPackage: drafted.skuPackage, expectedDataRevision: drafted.skuPackage.dataRevision,
        assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: at }).skuPackage;
      return { child, skuPackage: c2, content: drafted.content, copyReviewRequired: member.copyDraft != null && !isDeepStrictEqual(member.copyDraft,c1CopyFields(drafted.content)), differences: drafted.differences,
        reuseRecord: drafted.reuseRecord };
    });
    const binding = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
      dictionarySourceCandidateId: dictionarySource.id, confirmedBy: actor.userId,
      rightsDeclaration: input.rightsDeclaration,
      members: input.members.map(member => ({ candidateId: member.candidateId,
        candidateRevision: member.candidateRevision, colorMappings: member.colorMappings,
        rightsDeclaration: member.rightsDeclaration ?? null, copyDraft: member.copyDraft ?? null })),
      projected: prepared.map(({ child, content, reuseRecord }) => ({ candidateId: child.id,
        contentFingerprint: reuseRecord.contentFingerprint, targetCandidateRevision: child.dataRevision,
        sourcePlanFingerprint: reuseRecord.sourcePlanFingerprint })) };
    return { parent, prepared, at, previewFingerprint: fingerprintCanonicalRecord(binding) };
}

/** Pure preparation used by both the read-only preview and the write transaction. */
export function previewSiblingBatchC1Preparation({ document, actor, input, serverClock }) {
  validateInput(actor, input, serverClock, false);
  const { parent, prepared, previewFingerprint } = prepareBatch(document, actor, input, serverClock);
  return { parentCandidateId: parent.id, parentRevision: parent.dataRevision, previewFingerprint,
    members: prepared.map(({ child, content, differences, reuseRecord, copyReviewRequired }) => ({ candidateId: child.id,
      candidateRevision: child.dataRevision, sourceSkuId: child.siblingSourceV1.supplierSkuId,
      color: child.sourceCapture.skuChoices[0].attributes.颜色, copyReviewRequired,
      content: { seoTitleDraft: content.seoTitleDraft, descriptionDraft: content.descriptionDraft,
        bulletPointsDraft: content.bulletPointsDraft, searchKeywordsDraft: content.searchKeywordsDraft,
        russianAttributes: content.seoEvidenceLayer.russianAttributes ?? [] }, differences,
      sourceCandidateId: reuseRecord.sourceCandidateId, sourceCandidateRevision: reuseRecord.sourceCandidateRevision,
      adoptedFactPaths: reuseRecord.adoptedFactPaths })), externalRequests: 0, paidCalls: 0, platformWrites: 0 };
}

/** One owner declaration, one preview binding, and saved official color evidence. */
export async function commitSiblingBatchC1Preparation({ repository, runtimeMode, actor, input, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (runtimeMode === 'central_test' || runtimeMode === 'central_production') assertCentralPersistenceBoundary(repository);
  validateInput(actor, input, serverClock, true);
  if (!/^[a-f0-9]{64}$/.test(input.previewFingerprint ?? '')) fail('SIBLING_BATCH_C1_PREVIEW_REQUIRED');
  return repository.transact(document => {
    const { parent: currentParent } = assertBatchScope(document, input);
    const inputFingerprint = fingerprintCanonicalRecord({ input, confirmedBy: actor.userId });
    const replay = input.members.map(member => document.candidates.find(item => item.id === member.candidateId));
    if (replay.every(child => child?.lifecycleV11?.siblingBatchC1ReceiptV1?.inputFingerprint === inputFingerprint &&
        child.lifecycleV11.siblingBatchC1ReceiptV1.resultRevision === child.dataRevision &&
        child.lifecycleV11.siblingBatchC1ReceiptV1.parentCandidateId === input.parentCandidateId)) {
      const sourcePlanFingerprint = fingerprintCanonicalRecord(currentParent.lifecycleV11?.skuPackage?.c1ProductPlan);
      if (replay.some(child => child.lifecycleV11.skuPackage.c1ProductPlan.draftOnlySeo
          ?.siblingFormalReuseRecord?.sourcePlanFingerprint !== sourcePlanFingerprint)) {
        fail('SIBLING_BATCH_C1_PARENT_CHANGED');
      }
      return { changed: false, document, result: { status: 'idempotent_replay', members: replay.map(child => ({
        candidateId: child.id, resultRevision: child.dataRevision })), externalRequests: 0, paidCalls: 0, platformWrites: 0 } };
    }
    if (replay.some(child => child?.lifecycleV11?.siblingBatchC1ReceiptV1)) fail('SIBLING_BATCH_C1_REPLAY_CONFLICT');
    const { parent, prepared, at, previewFingerprint } = prepareBatch(document, actor, input, serverClock);
    if (prepared.some(item=>item.copyReviewRequired)) fail('SIBLING_BATCH_C1_COPY_REVIEW_REQUIRED');
    if (previewFingerprint !== input.previewFingerprint) fail('SIBLING_BATCH_C1_PREVIEW_CHANGED');
    for (const { child, skuPackage } of prepared) {
      child.lifecycleV11 = { ...child.lifecycleV11, skuPackage: structuredClone(skuPackage),
        siblingBatchC1ReceiptV1: { schemaVersion: 'sibling-batch-c1-receipt-v1',
          parentCandidateId: parent.id, sourceRevision: child.dataRevision,
          resultRevision: child.dataRevision + 1, inputFingerprint, confirmedBy: actor.userId,
          confirmedAt: at }, status: 'awaiting_final_assets', platformWrites: 0 };
      child.listingPreparation = { ...(child.listingPreparation ?? {}), status: 'awaiting_final_assets',
        reason: 'C1 独立颜色事实已核验，共用 SEO 已逐事实对照，C2 等待本色最终素材。',
        decisionItems: [], writeOccurred: false, platformWrites: 0 };
      child.dataRevision += 1;
      child.updatedAt = at;
      child.lastModifiedBy = actor.userId;
      assertSafeBusinessMutationCandidate(child);
    }
    return { changed: true, document, result: { status: 'c2_waiting_final_uploads',
      members: prepared.map(({ child }) => ({ candidateId: child.id, resultRevision: child.dataRevision })),
      externalRequests: 0, paidCalls: 0, platformWrites: 0 } };
  });
}
