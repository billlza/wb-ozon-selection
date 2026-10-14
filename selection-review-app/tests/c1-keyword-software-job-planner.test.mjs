import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertC1KeywordSoftwareJobClientInput,
  buildC1KeywordSoftwareJobPlan,
  C1_KEYWORD_PLANNING_EVIDENCE_VERSION,
  C1_KEYWORD_SOFTWARE_JOB_PLAN_VERSION,
  planC1KeywordEvidenceSoftwareJob
} from "../lib/c1-keyword-software-job-planner.mjs";
import { createKeywordEvidenceSnapshot } from "../lib/keyword-evidence-snapshot.mjs";

const NOW = "2026-08-24T08:00:00.000Z";
const EXPIRES = "2026-08-25T08:00:00.000Z";
const SALES_REF = "evidence:sales:music-box:31";
const SUPPLY_REF = "evidence:supply:music-box:white";

function confirmed(value, sourceRefs = [SUPPLY_REF]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function candidate() {
  const sales = {
    schemaVersion: "sales-snapshot-v1.1",
    snapshotId: "sales:music-box:31",
    platform: "ozon",
    title: "Деревянная музыкальная шкатулка",
    currentPrice: 1790,
    evidenceRef: SALES_REF,
    collectedAt: NOW
  };
  const supply = {
    schemaVersion: "confirmed-supplier-sku-snapshot-v1",
    snapshotId: SUPPLY_REF,
    ownerSupplyConfirmation: {
      confirmationId: "owner-supply:music-box:white:31",
      status: "confirmed",
      confirmedAt: NOW,
      supplierSkuId: "MUSIC-WHITE"
    },
    supplierSku: { supplierSkuId: "MUSIC-WHITE", variantKey: "颜色:原木", attributes: { material: "wood" } }
  };
  const profit = { schemaVersion: "profit-model-v1.1", profitModelVersion: "profit-v31", result: "passed", unitProfitRmb: 24, profitMargin: 0.13 };
  const c1ProductPlan = {
    schemaVersion: "c1-product-plan-v1.1",
    status: "facts_checked",
    inputRefs: { salesSnapshotId: sales.snapshotId, selectedSupplySnapshotId: supply.snapshotId, profitModelVersion: profit.profitModelVersion },
    identity: {
      parentOpportunityId: "opportunity:music-box",
      skuPackageId: "sku-lifecycle:music-box:MUSIC-WHITE",
      supplierSkuId: "MUSIC-WHITE",
      variantKey: "颜色:原木",
      targetStore: "dandanshu",
      targetPlatform: "ozon"
    },
    inputSnapshots: { salesSnapshot: sales, confirmedSupplierSkuSnapshot: supply, profitModel: profit },
    exactSkuVerification: { status: confirmed("verified") },
    productAttributes: { status: confirmed("known"), material: confirmed("wood") },
    platformCategory: { status: confirmed("identified", ["schema:music-box"]), categoryName: confirmed("Музыкальные шкатулки", ["schema:music-box"]) },
    schemaSnapshot: { status: confirmed("frozen", ["schema:music-box"]) },
    batteryAssessment: { status: confirmed("known"), assessment: confirmed("no_battery") },
    categoryRestrictions: { status: confirmed("known", ["schema:music-box"]), restrictions: confirmed([], ["schema:music-box"]) },
    platformCompliance: { status: confirmed("clear", ["schema:music-box"]) }
  };
  const value = {
    id: "CX-MUSIC-BOX-014",
    dataRevision: 31,
    lifecycleV11: {
      skuPackage: {
        g1Identity: {
      schemaVersion: "g1-identity-v1", candidateId: "CX-MUSIC-BOX-014", skuPackageId: c1ProductPlan.identity.skuPackageId,
      platform: "ozon", storeRef: { stableStoreId: "dandanshu", platformStoreId: "synthetic-seller-001", mappingVersion: "synthetic-v1" },
      supplierSkuId: "MUSIC-WHITE", merchantSku: "not_applicable", warehouseRef: "not_applicable",
      credentialAlias: "not_applicable", platformProductId: "not_applicable"
    },
        skuPackageId: c1ProductPlan.identity.skuPackageId,
        supplierSkuId: "MUSIC-WHITE",
        variantKey: "颜色:原木",
        targetPlatform: "ozon",
        targetStore: "dandanshu",
        businessPhase: "C1",
        dataRevision: 9,
        fulfillmentMode: "rfbs",
        c1ProductPlan
      }
    }
  };
  value.lifecycleV11.c1KeywordPlanningEvidenceV1 = planningEvidence(value);
  return value;
}

function planningEvidence(value) {
  const sku = value.lifecycleV11.skuPackage;
  const plan = sku.c1ProductPlan;
  return {
    schemaVersion: C1_KEYWORD_PLANNING_EVIDENCE_VERSION,
    binding: {
      candidateId: value.id,
      skuPackageId: sku.skuPackageId,
      candidateRevision: value.dataRevision,
      platform: plan.identity.targetPlatform,
      exactSupplierSkuId: plan.identity.supplierSkuId,
      salesSnapshotId: plan.inputRefs.salesSnapshotId,
      supplySnapshotId: plan.inputRefs.selectedSupplySnapshotId
    },
    locale: "ru-RU",
    expiresAt: EXPIRES,
    frozenSeoRules: { rulesVersion: "seo-rules-ru-v6", evidenceRef: "config:seo-rules-ru-v6" },
    frozenComplexityDecision: null,
    healthPolicy: {
      connectorVersion: "seerfar-runtime-v1",
      apiSchemaVersion: "seerfar-open-api-v1",
      controlledWindowId: "window:2026-08-24-am",
      ttlMs: 3_600_000,
      suspectedSystemicFailure: false,
      standardSkus: [{ id: "standard:1" }, { id: "standard:2" }, { id: "standard:3" }],
      lastProof: {
        connectorVersion: "seerfar-runtime-v1",
        apiSchemaVersion: "seerfar-open-api-v1",
        controlledWindowId: "window:2026-08-24-am",
        provedAt: "2026-08-24T07:30:00.000Z"
      }
    },
    productFactTerms: [{ term: "музыкальная шкатулка", sourceRefs: [SUPPLY_REF], factRefs: [SUPPLY_REF], sourceTrust: "confirmed_supply", matchType: "target_fact" }],
    comparables: Array.from({ length: 4 }, (_, index) => ({
      competitorRef: `competitor:music-box:${index + 1}`,
      seerfarSku: String(900000 + index),
      platform: "ozon",
      matchType: "exact_match",
      comparabilityStatus: "proven",
      comparabilityEvidenceRefs: [`comparison:${index + 1}`],
      factRefs: [SUPPLY_REF],
      useForReverseLookup: true,
      organicTraffic: { value: 400 - index * 50, period: "30d", evidenceRef: `organic:${index + 1}` },
      manualSelectionRank: index + 1,
      selectionEvidenceRef: `selection:${index + 1}`,
      terms: []
    })),
    seedEvidence: [],
    quotaEvidence: { availablePoints: 80, observedAt: NOW, expiresAt: EXPIRES, evidenceRef: "seerfar-quota:80" },
    pointBudget: { approved: true, maxPoints: 15, evidenceRef: "config:seerfar-budget-15" },
    keywordMetricEvidence: { version: "keyword-metrics-v1", evidenceRef: "metrics:music-box:31", candidates: [] },
    reusableKeywordSnapshot: null,
    reuseEvidenceNote: null
  };
}

test("G1缺失或错绑时不创建作业，顶层旧候选字段不能替代G1", () => {
  for (const identity of [undefined, { candidateId: "OTHER" }]) {
    const value = candidate();
    value.lifecycleV11.skuPackage.g1Identity = identity;
    value.lifecycleV11.skuPackage.candidateId = value.id;
    const before = structuredClone(value);
    const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
    assert.equal(result.status, "not_ready");
    assert.equal(result.gaps[0].code, "c1_sku_package_missing");
    assert.equal(result.job, null);
    assert.deepEqual(value, before);
  }
});

function keyword(term) {
  return { keyword: term, sourceRefs: ["reuse:source"], factRefs: [SUPPLY_REF], score: 90, scoringVersion: null, confidence: 0.9, decision: "adopted", decisionReason: "verified" };
}

function reusableSnapshot(value) {
  const sales = value.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.salesSnapshot;
  const supply = value.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot;
  return createKeywordEvidenceSnapshot({
    snapshotId: "keyword-evidence:music-box:reuse",
    identity: { candidateId: value.id, parentOpportunityId: "opportunity:music-box", skuPackageId: value.lifecycleV11.skuPackage.skuPackageId, dataRevision: value.dataRevision },
    bindings: {
      salesSnapshot: { snapshotId: sales.snapshotId, version: sales.schemaVersion, fingerprint: valueHash(sales) },
      supplySkuFacts: { version: supply.schemaVersion, fingerprint: valueHash(supply) }
    },
    currentBinding: {
      candidateId: value.id, parentOpportunityId: "opportunity:music-box", skuPackageId: value.lifecycleV11.skuPackage.skuPackageId, dataRevision: value.dataRevision,
      salesSnapshotVersion: sales.schemaVersion, salesSnapshotFingerprint: valueHash(sales), supplySkuFactsVersion: supply.schemaVersion, supplySkuFactsFingerprint: valueHash(supply)
    },
    collectedAt: NOW,
    expiresAt: EXPIRES,
    asOf: NOW,
    sourceAttempts: [{
      schemaVersion: "keyword-source-attempt-v1", attemptId: "reuse:attempt", provider: "saved-evidence", channel: "local_fusion", queryId: "reuse:query", queryText: "music box",
      locale: "ru-RU", targetPlatform: "ozon", requestId: null, receiptId: "reuse:receipt", startedAt: NOW, completedAt: NOW,
      status: "completed", resultCount: 3, failureClass: null, traceRef: "reuse:trace"
    }],
    groups: { title_keywords: [keyword("музыкальная шкатулка")], attribute_and_tag_keywords: [keyword("деревянная шкатулка")], description_long_tail: [keyword("подарочная музыкальная шкатулка")] }
  });
}

function valueHash(value) {
  const stable = (item) => Array.isArray(item) ? item.map(stable) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

test("旧付费结果未对账时不得因新revision或预算重新创建计划", () => {
  for (const status of ["in_flight", "unknown_outcome"]) {
    const value = candidate();
    value.lifecycleV11.keywordEvidenceSoftwareJobV1 = { status, sourceRevision: 1, retryAllowed: false };
    const before = structuredClone(value);
    const result = buildC1KeywordSoftwareJobPlan({ candidate: value, expectedRevision: 31, plannedAt: NOW });
    assert.equal(result.status, "not_ready");
    assert.equal(result.readinessClass, "blocked");
    assert.equal(result.gaps[0].code, "legacy_keyword_job_unresolved");
    assert.equal(result.job, null);
    assert.equal(result.executionPolicy.attemptLimit, 0);
    assert.deepEqual(value, before);
  }
});

test("普通非火车SKU从冻结数据生成唯一单次Open API计划，UI无需提交请求载荷", () => {
  const value = candidate();
  const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.mode, "seerfar_open_api_once");
  assert.equal(result.job.candidateId, value.id);
  assert.equal(result.job.skuPackageId, value.lifecycleV11.skuPackage.skuPackageId);
  assert.equal(result.job.sourceRevision, 31);
  assert.equal(result.job.resultRevision, 32);
  assert.equal(result.job.jobType, "c1_paid_keyword_evidence");
  assert.deepEqual(result.job.requiredCapabilities, ["seerfar-open-api"]);
  assert.deepEqual(result.job.seerfarRequest.skuIds, ["900000", "900001", "900002", "900003"]);
  assert.equal(result.job.evidencePolicy.maximumPoints, 15);
  assert.equal(result.job.evidencePolicy.trueEmptyBoundary, "only_completed_query_with_explicit_zero_results");
  assert.equal(result.job.runtimeInputTemplate.dataRevision, 32);
  assert.deepEqual([
    result.executionPolicy.attemptLimit,
    result.executionPolicy.browserFallbackAllowed,
    result.executionPolicy.codexDispatchAllowed
  ], [1, false, false]);
  assert.deepEqual([result.executionPolicy.automaticRetries, result.executionPolicy.c2Started, result.executionPolicy.dStarted, result.executionPolicy.eStarted], [0, false, false, false]);
  assert.equal(JSON.stringify(result).includes("runtimeInputTemplate\":{}"), false);
  assert.equal(JSON.stringify(result).includes("282"), false);
  assert.equal(JSON.stringify(result).includes("train"), false);
});

test("总控集成接口只接收dataRevision并把服务端生成的载荷提升到固定输出", () => {
  const value = candidate();
  assert.deepEqual(assertC1KeywordSoftwareJobClientInput({ dataRevision: 31 }), { dataRevision: 31 });
  for (const body of [
    { dataRevision: 31, runtimeInputTemplate: {} },
    { dataRevision: 31, seerfarRequest: {} },
    { dataRevision: 31, providerEvidence: {} },
    { dataRevision: 31, apiKey: "forbidden" }
  ]) assert.throws(() => assertC1KeywordSoftwareJobClientInput(body), /CLIENT_INPUT_REJECTED/);

  const result = buildC1KeywordSoftwareJobPlan({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.readinessClass, "ready");
  assert.equal(result.runtimeInputTemplate.dataRevision, 32);
  assert.equal(result.seerfarRequest.operation, "reverse_keywords");

  value.lifecycleV11.c1KeywordPlanningEvidenceV1.reusableKeywordSnapshot = reusableSnapshot(value);
  value.lifecycleV11.c1KeywordPlanningEvidenceV1.reuseEvidenceNote = "同绑定快照有效";
  const reuse = buildC1KeywordSoftwareJobPlan({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  assert.equal(reuse.status, "reuse_ready");
  assert.equal(reuse.readinessClass, "ready");
  assert.equal(reuse.seerfarRequest, null);
});

test("相同候选/revision计划幂等，跨revision、跨SKU和已有不同计划停止", () => {
  const value = candidate();
  const first = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  const replay = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW, existingPlan: first });
  assert.equal(replay.planFingerprint, first.planFingerprint);

  assert.throws(() => planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 30, plannedAt: NOW }), /INPUT_INVALID/);
  const drift = candidate();
  drift.lifecycleV11.c1KeywordPlanningEvidenceV1.binding.skuPackageId = "sku:other";
  assert.equal(planC1KeywordEvidenceSoftwareJob({ candidate: drift, expectedRevision: 31, plannedAt: NOW }).gaps[0].code, "keyword_planning_binding_drift");

  const otherPlan = structuredClone(first);
  otherPlan.job.jobId = "keyword-job:other";
  assert.equal(planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW, existingPlan: otherPlan }).gaps[0].code, "different_plan_already_exists");
});

