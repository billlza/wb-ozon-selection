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
  BUSINESS_STATE_CANDIDATE_TABLE,
  BUSINESS_STATE_KEY_TABLE,
  BUSINESS_STATE_SHARED_TABLE,
  POSTGRES_BUSINESS_STATE_TIMEOUTS,
  createPostgresBusinessStateStore,
  isPostgresConnectionString
} from "../lib/postgres-business-state-store.mjs";
import { createRepositoryRuntimeHealth } from "../lib/runtime-health.mjs";
import { createFakePostgresBusinessStateStore } from "./helpers/fake-postgres-business-state-store.mjs";

const CONFIGURATION = Object.freeze({ schemaVersion: "selection-review-runtime-configuration-v1", stateAdapter: "postgres", initializeDataFile: false });
const DATABASE_URL = "postgres://review:not-a-real-password@db.internal.example:5432/review";

const SHARED = (document = { meta: { version: 2 } }, positions = {}) => ({ schemaVersion: "business-state-shared-part-v1", document, positions });
const PART = (candidateId, collections) => ({ schemaVersion: "business-state-candidate-part-v1", candidateId, collections });
const candidatePart = (candidateId, extra = {}) => PART(candidateId, { candidates: { positions: [1], records: [{ id: candidateId, ...extra }] } });

