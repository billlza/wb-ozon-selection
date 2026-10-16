import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createConfiguredBusinessStateRepository,
  createMemoryBusinessStateRepository,
  createPostgresBusinessStateRepository,
  initialBusinessStateDocument
} from "../lib/business-state-repository.mjs";
import { importBusinessStateToPostgres } from "../lib/business-state-import.mjs";
import {
  BUSINESS_STATE_TABLE,
  POSTGRES_BUSINESS_STATE_TIMEOUTS,
  createPostgresBusinessStateStore,
  isPostgresConnectionString
} from "../lib/postgres-business-state-store.mjs";
import { createRepositoryRuntimeHealth } from "../lib/runtime-health.mjs";
import { createFakePostgresBusinessStateStore } from "./helpers/fake-postgres-business-state-store.mjs";

const CONFIGURATION = Object.freeze({ schemaVersion: "selection-review-runtime-configuration-v1", stateAdapter: "postgres", initializeDataFile: false });
const DATABASE_URL = "postgres://review:not-a-real-password@db.internal.example:5432/review";

// Answers the store's statements by kind and keeps one row; a ROLLBACK that goes through restores the row as it was at
// BEGIN. Failures are injected per kind.
function fakePool({ row = null, fail = {}, lease = { acquired: true, held: true } } = {}) {
  const statements = [];
  const released = [];
  let current = row;
  let atBegin = row;
  async function answer(sql, params = []) {
    const text = sql.replace(/\s+/gu, " ").trim();
    const kind = text.includes("pg_try_advisory_lock") ? "LEASE" : text.includes("pg_locks") ? "LEASE_CHECK"
      : text.includes("pg_advisory_unlock") ? "UNLOCK"
      : text.startsWith("CREATE TABLE") ? "CREATE" : text.startsWith("SELECT document, revision") ? "SELECT_FOR_UPDATE"
      : text.endsWith("FOR SHARE") ? "SELECT_FOR_SHARE" : text.startsWith("SELECT revision") ? "SELECT" : text.split(" ")[0];
    statements.push({ kind, text, params });
    const failure = Array.isArray(fail[kind]) ? fail[kind].shift() : fail[kind];
    if (failure) throw typeof failure === "function" ? failure() : failure;
    if (kind === "LEASE") return { rows: [{ acquired: lease.acquired, pid: 42 }] };
    if (kind === "LEASE_CHECK") return { rows: [{ held: lease.held && params[2] === 42 }] };
    if (kind === "UNLOCK") return { rows: [{}] };
    if (kind === "BEGIN") atBegin = current;
    if (kind === "ROLLBACK") current = atBegin;
    if (kind === "SELECT_FOR_SHARE") return { rows: current ? [{ revision: String(current.revision), text: JSON.stringify(current.document) }] : [] };
    if (kind === "SELECT_FOR_UPDATE") return { rows: current ? [{ document: JSON.parse(JSON.stringify(current.document)), revision: String(current.revision) }] : [] };
    if (kind === "SELECT") {
      if (!current) return { rows: [] };
      return { rows: [{ revision: String(current.revision), document: params[1] === String(current.revision) ? null : structuredClone(current.document) }] };
    }
    if (kind === "INSERT") {
      if (current) return { rowCount: 0 };
      current = { document: JSON.parse(params[1]), revision: 1 };
      return { rowCount: 1 };
    }
    if (kind === "UPDATE") {
      current = { document: JSON.parse(params[1]), revision: current.revision + 1 };
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  const client = Object.assign(new EventEmitter(), { query: answer, release(error) { released.push(error ?? null); } });
  const pool = { query: answer, async connect() { return client; } };
  return { pool, client, lease, statements, released, kinds: () => statements.map(statement => statement.kind) };
}

test("Postgres store validates its inputs and never builds SQL from values", async () => {
  assert.throws(() => createPostgresBusinessStateStore({}), /POSTGRES_BUSINESS_STATE_CONNECTION_REQUIRED/);
  assert.throws(() => createPostgresBusinessStateStore({ connectionString: "mysql://example" }), /CONNECTION_REQUIRED/);
  assert.throws(() => createPostgresBusinessStateStore({ pool: { query() {} } }), /POOL_INVALID/);
  assert.throws(() => createPostgresBusinessStateStore({ pool: fakePool().pool, documentId: "x'; DROP TABLE y; --" }), /DOCUMENT_ID_INVALID/);
  assert.throws(() => createPostgresBusinessStateStore({ pool: fakePool().pool, maxConnections: 0 }), /POOL_SIZE_INVALID/);
  for (const timeouts of [{}, { ...POSTGRES_BUSINESS_STATE_TIMEOUTS, lockMs: 0 },
    { ...POSTGRES_BUSINESS_STATE_TIMEOUTS, queryMs: POSTGRES_BUSINESS_STATE_TIMEOUTS.statementMs }]) {
    assert.throws(() => createPostgresBusinessStateStore({ pool: fakePool().pool, timeouts }), /TIMEOUTS_INVALID/);
  }
  assert.equal(isPostgresConnectionString("postgresql://u@h/db"), true);
  assert.equal(isPostgresConnectionString("postgres://"), false);

  const fake = fakePool({ row: { document: { meta: { version: 2 } }, revision: 4 } });
  const store = createPostgresBusinessStateStore({ pool: fake.pool, documentId: "state-a" });
  await store.runLocked({}, ({ document, replace }) => replace({ ...document, note: "it's \"quoted\"" }));
  for (const statement of fake.statements) {
    assert.doesNotMatch(statement.text, /state-a|quoted/u);
    if (statement.text.includes(BUSINESS_STATE_TABLE) && statement.kind !== "CREATE") assert.equal(statement.params[0], "state-a");
  }
  const update = fake.statements.find(statement => statement.kind === "UPDATE");
  assert.equal(JSON.parse(update.params[1]).note, "it's \"quoted\"");
});

test("a locked write runs as BEGIN, SELECT … FOR UPDATE, one UPDATE, COMMIT, and returns the connection once", async () => {
  const fake = fakePool({ row: { document: { meta: { version: 2 }, counter: 1 }, revision: 7 } });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  const result = await store.runLocked({}, async ({ document, replace }) => {
    replace({ ...document, counter: document.counter + 1 });
    replace({ ...document, counter: document.counter + 2 });
    return "saved";
  });
  assert.equal(result, "saved");
  assert.deepEqual(fake.kinds(), ["CREATE", "BEGIN", "SELECT_FOR_UPDATE", "UPDATE", "COMMIT"]);
  assert.match(fake.statements[2].text, /FOR UPDATE$/u);
  assert.equal(JSON.parse(fake.statements[3].params[1]).counter, 3);
  assert.deepEqual(fake.released, [null]);

  await store.runLocked({}, () => "read only");
  assert.deepEqual(fake.kinds().slice(5), ["BEGIN", "SELECT_FOR_UPDATE", "COMMIT"]);
});

test("failed work rolls back; a failed rollback closes the connection instead of reusing it", async () => {
  const fake = fakePool({ row: { document: { meta: { version: 2 } }, revision: 1 } });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  await assert.rejects(store.runLocked({}, ({ replace }) => { replace({ meta: { version: 2 } }); throw new Error("MUTATOR_FAILED"); }), /MUTATOR_FAILED/);
  assert.deepEqual(fake.kinds(), ["CREATE", "BEGIN", "SELECT_FOR_UPDATE", "ROLLBACK"]);
  assert.deepEqual(fake.released, [null]);

  const broken = new Error("connection lost");
  const failing = fakePool({ row: { document: { meta: { version: 2 } }, revision: 1 }, fail: { UPDATE: new Error("UPDATE_FAILED"), ROLLBACK: broken } });
  const failingStore = createPostgresBusinessStateStore({ pool: failing.pool });
  await assert.rejects(failingStore.runLocked({}, ({ document, replace }) => replace(document)), /UPDATE_FAILED/);
  assert.deepEqual(failing.kinds().slice(-2), ["UPDATE", "ROLLBACK"]);
  assert.deepEqual(failing.released, [broken]);

  // Past the client deadline the statement may still be running: the connection is closed, no ROLLBACK is queued behind it.
  const deadline = new Error("Query read timeout");
  const stalled = fakePool({ row: { document: { meta: { version: 2 } }, revision: 1 }, fail: { BEGIN: deadline } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: stalled.pool }).runLocked({}, () => "never"), /Query read timeout/);
  assert.deepEqual(stalled.kinds(), ["CREATE", "BEGIN"]);
  assert.deepEqual(stalled.released, [deadline]);
});

test("a lost COMMIT answer is settled from the row: saved, not saved, or reported as unknown", async () => {
  const row = () => ({ document: { meta: { version: 2 }, counter: 1 }, revision: 4 });
  const bump = ({ document, replace }) => { replace({ ...document, counter: 2 }); return "saved"; };
  const lost = () => new Error("Connection terminated unexpectedly");

  // The database committed but the answer never arrived (the connection is gone, so the rollback fails too).
  const landedFailure = lost();
  const landed = fakePool({ row: row(), fail: { COMMIT: landedFailure, ROLLBACK: new Error("Client was closed") } });
  assert.equal(await createPostgresBusinessStateStore({ pool: landed.pool }).runLocked({}, bump), "saved");
  assert.deepEqual(landed.kinds().slice(-4), ["UPDATE", "COMMIT", "ROLLBACK", "SELECT_FOR_SHARE"]);
  assert.match(landed.statements.at(-1).text, /WHERE document_id = \$1 FOR SHARE$/u);
  assert.equal(landed.released.length, 1);

  // The COMMIT never took effect: the row still has the locked revision, so the original failure stands.
  const missedFailure = lost();
  const missed = fakePool({ row: row(), fail: { COMMIT: missedFailure } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: missed.pool }).runLocked({}, bump), error => error === missedFailure);

  // A row this transaction inserted and never committed is simply absent.
  const firstFailure = lost();
  const first = fakePool({ fail: { COMMIT: firstFailure } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: first.pool })
    .runLocked({ initialDocument: () => ({ meta: { version: 2 }, counter: 1 }) }, bump), error => error === firstFailure);

  // The row cannot be read back: neither answer is safe, so the caller is told the outcome is unknown.
  const unknownFailure = lost();
  const unknown = fakePool({ row: row(), fail: { COMMIT: unknownFailure, ROLLBACK: new Error("Client was closed"), SELECT_FOR_SHARE: lost() } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: unknown.pool }).runLocked({}, bump),
    error => error.message === "BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN" && error.cause === unknownFailure);

  // The import insert settles a lost COMMIT answer the same way.
  const imported = fakePool({ fail: { COMMIT: lost(), ROLLBACK: new Error("Client was closed") } });
  assert.equal(await createPostgresBusinessStateStore({ pool: imported.pool }).insertDocument({ meta: { version: 2 } }), true);
  assert.equal(imported.kinds().at(-1), "SELECT_FOR_SHARE");
  const notImportedFailure = lost();
  const notImported = fakePool({ fail: { COMMIT: notImportedFailure } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: notImported.pool }).insertDocument({ meta: { version: 2 } }),
    error => error === notImportedFailure);

  // A read-only transaction has nothing to settle.
  const quiet = fakePool({ row: row(), fail: { COMMIT: lost() } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: quiet.pool }).runLocked({}, () => "looked"), /Connection terminated/);
  assert.equal(quiet.kinds().includes("SELECT_FOR_SHARE"), false);
});

