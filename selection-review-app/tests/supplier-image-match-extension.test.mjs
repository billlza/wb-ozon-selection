import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect1688ImageSearchPage } from "../extension/1688-capture/collector-1688-image-search.js";
import { IMAGE_MATCH_REQUEST_TYPE, isImageMatchJob, isOzonCaptureJob, validateCaptureStartSignal, validateImageMatchRequest,
  validateSupplierCaptureRequest } from "../extension/1688-capture/capture-request.js";
import { canonicalImageSearchSourceUrl as extensionSearchImageUrl, canonicalPinduoduoImageUrl as extensionImageUrl,
  classify1688ImageSearchNavigation, imageSearchResultPage, imageSearchUrl } from "../extension/1688-capture/source-routing.js";
import { canonicalImageSearchSourceUrl as serviceSearchImageUrl, canonicalPinduoduoImageUrl as serviceImageUrl } from "../lib/capture-evidence-sanitization.mjs";
import { sanitizeSupplierImageMatchEvidence, supplierImageMatchJobPayload, supplierImageMatchSearchUrl } from "../lib/supplier-image-match.mjs";
import { SENDER, harness, idle, startCapture, supplierJob } from "./helpers/extension-runtime-fixture.mjs";

// Every id, title, shop and picture address below is synthetic; no saved 1688 page and no network is used.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";
const SEARCH = supplierImageMatchSearchUrl(IMAGE);
const ALI_IMAGE = "https://cbu01.alicdn.com/img/ibank/O1CN01syntheticmain.jpg";
const OZON_IMAGE = "https://ir.ozone.ru/s3/multimedia-1-d/wc1000/9000000001.jpg";
const RESULTS = "https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&searchSession=synthetic";

const imageJob = (extra = {}) => ({
  ...supplierImageMatchJobPayload({ captureId: "IMJ-synthetic", candidateId: "candidate:synthetic", dataRevision: 5,
    imageUrl: IMAGE, searchUrl: SEARCH, requiredExtensionVersion: "1.3.0", attempt: 1, token: "synthetic-fixture-token" }),
  ...extra
});

test("the extension builds the same search address and accepts the same first pictures as the service", () => {
  const inputs = [IMAGE, `${IMAGE}?imageMogr2/thumbnail/750`, "https://t00img.yangkeduo.com/goods/a.jpeg", "https://pddpic.com/a.png",
    "http://img.pddpic.com/a.jpeg", "https://img.pddpic.com:444/a.jpeg", "https://user@img.pddpic.com/a.jpeg",
    "https://img.pddpic.com.evil.example/a.jpeg", "https://cbu01.alicdn.com/img/ibank/a.jpg", ALI_IMAGE, `${ALI_IMAGE}?x=1`,
    "https://alicdn.com/a.jpg", "https://cbu01.alicdn.com.evil.example/a.jpg", OZON_IMAGE, `${OZON_IMAGE}?w=1`,
    "https://cdn1.ozone.ru/s3/a.jpg", "https://evil-ir.ozone.ru/a.jpg", "http://ir.ozone.ru/a.jpg", "", null, 7];
  for (const input of inputs) {
    assert.equal(extensionImageUrl(input), serviceImageUrl(input), String(input));
    assert.equal(extensionSearchImageUrl(input), serviceSearchImageUrl(input), String(input));
    assert.equal(imageSearchUrl(input), supplierImageMatchSearchUrl(input), String(input));
  }
  for (const accepted of [ALI_IMAGE, OZON_IMAGE]) assert.ok(imageSearchUrl(accepted), accepted);
  assert.equal(SEARCH, "https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=https%3A%2F%2Fimg.pddpic.com%2Fgarner-api-new%2Fsynthetic-main.jpeg");
});