test("缺B通过、缺C1事实、缺履约或无有效竞品分别返回精确缺口且零外部调用", () => {
  const cases = [
    [(value) => { value.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.profitModel.result = "failed"; }, "b_profit_not_passed"],
    [(value) => { value.lifecycleV11.skuPackage.c1ProductPlan.productAttributes = null; }, "verified_facts_incomplete"],
    [(value) => { value.lifecycleV11.skuPackage.fulfillmentMode = null; }, "fulfillment_missing"],
    [(value) => { value.lifecycleV11.c1KeywordPlanningEvidenceV1.comparables = []; }, "valid_competitor_count_invalid"]
  ];
  for (const [mutate, code] of cases) {
    const value = candidate();
    mutate(value);
    const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
    assert.equal(result.gaps[0].code, code);
    assert.equal(result.job, null);
    assert.equal(result.executionPolicy.attemptLimit, 0);
  }
});

test("有效快照优先0点复用，不检查付费额度也不生成Seerfar调用", () => {
  const value = candidate();
  value.lifecycleV11.c1KeywordPlanningEvidenceV1.reusableKeywordSnapshot = reusableSnapshot(value);
  value.lifecycleV11.c1KeywordPlanningEvidenceV1.reuseEvidenceNote = "同平台、同SKU事实和同快照绑定仍在有效期内";
  value.lifecycleV11.c1KeywordPlanningEvidenceV1.quotaEvidence.availablePoints = 0;
  value.lifecycleV11.c1KeywordPlanningEvidenceV1.pointBudget.approved = false;
  const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.mode, "reuse_existing_evidence");
  assert.equal(result.job.pointsRequired, 0);
  assert.equal(result.job.providerCalls, 0);
  assert.equal(result.executionPolicy.attemptLimit, 0);
  assert.equal(result.job.runtimeInputTemplate.reusableKeywordSnapshot.snapshotId, "keyword-evidence:music-box:reuse");
});

