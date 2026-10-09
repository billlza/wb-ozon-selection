import test from 'node:test';
import assert from 'node:assert/strict';
import { createADiscoveryRuntimeFixture } from './fixtures/a-discovery-runtime-fixture.mjs';
import { runADiscoverySoftwareJob } from '../lib/a-discovery-software-runner.mjs';

test('configured plans create only a saved batch until explicit owner authorization',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  assert.deepEqual(await service.runDue(),{status:'idle',externalRequests:0});
  const created=await f.prepare(service),again=await f.prepare(service);
  assert.deepEqual(again.batch,created.batch);assert.equal(again.idempotentReplay,true);
  const saved=await f.repository.readSnapshot();assert.deepEqual(saved.runtime.softwareJobs,[]);assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,[]);
  assert.deepEqual(f.counts(),{secrets:0,requests:0});assert.equal(service.view({document:saved,actor:f.owner}).batches[0].canAuthorize,true);
  await assert.rejects(()=>service.createBatch({actor:f.owner,input:{plan:created.batch.plan}}),/INPUT_INVALID/);
  await service.stop();
});
test('three explicit one-use permissions advance sequentially and a restarted service cannot pay twice',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create(),created=await f.prepare(service);
  const first=await f.authorize(service,created);assert.equal(first.status,'completed');assert.ok(first.nextJobId);
  let saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobAuthorizationRecords.length,3);assert.equal(saved.runtime.softwareJobs.length,2);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords.map(value=>value.useCount),[1,1,0]);
  assert.equal(f.counts().requests,1);assert.equal(saved.candidates.length,0);await service.stop();
  const next=f.create().service;assert.equal((await next.runDue()).status,'completed');assert.equal((await next.runDue()).status,'completed');
  saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs.length,3);assert.ok(saved.runtime.softwareJobs.every(job=>job.status==='completed'&&job.attempt===1));
  assert.equal(f.counts().requests,3);assert.equal(f.imports.length,1);assert.deepEqual(await next.runDue(),{status:'idle',externalRequests:0});
  assert.equal((await f.authorize(next,created)).status,'idempotent_replay');assert.equal(f.counts().requests,3);
  await assert.rejects(()=>f.authorize(next,created,{idempotencyKey:'another:payment'}),/ALREADY_AUTHORIZED/);
  assert.equal(f.counts().requests,3);await next.stop();
});
test('true empty stops the approved sequence without trying supplier queries',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create({fetchImpl:async()=>new Response(JSON.stringify({code:'200',errcode:200,total:0,products:[]}))});
  const result=await f.authorize(service,await f.prepare(service));assert.equal(result.status,'completed');assert.equal(result.nextJobId,null);
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs.length,1);assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords.map(value=>value.useCount),[1,0,0]);
  assert.deepEqual(await service.runDue(),{status:'idle',externalRequests:0});assert.equal(f.imports.length,0);await service.stop();
});
test('queued batch revision drift is visible and performs no secret or request access',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create(),created=await f.prepare(service);
  await f.authorize(service,created);
  await f.repository.transact(document=>{document.runtime.aDiscoveryBatches[created.batch.batchId].revision++;return {changed:true,document};});
  const result=await service.runDue();assert.equal(result.status,'blocked');assert.ok(service.lastAdmissionRejection);
  assert.deepEqual(f.counts(),{secrets:1,requests:1});await service.stop();
});
test('a completed batch resumes only its local import after the last job commit and retains a known terminal import',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service,store,options}=f.create();
  const created=await f.prepare(service);await f.authorize(service,created);await service.runDue();
  const queued=(await f.repository.readSnapshot()).runtime.softwareJobs.find(job=>job.status==='queued');
  // Complete the real persisted runner, stopping before the service's local import callback.
  await runADiscoverySoftwareJob({repository:f.repository,softwareJobStore:store,
    worker:options.workerRegistry.heartbeat({workerId:f.serviceBinding.workerId,version:f.serviceBinding.workerVersion,capabilities:['linkfox-discovery-api'],status:'online'}),
    jobId:queued.jobId,leaseId:'lease:synthetic:before-import',leaseDurationMs:f.serviceBinding.leaseDurationMs,
    connectorBinding:f.connectorBinding,readSecret:f.readSecret,fetchImpl:f.fetchImpl,serverClock:f.clock});
  const before=await f.repository.readSnapshot();assert.equal(before.runtime.softwareJobs.filter(job=>job.status==='completed').length,3);
  assert.equal(f.counts().requests,3);const recovered=f.create().service;
  assert.equal((await recovered.runDue()).status,'continued');assert.equal(f.counts().requests,3);assert.equal(f.imports.length,1);
  const saved=await f.repository.readSnapshot(),view=recovered.view({document:saved,actor:f.owner});
  assert.equal(view.batches[0].candidateImport.status,'all_duplicates');assert.ok(view.batches[0].jobs.every(value=>value.canContinue===false));
  assert.deepEqual(await recovered.runDue(),{status:'idle',externalRequests:0});
  const damaged=structuredClone(saved);damaged.runtime.aDiscoveryCandidateImports[`${created.batch.batchId}:0`].status='success';
  assert.throws(()=>recovered.view({document:damaged,actor:f.owner}),/IMPORT_RECORD/);
  await recovered.stop();await service.stop();
});
test('persisted failed candidate import blocks another callback without changing completed search jobs',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create(),created=await f.prepare(service);
  await f.authorize(service,created);await service.runDue();await service.runDue();await service.stop();
  await f.repository.transact(document=>{
    const key=`${created.batch.batchId}:0`,old=document.runtime.aDiscoveryCandidateImports[key];
    document.runtime.aDiscoveryCandidateImports[key]={...old,status:'failed',sourceJobIds:[],failureClass:'UNEXPECTED_SYSTEM_ERROR'};
    return {changed:true,document};
  });
  const before=await f.repository.readSnapshot();const recovered=f.create({onBatchReady:async()=>{throw new Error('Must not repeat a failed import');}}).service;
  assert.deepEqual(await recovered.runDue(),{status:'idle',externalRequests:0});
  assert.deepEqual(await f.repository.readSnapshot(),before);assert.equal(f.counts().requests,3);await recovered.stop();
});


