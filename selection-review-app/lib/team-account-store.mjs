import { isPasswordVerifier } from "./scrypt-verifier.mjs";
import { isPostgresConnectionString } from "./postgres-business-state-store.mjs";
import { isTeamUserId } from "./runtime-identity.mjs";

export { isTeamUserId };

// The team's sign-in accounts: who may log in, under which name, with which role. They live in their own table, never in
// the business state document or its public views; a password is kept only as its verifier. Accounts are created from
// the command line (scripts/manage-team-accounts.mjs), never from the web page.
export const TEAM_ACCOUNT_TABLE = "selection_review_accounts";
export const TEAM_ACCOUNT_ROLES = Object.freeze(["boss", "tester"]);
export const TEAM_ACCOUNT_STATUSES = Object.freeze(["active", "disabled"]);

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TEAM_ACCOUNT_TABLE} (
  user_id text PRIMARY KEY,
  login_name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  credential_revision integer NOT NULL,
  verifier json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
const SCHEMA_RACE_CODES = new Set(["23505", "42P07"]);
const UNIQUE_VIOLATION = "23505";
const COLUMNS = "user_id, login_name, display_name, role, status, credential_revision, verifier, created_at, updated_at";

export class TeamAccountStoreError extends Error {
  constructor(code) { super(code); this.name = "TeamAccountStoreError"; this.code = code; }
}

/** Login names are case-insensitive: they are kept and looked up in lower case. */
export function normalizeLoginName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,31}$/u.test(name) ? name : null;
}

export function normalizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && [...name].length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function validAccount(account) {
  return account !== null && typeof account === "object" && isTeamUserId(account.userId) &&
    normalizeLoginName(account.loginName) === account.loginName && normalizeDisplayName(account.displayName) === account.displayName &&
    TEAM_ACCOUNT_ROLES.includes(account.role) && TEAM_ACCOUNT_STATUSES.includes(account.status) &&
    Number.isSafeInteger(account.credentialRevision) && account.credentialRevision >= 1 && isPasswordVerifier(account.verifier);
}

function fromRow(row) {
  const account = {
    userId: row.user_id, loginName: row.login_name, displayName: row.display_name, role: row.role, status: row.status,
    credentialRevision: Number(row.credential_revision), verifier: row.verifier,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
  if (!validAccount(account)) throw new TeamAccountStoreError("TEAM_ACCOUNT_RECORD_INVALID");
  return account;
}

/** What the account list shows: never the verifier. */
export function publicTeamAccount(account) {
  return { userId: account.userId, loginName: account.loginName, displayName: account.displayName, role: account.role,
    status: account.status, createdAt: account.createdAt, updatedAt: account.updatedAt };
}

function newAccount(input) {
  const account = { userId: input?.userId, loginName: normalizeLoginName(input?.loginName), displayName: normalizeDisplayName(input?.displayName),
    role: input?.role, status: "active", credentialRevision: 1, verifier: input?.verifier };
  if (!validAccount(account)) throw new TeamAccountStoreError("TEAM_ACCOUNT_INPUT_INVALID");
  return account;
}

function checkedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TeamAccountStoreError("TEAM_ACCOUNT_INPUT_INVALID");
  return value;
}

/**
 * Accounts in Postgres. `pool` is a pg.Pool (or anything with the same query/end); without one, `connectionString` makes a
 * small pool on first use. Every change bumps the account's credential revision, which ends the sessions signed in before.
 */
