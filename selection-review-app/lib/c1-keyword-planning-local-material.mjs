import { createHash } from "node:crypto";

import { validateKeywordEvidenceSnapshot } from "./keyword-evidence-snapshot.mjs";
import { validateC1ProductPlan, verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { resolveC1SkuRightsReviewForFacts } from "./c1-sku-rights-review.mjs";
import {
  fingerprintC1SalesSnapshot,
  fingerprintC1VerifiedFacts,
  projectC1ConfirmedFacts,
  projectC1CompetitorTextSnapshot
} from "./c1-software-input-preparation.mjs";

export const C1_KEYWORD_PLANNING_LOCAL_MATERIAL_VERSION = "c1-keyword-planning-local-material-v1";
export const C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION = "c1-keyword-planning-local-material-production-v1";
export const C1_LOCAL_PREPARATION_VERSION = "c1-local-preparation-v2";

// This policy classifies existing Ozon fields; it does not translate or invent
// product claims. Brand names, model codes and technical status are not SEO terms.
const OZON_KEYWORD_PURPOSES = Object.freeze({
  "8229": ["title", "description"],
  "4958": ["attributes", "description"],
  "4967": ["attributes", "description"],
  "5954": ["description"],
  "10096": ["attributes", "description"]
});

const SECRET_KEY = /(?:token|cookie|password|secret|authorization|api[_-]?key|bearer|headers?)/i;
const SECRET_VALUE = /(?:authorization|bearer|cookie|password|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*(?:=|:)/i;
const CREDENTIAL_QUERY = /[?&](?:key|token|secret|signature|password)=/i;

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0 && value !== "unknown"; }
function iso(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}
function gap(code, field, message) { return { code, field, message }; }

/**
 * 名字撞上密钥规则、但能**当场证明不是密钥**的那一种字段。
 *
 * 唯一的例子是 `categoryToken`：它的值就是「平台:类目ID:类型ID」拼出来的公开类目作用域串，
 * 而拼它的两个数字就明文躺在同一个对象里（descriptionCategoryId / typeId）。
 * 2026-09-17 实测：主人签完声明后整条 C1 准备链被这一条误报挡死。
 *
 * 放行的依据不是「这个字段名我保证没问题」——那就是给规矩开口子了。
 * 依据是**值本身可被验证**：必须恰好等于同层那两个明文数字拼出来的串，差一个字符就照旧拒绝。
 * 证明不了的一律当密钥处理。
 */
function provenPublicCategoryRef(key, value, parent) {
  if (key !== "categoryToken" || typeof value !== "string") return false;
  const id = parent?.descriptionCategoryId;
  const type = parent?.typeId;
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(type) || id <= 0 || type <= 0) return false;
  return value === `ozon:${id}:${type}`;
}

function assertNoSecrets(value, path = "candidate", depth = 0) {
  if (depth > 16) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_DEPTH_EXCEEDED:${path}`);
  if (typeof value === "string") {
    if (value.length > 20_000) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_TEXT_LIMIT_EXCEEDED:${path}`);
    if (SECRET_VALUE.test(value) || CREDENTIAL_QUERY.test(value)) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_SECRET_FORBIDDEN:${path}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_ARRAY_LIMIT_EXCEEDED:${path}`);
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key.replace(/[^a-z0-9_-]/gi, "")) && !provenPublicCategoryRef(key, child, value)) {
      throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_SECRET_FORBIDDEN:${path}.${key}`);
    }
    assertNoSecrets(child, `${path}.${key}`, depth + 1);
  }
}

function exactLiteralTerms(facts) {
  const seen = new Set();
  const terms = [];
  for (const fact of facts) {
    if (!nonEmpty(fact.value)) continue;
    const normalized = fact.value.normalize("NFKC").trim().replace(/\s+/g, " ");
    const key = normalized.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({
      term: normalized,
      sourceRefs: structuredClone(fact.sourceRefs),
      factRefs: structuredClone(fact.sourceRefs),
      factBindings: [{
        factPath: fact.factPath,
        factValueFingerprint: fact.valueFingerprint,
        sourceRef: fact.sourceRefs[0],
        bindingRelation: "exact_value",
        semanticProofRef: null
      }],
      sourceTrust: "confirmed_c1_fact",
      matchType: "target_fact"
    });
  }
  return terms;
}

