import { VARIANT, phase7PassedState, platformSchemaEvidence, createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { GLOBAL_PRICING_POLICY_VERSION } from "../lib/global-pricing-policy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  C1_PRODUCT_PLAN_SCHEMA_VERSION,
  C1_FACT_VERIFICATION_VERSION,
  createC1ProductPlan,
  validateC1ProductPlan,
  validatePlatformSchemaEvidence,
  verifyC1ProductFacts,
  collectC1UnknownManifest
} from "../lib/c1-product-plan.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import {
  C1_SEO_DRAFT_VERSION,
  createC1SeoDraft,
  validateC1SeoDraft
} from "../lib/c1-seo-draft.mjs";
import {
  C2_ASSET_LIFECYCLE_VERSION,
  selectConfirmedFinalUploadsForProduction,
  validateC2AssetLifecycle
} from "../lib/c2-asset-lifecycle.mjs";
import {
  FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION,
  createFinalProductPlanConfirmationCard,
  validateFinalProductPlanConfirmationCard
} from "../lib/final-product-plan-confirmation-card.mjs";
import {
  PRODUCTION_AUTHORIZATION_VERSION,
  createProductionAuthorization,
  readAuthorizedProductionSnapshot,
  validateProductionAuthorization
} from "../lib/production-authorization.mjs";
import { packageFixture, assetRegions, finalAssets, ownerDecision, productionAuthorizationInputFixture, authorizedProductionFixture, historicalAuthorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { createC2SoftwareContainer, prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from "../lib/c2-software-orchestrator.mjs";
import { isCanonicalFrozenRef } from "../lib/production-contract-primitives.mjs";


async function phase8InputsReadyState() {
  const state = await phase7PassedState();
  return createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  });
}

test("旧v1估算通过记录保留可读但不得创建新的C1", async () => {
  const state = await phase7PassedState();
  const skuPackage = structuredClone(state.skuPackage);
  const profit = skuPackage.profitModels.find(item => item.profitModelVersion === skuPackage.activeProfitModelVersion);
  profit.calculation.version = "profit-calculation-v1-unrounded";
  profit.pricingPolicyVersion = GLOBAL_PRICING_POLICY_VERSION; // 真实旧记录只带旧全局定价政策版本，不带新版成本政策快照版本
  profit.commissionMode = "estimated";
  profit.exactCommissionRequiredAtC = true;
  delete profit.calculationType;
  delete profit.exactCommissionRequiredForFormalB;
  const before = JSON.stringify(skuPackage);
  const validation = validateSkuLifecyclePackage(skuPackage);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.throws(() => createC1ProductPlan({
    opportunityPackage: state.opportunityPackage, skuPackage,
    platformSchemaEvidence: platformSchemaEvidence(), createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_GATE_REJECTED/);
  assert.equal(JSON.stringify(skuPackage), before);
});

async function phase9AFactsCheckedState() {
  const phase8 = await phase8InputsReadyState();
  return verifyC1ProductFacts({
    skuPackage: phase8.skuPackage,
    verifiedAt: "2026-08-12T12:40:00.000Z"
  });
}

function competitorTextSnapshot() {
  return {
    snapshotId: "competitor-text:CX-20260803-010:2026-08-07",
    sourceSalesSnapshotId: "legacy-sales:CX-20260803-010",
    observedAt: "2026-08-07T10:29:05.906Z",
    evidenceRef: "sales-snapshot:legacy-sales:CX-20260803-010#competitor_text",
    texts: [{
      textId: "ozon-competitor-title-3126033809",
      text: "Сложная трехмерная головоломка, деревянный паровозик 3D",
      sourceRef: "https://www.ozon.ru/product/3126033809/",
      role: "buyer_language_reference_only"
    }]
  };
}

function keywordEvidence() {
  return {
    evidenceId: "seo-evidence:CX-20260803-010:reused:2026-08-12",
    status: "ready",
    targetPlatform: "ozon",
    targetSkuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
    sourcePlatform: "ozon",
    collectionMode: "reused_verified_evidence",
    pointsSpent: 0,
    observedAt: "2026-08-12T13:00:00.000Z",
    reuseEvidenceNote: "单SKU测试证据；目标平台、精确SKU事实、市场文本和证据时间已匹配。",
    keywords: [
      {
        query: "3D-пазл паровоз",
        group: "core_product_type",
        keywordEvidenceRef: "seerfar:query:3d-pazl-parovoz:source-3126033809",
        sourcePlatform: "ozon",
        sourceSku: "3126033809",
        relevanceStatus: "retained",
        factBindingPaths: [
          "platformCategory.categoryName",
          "exactSkuVerification.variantKey"
        ],
        reason: "与已确认平台产品类型和精确豪华小火车SKU一致"
      },
      {
        query: "деревянный 3D-пазл",
        group: "material",
        keywordEvidenceRef: "seerfar:query:derevyannyy-3d-pazl:source-3126033809",
        sourcePlatform: "ozon",
        sourceSku: "3126033809",
        relevanceStatus: "retained",
        factBindingPaths: [
          "platformCategory.categoryName",
          "productAttributes.material"
        ],
        reason: "与已确认3D拼图类目和DVP木纤维板材质一致"
      },
      {
        query: "механический паровоз 320 деталей",
        group: "differentiator",
        keywordEvidenceRef: "seerfar:query:mechanical-320:source-3126033809",
        sourcePlatform: "ozon",
        sourceSku: "3126033809",
        relevanceStatus: "retained",
        factBindingPaths: ["platformCompliance.assessment"],
        reason: "冻结事实未确认机械机制和320件，应拒绝"
      }
    ]
  };
}

test("CX-20260803-010 enters C1 from exactly four frozen upstream inputs", async () => {
  const state = await phase7PassedState();
  const result = createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  });
  const plan = result.c1ProductPlan;

  assert.equal(plan.schemaVersion, C1_PRODUCT_PLAN_SCHEMA_VERSION);
  assert.equal(plan.status, "inputs_ready");
  assert.deepEqual(plan.inputRefs, {
    salesSnapshotId: "legacy-sales:CX-20260803-010",
    selectedSupplySnapshotId: "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8:4993364145574",
    profitModelVersion: "profit-v1",
    platformSchemaEvidenceId: "schema:ozon:dandanshu:17028665:92935:2026-08-12"
  });
  assert.equal(plan.inputSnapshots.salesSnapshot.snapshotId, plan.inputRefs.salesSnapshotId);
  assert.equal(plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.supplierSkuId, "4993364145574");
  assert.equal(plan.inputSnapshots.profitModel.result, "passed");
  assert.equal(plan.inputSnapshots.platformSchemaRules.requiredFields.length, 3);
  assert.deepEqual(validateC1ProductPlan(plan), { valid: true, errors: [] });
  assert.deepEqual(validatePlatformSchemaEvidence(plan.inputSnapshots.platformSchemaRules), { valid: true, errors: [] });
});

test("C1 plan validation reports malformed frozen required fields and source keys without throwing", () => {
  const { checked } = createFormalC1C2Fixture();
  const malformedFields = [null, {}, "brand", true, [null], ["brand"], [[]], [{}], [{ fieldKey: 1 }], Array(1),
    [{ fieldKey: " " }], [{ fieldKey: "brand", label: null, required: true }],
    [{ fieldKey: "brand", label: " ", required: true }], [{ fieldKey: "brand", label: "品牌", required: "true" }],
    [{ fieldKey: "brand", label: "品牌", required: true }, { fieldKey: "brand", label: "品牌", required: true }]];
  const malformedKeys = [null, {}, "brand", true, 1, [null], [{}], [[]], [1], [" "], Array(1)];
  const cases = [
    ...malformedFields.map((value, index) => [`requiredFields case ${index}`, schema => { schema.requiredFields = value; }]),
    ...malformedKeys.map((value, index) => [`sourceAttributeKeys case ${index}`, schema => { schema.requiredFields[0].sourceAttributeKeys = value; }])
  ];
  for (const [label, corrupt] of cases) {
    const plan = structuredClone(checked.c1ProductPlan);
    corrupt(plan.inputSnapshots.platformSchemaRules);
    const before = structuredClone(plan);
    const schemaResult = validatePlatformSchemaEvidence(plan.inputSnapshots.platformSchemaRules);
    assert.equal(schemaResult.valid, false, label);
    assert.ok(schemaResult.errors.some(error => error.path.startsWith("requiredFields")), label);
    const result = validateC1ProductPlan(plan);
    assert.equal(result.valid, false, label);
    assert.ok(result.errors.some(error => error.path.startsWith("inputSnapshots.platformSchemaRules.requiredFields")), label);
    assert.ok(result.errors.some(error => error.path === "platformCompliance.skuRightsReview" && error.message === "C1_SKU_RIGHTS_REVIEW_INVALID"), label);
    assert.deepEqual(plan, before, label);
  }
});

test("unknown卖家样本经A正式放行且B利润达标后正常进入C1", async () => {
  const state = await phase7PassedState({ sellerType: "unknown" });
  assert.equal(state.skuPackage.businessResult, "passed");
  assert.ok(state.skuPackage.profitModels[0].unitProfitRmb >= 20);
  assert.ok(state.skuPackage.profitModels[0].profitMargin >= 0.25);
  const result = createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:31:00.000Z"
  });
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.ownerAction, "none");
  assert.equal(result.c1ProductPlan.inputSnapshots.salesSnapshot.sellerType, "unknown");
});

