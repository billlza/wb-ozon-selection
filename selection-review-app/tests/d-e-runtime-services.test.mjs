import { capabilities as syntheticCapabilities, exactObservation } from './helpers/d-software-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createDEProductionRuntimeServices, DEPreflightTransportError } from '../lib/d-e-runtime-services.mjs';
import { settleDProductionPreSendStopInDocument } from '../lib/software-job-contract.mjs';
import { createDProductionRoundUseCase } from '../lib/d-production-round-use-case.mjs';
import { buildDESavedJobRuntimeView } from '../lib/d-e-runtime-view.mjs';
import { inspectAdapterCapabilities, OZON_DE_READBACK_ENDPOINTS } from '../lib/ozon-seller-api-de-adapter.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { finalAssets } from './helpers/c2-software-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../lib/software-job-repository.mjs';
import { savedDProductionJobFixture } from './fixtures/d-production-saved-job-fixture.mjs';
import { runPersistedDExecution } from '../lib/d-e-software-integration.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
const clone=value=>structuredClone(value);
const published=await loadPublishedSchemaValidator(),validJob=published.getSchema('software-job-v1.schema.json');
async function fixture({stableAssets=false}={}){
 const owner=stableAssets?productionOwnerDecisionFixture(undefined,{finalUploadAssets:finalAssets()}):productionOwnerDecisionFixture();await commitSingleOwnerProductionAuthorization(owner.args);
 const repository=owner.repository,candidate=(await repository.readSnapshot()).candidates[0],pa=candidate.lifecycleV11.skuPackage.productionAuthorization;
 let now=owner.formal.at;
 const clock=()=>now,registry=createLocalDevelopmentWorkerRegistry({clock});
 const binding={...clone(pa.executionBinding),platform:'ozon',storeRef:clone(candidate.storeRef),storeName:'合成测试店铺',warehouseName:'合成测试仓库',
  warehouseRef:pa.lockedScope.warehouseRef,credentialAlias:pa.lockedScope.credentialAlias,verification:{evidenceRef:'configuration-evidence:synthetic:1',checkedAt:'2026-08-01T00:00:00.000Z',expiresAt:'2026-09-01T00:00:00.000Z'}};
 const services=[{schemaVersion:'d-e-service-binding-v1',serviceId:'service:synthetic:de',configurationVersion:'service-config:1',productionBindingId:binding.bindingId,
  productionConfigurationVersion:binding.configurationVersion,workerId:'worker:synthetic:de',workerVersion:'worker-version:1',leaseDurationMs:60000}];
 const calls=[],puts=[],commits=[];let inspections=0,capabilityReads=0,imported=null;
 const upload=async({finalUploads,beforePublicWrite})=>{
  for(const asset of finalUploads){await beforePublicWrite({assetId:asset.assetId,sha256:asset.sha256,order:asset.order});puts.push(asset.assetId);}
  return {status:'verified',mode:'preapproved_stable_https',protocolVersion:'aliyun-oss-final-assets-v1',evidenceRef:'oss:synthetic:runtime',approvedHosts:['assets.example.com'],
   resolvedAssets:finalUploads.map(asset=>({assetId:asset.assetId,sha256:asset.sha256,order:asset.order,role:asset.role,platformAcceptedUrl:`https://assets.example.com/runtime/${asset.sha256}.jpg`,
    stable:true,authorizationStatus:'approved',evidenceRef:`oss:synthetic:${asset.assetId}`}))};
 };
 const inspectPlatform=async query=>{
  inspections++;const doc=await repository.readSnapshot();
  // 同一份授权可能跑过不止一轮，正在准备的那一轮才是当前轮。
  const dJobs=doc.runtime.softwareJobs.filter(j=>j.jobType==='d_production_execution');
  const job=dJobs.find(j=>j.preparationEvidence)??dJobs[0];
  assert.equal(job.preparationEvidence.status,'in_flight');
  if(job.preparationEvidence.requestMode==='persisted_evidence_only'&&job.externalRequestRef===null){
   assert.equal(job.status,'claimed');assert.equal(job.externalRequestState,'not_sent');
  }else{assert.equal(job.status,'waiting_platform');assert.ok(job.externalRequestRef);}
  commits.push(doc);
  return {observedStore:query.expectedStore,observedStoreRef:clone(query.expectedStoreRef),storeIdentityStatus:'matched',storeIdentityEvidenceRef:'evidence:synthetic:store',
   permissionStatus:'verified',permissionEvidenceRef:'evidence:synthetic:permission',connections:{api:{status:'connected',checkedVia:'seller_api_read_only',evidenceRef:'evidence:synthetic:api'},
    sellerBackend:{status:'connected',checkedVia:'seller_backend_read_only',evidenceRef:'evidence:synthetic:backend'}},platformWritableFields:clone(query.requestedWriteFields),
   imagePermissionStatus:'verified',imagePermissionEvidenceRef:'evidence:synthetic:images',priceFieldCurrency:'CNY',priceCurrencyEvidenceRef:'evidence:synthetic:currency',risks:[]};
 };
 const loadAdapterCapabilities=({candidate:current})=>{
  capabilityReads++;const b=binding;
  const assetTransport=stableAssets?{status:'verified',mode:'preapproved_stable_https',protocolVersion:'approved-https-assets-v1',evidenceRef:'assets:synthetic:approved-https',
   approvedHosts:['assets.example.com'],resolvedAssets:current.lifecycleV11.skuPackage.productionAuthorization.lockedScope.finalUploads.map(asset=>({
    assetId:asset.assetId,sha256:asset.sha256,order:asset.order,role:asset.role,platformAcceptedUrl:asset.assetRef,
    stable:true,authorizationStatus:'approved',evidenceRef:`assets:synthetic:${asset.assetId}`}))}:current.lifecycleV11.skuPackage.dAssetTransport?.assetTransport ?? null;
  return inspectAdapterCapabilities({store:current.targetStore,storeRef:b.storeRef,warehouseRef:b.warehouseRef,credentialAlias:b.credentialAlias,warehouseId:b.warehouseId,inspectedAt:clock(),
   storeIdentity:{status:'verified',expectedStore:current.targetStore,observedStore:current.targetStore,observedStoreRef:b.storeRef,credentialAlias:b.credentialAlias,evidenceRef:'evidence:synthetic:store'},
   productImport:{status:'verified',endpoint:'/v3/product/import',statusEndpoint:'/v1/product/import/info',protocolVersion:'ozon-product-import-v3',evidenceRef:'evidence:synthetic:import'},assetTransport,
   inventoryWrite:{status:'verified',endpoint:'/v2/products/stocks',protocolVersion:'ozon-products-stocks-v2',evidenceRef:'evidence:synthetic:stocks',warehouseId:b.warehouseId,
    storeRef:b.storeRef,warehouseRef:b.warehouseRef,credentialAlias:b.credentialAlias,
    prerequisitePolicy:clone(syntheticCapabilities().inventoryWrite.prerequisitePolicy)},independentReadback:{status:'verified',protocolVersion:'ozon-independent-readback-v2',endpoints:OZON_DE_READBACK_ENDPOINTS,evidenceRef:'evidence:synthetic:readback'}});
 };
 const requestJson=async(request,options)=>{
  calls.push(request.endpoint);commits.push(await repository.readSnapshot());
  assert.deepEqual(request.storeRef,binding.storeRef);assert.equal(request.credentialAlias,binding.credentialAlias);
  if(request.endpoint==='/v3/product/import'){imported=clone(request.body.items[0]);return {result:{task_id:501}};}
  if(request.endpoint==='/v1/product/import/info')return {result:{items:[{offer_id:imported.offer_id,product_id:910001,status:'imported',errors:[]}]}};
  if(request.endpoint==='/v2/products/stocks')return {result:[{offer_id:imported.offer_id,product_id:910001,warehouse_id:Number(binding.warehouseId),updated:true,errors:[]}]};
  const readResponses=readResponsesFor(imported,binding);
  assert.ok(readResponses[request.endpoint]);
  if(commits.at(-1).runtime.softwareJobs.some(j=>j.jobType==='e_independent_readback'&&j.status==='waiting_platform')) assert.ok(options.signal instanceof AbortSignal);
  return readResponses[request.endpoint];
 };
 // 2026-09-24 起：没有平台查询策略就不发导入（导入发出后无人跟进，正是背心那次的成因）。
 // 夹具按生产形态提供一条覆盖整场观察的策略；「缺策略」「策略过期」由专门用例覆盖。
 const observationPolicy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:de-runtime',
  version:'version:1',maxQueries:20,intervalMs:15000,requestTimeoutMs:30000,expiresAt:'2099-01-01T00:00:00.000Z'};
 const options={repository,runtimeMode:'local_development',serverClock:clock,workerRegistry:registry,deServiceBindings:services,productionBindings:[binding],upload,
  resolveLocalAsset:async()=>{throw new Error('Synthetic uploader never reads files');},inspectPlatform,loadAdapterCapabilities,requestJson,loadCurrentProductionBinding:()=>clone(binding),
  loadDPlatformObservationPolicy:()=>clone(observationPolicy)};
 const input={candidateId:candidate.id,jobId:candidate.lifecycleV11.skuPackage.dHandoff.softwareJobRef.jobId,expectedRevision:candidate.dataRevision};
 return {owner,repository,candidate,input,options,calls,puts,commits,binding,registry,counts:()=>({inspections,capabilityReads}),advance:ms=>{now=new Date(Date.parse(now)+ms).toISOString();}};
}
function readResponsesFor(imported,binding){
 const identity={offer_id:imported.offer_id,product_id:910001,id:910001};
 return {
   '/v4/product/info/attributes':{result:[{...identity,primary_image:imported.primary_image,images:imported.images}]},
   '/v3/product/info/list':{items:[{...identity,primary_image:[imported.primary_image],images:imported.images,statuses:{moderate_status:'approved',validation_status:'success',status_name:'Продается'},errors:[]}]},
   '/v5/product/info/prices':{items:[{...identity,price:{price:Number(imported.price),currency_code:'CNY'}}]},
   '/v2/product/info/stocks-by-warehouse/fbs':{products:[{offer_id:imported.offer_id,product_id:910001,sku:1910001,warehouse_id:Number(binding.warehouseId),free_stock:100,present:100,reserved:0}],has_next:false,cursor:''},
  };
}
// Produce the saved D result through the existing software use case; E still uses the real adapter.
async function savedEFixture(){
 const d=await savedDProductionJobFixture();
 // E-only tests start from the formal D reducer with explicit synthetic checkpoint and readback DTOs.
 // The real asynchronous seller adapter is exercised separately and never maps seller status to success here.
 assert.equal((await runPersistedDExecution({...d.input,createAdapter:async({request})=>({
  executeSellerApi:async(_request,{persistCheckpoint})=>{
   const identity={taskId:'501',productId:'910001',merchantSku:request.merchantSku};
   for(const event of [{kind:'import_intent'},{kind:'import_task_received',taskId:'501'},
    {kind:'import_result_observed',...identity,itemCount:1,status:'imported',errorCount:0,requestReceiptRef:'receipt:synthetic:import'},
    {kind:'stock_intent',...identity,warehouseId:request.inventoryWrite.warehouseId,stock:100},
    {kind:'stock_receipt_observed',...identity,warehouseId:request.inventoryWrite.warehouseId,updated:true,itemCount:1,errorCount:0,inventoryReceiptRef:'receipt:synthetic:stock'}])await persistCheckpoint(event);
   return {status:'accepted',taskId:'501',productId:'910001',offerId:request.merchantSku,requestReceiptRef:'receipt:synthetic:import',inventoryReceiptRef:'receipt:synthetic:stock'};
  },readbackSellerApi:async()=>exactObservation(request)
 })})).status,'succeeded');
 const document=await d.repository.readSnapshot(),candidate=document.candidates[0],sku=candidate.lifecycleV11.skuPackage;
 const e=document.runtime.softwareJobs.find(job=>job.jobType==='e_independent_readback');
 assert.equal(e.status,'queued');
 const binding=d.currentProductionBinding,calls=[],source=clone(sku.productionRecord),request=sku.dSoftwareExecution.attempt.request;
 const imported={offer_id:request.merchantSku,price:request.platformWritePrice.amount,
  primary_image:request.finalUploads[0].platformAcceptedUrl,images:request.finalUploads.slice(1).map(asset=>asset.platformAcceptedUrl)};
 const options={repository:d.repository,runtimeMode:'local_development',serverClock:d.input.serverClock,
  workerRegistry:createLocalDevelopmentWorkerRegistry({clock:d.input.serverClock}),
  deServiceBindings:[{schemaVersion:'d-e-service-binding-v1',serviceId:'service:synthetic:saved-d',configurationVersion:'service-config:1',
   productionBindingId:binding.bindingId,productionConfigurationVersion:binding.configurationVersion,workerId:d.worker.workerId,
   workerVersion:d.worker.version,leaseDurationMs:60000}],productionBindings:[binding],loadCurrentProductionBinding:()=>clone(binding),
  loadAdapterCapabilities:()=>clone(d.input.adapterCapabilities),requestJson:async(request,options)=>{
   assert.ok(options.signal instanceof AbortSignal);assert.deepEqual(request.storeRef,binding.storeRef);assert.equal(request.credentialAlias,binding.credentialAlias);
   calls.push(request.endpoint);const responses=readResponsesFor(imported,binding);assert.ok(responses[request.endpoint]);return responses[request.endpoint];
  }};
 return {repository:d.repository,options,calls,source,input:{candidateId:candidate.id,jobId:e.jobId,expectedRevision:candidate.dataRevision}};
}
async function waitForEntered(entered,running,release){
 let timer;
 try{
  await Promise.race([entered.promise,running.then(()=>{throw new Error('Runtime finished before the expected synchronization point');}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Runtime synchronization deadline exceeded')),10000);})]);
 }catch(error){release.resolve();throw error;}finally{clearTimeout(timer);}
}
function assertPublished(document){for(const job of document.runtime.softwareJobs)assert.equal(validJob(job),true,JSON.stringify(validJob.errors));}
function missingAccountCapabilities({candidate,productionBinding},clock){
 return inspectAdapterCapabilities({store:candidate.targetStore,storeRef:productionBinding.storeRef,
  warehouseRef:productionBinding.warehouseRef,credentialAlias:productionBinding.credentialAlias,warehouseId:productionBinding.warehouseId,
  inspectedAt:clock(),storeIdentity:null,productImport:null,assetTransport:null,inventoryWrite:null,independentReadback:null});
}
test('construction performs zero repository/provider reads; missing declared service or function leaves queued unchanged',async()=>{
 const f=await fixture();let reads=0;const repository={...f.repository,readSnapshot:async()=>{reads++;return f.repository.readSnapshot();}};
 const runtime=createDEProductionRuntimeServices({...f.options,repository});assert.equal(reads,0);assert.deepEqual(f.counts(),{inspections:0,capabilityReads:0});assert.equal(f.calls.length+f.puts.length,0);
 assert.throws(()=>createDEProductionRuntimeServices({...f.options,preflightRequestMode:'automatic'}),/PREFLIGHT_REQUEST_MODE_INVALID/);
 for(const overrides of [{deServiceBindings:[]},{requestJson:null},{inspectPlatform:null},{loadAdapterCapabilities:null},{upload:null}]){
  await assert.rejects(()=>createDEProductionRuntimeServices({...f.options,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock}),...overrides}).continueSavedCurrent(f.input),/DE_RUNTIME_UNAVAILABLE_/);
 }
 assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs[0].status,'queued');assert.equal(f.calls.length+f.puts.length,0);
});
test('one PA drives saved OSS and preflight, then a single accepted import waits without creating E or replaying',async()=>{
 const f=await fixture(),runtime=createDEProductionRuntimeServices(f.options);
 const outcome=await runtime.continueSavedCurrent(f.input);assert.equal(outcome.status,'waiting_platform');
 const doc=await f.repository.readSnapshot();assertPublished(doc);
 // 2026-09-24 起导入被接受后会同时排出第一条平台观察作业，所以是 1 条 D + 1 条观察。
 // 逐类型数，比原来只数总数更严：仍然不得出现任何 E 作业。
 assert.equal(doc.runtime.softwareJobs.length,2);
 assert.equal(doc.runtime.softwareJobs.filter(job=>job.jobType==='d_production_execution').length,1);
 assert.equal(doc.runtime.softwareJobs.filter(job=>job.jobType==='e_d_platform_observation').length,1);
 assert.equal(doc.runtime.softwareJobs.filter(job=>job.jobType==='e_independent_readback').length,0);
 assert.equal(f.puts.length,2);assert.equal(f.counts().inspections,1);assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls,['/v3/product/import']);
 assert.equal(doc.runtime.softwareJobs[0].revision,f.input.expectedRevision);assert.equal(doc.runtime.softwareJobs[0].attempt,1);
 assert.equal(doc.runtime.softwareJobs[0].preparationEvidence.status,'ready');assert.equal(doc.runtime.softwareJobs[0].status,'waiting_platform');
 const sku=doc.candidates[0].lifecycleV11.skuPackage;assert.equal(sku.productionRecord,null);assert.equal(sku.eVerificationRecord,null);
 assert.equal(sku.dSoftwareExecution.platformContinuation.status,'waiting_import');
 assert.equal(sku.dSoftwareExecution.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(sku.dSoftwareExecution.attempt.immediateReadback,undefined);
 const before=clone(doc);await createDEProductionRuntimeServices({...f.options,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock})}).continueSavedCurrent(f.input);
 assert.deepEqual(await f.repository.readSnapshot(),before);assert.equal(f.calls.length,1);for(const commit of f.commits)assertPublished(commit);
});
test('actual denied preflight and typed unknown stop without D intent; rerun never performs another inspection',async()=>{
 for(const mode of ['denied','unknown']){
  const f=await fixture();let attempts=0;
  const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async query=>{attempts++;if(mode==='unknown')throw new DEPreflightTransportError('response_lost');const result=await f.options.inspectPlatform(query);result.permissionStatus='denied';return result;}});
  await runtime.continueSavedCurrent(f.input);const doc=await f.repository.readSnapshot(),job=doc.runtime.softwareJobs[0];assertPublished(doc);
  assert.equal(job.status,mode==='denied'?'failed':'unknown_outcome');assert.equal(job.externalRequestState,mode==='denied'?'succeeded':'unknown_outcome');
  assert.equal(doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);assert.equal(f.calls.length,0);
  await runtime.continueSavedCurrent(f.input);assert.equal(attempts,1);
 }
});
test('internal inspector exceptions propagate unchanged and retain one in-flight marker without replay',async()=>{
 const f=await fixture(),failure=new TypeError('synthetic programming failure');let count=0;
 const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async()=>{count++;throw failure;}});
 await assert.rejects(()=>runtime.continueSavedCurrent(f.input),error=>error===failure);
 const doc=await f.repository.readSnapshot();assertPublished(doc);assert.equal(doc.runtime.softwareJobs[0].preparationEvidence.status,'in_flight');
 await runtime.continueSavedCurrent(f.input);assert.equal(count,1);assert.equal(f.calls.length,0);
});
test('HTTP input CAS and closed input reject another revision, job, actor or second owner choice before providers',async()=>{
 const f=await fixture(),runtime=createDEProductionRuntimeServices(f.options);
 for(const input of [{...f.input,expectedRevision:f.input.expectedRevision+1},{...f.input,jobId:'d-production-job:other'},
  {...f.input,ownerExecutionDecision:{confirmed:true}},{...f.input,actor:f.owner.args.actor}])await assert.rejects(()=>runtime.continueSavedCurrent(input));
 assert.equal(f.calls.length+f.puts.length,0);assert.equal(f.counts().inspections,0);
});
test('concurrent continuation cannot claim or inspect the same saved job twice',async()=>{
 const f=await fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();
 const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async query=>{entered.resolve();await release.promise;return f.options.inspectPlatform(query);}});
 const first=runtime.continueSavedCurrent(f.input);await waitForEntered(entered,first,release);
 const second=await runtime.continueSavedCurrent(f.input);assert.equal(second.status,'idempotent_replay');
 release.resolve();assert.equal((await first).status,'waiting_platform');assert.equal(f.counts().inspections,1);assert.equal(f.puts.length,2);assert.equal(f.calls.length,1);
});
test('late inspection retains evidence and stops before D on lease, current configuration, or candidate drift',async()=>{
 for(const drift of ['lease','configuration','candidate']){
  const f=await fixture();
  const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async query=>{
   const result=await f.options.inspectPlatform(query);
   if(drift==='lease')f.advance(60001);
   if(drift==='configuration')f.binding.configurationVersion='configuration:synthetic:changed';
   if(drift==='candidate')await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
   return result;
  }});
  await runtime.continueSavedCurrent(f.input);const doc=await f.repository.readSnapshot(),job=doc.runtime.softwareJobs[0];assertPublished(doc);
  assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'succeeded');assert.equal(job.preparationEvidence.continuationBlocked,true);
  assert.ok(job.preparationEvidence.result.platformWritePreflight);assert.equal(doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);assert.equal(f.calls.length,0);
  assert.equal(job.failureClass,drift==='configuration'?'d-production-preflight-not-ready':'d-production-preparation-context-changed');
 }
});
test('dependencyView states configuration presence only and a configured worker never impersonates the owner',async()=>{
 const f=await fixture(),runtime=createDEProductionRuntimeServices({...f.options,requestJson:null});
 assert.deepEqual(runtime.dependencyView,{transport:false,preflight:true,capabilities:true,assetTransport:true});assert.ok(Object.isFrozen(runtime.dependencyView));
 const workers=f.registry.snapshot();assert.equal(workers.length,1);assert.equal(workers[0].workerId,'worker:synthetic:de');
 assert.notEqual(workers[0].workerId,f.owner.args.actor.userId);
});
test('reconciled in-flight preparation keeps its late evidence but never resumes D',async()=>{
 const {reconcileSoftwareJobAfterRestart}=await import('../lib/software-job-contract.mjs');
 const f=await fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();
 const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async query=>{const result=await f.options.inspectPlatform(query);entered.resolve();await release.promise;return result;}});
 const run=runtime.continueSavedCurrent(f.input);await waitForEntered(entered,run,release);
 await f.repository.transact(document=>{document.runtime.softwareJobs[0]=reconcileSoftwareJobAfterRestart({job:document.runtime.softwareJobs[0],serverTime:f.options.serverClock()});return {changed:true,document};});
 const original=clone((await f.repository.readSnapshot()).runtime.softwareJobs[0]);
 release.resolve();await run;const doc=await f.repository.readSnapshot(),job=doc.runtime.softwareJobs[0];assertPublished(doc);
 assert.equal(job.status,'unknown_outcome');assert.equal(job.failureClass,original.failureClass);assert.equal(job.resultEnvelope,null);
 assert.equal(job.preparationEvidence.status,'ready');assert.equal(job.preparationEvidence.continuationBlocked,true);
 assert.equal(f.calls.length,0);assert.equal(doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);
});
test('an E read failure leaves the original D result and unknown E job without reusing immediate D observation',async()=>{
 const f=await savedEFixture();let eReads=0;
 const runtime=createDEProductionRuntimeServices({...f.options,requestJson:async(request,options)=>{
  const doc=await f.repository.readSnapshot();
  if(doc.runtime.softwareJobs.some(job=>job.jobType==='e_independent_readback'&&job.status==='waiting_platform')){eReads++;throw new Error('Synthetic E disconnect');}
  return f.options.requestJson(request,options);
 }});
 await runtime.continueSavedCurrent(f.input);const doc=await f.repository.readSnapshot();assertPublished(doc);
 assert.equal(doc.runtime.softwareJobs[0].status,'completed');assert.equal(doc.runtime.softwareJobs[1].status,'unknown_outcome');
 assert.equal(doc.candidates[0].lifecycleV11.skuPackage.eVerificationRecord,null);assert.equal(eReads,1);
 assert.deepEqual(doc.candidates[0].lifecycleV11.skuPackage.productionRecord,f.source);
 const e=doc.runtime.softwareJobs[1];await runtime.continueSavedCurrent({candidateId:f.input.candidateId,jobId:e.jobId,expectedRevision:e.revision});assert.equal(eReads,1);
});
test('readbackView uses the actual active E reader and history after completion, while top-level status follows E',async()=>{
 const f=await savedEFixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false;
 const runtime=createDEProductionRuntimeServices({...f.options,requestJson:async(request,options)=>{
  const doc=await f.repository.readSnapshot();
  if(!held&&doc.runtime.softwareJobs.some(job=>job.jobType==='e_independent_readback'&&job.status==='waiting_platform')){held=true;entered.resolve();await release.promise;}
  return f.options.requestJson(request,options);
 }});
 const running=runtime.continueSavedCurrent(f.input);await waitForEntered(entered,running,release);
 assert.equal(runtime.readbackView((await f.repository.readSnapshot()).candidates[0]).status,'in_flight');
 release.resolve();const result=await running;assert.equal(result.status,'not_verified');
 const document=await f.repository.readSnapshot();assertPublished(document);
 const view=runtime.readbackView(document.candidates[0]);assert.equal(view.status,'not_verified');assert.equal(view.live,false);
 assert.equal(view.result.observation.saleStatus,'unknown');assert.equal(f.calls.length,4);assert.deepEqual(f.calls,Object.values(OZON_DE_READBACK_ENDPOINTS));
 assert.deepEqual(document.candidates[0].lifecycleV11.skuPackage.productionRecord,f.source);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.eVerificationRecord,null);
 assert.equal(document.runtime.softwareJobs[0].status,'completed');assert.equal(document.runtime.softwareJobs[1].status,'completed');
 assert.equal(document.runtime.softwareJobs[1].externalRequestState,'succeeded');assert.equal(view.currentVerified,false);
 await runtime.continueSavedCurrent(f.input);assert.equal(f.calls.length,4);
});
test('saved unstarted E resumes once after D commit and a reconstructed service never replays it',async()=>{
 const f=await savedEFixture(),before=await f.repository.readSnapshot();
 const originalD=clone(before.runtime.softwareJobs.find(job=>job.jobType==='d_production_execution'));
 const runtime=createDEProductionRuntimeServices(f.options);
 runtime.start();assert.deepEqual(f.calls,[]); // No implicit timer without explicit configuration.
 const results=await Promise.all([runtime.runDueEReadbacks(),runtime.runDueEReadbacks()]);
 assert.equal(results[0].status,'not_verified');assert.deepEqual(results[0],results[1]);
 assert.deepEqual(f.calls,Object.values(OZON_DE_READBACK_ENDPOINTS));
 const saved=await f.repository.readSnapshot();assertPublished(saved);
 assert.deepEqual(saved.runtime.softwareJobs.find(job=>job.jobType==='d_production_execution'),originalD);
 assert.equal(saved.runtime.softwareJobs.find(job=>job.jobType==='e_independent_readback').attempt,1);
 assert.deepEqual(await runtime.runDueEReadbacks(),{status:'idle'});await runtime.stop();
 const restarted=createDEProductionRuntimeServices({...f.options,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock})});
 assert.deepEqual(await restarted.runDueEReadbacks(),{status:'idle'});await restarted.stop();
 assert.equal(f.calls.length,4);assert.deepEqual(saved.candidates[0].lifecycleV11.skuPackage.productionRecord,f.source);
});
test('E recovery reports revision blockers without providers and never selects an unknown result',async()=>{
 const f=await savedEFixture();
 await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
 const before=await f.repository.readSnapshot(),runtime=createDEProductionRuntimeServices(f.options);
 const blocked=await runtime.runDueEReadbacks();assert.equal(blocked.status,'blocked');
 assert.equal(blocked.rejection.jobId,f.input.jobId);assert.deepEqual(f.calls,[]);
 assert.deepEqual(await f.repository.readSnapshot(),before);await runtime.stop();
 const unknown=await savedEFixture();let requests=0;
 const unknownRuntime=createDEProductionRuntimeServices({...unknown.options,requestJson:async()=>{requests++;throw new Error('Synthetic unknown read');}});
 await unknownRuntime.runDueEReadbacks();const unknownSaved=await unknown.repository.readSnapshot();
 assert.equal(unknownSaved.runtime.softwareJobs.find(job=>job.jobType==='e_independent_readback').status,'unknown_outcome');
 assert.deepEqual(await unknownRuntime.runDueEReadbacks(),{status:'idle'});assert.equal(requests,1);
 assert.deepEqual(await unknown.repository.readSnapshot(),unknownSaved);await unknownRuntime.stop();
});
test('missing E transport is an explicit known blocker and cannot claim the saved job',async()=>{
 const f=await savedEFixture(),before=await f.repository.readSnapshot();
 const runtime=createDEProductionRuntimeServices({...f.options,requestJson:null});
 assert.deepEqual(await runtime.runDueEReadbacks(),{status:'blocked',rejection:{
  jobId:f.input.jobId,candidateId:f.input.candidateId,code:'DE_RUNTIME_UNAVAILABLE_TRANSPORT'}});
 assert.deepEqual(await f.repository.readSnapshot(),before);assert.deepEqual(f.calls,[]);await runtime.stop();
});
test('E service stop cancels the actual bounded read and preserves a non-replayable terminal',async()=>{
 const f=await savedEFixture(),entered=Promise.withResolvers();let requests=0;
 const runtime=createDEProductionRuntimeServices({...f.options,requestJson:async(_request,{signal})=>{
  requests++;assert.ok(signal instanceof AbortSignal);entered.resolve();
  return new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }});
 const running=runtime.runDueEReadbacks();await entered.promise;
 assert.deepEqual(await runtime.runDueObservations(),{status:'idle'});
 await runtime.stop();await running;
 const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs.find(job=>job.jobType==='e_independent_readback');
 assert.equal(job.status,'unknown_outcome');assert.equal(job.attempt,1);assert.equal(requests,1);
 assert.deepEqual(await runtime.runDueEReadbacks(),{status:'idle'});assert.deepEqual(await f.repository.readSnapshot(),saved);
});
test('E pump interval is explicit and unknown scheduling errors stop the pump visibly',async()=>{
 const f=await savedEFixture();
 for(const value of ['',0,999,1000.5,2147483648,Infinity]){
  assert.throws(()=>createDEProductionRuntimeServices({...f.options,eReadbackPumpIntervalMs:value}),/E_PUMP_INTERVAL_INVALID/);
 }
 const missing=createDEProductionRuntimeServices({...f.options,eReadbackPumpIntervalMs:1000});
 assert.throws(()=>missing.start(),/E_PUMP_ERROR_HANDLER_REQUIRED/);await missing.stop();assert.deepEqual(f.calls,[]);
 const failure=new TypeError('Synthetic repository failure'),observed=Promise.withResolvers();let reads=0;
 const runtime=createDEProductionRuntimeServices({...f.options,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock}),
  repository:{...f.repository,readSnapshot:async()=>{reads++;throw failure;}},eReadbackPumpIntervalMs:1000,onReadbackError:observed.resolve});
 runtime.start();assert.equal(await observed.promise,failure);await runtime.stop();assert.equal(reads,1);assert.deepEqual(f.calls,[]);
});
test('local batch observation pump keeps a live worker current but never revives an expired worker',async()=>{
 const f=await fixture();
 assert.throws(()=>createDEProductionRuntimeServices({...f.options,
  loadBatchMemberEvidence:async()=>null}),/DE_RUNTIME_BATCH_EVIDENCE_DEPENDENCY_INCOMPLETE/);
 const errors=[];
 const localRegistry=createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock,heartbeatTtlMs:3000});
 const runtime=createDEProductionRuntimeServices({...f.options,
  workerRegistry:localRegistry,
  loadBatchMemberEvidence:async()=>{throw new Error('No batch job in this test');},
  loadBatchEReadEvidence:async()=>{throw new Error('No batch E job in this test');},
  observationPumpIntervalMs:100000,onObservationError:error=>errors.push(error.message)});
 runtime.start();
 try{
  f.advance(2000);
  await new Promise(resolve=>setTimeout(resolve,1150));
  assert.equal(localRegistry.findEligible(['ozon-production-execution']).length,1);
  f.advance(3100);
  await new Promise(resolve=>setTimeout(resolve,1150));
  assert.deepEqual(errors,['DE_RUNTIME_LOCAL_WORKER_HEARTBEAT_EXPIRED']);
  assert.equal(localRegistry.findEligible(['ozon-production-execution']).length,0);
 }finally{await runtime.stop();}
});
test('inspection is bounded by its existing lease and forwards a real cancellation signal without retry',async()=>{
 const f=await fixture();let signal,inspections=0;
 const runtime=createDEProductionRuntimeServices({...f.options,deServiceBindings:f.options.deServiceBindings.map(binding=>({...binding,leaseDurationMs:1000})),
  inspectPlatform:(query,options)=>{inspections++;signal=options.signal;return new Promise(()=>{});}});
 await runtime.continueSavedCurrent(f.input);const doc=await f.repository.readSnapshot();assertPublished(doc);
 assert.equal(signal.aborted,true);assert.ok(signal.reason instanceof DEPreflightTransportError);assert.equal(doc.runtime.softwareJobs[0].status,'unknown_outcome');
 await runtime.continueSavedCurrent(f.input);assert.equal(inspections,1);assert.equal(f.calls.length,0);
});
test('preparation receipt persistence failure propagates and leaves its original intent without starting D',async()=>{
 const f=await fixture(),failure=new Error('Synthetic preparation storage unavailable');
 const repository={...f.repository,transact:mutator=>f.repository.transact(async document=>{
  const result=await mutator(document);
  if(result.changed && result.document.runtime.softwareJobs.some(job=>job.preparationEvidence?.status==='ready'))throw failure;
  return result;
 })};
 const runtime=createDEProductionRuntimeServices({...f.options,repository});
 await assert.rejects(()=>runtime.continueSavedCurrent(f.input),error=>error===failure);
 const doc=await f.repository.readSnapshot();assertPublished(doc);assert.equal(doc.runtime.softwareJobs[0].preparationEvidence.status,'in_flight');
 assert.equal(doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);assert.equal(f.calls.length,0);
 await runtime.continueSavedCurrent(f.input);assert.equal(f.counts().inspections,1);
});
test('inspection receives the committed preparation context after asset transport, with distinct source and current revisions',async()=>{
 const f=await fixture();let observed=false;
 const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async(query,context)=>{
  const document=await f.repository.readSnapshot(),candidate=document.candidates[0],job=document.runtime.softwareJobs[0];
  assert.deepEqual(Object.keys(context).sort(),['candidate','job','candidateRevision','sourceRevision','productionAuthorization','productionPlan',
   'productionBinding','preparationEvidence','workerId','leaseId','signal'].sort());
  assert.deepEqual(context.candidate,candidate);assert.deepEqual(context.job,job);
  assert.equal(context.job.status,'waiting_platform');assert.equal(context.preparationEvidence.status,'in_flight');
  assert.deepEqual(context.preparationEvidence,job.preparationEvidence);
  assert.equal(context.candidateRevision,candidate.dataRevision);assert.equal(context.sourceRevision,job.revision);
  assert.ok(context.candidateRevision>context.sourceRevision);
  assert.equal(context.preparationEvidence.sourceCandidateRevision,context.candidateRevision);
  assert.equal(context.preparationEvidence.revision,context.sourceRevision);
  assert.deepEqual(context.productionAuthorization,candidate.lifecycleV11.skuPackage.productionAuthorization);
  assert.deepEqual(context.productionPlan,candidate.lifecycleV11.skuPackage.dAssetTransport.intent.productionPlan);
  assert.deepEqual(context.productionBinding,f.binding);
  assert.equal(context.workerId,job.workerId);assert.equal(context.leaseId,job.leaseId);
  assert.ok(context.signal instanceof AbortSignal);assert.equal(context.signal.aborted,false);
  assert.equal(f.puts.length,2);assert.equal(f.calls.length,0);observed=true;
  return f.options.inspectPlatform(query);
 }});
 assert.equal((await runtime.continueSavedCurrent(f.input)).status,'waiting_platform');assert.equal(observed,true);
});
test('inspection cannot mutate persisted source, plan or preparation through its detached context',async()=>{
 const f=await fixture();
 const runtime=createDEProductionRuntimeServices({...f.options,inspectPlatform:async(query,context)=>{
  const before=await f.repository.readSnapshot();
  context.candidate.dataRevision++;
  context.job.status='failed';context.job.scopeBinding.productionBinding.configurationVersion='configuration:changed';
  context.productionAuthorization.lockedScope.credentialAlias='credential:changed';
  context.productionPlan.planId='plan:changed';context.productionBinding.warehouseId='999999';
  context.preparationEvidence.status='unknown_outcome';
  assert.deepEqual(await f.repository.readSnapshot(),before);
  return f.options.inspectPlatform(query);
 }});
 assert.equal((await runtime.continueSavedCurrent(f.input)).status,'waiting_platform');
 const document=await f.repository.readSnapshot();assertPublished(document);
 assert.equal(document.runtime.softwareJobs[0].preparationEvidence.status,'ready');
 assert.equal(f.binding.warehouseId,f.candidate.lifecycleV11.skuPackage.productionAuthorization.executionBinding.warehouseId);
});
test('capability evidence is read before preparation and its failure never invokes the inspector or D transport',async()=>{
 const f=await fixture(),failure=new Error('Synthetic persisted capability evidence unavailable');let reads=0;
 const runtime=createDEProductionRuntimeServices({...f.options,loadAdapterCapabilities:async({candidate,job})=>{
  reads++;const document=await f.repository.readSnapshot();
  assert.deepEqual(candidate,document.candidates[0]);assert.deepEqual(job,document.runtime.softwareJobs[0]);
  assert.equal(job.preparationEvidence,undefined);assert.equal(f.counts().inspections,0);assert.equal(f.calls.length,0);
  throw failure;
 }});
 await assert.rejects(()=>runtime.continueSavedCurrent(f.input),error=>error===failure);
 const document=await f.repository.readSnapshot();assertPublished(document);
 assert.equal(document.runtime.softwareJobs[0].preparationEvidence,undefined);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);
 await runtime.continueSavedCurrent(f.input);assert.equal(reads,1);assert.equal(f.counts().inspections,0);assert.equal(f.calls.length,0);assert.equal(f.puts.length,0);
});
test('failed atomic preparation-intent persistence performs zero inspection and cannot replay the saved job',async()=>{
 const f=await fixture(),failure=new Error('Synthetic preparation intent storage unavailable');
 const repository={...f.repository,transact:mutator=>f.repository.transact(async document=>{
  const result=await mutator(document);
  if(result.changed && result.document.runtime.softwareJobs.some(job=>job.preparationEvidence?.status==='in_flight'))throw failure;
  return result;
 })};
 const runtime=createDEProductionRuntimeServices({...f.options,repository});
 await assert.rejects(()=>runtime.continueSavedCurrent(f.input),error=>error===failure);
 const document=await f.repository.readSnapshot();assertPublished(document);
 assert.equal(document.runtime.softwareJobs[0].preparationEvidence,undefined);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);
 await runtime.continueSavedCurrent(f.input);assert.equal(f.counts().inspections,0);assert.equal(f.calls.length,0);
});
test('missing persisted account and protocol evidence settles not_ready before any public asset upload or D request',async()=>{
 const f=await fixture();let capabilityReads=0;
 const runtime=createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',loadAdapterCapabilities:input=>{
  capabilityReads++;
  return missingAccountCapabilities(input,f.options.serverClock);
 }});
 const outcome=await runtime.continueSavedCurrent(f.input),document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs[0];
 assertPublished(document);assert.equal(outcome.status,'failed');assert.equal(job.status,'failed');
 assert.equal(job.externalRequestState,'not_sent');assert.equal(job.externalRequestRef,null);
 assert.equal(job.preparationEvidence.requestMode,'persisted_evidence_only');
 assert.equal(job.preparationEvidence.status,'not_ready');
 assert.ok(job.preparationEvidence.result.capabilities.gaps.some(gap=>gap.code==='store_identity_not_verified'));
 assert.ok(job.preparationEvidence.result.capabilities.gaps.some(gap=>gap.code==='product_import_not_verified'));
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dAssetTransport,undefined);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution,undefined);
 assert.equal(f.puts.length,0);assert.equal(f.calls.length,0);assert.equal(f.counts().inspections,1);
 await runtime.continueSavedCurrent(f.input);assert.equal(capabilityReads,1);assert.equal(f.counts().inspections,1);
 assert.equal(f.puts.length,0);assert.equal(f.calls.length,0);
});
test('local evidence timeout records failed without inventing platform unknown and preserves prior verified OSS writes',async()=>{
 for(const assetsCompleted of [false,true]){
  const f=await fixture();let inspections=0;
  const runtime=createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',
   deServiceBindings:f.options.deServiceBindings.map(binding=>({...binding,leaseDurationMs:1000})),
   loadAdapterCapabilities:assetsCompleted?f.options.loadAdapterCapabilities:input=>missingAccountCapabilities(input,f.options.serverClock),
   inspectPlatform:()=>{inspections++;return new Promise(()=>{});}});
  await runtime.continueSavedCurrent(f.input);
  const document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs[0];assertPublished(document);
  assert.equal(job.preparationEvidence.requestMode,'persisted_evidence_only');assert.equal(job.preparationEvidence.status,'unknown_outcome');
  assert.equal(job.status,'failed');assert.equal(job.failureClass,'d-production-local-preflight-unavailable');
  assert.equal(job.externalRequestState,assetsCompleted?'succeeded':'not_sent');
  assert.equal(f.puts.length,assetsCompleted?2:0);assert.equal(f.calls.length,0);
  if(assetsCompleted)assert.equal(document.candidates[0].lifecycleV11.skuPackage.dAssetTransport.status,'verified');
  else assert.equal(job.externalRequestRef,null);
  await createDEProductionRuntimeServices({...f.options,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock}),
   preflightRequestMode:'persisted_evidence_only'}).continueSavedCurrent(f.input);
  assert.equal(inspections,1);assert.equal(f.calls.length,0);
 }
});
test('local ready evidence keeps not_sent until the first real D checkpoint starts the external request',async()=>{
 const f=await fixture({stableAssets:true});let inspected=false,firstRequest=false;
 const runtime=createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',inspectPlatform:async(query,context)=>{
  const document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs[0];assertPublished(document);
  assert.equal(context.job.status,'claimed');assert.equal(context.job.externalRequestState,'not_sent');assert.equal(context.job.externalRequestRef,null);
  assert.equal(job.preparationEvidence.requestMode,'persisted_evidence_only');assert.equal(f.calls.length,0);assert.equal(f.puts.length,0);
  inspected=true;return f.options.inspectPlatform(query);
 },requestJson:async(request,options)=>{
  if(!firstRequest){
   const document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs[0];assertPublished(document);
   assert.equal(inspected,true);assert.equal(request.endpoint,'/v3/product/import');
   assert.equal(job.status,'waiting_platform');assert.equal(job.externalRequestState,'in_flight');assert.ok(job.externalRequestRef);
   assert.equal(job.preparationEvidence.status,'ready');assert.equal(job.preparationEvidence.requestMode,'persisted_evidence_only');
   firstRequest=true;
  }
  return f.options.requestJson(request,options);
 }});
 assert.equal((await runtime.continueSavedCurrent(f.input)).status,'waiting_platform');assert.equal(firstRequest,true);
 const document=await f.repository.readSnapshot();assertPublished(document);assert.equal(f.puts.length,0);assert.equal(f.calls.length,1);
 await runtime.continueSavedCurrent(f.input);assert.equal(f.calls.length,1);
});
test('local late evidence preserves reconciled not_sent failure and cannot settle or claim the job again',async()=>{
 const {reconcileSoftwareJobAfterRestart,reconcileExpiredSoftwareJobLease}=await import('../lib/software-job-contract.mjs');
 for(const reason of ['restart','lease']){
  const f=await fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  const runtime=createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',
   loadAdapterCapabilities:input=>missingAccountCapabilities(input,f.options.serverClock),inspectPlatform:async query=>{
    const result=await f.options.inspectPlatform(query);entered.resolve();await release.promise;return result;
   }});
  const running=runtime.continueSavedCurrent(f.input);await waitForEntered(entered,running,release);
  if(reason==='lease')f.advance(60001);
  await f.repository.transact(document=>{
   const reconcile=reason==='restart'?reconcileSoftwareJobAfterRestart:reconcileExpiredSoftwareJobLease;
   document.runtime.softwareJobs[0]=reconcile({job:document.runtime.softwareJobs[0],serverTime:f.options.serverClock()});
   return {changed:true,document};
  });
  const original=clone((await f.repository.readSnapshot()).runtime.softwareJobs[0]);
  release.resolve();await running;
  const document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs[0];assertPublished(document);
  assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'not_sent');assert.equal(job.externalRequestRef,null);
  assert.equal(job.failureClass,original.failureClass);assert.equal(job.completedAt,original.completedAt);
  assert.deepEqual(job.resultEnvelope,original.resultEnvelope);assert.deepEqual(job.scopeBinding,original.scopeBinding);
  assert.equal(job.preparationEvidence.continuationBlocked,true);assert.equal(job.preparationEvidence.status,'not_ready');
  await runtime.continueSavedCurrent(f.input);assert.equal(f.counts().inspections,1);assert.equal(f.puts.length,0);assert.equal(f.calls.length,0);
 }
});
test('document-aware restart and lease reconciliation preserve proven OSS success when local preparation was interrupted',async()=>{
 const f=await fixture(),failure=new Error('Synthetic interrupted local preparation');
 const runtime=createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',inspectPlatform:()=>{throw failure;}});
 await assert.rejects(()=>runtime.continueSavedCurrent(f.input),error=>error===failure);
 const saved=await f.repository.readSnapshot(),originalAssets=clone(saved.candidates[0].lifecycleV11.skuPackage.dAssetTransport);
 for(const reason of ['restart','lease']){
  const repository=createMemoryBusinessStateRepository(saved),store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,serverClock:f.options.serverClock});
  if(reason==='lease'){
   assert.deepEqual((await store.reconcileExpiredLeases()).reconciled,[]);assert.deepEqual(await repository.readSnapshot(),saved);
   f.advance(60001);
  }
  const reconcile=()=>reason==='restart'?store.reconcileAfterRestart():store.reconcileExpiredLeases();
  assert.deepEqual((await reconcile()).reconciled,[f.input.jobId]);
  const document=await repository.readSnapshot(),job=document.runtime.softwareJobs[0];assertPublished(document);
  assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'succeeded');assert.equal(job.failureClass,'d-production-local-preflight-unavailable');
  assert.equal(job.preparationEvidence.status,'unknown_outcome');assert.equal(job.preparationEvidence.requestMode,'persisted_evidence_only');
  assert.equal(job.preparationEvidence.continuationBlocked,true);
  assert.deepEqual(document.candidates[0].lifecycleV11.skuPackage.dAssetTransport,originalAssets);
  assert.deepEqual((await reconcile()).reconciled,[]);assert.deepEqual(await repository.readSnapshot(),document);
  await createDEProductionRuntimeServices({...f.options,repository,preflightRequestMode:'persisted_evidence_only',
   workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.options.serverClock})}).continueSavedCurrent(f.input);
  assert.equal(f.puts.length,2);assert.equal(f.calls.length,0);
 }
});
test('document-aware reconciliation cannot reinterpret historical, external, unverified or mismatched sources as OSS success',async()=>{
 const f=await fixture(),failure=new Error('Synthetic interrupted local preparation');
 await assert.rejects(()=>createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',inspectPlatform:()=>{throw failure;}}).continueSavedCurrent(f.input),error=>error===failure);
 const saved=await f.repository.readSnapshot();
 function updateMode(evidence,mode){
  if(mode==='historical')delete evidence.requestMode;else evidence.requestMode=mode;
  const identity=Object.fromEntries(Object.entries(evidence).filter(([key])=>!['preparationId','completedAt','status','result','continuationBlocked'].includes(key)));
  evidence.preparationId=`d-preparation:${fingerprintCanonicalRecord(identity)}`;
 }
 for(const kind of ['historical','external_read','assets_in_flight','assets_unknown','d_started','mode_conflict','wrong_pa','wrong_job','missing_media']){
  const document=clone(saved),job=document.runtime.softwareJobs[0],sku=document.candidates[0].lifecycleV11.skuPackage;
  if(['historical','external_read'].includes(kind))updateMode(job.preparationEvidence,kind);
  if(kind==='assets_in_flight')sku.dAssetTransport.status='in_flight';
  if(kind==='assets_unknown')sku.dAssetTransport.status='unknown_outcome';
  if(kind==='d_started')sku.dSoftwareExecution={status:'in_flight'};
  if(kind==='mode_conflict'){updateMode(job.preparationEvidence,'external_read');job.preparationEvidence.requestMode='persisted_evidence_only';}
  if(kind==='wrong_pa')sku.dAssetTransport.intent.authorizationFingerprint='0'.repeat(64);
  if(kind==='wrong_job')sku.dAssetTransport.softwareJobRef.jobId='job:another';
  if(kind==='missing_media')sku.dAssetTransport.assetTransport.resolvedAssets.pop();
  const repository=createMemoryBusinessStateRepository(document),store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,serverClock:f.options.serverClock});
  if(['mode_conflict','wrong_pa','wrong_job','missing_media'].includes(kind)){
   await assert.rejects(()=>store.reconcileAfterRestart(),/SOURCE_INVALID|ASSET_SOURCE_CONFLICT|ASSET_RECEIPT_CONFLICT/);
   assert.deepEqual(await repository.readSnapshot(),document);
  }else{
   await store.reconcileAfterRestart();const result=await repository.readSnapshot();assertPublished(result);
   assert.equal(result.runtime.softwareJobs[0].status,'unknown_outcome');assert.equal(result.runtime.softwareJobs[0].externalRequestState,'unknown_outcome');
  }
 }
 assert.equal(f.puts.length,2);assert.equal(f.calls.length,0);
});

