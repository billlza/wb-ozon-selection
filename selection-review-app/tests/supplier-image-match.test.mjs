import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPLIER_IMAGE_MATCH_JUDGEMENTS,
  SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS,
  SUPPLIER_IMAGE_MATCH_MAX_RESULTS,
  SUPPLIER_IMAGE_MATCH_SCHEMA,
  computeSupplierImageMatchComparison,
  queuedSupplierImageMatchRecord,
  sanitizeSupplierImageMatchEvidence,
  supplierImageMatchComparisonApplied,
  supplierImageMatchComparisonRequested,
  supplierImageMatchFailed,
  supplierImageMatchFailureCode,
  supplierImageMatchInFlight,
  supplierImageMatchJudged,
  supplierImageMatchResultsRecorded,
  supplierImageMatchSearchUrl,
  supplierImageMatchSource,
  supplierImageMatchStartBlocker,
  supplierImageMatchStopMessage
} from "../lib/supplier-image-match.mjs";

// Every id, title, shop and picture address below is synthetic; no real 1688 or Pinduoduo data is used.
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";
const GOODS_URL = "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001";
const OBSERVED = "2026-10-09T08:00:00.000Z";
const ALI_IMAGE = "https://cbu01.alicdn.com/img/ibank/O1CN01syntheticmain.jpg";
const OZON_IMAGE = "https://ir.ozone.ru/s3/multimedia-1-d/wc1000/9000000001.jpg";

function capturedCandidate(overrides = {}) {
  return {
    id: "candidate:synthetic",
    workflowStatus: "candidate",
    sourceCapture: {
      captureId: "SC-synthetic", mode: "a_supplier_capture", status: "captured_waiting_owner_selection",
      sourceUrl: GOODS_URL, offerId: "600000000001", mainImageUrl: IMAGE, mainImageSource: "rawData.goods.topGallery[0]",
      skuChoices: [{ skuId: "1", priceCny: 18.9 }, { skuId: "2", priceCny: 16.5 }, { skuId: "3", priceCny: null }],
      ...overrides.sourceCapture
    },
    ...overrides.candidate
  };
}

function rawItem(index, overrides = {}) {
  return {
    offerId: String(700000000000 + index),
    title: `合成商品 ${index}`,
    imageUrl: `https://cbu01.alicdn.com/img/ibank/O1CN01synthetic${index}.jpg?x=1`,
    priceCny: "32.68",
    priceNote: "运费5元",
    quantityBegin: 1,
    saleQuantity: 120,
    shopName: "合成店铺",
    location: "浙江 金华",
    isAd: false,
    superFactory: false,
    vendorSimilarity: 0.91234,
    rank: index,
    ...overrides
  };
}

function rawEvidence(overrides = {}) {
  return { searchImageUrl: IMAGE, observedAt: OBSERVED, cardCount: 60, items: [rawItem(0), rawItem(1), rawItem(2)], ...overrides };
}

function queued(previous = null) {
  const source = supplierImageMatchSource(capturedCandidate()).source;
  return queuedSupplierImageMatchRecord(previous, { captureId: "IMJ-synthetic", source, requiredExtensionVersion: "1.4.1",
    authorizedBy: "owner:synthetic", authorizedAt: "2026-10-09T07:59:00.000Z", candidateRevision: 7 });
}

test("the 1688 search address is built only from an already canonical Pinduoduo, 1688 or Ozon picture", () => {
  assert.equal(supplierImageMatchSearchUrl(IMAGE),
    "https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=https%3A%2F%2Fimg.pddpic.com%2Fgarner-api-new%2Fsynthetic-main.jpeg");
  assert.equal(supplierImageMatchSearchUrl(ALI_IMAGE),
    "https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=https%3A%2F%2Fcbu01.alicdn.com%2Fimg%2Fibank%2FO1CN01syntheticmain.jpg");
  assert.equal(supplierImageMatchSearchUrl(OZON_IMAGE),
    "https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=https%3A%2F%2Fir.ozone.ru%2Fs3%2Fmultimedia-1-d%2Fwc1000%2F9000000001.jpg");
  for (const refused of [`${IMAGE}?imageMogr2=1`, "http://img.pddpic.com/a.jpeg", `${ALI_IMAGE}_.webp?x=1`, `${OZON_IMAGE}?w=1`,
    "https://cdn1.ozone.ru/s3/a.jpg", "https://img.pddpic.com.evil.example/a.jpeg", "https://example.com/a.jpg", "", null, 42]) {
    assert.equal(supplierImageMatchSearchUrl(refused), null, String(refused));
  }
});

