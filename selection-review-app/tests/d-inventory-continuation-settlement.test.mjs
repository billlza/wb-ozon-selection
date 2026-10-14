import assert from "node:assert/strict";
import test from "node:test";
import { runPersistedDRemainingInventory } from "../lib/d-e-software-integration.mjs";
import { createStoreIsolatedOzonSellerApiDEAdapter, inspectAdapterCapabilities,
  OZON_DE_READBACK_ENDPOINTS } from "../lib/ozon-seller-api-de-adapter.mjs";
import { createDProductionPreparationIntent, completeDProductionPreparation } from "../lib/d-production-preparation-contract.mjs";
import { prepareSingleSkuDExecution } from "../lib/d-e-software-closure.mjs";
import { settleDProductionJobInDocument } from "../lib/d-e-software-job-handoff.mjs";
import { createDPlatformObservationRuntimeFixture } from "./fixtures/d-platform-observation-runtime-fixture.mjs";
import { assertDRemainingInventoryContinuation, assertDRemainingInventorySend } from "../lib/d-platform-observation-contract.mjs";
import { exactObservation } from "./helpers/d-software-fixture.mjs";

// 库存续写会重新领取、铸出新租约；准备证据仍记着导入那次的租约。
// 三个既有 fixture 都不带 preparationEvidence，于是 d-e-software-job-results.mjs:186
// 那层 `if (job.preparationEvidence !== undefined)` 把断言整段跳过——闸在测试里等于不存在。
// 这里按真实作业的形状把证据补上，让它真的被执行到。
const dJob = (document, f) => document.runtime.softwareJobs.find(job => job.jobId === f.job.jobId);

async function inventoryReady() {
  const f = await createDPlatformObservationRuntimeFixture({ responses: ["imported"], prerequisitePolicy: "configured" });
  for (let index = 0; index < 3; index += 1) {
    f.lastObservation = await f.job();
    await f.createRuntime().runJob({ jobId: f.lastObservation.jobId });
    f.d.advance(11);
  }
  return f;
}

/** 按真实作业的形状造一份准备证据并挂到 D 作业上，持有者是导入那一轮的 worker/lease。 */
async function attachPreparationEvidence(f) {
  const input = f.d.input, caps = input.adapterCapabilities;
  // 真实顺序是「前检完成 → 本轮尝试开始」，合同据此要求
  // evidence.completedAt <= state.attempt.startedAt（PREPARATION_SOURCE_CONFLICT），
  // 且 capabilities.inspectedAt <= completedAt。所以三个时间都要锚在尝试开始之前。
  const started = await f.d.repository.readSnapshot().then(document =>
    document.candidates.find(entry => entry.id === f.d.candidate.id).lifecycleV11.skuPackage.dSoftwareExecution.attempt.startedAt);
  const inspected = inspectAdapterCapabilities({ ...caps, inspectedAt: input.platformWritePreflight.checkedAt,
    storeIdentity: { status: "verified", expectedStore: caps.store, observedStore: caps.store,
      observedStoreRef: caps.storeRef, credentialAlias: caps.credentialAlias, evidenceRef: "evidence:synthetic:store" },
    productImport: { ...caps.productImport, endpoint: "/v3/product/import", statusEndpoint: "/v1/product/import/info",
      protocolVersion: "ozon-product-import-v3" },
    assetTransport: { ...caps.assetTransport, mode: "preapproved_stable_https", protocolVersion: "approved-https-assets-v1" },
    independentReadback: { ...caps.independentReadback, protocolVersion: "ozon-independent-readback-v2",
      endpoints: OZON_DE_READBACK_ENDPOINTS } });
  const prepared = prepareSingleSkuDExecution({ ...input, adapterCapabilities: inspected,
    // preparedAt 必须落在 [startedAt, completedAt] 区间内（PREPARED_SOURCE_CONFLICT）
    productionAuthorization: input.productionPlan.sourceAuthorization, preparedAt: started });
  // 合同要求 preflight.checkedAt === evidence.startedAt（PREFLIGHT_SOURCE_CONFLICT），
  // 观察轮次已经推过时钟，所以起点必须锚在前检自己的时间上，不能用当前时钟。
  const intent = createDProductionPreparationIntent({ job: f.d.job, candidateRevision: f.d.candidate.dataRevision,
    productionPlan: input.productionPlan, startedAt: input.platformWritePreflight.checkedAt,
    requestMode: "persisted_evidence_only" });
  const evidence = completeDProductionPreparation({ evidence: intent, platformWritePreflight: input.platformWritePreflight,
    adapterCapabilities: inspected, preparedExecution: prepared, completedAt: started });
  await f.d.repository.transact(document => {
    dJob(document, f.d).preparationEvidence = structuredClone(evidence);
    return { changed: true, document, result: null };
  });
  return evidence;
}

