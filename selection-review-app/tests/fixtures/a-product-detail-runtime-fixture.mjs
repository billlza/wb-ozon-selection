import { createADiscoveryRuntimeFixture } from './a-discovery-runtime-fixture.mjs';
import { createADiscoveryCandidateImportUseCase } from '../../lib/a-discovery-candidate-import.mjs';
import { createAProductDetailRuntimeServices } from '../../lib/a-product-detail-runtime-services.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../../lib/software-job-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { LINKFOX_DETAIL_CONTRACT_VERSION } from '../../lib/linkfox-product-detail-api.mjs';

/** Real approved search jobs and import precede every detail test; only the network is synthetic. `ownerUserId` runs the search as someone else. */
export async function createAProductDetailRuntimeFixture({ownerUserId=null}={}){
  const search=createADiscoveryRuntimeFixture({ownerUserId});
  const importer=createADiscoveryCandidateImportUseCase({repository:search.repository,serverClock:search.clock,storeBindings:[]});
  const {service}=search.create({onBatchReady:input=>importer.importBatch(input)}),batch=await search.prepare(service);
  await search.authorize(service,batch);await service.runDue();await service.runDue();await service.stop();
  const candidate=(await search.repository.readSnapshot()).candidates[0];let secrets=0;const calls=[],applications=[];
  const connectorBinding={...search.connectorBinding,bindingId:'detail:binding',configurationVersion:'detail:version',contractVersion:LINKFOX_DETAIL_CONTRACT_VERSION,
    allowedMethods:['ozon_detail','supplier_detail'],budgetPolicyRef:'detail:budget',credentialAlias:'linkfox-detail-synthetic'};
  const serviceBinding={...search.serviceBinding,schemaVersion:'a-product-detail-service-binding-v1',serviceId:'service:detail',workerId:'worker:detail-synthetic',
    connectorBindingId:connectorBinding.bindingId,connectorConfigurationVersion:connectorBinding.configurationVersion};
  const readSecret=async()=>{secrets++;return 'synthetic-only-detail';};
  const fetchImpl=async(url,options)=>{
    calls.push(url);const body=JSON.parse(options.body);
    const data=body.sku?{code:'200',errcode:200,total:1,products:[{sku:Number(body.sku),title:'Synthetic organizer',price:297,currency:'₽',productUrl:`https://www.ozon.ru/product/${body.sku}/`}]}:
      {errcode:200,offerId:body.offerId,subject:'合成收纳',minOrderQuantity:1,skuList:[{skuId:'1234567',retailPrice:'5.90'}]};
    return new Response(JSON.stringify(data));
  };
  const onDetailsReady=async({candidateId,sourceRevision})=>search.repository.transact(document=>{
    const map=document.runtime.aProductDetailApplications??={},key=`${candidateId}:${sourceRevision}`;
    if(map[key])return {changed:false,result:map[key]};
    // This fixture exercises the handoff boundary. The production application's own tests validate its business products.
    applications.push(key);const record={schemaVersion:'a-product-detail-application-v1',candidateId,sourceRevision,resultRevision:null,status:'blocked',recordedAt:search.clock(),
      sourceJobIds:document.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read').map(job=>job.jobId),salesSnapshotId:null,supplierOptionId:null,failureClass:'TEST_APPLICATION_BOUNDARY'};
    map[key]=record;return {changed:true,document,result:record};
  });
  function create(overrides={}){
    const workerRegistry=createLocalDevelopmentWorkerRegistry({clock:search.clock}),store=createRepositoryBackedSoftwareJobStore({businessStateRepository:search.repository,workerRegistry,serverClock:search.clock});
    const options={repository:search.repository,softwareJobStore:store,runtimeMode:'local_development',serverClock:search.clock,workerRegistry,
      serviceBindings:[serviceBinding],connectorBindings:[connectorBinding],readSecret,fetchImpl,onDetailsReady,onError:async error=>{throw error;},...overrides};
    return {service:createAProductDetailRuntimeServices(options),store,options};
  }
  const input={candidateId:candidate.id,expectedRevision:candidate.dataRevision,bindingId:connectorBinding.bindingId,configurationVersion:connectorBinding.configurationVersion,
    expiresAt:'2026-09-08T13:00:00.000Z',idempotencyKey:'authorize:detail'};
  return {...search,candidate,connectorBinding,serviceBinding,readSecret,fetchImpl,onDetailsReady,create,input,calls,applications,counts:()=>({secrets,requests:calls.length}),
    authorize:(service,overrides={})=>service.authorizeAndRun({actor:search.owner,input:{...input,...overrides}})};
}