test("a captured Pinduoduo or 1688 source searches with its first picture, and the reason is said when nothing can be searched", () => {
  const ready = supplierImageMatchSource(capturedCandidate());
  assert.equal(ready.ok, true);
  assert.equal(ready.imageUrl, IMAGE);
  assert.equal(ready.searchUrl, supplierImageMatchSearchUrl(IMAGE));
  assert.deepEqual({ ...ready.source }, { platform: "pinduoduo", offerId: "600000000001", captureId: "SC-synthetic", imageUrl: IMAGE, lowestPriceCny: 16.5 });

  const ali = supplierImageMatchSource(capturedCandidate({ sourceCapture: { sourceUrl: "https://detail.1688.com/offer/123456789.html",
    offerId: "123456789", mainImageUrl: ALI_IMAGE, mainImageSource: "data.gallery.fields.mainImage[0]" } }));
  assert.equal(ali.ok, true);
  assert.deepEqual({ ...ali.source }, { platform: "1688", offerId: "123456789", captureId: "SC-synthetic", imageUrl: ALI_IMAGE, lowestPriceCny: 16.5 });

  const code = candidate => supplierImageMatchSource(candidate).code;
  assert.equal(code({}), "source_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { status: "needs_sku_selection" } })), "source_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { mode: "legacy" } })), "source_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { sourceUrl: "https://detail.1688.com/offer/123456789.html" } })), "main_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { sourceUrl: "https://detail.1688.com/offer/123456789.html", mainImageUrl: OZON_IMAGE } })),
    "main_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { mainImageUrl: null } })), "main_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { mainImageUrl: `${IMAGE}?w=200` } })), "main_image_missing");
  assert.equal(code(capturedCandidate({ sourceCapture: { mainImageUrl: "https://cbu01.alicdn.com/img/ibank/a.jpg" } })), "main_image_missing");
  for (const result of [supplierImageMatchSource({}), supplierImageMatchSource(capturedCandidate({ sourceCapture: { mainImageUrl: null } }))]) {
    assert.equal(result.ok, false);
    assert.ok(result.reason.length > 5);
  }
  assert.equal(supplierImageMatchSource(capturedCandidate({ sourceCapture: { skuChoices: [{ priceCny: null }] } })).source.lowestPriceCny, null);
});

