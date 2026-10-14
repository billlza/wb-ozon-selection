import assert from "node:assert/strict";
import test from "node:test";
import { runPersistedDExecution, runPersistedDRemainingInventory } from "../lib/d-e-software-integration.mjs";
import { settleSoftwareJob, settleSoftwareJobInDocument } from "../lib/software-job-contract.mjs";
import { settleDProductionJobInDocument } from "../lib/d-e-software-job-handoff.mjs";
import { createStoreIsolatedOzonSellerApiDEAdapter } from "../lib/ozon-seller-api-de-adapter.mjs";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { D_READBACK_MISMATCH_CODES, formatDReadbackMismatchReason, isDProductionUnknownReason } from "../lib/production-execution-failure.mjs";

import { createDPlatformObservationRuntimeFixture as waitingFixture,
  attachDPreparationEvidence } from "./fixtures/d-platform-observation-runtime-fixture.mjs";
import { assertDRemainingInventoryContinuation, assertDRemainingInventorySend } from "../lib/d-platform-observation-contract.mjs";
import { exactObservation } from "./helpers/d-software-fixture.mjs";
import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";

// Exercise the real adapter in three separately persisted read jobs, then the original D's one stock write.
async function inventoryFixture() {
  const f=await waitingFixture({responses:['imported'],prerequisitePolicy:'configured'});
  for(let index=0;index<3;index++) { f.lastObservation=await f.job(); await f.createRuntime().runJob({jobId:f.lastObservation.jobId}); f.d.advance(11); }
  // 真实 D 作业都带准备证据（prepare() 必写），fixture 原先不带，
  // 于是 results.mjs:186 的 `!== undefined` 把第 187 行那道断言整段跳过。
  // 补上之后，下面两条失败档用例才真的走到那道闸。
  f.preparationEvidence=await attachDPreparationEvidence(f.d);
  return f;
}
async function continueInventory(f,{onStock=async()=>{},stockRejected=false,readback=exactObservation}={}) {
  const d=f.d,before=await d.repository.readSnapshot(),job=dJob(before,d),verify=()=>true;
  const source=assertDRemainingInventoryContinuation({document:before,job,observationJobId:f.lastObservation.jobId,
    checkedAt:d.input.serverClock(),verifyInventoryPrerequisiteSource:verify});
  const leaseId='lease:synthetic:terminal-stock';
  await d.jobStore.claimDRemainingInventory({jobId:job.jobId,worker:d.worker,leaseId,leaseDurationMs:60000,
    observationJobId:f.lastObservation.jobId,verifyInventoryPrerequisiteSource:verify});
  return runPersistedDRemainingInventory({repository:d.repository,candidateId:d.candidate.id,serverClock:d.input.serverClock,
    currentProductionBinding:d.currentProductionBinding,observation:source.prerequisites,
    softwareJobContext:{jobStore:d.jobStore,jobId:job.jobId,workerId:d.worker.workerId,leaseId},
    assertRemainingInventoryAuthorization:async()=>{const document=await d.repository.readSnapshot();
      assertDRemainingInventorySend({document,job:dJob(document,d),observationJobId:f.lastObservation.jobId,
        checkedAt:d.input.serverClock(),workerId:d.worker.workerId,leaseId,verifyInventoryPrerequisiteSource:verify});},
    createAdapter:({executionContext,request})=>{
      const adapter=createStoreIsolatedOzonSellerApiDEAdapter({executionContext,adapterCapabilities:f.caps,
        requestJson:async(call,options)=>{
          assert.equal(call.endpoint,'/v2/products/stocks'); await options.beforeRequestSend();
          d.calls.push(call.endpoint); await onStock(call);
          return {result:[{offer_id:request.merchantSku,product_id:910001,warehouse_id:Number(request.inventoryWrite.warehouseId),
            updated:!stockRejected,errors:stockRejected?[{code:'synthetic-stock-rejection'}]:[]}]};
        }});
      return {...adapter,readbackSellerApi:async query=>readback(request,query)};
    }});
}
const clone = value => structuredClone(value);
const dJob = (document, f) => document.runtime.softwareJobs.find(job => job.jobId === f.job.jobId);
const eJobs = document => document.runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback");

