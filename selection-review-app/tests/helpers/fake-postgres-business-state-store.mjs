import { assembleBusinessState, decodeCandidatePart, decodeSharedPart, encodeCandidatePart, encodeSharedPart,
  longestPartitionedCollection, partitionKeys, sharedPartitionKeys, splitBusinessState } from "../../lib/business-state-partitions.mjs";

// Stands in for lib/postgres-business-state-store.mjs with no database: one shared row and one row per candidate, each
// kept as JSON text (the json columns keep the text as written), revisions and positions from counters that never go
// back, and the unique-key table. Locked work runs one at a time; a failed transaction leaves every row as it was.
export function createFakePostgresBusinessStateStore({ document = null } = {}) {
  let revision = 0, position = 0;
  const nextRevision = () => String(++revision);
  let state = { shared: null, parts: new Map(), keys: new Map() };
  let lock = Promise.resolve();
  const calls = { reads: 0, rowTransfers: 0, writes: 0, inserts: 0, lockedCandidateIds: [] };
  const copy = current => ({ shared: current.shared, parts: new Map(current.parts), keys: new Map(current.keys) });

  function store(target, split) {
    target.shared = { text: JSON.stringify(encodeSharedPart(split.shared)), revision: nextRevision() };
    for (const key of sharedPartitionKeys(split.shared)) if (!target.keys.has(key)) target.keys.set(key, "");
    for (const [candidateId, part] of split.parts) {
      target.parts.set(candidateId, { text: JSON.stringify(encodeCandidatePart(part)), revision: nextRevision() });
      for (const key of partitionKeys(part.collections)) if (!target.keys.has(key)) target.keys.set(key, candidateId);
    }
  }
  function seed(target, value) {
    const base = position;
    position += longestPartitionedCollection(value);
    store(target, splitBusinessState(value, { positionAt: index => base + index + 1 }));
  }
  if (document !== null) seed(state, document);

  const answer = (row, knownRevision) => {
    if (row.revision === knownRevision) return { revision: row.revision };
    calls.rowTransfers += 1;
    return { revision: row.revision, value: JSON.parse(row.text) };
  };
  function rowsOf(current, candidateIds, known) {
    const ids = candidateIds ?? [...current.parts.keys()];
    return [...new Set(ids)].sort().filter(id => current.parts.has(id))
      .map(candidateId => ({ candidateId, ...answer(current.parts.get(candidateId), known.parts?.get(candidateId) ?? null) }));
  }
  function applyKeys(target, owner, { added, removed }) {
    for (const key of removed) if (target.keys.get(key) === owner) target.keys.delete(key);
    return () => {
      for (const key of added) {
        const holder = target.keys.get(key);
        if (holder !== undefined && holder !== owner) {
          const kind = key.split("\u0000")[0];
          const error = new Error(kind === "idempotency" ? "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" : `BUSINESS_STATE_REPOSITORY_KEY_CONFLICT:${kind}`);
          error.code = kind === "idempotency" ? "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" : "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT";
          throw error;
        }
        target.keys.set(key, owner);
      }
    };
  }

  return {
    calls,
    maxConcurrentTransactions: 1,
    get revision() { return state.shared === null ? null : String(revision); },
    /** The whole stored document as the rows put it back together (production entity records still encoded). */
    storedDocument() {
      if (state.shared === null) return null;
      return assembleBusinessState(decodeSharedPart(JSON.parse(state.shared.text)),
        [...state.parts].map(([candidateId, row]) => decodeCandidatePart(JSON.parse(row.text), candidateId)));
    },
    storedRows() {
      return { shared: state.shared && JSON.parse(state.shared.text),
        parts: Object.fromEntries([...state.parts].map(([candidateId, row]) => [candidateId, JSON.parse(row.text)])) };
    },
    async readRows({ candidateIds = null, known = { shared: null, parts: new Map() } } = {}) {
      calls.reads += 1;
      if (state.shared === null) return null;
      return { shared: answer(state.shared, known.shared), parts: rowsOf(state, candidateIds, known) };
    },
    runLocked({ candidateIds = null, initialShared = null, known = { shared: null, parts: new Map() } } = {}, work) {
      const run = lock.then(async () => {
        const next = copy(state);
        let inserted = false;
        if (next.shared === null) {
          if (typeof initialShared !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
          next.shared = { text: JSON.stringify(initialShared()), revision: nextRevision() };
          inserted = true;
        }
        calls.lockedCandidateIds.push(candidateIds);
        let changes = null;
        const allocate = {
          async end(count) { return Array.from({ length: count }, () => ++position); },
          async front(count) { return Array.from({ length: count }, () => -++position).sort((a, b) => a - b); }
        };
        const result = await work({ shared: answer(next.shared, known.shared), parts: rowsOf(next, candidateIds, known),
          allocate, write(value) { changes = value; } });
        if (changes === null || (!changes.shared && changes.parts.size === 0)) {
          if (!inserted) state = next;
          return result;
        }
        if (candidateIds !== null && (changes.shared || [...changes.parts.keys()].some(id => !candidateIds.includes(id)))) {
          throw new Error("BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:store");
        }
        const additions = [];
        if (changes.shared) {
          next.shared = { text: JSON.stringify(changes.shared.value), revision: nextRevision() };
          additions.push(applyKeys(next, "", changes.shared.keys));
        }
        for (const [candidateId, change] of changes.parts) {
          if (change.value === null) next.parts.delete(candidateId);
          else next.parts.set(candidateId, { text: JSON.stringify(change.value), revision: nextRevision() });
          additions.push(applyKeys(next, candidateId, change.keys));
        }
        for (const add of additions) add();
        state = next;
        calls.writes += 1;
        return result;
      });
      lock = run.then(() => undefined, () => undefined);
      return run;
    },
    async inspect() {
      return { tableExists: state.shared !== null, revision: state.shared?.revision ?? null };
    },
    async insertDocument(value, { verify = async () => {} } = {}) {
      if (state.shared !== null) return false;
      const next = copy(state);
      seed(next, JSON.parse(JSON.stringify(value)));
      await verify(assembleBusinessState(decodeSharedPart(JSON.parse(next.shared.text)),
        [...next.parts].map(([candidateId, row]) => decodeCandidatePart(JSON.parse(row.text), candidateId))));
      state = next;
      calls.inserts += 1;
      return true;
    },
    async close() {}
  };
}
