import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { threeColorC2Fixture, at } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { loadOzonProductImportBatchLimitEvidence } from '../lib/ozon-product-import-batch-limit.mjs';

const { api: port } = allocatedTestPorts();

test('one authenticated batch confirmation persists authorization and reports unavailable D without an external request', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'batch-import-api-'));
  const family=await threeColorC2Fixture(1);
  await commitSiblingBatchC2Final({repository:family.repository,runtimeMode:'local_development',
    actor:family.actor,input:family.input,verifiedAssets:family.verifiedAssets,serverClock:()=>at});
  const prepared=await family.repository.readSnapshot();
  const parent=prepared.candidates[0];
  const owner=productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    {sourceCandidate:prepared.candidates[1],sourceAt:at});
  fixture.document.candidates=[parent,owner.candidate];
  fixture.document.evidencePacks=owner.evidencePacks.map(pack=>({...pack,expiresAt:'2099-01-01T00:00:00.000Z'}));
  fixture.document.currentCommissionCatalogs=owner.currentCommissionCatalogs;
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document,
    binding: fixture.binding, services: [] });
  const input={confirmAll:true,parentCandidateId:parent.id,parentRevision:parent.dataRevision,
    excludedOfferIds:['SYNTHETIC-FIRST-UNKNOWN'],
    members:[{candidateId:owner.candidate.id,ownerInput:{...owner.args.input,
      merchantSku:'SYNTHETIC-COLOR-API'}}],
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',
      eReadbackOfferIds:['SYNTHETIC-COLOR-API']}};
  const denied = await api.post('/api/d-batches/authorize', input, { authenticated: false });
  assert.equal(denied.status, 401);
  const before = await api.readBytes();
  await api.authenticate();
  const crossSite = await api.post('/api/d-batches/authorize', input,
    { headers: { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await api.readBytes(), before);
  const legacy=structuredClone(input);
  delete legacy.parentCandidateId;delete legacy.parentRevision;
  const missingParent=await api.post('/api/d-batches/authorize',legacy);
  assert.equal(missingParent.status,400,JSON.stringify(missingParent.body));
  assert.equal(missingParent.body.code,'D_BATCH_AUTHORIZATION_INPUT_INVALID');
  assert.deepEqual(await api.readBytes(),before);
  const confirmed = await api.post('/api/d-batches/authorize', input);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.executionStatus,'prewrite_blocked');
  assert.equal(confirmed.body.executionView.members[0].offerId,'SYNTHETIC-COLOR-API');
  assert.equal(confirmed.body.reasonCode,'DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT');
  assert.equal(confirmed.body.externalRequests, 0);
  const replay = await api.post('/api/d-batches/authorize', input);
  assert.equal(replay.status,200,JSON.stringify(replay.body));
  assert.equal(replay.body.batch.batchId,confirmed.body.batch.batchId);
  const detail=await api.get(`/api/d-batches/${encodeURIComponent(confirmed.body.batch.batchId)}`);
  assert.equal(detail.status,200);
  assert.equal(detail.body.members[0].importStatus,'not_started');
  const resume=await api.post(`/api/d-batches/${encodeURIComponent(confirmed.body.batch.batchId)}/resume`,
    {confirmUnsentStockContinuation:true});
  assert.equal(resume.status,422);
  assert.equal(resume.body.code,'DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT');
  const saved = await api.readDocument();
  assert.equal(saved.runtime.dProductionBatches.length,1);
  assert.equal(saved.runtime.dBatchImportJobs, undefined);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('where batches can be sent, an out-of-date import limit record stops a new batch before anything is saved or held', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'batch-import-limit-api-'));
  // The record that ran out on 2026-10-05 (review P0-4), in a folder of its own so a later fresh check cannot change this test.
  const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'batch-limit-evidence-api-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const expired = await loadOzonProductImportBatchLimitEvidence();
  assert.equal(expired.validUntil, '2026-10-05T00:40:19.000Z');
  await writeFile(path.join(evidenceDirectory, 'ozon-product-import-batch-limit-20260928.json'), JSON.stringify(expired));
  const family=await threeColorC2Fixture(1);
  await commitSiblingBatchC2Final({repository:family.repository,runtimeMode:'local_development',
    actor:family.actor,input:family.input,verifiedAssets:family.verifiedAssets,serverClock:()=>at});
  const prepared=await family.repository.readSnapshot();
  const parent=prepared.candidates[0];
  const owner=productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    {sourceCandidate:prepared.candidates[1],sourceAt:at});
  fixture.document.candidates=[parent,owner.candidate];
  fixture.document.evidencePacks=owner.evidencePacks.map(pack=>({...pack,expiresAt:'2099-01-01T00:00:00.000Z'}));
  fixture.document.currentCommissionCatalogs=owner.currentCommissionCatalogs;
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding,
    services: [fixture.service], batchLimitEvidenceDirectory: evidenceDirectory,
    credentialBindings: [{ credentialAlias: fixture.binding.credentialAlias, clientId: '700123',
      keychainService: 'synthetic-de-http', keychainAccount: 'synthetic-seller-key' }] });
  const input={confirmAll:true,parentCandidateId:parent.id,parentRevision:parent.dataRevision,
    excludedOfferIds:['SYNTHETIC-FIRST-UNKNOWN'],
    members:[{candidateId:owner.candidate.id,ownerInput:{...owner.args.input,merchantSku:'SYNTHETIC-COLOR-API'}}],
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',
      eReadbackOfferIds:['SYNTHETIC-COLOR-API']}};
  await api.authenticate();
  const before = await api.readBytes();
  for (const refused of [await api.post('/api/d-batches/authorize', input), await api.post('/api/d-batches/authorize', input)]) {
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'D_BATCH_IMPORT_LIMIT_NOT_CURRENT');
    assert.match(refused.body.message, /这批没有保存，也没有发给 Ozon，这些规格都没有被占用/u);
    assert.match(refused.body.message, /已经在 2026-10-05 到期/u);
    assert.equal(refused.body.externalRequests, 0);
    assert.equal(refused.body.platformWrites, 0);
  }
  assert.deepEqual(await api.readBytes(), before, 'no batch saved and no member authorization written');
  assert.equal((await api.readDocument()).runtime.dProductionBatches, undefined);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
