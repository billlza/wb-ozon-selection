import { STORE_LABELS, STATUS_LABELS } from "./constants.js";
import { orderCandidates } from "./candidateViews.js";
import { errorMessage, safeImageUrl, safeWebUrl } from "./formState.js";

/** The owner only makes judgment calls here, so every label below is a plain business word. */
export const DESK_STORES = Object.freeze(["dandanshu", "miska", "wb"]);
export const DECLINE_REASONS = Object.freeze(["尺寸太大", "利润太薄", "品牌风险", "不想做这类", "其他"]);
export const FEED_SORTS = Object.freeze([
  { value: "profit", label: "按预估利润" },
  { value: "sales", label: "按月销" },
  { value: "freight", label: "按运费占比" }
]);
export const BOARD_COLUMNS = Object.freeze([
  { key: "find", title: "找货" },
  { key: "profit", title: "算利润" },
  { key: "copy", title: "文案素材" },
  { key: "publish", title: "上架" },
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
 * Owner feedback 2026-09-11: "还有 5 条需要我处理，我不能直观看到它要处理什么，得挨个打开."
 * Every sentence below is read from this product's own saved records — the capture job, the 找货 declaration, the
 * estimate beside it and the platform's own asks. Nothing is inferred from a status name, and a product whose records
 * say nothing specific says "未取得" rather than inventing a reason.
 */
export function ownerAttentionReasons(candidate) {
  if (!isObject(candidate)) return { reasons: ["未取得需要你做什么的记录"], action: { key: "open", label: "打开" } };
  const capture = captureAttention(candidate);
  const draft = draftAttention(candidate);
  const needs = list(candidate.needsFromUser).map(need => text(need)).filter(need => need !== null);
  // The platform's own ask can repeat a sentence the records already produced; the owner reads it once.
  const reasons = [...new Set([capture?.reason ?? null, draft.reason, ...needs].filter(reason => reason !== null))];
  return {
    reasons: reasons.length ? reasons : ["未取得需要你做什么的具体记录，打开看它的六步"],
    action: capture?.action ?? draft.action
  };
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

export function boardColumnKey(candidate) {
  if (candidate.workflowStatus === "listed") return "live";
  const phase = typeof candidate.executionRuntime?.businessPhase === "string" ? candidate.executionRuntime.businessPhase : "";
  if (phase.startsWith("A")) return "find";
  if (phase.startsWith("B")) return "profit";
  if (phase.startsWith("C")) return "copy";
  if (phase.startsWith("D")) return "publish";
  if (phase.startsWith("E")) return "live";
  return {
    awaiting_user_direction: "find",
    codex_processing: "find",
    needs_user_data: "find",
    listing_preparation: "copy",
    ready_to_list: "publish"
  }[candidate.workflowStatus] ?? "find";
}

function boardCard(candidate) {
  const needs = list(candidate.needsFromUser).filter(need => text(need) !== null);
  return {
    id: candidate.id,
    // A saved candidate keeps one product name: the title the provider returned when it entered the review board.
    title: text(candidate.productName) ?? candidate.id,
    imageUrl: safeImageUrl(candidate.imageUrl),
    storeLabel: storeLabel(candidate.targetStore),
    statusLine: STATUS_LABELS[candidate.displayStatus ?? candidate.workflowStatus] ?? "状态未取得",
    waitingLine: needs[0] ?? null
  };
}

export function activeCandidates(candidates, store) {
  return orderCandidates(list(candidates).filter(candidate =>
    isObject(candidate) && candidate.workflowStatus !== "eliminated" && (store === null || candidate.targetStore === store)));
}

export function boardColumns(candidates, store) {
  const active = activeCandidates(candidates, store);
  return BOARD_COLUMNS.map(column => ({
    ...column,
    cards: active.filter(candidate => boardColumnKey(candidate) === column.key).map(boardCard)
  }));
}

/**
 * A product is in 需要你处理 when the platform itself asks the owner for something, and also when its own saved capture
 * job is standing still on him: a captured 1688 page waiting for a size choice, or a capture that stopped. Those two
 * are unambiguous — nobody but the owner can move them — and leaving them out was how a finished capture could sit
 * unnoticed. Everything else stays on 我选的商品 with its own chip.
 */
function waitsOnOwner(candidate) {
  if (list(candidate.needsFromUser).some(need => text(need) !== null)) return true;
  const capture = candidate.sourceCapture;
  if (!isObject(capture)) return false;
  return skuChoicePending(capture) || text(capture.failureCode) !== null;
}

export function inboxItems(candidates, store) {
  return activeCandidates(candidates, store)
    .map(candidate => ({ candidate, card: boardCard(candidate) }))
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
    board: boardColumns(candidates, store).reduce((total, column) => total + column.cards.length, 0),
    inbox: inboxItems(candidates, store).length
  };
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