function opportunityFor(candidate, plan) {
  const opportunity = candidate.lifecycleV11?.opportunityPackage;
  if (!isObject(opportunity) || opportunity.parentOpportunityId !== plan.identity.parentOpportunityId ||
      !Array.isArray(opportunity.salesSnapshots) || !isObject(opportunity.marketAssessment)) return null;
  return opportunity;
}

function comparableTexts(candidate, plan) {
  const opportunity = opportunityFor(candidate, plan);
  if (!opportunity) return { comparables: [], gaps: [gap("opportunity_market_evidence_missing", "lifecycleV11.opportunityPackage", "缺少当前C1绑定的A阶段市场证据")] };
  const primaryIds = opportunity.marketAssessment.primarySampleIds;
  if (!Array.isArray(primaryIds) || primaryIds.length < 3 || primaryIds.length > 5) {
    return { comparables: [], gaps: [gap("comparable_count_invalid", "lifecycleV11.opportunityPackage.marketAssessment.primarySampleIds", "本地原料要求3至5个已审查主要竞品")] };
  }
  const summaries = new Map((opportunity.marketAssessment.sampleSummaries || []).map((item) => [item.snapshotId, item]));
  const comparables = [];
  for (const snapshotId of primaryIds) {
    const summary = summaries.get(snapshotId);
    const snapshot = opportunity.salesSnapshots.find((item) => item.snapshotId === snapshotId);
    if (!isObject(summary) || summary.role !== "primary" || summary.comparability !== "comparable" ||
        summary.priceEvidenceStatus !== "verified" || summary.validityStatus !== "current" ||
        summary.evidenceTraceable !== true || summary.sellerType === "local_ru" || !isObject(snapshot) ||
        !nonEmpty(snapshot.title) || !nonEmpty(snapshot.evidenceRef) || !iso(snapshot.collectedAt)) {
      return { comparables: [], gaps: [gap("comparable_evidence_invalid", `salesSnapshots.${snapshotId}`, "竞品未通过A阶段可比性、价格、时效或可追溯性门禁")] };
    }
    // 这是一份**投影**：把同一个 C1 计划的销售快照换成这个竞品，只为了从它的标题和属性里取买家用语。
    // frozenInputRefs.salesSnapshotId 必须跟着一起换——projectC1CompetitorTextSnapshot 第一行就是
    // assertValidC1ProductPlan，而那道校验要求 frozen 与 inputRefs 指向同一个快照。只换一半，
    // 投影计划自己就不自洽，任何竞品都会被判成 frozenInputRefs 不一致（2026-09-17 实测：
    // 这条路从来没有跑过带竞品的情形，一跑就撞这里）。
    // 一起换才是对的：保住「frozen 与 inputRefs 必须一致」这条不变量，而不是为了投影把它削弱掉。
    const projectedPlan = {
      ...structuredClone(plan),
      inputRefs: { ...structuredClone(plan.inputRefs), salesSnapshotId: snapshotId },
      frozenInputRefs: { ...structuredClone(plan.frozenInputRefs), salesSnapshotId: snapshotId },
      inputSnapshots: { ...structuredClone(plan.inputSnapshots), salesSnapshot: structuredClone(snapshot) }
    };
    const textSnapshot = projectC1CompetitorTextSnapshot(projectedPlan);
    comparables.push({
      competitorRef: snapshot.evidenceRef,
      salesSnapshotId: snapshot.snapshotId,
      platform: snapshot.platform,
      sellerType: snapshot.sellerType,
      comparabilityStatus: "proven",
      role: "buyer_language_reference_only",
      textSnapshot
    });
  }
  if (new Set(comparables.map((item) => item.salesSnapshotId)).size !== comparables.length) {
    return { comparables: [], gaps: [gap("duplicate_comparable", "salesSnapshots", "竞品销售快照不得重复")] };
  }
  return { comparables, gaps: [] };
}

