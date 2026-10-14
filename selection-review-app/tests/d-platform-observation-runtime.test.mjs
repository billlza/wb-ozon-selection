import { createDPlatformObservationRuntimeFixture as waitingFixture } from './fixtures/d-platform-observation-runtime-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPersistedDRemainingInventory } from '../lib/d-e-software-integration.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../lib/ozon-seller-api-de-adapter.mjs';
import { createDPlatformObservationRuntime } from '../lib/d-platform-observation-use-case.mjs';
import { assertDPlatformObservationScope, createDPlatformObservationScope, assertDRemainingInventoryContinuation, assertDRemainingInventorySend,
 readDPlatformObservationJobTerminal } from '../lib/d-platform-observation-contract.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
const clone=value=>structuredClone(value);
test('accepted import and first bounded observation job are atomic; pending survives reconstruction without replaying import',async()=>{
 const f=await waitingFixture();let document=await f.d.repository.readSnapshot();
 assert.equal(document.runtime.softwareJobs[0].externalRequestState,'succeeded');
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
 const first=await f.job();assert.equal(first.scopeBinding.queryIndex,1);assertDPlatformObservationScope(first.scopeBinding);
 const runtime=f.createRuntime();await runtime.runJob({jobId:first.jobId});
 document=await f.d.repository.readSnapshot();assert.equal(document.runtime.softwareJobs.find(j=>j.jobId===first.jobId).status,'completed');
 const second=await f.job();assert.equal(second.scopeBinding.queryIndex,2);assert.notEqual(second.jobId,first.jobId);
 await f.createRuntime().runJob({jobId:first.jobId});assert.equal(f.calls.length,1);
 assert.equal((await f.createRuntime().runDue()).status,'idle');assert.equal(f.calls.length,1);
 f.d.advance(11);await f.createRuntime().runDue();assert.equal(f.calls.length,2);assert.equal(f.d.calls.length,1);
 const validator=await loadPublishedSchemaValidator();const valid=validator.getSchema('d-software-execution-state-v2');
 assert.equal(valid((await f.d.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.dSoftwareExecution),true,JSON.stringify(valid.errors));
});
test('pending budget exhausts explicitly; failed and skipped never schedule another read or stock write',async()=>{
 for(const status of ['pending','failed','skipped']) {
  const f=await waitingFixture({maxQueries:1,responses:[status]});await f.createRuntime().runJob({jobId:(await f.job()).jobId});
  const doc=await f.d.repository.readSnapshot(),c=doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation;
  assert.equal(c.status,status==='pending'?'query_budget_exhausted':`platform_${status}`);assert.equal(await f.job(),undefined);
  assert.equal(c.inventoryWriteState,'not_sent');assert.equal(f.d.calls.length,1);assert.equal(f.calls.length,1);assert.equal(f.ready(),0);
 }
});
test('imported does not prove price_sent; absent formal prerequisite policy stops before any price or stock request',async()=>{
 const f=await waitingFixture({responses:['imported']});await f.createRuntime().runJob({jobId:(await f.job()).jobId});
 f.d.advance(11);const next=await f.job();assert.equal(next.scopeBinding.queryKind,'price_state');await f.createRuntime().runJob({jobId:next.jobId});
 const doc=await f.d.repository.readSnapshot(),state=doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 assert.equal(state.platformContinuation.status,'blocked');assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(f.calls.length,1);assert.equal(f.ready(),0);assert.equal(await f.job(),undefined);
 assert.throws(()=>assertDRemainingInventoryContinuation({document:doc,job:doc.runtime.softwareJobs[0],observationJobId:next.jobId,
  checkedAt:f.d.input.serverClock(),verifyInventoryPrerequisiteSource:()=>true}),/SOURCE_JOB_INVALID/);
});
test('outdated inventory policy is a durable known block without a request, maintenance case or replay',async()=>{
 const f=await waitingFixture({responses:['imported'],prerequisitePolicy:'configured'});
 f.caps.inventoryWrite.prerequisitePolicy.stockRequest.quantSize=1;
 await f.createRuntime().runJob({jobId:(await f.job()).jobId});
 f.d.advance(11);const job=await f.job();assert.equal(job.scopeBinding.queryKind,'price_state');
 const result=await f.createRuntime().runJob({jobId:job.jobId});assert.equal(result.disposition,'blocked');
 const document=await f.d.repository.readSnapshot(),candidate=document.candidates[0],state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
 const saved=document.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(saved.status,'failed');assert.equal(saved.externalRequestState,'not_sent');
 assert.deepEqual(state.platformContinuation.observationHistory.at(-1).result,
  {schemaVersion:'d-platform-observation-failure-v1',status:'blocked',failureClass:'inventory_policy_outdated',requestSent:false});
 assert.equal(state.platformContinuation.status,'blocked');assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(state.checkpoints.some(value=>value.kind==='stock_intent'),false);
 assert.notEqual(candidate.executionRuntime?.exceptionCase?.status,'open');
 assert.equal(readDPlatformObservationJobTerminal({document,job:saved,observedAt:f.d.input.serverClock()}).disposition,'blocked');
 const validator=await loadPublishedSchemaValidator(),valid=validator.getSchema('d-software-execution-state-v2');
 assert.equal(valid(state),true,JSON.stringify(valid.errors));
 assert.equal((await f.createRuntime().runJob({jobId:job.jobId})).status,'idempotent_replay');
 assert.equal(await f.job(),undefined);assert.equal(f.ready(),0);
 assert.deepEqual(f.d.calls,['/v3/product/import']);assert.deepEqual(f.calls,['/v1/product/import/info']);
});
test('a policy error after request transmission cannot masquerade as a known unsent stop',async()=>{
 const failure=new Error('OZON_DE_INVENTORY_POLICY_OUTDATED');
 const f=await waitingFixture({beforeResponse:()=>{throw failure;}}),job=await f.job();
 await assert.rejects(()=>f.createRuntime().runJob({jobId:job.jobId}),error=>error===failure);
 const document=await f.d.repository.readSnapshot(),saved=document.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(saved.status,'unknown_outcome');assert.equal(saved.externalRequestState,'unknown_outcome');
 assert.equal(document.candidates[0].executionRuntime.exceptionCase.status,'open');
 assert.equal((await f.createRuntime().runJob({jobId:job.jobId})).status,'idempotent_replay');
 assert.deepEqual(f.calls,['/v1/product/import/info']);assert.equal(await f.job(),undefined);
});
test('changed revision or source D failure blocks a queued observation before providers',async()=>{
 for(const drift of ['revision','failed','unknown_outcome']) {
  const f=await waitingFixture(),job=await f.job();
  await f.d.repository.transact(document=>{if(drift==='revision')document.candidates[0].dataRevision++;else document.runtime.softwareJobs[0].status=drift;
   return {changed:true,document};});
  if(drift==='revision'){await f.createRuntime().runJob({jobId:job.jobId});
   const saved=await f.d.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs.find(value=>value.jobId===job.jobId).status,'failed');
   assert.equal(saved.runtime.softwareJobs.find(value=>value.jobId===job.jobId).externalRequestState,'not_sent');
  }else await assert.rejects(()=>f.createRuntime().runJob({jobId:job.jobId}),/SOURCE/);
  assert.equal(f.calls.length,0);assert.equal(f.d.calls.length,1);
 }
});
test('old unknown D records cannot acquire an observation scope or become a current execution',async()=>{
 const f=await waitingFixture(),doc=await f.d.repository.readSnapshot();doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.schemaVersion='d-software-execution-state-v1';
 assert.throws(()=>createDPlatformObservationScope({document:doc,candidate:doc.candidates[0],sourceDJob:doc.runtime.softwareJobs[0],
  policy:f.rules,queryIndex:1,nextEligibleAt:f.d.input.serverClock(),observedAt:f.d.input.serverClock()}),/SOURCE_CONFLICT/);
 assert.equal(f.d.calls.length,1);
});

