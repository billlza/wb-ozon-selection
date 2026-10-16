import fs from "node:fs/promises";
import path from "node:path";
import { persistJsonThroughRealTarget } from "./atomic-json-persistence.mjs";
import { createPostgresBusinessStateStore, isPostgresConnectionString } from "./postgres-business-state-store.mjs";
import { assembleBusinessState, assertNoNewKeyConflicts, createIndexPositionAllocator, decodeCandidatePart, decodeSharedPart,
  encodeCandidatePart, encodeSharedPart, partitionKeys, sharedPartitionKeys, splitBusinessState, splitBusinessStateResult }
  from "./business-state-partitions.mjs";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import { normalizeProductionEntities, createProductionEntityResolver, PRODUCTION_ENTITY_REFERENCE_VERSION } from "./production-entity-storage.mjs";
import { assertSafeBusinessMutationCandidate, assertSafeRuntimeRecord, assertSafeStoredProductionEntityRecord, assertRuntimeProductionEntityReferenceContext } from "./runtime-identity.mjs";

export const CENTRAL_PERSISTENCE_ERROR = "Production state has no central persistence boundary.";

function clone(value) {
  return structuredClone(value);
}

function validDocument(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PRODUCTION_RECORDS_FIELD = "productionEntityRecords";
const SNAPSHOT_CACHE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

function hasFinalCardSnapshot(value) {
  return value?.schemaVersion === "c2-final-card-input-snapshot-v1" || value?.schemaVersion === PRODUCTION_ENTITY_REFERENCE_VERSION;
}

function hasStoredSkuProductionEntities(sku) {
  const version = sku?.productionAuthorization?.schemaVersion;
  return version === "production-authorization-v1.2" || version === PRODUCTION_ENTITY_REFERENCE_VERSION ||
    hasFinalCardSnapshot(sku?.c2FinalAssets?.productionAuthorizationPreparation?.finalCardInputSnapshot);
}

function hasCandidateProductionEntities(candidate) {
  return hasStoredSkuProductionEntities(candidate?.lifecycleV11?.skuPackage) ||
    (Array.isArray(candidate?.lifecycleV11?.finalPricingRevisionHistory) && candidate.lifecycleV11.finalPricingRevisionHistory.some(history =>
      history?.previousSkuPackage?.entityType === "SkuLifecyclePackage" && hasStoredSkuProductionEntities(history.previousSkuPackage)));
}

function hasDetachedProductionHistory(record) {
  return record?.schemaVersion === "c1-final-plan-revision-history-v1" &&
    record.previousSkuPackage?.entityType === "SkuLifecyclePackage" && hasStoredSkuProductionEntities(record.previousSkuPackage);
}

function hasProductionResult(result) {
  return result !== null && typeof result === "object" &&
    (result.productionAuthorization !== undefined || result.productionPlan !== undefined ||
      ["production-authorization-v1.2", "production-plan-v1.1", PRODUCTION_ENTITY_REFERENCE_VERSION].includes(result.schemaVersion));
}

// Only production aggregates and their exact idempotent replies are encoded.
// Research material, paid receipts and unrelated candidates are not fingerprinted
// or rewritten by the production entity store.
function mapProductionSlots(document, transform) {
  if (Array.isArray(document.candidates)) {
    document.candidates = document.candidates.map((candidate, index) => hasCandidateProductionEntities(candidate)
      ? transform(candidate, candidate.id, "candidate", `candidate:${index}`) : candidate);
  }
  if (Array.isArray(document.c1FinalPlanRevisionHistoryRecords)) {
    document.c1FinalPlanRevisionHistoryRecords = document.c1FinalPlanRevisionHistoryRecords.map((record, index) => hasDetachedProductionHistory(record)
      ? transform(record, record.candidateId, "history", `final-plan-history:${index}`) : record);
  }
  if (Array.isArray(document.runtime?.idempotencyRecords)) {
    document.runtime.idempotencyRecords = document.runtime.idempotencyRecords.map((record, index) => {
      const hasCandidate = hasCandidateProductionEntities(record.candidateSnapshot);
      const hasResult = hasProductionResult(record.result);
      if (!hasCandidate && !hasResult) return record;
      return { ...record,
        ...(hasCandidate ? { candidateSnapshot: transform(record.candidateSnapshot, record.candidateId, "candidate", `idempotency:${index}:candidate`) } : {}),
        ...(hasResult ? { result: transform(record.result, record.candidateId, "result", `idempotency:${index}:result`) } : {}) };
    });
  }
  return document;
}

function assertSafeProductionSlot(value, kind) {
  if (kind === "candidate" || kind === "history") assertSafeBusinessMutationCandidate(value);
  else assertSafeRuntimeRecord(value);
}

function productionResolver(records) {
  return createProductionEntityResolver(records, { validateRecord: assertSafeStoredProductionEntityRecord });
}

function readProductionDocument(stored) {
  const document = clone(stored);
  const records = Object.hasOwn(document, PRODUCTION_RECORDS_FIELD) ? document[PRODUCTION_RECORDS_FIELD] : [];
  if (!Array.isArray(records)) throw new Error("BUSINESS_STATE_PRODUCTION_ENTITY_STORE_INVALID");
  delete document[PRODUCTION_RECORDS_FIELD];
  const resolver = productionResolver(records);
  return mapProductionSlots(document, (value, candidateId, kind) => {
    assertSafeProductionSlot(value, kind);
    const restored = resolver.restore(value, { candidateId });
    assertRuntimeProductionEntityReferenceContext(restored);
    return restored;
  });
}

// Retain only production slots before the mutator runs: mutators may change
// their input in place. Untouched slots reuse their exact previous encoding,
// including legacy inline records, without re-fingerprinting their snapshots.
function productionSlotBaseline(current, stored) {
  const encoded = new Map();
  mapProductionSlots({ ...stored, runtime: { ...stored.runtime } }, (value, _id, _kind, key) => {
    encoded.set(key, value);
    return value;
  });
  const baseline = new Map();
  mapProductionSlots({ ...current, runtime: { ...current.runtime } }, (value, _id, _kind, key) => {
    baseline.set(key, { value: clone(value), encoded: encoded.get(key) });
    return value;
  });
  return baseline;
}

function writeProductionDocument(domain, previousStored, baseline) {
  if (Object.hasOwn(domain, PRODUCTION_RECORDS_FIELD)) throw new Error("BUSINESS_STATE_PRODUCTION_ENTITY_STORE_RESERVED");
  const records = clone(Object.hasOwn(previousStored, PRODUCTION_RECORDS_FIELD) ? previousStored[PRODUCTION_RECORDS_FIELD] : []);
  if (!Array.isArray(records)) throw new Error("BUSINESS_STATE_PRODUCTION_ENTITY_STORE_INVALID");
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.entityId)) throw new Error("BUSINESS_STATE_PRODUCTION_ENTITY_DUPLICATE");
    byId.set(record.entityId, record);
  }
  const changedSlots = [];
  const document = mapProductionSlots(clone(domain), (value, candidateId, kind, key) => {
    const previous = baseline.get(key);
    if (previous && isDeepStrictEqual(previous.value, value)) return clone(previous.encoded);
    assertSafeProductionSlot(value, kind);
    const projected = normalizeProductionEntities(value, { candidateId });
    for (const record of projected.records) {
      const existing = byId.get(record.entityId);
      if (existing) {
        if (!isDeepStrictEqual(existing, record)) throw new Error("BUSINESS_STATE_PRODUCTION_ENTITY_CONFLICT");
      } else {
        byId.set(record.entityId, record);
        records.push(record);
      }
    }
    changedSlots.push({ value, candidateId, encoded: projected.value });
    return projected.value;
  });
  if (records.length > 0) document[PRODUCTION_RECORDS_FIELD] = records;
  const resolver = productionResolver(records);
  for (const slot of changedSlots) {
    if (!isDeepStrictEqual(resolver.restore(slot.encoded, { candidateId: slot.candidateId }), slot.value)) {
      throw new Error("BUSINESS_STATE_PRODUCTION_ENTITY_ROUNDTRIP_CONFLICT");
    }
  }
  return document;
}

