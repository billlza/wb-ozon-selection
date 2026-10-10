import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createServer } from "node:http";
import { isOzonCaptureJob, validateOzonCaptureRequest } from "../extension/1688-capture/capture-request.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT || 43927);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT || 43928);
if (![port, gatewayPort].every(value => Number.isSafeInteger(value) && value > 0 && ![4317, 4318, 4173].includes(value)) ||
    port === gatewayPort) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const baseUrl = `http://127.0.0.1:${port}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_PASSWORD = "synthetic password for bounded Ozon page read tests";

function candidate(id, productId) {
  return {
    id,
    source: "codex",
    group: "dandanshu",
    targetStore: "dandanshu",
    productName: `测试Ozon商品${productId}`,
    productUrl: `https://www.ozon.ru/product/test-${productId}/`,
    sourceUrl: "unknown",
    purchasePriceRmb: 20,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 10, width: 10, height: 5 },
    powered: false,
    workflowStatus: "codex_processing",
    dataRevision: 1,
    processing: { state: "blocked", manualHold: true, blockReason: "历史技术失败" },
    comments: [],
    history: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z"
  };
}

function document(candidates) {
  return {
    meta: { version: 2, title: "test", updatedAt: "2026-08-14T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates,
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  };
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

function evidence(productId, extra = {}) {
  return {
    productId,
    productUrl: `https://www.ozon.ru/product/${productId}/`,
    title: "Музыкальная швейная машинка",
    imageRefs: ["https://ir.ozone.ru/test.jpg"],
    currentPrice: 2598,
    currency: "RUB",
    categoryPath: "Хобби > Музыкальные шкатулки",
    attributes: { Тип: "Музыкальная шкатулка" },
    sellerIdentitySignals: [{ field: "seller_display_name", value: "Example", sourcePath: "widget.heading" }],
    marketScope: "ozon_general_market",
    observedAt: "2026-08-14T01:00:00.000Z",
    ...extra
  };
}

/** One isolated server per test: its own data file, its own owner identity file, its own AI gateway stub. */
async function startApi(t, candidates, { ttlMs = 2000, executionTtlMs = 500, dataFile = null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ozon-page-read-api-"));
  // 身份私有目录不得与业务数据目录交叠，所以两者各占一个子目录。
  const privateDirectory = path.join(directory, "private");
  const businessDirectory = path.join(directory, "business");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(businessDirectory);
  const file = dataFile ?? path.join(businessDirectory, "candidates.json");
  if (dataFile === null) await writeFile(file, JSON.stringify(document(candidates)));

  let terraCalls = 0;
  const gateway = createServer(async (req, res) => {
    terraCalls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({
      jobId: "inf-ozon-capture-test", candidateId: request.candidateId, dataRevision: request.dataRevision,
      taskType: request.taskType, model: request.model, status: "completed", attempt: 1,
      receipt: {
        requestHash: "a".repeat(64), outputSchemaHash: "b".repeat(64), evidenceRefs: request.evidenceRefs,
        requestedAt: "2026-08-14T01:00:01.000Z", completedAt: "2026-08-14T01:00:02.000Z",
        validation: { strictJson: true, schemaValid: true }, usage: "unknown",
        output: { summary: "公开销售快照已整理", comparabilitySignals: ["当前价格清晰"], attributeHints: [] }
      }
    }));
  });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "127.0.0.1", resolve); });

  const stderr = [];
  let child = null;
  let cookie = "";
  t.after(async () => {
    try { if (child) await stopApiProcess(child); }
    finally {
      gateway.closeAllConnections();
      await new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()));
    }
  });
  const env = {
    ...process.env,
    SELECTION_REVIEW_DATA_FILE: file,
    SELECTION_REVIEW_API_PORT: String(port),
    SELECTION_REVIEW_PUBLIC_ORIGIN: baseUrl,
    SELECTION_REVIEW_ALLOWED_ORIGINS: baseUrl,
    SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
    SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password",
    SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, "owner.json"),
    SELECTION_REVIEW_AUTO_DELIVER: "off",
    SELECTION_REVIEW_CODEX_DISPATCH: "off",
    SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS: String(ttlMs),
    SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS: String(executionTtlMs),
    SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`
  };
  async function start() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
      cwd: appDir, env, stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    await waitForHealth(child, stderr);
  }
  async function post(route, body, { authenticated = true, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin",
        ...(authenticated && cookie ? { Cookie: cookie } : {}), ...headers },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  async function get(route) {
    const response = await fetch(`${baseUrl}${route}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: response.status, body: await response.json() };
  }
  await start();
  return {
    dataFile: file, stderr, get, post,
    terraCalls: () => terraCalls,
    readDocument: async () => JSON.parse(await readFile(file, "utf8")),
    async login() {
      const response = await post("/api/owner-access/setup", { password: OWNER_PASSWORD }, { authenticated: false });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      cookie = response.cookie.split(";")[0];
    },
    claim: (jobId, version = "1.4.0") =>
      post(`/api/extension/capture-jobs/${jobId}/claim`, { version }, { authenticated: false, headers: { Origin: extensionOrigin } }),
    result: (candidateId, body) =>
      post(`/api/candidates/${candidateId}/sales-capture/result`, body, { authenticated: false, headers: { Origin: extensionOrigin } }),
    restart: async () => { await stopApiProcess(child); child = null; cookie = ""; await start(); }
  };
}

