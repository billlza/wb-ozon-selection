import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createAProductDetailRuntimeFixture} from './fixtures/a-product-detail-runtime-fixture.mjs';
import {createAProductDetailApplicationUseCase} from '../lib/a-product-detail-application.mjs';
import {createJsonBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {readAProductDetailSupplierEvidence} from '../lib/a-product-detail-evidence.mjs';
import {createActorContext} from '../lib/runtime-identity.mjs';

async function completed({fetchImpl=null}={}){
 const f=await createAProductDetailRuntimeFixture();
 const {service}=f.create({onDetailsReady:async()=>({status:'application_paused_for_test'}),...(fetchImpl?{fetchImpl}:{})});
 const before=await f.repository.readSnapshot();
 assert.equal((await f.authorize(service)).status,'completed');
 const first=await f.repository.readSnapshot();assert.deepEqual(first.candidates,before.candidates);
 assert.equal(Object.keys(first.runtime.aProductDetailReceipts).length,1);
 assert.equal((await service.runDue()).status,'completed');await service.stop();
 const saved=await f.repository.readSnapshot();assert.equal(Object.keys(saved.runtime.aProductDetailReceipts).length,2);
 assert.deepEqual(saved.candidates,before.candidates);
 const input={candidateId:f.candidate.id,sourceRevision:f.candidate.dataRevision};
 return {...f,input,before:saved,usecase:createAProductDetailApplicationUseCase({repository:f.repository,serverClock:f.clock})};
}
const detailJobs=document=>document.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read');

test('two actual detail jobs apply to the same A card atomically once, with JSON cold replay and no owner SKU selection',async t=>{
 const f=await completed(),result=await f.usecase.applyDetails(f.input);
 assert.equal(result.status,'applied');assert.equal(result.resultRevision,f.input.sourceRevision+1);
 const saved=await f.repository.readSnapshot(),candidate=saved.candidates[0];
 assert.equal(candidate.id,f.candidate.id);assert.equal(saved.candidates.length,1);assert.equal(candidate.dataRevision,result.resultRevision);
 assert.equal(candidate.salesSnapshotsV11.length,1);assert.equal(candidate.supplierOptionsV11.length,1);
 assert.equal(candidate.salesSnapshotsV11[0].snapshotId,result.salesSnapshotId);assert.equal(candidate.supplierOptionsV11[0].supplierOptionId,result.supplierOptionId);
 assert.equal(candidate.salesSnapshotsV11[0].currentPrice,297);assert.equal(candidate.salesSnapshotsV11[0].currency,'RUB');
 const readback=readAProductDetailSupplierEvidence(candidate);
 assert.deepEqual(readback.supplierCapture.selectedSkuIds,[]);assert.equal(readback.supplierCapture.ownerSupplyConfirmed,false);
 assert.equal(readback.supplierCapture.skuChoices[0].sourceSkuId,'1234567');assert.equal(readback.supplierCapture.skuChoices[0].unitProductPrice,5.9);
 assert.equal(candidate.sourceCapture,undefined);
 assert.equal(candidate.workflowStatus,'needs_user_data');assert.equal(candidate.lifecycleV11,undefined);assert.equal(candidate.listingPreparation,null);
 assert.equal(candidate.executionRuntime.status,'waiting_owner');assert.equal(candidate.executionRuntime.stepId,'A_WAITING_OWNER_SUPPLY_CONFIRMATION');
 assert.equal(candidate.executionRuntime.dataRevision,candidate.dataRevision);assert.equal(candidate.executionRuntime.inputRevision,candidate.dataRevision);
 assert.deepEqual(candidate.aDiscoveryEvidenceV1,f.candidate.aDiscoveryEvidenceV1);
 assert.deepEqual(saved.runtime.softwareJobs,f.before.runtime.softwareJobs);assert.deepEqual(saved.runtime.aProductDetailReceipts,f.before.runtime.aProductDetailReceipts);
 assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,f.before.runtime.softwareJobAuthorizationRecords);
 const bytes=JSON.stringify(saved);assert.deepEqual(await f.usecase.applyDetails(f.input),result);assert.equal(JSON.stringify(await f.repository.readSnapshot()),bytes);
 const directory=await mkdtemp(path.join(tmpdir(),'a-detail-application-cold-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const filePath=path.join(directory,'state.json');await writeFile(filePath,bytes);
 const repository=createJsonBusinessStateRepository({filePath}),cold=createAProductDetailApplicationUseCase({repository,serverClock:f.clock});
 assert.deepEqual(await cold.applyDetails(f.input),result);assert.equal(JSON.stringify(await repository.readSnapshot()),bytes);
 assert.deepEqual(f.counts(),{secrets:2,requests:2});
});

test('elimination or revision change blocks application without losing the two paid observations',async()=>{
 for(const mode of ['eliminated','revision','exception','technical']){
  const f=await completed();await f.repository.transact(document=>{
   const candidate=document.candidates[0];
   if(mode==='eliminated')candidate.workflowStatus='eliminated';
   else if(mode==='revision')candidate.dataRevision++;
   else if(mode==='exception')candidate.executionRuntime.exceptionCase={status:'open'};
   else candidate.executionRuntime.technicalFailure={status:'stopped'};
   return {document,changed:true};});
  const before=await f.repository.readSnapshot(),result=await f.usecase.applyDetails(f.input),saved=await f.repository.readSnapshot();
  assert.equal(result.status,'blocked');assert.equal(result.failureClass,'CANDIDATE_CHANGED');
  assert.deepEqual(saved.candidates,before.candidates);assert.deepEqual(saved.runtime.aProductDetailReceipts,before.runtime.aProductDetailReceipts);
  assert.deepEqual(await f.usecase.applyDetails(f.input),result);assert.deepEqual(f.counts(),{secrets:2,requests:2});
 }
});

test('invalid completed envelopes and missing permission fail explicitly, preserving candidate and receipts',async()=>{
 for(const mode of ['envelope','permission']){
  const f=await completed();await f.repository.transact(document=>{
   const job=detailJobs(document)[0];if(mode==='envelope')job.resultEnvelope.payload.receiptRef='receipt:wrong';
   else document.runtime.softwareJobAuthorizationRecords=document.runtime.softwareJobAuthorizationRecords.filter(record=>record.action!=='a_product_detail_read');
   return {document,changed:true};
  });
  const before=await f.repository.readSnapshot();let result;
  if(mode==='envelope'){
   await assert.rejects(()=>f.usecase.applyDetails(f.input),/COMPLETED_RESULT_CONFLICT/);
   result=(await f.repository.readSnapshot()).runtime.aProductDetailApplications[`${f.input.candidateId}:${f.input.sourceRevision}`];assert.equal(result.status,'failed');
  }else{result=await f.usecase.applyDetails(f.input);assert.equal(result.status,'blocked');assert.equal(result.failureClass,'APPLICATION_PERMISSION_CONFLICT');}
  const saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates,before.candidates);assert.deepEqual(saved.runtime.aProductDetailReceipts,before.runtime.aProductDetailReceipts);
  assert.deepEqual(await f.usecase.applyDetails(f.input),result);assert.deepEqual(f.counts(),{secrets:2,requests:2});
 }
});

test('missing market price remains unknown and cannot produce a partial A snapshot',async()=>{
 const f=await completed({fetchImpl:async(_url,options)=>{
  const body=JSON.parse(options.body);return new Response(JSON.stringify(body.sku?
   {code:'200',errcode:200,total:1,products:[{sku:Number(body.sku),title:'Unknown price',currency:'₽',productUrl:`https://www.ozon.ru/product/${body.sku}/`}]}:
   {errcode:200,offerId:body.offerId,subject:'合成收纳',skuList:[{skuId:'1234567',retailPrice:'5.90'}]}));
 }});
 const result=await f.usecase.applyDetails(f.input),saved=await f.repository.readSnapshot();assert.equal(result.status,'blocked');
 assert.equal(result.failureClass,'APPLICATION_FACTS_INCOMPLETE');assert.deepEqual(saved.candidates,f.before.candidates);
 assert.deepEqual(saved.runtime.aProductDetailReceipts,f.before.runtime.aProductDetailReceipts);
 assert.equal(detailJobs(saved)[0].status,'completed');assert.equal(Object.values(saved.runtime.aProductDetailReceipts)[0].steps[0].result.facts.currentPrice,'unknown');
 assert.deepEqual(await f.usecase.applyDetails(f.input),result);
});

test('unexpected local candidate materialization faults preserve failure and rethrow the original value without retry',async()=>{
 for(const original of [new Error('private synthetic fault'),null]){
  const f=await completed();let injections=0;
  // Inject an actual local materialization failure only for this transaction,
  // restoring its input before persistence so no test accessor enters the state.
  const repository={...f.repository,transact:mutator=>f.repository.transact(async document=>{
   const candidate=document.candidates[0],descriptor=Object.getOwnPropertyDescriptor(candidate,'history');
   Object.defineProperty(candidate,'history',{enumerable:true,configurable:true,get(){injections++;throw original;}});
   try{return await mutator(document);}finally{Object.defineProperty(candidate,'history',descriptor);}
  })};
  const usecase=createAProductDetailApplicationUseCase({repository,serverClock:f.clock});let caught=false;
  try{await usecase.applyDetails(f.input);}catch(error){caught=true;assert.equal(error,original);}
  assert.equal(caught,true);assert.equal(injections,1);
  const saved=await f.repository.readSnapshot(),record=saved.runtime.aProductDetailApplications[`${f.input.candidateId}:${f.input.sourceRevision}`];
  assert.equal(record.status,'failed');assert.equal(record.failureClass,'UNEXPECTED_SYSTEM_ERROR');assert.deepEqual(saved.candidates,f.before.candidates);
  assert.deepEqual(saved.runtime.aProductDetailReceipts,f.before.runtime.aProductDetailReceipts);assert.equal(JSON.stringify(saved).includes('private synthetic fault'),false);
  assert.deepEqual(await usecase.applyDetails(f.input),record);assert.equal(injections,1);assert.deepEqual(f.counts(),{secrets:2,requests:2});
 }
});

test('with team accounts the tester reads the details of a product from a boss\'s batch under their own permits, and the details apply',async()=>{
 const TESTER='team-user:00000000-0000-4000-8000-000000000003';
 const f=await createAProductDetailRuntimeFixture({ownerUserId:'team-user:00000000-0000-4000-8000-000000000001'});
 const tester=createActorContext({authenticatedAt:f.clock(),userId:TESTER,sessionId:'team-session:tester',actorType:'human',roles:['operator'],source:'authenticated_identity_provider'});
 const outsider=createActorContext({authenticatedAt:f.clock(),userId:'owner:someone-else',sessionId:'session:outsider',actorType:'human',roles:['owner'],source:'authenticated_identity_provider'});
 const {service}=f.create({onDetailsReady:async()=>({status:'application_paused_for_test'})});
 await assert.rejects(service.authorizeAndRun({actor:outsider,input:f.input}),/OWNER_CONFLICT/);
 assert.equal((await service.authorizeAndRun({actor:tester,input:f.input})).status,'completed');
 assert.equal((await service.runDue()).status,'completed');await service.stop();
 const saved=await f.repository.readSnapshot();
 assert.deepEqual([...new Set(detailJobs(saved).flatMap(job=>[job.ownerUserId,job.requestedByUserId]))],[TESTER]);
 assert.deepEqual([...new Set(saved.runtime.softwareJobAuthorizationRecords.filter(value=>value.action==='a_product_detail_read').map(value=>value.authorizedByUserId))],[TESTER]);
 const usecase=createAProductDetailApplicationUseCase({repository:f.repository,serverClock:f.clock});
 const result=await usecase.applyDetails({candidateId:f.candidate.id,sourceRevision:f.candidate.dataRevision});
 assert.equal(result.status,'applied');
});