test('only saved same-source price and warehouse observations authorize the original unsent inventory once',async()=>{
 const f=await waitingFixture({responses:['imported'],prerequisitePolicy:'configured'});let last;
 for(let index=0;index<3;index++){last=await f.job();await f.createRuntime().runJob({jobId:last.jobId});f.d.advance(11);}
 assert.equal(f.ready(),1);assert.equal(f.calls.length,3);assert.equal(f.d.calls.length,1);
 const before=await f.d.repository.readSnapshot(),job=before.runtime.softwareJobs[0],verify=()=>true;
 const source=assertDRemainingInventoryContinuation({document:before,job,observationJobId:last.jobId,checkedAt:f.d.input.serverClock(),verifyInventoryPrerequisiteSource:verify});
 const corrupted=clone(before),priceJob=corrupted.runtime.softwareJobs.find(value=>value.scopeBinding?.queryKind==='price_state');
 priceJob.resultEnvelope.payload.observationFingerprint='0'.repeat(64);
 assert.throws(()=>assertDRemainingInventoryContinuation({document:corrupted,job:corrupted.runtime.softwareJobs[0],observationJobId:last.jobId,
  checkedAt:f.d.input.serverClock(),verifyInventoryPrerequisiteSource:verify}),/PREREQUISITE_ENVELOPE_CONFLICT/);
 // Reconstruct the pump after observations are committed but before the continuation callback runs.
 const recoveredRuntime=f.createRuntime(async pending=>{
 assert.deepEqual(pending,{sourceDJobId:job.jobId,observationJobId:last.jobId});
 const leaseId='lease:synthetic:remaining';
 const claims=await Promise.allSettled([1,2].map(()=>f.d.jobStore.claimDRemainingInventory({jobId:job.jobId,worker:f.d.worker,leaseId,
  leaseDurationMs:60000,observationJobId:last.jobId,verifyInventoryPrerequisiteSource:verify})));
 assert.equal(claims.filter(value=>value.status==='fulfilled').length,1,claims.map(value=>value.reason?.stack ?? value.status).join('\n'));assert.equal(claims.filter(value=>value.status==='rejected').length,1);
 let writes=0,guards=0;const context={jobStore:f.d.jobStore,jobId:job.jobId,workerId:f.d.worker.workerId,leaseId};
 const assertRemainingInventoryAuthorization=async()=>{const document=await f.d.repository.readSnapshot();
  assertDRemainingInventorySend({document,job:document.runtime.softwareJobs[0],observationJobId:last.jobId,checkedAt:f.d.input.serverClock(),
    workerId:f.d.worker.workerId,leaseId,verifyInventoryPrerequisiteSource:verify});guards++;};
 const result=await runPersistedDRemainingInventory({repository:f.d.repository,candidateId:f.d.candidate.id,softwareJobContext:context,
  serverClock:f.d.input.serverClock,currentProductionBinding:f.d.currentProductionBinding,observation:source.prerequisites,assertRemainingInventoryAuthorization,
  createAdapter:({executionContext,request})=>{
   const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:f.caps,executionContext,requestJson:async(call,options)=>{
    assert.equal(call.endpoint,'/v2/products/stocks');await options.beforeRequestSend();writes++;
    return {result:[{offer_id:request.merchantSku,product_id:910001,warehouse_id:Number(request.inventoryWrite.warehouseId),updated:true,errors:[]}]};
   }});
   // This test isolates D continuation persistence. Independent seller status remains unproved.
   return {...adapter,readbackSellerApi:async()=>({platform:'ozon',store:request.store,storeRef:request.storeRef,warehouseRef:request.warehouseRef,
    credentialAlias:request.credentialAlias,skuPackageId:request.skuPackageId,supplierSkuId:request.supplierSkuId,merchantSku:request.merchantSku,
    platformProductId:'910001',currentPrice:request.platformWritePrice,currentStock:'unknown',imageCount:'unknown',moderationStatus:'unknown',
    validationStatus:'unknown',saleStatus:'unknown',errors:[],platformEvidenceRef:'evidence:synthetic:unproved'})};
  }});
 assert.equal(result.status,'unknown_outcome');assert.equal(writes,1);assert.equal(guards,2);assert.equal(f.d.calls.length,1);
 const final=await f.d.repository.readSnapshot();assert.equal(final.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
 assert.equal(final.runtime.softwareJobs[0].attempt,1);
 await assert.rejects(()=>f.d.jobStore.claimDRemainingInventory({jobId:job.jobId,worker:f.d.worker,leaseId:'lease:another',leaseDurationMs:60000,
  observationJobId:last.jobId,verifyInventoryPrerequisiteSource:verify}),/CONTINUATION_JOB_INVALID/);assert.equal(writes,1);
 return {status:'continued_once'};
 });
 assert.deepEqual(await recoveredRuntime.runDue(),{status:'continued_once'});
 assert.deepEqual(await recoveredRuntime.runDue(),{status:'idle'});
});

