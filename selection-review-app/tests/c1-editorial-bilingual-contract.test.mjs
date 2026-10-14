import test from 'node:test';
import assert from 'node:assert/strict';
import { createC1EditorialReviewFixture } from './fixtures/c1-editorial-review-fixture.mjs';
import { createC1EditorialReviewUseCase, buildC1EditorialReviewView } from '../lib/c1-editorial-review-use-case.mjs';
import { assessC1DraftEditorialContent, assertC1EditorialPlan } from '../lib/c1-editorial-review-contract.mjs';

const at = '2026-08-25T08:00:00.000Z';
test('v3 reference-only correction preserves each original review translation, keyword role and immutable category/attribute pair', async () => {
  const f = await createC1EditorialReviewFixture({ at }), before = structuredClone(f.bundle);
  const assessed = assessC1DraftEditorialContent(f.bundle);
  assert.equal(assessed.status, 'editorial_proposed');
  assert.equal(f.bundle.request.outputContractVersion, 'c1-ai-draft-output-v3');
  assert.equal(assessed.editedVersion.output.title.reviewZh, f.bundle.receipt.output.title.reviewZh);
  const view = buildC1EditorialReviewView({ candidate: f.candidate, sourceJob: f.bundle.sourceJob, proposalBundle: f.bundle, observedAt: at });
  const api = createC1EditorialReviewUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: () => at, proposalBundle: f.bundle });
  const result = await api.confirm({ actor: f.owner, input: { candidateId: f.candidate.id, expectedRevision: f.candidate.dataRevision,
    editorialVersionId: view.editorialVersionId, outputFingerprint: view.outputFingerprint, confirmed: true,
    idempotencyKey: 'synthetic:bilingual:confirm', auditEventId: 'synthetic:bilingual:audit' } });
  const sku = result.candidate.lifecycleV11.skuPackage, plan = sku.c1ProductPlan, original = f.bundle.receipt.output;
  assert.equal(plan.seoTitleDraft.reviewZh, original.title.reviewZh);
  assert.equal(plan.descriptionDraft.reviewZh, original.description.reviewZh);
  assert.deepEqual(plan.bulletPointsDraft.map(i => i.reviewZh), original.bulletPoints.map(i => i.reviewZh));
  assert.deepEqual(plan.searchKeywordsDraft.keywords.map(i => [i.reviewZh, i.keywordRole]), original.searchKeywords.map(i => [i.reviewZh, i.keywordRole]));
  assert.deepEqual(plan.seoEvidenceLayer.russianAttributes, original.russianAttributes);
  assert.deepEqual(plan.seoEvidenceLayer.categoryPathReview, original.categoryPathReview);
  assert.deepEqual(f.bundle, before);
  assert.equal(plan.draftOnlySeo.formalProviderResultAccepted, false);
  assert.equal(sku.productionAuthorization, null);
  for (const mutate of [p => { p.seoTitleDraft.reviewZh += '改变'; },
    p => { p.searchKeywordsDraft.keywords[0].keywordRole = 'long_tail'; },
    p => { p.seoEvidenceLayer.russianAttributes[0].reviewZh += '改变'; },
    p => { p.seoEvidenceLayer.categoryPathReview[0].reviewZh += '改变'; }]) {
    const changed = structuredClone(plan); mutate(changed);
    assert.throws(() => assertC1EditorialPlan({ plan: changed, identity: sku.g1Identity,
      resultSkuRevision: plan.draftOnlySeo.editorialSource.ownerConfirmation.resultSkuRevision }), /C1_EDITORIAL_CONTENT_CONFLICT/);
  }
});

test('v3 changed Russian wording cannot reuse the original Chinese translation or invent a translation in the correction plan', async () => {
  const f = await createC1EditorialReviewFixture({ at });
  const changed = structuredClone(f.bundle); changed.correctionPlan.items[0].correctedText += ' Исправлено';
  assert.deepEqual(assessC1DraftEditorialContent(changed).reasons, [{ code: 'EDITORIAL_TRANSLATION_REFRESH_REQUIRED', path: 'output.title' }]);
  const injected = structuredClone(f.bundle); injected.correctionPlan.items[0].reviewZh = '未经模型输出的释义';
  assert.equal(assessC1DraftEditorialContent(injected).reasons[0].code, 'EDITORIAL_ITEM_INVALID');
  assert.deepEqual(await f.repository.readSnapshot(), f.document);
});