test("a missing row fails without a starting document, and a starting document is kept only when work replaces it", async () => {
  const empty = fakePool();
  const store = createPostgresBusinessStateStore({ pool: empty.pool });
  await assert.rejects(store.runLocked({}, () => "never"), /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);
  assert.deepEqual(empty.kinds(), ["CREATE", "BEGIN", "SELECT_FOR_UPDATE", "ROLLBACK"]);

  const unchanged = fakePool();
  await createPostgresBusinessStateStore({ pool: unchanged.pool }).runLocked({ initialDocument: () => ({ meta: { version: 2 } }) }, () => "looked");
  assert.deepEqual(unchanged.kinds(), ["CREATE", "BEGIN", "SELECT_FOR_UPDATE", "INSERT", "SELECT_FOR_UPDATE", "ROLLBACK"]);

  const changed = fakePool();
  await createPostgresBusinessStateStore({ pool: changed.pool }).runLocked({ initialDocument: () => ({ meta: { version: 2 } }) },
    ({ document, replace }) => replace({ ...document, candidates: [] }));
  assert.deepEqual(changed.kinds(), ["CREATE", "BEGIN", "SELECT_FOR_UPDATE", "INSERT", "SELECT_FOR_UPDATE", "UPDATE", "COMMIT"]);
});

