import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { allocatedTestPorts, stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { newIntakeRecord, parseIntakeLinks } from "../lib/intake-pipeline.mjs";

// Every link, goods number, title and picture address below is synthetic. The service is told not to fetch any picture.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = allocatedTestPorts();
const baseUrl = `http://127.0.0.1:${ports.api}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_PASSWORD = "synthetic password for intake pipeline tests";
const PDD_A = "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001";
const PDD_B = "https://mobile.yangkeduo.com/goods.html?goods_id=600000000002";
const PDD_C = "https://mobile.yangkeduo.com/goods.html?goods_id=600000000003";
const OFFER = "https://detail.1688.com/offer/712345678901.html";
const IMAGE = (id) => `https://img.pddpic.com/garner-api-new/synthetic-${id}.jpeg`;
// The extension version the service requires is the one the extension ships with.
const EXTENSION_VERSION = JSON.parse(await readFile(path.join(appDir, "extension/1688-capture/manifest.json"), "utf8")).version;

const document = candidates => ({
  meta: { version: 2, title: "test", updatedAt: "2026-10-10T00:00:00.000Z", automationStarted: false },
  rules: {}, candidates, dispatches: [], nodeDispatches: [], workflowComments: [], controlAlerts: [], evidencePacks: []
});
const existing = (id, extra = {}) => ({ id, source: "codex", group: "miska", targetStore: "miska", productName: `合成已有商品 ${id}`,
  productUrl: "https://www.ozon.ru/product/synthetic-900000001/", sourceUrl: "", workflowStatus: "needs_user_data", dataRevision: 1,
  comments: [], history: [], createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", ...extra });

function seededIntake(id, url, { index = 0, size = 1, submittedAt = "2026-10-10T05:00:00.000Z", jobs = {}, ...extra } = {}) {
  const [link] = parseIntakeLinks([url]).links;
  const intake = newIntakeRecord({ link, submittedAt, submittedBy: "synthetic-owner", batchId: "INB-seeded", batchIndex: index, batchSize: size });
  return existing(id, { source: "user", productUrl: "", sourceUrl: link.sourceUrl, workflowStatus: "awaiting_user_direction",
    productName: "录入中的商品", intake: { ...intake, jobs: { ...intake.jobs, ...jobs } }, ...extra });
}

function pddEvidence(goodsUrl, title) {
  const goodsId = new URL(goodsUrl).searchParams.get("goods_id");
  return {
    offerId: goodsId, sourceUrl: goodsUrl, title, offerStatus: "on_sale", observedAt: new Date().toISOString(),
    titleSource: "rawData.goods.goodsName", offerIdSource: "rawData.goods.goodsID",
    pageFields: { unitProductPriceCny: null, unitProductPriceSource: null, unitDomesticFreightCny: null, unitDomesticFreightSource: null },
    priceRanges: [], supplierAttributes: {}, mainImageUrl: IMAGE(goodsId), mainImageSource: "rawData.goods.topGallery[0]",
    skus: [
      { sourceSkuId: `${goodsId}-a`, attributes: { 颜色: "卡其色" }, priceCny: 15.08, priceSource: "rawData.goods.skus.groupPrice",
        stock: 10, stockSource: "rawData.goods.skus.quantity", weight: 0.18, weightSource: "rawData.goods.skus.weight" },
      { sourceSkuId: `${goodsId}-b`, attributes: { 颜色: "黑色" }, priceCny: 16.5, priceSource: "rawData.goods.skus.groupPrice",
        stock: 0, stockSource: "rawData.goods.skus.quantity" }
    ]
  };
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function startApi(t, candidates) {
  const directory = await mkdtemp(path.join(tmpdir(), "intake-api-"));
  const privateDirectory = path.join(directory, "private");
  const businessDirectory = path.join(directory, "business");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(businessDirectory);
  const file = path.join(businessDirectory, "candidates.json");
  await writeFile(file, JSON.stringify(document(candidates)));
  const stderr = [];
  let cookie = "";
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir, stdio: ["ignore", "ignore", "pipe"], env: {
    ...process.env,
    SELECTION_REVIEW_DATA_FILE: file,
    SELECTION_REVIEW_API_PORT: String(ports.api),
    SELECTION_REVIEW_PUBLIC_ORIGIN: baseUrl,
    SELECTION_REVIEW_ALLOWED_ORIGINS: baseUrl,
    SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
    SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password",
    SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, "owner.json"),
    SELECTION_REVIEW_AUTO_DELIVER: "off",
    SELECTION_REVIEW_CODEX_DISPATCH: "off",
    SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
    SELECTION_REVIEW_IMAGE_FINGERPRINT_FETCH: "off",
    SELECTION_REVIEW_INTAKE_PUMP_INTERVAL_MS: "100"
  } });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(async () => { await stopApiProcess(child); });
  await waitForHealth(child, stderr);
  async function call(method, route, body, { authenticated = true, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin",
        ...(authenticated && cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  const post = (route, body, options) => call("POST", route, body, options);
  const extension = (route, body) => post(route, body, { authenticated: false, headers: { Origin: extensionOrigin } });
  const record = async id => JSON.parse(await readFile(file, "utf8")).candidates.find(entry => entry.id === id);
  const api = {
    file, stderr, post, record,
    async login() {
      const response = await post("/api/owner-access/setup", { password: OWNER_PASSWORD }, { authenticated: false });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      cookie = response.cookie.split(";")[0];
    },
    queue: ({ bridge = true } = {}) => call("GET", `/api/intake/queue${bridge ? "?bridge=1" : ""}`),
    heartbeat: () => extension("/api/extension/heartbeat", { version: EXTENSION_VERSION, backgroundReady: true, observedAt: new Date().toISOString() }),
    claim: jobId => extension(`/api/extension/capture-jobs/${jobId}/claim`, { version: EXTENSION_VERSION }),
    async until(label, check) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const queue = (await api.queue()).body;
        const value = await check(queue);
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`等不到：${label}；${stderr.join("")}`);
    },
    pending: kind => api.until(`排好的 ${kind}`, queue => (queue.pendingStart?.kind === kind ? queue.pendingStart : null)),
    async runSource(candidateId, goodsUrl, title) {
      const pending = await api.pending("supplier_capture");
      assert.equal(pending.candidateId, candidateId);
      const claim = await api.claim(pending.captureId);
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      const job = claim.body.captureJob;
      const saved = await extension(`/api/candidates/${candidateId}/source-capture/result`, { captureId: job.captureId, token: job.token,
        dataRevision: job.dataRevision, status: "captured", resolvedSourceUrl: goodsUrl, evidence: pddEvidence(goodsUrl, title) });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.candidate.sourceCapture.status, "captured_waiting_owner_selection");
    },
    async failMatch(candidateId, kind, failureCode) {
      const pending = await api.pending(kind);
      assert.equal(pending.candidateId, candidateId);
      const claim = await api.claim(pending.captureId);
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      const job = claim.body.captureJob;
      const route = kind === "ozon_image_match" ? "ozon-match" : "image-match";
      const stopped = await extension(`/api/candidates/${candidateId}/${route}/result`, { captureId: job.captureId, token: job.token,
        dataRevision: job.dataRevision, status: "failed", failureCode, observedAt: new Date().toISOString() });
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      return pending;
    }
  };
  return api;
}

test("贴链接：只有主人能贴；新建的一条一件、重复的指回原来那件；插件没连上或没有工作台页面时排着的不开始", async t => {
  const api = await startApi(t, [existing("SEERFAR-1", { sourceUrl: `${OFFER}?spm=synthetic` })]);
  const anonymous = await api.post("/api/intake/links", { links: [PDD_A] }, { authenticated: false });
  assert.equal(anonymous.status, 401);
  await api.login();
  assert.equal((await api.post("/api/intake/links", { links: PDD_A })).body.code, "intake_input_invalid");
  assert.equal((await api.post("/api/intake/links", { links: [PDD_A], targetStore: "wb" })).body.code, "intake_input_invalid");
  const garbage = await api.post("/api/intake/links", { links: ["随便一句话", "https://www.ozon.ru/product/x-1/"] });
  assert.deepEqual([garbage.status, garbage.body.code, garbage.body.rejected.length], [422, "intake_links_unrecognized", 2]);
  const many = await api.post("/api/intake/links", { links: Array.from({ length: 21 }, (_, index) => `${PDD_A.slice(0, -2)}${10 + index}`) });
  assert.equal(many.body.code, "intake_too_many_links");

  const pasted = await api.post("/api/intake/links", { links: [`【拼多多】合成宠物背心 ${PDD_A}&refer=share`, OFFER, "随便一句话"] });
  assert.equal(pasted.status, 201, JSON.stringify(pasted.body));
  const [created, duplicate] = pasted.body.items;
  assert.match(created.candidateId, /^USR-\d{8}-\d{3}$/);
  assert.deepEqual([created.created, created.sourceKind, duplicate], [true, "pinduoduo",
    { candidateId: "SEERFAR-1", created: false, duplicateOfCandidateId: "SEERFAR-1", duplicateEliminated: false, sourceKind: "1688" }]);
  assert.equal(pasted.body.rejected.length, 1);
  const again = await api.post("/api/intake/links", { links: [PDD_A] });
  assert.deepEqual([again.status, again.body.items[0].candidateId, again.body.items[0].created], [200, created.candidateId, false]);

  const stored = await api.record(created.candidateId);
  assert.deepEqual([stored.productName, stored.sourceUrl, stored.targetStore, stored.workflowStatus, stored.intake.stage, stored.intake.sourceKind,
    stored.intake.batch.index, stored.intake.batch.size], ["录入中的商品", PDD_A, "miska", "awaiting_user_direction", "queued", "pinduoduo", 0, 1]);
  assert.equal(stored.history.at(-1).action, "intakeSubmitted");

  // No extension heartbeat yet and no workbench page polling: nothing starts, nothing fails.
  await new Promise(resolve => setTimeout(resolve, 400));
  const quiet = (await api.queue({ bridge: false })).body;
  assert.deepEqual(quiet.items.map(item => [item.candidateId, item.stage, item.queue, item.batch]),
    [[created.candidateId, "queued", { position: 1, total: 1 }, { position: 1, total: 1 }]]);
  assert.deepEqual([quiet.pendingStart, quiet.pause, quiet.extension.online, quiet.extension.bridge, quiet.extension.login1688],
    [null, null, false, false, "unknown"]);
  assert.equal((await api.record(created.candidateId)).sourceCapture, undefined);
  await api.heartbeat();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await api.record(created.candidateId)).sourceCapture, undefined, "没有工作台页面递开始信号时也不排作业");
  assert.equal(api.stderr.join(""), "");
});