// Answers the store's statements by kind and keeps the rows (shared row, candidate rows, key rows, the two sequences); a
// ROLLBACK that goes through restores them as they were at BEGIN. Failures are injected per kind; `rows` overrides what
// a kind returns.
function fakePool({ shared = null, parts = [], keys = [], fail = {}, rows = {}, lease = { acquired: true, held: true } } = {}) {
  const statements = [];
  const released = [];
  let sequence = 100;
  const copy = state => ({ shared: state.shared && { ...state.shared }, parts: new Map(state.parts), keys: new Map(state.keys) });
  let state = {
    shared: shared && { value: shared, revision: "1" },
    parts: new Map(parts.map(part => [part.candidateId, { value: part, revision: "2" }])),
    keys: new Map(keys.map(([kind, key, owner]) => [`${kind}\u0000${key}`, owner]))
  };
  let atBegin = copy(state);
  const json = value => JSON.parse(JSON.stringify(value));
  function kindOf(text) {
    if (text.includes("pg_try_advisory_lock")) return "LEASE";
    if (text.includes("pg_locks")) return "LEASE_CHECK";
    if (text.includes("pg_advisory_unlock")) return "UNLOCK";
    if (text.startsWith("CREATE")) return "CREATE";
    if (text.startsWith("BEGIN")) return "BEGIN";
    if (text === "COMMIT" || text === "ROLLBACK") return text;
    if (text.includes("to_regclass")) return "INSPECT_TABLE";
    if (text.includes("generate_series")) return "POSITIONS";
    if (text.startsWith(`DELETE FROM ${BUSINESS_STATE_KEY_TABLE}`)) return "KEYS_REMOVE";
    if (text.startsWith(`INSERT INTO ${BUSINESS_STATE_KEY_TABLE}`)) return "KEYS_ADD";
    if (text.startsWith(`SELECT k.kind FROM ${BUSINESS_STATE_KEY_TABLE}`)) return "KEYS_CHECK";
    if (text.startsWith(`INSERT INTO ${BUSINESS_STATE_SHARED_TABLE}`)) return "INSERT_SHARED";
    if (text.startsWith(`UPDATE ${BUSINESS_STATE_SHARED_TABLE}`)) return "UPDATE_SHARED";
    if (text.startsWith(`DELETE FROM ${BUSINESS_STATE_CANDIDATE_TABLE}`)) return "DELETE_PARTS";
    if (text.startsWith(`UPDATE ${BUSINESS_STATE_CANDIDATE_TABLE}`)) return "UPDATE_PARTS";
    if (text.startsWith(`INSERT INTO ${BUSINESS_STATE_CANDIDATE_TABLE}`)) return "INSERT_PARTS";
    if (text.includes("shared::text AS text")) return "SETTLE_SHARED";
    if (text.includes("part::text AS text")) return "SETTLE_PARTS";
    if (text.startsWith("SELECT revision::text AS revision, CASE")) return "SELECT_SHARED";
    if (text.startsWith("SELECT p.candidate_id")) return "SELECT_PARTS";
    if (text.startsWith("SELECT shared FROM")) return "READBACK_SHARED";
    if (text.startsWith("SELECT candidate_id, part FROM")) return "READBACK_PARTS";
    if (text.startsWith("SELECT revision::text AS revision FROM")) return "INSPECT_REVISION";
    return text.split(" ")[0];
  }
  const next = () => String(++sequence);
  async function answer(sql, params = []) {
    const text = sql.replace(/\s+/gu, " ").trim();
    const kind = kindOf(text);
    statements.push({ kind, text, params });
    const failure = Array.isArray(fail[kind]) ? fail[kind].shift() : fail[kind];
    if (failure) throw typeof failure === "function" ? failure() : failure;
    if (rows[kind]) return rows[kind](params);
    switch (kind) {
      case "LEASE": return { rows: [{ acquired: lease.acquired, pid: 42 }] };
      case "LEASE_CHECK": return { rows: [{ held: lease.held && params[2] === 42 }] };
      case "BEGIN": atBegin = copy(state); return { rows: [] };
      case "ROLLBACK": state = copy(atBegin); return { rows: [] };
      case "POSITIONS": return { rows: Array.from({ length: params[0] }, () => ({ position: next() })) };
      case "SELECT_SHARED": {
        if (!state.shared) return { rows: [] };
        const unchanged = params[1] === state.shared.revision;
        return { rows: [{ revision: state.shared.revision, value: unchanged ? null : json(state.shared.value) }] };
      }
      case "SELECT_PARTS": {
        const known = new Map(params[1].map((id, index) => [id, params[2][index]]));
        return { rows: [...state.parts].filter(([id]) => params[3] === null || params[3].includes(id)).sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, row]) => ({ candidate_id: id, revision: row.revision, value: known.get(id) === row.revision ? null : json(row.value) })) };
      }
      case "INSERT_SHARED": {
        if (state.shared) return { rowCount: 0, rows: [] };
        state.shared = { value: JSON.parse(params[1]), revision: next() };
        return { rowCount: 1, rows: [{ revision: state.shared.revision }] };
      }
      case "UPDATE_SHARED":
        state.shared = { value: JSON.parse(params[1]), revision: next() };
        return { rows: [{ revision: state.shared.revision }] };
      case "KEYS_REMOVE":
        params[1].forEach((kindName, index) => {
          const key = `${kindName}\u0000${params[2][index]}`;
          if (state.keys.get(key) === params[3]) state.keys.delete(key);
        });
        return { rows: [] };
      case "KEYS_ADD": {
        const owners = params.length === 4 && Array.isArray(params[3]) ? params[3] : null;
        params[1].forEach((kindName, index) => {
          const key = `${kindName}\u0000${params[2][index]}`;
          if (!state.keys.has(key)) state.keys.set(key, owners ? owners[index] : params[3]);
        });
        return { rows: [] };
      }
      case "KEYS_CHECK": {
        const found = params[1].map((kindName, index) => [kindName, state.keys.get(`${kindName}\u0000${params[2][index]}`)])
          .find(([, owner]) => owner !== undefined && owner !== params[3]);
        return { rows: found ? [{ kind: found[0] }] : [] };
      }
      case "DELETE_PARTS":
        for (const id of params[1]) state.parts.delete(id);
        return { rows: [] };
      case "UPDATE_PARTS":
      case "INSERT_PARTS": {
        const written = [];
        params[1].forEach((id, index) => {
          if (state.parts.has(id) !== (kind === "UPDATE_PARTS")) return;
          state.parts.set(id, { value: JSON.parse(params[2][index]), revision: next() });
          written.push({ candidate_id: id, revision: state.parts.get(id).revision });
        });
        return { rows: written };
      }
      case "SETTLE_SHARED":
        return { rows: state.shared ? [{ revision: state.shared.revision, text: JSON.stringify(state.shared.value) }] : [] };
      case "SETTLE_PARTS":
        return { rows: params[1].filter(id => state.parts.has(id))
          .map(id => ({ candidate_id: id, revision: state.parts.get(id).revision, text: JSON.stringify(state.parts.get(id).value) })) };
      case "READBACK_SHARED": return { rows: [{ shared: json(state.shared.value) }] };
      case "READBACK_PARTS": return { rows: [...state.parts].map(([id, row]) => ({ candidate_id: id, part: json(row.value) })) };
      case "INSPECT_TABLE": return { rows: [{ exists: true }] };
      case "INSPECT_REVISION": return { rows: state.shared ? [{ revision: state.shared.revision }] : [] };
      default: return { rows: [], rowCount: 0 };
    }
  }
  const client = Object.assign(new EventEmitter(), { query: answer, release(error) { released.push(error ?? null); } });
  const pool = { query: answer, async connect() { return client; } };
  return { pool, client, lease, statements, released, kinds: () => statements.map(statement => statement.kind),
    stored: () => state, from: kind => statements.filter(statement => statement.kind === kind) };
}
const SCHEMA_STATEMENTS = 5;
const afterSchema = fake => fake.kinds().slice(SCHEMA_STATEMENTS);

