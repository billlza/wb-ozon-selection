import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionReviewRuntimeConfiguration,normalizeDPlatformObservationConfiguration,createDPlatformObservationPolicyResolver } from '../lib/runtime-configuration.mjs';
import { createConfiguredOzonAccountDiscoveryRuntime } from '../lib/ozon-account-discovery-runtime.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';

const at='2026-09-08T01:00:00.000Z',serverClock=()=>at;
const actor=createActorContext({userId:'owner:synthetic',sessionId:'session:synthetic',actorType:'human',roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:at});
const route={bindingId:'binding:discovery:synthetic',configurationVersion:'configuration:1',platform:'ozon',targetStore:'miska',storeName:'合成账户',credentialAlias:'alias:discovery:synthetic',workerId:'worker:discovery:synthetic',workerVersion:'worker:1',leaseDurationMs:10000};
const credential={credentialAlias:route.credentialAlias,clientId:'700123',keychainService:'synthetic-account',keychainAccount:'synthetic-read'};
const env={SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON:JSON.stringify([route]),SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON:JSON.stringify([credential])};
const configure=(value={})=>createSelectionReviewRuntimeConfiguration({env:value,appDir:'/synthetic-unavailable/discovery',argv:[]});

test('independent discovery routes load without store or warehouse assertions and without external access',async t=>{
  const network=t.mock.method(globalThis,'fetch',()=>{throw new Error('Unexpected network access');});
  const configuration=configure(env);assert.deepEqual(configuration.productionBindings,[]);assert.deepEqual(configuration.ozonAccountDiscoveryBindings,[route]);
  const repository=createMemoryBusinessStateRepository({candidates:[],runtime:{}}),workerRegistry=createLocalDevelopmentWorkerRegistry({clock:serverClock});
  let calls=0;const service=createConfiguredOzonAccountDiscoveryRuntime({configuration,repository,workerRegistry,serverClock,requestJson:async()=>{calls++;throw new Error('Unexpected account read');}});
  const before=await repository.readSnapshot(),view=service.view({document:before,actor});
  assert.equal(view.bindings.length,1);assert.equal(view.bindings[0].clientId,'700123');assert.equal(view.bindings[0].storeIdentityStatus,'unverified');
  assert.equal(Object.hasOwn(view.bindings[0],'storeRef'),false);assert.equal(Object.hasOwn(view.bindings[0],'warehouseId'),false);
  const binding=view.bindings[0],input={bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,idempotencyKey:'create:synthetic'};
  const created=await service.createPreparation({actor,input});assert.equal(created.preparation.revision,0);
  assert.deepEqual((await repository.readSnapshot()).candidates,[]);assert.equal((await repository.readSnapshot()).runtime.softwareJobs,undefined);
  assert.equal(calls,0);assert.equal(network.mock.callCount(),0);
  assert.deepEqual(await service.createPreparation({actor,input}),created);
});

test('missing configuration is explicit; historical preparation is retained when a route is removed',async()=>{
  const configuration=configure(),repository=createMemoryBusinessStateRepository({candidates:[],runtime:{}});
  const service=createConfiguredOzonAccountDiscoveryRuntime({configuration,repository,serverClock,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:serverClock}),requestJson:async()=>{throw new Error('Unexpected read');}});
  assert.deepEqual(service.view({document:await repository.readSnapshot(),actor}).bindings,[]);
  assert.throws(()=>service.createPreparation({actor,input:{bindingId:route.bindingId}}),/NOT_CONFIGURED/);
  assert.throws(()=>service.view({document:{candidates:[],runtime:{ozonAccountPreparations:{saved:{createdByUserId:actor.userId}}}},actor}),/NOT_CONFIGURED/);
  assert.throws(()=>service.view({document:{candidates:[],runtime:{}},actor:{...actor,roles:[]}}));
});

test('discovery configuration refuses manufactured verification, missing credentials, duplicate workers and invalid input',()=>{
  for(const change of [{...route,verified:true},{...route,warehouseId:'10001'},{...route,targetStore:'wb'},{...route,leaseDurationMs:0}]) {
    assert.throws(()=>configure({...env,SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON:JSON.stringify([change])}));
  }
  assert.throws(()=>configure({SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON:JSON.stringify([route])}));
  assert.throws(()=>configure({...env,SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON:JSON.stringify([route,{...route,bindingId:'different:binding'}])}));
  assert.throws(()=>configure({...env,SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON:'{invalid'}));
});

