import { normalizeServiceOrigin } from './runtime-configuration.mjs';

export const DISCOVERY_TITLE_TRANSLATION_TASK_TYPE = 'discovery_title_translation';
export const DISCOVERY_TITLE_TRANSLATION_MODEL = 'gpt-5.6-terra';
export const DISCOVERY_TITLE_TRANSLATION_MAX_TITLES = 20;
export const DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH = 120;

/** Display-only translation failures carry one closed code so the owner-facing route never guesses a cause. */
export class DiscoveryTitleTranslationError extends Error {
  constructor(code, message, details = {}) {
    super(`DISCOVERY_TITLE_TRANSLATION_${code}: ${message}`);
    this.name = 'DiscoveryTitleTranslationError';
    this.code = code;
    this.jobId = details.jobId ?? null;
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code, message, details) => { throw new DiscoveryTitleTranslationError(code, message, details); };

const OUTPUT_SCHEMA = Object.freeze({
  type: 'array',
  minItems: 1,
  maxItems: DISCOVERY_TITLE_TRANSLATION_MAX_TITLES,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['productId', 'titleZh'],
    properties: {
      productId: { type: 'string', minLength: 1, maxLength: 64 },
      titleZh: { type: 'string', minLength: 1, maxLength: DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH }
    }
  }
});

function assertItems(items, maxTitlesPerCall) {
  if (!Array.isArray(items) || items.length === 0 || items.length > maxTitlesPerCall) {
    fail('INPUT_INVALID', '待翻译标题为空或超出单次上限');
  }
  const seen = new Set();
  return items.map(item => {
    if (!closed(item, ['productId', 'title'])) fail('INPUT_INVALID', '待翻译条目只能包含商品编号与原标题');
    const { productId, title } = item;
    if (typeof productId !== 'string' || !/^[A-Za-z0-9_:.-]{1,64}$/u.test(productId) || seen.has(productId)) {
      fail('INPUT_INVALID', '商品编号无效或重复');
    }
    seen.add(productId);
    if (typeof title !== 'string' || title.trim() === '' || title.length > 500 || CONTROL_CHARACTERS.test(title)) {
      fail('INPUT_INVALID', '原标题为空、过长或含控制字符');
    }
    return { productId, title: title.trim() };
  });
}

/** The prompt carries only public marketplace titles; it asks for facts kept and nothing added. */
export function buildDiscoveryTitleTranslationRequest(items) {
  const text = [
    '把下列公开商品标题翻译成简洁的中文电商标题。只做翻译整理，不得创造商品事实，也不得替主人作商业决定。',
    '规则：每条不超过40个汉字；保留尺寸、数量、单位、规格、型号等事实；不添加促销词、评价、推测或任何原文没有的信息；无法确定的信息一律省略。',
    `只输出一个严格的JSON数组，顺序与输入完全一致，共 ${items.length} 项，每项只有 productId 和 titleZh 两个键；titleZh 不得为空且不超过 ${DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH} 个字符。`,
    '不要输出解释、注释、代码块标记或数组以外的任何文字。',
    JSON.stringify(items.map(item => ({ productId: item.productId, title: item.title })))
  ].join('\n');
  return {
    projectId: 'three-store-selection',
    businessPhase: 'A',
    taskType: DISCOVERY_TITLE_TRANSLATION_TASK_TYPE,
    model: DISCOVERY_TITLE_TRANSLATION_MODEL,
    input: { text, images: [] },
    outputSchema: structuredClone(OUTPUT_SCHEMA)
  };
}

/** Strict parse: JSON only, closed keys, one non-empty translation per requested id. Raw model text is never kept. */
function parseTranslations(output, items, jobId) {
  let parsed = output;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); }
    catch { fail('OUTPUT_INVALID', '模型输出不是严格JSON', { jobId }); }
  }
  if (!Array.isArray(parsed) || parsed.length !== items.length) fail('OUTPUT_INVALID', '模型输出不是与请求等长的JSON数组', { jobId });
  const requested = new Set(items.map(item => item.productId));
  const byId = new Map();
  for (const entry of parsed) {
    if (!closed(entry, ['productId', 'titleZh'])) fail('OUTPUT_INVALID', '模型输出条目键不符合约定', { jobId });
    const { productId, titleZh } = entry;
    if (typeof productId !== 'string' || !requested.has(productId) || byId.has(productId)) {
      fail('OUTPUT_INVALID', '模型输出缺少或重复了请求中的商品编号', { jobId });
    }
    if (typeof titleZh !== 'string') fail('OUTPUT_INVALID', '模型输出的中文标题不是文本', { jobId });
    const value = titleZh.trim();
    if (value === '' || value.length > DISCOVERY_TITLE_TRANSLATION_MAX_LENGTH || CONTROL_CHARACTERS.test(value)) {
      fail('OUTPUT_INVALID', '模型输出的中文标题为空、过长或含控制字符', { jobId });
    }
    byId.set(productId, value);
  }
  if (byId.size !== items.length) fail('OUTPUT_INVALID', '模型输出未覆盖全部请求商品', { jobId });
  return items.map(item => ({ productId: item.productId, titleZh: byId.get(item.productId) }));
}