const noKeys = Object.freeze({ added: [], removed: [] });
const writeParts = entries => ({ write }) => write({ shared: null, parts: new Map(entries.map(([candidateId, value, keys = noKeys]) =>
  [candidateId, { value, keys }])) });

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

  const fake = fakePool({ shared: SHARED(), parts: [candidatePart("C-1")] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool, documentId: "state-a" });
  await store.runLocked({ candidateIds: ["C-1"] }, writeParts([["C-1", candidatePart("C-1", { note: "it's \"quoted\"" }),
    { added: ["idempotency\u0000k'1"], removed: [] }]]));
  const tables = [BUSINESS_STATE_SHARED_TABLE, BUSINESS_STATE_CANDIDATE_TABLE, BUSINESS_STATE_KEY_TABLE];
  for (const statement of fake.statements) {
    assert.doesNotMatch(statement.text, /state-a|quoted|C-1|k'1/u);
    if (statement.kind !== "CREATE" && tables.some(table => statement.text.includes(table))) assert.equal(statement.params[0], "state-a");
  }
  assert.equal(JSON.parse(fake.from("UPDATE_PARTS")[0].params[2][0]).collections.candidates.records[0].note, "it's \"quoted\"");
});

test("a whole-document transaction locks the shared row, reads every candidate row and writes only the rows that changed", async () => {
  const fake = fakePool({ shared: SHARED(), parts: [candidatePart("C-1"), candidatePart("C-2")] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  const result = await store.runLocked({}, async work => {
    assert.equal(work.shared.revision, "1");
    assert.deepEqual(work.parts.map(part => part.candidateId), ["C-1", "C-2"]);
    writeParts([["C-2", candidatePart("C-2", { n: 1 })]])(work);
    return "saved";
  });
  assert.equal(result, "saved");
  assert.deepEqual(afterSchema(fake), ["BEGIN", "SELECT_SHARED", "SELECT_PARTS", "UPDATE_PARTS", "COMMIT"]);
  assert.match(fake.from("SELECT_SHARED")[0].text, /FOR UPDATE$/u);
  assert.equal(fake.from("SELECT_PARTS")[0].params[3], null);
  assert.doesNotMatch(fake.from("SELECT_PARTS")[0].text, /FOR UPDATE/u);
  assert.deepEqual(fake.from("UPDATE_PARTS")[0].params[1], ["C-2"]);
  assert.equal(fake.stored().parts.get("C-1").revision, "2");
  assert.deepEqual(fake.released, [null]);

  await store.runLocked({}, () => "read only");
  assert.deepEqual(afterSchema(fake).slice(5), ["BEGIN", "SELECT_SHARED", "SELECT_PARTS", "COMMIT"]);
});

test("a single-candidate transaction shares the shared row's lock and locks, reads and writes only its own rows", async () => {
  const fake = fakePool({ shared: SHARED(), parts: [candidatePart("C-1"), candidatePart("C-2"), candidatePart("C-3")] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  await store.runLocked({ candidateIds: ["C-1", "C-3"] }, work => {
    assert.deepEqual(work.parts.map(part => part.candidateId), ["C-1", "C-3"]);
    writeParts([["C-1", candidatePart("C-1", { n: 1 }), { added: ["dispatch\u0000D-1"], removed: [] }], ["C-3", null]])(work);
  });
  assert.deepEqual(afterSchema(fake), ["BEGIN", "SELECT_SHARED", "SELECT_PARTS", "KEYS_ADD", "KEYS_CHECK", "DELETE_PARTS",
    "UPDATE_PARTS", "COMMIT"]);
  assert.match(fake.from("SELECT_SHARED")[0].text, /FOR SHARE$/u);
  assert.match(fake.from("SELECT_PARTS")[0].text, /FOR UPDATE OF p$/u);
  assert.deepEqual(fake.from("SELECT_PARTS")[0].params[3], ["C-1", "C-3"]);
  assert.deepEqual([...fake.stored().parts.keys()], ["C-1", "C-2"]);
  assert.equal(fake.stored().keys.get("dispatch\u0000D-1"), "C-1");

  // Anything outside the candidates it locked (another candidate, the shared row) is refused before a row is written.
  for (const change of [writeParts([["C-2", candidatePart("C-2", { n: 2 })]]),
    ({ write }) => write({ shared: { value: SHARED({ meta: { version: 2 }, rules: {} }), keys: noKeys }, parts: new Map() })]) {
    const before = fake.statements.length;
    await assert.rejects(store.runLocked({ candidateIds: ["C-1"] }, change), /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:store/);
    assert.deepEqual(fake.kinds().slice(before), ["BEGIN", "SELECT_SHARED", "SELECT_PARTS", "ROLLBACK"]);
  }
  assert.equal(fake.stored().parts.get("C-2").revision, "2");
});

test("a key another candidate holds stops the write; a key moving between candidates in one write does not", async () => {
  const fake = fakePool({ shared: SHARED(), parts: [candidatePart("C-1"), candidatePart("C-2")],
    keys: [["idempotency", "K-1", "C-2"], ["software_job", "J-1", ""]] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  const claim = key => store.runLocked({ candidateIds: ["C-1"] },
    writeParts([["C-1", candidatePart("C-1", { n: 2 }), { added: [key], removed: [] }]]));
  await assert.rejects(claim("idempotency\u0000K-1"),
    error => error.message === "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" && error.code === "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT");
  await assert.rejects(claim("software_job\u0000J-1"),
    error => error.message === "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT:software_job" && error.code === "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT");
  assert.equal(fake.kinds().at(-1), "ROLLBACK");
  assert.equal(fake.stored().parts.get("C-1").value.collections.candidates.records[0].n, undefined);
  assert.equal(fake.stored().keys.get("idempotency\u0000K-1"), "C-2");

  await store.runLocked({}, writeParts([["C-1", candidatePart("C-1", { n: 3 }), { added: ["idempotency\u0000K-1"], removed: [] }],
    ["C-2", candidatePart("C-2", { n: 3 }), { added: [], removed: ["idempotency\u0000K-1"] }]]));
  assert.equal(fake.stored().keys.get("idempotency\u0000K-1"), "C-1");
  const order = fake.kinds();
  assert.ok(order.lastIndexOf("KEYS_REMOVE") < order.lastIndexOf("KEYS_ADD"));
});

test("failed work rolls back; a failed rollback closes the connection instead of reusing it", async () => {
  const fake = fakePool({ shared: SHARED(), parts: [candidatePart("C-1")] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  await assert.rejects(store.runLocked({}, work => { writeParts([["C-1", null]])(work); throw new Error("MUTATOR_FAILED"); }), /MUTATOR_FAILED/);
  assert.deepEqual(afterSchema(fake), ["BEGIN", "SELECT_SHARED", "SELECT_PARTS", "ROLLBACK"]);
  assert.deepEqual(fake.released, [null]);

  const broken = new Error("connection lost");
  const failing = fakePool({ shared: SHARED(), parts: [candidatePart("C-1")], fail: { UPDATE_PARTS: new Error("UPDATE_FAILED"), ROLLBACK: broken } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: failing.pool }).runLocked({},
    writeParts([["C-1", candidatePart("C-1", { n: 1 })]])), /UPDATE_FAILED/);
  assert.deepEqual(failing.kinds().slice(-2), ["UPDATE_PARTS", "ROLLBACK"]);
  assert.deepEqual(failing.released, [broken]);

  // Past the client deadline the statement may still be running: the connection is closed, no ROLLBACK is queued behind it.
  const deadline = new Error("Query read timeout");
  const stalled = fakePool({ shared: SHARED(), fail: { BEGIN: deadline } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: stalled.pool }).runLocked({}, () => "never"), /Query read timeout/);
  assert.deepEqual(afterSchema(stalled), ["BEGIN"]);
  assert.deepEqual(stalled.released, [deadline]);
});

test("a lost COMMIT answer is settled from the rows: saved, not saved, or reported as unknown", async () => {
  const start = () => ({ shared: SHARED(), parts: [candidatePart("C-1")] });
  const bump = work => { writeParts([["C-1", candidatePart("C-1", { n: 2 })]])(work); return "saved"; };
  const lost = () => new Error("Connection terminated unexpectedly");
  const closed = () => new Error("Client was closed");

  // The database committed but the answer never arrived (the connection is gone, so the rollback fails too).
  const landed = fakePool({ ...start(), fail: { COMMIT: [lost()], ROLLBACK: [closed()] } });
  assert.equal(await createPostgresBusinessStateStore({ pool: landed.pool }).runLocked({ candidateIds: ["C-1"] }, bump), "saved");
  assert.deepEqual(landed.kinds().slice(-7), ["UPDATE_PARTS", "COMMIT", "ROLLBACK", "BEGIN", "SETTLE_SHARED", "SETTLE_PARTS", "COMMIT"]);
  // Taking the shared row exclusively waits for every transaction still holding it, a COMMIT in flight included.
  assert.match(landed.from("SETTLE_SHARED")[0].text, /FOR UPDATE$/u);
  assert.deepEqual(landed.from("SETTLE_PARTS")[0].params[1], ["C-1"]);

  // The COMMIT never took effect: every row is as the transaction found it, so the original failure stands.
  const missedFailure = lost();
  const missed = fakePool({ ...start(), fail: { COMMIT: [missedFailure] } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: missed.pool }).runLocked({}, bump), error => error === missedFailure);

  // Rows this transaction inserted and never committed are simply absent.
  const firstFailure = lost();
  const first = fakePool({ fail: { COMMIT: [firstFailure] } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: first.pool })
    .runLocked({ initialShared: () => SHARED() }, bump), error => error === firstFailure);

  // Another write changed the row before the check, or the rows cannot be read back: neither answer is safe.
  const raced = fakePool({ ...start(), fail: { COMMIT: [lost()], ROLLBACK: [closed()] },
    rows: { SETTLE_PARTS: () => ({ rows: [{ candidate_id: "C-1", revision: "999", text: "{}" }] }) } });
  const unknownFailure = lost();
  const unreadable = fakePool({ ...start(), fail: { COMMIT: [unknownFailure], ROLLBACK: [closed()], SETTLE_SHARED: lost() } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: raced.pool }).runLocked({}, bump),
    error => error.message === "BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN");
  await assert.rejects(createPostgresBusinessStateStore({ pool: unreadable.pool }).runLocked({}, bump),
    error => error.message === "BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN" && error.cause === unknownFailure);

  // The import insert settles a lost COMMIT answer the same way.
  const document = { meta: { version: 2 }, candidates: [{ id: "C-1" }] };
  const imported = fakePool({ fail: { COMMIT: [lost()], ROLLBACK: [closed()] } });
  assert.equal(await createPostgresBusinessStateStore({ pool: imported.pool }).insertDocument(document), true);
  assert.deepEqual(imported.kinds().slice(-3), ["SETTLE_SHARED", "SETTLE_PARTS", "COMMIT"]);
  const notImportedFailure = lost();
  const notImported = fakePool({ fail: { COMMIT: [notImportedFailure] } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: notImported.pool }).insertDocument(document),
    error => error === notImportedFailure);

  // A read-only transaction has nothing to settle.
  const quiet = fakePool({ ...start(), fail: { COMMIT: [lost()] } });
  await assert.rejects(createPostgresBusinessStateStore({ pool: quiet.pool }).runLocked({}, () => "looked"), /Connection terminated/);
  assert.equal(quiet.kinds().includes("SETTLE_SHARED"), false);
});

test("a missing shared row fails without a starting part, and a started row is kept only when work writes", async () => {
  const empty = fakePool();
  await assert.rejects(createPostgresBusinessStateStore({ pool: empty.pool }).runLocked({}, () => "never"), /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);
  assert.deepEqual(afterSchema(empty), ["BEGIN", "SELECT_SHARED", "ROLLBACK"]);

  const unchanged = fakePool();
  await createPostgresBusinessStateStore({ pool: unchanged.pool }).runLocked({ initialShared: () => SHARED() }, () => "looked");
  assert.deepEqual(afterSchema(unchanged), ["BEGIN", "SELECT_SHARED", "INSERT_SHARED", "SELECT_SHARED", "SELECT_PARTS", "ROLLBACK"]);
  assert.equal(unchanged.stored().shared, null);

  const changed = fakePool();
  await createPostgresBusinessStateStore({ pool: changed.pool }).runLocked({ initialShared: () => SHARED() },
    writeParts([["C-1", candidatePart("C-1")]]));
  assert.deepEqual(afterSchema(changed), ["BEGIN", "SELECT_SHARED", "INSERT_SHARED", "SELECT_SHARED", "SELECT_PARTS", "INSERT_PARTS", "COMMIT"]);
  assert.deepEqual([...changed.stored().parts.keys()], ["C-1"]);
});

test("the tables are created once; a concurrent creator is tolerated and other failures are retried next time", async () => {
  const duplicate = code => () => Object.assign(new Error("duplicate"), { code });
  const raced = fakePool({ shared: SHARED(), fail: { CREATE: [null, duplicate("42P07"), null, duplicate("23505")] } });
  const store = createPostgresBusinessStateStore({ pool: raced.pool });
  await store.readRows();
  await store.readRows();
  // A creation race on one object does not skip the ones after it.
  assert.deepEqual(raced.kinds(), ["CREATE", "CREATE", "CREATE", "CREATE", "CREATE",
    "BEGIN", "SELECT_SHARED", "SELECT_PARTS", "COMMIT", "BEGIN", "SELECT_SHARED", "SELECT_PARTS", "COMMIT"]);
  assert.match(raced.statements[5].text, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/u);

  const down = fakePool({ fail: { CREATE: [() => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })] } });
  const retrying = createPostgresBusinessStateStore({ pool: down.pool });
  await assert.rejects(retrying.readRows(), /connection refused/);
  assert.equal(await retrying.readRows(), null);
  assert.deepEqual(down.kinds(), ["CREATE", "CREATE", "CREATE", "CREATE", "CREATE", "CREATE", "BEGIN", "SELECT_SHARED", "COMMIT"]);
});

