import { isDeepStrictEqual } from "node:util";
import { fingerprintCanonicalRecord, appendC2DiagnosticPath } from "./production-contract-primitives.mjs";

export const PRODUCTION_ENTITY_RECORD_VERSION = "production-entity-record-v1";
export const PRODUCTION_ENTITY_REFERENCE_VERSION = "production-entity-reference-v1";
const KINDS = Object.freeze({
  "c2-final-card-input-snapshot-v1": "final_card_input_snapshot",
  "production-authorization-v1.2": "production_authorization",
  "production-plan-v1.1": "production_plan"
});
const RANK = Object.freeze({ final_card_input_snapshot: 0, production_authorization: 1, production_plan: 2 });
const SCOPE_FIELDS = ["candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId", "variantKey"];
const STORE_FIELDS = ["stableStoreId", "platformStoreId", "mappingVersion"];
const REFERENCE_FIELDS = ["schemaVersion", "entityId", "kind", "scope"];
const RECORD_FIELDS = [...REFERENCE_FIELDS, "value"];
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_REFERENCES = 256;
const MAX_REACHABLE_RECORDS = 64;
const MAX_REGISTRY_RECORDS = 10000;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const kindOf = value => Object.hasOwn(KINDS, value) ? KINDS[value] : null;
const text = value => typeof value === "string" && value.length > 0 && value.length <= 2048 && value.trim() === value;

