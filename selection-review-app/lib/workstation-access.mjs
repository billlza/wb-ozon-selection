import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createPostgresWorkstationStore, isWorkstationId, normalizeWorkstationName } from "./workstation-store.mjs";

// With team accounts every plugin call (heartbeat, claim, picture, result) carries its computer's key, and a job claimed by
// one computer can only be finished by that computer. The key is made here, handed out once when the computer is added,
// and kept on that computer's plugin; the service keeps only its digest.
export const WORKSTATION_KEY_PREFIX = "srw_";
export const MAX_ACTIVE_WORKSTATIONS = 20;
export const WORKSTATION_HEARTBEAT_TTL_MS = 75_000;
const WORKSTATION_KEY = /^srw_[A-Za-z0-9_-]{43}$/u;

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code, extra: { code } });
}

export function isWorkstationKey(value) {
  return typeof value === "string" && WORKSTATION_KEY.test(value);
}

export function workstationKeyDigest(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The key in `Authorization: Bearer srw_…`, or null when the request carries none or a malformed one. */
export function presentedWorkstationKey(request) {
  const header = request?.headers?.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (\S+)$/u.exec(header.trim());
  return match && isWorkstationKey(match[1]) ? match[1] : null;
}

export function createWorkstationAccess({ store, clock = () => new Date().toISOString(), heartbeatTtlMs = WORKSTATION_HEARTBEAT_TTL_MS,
  maxActive = MAX_ACTIVE_WORKSTATIONS, newId = () => `workstation:${randomUUID()}`,
  newKey = () => `${WORKSTATION_KEY_PREFIX}${randomBytes(32).toString("base64url")}` } = {}) {
  if (store?.boundaryType !== "workstation_store") throw new Error("WORKSTATION_STORE_REQUIRED");
  if (!Number.isSafeInteger(heartbeatTtlMs) || heartbeatTtlMs < 1_000 || !Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error("WORKSTATION_ACCESS_CONFIGURATION_INVALID");
  }
  // Last heartbeats stay in this process only: a computer that is on sends one every half minute, so after a restart the
  // list is current again within that time. They show who is online; they never start or finish a job.
  const heartbeats = new Map();
  const nowMs = () => {
    const at = Date.parse(clock());
    if (Number.isNaN(at)) throw new Error("WORKSTATION_ACCESS_CLOCK_INVALID");
    return at;
  };
  function publicWorkstation(workstation, at = nowMs()) {
    const seen = heartbeats.get(workstation.workstationId) ?? null;
    return { workstationId: workstation.workstationId, name: workstation.name, addedAt: workstation.createdAt,
      online: seen !== null && at - seen.receivedAtMs <= heartbeatTtlMs,
      lastSeenAt: seen === null ? null : new Date(seen.receivedAtMs).toISOString(), extensionVersion: seen?.version ?? null };
  }
  return Object.freeze({
    boundaryType: "workstation_access",
    maxActive,
    async initialize() { await store.ensureSchema(); },
    async list() {
      const at = nowMs();
      return (await store.list()).map(workstation => publicWorkstation(workstation, at));
    },
    /** The key is in this answer only: the page hands it straight to the plugin on the same computer. */
    async add({ actor, name }) {
      const normalized = normalizeWorkstationName(name);
      if (normalized === null) throw failure(400, "WORKSTATION_NAME_INVALID", "给这台电脑起个名字，1 到 40 个字");
      if (typeof actor?.userId !== "string" || actor.userId === "") throw failure(401, "OWNER_LOGIN_REQUIRED", "请先登录");
      const key = newKey();
      if (!isWorkstationKey(key)) throw new Error("WORKSTATION_KEY_INVALID");
      try {
        const workstation = await store.create({ workstationId: newId(), name: normalized, keyDigest: workstationKeyDigest(key),
          addedBy: actor.userId }, { maxActive });
        return { workstation: publicWorkstation(workstation), key };
      } catch (error) {
        if (error?.code === "WORKSTATION_LIMIT_REACHED") {
          throw failure(409, "WORKSTATION_LIMIT_REACHED", `最多加 ${maxActive} 台电脑，先移除用不着的再加`);
        }
        throw error;
      }
    },
    async remove({ workstationId }) {
      if (!isWorkstationId(workstationId)) throw failure(400, "WORKSTATION_INPUT_INVALID", "要移除哪台电脑没说清楚");
      try {
        const removed = await store.remove(workstationId);
        heartbeats.delete(workstationId);
        return publicWorkstation(removed);
      } catch (error) {
        if (error?.code === "WORKSTATION_NOT_FOUND") throw failure(404, "WORKSTATION_NOT_FOUND", "这台电脑不在名单上，可能已经移除了");
        throw error;
      }
    },
    /** Which computer sent this plugin call; refused (401) without a key, or with one that is wrong or removed. */
    async authenticate(request) {
      const key = presentedWorkstationKey(request);
      if (key === null) throw failure(401, "WORKSTATION_KEY_REQUIRED", "这台电脑还没加进来，插件没有带钥匙");
      const workstation = await store.findActiveByKeyDigest(workstationKeyDigest(key));
      if (workstation === null) throw failure(401, "WORKSTATION_KEY_REJECTED", "这台电脑的钥匙不对，或者这台电脑已经移除了");
      return Object.freeze({ workstationId: workstation.workstationId, name: workstation.name });
    },
    recordHeartbeat(workstationId, { version }) {
      if (!isWorkstationId(workstationId)) throw new Error("WORKSTATION_INPUT_INVALID");
      heartbeats.set(workstationId, { version: typeof version === "string" ? version : null, receivedAtMs: nowMs() });
    }
  });
}

/** Only with team accounts, which already keep their table in Postgres; the address comes from the environment, like theirs. */
export function createConfiguredWorkstationAccess({ configuration, env = process.env, store = null, clock } = {}) {
  if (configuration?.identityProvider !== "team_accounts" || configuration.stateAdapter !== "postgres") return null;
  return createWorkstationAccess({ clock,
    store: store ?? createPostgresWorkstationStore({ connectionString: String(env?.SELECTION_REVIEW_DATABASE_URL ?? "").trim() }) });
}
