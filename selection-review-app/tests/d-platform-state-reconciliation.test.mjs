import test from 'node:test';
import assert from 'node:assert/strict';
import { createDPlatformObservationRuntimeFixture } from './fixtures/d-platform-observation-runtime-fixture.mjs';
import { createDEProductionRuntimeServices } from '../lib/d-e-runtime-services.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { buildDESavedJobRuntimeView } from '../lib/d-e-runtime-view.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createDPlatformStateReconciliationUseCase, DPlatformStateReconciliationError } from '../lib/d-platform-state-reconciliation-use-case.mjs';
import { dESavedJobRuntimeDisplay } from '../src/dESoftwareRuntimeView.js';

// 「按平台现状收口」：导入被平台接受、商品号已给出，但导入任务上挂了真错误，停在 unknown_outcome；
// 之后导入任务过期读不到，「按新分类重新观察一次」只会再停一次。
// 收口不再读导入任务，改读商品现状（价格那次）和仓库库存，两次都是只读；
// 库存只认等于授权锁定值 → 登记成主人填写，读到 0 也不由软件写。

const IMPORT_ERROR = { code: 'E1', message: '合成真错误', state: 'imported', level: 'ERROR_LEVEL_ERROR',
  field: 'attributes', attribute_id: 23171, attribute_name: 'Хештеги' };

async function stoppedFixture({ warehouseStock = 100, priceStatus = null } = {}) {
  const f = await createDPlatformObservationRuntimeFixture({ responses: ['imported'], prerequisitePolicy: 'configured', warehouseStock,
    responseFor: ({ request, defaultResponse, merchantSku }) => {
      if (request.endpoint === '/v1/product/import/info') {
        return { result: { items: [{ offer_id: merchantSku, product_id: 910001, status: 'imported', errors: [IMPORT_ERROR] }] } };
      }
      if (request.endpoint === '/v3/product/info/list' && priceStatus) {
        return { items: [{ ...defaultResponse.items[0], statuses: { status: priceStatus } }] };
      }
      return defaultResponse;
    } });
  await f.createRuntime(() => {}).runJob({ jobId: (await f.job()).jobId });
  const document = await f.d.repository.readSnapshot();
  const state = document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status, 'unknown_outcome');
  assert.equal(state.platformContinuation.observationHistory.at(-1).result.gapCode, 'import_task_errors_present');
  return f;
}

const owner = f => createActorContext({ userId: 'local-owner:synthetic', sessionId: 'synthetic-owner-session', actorType: 'human',
  roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: f.d.input.serverClock() });

function useCase(f) {
  return createDPlatformStateReconciliationUseCase({ repository: f.d.repository, serverClock: f.d.input.serverClock,
    loadDPlatformObservationPolicy: () => structuredClone(f.rules), jobStore: f.d.jobStore });
}

async function viewOf(f) {
  const document = await f.d.repository.readSnapshot(), candidate = document.candidates[0];
  const settled = candidate.lifecycleV11.skuPackage.dSoftwareExecution.settledAt;
  return buildDESavedJobRuntimeView({ candidate, runtime: document.runtime, serviceBindings: [],
    productionBindings: [f.d.currentProductionBinding], dependencyView: {},
    observedAt: new Date(Date.parse(settled ?? f.d.input.serverClock()) + 1000).toISOString() });
}

async function reconcile(f) {
  const view = await viewOf(f);
  assert.equal(view.canReconcileFromPlatformState, true, JSON.stringify(view.platformStateReconciliationBlocker));
  return useCase(f).reconcile({ actor: owner(f),
    input: { candidateId: f.d.candidate.id, confirmPlatformStateMatchesThisRound: true, ...view.platformStateReconciliation } });
}

// 收口排出的两次只读查询（价格、库存），按策略间隔跑完。
async function runReads(f) {
  const observations = f.createRuntime(() => {});
  for (let index = 0; index < 2; index += 1) {
    const queued = await f.job();
    if (!queued) break;
    f.d.advance(11);
    await observations.runJob({ jobId: queued.jobId });
  }
  const document = await f.d.repository.readSnapshot(), job = document.runtime.softwareJobs[0];
  return { sourceDJobId: job.jobId, observationJobId: job.platformContinuation?.observationHistory.at(-1).jobId };
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
    // 收口一个写请求都不许发：真发了这里就会计数。
    requestJson: () => { requests += 1; throw new Error('Unexpected inventory request'); },
    verifyInventoryPrerequisiteSource: async () => ({ assertCurrent: () => true }) });
  return { runtime, requests: () => requests };
}