test("C1 uses no external access and does not generate SEO, attributes, assets or production data", async () => {
  const state = await phase7PassedState();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("第8阶段禁止访问Ozon、WB或1688");
  };
  try {
    const result = createC1ProductPlan({
      ...state,
      platformSchemaEvidence: platformSchemaEvidence(),
      createdAt: "2026-08-12T12:30:00.000Z"
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.c1ProductPlan.externalAccesses, []);
    assert.equal(result.c1ProductPlan.finalSeo, null);
    assert.equal(result.c1ProductPlan.finalAttributes, null);
    assert.equal(result.c1ProductPlan.complianceDecision, null);
    assert.equal(result.c1ProductPlan.generatedAssets, null);
    assert.equal(result.c1ProductPlan.productionPayload, null);
    assert.equal(result.skuPackage.c2FinalAssets, null);
    assert.equal(result.skuPackage.productionAuthorization, null);
    assert.equal(result.skuPackage.productionRecord, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C1 preserves the complete B result and exact supplier SKU identity", async () => {
  const state = await phase7PassedState();
  const modelsBefore = structuredClone(state.skuPackage.profitModels);
  const activeBefore = state.skuPackage.activeProfitModelVersion;
  const identityBefore = {
    supplierOptionId: state.skuPackage.supplierOptionId,
    supplierSkuId: state.skuPackage.supplierSkuId,
    variantKey: state.skuPackage.variantKey
  };
  const result = createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  });

  assert.deepEqual(result.skuPackage.profitModels, modelsBefore);
  assert.equal(result.skuPackage.activeProfitModelVersion, activeBefore);
  assert.equal(result.skuPackage.profitModels[0].result, "passed");
  assert.deepEqual({
    supplierOptionId: result.skuPackage.supplierOptionId,
    supplierSkuId: result.skuPackage.supplierSkuId,
    variantKey: result.skuPackage.variantKey
  }, identityBefore);
  assert.equal(result.c1ProductPlan.profitRecalculated, false);
  assert.equal(result.c1ProductPlan.skuReplaced, false);
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.businessResult, "pending");
  assert.equal(result.skuPackage.technicalStatus, "completed");
  assert.equal(validateSkuLifecyclePackage(result.skuPackage).valid, true);
});

test("C1 rejects a B result that is not passed without partial mutation", async () => {
  const state = await phase7PassedState();
  const inputBefore = JSON.stringify(state.skuPackage);
  const rejected = structuredClone(state.skuPackage);
  rejected.businessResult = "rejected";

  assert.throws(() => createC1ProductPlan({
    opportunityPackage: state.opportunityPackage,
    skuPackage: rejected,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_GATE_REJECTED|ProfitModel校验失败/);
  assert.equal(JSON.stringify(state.skuPackage), inputBefore);
  assert.equal(state.skuPackage.c1ProductPlan, null);
});

test("C1 stops when platform Schema evidence is missing or belongs to another store", async () => {
  const state = await phase7PassedState();
  assert.throws(() => createC1ProductPlan({
    ...state,
    platformSchemaEvidence: null,
    createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_INPUT_GAP: 平台Schema证据校验失败/);

  const wrongStore = platformSchemaEvidence();
  wrongStore.store = "Miska";
  assert.throws(() => createC1ProductPlan({
    ...state,
    platformSchemaEvidence: wrongStore,
    createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_INPUT_GAP: 平台Schema不适用于当前平台或店铺/);
});

test("published C1 schema freezes the four inputs and all phase-8 exclusions", async () => {
  const url = new URL("../schema/c1-product-plan-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.ok(schema.properties.status.enum.includes("inputs_ready"));
  for (const field of ["salesSnapshotId", "selectedSupplySnapshotId", "profitModelVersion", "platformSchemaEvidenceId"]) {
    assert.ok(schema.properties.inputRefs.required.includes(field), field);
  }
  for (const field of ["finalSeo", "finalAttributes", "complianceDecision", "generatedAssets", "productionPayload"]) {
    assert.equal(schema.properties[field].type, "null");
  }
});

test("C1 category identity is sourced from the frozen Schema and absent IDs remain unknown", async () => {
  const state = await phase7PassedState();
  for (const categoryId of ["category:synthetic:3d-puzzle", undefined]) {
    const evidence = platformSchemaEvidence();
    if (categoryId !== undefined) evidence.categoryId = categoryId;
    else { delete evidence.descriptionCategoryId; delete evidence.typeId; }
    const inputs = createC1ProductPlan({ ...state, platformSchemaEvidence: evidence, createdAt: "2026-08-12T12:30:00.000Z" });
    const before = structuredClone(inputs);
    const result = verifyC1ProductFacts({ skuPackage: inputs.skuPackage, verifiedAt: "2026-08-12T12:40:00.000Z" });
    const field = result.c1ProductPlan.platformCategory.categoryId;
    assert.equal(field.value, categoryId ?? "unknown");
    assert.equal(field.verificationStatus, categoryId === undefined ? "unknown" : "confirmed");
    assert.deepEqual(field.sourceRefs, [`${evidence.evidenceId}#/categoryId`]);
    assert.equal(result.c1ProductPlan.platformCategory.status.value, categoryId === undefined ? "incomplete" : "identified");
    assert.deepEqual(inputs, before);
  }
});

test("9A generates all seven sourced fact sections from the frozen C1 input package", async () => {
  const phase8 = await phase8InputsReadyState();
  const result = verifyC1ProductFacts({
    skuPackage: phase8.skuPackage,
    verifiedAt: "2026-08-12T12:40:00.000Z"
  });
  const plan = result.c1ProductPlan;

  assert.equal(plan.status, "facts_checked");
  assert.equal(plan.factVerificationVersion, C1_FACT_VERIFICATION_VERSION);
  for (const field of [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ]) assert.equal(typeof plan[field], "object", field);
  assert.equal(plan.exactSkuVerification.supplierSkuId.value, "4993364145574");
  assert.match(plan.exactSkuVerification.supplierSkuId.sourceRefs[0], /supplierSku\/supplierSkuId/);
  assert.equal(plan.exactSkuVerification.status.value, "verified");
  assert.ok(plan.productAttributes.status.sourceRefs.length > 0);
  assert.equal(plan.platformCategory.descriptionCategoryId.value, "17028665");
  assert.equal(plan.schemaSnapshot.schemaRevision.value, "ozon-schema:17028665:92935:2026-08-12");
});

test("9A keeps unsupported brand, battery, restrictions and compliance explicitly unknown", async () => {
  const phase8 = await phase8InputsReadyState();
  const result = verifyC1ProductFacts({
    skuPackage: phase8.skuPackage,
    verifiedAt: "2026-08-12T12:40:00.000Z"
  });
  const plan = result.c1ProductPlan;
  const brand = plan.productAttributes.requiredPlatformFields.find((field) => field.fieldKey === "brand");

  assert.equal(brand.fact.value, "unknown");
  assert.equal(brand.fact.verificationStatus, "unknown");
  assert.equal(plan.batteryAssessment.assessment.value, "unknown");
  assert.equal(plan.batteryAssessment.containsBattery.value, "unknown");
  assert.equal(plan.categoryRestrictions.restrictions.value, "unknown");
  assert.equal(plan.platformCompliance.assessment.value, "unknown");
  assert.ok(brand.fact.sourceRefs.every((ref) => !ref.includes("image")));
});

test("9A makes zero platform calls and preserves B result, SKU, and all excluded outputs", async () => {
  const phase8 = await phase8InputsReadyState();
  const profitBefore = structuredClone(phase8.skuPackage.profitModels);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("9A禁止重新访问销售或供应平台");
  };
  try {
    const result = verifyC1ProductFacts({
      skuPackage: phase8.skuPackage,
      verifiedAt: "2026-08-12T12:40:00.000Z"
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.skuPackage.profitModels, profitBefore);
    assert.equal(result.skuPackage.activeProfitModelVersion, "profit-v1");
    assert.equal(result.skuPackage.profitModels[0].result, "passed");
    assert.equal(result.skuPackage.supplierSkuId, phase8.skuPackage.supplierSkuId);
    assert.equal(result.skuPackage.variantKey, phase8.skuPackage.variantKey);
    assert.deepEqual(result.c1ProductPlan.externalAccesses, []);
    assert.equal(result.c1ProductPlan.profitRecalculated, false);
    assert.equal(result.c1ProductPlan.finalSeo, null);
    assert.equal(result.c1ProductPlan.generatedAssets, null);
    assert.equal(result.c1ProductPlan.productionPayload, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("9A accepts a fact only from a declared frozen field mapping, never from title or images", async () => {
  const phase8 = await phase8InputsReadyState();
  const skuPackage = structuredClone(phase8.skuPackage);
  const plan = skuPackage.c1ProductPlan;
  plan.inputSnapshots.salesSnapshot.title = "某品牌带电木质玩具";
  plan.inputSnapshots.salesSnapshot.imageRefs = ["https://example.test/looks-powered.jpg"];
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.material = "unknown";
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.powerProfile = "unknown";
  plan.inputSnapshots.platformSchemaRules.requiredFields[0].sourceAttributeKeys = ["品牌"];

  const result = verifyC1ProductFacts({ skuPackage, verifiedAt: "2026-08-12T12:40:00.000Z" });
  const brand = result.c1ProductPlan.productAttributes.requiredPlatformFields.find((field) => field.fieldKey === "brand");
  assert.equal(result.c1ProductPlan.productAttributes.material.value, "unknown");
  assert.equal(result.c1ProductPlan.batteryAssessment.assessment.value, "unknown");
  assert.equal(brand.fact.value, "unknown");
});

test("9B creates four Russian SEO draft outputs with evidence on every retained keyword", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const result = createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    createdAt: "2026-08-12T13:05:00.000Z"
  });
  const plan = result.c1ProductPlan;

  assert.equal(plan.status, "seo_draft_ready");
  assert.equal(plan.seoEvidenceLayer.draftVersion, C1_SEO_DRAFT_VERSION);
  assert.equal(plan.seoTitleDraft.status, "draft_only");
  assert.match(plan.seoTitleDraft.text, /3D-пазл паровоз/);
  assert.equal(plan.descriptionDraft.status, "draft_only");
  assert.ok(plan.bulletPointsDraft.length >= 2);
  assert.equal(plan.searchKeywordsDraft.keywords.length, 2);
  for (const keyword of plan.searchKeywordsDraft.keywords) {
    assert.ok(keyword.evidenceRefs.length > 0);
    assert.ok(keyword.factRefs.length > 0);
  }
  assert.deepEqual(validateC1SeoDraft(plan), { valid: true, errors: [] });
});

test("9B rejects an evidenced keyword when verified product facts do not support it", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const result = createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    createdAt: "2026-08-12T13:05:00.000Z"
  });
  const rejected = result.c1ProductPlan.seoEvidenceLayer.keywordsRejected;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].query, "механический паровоз 320 деталей");
  assert.equal(rejected[0].reason, "unsupported_by_verified_product_facts");
  assert.ok(rejected[0].evidenceRefs.length > 0);
  assert.doesNotMatch(result.c1ProductPlan.seoTitleDraft.text, /320|механическ/i);
  assert.doesNotMatch(result.c1ProductPlan.descriptionDraft.text, /320|механическ/i);
});

test("9B preserves all 9A facts and B profit while making zero external or production writes", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const factsBefore = Object.fromEntries([
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ].map((field) => [field, structuredClone(phase9A.c1ProductPlan[field])]));
  const profitBefore = structuredClone(phase9A.skuPackage.profitModels);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("9B禁止访问平台");
  };
  try {
    const result = createC1SeoDraft({
      skuPackage: phase9A.skuPackage,
      competitorTextSnapshot: competitorTextSnapshot(),
      keywordEvidence: keywordEvidence(),
      createdAt: "2026-08-12T13:05:00.000Z"
    });
    assert.equal(fetchCalls, 0);
    for (const [field, value] of Object.entries(factsBefore)) assert.deepEqual(result.c1ProductPlan[field], value);
    assert.deepEqual(result.skuPackage.profitModels, profitBefore);
    assert.equal(result.skuPackage.businessPhase, "C1");
    assert.equal(result.skuPackage.c2FinalAssets, null);
    assert.equal(result.skuPackage.productionAuthorization, null);
    assert.equal(result.skuPackage.productionRecord, null);
    assert.equal(result.c1ProductPlan.finalSeo, null);
    assert.equal(result.c1ProductPlan.generatedAssets, null);
    assert.equal(result.c1ProductPlan.productionPayload, null);
    assert.equal(result.c1ProductPlan.seoEvidenceLayer.productionWrites, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("9B stops if keyword evidence has no fact binding or is not verified reusable evidence", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const noBinding = keywordEvidence();
  noBinding.keywords[0].factBindingPaths = [];
  assert.throws(() => createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: noBinding,
    createdAt: "2026-08-12T13:05:00.000Z"
  }), /C1_SEO_INPUT_GAP: 关键词证据无效/);

  const paidOrFresh = keywordEvidence();
  paidOrFresh.collectionMode = "live_lookup";
  assert.throws(() => createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: paidOrFresh,
    createdAt: "2026-08-12T13:05:00.000Z"
  }), /C1_SEO_INPUT_GAP: 关键词证据无效/);
});

