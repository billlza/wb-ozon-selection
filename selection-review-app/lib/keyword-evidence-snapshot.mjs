import { createHash } from "node:crypto";

export const KEYWORD_EVIDENCE_SNAPSHOT_VERSION = "keyword-evidence-snapshot-v1";
export const KEYWORD_SOURCE_ATTEMPT_VERSION = "keyword-source-attempt-v1";

// Persisted scoring versions retain their original quantity policy. Snapshot
// readers must not reinterpret historical results using today's minima.
const SCORING_GROUP_LIMITS = deepFreeze({
  "keyword-scoring-v1": {
    title_keywords: { min: 3, max: 5 },
    attribute_and_tag_keywords: { min: 6, max: 12 },
    description_long_tail: { min: 10, max: 20 }
  },
  "keyword-scoring-v2": {
    title_keywords: { min: 1, max: 5 },
    attribute_and_tag_keywords: { min: 0, max: 12 },
    description_long_tail: { min: 0, max: 20 }
  }
});

export function keywordScoringGroupLimits(version) {
  return Object.hasOwn(SCORING_GROUP_LIMITS, version) ? SCORING_GROUP_LIMITS[version] : null;
}

function hasRequiredGroups(groups, scoringVersion) {
  if (scoringVersion === "keyword-scoring-v2") {
    return KEYWORD_GROUPS.every(group => Array.isArray(groups?.[group]) &&
      groups[group].length >= SCORING_GROUP_LIMITS[scoringVersion][group].min);
  }
  // Unscored snapshots and v1 retain the original three-group coverage rule.
  return KEYWORD_GROUPS.every(group => Array.isArray(groups?.[group]) && groups[group].length > 0);
}

export const KEYWORD_PREPARATION_STATUSES = Object.freeze([
  "ready",
  "partial_ready",
  "technical_unavailable",
  "true_empty",
  "stale",
  "needs_review"
]);

export const KEYWORD_FAILURE_CLASSES = Object.freeze([
  "login_required",
  "quota_or_rate_limit",
  "network_timeout",
  "network_error",
  "selector_changed",
  "input_not_committed",
  "stale_result",
  "true_empty",
  "provider_server_error"
]);

export const KEYWORD_GROUPS = Object.freeze([
  "title_keywords",
  "attribute_and_tag_keywords",
  "description_long_tail"
]);

