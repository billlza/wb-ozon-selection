import { canonicalImageSearchSourceUrl, canonicalSupplierImageUrl, captureNumber, captureText } from "./capture-evidence-sanitization.mjs";
import { SUPPLIER_IMAGE_MATCH_SOURCE_LABELS, SUPPLIER_IMAGE_MATCH_SOURCE_PLATFORMS, supplierImageMatchSearchUrl,
  supplierImageMatchSource } from "./supplier-image-match-source.mjs";
import { IMAGE_FINGERPRINT_VERSION, classifyImageSimilarity, imageFingerprintDistance, isImageFingerprint } from "./image-fingerprint.mjs";

/**
 * 用首图在 1688 找同款 —— 一次由主人点出来的、只读的登录态搜索。
 *
 * 三种入口共用这一套：主人给的拼多多链接、主人给的 1688 链接（采到的那家货的首图），或者从 Seerfar / Ozon 来的商品
 * （它在 Ozon 上的主图）。拿到图以后，主人可以让插件在他自己登录的 1688 里用这张图搜一次。
 * 这里只放不碰网络、不碰业务状态的规则：
 *   1. 哪件商品、哪张图可以拿去搜，搜索地址怎么拼（在 supplier-image-match-source.mjs，商品页也用同一份）；
 *   2. 搜索作业何时能开、何时算还在进行；
 *   3. 插件读回来的结果怎么核验（只留商品事实，账号、会话、广告跳转这些一律不进来）；
 *   4. 首图指纹比对之后怎么分档，以及主人对每一条的判断怎么记。
 *
 * 软件只回答「首图看起来是不是同一张」。是不是同款，永远由主人逐条判断（精确同款 / 近似款 / 不是），
 * 近似款只能当价格参考，不能当供货方案（AGENTS.md §4.3）。没登录时 1688 不提示登录、只显示「没有结果」，
 * 所以一条结果都没读到时，结论是「无法核实」，绝不是「没有同款」（AGENTS.md §8.3）。
 */
export const SUPPLIER_IMAGE_MATCH_MODE = "a_supplier_image_match";
export const SUPPLIER_IMAGE_MATCH_SCHEMA = "supplier-image-match-v1";
export const SUPPLIER_IMAGE_MATCH_REQUEST_TYPE = "SELECTION_REVIEW_1688_IMAGE_MATCH_REQUEST";
export const SUPPLIER_IMAGE_MATCH_MAX_RESULTS = 20;
export const SUPPLIER_IMAGE_MATCH_JUDGEMENTS = Object.freeze(["exact", "near", "wrong"]);
export const SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS = Object.freeze({ exact: "是同款", near: "近似款", wrong: "不是" });
const HISTORY_LIMIT = 5;
const IN_FLIGHT = Object.freeze(["waiting_extension", "searching"]);

export { SUPPLIER_IMAGE_MATCH_SOURCE_LABELS, SUPPLIER_IMAGE_MATCH_SOURCE_PLATFORMS, supplierImageMatchSearchUrl, supplierImageMatchSource };

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function supplierImageMatchInFlight(record) {
  return isObject(record) && (IN_FLIGHT.includes(record.status) || ["queued", "claimed"].includes(record.jobStatus));
}

/** 这件商品此刻能不能再搜一次：淘汰了不行，上一次还没结束不行，上一次结果未知时要主人先说一声知道了。 */
export function supplierImageMatchStartBlocker(candidate, { acknowledgeUnknownOutcome = false } = {}) {
  if (candidate?.workflowStatus === "eliminated") {
    return { code: "candidate_eliminated", reason: "这件商品已经淘汰，不能再找同款。" };
  }
  const record = candidate?.supplierImageMatch;
  if (supplierImageMatchInFlight(record)) {
    return { code: "image_match_in_flight", reason: "上一次在 1688 找同款还没结束，等它结束再找。" };
  }
  if (record?.jobStatus === "unknown_outcome" && acknowledgeUnknownOutcome !== true) {
    return { code: "image_match_unknown_outcome",
      reason: "上一次找同款插件领取了但没有回传结果，结果未知。确认知道这一点后，才能再搜一次（这是新的一次只读搜索，不会补上一次的结果）。" };
  }
  return null;
}