test('库存等于授权值：不再读导入任务，只读商品现状和库存，登记成主人填写并收口', async () => {
  const f = await stoppedFixture({ warehouseStock: 100 });
  const result = await reconcile(f);
  assert.equal(result.externalRequests, 0);
  assert.equal(result.platformWrites, 0);
  assert.equal(result.archive.productId, '910001');
  assert.equal(result.archive.inventoryWrite, 'owner_registration_only');

  const queued = await f.job();
  assert.equal(queued.scopeBinding.queryKind, 'price_state');
  const ids = await runReads(f);
  const service = services(f);
  const outcome = await service.runtime.resumeInventory(ids);
  assert.equal(outcome.status, 'completed');
  assert.equal(service.requests(), 0);
  // 导入任务只在停下之前读过那一次；收口只读了商品现状和库存。
  assert.deepEqual(f.calls, ['/v1/product/import/info', '/v3/product/info/list', '/v2/product/info/stocks-by-warehouse/fbs']);

  const document = await f.d.repository.readSnapshot();
  const sku = document.candidates[0].lifecycleV11.skuPackage, state = sku.dSoftwareExecution, job = document.runtime.softwareJobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.resultEnvelope.payload.stockSource, 'owner_manual');
  assert.equal(job.resultEnvelope.payload.inventoryWriteState, 'not_sent');
  assert.equal(state.platformContinuation.status, 'owner_stock_registered');
  assert.equal(state.platformWrites, 1);
  assert.equal(sku.productionRecord, null);
  // 「导入结果已观察」这一格来自价格那次只读查询：同一商品号、0 错误，指向那次查询的回执。
  const checkpoint = state.checkpoints.at(-1);
  const price = state.platformContinuation.observationHistory.find(entry => entry.queryKind === 'price_state');
  assert.deepEqual([checkpoint.kind, checkpoint.productId, checkpoint.status, checkpoint.errorCount, checkpoint.itemCount],
    ['import_result_observed', '910001', 'imported', 0, 1]);
  assert.equal(checkpoint.requestReceiptRef, price.result.requestReceiptRef);
  assert.equal(document.runtime.softwareJobs.filter(entry => entry.jobType === 'e_independent_readback').length, 0);

  const view = await viewOf(f);
  assert.equal(view.canReconcileFromPlatformState, false);
  assert.equal(view.canReobserveUnknownOutcome, false);
  assert.deepEqual(view.d.blockers.map(item => item.code), ['D_OWNER_STOCK_PRODUCT_CREATED', 'D_OWNER_STOCK_WRITTEN_BY_OWNER', 'D_OWNER_STOCK_E_MANUAL']);
});

test('收口之后库存读到 0：停下报主人，不由软件写库存', async () => {
  const f = await stoppedFixture({ warehouseStock: 0 });
  await reconcile(f);
  const ids = await runReads(f);
  const service = services(f);
  const outcome = await service.runtime.resumeInventory(ids);
  assert.equal(outcome.status, 'failed');
  assert.equal(service.requests(), 0);
  assert.equal(f.calls.includes('/v2/products/stocks'), false);
  const document = await f.d.repository.readSnapshot();
  const state = document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.attempt.failure.code, 'inventory_stock_mismatch');
  assert.equal(state.platformContinuation.inventoryWriteState, 'not_sent');
});

test('商品现状核实不了：照旧停在结果未知，可以再收口，同一个导入任务最多三次', async () => {
  const f = await stoppedFixture({ priceStatus: 'moderating' });
  await reconcile(f);
  await runReads(f);
  let document = await f.d.repository.readSnapshot();
  let state = document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status, 'unknown_outcome');
  assert.equal(state.platformContinuation.inventoryWriteState, 'not_sent');
  assert.deepEqual(f.calls, ['/v1/product/import/info', '/v3/product/info/list']);

  const view = await viewOf(f);
  assert.equal(view.canReconcileFromPlatformState, true);
  assert.equal(view.platformStateReconciliationAttemptsLeft, 2);
  // 第二次收口也只读；预算（合成策略 4 次）在这里用完，界面说清楚为什么不能再点。
  await reconcile(f);
  await runReads(f);
  document = await f.d.repository.readSnapshot();
  state = document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status, 'unknown_outcome');
  assert.equal(document.candidates[0].lifecycleV11.dPlatformStateReconciliationV1.length, 2);
  const after = await viewOf(f);
  assert.equal(after.canReconcileFromPlatformState, false);
  assert.equal(after.platformStateReconciliationBlocker.code, 'QUERY_BUDGET_EXHAUSTED');
  assert.equal(f.calls.filter(endpoint => endpoint === '/v2/products/stocks').length, 0);
});

test('收口只认主人、准确的任务号和商品号，查询进行中不重复排', async () => {
  const f = await stoppedFixture();
  const view = await viewOf(f), input = { candidateId: f.d.candidate.id, confirmPlatformStateMatchesThisRound: true,
    ...view.platformStateReconciliation };
  const software = createActorContext({ userId: 'software:synthetic', sessionId: 'software-session', actorType: 'software', roles: ['operator'],
    source: 'authenticated_identity_provider', authenticatedAt: f.d.input.serverClock() });
  await assert.rejects(() => useCase(f).reconcile({ actor: software, input }));
  await assert.rejects(() => useCase(f).reconcile({ actor: owner(f), input: { ...input, productId: '910002' } }),
    error => error instanceof DPlatformStateReconciliationError && error.code === 'TASK_MISMATCH');
  await assert.rejects(() => useCase(f).reconcile({ actor: owner(f), input: { ...input, confirmPlatformStateMatchesThisRound: false } }),
    error => error.code === 'INPUT_INVALID');
  await useCase(f).reconcile({ actor: owner(f), input });
  await assert.rejects(() => useCase(f).reconcile({ actor: owner(f), input: { ...input, expectedRevision: input.expectedRevision } }),
    error => ['ALREADY_RECONCILING', 'CANDIDATE_CHANGED'].includes(error.code));
  const document = await f.d.repository.readSnapshot();
  assert.equal(document.candidates[0].lifecycleV11.dPlatformStateReconciliationV1.length, 1);
  assert.equal(document.runtime.softwareJobs.filter(entry => entry.jobType === 'e_d_platform_observation' && entry.status === 'queued').length, 1);
});

test('卡片按视图给的四项提交，界面不自己拼', async () => {
  const f = await stoppedFixture();
  const display = dESavedJobRuntimeDisplay(await viewOf(f));
  assert.equal(display.canReconcileFromPlatformState, true);
  assert.deepEqual(Object.keys(display.platformStateReconciliation).sort(), ['expectedRevision', 'productId', 'sourceDJobId', 'taskId']);
  assert.equal(display.platformStateReconciliation.productId, '910001');
  assert.equal(display.platformStateReconciliationAttemptsLeft, 3);
});
