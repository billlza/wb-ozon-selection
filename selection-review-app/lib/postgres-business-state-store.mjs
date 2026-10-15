// Postgres storage for the business state document: the same document the JSON adapter keeps in candidates.json,
// stored as one row. The `json` column keeps the text exactly as written (key order included), so revision hashes and
// production entity fingerprints read back unchanged.
export const BUSINESS_STATE_TABLE = "selection_review_business_state";
export const BUSINESS_STATE_DOCUMENT_ID = "business-state";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${BUSINESS_STATE_TABLE} (
  document_id text PRIMARY KEY,
  document json NOT NULL,
  revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
// Two processes creating the table at the same moment: the loser sees a duplicate type or table, and the table exists.
const SCHEMA_RACE_CODES = new Set(["23505", "42P07"]);

export function isPostgresConnectionString(value) {
  return typeof value === "string" && /^postgres(?:ql)?:\/\/\S+$/u.test(value);
}

function validDocumentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

/**
 * `pool` is a pg.Pool (or anything with the same query/connect/end). Without one, `connectionString` creates a pool on
 * first use; pg is only loaded then, so the local JSON runtime never loads the driver.
 */
export function createPostgresBusinessStateStore({ pool = null, connectionString = null, documentId = BUSINESS_STATE_DOCUMENT_ID,
  maxConnections = 5 } = {}) {
  if (pool === null && !isPostgresConnectionString(connectionString)) throw new Error("POSTGRES_BUSINESS_STATE_CONNECTION_REQUIRED");
  if (pool !== null && (typeof pool.query !== "function" || typeof pool.connect !== "function")) {
    throw new Error("POSTGRES_BUSINESS_STATE_POOL_INVALID");
  }
  if (!validDocumentId(documentId)) throw new Error("POSTGRES_BUSINESS_STATE_DOCUMENT_ID_INVALID");
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
    throw new Error("POSTGRES_BUSINESS_STATE_POOL_SIZE_INVALID");
  }
  let poolReady = pool === null ? null : Promise.resolve(pool);
  let schemaReady = null;

  function connectedPool() {
    poolReady ??= import("pg").then(({ default: pg }) => {
      const created = new pg.Pool({ connectionString, max: maxConnections, connectionTimeoutMillis: 10_000 });
      // An idle connection dropped by the server (restart, failover) must not crash the service; the next query
      // simply opens a new one. Only the error code is logged: messages can carry the database host.
      created.on("error", error => console.error(`POSTGRES_IDLE_CONNECTION_FAILED:${error?.code ?? "unknown"}`));
      return created;
    });
    return poolReady;
  }

  function ensureSchema() {
    schemaReady ??= connectedPool()
      .then(activePool => activePool.query(CREATE_TABLE))
      .catch(error => {
        if (SCHEMA_RACE_CODES.has(error?.code)) return;
        schemaReady = null;
        throw error;
      });
    return schemaReady;
  }

  async function selectForUpdate(client) {
    const { rows } = await client.query(
      `SELECT document, revision::text AS revision FROM ${BUSINESS_STATE_TABLE} WHERE document_id = $1 FOR UPDATE`,
      [documentId]);
    return rows[0] ?? null;
  }

  return Object.freeze({
    documentId,
    /** One unlocked read. When `knownRevision` is still current the document is not sent again. */
    async readDocument({ knownRevision = null } = {}) {
      await ensureSchema();
      const activePool = await connectedPool();
      const { rows } = await activePool.query(
        `SELECT revision::text AS revision, CASE WHEN revision::text = $2 THEN NULL ELSE document END AS document
         FROM ${BUSINESS_STATE_TABLE} WHERE document_id = $1`,
        [documentId, knownRevision]);
      if (rows.length === 0) return null;
      return rows[0].document === null ? { revision: rows[0].revision } : { revision: rows[0].revision, document: rows[0].document };
    },
    /**
     * Runs `work` inside one transaction holding the row lock. `work` gets the stored document and `replace(document)`;
     * a replaced document is written once, at the end, and committed with the lock released. Any error rolls back.
     * With `initialDocument`, a missing row starts from it; nothing is kept if `work` does not replace it.
     */
    async runLocked({ initialDocument = null } = {}, work) {
      if (typeof work !== "function") throw new Error("POSTGRES_BUSINESS_STATE_WORK_REQUIRED");
      await ensureSchema();
      const client = await (await connectedPool()).connect();
      let releaseError;
      try {
        await client.query("BEGIN");
        let row = await selectForUpdate(client);
        let inserted = false;
        if (row === null) {
          if (typeof initialDocument !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
          const insert = await client.query(
            `INSERT INTO ${BUSINESS_STATE_TABLE} (document_id, document, revision) VALUES ($1, $2::json, 1)
             ON CONFLICT (document_id) DO NOTHING`,
            [documentId, JSON.stringify(initialDocument())]);
          inserted = insert.rowCount === 1;
          row = await selectForUpdate(client);
          if (row === null) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
        }
        let replacement = null;
        const result = await work({ document: row.document, replace(document) { replacement = document; } });
        if (replacement !== null) {
          await client.query(
            `UPDATE ${BUSINESS_STATE_TABLE} SET document = $2::json, revision = revision + 1, updated_at = now()
             WHERE document_id = $1`,
            [documentId, JSON.stringify(replacement)]);
        }
        await client.query(replacement === null && inserted ? "ROLLBACK" : "COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { releaseError = rollbackError; }
        throw error;
      } finally {
        // A connection whose rollback failed is closed instead of going back to the pool mid-transaction.
        client.release(releaseError);
      }
    },
    /** Read-only look at the target, for the import dry run: creates nothing. */
    async inspect() {
      const activePool = await connectedPool();
      const { rows: [table] } = await activePool.query("SELECT to_regclass($1) IS NOT NULL AS exists", [BUSINESS_STATE_TABLE]);
      if (!table.exists) return { tableExists: false, revision: null };
      const { rows } = await activePool.query(
        `SELECT revision::text AS revision FROM ${BUSINESS_STATE_TABLE} WHERE document_id = $1`, [documentId]);
      return { tableExists: true, revision: rows[0]?.revision ?? null };
    },
    /**
     * Writes `document` as the first revision only when no row exists yet; never overwrites. `verify` sees the row as
     * stored before commit, and anything it throws rolls the insert back. Returns false when a row already exists.
     */
    async insertDocument(document, { verify = async () => {} } = {}) {
      if (document === null || typeof document !== "object" || Array.isArray(document)) {
        throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      }
      await ensureSchema();
      const client = await (await connectedPool()).connect();
      let releaseError;
      try {
        await client.query("BEGIN");
        const insert = await client.query(
          `INSERT INTO ${BUSINESS_STATE_TABLE} (document_id, document, revision) VALUES ($1, $2::json, 1)
           ON CONFLICT (document_id) DO NOTHING`,
          [documentId, JSON.stringify(document)]);
        if (insert.rowCount !== 1) {
          await client.query("ROLLBACK");
          return false;
        }
        await verify((await selectForUpdate(client)).document);
        await client.query("COMMIT");
        return true;
      } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { releaseError = rollbackError; }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
    async close() {
      if (poolReady === null) return;
      const activePool = await poolReady;
      if (typeof activePool.end === "function") await activePool.end();
    }
  });
}
