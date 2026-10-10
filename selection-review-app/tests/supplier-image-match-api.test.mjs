import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { allocatedTestPorts, stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { isImageMatchJob, isOzonImageMatchJob, validateImageMatchRequest, validateOzonImageMatchRequest } from "../extension/1688-capture/capture-request.js";
import { supplierImageMatchSearchUrl } from "../lib/supplier-image-match.mjs";
import { ozonSearchUrl } from "../lib/ozon-same-product-match.mjs";

// Every candidate, offer, title and picture address below is synthetic. The service is told not to fetch any picture.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = allocatedTestPorts();
const baseUrl = `http://127.0.0.1:${ports.api}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_PASSWORD = "synthetic password for bounded 1688 image search tests";
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";

const sku = (id, colour, priceCny) => ({ sourceSkuId: `pdd-sku-${id}`, propPath: `颜色:${colour}`, attributes: { 颜色: colour },
  priceCny, priceSource: "rawData.goods.skus.groupPrice", stock: 10, stockSource: "rawData.goods.skus.quantity", inStock: true,
  weight: null, weightSource: null, imageUrl: null });

function candidate(id, { mainImageUrl = IMAGE, ...extra } = {}) {
  return {
    id, source: "codex", group: "dandanshu", targetStore: "dandanshu", productName: `合成拼多多货源${id}`,
    productUrl: "unknown", sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001",
    workflowStatus: "needs_user_data", dataRevision: 1, comments: [], history: [],
    sourceCapture: {
      captureId: `SCJ-synthetic-${id}`, status: "captured_waiting_owner_selection", mode: "a_supplier_capture",
      jobId: `SCJ-synthetic-${id}`, jobStatus: "completed", attempt: 1, offerId: "600000000001",
      sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001", title: "合成背心",
      originalSourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001", requiredExtensionVersion: "1.4.0",
      offerStatus: "on_sale", observedAt: "2026-10-09T07:00:00.000Z", collectionMethod: "chrome_extension_structured_page_v1",
      titleSource: "rawData.goods.goodsName", offerIdSource: "rawData.goods.goodsID", pageSelectedSkuId: null, priceRanges: [],
      pageFields: { unitProductPriceCny: null, unitProductPriceSource: null, unitDomesticFreightCny: null, unitDomesticFreightSource: null },
      supplierAttributes: {}, suggestedSkuIds: [], matchTerms: [],
      mainImageUrl, mainImageSource: mainImageUrl ? "rawData.goods.topGallery[0]" : null,
      skuChoices: [sku("1", "卡其色", 18.9), sku("2", "黑色", 16.5)],
      selectedSkuIds: [], ownerSupplyConfirmed: false, writeOccurred: false, businessStateEffect: "unchanged"
    },
    createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", ...extra
  };
}

const document = candidates => ({
  meta: { version: 2, title: "test", updatedAt: "2026-10-09T00:00:00.000Z", automationStarted: false },
  rules: {}, candidates, dispatches: [], nodeDispatches: [], workflowComments: [], controlAlerts: [], evidencePacks: []
});

function item(index, extra = {}) {
  return { offerId: String(700000000000 + index), title: `合成同款 ${index}`, imageUrl: `https://cbu01.alicdn.com/img/ibank/O1CN01s${index}.jpg`,
    priceCny: 32.68, priceNote: "运费5元", quantityBegin: 1, saleQuantity: 120, shopName: "合成店铺", location: "浙江 金华",
    isAd: index === 1, superFactory: false, vendorSimilarity: 0.9 - index / 100, rank: index,
    loginId: "secret-login", memberId: "b2b-secret", eurl: "https://click.example/?token=secret", ...extra };
}
const evidence = (extra = {}) => ({ searchImageUrl: IMAGE, observedAt: "2026-10-09T08:00:00.000Z", cardCount: 60,
  items: [item(0), item(1), item(2)], ...extra });

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

