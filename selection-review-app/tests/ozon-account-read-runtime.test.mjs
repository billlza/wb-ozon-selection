import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createOzonAccountReadRuntime } from '../lib/ozon-account-read-runtime.mjs';
import { assertOzonAccountReadReceipt, readOzonAccountReadTerminal } from '../lib/ozon-account-read-contract.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../lib/software-job-repository.mjs';
const T='2026-09-08T00:00:00.000Z';
const actor=createActorContext({userId:'owner:1',sessionId:'session:1',actorType:'human',roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:T});
const storeRef={stableStoreId:'dandanshu',platformStoreId:'synthetic-store:1',mappingVersion:'mapping:1'};
const binding={scopeRef:'account-scope:1',bindingId:'binding:1',configurationVersion:'config:1',platform:'ozon',storeRef,warehouseRef:'warehouse:1',warehouseId:'10001',credentialAlias:'credential-alias:1',clientIdRef:'client-config:1',officialContractRefs:{roles:'official:roles:1',seller_info:'official:seller:1',warehouse_list:'official:warehouse:1'}};
const responses={
 '/v1/roles':{expires_at:'2027-01-01T00:00:00Z',roles:[{name:'Admin',methods:['/v3/product/import','/v1/*']}]},
 '/v1/seller/info':{company:{currency:'CNY',inn:'DO_NOT_PERSIST_PRIVATE_VALUE'}},
 '/v2/warehouse/list':{has_next:false,warehouses:[{warehouse_id:10001,is_rfbs:true,status:'created',warehouse_type:'RFBS',pause_at:null}]}
};
function setup({request,leaseDurationMs=10000,revision=0,bindingResolver}={}){
 let now=T,calls=0,clockOverride=null;
 const candidate={id:'candidate:1',dataRevision:revision,targetPlatform:'ozon',targetStore:'dandanshu',storeRef,lifecycleV11:{skuPackage:{skuPackageId:'sku:1',supplierSkuId:'supplier:1',targetPlatform:'ozon',targetStore:'dandanshu'}}};
 const repository=createMemoryBusinessStateRepository({candidates:[candidate],runtime:{}}),serverClock=()=>clockOverride===null?now:clockOverride();
 const workerRegistry=createLocalDevelopmentWorkerRegistry({clock:serverClock});
 const runtime=createOzonAccountReadRuntime({repository,serverClock,workerRegistry,worker:{workerId:'worker:account',version:'worker-version:1',leaseDurationMs},loadCurrentReadBinding:bindingResolver??(({bindingId,configurationVersion})=>{
  assert.equal(bindingId,binding.bindingId);assert.equal(configurationVersion,binding.configurationVersion);return structuredClone(binding);
 }),requestJson:async(req,options)=>{calls++;if(request)return request(req,options,{repository,setNow:value=>now=value,calls,setClock:value=>clockOverride=value});await options.beforeRequestSend();assert.ok(Object.hasOwn(responses,req.endpoint),req.endpoint);return structuredClone(responses[req.endpoint]);}});
 const input={candidateId:candidate.id,skuPackageId:'sku:1',expectedRevision:revision,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,confirmReadOnce:true,expiresAt:'2026-09-08T01:00:00.000Z',idempotencyKey:'owner-read:1'};
 return {runtime,repository,serverClock,workerRegistry,input,actor,candidate,get calls(){return calls;},setNow:value=>now=value};
}
async function run(f){const enqueued=await f.runtime.authorizeAndEnqueue({actor:f.actor,input:f.input});return f.runtime.continueSaved({candidateId:f.input.candidateId,jobId:enqueued.job.jobId,expectedRevision:f.input.expectedRevision});}
test('pre-PA one-use account read persists three sanitized receipts, source revision unchanged, replay zero requests',async()=>{
 const f=setup(),outcome=await run(f);assert.equal(outcome.status,'completed');assert.equal(f.calls,3);assert.equal(outcome.requestsSent,3);
 assert.deepEqual(outcome.observedMethods,['roles','seller_info','warehouse_list']);assertOzonAccountReadReceipt(outcome.receipt,outcome.job);
 assert.equal(outcome.receipt.steps[0].result.facts.roles[0].methods[0],'/v3/product/import');assert.equal(JSON.stringify(outcome).includes('DO_NOT_PERSIST'),false);
 const snapshot=await f.repository.readSnapshot();assert.deepEqual(snapshot.candidates[0],f.candidate);assert.equal(snapshot.runtime.softwareJobAuthorizationRecords[0].useCount,1);
 const replay=await f.runtime.authorizeAndEnqueue({actor:f.actor,input:f.input});assert.equal(replay.idempotentReplay,true);assert.equal(replay.job.jobId,outcome.job.jobId);
 await f.runtime.continueSaved({candidateId:f.input.candidateId,jobId:outcome.job.jobId,expectedRevision:0});assert.equal(f.calls,3);
});
test('first missing evidence stops sequence with an actual successful read and failed technical result',async()=>{
 const f=setup({request:async(req,options)=>{await options.beforeRequestSend();return {};}}),outcome=await run(f);
 assert.equal(outcome.status,'failed');assert.equal(outcome.job.externalRequestState,'succeeded');assert.equal(outcome.requestsSent,1);assert.equal(f.calls,1);
 assert.equal(outcome.receipt.steps[0].result.status,'data_unavailable');assert.equal(readOzonAccountReadTerminal(outcome.receipt,outcome.job).status,'failed');
});
test('malformed official response is typed failure with response fact retained and no next method',async()=>{
 const f=setup({request:async(req,options)=>{await options.beforeRequestSend();return {roles:42};}}),outcome=await run(f);
 assert.equal(outcome.status,'failed');assert.equal(outcome.requestsSent,1);assert.equal(outcome.job.externalRequestState,'succeeded');assert.equal(outcome.receipt.steps[0].errorCode,'OZON_ACCOUNT_READ_RESPONSE_INVALID');
});
test('programming errors stay explicit and a restart never replays a saved send intent',async()=>{
 const error=new Error('synthetic implementation failure');
 const f=setup({request:async(req,options)=>{await options.beforeRequestSend();throw error;}});
 await assert.rejects(()=>run(f),value=>value===error);
 const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:f.repository,serverClock:f.serverClock,workerRegistry:f.workerRegistry});
 await store.reconcileAfterRestart();const state=await f.repository.readSnapshot(),job=state.runtime.softwareJobs[0];
 assert.equal(job.status,'unknown_outcome');await f.runtime.continueSaved({candidateId:job.candidateId,jobId:job.jobId,expectedRevision:0});assert.equal(f.calls,1);
});

