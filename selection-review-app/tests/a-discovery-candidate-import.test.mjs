import test from 'node:test';
import assert from 'node:assert/strict';
import { createADiscoveryRuntimeFixture } from './fixtures/a-discovery-runtime-fixture.mjs';
import { createADiscoveryCandidateImportUseCase } from '../lib/a-discovery-candidate-import.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';

async function completed({ products = null } = {}) {
  const f = createADiscoveryRuntimeFixture();
  const fetchImpl = products ? async url => url.endsWith('/dld/productSearch') ? f.fetchImpl(url) :
    new Response(JSON.stringify({code:'200',errcode:200,total:products.length,products})) : f.fetchImpl;
  // Explicitly pause only the local callback. All three jobs, permits and response
  // envelopes still come from the actual service, store and provider normalizer.
  const {service} = f.create({fetchImpl,onBatchReady:async()=>({status:'awaiting_test_import'})});
  const created = await f.prepare(service);
  await f.authorize(service,created); await service.runDue(); await service.runDue(); await service.stop();
  const document = await f.repository.readSnapshot();
  assert.equal(document.runtime.softwareJobs.length,3);
  assert.ok(document.runtime.softwareJobs.every(job=>job.status==='completed'));
  assert.deepEqual(document.runtime.softwareJobAuthorizationRecords.map(p=>p.useCount),[1,1,1]);
  const input={batchId:created.batch.batchId,revision:created.batch.revision};
  return {...f,input,document,usecase:createADiscoveryCandidateImportUseCase({repository:f.repository,serverClock:f.clock,storeBindings:[]})};
}
const market = id => ({sku:id,productUrl:`https://www.ozon.ru/product/${id}`,title:'Synthetic organizer',price:297,currency:'₽'});

test('real three-request chain imports one unverified A candidate without invented supply, price, stock or profit',async()=>{
  const f=await completed(); const result=await f.usecase.importBatch(f.input);
  assert.equal(result.status,'imported');
  const saved=await f.repository.readSnapshot(),candidate=saved.candidates[0];
  assert.equal(saved.candidates.length,1); assert.equal(candidate.aDiscoveryEvidenceV1.exactSkuMatch,'unknown');
  for(const key of ['purchasePriceRmb','domesticShippingRmb','packagingCostRmb','expectedPriceRub','sellerRevenueCny','defaultStock']) assert.equal(candidate[key],null,key);
  assert.equal(candidate.imageUrl,''); assert.equal(candidate.lifecycle,undefined); assert.equal(candidate.listingPreparation,null);
  assert.equal(candidate.executionRuntime.businessPhase,'A'); assert.equal(candidate.processing.state,'idle');
  assert.equal(candidate.aDiscoveryEvidenceV1.supplierReceiptRefs.length,2);
  const bytes=JSON.stringify(saved); assert.deepEqual(await f.usecase.importBatch(f.input),result);
  assert.equal(JSON.stringify(await f.repository.readSnapshot()),bytes); assert.deepEqual(f.counts(),{secrets:3,requests:3});
  const cold=createMemoryBusinessStateRepository(JSON.parse(bytes));
  const retry=createADiscoveryCandidateImportUseCase({repository:cold,serverClock:f.clock,storeBindings:[]});
  assert.deepEqual(await retry.importBatch(f.input),result); assert.equal(JSON.stringify(await cold.readSnapshot()),bytes);
});

test('historical eliminated slug URLs are never revived and ordered selection skips duplicates',async()=>{
  for(const all of [false,true]) {
    const f=await completed({products:[market(2107989735),market(2107989736)]});
    const historical=[{id:'old:eliminated',workflowStatus:'eliminated',productUrl:'https://www.ozon.ru/product/old-organizer-2107989735/?from=archive',eliminationReason:'owner rejected'}];
    if(all) historical.push({id:'old:second',workflowStatus:'eliminated',competitorUrl:'https://ozon.ru/product/2107989736'});
    await f.repository.transact(document=>{document.candidates=structuredClone(historical);return {document,changed:true};});
    const result=await f.usecase.importBatch(f.input),saved=await f.repository.readSnapshot();
    assert.equal(result.status,all?'all_duplicates':'imported');
    assert.deepEqual(saved.candidates.slice(all?0:1),historical);
    if(!all) assert.equal(result.marketProductId,'2107989736');
  }
});