test("the table is created once; a concurrent creator is tolerated and other failures are retried next time", async () => {
  const raced = fakePool({ row: { document: { meta: { version: 2 } }, revision: 1 }, fail: { CREATE: [() => Object.assign(new Error("duplicate"), { code: "42P07" })] } });
  const store = createPostgresBusinessStateStore({ pool: raced.pool });
  await store.readDocument();
  await store.readDocument();
  assert.deepEqual(raced.kinds(), ["CREATE", "SELECT", "SELECT"]);

  const down = fakePool({ fail: { CREATE: [() => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })] } });
  const retrying = createPostgresBusinessStateStore({ pool: down.pool });
  await assert.rejects(retrying.readDocument(), /connection refused/);
  assert.equal(await retrying.readDocument(), null);
  assert.deepEqual(down.kinds(), ["CREATE", "CREATE", "SELECT"]);
});

test("reads skip the document while the caller's revision is current", async () => {
  const fake = fakePool({ row: { document: { meta: { version: 2 }, value: 1 }, revision: 3 } });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  assert.deepEqual(await store.readDocument(), { revision: "3", document: { meta: { version: 2 }, value: 1 } });
  assert.deepEqual(await store.readDocument({ knownRevision: "3" }), { revision: "3" });
  assert.deepEqual(await store.readDocument({ knownRevision: "2" }), { revision: "3", document: { meta: { version: 2 }, value: 1 } });
  assert.equal(fake.statements.at(-1).params[1], "2");
});