const startRoute = id => `/api/candidates/${id}/sales-capture/start`;

test("读一次 Ozon 页面：只有主人能发起，占同一把采集控制锁，插件明确领取一次并原子落盘真实页面快照", async (t) => {
  const api = await startApi(t, [candidate("OZON-CAPTURE-1", "4403916892"), candidate("OZON-OTHER-1", "4403916999")]);

  const idleHealth = await api.get("/api/health");
  assert.equal(idleHealth.body.captureControl.status, "idle");

  const preflight = await fetch(`${baseUrl}/api/candidates/OZON-CAPTURE-1/sales-capture/result`, {
    method: "OPTIONS", headers: { Origin: extensionOrigin }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

  // 没登录就发起：明确拒绝，并且一个字都没写进业务数据。未登录先被全局身份守卫挡成 401，
  // 路由自己那道「必须是主人」的检查站在它后面，两道都在。
  const beforeAnything = await readFile(api.dataFile, "utf8");
  const anonymous = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: 1 }, { authenticated: false });
  assert.equal(anonymous.status, 401);
  assert.equal(await readFile(api.dataFile, "utf8"), beforeAnything, "未登录的发起不得产生任何业务写入");
  const serverSource = await readFile(path.join(appDir, "server.mjs"), "utf8");
  assert.match(serverSource, /code: "ozon_page_read_owner_required"/u, "路由自己也必须要求主人身份");

  await api.login();

  // 封闭输入：只收当前数据修订号与可选的主人指定 Ozon 商品地址。
  const extraField = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: 1, unapprovedField: "synthetic" });
  assert.equal(extraField.status, 400);
  assert.equal(extraField.body.code, "ozon_page_read_input_invalid");
  const staleRevision = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: 99 });
  assert.equal(staleRevision.status, 409);
  assert.equal(staleRevision.body.code, "revision_conflict");
  assert.equal(await readFile(api.dataFile, "utf8"), beforeAnything, "被拒绝的发起不得产生任何业务写入");

  const queued = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: 1 });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.status, "ozon_page_read_job_queued");
  assert.equal(queued.body.duplicate, false);
  assert.equal(queued.body.dispatch, null);
  assert.equal(queued.body.captureJob.status, "queued");
  assert.equal(queued.body.captureJob.attempt, 0);
  assert.equal(queued.body.captureJob.requiredExtensionVersion, "1.4.0");
  assert.equal(queued.body.captureJob.expectedProductId, "4403916892");
  assert.equal(queued.body.captureJob.productUrl, "https://www.ozon.ru/product/4403916892/");
  assert.equal(Object.hasOwn(queued.body.captureJob, "token"), false, "页面回执不得带一次性令牌");
  assert.equal(queued.body.candidate.salesCapture.status, "waiting_extension");
  assert.equal(queued.body.candidate.salesCapture.jobStatus, "queued");
  assert.equal(queued.body.candidate.salesCapture.writeOccurred, false);
  assert.equal(queued.body.candidate.workflowStatus, "codex_processing", "读页面不推进业务阶段");

  // 同一把全局采集控制锁：另一件商品此刻不能开始读。
  const busy = await api.get("/api/health");
  assert.equal(busy.body.captureControl.status, "busy");
  assert.equal(busy.body.captureControl.candidateId, "OZON-CAPTURE-1");
  assert.equal(busy.body.captureControl.platform, "ozon");
  assert.equal(busy.body.captureControl.captureKind, "sales");
  const blockedParallel = await api.post(startRoute("OZON-OTHER-1"), { dataRevision: 1 });
  assert.equal(blockedParallel.status, 409);
  assert.match(blockedParallel.body.message, /商品采集控制正由 OZON-CAPTURE-1 使用/u);
  const otherDuringCapture = (await api.readDocument()).candidates.find(item => item.id === "OZON-OTHER-1");
  assert.equal(otherDuringCapture.dataRevision, 1);
  assert.equal(otherDuringCapture.salesCapture, undefined);

  // 同一次作业重复发起：沿用它，不再建第二个。
  const duplicate = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: 1 });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.captureJob.jobId, queued.body.captureJob.jobId);

  const wrongVersion = await api.claim(queued.body.captureJob.jobId, "1.2.6");
  assert.equal(wrongVersion.status, 409);
  assert.equal(wrongVersion.body.code, "extension_version_mismatch");

  const claim = await api.claim(queued.body.captureJob.jobId);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const job = claim.body.captureJob;
  // 插件那侧的判定原样跑一遍：形状不对，真实作业会在插件里被当场丢掉。
  assert.equal(isOzonCaptureJob(job), true);
  assert.deepEqual(validateOzonCaptureRequest({ payload: job, manifestVersion: "1.4.0" }),
    { ok: true, sourceUrl: "https://www.ozon.ru/product/4403916892/" });
  assert.equal(Object.hasOwn(job, "mode"), false);
  assert.equal(Object.hasOwn(job, "sourceUrl"), false);
  assert.equal(job.candidateId, "OZON-CAPTURE-1");
  assert.equal(job.attempt, 1);
  assert.equal(typeof job.token, "string");

  const secondClaim = await api.claim(queued.body.captureJob.jobId);
  assert.equal(secondClaim.status, 409, "同一作业只能领取一次");

  // 页面要人工过验证：如实停下，不重试、不绕过、不落任何快照。
  const stopped = await api.result("OZON-CAPTURE-1", {
    captureId: job.captureId, token: job.token, dataRevision: job.dataRevision,
    status: "failed", failureCode: "site_verification_required", observedAt: "2026-08-14T01:05:00.000Z"
  });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.candidate.salesCapture.status, "failed");
  assert.equal(stopped.body.candidate.salesCapture.failureCode, "site_verification_required");
  assert.equal(stopped.body.candidate.salesCapture.technicalStatus, "permission_required");
  assert.equal(stopped.body.candidate.salesCapture.retryAttempted, false);
  assert.equal(stopped.body.candidate.salesCapture.writeOccurred, false);
  assert.equal(stopped.body.candidate.salesSnapshotsV11, undefined);
  assert.equal(stopped.body.candidate.workflowStatus, "codex_processing");
  assert.equal(api.terraCalls(), 0);
  assert.equal((await api.get("/api/health")).body.captureControl.status, "idle", "停下之后采集控制必须放开");

  // 停下之后主人可以自己再读一次；软件不会替他重试。
  const stoppedRevision = stopped.body.candidate.dataRevision;
  const again = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: stoppedRevision });
  assert.equal(again.status, 202);
  assert.notEqual(again.body.captureJob.jobId, queued.body.captureJob.jobId);
  const secondJob = (await api.claim(again.body.captureJob.jobId)).body.captureJob;

  const revisionConflict = await api.result("OZON-CAPTURE-1", {
    captureId: secondJob.captureId, token: secondJob.token, dataRevision: secondJob.dataRevision - 1,
    status: "captured", evidence: evidence("4403916892")
  });
  assert.equal(revisionConflict.status, 409);

  const wrongProduct = await api.result("OZON-CAPTURE-1", {
    captureId: secondJob.captureId, token: secondJob.token, dataRevision: secondJob.dataRevision,
    status: "captured", evidence: evidence("9999999")
  });
  assert.equal(wrongProduct.status, 200);
  assert.equal(wrongProduct.body.candidate.salesCapture.status, "failed");
  assert.equal(wrongProduct.body.candidate.salesCapture.failureCode, "wrong_product");
  assert.equal(wrongProduct.body.candidate.salesSnapshotsV11, undefined, "身份不符不得落盘任何快照");

  const third = await api.post(startRoute("OZON-CAPTURE-1"), { dataRevision: wrongProduct.body.candidate.dataRevision });
  assert.equal(third.status, 202);
  const thirdJob = (await api.claim(third.body.captureJob.jobId)).body.captureJob;
  const captured = await api.result("OZON-CAPTURE-1", {
    captureId: thirdJob.captureId, token: thirdJob.token, dataRevision: thirdJob.dataRevision,
    status: "captured", evidence: evidence("4403916892")
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(captured.body.candidate.salesCapture.status, "verified");
  assert.equal(captured.body.candidate.salesCapture.writeOccurred, false);
  const snapshots = captured.body.candidate.salesSnapshotsV11;
  assert.equal(snapshots.length, 1);
  // 这一条才是算利润认的那一份：只有插件真的回传结果时才会产生。
  assert.equal(snapshots[0].collectorMode, "real_page_read_only");
  assert.equal(snapshots[0].collectorVersion, "real-ozon-sales-snapshot-v1");
  assert.equal(snapshots[0].categoryPath, "Хобби > Музыкальные шкатулки");
  assert.equal(snapshots[0].productUrl, "https://www.ozon.ru/product/4403916892/");
  assert.equal(snapshots[0].readOnly, true);
  assert.equal(captured.body.candidate.workflowStatus, "codex_processing", "读到了也不推进业务阶段");
  assert.equal(captured.body.candidate.lifecycleV11.platformWrites, 0);

  // 算利润那一小块现在说「可以用它」，按钮不再被类目挡住。
  const view = await api.get("/api/candidates/OZON-CAPTURE-1/lifecycle/supplier-draft");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.ozonCategoryReadStepV1.ready, true);
  assert.equal(view.body.ozonCategoryReadStepV1.readySource, "real_page_snapshot");
  assert.equal(view.body.ozonCategoryReadStepV1.category, "Хобби > Музыкальные шкатулки");
  assert.equal(view.body.ozonCategoryReadStepV1.action.available, false);

  const persisted = await api.readDocument();
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(persisted.meta.automationStarted, false);
  const other = persisted.candidates.find(item => item.id === "OZON-OTHER-1");
  assert.equal(other.dataRevision, 1);
  assert.equal(other.salesCapture, undefined);
  assert.equal(api.stderr.join(""), "");
});

