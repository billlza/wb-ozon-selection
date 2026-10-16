import { isPostgresConnectionString } from "./postgres-business-state-store.mjs";

// The computers whose plugin works for the team (AGENTS 0A: a worker has a stable id and is known to the central service).
// Each one holds its own key; only the key's SHA-256 digest is kept here, in its own table next to the team accounts, never
// in the business state document. A computer is added from the web page by whoever is signed in at it, and removed there.
export const WORKSTATION_TABLE = "selection_review_workstations";
export const WORKSTATION_STATUSES = Object.freeze(["active", "removed"]);

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${WORKSTATION_TABLE} (
  workstation_id text PRIMARY KEY,
  name text NOT NULL,
  key_digest text NOT NULL UNIQUE,
  status text NOT NULL,
  added_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
const SCHEMA_RACE_CODES = new Set(["23505", "42P07"]);
const UNIQUE_VIOLATION = "23505";
const COLUMNS = "workstation_id, name, key_digest, status, added_by, created_at, updated_at";
const WORKSTATION_ID = /^workstation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_DIGEST = /^[0-9a-f]{64}$/u;

export class WorkstationStoreError extends Error {
  constructor(code) { super(code); this.name = "WorkstationStoreError"; this.code = code; }
}

export function isWorkstationId(value) {
  return typeof value === "string" && WORKSTATION_ID.test(value);
}

/** What the person calls this computer, e.g. 「老板甲的 MacBook」. */
export function normalizeWorkstationName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && [...name].length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function validWorkstation(workstation) {
  return workstation !== null && typeof workstation === "object" && isWorkstationId(workstation.workstationId) &&
    normalizeWorkstationName(workstation.name) === workstation.name && KEY_DIGEST.test(workstation.keyDigest ?? "") &&
    WORKSTATION_STATUSES.includes(workstation.status) && typeof workstation.addedBy === "string" && workstation.addedBy.length > 0;
}

function fromRow(row) {
  const workstation = { workstationId: row.workstation_id, name: row.name, keyDigest: row.key_digest, status: row.status,
    addedBy: row.added_by, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  if (!validWorkstation(workstation)) throw new WorkstationStoreError("WORKSTATION_RECORD_INVALID");
  return workstation;
}

function newWorkstation(input) {
  const workstation = { workstationId: input?.workstationId, name: normalizeWorkstationName(input?.name), keyDigest: input?.keyDigest,
    status: "active", addedBy: input?.addedBy };
  if (!validWorkstation(workstation)) throw new WorkstationStoreError("WORKSTATION_INPUT_INVALID");
  return workstation;
}

/** In Postgres, like the team accounts: `pool` or a `connectionString` for a small pool made on first use. */
export function createPostgresWorkstationStore({ pool = null, connectionString = null, maxConnections = 2 } = {}) {
  if (pool === null && !isPostgresConnectionString(connectionString)) throw new WorkstationStoreError("WORKSTATION_DATABASE_URL_REQUIRED");
  if (pool !== null && typeof pool.query !== "function") throw new WorkstationStoreError("WORKSTATION_POOL_INVALID");
  let poolReady = pool === null ? null : Promise.resolve(pool);
  let schemaReady = null;
  function connectedPool() {
    poolReady ??= import("pg").then(({ default: pg }) => {
      const created = new pg.Pool({ connectionString, max: maxConnections, connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000, query_timeout: 20_000 });
      // Only the code is logged: driver messages can carry the database host.
      created.on("error", error => console.error(`WORKSTATION_IDLE_CONNECTION_FAILED:${error?.code ?? "unknown"}`));
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
  return Object.freeze({
    boundaryType: "workstation_store",
    async ensureSchema() { await query("SELECT 1"); },
    async findActiveByKeyDigest(keyDigest) {
      if (!KEY_DIGEST.test(keyDigest ?? "")) return null;
      const { rows } = await query(`SELECT ${COLUMNS} FROM ${WORKSTATION_TABLE} WHERE key_digest = $1 AND status = 'active'`, [keyDigest]);
      return rows.length === 1 ? fromRow(rows[0]) : null;
    },
    async list() {
      const { rows } = await query(`SELECT ${COLUMNS} FROM ${WORKSTATION_TABLE} WHERE status = 'active' ORDER BY created_at, workstation_id`);
      return rows.map(fromRow);
    },
    /** Adds the computer while fewer than `maxActive` are in use: a cap against runaway additions, not an exact count. */
    async create(input, { maxActive }) {
      const workstation = newWorkstation(input);
      if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new WorkstationStoreError("WORKSTATION_INPUT_INVALID");
      let rows;
      try {
        ({ rows } = await query(`INSERT INTO ${WORKSTATION_TABLE} (workstation_id, name, key_digest, status, added_by)
          SELECT $1, $2, $3, $4, $5 WHERE (SELECT count(*) FROM ${WORKSTATION_TABLE} WHERE status = 'active') < $6
          RETURNING ${COLUMNS}`, [workstation.workstationId, workstation.name, workstation.keyDigest, workstation.status,
          workstation.addedBy, maxActive]));
      } catch (error) {
        if (error?.code === UNIQUE_VIOLATION) throw new WorkstationStoreError("WORKSTATION_ALREADY_EXISTS");
        throw error;
      }
      if (rows.length !== 1) throw new WorkstationStoreError("WORKSTATION_LIMIT_REACHED");
      return fromRow(rows[0]);
    },
    /** A removed computer's key stops working at once; the row stays, so the id is never handed out again. */
    async remove(workstationId) {
      if (!isWorkstationId(workstationId)) throw new WorkstationStoreError("WORKSTATION_INPUT_INVALID");
      const { rows } = await query(`UPDATE ${WORKSTATION_TABLE} SET status = 'removed', updated_at = now()
        WHERE workstation_id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [workstationId]);
      if (rows.length !== 1) throw new WorkstationStoreError("WORKSTATION_NOT_FOUND");
      return fromRow(rows[0]);
    },
    async close() {
      if (poolReady === null) return;
      const activePool = await poolReady;
      if (typeof activePool.end === "function") await activePool.end();
    }
  });
}

/** The same store in memory, for tests. */
export function createMemoryWorkstationStore({ clock = () => new Date().toISOString() } = {}) {
  const workstations = new Map();
  const copy = workstation => workstation && structuredClone(workstation);
  const active = () => [...workstations.values()].filter(workstation => workstation.status === "active");
  return Object.freeze({
    boundaryType: "workstation_store",
    async ensureSchema() {},
    async findActiveByKeyDigest(keyDigest) {
      return copy(active().find(workstation => workstation.keyDigest === keyDigest) ?? null);
    },
    async list() { return active().map(copy); },
    async create(input, { maxActive }) {
      const workstation = newWorkstation(input);
      if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new WorkstationStoreError("WORKSTATION_INPUT_INVALID");
      if (workstations.has(workstation.workstationId) || [...workstations.values()].some(other => other.keyDigest === workstation.keyDigest)) {
        throw new WorkstationStoreError("WORKSTATION_ALREADY_EXISTS");
      }
      if (active().length >= maxActive) throw new WorkstationStoreError("WORKSTATION_LIMIT_REACHED");
      const at = clock();
      workstations.set(workstation.workstationId, { ...workstation, createdAt: at, updatedAt: at });
      return copy(workstations.get(workstation.workstationId));
    },
    async remove(workstationId) {
      const current = workstations.get(workstationId);
      if (!current || current.status !== "active") throw new WorkstationStoreError("WORKSTATION_NOT_FOUND");
      workstations.set(workstationId, { ...current, status: "removed", updatedAt: clock() });
      return copy(workstations.get(workstationId));
    },
    async close() {}
  });
}
