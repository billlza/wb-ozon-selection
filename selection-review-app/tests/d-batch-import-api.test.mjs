import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { threeColorC2Fixture, at } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';

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
