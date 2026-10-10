import { canonicalOzonImageUrl, captureNumber, captureText } from "./capture-evidence-sanitization.mjs";
import { IMAGE_MATCH_JUDGEMENT_LABELS, createImageMatchRules } from "./image-match-record.mjs";
import { OZON_IMAGE_SEARCH_ENTRY_URL, OZON_SEARCH_QUERY_MAX_LENGTH, normalizeOzonSearchQuery, ozonImageSearchId, ozonProductId,
  ozonSearchUrl, suggestedOzonSearchQuery } from "./ozon-search-query.mjs";
import { supplierImageMatchSource } from "./supplier-image-match-source.mjs";

export { OZON_IMAGE_SEARCH_ENTRY_URL, OZON_SEARCH_QUERY_MAX_LENGTH, normalizeOzonSearchQuery, ozonImageSearchId, ozonSearchUrl,
  suggestedOzonSearchQuery };

/**
 * 在 Ozon 找同款 —— 主人点一次，插件用这台电脑的 Chrome 在 Ozon 搜一次，读回结果页上的商品，服务端再拿首图（拼多多或
 * 1688 货源首图，没有就用这件商品的 Ozon 主图）和每条结果的主图比一次，标出像不像。两种搜法：
 *   · 以图搜（默认，主人 2026-10-10 定）：插件在 Ozon 首页的搜索栏上传这张首图，Ozon 跳到 /search-by-image 给出结果；
 *   · 俄文词搜（后备）：以图搜只找到近似款时，主人填几个俄文词，在 Ozon 站内搜一次。
 * Ozon 不给相似度分数，同一张图也可能对应好几个规格，所以「首图一致」由服务端自己比，是不是同款、是哪个规格永远由主人
 * 逐条判断（AGENTS.md §4.3）。只找到近似款是常见结果；搜不到只说明这一次没搜到，绝不说成「Ozon 上没有同款」。
 * 这里只放不碰网络、不碰业务状态的规则：读回来的结果怎么核验、停下时说什么。搜索词怎么认、地址怎么拼、预先填什么词在
 * ozon-search-query.mjs（商品页也用同一份）。搜索记录从排队到主人判断的生命周期和 1688 找同款共用 image-match-record.mjs。
 */
export const OZON_IMAGE_MATCH_MODE = "ozon_same_product_match";
export const OZON_IMAGE_MATCH_SCHEMA = "ozon-image-match-v1";
export const OZON_IMAGE_MATCH_REQUEST_TYPE = "SELECTION_REVIEW_OZON_IMAGE_MATCH_REQUEST";
// Ozon 词搜第一屏大约 36 件，多看一屏才不容易漏掉同款；以图搜第一页 12 件带完整数据，往下滚出来的几页最多也读到 36 件。
export const OZON_IMAGE_MATCH_MAX_RESULTS = 36;
export const OZON_IMAGE_MATCH_JUDGEMENT_LABELS = IMAGE_MATCH_JUDGEMENT_LABELS;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 这次在 Ozon 找同款要用的东西：比对用哪张首图（与 1688 找同款同一份规则），搜什么词，这件商品自己在 Ozon 上是哪一件
 * （它自己出现在结果里时标出来，免得当成另一家）。
 */
