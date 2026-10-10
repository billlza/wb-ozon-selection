import test from 'node:test';
import assert from 'node:assert/strict';
import {savedDProductionJobFixture} from './fixtures/d-production-saved-job-fixture.mjs';
import {runPersistedDExecution} from '../lib/d-e-software-integration.mjs';
import {createDPlatformObservationRuntime} from '../lib/d-platform-observation-use-case.mjs';
import {createStoreIsolatedOzonSellerApiDEAdapter,inspectAdapterCapabilities,OZON_DE_READBACK_ENDPOINTS} from '../lib/ozon-seller-api-de-adapter.mjs';
import {settleSoftwareJob,findSoftwareJobInDocument} from '../lib/software-job-contract.mjs';
import {loadPublishedSchemaValidator} from './helpers/published-schema-validator.mjs';
const clone=value=>structuredClone(value);
async function fixture({status='pending',throwDuringRead=false}={}){
 const d=await savedDProductionJobFixture(),at=d.input.serverClock(),policy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:job-store',version:'version:1',maxQueries:5,intervalMs:10,requestTimeoutMs:1000,expiresAt:new Date(Date.parse(at)+60000).toISOString()};
 await runPersistedDExecution({...d.input,platformObservationPolicy:policy,createAdapter:d.createAdapter()});
 let calls=0;
 const runtime=createDPlatformObservationRuntime({repository:d.repository,jobStore:d.jobStore,serverClock:d.input.serverClock,resolveExecution:()=>({worker:d.worker,leaseDurationMs:10000,
  createAdapter:()=>createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:d.input.adapterCapabilities,requestJson:async(request,options)=>{
   await options.beforeRequestSend();calls++;if(throwDuringRead)throw new Error('synthetic process interrupted');
   const document=await d.repository.readSnapshot(),attempt=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.attempt;
   const offer=attempt.request.merchantSku;
   if(request.endpoint==='/v1/product/import/info')return {result:{items:[{offer_id:offer,product_id:status==='pending'?0:910001,status,errors:[]}]}};
   if(request.endpoint==='/v3/product/info/list')return {items:[{id:910001,offer_id:offer,is_archived:false,is_autoarchived:false,errors:[],statuses:{status:d.input.adapterCapabilities.inventoryWrite.prerequisitePolicy.priceSent.acceptedValues[0]}}]};
   if(request.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return {has_next:false,products:[{warehouse_id:Number(d.input.adapterCapabilities.warehouseId),product_id:910001,sku:910002,offer_id:offer,free_stock:0,present:0,reserved:0}]};
   throw new Error('Unexpected endpoint');
  }})})});
 const queued=async()=>{const document=await d.repository.readSnapshot();return document.runtime.softwareJobs.find(job=>job.jobType==='e_d_platform_observation'&&job.status==='queued');};
 return {d,policy,runtime,queued,get calls(){return calls;}};
}
test('D park releases holder lease and starts one durable read in the same commit; duplicate enqueue is inert',async()=>{
 const f=await fixture(),document=await f.d.repository.readSnapshot(),original=document.runtime.softwareJobs[0],read=await f.queued();
 assert.equal(original.status,'waiting_platform');assert.equal(original.externalRequestState,'succeeded');assert.equal(original.leaseId,null);assert.equal(original.leaseExpiresAt,null);assert.equal(original.attempt,1);
 await f.d.repository.transact(doc=>{const source=doc.runtime.softwareJobs.find(job=>job.jobId===original.jobId),candidate=doc.candidates[0];
  const duplicate=f.d.jobStore.enqueueDPlatformObservationInDocument({document:doc,candidate,sourceDJob:source,scope:read.scopeBinding,policy:f.policy,observedAt:f.d.input.serverClock()});assert.equal(duplicate.jobId,read.jobId);return {changed:true,document:doc};});
 const after=await f.d.repository.readSnapshot();assert.equal(after.runtime.softwareJobs.length,2);assert.equal(f.d.calls.length,1);
 await f.d.jobStore.reconcileAfterRestart();assert.deepEqual(await f.d.repository.readSnapshot(),after);
 await f.d.jobStore.reconcileExpiredLeases();assert.deepEqual(await f.d.repository.readSnapshot(),after);
});
test('ordinary callers cannot forge an observation terminal or replace its scope',async()=>{
 const f=await fixture(),read=await f.queued();const claimed=await f.d.jobStore.claim({jobId:read.jobId,worker:f.d.worker,leaseId:'lease:synthetic:observation',leaseDurationMs:10000});
 assert.throws(()=>settleSoftwareJob({job:claimed,workerId:claimed.workerId,leaseId:claimed.leaseId,status:'failed',externalRequestState:'not_sent',failureClass:'synthetic:stop',serverTime:f.d.input.serverClock()}),/DOMAIN_SETTLEMENT_REQUIRED/);
 await assert.rejects(()=>f.d.repository.transact(doc=>{const job=doc.runtime.softwareJobs.find(value=>value.jobId===read.jobId);job.scopeBinding.taskId='99999';f.d.jobStore.assertDPlatformObservationExecutionInDocument({document:doc,jobId:job.jobId,workerId:claimed.workerId,leaseId:claimed.leaseId,observedAt:f.d.input.serverClock()});return {changed:true,document:doc};}),/SCOPE_FINGERPRINT_CONFLICT/);
 assert.equal(f.calls,0);
});
test('stopped issued observation retains the original accepted import and never starts another query on restart',async()=>{
 const f=await fixture({throwDuringRead:true});await assert.rejects(()=>f.runtime.runJob({jobId:undefined}),/JOB_INVALID/);
 const read=await f.queued();await assert.rejects(()=>f.runtime.runJob({jobId:read.jobId}),/synthetic process interrupted/);
 await f.d.jobStore.reconcileAfterRestart();const document=await f.d.repository.readSnapshot(),job=document.runtime.softwareJobs.find(value=>value.jobId===read.jobId),djob=document.runtime.softwareJobs[0];
 assert.equal(job.status,'unknown_outcome');assert.equal(job.externalRequestState,'unknown_outcome');assert.ok(job.resultEnvelope);assert.equal(djob.status,'unknown_outcome');assert.equal(f.calls,1);assert.equal(f.d.calls.length,1);assert.equal(await f.queued(),undefined);
 await f.runtime.runJob({jobId:read.jobId});assert.equal(f.calls,1);
});
test('queued, parked, completed-query and explicit platform-stop jobs obey published schema',async()=>{
 const f=await fixture({status:'failed'}),before=await f.d.repository.readSnapshot(),read=await f.queued();await f.runtime.runJob({jobId:read.jobId});
 const after=await f.d.repository.readSnapshot(),validator=await loadPublishedSchemaValidator(),validate=validator.getSchema('software-job-v1.schema.json');
 for(const job of [...before.runtime.softwareJobs,...after.runtime.softwareJobs])assert.equal(validate(job),true,`${job.jobType}/${job.status}: ${JSON.stringify(validate.errors)}`);
 const original=after.runtime.softwareJobs[0];assert.equal(original.status,'failed');assert.equal(original.externalRequestState,'succeeded');assert.equal(original.platformContinuation.inventoryWriteState,'not_sent');assert.ok(original.resultEnvelope);
});
test('new inventory lease can execute only the unsent remainder and a stopped pre-send lease preserves known import',async()=>{
 const f=await fixture({status:'imported'});
 for(let i=0;i<3;i++){await f.runtime.runJob({jobId:(await f.queued()).jobId});f.d.advance(11);}
 const document=await f.d.repository.readSnapshot(),original=document.runtime.softwareJobs[0],history=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation.observationHistory;
 const observationJobId=history.at(-1).jobId;
 const lease=await f.d.jobStore.claimDRemainingInventory({jobId:original.jobId,worker:f.d.worker,leaseId:'lease:synthetic:remaining',leaseDurationMs:10000,observationJobId,verifyInventoryPrerequisiteSource:()=>true});
 assert.equal(lease.attempt,1);assert.equal(lease.status,'claimed');assert.equal(lease.externalRequestState,'not_sent');
 await assert.rejects(()=>f.d.jobStore.claimDRemainingInventory({jobId:original.jobId,worker:f.d.worker,leaseId:'lease:synthetic:duplicate',leaseDurationMs:10000,observationJobId,verifyInventoryPrerequisiteSource:()=>true}),/JOB_INVALID/);
 await f.d.jobStore.reconcileAfterRestart();const stopped=await f.d.repository.readSnapshot(),job=stopped.runtime.softwareJobs[0];assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'succeeded');assert.equal(f.d.calls.length,1);assert.equal(f.calls,3);
 const state=stopped.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;assert.equal(state.platformWrites,1);assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
 assert.doesNotThrow(()=>findSoftwareJobInDocument(stopped,job.jobId));
});
test('completed preparation keeps its original lease; only new continuation can use it and historical source tampering rejects',async()=>{
 const {createDProductionPreparationIntent,completeDProductionPreparation}=await import('../lib/d-production-preparation-contract.mjs');
 const {prepareSingleSkuDExecution}=await import('../lib/d-e-software-closure.mjs');
 const f=await fixture(),input=f.d.input,caps=input.adapterCapabilities;
 const inspected=inspectAdapterCapabilities({...caps,inspectedAt:input.serverClock(),
  storeIdentity:{status:'verified',expectedStore:caps.store,observedStore:caps.store,observedStoreRef:caps.storeRef,credentialAlias:caps.credentialAlias,evidenceRef:'evidence:synthetic:store'},
  productImport:{...caps.productImport,endpoint:'/v3/product/import',statusEndpoint:'/v1/product/import/info',protocolVersion:'ozon-product-import-v3'},
  assetTransport:{...caps.assetTransport,mode:'preapproved_stable_https',protocolVersion:'approved-https-assets-v1'},
  independentReadback:{...caps.independentReadback,protocolVersion:'ozon-independent-readback-v2',endpoints:OZON_DE_READBACK_ENDPOINTS}});
 const prepared=prepareSingleSkuDExecution({...input,adapterCapabilities:inspected,productionAuthorization:input.productionPlan.sourceAuthorization,preparedAt:input.serverClock()});
 const intent=createDProductionPreparationIntent({job:f.d.job,candidateRevision:f.d.candidate.dataRevision,productionPlan:input.productionPlan,startedAt:input.serverClock(),requestMode:'persisted_evidence_only'});
 const evidence=completeDProductionPreparation({evidence:intent,platformWritePreflight:input.platformWritePreflight,adapterCapabilities:inspected,preparedExecution:prepared,completedAt:input.serverClock()});
 const doc=await f.d.repository.readSnapshot(),job=doc.runtime.softwareJobs[0];job.preparationEvidence=evidence;
 assert.equal(job.leaseId,null);assert.equal(evidence.leaseId,f.d.job.leaseId);assert.doesNotThrow(()=>findSoftwareJobInDocument(doc,job.jobId));
 for(const mutate of [value=>value.preparationEvidence.leaseId='lease:forged',value=>value.preparationEvidence.candidateId='candidate:wrong',value=>value.scopeBinding.authorizationFingerprint='a'.repeat(64),value=>value.preparationEvidence.result.capabilities.adapterVersion='ozon-seller-api-de-adapter-v2']){
   const bad=clone(doc);mutate(bad.runtime.softwareJobs[0]);assert.throws(()=>findSoftwareJobInDocument(bad,job.jobId));
 }
 const old=clone(doc);delete old.runtime.softwareJobs[0].platformContinuation;assert.throws(()=>findSoftwareJobInDocument(old,job.jobId),/JOB_CONFLICT/);
});

