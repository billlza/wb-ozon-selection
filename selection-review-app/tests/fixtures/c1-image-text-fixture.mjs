import assert from 'node:assert/strict';
import { productionOwnerDecisionFixture } from './production-owner-decision-fixture.mjs';
import { localFinalAssets } from '../helpers/c2-software-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../../lib/business-state-repository.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';

export const OCR_AT = '2026-08-22T10:00:00.000Z';
export function imageTextFixture({ count = 2 } = {}) {
  const templates = localFinalAssets();
  const finalUploadAssets = Array.from({ length: count }, (_, index) => {
    const assetId = `c2-local:00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const sha256 = (index + 1).toString(16).padStart(64, '0');
    return { ...templates[index ? 1 : 0], assetId, assetRef: `local-asset:${assetId}`, fileName: `synthetic-${index + 1}.png`,
      sha256, assetVersion: `sha256:${sha256}`,
      order: index + 1, role: index ? 'gallery_image' : 'main_image' };
  });
  const source = productionOwnerDecisionFixture(undefined, { finalUploadAssets });
  const candidate = structuredClone(source.candidate), sku = candidate.lifecycleV11.skuPackage;
  const prepared = sku.c2FinalAssets.productionAuthorizationPreparation;
  const assets = sku.c2FinalAssets.assets.finalUploads;
  candidate.lifecycleV11.c2UploadDraft = { schemaVersion: 'c2-upload-draft-v1', candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: sku.dataRevision, sourceC1Fingerprint: prepared.sourceC1Fingerprint,
    schemaEvidenceRef: prepared.targetContext.schemaEvidenceRef, revision: 1,
    uploads: assets.map(asset => ({ ...structuredClone(asset), status: 'ready' })),
    selection: assets.map(asset => ({ assetId: asset.assetId, order: asset.order })) };
  const document = initialBusinessStateDocument({ now: OCR_AT }); document.candidates = [candidate];
  const repository = createMemoryBusinessStateRepository(document);
  const owner = createActorContext({ userId: 'synthetic-owner', sessionId: 'synthetic-ocr-session', actorType: 'human',
    roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: OCR_AT });
  const reads = [], calls = [];
  const assetStore = { async read(asset, options) {
    assert.equal(options.verifyContent, true);
    reads.push(structuredClone(asset));
    return { body: Buffer.from(`synthetic image bytes ${asset.order}`) };
  } };
  const extractor = { version: 'synthetic-ocr-v1', async extract(input) {
    assert.ok(Buffer.isBuffer(input.body)); calls.push(input.body.toString());
    return { text: `Текст изображения ${calls.length}`, language: 'ru-RU' };
  } };
  return { candidate, repository, owner, reads, calls, assetStore, extractor, serverClock: () => OCR_AT,
    input: { candidateId: candidate.id, expectedRevision: candidate.dataRevision } };
}
export async function replaceCandidate(repository, mutate) {
  await repository.transact(document => {
    mutate(document.candidates[0]);
    return { changed: true, document, result: undefined };
  });
}
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Synthetic current-format archive reference; complete history is stored separately. */
export function archiveImageManifestForC1Fixture(candidate) {
  const previous = structuredClone(candidate.lifecycleV11.skuPackage), current = candidate.lifecycleV11.skuPackage;
  const sourceRevision = candidate.dataRevision, c2 = previous.c2FinalAssets;
  candidate.dataRevision += 1; current.dataRevision += 2;
  current.c2FinalAssets = null; current.c1ProductPlan.c1PlanId += ':new';
  candidate.lifecycleV11.c1FinalPlanRevisionPreparation = { preparationId: 'synthetic:history', historyRef: 'synthetic:history',
    candidateId: candidate.id, skuPackageId: current.skuPackageId, supplierSkuId: current.supplierSkuId, variantKey: current.variantKey,
    targetC1PlanId: current.c1ProductPlan.c1PlanId, sourceC1PlanId: previous.c1ProductPlan.c1PlanId,
    sourceCandidateRevision: sourceRevision, sourceSkuRevision: previous.dataRevision,
    sourceFinalManifestSha256: c2.ownerFinalUploadConfirmation.approvedManifestSha256 };
  candidate.lifecycleV11.c1FinalPlanRevisionHistory = [{ schemaVersion: 'c1-final-plan-revision-history-ref-v1',
    preparationId: 'synthetic:history', sourceCandidateRevision: sourceRevision, sourceSkuRevision: previous.dataRevision,
    sourceIdentity: structuredClone(previous.g1Identity), variantKey: previous.variantKey, sourceC1PlanId: previous.c1ProductPlan.c1PlanId,
    sourceFinalAssets: { assets: { finalUploads: structuredClone(c2.assets.finalUploads) },
      ownerFinalUploadConfirmation: structuredClone(c2.ownerFinalUploadConfirmation),
      effectiveVideoRequirement: structuredClone(c2.effectiveVideoRequirement), sourceC1Fingerprint: c2.targetContext.sourceC1Fingerprint } }];
  return previous;
}
