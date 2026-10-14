import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedFixture, capabilities as formalCapabilities } from './helpers/d-software-fixture.mjs';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createDBatchImportSoftwareService } from '../lib/d-batch-import-software-service.mjs';
import { OZON_DE_READBACK_ENDPOINTS } from '../lib/ozon-seller-api-de-adapter.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { createDBatchOfferRecord, createDBatchEReadback } from '../lib/d-batch-offer-readback.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';

const now = '2026-08-22T07:25:00.000Z';
const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1',
  policyRef: 'policy:synthetic:batch-observation', version: 'v1', maxQueries: 10,
  intervalMs: 0, expiresAt: '2026-09-01T00:00:00.000Z', requestTimeoutMs: 10_000 };

async function fixture({stockFree=0,stockReceipt='accepted',eMissingAttributes=false}={}) {
  let currentTime = now;
  const source = await preparedFixture();
  const request = source.prepared.executableRequest;
  const candidate = { id: source.fixture.candidateId, dataRevision: source.fixture.candidateRevision,
    targetPlatform: 'ozon', targetStore: request.store, storeRef: structuredClone(request.storeRef),
    sourceCapture: { skuChoices: [{ sourceSkuId: request.supplierSkuId, attributes: { 颜色: 'black' } }] },
    siblingSourceV1: { parentCardBinding: { model: 'synthetic-model' } },
    lifecycleV11: { skuPackage: structuredClone(source.fixture.skuPackage) } };
  const batch = { schemaVersion: 'd-batch-production-authorization-v1', batchId: 'd-batch:service-test',
    confirmedAt:now,storeRef: structuredClone(request.storeRef), status: 'authorized', externalRequestState: 'not_sent',
    excludedOfferIds: ['FIRST-EXCLUDED'], members: [{ candidateId: candidate.id,
      skuPackageId: request.skuPackageId, offerId: request.merchantSku,
      resultRevision: candidate.dataRevision, authorizationId: source.authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(source.authorization), status: 'authorized', taskId: null,
      productId: null }] };
  const document = initialBusinessStateDocument({ now });
  document.candidates = [candidate];
  document.runtime.dProductionBatches = [batch];
  const repository = createMemoryBusinessStateRepository(document);
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:batch-service', version: 'v1',
    capabilities: ['ozon-production-execution','ozon-independent-readback'], observedAt: now });
  const capability = formalCapabilities(request.store, source.authorization.lockedScope.finalUploads, request);
  capability.warehouseId = request.inventoryWrite.warehouseId;
  capability.inspectedAt = now;
  capability.productImport = { status: 'verified', protocolVersion: 'ozon-product-import-v3',
    evidenceRef: 'evidence:synthetic:import-limit', endpoint: '/v3/product/import',
    statusEndpoint: '/v1/product/import/info', maxItemsPerRequest: 10,
    limitEvidenceRef: 'synthetic:batch-limit',
    limitObservedAt: '2026-08-22T07:00:00.000Z',
    validUntil: '2026-09-01T00:00:00.000Z' };
  capability.independentReadback={status:'verified',evidenceRef:'evidence:synthetic:readback',
    protocolVersion:'ozon-independent-readback-v2',endpoints:structuredClone(OZON_DE_READBACK_ENDPOINTS)};
  const inspection = ozonDEPreflightEvidenceFixture().record.inspection;
  const calls = [];
  let stockWriteSent=false;
  let writeEvidenceUnavailable=false;
  const serviceOptions = { repository, runtimeMode: 'local_development',
    workerRegistry, serverClock: () => currentTime,
    services: new Map([[source.currentProductionBinding.bindingId,
      { worker: workerRegistry.get('worker:batch-service') }]]),
    loadCurrentProductionBinding: () => source.currentProductionBinding,
    loadBatchObservationPolicy: () => observationPolicy,
    loadBatchMemberEvidence: async () => {
      if(writeEvidenceUnavailable)throw new Error('PRODUCTION_EXECUTION_BINDING_UNVERIFIED');
      return { capabilities: structuredClone(capability),
        inspection: structuredClone(inspection), checkedAt: now };
    },
    loadBatchEReadEvidence: async () => ({ capabilities: structuredClone(capability), checkedAt: now }),
    requestJson: async requestJson => { calls.push(requestJson);
      if(requestJson.endpoint==='/v3/product/import')return {result:{task_id:9001}};
      if(requestJson.endpoint==='/v1/product/import/info')return {result:{items:[
        {offer_id:request.merchantSku,product_id:94001,status:'imported',errors:[]}]}};
      if(requestJson.endpoint==='/v3/product/info/list')return {items:[{offer_id:request.merchantSku,
        product_id:94001,errors:[],is_archived:false,is_autoarchived:false,
        primary_image:[request.finalUploads[0].platformAcceptedUrl],
        images:request.finalUploads.slice(1).map(asset=>asset.platformAcceptedUrl),
        statuses:{status:'price_sent',moderate_status:'approved',validation_status:'success'}}]};
      if(requestJson.endpoint==='/v4/product/info/attributes')return {result:eMissingAttributes?[]:
        [{offer_id:request.merchantSku,product_id:94001}]};
      if(requestJson.endpoint==='/v5/product/info/prices')return {items:[{offer_id:request.merchantSku,
        product_id:94001,price:{price:request.platformWritePrice.amount,currency_code:'CNY'}}]};
      if(requestJson.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return {
        products:[{offer_id:request.merchantSku,product_id:94001,sku:194001,
          warehouse_id:Number(request.inventoryWrite.warehouseId),
          free_stock:stockWriteSent?request.stock:stockFree,
          present:stockWriteSent?request.stock:stockFree,reserved:0}],
        has_next:false,cursor:''};
      if(requestJson.endpoint==='/v2/products/stocks'){
        const saved=await repository.readSnapshot();
        assert.equal(saved.runtime.dBatchStockJobs[0].status,'stock_intent');
        assert.ok(saved.runtime.dBatchStockJobs[0].stockIntentAt);
        if(stockReceipt==='transport_unknown')throw new Error('SYNTHETIC_RESPONSE_LOST');
        stockWriteSent=stockReceipt==='accepted';
        return {result:[{offer_id:request.merchantSku,product_id:94001,
          warehouse_id:Number(request.inventoryWrite.warehouseId),
          updated:stockReceipt==='accepted',errors:[]}]};
      }
      throw new Error('Synthetic endpoint not configured');
    } };
  const service = createDBatchImportSoftwareService(serviceOptions);
  return { repository, service, capability, inspection, calls, batch, request, candidateId: candidate.id,
    expireWriteEvidence:()=>{writeEvidenceUnavailable=true;},
    restartService: () => createDBatchImportSoftwareService(serviceOptions),
    advanceClock: value => { currentTime = value; workerRegistry.heartbeat({ workerId: 'worker:batch-service',
      version: 'v1', capabilities: ['ozon-production-execution','ozon-independent-readback'], status: 'online' }); } };
}
async function seedV2ObservedImport(f,inventoryAction){
  await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  await f.repository.transact(document=>{
    const batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v2';
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v1',inventoryAction,
      eReadbackOfferIds:batch.members.map(member=>member.offerId)};
    return {changed:true,document,result:null};
  });
  await f.service.observeBatchChunk({batchId:f.batch.batchId,chunkIndex:0});
}

