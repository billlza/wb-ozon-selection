import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finalImageRevisionFixture } from './fixtures/c1-completed-editorial-fixture.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { savedDProductionJobFixture } from './fixtures/d-production-saved-job-fixture.mjs';
import { createC1EditorialReviewUseCase, buildC1EditorialReviewView } from '../lib/c1-editorial-review-use-case.mjs';
import { createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { assertSafeBusinessMutationCandidate, assertSafeRuntimeRecord } from '../lib/runtime-identity.mjs';
import { normalizeProductionEntities, restoreProductionEntities } from '../lib/production-entity-storage.mjs';
import { BUSINESS_CANDIDATE_MAX_NODES, BUSINESS_CANDIDATE_MAX_BYTES, assertNoProductionSecrets } from '../lib/production-contract-primitives.mjs';
import { createPersistableAliyunOssAssetIntent } from '../lib/aliyun-oss-d-asset-integration.mjs';
import { commitDExecutionIntent } from '../lib/d-e-software-integration.mjs';

const clone = value => structuredClone(value);
const skuOf = candidate => candidate.lifecycleV11.skuPackage;
function nodes(value) { return 1 + (value !== null && typeof value === 'object' ? Object.values(value).reduce((sum,child)=>sum+nodes(child),0) : 0); }
async function heavyOwnerFixture(t) {
  const {f}=await finalImageRevisionFixture({withReferenceSources:true,referenceAttributeCount:36,additionalPlatformAttributeCount:20});
  const view=buildC1EditorialReviewView({candidate:f.candidate,sourceJob:f.bundle.sourceJob,proposalBundle:f.bundle,observedAt:f.at});
  const review=createC1EditorialReviewUseCase({repository:f.repository,runtimeMode:'local_development',serverClock:()=>f.at,proposalBundle:f.bundle});
  await review.confirm({actor:f.owner,input:{candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision,
    editorialVersionId:view.editorialVersionId,outputFingerprint:view.outputFingerprint,confirmed:true,
    idempotencyKey:'production-capacity:editorial-confirm',auditEventId:'production-capacity:editorial-audit'}});
  const sourceDocument=await f.repository.readSnapshot();
  const owner=productionOwnerDecisionFixture(undefined,{sourceCandidate:sourceDocument.candidates[0],sourceDocument,sourceAt:f.at});
  const document=await owner.repository.readSnapshot();
  const directory=await mkdtemp(path.join(tmpdir(),'production-entity-capacity-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'state.json');await writeFile(filePath,JSON.stringify(document));
  owner.repository=createJsonBusinessStateRepository({filePath});owner.args.repository=owner.repository;
  return {owner,filePath,before:document};
}
function assertSingleEntities(raw) {
  const records=raw.productionEntityRecords;
  assert.equal(records.filter(record=>record.kind==='production_authorization').length,1);
  assert.equal(records.filter(record=>record.kind==='final_card_input_snapshot').length,1);
  assert.equal(new Set(records.map(record=>record.entityId)).size,records.length);
  assert.equal(skuOf(raw.candidates[0]).productionAuthorization.schemaVersion,'production-entity-reference-v1');
  assert.ok(nodes(raw.candidates[0])<=BUSINESS_CANDIDATE_MAX_NODES);
  assert.ok(Buffer.byteLength(JSON.stringify(raw.candidates[0]))<=BUSINESS_CANDIDATE_MAX_BYTES);
  for(const record of records) assert.ok(nodes(record.value)<=10000);
}

test('large completed editorial owner authorization is atomic, deduplicated and unchanged after concurrent replay and JSON restart',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected external request');});
  const {owner,filePath,before}=await heavyOwnerFixture(t);
  const results=await Promise.all([commitSingleOwnerProductionAuthorization(owner.args),commitSingleOwnerProductionAuthorization(owner.args)]);
  assert.deepEqual(new Set(results.map(result=>result.status)),new Set(['committed','idempotent_replay']));
  const after=await owner.repository.readSnapshot(),candidate=after.candidates[0],sku=skuOf(candidate),raw=JSON.parse(await readFile(filePath,'utf8'));
  assert.equal(candidate.dataRevision,before.candidates[0].dataRevision+1);
  assert.equal(sku.dataRevision,skuOf(before.candidates[0]).dataRevision+1);
  assert.equal(sku.productionAuthorization.lockedScope.stock,100);
  assert.deepEqual(sku.productionAuthorization.lockedScope.finalCardInputSnapshot,skuOf(before.candidates[0]).c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot);
  assert.ok(nodes(candidate)>BUSINESS_CANDIDATE_MAX_NODES,'The inline DTO must reproduce the original capacity problem');
  assert.throws(()=>assertNoProductionSecrets(candidate,'candidate',{resourceScope:'business_candidate'}),/BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED/);
  assert.doesNotThrow(()=>assertSafeBusinessMutationCandidate(candidate));
  assertSingleEntities(raw);assert.equal(Object.hasOwn(after,'productionEntityRecords'),false);
  const oldJobs=before.runtime.softwareJobs;
  for(const job of oldJobs) assert.deepEqual(after.runtime.softwareJobs.find(row=>row.jobId===job.jobId),job);
  assert.equal(after.runtime.softwareJobs.length,oldJobs.length+1);
  for(const key of ['c1ProductPlan','c2FinalAssets','selectedSupplySnapshot','profitModels']) assert.deepEqual(sku[key],skuOf(before.candidates[0])[key]);
  assert.deepEqual(after.c1FinalPlanRevisionHistoryRecords,before.c1FinalPlanRevisionHistoryRecords);
  assert.equal(after.runtime.operationAudit.length,before.runtime.operationAudit.length+1);
  assert.equal(after.runtime.idempotencyRecords.length,before.runtime.idempotencyRecords.length+1);
  const restarted=createJsonBusinessStateRepository({filePath}),bytes=await readFile(filePath);
  assert.deepEqual(await restarted.readSnapshot(),after);
  const replay=await commitSingleOwnerProductionAuthorization({...owner.args,repository:restarted});
  assert.equal(replay.status,'idempotent_replay');assert.deepEqual(replay.result,results[0].result);
  assert.deepEqual(await readFile(filePath),bytes);assert.equal(fetch.mock.callCount(),0);
  t.diagnostic(`inline authorized candidate ${nodes(candidate)} nodes; stored candidate ${nodes(raw.candidates[0])} nodes; ${raw.productionEntityRecords.length} entities`);
});

test('owner authorization persistence failure writes neither entities nor candidate, job, audit or idempotency changes',async t=>{
  const {owner,filePath,before}=await heavyOwnerFixture(t),bytes=await readFile(filePath);
  let writes=0;
  const repository=createJsonBusinessStateRepository({filePath,atomicWriter:async()=>{writes++;throw new Error('SYNTHETIC_ATOMIC_WRITE_FAILURE');}});
  await assert.rejects(()=>commitSingleOwnerProductionAuthorization({...owner.args,repository}),/SYNTHETIC_ATOMIC_WRITE_FAILURE/);
  assert.equal(writes,1);assert.deepEqual(await readFile(filePath),bytes);assert.deepEqual(await repository.readSnapshot(),before);
});

test('stored production entities reject missing, duplicate, cross-scope, changed identity, secret and altered dependency records on restart',async t=>{
  const {owner,filePath}=await heavyOwnerFixture(t);await commitSingleOwnerProductionAuthorization(owner.args);
  const raw=JSON.parse(await readFile(filePath,'utf8'));
  const misplaced=clone(raw);
  misplaced.candidates[0].body=clone(skuOf(misplaced.candidates[0]).productionAuthorization);
  await writeFile(filePath,JSON.stringify(misplaced));
  const misplacedBytes=await readFile(filePath);
  await assert.rejects(()=>createJsonBusinessStateRepository({filePath}).readSnapshot(),error=>
    error.message.startsWith('RUNTIME_IDENTITY_INVALID:') && error.cause?.message.startsWith('PRODUCTION_AUTHORIZATION_SECRET_REJECTED:'),
  'a legal PA reference under an undeclared body field must not inherit its opaque-ID exception');
  assert.deepEqual(await readFile(filePath),misplacedBytes);
  const mutations=[
    ['null table',d=>d.productionEntityRecords=null],
    ['missing table',d=>delete d.productionEntityRecords],
    ['missing',d=>d.productionEntityRecords=d.productionEntityRecords.filter(row=>row.kind!=='production_authorization')],
    ['duplicate',d=>d.productionEntityRecords.push(clone(d.productionEntityRecords[0]))],
    ['cross candidate',d=>d.productionEntityRecords.find(row=>row.kind==='production_authorization').scope.candidateId='candidate:other'],
    ['cross store',d=>d.productionEntityRecords.find(row=>row.kind==='production_authorization').scope.storeRef.stableStoreId='store:other'],
    ['identity',d=>d.productionEntityRecords.find(row=>row.kind==='production_authorization').value.authorizationId='authorization:other'],
    ['dependency',d=>d.productionEntityRecords.find(row=>row.kind==='production_authorization').value.lockedScope.finalCardInputSnapshot.entityId='final-card-input-snapshot:other'],
    ['secret',d=>d.productionEntityRecords.find(row=>row.kind==='production_authorization').value.password='synthetic-secret-must-reject']
  ];
  for(const [label,mutate] of mutations) {
    const changed=clone(raw);mutate(changed);await writeFile(filePath,JSON.stringify(changed));
    await assert.rejects(()=>createJsonBusinessStateRepository({filePath}).readSnapshot(),undefined,label);
  }
  for(const mutate of [value=>value.resultCandidateRevision++,value=>value.lockedScope.stock++]) {
    const changed=clone(raw);mutate(changed.productionEntityRecords.find(row=>row.kind==='production_authorization').value);
    await writeFile(filePath,JSON.stringify(changed));const bytes=await readFile(filePath);
    await assert.rejects(()=>commitSingleOwnerProductionAuthorization({...owner.args,repository:createJsonBusinessStateRepository({filePath})}));
    assert.deepEqual(await readFile(filePath),bytes);
  }
});

test('heavy saved D job persists a local execution intent and survives restart with zero external transmission',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected external request');});
  const {owner,filePath}=await heavyOwnerFixture(t),f=await savedDProductionJobFixture({owner});
  const before=await f.repository.readSnapshot();
  const intent=createPersistableAliyunOssAssetIntent({candidate:before.candidates[0],expectedDataRevision:before.candidates[0].dataRevision,
    softwareJobRef:{jobId:f.job.jobId,revision:f.job.revision,workerId:f.worker.workerId,leaseId:f.input.softwareJobContext.leaseId},startedAt:owner.formal.at});
  const normalized=normalizeProductionEntities(intent,{candidateId:owner.candidate.id});
  assert.deepEqual(restoreProductionEntities(normalized.value,normalized.records,{candidateId:owner.candidate.id}),intent);
  assert.doesNotThrow(()=>assertSafeRuntimeRecord(intent));
  assert.equal(intent.finalUploadAssetIds.length,15);assert.equal(intent.status,'awaiting_persistence');
  const beforeBytes=await readFile(filePath);
  const failing=createJsonBusinessStateRepository({filePath,atomicWriter:async()=>{throw new Error('SYNTHETIC_D_PERSISTENCE_FAILURE');}});
  await assert.rejects(()=>commitDExecutionIntent({...f.input,repository:failing}),/D_EXECUTION_PERSISTENCE_FAILED/);
  assert.deepEqual(await readFile(filePath),beforeBytes);assert.deepEqual(await f.repository.readSnapshot(),before);
  const admitted=await commitDExecutionIntent(f.input),after=await f.repository.readSnapshot(),raw=JSON.parse(await readFile(filePath,'utf8'));
  assert.equal(after.candidates[0].dataRevision,before.candidates[0].dataRevision+1);
  const state=skuOf(after.candidates[0]).dSoftwareExecution,job=after.runtime.softwareJobs.find(row=>row.jobId===f.job.jobId);
  assert.equal(state.step,'intent_persisted');assert.deepEqual(state.productionPlan,f.input.productionPlan);
  assert.equal(job.externalRequestState,'not_sent');assert.equal(job.externalRequestRef,null);assert.equal(job.status,'claimed');
  assertSingleEntities(raw);assert.equal(raw.productionEntityRecords.filter(row=>row.kind==='production_plan').length,1);
  assert.equal(skuOf(raw.candidates[0]).dSoftwareExecution.productionPlan.schemaVersion,'production-entity-reference-v1');
  const repository=createJsonBusinessStateRepository({filePath}),bytes=await readFile(filePath);
  assert.deepEqual(await repository.readSnapshot(),after);
  const replay=await commitDExecutionIntent({...f.input,repository});assert.equal(replay.status,'idempotent_replay');
  assert.deepEqual(await readFile(filePath),bytes);assert.equal(admitted.status,'committed');
  assert.equal(f.factories(),0);assert.deepEqual(f.calls,[]);assert.equal(fetch.mock.callCount(),0);
});

test('unrelated oversized candidates and production records keep their original resource limits',()=>{
  assert.throws(()=>assertSafeBusinessMutationCandidate({id:'candidate:oversized',values:Array(20001).fill(1)}),/RESOURCE_LIMIT_EXCEEDED/);
  assert.throws(()=>assertSafeRuntimeRecord({values:Array(10001).fill(1)}),error=>error.message.startsWith('RUNTIME_IDENTITY_INVALID:') && error.cause?.message.includes('resource-limit'));
});

test('unrelated repository mutations retain previous inline and referenced authorization encodings exactly',async t=>{
  const owner=productionOwnerDecisionFixture();await commitSingleOwnerProductionAuthorization(owner.args);
  const domain=await owner.repository.readSnapshot();
  const directory=await mkdtemp(path.join(tmpdir(),'production-entity-unchanged-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'legacy-inline.json');await writeFile(filePath,JSON.stringify(domain));
  const repository=createJsonBusinessStateRepository({filePath});
  await repository.transact(document=>{document.meta.title='Synthetic unrelated metadata update';return {changed:true,document,result:null};});
  const inline=JSON.parse(await readFile(filePath,'utf8'));
  assert.equal(Object.hasOwn(inline,'productionEntityRecords'),false);
  assert.deepEqual(inline.candidates,domain.candidates);assert.deepEqual(inline.runtime,domain.runtime);
  assert.equal(skuOf(inline.candidates[0]).productionAuthorization.schemaVersion,'production-authorization-v1.2');
  // A changed production slot is normalized, then unrelated writes preserve its exact stored representation.
  await repository.transact(document=>{document.candidates[0].updatedAt='2026-08-25T09:00:00.000Z';return {changed:true,document,result:null};});
  const referenced=JSON.parse(await readFile(filePath,'utf8'));
  assert.equal(skuOf(referenced.candidates[0]).productionAuthorization.schemaVersion,'production-entity-reference-v1');
  await repository.transact(document=>{document.meta.title='Second unrelated metadata update';return {changed:true,document,result:null};});
  const unchanged=JSON.parse(await readFile(filePath,'utf8'));
  assert.deepEqual(unchanged.candidates,referenced.candidates);assert.deepEqual(unchanged.runtime,referenced.runtime);
  assert.deepEqual(unchanged.productionEntityRecords,referenced.productionEntityRecords);
});

test('pre-authorization C2 candidate and idempotent snapshot persist within the same entity budget', async t => {
  const owner = productionOwnerDecisionFixture(), candidate = clone(owner.candidate);
  const snapshot = skuOf(candidate).c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot;
  assert.equal(skuOf(candidate).productionAuthorization, null);
  // Exercise the aggregate boundary with ordinary JSON metadata, without enlarging any entity.
  candidate.storageBoundaryFixtureValues = Array(20020 - nodes(candidate)).fill('synthetic');
  assert.ok(nodes(candidate) > 20000);
  assert.doesNotThrow(() => assertSafeBusinessMutationCandidate(candidate));
  const directory = await mkdtemp(path.join(tmpdir(), 'c2-entity-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  await writeFile(filePath, JSON.stringify({ candidates: [], runtime: { idempotencyRecords: [] } }));
  const repository = createJsonBusinessStateRepository({ filePath });
  const candidateSnapshot = clone(candidate);
  await repository.transact(document => {
    document.candidates.push(candidate);
    document.runtime.idempotencyRecords.push({ schemaVersion: 'business-idempotency-record-v1', candidateId: candidate.id,
      idempotencyKey: 'synthetic:c2:entity-budget', candidateSnapshot, result: { schemaVersion: 'c1-content-review-result-v1', status: 'confirmed' } });
    return { changed: true, document, result: null };
  });
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(raw.productionEntityRecords.length, 1);
  assert.equal(raw.productionEntityRecords[0].kind, 'final_card_input_snapshot');
  for (const saved of [raw.candidates[0], raw.runtime.idempotencyRecords[0].candidateSnapshot]) {
    assert.ok(nodes(saved) < 20000);
    assert.equal(skuOf(saved).c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.schemaVersion, 'production-entity-reference-v1');
    assert.equal(skuOf(saved).productionAuthorization, null);
  }
  const reopened = createJsonBusinessStateRepository({ filePath });
  assert.deepEqual((await reopened.readSnapshot()).candidates[0], candidate);
  assert.deepEqual((await reopened.readSnapshot()).runtime.idempotencyRecords[0].candidateSnapshot, candidateSnapshot);
  assert.deepEqual(raw.productionEntityRecords[0].value, snapshot);
  const before = await readFile(filePath);
  await reopened.transact(document => ({ changed: false, document, result: null }));
  assert.deepEqual(await readFile(filePath), before);
});

test('pricing predecessor and detached C1 predecessor snapshots are normalized even when current C2 is absent', async t => {
  const owner = productionOwnerDecisionFixture(), previousSkuPackage = clone(skuOf(owner.candidate));
  const candidate = clone(owner.candidate);
  candidate.lifecycleV11.skuPackage.c2FinalAssets = null;
  candidate.lifecycleV11.skuPackage.productionConfirmationCard = null;
  candidate.lifecycleV11.finalPricingRevisionHistory = [{ revisionId: 'final-pricing:synthetic:storage',
    sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: previousSkuPackage.dataRevision,
    previousSkuPackage: clone(previousSkuPackage) }];
  const history = { schemaVersion: 'c1-final-plan-revision-history-v1', preparationId: 'final-plan:synthetic:storage',
    candidateId: candidate.id, sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: previousSkuPackage.dataRevision,
    previousSkuPackage: clone(previousSkuPackage), previousC1References: {} };
  history.previousSkuPackage.storageBoundaryFixtureValues = Array(20020 - nodes(history)).fill('synthetic');
  assert.ok(nodes(history) > 20000);
  assert.doesNotThrow(() => assertSafeBusinessMutationCandidate(history));
  const directory = await mkdtemp(path.join(tmpdir(), 'history-entity-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  await writeFile(filePath, JSON.stringify({ candidates: [], c1FinalPlanRevisionHistoryRecords: [] }));
  const repository = createJsonBusinessStateRepository({ filePath });
  await repository.transact(document => {
    document.candidates.push(candidate); document.c1FinalPlanRevisionHistoryRecords.push(history);
    return { changed: true, document, result: null };
  });
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(raw.productionEntityRecords.length, 1);
  assert.equal(raw.candidates[0].lifecycleV11.finalPricingRevisionHistory[0].previousSkuPackage.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.schemaVersion, 'production-entity-reference-v1');
  const savedHistory = raw.c1FinalPlanRevisionHistoryRecords[0];
  assert.ok(nodes(savedHistory) < 20000);
  assert.equal(savedHistory.previousSkuPackage.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.schemaVersion, 'production-entity-reference-v1');
  const restored = await createJsonBusinessStateRepository({ filePath }).readSnapshot();
  assert.deepEqual(restored.candidates[0], candidate);
  assert.deepEqual(restored.c1FinalPlanRevisionHistoryRecords[0], history);
});

test('unrelated metadata writes retain legacy inline C2 and predecessor records without migration', async t => {
  const candidate = clone(productionOwnerDecisionFixture().candidate);
  const history = { schemaVersion: 'c1-final-plan-revision-history-v1', preparationId: 'final-plan:synthetic:inline',
    candidateId: candidate.id, previousSkuPackage: clone(skuOf(candidate)), previousC1References: {} };
  const document = { meta: { title: 'before' }, candidates: [candidate], c1FinalPlanRevisionHistoryRecords: [history] };
  const directory = await mkdtemp(path.join(tmpdir(), 'inline-c2-history-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json'); await writeFile(filePath, JSON.stringify(document));
  const repository = createJsonBusinessStateRepository({ filePath });
  await repository.transact(current => { current.meta.title = 'after'; return { changed: true, document: current, result: null }; });
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(Object.hasOwn(saved, 'productionEntityRecords'), false);
  assert.deepEqual(saved.candidates, document.candidates);
  assert.deepEqual(saved.c1FinalPlanRevisionHistoryRecords, document.c1FinalPlanRevisionHistoryRecords);
});
