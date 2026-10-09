import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {threeColorFixture} from './fixtures/sibling-batch-final-family-fixture.mjs';
import {startSavedDEApi} from './helpers/d-e-saved-api-fixture.mjs';
import {allocatedTestPorts} from './helpers/api-process-lifecycle.mjs';
import {createPreparationValues,preparationDraftScopeCurrent,preparationValuesEqual} from '../src/siblingPreparationState.js';
import {createJsonBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {writeSyntheticSiblingPreparationCatalog} from './fixtures/sibling-preparation-catalog-fixture.mjs';

const {api:port}=allocatedTestPorts();

async function startPreparationApi(t,identityProvider='local_owner_password') {
 const fixture=await threeColorFixture(),document=await fixture.repository.readSnapshot(),parent=document.candidates[0];
 for(const child of document.candidates.slice(1))delete child.targetPlatform;
 const directory=await mkdtemp(path.join(tmpdir(),'s1-preparation-api-'));
 const catalog=await writeSyntheticSiblingPreparationCatalog({document,tempDir:directory});
 const api=await startSavedDEApi(t,{directory,port,document,binding:{storeRef:parent.storeRef,platform:parent.targetPlatform},productionBindings:[],catalogDirectory:directory,identityProvider});
 const route=`/api/sibling-batches/${encodeURIComponent(parent.id)}`;
 return {api,document,parent,catalog,route};
}

function assertBusinessUnchanged(before,after) {
 assert.equal(after.candidates.length,before.candidates.length);
 for(const [i,candidate] of after.candidates.entries()) {
  const original=structuredClone(before.candidates[i]),current=structuredClone(candidate);
  delete original.siblingPreparationDraftRefV1;delete current.siblingPreparationDraftRefV1;
  assert.deepEqual(current,original);
  assert.equal(candidate.dataRevision,before.candidates[i].dataRevision);
  assert.deepEqual(candidate.lifecycleV11,before.candidates[i].lifecycleV11);
 }
 assert.deepEqual(after.runtime.softwareJobs,before.runtime.softwareJobs);
 assert.deepEqual(after.runtime.idempotencyRecords,before.runtime.idempotencyRecords);
 assert.deepEqual(after.dispatches,before.dispatches);
}

function assertDraftReferences(document,draft) {
 assert.equal(draft.productionAuthorizationGranted,false);
 for(const member of draft.memberRevisions) {
  const candidate=document.candidates.find(c=>c.id===member.candidateId);
  assert.ok(candidate);
  assert.deepEqual(candidate.siblingPreparationDraftRefV1,{parentCandidateId:draft.parentCandidateId,
   draftRevision:draft.draftRevision,inputFingerprint:draft.inputFingerprint});
 }
}

test('real isolated API requires owner, persists/reloads all three colors, rejects conflicts and saves one draft per version without jobs or shop traffic',async t=>{
 const {api,document,parent,catalog,route}=await startPreparationApi(t);
 const originalBytes=await api.readBytes();
 assert.equal((await api.get(route+'/preparation')).status,401);
 assert.deepEqual(await api.readBytes(),originalBytes);
 await api.authenticate();
 const read=await api.get(route+'/preparation');assert.equal(read.status,200);assert.equal(read.body.configured,true);assert.equal(read.body.draft,null);
 assert.deepEqual(read.body.catalog,catalog);assert.equal(catalog.assets.length,18);assert.equal(catalog.assets.filter(a=>a.kind==='finished').length,15);assert.deepEqual(catalog.assets.filter(a=>a.kind==='owner_color_exception').map(a=>[a.assetId,a.onlySourceSkuId]),[['16',catalog.supplierSkuIds[0]],['30',catalog.supplierSkuIds[1]],['18',catalog.supplierSkuIds[2]]]);
 assert.deepEqual(await api.readDocument(),document);assert.ok(read.body.supplyPreparation);
 const values=createPreparationValues(read.body.catalog,parent,document.candidates.slice(1));values.shared.titleRu='synthetic edited draft';
 values.page=2;
 const orders=[['16','27','19'],['30','17','27','19'],['18','24','29','19']];
 for(const [i,member] of values.members.entries()) {member.order=orders[i];member.hero=orders[i][0];}
 values.members[0].overrides.titleRu='synthetic black-cp title';
 values.members[1].overrides.stock='21';
 values.members[2].overrides.descriptionZh='';
 const input={parentCandidateId:parent.id,parentRevision:parent.dataRevision,memberRevisions:document.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),expectedDraftRevision:0,idempotencyKey:'synthetic:api:save',values};
 const before=await api.readDocument();assert.ok(Array.isArray(before.runtime.operationAudit));
 const beforeSaveBytes=await api.readBytes();
 const unauthenticated=await api.post(route+'/preparation-draft',input,{authenticated:false,
  headers:{'x-user-id':'synthetic-owner','x-session-id':'synthetic-session','x-user-role':'owner'}});
 assert.equal(unauthenticated.status,401,JSON.stringify(unauthenticated.body));
 assert.deepEqual(await api.readBytes(),beforeSaveBytes);
 assert.equal((await api.post(route+'/preparation-draft',input,{headers:{Origin:'https://untrusted.example'}})).status,403);
 assert.deepEqual(await api.readBytes(),beforeSaveBytes);

 const saves=await Promise.all([api.post(route+'/preparation-draft',input),api.post(route+'/preparation-draft',input)]);
 for(const save of saves) {
  assert.equal(save.status,200,JSON.stringify(save.body));assert.equal(save.body.draft.draftRevision,1);
  assert.deepEqual(save.body.draft.values,values);assert.equal(save.body.externalRequests,0);assert.equal(save.body.platformWrites,0);
 }
 assert.deepEqual(saves[0].body,saves[1].body);
 const firstDraft=saves[0].body.draft,saved=await api.readDocument(),stored=await api.readStoredDocument();
 assertBusinessUnchanged(before,saved);assertDraftReferences(saved,firstDraft);
 assert.deepEqual(saved.candidates[0],before.candidates[0]);
 assert.deepEqual(stored.runtime.siblingPreparationDrafts,[firstDraft]);
 assert.equal(stored.runtime.operationAudit.length,before.runtime.operationAudit.length+1);
 assert.deepEqual(stored.runtime.operationAudit.slice(0,-1),before.runtime.operationAudit);
 assert.deepEqual(stored.runtime.operationAudit.at(-1),{eventId:`audit:sibling-preparation:${parent.id}:1`,
  action:'save_sibling_preparation_draft',actorId:firstDraft.savedBy,candidateId:parent.id,
  sourceRevision:parent.dataRevision,draftRevision:1,at:firstDraft.savedAt,platformWrites:0});
 const firstBytes=await api.readBytes(),firstRead=await api.get(route+'/preparation');
 assert.equal(firstRead.status,200);assert.deepEqual(firstRead.body.draft,firstDraft);
 assert.deepEqual(firstRead.body.draft.values.members.map(m=>m.order),orders);
 assert.deepEqual(firstRead.body.draft.values.members.map(m=>m.hero),['16','30','18']);
 assert.deepEqual(firstRead.body.draft.values.members.map(m=>m.sourceSkuId),values.members.map(m=>m.sourceSkuId));
 assert.deepEqual(await api.readBytes(),firstBytes);
 const replay=await api.post(route+'/preparation-draft',input);assert.equal(replay.status,200);
 assert.deepEqual(replay.body,saves[0].body);assert.deepEqual(await api.readBytes(),firstBytes);
 const conflict=await api.post(route+'/preparation-draft',{...input,idempotencyKey:'synthetic:api:conflict'});
 assert.equal(conflict.status,409);assert.equal(conflict.body.code,'SIBLING_PREPARATION_DRAFT_CONFLICT');
 assert.deepEqual(await api.readBytes(),firstBytes);
 const changedPayload=structuredClone(input);changedPayload.values.shared.titleRu='changed payload under the same key';
 const changedReplay=await api.post(route+'/preparation-draft',changedPayload);
 assert.equal(changedReplay.status,409);assert.equal(changedReplay.body.code,'SIBLING_PREPARATION_REPLAY_CONFLICT');
 assert.deepEqual(await api.readBytes(),firstBytes);

 const competingInputs=['a','b'].map((key,i)=>{
  const next=structuredClone(input);next.expectedDraftRevision=1;next.idempotencyKey=`synthetic:api:race:${key}`;
  next.values.members[0].overrides.stock=String(31+i);return next;
 });
 const competitors=await Promise.all(competingInputs.map(next=>api.post(route+'/preparation-draft',next)));
 assert.deepEqual(competitors.map(result=>result.status).sort((a,b)=>a-b),[200,409]);
 const winnerIndex=competitors.findIndex(result=>result.status===200),winner=competitors[winnerIndex];
 const loser=competitors.find(result=>result.status===409);
 assert.equal(loser.body.code,'SIBLING_PREPARATION_DRAFT_CONFLICT');
 assert.equal(winner.body.draft.draftRevision,2);assert.deepEqual(winner.body.draft.values,competingInputs[winnerIndex].values);
 assert.equal(winner.body.externalRequests,0);assert.equal(winner.body.platformWrites,0);
 const latest=await api.readDocument(),latestStored=await api.readStoredDocument();
 assertBusinessUnchanged(before,latest);assertDraftReferences(latest,winner.body.draft);
 assert.deepEqual(latest.candidates[0],before.candidates[0]);
 assert.deepEqual(latestStored.runtime.siblingPreparationDrafts,[firstDraft,winner.body.draft]);
 assert.equal(latestStored.runtime.operationAudit.length,before.runtime.operationAudit.length+2);
 assert.deepEqual(latestStored.runtime.operationAudit.slice(0,-1),stored.runtime.operationAudit);
 assert.equal(latestStored.runtime.operationAudit.at(-1).eventId,`audit:sibling-preparation:${parent.id}:2`);
 assert.equal(latestStored.runtime.operationAudit.at(-1).action,'save_sibling_preparation_draft');
 const latestBytes=await api.readBytes(),latestRead=await api.get(route+'/preparation');
 assert.equal(latestRead.status,200);assert.deepEqual(latestRead.body.draft,winner.body.draft);
 assert.deepEqual(await api.readBytes(),latestBytes);

 await api.restart();await api.authenticate('login');
 const restarted=await api.get(route+'/preparation');assert.equal(restarted.status,200);
 assert.deepEqual(restarted.body.draft,winner.body.draft);assert.deepEqual(restarted.body.draft.values,competingInputs[winnerIndex].values);
 assert.equal(restarted.body.draft.values.shared.titleRu,'synthetic edited draft');
 assert.deepEqual(await api.readStoredDocument(),latestStored);assert.deepEqual(await api.readBytes(),latestBytes);
 const winnerReplay=await api.post(route+'/preparation-draft',competingInputs[winnerIndex]);
 assert.equal(winnerReplay.status,200);assert.deepEqual(winnerReplay.body,winner.body);
 const historicalReplay=await api.post(route+'/preparation-draft',input);
 assert.equal(historicalReplay.status,200);assert.deepEqual(historicalReplay.body,saves[0].body);
 const stale=await api.post(route+'/preparation-draft',{...input,idempotencyKey:'synthetic:api:stale',expectedDraftRevision:2,parentRevision:parent.dataRevision+1});
 assert.equal(stale.status,409);assert.equal(stale.body.code,'SIBLING_PREPARATION_SOURCE_CHANGED');
 assert.deepEqual(await api.readDocument(),latest);assert.deepEqual(await api.readBytes(),latestBytes);
 assert.deepEqual((await api.get(route+'/preparation')).body.draft,winner.body.draft);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('development-default read-only identity cannot read or save preparation even with owner headers',async t=>{
 const {api,document,parent,catalog,route}=await startPreparationApi(t,'development_default');
 const before=await api.readBytes(),values=createPreparationValues(catalog,parent,document.candidates.slice(1));
 const input={parentCandidateId:parent.id,parentRevision:parent.dataRevision,
  memberRevisions:document.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),
  expectedDraftRevision:0,idempotencyKey:'synthetic:api:read-only',values};
 const read=await api.get(route+'/preparation');assert.equal(read.status,403,JSON.stringify(read.body));
 assert.deepEqual(await api.readBytes(),before);
 const rejected=await api.post(route+'/preparation-draft',input,{authenticated:false,
  headers:{'x-user-id':'synthetic-owner','x-session-id':'synthetic-session','x-user-role':'owner'}});
 assert.equal(rejected.status,403,JSON.stringify(rejected.body));
 assert.deepEqual(await api.readBytes(),before);assert.deepEqual(await api.readDocument(),document);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('unchanged values can be saved against refreshed parent and member revisions as one new draft',async t=>{
 const {api,document,parent,catalog,route}=await startPreparationApi(t);
 await api.authenticate();
 const values=createPreparationValues(catalog,parent,document.candidates.slice(1));
 const input={parentCandidateId:parent.id,parentRevision:parent.dataRevision,
  memberRevisions:document.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),
  expectedDraftRevision:0,idempotencyKey:'synthetic:api:scope:initial',values};
 const first=await api.post(route+'/preparation-draft',input);
 assert.equal(first.status,200,JSON.stringify(first.body));
 const repository=createJsonBusinessStateRepository({filePath:api.dataFile});
 await repository.transact(state=>{
  state.candidates[0].dataRevision+=1;
  state.candidates[1].dataRevision+=1;
  return {changed:true,document:state,result:null};
 });
 const changed=await api.readDocument(),currentParent=changed.candidates[0],members=changed.candidates.slice(1);
 assert.equal(preparationDraftScopeCurrent(first.body.draft,currentParent,members,catalog),false);
 const next={...input,parentRevision:currentParent.dataRevision,
  memberRevisions:members.map(c=>({candidateId:c.id,revision:c.dataRevision})),
  expectedDraftRevision:1,idempotencyKey:'synthetic:api:scope:current'};
 const saved=await api.post(route+'/preparation-draft',next);
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.equal(saved.body.draft.draftRevision,2);
 assert.equal(preparationValuesEqual(saved.body.draft.values,first.body.draft.values),true);
 assert.equal(preparationDraftScopeCurrent(saved.body.draft,currentParent,members,catalog),true);
 assertBusinessUnchanged(changed,await api.readDocument());
 assert.deepEqual((await api.get(route+'/preparation')).body.draft,saved.body.draft);
 const stored=await api.readBytes();
 assert.deepEqual((await api.post(route+'/preparation-draft',next)).body,saved.body);
 assert.deepEqual(await api.readBytes(),stored);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});