async function startApi(t, candidates, { ttlMs = 2000, executionTtlMs = 500 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "image-match-api-"));
  const privateDirectory = path.join(directory, "private");
  const businessDirectory = path.join(directory, "business");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(businessDirectory);
  const file = path.join(businessDirectory, "candidates.json");
  await writeFile(file, JSON.stringify(document(candidates)));
  const stderr = [];
  let child = null;
  let cookie = "";
  t.after(async () => { if (child) await stopApiProcess(child); });
  const env = {
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
    SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS: String(ttlMs),
    SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS: String(executionTtlMs),
    SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
    SELECTION_REVIEW_IMAGE_FINGERPRINT_FETCH: "off"
  };
  async function start() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir, env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
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
  await start();
  const readDocument = async () => JSON.parse(await readFile(file, "utf8"));
  const record = async id => (await readDocument()).candidates.find(entry => entry.id === id);
  return {
    dataFile: file, stderr, post, readDocument, record,
    health: async () => (await (await fetch(`${baseUrl}/api/health`)).json()),
    async login() {
      const response = await post("/api/owner-access/setup", { password: OWNER_PASSWORD }, { authenticated: false });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      cookie = response.cookie.split(";")[0];
    },
    start: (id, body) => post(`/api/candidates/${encodeURIComponent(id)}/image-match/start`, body),
    claim: (jobId, version = "1.4.0") =>
      post(`/api/extension/capture-jobs/${jobId}/claim`, { version }, { authenticated: false, headers: { Origin: extensionOrigin } }),
    result: (id, body) => post(`/api/candidates/${encodeURIComponent(id)}/image-match/result`, body,
      { authenticated: false, headers: { Origin: extensionOrigin } }),
    compare: (id, body) => post(`/api/candidates/${encodeURIComponent(id)}/image-match/compare`, body),
    judge: (id, body) => post(`/api/candidates/${encodeURIComponent(id)}/image-match/judgement`, body),
    ozon: (id, action, body, options) => post(`/api/candidates/${encodeURIComponent(id)}/ozon-match/${action}`, body, options),
    async settled(id, status) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await record(id);
        if (current.supplierImageMatch?.status === status) return current;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`找同款记录没有到 ${status}`);
    },
    restart: async () => { await stopApiProcess(child); child = null; cookie = ""; await start(); }
  };
}

