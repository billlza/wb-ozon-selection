import { createHash } from "node:crypto";
import {
  KEYWORD_FAILURE_CLASSES,
  validateKeywordEvidenceSnapshot,
  validateKeywordSourceAttempt
} from "./keyword-evidence-snapshot.mjs";

export const KEYWORD_EVIDENCE_PREPARATION_VERSION = "keyword-evidence-preparation-v1";
export const KEYWORD_SOURCE_PREPARATION_VERSION = "keyword-source-preparation-v1";
export const KEYWORD_PREPARATION_RESULTS = Object.freeze([
  "reused_snapshot",
  "source_candidates_ready",
  "true_empty",
  "technical_unavailable",
  "needs_review"
]);

const TECHNICAL_FAILURES = new Set(KEYWORD_FAILURE_CLASSES.filter((item) => !["true_empty", "stale_result"].includes(item)));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
}

function isoDateTime(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function bindingFromInput(input) {
  return {
    candidateId: input.identity.candidateId,
    parentOpportunityId: input.identity.parentOpportunityId,
    skuPackageId: input.identity.skuPackageId,
    dataRevision: input.identity.dataRevision,
    salesSnapshotVersion: input.bindings.salesSnapshot.version,
    salesSnapshotFingerprint: input.bindings.salesSnapshot.fingerprint,
    supplySkuFactsVersion: input.bindings.supplySkuFacts.version,
    supplySkuFactsFingerprint: input.bindings.supplySkuFacts.fingerprint
  };
}

function validateInput(input) {
  if (!isObject(input)) throw new Error("KEYWORD_PREPARATION_INPUT_INVALID");
  for (const field of ["candidateId", "parentOpportunityId", "skuPackageId"]) {
    if (!nonEmpty(input.identity?.[field])) throw new Error(`KEYWORD_PREPARATION_IDENTITY_INVALID:${field}`);
  }
  if (!Number.isInteger(input.identity?.dataRevision) || input.identity.dataRevision < 0) throw new Error("KEYWORD_PREPARATION_REVISION_INVALID");
  for (const [name, idField] of [["salesSnapshot", "snapshotId"], ["supplySkuFacts", "version"]]) {
    const binding = input.bindings?.[name];
    if (!isObject(binding) || !nonEmpty(binding[idField]) || !nonEmpty(binding.version) || !nonEmpty(binding.fingerprint)) {
      throw new Error(`KEYWORD_PREPARATION_BINDING_INVALID:${name}`);
    }
  }
  for (const field of ["platform", "exactSku", "fulfillment"]) if (!nonEmpty(input[field])) throw new Error(`KEYWORD_PREPARATION_SCOPE_INVALID:${field}`);
  if (input.businessGate?.approved !== true || !nonEmpty(input.businessGate?.approvedAt) || !isoDateTime(input.businessGate.approvedAt) ||
      !nonEmpty(input.businessGate?.note) || !nonEmpty(input.businessGate?.evidenceRef)) {
    throw new Error("KEYWORD_PREPARATION_BUSINESS_GATE_NOT_APPROVED");
  }
  if (!isoDateTime(input.now)) throw new Error("KEYWORD_PREPARATION_TIME_INVALID");
  if (!Array.isArray(input.frozenEvidence?.productFactTerms) || !Array.isArray(input.frozenEvidence?.comparables) || !Array.isArray(input.frozenEvidence?.seedEvidence)) {
    throw new Error("KEYWORD_PREPARATION_FROZEN_EVIDENCE_INVALID");
  }
  if (input.frozenEvidence.comparables.length > 10) throw new Error("KEYWORD_PREPARATION_COMPARABLE_LIMIT_EXCEEDED");
}

function normalizeRawCandidate(candidate, fallbackSourceRef) {
  if (!isObject(candidate) || !nonEmpty(candidate.term)) throw new Error("KEYWORD_RAW_CANDIDATE_INVALID:term");
  const normalized = {
    term: candidate.term.trim(),
    sourceRefs: structuredClone(candidate.sourceRefs ?? (fallbackSourceRef ? [fallbackSourceRef] : [])),
    factRefs: structuredClone(candidate.factRefs ?? []),
    competitorRefs: structuredClone(candidate.competitorRefs ?? []),
    sourceTrust: candidate.sourceTrust ?? null,
    matchType: candidate.matchType ?? null
  };
  for (const field of ["sourceRefs", "factRefs", "competitorRefs"]) {
    if (!Array.isArray(normalized[field]) || normalized[field].some((item) => !nonEmpty(item))) throw new Error(`KEYWORD_RAW_CANDIDATE_INVALID:${field}`);
  }
  if (!(normalized.sourceTrust === null || nonEmpty(normalized.sourceTrust))) throw new Error("KEYWORD_RAW_CANDIDATE_INVALID:sourceTrust");
  if (!["target_fact", "exact_match", "substitute", "multi_seed"].includes(normalized.matchType)) throw new Error("KEYWORD_RAW_CANDIDATE_INVALID:matchType");
  if (normalized.sourceRefs.length === 0 || (normalized.factRefs.length === 0 && normalized.competitorRefs.length === 0)) {
    throw new Error("KEYWORD_RAW_CANDIDATE_UNTRACEABLE");
  }
  return normalized;
}

function buildLocalCandidates(frozenEvidence) {
  const candidates = [];
  for (const fact of frozenEvidence.productFactTerms) {
    candidates.push(normalizeRawCandidate({
      term: fact.term,
      sourceRefs: fact.sourceRefs,
      factRefs: fact.factRefs,
      competitorRefs: [],
      sourceTrust: fact.sourceTrust ?? null,
      matchType: "target_fact"
    }));
  }
  for (const comparable of frozenEvidence.comparables) {
    if (!nonEmpty(comparable.competitorRef) || comparable.comparabilityStatus !== "proven" ||
        !Array.isArray(comparable.comparabilityEvidenceRefs) || comparable.comparabilityEvidenceRefs.length === 0 ||
        comparable.comparabilityEvidenceRefs.some((item) => !nonEmpty(item)) ||
        !["exact_match", "substitute"].includes(comparable.matchType) || !Array.isArray(comparable.terms)) {
      throw new Error("KEYWORD_COMPARABLE_INVALID");
    }
    for (const term of comparable.terms) {
      candidates.push(normalizeRawCandidate({
        term: term.term,
        sourceRefs: term.sourceRefs,
        factRefs: term.factRefs ?? [],
        competitorRefs: [comparable.competitorRef],
        sourceTrust: term.sourceTrust ?? null,
        matchType: comparable.matchType
      }));
    }
  }
  for (const seed of frozenEvidence.seedEvidence) candidates.push(normalizeRawCandidate({ ...seed, matchType: "multi_seed" }));
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.term.toLocaleLowerCase()}\u0000${candidate.matchType}`;
    if (!unique.has(key)) unique.set(key, candidate);
    else {
      const previous = unique.get(key);
      unique.set(key, {
        ...previous,
        sourceRefs: [...new Set([...previous.sourceRefs, ...candidate.sourceRefs])],
        factRefs: [...new Set([...previous.factRefs, ...candidate.factRefs])],
        competitorRefs: [...new Set([...previous.competitorRefs, ...candidate.competitorRefs])],
        sourceTrust: previous.sourceTrust === candidate.sourceTrust ? previous.sourceTrust : null
      });
    }
  }
  return [...unique.values()];
}

function validateAttempt(attempt) {
  const validation = validateKeywordSourceAttempt(attempt);
  if (!validation.valid) throw new Error(`KEYWORD_SOURCE_ATTEMPT_INVALID:${validation.errors.map((item) => item.message).join(";")}`);
  return structuredClone(attempt);
}

function healthTrigger(input) {
  const health = input.healthPolicy;
  if (!isObject(health)) throw new Error("KEYWORD_HEALTH_POLICY_INVALID");
  if (!Number.isFinite(health.ttlMs) || health.ttlMs <= 0 || !Array.isArray(health.standardSkus) || health.standardSkus.length !== 3) {
    throw new Error("KEYWORD_HEALTH_POLICY_INVALID");
  }
  if (health.connectorVersion !== health.lastProof?.connectorVersion) return "connector_version_changed";
  if (health.apiSchemaVersion !== health.lastProof?.apiSchemaVersion) return "api_schema_version_changed";
  if (health.suspectedSystemicFailure === true) return "suspected_systemic_failure";
  if (health.controlledWindowId !== health.lastProof?.controlledWindowId) {
    const proofAt = Date.parse(health.lastProof?.provedAt);
    if (!Number.isFinite(proofAt) || Date.parse(input.now) - proofAt >= health.ttlMs) return "controlled_window_first_call_ttl_expired";
  }
  return null;
}

async function runHealthCheck(input, providers) {
  const trigger = healthTrigger(input);
  if (!trigger) return { trigger: null, calls: 0, suspended: false, receipts: [], pointsBefore: null, pointsAfter: null, pointsSpent: null };
  if (typeof providers.standardSkuHealth !== "function") throw new Error("KEYWORD_STANDARD_SKU_PROVIDER_MISSING");
  const receipts = [];
  for (const standardSku of input.healthPolicy.standardSkus) {
    const receipt = await providers.standardSkuHealth({
      standardSku: structuredClone(standardSku),
      trigger,
      connectorVersion: input.healthPolicy.connectorVersion,
      apiSchemaVersion: input.healthPolicy.apiSchemaVersion,
      now: input.now
    });
    if (!isObject(receipt) || receipt.standardSkuId !== standardSku.id || !["passed", "failed"].includes(receipt.status) ||
        !isoDateTime(receipt.checkedAt) || !(nonEmpty(receipt.receiptId) || nonEmpty(receipt.attemptId))) {
      throw new Error("KEYWORD_STANDARD_SKU_RECEIPT_INVALID");
    }
    const pointValues = [receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent];
    const allNull = pointValues.every((value) => value === null);
    const allFinite = pointValues.every((value) => Number.isFinite(value));
    if ((!allNull && !allFinite) || (allFinite && (receipt.pointsSpent < 0 || receipt.pointsBefore - receipt.pointsAfter !== receipt.pointsSpent))) {
      throw new Error("KEYWORD_STANDARD_SKU_POINTS_INVALID");
    }
    const previous = receipts.at(-1);
    if (previous && Number.isFinite(previous.pointsAfter) && Number.isFinite(receipt.pointsBefore) && previous.pointsAfter !== receipt.pointsBefore) {
      throw new Error("KEYWORD_STANDARD_SKU_POINTS_DISCONTINUOUS");
    }
    receipts.push(structuredClone(receipt));
    if (receipt.status === "failed") return summarizeHealth(trigger, receipts, true);
  }
  return summarizeHealth(trigger, receipts, false);
}

function summarizeHealth(trigger, receipts, suspended) {
  const pointReceipts = receipts.filter((item) => Number.isFinite(item.pointsSpent));
  return {
    trigger,
    calls: receipts.length,
    suspended,
    receipts,
    pointsBefore: pointReceipts.length > 0 ? pointReceipts[0].pointsBefore : null,
    pointsAfter: pointReceipts.length > 0 ? pointReceipts.at(-1).pointsAfter : null,
    pointsSpent: pointReceipts.length > 0 ? pointReceipts.reduce((sum, item) => sum + item.pointsSpent, 0) : null
  };
}

function pointsFrom(receipt) {
  const values = [receipt?.pointsBefore, receipt?.pointsAfter, receipt?.pointsSpent];
  return values.map((value) => Number.isFinite(value) ? value : null);
}

function addPoints(state, receipt) {
  const [before, after, spent] = pointsFrom(receipt);
  if (Number.isFinite(state.pointsAfter) && Number.isFinite(before) && state.pointsAfter !== before) throw new Error("KEYWORD_PROVIDER_POINTS_DISCONTINUOUS");
  if (Number.isFinite(before) && state.pointsBefore === null) state.pointsBefore = before;
  if (Number.isFinite(after)) state.pointsAfter = after;
  if (Number.isFinite(spent)) state.pointsSpent = (state.pointsSpent ?? 0) + spent;
}

function validateProviderReceipt(receipt, expectedChannel) {
  if (!isObject(receipt) || !Array.isArray(receipt.candidates)) throw new Error("KEYWORD_PROVIDER_RECEIPT_INVALID");
  const pointValues = [receipt.pointsBefore ?? null, receipt.pointsAfter ?? null, receipt.pointsSpent ?? null];
  const allNull = pointValues.every((value) => value === null);
  const allFinite = pointValues.every((value) => Number.isFinite(value));
  if ((!allNull && !allFinite) || (allFinite && (receipt.pointsSpent < 0 || receipt.pointsBefore - receipt.pointsAfter !== receipt.pointsSpent))) {
    throw new Error("KEYWORD_PROVIDER_POINTS_INVALID");
  }
  const attempt = validateAttempt(receipt.attempt);
  if (attempt.channel !== expectedChannel) throw new Error(`KEYWORD_${expectedChannel.toUpperCase()}_ATTEMPT_CHANNEL_INVALID`);
  if (attempt.failureClass !== null) {
    if (receipt.candidates.length !== 0) throw new Error("KEYWORD_PROVIDER_FAILURE_CANDIDATES_FORBIDDEN");
  } else {
    if (attempt.resultCount !== receipt.candidates.length || attempt.resultCount <= 0) throw new Error("KEYWORD_PROVIDER_RESULT_COUNT_MISMATCH");
  }
  const candidates = receipt.candidates.map((item) => normalizeRawCandidate(item));
  if (candidates.some((item) => !item.sourceRefs.includes(attempt.attemptId))) throw new Error("KEYWORD_PROVIDER_ATTEMPT_REF_MISMATCH");
  return { attempt, candidates };
}

function finalize(input, state) {
  const mergedPool = new Map();
  for (const candidate of state.rawCandidatePool) {
    const key = `${candidate.term.toLocaleLowerCase()}\u0000${candidate.matchType}`;
    const previous = mergedPool.get(key);
    if (!previous) mergedPool.set(key, candidate);
    else mergedPool.set(key, {
      ...previous,
      sourceRefs: [...new Set([...previous.sourceRefs, ...candidate.sourceRefs])],
      factRefs: [...new Set([...previous.factRefs, ...candidate.factRefs])],
      competitorRefs: [...new Set([...previous.competitorRefs, ...candidate.competitorRefs])],
      sourceTrust: previous.sourceTrust === candidate.sourceTrust ? previous.sourceTrust : null
    });
  }
  state.rawCandidatePool = [...mergedPool.values()];
  const exactCount = input.frozenEvidence.comparables.filter((item) => item.matchType === "exact_match").length;
  const coverage = state.rawCandidatePool.length === 0 && input.frozenEvidence.comparables.length === 0
    ? "none"
    : exactCount >= 5 ? "full" : "partial";
  const hasTrueEmpty = state.sourceAttempts.some((item) => item.failureClass === "true_empty");
  const hasTechnicalFailure = state.sourceAttempts.some((item) => TECHNICAL_FAILURES.has(item.failureClass));
  const hasPositiveProviderResult = state.sourceAttempts.some((item) => item.channel !== "local_fusion" && item.status === "completed" && item.failureClass === null && item.resultCount > 0);
  const result = state.rawCandidatePool.length > 0
    ? "source_candidates_ready"
    : hasPositiveProviderResult ? "needs_review"
      : hasTrueEmpty ? "true_empty"
        : hasTechnicalFailure ? "technical_unavailable" : "needs_review";
  const preparation = {
    schemaVersion: KEYWORD_EVIDENCE_PREPARATION_VERSION,
    sourcePreparationVersion: KEYWORD_SOURCE_PREPARATION_VERSION,
    preparationId: `keyword-preparation:${input.identity.candidateId}:${input.identity.dataRevision}:${digest({ identity: input.identity, bindings: input.bindings, now: input.now }).slice(0, 16)}`,
    identity: structuredClone(input.identity),
    bindings: structuredClone(input.bindings),
    scope: { platform: input.platform, exactSku: input.exactSku, fulfillment: input.fulfillment },
    businessGate: structuredClone(input.businessGate),
    preparedAt: input.now,
    result,
    coverage,
    reusedSnapshot: null,
    sourceAttempts: state.sourceAttempts,
    rawCandidatePool: state.rawCandidatePool,
    pointsBefore: state.pointsBefore,
    pointsAfter: state.pointsAfter,
    pointsSpent: state.pointsSpent,
    connector: {
      seerfarConnectorSuspended: state.health.suspended,
      suspensionReason: state.health.suspended ? "standard_sku_health_failed" : null,
      healthTrigger: state.health.trigger,
      standardSkuCalls: state.health.calls,
      healthReceipts: state.health.receipts
    },
    execution: {
      seerfarApiCalls: state.seerfarApiCalls,
      browserCalls: state.browserCalls,
      localFusionRuns: 1,
      networkCallsByLocalFusion: 0,
      modelCallsByLocalFusion: 0,
      automaticRetries: 0
    },
    businessEffect: { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 }
  };
  preparation.preparationFingerprint = digest(preparation);
  const validation = validateKeywordEvidencePreparation(preparation, { currentBinding: bindingFromInput(input) });
  if (!validation.valid) throw new Error(`KEYWORD_PREPARATION_INVALID:${validation.errors.join(";")}`);
  return deepFreeze(preparation);
}

export function validateKeywordEvidencePreparation(preparation, { currentBinding } = {}) {
  const errors = [];
  if (!isObject(preparation)) return { valid: false, errors: ["preparation必须是对象"] };
  if (preparation.schemaVersion !== KEYWORD_EVIDENCE_PREPARATION_VERSION) errors.push("schemaVersion无效");
  if (!KEYWORD_PREPARATION_RESULTS.includes(preparation.result)) errors.push("result无效");
  if (preparation.businessGate?.approved !== true || !isoDateTime(preparation.businessGate?.approvedAt) ||
      !nonEmpty(preparation.businessGate?.note) || !nonEmpty(preparation.businessGate?.evidenceRef)) errors.push("businessGate无效");
  if (!["full", "partial", "none"].includes(preparation.coverage)) errors.push("coverage无效");
  if (!Array.isArray(preparation.sourceAttempts) || !Array.isArray(preparation.rawCandidatePool)) errors.push("来源尝试和候选池必须是数组");
  else {
    for (const attempt of preparation.sourceAttempts) if (!validateKeywordSourceAttempt(attempt).valid) errors.push("存在无效sourceAttempt");
    for (const candidate of preparation.rawCandidatePool) {
      try { normalizeRawCandidate(candidate); } catch { errors.push("存在无效rawCandidate"); }
    }
  }
  if (preparation.execution?.seerfarApiCalls > 1 || preparation.execution?.browserCalls > 1 || preparation.execution?.automaticRetries !== 0 ||
      preparation.execution?.networkCallsByLocalFusion !== 0 || preparation.execution?.modelCallsByLocalFusion !== 0) errors.push("执行次数或本地融合边界无效");
  if (preparation.businessEffect?.businessPhaseChanged !== false || preparation.businessEffect?.businessResultChanged !== false ||
      preparation.businessEffect?.bOrC1Created !== false || preparation.businessEffect?.dispatchesCreated !== 0) errors.push("K2不得产生业务副作用");
  if (preparation.result === "source_candidates_ready" && preparation.rawCandidatePool.length === 0) errors.push("候选已准备必须有rawCandidatePool");
  if (preparation.result === "reused_snapshot" && !isObject(preparation.reusedSnapshot)) errors.push("复用结果必须携带有效快照");
  if (preparation.result !== "reused_snapshot" && preparation.reusedSnapshot !== null) errors.push("非复用结果不得携带复用快照");
  if (currentBinding) {
    const actual = bindingFromInput({ identity: preparation.identity, bindings: preparation.bindings });
    for (const key of Object.keys(currentBinding)) if (actual[key] !== currentBinding[key]) errors.push(`binding漂移:${key}`);
  }
  const copy = structuredClone(preparation);
  delete copy.preparationFingerprint;
  if (!nonEmpty(preparation.preparationFingerprint) || preparation.preparationFingerprint !== digest(copy)) errors.push("preparationFingerprint漂移");
  return { valid: errors.length === 0, errors };
}

export async function prepareKeywordEvidence(input, providers = {}) {
  validateInput(input);
  const currentBinding = bindingFromInput(input);
  let cachedTrueEmptyAttempts = [];
  if (input.reusableSnapshot) {
    const validation = validateKeywordEvidenceSnapshot(input.reusableSnapshot, { currentBinding, asOf: input.now });
    const reusableCurrent = validation.valid && Date.parse(input.reusableSnapshot.validity.expiresAt) > Date.parse(input.now);
    if (reusableCurrent && ["ready", "partial_ready"].includes(input.reusableSnapshot.status)) {
      const result = {
        schemaVersion: KEYWORD_EVIDENCE_PREPARATION_VERSION,
        sourcePreparationVersion: KEYWORD_SOURCE_PREPARATION_VERSION,
        preparationId: `keyword-preparation:${input.identity.candidateId}:${input.identity.dataRevision}:reused`,
        identity: structuredClone(input.identity),
        bindings: structuredClone(input.bindings),
        scope: { platform: input.platform, exactSku: input.exactSku, fulfillment: input.fulfillment },
        businessGate: structuredClone(input.businessGate),
        preparedAt: input.now,
        result: "reused_snapshot",
        coverage: input.reusableSnapshot.status === "ready" ? "full" : "partial",
        reusedSnapshot: structuredClone(input.reusableSnapshot),
        sourceAttempts: [],
        rawCandidatePool: [],
        pointsBefore: null,
        pointsAfter: null,
        pointsSpent: null,
        connector: { seerfarConnectorSuspended: false, suspensionReason: null, healthTrigger: null, standardSkuCalls: 0, healthReceipts: [] },
        execution: { seerfarApiCalls: 0, browserCalls: 0, localFusionRuns: 0, networkCallsByLocalFusion: 0, modelCallsByLocalFusion: 0, automaticRetries: 0 },
        businessEffect: { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 }
      };
      result.preparationFingerprint = digest(result);
      const preparationValidation = validateKeywordEvidencePreparation(result, { currentBinding });
      if (!preparationValidation.valid) throw new Error(`KEYWORD_PREPARATION_INVALID:${preparationValidation.errors.join(";")}`);
      return deepFreeze(result);
    }
    if (reusableCurrent && input.reusableSnapshot.status === "true_empty") {
      cachedTrueEmptyAttempts = structuredClone(input.reusableSnapshot.sourceAttempts);
    }
  }

  // 主人没有授权任何付费关键词提供方时，这一轮一次外部调用都不打。
  // 连接器健康检查查的就是 Seerfar 连接器本身——没有连接器，就没有可查的东西，
  // 跑它只会拿三条标准SKU去换一份查不出所以然的回执。来源只用本地融合
  // （`buildLocalCandidates`：已确认商品事实 + 已证可比对标的词 + 种子词），
  // 而 `source_candidates_ready` 本来就只看候选池非空，与有没有付费结果无关。
  // 这和下面浏览器那两个开关是同一套写法，不是新机制；不传就是授权，老行为一字不变。
  const paidProviderAuthorized = input.policy?.paidProviderAuthorized !== false;
  const health = (!paidProviderAuthorized || cachedTrueEmptyAttempts.length > 0)
    ? { trigger: null, calls: 0, suspended: false, receipts: [], pointsBefore: null, pointsAfter: null, pointsSpent: null }
    : await runHealthCheck(input, providers);
  const state = {
    health,
    sourceAttempts: cachedTrueEmptyAttempts,
    rawCandidatePool: [],
    pointsBefore: health.pointsBefore,
    pointsAfter: health.pointsAfter,
    pointsSpent: health.pointsSpent,
    seerfarApiCalls: 0,
    browserCalls: 0
  };
  let apiTechnicalFailure = false;
  if (paidProviderAuthorized && !health.suspended && cachedTrueEmptyAttempts.length === 0) {
    if (typeof providers.seerfarApi !== "function") throw new Error("KEYWORD_SEERFAR_PROVIDER_MISSING");
    const receipt = await providers.seerfarApi({ input: structuredClone(input), attemptLimit: 1 });
    state.seerfarApiCalls = 1;
    const { attempt: apiAttempt, candidates } = validateProviderReceipt(receipt, "api");
    state.sourceAttempts.push(apiAttempt);
    state.rawCandidatePool.push(...candidates);
    addPoints(state, receipt);
    apiTechnicalFailure = TECHNICAL_FAILURES.has(apiAttempt.failureClass);
  }

  if (apiTechnicalFailure && input.policy?.browserAllowed === true && input.policy?.browserPreauthorized === true) {
    if (typeof providers.browser !== "function") throw new Error("KEYWORD_BROWSER_PROVIDER_MISSING");
    const receipt = await providers.browser({ input: structuredClone(input), attemptLimit: 1 });
    state.browserCalls = 1;
    const { attempt: browserAttempt, candidates } = validateProviderReceipt(receipt, "browser");
    state.sourceAttempts.push(browserAttempt);
    state.rawCandidatePool.push(...candidates);
    addPoints(state, receipt);
  }

  const localCandidates = buildLocalCandidates(input.frozenEvidence);
  state.rawCandidatePool.push(...localCandidates);
  if (localCandidates.length > 0) {
    state.sourceAttempts.push(validateAttempt({
      schemaVersion: "keyword-source-attempt-v1",
      attemptId: `attempt:local-fusion:${input.identity.candidateId}:${input.identity.dataRevision}`,
      provider: "local-keyword-fusion",
      channel: "local_fusion",
      queryId: `local-fusion:${input.identity.candidateId}:${input.identity.dataRevision}`,
      queryText: "frozen_product_facts+frozen_comparables+frozen_seed_evidence",
      locale: input.locale ?? "und",
      targetPlatform: input.platform,
      requestId: `local:${input.identity.candidateId}:${input.identity.dataRevision}`,
      receiptId: null,
      startedAt: input.now,
      completedAt: input.now,
      status: "completed",
      resultCount: localCandidates.length,
      failureClass: null,
      traceRef: `local-fusion:${digest(input.frozenEvidence)}`
    }));
  }
  return finalize(input, state);
}
