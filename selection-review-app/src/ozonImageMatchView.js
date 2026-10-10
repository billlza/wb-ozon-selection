import { normalizeOzonSearchQuery, suggestedOzonSearchQuery } from "../lib/ozon-search-query.mjs";
import { SUPPLIER_IMAGE_MATCH_SOURCE_LABELS, supplierImageMatchSource } from "../lib/supplier-image-match-source.mjs";
import { IMAGE_MATCH_JUDGEMENT_LABELS, IMAGE_MATCH_SIMILARITY_LABELS } from "./supplierImageMatchView.js";

/**
 * 商品页「在 Ozon 找同款」那一块要显示的东西，全部从服务端保存的 candidate.ozonImageMatch、这件商品的首图和它自己的
 * Ozon 标题里读出来。比对用哪张图、搜索词怎么认，和服务端读的是同一份规则（lib/supplier-image-match-source.mjs、
 * lib/ozon-search-query.mjs）。页面不判断是不是同款，只把首图像不像排出来，是不是同款由主人逐条点。
 */
const SIMILARITY_ORDER = Object.freeze(["identical", "similar", "unknown", "different"]);
const QUERY_ORIGIN_NOTES = Object.freeze({
  last_search: "上次在 Ozon 搜用的词，可以改。",
  ozon_title: "取自这件商品在 Ozon 上的标题，可以改。"
});
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);

function statusLine(record, counts) {
  switch (record.status) {
    case "waiting_extension": return "已经排队，等插件领取……";
    case "searching": return `插件正在 Ozon 上搜「${record.query}」……`;
    case "comparing": return `已读回 ${record.results.length} 条，正在比对首图……`;
    case "compared": return `Ozon 用「${record.query}」搜到 ${record.cardCount ?? "?"} 条，读回前 ${record.results.length} 条：首图一致 ` +
      `${counts.identical} 条、很像 ${counts.similar} 条、不像 ${counts.different} 条${counts.unknown ? `、无法比对 ${counts.unknown} 条` : ""}。` +
      "是不是同款请你逐条判断。";
    case "failed": return typeof record.reason === "string" && record.reason ? record.reason : "这次在 Ozon 找同款已经停下。";
    default: return "";
  }
}

/** 整块的显示数据。没有首图可比、也没有在 Ozon 找过同款时返回 null，这一块就不出现。 */
export function ozonImageMatchView(candidate) {
  const picture = supplierImageMatchSource(candidate);
  const record = isObject(candidate?.ozonImageMatch) ? candidate.ozonImageMatch : null;
  if (!picture.ok && record === null && picture.code !== "main_image_missing") return null;
  const suggestion = suggestedOzonSearchQuery(candidate);
  const results = Array.isArray(record?.results) ? record.results : [];
  const judgements = isObject(record?.judgements) ? record.judgements : {};
  const counts = { identical: 0, similar: 0, different: 0, unknown: 0 };
  for (const item of results) counts[SIMILARITY_ORDER.includes(item?.similarity) ? item.similarity : "unknown"] += 1;
  const inFlight = record !== null && (["waiting_extension", "searching"].includes(record.status) || ["queued", "claimed"].includes(record.jobStatus));
  const rows = results.map((item, index) => {
    const similarity = SIMILARITY_ORDER.includes(item.similarity) ? item.similarity : "unknown";
    return {
      productId: item.productId,
      sourceUrl: item.sourceUrl,
      title: item.title || `Ozon 商品 ${item.productId}`,
      imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
      similarity,
      similarityLabel: IMAGE_MATCH_SIMILARITY_LABELS[similarity],
      distance: finite(item.distance),
      priceRub: finite(item.priceRub),
      originalPriceRub: finite(item.originalPriceRub),
      rating: finite(item.rating),
      reviewCount: finite(item.reviewCount),
      isAd: item.isAd === true,
      isSourceProduct: item.isSourceProduct === true,
      judgement: IMAGE_MATCH_JUDGEMENT_LABELS[judgements[item.productId]?.judgement] ? judgements[item.productId].judgement : null,
      order: index
    };
  }).sort((left, right) => SIMILARITY_ORDER.indexOf(left.similarity) - SIMILARITY_ORDER.indexOf(right.similarity) ||
    (left.distance ?? 99) - (right.distance ?? 99) || left.order - right.order);
  const searchedPlatform = record?.source?.platform;
  return {
    sourceReady: picture.ok,
    sourceReason: picture.ok ? null : picture.reason,
    sourceLabel: SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[picture.ok ? picture.source.platform : searchedPlatform] ?? "首图",
    sourceImageUrl: picture.ok ? picture.imageUrl : record?.source?.imageUrl ?? null,
    suggestedQuery: suggestion.query,
    suggestionNote: QUERY_ORIGIN_NOTES[suggestion.origin] ?? "填几个俄文词，比如这件商品在俄语里叫什么、是什么材质。",
    captureId: record?.captureId ?? null,
    query: record?.query ?? null,
    status: record?.status ?? null,
    statusLine: record === null ? "" : statusLine({ ...record, results }, counts),
    failed: record?.status === "failed",
    inFlight,
    unknownOutcome: record?.jobStatus === "unknown_outcome",
    canStart: picture.ok && !inFlight && candidate?.workflowStatus !== "eliminated",
    canCompare: ["comparing", "compared"].includes(record?.status) && (record.status === "comparing" || counts.unknown > 0),
    judgeable: ["comparing", "compared"].includes(record?.status),
    counts,
    rows,
    exactCount: rows.filter(row => row.judgement === "exact").length
  };
}

/** 输入框里的词能不能拿去搜；和服务端同一条规则，这里只决定按钮亮不亮。 */
export function ozonSearchQueryReady(value) {
  return normalizeOzonSearchQuery(value) !== null;
}
