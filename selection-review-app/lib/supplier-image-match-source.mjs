import { canonicalImageSearchSourceUrl, canonicalOzonImageUrl, canonicalPinduoduoImageUrl,
  canonicalSupplierImageUrl } from "./capture-evidence-sanitization.mjs";
import { supplierCapturePlatform } from "./source-capture.mjs";

/**
 * 找同款用哪张图：服务端排作业和商品页决定按钮亮不亮，读的都是这一份，所以这里不碰网络、也不碰图片解码。
 * 只认三家平台自己图床的图：拼多多、1688 货源页采到的首图，或者这件商品在 Ozon 上的主图。
 */
export const SUPPLIER_IMAGE_MATCH_SOURCE_PLATFORMS = Object.freeze(["pinduoduo", "1688", "ozon"]);
export const SUPPLIER_IMAGE_MATCH_SOURCE_LABELS = Object.freeze({ pinduoduo: "拼多多首图", 1688: "1688 首图", ozon: "Ozon 主图" });

/** 与插件 extension/1688-capture/source-routing.js 里的 imageSearchUrl 逐字一致。 */
export function supplierImageMatchSearchUrl(imageUrl) {
  const canonical = canonicalImageSearchSourceUrl(imageUrl);
  if (!canonical || canonical !== imageUrl) return null;
  return `https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=${encodeURIComponent(canonical)}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SUPPLIER_IMAGE = Object.freeze({ pinduoduo: canonicalPinduoduoImageUrl, 1688: canonicalSupplierImageUrl });
const OZON_PRODUCT_PATH = /^\/product\/(?:[^/]*-)?(\d{5,20})\/?$/;

function ozonProductId(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "www.ozon.ru" || url.hostname === "ozon.ru")
      ? url.pathname.match(OZON_PRODUCT_PATH)?.[1] ?? null : null;
  } catch { return null; }
}

/** 这件 Ozon 商品自己的主图：先看候选上记的主图，再看最近一次销售快照的第一张图。只认 Ozon 图床。 */
function ozonMainImage(candidate) {
  const own = canonicalOzonImageUrl(candidate?.imageUrl);
  if (own) return own;
  const snapshots = Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [];
  for (const snapshot of [...snapshots].reverse()) {
    const first = Array.isArray(snapshot?.imageRefs) ? canonicalOzonImageUrl(snapshot.imageRefs[0]) : null;
    if (first) return first;
  }
  return null;
}

/**
 * 这件商品能拿哪张图去搜。先用采到的货源首图（拼多多或 1688）；没有货源采集、或者采集里没有首图时，用它在 Ozon 上的主图
 * （Seerfar 选出来的、主人给的 Ozon 链接都是这种）。拿不出来就如实说为什么，不换一张不相干的图凑数。
 */
export function supplierImageMatchSource(candidate) {
  const capture = candidate?.sourceCapture;
  const captured = isObject(capture) && capture.mode === "a_supplier_capture" && capture.status === "captured_waiting_owner_selection";
  const platform = captured ? supplierCapturePlatform(capture.sourceUrl) : null;
  const captureImage = captured && SUPPLIER_IMAGE[platform] ? SUPPLIER_IMAGE[platform](capture.mainImageUrl) : null;
  if (captureImage && captureImage === capture.mainImageUrl) {
    const prices = (Array.isArray(capture.skuChoices) ? capture.skuChoices : [])
      .map(sku => sku?.priceCny).filter(value => typeof value === "number" && Number.isFinite(value) && value > 0);
    return Object.freeze({
      ok: true,
      imageUrl: captureImage,
      searchUrl: supplierImageMatchSearchUrl(captureImage),
      source: Object.freeze({ platform, offerId: String(capture.offerId || ""), captureId: String(capture.captureId || ""),
        imageUrl: captureImage, lowestPriceCny: prices.length ? Math.min(...prices) : null })
    });
  }
  const productId = ozonProductId(candidate?.productUrl);
  const ozonImage = productId ? ozonMainImage(candidate) : null;
  if (ozonImage) {
    return Object.freeze({
      ok: true,
      imageUrl: ozonImage,
      searchUrl: supplierImageMatchSearchUrl(ozonImage),
      source: Object.freeze({ platform: "ozon", offerId: productId, captureId: "", imageUrl: ozonImage, lowestPriceCny: null })
    });
  }
  if (captured && SUPPLIER_IMAGE[platform]) {
    return Object.freeze({ ok: false, code: "main_image_missing",
      reason: "这次采集没有读到货源首图（插件升级前采的没有这一项），请先重新采一次这个货源页面。" });
  }
  return Object.freeze({ ok: false, code: "source_image_missing",
    reason: "先用插件采到拼多多或 1688 货源页面，或者这件商品要有 Ozon 主图，才有图可以拿去 1688 搜。" });
}
