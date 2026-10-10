import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectOzonSearchPage } from "../extension/1688-capture/collector-ozon-search.js";
import { uploadOzonSearchImage } from "../extension/1688-capture/uploader-ozon-image-search.js";
import { OZON_IMAGE_MATCH_REQUEST_TYPE, isImageMatchJob, isOzonCaptureJob, isOzonImageMatchJob, isOzonImageSearchJob, validateCaptureStartSignal,
  validateImageMatchRequest, validateOzonImageMatchRequest } from "../extension/1688-capture/capture-request.js";
import { classifyOzonImageSearchNavigation, classifyOzonSearchNavigation, ozonImageSearchId as extensionImageSearchId,
  ozonImageSearchResultPage, ozonSearchResultPage } from "../extension/1688-capture/source-routing.js";
import { OZON_IMAGE_SEARCH_ENTRY_URL, ozonImageMatchJobPayload, ozonImageSearchId, ozonSearchUrl,
  sanitizeOzonImageMatchEvidence } from "../lib/ozon-same-product-match.mjs";
import { SYNTHETIC_OZON_IMAGE_ID as IMAGE_ID, SYNTHETIC_OZON_IMAGE_SEARCH_HTML, SYNTHETIC_OZON_IMAGE_SEARCH_STATE, SYNTHETIC_OZON_QUERY as QUERY,
  SYNTHETIC_OZON_SEARCH_HTML, SYNTHETIC_OZON_SEARCH_STATE } from "./fixtures/ozon-search-state-fixture.mjs";
import { harness, idle, startCapture, supplierJob } from "./helpers/extension-runtime-fixture.mjs";
import { inspectSavedOzonSearchPage } from "../scripts/check-ozon-search-saved-page.mjs";

// Every word, id, price and picture address below is synthetic; no saved Ozon page and no network is used.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH = ozonSearchUrl(QUERY);
const CATEGORY = `https://www.ozon.ru/category/odezhda-dlya-koshek-12345/?category_was_predicted=true&from_global=true&text=${encodeURIComponent(QUERY)}`;
const ozonJob = (extra = {}) => ({
  ...ozonImageMatchJobPayload({ captureId: "OMJ-synthetic", candidateId: "candidate:synthetic", dataRevision: 5, query: QUERY,
    searchUrl: SEARCH, requiredExtensionVersion: "1.4.0", attempt: 1, token: "synthetic-fixture-token" }),
  ...extra
});

test("an Ozon search tab is read on the search page or the category page Ozon moves it to, only while the words are the same", () => {
  const cases = {
    [SEARCH]: "results",
    [CATEGORY]: "results",
    [`https://www.ozon.ru/search/?text=${encodeURIComponent(QUERY.toUpperCase())}`]: "results",
    "https://www.ozon.ru/search/?text=%D0%B4%D1%80%D1%83%D0%B3%D0%BE%D0%B5": "other_search",
    "https://www.ozon.ru/search/": "other_search",
    "https://www.ozon.ru/product/sinteticheskiy-zhilet-90000101/": "non_whitelisted_destination",
    "https://www.ozon.ru/abt/result?x=1": "verification_required",
    "https://ozon.ru/search/?text=x": "non_whitelisted_destination",
    "https://www.ozon.ru.evil.example/search/?text=x": "non_whitelisted_destination",
    "http://www.ozon.ru/search/?text=x": "invalid",
    "not a url": "invalid"
  };
  for (const [address, expected] of Object.entries(cases)) assert.equal(classifyOzonSearchNavigation(address, QUERY), expected, address);
  assert.equal(ozonSearchResultPage(CATEGORY, QUERY), `https://www.ozon.ru/category/odezhda-dlya-koshek-12345/?text=${encodeURIComponent(QUERY)}`);
  assert.equal(ozonSearchResultPage(SEARCH, "другое"), null);
});