test("without a supplier capture a product from Seerfar or an Ozon link searches with its Ozon main picture", () => {
  const ozon = (overrides = {}) => ({ id: "candidate:ozon", workflowStatus: "needs_user_data", productUrl: "https://www.ozon.ru/product/9000000001",
    imageUrl: OZON_IMAGE, ...overrides });
  const ready = supplierImageMatchSource(ozon());
  assert.equal(ready.ok, true);
  assert.equal(ready.searchUrl, supplierImageMatchSearchUrl(OZON_IMAGE));
  assert.deepEqual({ ...ready.source }, { platform: "ozon", offerId: "9000000001", captureId: "", imageUrl: OZON_IMAGE, lowestPriceCny: null });
  assert.equal(supplierImageMatchSource(ozon({ productUrl: "https://www.ozon.ru/product/sobachiy-dozhdevik-9000000001/" })).source.offerId, "9000000001");

  // The latest sales snapshot's first Ozon picture is used when the candidate itself names none.
  const fromSnapshot = supplierImageMatchSource(ozon({ imageUrl: "", salesSnapshotsV11: [
    { imageRefs: ["https://ir.ozone.ru/s3/old.jpg"] }, { imageRefs: [OZON_IMAGE, "https://ir.ozone.ru/s3/second.jpg"] }] }));
  assert.equal(fromSnapshot.imageUrl, OZON_IMAGE);

  // A captured supplier picture always wins; a capture without one falls back to the Ozon picture rather than stopping.
  assert.equal(supplierImageMatchSource({ ...capturedCandidate(), productUrl: "https://www.ozon.ru/product/9000000001", imageUrl: OZON_IMAGE }).source.platform,
    "pinduoduo");
  assert.equal(supplierImageMatchSource({ ...capturedCandidate({ sourceCapture: { mainImageUrl: null } }),
    productUrl: "https://www.ozon.ru/product/9000000001", imageUrl: OZON_IMAGE }).source.platform, "ozon");

  // Not an Ozon product, or no Ozon picture: nothing to search, and no other picture is borrowed.
  const code = candidate => supplierImageMatchSource(candidate).code;
  assert.equal(code(ozon({ productUrl: "https://www.wildberries.ru/catalog/1/detail.aspx" })), "source_image_missing");
  assert.equal(code(ozon({ productUrl: "https://www.ozon.ru/category/odezhda-dlya-sobak/" })), "source_image_missing");
  assert.equal(code(ozon({ imageUrl: "https://example.com/a.jpg" })), "source_image_missing");
  // A size or format query on the stored Ozon picture is dropped; the search always uses the bare picture address.
  assert.equal(supplierImageMatchSource(ozon({ imageUrl: `${OZON_IMAGE}?w=1` })).imageUrl, OZON_IMAGE);
});

test("a search cannot start for an eliminated product, while one is running, or over an unreconciled unknown outcome", () => {
  assert.equal(supplierImageMatchStartBlocker(capturedCandidate()), null);
  assert.equal(supplierImageMatchStartBlocker(capturedCandidate({ candidate: { workflowStatus: "eliminated" } })).code, "candidate_eliminated");
  for (const record of [{ status: "waiting_extension", jobStatus: "queued" }, { status: "searching", jobStatus: "claimed" }, { status: "failed", jobStatus: "claimed" }]) {
    assert.equal(supplierImageMatchInFlight(record), true);
    assert.equal(supplierImageMatchStartBlocker(capturedCandidate({ candidate: { supplierImageMatch: record } })).code, "image_match_in_flight");
  }
  for (const record of [null, { status: "compared", jobStatus: "completed" }, { status: "failed", jobStatus: "failed" }]) {
    assert.equal(supplierImageMatchInFlight(record), false);
    assert.equal(supplierImageMatchStartBlocker(capturedCandidate({ candidate: { supplierImageMatch: record } })), null);
  }
  const unknown = capturedCandidate({ candidate: { supplierImageMatch: { status: "failed", jobStatus: "unknown_outcome" } } });
  assert.equal(supplierImageMatchStartBlocker(unknown).code, "image_match_unknown_outcome");
  assert.equal(supplierImageMatchStartBlocker(unknown, { acknowledgeUnknownOutcome: "true" }).code, "image_match_unknown_outcome");
  assert.equal(supplierImageMatchStartBlocker(unknown, { acknowledgeUnknownOutcome: true }), null);
});