test('warehouse observation arriving after policy expiry preserves evidence but cannot resume inventory',async()=>{
 const f=await waitingFixture({responses:['imported'],prerequisitePolicy:'configured',beforeResponse:({request,advance})=>{
  if(request.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')advance(59980);
 }});
 for(let index=0;index<3;index++){const job=await f.job();await f.createRuntime().runJob({jobId:job.jobId});if(index<2)f.d.advance(11);}
 const document=await f.d.repository.readSnapshot(),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 assert.equal(state.platformContinuation.observationHistory.length,3);
 assert.equal(state.platformContinuation.observationHistory.at(-1).result.reservedObservation,'observed');
 assert.equal(state.platformContinuation.status,'unknown_outcome');assert.equal(state.continuationBlocked,true);
 assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');assert.equal(f.ready(),0);
 assert.equal(await f.job(),undefined);assert.equal(f.calls.length,3);assert.deepEqual(f.d.calls,['/v3/product/import']);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
});

test('unknown observation exceptions are persisted, rethrown, and never replayed',async()=>{
 const failure=new Error('synthetic internal observation failure');
 const f=await waitingFixture({beforeResponse:()=>{throw failure;}}),job=await f.job();
 await assert.rejects(()=>f.createRuntime().runJob({jobId:job.jobId}),error=>error===failure);
 const document=await f.d.repository.readSnapshot(),saved=document.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(saved.status,'unknown_outcome');assert.equal(saved.externalRequestState,'unknown_outcome');
 assert.equal(document.candidates[0].executionRuntime.exceptionCase.softwareJobId,job.jobId);
 assert.equal(document.candidates[0].executionRuntime.exceptionCase.automaticRetryAllowed,false);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation.inventoryWriteState,'not_sent');
 await f.createRuntime().runJob({jobId:job.jobId});assert.equal(f.calls.length,1);assert.equal(await f.job(),undefined);
});