function reusableSnapshot(candidate, plan, sku, producedAt) {
  const snapshot = candidate.lifecycleV11?.k3KeywordEvidenceSnapshotV1 ??
    candidate.lifecycleV11?.c1SoftwareEvidenceV1?.k3KeywordEvidenceSnapshot ?? null;
  const binding = candidate.lifecycleV11?.k3CurrentBindingV1 ??
    candidate.lifecycleV11?.c1SoftwareEvidenceV1?.k3CurrentBinding ?? null;
  if (snapshot === null) return { status: "not_available", snapshot: null, gap: gap("reusable_keyword_snapshot_missing", "lifecycleV11.k3KeywordEvidenceSnapshotV1", "缺少已保存的可复用关键词快照") };
  if (!isObject(binding)) return { status: "invalid", snapshot: null, gap: gap("reusable_keyword_binding_missing", "lifecycleV11.k3CurrentBindingV1", "可复用关键词快照缺少当前绑定") };
  const expected = {
    candidateId: candidate.id,
    parentOpportunityId: plan.identity.parentOpportunityId,
    skuPackageId: sku.skuPackageId,
    dataRevision: sku.dataRevision,
    salesSnapshotVersion: binding.salesSnapshotVersion,
    salesSnapshotFingerprint: binding.salesSnapshotFingerprint,
    supplySkuFactsVersion: binding.supplySkuFactsVersion,
    supplySkuFactsFingerprint: binding.supplySkuFactsFingerprint
  };
  const validation = validateKeywordEvidenceSnapshot(snapshot, { currentBinding: expected, asOf: producedAt });
  if (!validation.valid || snapshot.status !== "ready") {
    return { status: "invalid", snapshot: null, gap: gap("reusable_keyword_snapshot_invalid", "lifecycleV11.k3KeywordEvidenceSnapshotV1", "关键词快照已过期、漂移或状态不是ready") };
  }
  return { status: "reused", snapshot: structuredClone(snapshot), gap: null };
}