const OFFER_ID = /^[1-9]\d{5,19}$/;
const text = (value, limit) => captureText(value, limit).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
function nonNegativeInteger(value) {
  const parsed = captureNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 核验插件读回来的搜图结果。页面回显的搜索图必须就是这次要搜的那张，否则是别的搜索，整份拒绝。
 * 每一条只留商品事实；商品页地址由服务端按商品编号自己拼，广告的跳转地址不进来。
 */
export function sanitizeSupplierImageMatchEvidence(input, expectedImageUrl, { sourceOfferId = "" } = {}) {
  if (!isObject(input)) throw new Error("invalid_capture");
  if (canonicalImageSearchSourceUrl(input.searchImageUrl) !== expectedImageUrl || input.searchImageUrl !== expectedImageUrl) {
    throw new Error("wrong_query");
  }
  const observedAt = text(input.observedAt, 80);
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) throw new Error("invalid_capture");
  const cardCount = nonNegativeInteger(input.cardCount);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (cardCount === null || cardCount > 500 || !rawItems.length) throw new Error("results_unverifiable");
  if (rawItems.length > SUPPLIER_IMAGE_MATCH_MAX_RESULTS || rawItems.length > cardCount) throw new Error("invalid_capture");
  const seen = new Set();
  const items = rawItems.map(item => {
    if (!isObject(item)) throw new Error("invalid_capture");
    const offerId = typeof item.offerId === "string" ? item.offerId : "";
    if (!OFFER_ID.test(offerId) || seen.has(offerId)) throw new Error("invalid_capture");
    seen.add(offerId);
    const priceCny = captureNumber(item.priceCny);
    const vendorSimilarity = typeof item.vendorSimilarity === "number" && Number.isFinite(item.vendorSimilarity) &&
      item.vendorSimilarity >= 0 && item.vendorSimilarity <= 1 ? Math.round(item.vendorSimilarity * 1000) / 1000 : null;
    const rank = nonNegativeInteger(item.rank);
    const quantityBegin = nonNegativeInteger(item.quantityBegin);
    return {
      offerId,
      sourceUrl: `https://detail.1688.com/offer/${offerId}.html`,
      title: text(item.title, 300),
      imageUrl: canonicalSupplierImageUrl(item.imageUrl),
      priceCny: priceCny !== null && priceCny > 0 && priceCny <= 1_000_000 ? priceCny : null,
      priceNote: text(item.priceNote, 60) || null,
      quantityBegin: quantityBegin !== null && quantityBegin >= 1 ? quantityBegin : null,
      saleQuantity: nonNegativeInteger(item.saleQuantity),
      shopName: text(item.shopName, 80) || null,
      location: text(item.location, 40) || null,
      isAd: item.isAd === true,
      superFactory: item.superFactory === true,
      vendorSimilarity,
      rank: rank !== null && rank < cardCount ? rank : null,
      // 用 1688 首图去搜时，主人给的那家货自己也会出现在结果里；标出来，免得把它当成另一家。
      isSourceOffer: sourceOfferId !== "" && offerId === sourceOfferId
    };
  });
  return { searchImageUrl: expectedImageUrl, observedAt: new Date(observedAt).toISOString(), cardCount, items };
}

const STOP_MESSAGES = Object.freeze({
  site_login_required: "1688 需要登录：请在这台电脑的 Chrome 里登录 1688 后再找一次。没登录时 1688 只会显示没有结果，所以这次不能说明没有同款",
  site_verification_required: "1688 要求先完成验证（滑块或验证码）：请在 Chrome 里打开 1688 完成验证后再找一次",
  results_unverifiable: "1688 这次没有返回任何结果。没登录时它也会这样显示，所以这不能说明没有同款；请确认 Chrome 里已登录 1688 后再找一次",
  wrong_query: "1688 页面搜的不是这张首图，这次结果已拒绝",
  navigation_rejected: "插件打开的不是 1688 搜图结果页，这次已停止",
  structured_data_unavailable: "1688 搜图页面没有可核验的商品数据，这次已停止",
  timeout: "1688 搜图页面在期限内没有读完，这次已停止",
  invalid_capture: "插件回传的搜图结果没有通过服务端校验，这次已拒绝",
  extension_job_unclaimed: "这次找同款在等待期限内没有被插件领取，已经停下，软件不会自动重试",
  unknown_outcome: "插件领取了这次找同款，但在执行期限内没有回传可验证结果，这次的结果未知",
  capture_job_lost: "评审台服务重启了，这次找同款不会再有结果，需要重新找一次",
  extension_version_mismatch: "这次找同款要求的插件版本与当前插件版本不一致",
  system_error: "插件在找同款时发生系统错误，这次已停止"
});

export function supplierImageMatchStopMessage(code, detail = "") {
  const base = STOP_MESSAGES[code] || STOP_MESSAGES.system_error;
  return detail ? `${base}：${String(detail).slice(0, 300)}` : base;
}

