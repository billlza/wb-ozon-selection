import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { OwnerIdentityError } from "./local-owner-identity.mjs";
import { createPasswordVerifier, passwordMatches } from "./scrypt-verifier.mjs";
import { isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";
import { createActorContext } from "./runtime-identity.mjs";
import { isTeamUserId, normalizeLoginName, publicTeamAccount, TeamAccountStoreError } from "./team-account-store.mjs";

// Team sign-in: each person logs in with their own login name and password. A boss acts with the owner role; the tester
// with the operator role (owner decision 2026-10-16). Sessions live in this process; every request re-reads the account,
// so a disabled account or a changed password ends its sessions at once.
export const TEAM_ACCOUNT_ROLE_GRANTS = Object.freeze({ boss: Object.freeze(["owner"]), tester: Object.freeze(["operator"]) });
const COOKIE_NAME = "selection_review_session";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS_PER_ACCOUNT = 6;
const MAX_SESSIONS = 30;
// Wrong passwords are counted by where they come from, so someone else guessing cannot lock the team out: one address
// waits after five wrong passwords for one login name, or twenty for any names, within fifteen minutes.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_SOURCE_NAME = 5;
const MAX_FAILURES_PER_SOURCE = 20;
const MAX_FAILURE_COUNTERS = 10000;
// The server is reachable from the internet, so a new password is longer than the local owner's four characters.
export const TEAM_PASSWORD_MIN_CHARACTERS = 8;

function failure(code, status, message) { return new OwnerIdentityError(code, status, message); }
function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length &&
    fields.every(key => Object.hasOwn(value, key));
}
function storageFailure() { return failure("TEAM_ACCOUNT_STORAGE_UNAVAILABLE", 503, "账号存储暂时读不出来，请稍后再试"); }

function enteredPassword(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 1024 ? value : null;
}

/** A new password: at least eight characters, at most 1024 bytes, kept exactly as typed. */
export function newTeamPassword(value) {
  const password = enteredPassword(value);
  if (password === null || [...password].length < TEAM_PASSWORD_MIN_CHARACTERS) {
    throw failure("TEAM_PASSWORD_INPUT_INVALID", 400, `新密码至少${TEAM_PASSWORD_MIN_CHARACTERS}个字符、最多1024字节`);
  }
  return password;
}

/**
 * Where a sign-in comes from: the connecting address, or, with `trustedProxyHops` proxies in front of the service (each
 * adding the address it saw to X-Forwarded-For), the address the outermost of them saw. Anything earlier in that header
 * is whatever the caller wrote, so it is never read.
 */
export function signInSource(request, trustedProxyHops = 0) {
  const connected = request?.socket?.remoteAddress;
  const fallback = typeof connected === "string" && isIP(connected) ? connected : "unknown";
  if (trustedProxyHops === 0) return fallback;
  const header = request?.headers?.["x-forwarded-for"];
  if (typeof header !== "string" || header.length > 2048) return fallback;
  const entries = header.split(",").map(item => item.trim());
  const address = entries[entries.length - trustedProxyHops];
  return typeof address === "string" && isIP(address) ? address : fallback;
}

/**
 * What wrong passwords are counted under: an IPv4 address as it is (also when written as IPv6), and for IPv6 its /64,
 * since one connection usually holds a whole /64 and could otherwise start afresh from each address in it.
 */