test('published strict schemas accept saved account read job, authorization, credential and receipt at revision zero',async()=>{
 const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs');
 const validator=await loadPublishedSchemaValidator(),f=setup(),outcome=await run(f),document=await f.repository.readSnapshot();
 for(const [schema,value] of [['software-job-v1.schema.json',outcome.job],['ozon-account-read-v1.schema.json#/$defs/receipt',outcome.receipt],['software-job-admission-v1.schema.json#/$defs/softwareJobAuthorizationRecord',document.runtime.softwareJobAuthorizationRecords[0]],['software-job-admission-v1.schema.json#/$defs/softwareJobCredentialBinding',document.runtime.softwareJobCredentialBindings[0]]]){
  const validate=validator.getSchema(schema);assert.ok(validate,schema);assert.equal(validate(value),true,JSON.stringify(validate.errors));
 }
});

test('concurrent authorization and execution have one job, one lease and three reads total',async()=>{
 const f=setup();const enqueues=await Promise.all([f.runtime.authorizeAndEnqueue({actor,input:f.input}),f.runtime.authorizeAndEnqueue({actor,input:f.input})]);
 assert.equal(enqueues[0].job.jobId,enqueues[1].job.jobId);
 const input={candidateId:f.input.candidateId,jobId:enqueues[0].job.jobId,expectedRevision:0};
 await Promise.all([f.runtime.continueSaved(input),f.runtime.continueSaved(input)]);assert.equal(f.calls,3);
 assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs.length,1);
});
test('revision changes between methods stop before another connector/secret invocation and retain first response',async()=>{
 const f=setup({request:async(req,options,{repository})=>{
  await options.beforeRequestSend();await repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
  return structuredClone(responses[req.endpoint]);
 }}),outcome=await run(f);
 assert.equal(outcome.status,'failed');assert.equal(f.calls,1);assert.equal(outcome.requestsSent,1);assert.equal(outcome.job.externalRequestState,'succeeded');
 assert.equal(outcome.receipt.failureClass,'OZON_ACCOUNT_READ_CANDIDATE_CHANGED');
});
test('authorization expires before the next method: zero further connector invocations',async()=>{
 const f=setup({leaseDurationMs:1800000,request:async(req,options,{setNow})=>{await options.beforeRequestSend();setNow('2026-09-08T00:00:05.000Z');return structuredClone(responses[req.endpoint]);}});
 f.input.expiresAt='2026-09-08T00:00:05.000Z';const outcome=await run(f);
 assert.equal(outcome.status,'failed');assert.equal(outcome.job.externalRequestState,'succeeded');assert.equal(f.calls,1);assert.match(outcome.receipt.failureClass,/AUTHORIZATION_EXPIRED/);
});
test('proven not-attempted transport error after hook preserves zero transmissions despite send intent',async()=>{
 const {OzonDEHttpTransportError}=await import('../lib/ozon-de-http-configuration.mjs');
 const f=setup({request:async(req,options)=>{await options.beforeRequestSend();throw new OzonDEHttpTransportError('OZON_DE_HTTP_CANCELLED',{layer:'transport',externalRequestState:'not_sent',requestTransmission:'not_attempted'});}}),outcome=await run(f);
 assert.equal(outcome.status,'failed');assert.equal(outcome.job.externalRequestState,'not_sent');assert.equal(outcome.requestsSent,0);assert.equal(outcome.receipt.steps[0].sentAt,T);
});
test('lease timeout before a delayed send hook runs cannot create a late send fact or perform fetch',async()=>{
 let release,hookOutcome,fetches=0;
 const f=setup({request:async(req,options,{repository})=>{
  const blocked=repository.transact(async()=>{await new Promise(resolve=>release=resolve);return {changed:false};});
  hookOutcome=options.beforeRequestSend().then(()=>{fetches++;},error=>error);
  setTimeout(()=>release(),40);await blocked;await hookOutcome;return {};
 }});f.input.expiresAt='2026-09-08T00:00:00.015Z';
 const outcome=await run(f);assert.equal(outcome.status,'failed');assert.equal(outcome.job.externalRequestState,'not_sent');assert.equal(outcome.requestsSent,0);assert.equal(fetches,0);
 await hookOutcome;const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.ozonAccountReadReceipts[outcome.job.jobId].steps[0].sentAt,null);
});
for(const reconcile of ['reconcileAfterRestart','reconcileExpiredLeases'])test(`${reconcile} preserves partial response facts and stops once without resending`,async()=>{
 const error=new Error('synthetic stopped process');
 const f=setup({request:async(req,options,{calls})=>{if(calls===2)throw error;await options.beforeRequestSend();return structuredClone(responses[req.endpoint]);}});
 await assert.rejects(()=>run(f),value=>value===error);const before=await f.repository.readSnapshot();
 const restarted=createMemoryBusinessStateRepository(before);f.setNow('2026-09-08T00:00:11.000Z');
 const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:restarted,serverClock:f.serverClock,workerRegistry:f.workerRegistry});
 await store[reconcile]();const after=await restarted.readSnapshot(),job=after.runtime.softwareJobs[0],receipt=after.runtime.ozonAccountReadReceipts[job.jobId];
 assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'succeeded');assert.equal(receipt.status,'failed');assert.equal(f.calls,2);
 assert.deepEqual(receipt.steps[0],before.runtime.ozonAccountReadReceipts[job.jobId].steps[0]);
 assert.deepEqual(await store[reconcile](),{reconciled:[]});assert.deepEqual(await restarted.readSnapshot(),after);
});
test('unexpired lease reconciliation does not touch receipt or prematurely settle',async()=>{
 const f=setup({request:async(req,options)=>{await options.beforeRequestSend();throw new Error('synthetic interrupted');}});await assert.rejects(()=>run(f),/synthetic interrupted/);
 const before=await f.repository.readSnapshot();const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:f.repository,serverClock:f.serverClock,workerRegistry:f.workerRegistry});
 assert.deepEqual(await store.reconcileExpiredLeases(),{reconciled:[]});assert.deepEqual(await f.repository.readSnapshot(),before);
});

