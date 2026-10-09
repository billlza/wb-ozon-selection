import fs from "node:fs/promises";
import path from "node:path";
import { persistJsonThroughRealTarget } from "./atomic-json-persistence.mjs";
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

function createRepository({ adapter, concurrencyScope, read, replace, snapshotReader = null }) {
  let queue = Promise.resolve();
  const repository = {
    boundaryType: "business_state_repository",
    authoritative: true,
    adapter,
    concurrencyScope,
    multiUserReady: concurrencyScope === "database_transaction",
    async readSnapshot() {
      if (snapshotReader) return snapshotReader();
      const document = await read();
      if (!validDocument(document)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      return readProductionDocument(document);
    },
    transact(mutator) {
      if (typeof mutator !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_MUTATOR_REQUIRED");
      const operation = queue.then(async () => {
        const stored = await read();
        if (!validDocument(stored)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
        const current = readProductionDocument(stored);
        const baseline = productionSlotBaseline(current, stored);
        const outcome = validateTransactionResult(await mutator(current));
        if (outcome.changed) await replace(writeProductionDocument(outcome.document, stored, baseline));
        return outcome.result;
      });
      // `operation`仍原样返回给调用者并保留失败；这里只重置串行队列尾部，
      // 让一次失败不会永久阻断后续独立事务。
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
  return Object.freeze(repository);
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
  return createRepository({
    adapter: "json",
    concurrencyScope: "single_process",
    read: async () => parseSource(await readSource()),
    snapshotReader: async () => {
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
    },
    replace: async (document) => {
      invalidateSnapshot();
      if (initializeIfMissing && lastReadUsedInitialDocument) {
        await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
      }
      await atomicWriter(filePath, document);
      lastReadUsedInitialDocument = false;
    }
  });
}

export function createMemoryBusinessStateRepository(initialDocument) {
  if (!validDocument(initialDocument)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  let document = clone(initialDocument);
  return createRepository({
    adapter: "memory",
    concurrencyScope: "single_process",
    read: async () => clone(document),
    replace: async (next) => { document = clone(next); }
  });
}

export function createConfiguredBusinessStateRepository(configuration) {
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
  throw new Error(`BUSINESS_STATE_REPOSITORY_ADAPTER_NOT_IMPLEMENTED:${configuration.stateAdapter}`);
}

export function assertBusinessStateRepositoryBoundary(repository) {
  if (!repository || repository.boundaryType !== "business_state_repository" ||
      repository.authoritative !== true || typeof repository.readSnapshot !== "function" ||
      typeof repository.transact !== "function") {
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