export function ozonImageMatchTarget(candidate, query, { searchBy = "text" } = {}) {
  const picture = supplierImageMatchSource(candidate);
  if (!picture.ok) {
    return { ok: false, code: picture.code,
      reason: picture.code === "main_image_missing" ? picture.reason
        : "先用插件采到拼多多或 1688 货源页面，或者这件商品要有 Ozon 主图，才有首图可以和 Ozon 的结果比。" };
  }
  const ownProductId = ozonProductId(candidate?.productUrl) ?? "";
  // 以图搜：上传的就是比对用的这张首图，不带任何词。
  if (searchBy === "image") {
    return { ok: true, searchBy, imageUrl: picture.imageUrl, query: null, searchUrl: OZON_IMAGE_SEARCH_ENTRY_URL, queryOrigin: null,
      source: picture.source, ownProductId };
  }
  if (searchBy !== "text") return { ok: false, code: "ozon_search_by_invalid", reason: "只能用首图搜，或者用俄文词搜。" };
  const normalized = normalizeOzonSearchQuery(query);
  if (!normalized) {
    return { ok: false, code: "ozon_search_query_invalid",
      reason: `请填 Ozon 上用的俄文搜索词（2 到 ${OZON_SEARCH_QUERY_MAX_LENGTH} 个字，至少有一个字母）。` };
  }
  const suggested = suggestedOzonSearchQuery(candidate);
  return { ok: true, searchBy, imageUrl: picture.imageUrl, query: normalized, searchUrl: ozonSearchUrl(normalized),
    queryOrigin: suggested.query === normalized ? suggested.origin : "owner",
    source: picture.source, ownProductId };
}

const PRODUCT_ID = /^[1-9]\d{4,19}$/;
const text = (value, limit) => captureText(value, limit).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
function nonNegativeInteger(value) {
  const parsed = captureNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function rubles(value) {
  const parsed = captureNumber(value);
  return parsed !== null && parsed > 0 && parsed <= 10_000_000 ? Math.round(parsed * 100) / 100 : null;
}

/**
 * 核验插件读回来的 Ozon 搜索结果。词搜：页面搜的必须就是这次的词，否则是别的搜索，整份拒绝。以图搜：结果页必须是
 * Ozon 的以图搜页，带着它给这次上传编的号（插件自己上传、自己看着页面跳过去的；号本身看不出是哪张图，只记下来）。
 * 每一条只留商品事实；商品页地址由服务端按商品编号自己拼，页面上的跳转参数不进来。
 */
export function sanitizeOzonImageMatchEvidence(input, expectedQuery, { ownProductId = "", searchBy = "text" } = {}) {
  if (!isObject(input)) throw new Error("invalid_capture");
  const byImage = searchBy === "image";
  if (byImage ? input.searchBy !== "image" || input.query !== undefined : input.searchBy !== undefined) throw new Error("wrong_query");
  if (!byImage && normalizeOzonSearchQuery(input.query) !== expectedQuery) throw new Error("wrong_query");
  const imageId = byImage ? ozonImageSearchId(input.imageId) : null;
  if (byImage && !imageId) throw new Error("wrong_query");
  const observedAt = text(input.observedAt, 80);
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) throw new Error("invalid_capture");
  // 以图搜第一页的数据在页面自带的结果数据里，往下滚出来的几页只在网页上，所以可能两处合起来读（mixed）。
  if (!(byImage ? ["state", "dom", "mixed"] : ["state", "dom"]).includes(input.readFrom)) throw new Error("invalid_capture");
  const cardCount = nonNegativeInteger(input.cardCount);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (cardCount === null || cardCount > 500 || !rawItems.length) throw new Error("results_unverifiable");
  if (rawItems.length > OZON_IMAGE_MATCH_MAX_RESULTS || rawItems.length > cardCount) throw new Error("invalid_capture");
  const seen = new Set();
  const items = rawItems.map(item => {
    if (!isObject(item)) throw new Error("invalid_capture");
    const productId = typeof item.productId === "string" ? item.productId : "";
    if (!PRODUCT_ID.test(productId) || seen.has(productId)) throw new Error("invalid_capture");
    seen.add(productId);
    const priceRub = rubles(item.priceRub);
    const originalPriceRub = rubles(item.originalPriceRub);
    const rating = captureNumber(item.rating);
    const rank = nonNegativeInteger(item.rank);
    return {
      productId,
      sourceUrl: `https://www.ozon.ru/product/${productId}/`,
      title: text(item.title, 300),
      imageUrl: canonicalOzonImageUrl(item.imageUrl),
      priceRub,
      originalPriceRub: originalPriceRub !== null && priceRub !== null && originalPriceRub > priceRub ? originalPriceRub : null,
      rating: rating !== null && rating > 0 && rating <= 5 ? Math.round(rating * 10) / 10 : null,
      reviewCount: nonNegativeInteger(item.reviewCount),
      isAd: item.isAd === true,
      rank: rank !== null && rank < cardCount ? rank : null,
      // 搜的是这件商品自己在 Ozon 上卖的东西时，它自己也会出现在结果里；标出来，免得把它当成另一家。
      isSourceProduct: ownProductId !== "" && productId === ownProductId
    };
  });
  const facts = { observedAt: new Date(observedAt).toISOString(), cardCount, readFrom: input.readFrom, items };
  return byImage ? { searchBy: "image", imageId, ...facts } : { query: expectedQuery, ...facts };
}