/** The gateway reports token counts only; no monetary charge is claimed here. */
function readUsage(usage, jobId) {
  if (usage === undefined || usage === null) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const allowed = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'inputTokens', 'outputTokens', 'totalTokens'];
  if (!isObject(usage) || Object.entries(usage).some(([key, value]) =>
    !allowed.includes(key) || !Number.isSafeInteger(value) || value < 0)) {
    fail('GATEWAY_FAILED', '网关耗用记录格式无效', { jobId });
  }
  const inputTokens = usage.prompt_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens };
}

/**
 * Display-only Chinese titles for discovered products. One inference job per call carries every title;
 * the caller decides what to cache. Nothing here overwrites an observed marketplace field.
 */
export function createDiscoveryTitleTranslator({
  gatewayUrl,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  maxTitlesPerCall = DISCOVERY_TITLE_TRANSLATION_MAX_TITLES,
  timeoutMs = 60_000,
  gatewayDeploymentMode = 'local_development',
  wait = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }),
  statusIntervalMs = 500,
  maxStatusReads = 240
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof wait !== 'function' ||
      !Number.isSafeInteger(maxTitlesPerCall) || maxTitlesPerCall < 1 || maxTitlesPerCall > DISCOVERY_TITLE_TRANSLATION_MAX_TITLES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(statusIntervalMs) || statusIntervalMs < 0 ||
      !Number.isSafeInteger(maxStatusReads) || maxStatusReads < 1) {
    fail('INPUT_INVALID', '翻译服务依赖配置无效');
  }
  let baseUrl;
  try { baseUrl = normalizeServiceOrigin(gatewayUrl, { deploymentMode: gatewayDeploymentMode, label: 'aiGatewayUrl' }); }
  catch (error) { fail('INPUT_INVALID', `AI网关地址无效：${String(error?.message || error)}`); }

  const clockMs = () => {
    const at = now();
    const value = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(value)) fail('INPUT_INVALID', '服务时钟无效');
    return value;
  };
  async function gatewayJson(response, jobId = null) {
    let body = {};
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) fail('GATEWAY_FAILED', `AI网关返回 HTTP ${response.status}`, { jobId });
    if (!isObject(body)) fail('GATEWAY_FAILED', 'AI网关返回结构无效', { jobId });
    return body;
  }
  async function call(operation, jobId = null) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof DiscoveryTitleTranslationError) throw error;
      throw new DiscoveryTitleTranslationError('GATEWAY_FAILED', `AI网关请求失败：${String(error?.message || error)}`, { jobId });
    }
  }

  return Object.freeze({
    maxTitlesPerCall,
    async translateTitles({ items } = {}) {
      const normalized = assertItems(items, maxTitlesPerCall);
      const request = buildDiscoveryTitleTranslationRequest(normalized);
      const deadline = clockMs() + timeoutMs;
      let job = await call(async () => gatewayJson(await fetchImpl(`${baseUrl}/v1/inference-jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request)
      })));
      const jobId = job.jobId;
      if (typeof jobId !== 'string' || jobId.trim() === '' || jobId.length > 200) fail('GATEWAY_FAILED', 'AI网关未返回任务编号');
      for (let read = 0; ['queued', 'running'].includes(job.status); read += 1) {
        if (read >= maxStatusReads || clockMs() >= deadline) fail('TIMEOUT', '翻译任务读取超时；未重发请求', { jobId });
        await wait(statusIntervalMs);
        if (clockMs() >= deadline) fail('TIMEOUT', '翻译任务读取超时；未重发请求', { jobId });
        job = await call(async () => gatewayJson(await fetchImpl(`${baseUrl}/v1/inference-jobs/${encodeURIComponent(jobId)}`), jobId), jobId);
      }
      if (job.status !== 'completed' || !isObject(job.receipt)) fail('GATEWAY_FAILED', '翻译任务未完成并已停止', { jobId });
      if (job.model !== DISCOVERY_TITLE_TRANSLATION_MODEL || job.taskType !== DISCOVERY_TITLE_TRANSLATION_TASK_TYPE) {
        fail('GATEWAY_FAILED', '网关回执与已锁定的翻译任务不一致', { jobId });
      }
      const translations = parseTranslations(job.receipt.output, normalized, jobId);
      const usage = readUsage(job.receipt.usage, jobId);
      const completedAt = typeof job.receipt.completedAt === 'string' && Number.isFinite(Date.parse(job.receipt.completedAt))
        ? new Date(job.receipt.completedAt).toISOString()
        : new Date(clockMs()).toISOString();
      return { translations, usage, model: DISCOVERY_TITLE_TRANSLATION_MODEL, jobId, completedAt };
    }
  });
}
