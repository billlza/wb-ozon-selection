// This fixture preserves the historical three-group scoring contract.
const KEYWORD_SCORING_VERSION = "keyword-scoring-v1";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { adaptK3KeywordEvidenceForC1 } from "../lib/c1-k3-keyword-adapter.mjs";
import { buildC1AiDraftRequest, mergeC1AiDraftReceipt, validateC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { receipt as receiptFixture, authorizedExecution, settledExecution } from "./fixtures/c1-ai-draft-fixture.mjs";
import {
  fingerprintC1SalesSnapshot,
  prepareC1SoftwareInputs
} from "../lib/c1-software-input-preparation.mjs";
import { createKeywordEvidenceSnapshot } from "../lib/keyword-evidence-snapshot.mjs";
import { KEYWORD_SCORING_COMPONENTS } from "../lib/keyword-evidence-scoring.mjs";

const NOW = "2026-08-23T08:00:00.000Z";
const EXPIRES = "2026-08-24T08:00:00.000Z";
const SALES_ID = "sales:NON-TRAIN-SHELF:11";
const SALES_REF = "evidence:sales:NON-TRAIN-SHELF:11";
const SUPPLY_REF = "evidence:supply:NON-TRAIN-SHELF:WHITE";
const SCHEMA_REF = "evidence:schema:ozon:bathroom-shelf";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function fact(value, sourceRefs = [SUPPLY_REF]) { return { value, verificationStatus: "confirmed", sourceRefs }; }

function skuPackage() {
  const salesSnapshot = {
    snapshotId: SALES_ID,
    version: "sales-v3",
    fingerprint: "sales-binding-fp-11",
    title: "Полка для ванной комнаты без сверления",
    attributes: { material: "пластик", color: "белый" },
    collectedAt: NOW,
    evidenceRef: SALES_REF
  };
  const supplierSnapshot = {
    snapshotId: SUPPLY_REF,
    version: "supply-facts-v2",
    fingerprint: "supply-binding-fp-11"
  };
  const plan = {
    schemaVersion: "c1-product-plan-v1.1",
    c1PlanId: "c1:sku-lifecycle:NON-TRAIN-SHELF:SHELF-WHITE:profit-v3",
    status: "facts_checked",
    createdAt: NOW,
    inputRefs: {
      salesSnapshotId: SALES_ID,
      selectedSupplySnapshotId: SUPPLY_REF,
      profitModelVersion: "profit-v3",
      platformSchemaEvidenceId: SCHEMA_REF
    },
    identity: {
      parentOpportunityId: "opportunity:NON-TRAIN-SHELF",
      skuPackageId: "sku-lifecycle:NON-TRAIN-SHELF:SHELF-WHITE",
      supplierOptionId: "supplier-option:NON-TRAIN-SHELF",
      supplierSkuId: "SHELF-WHITE",
      variantKey: "颜色:白色",
      targetPlatform: "ozon",
      targetStore: "dandanshu"
    },
    inputSnapshots: {
      salesSnapshot,
      confirmedSupplierSkuSnapshot: supplierSnapshot,
      profitModel: { profitModelVersion: "profit-v3", result: "passed" },
      platformSchemaRules: {
        evidenceId: SCHEMA_REF,
        platform: "ozon",
        store: "dandanshu",
        schemaRevision: "ozon:bathroom-shelf:2026-08-23",
        requiredFields: [],
        collectedAt: NOW
      }
    },
    externalAccesses: [], profitRecalculated: false, skuReplaced: false,
    finalSeo: null, finalAttributes: null, complianceDecision: null, generatedAssets: null, productionPayload: null,
    factVerificationVersion: "c1-fact-verification-v1.1", factsVerifiedAt: NOW,
    exactSkuVerification: { status: fact("verified"), supplierSkuId: fact("SHELF-WHITE"), variantKey: fact("颜色:白色") },
    productAttributes: { status: fact("all_required_fields_known", [SUPPLY_REF, SCHEMA_REF]), material: fact("plastic"), color: fact("white") },
    platformCategory: { status: fact("identified", [SCHEMA_REF]), categoryName: fact("Полки для ванной", [SCHEMA_REF]), descriptionCategoryId: fact("17033001", [SCHEMA_REF]), typeId: fact("94001", [SCHEMA_REF]) },
    schemaSnapshot: { status: fact("frozen", [SCHEMA_REF]), schemaRevision: fact("ozon:bathroom-shelf:2026-08-23", [SCHEMA_REF]), requiredFields: fact([], [SCHEMA_REF]) },
    batteryAssessment: { status: fact("fact_available"), assessment: fact("no_battery"), powered: fact(false), containsBattery: fact(false) },
    categoryRestrictions: { status: fact("known", [SCHEMA_REF]), restrictions: fact([], [SCHEMA_REF]) },
    platformCompliance: { status: fact("known", [SCHEMA_REF]), assessment: fact({ status: "clear" }, [SCHEMA_REF]), requiredFieldGapCount: fact(0, [SCHEMA_REF]) },
    seoTitleDraft: null, descriptionDraft: null, bulletPointsDraft: null, searchKeywordsDraft: null, seoEvidenceLayer: null
  };
  return {
    schemaVersion: "sku-lifecycle-v1.1",
    g1Identity: {
      schemaVersion: "g1-identity-v1", candidateId: "NON-TRAIN-SHELF", skuPackageId: plan.identity.skuPackageId,
      platform: "ozon", storeRef: { stableStoreId: "dandanshu", platformStoreId: "synthetic-seller-001", mappingVersion: "synthetic-v1" },
      supplierSkuId: "SHELF-WHITE", merchantSku: "not_applicable", warehouseRef: "not_applicable",
      credentialAlias: "not_applicable", platformProductId: "not_applicable"
    },
    skuPackageId: plan.identity.skuPackageId,
    supplierSkuId: plan.identity.supplierSkuId,
    variantKey: plan.identity.variantKey,
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    businessPhase: "C1",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "none",
    dataRevision: 11,
    c1ProductPlan: plan
  };
}

function formalSkuPackage() {
  return createFormalC1DraftFixture({ at: NOW, candidateId: "NON-TRAIN-SHELF", supplierSkuId: "SHELF-WHITE",
    variantKey: "颜色:白色", productName: "Полка для ванной комнаты без сверления", material: "plastic",
    categoryName: "Полки для ванной", categoryPath: "Дом / Полки", salesSnapshotVersion: "sales-snapshot-v1.1",
    salesAttributes: { material: "пластик", color: "белый" },
    productUrl: "https://www.ozon.ru/product/synthetic-shelf-100000002/", imageUrl: "https://example.com/synthetic-shelf.png"
  }).checked.skuPackage;
}

function component(semantic) {
  return {
    value: semantic,
    rawValue: semantic,
    raw: null,
    normalizationRule: "identity_0_100",
    conversionRule: null,
    evidenceRef: `metric:semantic:${semantic}`,
    observedAt: NOW,
    period: null
  };
}

function keywordRecord(keyword, semantic, group, factRefs = [SUPPLY_REF]) {
  const descriptionOnly = semantic < 80;
  return {
    keyword,
    sourceRefs: [`k3-source:${keyword}`],
    factRefs,
    score: semantic,
    scoringVersion: KEYWORD_SCORING_VERSION,
    confidence: 0.35,
    decision: "adopted",
    decisionReason: descriptionOnly ? "description_only_semantic_gate" : `${group}_ranked_selection`,
    matchType: "target_fact",
    evidenceCoverage: 0.35,
    usageRestriction: descriptionOnly ? "description_only" : null,
    placementGateEvidence: descriptionOnly ? { approved: true, evidenceRef: `gate:${keyword}`, reason: "C1事实支持的描述长尾" } : null,
    components: Object.fromEntries(Object.keys(KEYWORD_SCORING_COMPONENTS).map((name) => [name, name === "semanticMatch" ? component(semantic) : null]))
  };
}

function currentBinding(pkg) {
  const plan = pkg.c1ProductPlan;
  return {
    candidateId: pkg.g1Identity.candidateId,
    parentOpportunityId: plan.identity.parentOpportunityId,
    skuPackageId: pkg.skuPackageId,
    dataRevision: pkg.dataRevision,
    supplierSkuId: pkg.supplierSkuId,
    salesSnapshotVersion: plan.inputSnapshots.salesSnapshot.version ?? plan.inputSnapshots.salesSnapshot.schemaVersion,
    salesSnapshotFingerprint: plan.inputSnapshots.salesSnapshot.fingerprint ?? digest(plan.inputSnapshots.salesSnapshot),
    supplySkuFactsVersion: plan.inputSnapshots.confirmedSupplierSkuSnapshot.version ?? "c1-confirmed-supplier-sku-snapshot-v1",
    supplySkuFactsFingerprint: plan.inputSnapshots.confirmedSupplierSkuSnapshot.fingerprint ?? digest(plan.inputSnapshots.confirmedSupplierSkuSnapshot),
    preparationFingerprint: "k2-preparation-fp-11",
    metricEvidenceFingerprint: "k3-metrics-fp-11",
    scoringPayloadFingerprint: null
  };
}

function k3Snapshot(pkg, { factRefs = pkg.c1ProductPlan.exactSkuVerification.supplierSkuId.sourceRefs, status = "ready" } = {}) {
  const groups = {
    title_keywords: Array.from({ length: 3 }, (_, index) => keywordRecord(`полка ванная title ${index}`, 80, "title_keywords", factRefs)),
    attribute_and_tag_keywords: Array.from({ length: 6 }, (_, index) => keywordRecord(`полка tag ${index}`, 88, "attribute_and_tag_keywords", factRefs)),
    description_long_tail: Array.from({ length: 10 }, (_, index) => keywordRecord(`полка без сверления long ${index}`, 75, "description_long_tail", factRefs))
  };
  if (status === "partial_ready") {
    groups.attribute_and_tag_keywords = [];
    groups.description_long_tail = [];
  }
  const binding = currentBinding(pkg);
  const gaps = status === "partial_ready" ? [
    { group: "attribute_and_tag_keywords", requiredMin: 6, actual: 0, missing: 6 },
    { group: "description_long_tail", requiredMin: 10, actual: 0, missing: 10 }
  ] : [];
  const scoringContext = {
    scoringVersion: KEYWORD_SCORING_VERSION,
    preparationId: "k2-preparation:NON-TRAIN-SHELF:11",
    preparationFingerprint: binding.preparationFingerprint,
    pointsBefore: 100,
    pointsAfter: 85,
    pointsSpent: 15,
    coverage: status === "ready" ? "full" : "partial",
    groupLimits: {
      title_keywords: { min: 3, max: 5 }, attribute_and_tag_keywords: { min: 6, max: 12 }, description_long_tail: { min: 10, max: 20 }
    },
    gaps,
    rejected: [],
    metricEvidenceVersion: "keyword-metrics-v1",
    metricEvidenceFingerprint: binding.metricEvidenceFingerprint,
    execution: { networkCalls: 0, modelCalls: 0, codexDispatches: 0, bOrC1Created: false, sharedWrites: 0 }
  };
  scoringContext.scoringPayloadFingerprint = digest({
    groups,
    rejected: scoringContext.rejected,
    gaps,
    preparationFingerprint: scoringContext.preparationFingerprint,
    metricEvidenceFingerprint: scoringContext.metricEvidenceFingerprint
  });
  binding.scoringPayloadFingerprint = scoringContext.scoringPayloadFingerprint;
  const snapshot = createKeywordEvidenceSnapshot({
    snapshotId: `keyword-evidence:NON-TRAIN-SHELF:11:${status}`,
    identity: {
      candidateId: pkg.g1Identity.candidateId,
      parentOpportunityId: pkg.c1ProductPlan.identity.parentOpportunityId,
      skuPackageId: pkg.skuPackageId,
      dataRevision: pkg.dataRevision
    },
    bindings: {
      salesSnapshot: {
        snapshotId: pkg.c1ProductPlan.inputRefs.salesSnapshotId,
        version: binding.salesSnapshotVersion,
        fingerprint: binding.salesSnapshotFingerprint
      },
      supplySkuFacts: { version: binding.supplySkuFactsVersion, fingerprint: binding.supplySkuFactsFingerprint }
    },
    currentBinding: binding,
    collectedAt: NOW,
    expiresAt: EXPIRES,
    asOf: NOW,
    sourceAttempts: [{
      schemaVersion: "keyword-source-attempt-v1", attemptId: "attempt:local:11", provider: "local-keyword-fusion", channel: "local_fusion",
      queryId: "local:11", queryText: "frozen K3 evidence", locale: "ru-RU", targetPlatform: "ozon", requestId: "local:11", receiptId: null,
      startedAt: NOW, completedAt: NOW, status: "completed", resultCount: Object.values(groups).flat().length, failureClass: null, traceRef: "trace:k3:11"
    }],
    groups,
    statusOverride: status,
    scoringContext
  });
  return { snapshot, binding };
}

function seoRules() {
  return {
    rulesVersion: "seo-rules-ru-v4", locale: "ru-RU", titleMaxLength: 120, descriptionMaxLength: 1800, bulletPointLimit: 5,
    prohibitedClaims: ["unverified_brand"], evidenceRef: "config:seo-rules-ru-v4", frozenAt: NOW
  };
}

test("普通非火车SKU把K3三组确定性映射到独立用途并保留完整评分证据", () => {
  const pkg = skuPackage();
  const { snapshot, binding } = k3Snapshot(pkg);
  const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.keywordEvidence.keywords.filter((item) => item.group === "title_keywords").map((item) => item.allowedOutputFields), [["title"], ["title"], ["title"]]);
  assert.ok(result.keywordEvidence.keywords.filter((item) => item.group === "attribute_and_tag_keywords").every((item) => item.allowedOutputFields.join() === "searchKeywords" && item.components));
  assert.ok(result.keywordEvidence.keywords.filter((item) => item.group === "description_long_tail").every((item) => item.allowedOutputFields.join() === "description,bulletPoints" && item.usageRestriction === "description_only"));
  assert.ok(result.keywordEvidence.keywords.filter((item) => item.group !== "description_long_tail").every((item) => item.components.semanticMatch.value >= 80));
  assert.ok(result.keywordEvidence.keywords.filter((item) => item.group === "description_long_tail").every((item) => item.components.semanticMatch.value >= 70 && item.components.semanticMatch.value < 80));
  assert.ok(result.keywordEvidence.keywords.every((item) => item.factBindingPaths.includes("exactSkuVerification.supplierSkuId")));
  assert.equal(Object.isFrozen(result), true);
});