test("没人领取就按期限收口，1688 那一侧的领取判断一个字都没变", async (t) => {
  const api = await startApi(t, [candidate("OZON-TIMEOUT-1", "4403916892")]);
  await api.login();

  // 不存在的作业编号仍旧由 1688 那条路径回答，错误码与文案不变。
  const unknown = await api.claim("SCJ-does-not-exist");
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.code, "capture_job_not_current");
  assert.equal(unknown.body.message, "当前服务没有这次明确创建的采集作业");
  const claimShape = await api.post("/api/extension/capture-jobs/SCJ-does-not-exist/claim",
    { version: "1.4.0", extra: true }, { authenticated: false, headers: { Origin: extensionOrigin } });
  assert.equal(claimShape.status, 400);
  assert.equal(claimShape.body.code, "capture_claim_invalid");

  const queued = await api.post(startRoute("OZON-TIMEOUT-1"), { dataRevision: 1 });
  assert.equal(queued.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const timedOut = (await api.readDocument()).candidates.find(item => item.id === "OZON-TIMEOUT-1");
  assert.equal(timedOut.salesCapture.status, "failed", "没有收口的记录会把这件商品永远钉在等插件上");
  assert.equal(timedOut.salesCapture.failureCode, "extension_job_unclaimed");
  assert.equal(timedOut.salesCapture.jobStatus, "failed");
  assert.equal(timedOut.salesCapture.writeOccurred, false);
  assert.equal(timedOut.workflowStatus, "codex_processing");
  assert.equal((await api.get("/api/health")).body.captureControl.status, "idle");
  // 收口之后主人可以重新读一次；这正是卡住时做不到的那一步。
  const retry = await api.post(startRoute("OZON-TIMEOUT-1"), { dataRevision: timedOut.dataRevision });
  assert.equal(retry.status, 202);
  assert.equal(api.stderr.join(""), "");
});

