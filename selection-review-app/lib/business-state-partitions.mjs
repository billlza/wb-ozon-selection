import { isDeepStrictEqual } from "node:util";

// The stored business state cut into one part per candidate plus one shared part. A candidate's part holds the candidate
// and every record bound to that candidate alone (its jobs, audit events, idempotency records, production entities…);
// rules, settings and records of several candidates or of none stay shared. A single-candidate transaction loads, checks
// and writes only its candidates' parts; the shared part is read-only to it.
//
// Each record keeps a position, so the whole document is put back in the order it was written: within one candidate the
// order is always exact, and records added later go after (or, for a new candidate put first, before) everything else.

const bound = value => typeof value === "string" && value !== "" ? value : null;

// `bind` names the one candidate a record belongs to; anything else (no candidate, several, a malformed id) is shared.
// `keys` are identities the domain treats as unique across the whole document (an idempotency key, a job id…); the
// stores keep each one with a single candidate, so a single-candidate transaction can never save one another candidate
// already uses. `newFirst`: a record added with nothing around it to place it by goes first (new candidates go on top).
const ownCandidate = record => record?.candidateId ?? record?.scopeBinding?.candidateId;
const keyOf = (kind, value) => typeof value === "string" && value !== "" ? [[kind, value]] : [];
export const PARTITIONED_COLLECTIONS = Object.freeze([
  { key: "candidates", path: ["candidates"], bind: record => record?.id, single: true, newFirst: true, keys: () => [] },
  { key: "productionEntityRecords", path: ["productionEntityRecords"], bind: record => record?.scope?.candidateId,
    keys: record => keyOf("production_entity", record?.entityId) },
  { key: "c1FinalPlanRevisionHistoryRecords", path: ["c1FinalPlanRevisionHistoryRecords"], bind: record => record?.candidateId,
    keys: record => keyOf("c1_final_plan_preparation", record?.preparationId) },
  { key: "c1SiblingColorRevisionHistoryRecords", path: ["c1SiblingColorRevisionHistoryRecords"], bind: record => record?.candidateId,
    keys: record => keyOf("c1_sibling_color_preparation", record?.preparationId) },
  { key: "dispatches", path: ["dispatches"], bind: record => record?.candidateId, keys: record => keyOf("dispatch", record?.id) },
  { key: "runtime.idempotencyRecords", path: ["runtime", "idempotencyRecords"], bind: record => record?.candidateId,
    keys: record => keyOf("idempotency", record?.idempotencyKey) },
  { key: "runtime.operationAudit", path: ["runtime", "operationAudit"], bind: record => record?.candidateId, keys: () => [] },
  { key: "runtime.softwareJobs", path: ["runtime", "softwareJobs"],
    bind: job => job?.candidateId ?? (job?.subject?.kind === "a_candidate" ? job.subject.candidateId : null),
    keys: job => [...keyOf("software_job", job?.jobId), ...keyOf("software_job_idempotency", job?.idempotencyKey)] },
  { key: "runtime.softwareJobAuthorizationRecords", path: ["runtime", "softwareJobAuthorizationRecords"], bind: ownCandidate,
    keys: record => keyOf("software_job_authorization", record?.authorizationId) },
  { key: "runtime.softwareJobCredentialBindings", path: ["runtime", "softwareJobCredentialBindings"], bind: ownCandidate,
    keys: record => keyOf("software_job_credential_binding", record?.bindingId) }
].map(collection => Object.freeze({ ...collection, path: Object.freeze(collection.path) })));
export const PARTITIONED_COLLECTION_KEYS = new Set(PARTITIONED_COLLECTIONS.map(collection => collection.key));

