import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { IMAGE_MATCH_CHANNEL, captureStartMessage, needsCaptureStartSignal } from "../src/captureStart.js";
import { IMAGE_MATCH_JUDGEMENT_LABELS, IMAGE_MATCH_SIMILARITY_LABELS, imageMatchSourceState, supplierImageMatchView } from "../src/supplierImageMatchView.js";
import { IMAGE_SIMILARITY_LABELS } from "../lib/image-fingerprint.mjs";
import { SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS } from "../lib/supplier-image-match.mjs";

// Synthetic display data only: no saved record, no service, no request, no picture download.
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";
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

test("the block appears only for a Pinduoduo capture or an earlier search, and says why a search cannot start", () => {
  assert.equal(supplierImageMatchView(candidate({ sourceCapture: capture({ sourceUrl: "https://detail.1688.com/offer/123456789.html" }) })), null);
  assert.equal(supplierImageMatchView(candidate({ sourceCapture: null })), null);
  const ready = supplierImageMatchView(candidate());
  assert.deepEqual([ready.sourceReady, ready.canStart, ready.sourceImageUrl, ready.lowestPriceCny, ready.status], [true, true, IMAGE, 16.5, null]);
  const old = supplierImageMatchView(candidate({ sourceCapture: capture({ mainImageUrl: null }) }));
  assert.deepEqual([old.sourceReady, old.canStart], [false, false]);
  assert.match(old.sourceReason, /重新采一次/);
  assert.equal(imageMatchSourceState(candidate({ sourceCapture: capture({ status: "needs_sku_selection" }) })).ready, false);
  assert.equal(supplierImageMatchView(candidate({ workflowStatus: "eliminated" })).canStart, false);
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
const pageProps = extra => ({ view: null, extensionStatus: { code: "connected", label: "插件已连接" }, onSaveDraft: forbidden,
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
  const withoutHandlers = await render(pageProps({ candidate: candidate(), onStartImageMatch: null }));
  assert.doesNotMatch(withoutHandlers, /在 1688 找同款/);
});

test("the app wires the three image-match actions and sends the image-match start signal after a new job", async () => {
  const app = await readFile(fileURLToPath(new URL("../src/App.jsx", import.meta.url)), "utf8");
  assert.match(app, /onStartImageMatch=\{payload => startSupplierImageMatch\(payload\)\}/);
  assert.match(app, /startQueuedSupplierCapture\(result,\{channel:IMAGE_MATCH_CHANNEL\}\)/);
  assert.match(app, /onJudgeImageMatch=\{payload => writeSupplierImageMatch\(api\.judgeSupplierImageMatch, payload\)\}/);
});
