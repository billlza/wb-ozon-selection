import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormalC1C2Fixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { createC2SoftwareContainer, prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { finalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { prepareC1FinalPlanRevision } from '../lib/c1-final-plan-revision-preparation.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createC1OzonAttributeMappingUseCase, applySavedDictionaryMappingToPreparedRevision } from '../lib/c1-ozon-attribute-mapping-use-case.mjs';
const AT = '2026-08-22T02:04:00.000Z';
const actor = createActorContext({ userId:'synthetic-owner', sessionId:'synthetic:mapping', actorType:'human', roles:['owner'], source:'authenticated_identity_provider', authenticatedAt:AT });
function fixture() {
  const formal = createFormalC1C2Fixture({ at: AT });
  const source = structuredClone(formal.merged.skuPackage);
  const schema = source.c1ProductPlan.inputSnapshots.platformSchemaRules;
  schema.attributes = [
    {fieldKey:'4967',label:'Материал',required:false,dictionaryId:1503},
    {fieldKey:'9048',label:'Модель',required:false,dictionaryId:0}
  ];
  source.ozonAttributeMappingsV1 = {schemaVersion:'c1-ozon-attribute-mapping-v1', schemaRevision:schema.schemaRevision,
    confirmationRef:'owner-mapping:synthetic:old', confirmedBy:'synthetic-owner', confirmedAt:AT,
    mappings:[{attributeId:'9048',attributeLabel:'Модель',dictionaryId:0,value:'Поезд',dictionaryValueId:null,
      sourceFactPath:'productAttributes.supplierAttributes.1.fact',sourceFactValue:source.c1ProductPlan.productAttributes.supplierAttributes[1].fact.value,
      dictionaryEvidenceRef:'dictionary:synthetic:old'}]};
  const c2 = createC2SoftwareContainer({skuPackage:source,expectedDataRevision:source.dataRevision,
    assetRegions:{collected:[],aiDrafts:[],finalUploads:[]},createdAt:AT}).skuPackage;
  const manifest = prepareC2FinalUploadManifest({skuPackage:c2,expectedDataRevision:c2.dataRevision,finalUploadAssets:finalAssets(),preparedAt:AT});
  const confirmed = confirmC2SoftwareFinalUploads({skuPackage:c2,expectedDataRevision:c2.dataRevision,finalManifest:manifest,ownerDecision:ownerDecision(manifest),confirmedAt:AT});
  const candidate = structuredClone(formal.candidate);
  candidate.targetPlatform='ozon';
  candidate.lifecycleV11.skuPackage=structuredClone(createFinalProductPlanConfirmationCard({skuPackage:confirmed.skuPackage,createdAt:AT}).skuPackage);
  candidate.cargoFactsV1={schemaVersion:'candidate-cargo-facts-v1',declaredBy:'owner',declaredRevision:candidate.dataRevision,declaredAt:AT,
    facts:{batteryType:'none',batteryEnergyWh:null,generalCargo:true,personalUse:true,irregularShape:false,sourceRef:`owner-cargo-facts:${candidate.id}:${candidate.dataRevision}:${AT}`}};
  const prepared=prepareC1FinalPlanRevision({candidate,expectedRevision:candidate.dataRevision,preparedAt:AT}).candidate;
  const life=prepared.lifecycleV11, sku=life.skuPackage, prep=life.c1FinalPlanRevisionPreparation;
  const receipt={schemaVersion:'c1-ozon-dictionary-read-receipt-v1',receiptId:'dictionary-receipt:synthetic:1',status:'completed',
    candidateId:prepared.id,skuPackageId:sku.skuPackageId,sourceCandidateRevision:prep.sourceCandidateRevision,sourceC1PlanId:prep.sourceC1PlanId,
    schemaRevision:schema.schemaRevision,platform:'ozon',storeRef:structuredClone(sku.g1Identity.storeRef),
    descriptionCategoryId:schema.descriptionCategoryId,typeId:schema.typeId,attributeId:4967,query:'ДВП',checkedAt:AT,
    requestedAt:AT,httpStatus:200,sourceRef:'dictionary-query:synthetic:1',exactMatch:{id:125,value:'ДВП'},requestCount:1,ownerInstructionRef:'user-instruction:synthetic:dictionary'};
  life.c1OzonDictionaryReadReceipts=[receipt];
  const input={candidateId:prepared.id,skuPackageId:sku.skuPackageId,expectedRevision:prepared.dataRevision,receiptId:receipt.receiptId,
    mapping:{attributeId:'4967',value:'ДВП',sourceFactPath:'productAttributes.supplierAttributes.0.fact'},idempotencyKey:'mapping:prepared:1',auditEventId:'audit:mapping:prepared:1'};
  return {candidate:prepared,input};
}
function runner(candidate) {
  const repository=createMemoryBusinessStateRepository({candidates:[candidate]}); let reads=0;
  const useCase=createC1OzonAttributeMappingUseCase({repository,runtimeMode:'local_development',serverClock:()=>AT,
    readDictionaryValue:async()=>{reads+=1;throw new Error('unexpected external dictionary read');}});
  return {repository,useCase,reads:()=>reads};
}
test('prepared revision upserts saved exact dictionary receipt without querying, preserves inputs and prior mappings',async()=>{
  const f=fixture(), original=structuredClone(f.candidate), r=runner(f.candidate);
  const out=await r.useCase.mapPreparedRevision({actor,input:f.input}), sku=out.candidate.lifecycleV11.skuPackage;
  assert.equal(out.status,'committed');assert.equal(r.reads(),0);
  assert.deepEqual(f.candidate,original);
  assert.equal(out.candidate.dataRevision,original.dataRevision+1);
  assert.equal(sku.c1ProductPlan.status,'facts_checked');
  assert.deepEqual(sku.c1ProductPlan.sourceFactsRevision,original.lifecycleV11.skuPackage.c1ProductPlan.sourceFactsRevision);
  assert.deepEqual(sku.c1ProductPlan.inputSnapshots,original.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots);
  assert.deepEqual(sku.profitModels,original.lifecycleV11.skuPackage.profitModels);
  assert.equal(sku.ozonAttributeMappingsV1.mappings.length,2);
  assert.equal(sku.ozonAttributeMappingsV1.mappings[0].confirmationRef,'owner-mapping:synthetic:old');
  assert.deepEqual(sku.c1ProductPlan.productAttributes.ozonAttributes.find(x=>x.fieldKey==='4967').fact.value,{value:'ДВП',dictionaryValueId:125});
  assert.equal(sku.productionAuthorization,null);
  const replay=await r.useCase.mapPreparedRevision({actor,input:f.input});
  assert.equal(replay.status,'idempotent_replay');assert.equal(r.reads(),0);
  assert.deepEqual(replay.candidate,out.candidate);
  const restored=runner(JSON.parse(JSON.stringify(out.candidate)));
  const repeated=await restored.useCase.mapPreparedRevision({actor,input:{...f.input,expectedRevision:out.candidate.dataRevision,
    idempotencyKey:'mapping:prepared:2',auditEventId:'audit:mapping:prepared:2'}});
  assert.equal(repeated.candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1.mappings.length,2);
  assert.equal(restored.reads(),0);
  assert.deepEqual(repeated.candidate.lifecycleV11.c1FinalPlanRevisionHistory,out.candidate.lifecycleV11.c1FinalPlanRevisionHistory);
});
test('pure isolated projection uses the same receipt boundary and does not claim authenticated owner identity',()=>{
  const f=fixture(), before=structuredClone(f.candidate);
  const out=applySavedDictionaryMappingToPreparedRevision({...f,confirmationRef:'user-instruction:synthetic:preview',confirmedBy:'source:user_response_annotations',observedAt:AT});
  assert.deepEqual(f.candidate,before);assert.equal(out.candidate.dataRevision,before.dataRevision);
  assert.equal(out.candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1.confirmedBy,'source:user_response_annotations');
  assert.equal(out.result.productionAuthorized,false);
});
test('mismatched, failed, future, ambiguous and multi-request receipts cannot be applied',async()=>{
  for(const change of [r=>r.status='failed',r=>r.candidateId='other',r=>r.skuPackageId='other',r=>r.sourceC1PlanId='other',
    r=>r.sourceCandidateRevision+=10,r=>r.storeRef.stableStoreId='other',r=>r.schemaRevision='other',r=>r.descriptionCategoryId+=1,
    r=>r.typeId+=1,r=>r.attributeId=10096,r=>r.query='ДВП другая',r=>r.exactMatch.value='ДВП другая',r=>r.exactMatch.id=0,
    r=>r.requestCount=2,r=>r.checkedAt='2030-01-01T00:00:00Z',r=>r.ownerInstructionRef='',r=>r.httpStatus=500,r=>r.requestedAt='2030-01-01T00:00:00Z']) {
    const f=fixture();change(f.candidate.lifecycleV11.c1OzonDictionaryReadReceipts[0]);const r=runner(f.candidate);
    await assert.rejects(r.useCase.mapPreparedRevision({actor,input:f.input}),/C1_PREPARED_MAPPING_RECEIPT_REJECTED/);
    assert.deepEqual((await r.repository.readSnapshot()).candidates[0],f.candidate);assert.equal(r.reads(),0);
  }
  const f=fixture();f.candidate.lifecycleV11.c1OzonDictionaryReadReceipts.push(structuredClone(f.candidate.lifecycleV11.c1OzonDictionaryReadReceipts[0]));
  await assert.rejects(runner(f.candidate).useCase.mapPreparedRevision({actor,input:f.input}),/RECEIPT_REJECTED/);
});
test('existing SEO request, final card, invalid lineage and old facts_checked plans are closed',async()=>{
  for(const change of [c=>c.lifecycleV11.c1AiDraftRequestV1={requestId:'existing'},c=>c.lifecycleV11.c1AiDraftJobRefV1={jobId:'existing'},
    c=>c.lifecycleV11.skuPackage.productionAuthorization={authorizationId:'existing'},c=>c.lifecycleV11.skuPackage.productionConfirmationCard={cardId:'existing'},
    c=>delete c.lifecycleV11.c1FinalPlanRevisionPreparation,c=>c.lifecycleV11.c1FinalPlanRevisionPreparation.targetC1PlanId='other',
    c=>c.lifecycleV11.c1FinalPlanRevisionHistory[0].sourceIdentity.supplierSkuId='other']) {
    const f=fixture();change(f.candidate);const r=runner(f.candidate);
    await assert.rejects(r.useCase.mapPreparedRevision({actor,input:f.input}),/LINEAGE_REJECTED/);assert.equal(r.reads(),0);
  }
});
test('unconfirmed, self-derived, nonexistent source facts and unauthorized/stale submissions fail without effects',async()=>{
  for(const path of ['productAttributes.ozonAttributes.0.fact','productAttributes.supplierAttributes.99.fact','batteryAssessment.batteryType']) {
    const f=fixture();f.input.mapping.sourceFactPath=path;const r=runner(f.candidate);
    await assert.rejects(r.useCase.mapPreparedRevision({actor,input:f.input}),/C1_PREPARED_MAPPING_/);assert.equal(r.reads(),0);
  }
  const f=fixture(),r=runner(f.candidate);
  await assert.rejects(r.useCase.mapPreparedRevision({actor:{...actor,roles:['reviewer']},input:f.input}));
  await assert.rejects(r.useCase.mapPreparedRevision({actor,input:{...f.input,expectedRevision:f.input.expectedRevision-1}}),/REVISION_CONFLICT/);
  assert.deepEqual((await r.repository.readSnapshot()).candidates[0],f.candidate);assert.equal(r.reads(),0);
});
test('source facts must remain confirmed and receipt must remain persisted rather than caller-injected',async()=>{
  const f=fixture(),fact=f.candidate.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.supplierAttributes[0].fact;
  fact.value='unknown';fact.verificationStatus='unknown';fact.reason='synthetic_not_confirmed';
  await assert.rejects(runner(f.candidate).useCase.mapPreparedRevision({actor,input:f.input}),/SOURCE_MISMATCH/);
  const missing=fixture();delete missing.candidate.lifecycleV11.c1OzonDictionaryReadReceipts;
  await assert.rejects(runner(missing.candidate).useCase.mapPreparedRevision({actor,input:missing.input}),/RECEIPT_REJECTED/);
});
test('concurrent duplicate submissions commit once and never repeat the dictionary query',async()=>{
  const f=fixture(),r=runner(f.candidate);
  const results=await Promise.all([r.useCase.mapPreparedRevision({actor,input:f.input}),r.useCase.mapPreparedRevision({actor,input:f.input})]);
  assert.deepEqual(results.map(x=>x.status).sort(),['committed','idempotent_replay']);
  const saved=await r.repository.readSnapshot();
  assert.equal(saved.candidates[0].dataRevision,f.input.expectedRevision+1);
  assert.equal(saved.runtime.idempotencyRecords.length,1);assert.equal(r.reads(),0);
});