test('legacy data without runtime is read without migration and explicit preparation creates only a batch',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  await f.repository.transact(document=>{delete document.runtime;return {changed:true,document};});
  const document=await f.repository.readSnapshot(),before=JSON.stringify(document);
  Object.freeze(document);
  const view=service.view({document,actor:f.owner});
  assert.equal(view.canPrepare,true);assert.deepEqual(view.configurationBlockers,[]);assert.deepEqual(view.batches,[]);
  assert.equal(JSON.stringify(document),before);assert.equal(JSON.stringify(await f.repository.readSnapshot()),before);
  await assert.rejects(service.authorizeAndRun({actor:f.owner,input:{batchId:'batch:absent',expectedRevision:0,expiresAt:'2026-09-08T13:00:00.000Z',idempotencyKey:'permit:absent'}}),/BATCH_REQUIRED/);
  assert.equal(JSON.stringify(await f.repository.readSnapshot()),before);
  const created=await f.prepare(service),repeated=await f.prepare(service),saved=await f.repository.readSnapshot();
  assert.equal(repeated.idempotentReplay,true);assert.deepEqual(repeated.batch,created.batch);
  assert.deepEqual(Object.keys(saved.runtime).sort(),['aDiscoveryBatches','aDiscoveryReceipts']);
  assert.deepEqual(saved.candidates,document.candidates);assert.deepEqual(f.counts(),{secrets:0,requests:0});await service.stop();
});

test('discovery rejects damaged runtime and collections instead of treating them as absent',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  for(const runtime of [null,[],false,0,'invalid',undefined]){
    const document={candidates:[],runtime};
    assert.throws(()=>service.view({document,actor:f.owner}),/REPOSITORY_INVALID/);
    await f.repository.transact(current=>({changed:true,document:{...current,runtime}}));
    await assert.rejects(f.prepare(service),/REPOSITORY_INVALID/);
  }
  for(const key of ['aDiscoveryBatches','aDiscoveryReceipts','aDiscoveryCandidateImports','softwareJobs']){
    for(const value of [null,false,0,'invalid',key==='softwareJobs'?{}:[]]){
      assert.throws(()=>service.view({document:{candidates:[],runtime:{[key]:value}},actor:f.owner}),/REPOSITORY_INVALID/);
    }
  }
  assert.deepEqual(f.counts(),{secrets:0,requests:0});await service.stop();
});

