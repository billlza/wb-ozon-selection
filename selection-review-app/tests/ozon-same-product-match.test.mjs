import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOzonSearchQuery as extensionQuery, ozonSearchUrl as extensionSearchUrl } from "../extension/1688-capture/source-routing.js";
import {
  OZON_IMAGE_MATCH_MAX_RESULTS, computeOzonImageMatchComparison, normalizeOzonSearchQuery, ozonImageMatchComparisonApplied,
  ozonImageMatchFailed, ozonImageMatchJudged, ozonImageMatchResultsRecorded, ozonImageMatchStartBlocker, ozonImageMatchTarget,
  ozonSearchUrl, queuedOzonImageMatchRecord, sanitizeOzonImageMatchEvidence, suggestedOzonSearchQuery
} from "../lib/ozon-same-product-match.mjs";
import { supplierImageMatchSource } from "../lib/supplier-image-match.mjs";

// Every id, title, price and picture address below is synthetic; no Ozon page and no network is used.
const QUERY = "синтетический жилет для кошки";
const PDD_IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";
const OZON_IMAGE = "https://ir.ozone.ru/s3/multimedia-1-d/wc1000/9000000001.jpg";
const OZON_URL = "https://www.ozon.ru/product/sinteticheskiy-zhilet-9000000001/";
const pddCapture = (extra = {}) => ({ mode: "a_supplier_capture", status: "captured_waiting_owner_selection", captureId: "SCJ-synthetic",
  sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001", offerId: "600000000001", mainImageUrl: PDD_IMAGE,
  title: "合成宠物背心", skuChoices: [{ priceCny: 16.5 }], ...extra });
const candidate = (extra = {}) => ({ id: "candidate:synthetic", workflowStatus: "needs_user_data", productName: "合成宠物背心",
  sourceCapture: pddCapture(), ...extra });

test("the service and the extension read search words and build the Ozon search address the same way", () => {
  const inputs = [QUERY, `  ${QUERY}  `, "жилет\u00a0для\u2028кошки", "Жилет  для\tкошки", "a", "ab", "12", "1 шт",
    "x".repeat(100), "x".repeat(101), "https://evil.example/", "жилет <script>", "{жилет}", "", null, 7, "猫 背心", "cat vest"];
  for (const input of inputs) {
    assert.equal(extensionQuery(input), normalizeOzonSearchQuery(input), String(input));
    assert.equal(extensionSearchUrl(input), ozonSearchUrl(input), String(input));
  }
  assert.equal(normalizeOzonSearchQuery("жилет\u00a0для\u2028кошки"), "жилет для кошки");
  assert.equal(normalizeOzonSearchQuery("12"), null, "words need at least one letter");
  assert.equal(ozonSearchUrl(`  ${QUERY}`), null, "only an already normalized query becomes an address");
  assert.equal(ozonSearchUrl(QUERY),
    "https://www.ozon.ru/search/?text=%D1%81%D0%B8%D0%BD%D1%82%D0%B5%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B8%D0%B9+%D0%B6%D0%B8%D0%BB%D0%B5%D1%82+%D0%B4%D0%BB%D1%8F+%D0%BA%D0%BE%D1%88%D0%BA%D0%B8&from_global=true");
});

test("the words are prefilled from the last Ozon search, else from the product's own Russian Ozon title, else left for the owner", () => {
  assert.deepEqual(suggestedOzonSearchQuery(candidate()), { query: "", origin: null }, "a Chinese supplier title is not a Russian query");
  assert.deepEqual(suggestedOzonSearchQuery(candidate({ productName: "Жилет для кошек и собак, тёплый, размер S" })),
    { query: "Жилет для кошек и собак", origin: "ozon_title" });
  assert.deepEqual(suggestedOzonSearchQuery(candidate({ salesSnapshotsV11: [{ title: "Старое название" },
    { title: "Жилет синтетический для кошек с капюшоном на молнии зимний тёплый (S)" }] })),
  { query: "Жилет синтетический для кошек с капюшоном на молнии", origin: "ozon_title" }, "at most eight words, before the first comma or bracket");
  assert.deepEqual(suggestedOzonSearchQuery(candidate({ productName: "Жилет", ozonImageMatch: { query: QUERY } })),
    { query: QUERY, origin: "last_search" });
});

test("the picture follows the same rule as the 1688 search, and the words must be real words", () => {
  const target = ozonImageMatchTarget(candidate(), QUERY);
  assert.equal(target.ok, true);
  assert.deepEqual([target.imageUrl, target.query, target.searchUrl, target.queryOrigin, target.ownProductId],
    [supplierImageMatchSource(candidate()).imageUrl, QUERY, ozonSearchUrl(QUERY), "owner", ""]);
  assert.equal(target.source.platform, "pinduoduo");
  const fromOzon = ozonImageMatchTarget(candidate({ sourceCapture: null, productUrl: OZON_URL, imageUrl: OZON_IMAGE,
    productName: "Синтетический жилет для кошки" }), "Синтетический жилет для кошки");
  assert.deepEqual([fromOzon.imageUrl, fromOzon.source.platform, fromOzon.ownProductId, fromOzon.queryOrigin],
    [OZON_IMAGE, "ozon", "9000000001", "ozon_title"]);
  assert.deepEqual(ozonImageMatchTarget(candidate(), "  "), { ok: false, code: "ozon_search_query_invalid",
    reason: "请填 Ozon 上用的俄文搜索词（2 到 100 个字，至少有一个字母）。" });
  assert.equal(ozonImageMatchTarget(candidate({ sourceCapture: null }), QUERY).code, "source_image_missing");
  assert.equal(ozonImageMatchTarget(candidate({ sourceCapture: pddCapture({ mainImageUrl: null }) }), QUERY).code, "main_image_missing");
});