test("K3采用词与C1事实sourceRefs无交集时整包not_ready", () => {
  const pkg = skuPackage();
  const { snapshot, binding } = k3Snapshot(pkg, { factRefs: ["unrelated:fact"] });
  const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
  assert.equal(result.status, "not_ready");
  assert.equal(result.keywordEvidence, null);
  assert.ok(result.gaps.every((item) => item.code === "k3_keyword_fact_intersection_missing"));
});

test("partial K3明确not_ready且不调用AI", () => {
  const pkg = skuPackage();
  const { snapshot, binding } = k3Snapshot(pkg, { status: "partial_ready" });
  const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
  assert.equal(result.status, "not_ready");
  assert.equal(result.gaps[0].code, "k3_status_partial_ready");
  assert.equal(result.executionEvidence.aiCalls, 0);
});

test("所有非ready K3状态都返回各自明确not_ready且不进入AI", () => {
  for (const status of ["partial_ready", "needs_review", "technical_unavailable", "true_empty", "stale"]) {
    const pkg = skuPackage();
    const fixture = k3Snapshot(pkg);
    const snapshot = structuredClone(fixture.snapshot);
    snapshot.status = status;
    const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: fixture.binding, adaptedAt: NOW });
    assert.equal(result.status, "not_ready", status);
    assert.equal(result.gaps[0].code, `k3_status_${status}`);
    assert.equal(result.executionEvidence.aiCalls, 0);
  }
});