test("an image-search tab is read only on the air.1688.com result page; login, verification and other pages stop it", () => {
  const cases = {
    [SEARCH]: "entry",
    [RESULTS]: "results",
    "https://air.1688.com/kapp/1688-global/sales/search?tab=imageSearch&imageId=1": "results",
    "https://air.1688.com/kapp/1688-search/pc-image-search": "results",
    "https://login.1688.com/member/signin.htm?Done=x": "login_required",
    "https://air.1688.com/login/": "login_required",
    "https://punish.1688.com/punish?x=1": "verification_required",
    "https://air.1688.com/kapp/other-app/": "non_whitelisted_destination",
    "https://detail.1688.com/offer/123456789.html": "non_whitelisted_destination",
    "https://www.taobao.com/": "non_whitelisted_destination",
    "http://air.1688.com/kapp/1688-search/pc-image-search/": "invalid",
    "not a url": "invalid"
  };
  for (const [address, expected] of Object.entries(cases)) assert.equal(classify1688ImageSearchNavigation(address), expected, address);
  assert.equal(imageSearchResultPage(RESULTS), "https://air.1688.com/kapp/1688-search/pc-image-search");
  assert.equal(imageSearchResultPage(SEARCH), null);
});

test("an image-match job is told apart from the other two jobs and validated on its own fields", () => {
  const job = imageJob();
  assert.equal(isImageMatchJob(job), true);
  assert.equal(isOzonCaptureJob(job), false);
  assert.equal(validateSupplierCaptureRequest({ payload: job, manifestVersion: "1.3.0" }).ok, false);
  assert.deepEqual(validateImageMatchRequest({ payload: job, manifestVersion: "1.3.0" }), { ok: true, imageUrl: IMAGE, searchUrl: SEARCH });
  const code = (extra, version = "1.3.0") => validateImageMatchRequest({ payload: imageJob(extra), manifestVersion: version }).code;
  assert.equal(code({}, "1.2.8"), "extension_version_mismatch");
  assert.equal(code({ attempt: 0 }), "attempt_invalid");
  assert.equal(code({ dataRevision: "5" }), "revision_invalid");
  assert.equal(code({ token: "" }), "request_payload_missing");
  assert.equal(code({ maxResults: 60 }), "request_payload_missing");
  assert.equal(code({ sourceUrl: "https://detail.1688.com/offer/123456789.html" }), "capture_mode_invalid");
  assert.equal(code({ productUrl: "https://www.ozon.ru/product/1234567/" }), "capture_mode_invalid");
  assert.equal(code({ imageUrl: `${IMAGE}?x=1` }), "image_url_invalid");
  assert.equal(code({ searchUrl: `${SEARCH}&extra=1` }), "image_url_invalid");
  assert.equal(code({ searchUrl: "https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=https%3A%2F%2Fimg.pddpic.com%2Fother.jpeg" }), "image_url_invalid");
  assert.equal(validateCaptureStartSignal({ type: IMAGE_MATCH_REQUEST_TYPE, captureId: "IMJ-synthetic" }).ok, true);
  for (const picture of [ALI_IMAGE, OZON_IMAGE]) {
    const search = supplierImageMatchSearchUrl(picture);
    assert.deepEqual(validateImageMatchRequest({ payload: imageJob({ imageUrl: picture, searchUrl: search }), manifestVersion: "1.3.0" }),
      { ok: true, imageUrl: picture, searchUrl: search });
  }
  assert.equal(code({ imageUrl: "https://example.com/a.jpg", searchUrl: supplierImageMatchSearchUrl("https://example.com/a.jpg") }), "image_url_invalid");
});

test("the page bridge forwards the image-match start signal and answers on its own receipt channel", async () => {
  const bridge = await readFile(path.join(appDir, "extension", "1688-capture", "bridge.js"), "utf8");
  assert.match(bridge, /SELECTION_REVIEW_1688_IMAGE_MATCH_REQUEST: "SELECTION_REVIEW_1688_IMAGE_MATCH_ACK"/);
});

function resultRequest(calls) {
  return calls.requests.find(request => /\/result$/.test(request.url));
}

test("one search: the extension opens the search address, reads the result page once and reports to the image-match route", async () => {
  const evidence = { searchImageUrl: IMAGE, observedAt: "2026-10-09T08:00:00.000Z", cardCount: 60, items: [{ offerId: "700000000001" }] };
  const { runtime, calls } = harness({ job: imageJob(), destination: RESULTS,
    execute: () => [{ result: { status: "captured", evidence } }] });
  const ack = await startCapture(runtime, "IMJ-synthetic", IMAGE_MATCH_REQUEST_TYPE);
  assert.deepEqual(ack, { accepted: true, claimedCaptureId: "IMJ-synthetic" });
  await idle(runtime);
  assert.deepEqual(calls.created, [{ url: SEARCH, active: false }]);
  assert.equal(calls.executions.length, 1);
  assert.equal(calls.executions[0].func, collect1688ImageSearchPage);
  assert.deepEqual(calls.executions[0].args, [IMAGE, 20]);
  assert.equal(calls.executions[0].world, "ISOLATED");
  const report = resultRequest(calls);
  assert.equal(report.url, "http://127.0.0.1:4317/api/candidates/candidate%3Asynthetic/image-match/result");
  assert.deepEqual(report.body, { captureId: "IMJ-synthetic", token: "synthetic-fixture-token", dataRevision: 5, status: "captured", evidence });
  assert.deepEqual(calls.removed, [7]);
});

