import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {productionOwnerDecisionHttpFixture,startSavedDEApi} from './helpers/d-e-saved-api-fixture.mjs';
import {createADiscoveryRuntimeFixture} from './fixtures/a-discovery-runtime-fixture.mjs';
import {createAProductDetailRuntimeFixture} from './fixtures/a-product-detail-runtime-fixture.mjs';
import {createADiscoveryCandidateImportUseCase} from '../lib/a-discovery-candidate-import.mjs';
import {createAProductDetailApplicationUseCase} from '../lib/a-product-detail-application.mjs';
import {createActorContext} from '../lib/runtime-identity.mjs';
import {buildRealAConfirmationCard} from '../lib/real-a-confirmation-card.mjs';
const at='2026-09-08T12:00:00.000Z';
async function start(t){
 const base=await productionOwnerDecisionHttpFixture(),document={...base.document,candidates:[],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}};
 base.binding={...base.binding,storeRef:{...base.binding.storeRef,stableStoreId:'miska'}};
 const directory=await mkdtemp(path.join(tmpdir(),'a-detail-http-state-')),probeDirectory=await mkdtemp(path.join(tmpdir(),'a-detail-http-probe-'));
 const probe=path.join(probeDirectory,'counts.json'),preload=path.join(probeDirectory,'deny-external.mjs');await writeFile(probe,JSON.stringify({credentials:0,network:0}));
 await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';const NativeDate=Date;const at=NativeDate.parse(${JSON.stringify(at)});globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}cp.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');`);
 const { api: port, gateway: dependencyPort } = allocatedTestPorts();
 const env={SELECTION_REVIEW_TEST_GATEWAY_PORT:String(dependencyPort),NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
  SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:'[]',
  SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON:'[]'};
 const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));let api;
 try{Object.assign(process.env,env);api=await startSavedDEApi(t,{directory,port,document,binding:base.binding});}
 finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 t.after(async()=>{assert.deepEqual(JSON.parse(await readFile(probe,'utf8')),{credentials:0,network:0});await rm(probeDirectory,{recursive:true,force:true});});
 async function save(saved){const temporary=`${api.dataFile}.synthetic`;await writeFile(temporary,JSON.stringify({...document,...saved}));await rename(temporary,api.dataFile);}
 return {api,base,save};
}
async function discovered(ownerId,storeBinding){
 const f=createADiscoveryRuntimeFixture(),actor=createActorContext({userId:ownerId,sessionId:'session:http-source',authenticatedAt:at,actorType:'human',roles:['owner'],source:'authenticated_identity_provider'});
 const importer=createADiscoveryCandidateImportUseCase({repository:f.repository,serverClock:f.clock,storeBindings:[storeBinding]});
 const {service}=f.create({onBatchReady:input=>importer.importBatch(input)});
 const created=await service.createBatch({actor,input:{planId:f.batch.plan.planId,planVersion:f.batch.plan.version,targetStore:storeBinding.targetStore,
  bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion,idempotencyKey:'create:http-detail'}});
 await service.authorizeAndRun({actor,input:{batchId:created.batch.batchId,expectedRevision:created.batch.revision,expiresAt:'2026-09-08T13:00:00.000Z',idempotencyKey:'authorize:http-detail'}});
 await service.runDue();await service.runDue();await service.stop();return f.repository.readSnapshot();
}

test('default-off detail HTTP binds the real owner and current candidate, rejects unsafe submissions, and cold reads change no bytes',async t=>{
 const {api,base,save}=await start(t);
 assert.equal((await api.get('/api/candidates/missing/product-details?revision=1')).status,401);
 const user=await api.authenticate(),saved=await discovered(user.userId,{targetStore:base.binding.storeRef.stableStoreId,platform:base.binding.platform,storeRef:base.binding.storeRef});
 const candidate=saved.candidates[0];await save(saved);const bytes=await api.readBytes(),route=`/api/candidates/${candidate.id}/product-details`;
 const view=await api.get(`${route}?revision=${candidate.dataRevision}`);assert.equal(view.status,200,JSON.stringify(view.body)+api.stderr.join(""));
 assert.equal(view.body.runtimeStatus,'not_configured');assert.equal(view.body.canAuthorize,false);assert.equal(view.body.preparationBlockCode,'SERVICE_NOT_CONFIGURED');
 assert.equal(view.body.proposedReads.length,2);assert.equal(view.body.proposedReads[0].productId,candidate.aDiscoveryEvidenceV1.marketProductId);
 assert.deepEqual(view.body.jobs,[]);assert.equal(view.body.activeExecution,null);
 const foreign=await discovered('local-owner:00000000-0000-4000-8000-000000000000',{targetStore:'miska',platform:base.binding.platform,storeRef:base.binding.storeRef});
 await save(foreign);const foreignBytes=await api.readBytes();
 assert.equal((await api.get(`/api/candidates/${foreign.candidates[0].id}/product-details?revision=${foreign.candidates[0].dataRevision}`)).status,409);
 assert.deepEqual(await api.readBytes(),foreignBytes);await save(saved);
 for(const revision of ['', '01','-1','abc','9007199254740992'])assert.equal((await api.get(`${route}?revision=${revision}`)).status,400);
 assert.equal((await api.get(`${route}?revision=${candidate.dataRevision+1}`)).status,409);
 assert.equal((await api.get('/api/candidates/missing/product-details?revision=1')).status,404);
 const input={candidateId:candidate.id,expectedRevision:candidate.dataRevision,bindingId:'detail:binding',configurationVersion:'detail:version',expiresAt:'2026-09-08T13:00:00.000Z',idempotencyKey:'http:detail'};
 assert.equal((await api.post(`${route}/authorize`,input,{authenticated:false})).status,401);
 assert.equal((await api.post(`${route}/authorize`,input)).status,503);
 assert.equal((await api.post(`${route}/authorize`,{...input,candidateId:'candidate:other'})).status,400);
 assert.equal((await api.post(`${route}/authorize`,{...input,verified:true})).status,400);
 assert.equal((await api.post(`${route}/authorize`,input,{headers:{'Content-Type':'text/plain'}})).status,415);
 assert.equal((await api.post(`${route}/authorize`,input,{headers:{Origin:'https://untrusted.invalid','Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await api.post(`${route}/authorize`,{...input,payload:'x'.repeat(9000)})).status,413);
 assert.equal((await api.post(`${route}/continue`,{candidateId:candidate.id,expectedRevision:candidate.dataRevision,verified:true})).status,400);
 assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();await api.restart();await api.authenticate('login');
 assert.equal((await api.get(`${route}?revision=${candidate.dataRevision}`)).status,200);assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
});

test('A confirmation recognizes saved provider detail source and never enqueues a second browser capture',async t=>{
 const {api,base,save}=await start(t);await api.authenticate();
 const f=await createAProductDetailRuntimeFixture();
 // Declare the local store mapping before this fixture creates detail permissions.
 await f.repository.transact(document=>{document.candidates[0].storeRef=structuredClone(base.binding.storeRef);return {document,changed:true};});
 const application=createAProductDetailApplicationUseCase({repository:f.repository,serverClock:f.clock});
 const {service}=f.create({onDetailsReady:input=>application.applyDetails(input)});await f.authorize(service);await service.runDue();await service.stop();
 const saved=await f.repository.readSnapshot(),candidate=saved.candidates[0];
 assert.equal(candidate.targetStore,base.binding.storeRef.stableStoreId);
 await save(saved);const bytes=await api.readBytes(),card=buildRealAConfirmationCard(candidate);
 const input={decision:'confirm',dataRevision:candidate.dataRevision,sourceCandidateId:candidate.id,sourceDataRevision:candidate.dataRevision,targetPlatform:candidate.targetPlatform,storeRef:candidate.storeRef,
  supplierConfirmation:{productUrl:candidate.sourceUrl},commissionEstimate:{authorized:false}};
 const response=await api.post(`/api/candidates/${candidate.id}/lifecycle/a-confirm`,input);
 assert.equal(response.status,400,JSON.stringify(response.body));assert.match(response.body.message,/估算佣金必须/);
 assert.ok(card.supplierCapture);assert.equal(candidate.sourceCapture,undefined);
 assert.deepEqual(await api.readBytes(),bytes);assert.deepEqual((await api.readDocument()).runtime.softwareJobs,saved.runtime.softwareJobs);
 await api.assertClean();
});

test('server startup itself reconciles a persisted issued detail request as unknown without a replay',async t=>{
 const {api,save}=await start(t);await api.authenticate();
 const f=await createAProductDetailRuntimeFixture();let enter,release;
 const entered=new Promise(resolve=>enter=resolve),pending=new Promise(resolve=>release=resolve);
 const {service}=f.create({fetchImpl:async(...args)=>{enter();await pending;return f.fetchImpl(...args);}});
 t.after(async()=>{release();await service.stop();});
 const execution=f.authorize(service);
 await Promise.race([entered,execution.then(()=>{throw new Error('DETAIL_COMPLETED_BEFORE_SEND_GATE');})]);
 const issued=await f.repository.readSnapshot(),job=issued.runtime.softwareJobs.find(value=>value.jobType==='a_product_detail_read');
 assert.equal(job.status,'waiting_platform');assert.equal(job.externalRequestState,'in_flight');
 assert.equal(issued.runtime.aProductDetailReceipts[job.jobId].steps[0].requestTransmission,'attempted');
 // Capture the persisted crash point. Completing the isolated fixture afterwards
 // only releases its resources; those later results are never installed in HTTP state.
 release();await execution;await service.stop();
 await save(issued);await api.restart();await api.authenticate('login');
 const recovered=await api.readDocument(),current=recovered.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(current.status,'unknown_outcome');assert.equal(current.externalRequestState,'unknown_outcome');assert.equal(current.attempt,1);
 assert.equal(recovered.runtime.aProductDetailReceipts[job.jobId].status,'unknown_outcome');
 assert.equal(recovered.runtime.softwareJobs.filter(value=>value.jobType==='a_product_detail_read').length,1);
 assert.deepEqual(recovered.candidates,issued.candidates);
 const bytes=await api.readBytes();await api.restart();await api.authenticate('login');assert.deepEqual(await api.readBytes(),bytes);
 await api.assertClean();
});


test('legacy candidate detail HTTP view works without adding runtime on read or restart',async t=>{
  const {api,base,save}=await start(t);await api.authenticate();
  const candidate=base.document.candidates[0];assert.ok(candidate);
  await save({...base.document,runtime:undefined});
  const bytes=await api.readBytes();assert.equal(Object.hasOwn(await api.readDocument(),'runtime'),false);
  const route=`/api/candidates/${candidate.id}/product-details?revision=${candidate.dataRevision}`;
  const response=await api.get(route);assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.canAuthorize,false);assert.ok(['SOURCE_INVALID','CANDIDATE_CHANGED'].includes(response.body.preparationBlockCode));
  assert.deepEqual(response.body.jobs,[]);assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
  await api.restart();await api.authenticate('login');assert.equal((await api.get(route)).status,200);
  assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
});
