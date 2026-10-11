import { discoveredTitleZh, formatInstant } from "./selectionDeskView.js";
import { eReadbackRuntimeDisplay } from "./dESoftwareRuntimeView.js";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

// 平台给的销售状态里，只有这几个是读得懂的；"unknown" 就是没读出来，不写。
const SALE_STATUS = Object.freeze({ on_sale: "在卖", active: "在卖", selling: "在卖", archived: "平台上已归档" });

/** 平台那边最后一次读到的价和库存，原样写出来；没读到就说没读到，不补数。 */
function observedLine(record) {
  if (!isObject(record)) return null;
  const parts = [];
  const price = record.currentPrice;
  if (isObject(price) && Number.isFinite(Number(price.amount)) && text(price.currency)) parts.push(`售价 ${price.amount} ${price.currency}`);
  if (Number.isFinite(record.currentStock)) parts.push(`库存 ${record.currentStock}`);
  const sale = text(record.saleStatus);
  if (sale && sale !== "unknown") parts.push(SALE_STATUS[sale] ?? `平台状态 ${sale}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 这件商品的回读，用主人的话说。只看服务端已经保存的记录：E 阶段的验证记录、回读作业的状态、旧版手动标记的上架记录。
 * 页面不去读平台，也不替一条还没通过的回读说「通过了」。
 */
export function listedReadback(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const record = isObject(sku?.eVerificationRecord) ? sku.eVerificationRecord : null;
  const runtime = candidate?.eReadbackRuntimeView ?? null;
  if (runtime?.status === "source_conflict") {
    return { tone: "warning", label: "回读记录和这件商品现在的资料对不上，需要核对", at: null };
  }
  if (record?.outcome === "listed_verified") {
    return { tone: "ok", label: "回读通过：软件上架的商品，平台上读到的和授权的一致", at: formatInstant(record.verifiedAt) };
  }
  if (record?.outcome === "externally_verified") {
    return { tone: "ok", label: "回读通过：平台上原本就有的商品", at: formatInstant(record.verifiedAt) };
  }
  const display = eReadbackRuntimeDisplay(runtime);
  if (display) return { tone: display.verified ? "ok" : "warning", label: display.statusLabel, at: formatInstant(display.completedAt ?? display.startedAt) };
  if (candidate?.workflowStatus === "listed") {
    return { tone: "muted", label: "以前手动标成已上架的，没有软件回读记录", at: formatInstant(candidate.listedAt) };
  }
  return { tone: "warning", label: "已经写到平台，还没有回读", at: null };
}

function listedRow(candidate, discoveryView) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const record = isObject(sku?.eVerificationRecord) ? sku.eVerificationRecord : null;
  return {
    id: candidate.id,
    title: discoveredTitleZh(discoveryView, candidate) ?? text(candidate.productName) ?? candidate.id,
    imageUrl: text(candidate.imageUrl),
    platformProductId: text(record?.platformProductId) ?? text(sku?.productionRecord?.platformProductId),
    observed: observedLine(record),
    readback: listedReadback(candidate),
    sortAt: Date.parse(record?.verifiedAt ?? sku?.productionRecord?.createdAt ?? candidate.listedAt ?? candidate.updatedAt ?? "") || 0
  };
}

/**
 * 在售那一页的两组：已经在售的，和已经写到平台、回读还没通过的。一家店一家店地看，最近的在上面。
 * 「在售」认的是服务端那个 listed 状态——只有回读通过（或者以前手动标记）才会变成它。
 */
export function listedProductGroups(candidates, store, discoveryView = null) {
  const mine = (Array.isArray(candidates) ? candidates : []).filter(candidate =>
    isObject(candidate) && candidate.workflowStatus !== "eliminated" && (store === null || candidate.targetStore === store));
  const order = (left, right) => right.sortAt - left.sortAt;
  const live = mine.filter(candidate => candidate.workflowStatus === "listed").map(candidate => listedRow(candidate, discoveryView)).sort(order);
  const pending = mine.filter(candidate => candidate.workflowStatus !== "listed" && isObject(candidate.lifecycleV11?.skuPackage?.productionRecord))
    .map(candidate => listedRow(candidate, discoveryView)).sort(order);
  return { live, pending };
}