test("search results are kept only as product facts, with the 1688 address rebuilt from the offer id", () => {
  const evidence = sanitizeSupplierImageMatchEvidence(rawEvidence({ items: [
    rawItem(0, { loginId: "secret-login", memberId: "b2b-secret", sessionId: "s", eurl: "https://click.example/ad?token=t",
      offerUrl: "https://dj.1688.com/ci_bb?a=1", title: "  合成\u0000商品\n第一条  " }),
    rawItem(1, { isAd: true, priceCny: 0, quantityBegin: 0, vendorSimilarity: 1.5, rank: 99, imageUrl: "https://example.com/a.jpg",
      priceNote: "", shopName: "", location: "" }),
    rawItem(2, { isAd: "true", superFactory: true, priceCny: "abc", saleQuantity: -1, quantityBegin: "2" })
  ] }), IMAGE);
  assert.equal(evidence.searchImageUrl, IMAGE);
  assert.equal(evidence.observedAt, OBSERVED);
  assert.equal(evidence.cardCount, 60);
  const [first, second, third] = evidence.items;
  assert.deepEqual(Object.keys(first).sort(), ["imageUrl", "isAd", "isSourceOffer", "location", "offerId", "priceCny", "priceNote", "quantityBegin",
    "rank", "saleQuantity", "shopName", "sourceUrl", "superFactory", "title", "vendorSimilarity"]);
  assert.equal(evidence.items.some(item => item.isSourceOffer), false);
  assert.equal(first.sourceUrl, "https://detail.1688.com/offer/700000000000.html");
  assert.equal(first.title, "合成 商品 第一条");
  assert.equal(first.imageUrl, "https://cbu01.alicdn.com/img/ibank/O1CN01synthetic0.jpg");
  assert.equal(first.priceCny, 32.68);
  assert.equal(first.priceNote, "运费5元");
  assert.equal(first.vendorSimilarity, 0.912);
  assert.equal(JSON.stringify(evidence).includes("secret"), false);
  assert.equal(JSON.stringify(evidence).includes("dj.1688.com"), false);
  assert.deepEqual([second.isAd, second.priceCny, second.quantityBegin, second.vendorSimilarity, second.rank, second.imageUrl,
    second.priceNote, second.shopName, second.location], [true, null, null, null, null, null, null, null, null]);
  assert.deepEqual([third.isAd, third.superFactory, third.priceCny, third.saleQuantity, third.quantityBegin], [false, true, null, null, 2]);

  // Searching with a 1688 picture: the owner's own offer shows up in the results and is marked as such.
  const fromAli = sanitizeSupplierImageMatchEvidence(rawEvidence({ searchImageUrl: ALI_IMAGE }), ALI_IMAGE, { sourceOfferId: "700000000001" });
  assert.deepEqual(fromAli.items.map(item => item.isSourceOffer), [false, true, false]);
  const fromOzon = sanitizeSupplierImageMatchEvidence(rawEvidence({ searchImageUrl: OZON_IMAGE }), OZON_IMAGE);
  assert.equal(fromOzon.searchImageUrl, OZON_IMAGE);
});

test("a search for another picture, an empty page or a malformed result is refused, never read as no match", () => {
  const code = (input, expected = IMAGE) => {
    try { sanitizeSupplierImageMatchEvidence(input, expected); return "accepted"; } catch (error) { return error.message; }
  };
  assert.equal(code(rawEvidence({ searchImageUrl: "https://img.pddpic.com/garner-api-new/other.jpeg" })), "wrong_query");
  assert.equal(code(rawEvidence({ searchImageUrl: `${IMAGE}?w=1` })), "wrong_query");
  assert.equal(code(rawEvidence({ searchImageUrl: undefined })), "wrong_query");
  assert.equal(code(rawEvidence({ searchImageUrl: ALI_IMAGE })), "wrong_query");
  assert.equal(code(rawEvidence({ searchImageUrl: OZON_IMAGE }), ALI_IMAGE), "wrong_query");
  assert.equal(code(rawEvidence({ items: [], cardCount: 0 })), "results_unverifiable");
  assert.equal(code(rawEvidence({ items: [] })), "results_unverifiable");
  assert.equal(code(rawEvidence({ cardCount: null })), "results_unverifiable");
  assert.equal(code(rawEvidence({ cardCount: 501 })), "results_unverifiable");
  assert.equal(code(null), "invalid_capture");
  assert.equal(code([]), "invalid_capture");
  assert.equal(code(rawEvidence({ observedAt: "yesterday" })), "invalid_capture");
  assert.equal(code(rawEvidence({ cardCount: 2 })), "invalid_capture");
  assert.equal(code(rawEvidence({ cardCount: 100, items: Array.from({ length: SUPPLIER_IMAGE_MATCH_MAX_RESULTS + 1 }, (_, index) => rawItem(index)) })), "invalid_capture");
  assert.equal(code(rawEvidence({ items: [rawItem(0), rawItem(0)] })), "invalid_capture");
  for (const offerId of ["0123456", "12345", "abc1234567", 700000000000, "7".repeat(21)]) {
    assert.equal(code(rawEvidence({ items: [rawItem(0, { offerId })] })), "invalid_capture", String(offerId));
  }
  assert.equal(code(rawEvidence({ items: [null] })), "invalid_capture");
  assert.equal(code(rawEvidence({ cardCount: 100, items: Array.from({ length: SUPPLIER_IMAGE_MATCH_MAX_RESULTS }, (_, index) => rawItem(index)) })), "accepted");
});