test('expired queued observations remain discoverable and stop with no fabricated claim or request',async()=>{
 const f=await fixture();const queued=await f.queued();f.d.advance(60001);
 assert.deepEqual((await f.d.jobStore.listDPlatformObservationJobs({limit:1})).map(value=>value.jobId),[queued.jobId]);
 await f.runtime.runDue();const document=await f.d.repository.readSnapshot(),job=document.runtime.softwareJobs.find(value=>value.jobId===queued.jobId);
 assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'not_sent');assert.equal(job.attempt,0);assert.equal(job.workerId,null);assert.equal(job.leaseId,null);assert.equal(f.calls,0);assert.equal(document.runtime.softwareJobs[0].status,'failed');
 const validator=await loadPublishedSchemaValidator(),validate=validator.getSchema('software-job-v1.schema.json');
 assert.equal(validate(job),true,JSON.stringify(validate.errors));
 assert.deepEqual(await f.d.jobStore.listDPlatformObservationJobs({limit:1}),[]);
});
test('claim-before-send revision conflict stops only the historical bound query without losing original import',async()=>{
 const f=await fixture();const queued=await f.queued();
 await f.d.repository.transact(document=>{document.candidates[0].dataRevision+=1;return {changed:true,document,result:null};});
 await f.runtime.runJob({jobId:queued.jobId});const document=await f.d.repository.readSnapshot(),job=document.runtime.softwareJobs.find(value=>value.jobId===queued.jobId);
 assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'not_sent');assert.equal(job.attempt,0);assert.equal(f.calls,0);
 assert.equal(document.runtime.softwareJobs[0].externalRequestState,'succeeded');assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformWrites,1);
});
test('saved final observation exposes exactly one original remaining D step and known stop removes it',async()=>{
 const f=await fixture({status:'imported'});
 for(let i=0;i<3;i++){await f.runtime.runJob({jobId:(await f.queued()).jobId});f.d.advance(11);}
 const pending=await f.d.jobStore.listDRemainingInventoryJobs({limit:1});assert.equal(pending.length,1);
 assert.equal(pending[0].sourceDJobId,f.d.job.jobId);assert.equal(f.calls,3);assert.equal(f.d.calls.length,1);
 await f.d.jobStore.rejectDRemainingInventory({jobId:pending[0].sourceDJobId,observationJobId:pending[0].observationJobId,failureClass:'inventory_policy_missing'});
 assert.deepEqual(await f.d.jobStore.listDRemainingInventoryJobs({limit:1}),[]);
 const document=await f.d.repository.readSnapshot();assert.equal(document.runtime.softwareJobs[0].status,'failed');assert.equal(document.runtime.softwareJobs[0].externalRequestState,'succeeded');assert.equal(f.d.calls.length,1);
});