test("the import insert never overwrites, and a failed read-back check rolls the insert back", async () => {
  const occupied = fakePool({ row: { document: { meta: { version: 2 } }, revision: 5 } });
  assert.equal(await createPostgresBusinessStateStore({ pool: occupied.pool }).insertDocument({ meta: { version: 2 } }), false);
  assert.deepEqual(occupied.kinds(), ["CREATE", "BEGIN", "INSERT", "ROLLBACK"]);

  const empty = fakePool();
  await assert.rejects(createPostgresBusinessStateStore({ pool: empty.pool }).insertDocument({ meta: { version: 2 } }, {
    verify: async () => { throw new Error("READBACK_MISMATCH"); }
  }), /READBACK_MISMATCH/);
  assert.deepEqual(empty.kinds(), ["CREATE", "BEGIN", "INSERT", "SELECT_FOR_UPDATE", "ROLLBACK"]);
  await assert.rejects(createPostgresBusinessStateStore({ pool: fakePool().pool }).insertDocument([]), /DOCUMENT_INVALID/);
});

test("configured Postgres storage needs a database address and keeps it out of the repository", async () => {
  assert.throws(() => createConfiguredBusinessStateRepository(CONFIGURATION, { env: {} }), /BUSINESS_STATE_REPOSITORY_DATABASE_URL_REQUIRED/);
  assert.throws(() => createConfiguredBusinessStateRepository(CONFIGURATION, { env: { SELECTION_REVIEW_DATABASE_URL: "file:///tmp/x" } }), /DATABASE_URL_REQUIRED/);
  const requested = [];
  const store = createFakePostgresBusinessStateStore({ document: initialBusinessStateDocument({ now: "2026-10-15T00:00:00.000Z" }) });
  const repository = createConfiguredBusinessStateRepository(CONFIGURATION, {
    env: { SELECTION_REVIEW_DATABASE_URL: ` ${DATABASE_URL} ` },
    createStore: options => { requested.push(options); return store; }
  });
  assert.deepEqual(requested, [{ connectionString: DATABASE_URL }]);
  assert.equal(repository.adapter, "postgres");
  assert.equal(repository.multiUserReady, true);
  assert.doesNotMatch(JSON.stringify(repository), /not-a-real-password|db\.internal/u);
  assert.equal((await repository.readSnapshot()).meta.version, 2);
});

