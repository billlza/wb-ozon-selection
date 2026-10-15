/**
 * Seerfar 会员前台「热销榜单选品」一页结果（方案 B 第一段，主人 2026-10-10 定）。
 *
 * 只做一件事：在主人自己已登录的 Chrome 里打开热销榜单选品页，等主人按工作台建议的类目搜一次，收下页面自己收到的
 * 那一页搜索结果（最多 20 条），回传给本机工作台。插件不替主人点搜索、不翻页、不发自己的请求、不读 Cookie 或
 * 登录凭据。页面请求里只把搜索条件带回去，给下一步"按计划自动查"用；请求里的 Seerfar 账号 ID、手机号、邮箱单独
 * 带回（主人 2026-10-15 定要存，工作台存进本机系统钥匙串）；令牌、签名这类登录凭据一律不带。
 *
 * 收结果靠在页面主世界里包一层 fetch / XMLHttpRequest：只记下发往搜索接口的那几次响应。下面两个 *InPage 函数
 * 由 chrome.scripting 注入页面执行，必须自给自足，不能引用本文件里的任何变量。
 */
export const SEERFAR_WEB_REQUEST_TYPE = "SELECTION_REVIEW_SEERFAR_WEB_REQUEST";
export const SEERFAR_WEB_MODE = "seerfar_web_discovery";
export const SEERFAR_WEB_SEARCH_PAGE = "https://www.seerfar.cn/admin/product-search";
export const SEERFAR_WEB_SEARCH_ENDPOINT = "https://www.seerfar.cn/product-report/product/search";
export const SEERFAR_WEB_MAX_WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 2000;

const failure = (code) => Object.assign(new Error(code), { code });

export function isSeerfarWebJob(payload) {
  return payload?.mode === SEERFAR_WEB_MODE;
}

const categoryPath = (value) => typeof value === "string" && value.length > 0 && value.length <= 500 && value.trim() === value &&
  value.split(" > ").every((segment) => segment.trim().length > 0);

/** The job the service hands over after a claim; anything else is refused before a tab is opened. */
export function validateSeerfarWebRequest({ payload, manifestVersion = "" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, code: "request_payload_missing" };
  if (payload.mode !== SEERFAR_WEB_MODE || payload.sourceUrl !== undefined || payload.productUrl !== undefined || payload.imageUrl !== undefined) {
    return { ok: false, code: "capture_mode_invalid" };
  }
  if (typeof payload.captureId !== "string" || !/^SWR-[A-Za-z0-9-]{1,80}$/.test(payload.captureId) ||
      typeof payload.roundId !== "string" || !/^seerfar-web-round:[0-9a-f-]{36}$/.test(payload.roundId) ||
      typeof payload.token !== "string" || payload.token.length === 0 || payload.token.length > 512) return { ok: false, code: "request_payload_missing" };
  if (payload.attempt !== 1) return { ok: false, code: "attempt_invalid" };
  if (payload.requiredExtensionVersion !== manifestVersion || !manifestVersion) return { ok: false, code: "extension_version_mismatch" };
  if (payload.pageUrl !== SEERFAR_WEB_SEARCH_PAGE || payload.endpoint !== SEERFAR_WEB_SEARCH_ENDPOINT) return { ok: false, code: "source_url_invalid" };
  if (!Array.isArray(payload.categoryPaths) || payload.categoryPaths.length === 0 || payload.categoryPaths.length > 20 ||
      !payload.categoryPaths.every(categoryPath) || new Set(payload.categoryPaths).size !== payload.categoryPaths.length ||
      !["cross_border", "local", "all"].includes(payload.sellerType) || payload.maxRecords !== 20 ||
      !Number.isSafeInteger(payload.waitMs) || payload.waitMs < 1000 || payload.waitMs > SEERFAR_WEB_MAX_WAIT_MS) {
    return { ok: false, code: "request_payload_missing" };
  }
  return { ok: true };
}

/*
 * 回传前先过一遍页面的请求体（审查清单 P1-22）。下面两组函数和服务端 lib/seerfar-web-round.mjs 的
 * sanitizeSeerfarRequestTemplate、lib/seerfar-account-identity.mjs 的 pickSeerfarAccountIdentity 规则相同
 * （测试逐条比对两边结果）；服务端收到后还会再过一遍。
 */