export function produceC1KeywordPlanningLocalMaterial({ candidate, expectedRevision, producedAt }) {
  if (!isObject(candidate) || !nonEmpty(candidate.id) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      candidate.dataRevision !== expectedRevision || !iso(producedAt)) throw new Error("C1_KEYWORD_LOCAL_MATERIAL_INPUT_INVALID");
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  const planValidation = isObject(plan) ? validateC1ProductPlan(plan) : { valid: false };
  if (!isObject(sku) || sku.businessPhase !== "C1" || !isObject(plan) || plan.status !== "facts_checked" || !planValidation.valid) {
    const production = {
      schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION,
      candidateId: candidate.id,
      skuPackageId: sku?.skuPackageId ?? null,
      sourceCandidateRevision: expectedRevision,
      resultCandidateRevision: expectedRevision + 1,
      status: "not_ready",
      inputFingerprint: digest({ candidateId: candidate.id, skuPackageId: sku?.skuPackageId ?? null, c1Plan: plan ?? null }),
      materialFingerprint: null,
      gaps: [gap("c1_facts_not_ready", "lifecycleV11.skuPackage.c1ProductPlan", "C1事实核验尚未完成")],
      producedAt,
      execution: { attemptLimit: 1, externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0, automaticRetries: 0 }
    };
    return freeze({ status: "not_ready", material: null, production });
  }

  assertNoSecrets({
    c1ProductPlan: plan,
    opportunityPackage: candidate.lifecycleV11?.opportunityPackage ?? null,
    reusableKeywordSnapshot: candidate.lifecycleV11?.k3KeywordEvidenceSnapshotV1 ?? candidate.lifecycleV11?.c1SoftwareEvidenceV1?.k3KeywordEvidenceSnapshot ?? null
  });

  const facts = projectC1ConfirmedFacts(plan);
  const terms = exactLiteralTerms(facts);
  const comparableResult = comparableTexts(candidate, plan);
  const reusable = reusableSnapshot(candidate, plan, sku, producedAt);
  const sales = plan.inputSnapshots.salesSnapshot;
  const supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  const gaps = [...comparableResult.gaps];
  if (terms.length === 0) gaps.push(gap("exact_literal_fact_terms_missing", "c1ProductPlan", "没有可安全复用的已确认字符串事实词"));
  if (reusable.gap) gaps.push(reusable.gap);
  const inputFingerprint = digest({
    candidateId: candidate.id,
    skuPackageId: sku.skuPackageId,
    skuRevision: sku.dataRevision,
    c1PlanId: plan.c1PlanId,
    factsFingerprint: fingerprintC1VerifiedFacts(plan),
    salesFingerprint: fingerprintC1SalesSnapshot(sales),
    supply,
    comparables: comparableResult.comparables,
    reusableSnapshotFingerprint: reusable.snapshot?.snapshotFingerprint ?? null
  });
  const material = gaps.length === 0 ? {
    schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_VERSION,
    candidateId: candidate.id,
    sourceCandidateRevision: expectedRevision,
    resultCandidateRevision: expectedRevision + 1,
    skuPackageId: sku.skuPackageId,
    supplierSkuId: sku.supplierSkuId,
    sourceSkuRevision: sku.dataRevision,
    resultSkuRevision: sku.dataRevision,
    c1PlanId: plan.c1PlanId,
    producedAt,
    bindings: {
      factsFingerprint: fingerprintC1VerifiedFacts(plan),
      salesSnapshotId: sales.snapshotId,
      salesSnapshotFingerprint: fingerprintC1SalesSnapshot(sales),
      supplySnapshotId: supply.snapshotId ?? plan.inputRefs.selectedSupplySnapshotId,
      supplySnapshotFingerprint: digest(supply),
      targetPlatform: plan.identity.targetPlatform,
      targetStore: plan.identity.targetStore
    },
    confirmedFactCatalog: structuredClone(facts),
    exactLiteralFactTerms: terms,
    competitorTextSnapshots: comparableResult.comparables,
    reusableKeywordSnapshot: reusable.snapshot,
    sourceRefs: [...new Set([
      ...facts.flatMap((item) => item.sourceRefs),
      ...comparableResult.comparables.map((item) => item.competitorRef),
      reusable.snapshot.snapshotId
    ])]
  } : null;
  if (material) material.materialFingerprint = digest(material);
  const production = {
    schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION,
    candidateId: candidate.id,
    skuPackageId: sku.skuPackageId,
    sourceCandidateRevision: expectedRevision,
    resultCandidateRevision: expectedRevision + 1,
    status: material ? "ready" : "not_ready",
    inputFingerprint,
    materialFingerprint: material?.materialFingerprint ?? null,
    gaps,
    producedAt,
    execution: { attemptLimit: 1, externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0, automaticRetries: 0 }
  };
  return freeze({ status: production.status, material, production });
}

/** Local review material only. Project facts without freezing the editable C1
 * plan: preparing words must not silently lock the owner's attribute editor. */