export function failureSourceKey(address) {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return String(address);
  const lower = address.toLowerCase().split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
  if (mapped) return mapped[1];
  // A dotted IPv4 tail is the last two groups, past the /64 anyway.
  const plain = lower.replace(/\d+\.\d+\.\d+\.\d+$/u, "0:0");
  const groups = part => part === "" ? [] : part.split(":");
  const [head, tail] = plain.includes("::") ? plain.split("::") : [plain, ""];
  const left = groups(head), right = groups(tail);
  const full = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${full.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}

function cookieToken(request) {
  const header = request?.headers?.cookie;
  if (typeof header !== "string" || header.length > 4096) return null;
  const values = header.split(";").map(item => item.trim()).filter(item => item.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export function createTeamAccountIdentityProvider({ accountStore, secureCookies = false, trustedProxyHops = 0,
  clock = () => new Date().toISOString() } = {}) {
  if (accountStore?.boundaryType !== "team_account_store" || typeof secureCookies !== "boolean" || typeof clock !== "function" ||
      !Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 3) {
    throw failure("TEAM_IDENTITY_CONFIGURATION_INVALID", 503, "团队登录配置无效");
  }
  let initialized = false;
  let operationRunning = false;
  let unknownNameVerifier = null;
  const sessions = new Map();
  // Wrong-password counters by source address, and by source address and login name; oldest first.
  const failures = new Map();
  // What each request was found to be, set once by authenticateRequest before any route reads it.
  const resolved = new WeakMap();

  function instant() {
    const value = clock();
    if (!isRuntimeConfigurationTimestamp(value)) throw failure("TEAM_IDENTITY_CLOCK_INVALID", 503, "身份服务时间无效");
    return { iso: value, ms: Date.parse(value) };
  }
  function requireInitialized() {
    if (!initialized) throw failure("TEAM_IDENTITY_NOT_INITIALIZED", 503, "团队登录尚未初始化");
  }
  async function stored(operation) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof OwnerIdentityError) throw error;
      if (error instanceof TeamAccountStoreError && error.code === "TEAM_ACCOUNT_CHANGED") {
        throw failure("TEAM_ACCOUNT_CHANGED", 409, "这个账号刚被改过，请刷新后再试");
      }
      throw storageFailure();
    }
  }
  function purgeExpired(nowMs) {
    for (const [token, session] of sessions) if (session.expiresAt <= nowMs || session.idleUntil <= nowMs) sessions.delete(token);
    for (const [key, window] of failures) if (window.until <= nowMs) failures.delete(key);
  }
  function endSessionsOf(userId) {
    for (const [token, session] of sessions) if (session.userId === userId) sessions.delete(token);
  }
  function cookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
  }
  function actorFor(account, session) {
    return createActorContext({ userId: account.userId, sessionId: session.sessionId, actorType: "human",
      roles: [...TEAM_ACCOUNT_ROLE_GRANTS[account.role]], source: "authenticated_identity_provider", authenticatedAt: session.authenticatedAt });
  }
  function accessFor(account) {
    return { providerType: "team_accounts", status: "authenticated",
      user: { userId: account.userId, displayName: account.displayName, role: account.role } };
  }
  function createSession(account) {
    const now = instant(); purgeExpired(now.ms);
    const own = [...sessions.values()].filter(session => session.userId === account.userId).length;
    if (own >= MAX_SESSIONS_PER_ACCOUNT || sessions.size >= MAX_SESSIONS) {
      throw failure("TEAM_SESSION_CAPACITY", 429, "这个账号登录的地方太多了，请先在别处退出或等一会儿");
    }
    const token = randomBytes(32).toString("base64url");
    const session = { userId: account.userId, credentialRevision: account.credentialRevision, sessionId: `team-session:${randomUUID()}`,
      authenticatedAt: now.iso, expiresAt: now.ms + SESSION_LIFETIME_MS, idleUntil: now.ms + SESSION_IDLE_MS };
    sessions.set(token, session);
    return { actor: actorFor(account, session), access: accessFor(account), setCookie: cookie(token, SESSION_LIFETIME_MS / 1000) };
  }
  // One password check at a time: scrypt is deliberately slow and large.
  async function exclusive(operation) {
    requireInitialized();
    if (operationRunning) throw failure("TEAM_IDENTITY_BUSY", 429, "正在核对另一次登录，请稍后再试");
    operationRunning = true;
    try { return await operation(); }
    finally { operationRunning = false; }
  }
  function failureKeys(source, name) {
    const key = failureSourceKey(source);
    return { bySource: JSON.stringify([key]), byName: JSON.stringify([key, name]) };
  }
  function assertNotRateLimited(source, name, nowMs) {
    purgeExpired(nowMs);
    const keys = failureKeys(source, name);
    if ((failures.get(keys.bySource)?.count ?? 0) >= MAX_FAILURES_PER_SOURCE ||
        (failures.get(keys.byName)?.count ?? 0) >= MAX_FAILURES_PER_SOURCE_NAME) {
      throw failure("TEAM_LOGIN_RATE_LIMITED", 429, "密码错的次数太多，请15分钟后再试");
    }
  }
  function recordFailure(source, name, nowMs) {
    for (const key of Object.values(failureKeys(source, name))) {
      const window = failures.get(key) ?? { count: 0, until: nowMs + FAILURE_WINDOW_MS };
      window.count += 1;
      failures.delete(key);
      failures.set(key, window);
    }
    // Many addresses guessing at once cannot grow this without bound; the counters touched longest ago go first.
    while (failures.size > MAX_FAILURE_COUNTERS) failures.delete(failures.keys().next().value);
  }
  function signedIn(request) {
    requireInitialized();
    const entry = resolved.get(request);
    if (!entry) throw failure("OWNER_LOGIN_REQUIRED", 401, "请先登录");
    return entry;
  }
  // A password check against an unknown name costs the same as against a real one, so the answer time tells nothing.
  async function verify(account, password) {
    unknownNameVerifier ??= await createPasswordVerifier(randomBytes(32).toString("hex"));
    const matches = await passwordMatches(password, account?.verifier ?? unknownNameVerifier);
    return account !== null && matches;
  }

  return Object.freeze({
    boundaryType: "runtime_identity_provider", providerType: "team_accounts", multiUserReady: true,
    async initialize() {
      if (initialized) return;
      await stored(() => accountStore.ensureSchema());
      initialized = true;
    },
    /** Reads the session cookie and the account behind it once per request; routes then read the result. */
    async authenticateRequest(request) {
      requireInitialized();
      if (resolved.has(request)) return;
      resolved.set(request, null);
      const token = cookieToken(request);
      if (token === null) return;
      const now = instant(); purgeExpired(now.ms);
      const session = sessions.get(token);
      if (!session) return;
      const account = await stored(() => accountStore.findByUserId(session.userId));
      if (!account || account.status !== "active" || account.credentialRevision !== session.credentialRevision) {
        sessions.delete(token);
        return;
      }
      resolved.set(request, { token, session, account, actor: actorFor(account, session) });
    },
    publicAccessState({ request } = {}) {
      requireInitialized();
      const entry = resolved.get(request);
      return entry ? accessFor(entry.account) : { providerType: "team_accounts", status: "login_required", user: null };
    },
    resolveActor({ request, touch = false } = {}) {
      if (typeof touch !== "boolean") throw failure("TEAM_IDENTITY_CONTEXT_INVALID", 503, "身份请求上下文无效");
      const entry = signedIn(request);
      if (touch) entry.session.idleUntil = Math.min(instant().ms + SESSION_IDLE_MS, entry.session.expiresAt);
      return entry.actor;
    },
    async setup() {
      throw failure("TEAM_ACCOUNT_SETUP_DISABLED", 403, "账号只能用管理命令建立，网页上不能自己开账号");
    },
    async login(input, { request } = {}) {
      if (!exact(input, ["loginName", "password"]) || typeof input.loginName !== "string" || enteredPassword(input.password) === null) {
        throw failure("TEAM_LOGIN_INPUT_INVALID", 400, "请填写登录名和密码");
      }
      const name = normalizeLoginName(input.loginName) ?? "";
      const source = signInSource(request, trustedProxyHops);
      return exclusive(async () => {
        assertNotRateLimited(source, name, instant().ms);
        const account = name ? await stored(() => accountStore.findByLoginName(name)) : null;
        const matches = await verify(account, input.password);
        if (!matches || account.status !== "active") {
          recordFailure(source, name, instant().ms);
          throw failure("TEAM_LOGIN_REJECTED", 401, "登录名或密码不正确");
        }
        failures.delete(failureKeys(source, name).byName);
        return createSession(account);
      });
    },
    logout({ request } = {}) {
      requireInitialized();
      const token = cookieToken(request);
      if (token !== null) sessions.delete(token);
      return { setCookie: cookie("", 0) };
    },
    /** Anyone signed in changes their own password with the current one; their other sessions end, this one goes on. */
    async changePassword({ request, input } = {}) {
      const entry = signedIn(request);
      if (!exact(input, ["currentPassword", "newPassword"]) || enteredPassword(input.currentPassword) === null) {
        throw failure("TEAM_PASSWORD_INPUT_INVALID", 400, "请填写现在的密码和新密码");
      }
      const password = newTeamPassword(input.newPassword);
      const source = signInSource(request, trustedProxyHops);
      return exclusive(async () => {
        const name = entry.account.loginName;
        assertNotRateLimited(source, name, instant().ms);
        const account = await stored(() => accountStore.findByUserId(entry.account.userId));
        if (!account || account.status !== "active" || account.credentialRevision !== entry.session.credentialRevision) {
          sessions.delete(entry.token);
          throw failure("OWNER_LOGIN_REQUIRED", 401, "请先登录");
        }
        if (!await verify(account, input.currentPassword)) {
          recordFailure(source, name, instant().ms);
          throw failure("TEAM_CURRENT_PASSWORD_REJECTED", 403, "现在的密码不对，密码没有改");
        }
        const updated = await stored(async () => accountStore.setPassword({ userId: account.userId,
          verifier: await createPasswordVerifier(password), expectedRevision: account.credentialRevision }));
        endSessionsOf(account.userId);
        return createSession(updated);
      });
    },
    /** A boss sets a new password for another account (the other boss or the tester); its sessions end. */
    async resetPassword({ request, input } = {}) {
      const entry = signedIn(request);
      if (entry.account.role !== "boss") throw failure("TEAM_ACCOUNT_MANAGER_REQUIRED", 403, "只有老板能给别人重设密码");
      if (!exact(input, ["userId", "newPassword"]) || !isTeamUserId(input.userId)) {
        throw failure("TEAM_PASSWORD_INPUT_INVALID", 400, "请选一个账号并填写新密码");
      }
      if (input.userId === entry.account.userId) {
        throw failure("TEAM_PASSWORD_INPUT_INVALID", 400, "改自己的密码请用「改我的密码」，要先填现在的密码");
      }
      const password = newTeamPassword(input.newPassword);
      return exclusive(async () => {
        const target = await stored(() => accountStore.findByUserId(input.userId));
        if (!target) throw failure("TEAM_ACCOUNT_NOT_FOUND", 404, "没有这个账号");
        const updated = await stored(async () => accountStore.setPassword({ userId: target.userId,
          verifier: await createPasswordVerifier(password), expectedRevision: target.credentialRevision }));
        endSessionsOf(target.userId);
        return { account: publicTeamAccount(updated) };
      });
    },
    /** For a boss: everyone's login name, display name, role and status; never a verifier. */
    async listAccounts({ request } = {}) {
      const entry = signedIn(request);
      if (entry.account.role !== "boss") throw failure("TEAM_ACCOUNT_MANAGER_REQUIRED", 403, "只有老板能看账号名单");
      return (await stored(() => accountStore.list())).map(publicTeamAccount);
    }
  });
}
