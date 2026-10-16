import { assembleBusinessState, decodeCandidatePart, decodeSharedPart, encodeCandidatePart, encodeSharedPart,
  longestPartitionedCollection, partitionKeys, sharedPartitionKeys, splitBusinessState } from "./business-state-partitions.mjs";

// Postgres storage for the business state document: the same document the JSON adapter keeps in candidates.json, cut by
// lib/business-state-partitions.mjs into one shared row and one row per candidate. The `json` columns keep the text
// exactly as written (key order included), so revision hashes and production entity fingerprints read back unchanged.
// A third table holds the identities the domain treats as unique across the document (idempotency keys, job ids…) with
// the one candidate that owns each, so a transaction that only loads its own candidates still cannot reuse one.
export const BUSINESS_STATE_SHARED_TABLE = "selection_review_state_shared";
export const BUSINESS_STATE_CANDIDATE_TABLE = "selection_review_state_candidates";
export const BUSINESS_STATE_KEY_TABLE = "selection_review_state_keys";
export const BUSINESS_STATE_DOCUMENT_ID = "business-state";
// Every row write takes its revision from one sequence, so a revision never comes back for different text, even when a
// candidate's row is removed and made again. Record positions come from another sequence (see the partitions module).
const REVISION_SEQUENCE = "selection_review_state_revision_seq";
const POSITION_SEQUENCE = "selection_review_state_position_seq";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${BUSINESS_STATE_SHARED_TABLE} (
    document_id text PRIMARY KEY,
    shared json NOT NULL,
    revision bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS ${BUSINESS_STATE_CANDIDATE_TABLE} (
    document_id text NOT NULL,
    candidate_id text NOT NULL,
    part json NOT NULL,
    revision bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, candidate_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${BUSINESS_STATE_KEY_TABLE} (
    document_id text NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    candidate_id text NOT NULL,
    PRIMARY KEY (document_id, kind, key)
  )`,
  `CREATE SEQUENCE IF NOT EXISTS ${REVISION_SEQUENCE}`,
  `CREATE SEQUENCE IF NOT EXISTS ${POSITION_SEQUENCE}`
];
// Two processes creating the same object at the same moment: the loser sees a duplicate type or relation, and it exists.
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
const KEY_SEPARATOR = "\u0000";

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

function positionsFrom(rows, negate) {
  const positions = rows.map(row => (negate ? -1 : 1) * Number(row.position));
  if (!positions.every(Number.isSafeInteger)) throw new Error("POSTGRES_BUSINESS_STATE_POSITION_EXHAUSTED");
  return positions.sort((a, b) => a - b);
}

function splitKeys(keys) {
  const kinds = [], values = [];
  for (const entry of keys) {
    const at = entry.indexOf(KEY_SEPARATOR);
    kinds.push(entry.slice(0, at));
    values.push(entry.slice(at + 1));
  }
  return { kinds, values };
}

function keyConflict(kind) {
  const idempotency = kind === "idempotency";
  const error = new Error(idempotency ? "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" : `BUSINESS_STATE_REPOSITORY_KEY_CONFLICT:${kind}`);
  error.code = idempotency ? "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" : "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT";
  return error;
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
  // flag drops as soon as the lease connection ends, and under the shared row's lock the database confirms the lease
  // session still holds it, so a process that lost its lease cannot write after another process took over.
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

  // One statement at a time, so a creation race on one object does not skip the ones after it.
  function ensureSchema() {
    schemaReady ??= connectedPool().then(async activePool => {
      for (const statement of SCHEMA) {
        try {
          await activePool.query(statement);
        } catch (error) {
          if (!SCHEMA_RACE_CODES.has(error?.code)) throw error;
        }
      }
    }).catch(error => {
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

  // `known` holds revisions the caller already has; a row still at that revision comes back without its value.
  async function selectShared(client, knownRevision, lock = "") {
    const { rows } = await client.query(
      `SELECT revision::text AS revision, CASE WHEN revision::text = $2 THEN NULL ELSE shared END AS value
       FROM ${BUSINESS_STATE_SHARED_TABLE} WHERE document_id = $1 ${lock}`,
      [documentId, knownRevision ?? null]);
    if (rows.length === 0) return null;
    return rows[0].value === null ? { revision: rows[0].revision } : { revision: rows[0].revision, value: rows[0].value };
  }

  async function selectParts(client, candidateIds, known, lock = "") {
    const knownIds = [...(known ?? new Map()).keys()];
    const { rows } = await client.query(
      `SELECT p.candidate_id, p.revision::text AS revision,
         CASE WHEN p.revision::text = k.revision THEN NULL ELSE p.part END AS value
       FROM ${BUSINESS_STATE_CANDIDATE_TABLE} AS p
       LEFT JOIN unnest($2::text[], $3::text[]) AS k(candidate_id, revision) ON k.candidate_id = p.candidate_id
       WHERE p.document_id = $1 AND ($4::text[] IS NULL OR p.candidate_id = ANY($4::text[]))
       ORDER BY p.candidate_id ${lock}`,
      [documentId, knownIds, knownIds.map(id => known.get(id)), candidateIds]);
    return rows.map(row => row.value === null ? { candidateId: row.candidate_id, revision: row.revision }
      : { candidateId: row.candidate_id, revision: row.revision, value: row.value });
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

  function allocator(client) {
    const take = async (count, negate) => {
      if (count === 0) return [];
      const { rows } = await client.query(
        `SELECT nextval('${POSITION_SEQUENCE}')::text AS position FROM generate_series(1, $1::integer)`, [count]);
      return positionsFrom(rows, negate);
    };
    return Object.freeze({ end: count => take(count, false), front: count => take(count, true) });
  }

  async function removeKeys(client, owner, removed) {
    if (removed.length === 0) return;
    const { kinds, values } = splitKeys(removed);
    await client.query(
      `DELETE FROM ${BUSINESS_STATE_KEY_TABLE} AS k USING unnest($2::text[], $3::text[]) AS r(kind, key)
       WHERE k.document_id = $1 AND k.kind = r.kind AND k.key = r.key AND k.candidate_id = $4`,
      [documentId, kinds, values, owner]);
  }

  // Refused when another owner holds one of the keys; a key this owner already holds is not a conflict.
  async function addKeys(client, owner, added) {
    if (added.length === 0) return;
    const { kinds, values } = splitKeys(added);
    await client.query(
      `INSERT INTO ${BUSINESS_STATE_KEY_TABLE} (document_id, kind, key, candidate_id)
       SELECT $1, a.kind, a.key, $4 FROM unnest($2::text[], $3::text[]) AS a(kind, key)
       ON CONFLICT (document_id, kind, key) DO NOTHING`,
      [documentId, kinds, values, owner]);
    const { rows } = await client.query(
      `SELECT k.kind FROM ${BUSINESS_STATE_KEY_TABLE} AS k JOIN unnest($2::text[], $3::text[]) AS a(kind, key)
         ON k.kind = a.kind AND k.key = a.key
       WHERE k.document_id = $1 AND k.candidate_id <> $4 LIMIT 1`,
      [documentId, kinds, values, owner]);
    if (rows.length > 0) throw keyConflict(rows[0].kind);
  }

  // Writes what a transaction changed and returns, per row, what it held before and after, to settle a lost COMMIT.
  async function writeChanges(client, { shared, parts }, { sharedRevision, existing }) {
    const written = { shared: null, parts: [] };
    if (shared) {
      const text = JSON.stringify(shared.value);
      const { rows: [row] } = await client.query(
        `UPDATE ${BUSINESS_STATE_SHARED_TABLE} SET shared = $2::json, revision = nextval('${REVISION_SEQUENCE}'), updated_at = now()
         WHERE document_id = $1 RETURNING revision::text AS revision`,
        [documentId, text]);
      written.shared = { before: sharedRevision, after: row.revision, text };
    }
    const updates = [], inserts = [], deletes = [];
    for (const [candidateId, change] of parts) {
      if (change.value === null) {
        if (existing.has(candidateId)) deletes.push(candidateId);
      } else if (existing.has(candidateId)) updates.push([candidateId, JSON.stringify(change.value)]);
      else inserts.push([candidateId, JSON.stringify(change.value)]);
    }
    // Every owner's removed keys go before any added ones, so a key moving between candidates is not a conflict.
    const keyChanges = [...(shared ? [["", shared.keys]] : []), ...[...parts].map(([candidateId, change]) => [candidateId, change.keys])];
    for (const [owner, keys] of keyChanges) await removeKeys(client, owner, keys.removed);
    for (const [owner, keys] of keyChanges) await addKeys(client, owner, keys.added);
    if (deletes.length > 0) {
      await client.query(`DELETE FROM ${BUSINESS_STATE_CANDIDATE_TABLE} WHERE document_id = $1 AND candidate_id = ANY($2::text[])`,
        [documentId, deletes]);
      for (const candidateId of deletes) written.parts.push({ candidateId, before: existing.get(candidateId), after: null, text: null });
    }
    if (updates.length > 0) {
      const { rows } = await client.query(
        `UPDATE ${BUSINESS_STATE_CANDIDATE_TABLE} AS p SET part = v.part::json, revision = nextval('${REVISION_SEQUENCE}'), updated_at = now()
         FROM unnest($2::text[], $3::text[]) AS v(candidate_id, part)
         WHERE p.document_id = $1 AND p.candidate_id = v.candidate_id RETURNING p.candidate_id, p.revision::text AS revision`,
        [documentId, updates.map(([id]) => id), updates.map(([, text]) => text)]);
      if (rows.length !== updates.length) throw new Error("BUSINESS_STATE_REPOSITORY_PARTITION_CONFLICT");
      const after = new Map(rows.map(row => [row.candidate_id, row.revision]));
      for (const [candidateId, text] of updates) written.parts.push({ candidateId, before: existing.get(candidateId), after: after.get(candidateId), text });
    }
    if (inserts.length > 0) {
      const { rows } = await client.query(
        `INSERT INTO ${BUSINESS_STATE_CANDIDATE_TABLE} (document_id, candidate_id, part, revision)
         SELECT $1, v.candidate_id, v.part::json, nextval('${REVISION_SEQUENCE}') FROM unnest($2::text[], $3::text[]) AS v(candidate_id, part)
         ON CONFLICT (document_id, candidate_id) DO NOTHING RETURNING candidate_id, revision::text AS revision`,
        [documentId, inserts.map(([id]) => id), inserts.map(([, text]) => text)]);
      // Another process made the same candidate's row since this transaction looked.
      if (rows.length !== inserts.length) throw new Error("BUSINESS_STATE_REPOSITORY_PARTITION_CONFLICT");
      const after = new Map(rows.map(row => [row.candidate_id, row.revision]));
      for (const [candidateId, text] of inserts) written.parts.push({ candidateId, before: null, after: after.get(candidateId), text });
    }
    return written;
  }

  // The COMMIT was sent but its answer never came, so the write may have landed. Reporting a saved write as failed would
  // invite the user to repeat it, so the rows decide: all ours (each at the revision and text this transaction wrote, or
  // gone if it removed them) means saved, all as this transaction found them means not saved, anything else cannot be
  // told apart and is reported as unknown. Locking the shared row first waits for every transaction still holding it,
  // ours included, so a COMMIT still in flight is seen as landed or not.
  async function settleLostCommit(written, failure, result) {
    let outcome;
    try {
      const connection = await checkOut();
      let releaseError;
      try {
        await connection.client.query("BEGIN");
        const { rows: sharedRows } = await connection.client.query(
          `SELECT revision::text AS revision, shared::text AS text FROM ${BUSINESS_STATE_SHARED_TABLE} WHERE document_id = $1 FOR UPDATE`,
          [documentId]);
        const { rows: partRows } = await connection.client.query(
          `SELECT candidate_id, revision::text AS revision, part::text AS text FROM ${BUSINESS_STATE_CANDIDATE_TABLE}
           WHERE document_id = $1 AND candidate_id = ANY($2::text[])`,
          [documentId, written.parts.map(part => part.candidateId)]);
        await connection.client.query("COMMIT");
        const current = new Map(partRows.map(row => [row.candidate_id, row]));
        const checks = written.parts.map(part => ({ row: current.get(part.candidateId) ?? null, ...part }));
        if (written.shared) checks.push({ row: sharedRows[0] ?? null, ...written.shared });
        const ours = checks.every(({ row, after, text }) => after === null ? row === null : row?.revision === after && row.text === text);
        const untouched = checks.every(({ row, before }) => before === null ? row === null : row?.revision === before);
        outcome = ours ? "saved" : untouched ? "not_saved" : "unknown";
      } catch (error) {
        releaseError = await abandon(connection.client, error);
        outcome = "unknown";
      } finally {
        connection.release(releaseError);
      }
    } catch {
      outcome = "unknown";
    }
    if (outcome === "saved") return result;
    if (outcome === "not_saved") throw failure;
    throw new Error("BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN", { cause: failure });
  }

  return Object.freeze({
    documentId,
    // One connection holds the process lease and reads need one, so this many transactions can run side by side.
    maxConcurrentTransactions: Math.max(1, maxConnections - 2),
    /**
     * One consistent unlocked read of the shared row and the candidate rows (all of them, or only `candidateIds`). Rows
     * still at the revision in `known` come back without their value. Null when nothing is stored yet.
     */
    async readRows({ candidateIds = null, known = { shared: null, parts: new Map() } } = {}) {
      await ensureSchema();
      const connection = await checkOut();
      const { client } = connection;
      let releaseError;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const shared = await selectShared(client, known.shared);
        const parts = shared === null ? [] : await selectParts(client, candidateIds, known.parts);
        await client.query("COMMIT");
        return shared === null ? null : { shared, parts };
      } catch (error) {
        releaseError = await abandon(client, error);
        throw error;
      } finally {
        connection.release(releaseError);
      }
    },
    /**
     * Runs `work` inside one transaction. For the whole document (`candidateIds` null) the shared row is locked
     * exclusively and every candidate row is read; for some candidates the shared row is locked shared (other such
     * transactions run alongside, a whole-document one waits) and only their rows are read and locked. `work` gets the
     * rows (as readRows returns them), `allocate` for new record positions and `write({ shared, parts })`; changes are
     * written once, at the end, and committed. Any error rolls back; when only the COMMIT's answer is lost, the rows say
     * whether the write landed. With `initialShared`, a missing shared row starts from it; nothing is kept if `work`
     * writes nothing.
     */
    async runLocked({ candidateIds = null, initialShared = null, known = { shared: null, parts: new Map() } } = {}, work) {
      if (typeof work !== "function") throw new Error("POSTGRES_BUSINESS_STATE_WORK_REQUIRED");
      if (lease !== null && !lease.held) throw new Error("BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST");
      await ensureSchema();
      const connection = await checkOut();
      const { client } = connection;
      const lock = candidateIds === null ? "FOR UPDATE" : "FOR SHARE";
      let releaseError, result, written = null, commitFailure;
      try {
        await client.query("BEGIN");
        let shared = await selectShared(client, known.shared, lock);
        let inserted = false;
        if (shared === null) {
          if (typeof initialShared !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
          const insert = await client.query(
            `INSERT INTO ${BUSINESS_STATE_SHARED_TABLE} (document_id, shared, revision) VALUES ($1, $2::json, nextval('${REVISION_SEQUENCE}'))
             ON CONFLICT (document_id) DO NOTHING`,
            [documentId, JSON.stringify(initialShared())]);
          inserted = insert.rowCount === 1;
          shared = await selectShared(client, null, lock);
          if (shared === null) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
        }
        await assertLeaseHeld(client);
        const parts = await selectParts(client, candidateIds, known.parts, candidateIds === null ? "" : "FOR UPDATE OF p");
        let changes = null;
        result = await work({ shared, parts, allocate: allocator(client), write(next) { changes = next; } });
        if (changes === null || (!changes.shared && changes.parts.size === 0)) {
          await client.query(inserted ? "ROLLBACK" : "COMMIT");
          return result;
        }
        if (candidateIds !== null && (changes.shared || [...changes.parts.keys()].some(id => !candidateIds.includes(id)))) {
          throw new Error("BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:store");
        }
        const pending = await writeChanges(client, changes, { sharedRevision: inserted ? null : shared.revision,
          existing: new Map(parts.map(part => [part.candidateId, part.revision])) });
        written = pending;
        await client.query("COMMIT");
        return result;
      } catch (error) {
        releaseError = await abandon(client, error);
        if (written === null) throw error;
        commitFailure = error;
      } finally {
        // A connection whose rollback failed or timed out is closed instead of going back to the pool mid-transaction.
        connection.release(releaseError);
      }
      return settleLostCommit(written, commitFailure, result);
    },
    /** Read-only look at the target, for the import dry run: creates nothing. */
    async inspect() {
      const activePool = await connectedPool();
      const { rows: [table] } = await activePool.query("SELECT to_regclass($1) IS NOT NULL AS exists", [BUSINESS_STATE_SHARED_TABLE]);
      if (!table.exists) return { tableExists: false, revision: null };
      const { rows } = await activePool.query(
        `SELECT revision::text AS revision FROM ${BUSINESS_STATE_SHARED_TABLE} WHERE document_id = $1`, [documentId]);
      return { tableExists: true, revision: rows[0]?.revision ?? null };
    },
    /**
     * Writes `document` as the first state only when nothing is stored yet; never overwrites. `verify` sees the document
     * put back together from the rows as stored before commit, and anything it throws rolls the insert back. Returns
     * false when a state already exists.
     */
    async insertDocument(document, { verify = async () => {} } = {}) {
      if (document === null || typeof document !== "object" || Array.isArray(document)) {
        throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      }
      await ensureSchema();
      const connection = await checkOut();
      const { client } = connection;
      let releaseError, written = null, commitFailure;
      try {
        await client.query("BEGIN");
        // Positions come from the sequence, so records added later always land after (or before) the imported ones.
        const positions = await allocator(client).end(longestPartitionedCollection(document));
        const { shared, parts } = splitBusinessState(document, { positionAt: index => positions[index] });
        const sharedValue = encodeSharedPart(shared);
        const insert = await client.query(
          `INSERT INTO ${BUSINESS_STATE_SHARED_TABLE} (document_id, shared, revision) VALUES ($1, $2::json, nextval('${REVISION_SEQUENCE}'))
           ON CONFLICT (document_id) DO NOTHING RETURNING revision::text AS revision`,
          [documentId, JSON.stringify(sharedValue)]);
        if (insert.rowCount !== 1) {
          await client.query("ROLLBACK");
          return false;
        }
        // Keys several candidates already share in the file stay as they are: the first holder is recorded.
        const keyRows = [...[...sharedPartitionKeys(shared)].map(key => ["", key]),
          ...[...parts].flatMap(([candidateId, part]) => [...partitionKeys(part.collections)].map(key => [candidateId, key]))];
        const { kinds, values } = splitKeys(keyRows.map(([, key]) => key));
        await client.query(
          `INSERT INTO ${BUSINESS_STATE_KEY_TABLE} (document_id, kind, key, candidate_id)
           SELECT $1, k.kind, k.key, k.candidate_id FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS k(kind, key, candidate_id, n)
           ORDER BY k.n ON CONFLICT (document_id, kind, key) DO NOTHING`,
          [documentId, kinds, values, keyRows.map(([owner]) => owner)]);
        const partValues = [...parts].map(([candidateId, part]) => [candidateId, JSON.stringify(encodeCandidatePart(part))]);
        const { rows: insertedParts } = await client.query(
          `INSERT INTO ${BUSINESS_STATE_CANDIDATE_TABLE} (document_id, candidate_id, part, revision)
           SELECT $1, v.candidate_id, v.part::json, nextval('${REVISION_SEQUENCE}') FROM unnest($2::text[], $3::text[]) AS v(candidate_id, part)
           RETURNING candidate_id, revision::text AS revision`,
          [documentId, partValues.map(([id]) => id), partValues.map(([, text]) => text)]);
        const { rows: [storedShared] } = await client.query(
          `SELECT shared FROM ${BUSINESS_STATE_SHARED_TABLE} WHERE document_id = $1`, [documentId]);
        const { rows: storedParts } = await client.query(
          `SELECT candidate_id, part FROM ${BUSINESS_STATE_CANDIDATE_TABLE} WHERE document_id = $1`, [documentId]);
        await verify(assembleBusinessState(decodeSharedPart(storedShared.shared),
          storedParts.map(row => decodeCandidatePart(row.part, row.candidate_id))));
        const after = new Map(insertedParts.map(row => [row.candidate_id, row.revision]));
        written = { shared: { before: null, after: insert.rows[0].revision, text: JSON.stringify(sharedValue) },
          parts: partValues.map(([candidateId, text]) => ({ candidateId, before: null, after: after.get(candidateId), text })) };
        await client.query("COMMIT");
        return true;
      } catch (error) {
        releaseError = await abandon(client, error);
        if (written === null) throw error;
        commitFailure = error;
      } finally {
        connection.release(releaseError);
      }
      // As for writes: a lost COMMIT answer is settled from the rows, so an import is never reported as failed when it
      // landed (a rerun would then find the target "not empty" with no way to tell it was this import).
      return settleLostCommit(written, commitFailure, true);
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