test('discovery preparation reports exact missing configuration and rejects an unselected store',async()=>{
  const f=createADiscoveryRuntimeFixture();
  for(const [overrides,expected] of [
    [{plans:[]},['PLAN_NOT_CONFIGURED']],
    [{serviceBindings:[]},['SERVICE_NOT_CONFIGURED']],
    [{serviceBindings:[],connectorBindings:[],plans:[]},['PLAN_NOT_CONFIGURED','CONNECTOR_NOT_CONFIGURED','SERVICE_NOT_CONFIGURED']]
  ]){
    const {service}=f.create(overrides),view=service.view({document:{candidates:[]},actor:f.owner});
    assert.equal(view.canPrepare,false);assert.deepEqual(view.configurationBlockers,expected);await service.stop();
  }
  const {service}=f.create();
  await assert.rejects(service.createBatch({actor:f.owner,input:{planId:f.batch.plan.planId,planVersion:f.batch.plan.version,targetStore:'',
    bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion,idempotencyKey:'create:unselected'}}),/INPUT_INVALID/);
  assert.deepEqual(f.counts(),{secrets:0,requests:0});await service.stop();
});

test('preparation and creation use the same method coverage for partial and mixed plans',async()=>{
  const f=createADiscoveryRuntimeFixture(),connector={...f.connectorBinding,allowedMethods:['ozon_market_search']};
  const full=f.batch.plan,market={...full,planId:'plan:market-only',requests:full.requests.slice(0,1),budget:{...full.budget,maxRequests:1}};
  const incompatible=f.create({connectorBindings:[connector]}).service;
  let view=incompatible.view({document:{candidates:[]},actor:f.owner});
  assert.equal(view.canPrepare,false);assert.deepEqual(view.configurationBlockers,['PLAN_NOT_SUPPORTED']);assert.deepEqual(view.plans,[]);
  await assert.rejects(f.prepare(incompatible),/PLAN_NOT_CONFIGURED/);await incompatible.stop();
  const mixed=f.create({connectorBindings:[connector],plans:[full,market]}).service;
  view=mixed.view({document:{candidates:[]},actor:f.owner});
  assert.equal(view.canPrepare,true);assert.deepEqual(view.configurationBlockers,[]);assert.deepEqual(view.plans,[market]);
  await assert.rejects(f.prepare(mixed),/PLAN_NOT_CONFIGURED/);
  const created=await mixed.createBatch({actor:f.owner,input:{planId:market.planId,planVersion:market.version,targetStore:'miska',
    ...view.bindings[0],idempotencyKey:'create:market-only'}});
  assert.equal(created.batch.plan.planId,market.planId);
  assert.deepEqual(f.counts(),{secrets:0,requests:0});await mixed.stop();
});

test('an owner turning one product down saves one fixed reason, replays the same reason and never invents a record',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create(),created=await f.prepare(service);
  await f.authorize(service,created);
  const input={batchId:created.batch.batchId,expectedRevision:created.batch.revision,marketProductId:'2107989735',reason:'尺寸太大'};
  const first=await service.declineProduct({actor:f.owner,input});
  assert.equal(first.idempotentReplay,false);assert.equal(first.externalRequests,0);
  assert.deepEqual(Object.keys(first.decline).sort(),['batchId','declinedAt','declinedByUserId','marketProductId','reason','revision','schemaVersion']);
  assert.equal(first.decline.schemaVersion,'a-discovery-decline-v1');
  assert.equal(first.decline.declinedByUserId,f.owner.userId);
  const again=await service.declineProduct({actor:f.owner,input});
  assert.equal(again.idempotentReplay,true);assert.deepEqual(again.decline,first.decline);
  await assert.rejects(()=>service.declineProduct({actor:f.owner,input:{...input,reason:'利润太薄'}}),/DECLINE_CONFLICT/);
  await assert.rejects(()=>service.declineProduct({actor:f.owner,input:{...input,reason:'我自己写的理由'}}),/INPUT_INVALID/);
  await assert.rejects(()=>service.declineProduct({actor:f.owner,input:{...input,extra:true}}),/INPUT_INVALID/);
  await assert.rejects(()=>service.declineProduct({actor:f.owner,input:{...input,marketProductId:'9999999999'}}),/PRODUCT_REQUIRED/);
  await assert.rejects(()=>service.declineProduct({actor:f.owner,input:{...input,expectedRevision:9}}),/BATCH_CHANGED/);
  await assert.rejects(()=>service.declineProduct({actor:{...f.owner,userId:'owner:someone-else'},input}),/OWNER_CONFLICT/);
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryDeclines),[`${created.batch.batchId}:0:2107989735`]);
  assert.equal(saved.candidates.length,0);assert.equal(f.counts().requests,1);
  const view=service.view({document:saved,actor:f.owner});
  assert.deepEqual(view.batches[0].declines,[first.decline]);
  const damaged=structuredClone(saved);damaged.runtime.aDiscoveryDeclines[`${created.batch.batchId}:0:2107989735`].reason='别的理由';
  assert.throws(()=>service.view({document:damaged,actor:f.owner}),/DECLINE_RECORD_INVALID/);
  await service.stop();
});

