import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { createPostgresBusinessStateRepository, initialBusinessStateDocument } from "../lib/business-state-repository.mjs";
import { importBusinessStateToPostgres } from "../lib/business-state-import.mjs";
import { BUSINESS_STATE_TABLE, createPostgresBusinessStateStore } from "../lib/postgres-business-state-store.mjs";

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
  const storedText = async () => (await admin.query(
    `SELECT document::text AS text, revision::text AS revision FROM ${schema}.${BUSINESS_STATE_TABLE}`)).rows[0] ?? null;
  const connectionString = () => `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const tableExists = async () => (await admin.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`${schema}.${BUSINESS_STATE_TABLE}`])).rows[0].exists;
  return { store, storedText, tableExists, connectionString };
}

const seed = () => ({ meta: { version: 2, title: "db test" }, candidates: [{ id: "C-1", dataRevision: 1 }], runtime: { operationAudit: [], idempotencyRecords: [] } });

test("two service processes writing at the same time lose no update", async t => {
  const database = await isolatedSchema(t);
  const first = database.store();
  assert.equal(await first.insertDocument(seed()), true);
  const repositories = [createPostgresBusinessStateRepository({ store: first }), createPostgresBusinessStateRepository({ store: database.store() })];
  await Promise.all(Array.from({ length: 40 }, (_, index) => repositories[index % 2].transact(async document => {
    const value = document.candidates[0].dataRevision;
    await new Promise(resolve => setTimeout(resolve, index % 3));
    document.candidates[0].dataRevision = value + 1;
    return { changed: true, document, result: null };
  })));
  for (const repository of repositories) assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 41);
  assert.equal((await database.storedText()).revision, "41");
  // A process that already read the current revision still sees the other process's next write.
  assert.equal((await repositories[0].readSnapshot()).candidates[0].dataRevision, 41);
  await repositories[1].transact(async document => {
    document.candidates[0].dataRevision = 42;
    return { changed: true, document };
  });
  assert.equal((await repositories[0].readSnapshot()).candidates[0].dataRevision, 42);
});

test("a failed mutator or an invalid result leaves the row and its revision as they were", async t => {
  const database = await isolatedSchema(t);
  const store = database.store();
  await store.insertDocument(seed());
  const repository = createPostgresBusinessStateRepository({ store });
  const before = await database.storedText();
  await assert.rejects(repository.transact(async document => {
    document.candidates[0].dataRevision = 5;
    throw new Error("MUTATOR_FAILED");
  }), /MUTATOR_FAILED/);
  await assert.rejects(repository.transact(async () => ({ changed: true, document: [] })), /TRANSACTION_DOCUMENT_REQUIRED/);
  assert.deepEqual(await database.storedText(), before);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 1);
});

test("the stored text keeps key order and values exactly as written", async t => {
  const database = await isolatedSchema(t);
  const store = database.store();
  const document = { runtime: { idempotencyRecords: [], operationAudit: [] }, meta: { version: 2, zeta: 1, alpha: "é ✓ \"q\"" },
    candidates: [{ z: 1, a: 2, price: 12.5, nested: { b: null, a: [3, 2, 1] } }] };
  await store.insertDocument(document);
  assert.equal((await database.storedText()).text, JSON.stringify(document));
  const repository = createPostgresBusinessStateRepository({ store });
  await repository.transact(async current => {
    current.candidates[0].price = 13;
    return { changed: true, document: current };
  });
  const expected = structuredClone(document);
  expected.candidates[0].price = 13;
  assert.equal((await database.storedText()).text, JSON.stringify(expected));
  assert.deepEqual(Object.keys((await repository.readSnapshot()).candidates[0]), ["z", "a", "price", "nested"]);
});

test("reading never creates the document; initialization keeps a row only after a real change", async t => {
  const database = await isolatedSchema(t);
  const strict = createPostgresBusinessStateRepository({ store: database.store() });
  await assert.rejects(strict.readSnapshot(), /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);
  const repository = createPostgresBusinessStateRepository({ store: database.store(), initializeIfMissing: true,
    initialDocument: () => initialBusinessStateDocument({ now: "2026-10-15T00:00:00.000Z" }) });
  assert.equal((await repository.readSnapshot()).meta.date, "2026-10-15");
  await repository.transact(async () => ({ changed: false, result: null }));
  assert.equal(await database.storedText(), null);
  await repository.transact(async document => ({ changed: true, document: { ...document, candidates: [{ id: "C-9" }] } }));
  assert.equal((await database.storedText()).revision, "2");
  assert.deepEqual((await strict.readSnapshot()).candidates, [{ id: "C-9" }]);
});

test("the import dry run creates nothing; a write fills an empty target once and refuses to overwrite", async t => {
  const database = await isolatedSchema(t);
  const document = { ...seed(), candidates: [{ id: "C-1", dataRevision: 1 }, { id: "C-2", dataRevision: 4 }], dispatches: [] };
  const text = JSON.stringify(document, null, 2);
  const options = { sourceFile: "/synthetic/business-state.json", readSource: async () => text, store: database.store() };
  const dryRun = await importBusinessStateToPostgres(options);
  assert.deepEqual([dryRun.status, dryRun.tableExists, dryRun.candidates], ["dry_run_ready", false, 2]);
  assert.equal(await database.tableExists(), false);
  assert.equal((await importBusinessStateToPostgres({ ...options, write: true })).status, "imported");
  assert.equal((await database.storedText()).text, JSON.stringify(document));
  const again = await importBusinessStateToPostgres({ ...options, write: true });
  assert.deepEqual([again.status, again.targetRevision], ["target_not_empty", "1"]);
  assert.deepEqual(await createPostgresBusinessStateRepository({ store: database.store() }).readSnapshot(), document);
});

test("a store opened from the database address makes its own pool and closes it", async t => {
  const database = await isolatedSchema(t);
  const store = createPostgresBusinessStateStore({ connectionString: database.connectionString(), maxConnections: 2 });
  try {
    assert.equal(await store.readDocument(), null);
    assert.equal(await store.insertDocument(seed()), true);
    assert.equal((await createPostgresBusinessStateRepository({ store }).readSnapshot()).meta.title, "db test");
  } finally {
    await store.close();
  }
  assert.equal(await database.tableExists(), true);
});
