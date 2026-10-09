import { validateSalesSnapshot } from "./sales-snapshot.mjs";
import { ozonCapturePageTarget } from "./ozon-page-capture-job.mjs";

/**
 * 算利润之前的那一小块：这件商品的类目到底是不是真实读过的 Ozon 页面给的。
 *
 * 算利润的确认走的是同一条 A 确认路，服务端在里面锁定这一步要用的技术范围，而类目那一项只认
 * collectorMode === "real_page_read_only" 的销售快照（lib/lifecycle-b-evidence-context.mjs 的 newestCategorySnapshot）。
 * Seerfar 接口给的那份快照 collectorMode 是 provider_category_result_read_only，服务端不认，于是主人点下确认
 * 只会收到一个 B_EVIDENCE_CONTEXT_INCOMPLETE: 当前类目（2026-09-14，第一件真货就卡在这里）。
 *
 * 这里把同一个判断提前说清楚：按钮不给点，并且说明为什么、以及唯一的出路是读一次这个 Ozon 页面。
 * 判断用的是服务端自己那份记录，不是页面自己猜的；这个文件不发请求、不写业务状态、不产生任何快照。
 */
export const OZON_CATEGORY_READ_STEP_VERSION = "ozon-category-read-step-v1";

/** 只有真实打开过商品页读回来的快照，算利润才认它的类目。 */
export const REAL_PAGE_COLLECTOR_MODE = "real_page_read_only";

const COLLECTOR_MODE_WORDS = Object.freeze({
  real_page_read_only: "真实打开过的 Ozon 商品页",
  provider_category_result_read_only: "Seerfar 的接口结果",
  mock_read_only: "演示用的假数据"
});

/** 这一次读页面只做什么、不做什么。放在按钮旁边，每次都说一遍。 */
export const OZON_PAGE_READ_SCOPE_LINE =
  "读的时候软件只用你自己的浏览器打开这一个商品页看一眼，不下单、不联系任何人，也不向 Ozon 写任何东西。" +
  "页面如果要登录或者要你过验证，软件会如实停下来告诉你，不会自己绕过去，也不会编一份结果。";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function known(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "unknown";
}

function validSnapshots(candidate) {
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .filter(snapshot => validateSalesSnapshot(snapshot).valid)
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt));
}

/** 算利润认的那一份：真实读过的页面，而且页面上确实读到了类目。与服务端的判断逐条同源。 */
export function realPageCategorySnapshot(candidate) {
  return validSnapshots(candidate)
    .find(snapshot => snapshot.collectorMode === REAL_PAGE_COLLECTOR_MODE && known(snapshot.categoryPath)) ?? null;
}

/** 这件商品现在显示的类目来自哪一份快照（不管算利润认不认）。 */
export function savedCategorySnapshot(candidate) {
  return validSnapshots(candidate).find(snapshot => known(snapshot.categoryPath)) ?? null;
}

function collectorModeWords(snapshot) {
  return COLLECTOR_MODE_WORDS[snapshot?.collectorMode] ?? "来路不明的记录";
}

/** 上一次读这个页面读成了什么。没读过就是 null，绝不拿别的记录顶替。 */
export function ozonPageReadRecord(candidate) {
  const capture = isObject(candidate?.salesCapture) ? candidate.salesCapture : null;
  if (capture === null || !known(capture.captureId)) return null;
  return {
    captureId: capture.captureId,
    status: typeof capture.status === "string" ? capture.status : "",
    jobStatus: typeof capture.jobStatus === "string" ? capture.jobStatus : null,
    failureCode: typeof capture.failureCode === "string" ? capture.failureCode : null,
    reason: typeof capture.reason === "string" ? capture.reason : "",
    productId: typeof capture.productId === "string" ? capture.productId : "",
    observedAt: typeof capture.observedAt === "string" ? capture.observedAt : null,
    writeOccurred: capture.writeOccurred === true
  };
}

/** 还在等插件的那一次读：等它结束之前不能再发起第二次。 */
export function ozonPageReadInFlight(record) {
  return record !== null &&
    (["waiting_extension", "capturing"].includes(record.status) || ["queued", "claimed"].includes(record.jobStatus ?? ""));
}

/**
 * 算利润这一步在类目上到底通不通，通不过的时候差什么、出路是什么。
 * ready 为真的两种情况：这件商品已经存了一条明确的技术范围类目，或者有一份真实读过的页面快照带着类目。
 */
export function buildOzonCategoryReadStep(candidate) {
  const explicitCategory = isObject(candidate?.lifecycleEvidenceContextV11)
    ? candidate.lifecycleEvidenceContextV11.category : null;
  const realPage = realPageCategorySnapshot(candidate);
  const saved = savedCategorySnapshot(candidate);
  const record = ozonPageReadRecord(candidate);
  const inFlight = ozonPageReadInFlight(record);
  const target = ozonCapturePageTarget(candidate);
  const ready = known(explicitCategory) || realPage !== null;
  const readySource = known(explicitCategory) ? "explicit_context" : realPage !== null ? "real_page_snapshot" : null;

  const why = ready
    ? known(explicitCategory)
      ? `这件商品的类目已经定下来了：${String(explicitCategory).trim()}。`
      : `这件商品的类目「${realPage.categoryPath}」是软件真实打开 Ozon 商品页读到的，算利润可以用它。`
    : saved === null
      ? "这件商品还没有读到过类目。算利润要用的类目，必须来自真实打开过的 Ozon 商品页。"
      : `算利润要用的类目，必须来自真实打开过的 Ozon 商品页。现在这条类目「${saved.categoryPath}」是${collectorModeWords(saved)}给的，` +
        "不是页面上读到的，所以这一步还不能确认。";

  const unavailableReason = ready
    ? "这件商品的类目已经是真实读过的页面给的，不用再读一次。"
    : inFlight
      ? "上一次读这个页面还没有结束，等它结束之后再说。"
      : target.ok ? "" : target.reason;

  return {
    schemaVersion: OZON_CATEGORY_READ_STEP_VERSION,
    candidateId: typeof candidate?.id === "string" ? candidate.id : "",
    dataRevision: Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
    ready,
    readySource,
    category: known(explicitCategory) ? String(explicitCategory).trim() : realPage?.categoryPath ?? saved?.categoryPath ?? null,
    categoryFrom: realPage !== null ? collectorModeWords(realPage) : saved !== null ? collectorModeWords(saved) : null,
    categoryCollectorMode: (realPage ?? saved)?.collectorMode ?? null,
    target: target.ok ? { productId: target.productId, productUrl: target.productUrl, from: target.from } : null,
    blocked: target.ok ? null : { code: target.code, reason: target.reason },
    lastRead: record,
    inFlight,
    why,
    scopeLine: OZON_PAGE_READ_SCOPE_LINE,
    action: {
      label: "读一次这个 Ozon 页面",
      available: !ready && !inFlight && target.ok,
      reason: unavailableReason
    }
  };
}