test('empty observation queue performs no candidate read, adapter construction, or external request',async()=>{
 let listed=0;
 const runtime=createDPlatformObservationRuntime({repository:{readSnapshot(){throw new Error('unexpected candidate read');}},
  jobStore:{async listDPlatformObservationJobs({limit}){assert.equal(limit,1);listed++;return [];},async listDRemainingInventoryJobs({limit}){assert.equal(limit,1);return [];}},
  serverClock:()=> '2026-09-08T00:00:00.000Z',resolveExecution(){throw new Error('unexpected provider construction');}});
 assert.deepEqual(await runtime.runDue(),{status:'idle'});assert.equal(listed,1);await runtime.stop();
});

test('expired queued observation is durably blocked before any provider call',async()=>{
 const f=await waitingFixture();const job=await f.job();f.d.advance(60001);
 await f.createRuntime().runDue();const document=await f.d.repository.readSnapshot();
 const saved=document.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(saved.status,'failed');assert.equal(saved.attempt,0);assert.equal(saved.externalRequestState,'not_sent');
 assert.equal(document.runtime.softwareJobs[0].status,'failed');
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation.status,'blocked');
 assert.equal(f.calls.length,0);assert.equal(await f.job(),undefined);
});

test('a sent observation survives current revision drift but cannot schedule or resume any write',async()=>{
 const f=await waitingFixture({beforeResponse:async({repository})=>{
  await repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
 }}),job=await f.job();await f.createRuntime().runJob({jobId:job.jobId});
 const document=await f.d.repository.readSnapshot(),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 const record=state.platformContinuation.observationHistory[0];assert.equal(record.sourceContextChanged,true);
 assert.equal(record.result.classification,'waiting_platform');assert.equal(state.platformContinuation.status,'unknown_outcome');
 assert.equal(state.continuationBlocked,true);assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(document.runtime.softwareJobs.find(value=>value.jobId===job.jobId).externalRequestState,'succeeded');
 assert.equal(document.runtime.softwareJobs[0].status,'unknown_outcome');assert.equal(f.calls.length,1);assert.equal(await f.job(),undefined);
});

