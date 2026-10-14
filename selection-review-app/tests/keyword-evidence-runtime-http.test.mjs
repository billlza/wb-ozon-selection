import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { c1PaidKeywordSettlementCandidate } from './fixtures/c1-paid-keyword-settlement-fixture.mjs';
import { KEYWORD_NOW } from './fixtures/c1-keyword-planning-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../lib/software-job-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createLocalDevelopmentActor } from '../lib/runtime-identity.mjs';
import { enqueueC1PaidKeywordEvidenceJob } from '../lib/c1-keyword-software-use-case.mjs';

async function historicalJobs() {
  const candidates=await Promise.all(['CLAIMED','WAITING'].map(name=>c1PaidKeywordSettlementCandidate({candidateId:`CX-HTTP-${name}`,supplierSkuId:`SKU-${name}`})));
  const repository=createMemoryBusinessStateRepository({candidates,runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],
    softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}});
  const registry=createLocalDevelopmentWorkerRegistry({clock:()=>KEYWORD_NOW});
  const worker=registry.register({workerId:'worker-seerfar-open-api-1',version:'1.0.0',capabilities:['seerfar-open-api'],observedAt:KEYWORD_NOW});
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry:registry,serverClock:()=>KEYWORD_NOW});
  for(const [index,candidate] of candidates.entries()) {
    const queued=await enqueueC1PaidKeywordEvidenceJob({repository,runtimeMode:'local_development',actor:createLocalDevelopmentActor({at:KEYWORD_NOW,userId:'owner-1',sessionId:'test:keyword-http'}),
      candidateId:candidate.id,expectedRevision:candidate.dataRevision,clientInput:{dataRevision:candidate.dataRevision},serverClock:()=>KEYWORD_NOW});
    const jobId=queued.result.softwareJobRef.jobId,leaseId=`lease:keyword-http:${index}`;
    await store.claim({jobId,worker,leaseId,leaseDurationMs:60000});
    if(index===1)await store.markExternalRequestStarted({jobId,workerId:worker.workerId,leaseId,externalRequestRef:'request:keyword-http:historical'});
  }
  return repository.readSnapshot();
}

test('configured idle HTTP consumer does not touch credentials or network and never claims historical holders as active',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'keyword-runtime-http-probe-'));
  const directory=await mkdtemp(path.join(tmpdir(),'keyword-runtime-http-state-'));
  const probeFile=path.join(root,'attempts.json'),preload=path.join(root,'deny-external.mjs');
  await writeFile(probeFile,JSON.stringify({credentials:0,network:0}));
  // Test-only interception rejects before the real keychain/fetch boundary; it does not supply successful evidence.
  await writeFile(preload,`import childProcess from 'node:child_process';\nimport {syncBuiltinESMExports} from 'node:module';\nimport {writeFileSync} from 'node:fs';\nconst counts={credentials:0,network:0};\nfunction reject(kind){counts[kind]++;writeFileSync(${JSON.stringify(probeFile)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}\nchildProcess.execFile=()=>reject('credentials');syncBuiltinESMExports();\nglobalThis.fetch=async()=>reject('network');\n`);
  const fixture=await productionOwnerDecisionHttpFixture();
  const document={...fixture.document,candidates:[],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}};
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const binding={schemaVersion:'c1-keyword-service-binding-v1',serviceId:'service:keyword:http',configurationVersion:'1',provider:'seerfar_open_api',
    workerId:'worker-seerfar-open-api-1',workerVersion:'1.0.0',leaseDurationMs:60000,pumpIntervalMs:1,requestTimeoutMs:1000};
  const overrides={SELECTION_REVIEW_TEST_GATEWAY_PORT:String(dependencyPort),SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON:JSON.stringify([binding]),
    NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`};
  const previous=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  let api;
  try {Object.assign(process.env,overrides);api=await startSavedDEApi(t,{directory,port,document,binding:fixture.binding});}
  finally {for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  t.after(async()=>{assert.deepEqual(JSON.parse(await readFile(probeFile,'utf8')),{credentials:0,network:0});await rm(root,{recursive:true,force:true});});
  await api.authenticate();
  const status=await api.get('/api/integrations/seerfar/runtime-status');assert.equal(status.status,200);
  assert.equal(status.body.consumerConnected,true);assert.equal(status.body.serviceStatus,'running');
  assert.equal(status.body.credentialStatus,'not_checked');assert.equal(status.body.configured,null);
  assert.equal(status.body.directProviderExecutionEnabled,false);assert.equal(status.body.automaticRetries,0);
  assert.deepEqual((await api.readDocument()).candidates,[]);assert.deepEqual((await api.readDocument()).runtime.softwareJobs,[]);
  const historical=await historicalJobs();
  // Persist only domain-produced historical fixtures; no HTTP business action or paid job is created by this running service.
  const stagedFile=`${api.dataFile}.synthetic-next`;
  await writeFile(stagedFile,JSON.stringify({...document,candidates:historical.candidates,runtime:historical.runtime}));
  await rename(stagedFile,api.dataFile);
  const saved=await api.readBytes(),state=await api.get('/api/state');assert.equal(state.status,200);
  for(const candidate of state.body.candidates) {
    const view=candidate.c1PaidKeywordSoftwareJob;
    assert.ok(view,'actual server keyword job projection is required');
    assert.equal(view.currentExecutionConfirmed,false);assert.equal(view.serviceStatus,'running',api.stderr.join(''));
    assert.ok(['claimed','waiting_platform'].includes(view.status));
  }
  assert.equal(state.body.candidates.length,2);assert.deepEqual(await api.readBytes(),saved);
  await api.assertClean();assert.deepEqual(JSON.parse(await readFile(probeFile,'utf8')),{credentials:0,network:0});
});
