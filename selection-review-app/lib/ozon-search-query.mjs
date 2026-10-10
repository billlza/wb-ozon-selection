/**
 * 在 Ozon 找同款用的搜索词：怎么认、搜索地址怎么拼、预先填什么词。服务端排作业和商品页的输入框读的都是这一份，
 * 所以这里不碰网络、也不碰图片解码。
 */
export const OZON_SEARCH_QUERY_MAX_LENGTH = 100;

/** 与插件 extension/1688-capture/source-routing.js 里的 normalizeOzonSearchQuery 逐字一致。 */
export function normalizeOzonSearchQuery(value) {
  if (typeof value !== "string") return null;
  const query = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u00a0\u2000-\u200b\u2028\u2029\u202f\u3000]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (query.length < 2 || query.length > OZON_SEARCH_QUERY_MAX_LENGTH || !/\p{L}/u.test(query) || /[<>{}]|:\/\//.test(query)) return null;
  return query;
}

/** 与插件里的 ozonSearchUrl 逐字一致：只搜 Ozon 自己的站内搜索，词放在它自己的 text 参数里。 */
export function ozonSearchUrl(query) {
  const normalized = normalizeOzonSearchQuery(query);
  if (!normalized || normalized !== query) return null;
  return `https://www.ozon.ru/search/?${new URLSearchParams({ text: normalized, from_global: "true" })}`;
}

/**
 * Ozon 以图搜（2025 年 9 月起网页版就有，主人 2026-10-10 在自己的 Chrome 里试过）：在 Ozon 首页的搜索栏上传一张图，
 * Ozon 把它跳到 /search-by-image?image_id=…。image_id 是 Ozon 给这次上传编的号，看不出是哪张原图。
 * 插件从这个首页开始；搜索栏在每一页都有，首页是固定、最短的那个地址。
 */
export const OZON_IMAGE_SEARCH_ENTRY_URL = "https://www.ozon.ru/";
export const OZON_SEARCH_BY = Object.freeze(["image", "text"]);
const OZON_IMAGE_SEARCH_ID = /^[0-9a-f]{8,64}(?:x[0-9a-f]{8,64})?$/i;

/** 与插件里的 ozonImageSearchId 逐字一致：Ozon 结果页地址里的 image_id，只认十六进制和中间那个 x。 */
export function ozonImageSearchId(value) {
  return typeof value === "string" && OZON_IMAGE_SEARCH_ID.test(value) ? value : null;
}

const OZON_PRODUCT_PATH = /^\/product\/(?:[^/]*-)?(\d{5,20})\/?$/;
export function ozonProductId(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "www.ozon.ru" || url.hostname === "ozon.ru")
      ? url.pathname.match(OZON_PRODUCT_PATH)?.[1] ?? null : null;
  } catch { return null; }
}

const CYRILLIC = /[\u0400-\u04ff]/;
// 一条 Ozon 标题当搜索词太长：逗号前那一段、最多 8 个词，正好是它自己写的商品名。
function queryFromTitle(value) {
  if (typeof value !== "string" || !CYRILLIC.test(value)) return null;
  const head = value.split(/[,;|(]/)[0];
  return normalizeOzonSearchQuery(head.split(/\s+/).filter(Boolean).slice(0, 8).join(" ").slice(0, OZON_SEARCH_QUERY_MAX_LENGTH));
}

/**
 * 预先填好的搜索词：上一次在 Ozon 找同款用过的词；没有的话，这件商品自己在 Ozon 上的俄文标题。都没有就空着，等主人填。
 * 只是建议，主人改了以后用主人的。
 */
export function suggestedOzonSearchQuery(candidate) {
  const last = normalizeOzonSearchQuery(candidate?.ozonImageMatch?.query);
  if (last) return { query: last, origin: "last_search" };
  const snapshots = Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [];
  for (const snapshot of [...snapshots].reverse()) {
    const query = queryFromTitle(snapshot?.title);
    if (query) return { query, origin: "ozon_title" };
  }
  const named = queryFromTitle(candidate?.productName);
  return named ? { query: named, origin: "ozon_title" } : { query: "", origin: null };
}