const TEMPLATE_DROP_KEY = new RegExp(["token|auth|sign|cookie|session|passw|secret|ticket|nonce|jwt|credential|bearer|captcha|header|device",
  "|fingerprint|expir|stamp|user|member|account|customer|login|phone|mobile|email|mail|openid|unionid|nickname|realname|contact|address",
  "|birth|gender|idcard|passport|identity|url|uri|href|link|redirect|callback|^(?:uid|ip|ts|t|sig|key)$",
  "|(?:uid|sig|apikey|accesskey|appkey|secretkey|privatekey|publickey|signkey)$"].join(""));
const TEMPLATE_KEYS = new Set(["data", "param", "params", "body", "request", "payload", "query", "search", "criteria", "where", "condition",
  "conditions", "filter", "filters", "options", "page", "pagenum", "pagenumber", "pageno", "pageindex", "pagesize", "size", "limit", "offset",
  "current", "order", "orders", "orderby", "orderfield", "sort", "sorts", "sortby", "sortfield", "sortorder", "sortkey", "field", "direction",
  "asc", "desc", "min", "max", "minimum", "maximum", "from", "to", "gt", "gte", "lt", "lte", "start", "end", "begin", "platform", "site",
  "market", "country", "currency", "language", "lang", "q", "kw", "searchkey", "searchword", "searchtext"]);
const TEMPLATE_KEY_PATTERNS = [/categor|^cat(?:id|ids)?$/, /(?:mode|type)s?$/, /^(?:date|time)|(?:date|time|day|period|month|week|year|range)s?$/,
  /price|sales|revenue|weight|volume|margin|rating|review|question|drr|conv|cancel|return|views?$|stock|rank|variant|gmv|profit|commission|dimension|length|width|height/,
  /fulfil|deliver|logistic|shipping|^fb[os]$|^rfbs$/, /brand|keyword|^(?:label|tag)s?$/, /^(?:is|has|only|filter|exclude|include)[a-z]/];
const templatePhoneLike = (text) => /^(?:\+?86[\s-]?)?1[3-9]\d{9}$/.test(text) || /^\+\d[\d\s()-]{6,}$/.test(text);

function templateValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && !templatePhoneLike(String(value)) ? value : null;
  if (typeof value !== "string" || value.length > 120 || /\p{Cc}/u.test(value)) return null;
  if (/:\/\/|[=@&?#\\]|^\s*(?:bearer|basic)\b/i.test(value) || /^eyJ[\w-]*\./.test(value) || templatePhoneLike(value) ||
      /^[A-Za-z0-9_+/-]{24,}={0,2}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) return null;
  return value;
}

function templateNode(value, depth) {
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => templateNode(item, depth + 1));
  if (value === null || typeof value !== "object") return templateValue(value);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key)) continue;
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!name || TEMPLATE_DROP_KEY.test(name) || !(TEMPLATE_KEYS.has(name) || TEMPLATE_KEY_PATTERNS.some((pattern) => pattern.test(name)))) continue;
    out[key] = templateNode(item, depth + 1);
  }
  return out;
}

/** The page's search request cut down to its search conditions; null when none is left. */
export function sanitizeSeerfarRequestTemplate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const template = templateNode(value, 0);
  return Object.keys(template).length > 0 ? template : null;
}

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
const CREDENTIAL_KEY = /token|auth|sign|cookie|session|passw|secret|ticket|nonce|jwt|credential|bearer|captcha|header/;
const ACCOUNT_KEYS = Object.freeze(["accountid", "memberid", "userid", "customerid", "uid", "loginid", "loginname", "username", "accountname",
  "account", "member", "user"]);
const isPhoneKey = (key) => /phone|mobile/.test(key) || key === "tel" || key === "telephone";
const isEmailKey = (key) => key.includes("email") || key === "mail" || key === "mailaddress";

function accountValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^[\p{L}\p{N}_.@+-]{1,64}$/u.test(text) && !/^eyJ[\w-]*\./.test(text) ? text : null;
}
function phoneValue(value) {
  const text = Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\+?[\d\s()*-]{6,24}$/.test(text)) return null;
  const digits = text.replace(/\D/g, "").length;
  return digits >= 6 && digits <= 15 ? `${text.startsWith("+") ? "+" : ""}${text.replace(/[^\d*]/g, "")}` : null;
}
function emailValue(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text.length <= 128 && /^[^\s@"'<>()[\]\\,;:]{1,64}@[\p{L}\p{N}.-]{1,100}\.\p{L}{2,24}$/u.test(text) ? text : null;
}

/** The Seerfar account ID, phone and email the page's request carries; anything under a credential-like key is not read. */
export function pickSeerfarAccountIdentity(value) {
  const found = { accountId: null, phone: null, email: null };
  let accountRank = ACCOUNT_KEYS.length;
  const queue = [[value, 0]];
  while (queue.length > 0) {
    const [node, depth] = queue.shift();
    if (depth > 4 || node === null || typeof node !== "object") continue;
    const entries = Array.isArray(node) ? node.slice(0, 20).map((item) => [null, item]) : Object.entries(node).slice(0, 60);
    for (const [rawKey, item] of entries) {
      const key = rawKey === null ? null : normalizeKey(rawKey);
      if (key !== null && CREDENTIAL_KEY.test(key)) continue;
      if (item !== null && typeof item === "object") {
        queue.push([item, depth + 1]);
        continue;
      }
      if (key === null) continue;
      const rank = ACCOUNT_KEYS.indexOf(key);
      if (rank !== -1) {
        const account = rank < accountRank ? accountValue(item) : null;
        if (account !== null) { found.accountId = account; accountRank = rank; }
      } else if (isPhoneKey(key) && found.phone === null) found.phone = phoneValue(item);
      else if (isEmailKey(key) && found.email === null) found.email = emailValue(item);
    }
  }
  return found;
}

/** Where the tab is now: the search page, a login page, or anywhere else (which ends the job). */
export function classifySeerfarAddress(address) {
  let url;
  try { url = new URL(String(address || "")); } catch { return "other"; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "other";
  if (url.hostname !== "www.seerfar.cn" && url.hostname !== "seerfar.cn") return "other";
  if (/login|signin|sign-in|passport/i.test(url.pathname) || /login/i.test(url.hash)) return "login";
  return url.hostname === "www.seerfar.cn" && url.pathname.replace(/\/$/, "") === "/admin/product-search" ? "search_page" : "other";
}

/** MAIN world. Wraps fetch and XHR once and keeps the last few responses from the search endpoint, nothing else. */
export function installSeerfarSearchHookInPage(endpointPath) {
  const state = window.__selectionReviewSeerfar || (window.__selectionReviewSeerfar = { installed: false, captures: [] });
  if (state.installed) return { installed: true, already: true };
  const matches = (url) => {
    try { return new URL(String(url), location.href).pathname === endpointPath; } catch { return false; }
  };
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const remember = (requestBody, status, text) => {
    state.captures.push({ requestBody: typeof requestBody === "string" ? parse(requestBody) : null, status, body: parse(text), at: new Date().toISOString() });
    if (state.captures.length > 10) state.captures.shift();
  };
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url;
      const promise = originalFetch.apply(this, arguments);
      if (matches(url)) {
        const requestBody = typeof init?.body === "string" ? init.body : null;
        promise.then((response) => response.clone().text().then((text) => remember(requestBody, response.status, text))).catch(() => {});
      }
      return promise;
    };
  }
  const proto = window.XMLHttpRequest?.prototype;
  if (proto) {
    const open = proto.open, send = proto.send;
    proto.open = function (method, url) {
      this.__selectionReviewSeerfarUrl = url;
      return open.apply(this, arguments);
    };
    proto.send = function (body) {
      if (matches(this.__selectionReviewSeerfarUrl)) {
        const requestBody = typeof body === "string" ? body : null;
        this.addEventListener("loadend", () => {
          try { remember(requestBody, this.status, typeof this.responseText === "string" ? this.responseText : ""); } catch {}
        });
      }
      return send.apply(this, arguments);
    };
  }
  state.installed = true;
  return { installed: true, already: false };
}

/**
 * MAIN world. Looks through the saved responses, newest first, for one page of products that all sit in the categories
 * this round asked for. A search of some other category is ignored and the job keeps waiting for the right one.
 */