async function syntheticTransport(overrides={}){
 const {createOzonDEHttpTransport}=await import('../lib/ozon-de-http-transport.mjs');
 return createOzonDEHttpTransport({productionBindings:[{bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,platform:'ozon',storeRef,storeName:'合成店铺',warehouseName:'合成仓库',warehouseRef:binding.warehouseRef,warehouseId:binding.warehouseId,credentialAlias:binding.credentialAlias,
  verification:{evidenceRef:'evidence:synthetic:1',checkedAt:T,expiresAt:'2027-01-01T00:00:00.000Z'}}],credentialBindings:[{credentialAlias:binding.credentialAlias,clientId:'123456',keychainService:'test.account',keychainAccount:'test.account'}],readSecret:async()=> 'synthetic-api-key',
  fetchImpl:async url=>new Response(JSON.stringify(responses[new URL(url).pathname]),{status:200}),...overrides});
}
test('actual transport with synthetic secret and fetch persists fixed real DTO shapes and only three calls',async()=>{
 let secrets=0,fetches=0;const transport=await syntheticTransport({readSecret:async()=>{secrets++;return 'synthetic-api-key';},fetchImpl:async url=>{fetches++;return new Response(JSON.stringify(responses[new URL(url).pathname]),{status:200});}});
 const f=setup({request:transport.requestJson}),outcome=await run(f);assert.equal(outcome.status,'completed');assert.equal(secrets,3);assert.equal(fetches,3);
 assert.equal(JSON.stringify(await f.repository.readSnapshot()).includes('synthetic-api-key'),false);
});
test('transport own timeout aborts delayed durable hook before settlement even when outer lease remains valid',async()=>{
 let fetches=0,hookPromise,release;
 const transport=await syntheticTransport({timeoutMs:10,fetchImpl:async()=>{fetches++;return new Response('{}');}});
 const f=setup({request:async(req,options,{repository})=>{
  return transport.requestJson(req,{...options,beforeRequestSend:async()=>{
    const blocked=repository.transact(async()=>{await new Promise(resolve=>release=resolve);return {changed:false};});
    hookPromise=options.beforeRequestSend();setTimeout(()=>release(),40);await blocked;return hookPromise;
  }});
 }});
 const outcome=await run(f);assert.equal(outcome.status,'failed');assert.equal(outcome.job.externalRequestState,'not_sent');assert.equal(fetches,0);assert.equal(outcome.requestsSent,0);
 await assert.rejects(hookPromise,/OZON_DE_HTTP_TIMEOUT/);assert.equal(outcome.receipt.steps[0].sentAt,null);
});
test('transmitted timeout is unknown, counted as a transmission, and never retried',async()=>{
 // The budget must outlast the durable send-intent hook (~14ms with the current secret scanner) so the timeout fires after transmission.
 const transport=await syntheticTransport({timeoutMs:250,fetchImpl:async()=>new Promise(()=>{})});
 const f=setup({request:transport.requestJson}),outcome=await run(f);assert.equal(outcome.status,'unknown_outcome');assert.equal(outcome.requestsSent,1);assert.equal(outcome.receipt.steps[0].requestTransmission,'attempted');
 const snapshot=await f.repository.readSnapshot();await f.runtime.continueSaved({candidateId:f.input.candidateId,jobId:outcome.job.jobId,expectedRevision:0});assert.equal(f.calls,1);assert.deepEqual(await f.repository.readSnapshot(),snapshot);
});
test('response observations are not restamped during delayed persistence; forged scope, times, raw fields rejected',async()=>{
 const f=setup(),outcome=await run(f),receipt=outcome.receipt;
 const copy=()=>structuredClone(receipt);
 let bad=copy();bad.steps[0].result.observedAt='2026-09-07T23:59:59.000Z';assert.throws(()=>assertOzonAccountReadReceipt(bad,outcome.job),/STEP_RESULT_INVALID/);
 bad=copy();bad.scope.warehouseId='10002';assert.throws(()=>assertOzonAccountReadReceipt(bad,outcome.job),/SCOPE_INVALID/);
 bad=copy();bad.steps[0].result.facts.token='secret';assert.throws(()=>assertOzonAccountReadReceipt(bad,outcome.job),/FACTS_INVALID/);
 bad=copy();bad.steps[0].requestTransmission='not_attempted';assert.throws(()=>assertOzonAccountReadReceipt(bad,outcome.job),/STEP_RESULT_INVALID/);
 bad=copy();bad.steps[2].result.facts.warehouses[0].warehouseId='10002';assert.throws(()=>assertOzonAccountReadReceipt(bad,outcome.job),/OBSERVED_FACTS_INVALID/);
});