test("every stop has a plain message, and an empty logged-out page is never called no match", () => {
  assert.match(supplierImageMatchStopMessage("site_login_required"), /登录/);
  assert.match(supplierImageMatchStopMessage("site_login_required"), /不能说明没有同款/);
  assert.match(supplierImageMatchStopMessage("results_unverifiable"), /不能说明没有同款/);
  assert.equal(supplierImageMatchStopMessage("made_up_code"), supplierImageMatchStopMessage("system_error"));
  assert.equal(supplierImageMatchStopMessage("timeout", "x".repeat(400)).length, supplierImageMatchStopMessage("timeout").length + 1 + 300);
  assert.equal(supplierImageMatchFailureCode(" unknown_outcome "), "unknown_outcome");
  for (const bad of ["", null, "constructor", "__proto__", "anything"]) assert.equal(supplierImageMatchFailureCode(bad), "system_error");
});

test("queuing locks a one-search login-state authorization and keeps the last five searches with their judgements", () => {
  const record = queued();
  assert.equal(record.schemaVersion, SUPPLIER_IMAGE_MATCH_SCHEMA);
  assert.deepEqual([record.status, record.jobStatus, record.attempt, record.captureId, record.jobId], ["waiting_extension", "queued", 0, "IMJ-synthetic", "IMJ-synthetic"]);
  assert.equal(record.searchUrl, supplierImageMatchSearchUrl(IMAGE));
  assert.deepEqual(record.authorization, { action: "1688_image_search", site: "1688", loginStateRead: true, maxSearches: 1, maxResults: 20,
    publicImageReads: 21, authorizedBy: "owner:synthetic", authorizedAt: "2026-10-09T07:59:00.000Z", candidateRevision: 7 });
  assert.deepEqual([record.results, record.comparison, record.judgements, record.history], [[], null, {}, []]);
  assert.deepEqual([record.businessStateEffect, record.writeOccurred, record.retryAttempted], ["unchanged", false, false]);

  let previous = supplierImageMatchJudged(supplierImageMatchResultsRecorded(record, sanitizeSupplierImageMatchEvidence(rawEvidence(), IMAGE), OBSERVED),
    { offerId: "700000000001", judgement: "exact", judgedAt: OBSERVED, judgedBy: "owner:synthetic" });
  const next = queued(previous);
  assert.equal(next.history.length, 1);
  assert.deepEqual(next.history[0].judgements, { "700000000001": { judgement: "exact", judgedAt: OBSERVED, judgedBy: "owner:synthetic" } });
  assert.deepEqual(next.history[0].results, [{ offerId: "700000000001", sourceUrl: "https://detail.1688.com/offer/700000000001.html", title: "合成商品 1", priceCny: 32.68 }]);
  assert.equal(next.history[0].resultCount, 3);
  assert.deepEqual([next.results, next.judgements], [[], {}]);

  previous = next;
  for (let round = 0; round < 7; round += 1) previous = queued(previous);
  assert.equal(previous.history.length, 5);
});

