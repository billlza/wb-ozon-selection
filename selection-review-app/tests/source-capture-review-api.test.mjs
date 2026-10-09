import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;
const extensionOrigin = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function candidate(id) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    targetPlatform: "ozon",
    storeRef: structuredClone(SYNTHETIC_STORE_REF),
    productName: `合成核实测试商品 ${id}`,
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

function aSubmission(dataRevision, candidateId) {
  return {
    dataRevision,
    sourceCandidateId: candidateId,
    sourceDataRevision: dataRevision,
    targetPlatform: "ozon",
    storeRef: structuredClone(SYNTHETIC_STORE_REF),
    decision: "confirm",
    salesReview: {},
    supplierConfirmation: { productUrl: "https://qr.1688.com/s/7OnLCakq", ownerSupplyConfirmed: false }
  };
}

/**
 * 结果未知的采集记录只有主人自己能了结。这个测试证明的是三件事：这条出路真的存在（路由）、它不编造任何采集结果
 * （业务状态与证据一字未动）、而且核实之后守卫真的放行下一次采集申请——2026-09-11 主人卡死的正是最后这一步。
 */
test("主人核实“结果未知”的采集记录：只记核实、不动业务状态，核实后才允许重新建作业", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-review-api-"));
  const privateDirectory = path.join(directory, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const businessDirectory = path.join(directory, "business");
  await mkdir(businessDirectory);
  const dataFile = path.join(businessDirectory, "state.json");
  const untouched = candidate("REVIEW-OTHER");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-19T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [candidate("REVIEW-UNKNOWN"), candidate("REVIEW-CLEAN"), untouched],
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  }));
  const originalUntouched = JSON.stringify(untouched);
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_PUBLIC_ORIGIN: base,
      SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
      SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password",
      SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, "owner.json"),
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: "dandanshu", platform: "ozon", storeRef: SYNTHETIC_STORE_REF }]),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS: "4000",
      SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS: "400"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 15000);
    let output = "";
    const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("").slice(-2000)}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
  });

  let cookie = "";
  async function post(route, body, headers = {}) {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") };
  }
  async function state() {
    const response = await fetch(`${base}/api/state`, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(response.status, 200);
    return response.json();
  }
  const saved = () => readFile(dataFile);
  const savedCandidate = async id => JSON.parse(await readFile(dataFile, "utf8")).candidates.find(item => item.id === id);

  // 没登录就不能核实：核实是主人自己的判断，软件不接受匿名代办。
  const beforeLogin = await saved();
  const anonymous = await post("/api/candidates/REVIEW-UNKNOWN/source-capture/review", { dataRevision: 1 });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await saved(), beforeLogin);

  const setup = await post("/api/owner-access/setup", { password: "synthetic capture review password" });
  assert.equal(setup.status, 200);
  cookie = setup.setCookie.split(";")[0];
  assert.deepEqual(await saved(), beforeLogin, "登录本身不得改动业务数据");

  // 没有“结果未知”的记录时，这条路由什么都不做，并说清楚为什么。
  const clean = await post("/api/candidates/REVIEW-CLEAN/source-capture/review", { dataRevision: 1 });
  assert.equal(clean.status, 409);
  assert.equal(clean.body.code, "source_capture_review_not_applicable");
  assert.deepEqual(await saved(), beforeLogin);

  // 把 REVIEW-UNKNOWN 真的推进到 status=failed / jobStatus=unknown_outcome：插件领取了作业，但执行期限内没有回传结果。
  const queued = await post("/api/candidates/REVIEW-UNKNOWN/lifecycle/a-confirm", aSubmission(1, "REVIEW-UNKNOWN"));
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.status, "supplier_capture_job_queued");
  const firstCaptureId = queued.body.captureJob.jobId;
  const claim = await post(`/api/extension/capture-jobs/${firstCaptureId}/claim`, { version: "1.2.7" }, { Origin: extensionOrigin, Cookie: "" });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  await new Promise(resolve => setTimeout(resolve, 900));
  const stuck = (await state()).candidates.find(item => item.id === "REVIEW-UNKNOWN");
  assert.equal(stuck.sourceCapture.status, "failed");
  assert.equal(stuck.sourceCapture.jobStatus, "unknown_outcome");
  assert.equal(stuck.sourceCapture.failureCode, "unknown_outcome");
  assert.equal(stuck.sourceCapture.reviewedAt, undefined);
  const stuckReason = stuck.sourceCapture.reason;
  assert.equal(typeof stuckReason, "string");
  const stuckRecord = await savedCandidate("REVIEW-UNKNOWN");
  const stuckLifecycle = JSON.stringify(stuckRecord.lifecycleV11);

  // 这就是主人今天下午撞上的墙：未核实的记录挡住每一次新的采集申请。
  const blocked = await post("/api/candidates/REVIEW-UNKNOWN/lifecycle/a-confirm", aSubmission(stuck.dataRevision, "REVIEW-UNKNOWN"));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "previous_capture_requires_review");

  // 封闭输入：修订号必须是整数，确认选项必须来自固定列表，任何多余字段（包括自由文本）一律拒绝。
  const beforeRejections = await saved();
  for (const body of [
    { dataRevision: "1" },
    {},
    { dataRevision: stuck.dataRevision, acknowledgement: "looks_fine" },
    { dataRevision: stuck.dataRevision, note: "我觉得应该采到了" },
    { dataRevision: stuck.dataRevision, acknowledgement: "no_result_received", reviewedBy: "owner" }
  ]) {
    const rejected = await post("/api/candidates/REVIEW-UNKNOWN/source-capture/review", body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(rejected.body.code, "source_capture_review_input_invalid");
  }
  const conflict = await post("/api/candidates/REVIEW-UNKNOWN/source-capture/review", { dataRevision: stuck.dataRevision - 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "revision_conflict");
  const missing = await post("/api/candidates/REVIEW-NOT-THERE/source-capture/review", { dataRevision: 1 });
  assert.equal(missing.status, 404);
  assert.deepEqual(await saved(), beforeRejections, "被拒绝的核实请求不得写入任何数据");

  const reviewed = await post("/api/candidates/REVIEW-UNKNOWN/source-capture/review",
    { dataRevision: stuck.dataRevision, acknowledgement: "no_result_received" });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const record = reviewed.body.candidate.sourceCapture;
  // 保留原本的失败事实：软件没有、也不会替主人补一份采集结果。
  assert.equal(record.failureCode, "unknown_outcome");
  assert.equal(record.reason, stuckReason);
  assert.equal(record.status, "failed");
  assert.equal(record.captureId, firstCaptureId);
  assert.equal(record.writeOccurred, false);
  assert.equal(record.skuChoices, undefined);
  assert.equal(record.evidence, undefined);
  // 只多了“主人已核实”这件事，作业状态落到终态。
  assert.equal(record.jobStatus, "failed");
  assert.equal(record.reviewedBy, "owner");
  assert.equal(record.acknowledgement, "no_result_received");
  assert.ok(Number.isFinite(Date.parse(record.reviewedAt)));
  assert.equal(reviewed.body.dispatch, null);
  // 业务状态一律不动。
  assert.equal(reviewed.body.candidate.workflowStatus, "codex_processing");
  assert.equal(reviewed.body.candidate.dataRevision, stuck.dataRevision + 1);
  const reviewedRecord = await savedCandidate("REVIEW-UNKNOWN");
  assert.equal(JSON.stringify(reviewedRecord.lifecycleV11), stuckLifecycle);
  assert.deepEqual(reviewedRecord.processing, stuckRecord.processing);
  assert.equal(reviewedRecord.sourceUrl, stuckRecord.sourceUrl);
  assert.equal(reviewedRecord.history.filter(item => item.action === "aSupplierCaptureReviewed").length, 1);
  assert.match(reviewedRecord.history.at(-1).detail, /没有可用结果/);
  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(persisted.meta.automationStarted, false);
  assert.equal(JSON.stringify(persisted.candidates.find(item => item.id === "REVIEW-OTHER")), originalUntouched);

  // 同一条记录只核实一次；重复提交既不会重复记账，也不会假装成功。
  const beforeRepeat = await saved();
  const repeated = await post("/api/candidates/REVIEW-UNKNOWN/source-capture/review", { dataRevision: reviewed.body.candidate.dataRevision });
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.code, "source_capture_already_reviewed");
  assert.deepEqual(await saved(), beforeRepeat);

  // 核实之后，守卫必须放行：这正是卡住时做不到的那一步。
  const retry = await post("/api/candidates/REVIEW-UNKNOWN/lifecycle/a-confirm",
    aSubmission(reviewed.body.candidate.dataRevision, "REVIEW-UNKNOWN"));
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  assert.equal(retry.body.captureJob.status, "queued");
  assert.notEqual(retry.body.captureJob.jobId, firstCaptureId);
  // 新作业是一条全新的记录：主人的核实不会被带进来，也不会替新的一次采集背书。
  assert.equal(retry.body.candidate.sourceCapture.status, "waiting_extension");
  assert.equal(retry.body.candidate.sourceCapture.reviewedAt, undefined);
  assert.equal(retry.body.candidate.sourceCapture.acknowledgement, undefined);
  assert.equal(retry.body.candidate.workflowStatus, "codex_processing");
  assert.equal(retry.body.bStarted, false);
  assert.equal(retry.body.c1Created, false);
  assert.equal(retry.body.dispatch, null);

  // 放宽只针对“已核实的结果未知”。新作业还活着，再点一次不会产生第二个作业。
  const again = await post("/api/candidates/REVIEW-UNKNOWN/lifecycle/a-confirm",
    aSubmission(retry.body.candidate.dataRevision, "REVIEW-UNKNOWN"));
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.captureJob.jobId, retry.body.captureJob.jobId);

  assert.equal(stderr.join(""), "");
});
