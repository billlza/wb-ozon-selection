import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { IMAGE_MATCH_CHANNEL, OZON_IMAGE_MATCH_CHANNEL, captureStartMessage, needsCaptureStartSignal } from "../src/captureStart.js";
import { ozonImageMatchView, ozonSearchQueryReady } from "../src/ozonImageMatchView.js";
import { normalizeOzonSearchQuery, ozonImageMatchRules } from "../lib/ozon-same-product-match.mjs";
import { IMAGE_MATCH_JUDGEMENT_LABELS, IMAGE_MATCH_SIMILARITY_LABELS, imageMatchSourceState, supplierImageMatchView } from "../src/supplierImageMatchView.js";
import { IMAGE_SIMILARITY_LABELS } from "../lib/image-fingerprint.mjs";
import { SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS, supplierImageMatchSource } from "../lib/supplier-image-match.mjs";

// Synthetic display data only: no saved record, no service, no request, no picture download.
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";
const ALI_IMAGE = "https://cbu01.alicdn.com/img/ibank/O1CN01syntheticmain.jpg";
const OZON_IMAGE = "https://ir.ozone.ru/s3/multimedia-1-d/wc1000/9000000001.jpg";
const OZON_URL = "https://www.ozon.ru/product/sinteticheskiy-zhilet-9000000001/";
const capture = (extra = {}) => ({ mode: "a_supplier_capture", status: "captured_waiting_owner_selection",
  sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001", mainImageUrl: IMAGE,
  skuChoices: [{ sourceSkuId: "1", priceCny: 18.9, attributes: { 颜色: "卡其色" } }, { sourceSkuId: "2", priceCny: 16.5, attributes: { 颜色: "黑色" } }],
  selectedSkuIds: [], ...extra });
const row = (index, extra = {}) => ({ offerId: String(700000000000 + index), sourceUrl: `https://detail.1688.com/offer/${700000000000 + index}.html`,
  title: `合成同款 ${index}`, imageUrl: `https://cbu01.alicdn.com/img/ibank/O1CN01s${index}.jpg`, priceCny: 15, priceNote: "运费5元",
  quantityBegin: 1, saleQuantity: 120, shopName: "合成店铺", location: "浙江 金华", isAd: false, superFactory: false,
  vendorSimilarity: 0.9, rank: index, fingerprint: null, distance: null, similarity: "unknown", compareError: null, ...extra });
const compared = (extra = {}) => ({ captureId: "IMJ-synthetic", status: "compared", jobStatus: "completed", cardCount: 60,
  source: { imageUrl: IMAGE }, results: [
    row(0, { similarity: "different", distance: 30 }),
    row(1, { similarity: "identical", distance: 2, priceCny: 12.3, quantityBegin: 3, isAd: true }),
    row(2, { similarity: "similar", distance: 9, quantityBegin: null }),
    row(3, { similarity: "unknown", compareError: "fetch_failed" })
  ], judgements: { "700000000001": { judgement: "exact" } }, ...extra });
const candidate = (extra = {}) => ({ id: "candidate:synthetic-pdd", dataRevision: 6, targetStore: "miska", workflowStatus: "needs_user_data",
  productName: "合成背心", sourceCapture: capture(), ...extra });

test("the page labels match the service's own labels word for word", () => {
  for (const [level, label] of Object.entries(IMAGE_SIMILARITY_LABELS)) assert.equal(IMAGE_MATCH_SIMILARITY_LABELS[level], label);
  assert.deepEqual({ ...IMAGE_MATCH_JUDGEMENT_LABELS }, { ...SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS });
});