test('initial import rechecks current revision and lease after credential preparation and before sending',async()=>{
 for(const drift of ['revision','lease']) {
  const f=await fixture({stableAssets:true});let callbacks=0,sent=0;
  const runtime=createDEProductionRuntimeServices({...f.options,preflightRequestMode:'persisted_evidence_only',requestJson:async(request,options)=>{
   assert.equal(request.endpoint,'/v3/product/import');assert.equal(typeof options.beforeRequestSend,'function');
   if(drift==='revision')await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
   else f.advance(60001);
   callbacks++;await options.beforeRequestSend();sent++;
   throw new Error('invalid send authorization escaped');
  }});
  const result=await runtime.continueSavedCurrent(f.input);assert.equal(result.status,'failed');
  const document=await f.repository.readSnapshot(),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(callbacks,1);assert.equal(sent,0);assert.equal(state.platformWrites,0);assert.equal(state.step,'import_intent');
  assert.equal(state.attempt.productionRecord,null);assert.equal(document.runtime.softwareJobs[0].status,'failed');
  await runtime.continueSavedCurrent(f.input);assert.equal(callbacks,1);assert.equal(sent,0);
 }
});

test('active multi-image checkpoints renew liveness after 30 seconds without extending the D lease',async()=>{
 const f=await fixture();
 const upload=async args=>f.options.upload({...args,beforePublicWrite:async asset=>{
  f.advance(20000);return args.beforePublicWrite(asset);
 }});
 const runtime=createDEProductionRuntimeServices({...f.options,upload});
 const outcome=await runtime.continueSavedCurrent(f.input);
 assert.equal(outcome.status,'waiting_platform');assert.equal(f.puts.length,2);assert.deepEqual(f.calls,['/v3/product/import']);
 const job=(await f.repository.readSnapshot()).runtime.softwareJobs.find(value=>value.jobId===f.input.jobId);
 const active=f.commits.at(-1).runtime.softwareJobs.find(value=>value.jobId===f.input.jobId);
 assert.equal(Date.parse(active.leaseExpiresAt)-Date.parse(active.startedAt),60000);
 assert.equal(job.attempt,1);
});