test("过期、跨SKU、revision、销售与供应绑定漂移全部停止", () => {
  const mutations = [
    (binding) => { binding.skuPackageId = "sku:OTHER"; },
    (binding) => { binding.dataRevision = 12; },
    (binding) => { binding.salesSnapshotFingerprint = "sales-drift"; },
    (binding) => { binding.supplySkuFactsFingerprint = "supply-drift"; },
    (binding) => { binding.supplierSkuId = "OTHER-SKU"; }
  ];
  for (const mutate of mutations) {
    const pkg = skuPackage();
    const { snapshot, binding } = k3Snapshot(pkg);
    mutate(binding);
    const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
    assert.equal(result.status, "not_ready");
  }
  const pkg = skuPackage();
  const { snapshot, binding } = k3Snapshot(pkg);
  assert.equal(adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: EXPIRES }).status, "not_ready");
});

test("K3快照或preparation metric scoring指纹篡改均拒绝", () => {
  for (const mutate of [
    ({ snapshot }) => { snapshot.groups.title_keywords[0].score = 99; },
    ({ binding }) => { binding.preparationFingerprint = "tampered-preparation"; },
    ({ binding }) => { binding.metricEvidenceFingerprint = "tampered-metrics"; },
    ({ binding }) => { binding.scoringPayloadFingerprint = "tampered-scoring"; }
  ]) {
    const pkg = skuPackage();
    const fixture = k3Snapshot(pkg);
    fixture.snapshot = structuredClone(fixture.snapshot);
    mutate(fixture);
    const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: fixture.snapshot, currentBinding: fixture.binding, adaptedAt: NOW });
    assert.equal(result.status, "not_ready");
  }
});

