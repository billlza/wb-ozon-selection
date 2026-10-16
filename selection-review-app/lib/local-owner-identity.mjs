import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { persistJsonThroughRealTarget } from "./atomic-json-persistence.mjs";
import { derivePasswordKey, isPasswordVerifier, PASSWORD_KDF as KDF } from "./scrypt-verifier.mjs";
import { createActorContext } from "./runtime-identity.mjs";
import { isOwnerCredentialPathIsolated, isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";

const RECORD_VERSION = "local-owner-credential-v1";
const COOKIE_NAME = "selection_review_owner";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 4;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export class OwnerIdentityError extends Error {
  constructor(code, statusCode, message) { super(message); this.name = "OwnerIdentityError"; this.code = code; this.statusCode = statusCode; }
}
function failure(code, status, message) { return new OwnerIdentityError(code, status, message); }
function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function validRecord(record) {
  return exact(record, ["schemaVersion", "ownerId", "credentialRevision", "createdAt", "verifier"]) && record.schemaVersion === RECORD_VERSION &&
    typeof record.ownerId === "string" && /^local-owner:[0-9a-f-]{36}$/.test(record.ownerId) && record.credentialRevision === 1 &&
    isRuntimeConfigurationTimestamp(record.createdAt) && isPasswordVerifier(record.verifier);
}
function privateStat(stat, kind) {
  return !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile()) &&
    (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

/** Private authentication records never enter the business-state repository or public projections. */
export function createPrivateOwnerCredentialRepository({ filePath, protectedPaths = [], fileSystem = fs, atomicWriter = persistJsonThroughRealTarget }) {
  const absolutePath = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
  if (!absolutePath(filePath) || !Array.isArray(protectedPaths) || !protectedPaths.every(absolutePath)) throw failure("OWNER_IDENTITY_CONFIGURATION_INVALID", 503, "本地主人认证的私有位置未正确配置");
  const protectedLocations = [...protectedPaths];
  const directory = path.dirname(filePath);
  async function resolvedLocation(location) {
    const missing = [];
    let current = location;
    while (true) {
      try { return path.join(await fileSystem.realpath(current), ...missing); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        // A dangling link is not an absent directory that registration may create.
        try { if ((await fileSystem.lstat(current)).isSymbolicLink()) throw failure("OWNER_IDENTITY_STORAGE_INVALID", 503, "身份路径含不可解析的符号链接"); }
        catch (statError) { if (statError.code !== "ENOENT") throw statError; }
        const parent = path.dirname(current);
        if (parent === current) throw error;
        missing.unshift(path.basename(current)); current = parent;
      }
    }
  }
  async function assertIsolatedLocation() {
    try {
      const [resolvedFile, ...resolvedProtected] = await Promise.all([filePath, ...protectedLocations].map(resolvedLocation));
      if (!isOwnerCredentialPathIsolated(resolvedFile, resolvedProtected)) throw failure("OWNER_IDENTITY_CONFIGURATION_INVALID", 503, "身份私有目录不得与源码、业务数据或素材位置交叠");
    } catch (error) {
      if (error instanceof OwnerIdentityError) throw error;
      throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "身份私有路径无法安全核对");
    }
  }
  async function assertDirectory({ allowMissing = false } = {}) {
    let stat;
    try { stat = await fileSystem.lstat(directory); }
    catch (error) {
      if (error.code === "ENOENT" && allowMissing) return false;
      throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "本地主人认证存储不可用");
    }
    if (!privateStat(stat, "directory")) throw failure("OWNER_IDENTITY_STORAGE_PERMISSIONS", 503, "身份目录必须属于当前系统用户且仅该用户可访问");
    return true;
  }
  return Object.freeze({
    boundaryType: "private_owner_credential_repository",
    async read() {
      await assertIsolatedLocation();
      if (!await assertDirectory({ allowMissing: true })) return null;
      let handle;
      try {
        handle = await fileSystem.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!privateStat(stat, "file") || stat.size > 4096) throw failure("OWNER_IDENTITY_STORAGE_INVALID", 503, "身份文件权限或格式无效");
        const record = JSON.parse(await handle.readFile("utf8"));
        if (!validRecord(record)) throw failure("OWNER_IDENTITY_STORAGE_INVALID", 503, "身份文件权限或格式无效");
        return record;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        if (error instanceof OwnerIdentityError) throw error;
        throw failure("OWNER_IDENTITY_STORAGE_INVALID", 503, "身份文件无法安全读取");
      } finally {
        if (handle) {
          try { await handle.close(); }
          catch { throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "身份文件读取未正常结束"); }
        }
      }
    },
    async create(record) {
      if (!validRecord(record)) throw failure("OWNER_IDENTITY_RECORD_INVALID", 503, "身份记录未通过内部校验");
      await assertIsolatedLocation();
      // The configured parent must already exist; only the dedicated private directory is created.
      // Syncing that parent makes the directory entry durable before the account is committed.
      try { await fileSystem.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "身份私有目录无法创建，请确认上级目录已存在"); }
      await assertDirectory();
      let parentHandle;
      try { parentHandle = await fileSystem.open(path.dirname(directory), "r"); await parentHandle.sync(); }
      catch { throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "身份私有目录无法创建"); }
      finally {
        if (parentHandle) {
          try { await parentHandle.close(); }
          catch { throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "身份私有目录创建未正常结束"); }
        }
      }
      try { await atomicWriter(filePath, record, { fileSystem, createOnly: true }); }
      catch (error) {
        if (error.code === "EEXIST") throw failure("OWNER_ALREADY_CONFIGURED", 409, "主人账户已经设置，请登录");
        if (error.code === "ATOMIC_JSON_DURABILITY_UNCONFIRMED" || error.replaced === true) throw failure("OWNER_IDENTITY_STORAGE_UNCERTAIN", 503, "首次设置的保存结果待核对，请重启后检查登录状态");
        throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "首次设置未完成，身份存储不可用");
      }
    }
  });
}

