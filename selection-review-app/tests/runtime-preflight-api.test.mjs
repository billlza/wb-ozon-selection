import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {prepareRuntimePackage} from '../scripts/runtime-package.mjs';
import {verifyRuntimePackage} from '../scripts/verify-package-with-real-env.mjs';
import {createLocalProcessSandboxProfile} from '../scripts/local-process-sandbox-profile.mjs';
import {allocatedTestPorts} from './helpers/api-process-lifecycle.mjs';
const appDir=fileURLToPath(new URL('..',import.meta.url));
const {api:port,gateway:gatewayPort}=allocatedTestPorts();

// This trusted fixture parent must start outside Seatbelt: macOS forbids nesting profiles.
// The package process and the actual OS probes are each protected by a single explicit profile.
test('real configuration preflight enforces macOS boundaries and explicitly rejects unsupported platforms',async t=>{
 if(process.platform!=='darwin'){
  await assert.rejects(verifyRuntimePackage({appDirectory:appDir,dataCopy:path.join(tmpdir(),'unsupported-preflight.json'),port}),
   {code:'RUNTIME_PREFLIGHT_REQUIRES_MACOS_SANDBOX'});
  return;
 }
 const root=await fs.mkdtemp(path.join(tmpdir(),'runtime-preflight-api-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const output=path.join(root,'runtime-copy'),homeDirectory=path.join(root,'owner-home');
 const dataCopy=path.join(root,'input.json'),plistFile=path.join(homeDirectory,'Library/LaunchAgents/com.shuaizhang.selection-review-app.plist');
 await fs.mkdir(path.dirname(plistFile),{recursive:true});
 const document={meta:{version:2,automationStarted:false},rules:{},candidates:[],dispatches:[],evidencePacks:[],runtime:{softwareJobs:[]}};
 const bytes=Buffer.from(JSON.stringify(document));await fs.writeFile(dataCopy,bytes);
 const environment={SELECTION_REVIEW_DATA_FILE:path.join(root,'unused-live.json'),SELECTION_REVIEW_PORT:String(port),
  SELECTION_REVIEW_STORE_BINDINGS_JSON:'[]',SELECTION_REVIEW_IDENTITY_PROVIDER:'local_owner_password',
  SELECTION_REVIEW_CODEX_DISPATCH:'off',SELECTION_REVIEW_AUTO_DELIVER:'off',
  SELECTION_REVIEW_AI_GATEWAY_URL:`http://127.0.0.1:${gatewayPort}`,
  SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL:`http://127.0.0.1:${gatewayPort}`};
 const writePlist=()=>fs.writeFile(plistFile,JSON.stringify({EnvironmentVariables:environment}));
 const workflowMap=path.join(root,'synthetic-workflow-map.json');await fs.writeFile(workflowMap,'{}');
 environment.SELECTION_REVIEW_WORKFLOW_MAP_FILE=workflowMap;
 const tariffFile=path.join(root,'synthetic-tariff-2026.8.19.xlsx');
 await fs.writeFile(tariffFile,'synthetic filename boundary; no tariff calculation is requested');
 environment.SELECTION_REVIEW_GUOO_TARIFF_FILE=tariffFile;
 await writePlist();
 await prepareRuntimePackage({sourceDirectory:appDir,outputDirectory:output,nodeExecutable:process.execPath});

 const sandboxRoot=path.join(root,'sandbox-write'),protectedFile=path.join(root,'protected-synthetic-value');
 await fs.mkdir(sandboxRoot);await fs.writeFile(protectedFile,'synthetic value, never an actual credential');
 const profile=createLocalProcessSandboxProfile({writableRoot:sandboxRoot,
  readOnlyDirectories:[output,path.dirname(process.execPath)],ports:[port]})+'\n(deny process-fork)';
 const probe=`
 import fs from 'node:fs/promises';import {spawn} from 'node:child_process';
 const denied=error=>['EPERM','EACCES'].includes(error.code);
 let networkDenied=false,fileDenied=false,forkDenied=false;
 try{await fetch(process.argv[2],{signal:AbortSignal.timeout(2000)});}catch(error){if(!denied(error.cause))throw error;networkDenied=true;}
 try{await fs.readFile(process.argv[1]);}catch(error){if(!denied(error))throw error;fileDenied=true;}
 await new Promise((resolve,reject)=>{
  const rejected=error=>{if(!denied(error)){reject(error);return;}forkDenied=true;resolve();};
  let child;try{child=spawn('/bin/echo',['synthetic fork probe']);}catch(error){rejected(error);return;}
  child.once('error',rejected);child.once('exit',()=>resolve());});
 console.log(JSON.stringify({networkDenied,fileDenied,forkDenied}));`;
 const observed=JSON.parse(execFileSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'--input-type=module','-e',probe,
  protectedFile,`http://127.0.0.1:${gatewayPort}`],{cwd:sandboxRoot,encoding:'utf8',timeout:6000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}));
 assert.deepEqual(observed,{networkDenied:true,fileDenied:true,forkDenied:true});
 const receipt=await verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory});
 assert.equal(receipt.startupVerified,true);assert.equal(receipt.healthStatus,200);assert.equal(receipt.readinessFresh,true);
 assert.equal(receipt.osSandboxed,true);assert.equal(receipt.externalNetworkAllowed,false);assert.equal(receipt.credentialAccessAllowed,false);
 assert.equal(receipt.installed,false);assert.equal(receipt.activated,false);assert.deepEqual(await fs.readFile(dataCopy),bytes);

 const liveFile=path.join(homeDirectory,'Library/Application Support/今日选品评审台/data/candidates.json');
 await fs.mkdir(path.dirname(liveFile),{recursive:true});await fs.link(dataCopy,liveFile);
 await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_COPY_REQUIRED'});
 await fs.unlink(liveFile);
 const configuredLive=environment.SELECTION_REVIEW_DATA_FILE;
 await fs.link(dataCopy,configuredLive);
 await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_COPY_REQUIRED'});
 await fs.unlink(configuredLive);
 environment.SELECTION_REVIEW_DATA_FILE=dataCopy;await writePlist();
 await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_COPY_REQUIRED'});
 environment.SELECTION_REVIEW_DATA_FILE=configuredLive;await writePlist();
 const active=structuredClone(document);active.runtime.softwareJobs=[{status:'claimed'}];await fs.writeFile(dataCopy,JSON.stringify(active));
 await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_REQUIRES_QUIESCENT_COPY'});
 await fs.writeFile(dataCopy,bytes);
 environment.SELECTION_REVIEW_STORE_BINDINGS_JSON='{invalid';await writePlist();
 await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_STARTUP_FAILED'});
 assert.deepEqual(await fs.readFile(dataCopy),bytes);

 // A protocol-only process probe makes shutdown long enough to deliver a late interrupt.
 // This does not replace the actual packaged server health assertion above.
 environment.SELECTION_REVIEW_STORE_BINDINGS_JSON='[]';await writePlist();
 const serverFile=path.join(output,'server.mjs'),originalServer=await fs.readFile(serverFile);
 const writeShutdownProbe=emitDiagnostic=>fs.writeFile(serverFile,`import http from 'node:http';
 const server=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');
 response.end(JSON.stringify(request.url==='/api/live'?{live:true}:{ok:true,ready:true,readiness:{fresh:true}}));});
 server.listen(Number(process.env.SELECTION_REVIEW_PORT),'127.0.0.1',()=>console.log(process.env.SELECTION_REVIEW_PUBLIC_ORIGIN));
 process.once('SIGTERM',()=>setTimeout(()=>{${emitDiagnostic ? "process.stderr.write('synthetic unexpected shutdown diagnostic');" : ''}
 server.close(()=>process.exit(0));},250));`);
 await writeShutdownProbe(false);
 const actualFetch=globalThis.fetch;let interruptTimer,healthObserved=false;
 globalThis.fetch=async(...args)=>{
  const response=await actualFetch(...args);
  if(String(args[0]).endsWith('/api/health')){healthObserved=true;interruptTimer=setTimeout(()=>process.emit('SIGINT'),20);}
  return response;
 };
 try{
  await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_INTERRUPTED'});
  assert.equal(healthObserved,true);assert.deepEqual(await fs.readFile(dataCopy),bytes);
 }finally{clearTimeout(interruptTimer);globalThis.fetch=actualFetch;await fs.writeFile(serverFile,originalServer);}
 try{
  await writeShutdownProbe(true);
  await assert.rejects(verifyRuntimePackage({appDirectory:output,dataCopy,port,homeDirectory}),{code:'RUNTIME_PREFLIGHT_SERVICE_DIAGNOSTIC'});
  assert.deepEqual(await fs.readFile(dataCopy),bytes);
 }finally{await fs.writeFile(serverFile,originalServer);}
});
