/**
 * 本店近 8 周按 SKU 的销量、曝光和加购：Ozon Seller API 只读接口，给"本店爆款找相似"挑种子用。
 *
 * 只发三个只读请求：两个窗口各一次 /v1/analytics/data，再一次 /v3/product/info/list 补货号、标价和有没有库存。
 * 凭据走账户读取已经声明的同一组绑定（targetStore → credentialAlias → 本机钥匙串），只在发请求的那一刻读出来，
 * 不落盘、不进日志、不进返回值。任何一步失败都按失败层分类后停下，不重试、不换接口（AGENTS.md §8.3）。
 */
import { readOzonDEKeychainSecret } from './ozon-de-http-transport.mjs';
import { assertOzonAccountDiscoveryBindings, normalizeOzonDECredentialBindings } from './ozon-de-http-configuration.mjs';
import { STORE_SALES_SNAPSHOT_SCHEMA, assertStoreSalesRow } from './store-sales-seeds.mjs';

const ORIGIN = 'https://api-seller.ozon.ru';
const ANALYTICS = '/v1/analytics/data';
const PRODUCT_INFO = '/v3/product/info/list';
const METRICS = Object.freeze(['ordered_units', 'revenue', 'hits_view', 'hits_tocart']);
const ROW_LIMIT = 1000;

export const STORE_SALES_FAILURES = Object.freeze({
  not_configured: '这台电脑没有配这家店的只读 Seller API',
  credential_unavailable: '钥匙串里读不到这家店的 API Key',
  permission_required: 'Ozon 拒绝了这个 API Key（没有权限或已失效）',
  rate_limited: 'Ozon 说请求太频繁，这次先停下',
  platform_error: 'Ozon 接口出错',
  connection_failed: '连不上 Ozon 接口',
  timeout: 'Ozon 接口超时',
  response_invalid: 'Ozon 返回的数据和预期不一样',
  too_many_skus: '这家店一个窗口的 SKU 超过 1000 个，一次读不完'
});

