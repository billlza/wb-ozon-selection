// Runs the Pinduoduo collector against goods pages saved from Chrome ("网页，仅 HTML") and prints what it read.
// Usage: node scripts/check-pinduoduo-saved-page.mjs ~/Desktop/<page>.html [...]
// The saved files may carry the owner's account details, so only product facts and the model's field names are printed:
// never a field value outside the goods object, and the files themselves are read in place, never copied or sent.
import { readFile } from "node:fs/promises";
import { collectPinduoduoPage } from "../extension/1688-capture/collector-pinduoduo.js";
import { sanitizePinduoduoEvidence } from "../lib/source-capture.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：node scripts/check-pinduoduo-saved-page.mjs <保存的拼多多商品页.html> [...]");
  process.exit(2);
}

const scriptBodies = (html) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
const decodeEntities = (value) => value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = (html) => decodeEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

// Field names only, down to the goods object; values are printed solely for price-like numbers of the first SKU.
function modelShape(scripts) {
  const assignment = scripts.find((body) => /rawData\s*=/.test(body));
  const report = { rawDataAssignment: Boolean(assignment), initDataObjMentioned: scripts.some((body) => body.includes('"initDataObj"')) };
  const body = assignment || scripts.find((text) => text.includes('"initDataObj"'));
  if (!body) return report;
  const start = body.indexOf("{", assignment ? body.search(/rawData\s*=/) : body.indexOf('"initDataObj"') - 200);
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let index = Math.max(start, 0); index < body.length; index += 1) {
    const character = body[index];
    if (inString) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') inString = false; continue; }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) { end = index; break; }
  }
  let parsed = null;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { report.parseError = true; return report; }
  report.topLevelKeys = Object.keys(parsed);
  const init = parsed?.store?.initDataObj || parsed?.initDataObj;
  report.initDataObjKeys = init ? Object.keys(init) : null;
  const goods = init?.goods;
  if (!goods) return report;
  report.goodsKeys = Object.keys(goods);
  const sku = Array.isArray(goods.skus) ? goods.skus[0] : null;
  report.skuCount = Array.isArray(goods.skus) ? goods.skus.length : null;
  report.firstSkuKeys = sku ? Object.keys(sku) : null;
  report.firstSkuPriceFields = sku ? Object.fromEntries(Object.entries(sku).filter(([key, value]) => /price/i.test(key) &&
    ["number", "string"].includes(typeof value))) : null;
  report.firstSkuSpecs = sku?.specs ?? null;
  report.goodsPriceFields = Object.fromEntries(Object.entries(goods).filter(([key, value]) => /price/i.test(key) &&
    ["number", "string"].includes(typeof value)));
  report.goodsPropertySample = Array.isArray(goods.goodsProperty) ? goods.goodsProperty.slice(0, 2) : goods.goodsProperty ?? null;
  return report;
}

for (const file of files) {
  const html = await readFile(file, "utf8");
  const scripts = scriptBodies(html);
  const text = visibleText(html);
  const ids = [...new Set([...html.matchAll(/"goods(?:ID|Id|_id)"\s*:\s*"?(\d{1,40})/g), ...html.matchAll(/goods_id=(\d{1,40})/g)].map((match) => match[1]))];
  const goodsId = html.match(/"goods(?:ID|Id|_id)"\s*:\s*"?(\d{1,40})/)?.[1] || ids[0] || "";
  console.log(`\n=== ${file}`);
  console.log(JSON.stringify({
    scripts: scripts.length,
    goodsIdsSeen: ids.slice(0, 5),
    looksLikeLogin: /登录|login/i.test(text.slice(0, 4000)) && !goodsId,
    asksForPhone: /请在手机|手机上打开|打开拼多多App/.test(text),
    firstVisiblePrices: [...text.matchAll(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/g)].slice(0, 5).map((match) => match[1])
  }, null, 2));
  if (!goodsId) { console.log(JSON.stringify({ modelShape: modelShape(scripts) }, null, 2)); continue; }

  const nodes = scripts.map((body) => ({ textContent: body, getAttribute: () => null }));
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  const previousNow = Date.now;
  let reading = previousNow();
  Date.now = () => (reading += 30_000); // A page without a usable model answers at once instead of after 20s.
  globalThis.window = { location: { href: `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}` } };
  globalThis.document = { title, querySelector: () => null, querySelectorAll: (selector) => (selector === "script" ? nodes : []) };
  let result;
  try { result = await collectPinduoduoPage(goodsId); } finally { Date.now = previousNow; }
  let sanitizer = "not_run";
  if (result.status === "captured") {
    try { sanitizePinduoduoEvidence(result.evidence, goodsId); sanitizer = "passed"; } catch (error) { sanitizer = `rejected:${error.message}`; }
  }
  const evidence = result.evidence;
  console.log(JSON.stringify({
    goodsId,
    collector: result.status === "captured" ? "captured" : `failed:${result.failureCode}`,
    sanitizer,
    title: evidence?.title ?? null,
    offerIdSource: evidence?.offerIdSource ?? null,
    supplierAttributeKeys: evidence ? Object.keys(evidence.supplierAttributes) : null,
    skuCount: evidence?.skus.length ?? null,
    firstSkus: evidence?.skus.slice(0, 3).map((sku) => ({ priceCny: sku.priceCny, priceSource: sku.priceSource, stock: sku.stock,
      attributes: sku.attributes, imageHost: sku.imageUrl ? new URL(sku.imageUrl).hostname : null })) ?? null,
    skusWithoutPrice: evidence ? evidence.skus.filter((sku) => sku.priceCny === null).length : null,
    modelShape: modelShape(scripts)
  }, null, 2));
}
