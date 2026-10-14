import { createSyntheticBCostPolicy } from "./b-cost-policy-fixture.mjs";
import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS } from "./c1-sku-rights-review-fixture.mjs";
import { adaptLegacyCandidateToOpportunity } from "../../lib/legacy-candidate-adapter.mjs";
import { sanitize1688Evidence } from "../../lib/source-capture.mjs";
import { adapt1688CaptureToSupplierOption } from "../../lib/supplier-option.mjs";
import { createOwnerSupplyConfirmation, createSkuLifecycleFromConfirmedSupply, recommendSupplierOption } from "../../lib/supplier-selection-flow.mjs";
import { runSkuProfitModel } from "../../lib/profit-model.mjs";
import { appendProfitModelVersion } from "../../lib/product-lifecycle-schema.mjs";
import { createC1ProductPlan, verifyC1ProductFacts } from "../../lib/c1-product-plan.mjs";
import { buildC1AiDraftRequest, mergeC1AiDraftReceipt, createC1AiAccounting } from "../../lib/c1-ai-draft-contract.mjs";
import { fingerprintCanonicalRecord } from "../../lib/production-contract-primitives.mjs";
import { createC2SoftwareContainer } from "../../lib/c2-software-orchestrator.mjs";
import { projectC1CompetitorTextSnapshot } from "../../lib/c1-software-input-preparation.mjs";
import { authorizedExecution, settledExecution } from "./c1-ai-draft-fixture.mjs";
import { attachPassedMarketAssessment } from "../helpers/market-assessment-fixture.mjs";
import { createTrainCandidateInput } from "./legacy-candidate-input-fixture.mjs";
import { packageFixture } from "./c2-source-package-fixture.mjs";

export const VARIANT = "规格:豪华小火车";
export const FORMAL_C1_CREATED_AT = "2026-08-12T13:00:00.000Z";

