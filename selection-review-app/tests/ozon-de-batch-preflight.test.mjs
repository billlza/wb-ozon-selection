import test from 'node:test';
import assert from 'node:assert/strict';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createOzonDEPreflightProvider, inspectOzonDEPreflightCapabilities,
  assertOzonDEPreflightEvidence } from '../lib/ozon-de-preflight-provider.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { assertCurrentProductionExecutionBinding } from '../lib/platform-write-preflight.mjs';
import { loadOzonProductImportBatchLimitEvidence } from '../lib/ozon-product-import-batch-limit.mjs';

const batchNow='2026-09-28T00:41:00.000Z';
function readyBatchEvidence() {
  const {context,record,scope}=ozonDEPreflightEvidenceFixture();
  record.schemaVersion='ozon-de-preflight-evidence-v4';
  record.collectedAt='2026-09-28T00:40:00.000Z';
  record.expiresAt='2026-09-29T00:40:00.000Z';
  record.protocols.inventoryWrite.prerequisitePolicy={schemaVersion:'ozon-inventory-prerequisite-policy-v1',
    policyId:'policy:synthetic:inventory',version:'synthetic-v1',
    officialEvidenceRef:'evidence:synthetic:official-inventory',
    priceSent:{endpoint:'/v3/product/info/list',field:'statuses.status',acceptedValues:['synthetic_price_sent']},
    reserved:{endpoint:'/v2/product/info/stocks-by-warehouse/fbs',sourceProtocol:'ozon-product-stocks-by-warehouse-fbs-v2'},
    stockRequest:{identityField:'offer_id',quantSize:null}};
  context.productionBinding.verification.checkedAt='2026-09-28T00:40:00.000Z';
  context.productionBinding.verification.expiresAt='2026-09-29T00:40:00.000Z';
  const candidate=context.candidate,authorization=candidate.lifecycleV11.skuPackage.productionAuthorization;
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic:ready',status:'authorized',
    members:[{candidateId:candidate.id,skuPackageId:authorization.lockedScope.skuPackageId,
      offerId:authorization.lockedScope.merchantSku,authorizationId:authorization.authorizationId,
      authorizationFingerprint:fingerprintCanonicalRecord(authorization),resultRevision:candidate.dataRevision}]};
  assert.deepEqual(assertOzonDEPreflightEvidence(record),record);
  assert.equal(inspectOzonDEPreflightCapabilities({candidate,authorization,scope,record,reason:null,now:batchNow}).status,'ready');
  return {candidate,record,batch,productionBinding:context.productionBinding};
}

test('ready v4 batch combines account and separate current official item limit without mutating either source',async()=>{
  const f=readyBatchEvidence(),limit=await loadOzonProductImportBatchLimitEvidence();
  const before=structuredClone(f.record);
  let limitReads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>{limitReads++;return limit;}});
  const result=await provider.loadBatchMemberEvidence(f);
  assert.equal(result.capabilities.status,'ready');
  assert.equal(result.capabilities.productImport.status,'verified');
  assert.equal(result.capabilities.productImport.maxItemsPerRequest,100);
  assert.equal(result.capabilities.productImport.limitEvidenceRef,limit.evidenceRef);
  assert.equal(result.capabilities.productImport.evidenceRef,f.record.protocols.productImport.evidenceRef);
  assert.notEqual(result.capabilities.productImport.evidenceRef,result.capabilities.productImport.limitEvidenceRef);
  assert.equal(result.capabilities.productImport.validUntil,limit.validUntil);
  assert.equal(Object.isFrozen(result.capabilities),true);
  assert.equal(Object.isFrozen(result.capabilities.productImport),true);
  assert.equal(limitReads,1);
  assert.deepEqual(f.record,before);
});

test('batch observation never consumes the public send limit; missing or expired send evidence stops new import',async()=>{
  const f=readyBatchEvidence(),limit=await loadOzonProductImportBatchLimitEvidence();
  const observer=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>{throw new Error('OBSERVATION_READ_LIMIT');}});
  for(const purpose of ['import_observation','stock_write']){
    const observed=await observer.loadBatchMemberEvidence({...f,purpose});
    assert.equal(observed.capabilities.status,'ready');
    assert.equal(observed.capabilities.productImport.maxItemsPerRequest,null);
    assert.equal(Object.hasOwn(observed.capabilities.productImport,'limitEvidenceRef'),false);
  }
  const missing=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record});
  await assert.rejects(missing.loadBatchMemberEvidence(f),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_LIMIT_SOURCE_REQUIRED/);
  const invalid=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>null});
  await assert.rejects(invalid.loadBatchMemberEvidence(f),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  const forged=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>({...limit,sourceUrl:'https://example.test/forged-limit'})});
  await assert.rejects(forged.loadBatchMemberEvidence(f),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  f.record.expiresAt='2026-10-06T00:40:00.000Z';
  f.productionBinding.verification.expiresAt='2026-10-06T00:40:00.000Z';
  const expired=createOzonDEPreflightProvider({serverClock:()=>limit.validUntil,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>limit});
  await assert.rejects(expired.loadBatchMemberEvidence(f),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_LIMIT_NOT_CURRENT/);
  const historical=await expired.loadBatchMemberEvidence({...f,purpose:'import_observation'});
  assert.equal(historical.capabilities.status,'ready');
});