export function readSeerfarSearchCapturesInPage(categoryPaths, maxRecords) {
  const state = window.__selectionReviewSeerfar;
  if (!state?.installed) return { status: "hook_missing" };
  const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value) && "sku" in value && value.categoryInfo && typeof value.categoryInfo === "object";
  const findRecords = (value, depth) => {
    if (depth > 6 || value === null || typeof value !== "object") return null;
    if (Array.isArray(value)) return value.length > 0 && value.every(isRecord) ? value : null;
    for (const key of Object.keys(value)) {
      const found = findRecords(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  const findTotal = (value, depth) => {
    if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) return null;
    for (const key of ["total", "totalCount", "totalRecords", "count"]) if (Number.isSafeInteger(value[key]) && value[key] >= 0) return value[key];
    for (const key of Object.keys(value)) {
      const found = findTotal(value[key], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  for (const capture of [...state.captures].reverse()) {
    if (capture.status !== 200) continue;
    const records = findRecords(capture.body, 0);
    // Same rule as the service: a declared category is a run of whole path segments.
    const inScope = (path) => typeof path === "string" && categoryPaths.some((entry) => ` > ${path} > `.includes(` > ${entry} > `));
    if (!records || !records.every((record) => inScope(record.categoryInfo?.cnTitlePath))) continue;
    const label = (document.body?.innerText || "").match(/共\s*[\d,]+\s*条记录/)?.[0]?.replace(/\s+/g, "");
    const total = findTotal(capture.body, 0);
    return { status: "captured", records: records.slice(0, maxRecords), requestBody: capture.requestBody, capturedAt: capture.at,
      resultCountLabel: label || (total !== null ? `共${total}条记录` : "未读到总条数") };
  }
  return { status: "waiting" };
}

/**
 * The whole job: open the search page in a tab the owner can see, wait for their search, return one page. The tab is
 * ours and is closed by the caller. Login pages and wandering off the search page end the job with their reason.
 */
export async function runSeerfarWebCapture({ chromeApi, payload, signal, clock = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onTab = () => {} }) {
  const tab = await chromeApi.tabs.create({ url: payload.pageUrl, active: true });
  if (!Number.isInteger(tab.id)) throw failure("system_error");
  onTab(tab.id);
  const endpointPath = new URL(payload.endpoint).pathname;
  const started = Date.now();
  while (Date.now() - started < payload.waitMs) {
    if (signal?.aborted) throw failure("timeout");
    const current = await chromeApi.tabs.get(tab.id);
    const place = classifySeerfarAddress(current.pendingUrl || current.url);
    if (place === "login") throw failure("site_login_required");
    if (place === "other") {
      // The first moments of a new tab can still read about:blank; anything else is somewhere the job must not read.
      if (!/^(?:about:blank|)$/.test(String(current.pendingUrl || current.url || ""))) throw failure("navigation_rejected");
    } else if (current.status === "complete" || !current.pendingUrl) {
      const [installed] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN",
        func: installSeerfarSearchHookInPage, args: [endpointPath] });
      if (installed?.result?.installed !== true) throw failure("system_error");
      const [read] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN",
        func: readSeerfarSearchCapturesInPage, args: [payload.categoryPaths, payload.maxRecords] });
      const found = read?.result;
      if (found?.status === "captured") {
        // Re-read the browser's own address after extraction, not the page's idea of where it is.
        const after = await chromeApi.tabs.get(tab.id);
        if (classifySeerfarAddress(after.url) !== "search_page") throw failure("navigation_rejected");
        // The page's whole request body stays here: only its search conditions and the three account fields go back.
        const requestBody = found.requestBody ?? null;
        return { status: "captured", observedAt: clock(), requestTemplate: sanitizeSeerfarRequestTemplate(requestBody),
          accountIdentity: pickSeerfarAccountIdentity(requestBody),
          capture: { pageUrl: payload.pageUrl, endpoint: payload.endpoint, httpStatus: 200, capturedAt: found.capturedAt,
            resultCountLabel: String(found.resultCountLabel).slice(0, 64), records: Array.isArray(found.records) ? found.records : [] } };
      }
    }
    await sleep(POLL_MS);
  }
  throw failure("no_matching_search");
}