test('removing one route retains its preparation but exposes no actions through another configured route',async()=>{
  const repository=createMemoryBusinessStateRepository({candidates:[],runtime:{}});
  const construct=configuration=>createConfiguredOzonAccountDiscoveryRuntime({configuration,repository,serverClock,
    workerRegistry:createLocalDevelopmentWorkerRegistry({clock:serverClock}),requestJson:async()=>{throw new Error('Unexpected account access');}});
  const initial=construct(configure(env)),binding=initial.view({document:await repository.readSnapshot(),actor}).bindings[0];
  await initial.createPreparation({actor,input:{bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,idempotencyKey:'create:removed-route'}});
  const otherRoute={...route,bindingId:'binding:other',targetStore:'dandanshu',credentialAlias:'alias:other',workerId:'worker:other'};
  const otherCredential={...credential,credentialAlias:otherRoute.credentialAlias,clientId:'700124'};
  const changed=construct(configure({SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON:JSON.stringify([otherRoute]),SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON:JSON.stringify([otherCredential])}));
  const view=changed.view({document:await repository.readSnapshot(),actor});
  assert.equal(view.bindings[0].bindingId,otherRoute.bindingId);assert.equal(view.preparations.length,1);
  assert.equal(view.preparations[0].configurationBlocker,'account_route_unavailable');
  assert.equal(view.preparations[0].canAuthorize,false);assert.equal(view.preparations[0].canSelectWarehouse,false);
  assert.deepEqual(view.preparations[0].jobs,[]);assert.equal((await repository.readSnapshot()).runtime.softwareJobs,undefined);
});

test('observation policies have explicit bounded inputs and exact immutable source matching',()=>{
  const policy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic',version:'1',maxQueries:5,intervalMs:1000,requestTimeoutMs:1000,expiresAt:'2026-09-08T02:00:00.000Z'};
  const entry={candidateId:'candidate:1',skuPackageId:'sku:1',authorizationRef:'permission:1',revision:3,productionBindingId:'binding:1',productionConfigurationVersion:'config:1',policy};
  const production=[{bindingId:'binding:1',configurationVersion:'config:1',platform:'ozon'}];
  const normalized=normalizeDPlatformObservationConfiguration({policies:[entry],pumpIntervalMs:500},production);
  assert.ok(Object.isFrozen(normalized.policies[0].policy));
  const load=createDPlatformObservationPolicyResolver({dPlatformObservation:normalized});
  const input={candidate:{id:'candidate:1'},job:{skuPackageId:'sku:1',revision:3,scopeBinding:{authorizationRef:'permission:1',productionBinding:{bindingId:'binding:1',configurationVersion:'config:1'}}}};
  assert.deepEqual(load(input),policy);
  // 2026-09-23：查询策略是技术容量配置，不跟授权版本或候选修订走。重签一版授权之后
  // revision 和 authorizationRef 都会变，若仍据此拒绝，新授权取不到策略，
  // 导入被接受后不会排观察作业，商品发出去却永远不写库存。
  assert.deepEqual(load({...input,job:{...input.job,revision:4}}),policy);
  assert.deepEqual(load({...input,job:{...input.job,scopeBinding:{...input.job.scopeBinding,authorizationRef:'permission:2'}}}),policy);
  // 商品、SKU、仓库绑定、配置版本任一不同仍必须取不到
  assert.equal(load({...input,candidate:{id:'candidate:2'}}),null);
  assert.equal(load({...input,job:{...input.job,skuPackageId:'sku:2'}}),null);
  assert.equal(load({...input,job:{...input.job,scopeBinding:{...input.job.scopeBinding,productionBinding:{bindingId:'binding:2',configurationVersion:'config:1'}}}}),null);
  assert.equal(load({...input,job:{...input.job,scopeBinding:{...input.job.scopeBinding,productionBinding:{bindingId:'binding:1',configurationVersion:'config:2'}}}}),null);
  // r70 ④：规范化结果多了 defaults（店铺级默认观察策略）。这里断言的是**精确形状**，
  // 所以要把新字段写进期望值——不是放宽断言，仍然逐字段精确比对。
  assert.deepEqual(configure().dPlatformObservation,{policies:[],pumpIntervalMs:null,defaults:[]});
  for(const bad of [{policies:[entry],pumpIntervalMs:null},{policies:[entry,entry],pumpIntervalMs:1},{policies:[{...entry,policy:{...policy,maxQueries:101}}],pumpIntervalMs:1},{policies:[],pumpIntervalMs:2147483648}])assert.throws(()=>normalizeDPlatformObservationConfiguration(bad,production));
  assert.throws(()=>configure({SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON:'{}'}));
});