function passwordInput(input, setup) {
  if (!exact(input, ["password"]) || typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") > 1024 ||
      input.password.includes("\0") || (setup ? [...input.password].length < 4 : input.password.length === 0)) {
    throw failure("OWNER_PASSWORD_INPUT_INVALID", 400, setup ? "请设置至少4个字符、最多1024字节的口令" : "请输入有效口令");
  }
  return input.password;
}
function cookieToken(request) {
  const header = request?.headers?.cookie;
  if (typeof header !== "string" || header.length > 4096) return null;
  const values = header.split(";").map(item => item.trim()).filter(item => item.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
async function passwordKey(password, salt) {
  try {
    return await derivePasswordKey(password, salt);
  } catch { throw failure("OWNER_IDENTITY_VERIFICATION_UNAVAILABLE", 503, "口令核验暂不可用"); }
}

/** Single local owner. Possession of a validated session proves login, not production approval. */
export function createLocalOwnerIdentityProvider({ credentialRepository, secureCookies = false, clock = () => new Date().toISOString() } = {}) {
  if (credentialRepository?.boundaryType !== "private_owner_credential_repository" || typeof credentialRepository.read !== "function" ||
      typeof credentialRepository.create !== "function" || typeof secureCookies !== "boolean" || typeof clock !== "function") {
    throw failure("OWNER_IDENTITY_CONFIGURATION_INVALID", 503, "本地主人身份提供器配置无效");
  }
  let initialized = false;
  let record = null;
  let storageFailure = null;
  let operationRunning = false;
  let failureWindow = null;
  const sessions = new Map();
  function instant() {
    const value = clock();
    if (!isRuntimeConfigurationTimestamp(value)) throw failure("OWNER_IDENTITY_CLOCK_INVALID", 503, "身份服务时间无效");
    return { iso: value, ms: Date.parse(value) };
  }
  function requireInitialized() {
    if (storageFailure) throw storageFailure;
    if (!initialized) throw failure("OWNER_IDENTITY_NOT_INITIALIZED", 503, "本地主人身份尚未初始化");
  }
  async function readRecord() {
    let value;
    try { value = await credentialRepository.read(); }
    catch (error) {
      if (error instanceof OwnerIdentityError) throw error;
      throw failure("OWNER_IDENTITY_STORAGE_UNAVAILABLE", 503, "身份存储不可用");
    }
    if (value !== null && !validRecord(value)) throw failure("OWNER_IDENTITY_STORAGE_INVALID", 503, "身份存储未返回有效记录");
    return value;
  }
  function purgeExpired(nowMs) {
    for (const [token, session] of sessions) if (session.expiresAt <= nowMs || session.idleUntil <= nowMs) sessions.delete(token);
  }
  function sessionFor(request, { touch = false } = {}) {
    requireInitialized();
    const now = instant(); purgeExpired(now.ms);
    const session = sessions.get(cookieToken(request));
    if (!session) return null;
    if (touch) session.idleUntil = Math.min(now.ms + SESSION_IDLE_MS, session.expiresAt);
    return session;
  }
  function cookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
  }
  function createSession() {
    const now = instant(); purgeExpired(now.ms);
    if (sessions.size >= MAX_SESSIONS) throw failure("OWNER_SESSION_CAPACITY", 429, "有效登录会话已达上限，请先退出其他会话或等待过期");
    const token = randomBytes(32).toString("base64url");
    const actor = createActorContext({ userId: record.ownerId, sessionId: `owner-session:${randomUUID()}`, actorType: "human", roles: ["owner"],
      source: "authenticated_identity_provider", authenticatedAt: now.iso });
    sessions.set(token, { actor, expiresAt: now.ms + SESSION_LIFETIME_MS, idleUntil: now.ms + SESSION_IDLE_MS });
    return { actor, setCookie: cookie(token, SESSION_LIFETIME_MS / 1000) };
  }
  async function exclusive(operation) {
    requireInitialized();
    if (operationRunning) throw failure("OWNER_IDENTITY_BUSY", 429, "正在核验一次主人请求，请稍后再提交");
    operationRunning = true;
    try { return await operation(); }
    finally { operationRunning = false; }
  }
  const provider = {
    boundaryType: "runtime_identity_provider", providerType: "local_owner_password", multiUserReady: false,
    async initialize() {
      if (initialized) return;
      if (operationRunning) throw failure("OWNER_IDENTITY_BUSY", 429, "身份初始化正在进行");
      operationRunning = true;
      try { record = await readRecord(); initialized = true; }
      finally { operationRunning = false; }
    },
    publicAccessState({ request } = {}) {
      const session = sessionFor(request);
      return { providerType: "local_owner_password", status: session ? "authenticated" : record ? "login_required" : "setup_required",
        user: session ? { userId: session.actor.userId } : null };
    },
    resolveActor({ request, touch = false } = {}) {
      if (typeof touch !== "boolean") throw failure("OWNER_IDENTITY_CONTEXT_INVALID", 503, "身份请求上下文无效");
      const session = sessionFor(request, { touch });
      if (!session) throw failure("OWNER_LOGIN_REQUIRED", 401, "请先登录主人账户");
      return session.actor;
    },
    async setup(input) {
      const password = passwordInput(input, true);
      return exclusive(async () => {
        if (record) throw failure("OWNER_ALREADY_CONFIGURED", 409, "主人账户已经设置，请登录");
        const salt = randomBytes(16).toString("hex");
        const key = await passwordKey(password, salt);
        const prepared = { schemaVersion: RECORD_VERSION, ownerId: `local-owner:${randomUUID()}`, credentialRevision: 1, createdAt: instant().iso,
          verifier: { ...KDF, salt, derivedKey: key.toString("hex") } };
        key.fill(0);
        try { await credentialRepository.create(prepared); }
        catch (error) {
          if (error instanceof OwnerIdentityError && error.code === "OWNER_ALREADY_CONFIGURED") {
            try { record = await readRecord(); }
            catch { storageFailure = failure("OWNER_IDENTITY_STORAGE_UNCERTAIN", 503, "已有身份记录尚未回读，请重启后检查登录状态"); }
            if (!record) storageFailure = failure("OWNER_IDENTITY_STORAGE_UNCERTAIN", 503, "身份保存记录待核对，请重启后检查");
          } else if (!(error instanceof OwnerIdentityError) || error.code === "OWNER_IDENTITY_STORAGE_UNCERTAIN") {
            storageFailure = failure("OWNER_IDENTITY_STORAGE_UNCERTAIN", 503, "首次设置的保存结果待核对，请重启后检查登录状态");
          }
          throw storageFailure ?? error;
        }
        let saved;
        try { saved = await readRecord(); }
        catch {
          storageFailure = failure("OWNER_IDENTITY_STORAGE_UNCERTAIN", 503, "首次设置已提交但尚未回读，请重启后检查登录状态");
          throw storageFailure;
        }
        if (!saved || saved.ownerId !== prepared.ownerId || saved.verifier.derivedKey !== prepared.verifier.derivedKey) {
          storageFailure = failure("OWNER_IDENTITY_STORAGE_UNCERTAIN", 503, "首次设置的保存结果待核对，请重启后检查登录状态");
          throw storageFailure;
        }
        record = saved;
        return createSession();
      });
    },
    async login(input) {
      const password = passwordInput(input, false);
      return exclusive(async () => {
        if (!record) throw failure("OWNER_SETUP_REQUIRED", 409, "请先设置主人账户");
        const now = instant(); purgeExpired(now.ms);
        if (failureWindow && now.ms >= failureWindow.until) failureWindow = null;
        if (failureWindow?.count >= MAX_FAILURES) throw failure("OWNER_LOGIN_RATE_LIMITED", 429, "口令失败次数较多，请15分钟后再试");
        if (sessions.size >= MAX_SESSIONS) throw failure("OWNER_SESSION_CAPACITY", 429, "有效登录会话已达上限，请先退出其他会话或等待过期");
        const key = await passwordKey(password, record.verifier.salt);
        const matches = timingSafeEqual(key, Buffer.from(record.verifier.derivedKey, "hex")); key.fill(0);
        if (!matches) {
          failureWindow ??= { count: 0, until: now.ms + FAILURE_WINDOW_MS };
          failureWindow.count += 1;
          throw failure("OWNER_LOGIN_REJECTED", 401, "口令不正确");
        }
        failureWindow = null;
        return createSession();
      });
    },
    logout({ request } = {}) {
      requireInitialized(); sessions.delete(cookieToken(request));
      return { setCookie: cookie("", 0) };
    }
  };
  return Object.freeze(provider);
}