test("重复适配幂等且活动C1输入无需savedKeywordEvidence", () => {
  const pkg = formalSkuPackage();
  const { snapshot, binding } = k3Snapshot(pkg);
  const first = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
  const second = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
  assert.deepEqual(second, first);
  const prepared = prepareC1SoftwareInputs({
    skuPackage: pkg,
    frozenSeoRules: seoRules(),
    k3KeywordEvidenceSnapshot: snapshot,
    k3CurrentBinding: binding,
    preparedAt: NOW
  });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.inputs.keywordEvidence.collectionMode, "validated_k3_snapshot");
  assert.deepEqual(prepared.executionEvidence, { externalAccesses: [], seerfarCalls: 0, gatewayCalls: 0, codexDispatches: 0, platformWrites: 0 });
  assert.deepEqual(prepared.downstream, { c2Started: false, productionStarted: false, eReadbackStarted: false });
});

test("C1 AI请求保留K3回溯字段、用途门禁与既有Terra单次策略", () => {
  const pkg = formalSkuPackage();
  const { snapshot, binding } = k3Snapshot(pkg);
  const prepared = prepareC1SoftwareInputs({ skuPackage: pkg, frozenSeoRules: seoRules(), k3KeywordEvidenceSnapshot: snapshot, k3CurrentBinding: binding, preparedAt: NOW });
  const request = buildC1AiDraftRequest({ skuPackage: pkg, ...prepared.inputs, requestedAt: NOW });
  assert.equal(request.provider, "terra");
  assert.equal(request.executionPolicy.attemptLimit, 1);
  assert.equal(request.executionPolicy.automaticRetry, false);
  assert.equal(request.executionPolicy.fallbackProvider, null);
  assert.equal(request.executionPolicy.codexDispatch, false);
  assert.equal(request.keywordEvidence.sourceBindings.sourceSnapshotId, snapshot.snapshotId);
  assert.equal(request.keywordEvidence.sourceBindings.sourceSnapshotFingerprint, snapshot.snapshotFingerprint);
  assert.ok(request.keywordEvidence.keywords.every((item) => item.components && item.sourceRefs && item.k3FactRefs));
  assert.ok(request.keywordEvidence.keywords.filter((item) => item.usageRestriction === "description_only").every((item) => !item.allowedOutputFields.includes("title") && !item.allowedOutputFields.includes("searchKeywords")));
});

