/**
 * Seerfar 会员前台的一轮查询（方案 B，主人 2026-10-10 定）：主人点一次"收一轮"，系统存下这轮要查的条件和一次性
 * 只读许可，插件在主人自己已登录的 Chrome 里读「热销榜单选品」页的一页结果（最多 20 条），服务端用固定规则筛，
 * 排在前面的几个收成待核验候选，和手贴链接进来的候选同一个形状，之后去 1688 找货源、算利润都走同一套。
 *
 * 不调开放接口、不花积分、不保存 Cookie、令牌、密码这类登录凭据。查询的请求格式只留搜索条件（requestTemplate），
 * 给下一步"插件按计划自动查"用；这一轮不用它发任何请求。请求里的 Seerfar 账号 ID、手机号、邮箱按主人 2026-10-15
 * 的决定存进本机系统钥匙串（seerfar-account-identity.mjs），这里的轮次记录只留打码的样子。
 */
import { randomUUID } from 'node:crypto';
import { assertNoProductionSecrets } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { isSeerfarAccountIdentityStatus } from './seerfar-account-identity.mjs';
import { SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION, SEERFAR_WEB_DISCOVERY_PROVIDER, SEERFAR_WEB_PAGE_SIZE, SEERFAR_WEB_SEARCH_ENDPOINT,
  SEERFAR_WEB_SEARCH_PAGE, assertSeerfarWebDiscoveryRequest, buildSeerfarWebDiscoveryResult } from './seerfar-web-discovery-contract.mjs';
import { screenSeerfarProducts } from './seerfar-selection-screening.mjs';

export const SEERFAR_WEB_ROUND_SCHEMA = 'seerfar-web-round-v1';
export const SEERFAR_WEB_ROUND_MODE = 'seerfar_web_discovery';
export const SEERFAR_WEB_ROUND_COLLECTION = 'seerfarWebRounds';
export const SEERFAR_WEB_RESULT_COLLECTION = 'seerfarWebResults';
export const SEERFAR_WEB_EVIDENCE_SCHEMA = 'seerfar-web-candidate-evidence-v1';
/** The owner searches by hand in this first slice, so the extension waits longer than for a page it opens itself. */
export const SEERFAR_WEB_CAPTURE_WAIT_MS = 3 * 60 * 1000;

export const SEERFAR_WEB_FAILURE_LABELS = Object.freeze({
  site_login_required: 'Seerfar 没登录，插件停在了登录页',
  navigation_rejected: '打开的不是 Seerfar 热销榜单选品页',
  no_matching_search: '等了 3 分钟，没收到这几个类目的搜索结果',
  results_unverifiable: '收到了搜索结果，但格式和约定的不一样，没敢用',
  scope_mismatch: '搜回来的商品不在这轮要查的类目里',
  timeout: '插件超时了',
  extension_job_unclaimed: '插件没有领取这次作业',
  unknown_outcome: '插件领取以后没有回音，结果未知',
  capture_job_lost: '服务重启了，这一轮的作业丢了',
  system_error: '插件出错了'
});

