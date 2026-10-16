import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { assembleBusinessState, decodeCandidatePart, decodeSharedPart } from "../lib/business-state-partitions.mjs";
import { createPostgresBusinessStateRepository, initialBusinessStateDocument } from "../lib/business-state-repository.mjs";
import { importBusinessStateToPostgres } from "../lib/business-state-import.mjs";
import {
  BUSINESS_STATE_CANDIDATE_TABLE,
  BUSINESS_STATE_KEY_TABLE,
  BUSINESS_STATE_SHARED_TABLE,
  createPostgresBusinessStateStore
} from "../lib/postgres-business-state-store.mjs";

// Runs against a real, disposable Postgres (CI starts one; see scripts/run-ci-database-tests.mjs). Each test works in
// its own schema and drops it afterwards.
const DATABASE_URL = process.env.SELECTION_REVIEW_TEST_DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//u.test(DATABASE_URL ?? "")) {
  throw new Error("TEST_REQUIRES_DATABASE: set SELECTION_REVIEW_TEST_DATABASE_URL to a disposable Postgres");
}

async function isolatedSchema(t) {
  const schema = `review_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools = [];
  t.after(async () => {
    for (const pool of pools) await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  // A separate pool stands for a separate service process.
  const store = () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
    pools.push(pool);
    return createPostgresBusinessStateStore({ pool });
  };
  // Every stored row as text, straight from the tables.
  const rows = async () => {
    const { rows: [shared] } = await admin.query(
      `SELECT shared::text AS text, revision::text AS revision FROM ${schema}.${BUSINESS_STATE_SHARED_TABLE}`).catch(() => ({ rows: [] }));
    if (!shared) return null;
    const { rows: parts } = await admin.query(
      `SELECT candidate_id, part::text AS text, revision::text AS revision FROM ${schema}.${BUSINESS_STATE_CANDIDATE_TABLE} ORDER BY candidate_id`);
    const { rows: keys } = await admin.query(
      `SELECT kind, key, candidate_id FROM ${schema}.${BUSINESS_STATE_KEY_TABLE} ORDER BY kind, key`);
    return { shared, parts: Object.fromEntries(parts.map(row => [row.candidate_id, { text: row.text, revision: row.revision }])),
      keys: keys.map(row => [row.kind, row.key, row.candidate_id]) };
  };
  // The whole document as the rows put it back together.
  const storedDocument = async () => {
    const stored = await rows();
    if (stored === null) return null;
    return assembleBusinessState(decodeSharedPart(JSON.parse(stored.shared.text)),
      Object.entries(stored.parts).map(([candidateId, row]) => decodeCandidatePart(JSON.parse(row.text), candidateId)));
  };
  const connectionString = () => `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const tableExists = async () => (await admin.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`${schema}.${BUSINESS_STATE_SHARED_TABLE}`])).rows[0].exists;
  // Stands in for a connection that loses the COMMIT's answer; `onCommit(send)` decides whether the COMMIT reaches the
  // database at all.
  const storeLosingCommitAnswer = onCommit => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
    pools.push(pool);
    let lost = false;
    return createPostgresBusinessStateStore({ pool: { query: (...args) => pool.query(...args), async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          if (sql !== "COMMIT" || lost) return client.query(sql, params);
          lost = true;
          await onCommit(() => client.query("COMMIT"));
          throw new Error("Connection terminated unexpectedly");
        },
        release: error => client.release(error)
      };
    } } });
  };
  // Another process holding a row lock in an open transaction until `release()`: the shared row, or one candidate's row.
  const holdRow = async (candidateId = null) => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    pools.unshift(client);
    await client.query("BEGIN");
    if (candidateId === null) await client.query(`SELECT 1 FROM ${schema}.${BUSINESS_STATE_SHARED_TABLE} FOR UPDATE`);
    else await client.query(`SELECT 1 FROM ${schema}.${BUSINESS_STATE_CANDIDATE_TABLE} WHERE candidate_id = $1 FOR UPDATE`, [candidateId]);
    return { release: () => client.query("COMMIT") };
  };
  // Ends the connection holding this schema's process lease, as a database restart or a network cut would.
  const endLeaseConnection = async () => (await admin.query(
    `SELECT pg_terminate_backend(pid) AS ended FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid
     AND objid = (hashtext($2)::bigint & 4294967295)::oid`, [1_397_904_945, `${schema}:business-state`])).rows.length;
  return { store, rows, storedDocument, tableExists, connectionString, storeLosingCommitAnswer, holdRow, endLeaseConnection };
}

