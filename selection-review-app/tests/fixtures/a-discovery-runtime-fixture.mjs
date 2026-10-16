import { createMemoryBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../../lib/software-job-repository.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { createADiscoveryRuntimeServices } from '../../lib/a-discovery-runtime-services.mjs';
import { LINKFOX_DISCOVERY_GATEWAY } from '../../lib/linkfox-discovery-api.mjs';
import { createADiscoveryContractFixture, discoveryAt } from './a-discovery-contract-fixture.mjs';

/** `ownerUserId` opens the batch as someone else, e.g. a team account; the fixture's own id is not a team account's. */
export function createADiscoveryRuntimeFixture({ownerUserId=null}={}){
  const {batch}=createADiscoveryContractFixture();let now=discoveryAt,secrets=0;const calls=[],imports=[];
  const clock=()=>now,owner=createActorContext({authenticatedAt:now,userId:ownerUserId??batch.ownerUserId,sessionId:'session:discovery-test',
    actorType:'human',roles:['owner'],source:'authenticated_identity_provider'});
  const repository=createMemoryBusinessStateRepository({candidates:[],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}});
  const connectorBinding={provider:'linkfox',bindingId:batch.bindingId,configurationVersion:batch.configurationVersion,gatewayOrigin:LINKFOX_DISCOVERY_GATEWAY,
    credentialAlias:batch.credentialAlias,contractVersion:batch.plan.contractVersion,allowedMethods:['ozon_market_search','supplier_search'],timeoutMs:1000,budgetPolicyRef:batch.budgetPolicyRef};
  const serviceBinding={schemaVersion:'a-discovery-service-binding-v1',serviceId:'service:discovery',configurationVersion:'version:1',connectorBindingId:batch.bindingId,
    connectorConfigurationVersion:batch.configurationVersion,workerId:'worker:synthetic',workerVersion:'version:1',leaseDurationMs:60000,pumpIntervalMs:1000};
  const readSecret=async()=>{secrets++;return 'synthetic-only-value';};
  const fetchImpl=async(url)=>{
    calls.push(url);const supplier=url.endsWith('/dld/productSearch');
    const products=supplier?[{offerId:'876240928352',asinUrl:'https://detail.1688.com/offer/876240928352.html',title:'合成收纳',currency:'CNY',price:5}]:
      [{sku:2107989735,productUrl:'https://www.ozon.ru/product/2107989735',title:'Synthetic organizer',price:297,currency:'₽'}];
    return new Response(JSON.stringify({code:'200',errcode:200,total:products.length,products}));
  };
  const onBatchReady=async({batchId,revision})=>repository.transact(document=>{
    const mapping=document.runtime.aDiscoveryCandidateImports??={};const key=`${batchId}:${revision}`;
    if(mapping[key])return {changed:false,result:mapping[key]};
    imports.push(key);
    const result={schemaVersion:'a-discovery-candidate-import-v1',batchId,revision,recordedAt:clock(),status:'all_duplicates',candidateId:null,
      marketProductId:null,sourceJobIds:document.runtime.softwareJobs.filter(job=>job.subject.batchId===batchId).map(job=>job.jobId),failureClass:null};
    mapping[key]=result;return {changed:true,document,result};
  });
  function create(overrides={}){
    const workerRegistry=createLocalDevelopmentWorkerRegistry({clock});
    const softwareJobStore=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry,serverClock:clock});
    const options={repository,softwareJobStore,workerRegistry,runtimeMode:'local_development',serverClock:clock,serviceBindings:[serviceBinding],
      connectorBindings:[connectorBinding],plans:[batch.plan],readSecret,fetchImpl,onBatchReady,onError:async error=>{throw error;},...overrides};
    return {service:createADiscoveryRuntimeServices(options),store:softwareJobStore,options};
  }
  async function prepare(service){return service.createBatch({actor:owner,input:{planId:batch.plan.planId,planVersion:batch.plan.version,targetStore:batch.targetStore,
    bindingId:batch.bindingId,configurationVersion:batch.configurationVersion,idempotencyKey:'create:discovery'}});}
  const authorize=(service,created,overrides={})=>service.authorizeAndRun({actor:owner,input:{batchId:created.batch.batchId,expectedRevision:created.batch.revision,
    expiresAt:'2026-09-08T13:00:00.000Z',idempotencyKey:'authorize:discovery',...overrides}});
  return {repository,owner,batch,connectorBinding,serviceBinding,clock,readSecret,fetchImpl,onBatchReady,create,prepare,authorize,calls,imports,
    counts:()=>({secrets,requests:calls.length}),advance:ms=>{now=new Date(Date.parse(now)+ms).toISOString();}};
}