export class SeerfarWebRoundError extends Error {
  constructor(code, detail = '') {
    super(`SEERFAR_WEB_ROUND_${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'SeerfarWebRoundError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new SeerfarWebRoundError(code, detail); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function seerfarWebRounds(document) {
  document.runtime ||= {};
  if (!Object.hasOwn(document.runtime, SEERFAR_WEB_ROUND_COLLECTION)) document.runtime[SEERFAR_WEB_ROUND_COLLECTION] = {};
  if (!isObject(document.runtime[SEERFAR_WEB_ROUND_COLLECTION])) fail('REPOSITORY_INVALID');
  return document.runtime[SEERFAR_WEB_ROUND_COLLECTION];
}
function seerfarWebResults(document) {
  document.runtime ||= {};
  if (!Object.hasOwn(document.runtime, SEERFAR_WEB_RESULT_COLLECTION)) document.runtime[SEERFAR_WEB_RESULT_COLLECTION] = {};
  if (!isObject(document.runtime[SEERFAR_WEB_RESULT_COLLECTION])) fail('REPOSITORY_INVALID');
  return document.runtime[SEERFAR_WEB_RESULT_COLLECTION];
}

/**
 * 同一家店、同一个查询、同一个业务日只跑一次：9 月 10 日同一天重复查宠物床、结果一模一样还扣了分，这条就是为它。
 * 失败的那一轮不算"跑过"，主人可以再点一次（新的一轮，新的许可）；正在跑的算。
 */
export function sameQueryRoundToday(document, { targetStore, queryId, businessDate }) {
  return Object.values(seerfarWebRounds(document)).find(round => round.targetStore === targetStore && round.query.queryId === queryId &&
    round.businessDate === businessDate && round.status !== 'failed') || null;
}

/** One round, one read permit: the site, the page, one result page of at most 20 rows, used once. */
export function createSeerfarWebRoundRecord({ targetStore, businessDate, query, plan, requestedBy, at, captureId }) {
  if (!['miska', 'dandanshu'].includes(targetStore) || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '') || !isObject(query) ||
      !isObject(plan) || typeof requestedBy !== 'string' || !requestedBy || !instant(at) || !/^SWR-[A-Za-z0-9-]{1,80}$/.test(captureId || '')) {
    fail('INPUT_INVALID');
  }
  const roundId = `seerfar-web-round:${randomUUID()}`;
  const request = assertSeerfarWebDiscoveryRequest({ requestId: roundId, provider: SEERFAR_WEB_DISCOVERY_PROVIDER,
    contractVersion: SEERFAR_WEB_DISCOVERY_CONTRACT_VERSION, platform: 'ozon', pageUrl: SEERFAR_WEB_SEARCH_PAGE,
    categoryPaths: [...query.categoryPaths], sellerType: query.sellerType, dateRange: query.dateRange, maxRecords: SEERFAR_WEB_PAGE_SIZE });
  const record = {
    schemaVersion: SEERFAR_WEB_ROUND_SCHEMA, roundId, captureId, targetStore, businessDate,
    query: structuredClone(query),
    plan: { profileVersion: plan.profileVersion, calendarVersion: plan.calendarVersion },
    request,
    readPermit: { kind: 'logged_in_read', site: 'www.seerfar.cn', page: SEERFAR_WEB_SEARCH_PAGE, endpoint: SEERFAR_WEB_SEARCH_ENDPOINT,
      action: 'read_one_search_result_page', maxPages: 1, maxRecords: SEERFAR_WEB_PAGE_SIZE, exclusions: ['写入', '付费', '开放接口', '保存登录凭据'],
      grantedBy: requestedBy, grantedAt: at, useCount: 0 },
    status: 'waiting_extension', createdAt: at, updatedAt: at, claimedAt: null, completedAt: null,
    failure: null, resultRef: null, resultCountLabel: null, screening: null, importedCandidateIds: [], requestTemplate: null, accountIdentity: null
  };
  assertSafeRuntimeRecord(record);
  return record;
}

export function claimSeerfarWebRound(record, at) {
  if (record?.status !== 'waiting_extension' || record.readPermit.useCount !== 0) fail('NOT_CLAIMABLE');
  return { ...structuredClone(record), status: 'capturing', claimedAt: at, updatedAt: at,
    readPermit: { ...record.readPermit, useCount: 1 } };
}

export function failSeerfarWebRound(record, code, at) {
  if (!['waiting_extension', 'capturing'].includes(record?.status)) return null;
  const known = Object.hasOwn(SEERFAR_WEB_FAILURE_LABELS, code) ? code : 'system_error';
  return { ...structuredClone(record), status: 'failed', updatedAt: at, completedAt: at,
    failure: { code: known, reason: SEERFAR_WEB_FAILURE_LABELS[known] } };
}

// 只留搜索条件：找什么（类目、卖家类型、时间、价格销量重量这类区间、配送、品牌、关键词）和怎么翻页、排序。名字像账号、
// 身份、网址或登录凭据的字段整个丢掉；取值像邮箱、手机号、网址、赋值、授权头、令牌的只留字段名，值记成 null。
// data、params、query 这类外壳本身不说明是什么条件：直接挂在外壳下的值，连同它底下数组里没有字段名的值，也记成 null
// （比如 params: ["sid-…"] 里短的会话号，没有字段名可查，取值规则也认不出来）。
// 插件 extension/1688-capture/seerfar-web-capture.js 里有一份规则相同的副本（测试逐条比对两边结果），回传前先删一遍；服务端是最后一道。
const TEMPLATE_DROP_KEY = new RegExp(['token|auth|sign|cookie|session|passw|secret|ticket|nonce|jwt|credential|bearer|captcha|header|device',
  '|fingerprint|expir|stamp|user|member|account|customer|login|phone|mobile|email|mail|openid|unionid|nickname|realname|contact|address',
  '|birth|gender|idcard|passport|identity|url|uri|href|link|redirect|callback|^(?:uid|ip|ts|t|sig|key)$',
  '|(?:uid|sig|apikey|accesskey|appkey|secretkey|privatekey|publickey|signkey)$'].join(''));
const TEMPLATE_WRAPPER_KEYS = new Set(['data', 'param', 'params', 'body', 'request', 'payload', 'query', 'search', 'criteria', 'where',
  'condition', 'conditions', 'filter', 'filters', 'options']);
const TEMPLATE_KEYS = new Set([...TEMPLATE_WRAPPER_KEYS, 'page', 'pagenum', 'pagenumber', 'pageno', 'pageindex', 'pagesize', 'size', 'limit',
  'offset', 'current', 'order', 'orders', 'orderby', 'orderfield', 'sort', 'sorts', 'sortby', 'sortfield', 'sortorder', 'sortkey', 'field',
  'direction', 'asc', 'desc', 'min', 'max', 'minimum', 'maximum', 'from', 'to', 'gt', 'gte', 'lt', 'lte', 'start', 'end', 'begin', 'platform',
  'site', 'market', 'country', 'currency', 'language', 'lang', 'q', 'kw', 'searchkey', 'searchword', 'searchtext']);
const TEMPLATE_KEY_PATTERNS = [/categor|^cat(?:id|ids)?$/, /(?:mode|type)s?$/, /^(?:date|time)|(?:date|time|day|period|month|week|year|range)s?$/,
  /price|sales|revenue|weight|volume|margin|rating|review|question|drr|conv|cancel|return|views?$|stock|rank|variant|gmv|profit|commission|dimension|length|width|height/,
  /fulfil|deliver|logistic|shipping|^fb[os]$|^rfbs$/, /brand|keyword|^(?:label|tag)s?$/, /^(?:is|has|only|filter|exclude|include)[a-z]/];
const templatePhoneLike = text => /^(?:\+?86[\s-]?)?1[3-9]\d{9}$/.test(text) || /^\+\d[\d\s()-]{6,}$/.test(text);

function templateValue(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !templatePhoneLike(String(value)) ? value : null;
  if (typeof value !== 'string' || value.length > 120 || /\p{Cc}/u.test(value)) return null;
  if (/:\/\/|[=@&?#\\]|^\s*(?:bearer|basic)\b/i.test(value) || /^eyJ[\w-]*\./.test(value) || templatePhoneLike(value) ||
      /^[A-Za-z0-9_+/-]{24,}={0,2}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) return null;
  return value;
}

// named: the nearest field name above this value names a search condition, not a wrapper; a list keeps its field's name.
function templateNode(value, depth, named) {
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => templateNode(item, depth + 1, named));
  if (value === null || typeof value !== 'object') return named ? templateValue(value) : null;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key)) continue;
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name || TEMPLATE_DROP_KEY.test(name) || !(TEMPLATE_KEYS.has(name) || TEMPLATE_KEY_PATTERNS.some(pattern => pattern.test(name)))) continue;
    out[key] = templateNode(item, depth + 1, !TEMPLATE_WRAPPER_KEYS.has(name));
  }
  return out;
}

/**
 * The search request the page itself sent, kept only as its search conditions so the next slice can build the same query
 * without the owner. Anything else is dropped, not masked; a request with no search condition left is null.
 */
export function sanitizeSeerfarRequestTemplate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const template = templateNode(value, 0, false);
  return Object.keys(template).length > 0 ? template : null;
}

/** The template a round keeps: sanitized, and never one the record's own secret check would refuse (a round must not stick). */
function roundRequestTemplate(value) {
  const template = sanitizeSeerfarRequestTemplate(value);
  try {
    return template === null ? null : assertNoProductionSecrets(template, 'requestTemplate');
  } catch {
    return null;
  }
}

/** The product shape a-discovery-estimate.mjs reads; the page's weight and size are the only package facts there are. */
export function seerfarWebEstimateProduct(product) {
  return { productId: product.productId, price: product.price, categoryPath: product.categoryPath,
    weightGrams: product.webMetrics.weightGrams, dimensionMm: product.webMetrics.dimensionMm };
}

/** Normalize the extension's raw capture against what this round declared; anything off-contract fails the round. */
export function normalizeSeerfarWebCapture(record, capture) {
  const evidenceRef = `seerfar-web:${record.roundId.slice('seerfar-web-round:'.length)}`;
  try {
    return buildSeerfarWebDiscoveryResult({ request: record.request, capture, evidenceRef });
  } catch (error) {
    return { error: error?.code === 'SCOPE_MISMATCH' ? 'scope_mismatch' : 'results_unverifiable', detail: String(error?.message || '').slice(0, 200) };
  }
}

/**
 * Apply one normalized page: screen it, create candidates for the kept rows, close the round. Runs inside the caller's
 * transaction so the duplicate check, the candidates and the round record land together or not at all.
 * createCandidate(product, rank) is the server's own factory (createInitialCandidate + evidence), injected here.
 */
export function completeSeerfarWebRound({ document, record, result, profile, knownProductIds, estimates, at, requestTemplate, accountIdentity = null,
  createCandidate }) {
  if (record?.status !== 'capturing') fail('NOT_CAPTURING');
  if (accountIdentity !== null && !isSeerfarAccountIdentityStatus(accountIdentity)) fail('ACCOUNT_IDENTITY_INVALID');
  const screening = screenSeerfarProducts({ products: result.products, query: record.query, profile, knownProductIds, estimates, businessTime: at });
  const byId = new Map(result.products.map(product => [product.productId, product]));
  const importedCandidateIds = screening.kept.map(entry => createCandidate(byId.get(entry.productId), entry));
  seerfarWebResults(document)[record.roundId] = structuredClone(result);
  const estimatesById = Object.fromEntries([...estimates.entries()].map(([id, estimate]) => [id, {
    status: estimate.status, missing: estimate.missing, maximumAllInPurchaseRmb: estimate.ceiling?.maximumAllInPurchaseRmb ?? null,
    freightRmb: estimate.freight?.chosen?.freightRmb ?? null, commissionRate: estimate.commission?.rate ?? null, rubPerCny: estimate.fx?.rubPerCny ?? null }]));
  const completed = { ...structuredClone(record), status: 'completed', updatedAt: at, completedAt: at, resultRef: result.evidenceRef,
    resultCountLabel: result.resultCountLabel, screening: { ...screening, estimates: estimatesById }, importedCandidateIds,
    requestTemplate: requestTemplate === undefined ? null : roundRequestTemplate(requestTemplate),
    accountIdentity: accountIdentity === null ? null : structuredClone(accountIdentity) };
  assertSafeRuntimeRecord(completed);
  seerfarWebRounds(document)[record.roundId] = completed;
  return completed;
}

/** What a Seerfar-picked candidate carries: where it came from, never a supply or profit decision. */
export function seerfarWebCandidateEvidence({ record, product, entry, candidateRevision }) {
  return { schemaVersion: SEERFAR_WEB_EVIDENCE_SCHEMA, provider: SEERFAR_WEB_DISCOVERY_PROVIDER, platform: 'ozon',
    roundId: record.roundId, route: record.query.route, routeReason: record.query.reason, queryId: record.query.queryId,
    profileVersion: record.plan.profileVersion, calendarVersion: record.plan.calendarVersion, sourceRevision: 0, resultRevision: candidateRevision,
    marketProductId: product.productId, providerRecordRef: product.providerRecordRef, categoryPath: structuredClone(product.categoryPath),
    observedMarketPrice: { value: product.price, currency: 'RUB' }, salesCount30d: product.salesCount, revenue30d: product.revenue,
    weightGrams: product.webMetrics.weightGrams, dimensionMm: product.webMetrics.dimensionMm, rank: entry.rank, roughPurchaseCeilingRmb: entry.ceilingRmb,
    newListing: entry.newListing, sellerIdentity: 'unknown', exactSkuMatch: 'unknown', businessEffect: 'discovery_evidence_only' };
}

/** The page's view of one round: no permit, no captureId token, nothing the browser should not hold. */
export function seerfarWebRoundPublic(record) {
  return { roundId: record.roundId, captureId: record.captureId, targetStore: record.targetStore, businessDate: record.businessDate,
    query: structuredClone(record.query), status: record.status, createdAt: record.createdAt, completedAt: record.completedAt,
    failure: record.failure, resultCountLabel: record.resultCountLabel,
    screening: record.screening ? { counts: record.screening.counts, kept: record.screening.kept, dropped: record.screening.dropped } : null,
    importedCandidateIds: [...record.importedCandidateIds], requestTemplateCaptured: record.requestTemplate !== null,
    accountIdentity: record.accountIdentity ? structuredClone(record.accountIdentity) : null };
}