export function produceC1LocalPreparation({ candidate, expectedRevision, producedAt }) {
  if (!isObject(candidate) || candidate.dataRevision !== expectedRevision || !iso(producedAt)) {
    throw new Error("C1_LOCAL_PREPARATION_INPUT_INVALID");
  }
  const sku = candidate.lifecycleV11?.skuPackage;
  const sourcePlan = sku?.c1ProductPlan;
  if (sku?.businessPhase !== "C1" || sku.targetPlatform !== "ozon" ||
      !["inputs_ready", "facts_checked"].includes(sourcePlan?.status)) {
    throw new Error("C1_LOCAL_PREPARATION_PHASE_REJECTED");
  }
  if (sku.g1Identity?.candidateId !== candidate.id || sourcePlan.identity.skuPackageId !== sku.skuPackageId ||
      sourcePlan.identity.supplierSkuId !== sku.supplierSkuId || sourcePlan.identity.targetStore !== sku.targetStore ||
      !validateC1ProductPlan(sourcePlan).valid) throw new Error("C1_LOCAL_PREPARATION_IDENTITY_INVALID");
  const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt: producedAt });
  const gaps = [];
  let plan = sourcePlan;
  if (rights.status !== "verified") {
    gaps.push(gap(rights.code, "skuRightsReview", "当前已保存的权利声明无法用于这份准备材料，请核对其有效性"));
  } else if (sourcePlan.status === "inputs_ready") {
    plan = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights.review, verifiedAt: producedAt }).c1ProductPlan;
  }
  const schema = sourcePlan.inputSnapshots.platformSchemaRules;
  const choice = candidate.sourceCapture?.skuChoices?.find(item => String(item.sourceSkuId) === sku.supplierSkuId);
  const variantAttributes = isObject(choice?.attributes) ? structuredClone(choice.attributes) : {};
  const mappings = sku.ozonAttributeMappingsV1?.mappings ?? [];
  const projected = new Map((plan.productAttributes?.ozonAttributes ?? []).map(item => [item.fieldKey, item]));
  const requiredFacts = new Map((plan.productAttributes?.requiredPlatformFields ?? []).map(item => [String(item.fieldKey), item.fact]));
  const attributes = (schema.attributes ?? []).map(attribute => {
    const fieldKey = String(attribute.fieldKey);
    const mapping = mappings.find(item => String(item.attributeId) === fieldKey);
    const fact = projected.get(fieldKey)?.fact;
    const requiredFact = requiredFacts.get(fieldKey);
    if (!mapping && requiredFact?.verificationStatus === "confirmed") {
      const raw = requiredFact.value;
      const value = isObject(raw) && Object.hasOwn(raw, "value") ? raw.value : raw;
      const dictionaryPending = attribute.dictionaryId > 0 &&
        !(Number.isInteger(raw?.dictionaryValueId) && raw.dictionaryValueId > 0);
      // A valid dictionary value proves wording, not which supplier variant it
      // describes. Without a mapping, there is no source path for a scope review.
      const colourScopeUnverified = fieldKey === "10096" &&
        (!nonEmpty(value) || value !== variantAttributes["颜色"]);
      return { fieldKey, label: attribute.labelZh || attribute.label || fieldKey,
        required: attribute.required === true, value, sourceValue: raw,
        sourceScope: fieldKey === "85" ? "sku" : "supplier_product",
        sourceRefs: [...requiredFact.sourceRefs], status: colourScopeUnverified ? "needs_review"
          : dictionaryPending ? "dictionary_pending" : "confirmed" };
    }
    const sourceScope = mapping?.sourceFactPath?.startsWith("productAttributes.supplierAttributes.")
      ? "supplier_product" : mapping?.sourceFactPath?.startsWith("platformCategory.") ? "category" : "sku";
    // The offer's list of available colours is neither a single SKU colour nor
    // proof of a multicolour bundle. Preserve the saved mapping without adopting it.
    const variantUnresolved = fieldKey === "10096" && mapping && sourceScope === "supplier_product" &&
      mapping.sourceFactValue !== variantAttributes["颜色"];
    return {
      fieldKey, label: attribute.labelZh || attribute.label || fieldKey,
      required: attribute.required === true,
      value: mapping?.value ?? null,
      sourceValue: mapping?.sourceFactValue ?? null,
      sourceScope,
      sourceRefs: mapping ? [mapping.dictionaryEvidenceRef, sku.ozonAttributeMappingsV1.confirmationRef].filter(nonEmpty) : [],
      status: !mapping ? "not_supplied" : variantUnresolved ? "scope_unresolved"
        : fact?.verificationStatus === "confirmed" ? "confirmed" : "needs_review"
    };
  });
  const keywords = [];
  const seen = new Set();
  for (const attribute of attributes) {
    const purposes = OZON_KEYWORD_PURPOSES[attribute.fieldKey];
    if (!mappings.some(item => String(item.attributeId) === attribute.fieldKey) || !purposes || attribute.status !== "confirmed" || !nonEmpty(attribute.value) || !/[А-Яа-яЁё]/u.test(attribute.value)) continue;
    const normalized = attribute.value.normalize("NFKC").trim().toLocaleLowerCase("ru");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keywords.push({ term: attribute.value, purposes: [...purposes], sourceRefs: attribute.sourceRefs,
      factPath: `productAttributes.ozonAttributes.${plan.productAttributes.ozonAttributes.findIndex(item => item.fieldKey === attribute.fieldKey)}.fact`,
      evidenceKind: "owner_confirmed_attribute", searchVolume: null, conversion: null,
      wordingStatus: "existing_platform_wording" });
  }
  if (!keywords.some(item => item.purposes.includes("title"))) {
    gaps.push(gap("title_keyword_missing", "keywords", "还没有可用于标题的已确认商品类型词；不会拿材质或内部货号凑标题"));
  }
  for (const attribute of attributes.filter(item => item.required && item.status !== "confirmed")) {
    gaps.push(attribute.status === "dictionary_pending"
      ? gap("required_dictionary_value_missing", attribute.fieldKey, `必填属性「${attribute.label}」事实已确认，仍需补平台字典编号`)
      : gap("required_attribute_missing", attribute.fieldKey, `必填属性「${attribute.label}」仍需核对`));
  }
  const comparables = [];
  const seenSnapshots = new Set();
  for (const snapshot of [...(candidate.lifecycleV11?.opportunityPackage?.salesSnapshots ?? []), ...(candidate.salesSnapshotsV11 ?? [])]) {
    if (seenSnapshots.has(snapshot.snapshotId) || comparables.length >= 10) continue;
    if (snapshot.platform !== sku.targetPlatform || !nonEmpty(snapshot.snapshotId) || !nonEmpty(snapshot.title) ||
        !nonEmpty(snapshot.evidenceRef) || !iso(snapshot.collectedAt)) continue;
    seenSnapshots.add(snapshot.snapshotId);
    comparables.push({ snapshotId: snapshot.snapshotId, title: snapshot.title, collectedAt: snapshot.collectedAt,
      sourceRef: snapshot.evidenceRef, role: "buyer_language_reference_only", adoptedAsProductFact: false });
  }
  const existing = reusableSnapshot(candidate, plan, sku, producedAt);
  if (existing.status === "invalid") gaps.push(existing.gap);
  const inputFingerprint = digest({ version: C1_LOCAL_PREPARATION_VERSION, mode: "saved_material_only",
    skuPackage: sku, variantAttributes, comparables, rightsStatus: rights.status, reusableStatus: existing.status });
  const material = {
    schemaVersion: C1_LOCAL_PREPARATION_VERSION, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    supplierSkuId: sku.supplierSkuId, variantKey: sku.variantKey, variantAttributes,
    sourceCandidateRevision: expectedRevision, resultCandidateRevision: expectedRevision + 1,
    sourceSkuRevision: sku.dataRevision, targetPlatform: sku.targetPlatform, targetStore: sku.targetStore,
    mode: "saved_material_only", attributes, keywords, competitorTextSnapshots: comparables,
    reusableKeywordSnapshot: existing.snapshot,
    quantityPolicy: { titleMinimum: 1, tagMinimum: 0, longTailMinimum: 0, fixedTotal: null },
    writingRules: ["商品类型词自然放入标题，不堆同义词", "属性和长尾仅在事实适用的位置使用，不要求三组齐全",
      "对标只提供买家措辞，不证明本品功能、尺寸或适用对象", "没有搜索量或转化证据时保持未知，不标成Seerfar验证词"],
    skillRef: "optimize-ecommerce-seo", preparationOnly: true,
    status: gaps.length === 0 ? "ready_for_review" : "needs_information", gaps, producedAt
  };
  assertNoSecrets(material, "localPreparation");
  material.materialFingerprint = digest(material);
  const production = {
    schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION, candidateId: candidate.id,
    skuPackageId: sku.skuPackageId, sourceCandidateRevision: expectedRevision, resultCandidateRevision: expectedRevision + 1,
    status: gaps.length === 0 ? "ready" : "not_ready", inputFingerprint,
    materialFingerprint: material.materialFingerprint, gaps, producedAt,
    execution: { attemptLimit: 1, externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0, automaticRetries: 0 }
  };
  return freeze({ status: production.status, material, production });
}
