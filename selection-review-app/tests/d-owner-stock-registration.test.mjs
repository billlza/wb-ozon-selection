import test from 'node:test';
import assert from 'node:assert/strict';
import { createDPlatformObservationRuntimeFixture } from './fixtures/d-platform-observation-runtime-fixture.mjs';
import { createDEProductionRuntimeServices } from '../lib/d-e-runtime-services.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { buildDESavedJobRuntimeView } from '../lib/d-e-runtime-view.mjs';
import { productionAuthorizationRollbackEligible } from '../lib/production-authorization-rollback.mjs';

// 主人 2026-09-24 决定：库存他自己在卖家后台填。
// 库存续写（d-e-runtime-services.mjs resumeInventory）因此按顺序做两件判断：
//   1) 回读 === 授权锁定值 → 只登记，不发任何库存写请求、不生成 productionRecord、不排 E；
//      回读是其他任何数     → 停下报主人（inventory_stock_mismatch），不覆盖、不重写。
//   2) 再看冻结的执行请求还能不能按当前代码重建；重建不一致就停
//      （inventory_request_superseded），因为照常写入必然在中途撞 SCOPE_MISMATCH。
//      重建一致的新品照常走软件写入——这条路没有被砍。
// 不生成 productionRecord 是有依据的：AGENTS 10.2 要求它必须绑定本轮**真实执行回执**，
// 库存不是软件写的就没有库存写入回执，倒填一个等于拿回读冒充写入。

async function readyFixture(warehouseStock) {
  const f = await createDPlatformObservationRuntimeFixture({ responses: ['imported'], prerequisitePolicy: 'configured', warehouseStock });
  const observations = f.createRuntime(() => {});
  for (let index = 0; index < 3; index += 1) {
    await observations.runJob({ jobId: (await f.job()).jobId });
    f.d.advance(11);
  }
  const document = await f.d.repository.readSnapshot(), job = document.runtime.softwareJobs[0];
  return { ...f, sourceDJobId: job.jobId, observationJobId: job.platformContinuation.observationHistory.at(-1).jobId };
}

function services(f) {
  let requests = 0;
  const runtime = createDEProductionRuntimeServices({ repository: f.d.repository, runtimeMode: f.d.input.runtimeMode,
    serverClock: f.d.input.serverClock, workerRegistry: createLocalDevelopmentWorkerRegistry({ clock: f.d.input.serverClock }),
    productionBindings: [f.d.currentProductionBinding],
    deServiceBindings: [{ schemaVersion: 'd-e-service-binding-v1', serviceId: 'service:synthetic:saved-d', configurationVersion: 'service-config:1',
      productionBindingId: f.d.currentProductionBinding.bindingId, productionConfigurationVersion: f.d.currentProductionBinding.configurationVersion,
      workerId: f.d.worker.workerId, workerVersion: f.d.worker.version, leaseDurationMs: 60000 }],
    inspectPlatform: () => { throw new Error('Unexpected new preflight'); }, loadAdapterCapabilities: () => f.caps,
    upload: () => { throw new Error('Unexpected asset upload'); }, resolveLocalAsset: () => { throw new Error('Unexpected asset resolution'); },
    // 登记档一个字节都不许发出去：真发了这里就会把计数加起来。
    requestJson: () => { requests += 1; throw new Error('Unexpected inventory request'); },
    verifyInventoryPrerequisiteSource: async () => ({ assertCurrent: () => true }) });
  return { runtime, requests: () => requests };
}

const skuOf = document => document.candidates[0].lifecycleV11.skuPackage;

test('主人已填到授权值：只登记，不发库存请求、不生成生产记录、不排 E', async () => {
  const f = await readyFixture(100), service = services(f);
  const result = await service.runtime.resumeInventory(f);

  assert.equal(result.status, 'completed');
  assert.equal(service.requests(), 0);

  const document = await f.d.repository.readSnapshot();
  const sku = skuOf(document), state = sku.dSoftwareExecution, job = document.runtime.softwareJobs[0];
  assert.equal(state.status, 'succeeded');
  assert.equal(state.platformContinuation.status, 'owner_stock_registered');
  assert.equal(state.platformContinuation.inventoryWriteState, 'not_sent');
  assert.equal(state.platformWrites, 1);
  assert.deepEqual(state.checkpoints.map(event => event.kind),
    ['import_intent', 'import_task_received', 'import_result_observed']);
  // 这一档的要害：没有生产记录、没有 E 作业。
  assert.equal(sku.productionRecord, null);
  assert.equal(state.attempt.productionRecord, null);
  assert.equal(document.runtime.softwareJobs.filter(entry => entry.jobType === 'e_independent_readback').length, 0);

  assert.equal(job.status, 'completed');
  assert.equal(job.externalRequestState, 'succeeded');
  assert.equal(job.failureClass, null);
  const payload = job.resultEnvelope.payload;
  assert.equal(payload.schemaVersion, 'd-owner-stock-registered-job-result-v1');
  assert.equal(payload.stockSource, 'owner_manual');
  assert.equal(payload.inventoryWriteState, 'not_sent');
  assert.equal(payload.inventoryReceiptRef, null);
  assert.equal(payload.productionRecordCreated, false);
  assert.equal(payload.eReadbackQueued, false);

  const registration = document.candidates[0].lifecycleV11.dOwnerStockRegistrationV1.at(-1);
  assert.equal(registration.stockSource, 'owner_manual');
  assert.equal(registration.observedStock, 100);
  assert.equal(registration.authorizedStock, 100);
  assert.equal(registration.taskId, state.platformContinuation.taskId);
  assert.equal(registration.productId, state.platformContinuation.productId);
  assert.ok(registration.registeredByActorId);
  assert.ok(registration.observationFingerprint);
});