for(const change of ['offline','version','capabilities','lease'])test(`active D upload stops for ${change} without a second public write`,async()=>{
 const f=await fixture();let checkpoints=0;
 const upload=async args=>f.options.upload({...args,beforePublicWrite:async asset=>{
  checkpoints++;
  if(checkpoints===2){
   const worker=f.registry.get(f.options.deServiceBindings[0].workerId);
   if(change==='offline')f.registry.markOffline(worker.workerId);
   else if(change==='version')f.registry.heartbeat({...worker,version:'worker-version:changed'});
   else if(change==='capabilities')f.registry.heartbeat({...worker,capabilities:['ozon-independent-readback']});
   else f.advance(60001);
  }
  return args.beforePublicWrite(asset);
 }});
 const runtime=createDEProductionRuntimeServices({...f.options,upload});
 const outcome=await runtime.continueSavedCurrent(f.input);
 assert.notEqual(outcome.status,'waiting_platform');assert.equal(f.puts.length,1);assert.equal(f.calls.length,0);
 const saved=await f.repository.readSnapshot();assertPublished(saved);
 await runtime.continueSavedCurrent({...f.input,expectedRevision:saved.candidates[0].dataRevision});
 assert.equal(f.puts.length,1);assert.equal(f.calls.length,0);
});