test("reads skip the rows whose revision the caller already has, and can ask for some candidates only", async () => {
  const fake = fakePool({ shared: SHARED({ meta: { version: 2 }, value: 1 }), parts: [candidatePart("C-1"), candidatePart("C-2")] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  const all = await store.readRows();
  assert.deepEqual(all.shared, { revision: "1", value: SHARED({ meta: { version: 2 }, value: 1 }) });
  assert.deepEqual(all.parts.map(part => [part.candidateId, part.revision, part.value.candidateId]), [["C-1", "2", "C-1"], ["C-2", "2", "C-2"]]);
  const known = await store.readRows({ known: { shared: "1", parts: new Map([["C-1", "2"], ["C-2", "1"]]) } });
  assert.deepEqual(known.shared, { revision: "1" });
  assert.deepEqual(known.parts.map(part => Object.hasOwn(part, "value")), [false, true]);
  const some = await store.readRows({ candidateIds: ["C-2", "C-9"] });
  assert.deepEqual(some.parts.map(part => part.candidateId), ["C-2"]);
  assert.deepEqual(fake.from("SELECT_PARTS").at(-1).params[3], ["C-2", "C-9"]);
});

test("the import insert never overwrites, gives the first holder a shared key, and a failed read-back check rolls back", async () => {
  const occupied = fakePool({ shared: SHARED() });
  assert.equal(await createPostgresBusinessStateStore({ pool: occupied.pool }).insertDocument({ meta: { version: 2 } }), false);
  assert.deepEqual(afterSchema(occupied), ["BEGIN", "INSERT_SHARED", "ROLLBACK"]);

  const empty = fakePool();
  await assert.rejects(createPostgresBusinessStateStore({ pool: empty.pool }).insertDocument({ meta: { version: 2 }, candidates: [{ id: "C-1" }] }, {
    verify: async () => { throw new Error("READBACK_MISMATCH"); }
  }), /READBACK_MISMATCH/);
  assert.deepEqual(afterSchema(empty), ["BEGIN", "POSITIONS", "INSERT_SHARED", "KEYS_ADD", "INSERT_PARTS", "READBACK_SHARED", "READBACK_PARTS", "ROLLBACK"]);
  assert.equal(empty.stored().shared, null);
  await assert.rejects(createPostgresBusinessStateStore({ pool: fakePool().pool }).insertDocument([]), /DOCUMENT_INVALID/);

  // Saved before keys were checked, two candidates may share an idempotency key: the import keeps both, the first holds it.
  const document = { meta: { version: 2 }, candidates: [{ id: "C-1" }, { id: "C-2" }],
    runtime: { idempotencyRecords: [{ candidateId: "C-1", idempotencyKey: "K" }, { candidateId: "C-2", idempotencyKey: "K" }] } };
  const target = fakePool();
  const store = createPostgresBusinessStateStore({ pool: target.pool });
  let verified = null;
  assert.equal(await store.insertDocument(document, { verify: async stored => { verified = stored; } }), true);
  assert.deepEqual(verified, document);
  assert.equal(target.stored().keys.get("idempotency\u0000K"), "C-1");
  assert.deepEqual(await createPostgresBusinessStateRepository({ store }).readSnapshot(), document);
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

test("Postgres snapshots re-check every row's revision, re-parse only rows that changed, and never share objects", async () => {
  const store = createFakePostgresBusinessStateStore({ document: { meta: { version: 2 },
    candidates: [{ id: "C-1", dataRevision: 1 }, { id: "C-2", dataRevision: 1 }] } });
  const repository = createPostgresBusinessStateRepository({ store });
  const first = await repository.readSnapshot();
  first.candidates[0].dataRevision = 99;
  const second = await repository.readSnapshot();
  assert.equal(second.candidates[0].dataRevision, 1);
  // The shared row and both candidate rows once; nothing on the second read.
  assert.deepEqual([store.calls.reads, store.calls.rowTransfers], [2, 3]);
  await repository.transactCandidates(["C-1"], async document => {
    document.candidates[0].dataRevision = 2;
    return { changed: true, document, result: null };
  });
  assert.deepEqual((await repository.readSnapshot()).candidates.map(candidate => candidate.dataRevision), [2, 1]);
  // The single-candidate transaction locked only C-1's row (and, its cached copy being current, was not even sent it);
  // the read after it fetched only C-1's new row.
  assert.deepEqual(store.calls.lockedCandidateIds, [["C-1"]]);
  assert.deepEqual([store.calls.reads, store.calls.rowTransfers], [3, 4]);
});

test("a single-candidate read or transaction sees only its candidates and the shared part, and may change only them", async () => {
  const document = { meta: { version: 2 }, rules: { margin: 1 }, candidates: [{ id: "C-1", dataRevision: 1 }, { id: "C-2", dataRevision: 1 }],
    dispatches: [{ id: "D-1", candidateId: "C-2" }, { id: "D-0", candidateId: null }] };
  const store = createFakePostgresBusinessStateStore({ document });
  const repository = createPostgresBusinessStateRepository({ store });
  const view = await repository.readCandidates(["C-1"]);
  assert.deepEqual(view.candidates.map(candidate => candidate.id), ["C-1"]);
  assert.deepEqual(view.dispatches.map(dispatch => dispatch.id), ["D-0"]);
  assert.deepEqual(view.rules, { margin: 1 });
  assert.deepEqual((await repository.readCandidates([])).candidates, []);

  const attempts = [
    current => { current.rules.margin = 2; },
    current => { current.dispatches.push({ id: "D-2", candidateId: "C-2" }); },
    current => { current.dispatches[0].note = "shared record"; }
  ];
  for (const change of attempts) {
    await assert.rejects(repository.transactCandidates(["C-1"], async current => {
      change(current);
      return { changed: true, document: current, result: null };
    }), /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION/);
  }
  await repository.transactCandidates(["C-1"], async current => {
    current.candidates[0].dataRevision = 2;
    current.dispatches.unshift({ id: "D-3", candidateId: "C-1" });
    return { changed: true, document: current, result: null };
  });
  const saved = store.storedDocument();
  assert.deepEqual(saved.candidates.map(candidate => [candidate.id, candidate.dataRevision]), [["C-1", 2], ["C-2", 1]]);
  assert.deepEqual(saved.dispatches.map(dispatch => dispatch.id), ["D-3", "D-1", "D-0"]);
  assert.throws(() => repository.transactCandidates([""], async () => ({ changed: false })), /BUSINESS_STATE_REPOSITORY_SCOPE_INVALID/);
});

test("a read that finishes after a newer read answers from the rows it asked about", async () => {
  const shared = SHARED({ meta: { version: 2 }, candidates: [] }, { candidates: [] });
  const answers = [];
  const store = { readRows: ({ known }) => new Promise(resolve => answers.push({ known, resolve })),
    async runLocked() { throw new Error("NOT_USED"); } };
  const repository = createPostgresBusinessStateRepository({ store });
  const first = repository.readSnapshot();
  answers.shift().resolve({ shared: { revision: "1", value: shared }, parts: [{ candidateId: "C-1", revision: "2",
    value: candidatePart("C-1", { dataRevision: 1 }) }] });
  await first;
  const slower = repository.readSnapshot();
  const faster = repository.readSnapshot();
  const [slowerQuery, fasterQuery] = answers.splice(0);
  assert.deepEqual([slowerQuery.known.parts.get("C-1"), fasterQuery.known.parts.get("C-1")], ["2", "2"]);
  // Another process wrote C-1 again between the two queries; the faster one sees it and replaces the cached row first.
  fasterQuery.resolve({ shared: { revision: "1" }, parts: [{ candidateId: "C-1", revision: "3", value: candidatePart("C-1", { dataRevision: 2 }) }] });
  assert.equal((await faster).candidates[0].dataRevision, 2);
  slowerQuery.resolve({ shared: { revision: "1" }, parts: [{ candidateId: "C-1", revision: "2" }] });
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
  const fake = fakePool({ shared: SHARED(), parts: [candidatePart("C-1")] });
  const store = createPostgresBusinessStateStore({ pool: fake.pool });
  const bump = writeParts([["C-1", candidatePart("C-1", { n: 1 })]]);
  await store.runLocked({ candidateIds: ["C-1"] }, bump);
  assert.equal(fake.kinds().includes("LEASE_CHECK"), false);
  let lost = 0;
  const lease = await store.acquireProcessLease({ onLost: () => { lost += 1; } });
  await assert.rejects(store.acquireProcessLease({ onLost: () => {} }), /LEASE_ALREADY_TAKEN/);
  await store.runLocked({ candidateIds: ["C-1"] }, bump);
  assert.deepEqual(fake.kinds().slice(-6), ["BEGIN", "SELECT_SHARED", "LEASE_CHECK", "SELECT_PARTS", "UPDATE_PARTS", "COMMIT"]);
  assert.deepEqual(fake.from("LEASE_CHECK").at(-1).params, [1_397_904_945, "business-state", 42]);

  // The lease session lost the lock before this process heard about it: the write stops under the shared row's lock.
  fake.lease.held = false;
  await assert.rejects(store.runLocked({}, bump), /BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_LOST/);
  assert.deepEqual(fake.kinds().slice(-4), ["BEGIN", "SELECT_SHARED", "LEASE_CHECK", "ROLLBACK"]);
  // From then on the store refuses at once, without asking the database.
  const asked = fake.statements.length;
  await assert.rejects(store.runLocked({ candidateIds: ["C-1"] }, bump), /PROCESS_LEASE_LOST/);
  assert.equal(fake.statements.length, asked);
  assert.equal(lost, 0);
  await lease.release();
  assert.equal(fake.kinds().at(-1), "UNLOCK");

  // When the lease connection itself ends, the holder is told and its writes stop.
  const dropped = fakePool({ shared: SHARED(), parts: [candidatePart("C-1")] });
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
  await assert.rejects(createPostgresBusinessStateRepository({ store: missing }).readCandidates(["C-1"]), /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);
  await assert.rejects(createPostgresBusinessStateRepository({ store: missing }).transact(async document => ({ changed: true, document })),
    /BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING/);

  const repository = createPostgresBusinessStateRepository({ store: missing, initializeIfMissing: true,
    initialDocument: () => initialBusinessStateDocument({ now: "2026-10-15T00:00:00.000Z" }) });
  assert.equal((await repository.readSnapshot()).meta.date, "2026-10-15");
  assert.deepEqual((await repository.readCandidates(["C-1"])).candidates, []);
  await repository.transact(async () => ({ changed: false, result: null }));
  assert.equal(missing.revision, null);
  await repository.transactCandidates(["C-1"], async document => ({ changed: true, document: { ...document, candidates: [{ id: "C-1" }] } }));
  assert.notEqual(missing.revision, null);
  assert.deepEqual(missing.storedDocument().candidates, [{ id: "C-1" }]);
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
  assert.deepEqual(store.storedDocument(), document);
  assert.deepEqual(Object.keys(store.storedDocument().candidates[0]), ["id", "dataRevision"]);
  assert.deepEqual(Object.keys(store.storedRows().parts).sort(), ["C-1", "C-2"]);

  const again = await importBusinessStateToPostgres({ ...source, store, write: true });
  assert.deepEqual([again.status, again.written], ["target_not_empty", false]);
  assert.equal(typeof again.targetRevision, "string");
  assert.equal(store.calls.inserts, 1);

  await assert.rejects(importBusinessStateToPostgres({ ...sourceFile({ meta: { version: 1 }, candidates: [] }), store: createFakePostgresBusinessStateStore(), write: true }),
    /BUSINESS_STATE_IMPORT_SOURCE_INVALID/);
  await assert.rejects(importBusinessStateToPostgres({ sourceFile: "/x", readSource: async () => "{not json", store: createFakePostgresBusinessStateStore() }), SyntaxError);
  // Two candidates with one id cannot be cut into rows; the import stops before anything is written.
  const doubled = createFakePostgresBusinessStateStore();
  await assert.rejects(importBusinessStateToPostgres({ ...sourceFile({ meta: { version: 2 }, candidates: [{ id: "C-1" }, { id: "C-1" }] }),
    store: doubled, write: true }), /BUSINESS_STATE_PARTITION_DUPLICATE:candidates/);
  assert.equal(doubled.revision, null);
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
