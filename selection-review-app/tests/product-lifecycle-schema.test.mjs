import { phase7PassedState } from "./fixtures/formal-c1-flow-fixture.mjs";
import { productionAuthorizationInputFixture } from "./helpers/c2-software-fixture.mjs";
import { fingerprintAuthorizedMedia } from "../lib/production-authorization-preparation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  assertNoProductionSecrets,
  appendProfitModelVersion,
  fingerprintCanonicalRecord,
  readbackStopReason,
  supplierSearchStopReason,
  validateC2ProductionAuthorizationPreparationRecord,
  validateLifecyclePackage,
  validateLifecycleTransition,
  validateOpportunityPackage,
  validateSkuLifecyclePackage
} from "../lib/product-lifecycle-schema.mjs";
import {
  assertIndependentProductionAuthorizationActors,
  assertCurrentProductionAuthorization,
  buildProductionOwnerDecisionSnapshot,
  createProductionAuthorization,
  readAuthorizedProductionSnapshot,
  validateProductionAuthorizationPreparation,
  validateProductionAuthorization
} from "../lib/production-authorization.mjs";
import {
  validateProductionAuthorizationPreparation as validatePreparationFromNeutralContract
} from "../lib/production-authorization-preparation.mjs";

const NOW = "2026-08-12T08:00:00.000Z";

function opportunity(overrides = {}) {
  return {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "OpportunityPackage",
    parentOpportunityId: "OPP-001",
    dataRevision: 0,
    directionName: "木质机械模型",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    businessPhase: "A",
    businessResult: "pending",
    technicalStatus: "not_started",
    ownerAction: "none",
    salesSnapshots: [],
    supplierOptions: [],
    recommendedSupplierOptionId: null,
    confirmedSupplierOptionId: null,
    supplierSearch: {
      status: "not_started",
      limits: {
        maxSearchRounds: 3,
        maxSupplierOptions: 5,
        maxConsecutiveNoEvidenceRounds: 2
      },
      searchRounds: 0,
      supplierOptionsFound: 0,
      consecutiveNoEvidenceRounds: 0,
      stopReason: null,
      stoppedAt: null
    },
    audit: { createdAt: NOW, updatedAt: NOW, history: [] },
    ...overrides
  };
}

function profitModel(version = "profit-v1", overrides = {}) {
  return {
    profitModelVersion: version,
    calculatedAt: NOW,
    inputSnapshotRefs: ["sales-1", "supply-1", "fees-1"],
    recommendedSalePriceCny: 151.78,
    unitProfitRmb: 44.95,
    profitMargin: 0.2962,
    result: "passed",
    ...overrides
  };
}

function sku(overrides = {}) {
  return {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "SkuLifecyclePackage",
    skuPackageId: "SKU-PKG-001",
    parentOpportunityId: "OPP-001",
    supplierOptionId: "SUPPLY-001",
    supplierSkuId: "4993364145574",
    variantKey: "豪华小火车",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    g1Identity: {
      schemaVersion: "g1-identity-v1",
      candidateId: "C-001",
      skuPackageId: "SKU-PKG-001",
      platform: "ozon",
      storeRef: { stableStoreId: "dandanshu", platformStoreId: "seller-001", mappingVersion: "stores-v1" },
      supplierSkuId: "4993364145574",
      merchantSku: "not_applicable",
      warehouseRef: "not_applicable",
      credentialAlias: "not_applicable",
      platformProductId: "not_applicable"
    },
    dataRevision: 0,
    businessPhase: "B",
    businessResult: "pending",
    technicalStatus: "not_started",
    ownerAction: "none",
    inheritedSalesSnapshotRefs: ["sales-1"],
    selectedSupplySnapshot: { snapshotId: "supply-1" },
    skuFacts: {},
    profitModels: [],
    activeProfitModelVersion: null,
    c1ProductPlan: null,
    c2FinalAssets: null,
    productionAuthorization: null,
    dHandoff: null,
    productionRecord: null,
    externalListingRecord: null,
    eVerificationRecord: null,
    readbackPolicy: {
      status: "not_started",
      maxAutomaticAttempts: 2,
      automaticAttempts: 0,
      maxConsecutiveSameFailure: 1,
      consecutiveSameFailureCount: 0,
      lastFailureLayer: null,
      stopReason: null,
      stoppedAt: null
    },
    readbackHistory: [],
    audit: { createdAt: NOW, updatedAt: NOW, history: [] },
    ...overrides
  };
}

