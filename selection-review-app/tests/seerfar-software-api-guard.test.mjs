import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';


for (const oldFlag of ['false','true']) {
  test(`旧开关=${oldFlag}不直连付费；当前身份、来源、输入和冻结证据门禁拒绝且零写入`,async t=>{
    const directory=await mkdtemp(path.join(tmpdir(),'seerfar-software-guard-state-'));
    const probeRoot=await mkdtemp(path.join(tmpdir(),'seerfar-software-guard-probe-'));
    const probe=path.join(probeRoot,'counts.json'),preload=path.join(probeRoot,'deny-external.mjs');
    await writeFile(probe,JSON.stringify({credentials:0,network:0}));
    await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}cp.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');`);
    const fixture=await productionOwnerDecisionHttpFixture();
    const candidate={id:'CX-C1-NOT-READY',dataRevision:7,lifecycleV11:{skuPackage:{candidateId:'CX-C1-NOT-READY',skuPackageId:'sku:not-ready:7',businessPhase:'C1',c1ProductPlan:{status:'inputs_ready'}}}};
    const document={...fixture.document,candidates:[candidate]};
    const { api: port, gateway: dependencyPort } = allocatedTestPorts();
    const env={SELECTION_REVIEW_TEST_GATEWAY_PORT:String(dependencyPort),SELECTION_REVIEW_SEERFAR_SOFTWARE_ENABLED:oldFlag,
      SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON:'[]',NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`};
    const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));let api;
    try{Object.assign(process.env,env);api=await startSavedDEApi(t,{directory,port,document,binding:fixture.binding});}
    finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
    t.after(async()=>{assert.deepEqual(JSON.parse(await readFile(probe,'utf8')),{credentials:0,network:0});await rm(probeRoot,{recursive:true,force:true});});
    const route='/api/candidates/CX-C1-NOT-READY/lifecycle/c1/keyword-evidence-software-run';
    assert.equal((await api.post(route,{dataRevision:7},{authenticated:false})).status,401);
    await api.authenticate();const before=await api.readBytes();
    const runtime=await api.get('/api/integrations/seerfar/runtime-status');assert.equal(runtime.status,200);
    assert.equal(runtime.body.directProviderExecutionEnabled,false);assert.equal(runtime.body.consumerConnected,false);
    assert.equal(runtime.body.credentialStatus,'not_checked');
    assert.equal((await api.post(route,{dataRevision:7},{headers:{Origin:'https://untrusted.invalid','Sec-Fetch-Site':'cross-site'}})).status,403);
    const unsafe=await api.post(route,{dataRevision:7,seerfarRequest:{skuIds:['unsafe']}});
    assert.equal(unsafe.status,400);assert.match(unsafe.body.message,/CLIENT_INPUT_REJECTED/);
    const notReady=await api.post(route,{dataRevision:7});
    assert.equal(notReady.status,422);assert.match(notReady.body.message,/C1_KEYWORD_SOFTWARE_NOT_READY/);
    assert.equal((await api.post('/api/candidates/NO-SUCH/lifecycle/c1/keyword-evidence-software-run',{dataRevision:1})).status,404);
    assert.deepEqual(await api.readBytes(),before);await api.assertClean();
  });
}