test("the block appears when there is a picture to search, a capture to redo or an earlier search, and says why a search cannot start", () => {
  assert.equal(supplierImageMatchView(candidate({ sourceCapture: null })), null);
  const ready = supplierImageMatchView(candidate());
  assert.deepEqual([ready.sourceReady, ready.canStart, ready.sourceImageUrl, ready.lowestPriceCny, ready.status], [true, true, IMAGE, 16.5, null]);
  assert.deepEqual([ready.sourcePlatform, ready.sourceLabel, ready.priceBaseLabel], ["pinduoduo", "拼多多首图", "拼多多"]);
  const old = supplierImageMatchView(candidate({ sourceCapture: capture({ mainImageUrl: null }) }));
  assert.deepEqual([old.sourceReady, old.canStart], [false, false]);
  assert.match(old.sourceReason, /重新采一次/);
  assert.doesNotMatch(old.sourceReason, /1\.2\.9/);
  // A 1688 capture whose stored picture is not on 1688's own image host has nothing to search with until it is captured again.
  const foreign = supplierImageMatchView(candidate({ sourceCapture: capture({ sourceUrl: "https://detail.1688.com/offer/123456789.html" }) }));
  assert.deepEqual([foreign.sourceReady, foreign.canStart], [false, false]);
  assert.match(foreign.sourceReason, /重新采一次/);
  assert.equal(imageMatchSourceState(candidate({ sourceCapture: capture({ status: "needs_sku_selection" }) })).ready, false);
  assert.equal(supplierImageMatchView(candidate({ workflowStatus: "eliminated" })).canStart, false);
});

test("the page picks the same picture the service will search with, for every entry", () => {
  const cases = [
    candidate(),
    candidate({ sourceCapture: capture({ sourceUrl: "https://detail.1688.com/offer/123456789.html", offerId: "123456789", mainImageUrl: ALI_IMAGE }) }),
    candidate({ sourceCapture: null, productUrl: OZON_URL, imageUrl: OZON_IMAGE }),
    candidate({ sourceCapture: null, productUrl: OZON_URL, imageUrl: null, salesSnapshotsV11: [{ imageRefs: [OZON_IMAGE] }] }),
    candidate({ sourceCapture: capture({ mainImageUrl: null }), productUrl: OZON_URL, imageUrl: OZON_IMAGE }),
    candidate({ sourceCapture: null, productUrl: "https://www.wildberries.ru/catalog/1/detail.aspx", imageUrl: OZON_IMAGE }),
    candidate({ sourceCapture: null, productUrl: OZON_URL, imageUrl: "https://img.example.com/a.jpg" })
  ];
  for (const item of cases) {
    const service = supplierImageMatchSource(item);
    const page = imageMatchSourceState(item);
    assert.equal(page.ready, service.ok);
    assert.equal(page.imageUrl, service.ok ? service.imageUrl : null);
    assert.equal(page.platform, service.ok ? service.source.platform : null);
    assert.equal(page.reason, service.ok ? null : service.reason);
  }

  const supplier = supplierImageMatchView(cases[1]);
  assert.deepEqual([supplier.sourcePlatform, supplier.sourceLabel, supplier.priceBaseLabel, supplier.lowestPriceCny], ["1688", "1688 首图", "你给的这家", 16.5]);
  const ozon = supplierImageMatchView(cases[2]);
  assert.deepEqual([ozon.sourceReady, ozon.sourcePlatform, ozon.sourceLabel, ozon.sourceImageUrl, ozon.lowestPriceCny, ozon.priceBaseLabel],
    [true, "ozon", "Ozon 主图", OZON_IMAGE, null, null]);
  assert.equal(supplierImageMatchView(cases[5]), null);
  assert.equal(supplierImageMatchView(cases[6]), null);
});