test('receipt preserves observation time when the commit clock advances',async()=>{
 const later='2026-09-08T00:00:00.005Z';
 const f=setup({request:async(req,options,{calls,setClock})=>{await options.beforeRequestSend();if(calls===1){let reads=0;setClock(()=>reads++===0?T:later);}return structuredClone(responses[req.endpoint]);}});
 const outcome=await run(f);assert.equal(outcome.status,'completed');assert.equal(outcome.receipt.steps[0].result.observedAt,T);assert.equal(outcome.receipt.steps[0].completedAt,later);
});

test('authorization rejects untrusted actor, expired range and unresolved exact binding without creating jobs',async()=>{
 for(const kind of ['actor','expiry','binding']){
  const f=setup(kind==='binding'?{bindingResolver:()=>null}:{});
  if(kind==='expiry')f.input.expiresAt=T;
  const owner=kind==='actor'?{...actor,source:'local_development'}:actor;
  const before=await f.repository.readSnapshot();await assert.rejects(()=>f.runtime.authorizeAndEnqueue({actor:owner,input:f.input}),/OZON_ACCOUNT_READ_/);
  assert.deepEqual(await f.repository.readSnapshot(),before);assert.equal(f.calls,0);
 }
});
test('failed and unknown account-read jobs and receipts satisfy strict published schemas',async()=>{
 const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs'),validator=await loadPublishedSchemaValidator();
 const {OzonDEHttpTransportError}=await import('../lib/ozon-de-http-configuration.mjs');
 for(const mode of ['data_unavailable','not_sent','unknown_outcome']){
  const f=setup({request:async(req,options)=>{await options.beforeRequestSend();if(mode==='data_unavailable')return {};throw new OzonDEHttpTransportError('OZON_DE_HTTP_TIMEOUT',{externalRequestState:mode,requestTransmission:mode==='not_sent'?'not_attempted':'attempted'});}}),outcome=await run(f);
  for(const [name,value] of [['software-job-v1.schema.json',outcome.job],['ozon-account-read-v1.schema.json#/$defs/receipt',outcome.receipt]]){
   const validate=validator.getSchema(name);assert.equal(validate(value),true,JSON.stringify(validate.errors));
  }
 }
});
test('account view is a pure read and does not materialize empty runtime collections',()=>{
 const f=setup(),document={candidates:[],runtime:{}};assert.deepEqual(f.runtime.view({document,candidateId:'candidate:1'}),[]);assert.deepEqual(document,{candidates:[],runtime:{}});
});


