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
// Every statement has a deadline, so one stuck write cannot hold the write queue forever: the server cancels a lock wait
// or a statement that runs too long, ends a transaction left idle, and the client gives up on a connection that stops
// answering (a dropped network never answers at all). The client deadline is the longest so the server normally answers
// first and the connection stays usable.
export const POSTGRES_BUSINESS_STATE_TIMEOUTS = Object.freeze({ lockMs: 15_000, statementMs: 30_000, queryMs: 40_000,
  idleInTransactionMs: 120_000 });
// pg's message when the client deadline passes; the statement may still be running, so the connection is closed instead of
// queueing a ROLLBACK behind it.
const CLIENT_DEADLINE_MESSAGE = "Query read timeout";
// Advisory lock class for the one-service-process lease; the key within it is the schema and document id.
const PROCESS_LEASE_LOCK_CLASS = 1_397_904_945;
const PROCESS_LEASE_KEY = "hashtext(current_schema() || ':' || $2)";
// pg-pool listens for errors only while a connection is idle in the pool. A checked-out connection that drops between
// statements emits 'error' by itself, which would end the process without a listener; the next statement fails instead.
const ignoreCheckedOutError = () => {};

export function isPostgresConnectionString(value) {
  return typeof value === "string" && /^postgres(?:ql)?:\/\/\S+$/u.test(value);
}

function validDocumentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function validTimeouts(value) {
  const keys = ["lockMs", "statementMs", "queryMs", "idleInTransactionMs"];
  return value !== null && typeof value === "object" && Object.keys(value).length === keys.length &&
    keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 1 && value[key] <= 600_000) &&
    value.lockMs < value.statementMs && value.statementMs < value.queryMs;
}

/**
 * `pool` is a pg.Pool (or anything with the same query/connect/end). Without one, `connectionString` creates a pool on
 * first use; pg is only loaded then, so the local JSON runtime never loads the driver.
 */
