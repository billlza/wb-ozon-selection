import { SUPPLIER_IMAGE_MATCH_SOURCE_LABELS, supplierImageMatchSource } from "../lib/supplier-image-match-source.mjs";

/**
 * 商品页「在 1688 找同款」那一块要显示的东西，全部从服务端保存的 candidate.supplierImageMatch 和这件商品的货源采集、Ozon 主图里读出来。
 *
 * 用哪张图搜，和服务端读的是同一份规则（lib/supplier-image-match-source.mjs）：拼多多或 1688 货源首图优先，没有就用 Ozon 主图。
 * 页面不判断是不是同款：首图一致 / 很像 / 不像 只说两张首图看起来像不像，是不是同款由主人逐条点。这里不 import
 * lib/supplier-image-match.mjs——那边连着图片解码库，进不了浏览器；同样的几句标签由测试逐字对齐。
 */
export const IMAGE_MATCH_SIMILARITY_LABELS = Object.freeze({
  identical: "首图一致", similar: "很像", different: "不像", unknown: "无法比对"
});
export const IMAGE_MATCH_JUDGEMENT_LABELS = Object.freeze({ exact: "是同款", near: "近似款", wrong: "不是" });
const SIMILARITY_ORDER = Object.freeze(["identical", "similar", "unknown", "different"]);
// 拿哪家的价格去比：拼多多比的是拼单价，1688 比的是主人给的那一家；Ozon 主图搜出来的没有人民币进价可比。
const PRICE_BASE_LABELS = Object.freeze({ pinduoduo: "拼多多", 1688: "你给的这家" });
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
const knownPlatform = value => (Object.hasOwn(SUPPLIER_IMAGE_MATCH_SOURCE_LABELS, value) ? value : null);

/** 这件商品能不能拿首图去 1688 搜；不能的话为什么。服务端会再判一次，这里只决定按钮亮不亮、说哪句话。 */
export function imageMatchSourceState(candidate) {
  const source = supplierImageMatchSource(candidate);
  if (!source.ok) return { ready: false, platform: null, imageUrl: null, lowestPriceCny: null, reason: source.reason, code: source.code };
  return { ready: true, platform: source.source.platform, imageUrl: source.imageUrl, lowestPriceCny: finite(source.source.lowestPriceCny),
    reason: null, code: null };
}

function quantityLine(value) {
  if (value === null || value === undefined) return { text: "起批量没读到，打开 1688 页面核对是否一件起订", ok: null };
  return value <= 1 ? { text: "一件起订", ok: true } : { text: `${value} 件起批，不满足一件起订`, ok: false };
}

function statusLine(record, counts) {
  switch (record.status) {
    case "waiting_extension": return "已经排队，等插件领取……";
    case "searching": return "插件正在你 Chrome 里登录的 1688 上搜图……";
    case "comparing": return `已读回 ${record.results.length} 条，正在比对首图……`;
    case "compared": return `1688 共显示 ${record.cardCount ?? "?"} 条，取了最像的 ${record.results.length} 条：首图一致 ${counts.identical} 条、` +
      `很像 ${counts.similar} 条、不像 ${counts.different} 条${counts.unknown ? `、无法比对 ${counts.unknown} 条` : ""}。是不是同款请你逐条判断。`;
    case "failed": return typeof record.reason === "string" && record.reason ? record.reason : "这次找同款已经停下。";
    default: return "";
  }
}

/** 整块的显示数据。没有图可搜、没有待重采的货源、也没有找过同款时返回 null，这一块就不出现。 */
export function supplierImageMatchView(candidate) {
  const source = imageMatchSourceState(candidate);
  const record = isObject(candidate?.supplierImageMatch) ? candidate.supplierImageMatch : null;
  if (!source.ready && record === null && source.code !== "main_image_missing") return null;
  // 结果是用上一次那张图搜出来的，价格也跟那一次比；那次之前的记录没有写平台，那时只有拼多多一种。
  const searched = isObject(record?.source) ? record.source : null;
  const searchedPlatform = searched ? knownPlatform(searched.platform) ?? "pinduoduo" : null;
  const sourcePlatform = source.platform ?? searchedPlatform;
  const priceBasePlatform = searchedPlatform ?? source.platform;
  const priceBaseCny = searched
    ? finite(searched.lowestPriceCny) ?? (source.platform === searchedPlatform ? source.lowestPriceCny : null)
    : source.lowestPriceCny;
  const priceBaseLabel = priceBaseCny === null ? null : PRICE_BASE_LABELS[priceBasePlatform] ?? null;
  const results = Array.isArray(record?.results) ? record.results : [];
  const judgements = isObject(record?.judgements) ? record.judgements : {};
  const counts = { identical: 0, similar: 0, different: 0, unknown: 0 };
  for (const item of results) counts[SIMILARITY_ORDER.includes(item?.similarity) ? item.similarity : "unknown"] += 1;
  const inFlight = record !== null && (["waiting_extension", "searching"].includes(record.status) || ["queued", "claimed"].includes(record.jobStatus));
  const unknownOutcome = record?.jobStatus === "unknown_outcome";
  const rows = results.map((item, index) => {
    const similarity = SIMILARITY_ORDER.includes(item.similarity) ? item.similarity : "unknown";
    return {
      offerId: item.offerId,
      sourceUrl: item.sourceUrl,
      title: item.title || `1688 商品 ${item.offerId}`,
      imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
      similarity,
      similarityLabel: IMAGE_MATCH_SIMILARITY_LABELS[similarity],
      distance: finite(item.distance),
      priceCny: finite(item.priceCny),
      priceNote: item.priceNote || null,
      priceDifferenceCny: finite(item.priceCny) !== null && priceBaseLabel !== null
        ? Math.round((item.priceCny - priceBaseCny) * 100) / 100 : null,
      isSourceOffer: item.isSourceOffer === true,
      quantity: quantityLine(item.quantityBegin),
      saleQuantity: finite(item.saleQuantity),
      shopName: item.shopName || null,
      location: item.location || null,
      isAd: item.isAd === true,
      superFactory: item.superFactory === true,
      vendorSimilarity: finite(item.vendorSimilarity),
      judgement: IMAGE_MATCH_JUDGEMENT_LABELS[judgements[item.offerId]?.judgement] ? judgements[item.offerId].judgement : null,
      order: index
    };
  }).sort((left, right) => SIMILARITY_ORDER.indexOf(left.similarity) - SIMILARITY_ORDER.indexOf(right.similarity) ||
    (left.distance ?? 99) - (right.distance ?? 99) || left.order - right.order);
  return {
    sourceReady: source.ready,
    sourceReason: source.reason,
    sourcePlatform,
    sourceLabel: SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[sourcePlatform] ?? "首图",
    sourceImageUrl: source.imageUrl ?? searched?.imageUrl ?? null,
    lowestPriceCny: source.lowestPriceCny,
    priceBaseLabel,
    captureId: record?.captureId ?? null,
    status: record?.status ?? null,
    statusLine: record === null ? "" : statusLine({ ...record, results }, counts),
    failed: record?.status === "failed",
    inFlight,
    unknownOutcome,
    canStart: source.ready && !inFlight && candidate?.workflowStatus !== "eliminated",
    canCompare: ["comparing", "compared"].includes(record?.status) && (record.status === "comparing" || counts.unknown > 0),
    judgeable: ["comparing", "compared"].includes(record?.status),
    counts,
    rows,
    exactCount: rows.filter(row => row.judgement === "exact").length
  };
}
