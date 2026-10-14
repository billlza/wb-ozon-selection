import test from 'node:test';
import assert from 'node:assert/strict';
import { createC1EditorialReviewFixture } from './fixtures/c1-editorial-review-fixture.mjs';
import { createC1EditorialReviewUseCase, buildC1EditorialReviewView, C1EditorialReviewError } from '../lib/c1-editorial-review-use-case.mjs';
import { buildC1ContentReviewView, createC1ContentReviewUseCase } from '../lib/c1-content-review-use-case.mjs';
import { assertC1EditorialPlan } from '../lib/c1-editorial-review-contract.mjs';

async function fixture() {
  const f = await createC1EditorialReviewFixture();
  f.useCase = createC1EditorialReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => f.at, proposalBundle: f.bundle });
  f.view = buildC1EditorialReviewView({ candidate: f.candidate, sourceJob: f.document.runtime.softwareJobs[0], proposalBundle: f.bundle, observedAt: f.at });
  assert.equal(f.view.status, 'awaiting_confirmation');
  f.input = { candidateId: f.candidate.id, expectedRevision: f.candidate.dataRevision, editorialVersionId: f.view.editorialVersionId,
    outputFingerprint: f.view.outputFingerprint, confirmed: true, idempotencyKey: 'editorial:confirm:1', auditEventId: 'editorial:audit:1' };
  return f;
}

