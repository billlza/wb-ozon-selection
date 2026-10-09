import { createLifecycleBInputBundle } from "../../lib/lifecycle-b-input-bundle.mjs";
import { buildLifecycleBExplicitOtherCosts } from "../../lib/lifecycle-b-evidence-runtime.mjs";

/** Build explicit synthetic sources matching the fixture's existing formal B inputs. */
export function attachProductionProfitEvidence(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  const profit = sku.profitModels.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
  const schema = sku.c1ProductPlan.inputSnapshots.platformSchemaRules;
  const context = { platform: sku.targetPlatform, store: sku.targetStore, storeRef: structuredClone(sku.g1Identity.storeRef),
    category: `ozon:${schema.descriptionCategoryId}:${schema.typeId}`, salesScheme: profit.otherCosts.costPolicyContext.salesScheme,
    route: profit.internationalFreight.route, logisticsRuleVersion: "synthetic-tariff-v1", exchangePair: "RUB/CNY", schemaRuleVersion: schema.schemaRevision };
  candidate.lifecycleEvidenceContextV11 = context;
  candidate.packagingCostRmb = profit.otherCosts.components.packagingRmb;
  const pack = (kind, id, scope, evidenceData, checkedAt = "2026-08-07T00:00:00.000Z") => ({ kind, id, scope, evidenceData: structuredClone(evidenceData),
    status: "active", sourceType: "isolated_test", sourceRef: `synthetic:${kind}`, checkedAt, expiresAt: "2026-09-01T00:00:00.000Z" });
  // FX stays first so existing FX-specific boundary cases keep addressing the FX pack.
  const evidencePacks = [
    pack("exchange_rate", profit.inputSnapshotRefs[4], { pair: "RUB/CNY" }, { rubPerCny: profit.priceConversion.rubPerCny }),
    pack("commission", profit.inputSnapshotRefs[2], { platform: context.platform, store: context.store, storeRef: context.storeRef, category: context.category, salesScheme: context.salesScheme },
      { commissionRate: profit.commissionRate, commissionEvidenceMode: "exact" }),
    pack("logistics_tariff", profit.inputSnapshotRefs[3], { route: context.route, ruleVersion: context.logisticsRuleVersion },
      { chargeableWeightRule: "actual_weight", perKgRmb: 0, perParcelRmb: profit.internationalFreight.amount, minimumChargeableWeightKg: 0, weightRoundingRule: "none", weightRoundingKg: null }),
    pack("schema", schema.evidenceId, { platform: context.platform, store: context.store, storeRef: context.storeRef, category: context.category, ruleVersion: context.schemaRuleVersion }, schema, schema.collectedAt)
  ];
  if (profit.commissionMode === "official_reference") {
    const commission = evidencePacks.find(pack => pack.kind === "commission");
    commission.sourceType = "ozon_official_commission_table";
    commission.evidenceData.commissionEvidenceMode = "official_reference";
    commission.evidenceData.officialCommissionBinding = { schemaVersion: "ozon-official-commission-binding-v1", candidateId: candidate.id,
      candidateRevision: candidate.dataRevision, priceRub: profit.recommendedSalePriceRub };
    commission.commissionCatalogRef = { effectiveFrom: "2026-08-01", fileSha256: "a".repeat(64), sourceUrl: "https://docs.ozon.ru/commission/synthetic",
      priceTier: profit.recommendedSalePriceRub <= 1500 ? "le1500" : profit.recommendedSalePriceRub <= 5000 ? "1500_5000" : "gt5000",
      matchedRow: { typeRu: "Синтетическая категория", typeZh: "合成类目", mpCategoryZh: "合成目录" } };
  }
  const supplier = sku.selectedSupplySnapshot.supplierSku;
  const rules = { costPolicySnapshot: structuredClone(profit.otherCosts.costPolicySnapshot), targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceRoundRmb: 1, thresholdPolicy: "either" };
  candidate.lifecycleV11.bSystemEvidenceBundle = createLifecycleBInputBundle({ candidate, evidencePacks, createdAt: profit.calculatedAt,
    otherCosts: buildLifecycleBExplicitOtherCosts(candidate, rules, { asOf: profit.calculatedAt }),
    normalizedSubmission: { supplierConfirmation: { weightKg: supplier.weight.value, dimensionsCm: supplier.dimensions } } });
  return { evidencePacks, currentCommissionCatalogs: [] };
}

export function productionEvidenceForSku(skuPackage, dataRevision) {
  const candidate = { id: skuPackage.g1Identity.candidateId, dataRevision, targetPlatform: skuPackage.targetPlatform,
    targetStore: skuPackage.targetStore, storeRef: structuredClone(skuPackage.g1Identity.storeRef), lifecycleV11: { skuPackage } };
  return { candidate, ...attachProductionProfitEvidence(candidate) };
}