test("Postgres snapshots re-check the revision every read, re-parse only after a change, and never share objects", async () => {
  const store = createFakePostgresBusinessStateStore({ document: { meta: { version: 2 }, candidates: [{ id: "C-1", dataRevision: 1 }] } });
  const repository = createPostgresBusinessStateRepository({ store });
  const first = await repository.readSnapshot();
  first.candidates[0].dataRevision = 99;
  const second = await repository.readSnapshot();
  assert.equal(second.candidates[0].dataRevision, 1);
  assert.deepEqual([store.calls.reads, store.calls.documentTransfers], [2, 1]);
  await repository.transact(async document => {
    document.candidates[0].dataRevision = 2;
    return { changed: true, document, result: null };
  });
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
  assert.deepEqual([store.calls.reads, store.calls.documentTransfers], [3, 2]);
});

test("a read that finishes after a newer read answers from the snapshot it asked about", async () => {
  const documents = { 1: { meta: { version: 2 }, candidates: [{ id: "C-1", dataRevision: 1 }] },
    2: { meta: { version: 2 }, candidates: [{ id: "C-1", dataRevision: 2 }] } };
  const answers = [];
  const store = { readDocument: ({ knownRevision }) => new Promise(resolve => answers.push({ knownRevision, resolve })),
    async runLocked() { throw new Error("NOT_USED"); } };
  const repository = createPostgresBusinessStateRepository({ store });
  const first = repository.readSnapshot();
  answers.shift().resolve({ revision: "1", document: structuredClone(documents[1]) });
  await first;
  const slower = repository.readSnapshot();
  const faster = repository.readSnapshot();
  const [slowerQuery, fasterQuery] = answers.splice(0);
  assert.deepEqual([slowerQuery.knownRevision, fasterQuery.knownRevision], ["1", "1"]);
  // Another process wrote revision 2 between the two queries; the faster one sees it and replaces the cache first.
  fasterQuery.resolve({ revision: "2", document: structuredClone(documents[2]) });
  assert.equal((await faster).candidates[0].dataRevision, 2);
  slowerQuery.resolve({ revision: "1" });
  assert.equal((await slower).candidates[0].dataRevision, 1);
});

test("the Postgres repository holds one service-process lease or refuses to start a second", async () => {
  let holder = null;
  const base = createFakePostgresBusinessStateStore({ document: { meta: { version: 2 }, candidates: [] } });
  const store = { ...base, async acquireProcessLease({ onLost }) {
    if (holder) return null;
    holder = { onLost, async release() { holder = null; } };
    return holder;
  } };
  const onLost = () => {};
  const lease = await createPostgresBusinessStateRepository({ store }).holdProcessLease({ onLost });
  assert.equal(lease.onLost, onLost);
  await assert.rejects(createPostgresBusinessStateRepository({ store }).holdProcessLease({ onLost }), /BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_HELD/);
  await lease.release();
  await (await createPostgresBusinessStateRepository({ store }).holdProcessLease({ onLost })).release();
  await assert.rejects(createPostgresBusinessStateRepository({ store: base }).holdProcessLease({ onLost }), /PROCESS_LEASE_UNSUPPORTED/);
  await assert.rejects(createPostgresBusinessStateStore({ pool: fakePool().pool }).acquireProcessLease({}), /LEASE_LOST_HANDLER_REQUIRED/);
  // The single-process JSON and memory adapters have no lease; the server skips it for them.
  assert.equal("holdProcessLease" in createMemoryBusinessStateRepository({ meta: { version: 2 }, candidates: [] }), false);
});

