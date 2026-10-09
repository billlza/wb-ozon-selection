import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect1688Page } from "../extension/1688-capture/collector.js";
import { sanitize1688Evidence } from "../lib/source-capture.mjs";
import {
  SYNTHETIC_1688_INLINE_SCRIPT,
  SYNTHETIC_1688_OFFER_ID,
  SYNTHETIC_1688_SOURCE_URL
} from "./fixtures/a-supplier-1688-inline-context-fixture.mjs";
import { harness, idle, startCapture, supplierJob } from "./helpers/extension-runtime-fixture.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Synthetic script-text document harness; it does not execute scripts or expose MAIN-world models. */
function pageDocument({ scripts = [], blocked = null, title = "" } = {}) {
  const nodes = scripts.map((script) => (typeof script === "string"
    ? { textContent: script, getAttribute: () => null }
    : { textContent: script.text, getAttribute: (name) => (name === "type" ? script.type : null) }));
  return {
    title,
    body: { innerText: "" },
    querySelector(selector) {
      if (blocked === "captcha" && selector.includes("nc_1_wrapper")) return { id: "nc_1_wrapper" };
      if (blocked === "login" && selector.includes("login")) return { id: "loginForm" };
      return null;
    },
    querySelectorAll(selector) {
      return selector === "script" ? nodes : [];
    }
  };
}

async function collectFrom(document, { offerId = SYNTHETIC_1688_OFFER_ID, expected = SYNTHETIC_1688_OFFER_ID, skipPollBudget = false } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNow = Date.now;
  globalThis.window = {
    location: { href: `https://detail.1688.com/offer/${offerId}.html`, pathname: `/offer/${offerId}.html` }
  };
  globalThis.document = document;
  // A page that will never produce a model still costs the collector its full 20s in-page budget. Cases that assert
  // what happens *after* that budget expires move the clock instead of holding the suite for twenty seconds each.
  if (skipPollBudget) {
    let reading = previousNow();
    Date.now = () => (reading += 30_000);
  }
  try {
    return await collect1688Page(expected);
  } finally {
    Date.now = previousNow;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

const inlinePage = (extra = {}) => pageDocument({ scripts: [SYNTHETIC_1688_INLINE_SCRIPT], ...extra });

test("1688 collector reads offer, title, prices and weighted SKUs from a purely synthetic inline context script", async () => {
  const result = await collectFrom(inlinePage());

  assert.equal(result.status, "captured");
  assert.equal(result.evidence.offerId, SYNTHETIC_1688_OFFER_ID);
  assert.equal(result.evidence.offerIdSource, "offerBaseInfo.offerId");
  assert.equal(result.evidence.sourceUrl, SYNTHETIC_1688_SOURCE_URL);
  assert.equal(result.evidence.title, "纯合成供应商品用于解析测试");
  assert.equal(result.evidence.titleSource, "offerDetail.subject");
  assert.equal(result.evidence.offerStatus, "PUBLISHED");
  assert.deepEqual(result.evidence.priceRanges, [
    { minimumQuantity: 1, priceCny: 27.4, source: "tradeModel.offerPriceModel.currentPrices" },
    { minimumQuantity: 1, priceCny: 58.6, source: "tradeModel.offerPriceModel.currentPrices" }
  ]);
  assert.equal(result.evidence.supplierAttributes["材质"], "合成测试材质A");
  assert.equal(result.evidence.supplierAttributes["产品类别"], "合成测试类目");

  // Six synthetic SKUs, each with its own price, stock and shipping weight — the weight-only id invents nothing.
  assert.equal(result.evidence.skus.length, 6);
  const cheapest = result.evidence.skus.find((sku) => sku.sourceSkuId === "9999999000002");
  assert.equal(cheapest.priceCny, 27.4);
  assert.equal(cheapest.priceSource, "tradeModel.skuMap[0].price");
  assert.equal(cheapest.stock, 731);
  assert.equal(cheapest.inStock, true);
  assert.deepEqual(cheapest.weight, { value: 0.147, unit: "kg" });
  assert.equal(cheapest.weightSource, "detailDescription.freightInfo.skuWeight");
  // The synthetic &gt; label must decode into the directly supplied specification, not markup.
  assert.deepEqual(cheapest.attributes, { "规格": "合成橙>合成S1（背长21cm）", "颜色": "合成橙", "尺码": "合成S1（背长21cm）" });
  assert.deepEqual(result.evidence.skus.map((sku) => sku.priceCny), [27.4, 31.8, 36.2, 27.4, 31.8, 36.2]);
  assert.deepEqual(result.evidence.skus.map((sku) => sku.weight.value), [0.147, 0.162, 0.185, 0.147, 0.162, 0.185]);
  assert.equal(result.evidence.skus.some((sku) => sku.sourceSkuId === "9999999000011"), false);

  // A range price is not a unit price and the page does not state one: recording null keeps B stage honest.
  assert.equal(result.evidence.pageFields.unitProductPriceCny, null);
  assert.equal(result.evidence.pageFields.unitDomesticFreightCny, null);

  const evidence = sanitize1688Evidence(result.evidence, SYNTHETIC_1688_OFFER_ID);
  assert.equal(evidence.skus.length, 6);
  assert.equal(evidence.skus[0].priceCny, 27.4);
  assert.equal(evidence.title, result.evidence.title);
});

test("the inline capture result satisfies the background result contract and is reported unchanged", async () => {
  const collected = await collectFrom(inlinePage());
  const job = supplierJob({ sourceUrl: SYNTHETIC_1688_SOURCE_URL, expectedOfferId: SYNTHETIC_1688_OFFER_ID });
  const h = harness({ job, destination: SYNTHETIC_1688_SOURCE_URL, execute: () => [{ result: collected }] });

  assert.equal((await startCapture(h.runtime, job.captureId)).accepted, true);
  await idle(h.runtime);

  const reported = h.calls.requests.at(-1).body;
  assert.equal(reported.status, "captured");
  assert.equal(reported.resolvedSourceUrl, SYNTHETIC_1688_SOURCE_URL);
  assert.equal(reported.evidence.offerId, SYNTHETIC_1688_OFFER_ID);
  assert.equal(reported.evidence.sourceUrl, SYNTHETIC_1688_SOURCE_URL);
  assert.equal(reported.evidence.skus.length, 6);
  assert.deepEqual(reported.evidence.skus[0].weight, { value: 0.147, unit: "kg" });
});

test("a mismatched offer in the inline context is rejected before any SKU is returned", async () => {
  // The synthetic tab carries the fixture offer; the job requests another identity.
  const result = await collectFrom(inlinePage(), { expected: "999999000012" });
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "wrong_offer");
  assert.equal(result.evidence, undefined);

  // And the reverse: the URL is the requested offer, but the inline model declares another one.
  const mismatch = await collectFrom(
    pageDocument({ scripts: [SYNTHETIC_1688_INLINE_SCRIPT.replace(/"offerId":999999000001/g, '"offerId":999999000012')] }),
    { offerId: SYNTHETIC_1688_OFFER_ID, expected: SYNTHETIC_1688_OFFER_ID }
  );
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.failureCode, "wrong_offer");
});

