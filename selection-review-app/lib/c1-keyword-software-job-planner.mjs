import { createHash } from "node:crypto";

import { validateKeywordEvidenceSnapshot } from "./keyword-evidence-snapshot.mjs";
import { legacyKeywordJobBlocksPaidExecution } from "./keyword-evidence-software-job-state.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_CAPABILITY,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER
} from "./software-job-contract.mjs";

export const C1_KEYWORD_SOFTWARE_JOB_PLAN_VERSION = "c1-keyword-software-job-plan-v1";
export const C1_KEYWORD_PLANNING_EVIDENCE_VERSION = "c1-keyword-planning-evidence-v1";

const SECRET_FIELD = /(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i;
const VALID_PLATFORMS = new Set(["ozon", "wb"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
}

/**
 * 履约模式。`skuPackage.fulfillmentMode` 这个字段**生产代码里从来没有人写过**——只有读、没有写，
 * `product-lifecycle-schema.mjs` 也没定义它，62 个真实候选一个都不带，唯一赋值的是几个测试夹具。
 * 结果是这道门在 CI 里永远绿、在生产里谁都过不去（2026-09-17 查实）。
 *
 * 但这件事本来就冻在与 C1 绑定的那份利润模型里：成本口径的 `salesScheme`。这里从**已冻结的数据**
 * 里把它读出来，不是替主人现造一个值。包上真写了字段就以字段为准；两处口径不一致就照实返回读不准，
 * 绝不挑一个用——含糊的地方不替主人签字。
 */
export function resolveFrozenFulfillmentMode(skuPackage, profitModel) {
  if (nonEmpty(skuPackage?.fulfillmentMode)) return skuPackage.fulfillmentMode.trim();
  const costs = profitModel?.otherCosts;
  const fromSnapshot = costs?.costPolicySnapshot?.scope?.salesScheme;
  const fromContext = costs?.costPolicyContext?.salesScheme;
  if (!nonEmpty(fromSnapshot) || !nonEmpty(fromContext)) return null;
  return fromSnapshot.trim() === fromContext.trim() ? fromSnapshot.trim() : null;
}


function iso(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function assertNoSecrets(value, path = "planningInput") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`C1_KEYWORD_JOB_PLAN_SECRET_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function gap(code, field, message) {
  return { code, field, message };
}

function finish({ status, candidate, skuPackage, plannedAt, mode = null, gaps = [], job = null, reusableSnapshot = null, bindings = null }) {
  const result = {
    schemaVersion: C1_KEYWORD_SOFTWARE_JOB_PLAN_VERSION,
    status,
    candidateId: candidate?.id ?? null,
    sourceCandidateRevision: candidate?.dataRevision ?? null,
    skuPackageId: skuPackage?.skuPackageId ?? null,
    sourceSkuRevision: skuPackage?.dataRevision ?? null,
    mode,
    bindings,
    gaps,
    job,
    reusableSnapshot,
    executionPolicy: {
      provider: mode === "seerfar_open_api_once" ? "seerfar_open_api" : "none",
      attemptLimit: mode === "seerfar_open_api_once" ? 1 : 0,
      automaticRetries: 0,
      browserFallbackAllowed: false,
      codexDispatchAllowed: false,
      c2Started: false,
      dStarted: false,
      eStarted: false
    },
    plannedAt
  };
  result.planFingerprint = digest(result);
  assertNoSecrets(result, "plan");
  return freeze(result);
}

function versionAndFingerprint(snapshot, fallbackVersion) {
  return {
    version: nonEmpty(snapshot?.version) ? snapshot.version : nonEmpty(snapshot?.schemaVersion) ? snapshot.schemaVersion : fallbackVersion,
    fingerprint: nonEmpty(snapshot?.fingerprint) ? snapshot.fingerprint : digest(snapshot)
  };
}

function resolveCore(candidate, expectedRevision, plannedAt) {
  if (!isObject(candidate) || !nonEmpty(candidate.id) || !Number.isInteger(candidate.dataRevision) ||
      candidate.dataRevision !== expectedRevision || !iso(plannedAt)) {
    throw new Error("C1_KEYWORD_JOB_PLAN_INPUT_INVALID: 候选、revision或计划时间无效");
  }
  const sku = candidate.lifecycleV11?.skuPackage;
  if (!isObject(sku) || !nonEmpty(sku.skuPackageId) || sku.g1Identity?.candidateId !== candidate.id || sku.businessPhase !== "C1") {
    return { status: "not_ready", sku, gaps: [gap("c1_sku_package_missing", "lifecycleV11.skuPackage", "当前候选没有唯一且处于C1阶段的SKU生命周期包")] };
  }
  const plan = sku.c1ProductPlan;
  if (!isObject(plan) || !["facts_checked", "seo_draft_ready"].includes(plan.status)) {
    return { status: "not_ready", sku, gaps: [gap("c1_facts_not_checked", "c1ProductPlan.status", "C1商品事实尚未完成核验")] };
  }
  const identity = plan.identity;
  if (!isObject(identity) || identity.skuPackageId !== sku.skuPackageId || identity.supplierSkuId !== sku.supplierSkuId ||
      identity.targetStore !== sku.targetStore || identity.variantKey !== sku.variantKey ||
      !VALID_PLATFORMS.has(identity.targetPlatform) || !nonEmpty(identity.targetStore) ||
      !nonEmpty(identity.parentOpportunityId) || !nonEmpty(identity.variantKey)) {
    return { status: "blocked", sku, gaps: [gap("c1_identity_drift", "c1ProductPlan.identity", "C1身份、平台或精确供应SKU与当前生命周期包不一致")] };
  }
  const sales = plan.inputSnapshots?.salesSnapshot;
  const supply = plan.inputSnapshots?.confirmedSupplierSkuSnapshot;
  const profit = plan.inputSnapshots?.profitModel;
  if (!isObject(profit) || profit.result !== "passed" || profit.profitModelVersion !== plan.inputRefs?.profitModelVersion) {
    return { status: "not_ready", sku, gaps: [gap("b_profit_not_passed", "c1ProductPlan.inputSnapshots.profitModel", "缺少与C1绑定的B利润通过证据")] };
  }
  if (!isObject(sales) || sales.snapshotId !== plan.inputRefs?.salesSnapshotId || !nonEmpty(sales.evidenceRef)) {
    return { status: "not_ready", sku, gaps: [gap("sales_snapshot_missing", "c1ProductPlan.inputSnapshots.salesSnapshot", "A销售快照缺失或与C1引用不一致")] };
  }
  if (!isObject(supply) || supply.snapshotId !== plan.inputRefs?.selectedSupplySnapshotId ||
      supply.ownerSupplyConfirmation?.status !== "confirmed" || supply.supplierSku?.supplierSkuId !== identity.supplierSkuId) {
    return { status: "not_ready", sku, gaps: [gap("confirmed_supply_snapshot_missing", "c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot", "主人确认的供应SKU快照缺失或身份不一致")] };
  }
  const factFields = ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment", "categoryRestrictions", "platformCompliance"];
  if (factFields.some((field) => !isObject(plan[field]))) {
    return { status: "not_ready", sku, gaps: [gap("verified_facts_incomplete", "c1ProductPlan", "C1事实核验字段不完整，不能构造关键词作业")] };
  }
  const fulfillmentMode = resolveFrozenFulfillmentMode(sku, profit);
  if (fulfillmentMode === null) {
    return { status: "not_ready", sku, gaps: [gap("fulfillment_missing", "skuPackage.fulfillmentMode", "SKU生命周期包未冻结履约模式")] };
  }
  const salesBinding = versionAndFingerprint(sales, null);
  const supplyBinding = versionAndFingerprint(supply, "c1-confirmed-supplier-sku-snapshot-v1");
  const factsFingerprint = digest(Object.fromEntries(factFields.map((field) => [field, plan[field]])));
  return {
    status: "ready",
    sku,
    plan,
    sales,
    supply,
    profit,
    bindings: {
      candidateId: candidate.id,
      parentOpportunityId: identity.parentOpportunityId,
      skuPackageId: sku.skuPackageId,
      candidateRevision: candidate.dataRevision,
      skuRevision: sku.dataRevision,
      platform: identity.targetPlatform,
      targetStore: identity.targetStore,
      exactSupplierSkuId: identity.supplierSkuId,
      variantKey: identity.variantKey,
      fulfillment: fulfillmentMode,
      profitModelVersion: profit.profitModelVersion,
      profitModelFingerprint: digest(profit),
      salesSnapshotId: sales.snapshotId,
      salesSnapshotVersion: salesBinding.version,
      salesSnapshotFingerprint: salesBinding.fingerprint,
      supplySnapshotId: supply.snapshotId,
      supplySnapshotVersion: supplyBinding.version,
      supplySnapshotFingerprint: supplyBinding.fingerprint,
      c1FactsFingerprint: factsFingerprint
    }
  };
}

function validatePlanningEvidence(candidate, core, plannedAt) {
  const evidence = candidate.lifecycleV11?.c1KeywordPlanningEvidenceV1;
  if (!isObject(evidence) || evidence.schemaVersion !== C1_KEYWORD_PLANNING_EVIDENCE_VERSION) {
    return { status: "not_ready", gaps: [gap("keyword_planning_evidence_missing", "lifecycleV11.c1KeywordPlanningEvidenceV1", "缺少服务端已保存的关键词准备证据")] };
  }
  const expected = core.bindings;
  const bindingFields = ["candidateId", "skuPackageId", "candidateRevision", "platform", "exactSupplierSkuId", "salesSnapshotId", "supplySnapshotId"];
  if (bindingFields.some((field) => evidence.binding?.[field] !== expected[field])) {
    return { status: "blocked", gaps: [gap("keyword_planning_binding_drift", "c1KeywordPlanningEvidenceV1.binding", "关键词准备证据与当前候选、SKU或上游快照不一致")] };
  }
  if (!iso(evidence.expiresAt) || Date.parse(evidence.expiresAt) <= Date.parse(plannedAt)) {
    return { status: "not_ready", gaps: [gap("keyword_planning_evidence_expired", "c1KeywordPlanningEvidenceV1.expiresAt", "关键词准备证据已过期")] };
  }
  if (!isObject(evidence.frozenSeoRules) || !isObject(evidence.healthPolicy) || !Array.isArray(evidence.productFactTerms) ||
      !Array.isArray(evidence.comparables) || !Array.isArray(evidence.seedEvidence) || !isObject(evidence.keywordMetricEvidence)) {
    return { status: "not_ready", gaps: [gap("keyword_planning_evidence_incomplete", "c1KeywordPlanningEvidenceV1", "SEO规则、健康证明、事实词、竞品或评分证据不完整")] };
  }
  const health = evidence.healthPolicy;
  const proofAt = Date.parse(health.lastProof?.provedAt);
  if (!Array.isArray(health.standardSkus) || health.standardSkus.length !== 3 || !Number.isFinite(health.ttlMs) || health.ttlMs <= 0 ||
      !nonEmpty(health.connectorVersion) || !nonEmpty(health.apiSchemaVersion) ||
      health.connectorVersion !== health.lastProof?.connectorVersion || health.apiSchemaVersion !== health.lastProof?.apiSchemaVersion ||
      health.controlledWindowId !== health.lastProof?.controlledWindowId || !Number.isFinite(proofAt) || Date.parse(plannedAt) - proofAt >= health.ttlMs ||
      health.suspectedSystemicFailure === true) {
    return { status: "blocked", gaps: [gap("standard_sku_health_not_current", "c1KeywordPlanningEvidenceV1.healthPolicy", "三条标准SKU健康证明无效或过期，当前批次不得扣点")] };
  }
  return { status: "ready", evidence };
}

function currentSnapshotBinding(core) {
  return {
    candidateId: core.bindings.candidateId,
    parentOpportunityId: core.bindings.parentOpportunityId,
    skuPackageId: core.bindings.skuPackageId,
    dataRevision: core.bindings.candidateRevision,
    salesSnapshotVersion: core.bindings.salesSnapshotVersion,
    salesSnapshotFingerprint: core.bindings.salesSnapshotFingerprint,
    supplySkuFactsVersion: core.bindings.supplySnapshotVersion,
    supplySkuFactsFingerprint: core.bindings.supplySnapshotFingerprint
  };
}

function reusableResult(candidate, core, evidence, plannedAt) {
  const snapshot = evidence.reusableKeywordSnapshot;
  if (!isObject(snapshot)) return null;
  const validation = validateKeywordEvidenceSnapshot(snapshot, { currentBinding: currentSnapshotBinding(core), asOf: plannedAt });
  if (snapshot.status !== "ready" || !validation.valid) return null;
  const runtimeInputTemplate = buildRuntimeInputTemplate(candidate, core, evidence, snapshot);
  return finish({
    status: "ready",
    candidate,
    skuPackage: core.sku,
    plannedAt,
    mode: "reuse_existing_evidence",
    gaps: [],
    job: {
      schemaVersion: "c1-keyword-evidence-reuse-plan-v1",
      candidateId: candidate.id,
      dataRevision: candidate.dataRevision,
      skuPackageId: core.sku.skuPackageId,
      pointsRequired: 0,
      providerCalls: 0,
      runtimeInputTemplate,
      reuseEvidenceNote: evidence.reuseEvidenceNote
    },
    reusableSnapshot: structuredClone(snapshot),
    bindings: structuredClone(core.bindings)
  });
}

function selectCompetitors(evidence, platform) {
  const eligible = evidence.comparables.filter((item) => item?.useForReverseLookup === true);
  if (eligible.length < 3 || eligible.length > 5) {
    return { status: "blocked", gaps: [gap("valid_competitor_count_invalid", "c1KeywordPlanningEvidenceV1.comparables", "必须有3至5个已核验且明确选中的同品竞品")] };
  }
  for (const item of eligible) {
    if (!isObject(item) || item.platform !== platform || item.matchType !== "exact_match" || item.comparabilityStatus !== "proven" ||
        !nonEmpty(item.competitorRef) || !(nonEmpty(item.seerfarSku) || Number.isInteger(item.seerfarSku)) ||
        !Array.isArray(item.comparabilityEvidenceRefs) || item.comparabilityEvidenceRefs.length === 0 || item.comparabilityEvidenceRefs.some((ref) => !nonEmpty(ref))) {
      return { status: "blocked", gaps: [gap("invalid_competitor_evidence", "c1KeywordPlanningEvidenceV1.comparables", "竞品必须为当前平台、同品、可追溯且具有Seerfar SKU")] };
    }
  }
  const trafficPresent = eligible.every((item) => Number.isFinite(item.organicTraffic?.value) && nonEmpty(item.organicTraffic?.period) && nonEmpty(item.organicTraffic?.evidenceRef));
  if (trafficPresent) {
    const periods = new Set(eligible.map((item) => item.organicTraffic.period));
    if (periods.size !== 1) return { status: "blocked", gaps: [gap("organic_traffic_period_conflict", "comparables.organicTraffic.period", "竞品自然流量周期不一致，不能排序")] };
  } else if (eligible.some((item) => !Number.isInteger(item.manualSelectionRank) || item.manualSelectionRank < 1 || !nonEmpty(item.selectionEvidenceRef))) {
    return { status: "blocked", gaps: [gap("competitor_order_evidence_missing", "comparables", "缺少可比自然流量时，必须保存明确的人工选择顺序和证据，不得猜排名")] };
  }
  const selected = [...eligible].sort(trafficPresent
    ? (left, right) => right.organicTraffic.value - left.organicTraffic.value
    : (left, right) => left.manualSelectionRank - right.manualSelectionRank);
  return { status: "ready", selected, selectionMethod: trafficPresent ? "non_ad_organic_traffic_desc" : "owner_verified_unranked_selection" };
}

function validatePointGate(evidence, plannedAt) {
  const quota = evidence.quotaEvidence;
  const budget = evidence.pointBudget;
  if (!isObject(quota) || !Number.isFinite(quota.availablePoints) || !iso(quota.observedAt) || !iso(quota.expiresAt) ||
      Date.parse(quota.expiresAt) <= Date.parse(plannedAt) || !nonEmpty(quota.evidenceRef)) {
    return { status: "blocked", gaps: [gap("quota_evidence_missing_or_stale", "quotaEvidence", "缺少当前可用点数证据，不能创建付费作业")] };
  }
  if (!isObject(budget) || budget.approved !== true || !Number.isFinite(budget.maxPoints) || budget.maxPoints < C1_PAID_KEYWORD_POINTS || !nonEmpty(budget.evidenceRef)) {
    return { status: "blocked", gaps: [gap("paid_points_not_approved", "pointBudget", "未批准本次最多15点的反查预算")] };
  }
  if (quota.availablePoints < C1_PAID_KEYWORD_POINTS) {
    return { status: "blocked", gaps: [gap("quota_insufficient", "quotaEvidence.availablePoints", `当前点数不足${C1_PAID_KEYWORD_POINTS}点`)] };
  }
  return { status: "ready", quota, budget };
}

function buildRuntimeInputTemplate(candidate, core, evidence, reusableSnapshot, { dataRevision = candidate.dataRevision } = {}) {
  return {
    schemaVersion: "c1-fact-keyword-runtime-input-v1",
    dataRevision,
    keywordSourceEvidence: {
      fulfillment: core.bindings.fulfillment,
      locale: evidence.locale,
      policy: { browserAllowed: false, browserPreauthorized: false },
      healthPolicy: structuredClone(evidence.healthPolicy),
      frozenEvidence: {
        productFactTerms: structuredClone(evidence.productFactTerms),
        comparables: structuredClone(evidence.comparables),
        seedEvidence: structuredClone(evidence.seedEvidence)
      }
    },
    frozenSeoRules: structuredClone(evidence.frozenSeoRules),
    frozenComplexityDecision: evidence.frozenComplexityDecision === undefined ? null : structuredClone(evidence.frozenComplexityDecision),
    reusableKeywordSnapshot: reusableSnapshot ? structuredClone(reusableSnapshot) : null,
    keywordExpiresAt: evidence.expiresAt,
    providerEvidence: {
      seerfarApiReceipt: null,
      browserReceipt: null,
      standardSkuHealthReceipts: [],
      keywordMetricEvidence: structuredClone(evidence.keywordMetricEvidence)
    }
  };
}

export function planC1KeywordEvidenceSoftwareJob({ candidate, expectedRevision, plannedAt, existingPlan = null }) {
  assertNoSecrets(candidate, "candidate");
  const core = resolveCore(candidate, expectedRevision, plannedAt);
  if (core.status !== "ready") return finish({ status: core.status, candidate, skuPackage: core.sku, plannedAt, gaps: core.gaps });
  if (legacyKeywordJobBlocksPaidExecution(candidate)) {
    return finish({ status: "blocked", candidate, skuPackage: core.sku, plannedAt,
      gaps: [gap("legacy_keyword_job_unresolved", "keywordEvidenceSoftwareJobV1", "旧付费请求尚未对账，禁止创建新付费作业")], bindings: core.bindings });
  }
  const evidenceResult = validatePlanningEvidence(candidate, core, plannedAt);
  if (evidenceResult.status !== "ready") return finish({ status: evidenceResult.status, candidate, skuPackage: core.sku, plannedAt, gaps: evidenceResult.gaps, bindings: core.bindings });
  const evidence = evidenceResult.evidence;
  if (!nonEmpty(evidence.locale)) return finish({ status: "not_ready", candidate, skuPackage: core.sku, plannedAt, gaps: [gap("locale_missing", "c1KeywordPlanningEvidenceV1.locale", "关键词语言未冻结")], bindings: core.bindings });

  const reused = reusableResult(candidate, core, evidence, plannedAt);
  if (reused) return reused;

  const competitors = selectCompetitors(evidence, core.bindings.platform);
  if (competitors.status !== "ready") return finish({ status: "blocked", candidate, skuPackage: core.sku, plannedAt, gaps: competitors.gaps, bindings: core.bindings });
  const points = validatePointGate(evidence, plannedAt);
  if (points.status !== "ready") return finish({ status: "blocked", candidate, skuPackage: core.sku, plannedAt, gaps: points.gaps, bindings: core.bindings });

  const runtimeInputTemplate = buildRuntimeInputTemplate(candidate, core, evidence, null, { dataRevision: candidate.dataRevision + 1 });
  const sourceSkuIds = competitors.selected.map((item) => item.seerfarSku);
  const competitorRefs = competitors.selected.map((item) => item.competitorRef);
  const factRefs = [...new Set(competitors.selected.flatMap((item) => item.factRefs ?? []).filter(nonEmpty))];
  if (factRefs.length === 0) {
    return finish({ status: "blocked", candidate, skuPackage: core.sku, plannedAt, gaps: [gap("competitor_fact_binding_missing", "comparables.factRefs", "竞品未绑定当前商品事实")], bindings: core.bindings });
  }
  const planKey = digest({ bindings: core.bindings, sourceSkuIds, evidenceFingerprint: digest(evidence) });
  const jobId = `keyword-job:${candidate.id}:${candidate.dataRevision}:${planKey.slice(0, 16)}`;
  const seerfarRequest = {
    operation: "reverse_keywords",
    platform: core.bindings.platform,
    skuIds: sourceSkuIds,
    factRefs,
    competitorRefs,
    matchType: "exact_match",
    attemptId: `attempt:seerfar:${planKey.slice(0, 20)}`,
    queryId: `query:seerfar:${planKey.slice(0, 20)}`,
    receiptId: `receipt:seerfar:${planKey.slice(0, 20)}`
  };
  const runtimeInputFingerprint = digest(runtimeInputTemplate);
  const seerfarRequestFingerprint = digest(seerfarRequest);
  const scopeBinding = {
    schemaVersion: "software-job-scope-v1",
    candidateId: candidate.id,
    skuPackageId: core.sku.skuPackageId,
    sourceRevision: candidate.dataRevision,
    resultRevision: candidate.dataRevision + 1,
    platform: core.bindings.platform,
    targetStore: core.bindings.targetStore,
    supplierSkuId: core.bindings.exactSupplierSkuId,
    variantKey: core.bindings.variantKey,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationRef: `c1-paid-keyword-authz-${planKey.slice(0, 20)}`,
    credentialAlias: `seerfar-open-api-alias-${core.bindings.platform}-${core.bindings.targetStore}`,
    inputFingerprint: planKey,
    planningEvidenceFingerprint: digest(evidence),
    runtimeInputFingerprint,
    seerfarRequestFingerprint,
    salesSnapshotFingerprint: core.bindings.salesSnapshotFingerprint,
    supplySnapshotFingerprint: core.bindings.supplySnapshotFingerprint,
    profitModelFingerprint: core.bindings.profitModelFingerprint,
    c1FactsFingerprint: core.bindings.c1FactsFingerprint,
    pointBudgetEvidenceRef: points.budget.evidenceRef,
    quotaEvidenceRef: points.quota.evidenceRef,
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    provider: C1_PAID_KEYWORD_PROVIDER
  };
  const job = {
    schemaVersion: "c1-paid-keyword-evidence-software-job-plan-v1",
    jobId,
    jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: candidate.id,
    skuPackageId: core.sku.skuPackageId,
    sourceRevision: candidate.dataRevision,
    resultRevision: candidate.dataRevision + 1,
    platform: core.bindings.platform,
    targetStore: core.bindings.targetStore,
    supplierSkuId: core.bindings.exactSupplierSkuId,
    variantKey: core.bindings.variantKey,
    provider: C1_PAID_KEYWORD_PROVIDER,
    requiredCapabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    idempotencyKey: `c1-paid-keyword:${candidate.id}:${candidate.dataRevision}:${planKey.slice(0, 20)}`,
    scopeBinding,
    runtimeInputTemplate,
    runtimeInputFingerprint,
    seerfarRequest,
    seerfarRequestFingerprint,
    evidencePolicy: {
      selectedCompetitorCount: sourceSkuIds.length,
      competitorSelectionMethod: competitors.selectionMethod,
      quotaEvidenceRef: points.quota.evidenceRef,
      pointsAvailableBefore: points.quota.availablePoints,
      pointBudgetEvidenceRef: points.budget.evidenceRef,
      maximumPoints: C1_PAID_KEYWORD_POINTS,
      trueEmptyBoundary: "only_completed_query_with_explicit_zero_results",
      technicalFailureIsNotTrueEmpty: true,
      emptyResultAction: "retain_business_result_and_continue_only_with_frozen_multi_source_evidence"
    }
  };
  job.jobFingerprint = digest(job);
  if (existingPlan) {
    if (existingPlan.planFingerprint && existingPlan.job?.jobId === jobId && existingPlan.job?.jobFingerprint === job.jobFingerprint) return freeze(structuredClone(existingPlan));
    return finish({ status: "blocked", candidate, skuPackage: core.sku, plannedAt, gaps: [gap("different_plan_already_exists", "existingPlan", "当前SKU/revision已经存在另一份作业计划")], bindings: core.bindings });
  }
  return finish({ status: "ready", candidate, skuPackage: core.sku, plannedAt, mode: "seerfar_open_api_once", job, bindings: core.bindings });
}

/**
 * HTTP层只能把客户端的dataRevision交给这里；runtimeInputTemplate与Seerfar请求始终由服务端生成。
 * 领域层仍保留blocked语义，服务编排层统一折叠为not_ready并通过readinessClass展示真实原因。
 */
export function buildC1KeywordSoftwareJobPlan(input) {
  const detailed = planC1KeywordEvidenceSoftwareJob(input);
  const status = detailed.mode === "reuse_existing_evidence" && detailed.status === "ready"
    ? "reuse_ready"
    : detailed.status === "blocked" ? "not_ready" : detailed.status;
  return freeze({
    ...structuredClone(detailed),
    status,
    readinessClass: detailed.status,
    runtimeInputTemplate: detailed.job?.runtimeInputTemplate ?? null,
    seerfarRequest: detailed.job?.seerfarRequest ?? null
  });
}

export function assertC1KeywordSoftwareJobClientInput(body) {
  if (!isObject(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "dataRevision") ||
      !Number.isInteger(body.dataRevision) || body.dataRevision < 0) {
    throw new Error("C1_KEYWORD_JOB_CLIENT_INPUT_REJECTED: 客户端只允许提交dataRevision");
  }
  return freeze({ dataRevision: body.dataRevision });
}
