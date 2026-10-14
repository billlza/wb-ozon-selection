import test from 'node:test';
import assert from 'node:assert/strict';
import { finalPricingC1ReuseFixture } from './fixtures/final-pricing-c1-reuse-fixture.mjs';
import { finalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { prepareC1FinalPlanRevision, completeC1FinalPlanRevision } from '../lib/c1-final-plan-revision-preparation.mjs';
import { assertValidC1ProductPlan } from '../lib/c1-product-plan.mjs';
const at = '2026-08-22T02:04:00.000Z';
function fixture() {
  const candidate = finalPricingC1ReuseFixture().document.candidates[0];
  candidate.targetPlatform = 'ozon';
  const sku = candidate.lifecycleV11.skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: sku, expectedDataRevision: sku.dataRevision, finalUploadAssets: finalAssets(), preparedAt: at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: sku, expectedDataRevision: sku.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: at });
  candidate.lifecycleV11.skuPackage = structuredClone(createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: at }).skuPackage);
  candidate.cargoFactsV1 = { schemaVersion: 'candidate-cargo-facts-v1', declaredBy: 'owner', declaredRevision: candidate.dataRevision, declaredAt: at,
    facts: { batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true, irregularShape: false,
      sourceRef: `owner-cargo-facts:${candidate.id}:${candidate.dataRevision}:${at}` } };
  candidate.lifecycleV11.c1AiDraftRequestV1 = { historicalRequest: true };
  candidate.lifecycleV11.c1AiDraftJobRefV1 = { historicalJob: true };
  candidate.lifecycleV11.c1ContentReviewV1 = { historicalContentReview: true };
  candidate.lifecycleV11.c2UploadDraft = { registration: 'preserved' };
  return candidate;
}
function prepare(candidate = fixture()) { return prepareC1FinalPlanRevision({ candidate, expectedRevision: candidate.dataRevision, preparedAt: at }); }

test('new C1 prepares confirmed facts with immutable old card, profit, rights and assets', () => {
  const source = fixture(), original = structuredClone(source), result = prepare(source), life = result.candidate.lifecycleV11;
  const old = source.lifecycleV11.skuPackage, next = life.skuPackage;
  assert.deepEqual(source, original);
  assert.equal(result.candidate.dataRevision, source.dataRevision + 1);
  assert.equal(next.dataRevision, old.dataRevision + 2);
  assert.equal(next.c1ProductPlan.status, 'facts_checked');
  assert.notEqual(next.c1ProductPlan.c1PlanId, old.c1ProductPlan.c1PlanId);
  assert.deepEqual(next.c1ProductPlan.revisionRefs, old.c1ProductPlan.revisionRefs);
  assert.deepEqual(next.c1ProductPlan.inputSnapshots, old.c1ProductPlan.inputSnapshots);
  assert.deepEqual(next.profitModels, old.profitModels);
  assert.deepEqual(next.selectedSupplySnapshot, old.selectedSupplySnapshot);
  assert.equal(next.c1ProductPlan.batteryAssessment.batteryType.value, 'none');
  assert.equal(next.c1ProductPlan.batteryAssessment.containsBattery.value, false);
  assert.equal(next.c1ProductPlan.batteryAssessment.powered.value, false);
  assert.match(next.c1ProductPlan.batteryAssessment.containsBattery.sourceRefs[0], /:facts#\/records\/0$/);
  assert.equal(next.c1ProductPlan.draftOnlySeo, null);
  assert.equal(next.c2FinalAssets, null);
  assert.equal(next.productionConfirmationCard, null);
  assert.deepEqual(result.historyRecord.previousSkuPackage, old);
  assert.deepEqual(life.c2UploadDraft, original.lifecycleV11.c2UploadDraft);
  assert.deepEqual(result.historyRecord.previousC1References.c1AiDraftRequestV1, original.lifecycleV11.c1AiDraftRequestV1);
  assert.equal(Object.hasOwn(life, 'c1AiDraftRequestV1'), false);
  assert.equal(Object.hasOwn(life, 'c1AiDraftJobRefV1'), false);
  assert.equal(Object.hasOwn(life, 'c1ContentReviewV1'), false);
  assert.deepEqual(result.historyRecord.previousC1References.c1ContentReviewV1, original.lifecycleV11.c1ContentReviewV1);
  assert.equal(result.finalCardCreated, false); assert.equal(result.productionAuthorized, false);
});

test('revision facts and projected battery cannot be replaced after preparation', () => {
  const result = prepare();
  for (const mutate of [p => p.sourceFactsRevision.records[0].value = 'battery_present',
    p => p.sourceFactsRevision.sourceSkuRevision += 1,
    p => p.sourceFactsRevision.sourceIdentity.storeRef.stableStoreId = 'foreign',
    p => p.batteryAssessment.containsBattery.value = true,
    p => p.batteryAssessment.batteryType.sourceRefs = ['unrelated:source']]) {
    const plan = structuredClone(result.candidate.lifecycleV11.skuPackage.c1ProductPlan); mutate(plan);
    assert.throws(() => assertValidC1ProductPlan(plan), /C1_SUPPLIER_FACT_REVISION/);
  }
});

test('stale revision, invalid time, changed old card and downstream authorization stop preparation', () => {
  const c = fixture();
  assert.throws(() => prepareC1FinalPlanRevision({ candidate: c, expectedRevision: c.dataRevision - 1, preparedAt: at }), /INPUT_INVALID/);
  assert.throws(() => prepareC1FinalPlanRevision({ candidate: c, expectedRevision: c.dataRevision, preparedAt: '2026-02-30T00:00:00.000Z' }), /INPUT_INVALID/);
  const changed = structuredClone(c); changed.lifecycleV11.skuPackage.productionConfirmationCard.cardId = 'changed:card';
  assert.throws(() => prepare(changed));
  const authorized = structuredClone(c); authorized.lifecycleV11.skuPackage.productionRecord = { recordId: 'not-allowed' };
  assert.throws(() => prepare(authorized));
});

test('final plan revision preserves an unsettled dictionary read instead of clearing it', () => {
  for (const status of ['request_sent', 'unknown_outcome']) {
    const candidate = fixture();
    candidate.lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': {
      schemaVersion: 'c1-color-dictionary-read-v1', status,
      authorizationId: `synthetic:${status}`, externalRequestRef: `synthetic:${status}:request`
    } };
    const before = structuredClone(candidate);
    assert.throws(() => prepare(candidate), /C1_COLOR_DICTIONARY_READ_UNSETTLED/);
    assert.deepEqual(candidate, before);
  }
});