// r70 ①：平台在导入任务上报错误时，**每一条都要落盘并摆给主人看**。
// 2026-09-24 背心停在 unknown_outcome，观察记录里只有 errorCount: 2，错误正文当场就丢了，
// 主人只能去卖家后台翻——「停下来却留不下能看懂的原因」正是这一轮要治的毛病。
// 字段名出自官方合同 v1ItemError（docs/contracts/ozon-de-20260908/official-de-structural-openapi.json）。
test('导入任务带错误时，错误明细逐条落盘并在视图逐条显示', async () => {
  const { buildDESavedJobRuntimeView } = await import('../lib/d-e-runtime-view.mjs');
  const platformErrors = [
    { code: 'ITEM_ATTRIBUTE_INVALID', message: 'Хештеги: формат неверный', state: 'imported',
      level: 'ERROR_LEVEL_WARNING', field: 'attributes', attribute_id: 23171, attribute_name: 'Хештеги' },
    { code: 'ITEM_IMAGE_WARN', message: 'Изображение низкого качества', state: 'imported',
      level: 'ERROR_LEVEL_WARNING', field: 'images', attribute_id: null, attribute_name: null }
  ];
  const f = await waitingFixture({ responses: ['imported'], responseFor: ({ request, defaultResponse, merchantSku }) =>
    request.endpoint === '/v1/product/import/info'
      ? { result: { items: [{ offer_id: merchantSku, product_id: 910001, status: 'imported', errors: platformErrors }] } }
      : defaultResponse });
  const queued = await f.job();
  await f.createRuntime().runJob({ jobId: queued.jobId });

  const document = await f.d.repository.readSnapshot();
  const candidate = document.candidates[0];
  const observed = candidate.lifecycleV11.skuPackage.dSoftwareExecution
    .platformContinuation.observationHistory.at(-1).result.importObservation;

  // 计数保留，明细也在
  assert.equal(observed.errorCount, 2);
  assert.equal(observed.errors.length, 2);
  // 逐字段按官方合同落盘（snake_case → camelCase）
  assert.deepEqual(observed.errors[0], { code: 'ITEM_ATTRIBUTE_INVALID', message: 'Хештеги: формат неверный',
    state: 'imported', level: 'ERROR_LEVEL_WARNING', field: 'attributes',
    attributeId: 23171, attributeName: 'Хештеги' });
  assert.equal(observed.errors[1].attributeId, null);
  assert.equal(observed.errors[1].attributeName, null);

  // 视图必须把每一条摆出来，主人不用再去后台翻
  const state = candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  const observedAt = new Date(Date.parse(state.settledAt ?? f.d.input.serverClock()) + 1000).toISOString();
  const view = buildDESavedJobRuntimeView({ candidate, runtime: document.runtime,
    serviceBindings: [], productionBindings: [f.d.currentProductionBinding], dependencyView: {}, observedAt });
  const shown = view.d.blockers.map(item => item.message).join('\n');
  assert.match(shown, /Хештеги: формат неверный/u);
  assert.match(shown, /Изображение низкого качества/u);
  assert.match(shown, /ERROR_LEVEL_WARNING/u);
  assert.match(shown, /23171|Хештеги/u);
});