const C2_TIME = "2026-08-22T07:00:00.000Z";
function initializedC2(source = packageFixture({ stableStoreId: "dandanshu", executableOzon: true })) {
  return createC2SoftwareContainer({ skuPackage: source, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: C2_TIME });
}
function confirmInput() {
  const initialized = initializedC2();
  const finalManifest = prepareC2FinalUploadManifest({ skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: C2_TIME });
  return { skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalManifest, ownerDecision: ownerDecision(finalManifest), confirmedAt: C2_TIME };
}
function cardSource() {
  const input = productionAuthorizationInputFixture();
  const sku = structuredClone(input.skuPackage);
  sku.productionConfirmationCard = null;
  return sku;
}

test("10 creates three independent C2 asset regions without generation or production", () => {
  const result = initializedC2();
  const c2 = result.skuPackage.c2FinalAssets;
  assert.equal(c2.schemaVersion, C2_ASSET_LIFECYCLE_VERSION);
  assert.equal(c2.status, "awaiting_final_uploads");
  assert.equal(c2.assets.collected.length, 1);
  assert.equal(c2.assets.aiDrafts.length, 1);
  assert.deepEqual(c2.assets.finalUploads, []);
  assert.equal(c2.platformUploads, 0);
  assert.equal(c2.productionStarted, false);
  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.deepEqual(validateC2AssetLifecycle(c2), { valid: true, errors: [] });
});

test("10 never exposes collected assets to the future D asset selector", () => {
  const sku = initializedC2().skuPackage;
  assert.equal(sku.c2FinalAssets.assets.collected[0].productionEligible, false);
  assert.throws(() => selectConfirmedFinalUploadsForProduction(sku), /C2_OWNER_CONFIRMATION_REQUIRED/);
});

test("10 keeps draft images isolated and does not promote them into finalUploads", () => {
  const sku = initializedC2().skuPackage;
  assert.equal(sku.c2FinalAssets.assets.aiDrafts[0].productionEligible, false);
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads, []);
  const assets = finalAssets(); assets[0].sourceType = "ai_generated_draft";
  assert.throws(() => prepareC2FinalUploadManifest({ skuPackage: sku, expectedDataRevision: 8, finalUploadAssets: assets, preparedAt: C2_TIME }), /C2_/);
  assert.equal(sku.c2FinalAssets.status, "awaiting_final_uploads");
});

test("10 requires owner confirmation and accepts only the approved final upload manifest", () => {
  const input = confirmInput();
  const before = structuredClone(input);
  for (const owner of [null, { ...input.ownerDecision, approvedAssetIds: input.ownerDecision.approvedAssetIds.toReversed() }]) {
    assert.throws(() => confirmC2SoftwareFinalUploads({ ...input, ownerDecision: owner }), /C2_/);
  }
  const confirmed = confirmC2SoftwareFinalUploads(input);
  const selected = selectConfirmedFinalUploadsForProduction(confirmed.skuPackage);
  assert.equal(selected.assets.length, 2);
  assert.equal(selected.sourceArea, "assets.finalUploads");
  assert.equal(selected.collectedIncluded, false);
  assert.equal(selected.aiDraftsIncluded, false);
  assert.equal(selected.productionExecuted, false);
  assert.deepEqual(input, before);
});

test("10 preserves product facts, C1 drafts and B profit throughout C2 setup", () => {
  const source = packageFixture({ stableStoreId: "dandanshu", executableOzon: true });
  const before = structuredClone(source);
  const result = initializedC2(source);
  assert.deepEqual(result.skuPackage.c1ProductPlan, before.c1ProductPlan);
  assert.deepEqual(result.skuPackage.profitModels, before.profitModels);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.deepEqual(source, before);
});

test("published C2 schema freezes the three regions and D read policy", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.assets.required, ["collected", "aiDrafts", "finalUploads"]);
  assert.equal(schema.properties.platformUploads.const, 0);
  assert.equal(schema.properties.productionStarted.const, false);
});

test("10 rejects a fake completed C2 shell at the final card gate", () => {
  const source = initializedC2().skuPackage;
  const fake = structuredClone(source); fake.c2FinalAssets.status = "completed";
  assert.throws(() => createFinalProductPlanConfirmationCard({ skuPackage: fake, createdAt: C2_TIME }), /C2|生命周期/);
  assert.equal(source.productionAuthorization, null);
});

test("11 creates one complete owner-facing final product plan confirmation card", () => {
  const result = createFinalProductPlanConfirmationCard({ skuPackage: cardSource(), createdAt: C2_TIME });
  const card = result.confirmationCard;
  assert.equal(card.schemaVersion, FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION);
  assert.equal(card.status, "awaiting_owner_business_confirmation");
  assert.equal(card.ownerDecision, null);
  assert.equal(card.productInformation.sku.value.supplierSkuId, "SHELF-WHITE");
  assert.equal(card.productInformation.targetPlatform.value.platform, "ozon");
  assert.equal(card.productInformation.targetPlatform.value.store, "dandanshu");
  assert.equal(card.profitResult.recommendedSalePrice.value.cny, 151.78);
  assert.deepEqual(validateFinalProductPlanConfirmationCard(card), { valid: true, errors: [] });
});

test("11 card reads frozen C1 facts and all four drafts rather than later mutable fields", () => {
  const source = cardSource();
  const frozen = structuredClone(source.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot);
  source.c1ProductPlan.seoTitleDraft.text = "Later unapproved text";
  const before = structuredClone(source);
  const result = createFinalProductPlanConfirmationCard({ skuPackage: source, createdAt: C2_TIME });
  const card = result.confirmationCard;
  assert.deepEqual(card.c1Facts.productAttributes, frozen.productAttributes);
  assert.deepEqual(card.c1Facts.batteryStatus, frozen.batteryAssessment);
  assert.deepEqual(card.c1Facts.platformCompliance, frozen.platformCompliance);
  assert.deepEqual(card.seoDraft.title, frozen.seoTitleDraft);
  assert.deepEqual(card.seoDraft.description, frozen.descriptionDraft);
  assert.deepEqual(card.seoDraft.bulletPoints, frozen.bulletPointsDraft);
  assert.deepEqual(card.seoDraft.searchKeywords, frozen.searchKeywordsDraft);
  assert.deepEqual(source, before);
});