test('different click keys for the same read scope atomically authorize only one job and one three-method execution',async()=>{
 const f=setup();const outcomes=await Promise.allSettled([f.runtime.authorizeAndEnqueue({actor,input:f.input}),
  f.runtime.authorizeAndEnqueue({actor,input:{...f.input,idempotencyKey:'owner-read:another'}})]);
 assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
 assert.equal(outcomes.find(value=>value.status==='rejected').reason.code,'OZON_ACCOUNT_READ_SCOPE_ALREADY_AUTHORIZED');
 const job=outcomes.find(value=>value.status==='fulfilled').value.job;
 await f.runtime.continueSaved({candidateId:job.candidateId,jobId:job.jobId,expectedRevision:job.revision});
 assert.equal(f.calls,3);const document=await f.repository.readSnapshot();assert.equal(document.runtime.softwareJobs.length,1);assert.equal(document.runtime.softwareJobAuthorizationRecords.length,1);
});
test('an unknown read outcome cannot be reopened with another key or longer expiry',async()=>{
 const {OzonDEHttpTransportError}=await import('../lib/ozon-de-http-configuration.mjs');
 const f=setup({request:async(req,options)=>{await options.beforeRequestSend();throw new OzonDEHttpTransportError('OZON_DE_HTTP_TIMEOUT',{externalRequestState:'unknown_outcome',requestTransmission:'attempted'});}});
 const outcome=await run(f);assert.equal(outcome.status,'unknown_outcome');const before=await f.repository.readSnapshot();
 await assert.rejects(()=>f.runtime.authorizeAndEnqueue({actor,input:{...f.input,idempotencyKey:'owner-read:again',expiresAt:'2026-09-09T01:00:00.000Z'}}),error=>error.code==='OZON_ACCOUNT_READ_OUTCOME_RECONCILIATION_REQUIRED');
 assert.deepEqual(await f.repository.readSnapshot(),before);assert.equal(f.calls,1);
});
test('completed evidence never becomes a refresh permission, even after it expires',async()=>{
 const f=setup();await run(f);const before=await f.repository.readSnapshot();
 for(const now of [T,'2026-09-09T00:00:00.000Z']){
  f.setNow(now);await assert.rejects(()=>f.runtime.authorizeAndEnqueue({actor,input:{...f.input,idempotencyKey:'owner-read:refresh',expiresAt:'2026-09-10T00:00:00.000Z'}}),error=>error.code==='OZON_ACCOUNT_READ_REFRESH_NOT_SUPPORTED');
  assert.deepEqual(await f.repository.readSnapshot(),before);
 }
 assert.equal(f.calls,3);
});
test('a known failed read permits a new explicit one-use authorization and preserves the failed history',async()=>{
 const f=setup({request:async(req,options,{calls})=>{await options.beforeRequestSend();return calls===1?{}:structuredClone(responses[req.endpoint]);}});
 const failed=await run(f);assert.equal(failed.status,'failed');const before=await f.repository.readSnapshot();
 const next=await f.runtime.authorizeAndEnqueue({actor,input:{...f.input,idempotencyKey:'owner-read:new-authorization'}});
 assert.notEqual(next.job.jobId,failed.job.jobId);assert.equal(next.status,'queued');
 const complete=await f.runtime.continueSaved({candidateId:next.job.candidateId,jobId:next.job.jobId,expectedRevision:0});assert.equal(complete.status,'completed');assert.equal(f.calls,4);
 const after=await f.repository.readSnapshot();assert.equal(after.runtime.softwareJobs.length,2);assert.equal(after.runtime.softwareJobAuthorizationRecords.length,2);
 assert.deepEqual(after.runtime.softwareJobs[0],before.runtime.softwareJobs[0]);assert.deepEqual(after.runtime.ozonAccountReadReceipts[failed.job.jobId],before.runtime.ozonAccountReadReceipts[failed.job.jobId]);
});