async function continueInventory(f, { readback = exactObservation, leaseId = "lease:d-inventory:settlement" } = {}) {
  const d = f.d, before = await d.repository.readSnapshot(), job = dJob(before, d), verify = () => true;
  const source = assertDRemainingInventoryContinuation({ document: before, job, observationJobId: f.lastObservation.jobId,
    checkedAt: d.input.serverClock(), verifyInventoryPrerequisiteSource: verify });
  await d.jobStore.claimDRemainingInventory({ jobId: job.jobId, worker: d.worker, leaseId, leaseDurationMs: 60000,
    observationJobId: f.lastObservation.jobId, verifyInventoryPrerequisiteSource: verify });
  const stockCalls = [];
  const result = await runPersistedDRemainingInventory({ repository: d.repository, candidateId: d.candidate.id,
    serverClock: d.input.serverClock, currentProductionBinding: d.currentProductionBinding,
    observation: source.prerequisites,
    softwareJobContext: { jobStore: d.jobStore, jobId: job.jobId, workerId: d.worker.workerId, leaseId },
    assertRemainingInventoryAuthorization: async () => {
      const document = await d.repository.readSnapshot();
      assertDRemainingInventorySend({ document, job: dJob(document, d), observationJobId: f.lastObservation.jobId,
        checkedAt: d.input.serverClock(), workerId: d.worker.workerId, leaseId, verifyInventoryPrerequisiteSource: verify });
    },
    createAdapter: ({ executionContext, request }) => {
      const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ executionContext, adapterCapabilities: f.caps,
        requestJson: async (call, options) => {
          await options.beforeRequestSend();
          stockCalls.push({ endpoint: call.endpoint, body: structuredClone(call.body) });
          return { result: [{ offer_id: request.merchantSku, product_id: 910001,
            warehouse_id: Number(request.inventoryWrite.warehouseId), updated: true, errors: [] }] };
        } });
      return { ...adapter, readbackSellerApi: async query => readback(request, query) };
    } });
  return { result, stockCalls, leaseId };
}

test("a) 库存写成功整条：只发一次库存写，仓库、数量、货号逐项对得上，回执与生产记录落盘", async () => {
  const f = await inventoryReady();
  const evidence = await attachPreparationEvidence(f);
  const { result, stockCalls } = await continueInventory(f);

  assert.equal(result.status, "succeeded");
  // 只有一次平台写入，且就是库存那一次
  assert.equal(stockCalls.length, 1);
  assert.equal(stockCalls[0].endpoint, "/v2/products/stocks");
  const row = stockCalls[0].body.stocks[0];
  const binding = f.d.currentProductionBinding;
  assert.equal(row.warehouse_id, Number(binding.warehouseId));
  assert.equal(row.stock, 100);

  const document = await f.d.repository.readSnapshot();
  const sku = document.candidates.find(entry => entry.id === f.d.candidate.id).lifecycleV11.skuPackage;
  const state = sku.dSoftwareExecution;
  assert.equal(row.offer_id, state.attempt.request.merchantSku);
  assert.equal(state.status, "succeeded");
  assert.equal(state.step, "independent_readback_observed");
  assert.equal(state.platformContinuation.inventoryWriteState, "succeeded");
  assert.equal(state.platformWrites, 2);
  // 生产记录必须绑定本轮真实回执，不是回读倒填
  assert.ok(sku.productionRecord);
  assert.equal(sku.productionRecord.stockWritten, 100);
  assert.equal(sku.productionRecord.inventoryModified, true);
  assert.ok(sku.productionRecord.inventoryReceiptRef);
  assert.equal(sku.productionRecord.independentReadbackVerified, true);
  // 作业终态
  const job = dJob(document, f.d);
  assert.equal(job.status, "completed");
  assert.equal(job.externalRequestState, "succeeded");
  assert.equal(job.failureClass, null);
  // 准备证据一个字节没动
  assert.deepEqual(job.preparationEvidence, evidence);
});