function authorizedSku() {
  const sourceIdentity = structuredClone(sku().g1Identity);
  const identity = {
    ...structuredClone(sourceIdentity),
    merchantSku: "MERCHANT-SKU-1",
    warehouseRef: "warehouse:ozon:main",
    credentialAlias: "credential-alias:ozon:dandanshu"
  };
  const providerJobEvidence = {
    providerJobRef: {
      authorizationRef: { authorizationId: "authorization:c1-ai-draft:SHELF-WHITE" }
    }
  };
  const c1Snapshot = {
    status: "seo_draft_ready",
    unknownManifest: [],
    inputSnapshots: { platformSchemaRules: { evidenceId: "schema:evidence:1", schemaRevision: "schema-v1" } },
    seoEvidenceLayer: structuredClone(providerJobEvidence),
    draftOnlySeo: structuredClone(providerJobEvidence)
  };
  const sourceC1Fingerprint = fingerprintCanonicalRecord({ g1Identity: sourceIdentity, c1Snapshot });
  const finalCardInputSnapshot = {
    schemaVersion: "c2-final-card-input-snapshot-v1",
    skuPackageId: "SKU-PKG-001",
    sourceDataRevision: 7,
    resultDataRevision: 8,
    sourceC1Fingerprint,
    identity: structuredClone(sourceIdentity),
    variantKey: "豪华小火车",
    inheritedSalesSnapshotRefs: ["sales-1"],
    selectedSupplySnapshot: { snapshotId: "supply-1", ownerSupplyConfirmation: { status: "confirmed" } },
    activeProfitModelVersion: "profit-v1",
    activeProfitModel: { profitModelVersion: "profit-v1", result: "passed" },
    c1Snapshot,
    canonicalC1: {
      identity: structuredClone(sourceIdentity),
      unknownManifest: [],
      schemaSnapshotRef: "schema:evidence:1",
      draftOnlySeo: structuredClone(providerJobEvidence)
    }
  };
  const sourceFinalCardInputFingerprint = fingerprintCanonicalRecord(finalCardInputSnapshot);
  const finalUploads = [{
    assetId: "final-1",
    mediaType: "image",
    assetRef: "https://assets.example.test/final-1.png",
    fileName: "final-1.png",
    assetVersion: "asset-v1",
    sha256: "d".repeat(64),
    sourceEvidenceRef: "evidence:final-1",
    stableUrlEvidenceRef: "stable-url:final-1",
    usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "rights:final-1" },
    sourceType: "owner_provided_final_upload",
    order: 1,
    role: "main_image",
    byteSize: 1024,
    width: 1000,
    height: 1000,
    addedAt: NOW,
    lifecycleArea: "finalUploads",
    ownerConfirmed: true,
    productionEligible: true
  }];
  const effectiveVideoRequirement = { status: "not_required", requiredBy: "default", evidenceRefs: [] };
  const authorizedMediaFingerprint = fingerprintAuthorizedMedia(finalUploads);
  const finalUploadsFingerprint = fingerprintCanonicalRecord({ collected: [], aiDrafts: [], finalUploads });
  const finalManifestSha256 = fingerprintCanonicalRecord({
    schemaVersion: "c2-final-manifest-v1",
    authorizedMediaFingerprint,
    effectiveVideoRequirement,
    mainImageAssetId: "final-1",
    videoDisposition: "excludes_video",
    assets: finalUploads
  });
  const preparation = {
    schemaVersion: "c2-production-authorization-preparation-v1",
    status: "awaiting_final_card_approval",
    skuPackageId: "SKU-PKG-001",
    sourceDataRevision: 7,
    resultDataRevision: 8,
    sourceC1Fingerprint,
    authorizedMediaFingerprint,
    finalManifestVersion: "c2-final-manifest-v1",
    finalManifestSha256,
    finalUploadsFingerprint,
    mainImageAssetId: "final-1",
    videoDisposition: "excludes_video",
    ownerConfirmationAt: NOW,
    targetContext: {
      platform: "ozon",
      targetStore: sourceIdentity.storeRef.stableStoreId,
      storeRef: sourceIdentity.storeRef.stableStoreId,
      schemaRevision: "schema-v1",
      schemaEvidenceRef: "schema:evidence:1"
    },
    frozenC1Handoff: structuredClone(finalCardInputSnapshot.canonicalC1),
    finalUploads: structuredClone(finalUploads),
    effectiveVideoRequirement: structuredClone(effectiveVideoRequirement),
    ownerVideoRequirement: null,
    ownerFinalUploadConfirmation: {
      status: "confirmed",
      confirmedBy: "owner",
      confirmedAt: NOW,
      approvedManifestVersion: "c2-final-manifest-v1",
      approvedManifestSha256: finalManifestSha256,
      approvedAuthorizedMediaFingerprint: authorizedMediaFingerprint,
      approvedAssetIds: ["final-1"],
      approvedMainImageAssetId: "final-1",
      approvedVideoDisposition: "excludes_video",
      confirmationNote: null
    },
    finalCardInputSnapshot: structuredClone(finalCardInputSnapshot),
    finalCardInputFingerprint: sourceFinalCardInputFingerprint,
    ownerFinalCardAuthorizationDecision: null,
    pendingAuthorizationInputs: {
      schemaVersion: "c2-authorization-pending-inputs-v1",
      status: "awaiting_independent_owner_authorization",
      merchantSku: null,
      credentialAlias: null,
      warehouseRef: null,
      stock: null,
      price: null,
      allowedWriteFields: null,
      exclusions: null,
      sourceConfirmationCardId: null,
      ownerBusinessDecision: null,
      buyerTargetPrice: null,
      platformWritePrice: null,
      priceConversion: null,
      publishScope: null,
      confirmedAt: null
    },
    productionAuthorizationCreated: false,
    dHandoffCreated: false
  };
  preparation.preparationFingerprint = fingerprintCanonicalRecord(preparation);
  const sourcePreparationFingerprint = preparation.preparationFingerprint;
  const authorizationId = `production-auth:SKU-PKG-001:${sourcePreparationFingerprint}:owner-decision-1`;
  const ownerDecisionSnapshot = {
    schemaVersion: "production-owner-decision-snapshot-v1",
    decisionId: "owner-decision-1",
    sourceConfirmationCardId: "final-plan-card:SKU-PKG-001:8",
    sourcePreparationFingerprint,
    sourceFinalCardInputFingerprint,
    sourceC1Fingerprint,
    sourceCandidateRevision: 5,
    sourceSkuRevision: 8,
    identity: structuredClone(identity),
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    stock: 37,
    publishScope: "create_draft_only",
    allowedWriteFields: ["title", "price", "stock", "assets.finalUploads"],
    exclusions: [],
    authorizedMediaFingerprint,
    finalManifestSha256,
    finalUploadsFingerprint,
    mainImageAssetId: "final-1",
    videoDisposition: "excludes_video",
    effectiveVideoRequirement: structuredClone(effectiveVideoRequirement)
  };
  const ownerDecisionFingerprint = fingerprintCanonicalRecord(ownerDecisionSnapshot);
  const productionAuthorization = {
    schemaVersion: "production-authorization-v1.1",
    authorizationId,
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByActorId: "owner-1",
    confirmedAt: NOW,
    authorizedByActorId: "authorizer-1",
    authorizedAt: NOW,
    ownerDecisionId: "owner-decision-1",
    ownerConfirmation: {
      schemaVersion: "production-owner-confirmation-v1",
      decisionId: "owner-decision-1",
      actorId: "owner-1",
      actorType: "human",
      role: "owner",
      confirmedAt: NOW,
      sourcePreparationFingerprint,
      sourceFinalCardInputFingerprint,
      sourceC1Fingerprint,
      sourceCandidateRevision: 5,
      sourceSkuRevision: 8,
      ownerDecisionFingerprint
    },
    ownerDecisionFingerprint,
    ownerDecisionSnapshot,
    technicalAuthorization: {
      schemaVersion: "production-technical-authorization-v1",
      actorId: "authorizer-1",
      actorType: "human",
      role: "production_authorizer",
      authorizedAt: NOW
    },
    sourceConfirmationCardId: "final-plan-card:SKU-PKG-001:8",
    sourcePreparationFingerprint,
    sourceFinalCardInputFingerprint,
    sourceC1Fingerprint,
    sourceCandidateRevision: 5,
    resultCandidateRevision: 6,
    authorizedDataRevision: 8,
    resultDataRevision: 9,
    sourceIdentity: structuredClone(sourceIdentity),
    identity: structuredClone(identity),
    lockedScope: {
      candidateId: "C-001",
      skuPackageId: "SKU-PKG-001",
      variantKey: "豪华小火车",
      platform: "ozon",
      storeRef: structuredClone(identity.storeRef),
      merchantSku: identity.merchantSku,
      supplierSkuId: identity.supplierSkuId,
      warehouseRef: identity.warehouseRef,
      credentialAlias: identity.credentialAlias,
      schemaRevision: "schema-v1",
      schemaEvidenceRef: "schema:evidence:1",
      activeProfitModelVersion: "profit-v1",
      buyerTargetPrice: { amount: 1831, currency: "RUB" },
      platformWritePrice: { amount: 151.78, currency: "CNY" },
      priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
      stock: 37,
      authorizedMediaFingerprint,
      finalManifestVersion: "c2-final-manifest-v1",
      finalManifestSha256,
      finalUploadsFingerprint,
      mainImageAssetId: "final-1",
      videoDisposition: "excludes_video",
      effectiveVideoRequirement: structuredClone(effectiveVideoRequirement),
      finalUploads: structuredClone(finalUploads),
      finalCardInputSnapshot: structuredClone(finalCardInputSnapshot),
      publishScope: "create_draft_only",
      allowedWriteFields: ["title", "price", "stock", "assets.finalUploads"],
      exclusions: []
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
  return sku({
    dataRevision: 9,
    businessPhase: "D",
    profitModels: [profitModel("profit-v1")],
    activeProfitModelVersion: "profit-v1",
    c1ProductPlan: { status: "completed" },
    c2FinalAssets: {
      schemaVersion: "c2-asset-lifecycle-v1.1",
      status: "completed",
      assets: { collected: [], aiDrafts: [], finalUploads: structuredClone(finalUploads) },
      ownerFinalUploadConfirmation: structuredClone(preparation.ownerFinalUploadConfirmation),
      dReadPolicy: { onlyAllowedArea: "assets.finalUploads", collectedAllowed: false, aiDraftsAllowed: false, ownerConfirmationRequired: true },
      platformUploads: 0,
      productionStarted: false,
      productionAuthorizationPreparation: preparation
    },
    productionAuthorization,
    dHandoff: {
      schemaVersion: "c2-d-handoff-v1",
      handoffId: `d-handoff:${authorizationId}`,
      status: "awaiting_explicit_d_start",
      candidateId: "C-001",
      skuPackageId: "SKU-PKG-001",
      identity: structuredClone(identity),
      variantKey: "豪华小火车",
      productionAuthorizationId: authorizationId,
      ownerDecisionId: "owner-decision-1",
      sourcePreparationFingerprint,
      sourceFinalCardInputFingerprint,
      sourceCandidateRevision: 5,
      resultCandidateRevision: 6,
      sourceSkuRevision: 8,
      resultSkuRevision: 9,
      createdAt: NOW,
      uniqueOwner: "d_software",
      productionPlanCreated: false,
      executionIntentCreated: false,
      softwareJobCreated: false,
      dWritePermissionGranted: false,
      externalRequests: 0,
      platformWrites: 0
    }
  });
}

function authorizationCreationInput() {
  const persisted = authorizedSku();
  const authorization = structuredClone(persisted.productionAuthorization);
  const source = structuredClone(persisted);
  source.dataRevision = authorization.authorizedDataRevision;
  source.businessPhase = "C2";
  source.productionAuthorization = null;
  source.dHandoff = null;
  const ownerDecision = {
    decisionId: authorization.ownerDecisionId,
    selectedOption: "approve_for_production_authorization",
    sourcePreparationFingerprint: authorization.sourcePreparationFingerprint,
    sourceFinalCardInputFingerprint: authorization.sourceFinalCardInputFingerprint,
    sourceConfirmationCardId: authorization.sourceConfirmationCardId,
    merchantSku: authorization.identity.merchantSku,
    warehouseRef: authorization.identity.warehouseRef,
    credentialAlias: authorization.identity.credentialAlias,
    stock: authorization.lockedScope.stock,
    buyerTargetPrice: structuredClone(authorization.lockedScope.buyerTargetPrice),
    platformWritePrice: structuredClone(authorization.lockedScope.platformWritePrice),
    priceConversion: structuredClone(authorization.lockedScope.priceConversion),
    publishScope: authorization.lockedScope.publishScope,
    allowedWriteFields: structuredClone(authorization.lockedScope.allowedWriteFields),
    exclusions: structuredClone(authorization.lockedScope.exclusions),
    ownerDecisionFingerprint: authorization.ownerDecisionFingerprint,
    ownerConfirmation: structuredClone(authorization.ownerConfirmation)
  };
  const technicalAuthorizer = {
    schemaVersion: "actor-context-v1",
    userId: authorization.authorizedByActorId,
    sessionId: "session:b1:authorizer",
    actorType: "human",
    roles: ["production_authorizer"],
    source: "authenticated_identity_provider",
    authenticatedAt: NOW
  };
  return { persisted, source, ownerDecision, technicalAuthorizer };
}

function errorPaths(result) {
  return result.errors.map((item) => item.path);
}

test("published schema freezes product-lifecycle-v1.1 and both package types", async () => {
  const url = new URL("../schema/product-lifecycle-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.equal(schema.$id, PRODUCT_LIFECYCLE_SCHEMA_VERSION);
  assert.equal(schema.$defs.OpportunityPackage.properties.entityType.const, "OpportunityPackage");
  assert.equal(schema.$defs.SkuLifecyclePackage.properties.entityType.const, "SkuLifecyclePackage");
  for (const name of ["businessPhase", "businessResult", "technicalStatus", "ownerAction"]) {
    assert.ok(schema.$defs.OpportunityPackage.required.includes(name));
    assert.ok(schema.$defs.SkuLifecyclePackage.required.includes(name));
  }
  assert.ok(schema.$defs.profitModel.required.includes("profitModelVersion"));
  assert.ok(schema.$defs.readbackPolicy.required.includes("maxAutomaticAttempts"));
  assert.ok(schema.$defs.supplierSearch.required.includes("limits"));
  assert.deepEqual(schema.$defs.c2DHandoff, {
    oneOf: [{ $ref: "#/$defs/historicalC2DHandoff" }, { $ref: "#/$defs/queuedC2DHandoff" }]
  });
  const handoffBase = schema.$defs.c2DHandoffBase;
  assert.equal(handoffBase.type, "object");
  assert.equal(handoffBase.additionalProperties, false);
  const handoffFields = [
    "schemaVersion", "handoffId", "status", "candidateId", "skuPackageId", "identity", "variantKey",
    "productionAuthorizationId", "ownerDecisionId", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint",
    "sourceCandidateRevision", "resultCandidateRevision", "sourceSkuRevision", "resultSkuRevision", "createdAt",
    "uniqueOwner", "productionPlanCreated", "executionIntentCreated", "softwareJobCreated", "dWritePermissionGranted",
    "externalRequests", "platformWrites"
  ];
  assert.deepEqual(handoffBase.required, handoffFields);
  assert.deepEqual(Object.keys(handoffBase.properties), [...handoffFields, "softwareJobRef"]);
  assert.deepEqual(handoffBase.properties.uniqueOwner, { const: "d_software" });
  for (const field of ["productionPlanCreated", "executionIntentCreated", "dWritePermissionGranted"]) {
    assert.deepEqual(handoffBase.properties[field], { const: false });
  }
  for (const field of ["externalRequests", "platformWrites"]) {
    assert.deepEqual(handoffBase.properties[field], { const: 0 });
  }
  assert.deepEqual(schema.$defs.historicalC2DHandoff, {
    allOf: [
      { $ref: "#/$defs/c2DHandoffBase" },
      { type: "object", properties: {
        softwareJobRef: false,
        schemaVersion: { const: "c2-d-handoff-v1" },
        status: { const: "awaiting_explicit_d_start" },
        softwareJobCreated: { const: false }
      } }
    ]
  });
  assert.deepEqual(schema.$defs.queuedC2DHandoff, {
    allOf: [
      { $ref: "#/$defs/c2DHandoffBase" },
      { type: "object", required: ["softwareJobRef"], properties: {
        softwareJobRef: { $ref: "#/$defs/c2DHandoffBase/properties/softwareJobRef" },
        schemaVersion: { const: "c2-d-handoff-v2" },
        status: { const: "software_job_queued" },
        softwareJobCreated: { const: true }
      } }
    ]
  });
  assert.deepEqual(handoffBase.properties.softwareJobRef, {
    type: "object", additionalProperties: false,
    required: ["jobId", "jobType", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "inputFingerprint"],
    properties: {
      jobId: { $ref: "software-job-v1.schema.json#/$defs/strictRef" },
      jobType: { const: "d_production_execution" },
      candidateId: { $ref: "software-job-v1.schema.json#/$defs/strictRef" },
      skuPackageId: { $ref: "software-job-v1.schema.json#/$defs/strictRef" },
      sourceRevision: { type: "integer", minimum: 0 },
      resultRevision: { type: "integer", minimum: 1 },
      inputFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" }
    }
  });
  assert.equal(schema.$defs.SkuLifecyclePackage.properties.dHandoff.oneOf[1].$ref, "#/$defs/c2DHandoff");
  assert.deepEqual(schema.$defs.SkuLifecyclePackage.properties.productionAuthorization.oneOf[1], { oneOf: [{ $ref: "production-authorization-v1.1" }, { $ref: "production-authorization-v1.2" }] });
});

test("native OpportunityPackage uses A/closed while legacy read-only views may use unknown", () => {
  assert.deepEqual(validateOpportunityPackage(opportunity()), { valid: true, errors: [] });
  const wrongPhase = validateOpportunityPackage(opportunity({ businessPhase: "B" }));
  assert.equal(wrongPhase.valid, false);
  assert.ok(errorPaths(wrongPhase).includes("businessPhase"));
});

test("valid SkuLifecyclePackage starts at B and keeps an independent SKU identity", () => {
  assert.deepEqual(validateSkuLifecyclePackage(sku()), { valid: true, errors: [] });
  const missingIdentity = validateSkuLifecyclePackage(sku({ supplierSkuId: "", businessPhase: "A" }));
  assert.equal(missingIdentity.valid, false);
  assert.ok(errorPaths(missingIdentity).includes("supplierSkuId"));
  assert.ok(errorPaths(missingIdentity).includes("businessPhase"));
});

test("历史两人授权保留原合同只读，新生产只接受本次已认证主人确认", () => {
  const { persisted, ownerDecision, technicalAuthorizer } = authorizationCreationInput();
  assert.equal(validateProductionAuthorization(persisted.productionAuthorization).valid, true);
  assert.throws(() => assertCurrentProductionAuthorization(persisted.productionAuthorization), /RECONFIRMATION_REQUIRED/);
  assert.throws(() => assertIndependentProductionAuthorizationActors({ ownerConfirmation: ownerDecision.ownerConfirmation, technicalAuthorizer }), /RECONFIRMATION_REQUIRED/);
  const input = productionAuthorizationInputFixture();
  const created = createProductionAuthorization(input);
  assert.equal(created.productionAuthorization.schemaVersion, "production-authorization-v1.2");
  assert.equal(created.productionAuthorization.confirmedByActorId, input.ownerActor.userId);
  assert.equal(created.productionAuthorization.authorizedByActorId, input.ownerActor.userId);
  assert.equal(created.productionAuthorization.lockedScope.stock, input.commercialDecision.stock);
  for (const mutate of [a => { a.roles = ["production_authorizer"]; }, a => { a.actorType = "software"; }, a => { a.source = "development_default"; }]) {
    const actor = structuredClone(input.ownerActor); mutate(actor);
    assert.throws(() => createProductionAuthorization({ ...input, ownerActor: actor }), /AUTHENTICATED_IDENTITY_REQUIRED/);
  }
});

test("B1秘密门有界解码且保留合法相似商品文本和opaque引用", () => {
  assert.strictEqual(
    validateC2ProductionAuthorizationPreparationRecord,
    validatePreparationFromNeutralContract
  );
  const canonicalAuthorizationRecords = (authorizationId) => ({
    frozenC1Handoff: {
      draftOnlySeo: { providerJobRef: { authorizationRef: { authorizationId } } }
    },
    finalCardInputSnapshot: {
      c1Snapshot: {
        seoEvidenceLayer: { providerJobRef: { authorizationRef: { authorizationId } } },
        draftOnlySeo: { providerJobRef: { authorizationRef: { authorizationId } } }
      },
      canonicalC1: {
        draftOnlySeo: { providerJobRef: { authorizationRef: { authorizationId } } }
      }
    }
  });
  const legalAuthorizationId = "authorization:c1-ai-draft:SHELF-WHITE";
  assert.doesNotThrow(() => assertNoProductionSecrets(canonicalAuthorizationRecords(legalAuthorizationId)));
  const { source } = authorizationCreationInput();
  assert.equal(validateProductionAuthorizationPreparation({
    preparation: source.c2FinalAssets.productionAuthorizationPreparation,
    candidateId: source.g1Identity.candidateId,
    skuPackage: source
  }), source.c2FinalAssets.productionAuthorizationPreparation);
  for (const wrongPath of [
    { note: legalAuthorizationId },
    { authorizationId: legalAuthorizationId },
    { providerJobRef: { authorizationRef: { authorizationId: legalAuthorizationId } } },
    { "frozenC1Handoff.draftOnlySeo.providerJobRef.authorizationRef.authorizationId": legalAuthorizationId }
  ]) assert.throws(() => assertNoProductionSecrets(wrongPath), /SECRET_REJECTED/);
  // 扫描器按字符串值缓存结论，下面三条钉住它绝不能顺手把别的东西一起缓存掉。
  // 一：同一次扫描里，允许路径上的那次放行不得顺带放行别处的同一个值。
  const mixedPlacement = {
    ...canonicalAuthorizationRecords(legalAuthorizationId),
    note: legalAuthorizationId,
    targetContext: { note: legalAuthorizationId }
  };
  assert.throws(() => assertNoProductionSecrets(mixedPlacement), (error) => {
    assert.doesNotMatch(error.message, /frozenC1Handoff/, "允许路径上的那次被误报");
    assert.match(error.message, /productionAuthorization\.\[unknown\]/);
    assert.match(error.message, /productionAuthorization\.targetContext\.\[unknown\]/);
    return true;
  });
  // 二：同一个秘密在一次扫描里出现几次，就要被点名几次。
  assert.throws(() => assertNoProductionSecrets({
    note: "token=abc",
    targetContext: { note: "token=abc" },
    scope: { value: "token=abc" }
  }), (error) => {
    for (const path of [
      "productionAuthorization.[unknown]",
      "productionAuthorization.targetContext.[unknown]",
      "productionAuthorization.scope.value"
    ]) assert.ok(error.message.includes(path), `重复出现的秘密漏报 ${path}：${error.message}`);
    return true;
  });
  // 三：段数相同但不是那条路径，仍然是别处。
  assert.throws(() => assertNoProductionSecrets({
    frozenC1Handoff: { draftOnlySeo: { providerJobRef: { authorizationRef: { authorizationIdX: legalAuthorizationId } } } }
  }), /SECRET_REJECTED/);
  // 四：有些秘密只有 URL 解析看得见——query/hash 的键光秃秃没有等号，赋值模式抓不到。
  // 这一支不得被任何"先判断能不能解析"的快路径跳过。
  for (const urlOnlySecret of [
    "https://x.test/p?sig", "https://x.test/p?Signature", "https://x.test/p?x-amz-security-token",
    "https://x.test/p#access-token", "//x.test/p?sig", "?sig"
  ]) assert.throws(() => assertNoProductionSecrets({ note: urlOnlySecret }), /SECRET_REJECTED/);
  for (const unsafeAuthorizationId of [
    "authorization:Bearer",
    "authorization:abc",
    "authorization:c1-ai-draft:Bearer",
    "authorization:c1-ai-draft:bearer-token",
    "authorization:c1-ai-draft:t-o-k-e-n",
    "Bearer abc",
    "Basic abc",
    "Bearer:abc",
    "Basic:abc",
    "%42earer%3Aabc",
    "%2542earer%253Aabc",
    "%252542earer%25253Aabc",
    "authorization=c1-ai-draft:SHELF-WHITE",
    "token=abc",
    "secret:abc",
    "credential=abc",
    "authorization:c1-ai-draft:SHELF WHITE",
    "authorization:c1-ai-draft:SHELF\nWHITE",
    `authorization:c1-ai-draft:${"A".repeat(231)}`,
    "authorization:c1-ai-draft:https://user:pass@x.test/path",
    "authorization:c1-ai-draft:https://x.test/?token=abc",
    "https://user:pass@x.test/path",
    "https://x.test/?token=abc",
    "?token=abc",
    "%74oken%3Dabc",
    "%2574oken%253Dabc",
    "%252574oken%25253Dabc",
    "authorization%3Ac1-ai-draft%3ASHELF-WHITE",
    "authorization%253Ac1-ai-draft%253ASHELF-WHITE",
    "authorization%25253Ac1-ai-draft%25253ASHELF-WHITE"
  ]) assert.throws(
    () => assertNoProductionSecrets(canonicalAuthorizationRecords(unsafeAuthorizationId)),
    /SECRET_REJECTED/
  );
  for (const legal of [
    "tokenizer tool", "secretless design", "cookie cutter", "Basic design", "Bearer material",
    "credential-alias:ozon:dandanshu", "https://x.test/path/size%20chart",
    "https://x.test/?q=100%25%20cotton", "opaque:authorization-ref%2Fsafe", "size%2520chart"
  ]) {
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: legal }));
  }
  assert.doesNotThrow(() => assertNoProductionSecrets({
    "color%20name": "white",
    "size%2520label": "large",
    "material%252520note": "cotton"
  }));
  for (const secret of [
    { token: "abc" }, { secret: "abc" }, { credentials: "abc" }, { note: "token=abc" },
    { note: "secret:abc" }, { note: "cookie=abc" }, { note: "https://user:pass@x.test/path" },
    { note: "https://x.test/?accessToken=abc" }, { note: "https://x.test/?access%252554oken=abc" },
    { "%74oken": "abc" }, { "%2574oken": "abc" }, { "%252574oken": "abc" },
    { note: "%73ecret%3Aabc" }, { note: "%2573ecret%253Aabc" }, { note: "%252573ecret%25253Aabc" },
    { note: "https://x.test/?%63redentials%3Dabc" }, { note: "https://x.test/?%2563redentials%253Dabc" },
    { note: "https://x.test/?%252563redentials%25253Dabc" },
    { note: "https://user:pass%40x.test/path" }, { note: "https://user:pass%2540x.test/path" },
    { note: "https://user:pass%252540x.test/path" },
    { note: "https%3A%2F%2Fuser%3Apass%40x.test/path" },
    { note: "https%253A%252F%252Fuser%253Apass%2540x.test/path" },
    { note: "https%25253A%25252F%25252Fuser%25253Apass%252540x.test/path" },
    { note: "%ZZ%3Fauthorization%3Dabc" }, { note: "%E0%A4%A%3Ftoken%3Dabc" },
    { note: "%2%3Fcookie%3Dabc" }, { note: "%ZZ%3Fbearer%3Dabc" },
    { note: "%ZZ%3Fsecret%3Dabc" }, { note: "%ZZ%3Fcredentials%3Dabc" },
    { note: "%ZZ-token%3Dabc" }, { note: "%ZZBearer%20abc123" },
    { note: "%ZZBasic%20abc123" }, { note: "%ZZnote%3ABearer" },
    { note: "%ZZ%2F%2Fuser%3Apass%40example.test%2Fa" },
    { note: "Bearer%20abc123" }, { note: "note%3ABearer%20abc123" }
  ]) assert.throws(() => assertNoProductionSecrets(secret), /SECRET_REJECTED/);
  for (const key of ["authorization", "bearer", "basic", "cookie", "secret", "token", "credentials"]) {
    let value = `https://x.test/path?${key}=abc`;
    for (let depth = 1; depth <= 3; depth += 1) {
      value = encodeURIComponent(value);
      assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/, `${key}:${depth}`);
    }
  }
});