async function persistSyntheticPA(f,{sourceRevision=0,resultRevision=1}={}){
 await f.repository.transact(document=>{
  const candidate=document.candidates[0],sku=candidate.lifecycleV11.skuPackage;
  candidate.dataRevision=resultRevision;
  sku.productionAuthorization={authorizationId:'production-authorization:synthetic:1',sourceCandidateRevision:sourceRevision,resultCandidateRevision:resultRevision,
   lockedScope:{candidateId:candidate.id,skuPackageId:sku.skuPackageId,supplierSkuId:sku.supplierSkuId,storeRef:structuredClone(storeRef),warehouseRef:binding.warehouseRef,credentialAlias:binding.credentialAlias},
   executionBinding:{bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,warehouseId:binding.warehouseId}};
  return {changed:true,document};
 });
}
for(const status of ['completed','unknown_outcome'])test(`PA commit keeps the same pre-PA ${status} read within the no-repeat boundary`,async()=>{
 const {OzonDEHttpTransportError}=await import('../lib/ozon-de-http-configuration.mjs');
 const f=setup(status==='unknown_outcome'?{request:async(req,options)=>{await options.beforeRequestSend();throw new OzonDEHttpTransportError('OZON_DE_HTTP_TIMEOUT',{externalRequestState:'unknown_outcome',requestTransmission:'attempted'});}}:{});
 const result=await run(f);assert.equal(result.status,status);await persistSyntheticPA(f);const before=await f.repository.readSnapshot(),calls=f.calls;
 await assert.rejects(()=>f.runtime.authorizeAndEnqueue({actor,input:{...f.input,expectedRevision:1,idempotencyKey:'owner-read:post-pa'}}),
  error=>error.code===(status==='completed'?'OZON_ACCOUNT_READ_REFRESH_NOT_SUPPORTED':'OZON_ACCOUNT_READ_OUTCOME_RECONCILIATION_REQUIRED'));
 assert.deepEqual(await f.repository.readSnapshot(),before);assert.equal(f.calls,calls);
});
test('only the current PA source revision is equivalent; an unrelated historical revision is not inherited',async()=>{
 const f=setup();await run(f);await persistSyntheticPA(f,{sourceRevision:1,resultRevision:2});
 const queued=await f.runtime.authorizeAndEnqueue({actor,input:{...f.input,expectedRevision:2,idempotencyKey:'owner-read:changed-source'}});
 assert.equal(queued.status,'queued');assert.equal(queued.job.revision,2);assert.equal(f.calls,3);
 assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs.length,2);
});