test("流水线：读货源页 → 1688 找同款 → Ozon 以图搜 → 粗算；1688 没登录不拦这件，之后的先跳过 1688，主人点「接着找」再补", async t => {
  const api = await startApi(t, []);
  await api.login();
  const first = (await api.post("/api/intake/links", { links: [PDD_A] })).body.items[0].candidateId;
  await api.heartbeat();

  await api.runSource(first, PDD_A, "合成宠物背心 狗狗衣服");
  const afterSource = await api.record(first);
  assert.equal(afterSource.intake.jobs.sourceCaptureId, afterSource.sourceCapture.captureId);
  assert.ok(afterSource.history.some(entry => entry.action === "intakeStepQueued"));
  await api.failMatch(first, "supplier_image_match", "site_login_required");
  const searching = await api.record(first);
  assert.deepEqual([searching.productName, searching.imageUrl, searching.supplierImageMatch.authorization.authorizedBy !== undefined],
    ["合成宠物背心 狗狗衣服", IMAGE("600000000001"), true]);
  assert.equal((await api.queue()).body.extension.login1688, "expired");
  const ozon = await api.failMatch(first, "ozon_image_match", "image_upload_unavailable");
  assert.equal((await api.record(first)).ozonImageMatch.searchBy, "image");
  assert.ok(ozon.captureId.startsWith("OMJ-"));
  const ready = await api.until("第一件找完", async () => {
    const current = await api.record(first);
    return current.intake.stage === "ready" ? current : null;
  });
  assert.deepEqual([ready.roughProfit.status, ready.roughProfit.assumed, ready.roughProfit.purchaseRmb, ready.roughProfit.purchaseBasis],
    ["incomplete", true, 15.08, "pinduoduo"]);
  assert.ok(ready.roughProfit.missing.includes("Ozon 售价"));
  assert.ok(ready.history.some(entry => entry.action === "intakeReady"));
  assert.deepEqual([ready.workflowStatus, ready.sourceCapture.selectedSkuIds, ready.sourceCapture.ownerSupplyConfirmed],
    ["awaiting_user_direction", [], false], "找同款、粗算都不替主人选规格、确认供货或推进阶段");

  // 1688 is known to be logged out: the next product skips that search instead of opening another 1688 tab.
  const second = (await api.post("/api/intake/links", { links: [PDD_B] })).body.items[0].candidateId;
  await api.runSource(second, PDD_B, "合成猫窝 冬季");
  await api.failMatch(second, "ozon_image_match", "image_upload_unavailable");
  const skipped = await api.until("第二件找完", async () => {
    const current = await api.record(second);
    return current.intake.stage === "ready" ? current : null;
  });
  assert.deepEqual([skipped.intake.skips.supplierMatch, skipped.supplierImageMatch], ["login_1688_required", undefined]);
  assert.ok(skipped.history.some(entry => entry.action === "intakeStepSkipped"));

  assert.equal((await api.post("/api/intake/resume", { anything: true })).body.code, "intake_resume_input_invalid");
  const resumed = await api.post("/api/intake/resume", {});
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
  assert.deepEqual(resumed.body.resumed.sort(), [first, second].sort());
  const queue = (await api.queue()).body;
  assert.equal(queue.extension.login1688, "unknown");
  const pending = await api.pending("supplier_image_match");
  assert.equal(pending.candidateId, first);
  const reopened = await api.record(first);
  assert.deepEqual([reopened.intake.stage, reopened.intake.lastRetry.step, typeof reopened.intake.resumedAt],
    ["searching_1688", "search_1688", "string"]);
  assert.equal((await api.post("/api/intake/resume", {})).body.code, "intake_nothing_to_resume");
  assert.equal(api.stderr.join(""), "");
});