test("results are compared with the picture and price that search used, and the 1688 offer you gave is marked as itself", () => {
  const supplierCapture = capture({ sourceUrl: "https://detail.1688.com/offer/700000000001.html", offerId: "700000000001", mainImageUrl: ALI_IMAGE });
  const fromSupplier = supplierImageMatchView(candidate({ sourceCapture: supplierCapture, supplierImageMatch: compared({
    source: { platform: "1688", offerId: "700000000001", imageUrl: ALI_IMAGE, lowestPriceCny: 14 },
    results: [row(1, { similarity: "identical", distance: 0, priceCny: 14, isSourceOffer: true }), row(2, { similarity: "similar", distance: 8, priceCny: 12.5 })]
  }) }));
  assert.deepEqual(fromSupplier.rows.map(item => [item.offerId, item.isSourceOffer, item.priceDifferenceCny]),
    [["700000000001", true, 0], ["700000000002", false, -1.5]]);
  assert.equal(fromSupplier.priceBaseLabel, "你给的这家");

  const fromOzon = supplierImageMatchView(candidate({ sourceCapture: null, productUrl: OZON_URL, imageUrl: OZON_IMAGE, supplierImageMatch: compared({
    source: { platform: "ozon", offerId: "9000000001", imageUrl: OZON_IMAGE, lowestPriceCny: null } }) }));
  assert.equal(fromOzon.priceBaseLabel, null);
  assert.ok(fromOzon.rows.every(item => item.priceDifferenceCny === null && item.isSourceOffer === false));

  // A Pinduoduo capture made after an Ozon-picture search does not lend its price to that search's results.
  const later = supplierImageMatchView(candidate({ productUrl: OZON_URL, supplierImageMatch: compared({
    source: { platform: "ozon", offerId: "9000000001", imageUrl: OZON_IMAGE, lowestPriceCny: null } }) }));
  assert.deepEqual([later.sourcePlatform, later.sourceImageUrl, later.priceBaseLabel], ["pinduoduo", IMAGE, null]);
  assert.ok(later.rows.every(item => item.priceDifferenceCny === null));
});

test("results are ordered by first-picture similarity, carry price, MOQ and judgement, and never call anything a match by themselves", () => {
  const view = supplierImageMatchView(candidate({ supplierImageMatch: compared() }));
  assert.deepEqual(view.rows.map(item => [item.offerId, item.similarityLabel]),
    [["700000000001", "首图一致"], ["700000000002", "很像"], ["700000000003", "无法比对"], ["700000000000", "不像"]]);
  assert.deepEqual(view.counts, { identical: 1, similar: 1, different: 1, unknown: 1 });
  const [first, second] = view.rows;
  assert.deepEqual([first.judgement, first.priceDifferenceCny, first.quantity.ok, first.isAd], ["exact", -4.2, false, true]);
  assert.match(first.quantity.text, /不满足一件起订/);
  assert.deepEqual([second.judgement, second.quantity.ok], [null, null]);
  assert.match(second.quantity.text, /核对是否一件起订/);
  assert.match(view.statusLine, /首图一致 1 条、很像 1 条、不像 1 条、无法比对 1 条/);
  assert.match(view.statusLine, /请你逐条判断/);
  assert.deepEqual([view.canCompare, view.judgeable, view.exactCount], [true, true, 1]);
  const allRead = supplierImageMatchView(candidate({ supplierImageMatch: compared({ results: [row(0, { similarity: "identical", distance: 0 })] }) }));
  assert.equal(allRead.canCompare, false);
});

test("a running, failed or unknown search says so and blocks or asks before another search", () => {
  const running = supplierImageMatchView(candidate({ supplierImageMatch: { captureId: "IMJ-a", status: "searching", jobStatus: "claimed", results: [] } }));
  assert.deepEqual([running.inFlight, running.canStart, running.judgeable], [true, false, false]);
  assert.match(running.statusLine, /正在你 Chrome 里登录的 1688 上搜图/);
  const login = supplierImageMatchView(candidate({ supplierImageMatch: { captureId: "IMJ-b", status: "failed", jobStatus: "failed",
    failureCode: "site_login_required", reason: "1688 需要登录：……这次不能说明没有同款", results: [] } }));
  assert.deepEqual([login.failed, login.canStart, login.unknownOutcome], [true, true, false]);
  assert.match(login.statusLine, /不能说明没有同款/);
  const unknown = supplierImageMatchView(candidate({ supplierImageMatch: { captureId: "IMJ-c", status: "failed", jobStatus: "unknown_outcome",
    reason: "结果未知", results: [] } }));
  assert.deepEqual([unknown.unknownOutcome, unknown.canStart], [true, true]);
});