export function createPostgresTeamAccountStore({ pool = null, connectionString = null, maxConnections = 2 } = {}) {
  if (pool === null && !isPostgresConnectionString(connectionString)) throw new TeamAccountStoreError("TEAM_ACCOUNT_DATABASE_URL_REQUIRED");
  if (pool !== null && typeof pool.query !== "function") throw new TeamAccountStoreError("TEAM_ACCOUNT_POOL_INVALID");
  let poolReady = pool === null ? null : Promise.resolve(pool);
  let schemaReady = null;
  function connectedPool() {
    poolReady ??= import("pg").then(({ default: pg }) => {
      const created = new pg.Pool({ connectionString, max: maxConnections, connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000, query_timeout: 20_000 });
      // Only the code is logged: driver messages can carry the database host.
      created.on("error", error => console.error(`TEAM_ACCOUNT_IDLE_CONNECTION_FAILED:${error?.code ?? "unknown"}`));
      return created;
    });
    return poolReady;
  }
  async function query(text, params = []) {
    schemaReady ??= connectedPool().then(async activePool => {
      try { await activePool.query(SCHEMA); }
      catch (error) { if (!SCHEMA_RACE_CODES.has(error?.code)) throw error; }
    }).catch(error => { schemaReady = null; throw error; });
    await schemaReady;
    return (await connectedPool()).query(text, params);
  }
  async function changed(text, params) {
    const { rows } = await query(text, params);
    if (rows.length !== 1) throw new TeamAccountStoreError("TEAM_ACCOUNT_CHANGED");
    return fromRow(rows[0]);
  }
  return Object.freeze({
    boundaryType: "team_account_store",
    async ensureSchema() { await query("SELECT 1"); },
    async findByLoginName(loginName) {
      const name = normalizeLoginName(loginName);
      if (name === null) return null;
      const { rows } = await query(`SELECT ${COLUMNS} FROM ${TEAM_ACCOUNT_TABLE} WHERE login_name = $1`, [name]);
      return rows.length === 1 ? fromRow(rows[0]) : null;
    },
    async findByUserId(userId) {
      if (!isTeamUserId(userId)) return null;
      const { rows } = await query(`SELECT ${COLUMNS} FROM ${TEAM_ACCOUNT_TABLE} WHERE user_id = $1`, [userId]);
      return rows.length === 1 ? fromRow(rows[0]) : null;
    },
    async list() {
      const { rows } = await query(`SELECT ${COLUMNS} FROM ${TEAM_ACCOUNT_TABLE} ORDER BY created_at, login_name`);
      return rows.map(fromRow);
    },
    async create(input) {
      const account = newAccount(input);
      try {
        return await changed(`INSERT INTO ${TEAM_ACCOUNT_TABLE} (user_id, login_name, display_name, role, status, credential_revision, verifier)
          VALUES ($1, $2, $3, $4, $5, $6, $7::json) RETURNING ${COLUMNS}`,
        [account.userId, account.loginName, account.displayName, account.role, account.status, account.credentialRevision,
          JSON.stringify(account.verifier)]);
      } catch (error) {
        if (error?.code === UNIQUE_VIOLATION) throw new TeamAccountStoreError("TEAM_ACCOUNT_ALREADY_EXISTS");
        throw error;
      }
    },
    /** Only when the account is still at `expectedRevision`; otherwise TEAM_ACCOUNT_CHANGED and nothing is written. */
    setPassword({ userId, verifier, expectedRevision }) {
      if (!isTeamUserId(userId) || !isPasswordVerifier(verifier)) throw new TeamAccountStoreError("TEAM_ACCOUNT_INPUT_INVALID");
      return changed(`UPDATE ${TEAM_ACCOUNT_TABLE} SET verifier = $2::json, credential_revision = credential_revision + 1, updated_at = now()
        WHERE user_id = $1 AND credential_revision = $3 RETURNING ${COLUMNS}`, [userId, JSON.stringify(verifier), checkedRevision(expectedRevision)]);
    },
    setStatus({ userId, status, expectedRevision }) {
      if (!isTeamUserId(userId) || !TEAM_ACCOUNT_STATUSES.includes(status)) throw new TeamAccountStoreError("TEAM_ACCOUNT_INPUT_INVALID");
      return changed(`UPDATE ${TEAM_ACCOUNT_TABLE} SET status = $2, credential_revision = credential_revision + 1, updated_at = now()
        WHERE user_id = $1 AND credential_revision = $3 RETURNING ${COLUMNS}`, [userId, status, checkedRevision(expectedRevision)]);
    },
    async close() {
      if (poolReady === null) return;
      const activePool = await poolReady;
      if (typeof activePool.end === "function") await activePool.end();
    }
  });
}

/** The same store in memory, for tests. */
export function createMemoryTeamAccountStore({ clock = () => new Date().toISOString() } = {}) {
  const accounts = new Map();
  const copy = account => account && structuredClone(account);
  function update(userId, expectedRevision, change) {
    const current = accounts.get(userId);
    if (!current || current.credentialRevision !== checkedRevision(expectedRevision)) throw new TeamAccountStoreError("TEAM_ACCOUNT_CHANGED");
    const next = { ...current, ...change, credentialRevision: current.credentialRevision + 1, updatedAt: clock() };
    accounts.set(userId, next);
    return copy(next);
  }
  return Object.freeze({
    boundaryType: "team_account_store",
    async ensureSchema() {},
    async findByLoginName(loginName) {
      const name = normalizeLoginName(loginName);
      return copy([...accounts.values()].find(account => account.loginName === name) ?? null);
    },
    async findByUserId(userId) { return copy(accounts.get(userId) ?? null); },
    async list() { return [...accounts.values()].map(copy); },
    async create(input) {
      const account = newAccount(input);
      if (accounts.has(account.userId) || [...accounts.values()].some(other => other.loginName === account.loginName)) {
        throw new TeamAccountStoreError("TEAM_ACCOUNT_ALREADY_EXISTS");
      }
      const at = clock();
      accounts.set(account.userId, { ...account, createdAt: at, updatedAt: at });
      return copy(accounts.get(account.userId));
    },
    async setPassword({ userId, verifier, expectedRevision }) {
      if (!isPasswordVerifier(verifier)) throw new TeamAccountStoreError("TEAM_ACCOUNT_INPUT_INVALID");
      return update(userId, expectedRevision, { verifier: structuredClone(verifier) });
    },
    async setStatus({ userId, status, expectedRevision }) {
      if (!TEAM_ACCOUNT_STATUSES.includes(status)) throw new TeamAccountStoreError("TEAM_ACCOUNT_INPUT_INVALID");
      return update(userId, expectedRevision, { status });
    },
    async close() {}
  });
}
