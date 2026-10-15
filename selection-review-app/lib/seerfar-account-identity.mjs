/**
 * Seerfar 会员账号的 ID、手机号、邮箱（审查清单 P1-22，主人 2026-10-15 定：要存，方便用户，大电商平台都这么做）。
 *
 * 完整的值只存进这台电脑的系统凭据库（Mac 上就是钥匙串，和 Seerfar 开放接口密钥同一个服务名）；工作台的数据文件和
 * 页面只留打码的样子、这次请求里有哪几项、和上一次存的是不是同一个账号。令牌、签名、Cookie、密码这类登录凭据
 * 不归这里管，任何地方都不存。
 *
 * 这是本地开发适配器（AGENTS 0A）：只在 local_development 下读写本机凭据库；中央运行方式下一律不存，页面照实说明。
 * 存不上时只记一个分类好的原因，不重试，也不挡这一轮收商品。
 */
import { CredentialStoreError, createOsCredentialStore } from './credential-store.mjs';

export const SEERFAR_ACCOUNT_IDENTITY_SCHEMA = 'seerfar-web-account-identity-v1';
/** Same service name as the Seerfar open API key (seerfar-runtime-connector.mjs), its own account name. */
export const SEERFAR_ACCOUNT_KEYCHAIN_SERVICE = 'egg-ozon-operations-center';
export const SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT = 'seerfar-web-account';
const STORED_SCHEMA = 'seerfar-web-account-v1';
const FIELDS = Object.freeze(['accountId', 'phone', 'email']);

export const SEERFAR_ACCOUNT_IDENTITY_FAILURES = Object.freeze({
  not_local: '现在是中央运行方式，账号信息不往这台电脑的钥匙串里存',
  store_unavailable: '这台电脑的系统钥匙串用不了',
  access_denied: '系统钥匙串没允许（可能点了「拒绝」）',
  read_failed: '读钥匙串里上一次存的账号没成功',
  write_failed: '写进系统钥匙串没成功',
  system_error: '程序出错了'
});

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizeKey = key => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
// A login credential is never an identity: nothing under these keys is read.
const CREDENTIAL_KEY = /token|auth|sign|cookie|session|passw|secret|ticket|nonce|jwt|credential|bearer|captcha|header/;
// Most specific first: an accountId beats a memberId, which beats a bare "user".
const ACCOUNT_KEYS = Object.freeze(['accountid', 'memberid', 'userid', 'customerid', 'uid', 'loginid', 'loginname', 'username', 'accountname',
  'account', 'member', 'user']);
const isPhoneKey = key => /phone|mobile/.test(key) || key === 'tel' || key === 'telephone';
const isEmailKey = key => key.includes('email') || key === 'mail' || key === 'mailaddress';

function accountValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^[\p{L}\p{N}_.@+-]{1,64}$/u.test(text) && !/^eyJ[\w-]*\./.test(text) ? text : null;
}
function phoneValue(value) {
  const text = Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\+?[\d\s()*-]{6,24}$/.test(text)) return null;
  const digits = text.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 15 ? `${text.startsWith('+') ? '+' : ''}${text.replace(/[^\d*]/g, '')}` : null;
}
function emailValue(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text.length <= 128 && /^[^\s@"'<>()[\]\\,;:]{1,64}@[\p{L}\p{N}.-]{1,100}\.\p{L}{2,24}$/u.test(text) ? text : null;
}
const VALUE_OF = Object.freeze({ accountId: accountValue, phone: phoneValue, email: emailValue });
const normalizeIdentity = input => Object.fromEntries(FIELDS.map(field => [field,
  input?.[field] === null || input?.[field] === undefined ? null : VALUE_OF[field](input[field])]));

/**
 * The account ID, phone and email a request carries, wherever they sit (at most 4 levels down). Values that do not look
 * like what their key says are ignored, and so is everything under a credential-like key. Missing fields are null.
 */
export function pickSeerfarAccountIdentity(value) {
  const found = { accountId: null, phone: null, email: null };
  let accountRank = ACCOUNT_KEYS.length;
  const queue = [[value, 0]];
  while (queue.length > 0) {
    const [node, depth] = queue.shift();
    if (depth > 4 || node === null || typeof node !== 'object') continue;
    const entries = Array.isArray(node) ? node.slice(0, 20).map(item => [null, item]) : Object.entries(node).slice(0, 60);
    for (const [rawKey, item] of entries) {
      const key = rawKey === null ? null : normalizeKey(rawKey);
      if (key !== null && CREDENTIAL_KEY.test(key)) continue;
      if (item !== null && typeof item === 'object') {
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

const maskMiddle = (text, head, tail) => `${text.slice(0, head)}****${text.slice(text.length - tail)}`;
function maskEmail(email) {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
function maskPhone(phone) {
  const plus = phone.startsWith('+') ? '+' : '';
  const body = phone.slice(plus.length);
  return plus + (body.length >= 9 ? maskMiddle(body, 3, 4) : maskMiddle(body, 2, 2));
}
function maskAccountId(accountId) {
  if (accountId.includes('@')) return maskEmail(accountId);
  if (accountId.length >= 8) return maskMiddle(accountId, 2, 2);
  return accountId.length >= 5 ? maskMiddle(accountId, 1, 1) : '****';
}

/** What the data file and the page may hold: every value masked, absent ones null. */
export function maskSeerfarAccountIdentity(identity) {
  return { accountId: identity.accountId === null ? null : maskAccountId(identity.accountId),
    phone: identity.phone === null ? null : maskPhone(identity.phone),
    email: identity.email === null ? null : maskEmail(identity.email) };
}

function status({ identity, shown = identity, outcome, location = null, sameAsPrevious = null, failureCode = null }) {
  return { schemaVersion: SEERFAR_ACCOUNT_IDENTITY_SCHEMA, status: outcome, fields: FIELDS.filter(field => identity[field] !== null),
    masked: maskSeerfarAccountIdentity(shown), sameAsPrevious, location,
    failure: failureCode === null ? null : { code: failureCode, reason: SEERFAR_ACCOUNT_IDENTITY_FAILURES[failureCode] } };
}

/** A round's record of what happened to the account identity; the round refuses anything else. */
export function isSeerfarAccountIdentityStatus(value) {
  const keys = ['schemaVersion', 'status', 'fields', 'masked', 'sameAsPrevious', 'location', 'failure'];
  return isPlain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    value.schemaVersion === SEERFAR_ACCOUNT_IDENTITY_SCHEMA && ['saved', 'not_in_request', 'not_saved'].includes(value.status) &&
    Array.isArray(value.fields) && value.fields.every(field => FIELDS.includes(field)) && new Set(value.fields).size === value.fields.length &&
    isPlain(value.masked) && Object.keys(value.masked).length === FIELDS.length &&
    FIELDS.every(field => value.masked[field] === null || typeof value.masked[field] === 'string' && value.masked[field].length <= 140 &&
      value.masked[field].includes('***')) &&
    [true, false, null].includes(value.sameAsPrevious) &&
    (value.location === null || typeof value.location === 'string' && /^[a-z_]{1,64}$/.test(value.location)) &&
    (value.failure === null ? value.status !== 'not_saved'
      : value.status === 'not_saved' && isPlain(value.failure) && Object.keys(value.failure).length === 2 &&
        Object.hasOwn(SEERFAR_ACCOUNT_IDENTITY_FAILURES, value.failure.code) && value.failure.reason === SEERFAR_ACCOUNT_IDENTITY_FAILURES[value.failure.code]) &&
    (value.status === 'not_in_request') === (value.fields.length === 0);
}

// The stored entry is base64 JSON so it passes every backend's command line unquoted.
function encodeStored(identity, savedAt) {
  return Buffer.from(JSON.stringify({ schemaVersion: STORED_SCHEMA, ...identity, savedAt }), 'utf8').toString('base64');
}
function decodeStored(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/=]{1,1024}$/.test(text.trim())) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8')); } catch { return null; }
  if (!isPlain(parsed) || parsed.schemaVersion !== STORED_SCHEMA) return null;
  const identity = {};
  for (const field of FIELDS) {
    if (parsed[field] !== null && VALUE_OF[field](parsed[field]) !== parsed[field]) return null;
    identity[field] = parsed[field];
  }
  return identity;
}
function sameAccount(previous, identity) {
  for (const field of FIELDS) if (previous[field] !== null && identity[field] !== null) return previous[field] === identity[field];
  return null;
}
function failureFor(code, fallback) {
  if (code === 'credential_access_denied') return 'access_denied';
  if (code === 'credential_store_unavailable') return 'store_unavailable';
  return fallback;
}

/**
 * The local keychain entry for the Seerfar member account. save() reads the previous entry, tells whether this is the same
 * account, writes the new values (merged with the old ones when it is the same account) and returns the round's status.
 * Construction touches nothing; a request without any of the three fields touches nothing either.
 */
export function createSeerfarAccountVault({ runtimeMode = 'local_development', credentialStore, platform = process.platform,
  entry = { service: SEERFAR_ACCOUNT_KEYCHAIN_SERVICE, account: SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT }, timeoutMs = 5000 } = {}) {
  if (credentialStore !== undefined && (typeof credentialStore?.readSecret !== 'function' || typeof credentialStore?.writeSecret !== 'function') ||
      !isPlain(entry) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('SEERFAR_ACCOUNT_VAULT_CONFIGURATION_INVALID');
  let store = credentialStore ?? null;
  return Object.freeze({
    async save(input, { at }) {
      const identity = normalizeIdentity(input);
      if (FIELDS.every(field => identity[field] === null)) return status({ identity, outcome: 'not_in_request' });
      if (runtimeMode !== 'local_development') return status({ identity, outcome: 'not_saved', failureCode: 'not_local' });
      store ??= createOsCredentialStore({ platform });
      const location = typeof store.backend === 'string' && /^[a-z_]{1,64}$/.test(store.backend) ? store.backend : null;
      let previous = null;
      try {
        previous = decodeStored(await store.readSecret(entry, { timeout: timeoutMs, maxBuffer: 8192 }));
      } catch (error) {
        if (!(error instanceof CredentialStoreError)) throw error;
        if (error.code !== 'credential_missing') return status({ identity, outcome: 'not_saved', location, failureCode: failureFor(error.code, 'read_failed') });
      }
      const sameAsPrevious = previous === null ? null : sameAccount(previous, identity);
      // Only the same account keeps its older fields; when that cannot be told, the new values replace the old ones whole.
      const next = sameAsPrevious === true ? Object.fromEntries(FIELDS.map(field => [field, identity[field] ?? previous[field]])) : identity;
      if (previous === null || FIELDS.some(field => previous[field] !== next[field])) {
        try {
          await store.writeSecret(entry, encodeStored(next, at), { timeout: timeoutMs });
        } catch (error) {
          if (!(error instanceof CredentialStoreError)) throw error;
          return status({ identity, outcome: 'not_saved', location, sameAsPrevious, failureCode: failureFor(error.code, 'write_failed') });
        }
      }
      return status({ identity, shown: next, outcome: 'saved', location, sameAsPrevious });
    }
  });
}

/** The status a round records when the vault itself failed (a defect, not a classified store failure). */
export function seerfarAccountIdentityFailure(input, failureCode = 'system_error') {
  const identity = normalizeIdentity(input);
  return FIELDS.every(field => identity[field] === null) ? status({ identity, outcome: 'not_in_request' })
    : status({ identity, outcome: 'not_saved', failureCode });
}
