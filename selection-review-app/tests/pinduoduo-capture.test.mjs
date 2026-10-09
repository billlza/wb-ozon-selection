import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectPinduoduoPage } from "../extension/1688-capture/collector-pinduoduo.js";
import { validateSupplierCaptureRequest } from "../extension/1688-capture/capture-request.js";
import { classifyPinduoduoSource, classifySupplierSource } from "../extension/1688-capture/source-routing.js";
import {
  extractPinduoduoGoodsId,
  normalizePinduoduoCaptureSource,
  normalizeSupplierCaptureSource,
  sanitize1688Evidence,
  sanitizePinduoduoEvidence,
  sourceCaptureFailureMessage,
  supplierPlatformLabel
} from "../lib/source-capture.mjs";
import { adapt1688CaptureToSupplierOption, validateSupplierOption } from "../lib/supplier-option.mjs";
import { harness, idle, startCapture, supplierJob } from "./helpers/extension-runtime-fixture.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Purely synthetic goods; no real Pinduoduo page, account or share token is used.
const GOODS_ID = "123456789012";
const GOODS_URL = `https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}`;

function syntheticGoods(extra = {}) {
  return {
    goodsID: Number(GOODS_ID),
    goodsName: "合成测试 宠物背心",
    isOnSale: true,
    goodsProperty: [{ key: "材质", values: ["牛津布"] }, { key: "适用对象", values: ["猫", "小型犬"] }],
    skus: [
      { skuId: 9001, groupPrice: 12.9, normalPrice: 15.9, quantity: 30,
        thumbUrl: "https://img.pddpic.com/mms-material-img/synthetic-a.jpeg?imageView2/2/w/400",
        specs: [{ spec_key: "颜色", spec_value: "红色" }, { spec_key: "尺码", spec_value: "S" }] },
      { skuId: 9002, group_price: 1390, quantity: 0, thumbUrl: "https://cbu01.alicdn.com/synthetic.jpg",
        specs: [{ spec_key: "颜色", spec_value: "蓝色" }, { spec_key: "尺码", spec_value: "M" }] },
      { skuId: 9003, normalPrice: 15.9, quantity: 5, specs: [{ spec_key: "颜色", spec_value: "黑色" }, { spec_key: "尺码", spec_value: "L" }] }
    ],
    ...extra
  };
}

const rawDataScript = (goods) => `window.rawData=${JSON.stringify({ store: { initDataObj: { goods } } })};`;

/** Synthetic script-text document; nothing is executed and no MAIN-world global exists. */
function pageDocument(scripts) {
  const nodes = scripts.map((text) => ({ textContent: text, getAttribute: () => null }));
  return { title: "", querySelector: () => null, querySelectorAll: (selector) => (selector === "script" ? nodes : []) };
}