test("11 card only reads owner-confirmed finalUploads and excludes reference regions", () => {
  const source = cardSource();
  const card = createFinalProductPlanConfirmationCard({ skuPackage: source, createdAt: C2_TIME }).confirmationCard;
  assert.deepEqual(card.c2Assets.finalUploads.map(asset => asset.assetId), finalAssets().map(asset => asset.assetId));
  assert.equal(Object.hasOwn(card.c2Assets, "collected"), false);
  assert.equal(Object.hasOwn(card.c2Assets, "aiDrafts"), false);
  assert.ok(card.c2Assets.finalUploads.every(asset => asset.ownerConfirmed && asset.productionEligible));
});

test("11 unverified required C1 facts stop before a final business card can be approved", () => {
  const source = packageFixture({ stableStoreId: "dandanshu", executableOzon: true });
  source.c1ProductPlan.productAttributes.requiredPlatformFields[0].fact = { value: "unknown", verificationStatus: "unknown", sourceRefs: [] };
  const before = structuredClone(source);
  assert.throws(() => productionAuthorizationInputFixture({ sourceSkuPackage: source }), /C2素材包校验失败|C2_/);
  assert.deepEqual(source, before);
});

test("11 remains C2 without D authorization, writes, uploads, automatic approval or SKU revision drift", () => {
  const source = cardSource();
  const before = structuredClone(source);
  const result = createFinalProductPlanConfirmationCard({ skuPackage: source, createdAt: C2_TIME });
  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.equal(result.skuPackage.dataRevision, before.dataRevision);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.deepEqual(result.skuPackage.c2FinalAssets, before.c2FinalAssets);
  assert.deepEqual(result.skuPackage.profitModels, before.profitModels);
  assert.equal(result.confirmationCard.productionBoundary.productionAuthorized, false);
  assert.equal(result.confirmationCard.productionBoundary.dStarted, false);
  assert.equal(result.confirmationCard.productionBoundary.platformWrites, 0);
  assert.equal(result.confirmationCard.productionBoundary.requiresSeparateExactAuthorization, true);
  assert.equal(result.confirmationCard.ownerDecision, null);
});

test("11 refuses to generate a card before the final manifest is owner-confirmed", () => {
  const awaiting = initializedC2().skuPackage;
  assert.throws(() => createFinalProductPlanConfirmationCard({ skuPackage: awaiting, createdAt: C2_TIME }), /FINAL_PLAN_CARD_GATE_REJECTED/);
});

test("published final confirmation card schema freezes owner and production boundaries", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/final-product-plan-confirmation-card-v1.1.schema.json", import.meta.url), "utf8"));
  assert.ok(schema.properties.status.enum.includes("awaiting_owner_business_confirmation"));
  assert.equal(schema.properties.c2Assets.properties.sourceArea.const, "assets.finalUploads");
  for (const field of ["productionAuthorized", "dStarted"]) assert.equal(schema.properties.productionBoundary.properties[field].const, false);
  assert.equal(schema.properties.productionBoundary.properties.platformWrites.const, 0);
  assert.equal(schema.properties.productionBoundary.properties.requiresSeparateExactAuthorization.const, true);
});

test("12 converts one exact authenticated owner decision into a locked authorization", () => {
  const input = productionAuthorizationInputFixture({ publishScope: "create_draft_only" });
  const result = createProductionAuthorization(input);
  const authorization = result.productionAuthorization;
  assert.equal(authorization.schemaVersion, PRODUCTION_AUTHORIZATION_VERSION);
  assert.equal(authorization.status, "confirmed");
  assert.equal(authorization.confirmedBy, "owner");
  assert.equal(authorization.confirmedByActorId, authorization.authorizedByActorId);
  assert.equal(authorization.ownerConfirmation.schemaVersion, "production-owner-confirmation-v2");
  assert.equal(authorization.ownerAuthorization.role, "owner");
  assert.equal(Object.hasOwn(authorization, "technicalAuthorization"), false);
  assert.equal(authorization.sourceCandidateRevision, input.sourceCandidateRevision);
  assert.equal(authorization.authorizedDataRevision, input.skuPackage.dataRevision);
  assert.deepEqual(authorization.lockedScope.storeRef, input.skuPackage.g1Identity.storeRef);
  assert.equal(authorization.lockedScope.supplierSkuId, "SHELF-WHITE");
  assert.equal(authorization.lockedScope.merchantSku, "MERCHANT-SHELF-001");
  assert.deepEqual(authorization.lockedScope.buyerTargetPrice, { amount: 1831, currency: "RUB" });
  assert.deepEqual(authorization.lockedScope.platformWritePrice, { amount: 151.78, currency: "CNY" });
  assert.equal(authorization.lockedScope.stock, 100);
  assert.equal(authorization.lockedScope.finalUploads.length, 2);
  assert.equal(authorization.lockedScope.publishScope, "create_draft_only");
  assert.deepEqual(validateProductionAuthorization(authorization), { valid: true, errors: [] });
});

test("12 requires owner approval of the exact card and never auto-authorizes", () => {
  const input = productionAuthorizationInputFixture();
  const before = structuredClone(input);
  for (const change of [
    value => { value.commercialDecision = null; }, value => { value.ownerActor = null; },
    value => { value.skuPackage.productionConfirmationCard.cardId = "another"; },
    value => { value.skuPackage.c2FinalAssets.productionAuthorizationPreparation.preparationFingerprint = "a".repeat(64); }
  ]) {
    const changed = structuredClone(input); change(changed);
    assert.throws(() => createProductionAuthorization(changed), /PRODUCTION_|ProductionAuthorization|ACTOR_|C2素材包校验失败:productionAuthorizationPreparation/);
  }
  assert.deepEqual(input, before);
});

test("12 blocks production when the frozen B result uses an estimated commission", () => {
  const source = packageFixture({ stableStoreId: "dandanshu", executableOzon: true });
  source.profitModels[0].commissionMode = "estimated";
  assert.throws(() => authorizedProductionFixture({ sourceSkuPackage: source }), /commission|佣金|PRODUCTION_|C2_/);
  assert.equal(source.productionAuthorization, null);
});

test("12 blocks authorization when required C1 facts remain unknown", () => {
  const source = packageFixture({ stableStoreId: "dandanshu", executableOzon: true });
  source.c1ProductPlan.platformCompliance.assessment = { value: "unknown", verificationStatus: "unknown", sourceRefs: [] };
  assert.throws(() => authorizedProductionFixture({ sourceSkuPackage: source }), /C2素材包校验失败|C2_|PRODUCTION_/);
  assert.equal(source.productionAuthorization, null);
});

test("12 locks SKU, content, price, stock and final assets against later source changes", () => {
  const input = structuredClone(productionAuthorizationInputFixture());
  const result = createProductionAuthorization(input);
  const frozen = structuredClone(result.productionAuthorization);
  input.skuPackage.c1ProductPlan.seoTitleDraft.text = "Later text";
  input.commercialDecision.platformWritePrice.amount = 1;
  assert.deepEqual(result.productionAuthorization, frozen);
  assert.throws(() => { result.productionAuthorization.lockedScope.stock = 1; }, TypeError);
  const readback = readAuthorizedProductionSnapshot({ productionAuthorization: result.productionAuthorization, candidateId: input.candidateId,
    candidateRevision: result.productionAuthorization.resultCandidateRevision, skuPackage: result.skuPackage, checkedAt: C2_TIME });
  assert.deepEqual(readback, frozen);
});

test("12 rejects scope expansion and records replacement controls as false", () => {
  const input = productionAuthorizationInputFixture();
  const expanded = structuredClone(input); expanded.commercialDecision.allowedWriteFields.push("advertising");
  assert.throws(() => createProductionAuthorization(expanded), /PRODUCTION_|ProductionAuthorization/);
  const authorization = createProductionAuthorization(input).productionAuthorization;
  for (const field of ["scopeExpansionAllowed", "fieldMutationAllowed", "skuReplacementAllowed", "assetReplacementAllowed"]) assert.equal(authorization[field], false);
  assert.equal(authorization.readPolicy, "authorization_snapshot_only");
});

test("12 stays in C2 and creates no execution intent, upload, product, D or E write", () => {
  const input = productionAuthorizationInputFixture();
  const before = structuredClone(input);
  const result = createProductionAuthorization(input);
  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.equal(result.skuPackage.businessResult, "passed");
  assert.equal(result.skuPackage.ownerAction, "none");
  assert.equal(result.skuPackage.productionRecord, null);
  assert.deepEqual(result.skuPackage.c1ProductPlan, before.skuPackage.c1ProductPlan);
  assert.deepEqual(result.skuPackage.profitModels, before.skuPackage.profitModels);
  assert.equal(result.productionAuthorization.productionExecuted, false);
  assert.equal(result.productionAuthorization.platformWrites, 0);
  assert.equal(result.dHandoff.status, "awaiting_explicit_d_start");
  for (const field of ["productionPlanCreated", "executionIntentCreated", "softwareJobCreated", "dWritePermissionGranted"]) assert.equal(result.dHandoff[field], false);
  assert.equal(result.dHandoff.externalRequests, 0);
  assert.equal(result.dHandoff.platformWrites, 0);
  assert.deepEqual(input, before);
});