export function createPostgresBusinessStateStore({ pool = null, connectionString = null, documentId = BUSINESS_STATE_DOCUMENT_ID,
  maxConnections = 5, timeouts = POSTGRES_BUSINESS_STATE_TIMEOUTS } = {}) {
  if (pool === null && !isPostgresConnectionString(connectionString)) throw new Error("POSTGRES_BUSINESS_STATE_CONNECTION_REQUIRED");
  if (pool !== null && (typeof pool.query !== "function" || typeof pool.connect !== "function")) {
    throw new Error("POSTGRES_BUSINESS_STATE_POOL_INVALID");
  }
  if (!validDocumentId(documentId)) throw new Error("POSTGRES_BUSINESS_STATE_DOCUMENT_ID_INVALID");
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
    throw new Error("POSTGRES_BUSINESS_STATE_POOL_SIZE_INVALID");
  }
  if (!validTimeouts(timeouts)) throw new Error("POSTGRES_BUSINESS_STATE_TIMEOUTS_INVALID");
  let poolReady = pool === null ? null : Promise.resolve(pool);
  let schemaReady = null;
  // Set once this store takes the process lease. From then on a write goes through only while the lease is held: the
  // flag drops as soon as the lease connection ends, and under the row lock the database confirms the lease session
  // still holds it, so a process that lost its lease cannot write after another process took over.
  let lease = null;

  function connectedPool() {
    poolReady ??= import("pg").then(({ default: pg }) => {
      const created = new pg.Pool({ connectionString, max: maxConnections, connectionTimeoutMillis: 10_000,
        lock_timeout: timeouts.lockMs, statement_timeout: timeouts.statementMs, query_timeout: timeouts.queryMs,
        idle_in_transaction_session_timeout: timeouts.idleInTransactionMs });
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

  async function checkOut() {
    const client = await (await connectedPool()).connect();
    client.on?.("error", ignoreCheckedOutError);
    return {
      client,
      release(error) {
        client.removeListener?.("error", ignoreCheckedOutError);
        client.release(error);
      }
    };
  }

  async function assertLeaseHeld(client) {
    if (lease === null) return;
    if (lease.held) {
      const { rows: [{ held }] } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = $3 AND objsubid = 2
           AND classid = $1::integer::oid AND objid = (${PROCESS_LEASE_KEY}::bigint & 4294967295)::oid) AS held`,
        [PROCESS_LEASE_LOCK_CLASS, documentId, lease.pid]);
      if (held) return;
      lease.held = false;
    }
    throw new Error("BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST");
  }

  async function selectForUpdate(client) {
    const { rows } = await client.query(
      `SELECT document, revision::text AS revision FROM ${BUSINESS_STATE_TABLE} WHERE document_id = $1 FOR UPDATE`,
      [documentId]);
    return rows[0] ?? null;
  }

  // Ends a failed transaction: ROLLBACK while the connection still answers; otherwise the connection is closed, which
  // aborts the transaction on the server. Returns the error to release the connection with.
  async function abandon(client, error) {
    if (error?.message === CLIENT_DEADLINE_MESSAGE) return error;
    try {
      await client.query("ROLLBACK");
      return undefined;
    } catch (rollbackError) {
      return rollbackError;
    }
  }

  // The COMMIT was sent but its answer never came, so the write may have landed. Reporting a saved write as failed would
  // invite the user to repeat it, so the row decides: ours (the next revision with exactly our text) means saved, the
  // revision we locked means not saved, anything else cannot be told apart and is reported as unknown.
  async function settleLostCommit({ before, after, text }, failure, result) {
    let row;
    try {
      // FOR SHARE waits for a transaction still holding the row, so a COMMIT still in flight is seen as landed or not.
      const { rows } = await (await connectedPool()).query(
        `SELECT revision::text AS revision, document::text AS text FROM ${BUSINESS_STATE_TABLE} WHERE document_id = $1 FOR SHARE`,
        [documentId]);
      row = rows[0] ?? null;
    } catch {
      row = undefined;
    }
    if (row && row.revision === after && row.text === text) return result;
    if (row !== undefined && (row === null ? before === null : row.revision === before)) throw failure;
    throw new Error("BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN", { cause: failure });
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
     * a replaced document is written once, at the end, and committed with the lock released. Any error rolls back; when
     * only the COMMIT's answer is lost, the row says whether the write landed. With `initialDocument`, a missing row starts
     * from it; nothing is kept if `work` does not replace it.
     */
    async runLocked({ initialDocument = null } = {}, work) {
      if (typeof work !== "function") throw new Error("POSTGRES_BUSINESS_STATE_WORK_REQUIRED");
      if (lease !== null && !lease.held) throw new Error("BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST");
      await ensureSchema();
      const connection = await checkOut();
      const { client } = connection;
      let releaseError, result, pendingCommit = null, commitFailure;
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
        await assertLeaseHeld(client);
        let replacement = null;
        result = await work({ document: row.document, replace(document) { replacement = document; } });
        if (replacement === null) {
          await client.query(inserted ? "ROLLBACK" : "COMMIT");
          return result;
        }
        const text = JSON.stringify(replacement);
        await client.query(
          `UPDATE ${BUSINESS_STATE_TABLE} SET document = $2::json, revision = revision + 1, updated_at = now()
           WHERE document_id = $1`,
          [documentId, text]);
        pendingCommit = { before: inserted ? null : row.revision, after: String(BigInt(row.revision) + 1n), text };
        await client.query("COMMIT");
        return result;
      } catch (error) {
        releaseError = await abandon(client, error);
        if (pendingCommit === null) throw error;
        commitFailure = error;
      } finally {
        // A connection whose rollback failed or timed out is closed instead of going back to the pool mid-transaction.
        connection.release(releaseError);
      }
      return settleLostCommit(pendingCommit, commitFailure, result);
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
      const connection = await checkOut();
      const { client } = connection;
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
        releaseError = await abandon(client, error);
        throw error;
      } finally {
        connection.release(releaseError);
      }
    },
    /**
     * Holds the document for one service process: a session advisory lock on a connection kept for the life of the
     * process. Returns null while another process holds it. The lock lives only as long as that connection, so `onLost`
     * is called if the connection ends before `release()`. Once the lease ends, this store refuses every further write.
     */
    async acquireProcessLease({ onLost } = {}) {
      if (typeof onLost !== "function") throw new Error("POSTGRES_BUSINESS_STATE_LEASE_LOST_HANDLER_REQUIRED");
      if (lease !== null) throw new Error("POSTGRES_BUSINESS_STATE_LEASE_ALREADY_TAKEN");
      const client = await (await connectedPool()).connect();
      let state = "acquiring";
      const detach = () => {
        client.removeListener("error", ended);
        client.removeListener("end", ended);
      };
      function ended() {
        if (state === "ended") return;
        const wasHeld = state === "held";
        state = "ended";
        detach();
        client.release(new Error("POSTGRES_PROCESS_LEASE_CONNECTION_ENDED"));
        if (!wasHeld) return;
        lease.held = false;
        onLost();
      }
      client.on("error", ended);
      client.on("end", ended);
      let acquired, pid;
      try {
        ({ rows: [{ acquired, pid }] } = await client.query(
          `SELECT pg_try_advisory_lock($1, ${PROCESS_LEASE_KEY}) AS acquired, pg_backend_pid() AS pid`,
          [PROCESS_LEASE_LOCK_CLASS, documentId]));
      } catch (error) {
        if (state !== "ended") {
          state = "ended";
          detach();
          client.release(error);
        }
        throw error;
      }
      if (state === "ended") throw new Error("POSTGRES_PROCESS_LEASE_CONNECTION_ENDED");
      if (!acquired) {
        state = "ended";
        detach();
        client.release();
        return null;
      }
      state = "held";
      lease = { pid, held: true };
      return Object.freeze({
        async release() {
          if (state !== "held") return;
          state = "ended";
          lease.held = false;
          detach();
          let unlockError;
          try {
            await client.query(`SELECT pg_advisory_unlock($1, ${PROCESS_LEASE_KEY})`, [PROCESS_LEASE_LOCK_CLASS, documentId]);
          } catch (error) {
            unlockError = error;
          }
          // A failed unlock closes the connection, which drops the lock all the same.
          client.release(unlockError);
        }
      });
    },
    async close() {
      if (poolReady === null) return;
      const activePool = await poolReady;
      if (typeof activePool.end === "function") await activePool.end();
    }
  });
}