export function supplierImageMatchFailureCode(value) {
  const code = String(value || "").trim();
  return Object.hasOwn(STOP_MESSAGES, code) ? code : "system_error";
}

/** 排队那一刻写进商品记录的样子；同时把上一份结果收进历史（最多留 5 份），主人的判断跟着它走。 */
export function queuedSupplierImageMatchRecord(previous, { captureId, source, requiredExtensionVersion, authorizedBy, authorizedAt, candidateRevision }) {
  const history = [
    ...(isObject(previous) ? [summaryForHistory(previous)] : []),
    ...(Array.isArray(previous?.history) ? previous.history : [])
  ].slice(0, HISTORY_LIMIT);
  return {
    schemaVersion: SUPPLIER_IMAGE_MATCH_SCHEMA,
    captureId,
    jobId: captureId,
    status: "waiting_extension",
    jobStatus: "queued",
    attempt: 0,
    requiredExtensionVersion,
    source: { ...source },
    searchUrl: supplierImageMatchSearchUrl(source.imageUrl),
    // 这一次登录态只读搜索的授权：谁、什么时候、对哪件商品的哪一版、只准搜一次、最多读回多少条（AGENTS.md §8.1）。
    // 比对首图时服务端还会去两家图床各取一次公开图片（货源首图一张，每条结果的主图各一张），不带任何登录信息。
    authorization: { action: "1688_image_search", site: "1688", loginStateRead: true, maxSearches: 1,
      maxResults: SUPPLIER_IMAGE_MATCH_MAX_RESULTS, publicImageReads: SUPPLIER_IMAGE_MATCH_MAX_RESULTS + 1,
      authorizedBy, authorizedAt, candidateRevision },
    startedAt: authorizedAt,
    claimedAt: null,
    observedAt: null,
    completedAt: null,
    cardCount: null,
    results: [],
    comparison: null,
    judgements: {},
    failureCode: null,
    reason: null,
    businessStateEffect: "unchanged",
    retryAttempted: false,
    writeOccurred: false,
    history
  };
}

function summaryForHistory(record) {
  return {
    captureId: record.captureId,
    status: record.status,
    jobStatus: record.jobStatus,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    resultCount: Array.isArray(record.results) ? record.results.length : 0,
    failureCode: record.failureCode ?? null,
    judgements: isObject(record.judgements) ? structuredClone(record.judgements) : {},
    results: (Array.isArray(record.results) ? record.results : []).filter(item => record.judgements?.[item.offerId])
      .map(item => ({ offerId: item.offerId, sourceUrl: item.sourceUrl, title: item.title, priceCny: item.priceCny }))
  };
}

/** 插件交回核验过的结果：先存下来，状态是「正在比对首图」；比对是之后单独一步。 */
export function supplierImageMatchResultsRecorded(record, evidence, timestamp) {
  return {
    ...record,
    status: "comparing",
    jobStatus: "completed",
    observedAt: evidence.observedAt,
    completedAt: timestamp,
    cardCount: evidence.cardCount,
    results: evidence.items.map(item => ({ ...item, fingerprint: null, distance: null, similarity: "unknown", compareError: null })),
    comparison: null,
    failureCode: null,
    reason: null
  };
}

export function supplierImageMatchFailed(record, code, { observedAt, timestamp, detail = "" }) {
  const failureCode = supplierImageMatchFailureCode(code);
  return {
    ...record,
    status: "failed",
    jobStatus: failureCode === "unknown_outcome" ? "unknown_outcome" : "failed",
    observedAt: observedAt ?? timestamp,
    completedAt: timestamp,
    failureCode,
    reason: supplierImageMatchStopMessage(failureCode, detail),
    businessStateEffect: "unchanged",
    retryAttempted: false,
    writeOccurred: false
  };
}

async function mapLimited(items, limit, task) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

/**
 * 取指纹：货源首图一次，每条结果的主图各一次。取不到的那一条标「无法比对」，不猜、不跳过、不重试。
 * fingerprintOf 由调用方注入（服务端用 fetchImageFingerprint），这里不碰网络。
 */