const STOP_MESSAGES = Object.freeze({
  site_verification_required: "Ozon 要求先完成人机验证：请在这台电脑的 Chrome 里打开 Ozon 完成验证后再找一次",
  site_login_required: "Ozon 要求先登录：请在这台电脑的 Chrome 里登录 Ozon 后再找一次",
  results_empty: "Ozon 这次没有搜到商品。这只说明这一次没搜到，不能说明 Ozon 上没有同款；可以用俄文词再搜一次",
  results_unverifiable: "Ozon 搜索页在期限内没有显示任何商品，这次不能说明没有同款；请再找一次",
  wrong_query: "Ozon 页面搜的不是这次的图或这几个词，这次结果已拒绝",
  image_upload_unavailable: "插件在 Ozon 页面上没找到以图搜的上传按钮，这次没有搜成；可以先用俄文词搜",
  search_image_unavailable: "评审台没能取到这张首图交给插件上传，这次没有搜成；请再找一次，或者先用俄文词搜",
  navigation_rejected: "插件打开的不是 Ozon 搜索结果页，这次已停止",
  structured_data_unavailable: "Ozon 搜索页没有可核验的商品数据，这次已停止",
  timeout: "Ozon 搜索页在期限内没有读完，这次已停止",
  invalid_capture: "插件回传的搜索结果没有通过服务端校验，这次已拒绝",
  extension_job_unclaimed: "这次在 Ozon 找同款在等待期限内没有被插件领取，已经停下，软件不会自动重试",
  unknown_outcome: "插件领取了这次在 Ozon 找同款，但在执行期限内没有回传可验证结果，这次的结果未知",
  capture_job_lost: "评审台服务重启了，这次在 Ozon 找同款不会再有结果，需要重新找一次",
  extension_version_mismatch: "这次在 Ozon 找同款要求的插件版本与当前插件版本不一致",
  system_error: "插件在 Ozon 找同款时发生系统错误，这次已停止"
});

const rules = createImageMatchRules({
  field: "ozonImageMatch",
  idKey: "productId",
  schemaVersion: OZON_IMAGE_MATCH_SCHEMA,
  codes: { inFlight: "ozon_match_in_flight", unknownOutcome: "ozon_match_unknown_outcome", notComparable: "ozon_match_not_comparable",
    notJudgeable: "ozon_match_not_judgeable", itemUnknown: "ozon_match_product_unknown", judgementInvalid: "ozon_match_judgement_invalid" },
  stopMessages: STOP_MESSAGES,
  reasons: {
    eliminated: "这件商品已经淘汰，不能再找同款。",
    inFlight: "上一次在 Ozon 找同款还没结束，等它结束再找。",
    unknownOutcome: "上一次在 Ozon 找同款插件领取了但没有回传结果，结果未知。确认知道这一点后，才能再搜一次（这是新的一次搜索，不会补上一次的结果）。"
  },
  searchUrl: (_source, extra) => (extra.searchBy === "image" ? OZON_IMAGE_SEARCH_ENTRY_URL : ozonSearchUrl(extra.query)),
  // 这一次 Ozon 站内搜索的授权：在主人这台电脑的 Chrome 里搜一次，不加购、不收藏、不联系任何人。词搜只打开公开的搜索页，
  // 不点任何按钮；以图搜在 Ozon 首页点一次搜索栏的拍照按钮，把这张首图（货源或 Ozon 上公开的商品图）上传给 Ozon 搜一次。
  // 比对首图时服务端还会去图床各取一次公开图片（来源首图一张，每条结果的主图各一张），不带任何登录信息。
  authorization: (_source, extra) => ({ action: extra.searchBy === "image" ? "ozon_image_search" : "ozon_text_search", site: "ozon",
    loginStateRead: false, ownerBrowser: true, maxSearches: 1, ...(extra.searchBy === "image" ? { imageUploads: 1 } : {}),
    maxResults: OZON_IMAGE_MATCH_MAX_RESULTS, publicImageReads: OZON_IMAGE_MATCH_MAX_RESULTS + 1 }),
  historyFields: ["productId", "sourceUrl", "title", "priceRub"]
});