test('new formal request and receipt reach a final card carrying the new facts snapshot', async () => {
  const { c1DraftPreparedCandidate } = await import('./fixtures/c1-draft-source-fixture.mjs');
  const { prepareCurrentC1AiDraftRequest } = await import('../lib/c1-ai-draft-request-source.mjs');
  const { c1AiSoftwareJobFixture, c1AiSoftwareJobResultEnvelope } = await import('./fixtures/c1-ai-software-job-fixture.mjs');
  const { bindSoftwareJobAdmissionForEnqueue } = await import('../lib/software-job-admission.mjs');
  const { claimSoftwareJobLease, markSoftwareJobExternalRequestStarted, settleSoftwareJob, readCompletedC1AiSoftwareJobResult } = await import('../lib/software-job-contract.mjs');
  const { mergeC1AiDraftReceipt } = await import('../lib/c1-ai-draft-contract.mjs');
  const source = fixture(), prepared = prepare(source);
  const candidate = c1DraftPreparedCandidate({ candidate: prepared.candidate, at });
  const request = prepareCurrentC1AiDraftRequest(candidate, at);
  const jobId = 'software-job:c1-revised:synthetic', authorizationId = 'authorization:c1-ai-draft:revised-synthetic';
  candidate.lifecycleV11.c1AiDraftRequestV1 = structuredClone(request);
  const f = c1AiSoftwareJobFixture({ formalDraftFixture: { candidate, request, at }, jobId, authorizationId });
  let job = bindSoftwareJobAdmissionForEnqueue({ document: f.document, job: f.job, observedAt: at, phase: 'enqueue_current' });
  job = claimSoftwareJobLease({ job, worker: f.worker, leaseId: 'lease:revised:synthetic', serverTime: at, leaseDurationMs: 300000 });
  job = markSoftwareJobExternalRequestStarted({ job, workerId: f.worker.workerId, leaseId: job.leaseId, externalRequestRef: 'request:revised:synthetic', serverTime: at });
  const doneAt = '2026-08-22T02:05:00.000Z';
  job = settleSoftwareJob({ job, workerId: f.worker.workerId, leaseId: job.leaseId, status: 'completed', externalRequestState: 'succeeded', serverTime: doneAt,
    resultEnvelope: c1AiSoftwareJobResultEnvelope(job, request, { startedAt: at, completedAt: doneAt }) });
  const merged = mergeC1AiDraftReceipt({ skuPackage: candidate.lifecycleV11.skuPackage, ...readCompletedC1AiSoftwareJobResult(job), mergedAt: doneAt });
  const ready = structuredClone(candidate);
  ready.lifecycleV11.skuPackage = structuredClone(merged.skuPackage);
  const { fingerprintC2SourceC1 } = await import('../lib/c2-asset-lifecycle.mjs');
  ready.lifecycleV11.c1ContentReviewV1 = { schemaVersion: 'c1-content-review-v1', status: 'confirmed', candidateId: ready.id,
    skuPackageId: merged.skuPackage.skuPackageId, contentFingerprint: fingerprintC2SourceC1(merged.skuPackage),
    receiptRef: merged.skuPackage.c1ProductPlan.seoEvidenceLayer.aiReceiptId, sourceRevision: ready.dataRevision,
    resultRevision: ready.dataRevision + 1, confirmedByUserId: 'synthetic-owner', confirmedAt: doneAt, productionAuthorizationGranted: false };
  const beforeCompletion = structuredClone(ready);
  const completion = completeC1FinalPlanRevision({ candidate: ready, historyRecord: prepared.historyRecord, expectedRevision: ready.dataRevision, completedAt: doneAt });
  const final = completion.candidate.lifecycleV11.skuPackage;
  assert.deepEqual(ready, beforeCompletion);
  assert.deepEqual(final.c2FinalAssets.ownerFinalUploadConfirmation, source.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation);
  assert.deepEqual(final.c2FinalAssets.assets.finalUploads, source.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads);
  assert.equal(final.c2FinalAssets.ownerFinalUploadConfirmation.confirmedAt, at);
  assert.equal(final.c2FinalAssets.updatedAt, doneAt);
  assert.equal(completion.completion.newOwnerSignature, false);
  assert.match(completion.completion.sourceConfirmationRef, /previousSkuPackage\/c2FinalAssets\/ownerFinalUploadConfirmation$/);
  for (const mutate of [c => delete c.lifecycleV11.c1ContentReviewV1,
    c => c.lifecycleV11.c1FinalPlanRevisionPreparation.sourceFinalManifestSha256 = 'f'.repeat(64),
    c => c.lifecycleV11.c1FinalPlanRevisionHistory[0].sourceFinalAssets.assets.finalUploads[0].sha256 = 'f'.repeat(64),
    c => c.lifecycleV11.c1FinalPlanRevisionPreparation.sourceCardId = 'card:foreign']) {
    const invalid = structuredClone(ready); mutate(invalid);
    assert.throws(() => completeC1FinalPlanRevision({ candidate: invalid, historyRecord: prepared.historyRecord, expectedRevision: invalid.dataRevision, completedAt: doneAt }));
  }
  const snapshot = final.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot;
  assert.deepEqual(snapshot.sourceFactsRevision, prepared.candidate.lifecycleV11.skuPackage.c1ProductPlan.sourceFactsRevision);
  assert.equal(snapshot.batteryAssessment.batteryType.value, 'none');
  assert.equal(snapshot.batteryAssessment.containsBattery.value, false);
  assert.notEqual(final.productionConfirmationCard.cardId, source.lifecycleV11.skuPackage.productionConfirmationCard.cardId);
  assert.equal(final.productionAuthorization, null);
});