test('software service requires a current batch limit before admission and sends no request', async () => {
  const f = await fixture();
  delete f.capability.productImport.maxItemsPerRequest;
  await assert.rejects(f.service.runAuthorizedBatch({ batchId: f.batch.batchId }),
    /D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs, undefined);
});
test('new batch authorization scope runs an explicit create-only import and software readback',async()=>{
  const f=await fixture();
  await f.repository.transact(document=>{
    const batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v2';
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',
      eReadbackOfferIds:batch.members.map(member=>member.offerId)};
    return {changed:true,document,result:null};
  });
  const started=await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  assert.equal(started.status,'waiting_platform');
  assert.equal((await f.service.runDueBatchContinuations()).status,'imported_awaiting_inventory');
  const e=await f.service.runDueBatchContinuations();
  assert.equal(e.status,'card_observed_pending_inventory');
  assert.equal((await f.service.runDueBatchContinuations()).status,'idle');
  assert.equal(f.calls.filter(call=>call.write).length,1);
  assert.equal((await f.service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'idempotent_replay');
  assert.equal(f.calls.filter(call=>call.write).length,1);
});

test('software service starts one persisted import task and duplicate start cannot resend', async () => {
  const f = await fixture();
  const first = await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  assert.equal(first.status, 'waiting_platform');
  assert.equal(f.calls.filter(call => call.write).length, 1);
  delete f.capability.productImport.maxItemsPerRequest;
  const replay = await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  assert.equal(replay.status, 'idempotent_replay');
  assert.equal(f.calls.filter(call => call.write).length, 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].taskId, '9001');
});