test("an Ozon search job is told apart from the other jobs and validated on its own fields", () => {
  const job = ozonJob();
  assert.deepEqual([isOzonImageMatchJob(job), isImageMatchJob(job), isOzonCaptureJob(job)], [true, false, false]);
  assert.equal(validateImageMatchRequest({ payload: job, manifestVersion: "1.4.0" }).ok, false);
  assert.deepEqual(validateOzonImageMatchRequest({ payload: job, manifestVersion: "1.4.0" }), { ok: true, searchBy: "text", query: QUERY, searchUrl: SEARCH });
  assert.equal(isOzonImageSearchJob(job), false);
  const code = (extra, version = "1.4.0") => validateOzonImageMatchRequest({ payload: ozonJob(extra), manifestVersion: version }).code;
  assert.equal(code({}, "1.3.0"), "extension_version_mismatch");
  assert.equal(code({ attempt: 0 }), "attempt_invalid");
  assert.equal(code({ maxResults: 20 }), "request_payload_missing");
  assert.equal(code({ imageUrl: "https://ir.ozone.ru/s3/a.jpg" }), "capture_mode_invalid");
  assert.equal(code({ productUrl: "https://www.ozon.ru/product/1234567/" }), "capture_mode_invalid");
  assert.equal(code({ query: ` ${QUERY}` }), "search_query_invalid");
  assert.equal(code({ searchUrl: `${SEARCH}&sorting=price` }), "search_query_invalid");
  assert.equal(code({ query: "другое", searchUrl: SEARCH }), "search_query_invalid");
  assert.equal(code({ searchBy: undefined }), "capture_mode_invalid");
  assert.equal(code({ searchBy: "photo" }), "capture_mode_invalid");
  assert.equal(validateCaptureStartSignal({ type: OZON_IMAGE_MATCH_REQUEST_TYPE, captureId: "OMJ-synthetic" }).ok, true);
});

test("the page bridge forwards the Ozon search start signal, and the extension may open Ozon search pages", async () => {
  const bridge = await readFile(path.join(appDir, "extension", "1688-capture", "bridge.js"), "utf8");
  assert.match(bridge, /SELECTION_REVIEW_OZON_IMAGE_MATCH_REQUEST: "SELECTION_REVIEW_OZON_IMAGE_MATCH_ACK"/);
  const manifest = JSON.parse(await readFile(path.join(appDir, "extension", "1688-capture", "manifest.json"), "utf8"));
  for (const host of ["https://www.ozon.ru/search/*", "https://www.ozon.ru/category/*"]) assert.ok(manifest.host_permissions.includes(host), host);
});

const resultRequest = calls => calls.requests.find(request => /\/result$/.test(request.url));

test("one search: the extension opens the Ozon search address, reads the grid once and reports to the Ozon route", async () => {
  for (const destination of [SEARCH, CATEGORY]) {
    const evidence = { query: QUERY, observedAt: "2026-10-10T08:00:00.000Z", cardCount: 4, readFrom: "state", items: [{ productId: "90000101" }] };
    const { runtime, calls } = harness({ job: ozonJob(), destination, execute: () => [{ result: { status: "captured", evidence } }] });
    assert.deepEqual(await startCapture(runtime, "OMJ-synthetic", OZON_IMAGE_MATCH_REQUEST_TYPE), { accepted: true, claimedCaptureId: "OMJ-synthetic" });
    await idle(runtime);
    assert.deepEqual(calls.created, [{ url: SEARCH, active: false }]);
    assert.equal(calls.executions.length, 1);
    assert.equal(calls.executions[0].func, collectOzonSearchPage);
    assert.deepEqual(calls.executions[0].args, [QUERY, 36]);
    assert.equal(calls.executions[0].world, "ISOLATED");
    const report = resultRequest(calls);
    assert.equal(report.url, "http://127.0.0.1:4317/api/candidates/candidate%3Asynthetic/ozon-match/result");
    assert.deepEqual(report.body, { captureId: "OMJ-synthetic", token: "synthetic-fixture-token", dataRevision: 5, status: "captured", evidence });
    assert.deepEqual(calls.removed, [7]);
  }
});