test('each independent E read checks its current holder after 30 seconds and retains the original lease',async()=>{
 const f=await savedEFixture();let now=f.options.serverClock();const clock=()=>now;const leases=[];
 const registry=createLocalDevelopmentWorkerRegistry({clock});
 const runtime=createDEProductionRuntimeServices({...f.options,serverClock:clock,workerRegistry:registry,
  requestJson:async(request,options)=>{
   // Model credential preparation before the real transport send checkpoint.
   now=new Date(Date.parse(now)+10000).toISOString();await options.beforeRequestSend();
   const job=(await f.repository.readSnapshot()).runtime.softwareJobs.find(value=>value.jobId===f.input.jobId);
   leases.push({startedAt:job.startedAt,leaseExpiresAt:job.leaseExpiresAt});
   return f.options.requestJson(request,options);
  }});
 const result=await runtime.continueSavedCurrent(f.input);
 assert.equal(result.status,'not_verified');assert.deepEqual(f.calls,Object.values(OZON_DE_READBACK_ENDPOINTS));
 const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs.find(value=>value.jobId===f.input.jobId);
 assert.equal(new Set(leases.map(value=>value.leaseExpiresAt)).size,1);
 assert.equal(Date.parse(leases[0].leaseExpiresAt)-Date.parse(leases[0].startedAt),60000);assert.equal(job.attempt,1);
 assert.equal(saved.candidates[0].lifecycleV11.skuPackage.readbackHistory.at(-1).externalRequestState,'succeeded');
});

