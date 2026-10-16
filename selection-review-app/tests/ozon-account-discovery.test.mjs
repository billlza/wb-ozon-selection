import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createOzonAccountDiscoveryServices } from '../lib/ozon-account-discovery-services.mjs';
import { assertOzonAccountPreparation, createOzonAccountDiscoveryScope, assertOzonAccountReadScope, assertOzonAccountReadReceipt } from '../lib/ozon-account-read-contract.mjs';
import { buildOzonAccountReadRequest, normalizeOzonAccountReadResponse } from '../lib/ozon-account-read-api.mjs';
const T='2026-09-08T00:00:00.000Z';
const actor=createActorContext({userId:'owner:synthetic',sessionId:'session:synthetic',actorType:'human',roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:T});
const binding={scopeRef:'discovery:synthetic',bindingId:'binding:synthetic',configurationVersion:'config:synthetic',platform:'ozon',targetStore:'miska',storeIdentityStatus:'unverified',credentialAlias:'alias:synthetic',clientIdRef:'client:synthetic',officialContractRefs:{roles:'official:roles',seller_info:'official:seller',warehouse_list:'official:warehouse'}};
const preparation={schemaVersion:'ozon-account-preparation-v1',preparationId:'preparation:synthetic',revision:0,createdByUserId:actor.userId,createdAt:T,updatedAt:T,binding,warehouseSelections:[]};
function scope(){return createOzonAccountDiscoveryScope({preparation,binding,authorizationRef:'permission:synthetic',expiresAt:'2026-09-08T01:00:00.000Z'});}
const row={warehouse_id:10001,name:'合成仓库',is_rfbs:true,status:'created',warehouse_type:'RFBS',pause_at:null,address:'DO_NOT_SAVE_ADDRESS',phone:'DO_NOT_SAVE_PHONE'};
const responses={'/v1/roles':{expires_at:'2027-01-01T00:00:00Z',roles:[{name:'Admin',methods:['/v1/roles','/v1/seller/info','/v2/warehouse/list']}]},'/v1/seller/info':{company:{currency:'CNY',inn:'DO_NOT_SAVE_TAX'}},'/v2/warehouse/list':{has_next:true,warehouses:[row]}};
function setup({request}={}){
  let now=T,calls=0;
  const repository=createMemoryBusinessStateRepository({candidates:[],runtime:{}}),serverClock=()=>now,workerRegistry=createLocalDevelopmentWorkerRegistry({clock:serverClock});
  const service=createOzonAccountDiscoveryServices({repository,serverClock,workerRegistry,worker:{workerId:'worker:discovery',version:'worker:1',leaseDurationMs:10000},
    listBindings:()=>[{...binding,storeName:'合成账户',clientId:'123456'}],loadCurrentReadBinding:()=>structuredClone(binding),requestJson:async(req,options)=>{
      calls++;if(request)return request(req,options,{repository});await options.beforeRequestSend();return structuredClone(responses[req.endpoint]);
    }});
  return {service,repository,serverClock,workerRegistry,get calls(){return calls;},setNow:value=>now=value};
}
async function create(f){return f.service.createPreparation({actor,input:{bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,idempotencyKey:'create:synthetic'}});}
async function run(f){const {preparation:p}=await create(f);const input={preparationId:p.preparationId,expectedRevision:0,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,expiresAt:'2026-09-08T01:00:00.000Z',confirmReadOnce:true,idempotencyKey:'authorize:synthetic'};return {outcome:await f.service.authorizeAndRun({actor,input}),input};}

