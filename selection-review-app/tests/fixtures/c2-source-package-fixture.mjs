import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS } from "./c1-sku-rights-review-fixture.mjs";
import { C1_CURRENT_FACT_VERIFICATION_VERSION, projectC1SkuRightsReviewFacts } from "../../lib/c1-sku-rights-review.mjs";
const NOW = "2026-08-22T06:00:00.000Z";

const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

export function fact(value, sourceRefs = ["evidence:fixture:shelf-white"]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

export function draft(text, factRefs = ["platformCategory.categoryName"], keywordEvidenceRefs = ["keyword:fixture:shelf"]) {
  return { status: "draft_only", text, factRefs, keywordEvidenceRefs, productionApproved: false };
}


export function packageFixture({ sku = "SHELF-WHITE", title = "Полка для ванной", candidateId = "candidate:fixture:bathroom-shelf", stableStoreId = "store:ozon:dandanshu", platformStoreId = "seller-dandanshu-001", mappingVersion = "stores-v1", executableOzon = false, historicalC1 = false } = {}) {
  const skuPackageId = `sku-lifecycle:FIXTURE-SHELF-001:${sku}`;
  const g1Identity = {
    schemaVersion: "g1-identity-v1",
    candidateId,
    skuPackageId,
    platform: "ozon",
    storeRef: {
      stableStoreId,
      platformStoreId,
      mappingVersion
    },
    supplierSkuId: sku,
    merchantSku: "not_applicable",
    warehouseRef: "not_applicable",
    credentialAlias: "not_applicable",
    platformProductId: "not_applicable"
  };
  const salesId = `sales:fixture:${sku}`;
  const supplyRef = `evidence:fixture:${sku}`;
  const schemaRef = "schema:fixture:ozon:bathroom-shelf";
  const ownerSupplyConfirmation = {
    confirmationVersion: "owner-supply-confirmation-v1",
    status: "confirmed",
    parentOpportunityId: "opportunity:fixture:bathroom-shelf",
    sourceOpportunityRevision: 3,
    recommendationVersion: "supplier-recommendation-v1",
    recommendedSupplierOptionId: "supplier-option:fixture:bathroom-shelf",
    selectedRecommendedOption: true,
    supplierOptionId: "supplier-option:fixture:bathroom-shelf",
    supplierSkuId: sku,
    variantKey: `颜色:${sku}`,
    confirmedBy: "owner",
    confirmedAt: NOW
  };
  const supplierSku = { supplierSkuId: sku, variantKey: `颜色:${sku}`, sourceRefs: [supplyRef] };
  const supplierOption = {
    supplierOptionId: "supplier-option:fixture:bathroom-shelf",
    sourcePlatform: "1688",
    productUrl: "https://detail.1688.com/offer/fixture.html",
    offerId: "offer:fixture:bathroom-shelf",
    evidenceRef: supplyRef
  };
  const selectedSupplySnapshot = {
    snapshotId: supplyRef,
    ownerSupplyConfirmation: structuredClone(ownerSupplyConfirmation),
    supplierOption: structuredClone(supplierOption),
    supplierSku: structuredClone(supplierSku)
  };
  const confirmedSupplySnapshot = {
    snapshotId: supplyRef,
    ownerSupplyConfirmation: structuredClone(ownerSupplyConfirmation),
    supplierOptionIdentity: {
      ...supplierOption
    },
    supplierSku: structuredClone(supplierSku)
  };
  const profitModel = {
    profitModelVersion: "profit-v1",
    calculatedAt: NOW,
    inputSnapshotRefs: [salesId, supplyRef, "fee:fixture", "logistics:fixture", "fx:fixture"],
    recommendedSalePriceCny: 100,
    unitProfitRmb: 30,
    profitMargin: 0.3,
    result: "passed"
  };
  const providerJobRef = {
    jobId: `job:c1-ai-draft:${sku}`,
    jobType: "c1_ai_draft",
    providerId: "ecommerce-ai-gateway",
    providerVersion: "gateway-v1",
    candidateId,
    skuPackageId,
    platform: "ozon",
    storeRef: stableStoreId,
    authorizationRef: {
      authorizationId: `authorization:c1-ai-draft:${sku}`,
      authorizationType: "paid_ai_draft",
      scope: {
        candidateId,
        skuPackageId,
        platform: "ozon",
        storeRef: stableStoreId,
        sourceRevision: 6,
        jobType: "c1_ai_draft"
      }
    },
    inputFingerprint: SHA_F,
    sourceRevision: 6,
    receiptRef: `receipt:c1-ai-draft:${sku}`,
    terminalStatus: "completed",
    requestSubmitted: true,
    responseVerified: true
  };
  const plan = {
    schemaVersion: "c1-product-plan-v1.1",
    contractVersion: "g1-c1-domain-contract-v1",
    c1PlanId: `c1:${skuPackageId}:profit-v1`,
    status: "seo_draft_ready",
    createdAt: NOW,
    inputRefs: {
      salesSnapshotId: salesId,
      selectedSupplySnapshotId: supplyRef,
      profitModelVersion: "profit-v1",
      platformSchemaEvidenceId: schemaRef
    },
    identity: {
      parentOpportunityId: "opportunity:fixture:bathroom-shelf",
      skuPackageId,
      supplierOptionId: "supplier-option:fixture:bathroom-shelf",
      supplierSkuId: sku,
      variantKey: `颜色:${sku}`,
      targetPlatform: "ozon",
      targetStore: stableStoreId
    },
    revisionRefs: { sourceRevision: 4, resultRevision: 5 },
    frozenInputRefs: {
      candidateId,
      skuPackageId,
      platform: "ozon",
      storeRef: stableStoreId,
      sourceRevision: 4,
      salesSnapshotId: salesId,
      selectedSupplySnapshotId: supplyRef,
      ownerSupplyConfirmationRef: `${supplyRef}#ownerSupplyConfirmation`,
      profitModelVersion: "profit-v1",
      schemaSnapshotRef: schemaRef
    },
    schemaSnapshotRef: schemaRef,
    inputSnapshots: {
      salesSnapshot: { snapshotId: salesId, title },
      confirmedSupplierSkuSnapshot: confirmedSupplySnapshot,
      profitModel: structuredClone(profitModel),
      platformSchemaRules: {
        evidenceId: schemaRef,
        platform: "ozon",
        store: stableStoreId,
        storeRef: { stableStoreId, platformStoreId, mappingVersion },
        categoryId: "category:ozon:bathroom-shelf",
        schemaRevision: "schema-v1",
        requiredFields: [],
        collectedAt: NOW,
        unknownManifest: {
          schemaVersion: "c1-unknown-manifest-v1",
          blockingItems: []
        }
      }
    },
    externalAccesses: [],
    profitRecalculated: false,
    skuReplaced: false,
    finalSeo: null,
    finalAttributes: null,
    complianceDecision: null,
    generatedAssets: null,
    productionPayload: null,
    factVerificationVersion: historicalC1 ? "c1-fact-verification-v1.1" : C1_CURRENT_FACT_VERIFICATION_VERSION,
    factsVerifiedAt: NOW,
    exactSkuVerification: {
      status: fact("verified", [supplyRef]),
      verifiedAt: NOW,
      sourceRefs: [supplyRef],
      supplierSkuId: fact(sku, [supplyRef])
    },
    productAttributes: { status: fact("all_required_fields_known", [supplyRef, schemaRef]), material: fact("plastic", [supplyRef]) },
    platformCategory: {
      status: fact("identified", [schemaRef]),
      categoryId: fact("category:ozon:bathroom-shelf", [schemaRef]),
      categoryName: fact("Полки для ванной", [schemaRef])
    },
    schemaSnapshot: { status: fact("frozen", [schemaRef]), schemaRevision: fact("schema-v1", [schemaRef]) },
    batteryAssessment: { status: fact("fact_available", [supplyRef]), assessment: fact("no_battery", [supplyRef]) },
    categoryRestrictions: { status: fact("known", [schemaRef]), restrictions: fact([], [schemaRef]) },
    platformCompliance: { status: fact("known", [schemaRef]), assessment: fact({ status: "clear" }, [schemaRef]) },
    seoTitleDraft: draft(title),
    descriptionDraft: draft(`${title}. Без сверления.`),
    bulletPointsDraft: [draft("Для ванной комнаты.")],
    searchKeywordsDraft: {
      status: "draft_only",
      keywords: [{ query: "полка для ванной", evidenceRefs: ["keyword:fixture:shelf"], factRefs: ["platformCategory.categoryName"] }],
      productionApproved: false
    },
    draftOnlySeo: {
      status: "draft_only",
      formalProviderResultAccepted: true,
      reason: null,
      aiRequestId: `request:c1-ai-draft:${sku}`,
      aiRequestFingerprint: SHA_E,
      inputFingerprint: SHA_F,
      sourceRevision: 6,
      receiptRef: `receipt:c1-ai-content:${sku}`,
      providerJobRef
    },
    keywordEvidenceRefs: ["keyword:fixture:shelf"],
    unknownManifest: [],
    seoEvidenceLayer: {
      draftVersion: "c1-ai-draft-receipt-v1",
      executionStatus: "draft_only",
      aiRequestId: `request:c1-ai-draft:${sku}`,
      aiRequestFingerprint: SHA_E,
      inputFingerprint: SHA_F,
      sourceRevision: 6,
      aiReceiptId: `receipt:c1-ai-content:${sku}`,
      providerJobRef,
      inputEvidenceRefs: [schemaRef, "keyword:fixture:shelf"],
      productionWrites: 0
    }
  };
  // Historical construction omits the new review entirely; it remains readable but cannot enter current C2.
  if (!historicalC1) {
    const review = syntheticSkuRightsReview({ plan, sourceIdentity: g1Identity, reviewedAt: NOW, brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS });
    plan.inputSnapshots.skuRightsReview = review;
    plan.platformCompliance.skuRightsReview = projectC1SkuRightsReviewFacts(review);
  }
  if (executableOzon) {
    const writeBindings = {
      schemaRevision: "schema-v1", evidenceRef: schemaRef,
      content: {
        title: { fieldKey: "title", attributeId: 4180, complexId: 0, dictionaryId: 0 },
        description: { fieldKey: "description", attributeId: 4191, complexId: 0, dictionaryId: 0 },
        searchKeywords: { fieldKey: "searchKeywords", attributeId: 23171, complexId: 0, dictionaryId: 0 }
      },
      requiredAttributes: [{ fieldKey: "material", attributeId: 85, complexId: 0, dictionaryId: 0 }]
    };
    plan.productAttributes.weight = fact({ value: 0.3, unit: "kg" }, [supplyRef]);
    plan.productAttributes.dimensions = fact({ length: 23, width: 16, height: 3, unit: "cm" }, [supplyRef]);
    plan.productAttributes.requiredPlatformFields = [{ fieldKey: "material", fact: fact("plastic", [supplyRef]) }];
    plan.platformCategory.descriptionCategoryId = fact("17033001", [schemaRef]);
    plan.platformCategory.typeId = fact("94001", [schemaRef]);
    plan.schemaSnapshot.writeBindings = fact(writeBindings, [schemaRef]);
    plan.inputSnapshots.platformSchemaRules.writeBindings = structuredClone(writeBindings);
  }
  return {
    schemaVersion: "product-lifecycle-v1.1",
    entityType: "SkuLifecyclePackage",
    skuPackageId,
    parentOpportunityId: plan.identity.parentOpportunityId,
    supplierOptionId: plan.identity.supplierOptionId,
    supplierSkuId: sku,
    variantKey: plan.identity.variantKey,
    targetPlatform: "ozon",
    targetStore: stableStoreId,
    g1Identity,
    dataRevision: 7,
    businessPhase: "C1",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "none",
    inheritedSalesSnapshotRefs: [salesId],
    selectedSupplySnapshot,
    skuFacts: {},
    profitModels: [profitModel],
    activeProfitModelVersion: "profit-v1",
    c1ProductPlan: plan,
    c2FinalAssets: null,
    productionAuthorization: null,
    productionRecord: null,
    externalListingRecord: null,
    eVerificationRecord: null,
    readbackPolicy: {
      status: "not_started",
      maxAutomaticAttempts: 1,
      automaticAttempts: 0,
      maxConsecutiveSameFailure: 1,
      consecutiveSameFailureCount: 0,
      lastFailureLayer: null,
      stopReason: null,
      stoppedAt: null
    },
    readbackHistory: [],
    audit: { createdAt: NOW, updatedAt: NOW, history: [] }
  };
}