// r70 ②：按级别分类。
// 级别枚举出自官方合同 ErrorErrorLevel，但它只绑在 /v3/product/info/list；
// import/info 的 v1ItemError.level 是裸 string，所以**只认 ERROR_LEVEL_WARNING，其余一律从严**。
// 最坏结果 = 2026-09-24 当天的行为（停下来留证），不会误放行。
async function observeWith(errors, status = 'imported') {
  const f = await waitingFixture({ responses: [status], responseFor: ({ request, defaultResponse, merchantSku }) =>
    request.endpoint === '/v1/product/import/info'
      ? { result: { items: [{ offer_id: merchantSku, product_id: status === 'imported' ? 910001 : 0, status, errors }] } }
      : defaultResponse });
  const queued = await f.job();
  await f.createRuntime().runJob({ jobId: queued.jobId });
  const document = await f.d.repository.readSnapshot();
  const entry = document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution
    .platformContinuation.observationHistory.at(-1);
  return { result: entry.result, document };
}
const warn = extra => ({ code: 'W', message: '警告文案', state: 'imported',
  level: 'ERROR_LEVEL_WARNING', field: 'attributes', attribute_id: 23171, attribute_name: 'Хештеги', ...extra });

test('② 全部为警告：按 imported 走，警告仍逐条落盘', async () => {
  const { result } = await observeWith([warn(), warn({ code: 'W2' })]);
  assert.equal(result.classification, 'imported');
  assert.equal(result.gapCode, null);
  assert.equal(result.importObservation.errorCount, 2);
  assert.equal(result.importObservation.errors.length, 2);
  assert.equal(result.importObservation.errors[0].level, 'ERROR_LEVEL_WARNING');
});

test('② 含一条 ERROR 级：维持 unknown_outcome', async () => {
  const { result } = await observeWith([warn(), warn({ code: 'E1', level: 'ERROR_LEVEL_ERROR' })]);
  assert.equal(result.classification, 'unknown_outcome');
  assert.equal(result.gapCode, 'import_task_errors_present');
  assert.equal(result.importObservation.errors.length, 2);
});

test('② 含一条不认识的级别串：从严，维持 unknown_outcome', async () => {
  for (const level of ['ERROR_LEVEL_INTERNAL', 'ERROR_LEVEL_UNSPECIFIED', 'SOMETHING_NEW', null]) {
    const { result } = await observeWith([warn({ code: 'X', level })]);
    assert.equal(result.classification, 'unknown_outcome', `level=${level} 应从严`);
    assert.equal(result.gapCode, 'import_task_errors_present');
  }
});

test('② status=failed：判 platform_failed，与错误级别无关', async () => {
  const { result } = await observeWith([warn()], 'failed');
  assert.equal(result.classification, 'platform_failed');
  assert.equal(result.importObservation.errors.length, 1);
});

test('② 落盘只含合同字段，不含原始响应整包', async () => {
  const { result, document } = await observeWith([warn({ message: 'Хештеги: формат неверный' })]);
  // 观察结果本身的键也必须是合同字段，不能多塞
  assert.deepEqual(Object.keys(result.importObservation).sort(),
    ['errorCount','errors','itemCount','kind','merchantSku','productId','requestReceiptRef','status','taskId']);
  // 只查观察结果本身：冻结的导入**请求体**本来就是 Ozon 格式（含 items/offer_id），
  // 那是合法的，不能拿整个状态去搜。这里要证的是「错误明细没有把原始响应原样塞进来」。
  const persisted = JSON.stringify(result.importObservation);
  for (const raw of ['attribute_id', 'attribute_name']) {
    assert.equal(persisted.includes(raw), false, `观察结果里不该出现原始响应键 ${raw}`);
  }
  // 明细条目的键集合就是合同字段，一个不多
  for (const entry of result.importObservation.errors) {
    assert.deepEqual(Object.keys(entry).sort(),
      ['attributeId','attributeName','code','field','level','message','state']);
  }
});