async function collectFrom(document, { href = GOODS_URL, expected = GOODS_ID, skipPollBudget = false } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNow = Date.now;
  globalThis.window = { location: { href } };
  globalThis.document = document;
  // A page that never yields one model costs the collector its 20s budget; such cases move the clock instead.
  if (skipPollBudget) {
    let reading = previousNow();
    Date.now = () => (reading += 30_000);
  }
  try {
    return await collectPinduoduoPage(expected);
  } finally {
    Date.now = previousNow;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

test("Pinduoduo links reduce to one canonical goods page, share links stay short links, and 1688 is untouched", () => {
  assert.deepEqual(normalizePinduoduoCaptureSource(`https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}&_wvx=1&refer_share_uid=9`),
    { type: "detail", sourceUrl: GOODS_URL, offerId: GOODS_ID });
  assert.deepEqual(normalizePinduoduoCaptureSource(`https://mobile.pinduoduo.com/goods1.html?goods_id=${GOODS_ID}`),
    { type: "detail", sourceUrl: GOODS_URL, offerId: GOODS_ID });
  assert.deepEqual(normalizePinduoduoCaptureSource("https://p.pinduoduo.com/AbC_12-x"),
    { type: "short", sourceUrl: "https://p.pinduoduo.com/AbC_12-x", offerId: "" });
  assert.deepEqual(normalizePinduoduoCaptureSource("https://mobile.yangkeduo.com/goods2.html?ps=Tok3n"),
    { type: "short", sourceUrl: "https://mobile.yangkeduo.com/goods2.html?ps=Tok3n", offerId: "" });
  for (const rejected of [
    `http://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}`,
    `https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}&goods_id=1`,
    "https://mobile.yangkeduo.com/goods.html?goods_id=abc",
    `https://evil.example/goods.html?goods_id=${GOODS_ID}`,
    `https://user:pass@mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}`,
    "https://mobile.yangkeduo.com/search_result.html?search_key=x"
  ]) assert.equal(normalizePinduoduoCaptureSource(rejected).type, "invalid", rejected);
  assert.equal(extractPinduoduoGoodsId(`https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}`), GOODS_ID);
  assert.equal(extractPinduoduoGoodsId("https://p.pinduoduo.com/AbC"), "");

  assert.deepEqual(normalizeSupplierCaptureSource("https://detail.1688.com/offer/876240928352.html?spm=x"),
    { platform: "1688", type: "detail", sourceUrl: "https://detail.1688.com/offer/876240928352.html", offerId: "876240928352" });
  assert.equal(normalizeSupplierCaptureSource(GOODS_URL).platform, "pinduoduo");
  assert.deepEqual(normalizeSupplierCaptureSource("https://example.com/x"), { platform: null, type: "invalid", sourceUrl: "", offerId: "" });
  assert.equal(supplierPlatformLabel("pinduoduo"), "拼多多");
  assert.equal(supplierPlatformLabel("1688"), "1688");
});

test("the extension reads a Pinduoduo link exactly as the service does", () => {
  for (const input of [
    `https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}&_wvx=1`,
    `https://mobile.pinduoduo.com/goods2.html?goods_id=${GOODS_ID}`,
    "https://p.pinduoduo.com/AbC_12-x",
    "https://mobile.yangkeduo.com/goods2.html?ps=Tok3n",
    `https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}&goods_id=1`,
    `http://mobile.yangkeduo.com/goods.html?goods_id=${GOODS_ID}`,
    "https://p.pinduoduo.com/a/b"
  ]) {
    const service = normalizePinduoduoCaptureSource(input);
    const extension = classifyPinduoduoSource(input);
    assert.deepEqual(extension, service.type === "invalid" ? null : service, input);
  }
  assert.equal(classifySupplierSource("https://qr.1688.com/s/fixture").platform, "1688");
  assert.equal(classifySupplierSource(GOODS_URL).platform, "pinduoduo");
});

test("a Pinduoduo job passes the extension's request check under the same rules as a 1688 job", () => {
  const detail = supplierJob({ sourceUrl: GOODS_URL, expectedOfferId: GOODS_ID });
  assert.equal(validateSupplierCaptureRequest({ payload: detail, manifestVersion: "1.2.8" }).ok, true);
  const short = supplierJob({ sourceUrl: "https://p.pinduoduo.com/AbC", expectedOfferId: "", allowShortLinkResolution: true });
  assert.equal(validateSupplierCaptureRequest({ payload: short, manifestVersion: "1.2.8" }).ok, true);
  assert.equal(validateSupplierCaptureRequest({ payload: { ...short, allowShortLinkResolution: false }, manifestVersion: "1.2.8" }).code,
    "short_link_resolution_not_allowed");
  assert.equal(validateSupplierCaptureRequest({ payload: { ...detail, expectedOfferId: "1" }, manifestVersion: "1.2.8" }).code,
    "expected_offer_invalid");
});

test("the Pinduoduo collector reads goods, 拼单价 per SKU and specifications from the inline model only", async () => {
  const result = await collectFrom(pageDocument([rawDataScript(syntheticGoods())]));
  assert.equal(result.status, "captured", JSON.stringify(result));
  const { evidence } = result;
  assert.equal(evidence.offerId, GOODS_ID);
  assert.equal(evidence.sourceUrl, GOODS_URL);
  assert.equal(evidence.title, "合成测试 宠物背心");
  assert.equal(evidence.offerIdSource, "rawData.goods.goodsID");
  assert.equal(evidence.offerStatus, "on_sale");
  assert.deepEqual(evidence.supplierAttributes, { 材质: "牛津布", 适用对象: "猫，小型犬" });
  assert.deepEqual(evidence.priceRanges, []);
  const [red, blue, black] = evidence.skus;
  assert.deepEqual([red.sourceSkuId, red.priceCny, red.priceSource, red.stock, red.inStock],
    ["9001", 12.9, "rawData.goods.skus[0].groupPrice", 30, true]);
  assert.deepEqual(red.attributes, { 颜色: "红色", 尺码: "S" });
  assert.equal(red.imageUrl, "https://img.pddpic.com/mms-material-img/synthetic-a.jpeg");
  // Integer fen under the API's snake_case name is converted exactly; a 1688 picture host is not a Pinduoduo picture.
  assert.deepEqual([blue.priceCny, blue.priceSource, blue.inStock, blue.imageUrl], [13.9, "rawData.goods.skus[1].group_price", false, null]);
  // 单独购买价 is never used to fill a missing 拼单价.
  assert.deepEqual([black.priceCny, black.priceSource], [null, null]);
  assert.equal(red.weight, null);

  const sanitized = sanitizePinduoduoEvidence(evidence, GOODS_ID);
  assert.equal(sanitized.sourceUrl, GOODS_URL);
  assert.equal(sanitized.skus.length, 3);
  assert.throws(() => sanitize1688Evidence(evidence, GOODS_ID), /wrong_offer/);
  assert.throws(() => sanitizePinduoduoEvidence({ ...evidence, sourceUrl: "https://detail.1688.com/offer/123456789012.html" }, GOODS_ID), /wrong_offer/);

  const option = adapt1688CaptureToSupplierOption(sanitized, { evidenceRef: "source-capture:SCJ-synthetic" });
  assert.equal(option.sourcePlatform, "pinduoduo");
  assert.equal(option.supplierOptionId, `supplier-option:pinduoduo:${GOODS_ID}`);
  assert.equal(option.productUrl, GOODS_URL);
  assert.equal(validateSupplierOption({ ...structuredClone(option), productUrl: `https://detail.1688.com/offer/${GOODS_ID}.html` }).valid, false);
});

test("the Pinduoduo collector refuses a page whose address or model names other goods", async () => {
  const otherModel = await collectFrom(pageDocument([rawDataScript(syntheticGoods({ goodsID: 999 }))]));
  assert.equal(otherModel.failureCode, "wrong_offer");
  const otherAddress = await collectFrom(pageDocument([rawDataScript(syntheticGoods())]), {
    href: "https://mobile.yangkeduo.com/goods.html?goods_id=999" });
  assert.equal(otherAddress.failureCode, "wrong_offer");
  const twoModels = await collectFrom(pageDocument([rawDataScript(syntheticGoods()), rawDataScript(syntheticGoods({ goodsName: "另一份" }))]),
    { skipPollBudget: true });
  assert.equal(twoModels.failureCode, "structured_data_unavailable");
});

test("the injected Pinduoduo collector stays self-contained and never executes page script or reads MAIN-world globals", async () => {
  const source = await readFile(path.join(appDir, "extension", "1688-capture", "collector-pinduoduo.js"), "utf8");
  const topLevel = source.split("\n").filter((line) => line !== "" && !/^[\s}]/.test(line));
  assert.deepEqual(topLevel, ["export async function collectPinduoduoPage(expectedGoodsId) {"]);
  assert.equal(source.trimEnd().endsWith("\n}"), true);
  const code = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  for (const forbidden of [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\bwindow\s*\.\s*rawData\b/, /\bglobalThis\b/]) {
    assert.doesNotMatch(code, forbidden, `collector must not contain ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/\bwindow\.\w+/g)].map((match) => match[0]), ["window.location"]);
});

test("the extension follows a Pinduoduo share link to its goods page and reads it with the Pinduoduo collector", async () => {
  const job = supplierJob({ sourceUrl: "https://p.pinduoduo.com/AbC", expectedOfferId: "", allowShortLinkResolution: true });
  const h = harness({ job, destination: `${GOODS_URL}&refer_share_id=synthetic`,
    execute: () => [{ result: { status: "captured", evidence: { offerId: GOODS_ID, sourceUrl: GOODS_URL } } }] });
  assert.equal((await startCapture(h.runtime, job.captureId)).accepted, true);
  await idle(h.runtime);
  assert.equal(h.calls.created[0].url, "https://p.pinduoduo.com/AbC");
  assert.equal(h.calls.executions[0].func, collectPinduoduoPage);
  assert.deepEqual(h.calls.executions[0].args, [GOODS_ID]);
  const report = h.calls.requests.at(-1);
  assert.match(report.url, /\/source-capture\/result$/);
  assert.equal(report.body.status, "captured");
  assert.equal(report.body.resolvedSourceUrl, GOODS_URL);
  assert.deepEqual(h.calls.removed, [7]);
});

test("a Pinduoduo login or verification page, or other goods, ends the job with its reason instead of a capture", async () => {
  for (const [destination, code] of [
    ["https://mobile.yangkeduo.com/login.html?from=synthetic", "site_login_required"],
    ["https://mobile.yangkeduo.com/psnl_verification.html?x=1", "site_verification_required"],
    ["https://mobile.yangkeduo.com/goods.html?goods_id=999", "wrong_offer"],
    ["https://example.com/elsewhere", "short_link_resolution_failed"]
  ]) {
    const job = supplierJob({ sourceUrl: GOODS_URL, expectedOfferId: GOODS_ID });
    const h = harness({ job, destination });
    await startCapture(h.runtime, job.captureId);
    await idle(h.runtime);
    assert.equal(h.calls.executions.length, 0, destination);
    assert.equal(h.calls.requests.at(-1).body.failureCode, code, destination);
  }
});

test("failure wording names Pinduoduo for a Pinduoduo job and stays word for word for 1688", () => {
  assert.equal(sourceCaptureFailureMessage("site_login_required", "", "pinduoduo"), "拼多多页面需要先登录");
  assert.equal(sourceCaptureFailureMessage("short_link_resolution_failed", "", "pinduoduo"), "拼多多短链没有落到可核验的商品详情页");
  assert.equal(sourceCaptureFailureMessage("site_login_required"), "1688页面需要先登录");
  assert.equal(sourceCaptureFailureMessage("extension_not_installed", "", "pinduoduo"), "未检测到本机1688采集扩展");
});