test("a search that lands on verification, another search or another page stops with its reason and reads nothing", async () => {
  const cases = [
    ["https://www.ozon.ru/abt/result", "site_verification_required"],
    ["https://www.ozon.ru/search/?text=%D0%B4%D1%80%D1%83%D0%B3%D0%BE%D0%B5", "wrong_query"],
    ["https://www.ozon.ru/product/sinteticheskiy-zhilet-90000101/", "navigation_rejected"]
  ];
  for (const [destination, failureCode] of cases) {
    const { runtime, calls } = harness({ job: ozonJob(), destination });
    await startCapture(runtime, "OMJ-synthetic", OZON_IMAGE_MATCH_REQUEST_TYPE);
    await idle(runtime);
    assert.equal(calls.executions.length, 0, destination);
    assert.deepEqual([resultRequest(calls).body.status, resultRequest(calls).body.failureCode], ["failed", failureCode], destination);
  }
  const other = { query: "другое", observedAt: "2026-10-10T08:00:00.000Z", cardCount: 1, readFrom: "state", items: [] };
  const echoed = harness({ job: ozonJob(), destination: SEARCH, execute: () => [{ result: { status: "captured", evidence: other } }] });
  await startCapture(echoed.runtime, "OMJ-synthetic", OZON_IMAGE_MATCH_REQUEST_TYPE);
  await idle(echoed.runtime);
  assert.equal(resultRequest(echoed.calls).body.failureCode, "wrong_query");
  const empty = harness({ job: ozonJob(), destination: SEARCH, execute: () => [{ result: { status: "failed", failureCode: "results_empty" } }] });
  await startCapture(empty.runtime, "OMJ-synthetic", OZON_IMAGE_MATCH_REQUEST_TYPE);
  await idle(empty.runtime);
  assert.equal(resultRequest(empty.calls).body.failureCode, "results_empty");
});

test("a start signal only starts its own kind of job", async () => {
  const wrongKind = harness({ job: ozonJob() });
  assert.deepEqual(await startCapture(wrongKind.runtime, "OMJ-synthetic"), { accepted: false, code: "capture_job_invalid" });
  const supplier = harness({ job: supplierJob({ captureId: "OMJ-synthetic" }) });
  assert.deepEqual(await startCapture(supplier.runtime, "OMJ-synthetic", OZON_IMAGE_MATCH_REQUEST_TYPE), { accepted: false, code: "capture_job_invalid" });
  assert.equal(supplier.calls.created.length, 0);
});

// ---- the collector, on a synthetic page ----

function element(tagName, attributes = {}, children = [], ownText = "") {
  const node = {
    tagName: tagName.toUpperCase(), parentElement: null, children,
    getAttribute: name => attributes[name] ?? null,
    get textContent() { return [ownText, ...children.map(child => child.textContent)].join(" "); },
    get innerText() { return [ownText, ...children.map(child => child.innerText)].filter(Boolean).join("\n"); },
    querySelectorAll(selector) {
      const all = [];
      const walk = parent => parent.children.forEach(child => { all.push(child); walk(child); });
      walk(node);
      if (selector === 'a[href*="/product/"]') return all.filter(child => child.tagName === "A" && String(child.getAttribute("href") || "").includes("/product/"));
      if (selector === "img") return all.filter(child => child.tagName === "IMG");
      return [];
    }
  };
  children.forEach(child => { child.parentElement = node; });
  return node;
}