test("published ProductionAuthorization schema freezes every required lock and no-write boundary", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/production-authorization-v1.1.schema.json", import.meta.url), "utf8"));
  const scope = schema.$defs.lockedScope;
  for (const field of ["platform", "storeRef", "skuPackageId", "supplierSkuId", "merchantSku", "warehouseRef", "credentialAlias", "finalCardInputSnapshot",
    "buyerTargetPrice", "platformWritePrice", "priceConversion", "stock", "finalManifestVersion", "finalUploads", "publishScope", "exclusions", "allowedWriteFields"]) assert.ok(scope.required.includes(field), field);
  assert.equal(scope.properties.stock.type, "integer");
  assert.equal(scope.properties.stock.minimum, 0);
  for (const field of ["scopeExpansionAllowed", "fieldMutationAllowed", "skuReplacementAllowed", "assetReplacementAllowed", "productionExecuted"]) assert.equal(schema.properties[field].const, false);
  assert.equal(schema.properties.readPolicy.const, "authorization_snapshot_only");
  assert.equal(schema.properties.platformWrites.const, 0);
});

test("正式C1从B实际创建和核验，经已保存AI回执合并自然进入C2，不预测媒体revision", async () => {
  const { before, schema, created, checked, merged, c2 } = await createFormalC1C2Fixture();
  assert.equal(checked.c1ProductPlan.unknownManifest.some(item => item.blocksC2Handoff), false,
    JSON.stringify(checked.c1ProductPlan.unknownManifest));
  assert.equal(checked.c1ProductPlan.draftOnlySeo, null);
  assert.deepEqual(created.c1ProductPlan.revisionRefs, { sourceRevision: before.dataRevision, resultRevision: before.dataRevision + 1 });
  assert.deepEqual(merged.skuPackage.profitModels, before.profitModels);
  assert.deepEqual(merged.skuPackage.selectedSupplySnapshot, before.selectedSupplySnapshot);
  assert.deepEqual(merged.skuPackage.g1Identity, before.g1Identity);
  assert.equal(c2.skuPackage.businessPhase, "C2");
  assert.equal(c2.skuPackage.c2FinalAssets.targetContext.sourceDataRevision, merged.skuPackage.dataRevision);
  assert.equal(c2.skuPackage.c2FinalAssets.targetContext.schemaEvidenceRef, schema.evidenceId);
  // 槽位合同已废止：冻结 Schema 不再携带任何媒体槽位，C1 也不再产出媒体摘要。
  assert.equal(Object.hasOwn(schema, "mediaRequirements"), false);
  assert.equal(Object.hasOwn(c2.skuPackage.c1ProductPlan, "mediaRequirements"), false);
  assert.deepEqual(c2.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules, schema);
  assert.deepEqual(c2.skuPackage.profitModels, before.profitModels);
  assert.equal(c2.skuPackage.productionAuthorization, null);
  for (const sku of [before, created.skuPackage, checked.skuPackage, merged.skuPackage, c2.skuPackage]) {
    const validation = validateSkuLifecyclePackage(sku);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  }
  // The published schema graph carries cross-schema $refs; validate through the shared registry of every published schema.
  const publishedValidator = await loadPublishedSchemaValidator();
  const validate = publishedValidator.getSchema("c1-product-plan-v1.1");
  for (const plan of [created.c1ProductPlan, checked.c1ProductPlan, merged.c1ProductPlan]) {
    assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  }
  const validateC2 = publishedValidator.getSchema("c2-asset-lifecycle-v1.1");
  assert.equal(validateC2(c2.skuPackage.c2FinalAssets), true, JSON.stringify(validateC2.errors));
});

test("唯一正式fixture创建当前单主人授权，历史fixture保留旧双人合同且分别通过严格Schema", async () => {
  const validator = await loadPublishedSchemaValidator();
  for (const factory of [authorizedProductionFixture, historicalAuthorizedProductionFixture]) {
    const result = factory();
    const authorization = result.productionAuthorization;
    const validate = validator.getSchema(authorization.schemaVersion);
    assert.equal(validate(authorization), true, JSON.stringify(validate.errors));
    const validateSku = validator.getSchema("product-lifecycle-v1.1");
    assert.equal(validateSku(result.skuPackage), true, JSON.stringify(validateSku.errors));
    assert.equal(authorization.lockedScope.platformWritePrice.amount, 151.78);
    assert.equal(authorization.productionExecuted, false);
    if (factory === historicalAuthorizedProductionFixture) {
      assert.equal(authorization.schemaVersion, "production-authorization-v1.1");
      assert.notEqual(authorization.confirmedByActorId, authorization.authorizedByActorId);
      assert.equal(authorization.technicalAuthorization.role, "production_authorizer");
      assert.equal(authorization.ownerConfirmation.schemaVersion, "production-owner-confirmation-v1");
      assert.equal(Object.hasOwn(authorization, "ownerAuthorization"), false);
    } else {
      assert.equal(authorization.schemaVersion, "production-authorization-v1.2");
      assert.equal(authorization.confirmedByActorId, authorization.authorizedByActorId);
      assert.equal(Object.hasOwn(authorization, "technicalAuthorization"), false);
    }
  }
});

test("正式链fixture在出生前绑定另一候选、供应SKU与完整店铺，所有冻结引用由领域函数生成", async () => {
  const storeRef = { stableStoreId: "miska", platformStoreId: "fixture-seller-miska", mappingVersion: "fixture-stores-v2" };
  const fixture = await createFormalC1C2Fixture({ candidateId: "FORMAL-C1-GENERIC", supplierSkuId: "SUPPLIER-BLUE",
    variantKey: "颜色:蓝色", storeRef, softwareJobId: "software-job:formal-generic:1", gatewayJobId: "gateway-job:formal-generic:1" });
  for (const sku of [fixture.before, fixture.checked.skuPackage, fixture.merged.skuPackage, fixture.c2.skuPackage]) {
    assert.equal(sku.g1Identity.candidateId, "FORMAL-C1-GENERIC");
    assert.equal(sku.g1Identity.supplierSkuId, "SUPPLIER-BLUE");
    assert.equal(sku.variantKey, "颜色:蓝色");
    assert.deepEqual(sku.g1Identity.storeRef, storeRef);
    const validation = validateSkuLifecyclePackage(sku);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  }
  assert.equal(fixture.request.sourceIdentity.candidateId, fixture.candidate.id);
  assert.equal(fixture.merged.c1ProductPlan.draftOnlySeo.providerJobRef.jobId, "gateway-job:formal-generic:1");
  assert.deepEqual(fixture.c2.skuPackage.profitModels, fixture.before.profitModels);
  assert.deepEqual(fixture.schema.storeRef, storeRef);
});

test("动态供应字段保留原始键和值，集合来源引用可完成正式C2确认", () => {
  const attributes = { 规格: "小号", "цвет": "синий", "size/~%2F": "large" };
  const fixture = createFormalC1C2Fixture({ variantKey: "规格:小号", skuAttributes: attributes });
  const facts = fixture.checked.c1ProductPlan.productAttributes.supplierAttributes;
  for (const [fieldKey, value] of Object.entries(attributes)) {
    const item = facts.find(fact => fact.fieldKey === fieldKey);
    assert.equal(item.fact.value, value);
    assert.deepEqual(item.fact.sourceRefs, [`${fixture.checked.c1ProductPlan.inputRefs.selectedSupplySnapshotId}#/supplierSku/attributes`]);
    assert.ok(item.fact.sourceRefs.every(isCanonicalFrozenRef));
  }
  const before = structuredClone(fixture.merged.skuPackage);
  const input = productionAuthorizationInputFixture({ sourceSkuPackage: fixture.merged.skuPackage });
  assert.equal(input.skuPackage.c2FinalAssets.status, "completed");
  assert.deepEqual(fixture.merged.skuPackage, before);
  assert.deepEqual(input.skuPackage.c1ProductPlan.productAttributes.supplierAttributes, facts);
});

test("缺失的动态必填字段以原始fieldKey报告阻塞，来源引用不拼接任意键", () => {
  const state = phase7PassedState({ fullC1Facts: true });
  const schema = platformSchemaEvidence();
  const keys = ["材质", "размер", "size/~%2F"];
  schema.requiredFields = keys.map(fieldKey => ({ fieldKey, label: fieldKey, required: true, sourceAttributeKeys: ["missing"] }));
  const created = createC1ProductPlan({ ...state, platformSchemaEvidence: schema, createdAt: "2026-08-12T13:00:00.000Z" });
  const checked = verifyC1ProductFacts({ skuPackage: created.skuPackage, verifiedAt: "2026-08-12T13:00:00.000Z" });
  assert.deepEqual(checked.c1ProductPlan.productAttributes.requiredPlatformFields.map(item => item.fieldKey), keys);
  for (const item of checked.c1ProductPlan.productAttributes.requiredPlatformFields) {
    assert.equal(item.fact.verificationStatus, "unknown");
    assert.ok(item.fact.sourceRefs.every(isCanonicalFrozenRef));
    assert.ok(item.fact.sourceRefs.includes(`${schema.evidenceId}#/requiredFields`));
  }
  assert.equal(checked.c1ProductPlan.unknownManifest.some(item => item.blocksC2Handoff), true);
});