test("B1持久授权严格拒绝空身份、范围漂移、秘密、旧revision和媒体缺口", () => {
  const { persisted } = authorizationCreationInput();
  assert.deepEqual(validateProductionAuthorization(persisted.productionAuthorization, {
    candidateId: "C-001",
    candidateRevision: 6,
    skuPackage: persisted,
    lifecycleState: "persisted"
  }), { valid: true, errors: [] });
  const canonicalAuthorization = readAuthorizedProductionSnapshot({
    productionAuthorization: persisted.productionAuthorization,
    candidateId: "C-001",
    candidateRevision: 6,
    skuPackage: persisted
  });
  assert.deepEqual(canonicalAuthorization, persisted.productionAuthorization);
  assert.notEqual(canonicalAuthorization, persisted.productionAuthorization);
  assert.equal(canonicalAuthorization.schemaVersion, "production-authorization-v1.1");
  assert.deepEqual(canonicalAuthorization.ownerDecisionSnapshot, persisted.productionAuthorization.ownerDecisionSnapshot);
  assert.deepEqual(canonicalAuthorization.technicalAuthorization, persisted.productionAuthorization.technicalAuthorization);
  assert.equal(Object.isFrozen(canonicalAuthorization), true);
  assert.equal(Object.isFrozen(canonicalAuthorization.ownerDecisionSnapshot), true);
  assert.throws(() => readAuthorizedProductionSnapshot(persisted.productionAuthorization), /CONTEXT_REQUIRED/);

  const mutations = [
    (value) => { value.sourceIdentity = {}; },
    (value) => { delete value.identity.storeRef; },
    (value) => { value.lockedScope = {}; },
    (value) => { value.lockedScope.merchantSku = value.lockedScope.supplierSkuId; },
    (value) => { value.lockedScope.storeRef.stableStoreId = "store:other"; },
    (value) => { value.sourceCandidateRevision -= 1; },
    (value) => { value.sourcePreparationFingerprint = "f".repeat(64); },
    (value) => { value.sourceFinalCardInputFingerprint = "f".repeat(64); },
    (value) => { value.lockedScope.authorizedMediaFingerprint = "f".repeat(64); },
    (value) => { value.lockedScope.stock = 1.5; },
    (value) => { value.lockedScope.buyerTargetPrice.currency = "CNY"; },
    (value) => { value.lockedScope.finalUploads = []; },
    (value) => { value.ownerConfirmation.role = "production_authorizer"; },
    (value) => { value.technicalAuthorization.role = "owner"; },
    (value) => { value.authorizedByActorId = value.confirmedByActorId; value.technicalAuthorization.actorId = value.confirmedByActorId; },
    (value) => { value.authorizedAt = "2026-08-12T07:59:59.000Z"; value.technicalAuthorization.authorizedAt = value.authorizedAt; },
    (value) => { value.lockedScope.finalUploads[0].byteSize = -1; },
    (value) => { value.lockedScope.finalUploads[0].addedAt = "not-a-date"; },
    (value) => { value.ownerDecisionSnapshot.stock += 1; },
    (value) => { value.ownerDecisionSnapshot.sourceConfirmationCardId = "final-plan-card:other:8"; },
    (value) => { value.sourceConfirmationCardId = "final-plan-card:other:8"; },
    (value) => { value.ownerDecisionSnapshot.identity.merchantSku = "MERCHANT-SKU-OTHER"; },
    (value) => { value.ownerDecisionSnapshot.platformWritePrice.amount += 1; },
    (value) => { value.ownerDecisionSnapshot.priceConversion.evidenceRef = "fx:other"; },
    (value) => { value.ownerDecisionSnapshot.publishScope = "create_and_allow_validation_moderation"; },
    (value) => { value.ownerDecisionSnapshot.allowedWriteFields = ["create_product"]; },
    (value) => { value.ownerDecisionSnapshot.exclusions = ["no_inventory_write"]; },
    (value) => { value.ownerDecisionSnapshot.authorizedMediaFingerprint = "f".repeat(64); },
    (value) => { value.ownerDecisionSnapshot.mainImageAssetId = "final-other"; },
    (value) => { value.ownerDecisionSnapshot.videoDisposition = "includes_video"; },
    (value) => { value.lockedScope.finalCardInputSnapshot.extra = true; },
    (value) => { value.lockedScope.finalCardInputSnapshot.c1Snapshot.credential_value = "raw-value"; },
    (value) => { value.extra = true; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(persisted.productionAuthorization);
    mutate(changed);
    assert.equal(validateProductionAuthorization(changed, {
      candidateId: "C-001",
      candidateRevision: 6,
      skuPackage: persisted,
      lifecycleState: "persisted"
    }).valid, false, `mutation ${index} must be rejected`);
  }
});

test("新版主人授权仍拒旧revision、卡片漂移、秘密、缺图、未确认与unknown且不改输入", () => {
  const cases = [
    ["旧candidate revision", input => { input.sourceCandidateRevision -= 1; }],
    ["确认卡创建前不能授权", input => { input.skuPackage.productionConfirmationCard.createdAt = "2026-08-23T00:00:00.000Z"; }],
    ["卡片事实与冻结源不一致", input => { input.skuPackage.productionConfirmationCard.profitResult.recommendedSalePrice.value.rub += 1; }],
    ["秘密", input => { input.commercialDecision.credentialAlias = "accessToken=secret-value"; }],
    ["缺图", input => { input.skuPackage.c2FinalAssets.assets.finalUploads = []; input.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalUploads = []; }],
    ["未确认主人", input => { input.ownerActor.roles = ["production_authorizer"]; }],
    ["改价", input => { input.commercialDecision.platformWritePrice.amount += 1; }],
    ["unknown outcome", input => { input.skuPackage.dAssetTransport = {
      schemaVersion: "aliyun-oss-d-asset-state-v1", status: "unknown_outcome",
      intent: { schemaVersion: "aliyun-oss-d-asset-integration-v1", status: "unknown_outcome" }, assetTransport: null, automaticRetry: false, platformWrites: 0
    }; }]
  ];
  const valid = productionAuthorizationInputFixture();
  assert.equal(createProductionAuthorization(valid).productionAuthorization.schemaVersion, "production-authorization-v1.2");
  for (const [label, mutate] of cases) {
    const input = structuredClone(valid); mutate(input); const before = structuredClone(input.skuPackage);
    assert.throws(() => createProductionAuthorization(input), undefined, label);
    assert.deepEqual(input.skuPackage, before, label);
    assert.equal(input.skuPackage.productionAuthorization, null, label);
    assert.equal(input.skuPackage.dHandoff ?? null, null, label);
  }
});

test("B1持久校验重算preparation且handoff严格绑定同一PA、revision、时间和唯一owner", () => {
  const { persisted } = authorizationCreationInput();
  const preparationDrift = structuredClone(persisted);
  preparationDrift.productionAuthorization.lockedScope.schemaRevision = "schema-v2";
  preparationDrift.c2FinalAssets.productionAuthorizationPreparation.targetContext.schemaRevision = "schema-v2";
  assert.equal(validateSkuLifecyclePackage(preparationDrift).valid, false);

  for (const mutate of [
    (value) => { value.dHandoff.createdAt = "2026-08-12T08:00:01.000Z"; },
    (value) => { value.dHandoff.uniqueOwner = "owner"; },
    (value) => { value.dHandoff.candidateId = "C-OTHER"; },
    (value) => { value.dHandoff.sourceCandidateRevision -= 1; },
    (value) => { delete value.dHandoff.productionAuthorizationId; },
    (value) => { value.dHandoff.extra = true; }
  ]) {
    const changed = structuredClone(persisted);
    mutate(changed);
    assert.equal(validateSkuLifecyclePackage(changed).valid, false);
  }
});

test("D阶段OSS素材状态只接受已持久化、不可重试且零平台写入的证据", () => {
  const verified = sku({
    dAssetTransport: {
      schemaVersion: "aliyun-oss-d-asset-state-v1",
      status: "verified",
      intent: { schemaVersion: "aliyun-oss-d-asset-integration-v1", status: "completed" },
      assetTransport: {
        status: "verified",
        mode: "preapproved_stable_https",
        evidenceRef: "aliyun-oss-asset:evidence",
        resolvedAssets: [{ assetId: "final-1", platformAcceptedUrl: "https://example.invalid/final-1.png" }]
      },
      automaticRetry: false,
      platformWrites: 0
    }
  });
  assert.deepEqual(validateSkuLifecyclePackage(verified), { valid: true, errors: [] });

  const invalid = structuredClone(verified);
  invalid.dAssetTransport.automaticRetry = true;
  invalid.dAssetTransport.platformWrites = 1;
  invalid.dAssetTransport.assetTransport = null;
  const result = validateSkuLifecyclePackage(invalid);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("dAssetTransport.automaticRetry"));
  assert.ok(errorPaths(result).includes("dAssetTransport.platformWrites"));
  assert.ok(errorPaths(result).includes("dAssetTransport.assetTransport"));
});