async function onPage({ states = [SYNTHETIC_OZON_SEARCH_STATE], grid = null, href = SEARCH, title = "", bodyText = "", blocker = null,
  expected = QUERY } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, now: Date.now };
  let reading = previous.now();
  Date.now = () => (reading += 2_000); // Each wait in the collector ends at once instead of after seconds.
  const hosts = states.map(state => ({ getAttribute: name => (name === "data-state" ? JSON.stringify(state) : null) }));
  globalThis.window = { location: { href } };
  globalThis.document = {
    title, body: { innerText: bodyText },
    querySelector: selector => (blocker && selector.includes(blocker) ? {} : null),
    querySelectorAll: selector => (selector.includes("state-searchResultsV2") ? hosts
      : selector.includes('data-widget="searchResultsV2"') && grid ? [grid] : [])
  };
  try { return await collectOzonSearchPage(expected, 36); }
  finally { globalThis.window = previous.window; globalThis.document = previous.document; Date.now = previous.now; }
}

test("the collector reads Ozon's grid state into product facts and never the tracking or click fields", async () => {
  const result = await onPage();
  assert.equal(result.status, "captured");
  assert.deepEqual([result.evidence.query, result.evidence.readFrom, result.evidence.cardCount], [QUERY, "state", 4]);
  assert.deepEqual(result.evidence.items.map(item => [item.productId, item.priceRub, item.originalPriceRub, item.rating, item.reviewCount, item.isAd]), [
    ["90000101", 1299, 2599, 4.8, 1234, false],
    ["90000102", 849, null, 4.5, 57, true],
    ["90000103", 1049.5, 1999, 4.8, 1, false],
    ["90000104", 1299, 2599, 4.8, 1234, false]
  ]);
  assert.equal(result.evidence.items[0].title, "Синтетический жилет 101");
  assert.equal(result.evidence.items[0].imageUrl, "https://ir.ozone.ru/s3/multimedia-1-z/wc500/90000101.jpg");
  assert.equal(result.evidence.items[3].imageUrl, null, "a picture from anywhere but Ozon's image host is not kept");
  assert.equal(JSON.stringify(result).includes("synthetic-tracking-key"), false);
  assert.equal(JSON.stringify(result).includes("asb="), false);
  assert.equal(sanitizeOzonImageMatchEvidence(result.evidence, QUERY).items.length, 4);
});

test("without the grid state the rendered tiles are read the same way", async () => {
  const tile = (id, price, extra = []) => element("div", {}, [
    element("a", { href: `/product/sinteticheskiy-zhilet-${id}/?asb=secret` }, [element("img", { src: `https://ir.ozone.ru/s3/multimedia-1-z/wc500/${id}.jpg` })]),
    element("div", {}, [element("span", {}, [], price), element("span", {}, [], "2 599 ₽")]),
    element("a", { href: `/product/sinteticheskiy-zhilet-${id}/` }, [], `Синтетический жилет ${id}`),
    element("div", {}, [element("span", {}, [], "4.7"), element("span", {}, [], "321 отзыв")]),
    ...extra
  ]);
  const grid = element("div", { "data-widget": "searchResultsV2" }, [element("div", {}, [tile("90000201", "1 199 ₽"),
    tile("90000202", "999 ₽", [element("span", {}, [], "Реклама")])])]);
  const result = await onPage({ states: [], grid });
  assert.equal(result.status, "captured");
  assert.equal(result.evidence.readFrom, "dom");
  assert.deepEqual(result.evidence.items.map(item => [item.productId, item.title, item.priceRub, item.originalPriceRub, item.rating, item.reviewCount, item.isAd]), [
    ["90000201", "Синтетический жилет 90000201", 1199, 2599, 4.7, 321, false],
    ["90000202", "Синтетический жилет 90000202", 999, 2599, 4.7, 321, true]
  ]);
  assert.equal(result.evidence.items[0].imageUrl, "https://ir.ozone.ru/s3/multimedia-1-z/wc500/90000201.jpg");
});