test("an image search needs only the picture: no words, Ozon's home page as the start, and its own authorization", () => {
  const target = ozonImageMatchTarget(candidate(), "ignored words", { searchBy: "image" });
  assert.deepEqual([target.ok, target.searchBy, target.imageUrl, target.query, target.queryOrigin, target.searchUrl],
    [true, "image", supplierImageMatchSource(candidate()).imageUrl, null, null, "https://www.ozon.ru/"]);
  assert.equal(ozonImageMatchTarget(candidate(), "", { searchBy: "image" }).ok, true, "an empty word box does not stop an image search");
  assert.equal(ozonImageMatchTarget(candidate({ sourceCapture: null }), null, { searchBy: "image" }).code, "source_image_missing");
  assert.equal(ozonImageMatchTarget(candidate(), QUERY, { searchBy: "photo" }).code, "ozon_search_by_invalid");
  assert.equal(ozonImageMatchTarget(candidate(), QUERY).searchBy, "text");

  const queued = queuedOzonImageMatchRecord(null, { captureId: "OMJ-image", source: target.source, searchBy: "image", query: "ignored",
    queryOrigin: "owner", requiredExtensionVersion: "1.4.1", authorizedBy: "owner", authorizedAt: "2026-10-10T08:00:00.000Z", candidateRevision: 3 });
  assert.deepEqual([queued.searchBy, queued.query, queued.queryOrigin, queued.searchUrl], ["image", null, null, "https://www.ozon.ru/"]);
  assert.deepEqual(queued.authorization, { action: "ozon_image_search", site: "ozon", loginStateRead: false, ownerBrowser: true,
    maxSearches: 1, imageUploads: 1, maxResults: 36, publicImageReads: 37, authorizedBy: "owner", authorizedAt: "2026-10-10T08:00:00.000Z",
    candidateRevision: 3 });
  // The next word search does not prefill from an image search, which had no words.
  assert.deepEqual(suggestedOzonSearchQuery(candidate({ ozonImageMatch: queued })), { query: "", origin: null });
  assert.match(ozonImageMatchFailed({}, "image_upload_unavailable", { timestamp: "2026-10-10T08:00:00.000Z" }).reason, /可以先用俄文词搜/);
});

const item = (index, extra = {}) => ({ productId: String(9000000100 + index), title: `Синтетический жилет ${index}`,
  imageUrl: `https://ir.ozone.ru/s3/multimedia-1-z/wc500/${9000000100 + index}.jpg?w=1`, priceRub: 1299, originalPriceRub: 2599,
  rating: 4.84, reviewCount: 1234, isAd: false, rank: index, trackingInfo: { key: "secret-tracking" },
  link: "/product/x-1/?asb=secret", ...extra });
const evidence = (extra = {}) => ({ query: QUERY, observedAt: "2026-10-10T08:00:00.000Z", cardCount: 36, readFrom: "state",
  items: [item(0), item(1, { isAd: true, originalPriceRub: 999 }), item(2, { imageUrl: "https://cdn.example.com/a.jpg", rating: 7 })], ...extra });

test("Ozon results are kept only as product facts, with the address rebuilt from the product id", () => {
  const kept = sanitizeOzonImageMatchEvidence(evidence(), QUERY, { ownProductId: "9000000101" });
  assert.deepEqual(Object.keys(kept), ["query", "observedAt", "cardCount", "readFrom", "items"]);
  assert.deepEqual(Object.keys(kept.items[0]), ["productId", "sourceUrl", "title", "imageUrl", "priceRub", "originalPriceRub", "rating",
    "reviewCount", "isAd", "rank", "isSourceProduct"]);
  assert.deepEqual(kept.items[0], { productId: "9000000100", sourceUrl: "https://www.ozon.ru/product/9000000100/",
    title: "Синтетический жилет 0", imageUrl: "https://ir.ozone.ru/s3/multimedia-1-z/wc500/9000000100.jpg", priceRub: 1299,
    originalPriceRub: 2599, rating: 4.8, reviewCount: 1234, isAd: false, rank: 0, isSourceProduct: false });
  assert.deepEqual([kept.items[1].isAd, kept.items[1].originalPriceRub, kept.items[1].isSourceProduct], [true, null, true]);
  assert.deepEqual([kept.items[2].imageUrl, kept.items[2].rating], [null, null]);
  assert.equal(JSON.stringify(kept).includes("secret"), false);

  const code = (input, query = QUERY) => { try { sanitizeOzonImageMatchEvidence(input, query); return "accepted"; } catch (error) { return error.message; } };
  assert.equal(code(evidence({ query: "другие слова" })), "wrong_query");
  assert.equal(code(evidence({ items: [] })), "results_unverifiable");
  assert.equal(code(evidence({ readFrom: "guess" })), "invalid_capture");
  assert.equal(code(evidence({ items: [item(0), item(0)] })), "invalid_capture");
  assert.equal(code(evidence({ items: [item(0, { productId: "0123" })] })), "invalid_capture");
  assert.equal(code(evidence({ cardCount: 1 })), "invalid_capture");
  assert.equal(code(evidence({ items: Array.from({ length: OZON_IMAGE_MATCH_MAX_RESULTS + 1 }, (_value, index) => item(index)), cardCount: 60 })),
    "invalid_capture");
  assert.equal(code(evidence({ query: ` ${QUERY.toUpperCase()} ` })), "wrong_query", "the page must echo these very words");
});

