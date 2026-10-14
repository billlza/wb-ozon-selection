import { createSyntheticBCostPolicy } from './b-cost-policy-fixture.mjs';
import { buildLifecycleBExplicitOtherCosts } from '../../lib/lifecycle-b-evidence-runtime.mjs';
import { buildRealAConfirmationCard } from "../../lib/real-a-confirmation-card.mjs";
import { compareGuooRoutes } from "../../lib/guoo-route-comparison.mjs";
import { runRealAConfirmationToBAndC1 } from "../../lib/real-a-b-c1-flow.mjs";
import { createSoftwareExecutionRuntime, startSoftwareStep, completeExecutionStep, blockExecutionForTechnicalFailure } from "../../lib/software-execution-state.mjs";
import { SYNTHETIC_STORE_REF } from "./store-binding-fixture.mjs";
import { createMusicBoxCandidate } from "../helpers/legacy-candidate-fixture.mjs";

const fixtureCostRule = Object.freeze({
  fixedOtherRmb: 0, advertisingReserveRate: 0, returnOpsReserveRate: 0,
  targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceRoundRmb: 1, thresholdPolicy: 'either'
});
export function currentCostRule(candidate) {
  return { ...fixtureCostRule, costPolicySnapshot: createSyntheticBCostPolicy({ scope: {
    platform: candidate.targetStore === 'wb' ? 'wb' : 'ozon', store: candidate.targetStore,
    storeRef: structuredClone(candidate.storeRef), salesScheme: candidate.lifecycleEvidenceContextV11?.salesScheme
  } }) };
}
export function currentOtherCosts(candidate) {
  return buildLifecycleBExplicitOtherCosts(candidate, currentCostRule(candidate), { asOf: confirmedAt });
}

export const confirmedAt = "2026-08-18T02:00:00.000Z";

export async function candidate() {
  const value = createMusicBoxCandidate();
  delete value.lifecycleV11;
  value.workflowStatus = "codex_processing";
  value.listingHandoff = null;
  return value;
}

export function submission(card) {
  return {
    sourceCandidateId: card.sourceCandidateId, sourceDataRevision: card.sourceDataRevision, dataRevision: card.sourceDataRevision,
    targetPlatform: card.targetPlatform, storeRef: structuredClone(card.storeRef),
    decision: "confirm",
    salesReview: {
      snapshotId: card.salesReview.snapshotId,
      comparability: "comparable",
      validityStatus: "current",
      confidence: "limited"
    },
    supplierConfirmation: {
      productUrl: "https://detail.1688.com/offer/876240928352.html",
      supplierSkuId: "SKU-SEWING-MACHINE-01",
      variantKey: "手摇缝纫机音乐盒",
      unitProductPrice: 15.3,
      unitDomesticFreight: 2,
      otherPurchaseCosts: 0,
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: true
    }
  };
}

export function evidencePacks({ logistics = {} } = {}) {
  return [{
    id: "fees:ozon:dandanshu:music-box:2026-08-18",
    kind: "commission",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", salesScheme: "rfbs" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      commissionRate: 0.14, commissionEvidenceMode: "exact",
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    },
  }, {
    id: "logistics:guoo:music-box:2026-08-18",
    kind: "logistics_tariff",
    status: "active",
    scope: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      chargeableWeightRule: "actual_weight",
      perKgRmb: 0,
      perParcelRmb: 18,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1,
      ...logistics
    }
  }, {
    id: "fx:official:2026-08-18:RUB-CNY",
    kind: "exchange_rate",
    status: "active",
    scope: { pair: "RUB/CNY" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      rubPerCny: 12
    }
  }, {
    id: "schema:ozon:dandanshu:music-box:2026-08-18",
    kind: "schema",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", ruleVersion: "schema-2026-08-18" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      schemaRevision: "2026-08-18",
      requiredFields: []
    }
  }].map((pack) => ({
    ...pack,
    sourceType: "isolated_test",
    sourceRef: `fixture:${pack.id}`
  }));
}

export function addEvidenceContext(source) {
  source.lifecycleEvidenceContextV11 = {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "music-box",
    salesScheme: "rfbs",
    route: "guoo-economy-small",
    logisticsRuleVersion: "guoo-2026-07-20",
    exchangePair: "RUB/CNY",
    schemaRuleVersion: "schema-2026-08-18"
  };
  return source;
}


export const FIXTURE_FROZEN_ROUTE = "guoo-economy-small";
export const FIXTURE_LOGISTICS_RULE_VERSION = "guoo-2026-07-20";

/** 一行能通过 assertGuooRouteComparison 的合成资费：只有 17 行落在重量区间里，而它就是夹具冻住的那条线路。 */
function guooCatalogRow(rowNumber) {
  const route = rowNumber === 17 ? FIXTURE_FROZEN_ROUTE : `GUOO Synthetic ${rowNumber} PUDO`;
  return { rowNumber, route, routeText: route, deliveryMethods: [route],
    sourceRefs: { perKgRmb: { sheetName: "Synthetic", cellRef: `K${rowNumber}` } },
    unresolvedRules: [],
    feeCoverage: { status: "complete", additionalPerParcelRmb: 0, evidenceRef: "evidence:synthetic-complete-fees" },
    evidenceData: { chargeableWeightRule: "actual_weight", perKgRmb: 28.1, perParcelRmb: 17.97,
      minimumChargeableWeightKg: 0.001, weightRoundingRule: "none", weightRoundingKg: null,
      productType: "Small", weightLimit: rowNumber === 17 ? "0.001-2KG" : "10-30KG", declaredValueLimitRub: "1501-7000₽",
      sizeLimit: "尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费",
      batteryTransportRule: "电池不允许\n只接普货（不接带电、带磁、液体、粉末、刀具、仿牌等产品）" } };
}