test('batch member reads only its saved authorization and scope without a single D job', async () => {
  const { context, record } = ozonDEPreflightEvidenceFixture();
  const candidate = context.candidate;
  const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
  const batch = { schemaVersion: 'd-batch-production-authorization-v1', batchId: 'd-batch:synthetic',
    status: 'authorized', members: [{ candidateId: candidate.id, skuPackageId: context.job.skuPackageId,
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(authorization), resultRevision: candidate.dataRevision }] };
  let reads = 0;
  const provider = createOzonDEPreflightProvider({ serverClock: () => '2026-08-22T07:25:00.000Z',
    readEvidence: async () => { reads++; return record; } });
  const result = await provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch,purpose:'import_observation' });
  assert.equal(reads, 1);
  assert.equal(result.capabilities.status, 'not_ready');
  assert.ok(result.capabilities.gaps.some(gap => gap.code === 'evidence_protocol_version_outdated'));
  batch.members[0].resultRevision++;
  await assert.rejects(provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch,purpose:'import_observation' }), /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads, 1);
});

test('batch E uses current read evidence after write verification expires, and rejects drift or missing read grants', async () => {
  const {context,record}=ozonDEPreflightEvidenceFixture();
  const candidate=context.candidate,authorization=candidate.lifecycleV11.skuPackage.productionAuthorization;
  assert.equal(Object.hasOwn(candidate.lifecycleV11.skuPackage,'merchantSku'),false);
  assert.ok(authorization.lockedScope.merchantSku);
  const binding=structuredClone(context.productionBinding);
  binding.verification.expiresAt='2026-08-22T07:20:00.000Z';
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic:e-read',status:'imported_awaiting_inventory',
    members:[{candidateId:candidate.id,skuPackageId:authorization.lockedScope.skuPackageId,
      offerId:authorization.lockedScope.merchantSku,authorizationId:authorization.authorizationId,
      authorizationFingerprint:fingerprintCanonicalRecord(authorization),resultRevision:candidate.dataRevision}]};
  batch.postImportScope={eReadbackOfferIds:[batch.members[0].offerId]};
  assert.throws(()=>assertCurrentProductionExecutionBinding({productionAuthorization:authorization,
    currentProductionBinding:binding,checkedAt:'2026-08-22T07:25:00.000Z'}),/PRODUCTION_EXECUTION_BINDING_UNVERIFIED/);
  record.schemaVersion='ozon-de-preflight-evidence-v3';
  record.protocols.inventoryWrite={...record.protocols.inventoryWrite,status:'denied',prerequisitePolicy:null};
  record.inspection.permissionStatus='denied';
  let reads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=> '2026-08-22T07:25:00.000Z',
    readEvidence:async scope=>{reads++;assert.deepEqual(scope,record.scope);return structuredClone(record);}});
  const input={candidate,productionBinding:binding,batch,offerId:batch.members[0].offerId};
  const ready=await provider.loadBatchEReadEvidence(input);
  assert.equal(ready.capabilities.status,'read_ready');
  assert.equal(ready.capabilities.independentReadback.status,'verified');
  assert.equal(reads,1);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,productionBinding:{...binding,warehouseId:'999999'}}),
    /OZON_DE_PREFLIGHT_EVIDENCE_READ_ROUTING_CHANGED/);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,productionBinding:{...binding,credentialAlias:'credential-alias:synthetic:other'}}),
    /OZON_DE_PREFLIGHT_EVIDENCE_READ_ROUTING_CHANGED/);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  const forgedBatch=structuredClone(batch);
  forgedBatch.members[0].offerId='UNCONFIRMED-OFFER';
  forgedBatch.postImportScope.eReadbackOfferIds=['UNCONFIRMED-OFFER'];
  await assert.rejects(provider.loadBatchEReadEvidence({...input,batch:forgedBatch,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads,1);
  record.protocols.independentReadback.status='denied';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  record.protocols.independentReadback.status='verified';
  record.inspection.storeIdentityStatus='mismatched';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(reads,3);
  record.inspection.storeIdentityStatus='matched';
  record.expiresAt='2026-08-22T07:25:00.000Z';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(reads,4);
});
