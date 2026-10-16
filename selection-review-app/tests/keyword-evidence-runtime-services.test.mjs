import test from 'node:test';
import assert from 'node:assert/strict';
import { runC1PaidKeywordEvidenceSoftwareJob } from '../lib/keyword-evidence-software-runner.mjs';
import { createKeywordEvidenceRuntimeServices, C1KeywordContinuationRevisionConflictError } from '../lib/keyword-evidence-runtime-services.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../lib/software-job-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createLocalDevelopmentActor } from '../lib/runtime-identity.mjs';
import { enqueueC1PaidKeywordEvidenceJob } from '../lib/c1-keyword-software-use-case.mjs';
import { c1PaidKeywordSettlementCandidate, c1PaidKeywordFixtureReceipt } from './fixtures/c1-paid-keyword-settlement-fixture.mjs';
import { KEYWORD_NOW } from './fixtures/c1-keyword-planning-fixture.mjs';

const binding={schemaVersion:'c1-keyword-service-binding-v1',serviceId:'service:keyword:test',configurationVersion:'1',provider:'seerfar_open_api',
  workerId:'worker-seerfar-open-api-1',workerVersion:'1.0.0',leaseDurationMs:60000,pumpIntervalMs:1000,requestTimeoutMs:1000};
function receipt(){
  const value=c1PaidKeywordFixtureReceipt(),a=value.attempt;
  return {observation:{...a,completed:true,explicitEmpty:true},candidates:[],pointsBefore:value.pointsBefore,pointsAfter:value.pointsAfter,
    pointsSpent:value.pointsSpent,evidence:value.providerEvidence};
}
async function fixture(serviceBinding=binding){
  const candidate=await c1PaidKeywordSettlementCandidate();
  const repository=createMemoryBusinessStateRepository({candidates:[candidate],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],
    softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}});
  const registry=createLocalDevelopmentWorkerRegistry({clock:()=>KEYWORD_NOW});
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry:registry,serverClock:()=>KEYWORD_NOW});
  const enqueue=()=>enqueueC1PaidKeywordEvidenceJob({repository,runtimeMode:'local_development',actor:createLocalDevelopmentActor({at:KEYWORD_NOW,userId:'owner-1',sessionId:'test:keyword'}),
    candidateId:candidate.id,expectedRevision:candidate.dataRevision,clientInput:{dataRevision:candidate.dataRevision},serverTime:KEYWORD_NOW,serverClock:()=>KEYWORD_NOW,allowedWorkerIds:[serviceBinding.workerId]});
  let factories=0,calls=0;const callbacks=[];
  const create=(options={})=>{
    const restartedRegistry=createLocalDevelopmentWorkerRegistry({clock:()=>KEYWORD_NOW});
    const restartedStore=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry:restartedRegistry,serverClock:()=>KEYWORD_NOW});
    return createKeywordEvidenceRuntimeServices({repository,softwareJobStore:restartedStore,runtimeMode:'local_development',serverClock:()=>KEYWORD_NOW,
    workerRegistry:restartedRegistry,serviceBindings:[serviceBinding],createTransport:({beforeRequestSend})=>{factories++;return async()=>{await beforeRequestSend({stage:'target'});calls++;return receipt();};},
    onEvidenceReady:async(...args)=>callbacks.push(args),onError:async error=>{throw error;},...options});};
  return {candidate,repository,store,registry,create,enqueue,callbacks,counts:()=>({factories,calls})};
}
test('empty configuration and idle queue never construct a credential-bearing transport',async()=>{
  const f=await fixture(),unconfigured=f.create({serviceBindings:[]});unconfigured.start();
  assert.equal((await unconfigured.runDue()).status,'not_configured');await unconfigured.stop();
  const service=f.create();assert.equal((await service.runDue()).status,'idle');
  service.start();service.start();await service.stop();assert.deepEqual(f.counts(),{factories:0,calls:0});
});
test('a central service runs the same keyword service; an unknown mode is refused',async()=>{
  const f=await fixture();
  for(const runtimeMode of ['central_test','central_production'])assert.equal((await f.create({runtimeMode}).runDue()).status,'idle');
  assert.throws(()=>f.create({runtimeMode:'local'}),/KEYWORD_SERVICE_DEPENDENCY_INVALID/);
  assert.deepEqual(f.counts(),{factories:0,calls:0});
});
test('one paid job executes once and an unknown continuation failure persists and blocks restart',async()=>{
  const f=await fixture();await f.enqueue();const error=new Error('synthetic callback interrupted');
  let completedJob;
  const service=f.create({onEvidenceReady:async()=>{completedJob=(await f.repository.readSnapshot()).runtime.softwareJobs[0];throw error;}});
  const first=service.runDue(),second=service.runDue();assert.equal(first,second);
  await assert.rejects(first,value=>value===error);
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs[0].status,'completed');
  assert.deepEqual(f.counts(),{factories:1,calls:1});
  assert.deepEqual(saved.runtime.softwareJobs[0],completedJob);
  const exception=saved.candidates[0].executionRuntime.exceptionCase;
  assert.equal(exception.softwareJobId,saved.runtime.softwareJobs[0].jobId);
  assert.equal(exception.failureLayer,'c1_keyword_handoff');assert.equal(exception.unknownOutcome,false);
  assert.equal(JSON.stringify(saved).includes(error.message),false);
  const restarted=f.create();assert.equal((await restarted.runDue()).status,'idle');
  assert.equal(f.callbacks.length,0);
  assert.deepEqual(f.counts(),{factories:1,calls:1});assert.deepEqual(await f.repository.readSnapshot(),saved);
});
test('queued source drift remains visible as blocked without transport construction',async()=>{
  const f=await fixture();await f.enqueue();const original=await f.repository.readSnapshot();
  await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
  const service=f.create(),result=await service.runDue();assert.equal(result.status,'blocked');assert.ok(result.rejections.length);
  assert.deepEqual(f.counts(),{factories:0,calls:0});assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs[0].status,'queued');
  assert.equal(service.lastAdmissionRejection.jobId,original.runtime.softwareJobs[0].jobId);
  // Restore the exact synthetic source to exercise a previously rejected, still-unclaimed job's later admission.
  await f.repository.transact(()=>({changed:true,document:original}));
  assert.equal((await service.runDue()).status,'committed');assert.equal(service.lastAdmissionRejection,null);
});
test('unknown transport errors persist a bound exception and cannot be replayed by a restarted pump',async()=>{
  const f=await fixture();await f.enqueue();const error=new TypeError('synthetic internal secret detail');
  const service=f.create({createTransport:({beforeRequestSend})=>async()=>{await beforeRequestSend({stage:'target'});throw error;}});
  await assert.rejects(service.runDue(),value=>value===error);
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs[0];
  assert.equal(job.status,'unknown_outcome');assert.equal(saved.candidates[0].executionRuntime.exceptionCase.softwareJobId,job.jobId);
  assert.equal(JSON.stringify(saved).includes(error.message),false);
  assert.equal((await f.create().runDue()).status,'idle');assert.deepEqual(await f.repository.readSnapshot(),saved);
});