const seed = () => ({ meta: { version: 2, title: "db test" }, candidates: [{ id: "C-1", dataRevision: 1 }, { id: "C-2", dataRevision: 1 }],
  runtime: { operationAudit: [], idempotencyRecords: [] } });

const bump = value => async document => {
  document.candidates[0].dataRevision = value;
  return { changed: true, document, result: value };
};

test("two service processes writing at the same time lose no update, whole-document or single-candidate", async t => {
  const database = await isolatedSchema(t);
  const first = database.store();
  assert.equal(await first.insertDocument(seed()), true);
  const repositories = [createPostgresBusinessStateRepository({ store: first }), createPostgresBusinessStateRepository({ store: database.store() })];
  const increment = index => async document => {
    const value = document.candidates[0].dataRevision;
    await new Promise(resolve => setTimeout(resolve, index % 3));
    document.candidates[0].dataRevision = value + 1;
    return { changed: true, document, result: null };
  };
  await Promise.all(Array.from({ length: 40 }, (_, index) => index % 4 < 2
    ? repositories[index % 2].transact(increment(index))
    : repositories[index % 2].transactCandidates(["C-1"], increment(index))));
  for (const repository of repositories) assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 41);
  assert.equal((await database.storedDocument()).candidates[1].dataRevision, 1);
  // A process that already read the current rows still sees the other process's next write.
  await repositories[1].transactCandidates(["C-1"], bump(42));
  assert.equal((await repositories[0].readSnapshot()).candidates[0].dataRevision, 42);
  assert.equal((await repositories[0].readCandidates(["C-1"])).candidates[0].dataRevision, 42);
});

test("actions on different candidates run side by side; a whole-document transaction waits for them", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const repository = createPostgresBusinessStateRepository({ store: database.store() });
  const other = createPostgresBusinessStateRepository({ store: database.store() });
  const order = [];
  let finish;
  const holding = new Promise(resolve => { finish = resolve; });
  let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  const slow = repository.transactCandidates(["C-1"], async document => {
    entered();
    await holding;
    order.push("C-1");
    return bump(5)(document);
  });
  await inside;
  // The same process and another one both get C-2 while C-1's transaction is still open.
  await repository.transactCandidates(["C-2"], async document => { order.push("C-2 same process"); return bump(6)(document); });
  await other.transactCandidates(["C-2"], async document => { order.push("C-2 other process"); return bump(7)(document); });
  const whole = other.transact(async () => { order.push("whole"); return { changed: false, result: null }; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(order, ["C-2 same process", "C-2 other process"]);
  finish();
  await Promise.all([slow, whole]);
  assert.deepEqual(order, ["C-2 same process", "C-2 other process", "C-1", "whole"]);
  assert.deepEqual((await database.storedDocument()).candidates.map(candidate => candidate.dataRevision), [5, 7]);
});

test("a single-candidate write changes only that candidate's row", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const before = await database.rows();
  const repository = createPostgresBusinessStateRepository({ store: database.store() });
  await repository.transactCandidates(["C-2"], bump(3));
  const after = await database.rows();
  assert.deepEqual(after.shared, before.shared);
  assert.deepEqual(after.parts["C-1"], before.parts["C-1"]);
  assert.notEqual(after.parts["C-2"].revision, before.parts["C-2"].revision);
  assert.deepEqual(JSON.parse(after.parts["C-2"].text).collections.candidates.records, [{ id: "C-2", dataRevision: 3 }]);
  await assert.rejects(repository.transactCandidates(["C-2"], async document => {
    document.meta.title = "changed";
    return { changed: true, document };
  }), /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:shared/);
  assert.deepEqual((await database.rows()).shared, before.shared);
});

test("a failed mutator or an invalid result leaves every row and revision as it was", async t => {
  const database = await isolatedSchema(t);
  const store = database.store();
  await store.insertDocument(seed());
  const repository = createPostgresBusinessStateRepository({ store });
  const before = await database.rows();
  await assert.rejects(repository.transact(async document => {
    document.candidates[0].dataRevision = 5;
    throw new Error("MUTATOR_FAILED");
  }), /MUTATOR_FAILED/);
  await assert.rejects(repository.transactCandidates(["C-1"], async () => ({ changed: true, document: [] })), /TRANSACTION_DOCUMENT_REQUIRED/);
  assert.deepEqual(await database.rows(), before);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 1);
});