for(const change of ['offline','version','capabilities','lease','source_revision','binding_expiry'])test(`E stops before another platform read after ${change}`,async()=>{
 const f=await savedEFixture();let now=f.options.serverClock();const clock=()=>now;
 const registry=createLocalDevelopmentWorkerRegistry({clock});let preparations=0;
 const binding=clone(f.options.productionBindings[0]);
 const runtime=createDEProductionRuntimeServices({...f.options,serverClock:clock,workerRegistry:registry,loadCurrentProductionBinding:()=>clone(binding),
  requestJson:async(request,options)=>{
   preparations++;
   if(preparations===2){
    const worker=registry.get(f.options.deServiceBindings[0].workerId);
    if(change==='offline')registry.markOffline(worker.workerId);
    else if(change==='version')registry.heartbeat({...worker,version:'worker-version:changed'});
    else if(change==='capabilities')registry.heartbeat({...worker,capabilities:['ozon-production-execution']});
    else if(change==='lease')now=new Date(Date.parse(now)+60001).toISOString();
    else if(change==='source_revision')await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document,result:null};});
    else binding.verification.expiresAt=now;
   }
   await options.beforeRequestSend();return f.options.requestJson(request,options);
  }});
 const result=await runtime.continueSavedCurrent(f.input);
 assert.equal(result.status,change==='source_revision'?'not_applied':'unknown_outcome');assert.equal(f.calls.length,1);
 const saved=await f.repository.readSnapshot();assertPublished(saved);
 assert.equal(saved.candidates[0].lifecycleV11.skuPackage.eVerificationRecord,null);
 await runtime.continueSavedCurrent(f.input);assert.equal(f.calls.length,1);
});

