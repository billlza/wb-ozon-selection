import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS } from "./c1-sku-rights-review-fixture.mjs";
import { C1_CURRENT_FACT_VERIFICATION_VERSION, projectC1SkuRightsReviewFacts } from "../../lib/c1-sku-rights-review.mjs";
import { createHash } from "node:crypto";
import { C1_AI_DRAFT_RECEIPT_VERSION, buildC1AiDraftRequest, createC1AiAccounting } from "../../lib/c1-ai-draft-contract.mjs";

export const CREATED_AT = "2026-08-22T02:00:00.000Z";
const FACT_SOURCE = "source-capture:fixture:sink-organizer-blue";
const SCHEMA_SOURCE = "schema:ozon:fixture:kitchen-organizer";
const STORE_REF = { stableStoreId: "dandanshu", platformStoreId: "fixture-seller-001", mappingVersion: "fixture-stores-v1" };

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fact(value, sourceRefs = [FACT_SOURCE]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function unknown(reason) {
  return { value: "unknown", verificationStatus: "unknown", sourceRefs: [FACT_SOURCE], reason };
}

export function nonTrainSkuPackage({ candidateId = "GENERIC-SINK-001", supplierSkuId = "SINK-BLUE",
  skuPackageId = `sku-lifecycle:${candidateId}:${supplierSkuId}`, variantKey = "颜色:蓝色", storeRef = STORE_REF } = {}) {
  const schema = {
    evidenceId: SCHEMA_SOURCE,
    platform: "ozon",
    store: storeRef.stableStoreId,
    storeRef: structuredClone(storeRef),
    descriptionCategoryId: "17029001",
    typeId: "93001",
    categoryName: "Органайзер для раковины",
    schemaRevision: "ozon-schema:kitchen-organizer:2026-08-22",
    requiredFields: [
      { fieldKey: "product_type", label: "商品类型", required: true, sourceAttributeKeys: ["product_type"] },
      { fieldKey: "material", label: "材质", required: true, sourceAttributeKeys: ["material"] }
    ],
    categoryRestrictions: [],
    platformCompliance: { status: "clear" },
    collectedAt: CREATED_AT
  };
  const plan = {
    schemaVersion: "c1-product-plan-v1.1",
    contractVersion: "g1-c1-domain-contract-v1",
    revisionRefs: { sourceRevision: 2, resultRevision: 3 },
    frozenInputRefs: { candidateId, skuPackageId, platform: "ozon", storeRef: storeRef.stableStoreId, sourceRevision: 2, salesSnapshotId: "sales:fixture:sink-organizer", selectedSupplySnapshotId: FACT_SOURCE, ownerSupplyConfirmationRef: `${FACT_SOURCE}#ownerSupplyConfirmation`, profitModelVersion: "profit-v1", schemaSnapshotRef: SCHEMA_SOURCE },
    schemaSnapshotRef: SCHEMA_SOURCE, draftOnlySeo: null, keywordEvidenceRefs: [], unknownManifest: [],
    c1PlanId: `c1:${skuPackageId}:profit-v1`,
    status: "facts_checked",
    createdAt: CREATED_AT,
    inputRefs: {
      salesSnapshotId: "sales:fixture:sink-organizer",
      selectedSupplySnapshotId: FACT_SOURCE,
      profitModelVersion: "profit-v1",
      platformSchemaEvidenceId: SCHEMA_SOURCE
    },
    identity: {
      parentOpportunityId: "opportunity:sink-organizer",
      skuPackageId,
      supplierOptionId: "supplier-option:fixture:sink-organizer",
      supplierSkuId,
      variantKey,
      targetPlatform: "ozon",
      targetStore: storeRef.stableStoreId
    },
    inputSnapshots: {
      salesSnapshot: { snapshotId: "sales:fixture:sink-organizer" },
      confirmedSupplierSkuSnapshot: { snapshotId: FACT_SOURCE },
      profitModel: { profitModelVersion: "profit-v1", result: "passed" },
      platformSchemaRules: schema
    },
    externalAccesses: [],
    profitRecalculated: false,
    skuReplaced: false,
    finalSeo: null,
    finalAttributes: null,
    complianceDecision: null,
    generatedAssets: null,
    productionPayload: null,
    factVerificationVersion: C1_CURRENT_FACT_VERIFICATION_VERSION,
    factsVerifiedAt: CREATED_AT,
    exactSkuVerification: {
      status: fact("verified"),
      supplierSkuId: fact(supplierSkuId),
      variantKey: fact(variantKey)
    },
    productAttributes: {
      status: fact("all_required_fields_known", [FACT_SOURCE, SCHEMA_SOURCE]),
      material: fact("silicone"),
      color: fact("blue"),
      brand: unknown("brand_not_present_in_frozen_inputs"),
      dimensions: fact({ length: 22, width: 11, height: 4, unit: "cm" }),
      requiredPlatformFields: [
        { fieldKey: "product_type", fact: fact("sink organizer") },
        { fieldKey: "material", fact: fact("silicone") }
      ]
    },
    platformCategory: {
      status: fact("identified", [SCHEMA_SOURCE]),
      categoryName: fact("Органайзер для раковины", [SCHEMA_SOURCE]),
      descriptionCategoryId: fact("17029001", [SCHEMA_SOURCE]),
      typeId: fact("93001", [SCHEMA_SOURCE])
    },
    schemaSnapshot: {
      status: fact("frozen", [SCHEMA_SOURCE]),
      schemaRevision: fact(schema.schemaRevision, [SCHEMA_SOURCE]),
      requiredFields: fact(schema.requiredFields, [SCHEMA_SOURCE])
    },
    batteryAssessment: {
      status: fact("fact_available"),
      assessment: fact("no_battery"),
      powered: fact(false),
      containsBattery: fact(false),
      batteryType: fact("not_applicable"),
      batteryCount: fact(0),
      batteryCapacity: fact("not_applicable")
    },
    categoryRestrictions: {
      status: fact("known", [SCHEMA_SOURCE]),
      restrictions: fact([], [SCHEMA_SOURCE])
    },
    platformCompliance: {
      status: fact("known", [SCHEMA_SOURCE]),
      assessment: fact({ status: "clear" }, [SCHEMA_SOURCE]),
      requiredFieldGapCount: fact(0, [SCHEMA_SOURCE])
    },
    seoTitleDraft: null,
    descriptionDraft: null,
    bulletPointsDraft: null,
    searchKeywordsDraft: null,
    seoEvidenceLayer: null
  };
  const g1Identity = { schemaVersion: "g1-identity-v1", candidateId, skuPackageId: plan.identity.skuPackageId, supplierSkuId, platform: "ozon", storeRef: structuredClone(storeRef), merchantSku: "not_applicable", warehouseRef: "not_applicable", credentialAlias: "not_applicable", platformProductId: "not_applicable" };
  const review = syntheticSkuRightsReview({ plan, sourceIdentity: g1Identity, reviewedAt: CREATED_AT, brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS });
  plan.inputSnapshots.skuRightsReview = review;
  plan.platformCompliance.skuRightsReview = projectC1SkuRightsReviewFacts(review);
  return {
    schemaVersion: "sku-lifecycle-v1.1",
    g1Identity,
    skuPackageId: plan.identity.skuPackageId,
    supplierSkuId,
    variantKey,
    targetPlatform: "ozon",
    targetStore: storeRef.stableStoreId,
    businessPhase: "C1",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "none",
    dataRevision: 4,
    activeProfitModelVersion: "profit-v1",
    profitModels: [{ profitModelVersion: "profit-v1", result: "passed", unitProfitRmb: 36, profitMargin: 0.36 }],
    c1ProductPlan: plan,
    c2FinalAssets: null,
    productionAuthorization: null,
    productionRecord: null,
    externalListingRecord: null,
    eVerificationRecord: null,
    audit: { updatedAt: CREATED_AT, history: [] }
  };
}

export function competitorTextSnapshot() {
  return {
    snapshotId: "competitor-text:fixture:sink-organizer",
    sourceSalesSnapshotId: "sales:fixture:sink-organizer",
    observedAt: CREATED_AT,
    evidenceRef: "sales:fixture:sink-organizer#competitor-text",
    texts: [{
      textId: "competitor-title-1",
      text: "Силиконовый органайзер для кухонной раковины",
      sourceRef: "ozon-product:fixture:1001",
      role: "buyer_language_reference_only"
    }]
  };
}

export function keywordEvidence(skuPackageId = "sku-lifecycle:GENERIC-SINK-001:SINK-BLUE") {
  return {
    evidenceId: "seo:fixture:sink-organizer",
    status: "ready",
    targetPlatform: "ozon",
    targetSkuPackageId: skuPackageId,
    sourcePlatform: "ozon",
    collectionMode: "reused_verified_evidence",
    observedAt: CREATED_AT,
    keywords: [
      {
        query: "органайзер для раковины",
        group: "core_product_type",
        keywordEvidenceRef: "keyword:fixture:sink-organizer",
        sourceSku: "ozon-fixture-1001",
        sourcePlatform: "ozon",
        relevanceStatus: "retained",
        factBindingPaths: ["platformCategory.categoryName"]
      },
      {
        query: "деревянный органайзер",
        group: "material",
        keywordEvidenceRef: "keyword:fixture:wood",
        sourceSku: "ozon-fixture-1002",
        sourcePlatform: "ozon",
        relevanceStatus: "retained",
        factBindingPaths: ["productAttributes.brand"]
      }
    ]
  };
}

export function seoRules() {
  return {
    rulesVersion: "seo-rules-ru-v1",
    locale: "ru-RU",
    titleMaxLength: 120,
    descriptionMaxLength: 1200,
    bulletPointLimit: 5,
    prohibitedClaims: ["unverified_brand", "unverified_material", "unverified_dimensions", "unverified_certification"]
  };
}

export function standardClassification() {
  return {
    complexity: "standard",
    preapprovedForSol: false,
    reason: "单SKU常规俄语Listing草稿",
    markedBy: "software",
    markedAt: CREATED_AT
  };
}

export function buildRequest(overrides = {}) {
  const skuPackage = overrides.skuPackage ?? nonTrainSkuPackage();
  return buildC1AiDraftRequest({
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(skuPackage.skuPackageId),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    requestedAt: CREATED_AT,
    ...overrides
  });
}

export function receipt(request, overrides = {}) {
  const factPath = "platformCategory.categoryName";
  const factValue = "Органайзер для раковины";
  const cited = (text) => ({
    text,
    factRefs: [factPath],
    keywordRefs: ["keyword:fixture:sink-organizer"],
    assertions: [{ factPath, value: factValue }]
  });
  const output = {
    status: "draft_only",
    locale: "ru-RU",
    claimCoverage: "complete",
    unsupportedClaims: [],
    title: cited("Органайзер для раковины"),
    description: cited("Органайзер для кухонной раковины."),
    bulletPoints: [cited("Для организации пространства у раковины.")],
    searchKeywords: [cited("органайзер для раковины")]
  };
  const inputEvidenceRefs = [...new Set([
    request.competitorTextEvidence.evidenceRef,
    request.keywordEvidence.evidenceId,
    ...request.verifiedFacts.flatMap((factItem) => factItem.evidenceRefs)
  ])].sort();
  return {
    schemaVersion: C1_AI_DRAFT_RECEIPT_VERSION,
    receiptId: `receipt:${request.requestId}`,
    providerRequestId: "provider-call:test:1",
    softwareJobId: "software-job:c1-sink:1",
    gatewayJobId: "job-c1-1",
    accounting: createC1AiAccounting({ gatewayJobId: overrides.gatewayJobId ?? "job-c1-1", providerRequestId: overrides.providerRequestId ?? "provider-call:test:1" }),
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
    provider: request.provider,
    modelVersion: request.provider === "terra" ? "terra-test-1" : "sol-test-1",
    serviceVersion: "third-party-gateway-test-v1",
    status: "completed",
    attempt: 1,
    startedAt: "2026-08-22T02:01:00.000Z",
    completedAt: "2026-08-22T02:01:01.000Z",
    inputEvidenceRefs,
    outputFingerprint: createHash("sha256").update(JSON.stringify(canonicalize(output))).digest("hex"),
    externalPlatformAccesses: 0,
    codexDispatches: 0,
    productionWrites: 0,
    output,
    ...overrides
  };
}

export function authorizedExecution(request, candidateRevision = 12, { softwareJobId = "software-job:c1-sink:1", authorizationId = "authorization:c1-ai-draft:SINK-BLUE" } = {}) {
  return { schemaVersion: "c1-ai-authorized-execution-v1", jobId: softwareJobId, jobType: "c1_ai_draft",
    candidateRevision, sourceSkuRevision: request.sourceSkuRevision, identity: structuredClone(request.sourceIdentity),
    requestFingerprint: request.requestFingerprint, status: "waiting_platform", externalRequestState: "in_flight",
    authorizationRef: { authorizationId, authorizationType: "paid_ai_draft",
      scope: { candidateId: request.sourceIdentity.candidateId, skuPackageId: request.sourceIdentity.skuPackageId,
        platform: request.sourceIdentity.platform, storeRef: request.sourceIdentity.storeRef.stableStoreId,
        sourceRevision: request.sourceSkuRevision, jobType: "c1_ai_draft" } }
  };
}

export function settledExecution(request, result, admitted = authorizedExecution(request)) {
  return { schemaVersion: "c1-ai-settled-execution-v1", authorizedExecution: structuredClone(admitted),
    softwareJobId: result.softwareJobId, gatewayJobId: result.gatewayJobId,
    status: "completed", externalRequestState: "succeeded", receiptRef: result.receiptId };
}