test("an Ozon search record runs the same life as a 1688 one: queued with its words, results, picture comparison, the owner's judgement", async () => {
  const target = ozonImageMatchTarget(candidate(), QUERY);
  const queued = queuedOzonImageMatchRecord(null, { captureId: "OMJ-synthetic", source: target.source, query: target.query,
    queryOrigin: target.queryOrigin, requiredExtensionVersion: "1.4.1", authorizedBy: "owner", authorizedAt: "2026-10-10T08:00:00.000Z",
    candidateRevision: 3 });
  assert.deepEqual([queued.schemaVersion, queued.status, queued.query, queued.queryOrigin, queued.searchUrl],
    ["ozon-image-match-v1", "waiting_extension", QUERY, "owner", ozonSearchUrl(QUERY)]);
  assert.deepEqual(queued.authorization, { action: "ozon_text_search", site: "ozon", loginStateRead: false, ownerBrowser: true,
    maxSearches: 1, maxResults: 36, publicImageReads: 37, authorizedBy: "owner", authorizedAt: "2026-10-10T08:00:00.000Z", candidateRevision: 3 });
  assert.equal(ozonImageMatchStartBlocker(candidate({ ozonImageMatch: queued })).code, "ozon_match_in_flight");

  const saved = ozonImageMatchResultsRecorded({ ...queued, status: "searching", jobStatus: "claimed" },
    sanitizeOzonImageMatchEvidence(evidence(), QUERY), "2026-10-10T08:01:00.000Z");
  const prints = { [PDD_IMAGE]: "0000000000000000", "https://ir.ozone.ru/s3/multimedia-1-z/wc500/9000000100.jpg": "0000000000000003",
    "https://ir.ozone.ru/s3/multimedia-1-z/wc500/9000000101.jpg": "ffffffffffffffff" };
  const comparison = await computeOzonImageMatchComparison(saved, { comparedAt: "2026-10-10T08:02:00.000Z",
    fingerprintOf: async url => { if (!prints[url]) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" }); return prints[url]; } });
  const compared = ozonImageMatchComparisonApplied(saved, comparison);
  assert.deepEqual(compared.results.map(row => [row.productId, row.similarity, row.compareError]),
    [["9000000100", "identical", null], ["9000000101", "different", null], ["9000000102", "unknown", "image_missing"]]);

  const judged = ozonImageMatchJudged(compared, { productId: "9000000100", judgement: "exact", judgedAt: "2026-10-10T08:03:00.000Z", judgedBy: "owner" });
  assert.equal(judged.judgements["9000000100"].judgement, "exact");
  const code = input => { try { ozonImageMatchJudged(compared, input); return "accepted"; } catch (error) { return error.message; } };
  assert.equal(code({ productId: "9999999999", judgement: "exact" }), "ozon_match_product_unknown");
  assert.equal(code({ productId: "9000000100", judgement: "maybe" }), "ozon_match_judgement_invalid");

  const next = queuedOzonImageMatchRecord(judged, { captureId: "OMJ-next", source: target.source, query: "другие слова", queryOrigin: "owner",
    requiredExtensionVersion: "1.4.1", authorizedBy: "owner", authorizedAt: "2026-10-10T09:00:00.000Z", candidateRevision: 9 });
  assert.deepEqual(next.history[0].results, [{ productId: "9000000100", sourceUrl: "https://www.ozon.ru/product/9000000100/",
    title: "Синтетический жилет 0", priceRub: 1299 }]);
});

test("an empty Ozon search only says these words found nothing, never that Ozon has no same product", () => {
  const stopped = ozonImageMatchFailed({ status: "searching" }, "results_empty", { timestamp: "2026-10-10T08:00:00.000Z" });
  assert.equal(stopped.failureCode, "results_empty");
  assert.match(stopped.reason, /不能说明 Ozon 上没有同款/);
  assert.equal(ozonImageMatchFailed({}, "made_up", { timestamp: "2026-10-10T08:00:00.000Z" }).failureCode, "system_error");
  assert.match(ozonImageMatchFailed({}, "site_verification_required", { timestamp: "2026-10-10T08:00:00.000Z" }).reason, /人机验证/);
});