function attributeDecisionFacts({ material = 'unknown', requiredMaterial = false, powerProfile = { powered: false, containsBattery: false } } = {}) {
  const state = structuredClone(phase7PassedState({ fullC1Facts: true, material }));
  state.skuPackage.selectedSupplySnapshot.supplierSku.powerProfile = structuredClone(powerProfile);
  const schema = platformSchemaEvidence();
  schema.requiredFields = requiredMaterial ? [{ fieldKey: 'material', label: '材质', required: true, sourceAttributeKeys: ['material'] }] : [];
  const created = createC1ProductPlan({ ...state, platformSchemaEvidence: schema, createdAt: '2026-08-12T13:00:00.000Z' });
  return verifyC1ProductFacts({ skuPackage: created.skuPackage, verifiedAt: '2026-08-12T13:00:00.000Z' });
}

test('schema-optional material stays unknown without becoming a C2 blocking claim', () => {
  const { c1ProductPlan: plan } = attributeDecisionFacts();
  assert.equal(plan.productAttributes.material.value, 'unknown');
  assert.equal(plan.productAttributes.material.verificationStatus, 'unknown');
  const material = collectC1UnknownManifest(plan).find(item => item.fieldPath === 'productAttributes.material');
  assert.equal(material.blockingScope, 'informational');
  assert.equal(material.blocksC2Handoff, false);
  assert.equal(plan.finalSeo, null);
});

test('schema-required material cannot be made optional by a forged saved unknown manifest', () => {
  const plan = structuredClone(attributeDecisionFacts({ requiredMaterial: true }).c1ProductPlan);
  assert.ok(plan.productAttributes.requiredPlatformFields.some(item => item.fieldKey === 'material' && item.fact.verificationStatus === 'unknown'));
  plan.unknownManifest = plan.unknownManifest.map(item => ({ ...item, blockingScope: 'informational', blocksC2Handoff: false }));
  const recomputed = collectC1UnknownManifest(plan);
  assert.ok(recomputed.some(item => item.fieldPath.startsWith('productAttributes.requiredPlatformFields') && item.blocksC2Handoff));
});

test('verified no-battery product does not require unknown battery type count and capacity', () => {
  const { c1ProductPlan: plan } = attributeDecisionFacts();
  assert.equal(plan.batteryAssessment.containsBattery.value, false);
  assert.equal(plan.batteryAssessment.assessment.value, 'no_battery');
  for (const field of ['batteryType', 'batteryCount', 'batteryCapacity']) {
    assert.equal(plan.batteryAssessment[field].verificationStatus, 'unknown');
    const gap = collectC1UnknownManifest(plan).find(item => item.fieldPath === `batteryAssessment.${field}`);
    assert.equal(gap.blocksC2Handoff, false, field);
  }
});

// 主人 2026-09-15 要求撤掉「合规」那一档阻断。电池缺口仍然逐条如实记在清单上——
// 只是不再拿它挡 C1→C2。不是把它藏起来：blockingScope 必须还叫得出名字。
for (const powerProfile of [{ powered: false }, { powered: true, containsBattery: true }]) {
  test(`battery gaps stay on the record but stop blocking when containsBattery is ${powerProfile.containsBattery ?? 'unknown'}`, () => {
    const { c1ProductPlan: plan } = attributeDecisionFacts({ powerProfile });
    const gaps = collectC1UnknownManifest(plan).filter(item => item.fieldPath.startsWith('batteryAssessment.'));
    assert.ok(gaps.length > 0);
    assert.ok(gaps.every(item => item.blockingScope === 'informational' && item.blocksC2Handoff === false));
  });
}

test('legacy final card without unknown classification cannot authorize production', () => {
  const input = structuredClone(productionAuthorizationInputFixture());
  delete input.skuPackage.productionConfirmationCard.riskAndUnknowns.classificationVersion;
  assert.equal(validateFinalProductPlanConfirmationCard(input.skuPackage.productionConfirmationCard).valid, true);
  assert.throws(() => createProductionAuthorization(input), /FINAL_CARD_CLASSIFICATION_REQUIRED/);
});

test('forged final-card nonblocking flags cannot bypass a required fact', () => {
  const input = structuredClone(productionAuthorizationInputFixture());
  const risks = input.skuPackage.productionConfirmationCard.riskAndUnknowns;
  risks.unknownFields.push({ path: 'c1Facts.productAttributes.requiredPlatformFields[0].fact', fieldKey: 'material', label: '材质', value: 'unknown', reason: 'synthetic unknown', sourceRefs: [],
    blockingScope: 'informational', blocksProductionAuthorization: false });
  risks.blockingUnknownCount = 0;
  assert.throws(() => createProductionAuthorization(input), /CARD_DRIFT/);
});

function optionalMaterialAuthorizationSource() {
  const source = structuredClone(createFormalC1C2Fixture().merged.skuPackage);
  const plan = source.c1ProductPlan;

  plan.productAttributes.material = { value: 'unknown', verificationStatus: 'unknown', sourceRefs: [...plan.productAttributes.material.sourceRefs], reason: 'Synthetic material not supplied' };
  plan.productAttributes.requiredPlatformFields = [];
  plan.inputSnapshots.platformSchemaRules.requiredFields = [];
  plan.inputSnapshots.platformSchemaRules.writeBindings.requiredAttributes = [];
  plan.schemaSnapshot.writeBindings.value.requiredAttributes = [];
  plan.unknownManifest = collectC1UnknownManifest(plan);
  return source;
}

test('optional unknown material survives final card and authorization without an invented material value', () => {
  const source = optionalMaterialAuthorizationSource();
  const before = structuredClone(source);
  const input = productionAuthorizationInputFixture({ sourceSkuPackage: source });
  const card = input.skuPackage.productionConfirmationCard;
  assert.equal(card.riskAndUnknowns.classificationVersion, 'c1-schema-aware-unknown-v1');
  const material = card.riskAndUnknowns.unknownFields.find(item => item.path.endsWith('productAttributes.material'));
  assert.equal(material.blocksProductionAuthorization, false);
  assert.equal(card.riskAndUnknowns.blockingUnknownCount, 0);
  const result = createProductionAuthorization(input);
  assert.equal(result.productionAuthorization.status, 'confirmed');
  assert.equal(result.skuPackage.c1ProductPlan.productAttributes.material.value, 'unknown');
  assert.deepEqual(source, before);
});


test('contradictory frozen battery evidence is still listed, and is no longer a C2 blocker either', () => {
  const plan = structuredClone(attributeDecisionFacts().c1ProductPlan);
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.powerProfile.batteryIncluded = true;
  const gaps = collectC1UnknownManifest(plan);
  for (const field of ['batteryType', 'batteryCount', 'batteryCapacity']) {
    const gap = gaps.find(item => item.fieldPath === `batteryAssessment.${field}`);
    assert.ok(gap, field);
    assert.equal(gap.blockingScope, 'informational', field);
    assert.equal(gap.blocksC2Handoff, false, field);
  }
});

 test('direct production authorization rejects current C1 required-schema drift despite an optional frozen card', () => {
  for (const mutate of [
    plan => { plan.inputSnapshots.platformSchemaRules.requiredFields = [{ fieldKey: 'material', label: '材质', required: true, sourceAttributeKeys: ['material'] }]; },
    plan => { plan.schemaSnapshot.writeBindings.value.requiredAttributes = [{ fieldKey: 'material', attributeId: 'synthetic-required-material' }]; }
  ]) {
    const input = structuredClone(productionAuthorizationInputFixture({ sourceSkuPackage: optionalMaterialAuthorizationSource() }));
    const sku = input.skuPackage;
    assert.equal(sku.productionConfirmationCard.riskAndUnknowns.blockingUnknownCount, 0);
    mutate(sku.c1ProductPlan);
    const before = JSON.stringify(input);
    assert.throws(() => createProductionAuthorization(input), /C1.*(CHANGED|DRIFT)|PREPARATION_.*(CHANGED|DRIFT)/);
    assert.equal(JSON.stringify(input), before);
    assert.equal(sku.productionAuthorization, null);
    assert.equal(sku.dHandoff, undefined);
  }
});

/*
 * 类目全部属性与字典号（2026-09-17 新增）。老计划里没有这个字段，新计划给了就必须成形。
 * 为什么要守：dictionaryId 是发 import 时 dictionaryValueId 的唯一来源，
 * 这里放行一个坏形状，代价是真发商品那一刻才炸（OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED）。
 */
test("类目属性是可选字段：老证据照旧通过，新证据给了就必须成形", () => {
  const base = platformSchemaEvidence();
  assert.equal(validatePlatformSchemaEvidence(base).valid, true, "没有 attributes 的老证据必须照旧通过");

  const good = { ...structuredClone(base), attributes: [
    { fieldKey: "4967", label: "Материал", required: false, dictionaryId: 1503, isCollection: true, attributeType: "String" },
    { fieldKey: "9048", label: "Название модели", required: true, dictionaryId: 0 }
  ] };
  assert.equal(validatePlatformSchemaEvidence(good).valid, true);

  const paths = (evidence) => validatePlatformSchemaEvidence(evidence).errors.map((item) => item.path);
  assert.deepEqual(paths({ ...structuredClone(base), attributes: {} }), ["attributes"]);
  assert.deepEqual(paths({ ...structuredClone(base), attributes: [null] }), ["attributes[0]"]);
  for (const [broken, path] of [
    [{ fieldKey: "", label: "x", required: false, dictionaryId: 0 }, "attributes[0].fieldKey"],
    [{ fieldKey: "1", label: "", required: false, dictionaryId: 0 }, "attributes[0].label"],
    [{ fieldKey: "1", label: "x", required: "yes", dictionaryId: 0 }, "attributes[0].required"],
    [{ fieldKey: "1", label: "x", required: false, dictionaryId: -1 }, "attributes[0].dictionaryId"],
    [{ fieldKey: "1", label: "x", required: false, dictionaryId: 1.5 }, "attributes[0].dictionaryId"],
    [{ fieldKey: "1", label: "x", required: false }, "attributes[0].dictionaryId"]
  ]) {
    assert.ok(paths({ ...structuredClone(base), attributes: [broken] }).includes(path), `应报 ${path}`);
  }
  assert.ok(paths({ ...structuredClone(base), attributes: [
    { fieldKey: "4967", label: "a", required: false, dictionaryId: 0 },
    { fieldKey: "4967", label: "b", required: false, dictionaryId: 0 }
  ] }).includes("attributes[1].fieldKey"), "重复属性必须被拦");
});