test("a search that lands on login, verification, another page or another picture stops with its reason and reads nothing", async () => {
  const cases = [
    ["https://login.1688.com/member/signin.htm", "site_login_required"],
    ["https://punish.1688.com/punish", "site_verification_required"],
    ["https://detail.1688.com/offer/123456789.html", "navigation_rejected"]
  ];
  for (const [destination, failureCode] of cases) {
    const { runtime, calls } = harness({ job: imageJob(), destination });
    await startCapture(runtime, "IMJ-synthetic", IMAGE_MATCH_REQUEST_TYPE);
    await idle(runtime);
    assert.equal(calls.executions.length, 0, destination);
    assert.equal(resultRequest(calls).body.status, "failed");
    assert.equal(resultRequest(calls).body.failureCode, failureCode, destination);
  }
  const other = { searchImageUrl: "https://img.pddpic.com/garner-api-new/other.jpeg", observedAt: "2026-10-09T08:00:00.000Z", cardCount: 1, items: [] };
  const { runtime, calls } = harness({ job: imageJob(), destination: RESULTS, execute: () => [{ result: { status: "captured", evidence: other } }] });
  await startCapture(runtime, "IMJ-synthetic", IMAGE_MATCH_REQUEST_TYPE);
  await idle(runtime);
  assert.equal(resultRequest(calls).body.failureCode, "wrong_query");
  const empty = harness({ job: imageJob(), destination: RESULTS, execute: () => [{ result: { status: "failed", failureCode: "results_unverifiable" } }] });
  await startCapture(empty.runtime, "IMJ-synthetic", IMAGE_MATCH_REQUEST_TYPE);
  await idle(empty.runtime);
  assert.equal(resultRequest(empty.calls).body.failureCode, "results_unverifiable");
});

test("a start signal only starts its own kind of job", async () => {
  const wrongKind = harness({ job: imageJob() });
  assert.deepEqual(await startCapture(wrongKind.runtime, "IMJ-synthetic"), { accepted: false, code: "capture_job_invalid" });
  assert.equal(wrongKind.calls.created.length, 0);
  const supplier = harness({ job: supplierJob({ captureId: "IMJ-synthetic" }) });
  assert.deepEqual(await startCapture(supplier.runtime, "IMJ-synthetic", IMAGE_MATCH_REQUEST_TYPE), { accepted: false, code: "capture_job_invalid" });
  assert.equal(supplier.calls.created.length, 0);
  assert.equal(SENDER.url, "http://127.0.0.1:4317/");
});

// ---- the collector, on a synthetic result page ----

const escape = value => JSON.stringify(value);
function card(index, offerId, fields = {}, { cos = null, query = IMAGE, member = "b2b-2200000000001", shape = "plain" } = {}) {
  const props = { offerId, title: `合成<font color="red">同款</font> ${index}`, offerUrl: `https://dj.1688.com/ci_bb?a=${index}&eurl=secret`,
    offerPicUrl: `//cbu01.alicdn.com/img/ibank/O1CN01synthetic${index}.jpg?w=220`, imgUrl: "https://cbu01.alicdn.com/thumb.jpg",
    priceInfo: { price: "32.68", priceType: "normal", priceDescription: "运费5元" }, priceDesc: [{ showText: "2件起批" }],
    saleQuantity: "1.2万+", shopName: "合成店铺", province: "浙江", city: "金华", isAd: false, superFactory: false,
    loginId: "secret-login-id", memberId: member, sessionId: "secret-session", eurl: "https://click.example/?token=secret",
    expoStr: "secret-expo", ...fields };
  // "sp_expo": the shape on the owner's saved page — @-named segments, and inside sp_expo_data ;-separated fields with
  // query_url encoded once and the scores as an encoded object.
  const report = shape === "sp_expo"
    ? ["sessionId@secret-session", "traceId@secret-trace", `sp_expo_data@offerId:${offerId};query_url:${encodeURIComponent(query)};` +
      `queryEngine:cbu_picture;relevanceScores:${encodeURIComponent(JSON.stringify(cos === null ? { other: 1 } : { cosScore: cos, other: 1 }))};` +
      "imageSessionId:secret-image-session", "serverTrackId@secret-track"].join("^")
    : [`query_url:${encodeURIComponent(encodeURIComponent(query))}`, "simScore:0.5",
      ...(cos === null ? [] : [`relevanceScores:{"cosScore":${cos},"other":1}`]), "sessionId:secret-session"].join("^");
  const attributes = { "data-renderkey": `1_${index}_normal_${member}_${offerId}`, "data-index": String(index),
    "data-ftk-fiber-props": escape(props), "data-aplus-report": report };
  return { getAttribute: name => attributes[name] ?? null, hasAttribute: name => Object.hasOwn(attributes, name), querySelector: () => null };
}