test("the collector refuses another search, a verification page and an empty page, and never calls an empty page no match", async () => {
  assert.deepEqual(await onPage({ href: "https://www.ozon.ru/search/?text=%D0%B4%D1%80%D1%83%D0%B3%D0%BE%D0%B5" }), { status: "failed", failureCode: "wrong_query" });
  assert.deepEqual(await onPage({ blocker: "captcha" }), { status: "failed", failureCode: "site_verification_required" });
  assert.deepEqual(await onPage({ title: "Antibot Challenge Page" }), { status: "failed", failureCode: "site_verification_required" });
  assert.deepEqual(await onPage({ states: [], bodyText: "По запросу ничего не нашлось" }), { status: "failed", failureCode: "results_empty" });
  assert.deepEqual(await onPage({ states: [] }), { status: "failed", failureCode: "results_unverifiable" });
  const category = await onPage({ href: CATEGORY });
  assert.equal(category.status, "captured");
});

test("the saved-page checker reads a saved search page and reports only structure and public product facts", async () => {
  const report = await inspectSavedOzonSearchPage(SYNTHETIC_OZON_SEARCH_HTML);
  assert.deepEqual([report.structure.savedFromPage, report.structure.query, report.structure.gridItems], ["www.ozon.ru/search/", QUERY, 5]);
  assert.deepEqual(report.structure.firstItemAtoms.map(atom => atom.type), ["priceV2", "textAtom", "labelList"]);
  assert.equal(report.structure.firstItemLinkShape, "/product/sinteticheskiy-zhilet-<id>/");
  assert.deepEqual([report.collector.status, report.summary.readFrom, report.summary.itemCount, report.summary.sanitizer],
    ["captured", "state", 4, "accepted 4 items"]);
  assert.equal(JSON.stringify(report).includes("synthetic-tracking-key"), false);
  assert.equal(JSON.stringify(report).includes("asb="), false);
  const withoutAddress = await inspectSavedOzonSearchPage(SYNTHETIC_OZON_SEARCH_HTML.replace(/<!--[^>]*-->/, ""));
  assert.equal(withoutAddress.collector.failureCode, "query_missing");
  assert.equal((await inspectSavedOzonSearchPage(SYNTHETIC_OZON_SEARCH_HTML.replace(/<!--[^>]*-->/, ""), QUERY)).collector.status, "captured");
});

// ---- 以图搜：Ozon 首页上传首图，结果页 /search-by-image ----

const RESULTS = `https://www.ozon.ru/search-by-image?image_id=${IMAGE_ID}`;
const imageJob = (extra = {}) => ({
  ...ozonImageMatchJobPayload({ captureId: "OMJ-image", candidateId: "candidate:synthetic", dataRevision: 6, searchBy: "image",
    searchUrl: OZON_IMAGE_SEARCH_ENTRY_URL, requiredExtensionVersion: "1.4.0", attempt: 1, token: "synthetic-fixture-token" }),
  ...extra
});

test("an image-search tab starts on Ozon's home page and is read only on the search-by-image page with a well-formed upload id", () => {
  const cases = {
    "https://www.ozon.ru/": "entry",
    "https://www.ozon.ru/?__rr=1": "entry",
    [RESULTS]: "results",
    [`${RESULTS}&from=camera`]: "results",
    "https://www.ozon.ru/search-by-image": "other_search",
    "https://www.ozon.ru/search-by-image?image_id=not-hex": "other_search",
    [SEARCH]: "non_whitelisted_destination",
    "https://www.ozon.ru/product/sinteticheskiy-zhilet-90000101/": "non_whitelisted_destination",
    "https://www.ozon.ru/abt/result?x=1": "verification_required",
    "https://ozon.ru/": "non_whitelisted_destination",
    "http://www.ozon.ru/": "invalid"
  };
  for (const [address, expected] of Object.entries(cases)) assert.equal(classifyOzonImageSearchNavigation(address), expected, address);
  assert.equal(ozonImageSearchResultPage(`${RESULTS}&from=camera`), RESULTS);
  for (const value of [IMAGE_ID, IMAGE_ID.toUpperCase(), "abc", "0123456789abcdefx", "0123456789abcdefg", "", null, 7]) {
    assert.equal(extensionImageSearchId(value), ozonImageSearchId(value), String(value));
  }
});

