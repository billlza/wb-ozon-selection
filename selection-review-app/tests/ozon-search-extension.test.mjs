import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectOzonSearchPage } from "../extension/1688-capture/collector-ozon-search.js";
import { OZON_IMAGE_MATCH_REQUEST_TYPE, isImageMatchJob, isOzonCaptureJob, isOzonImageMatchJob, validateCaptureStartSignal,
  validateImageMatchRequest, validateOzonImageMatchRequest } from "../extension/1688-capture/capture-request.js";
import { classifyOzonSearchNavigation, ozonSearchResultPage } from "../extension/1688-capture/source-routing.js";
import { ozonImageMatchJobPayload, ozonSearchUrl, sanitizeOzonImageMatchEvidence } from "../lib/ozon-same-product-match.mjs";
import { SYNTHETIC_OZON_QUERY as QUERY, SYNTHETIC_OZON_SEARCH_HTML, SYNTHETIC_OZON_SEARCH_STATE } from "./fixtures/ozon-search-state-fixture.mjs";
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
  assert.deepEqual(validateOzonImageMatchRequest({ payload: job, manifestVersion: "1.4.0" }), { ok: true, query: QUERY, searchUrl: SEARCH });
  const code = (extra, version = "1.4.0") => validateOzonImageMatchRequest({ payload: ozonJob(extra), manifestVersion: version }).code;
  assert.equal(code({}, "1.3.0"), "extension_version_mismatch");
  assert.equal(code({ attempt: 0 }), "attempt_invalid");
  assert.equal(code({ maxResults: 20 }), "request_payload_missing");
  assert.equal(code({ imageUrl: "https://ir.ozone.ru/s3/a.jpg" }), "capture_mode_invalid");
  assert.equal(code({ productUrl: "https://www.ozon.ru/product/1234567/" }), "capture_mode_invalid");
  assert.equal(code({ query: ` ${QUERY}` }), "search_query_invalid");
  assert.equal(code({ searchUrl: `${SEARCH}&sorting=price` }), "search_query_invalid");
  assert.equal(code({ query: "другое", searchUrl: SEARCH }), "search_query_invalid");
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