test("AI输出引用不能把description_only词越界放进标题或标签", () => {
  const pkg = formalSkuPackage();
  const { snapshot, binding } = k3Snapshot(pkg);
  const prepared = prepareC1SoftwareInputs({ skuPackage: pkg, frozenSeoRules: seoRules(), k3KeywordEvidenceSnapshot: snapshot, k3CurrentBinding: binding, preparedAt: NOW });
  const request = buildC1AiDraftRequest({ skuPackage: pkg, ...prepared.inputs, requestedAt: NOW });
  const byGroup = Object.fromEntries(["title_keywords", "attribute_and_tag_keywords", "description_long_tail"].map((group) => [
    group, request.keywordEvidence.keywords.find((item) => item.group === group).keywordEvidenceRef
  ]));
  const cited = (text, keywordRef) => ({
    text,
    factRefs: ["exactSkuVerification.supplierSkuId"],
    keywordRefs: [keywordRef],
    assertions: [{ factPath: "exactSkuVerification.supplierSkuId", value: "SHELF-WHITE" }]
  });
  const output = {
    status: "draft_only", locale: "ru-RU", claimCoverage: "complete", unsupportedClaims: [],
    title: cited("Полка для ванной", byGroup.title_keywords),
    description: cited("Полка без сверления", byGroup.description_long_tail),
    bulletPoints: [cited("Для ванной", byGroup.description_long_tail)],
    searchKeywords: [cited("полка для ванной", byGroup.attribute_and_tag_keywords)]
  };
  const receipt = receiptFixture(request, { startedAt: NOW, completedAt: NOW, outputFingerprint: digest(output), output });
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt }), { valid: true, errors: [] });
  const saved = settledExecution(request, receipt, authorizedExecution(request));
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage: pkg, request, receipt, mergedAt: NOW }), /SETTLED_EXECUTION_REQUIRED/);
  const merged = mergeC1AiDraftReceipt({ skuPackage: pkg, request, receipt, settledExecution: saved, mergedAt: NOW });
  assert.equal(merged.c1ProductPlan.seoEvidenceLayer.providerJobRef.jobId, receipt.gatewayJobId);
  assert.equal(merged.c1ProductPlan.seoEvidenceLayer.aiRequestFingerprint, request.requestFingerprint);
  for (const field of ["title", "searchKeywords"]) {
    const drifted = structuredClone(receipt);
    const outputField = field === "title" ? drifted.output.title : drifted.output.searchKeywords[0];
    outputField.keywordRefs = [byGroup.description_long_tail];
    drifted.outputFingerprint = digest(drifted.output);
    const validation = validateC1AiDraftReceipt({ request, receipt: drifted });
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join(" "), /用途越界/);
  }
});