test("服务重启时把等不到结果的读页面记录收口，不留下永远卡住的记录", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ozon-page-read-restart-"));
  const dataFile = path.join(directory, "candidates.json");
  const waiting = candidate("OZON-RESTART-QUEUED", "4403916892");
  waiting.salesCapture = { captureId: "OPR-lost-queued", jobId: "OPR-lost-queued", status: "waiting_extension",
    jobStatus: "queued", productId: "4403916892", productUrl: "https://www.ozon.ru/product/4403916892/",
    attempt: 0, requiredExtensionVersion: "1.4.0", token: "must-not-survive-restart", writeOccurred: false };
  const capturing = candidate("OZON-RESTART-CLAIMED", "4403916999");
  capturing.salesCapture = { captureId: "OPR-lost-claimed", jobId: "OPR-lost-claimed", status: "capturing",
    jobStatus: "claimed", productId: "4403916999", productUrl: "https://www.ozon.ru/product/4403916999/",
    attempt: 1, requiredExtensionVersion: "1.4.0", writeOccurred: false };
  const settled = candidate("OZON-RESTART-DONE", "4403916777");
  settled.salesCapture = { captureId: "OPR-done", status: "verified", technicalStatus: "completed", writeOccurred: false };
  await writeFile(dataFile, JSON.stringify(document([waiting, capturing, settled])));

  const api = await startApi(t, null, { dataFile });
  await api.login();
  const stored = await api.readDocument();
  const closedQueued = stored.candidates.find(item => item.id === "OZON-RESTART-QUEUED");
  const closedClaimed = stored.candidates.find(item => item.id === "OZON-RESTART-CLAIMED");
  const untouched = stored.candidates.find(item => item.id === "OZON-RESTART-DONE");
  for (const closed of [closedQueued, closedClaimed]) {
    assert.equal(closed.salesCapture.status, "failed");
    assert.equal(closed.salesCapture.failureCode, "capture_job_lost");
    assert.equal(closed.salesCapture.writeOccurred, false);
    assert.equal(closed.workflowStatus, "codex_processing");
    assert.equal(closed.dataRevision, 2, "收口只推进一次修订号");
  }
  assert.match(closedQueued.salesCapture.reason, /重新读一次/u);
  assert.equal(closedQueued.salesCapture.token, undefined, "一次性令牌不得随收口留在记录里");
  assert.deepEqual(untouched.salesCapture, { captureId: "OPR-done", status: "verified", technicalStatus: "completed", writeOccurred: false },
    "已有结论的记录不得被重启改写");
  assert.equal(untouched.dataRevision, 1);
  assert.equal((await api.get("/api/health")).body.captureControl.status, "idle");
  // 收口之后这件商品可以重新读一次。
  const retry = await api.post(startRoute("OZON-RESTART-QUEUED"), { dataRevision: closedQueued.dataRevision });
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  assert.equal(api.stderr.join(""), "");
});