export const ozonImageMatchRules = rules;
export const ozonImageMatchInFlight = rules.inFlight;
export const ozonImageMatchStartBlocker = rules.startBlocker;
export const ozonImageMatchStopMessage = rules.stopMessage;
export const ozonImageMatchFailureCode = rules.failureCode;
export const ozonImageMatchResultsRecorded = rules.resultsRecorded;
export const ozonImageMatchFailed = rules.failed;
export const computeOzonImageMatchComparison = rules.computeComparison;
export const ozonImageMatchComparisonRequested = rules.comparisonRequested;
export const ozonImageMatchComparisonApplied = rules.comparisonApplied;

/** 排队那一刻写进商品记录的样子：怎么搜的（以图搜还是词搜），词搜还记下搜的词和它从哪来（主人填的还是预先填好的）。 */
export function queuedOzonImageMatchRecord(previous, { captureId, source, searchBy = "text", query, queryOrigin, requiredExtensionVersion,
  authorizedBy, authorizedAt, candidateRevision }) {
  const extra = searchBy === "image" ? { searchBy, query: null, queryOrigin: null } : { searchBy, query, queryOrigin };
  return rules.queuedRecord(previous, { captureId, source, requiredExtensionVersion, authorizedBy, authorizedAt, candidateRevision, extra });
}

export function ozonImageMatchJudged(record, { productId, judgement, judgedAt, judgedBy }) {
  return rules.judged(record, { itemId: productId, judgement, judgedAt, judgedBy });
}

/**
 * 插件领取这次作业时拿到的东西。形状由插件的 validateOzonImageMatchRequest 说了算：带 mode、searchBy 和 searchUrl，
 * 词搜再带 query；不带 sourceUrl、productUrl、expectedProductId、imageUrl —— 所以它不会被认成别的作业。以图搜要上传的那张图
 * 由插件凭这次作业的令牌向评审台取（POST /api/extension/capture-jobs/<id>/search-image），不经过任何别的地址。
 */
export function ozonImageMatchJobPayload(session) {
  const byImage = session.searchBy === "image";
  return {
    captureId: session.captureId,
    jobId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    mode: OZON_IMAGE_MATCH_MODE,
    searchBy: byImage ? "image" : "text",
    ...(byImage ? {} : { query: session.query }),
    searchUrl: session.searchUrl,
    maxResults: OZON_IMAGE_MATCH_MAX_RESULTS,
    requiredExtensionVersion: session.requiredExtensionVersion,
    attempt: session.attempt,
    token: session.token
  };
}

/** 页面拿到的回执：同一次作业，没有一次性令牌。 */
export function ozonImageMatchJobPublic(session) {
  return {
    jobId: session.captureId,
    candidateId: session.candidateId,
    requestRevision: session.requestRevision,
    dataRevision: session.dataRevision,
    mode: OZON_IMAGE_MATCH_MODE,
    searchBy: session.searchBy === "image" ? "image" : "text",
    query: session.query,
    status: session.jobStatus,
    attempt: session.attempt,
    requiredExtensionVersion: session.requiredExtensionVersion,
    createdAt: new Date(session.createdAt).toISOString(),
    claimedAt: session.claimedAt ? new Date(session.claimedAt).toISOString() : null,
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}
