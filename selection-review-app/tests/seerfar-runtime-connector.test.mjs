import assert from "node:assert/strict";
import test from "node:test";

import {
  SEERFAR_KEYCHAIN_ACCOUNT,
  SEERFAR_KEYCHAIN_SERVICE,
  createSeerfarFetchTransport,
  inspectSeerfarKeychainEntry,
  inspectSeerfarRuntimeConfiguration,
  readSeerfarKeychainSecret
} from "../lib/seerfar-runtime-connector.mjs";

test("执行器读取固定钥匙串秘密，状态检查只验证条目存在且不读取秘密", async () => {
  let seen;
  const secret = await readSeerfarKeychainSecret({ platform: "darwin", execFileImpl: async (...args) => { seen = args; return { stdout: "test-secret\n" }; } });
  assert.equal(secret, "test-secret");
  assert.equal(seen[0], "/usr/bin/security");
  assert.deepEqual(seen[1], ["find-generic-password", "-w", "-s", SEERFAR_KEYCHAIN_SERVICE, "-a", SEERFAR_KEYCHAIN_ACCOUNT]);
  let inspectionArgs;
  const entryExists = await inspectSeerfarKeychainEntry({ platform: "darwin", execFileImpl: async (...args) => { inspectionArgs = args; return { stdout: "metadata only" }; } });
  assert.equal(entryExists, true);
  assert.equal(inspectionArgs[0], "/usr/bin/security");
  assert.deepEqual(inspectionArgs[1], ["find-generic-password", "-s", SEERFAR_KEYCHAIN_SERVICE, "-a", SEERFAR_KEYCHAIN_ACCOUNT]);
  assert.equal(inspectionArgs[1].includes("-w"), false);
  const status = await inspectSeerfarRuntimeConfiguration({ keychainEntryReader: async () => true, platform: "darwin" });
  assert.equal(status.credentialLocation, "macos_keychain");
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes("test-secret"), false);
  assert.equal(status.secretExposed, false);
});

test("钥匙串确定缺项与拒绝分开，未知异常不能伪装未配置", async () => {
  await assert.rejects(()=>readSeerfarKeychainSecret({platform:"darwin",execFileImpl:async()=>{throw Object.assign(new Error('sensitive stderr'),{code:44});}}),error=>error.code==='credential_missing'&&!error.message.includes('sensitive'));
  assert.equal(await inspectSeerfarKeychainEntry({platform:"darwin",execFileImpl:async()=>{throw {code:44};}}),false);
  await assert.rejects(()=>inspectSeerfarKeychainEntry({platform:"darwin",execFileImpl:async()=>{throw {code:51};}}),error=>error.code==='credential_access_denied');
  const failure=new Error('implementation defect');
  await assert.rejects(()=>readSeerfarKeychainSecret({platform:"darwin",execFileImpl:async()=>{throw failure;}}),error=>error===failure);
  await assert.rejects(()=>inspectSeerfarRuntimeConfiguration({keychainEntryReader:async()=>{throw failure;}}),error=>error===failure);
});

test("HTTP运行时只允许固定Seerfar白名单且不跟随重定向", async () => {
  const calls = [];
  const transport = createSeerfarFetchTransport({
    now: () => "2026-08-24T10:00:00.000Z",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { status: 200, headers: { get: () => "request-safe-1" }, text: async () => JSON.stringify({ code: 200, data: {} }) };
    }
  });
  const result = await transport({ url: "https://api.seerfar.cn/open-api/quota", method: "GET", headers: { Authorization: "Bearer test-only" }, body: null, redirect: "error", attempt: 1 });
  assert.equal(result.requestId, "request-safe-1");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(JSON.stringify(result).includes("test-only"), false);
  await assert.rejects(() => transport({ url: "https://evil.test/open-api/quota", method: "GET", redirect: "error", attempt: 1 }), /ENDPOINT_REJECTED/);
});

test("超时和非法JSON保留精确失败层且不返回请求秘密", async () => {
  const timeout = createSeerfarFetchTransport({ timeoutMs: 1, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("secret"), { name: "AbortError" })))) });
  await assert.rejects(() => timeout({ url: "https://api.seerfar.cn/open-api/quota", method: "GET", headers: { Authorization: "Bearer hidden" }, redirect: "error", attempt: 1 }), (error) => error.code === "network_timeout" && !error.message.includes("hidden"));
  const invalid = createSeerfarFetchTransport({ fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => "not-json" }) });
  await assert.rejects(() => invalid({ url: "https://api.seerfar.cn/open-api/quota", method: "GET", headers: {}, redirect: "error", attempt: 1 }), (error) => error.code === "schema_error");
});

test('发送门失败零fetch，未知fetch和body异常原样传播，body超时仍受deadline限制',async()=>{
 const request={url:'https://api.seerfar.cn/open-api/quota',method:'GET',headers:{},redirect:'error',attempt:1,step:'quota_before'};
 const failure=new TypeError('synthetic defect');let sends=0;
 await assert.rejects(()=>createSeerfarFetchTransport({beforeRequestSend:async()=>{throw failure;},fetchImpl:async()=>{sends++;}})(request),e=>e===failure);assert.equal(sends,0);
 await assert.rejects(()=>createSeerfarFetchTransport({fetchImpl:async()=>{throw failure;}})(request),e=>e===failure);
 await assert.rejects(()=>createSeerfarFetchTransport({fetchImpl:async()=>({status:200,headers:{get:()=>null},text:async()=>{throw failure;}})})(request),e=>e===failure);
 await assert.rejects(()=>createSeerfarFetchTransport({timeoutMs:5,fetchImpl:async()=>({status:200,headers:{get:()=>null},text:async()=>new Promise(()=>{})})})(request),e=>e.code==='network_timeout');
});

test('每作业独立三HTTP预算，发送门位于密钥和间隔后且取消不发送',async()=>{
 const {createSeerfarRuntimeTransport}=await import('../lib/seerfar-runtime-connector.mjs');
 let at=0;const events=[];
 const request={attemptLimit:1,targetPlatform:'ozon',seerfarRequest:{operation:'reverse_keywords',platform:'ozon',skuIds:['123'],attemptId:'attempt:1',queryId:'query:1',startedAt:'2026-09-08T00:00:00Z'}};
 const options={clock:{now:()=>at},sleep:async ms=>{events.push(`wait:${ms}`);at+=ms;},secretReader:async()=>{events.push('secret');return 'fake';},beforeRequestSend:async({stage})=>events.push(stage),fetchImpl:async url=>{events.push('fetch');return {status:200,headers:{get:()=>null},text:async()=>JSON.stringify({code:200,data:String(url).endsWith('quota')?{remaining:100}:{records:[]}})};}};
 for(let i=0;i<2;i++){const transport=createSeerfarRuntimeTransport(options);await transport(request);await assert.rejects(()=>transport(request),/ATTEMPT_LIMIT/);}
 assert.deepEqual(events,Array(2).fill(['secret','quota_before','fetch','wait:3000','target','fetch','wait:3000','quota_after','fetch']).flat());
 const controller=new AbortController();let calls=0;
 const cancelled=createSeerfarRuntimeTransport({...options,signal:controller.signal,beforeRequestSend:async()=>controller.abort(),fetchImpl:async()=>{calls++;}});
 await assert.rejects(()=>cancelled(request),e=>e===controller.signal.reason);assert.equal(calls,0);
});