// 2026-09-22：真实事故。领取成功后守卫拒绝，旧代码既没发请求也没收口，任务永远停在 claimed。
// 时钟必须真的前进：冻结时钟下租约永不过期，这条路径根本走不到。
test('claim后守卫拒绝时把已领取任务收口成已知技术失败，零外部请求且不自动重试',async()=>{
 const f=await fixture();let advanced=false;
 const runtime=createDEProductionRuntimeServices({...f.options,loadAdapterCapabilities:args=>{
  const capabilities=f.options.loadAdapterCapabilities(args);
  if(!advanced){advanced=true;f.advance(60001);}
  return capabilities;
 }});
 const outcome=await runtime.continueSavedCurrent(f.input);
 assert.equal(outcome.status,'failed');
 const document=await f.repository.readSnapshot(),job=document.runtime.softwareJobs.find(entry=>entry.jobType==='d_production_execution');
 assert.equal(job.status,'failed');assert.equal(job.attempt,1);
 assert.equal(job.externalRequestState,'not_sent');assert.equal(job.externalRequestRef,null);
 assert.equal(job.automaticRetryAllowed,false);
 assert.match(job.failureClass,/^d-production-guard-rejected:[A-Z][A-Z0-9_]+$/);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dAssetTransport??null,null);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution??null,null);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
 assert.equal(f.calls.length,0);assert.equal(f.puts.length,0);
 assert.equal(f.counts().inspections,0);
 assertPublished(document);
 // 收口是终态，不是新一轮：再点一次只读回同一结果，不重新领取也不再发请求。
 const again=await runtime.continueSavedCurrent(f.input);
 assert.equal(again.status,'idempotent_replay');
 assert.equal(f.calls.length,0);
 assert.deepEqual((await f.repository.readSnapshot()).runtime.softwareJobs,document.runtime.softwareJobs);
});