test("the stored rows keep key order and values exactly as written", async t => {
  const database = await isolatedSchema(t);
  const store = database.store();
  const document = { runtime: { idempotencyRecords: [], operationAudit: [] }, meta: { version: 2, zeta: 1, alpha: "é ✓ \"q\"" },
    candidates: [{ id: "C-1", z: 1, a: 2, price: 12.5, nested: { b: null, a: [3, 2, 1] } }] };
  await store.insertDocument(document);
  assert.equal(JSON.stringify(await database.storedDocument()), JSON.stringify(document));
  assert.match((await database.rows()).parts["C-1"].text, /"records":\[\{"id":"C-1","z":1,"a":2,"price":12.5,"nested":\{"b":null,"a":\[3,2,1\]\}\}\]/u);
  const repository = createPostgresBusinessStateRepository({ store });
  await repository.transactCandidates(["C-1"], async current => {
    current.candidates[0].price = 13;
    return { changed: true, document: current };
  });
  const expected = structuredClone(document);
  expected.candidates[0].price = 13;
  assert.equal(JSON.stringify(await database.storedDocument()), JSON.stringify(expected));
  assert.deepEqual(Object.keys((await repository.readSnapshot()).candidates[0]), ["id", "z", "a", "price", "nested"]);
});

test("a key one candidate holds cannot be saved by another, even from two processes at once", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const record = candidateId => async document => {
    document.runtime.idempotencyRecords.push({ candidateId, idempotencyKey: "K-1" });
    return { changed: true, document, result: candidateId };
  };
  const [first, second] = [createPostgresBusinessStateRepository({ store: database.store() }),
    createPostgresBusinessStateRepository({ store: database.store() })];
  const outcomes = await Promise.allSettled([first.transactCandidates(["C-1"], record("C-1")), second.transactCandidates(["C-2"], record("C-2"))]);
  const saved = outcomes.filter(outcome => outcome.status === "fulfilled").map(outcome => outcome.value);
  const refused = outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason);
  assert.equal(saved.length, 1);
  assert.deepEqual(refused.map(error => [error.message, error.code]),
    [["BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"]]);
  assert.deepEqual((await database.rows()).keys, [["idempotency", "K-1", saved[0]]]);
  assert.deepEqual((await database.storedDocument()).runtime.idempotencyRecords, [{ candidateId: saved[0], idempotencyKey: "K-1" }]);

  // One transaction moving the key from one candidate to the other is not a conflict.
  const target = saved[0] === "C-1" ? "C-2" : "C-1";
  await first.transact(async document => {
    document.runtime.idempotencyRecords = [{ candidateId: target, idempotencyKey: "K-1" }];
    return { changed: true, document };
  });
  assert.deepEqual((await database.rows()).keys, [["idempotency", "K-1", target]]);
});

test("reading never creates the document; initialization keeps rows only after a real change", async t => {
  const database = await isolatedSchema(t);
  const strict = createPostgresBusinessStateRepository({ store: database.store() });
  await assert.rejects(strict.readSnapshot(), /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);
  const repository = createPostgresBusinessStateRepository({ store: database.store(), initializeIfMissing: true,
    initialDocument: () => initialBusinessStateDocument({ now: "2026-10-15T00:00:00.000Z" }) });
  assert.equal((await repository.readSnapshot()).meta.date, "2026-10-15");
  await repository.transact(async () => ({ changed: false, result: null }));
  await repository.transactCandidates(["C-9"], async () => ({ changed: false, result: null }));
  assert.equal(await database.rows(), null);
  await repository.transactCandidates(["C-9"], async document => ({ changed: true, document: { ...document, candidates: [{ id: "C-9" }] } }));
  assert.deepEqual(Object.keys((await database.rows()).parts), ["C-9"]);
  assert.deepEqual((await strict.readSnapshot()).candidates, [{ id: "C-9" }]);
});

