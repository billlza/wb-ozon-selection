// Runs the 1688 image-search collector against a result page saved from Chrome and prints what it read.
// Usage: node scripts/check-1688-image-search-saved-page.mjs ~/Desktop/<page>.html [pinduoduo first-picture address]
// The saved file carries the owner's account details, so only product facts and field names are printed — never a
// login, member, session or ad-click value — and the file is read in place, never copied or sent.
import { readFile } from "node:fs/promises";
import { collect1688ImageSearchPage } from "../extension/1688-capture/collector-1688-image-search.js";
import { sanitizeSupplierImageMatchEvidence } from "../lib/supplier-image-match.mjs";

const [file, expectedArgument = ""] = process.argv.slice(2);
if (!file) {
  console.error("用法：node scripts/check-1688-image-search-saved-page.mjs <保存的1688搜图结果页.html> [拼多多首图地址]");
  process.exit(2);
}
const html = await readFile(file, "utf8");
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attributesOf = tag => Object.fromEntries([...tag.matchAll(/\s([a-zA-Z0-9_:-]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));

// One card per opening tag that names a data-renderkey; its props and report may sit on that tag or inside it.
const openings = [...html.matchAll(/<[a-zA-Z][^>]*\sdata-renderkey="[^"]*"[^>]*>/g)];
const cards = openings.map((match, index) => {
  const own = attributesOf(match[0]);
  const inside = html.slice(match.index, openings[index + 1]?.index ?? html.length);
  const find = name => own[name] ?? (inside.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] !== undefined
    ? decode(inside.match(new RegExp(`\\s${name}="([^"]*)"`))[1]) : null);
  const attributes = { "data-renderkey": own["data-renderkey"], "data-index": own["data-index"] ?? null,
    "data-ftk-fiber-props": find("data-ftk-fiber-props"), "data-aplus-report": find("data-aplus-report") };
  return { getAttribute: name => attributes[name] ?? null, hasAttribute: name => attributes[name] !== null && attributes[name] !== undefined,
    querySelector: () => null };
});

const firstProps = (() => { try { return JSON.parse(cards[0]?.getAttribute("data-ftk-fiber-props") || "null"); } catch { return null; } })();
const model = [firstProps, firstProps?.data, firstProps?.item, firstProps?.offer].find(entry => entry && typeof entry === "object" && entry.offerId !== undefined);
const report = cards[0]?.getAttribute("data-aplus-report") || "";
console.log(JSON.stringify({
  cardsWithRenderKey: cards.length,
  cardsWithProps: cards.filter(card => card.getAttribute("data-ftk-fiber-props")).length,
  cardsWithReport: cards.filter(card => card.getAttribute("data-aplus-report")).length,
  firstCardFieldNames: model ? Object.keys(model) : null,
  firstCardQuantityFacts: model ? { priceInfo: model.priceInfo ?? null, priceDesc: model.priceDesc ?? null, quantityPrices: model.quantityPrices ?? null } : null,
  // Only the leading name of each segment: "sessionId@…" and similar carry session values that must not be printed.
  firstReportKeys: report.split(/[\^;]/).map(part => part.match(/^[A-Za-z_][A-Za-z0-9_.-]{0,40}/)?.[0]).filter(Boolean).slice(0, 60),
  firstReportHasQueryUrl: /query_url/.test(report),
  firstReportHasCosScore: /cosScore/.test(report)
}, null, 2));

// The same reading as the collector: query_url ends at the next ^, ; or & (inside sp_expo_data the fields are ;-separated).
const echoed = (() => {
  const raw = report.match(/(?:^|[\^&{,;"\s@=])query_url["']?\s*[:=]\s*["']?([^\^&"'\s,;}]+)/)?.[1];
  let value = raw || "";
  try { for (let round = 0; round < 3 && /%[0-9A-Fa-f]{2}/.test(value); round += 1) value = decodeURIComponent(value); }
  catch { return ""; }
  try { const url = new URL(value.split(/[;\s"'^,}]/)[0]); return `${url.origin}${url.pathname}`; } catch { return ""; }
})();
const expected = expectedArgument || echoed;
const previous = { window: globalThis.window, document: globalThis.document, now: Date.now };
let reading = previous.now();
Date.now = () => (reading += 30_000);
globalThis.window = { location: { href: "https://air.1688.com/kapp/1688-search/pc-image-search/" } };
globalThis.document = { body: { innerText: "" }, querySelector: () => null,
  querySelectorAll: selector => (selector === "[data-renderkey]" ? cards : []) };
let result;
try { result = await collect1688ImageSearchPage(expected, 20); }
finally { globalThis.window = previous.window; globalThis.document = previous.document; Date.now = previous.now; }

if (result.status !== "captured") {
  console.log(JSON.stringify({ collector: result, expectedImageFromPage: echoed || null }, null, 2));
  process.exit(1);
}
let sanitizer;
try { sanitizer = `accepted ${sanitizeSupplierImageMatchEvidence(result.evidence, expected).items.length} items`; }
catch (error) { sanitizer = `rejected: ${error.message}`; }
console.log(JSON.stringify({
  collector: "captured",
  searchImageUrl: result.evidence.searchImageUrl,
  cardCount: result.evidence.cardCount,
  itemCount: result.evidence.items.length,
  withPrice: result.evidence.items.filter(item => item.priceCny !== null).length,
  withQuantityBegin: result.evidence.items.filter(item => item.quantityBegin !== null).length,
  withVendorSimilarity: result.evidence.items.filter(item => item.vendorSimilarity !== null).length,
  withImage: result.evidence.items.filter(item => item.imageUrl !== null).length,
  ads: result.evidence.items.filter(item => item.isAd).length,
  sanitizer,
  firstFive: result.evidence.items.slice(0, 5).map(item => ({ offerId: item.offerId, title: item.title.slice(0, 40), priceCny: item.priceCny,
    priceNote: item.priceNote, quantityBegin: item.quantityBegin, vendorSimilarity: item.vendorSimilarity, isAd: item.isAd }))
}, null, 2));