// pre-send 收口是窄路：只有“已领取、什么都没落盘、什么都没发”才允许收口，别的一律拒绝。
test('pre-send收口只认已领取且零副作用的持有态，非守卫类错误仍原样抛出',async()=>{
 const f=await fixture();
 const runtime=createDEProductionRuntimeServices({...f.options,loadAdapterCapabilities:()=>{throw new TypeError('合成实现缺陷');}});
 await assert.rejects(()=>runtime.continueSavedCurrent(f.input),/合成实现缺陷/);
 const claimed=await f.repository.readSnapshot(),job=claimed.runtime.softwareJobs.find(entry=>entry.jobType==='d_production_execution');
 assert.equal(job.status,'claimed');assert.equal(job.failureClass,null);
 const holder={jobId:job.jobId,workerId:job.workerId,leaseId:job.leaseId};
 const at=new Date(Date.parse(job.lastProgressAt)+1000).toISOString();
 const guardClass='d-production-guard-rejected:SOFTWARE_JOB_LEASE_REJECTED';
 const attempt=(mutate,settlement={})=>{
  const document=clone(claimed),saved=document.runtime.softwareJobs.find(entry=>entry.jobId===job.jobId);
  if(mutate)mutate(saved,document.candidates[0].lifecycleV11.skuPackage);
  return ()=>settleDProductionPreSendStopInDocument(document,{...holder,failureClass:guardClass,...settlement},at);
 };
 const invalid=/SOFTWARE_JOB_D_PRE_SEND_STOP_INVALID/;
 assert.throws(attempt(null,{failureClass:'lease_expired'}),invalid);
 assert.throws(attempt(null,{failureClass:'d-production-guard-rejected:随便写'}),invalid);
 assert.throws(attempt(saved=>{saved.externalRequestState='in_flight';saved.externalRequestRef='d-production-request:synthetic';}),invalid);
 assert.throws(attempt((saved,sku)=>{sku.dAssetTransport={schemaVersion:'aliyun-oss-d-asset-state-v1',status:'in_flight'};}),invalid);
 assert.throws(attempt((saved,sku)=>{sku.dSoftwareExecution={schemaVersion:'d-software-execution-state-v2',status:'in_flight'};}),invalid);
 assert.throws(attempt(null,{leaseId:'lease:de:other'}),/SOFTWARE_JOB_LEASE_REJECTED/);
 const document=clone(claimed);
 const settled=settleDProductionPreSendStopInDocument(document,{...holder,failureClass:guardClass},at);
 assert.equal(settled.status,'failed');assert.equal(settled.externalRequestState,'not_sent');
 assert.equal(settled.completedAt,at);assert.equal(settled.failureClass,guardClass);
 assertPublished(document);
});

