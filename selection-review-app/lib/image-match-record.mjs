import { IMAGE_FINGERPRINT_VERSION, classifyImageSimilarity, imageFingerprintDistance, isImageFingerprint } from "./image-fingerprint.mjs";

/**
 * 「拿首图找同款」一次搜索记录的生命周期，1688 和 Ozon 共用这一份：排队、插件领取、交回结果、比对首图、主人逐条判断、
 * 失败如实停下、留最近几次的历史。不同的只有目标站点本身：结果用哪个编号认（1688 是 offerId，Ozon 是 productId）、
 * 停下时说哪句话、授权写什么、历史里留哪几项。这些由 createImageMatchRules 的参数给出，这里不碰网络、不碰业务状态。
 *
 * 软件只回答「首图看起来是不是同一张」；是不是同款，永远由主人逐条判断（AGENTS.md §4.3）。
 */
export const IMAGE_MATCH_JUDGEMENTS = Object.freeze(["exact", "near", "wrong"]);
export const IMAGE_MATCH_JUDGEMENT_LABELS = Object.freeze({ exact: "是同款", near: "近似款", wrong: "不是" });
const HISTORY_LIMIT = 5;
const IN_FLIGHT = Object.freeze(["waiting_extension", "searching"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
 * field：记录挂在商品上的哪个字段。idKey：结果用哪个编号认。codes：拒绝时抛出的代码。stopMessages：每种停下的原话，
 * 至少要有 system_error。reasons：不能开始时对主人说的话。authorization(source)：这次搜索授权写什么。
 * searchUrl(source)：这次打开的搜索地址。historyFields：历史里每条被判断过的结果留哪几项。
 */
export function createImageMatchRules({ field, idKey, schemaVersion, codes, stopMessages, reasons, authorization, searchUrl, historyFields }) {
  if (!Object.hasOwn(stopMessages, "system_error")) throw new TypeError("IMAGE_MATCH_RULES_STOP_MESSAGES_INCOMPLETE");

  function inFlight(record) {
    return isObject(record) && (IN_FLIGHT.includes(record.status) || ["queued", "claimed"].includes(record.jobStatus));
  }

  /** 这件商品此刻能不能再搜一次：淘汰了不行，上一次还没结束不行，上一次结果未知时要主人先说一声知道了。 */
  function startBlocker(candidate, { acknowledgeUnknownOutcome = false } = {}) {
    if (candidate?.workflowStatus === "eliminated") return { code: "candidate_eliminated", reason: reasons.eliminated };
    const record = candidate?.[field];
    if (inFlight(record)) return { code: codes.inFlight, reason: reasons.inFlight };
    if (record?.jobStatus === "unknown_outcome" && acknowledgeUnknownOutcome !== true) {
      return { code: codes.unknownOutcome, reason: reasons.unknownOutcome };
    }
    return null;
  }

  function stopMessage(code, detail = "") {
    const base = stopMessages[code] || stopMessages.system_error;
    return detail ? `${base}：${String(detail).slice(0, 300)}` : base;
  }

  function failureCode(value) {
    const code = String(value || "").trim();
    return Object.hasOwn(stopMessages, code) ? code : "system_error";
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
      results: (Array.isArray(record.results) ? record.results : []).filter(item => record.judgements?.[item[idKey]])
        .map(item => Object.fromEntries(historyFields.map(name => [name, item[name] ?? null])))
    };
  }

  /** 排队那一刻写进商品记录的样子；同时把上一份结果收进历史（最多留 5 份），主人的判断跟着它走。 */
  function queuedRecord(previous, { captureId, source, requiredExtensionVersion, authorizedBy, authorizedAt, candidateRevision, extra = {} }) {
    const history = [
      ...(isObject(previous) ? [summaryForHistory(previous)] : []),
      ...(Array.isArray(previous?.history) ? previous.history : [])
    ].slice(0, HISTORY_LIMIT);
    return {
      schemaVersion,
      captureId,
      jobId: captureId,
      status: "waiting_extension",
      jobStatus: "queued",
      attempt: 0,
      requiredExtensionVersion,
      source: { ...source },
      ...extra,
      searchUrl: searchUrl(source, extra),
      authorization: { ...authorization(source, extra), authorizedBy, authorizedAt, candidateRevision },
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

  /** 插件交回核验过的结果：先存下来，状态是「正在比对首图」；比对是之后单独一步。 */
  function resultsRecorded(record, evidence, timestamp) {
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

  function failed(record, code, { observedAt, timestamp, detail = "" }) {
    const settled = failureCode(code);
    return {
      ...record,
      status: "failed",
      jobStatus: settled === "unknown_outcome" ? "unknown_outcome" : "failed",
      observedAt: observedAt ?? timestamp,
      completedAt: timestamp,
      failureCode: settled,
      reason: stopMessage(settled, detail),
      businessStateEffect: "unchanged",
      retryAttempted: false,
      writeOccurred: false
    };
  }

  /**
   * 取指纹：来源首图一次，每条结果的主图各一次。取不到的那一条标「无法比对」，不猜、不跳过、不重试。
   * fingerprintOf 由调用方注入（服务端用 fetchImageFingerprint），这里不碰网络。
   */
  async function computeComparison(record, { fingerprintOf, comparedAt }) {
    if (typeof fingerprintOf !== "function") throw new TypeError("IMAGE_MATCH_COMPARE_DEPENDENCY_INVALID");
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
        return { [idKey]: item[idKey], fingerprint: read.fingerprint, distance: null, similarity: "unknown",
          compareError: source.fingerprint ? read.error : "source_image_unreadable" };
      }
      const distance = imageFingerprintDistance(source.fingerprint, read.fingerprint);
      return { [idKey]: item[idKey], fingerprint: read.fingerprint, distance, similarity: classifyImageSimilarity(distance), compareError: null };
    });
    return { captureId: record.captureId, version: IMAGE_FINGERPRINT_VERSION, comparedAt, sourceFingerprint: source.fingerprint,
      sourceError: source.error, results };
  }

  /** 主人要求再比一次（例如上次有几张图没取到）：结果和主人的判断都不动，只把状态退回「正在比对首图」。 */
  function comparisonRequested(record) {
    if (!isObject(record) || !["comparing", "compared"].includes(record.status)) throw new Error(codes.notComparable);
    return { ...record, status: "comparing" };
  }

  /** 把比对结果落到同一份记录上。记录换了（又搜了一次）或者不在比对中，就什么也不做。 */
  function comparisonApplied(record, comparison) {
    if (!isObject(record) || record.status !== "comparing" || record.captureId !== comparison?.captureId) return null;
    const byId = new Map(comparison.results.map(row => [row[idKey], row]));
    if (byId.size !== record.results.length || record.results.some(item => !byId.has(item[idKey]))) return null;
    return {
      ...record,
      status: "compared",
      comparison: { version: comparison.version, comparedAt: comparison.comparedAt,
        sourceFingerprint: comparison.sourceFingerprint, sourceError: comparison.sourceError },
      results: record.results.map(item => {
        const row = byId.get(item[idKey]);
        return { ...item, fingerprint: row.fingerprint, distance: row.distance, similarity: row.similarity, compareError: row.compareError };
      })
    };
  }

  /** 主人对其中一条的判断。只认这次结果里真有的那一条；clear 撤回判断。 */
  function judged(record, { itemId, judgement, judgedAt, judgedBy }) {
    if (!isObject(record) || !["comparing", "compared"].includes(record.status)) throw new Error(codes.notJudgeable);
    if (!record.results.some(item => item[idKey] === itemId)) throw new Error(codes.itemUnknown);
    const judgements = { ...(isObject(record.judgements) ? record.judgements : {}) };
    if (judgement === "clear") delete judgements[itemId];
    else if (IMAGE_MATCH_JUDGEMENTS.includes(judgement)) judgements[itemId] = { judgement, judgedAt, judgedBy };
    else throw new Error(codes.judgementInvalid);
    return { ...record, judgements };
  }

  return Object.freeze({ field, idKey, inFlight, startBlocker, stopMessage, failureCode, queuedRecord, resultsRecorded, failed,
    computeComparison, comparisonRequested, comparisonApplied, judged });
}
