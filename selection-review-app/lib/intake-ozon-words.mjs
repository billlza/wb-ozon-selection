import { createHash } from "node:crypto";
import { normalizeOzonSearchQuery } from "./ozon-search-query.mjs";
import { normalizeServiceOrigin } from "./runtime-configuration.mjs";

/**
 * 录入流水线里「Ozon 以图搜不到时，俄文搜索词用 AI 翻」这一步（主人 2026-10-11 定，主人知道这是一次付费调用）。
 *
 * 以图搜没找到首图一致的那一件，把货源页上读到的中文标题交给正式 AI 网关（AGENTS.md §8.4），翻成在 Ozon 站内搜同款用的
 * 几个俄文词；词回来以后录入泵用它在 Ozon 词搜一次。模型只做翻译，不决定任何事：搜到的结果照样由服务端比首图、由主人
 * 逐条判断。每一件、每一轮以图搜只翻一次（attempt=1）：没翻成、超时、服务重启没等到结果都不重发、不换模型，这件照样往下
 * 粗算，主人可以在商品页上自己填词再搜。
 *
 * 发给网关的只有货源页上公开的商品标题；不带图片、链接、店铺或任何凭证。回执（网关作业号、模型、请求指纹、输入摘要、
 * 校验结果、真实用量、失败在哪一层）存在 candidate.intake.ozonWords。
 */
export const INTAKE_OZON_WORDS_SCHEMA = "intake-ozon-words-v1";
export const INTAKE_OZON_WORDS_TASK_TYPE = "russian_translation";
export const INTAKE_OZON_WORDS_MODEL = "gpt-5.6-terra";
export const INTAKE_OZON_WORDS_MAX_LENGTH = 60;
const TITLE_MAX_LENGTH = 300;
// 主人这条决定就是这一步的付费许可：只在录入流水线里、以图搜没找到首图一致时、每件每轮一次。
export const INTAKE_OZON_WORDS_AUTHORIZATION = Object.freeze({
  kind: "owner_standing_decision",
  decidedAt: "2026-10-11",
  scope: "录入流水线：Ozon 以图搜没找到首图一致的商品时，用 AI 把货源标题翻成俄文搜索词，每件每轮一次"
});

export class IntakeOzonWordsError extends Error {
  constructor(code, layer, message, { jobId = null, usage = null } = {}) {
    super(`INTAKE_OZON_WORDS_${code}: ${message}`);
    this.name = "IntakeOzonWordsError";
    this.code = code;
    this.layer = layer;
    this.detail = message;
    this.jobId = jobId;
    this.usage = usage;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const CJK = /[㐀-鿿豈-﫿]/u;
const CYRILLIC = /[Ѐ-ӿ]/u;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const fail = (code, layer, message, details) => { throw new IntakeOzonWordsError(code, layer, message, details); };

/** 网关的两条硬要求（见 c1-ozon-attribute-proposal.mjs）：根是对象，每层对象都写 additionalProperties:false。 */
const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: { query: { type: "string", minLength: 2, maxLength: INTAKE_OZON_WORDS_MAX_LENGTH } }
});

/** 要翻的那条标题：这一轮录入读到的货源页标题。读不到就没有可翻的，这一步不做。 */
export function intakeOzonWordsTitle(candidate) {
  const capture = candidate?.sourceCapture;
  if (!capture || capture.captureId !== candidate?.intake?.jobs?.sourceCaptureId) return null;
  const title = typeof capture.title === "string" ? capture.title.replace(/\s+/g, " ").trim() : "";
  return title && !CONTROL.test(title) ? title.slice(0, TITLE_MAX_LENGTH) : null;
}

