import assert from 'node:assert/strict';
import test from 'node:test';
import { preparedFixture, capabilities as fixtureCapabilities } from './helpers/d-software-fixture.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../lib/ozon-seller-api-de-adapter.mjs';
import { OzonDEHttpTransportError } from '../lib/ozon-de-http-configuration.mjs';

const formal=await preparedFixture();
const request=formal.prepared.executableRequest;
const capabilities={...fixtureCapabilities(request.store,request.finalUploads,request),warehouseId:request.inventoryWrite.warehouseId,
 assetTransport:{status:'verified',mode:'preapproved_stable_https',approvedHosts:[...new Set(request.finalUploads.map(asset=>new URL(asset.platformAcceptedUrl).hostname))],
  resolvedAssets:request.finalUploads.map(asset=>({...structuredClone(asset),stable:true,authorizationStatus:'approved',evidenceRef:`evidence:synthetic:${asset.assetId}`}))}};
function adapterFailure(error,failAt=0){
 const calls=[],checkpoints=[],writes=[];
 const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:capabilities,executionContext:formal.executionContext,requestJson:async call=>{
  const index=calls.length;calls.push(call.endpoint);
  if(index===failAt)throw error;
  if(call.write)writes.push(call.endpoint);
  if(index===0)return {result:{task_id:501}};
  if(index===1)return {result:{items:[{offer_id:request.merchantSku,product_id:910001,status:'imported',errors:[]}]}};
  return {result:[{offer_id:request.merchantSku,product_id:910001,warehouse_id:Number(request.inventoryWrite.warehouseId),updated:true,errors:[]}]};
 }});
 return {calls,checkpoints,writes,run:async()=>{
  const submitted=await adapter.executeSellerApi(request,{persistCheckpoint:event=>{checkpoints.push(structuredClone(event));}});
  if(failAt===0)return submitted;
  return adapter.observeImportTask({platform:'ozon',store:request.store,storeRef:request.storeRef,warehouseRef:request.warehouseRef,credentialAlias:request.credentialAlias,warehouseId:request.inventoryWrite.warehouseId,taskId:submitted.taskId,merchantSku:request.merchantSku,supplierSkuId:request.supplierSkuId,writeAllowed:false,executionKey:request.executionKey,requestReceiptRef:submitted.requestReceiptRef});
 }};
}
test('only typed first-import not_sent/not_attempted produces the original zero-write rejection DTO',async()=>{
 for(const code of ['OZON_DE_HTTP_CONFIGURATION_INVALID','OZON_DE_CREDENTIAL_VALUE_INVALID','OZON_DE_CREDENTIAL_READ_FAILED','OZON_DE_CREDENTIAL_READER_UNAVAILABLE']){
  const f=adapterFailure(new OzonDEHttpTransportError(code));const outcome=await f.run();
  assert.deepEqual(outcome,{status:'rejected_before_write',writeOccurred:false,code:'adapter_request_invalid',message:code,retryAllowed:false});
  assert.equal(f.calls.length,1);assert.equal(f.writes.length,0);assert.deepEqual(f.checkpoints.map(value=>value.kind),['import_intent']);
 }
});
test('a copied transport code, error name or mismatching transmission state cannot declare zero writes',async()=>{
 const fake=Object.assign(new Error('synthetic uncertain transport'),{name:'OzonDEHttpTransportError',code:'OZON_DE_CREDENTIAL_READ_FAILED',externalRequestState:'not_sent',requestTransmission:'not_attempted'});
 for(const error of [fake,new Error('synthetic legacy network disconnect'),
  new OzonDEHttpTransportError('OZON_DE_HTTP_REQUEST_FAILED',{externalRequestState:'unknown_outcome',requestTransmission:'attempted'}),
  new OzonDEHttpTransportError('OZON_DE_HTTP_REQUEST_FAILED',{externalRequestState:'not_sent',requestTransmission:'attempted'})]){
  const f=adapterFailure(error),outcome=await f.run();assert.equal(outcome.status,'unknown_outcome');assert.equal(outcome.writeOccurred,'unknown');
  assert.equal(outcome.layer,'product_import_transport');assert.equal(outcome.retryAllowed,false);assert.equal(f.calls.length,1);
 }
});
test('later no-send observation failure propagates and preserves the separately saved accepted import receipt',async()=>{
 const error=new OzonDEHttpTransportError('OZON_DE_CREDENTIAL_READ_FAILED'),f=adapterFailure(error,1);
 await assert.rejects(()=>f.run(),value=>value===error);
 assert.equal(f.calls.length,2);assert.equal(f.writes.length,1);assert.equal(f.checkpoints[1].taskId,'501');
 assert.deepEqual(f.checkpoints.map(value=>value.kind),['import_intent','import_task_received']);
});
test('native programming errors propagate by identity at every transport step without running another request',async()=>{
 for(const Type of [TypeError,ReferenceError,SyntaxError,RangeError,EvalError,URIError,AggregateError]){
  for(const step of [0,1]){
   const error=Type===AggregateError?new AggregateError([],'synthetic programming failure'):new Type('synthetic programming failure');
   const f=adapterFailure(error,step);await assert.rejects(()=>f.run(),value=>value===error);assert.equal(f.calls.length,step+1);
  }
 }
});
test('a malformed typed diagnostic is rejected without exposing its raw message in a domain receipt',async()=>{
 const f=adapterFailure(new OzonDEHttpTransportError('Bearer synthetic-private-value'));
 await assert.rejects(()=>f.run(),error=>error instanceof TypeError&&error.message==='OZON_DE_TRANSPORT_ERROR_CONTRACT_INVALID');
 assert.equal(f.calls.length,1);assert.equal(f.writes.length,0);
});