test("the import dry run creates nothing; a write fills an empty target once and refuses to overwrite", async t => {
  const database = await isolatedSchema(t);
  const document = { ...seed(), candidates: [{ id: "C-1", dataRevision: 1 }, { id: "C-2", dataRevision: 4 }],
    dispatches: [{ id: "D-1", candidateId: "C-2" }, { id: "D-2", candidateId: null }, { id: "D-3", candidateId: "C-1" }] };
  const text = JSON.stringify(document, null, 2);
  const options = { sourceFile: "/synthetic/business-state.json", readSource: async () => text, store: database.store() };
  const dryRun = await importBusinessStateToPostgres(options);
  assert.deepEqual([dryRun.status, dryRun.tableExists, dryRun.candidates], ["dry_run_ready", false, 2]);
  assert.equal(await database.tableExists(), false);
  assert.equal((await importBusinessStateToPostgres({ ...options, write: true })).status, "imported");
  assert.equal(JSON.stringify(await database.storedDocument()), JSON.stringify(document));
  assert.deepEqual(Object.keys((await database.rows()).parts), ["C-1", "C-2"]);
  assert.deepEqual((await database.rows()).keys, [["dispatch", "D-1", "C-2"], ["dispatch", "D-2", ""], ["dispatch", "D-3", "C-1"]]);
  const again = await importBusinessStateToPostgres({ ...options, write: true });
  assert.deepEqual([again.status, again.targetRevision], ["target_not_empty", (await database.rows()).shared.revision]);
  assert.deepEqual(await createPostgresBusinessStateRepository({ store: database.store() }).readSnapshot(), document);

  // Records added later go after the imported ones, and a new candidate put first stays first.
  const repository = createPostgresBusinessStateRepository({ store: database.store() });
  await repository.transactCandidates(["C-1", "C-0"], async current => {
    current.dispatches.push({ id: "D-4", candidateId: "C-1" });
    current.candidates.unshift({ id: "C-0", dataRevision: 1 });
    return { changed: true, document: current };
  });
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.candidates.map(candidate => candidate.id), ["C-0", "C-1", "C-2"]);
  assert.deepEqual(saved.dispatches.map(dispatch => dispatch.id), ["D-1", "D-2", "D-3", "D-4"]);
});

test("a store opened from the database address makes its own pool and closes it", async t => {
  const database = await isolatedSchema(t);
  const store = createPostgresBusinessStateStore({ connectionString: database.connectionString(), maxConnections: 2 });
  try {
    assert.equal(await store.readRows(), null);
    assert.equal(await store.insertDocument(seed()), true);
    assert.equal((await createPostgresBusinessStateRepository({ store }).readSnapshot()).meta.title, "db test");
  } finally {
    await store.close();
  }
  assert.equal(await database.tableExists(), true);
});

test("a write whose COMMIT answer is lost after it landed is reported as saved, once", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const before = await database.rows();
  const repository = createPostgresBusinessStateRepository({ store: database.storeLosingCommitAnswer(send => send()) });
  assert.equal(await repository.transactCandidates(["C-1"], bump(7)), 7);
  const after = await database.rows();
  assert.notEqual(after.parts["C-1"].revision, before.parts["C-1"].revision);
  assert.deepEqual(after.parts["C-2"], before.parts["C-2"]);
  assert.equal((await createPostgresBusinessStateRepository({ store: database.store() }).readSnapshot()).candidates[0].dataRevision, 7);
});

test("a COMMIT that never reached the database is reported as failed and leaves the rows as they were", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const before = await database.rows();
  const repository = createPostgresBusinessStateRepository({ store: database.storeLosingCommitAnswer(async () => {}) });
  await assert.rejects(repository.transact(bump(7)), /Connection terminated unexpectedly/);
  assert.deepEqual(await database.rows(), before);
  // The connection went back to the pool clean: the next write goes through.
  assert.equal(await repository.transactCandidates(["C-1"], bump(8)), 8);
  assert.equal((await database.storedDocument()).candidates[0].dataRevision, 8);
});

test("when another write lands before the check, a lost COMMIT answer is reported as unknown", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const other = createPostgresBusinessStateRepository({ store: database.store() });
  const repository = createPostgresBusinessStateRepository({ store: database.storeLosingCommitAnswer(async send => {
    await send();
    await other.transactCandidates(["C-1"], bump(9));
  }) });
  await assert.rejects(repository.transactCandidates(["C-1"], bump(7)), error => error.message === "BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN" &&
    error.cause?.message === "Connection terminated unexpectedly");
  assert.equal((await database.storedDocument()).candidates[0].dataRevision, 9);
});