const afterStart = milliseconds => new Date(Date.parse(T) + milliseconds).toISOString();

test('active account reader renews heartbeat across two successful methods exceeding thirty seconds within its original lease',async()=>{
 let sends=0;const f=setup({leaseDurationMs:120000,request:async(req,options,{calls,setNow})=>{
  await options.beforeRequestSend();sends++;setNow(afterStart(calls*20000));return structuredClone(responses[req.endpoint]);
 }}),outcome=await run(f);
 assert.equal(outcome.status,'completed');assert.equal(f.calls,3);assert.equal(sends,3);assert.equal(outcome.requestsSent,3);
 assert.deepEqual(outcome.observedMethods,['roles','seller_info','warehouse_list']);
 assert.equal(outcome.receipt.steps[0].result.observedAt,afterStart(20000));
 assert.equal(outcome.receipt.steps[1].result.observedAt,afterStart(40000));
 assert.equal(outcome.receipt.steps[2].sentAt,afterStart(40000));
 assert.equal(outcome.job.leaseExpiresAt,afterStart(120000));
 assert.equal(outcome.receipt.completedAt,afterStart(60000));
 assert.deepEqual((await f.repository.readSnapshot()).candidates[0],f.candidate);
});

test('an active delayed send checkpoint renews heartbeat without extending the authorized lease',async()=>{
 let sends=0;const f=setup({leaseDurationMs:120000,request:async(req,options,{calls,setNow})=>{
  if(calls===1)setNow(afterStart(31000));
  await options.beforeRequestSend();sends++;return structuredClone(responses[req.endpoint]);
 }}),outcome=await run(f);
 assert.equal(outcome.status,'completed');assert.equal(sends,3);assert.equal(f.calls,3);
 assert.equal(outcome.receipt.steps[0].intentAt,T);assert.equal(outcome.receipt.steps[0].sentAt,afterStart(31000));
 assert.equal(outcome.job.leaseExpiresAt,afterStart(120000));
});

