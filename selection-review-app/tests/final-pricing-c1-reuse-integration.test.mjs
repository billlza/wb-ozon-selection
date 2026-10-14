import test from 'node:test';
import assert from 'node:assert/strict';
import { finalPricingC1ReuseFixture } from './fixtures/final-pricing-c1-reuse-fixture.mjs';
import { assertSafeRuntimeRecord, assertSafeBusinessMutationCandidate } from '../lib/runtime-identity.mjs';
import { validateC2AssetLifecycle, fingerprintC2FinalCardInputSnapshot, fingerprintC2AuthorizationPreparation } from '../lib/c2-asset-lifecycle.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

test('C2 pricing reuse freezes one complete record and rejects rebound or altered references', async () => {
  const { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } = await import('../lib/c2-software-orchestrator.mjs');
  const { finalAssets, ownerDecision } = await import('./helpers/c2-software-fixture.mjs');
  const f = finalPricingC1ReuseFixture();
  await f.usecase.review({ actor: f.actor, input: f.input });
  const source = (await f.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision, finalUploadAssets: finalAssets(), preparedAt: f.observedAt });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: f.observedAt });
  const frozen = confirmed.skuPackage.c2FinalAssets;
  const preparation = frozen.productionAuthorizationPreparation;
  const complete = preparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.pricingReuseRecord;
  const references = [preparation.frozenC1Handoff.draftOnlySeo.pricingReuseRecord, preparation.finalCardInputSnapshot.canonicalC1.draftOnlySeo.pricingReuseRecord];
  assert.equal(complete.schemaVersion, 'c1-pricing-result-reuse-v1');
  assert.deepEqual(confirmed.skuPackage.c1ProductPlan.draftOnlySeo.pricingReuseRecord, complete);
  assert.equal(references[0].schemaVersion, 'c1-pricing-result-reuse-reference-v1');
  assert.deepEqual(references[0], references[1]);
  assert.equal(references[0].recordFingerprint, fingerprintCanonicalRecord(complete));
  assert.deepEqual(references[0].sourceIdentity, complete.sourceIdentity);
  assert.equal(references[0].resultSkuRevision, complete.resultSkuRevision);
  assert.equal(references[0].targetProfitModelVersion, complete.targetProfitModelVersion);
  for (const change of [
    reference => { reference.sourceIdentity.candidateId = 'foreign'; },
    reference => { reference.resultSkuRevision += 1; },
    reference => { reference.targetPlanId = 'foreign-plan'; },
    reference => { reference.targetProfitModelVersion = 'foreign-profit'; },
    reference => { reference.recordFingerprint = '0'.repeat(64); },
    reference => { reference.extra = true; }
  ]) {
    const altered = structuredClone(frozen);
    for (const reference of [altered.productionAuthorizationPreparation.frozenC1Handoff.draftOnlySeo.pricingReuseRecord,
      altered.productionAuthorizationPreparation.finalCardInputSnapshot.canonicalC1.draftOnlySeo.pricingReuseRecord]) change(reference);
    const changedPreparation = altered.productionAuthorizationPreparation;
    changedPreparation.finalCardInputFingerprint = fingerprintC2FinalCardInputSnapshot(changedPreparation.finalCardInputSnapshot);
    changedPreparation.preparationFingerprint = fingerprintC2AuthorizationPreparation(changedPreparation);
    assert.ok(validateC2AssetLifecycle(altered).errors.some(error => error.path.includes('draftOnlySeo.pricingReuseRecord')));
  }
  const alteredSource = structuredClone(frozen);
  alteredSource.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.pricingReuseRecord.request.requestId = 'changed-source';
  assert.ok(validateC2AssetLifecycle(alteredSource).errors.some(error => error.path.includes('draftOnlySeo.pricingReuseRecord')));
});