export function buildIntakeOzonWordsRequest({ candidateId, dataRevision, title }) {
  if (!nonEmpty(candidateId) || !Number.isSafeInteger(dataRevision) || !nonEmpty(title)) {
    fail("INPUT_INVALID", "request", "要翻的标题、商品编号或修订号缺了");
  }
  const text = [
    "下面是中国电商平台（拼多多或 1688）上一件商品的公开标题。请把它改写成在俄罗斯电商 Ozon 站内搜索这件商品时用的俄文搜索词。",
    "规则：",
    "1. 2 到 6 个俄文词，写这件商品是什么：品类，再加最能认出它的一两个特征（材质、用途、给谁用、款式）。",
    "2. 不写品牌、店铺名、促销词、年份、数量、尺码、价格；不写标题里没有的东西，不猜。",
    "3. 只用俄文，不夹中文；不要标点堆砌。",
    `4. 总长不超过 ${INTAKE_OZON_WORDS_MAX_LENGTH} 个字符。`,
    `标题：${JSON.stringify(title)}`,
    "只输出一个 JSON 对象 {\"query\":\"...\"}，不要输出解释、注释、代码块标记或对象以外的任何文字。"
  ].join("\n");
  return {
    projectId: "three-store-selection",
    candidateId,
    dataRevision: String(dataRevision),
    businessPhase: "A",
    taskType: INTAKE_OZON_WORDS_TASK_TYPE,
    model: INTAKE_OZON_WORDS_MODEL,
    input: { text, images: [] },
    evidenceRefs: [{ id: `source-capture-title:${sha256(title).slice(0, 16)}`, kind: "source_capture_title",
      contentSha256: sha256(title), authorizedForAi: true }],
    outputSchema: structuredClone(OUTPUT_SCHEMA)
  };
}

/** 严格读回：只认 {query}，词要是 Ozon 搜索栏认的样子、只有俄文。原始输出不留。 */
export function parseIntakeOzonWords(output, jobId = null) {
  let parsed = output;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { fail("OUTPUT_INVALID", "validation", "模型输出不是 JSON", { jobId }); }
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.query !== "string") {
    fail("OUTPUT_INVALID", "validation", "模型输出不是只有 query 的对象", { jobId });
  }
  const query = normalizeOzonSearchQuery(parsed.query);
  if (!query || query.length > INTAKE_OZON_WORDS_MAX_LENGTH || !CYRILLIC.test(query) || CJK.test(query)) {
    fail("OUTPUT_INVALID", "validation", "模型给的不是能在 Ozon 搜的俄文词", { jobId });
  }
  return query;
}

/** 网关只报 token 数；没报就记 unknown，不当成 0。 */
function readUsage(usage) {
  if (!isObject(usage)) return "unknown";
  const pick = (...keys) => keys.map((key) => usage[key]).find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
  const inputTokens = pick("prompt_tokens", "inputTokens");
  const outputTokens = pick("completion_tokens", "outputTokens");
  const totalTokens = pick("total_tokens", "totalTokens") ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return inputTokens === null && outputTokens === null && totalTokens === null ? "unknown" : { inputTokens, outputTokens, totalTokens };
}

/** 发请求之前写进商品的那份：状态 requested。服务重启后看到它还是 requested，就是没等到结果，不重发。 */
export function requestedIntakeOzonWords({ imageCaptureId, title, request, requestedAt }) {
  return {
    schemaVersion: INTAKE_OZON_WORDS_SCHEMA,
    status: "requested",
    attempt: 1,
    imageCaptureId,
    taskType: request.taskType,
    model: request.model,
    requestFingerprint: sha256(request),
    input: { kind: "source_capture_title", titleSha256: sha256(title), title },
    outputSchemaSha256: sha256(request.outputSchema),
    authorization: { ...INTAKE_OZON_WORDS_AUTHORIZATION },
    requestedAt,
    gatewayJobId: null,
    query: null,
    validation: null,
    usage: "unknown",
    completedAt: null,
    failure: null
  };
}

export function completedIntakeOzonWords(record, { query, jobId, usage, completedAt }) {
  return { ...record, status: "completed", gatewayJobId: jobId, query, validation: "passed", usage: readUsage(usage), completedAt };
}

export function failedIntakeOzonWords(record, error, completedAt) {
  const known = error instanceof IntakeOzonWordsError;
  return {
    ...record,
    status: known && error.code === "TIMEOUT" ? "unknown_outcome" : "failed",
    gatewayJobId: known ? error.jobId : null,
    validation: known && error.layer === "validation" ? "failed" : null,
    usage: known ? readUsage(error.usage) : "unknown",
    completedAt,
    failure: { layer: known ? error.layer : "gateway", code: known ? error.code : "GATEWAY_FAILED",
      detail: String(known ? error.detail : error?.message || error).slice(0, 300) }
  };
}