test('software service records the offer observation without claiming inventory or E success', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.capability.productImport.validUntil = '2026-08-22T07:20:00.000Z';
  const observed = await f.service.observeBatchChunk({ batchId: f.batch.batchId, chunkIndex: 0 });
  assert.equal(observed.status, 'imported_awaiting_inventory');
  assert.equal(observed.results[0].classification, 'imported');
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dProductionBatches[0].members[0].status, 'imported_awaiting_inventory_and_e');
  const sku = saved.candidates.find(candidate => candidate.id === f.candidateId).lifecycleV11.skuPackage;
  assert.equal(sku.productionRecord, null);
  assert.equal(sku.eVerificationRecord, null);
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('an expired lease can be reclaimed without fresh import limit evidence', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const reclaimed = await f.service.reclaimBatchLease({ batchId: f.batch.batchId });
  assert.equal(reclaimed.status, 'waiting_platform');
  assert.equal(reclaimed.chunks[0].taskId, '9001');
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('restarted software pump recovers only a saved task and never resends its import', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.capability.productImport.validUntil = '2026-08-22T07:20:00.000Z';
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const restarted = f.restartService();
  const result = await restarted.runDueBatchObservations();
  assert.equal(result.status, 'imported_awaiting_inventory');
  assert.deepEqual(f.calls.map(call => call.write), [true, false]);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].observationReads, 1);
});
test('historical v2 import job remains observable after a cold service restart',async()=>{
  const f=await fixture();
  await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  await f.repository.transact(document=>{
    document.runtime.dBatchImportJobs[0].schemaVersion='d-batch-import-job-v2';
    return {changed:true,document,result:null};
  });
  const observed=await f.restartService().runDueBatchObservations();
  assert.equal(observed.status,'imported_awaiting_inventory');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].schemaVersion,
    'd-batch-import-job-v2');
  assert.deepEqual(f.calls.map(call=>call.write),[true,false]);
});
test('create-only imported offer performs no stock precheck or stock write',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  assert.equal((await f.service.runDueBatchStockPrerequisites()).status,'idle');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchStockJobs[0].status,'inventory_deferred');
  assert.deepEqual(f.calls.map(call=>call.write),[true,false]);
});

