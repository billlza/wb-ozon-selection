import assert from 'node:assert/strict';
import { savedDProductionJobFixture } from './d-production-saved-job-fixture.mjs';
import { runPersistedDExecution } from '../../lib/d-e-software-integration.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../../lib/ozon-seller-api-de-adapter.mjs';
import { createDPlatformObservationRuntime } from '../../lib/d-platform-observation-use-case.mjs';
/** Real asynchronous adapter and persisted job flow using explicit synthetic HTTP responses only. */
const clone=value=>structuredClone(value);
const policy = at => ({schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:task',version:'version:1',
 maxQueries:4,intervalMs:10,requestTimeoutMs:1000,expiresAt:new Date(Date.parse(at)+60000).toISOString()});
// warehouseStock：库存写入**之前**平台仓库里的数量。
// 默认 0——空仓才是「软件去写库存」的前提；等于授权值（100）表示主人已经自己填过，
// 那一档走登记不写（d-e-runtime-services.mjs 的三岔判定）。
export async function createDPlatformObservationRuntimeFixture({maxQueries=4,responses=['pending'],prerequisitePolicy=null,beforeResponse=null,initialAdapterFactory=null,responseFor=null,warehouseStock=0}={}) {
 const d=await savedDProductionJobFixture(),rules={...policy(d.input.serverClock()),maxQueries};
 const outcome=await runPersistedDExecution({...d.input,platformObservationPolicy:rules,createAdapter:initialAdapterFactory ? initialAdapterFactory(d) : d.createAdapter()});
 assert.equal(outcome.status,'waiting_platform');assert.deepEqual(d.calls,['/v3/product/import']);
 const calls=[],caps=clone(d.input.adapterCapabilities);if(prerequisitePolicy)caps.inventoryWrite.prerequisitePolicy=clone(prerequisitePolicy === 'configured' ? d.input.adapterCapabilities.inventoryWrite.prerequisitePolicy : prerequisitePolicy);else delete caps.inventoryWrite.prerequisitePolicy;
 const merchantSku=(await d.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.attempt.request.merchantSku;
 let index=0,ready=0;
 const createRuntime=(onPrerequisitesObserved=()=>{ready++;})=>createDPlatformObservationRuntime({repository:d.repository,jobStore:d.jobStore,serverClock:d.input.serverClock,
  resolveExecution:()=>({worker:d.worker,leaseDurationMs:60000,createAdapter:()=>createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:caps,
   requestJson:async(request,options)=>{await options.beforeRequestSend();calls.push(request.endpoint);
    if(beforeResponse)await beforeResponse({request,advance:d.advance,repository:d.repository});
    const status=responses[Math.min(index++,responses.length-1)];
    const defaultResponse=(()=>{
    if(request.endpoint==='/v1/product/import/info')return {result:{items:[{offer_id:merchantSku,
     product_id:status==='pending'?0:910001,status,errors:[]}]}};
    if(request.endpoint==='/v3/product/info/list')return {items:[{offer_id:merchantSku,id:910001,is_archived:false,is_autoarchived:false,statuses:{status:caps.inventoryWrite.prerequisitePolicy.priceSent.acceptedValues[0]},errors:[]}]};
    if(request.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return {products:[{offer_id:merchantSku,product_id:910001,sku:1910001,
      warehouse_id:Number(d.currentProductionBinding.warehouseId),free_stock:warehouseStock,present:warehouseStock,reserved:0}],has_next:false,cursor:''};
    throw new Error('Unexpected synthetic observation endpoint');
    })();
    return responseFor ? responseFor({request,defaultResponse,options,d,merchantSku,caps,status}) : defaultResponse;
   }})}),onPrerequisitesObserved});
 const job=()=>d.repository.readSnapshot().then(doc=>doc.runtime.softwareJobs.find(value=>value.jobType==='e_d_platform_observation'&&value.status==='queued'));
 return {d,rules,calls,caps,createRuntime,job,ready:()=>ready};
}

/**
 * 按 lib/d-e-runtime-services.mjs:160 里 prepare() 真正落盘的那份形状，
 * 给 D 作业补一份准备证据：持有者是**导入那一轮**的 worker/lease。
 *
 * 为什么必须补：d-e-software-job-results.mjs:186 是
 * `if (job.preparationEvidence !== undefined)`，fixture 不造这个字段，
 * 里面第 187 行那道断言就整段跳过——闸在测试里等于不存在。
 *
 * 时间必须锚在本轮尝试开始之前，否则撞三道合同：
 *   preflight.checkedAt === evidence.startedAt        （PREFLIGHT_SOURCE_CONFLICT）
 *   startedAt <= preparedAt <= completedAt            （PREPARED_SOURCE_CONFLICT）
 *   evidence.completedAt <= state.attempt.startedAt    （PREPARATION_SOURCE_CONFLICT）
 */
export async function attachDPreparationEvidence(d) {
  const { createDProductionPreparationIntent, completeDProductionPreparation } =
    await import('../../lib/d-production-preparation-contract.mjs');
  const { prepareSingleSkuDExecution } = await import('../../lib/d-e-software-closure.mjs');
  const { inspectAdapterCapabilities, OZON_DE_READBACK_ENDPOINTS } =
    await import('../../lib/ozon-seller-api-de-adapter.mjs');
  const input = d.input, caps = input.adapterCapabilities;
  const dJobOf = document => document.runtime.softwareJobs.find(entry => entry.jobId === d.job.jobId);
  const started = await d.repository.readSnapshot().then(document =>
    document.candidates.find(entry => entry.id === d.candidate.id)
      .lifecycleV11.skuPackage.dSoftwareExecution.attempt.startedAt);
  const inspected = inspectAdapterCapabilities({ ...caps, inspectedAt: input.platformWritePreflight.checkedAt,
    storeIdentity: { status: 'verified', expectedStore: caps.store, observedStore: caps.store,
      observedStoreRef: caps.storeRef, credentialAlias: caps.credentialAlias, evidenceRef: 'evidence:synthetic:store' },
    productImport: { ...caps.productImport, endpoint: '/v3/product/import',
      statusEndpoint: '/v1/product/import/info', protocolVersion: 'ozon-product-import-v3' },
    assetTransport: { ...caps.assetTransport, mode: 'preapproved_stable_https',
      protocolVersion: 'approved-https-assets-v1' },
    independentReadback: { ...caps.independentReadback, protocolVersion: 'ozon-independent-readback-v2',
      endpoints: OZON_DE_READBACK_ENDPOINTS } });
  const prepared = prepareSingleSkuDExecution({ ...input, adapterCapabilities: inspected,
    productionAuthorization: input.productionPlan.sourceAuthorization, preparedAt: started });
  const intent = createDProductionPreparationIntent({ job: d.job, candidateRevision: d.candidate.dataRevision,
    productionPlan: input.productionPlan, startedAt: input.platformWritePreflight.checkedAt,
    requestMode: 'persisted_evidence_only' });
  const evidence = completeDProductionPreparation({ evidence: intent,
    platformWritePreflight: input.platformWritePreflight, adapterCapabilities: inspected,
    preparedExecution: prepared, completedAt: started });
  await d.repository.transact(document => {
    dJobOf(document).preparationEvidence = clone(evidence);
    return { changed: true, document, result: null };
  });
  return evidence;
}