const TECHNICAL_FAILURES = new Set([
  "login_required",
  "quota_or_rate_limit",
  "network_timeout",
  "network_error",
  "selector_changed",
  "input_not_committed",
  "provider_server_error"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
}

function isoDateTime(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function finiteOrNull(value) {
  return value === null || Number.isFinite(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function withoutFingerprint(snapshot) {
  const copy = structuredClone(snapshot);
  delete copy.snapshotFingerprint;
  return copy;
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function classifyKeywordSourceFailure(observation) {
  if (!isObject(observation)) throw new TypeError("KEYWORD_ATTEMPT_CLASSIFICATION_INVALID: 必须提供结构化观察");
  const channel = observation.channel;
  if (!["api", "browser", "local_fusion"].includes(channel)) throw new Error("KEYWORD_ATTEMPT_CHANNEL_INVALID");
  if (channel === "local_fusion") return null;
  if (observation.stale === true) return "stale_result";
  if (observation.loginRequired === true || [401, 403].includes(observation.httpStatus)) return "login_required";
  if (observation.quotaExceeded === true || observation.rateLimited === true || observation.httpStatus === 429) return "quota_or_rate_limit";
  if (observation.timeout === true) return "network_timeout";
  if (observation.networkError === true) return "network_error";
  if (channel === "browser" && observation.selectorChanged === true) return "selector_changed";
  if (channel === "browser" && observation.inputCommitted === false) return "input_not_committed";
  if (Number.isInteger(observation.httpStatus) && observation.httpStatus >= 500 && observation.httpStatus <= 599) return "provider_server_error";
  if (observation.completed === true && observation.resultCount === 0 && isoDateTime(observation.completedAt) &&
      (nonEmpty(observation.requestId) || nonEmpty(observation.receiptId)) && nonEmpty(observation.queryId) && nonEmpty(observation.provider)) {
    return "true_empty";
  }
  return null;
}

function validateAttempt(attempt, index, errors) {
  const path = `sourceAttempts[${index}]`;
  if (!isObject(attempt)) return push(errors, path, "必须是对象");
  if (attempt.schemaVersion !== KEYWORD_SOURCE_ATTEMPT_VERSION) push(errors, `${path}.schemaVersion`, "版本无效");
  for (const field of ["attemptId", "provider", "queryId", "queryText", "locale", "targetPlatform", "traceRef", "startedAt"]) {
    if (!nonEmpty(attempt[field])) push(errors, `${path}.${field}`, "必须是非空字符串");
  }
  if (!isoDateTime(attempt.startedAt)) push(errors, `${path}.startedAt`, "必须是有效时间");
  if (!['api', 'browser', 'local_fusion'].includes(attempt.channel)) push(errors, `${path}.channel`, "必须是api、browser或local_fusion");
  if (!['completed', 'failed'].includes(attempt.status)) push(errors, `${path}.status`, "必须是completed或failed");
  if (!(nonEmpty(attempt.requestId) || nonEmpty(attempt.receiptId))) push(errors, path, "必须至少保存requestId或receiptId");
  if (!(attempt.completedAt === null || isoDateTime(attempt.completedAt))) push(errors, `${path}.completedAt`, "必须是有效时间或null");
  if (!(attempt.resultCount === null || (Number.isInteger(attempt.resultCount) && attempt.resultCount >= 0))) push(errors, `${path}.resultCount`, "必须是非负整数或null");
  if (!(attempt.failureClass === null || KEYWORD_FAILURE_CLASSES.includes(attempt.failureClass))) push(errors, `${path}.failureClass`, "失败分类无效");

  if (attempt.failureClass === "true_empty") {
    if (attempt.status !== "completed" || !isoDateTime(attempt.completedAt) || attempt.resultCount !== 0) {
      push(errors, path, "true_empty必须有查询完成时间且resultCount严格为0");
    }
  } else if (attempt.resultCount === 0) {
    push(errors, path, "resultCount为0时必须明确分类为true_empty");
  }
  if (TECHNICAL_FAILURES.has(attempt.failureClass)) {
    if (attempt.status !== "failed" || attempt.resultCount !== null) push(errors, path, "技术失败必须status=failed且resultCount=null");
  }
  if (attempt.failureClass === "stale_result" && attempt.resultCount !== null) push(errors, path, "过期结果不得继续携带可用结果数");
  if (["selector_changed", "input_not_committed"].includes(attempt.failureClass) && attempt.channel !== "browser") {
    push(errors, path, "selector_changed和input_not_committed只属于browser路径");
  }
  if (attempt.status === "completed" && attempt.failureClass === null && !(Number.isInteger(attempt.resultCount) && attempt.resultCount > 0)) {
    push(errors, path, "正常完成必须有大于0的结果数");
  }
  if (attempt.channel === "local_fusion" && (
    attempt.status !== "completed" ||
    !isoDateTime(attempt.completedAt) ||
    !(Number.isInteger(attempt.resultCount) && attempt.resultCount > 0) ||
    attempt.failureClass !== null
  )) {
    push(errors, path, "local_fusion只允许completed、正resultCount且failureClass=null");
  }
}

export function validateKeywordSourceAttempt(attempt) {
  const errors = [];
  validateAttempt(attempt, 0, errors);
  return { valid: errors.length === 0, errors };
}

function validateKeyword(keyword, path, errors) {
  if (!isObject(keyword)) return push(errors, path, "必须是对象");
  if (!nonEmpty(keyword.keyword)) push(errors, `${path}.keyword`, "必须是非空关键词");
  for (const field of ["sourceRefs", "factRefs"]) {
    if (!Array.isArray(keyword[field]) || keyword[field].length === 0 || keyword[field].some((item) => !nonEmpty(item))) {
      push(errors, `${path}.${field}`, "必须保留至少一个可追溯引用");
    }
  }
  if (!finiteOrNull(keyword.score)) push(errors, `${path}.score`, "必须是数字或null");
  if (!(keyword.scoringVersion === null || nonEmpty(keyword.scoringVersion))) push(errors, `${path}.scoringVersion`, "必须是非空字符串或null");
  if (!(keyword.confidence === null || (Number.isFinite(keyword.confidence) && keyword.confidence >= 0 && keyword.confidence <= 1))) {
    push(errors, `${path}.confidence`, "必须是0到1或null");
  }
  if (!(keyword.decision === null || ["adopted", "rejected", "needs_review"].includes(keyword.decision))) push(errors, `${path}.decision`, "采用状态无效");
  if (!(keyword.decisionReason === null || nonEmpty(keyword.decisionReason))) push(errors, `${path}.decisionReason`, "必须是非空字符串或null");
  if (keyword.decision !== null && !nonEmpty(keyword.decisionReason)) push(errors, `${path}.decisionReason`, "有采用决定时必须说明原因");
  const hasK3 = ["matchType", "evidenceCoverage", "usageRestriction", "placementGateEvidence", "components"].some((field) => Object.hasOwn(keyword, field));
  if (hasK3) {
    if (!["target_fact", "exact_match", "substitute", "multi_seed"].includes(keyword.matchType)) push(errors, `${path}.matchType`, "K3语义类型无效");
    if (!Number.isFinite(keyword.evidenceCoverage) || keyword.evidenceCoverage < 0 || keyword.evidenceCoverage > 1) push(errors, `${path}.evidenceCoverage`, "K3证据覆盖率无效");
    if (!(keyword.usageRestriction === null || keyword.usageRestriction === "description_only")) push(errors, `${path}.usageRestriction`, "K3使用限制无效");
    if (!(keyword.placementGateEvidence === null || (isObject(keyword.placementGateEvidence) && keyword.placementGateEvidence.approved === true && nonEmpty(keyword.placementGateEvidence.evidenceRef) && nonEmpty(keyword.placementGateEvidence.reason)))) push(errors, `${path}.placementGateEvidence`, "K3描述门禁证据无效");
    const names = ["semanticMatch", "searchDemand", "addToCartConversion", "competitorConsensus", "titleDensity", "competitorCount", "searchGrowth", "returnCancelHealth", "sourceTrust"];
    if (!isObject(keyword.components) || Object.keys(keyword.components).length !== names.length || names.some((name) => !Object.hasOwn(keyword.components, name))) {
      push(errors, `${path}.components`, "K3九个评分组件必须完整");
    }
  }
}

export function validateKeywordEvidenceSnapshot(snapshot, { currentBinding, asOf } = {}) {
  const errors = [];
  if (!isObject(snapshot)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (snapshot.schemaVersion !== KEYWORD_EVIDENCE_SNAPSHOT_VERSION) push(errors, "schemaVersion", "版本无效");
  if (!nonEmpty(snapshot.snapshotId)) push(errors, "snapshotId", "必须是非空字符串");
  if (!KEYWORD_PREPARATION_STATUSES.includes(snapshot.status)) push(errors, "status", "准备状态无效");
  const identity = snapshot.identity;
  if (!isObject(identity)) push(errors, "identity", "必须是对象");
  else {
    for (const field of ["candidateId", "parentOpportunityId", "skuPackageId"]) if (!nonEmpty(identity[field])) push(errors, `identity.${field}`, "必须是非空字符串");
    if (!Number.isInteger(identity.dataRevision) || identity.dataRevision < 0) push(errors, "identity.dataRevision", "必须是非负整数");
  }
  const bindings = snapshot.bindings;
  for (const [name, idField] of [["salesSnapshot", "snapshotId"], ["supplySkuFacts", "version"]]) {
    const binding = bindings?.[name];
    if (!isObject(binding)) push(errors, `bindings.${name}`, "必须是对象");
    else {
      if (!nonEmpty(binding[idField])) push(errors, `bindings.${name}.${idField}`, "必须是非空字符串");
      if (!nonEmpty(binding.version) || !nonEmpty(binding.fingerprint)) push(errors, `bindings.${name}`, "必须锁定版本与指纹");
    }
  }
  if (!isObject(snapshot.validity) || !isoDateTime(snapshot.validity.collectedAt) || !isoDateTime(snapshot.validity.expiresAt)) {
    push(errors, "validity", "必须保存有效采集时间和失效时间");
  } else if (Date.parse(snapshot.validity.expiresAt) <= Date.parse(snapshot.validity.collectedAt)) {
    push(errors, "validity.expiresAt", "必须晚于采集时间");
  }
  if (!Array.isArray(snapshot.sourceAttempts) || snapshot.sourceAttempts.length === 0) push(errors, "sourceAttempts", "必须至少有一次来源尝试");
  else snapshot.sourceAttempts.forEach((attempt, index) => validateAttempt(attempt, index, errors));
  for (const group of KEYWORD_GROUPS) {
    if (!Array.isArray(snapshot.groups?.[group])) push(errors, `groups.${group}`, "必须是数组");
    else snapshot.groups[group].forEach((keyword, index) => validateKeyword(keyword, `groups.${group}[${index}]`, errors));
  }
  if (!isObject(snapshot.businessEffect) || snapshot.businessEffect.businessPhaseChanged !== false || snapshot.businessEffect.businessResultChanged !== false ||
      snapshot.businessEffect.bOrC1Created !== false || snapshot.businessEffect.dispatchesCreated !== 0) {
    push(errors, "businessEffect", "K1不得改变业务结论、创建B/C1或派发");
  }
  if (snapshot.scoringContext !== undefined) {
    if (!isObject(snapshot.scoringContext) || !nonEmpty(snapshot.scoringContext.scoringVersion) || !nonEmpty(snapshot.scoringContext.preparationFingerprint) ||
        !nonEmpty(snapshot.scoringContext.metricEvidenceFingerprint) || !isObject(snapshot.scoringContext.execution) ||
        snapshot.scoringContext.execution.networkCalls !== 0 || snapshot.scoringContext.execution.modelCalls !== 0 ||
        snapshot.scoringContext.execution.codexDispatches !== 0 || snapshot.scoringContext.execution.bOrC1Created !== false || snapshot.scoringContext.execution.sharedWrites !== 0) {
      push(errors, "scoringContext", "K3评分上下文绑定或零副作用字段无效");
    }
    if (keywordScoringGroupLimits(snapshot.scoringContext?.scoringVersion) === null) {
      push(errors, "scoringContext.scoringVersion", "评分版本无效");
    }
  }
  const keywords = KEYWORD_GROUPS.flatMap((group) => snapshot.groups?.[group] || []);
  const attempts = Array.isArray(snapshot.sourceAttempts) ? snapshot.sourceAttempts : [];
  const hasTrueEmpty = attempts.some((item) => item.failureClass === "true_empty");
  const hasPositiveCompletedResult = attempts.some((item) => item.status === "completed" && item.failureClass === null && Number.isInteger(item.resultCount) && item.resultCount > 0);
  if (snapshot.status === "true_empty" && (keywords.length !== 0 || !hasTrueEmpty || hasPositiveCompletedResult)) {
    push(errors, "status", "总体true_empty要求零关键词、至少一条可追溯零结果证据且不存在成功正结果");
  }
  if (snapshot.status === "technical_unavailable" && (keywords.length !== 0 || !attempts.some((item) => TECHNICAL_FAILURES.has(item.failureClass)))) {
    push(errors, "status", "technical_unavailable要求零关键词且存在明确技术失败");
  }
  const requiredGroupsPresent = hasRequiredGroups(snapshot.groups, snapshot.scoringContext?.scoringVersion);
  if (snapshot.status === "ready" && !requiredGroupsPresent) push(errors, "status", "ready要求满足当前评分版本的必要分组");
  if (snapshot.status === "partial_ready" && !(keywords.length > 0 && !requiredGroupsPresent)) push(errors, "status", "partial_ready要求已有结果但尚未满足当前评分版本的必要分组");
  if (snapshot.status === "stale" && !attempts.some((item) => item.failureClass === "stale_result") && !(asOf && isoDateTime(snapshot.validity?.expiresAt) && Date.parse(snapshot.validity.expiresAt) <= Date.parse(asOf))) {
    push(errors, "status", "stale必须由过期尝试或有效期证明");
  }
  if (currentBinding) {
    const pairs = [
      ["candidateId", identity?.candidateId, currentBinding.candidateId],
      ["parentOpportunityId", identity?.parentOpportunityId, currentBinding.parentOpportunityId],
      ["skuPackageId", identity?.skuPackageId, currentBinding.skuPackageId],
      ["dataRevision", identity?.dataRevision, currentBinding.dataRevision],
      ["salesSnapshotVersion", bindings?.salesSnapshot?.version, currentBinding.salesSnapshotVersion],
      ["salesSnapshotFingerprint", bindings?.salesSnapshot?.fingerprint, currentBinding.salesSnapshotFingerprint],
      ["supplySkuFactsVersion", bindings?.supplySkuFacts?.version, currentBinding.supplySkuFactsVersion],
      ["supplySkuFactsFingerprint", bindings?.supplySkuFacts?.fingerprint, currentBinding.supplySkuFactsFingerprint]
    ];
    for (const [path, actual, expected] of pairs) if (actual !== expected) push(errors, `binding.${path}`, "当前SKU、revision或冻结快照不匹配");
  }
  if (!nonEmpty(snapshot.snapshotFingerprint) || snapshot.snapshotFingerprint !== fingerprint(withoutFingerprint(snapshot))) {
    push(errors, "snapshotFingerprint", "快照指纹缺失或内容已漂移");
  }
  return { valid: errors.length === 0, errors };
}

function deriveStatus({ groups, attempts, expiresAt, asOf, needsReview, scoringVersion }) {
  if (Date.parse(expiresAt) <= Date.parse(asOf) || attempts.some((item) => item.failureClass === "stale_result")) return "stale";
  if (needsReview === true) return "needs_review";
  const keywords = KEYWORD_GROUPS.flatMap((group) => groups[group]);
  const hasPositiveCompletedResult = attempts.some((item) => item.status === "completed" && item.failureClass === null && Number.isInteger(item.resultCount) && item.resultCount > 0);
  if (keywords.length === 0 && hasPositiveCompletedResult) return "needs_review";
  if (keywords.length === 0 && attempts.some((item) => item.failureClass === "true_empty")) return "true_empty";
  if (keywords.length === 0 && attempts.some((item) => TECHNICAL_FAILURES.has(item.failureClass))) return "technical_unavailable";
  if (hasRequiredGroups(groups, scoringVersion)) return "ready";
  if (keywords.length > 0) return "partial_ready";
  return "needs_review";
}

export function createKeywordEvidenceSnapshot(input) {
  if (!isObject(input)) throw new TypeError("KEYWORD_EVIDENCE_INPUT_INVALID");
  const groups = Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, structuredClone(input.groups?.[group] ?? [])]));
  const sourceAttempts = structuredClone(input.sourceAttempts || []);
  const status = input.statusOverride ?? deriveStatus({ groups, attempts: sourceAttempts, expiresAt: input.expiresAt, asOf: input.asOf, needsReview: input.needsReview, scoringVersion: input.scoringContext?.scoringVersion });
  const snapshot = {
    schemaVersion: KEYWORD_EVIDENCE_SNAPSHOT_VERSION,
    snapshotId: input.snapshotId,
    snapshotFingerprint: null,
    status,
    identity: structuredClone(input.identity),
    bindings: structuredClone(input.bindings),
    validity: { collectedAt: input.collectedAt, expiresAt: input.expiresAt },
    sourceAttempts,
    groups,
    ...(input.scoringContext === undefined ? {} : { scoringContext: structuredClone(input.scoringContext) }),
    businessEffect: {
      businessPhaseChanged: false,
      businessResultChanged: false,
      bOrC1Created: false,
      dispatchesCreated: 0
    }
  };
  snapshot.snapshotFingerprint = fingerprint(withoutFingerprint(snapshot));
  const validation = validateKeywordEvidenceSnapshot(snapshot, { currentBinding: input.currentBinding, asOf: input.asOf });
  if (!validation.valid) throw new Error(`KEYWORD_EVIDENCE_INVALID: ${validation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return deepFreeze(snapshot);
}

export function readLegacyKeywordEvidenceReadOnly(value) {
  if (isObject(value) && value.schemaVersion === KEYWORD_EVIDENCE_SNAPSHOT_VERSION) return deepFreeze(structuredClone(value));
  return deepFreeze({
    schemaVersion: "legacy-keyword-evidence-readonly",
    legacyReadOnly: true,
    original: structuredClone(value ?? null),
    snapshotId: "unknown",
    snapshotFingerprint: "unknown",
    status: "needs_review",
    identity: { candidateId: "unknown", parentOpportunityId: "unknown", skuPackageId: "unknown", dataRevision: null },
    bindings: {
      salesSnapshot: { snapshotId: "unknown", version: "unknown", fingerprint: "unknown" },
      supplySkuFacts: { version: "unknown", fingerprint: "unknown" }
    },
    validity: { collectedAt: null, expiresAt: null },
    sourceAttempts: [],
    groups: Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []])),
    businessEffect: {
      businessPhaseChanged: false,
      businessResultChanged: false,
      bOrC1Created: false,
      dispatchesCreated: 0
    }
  });
}
