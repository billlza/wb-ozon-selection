import { createHash } from "node:crypto";

export const SAFE_FROZEN_REF_MAX_LENGTH = 256;
export const PERCENT_ENCODING_MAX_DECODE_DEPTH = 3;
export const PRODUCTION_CONTRACT_MAX_DEPTH = 128;
export const PRODUCTION_CONTRACT_MAX_NODES = 10_000;
export const PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED = "PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED";
// A centrally saved candidate aggregates several independently bounded records.
// These limits apply only to that explicit persistence scope, never API payloads.
export const BUSINESS_CANDIDATE_MAX_NODES = 20_000;
export const BUSINESS_CANDIDATE_MAX_BYTES = 1024 * 1024;
export const BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED = "BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED";

function resourceLimitForScope(scope) {
  if (scope === "production_record") return PRODUCTION_CONTRACT_MAX_NODES;
  if (scope === "business_candidate") return BUSINESS_CANDIDATE_MAX_NODES;
  throw new Error("PRODUCTION_CONTRACT_RESOURCE_SCOPE_INVALID");
}

function candidateResourceLimit() {
  return Object.assign(new Error(BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED), { code: BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED });
}

function assertBusinessCandidateResourceBounds(value) {
  const stack = [{ value, depth: 0 }]; let nodes = 0, textBytes = 0;
  while (stack.length) {
    const current = stack.pop(); nodes += 1;
    if (nodes > BUSINESS_CANDIDATE_MAX_NODES || current.depth > PRODUCTION_CONTRACT_MAX_DEPTH) throw candidateResourceLimit();
    if (typeof current.value === "string") textBytes += Buffer.byteLength(current.value, "utf8");
    else if (current.value !== null && typeof current.value === "object") {
      for (const [key, child] of ownEnumerableEntries(current.value)) {
        if (!Array.isArray(current.value)) textBytes += Buffer.byteLength(String(key), "utf8");
        stack.push({ value: child, depth: current.depth + 1 });
        if (nodes + stack.length > BUSINESS_CANDIDATE_MAX_NODES) throw candidateResourceLimit();
      }
    }
    if (textBytes > BUSINESS_CANDIDATE_MAX_BYTES) throw candidateResourceLimit();
  }
  // The bounded preliminary walk prevents serializing an unbounded/deep input;
  // JSON size also accounts for escaping, punctuation and numeric values.
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > BUSINESS_CANDIDATE_MAX_BYTES) throw candidateResourceLimit();
}

export const C2_DIAGNOSTIC_MAX_PATH_SEGMENTS = 24;
export const C2_DIAGNOSTIC_MAX_PATHS = 16;
export const C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES = 2_048;

/**
 * The C2 contract's declared reference fields.  This is intentionally a
 * field-name allowlist rather than a `*Ref`/`*Id` convention: dynamic fact
 * keys remain business data and must not acquire reference semantics merely
 * because of their spelling.
 */
export const C2_REFERENCE_FIELD_SEMANTICS = Object.freeze({
  assetRef: "assetRef",
  authorizationId: "authorizationId",
  sourceRef: "sourceRef",
  sourceRefs: "canonicalFrozenRef",
  aiRequestId: "canonicalFrozenRef",
  aiReceiptId: "canonicalFrozenRef",
  approvedAssetIds: "canonicalFrozenRef",
  approvedMainImageAssetId: "canonicalFrozenRef",
  assetId: "canonicalFrozenRef",
  assetPackageId: "canonicalFrozenRef",
  candidateId: "canonicalFrozenRef",
  categoryId: "canonicalFrozenRef",
  descriptionCategoryId: "canonicalFrozenRef",
  evidenceRef: "canonicalFrozenRef",
  evidenceRefs: "canonicalFrozenRef",
  factRefs: "canonicalFrozenRef",
  generatorRef: "canonicalFrozenRef",
  inheritedSalesSnapshotRefs: "canonicalFrozenRef",
  inputEvidenceRefs: "canonicalFrozenRef",
  jobId: "canonicalFrozenRef",
  keywordEvidenceRefs: "canonicalFrozenRef",
  mainImageAssetId: "canonicalFrozenRef",
  offerId: "canonicalFrozenRef",
  ownerSupplyConfirmationRef: "canonicalFrozenRef",
  platformProductId: "canonicalFrozenRef",
  platformStoreId: "canonicalFrozenRef",
  providerId: "canonicalFrozenRef",
  providerVersion: "canonicalFrozenRef",
  receiptRef: "canonicalFrozenRef",
  salesSnapshotId: "canonicalFrozenRef",
  schemaEvidenceRef: "canonicalFrozenRef",
  schemaSnapshotRef: "canonicalFrozenRef",
  selectedSupplySnapshotId: "canonicalFrozenRef",
  skuPackageId: "canonicalFrozenRef",
  sourceConfirmationCardId: "canonicalFrozenRef",
  sourceEvidenceRef: "canonicalFrozenRef",
  stableStoreId: "canonicalFrozenRef",
  stableUrlEvidenceRef: "canonicalFrozenRef",
  storeRef: "canonicalFrozenRef",
  supplierOptionId: "canonicalFrozenRef",
  supplierSkuId: "canonicalFrozenRef",
  typeId: "canonicalFrozenRef",
  warehouseRef: "canonicalFrozenRef",
  // inputRefs is an object: its declared C1 source fields are independently
  // canonical references, while the object itself has no scalar semantics.
  platformSchemaEvidenceId: "canonicalFrozenRef",
  profitModelVersion: "canonicalFrozenRef"
});
const C2_REFERENCE_SEMANTIC_KINDS = new Set(Object.values(C2_REFERENCE_FIELD_SEMANTICS));

const C2_DIAGNOSTIC_STATIC_FIELDS = new Set([
  "assets", "collected", "aiDrafts", "finalUploads", "assetId", "mediaType", "assetRef", "assetVersion",
  "sha256", "addedAt", "sourcePlatform", "sourceEvidenceRef", "usageAuthorization", "sourceType",
  "generatorRef", "fileName", "byteSize", "width", "height", "order", "role",
  "stableUrlEvidenceRef", "ownerConfirmed", "productionEligible", "status", "evidenceRef",
  "targetContext", "unknownManifest", "softwareState", "productionAuthorizationPreparation",
  "skuPackage", "c2SourceSnapshots", "c2FinalAssets", "selectedSupplySnapshot", "activeProfitModel", "c1ProductPlan",
  "technicalFailureRecord", "failure", "ownerDecision",
  "frozenC1Handoff", "seoEvidenceLayer", "draftOnlySeo", "providerJobRef", "authorizationRef",
  "pricingReuseRecord", "sourcePlan", "settledExecution", "authorizedExecution",
  "siblingFormalReuseRecord",
  "editorialSource", "bundle", "sourceJob", "scopeBinding", "admissionDecision", "lifecycleV11",
  "request", "competitorTextEvidence", "texts", "referenceContext", "referenceTexts", "canonicalHandoff",
  "authorizationId", "authorizationType", "scope", "finalCardInputSnapshot", "c1Snapshot", "canonicalC1",
  "exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment",
  "categoryRestrictions", "platformCompliance", "inputSnapshots",
  "lockedScope", "c1", "seoDraft", "evidenceLayer", "targetContext", "candidateId", "skuPackageId",
  "variantKey", "platform", "storeRef", "merchantSku", "supplierSkuId", "warehouseRef", "credentialAlias",
  "sourceDataRevision", "resultRevision", "sourceC1Fingerprint", "requirementsFingerprint", "schemaVersion",
  "blockingItems", "finalUploadsFingerprint", "authorizedMediaFingerprint", "cardId", "value", "inputRefs",
  ...Object.keys(C2_REFERENCE_FIELD_SEMANTICS)
]);

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function boundedDiagnosticPath(path) {
  const text = String(path);
  return text.length <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES
    ? text
    : "$.[path-truncated]";
}