test("停下：整页的事（滑块）整条队停着；主人点「重跑」只重排这一件那一步；不能重跑的说清楚；结果未知的重跑算主人知道了", async t => {
  const api = await startApi(t, [
    seededIntake("SLIDER", PDD_A, { index: 0, size: 2, jobs: { sourceCaptureId: "SCJ-seeded-slider" }, sourceCapture: { captureId: "SCJ-seeded-slider",
      status: "failed", jobStatus: "failed", failureCode: "site_verification_required", mode: "a_supplier_capture", sourceUrl: PDD_A } }),
    seededIntake("WAITING", PDD_B, { index: 1, size: 2 }),
    seededIntake("UNKNOWN", PDD_C, { submittedAt: "2026-10-10T04:00:00.000Z", jobs: { sourceCaptureId: "SCJ-seeded-unknown" },
      sourceCapture: { captureId: "SCJ-seeded-unknown", status: "failed", jobStatus: "unknown_outcome", failureCode: "unknown_outcome",
        mode: "a_supplier_capture", sourceUrl: PDD_C } }),
    seededIntake("DELISTED", OFFER, { submittedAt: "2026-10-10T03:00:00.000Z", jobs: { sourceCaptureId: "SCJ-seeded-delisted" },
      sourceCapture: { captureId: "SCJ-seeded-delisted", status: "captured_waiting_owner_selection", mode: "a_supplier_capture", sourceUrl: OFFER,
        offerStatus: "off_sale", mainImageUrl: IMAGE("x"), skuChoices: [{ sourceSkuId: "a", priceCny: 9, inStock: true }], priceRanges: [] } })
  ]);
  await api.login();
  await api.heartbeat();
  const paused = await api.until("整条队停下", queue => (queue.pause ? queue : null));
  assert.deepEqual([paused.pause.code, paused.pause.candidateId], ["slider_required", "SLIDER"]);
  assert.equal(paused.pendingStart, null, "整页停下时后面排着的也不开始");
  const byId = Object.fromEntries(paused.items.map(item => [item.candidateId, item]));
  assert.deepEqual([byId.DELISTED.blocker.code, byId.DELISTED.blocker.retryable, byId.UNKNOWN.blocker.code, byId.WAITING.stage],
    ["source_delisted", false, "unknown_outcome", "queued"]);
  // The first queue read after a restart wakes the pump, which writes the stage back onto the product.
  const stuck = await api.until("滑块那一件记成停下", async () => {
    const current = await api.record("SLIDER");
    return current.intake.stage === "blocked" ? current : null;
  });
  assert.deepEqual([stuck.intake.stage, stuck.intake.blocker.code], ["blocked", "slider_required"]);
  assert.ok(stuck.history.some(entry => entry.action === "intakeBlocked"));

  const retry = (id, body) => api.post(`/api/intake/${id}/retry`, body);
  assert.equal((await retry("SLIDER", { dataRevision: stuck.dataRevision, extra: 1 })).body.code, "intake_retry_input_invalid");
  assert.equal((await retry("SLIDER", { dataRevision: stuck.dataRevision - 1 })).body.code, "revision_conflict");
  const delisted = await api.record("DELISTED");
  assert.equal((await retry("DELISTED", { dataRevision: delisted.dataRevision })).body.code, "intake_not_retryable");
  const waiting = await api.record("WAITING");
  assert.equal((await retry("WAITING", { dataRevision: waiting.dataRevision })).body.code, "intake_not_blocked");

  const unknown = await api.record("UNKNOWN");
  const acknowledged = await retry("UNKNOWN", { dataRevision: unknown.dataRevision });
  assert.equal(acknowledged.status, 202, JSON.stringify(acknowledged.body));
  const settled = await api.record("UNKNOWN");
  assert.deepEqual([settled.sourceCapture.reviewedBy, settled.sourceCapture.acknowledgement, settled.intake.stage, settled.intake.jobs.sourceCaptureId],
    ["owner", "no_result_received", "queued", null]);
  assert.ok(settled.history.some(entry => entry.action === "aSupplierCaptureReviewed"));
  assert.equal((await api.queue()).body.pendingStart, null, "滑块那一件还停着，整条队照旧停着");

  const sliderRetry = await retry("SLIDER", { dataRevision: (await api.record("SLIDER")).dataRevision });
  assert.equal(sliderRetry.status, 202, JSON.stringify(sliderRetry.body));
  const next = await api.pending("supplier_capture");
  assert.equal(next.candidateId, "UNKNOWN", "重跑以后按贴进来的先后接着排，这一件最早");
  assert.equal((await api.queue()).body.pause, null);
  assert.equal(api.stderr.join(""), "");
});