export function phase7PassedState({ sellerType = "cross_border_cn", fullC1Facts = false, commissionMode = "exact",
  candidateId = "CX-20260803-010", supplierSkuId = "4993364145574", variantKey = VARIANT,
  sourceOfferId = "712421624571", productName = "机械发条木质火车", material = "DVP木纤维板", skuAttributes = {},
  captureId = "SC-8f132e8e-425e-401a-8c72-13c32290d8b8", productUrl, imageUrl, categoryPath,
  salesSnapshotVersion, salesAttributes = {},
  expectedPriceRub = 1831, actualPurchaseCost = 41, unitProductPrice = 40, unitDomesticFreight = 1,
  packedWeightKg = 0.3, dimensionsCm = { length: 23, width: 16, height: 3 }, internationalFreightRmb = 26.4,
  returnReserveRate = 0.05, previousProfitModels = [],
  storeRef = { stableStoreId: "dandanshu", platformStoreId: "fixture-seller-001", mappingVersion: "fixture-stores-v1" }
} = {}) {
  const candidate = createTrainCandidateInput({ candidateId, supplierSkuId, sourceOfferId, variantKey, storeRef, productName,
    expectedPriceRub, purchasePriceRmb: actualPurchaseCost, packedWeightKg, dimensionsCm, returnOpsReserveRate: returnReserveRate,
    captureId, internationalFreightRmb, productUrl, imageUrl, categoryPath, salesAttributes });
  const delimiter = variantKey.indexOf(":");
  if (delimiter < 1 || delimiter === variantKey.length - 1) throw new Error("FIXTURE_VARIANT_INVALID: 规格必须显式声明属性名和值");
  const attributes = { material, ...structuredClone(skuAttributes), [variantKey.slice(0, delimiter)]: variantKey.slice(delimiter + 1) };
  const opportunity = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunity.salesSnapshots[0].platform = "ozon";
  opportunity.salesSnapshots[0].categoryPath = candidate.codexReview.category.path;
  opportunity.salesSnapshots[0].sellerType = sellerType;
  opportunity.salesSnapshots[0].sellerIdentityEvidence = {
    status: sellerType === "unknown" ? "unverified" : "verified",
    evidenceRef: sellerType === "unknown" ? "test:seller-identity:unknown" : "test:cross-border-cn"
  };
  // Requesting a version selects the existing mock collector's typed snapshot, never relabels a legacy one.
  const selectedSales = salesSnapshotVersion === undefined ? opportunity.salesSnapshots[0]
    : opportunity.salesSnapshots.find(snapshot => snapshot.schemaVersion === salesSnapshotVersion);
  if (!selectedSales) throw new Error("FIXTURE_SALES_VERSION_UNAVAILABLE: 必须选择实际模拟采集器产出的销售快照版本");
  attachPassedMarketAssessment(opportunity, { sellerType, price: expectedPriceRub, snapshotId: selectedSales.snapshotId });
  const evidence = sanitize1688Evidence({
    offerId: sourceOfferId,
    sourceUrl: `https://detail.1688.com/offer/${sourceOfferId}.html`,
    observedAt: "2026-08-12T12:00:00.000Z",
    title: productName,
    supplierSalesEvidence: { salesVolume: 500, stabilityScore: 80 },
    supplierBadges: ["牛头供应商"],
    skus: [{
      sourceSkuId: supplierSkuId,
      propPath: variantKey,
      attributes,
      priceCny: null,
      priceSource: null,
      stock: null,
      stockSource: null,
      imageUrl: null
    }]
  }, sourceOfferId);
  evidence.supplierSalesEvidence = { salesVolume: 500, stabilityScore: 80 };
  evidence.supplierBadges = ["牛头供应商"];
  evidence.skus[0].weight = { value: packedWeightKg, unit: "kg" };
  evidence.skus[0].dimensions = { ...structuredClone(dimensionsCm), unit: "cm" };
  evidence.skus[0].material = material;
  evidence.skus[0].powerProfile = fullC1Facts
    ? { powered: false, containsBattery: false, batteryType: "not_applicable", batteryCount: 0, batteryCapacity: "not_applicable" }
    : { powered: false };
  const option = structuredClone(adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: `source-capture:${captureId}`
  }));
  option.supplierSalesEvidence = evidence.supplierSalesEvidence;
  option.supplierBadges = evidence.supplierBadges;
  // Explicit typed fixture facts are supplied before the owner freezes this SKU.
  option.supplierSkus[0].attributes = { ...option.supplierSkus[0].attributes, ...structuredClone(skuAttributes) };
  option.supplierSkus[0].actualPurchaseCost = actualPurchaseCost;
  option.supplierSkus[0].unitProductPrice = unitProductPrice;
  option.supplierSkus[0].unitDomesticFreight = unitDomesticFreight;

  opportunity.businessPhase = "A";
  opportunity.businessResult = "passed";
  opportunity.technicalStatus = "completed";
  opportunity.ownerAction = "confirm_supplier_option";
  opportunity.supplierOptions = [option];
  opportunity.recommendedSupplierOptionId = null;
  opportunity.confirmedSupplierOptionId = null;

  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: variantKey,
    scoredAt: "2026-08-12T12:10:00.000Z"
  });
  const confirmation = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: option.supplierOptionId,
      supplierSkuId: option.supplierSkus[0].supplierSkuId,
      variantKey
    },
    confirmedAt: "2026-08-12T12:11:00.000Z"
  });
  let skuPackage = createSkuLifecycleFromConfirmedSupply({
    candidateId: candidate.id,
    storeRef: candidate.storeRef,
    opportunityPackage: confirmation.opportunityPackage,
    ownerSupplyConfirmation: confirmation.confirmation,
    skuPackageId: `sku-lifecycle:${candidateId}:${supplierSkuId}`,
    createdAt: "2026-08-12T12:12:00.000Z"
  });
  for (const priorModel of previousProfitModels) skuPackage = appendProfitModelVersion(skuPackage, priorModel);
  const costPolicyContext = { platform: skuPackage.targetPlatform, store: skuPackage.targetStore, storeRef: structuredClone(skuPackage.g1Identity.storeRef), salesScheme: "rfbs" };
  const costPolicySnapshot = createSyntheticBCostPolicy({ scope: costPolicyContext, values: { returnReserveRate } });
  const result = runSkuProfitModel({
    opportunityPackage: confirmation.opportunityPackage,
    skuPackage,
    salesSelection: {
      salesSnapshotId: selectedSales.snapshotId,
      pricePath: salesSnapshotVersion === undefined ? "marketEvidence.exactTarget.lowestOtherOfferRub" : "currentPrice",
      currency: "RUB"
    },
    platformFeeEvidence: {
      costPolicyContext, costPolicySnapshot,
      evidenceId: "platform-fees:ozon:dandanshu:17028665:rfbs:2026-08-12",
      commissionEvidenceMode: commissionMode,
      commissionRate: 0.14,
      sourceType: "real_same_description_category_seller_api",
      otherCosts: {
        acquiringRate: 0, taxRate: 0, otherRate: 0,
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: costPolicySnapshot.policyVersion
      }
    },
    logisticsEvidence: {
      evidenceId: `logistics:guoo:economy-small:2026-07-20:${packedWeightKg}kg`,
      route: "GUOO Economy Small PUDO/Courier",
      amountRmb: internationalFreightRmb,
      billableWeightKg: packedWeightKg,
      effectiveDate: "2026-07-20"
    },
    exchangeRateEvidence: {
      evidenceId: "fx:cbr:2026-08-07:RUB-CNY",
      rubPerCny: 12.0637,
      sourceType: "official"
    },
    calculatedAt: "2026-08-12T12:20:00.000Z"
  });
  return { candidate, opportunityPackage: confirmation.opportunityPackage, skuPackage: result.skuPackage };
}

