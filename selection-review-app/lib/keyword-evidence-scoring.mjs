import { createHash } from "node:crypto";
import { createKeywordEvidenceSnapshot, validateKeywordEvidenceSnapshot, keywordScoringGroupLimits } from "./keyword-evidence-snapshot.mjs";
import { validateKeywordEvidencePreparation } from "./keyword-evidence-orchestrator.mjs";

export const KEYWORD_SCORING_VERSION = "keyword-scoring-v2";
export const KEYWORD_SCORING_COMPONENTS = Object.freeze({
  semanticMatch: 35,
  searchDemand: 10,
  addToCartConversion: 10,
  competitorConsensus: 12,
  titleDensity: 7,
  competitorCount: 7,
  searchGrowth: 7,
  returnCancelHealth: 5,
  sourceTrust: 7
});

// Current policy requires one fact-supported title term; other groups are optional.
// Version 1 remains readable with its original 3/6/10 minima.
export const KEYWORD_GROUP_LIMITS_POLICY = Object.freeze({
  version: KEYWORD_SCORING_VERSION,
  decidedBy: "owner",
  decidedOn: "2026-09-18"
});
const GROUP_LIMITS = keywordScoringGroupLimits(KEYWORD_SCORING_VERSION);
const DYNAMIC_COMPONENTS = new Set(["searchDemand", "addToCartConversion", "titleDensity", "searchGrowth", "returnCancelHealth"]);

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0 && value !== "unknown"; }
function iso(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

function binding(preparation) {
  return {
    candidateId: preparation.identity.candidateId,
    parentOpportunityId: preparation.identity.parentOpportunityId,
    skuPackageId: preparation.identity.skuPackageId,
    dataRevision: preparation.identity.dataRevision,
    salesSnapshotVersion: preparation.bindings.salesSnapshot.version,
    salesSnapshotFingerprint: preparation.bindings.salesSnapshot.fingerprint,
    supplySkuFactsVersion: preparation.bindings.supplySkuFacts.version,
    supplySkuFactsFingerprint: preparation.bindings.supplySkuFacts.fingerprint
  };
}

/**
 * 指标证据按这个键对上候选词。**导出是为了让提供方复用同一份定义**——
 * 键格式在两处各写一遍，早晚会漂，漂了就报 KEYWORD_SCORING_METRIC_KEY_OUT_OF_SCOPE，
 * 而那句话读不出真正的原因。行为没有任何变化，只是把已有函数暴露出去。
 */
export function keywordMetricKey(candidate) { return `${candidate.term.toLocaleLowerCase()}\u0000${candidate.matchType}`; }
const metricKey = keywordMetricKey;
function normalizedKeyword(value) { return value.trim().toLocaleLowerCase().replace(/\s+/g, " "); }

function validStructuredRaw(raw) {
  if (!isObject(raw) || Object.keys(raw).length === 0) return false;
  try {
    const serialized = JSON.stringify(raw);
    return nonEmpty(serialized) && serialized !== "{}" && isObject(JSON.parse(serialized));
  } catch { return false; }
}

function normalizeComponent(name, component) {
  if (component === undefined || component === null) return {
    value: null, rawValue: null, raw: null, normalizationRule: null, conversionRule: null,
    evidenceRef: null, observedAt: null, period: null
  };
  if (!isObject(component)) throw new Error(`KEYWORD_SCORING_COMPONENT_INVALID:${name}`);
  const value = component.value;
  if (!(value === null || (Number.isFinite(value) && value >= 0 && value <= 100))) throw new Error(`KEYWORD_SCORING_COMPONENT_INVALID:${name}:value`);
  if (value !== null && (!nonEmpty(component.evidenceRef) || !iso(component.observedAt) ||
      (!Number.isFinite(component.rawValue) && !validStructuredRaw(component.raw)) ||
      !(nonEmpty(component.normalizationRule) || nonEmpty(component.conversionRule)) ||
      (DYNAMIC_COMPONENTS.has(name) && !nonEmpty(component.period)))) {
    throw new Error(`KEYWORD_SCORING_COMPONENT_UNTRACEABLE:${name}`);
  }
  if (name === "returnCancelHealth" && value !== null) {
    const raw = component.raw;
    const expected = Number((100 - (raw?.returnRate + raw?.cancelRate) * 100).toFixed(4));
    if (!isObject(raw) || !Number.isFinite(raw.returnRate) || raw.returnRate < 0 || raw.returnRate > 1 ||
        !Number.isFinite(raw.cancelRate) || raw.cancelRate < 0 || raw.cancelRate > 1 ||
        !nonEmpty(component.conversionRule) || component.conversionRule !== "round4(100-(returnRate+cancelRate)*100)" ||
        expected < 0 || expected > 100 || value !== expected) {
      throw new Error("KEYWORD_RETURN_CANCEL_DIRECTION_INVALID");
    }
  }
  return {
    value,
    rawValue: value === null || !Number.isFinite(component.rawValue) ? null : component.rawValue,
    raw: value === null ? null : (validStructuredRaw(component.raw) ? structuredClone(component.raw) : null),
    normalizationRule: value === null ? null : (component.normalizationRule ?? null),
    conversionRule: value === null ? null : (component.conversionRule ?? null),
    evidenceRef: value === null ? null : component.evidenceRef,
    observedAt: value === null ? null : component.observedAt,
    period: value === null ? null : (component.period ?? null),
  };
}

function scoreCandidate(candidate, metricEvidence) {
  const components = {};
  let weighted = 0;
  let availableWeight = 0;
  for (const [name, weight] of Object.entries(KEYWORD_SCORING_COMPONENTS)) {
    const exactOnly = ["competitorConsensus", "competitorCount"].includes(name) && candidate.matchType !== "exact_match";
    if (exactOnly && metricEvidence?.components?.[name]?.value !== null && metricEvidence?.components?.[name]?.value !== undefined) {
      throw new Error(`KEYWORD_NON_EXACT_CONSENSUS_FORBIDDEN:${name}`);
    }
    const component = normalizeComponent(name, exactOnly ? null : metricEvidence?.components?.[name]);
    components[name] = component;
    if (component.value !== null) {
      weighted += component.value * weight;
      availableWeight += weight;
    }
  }
  const compositeScore = availableWeight === 0 ? null : Number((weighted / availableWeight).toFixed(4));
  const evidenceCoverage = availableWeight / 100;
  const confidence = compositeScore === null ? 0 : Number(evidenceCoverage.toFixed(4));
  const semantic = components.semanticMatch.value;
  let eligibility = "rejected";
  let reason = "semantic_match_missing";
  let usageRestriction = null;
  let placementGateEvidence = null;
  if (semantic !== null && semantic >= 80 && candidate.factRefs.length > 0) {
    eligibility = "title_or_tag";
    reason = "semantic_and_fact_gate_passed";
  } else if (semantic !== null && semantic >= 70 && semantic < 80 && candidate.factRefs.length > 0 &&
      metricEvidence?.descriptionGate?.approved === true && nonEmpty(metricEvidence.descriptionGate.evidenceRef) && nonEmpty(metricEvidence.descriptionGate.reason)) {
    eligibility = "description_only";
    reason = "semantic_70_79_description_gate_passed";
    usageRestriction = "description_only";
    placementGateEvidence = structuredClone(metricEvidence.descriptionGate);
  } else if (semantic !== null && semantic >= 70 && semantic < 80) reason = "description_gate_missing_or_untraceable";
  else if (semantic !== null && semantic < 70) reason = "semantic_below_70";
  else if (candidate.factRefs.length === 0) reason = "fact_refs_missing";
  return { candidate, components, compositeScore, evidenceCoverage, confidence, eligibility, reason, usageRestriction, placementGateEvidence };
}

function sourceTrustValue(item) { return item.components.sourceTrust.value ?? -1; }
function consensusValue(item) {
  return item.candidate.matchType === "exact_match" ? (item.components.competitorConsensus.value ?? -1) : -1;
}
function ranked(a, b) {
  return (b.compositeScore ?? -1) - (a.compositeScore ?? -1) ||
    b.confidence - a.confidence || consensusValue(b) - consensusValue(a) || sourceTrustValue(b) - sourceTrustValue(a) ||
    a.candidate.term.localeCompare(b.candidate.term);
}

function record(item, decision, decisionReason) {
  return {
    keyword: item.candidate.term,
    sourceRefs: structuredClone(item.candidate.sourceRefs),
    factRefs: structuredClone(item.candidate.factRefs),
    score: item.compositeScore,
    scoringVersion: KEYWORD_SCORING_VERSION,
    confidence: item.confidence,
    decision,
    decisionReason,
    matchType: item.candidate.matchType,
    evidenceCoverage: item.evidenceCoverage,
    usageRestriction: item.usageRestriction,
    placementGateEvidence: item.placementGateEvidence,
    components: structuredClone(item.components)
  };
}

export function scoreAndGroupKeywordEvidence({ preparation, metricEvidence, collectedAt, expiresAt, currentBinding }) {
  const validation = validateKeywordEvidencePreparation(preparation, { currentBinding });
  if (!validation.valid) throw new Error(`KEYWORD_SCORING_PREPARATION_INVALID:${validation.errors.join(";")}`);
  if (preparation.result !== "source_candidates_ready") throw new Error("KEYWORD_SCORING_CANDIDATES_NOT_READY");
  if (!isObject(metricEvidence) || metricEvidence.version !== "keyword-metrics-v1" || !Array.isArray(metricEvidence.candidates)) throw new Error("KEYWORD_SCORING_METRICS_INVALID");
  if (metricEvidence.preparationFingerprint !== preparation.preparationFingerprint) throw new Error("KEYWORD_SCORING_PREPARATION_FINGERPRINT_DRIFT");
  if (!iso(collectedAt) || !iso(expiresAt) || Date.parse(expiresAt) <= Date.parse(collectedAt)) throw new Error("KEYWORD_SCORING_VALIDITY_INVALID");
  const allowedKeys = new Set(preparation.rawCandidatePool.map(metricKey));
  const metrics = new Map();
  for (const item of metricEvidence.candidates) {
    if (!isObject(item) || !nonEmpty(item.key) || !allowedKeys.has(item.key)) throw new Error("KEYWORD_SCORING_METRIC_KEY_OUT_OF_SCOPE");
    if (metrics.has(item.key)) throw new Error("KEYWORD_SCORING_METRIC_KEY_DUPLICATE");
    metrics.set(item.key, item);
  }
  const scored = preparation.rawCandidatePool.map((candidate) => scoreCandidate(candidate, metrics.get(metricKey(candidate))));
  const duplicateRejected = [];
  const uniqueScored = [];
  const seenTerms = new Set();
  for (const item of [...scored].sort(ranked)) {
    const key = normalizedKeyword(item.candidate.term);
    if (seenTerms.has(key)) {
      duplicateRejected.push({ ...item, duplicateReason: "duplicate_term" });
    } else {
      seenTerms.add(key);
      uniqueScored.push(item);
    }
  }
  const high = uniqueScored.filter((item) => item.eligibility === "title_or_tag").sort(ranked);
  const descriptionOnly = uniqueScored.filter((item) => item.eligibility === "description_only").sort(ranked);
  const title = high.splice(0, GROUP_LIMITS.title_keywords.min);
  const tags = high.splice(0, GROUP_LIMITS.attribute_and_tag_keywords.min);
  const description = descriptionOnly.splice(0, GROUP_LIMITS.description_long_tail.min);
  description.push(...high.splice(0, GROUP_LIMITS.description_long_tail.min - description.length));
  title.push(...high.splice(0, GROUP_LIMITS.title_keywords.max - title.length));
  tags.push(...high.splice(0, GROUP_LIMITS.attribute_and_tag_keywords.max - tags.length));
  description.push(...descriptionOnly.splice(0, GROUP_LIMITS.description_long_tail.max - description.length));
  description.push(...high.splice(0, GROUP_LIMITS.description_long_tail.max - description.length));
  const selected = new Set([...title, ...tags, ...description]);
  const rejected = [...uniqueScored.filter((item) => !selected.has(item)), ...duplicateRejected].map((item) => ({
    keyword: item.candidate.term,
    matchType: item.candidate.matchType,
    sourceRefs: structuredClone(item.candidate.sourceRefs),
    factRefs: structuredClone(item.candidate.factRefs),
    reason: item.duplicateReason ?? (item.eligibility === "rejected" ? item.reason : "group_capacity_or_cross_group_dedup"),
    score: item.compositeScore,
    confidence: item.confidence
  }));
  const groups = {
    title_keywords: title.map((item) => record(item, "adopted", "title_ranked_selection")),
    attribute_and_tag_keywords: tags.map((item) => record(item, "adopted", "tag_ranked_selection")),
    description_long_tail: description.map((item) => record(item, "adopted", item.usageRestriction === "description_only" ? "description_only_semantic_gate" : "description_ranked_selection"))
  };
  const gaps = Object.entries(GROUP_LIMITS).filter(([group, limit]) => groups[group].length < limit.min)
    .map(([group, limit]) => ({ group, requiredMin: limit.min, actual: groups[group].length, missing: limit.min - groups[group].length }));
  const selectedCount = Object.values(groups).reduce((sum, items) => sum + items.length, 0);
  const statusOverride = gaps.length === 0 ? "ready" : selectedCount === 0 ? "needs_review" : Object.values(groups).some((items) => items.length === 0) ? "partial_ready" : "needs_review";
  const scoringContext = {
    scoringVersion: KEYWORD_SCORING_VERSION,
    preparationId: preparation.preparationId,
    preparationFingerprint: preparation.preparationFingerprint,
    pointsBefore: preparation.pointsBefore,
    pointsAfter: preparation.pointsAfter,
    pointsSpent: preparation.pointsSpent,
    coverage: preparation.coverage,
    groupLimits: GROUP_LIMITS,
    gaps,
    rejected,
    metricEvidenceVersion: metricEvidence.version,
    metricEvidenceFingerprint: digest(metricEvidence),
    execution: { networkCalls: 0, modelCalls: 0, codexDispatches: 0, bOrC1Created: false, sharedWrites: 0 }
  };
  scoringContext.scoringPayloadFingerprint = digest({ groups, rejected, gaps, preparationFingerprint: preparation.preparationFingerprint, metricEvidenceFingerprint: scoringContext.metricEvidenceFingerprint });
  const snapshot = createKeywordEvidenceSnapshot({
    snapshotId: `keyword-evidence:${preparation.identity.candidateId}:${preparation.identity.dataRevision}:${digest({ scoringVersion: KEYWORD_SCORING_VERSION, preparation: preparation.preparationFingerprint, metrics: scoringContext.metricEvidenceFingerprint }).slice(0, 16)}`,
    identity: preparation.identity,
    bindings: preparation.bindings,
    currentBinding: currentBinding ?? binding(preparation),
    collectedAt,
    expiresAt,
    asOf: collectedAt,
    sourceAttempts: preparation.sourceAttempts,
    groups,
    statusOverride,
    scoringContext
  });
  const snapshotValidation = validateKeywordScoredSnapshot(snapshot, {
    currentBinding: currentBinding ?? binding(preparation),
    expectedPreparationFingerprint: preparation.preparationFingerprint,
    expectedMetricEvidenceFingerprint: scoringContext.metricEvidenceFingerprint,
    asOf: collectedAt
  });
  if (!snapshotValidation.valid) throw new Error(`KEYWORD_SCORING_SNAPSHOT_INVALID:${snapshotValidation.errors.join(";")}`);
  return snapshot;
}

export function validateKeywordScoredSnapshot(snapshot, { currentBinding, expectedPreparationFingerprint, expectedMetricEvidenceFingerprint, asOf } = {}) {
  const errors = [];
  const base = validateKeywordEvidenceSnapshot(snapshot, { currentBinding, asOf });
  if (!base.valid) errors.push(...base.errors.map((item) => `${item.path}:${item.message}`));
  const context = snapshot?.scoringContext;
  const groupLimits = keywordScoringGroupLimits(context?.scoringVersion);
  if (!isObject(context) || groupLimits === null) return { valid: false, errors: [...errors, "scoringContext无效"] };
  if (JSON.stringify(stable(context.groupLimits)) !== JSON.stringify(stable(groupLimits))) errors.push("groupLimits与评分版本不一致");
  if (expectedPreparationFingerprint && context?.preparationFingerprint !== expectedPreparationFingerprint) errors.push("Preparation指纹漂移");
  if (expectedMetricEvidenceFingerprint && context?.metricEvidenceFingerprint !== expectedMetricEvidenceFingerprint) errors.push("metrics指纹漂移");
  const execution = context?.execution;
  if (execution?.networkCalls !== 0 || execution?.modelCalls !== 0 || execution?.codexDispatches !== 0 || execution?.bOrC1Created !== false || execution?.sharedWrites !== 0) errors.push("K3执行副作用无效");
  const all = Object.values(snapshot?.groups ?? {}).flat();
  const terms = all.map((item) => normalizedKeyword(item.keyword));
  if (new Set(terms).size !== terms.length) errors.push("跨组关键词重复");
  for (const [group, limit] of Object.entries(groupLimits)) {
    const count = snapshot?.groups?.[group]?.length ?? -1;
    if (count < 0 || count > limit.max) errors.push(`${group}数量越界`);
  }
  for (const item of all) {
    if (!Object.keys(KEYWORD_SCORING_COMPONENTS).every((name) => Object.hasOwn(item.components ?? {}, name)) || Object.keys(item.components ?? {}).length !== 9) errors.push(`${item.keyword}:九组件不完整`);
    if (!Number.isFinite(item.evidenceCoverage) || item.evidenceCoverage < 0 || item.evidenceCoverage > 1 || item.scoringVersion !== context.scoringVersion ||
        !["target_fact", "exact_match", "substitute", "multi_seed"].includes(item.matchType)) errors.push(`${item.keyword}:K3扩展字段无效`);
    for (const [name, component] of Object.entries(item.components ?? {})) {
      try { normalizeComponent(name, component); } catch { errors.push(`${item.keyword}:${name}组件无效`); }
    }
    const semantic = item.components?.semanticMatch?.value;
    const inTitleOrTag = ["title_keywords", "attribute_and_tag_keywords"].some((group) => snapshot.groups[group]?.includes(item));
    const inDescription = snapshot.groups.description_long_tail?.includes(item);
    if (!Array.isArray(item.factRefs) || item.factRefs.length === 0) errors.push(`${item.keyword}:采用词事实引用缺失`);
    if (inTitleOrTag && (!(semantic >= 80) || item.usageRestriction === "description_only" || item.placementGateEvidence !== null)) errors.push(`${item.keyword}:标题标签语义门禁失败`);
    if (item.usageRestriction === "description_only") {
      const gate = item.placementGateEvidence;
      if (!inDescription || !(semantic >= 70 && semantic < 80) || !isObject(gate) || gate.approved !== true || !nonEmpty(gate.evidenceRef) || !nonEmpty(gate.reason)) errors.push(`${item.keyword}:描述限定门禁无效`);
    } else if (item.placementGateEvidence !== null) errors.push(`${item.keyword}:非描述限定词携带门禁证据`);
    if (inDescription && semantic < 70) errors.push(`${item.keyword}:描述语义门禁失败`);
  }
  for (const rejected of context?.rejected ?? []) {
    if (!nonEmpty(rejected.keyword) || !["target_fact", "exact_match", "substitute", "multi_seed"].includes(rejected.matchType) ||
        !Array.isArray(rejected.sourceRefs) || !Array.isArray(rejected.factRefs) || !nonEmpty(rejected.reason) ||
        !(rejected.score === null || Number.isFinite(rejected.score)) || !Number.isFinite(rejected.confidence)) errors.push("rejected记录不完整");
  }
  const computedGaps = Object.entries(groupLimits).filter(([group, limit]) => snapshot.groups?.[group]?.length < limit.min)
    .map(([group, limit]) => ({ group, requiredMin: limit.min, actual: snapshot.groups[group].length, missing: limit.min - snapshot.groups[group].length }));
  if (JSON.stringify(context?.gaps) !== JSON.stringify(computedGaps)) errors.push("gaps与分组状态不一致");
  const selectedCount = Object.values(snapshot.groups ?? {}).reduce((sum, items) => sum + items.length, 0);
  const expectedStatus = computedGaps.length === 0 ? "ready" : selectedCount === 0 ? "needs_review" : Object.values(snapshot.groups ?? {}).some((items) => items.length === 0) ? "partial_ready" : "needs_review";
  if (snapshot.status !== expectedStatus) errors.push("snapshot状态与group minima不一致");
  const expectedPayload = digest({ groups: snapshot.groups, rejected: context?.rejected, gaps: context?.gaps, preparationFingerprint: context?.preparationFingerprint, metricEvidenceFingerprint: context?.metricEvidenceFingerprint });
  if (context?.scoringPayloadFingerprint !== expectedPayload) errors.push("K3评分载荷指纹漂移");
  return { valid: errors.length === 0, errors };
}
