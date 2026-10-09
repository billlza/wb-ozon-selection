import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {createRepositoryBackedSoftwareJobStore} from '../lib/software-job-repository.mjs';
import {createLocalDevelopmentWorkerRegistry} from '../lib/worker-registry.mjs';
import {productionOwnerDecisionFixture} from './fixtures/production-owner-decision-fixture.mjs';
import {commitSingleOwnerProductionAuthorization} from '../lib/production-authorization.mjs';
import {savedDProductionJobFixture} from './fixtures/d-production-saved-job-fixture.mjs';
import {createDPlatformObservationRuntimeFixture} from './fixtures/d-platform-observation-runtime-fixture.mjs';
import {commitDExecutionIntent,persistDExecutionCheckpoint,runPersistedDExecution} from '../lib/d-e-software-integration.mjs';
import {createSyntheticDCompletionAdapter} from './helpers/d-synthetic-completion-adapter.mjs';
import {normalizeDPlatformObservationConfiguration,createDPlatformObservationPolicyResolver} from '../lib/runtime-configuration.mjs';

const types=['d_production_execution','e_d_platform_observation','e_independent_readback'];
function cold(document,clock){
 const repository=createMemoryBusinessStateRepository(document),workerRegistry=createLocalDevelopmentWorkerRegistry({clock});
 return {repository,store:createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry,serverClock:clock})};
}

test('filtered D/E restart preserves queued unsent production and completed business authorization exactly',async()=>{
 const f=productionOwnerDecisionFixture();await commitSingleOwnerProductionAuthorization(f.args);
 const before=await f.repository.readSnapshot(),{repository,store}=cold(before,()=>f.formal.at);
 assert.equal(before.runtime.softwareJobs[0].status,'queued');
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[]});
 assert.deepEqual(await repository.readSnapshot(),before);
 for(const invalid of [['d_production_execution','d_production_execution'],['d_production_execution','c1_ai_draft'],['c2_stable_asset_transport'],[...types,'unknown']]){
  await assert.rejects(store.reconcileAfterRestart({jobTypes:invalid}),/SOFTWARE_JOB_RESTART_FILTER_INVALID/);
  assert.deepEqual(await repository.readSnapshot(),before);
 }
});

test('filtered restart preserves accepted import and its unsent observation without replaying the write',async()=>{
 const f=await createDPlatformObservationRuntimeFixture(),before=await f.d.repository.readSnapshot();
 const {repository,store}=cold(before,f.d.input.serverClock);
 assert.equal(before.runtime.softwareJobs.find(value=>value.jobType==='d_production_execution').externalRequestState,'succeeded');
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[]});
 assert.deepEqual(await repository.readSnapshot(),before);assert.deepEqual(f.d.calls,['/v3/product/import']);
 assert.equal((await store.listDPlatformObservationJobs({limit:1})).length,1);
});

test('filtered restart classifies sent D as unknown and never replays it or changes unselected jobs',async()=>{
 const f=await savedDProductionJobFixture(),admitted=await commitDExecutionIntent(f.input);
 await persistDExecutionCheckpoint({repository:f.repository,candidateId:f.input.candidateId,executionKey:admitted.result.executionKey,
  expectedExecutionRevision:1,event:{kind:'import_intent'},serverClock:f.input.serverClock,softwareJobContext:f.input.softwareJobContext,
  currentProductionBinding:f.currentProductionBinding});
 const before=await f.repository.readSnapshot(),{repository,store}=cold(before,f.input.serverClock);
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:['e_independent_readback']}),{reconciled:[]});
 assert.deepEqual(await repository.readSnapshot(),before);
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[f.job.jobId]});
 const saved=await repository.readSnapshot(),job=saved.runtime.softwareJobs.find(value=>value.jobId===f.job.jobId);
 assert.equal(job.status,'unknown_outcome');assert.equal(job.externalRequestState,'unknown_outcome');assert.equal(job.automaticRetryAllowed,false);
 assert.deepEqual(saved.candidates,before.candidates);
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[]});
 assert.deepEqual(await repository.readSnapshot(),saved);assert.equal(f.calls.length,0);
 await assert.rejects(store.claim({jobId:job.jobId,worker:f.worker,leaseId:'lease:replay',leaseDurationMs:60000}));
 assert.deepEqual(await repository.readSnapshot(),saved);
});

