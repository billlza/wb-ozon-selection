import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const baseUrl = `http://127.0.0.1:${port}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function candidate(id) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    targetPlatform: "ozon",
    storeRef: structuredClone(SYNTHETIC_STORE_REF),
    productName: `测试音乐盒 ${id}`,
    productUrl: "https://www.ozon.ru/product/test-4403916892/",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    purchasePriceRmb: 17.3,
    packedWeightKg: 0.4,
    dimensionsCm: { length: 12, width: 12, height: 7 },
    workflowStatus: "codex_processing",
    dataRevision: 1,
    processing: { state: "idle", manualHold: true },
    lifecycleV11: {
      schemaVersion: "product-lifecycle-v1.1",
      status: "opportunity_sales_snapshot_captured",
      opportunityPackage: { schemaVersion: "product-lifecycle-v1.1", entityType: "OpportunityPackage" },
      platformWrites: 0
    },
    comments: [],
    history: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z"
  };
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

function post(pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin", ...headers },
    body: JSON.stringify(body)
  });
}

function aSubmission(dataRevision, candidateId = "A-JOB-1") {
  return {
    dataRevision,
    sourceCandidateId: candidateId,
    sourceDataRevision: dataRevision,
    targetPlatform: "ozon",
    storeRef: structuredClone(SYNTHETIC_STORE_REF),
    decision: "confirm",
    salesReview: {},
    supplierConfirmation: {
      productUrl: "https://qr.1688.com/s/7OnLCakq",
      ownerSupplyConfirmed: false
    }
  };
}

function patch(pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body)
  });
}

function heartbeat(version = "1.2.7") {
  return post("/api/extension/heartbeat", {
    version,
    backgroundReady: true,
    observedAt: new Date().toISOString()
  }, { Origin: extensionOrigin });
}

function claimJob(jobId, version = "1.2.7") {
  return post(`/api/extension/capture-jobs/${jobId}/claim`, { version }, { Origin: extensionOrigin });
}

function evidence() {
  return {
    offerId: "876240928352",
    sourceUrl: "https://detail.1688.com/offer/876240928352.html",
    title: "复古缝纫机手摇音乐盒",
    offerStatus: "online",
    observedAt: new Date().toISOString(),
    titleSource: "offerBaseInfo.subject",
    offerIdSource: "offerBaseInfo.offerId",
    pageFields: {
      unitProductPriceCny: null,
      unitProductPriceSource: null,
      unitDomesticFreightCny: null,
      unitDomesticFreightSource: null
    },
    priceRanges: [],
    supplierAttributes: {},
    skus: [
      {
        sourceSkuId: "sewing-black",
        attributes: { 款式: "黑色缝纫机" },
        priceCny: 11.8,
        priceSource: "skuModel.skuInfoMap.price",
        stock: 120,
        stockSource: "skuModel.skuInfoMap.canBookCount"
      },
      {
        sourceSkuId: "sewing-ivory",
        attributes: { 款式: "象牙白缝纫机" },
        priceCny: null,
        priceSource: null,
        stock: null,
        stockSource: null
      }
    ]
  };
}

test("A确认只建立本次作业，明确领取一次并原子保存SKU，心跳始终不领取", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-job-"));
  const dataFile = path.join(directory, "candidates.json");
  const other = candidate("OTHER-1");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-19T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [candidate("A-JOB-1"), candidate("A-FAIL"), candidate("A-TIMEOUT"), candidate("A-DRIFT"), other],
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  }));
  const originalOther = JSON.stringify(other);
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: "dandanshu", platform: "ozon", storeRef: SYNTHETIC_STORE_REF }]),
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_ALLOWED_ORIGINS: baseUrl,
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS: "2000",
      SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS: "500"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await waitForHealth(child, stderr);

  const beforeNoJob = await readFile(dataFile, "utf8");
  const idleHeartbeat = await heartbeat();
  assert.equal(idleHeartbeat.status, 200);
  assert.equal((await idleHeartbeat.json()).captureJob, null);
  assert.equal(await readFile(dataFile, "utf8"), beforeNoJob, "无任务心跳不得写业务数据");

  const queuedResponse = await post("/api/candidates/A-JOB-1/lifecycle/a-confirm", aSubmission(1));
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.equal(queued.status, "supplier_capture_job_queued");
  assert.equal(queued.captureJob.status, "queued");
  assert.equal(queued.captureJob.attempt, 0);
  assert.equal(queued.captureJob.requiredExtensionVersion, "1.2.7");
  assert.equal(queued.candidate.sourceCapture.status, "waiting_extension");
  assert.equal(queued.bStarted, false);
  assert.equal(queued.c1Created, false);
  assert.equal(queued.dispatch, null);

  const duplicate = await post("/api/candidates/A-JOB-1/lifecycle/a-confirm", aSubmission(queued.candidate.dataRevision));
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.captureJob.jobId, queued.captureJob.jobId);
  assert.equal(duplicateBody.captureJob.attempt, 0);

  const queuedBeforeHeartbeat = await readFile(dataFile, "utf8");
  assert.equal((await (await heartbeat()).json()).captureJob, null);
  assert.equal(await readFile(dataFile, "utf8"), queuedBeforeHeartbeat, "即使存在已授权队列作业，心跳也不能领取");
  const mismatch = await claimJob(queued.captureJob.jobId, "1.2.6");
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "extension_version_mismatch");
  assert.equal(await readFile(dataFile, "utf8"), queuedBeforeHeartbeat);
  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.candidates.find(item => item.id === "A-JOB-1").currentSourceCapture, null, "排队不等于已开始采集");
  const claimResponse = await claimJob(queued.captureJob.jobId);
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();
  assert.equal(claim.captureJob.candidateId, "A-JOB-1");
  assert.equal(claim.captureJob.attempt, 1);
  assert.equal(claim.captureJob.mode, "a_supplier_capture");
  assert.equal(claim.captureJob.sourceUrl, "https://qr.1688.com/s/7OnLCakq");
  assert.equal(claim.captureJob.allowShortLinkResolution, true);
  assert.equal(typeof claim.captureJob.token, "string");
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  const activeCapture = state.candidates.find(item => item.id === "A-JOB-1").currentSourceCapture;
  assert.equal(activeCapture.currentExecutionConfirmed, true);
  assert.equal(activeCapture.captureId, claim.captureJob.captureId);
  assert.equal(activeCapture.candidateRevision, claim.captureJob.dataRevision);
  assert.equal(Object.hasOwn(activeCapture, "token"), false);

  const secondClaim = await claimJob(queued.captureJob.jobId);
  assert.equal(secondClaim.status, 409, "同一作业只能领取一次");
  const blockedParallelCandidate = await post("/api/candidates/A-TIMEOUT/lifecycle/a-confirm", aSubmission(1, "A-TIMEOUT"));
  assert.equal(blockedParallelCandidate.status, 409, "一个采集作业执行时不得创建第二个候选作业");

  const revisionConflict = await post("/api/candidates/A-JOB-1/source-capture/result", {
    captureId: claim.captureJob.captureId,
    token: claim.captureJob.token,
    dataRevision: claim.captureJob.dataRevision - 1,
    status: "captured",
    resolvedSourceUrl: "https://detail.1688.com/offer/876240928352.html",
    evidence: evidence()
  }, { Origin: extensionOrigin });
  assert.equal(revisionConflict.status, 409);
  assert.equal((await revisionConflict.json()).code, "revision_conflict");

  const resultResponse = await post("/api/candidates/A-JOB-1/source-capture/result", {
    captureId: claim.captureJob.captureId,
    token: claim.captureJob.token,
    dataRevision: claim.captureJob.dataRevision,
    status: "captured",
    resolvedSourceUrl: "https://detail.1688.com/offer/876240928352.html",
    evidence: evidence()
  }, { Origin: extensionOrigin });
  assert.equal(resultResponse.status, 200);
  const result = await resultResponse.json();
  assert.equal(result.candidate.sourceCapture.status, "captured_waiting_owner_selection");
  assert.equal(result.candidate.sourceCapture.jobStatus, "completed");
  assert.equal(result.candidate.sourceCapture.attempt, 1);
  assert.equal(result.candidate.sourceCapture.offerId, "876240928352");
  assert.equal(result.candidate.sourceCapture.sourceUrl, "https://detail.1688.com/offer/876240928352.html");
  assert.equal(result.candidate.sourceCapture.skuChoices.length, 2);
  assert.equal(result.candidate.sourceCapture.skuChoices[0].priceCny, 11.8);
  assert.equal(result.candidate.sourceCapture.skuChoices[1].priceCny, null);
  assert.equal(result.candidate.sourceCapture.skuChoices[1].stock, null);
  assert.deepEqual(result.candidate.sourceCapture.selectedSkuIds, []);
  assert.equal(result.candidate.sourceCapture.ownerSupplyConfirmed, false);
  assert.equal(result.candidate.workflowStatus, "codex_processing");
  assert.equal(result.candidate.lifecycleV11.skuPackage, undefined);
  assert.equal(result.dispatch, null);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.candidates.length, 5);
  assert.equal(state.meta.automationStarted, false);
  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(JSON.stringify(persisted.candidates.find((item) => item.id === "OTHER-1")), originalOther);

  const failedQueued = await post("/api/candidates/A-FAIL/lifecycle/a-confirm", aSubmission(1, "A-FAIL"));
  assert.equal(failedQueued.status, 202);
  const failedClaimResponse = await claimJob((await failedQueued.json()).captureJob.jobId);
  const failedClaim = await failedClaimResponse.json();
  assert.equal(failedClaim.captureJob.candidateId, "A-FAIL");

  const rejectedRawUrl = await post("/api/candidates/A-FAIL/source-capture/result", {
    captureId: failedClaim.captureJob.captureId,
    token: failedClaim.captureJob.token,
    dataRevision: failedClaim.captureJob.dataRevision,
    status: "failed",
    failureCode: "wrong_offer",
    observedAt: "2026-08-19T08:00:00.000Z",
    failureDiagnostics: {
      finalHostClass: "detail_1688",
      finalPathType: "offer_detail",
      redirectClassification: "different_offer",
      navigationStage: "page_complete",
      observedOfferId: "999999",
      finalUrl: "https://detail.1688.com/offer/999999.html?token=must-not-persist"
    }
  }, { Origin: extensionOrigin });
  assert.equal(rejectedRawUrl.status, 400);
  assert.equal((await rejectedRawUrl.json()).code, "capture_failure_diagnostics_invalid");

  const failedResultResponse = await post("/api/candidates/A-FAIL/source-capture/result", {
    captureId: failedClaim.captureJob.captureId,
    token: failedClaim.captureJob.token,
    dataRevision: failedClaim.captureJob.dataRevision,
    status: "failed",
    failureCode: "wrong_offer",
    observedAt: "2026-08-19T08:00:00.000Z",
    failureDiagnostics: {
      finalHostClass: "detail_1688",
      finalPathType: "offer_detail",
      redirectClassification: "different_offer",
      navigationStage: "page_complete",
      observedOfferId: "999999"
    }
  }, { Origin: extensionOrigin });
  assert.equal(failedResultResponse.status, 200);
  const failedResult = await failedResultResponse.json();
  assert.equal(failedResult.candidate.sourceCapture.status, "failed");
  assert.equal(failedResult.candidate.sourceCapture.failureCode, "wrong_offer");
  assert.equal(failedResult.candidate.sourceCapture.failureDestinationLabel, "不同商品");
  assert.equal(failedResult.candidate.sourceCapture.failureDiagnostics.redirectClassification, "different_offer");
  assert.equal(failedResult.candidate.workflowStatus, "codex_processing");
  assert.equal(failedResult.candidate.lifecycleV11.skuPackage, undefined);
  assert.equal(failedResult.dispatch, null);
  const afterFailure = await readFile(dataFile, "utf8");
  assert.doesNotMatch(afterFailure, /must-not-persist|finalUrl|[?&]token=/i);
  const afterFailureData = JSON.parse(afterFailure);
  assert.equal(afterFailureData.dispatches.length, 0);
  assert.equal(afterFailureData.meta.automationStarted, false);
  assert.equal(JSON.stringify(afterFailureData.candidates.find((item) => item.id === "OTHER-1")), originalOther);

  const timeoutQueued = await post("/api/candidates/A-TIMEOUT/lifecycle/a-confirm", aSubmission(1, "A-TIMEOUT"));
  assert.equal(timeoutQueued.status, 202);
  const timeoutClaim = await claimJob((await timeoutQueued.json()).captureJob.jobId);
  assert.equal((await timeoutClaim.json()).captureJob.candidateId, "A-TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 700));
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  const timedOut = state.candidates.find((item) => item.id === "A-TIMEOUT");
  assert.equal(timedOut.sourceCapture.status, "failed");
  assert.equal(timedOut.sourceCapture.failureCode, "unknown_outcome");
  assert.equal(timedOut.sourceCapture.jobStatus, "unknown_outcome");
  const beforeRepeat = await readFile(dataFile, "utf8");
  const repeat = await post("/api/candidates/A-TIMEOUT/lifecycle/a-confirm", aSubmission(timedOut.dataRevision, "A-TIMEOUT"));
  assert.equal(repeat.status, 409);
  assert.equal((await repeat.json()).code, "previous_capture_requires_review");
  assert.equal(await readFile(dataFile, "utf8"), beforeRepeat);
  assert.equal(timedOut.workflowStatus, "codex_processing");
  assert.equal((await (await heartbeat("1.2.7")).json()).captureJob, null, "unknown_outcome不得自动重新领取");

  // 等插件的过程中主人改了别的资料，商品修订号就会前进。收口只认这条采集记录本身（captureId），不再因为修订号变了
  // 就放弃：否则候选永远停在 waiting_extension，previous_capture_requires_review 会拒绝之后的每一次采集申请。
  const driftQueued = await post("/api/candidates/A-DRIFT/lifecycle/a-confirm", aSubmission(1, "A-DRIFT"));
  assert.equal(driftQueued.status, 202);
  const driftJob = await driftQueued.json();
  assert.equal(driftJob.candidate.sourceCapture.status, "waiting_extension");
  const noted = await patch("/api/candidates/A-DRIFT", { dataRevision: driftJob.candidate.dataRevision, notes: "等插件的时候又补了一句备注" });
  assert.equal(noted.status, 200);
  const driftedRevision = (await noted.json()).candidate.dataRevision;
  assert.equal(driftedRevision, driftJob.candidate.dataRevision + 1, "这次改动必须真的推进修订号");
  await new Promise((resolve) => setTimeout(resolve, 2400));
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  const drifted = state.candidates.find((item) => item.id === "A-DRIFT");
  assert.equal(drifted.sourceCapture.status, "failed", "修订号变了也必须收口，不能让候选永远等插件");
  assert.equal(drifted.sourceCapture.failureCode, "extension_job_unclaimed");
  assert.equal(drifted.sourceCapture.jobStatus, "failed");
  assert.equal(drifted.sourceCapture.writeOccurred, false);
  assert.equal(drifted.workflowStatus, "codex_processing");
  // 收口之后主人可以重新申请采集；这正是卡住时做不到的那一步。
  const driftRetry = await post("/api/candidates/A-DRIFT/lifecycle/a-confirm", aSubmission(drifted.dataRevision, "A-DRIFT"));
  assert.equal(driftRetry.status, 202, "旧作业已收口，新的采集申请必须被接受");
  assert.equal((await driftRetry.json()).captureJob.status, "queued");

  assert.equal(stderr.join(""), "");
});