test("a verification or login wall stops the inline capture with its own failure code", async () => {
  const verification = await collectFrom(inlinePage({ blocked: "captcha" }));
  assert.equal(verification.status, "failed");
  assert.equal(verification.failureCode, "site_verification_required");
  assert.equal(verification.offerId, SYNTHETIC_1688_OFFER_ID);

  const login = await collectFrom(inlinePage({ blocked: "login" }));
  assert.equal(login.status, "failed");
  assert.equal(login.failureCode, "site_login_required");
});

test("quoting 1688's bare numeric keys never rewrites text that merely looks like one inside a string", async () => {
  // Both traps sit inside JSON strings: a brace/comma followed by digits and a colon. A string-blind repair would
  // corrupt the synthetic product title and attributes; the collector must return them character for character.
  const trapTitle = "口袋尺寸 {123:456} 与侧标 ,789: 均为文字";
  const trapValue = "备注{42:7},标注 ,8: 结束";
  const script = SYNTHETIC_1688_INLINE_SCRIPT
    .replaceAll(/"subject":"[^"]*"/g, `"subject":${JSON.stringify(trapTitle)}`)
    .replace('"name":"材质","outputType":0,"value":"合成测试材质A"', `"name":"材质","outputType":0,"value":${JSON.stringify(trapValue)}`);

  const result = await collectFrom(pageDocument({ scripts: [script] }));

  assert.equal(result.status, "captured");
  assert.equal(result.evidence.title, trapTitle);
  assert.equal(result.evidence.supplierAttributes["材质"], trapValue);
  // The genuine bare keys in the same payload are still repaired, so weights survive alongside the traps.
  assert.deepEqual(result.evidence.skus[0].weight, { value: 0.147, unit: "kg" });
});

test("an inline script without the page model yields no evidence instead of a guess", async () => {
  const unrelated = await collectFrom(pageDocument({ scripts: ['window.__ad = {"result":{"data":{}}};'] }), { skipPollBudget: true });
  assert.equal(unrelated.status, "failed");
  assert.equal(unrelated.failureCode, "structured_data_unavailable");

  // The same payload emitted twice is one statement said twice, so it is still read.
  const duplicated = await collectFrom(pageDocument({ scripts: [SYNTHETIC_1688_INLINE_SCRIPT, SYNTHETIC_1688_INLINE_SCRIPT] }));
  assert.equal(duplicated.status, "captured");
  assert.equal(duplicated.evidence.skus.length, 6);

  // Two copies that disagree cannot both be the page's statement, so neither is trusted.
  const contradicted = await collectFrom(pageDocument({
    scripts: [SYNTHETIC_1688_INLINE_SCRIPT, SYNTHETIC_1688_INLINE_SCRIPT.replace(/"price":"27\.40"/g, '"price":"2.50"')]
  }), { skipPollBudget: true });
  assert.equal(contradicted.status, "failed");
  assert.equal(contradicted.failureCode, "structured_data_unavailable");
});

test("the injected collector stays self-contained and never executes page script or reads MAIN-world globals", async () => {
  const source = await readFile(path.join(appDir, "extension", "1688-capture", "collector.js"), "utf8");

  // chrome.scripting.executeScript({ func }) serializes the function alone: a module-scope reference would throw
  // ReferenceError inside the tab, so nothing may live at column 0 except the function's own opening and closing.
  const topLevel = source.split("\n").filter((line) => line !== "" && !/^[\s}]/.test(line));
  assert.deepEqual(topLevel, ["export async function collect1688Page(expectedOfferId) {"]);
  assert.equal(source.trimEnd().endsWith("\n}"), true);

  // Comment lines quote the page's own wrapper syntax; only executable lines are searched for it.
  const code = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  for (const forbidden of [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\bwindow\s*\.\s*context\b/, /\bglobalThis\b/]) {
    assert.doesNotMatch(code, forbidden, `collector must not contain ${forbidden}`);
  }
  // window is read for the page identity only; the model always comes from script text.
  assert.deepEqual([...code.matchAll(/\bwindow\.\w+/g)].map((match) => match[0]), ["window.location"]);
  assert.match(source, /never executed and no\s*\n\s*\/\/ MAIN-world global is ever read/);
});