test("an image-search job carries no words and only the home page, and is told apart from a word search", () => {
  const job = imageJob();
  assert.deepEqual([isOzonImageMatchJob(job), isOzonImageSearchJob(job), Object.hasOwn(job, "query"), job.searchBy], [true, true, false, "image"]);
  assert.deepEqual(validateOzonImageMatchRequest({ payload: job, manifestVersion: "1.4.0" }),
    { ok: true, searchBy: "image", searchUrl: OZON_IMAGE_SEARCH_ENTRY_URL });
  const code = extra => validateOzonImageMatchRequest({ payload: imageJob(extra), manifestVersion: "1.4.0" }).code;
  assert.equal(code({ query: QUERY }), "search_query_invalid");
  assert.equal(code({ searchUrl: SEARCH }), "search_query_invalid");
  assert.equal(code({ imageUrl: "https://ir.ozone.ru/s3/a.jpg" }), "capture_mode_invalid");
});

test("one image search: the picture comes from the review app, is uploaded on the home page, and the result page is read", async () => {
  const evidence = { searchBy: "image", imageId: IMAGE_ID, observedAt: "2026-10-10T08:00:00.000Z", cardCount: 12, readFrom: "state",
    items: [{ productId: "90000301" }] };
  const { runtime, calls } = harness({ job: imageJob(), execute: ({ tab, input }) => {
    if (input.func === uploadOzonSearchImage) { tab.url = RESULTS; return [{ result: { status: "uploaded" } }]; }
    return [{ result: { status: "captured", evidence } }];
  } });
  assert.deepEqual(await startCapture(runtime, "OMJ-image", OZON_IMAGE_MATCH_REQUEST_TYPE), { accepted: true, claimedCaptureId: "OMJ-image" });
  await idle(runtime);
  const fetched = calls.requests.find(request => request.url.endsWith("/search-image"));
  assert.equal(fetched.url, "http://127.0.0.1:4317/api/extension/capture-jobs/OMJ-image/search-image");
  assert.deepEqual(fetched.body, { token: "synthetic-fixture-token", dataRevision: 6 });
  assert.deepEqual(calls.created, [{ url: "https://www.ozon.ru/", active: false }]);
  assert.deepEqual(calls.executions.map(execution => [execution.func, execution.world]),
    [[uploadOzonSearchImage, "ISOLATED"], [collectOzonSearchPage, "ISOLATED"]]);
  assert.deepEqual(calls.executions[0].args, ["AAEC", "image/jpeg"]);
  assert.deepEqual(calls.executions[1].args, [{ imageId: IMAGE_ID }, 36]);
  assert.deepEqual(resultRequest(calls).body, { captureId: "OMJ-image", token: "synthetic-fixture-token", dataRevision: 6, status: "captured", evidence });
  assert.deepEqual(calls.removed, [7]);
});