export class ProductionEntityStorageError extends Error {
  constructor(code, path = "$") {
    const safePath = String(path).split(".").slice(1).reduce((base, key) =>
      appendC2DiagnosticPath(base, key, /^(?:0|[1-9][0-9]*)$/.test(key)), "$");
    super(`${code}:${safePath}`);
    this.name = "ProductionEntityStorageError";
    this.code = code;
  }
}
function childPath(path, key) {
  return `${path}.${String(key).replace(/%/g, "%25").replace(/\./g, "%2E")}`;
}
function fail(code, path) { throw new ProductionEntityStorageError(`PRODUCTION_ENTITY_${code}`, path); }
function exact(value, fields, path) {
  if (!object(value)) fail("SHAPE_INVALID", path);
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (count > fields.length || !fields.includes(key) || !Object.hasOwn(descriptor, "value")) fail("SHAPE_INVALID", path);
  }
  if (count !== fields.length) fail("SHAPE_INVALID", path);
}
function schemaVersion(value) {
  const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) fail("JSON_INVALID");
  return descriptor.value;
}
function scopeValid(scope, candidateId, path) {
  exact(scope, SCOPE_FIELDS, path);
  exact(scope.storeRef, STORE_FIELDS, `${path}.storeRef`);
  for (const key of SCOPE_FIELDS.filter(key => key !== "storeRef")) if (!text(scope[key])) fail("SCOPE_INVALID", path);
  for (const key of STORE_FIELDS) if (!text(scope.storeRef[key])) fail("SCOPE_INVALID", path);
  if (candidateId !== null && scope.candidateId !== candidateId) fail("SCOPE_MISMATCH", path);
  return scope;
}
function identityScope(identity, variantKey, candidateId, path) {
  if (!object(identity)) fail("SCOPE_INVALID", path);
  const scope = Object.fromEntries(SCOPE_FIELDS.map(key => [key, key === "variantKey" ? variantKey : identity[key]]));
  return scopeValid(scope, candidateId, path);
}
function sameScope(left, right, path) {
  if (!isDeepStrictEqual(left, right)) fail("SCOPE_MISMATCH", path);
}
function refValid(ref, candidateId, path) {
  exact(ref, REFERENCE_FIELDS, path);
  if (ref.schemaVersion !== PRODUCTION_ENTITY_REFERENCE_VERSION || !Object.hasOwn(RANK, ref.kind) || !text(ref.entityId)) fail("REFERENCE_INVALID", path);
  scopeValid(ref.scope, candidateId, `${path}.scope`);
}
function budget(maxNodes = 20000) { return { nodes: 0, bytes: 0, maxNodes }; }
function count(state, value, depth, path) {
  state.nodes += 1;
  if (typeof value === "string") state.bytes += Buffer.byteLength(value, "utf8");
  if (state.nodes > state.maxNodes || state.bytes > MAX_BYTES || depth > MAX_DEPTH) fail("RESOURCE_LIMIT_EXCEEDED", path);
}
function finish(value, state, path) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES || state.bytes > MAX_BYTES) fail("RESOURCE_LIMIT_EXCEEDED", path);
  return value;
}
/** Copies JSON data without invoking accessors, retaining ordinary keys such as __proto__. */
function walk(value, state, path, visit, active, depth = 0, entityRoot = false) {
  if (depth > MAX_DEPTH) fail("RESOURCE_LIMIT_EXCEEDED", path);
  if (object(value) && !entityRoot) {
    const replacement = visit(value, path);
    if (replacement !== undefined) return walk(replacement, state, path, () => undefined, active, depth, true);
  }
  count(state, value, depth, path);
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object") fail("JSON_INVALID", path);
  if (active.has(value)) fail("CYCLE", path);
  const prototype = Object.getPrototypeOf(value);
  if ((!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) fail("JSON_INVALID", path);
  active.add(value);
  const result = Array.isArray(value) ? [] : {};
  let seen = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("JSON_INVALID", path);
    if (Array.isArray(value) && key !== String(seen)) fail("JSON_INVALID", path);
    seen += 1;
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MAX_BYTES || state.nodes + seen > state.maxNodes * 2) fail("RESOURCE_LIMIT_EXCEEDED", path);
    const child = walk(descriptor.value, state, childPath(path, key), visit, active, depth + 1);
    Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  if (Array.isArray(value) && seen !== value.length) fail("JSON_INVALID", path);
  active.delete(value);
  return result;
}
function reference(record) {
  return { schemaVersion: PRODUCTION_ENTITY_REFERENCE_VERSION, entityId: record.entityId, kind: record.kind, scope: structuredClone(record.scope) };
}
function expectedDependency(kind, path) {
  if (kind === "production_authorization" && path === "$.lockedScope.finalCardInputSnapshot") return "final_card_input_snapshot";
  if (kind === "production_plan" && path === "$.sourceAuthorization") return "production_authorization";
  if (kind === "production_plan" && path === "$.sourceAuthorization.lockedScope.finalCardInputSnapshot") return "final_card_input_snapshot";
  return null;
}
function describe(value, kind, candidateId) {
  let scope;
  let entityId;
  if (kind === "final_card_input_snapshot") {
    scope = identityScope(value.identity, value.variantKey, candidateId, "$.identity");
    if (value.skuPackageId !== scope.skuPackageId || !Number.isInteger(value.sourceDataRevision) || value.sourceDataRevision < 0 || value.resultDataRevision !== value.sourceDataRevision + 1) fail("IDENTITY_INVALID");
    entityId = `final-card-input-snapshot:${fingerprintCanonicalRecord(value)}`;
  } else if (kind === "production_authorization") {
    const locked = value.lockedScope;
    if (!object(locked)) fail("IDENTITY_INVALID");
    scope = identityScope(value.sourceIdentity, locked.variantKey, candidateId, "$.sourceIdentity");
    sameScope(scope, identityScope(value.identity, locked.variantKey, candidateId, "$.identity"), "$.identity");
    sameScope(scope, identityScope(locked, locked.variantKey, candidateId, "$.lockedScope"), "$.lockedScope");
    const snapshot = locked.finalCardInputSnapshot;
    refValid(snapshot, scope.candidateId, "$.lockedScope.finalCardInputSnapshot");
    if (snapshot.kind !== "final_card_input_snapshot" || snapshot.entityId !== `final-card-input-snapshot:${value.sourceFinalCardInputFingerprint}`) fail("DEPENDENCY_INVALID");
    sameScope(scope, snapshot.scope, "$.lockedScope.finalCardInputSnapshot");
    entityId = value.authorizationId;
  } else {
    const authorization = value.sourceAuthorization;
    if (authorization?.schemaVersion === PRODUCTION_ENTITY_REFERENCE_VERSION) {
      refValid(authorization, candidateId, "$.sourceAuthorization");
      if (authorization.kind !== "production_authorization") fail("DEPENDENCY_INVALID");
      scope = authorization.scope;
    } else {
      // The published plan contract also admits frozen v1.1 authorizations.
      // They retain their original inline representation; only v1.2 is an entity.
      if (authorization?.schemaVersion !== "production-authorization-v1.1" || !object(authorization.lockedScope)) fail("DEPENDENCY_INVALID");
      scope = identityScope(authorization.sourceIdentity, authorization.lockedScope.variantKey, candidateId, "$.sourceAuthorization.sourceIdentity");
      sameScope(scope, identityScope(authorization.lockedScope, authorization.lockedScope.variantKey, candidateId, "$.sourceAuthorization.lockedScope"), "$.sourceAuthorization.lockedScope");
      const snapshot = authorization.lockedScope.finalCardInputSnapshot;
      refValid(snapshot, candidateId, "$.sourceAuthorization.lockedScope.finalCardInputSnapshot");
      if (snapshot.kind !== "final_card_input_snapshot" || snapshot.entityId !== `final-card-input-snapshot:${authorization.sourceFinalCardInputFingerprint}`) fail("DEPENDENCY_INVALID");
      sameScope(scope, snapshot.scope, "$.sourceAuthorization.lockedScope.finalCardInputSnapshot");
    }
    entityId = value.planId;
  }
  if (!text(entityId)) fail("IDENTITY_INVALID");
  return { entityId, scope: structuredClone(scope) };
}
function candidateOption(value, options) {
  const candidateId = options.candidateId ?? (object(value) && object(value.lifecycleV11) ? value.id : null);
  if (candidateId !== null && !text(candidateId)) fail("SCOPE_INVALID");
  return candidateId;
}