test("all four state lines are required and independently validated", () => {
  const value = sku();
  delete value.ownerAction;
  value.technicalStatus = "passed";
  const result = validateLifecyclePackage(value);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("ownerAction"));
  assert.ok(errorPaths(result).includes("technicalStatus"));
});

test("supplier collection cannot run after a finite stop condition is reached", () => {
  const value = opportunity();
  value.supplierSearch.status = "running";
  value.supplierSearch.searchRounds = 3;
  const result = validateOpportunityPackage(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "supplierSearch.status" && /停止条件/.test(item.message)));
  assert.equal(supplierSearchStopReason(value.supplierSearch), "max_search_rounds");
});

test("supplier collection requires explicit finite positive limits", () => {
  const value = opportunity();
  value.supplierSearch.limits.maxSearchRounds = null;
  value.supplierSearch.limits.maxSupplierOptions = Infinity;
  const result = validateOpportunityPackage(value);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("supplierSearch.limits.maxSearchRounds"));
  assert.ok(errorPaths(result).includes("supplierSearch.limits.maxSupplierOptions"));
});

test("profitModelVersion is mandatory, unique and strictly increasing", () => {
  const result = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1"), profitModel("profit-v1")],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path.endsWith("profitModelVersion") && /重复|递增/.test(item.message)));
});

