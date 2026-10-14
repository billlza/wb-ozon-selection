import { createHash } from "node:crypto";

import { verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { resolveC1SkuRightsReviewForFacts } from "./c1-sku-rights-review.mjs";
import {
  buildC1KeywordSoftwareJobPlan,
  resolveFrozenFulfillmentMode,
  C1_KEYWORD_PLANNING_EVIDENCE_VERSION
} from "./c1-keyword-software-job-planner.mjs";

export const C1_KEYWORD_PLANNING_PRODUCTION_VERSION = "c1-keyword-planning-production-v1";
export const C1_KEYWORD_PLANNING_SOURCE_VERSION = "c1-keyword-planning-source-evidence-v1";

const SECRET_FIELD = /(?:token|cookie|password|secret|authorization|apikey|bearer|headers?)/i;
const SECRET_VALUE = /(?:authorization|bearer|cookie|password|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*(?:=|:)/i;
const SECRET_URL_QUERY = /[?&](?:key|token|secret|signature|password)=/i;
const VALID_RESULT = new Set(["ready", "reuse_ready", "not_ready", "blocked"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
}

function validTime(value) {
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

function normalizeSemanticTerm(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und") : null;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function assertNoSecrets(value, path = "sourceEvidence") {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value) || SECRET_URL_QUERY.test(value)) {
      throw new Error(`C1_KEYWORD_PLANNING_SECRET_FORBIDDEN:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SECRET_FIELD.test(normalizedKey)) throw new Error(`C1_KEYWORD_PLANNING_SECRET_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function assertAllowedKeys(value, allowed, path) {
  if (!isObject(value)) throw new Error(`C1_KEYWORD_PLANNING_SOURCE_INVALID:${path}`);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`C1_KEYWORD_PLANNING_SOURCE_FIELD_FORBIDDEN:${path}.${extra[0]}`);
}

function copyPresent(source, fields) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, structuredClone(source[field])]));
}

function sanitizeRawTerm(item, path, forcedMatchType = null) {
  const fields = ["term", "sourceRefs", "factRefs", "factBindings", "competitorRefs", "sourceTrust", "matchType"];
  assertAllowedKeys(item, fields, path);
  return {
    term: item.term,
    sourceRefs: structuredClone(item.sourceRefs),
    factRefs: structuredClone(item.factRefs),
    factBindings: structuredClone(item.factBindings),
    competitorRefs: structuredClone(item.competitorRefs ?? []),
    sourceTrust: item.sourceTrust ?? null,
    matchType: forcedMatchType ?? item.matchType
  };
}

function sanitizeSeoRules(value) {
  const fields = ["rulesVersion", "evidenceRef", "locale", "frozenAt", "titleMaxLength", "descriptionMaxLength", "bulletPointLimit", "prohibitedClaims"];
  assertAllowedKeys(value, fields, "frozenSeoRules");
  return copyPresent(value, fields);
}

function sanitizeComplexity(value) {
  if (value === null || value === undefined) return null;
  const fields = ["decisionId", "ruleVersion", "evaluatedAt", "c1PlanId", "sourceFactsFingerprint", "complexity", "reason", "evidenceRefs", "gatewayTaskType"];
  assertAllowedKeys(value, fields, "frozenComplexityDecision");
  return copyPresent(value, fields);
}

function sanitizeHealth(value) {
  const fields = ["connectorVersion", "apiSchemaVersion", "controlledWindowId", "ttlMs", "suspectedSystemicFailure", "standardSkus", "lastProof"];
  assertAllowedKeys(value, fields, "healthPolicy");
  return {
    connectorVersion: value.connectorVersion,
    apiSchemaVersion: value.apiSchemaVersion,
    controlledWindowId: value.controlledWindowId,
    ttlMs: value.ttlMs,
    suspectedSystemicFailure: value.suspectedSystemicFailure,
    standardSkus: value.standardSkus.map((item, index) => {
      assertAllowedKeys(item, ["id", "status", "evidenceRef"], `healthPolicy.standardSkus[${index}]`);
      return { id: item.id, status: item.status, evidenceRef: item.evidenceRef };
    }),
    lastProof: (() => {
      assertAllowedKeys(value.lastProof, ["connectorVersion", "apiSchemaVersion", "controlledWindowId", "provedAt"], "healthPolicy.lastProof");
      return copyPresent(value.lastProof, ["connectorVersion", "apiSchemaVersion", "controlledWindowId", "provedAt"]);
    })()
  };
}

function sanitizeComparable(item, index) {
  const path = `comparables[${index}]`;
  const fields = ["competitorRef", "seerfarSku", "platform", "matchType", "comparabilityStatus", "comparabilityEvidenceRefs", "factRefs", "factBindings", "useForReverseLookup", "organicTraffic", "manualSelectionRank", "selectionEvidenceRef", "terms"];
  assertAllowedKeys(item, fields, path);
  let organicTraffic = null;
  if (item.organicTraffic !== null && item.organicTraffic !== undefined) {
    assertAllowedKeys(item.organicTraffic, ["value", "period", "evidenceRef"], `${path}.organicTraffic`);
    organicTraffic = copyPresent(item.organicTraffic, ["value", "period", "evidenceRef"]);
  }
  return {
    competitorRef: item.competitorRef,
    seerfarSku: item.seerfarSku,
    platform: item.platform,
    matchType: item.matchType,
    comparabilityStatus: item.comparabilityStatus,
    comparabilityEvidenceRefs: structuredClone(item.comparabilityEvidenceRefs),
    factRefs: structuredClone(item.factRefs ?? []),
    factBindings: structuredClone(item.factBindings ?? []),
    useForReverseLookup: item.useForReverseLookup,
    organicTraffic,
    manualSelectionRank: item.manualSelectionRank,
    selectionEvidenceRef: item.selectionEvidenceRef,
    terms: item.terms.map((term, termIndex) => sanitizeRawTerm(term, `${path}.terms[${termIndex}]`, item.matchType))
  };
}

function sanitizeQuota(value) {
  if (value === null || value === undefined) return null;
  assertAllowedKeys(value, ["availablePoints", "observedAt", "expiresAt", "evidenceRef"], "quotaEvidence");
  return copyPresent(value, ["availablePoints", "observedAt", "expiresAt", "evidenceRef"]);
}

function sanitizeBudget(value) {
  if (value === null || value === undefined) return null;
  assertAllowedKeys(value, ["approved", "maxPoints", "evidenceRef"], "pointBudget");
  return copyPresent(value, ["approved", "maxPoints", "evidenceRef"]);
}

function sanitizeMetricEvidence(value) {
  assertAllowedKeys(value, ["version", "evidenceRef", "preparationFingerprint", "candidates"], "keywordMetricEvidence");
  const componentNames = ["semanticMatch", "searchDemand", "addToCartConversion", "competitorConsensus", "titleDensity", "competitorCount", "searchGrowth", "returnCancelHealth", "sourceTrust"];
  const candidates = value.candidates.map((candidate, index) => {
    const path = `keywordMetricEvidence.candidates[${index}]`;
    assertAllowedKeys(candidate, ["key", "descriptionGate", "components"], path);
    assertAllowedKeys(candidate.descriptionGate, ["approved", "evidenceRef", "reason"], `${path}.descriptionGate`);
    assertAllowedKeys(candidate.components, componentNames, `${path}.components`);
    const components = Object.fromEntries(componentNames.filter((name) => Object.hasOwn(candidate.components, name)).map((name) => {
      const component = candidate.components[name];
      if (component === null) return [name, null];
      const componentPath = `${path}.components.${name}`;
      const fields = ["value", "rawValue", "raw", "normalizationRule", "conversionRule", "evidenceRef", "observedAt", "period"];
      assertAllowedKeys(component, fields, componentPath);
      const sanitized = copyPresent(component, fields);
      if (isObject(sanitized.raw)) {
        assertAllowedKeys(sanitized.raw, ["returnRate", "cancelRate"], `${componentPath}.raw`);
        sanitized.raw = copyPresent(sanitized.raw, ["returnRate", "cancelRate"]);
      }
      return [name, sanitized];
    }));
    return {
      key: candidate.key,
      descriptionGate: copyPresent(candidate.descriptionGate, ["approved", "evidenceRef", "reason"]),
      components
    };
  });
  return { ...copyPresent(value, ["version", "evidenceRef", "preparationFingerprint"]), candidates };
}

function sanitizeReusableSnapshot(value) {
  if (value === null || value === undefined) return null;
  const fields = ["schemaVersion", "snapshotId", "snapshotFingerprint", "status", "identity", "bindings", "validity", "sourceAttempts", "groups", "scoringContext", "businessEffect"];
  assertAllowedKeys(value, fields, "reusableKeywordSnapshot");
  return copyPresent(value, fields);
}

function sanitizeSourceEvidence(value) {
  const fields = ["schemaVersion", "locale", "expiresAt", "frozenSeoRules", "frozenComplexityDecision", "healthPolicy", "productFactTerms", "comparables", "seedEvidence", "quotaEvidence", "pointBudget", "keywordMetricEvidence", "reusableKeywordSnapshot", "reuseEvidenceNote"];
  assertAllowedKeys(value, fields, "serverEvidence");
  return {
    schemaVersion: value.schemaVersion,
    locale: value.locale,
    expiresAt: value.expiresAt,
    frozenSeoRules: sanitizeSeoRules(value.frozenSeoRules),
    frozenComplexityDecision: sanitizeComplexity(value.frozenComplexityDecision),
    healthPolicy: sanitizeHealth(value.healthPolicy),
    productFactTerms: value.productFactTerms.map((item, index) => sanitizeRawTerm(item, `productFactTerms[${index}]`, "target_fact")),
    comparables: value.comparables.map(sanitizeComparable),
    seedEvidence: value.seedEvidence.map((item, index) => sanitizeRawTerm(item, `seedEvidence[${index}]`, "multi_seed")),
    quotaEvidence: sanitizeQuota(value.quotaEvidence),
    pointBudget: sanitizeBudget(value.pointBudget),
    keywordMetricEvidence: sanitizeMetricEvidence(value.keywordMetricEvidence),
    reusableKeywordSnapshot: sanitizeReusableSnapshot(value.reusableKeywordSnapshot),
    reuseEvidenceNote: value.reuseEvidenceNote ?? null
  };
}

function gap(code, field, message) {
  return { code, field, message };
}

function sourceGap(serverEvidence) {
  const invalidTermEvidence = (item) => !nonEmpty(item?.term) || !Array.isArray(item.sourceRefs) ||
    item.sourceRefs.length === 0 || !Array.isArray(item.factRefs) || item.factRefs.length === 0 ||
    !Array.isArray(item.factBindings) || item.factBindings.length === 0;
  if (!isObject(serverEvidence) || serverEvidence.schemaVersion !== C1_KEYWORD_PLANNING_SOURCE_VERSION) {
    return gap("planning_source_evidence_missing", "serverEvidence", "缺少服务端正式关键词准备来源证据");
  }
  if (!nonEmpty(serverEvidence.locale) || !validTime(serverEvidence.expiresAt)) {
    return gap("planning_locale_or_expiry_missing", "serverEvidence", "关键词语言或有效期未冻结");
  }
  if (!isObject(serverEvidence.frozenSeoRules) || !nonEmpty(serverEvidence.frozenSeoRules.rulesVersion) ||
      !nonEmpty(serverEvidence.frozenSeoRules.evidenceRef)) {
    return gap("seo_rules_missing", "serverEvidence.frozenSeoRules", "缺少已冻结SEO规则证据");
  }
  if (!Array.isArray(serverEvidence.productFactTerms) || serverEvidence.productFactTerms.length === 0 ||
      serverEvidence.productFactTerms.some(invalidTermEvidence)) {
    return gap("product_fact_terms_missing", "serverEvidence.productFactTerms", "缺少带事实引用的商品事实词，禁止拆标题或猜词");
  }
  if (!Array.isArray(serverEvidence.comparables) || serverEvidence.comparables.length < 3 || serverEvidence.comparables.length > 5) {
    return gap("valid_competitor_count_invalid", "serverEvidence.comparables", "必须有3至5个已核验同品竞品");
  }
  const competitorIds = serverEvidence.comparables.map((item) => String(item?.seerfarSku ?? "").trim());
  const competitorRefs = serverEvidence.comparables.map((item) => String(item?.competitorRef ?? "").trim());
  if (competitorIds.some((id) => !id) || new Set(competitorIds).size !== competitorIds.length ||
      competitorRefs.some((id) => !id) || new Set(competitorRefs).size !== competitorRefs.length) {
    return gap("competitor_identity_invalid", "serverEvidence.comparables", "竞品Seerfar SKU必须存在且唯一");
  }
  const health = serverEvidence.healthPolicy;
  if (!isObject(health) || !Array.isArray(health.standardSkus) || health.standardSkus.length !== 3) {
    return gap("standard_sku_health_missing", "serverEvidence.healthPolicy", "缺少三条标准SKU健康证明");
  }
  const healthIds = health.standardSkus.map((item) => String(item?.id ?? "").trim());
  if (healthIds.some((id) => !id) || new Set(healthIds).size !== 3 ||
      health.standardSkus.some((item) => item.status !== "passed" || !nonEmpty(item.evidenceRef))) {
    return gap("standard_sku_health_invalid", "serverEvidence.healthPolicy.standardSkus", "三条标准SKU必须唯一且均有成功证据");
  }
  if (!Array.isArray(serverEvidence.seedEvidence) || !isObject(serverEvidence.keywordMetricEvidence)) {
    return gap("keyword_metric_evidence_missing", "serverEvidence.keywordMetricEvidence", "缺少关键词指标证据");
  }
  if (serverEvidence.seedEvidence.some(invalidTermEvidence) ||
      serverEvidence.comparables.some((item) => !Array.isArray(item?.terms) || item.terms.some(invalidTermEvidence))) {
    return gap("keyword_term_evidence_invalid", "serverEvidence", "种子词或竞品词必须是带当前事实绑定的非空文本");
  }
  if (!isObject(serverEvidence.reusableKeywordSnapshot) &&
      (!isObject(serverEvidence.quotaEvidence) || !isObject(serverEvidence.pointBudget))) {
    return gap("paid_lookup_gate_missing", "serverEvidence", "无可复用快照时必须保存实时额度和点数授权");
  }
  return null;
}

function collectConfirmedFacts(plan) {
  const facts = new Map();
  const visit = (value, path) => {
    if (Array.isArray(value)) return value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    if (!isObject(value)) return;
    if (value.verificationStatus === "confirmed" && Array.isArray(value.sourceRefs) && Object.hasOwn(value, "value")) {
      facts.set(path, {
        factPath: path,
        value: value.value,
        factValueFingerprint: digest(value.value),
        sourceRefs: new Set(value.sourceRefs.filter(nonEmpty))
      });
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
  };
  for (const field of [
    "exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot",
    "batteryAssessment", "categoryRestrictions", "platformCompliance"
  ]) visit(plan?.[field], field);
  return facts;
}

function factsBindingGap(serverEvidence, plan) {
  const confirmedFacts = collectConfirmedFacts(plan);
  const terms = [
    ...(serverEvidence.productFactTerms || []).map((item) => ({ ...item, termRequired: true })),
    ...(serverEvidence.seedEvidence || []).map((item) => ({ ...item, termRequired: true })),
    ...(serverEvidence.comparables || []).flatMap((item) => [
      { factRefs: item.factRefs, factBindings: item.factBindings, termRequired: false },
      ...(item.terms || []).map((term) => ({ ...term, termRequired: true }))
    ])
  ];
  const unbound = terms.find((item) => {
    if (!Array.isArray(item?.factRefs) || item.factRefs.length === 0 ||
        !Array.isArray(item.factBindings) || item.factBindings.length === 0) return true;
    const bindingRefs = new Set();
    const normalizedTerm = normalizeSemanticTerm(item.term);
    if (item.termRequired && !normalizedTerm) return true;
    const valid = item.factBindings.every((binding) => {
      if (!isObject(binding) || !nonEmpty(binding.factPath) || !nonEmpty(binding.factValueFingerprint) ||
          !nonEmpty(binding.sourceRef) || binding.bindingRelation !== "exact_value" || binding.semanticProofRef !== null) return false;
      const fact = confirmedFacts.get(binding.factPath);
      if (!fact || fact.factValueFingerprint !== binding.factValueFingerprint || !fact.sourceRefs.has(binding.sourceRef)) return false;
      if (normalizedTerm) {
        if (normalizeSemanticTerm(fact.value) !== normalizedTerm) return false;
      }
      bindingRefs.add(binding.sourceRef);
      return true;
    });
    return !valid || item.factRefs.some((ref) => !bindingRefs.has(ref)) || bindingRefs.size !== new Set(item.factRefs).size;
  });
  return unbound
    ? gap("keyword_fact_binding_missing", "serverEvidence", "关键词或竞品证据没有绑定当前C1已确认商品事实")
    : null;
}

function coreGap(candidate) {
  if (!isObject(candidate) || !nonEmpty(candidate.id) || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("C1_KEYWORD_PLANNING_INPUT_INVALID:candidate");
  }
  const sku = candidate.lifecycleV11?.skuPackage;
  if (!isObject(sku) || !nonEmpty(sku.skuPackageId) || sku.g1Identity?.candidateId !== candidate.id || sku.businessPhase !== "C1") {
    return gap("c1_sku_package_missing", "lifecycleV11.skuPackage", "当前候选没有唯一且处于C1阶段的SKU生命周期包");
  }
  return null;
}

function productionBase({ candidate, skuPackage, sourceRevision, resultRevision, sourceSkuRevision, resultSkuRevision, producedAt, inputFingerprint }) {
  return {
    schemaVersion: C1_KEYWORD_PLANNING_PRODUCTION_VERSION,
    candidateId: candidate.id,
    skuPackageId: skuPackage?.skuPackageId ?? null,
    sourceCandidateRevision: sourceRevision,
    resultCandidateRevision: resultRevision,
    sourceSkuRevision,
    resultSkuRevision,
    factsVerifiedFromFrozenInputs: false,
    inputFingerprint,
    evidenceFingerprint: null,
    status: "not_ready",
    gaps: [],
    producedAt,
    execution: {
      producer: "selection_review_software",
      externalCallsPerformed: 0,
      aiCallsPerformed: 0,
      browserActionsPerformed: 0,
      codexDispatchesPerformed: 0,
      automaticRetries: 0,
      c2Started: false,
      dStarted: false,
      eStarted: false
    }
  };
}

/**
 * 纯领域生产器：只把服务端已保存的正式来源证据冻结成C1关键词准备证据。
 * 它不采集、不调用Seerfar/4318/浏览器，也不持久化或推进C2。
 */
export function produceC1KeywordPlanningEvidence(
  { candidate, expectedRevision, serverEvidence, producedAt },
  { verifyFacts = verifyC1ProductFacts, buildPlan = buildC1KeywordSoftwareJobPlan } = {}
) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !validTime(producedAt)) {
    throw new Error("C1_KEYWORD_PLANNING_INPUT_INVALID:revision_or_time");
  }
  const inputCandidate = structuredClone(candidate);
  const rawEvidence = structuredClone(serverEvidence);
  assertNoSecrets(rawEvidence);
  let inputEvidence = rawEvidence;
  const sourceRevision = inputCandidate?.dataRevision;
  if (sourceRevision !== expectedRevision) throw new Error("C1_KEYWORD_PLANNING_REVISION_CONFLICT");
  const initialSku = inputCandidate?.lifecycleV11?.skuPackage;
  const sourceSkuRevision = initialSku?.dataRevision ?? null;
  const inputFingerprint = digest({ candidate: inputCandidate, serverEvidence: inputEvidence, producedAt });
  const base = productionBase({
    candidate: inputCandidate,
    skuPackage: initialSku,
    sourceRevision,
    resultRevision: sourceRevision + 1,
    sourceSkuRevision,
    resultSkuRevision: sourceSkuRevision,
    producedAt,
    inputFingerprint
  });
  const candidateGap = coreGap(inputCandidate);
  if (candidateGap) return freeze({ status: "not_ready", candidate: inputCandidate, skuPackage: initialSku ?? null, evidence: null, production: { ...base, gaps: [candidateGap] } });

  let skuPackage = structuredClone(initialSku);
  const rights = resolveC1SkuRightsReviewForFacts({ skuPackage, observedAt: producedAt });
  if (rights.status !== "verified") {
    return freeze({ status: "not_ready", candidate: inputCandidate, skuPackage, evidence: null,
      production: { ...base, gaps: [gap(rights.code, "skuPackage.c1RightsReviewRecord", "当前SKU权利声明尚未满足事实冻结条件")] } });
  }
  if (skuPackage.c1ProductPlan?.status === "inputs_ready") {
    skuPackage = structuredClone(verifyFacts({ skuPackage, skuRightsReview: rights.review, verifiedAt: producedAt }).skuPackage);
  }
  if (!['facts_checked', 'seo_draft_ready'].includes(skuPackage.c1ProductPlan?.status)) {
    const factGap = gap("c1_facts_not_checked", "skuPackage.c1ProductPlan.status", "C1商品事实尚未完成核验");
    return freeze({ status: "not_ready", candidate: inputCandidate, skuPackage, evidence: null, production: { ...base, resultSkuRevision: skuPackage.dataRevision, factsVerifiedFromFrozenInputs: skuPackage.dataRevision !== sourceSkuRevision, gaps: [factGap] } });
  }

  const missing = sourceGap(inputEvidence);
  if (missing) return freeze({ status: "not_ready", candidate: inputCandidate, skuPackage, evidence: null, production: { ...base, resultSkuRevision: skuPackage.dataRevision, factsVerifiedFromFrozenInputs: skuPackage.dataRevision !== sourceSkuRevision, gaps: [missing] } });
  inputEvidence = sanitizeSourceEvidence(inputEvidence);

  const plan = skuPackage.c1ProductPlan;
  const salesSnapshot = plan.inputSnapshots.salesSnapshot;
  const supplySnapshot = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  const salesSnapshotVersion = nonEmpty(salesSnapshot.version) ? salesSnapshot.version
    : nonEmpty(salesSnapshot.schemaVersion) ? salesSnapshot.schemaVersion : null;
  const supplySnapshotVersion = nonEmpty(supplySnapshot.version) ? supplySnapshot.version
    : nonEmpty(supplySnapshot.schemaVersion) ? supplySnapshot.schemaVersion : "c1-confirmed-supplier-sku-snapshot-v1";
  if (salesSnapshotVersion === null) {
    return freeze({ status: "not_ready", candidate: inputCandidate, skuPackage, evidence: null,
      production: { ...base, resultSkuRevision: skuPackage.dataRevision,
        factsVerifiedFromFrozenInputs: skuPackage.dataRevision !== sourceSkuRevision,
        gaps: [gap("sales_snapshot_version_missing", "c1ProductPlan.inputSnapshots.salesSnapshot",
          "冻结销售快照缺少有效版本，不能生成关键词准备证据")] } });
  }
  const bindingGap = factsBindingGap(inputEvidence, plan);
  if (bindingGap) {
    return freeze({
      status: "not_ready",
      candidate: inputCandidate,
      skuPackage,
      evidence: null,
      production: {
        ...base,
        resultSkuRevision: skuPackage.dataRevision,
        factsVerifiedFromFrozenInputs: skuPackage.dataRevision !== sourceSkuRevision,
        gaps: [bindingGap]
      }
    });
  }
  const evidence = {
    schemaVersion: C1_KEYWORD_PLANNING_EVIDENCE_VERSION,
    binding: {
      candidateId: inputCandidate.id,
      skuPackageId: skuPackage.skuPackageId,
      sourceCandidateRevision: sourceRevision,
      candidateRevision: sourceRevision + 1,
      resultCandidateRevision: sourceRevision + 1,
      skuRevision: skuPackage.dataRevision,
      sourceSkuRevision,
      resultSkuRevision: skuPackage.dataRevision,
      platform: plan.identity.targetPlatform,
      exactSupplierSkuId: plan.identity.supplierSkuId,
      fulfillment: resolveFrozenFulfillmentMode(skuPackage, plan.inputSnapshots.profitModel),
      profitModelVersion: plan.inputSnapshots.profitModel.profitModelVersion,
      profitModelFingerprint: digest(plan.inputSnapshots.profitModel),
      salesSnapshotId: plan.inputRefs.salesSnapshotId,
      salesSnapshotVersion,
      salesSnapshotFingerprint: digest(plan.inputSnapshots.salesSnapshot),
      supplySnapshotId: plan.inputRefs.selectedSupplySnapshotId,
      supplySnapshotVersion,
      supplySnapshotFingerprint: digest(plan.inputSnapshots.confirmedSupplierSkuSnapshot),
      c1FactsFingerprint: digest({
        exactSkuVerification: plan.exactSkuVerification,
        productAttributes: plan.productAttributes,
        platformCategory: plan.platformCategory,
        schemaSnapshot: plan.schemaSnapshot,
        batteryAssessment: plan.batteryAssessment,
        categoryRestrictions: plan.categoryRestrictions,
        platformCompliance: plan.platformCompliance
      })
    },
    locale: inputEvidence.locale,
    expiresAt: inputEvidence.expiresAt,
    frozenSeoRules: inputEvidence.frozenSeoRules,
    frozenComplexityDecision: inputEvidence.frozenComplexityDecision,
    healthPolicy: inputEvidence.healthPolicy,
    productFactTerms: inputEvidence.productFactTerms,
    comparables: inputEvidence.comparables,
    seedEvidence: inputEvidence.seedEvidence,
    quotaEvidence: inputEvidence.quotaEvidence,
    pointBudget: inputEvidence.pointBudget,
    keywordMetricEvidence: inputEvidence.keywordMetricEvidence,
    reusableKeywordSnapshot: inputEvidence.reusableKeywordSnapshot,
    reuseEvidenceNote: inputEvidence.reuseEvidenceNote ?? null
  };
  assertNoSecrets(evidence, "planningEvidence");

  const stagedCandidate = structuredClone(inputCandidate);
  stagedCandidate.dataRevision = sourceRevision + 1;
  stagedCandidate.lifecycleV11.skuPackage = structuredClone(skuPackage);
  stagedCandidate.lifecycleV11.c1KeywordPlanningEvidenceV1 = structuredClone(evidence);
  const validationPlan = buildPlan({
    candidate: stagedCandidate,
    expectedRevision: sourceRevision + 1,
    plannedAt: producedAt
  });
  if (!VALID_RESULT.has(validationPlan.status)) throw new Error("C1_KEYWORD_PLANNING_PLAN_VALIDATION_INVALID");
  if (validationPlan.status !== "ready" && validationPlan.status !== "reuse_ready") {
    const status = validationPlan.status === "blocked" ? "blocked" : "not_ready";
    return freeze({
      status,
      candidate: inputCandidate,
      skuPackage,
      evidence: null,
      production: { ...base, status, resultSkuRevision: skuPackage.dataRevision, factsVerifiedFromFrozenInputs: skuPackage.dataRevision !== sourceSkuRevision, gaps: structuredClone(validationPlan.gaps) }
    });
  }

  const evidenceFingerprint = digest(evidence);
  const production = {
    ...base,
    status: "ready",
    resultSkuRevision: skuPackage.dataRevision,
    factsVerifiedFromFrozenInputs: skuPackage.dataRevision !== sourceSkuRevision,
    evidenceFingerprint,
    gaps: []
  };
  return freeze({ status: "ready", candidate: inputCandidate, skuPackage, evidence, production });
}