test('平台库存既不是 0 也不等于授权值：停下报主人，不覆盖也不重写', async () => {
  const f = await readyFixture(500), service = services(f);
  const result = await service.runtime.resumeInventory(f);

  assert.equal(result.status, 'failed');
  assert.equal(service.requests(), 0);
  const document = await f.d.repository.readSnapshot();
  const sku = skuOf(document), state = sku.dSoftwareExecution;
  assert.equal(state.attempt.failure.code, 'inventory_stock_mismatch');
  assert.equal(state.platformContinuation.inventoryWriteState, 'not_sent');
  assert.equal(sku.productionRecord, null);
  assert.equal(document.candidates[0].lifecycleV11.dOwnerStockRegistrationV1, undefined);

  // 页面必须说清楚该做什么。原先这一档落进笼统的「缺少已核实的后续执行前提」，
  // 主人看不出该做什么，甚至可能去重签授权——重签等于第二次导入、会建出重复商品。
  const observedAt = new Date(Date.parse(state.settledAt) + 1000).toISOString();
  const view = buildDESavedJobRuntimeView({ candidate: document.candidates[0], runtime: document.runtime,
    serviceBindings: [], productionBindings: [f.d.currentProductionBinding], dependencyView: {}, observedAt });
  const shown = view.d.blockers.map(item => item.message).join('\n');
  assert.match(shown, /不会覆盖它/u);
  assert.match(shown, /不要重签授权/u);
  assert.match(shown, /不要重新导入/u);
  assert.doesNotMatch(shown, /需重新签授权/u);
});

test('同一个导入任务只登记一次', async () => {
  const f = await readyFixture(100), service = services(f);
  assert.equal((await service.runtime.resumeInventory(f)).status, 'completed');
  const before = await f.d.repository.readSnapshot();
  assert.equal(before.candidates[0].lifecycleV11.dOwnerStockRegistrationV1.length, 1);

  await assert.rejects(() => f.d.jobStore.registerOwnerWrittenInventory({ jobId: f.sourceDJobId,
    observationJobId: f.observationJobId, verifyInventoryPrerequisiteSource: () => true,
    actorId: 'local-owner:synthetic' }));

  const after = await f.d.repository.readSnapshot();
  assert.equal(after.candidates[0].lifecycleV11.dOwnerStockRegistrationV1.length, 1);
  assert.equal(service.requests(), 0);
});

test('登记之后：三句分开显示，继续/再派一轮/作废三个按钮都不亮', async () => {
  const f = await readyFixture(100), service = services(f);
  await service.runtime.resumeInventory(f);
  const document = await f.d.repository.readSnapshot();
  const candidate = document.candidates[0];
  // 观察按 intervalMs 推过时钟，settledAt 会晚于真实 now；观察时刻必须在结算之后。
  const observedAt = new Date(Date.parse(candidate.lifecycleV11.skuPackage.dSoftwareExecution.settledAt) + 1000).toISOString();
  const view = buildDESavedJobRuntimeView({ candidate, runtime: document.runtime,
    serviceBindings: [], productionBindings: [f.d.currentProductionBinding], dependencyView: {}, observedAt });
  const d = view.d;

  assert.equal(d.receiptStatus, 'owner_stock_registered');
  assert.equal(d.businessStatus, 'owner_stock_registered');
  // 三个按钮
  assert.equal(d.canContinueSaved, false);
  assert.equal(d.newRound.canDispatch, false);
  assert.equal(productionAuthorizationRollbackEligible({ document, candidate, observedAt })?.eligible ?? false, false);
  // 三句必须各自独立，不许合并成「已上架」
  const codes = d.blockers.map(item => item.code);
  assert.deepEqual(codes, ['D_OWNER_STOCK_PRODUCT_CREATED', 'D_OWNER_STOCK_WRITTEN_BY_OWNER', 'D_OWNER_STOCK_E_MANUAL']);
  assert.match(d.blockers[0].message, /商品由软件创建/u);
  assert.match(d.blockers[1].message, /库存由主人手工写入/u);
  assert.match(d.blockers[1].message, /软件未发送任何库存请求/u);
  assert.match(d.blockers[2].message, /由主人人工核对/u);
  assert.equal(d.blockers.some(item => /已上架/u.test(item.message)), false);
});