export async function computeSupplierImageMatchComparison(record, { fingerprintOf, comparedAt }) {
  if (typeof fingerprintOf !== "function") throw new TypeError("SUPPLIER_IMAGE_MATCH_COMPARE_DEPENDENCY_INVALID");
  const attempt = async url => {
    if (!url) return { fingerprint: null, error: "image_missing" };
    try {
      const fingerprint = await fingerprintOf(url);
      return isImageFingerprint(fingerprint) ? { fingerprint, error: null } : { fingerprint: null, error: "image_unreadable" };
    } catch (error) {
      return { fingerprint: null, error: typeof error?.code === "string" ? error.code.toLowerCase().slice(0, 40) : "image_unreadable" };
    }
  };
  const source = await attempt(record.source?.imageUrl);
  const results = await mapLimited(record.results, 4, async item => {
    const read = await attempt(item.imageUrl);
    if (!source.fingerprint || !read.fingerprint) {
      return { offerId: item.offerId, fingerprint: read.fingerprint, distance: null, similarity: "unknown",
        compareError: source.fingerprint ? read.error : "source_image_unreadable" };
    }
    const distance = imageFingerprintDistance(source.fingerprint, read.fingerprint);
    return { offerId: item.offerId, fingerprint: read.fingerprint, distance, similarity: classifyImageSimilarity(distance), compareError: null };
  });
  return { captureId: record.captureId, version: IMAGE_FINGERPRINT_VERSION, comparedAt, sourceFingerprint: source.fingerprint,
    sourceError: source.error, results };
}

/** 主人要求再比一次（例如上次有几张图没取到）：结果和主人的判断都不动，只把状态退回「正在比对首图」。 */
export function supplierImageMatchComparisonRequested(record) {
  if (!isObject(record) || !["comparing", "compared"].includes(record.status)) throw new Error("image_match_not_comparable");
  return { ...record, status: "comparing" };
}

/** 把比对结果落到同一份记录上。记录换了（又搜了一次）或者不在比对中，就什么也不做。 */
export function supplierImageMatchComparisonApplied(record, comparison) {
  if (!isObject(record) || record.status !== "comparing" || record.captureId !== comparison?.captureId) return null;
  const byOffer = new Map(comparison.results.map(row => [row.offerId, row]));
  if (byOffer.size !== record.results.length || record.results.some(item => !byOffer.has(item.offerId))) return null;
  return {
    ...record,
    status: "compared",
    comparison: { version: comparison.version, comparedAt: comparison.comparedAt,
      sourceFingerprint: comparison.sourceFingerprint, sourceError: comparison.sourceError },
    results: record.results.map(item => {
      const row = byOffer.get(item.offerId);
      return { ...item, fingerprint: row.fingerprint, distance: row.distance, similarity: row.similarity, compareError: row.compareError };
    })
  };
}

/** 主人对其中一条的判断。只认这次结果里真有的那一条；clear 撤回判断。 */
export function supplierImageMatchJudged(record, { offerId, judgement, judgedAt, judgedBy }) {
  if (!isObject(record) || !["comparing", "compared"].includes(record.status)) throw new Error("image_match_not_judgeable");
  if (!record.results.some(item => item.offerId === offerId)) throw new Error("image_match_offer_unknown");
  const judgements = { ...(isObject(record.judgements) ? record.judgements : {}) };
  if (judgement === "clear") delete judgements[offerId];
  else if (SUPPLIER_IMAGE_MATCH_JUDGEMENTS.includes(judgement)) judgements[offerId] = { judgement, judgedAt, judgedBy };
  else throw new Error("image_match_judgement_invalid");
  return { ...record, judgements };
}

/**
 * 插件领取这次作业时拿到的东西。形状由插件的 validateImageMatchRequest 说了算：带 mode、imageUrl 和 searchUrl，
 * 不带 sourceUrl、productUrl、expectedProductId —— 所以它不会被认成供应采集或 Ozon 读页面。
 */
export function supplierImageMatchJobPayload(session) {
  return {
    captureId: session.captureId,
    jobId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    mode: SUPPLIER_IMAGE_MATCH_MODE,
    imageUrl: session.imageUrl,
    searchUrl: session.searchUrl,
    maxResults: SUPPLIER_IMAGE_MATCH_MAX_RESULTS,
    requiredExtensionVersion: session.requiredExtensionVersion,
    attempt: session.attempt,
    token: session.token
  };
}

/** 页面拿到的回执：同一次作业，没有一次性令牌。 */
export function supplierImageMatchJobPublic(session) {
  return {
    jobId: session.captureId,
    candidateId: session.candidateId,
    requestRevision: session.requestRevision,
    dataRevision: session.dataRevision,
    mode: SUPPLIER_IMAGE_MATCH_MODE,
    imageUrl: session.imageUrl,
    status: session.jobStatus,
    attempt: session.attempt,
    requiredExtensionVersion: session.requiredExtensionVersion,
    createdAt: new Date(session.createdAt).toISOString(),
    claimedAt: session.claimedAt ? new Date(session.claimedAt).toISOString() : null,
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}
