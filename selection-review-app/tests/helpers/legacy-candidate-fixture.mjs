import { SYNTHETIC_UNBRANDED, SYNTHETIC_NO_THIRD_PARTY_RIGHTS } from "../fixtures/c1-sku-rights-review-fixture.mjs";
import { collectRealOzonSalesSnapshot } from "../../lib/sales-snapshot.mjs";
import { adaptLegacyCandidateToOpportunity } from "../../lib/legacy-candidate-adapter.mjs";
import { createProductionAuthorization } from "../../lib/production-authorization.mjs";
import { createExternalListingRecord, verifyExternalListing } from "../../lib/e-stage-readback.mjs";
import { createTrainCandidateInput } from "../fixtures/legacy-candidate-input-fixture.mjs";
import { createFormalC1C2Fixture, phase7PassedState } from "../fixtures/formal-c1-flow-fixture.mjs";
import { finalAssets, productionAuthorizationInputFixture } from "./c2-software-fixture.mjs";

const observedAt = "2026-08-12T03:50:00.000Z";

export function createGenericCStageCandidate() {
  const state = phase7PassedState({
    candidateId: "GENERIC-NON-TRAIN-001", supplierSkuId: "SINK-ORGANIZER-BLUE", sourceOfferId: "900000000001",
    captureId: "test:sink-organizer", variantKey: "颜色:蓝色", productName: "硅胶水槽收纳架",
    productUrl: "https://www.ozon.ru/product/sink-organizer-test/", imageUrl: "https://example.invalid/sink-organizer-source.jpg",
    categoryPath: "Дом и сад > Кухня > Органайзеры", material: "silicone", expectedPriceRub: 1200,
    actualPurchaseCost: 20, unitProductPrice: 16, unitDomesticFreight: 4, packedWeightKg: 0.25,
    dimensionsCm: { length: 22, width: 11, height: 4 }, internationalFreightRmb: 20,
    skuAttributes: { product_type: "水槽收纳架", color: "蓝色", model_name: "水槽收纳架" }, fullC1Facts: true
  });
  return structuredClone({ ...state.candidate, workflowStatus: "listing_preparation", dataRevision: 1,
    processing: { state: "idle", manualHold: false }, listingPreparation: { status: "c1_ready" },
    listingHandoff: { state: "queued", owner: "listing_task" },
    lifecycleV11: { status: "b_passed_auto_c1", opportunityPackage: state.opportunityPackage,
      skuPackage: state.skuPackage, platformWrites: 0, externalAccesses: [] } });
}

export function createTrainCandidate({ lifecycle = true, returnOpsReserveRate = 0.05, ...sourceOptions } = {}) {
  if (!lifecycle) return createTrainCandidateInput({ returnOpsReserveRate, ...sourceOptions });
  const fixture = createFormalC1C2Fixture({ returnReserveRate: returnOpsReserveRate, material: "DVP", rightsReviewOptions: { brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS },
    productName: "机械发条DVP火车320件3D拼图", skuAttributes: { brand: "Нет бренда", piece_count: 320, mechanism: "mechanical_wind_up" },
    ...sourceOptions });
  return structuredClone({ ...fixture.candidate,
    lifecycleV11: { ...fixture.candidate.lifecycleV11, status: "awaiting_final_uploads", platformWrites: 0, externalAccesses: [] } });
}

export function createMusicBoxCandidate() {
  const candidate = {
    id: "CX-20260802-014",
    productName: "手摇缝纫机音乐盒",
    dataRevision: 7,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: observedAt,
    history: [],
    targetStore: "dandanshu",
    storeRef: { stableStoreId: "dandanshu", platformStoreId: "fixture-seller-001", mappingVersion: "fixture-stores-v1" },
    targetPlatform: "ozon",
    workflowStatus: "codex_processing",
    source: "user",
    productUrl: "https://www.ozon.ru/product/test-music-box-4403916892/",
    imageUrl: "https://example.com/test-music-box.png",
    sourceUrl: "https://detail.1688.com/offer/876240928352.html",
    purchasePriceRmb: 17.3,
    expectedPriceRub: 1462,
    packagingCostRmb: 1.5,
    packedWeightKg: 0.4,
    dimensionsCm: { length: 12, width: 12, height: 7 },
    sourceCapture: { captureId: "test-capture-music-box", status: "verified", originalSourceUrl: "https://qr.1688.com/s/7OnLCakq", sourceUrl: "https://detail.1688.com/offer/876240928352.html", offerId: "876240928352", observedAt, selectedSkus: [] },
    codexReview: { cStageReview: { categoryPath: "Музыкальные шкатулки" } }
  };
  // The adapter consumes an observation object; it does not open a page.
  // Keeping this mode exercises category derivation instead of pre-filling its result.
  candidate.salesSnapshotsV11 = [collectRealOzonSalesSnapshot({
    sourceMode: "real_ozon_page_observation", technicalStatus: "completed",
    snapshotId: `fixture-sales:${candidate.id}`, marketScope: "ozon_general_market",
    sellerIdentitySignals: [], sellerIdentityEvidenceRef: "test:unknown-seller",
    productUrl: candidate.productUrl, title: candidate.productName, imageRefs: [candidate.imageUrl],
    currentPrice: candidate.expectedPriceRub, currency: "RUB", categoryPath: "Музыкальные шкатулки",
    attributes: { description_category_id: 17028743, type_id: 971097529 },
    collectedAt: observedAt, evidenceRef: `test:sales:${candidate.id}`
  })];
  candidate.lifecycleV11 = { opportunityPackage: structuredClone(adaptLegacyCandidateToOpportunity(candidate)) };
  return candidate;
}