test("b) 续写后失败档：回读价对不上时落成 unknown_outcome，原因可读，不再卡在 waiting_platform", async () => {
  const f = await inventoryReady();
  const evidence = await attachPreparationEvidence(f);
  // 平台回读价与授权价不一致——很可能真实发生
  const { result } = await continueInventory(f, {
    readback: request => ({ ...exactObservation(request), currentPrice: { amount: 99, currency: "CNY" } })
  });

  assert.equal(result.status, "unknown_outcome");
  const document = await f.d.repository.readSnapshot();
  const sku = document.candidates.find(entry => entry.id === f.d.candidate.id).lifecycleV11.skuPackage;
  const state = sku.dSoftwareExecution;
  // 失败本身必须落了盘：分类在、原因可读
  assert.equal(state.status, "unknown_outcome");
  assert.match(state.attempt.reason, /currentPrice/);
  // 回读对不上不得生成生产记录
  assert.equal(sku.productionRecord, null);
  // 库存那一笔确实写成功了，这个事实不能丢
  assert.equal(state.platformContinuation.inventoryWriteState, "succeeded");
  const job = dJob(document, f.d);
  assert.notEqual(job.status, "waiting_platform");
  assert.equal(job.status, "unknown_outcome");
  assert.equal(job.failureClass, "d-production-outcome-unknown");
  assert.deepEqual(job.preparationEvidence, evidence);
});

test("c) 不在案的租约结算仍被拒：放开的只是历史持有者，不是当前持有者", async () => {
  const f = await inventoryReady();
  await attachPreparationEvidence(f);
  const { leaseId } = await continueInventory(f);
  const document = await f.d.repository.readSnapshot();
  const job = dJob(document, f.d);
  assert.notEqual(job.leaseId, "lease:d-inventory:forged");
  await assert.rejects(() => f.d.repository.transact(current => {
    settleDProductionJobInDocument({ document: current, candidate: current.candidates.find(entry => entry.id === f.d.candidate.id),
      jobId: job.jobId, workerId: f.d.worker.workerId, leaseId: "lease:d-inventory:forged",
      observedAt: f.d.input.serverClock() });
    return { changed: true, document: current, result: null };
  }), /LEASE_REJECTED|SETTLEMENT_REJECTED|SOURCE_CONFLICT|JOB_INVALID/);
  assert.equal(leaseId, "lease:d-inventory:settlement");
});

test("d) preparationId 与冻结字段全程逐字节不变", async () => {
  const f = await inventoryReady();
  const evidence = await attachPreparationEvidence(f);
  const before = structuredClone(evidence);
  await continueInventory(f);
  const document = await f.d.repository.readSnapshot();
  const saved = dJob(document, f.d).preparationEvidence;
  assert.equal(saved.preparationId, before.preparationId);
  // 持有者仍是导入那一轮的，没有被续写的新租约改写
  assert.equal(saved.workerId, before.workerId);
  assert.equal(saved.leaseId, before.leaseId);
  assert.deepEqual(saved, before);
  // 续写确实换了租约——否则这组用例证明不了任何东西
  assert.notEqual(dJob(document, f.d).leaseId, before.leaseId);
});