// 主人拍板（2026-09-22）：上一轮证明什么都没发出去时，在同一份授权下再派一轮，而不是重签授权。
// 这条路必须真的走得通到底——不只是排出作业，而是新一轮能把商品实际写到平台并通过独立回读。
test('上一轮零发送停下后，同一授权可再派一轮，新一轮真的传素材并把导入发到平台',async()=>{
 const f=await fixture();let advanced=false;
 const blocked=createDEProductionRuntimeServices({...f.options,loadAdapterCapabilities:args=>{
  const capabilities=f.options.loadAdapterCapabilities(args);
  if(!advanced){advanced=true;f.advance(60001);}
  return capabilities;
 }});
 assert.equal((await blocked.continueSavedCurrent(f.input)).status,'failed');
 const stopped=await f.repository.readSnapshot();
 const firstRound=stopped.runtime.softwareJobs.find(entry=>entry.jobType==='d_production_execution');
 const revisionBefore=stopped.candidates[0].dataRevision;

 const rounds=createDProductionRoundUseCase({repository:f.repository,serverClock:f.options.serverClock});
 const dispatched=await rounds.dispatch({actor:f.owner.args.actor,input:{candidateId:f.input.candidateId,
  expectedRevision:revisionBefore,supersededJobId:firstRound.jobId,confirmPreviousRoundSentNothing:true}});
 assert.equal(dispatched.round,2);
 assert.equal(dispatched.jobId,`${firstRound.jobId}:round2`);
 assert.equal(dispatched.externalRequests,0);assert.equal(dispatched.platformWrites,0);

 const requeued=await f.repository.readSnapshot(),jobs=requeued.runtime.softwareJobs.filter(e=>e.jobType==='d_production_execution');
 assert.equal(jobs.length,2);
 // 授权、候选和失败历史一律不动：轮次是技术尝试，不占 revision，也不改写上一轮。
 assert.equal(requeued.candidates[0].dataRevision,revisionBefore);
 assert.deepEqual(requeued.candidates[0].lifecycleV11.skuPackage.productionAuthorization,
  stopped.candidates[0].lifecycleV11.skuPackage.productionAuthorization);
 assert.deepEqual(requeued.candidates[0].lifecycleV11.skuPackage.dHandoff,stopped.candidates[0].lifecycleV11.skuPackage.dHandoff);
 assert.deepEqual(jobs.find(e=>e.jobId===firstRound.jobId),firstRound);
 const second=jobs.find(e=>e.jobId===dispatched.jobId);
 assert.equal(second.status,'queued');assert.equal(second.attempt,0);
 assert.equal(second.externalRequestState,'not_sent');assert.equal(second.revision,firstRound.revision);
 assert.deepEqual(second.scopeBinding,firstRound.scopeBinding);
 assertPublished(requeued);
 // 重复点击：第二下引用的还是已经被取代的那一轮，必须拒绝，不能派出第三轮。
 await assert.rejects(()=>rounds.dispatch({actor:f.owner.args.actor,input:{candidateId:f.input.candidateId,
  expectedRevision:revisionBefore,supersededJobId:firstRound.jobId,confirmPreviousRoundSentNothing:true}}),
  error=>error.code==='ROUND_NOT_ALLOWED'&&/已经重派过/.test(error.message));
 assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs.filter(e=>e.jobType==='d_production_execution').length,2);

 // 同一个运行时实例继续跑：工人注册表只允许一个，重派也不需要重启服务。
 const view=buildDESavedJobRuntimeView({candidate:requeued.candidates[0],
  runtime:{...requeued.runtime,workers:f.registry.snapshot()},serviceBindings:f.options.deServiceBindings,
  productionBindings:f.options.productionBindings,dependencyView:blocked.dependencyView,observedAt:f.options.serverClock()});
 assert.equal(view.canContinueSaved,true);
 assert.equal(view.continueJobId,dispatched.jobId);
 assert.equal(view.canDispatchNewRound,false);

 // 新一轮真的把素材传上去、把商品导入发到平台了；这才是「能上架」，不只是排了个作业。
 const outcome=await blocked.continueSavedCurrent({...f.input,jobId:dispatched.jobId,expectedRevision:revisionBefore});
 assert.equal(outcome.status,'waiting_platform');
 assert.equal(f.puts.length,2);
 assert.deepEqual(f.calls,['/v3/product/import']);
 const done=await f.repository.readSnapshot(),sku=done.candidates[0].lifecycleV11.skuPackage;
 assert.equal(sku.dSoftwareExecution.softwareJobRef.jobId,dispatched.jobId);
 assert.equal(sku.dAssetTransport.softwareJobRef.jobId,dispatched.jobId);
 assert.equal(sku.dSoftwareExecution.productionPlan.sourceAuthorization.authorizationId,
  stopped.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId);
 const executed=done.runtime.softwareJobs.find(e=>e.jobId===dispatched.jobId);
 assert.equal(executed.status,'waiting_platform');assert.equal(executed.externalRequestState,'succeeded');
 // 失败的第一轮一个字节都没被改写。
 assert.deepEqual(done.runtime.softwareJobs.find(e=>e.jobId===firstRound.jobId),firstRound);
 assertPublished(done);
});

// 只要上一轮无法证明零发送，就绝不允许重派——这是整条规则的保险丝。
test('上一轮可能已经发出请求时拒绝重派，且不创建任何新作业',async()=>{
 const f=await fixture();
 const runtime=createDEProductionRuntimeServices(f.options);
 await runtime.continueSavedCurrent(f.input);
 const sent=await f.repository.readSnapshot();
 const job=sent.runtime.softwareJobs.find(entry=>entry.jobType==='d_production_execution');
 assert.notEqual(job.externalRequestRef,null);
 const rounds=createDProductionRoundUseCase({repository:f.repository,serverClock:f.options.serverClock});
 await assert.rejects(()=>rounds.dispatch({actor:f.owner.args.actor,input:{candidateId:f.input.candidateId,
  expectedRevision:sent.candidates[0].dataRevision,supersededJobId:job.jobId,confirmPreviousRoundSentNothing:true}}),
  error=>error.code==='ROUND_NOT_ALLOWED'&&/还没停下来|没发出去/.test(error.message));
 assert.deepEqual((await f.repository.readSnapshot()).runtime.softwareJobs,sent.runtime.softwareJobs);
});