const startInput=(f,overrides={})=>({planId:f.batch.plan.planId,planVersion:f.batch.plan.version,targetStore:f.batch.targetStore,
  bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion,expiresAt:'2026-09-08T13:00:00.000Z',
  idempotencyKey:'desk-round:one',...overrides});
const createInput=(f,overrides={})=>({planId:f.batch.plan.planId,planVersion:f.batch.plan.version,targetStore:f.batch.targetStore,
  bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion,idempotencyKey:'create:another',...overrides});

test('一次点击把这一轮建好、许可并开始；同一个幂等键只续这一轮，不会再建第二个批次',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  const input=startInput(f);
  const first=await service.startRound({actor:f.owner,input});
  assert.deepEqual(Object.keys(first).sort(),['batch','job','resumed']);
  assert.equal(first.resumed,false);assert.equal(first.batch.ownerUserId,f.owner.userId);assert.equal(first.batch.targetStore,f.batch.targetStore);
  assert.equal(first.job.subject.batchId,first.batch.batchId);assert.equal(first.job.revision,first.batch.revision);
  let saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches),[first.batch.batchId]);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length,f.batch.plan.requests.length);
  assert.equal(saved.runtime.softwareJobCredentialBindings.length,f.batch.plan.requests.length);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords.map(value=>value.scopeBinding.batchId),
    saved.runtime.softwareJobAuthorizationRecords.map(()=>first.batch.batchId));
  // The one click really started the round: exactly one saved query was performed for it.
  assert.equal(f.counts().requests,1);
  const again=await service.startRound({actor:f.owner,input});
  assert.equal(again.resumed,true);assert.deepEqual(again.batch,first.batch);assert.equal(again.job.jobId,first.job.jobId);
  saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches),[first.batch.batchId]);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length,f.batch.plan.requests.length);
  assert.equal(f.counts().requests,1);
  const {expiresAt,...withoutExpiry}=input;
  await assert.rejects(()=>service.startRound({actor:f.owner,input:withoutExpiry}),/INPUT_INVALID/);
  await assert.rejects(()=>service.startRound({actor:f.owner,input:{...input,verified:true}}),/INPUT_INVALID/);
  await assert.rejects(()=>service.startRound({actor:f.owner,input:{...input,expiresAt:'not-a-time'}}),/INPUT_INVALID/);
  await assert.rejects(()=>service.startRound({actor:f.owner,input:{...input,targetStore:'wb'}}),/INPUT_INVALID/);
  await assert.rejects(()=>service.startRound({actor:f.owner,input:{...input,planId:'plan:not-configured'}}),/PLAN_NOT_CONFIGURED/);
  await assert.rejects(()=>service.startRound({actor:{...f.owner,roles:['reviewer']},input}),/AUTHORIZATION|FORBIDDEN|ROLE/i);
  assert.equal(f.counts().requests,1);
  await service.stop();
});

test('开始这一轮是一次保存：许可被拒时不会留下一个已扣过钱却没有许可的批次',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  await assert.rejects(()=>service.startRound({actor:f.owner,input:startInput(f,{expiresAt:'2026-09-08T11:00:00.000Z',
    idempotencyKey:'desk-round:expired'})}),/AUTHORIZATION_EXPIRED/);
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches??{}),[]);
  assert.deepEqual(saved.runtime.softwareJobs,[]);assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,[]);
  assert.deepEqual(f.counts(),{secrets:0,requests:0});
  await service.stop();
});