test('authorized stock branch persists one exact prerequisite read and refuses nonzero stock',async()=>{
  for(const stockFree of [0,100]){
    const f=await fixture({stockFree});
    await seedV2ObservedImport(f,'write_authorized_stock');
    const first=await f.service.runDueBatchStockPrerequisites();
    assert.equal(first.status,stockFree===0?'ready_to_write':'needs_owner');
    assert.equal((await f.repository.readSnapshot()).runtime.dBatchStockJobs[0].prerequisiteReads,1);
    assert.equal((await f.service.runDueBatchStockPrerequisites()).status,'idle');
    assert.deepEqual(f.calls.map(call=>call.write),[true,false,false,false]);
  }
});
test('authorized stock sends once after durable intent; restart cannot replay accepted or unknown receipt',async()=>{
  for(const stockReceipt of ['accepted','incomplete']){
    const f=await fixture({stockReceipt});
    await seedV2ObservedImport(f,'write_authorized_stock');
    assert.equal((await f.service.runDueBatchStockPrerequisites()).status,'ready_to_write');
    const first=await f.service.runDueBatchStockWrites();
    assert.equal(first.status,stockReceipt==='accepted'?'stock_accepted':'unknown_outcome');
    const saved=await f.repository.readSnapshot();
    assert.ok(saved.runtime.dBatchStockJobs[0].stockIntentAt);
    assert.equal(saved.runtime.dBatchStockJobs[0].status,first.status);
    assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
    assert.equal((await f.restartService().runDueBatchStockWrites()).status,'idle');
    assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
  }
});
test('per-offer E distinguishes card creation without stock from authorized stock readback',async()=>{
  for(const inventoryAction of ['create_only','write_authorized_stock']){
    const f=await fixture();
    await seedV2ObservedImport(f,inventoryAction);
    if(inventoryAction==='write_authorized_stock'){
      await f.service.runDueBatchStockPrerequisites();
      await f.service.runDueBatchStockWrites();
    }
    const saved=await f.repository.readSnapshot();
    const batch=saved.runtime.dProductionBatches[0],chunk=saved.runtime.dBatchImportJobs[0].chunks[0];
    const record=createDBatchOfferRecord({batch,member:batch.members[0],chunkIndex:0,
      stockJob:saved.runtime.dBatchStockJobs[0],source:chunk.frozenImport.memberSources[0],
      frozenImport:chunk.frozenImport,chunkOfferIds:chunk.offerIds,
      importObservation:chunk.results[0].importObservation,createdAt:now});
    assert.equal(record.inventoryModified,inventoryAction==='write_authorized_stock');
    const media=record.readbackExpectation.media.map(item=>item.submittedUrl);
    const observation={platform:'ozon',store:record.store,storeRef:record.storeRef,
      warehouseRef:record.warehouseRef,credentialAlias:record.credentialAlias,
      skuPackageId:record.skuPackageId,supplierSkuId:record.supplierSkuId,
      merchantSku:record.offerId,platformProductId:record.productId,
      currentPrice:record.expectedPrice,currentStock:inventoryAction==='create_only'?'unknown':record.expectedStock,
      imageCount:media.length,errors:[],platformEvidenceRef:'receipt:synthetic:independent-readback',
      mediaObservation:{sourceProtocol:'ozon-product-info-v3',primaryImageUrl:media[0],images:media.slice(1)},
      inventoryObservation:{sourceProtocol:'ozon-product-stocks-by-warehouse-fbs-v2',hasNext:false,
        rows:inventoryAction==='create_only'?[]:[{warehouseId:record.warehouseId,productId:record.productId,
          sku:'194001',offerId:record.offerId,freeStock:record.expectedStock,present:record.expectedStock,reserved:0}]}};
    const e=createDBatchEReadback({record,observation,readAt:now});
    assert.equal(e.status,inventoryAction==='create_only'?'card_observed_pending_inventory':'card_and_stock_observed');
    assert.equal(e.listedVerified,false);
    const drift=createDBatchEReadback({record,observation:{...observation,platformProductId:'999999'},readAt:now});
    assert.equal(drift.status,'not_verified');
    assert.ok(drift.gaps.includes('platformProductId'));
  }
});
test('software E persists one independent per-offer readback for each frozen inventory action',async()=>{
  for(const inventoryAction of ['create_only','write_authorized_stock']){
    const f=await fixture();
    await seedV2ObservedImport(f,inventoryAction);
    if(inventoryAction==='write_authorized_stock'){
      await f.service.runDueBatchStockPrerequisites();
      await f.service.runDueBatchStockWrites();
    }
    const result=await f.service.runDueBatchEReadbacks();
    assert.equal(result.status,inventoryAction==='create_only'?
      'card_observed_pending_inventory':'card_and_stock_observed');
    assert.equal(result.result.listedVerified,false);
    const saved=await f.repository.readSnapshot();
    assert.equal(saved.runtime.dBatchOfferRecords.length,1);
    assert.equal(saved.runtime.dBatchEReadbacks.length,1);
    assert.equal(saved.runtime.dBatchEJobs[0].status,'completed');
    assert.equal(saved.runtime.dProductionBatches[0].members[0].status,result.status);
    const view=projectDBatchExecutionView(saved,f.batch.batchId);
    assert.equal(view.members[0].eStatus,result.status);
    assert.equal(view.members[0].inventoryStatus,inventoryAction==='create_only'?'inventory_deferred':'stock_accepted');
    assert.equal(view.members[0].listedVerified,false);
    assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
    assert.equal(f.calls.filter(call=>call.write).length,
      inventoryAction==='create_only'?1:2);
  }
});
test('saved import E remains read-only after write qualification expires, but needs current read authority',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  f.expireWriteEvidence();
  f.capability.status='not_ready';
  f.capability.inventoryWrite.status='expired';
  f.inspection.permissionStatus='denied';
  const observed=await f.restartService().runDueBatchEReadbacks();
  assert.equal(observed.status,'card_observed_pending_inventory');
  assert.equal(f.calls.filter(call=>call.write).length,1);
  const denied=await fixture();
  await seedV2ObservedImport(denied,'create_only');
  denied.capability.independentReadback.status='expired';
  const before=denied.calls.length;
  await assert.rejects(()=>denied.restartService().runDueBatchEReadbacks(),
    /D_BATCH_E_READ_EVIDENCE_NOT_READY/);
  assert.equal(denied.calls.length,before);
  assert.equal((await denied.repository.readSnapshot()).runtime.dBatchEJobs,undefined);
});
test('E refuses a changed frozen import source before creating an offer record or reading the platform',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  await f.repository.transact(document=>{
    document.runtime.dBatchImportJobs[0].chunks[0].frozenImport.memberSources[0].stock+=1;
    return {changed:true,document,result:null};
  });
  const before=f.calls.length;
  await assert.rejects(()=>f.restartService().runDueBatchEReadbacks(),
    /D_BATCH_FROZEN_IMPORT_INVALID/);
  assert.equal(f.calls.length,before);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchOfferRecords,undefined);
  assert.equal(saved.runtime.dBatchEJobs,undefined);
});
test('explicit stock scope pumps import, prerequisite, stock and E without a second import',async()=>{
  const f=await fixture();
  await f.repository.transact(document=>{
    const batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v2';
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v1',
      inventoryAction:'write_authorized_stock',
      eReadbackOfferIds:batch.members.map(member=>member.offerId)};
    return {changed:true,document,result:null};
  });
  assert.equal((await f.service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'waiting_platform');
  assert.equal((await f.service.runDueBatchContinuations()).status,'imported_awaiting_inventory');
  assert.equal((await f.service.runDueBatchContinuations()).status,'ready_to_write');
  assert.equal((await f.service.runDueBatchContinuations()).status,'stock_accepted');
  assert.equal((await f.service.runDueBatchContinuations()).status,'card_and_stock_observed');
  assert.equal((await f.service.runDueBatchContinuations()).status,'idle');
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/import').length,1);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});
test('a restarted process only reads saved work until the owner resumes unsent stock',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const restarted=f.restartService();
  assert.equal((await restarted.runDueBatchContinuations()).status,'idle');
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,0);
  assert.equal((await restarted.resumeAuthorizedBatchContinuations({batchId:f.batch.batchId})).status,
    'continuation_activated');
  assert.equal((await restarted.runDueBatchContinuations()).status,'stock_accepted');
  assert.equal((await restarted.runDueBatchContinuations()).status,'card_and_stock_observed');
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});

test('an unknown stock receipt stops E and cannot be resumed as an unsent write',async()=>{
  const f=await fixture({stockReceipt:'incomplete'});
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  assert.equal((await f.service.runDueBatchStockWrites()).status,'unknown_outcome');
  const restarted=f.restartService();
  assert.equal((await restarted.runDueBatchContinuations()).status,'idle');
  await assert.rejects(restarted.resumeAuthorizedBatchContinuations({batchId:f.batch.batchId}),
    /RESUME_NOTHING_UNSENT/);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchEReadbacks,undefined);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});
test('create-only missing independent product readback remains unverified without a stock write',async()=>{
  const f=await fixture({eMissingAttributes:true});
  await seedV2ObservedImport(f,'create_only');
  const failed=await f.service.runDueBatchEReadbacks();
  assert.equal(failed.status,'read_failed');
  assert.equal(failed.result.status,'not_verified');
  assert.equal(failed.result.listedVerified,false);
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
  assert.equal(f.calls.filter(call=>call.write).length,1);
});