async function onPage(cards, { bodyText = "", blocker = null, href = RESULTS, expected = IMAGE } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, now: Date.now };
  let reading = previous.now();
  Date.now = () => (reading += 30_000); // Each wait in the collector ends at once instead of after seconds.
  globalThis.window = { location: { href } };
  globalThis.document = {
    body: { innerText: bodyText },
    querySelector: selector => (blocker && selector.includes(blocker) ? {} : null),
    querySelectorAll: selector => (selector === "[data-renderkey]" ? cards : [])
  };
  try { return await collect1688ImageSearchPage(expected, 20); }
  finally { globalThis.window = previous.window; globalThis.document = previous.document; Date.now = previous.now; }
}

test("the collector keeps only product facts, most similar first, and never the account, session or ad-click fields", async () => {
  const cards = [
    card(0, "700000000000", {}, { cos: 0.71 }),
    card(1, "700000000001", { isAd: true, type: "fm" }, { cos: 0.98 }),
    card(2, "700000000002", { priceInfo: { price: "abc" }, saleQuantity: 88, priceDesc: [] , quantityPrices: [{ quantity: "≥3件", price: "30" }] }, { cos: 0.85 }),
    card(3, "700000000000", {}, { cos: 0.99 }), // a duplicate of the first card (a hover clone) is read once
    card(4, "700000000004", { offerId: "799999999999" }, { cos: 0.9 }), // props that name another offer are not this card
    ...Array.from({ length: 30 }, (_, extra) => card(5 + extra, String(710000000000 + extra), {}, { cos: null }))
  ];
  const result = await onPage(cards);
  assert.equal(result.status, "captured", JSON.stringify(result));
  const { evidence } = result;
  assert.equal(evidence.searchImageUrl, IMAGE);
  assert.equal(evidence.cardCount, 34);
  assert.equal(evidence.items.length, 20);
  assert.deepEqual(evidence.items.slice(0, 4).map(item => [item.offerId, item.vendorSimilarity, item.rank]),
    [["700000000001", 0.98, 1], ["700000000002", 0.85, 2], ["700000000000", 0.71, 0], ["710000000000", null, 5]]);
  const [ad, noPrice, first] = evidence.items;
  assert.deepEqual([ad.isAd, ad.title, ad.imageUrl, ad.priceCny, ad.priceNote, ad.quantityBegin, ad.saleQuantity, ad.shopName, ad.location],
    [true, "合成 同款 1", "https://cbu01.alicdn.com/img/ibank/O1CN01synthetic1.jpg", 32.68, "运费5元", 2, 12000, "合成店铺", "浙江 金华"]);
  assert.deepEqual([noPrice.priceCny, noPrice.quantityBegin, noPrice.saleQuantity], [null, 3, 88]);
  assert.equal(first.isAd, false);
  const text = JSON.stringify(evidence);
  for (const secret of ["secret", "b2b-2200000000001", "dj.1688.com", "eurl", "loginId", "memberId"]) assert.equal(text.includes(secret), false, secret);
  // What the collector reads is exactly what the service accepts.
  const accepted = sanitizeSupplierImageMatchEvidence(evidence, IMAGE);
  assert.equal(accepted.items.length, 20);
  assert.equal(accepted.items[0].sourceUrl, "https://detail.1688.com/offer/700000000001.html");
});