test("找同款：只有主人能发起，插件领取一次、回传核验过的结果，服务端比对首图，主人逐条判断，业务状态不动", async t => {
  const api = await startApi(t, [candidate("IMG-1"), candidate("IMG-NO-PICTURE", { mainImageUrl: null })]);
  const before = await readFile(api.dataFile, "utf8");
  const anonymous = await api.post("/api/candidates/IMG-1/image-match/start", { dataRevision: 1 }, { authenticated: false });
  assert.equal(anonymous.status, 401);
  assert.match(await readFile(path.join(appDir, "server.mjs"), "utf8"), /code: "image_match_owner_required"/u);
  await api.login();
  assert.equal((await api.start("IMG-1", { dataRevision: 1, sourceUrl: "x" })).body.code, "image_match_input_invalid");
  assert.equal((await api.start("IMG-1", { dataRevision: 1, acknowledgeUnknownOutcome: "yes" })).body.code, "image_match_input_invalid");
  assert.equal((await api.start("IMG-1", { dataRevision: 9 })).body.code, "revision_conflict");
  const noPicture = await api.start("IMG-NO-PICTURE", { dataRevision: 1 });
  assert.deepEqual([noPicture.status, noPicture.body.code], [422, "main_image_missing"]);
  assert.equal(await readFile(api.dataFile, "utf8"), before, "被拒绝的发起不得写入任何东西");

  const queued = await api.start("IMG-1", { dataRevision: 1 });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.status, "supplier_image_match_job_queued");
  const jobId = queued.body.captureJob.jobId;
  assert.match(jobId, /^IMJ-/);
  assert.equal(queued.body.captureJob.token, undefined, "页面回执不带一次性令牌");
  assert.deepEqual([queued.body.candidate.supplierImageMatch.status, queued.body.candidate.supplierImageMatch.authorization.maxSearches],
    ["waiting_extension", 1]);
  const health = await api.health();
  assert.deepEqual([health.captureControl.status, health.captureControl.captureKind, health.captureControl.candidateId], ["busy", "image_match", "IMG-1"]);
  const duplicate = await api.start("IMG-1", { dataRevision: 1 });
  assert.deepEqual([duplicate.status, duplicate.body.duplicate, duplicate.body.captureJob.jobId], [200, true, jobId]);
  assert.equal((await api.start("IMG-NO-PICTURE", { dataRevision: 1 })).status, 409, "全局采集控制被占用时不建第二个作业");

  assert.equal((await api.claim(jobId, "1.2.8")).body.code, "extension_version_mismatch");
  const claim = await api.claim(jobId);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const payload = claim.body.captureJob;
  assert.equal(isImageMatchJob(payload), true);
  assert.deepEqual(validateImageMatchRequest({ payload, manifestVersion: "1.4.0" }), { ok: true, imageUrl: IMAGE, searchUrl: supplierImageMatchSearchUrl(IMAGE) });
  assert.equal((await api.claim(jobId)).status, 409, "同一个作业不能被领取第二次");
  assert.equal((await api.record("IMG-1")).supplierImageMatch.status, "searching");

  const preflight = await fetch(`${baseUrl}/api/candidates/IMG-1/image-match/result`, { method: "OPTIONS", headers: { Origin: extensionOrigin } });
  assert.equal(preflight.status, 204);
  const base = { captureId: jobId, token: payload.token, dataRevision: payload.dataRevision };
  assert.equal((await api.result("IMG-1", { ...base, token: "wrong", status: "captured", evidence: evidence() })).status, 403);
  // An unrelated save while the search runs does not throw the result away.
  const document = await api.readDocument();
  document.candidates.find(entry => entry.id === "IMG-1").ownerNote = "synthetic unrelated edit";
  await writeFile(api.dataFile, JSON.stringify(document));
  const saved = await api.result("IMG-1", { ...base, status: "captured", evidence: evidence() });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await api.result("IMG-1", { ...base, status: "captured", evidence: evidence() })).status, 409, "结果只收一次");

  const compared = await api.settled("IMG-1", "compared");
  const match = compared.supplierImageMatch;
  assert.deepEqual(match.results.map(entry => [entry.offerId, entry.similarity, entry.compareError]),
    [["700000000000", "unknown", "source_image_unreadable"], ["700000000001", "unknown", "source_image_unreadable"],
      ["700000000002", "unknown", "source_image_unreadable"]]);
  assert.deepEqual([match.comparison.sourceFingerprint, match.comparison.sourceError], [null, "fetch_disabled"]);
  assert.equal(match.results[0].sourceUrl, "https://detail.1688.com/offer/700000000000.html");
  assert.deepEqual([match.businessStateEffect, match.writeOccurred], ["unchanged", false]);
  assert.equal(compared.sourceCapture.status, "captured_waiting_owner_selection");
  assert.deepEqual(compared.sourceCapture.selectedSkuIds, []);
  assert.equal(compared.workflowStatus, "needs_user_data");
  const stored = await readFile(api.dataFile, "utf8");
  for (const secret of ["secret-login", "b2b-secret", "click.example", payload.token]) assert.equal(stored.includes(secret), false, secret);
  assert.equal((await api.health()).captureControl.status, "idle");

  let revision = compared.dataRevision;
  const judge = body => api.judge("IMG-1", { dataRevision: revision, captureId: jobId, ...body });
  assert.equal((await judge({ offerId: "700000000000", judgement: "maybe" })).body.code, "image_match_judgement_invalid");
  assert.equal((await judge({ offerId: "799999999999", judgement: "exact" })).body.code, "image_match_offer_unknown");
  assert.equal((await api.judge("IMG-1", { dataRevision: revision, captureId: "IMJ-other", offerId: "700000000000", judgement: "exact" })).body.code,
    "image_match_not_current");
  const exact = await judge({ offerId: "700000000000", judgement: "exact" });
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.candidate.supplierImageMatch.judgements["700000000000"].judgement, "exact");
  assert.equal(exact.body.candidate.sourceCapture.ownerSupplyConfirmed, false, "同款判断不是供货确认");
  revision = exact.body.candidate.dataRevision;
  const near = await judge({ offerId: "700000000001", judgement: "near" });
  revision = near.body.candidate.dataRevision;
  const cleared = await judge({ offerId: "700000000001", judgement: "clear" });
  assert.deepEqual(Object.keys(cleared.body.candidate.supplierImageMatch.judgements), ["700000000000"]);
  revision = cleared.body.candidate.dataRevision;

  const again = await api.compare("IMG-1", { dataRevision: revision, captureId: jobId });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  const recompared = await api.settled("IMG-1", "compared");
  assert.equal(recompared.supplierImageMatch.judgements["700000000000"].judgement, "exact", "重新比对不动主人的判断");
  const history = recompared.history.map(entry => entry.action);
  for (const action of ["supplierImageMatchQueued", "supplierImageMatchResultsSaved", "supplierImageMatchCompared", "supplierImageMatchJudged"]) {
    assert.ok(history.includes(action), action);
  }

  // A new search keeps the judged result of the previous one in its history.
  const next = await api.start("IMG-1", { dataRevision: recompared.dataRevision });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  const nextRecord = next.body.candidate.supplierImageMatch;
  assert.equal(nextRecord.history[0].captureId, jobId);
  assert.deepEqual(nextRecord.history[0].results.map(entry => entry.offerId), ["700000000000"]);
  assert.deepEqual(nextRecord.results, []);
});