export class OzonStoreSalesReadError extends Error {
  constructor(code, { requestsSent = 0, httpStatus = null } = {}) {
    super(`OZON_STORE_SALES_${code}`);
    this.name = 'OzonStoreSalesReadError';
    this.code = code;
    this.requestsSent = requestsSent;
    this.httpStatus = httpStatus;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Which store this machine can read, without touching a credential. */
export function storeSalesRoutes({ discoveryBindings = [], credentialBindings = [], productionBindings = [] } = {}) {
  assertOzonAccountDiscoveryBindings(discoveryBindings);
  const credentials = normalizeOzonDECredentialBindings(credentialBindings, productionBindings, discoveryBindings);
  const routes = {};
  for (const binding of discoveryBindings) {
    const credential = credentials.find(value => value.credentialAlias === binding.credentialAlias);
    if (credential) routes[binding.targetStore] = { credentialAlias: binding.credentialAlias, bindingId: binding.bindingId, credential };
  }
  return routes;
}

function analyticsRows(body) {
  const data = body?.result?.data;
  if (!Array.isArray(data)) throw new OzonStoreSalesReadError('response_invalid');
  if (data.length >= ROW_LIMIT) throw new OzonStoreSalesReadError('too_many_skus');
  const rows = new Map();
  for (const entry of data) {
    const dimension = entry?.dimensions?.[0];
    const metrics = entry?.metrics;
    if (!isObject(dimension) || typeof dimension.id !== 'string' || !/^[1-9]\d{0,17}$/.test(dimension.id) || !Array.isArray(metrics) ||
        metrics.length !== METRICS.length || !metrics.every(nonNegative) || rows.has(dimension.id)) throw new OzonStoreSalesReadError('response_invalid');
    const [units, revenue, views, toCart] = metrics;
    if (![units, views, toCart].every(Number.isSafeInteger)) throw new OzonStoreSalesReadError('response_invalid');
    rows.set(dimension.id, { title: typeof dimension.name === 'string' ? dimension.name.slice(0, 2000) : '',
      totals: { units, revenueRmb: Math.round(revenue * 100) / 100, views, toCart } });
  }
  return rows;
}

function productFacts(body) {
  if (!Array.isArray(body?.items)) throw new OzonStoreSalesReadError('response_invalid');
  const facts = new Map();
  for (const item of body.items) {
    if (!isObject(item)) throw new OzonStoreSalesReadError('response_invalid');
    const skus = new Set([item.sku, ...(Array.isArray(item.sources) ? item.sources.map(source => source?.sku) : [])]
      .filter(value => value !== undefined && value !== null).map(String));
    const price = Number(item.price);
    const fact = { offerId: typeof item.offer_id === 'string' ? item.offer_id.slice(0, 200) : null,
      listedPriceRmb: item.currency_code === 'CNY' && Number.isFinite(price) && price > 0 ? price : null,
      hasStock: typeof item.stocks?.has_stock === 'boolean' ? item.stocks.has_stock : null,
      name: typeof item.name === 'string' ? item.name.slice(0, 2000) : '' };
    for (const sku of skus) facts.set(sku, fact);
  }
  return facts;
}

/**
 * fetchImpl and readSecret are injected so tests never reach the network or the keychain. Each read is one bounded
 * sequence of three requests; `requestGapMs` spaces the two analytics calls because Ozon limits that method per minute.
 */
export function createOzonStoreSalesReader({ routes, runtimeMode = 'local_development', fetchImpl = globalThis.fetch, readSecret = readOzonDEKeychainSecret,
  timeoutMs = 20_000, maxResponseBytes = 4 * 1024 * 1024, requestGapMs = 65_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!isObject(routes) || typeof fetchImpl !== 'function' || typeof readSecret !== 'function' || typeof sleep !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(requestGapMs) || requestGapMs < 0) {
    throw new TypeError('OZON_STORE_SALES_READER_CONFIGURATION_INVALID');
  }

  async function post(credential, endpoint, body, state) {
    let key;
    try { key = String(await readSecret(credential, { runtimeMode })).trim(); }
    catch { throw new OzonStoreSalesReadError('credential_unavailable', state); }
    if (!key) throw new OzonStoreSalesReadError('credential_unavailable', state);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      state.requestsSent += 1;
      response = await fetchImpl(`${ORIGIN}${endpoint}`, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Client-Id': credential.clientId, 'Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body) });
    } catch {
      clearTimeout(timer);
      throw new OzonStoreSalesReadError(controller.signal.aborted ? 'timeout' : 'connection_failed', state);
    }
    try {
      const status = response?.status;
      const facts = { ...state, httpStatus: Number.isInteger(status) ? status : null };
      if (status === 401 || status === 403) throw new OzonStoreSalesReadError('permission_required', facts);
      if (status === 429) throw new OzonStoreSalesReadError('rate_limited', facts);
      if (!Number.isInteger(status) || status < 200 || status >= 300) throw new OzonStoreSalesReadError('platform_error', facts);
      let text;
      try { text = await response.text(); }
      catch { throw new OzonStoreSalesReadError(controller.signal.aborted ? 'timeout' : 'connection_failed', facts); }
      if (typeof text !== 'string' || Buffer.byteLength(text) > maxResponseBytes) throw new OzonStoreSalesReadError('response_invalid', facts);
      try { return JSON.parse(text); }
      catch { throw new OzonStoreSalesReadError('response_invalid', facts); }
    } finally {
      clearTimeout(timer);
    }
  }

  const analyticsBody = window => ({ date_from: window.from, date_to: window.to, metrics: [...METRICS], dimension: ['sku'], filters: [],
    sort: [{ key: 'ordered_units', order: 'DESC' }], limit: ROW_LIMIT, offset: 0 });

  /** Returns the normalized snapshot body; the caller persists it. Throws OzonStoreSalesReadError with what was sent. */
  async function read({ targetStore, windows, readAt }) {
    const route = routes[targetStore];
    if (!route) throw new OzonStoreSalesReadError('not_configured');
    const state = { requestsSent: 0, httpStatus: null };
    // A response that does not parse still counts the request that fetched it.
    const parsed = (normalize, body) => {
      try { return normalize(body); }
      catch (error) { throw error instanceof OzonStoreSalesReadError ? new OzonStoreSalesReadError(error.code, { ...state, httpStatus: 200 }) : error; }
    };
    const recent = parsed(analyticsRows, await post(route.credential, ANALYTICS, analyticsBody(windows.recent), state));
    await sleep(requestGapMs);
    const prior = parsed(analyticsRows, await post(route.credential, ANALYTICS, analyticsBody(windows.prior), state));
    const skus = [...new Set([...recent.keys(), ...prior.keys()])];
    const facts = skus.length ? parsed(productFacts, await post(route.credential, PRODUCT_INFO, { sku: skus.map(Number) }, state)) : new Map();
    const empty = { units: 0, revenueRmb: 0, views: 0, toCart: 0 };
    const rows = skus.map(sku => {
      const fact = facts.get(sku) || { offerId: null, listedPriceRmb: null, hasStock: null, name: '' };
      return assertStoreSalesRow({ sku, title: recent.get(sku)?.title || prior.get(sku)?.title || fact.name || `SKU ${sku}`,
        recent: recent.get(sku)?.totals || { ...empty }, prior: prior.get(sku)?.totals || { ...empty },
        offerId: fact.offerId, listedPriceRmb: fact.listedPriceRmb, hasStock: fact.hasStock });
    });
    return { schemaVersion: STORE_SALES_SNAPSHOT_SCHEMA, targetStore, readAt, windows, source: { platform: 'ozon', api: 'seller_api',
      endpoints: [ANALYTICS, PRODUCT_INFO], bindingId: route.bindingId, write: false }, requestsSent: state.requestsSent, rows };
  }

  return Object.freeze({ read, stores: () => Object.keys(routes) });
}