// 背心的真实处境：它的 D 执行请求是在 r69 改 23171 标签格式**之前**冻结的，
// 所以冻结的那份是旧格式（一条、无 #、内部带空格）。若照常走软件写入，
// 必然在执行中途撞 D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH——等于给主人一条注定失败的路。
//
// 拦的依据是「冻结请求还能不能按当前代码重建」，**不是**「库存是不是 0」。
// 按库存数拦会把新授权品的软件写库存一起砍掉（resumeInventory 是
// onPrerequisitesObserved 的回调，所有品写库存都经过它）。
// 讲解会话 2026-09-24 一度指示按库存数两岔，核对后收回。
//
// 「新品、冻结请求一致、回读 0 → 照常软件写入」这一档由
// tests/d-remaining-inventory-admission.test.mjs 那 7 条兜住：它们驱动同一个
// resumeInventory 并走到 claim 之后，全绿即证明这条路没被砍。删那 7 条前要先补这一层。
test('冻结的执行请求无法按当前代码重建时，必须被判成 SCOPE_MISMATCH', async () => {
  const { assertCurrentDExecutionContext } = await import('../lib/platform-write-preflight.mjs');
  const f = await readyFixture(0);
  const document = await f.d.repository.readSnapshot();
  const state = skuOf(document).dSoftwareExecution;
  const { decodeAttempt } = await import('../lib/d-execution-request-codec.mjs');
  const request = decodeAttempt(state.attempt).request;
  const executionContext = { productionPlan: state.productionPlan,
    currentProductionBinding: f.d.currentProductionBinding, serverClock: f.d.input.serverClock };

  // 冻结请求与当前计划一致时必须通过——这就是新授权品照常写库存的前提。
  assert.doesNotThrow(() => assertCurrentDExecutionContext({ request, executionContext }));

  // 只要重建出来的导入请求与冻结的那份不一致，就必须判 SCOPE_MISMATCH。
  // 背心正是这种情形：它的请求在 r69 改 23171 标签格式**之前**就冻结了。
  const stale = structuredClone(request);
  const tag = stale.productImport.body.items[0].attributes.find(entry => entry.id === 23171);
  assert.ok(tag, '冻结请求里应当有 23171 主题标签属性');
  tag.values[0].value = tag.values[0].value.replaceAll('#', '').replaceAll('_', ' ');
  assert.throws(() => assertCurrentDExecutionContext({ request: stale, executionContext }),
    /D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH/u);
});

// resumeInventory 捕获上面那个错误、转成 inventory_request_superseded 并**零请求**停下，
// 已在正式数据副本上真跑验证（背心当前状态、仓库回读 0）：
//   作业 failed ｜ 失败原因 inventory_request_superseded ｜ 库存 not_sent ｜ 生产记录 null
//   发出的调用只有三次只读，没有 /v2/products/stocks
// 这里不再用合成数据复制那一档：冻结请求的 executionKey 是由请求内容推出来的
// （d-executable-request-contract.mjs:23），改动请求内容就会先撞「执行输入已变化」，
// 造不出「请求没变、但重建结果变了」这个真实情形。改动计划则会被实体归一化挡住。
// 失败分类本身的白名单由下面这条钉住。
test('inventory_request_superseded 是被允许的停止分类，且不会被当成未知错误', async () => {
  const { rejectDRemainingInventoryInDocument } = await import('../lib/d-platform-observation-contract.mjs');
  assert.throws(() => rejectDRemainingInventoryInDocument({ document: { candidates: [] },
    job: { candidateId: 'candidate:missing' }, observationJobId: 'x', observedAt: new Date().toISOString(),
    failureClass: 'not_an_allowed_class' }), /REJECTION_INVALID/u);
  // 允许的三类不会在白名单这一步被拒（后续来源校验另行失败，不是 REJECTION_INVALID）
  for (const allowed of ['inventory_stock_mismatch', 'inventory_request_superseded', 'context_changed']) {
    assert.throws(() => rejectDRemainingInventoryInDocument({ document: { candidates: [] },
      job: { candidateId: 'candidate:missing' }, observationJobId: 'x', observedAt: new Date().toISOString(),
      failureClass: allowed }), error => !/REJECTION_INVALID/u.test(String(error.message)));
  }
});