/** Normalize one candidate, immutable DTO, or idempotency snapshot, never a whole candidate pool. */
export function normalizeProductionEntities(value, options = {}) {
  const candidateId = candidateOption(value, options);
  if (options.inspectEntity !== undefined && typeof options.inspectEntity !== "function") fail("VALIDATOR_INVALID");
  const records = new Map();
  const active = new Set();
  let references = 0;
  function visit(entry, path, parentKind = null, ancestors = []) {
    const kind = kindOf(schemaVersion(entry));
    const isRef = schemaVersion(entry) === PRODUCTION_ENTITY_REFERENCE_VERSION;
    if (!kind && !isRef) return undefined;
    const pathSegments = [...ancestors, ...path.split(".").slice(1).map(key => key.replace(/%2E/g, ".").replace(/%25/g, "%"))];
    references += 1;
    if (references > MAX_REFERENCES) fail("RESOURCE_LIMIT_EXCEEDED", path);
    const actualKind = isRef ? entry.kind : kind;
    if (parentKind !== null && expectedDependency(parentKind, path) !== actualKind) fail("DEPENDENCY_INVALID", path);
    if (isRef) { refValid(entry, candidateId, path); return entry; }
    if (active.has(entry)) fail("CYCLE", path);
    const state = budget(10000);
    const normalized = finish(walk(entry, state, "$", (child, childPath) => visit(child, childPath, kind, pathSegments), active, 0, true), state, path);
    if (options.inspectEntity) options.inspectEntity({ kind, value: normalized }, { pathSegments });
    const identity = describe(normalized, kind, candidateId);
    const record = { schemaVersion: PRODUCTION_ENTITY_RECORD_VERSION, entityId: identity.entityId, kind, scope: identity.scope, value: normalized };
    const previous = records.get(record.entityId);
    if (previous && !isDeepStrictEqual(previous, record)) fail("CONFLICT", path);
    records.set(record.entityId, record);
    if (records.size > MAX_REACHABLE_RECORDS) fail("RESOURCE_LIMIT_EXCEEDED", path);
    return reference(record);
  }
  const state = budget();
  const normalized = finish(walk(value, state, "$", (entry, path) => visit(entry, path), active), state, "$");
  return { value: normalized, records: [...records.values()] };
}

/** Restore only records reached by this value. References never resolve from mutable current state. */
function indexRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_REGISTRY_RECORDS) fail("RESOURCE_LIMIT_EXCEEDED", "records");
  const index = new Map();
  for (const record of records) {
    exact(record, RECORD_FIELDS, "records");
    if (record.schemaVersion !== PRODUCTION_ENTITY_RECORD_VERSION || !text(record.entityId) || !Object.hasOwn(RANK, record.kind)) fail("RECORD_INVALID", "records");
    // Duplicate ids must be merged at the repository transaction boundary.
    if (index.has(record.entityId)) fail("CONFLICT", "records");
    index.set(record.entityId, record);
  }
  return index;
}

export function restoreProductionEntities(value, records, options = {}) {
  return restoreWithIndex(value, indexRecords(records), options);
}

/** Reuse the index and privately frozen validated records; every restored occurrence is a fresh DTO. */
export function createProductionEntityResolver(records, { validateRecord = null } = {}) {
  if (validateRecord !== null && typeof validateRecord !== "function") fail("VALIDATOR_INVALID");
  const index = indexRecords(records);
  const validated = new Map();
  return Object.freeze({ restore: (value, options = {}) => restoreWithIndex(value, index, options, validated, validateRecord) });
}