test("an import whose COMMIT answer is lost is reported by what the tables actually hold", async t => {
  const database = await isolatedSchema(t);
  // The COMMIT never reached the database: the import fails and the tables stay empty.
  await assert.rejects(database.storeLosingCommitAnswer(async () => {}).insertDocument(seed()), /Connection terminated unexpectedly/);
  assert.equal(await database.rows(), null);
  // The COMMIT landed but its answer was lost: the import is reported as done, once.
  assert.equal(await database.storeLosingCommitAnswer(send => send()).insertDocument(seed()), true);
  assert.equal(JSON.stringify(await database.storedDocument()), JSON.stringify(seed()));
});

test("waiting for a row another process holds has a deadline, and other candidates and later writes still go through", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const store = createPostgresBusinessStateStore({ connectionString: database.connectionString(), maxConnections: 3,
    timeouts: { lockMs: 200, statementMs: 2_000, queryMs: 5_000, idleInTransactionMs: 10_000 } });
  try {
    const repository = createPostgresBusinessStateRepository({ store });
    const candidateHolder = await database.holdRow("C-1");
    let started = performance.now();
    await assert.rejects(repository.transactCandidates(["C-1"], bump(7)), error => error.code === "55P03");
    assert.ok(performance.now() - started < 2_000);
    assert.equal(await repository.transactCandidates(["C-2"], bump(4)), 4);
    await candidateHolder.release();
    const sharedHolder = await database.holdRow();
    started = performance.now();
    await assert.rejects(repository.transactCandidates(["C-2"], bump(5)), error => error.code === "55P03");
    await assert.rejects(repository.transact(bump(5)), error => error.code === "55P03");
    assert.ok(performance.now() - started < 4_000);
    await sharedHolder.release();
    assert.equal(await repository.transactCandidates(["C-1"], bump(8)), 8);
    assert.deepEqual((await database.storedDocument()).candidates.map(candidate => candidate.dataRevision), [8, 4]);
  } finally {
    await store.close();
  }
});

test("one service process per stored document: a second process is refused until the first lets go", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const first = createPostgresBusinessStateRepository({ store: database.store() });
  const second = createPostgresBusinessStateRepository({ store: database.store() });
  const lease = await first.holdProcessLease({ onLost: () => assert.fail("not lost") });
  await assert.rejects(second.holdProcessLease({ onLost: () => {} }), /BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_HELD/);
  // The holder's own writes pass the database's check that its lease session still holds the lease.
  assert.equal(await first.transact(bump(3)), 3);
  assert.equal(await first.transactCandidates(["C-1"], bump(4)), 4);
  await lease.release();
  await assert.rejects(first.transactCandidates(["C-1"], bump(5)), /BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST/);
  const next = await second.holdProcessLease({ onLost: () => assert.fail("not lost") });
  assert.equal(await second.transact(bump(6)), 6);
  await next.release();
});

test("a process whose lease connection ends is told, and another process can take over", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const holder = createPostgresBusinessStateRepository({ store: database.store() });
  let lost;
  const told = new Promise(resolve => { lost = resolve; });
  await holder.holdProcessLease({ onLost: lost });
  assert.equal(await database.endLeaseConnection(), 1);
  await told;
  // The holder's other connections still work, but its writes are fenced off from now on.
  await assert.rejects(holder.transactCandidates(["C-1"], bump(4)), /BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST/);
  const successor = createPostgresBusinessStateRepository({ store: database.store() });
  const successorLease = await successor.holdProcessLease({ onLost: () => {} });
  assert.equal(await successor.transactCandidates(["C-1"], bump(5)), 5);
  assert.equal((await holder.readSnapshot()).candidates[0].dataRevision, 5);
  await successorLease.release();
});

test("a connection dropped in the middle of a write fails that write, not the process", async t => {
  const database = await isolatedSchema(t);
  await database.store().insertDocument(seed());
  const before = await database.rows();
  // The database ends a transaction left idle longer than this while the change is still being worked out.
  const store = createPostgresBusinessStateStore({ connectionString: database.connectionString(), maxConnections: 3,
    timeouts: { lockMs: 100, statementMs: 1_000, queryMs: 2_000, idleInTransactionMs: 200 } });
  try {
    const repository = createPostgresBusinessStateRepository({ store });
    await assert.rejects(repository.transactCandidates(["C-1"], async document => {
      await new Promise(resolve => setTimeout(resolve, 600));
      return bump(7)(document);
    }), /not queryable|terminat/u);
    assert.deepEqual(await database.rows(), before);
    assert.equal(await repository.transactCandidates(["C-1"], bump(8)), 8);
  } finally {
    await store.close();
  }
});