const SHARED_KEY = "";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(document, path) {
  let value = document;
  for (const key of path) {
    if (!isPlainObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function violation(detail) {
  return new Error(`BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:${detail}`);
}

// Sets `path` in `document`, copying each container on the way the first time it is touched (`copied` remembers which),
// so the input is never changed. A key that already exists keeps its place.
function setAt(document, path, value, copied) {
  let container = document;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const key = path[depth];
    const id = path.slice(0, depth + 1).join(".");
    const existing = container[key];
    if (existing !== undefined && !isPlainObject(existing)) throw new Error(`BUSINESS_STATE_PARTITION_SHAPE_INVALID:${id}`);
    if (!copied.has(id)) {
      container[key] = existing === undefined ? {} : { ...existing };
      copied.add(id);
    }
    container = container[key];
  }
  container[path.at(-1)] = value;
}

function emptyPart(candidateId) {
  return { candidateId, collections: {} };
}

/**
 * Cuts a whole stored document. `positionAt(index)` gives the stored position of a record at that index (the index
 * itself by default); records then go back in their original order.
 */
export function splitBusinessState(document, { positionAt = index => index } = {}) {
  if (!isPlainObject(document)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  const shared = { document: { ...document }, positions: {} };
  const parts = new Map();
  const copied = new Set();
  for (const collection of PARTITIONED_COLLECTIONS) {
    const records = valueAt(document, collection.path);
    if (!Array.isArray(records)) continue;
    const sharedPositions = [], sharedRecords = [];
    records.forEach((record, index) => {
      const position = positionAt(index);
      const candidateId = bound(collection.bind(record));
      if (candidateId === null) {
        sharedPositions.push(position);
        sharedRecords.push(record);
        return;
      }
      if (!parts.has(candidateId)) parts.set(candidateId, emptyPart(candidateId));
      const entries = parts.get(candidateId).collections[collection.key] ??= { positions: [], records: [] };
      if (collection.single && entries.records.length > 0) throw new Error(`BUSINESS_STATE_PARTITION_DUPLICATE:${collection.key}`);
      entries.positions.push(position);
      entries.records.push(record);
    });
    setAt(shared.document, collection.path, sharedRecords, copied);
    shared.positions[collection.key] = sharedPositions;
  }
  return { shared, parts };
}

/**
 * Puts a shared part and some candidate parts back into one stored document: every part for the whole document, or
 * only the parts in scope for a single-candidate view. Records are shared with the parts, not copied.
 */
export function assembleBusinessState(shared, parts) {
  const document = { ...shared.document };
  const copied = new Set();
  const list = [...parts];
  for (const collection of PARTITIONED_COLLECTIONS) {
    const sharedRecords = valueAt(shared.document, collection.path);
    const entries = [];
    if (Array.isArray(sharedRecords)) {
      const positions = shared.positions[collection.key];
      if (!Array.isArray(positions) || positions.length !== sharedRecords.length) {
        throw new Error(`BUSINESS_STATE_PARTITION_POSITIONS_INVALID:${collection.key}`);
      }
      sharedRecords.forEach((record, index) => entries.push({ position: positions[index], owner: SHARED_KEY, index, record }));
    }
    for (const part of list) {
      const own = part.collections[collection.key];
      if (!own) continue;
      if (own.positions.length !== own.records.length) throw new Error(`BUSINESS_STATE_PARTITION_POSITIONS_INVALID:${collection.key}`);
      own.records.forEach((record, index) => entries.push({ position: own.positions[index], owner: part.candidateId, index, record }));
    }
    if (!Array.isArray(sharedRecords)) {
      if (entries.length === 0) continue;
      if (sharedRecords !== undefined) throw new Error(`BUSINESS_STATE_PARTITION_SHAPE_INVALID:${collection.key}`);
    }
    entries.sort((a, b) => a.position - b.position || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.index - b.index);
    setAt(document, collection.path, entries.map(entry => entry.record), copied);
  }
  return document;
}

// In a single-candidate transaction, an empty partitioned collection is the same as none: an array the shared part never
// had and now only holds empty (the transaction created it for its candidate's records), or one the shared part held empty
// and the written document leaves out (production entity records go when no record is left), is not a shared change.
function withoutNewEmptyCollections(next, previous) {
  const document = { ...next.document };
  const positions = { ...next.positions };
  const copied = new Set();
  for (const collection of PARTITIONED_COLLECTIONS) {
    const value = valueAt(document, collection.path);
    const before = valueAt(previous.document, collection.path);
    if (value === undefined && Array.isArray(before) && before.length === 0) {
      setAt(document, collection.path, [], copied);
      positions[collection.key] = [];
      continue;
    }
    if (!Array.isArray(value) || value.length > 0 || before !== undefined) continue;
    const parentPath = collection.path.slice(0, -1);
    if (parentPath.length > 0) setAt(document, parentPath, { ...valueAt(document, parentPath) }, copied);
    const parent = parentPath.length === 0 ? document : valueAt(document, parentPath);
    delete parent[collection.path.at(-1)];
    delete positions[collection.key];
    // The container (`runtime`) also goes when it only existed for that array.
    if (parentPath.length > 0 && Object.keys(parent).length === 0 && valueAt(previous.document, parentPath) === undefined) {
      const grand = parentPath.length === 1 ? document : valueAt(document, parentPath.slice(0, -1));
      delete grand[parentPath.at(-1)];
    }
  }
  return { document, positions };
}

/**
 * Cuts the document a transaction wrote, against the parts it loaded. `scope` is null for a whole-document transaction
 * (every part was loaded) or the set of candidate ids a single-candidate transaction may change; anything outside it is
 * refused. `allocate.end(n)` returns n ascending positions above every stored one, `allocate.front(n)` n ascending
 * positions below every stored one. Returns the shared part when it changed and every candidate part that changed
 * (null: the part is now empty and goes away).
 */
export async function splitBusinessStateResult(document, loaded, { scope = null, allocate }) {
  if (!isPlainObject(document)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  const shared = { document: { ...document }, positions: {} };
  const next = new Map();
  const copied = new Set();
  for (const collection of PARTITIONED_COLLECTIONS) {
    const records = valueAt(document, collection.path);
    if (!Array.isArray(records)) continue;
    const sharedBefore = Array.isArray(valueAt(loaded.shared.document, collection.path))
      ? { positions: loaded.shared.positions[collection.key], records: valueAt(loaded.shared.document, collection.path) }
      : { positions: [], records: [] };
    const before = owner => owner === SHARED_KEY ? sharedBefore
      : loaded.parts.get(owner)?.collections[collection.key] ?? { positions: [], records: [] };
    const owners = records.map(record => bound(collection.bind(record)) ?? SHARED_KEY);
    const indexes = new Map();
    owners.forEach((owner, index) => {
      if (owner !== SHARED_KEY && scope !== null && !scope.has(owner)) throw violation(`${collection.key}:${owner}`);
      if (!indexes.has(owner)) indexes.set(owner, []);
      indexes.get(owner).push(index);
      if (collection.single && owner !== SHARED_KEY && indexes.get(owner).length > 1) {
        throw new Error(`BUSINESS_STATE_PARTITION_DUPLICATE:${collection.key}`);
      }
    });
    // Each owner's records keep their stored positions in order. Records added at the start (the old first record now
    // further down) take the positions from the end of the list instead, so the new ones count as added in front.
    const assigned = new Array(records.length).fill(undefined);
    for (const [owner, own] of indexes) {
      const old = before(owner);
      const extra = own.length - old.positions.length;
      const front = extra > 0 && old.records.length > 0 && isDeepStrictEqual(old.records[0], records[own[extra]]) &&
        !isDeepStrictEqual(old.records[0], records[own[0]]);
      const offset = front ? extra : 0;
      old.positions.forEach((position, k) => {
        if (k + offset < own.length) assigned[own[k + offset]] = position;
      });
    }
    const firstReused = assigned.findIndex(position => position !== undefined);
    const front = [], end = [];
    assigned.forEach((position, index) => {
      if (position !== undefined) return;
      const before = firstReused < 0 ? collection.newFirst === true : index < firstReused;
      (before ? front : end).push(index);
    });
    if (front.length > 0) (await allocate.front(front.length)).forEach((position, i) => { assigned[front[i]] = position; });
    if (end.length > 0) (await allocate.end(end.length)).forEach((position, i) => { assigned[end[i]] = position; });
    // A whole-document transaction may reorder or insert in the middle; positions are then given again in written order.
    if (scope === null && assigned.some((position, index) => index > 0 && !(assigned[index - 1] < position))) {
      (await allocate.end(records.length)).forEach((position, index) => { assigned[index] = position; });
    }
    const sharedPositions = [], sharedRecords = [];
    records.forEach((record, index) => {
      const owner = owners[index];
      if (owner === SHARED_KEY) {
        sharedPositions.push(assigned[index]);
        sharedRecords.push(record);
        return;
      }
      if (!next.has(owner)) next.set(owner, emptyPart(owner));
      const entries = next.get(owner).collections[collection.key] ??= { positions: [], records: [] };
      entries.positions.push(assigned[index]);
      entries.records.push(record);
    });
    setAt(shared.document, collection.path, sharedRecords, copied);
    shared.positions[collection.key] = sharedPositions;
  }
  const comparable = scope === null ? shared : withoutNewEmptyCollections(shared, loaded.shared);
  const sharedChanged = !isDeepStrictEqual(comparable, loaded.shared);
  if (sharedChanged && scope !== null) throw violation("shared");
  const parts = new Map();
  const ids = scope === null ? new Set([...loaded.parts.keys(), ...next.keys()]) : scope;
  for (const candidateId of ids) {
    const before = loaded.parts.get(candidateId) ?? null;
    const after = next.get(candidateId) ?? null;
    if (before === null && after === null) continue;
    if (before !== null && after !== null && isDeepStrictEqual(before, after)) continue;
    parts.set(candidateId, after);
  }
  return { shared: sharedChanged ? comparable : null, parts };
}

// The document with every partitioned collection taken out, and a container that holds nothing else (an empty
// `runtime`) with it. Partitioned collections sit at most two levels deep.
function withoutPartitionedRecords(document) {
  const result = { ...document };
  for (const { path } of PARTITIONED_COLLECTIONS) {
    if (path.length === 1) {
      delete result[path[0]];
      continue;
    }
    const [parentKey, key] = path;
    if (!isPlainObject(result[parentKey])) continue;
    const { [key]: _removed, ...rest } = result[parentKey];
    if (Object.keys(rest).length === 0) delete result[parentKey];
    else result[parentKey] = rest;
  }
  return result;
}

/** Whether two documents agree on everything outside the partitioned collections (rules, settings, shared records…). */
export function sameSharedState(left, right) {
  return isDeepStrictEqual(withoutPartitionedRecords(left), withoutPartitionedRecords(right));
}

/**
 * `base` with its partitioned collections taken from `from`; everything else stays as `base` has it. A collection `from`
 * only holds as an empty array `base` never had is left out.
 */
export function withPartitionedRecords(base, from) {
  const result = { ...base };
  const copied = new Set();
  for (const collection of PARTITIONED_COLLECTIONS) {
    const records = valueAt(from, collection.path);
    const before = valueAt(base, collection.path);
    if (records === undefined && before === undefined) continue;
    if (Array.isArray(records) && records.length === 0 && before === undefined) continue;
    setAt(result, collection.path, records === undefined ? [] : records, copied);
  }
  return result;
}

/** Positions for an adapter that keeps the whole document (JSON file, memory): stored positions are array indexes. */
export function createIndexPositionAllocator(split) {
  let lowest = 0, highest = -1;
  const visit = positions => positions.forEach(position => {
    lowest = Math.min(lowest, position);
    highest = Math.max(highest, position);
  });
  Object.values(split.shared.positions).forEach(visit);
  for (const part of split.parts.values()) Object.values(part.collections).forEach(entries => visit(entries.positions));
  return {
    async end(count) { return Array.from({ length: count }, () => { highest += 1; return highest; }); },
    async front(count) { return Array.from({ length: count }, () => { lowest -= 1; return lowest; }).reverse(); }
  };
}

/** How many records the longest partitioned collection of a whole document holds. */
export function longestPartitionedCollection(document) {
  return Math.max(0, ...PARTITIONED_COLLECTIONS.map(collection => valueAt(document, collection.path))
    .filter(Array.isArray).map(records => records.length));
}

/** Every unique identity the records of one part hold, as "kind\u0000value" strings. */
export function partitionKeys(collections, document = null) {
  const keys = new Set();
  for (const collection of PARTITIONED_COLLECTIONS) {
    const records = document === null ? collections[collection.key]?.records : valueAt(document, collection.path);
    if (!Array.isArray(records)) continue;
    for (const record of records) for (const [kind, value] of collection.keys(record)) keys.add(`${kind}\u0000${value}`);
  }
  return keys;
}

/** Keys of the shared part (its unbound records). */
export function sharedPartitionKeys(shared) {
  return partitionKeys(null, shared.document);
}

export function keyConflictError(entry) {
  const [kind] = entry.split("\u0000");
  const error = new Error(kind === "idempotency" ? "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" : `BUSINESS_STATE_REPOSITORY_KEY_CONFLICT:${kind}`);
  error.code = kind === "idempotency" ? "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" : "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT";
  return error;
}

function keyOwners(split) {
  const owners = new Map();
  const visit = (owner, keys) => {
    for (const key of keys) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(owner);
    }
  };
  visit(SHARED_KEY, sharedPartitionKeys(split.shared));
  for (const [candidateId, part] of split.parts) visit(candidateId, partitionKeys(part.collections));
  return owners;
}

/**
 * For adapters holding the whole document: a write may not give a key to a second part (the shared part counts as one).
 * A key already held by several parts before the write (data saved before keys were checked) is left as it was.
 */
export function assertNoNewKeyConflicts(before, after) {
  const previous = keyOwners(before);
  for (const [key, owners] of keyOwners(after)) {
    if (owners.size < 2) continue;
    const had = previous.get(key);
    if (!had || [...owners].some(owner => !had.has(owner))) throw keyConflictError(key);
  }
}

// How the parts are stored (one row each in Postgres).
const SHARED_PART_VERSION = "business-state-shared-part-v1";
const CANDIDATE_PART_VERSION = "business-state-candidate-part-v1";

function validPositions(positions, length) {
  return Array.isArray(positions) && positions.length === length && positions.every(Number.isSafeInteger);
}

export function encodeSharedPart(shared) {
  return { schemaVersion: SHARED_PART_VERSION, document: shared.document, positions: shared.positions };
}

export function decodeSharedPart(value) {
  if (!isPlainObject(value) || value.schemaVersion !== SHARED_PART_VERSION || !isPlainObject(value.document) ||
      !isPlainObject(value.positions) || Object.keys(value).length !== 3 ||
      Object.entries(value.positions).some(([key, positions]) => !PARTITIONED_COLLECTION_KEYS.has(key) || !validPositions(positions, positions?.length))) {
    throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  }
  return { document: value.document, positions: value.positions };
}

export function encodeCandidatePart(part) {
  return { schemaVersion: CANDIDATE_PART_VERSION, candidateId: part.candidateId, collections: part.collections };
}

export function decodeCandidatePart(value, candidateId) {
  if (!isPlainObject(value) || value.schemaVersion !== CANDIDATE_PART_VERSION || value.candidateId !== candidateId ||
      !isPlainObject(value.collections) || Object.keys(value).length !== 3 ||
      Object.entries(value.collections).some(([key, entries]) => !PARTITIONED_COLLECTION_KEYS.has(key) || !isPlainObject(entries) ||
        !Array.isArray(entries.records) || entries.records.length === 0 || !validPositions(entries.positions, entries.records.length))) {
    throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  }
  return { candidateId, collections: value.collections };
}