for(const change of ['offline','version','capabilities'])test(`heartbeat checkpoint does not restore an explicitly changed worker: ${change}`,async()=>{
 let sends=0;let f;
 f=setup({leaseDurationMs:120000,request:async(req,options,{calls,setNow})=>{
  await options.beforeRequestSend();sends++;
  if(calls===1){
   setNow(afterStart(31000));const current=f.workerRegistry.get('worker:account');
   if(change==='offline')f.workerRegistry.markOffline(current.workerId);
   else f.workerRegistry.heartbeat({...current,...(change==='version'?{version:'worker-version:replaced'}:{capabilities:[]})});
  }
  return structuredClone(responses[req.endpoint]);
 }});
 const outcome=await run(f),changed=f.workerRegistry.get('worker:account');
 assert.equal(outcome.status,'failed');assert.equal(outcome.receipt.failureClass,'OZON_ACCOUNT_READ_WORKER_CHANGED');
 assert.equal(sends,1);assert.equal(f.calls,1);assert.equal(outcome.requestsSent,1);
 assert.equal(outcome.receipt.steps.length,1);assert.equal(outcome.receipt.steps[0].result.status,'observed');
 assert.equal(outcome.receipt.steps[0].result.observedAt,afterStart(31000));
 assert.equal(changed.status,change==='offline'?'offline':'online');
 assert.equal(changed.version,change==='version'?'worker-version:replaced':'worker-version:1');
 if(change==='capabilities')assert.deepEqual(changed.capabilities,[]);
 const before=await f.repository.readSnapshot();
 await f.runtime.continueSaved({candidateId:f.input.candidateId,jobId:outcome.job.jobId,expectedRevision:0});
 assert.equal(f.calls,1);assert.equal(sends,1);assert.deepEqual(await f.repository.readSnapshot(),before);
 assert.deepEqual(f.workerRegistry.get('worker:account'),changed);
});

for(const limit of ['lease','authorization'])test(`heartbeat renewal cannot extend an expired ${limit} or resend retained observations`,async()=>{
 let sends=0;const f=setup({leaseDurationMs:120000,request:async(req,options,{setNow})=>{
  await options.beforeRequestSend();sends++;setNow(afterStart(limit==='lease'?120000:40000));return structuredClone(responses[req.endpoint]);
 }});
 if(limit==='authorization')f.input.expiresAt=afterStart(40000);
 const outcome=await run(f);assert.equal(outcome.status,'failed');assert.equal(f.calls,1);assert.equal(sends,1);
 assert.match(outcome.receipt.failureClass,limit==='lease'?/LEASE_EXPIRED/:/AUTHORIZATION_EXPIRED/);
 assert.equal(outcome.receipt.steps.length,1);assert.equal(outcome.receipt.steps[0].result.status,'observed');
 assert.equal(outcome.requestsSent,1);assert.equal(outcome.job.leaseExpiresAt,afterStart(120000));
 const before=await f.repository.readSnapshot();
 await f.runtime.continueSaved({candidateId:f.input.candidateId,jobId:outcome.job.jobId,expectedRevision:0});
 assert.equal(f.calls,1);assert.equal(sends,1);assert.deepEqual(await f.repository.readSnapshot(),before);
});

test('initial claim never revives offline or replaces changed version/capabilities before the first request',async()=>{
 for(const change of ['offline','version','capabilities']){
  const f=setup({leaseDurationMs:120000}),queued=await f.runtime.authorizeAndEnqueue({actor:f.actor,input:f.input});
  const current=f.workerRegistry.get('worker:account');
  if(change==='offline')f.workerRegistry.markOffline(current.workerId);
  else f.workerRegistry.heartbeat({...current,...(change==='version'?{version:'worker-version:replaced'}:{capabilities:[]})});
  const before=await f.repository.readSnapshot(),registered=f.workerRegistry.get(current.workerId);
  await assert.rejects(()=>f.runtime.continueSaved({candidateId:f.input.candidateId,jobId:queued.job.jobId,expectedRevision:0}),
   error=>error.code==='OZON_ACCOUNT_READ_WORKER_CHANGED');
  assert.equal(f.calls,0);assert.deepEqual(await f.repository.readSnapshot(),before);
  assert.deepEqual(f.workerRegistry.get(current.workerId),registered);assert.equal(before.runtime.softwareJobs[0].status,'queued');
 }
});
