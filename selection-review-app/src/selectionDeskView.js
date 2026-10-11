import { STORE_LABELS } from "./constants.js";
import { orderCandidates } from "./candidateViews.js";
import { errorMessage, safeImageUrl, safeWebUrl } from "./formState.js";
import { INTAKE_BLOCKER_LABELS, UNSOURCED_BLOCKER_CODES } from "../lib/global-notices.mjs";
import { gate1Open, gate1ShortfallPending } from "../lib/gate1-decision.mjs";
import { gate1ShortfallView } from "./gate1View.js";
import { INTAKE_BLOCKER_HINTS, INTAKE_STAGE_LABELS, roughProfitLine } from "./intakeView.js";

/** The owner only makes judgment calls here, so every label below is a plain business word. */
export const DESK_STORES = Object.freeze(["dandanshu", "miska", "wb"]);
export const DECLINE_REASONS = Object.freeze(["尺寸太大", "利润太薄", "品牌风险", "不想做这类", "其他"]);
export const FEED_SORTS = Object.freeze([
  { value: "profit", label: "按预估利润" },
  { value: "sales", label: "按月销" },
  { value: "freight", label: "按运费占比" }
]);
/**
 * 进行中的五列（第 8 版定的五个词）。「找货」是录入流水线还在找同款的；「待确认」是找完了等主人点「做这件」、正式利润
 * 没过线等主人选怎么办，以及做了之后还在定规格和货源的（都还在 A 阶段）。「准备中」是正式利润和文案素材（B、C），
 * 「待上架」是 D，「在售」是 E 和已上架的。
 */