function validateTransactionResult(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || typeof outcome.changed !== "boolean") {
    throw new Error("BUSINESS_STATE_REPOSITORY_TRANSACTION_RESULT_INVALID");
  }
  if (outcome.changed && !validDocument(outcome.document)) {
    throw new Error("BUSINESS_STATE_REPOSITORY_TRANSACTION_DOCUMENT_REQUIRED");
  }
  return outcome;
}

export function initialBusinessStateDocument({ now = new Date().toISOString(), title = "WB 与 Ozon 选品评审台" } = {}) {
  return {
    meta: {
      version: 2,
      title,
      date: now.slice(0, 10),
      updatedAt: now,
      automationStarted: false
    },
    rules: {},
    candidates: [],
    dispatches: [],
    collaboration: {
      messages: [],
      delivery: []
    },
    runtime: {
      operationAudit: [],
      idempotencyRecords: []
    }
  };
}

const MAX_SCOPE_CANDIDATES = 200;

// An empty scope is allowed: the transaction then sees only the shared part and can save nothing (an action asked about
// a product that does not exist gets its own "not found").
function candidateScope(candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length > MAX_SCOPE_CANDIDATES ||
      candidateIds.some(id => typeof id !== "string" || id === "")) {
    throw new Error("BUSINESS_STATE_REPOSITORY_SCOPE_INVALID");
  }
  return [...new Set(candidateIds)].sort();
}

