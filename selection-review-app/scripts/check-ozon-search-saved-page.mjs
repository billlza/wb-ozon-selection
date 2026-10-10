// Runs the Ozon search collector against a search result page saved from Chrome and prints what it read: a word search
// (/search/?text=…) or an image search (/search-by-image?image_id=…), told apart by the address Chrome saved it from.
// Usage: node scripts/check-ozon-search-saved-page.mjs ~/Desktop/<page>.html ["俄文搜索词"]（以图搜的页面不用词）
// A logged-in page also carries the buyer's own header, so only the search grid is read: structure facts, field names,
// and each result's public product facts (id, title, price, rating). The file is read in place, never copied or sent.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { collectOzonSearchPage } from "../extension/1688-capture/collector-ozon-search.js";
import { normalizeOzonSearchQuery, ozonImageSearchId, sanitizeOzonImageMatchEvidence } from "../lib/ozon-same-product-match.mjs";

const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&amp;/g, "&");

/** What the saved page holds and what the collector reads from it: { structure, collector, summary }. */
export async function inspectSavedOzonSearchPage(html, queryArgument = "") {
  // Chrome writes the page address into a "saved from url" comment; the words are read from its text parameter, an image
  // search's upload id from its image_id parameter.
  const savedFrom = html.match(/<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/)?.[1] || "";
  let savedQuery = "";
  let imageId = null;
  try {
    const address = new URL(savedFrom);
    savedQuery = address.searchParams.get("text") || "";
    if (/^\/search-by-image\/?$/.test(address.pathname)) imageId = ozonImageSearchId(address.searchParams.get("image_id")) ?? "";
  } catch { savedQuery = ""; }
  const byImage = imageId !== null;
  const query = byImage ? null : normalizeOzonSearchQuery(queryArgument || savedQuery);

  // The whole opening tag around an attribute: quoted values may hold a raw ">" (older Chrome does not escape it).
  const tagAround = index => {
    const start = html.lastIndexOf("<", index);
    let quote = "";
    for (let at = start + 1; at < html.length; at += 1) {
      const char = html[at];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") return html.slice(start, at + 1);
    }
    return html.slice(start);
  };
  const hosts = [...html.matchAll(/\sid="(state-([A-Za-z0-9]+)-[^"]*)"/g)].map(match => {
    const state = tagAround(match.index).match(/\sdata-state="([^"]*)"/)?.[1];
    return { widget: `state-${match[2]}`, id: match[1], state: state === undefined ? null : decode(state) };
  });
  const gridHosts = hosts.filter(host => /^state-(?:searchResultsV2|searchResultsV3|tileGridDesktop)$/.test(host.widget));
  const parsed = gridHosts.map(host => { try { return JSON.parse(host.state || "null"); } catch { return null; } });
  const firstItem = parsed.find(state => Array.isArray(state?.items) && state.items.length)?.items?.[0] ?? null;
  const atomsOf = entry => (Array.isArray(entry?.mainState) ? entry.mainState : []).map(atom => atom?.atom ?? atom);
  const widgetNames = [...html.matchAll(/\sdata-widget="([^"]+)"/g)].map(match => match[1]);
  const structure = {
    savedFromPage: (() => { try { return new URL(savedFrom).hostname + new URL(savedFrom).pathname; } catch { return null; } })(),
    searchBy: byImage ? "image" : "text",
    query,
    widgetCounts: Object.fromEntries([...new Set(widgetNames)].slice(0, 80).map(name => [name, widgetNames.filter(other => other === name).length])),
    stateWidgets: [...new Set(hosts.map(host => host.widget))].slice(0, 80),
    gridStateHosts: gridHosts.length,
    gridStatesParsed: parsed.filter(Boolean).length,
    gridItems: parsed.reduce((sum, state) => sum + (Array.isArray(state?.items) ? state.items.length : 0), 0),
    firstItemKeys: firstItem && typeof firstItem === "object" ? Object.keys(firstItem) : null,
    firstItemAtoms: firstItem ? atomsOf(firstItem).map(atom => ({ type: atom?.type ?? null, id: atom?.id ?? null,
      keys: atom && typeof atom === "object" ? Object.keys(atom[atom.type] ?? {}).slice(0, 12) : [] })) : null,
    firstItemTileImageKeys: firstItem?.tileImage && typeof firstItem.tileImage === "object" ? Object.keys(firstItem.tileImage) : null,
    firstItemLinkShape: typeof firstItem?.action?.link === "string" ? firstItem.action.link.split("?")[0].replace(/\d{5,}/g, "<id>") : null,
    productLinks: new Set([...html.matchAll(/href="[^"]*\/product\/(?:[^"/]*-)?(\d{5,20})\/?[^"]*"/g)].map(match => match[1])).size,
    ozonImages: (html.match(/https:\/\/ir\.ozone\.ru\/[^"'\s)]+/g) || []).length,
    scriptStateMentions: (html.match(/<script[^>]*>[^<]*searchResultsV2/g) || []).length
  };
  if (byImage && !imageId) return { structure, collector: { status: "failed", failureCode: "image_id_missing" }, summary: null };
  if (!byImage && !query) return { structure, collector: { status: "failed", failureCode: "query_missing" }, summary: null };

  const states = gridHosts.map(host => ({ getAttribute: name => (name === "data-state" ? host.state : name === "id" ? host.id : null) }));
  const previous = { window: globalThis.window, document: globalThis.document, now: Date.now };
  let reading = previous.now();
  Date.now = () => (reading += 2_000);
  globalThis.window = { location: { href: byImage ? `https://www.ozon.ru/search-by-image?image_id=${imageId}`
    : `https://www.ozon.ru/search/?${new URLSearchParams({ text: query })}` } };
  globalThis.document = { title: "", body: { innerText: "" }, querySelector: () => null,
    querySelectorAll: selector => (selector.includes("state-searchResultsV2") ? states : []) };
  let result;
  try { result = await collectOzonSearchPage(byImage ? { imageId } : query, 36); }
  finally { globalThis.window = previous.window; globalThis.document = previous.document; Date.now = previous.now; }
  if (result.status !== "captured") return { structure, collector: result, summary: null };

  let sanitizer;
  try {
    sanitizer = `accepted ${sanitizeOzonImageMatchEvidence(result.evidence, query, { searchBy: byImage ? "image" : "text" }).items.length} items`;
  }
  catch (error) { sanitizer = `rejected: ${error.message}`; }
  const items = result.evidence.items;
  return {
    structure,
    collector: { status: "captured" },
    summary: {
      readFrom: result.evidence.readFrom,
      cardCount: result.evidence.cardCount,
      itemCount: items.length,
      withTitle: items.filter(item => item.title).length,
      withImage: items.filter(item => item.imageUrl).length,
      withPrice: items.filter(item => item.priceRub !== null).length,
      withOriginalPrice: items.filter(item => item.originalPriceRub !== null).length,
      withRating: items.filter(item => item.rating !== null).length,
      withReviews: items.filter(item => item.reviewCount !== null).length,
      ads: items.filter(item => item.isAd).length,
      sanitizer,
      firstThree: items.slice(0, 3).map(item => ({ productId: item.productId, title: item.title.slice(0, 60), priceRub: item.priceRub,
        rating: item.rating, reviewCount: item.reviewCount }))
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, queryArgument = ""] = process.argv.slice(2);
  if (!file) {
    console.error("用法：node scripts/check-ozon-search-saved-page.mjs <保存的Ozon搜索结果页.html> [俄文搜索词]");
    process.exit(2);
  }
  const report = await inspectSavedOzonSearchPage(await readFile(file, "utf8"), queryArgument);
  console.log(JSON.stringify(report, null, 2));
  if (report.collector.failureCode === "query_missing") {
    console.log("没有读到搜索词：保存的页面里没有 saved from url，请把搜索词作为第二个参数传进来。");
  }
  if (report.collector.status !== "captured") process.exit(1);
}