test("profit margin uses recommended sale price and current pass requires either frozen threshold", () => {
  const wrongFormula = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1", { profitMargin: 0.5 })],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.ok(wrongFormula.errors.some((item) => item.path.endsWith("profitMargin") && /建议成交价/.test(item.message)));

  const neitherThreshold = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1", {
      recommendedSalePriceCny: 100,
      unitProfitRmb: 14,
      profitMargin: 0.14,
      result: "passed"
    })],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.ok(neitherThreshold.errors.some((item) => item.path.endsWith("result") && /任一项/.test(item.message)));

  const marginOnly = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1", {
      recommendedSalePriceCny: 100,
      unitProfitRmb: 15,
      profitMargin: 0.15,
      result: "passed"
    })],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.equal(marginOnly.valid, true);
});

test("appendProfitModelVersion preserves prior profit evidence without mutation", () => {
  const original = sku();
  const first = appendProfitModelVersion(original, profitModel("profit-v1"));
  const secondModel = profitModel("profit-v2", {
    calculatedAt: "2026-08-12T09:00:00.000Z",
    unitProfitRmb: 42,
    profitMargin: 42 / 151.78
  });
  const second = appendProfitModelVersion(first, secondModel);
  assert.equal(original.profitModels.length, 0);
  assert.equal(first.profitModels.length, 1);
  assert.equal(second.profitModels.length, 2);
  assert.deepEqual(second.profitModels[0], first.profitModels[0]);
  assert.equal(second.activeProfitModelVersion, "profit-v2");
  assert.throws(() => appendProfitModelVersion(second, profitModel("profit-v2")), /profit-v3/);
});