test("a store holding the process lease writes only while the database confirms its lease session still holds it", async () => {
  const fake = fakePool({ row: { document: { meta: { version: 2 }, counter: 1 }, revision: 1 } });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  const bump = ({ document, replace }) => replace({ ...document, counter: document.counter + 1 });
  await store.runLocked({}, bump);
  assert.equal(fake.kinds().includes("LEASE_CHECK"), false);
  let lost = 0;
  const lease = await store.acquireProcessLease({ onLost: () => { lost += 1; } });
  await assert.rejects(store.acquireProcessLease({ onLost: () => {} }), /LEASE_ALREADY_TAKEN/);
  await store.runLocked({}, bump);
  assert.deepEqual(fake.kinds().slice(-5), ["BEGIN", "SELECT_FOR_UPDATE", "LEASE_CHECK", "UPDATE", "COMMIT"]);
  assert.deepEqual(fake.statements.at(-3).params, [1_397_904_945, "business-state", 42]);

  // The lease session lost the lock before this process heard about it: the write stops under the row lock.
  fake.lease.held = false;
  await assert.rejects(store.runLocked({}, bump), /BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST/);
  assert.deepEqual(fake.kinds().slice(-4), ["BEGIN", "SELECT_FOR_UPDATE", "LEASE_CHECK", "ROLLBACK"]);
  // From then on the store refuses at once, without asking the database.
  const asked = fake.statements.length;
  await assert.rejects(store.runLocked({}, bump), /PROCESS_LEASE_LOST/);
  assert.equal(fake.statements.length, asked);
  assert.equal(lost, 0);
  await lease.release();
  assert.equal(fake.kinds().at(-1), "UNLOCK");

  // When the lease connection itself ends, the holder is told and its writes stop.
  const dropped = fakePool({ row: { document: { meta: { version: 2 }, counter: 1 }, revision: 1 } });
  const droppedStore = createPostgresBusinessStateStore({ pool: dropped.pool });
  let told = 0;
  await droppedStore.acquireProcessLease({ onLost: () => { told += 1; } });
  dropped.client.emit("error", new Error("terminating connection due to administrator command"));
  dropped.client.emit("end");
  assert.equal(told, 1);
  await assert.rejects(droppedStore.runLocked({}, bump), /PROCESS_LEASE_LOST/);

  const busy = fakePool({ lease: { acquired: false, held: false } });
  assert.equal(await createPostgresBusinessStateStore({ pool: busy.pool }).acquireProcessLease({ onLost: () => {} }), null);
});

test("a missing Postgres document is an error unless initialization is allowed, and reading never creates it", async () => {
  const missing = createFakePostgresBusinessStateStore();
  await assert.rejects(createPostgresBusinessStateRepository({ store: missing }).readSnapshot(), /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);
  await assert.rejects(createPostgresBusinessStateRepository({ store: missing }).transact(async document => ({ changed: true, document })),
    /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);

  const repository = createPostgresBusinessStateRepository({ store: missing, initializeIfMissing: true,
    initialDocument: () => initialBusinessStateDocument({ now: "2026-10-15T00:00:00.000Z" }) });
  assert.equal((await repository.readSnapshot()).meta.date, "2026-10-15");
  await repository.transact(async () => ({ changed: false, result: null }));
  assert.equal(missing.revision, null);
  await repository.transact(async document => ({ changed: true, document: { ...document, candidates: [{ id: "C-1" }] } }));
  assert.equal(missing.revision, 2);
  assert.throws(() => createPostgresBusinessStateRepository({ store: {} }), /BUSINESS_STATE_REPOSITORY_STORE_REQUIRED/);
});

function sourceFile(document) {
  const text = JSON.stringify(document, null, 2);
  return { sourceFile: "/synthetic/business-state.json", readSource: async () => text, text };
}

