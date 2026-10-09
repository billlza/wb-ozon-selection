import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {productionOwnerDecisionHttpFixture,startSavedDEApi} from './helpers/d-e-saved-api-fixture.mjs';

test('real default-off discovery API enforces owner, source and closed input without credential or external access',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'a-discovery-http-probe-')),directory=await mkdtemp(path.join(tmpdir(),'a-discovery-http-state-'));
  const probe=path.join(root,'counts.json'),preload=path.join(root,'deny-external.mjs');
  await writeFile(probe,JSON.stringify({credentials:0,network:0}));
  await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}cp.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');`);
  const fixture=await productionOwnerDecisionHttpFixture(),document={...fixture.document,candidates:[]};
  delete document.runtime;
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const env={SELECTION_REVIEW_TEST_GATEWAY_PORT:String(dependencyPort),NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
    SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON:'[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:'[]'};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));let api;
  try{Object.assign(process.env,env);api=await startSavedDEApi(t,{directory,port,document,binding:fixture.binding});}
  finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  t.after(async()=>{assert.deepEqual(JSON.parse(await readFile(probe,'utf8')),{credentials:0,network:0});await rm(root,{recursive:true,force:true});});
  assert.equal((await api.get('/api/product-discovery')).status,401);
  assert.equal((await api.post('/api/product-discovery/create',{}, {authenticated:false})).status,401);
  await api.authenticate();
  const bytes=await api.readBytes(),view=await api.get('/api/product-discovery');assert.equal(view.status,200);
  assert.equal(view.body.runtimeStatus,'not_configured');assert.equal(view.body.canPrepare,false);
  assert.deepEqual(view.body.configurationBlockers,['PLAN_NOT_CONFIGURED','CONNECTOR_NOT_CONFIGURED','SERVICE_NOT_CONFIGURED']);assert.deepEqual(view.body.plans,[]);assert.deepEqual(view.body.bindings,[]);
  assert.deepEqual(view.body.batches,[]);assert.equal(view.body.activeExecution,null);assert.equal(view.body.platformWrites,0);
  const input={planId:'plan:unconfigured',planVersion:'version:1',targetStore:'miska',bindingId:'binding:unconfigured',configurationVersion:'version:1',idempotencyKey:'create:one'};
  assert.equal((await api.post('/api/product-discovery/create',input)).status,503);
  assert.equal((await api.post('/api/product-discovery/create',{...input,verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/create',input,{headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await api.post('/api/product-discovery/create',input,{headers:{Origin:'https://untrusted.invalid','Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await api.post('/api/product-discovery/create',{payload:'x'.repeat(9000)})).status,413);
  for(const route of ['authorize','continue','select','decline'])assert.equal((await api.post(`/api/product-discovery/${route}`,{verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/select',{batchId:'a-discovery-batch:none',expectedRevision:0,marketProductId:'1'},{authenticated:false})).status,401);
  assert.equal((await api.post('/api/product-discovery/select',{batchId:'a-discovery-batch:none',expectedRevision:0,marketProductId:'1'})).status,409);
  const decline={batchId:'a-discovery-batch:none',expectedRevision:0,marketProductId:'1',reason:'尺寸太大'};
  assert.equal((await api.post('/api/product-discovery/decline',decline,{authenticated:false})).status,(await api.post('/api/product-discovery/create',{},{authenticated:false})).status);
  assert.equal((await api.post('/api/product-discovery/decline',{...decline,verified:true})).status,400);
  // Only the fixed owner reasons are accepted; free text never reaches the saved record.
  assert.equal((await api.post('/api/product-discovery/decline',{...decline,reason:'我自己写的理由'})).status,400);
  assert.equal((await api.post('/api/product-discovery/decline',decline)).status,409);
  assert.equal((await api.post('/api/product-discovery/translate',{batchId:'a-discovery-batch:none',expectedRevision:0},{authenticated:false})).status,(await api.post('/api/product-discovery/create',{},{authenticated:false})).status);
  assert.equal((await api.post('/api/product-discovery/translate',{batchId:'a-discovery-batch:none',expectedRevision:0,verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/translate',{batchId:'a-discovery-batch:none',expectedRevision:0})).status,409);
  assert.equal((await api.post('/api/product-discovery/estimate',{batchId:'a-discovery-batch:none',expectedRevision:0},{authenticated:false})).status,(await api.post('/api/product-discovery/create',{},{authenticated:false})).status);
  assert.equal((await api.post('/api/product-discovery/estimate',{batchId:'a-discovery-batch:none',expectedRevision:0,verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/estimate',{batchId:'a-discovery-batch:none',expectedRevision:0})).status,409);
  assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
  await api.restart();await api.authenticate('login');
  assert.equal((await api.get('/api/product-discovery')).body.runtimeStatus,'not_configured');
  assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
});

/**
 * The desk's one click over the real API. The round is fully configured so the whole saved path runs, but the one
 * configured credential alias answers exactly as a missing keychain item does, so the job stops before any request:
 * no external call, no platform write, and the points the owner would have spent are never spent here.
 */
test('一次 start 请求把这一轮建好、许可并开始；重复同一个幂等键只留一个批次和一份许可',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'a-discovery-start-probe-')),directory=await mkdtemp(path.join(tmpdir(),'a-discovery-start-state-'));
  const probe=path.join(root,'counts.json'),preload=path.join(root,'deny-external.mjs');
  await writeFile(probe,JSON.stringify({network:0,keychain:0}));
  await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';
const counts={network:0,keychain:0};const save=()=>writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));
cp.execFile=(...args)=>{const callback=args[args.length-1];counts.keychain++;save();
const error=new Error('SYNTHETIC_KEYCHAIN_ITEM_ABSENT');error.code=44;if(typeof callback==='function')callback(error,'','');};
syncBuiltinESMExports();globalThis.fetch=async()=>{counts.network++;save();throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');};`);
  const contractVersion='linkfox-discovery-93a1dbf-v1';
  const connector={provider:'linkfox',bindingId:'route:synthetic-start',configurationVersion:'version:1',gatewayOrigin:'https://tool-gateway.linkfox.com',
    credentialAlias:'linkfox-synthetic-start',contractVersion,allowedMethods:['ozon_market_search'],timeoutMs:1000,budgetPolicyRef:'budget:synthetic-start'};
  const plan={schemaVersion:'a-discovery-plan-v1',planId:'plan:synthetic-start',version:'version:1',provider:'linkfox',contractVersion,
    selection:{schemaVersion:'a-discovery-selection-v1',marketOrder:'provider_order',supplierOrder:'provider_order',maxCandidates:1},
    direction:'合成方向（只用于隔离测试）',requests:[{requestId:'discovery:market',method:'ozon_market_search',keywords:['органайзер'],pageSize:20}],
    budget:{unit:'linkfox_credits',maxRequests:1,maxCredits:12},exclusions:['明确品牌/IP风险']};
  const fixture=await productionOwnerDecisionHttpFixture(),document={...fixture.document,candidates:[]};
  delete document.runtime;
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const env={SELECTION_REVIEW_TEST_GATEWAY_PORT:String(dependencyPort),NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
    SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:JSON.stringify([connector]),
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON:JSON.stringify([{schemaVersion:'a-discovery-service-binding-v1',serviceId:'service:synthetic-start',
      configurationVersion:'version:1',connectorBindingId:connector.bindingId,connectorConfigurationVersion:connector.configurationVersion,
      workerId:'worker:synthetic-start',workerVersion:'version:1',leaseDurationMs:60000,pumpIntervalMs:600000}]),
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:JSON.stringify([{credentialAlias:connector.credentialAlias,
      keychainService:'synthetic-absent-service',keychainAccount:'synthetic-absent-account'}]),
    SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:JSON.stringify([plan])};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));let api;
  try{Object.assign(process.env,env);api=await startSavedDEApi(t,{directory,port,document,binding:fixture.binding});}
  finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  const input={planId:plan.planId,planVersion:plan.version,targetStore:'miska',bindingId:connector.bindingId,
    configurationVersion:connector.configurationVersion,expiresAt:new Date(Date.now()+2*60*60*1000).toISOString(),
    idempotencyKey:'desk-round:synthetic-one'};
  assert.equal((await api.post('/api/product-discovery/start',input,{authenticated:false})).status,401);
  await api.authenticate();
  // Closed input: nothing extra, nothing missing, nothing outside the two owner stores.
  assert.equal((await api.post('/api/product-discovery/start',{...input,verified:true})).status,400);
  const {expiresAt,...withoutExpiry}=input;
  assert.equal((await api.post('/api/product-discovery/start',withoutExpiry)).status,400);
  assert.equal((await api.post('/api/product-discovery/start',{...input,expiresAt:'not-a-time'})).status,400);
  assert.equal((await api.post('/api/product-discovery/start',{...input,targetStore:'wb'})).status,400);
  assert.equal((await api.post('/api/product-discovery/start',input,{headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await api.post('/api/product-discovery/start',input,{headers:{Origin:'https://untrusted.invalid','Sec-Fetch-Site':'cross-site'}})).status,403);
  const before=await api.readDocument();
  assert.equal(Object.keys(before.runtime?.aDiscoveryBatches??{}).length,0);
  const first=await api.post('/api/product-discovery/start',input);
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.deepEqual(Object.keys(first.body.operationResult).sort(),['batch','job','resumed']);
  assert.equal(first.body.operationResult.resumed,false);
  const batchId=first.body.operationResult.batch.batchId,jobId=first.body.operationResult.job.jobId;
  assert.equal(first.body.operationResult.job.subject.batchId,batchId);
  assert.equal(first.body.batches.length,1);
  // The same click sent twice resumes the one round; it never opens a second batch or a second permit.
  const again=await api.post('/api/product-discovery/start',input);
  assert.equal(again.status,200,JSON.stringify(again.body));
  assert.equal(again.body.operationResult.resumed,true);
  assert.equal(again.body.operationResult.batch.batchId,batchId);
  assert.equal(again.body.operationResult.job.jobId,jobId);
  const saved=await api.readDocument();
  assert.deepEqual(Object.keys(saved.runtime.aDiscoveryBatches),[batchId]);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length,1);
  assert.equal(saved.runtime.softwareJobCredentialBindings.length,1);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].scopeBinding.batchId,batchId);
  assert.deepEqual(saved.runtime.softwareJobs.map(job=>job.jobId),[jobId]);
  // The round really started and stopped at the credential boundary: no request was ever issued.
  const receipt=saved.runtime.aDiscoveryReceipts[jobId];
  assert.equal(receipt.status,'failed');
  assert.ok(['CREDENTIAL_MISSING','CREDENTIAL_UNAVAILABLE'].includes(receipt.failureClass),receipt.failureClass);
  assert.equal(receipt.steps[0].externalRequestState,'not_sent');
  assert.equal(receipt.steps[0].requestTransmission,'not_attempted');
  assert.equal(again.body.batches[0].jobs[0].job.status,'failed');
  assert.equal(again.body.platformWrites,0);
  const counts=JSON.parse(await readFile(probe,'utf8'));
  assert.equal(counts.network,0);
  assert.ok(counts.keychain<=1,`keychain attempts ${counts.keychain}`);
  await api.assertClean();
});