test("an image search stops with its reason: no picture, no upload control, verification, another upload, another page", async () => {
  const noPicture = harness({ job: imageJob(), searchImage: () => ({ ok: false, status: 503 }) });
  await startCapture(noPicture.runtime, "OMJ-image", OZON_IMAGE_MATCH_REQUEST_TYPE);
  await idle(noPicture.runtime);
  assert.deepEqual([noPicture.calls.created.length, resultRequest(noPicture.calls).body.failureCode], [0, "search_image_unavailable"]);

  const noControl = harness({ job: imageJob(), execute: () => [{ result: { status: "failed", failureCode: "image_upload_unavailable" } }] });
  await startCapture(noControl.runtime, "OMJ-image", OZON_IMAGE_MATCH_REQUEST_TYPE);
  await idle(noControl.runtime);
  assert.deepEqual([noControl.calls.executions.length, resultRequest(noControl.calls).body.failureCode], [1, "image_upload_unavailable"]);

  const verification = harness({ job: imageJob(), destination: "https://www.ozon.ru/abt/result" });
  await startCapture(verification.runtime, "OMJ-image", OZON_IMAGE_MATCH_REQUEST_TYPE);
  await idle(verification.runtime);
  assert.deepEqual([verification.calls.executions.length, resultRequest(verification.calls).body.failureCode], [0, "site_verification_required"]);

  for (const [landing, failureCode] of [[SEARCH, "navigation_rejected"], ["https://www.ozon.ru/search-by-image", "navigation_rejected"]]) {
    const moved = harness({ job: imageJob(), execute: ({ tab }) => { tab.url = landing; return [{ result: { status: "uploaded" } }]; } });
    await startCapture(moved.runtime, "OMJ-image", OZON_IMAGE_MATCH_REQUEST_TYPE);
    await idle(moved.runtime);
    assert.deepEqual([moved.calls.executions.length, resultRequest(moved.calls).body.failureCode], [1, failureCode], landing);
  }

  const otherUpload = harness({ job: imageJob(), execute: ({ tab, input }) => {
    if (input.func === uploadOzonSearchImage) { tab.url = RESULTS; return [{ result: { status: "uploaded" } }]; }
    return [{ result: { status: "captured", evidence: { searchBy: "image", imageId: "ffffffffffffffff", observedAt: "2026-10-10T08:00:00.000Z",
      cardCount: 1, readFrom: "state", items: [] } } }];
  } });
  await startCapture(otherUpload.runtime, "OMJ-image", OZON_IMAGE_MATCH_REQUEST_TYPE);
  await idle(otherUpload.runtime);
  assert.equal(resultRequest(otherUpload.calls).body.failureCode, "wrong_query");
});

test("the uploader opens the search bar's photo control and hands the one picture to the page's own file input", async () => {
  const previous = { window: globalThis.window, document: globalThis.document, DataTransfer: globalThis.DataTransfer, now: Date.now };
  let reading = previous.now();
  Date.now = () => (reading += 1_000);
  const events = [];
  const fileInput = { accept: "image/*", disabled: false, files: null, dispatchEvent: event => events.push(event.type) };
  let opened = false;
  const control = (label, type = "button") => ({ getAttribute: name => (name === "aria-label" ? label : name === "type" ? type : null),
    textContent: "", click() { if (label === "Поиск по фото") opened = true; } });
  const bar = { querySelectorAll: () => [control("Найти", "submit"), control("Очистить"), control("Поиск по фото")] };
  globalThis.DataTransfer = class { constructor() { this.list = []; this.items = { add: file => this.list.push(file) }; } get files() { return this.list; } };
  globalThis.document = { title: "OZON", querySelector: selector => (selector.startsWith("[data-widget^=") ? bar : null),
    querySelectorAll: selector => (selector === 'input[type="file"]' && opened ? [fileInput] : []) };
  try {
    assert.deepEqual(await uploadOzonSearchImage("AAEC", "image/jpeg"), { status: "uploaded" });
    assert.equal(fileInput.files.length, 1);
    assert.deepEqual([fileInput.files[0].type, fileInput.files[0].size, fileInput.files[0].name], ["image/jpeg", 3, "photo.jpg"]);
    assert.deepEqual(events, ["input", "change"]);
    // A page without the control, or behind verification, is reported as such; nothing is guessed.
    opened = false;
    globalThis.document = { title: "OZON", querySelector: () => null, querySelectorAll: () => [] };
    assert.deepEqual(await uploadOzonSearchImage("AAEC", "image/jpeg"), { status: "failed", failureCode: "image_upload_unavailable" });
    globalThis.document = { title: "Antibot Challenge Page", querySelector: () => null, querySelectorAll: () => [] };
    assert.deepEqual(await uploadOzonSearchImage("AAEC", "image/jpeg"), { status: "failed", failureCode: "site_verification_required" });
    assert.deepEqual(await uploadOzonSearchImage("", "image/jpeg"), { status: "failed", failureCode: "search_image_unavailable" });
  } finally {
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.DataTransfer = previous.DataTransfer; Date.now = previous.now;
  }
});