test('published C1 schema accepts the explicit new facts input and rejects unknown record fields', async () => {
  const { loadPublishedSchemaValidator } = await import('./helpers/published-schema-validator.mjs');
  const validator = await loadPublishedSchemaValidator();
  const validate = validator.getSchema('c1-product-plan-v1.1');
  const plan = structuredClone(prepare().candidate.lifecycleV11.skuPackage.c1ProductPlan);
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  plan.sourceFactsRevision.unregisteredReplacement = true;
  assert.equal(validate(plan), false);
});

test('an obsolete colour mapping cannot demote a newly confirmed source value', async () => {
  const { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } = await import('./fixtures/c1-local-draft-source-fixture.mjs');
  const { verifyC1ProductFacts, applyC1SkuAttributeScopeReview } = await import('../lib/c1-product-plan.mjs');
  const candidate = createSavedLocalPreparationCandidate(), sku = candidate.lifecycleV11.skuPackage;
  // Independent evidence changes the input before the fact-verification step;
  // the old owner mapping is retained to exercise the stale-reference branch.
  sku.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes.colour = '卡其色';
  const checked = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: sku.c1RightsReviewRecord.review, verifiedAt: LOCAL_DRAFT_AT }).skuPackage;
  const mapping = sku.ozonAttributeMappingsV1.mappings.find(item => item.attributeId === '10096');
  const result = applyC1SkuAttributeScopeReview({ skuPackage: checked, reviewedAt: LOCAL_DRAFT_AT,
    scopeReview: { schemaVersion: 'c1-sku-attribute-scope-review-v1', evidenceRef: 'scope:synthetic:colour', attributes: [{ fieldKey: '10096', sourceFactPath: mapping.sourceFactPath }] } });
  const plan = result.skuPackage.c1ProductPlan;
  assert.equal(plan.productAttributes.supplierAttributes.find(x => x.fieldKey === 'colour').fact.value, '卡其色');
  assert.equal(plan.productAttributes.supplierAttributes.find(x => x.fieldKey === 'colour').fact.verificationStatus, 'confirmed');
  assert.equal(plan.productAttributes.ozonAttributes.find(x => x.fieldKey === '10096').fact.verificationStatus, 'unknown');
  assert.equal(plan.productAttributes.ozonAttributes.find(x => x.fieldKey === '10096').dictionaryValueId, null);
});

test('history references use one exact projection and preserve explicit absence rules', async () => {
  const { buildC1FinalPlanHistoryReferences } = await import('../lib/c1-final-plan-revision-preparation.mjs');
  assert.deepEqual(buildC1FinalPlanHistoryReferences({ unknownReference: null }), { c2UploadDraft: null });
  const input = { c1AiDraftRequestV1: null, c2UploadDraft: { registration: 'saved' }, unknownReference: { ignored: true } };
  const result = buildC1FinalPlanHistoryReferences(input);
  assert.deepEqual(result, { c2UploadDraft: { registration: 'saved' }, c1AiDraftRequestV1: null });
  result.c2UploadDraft.registration = 'changed';
  assert.equal(input.c2UploadDraft.registration, 'saved');
});