test("找同款失败如实停下：没登录、空页面、别的图、没领取、领取后没回传、服务重启，都不会说成没有同款", async t => {
  const api = await startApi(t, [candidate("IMG-2")], { ttlMs: 300, executionTtlMs: 300 });
  await api.login();
  let revision = 1;
  async function search() {
    const queued = await api.start("IMG-2", { dataRevision: revision });
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    const claim = await api.claim(queued.body.captureJob.jobId);
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    return claim.body.captureJob;
  }
  async function finish(payload, body) {
    const response = await api.result("IMG-2", { captureId: payload.captureId, token: payload.token, dataRevision: payload.dataRevision, ...body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    revision = response.body.candidate.dataRevision;
    return response.body.candidate.supplierImageMatch;
  }

  const login = await finish(await search(), { status: "failed", failureCode: "site_login_required" });
  assert.deepEqual([login.status, login.jobStatus, login.failureCode], ["failed", "failed", "site_login_required"]);
  assert.match(login.reason, /不能说明没有同款/);
  const empty = await finish(await search(), { status: "captured", evidence: evidence({ items: [], cardCount: 0 }) });
  assert.equal(empty.failureCode, "results_unverifiable");
  const other = await finish(await search(), { status: "captured",
    evidence: evidence({ searchImageUrl: "https://img.pddpic.com/garner-api-new/other.jpeg" }) });
  assert.equal(other.failureCode, "wrong_query");
  const made = await finish(await search(), { status: "failed", failureCode: "made_up_code" });
  assert.equal(made.failureCode, "system_error");

  // Queued and never claimed: closed as unclaimed by the lease timer.
  const unclaimed = await api.start("IMG-2", { dataRevision: revision });
  assert.equal(unclaimed.status, 202);
  const closed = await api.settled("IMG-2", "failed");
  assert.equal(closed.supplierImageMatch.failureCode, "extension_job_unclaimed");
  revision = closed.dataRevision;

  // Claimed and never answered: the outcome is unknown, and a new search needs the owner's acknowledgement first.
  const claimed = await search();
  assert.ok(claimed.captureId);
  let unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    unknown = await api.record("IMG-2");
    if (unknown.supplierImageMatch.jobStatus === "unknown_outcome") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(unknown.supplierImageMatch.failureCode, "unknown_outcome");
  revision = unknown.dataRevision;
  const refused = await api.start("IMG-2", { dataRevision: revision });
  assert.deepEqual([refused.status, refused.body.code], [409, "image_match_unknown_outcome"]);
  const acknowledged = await api.start("IMG-2", { dataRevision: revision, acknowledgeUnknownOutcome: true });
  assert.equal(acknowledged.status, 202, JSON.stringify(acknowledged.body));

  // A restart while it waits closes it as lost instead of leaving it waiting for good.
  await api.restart();
  const lost = await api.record("IMG-2");
  assert.deepEqual([lost.supplierImageMatch.status, lost.supplierImageMatch.failureCode], ["failed", "capture_job_lost"]);
  assert.equal(lost.sourceCapture.status, "captured_waiting_owner_selection");
});

test("找同款三个入口共用一条作业链：1688 货源用它自己的首图搜，结果里标出就是这一家；没有货源采集的 Ozon 商品用 Ozon 主图搜", async t => {
  const ALI_SOURCE = "https://detail.1688.com/offer/700000000001.html";
  const ALI_IMAGE = "https://cbu01.alicdn.com/img/ibank/O1CN01syntheticmain.jpg";
  const OZON_IMAGE = "https://ir.ozone.ru/s3/multimedia-1-d/wc1000/9000000001.jpg";
  const base = candidate("IMG-1688");
  const supplier = { ...base, productName: "合成1688货源", sourceUrl: ALI_SOURCE, sourceCapture: { ...base.sourceCapture,
    offerId: "700000000001", sourceUrl: ALI_SOURCE, originalSourceUrl: ALI_SOURCE, mainImageUrl: ALI_IMAGE,
    mainImageSource: "offerDetail.imageList[0]", titleSource: "offerDetail.subject", offerIdSource: "offerBaseInfo.offerId" } };
  const ozon = { ...candidate("IMG-OZON"), productName: "合成 Ozon 商品", sourceUrl: "", sourceCapture: null,
    productUrl: "https://www.ozon.ru/product/sinteticheskiy-zhilet-9000000001/", imageUrl: OZON_IMAGE };
  const api = await startApi(t, [supplier, ozon]);
  await api.login();

  async function searchOnce(id, imageUrl) {
    const queued = await api.start(id, { dataRevision: 1 });
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    const claim = await api.claim(queued.body.captureJob.jobId);
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const payload = claim.body.captureJob;
    assert.deepEqual(validateImageMatchRequest({ payload, manifestVersion: "1.4.0" }),
      { ok: true, imageUrl, searchUrl: supplierImageMatchSearchUrl(imageUrl) });
    const saved = await api.result(id, { captureId: payload.captureId, token: payload.token, dataRevision: payload.dataRevision,
      status: "captured", evidence: evidence({ searchImageUrl: imageUrl }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return api.settled(id, "compared");
  }

  const fromSupplier = await searchOnce("IMG-1688", ALI_IMAGE);
  assert.deepEqual([fromSupplier.supplierImageMatch.source.platform, fromSupplier.supplierImageMatch.source.offerId], ["1688", "700000000001"]);
  assert.deepEqual(fromSupplier.supplierImageMatch.results.map(entry => [entry.offerId, entry.isSourceOffer]),
    [["700000000000", false], ["700000000001", true], ["700000000002", false]]);
  assert.match(fromSupplier.history.find(entry => entry.action === "supplierImageMatchQueued").detail, /用1688 首图在 1688 找一次同款/);
  assert.equal(fromSupplier.sourceCapture.ownerSupplyConfirmed, false);

  const fromOzon = await searchOnce("IMG-OZON", OZON_IMAGE);
  assert.deepEqual([fromOzon.supplierImageMatch.source.platform, fromOzon.supplierImageMatch.source.offerId, fromOzon.supplierImageMatch.source.lowestPriceCny],
    ["ozon", "9000000001", null]);
  assert.ok(fromOzon.supplierImageMatch.results.every(entry => entry.isSourceOffer === false));
  assert.match(fromOzon.history.find(entry => entry.action === "supplierImageMatchResultsSaved").detail, /用Ozon 主图搜到 60 条/);
  assert.deepEqual([fromOzon.sourceCapture, fromOzon.workflowStatus], [null, "needs_user_data"]);
});

test("在 Ozon 找同款：主人填俄文词，插件在 Ozon 搜一次、回传核验过的结果，服务端比首图，主人逐条判断，业务状态不动", async t => {
  const QUERY = "синтетический жилет для кошки";
  const OZON_IMAGE = "https://ir.ozone.ru/s3/multimedia-1-d/wc1000/9000000001.jpg";
  const fromOzon = { ...candidate("OZ-OWN"), productName: "Синтетический жилет для кошки, тёплый", sourceUrl: "", sourceCapture: null,
    productUrl: "https://www.ozon.ru/product/sinteticheskiy-zhilet-9000000101/", imageUrl: OZON_IMAGE };
  const api = await startApi(t, [candidate("OZ-PDD"), fromOzon]);
  const before = await readFile(api.dataFile, "utf8");
  assert.equal((await api.ozon("OZ-PDD", "start", { dataRevision: 1, query: QUERY }, { authenticated: false })).status, 401);
  assert.match(await readFile(path.join(appDir, "server.mjs"), "utf8"), /code: "ozon_match_owner_required"/u);
  await api.login();
  assert.equal((await api.ozon("OZ-PDD", "start", { dataRevision: 1 })).body.code, "ozon_match_input_invalid");
  assert.equal((await api.ozon("OZ-PDD", "start", { dataRevision: 1, query: QUERY, imageUrl: OZON_IMAGE })).body.code, "ozon_match_input_invalid");
  const noWords = await api.ozon("OZ-PDD", "start", { dataRevision: 1, query: " 1 " });
  assert.deepEqual([noWords.status, noWords.body.code], [422, "ozon_search_query_invalid"]);
  assert.equal(await readFile(api.dataFile, "utf8"), before, "被拒绝的发起不得写入任何东西");

  const queued = await api.ozon("OZ-PDD", "start", { dataRevision: 1, query: QUERY });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.status, "ozon_image_match_job_queued");
  const jobId = queued.body.captureJob.jobId;
  assert.match(jobId, /^OMJ-/);
  assert.equal(queued.body.captureJob.token, undefined);
  const record = queued.body.candidate.ozonImageMatch;
  assert.deepEqual([record.status, record.query, record.queryOrigin, record.source.platform, record.searchUrl],
    ["waiting_extension", QUERY, "owner", "pinduoduo", ozonSearchUrl(QUERY)]);
  assert.equal(queued.body.candidate.supplierImageMatch ?? null, null, "Ozon 找同款不碰 1688 找同款的记录");
  const health = await api.health();
  assert.deepEqual([health.captureControl.status, health.captureControl.captureKind, health.captureControl.platform], ["busy", "ozon_image_match", "ozon"]);
  assert.equal((await api.start("OZ-PDD", { dataRevision: queued.body.candidate.dataRevision })).status, 409, "全局采集控制被占用时不建第二个作业");

  const claim = await api.claim(jobId);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const payload = claim.body.captureJob;
  assert.deepEqual([isOzonImageMatchJob(payload), isImageMatchJob(payload)], [true, false]);
  assert.deepEqual(validateOzonImageMatchRequest({ payload, manifestVersion: "1.4.0" }), { ok: true, query: QUERY, searchUrl: ozonSearchUrl(QUERY) });
  const item = (index, extra = {}) => ({ productId: String(9000000100 + index), title: `Синтетический жилет ${index}`,
    imageUrl: `https://ir.ozone.ru/s3/multimedia-1-z/wc500/${9000000100 + index}.jpg`, priceRub: 1299, originalPriceRub: 2599, rating: 4.8,
    reviewCount: 12, isAd: false, rank: index, trackingInfo: { key: "secret-tracking" }, ...extra });
  const result = body => api.ozon("OZ-PDD", "result", { captureId: jobId, token: payload.token, dataRevision: payload.dataRevision, ...body },
    { authenticated: false, headers: { Origin: extensionOrigin } });
  const saved = await result({ status: "captured", evidence: { query: QUERY, observedAt: "2026-10-10T08:00:00.000Z", cardCount: 36,
    readFrom: "state", items: [item(0), item(1, { isAd: true })] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const compared = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await api.record("OZ-PDD");
      if (current.ozonImageMatch?.status === "compared") return current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Ozon 找同款没有比完");
  })();
  const match = compared.ozonImageMatch;
  assert.deepEqual(match.results.map(entry => [entry.productId, entry.sourceUrl, entry.similarity, entry.isAd]),
    [["9000000100", "https://www.ozon.ru/product/9000000100/", "unknown", false], ["9000000101", "https://www.ozon.ru/product/9000000101/", "unknown", true]]);
  assert.equal((await readFile(api.dataFile, "utf8")).includes("secret-tracking"), false);
  assert.match(compared.history.find(entry => entry.action === "ozonImageMatchResultsSaved").detail, /用「синтетический жилет для кошки」搜到 36 条/);
  assert.equal(compared.sourceCapture.status, "captured_waiting_owner_selection");
  assert.equal(compared.workflowStatus, "needs_user_data");

  const judged = await api.ozon("OZ-PDD", "judgement", { dataRevision: compared.dataRevision, captureId: jobId, productId: "9000000101", judgement: "exact" });
  assert.equal(judged.status, 200, JSON.stringify(judged.body));
  assert.equal(judged.body.candidate.ozonImageMatch.judgements["9000000101"].judgement, "exact");
  assert.equal((await api.ozon("OZ-PDD", "judgement", { dataRevision: judged.body.candidate.dataRevision, captureId: jobId, offerId: "9000000101",
    judgement: "exact" })).body.code, "ozon_match_input_invalid");
  assert.equal((await api.ozon("OZ-PDD", "judgement", { dataRevision: judged.body.candidate.dataRevision, captureId: jobId, productId: "9999999999",
    judgement: "exact" })).body.code, "ozon_match_product_unknown");
  assert.match(judged.body.candidate.history.at(-1).detail, /主人把 Ozon 商品 9000000101 判断为「是同款」/);

  // A product that came from Ozon searches with its own Ozon picture, and finds itself marked as itself.
  const own = await api.ozon("OZ-OWN", "start", { dataRevision: 1, query: "Синтетический жилет для кошки" });
  assert.equal(own.status, 202, JSON.stringify(own.body));
  assert.deepEqual([own.body.candidate.ozonImageMatch.source.platform, own.body.candidate.ozonImageMatch.queryOrigin], ["ozon", "ozon_title"]);
  const ownClaim = (await api.claim(own.body.captureJob.jobId)).body.captureJob;
  const ownSaved = await api.ozon("OZ-OWN", "result", { captureId: ownClaim.captureId, token: ownClaim.token, dataRevision: ownClaim.dataRevision,
    status: "captured", evidence: { query: "Синтетический жилет для кошки", observedAt: "2026-10-10T08:00:00.000Z", cardCount: 2, readFrom: "dom",
      items: [item(0), item(1)] } }, { authenticated: false, headers: { Origin: extensionOrigin } });
  assert.deepEqual(ownSaved.body.candidate.ozonImageMatch.results.map(entry => entry.isSourceProduct), [false, true]);

  // A search that found nothing says these words found nothing, never that there is no same product.
  await new Promise(resolve => setTimeout(resolve, 100));
  const latest = await api.record("OZ-PDD");
  const again = await api.ozon("OZ-PDD", "start", { dataRevision: latest.dataRevision, query: "другие слова" });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  const againClaim = (await api.claim(again.body.captureJob.jobId)).body.captureJob;
  const empty = await api.ozon("OZ-PDD", "result", { captureId: againClaim.captureId, token: againClaim.token, dataRevision: againClaim.dataRevision,
    status: "failed", failureCode: "results_empty" }, { authenticated: false, headers: { Origin: extensionOrigin } });
  assert.equal(empty.body.candidate.ozonImageMatch.failureCode, "results_empty");
  assert.match(empty.body.candidate.ozonImageMatch.reason, /不能说明 Ozon 上没有同款/);
  assert.deepEqual(empty.body.candidate.ozonImageMatch.history[0].results.map(entry => entry.productId), ["9000000101"]);
});