function expandedStats(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0, textBytes = 0, depth = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    depth = Math.max(depth, current.depth);
    if (nodes > 200000 || depth > MAX_DEPTH) fail("RESOURCE_LIMIT_EXCEEDED");
    if (typeof current.value === "string") textBytes += Buffer.byteLength(current.value, "utf8");
    else if (current.value !== null && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        textBytes += Buffer.byteLength(key, "utf8");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
    if (textBytes > 16 * MAX_BYTES || nodes + stack.length > 200000) fail("RESOURCE_LIMIT_EXCEEDED");
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > 16 * MAX_BYTES) fail("RESOURCE_LIMIT_EXCEEDED");
  return { nodes, bytes, depth };
}
function freezeRecord(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRecord(child);
    Object.freeze(value);
  }
  return value;
}
function restoreWithIndex(value, index, options, validated = new Map(), validateRecord = null) {
  const candidateId = candidateOption(value, options);
  const resolved = new Map();
  const resolving = new Set();
  let references = 0;
  let expandedNodes = 0;
  let expandedBytes = 0;
  let expandedReferences = 0;
  function resolve(ref, path, parentKind = null, parentScope = null) {
    refValid(ref, candidateId, path);
    references += 1;
    if (references > MAX_REFERENCES) fail("RESOURCE_LIMIT_EXCEEDED", path);
    if (parentKind !== null && (expectedDependency(parentKind, path) !== ref.kind || RANK[ref.kind] >= RANK[parentKind])) fail("DEPENDENCY_INVALID", path);
    if (parentScope) sameScope(parentScope, ref.scope, path);
    const record = validated.get(ref.entityId) ?? index.get(ref.entityId);
    if (!record) fail("MISSING", path);
    if (record.kind !== ref.kind) fail("REFERENCE_INVALID", path);
    scopeValid(record.scope, candidateId, `${path}.scope`);
    sameScope(record.scope, ref.scope, path);
    if (resolving.has(ref.entityId)) fail("CYCLE", path);
    if (!resolved.has(ref.entityId)) {
      if (resolved.size + resolving.size >= MAX_REACHABLE_RECORDS) fail("RESOURCE_LIMIT_EXCEEDED", path);
      resolving.add(ref.entityId);
      let stored = record.value;
      if (!validated.has(ref.entityId)) {
        const state = budget(10000);
        // First validate the stored normalized record without expanding dependencies.
        stored = finish(walk(record.value, state, "$", (entry, entryPath) => {
          if (schemaVersion(entry) === PRODUCTION_ENTITY_REFERENCE_VERSION) {
            refValid(entry, candidateId, entryPath);
            if (expectedDependency(record.kind, entryPath) !== entry.kind) fail("DEPENDENCY_INVALID", entryPath);
            sameScope(record.scope, entry.scope, entryPath);
            return entry;
          }
          if (kindOf(schemaVersion(entry))) fail("RECORD_NOT_NORMALIZED", entryPath);
          return undefined;
        }, new Set(), 0, true), state, path);
        if (kindOf(stored.schemaVersion) !== record.kind) fail("RECORD_INVALID", path);
        const identity = describe(stored, record.kind, candidateId);
        if (identity.entityId !== record.entityId) fail("IDENTITY_INVALID", path);
        sameScope(identity.scope, record.scope, path);
        const privateRecord = freezeRecord({ ...record, scope: structuredClone(record.scope), value: stored });
        if (validateRecord) validateRecord(privateRecord);
        validated.set(ref.entityId, privateRecord);
      }
      let entityReferences = 1;
      function expand(entry, entryPath) {
        if (!entry || typeof entry !== "object") return entry;
        if (schemaVersion(entry) === PRODUCTION_ENTITY_REFERENCE_VERSION) {
          const child = resolve(entry, entryPath, record.kind, record.scope);
          entityReferences += resolved.get(entry.entityId).references;
          return child;
        }
        return Array.isArray(entry) ? entry.map((child, i) => expand(child, childPath(entryPath, String(i)))) : Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, expand(child, childPath(entryPath, key))]));
      }
      const full = expand(stored, "$");
      resolved.set(ref.entityId, { value: full, ...expandedStats(full), references: entityReferences });
      resolving.delete(ref.entityId);
    }
    const item = resolved.get(ref.entityId);
    if (item.depth + path.split(".").length - 1 > MAX_DEPTH) fail("RESOURCE_LIMIT_EXCEEDED", path);
    if (parentKind === null) {
      expandedNodes += item.nodes;
      expandedBytes += item.bytes;
      expandedReferences += item.references;
      if (expandedNodes > 200000 || expandedBytes > 16 * MAX_BYTES || expandedReferences > MAX_REFERENCES) fail("RESOURCE_LIMIT_EXCEEDED", path);
    }
    return structuredClone(item.value);
  }
  const state = budget();
  // Validate the bounded root before hydrating; its references are not counted as inline DTOs.
  const normalized = finish(walk(value, state, "$", (entry, path) => {
    if (schemaVersion(entry) === PRODUCTION_ENTITY_REFERENCE_VERSION) { refValid(entry, candidateId, path); return entry; }
    return undefined;
  }, new Set()), state, "$");
  expandedNodes = state.nodes;
  expandedBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  function expandRoot(entry, path) {
    if (!entry || typeof entry !== "object") return entry;
    if (schemaVersion(entry) === PRODUCTION_ENTITY_REFERENCE_VERSION) return resolve(entry, path);
    return Array.isArray(entry) ? entry.map((child, i) => expandRoot(child, childPath(path, String(i)))) : Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, expandRoot(child, childPath(path, key))]));
  }
  return expandRoot(normalized, "$");
}