test("付费点数不足、预算未确认、标准SKU健康过期均阻断且不产生作业", () => {
  const cases = [
    [(value) => { value.lifecycleV11.c1KeywordPlanningEvidenceV1.quotaEvidence.availablePoints = 14; }, "quota_insufficient"],
    [(value) => { value.lifecycleV11.c1KeywordPlanningEvidenceV1.pointBudget.approved = false; }, "paid_points_not_approved"],
    [(value) => { value.lifecycleV11.c1KeywordPlanningEvidenceV1.healthPolicy.lastProof.provedAt = "2026-08-24T06:00:00.000Z"; }, "standard_sku_health_not_current"]
  ];
  for (const [mutate, code] of cases) {
    const value = candidate();
    mutate(value);
    const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
    assert.equal(result.status, "blocked");
    assert.equal(result.gaps[0].code, code);
    assert.equal(result.job, null);
  }
});

test("无自然流量时只接受有证据的人工顺序，不把自然排名或销量冒充流量", () => {
  const allowed = candidate();
  allowed.lifecycleV11.c1KeywordPlanningEvidenceV1.comparables.forEach((item) => { item.organicTraffic = null; });
  const result = planC1KeywordEvidenceSoftwareJob({ candidate: allowed, expectedRevision: 31, plannedAt: NOW });
  assert.equal(result.job.evidencePolicy.competitorSelectionMethod, "owner_verified_unranked_selection");

  const blocked = candidate();
  blocked.lifecycleV11.c1KeywordPlanningEvidenceV1.comparables.forEach((item) => { item.organicTraffic = null; delete item.selectionEvidenceRef; });
  const failed = planC1KeywordEvidenceSoftwareJob({ candidate: blocked, expectedRevision: 31, plannedAt: NOW });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.gaps[0].code, "competitor_order_evidence_missing");
});

