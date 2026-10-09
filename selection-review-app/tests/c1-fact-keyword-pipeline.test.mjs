import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { prepareC1FactKeywordPipeline } from "../lib/c1-fact-keyword-pipeline.mjs";
import { KEYWORD_SCORING_COMPONENTS } from "../lib/keyword-evidence-scoring.mjs";
import { createC1SkuRightsReviewRecord } from "../lib/c1-sku-rights-review.mjs";
import { addSyntheticLicensedRightsToCheckedFixture } from "./fixtures/c1-sku-rights-review-fixture.mjs";

const NOW = "2026-08-23T12:00:00.000Z";
const EXPIRES = "2026-08-24T12:00:00.000Z";
const SUPPLY_REF = "evidence:supply:BATH-SHELF:WHITE";
const SALES_REF = "evidence:sales:BATH-SHELF:18";
const SCHEMA_REF = "evidence:schema:ozon:bath-shelf";

function fact(value, sourceRefs = [SUPPLY_REF]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function factsCheckedPackage() {
  const salesSnapshot = {
    schemaVersion: "sales-snapshot-v1.1",
    snapshotId: "sales:BATH-SHELF:18",
    platform: "ozon",
    title: "Полка для ванной без сверления",
    attributes: { material: "пластик", color: "белый" },
    collectedAt: NOW,
    evidenceRef: SALES_REF
  };
  const supplySnapshot = {
    snapshotId: SUPPLY_REF,
    ownerSupplyConfirmation: {
      confirmationId: "owner-supply:BATH-SHELF:WHITE:18",
      status: "confirmed",
      confirmedAt: NOW,
      supplierOptionId: "supplier-option:BATH-SHELF",
      supplierSkuId: "SHELF-WHITE"
    },
    supplierOptionIdentity: {
      supplierOptionId: "supplier-option:BATH-SHELF",
      sourcePlatform: "1688",
      productUrl: "https://detail.1688.com/offer/123456789.html",
      offerId: "123456789",
      evidenceRef: SUPPLY_REF
    },
    supplierSku: {
      supplierSkuId: "SHELF-WHITE",
      variantKey: "颜色:白色",
      attributes: { material: "plastic", color: "white" },
      material: "plastic",
      weight: { value: 0.25, unit: "kg" },
      dimensions: { length: 25, width: 10, height: 5, unit: "cm" },
      powerProfile: { powered: false, containsBattery: false }
    }
  };
  const plan = {
    schemaVersion: "c1-product-plan-v1.1",
    c1PlanId: "c1:sku-lifecycle:BATH-SHELF:SHELF-WHITE:profit-v6",
    status: "facts_checked",
    createdAt: NOW,
    inputRefs: {
      salesSnapshotId: salesSnapshot.snapshotId,
      selectedSupplySnapshotId: SUPPLY_REF,
      profitModelVersion: "profit-v6",
      platformSchemaEvidenceId: SCHEMA_REF
    },
    identity: {
      parentOpportunityId: "opportunity:BATH-SHELF",
      skuPackageId: "sku-lifecycle:BATH-SHELF:SHELF-WHITE",
      supplierOptionId: "supplier-option:BATH-SHELF",
      supplierSkuId: "SHELF-WHITE",
      variantKey: "颜色:白色",
      targetPlatform: "ozon",
      targetStore: "dandanshu"
    },
    inputSnapshots: {
      salesSnapshot,
      confirmedSupplierSkuSnapshot: supplySnapshot,
      profitModel: { profitModelVersion: "profit-v6", result: "passed" },
      platformSchemaRules: {
        evidenceId: SCHEMA_REF,
        platform: "ozon",
        store: "dandanshu",
        schemaRevision: "ozon:bath-shelf:2026-08-23",
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
    schemaSnapshot: { status: fact("frozen", [SCHEMA_REF]), schemaRevision: fact("ozon:bath-shelf:2026-08-23", [SCHEMA_REF]), requiredFields: fact([], [SCHEMA_REF]) },
    batteryAssessment: { status: fact("fact_available"), assessment: fact("no_battery"), powered: fact(false), containsBattery: fact(false) },
    categoryRestrictions: { status: fact("known", [SCHEMA_REF]), restrictions: fact([], [SCHEMA_REF]) },
    platformCompliance: { status: fact("known", [SCHEMA_REF]), assessment: fact({ status: "clear" }, [SCHEMA_REF]), requiredFieldGapCount: fact(0, [SCHEMA_REF]) },
    seoTitleDraft: null, descriptionDraft: null, bulletPointsDraft: null, searchKeywordsDraft: null, seoEvidenceLayer: null
  };
  const skuPackage = {
    schemaVersion: "sku-lifecycle-v1.1",
    g1Identity: {
      schemaVersion: "g1-identity-v1", candidateId: "BATH-SHELF", skuPackageId: plan.identity.skuPackageId,
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
    dataRevision: 18,
    c1ProductPlan: plan
  };
  return addSyntheticLicensedRightsToCheckedFixture(skuPackage, { sourceSkuRevision: 17, reviewedAt: NOW });
}

function profitModelFixture() {
  return {
    schemaVersion: "profit-model-v1.1",
    profitModelVersion: "profit-v1",
    calculatedAt: NOW,
    inputSnapshotRefs: ["sales:BATH-SHELF:18", SUPPLY_REF, "fees:18", "logistics:18", "fx:18"],
    recommendedSalePriceRub: 2400,
    recommendedSalePriceCny: 200,
    sellerSettlementRevenue: { amount: 172, currency: "CNY", evidenceRef: "fees:18" },
    commissionRate: 0.14,
    commissionMode: "exact",
    internationalFreight: { amount: 30, currency: "CNY", evidenceRef: "logistics:18" },
    actualPurchaseCost: { amount: 40, currency: "CNY", evidenceRef: SUPPLY_REF },
    otherCosts: { amount: 2, currency: "CNY", evidenceRef: "costs:18" },
    unitProfitRmb: 100,
    profitMargin: 0.5,
    thresholdVersion: "profit-threshold-v1.2-15pct-or-20cny",
    thresholds: { minimumProfitMargin: 0.15, minimumUnitProfitRmb: 20, logic: "any" },
    result: "passed",
    externalAccesses: [],
    requestedExistingFields: [],
    marketAssessmentRef: "market-assessment:BATH-SHELF:18",
    marketSampleRefs: ["sales:BATH-SHELF:18"]
  };
}

function inputsReadyPackage() {
  const pkg = structuredClone(factsCheckedPackage());
  const plan = pkg.c1ProductPlan;
  const profit = profitModelFixture();
  plan.status = "inputs_ready";
  const declaration = plan.inputSnapshots.skuRightsReview;
  delete plan.inputSnapshots.skuRightsReview;
  plan.revisionRefs = { sourceRevision: pkg.dataRevision - 1, resultRevision: pkg.dataRevision };
  pkg.c1RightsReviewRecord = createC1SkuRightsReviewRecord({ plan, sourceIdentity: pkg.g1Identity,
    sourceCandidateRevision: 20, declaredByUserId: "synthetic-owner", declaredAt: NOW,
    ownerDeclaration: { brand: { status: declaration.brand.status, name: declaration.brand.name },
      rights: { status: declaration.rights.status, basis: declaration.rights.basis }, reviewedAt: NOW, expiresAt: EXPIRES } });
  plan.inputRefs.profitModelVersion = profit.profitModelVersion;
  plan.inputSnapshots.profitModel = structuredClone(profit);
  delete plan.factVerificationVersion;
  delete plan.factsVerifiedAt;
  for (const field of ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment", "categoryRestrictions", "platformCompliance"]) {
    plan[field] = null;
  }
  pkg.schemaVersion = "product-lifecycle-v1.1";
  pkg.entityType = "SkuLifecyclePackage";
  pkg.parentOpportunityId = plan.identity.parentOpportunityId;
  pkg.supplierOptionId = plan.identity.supplierOptionId;
  pkg.inheritedSalesSnapshotRefs = [plan.inputRefs.salesSnapshotId];
  pkg.selectedSupplySnapshot = structuredClone(plan.inputSnapshots.confirmedSupplierSkuSnapshot);
  pkg.skuFacts = { source: SUPPLY_REF };
  pkg.c2FinalAssets = null;
  pkg.productionAuthorization = null;
  pkg.productionConfirmationCard = null;
  pkg.productionRecord = null;
  pkg.externalListingRecord = null;
  pkg.eVerificationRecord = null;
  pkg.profitModels = [structuredClone(profit)];
  pkg.activeProfitModelVersion = profit.profitModelVersion;
  pkg.readbackPolicy = {
    status: "not_started", maxAutomaticAttempts: 1, maxConsecutiveSameFailure: 1,
    automaticAttempts: 0, consecutiveSameFailureCount: 0, lastFailureLayer: null,
    stopReason: null, stoppedAt: null
  };
  pkg.readbackHistory = [];
  pkg.audit = { createdAt: NOW, updatedAt: NOW, history: [] };
  return pkg;
}

function keywordSourceEvidence({ productFactTerms = null } = {}) {
  const terms = productFactTerms ?? Array.from({ length: 19 }, (_, index) => ({
    term: `bath shelf keyword ${index + 1}`,
    sourceRefs: [SUPPLY_REF],
    factRefs: [SUPPLY_REF],
    sourceTrust: "owner_confirmed_supply_fact",
    matchType: "target_fact"
  }));
  return {
    fulfillment: "rfbs",
    locale: "ru-RU",
    policy: { browserAllowed: false, browserPreauthorized: false },
    healthPolicy: {
      connectorVersion: "seerfar-connector-v3",
      apiSchemaVersion: "seerfar-api-v2",
      controlledWindowId: "window:2026-08-23-pm",
      ttlMs: 3_600_000,
      suspectedSystemicFailure: false,
      standardSkus: [{ id: "standard:1" }, { id: "standard:2" }, { id: "standard:3" }],
      lastProof: {
        connectorVersion: "seerfar-connector-v3",
        apiSchemaVersion: "seerfar-api-v2",
        controlledWindowId: "window:2026-08-23-pm",
        provedAt: NOW
      }
    },
    frozenEvidence: { productFactTerms: terms, comparables: [], seedEvidence: [] }
  };
}

function seoRules() {
  return {
    rulesVersion: "seo-rules-ru-v5", locale: "ru-RU", titleMaxLength: 120, descriptionMaxLength: 1800, bulletPointLimit: 5,
    prohibitedClaims: ["unverified_brand"], evidenceRef: "config:seo-rules-ru-v5", frozenAt: NOW
  };
}

function attempt(failureClass = "true_empty") {
  const technicalFailure = failureClass !== "true_empty";
  return {
    schemaVersion: "keyword-source-attempt-v1", attemptId: "attempt:api:BATH-SHELF:18", provider: "seerfar-api", channel: "api",
    queryId: "query:BATH-SHELF:18", queryText: "bath shelf", locale: "ru-RU", targetPlatform: "ozon",
    requestId: "request:BATH-SHELF:18", receiptId: null, startedAt: NOW, completedAt: NOW,
    status: technicalFailure ? "failed" : "completed", resultCount: technicalFailure ? null : 0, failureClass, traceRef: "trace:BATH-SHELF:18"
  };
}

function metricComponent(value, name, semantic = false) {
  return {
    value,
    rawValue: value,
    raw: null,
    normalizationRule: "identity_0_100",
    conversionRule: null,
    evidenceRef: `metric:${name}:${value}`,
    observedAt: NOW,
    period: "30d"
  };
}

function providers({ failureClass = "true_empty", metricMode = "ready" } = {}) {
  let metricsCalls = 0;
  const value = {
    seerfarApi: async () => ({ attempt: attempt(failureClass), candidates: [] }),
    keywordMetrics: async ({ preparation, attemptLimit }) => {
      metricsCalls += 1;
      assert.equal(attemptLimit, 1);
      const candidates = preparation.rawCandidatePool.map((candidate, index) => {
        const semantic = metricMode === "ready" ? (index < 9 ? 90 : 75) : 60;
        const components = Object.fromEntries(Object.keys(KEYWORD_SCORING_COMPONENTS).map((name) => [name, metricComponent(name === "semanticMatch" ? semantic : 82, name)]));
        components.competitorConsensus = null;
        components.competitorCount = null;
        components.returnCancelHealth = null;
        return {
          key: `${candidate.term.toLocaleLowerCase()}\u0000${candidate.matchType}`,
          descriptionGate: { approved: true, evidenceRef: `description-gate:${index}`, reason: "冻结事实支持" },
          components
        };
      });
      return { version: "keyword-metrics-v1", preparationFingerprint: preparation.preparationFingerprint, candidates };
    }
  };
  return { value, getMetricsCalls: () => metricsCalls };
}

function input(pkg = factsCheckedPackage()) {
  return {
    candidateId: "BATH-SHELF",
    candidateRevision: 42,
    skuPackage: pkg,
    keywordSourceEvidence: keywordSourceEvidence(),
    frozenSeoRules: seoRules(),
    preparedAt: NOW,
    keywordExpiresAt: EXPIRES
  };
}

test("普通非火车SKU一次完成K2/K3并停在C1证据原子保存前", async () => {
  const provider = providers();
  const result = await prepareC1FactKeywordPipeline(input(), provider.value);
  assert.equal(result.status, "ready_for_atomic_persist");
  assert.equal(result.factVerification, "reused");
  assert.equal(result.keywordPreparation.result, "source_candidates_ready");
  assert.equal(result.k3KeywordEvidenceSnapshot.status, "ready");
  assert.deepEqual(Object.fromEntries(Object.entries(result.k3KeywordEvidenceSnapshot.groups).map(([key, items]) => [key, items.length])), {
    title_keywords: 5,
    attribute_and_tag_keywords: 4,
    description_long_tail: 10
  });
  assert.equal(result.preparedInputs.status, "ready");
  assert.equal(result.evidenceStage.status, "created");
  assert.equal(result.execution.metricProviderCalls, 1);
  assert.equal(provider.getMetricsCalls(), 1);
  assert.deepEqual(result.downstream, { c2Started: false, productionStarted: false, eReadbackStarted: false });
});

test("inputs_ready会先只读冻结输入完成事实核验，再继续K2/K3", async () => {
  const args = input(inputsReadyPackage());
  const result = await prepareC1FactKeywordPipeline(args, providers().value);
  assert.equal(result.status, "ready_for_atomic_persist");
  assert.equal(result.factVerification, "created");
  assert.equal(result.skuPackage.dataRevision, 19);
  assert.equal(result.skuPackage.c1ProductPlan.status, "facts_checked");
  assert.equal(result.skuPackage.c1ProductPlan.factVerificationVersion, "c1-fact-verification-v1.2");
  assert.deepEqual(result.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview, args.skuPackage.c1RightsReviewRecord.review);
  assert.equal(result.skuPackage.profitModels.length, 1);
  assert.equal(result.skuPackage.activeProfitModelVersion, "profit-v1");
});

test("真实冻结快照缺显式fingerprint时仅计算内容指纹，不补商品事实", async () => {
  const result = await prepareC1FactKeywordPipeline(input(), providers().value);
  assert.equal(result.bindingEvidence.salesSnapshot.versionSource, "upstream_schema_version");
  assert.equal(result.bindingEvidence.salesSnapshot.fingerprintSource, "computed_from_frozen_snapshot");
  assert.equal(result.bindingEvidence.supplySkuFacts.versionSource, "pipeline_contract_version");
  assert.equal(result.bindingEvidence.supplySkuFacts.fingerprintSource, "computed_from_frozen_snapshot");
  assert.match(result.k3CurrentBinding.salesSnapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.k3CurrentBinding.supplySkuFactsFingerprint, /^[a-f0-9]{64}$/);
});

test("K3分组不完整时明确not_ready且不进入AI/C2/D/E", async () => {
  const provider = providers({ metricMode: "insufficient" });
  const result = await prepareC1FactKeywordPipeline(input(), provider.value);
  assert.equal(result.status, "not_ready");
  assert.equal(result.k3KeywordEvidenceSnapshot.status, "needs_review");
  assert.equal(result.preparedInputs, null);
  assert.equal(result.evidenceStage, null);
  assert.equal(result.execution.aiGatewayCalls, 0);
  assert.equal(result.execution.codexDispatches, 0);
  assert.equal(provider.getMetricsCalls(), 1);
});

test("技术失败且没有冻结本地词时停止，不把失败冒充true_empty或业务失败", async () => {
  const args = input();
  args.keywordSourceEvidence = keywordSourceEvidence({ productFactTerms: [] });
  const result = await prepareC1FactKeywordPipeline(args, providers({ failureClass: "network_timeout" }).value);
  assert.equal(result.status, "not_ready");
  assert.equal(result.keywordPreparation.result, "technical_unavailable");
  assert.equal(result.gaps[0].code, "keyword_preparation_technical_unavailable");
  assert.equal(result.skuPackage.businessResult, "pending");
  assert.equal(result.evidenceStage, null);
});

test("相同输入和现有证据幂等复用，不产生第二份C1证据", async () => {
  const first = await prepareC1FactKeywordPipeline(input(), providers().value);
  const secondArgs = input();
  secondArgs.reusableKeywordSnapshot = first.k3KeywordEvidenceSnapshot;
  secondArgs.existingEvidence = first.evidenceStage.evidence;
  const second = await prepareC1FactKeywordPipeline(secondArgs, {
    seerfarApi: async () => { throw new Error("不得再次调用Seerfar"); },
    keywordMetrics: async () => { throw new Error("不得再次调用指标提供器"); }
  });
  assert.equal(second.status, "ready_for_atomic_persist");
  assert.equal(second.keywordPreparation.result, "reused_snapshot");
  assert.equal(second.execution.metricProviderCalls, 0);
  assert.equal(second.evidenceStage.status, "reused");
  assert.equal(second.evidenceStage.sharedWriteRequired, false);
});

test("跨候选与事实引用不相交均停止", async () => {
  for (const identity of [undefined, { candidateId: "OTHER-CANDIDATE" }]) {
    const args = input();
    args.skuPackage.g1Identity = identity;
    args.skuPackage.candidateId = args.candidateId;
    const before = structuredClone(args);
    let calls = 0;
    await assert.rejects(() => prepareC1FactKeywordPipeline(args, {
      seerfarApi: async () => { calls += 1; throw new Error("unexpected provider call"); }
    }), /CANDIDATE_DRIFT/);
    assert.equal(calls, 0);
    assert.deepEqual(args, before);
  }
  const wrongCandidate = input();
  wrongCandidate.candidateId = "OTHER-CANDIDATE";
  await assert.rejects(() => prepareC1FactKeywordPipeline(wrongCandidate, providers().value), /CANDIDATE_DRIFT/);

  const noIntersection = input();
  noIntersection.keywordSourceEvidence = keywordSourceEvidence({
    productFactTerms: Array.from({ length: 19 }, (_, index) => ({
      term: `unbound keyword ${index}`,
      sourceRefs: ["unrelated:source"],
      factRefs: ["unrelated:fact"],
      sourceTrust: "frozen_source",
      matchType: "target_fact"
    }))
  });
  const result = await prepareC1FactKeywordPipeline(noIntersection, providers().value);
  assert.equal(result.status, "not_ready");
  assert.ok(result.gaps.every((item) => item.code === "k3_keyword_fact_intersection_missing"));
});

test("新流水线Schema锁定一次调用、零Codex和零下游写入", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c1-fact-keyword-pipeline-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "c1-fact-keyword-pipeline-v1");
  assert.equal(schema.properties.execution.properties.metricProviderCalls.maximum, 1);
  assert.equal(schema.properties.execution.properties.aiGatewayCalls.const, 0);
  assert.equal(schema.properties.execution.properties.codexDispatches.const, 0);
  assert.equal(schema.properties.execution.properties.platformWrites.const, 0);
  assert.deepEqual(schema.properties.downstream.const, { c2Started: false, productionStarted: false, eReadbackStarted: false });
});

test("活动路径不含火车、282件、固定SKU或固定价格默认值", async () => {
  const source = await readFile(new URL("../lib/c1-fact-keyword-pipeline.mjs", import.meta.url), "utf8");
  for (const forbidden of ["CX-20260803-010", "282", "4993364145574", "1831", "火车", "паровоз"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
