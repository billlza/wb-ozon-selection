import {
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { platformOfStore } from "./store-registry.mjs";

export const LEGACY_ADAPTER_MODE = "legacy-read-only-v1";
export const UNKNOWN = "unknown";
export const HISTORICAL_UNVERSIONED_PROFIT = "historical-unversioned";
export const LEGACY_FIELD_MAPPING_RULES = Object.freeze({
  id: "parentOpportunityId",
  productName: "directionName",
  targetStore: "targetStore",
  productUrl: "salesSnapshots[0].productUrl",
  competitorUrl: "salesSnapshots[0].competitorUrl",
  expectedPriceRub: "salesSnapshots[0].legacyExpectedPriceRub",
  sourceUrl: "supplierOptions[0].sourceUrl",
  purchasePriceRmb: "supplierOptions[0].actualPurchaseCost",
  domesticShippingRmb: "not_mapped_component_is_unknown",
  packedWeightKg: "supplierOptions[0].packedWeightKg",
  dimensionsCm: "supplierOptions[0].dimensionsCm",
  "codexReview.profitCalculation": "historicalProfitModels[0]",
  workflowStatus: "businessPhase_and_businessResult_only_when_unambiguous",
  "processing.state": "technicalStatus_only_when_unambiguous"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function direct(value) {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  return structuredClone(value);
}

function directNumber(value) {
  return Number.isFinite(value) ? value : UNKNOWN;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function targetPlatform(candidate) {
  if (candidate.targetPlatform) return candidate.targetPlatform;
  return platformOfStore(candidate.targetStore) ?? UNKNOWN;
}

function businessState(candidate) {
  if (candidate.workflowStatus === "eliminated") {
    return { businessPhase: "closed", businessResult: "rejected" };
  }
  return { businessPhase: UNKNOWN, businessResult: UNKNOWN };
}

function technicalStatus(candidate) {
  const state = candidate.processing?.state;
  if (["running", "queued", "stopped"].includes(state)) return state;
  return UNKNOWN;
}

function historicalProfitModels(candidate) {
  const calculation = candidate.codexReview?.profitCalculation;
  if (!isObject(calculation)) return [];
  return [{
    sourceCandidateId: candidate.id,
    sourceDataRevision: Number.isInteger(candidate.dataRevision) ? candidate.dataRevision : UNKNOWN,
    profitModelVersion: direct(calculation.profitModelVersion) === UNKNOWN
      ? HISTORICAL_UNVERSIONED_PROFIT
      : calculation.profitModelVersion,
    calculationPolicyVersion: direct(calculation.pricingPolicyVersion),
    historicalStatus: direct(calculation.status),
    legacyResult: direct(calculation.directionalStatus),
    calculatedAt: direct(candidate.codexReview?.reviewedAt),
    recommendedSalePriceCny: directNumber(calculation.targetPriceRmb),
    unitProfitRmb: directNumber(calculation.unitProfitRmb),
    profitMargin: directNumber(calculation.marginRate),
    readOnly: true,
    originalSnapshot: structuredClone(calculation)
  }];
}

function salesSnapshot(candidate) {
  return {
    snapshotId: `legacy-sales:${candidate.id}`,
    sourceType: "legacy_candidate_record",
    sourceDataRevision: Number.isInteger(candidate.dataRevision) ? candidate.dataRevision : UNKNOWN,
    productUrl: direct(candidate.productUrl),
    competitorUrl: direct(candidate.competitorUrl),
    title: direct(candidate.productName),
    imageUrl: direct(candidate.imageUrl),
    currentSalePrice: UNKNOWN,
    originalPrice: UNKNOWN,
    discount: UNKNOWN,
    currency: Number.isFinite(candidate.expectedPriceRub) ? "RUB" : UNKNOWN,
    legacyExpectedPriceRub: directNumber(candidate.expectedPriceRub),
    marketEvidence: direct(candidate.codexReview?.marketEvidence),
    category: direct(candidate.codexReview?.category),
    rating: UNKNOWN,
    reviewCount: UNKNOWN,
    salesVolume: UNKNOWN,
    crossBorderIdentity: UNKNOWN,
    collectedAt: direct(candidate.createdAt)
  };
}

function supplierOption(candidate) {
  return {
    supplierOptionId: `legacy-supply:${candidate.id}`,
    sourceType: "legacy_candidate_record",
    sourceDataRevision: Number.isInteger(candidate.dataRevision) ? candidate.dataRevision : UNKNOWN,
    sourceUrl: direct(candidate.sourceUrl),
    supplierSkuId: direct(candidate.codexReview?.cStageReview?.exactSourceSku ?? candidate.codexReview?.sourceSku?.sku),
    variant: direct(candidate.codexReview?.cStageReview?.exactSourceSpec),
    actualPurchaseCost: directNumber(candidate.purchasePriceRmb),
    actualPurchaseCostCurrency: Number.isFinite(candidate.purchasePriceRmb) ? "CNY" : UNKNOWN,
    productPrice: UNKNOWN,
    domesticShipping: UNKNOWN,
    packedWeightKg: directNumber(candidate.packedWeightKg),
    dimensionsCm: direct(candidate.dimensionsCm),
    material: UNKNOWN,
    powered: direct(candidate.powered),
    battery: UNKNOWN,
    images: UNKNOWN,
    readOnly: true
  };
}

function unknownFields(pkg) {
  const paths = [];
  const walk = (value, path) => {
    if (value === UNKNOWN) {
      paths.push(path);
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (isObject(value)) Object.entries(value).forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key));
  };
  walk(pkg, "");
  return paths;
}

export function adaptLegacyCandidateToOpportunity(candidate) {
  if (!isObject(candidate)) throw new TypeError("旧候选必须是对象");
  if (!candidate.id || !candidate.productName || !candidate.createdAt || !candidate.updatedAt) {
    throw new Error("旧候选缺少只读映射所需的身份或审计字段");
  }
  const state = businessState(candidate);
  const pkg = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "OpportunityPackage",
    parentOpportunityId: candidate.id,
    dataRevision: Number.isInteger(candidate.dataRevision) && candidate.dataRevision >= 0
      ? candidate.dataRevision
      : 0,
    directionName: candidate.productName,
    targetPlatform: targetPlatform(candidate),
    targetStore: direct(candidate.targetStore),
    businessPhase: state.businessPhase,
    businessResult: state.businessResult,
    technicalStatus: technicalStatus(candidate),
    ownerAction: UNKNOWN,
    salesSnapshots: [
      salesSnapshot(candidate),
      ...(Array.isArray(candidate.salesSnapshotsV11) ? structuredClone(candidate.salesSnapshotsV11) : [])
    ],
    supplierOptions: [supplierOption(candidate)],
    recommendedSupplierOptionId: UNKNOWN,
    confirmedSupplierOptionId: UNKNOWN,
    supplierSearch: {
      status: UNKNOWN,
      limits: {
        maxSearchRounds: UNKNOWN,
        maxSupplierOptions: UNKNOWN,
        maxConsecutiveNoEvidenceRounds: UNKNOWN
      },
      searchRounds: UNKNOWN,
      supplierOptionsFound: UNKNOWN,
      consecutiveNoEvidenceRounds: UNKNOWN,
      stopReason: UNKNOWN,
      stoppedAt: UNKNOWN
    },
    historicalProfitModels: historicalProfitModels(candidate),
    legacySource: {
      adapterMode: LEGACY_ADAPTER_MODE,
      readOnly: true,
      candidateId: candidate.id,
      workflowStatus: direct(candidate.workflowStatus),
      processingState: direct(candidate.processing?.state),
      source: direct(candidate.source),
      unknownFields: []
    },
    audit: {
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      history: Array.isArray(candidate.history) ? structuredClone(candidate.history) : []
    }
  };
  pkg.legacySource.unknownFields = unknownFields(pkg);
  const validation = validateOpportunityPackage(pkg);
  if (!validation.valid) {
    const detail = validation.errors.map((item) => `${item.path}: ${item.message}`).join("；");
    throw new Error(`旧候选${candidate.id}无法只读适配：${detail}`);
  }
  return deepFreeze(pkg);
}

export function adaptLegacyCandidatesDocument(document) {
  if (!isObject(document) || !Array.isArray(document.candidates)) {
    throw new TypeError("旧候选文档必须包含candidates数组");
  }
  const opportunities = document.candidates.map(adaptLegacyCandidateToOpportunity);
  const ids = new Set(opportunities.map((item) => item.parentOpportunityId));
  if (ids.size !== document.candidates.length) throw new Error("旧候选ID不唯一，禁止生成数量不一致的只读视图");
  return deepFreeze({
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    adapterMode: LEGACY_ADAPTER_MODE,
    readOnly: true,
    sourceCandidateCount: document.candidates.length,
    opportunityCount: opportunities.length,
    opportunities
  });
}
