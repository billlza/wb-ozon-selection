import test from 'node:test';
import assert from 'node:assert/strict';
import { createC1CompletedEditorialFixture } from './fixtures/c1-completed-editorial-fixture.mjs';
import { buildC1CompletedEditorialPreview } from '../lib/c1-editorial-review-use-case.mjs';

test('completed editorial preview binds the current applied original without adopting or changing persisted state', async () => {
  const f = await createC1CompletedEditorialFixture();
  const before = structuredClone({ candidate: f.candidate, bundle: f.bundle });
  const view = buildC1CompletedEditorialPreview({ candidate: f.candidate, sourceJob: f.bundle.sourceJob,
    proposalBundle: f.bundle, observedAt: f.at });
  assert.equal(view.status, 'proposal_only');
  assert.equal(view.canConfirm, false);
  assert.equal(view.expectedRevision, f.candidate.dataRevision);
  assert.equal(view.sourceReceiptId, f.bundle.receipt.receiptId);
  assert.equal(view.content.description.text, f.bundle.correctionPlan.items[0].correctedText);
  assert.equal(view.content.description.reviewZh, f.bundle.correctionPlan.items[0].correctedReviewZh);
  assert.equal(view.providerReceiptReplaced, false);
  assert.equal(view.productionAuthorized, false);
  assert.deepEqual({ candidate: f.candidate, bundle: f.bundle }, before);
  assert.deepEqual(await f.repository.readSnapshot(), f.document);
  assert.equal(f.gatewayCalls(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
});

test('preview refuses drifted current content, facts, revisions, identities and downstream state', async () => {
  const f = await createC1CompletedEditorialFixture();
  for (const mutate of [
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.descriptionDraft.text += ' stale'; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.descriptionDraft.reviewZh += '过期'; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[0].fact.value = 'changed'; },
    c => { c.lifecycleV11.skuPackage.dataRevision += 1; },
    c => { c.dataRevision = f.bundle.sourceJob.revision; },
    c => { c.id += ':foreign'; },
    c => { c.lifecycleV11.c1AiDraftJobRefV1.jobId += ':foreign'; },
    c => { c.lifecycleV11.skuPackage.businessPhase = 'C2'; },
    c => { c.lifecycleV11.skuPackage.c2FinalAssets = {}; },
    c => { c.lifecycleV11.skuPackage.productionAuthorization = {}; },
    c => { c.lifecycleV11.c1ContentReviewV1 = {}; }
  ]) {
    const candidate = structuredClone(f.candidate); mutate(candidate);
    assert.throws(() => buildC1CompletedEditorialPreview({ candidate, sourceJob: f.bundle.sourceJob,
      proposalBundle: f.bundle, observedAt: f.at }));
  }
  const foreignJob = structuredClone(f.bundle.sourceJob); foreignJob.updatedAt = '2026-01-01T00:00:00.000Z';
  assert.throws(() => buildC1CompletedEditorialPreview({ candidate: f.candidate, sourceJob: foreignJob,
    proposalBundle: f.bundle, observedAt: f.at }), /C1_EDITORIAL_PREVIEW_SOURCE_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), f.document);
});