test('discovery source is real preparation with a closed separate scope and exact bounded request',()=>{
  assertOzonAccountPreparation(preparation);const source=scope();assertOzonAccountReadScope(source);
  assert.equal(Object.hasOwn(source,'candidateId'),false);assert.equal(Object.hasOwn(source,'skuPackageId'),false);assert.equal(Object.hasOwn(source,'storeRef'),false);
  const request=buildOzonAccountReadRequest({scope:source,method:'warehouse_list',executionKey:'execution:synthetic'});
  assert.deepEqual(request.body,{limit:20});assert.deepEqual(request.subject,{kind:'account_preparation',preparationId:preparation.preparationId,revision:0});assert.equal(request.write,false);
  for(const mutation of [value=>value.candidateId='fake',value=>value.warehouseLimit=200,value=>value.storeIdentityStatus='verified',value=>value.subject.revision=1]){const bad=structuredClone(source);mutation(bad);assert.throws(()=>assertOzonAccountReadScope(bad));}
});
test('discovery keeps bounded named partial list without private fields or auto selection; null and missing remain distinct',()=>{
  const normalize=response=>normalizeOzonAccountReadResponse({method:'warehouse_list',scope:scope(),observedAt:T,officialContractRef:binding.officialContractRefs.warehouse_list,response});
  const result=normalize(responses['/v2/warehouse/list']);assert.equal(result.status,'observed');assert.equal(result.facts.hasNext,true);assert.equal(result.facts.warehouses[0].name,row.name);assert.equal(JSON.stringify(result).includes('DO_NOT_SAVE'),false);
  assert.equal(normalize({has_next:false,warehouses:[]}).status,'observed');
  const missing=structuredClone(row);delete missing.name;assert.equal(normalize({has_next:false,warehouses:[missing]}).status,'data_unavailable');
  assert.throws(()=>normalize({has_next:false,warehouses:[{...row,name:null}]}),/RESPONSE_INVALID/);
  for(const warehouse_id of [Number.MAX_SAFE_INTEGER+1,'10001',0,-1,1.5])assert.throws(()=>normalize({has_next:false,warehouses:[{...row,warehouse_id}]}),/RESPONSE_INVALID/);
  assert.throws(()=>normalize({has_next:false,warehouses:[row,row]}),/DUPLICATE_WAREHOUSE_ID/);
  assert.throws(()=>normalize({has_next:false,warehouses:Array.from({length:21},(_,i)=>({...row,warehouse_id:i+1}))}),/RESPONSE_LIMIT_EXCEEDED/);
  const incomplete=normalize({has_next:false,warehouses:Array.from({length:20},()=>({}))});assert.equal(incomplete.status,'data_unavailable');assert.ok(incomplete.gaps.length<=30);
});
test('create and view make zero jobs or requests, idempotent creation preserves the independent entity',async()=>{
  const f=setup();const empty=f.service.view({document:await f.repository.readSnapshot(),actor});assert.deepEqual(empty.preparations,[]);assert.equal(f.calls,0);
  const created=await create(f),replay=await create(f);assert.deepEqual(created,replay);assert.equal(created.preparation.revision,0);assert.equal(created.externalRequests,0);
  const document=await f.repository.readSnapshot();assert.deepEqual(document.candidates,[]);assert.equal(document.runtime.softwareJobs,undefined);assert.equal(f.calls,0);
  await assert.rejects(()=>f.service.createPreparation({actor,input:{bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,idempotencyKey:'another:key'}}),/PREPARATION_ALREADY_EXISTS/);
});
test('independent job consumes one explicit permission and completes three reads, preserving no SKU and no automatic warehouse choice',async()=>{
  const f=setup(),{outcome,input}=await run(f);assert.equal(outcome.status,'completed');assert.equal(f.calls,3);assert.equal(outcome.job.schemaVersion,'software-job-v2');
  assert.equal(Object.hasOwn(outcome.job,'candidateId'),false);assert.equal(Object.hasOwn(outcome.job,'skuPackageId'),false);assertOzonAccountReadReceipt(outcome.receipt,outcome.job);
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount,1);assert.deepEqual(saved.candidates,[]);
  assert.deepEqual(saved.runtime.ozonAccountPreparations[input.preparationId].warehouseSelections,[]);assert.equal(JSON.stringify(saved).includes('DO_NOT_SAVE'),false);
  await f.service.authorizeAndRun({actor,input});assert.equal(f.calls,3);
  await assert.rejects(()=>f.service.authorizeAndRun({actor,input:{...input,idempotencyKey:'another:read'}}),/REFRESH_NOT_SUPPORTED/);assert.equal(f.calls,3);
});
test('warehouse decision is source-bound append-only local persistence and never verifies the store',async()=>{
  const f=setup(),{outcome,input}=await run(f),view=f.service.view({document:await f.repository.readSnapshot(),actor}),item=view.preparations[0];
  assert.equal(item.hasNext,true);assert.equal(item.canSelectWarehouse,true);
  const selection={preparationId:input.preparationId,expectedRevision:0,sourceJobId:outcome.job.jobId,sourceReceiptId:outcome.receipt.receiptId,warehouseId:'10001',idempotencyKey:'selection:1'};
  await assert.rejects(()=>f.service.selectWarehouse({actor,input:{...selection,warehouseId:'99999'}}),/WAREHOUSE_NOT_OBSERVED/);
  await assert.rejects(()=>f.service.selectWarehouse({actor,input:{...selection,sourceReceiptId:'unrelated:receipt'}}),/SOURCE_RECEIPT_CONFLICT/);
  const selected=await f.service.selectWarehouse({actor,input:selection});assert.equal(selected.preparation.revision,1);assert.equal(selected.preparation.binding.storeIdentityStatus,'unverified');
  assert.equal(selected.preparation.warehouseSelections[0].sourceRevision,0);assert.equal(selected.preparation.warehouseSelections[0].warehouse.name,row.name);assert.equal(f.calls,3);
  assert.deepEqual(await f.service.selectWarehouse({actor,input:selection}),selected);
  await assert.rejects(()=>f.service.authorizeAndRun({actor,input:{...input,expectedRevision:1,idempotencyKey:'after:selection'}}),/REFRESH_NOT_SUPPORTED/);assert.equal(f.calls,3);
});
test('selection refuses expired or unconsumed source and a different owner',async()=>{
  const f=setup(),{outcome,input}=await run(f),selection={preparationId:input.preparationId,expectedRevision:0,sourceJobId:outcome.job.jobId,sourceReceiptId:outcome.receipt.receiptId,warehouseId:'10001',idempotencyKey:'selection:1'};
  const other={...actor,userId:'owner:other'};await assert.rejects(()=>f.service.selectWarehouse({actor:other,input:selection}),/OWNER_CONFLICT/);
  f.setNow('2026-09-08T01:00:00.000Z');await assert.rejects(()=>f.service.selectWarehouse({actor,input:selection}),/SOURCE_EXPIRED/);
  f.setNow(T);await f.repository.transact(document=>{Object.assign(document.runtime.softwareJobAuthorizationRecords[0],{useCount:0,consumedByJobId:null,consumedAt:null});return {changed:true,document};});
  await assert.rejects(()=>f.service.selectWarehouse({actor,input:selection}),/SOURCE_PERMISSION_CONFLICT/);assert.equal(f.calls,3);
});
test('with team accounts one boss\'s preparation is the team\'s: the tester sees it, reads the account under their own permit and picks the warehouse',async()=>{
  const member=(userId,roles)=>createActorContext({userId,sessionId:`team-session:${roles[0]}`,actorType:'human',roles,source:'authenticated_identity_provider',authenticatedAt:T});
  const boss=member('team-user:00000000-0000-4000-8000-000000000001',['owner']),tester=member('local-owner:00000000-0000-4000-8000-000000000003',['operator']);
  const f=setup(),ids={bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef};
  const {preparation:p}=await f.service.createPreparation({actor:boss,input:{...ids,idempotencyKey:'create:boss'}});
  assert.deepEqual(f.service.view({document:await f.repository.readSnapshot(),actor:tester}).preparations.map(item=>item.preparation.preparationId),[p.preparationId]);
  // One preparation per account for the whole team.
  await assert.rejects(()=>f.service.createPreparation({actor:tester,input:{...ids,idempotencyKey:'create:tester'}}),/PREPARATION_ALREADY_EXISTS/);
  const input={preparationId:p.preparationId,expectedRevision:0,...ids,expiresAt:'2026-09-08T01:00:00.000Z',confirmReadOnce:true,idempotencyKey:'read:tester'};
  const outcome=await f.service.authorizeAndRun({actor:tester,input});assert.equal(outcome.status,'completed');assert.equal(f.calls,3);
  const saved=await f.repository.readSnapshot();
  // The paid read stays the tester's: they asked for it, own the job and gave its permit.
  assert.deepEqual([outcome.job.ownerUserId,outcome.job.requestedByUserId,saved.runtime.softwareJobAuthorizationRecords[0].authorizedByUserId],[tester.userId,tester.userId,tester.userId]);
  assert.equal(saved.runtime.ozonAccountPreparations[p.preparationId].createdByUserId,boss.userId);
  const selected=await f.service.selectWarehouse({actor:tester,input:{preparationId:p.preparationId,expectedRevision:0,sourceJobId:outcome.job.jobId,sourceReceiptId:outcome.receipt.receiptId,warehouseId:'10001',idempotencyKey:'selection:tester'}});
  assert.deepEqual([selected.preparation.revision,selected.preparation.warehouseSelections[0].selectedByUserId],[1,tester.userId]);
  assert.equal(f.service.view({document:await f.repository.readSnapshot(),actor:boss}).preparations[0].preparation.revision,1);
  // Anyone outside the team (here a person whose id is not a team account's) still sees nothing of it and cannot read it.
  assert.deepEqual(f.service.view({document:await f.repository.readSnapshot(),actor}).preparations,[]);
  await assert.rejects(()=>f.service.authorizeAndRun({actor,input:{...input,expectedRevision:1,idempotencyKey:'read:outsider'}}),/OWNER_CONFLICT/);
});
test('wrong or missing explicit permission creates no queued job and no external call',async()=>{
  const f=setup(),{preparation:p}=await create(f);
  const input={preparationId:p.preparationId,expectedRevision:0,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,expiresAt:'2026-09-08T01:00:00.000Z',confirmReadOnce:false,idempotencyKey:'read:invalid'};
  await assert.rejects(()=>f.service.authorizeAndRun({actor,input}),/INPUT_INVALID/);
  await assert.rejects(()=>f.service.authorizeAndRun({actor:{...actor,userId:'other:owner'},input:{...input,confirmReadOnce:true}}),/OWNER_CONFLICT/);
  assert.equal(f.calls,0);assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs,undefined);
});
test('changing the preparation owner before response persistence retains response and stops further reads',async()=>{
  const f=setup({request:async(req,options,{repository})=>{await options.beforeRequestSend();await repository.transact(document=>{
    const p=Object.values(document.runtime.ozonAccountPreparations)[0];p.createdByUserId='owner:other';return {changed:true,document};});return structuredClone(responses[req.endpoint]);}});
  const {outcome}=await run(f);assert.equal(outcome.status,'failed');assert.equal(outcome.job.externalRequestState,'succeeded');assert.equal(f.calls,1);assert.match(outcome.receipt.failureClass,/OWNER_CONFLICT/);assert.equal(outcome.receipt.steps[0].result.status,'observed');
});
test('published v2 definitions require discovery subject while old v1 rejects it',async()=>{
  const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs');const validator=await loadPublishedSchemaValidator();
  const f=setup(),{outcome}=await run(f),doc=await f.repository.readSnapshot();
  for(const [name,value] of [['scope',scope()],['preparation',Object.values(doc.runtime.ozonAccountPreparations)[0]],['receipt',outcome.receipt],['authorization',doc.runtime.softwareJobAuthorizationRecords[0]],['credential',doc.runtime.softwareJobCredentialBindings[0]]]){
    const validate=validator.getSchema(`ozon-account-read-v2.schema.json#/$defs/${name}`);assert.equal(validate(value),true,JSON.stringify(validate.errors));
  }
  const legacy=validator.getSchema('ozon-account-read-v1.schema.json#/$defs/scope');assert.equal(legacy(scope()),false);
});
test('actual discovery queued, claimed, completed and failed jobs satisfy v2 and reject mixed legacy identity',async()=>{
  const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs');
  const {createOzonAccountReadRuntime}=await import('../lib/ozon-account-read-runtime.mjs');
  const validator=await loadPublishedSchemaValidator(),validate=validator.getSchema('software-job-v2.schema.json'),snapshots=[];
  for(const failure of [false,true]){
    const repository=createMemoryBusinessStateRepository({candidates:[],runtime:{ozonAccountPreparations:{[preparation.preparationId]:preparation}}}),workerRegistry=createLocalDevelopmentWorkerRegistry({clock:()=>T});
    const runtime=createOzonAccountReadRuntime({repository,workerRegistry,serverClock:()=>T,worker:{workerId:'worker:discovery',version:'worker:1',leaseDurationMs:10000},
      loadCurrentReadBinding:()=>structuredClone(binding),subjectKind:'account_preparation',requestJson:async(req,options)=>{
        snapshots.push((await repository.readSnapshot()).runtime.softwareJobs[0]);await options.beforeRequestSend();return failure?{}:structuredClone(responses[req.endpoint]);}});
    const input={preparationId:preparation.preparationId,expectedRevision:0,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,confirmReadOnce:true,expiresAt:'2026-09-08T01:00:00.000Z',idempotencyKey:'read:schema'};
    const queued=await runtime.authorizeAndEnqueue({actor,input});snapshots.push(queued.job);
    snapshots.push((await runtime.continueSaved({preparationId:preparation.preparationId,jobId:queued.job.jobId,expectedRevision:0})).job);
  }
  for(const status of ['queued','claimed','completed','failed'])assert.ok(snapshots.some(job=>job.status===status),status);
  for(const job of snapshots){
    assert.equal(validate(job),true,`${job.status}: ${JSON.stringify(validate.errors)}`);
    for(const alter of [value=>value.candidateId='fake:candidate',value=>value.subject.kind='candidate_sku',value=>delete value.subject.preparationId,value=>value.subject.revision=-1]){
      const bad=structuredClone(job);alter(bad);assert.equal(validate(bad),false);
    }
    const wrong=structuredClone(job);wrong.subject.preparationId='wrong:preparation';assert.throws(()=>assertOzonAccountReadScope(wrong.scopeBinding,wrong),/JOB_SOURCE_CONFLICT/);
    const wrongRevision=structuredClone(job);wrongRevision.subject.revision++;assert.throws(()=>assertOzonAccountReadScope(wrongRevision.scopeBinding,wrongRevision),/JOB_SOURCE_CONFLICT/);
  }
});
for(const phase of ['before_send','after_send'])test(`discovery restart ${phase} retains partial evidence and never repeats the consumed permission`,async()=>{
  const {createRepositoryBackedSoftwareJobStore}=await import('../lib/software-job-repository.mjs');const interrupted=new Error('synthetic process stopped');
  const f=setup({request:async(req,options)=>{
    if(req.endpoint==='/v1/seller/info'){if(phase==='after_send')await options.beforeRequestSend();throw interrupted;}
    await options.beforeRequestSend();return structuredClone(responses[req.endpoint]);
  }});
  await assert.rejects(()=>run(f),error=>error===interrupted);assert.equal(f.calls,2);
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:f.repository,serverClock:f.serverClock,workerRegistry:f.workerRegistry});await store.reconcileAfterRestart();
  const document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs[0],receipt=document.runtime.ozonAccountReadReceipts[job.jobId];
  assert.equal(receipt.steps[0].result.status,'observed');assert.equal(job.status,phase==='after_send'?'unknown_outcome':'failed');
  assert.equal(job.externalRequestState,phase==='after_send'?'unknown_outcome':'succeeded');
  await f.service.continueSavedRead({actor,input:{preparationId:job.subject.preparationId,jobId:job.jobId,expectedRevision:0}});assert.equal(f.calls,2);
  assert.deepEqual(document.candidates,[]);assert.equal(document.runtime.softwareJobAuthorizationRecords[0].useCount,1);
});
