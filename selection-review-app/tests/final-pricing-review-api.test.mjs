import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFinalPricingRevalidationFixture } from './fixtures/final-pricing-revalidation-fixture.mjs';
import { startSavedDEApi, productionOwnerDecisionHttpFixture } from './helpers/d-e-saved-api-fixture.mjs';

test('最终定价真实HTTP鉴权、双提交、冷回读及过期修订，零外部依赖', async t => {
  const f = createFinalPricingRevalidationFixture(), source = await productionOwnerDecisionHttpFixture();
  const sku = f.candidate.lifecycleV11.skuPackage;
  f.candidate.salesSnapshotsV11 = structuredClone(f.assessmentInput.salesSnapshots);
  const document = { meta: { version: 2, automationStarted: false }, candidates: [f.candidate], dispatches: [],
    evidencePacks: f.evidencePacks.map(pack => ({ ...pack, expiresAt: '2099-01-01T00:00:00.000Z' })),
    currentCommissionCatalogs: [], rules: f.rules, runtime: { softwareJobs: [] } };
  const binding = { ...source.binding, platform: sku.targetPlatform, storeRef: structuredClone(sku.g1Identity.storeRef) };
  const api = await startSavedDEApi(t, { directory: await mkdtemp(path.join(tmpdir(), 'final-pricing-api-')),
    port: allocatedTestPorts().api, document, binding });
  const route = `/api/candidates/${f.candidate.id}/lifecycle/final-pricing/review`;
  const end = new Date(), start = new Date(end.getTime() - 29 * 86400000);
  const reviews = f.assessmentInput.reviews.map(review => ({ ...review, salesWindow: { ...review.salesWindow,
    startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) } }));
  const input = { candidateId: f.candidate.id, expectedRevision: f.candidate.dataRevision, skuPackageId: sku.skuPackageId,
    selectedPriceRub: f.assessmentInput.selectedPriceRub, reviews, idempotencyKey: 'http:final:1', auditEventId: 'audit:http:final:1' };
  const before = await api.readBytes();
  const anonymous = await api.post(route, input, { authenticated: false });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'OWNER_LOGIN_REQUIRED');
  assert.deepEqual(await api.readBytes(), before);
  await api.authenticate();
  const both = await Promise.all([api.post(route, input), api.post(route, input)]);
  for (const response of both) assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(both.map(response => response.body.transactionStatus).sort(), ['committed', 'idempotent_replay']);
  const saved = await api.readDocument(), current = saved.candidates[0];
  assert.equal(current.dataRevision, input.expectedRevision + 1);
  assert.equal(current.lifecycleV11.skuPackage.finalPricingReview.profitModelVersion, sku.activeProfitModelVersion);
  assert.deepEqual(current.lifecycleV11.skuPackage.profitModels, sku.profitModels);
  assert.deepEqual(saved.runtime.softwareJobs, []);
  const stale = await api.post(route, { ...input, idempotencyKey: 'http:final:2', auditEventId: 'audit:http:final:2' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'BUSINESS_MUTATION_REVISION_CONFLICT');
  assert.deepEqual(await api.readDocument(), saved);
  await api.restart(); await api.authenticate('login');
  const replay = await api.post(route, input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.transactionStatus, 'idempotent_replay');
  assert.deepEqual(await api.readDocument(), saved);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