test('filtered restart marks an interrupted platform observation unknown and creates no successor query',async()=>{
 const f=await createDPlatformObservationRuntimeFixture(),observation=await f.job();
 await f.d.jobStore.claim({jobId:observation.jobId,worker:f.d.worker,leaseId:'lease:interrupted-observation',leaseDurationMs:60000});
 await f.d.jobStore.markExternalRequestStarted({jobId:observation.jobId,workerId:f.d.worker.workerId,leaseId:'lease:interrupted-observation',externalRequestRef:'request:synthetic:observation'});
 const {repository,store}=cold(await f.d.repository.readSnapshot(),f.d.input.serverClock);
 await store.reconcileAfterRestart({jobTypes:types});
 const saved=await repository.readSnapshot();
 assert.equal(saved.runtime.softwareJobs.find(value=>value.jobId===observation.jobId).status,'unknown_outcome');
 assert.equal(saved.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.status,'unknown_outcome');
 assert.equal((await store.listDPlatformObservationJobs({limit:1})).length,0);
 const count=saved.runtime.softwareJobs.length;
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[]});
 assert.equal((await repository.readSnapshot()).runtime.softwareJobs.length,count);assert.equal(f.calls.length,0);
});

test('filtered restart preserves queued E and closes a sent E without repeating reads',async()=>{
 const f=await savedDProductionJobFixture();
 await runPersistedDExecution({...f.input,createAdapter:async({request})=>createSyntheticDCompletionAdapter({request})});
 const queued=await f.repository.readSnapshot(),e=queued.runtime.softwareJobs.find(value=>value.jobType==='e_independent_readback');
 const first=cold(queued,f.input.serverClock);assert.deepEqual(await first.store.reconcileAfterRestart({jobTypes:types}),{reconciled:[]});
 assert.deepEqual(await first.repository.readSnapshot(),queued);
 await f.jobStore.claim({jobId:e.jobId,worker:f.worker,leaseId:'lease:interrupted-e',leaseDurationMs:60000});
 await f.jobStore.markExternalRequestStarted({jobId:e.jobId,workerId:f.worker.workerId,leaseId:'lease:interrupted-e',externalRequestRef:'request:synthetic:e-read'});
 const before=await f.repository.readSnapshot(),{repository,store}=cold(before,f.input.serverClock);
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[e.jobId]});
 const saved=await repository.readSnapshot();assert.equal(saved.runtime.softwareJobs.find(value=>value.jobId===e.jobId).status,'unknown_outcome');
 assert.deepEqual(saved.candidates,before.candidates);assert.deepEqual(saved.runtime.softwareJobs.find(value=>value.jobId===f.job.jobId),before.runtime.softwareJobs.find(value=>value.jobId===f.job.jobId));
 assert.deepEqual(await store.reconcileAfterRestart({jobTypes:types}),{reconciled:[]});assert.equal(f.calls.length,0);
});

test('current-PA observation policy uses original D revision and rejects unrelated scopes without fallback',async()=>{
 const f=await savedDProductionJobFixture(),candidate=f.candidate,job=f.job;
 const policy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:current-pa',version:'version:1',
  maxQueries:20,intervalMs:15000,requestTimeoutMs:30000,expiresAt:new Date(Date.parse(f.input.serverClock())+3600000).toISOString()};
 const entry={candidateId:candidate.id,skuPackageId:job.skuPackageId,authorizationRef:job.scopeBinding.authorizationRef,
  revision:job.revision,productionBindingId:job.scopeBinding.productionBinding.bindingId,
  productionConfigurationVersion:job.scopeBinding.productionBinding.configurationVersion,policy};
 const dPlatformObservation=normalizeDPlatformObservationConfiguration({policies:[entry],pumpIntervalMs:1000},[f.currentProductionBinding]);
 const resolve=createDPlatformObservationPolicyResolver({dPlatformObservation});
 assert.deepEqual(resolve({candidate:{...candidate,dataRevision:candidate.dataRevision+2},job}),policy);
 for(const field of ['candidateId','skuPackageId','productionBindingId','productionConfigurationVersion']){
  const changed=structuredClone(entry);changed[field]=`${entry[field]}:other`;
  const resolver=createDPlatformObservationPolicyResolver({dPlatformObservation:{policies:[changed],pumpIntervalMs:1000}});
  assert.equal(resolver({candidate,job}),null,field);
 }
 // 2026-09-23：查询策略是技术容量配置，不跟授权版本走。旧授权下配的策略在重签一版授权之后
 // 仍然适用——否则新授权取不到策略，导入被接受后不会排观察作业，商品发出去却永远不写库存。
 for(const field of ['authorizationRef','revision']){
  const changed=structuredClone(entry);changed[field]=field==='revision'?entry.revision+1:`${entry[field]}:other`;
  const resolver=createDPlatformObservationPolicyResolver({dPlatformObservation:{policies:[changed],pumpIntervalMs:1000}});
  assert.deepEqual(resolver({candidate,job}),policy,field);
 }
 assert.throws(()=>normalizeDPlatformObservationConfiguration({policies:[entry],pumpIntervalMs:null},[f.currentProductionBinding]),/PUMP_CONFIGURATION_REQUIRED/);
});