export const BOARD_COLUMNS = Object.freeze([
  { key: "find", title: "找货" },
  { key: "confirm", title: "待确认" },
  { key: "prepare", title: "准备中" },
  { key: "publish", title: "待上架" },
  { key: "live", title: "在售" }
]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const text = value => (typeof value === "string" && value.trim() !== "" ? value : null);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function storeLabel(store) {
  return STORE_LABELS[store] ?? "未选择店铺";
}

/** Instants are saved as ISO strings; the owner reads the local date and minute, never the raw string. */
export function formatInstant(value) {
  const at = Date.parse(typeof value === "string" ? value : "");
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const pad = part => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Freight against the money that can still be spent on the goods; both numbers come from the same saved estimate. */
export function freightShare(estimate) {
  const freight = finite(estimate?.freight?.freightRmb);
  const ceiling = finite(estimate?.maximumAllInPurchaseRmb);
  if (freight === null || ceiling === null || freight + ceiling <= 0) return null;
  return freight / (freight + ceiling);
}

function batchesForStore(discoveryView, store) {
  return list(discoveryView?.batches)
    .filter(entry => isObject(entry?.batch) && entry.batch.targetStore === store)
    .sort((a, b) => (Date.parse(b.batch.createdAt) || 0) - (Date.parse(a.batch.createdAt) || 0));
}

/** Mirrors the discovery card: a Seerfar round keeps its market rows in the category step, LinkFox in the first step. */
function marketResultOf(entry, receipt) {
  if (!isObject(receipt) || !Array.isArray(receipt.steps)) return null;
  return entry.batch.plan?.provider === "seerfar"
    ? receipt.steps.find(step => step?.method === "category_detail")?.result ?? null
    : receipt.steps[0]?.result ?? null;
}

function chipsFor(product) {
  const chips = [];
  const estimate = product.estimate ?? null;
  if (estimate === null) chips.push("待估算");
  if (estimate?.outcome === "needs_data" && estimate.freight?.route === null) chips.push("待补尺寸");
  if (estimate?.freight?.oversize === true) chips.push("超抛");
  if (text(product.categoryPath?.cnTitlePath) === null) chips.push("类目未知");
  return chips;
}

function feedRow(entry, product, { imported, selections, declines }) {
  const { batch } = entry;
  const estimate = isObject(product.estimate) ? product.estimate : null;
  const selection = selections.get(product.productId) ?? null;
  return {
    key: `${batch.batchId}:${batch.revision}:${product.productId}`,
    batchId: batch.batchId,
    expectedRevision: batch.revision,
    marketProductId: product.productId,
    title: product.title ?? "",
    titleZh: text(product.titleZh),
    productUrl: safeWebUrl(product.productUrl),
    imageUrl: safeImageUrl(product.imageUrl),
    price: finite(product.price),
    salesCount: finite(product.salesCount),
    reviewCount: finite(product.reviewCount),
    reviewRating: finite(product.reviewRating),
    categoryZh: text(product.categoryPath?.cnTitlePath),
    estimate,
    outcome: estimate?.outcome ?? null,
    freightShare: freightShare(estimate),
    chips: chipsFor(product),
    importedCandidateId: imported.get(product.productId) ?? null,
    duplicate: selection?.status === "all_duplicates",
    failureClass: ["blocked", "failed"].includes(selection?.status) ? selection.failureClass ?? "未知" : null,
    declineReason: declines.get(product.productId) ?? null
  };
}

function compareRows(sort) {
  const rank = row => {
    if (sort === "sales") return row.salesCount;
    if (sort === "freight") return row.freightShare;
    return finite(row.estimate?.maximumAllInPurchaseRmb);
  };
  const ascending = sort === "freight";
  return (a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left === null && right === null) return a.key.localeCompare(b.key);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return ascending ? left - right : right - left;
    return a.key.localeCompare(b.key);
  };
}

export function sortFeedRows(rows, sort = "profit") {
  return [...rows].sort(compareRows(sort));
}

/** The market jobs of one round that actually saved a result; a supplier search is never part of the feed. */
function completedMarketJobs(entry) {
  return list(entry.jobs).filter(({ job }) =>
    job?.scopeBinding?.request?.method !== "supplier_search" && job?.status === "completed");
}

/**
 * Everything the home feed shows for one store: the newest finished round first, then the rows an estimate already
 * ruled out, the rows the owner personally turned down, and — folded away — whatever older rounds left undecided.
 * Nothing here is computed: each number comes from a saved query result or a saved estimate, and a missing number
 * stays missing.
 */
export function feedRows(discoveryView, store, sort = "profit") {
  const entries = batchesForStore(discoveryView, store);
  const rows = [];
  // Older rounds keep only what the owner already acted on; their undecided rows wait behind one toggle.
  const carried = [];
  const history = [];
  const excluded = [];
  const declined = [];
  let pendingTranslations = 0;
  let estimable = 0;
  let newest = null;
  // One product appears once even when several rounds returned it; the newest round that returned it wins.
  const seen = new Set();
  for (const entry of entries) {
    const jobs = completedMarketJobs(entry);
    // A round that has not saved a result yet — created, queued or failed — contributes nothing and heads nothing.
    if (jobs.length === 0) continue;
    const latestRound = newest === null;
    if (latestRound) newest = entry;
    const imported = new Map(list(entry.importedCandidates).map(value => [value.marketProductId, value.candidateId]));
    const selections = new Map(list(entry.selections).map(value => [value.marketProductId, value]));
    const declines = new Map(list(entry.declines).map(value => [value.marketProductId, value.reason]));
    for (const { receipt } of jobs) {
      for (const product of list(marketResultOf(entry, receipt)?.products)) {
        if (typeof product?.productId !== "string" || seen.has(product.productId)) continue;
        seen.add(product.productId);
        const row = feedRow(entry, product, { imported, selections, declines });
        // The two refresh buttons act on the newest finished round, so their counters describe that round only.
        if (latestRound) estimable += 1;
        if (latestRound && row.titleZh === null) pendingTranslations += 1;
        if (row.outcome === "excluded_negative") excluded.push(row);
        else if (row.declineReason !== null) declined.push(row);
        else if (latestRound) rows.push(row);
        else if (row.importedCandidateId !== null) carried.push(row);
        else history.push(row);
      }
    }
  }
  return {
    store,
    storeLabel: storeLabel(store),
    direction: text(newest?.batch.plan?.direction),
    queriedAt: formatInstant(newest?.batch.createdAt),
    current: newest === null ? null : { batchId: newest.batch.batchId, expectedRevision: newest.batch.revision },
    rows: [...sortFeedRows(rows, sort), ...sortFeedRows(carried, sort)],
    history: sortFeedRows(history, sort),
    excluded: sortFeedRows(excluded, sort),
    declined: sortFeedRows(declined, sort),
    pendingTranslations,
    estimable
  };
}

/** Remaining service points, when the saved query results carry them; never a guess. */
export function pointsLine(discoveryView, store) {
  let remaining = null;
  for (const entry of batchesForStore(discoveryView, store)) {
    for (const { receipt } of list(entry.jobs)) {
      for (const step of list(receipt?.steps)) {
        const value = finite(step?.result?.remainingPoints);
        if (value !== null) remaining = value;
      }
    }
  }
  return remaining === null ? null : `本店查询点数还剩 ${remaining}`;
}

/** The display-only Chinese title already saved for this candidate's market product, when the round translated it. */
export function discoveredTitleZh(discoveryView, candidate) {
  const productId = candidate?.aDiscoveryEvidenceV2?.marketProductId ?? candidate?.aDiscoveryEvidenceV1?.marketProductId ?? null;
  if (text(productId) === null) return null;
  for (const entry of list(discoveryView?.batches)) {
    for (const job of list(entry?.jobs)) {
      const product = list(marketResultOf(entry, job?.receipt)?.products).find(value => value?.productId === productId);
      if (product && text(product.titleZh) !== null) return product.titleZh;
    }
  }
  return null;
}

/** The saved capture job in the owner's words. A job that failed or was never asked for is not a step of its own. */
function captureStage(candidate) {
  const capture = candidate.sourceCapture;
  if (!isObject(capture)) return null;
  if (["captured_waiting_owner_selection", "verified"].includes(capture.status)) return "done";
  if (capture.jobStatus === "claimed" || ["capturing", "extension_running"].includes(capture.status)) return "running";
  if (capture.jobStatus === "queued" || capture.status === "waiting_extension") return "queued";
  return null;
}

const CAPTURE_CHIPS = Object.freeze({ queued: "待采集", running: "采集中", done: "已采到" });

const money = value => (finite(value) === null ? "未取得" : `¥${value.toFixed(2)}`);
const percent = value => (finite(value) === null ? "未取得" : `${Math.round(value * 100)}%`);

/**
 * A captured page is waiting on the owner only until he has actually chosen from it. Once 选定 is saved the list must
 * stop asking for the same thing — 需要你处理 promises that a finished row disappears by itself.
 */
function skuChoicePending(capture) {
  return capture.status === "captured_waiting_owner_selection" &&
    !(Array.isArray(capture.selectedSkuIds) && capture.selectedSkuIds.length > 0);
}

/**
 * Why the capture job of this product is waiting on the owner, in his own words, read from the saved job alone.
 * A job nobody ever asked for is not a reason for anything, so it answers null.
 */
function captureAttention(candidate) {
  const capture = candidate.sourceCapture;
  if (!isObject(capture)) return null;
  if (skuChoicePending(capture)) {
    return { reason: "插件已采到1688页面，等你选具体规格", action: { key: "sku", label: "去选规格" } };
  }
  if (capture.status === "captured_waiting_owner_selection") return null;
  if (["verified"].includes(capture.status)) return null;
  if (capture.jobStatus === "claimed" || ["capturing", "extension_running"].includes(capture.status)) {
    return { reason: "插件正在读这个1688页面，先等它读完", action: { key: "open", label: "查看" } };
  }
  if (capture.jobStatus === "queued" || capture.status === "waiting_extension") {
    return { reason: "采集已排队，等插件领取", action: { key: "open", label: "查看" } };
  }
  if (text(capture.failureCode) !== null) {
    return { reason: `上一次采集已停止：${text(capture.reason) ?? capture.failureCode}`,
      action: { key: "capture", label: "重新申请采集" } };
  }
  return null;
}

/**
 * What the 找货 declaration and the estimate saved beside it say about this product, read from those records only.
 * A missing estimate says so instead of turning into "没过线", and a blocked route repeats the saved sentence verbatim.
 */
function draftAttention(candidate) {
  if (!isObject(candidate.supplierDraftV1)) {
    return { step: "draft_missing", chip: "找货未填", reason: "找货还没填", action: { key: "draft", label: "去填找货" } };
  }
  const record = isObject(candidate.supplierDraftEstimateV1) ? candidate.supplierDraftEstimateV1 : null;
  if (record?.estimate?.status !== "ok") {
    const missing = list(record?.estimate?.missing).filter(value => text(value) !== null);
    const block = text(record?.routeBlock?.message);
    return { step: "draft_incomplete", chip: "找货已填 · 缺数据",
      reason: block ?? (missing.length ? `找货已填，还算不出利润：缺${missing.join("、")}` : "找货已填，还算不出利润：缺必要数据"),
      action: { key: "draft", label: "去补资料" } };
  }
  const profit = isObject(record.profitAtDeclaredPurchase) ? record.profitAtDeclaredPurchase : null;
  if (profit?.passes !== true) {
    return { step: "draft_blocked", chip: "找货已填 · 未过线",
      reason: `按你填的到手总价没到本店利润门槛：单件利润 ${money(profit?.unitProfitRmb)} · 利润率 ${percent(profit?.marginRate)}`,
      action: { key: "draft", label: "去改找货" } };
  }
  return { step: "draft_passes", chip: `找货已填 · 过线 单件利润 ${money(profit.unitProfitRmb)}`,
    reason: null, action: { key: "capture", label: "去申请采集" } };
}

/**
 * The one thing that still has to happen to this product, read from its own saved records: the 找货 declaration, the
 * estimate that was saved beside it and the capture job it already carries. Nothing is computed and nothing is guessed;
 * a missing estimate says so instead of turning into "没过线".
 * Owner feedback 2026-09-11: the 我选的商品 button said 申请插件采集 but only opened the product page, so it now says
 * where the click goes; the one button that really queues a capture lives on the product page and nowhere else.
 */
function myProductStep(candidate) {
  const capture = captureStage(candidate);
  if (capture !== null) return { step: `capture_${capture}`, chip: CAPTURE_CHIPS[capture], action: "查看" };
  const draft = draftAttention(candidate);
  return { step: draft.step, chip: draft.chip, action: draft.action.label };
}

/**
 * The intake blocker that leaves this product without a usable source (piece A writes candidate.intake), or null.
 * Item 9 of the 2026-10-10 list: such a product waits on the owner for one thing — a source link — so it says so.
 */
function unsourcedBlocker(candidate) {
  const intake = isObject(candidate?.intake) ? candidate.intake : null;
  if (intake?.stage !== "blocked" || !UNSOURCED_BLOCKER_CODES.includes(intake.blocker?.code)) return null;
  return intake.blocker;
}

/** Whether this product already carries a source of its own: a captured page, a 找货 declaration or a pasted link. */
function hasOwnSource(candidate) {
  if (isObject(candidate.sourceCapture) || isObject(candidate.supplierDraftV1)) return true;
  if (text(candidate.roughProfit?.purchaseBasis) !== null) return true;
  return ["pinduoduo", "1688"].includes(candidate.intake?.sourceKind);
}

/** The intake pipeline is still working on it, so "no source" would be premature. */
const intakeWorking = candidate => isObject(candidate.intake) && !["ready", "blocked"].includes(candidate.intake.stage);

/**
 * Why this product has no source, in the owner's words, or null when it has one. A saved intake blocker is repeated
 * as saved; otherwise a product with nothing of its own says so, and a 1688 image search that came back without one
 * identical picture says that — a near match is a price reference, never a source.
 */
export function unsourcedReason(candidate) {
  if (!isObject(candidate) || candidate.workflowStatus === "listed") return null;
  const blocker = unsourcedBlocker(candidate);
  if (blocker !== null) return text(blocker.message) ?? INTAKE_BLOCKER_LABELS[blocker.code];
  if (hasOwnSource(candidate) || intakeWorking(candidate)) return null;
  const match = isObject(candidate.supplierImageMatch) ? candidate.supplierImageMatch : null;
  if (["waiting_extension", "searching", "comparing"].includes(match?.status)) return null;
  if (match?.status === "compared") {
    const exact = list(match.results).some(item => item?.similarity === "identical") ||
      Object.values(isObject(match.judgements) ? match.judgements : {}).some(value => value?.judgement === "exact");
    if (!exact) return "1688 以图搜没找到首图一致的货源";
  }
  return "还没有货源";
}

/** 「做这件」卡在等主人：找完了等决定，或者正式利润没过线等选怎么办。 */
function gate1Attention(candidate) {
  if (!gate1Waiting(candidate)) return null;
  if (gate1ShortfallPending(candidate)) {
    const line = gate1ShortfallView(candidate.gate1ShortfallV1)?.line ?? "正式利润没过线。";
    return { reason: `${line}换货源、改售价，或者不做`, action: { key: "open", label: "去选怎么办" } };
  }
  return { reason: "找完了，看同款、货源和粗算，决定做不做这件", action: { key: "open", label: "去确认" } };
}

/**
 * Owner feedback 2026-09-11: "还有 5 条需要我处理，我不能直观看到它要处理什么，得挨个打开."
 * Every sentence below is read from this product's own saved records — the capture job, the 找货 declaration, the
 * estimate beside it and the platform's own asks. Nothing is inferred from a status name, and a product whose records
 * say nothing specific says "未取得" rather than inventing a reason.
 */
export function ownerAttentionReasons(candidate) {
  if (!isObject(candidate)) return { reasons: ["未取得需要你做什么的记录"], action: { key: "open", label: "打开" } };
  const autopilot = autopilotAttention(candidate);
  // 做这件之后软件停下来等主人的那几样（权利声明、属性、付费生成、确认文案、素材、上架确认），原话照搬。
  if (autopilot !== null) return autopilot;
  const capture = captureAttention(candidate);
  // 录入流水线找完、等「做这件」的商品不再走手填找货：卡上读到的同款、货源和粗算就是要主人认的东西。
  const gate1 = gate1Attention(candidate);
  const draft = gate1 === null ? draftAttention(candidate) : { reason: null, action: null };
  const needs = list(candidate.needsFromUser).map(need => text(need)).filter(need => need !== null);
  // A product the intake pipeline left without a source has one next step: paste a source link.
  const blocker = unsourcedBlocker(candidate);
  const source = blocker === null ? null : { reason: `${text(blocker.message) ?? INTAKE_BLOCKER_LABELS[blocker.code]}，贴一个能一件起订的货源链接，或者淘汰`,
    action: { key: "source_link", label: "贴货源链接" } };
  // The platform's own ask can repeat a sentence the records already produced; the owner reads it once.
  const reasons = [...new Set([gate1?.reason ?? null, source?.reason ?? null, capture?.reason ?? null, draft.reason, ...needs]
    .filter(reason => reason !== null))];
  return {
    reasons: reasons.length ? reasons : ["未取得需要你做什么的具体记录，打开看它的六步"],
    action: gate1?.action ?? source?.action ?? capture?.action ?? draft.action ?? { key: "open", label: "打开" }
  };
}

/**
 * 「做这件」之后软件停下来等主人的那一刻（服务端 gate1AutopilotView，lib/gate1-autopilot.mjs）：停在哪几样、软件哪一步出错、
 * 或者老商品还没让软件接着做。软件自己还在做的，不算等主人。
 */
const AUTOPILOT_WAITS = ["waiting_owner", "failed", "ready"];
function autopilotAttention(candidate) {
  const view = isObject(candidate.gate1AutopilotView) ? candidate.gate1AutopilotView : null;
  if (!AUTOPILOT_WAITS.includes(view?.status)) return null;
  const stops = list(view.stops).map(item => text(item?.line)).filter(line => line !== null);
  const reasons = view.status === "waiting_owner" && stops.length ? stops : [text(view.line)].filter(line => line !== null);
  if (!reasons.length) return null;
  const more = Number.isInteger(view.moreStops) && view.moreStops > 0 ? [`还有 ${view.moreStops} 项，打开看`] : [];
  return { reasons: [...reasons, ...more], action: { key: "open", label: "打开" } };
}

/** The Ozon price this product carried when the round returned it; the unit is only named when the record names it. */
function marketPriceLine(candidate) {
  const observed = (candidate.aDiscoveryEvidenceV2 ?? candidate.aDiscoveryEvidenceV1)?.observedMarketPrice;
  const price = finite(observed?.value);
  if (price === null) return "售价未取得";
  const currency = text(observed.currency);
  if (currency === null) return `售价 ${price}`;
  return ["₽", "RUB"].includes(currency) ? `售价 ${price} 卢布` : `售价 ${price} ${currency}`;
}

const fromDiscovery = candidate => isObject(candidate.aDiscoveryEvidenceV2) || isObject(candidate.aDiscoveryEvidenceV1);

/**
 * The owner's own shelf, newest first: every product this store took out of a query round — picked by hand or imported
 * by the plan — with the next thing to do to it. Owner feedback 2026-09-11: a filled 找货 form became unfindable once
 * the page was left, so this block is the fixed way back into any product, and every row opens that product's page.
 * Products the owner already dropped are not on the shelf any more, exactly as they leave 进行中.
 */
export function myProductRows(candidates, discoveryView, store) {
  return list(candidates)
    .filter(candidate => isObject(candidate) && candidate.workflowStatus !== "eliminated" &&
      (store === null || candidate.targetStore === store) && fromDiscovery(candidate))
    .sort((a, b) => ((Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)) || String(a.id).localeCompare(String(b.id)))
    .map(candidate => ({
      id: candidate.id,
      // The Chinese title only shows when the round actually translated it; otherwise the provider's own title stands.
      title: discoveredTitleZh(discoveryView, candidate) ?? text(candidate.productName) ?? candidate.id,
      imageUrl: safeImageUrl(candidate.imageUrl),
      priceLine: marketPriceLine(candidate),
      ...myProductStep(candidate)
    }));
}

/**
 * The name the top bar shows while the owner is on one product page: the translated title when the round saved one,
 * then the provider's own product name, then the saved id — short enough to sit on one line beside the way back.
 */
export function shortProductTitle(candidate, titleZh) {
  const name = [titleZh, candidate?.productName, candidate?.id].map(value => (text(value) ?? "").trim()).find(value => value !== "") ?? "未取得名称";
  return name.length > 16 ? `${name.slice(0, 16)}…` : name;
}

/** 录入流水线还在找、还没被主人在「做这件」卡上决定过的。 */
function intakeStillFinding(candidate) {
  return isObject(candidate.intake) && !isObject(candidate.gate1) && candidate.intake.stage !== "ready";
}

/**
 * 在等主人点「做这件」或者选「正式利润没过线」之后怎么办。只认录入流水线找完了的（或者主人让它重开一轮的）：
 * 老商品没走录入、也没填找货的，不算在等主人，免得旧货一下子全涌进「需要你处理」。
 */
function gate1Waiting(candidate) {
  if (gate1ShortfallPending(candidate)) return true;
  return gate1Open(candidate) && (candidate.intake?.stage === "ready" || isObject(candidate.gate1ReopenV1));
}

export function boardColumnKey(candidate) {
  if (candidate.workflowStatus === "listed") return "live";
  // 正式利润没过线时商品可能已经在 B，但下一步是主人在「做这件」卡上选怎么办，所以回到「待确认」。
  if (gate1ShortfallPending(candidate)) return "confirm";
  const phase = typeof candidate.executionRuntime?.businessPhase === "string" ? candidate.executionRuntime.businessPhase : "";
  if (phase.startsWith("B") || phase.startsWith("C")) return "prepare";
  if (phase.startsWith("D")) return "publish";
  if (phase.startsWith("E")) return "live";
  if (!phase.startsWith("A")) {
    const legacy = { listing_preparation: "prepare", ready_to_list: "publish" }[candidate.workflowStatus];
    if (legacy) return legacy;
  }
  return intakeStillFinding(candidate) ? "find" : "confirm";
}

const CYRILLIC = /[\u0400-\u04FF]/u;
/** 录入刚建卡、货源页还没读回来时后台先放的名字（server.mjs INTAKE_PLACEHOLDER_NAME）。 */
const INTAKE_PLACEHOLDER_NAME = "录入中的商品";

/**
 * 卡片上的名字，先中文：一轮查询翻好的中文标题，然后不是俄文的商品名，然后读到的货源页标题（拼多多、1688 都是中文），
 * 最后才是原来的商品名或编号。同一件货的其他颜色用原商品的名字，颜色另外写。
 */
export function boardTitle(candidate, { byId = null, discoveryView = null } = {}) {
  const parent = byId?.get(candidate?.siblingSourceV1?.parentCandidateId) ?? null;
  if (parent && parent !== candidate) return boardTitle(parent, { discoveryView });
  const translated = discoveredTitleZh(discoveryView, candidate);
  if (translated !== null) return translated;
  const name = text(candidate?.productName);
  const captured = text(candidate?.sourceCapture?.title);
  if (name !== null && name !== INTAKE_PLACEHOLDER_NAME && !CYRILLIC.test(name)) return name;
  if (captured !== null && !CYRILLIC.test(captured)) return captured;
  return name ?? captured ?? candidate?.id ?? "未取得名称";
}

/** 这件货是哪个颜色：同款各色读它自己那条规格，原商品读主人选定的那条。读不到就是 null，不猜。 */
function colourOf(candidate) {
  const capture = isObject(candidate.sourceCapture) ? candidate.sourceCapture : null;
  const skuId = candidate.siblingSourceV1?.supplierSkuId ?? list(capture?.selectedSkuIds)[0];
  const choice = list(capture?.skuChoices).find(item => item?.sourceSkuId === skuId);
  return text(choice?.attributes?.颜色);
}

const familyOf = candidate => text(candidate.siblingSourceV1?.parentCandidateId) ?? candidate.id;

const RUNTIME_LINES = Object.freeze({ not_started: "还没开始", queued: "排着等软件", running: "软件在做",
  waiting_owner: "等你决定", completed: "这一步做完了" });
const FAILURE_LINES = Object.freeze({ external_dependency: "外部服务不可用，已停下", known_technical_failure: "技术失败，已安全停下",
  unknown_outcome: "结果未知，要先核对，不会自动重做" });
const CAPTURE_LINES = Object.freeze({ queued: "已决定做，货源页排着等插件读", running: "已决定做，插件正在读货源页",
  done: "已决定做，货源页已读到" });

/** B 之后：读已保存的软件执行状态。停下的分清楚是外部依赖、已知技术失败、结果未知还是要技术维护。 */
function runtimeState(candidate) {
  const runtime = isObject(candidate.executionRuntime) ? candidate.executionRuntime : null;
  if (runtime === null) return { statusLine: "状态还没记录", stuckLine: null };
  if (runtime.exceptionCase?.status === "open") return { statusLine: "已停下", stuckLine: "需要技术维护，异常已记下" };
  if (runtime.status === "blocked") {
    return { statusLine: "已停下", stuckLine: FAILURE_LINES[runtime.technicalFailure?.kind] ?? "已停下，原因没认出来" };
  }
  return { statusLine: RUNTIME_LINES[runtime.status] ?? "状态没认出来", stuckLine: null };
}

const ACTIVE_INTAKE_STAGES = Object.freeze(["queued", "reading_source", "searching_1688", "searching_ozon", "estimating"]);

/** 找货中：以录入队列的回执为准（它算的是此刻的进度），回执里没有才看商品上存的。 */
function findState(candidate, context) {
  const item = context.queueItems.get(candidate.id) ?? null;
  const stage = text(item?.stage) ?? text(candidate.intake?.stage);
  const blocker = stage !== "blocked" ? null : isObject(item?.blocker) ? item.blocker
    : isObject(candidate.intake?.blocker) ? candidate.intake.blocker : null;
  const active = ACTIVE_INTAKE_STAGES.includes(stage);
  let stuckLine = null;
  if (blocker !== null) stuckLine = text(blocker.message) ?? INTAKE_BLOCKER_HINTS[blocker.code] ?? "停下来的原因没认出来";
  else if (active && context.pause !== null) stuckLine = `整条队先停着：${text(context.pause.message) ?? INTAKE_BLOCKER_HINTS[context.pause.code] ?? "等你处理好再点「接着找」"}`;
  else if (active && context.extension?.online === false) stuckLine = "插件没连上，这件排着等，什么都不会丢";
  const position = [
    Number.isInteger(item?.batch?.position) && Number.isInteger(item?.batch?.total) && item.batch.total > 1
      ? `第 ${item.batch.position} / ${item.batch.total} 条` : null,
    Number.isInteger(item?.queue?.position) && Number.isInteger(item?.queue?.total) ? `排第 ${item.queue.position} / ${item.queue.total}` : null
  ].filter(Boolean);
  // 卡上的按钮和录入页一样：整页那类事（滑块、登录、插件）点「接着找」，只拦这一件、能重跑的点「重跑」或「核实」。
  const revision = Number.isSafeInteger(item?.dataRevision) ? item.dataRevision : Number.isSafeInteger(candidate.dataRevision) ? candidate.dataRevision : null;
  const pageStop = blocker?.scope === "page" || (blocker === null && active && context.pause !== null);
  const action = pageStop ? { key: "resume", label: "接着找" }
    : blocker?.retryable === true && revision !== null
      ? { key: "retry", label: blocker.code === "unknown_outcome" ? "核实" : "重跑", dataRevision: revision }
      : null;
  return { statusLine: INTAKE_STAGE_LABELS[stage] ?? "状态没认出来", stuckLine,
    positionLine: position.length ? position.join(" · ") : null, action };
}

/** 待确认：做这件之前、正式利润没过线之后、做了之后定规格货源时，各说各的。 */
function confirmState(candidate) {
  if (gate1ShortfallPending(candidate)) {
    return { statusLine: "正式利润没过线", stuckLine: gate1ShortfallView(candidate.gate1ShortfallV1)?.line ?? "正式利润没过线" };
  }
  if (gate1Open(candidate)) {
    return { statusLine: gate1Waiting(candidate) ? "找完了，等你点「做这件」" : "还没决定做不做",
      stuckLine: null, roughProfit: roughProfitLine(candidate.roughProfit) };
  }
  const capture = captureStage(candidate);
  return { statusLine: capture === null ? "已决定做，在定规格和货源" : CAPTURE_LINES[capture], stuckLine: null };
}

/**
 * 一件商品在「进行中」上的一张小卡：同一套说法，四件事分开写——在哪一步（列）、这一步现在怎样（statusLine）、
 * 卡住了没有（stuckLine）、要不要你做什么（waitingLine，和「需要你处理」用同一个判断）。
 */
function candidateCard(candidate, context) {
  const column = boardColumnKey(candidate);
  const state = column === "find" ? findState(candidate, context)
    : column === "confirm" ? confirmState(candidate)
    : candidate.workflowStatus === "listed" ? { statusLine: "已上架", stuckLine: null }
    : runtimeState(candidate);
  const unsourced = column === "confirm" && state.stuckLine == null ? unsourcedReason(candidate) : null;
  const waitingLine = waitsOnOwner(candidate) ? ownerAttentionReasons(candidate).reasons[0] : null;
  const action = state.action ?? (waitingLine !== null ? { key: "open", label: "去处理" } : null);
  let stuckLine = state.stuckLine ?? (unsourced === null ? null : `没有货源：${unsourced}`);
  const stuck = stuckLine !== null;
  // 等你那一行已经说了同一件事（比如没货源要你贴链接），就不再重复一遍。
  if (stuckLine !== null && waitingLine !== null && (waitingLine.includes(stuckLine) || stuckLine.includes(waitingLine))) stuckLine = null;
  return {
    id: candidate.id,
    column,
    dataRevision: candidate.dataRevision ?? null,
    title: boardTitle(candidate, context),
    colour: colourOf(candidate),
    family: familyOf(candidate),
    imageUrl: safeImageUrl(candidate.imageUrl),
    storeLabel: storeLabel(candidate.targetStore),
    statusLine: state.statusLine,
    stuck,
    stuckLine,
    waitingLine,
    positionLine: state.positionLine ?? null,
    roughProfit: state.roughProfit ?? null,
    action
  };
}

function boardContext(candidates, { discoveryView = null, intakeQueue = null } = {}) {
  const queueItems = new Map(list(intakeQueue?.items).filter(item => text(item?.candidateId) !== null).map(item => [item.candidateId, item]));
  return { byId: new Map(list(candidates).filter(isObject).map(candidate => [candidate.id, candidate])), discoveryView, queueItems,
    pause: isObject(intakeQueue?.pause) ? intakeQueue.pause : null,
    extension: isObject(intakeQueue?.extension) ? intakeQueue.extension : null };
}

export function activeCandidates(candidates, store) {
  return orderCandidates(list(candidates).filter(candidate =>
    isObject(candidate) && candidate.workflowStatus !== "eliminated" && (store === null || candidate.targetStore === store)));
}

/**
 * 同一件货的几个颜色合成一张卡（原商品和它的同款各色）。每列里各合各的；同一件货有颜色在别的列，卡上写一句在哪。
 * 价格不在这里算：各色都按原商品定价时那份销售快照算，卡上不显示另算的数。
 */
function familyCards(cards, columnTitles) {
  const families = new Map();
  for (const card of cards) {
    if (!families.has(card.family)) families.set(card.family, []);
    families.get(card.family).push(card);
  }
  const seen = new Set();
  const grouped = [];
  for (const card of cards) {
    if (seen.has(`${card.column}:${card.family}`)) continue;
    seen.add(`${card.column}:${card.family}`);
    const family = families.get(card.family);
    const here = family.filter(member => member.column === card.column)
      .sort((a, b) => (a.id === card.family ? -1 : b.id === card.family ? 1 : 0));
    const elsewhere = [...new Set(family.filter(member => member.column !== card.column).map(member => member.column))]
      .map(column => `${columnTitles[column]} ${family.filter(member => member.column === column).length} 个`);
    if (family.length === 1) { grouped.push({ ...card, members: [], elsewhereLine: null }); continue; }
    const lead = here[0];
    const label = member => member.colour ?? "颜色没读到";
    const statuses = [...new Set(here.map(member => member.statusLine))];
    const stuck = here.find(member => member.stuckLine !== null) ?? null;
    const waiting = here.filter(member => member.waitingLine !== null);
    grouped.push({
      ...lead,
      title: lead.title,
      imageUrl: lead.imageUrl ?? here.map(member => member.imageUrl).find(Boolean) ?? null,
      statusLine: statuses.length === 1 ? statuses[0] : "几个颜色走到的地方不一样，看下面每个颜色",
      stuck: here.some(member => member.stuck),
      stuckLine: stuck === null ? null : here.length > 1 ? `${label(stuck)}：${stuck.stuckLine}` : stuck.stuckLine,
      waitingLine: waiting.length === 0 ? null : here.length > 1
        ? `${label(waiting[0])}：${waiting[0].waitingLine}${waiting.length > 1 ? `（另有 ${waiting.length - 1} 个颜色也在等你）` : ""}`
        : waiting[0].waitingLine,
      positionLine: here.length === 1 ? lead.positionLine : null,
      // 合起来的卡只给一个按钮：打开第一个在等你的颜色。
      action: waiting.length === 0 ? null : { key: "open", label: "去处理", id: waiting[0].id },
      members: here.map(member => ({ id: member.id, dataRevision: member.dataRevision, label: label(member), statusLine: member.statusLine })),
      elsewhereLine: elsewhere.length ? `同一件货另有颜色在：${elsewhere.join("、")}` : null
    });
  }
  return grouped;
}

export function boardColumns(candidates, store, options = {}) {
  const active = activeCandidates(candidates, store);
  const context = boardContext(candidates, options);
  const cards = active.map(candidate => candidateCard(candidate, context));
  const titles = Object.fromEntries(BOARD_COLUMNS.map(column => [column.key, column.title]));
  const grouped = familyCards(cards, titles);
  return BOARD_COLUMNS.map(column => ({
    ...column,
    count: cards.filter(card => card.column === column.key).length,
    cards: grouped.filter(card => card.column === column.key)
  }));
}

/**
 * A product is in 需要你处理 when the platform itself asks the owner for something, and also when its own saved capture
 * job is standing still on him: a captured 1688 page waiting for a size choice, or a capture that stopped. Those two
 * are unambiguous — nobody but the owner can move them — and leaving them out was how a finished capture could sit
 * unnoticed. Everything else stays on 我选的商品 with its own chip.
 */
function waitsOnOwner(candidate) {
  if (gate1Waiting(candidate)) return true;
  if (list(candidate.needsFromUser).some(need => text(need) !== null)) return true;
  if (autopilotAttention(candidate) !== null) return true;
  if (unsourcedBlocker(candidate) !== null) return true;
  const capture = candidate.sourceCapture;
  if (!isObject(capture)) return false;
  return skuChoicePending(capture) || text(capture.failureCode) !== null;
}

export function inboxItems(candidates, store, options = {}) {
  const context = boardContext(candidates, options);
  return activeCandidates(candidates, store)
    .map(candidate => ({ candidate, card: candidateCard(candidate, context) }))
    .filter(({ candidate }) => waitsOnOwner(candidate))
    .map(({ candidate, card }) => {
      const attention = ownerAttentionReasons(candidate);
      return {
        id: card.id,
        dataRevision: candidate.dataRevision ?? null,
        title: card.title,
        imageUrl: card.imageUrl,
        storeLabel: card.storeLabel,
        statusLine: card.statusLine,
        // Kept for the desk rail, which has room for exactly one line.
        need: attention.reasons[0],
        moreNeeds: Math.max(attention.reasons.length - 1, 0),
        reasons: attention.reasons,
        action: attention.action
      };
    });
}

/**
 * Every product of this store still without a source that is not already a row of 需要你处理 — the ones that used to
 * be only folded away (item 9: 历史 10 个里 7 个). Each row offers 贴货源链接; nothing here is started by reading it.
 */
export function unsourcedRows(candidates, store, discoveryView = null) {
  return activeCandidates(candidates, store)
    .filter(candidate => !waitsOnOwner(candidate))
    .map(candidate => ({ candidate, reason: unsourcedReason(candidate) }))
    .filter(({ reason }) => reason !== null)
    .map(({ candidate, reason }) => ({
      id: candidate.id,
      dataRevision: candidate.dataRevision ?? null,
      title: discoveredTitleZh(discoveryView, candidate) ?? text(candidate.productName) ?? candidate.id,
      storeLabel: storeLabel(candidate.targetStore),
      reason
    }));
}

/** The stores the intake pipeline can open a new product for; it never picks one by itself (AGENTS.md §13.1). */
const INTAKE_STORES = Object.freeze(["miska", "dandanshu"]);

/**
 * The body 贴货源链接 sends. On a saved product it carries attachTo, so the intake pipeline puts the link on that very
 * card (bound to the revision the owner saw) instead of opening a second one; a market row is not a product yet, so
 * it names the row's own store for the new product.
 */
export function sourceLinkPayload(link, target) {
  if (isObject(target) && text(target.candidateId) !== null) {
    return { links: [link], attachTo: { candidateId: target.candidateId, dataRevision: target.dataRevision ?? null } };
  }
  return { links: [link], targetStore: isObject(target) && INTAKE_STORES.includes(target.store) ? target.store : null };
}

/** Why 贴货源链接 cannot be used on this target yet, or null: a new product needs a store the pipeline accepts. */
export function sourceLinkBlocked(target) {
  if (isObject(target) && text(target.candidateId) !== null) return null;
  if (isObject(target) && INTAKE_STORES.includes(target.store)) return null;
  return `贴货源链接只能给${INTAKE_STORES.map(storeLabel).join("或")}新建商品，先在上面选好店铺。`;
}

/** What the owner reads after 贴货源链接 came back from piece A's POST /api/intake/links. */
export function sourceLinkResult(response) {
  const item = list(response?.items)[0] ?? null;
  if (!isObject(item)) {
    return list(response?.rejected).length
      ? { message: "这条没认出是拼多多或 1688 的商品链接，没有收下。", candidateId: null }
      : { message: "服务没有返回结果，链接是否收下未确认；刷新后再看。", candidateId: null };
  }
  if (item.attached === true) {
    return { message: "已换上这个货源，这件会从读货源页重新开始，找完回到需要你处理。", candidateId: null };
  }
  if (item.created === false && text(item.duplicateOfCandidateId) !== null) {
    return duplicateAnswer(item.duplicateOfCandidateId, item.duplicateEliminated === true);
  }
  return { message: "已收下，软件会去读这个货源、找同款、粗算，读完回到需要你处理。", candidateId: text(item.candidateId) };
}

function duplicateAnswer(candidateId, eliminated) {
  return eliminated
    ? { message: "这个货源之前贴过，那件已经淘汰了；要重新做，去「已淘汰」里恢复它。", candidateId }
    : { message: "这个货源之前贴过，已经在另一件商品上，没有多建一张卡。", candidateId };
}

/** A refusal that is really an answer (the link already belongs to another card), or null for a real failure. */
export function sourceLinkRefusal(cause) {
  const body = isObject(cause?.body) ? cause.body : null;
  if (body?.code !== "intake_attach_duplicate" || text(body.duplicateOfCandidateId) === null) return null;
  return duplicateAnswer(body.duplicateOfCandidateId, body.duplicateEliminated === true);
}

/**
 * What the owner already dropped, per store, newest first. Every list folds these away by default and offers 恢复 on
 * each row; the reason and the instant are read from the saved candidate and never re-worded.
 */
export function eliminatedRows(candidates, store, discoveryView = null) {
  return list(candidates)
    .filter(candidate => isObject(candidate) && candidate.workflowStatus === "eliminated" &&
      (store === null || candidate.targetStore === store))
    .sort((a, b) => ((Date.parse(b.eliminatedAt ?? b.updatedAt) || 0) - (Date.parse(a.eliminatedAt ?? a.updatedAt) || 0)) ||
      String(a.id).localeCompare(String(b.id)))
    .map(candidate => ({
      id: candidate.id,
      dataRevision: candidate.dataRevision ?? null,
      title: discoveredTitleZh(discoveryView, candidate) ?? text(candidate.productName) ?? candidate.id,
      imageUrl: safeImageUrl(candidate.imageUrl),
      storeLabel: storeLabel(candidate.targetStore),
      reasonLine: text(candidate.eliminationReason) ?? "没有记录理由",
      eliminatedAtLabel: formatInstant(candidate.eliminatedAt) ?? "时间未记录"
    }));
}

/**
 * The rows of the newest finished round the owner never answered — neither 要 nor 不要. This is exactly what
 * 一键淘汰上一轮全部未选 acts on, so the count shown before the click and the rows acted on afterwards are one list.
 */
export function lastRoundUndecidedRows(feed) {
  if (!isObject(feed) || feed.current === null) return [];
  return list(feed.rows).filter(row => row.batchId === feed.current.batchId &&
    row.expectedRevision === feed.current.expectedRevision &&
    row.importedCandidateId === null && row.declineReason === null && row.duplicate !== true);
}

/** The three counters the top bar shows beside the view names. */
export function deskCounts({ discoveryView, candidates, store }) {
  const feed = feedRows(discoveryView, store);
  return {
    desk: feed.rows.length,
    board: activeCandidates(candidates, store).length,
    inbox: inboxItems(candidates, store).length
  };
}

/**
 * The one request body that starts a round, shared by 找一轮新品 and the 重跑 of a stopped round, so a rerun is the
 * same explicit, priced start and never a replay of the old request.
 */
export function roundStartPayload({ plan, binding, store }, now = Date.now(), key = globalThis.crypto.randomUUID()) {
  return { planId: plan.planId, planVersion: plan.version, targetStore: store,
    bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
    expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(), idempotencyKey: `desk-round:${key}` };
}

const RUNNING_JOB_STATUSES = ["queued", "claimed", "waiting_platform"];
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The server refuses a second round for the same store and direction while a just-created round is this young, so the
 * desk has to say so before the click instead of letting 「不要这一轮了，重新找一轮」 come back refused (owner incident
 * 2026-09-11). It mirrors ROUND_RESUMABLE_WINDOW_MS in lib/a-discovery-runtime-services.mjs and a test holds the two equal.
 */
export const ROUND_REOPEN_WINDOW_MS = 10 * 60 * 1000;
/**
 * One sentence for "this store is already querying this direction", wherever the answer comes from: the saved rounds
 * the rail reads before a click, and the server's own ROUND_ALREADY_RUNNING refusal after one.
 */
export const ROUND_ALREADY_RUNNING_MESSAGE = "本店已有一轮查询在进行，等它完成后再找。";

/**
 * What the desk shows when a write comes back refused. The server answers ROUND_ALREADY_RUNNING when this store is
 * already asking this question — a job still running, or a round that was created and never started — so the answer
 * names both and points at the button that continues the saved round instead of opening a second, paid one.
 */
export function deskErrorMessage(cause) {
  return cause?.body?.code === "ROUND_ALREADY_RUNNING"
    ? `${ROUND_ALREADY_RUNNING_MESSAGE}上一次点了却没真的开始的那一轮也算，用「找一轮新品」继续它。`
    : errorMessage(cause);
}
const notReady = (reason, extra = {}) =>
  ({ ready: false, reason, plan: null, binding: null, warning: null, estimatedPoints: null, maxCredits: null, direction: null, resume: null, ...extra });

/**
 * What one click on 找一轮新品 would do, in the owner's words, before anything is created or billed.
 * Owner rule 2026-09-11: never show a confusing engineering step; one explicit cost confirmation, then automatic.
 */
export function newRoundPlan(discoveryView, store, now = Date.now()) {
  const plans = list(discoveryView?.plans), bindings = list(discoveryView?.bindings);
  if (discoveryView?.canPrepare !== true || plans.length === 0 || bindings.length !== 1) {
    return notReady("还没有可执行的查询计划，需要维护人员先配置方向。");
  }
  const plan = plans[0], binding = bindings[0];
  const entries = batchesForStore(discoveryView, store);
  let latestCompleted = null;
  for (const entry of entries) {
    for (const { job } of list(entry.jobs)) {
      if (RUNNING_JOB_STATUSES.includes(job?.status)) {
        return notReady(ROUND_ALREADY_RUNNING_MESSAGE, { plan, binding, direction: text(plan.direction) });
      }
      const at = Date.parse(job?.completedAt ?? "");
      if (Number.isFinite(at) && (latestCompleted === null || at > latestCompleted.at)) latestCompleted = { at, entry };
    }
  }
  const estimatedPoints = plan.budget?.estimatedPointsByStep?.category_detail ?? null;
  const maxCredits = plan.budget?.maxCredits ?? null;
  const direction = text(plan.direction) ?? "";
  // An earlier click that saved the round but never started it: continue that same batch instead of opening a new one.
  // canAuthorize is the server's own answer, so a batch the current configuration can no longer run is never offered.
  const orphan = entries.find(entry => list(entry.jobs).length === 0 && entry.canAuthorize === true) ?? null;
  // A saved round this young blocks a fresh one on the server, so say the wait here rather than after a refused click.
  const orphanCreatedAt = orphan === null ? NaN : Date.parse(orphan.batch.createdAt);
  const reopenAt = Number.isFinite(orphanCreatedAt) ? orphanCreatedAt + ROUND_REOPEN_WINDOW_MS : NaN;
  const canReopenNow = !Number.isFinite(reopenAt) || now >= reopenAt;
  const resume = orphan === null ? null : { batchId: orphan.batch.batchId, expectedRevision: orphan.batch.revision,
    direction: text(orphan.batch.plan?.direction) ?? direction, createdAt: formatInstant(orphan.batch.createdAt),
    canReopenNow, reopenAt: Number.isFinite(reopenAt) ? formatInstant(new Date(reopenAt).toISOString()) : null,
    reopenWaitMinutes: canReopenNow ? 0 : Math.max(1, Math.ceil((reopenAt - now) / 60000)) };
  let warning = null;
  if (latestCompleted !== null && now - latestCompleted.at < DAY_MS) {
    const at = formatInstant(new Date(latestCompleted.at).toISOString());
    const previous = text(latestCompleted.entry.batch.plan?.direction);
    warning = latestCompleted.entry.batch.plan?.planId === plan.planId
      ? `本店 ${at} 刚查过同一方向「${previous ?? direction}」，结果就在下面；再查会再扣一次点数。`
      : `本店 ${at} 刚查过「${previous ?? "未记录的方向"}」，这一轮是「${direction}」，不是同一个方向；这次查询会再扣一次点数。`;
  }
  return { ready: true, reason: null, plan, binding, warning, estimatedPoints, maxCredits, direction, resume };
}