test("the collector reads an image-search page: the first page from its state, the pages below from the tiles", async () => {
  const tile = id => element("div", {}, [
    element("a", { href: `/product/sinteticheskiy-tovar-${id}/` }, [element("img", { src: `https://ir.ozone.ru/s3/multimedia-1-x/${id}.jpg` })]),
    element("div", {}, [element("span", {}, [], "690\u2009₽")]),
    element("a", { href: `/product/sinteticheskiy-tovar-${id}/` }, [], `Синтетический товар ${id}`)
  ]);
  const grid = element("div", { "data-widget": "tileGridDesktop" }, [tile("90000301"), tile("90000399")]);
  const result = await onPage({ states: [SYNTHETIC_OZON_IMAGE_SEARCH_STATE], grid, href: `${RESULTS}&from=camera`, expected: { imageId: IMAGE_ID } });
  assert.equal(result.status, "captured");
  assert.deepEqual([result.evidence.searchBy, result.evidence.imageId, result.evidence.readFrom, result.evidence.cardCount, Object.hasOwn(result.evidence, "query")],
    ["image", IMAGE_ID, "mixed", 4, false]);
  assert.deepEqual(result.evidence.items.map(item => [item.productId, item.title, item.priceRub, item.originalPriceRub, item.rank]), [
    ["90000301", "Синтетический товар 301", 425, 1093, 0],
    ["90000302", "Синтетический товар 302", 690, null, 1],
    ["90000303", "Синтетический товар 303", 1290, 1990, 2],
    ["90000399", "Синтетический товар 90000399", 690, null, 3]
  ]);
  assert.equal(result.evidence.items[0].imageUrl, "https://ir.ozone.ru/s3/multimedia-1-x/90000301.jpg");
  assert.equal(JSON.stringify(result).includes("synthetic-tracking-key"), false);
  assert.equal(sanitizeOzonImageMatchEvidence(result.evidence, null, { searchBy: "image" }).items.length, 4);
  assert.throws(() => sanitizeOzonImageMatchEvidence(result.evidence, QUERY), /wrong_query/, "an image search is not a word search");
  assert.throws(() => sanitizeOzonImageMatchEvidence({ ...result.evidence, imageId: "x" }, null, { searchBy: "image" }), /wrong_query/);

  assert.deepEqual(await onPage({ states: [SYNTHETIC_OZON_IMAGE_SEARCH_STATE], href: RESULTS, expected: { imageId: "ffffffffffffffff" } }),
    { status: "failed", failureCode: "wrong_query" }, "another upload's page is not this search");
  assert.deepEqual(await onPage({ states: [SYNTHETIC_OZON_IMAGE_SEARCH_STATE], href: SEARCH, expected: { imageId: IMAGE_ID } }),
    { status: "failed", failureCode: "wrong_query" });
  const stateOnly = await onPage({ states: [SYNTHETIC_OZON_IMAGE_SEARCH_STATE], href: RESULTS, expected: { imageId: IMAGE_ID } });
  assert.deepEqual([stateOnly.evidence.readFrom, stateOnly.evidence.items.length], ["state", 3]);
});

test("the saved-page checker also reads a saved image-search page", async () => {
  const report = await inspectSavedOzonSearchPage(SYNTHETIC_OZON_IMAGE_SEARCH_HTML);
  assert.deepEqual([report.structure.savedFromPage, report.structure.searchBy, report.structure.gridStateHosts, report.structure.gridItems],
    ["www.ozon.ru/search-by-image", "image", 1, 3]);
  assert.deepEqual(report.structure.firstItemAtoms.map(atom => [atom.type, atom.id]), [["priceV2", "atom"], ["textDS", "name"], ["textDS", "stock"]]);
  assert.deepEqual([report.collector.status, report.summary.readFrom, report.summary.itemCount, report.summary.withTitle, report.summary.sanitizer],
    ["captured", "state", 3, 3, "accepted 3 items"]);
  assert.equal(JSON.stringify(report).includes("synthetic-tracking-key"), false);
});
