import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const baseUrl = `http://127.0.0.1:${port}`;

function candidate(id, lifecycle = false) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `${id}历史候选`,
    productUrl: "https://www.ozon.ru/product/simulation/",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html",
    purchasePriceRmb: 41,
    packedWeightKg: 0.21,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    powered: false,
    workflowStatus: "listing_preparation",
    dataRevision: 1,
    processing: { state: "idle", manualHold: false },
    listingPreparation: { status: "awaiting_user_start" },
    listingHandoff: { state: "awaiting_user_start", owner: "listing_task" },
    comments: [],
    history: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...(lifecycle ? {
      lifecycleV11: { opportunityPackage: { parentOpportunityId: `opportunity:${id}` } },
      sourceCapture: {
        captureId: "SC-LEGACY",
        status: "needs_sku_selection",
        mode: "listing_preparation",
        offerId: "712421624571",
        sourceUrl: "https://detail.1688.com/offer/712421624571.html",
        skuChoices: [{ sourceSkuId: "SKU-LEGACY", attributes: { 款式: "旧规格" } }]
      }
    } : {})
  };
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function post(url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body)
  });
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("2A模拟接口零持久化，旧C入口明确拒绝且awaiting_user_start只读", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "phase-2a-api-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-14T00:00:00.000Z", automationStarted: false },
    rules: {
      selectionFlow: {
        profitInputs: ["productName", "purchasePriceRmb"],
        sourcePagePurpose: "旧规则：精确货源只在C阶段核验"
      },
      listingPreparation: { startPolicy: "single_sku_user_button" },
      purchaseInput: { domesticShippingRmb: 0, note: "旧规则：未知运费按0" },
      ozonDandanshu: { minimumUnitProfitRmb: 20, targetMarginRate: 0.25, thresholdPolicy: "both" },
      ozonMiska: { minimumUnitProfitRmb: 20, targetMarginRate: 0.25, thresholdPolicy: "both" },
      wbCrossListing: { minimumUnitProfitRmb: 20, targetMarginRate: 0.25, thresholdPolicy: "both" }
    },
    candidates: [candidate("LEGACY-AWAITING"), candidate("LIFECYCLE-NEW", true)],
    dispatches: [{
      id: "D-LEGACY-C",
      candidateId: "LEGACY-AWAITING",
      dataRevision: 1,
      nodeId: "M07",
      scope: "candidate",
      assigneeRole: "selection_task",
      assigneeTitle: "选品",
      status: "queued",
      message: "旧C阶段错误派发"
    }]
  }));
  await writeFile(path.join(directory, "workflow-map.json"), JSON.stringify({ nodes: [], edges: [] }));
  const before = await readFile(dataFile);

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      PATH: "/usr/bin:/bin",
      SELECTION_REVIEW_PUBLIC_ORIGIN: baseUrl,
      SELECTION_REVIEW_ALLOWED_ORIGINS: baseUrl,
      SELECTION_REVIEW_IDENTITY_PROVIDER: "development_default",
      SELECTION_REVIEW_WORKFLOW_MAP_FILE: path.join(directory, "workflow-map.json"),
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await waitForHealth(child, stderr);

  const initialState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(initialState.candidates.length, 2);
  assert.deepEqual(initialState.rules.selectionFlow.profitInputs, [
    "confirmedSupplierSku",
    "actualPurchaseCost",
    "packedWeightKg",
    "dimensionsCm"
  ]);
  assert.match(initialState.rules.selectionFlow.sourcePagePurpose, /^A阶段完成精确1688链接/);
  assert.equal(initialState.rules.listingPreparation.startPolicy, "auto_c1_after_b_passed");
  assert.equal(initialState.rules.purchaseInput.domesticShippingRmb, null);
  assert.equal(
    initialState.rules.purchaseInput.componentPolicy,
    "legacy_all_in_cost_keeps_goods_price_and_domestic_freight_unknown"
  );
  for (const key of ["ozonDandanshu", "ozonMiska", "wbCrossListing"]) {
    assert.equal(initialState.rules[key].minimumUnitProfitRmb, 20);
    assert.equal(initialState.rules[key].targetMarginRate, 0.15);
    assert.equal(initialState.rules[key].thresholdPolicy, "either");
  }
  const legacyAwaiting = initialState.candidates.find((item) => item.id === "LEGACY-AWAITING");
  assert.equal(legacyAwaiting.listingHandoff.state, "awaiting_user_start");
  assert.equal(legacyAwaiting.activeDispatch, null);
  assert.equal(legacyAwaiting.latestDispatch.status, "legacy_disabled");

  const missingOrigin = await fetch(`${baseUrl}/api/candidates/LEGACY-AWAITING/start-listing-preparation`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataRevision: 1 })
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).code, "api_origin_required");

  for (const id of ["LEGACY-AWAITING", "LIFECYCLE-NEW"]) {
    const response = await post(`/api/candidates/${id}/start-listing-preparation`, { dataRevision: 1 });
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /旧“开始上架准备”入口已停用/);
  }

  const capture = await post("/api/candidates/LIFECYCLE-NEW/source-capture/start", { dataRevision: 1 });
  assert.equal(capture.status, 409);
  assert.match((await capture.json()).message, /不会创建旧C阶段派发/);

  const oldSkuSelection = await post("/api/candidates/LIFECYCLE-NEW/source-capture/select-sku", {
    dataRevision: 1,
    sourceSkuIds: ["SKU-LEGACY"]
  });
  assert.equal(oldSkuSelection.status, 409);
  assert.match((await oldSkuSelection.json()).message, /只保留历史读取/);

  const oldDispatch = await post("/api/candidates/LIFECYCLE-NEW/dispatch", { dataRevision: 1 });
  assert.equal(oldDispatch.status, 409);
  assert.match((await oldDispatch.json()).message, /不能使用旧通用派发入口/);

  const oldClaim = await post("/api/dispatches/D-LEGACY-C/claim", {
    runId: "legacy-run",
    currentStep: "尝试领取旧C"
  });
  assert.equal(oldClaim.status, 409);
  assert.match((await oldClaim.json()).message, /旧派发通道已停用.*历史派发只读/);

  const oldEvaluation = await post("/api/candidates/LIFECYCLE-NEW/user-evaluation", {
    dataRevision: 1,
    decision: "viable"
  });
  assert.equal(oldEvaluation.status, 409);
  assert.match((await oldEvaluation.json()).message, /新版生命周期商品不能使用旧方向确认入口/);

  const oldReview = await post("/api/candidates/LIFECYCLE-NEW/codex-review", {
    dataRevision: 1,
    decision: "approved"
  });
  assert.equal(oldReview.status, 409);
  assert.match((await oldReview.json()).message, /不能使用旧B审核入口/);

  const demoCard = await (await fetch(`${baseUrl}/api/simulations/phase-2a`)).json();
  assert.equal(demoCard.card.isSimulation, true);
  assert.equal(demoCard.card.sharedCandidatesAffected, 0);
  const simulated = await post("/api/simulations/phase-2a/confirm", {
    decision: "confirm",
    supplierConfirmation: demoCard.card.supplierConfirmation
  });
  assert.equal(simulated.status, 200);
  const simulatedBody = await simulated.json();
  assert.equal(simulatedBody.result.status, "c1_handed_off");
  assert.deepEqual(simulatedBody.persistence, {
    sharedCandidatesWritten: 0,
    dispatchesCreated: 0,
    platformAccesses: 0,
    platformWrites: 0
  });

  const after = await readFile(dataFile);
  assert.equal(sha(after), sha(before));
  const finalState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(finalState.meta.automationStarted, false);
  assert.equal(finalState.candidates.length, 2);
  assert.equal(finalState.candidates.every((item) => item.activeDispatch === null), true);
});

test("旧方向卡不再提供绕过A确认直接算利润的入口", async () => {
  const source = await readFile(path.join(appDir, "src", "components", "UserInspector.jsx"), "utf8");
  assert.doesNotMatch(source, /待确认 · 看利润/);
  assert.doesNotMatch(source, /提交并计算利润/);
  assert.doesNotMatch(source, /系统将国内运费记为0/);
  assert.match(source, /新版A确认卡/);
  assert.match(source, /主人确认后系统才自动进入B/);
});