/*
 * 主人签过的「中文事实 → Ozon 字典值」映射，投影成俄文值的已确认事实。
 *
 * 这是关键词那条路的必经之处：Ozon 关键词要求**逐字等于**某条已确认事实的值，
 * 而本品的事实来自 1688、全是中文。这组测试守的是最危险的失败方式——
 * **依据已经变了却还在继续声称**：中文事实漂了、或 schema 换版了，
 * 那条俄文事实必须退回 unknown，而不是照旧摆在那里让人当真。
 */
const OZON_SCHEMA_ATTRIBUTES = [
  { fieldKey: "4967", label: "Материал", required: false, dictionaryId: 1503 },
  { fieldKey: "brand", label: "品牌", required: true, dictionaryId: 28732849 }
];

async function factsWithOzonMapping(mutate = () => {}) {
  const inputs = await phase8InputsReadyState();
  const skuPackage = structuredClone(inputs.skuPackage);
  const plan = skuPackage.c1ProductPlan;
  plan.inputSnapshots.platformSchemaRules.attributes = structuredClone(OZON_SCHEMA_ATTRIBUTES);
  const supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  supply.supplierSku.material = "牛津布";
  skuPackage.selectedSupplySnapshot.supplierSku.material = "牛津布";
  skuPackage.ozonAttributeMappingsV1 = {
    schemaVersion: "c1-ozon-attribute-mapping-v1",
    schemaRevision: plan.inputSnapshots.platformSchemaRules.schemaRevision,
    confirmationRef: "owner-ozon-attribute-mapping:test",
    mappings: [{
      attributeId: "4967", attributeLabel: "Материал", dictionaryValueId: 61979, value: "Оксфорд",
      sourceFactPath: "productAttributes.material", sourceFactValue: "牛津布",
      dictionaryEvidenceRef: "ozon-seller-api:/v1/description-category/attribute/values/search:17028665:92935:4967"
    }]
  };
  mutate(skuPackage, plan);
  return verifyC1ProductFacts({ skuPackage, verifiedAt: "2026-08-12T12:40:00.000Z" });
}

test("映射两端证据齐全时，产出俄文值的已确认事实并带上真实字典号", async () => {
  const { skuPackage } = await factsWithOzonMapping();
  const [entry] = skuPackage.c1ProductPlan.productAttributes.ozonAttributes;
  assert.equal(entry.fieldKey, "4967");
  assert.equal(entry.label, "Материал");
  assert.equal(entry.dictionaryValueId, 61979);
  // 字典属性的事实值必须是对象，真发 import 时适配器要从里面取 dictionaryValueId。
  assert.deepEqual(entry.fact.value, { value: "Оксфорд", dictionaryValueId: 61979 });
  assert.equal(entry.fact.verificationStatus, "confirmed");
  // 两端的证据都要留在引用里：Ozon 字典读数、schema 属性、冻结供应属性、主人确认。
  assert.ok(entry.fact.sourceRefs.some((ref) => ref.includes("attribute/values/search")), "缺Ozon字典证据引用");
  assert.ok(entry.fact.sourceRefs.includes("owner-ozon-attribute-mapping:test"), "缺主人确认引用");
});

test("中文事实漂了就退回unknown，不继续声称那条俄文值", async () => {
  const { skuPackage } = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.material = "涤纶";
  });
  const [entry] = skuPackage.c1ProductPlan.productAttributes.ozonAttributes;
  assert.equal(entry.fact.verificationStatus, "unknown");
  assert.equal(entry.fact.reason, "source_fact_drifted_since_mapping");
  assert.equal(entry.dictionaryValueId, null, "漂移后绝不能还交出字典号");
});

test("schema换版就退回unknown——属性号和字典可能已经不是同一套", async () => {
  const { skuPackage } = await factsWithOzonMapping((sku) => {
    sku.ozonAttributeMappingsV1.schemaRevision = "ozon-schema:别的版本";
  });
  const [entry] = skuPackage.c1ProductPlan.productAttributes.ozonAttributes;
  assert.equal(entry.fact.verificationStatus, "unknown");
  assert.equal(entry.fact.reason, "schema_revision_changed_since_mapping");
});

test("映射到当前schema里没有的属性也退回unknown", async () => {
  const { skuPackage } = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.platformSchemaRules.attributes = [{ fieldKey: "9999", label: "别的", required: false, dictionaryId: 0 }];
  });
  const [entry] = skuPackage.c1ProductPlan.productAttributes.ozonAttributes;
  assert.equal(entry.fact.verificationStatus, "unknown");
  assert.equal(entry.fact.reason, "ozon_attribute_not_in_current_schema");
});

test("没有映射记录时是空数组，老计划的行为一字不变", async () => {
  const inputs = await phase8InputsReadyState();
  const { skuPackage } = verifyC1ProductFacts({ skuPackage: inputs.skuPackage, verifiedAt: "2026-08-12T12:40:00.000Z" });
  assert.deepEqual(skuPackage.c1ProductPlan.productAttributes.ozonAttributes, []);
});

test("没映射的非必填Ozon属性不挡C2，必填的照旧阻断", async () => {
  const { skuPackage } = await factsWithOzonMapping((sku) => {
    sku.ozonAttributeMappingsV1.mappings.push({
      attributeId: "brand", attributeLabel: "品牌", dictionaryValueId: 1, value: "Нет бренда",
      sourceFactPath: "productAttributes.material", sourceFactValue: "对不上的值",
      dictionaryEvidenceRef: "ozon-seller-api:brand"
    });
    sku.ozonAttributeMappingsV1.mappings[0].sourceFactValue = "也对不上";
  });
  const unknowns = collectC1UnknownManifest(skuPackage.c1ProductPlan)
    .filter((item) => item.fieldPath.startsWith("productAttributes.ozonAttributes"));
  assert.equal(unknowns.length, 2);
  const byPath = Object.fromEntries(unknowns.map((item) => [item.fieldPath, item.blockingScope]));
  assert.equal(byPath["productAttributes.ozonAttributes[0].fact"], "informational", "非必填的4967不该挡C2");
  assert.equal(byPath["productAttributes.ozonAttributes[1].fact"], "required_field", "必填的brand必须照旧阻断");
});

test("回归：映射可以绑到计划里任何一块事实，不只是 productAttributes", async () => {
  // 2026-09-17 真数据踩到的：投影一度跑在 plan.platformCategory 赋值之前，
  // 绑到 platformCategory.categoryPath 的映射全被静默判成漂移。
  // 合成夹具当时只绑 productAttributes，照不出这一条，只有真数据跑出来了。
  const { skuPackage } = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.platformSchemaRules.attributes = [
      ...structuredClone(OZON_SCHEMA_ATTRIBUTES),
      { fieldKey: "4958", label: "Предназначено для", required: false, dictionaryId: 749 }
    ];
    sku.ozonAttributeMappingsV1.mappings.push({
      attributeId: "4958", attributeLabel: "Предназначено для", dictionaryValueId: 33754, value: "Для кошек",
      sourceFactPath: "platformCategory.categoryPath",
      sourceFactValue: plan.inputSnapshots.salesSnapshot.categoryPath,
      dictionaryEvidenceRef: "ozon-seller-api:values/search:4958"
    });
  });
  const byId = Object.fromEntries(
    skuPackage.c1ProductPlan.productAttributes.ozonAttributes.map((item) => [item.fieldKey, item]));
  assert.equal(byId["4958"].fact.verificationStatus, "confirmed",
    "绑到 platformCategory 的映射必须成立——投影要排在全部事实段之后");
  assert.deepEqual(byId["4958"].fact.value, { value: "Для кошек", dictionaryValueId: 33754 });
  assert.equal(byId["4958"].dictionaryValueId, 33754);
  // 清单也必须看到最终那一份，而不是空的。
  assert.equal(skuPackage.c1ProductPlan.unknownManifest
    .filter((item) => item.fieldPath.startsWith("productAttributes.ozonAttributes")).length, 0);
});