test("the start receipt sends the image-match start signal, and its accepted sentence names the search", () => {
  assert.equal(needsCaptureStartSignal({ status: "supplier_image_match_job_queued", duplicate: false }, IMAGE_MATCH_CHANNEL), true);
  assert.equal(needsCaptureStartSignal({ status: "supplier_image_match_job_queued", duplicate: true }, IMAGE_MATCH_CHANNEL), false);
  assert.equal(needsCaptureStartSignal({ status: "supplier_capture_job_queued" }, IMAGE_MATCH_CHANNEL), false);
  assert.match(captureStartMessage({ accepted: true }, IMAGE_MATCH_CHANNEL), /找同款/);
  assert.equal(IMAGE_MATCH_CHANNEL.request, "SELECTION_REVIEW_1688_IMAGE_MATCH_REQUEST");
});

let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL("./supplier-image-match-ui-entry.jsx", import.meta.url));
    const component = fileURLToPath(new URL("../src/components/ProductPage.jsx", import.meta.url));
    const state = fileURLToPath(new URL("../src/siblingPreparationState.js", import.meta.url));
    const output = await build({ configFile: false, logLevel: "warn", plugins: [react(), { name: "image-match-ui-test",
      resolveId: id => (id === entry ? entry : null),
      load: id => (id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
        import {createPreparationSaveState} from ${JSON.stringify(state)};import Page from ${JSON.stringify(component)};
        export const render=props=>renderToStaticMarkup(<Page preparationSaveState={createPreparationSaveState()} {...props}/>);` : null) }],
    ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
    const chunk = output.output.find(value => value.type === "chunk" && value.isEntry);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  }
  return renderer.render(props);
}
const forbidden = () => { throw new Error("RENDER_MUST_NOT_START_WORK"); };
// 两个找同款区块从 2026-10-10 起在「做这件」卡里面，卡开着才看得见。
const imageMatchSection = html => html.match(/<section class="product-image-match"[\s\S]*?<\/section>/)?.[0] ?? "";
const gate1Open = { gate1V1: { open: true, preselection: {}, ozonOptions: [], supplierOptions: [] } };
const pageProps = extra => ({ view: gate1Open, extensionStatus: { code: "connected", label: "插件已连接" }, onAcceptGate1: forbidden, onSkipGate1: forbidden,
  onRequestCapture: forbidden, onBack: forbidden, onStartImageMatch: forbidden, onCompareImageMatch: forbidden, onJudgeImageMatch: forbidden, ...extra });

test("the product page shows the first picture, the search button, the labelled results and the three judgement buttons", async () => {
  const fresh = await render(pageProps({ candidate: candidate() }));
  assert.match(fresh, /aria-label="在 1688 找同款"/);
  assert.match(fresh, /用首图在 1688 找同款/);
  assert.match(fresh, /拼多多最低拼单价：¥16\.50/);
  assert.match(fresh, new RegExp(`src="${IMAGE.replace(/[.]/g, "\\.")}"`));
  const html = await render(pageProps({ candidate: candidate({ supplierImageMatch: compared() }) }));
  assert.match(html, /首图一致/);
  assert.match(html, /很像/);
  assert.match(html, /无法比对/);
  assert.match(html, /重新比对首图/);
  assert.match(html, /再找一次/);
  assert.match(html, /比拼多多低 ¥4\.20/);
  assert.match(html, /3 件起批，不满足一件起订/);
  assert.match(html, /aria-pressed="true"[^>]*>是同款</);
  assert.match(html, /href="https:\/\/detail\.1688\.com\/offer\/700000000001\.html"/);
  assert.match(html, /近似款只能当价格参考，不能当供货方案/);
  const unknown = await render(pageProps({ candidate: candidate({ supplierImageMatch: { captureId: "IMJ-c", status: "failed",
    jobStatus: "unknown_outcome", reason: "插件领取了这次找同款，但在执行期限内没有回传可验证结果，这次的结果未知", results: [] } }) }));
  assert.match(unknown, /我知道上次结果未知，重新找一次/);
  const supplier = await render(pageProps({ candidate: candidate({
    sourceCapture: capture({ sourceUrl: "https://detail.1688.com/offer/700000000001.html", offerId: "700000000001", mainImageUrl: ALI_IMAGE }),
    supplierImageMatch: compared({ source: { platform: "1688", offerId: "700000000001", imageUrl: ALI_IMAGE, lowestPriceCny: 16.5 },
      results: [row(1, { similarity: "identical", distance: 0, priceCny: 16.5, isSourceOffer: true }), row(2, { similarity: "similar", distance: 8, priceCny: 15 })] }) }) }));
  assert.match(supplier, /用这张1688 首图/);
  assert.match(supplier, /你给的这家 1688 最低价：¥16\.50/);
  assert.match(supplier, /就是你给的这家/);
  assert.match(supplier, /比你给的这家低 ¥1\.50/);
  assert.doesNotMatch(imageMatchSection(supplier), /拼多多/);
  const ozon = await render(pageProps({ candidate: candidate({ sourceCapture: null, productUrl: OZON_URL, imageUrl: OZON_IMAGE,
    supplierImageMatch: compared({ source: { platform: "ozon", offerId: "9000000001", imageUrl: OZON_IMAGE, lowestPriceCny: null } }) }) }));
  assert.match(ozon, /用这张Ozon 主图/);
  assert.match(ozon, /alt="Ozon 主图"/);
  assert.doesNotMatch(imageMatchSection(ozon), /拼多多|最低价：/);
  const withoutHandlers = await render(pageProps({ candidate: candidate(), onStartImageMatch: null }));
  assert.doesNotMatch(withoutHandlers, /在 1688 找同款/);
});

test("the app wires the three image-match actions and sends the image-match start signal after a new job", async () => {
  const app = await readFile(fileURLToPath(new URL("../src/App.jsx", import.meta.url)), "utf8");
  assert.match(app, /onStartImageMatch=\{payload => startSupplierImageMatch\(payload\)\}/);
  assert.match(app, /startQueuedSupplierCapture\(result,\{channel:IMAGE_MATCH_CHANNEL\}\)/);
  assert.match(app, /onJudgeImageMatch=\{payload => writeSupplierImageMatch\(api\.judgeSupplierImageMatch, payload\)\}/);
});

// ---- 在 Ozon 找同款 ----
const OZON_QUERY = "жилет для кошки";
const ozonRow = (index, extra = {}) => ({ productId: String(9100000000 + index), sourceUrl: `https://www.ozon.ru/product/${9100000000 + index}/`,
  title: `Синтетический жилет ${index}`, imageUrl: `https://ir.ozone.ru/s3/multimedia-1-a/wc1000/91000000${index}.jpg`, priceRub: 1290,
  originalPriceRub: null, rating: null, reviewCount: null, isAd: false, rank: index, isSourceProduct: false,
  fingerprint: null, distance: null, similarity: "unknown", compareError: null, ...extra });
const ozonCompared = (extra = {}) => ({ captureId: "OMJ-synthetic", status: "compared", jobStatus: "completed", cardCount: 36,
  query: OZON_QUERY, queryOrigin: "owner", source: { platform: "pinduoduo", imageUrl: IMAGE }, results: [
    ozonRow(0, { similarity: "different", distance: 31 }),
    ozonRow(1, { similarity: "identical", distance: 1, priceRub: 1290, originalPriceRub: 1590, rating: 4.8, reviewCount: 312, isAd: true }),
    ozonRow(2, { similarity: "similar", distance: 9, isSourceProduct: true }),
    ozonRow(3, { similarity: "unknown", compareError: "fetch_failed", priceRub: null })
  ], judgements: { "9100000001": { judgement: "exact" } }, ...extra });
const ozonProps = extra => pageProps({ onStartOzonMatch: forbidden, onCompareOzonMatch: forbidden, onJudgeOzonMatch: forbidden, ...extra });
const ozonMatchSection = html => html.match(/<section class="product-image-match product-ozon-match"[\s\S]*?<\/section>/)?.[0] ?? "";

test("the Ozon block prefills the last search's words, else the product's own Russian Ozon title, and checks words like the service", () => {
  assert.equal(ozonImageMatchView(candidate({ sourceCapture: null })), null);
  const fresh = ozonImageMatchView(candidate());
  assert.deepEqual([fresh.sourceReady, fresh.canStart, fresh.sourceImageUrl, fresh.sourceLabel, fresh.status, fresh.suggestedQuery],
    [true, true, IMAGE, "拼多多首图", null, ""]);
  assert.match(fresh.suggestionNote, /填几个俄文词/);
  const titled = ozonImageMatchView(candidate({ productName: "Жилет для кошки утеплённый, синтетический (S)" }));
  assert.equal(titled.suggestedQuery, "Жилет для кошки утеплённый");
  assert.match(titled.suggestionNote, /取自这件商品在 Ozon 上的标题/);
  const snapshot = ozonImageMatchView(candidate({ productName: "合成背心", salesSnapshotsV11: [{ title: "Старое название" }, { title: "Жилет зимний; новый" }] }));
  assert.equal(snapshot.suggestedQuery, "Жилет зимний");
  const last = ozonImageMatchView(candidate({ productName: "Жилет для кошки", ozonImageMatch: ozonCompared({ query: "попона для собаки" }) }));
  assert.deepEqual([last.suggestedQuery, last.query], ["попона для собаки", "попона для собаки"]);
  assert.match(last.suggestionNote, /上次在 Ozon 搜用的词/);
  for (const value of ["жилет", " жилет  для\u00a0кошки ", "a", "12", "<b>жилет</b>", "https://www.ozon.ru/", "ж".repeat(101), null]) {
    assert.equal(ozonSearchQueryReady(value), normalizeOzonSearchQuery(value) !== null);
  }
  assert.equal(ozonImageMatchView(candidate({ workflowStatus: "eliminated" })).canStart, false);
  const old = ozonImageMatchView(candidate({ sourceCapture: capture({ mainImageUrl: null }) }));
  assert.deepEqual([old.sourceReady, old.canStart], [false, false]);
  assert.match(old.sourceReason, /重新采一次/);
});

test("Ozon results are ordered by first-picture similarity, carry rouble price, rating and judgement, and never call anything a match", () => {
  const view = ozonImageMatchView(candidate({ ozonImageMatch: ozonCompared() }));
  assert.deepEqual(view.rows.map(item => item.similarity), ["identical", "similar", "unknown", "different"]);
  assert.deepEqual(view.counts, { identical: 1, similar: 1, different: 1, unknown: 1 });
  assert.deepEqual([view.rows[0].priceRub, view.rows[0].originalPriceRub, view.rows[0].rating, view.rows[0].reviewCount, view.rows[0].isAd],
    [1290, 1590, 4.8, 312, true]);
  assert.equal(view.rows[1].isSourceProduct, true);
  assert.equal(view.rows[2].priceRub, null);
  assert.deepEqual(view.rows.map(item => item.judgement), ["exact", null, null, null]);
  assert.equal(view.exactCount, 1);
  assert.deepEqual([view.judgeable, view.canCompare, view.canStart], [true, true, true]);
  assert.match(view.statusLine, /用「жилет для кошки」搜到 36 条，读回前 4 条/);
  assert.match(view.statusLine, /是不是同款请你逐条判断/);
  assert.doesNotMatch(view.statusLine, /找到同款|就是同款/);
});

test("a running, empty, failed or unknown Ozon search says so and blocks or asks before another search", () => {
  const running = ozonImageMatchView(candidate({ ozonImageMatch: { captureId: "OMJ-a", status: "searching", jobStatus: "claimed", query: OZON_QUERY, results: [] } }));
  assert.deepEqual([running.inFlight, running.canStart, running.judgeable], [true, false, false]);
  assert.match(running.statusLine, /正在 Ozon 上搜「жилет для кошки」/);
  const empty = ozonImageMatchView(candidate({ ozonImageMatch: { captureId: "OMJ-b", status: "failed", jobStatus: "failed", query: OZON_QUERY,
    failureCode: "results_empty", reason: ozonImageMatchRules.stopMessage("results_empty"), results: [] } }));
  assert.deepEqual([empty.failed, empty.canStart, empty.unknownOutcome], [true, true, false]);
  assert.match(empty.statusLine, /不能说明 Ozon 上没有同款/);
  const unknown = ozonImageMatchView(candidate({ ozonImageMatch: { captureId: "OMJ-c", status: "failed", jobStatus: "unknown_outcome",
    query: OZON_QUERY, reason: "结果未知", results: [] } }));
  assert.deepEqual([unknown.unknownOutcome, unknown.canStart], [true, true]);
});

test("the Ozon start receipt sends the Ozon start signal, never the 1688 one", () => {
  assert.equal(needsCaptureStartSignal({ status: "ozon_image_match_job_queued", duplicate: false }, OZON_IMAGE_MATCH_CHANNEL), true);
  assert.equal(needsCaptureStartSignal({ status: "ozon_image_match_job_queued", duplicate: true }, OZON_IMAGE_MATCH_CHANNEL), false);
  assert.equal(needsCaptureStartSignal({ status: "supplier_image_match_job_queued" }, OZON_IMAGE_MATCH_CHANNEL), false);
  assert.equal(needsCaptureStartSignal({ status: "ozon_image_match_job_queued" }, IMAGE_MATCH_CHANNEL), false);
  assert.equal(OZON_IMAGE_MATCH_CHANNEL.request, "SELECTION_REVIEW_OZON_IMAGE_MATCH_REQUEST");
  assert.match(captureStartMessage({ accepted: true }, OZON_IMAGE_MATCH_CHANNEL), /Ozon/);
});

test("the product page offers the image search first, keeps the words box as the fallback, and shows rouble results with judgements", async () => {
  const fresh = ozonMatchSection(await render(ozonProps({ candidate: candidate({ productName: "Жилет для кошки, синтетический" }) })));
  assert.match(fresh, /aria-label="在 Ozon 找同款"/);
  assert.match(fresh, /<button type="button" class="button primary">用首图在 Ozon 搜</);
  assert.match(fresh, /先用这张拼多多首图在 Ozon 以图搜一次/);
  assert.ok(fresh.indexOf("用首图在 Ozon 搜") < fresh.indexOf('id="ozon-match-query"'), "the image search comes before the words");
  assert.match(fresh, /id="ozon-match-query"[^>]*value="Жилет для кошки"|value="Жилет для кошки"[^>]*id="ozon-match-query"/);
  assert.match(fresh, /以图搜只找到近似款时，用俄文词再搜（后备）/);
  assert.match(fresh, /取自这件商品在 Ozon 上的标题/);
  assert.match(fresh, /<button type="button" class="button secondary">用俄文词搜</);
  assert.doesNotMatch(fresh, /Ozon 不能拿图搜/);
  // No words yet: the image search still works, only the word search waits for words.
  const blank = ozonMatchSection(await render(ozonProps({ candidate: candidate() })));
  assert.match(blank, /<button type="button" class="button primary">用首图在 Ozon 搜</);
  assert.match(blank, /<button type="button" class="button secondary" disabled="">用俄文词搜</);
  const html = ozonMatchSection(await render(ozonProps({ candidate: candidate({ ozonImageMatch: ozonCompared() }) })));
  assert.match(html, /首图一致/);
  assert.match(html, /1 290 ₽/);
  assert.match(html, /原价 1 590 ₽/);
  assert.match(html, /4\.8 分/);
  assert.match(html, /312 条评价/);
  assert.match(html, />广告</);
  assert.match(html, /就是这件商品自己/);
  assert.match(html, /价格没读到/);
  assert.match(html, /aria-pressed="true"[^>]*>是同款</);
  assert.match(html, /href="https:\/\/www\.ozon\.ru\/product\/9100000001\/"/);
  assert.match(html, />用首图再搜一次</);
  assert.match(html, /重新比对首图/);
  assert.match(html, /没搜到也不说明 Ozon 上没有同款/);
  assert.doesNotMatch(html, /¥|1688/);
  const unknown = ozonMatchSection(await render(ozonProps({ candidate: candidate({ ozonImageMatch: { captureId: "OMJ-c", status: "failed",
    jobStatus: "unknown_outcome", query: OZON_QUERY, reason: "插件领取了这次在 Ozon 找同款，但在执行期限内没有回传可验证结果，这次的结果未知", results: [] } }) })));
  assert.match(unknown, /我知道上次结果未知，用首图再搜一次/);
  assert.match(unknown, /我知道上次结果未知，用俄文词搜/);
  // An image search's results say so, point to the words when nothing matched, and flag pictures shared by several products.
  const shared = "https://ir.ozone.ru/s3/multimedia-1-x/9100000099.jpg";
  const byImage = ozonCompared({ searchBy: "image", query: null, results: [
    ozonRow(0, { similarity: "similar", imageUrl: shared }), ozonRow(1, { similarity: "different", imageUrl: shared, isSourceProduct: false }),
    ozonRow(2, { similarity: "different", isSourceProduct: false })], judgements: {} });
  const imageView = ozonImageMatchView(candidate({ ozonImageMatch: byImage }));
  assert.equal(imageView.searchBy, "image");
  assert.match(imageView.statusLine, /^Ozon 以图搜到 36 条，读回前 3 条/);
  assert.match(imageView.statusLine, /只找到近似款很常见，可以在下面用俄文词再搜一次/);
  assert.deepEqual(imageView.rows.map(row => row.samePictureOthers), [1, 1, 0]);
  const imageHtml = ozonMatchSection(await render(ozonProps({ candidate: candidate({ ozonImageMatch: byImage }) })));
  assert.match(imageHtml, /同一张图还有 1 个商品，可能是别的规格/);
  assert.match(imageHtml, /以图搜按样子找，不保证有一模一样的/);
  const searching = ozonImageMatchView(candidate({ ozonImageMatch: { captureId: "OMJ-d", status: "searching", jobStatus: "claimed", searchBy: "image",
    query: null, results: [] } }));
  assert.equal(searching.statusLine, "插件正在 Ozon 上用首图搜……");
  // Both blocks sit on the page side by side; the 1688 block keeps its own wording.
  const both = await render(ozonProps({ candidate: candidate() }));
  assert.match(imageMatchSection(both), /在 1688 找同款/);
  assert.doesNotMatch(imageMatchSection(both), /Ozon/);
  const withoutHandlers = await render(pageProps({ candidate: candidate() }));
  assert.doesNotMatch(withoutHandlers, /在 Ozon 找同款/);
});

test("the app wires the three Ozon match actions to their own routes and sends the Ozon start signal after a new job", async () => {
  const app = await readFile(fileURLToPath(new URL("../src/App.jsx", import.meta.url)), "utf8");
  assert.match(app, /onStartOzonMatch=\{payload => startOzonImageMatch\(payload\)\}/);
  assert.match(app, /startQueuedSupplierCapture\(result,\{channel:OZON_IMAGE_MATCH_CHANNEL\}\)/);
  assert.match(app, /onCompareOzonMatch=\{payload => writeSupplierImageMatch\(api\.compareOzonImageMatch, payload\)\}/);
  assert.match(app, /onJudgeOzonMatch=\{payload => writeSupplierImageMatch\(api\.judgeOzonImageMatch, payload\)\}/);
  const client = await readFile(fileURLToPath(new URL("../src/api.js", import.meta.url)), "utf8");
  for (const action of ["start", "compare", "judgement"]) assert.match(client, new RegExp(`/ozon-match/${action}`));
});