test('proposal view is read-only and remains separate from formal receipt review before confirmation', async () => {
  const f = await fixture();
  assert.equal(f.view.canConfirm, true);
  assert.deepEqual(f.view.changes.map(change => change.path), ['output.title', 'output.description',
    ...['bulletPoints', 'searchKeywords'].flatMap(field => f.bundle.receipt.output[field].map((_, index) => `output.${field}[${index}]`))]);
  assert.equal(f.view.semanticValidation.automatedSemanticProof, false);
  assert.equal(f.candidate.lifecycleV11.skuPackage.businessPhase, 'C1');
  assert.equal(f.candidate.lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.equal(buildC1ContentReviewView(f.candidate).canConfirm, false);
  assert.deepEqual(await f.repository.readSnapshot(), f.document);
  assert.deepEqual(buildC1EditorialReviewView({ candidate: f.candidate, proposalBundle: null, observedAt: f.at }), { status: 'not_applicable', canConfirm: false });
});

test('authenticated owner confirms once atomically, enters C2 and preserves original failed job/receipt/authorization', async () => {
  const f = await fixture();
  const outcomes = await Promise.all([f.useCase.confirm({ actor: f.owner, input: f.input }), f.useCase.confirm({ actor: f.owner, input: f.input })]);
  assert.equal(outcomes.filter(result => result.status === 'idempotent_replay').length, 1);
  const doc = await f.repository.readSnapshot(), candidate = doc.candidates[0], sku = candidate.lifecycleV11.skuPackage;
  assert.equal(candidate.dataRevision, f.candidate.dataRevision + 1); assert.equal(sku.businessPhase, 'C2');
  assert.equal(sku.ownerAction, 'provide_final_assets'); assert.deepEqual(sku.c2FinalAssets.assets.finalUploads, []);
  assert.equal(sku.productionAuthorization, null);
  assert.equal(sku.c1ProductPlan.draftOnlySeo.sourceType, 'owner_confirmed_editorial');
  assert.equal(sku.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted, false);
  assert.equal(Object.hasOwn(sku.c1ProductPlan.draftOnlySeo, 'providerJobRef'), false);
  assert.equal(candidate.lifecycleV11.c1EditorialContentReviewV1.status, 'confirmed');
  assert.equal(candidate.lifecycleV11.c1EditorialContentReviewV1.confirmedByUserId, f.owner.userId);
  assert.deepEqual(doc.runtime.softwareJobs, f.document.runtime.softwareJobs);
  assert.deepEqual(doc.runtime.softwareJobAuthorizationRecords, f.document.runtime.softwareJobAuthorizationRecords);
  assert.equal(doc.runtime.softwareJobs[0].status, 'failed'); assert.equal(doc.runtime.softwareJobs[0].attempt, 1);
  assert.equal(doc.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.deepEqual(candidate.lifecycleV11.c1AiDraftRequestV1, f.candidate.lifecycleV11.c1AiDraftRequestV1);
  assert.deepEqual(sku.profitModels, f.candidate.lifecycleV11.skuPackage.profitModels);
  assert.deepEqual(sku.selectedSupplySnapshot, f.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot);
  const source = sku.c1ProductPlan.draftOnlySeo.editorialSource;
  assert.doesNotThrow(() => assertC1EditorialPlan({ plan: sku.c1ProductPlan, identity: sku.g1Identity, resultSkuRevision: source.ownerConfirmation.resultSkuRevision }));
  const view = buildC1EditorialReviewView({ candidate, sourceJob: doc.runtime.softwareJobs[0], proposalBundle: null, observedAt: f.at });
  assert.equal(view.status, 'confirmed'); assert.equal(view.canConfirm, false);
  assert.equal(buildC1ContentReviewView(candidate).reason, 'C1_CONTENT_REVIEW_EDITORIAL_SOURCE');
  assert.equal(doc.runtime.operationAudit.filter(event => event.action === 'c1_confirm_editorial_content').length, 1);
});

test('wrong identity, false confirmation, stale revision/version/output and text injection cause no write', async () => {
  const f = await fixture(), before = await f.repository.readSnapshot();
  for (const input of [{ ...f.input, confirmed: false }, { ...f.input, expectedRevision: f.input.expectedRevision - 1 },
    { ...f.input, editorialVersionId: 'editorial:other' }, { ...f.input, outputFingerprint: '0'.repeat(64) },
    { ...f.input, candidateId: 'candidate:other' }, { ...f.input, correctedText: 'injection' }]) {
    await assert.rejects(f.useCase.confirm({ actor: f.owner, input }));
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
  for (const actor of [{ ...f.owner, roles: ['viewer'] }, { ...f.owner, actorType: 'worker' }, { ...f.owner, source: 'local_worker' }]) {
    await assert.rejects(f.useCase.confirm({ actor, input: f.input })); assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('current job, request, source facts and SKU revision drift block view and confirmation', async () => {
  const mutations = [doc => { doc.runtime.softwareJobs[0].resultEnvelope.payloadFingerprint = '0'.repeat(64); },
    doc => { doc.candidates[0].lifecycleV11.c1AiDraftJobRefV1.jobId = 'job:other'; },
    doc => { doc.candidates[0].lifecycleV11.c1AiDraftRequestV1.requestFingerprint = '0'.repeat(64); },
    doc => { doc.candidates[0].lifecycleV11.skuPackage.dataRevision += 1; },
    doc => { doc.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.productAttributes.material.value = 'changed'; },
    doc => { doc.candidates[0].lifecycleV11.c1LocalDraftSourceV1.materialFingerprint = '0'.repeat(64); }];
  for (const mutate of mutations) {
    const f = await fixture();
    await f.repository.transact(document => { mutate(document); return { changed: true, document, result: null }; });
    const before = await f.repository.readSnapshot();
    const view = buildC1EditorialReviewView({ candidate: before.candidates[0], sourceJob: before.runtime.softwareJobs[0], proposalBundle: f.bundle, observedAt: f.at });
    assert.equal(view.status, 'blocked'); assert.equal(view.canConfirm, false);
    await assert.rejects(f.useCase.confirm({ actor: f.owner, input: f.input }), error => error instanceof C1EditorialReviewError);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('proposal deployment replacement, changed original locks and invalid plans never become confirmation input', async () => {
  const f = await fixture(), before = await f.repository.readSnapshot();
  const stale = structuredClone(f.bundle); stale.correctionPlan.items[0].originalText = 'stale';
  assert.throws(() => createC1EditorialReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => f.at, proposalBundle: stale }), error => error instanceof C1EditorialReviewError);
  const changed = structuredClone(f.bundle); changed.correctionPlan.items[0].explanation += ' additional maintenance review';
  const other = createC1EditorialReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => f.at, proposalBundle: changed });
  await assert.rejects(other.confirm({ actor: f.owner, input: f.input }), error => error.code === 'C1_EDITORIAL_REVIEW_CONTENT_CONFLICT');
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test('idempotency is bound to confirming owner and old formal confirmation cannot adopt editorial content', async () => {
  const f = await fixture(); await f.useCase.confirm({ actor: f.owner, input: f.input });
  const before = await f.repository.readSnapshot();
  await assert.rejects(f.useCase.confirm({ actor: { ...f.owner, userId: 'owner:other' }, input: f.input }), /BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT/);
  const old = createC1ContentReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => f.at });
  await assert.rejects(old.confirm({ actor: f.owner, input: { candidateId: f.candidate.id, expectedRevision: before.candidates[0].dataRevision,
    contentFingerprint: before.candidates[0].lifecycleV11.c1EditorialContentReviewV1.contentFingerprint, confirmed: true,
    idempotencyKey: 'old:confirm', auditEventId: 'old:audit' } }));
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test('saved confirmation is revalidated without deployment proposal and damaged records stay blocked', async () => {
  const f = await fixture(); await f.useCase.confirm({ actor: f.owner, input: f.input });
  const candidate = (await f.repository.readSnapshot()).candidates[0];
  const mutations = [value => { delete value.lifecycleV11.skuPackage; },
    value => { value.lifecycleV11.c1EditorialContentReviewV1.outputFingerprint = '0'.repeat(64); },
    value => { value.lifecycleV11.c1EditorialContentReviewV1.sourceSoftwareJobId = 'job:other'; },
    value => { value.lifecycleV11.skuPackage.c1ProductPlan.draftOnlySeo.editorialSource.ownerConfirmation.confirmedByUserId = 'owner:other'; },
    value => { value.lifecycleV11.skuPackage.c1ProductPlan.draftOnlySeo.editorialSource.bundle.correctionPlan.items[0].originalText = 'changed'; }];
  for (const mutate of mutations) {
    const changed = structuredClone(candidate); mutate(changed);
    const view = buildC1EditorialReviewView({ candidate: changed, proposalBundle: null, observedAt: f.at });
    assert.equal(view.status, 'blocked'); assert.equal(view.canConfirm, false);
  }
  assert.deepEqual((await f.repository.readSnapshot()).candidates[0], candidate);
});


test('new editorial version completes a new card using the original asset signature', async () => {
  const { finalAssets, ownerDecision } = await import('./helpers/c2-software-fixture.mjs');
  const { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } = await import('../lib/c2-software-orchestrator.mjs');
  const { createFinalProductPlanConfirmationCard } = await import('../lib/final-product-plan-confirmation-card.mjs');
  const { prepareC1FinalPlanRevision } = await import('../lib/c1-final-plan-revision-preparation.mjs');
  const first = await fixture();
  await first.useCase.confirm({ actor: first.owner, input: first.input });
  const original = (await first.repository.readSnapshot()).candidates[0], sku = original.lifecycleV11.skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
    finalUploadAssets: finalAssets(), preparedAt: first.at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
    finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: first.at });
  original.lifecycleV11.skuPackage = structuredClone(createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: first.at }).skuPackage);
  original.targetPlatform = 'ozon'; delete original.sourceCapture;
  const revised = prepareC1FinalPlanRevision({ candidate: original, expectedRevision: original.dataRevision, preparedAt: first.at });
  const f = await createC1EditorialReviewFixture({ at: first.at, sourceCandidate: revised.candidate, historyRecord: revised.historyRecord });
  const useCase = createC1EditorialReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => f.at, proposalBundle: f.bundle });
  const view = buildC1EditorialReviewView({ candidate: f.candidate, sourceJob: f.document.runtime.softwareJobs[0], proposalBundle: f.bundle, observedAt: f.at });
  assert.equal(view.canConfirm, true);
  const input = { candidateId: f.candidate.id, expectedRevision: f.candidate.dataRevision, editorialVersionId: view.editorialVersionId,
    outputFingerprint: view.outputFingerprint, confirmed: true, idempotencyKey: 'editorial:new-confirm', auditEventId: 'editorial:new-audit' };
  const outcome = await useCase.confirm({ actor: f.owner, input });
  assert.equal(outcome.result.finalCardCreated, true);
  const saved = (await f.repository.readSnapshot()).candidates[0];
  assert.equal(saved.dataRevision, f.candidate.dataRevision + 1);
  assert.equal(saved.lifecycleV11.skuPackage.c2FinalAssets.status, 'completed');
  assert.ok(saved.lifecycleV11.skuPackage.productionConfirmationCard);
  assert.deepEqual(saved.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation, original.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation);
  assert.equal(buildC1EditorialReviewView({ candidate: saved, observedAt: f.at }).status, 'confirmed');
  assert.equal(saved.lifecycleV11.skuPackage.productionAuthorization, null);
  assert.deepEqual((await f.repository.readSnapshot()).c1FinalPlanRevisionHistoryRecords, f.document.c1FinalPlanRevisionHistoryRecords);
});