export function platformSchemaEvidence({ storeRef } = {}) {
  return {
    evidenceId: "schema:ozon:dandanshu:17028665:92935:2026-08-12",
    platform: "ozon",
    store: storeRef ? storeRef.stableStoreId : "dandanshu",
    descriptionCategoryId: "17028665",
    typeId: "92935",
    categoryName: "3D-пазл",
    schemaRevision: "ozon-schema:17028665:92935:2026-08-12",
    requiredFields: [
      { fieldKey: "brand", label: "品牌", required: true },
      { fieldKey: "model_name", label: "模型名", required: true },
      { fieldKey: "type", label: "类型", required: true }
    ],
    collectedAt: "2026-08-12T02:30:00.000Z"
  };
}

/** Synthetic evidence and receipt for the real B/C1 functions; this is not a persisted or platform completion. */
export function createFormalC1DraftFixture({ at = FORMAL_C1_CREATED_AT, candidateRevision = 27,
  softwareJobId = "software-job:formal-c1:1", gatewayJobId = "gateway-job:synthetic:1",
  authorizationId = "authorization:c1-ai-draft:FORMAL-C1",
  categoryName = "3D-пазл", projectCompetitorTexts = false, platformAttributes = null,
  platformRequiredFields = null,
  rightsReviewOptions = { brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS }, ...sourceOptions
} = {}) {
  const state = phase7PassedState({ ...sourceOptions, fullC1Facts: true });
  const schema = platformSchemaEvidence({ storeRef: state.skuPackage.g1Identity.storeRef });
  schema.storeRef = structuredClone(state.skuPackage.g1Identity.storeRef);
  schema.categoryName = categoryName;
  schema.ruleVersion = schema.schemaRevision;
  schema.categoryId = "category:ozon:3d-puzzle";
  schema.requiredFields = platformRequiredFields === null
    ? [{ fieldKey: "material", label: "材质", required: true, sourceAttributeKeys: ["material"] }]
    : structuredClone(platformRequiredFields);
  schema.categoryRestrictions = [];
  if (platformAttributes !== null) schema.attributes = structuredClone(platformAttributes);
  schema.platformCompliance = { status: "clear" };
  const declared = packageFixture({ executableOzon: true }).c1ProductPlan.inputSnapshots.platformSchemaRules;
  schema.writeBindings = { ...structuredClone(declared.writeBindings), evidenceRef: schema.evidenceId, schemaRevision: schema.schemaRevision };
  const before = structuredClone(state.skuPackage);
  const created = createC1ProductPlan({ ...state, platformSchemaEvidence: schema, createdAt: at });
  const skuRightsReview = rightsReviewOptions === null ? null : syntheticSkuRightsReview({ ...rightsReviewOptions,
    plan: created.c1ProductPlan, sourceIdentity: created.skuPackage.g1Identity, reviewedAt: at });
  const checked = verifyC1ProductFacts({ skuPackage: created.skuPackage, skuRightsReview, verifiedAt: at });
  const verifiedCategoryName = checked.c1ProductPlan.platformCategory.categoryName.value;
  const keywordRef = "keyword:synthetic:3d-puzzle";
  const request = buildC1AiDraftRequest({ skuPackage: checked.skuPackage,
    competitorTextSnapshot: projectCompetitorTexts ? projectC1CompetitorTextSnapshot(checked.c1ProductPlan) : {
      snapshotId: "competitor-text:synthetic:3d-puzzle", evidenceRef: "text:synthetic:3d-puzzle",
      sourceSalesSnapshotId: checked.c1ProductPlan.inputRefs.salesSnapshotId, observedAt: at,
      texts: [{ textId: "text:synthetic:1", text: verifiedCategoryName, sourceRef: "competitor:synthetic:1" }] },
    keywordEvidence: { evidenceId: "seo:synthetic:3d-puzzle", status: "ready", targetPlatform: "ozon",
      targetSkuPackageId: checked.skuPackage.skuPackageId, observedAt: at, collectionMode: "reused_verified_evidence", sourcePlatform: "ozon",
      keywords: [{ query: verifiedCategoryName, group: "core_product_type", keywordEvidenceRef: keywordRef,
        relevanceStatus: "retained", factBindingPaths: ["platformCategory.categoryName"] }] },
    seoRules: { rulesVersion: "seo:synthetic:v1", locale: "ru-RU", titleMaxLength: 120, descriptionMaxLength: 1200, bulletPointLimit: 5, prohibitedClaims: [] },
    taskClassification: { complexity: "standard", preapprovedForSol: false, reason: "单SKU草稿", markedBy: "software", markedAt: at },
    requestedAt: at });
  const cited = { text: verifiedCategoryName, factRefs: ["platformCategory.categoryName"], keywordRefs: [keywordRef],
    assertions: [{ factPath: "platformCategory.categoryName", value: verifiedCategoryName }] };
  const pieceFact = checked.c1ProductPlan.productAttributes.supplierAttributes.findIndex(item => item.fieldKey === "piece_count");
  if (pieceFact >= 0) {
    const value = checked.c1ProductPlan.productAttributes.supplierAttributes[pieceFact].fact.value;
    const factPath = `productAttributes.supplierAttributes.${pieceFact}.fact`;
    cited.text += `, ${value} детали`;
    cited.factRefs.push(factPath);
    cited.assertions.push({ factPath, value });
  }
  const output = { status: "draft_only", locale: "ru-RU", claimCoverage: "complete", unsupportedClaims: [],
    title: structuredClone(cited), description: structuredClone(cited),
    bulletPoints: [structuredClone(cited)], searchKeywords: [structuredClone(cited)] };
  const receipt = { schemaVersion: "c1-ai-draft-receipt-v1", receiptId: "receipt:synthetic:c1:1", providerRequestId: "provider-call:synthetic:1",
    softwareJobId, gatewayJobId, requestId: request.requestId,
    accounting: createC1AiAccounting({ gatewayJobId, providerRequestId: "provider-call:synthetic:1" }),
    requestFingerprint: request.requestFingerprint, provider: request.provider, modelVersion: "terra-synthetic-v1", serviceVersion: "gateway-synthetic-v1",
    status: "completed", attempt: 1, startedAt: at, completedAt: at,
    inputEvidenceRefs: [...new Set([request.competitorTextEvidence.evidenceRef, request.keywordEvidence.evidenceId,
      ...request.verifiedFacts.flatMap(fact => fact.evidenceRefs)])],
    outputFingerprint: fingerprintCanonicalRecord(output), output, externalPlatformAccesses: 0, codexDispatches: 0, productionWrites: 0 };
  const admitted = authorizedExecution(request, candidateRevision, { softwareJobId, authorizationId });
  const saved = settledExecution(request, receipt, admitted);
  const candidate = { ...state.candidate, dataRevision: candidateRevision,
    lifecycleV11: { opportunityPackage: state.opportunityPackage, skuPackage: checked.skuPackage } };
  return { candidate, state, before, schema, created, checked, request, receipt,
    authorizedExecution: admitted, settledExecution: saved, at };
}

export function createFormalC1C2Fixture(options = {}) {
  const fixture = createFormalC1DraftFixture(options);
  const { checked, request, receipt, settledExecution: saved, at } = fixture;
  const merged = mergeC1AiDraftReceipt({ skuPackage: checked.skuPackage, request, receipt, settledExecution: saved, mergedAt: at });
  const c2 = createC2SoftwareContainer({ skuPackage: merged.skuPackage, expectedDataRevision: merged.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: at });
  return { ...fixture, merged, c2,
    candidate: { ...fixture.candidate, lifecycleV11: { ...fixture.candidate.lifecycleV11, skuPackage: c2.skuPackage } } };
}