/** 没发请求就做不了的（没读到标题、没配网关）：只记下为什么，没有网关作业、没有用量。 */
export function skippedIntakeOzonWords({ imageCaptureId, title, layer, code, detail, at }) {
  return {
    schemaVersion: INTAKE_OZON_WORDS_SCHEMA, status: "failed", attempt: 0, imageCaptureId,
    taskType: INTAKE_OZON_WORDS_TASK_TYPE, model: INTAKE_OZON_WORDS_MODEL, requestFingerprint: null,
    input: title ? { kind: "source_capture_title", titleSha256: sha256(title), title } : null, outputSchemaSha256: null,
    authorization: { ...INTAKE_OZON_WORDS_AUTHORIZATION }, requestedAt: null, gatewayJobId: null, query: null, validation: null,
    usage: "unknown", completedAt: at, failure: { layer, code, detail }
  };
}

/** 服务重启时还挂着 requested 的那一份：网关那边可能已经跑了，结果不知道，不重发。 */
export function interruptedIntakeOzonWords(record, completedAt) {
  return { ...record, status: "unknown_outcome", completedAt,
    failure: { layer: "service", code: "SERVICE_RESTARTED", detail: "服务在等 AI 网关回结果时重启了，没收到结果；没有重发" } };
}

export function createIntakeOzonWordsTranslator({
  gatewayUrl,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  timeoutMs = 60_000,
  gatewayDeploymentMode = "local_development",
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  statusIntervalMs = 500,
  maxStatusReads = 240
} = {}) {
  if (typeof fetchImpl !== "function" || typeof wait !== "function" || typeof now !== "function") {
    fail("INPUT_INVALID", "configuration", "翻译依赖配置无效");
  }
  let baseUrl;
  try { baseUrl = normalizeServiceOrigin(gatewayUrl, { deploymentMode: gatewayDeploymentMode, label: "aiGatewayUrl" }); }
  catch (error) { fail("INPUT_INVALID", "configuration", `AI 网关地址无效：${String(error?.message || error)}`); }
  const clockMs = () => {
    const at = now();
    const value = typeof at === "number" ? at : Date.parse(at);
    if (!Number.isFinite(value)) fail("INPUT_INVALID", "configuration", "服务时钟无效");
    return value;
  };
  async function gatewayJson(operation, jobId = null) {
    let response;
    try { response = await operation(); }
    catch (error) { fail("GATEWAY_FAILED", "gateway", `AI 网关请求失败：${String(error?.message || error)}`, { jobId }); }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const reason = isObject(body?.error) ? `${body.error.code}: ${body.error.message}` : "";
      fail("GATEWAY_FAILED", "gateway", `AI 网关返回 HTTP ${response.status}${reason ? ` —— ${String(reason).slice(0, 200)}` : ""}`, { jobId });
    }
    if (!isObject(body)) fail("GATEWAY_FAILED", "gateway", "AI 网关返回结构无效", { jobId });
    return body;
  }
  return Object.freeze({
    /** 一次请求、读到完成为止；超时、失败都不重发。 */
    async translate(request) {
      const deadline = clockMs() + timeoutMs;
      let job = await gatewayJson(() => fetchImpl(`${baseUrl}/v1/inference-jobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
      }));
      const jobId = job.jobId;
      if (!nonEmpty(jobId) || jobId.length > 200) fail("GATEWAY_FAILED", "gateway", "AI 网关没给作业编号");
      for (let read = 0; ["queued", "running"].includes(job.status); read += 1) {
        if (read >= maxStatusReads || clockMs() >= deadline) fail("TIMEOUT", "gateway", "等 AI 网关结果超时；没有重发", { jobId });
        await wait(statusIntervalMs);
        job = await gatewayJson(() => fetchImpl(`${baseUrl}/v1/inference-jobs/${encodeURIComponent(jobId)}`), jobId);
      }
      if (job.status !== "completed" || !isObject(job.receipt)) {
        fail("GATEWAY_FAILED", "provider", `翻译作业没完成（${String(job.status || "unknown").slice(0, 40)}）`, { jobId, usage: job.receipt?.usage });
      }
      if (job.model !== request.model || job.taskType !== request.taskType) {
        fail("GATEWAY_FAILED", "gateway", "网关回执和这次锁定的任务不一致", { jobId, usage: job.receipt.usage });
      }
      let query;
      try { query = parseIntakeOzonWords(job.receipt.output, jobId); }
      catch (error) { error.usage = job.receipt.usage; throw error; }
      const completedAt = typeof job.receipt.completedAt === "string" && Number.isFinite(Date.parse(job.receipt.completedAt))
        ? new Date(job.receipt.completedAt).toISOString() : new Date(clockMs()).toISOString();
      return { query, jobId, usage: job.receipt.usage ?? null, completedAt };
    }
  });
}