test("the import dry run validates the file and writes nothing; a write only fills an empty target and is checked", async () => {
  const document = { meta: { version: 2, title: "t" }, candidates: [{ id: "C-1", dataRevision: 3 }, { id: "C-2", dataRevision: 1 }], dispatches: [{ id: "D-1" }] };
  const source = sourceFile(document);
  const store = createFakePostgresBusinessStateStore();
  const dryRun = await importBusinessStateToPostgres({ ...source, store });
  assert.deepEqual(dryRun, { status: "dry_run_ready", written: false, tableExists: false, candidates: 2, dispatches: 1, sourceBytes: Buffer.byteLength(source.text) });
  assert.equal(store.calls.inserts, 0);

  const imported = await importBusinessStateToPostgres({ ...source, store, write: true });
  assert.equal(imported.status, "imported");
  assert.deepEqual(JSON.parse(store.storedText()), document);
  assert.deepEqual(Object.keys(JSON.parse(store.storedText()).candidates[0]), ["id", "dataRevision"]);

  const again = await importBusinessStateToPostgres({ ...source, store, write: true });
  assert.deepEqual([again.status, again.written, again.targetRevision], ["target_not_empty", false, "1"]);
  assert.equal(store.calls.inserts, 1);

  await assert.rejects(importBusinessStateToPostgres({ ...sourceFile({ meta: { version: 1 }, candidates: [] }), store: createFakePostgresBusinessStateStore(), write: true }),
    /BUSINESS_STATE_IMPORT_SOURCE_INVALID/);
  await assert.rejects(importBusinessStateToPostgres({ sourceFile: "/x", readSource: async () => "{not json", store: createFakePostgresBusinessStateStore() }), SyntaxError);
});

const readinessFailure = code => error => error.message === "RUNTIME_READINESS_FAILED" && error.code === code;

test("Postgres readiness is one fresh repository read under the same admission and deadline rules", async () => {
  let reads = 0;
  let next = async () => ({ meta: { version: 2 }, candidates: [] });
  const health = createRepositoryRuntimeHealth({ readSnapshot: () => { reads += 1; return next(); } });
  await assert.rejects(health.ready(), readinessFailure("starting"));
  health.markListening();
  assert.deepEqual({ ...(await health.ready()), durationMs: 0 }, { dataVersion: 2, fresh: true, durationMs: 0 });
  next = async () => ({ meta: { version: 1 }, candidates: [] });
  await assert.rejects(health.ready(), readinessFailure("data_invalid"));
  next = async () => { throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID"); };
  await assert.rejects(health.ready(), readinessFailure("data_invalid"));
  next = async () => { throw new Error("connect ECONNREFUSED"); };
  await assert.rejects(health.ready(), readinessFailure("data_unavailable"));

  let release;
  next = () => new Promise(resolve => { release = resolve; });
  const pending = health.ready();
  await assert.rejects(health.ready(), readinessFailure("busy"));
  release({ meta: { version: 2 }, candidates: [] });
  assert.equal((await pending).dataVersion, 2);
  assert.equal(reads, 5);

  const controller = new AbortController();
  next = () => new Promise(() => {});
  const cancelled = health.ready({ signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, readinessFailure("cancelled"));
  await health.close();
  await assert.rejects(health.ready(), readinessFailure("closed"));
  assert.throws(() => createRepositoryRuntimeHealth({}), readinessFailure("configuration_invalid"));
});

test("Postgres readiness fails on its deadline instead of waiting for a stuck database", async () => {
  const health = createRepositoryRuntimeHealth({ readSnapshot: () => new Promise(() => {}), timeoutMs: 20 });
  health.markListening();
  await assert.rejects(health.ready(), readinessFailure("timeout"));
  await health.close();
});

test("a timed-out readiness read keeps admission until the database answers, so probes never pile up", async () => {
  let reads = 0;
  let release;
  const health = createRepositoryRuntimeHealth({ readSnapshot: () => {
    reads += 1;
    return new Promise(resolve => { release = resolve; });
  }, timeoutMs: 20 });
  health.markListening();
  await assert.rejects(health.ready(), readinessFailure("timeout"));
  await assert.rejects(health.ready(), readinessFailure("busy"));
  await assert.rejects(health.ready(), readinessFailure("busy"));
  assert.equal(reads, 1);
  release({ meta: { version: 2 }, candidates: [] });
  await new Promise(resolve => setImmediate(resolve));
  const next = health.ready();
  await new Promise(resolve => setImmediate(resolve));
  release({ meta: { version: 2 }, candidates: [] });
  assert.equal((await next).dataVersion, 2);
  assert.equal(reads, 2);
  // Shutdown does not wait for a database that never answers.
  const stuck = health.ready();
  await assert.rejects(stuck, readinessFailure("timeout"));
  await health.close();
  await assert.rejects(health.ready(), readinessFailure("closed"));
});