test("transition validation rejects deletion or overwrite of historical profit models", () => {
  const previous = sku({
    dataRevision: 1,
    profitModels: [profitModel("profit-v1")],
    activeProfitModelVersion: "profit-v1"
  });
  const next = structuredClone(previous);
  next.dataRevision = 2;
  next.profitModels[0].unitProfitRmb = 999;
  const result = validateLifecycleTransition(previous, next);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "profitModels" && /覆盖/.test(item.message)));
});

test("technical failure does not change business phase or business result", () => {
  const previous = sku();
  const next = sku({
    dataRevision: 1,
    businessPhase: "C1",
    businessResult: "rejected",
    technicalStatus: "data_acquisition_failed"
  });
  const result = validateLifecycleTransition(previous, next);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("businessPhase"));
  assert.ok(errorPaths(result).includes("businessResult"));
});

test("E readback cannot keep running at the automatic-attempt boundary", () => {
  const value = sku({ businessPhase: "C2" });
  value.readbackPolicy = {
    ...value.readbackPolicy,
    status: "running",
    automaticAttempts: 2,
    consecutiveSameFailureCount: 0
  };
  const result = validateSkuLifecyclePackage(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "readbackPolicy.status" && /停止条件/.test(item.message)));
  assert.equal(readbackStopReason(value.readbackPolicy), "max_automatic_attempts");
});

