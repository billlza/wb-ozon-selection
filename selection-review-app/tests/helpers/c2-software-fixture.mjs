import { productionEvidenceForSku } from "../fixtures/production-profit-evidence-fixture.mjs";
import { createC2SoftwareContainer, prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from "../../lib/c2-software-orchestrator.mjs";
import { createProductionAuthorization, assertValidProductionAuthorization, buildProductionOwnerDecisionSnapshot } from "../../lib/production-authorization.mjs";
import { fingerprintCanonicalRecord } from "../../lib/production-contract-primitives.mjs";
import { createActorContext } from "../../lib/runtime-identity.mjs";
import { createFinalProductPlanConfirmationCard } from "../../lib/final-product-plan-confirmation-card.mjs";
import { createFormalC1C2Fixture } from "../fixtures/formal-c1-flow-fixture.mjs";
import { attachSyntheticFinalPricingReview } from "../fixtures/final-pricing-review-fixture.mjs";
export { packageFixture, fact, draft } from "../fixtures/c2-source-package-fixture.mjs";

const NOW = "2026-08-22T06:00:00.000Z";

export function productionAuthorizationInputFixture({ publishScope = "create_and_allow_validation_moderation", assets = finalAssets(),
  storeRef = { stableStoreId: "dandanshu", platformStoreId: "seller-dandanshu-001", mappingVersion: "stores-v1" },
  supplierSkuId = "SHELF-WHITE", candidateId: sourceCandidateId = "candidate:fixture:bathroom-shelf", merchantSku = "MERCHANT-SHELF-001",
  sourceCandidateRevision = 12, warehouseRef = "warehouse:synthetic:ozon", credentialAlias = "credential-alias:synthetic:ozon",
  allowedWriteFields = ["create_product", "title", "description", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
  exclusions = ["no_activation", "no_advertising", "no_other_sku_write"],
  buyerTargetPrice, platformWritePrice, priceConversion, sourceSkuPackage,
  executionBinding = { bindingId: "binding:synthetic:ozon", configurationVersion: "config-v1", warehouseId: "70001" }
} = {}) {
  const at = "2026-08-22T07:00:00.000Z";
  const formal = sourceSkuPackage ? null : createFormalC1C2Fixture({ candidateId: sourceCandidateId, supplierSkuId, storeRef,
    categoryPath: "Дом / Полки", productName: "合成浴室置物架", categoryName: "Полки для ванной", material: "plastic", variantKey: `颜色:${supplierSkuId}` });
  const source = sourceSkuPackage ?? formal.merged.skuPackage;
  const initialized = createC2SoftwareContainer({ skuPackage: source, expectedDataRevision: source.dataRevision, assetRegions: assetRegions(), createdAt: NOW });
  const manifest = prepareC2FinalUploadManifest({ skuPackage: initialized.skuPackage, expectedDataRevision: initialized.skuPackage.dataRevision, finalUploadAssets: assets, preparedAt: at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: initialized.skuPackage, expectedDataRevision: initialized.skuPackage.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: at });
  const reviewed = attachSyntheticFinalPricingReview(confirmed.skuPackage, { at, candidateRevision: sourceCandidateRevision });
  const skuPackage = createFinalProductPlanConfirmationCard({ skuPackage: reviewed, createdAt: at }).skuPackage;
  const model = confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.activeProfitModel;
  const commercialDecision = { selectedOption: "approve_for_production_authorization", merchantSku, warehouseRef, credentialAlias, stock: 100,
    buyerTargetPrice: buyerTargetPrice ?? { amount: model.recommendedSalePriceRub, currency: "RUB" },
    platformWritePrice: platformWritePrice ?? { amount: model.recommendedSalePriceCny, currency: "CNY" },
    priceConversion: structuredClone(priceConversion ?? model.priceConversion), publishScope, allowedWriteFields, exclusions, executionBinding: structuredClone(executionBinding) };
  const ownerActor = createActorContext({ userId: "synthetic-owner", sessionId: "synthetic-owner-session", actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: at });
  return { ...productionEvidenceForSku(skuPackage, sourceCandidateRevision), candidateId: skuPackage.g1Identity.candidateId, sourceCandidateRevision, currentCandidateRevision: sourceCandidateRevision, skuPackage, commercialDecision, ownerActor, authorizedAt: at };
}

export function authorizedProductionFixture(options) {
  const input = productionAuthorizationInputFixture(options);
  const result = createProductionAuthorization(input);
  return { ...result, candidateId: input.candidateId, candidateRevision: result.productionAuthorization.resultCandidateRevision, createdAt: input.authorizedAt };
}

/** An explicit old two-person record for read-only/rejection tests, never a current authorization. */
export function historicalAuthorizedProductionFixture(options) {
  const input = productionAuthorizationInputFixture(options);
  const { candidateId, sourceCandidateRevision, skuPackage: source, commercialDecision, authorizedAt } = input;
  const preparation = source.c2FinalAssets.productionAuthorizationPreparation;
  const legacyCommercialDecision = Object.fromEntries(Object.entries(commercialDecision).filter(([key]) => key !== "executionBinding"));
  const decision = { ...structuredClone(legacyCommercialDecision), decisionId: "owner-decision:synthetic:historical",
    sourceConfirmationCardId: source.productionConfirmationCard.cardId, sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint };
  const ownerDecisionSnapshot = buildProductionOwnerDecisionSnapshot({ candidateId, sourceCandidateRevision, skuPackage: source, preparation, ownerDecision: decision,
    contractVersion: "production-authorization-v1.1" });
  decision.ownerDecisionFingerprint = fingerprintCanonicalRecord(ownerDecisionSnapshot);
  decision.ownerConfirmation = { schemaVersion: "production-owner-confirmation-v1", decisionId: decision.decisionId,
    actorId: "synthetic-historical-owner", actorType: "human", role: "owner", confirmedAt: authorizedAt,
    sourcePreparationFingerprint: preparation.preparationFingerprint, sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceC1Fingerprint: preparation.sourceC1Fingerprint, sourceCandidateRevision, sourceSkuRevision: source.dataRevision,
    ownerDecisionFingerprint: decision.ownerDecisionFingerprint };
  const sourceIdentity = structuredClone(preparation.finalCardInputSnapshot.identity);
  const identity = { ...structuredClone(sourceIdentity), merchantSku: decision.merchantSku, warehouseRef: decision.warehouseRef, credentialAlias: decision.credentialAlias };
  const authorizationId = `production-auth:${source.skuPackageId}:${preparation.preparationFingerprint}:${decision.decisionId}`;
  const productionAuthorization = {
    schemaVersion: "production-authorization-v1.1", authorizationId, status: "confirmed", confirmedBy: "owner",
    confirmedByActorId: decision.ownerConfirmation.actorId, confirmedAt: authorizedAt,
    authorizedByActorId: "synthetic-historical-technical-authorizer", authorizedAt,
    ownerDecisionId: decision.decisionId, ownerConfirmation: structuredClone(decision.ownerConfirmation),
    technicalAuthorization: { schemaVersion: "production-technical-authorization-v1", actorId: "synthetic-historical-technical-authorizer",
      actorType: "human", role: "production_authorizer", authorizedAt },
    ownerDecisionFingerprint: decision.ownerDecisionFingerprint, ownerDecisionSnapshot,
    sourceConfirmationCardId: decision.sourceConfirmationCardId, sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint, sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision, resultCandidateRevision: sourceCandidateRevision + 1, authorizedDataRevision: source.dataRevision, resultDataRevision: source.dataRevision + 1,
    sourceIdentity, identity,
    lockedScope: { candidateId, skuPackageId: source.skuPackageId, variantKey: source.variantKey, platform: sourceIdentity.platform,
      storeRef: structuredClone(sourceIdentity.storeRef), merchantSku: decision.merchantSku, supplierSkuId: sourceIdentity.supplierSkuId,
      warehouseRef: decision.warehouseRef, credentialAlias: decision.credentialAlias, schemaRevision: preparation.targetContext.schemaRevision,
      schemaEvidenceRef: preparation.targetContext.schemaEvidenceRef,
      activeProfitModelVersion: preparation.finalCardInputSnapshot.activeProfitModelVersion,
      buyerTargetPrice: structuredClone(decision.buyerTargetPrice), platformWritePrice: structuredClone(decision.platformWritePrice),
      priceConversion: structuredClone(decision.priceConversion), stock: decision.stock, authorizedMediaFingerprint: preparation.authorizedMediaFingerprint,
      finalManifestVersion: preparation.finalManifestVersion, finalManifestSha256: preparation.finalManifestSha256,
      finalUploadsFingerprint: preparation.finalUploadsFingerprint, mainImageAssetId: preparation.mainImageAssetId,
      videoDisposition: preparation.videoDisposition, effectiveVideoRequirement: structuredClone(preparation.effectiveVideoRequirement),
      finalUploads: structuredClone(preparation.finalUploads), finalCardInputSnapshot: structuredClone(preparation.finalCardInputSnapshot),
      publishScope: decision.publishScope, allowedWriteFields: structuredClone(decision.allowedWriteFields), exclusions: structuredClone(decision.exclusions) },
    scopeExpansionAllowed: false, fieldMutationAllowed: false, skuReplacementAllowed: false, assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only", productionExecuted: false, platformWrites: 0
  };
  assertValidProductionAuthorization(productionAuthorization, { candidateId, candidateRevision: sourceCandidateRevision, skuPackage: source, lifecycleState: "source" });
  const dHandoff = { schemaVersion: "c2-d-handoff-v1", handoffId: `d-handoff:${authorizationId}`, status: "awaiting_explicit_d_start", candidateId,
    skuPackageId: source.skuPackageId, identity: structuredClone(identity), variantKey: source.variantKey, productionAuthorizationId: authorizationId,
    ownerDecisionId: decision.decisionId, sourcePreparationFingerprint: preparation.preparationFingerprint, sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceCandidateRevision, resultCandidateRevision: sourceCandidateRevision + 1, sourceSkuRevision: source.dataRevision, resultSkuRevision: source.dataRevision + 1,
    createdAt: authorizedAt, uniqueOwner: "d_software", productionPlanCreated: false, executionIntentCreated: false, softwareJobCreated: false,
    dWritePermissionGranted: false, externalRequests: 0, platformWrites: 0 };
  const skuPackage = structuredClone(source);
  skuPackage.productionConfirmationCard.ownerDecision = decision;
  skuPackage.productionConfirmationCard.status = "owner_business_approved";
  skuPackage.productionConfirmationCard.cardRevision += 1;
  skuPackage.productionAuthorization = structuredClone(productionAuthorization); skuPackage.dHandoff = structuredClone(dHandoff);
  skuPackage.dataRevision += 1; skuPackage.businessResult = "passed";
  return { skuPackage, productionAuthorization, dHandoff, candidateId, candidateRevision: sourceCandidateRevision + 1, createdAt: authorizedAt };
}

const SHA_D = "d".repeat(64);
const SHA_G = "1".repeat(64);

export function assetRegions() {
  return {
    collected: [{
      assetId: "collected:fixture:shelf:1",
      mediaType: "image",
      assetRef: "https://source.example.com/shelf-1.jpg",
      assetVersion: "asset-v1",
      sha256: SHA_G,
      sourcePlatform: "ozon",
      sourceEvidenceRef: "evidence:sales:shelf-1",
      usageAuthorization: { status: "analysis_reference_only", evidenceRef: "rights:sales:shelf-1" }
    }],
    aiDrafts: [{
      assetId: "ai-draft:fixture:shelf:1",
      mediaType: "image",
      assetRef: "https://drafts.example.com/shelf-1-v1.jpg",
      assetVersion: "asset-v1",
      sha256: SHA_D,
      generatorRef: "receipt:fixture:image-draft-1",
      sourceEvidenceRef: "receipt:fixture:image-draft-1",
      usageAuthorization: { status: "draft_reference_only", evidenceRef: "rights:ai-draft:shelf-1" }
    }],
    finalUploads: []
  };
}

export function finalAssets() {
  return [
    {
      assetId: "final:fixture:shelf:main",
      mediaType: "image",
      assetRef: "https://assets.example.com/owner/shelf-main-v1.jpg",
      fileName: "shelf-main.jpg",
      byteSize: 512, width: 1200, height: 1600,
      assetVersion: "final-v1",
      sha256: "a".repeat(64),
      sourceEvidenceRef: "owner-upload:shelf-main",
      stableUrlEvidenceRef: "stable-url:shelf-main-v1",
      usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "owner-confirmation:shelf-final-v1" },
      sourceType: "owner_provided_final_upload",
      order: 1,
      role: "main_image"
    },
    {
      assetId: "final:fixture:shelf:detail",
      mediaType: "image",
      assetRef: "https://assets.example.com/owner/shelf-detail-v1.jpg",
      fileName: "shelf-detail.jpg",
      byteSize: 640, width: 1200, height: 1600,
      assetVersion: "final-v1",
      sha256: "b".repeat(64),
      sourceEvidenceRef: "owner-upload:shelf-detail",
      stableUrlEvidenceRef: "stable-url:shelf-detail-v1",
      usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "owner-confirmation:shelf-final-v1" },
      sourceType: "owner_provided_final_upload",
      order: 2,
      role: "gallery_image"
    }
  ];
}

export function localFinalAssets() {
  return finalAssets().map((asset, index) => {
    const assetId = `c2-local:00000000-0000-4000-8000-00000000000${index + 1}`;
    return { ...asset, assetId, assetRef: `local-asset:${assetId}`, assetVersion: `sha256:${asset.sha256}`, stableUrlEvidenceRef: "not_applicable" };
  });
}

export function ownerDecision(manifest) {
  return {
    status: "confirmed",
    confirmedBy: "owner",
    approvedManifestVersion: manifest.schemaVersion,
    approvedManifestSha256: manifest.manifestSha256,
    approvedAuthorizedMediaFingerprint: manifest.authorizedMediaFingerprint,
    approvedAssetIds: manifest.approvedAssetIds,
    approvedMainImageAssetId: manifest.mainImageAssetId,
    approvedVideoDisposition: manifest.videoDisposition
  };
}