test("on the saved-page report shape the searched picture ends at the next ; and the encoded score is read", async () => {
  const sp = { shape: "sp_expo" };
  const result = await onPage([card(0, "700000000000", {}, { ...sp, cos: 0.95 }), card(1, "700000000001", {}, { ...sp, cos: 0.46 }),
    card(2, "700000000002", {}, { ...sp })]);
  assert.equal(result.status, "captured", JSON.stringify(result));
  assert.equal(result.evidence.searchImageUrl, IMAGE);
  assert.deepEqual(result.evidence.items.map(item => [item.offerId, item.vendorSimilarity]),
    [["700000000000", 0.95], ["700000000001", 0.46], ["700000000002", null]]);
  assert.equal(JSON.stringify(result.evidence).includes("secret"), false);
  assert.deepEqual(await onPage([card(0, "700000000000", {}, { ...sp, query: "https://img.pddpic.com/garner-api-new/other.jpeg" })]),
    { status: "failed", failureCode: "wrong_query" });
});

test("a search run with a 1688 or an Ozon picture is read the same way, and the echoed picture must still be that one", async () => {
  for (const picture of [ALI_IMAGE, OZON_IMAGE]) {
    const sp = { shape: "sp_expo", query: picture };
    const result = await onPage([card(0, "700000000000", {}, { ...sp, cos: 0.97 }), card(1, "700000000001", {}, { ...sp, cos: 0.41 })],
      { expected: picture });
    assert.equal(result.status, "captured", JSON.stringify(result));
    assert.equal(result.evidence.searchImageUrl, picture);
    assert.equal(sanitizeSupplierImageMatchEvidence(result.evidence, picture).items.length, 2);
    const plain = await onPage([card(0, "700000000000", {}, { query: picture })], { expected: picture });
    assert.equal(plain.evidence.searchImageUrl, picture);
  }
  assert.deepEqual(await onPage([card(0, "700000000000", {}, { shape: "sp_expo", query: OZON_IMAGE })], { expected: ALI_IMAGE }),
    { status: "failed", failureCode: "wrong_query" });
  assert.deepEqual(await onPage([card(0, "700000000000", {}, { query: "https://example.com/a.jpg" })], { expected: OZON_IMAGE }),
    { status: "failed", failureCode: "structured_data_unavailable" });
});

test("the collector refuses another picture, an unreadable page and an empty page, and never calls an empty page no match", async () => {
  assert.deepEqual(await onPage([card(0, "700000000000", {}, { query: "https://img.pddpic.com/garner-api-new/other.jpeg" })]),
    { status: "failed", failureCode: "wrong_query" });
  assert.deepEqual(await onPage([card(0, "700000000000"), card(1, "700000000001", {}, { query: "https://img.pddpic.com/x.jpeg" })]),
    { status: "failed", failureCode: "wrong_query" });
  assert.deepEqual(await onPage([], { bodyText: "No search results" }), { status: "failed", failureCode: "results_unverifiable" });
  assert.deepEqual(await onPage([]), { status: "failed", failureCode: "results_unverifiable" });
  assert.deepEqual(await onPage([card(0, "700000000000")], { blocker: "punish" }), { status: "failed", failureCode: "site_verification_required" });
  assert.deepEqual(await onPage([card(0, "700000000000")], { blocker: "login.1688.com" }), { status: "failed", failureCode: "site_login_required" });
  const broken = card(0, "700000000000");
  const unreadable = { ...broken, getAttribute: name => (name === "data-ftk-fiber-props" ? "{not json" : broken.getAttribute(name)) };
  assert.deepEqual(await onPage([unreadable]), { status: "failed", failureCode: "structured_data_unavailable" });
  // Without an echo on the cards, the search address on the page itself names the picture.
  const silent = card(0, "700000000000");
  const noEcho = { ...silent, getAttribute: name => (name === "data-aplus-report" ? "simScore:0.5" : silent.getAttribute(name)) };
  assert.equal((await onPage([noEcho], { href: `${RESULTS}&imageAddress=${encodeURIComponent(IMAGE)}` })).status, "captured");
  assert.deepEqual(await onPage([noEcho]), { status: "failed", failureCode: "structured_data_unavailable" });
});
