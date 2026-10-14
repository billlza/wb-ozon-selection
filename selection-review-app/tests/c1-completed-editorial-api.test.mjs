import test from 'node:test';
import { createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { stopApiProcess } from './helpers/api-process-lifecycle.mjs';
import { createC1CompletedEditorialFixture } from './fixtures/c1-completed-editorial-fixture.mjs';
import { fingerprintC1ReviewContent } from '../lib/c1-content-review-use-case.mjs';

const appDir=fileURLToPath(new URL('..',import.meta.url));
const port=Number(process.env.SELECTION_REVIEW_TEST_PORT),dependencyPort=Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if(![port,dependencyPort].every(value=>Number.isSafeInteger(value)&&value>0&&![4317,4318,4173].includes(value))||port===dependencyPort) throw new Error('TEST_REQUIRES_ISOLATED_PORT');
const base=`http://127.0.0.1:${port}`;

test('completed bilingual editorial adoption requires real local owner login and survives restart without another provider call',async t=>{
  const f=await createC1CompletedEditorialFixture({at:new Date().toISOString()}),{candidate,bundle}=f;
  const directory=await mkdtemp(path.join(tmpdir(),'completed-editorial-api-'));
  await mkdir(path.join(directory,'private'),{mode:0o700});
  await mkdir(path.join(directory,'business'));
  const dataFile=path.join(directory,'business/state.json'),proposalFile=path.join(directory,'private/proposal.json');
  await writeFile(dataFile,JSON.stringify(f.document));await writeFile(proposalFile,JSON.stringify(bundle),{mode:0o600});
  let dependencyRequests=0,child=null,cookie='';const stderr=[];
  const dependency=createServer((request,response)=>{dependencyRequests++;response.writeHead(500,{'Content-Type':'application/json'});response.end('{}');});
  t.after(async()=>{
    try {if(child)await stopApiProcess(child);}finally {
      dependency.closeAllConnections();
      if(dependency.listening)await new Promise((resolve,reject)=>dependency.close(error=>error?reject(error):resolve()));
      await rm(directory,{recursive:true,force:true});
    }
  });
  await new Promise((resolve,reject)=>{dependency.once('error',reject);dependency.listen(dependencyPort,'127.0.0.1',resolve);});
  async function start() {
    child=spawn(process.execPath,[path.join(appDir,'server.mjs'),'--api-only'],{cwd:appDir,env:{...process.env,
      SELECTION_REVIEW_API_PORT:String(port),SELECTION_REVIEW_DATA_FILE:dataFile,
      SELECTION_REVIEW_PUBLIC_ORIGIN:base,SELECTION_REVIEW_ALLOWED_ORIGINS:base,
      SELECTION_REVIEW_IDENTITY_PROVIDER:'local_owner_password',SELECTION_REVIEW_OWNER_IDENTITY_FILE:path.join(directory,'private/owner.json'),
      SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE:proposalFile,SELECTION_REVIEW_C2_UPLOAD_DIR:path.join(directory,'uploads'),
      SELECTION_REVIEW_STORE_BINDINGS_JSON:JSON.stringify([{targetStore:candidate.targetStore,platform:candidate.targetPlatform,storeRef:candidate.storeRef}]),
      SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON:'[]',SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON:'[]',SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON:'[]',
      SELECTION_REVIEW_AI_GATEWAY_URL:`http://127.0.0.1:${dependencyPort}`,SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL:`http://127.0.0.1:${dependencyPort}`,
      SELECTION_REVIEW_CODEX_DISPATCH:'off',SELECTION_REVIEW_AUTO_DELIVER:'off'},stdio:['ignore','pipe','pipe']});
    child.stderr.on('data',chunk=>stderr.push(String(chunk)));
    await new Promise((resolve,reject)=>{
      let stdout='';const launched=child;
      const timer=setTimeout(()=>done(new Error(`API_START_TIMEOUT:${stdout}:${stderr.join('')}`)),10000);
      const onData=chunk=>{stdout+=chunk;if(stdout.includes(base))done();};
      const onExit=(code,signal)=>done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join('')}`));
      function done(error){clearTimeout(timer);launched.stdout.off('data',onData);launched.off('error',done);launched.off('exit',onExit);if(error)reject(error);else resolve();}
      launched.stdout.on('data',onData);launched.once('error',done);launched.once('exit',onExit);
    });
  }
  async function post(route,body,{authenticated=true,origin=base}={}) {
    const response=await fetch(`${base}${route}`,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',
      ...(authenticated&&cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  async function login(action) {
    const response=await post(`/api/owner-access/${action}`,{password:'synthetic completed editorial password'},{authenticated:false});
    assert.equal(response.status,200,JSON.stringify(response.body));cookie=response.cookie.split(';')[0];
  }
  async function current() {
    const response=await fetch(`${base}/api/state`,{headers:{Cookie:cookie}});assert.equal(response.status,200);
    return (await response.json()).candidates.find(item=>item.id===candidate.id);
  }
  async function readDocument(){return createJsonBusinessStateRepository({filePath:dataFile}).readSnapshot();}
  async function assertProtected() {
    const saved=await readDocument();
    for(const key of ['softwareJobs','softwareJobAuthorizationRecords','softwareJobCredentialBindings']) assert.deepEqual(saved.runtime[key],f.document.runtime[key]);
    assert.deepEqual(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1,bundle.request);
    assert.deepEqual(saved.candidates[0].lifecycleV11.skuPackage.profitModels,candidate.lifecycleV11.skuPackage.profitModels);
    assert.deepEqual(JSON.parse(await readFile(proposalFile,'utf8')),bundle);assert.equal(dependencyRequests,0);
  }
  const route=`/api/candidates/${candidate.id}/lifecycle/c1/confirm-editorial-content`;
  let input;await start();
  await t.test('login and proposal previews remain read-only',async()=>{
    const bytes=await readFile(dataFile);await login('setup');await login('login');
    for(let i=0;i<2;i++) {
      const view=(await current()).c1EditorialReviewView;
      assert.equal(view.status,'awaiting_confirmation');assert.equal(view.canConfirm,true);
      assert.deepEqual(view.changes.map(change=>change.path),['output.description']);
      assert.equal(view.content.description.text,bundle.correctionPlan.items[0].correctedText);
      assert.equal(view.content.description.reviewZh,bundle.correctionPlan.items[0].correctedReviewZh);
      assert.equal(view.semanticValidation.automatedSemanticProof,false);
      input={candidateId:candidate.id,expectedRevision:view.expectedRevision,editorialVersionId:view.editorialVersionId,
        outputFingerprint:view.outputFingerprint,confirmed:true,idempotencyKey:'completed-editorial:api-confirm',auditEventId:'completed-editorial:api-audit'};
    }
    assert.deepEqual(await readFile(dataFile),bytes);await assertProtected();
  });
  await t.test('authentication, origin and exact confirmation scope reject before writes',async()=>{
    const bytes=await readFile(dataFile);
    assert.equal((await post(route,input,{authenticated:false})).status,401);
    assert.equal((await post(route,input,{origin:'https://untrusted.invalid'})).status,403);
    const originalContent=await post(`/api/candidates/${candidate.id}/lifecycle/c1/confirm-content`,{
      candidateId:candidate.id,expectedRevision:candidate.dataRevision,
      contentFingerprint:fingerprintC1ReviewContent(candidate.lifecycleV11.skuPackage),confirmed:true,
      idempotencyKey:'completed-editorial:old-content',auditEventId:'completed-editorial:old-content-audit'});
    assert.equal(originalContent.status,409,JSON.stringify(originalContent.body));
    assert.equal(originalContent.body.code,'C1_CONTENT_REVIEW_EDITORIAL_REQUIRED');
    assert.deepEqual(await readFile(dataFile),bytes);
    for(const [change,status] of [[{confirmed:false},400],[{expectedRevision:input.expectedRevision-1},409],
      [{editorialVersionId:'editorial:other'},409],[{outputFingerprint:'0'.repeat(64)},409],
      [{candidateId:'candidate:other'},400],[{correctedText:'injected'},400]]) {
      const response=await post(route,{...input,...change});assert.equal(response.status,status,JSON.stringify(response.body));
      assert.deepEqual(await readFile(dataFile),bytes);
    }
    await assertProtected();
  });
  await t.test('concurrent confirmation adopts one version while preserving the completed paid execution',async()=>{
    const results=await Promise.all([post(route,input),post(route,input)]);
    for(const result of results)assert.equal(result.status,200,JSON.stringify(result.body));
    assert.deepEqual(new Set(results.map(result=>result.body.status)),new Set(['committed','idempotent_replay']));
    const saved=await readDocument(),sku=saved.candidates[0].lifecycleV11.skuPackage;
    assert.equal(saved.candidates[0].dataRevision,candidate.dataRevision+1);
    assert.equal(sku.dataRevision,bundle.request.sourceSkuRevision+3);
    assert.equal(sku.businessPhase,'C2');assert.equal(sku.c2FinalAssets.status,'awaiting_final_uploads');
    assert.deepEqual(sku.c2FinalAssets.assets.finalUploads,[]);assert.equal(sku.productionAuthorization,null);
    assert.equal(sku.c1ProductPlan.descriptionDraft.reviewZh,bundle.correctionPlan.items[0].correctedReviewZh);
    assert.equal(saved.runtime.operationAudit.filter(row=>row.action==='c1_confirm_editorial_content').length,1);
    assert.equal(saved.runtime.softwareJobs[0].status,'completed');assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition,'applied');
    const bytes=await readFile(dataFile);assert.equal((await post(route,input)).body.status,'idempotent_replay');
    assert.deepEqual(await readFile(dataFile),bytes);await assertProtected();
  });
  await t.test('restart reads the same confirmed version without new work',async()=>{
    const bytes=await readFile(dataFile);await stopApiProcess(child);child=null;cookie='';await start();await login('login');
    const value=await current();assert.equal(value.c1EditorialReviewView.status,'confirmed');assert.equal(value.c1EditorialReviewView.canConfirm,false);
    assert.equal(value.c1EditorialReviewView.editorialVersionId,input.editorialVersionId);
    assert.equal(value.c1EditorialReviewView.content.description.reviewZh,bundle.correctionPlan.items[0].correctedReviewZh);
    assert.deepEqual(await readFile(dataFile),bytes);await assertProtected();assert.equal(stderr.join(''),'');
  });
});