export function createLegacyCandidateDocument() {
  const train = createTrainCandidate({ lifecycle: false });
  const candidates = [train, createMusicBoxCandidate()];
  for (let index = 2; index < 52; index += 1) {
    candidates.push({
      id: `TEST-LEGACY-${index}`,
      productName: `合成旧候选${index}`,
      createdAt: observedAt,
      updatedAt: observedAt,
      dataRevision: index,
      history: [],
      purchasePriceRmb: index === 2 ? null : index,
      workflowStatus: index === 3 ? "eliminated" : "codex_processing"
    });
  }
  return { candidates };
}

// Reuses the formal domain chain with fresh synthetic source evidence. This is
// not a production operation for correcting an existing frozen C1/C2 package.
export function createTrainFinalAssetsFixture({ candidateId = "CX-20260803-010",
  files = ["09-成品图-俄文.png", "01-成品图-俄文.png", "05-成品图-俄文.png", "详情-01.jpg", "详情-02.jpg"]
} = {}) {
  const before = createTrainCandidate({ candidateId, returnOpsReserveRate: 0.03 });
  const fixture = createFormalC1C2Fixture({ candidateId, returnReserveRate: 0.03, material: "DVP", rightsReviewOptions: { brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS },
    productName: "机械发条DVP火车282件3D拼图", packedWeightKg: 0.21, internationalFreightRmb: 23.87,
    captureId: "test:train:282:210g", skuAttributes: { brand: "Нет бренда", piece_count: 282, mechanism: "mechanical_wind_up" },
    previousProfitModels: before.lifecycleV11.skuPackage.profitModels,
    softwareJobId: "software-job:train-final:1", gatewayJobId: "gateway-job:train-final:1",
    authorizationId: "authorization:c1-ai-draft:TRAIN-FINAL" });
  const templates = finalAssets();
  const assets = files.map((fileName, index) => ({ ...structuredClone(templates[index === 0 ? 0 : 1]),
    assetId: `test-final-${index + 1}`, fileName, order: index + 1,
    assetRef: `https://assets.example.com/train/final-${index + 1}.${fileName.endsWith(".jpg") ? "jpg" : "png"}`,
    sha256: `a${index + 1}`.repeat(32), sourceEvidenceRef: `owner-upload:train:${index + 1}`,
    stableUrlEvidenceRef: `stable-url:train:${index + 1}` }));
  const authorizationInput = productionAuthorizationInputFixture({ sourceSkuPackage: fixture.merged.skuPackage,
    sourceCandidateRevision: fixture.candidate.dataRevision, assets, merchantSku: "MERCHANT-TRAIN-001",
    publishScope: "create_draft_only", exclusions: ["no_publish_or_activation", "no_moderation_submission"] });
  return { before, fixture, authorizationInput, skuPackage: authorizationInput.skuPackage, confirmationCard: authorizationInput.skuPackage.productionConfirmationCard };
}

export function createAuthorizedTrainCandidate(options = {}) {
  const { fixture, authorizationInput } = createTrainFinalAssetsFixture(options);
  const authorized = createProductionAuthorization(authorizationInput);
  return structuredClone({ ...fixture.candidate, dataRevision: authorized.productionAuthorization.resultCandidateRevision,
    lifecycleV11: { ...fixture.candidate.lifecycleV11, skuPackage: authorized.skuPackage,
      status: "awaiting_explicit_d_start", platformWrites: 0, externalAccesses: [] } });
}

export function createVerifiedGenericCandidate() {
  const candidate = createAuthorizedTrainCandidate({ candidateId: "GENERIC-LIFECYCLE-E-READBACK" });
  const sku = candidate.lifecycleV11.skuPackage;
  const observation = {
    platform: sku.targetPlatform,
    store: sku.targetStore,
    skuPackageId: sku.skuPackageId,
    supplierSkuId: sku.supplierSkuId,
    platformProductId: "TEST-EXTERNALLY-VERIFIED-001",
    merchantSku: sku.productionAuthorization.lockedScope.merchantSku,
    currentPrice: { amount: 153, currency: "CNY" },
    currentStock: 100,
    imageCount: 5,
    moderationStatus: "approved",
    validationStatus: "success",
    saleStatus: "on_sale",
    errors: [],
    platformEvidenceRef: "test:external-observation:generic-e-readback"
  };
  // These domain functions validate in-memory observations only; no platform
  // readback, production execution, or external adapter is invoked.
  const externalListingRecord = createExternalListingRecord({
    observation: { ...observation, discoverySource: "seller_portal" },
    ownerPriceDecision: {
      decision: "keep_current_live_price",
      confirmedBy: "owner",
      confirmedAt: "2026-08-22T09:00:00.000Z",
      price: structuredClone(observation.currentPrice)
    },
    discoveredAt: "2026-08-22T09:05:00.000Z"
  });
  const verification = verifyExternalListing({
    externalListingRecord,
    verifiedObservation: observation,
    verifiedAt: "2026-08-22T09:10:00.000Z"
  });
  sku.externalListingRecord = structuredClone(externalListingRecord);
  sku.eVerificationRecord = structuredClone(verification);
  sku.businessPhase = "E";
  sku.businessResult = "passed";
  sku.technicalStatus = "completed";
  sku.ownerAction = "none";
  sku.readbackPolicy = { ...sku.readbackPolicy, status: "completed", automaticAttempts: 1 };
  sku.readbackHistory = [{
    verificationId: verification.verificationId,
    path: verification.verificationPath,
    outcome: verification.outcome,
    platformProductId: verification.platformProductId,
    verifiedAt: verification.verifiedAt,
    evidenceRef: verification.platformEvidenceRef
  }];
  candidate.lifecycleV11.status = verification.outcome;
  candidate.lifecycleV11.platformWrites = 0;
  return candidate;
}