test("从冻结类目属性表推出发 import 的写入绑定；缺属性编号就不给绑定", async () => {
  // writeBindings 全仓库从没人赋过值、证据服务也不返回，于是它永远 unknown、永远阻断 C2。
  // 但它要的 attributeId / complexId / dictionaryId 全在类目属性表里，只是没人拼起来。
  const withIds = [
    { fieldKey: "4180", label: "Название", required: false, dictionaryId: 0, complexId: 0 },
    { fieldKey: "4191", label: "Аннотация", required: false, dictionaryId: 0, complexId: 0 },
    { fieldKey: "23171", label: "#Хештеги", required: false, dictionaryId: 0, complexId: 0 },
    { fieldKey: "8229", label: "Тип", required: true, dictionaryId: 1960, complexId: 0 },
    { fieldKey: "85", label: "Бренд", required: true, dictionaryId: 28732849, complexId: 100001 }
  ];
  const { skuPackage } = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.platformSchemaRules.attributes = structuredClone(withIds);
  });
  const wb = skuPackage.c1ProductPlan.schemaSnapshot.writeBindings;
  assert.equal(wb.verificationStatus, "confirmed");
  assert.deepEqual(wb.value.content.searchKeywords, { fieldKey: "searchKeywords", attributeId: 23171, complexId: 0, dictionaryId: 0 });
  // complexId 要照抄，不能假设 0——这个类目实测就有 100001。
  assert.deepEqual(wb.value.requiredAttributes.find(item => item.fieldKey === "85"),
    { fieldKey: "85", attributeId: 85, complexId: 100001, dictionaryId: 28732849 });

  // 缺 complexId 的旧读数：宁可照实说缺，不编一个号发出去。
  const stale = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.platformSchemaRules.attributes = withIds.map(({ complexId, ...rest }) => rest);
  });
  assert.equal(stale.skuPackage.c1ProductPlan.schemaSnapshot.writeBindings.verificationStatus, "unknown");

  // 内容字段带字典就不能走文字写入，同样不给绑定。
  const dictTitle = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.platformSchemaRules.attributes = withIds.map(item =>
      item.fieldKey === "4180" ? { ...item, dictionaryId: 7 } : item);
  });
  assert.equal(dictTitle.skuPackage.c1ProductPlan.schemaSnapshot.writeBindings.verificationStatus, "unknown");
});

test("主人签的映射就是必填属性的答案；供应属性已能确认的不被盖掉", async () => {
  // 2026-09-18 真数据踩到：映射已经签好（8229 Тип = Одежда для животных），
  // 可 requiredPlatformFields 仍然 unknown、照旧阻断 C2——那一段只从 1688 供应属性里
  // 按 sourceAttributeKeys 找依据，完全看不见 ozonAttributes。加新段时没接这条线，
  // 等于让主人签了个不算数的字。
  const { skuPackage } = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.platformSchemaRules.attributes = [
      { fieldKey: "8229", label: "Тип", labelZh: "类型", required: true, dictionaryId: 1960, complexId: 0 },
      { fieldKey: "4180", label: "Название", required: false, dictionaryId: 0, complexId: 0 },
      { fieldKey: "4191", label: "Аннотация", required: false, dictionaryId: 0, complexId: 0 },
      { fieldKey: "23171", label: "#Хештеги", required: false, dictionaryId: 0, complexId: 0 }
    ];
    plan.inputSnapshots.platformSchemaRules.requiredFields = [
      { fieldKey: "8229", label: "Тип", required: true, sourceAttributeKeys: ["8229"] }
    ];
    sku.ozonAttributeMappingsV1.mappings = [{
      attributeId: "8229", attributeLabel: "Тип", dictionaryId: 1960,
      value: "Одежда для животных", dictionaryValueId: 96063,
      sourceFactPath: "productAttributes.material", sourceFactValue: "牛津布",
      dictionaryEvidenceRef: "ozon-seller-api:8229"
    }];
  });
  const plan = skuPackage.c1ProductPlan;
  const field = plan.productAttributes.requiredPlatformFields.find(item => item.fieldKey === "8229");
  assert.equal(field.fact.verificationStatus, "confirmed", "签过的映射必须能满足必填项");
  assert.deepEqual(field.fact.value, { value: "Одежда для животных", dictionaryValueId: 96063 });
  assert.equal(field.resolvedFromOwnerAttributeMapping, true);
  // 补齐之后，缺口计数和整体状态要跟着更新，否则界面还显示「必填不全」。
  assert.equal(plan.platformCompliance.requiredFieldGapCount.value, 0);
  assert.equal(plan.productAttributes.status.value, "all_required_fields_known");
  // 这一格不该再挡 C2。
  assert.equal((plan.unknownManifest ?? []).some(item =>
    item.fieldPath.startsWith("productAttributes.requiredPlatformFields") && item.blocksC2Handoff), false);
});

test("已确认但缺字典号的必填项：只在取值逐字相同时补号，不改主人签过的任何一个字", async () => {
  // 主人签的品牌声明给的是 {value:"Нет бренда", dictionaryValueId:null}——值对、就是缺平台编号。
  // 而真发 import 时字典属性必须有正整数字典号，否则报 OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED。
  // 这里用「供应属性已经确认出一个缺号的对象值」来重现同一形状（合成夹具装不出同源的权利声明）。
  async function withBrand(mappingValue) {
    return factsWithOzonMapping((sku, plan) => {
      plan.inputSnapshots.platformSchemaRules.attributes = [
        { fieldKey: "brand", label: "Бренд", labelZh: "品牌", required: true, dictionaryId: 28732849, complexId: 0 },
        { fieldKey: "4180", label: "Название", required: false, dictionaryId: 0, complexId: 0 },
        { fieldKey: "4191", label: "Аннотация", required: false, dictionaryId: 0, complexId: 0 },
        { fieldKey: "23171", label: "#Хештеги", required: false, dictionaryId: 0, complexId: 0 }
      ];
      plan.inputSnapshots.platformSchemaRules.requiredFields = [
        { fieldKey: "brand", label: "Бренд", required: true, sourceAttributeKeys: ["brandDeclared"] }
      ];
      // 已确认、但缺 dictionaryValueId 的对象值——和主人签的品牌声明同一个形状。
      plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes.brandDeclared =
        { value: "Нет бренда", brandStatus: "unbranded", dictionaryValueId: null };
      sku.ozonAttributeMappingsV1.mappings = [{
        attributeId: "brand", attributeLabel: "Бренд", dictionaryId: 28732849,
        value: mappingValue, dictionaryValueId: 126745801,
        sourceFactPath: "productAttributes.material", sourceFactValue: "牛津布",
        dictionaryEvidenceRef: "ozon-seller-api:brand"
      }];
    });
  }
  const { skuPackage } = await withBrand("Нет бренда");
  const field = skuPackage.c1ProductPlan.productAttributes.requiredPlatformFields.find(item => item.fieldKey === "brand");
  assert.equal(field.fact.verificationStatus, "confirmed");
  assert.equal(field.fact.value.dictionaryValueId, 126745801, "取值相同就该把平台编号补上");
  assert.equal(field.fact.value.value, "Нет бренда", "原来说的是什么就还是什么");
  assert.equal(field.fact.value.brandStatus, "unbranded", "原值的其它字段不能被丢掉");
  assert.equal(field.dictionaryValueIdResolvedFromOwnerAttributeMapping, true);
  assert.equal(field.resolvedFromOwnerAttributeMapping, undefined, "这不是整条替换，只是补号");

  // 取值不同就**不准**补——那是在替主人改他签过的东西。
  const other = await withBrand("WOSPORT");
  const otherField = other.skuPackage.c1ProductPlan.productAttributes.requiredPlatformFields.find(item => item.fieldKey === "brand");
  assert.equal(otherField.fact.value.dictionaryValueId ?? null, null, "取值不同时绝不能补号");
});

test("依据是对象值的事实时，漂移判定要用深比较——否则好端端的映射全被判成漂移", async () => {
  // 事实值不一定是字符串：主人签的品牌声明就是 {value, brandStatus, dictionaryValueId}。
  // 原来这里用 ===，对象永远不相等，映射会被无辜判成 source_fact_drifted_since_mapping。
  const { skuPackage } = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes.objectFact =
      { value: "Нет бренда", brandStatus: "unbranded", dictionaryValueId: null };
    const index = Object.keys(plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes)
      .filter((key) => {
        const item = plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes[key];
        return item !== null && item !== undefined && item !== "";
      }).indexOf("objectFact");
    sku.ozonAttributeMappingsV1.mappings = [{
      attributeId: "4967", attributeLabel: "Материал", dictionaryId: 1503,
      value: "Оксфорд", dictionaryValueId: 61979,
      sourceFactPath: `productAttributes.supplierAttributes.${index}.fact`,
      sourceFactValue: { value: "Нет бренда", brandStatus: "unbranded", dictionaryValueId: null },
      dictionaryEvidenceRef: "ozon-seller-api:4967"
    }];
  });
  const [entry] = skuPackage.c1ProductPlan.productAttributes.ozonAttributes;
  assert.equal(entry.fact.verificationStatus, "confirmed", "对象值逐字相同就不该判成漂移");

  // 对象内容真的变了，仍然必须判成漂移。
  const drifted = await factsWithOzonMapping((sku, plan) => {
    plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes.objectFact =
      { value: "WOSPORT", brandStatus: "branded", dictionaryValueId: null };
    const index = Object.keys(plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes)
      .filter((key) => {
        const item = plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes[key];
        return item !== null && item !== undefined && item !== "";
      }).indexOf("objectFact");
    sku.ozonAttributeMappingsV1.mappings = [{
      attributeId: "4967", attributeLabel: "Материал", dictionaryId: 1503,
      value: "Оксфорд", dictionaryValueId: 61979,
      sourceFactPath: `productAttributes.supplierAttributes.${index}.fact`,
      sourceFactValue: { value: "Нет бренда", brandStatus: "unbranded", dictionaryValueId: null },
      dictionaryEvidenceRef: "ozon-seller-api:4967"
    }];
  });
  const [driftedEntry] = drifted.skuPackage.c1ProductPlan.productAttributes.ozonAttributes;
  assert.equal(driftedEntry.fact.verificationStatus, "unknown");
  assert.equal(driftedEntry.fact.reason, "source_fact_drifted_since_mapping");
});