test('real transport checks the remaining-write authorization after credentials and before the only stock fetch',async()=>{
 const {createOzonDEHttpTransport}=await import('../lib/ozon-de-http-transport.mjs');
 const order=[],calls=[];
 const transport=createOzonDEHttpTransport({productionBindings:[formal.currentProductionBinding],credentialBindings:[{
  credentialAlias:request.credentialAlias,clientId:'123456',keychainService:'synthetic.ozon',keychainAccount:'synthetic.account'}],
  readSecret:async()=>{order.push('credential');return 'synthetic-key';},fetchImpl:async(url)=>{
   const endpoint=new URL(url).pathname;calls.push(endpoint);order.push('fetch');
   if(endpoint==='/v3/product/info/list')return new Response(JSON.stringify({items:[{offer_id:request.merchantSku,id:910001,is_archived:false,is_autoarchived:false,statuses:{status:capabilities.inventoryWrite.prerequisitePolicy.priceSent.acceptedValues[0]},errors:[]}]}));
   if(endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return new Response(JSON.stringify({has_next:false,products:[{offer_id:request.merchantSku,product_id:910001,sku:1910001,warehouse_id:Number(request.inventoryWrite.warehouseId),free_stock:100,present:103,reserved:3}]}));
   return new Response(JSON.stringify({result:[{offer_id:request.merchantSku,product_id:910001,warehouse_id:Number(request.inventoryWrite.warehouseId),updated:true,errors:[]}]}));
  }});
 const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:capabilities,executionContext:formal.executionContext,requestJson:transport.requestJson});
 const query={platform:'ozon',store:request.store,storeRef:request.storeRef,warehouseRef:request.warehouseRef,credentialAlias:request.credentialAlias,
  warehouseId:request.inventoryWrite.warehouseId,taskId:'501',productId:'910001',merchantSku:request.merchantSku,supplierSkuId:request.supplierSkuId,
  writeAllowed:false,executionKey:request.executionKey,requestReceiptRef:'ozon-import-receipt:synthetic'};
 const observation={priceSentObservation:await adapter.observePriceSent(query),inventoryPrerequisiteObservation:await adapter.observeInventoryPrerequisites(query)};
 order.length=0;calls.length=0;
 const result=await adapter.executeRemainingInventory(request,{observation,assertRemainingInventoryAuthorization:async()=>{order.push('authorization');},
  persistCheckpoint:async value=>{order.push(value.kind);}});
 assert.equal(result.status,'accepted');assert.deepEqual(calls,['/v2/products/stocks']);
 assert.deepEqual(order,['authorization','stock_intent','credential','authorization','fetch','stock_receipt_observed']);
});