test('the target fetch is forbidden after quota observation changes the current revision',async()=>{
  const f=await fixture();await f.enqueue();const stages=[];
  const service=f.create({createTransport:({beforeRequestSend})=>async()=>{
    await beforeRequestSend({stage:'quota_before'});stages.push('quota_before');
    await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
    await beforeRequestSend({stage:'target'});stages.push('target');
    return receipt();
  }});
  const result=await service.runDue();assert.equal(result.result.status,'unknown_outcome');
  assert.deepEqual(stages,['quota_before']);assert.equal(service.activeJobId,null);
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs[0];
  assert.equal(job.externalRequestState,'unknown_outcome');assert.equal(job.automaticRetryAllowed,false);
  assert.equal(saved.candidates[0].executionRuntime?.exceptionCase,undefined);
  assert.equal((await f.create().runDue()).status,'idle');
});
test('stop cancels the active transport and clears active execution without reopening the paid job',async()=>{
  const f=await fixture();await f.enqueue();let enter;
  const entered=new Promise(resolve=>{enter=resolve;});
  const service=f.create({createTransport:({beforeRequestSend,signal})=>async()=>{
    await beforeRequestSend({stage:'quota_before'});enter();
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    assert.fail('cancelled transport continued');
  }});
  const run=service.runDue();await Promise.race([entered,run.then(()=>assert.fail('job ended before transport'))]);
  const jobId=(await f.repository.readSnapshot()).runtime.softwareJobs[0].jobId;
  assert.equal(service.activeJobId,jobId);
  const held=(await f.repository.readSnapshot()).runtime.softwareJobs[0];
  assert.deepEqual(service.activeExecution,{jobId,workerId:held.workerId,leaseId:held.leaseId});
  const detached=service.activeExecution;detached.leaseId='mutated';assert.equal(service.activeExecution.leaseId,held.leaseId);
  await service.stop();await run;
  assert.equal(service.activeJobId,null);assert.equal(service.activeExecution,null);assert.equal(service.status,'stopped');
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs[0].status,'unknown_outcome');
  assert.equal(saved.candidates[0].executionRuntime?.exceptionCase,undefined);
  assert.equal((await f.create().runDue()).status,'idle');
});