// Orders transactions in this process. A whole-document transaction runs alone. With `concurrent`, transactions on
// different candidates run side by side (up to `maxActive`); without it everything runs one at a time. Either way, two
// transactions that touch the same candidate start in the order they were asked for.
function createScopeLock({ concurrent, maxActive }) {
  const running = new Set();
  const waiting = [];
  const conflicts = (a, b) => !concurrent || a.ids === null || b.ids === null || a.ids.some(id => b.ids.includes(id));
  function startReady() {
    for (let index = 0; index < waiting.length;) {
      const operation = waiting[index];
      if (running.size >= maxActive || [...running].some(other => conflicts(other, operation)) ||
          waiting.slice(0, index).some(other => conflicts(other, operation))) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      running.add(operation);
      operation.start();
    }
  }
  return {
    run(ids, task) {
      return new Promise((resolve, reject) => {
        const operation = { ids, start() {
          Promise.resolve().then(task).then(resolve, reject).finally(() => {
            running.delete(operation);
            startReady();
          });
        } };
        waiting.push(operation);
        startReady();
      });
    }
  };
}

async function runMutation(locked, mutator) {
  const stored = await locked.read();
  if (!validDocument(stored)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  const current = readProductionDocument(stored);
  const baseline = productionSlotBaseline(current, stored);
  const outcome = validateTransactionResult(await mutator(current));
  if (outcome.changed) await locked.replace(writeProductionDocument(outcome.document, stored, baseline));
  return outcome.result;
}

// `transaction(scope, work)` wraps one read → mutator → replace: `scope` is null for the whole document, or the candidate
// ids of a single-candidate transaction, whose `read` gives only those candidates (their own records included) and the
// shared part, and whose `replace` refuses changes outside them. The file and memory adapters keep one document and run
// it as is; the Postgres adapter runs it inside one database transaction that locks only what the scope needs.
function createRepository({ adapter, concurrencyScope, transaction, readWhole, readScoped, holdProcessLease = null,
  concurrentScopes = false, maxActiveTransactions = 1 }) {
  const lock = createScopeLock({ concurrent: concurrentScopes, maxActive: maxActiveTransactions });
  const repository = {
    boundaryType: "business_state_repository",
    authoritative: true,
    adapter,
    concurrencyScope,
    multiUserReady: concurrencyScope === "database_transaction",
    readSnapshot() {
      return readWhole();
    },
    /** Only these candidates and the shared part, the way a single-candidate transaction sees them. */
    async readCandidates(candidateIds) {
      const stored = await readScoped(candidateScope(candidateIds));
      if (!validDocument(stored)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      return readProductionDocument(stored);
    },
    transact(mutator) {
      if (typeof mutator !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_MUTATOR_REQUIRED");
      return lock.run(null, () => transaction(null, locked => runMutation(locked, mutator)));
    },
    /**
     * For an action on these candidates only: the mutator gets them with their own records and the shared part (rules,
     * settings), and may change only those candidates' records; any other change fails the whole transaction.
     */
    transactCandidates(candidateIds, mutator) {
      const scope = candidateScope(candidateIds);
      if (typeof mutator !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_MUTATOR_REQUIRED");
      return lock.run(scope, () => transaction(scope, locked => runMutation(locked, mutator)));
    }
  };
  if (holdProcessLease) repository.holdProcessLease = holdProcessLease;
  return Object.freeze(repository);
}

// File and memory adapters keep the whole document: a single-candidate transaction cuts it, works on its view and puts the
// result back, with the same view and the same checks as the Postgres adapter.
function wholeDocumentTransaction({ read, replace }) {
  return async (scope, work) => {
    let split = null, loaded = null;
    return work({
      async read() {
        const stored = await read();
        if (!validDocument(stored)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
        split = splitBusinessState(stored);
        if (scope === null) return stored;
        loaded = { shared: split.shared, parts: new Map(scope.filter(id => split.parts.has(id)).map(id => [id, split.parts.get(id)])) };
        return assembleBusinessState(loaded.shared, loaded.parts.values());
      },
      async replace(document) {
        if (scope === null) {
          assertNoNewKeyConflicts(split, splitBusinessState(document));
          return replace(document);
        }
        const next = await splitBusinessStateResult(document, loaded, { scope: new Set(scope), allocate: createIndexPositionAllocator(split) });
        if (next.parts.size === 0) return undefined;
        const parts = new Map(split.parts);
        for (const [candidateId, part] of next.parts) {
          if (part === null) parts.delete(candidateId);
          else parts.set(candidateId, part);
        }
        assertNoNewKeyConflicts(split, { shared: split.shared, parts });
        return replace(assembleBusinessState(split.shared, parts.values()));
      }
    });
  };
}

function scopedFromWhole(stored, scope) {
  if (!validDocument(stored)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  const split = splitBusinessState(stored);
  return assembleBusinessState(split.shared, scope.filter(id => split.parts.has(id)).map(id => split.parts.get(id)));
}

export function createJsonBusinessStateRepository({
  filePath,
  fileSystem = fs,
  atomicWriter = persistJsonThroughRealTarget,
  initializeIfMissing = false,
  initialDocument = () => initialBusinessStateDocument()
} = {}) {
  if (!filePath || typeof filePath !== "string") throw new Error("BUSINESS_STATE_REPOSITORY_FILE_REQUIRED");
  let lastReadUsedInitialDocument = false;
  let snapshotCache = null;
  let cacheGeneration = 0;
  function invalidateSnapshot() {
    snapshotCache = null;
    cacheGeneration += 1;
  }
  async function readSource() {
    try {
      const sourceText = await fileSystem.readFile(filePath, "utf8");
      lastReadUsedInitialDocument = false;
      return { sourceText };
    } catch (error) {
      invalidateSnapshot();
      if (error?.code === "ENOENT" && initializeIfMissing) {
        const document = typeof initialDocument === "function" ? initialDocument() : initialDocument;
        if (!validDocument(document)) throw new Error("BUSINESS_STATE_REPOSITORY_INITIAL_DOCUMENT_INVALID");
        lastReadUsedInitialDocument = true;
        return { sourceText: null, document: clone(document) };
      }
      throw error;
    }
  }
  function parseSource(source) {
    try {
      const document = source.sourceText === null ? source.document : JSON.parse(source.sourceText);
      if (!validDocument(document)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      return document;
    } catch (error) {
      invalidateSnapshot();
      throw error;
    }
  }
  const read = async () => parseSource(await readSource());
  return createRepository({
    adapter: "json",
    concurrencyScope: "single_process",
    transaction: wholeDocumentTransaction({
      read,
      replace: async (document) => {
        invalidateSnapshot();
        if (initializeIfMissing && lastReadUsedInitialDocument) {
          await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
        }
        await atomicWriter(filePath, document);
        lastReadUsedInitialDocument = false;
      }
    }),
    readScoped: async scope => scopedFromWhole(await read(), scope),
    readWhole: async () => {
      const generation = cacheGeneration;
      try {
        const source = await readSource();
        if (source.sourceText !== null && snapshotCache?.sourceText === source.sourceText) {
          return clone(snapshotCache.document);
        }
        snapshotCache = null;
        const document = readProductionDocument(parseSource(source));
        // One private, fully validated projection. Every call still reads the
        // file, and transactions never use this cache. UTF-8 text equality is
        // the same decoded input used by JSON.parse, not a file identity claim.
        // This bounds retained payload, not RSS or transient serialization.
        if (source.sourceText !== null && generation === cacheGeneration) {
          const sourceBytes = Buffer.byteLength(source.sourceText, "utf8");
          if (sourceBytes <= SNAPSHOT_CACHE_MAX_SOURCE_BYTES &&
              sourceBytes + serialize(document).byteLength <= SNAPSHOT_CACHE_MAX_PAYLOAD_BYTES) {
            snapshotCache = { sourceText: source.sourceText, document };
            return clone(document);
          }
        }
        return document;
      } catch (error) {
        invalidateSnapshot();
        throw error;
      }
    }
  });
}

export function createMemoryBusinessStateRepository(initialDocument) {
  if (!validDocument(initialDocument)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  let document = clone(initialDocument);
  const read = async () => clone(document);
  return createRepository({
    adapter: "memory",
    concurrencyScope: "single_process",
    transaction: wholeDocumentTransaction({ read, replace: async (next) => { document = clone(next); } }),
    readScoped: async scope => scopedFromWhole(await read(), scope),
    readWhole: async () => {
      const stored = await read();
      if (!validDocument(stored)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      return readProductionDocument(stored);
    }
  });
}

function keyChanges(before, after) {
  return { added: [...after].filter(key => !before.has(key)), removed: [...before].filter(key => !after.has(key)) };
}

/**
 * The shared part of the document is one Postgres row and every candidate is its own row, with the records that belong
 * to it alone (`store` is lib/postgres-business-state-store.mjs). A whole-document transaction locks the shared row
 * exclusively; a single-candidate transaction shares that lock and locks only its candidates' rows, so actions on
 * different candidates neither wait for each other nor read, copy or write anyone else's records. Reads re-check each
 * row's revision and only fetch rows that changed.
 */
export function createPostgresBusinessStateRepository({ store, initializeIfMissing = false,
  initialDocument = () => initialBusinessStateDocument() } = {}) {
  if (!store || typeof store.readRows !== "function" || typeof store.runLocked !== "function") {
    throw new Error("BUSINESS_STATE_REPOSITORY_STORE_REQUIRED");
  }
  function startingDocument() {
    const document = typeof initialDocument === "function" ? initialDocument() : initialDocument;
    if (!validDocument(document)) throw new Error("BUSINESS_STATE_REPOSITORY_INITIAL_DOCUMENT_INVALID");
    return clone(document);
  }
  // Rows already read, by revision. Every write takes its revision from one database sequence, so a revision names one
  // stored text for good, and an entry can answer for any read that finds that revision unchanged.
  const rows = { shared: null, parts: new Map(), bytes: 0 };
  let snapshotCache = null;
  function asked(scope) {
    const parts = new Map();
    for (const candidateId of scope ?? rows.parts.keys()) {
      const entry = rows.parts.get(candidateId);
      if (entry) parts.set(candidateId, entry);
    }
    return { shared: rows.shared, parts };
  }
  const known = entries => ({ shared: entries.shared?.revision ?? null,
    parts: new Map([...entries.parts].map(([candidateId, entry]) => [candidateId, entry.revision])) });
  // Keeps a fetched row for later reads while the cached rows stay within the snapshot budget.
  function remember(candidateId, entry) {
    const previous = candidateId === null ? rows.shared : rows.parts.get(candidateId);
    if (previous && BigInt(previous.revision) >= BigInt(entry.revision)) return;
    const bytes = serialize(entry.part).byteLength;
    if (rows.bytes - (previous?.bytes ?? 0) + bytes > SNAPSHOT_CACHE_MAX_PAYLOAD_BYTES) return;
    rows.bytes += bytes - (previous?.bytes ?? 0);
    const kept = { ...entry, bytes };
    if (candidateId === null) rows.shared = kept;
    else rows.parts.set(candidateId, kept);
  }
  // The store sends a row's value only when its revision differs from the one asked about; the others come from the
  // entries this read asked with (a concurrent read may replace the cached ones meanwhile).
  function absorb(answer, question) {
    let shared;
    if (Object.hasOwn(answer.shared, "value")) {
      shared = { revision: answer.shared.revision, part: decodeSharedPart(answer.shared.value) };
      remember(null, shared);
    } else {
      if (question.shared?.revision !== answer.shared.revision) throw new Error("BUSINESS_STATE_REPOSITORY_SNAPSHOT_REVISION_INVALID");
      shared = question.shared;
    }
    const parts = new Map();
    for (const row of answer.parts) {
      let entry;
      if (Object.hasOwn(row, "value")) {
        entry = { revision: row.revision, part: decodeCandidatePart(row.value, row.candidateId) };
        remember(row.candidateId, entry);
      } else {
        entry = question.parts.get(row.candidateId);
        if (entry?.revision !== row.revision) throw new Error("BUSINESS_STATE_REPOSITORY_SNAPSHOT_REVISION_INVALID");
      }
      parts.set(row.candidateId, entry);
    }
    return { shared, parts };
  }
  const view = loaded => ({ shared: loaded.shared.part,
    parts: new Map([...loaded.parts].map(([candidateId, entry]) => [candidateId, entry.part])) });
  return createRepository({
    adapter: "postgres",
    concurrencyScope: "database_transaction",
    concurrentScopes: true,
    maxActiveTransactions: store.maxConcurrentTransactions ?? 1,
    readWhole: async () => {
      const question = asked(null);
      const answer = await store.readRows({ known: known(question) });
      if (answer === null) {
        if (!initializeIfMissing) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
        return readProductionDocument(startingDocument());
      }
      const loaded = absorb(answer, question);
      // A whole read lists every candidate row, so rows no longer stored leave the cache here.
      for (const candidateId of rows.parts.keys()) {
        if (loaded.parts.has(candidateId)) continue;
        rows.bytes -= rows.parts.get(candidateId).bytes;
        rows.parts.delete(candidateId);
      }
      const key = JSON.stringify([loaded.shared.revision, ...[...loaded.parts].map(([candidateId, entry]) => [candidateId, entry.revision])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
      const cached = snapshotCache;
      if (cached?.key === key) return clone(cached.document);
      const current = view(loaded);
      const document = readProductionDocument(assembleBusinessState(current.shared, current.parts.values()));
      if (serialize(document).byteLength <= SNAPSHOT_CACHE_MAX_PAYLOAD_BYTES) {
        snapshotCache = { key, document };
        return clone(document);
      }
      return document;
    },
    readScoped: async scope => {
      const question = asked(scope);
      const answer = await store.readRows({ candidateIds: scope, known: known(question) });
      if (answer === null) {
        if (!initializeIfMissing) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
        return scopedFromWhole(startingDocument(), scope);
      }
      const current = view(absorb(answer, question));
      return assembleBusinessState(current.shared, current.parts.values());
    },
    transaction: (scope, work) => {
      const question = asked(scope);
      return store.runLocked({
        candidateIds: scope,
        initialShared: initializeIfMissing ? () => encodeSharedPart(splitBusinessState(startingDocument()).shared) : null,
        known: known(question)
      }, async locked => {
        const loaded = view(absorb(locked, question));
        return work({
          read: async () => assembleBusinessState(loaded.shared, loaded.parts.values()),
          replace: async document => {
            const next = await splitBusinessStateResult(document, loaded, { scope: scope && new Set(scope), allocate: locked.allocate });
            const parts = new Map();
            for (const [candidateId, part] of next.parts) {
              const before = loaded.parts.get(candidateId);
              parts.set(candidateId, { value: part && encodeCandidatePart(part),
                keys: keyChanges(before ? partitionKeys(before.collections) : new Set(), part ? partitionKeys(part.collections) : new Set()) });
            }
            locked.write({
              shared: next.shared && { value: encodeSharedPart(next.shared),
                keys: keyChanges(sharedPartitionKeys(loaded.shared), sharedPartitionKeys(next.shared)) },
              parts
            });
          }
        });
      });
    },
    // One service process per stored document until jobs carry their own leases: see server.mjs.
    holdProcessLease: async ({ onLost } = {}) => {
      if (typeof store.acquireProcessLease !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_UNSUPPORTED");
      const lease = await store.acquireProcessLease({ onLost });
      if (lease === null) throw new Error("BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_HELD");
      return lease;
    }
  });
}

/** Postgres needs `SELECTION_REVIEW_DATABASE_URL`; it is read here and never copied into the runtime configuration. */
export function createConfiguredBusinessStateRepository(configuration, { env = process.env, createStore = createPostgresBusinessStateStore } = {}) {
  if (!configuration || configuration.schemaVersion !== "selection-review-runtime-configuration-v1") {
    throw new Error("BUSINESS_STATE_REPOSITORY_CONFIGURATION_INVALID");
  }
  if (configuration.stateAdapter === "json") {
    return createJsonBusinessStateRepository({
      filePath: configuration.dataFile,
      initializeIfMissing: configuration.initializeDataFile === true,
      initialDocument: () => initialBusinessStateDocument()
    });
  }
  if (configuration.stateAdapter === "postgres") {
    const connectionString = String(env?.SELECTION_REVIEW_DATABASE_URL ?? "").trim();
    if (!isPostgresConnectionString(connectionString)) throw new Error("BUSINESS_STATE_REPOSITORY_DATABASE_URL_REQUIRED");
    return createPostgresBusinessStateRepository({
      store: createStore({ connectionString }),
      initializeIfMissing: configuration.initializeDataFile === true,
      initialDocument: () => initialBusinessStateDocument()
    });
  }
  throw new Error(`BUSINESS_STATE_REPOSITORY_ADAPTER_NOT_IMPLEMENTED:${configuration.stateAdapter}`);
}

export function assertBusinessStateRepositoryBoundary(repository) {
  if (!repository || repository.boundaryType !== "business_state_repository" ||
      repository.authoritative !== true || typeof repository.readSnapshot !== "function" ||
      typeof repository.transact !== "function" || typeof repository.readCandidates !== "function" ||
      typeof repository.transactCandidates !== "function") {
    const error = new Error(CENTRAL_PERSISTENCE_ERROR);
    error.code = "CENTRAL_PERSISTENCE_BOUNDARY_REQUIRED";
    throw error;
  }
  return Object.freeze({
    status: "business_state_repository_boundary_present",
    adapter: repository.adapter,
    concurrencyScope: repository.concurrencyScope,
    multiUserReady: repository.multiUserReady
  });
}

export function assertCentralPersistenceBoundary(repository) {
  const boundary = assertBusinessStateRepositoryBoundary(repository);
  if (boundary.multiUserReady !== true || boundary.concurrencyScope !== "database_transaction") {
    const error = new Error(CENTRAL_PERSISTENCE_ERROR);
    error.code = "CENTRAL_PERSISTENCE_BOUNDARY_REQUIRED";
    throw error;
  }
  return Object.freeze({ ...boundary, status: "central_persistence_boundary_present" });
}