export function appendC2DiagnosticPath(path, rawKey, isArray = false) {
  const base = boundedDiagnosticPath(path);
  const key = String(rawKey);
  if (isArray) {
    return /^(?:0|[1-9][0-9]{0,4})$/.test(key) && Number(key) < PRODUCTION_CONTRACT_MAX_NODES
      ? `${base}[${key}]`
      : `${base}[index]`;
  }
  const segment = C2_DIAGNOSTIC_STATIC_FIELDS.has(key) ? key : "[unknown]";
  const segmentCount = (base.match(/\.|\[/g) || []).length;
  return segmentCount < C2_DIAGNOSTIC_MAX_PATH_SEGMENTS
    ? `${base}.${segment}`
    : `${base}.[path-truncated]`;
}

function diagnosticSemanticSegment(rawKey, isArray) {
  const key = String(rawKey);
  return isArray || C2_DIAGNOSTIC_STATIC_FIELDS.has(key) ? key : "[unknown]";
}

function semanticPathSegment(rawKey, isArray) {
  const key = String(rawKey);
  // Array indexes and unrecognised keys can never make the exact C1 opaque
  // authorizationId path eligible.  Keep a stable sentinel instead of any
  // user-controlled text.
  return isArray ? "[array]" : C2_DIAGNOSTIC_STATIC_FIELDS.has(key) ? key : "[unknown]";
}

function appendBoundedDiagnosticPart(message, part) {
  const candidate = `${message}${part}`;
  return byteLength(candidate) <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES ? candidate : null;
}

export function formatC2ReferenceDiagnostic(code, paths, summary = null) {
  let message = String(code);
  const uniquePaths = [...new Set(paths.map(boundedDiagnosticPath))];
  let included = 0;
  for (const path of uniquePaths) {
    if (included >= C2_DIAGNOSTIC_MAX_PATHS) break;
    const next = appendBoundedDiagnosticPart(message, `${included === 0 ? ":" : ","}${path}`);
    if (next === null) break;
    message = next;
    included += 1;
  }
  if (included < uniquePaths.length) {
    const next = appendBoundedDiagnosticPart(message, `${included === 0 ? ":" : ","}[truncated]`);
    if (next !== null) message = next;
  }
  if (summary !== null) {
    const next = appendBoundedDiagnosticPart(message, `:${summary}`);
    if (next !== null) message = next;
  }
  return message;
}

const RAW_PERSISTENCE_KEYS = new Set([
  "rawresponse", "rawrequest", "rawhtml", "rawpayload", "rawbody", "rawheader", "rawheaders",
  "requestbody", "responsebody", "requestheader", "requestheaders", "responseheader", "responseheaders"
]);

export function assertNoRawPersistenceKeys(value, path, {
  errorCode = "C2_SENSITIVE_INPUT_REJECTED", resourceScope = "production_record"
} = {}) {
  const maxNodes = resourceLimitForScope(resourceScope);
  if (resourceScope === "business_candidate") assertBusinessCandidateResourceBounds(value);
  const stack = [{ kind: "value", value, path: boundedDiagnosticPath(path), depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === "entries") {
      const next = current.iterator.next();
      if (next.done) continue;
      stack.push(current);
      const [key, child] = next.value;
      const childPath = appendC2DiagnosticPath(current.path, key, current.isArray);
      if (!current.isArray && RAW_PERSISTENCE_KEYS.has(normalizeSecretKey(key))) {
        throw new Error(formatC2ReferenceDiagnostic(errorCode, [childPath], "raw-persistence-key"));
      }
      stack.push({ kind: "value", value: child, path: childPath, depth: current.depth + 1 });
      continue;
    }
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > maxNodes) {
      throw new Error(formatC2ReferenceDiagnostic(
        errorCode,
        [current.path],
        "resource-limit"
      ));
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) continue;
    stack.push({
      kind: "entries",
      iterator: ownEnumerableEntries(current.value),
      isArray: Array.isArray(current.value),
      path: current.path,
      depth: current.depth
    });
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ownEnumerableEntries(value) {
  if (Array.isArray(value)) return value.entries();
  return (function* iterateOwnEntries() {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) yield [key, value[key]];
    }
  })();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function fingerprintCanonicalRecord(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizeSecretKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES = Object.freeze([
  Object.freeze({
    key: "x-amz-signature",
    words: Object.freeze(["x", "amz", "signature"]),
    atVariant: true
  }),
  Object.freeze({ key: "x-amz-security-token", words: Object.freeze(["x", "amz", "security", "token"]) }),
  Object.freeze({ key: "x-amz-credential", words: Object.freeze(["x", "amz", "credential"]) }),
  Object.freeze({ key: "x-goog-signature", words: Object.freeze(["x", "goog", "signature"]) }),
  Object.freeze({ key: "x-goog-credential", words: Object.freeze(["x", "goog", "credential"]) }),
  Object.freeze({ key: "x-goog-security-token", words: Object.freeze(["x", "goog", "security", "token"]) }),
  Object.freeze({ key: "AWSAccessKeyId", words: Object.freeze(["aws", "access", "key", "id"]) }),
  Object.freeze({ key: "GoogleAccessId", words: Object.freeze(["google", "access", "id"]) }),
  Object.freeze({ key: "x-oss-security-token", words: Object.freeze(["x", "oss", "security", "token"]) }),
  Object.freeze({ key: "security-token", words: Object.freeze(["security", "token"]) }),
  Object.freeze({ key: "OSSAccessKeyId", words: Object.freeze(["oss", "access", "key", "id"]) }),
  Object.freeze({ key: "x-oss-signature", words: Object.freeze(["x", "oss", "signature"]) }),
  Object.freeze({ key: "x-oss-credential", words: Object.freeze(["x", "oss", "credential"]) }),
  Object.freeze({ key: "x-oss-signature-version", words: Object.freeze(["x", "oss", "signature", "version"]) }),
  Object.freeze({ key: "x-oss-date", words: Object.freeze(["x", "oss", "date"]) }),
  Object.freeze({ key: "x-oss-expires", words: Object.freeze(["x", "oss", "expires"]) }),
  Object.freeze({ key: "x-oss-additional-headers", words: Object.freeze(["x", "oss", "additional", "headers"]) }),
  Object.freeze({ key: "sig", words: Object.freeze(["sig"]) })
]);
export const CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS = Object.freeze(
  CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES.flatMap(({ key, atVariant }) => [
    key,
    ...(atVariant ? [`${key}-at`] : [])
  ])
);

const CANONICAL_REFERENCE_SENSITIVE_NORMALIZED_KEYS = new Set([
  "expires", "expiresat", "expiry", "expiryat",
  ...CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES.flatMap(({ words, atVariant }) => [
    words.join(""),
    ...(atVariant ? [`${words.join("")}at`] : [])
  ])
]);

function boundedDecode(value, maxRounds = PERCENT_ENCODING_MAX_DECODE_DEPTH) {
  const values = [String(value)];
  for (let round = 0; round < maxRounds; round += 1) {
    const current = values.at(-1).replace(/\+/g, "%20");
    let decoded = current;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // A malformed escape must not hide valid escapes that follow it. Decode
      // only complete byte escapes and leave malformed escapes intact.
      decoded = current.replace(/%([0-9a-f]{2})/gi, (_match, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
    if (decoded === values.at(-1)) break;
    values.push(decoded);
  }
  return values;
}

export function hasPercentEncodingBeyondDecodeDepth(value) {
  return /%[0-9a-f]{2}/i.test(boundedDecode(value).at(-1));
}

function normalizeMalformedPercentBoundary(value) {
  // Preserve a following complete %HH escape: it may decode to the first
  // character of a sensitive key.  Only the malformed percent marker and
  // its immediate non-percent prefix become a non-word boundary.
  return String(value).replace(/%(?![0-9a-f]{2})(?:[^%\s])?/gi, " ");
}

function normalizeMalformedPercentEscape(value) {
  // Keep the wider malformed-escape projection as a second bounded scan:
  // `%ZZ-token` must still preserve `-token` as an assignment boundary.
  return String(value).replace(/%(?![0-9a-f]{2})(?:[^%\s]{1,2})?/gi, " ");
}

function secretScanCandidates(value) {
  return boundedDecode(value).flatMap((candidate) => {
    const normalizedCandidates = [
      normalizeMalformedPercentBoundary(candidate),
      normalizeMalformedPercentEscape(candidate)
    ];
    // Normalize before a further bounded decode so `%G%74oken` retains the
    // valid `%74` byte as the first character of a sensitive key; retain the
    // two bounded malformed projections for `%Gtoken` and `%ZZ-token`.
    return [candidate, ...normalizedCandidates.flatMap((normalized) =>
      normalized === candidate ? [] : boundedDecode(normalized)
    )];
  });
}

function isForbiddenSecretKey(key) {
  if (hasPercentEncodingBeyondDecodeDepth(key)) return true;
  return boundedDecode(key).some((candidate) => {
    const normalized = normalizeSecretKey(candidate);
    if ([
      "authorization", "bearer", "basic", "password", "cookie", "cookies", "cookiejar",
      "headers", "requestheaders", "token", "secret", "credential", "credentials"
    ].includes(normalized)) return true;
    if (/^(?:token|secret|credentials?)(?:at)?$/.test(normalized)) return true;
    if (/^(?:access|refresh)token(?:at)?$/.test(normalized)) return true;
    if (/^(?:clientsecret|sessioncookie|apikey|signature)(?:at)?$/.test(normalized)) return true;
    return /^credential(?:value|secret|token|password)(?:at)?$/.test(normalized);
  });
}

function isSensitiveAssignmentKey(key) {
  return isForbiddenSecretKey(key) ||
    CANONICAL_REFERENCE_SENSITIVE_NORMALIZED_KEYS.has(normalizeSecretKey(key));
}

function isSafeSecretAssignmentValue(value) {
  // Assignment scanning evaluates the original text as well as its bounded
  // percent-decoded projections.  Apply the same bounded projection here so
  // a harmless encoded separator (for example, `none%2Dlabel`) has exactly
  // the same meaning as its decoded form, while encoded `=` / `:` remains
  // ineligible as a safe terminator.
  const normalizedValue = boundedDecode(value).at(-1);
  return /^(?:required|not[-_ ]?required|none|not[-_ ]?applicable)(?:$|[^A-Za-z0-9_=%:])/i.test(normalizedValue);
}

const C1_PRICING_REUSE_AUTHORIZATION_PATHS = [
  ["sourcePlan", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"],
  ["sourcePlan", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"],
  ["settledExecution", "authorizedExecution", "authorizationRef", "authorizationId"]
];
const C1_PRICING_REUSE_CONTAINER_PATHS = [
  ["frozenC1Handoff", "draftOnlySeo"],
  ["finalCardInputSnapshot", "c1Snapshot", "draftOnlySeo"],
  ["finalCardInputSnapshot", "canonicalC1", "draftOnlySeo"],
  ["lockedScope", "finalCardInputSnapshot", "c1Snapshot", "draftOnlySeo"],
  ["lockedScope", "finalCardInputSnapshot", "canonicalC1", "draftOnlySeo"],
  ["c1", "canonicalHandoff", "draftOnlySeo"]
];

const C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS_VALUE = Object.freeze({
  runtimeRootPrefixes: Object.freeze([
    Object.freeze([]),
    Object.freeze(["productionAuthorizationPreparation"]),
    Object.freeze(["c2FinalAssets", "productionAuthorizationPreparation"])
  ]),
  runtimePaths: Object.freeze([
    // Only the two already-validated opaque authorization IDs in a frozen
    // editorial source job. Arbitrary *Ref fields receive no exception.
    ...[...C1_PRICING_REUSE_CONTAINER_PATHS, ["draftOnlySeo"], ["c1ProductPlan", "draftOnlySeo"],
      ["lifecycleV11", "skuPackage", "c1ProductPlan", "draftOnlySeo"]].flatMap(prefix =>
      ["scopeBinding", "admissionDecision"].map(section => Object.freeze([
        ...prefix, "editorialSource", "bundle", "sourceJob", section, "authorizationRef"
      ]))),
    ...[...C1_PRICING_REUSE_CONTAINER_PATHS, ["draftOnlySeo"], ["c1ProductPlan", "draftOnlySeo"],
      ["lifecycleV11", "skuPackage", "c1ProductPlan", "draftOnlySeo"]].flatMap(prefix =>
      ["scopeBinding", "admissionDecision"].map(section => Object.freeze([
        ...prefix, "siblingFormalReuseRecord", "sourcePlan", "draftOnlySeo", "editorialSource", "bundle", "sourceJob", section, "authorizationRef"
      ]))),
    ...C1_PRICING_REUSE_CONTAINER_PATHS.flatMap(prefix => C1_PRICING_REUSE_AUTHORIZATION_PATHS.map(suffix =>
      Object.freeze([...prefix, "pricingReuseRecord", ...suffix]))),
    ...[...C1_PRICING_REUSE_CONTAINER_PATHS, ["draftOnlySeo"], ["c1ProductPlan", "draftOnlySeo"],
      ["lifecycleV11", "skuPackage", "c1ProductPlan", "draftOnlySeo"]].flatMap(prefix =>
      C1_PRICING_REUSE_AUTHORIZATION_PATHS.map(suffix => Object.freeze([...prefix, "siblingFormalReuseRecord", ...suffix]))),
    Object.freeze(["frozenC1Handoff", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["frozenC1Handoff", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["finalCardInputSnapshot", "c1Snapshot", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["finalCardInputSnapshot", "c1Snapshot", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["finalCardInputSnapshot", "canonicalC1", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["lockedScope", "finalCardInputSnapshot", "c1Snapshot", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["lockedScope", "finalCardInputSnapshot", "c1Snapshot", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["lockedScope", "finalCardInputSnapshot", "canonicalC1", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["c1", "seoDraft", "evidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["c1", "canonicalHandoff", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"])
  ]),
  schemaPaths: Object.freeze({
    c2SoftwareInput: Object.freeze([
      Object.freeze(["$defs", "paidAuthorizationRef", "properties", "authorizationId"])
    ]),
    c2AssetLifecycle: Object.freeze([
      Object.freeze([
        "$defs", "canonicalC1Handoff", "properties", "draftOnlySeo", "oneOf", 0, "properties", "providerJobRef",
        "properties", "authorizationRef", "properties", "authorizationId"
      ])
    ])
  })
});

// A competitor text reference locates a field in frozen evidence, not a file
// or a network resource. Attribute names are JSON Pointer segments and may be
// multilingual. Only this declared request field has that meaning.
const C1_COMPETITOR_TEXT_REFERENCE_PATHS = Object.freeze(
  C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS_VALUE.runtimeRootPrefixes.flatMap(root =>
    [...C1_PRICING_REUSE_CONTAINER_PATHS, ["draftOnlySeo"], ["c1ProductPlan", "draftOnlySeo"],
      ["lifecycleV11", "skuPackage", "c1ProductPlan", "draftOnlySeo"]].flatMap(prefix => [
      Object.freeze([...root, ...prefix, "editorialSource", "bundle", "request", "competitorTextEvidence", "texts", "[array]", "sourceRef"]),
      Object.freeze([...root, ...prefix, "siblingFormalReuseRecord", "sourcePlan", "draftOnlySeo", "editorialSource", "bundle", "request", "competitorTextEvidence", "texts", "[array]", "sourceRef"])
    ]))
);

const C1_CONTEXT_TEXT_REFERENCE_PATHS = Object.freeze(C1_COMPETITOR_TEXT_REFERENCE_PATHS.map(path =>
  Object.freeze([...path.slice(0, -4), "referenceContext", "referenceTexts", "[array]", "sourceRef"])));

/**
 * One public source for collector field semantics and the single C1 opaque-ID
 * exception that the schema generator materializes at explicit paths.
 */
export const C2_REFERENCE_SEMANTICS = Object.freeze({
  fields: C2_REFERENCE_FIELD_SEMANTICS,
  c1OpaqueAuthorizationId: C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS_VALUE,
  c1CompetitorTextReferencePaths: C1_COMPETITOR_TEXT_REFERENCE_PATHS,
  c1ContextTextReferencePaths: C1_CONTEXT_TEXT_REFERENCE_PATHS
});
export const C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS = C2_REFERENCE_SEMANTICS.c1OpaqueAuthorizationId;

// The allowed paths are the frozen prefix x path cross product (84 pairs).  It
// never changes at runtime, so materialize it once and bucket it by segment
// count.  Every string in a production record is checked against this table, and
// rebuilding all 84 expected paths per string accounted for about a third of the
// scan's self time.  The membership test below answers exactly what the old one
// answered: same order (path first, canonical id second), same element-wise
// `===` comparison, just without the per-string allocation.
const C1_OPAQUE_AUTHORIZATION_ID_ALLOWED_PATHS_BY_LENGTH = (() => {
  const byLength = new Map();
  for (const prefix of C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimeRootPrefixes) {
    for (const path of C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths) {
      const expected = Object.freeze([...prefix, ...path]);
      const bucket = byLength.get(expected.length);
      if (bucket) bucket.push(expected);
      else byLength.set(expected.length, [expected]);
    }
  }
  for (const [length, bucket] of byLength) byLength.set(length, Object.freeze(bucket));
  return byLength;
})();

function isAllowedC1OpaqueAuthorizationId(value, pathSegments) {
  const text = String(value);
  // Read the segment count unconditionally, as the old comparison did, so a
  // malformed `pathSegments` still fails loudly instead of quietly answering
  // "not allowed".
  const expectedPaths = C1_OPAQUE_AUTHORIZATION_ID_ALLOWED_PATHS_BY_LENGTH.get(pathSegments.length);
  let allowedPath = false;
  if (expectedPaths !== undefined) {
    for (const expected of expectedPaths) {
      let matches = true;
      for (let index = 0; index < expected.length; index += 1) {
        if (expected[index] !== pathSegments[index]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        allowedPath = true;
        break;
      }
    }
  }
  if (!allowedPath ||
      !isCanonicalC1AuthorizationId(text)) {
    return false;
  }
  return true;
}

// One document walk sees the same string value many times over: a real business
// record holds about 8000 strings but only about 480 distinct ones.  Every part
// of the scan except the C1 opaque-authorization allowance is a pure function of
// the string, and the allowance is a plain boolean, so `(value, allowance)` is a
// complete cache key — nothing about the path leaks past it and a repeated
// secret is still reported at every path it appears on.
//
// The cache is scoped to a single `collectProductionSecretErrors` call on
// purpose, not to the module: a module-level cache in a long-running server
// would grow without bound and carry one request's strings into the next.  This
// one dies with the walk and is bounded by the walk's own node limit
// (PRODUCTION_CONTRACT_MAX_NODES / BUSINESS_CANDIDATE_MAX_NODES).
function createSecretScanCache() {
  return { encodingDepth: new Map(), scan: [new Map(), new Map()] };
}

function secretValueReason(value, pathSegments, cache = createSecretScanCache()) {
  let beyondDecodeDepth = cache.encodingDepth.get(value);
  if (beyondDecodeDepth === undefined) {
    beyondDecodeDepth = hasPercentEncodingBeyondDecodeDepth(value);
    cache.encodingDepth.set(value, beyondDecodeDepth);
  }
  if (beyondDecodeDepth) return "encoded content exceeds approved depth";
  const allowedOpaqueAuthorizationId = isAllowedC1OpaqueAuthorizationId(value, pathSegments);
  const scanned = cache.scan[allowedOpaqueAuthorizationId ? 1 : 0];
  if (scanned.has(value)) return scanned.get(value);
  const reason = secretScanReason(value, allowedOpaqueAuthorizationId);
  scanned.set(value, reason);
  return reason;
}

function secretScanReason(value, allowedOpaqueAuthorizationId) {
  for (const text of secretScanCandidates(value)) {
    if (/\b(?:bearer|basic)\s+(?!(?:plant|extract|required|documentation|material|design)\b)[A-Za-z0-9._~+/=-]{3,}/i.test(text)) {
      return "authorization value";
    }
    if (/^(?:bearer|basic)[-_:](?=.*(?:token|key|secret|credential))[A-Za-z0-9._~+/-]{3,}$/i.test(text)) {
      return "authorization value";
    }
    if (/(?:^|[^A-Za-z0-9_])note\s*[:=]\s*(?:bearer|basic)(?:$|[^A-Za-z0-9_])/i.test(text)) {
      return "authorization value";
    }
    const assignmentPattern = /[=:]\s*(\S{0,192})/g;
    for (let match = assignmentPattern.exec(text); match; ) {
      const prefix = text.slice(Math.max(0, match.index - 64), match.index).trimEnd();
      const singleKey = prefix.match(/(?:^|[^A-Za-z0-9_])([A-Za-z0-9][A-Za-z0-9_-]*)$/)?.[1];
      const words = singleKey ? [singleKey] : [];
      const spacedSuffix = prefix.match(/(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*){1,2})$/)?.[1];
      if (spacedSuffix) words.push(...spacedSuffix.split(/\s+/).map((_, index, all) => all.slice(index).join(" ")));
      const forbiddenAssignment = words.some(isSensitiveAssignmentKey);
      const keyStart = singleKey ? match.index - singleKey.length : -1;
      const ampersandDelimited = keyStart > 0 && text[keyStart - 1] === "&";
      if (forbiddenAssignment && (ampersandDelimited || !isSafeSecretAssignmentValue(match[1])) &&
          !(allowedOpaqueAuthorizationId && text === value)) {
        return "secret assignment";
      }
      // Advance one delimiter at a time: a value such as `x=token=abc`
      // must not hide the later `token=abc` assignment behind the first `=`.
      assignmentPattern.lastIndex = match.index + 1;
      match = assignmentPattern.exec(text);
    }
    if (ENCODED_URL_USERINFO_PATTERN.test(text) || ENCODED_SCHEME_RELATIVE_USERINFO_PATTERN.test(text)) {
      return "URL userinfo";
    }
    const candidates = [text];
    if (text.startsWith("//")) candidates.push(`https:${text}`);
    else if (/^[/?#]/.test(text) || /[?#]/.test(text)) candidates.push(`https://schema.invalid/${text}`);
    for (const candidate of candidates) {
      // `URL.canParse(x)` is specified as exactly "would `new URL(x)` not
      // throw", so this skips only the strings the `catch` below already
      // ignored — it never decides what counts as a URL, and every string that
      // does parse still goes through the full check.  It is here because most
      // business text is not a URL and building the thrown exception cost more
      // than the parse itself.  `try`/`catch` stays: it is the guarantee, the
      // pre-check is only the fast path.
      if (!URL.canParse(candidate)) continue;
      try {
        const parsed = new URL(candidate);
        if (parsed.username || parsed.password) return "URL userinfo";
        for (const key of [...parsed.searchParams.keys(), ...new URLSearchParams(parsed.hash.replace(/^#/, "")).keys()]) {
          if (isForbiddenSecretKey(key) ||
              CANONICAL_REFERENCE_SENSITIVE_NORMALIZED_KEYS.has(normalizeSecretKey(key))) {
            return "URL secret parameter";
          }
        }
      } catch {
        // Non-URL business text is validated by the explicit assignment patterns above.
      }
    }
  }
  return null;
}

export function collectProductionSecretErrors(value, path, errors, pathSegments = [], resourceScope = "production_record") {
  const maxNodes = resourceLimitForScope(resourceScope);
  if (resourceScope === "business_candidate") assertBusinessCandidateResourceBounds(value);
  const stack = [{ kind: "value", value, path, pathSegments, depth: 0 }];
  const secretScanCache = createSecretScanCache();
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === "entries") {
      const next = current.iterator.next();
      if (next.done) continue;
      stack.push(current);
      const [rawKey, entry] = next.value;
      const key = String(rawKey);
      const childPath = appendC2DiagnosticPath(current.path, key, current.isArray);
      if (!current.isArray && isForbiddenSecretKey(key)) {
        errors.push({ path: childPath, message: "不得保存秘密字段" });
      }
      stack.push({
        kind: "value",
        value: entry,
        path: childPath,
        pathSegments: [...current.pathSegments, diagnosticSemanticSegment(key, current.isArray)],
        depth: current.depth + 1
      });
      continue;
    }
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > maxNodes) {
      errors.push({ path: current.path, message: PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED });
      return;
    }
    if (typeof current.value === "string") {
      const reason = secretValueReason(current.value, current.pathSegments, secretScanCache);
      if (reason) errors.push({ path: current.path, message: `不得保存秘密：${reason}` });
      continue;
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) continue;
    stack.push({
      kind: "entries",
      iterator: ownEnumerableEntries(current.value),
      isArray: Array.isArray(current.value),
      path: current.path,
      pathSegments: current.pathSegments,
      depth: current.depth
    });
  }
}

export function assertNoProductionSecrets(value, path = "productionAuthorization", { resourceScope = "production_record" } = {}) {
  const errors = [];
  collectProductionSecretErrors(value, path, errors, [], resourceScope);
  if (errors.length > 0) {
    const secretPaths = errors
      .filter((item) => item.message !== PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
      .map((item) => item.path);
    if (secretPaths.length > 0) {
      throw new Error(formatC2ReferenceDiagnostic(
        "PRODUCTION_AUTHORIZATION_SECRET_REJECTED",
        secretPaths,
        "secret-rejected"
      ));
    }
    if (errors.some((item) => item.message === PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)) {
      throw new Error(formatC2ReferenceDiagnostic(
        PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
        errors.filter((item) => item.message === PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED).map((item) => item.path),
        "resource-limit"
      ));
    }
  }
  return value;
}

function asciiCaseInsensitive(value) {
  return [...value].map((character) => /[a-z]/i.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]`
    : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
}

const canonicalKeyPattern = (...words) => words.map(asciiCaseInsensitive).join("[._~-]*");
const canonicalObfuscatedWordPattern = (word) => [...word]
  .map(asciiCaseInsensitive)
  .join("[._~-]*");
const canonicalSensitiveNamespacePattern = `(?:${[
  ["authorization"], ["bearer"], ["basic"], ["password"], ["cookie"], ["cookies"],
  ["cookiejar"], ["headers"], ["request", "headers"], ["token"], ["token", "at"],
  ["secret"], ["secret", "at"], ["credential"], ["credentials"], ["credential", "at"],
  ["credentials", "at"], ["access", "token"], ["access", "token", "at"],
  ["refresh", "token"], ["refresh", "token", "at"], ["client", "secret"],
  ["client", "secret", "at"], ["session", "cookie"], ["session", "cookie", "at"],
  ["api", "key"], ["api", "key", "at"], ["signature"], ["signature", "at"],
  ["credential", "value"], ["credential", "secret"], ["credential", "token"],
  ["credential", "password"], ["raw", "response"], ["raw", "response", "at"],
  ["raw", "request"], ["raw", "request", "at"], ["request", "body"],
  ["response", "headers"], ["response", "headers", "at"], ["raw", "html"], ["raw", "payload"]
].map((words) => words.length === 1
  ? canonicalObfuscatedWordPattern(words[0])
  : canonicalKeyPattern(...words)).join("|")})`;
const canonicalReferenceSensitiveKeyPattern = `(?:${canonicalSensitiveNamespacePattern}|${[
  ["expires"], ["expires", "at"], ["expiry"], ["expiry", "at"],
  ...CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES.flatMap(({ words, atVariant }) => [
    words,
    ...(atVariant ? [[...words, "at"]] : [])
  ])
].map((words) => canonicalKeyPattern(...words)).join("|")})`;
const canonicalReferenceSensitivePathSegmentPattern =
  `(?:^|[/:])${canonicalReferenceSensitiveKeyPattern}(?::|/|$)`;
export const PERCENT_ENCODING_BEYOND_MAX_DEPTH_PATTERN_SOURCE =
  `%(?:25){${PERCENT_ENCODING_MAX_DECODE_DEPTH},}[0-9A-Fa-f]{2}`;
const ENCODED_URL_USERINFO_PATTERN = /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\r\n]*@/;
const ENCODED_SCHEME_RELATIVE_USERINFO_PATTERN = /(?:^|[^A-Za-z0-9+.-])\/\/[^/?#\r\n]*@/;

export const C2_REFERENCE_REJECTED_NONCANONICAL = "C2_REFERENCE_REJECTED_NONCANONICAL";
export const C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED = "C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED";
export const C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED = "C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED";
export const CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH = 1024;

export const C2_SOFTWARE_INPUT_C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE = [
  "^(?=.{27,256}$)authorization:c1-ai-draft:",
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[._~-]|$))`,
  "[A-Za-z0-9][A-Za-z0-9._~-]*$"
].join("");

export const C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE = [
  "^(?=.{27,256}$)authorization:c1-ai-draft:",
  "(?!.*[\\r\\n])",
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[._~-]|$))`,
  "[A-Za-z0-9][A-Za-z0-9._~-]*$"
].join("");
const C1_OPAQUE_AUTHORIZATION_ID_PATTERN = new RegExp(C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE);

export const C2_SOFTWARE_INPUT_CANONICAL_FROZEN_REF_PATTERN_SOURCE = [
  `^(?=.{1,${SAFE_FROZEN_REF_MAX_LENGTH}}$)`,
  "(?!.*//)",
  `(?!(?:${asciiCaseInsensitive("bearer")}|${asciiCaseInsensitive("basic")})(?:[._~@#+-]|$))`,
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[:/]|$))`,
  "[A-Za-z0-9][A-Za-z0-9._~:/@#+-]*$"
].join("");

export const CANONICAL_FROZEN_REF_PATTERN_SOURCE = [
  `^(?=.{1,${SAFE_FROZEN_REF_MAX_LENGTH}}$)`,
  "(?!.*[\\r\\n])",
  "(?!.*//)",
  `(?!(?:${asciiCaseInsensitive("bearer")}|${asciiCaseInsensitive("basic")})(?:[._~@#+-]|$))`,
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[:/]|$))`,
  `(?!.*${canonicalReferenceSensitivePathSegmentPattern})`,
  "[A-Za-z0-9][A-Za-z0-9._~:/@#+-]*$"
].join("");

const canonicalQueryPair = "[A-Za-z0-9._~-]+=[A-Za-z0-9._~-]+";
export const C2_SOFTWARE_INPUT_CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE = [
  `^(?=.{1,${CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH}}$)`,
  `(?!.*[?&]${canonicalReferenceSensitiveKeyPattern}=)`,
  "(?!.*(?:/\\.{1,2})(?:/|\\?|$))",
  "(?!https://[^/]+/.*//)",
  "https://",
  "(?!localhost(?:/|$))",
  "(?![^/]*\\.(?:localhost|local)(?:/|$))",
  "(?!(?:[0-9.]+|\\[[^\\]]+\\])(?:/|$))",
  "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+",
  "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?",
  "/[A-Za-z0-9._~!$'()*+,:@/-]+",
  `(?:\\?${canonicalQueryPair}(?:&${canonicalQueryPair})*)?$`
].join("");
export const CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE = [
  `^(?=.{1,${CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH}}$)`,
  "(?!.*[\\r\\n])",
  `(?!.*[?&]${canonicalReferenceSensitiveKeyPattern}=)`,
  `(?!.*${canonicalReferenceSensitivePathSegmentPattern})`,
  "(?!.*(?:/\\.{1,2})(?:/|\\?|$))",
  "(?!https://[^/]+/.*//)",
  "https://",
  "(?!localhost(?:/|$))",
  "(?![^/]*\\.(?:localhost|local)(?:/|$))",
  "(?!(?:[0-9.]+|\\[[^\\]]+\\])(?:/|$))",
  "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+",
  "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?",
  "/[A-Za-z0-9._~!$'()*+,:@/-]+",
  `(?:\\?${canonicalQueryPair}(?:&${canonicalQueryPair})*)?$`
].join("");

const CANONICAL_FROZEN_REF_PATTERN = new RegExp(CANONICAL_FROZEN_REF_PATTERN_SOURCE);
const CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN = new RegExp(CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE);
export const CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE =
  "^https://(?:localhost|[^/]*\\.(?:localhost|local|localdomain|lan|home|internal))(?:/|$)";

export const C2_REFERENCE_SCHEMA_DEFS = Object.freeze({
  canonicalFrozenRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: C2_SOFTWARE_INPUT_CANONICAL_FROZEN_REF_PATTERN_SOURCE
  }),
  canonicalStableHttpsAssetRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH,
    pattern: C2_SOFTWARE_INPUT_CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE
  }),
  analysisAssetRef: Object.freeze({
    oneOf: Object.freeze([
      Object.freeze({ $ref: "#/$defs/canonicalFrozenRef" }),
      Object.freeze({ $ref: "#/$defs/canonicalStableHttpsAssetRef" })
    ])
  }),
  c1OpaqueAuthorizationId: Object.freeze({
    type: "string",
    minLength: 27,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: C2_SOFTWARE_INPUT_C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE
  })
});

export const C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS = Object.freeze({
  ...C2_REFERENCE_SCHEMA_DEFS,
  canonicalFrozenRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: CANONICAL_FROZEN_REF_PATTERN_SOURCE
  }),
  canonicalStableHttpsAssetRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH,
    allOf: Object.freeze([
      Object.freeze({
        not: Object.freeze({
          pattern: CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE
        })
      })
    ]),
    pattern: CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE
  }),
  c1OpaqueAuthorizationId: Object.freeze({
    type: "string",
    minLength: 27,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE
  })
});

export function isCanonicalFrozenRef(value) {
  return typeof value === "string" && CANONICAL_FROZEN_REF_PATTERN.test(value);
}

/** Opaque persisted production IDs may embed several source IDs; never use these as URLs. */
export function isOpaqueProductionSourceRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !["unknown", "null", "undefined", "not_applicable", "missing"].includes(value.toLowerCase());
}

export function assertCanonicalFrozenRef(value, path = "canonicalFrozenRef") {
  if (!isCanonicalFrozenRef(value)) throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  return value;
}

export function isCanonicalStableHttpsAssetRef(value) {
  return typeof value === "string" && CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN.test(value);
}

export function assertCanonicalStableHttpsAssetRef(value, path = "canonicalStableHttpsAssetRef") {
  if (!isCanonicalStableHttpsAssetRef(value)) {
    throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  }
  return value;
}

export const LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE = "^local-asset:c2-local:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
const LOCAL_FINAL_ASSET_REF_PATTERN = new RegExp(LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE);

export function isLocalFinalAssetRef(value) {
  return typeof value === "string" && LOCAL_FINAL_ASSET_REF_PATTERN.test(value);
}

export function isCanonicalFinalAssetRef(value) {
  return isLocalFinalAssetRef(value) || isCanonicalStableHttpsAssetRef(value);
}

// C2 locks an immutable local file or an already stable remote file. Only D resolves local files for transport.
export function assertFinalAssetLocation(asset, path = "finalUpload") {
  if (!asset || typeof asset !== "object") throw new Error(`C2_FINAL_ASSET_LOCATION_INVALID:${path}`);
  if (isLocalFinalAssetRef(asset.assetRef)) {
    if (asset.assetRef !== `local-asset:${asset.assetId}` || asset.stableUrlEvidenceRef !== "not_applicable" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.assetVersion !== `sha256:${asset.sha256}` ||
        !Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0) {
      throw new Error(`C2_FINAL_ASSET_LOCATION_INVALID:${path}`);
    }
    return "local";
  }
  assertCanonicalStableHttpsAssetRef(asset.assetRef, `${path}.assetRef`);
  assertCanonicalFrozenRef(asset.stableUrlEvidenceRef, `${path}.stableUrlEvidenceRef`);
  if (asset.stableUrlEvidenceRef === "not_applicable") throw new Error(`C2_FINAL_ASSET_LOCATION_INVALID:${path}`);
  return "remote";
}

export function isCanonicalAnalysisAssetRef(value) {
  return isCanonicalFrozenRef(value) || isCanonicalStableHttpsAssetRef(value);
}

export function assertCanonicalAnalysisAssetRef(value, path = "analysisAssetRef") {
  if (!isCanonicalAnalysisAssetRef(value)) {
    throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  }
  return value;
}

export function isCanonicalC1AuthorizationId(value) {
  return typeof value === "string" && C1_OPAQUE_AUTHORIZATION_ID_PATTERN.test(value);
}

export function assertCanonicalC1AuthorizationId(value, path = "authorizationId") {
  if (!isCanonicalC1AuthorizationId(value)) {
    throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  }
  return value;
}

function isAnalysisAssetRefPath(pathSegments) {
  if (pathSegments.at(-1) !== "assetRef") return false;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    if (["assets", "assetRegions"].includes(pathSegments[index]) &&
        ["collected", "aiDrafts"].includes(pathSegments[index + 1])) return true;
  }
  return false;
}

function isFrozenC1CompetitorTextPointer(value, pathSegments, root) {
  if (value.length > SAFE_FROZEN_REF_MAX_LENGTH ||
      !C1_COMPETITOR_TEXT_REFERENCE_PATHS.some(expected => expected.length === pathSegments.length &&
        expected.every((segment, index) => segment === pathSegments[index]))) return false;
  const snapshot = pathSegments.slice(0, -3).reduce((node, segment) => node[segment], root);
  if (!isCanonicalFrozenRef(snapshot.evidenceRef) || !value.startsWith(`${snapshot.evidenceRef}#`)) return false;
  const pointer = value.slice(snapshot.evidenceRef.length + 1);
  return pointer === "/title" || (pointer.startsWith("/attributes/") &&
    /^(?:[^~\u0000-\u001f\u007f]|~[01])*$/u.test(pointer.slice("/attributes/".length)));
}

function isEncodedSupplierAttributeKey(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); }
  catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
  return decoded.length > 0 && encodeURIComponent(decoded) === value &&
    /^(?:[^~/\u0000-\u001f\u007f]|~[01])+$/u.test(decoded);
}

// These are pointers into saved language evidence, never file or URL targets.
// The request source validator owns capture/SKU/text provenance; this lower
// layer checks the declared pointer representation without rewriting the request.
function isFrozenC1ContextTextPointer(value, pathSegments, root, row) {
  if (value.length > SAFE_FROZEN_REF_MAX_LENGTH ||
      !C1_CONTEXT_TEXT_REFERENCE_PATHS.some(expected => expected.length === pathSegments.length &&
        expected.every((segment, index) => segment === pathSegments[index]))) return false;
  const request = pathSegments.slice(0, -4).reduce((node, segment) => node[segment], root);
  const context = request.referenceContext;
  if (!isObject(row) || row.sourceRef !== value || typeof row.text !== "string" ||
      row.text.length < 1 || row.text.length > 6000 || row.text.trim().length === 0 ||
      context.role !== "language_reference_not_product_facts" ||
      !["c1-seo-reference-context-v1", "c1-seo-reference-context-v2", "c1-seo-reference-context-v3"].includes(context.schemaVersion) ||
      !Array.isArray(context.referenceTexts) || context.referenceTexts.length < 1 || context.referenceTexts.length > 100) return false;
  if (row.kind === "competitor_text") {
    const snapshot = request.competitorTextEvidence;
    return isObject(snapshot) && Array.isArray(snapshot.texts) && snapshot.texts.length <= 100 &&
      snapshot.texts.some(item => isObject(item) && item.sourceRef === value && item.text === row.text) &&
      isFrozenC1CompetitorTextPointer(value,
        [...pathSegments.slice(0, -4), "competitorTextEvidence", "texts", "[array]", "sourceRef"], root);
  }
  const parts = value.split("#");
  if (parts.length !== 2 || !isCanonicalFrozenRef(parts[0])) return false;
  const [evidenceRef, pointer] = parts;
  if (row.kind === "competitor_description") {
    return context.schemaVersion !== "c1-seo-reference-context-v1" &&
      ["/description", "/attributes/description", "/attributes/Описание"].includes(pointer);
  }
  if (context.schemaVersion !== "c1-seo-reference-context-v3") return false;
  if (row.kind === "supplier_attribute") {
    if (!pointer.startsWith("/supplierSku/attributes/") || !Array.isArray(request.verifiedFacts) ||
        request.verifiedFacts.length > PRODUCTION_CONTRACT_MAX_NODES) return false;
    const skuFact = request.verifiedFacts.find(fact => isObject(fact) && fact.factPath === "exactSkuVerification.supplierSkuId");
    return isObject(skuFact) && Array.isArray(skuFact.evidenceRefs) &&
      skuFact.evidenceRefs.length > 0 && skuFact.evidenceRefs.length <= PRODUCTION_CONTRACT_MAX_NODES &&
      skuFact.evidenceRefs.includes(`${evidenceRef}#/supplierSku/supplierSkuId`) &&
      isEncodedSupplierAttributeKey(pointer.slice("/supplierSku/attributes/".length));
  }
  if (row.kind === "supplier_variant_attribute") {
    const match = /^\/skuChoices\/(0|[1-9][0-9]*)\/attributes\/(.+)$/.exec(pointer);
    return match !== null && Number.isSafeInteger(Number(match[1])) && isEncodedSupplierAttributeKey(match[2]);
  }
  return false;
}

function isCanonicalC2ReferenceValue(value, semanticKind, pathSegments, root, parent) {
  if (semanticKind === "assetRef") {
    return isAnalysisAssetRefPath(pathSegments)
      ? isCanonicalAnalysisAssetRef(value)
      : isCanonicalFinalAssetRef(value);
  }
  if (semanticKind === "authorizationId") {
    return isAllowedC1OpaqueAuthorizationId(value, pathSegments)
      ? isCanonicalC1AuthorizationId(value)
      : isCanonicalFrozenRef(value);
  }
  if (semanticKind === "sourceRef") {
    return isCanonicalFrozenRef(value) || isCanonicalStableHttpsAssetRef(value) ||
      isFrozenC1CompetitorTextPointer(value, pathSegments, root) ||
      isFrozenC1ContextTextPointer(value, pathSegments, root, parent);
  }
  if (semanticKind === "canonicalFrozenRef") return isCanonicalFrozenRef(value);
  return true;
}

export function collectCanonicalC2ReferenceErrors(value, path = "$", semanticField = null, errors = []) {
  const stack = [{ kind: "value", value, path, semanticField, pathSegments: [], depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === "entries") {
      const next = current.iterator.next();
      if (next.done) continue;
      stack.push(current);
      const [rawKey, entry] = next.value;
      const key = String(rawKey);
      const childPath = appendC2DiagnosticPath(current.path, key, current.isArray);
      const childSemanticKind = current.isArray
        ? current.semanticField
        : key === "value" && C2_REFERENCE_SEMANTIC_KINDS.has(current.semanticField)
          ? current.semanticField
          : C2_REFERENCE_FIELD_SEMANTICS[key] || null;
      stack.push({
        kind: "value",
        value: entry,
        parent: current.value,
        path: childPath,
        semanticField: childSemanticKind,
        pathSegments: [...current.pathSegments, semanticPathSegment(key, current.isArray)],
        depth: current.depth + 1
      });
      continue;
    }
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > PRODUCTION_CONTRACT_MAX_NODES) {
      errors.push({ path: current.path, message: C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED });
      return errors;
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) {
      if (typeof current.value === "string" && current.semanticField !== null &&
          !isCanonicalC2ReferenceValue(current.value, current.semanticField, current.pathSegments, value, current.parent)) {
        errors.push({ path: current.path, message: C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED });
      }
      continue;
    }
    stack.push({
      kind: "entries",
      value: current.value,
      iterator: ownEnumerableEntries(current.value),
      isArray: Array.isArray(current.value),
      path: current.path,
      semanticField: current.semanticField,
      pathSegments: current.pathSegments,
      depth: current.depth
    });
  }
  return errors;
}

export function assertCanonicalC2ReferenceTree(value, path = "productionAuthorizationPreparation") {
  const errors = collectCanonicalC2ReferenceErrors(value, path);
  if (errors.length > 0) {
    if (errors.some((item) => item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED)) {
      throw new Error(formatC2ReferenceDiagnostic(
        C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
        errors.filter((item) => item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED).map((item) => item.path),
        "resource-limit"
      ));
    }
    throw new Error(formatC2ReferenceDiagnostic(
      C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED,
      errors.filter((item) => item.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED).map((item) => item.path),
      "migration-required"
    ));
  }
  return value;
}

const D_PRODUCTION_JOB_ID_PREFIX = "d-production-job:";
export const D_PRODUCTION_MAX_ROUNDS = 20;

/**
 * 一个生产授权对应一段 D 工作；一段 D 工作可能要跑不止一轮。
 * 第一轮沿用原来的作业号（历史数据不动），之后每一轮受控重派都带自己的轮次号。
 */
export function dProductionJobIdForRound(authorizationFingerprint, round) {
  if (typeof authorizationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(authorizationFingerprint) ||
      !Number.isSafeInteger(round) || round < 1 || round > D_PRODUCTION_MAX_ROUNDS) {
    throw new Error("D_PRODUCTION_JOB_ROUND_INVALID");
  }
  return round === 1 ? `${D_PRODUCTION_JOB_ID_PREFIX}${authorizationFingerprint}`
    : `${D_PRODUCTION_JOB_ID_PREFIX}${authorizationFingerprint}:round${round}`;
}

/** 返回这个作业号属于该授权的第几轮；不属于该授权就返回 null，调用方按不匹配处理。 */
export function dProductionJobRound(jobId, authorizationFingerprint) {
  if (typeof jobId !== "string" || typeof authorizationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(authorizationFingerprint)) return null;
  const base = `${D_PRODUCTION_JOB_ID_PREFIX}${authorizationFingerprint}`;
  if (jobId === base) return 1;
  if (!jobId.startsWith(`${base}:round`)) return null;
  const suffix = jobId.slice(`${base}:round`.length);
  if (!/^(?:[1-9][0-9]?)$/.test(suffix)) return null;
  const round = Number(suffix);
  return round >= 2 && round <= D_PRODUCTION_MAX_ROUNDS ? round : null;
}