test('上一次只建好却没开始的这一轮，用同一个幂等键续上而不是再建一个',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  const created=await f.prepare(service);
  let saved=await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.softwareJobs,[]);assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,[]);
  // resumed means "this call did not open a new batch": the saved batch is authorized and started instead.
  const resumed=await service.startRound({actor:f.owner,input:startInput(f,{idempotencyKey:'create:discovery'})});
  assert.equal(resumed.resumed,true);assert.equal(resumed.batch.batchId,created.batch.batchId);
  assert.deepEqual(resumed.batch,created.batch);
  saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches),[created.batch.batchId]);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length,f.batch.plan.requests.length);
  assert.equal(saved.runtime.softwareJobs.filter(job=>job.subject.batchId===created.batch.batchId&&job.scopeBinding.requestIndex===0).length,1);
  assert.equal(f.counts().requests,1);
  await service.stop();
});

test('同店同方向已经有一轮在跑时不再开第二轮，原来那一轮仍能用同一个幂等键续上',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  const first=await service.startRound({actor:f.owner,input:startInput(f)});
  const jobs=(await f.repository.readSnapshot()).runtime.softwareJobs;
  assert.ok(jobs.some(job=>job.status==='queued'),'这一轮还有没跑完的步骤');
  const requests=f.counts().requests;
  // A lost answer to the first click must not let the second click open — and pay for — a second round.
  await assert.rejects(()=>service.startRound({actor:f.owner,input:startInput(f,{idempotencyKey:'desk-round:two'})}),/ROUND_ALREADY_RUNNING/);
  await assert.rejects(()=>service.createBatch({actor:f.owner,input:createInput(f)}),/ROUND_ALREADY_RUNNING/);
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches),[first.batch.batchId]);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length,f.batch.plan.requests.length);
  assert.equal(f.counts().requests,requests,'被拒绝的一轮没有发出任何查询');
  const again=await service.startRound({actor:f.owner,input:startInput(f)});
  assert.equal(again.resumed,true);assert.equal(again.batch.batchId,first.batch.batchId);
  assert.equal(f.counts().requests,requests);
  await service.stop();
});

test('刚建好还没开始的那一轮十分钟内挡住同店同方向的新一轮，别的店和十分钟以后都不挡',async()=>{
  const f=createADiscoveryRuntimeFixture(),{service}=f.create();
  const created=await f.prepare(service);
  assert.deepEqual((await f.repository.readSnapshot()).runtime.softwareJobs,[]);
  await assert.rejects(()=>service.createBatch({actor:f.owner,input:createInput(f)}),/ROUND_ALREADY_RUNNING/);
  await assert.rejects(()=>service.startRound({actor:f.owner,input:startInput(f,{idempotencyKey:'desk-round:second'})}),/ROUND_ALREADY_RUNNING/);
  let saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches),[created.batch.batchId]);
  assert.deepEqual(saved.runtime.softwareJobs,[]);assert.deepEqual(f.counts(),{secrets:0,requests:0});
  // Another store's round answers a different question and is never blocked by this one.
  const other=await service.createBatch({actor:f.owner,input:createInput(f,{targetStore:'dandanshu',idempotencyKey:'create:other-store'})});
  assert.equal(other.batch.targetStore,'dandanshu');
  // The saved round keeps resuming: the same key still names it.
  assert.equal((await f.prepare(service)).idempotentReplay,true);
  // Ten minutes on, the saved round is no longer one the desk is about to start, so a fresh round is allowed again.
  f.advance(10*60*1000);
  const later=await service.createBatch({actor:f.owner,input:createInput(f,{idempotencyKey:'create:after-window'})});
  assert.notEqual(later.batch.batchId,created.batch.batchId);
  // A refusal changed nothing: the first saved round can still be authorized and started from its own permit.
  assert.equal((await f.authorize(service,created)).status,'completed');
  saved=await f.repository.readSnapshot();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches).sort(),
    [created.batch.batchId,later.batch.batchId,other.batch.batchId].sort());
  assert.equal(f.counts().requests,1);
  await service.stop();
});