test("秘密字段在计划产生前拒绝，发布Schema锁定三状态和零副作用边界", async () => {
  const unsafe = candidate();
  unsafe.lifecycleV11.c1KeywordPlanningEvidenceV1.api_key = "forbidden";
  assert.throws(() => planC1KeywordEvidenceSoftwareJob({ candidate: unsafe, expectedRevision: 31, plannedAt: NOW }), /SECRET_FORBIDDEN/);

  const schema = JSON.parse(await readFile(new URL("../schema/c1-keyword-software-job-plan-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, C1_KEYWORD_SOFTWARE_JOB_PLAN_VERSION);
  assert.deepEqual(schema.properties.status.enum, ["ready", "reuse_ready", "not_ready"]);
  assert.equal(schema.properties.executionPolicy.properties.automaticRetries.const, 0);
  assert.equal(schema.properties.executionPolicy.properties.browserFallbackAllowed.const, false);
  assert.equal(schema.properties.executionPolicy.properties.codexDispatchAllowed.const, false);
  assert.equal(schema.additionalProperties, false);
});

// `skuPackage.fulfillmentMode` 生产代码里从来没有人写过——只有读、没有写，schema 也没定义它，
// 真实候选一个都不带。这道门因此在生产里谁都过不去。下面三条钉住 2026-09-17 的修法：
// 值从**已冻结的利润模型**里取（成本口径的 salesScheme），两处口径必须一致，不一致就照实说读不准。
function frozenSalesScheme(value, snapshotScheme, contextScheme = snapshotScheme) {
  const profit = value.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.profitModel;
  profit.otherCosts = {
    costPolicySnapshot: { scope: { salesScheme: snapshotScheme } },
    costPolicyContext: { salesScheme: contextScheme }
  };
  return value;
}

test("包上没写履约模式时，从已冻结的利润模型里取，不再把整条路堵死", () => {
  const value = frozenSalesScheme(candidate(), "rfbs");
  delete value.lifecycleV11.skuPackage.fulfillmentMode;
  const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  assert.equal(result.status, "ready", "冻结数据里有销售模式就不该报缺口");
  assert.equal(buildC1KeywordSoftwareJobPlan({ candidate: value, expectedRevision: 31, plannedAt: NOW })
    .bindings.fulfillment, "rfbs", "作业身份里要带上取到的那个值，不能留空");
});

test("冻结数据里两处口径不一致时照实说读不准，绝不替主人挑一个", () => {
  const value = frozenSalesScheme(candidate(), "rfbs", "fbp");
  delete value.lifecycleV11.skuPackage.fulfillmentMode;
  const result = planC1KeywordEvidenceSoftwareJob({ candidate: value, expectedRevision: 31, plannedAt: NOW });
  assert.equal(result.status, "not_ready");
  assert.deepEqual(result.gaps.map(item => item.code), ["fulfillment_missing"]);
});

test("包上真写了履约模式就以它为准，冻结数据只是兜底", () => {
  const value = frozenSalesScheme(candidate(), "fbp");
  value.lifecycleV11.skuPackage.fulfillmentMode = "rfbs";
  assert.equal(buildC1KeywordSoftwareJobPlan({ candidate: value, expectedRevision: 31, plannedAt: NOW })
    .bindings.fulfillment, "rfbs");
});