test("generic settlement rejects every D and E terminal without domain evidence and changes nothing", async t => {
  for (const type of ["d_production_execution", "e_independent_readback"]) {
    for (const status of ["completed", "failed", "unknown_outcome"]) {
      await t.test(`${type}: ${status}`, async () => {
        const f = await savedDProductionJobFixture();
        let job = f.job;
        if (type === "e_independent_readback") {
          assert.equal((await runPersistedDExecution({ ...f.input, createAdapter: createSyntheticDCompletionAdapter })).status, "succeeded");
          const [queued] = eJobs(await f.repository.readSnapshot());
          job = await f.jobStore.claim({ jobId: queued.jobId, worker: f.worker,
            leaseId: "lease:synthetic:e-terminal-guard", leaseDurationMs: 60_000 });
        }
        if (status !== "failed") {
          job = await f.jobStore.markExternalRequestStarted({ jobId: job.jobId, workerId: job.workerId,
            leaseId: job.leaseId, externalRequestRef: "request:synthetic:terminal-guard" });
        }
        const settlement = { jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId, status,
          externalRequestState: status === "completed" ? "succeeded" : status === "failed" ? "not_sent" : "unknown_outcome",
          failureClass: status === "completed" ? null : "synthetic-unproven-terminal" };
        const before = await f.repository.readSnapshot();
        assert.throws(() => settleSoftwareJob({ ...settlement, job, serverTime: f.input.serverClock() }),
          /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
        await assert.rejects(() => f.repository.transact(document => ({ changed: true, document,
          result: settleSoftwareJobInDocument(document, settlement, f.input.serverClock()) })),
        /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
        await assert.rejects(() => f.jobStore.settle(settlement), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
        assert.deepEqual(await f.repository.readSnapshot(), before);
      });
    }
  }
});

for (const reconciliation of ["reconcileExpiredLeases", "reconcileAfterRestart"]) {
  test(`${reconciliation} preserves the original unknown job while its actual late D receipts are saved without E`, async () => {
    const staged=await inventoryFixture(),f=staged.d;
    let reconciledJob;
    const result = await continueInventory(staged,{onStock:async()=>{
      f.advance(60_001);
      const outcome = await f.jobStore[reconciliation]();
      assert.deepEqual(outcome.reconciled, [f.job.jobId]);
      reconciledJob = dJob(await f.repository.readSnapshot(), f);
      assert.equal(reconciledJob.status, "unknown_outcome");
      assert.equal(reconciledJob.externalRequestState, "unknown_outcome");
    }});
    assert.equal(result.status, "succeeded");
    const saved = await f.repository.readSnapshot(), sku = saved.candidates[0].lifecycleV11.skuPackage;
    assert.deepEqual(dJob(saved, f), reconciledJob);
    assert.deepEqual(f.calls, ["/v3/product/import", "/v2/products/stocks"]);
    assert.deepEqual(staged.calls,["/v1/product/import/info","/v3/product/info/list","/v2/product/info/stocks-by-warehouse/fbs"]);
    assert.equal(sku.dSoftwareExecution.status, "succeeded");
    assert.equal(sku.dSoftwareExecution.continuationBlocked, true);
    assert.equal(sku.dSoftwareExecution.blockReason, "software_job_reconciliation_required");
    assert.equal(sku.dSoftwareExecution.checkpoints.length, 6);
    assert.deepEqual(sku.productionRecord, sku.dSoftwareExecution.attempt.productionRecord);
    assert.equal(sku.productionRecord.platformProductId, "910001");
    assert.equal(sku.eVerificationRecord, null);
    assert.deepEqual(sku.readbackHistory, []);
    assert.equal(eJobs(saved).length, 0);
    const calls = [...f.calls];
    await assert.rejects(() => runPersistedDExecution({ ...f.input, createAdapter: f.createAdapter() }), /D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
    assert.deepEqual(f.calls, calls);
    assert.deepEqual(await f.repository.readSnapshot(), saved);
  });
}

test("a failed terminal contradicting actual saved import receipts is rejected atomically", async () => {
  const staged=await waitingFixture(),f=staged.d;
  const lastCertain=await f.repository.readSnapshot();
  assert.deepEqual(lastCertain.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.checkpoints.map(event=>event.kind),
    ["import_intent","import_task_received"]);
  const terminalDocument = await f.repository.readSnapshot();
  const state = terminalDocument.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  await assert.rejects(() => f.repository.transact(document => {
    // Replay the captured pre-terminal transaction, preserving its genuine request and checkpoint evidence.
    document.runtime.softwareJobs = clone(lastCertain.runtime.softwareJobs);
    const candidate = document.candidates[0];
    candidate.lifecycleV11.skuPackage.dSoftwareExecution = { ...clone(state), status: "failed",
      attempt: { ...clone(state.attempt), status: "failed", completedAt: f.input.serverClock(),
        failure: { layer: "production_admission", code: "SOFTWARE_JOB_LEASE_REJECTED", message: "synthetic contradictory prewrite failure" } } };
    const result = settleDProductionJobInDocument({ document, candidate, jobId: f.job.jobId,
      workerId: f.worker.workerId, leaseId: f.job.leaseId, observedAt: f.input.serverClock() });
    return { changed: true, document, result };
  }), /DE_JOB_RESULT_[A-Z_]+|D_JOB_[A-Z_]+/);
  assert.deepEqual(await f.repository.readSnapshot(), terminalDocument);
  assert.equal(eJobs(terminalDocument).length, 0);
  assert.equal(terminalDocument.candidates[0].lifecycleV11.skuPackage.productionRecord, null);
});

test("concurrent owner, handoff and unique-job corruption cannot create an E job from real D receipts", async t => {
  const cases = {
    owner: (document, f) => { dJob(document, f).ownerUserId = "owner:synthetic:other"; },
    requester: (document, f) => { dJob(document, f).requestedByUserId = "owner:synthetic:other"; },
    handoff: document => { document.candidates[0].lifecycleV11.skuPackage.dHandoff.softwareJobRef.jobId += ":other"; },
    missing_handoff: document => { delete document.candidates[0].lifecycleV11.skuPackage.dHandoff.softwareJobRef; },
    duplicate_job: (document, f) => { document.runtime.softwareJobs.push({ ...clone(dJob(document, f)), jobId: `${f.job.jobId}:duplicate` }); }
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, async () => {
    const staged=await inventoryFixture(),f=staged.d;
    let changed = false;
    await assert.rejects(() => continueInventory(staged,{onStock:async()=>{
      await f.repository.transact(document=>{corrupt(document,f);changed=true;return {changed:true,document};});
    }}), /DE_JOB_RESULT_[A-Z_]+|D_JOB_HANDOFF_[A-Z_]+|D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
    assert.equal(changed, true);
    const saved = await f.repository.readSnapshot();
    assert.equal(eJobs(saved).length, 0);
    assert.equal(saved.candidates[0].lifecycleV11.skuPackage.productionRecord, null);
    assert.equal(dJob(saved, f).status, "waiting_platform");
    assert.equal(f.factories(), 1);
    assert.deepEqual(f.calls, ["/v3/product/import", "/v2/products/stocks"]);
  });
});

test("a real failed import observation is saved as platform failure with no stock, E or import replay", async()=>{
  const f=await waitingFixture({responses:['failed'],responseFor:({defaultResponse})=>{defaultResponse.result.items[0].errors=[{code:'synthetic-import-rejection'}];return defaultResponse;}});const job=await f.job();
  await f.createRuntime().runJob({jobId:job.jobId});
  const saved=await f.d.repository.readSnapshot(),sku=saved.candidates[0].lifecycleV11.skuPackage,c=sku.dSoftwareExecution.platformContinuation;
  assert.equal(c.status,'platform_failed');assert.equal(c.inventoryWriteState,'not_sent');
  assert.equal(c.observationHistory.length,1);const observed=c.observationHistory[0].result.importObservation;
  assert.equal(observed.status,'failed');assert.equal(observed.errorCount,1);assert.equal(observed.taskId,'501');assert.equal(observed.productId,'910001');
  assert.equal(sku.dSoftwareExecution.status,'failed');assert.equal(dJob(saved,f.d).status,'failed');
  assert.equal(sku.productionRecord,null);assert.equal(eJobs(saved).length,0);
  assert.deepEqual(f.d.calls,['/v3/product/import']);assert.deepEqual(f.calls,['/v1/product/import/info']);
  await f.createRuntime().runJob({jobId:job.jobId});
  await assert.rejects(()=>runPersistedDExecution({...f.d.input,createAdapter:f.d.createAdapter()}),/D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
  assert.equal(f.d.factories(),1);assert.equal(f.calls.length,1);assert.deepEqual(await f.d.repository.readSnapshot(),saved);
});

test("a real import observation exception is unknown and cannot retry or reach inventory",async()=>{
 const error=new Error('synthetic disconnect after accepted import');
 const f=await waitingFixture({beforeResponse:()=>{throw error;}}),job=await f.job();
 await assert.rejects(()=>f.createRuntime().runJob({jobId:job.jobId}),value=>value===error);
 const saved=await f.d.repository.readSnapshot(),sku=saved.candidates[0].lifecycleV11.skuPackage;
 assert.equal(sku.dSoftwareExecution.status,'unknown_outcome');assert.equal(dJob(saved,f.d).status,'unknown_outcome');
 assert.equal(sku.dSoftwareExecution.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(sku.productionRecord,null);assert.equal(eJobs(saved).length,0);
 await f.createRuntime().runJob({jobId:job.jobId});
 await assert.rejects(()=>runPersistedDExecution({...f.d.input,createAdapter:f.d.createAdapter()}),/D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
 assert.deepEqual(f.d.calls,['/v3/product/import']);assert.deepEqual(f.calls,['/v1/product/import/info']);
 assert.deepEqual(await f.d.repository.readSnapshot(),saved);
});

test("the real adapter preserves a failed stock receipt and settles unknown without further requests",async()=>{
 const staged=await inventoryFixture(),f=staged.d;
 assert.equal((await continueInventory(staged,{stockRejected:true})).status,'unknown_outcome');
 const saved=await f.repository.readSnapshot(),sku=saved.candidates[0].lifecycleV11.skuPackage;
 assert.deepEqual(sku.dSoftwareExecution.checkpoints.map(event=>event.kind),['import_intent','import_task_received','import_result_observed','stock_intent','stock_receipt_observed']);
 const observation=sku.dSoftwareExecution.checkpoints.at(-1);
 assert.equal(observation.errorCount,1);assert.equal(observation.updated,false);assert.equal(observation.taskId,'501');assert.equal(observation.productId,'910001');
 assert.equal(sku.dSoftwareExecution.status,'unknown_outcome');assert.equal(dJob(saved,f).status,'unknown_outcome');
 assert.equal(dJob(saved,f).externalRequestState,'unknown_outcome');assert.equal(sku.productionRecord,null);assert.equal(eJobs(saved).length,0);
 assert.deepEqual(f.calls,['/v3/product/import','/v2/products/stocks']);assert.equal(staged.calls.length,3);
 await assert.rejects(()=>runPersistedDExecution({...f.input,createAdapter:f.createAdapter()}),/D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
 await assert.rejects(()=>continueInventory(staged),/SOURCE|CONTINUATION|INVENTORY/);
 assert.deepEqual(await f.repository.readSnapshot(),saved);assert.equal(f.calls.length,2);
});

test("a final readback identity mismatch after real staged writes is unknown and cannot authorize E or replay D",async()=>{
 const staged=await inventoryFixture(),f=staged.d;let receivedObservation;
 const result=await continueInventory(staged,{readback:request=>{
  receivedObservation={...exactObservation(request),platformProductId:'910002'};return clone(receivedObservation);
 }});
 assert.equal(result.status,'unknown_outcome');
 const saved=await f.repository.readSnapshot(),sku=saved.candidates[0].lifecycleV11.skuPackage,state=sku.dSoftwareExecution;
 assert.equal(state.status,'unknown_outcome');assert.equal(state.checkpoints.length,6);
 assert.equal(state.checkpoints.at(-1).kind,'independent_readback_observed');
 assert.deepEqual(state.checkpoints.at(-1).observation,receivedObservation);assert.deepEqual(state.attempt.immediateReadback,receivedObservation);
 assert.equal(state.checkpoints.find(event=>event.kind==='import_result_observed').productId,'910001');
 assert.equal(state.attempt.reason,'write_readback_mismatch:warehouse_identity_or_quantity_unverified,platformProductId');
 assert.equal(dJob(saved,f).status,'unknown_outcome');assert.equal(dJob(saved,f).externalRequestState,'unknown_outcome');
 assert.equal(sku.productionRecord,null);assert.equal(eJobs(saved).length,0);
 assert.deepEqual(f.calls,['/v3/product/import','/v2/products/stocks']);assert.equal(staged.calls.length,3);
 await assert.rejects(()=>runPersistedDExecution({...f.input,createAdapter:f.createAdapter()}),/D_EXECUTION_SOFTWARE_JOB_REFERENCE_CONFLICT/);
 assert.equal(f.factories(),1);assert.deepEqual(await f.repository.readSnapshot(),saved);
});

test("unknown readback diagnostics preserve bounded multiple differences and reject unrecognized or malformed codes", () => {
  const longest = formatDReadbackMismatchReason(D_READBACK_MISMATCH_CODES);
  assert.ok(longest.length > 256);
  assert.equal(isDProductionUnknownReason(longest), true);
  assert.equal(formatDReadbackMismatchReason(["currentPrice", "currentStock", "currentPrice"]), "write_readback_mismatch:currentPrice,currentStock");
  for (const value of ["write_readback_mismatch:", "write_readback_mismatch:arbitrary_code", "write_readback_mismatch:currentPrice,",
    "write_readback_mismatch:,currentPrice", "write_readback_mismatch:currentPrice,currentPrice",
    "write_readback_mismatch:currentPrice\n,currentStock", "write_readback_mismatch:currentPrice, currentStock",
    `${longest},currentPrice`, null]) assert.equal(isDProductionUnknownReason(value), false);
  for (const values of [[], ["arbitrary_code"], ["currentPrice,currentStock"], [null]]) {
    assert.throws(() => formatDReadbackMismatchReason(values), /D_READBACK_MISMATCH_CODES_INVALID/);
  }
  assert.equal(isDProductionUnknownReason("independent_readback_failed"), true);
  assert.equal(isDProductionUnknownReason("service_restart_after_persist_before_terminal_receipt"), true);
});