test("stopped E readback records an explicit failure boundary and time", () => {
  const value = sku({ businessPhase: "C2", technicalStatus: "stopped", ownerAction: "decide_readback_failure" });
  value.readbackPolicy = {
    ...value.readbackPolicy,
    status: "stopped",
    automaticAttempts: 2,
    stopReason: "max_automatic_attempts",
    stoppedAt: "2026-08-12T10:00:00.000Z"
  };
  assert.deepEqual(validateSkuLifecyclePackage(value), { valid: true, errors: [] });
});

test("D and E are blocked until C1, C2 and exact production authorization exist", () => {
  const blockedD = validateSkuLifecyclePackage(sku({ businessPhase: "D" }));
  assert.equal(blockedD.valid, false);
  assert.ok(errorPaths(blockedD).includes("c1ProductPlan.status"));
  assert.ok(errorPaths(blockedD).includes("c2FinalAssets.status"));
  assert.ok(errorPaths(blockedD).includes("productionAuthorization.status"));

  const allowedD = authorizedSku();
  assert.deepEqual(validateSkuLifecyclePackage(allowedD), { valid: true, errors: [] });

  const blockedE = validateSkuLifecyclePackage({ ...allowedD, businessPhase: "E" });
  assert.ok(errorPaths(blockedE).includes("productionRecord"));
});