test('a crash after durable keyword settlement but before handoff is recovered without a second transport',async()=>{
  const f=await fixture();await f.enqueue();
  const worker=f.registry.register({workerId:binding.workerId,version:binding.workerVersion,capabilities:['seerfar-open-api'],observedAt:KEYWORD_NOW});
  const job=(await f.repository.readSnapshot()).runtime.softwareJobs[0];let calls=0;
  await runC1PaidKeywordEvidenceSoftwareJob({repository:f.repository,softwareJobStore:f.store,worker,jobId:job.jobId,
    leaseId:'lease:synthetic:pre-handoff-crash',leaseDurationMs:60000,serverClock:()=>KEYWORD_NOW,
    openApiTransport:async()=>{calls++;return receipt();}});
  // The durable producer completed; no in-memory callback has run, as after process loss at that boundary.
  const before=await f.repository.readSnapshot();assert.equal(before.runtime.softwareJobs[0].status,'completed');
  assert.equal((await f.create().runDue()).status,'continued');
  assert.deepEqual(f.callbacks,[[f.candidate.id,before.candidates[0].dataRevision]]);
  assert.deepEqual(f.counts(),{factories:0,calls:0});assert.equal(calls,1);
  assert.deepEqual(await f.repository.readSnapshot(),before);
});

test('a typed revision change before handoff preserves completed evidence without a maintenance case',async()=>{
  const f=await fixture();await f.enqueue();let callbacks=0;
  const service=f.create({onEvidenceReady:async()=>{callbacks++;await f.repository.transact(document=>{
    document.candidates[0].dataRevision++;return {changed:true,document};
  });throw new C1KeywordContinuationRevisionConflictError();}});
  const outcome=await service.runDue();assert.equal(outcome.status,'blocked');assert.equal(outcome.failureClass,'C1_KEYWORD_CONTINUATION_REVISION_CONFLICT');
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].status,'completed');assert.equal(callbacks,1);
  assert.equal(saved.candidates[0].executionRuntime?.exceptionCase,undefined);
  assert.equal((await f.create().runDue()).status,'idle');assert.deepEqual(f.counts(),{factories:1,calls:1});
});