test('tampered job, response and permission cannot import and leave a persistent blocked record',async()=>{
  for(const field of ['job','receipt','permit']) {
    const f=await completed();
    await f.repository.transact(document=>{
      const job=document.runtime.softwareJobs[0];
      if(field==='job')job.resultEnvelope.payload.receiptRef='receipt:wrong';
      if(field==='receipt')document.runtime.aDiscoveryReceipts[job.jobId].scope.requestIndex=1;
      if(field==='permit')document.runtime.softwareJobAuthorizationRecords=[];
      return {document,changed:true};
    });
    let result;
    if(field==='job'){
      await assert.rejects(()=>f.usecase.importBatch(f.input),/COMPLETED_RESULT_CONFLICT/);
      result=(await f.repository.readSnapshot()).runtime.aDiscoveryCandidateImports[`${f.input.batchId}:${f.input.revision}`];
      assert.equal(result.status,'failed');
    }else{result=await f.usecase.importBatch(f.input);assert.equal(result.status,'blocked',field);}
    const bytes=JSON.stringify(await f.repository.readSnapshot()); assert.equal(JSON.parse(bytes).candidates.length,0);
    assert.deepEqual(await f.usecase.importBatch(f.input),result); assert.equal(JSON.stringify(await f.repository.readSnapshot()),bytes);
    assert.deepEqual(f.counts(),{secrets:3,requests:3});
  }
});

test('unknown local import errors including null persist failure before original throw, and cold replay never retries',async()=>{
  for(const original of [new Error('synthetic private fault'),null]) {
    const f=await completed(); let calls=0; const storeBindings=[];
    storeBindings.find=()=>{calls++;throw original;};
    const usecase=createADiscoveryCandidateImportUseCase({repository:f.repository,serverClock:f.clock,storeBindings});
    let thrown=false;
    try{await usecase.importBatch(f.input);}catch(error){thrown=true;assert.equal(error,original);}
    assert.equal(thrown,true); assert.equal(calls,1);
    const saved=await f.repository.readSnapshot(),record=saved.runtime.aDiscoveryCandidateImports[`${f.input.batchId}:${f.input.revision}`];
    assert.equal(record.status,'failed'); assert.equal(record.failureClass,'UNEXPECTED_SYSTEM_ERROR'); assert.equal(saved.candidates.length,0);
    assert.equal(JSON.stringify(saved).includes('synthetic private fault'),false);
    assert.deepEqual(await usecase.importBatch(f.input),record); assert.equal(calls,1);
    assert.deepEqual(f.counts(),{secrets:3,requests:3});
  }
});

test('owner-selected products import from a completed batch with the same duplicate rules and one record per product',async()=>{
  const f=await completed({products:[market(3100000001),market(3100000002),market(3100000003)]});
  const first=await f.usecase.importBatch(f.input); assert.equal(first.marketProductId,'3100000001');
  const ownerId=(await f.repository.readSnapshot()).runtime.aDiscoveryBatches[f.input.batchId].ownerUserId;
  const pick=id=>f.usecase.importSelectedProduct({...f.input,marketProductId:id,selectedByUserId:ownerId});
  const second=await pick('3100000002'); assert.equal(second.status,'imported'); assert.match(second.candidateId,/^candidate:/);
  const saved=await f.repository.readSnapshot(); assert.equal(saved.candidates.length,2);
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV1.marketProductId,'3100000002'); assert.equal(saved.candidates[0].source,'software');
  assert.match(saved.candidates[0].history.at(-1).detail,/主人从已批准发现批次/);
  for(const key of ['purchasePriceRmb','domesticShippingRmb','packagingCostRmb','expectedPriceRub','sellerRevenueCny']) assert.equal(saved.candidates[0][key],null,key);
  const bytes=JSON.stringify(saved); assert.deepEqual(await pick('3100000002'),second); assert.equal(JSON.stringify(await f.repository.readSnapshot()),bytes);
  const duplicate=await pick('3100000001'); assert.equal(duplicate.status,'all_duplicates'); assert.equal(duplicate.candidateId,null);
  await assert.rejects(pick('3100000009'),error=>error.code==='IMPORT_INPUT_INVALID');
  await assert.rejects(f.usecase.importSelectedProduct({...f.input,marketProductId:'3100000003',selectedByUserId:'user:someone-else'}),error=>error.code==='OWNER_CONFLICT');
  const after=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(after.runtime.aDiscoveryCandidateSelections).map(key=>key.split(':').at(-1)).sort(),['3100000001','3100000002']);
  assert.equal(after.candidates.length,2);
});