test("v3成本两份范围同时换店仍被父SKU身份拒绝，校验不改写记录", () => {
  const original = phase7PassedState().skuPackage;
  const originalBytes = JSON.stringify(original);
  assert.equal(validateSkuLifecyclePackage(original).valid, true);
  for (const mutate of [
    scope => { scope.store = "miska"; scope.storeRef = { stableStoreId: "miska", platformStoreId: "synthetic-other-store", mappingVersion: "synthetic-other-v1" }; },
    scope => { scope.storeRef.platformStoreId = "synthetic-other-account"; },
    scope => { scope.storeRef.mappingVersion = "synthetic-other-mapping"; },
    scope => { scope.platform = "wb"; scope.store = "wb"; scope.storeRef = { stableStoreId: "wb", platformStoreId: "synthetic-wb-account", mappingVersion: "synthetic-wb-v1" }; }
  ]) {
    const changed = structuredClone(original);
    const model = changed.profitModels.at(-1);
    mutate(model.otherCosts.costPolicyContext);
    mutate(model.otherCosts.costPolicySnapshot.scope);
    const changedBytes = JSON.stringify(changed);
    const result = validateSkuLifecyclePackage(changed);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.path === "profitModels[0].otherCosts.costPolicyContext"));
    assert.equal(JSON.stringify(changed), changedBytes);
    assert.equal(JSON.stringify(original), originalBytes);
  }
});