test('published C2 handoff schemas accept the new reference and preserve legacy complete handoffs', async () => {
  const { normalizeC1CanonicalHandoffContract } = await import('../lib/c2-asset-lifecycle.mjs');
  const { loadPublishedSchemaValidator } = await import('./helpers/published-schema-validator.mjs');
  const f = finalPricingC1ReuseFixture();
  await f.usecase.review({ actor: f.actor, input: f.input });
  const sku = (await f.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage;
  const referenceHandoff = normalizeC1CanonicalHandoffContract(sku);
  const legacy = structuredClone(sku);
  legacy.c2FinalAssets.status = 'completed';
  legacy.c2FinalAssets.productionAuthorizationPreparation = { frozenC1Handoff: {
    draftOnlySeo: { pricingReuseRecord: structuredClone(sku.c1ProductPlan.draftOnlySeo.pricingReuseRecord) }
  } };
  const fullHandoff = normalizeC1CanonicalHandoffContract(legacy);
  assert.equal(referenceHandoff.draftOnlySeo.pricingReuseRecord.schemaVersion, 'c1-pricing-result-reuse-reference-v1');
  assert.equal(fullHandoff.draftOnlySeo.pricingReuseRecord.schemaVersion, 'c1-pricing-result-reuse-v1');
  const validator = await loadPublishedSchemaValidator();
  for (const schemaId of ['c2-asset-lifecycle-v1.1#/$defs/canonicalC1Handoff', 'c2-software-input-v1#/$defs/canonicalHandoff']) {
    const validate = validator.getSchema(schemaId);
    assert.equal(validate(referenceHandoff), true, `${schemaId}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate(fullHandoff), true, `${schemaId}: ${JSON.stringify(validate.errors)}`);
  }
});

test('final repricing reuses the completed C1 result and returns to C2 without another AI job or accounting charge', async () => {
  const f = finalPricingC1ReuseFixture(), before = await f.repository.readSnapshot();
  const result = await f.usecase.review({ actor: f.actor, input: f.input });
  const after = await f.repository.readSnapshot(), sku = after.candidates[0].lifecycleV11.skuPackage;
  assert.equal(result.status, 'committed'); assert.equal(sku.businessPhase, 'C2');
  assert.equal(sku.profitModels.at(-1).recommendedSalePriceRub, 2000);
  assert.deepEqual(sku.profitModels.slice(0, -1), before.candidates[0].lifecycleV11.skuPackage.profitModels);
  assert.deepEqual(after.runtime.softwareJobs, before.runtime.softwareJobs);
  assert.deepEqual(after.runtime.softwareJobAuthorizationRecords, before.runtime.softwareJobAuthorizationRecords);
  assert.equal(result.result.externalRequests, 0); assert.equal(result.result.productionAuthorizationCreated, false);
  const record = sku.c1ProductPlan.draftOnlySeo.pricingReuseRecord;
  assert.deepEqual(record.request, f.saved.request); assert.deepEqual(record.receipt, f.saved.receipt);
  assert.equal(sku.productionAuthorization, null); assert.equal(sku.productionRecord, null);
  assertSafeBusinessMutationCandidate(after.candidates[0], 'syntheticFinalPricing');
  const secret = structuredClone(after.candidates[0]);
  secret.lifecycleV11.skuPackage.c1ProductPlan.draftOnlySeo.pricingReuseRecord.apiKey = 'synthetic-forbidden-value';
  assert.throws(() => assertSafeBusinessMutationCandidate(secret), /秘密/);
});

test('a second explicit price revision keeps one original C1 source record and unchanged software jobs', async () => {
  const f = finalPricingC1ReuseFixture(), jobs = JSON.stringify(f.document.runtime.softwareJobs);
  await f.usecase.review({ actor: f.actor, input: f.input });
  const first = await f.repository.readSnapshot(), firstSku = first.candidates[0].lifecycleV11.skuPackage;
  assert.equal(firstSku.businessPhase, 'C2');
  const input = { ...f.input, expectedRevision: first.candidates[0].dataRevision, selectedPriceRub: 2100,
    idempotencyKey: 'synthetic:final-pricing:2', auditEventId: 'synthetic:final-pricing-audit:2' };
  await f.usecase.review({ actor: f.actor, input });
  const after = await f.repository.readSnapshot(), sku = after.candidates[0].lifecycleV11.skuPackage;
  assert.equal(sku.businessPhase, 'C2'); assert.equal(sku.profitModels.at(-1).recommendedSalePriceRub, 2100);
  const record = sku.c1ProductPlan.draftOnlySeo.pricingReuseRecord;
  assert.equal(Object.hasOwn(record.sourcePlan.draftOnlySeo, 'pricingReuseRecord'), false);
  assert.deepEqual(record.request, f.saved.request); assert.deepEqual(record.receipt, f.saved.receipt);
  assert.equal(JSON.stringify(after.runtime.softwareJobs), jobs);
  assert.equal(sku.productionAuthorization, null);
  assertSafeBusinessMutationCandidate(after.candidates[0], 'syntheticSecondFinalPricing');
});

test('missing completed source and changed sample facts save an explicit C1 gap without creating work', async () => {
  for (const mode of ['missing_job', 'changed_category']) {
    const f = finalPricingC1ReuseFixture();
    await f.repository.transact(document => {
      if (mode === 'missing_job') document.runtime.softwareJobs = [];
      else for (const snapshot of document.candidates[0].salesSnapshotsV11) snapshot.categoryPath = 'Synthetic different category';
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    const result = await f.usecase.review({ actor: f.actor, input: f.input });
    const after = await f.repository.readSnapshot(), life = after.candidates[0].lifecycleV11;
    assert.equal(result.result.status, 'price_revalidated'); assert.equal(life.skuPackage.businessPhase, 'C1');
    assert.equal(life.c1PricingReuse.status, 'blocked');
    assert.match(life.c1PricingReuse.reasonCode, mode === 'missing_job' ? /SOURCE_JOB_MISSING/ : /MARKET_FACT_CHANGED/);
    assert.equal(life.skuPackage.c2FinalAssets, null); assert.equal(life.skuPackage.productionAuthorization, null);
    assert.deepEqual(after.runtime.softwareJobs, before.runtime.softwareJobs);
    assert.deepEqual(after.runtime.softwareJobAuthorizationRecords, before.runtime.softwareJobAuthorizationRecords);
    assert.equal(result.result.externalRequests, 0);
  }
});

test('expired keyword evidence blocks reuse at the current clock without another request or charge', async () => {
  const f = finalPricingC1ReuseFixture();
  const { createFinalPricingReviewUseCase } = await import('../lib/final-pricing-review-use-case.mjs');
  const usecase = createFinalPricingReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => '2026-08-23T02:00:00.000Z' });
  const before = await f.repository.readSnapshot();
  await usecase.review({ actor: f.actor, input: f.input });
  const after = await f.repository.readSnapshot(), life = after.candidates[0].lifecycleV11;
  assert.equal(life.skuPackage.businessPhase, 'C1'); assert.equal(life.c1PricingReuse.reasonCode, 'C1_PRICING_REUSE_KEYWORDS_EXPIRED');
  assert.deepEqual(after.runtime.softwareJobs, before.runtime.softwareJobs);
  assert.deepEqual(after.runtime.softwareJobAuthorizationRecords, before.runtime.softwareJobAuthorizationRecords);
  assert.equal(life.skuPackage.productionAuthorization, null);
});

test('reused C1 can reconfirm C2 assets and build a new canonical frozen final card without authorization', async () => {
  const { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } = await import('../lib/c2-software-orchestrator.mjs');
  const { finalAssets, ownerDecision } = await import('./helpers/c2-software-fixture.mjs');
  const { createFinalProductPlanConfirmationCard } = await import('../lib/final-product-plan-confirmation-card.mjs');
  const { loadPublishedSchemaValidator } = await import('./helpers/published-schema-validator.mjs');
  const f = finalPricingC1ReuseFixture();
  await f.usecase.review({ actor: f.actor, input: f.input });
  const before = await f.repository.readSnapshot(), source = before.candidates[0].lifecycleV11.skuPackage;
  assert.equal(source.businessPhase, 'C2');
  const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision, finalUploadAssets: finalAssets(), preparedAt: f.observedAt });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: f.observedAt });
  const result = createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: f.observedAt });
  assert.equal(result.confirmationCard.profitResult.recommendedSalePrice.value.rub, 2000);
  assert.equal(result.skuPackage.productionAuthorization, null);
  const published = await loadPublishedSchemaValidator(), validate = published.getSchema('product-lifecycle-v1.1');
  assert.equal(validate(result.skuPackage), true, JSON.stringify(validate.errors));
  assertSafeRuntimeRecord(result.confirmationCard, 'syntheticReusedFinalCard');
  assertSafeBusinessMutationCandidate({ ...before.candidates[0], lifecycleV11: { ...before.candidates[0].lifecycleV11, skuPackage: result.skuPackage } }, 'syntheticReusedCandidate');
  assert.deepEqual(await f.repository.readSnapshot(), before, 'local C2 construction does not persist or create work');
});

test('repricing rebinds a ready registered upload draft while preserving files selection and historical draft', async () => {
  const { reserveC2Upload, settleC2Upload, saveC2UploadSelection, selectedC2DraftAssets, assertCurrentC2UploadDraft } = await import('../lib/c2-upload-draft.mjs');
  const { localFinalAssets, ownerDecision } = await import('./helpers/c2-software-fixture.mjs');
  const { buildC2FinalAssetInput } = await import('../src/c2FinalAssetInput.js');
  const { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } = await import('../lib/c2-software-orchestrator.mjs');
  const f = finalPricingC1ReuseFixture();
  const source = structuredClone(f.document.candidates[0]), assets = localFinalAssets();
  for (const asset of assets) {
    const uploadId = asset.assetId.slice('c2-local:'.length);
    const draft = reserveC2Upload(source, { dataRevision: source.dataRevision, draftRevision: source.lifecycleV11.c2UploadDraft?.revision ?? 0,
      uploadId, fileName: asset.fileName, mediaType: asset.mediaType, contentType: 'image/jpeg', startedAt: f.observedAt });
    source.lifecycleV11.c2UploadDraft = settleC2Upload(draft, { uploadId, asset: { ...asset, stagedAt: f.observedAt }, settledAt: f.observedAt });
  }
  source.lifecycleV11.c2UploadDraft = saveC2UploadSelection(source, { dataRevision: source.dataRevision, draftRevision: source.lifecycleV11.c2UploadDraft.revision,
    selection: assets.map((asset, index) => ({ assetId: asset.assetId, order: index + 1 })) });
  const originalDraft = JSON.stringify(source.lifecycleV11.c2UploadDraft);
  await f.repository.transact(document => { document.candidates[0] = source; return { changed: true, document, result: null }; });
  await f.usecase.review({ actor: f.actor, input: f.input });
  const saved = await f.repository.readSnapshot(), candidate = saved.candidates[0], life = candidate.lifecycleV11, sku = life.skuPackage, draft = life.c2UploadDraft;
  assert.equal(sku.businessPhase, 'C2');
  assert.equal(draft.sourceCandidateRevision, candidate.dataRevision);
  assert.equal(draft.sourceSkuRevision, sku.dataRevision);
  assert.equal(draft.sourceC1Fingerprint, sku.c2FinalAssets.softwareState.sourceC1Fingerprint);
  assert.equal(draft.skuPackageId, sku.skuPackageId);
  assert.deepEqual(draft.selection, JSON.parse(originalDraft).selection);
  assert.deepEqual(draft.uploads, JSON.parse(originalDraft).uploads);
  assert.equal(JSON.stringify(source.lifecycleV11.c2UploadDraft), originalDraft);
  assert.equal(JSON.stringify(life.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft), originalDraft);
  assertCurrentC2UploadDraft(candidate, { dataRevision: candidate.dataRevision, draftRevision: draft.revision });
  const selected = selectedC2DraftAssets(draft);
  assert.deepEqual(selected.map(asset => [asset.assetId, asset.sha256]), assets.map(asset => [asset.assetId, asset.sha256]));
  const input = buildC2FinalAssetInput({ candidate, sourceRevision: candidate.dataRevision, draftRevision: draft.revision, assets: selected, ownerChecked: true });
  assert.deepEqual(input.approvedAssetIds, assets.map(asset => asset.assetId));
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads, []);
  const manifest = prepareC2FinalUploadManifest({ skuPackage: sku, expectedDataRevision: sku.dataRevision, finalUploadAssets: selected, preparedAt: f.observedAt });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: sku, expectedDataRevision: sku.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: f.observedAt });
  assert.equal(confirmed.skuPackage.c2FinalAssets.status, 'completed');
  assert.equal(confirmed.skuPackage.productionAuthorization, null);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
});