// r70 ③：「按新分类重新观察一次」的按钮闸。
// 四条缺一不可：停在 unknown_outcome、平台已给 product_id、策略有效、剩余预算盖得住。
// 提交的四项由视图给全，界面不自己拼。
test('③ 停在 unknown_outcome 且平台已给商品号时，重新观察按钮才亮，四项由视图给全', async () => {
  const { buildDESavedJobRuntimeView } = await import('../lib/d-e-runtime-view.mjs');
  const errors = [{ code: 'E1', message: '真错误', state: 'imported',
    level: 'ERROR_LEVEL_ERROR', field: 'attributes', attribute_id: 23171, attribute_name: 'Хештеги' }];
  const f = await waitingFixture({ responses: ['imported'], responseFor: ({ request, defaultResponse, merchantSku }) =>
    request.endpoint === '/v1/product/import/info'
      ? { result: { items: [{ offer_id: merchantSku, product_id: 910001, status: 'imported', errors }] } }
      : defaultResponse });
  await f.createRuntime().runJob({ jobId: (await f.job()).jobId });

  const document = await f.d.repository.readSnapshot();
  const candidate = document.candidates[0];
  const state = candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status, 'unknown_outcome');

  const observedAt = new Date(Date.parse(state.settledAt) + 1000).toISOString();
  const view = buildDESavedJobRuntimeView({ candidate, runtime: document.runtime,
    serviceBindings: [], productionBindings: [f.d.currentProductionBinding], dependencyView: {}, observedAt });

  assert.equal(view.canReobserveUnknownOutcome, true);
  assert.equal(view.reobservationBlocker, null);
  assert.deepEqual(Object.keys(view.unknownOutcomeReobservation).sort(),
    ['expectedRevision', 'productId', 'sourceDJobId', 'taskId']);
  assert.equal(view.unknownOutcomeReobservation.productId, '910001');
  assert.equal(view.unknownOutcomeReobservation.expectedRevision, candidate.dataRevision);
  // 其余按钮都不该亮
  assert.equal(view.canContinueSaved, false);
  assert.equal(view.canRecoverInitialImport, false);
  // 主人点之前就能看到停在什么上（r70 ① 的明细）
  const shown = view.d.blockers.map(item => item.message).join('\n');
  assert.match(shown, /真错误/u);
  assert.match(shown, /ERROR_LEVEL_ERROR/u);
});

test('③ 全是警告时不会停，也就不会出现重新观察按钮', async () => {
  const { buildDESavedJobRuntimeView } = await import('../lib/d-e-runtime-view.mjs');
  const errors = [{ code: 'W', message: '只是警告', state: 'imported',
    level: 'ERROR_LEVEL_WARNING', field: 'attributes', attribute_id: 23171, attribute_name: 'Хештеги' }];
  const f = await waitingFixture({ responses: ['imported'], responseFor: ({ request, defaultResponse, merchantSku }) =>
    request.endpoint === '/v1/product/import/info'
      ? { result: { items: [{ offer_id: merchantSku, product_id: 910001, status: 'imported', errors }] } }
      : defaultResponse });
  await f.createRuntime().runJob({ jobId: (await f.job()).jobId });
  const document = await f.d.repository.readSnapshot();
  const candidate = document.candidates[0];
  assert.notEqual(candidate.lifecycleV11.skuPackage.dSoftwareExecution.status, 'unknown_outcome');
  const view = buildDESavedJobRuntimeView({ candidate, runtime: document.runtime,
    serviceBindings: [], productionBindings: [f.d.currentProductionBinding], dependencyView: {},
    observedAt: f.d.input.serverClock() });
  assert.equal(view.canReobserveUnknownOutcome, false);
});