/**
 * `appendGuooRouteComparison` 落盘时写的就是这个形状：比较结果本身，加上 recordedAt 和 resultRevision。
 *
 * `declared: false` 时运输属性没声明，选中那条线路的 eligibility 是「说不准」，`transportVerified` 因此
 * 为 false——那是真的没核实出来的，不是把字段改一下装出来的。
 */
export function savedGuooRouteComparison(candidateId, sourceRevision,
  { declared = true, ruleVersion = FIXTURE_LOGISTICS_RULE_VERSION } = {}) {
  const comparison = compareGuooRoutes({ candidateId, sourceRevision,
    packaging: { weightKg: 0.4, dimensionsCm: { length: 12, width: 12, height: 7 }, sourceRef: "evidence:synthetic-packaging" },
    salePrice: { amountRub: 2000, sourceRef: "evidence:synthetic-target-sale" },
    cargoFacts: declared ? { batteryType: "none", batteryEnergyWh: null, generalCargo: true, personalUse: true,
      irregularShape: false, sourceRef: "evidence:synthetic-cargo" } : null,
    catalog: { schemaVersion: "guoo-tariff-catalog-v1", sourceRef: "evidence:synthetic-catalog",
      ruleVersion, observedAt: confirmedAt, sourceNotes: [], unresolvedRules: [],
      rows: Array.from({ length: 15 }, (_, index) => guooCatalogRow(index + 10)) } });
  if (comparison.selectedRoute !== FIXTURE_FROZEN_ROUTE || comparison.transportVerified !== declared) {
    throw new Error("SYNTHETIC_GUOO_COMPARISON_SHAPE_UNEXPECTED");
  }
  return { ...comparison, recordedAt: confirmedAt, resultRevision: sourceRevision + 1 };
}

export async function createSavedConditionalBFixture({ rejected = false } = {}) {
  const source = addEvidenceContext(await candidate());
  const estimated = evidencePacks();
  Object.assign(estimated[0].evidenceData, { commissionEvidenceMode: "estimated", estimateAuthorized: true,
    commissionEstimateAuthorization: { schemaVersion: "commission-estimate-authorization-v1", candidateId: source.id,
      candidateRevision: source.dataRevision, authorizationRef: "fixture:b-estimate", commissionRate: estimated[0].evidenceData.commissionRate } });
  const original = runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source), submission: submission(buildRealAConfirmationCard(source)), evidencePacks: estimated, confirmedAt });
  if (original.profitModel.calculationType !== "conditional") throw new Error("SYNTHETIC_B_CONDITIONAL_PRODUCER_REQUIRED");
  source.lifecycleV11 = { schemaVersion: "product-lifecycle-v1.1", status: "b_conditional_awaiting_exact_commission",
    aConfirmationReceipt: { receiptId: original.confirmationReceiptId, decision: "confirm", sourceCandidateRevision: source.dataRevision, confirmedAt },
    opportunityPackage: structuredClone(original.opportunityPackage), ownerSupplyConfirmation: structuredClone(original.ownerSupplyConfirmation),
    skuPackage: structuredClone(original.skuPackage), bSystemEvidenceBundle: structuredClone(original.systemEvidenceBundle),
    c1Handoffs: [], externalAccesses: [], platformWrites: 0 };
  let runtime = createSoftwareExecutionRuntime({ candidateId: source.id, dataRevision: source.dataRevision, businessPhase: "A", stepId: "A_CONFIRMATION", at: confirmedAt });
  runtime = completeExecutionStep(startSoftwareStep(runtime, { stepId: "B_DETERMINISTIC_PROFIT", inputRevision: source.dataRevision, at: confirmedAt }),
    { outputRevision: source.dataRevision + 1, at: confirmedAt });
  runtime.businessPhase = "B";
  source.executionRuntime = blockExecutionForTechnicalFailure(runtime, { failureId: "failure:b-exact", kind: "external_dependency",
    errorCode: "B_EXACT_COMMISSION_REQUIRED", failureLayer: "b_commission_evidence", sourceRevision: source.dataRevision + 1,
    evidenceRefs: [original.systemEvidenceBundle.platformFeeEvidence.evidenceId], at: confirmedAt });
  source.dataRevision += 1;
  source.workflowStatus = "needs_user_data";
  const currentPacks = evidencePacks({ logistics: rejected ? { perParcelRmb: 105 } : {} });
  currentPacks[0].id = "commission:current:exact";
  const document = { rules: { [{ dandanshu: "ozonDandanshu", miska: "ozonMiska", wb: "wbCrossListing" }[source.targetStore]]: currentCostRule(source) }, candidates: [source], evidencePacks: currentPacks, runtime: { softwareJobs: [] } };
  return { candidate: source, original, document, evidencePacks: currentPacks, at: "2026-08-18T03:00:00.000Z" };
}
