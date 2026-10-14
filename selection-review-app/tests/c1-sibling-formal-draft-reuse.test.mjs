import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormalC1DraftFixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { siblingColorState } from './fixtures/sibling-color-state.mjs';
import { mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { projectC1SiblingFormalDraft, assertC1SiblingFormalReuse } from '../lib/c1-sibling-formal-draft-reuse.mjs';
import { createC2SoftwareContainer, prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { finalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { createC1CompletedEditorialFixture } from './fixtures/c1-completed-editorial-fixture.mjs';
import { createC1EditorialReviewUseCase, buildC1EditorialReviewView } from '../lib/c1-editorial-review-use-case.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';

function fixture() {
  const source = createFormalC1DraftFixture({ candidateId: 'candidate:synthetic-parent',
    variantKey: '颜色:黑cp', skuAttributes: { 颜色: '黑cp' } });
  const merged = mergeC1AiDraftReceipt({ skuPackage: source.checked.skuPackage,
    request: source.request, receipt: source.receipt, settledExecution: source.settledExecution,
    mergedAt: source.at });
  const target = structuredClone(siblingColorState().candidates[0].lifecycleV11.skuPackage);
  target.c1ProductPlan.inputSnapshots.platformSchemaRules = structuredClone(merged.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules);
  return { source, merged, target };
}

test('formal parent receipt projects an independently identified child draft and enters C2 without another provider request', async () => {
  const { source, merged, target } = fixture();
  const result = projectC1SiblingFormalDraft({ sourcePlan: merged.skuPackage.c1ProductPlan,
    sourceIdentity: merged.skuPackage.g1Identity, request: source.request, receipt: source.receipt,
    settledExecution: source.settledExecution, targetSkuPackage: target,
    sourceCandidateRevision: 7, targetCandidateRevision: 8, observedAt: source.at });
  assert.equal(result.providerCalls, 0);
  assert.equal(result.skuPackage.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted, false);
  assert.equal(result.skuPackage.c1ProductPlan.draftOnlySeo.providerJobRef, undefined);
  const c2 = createC2SoftwareContainer({ skuPackage: result.skuPackage,
    expectedDataRevision: result.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: source.at });
  assert.equal(c2.skuPackage.c2FinalAssets.status, 'awaiting_final_uploads');
  const manifest = prepareC2FinalUploadManifest({ skuPackage: c2.skuPackage,
    expectedDataRevision: c2.skuPackage.dataRevision, finalUploadAssets: finalAssets(), preparedAt: source.at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: c2.skuPackage,
    expectedDataRevision: c2.skuPackage.dataRevision, finalManifest: manifest,
    ownerDecision: ownerDecision(manifest), confirmedAt: source.at });
  const card = createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: source.at });
  assert.equal(card.skuPackage.c2FinalAssets.status, 'completed');
  const validator = await loadPublishedSchemaValidator();
  for (const [name, value] of [['c1-product-plan-v1.1', result.skuPackage.c1ProductPlan],
    ['c2-asset-lifecycle-v1.1', c2.skuPackage.c2FinalAssets]]) {
    const validate = validator.getSchema(name);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  assertC1SiblingFormalReuse({ plan: result.skuPackage.c1ProductPlan,
    resultSkuRevision: result.skuPackage.dataRevision });
});

test('owner-confirmed editorial source is revalidated before an equivalent sibling can share its content', async () => {
  const f = await createC1CompletedEditorialFixture();
  const view = buildC1EditorialReviewView({ candidate: f.candidate, sourceJob: f.bundle.sourceJob,
    proposalBundle: f.bundle, observedAt: f.at });
  const service = createC1EditorialReviewUseCase({ repository: f.repository, runtimeMode: 'local_development',
    serverClock: () => f.at, proposalBundle: f.bundle });
  await service.confirm({ actor: f.owner, input: { candidateId: f.candidate.id,
    expectedRevision: f.candidate.dataRevision, editorialVersionId: view.editorialVersionId,
    outputFingerprint: view.outputFingerprint, confirmed: true,
    idempotencyKey: 'sibling-editorial:source', auditEventId: 'sibling-editorial:source-audit' } });
  const source = (await f.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage;
  const target = structuredClone(siblingColorState().candidates[0].lifecycleV11.skuPackage);
  target.c1ProductPlan.inputSnapshots.platformSchemaRules = structuredClone(source.c1ProductPlan.inputSnapshots.platformSchemaRules);
  const adopted = new Set([source.c1ProductPlan.seoTitleDraft, source.c1ProductPlan.descriptionDraft,
    ...source.c1ProductPlan.bulletPointsDraft, ...source.c1ProductPlan.searchKeywordsDraft.keywords]
    .flatMap(piece => piece.factRefs));
  for (const path of adopted) {
    const parts = path.split('.');
    const sourceFact = parts.reduce((value, key) => value?.[key], source.c1ProductPlan);
    let parent = target.c1ProductPlan;
    for (const part of parts.slice(0, -1)) {
      if (parent[part] === undefined) parent[part] = /^\d+$/.test(parts[parts.indexOf(part) + 1]) ? [] : {};
      parent = parent[part];
    }
    parent[parts.at(-1)] = { ...structuredClone(sourceFact), sourceRefs: ['synthetic:child-own-fact'] };
  }
  const result = projectC1SiblingFormalDraft({ sourcePlan: source.c1ProductPlan,
    sourceIdentity: source.g1Identity, request: null, receipt: null, settledExecution: null,
    targetSkuPackage: target, sourceCandidateRevision: 7, targetCandidateRevision: 8, observedAt: f.at });
  assert.equal(result.skuPackage.c1ProductPlan.draftOnlySeo.siblingFormalReuseRecord.sourceKind, 'owner_confirmed_editorial');
  assert.equal(result.skuPackage.c1ProductPlan.draftOnlySeo.providerJobRef, undefined);
  const c2 = createC2SoftwareContainer({ skuPackage: result.skuPackage,
    expectedDataRevision: result.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: f.at });
  assert.equal(c2.skuPackage.c2FinalAssets.status, 'awaiting_final_uploads');
  const manifest = prepareC2FinalUploadManifest({ skuPackage: c2.skuPackage,
    expectedDataRevision: c2.skuPackage.dataRevision, finalUploadAssets: finalAssets(), preparedAt: f.at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: c2.skuPackage,
    expectedDataRevision: c2.skuPackage.dataRevision, finalManifest: manifest,
    ownerDecision: ownerDecision(manifest), confirmedAt: f.at });
  const card = createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: f.at });
  assert.equal(card.skuPackage.c2FinalAssets.status, 'completed');
});

test('a changed adopted fact, receipt, or target content blocks shared reuse', () => {
  for (const change of [
    x => { x.target.c1ProductPlan.platformCategory.categoryName.value = 'Другая категория'; },
    x => { x.source.receipt.output.title.text = 'unsupported'; }
  ]) {
    const x = fixture();
    change(x);
    assert.throws(() => projectC1SiblingFormalDraft({ sourcePlan: x.merged.skuPackage.c1ProductPlan,
      sourceIdentity: x.merged.skuPackage.g1Identity, request: x.source.request, receipt: x.source.receipt,
      settledExecution: x.source.settledExecution, targetSkuPackage: x.target,
      sourceCandidateRevision: 7, targetCandidateRevision: 8, observedAt: x.source.at }));
  }
  const x = fixture();
  const result = projectC1SiblingFormalDraft({ sourcePlan: x.merged.skuPackage.c1ProductPlan,
    sourceIdentity: x.merged.skuPackage.g1Identity, request: x.source.request, receipt: x.source.receipt,
    settledExecution: x.source.settledExecution, targetSkuPackage: x.target,
    sourceCandidateRevision: 7, targetCandidateRevision: 8, observedAt: x.source.at });
  result.skuPackage.c1ProductPlan.seoTitleDraft.text = 'unreviewed target edit';
  assert.throws(() => assertC1SiblingFormalReuse({ plan: result.skuPackage.c1ProductPlan,
    resultSkuRevision: result.skuPackage.dataRevision }), /C1_SIBLING_SHARED_CONTENT_CHANGED/);
});