test('missing draft configuration is durably blocked without changing completed evidence or retrying handoff',async()=>{
  const f=await fixture();await f.enqueue();let callbacks=0,completedJob;
  const service=f.create({onEvidenceReady:async()=>{
    callbacks++;completedJob=(await f.repository.readSnapshot()).runtime.softwareJobs[0];
    return {status:'blocked',failureClass:'C1_DRAFT_RUNTIME_UNAVAILABLE'};
  }});
  const result=await service.runDue();assert.equal(result.status,'blocked');assert.equal(result.failureClass,'C1_DRAFT_RUNTIME_UNAVAILABLE');
  const saved=await f.repository.readSnapshot(),runtime=saved.candidates[0].executionRuntime;
  assert.deepEqual(saved.runtime.softwareJobs[0],completedJob);assert.equal(runtime.exceptionCase,null);
  assert.equal(runtime.status,'blocked');assert.equal(runtime.technicalFailure.kind,'known_technical_failure');
  assert.equal(runtime.technicalFailure.softwareJobId,completedJob.jobId);
  assert.equal(runtime.technicalFailure.errorCode,'C1_DRAFT_RUNTIME_UNAVAILABLE');
  assert.equal(runtime.technicalFailure.automaticRetryAllowed,false);
  assert.equal((await service.runDue()).status,'idle');assert.equal((await f.create().runDue()).status,'idle');
  assert.equal(callbacks,1);assert.deepEqual(f.counts(),{factories:1,calls:1});assert.deepEqual(await f.repository.readSnapshot(),saved);
});


test('configured non-default worker alone receives the store-bound paid authorization and can execute', async () => {
  const configured={...binding,workerId:'worker:keyword:configured-store-service'};
  const f=await fixture(configured);await f.enqueue();
  const before=await f.repository.readSnapshot();
  const job=before.runtime.softwareJobs[0];
  const credential=before.runtime.softwareJobCredentialBindings[0];
  assert.deepEqual(credential.allowedWorkerIds,[configured.workerId]);
  assert.equal(credential.targetStore,job.scopeBinding.targetStore);
  const wrong=f.create({serviceBindings:[binding]});
  const blocked=await wrong.runDue();
  assert.equal(blocked.status,'blocked');
  assert.deepEqual(f.counts(),{factories:0,calls:0});
  assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs[0].status,'queued');
  const right=f.create();assert.equal((await right.runDue()).status,'committed');
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].workerId,configured.workerId);
  assert.equal(saved.runtime.softwareJobs[0].status,'completed');
  assert.deepEqual(f.counts(),{factories:1,calls:1});
});

test('missing configured keyword service cannot create a new paid authorization', async () => {
  const f=await fixture();const before=await f.repository.readSnapshot();
  await assert.rejects(enqueueC1PaidKeywordEvidenceJob({repository:f.repository,runtimeMode:'local_development',
    actor:createLocalDevelopmentActor({at:KEYWORD_NOW,userId:'owner-1',sessionId:'test:keyword'}),
    candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision,
    clientInput:{dataRevision:f.candidate.dataRevision},serverClock:()=>KEYWORD_NOW,allowedWorkerIds:[]}),
    /C1_KEYWORD_SERVICE_NOT_CONFIGURED/);
  assert.deepEqual(await f.repository.readSnapshot(),before);
  assert.deepEqual(f.counts(),{factories:0,calls:0});
});


test('configured worker cannot consume an authorization moved to another store', async () => {
  const configured={...binding,workerId:'worker:keyword:configured-store-service'};
  const f=await fixture(configured);await f.enqueue();
  await f.repository.transact(document=>{
    document.runtime.softwareJobCredentialBindings[0].targetStore='another-store';
    return {changed:true,document};
  });
  const result=await f.create().runDue();
  assert.equal(result.status,'blocked');
  assert.ok(result.rejections.length>0);
  assert.deepEqual(f.counts(),{factories:0,calls:0});
  assert.equal((await f.repository.readSnapshot()).runtime.softwareJobs[0].status,'queued');
});