test("results are recorded, compared by first-picture fingerprint, and each one is labelled identical, similar, different or unknown", async () => {
  const items = [rawItem(0), rawItem(1), rawItem(2), rawItem(3, { imageUrl: null }), rawItem(4)];
  const recorded = supplierImageMatchResultsRecorded(queued(), sanitizeSupplierImageMatchEvidence(rawEvidence({ items }), IMAGE), "2026-10-09T08:00:05.000Z");
  assert.deepEqual([recorded.status, recorded.jobStatus, recorded.completedAt, recorded.cardCount], ["comparing", "completed", "2026-10-09T08:00:05.000Z", 60]);
  assert.ok(recorded.results.every(item => item.similarity === "unknown" && item.fingerprint === null && item.distance === null));

  const source = "0000000000000000";
  const prints = {
    [IMAGE]: source,
    "https://cbu01.alicdn.com/img/ibank/O1CN01synthetic0.jpg": "0000000000000003", // 2 bits away
    "https://cbu01.alicdn.com/img/ibank/O1CN01synthetic1.jpg": "00000000000003ff", // 10 bits away
    "https://cbu01.alicdn.com/img/ibank/O1CN01synthetic2.jpg": "ffffffffffffffff" // 64 bits away
  };
  const fetched = [];
  const fingerprintOf = async url => {
    fetched.push(url);
    if (url.endsWith("synthetic4.jpg")) { const error = new Error("x"); error.code = "FETCH_FAILED"; throw error; }
    return prints[url];
  };
  const comparison = await computeSupplierImageMatchComparison(recorded, { fingerprintOf, comparedAt: "2026-10-09T08:00:06.000Z" });
  assert.equal(fetched[0], IMAGE);
  assert.equal(fetched.length, 5, "the result without a picture is not fetched");
  assert.equal(comparison.sourceFingerprint, source);
  assert.equal(comparison.sourceError, null);
  assert.deepEqual(comparison.results.map(row => [row.offerId, row.distance, row.similarity, row.compareError]), [
    ["700000000000", 2, "identical", null],
    ["700000000001", 10, "similar", null],
    ["700000000002", 64, "different", null],
    ["700000000003", null, "unknown", "image_missing"],
    ["700000000004", null, "unknown", "fetch_failed"]
  ]);

  const applied = supplierImageMatchComparisonApplied(recorded, comparison);
  assert.equal(applied.status, "compared");
  assert.deepEqual(applied.comparison, { version: "dhash-64-v1", comparedAt: "2026-10-09T08:00:06.000Z", sourceFingerprint: source, sourceError: null });
  assert.deepEqual(applied.results.map(item => item.similarity), ["identical", "similar", "different", "unknown", "unknown"]);
  assert.equal(applied.results[0].title, "合成商品 0");
  assert.equal(comparison.captureId, "IMJ-synthetic");
  assert.equal(supplierImageMatchComparisonApplied(applied, comparison), null, "a record that is not waiting for a comparison is left alone");
  assert.equal(supplierImageMatchComparisonApplied(queued(), comparison), null, "a newer search is never overwritten by an older comparison");
  assert.equal(supplierImageMatchComparisonApplied({ ...recorded, captureId: "IMJ-newer" }, comparison), null);

  // Comparing again keeps the results and the owner's judgements; only the labels are refreshed.
  const judged = supplierImageMatchJudged(applied, { offerId: "700000000002", judgement: "wrong", judgedAt: OBSERVED, judgedBy: "owner:synthetic" });
  const again = supplierImageMatchComparisonRequested(judged);
  assert.deepEqual([again.status, again.judgements, again.results], ["comparing", judged.judgements, judged.results]);
  assert.equal(supplierImageMatchComparisonApplied(again, comparison).status, "compared");
  assert.equal(supplierImageMatchComparisonRequested(recorded).status, "comparing");
  for (const record of [queued(), supplierImageMatchFailed(queued(), "timeout", { timestamp: OBSERVED }), null]) {
    assert.throws(() => supplierImageMatchComparisonRequested(record), /image_match_not_comparable/);
  }
  assert.equal(supplierImageMatchComparisonApplied(recorded, { ...comparison, results: comparison.results.slice(1) }), null);

  const sourceUnreadable = await computeSupplierImageMatchComparison(recorded, { fingerprintOf: async url => (url === IMAGE ? "not-a-print" : source),
    comparedAt: OBSERVED });
  assert.deepEqual([sourceUnreadable.sourceFingerprint, sourceUnreadable.sourceError], [null, "image_unreadable"]);
  assert.ok(sourceUnreadable.results.every(row => row.similarity === "unknown" && row.compareError === "source_image_unreadable"));
  await assert.rejects(computeSupplierImageMatchComparison(recorded, { fingerprintOf: null }), /DEPENDENCY_INVALID/);
});