test("适配层零外部调用、零Codex派发、零C2/D/E", () => {
  const pkg = skuPackage();
  const { snapshot, binding } = k3Snapshot(pkg);
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; throw new Error("forbidden"); };
  try {
    const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
    assert.equal(result.status, "ready");
    assert.equal(fetches, 0);
    assert.deepEqual(result.executionEvidence, { externalAccesses: [], seerfarCalls: 0, aiCalls: 0, codexDispatches: 0, platformWrites: 0 });
    assert.deepEqual(result.downstream, { c2Started: false, productionStarted: false, eReadbackStarted: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("K3拒绝G1缺失或错绑，不使用顶层旧候选字段跳过身份校验", () => {
  for (const identity of [undefined, { candidateId: "OTHER" }]) {
    const pkg = skuPackage();
    const { snapshot, binding } = k3Snapshot(pkg);
    pkg.g1Identity = identity;
    pkg.candidateId = binding.candidateId;
    const before = structuredClone(pkg);
    const result = adaptK3KeywordEvidenceForC1({ skuPackage: pkg, k3Snapshot: snapshot, currentBinding: binding, adaptedAt: NOW });
    assert.equal(result.status, "not_ready");
    assert.ok(result.gaps.some(item => item.code === "k3_c1_identity_drift"));
    assert.deepEqual(pkg, before);
  }
});

test("适配结果Schema冻结零外部调用与零下游推进", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c1-k3-keyword-adapter-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.executionEvidence.properties.externalAccesses.maxItems, 0);
  assert.equal(schema.properties.executionEvidence.properties.seerfarCalls.const, 0);
  assert.equal(schema.properties.executionEvidence.properties.aiCalls.const, 0);
  assert.equal(schema.properties.executionEvidence.properties.codexDispatches.const, 0);
  assert.equal(schema.properties.downstream.properties.c2Started.const, false);
  assert.equal(schema.properties.downstream.properties.productionStarted.const, false);
  assert.equal(schema.properties.downstream.properties.eReadbackStarted.const, false);
});