test("the owner judges each result as same product, near match or not, and only results from this search can be judged", () => {
  assert.deepEqual([...SUPPLIER_IMAGE_MATCH_JUDGEMENTS], ["exact", "near", "wrong"]);
  assert.deepEqual({ ...SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS }, { exact: "是同款", near: "近似款", wrong: "不是" });
  const recorded = supplierImageMatchResultsRecorded(queued(), sanitizeSupplierImageMatchEvidence(rawEvidence(), IMAGE), OBSERVED);
  const by = { judgedAt: OBSERVED, judgedBy: "owner:synthetic" };
  let record = supplierImageMatchJudged(recorded, { offerId: "700000000000", judgement: "exact", ...by });
  record = supplierImageMatchJudged(record, { offerId: "700000000001", judgement: "near", ...by });
  record = supplierImageMatchJudged(record, { offerId: "700000000002", judgement: "wrong", ...by });
  assert.deepEqual(Object.fromEntries(Object.entries(record.judgements).map(([id, value]) => [id, value.judgement])),
    { "700000000000": "exact", "700000000001": "near", "700000000002": "wrong" });
  record = supplierImageMatchJudged(record, { offerId: "700000000001", judgement: "clear", ...by });
  assert.deepEqual(Object.keys(record.judgements), ["700000000000", "700000000002"]);
  assert.deepEqual(recorded.judgements, {}, "judging never mutates the earlier record");

  const code = (target, input) => { try { supplierImageMatchJudged(target, { ...by, ...input }); return "accepted"; } catch (error) { return error.message; } };
  assert.equal(code(record, { offerId: "799999999999", judgement: "exact" }), "image_match_offer_unknown");
  assert.equal(code(record, { offerId: "700000000000", judgement: "maybe" }), "image_match_judgement_invalid");
  assert.equal(code(queued(), { offerId: "700000000000", judgement: "exact" }), "image_match_not_judgeable");
  const failed = supplierImageMatchFailed(queued(), "site_login_required", { timestamp: OBSERVED });
  assert.equal(code(failed, { offerId: "700000000000", judgement: "exact" }), "image_match_not_judgeable");
});

test("a failed search keeps business state unchanged, and a claimed search without a result is an unknown outcome", () => {
  const login = supplierImageMatchFailed(queued(), "site_login_required", { timestamp: OBSERVED });
  assert.deepEqual([login.status, login.jobStatus, login.failureCode, login.observedAt, login.businessStateEffect, login.writeOccurred, login.retryAttempted],
    ["failed", "failed", "site_login_required", OBSERVED, "unchanged", false, false]);
  assert.match(login.reason, /登录/);
  const unknown = supplierImageMatchFailed(queued(), "unknown_outcome", { observedAt: "2026-10-09T08:01:00.000Z", timestamp: OBSERVED });
  assert.deepEqual([unknown.jobStatus, unknown.observedAt], ["unknown_outcome", "2026-10-09T08:01:00.000Z"]);
  const odd = supplierImageMatchFailed(queued(), "page_exploded", { timestamp: OBSERVED, detail: "细节" });
  assert.equal(odd.failureCode, "system_error");
  assert.ok(odd.reason.endsWith("：细节"));
});
