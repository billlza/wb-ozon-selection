import { isDeepStrictEqual } from "node:util";
import { resolveLifecycleBCostPolicy } from "./global-pricing-policy.mjs";
import { validateProfitModel } from "./profit-model.mjs";
import { validateLifecycleBInputBundle, inspectCommissionCatalogValidity } from "./lifecycle-b-input-bundle.mjs";
import { inspectProductionEvidenceReadiness } from "./production-evidence-readiness.mjs";
import { inspectLifecycleEvidenceValidity } from "./lifecycle-evidence-validity.mjs";
import { isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";
import { evaluateFinalMarketPricing } from "./market-sample-policy.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets } from "./production-contract-primitives.mjs";

export class FinalPricingReviewError extends Error {
  constructor(code, message) { super(message); this.name = "FinalPricingReviewError"; this.code = code; }
}

export function assertFinalPricingReviewCurrent(skuPackage) {
  const record = skuPackage.finalPricingReview;
  if (!record) throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_REQUIRED", "最终定价尚未完成多样本比较，B阶段参考价仍可用于前期利润计算。");
  const keys = ["schemaVersion", "assessment", "salesSnapshots", "reviews", "supplierSkuId", "variantKey", "profitModelVersion"];
  if (typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== keys.length ||
      keys.some(key => !Object.hasOwn(record, key)) || record.schemaVersion !== "final-pricing-review-v1") {
    throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_INVALID", "最终定价复核记录无效。");
  }
  assertNoProductionSecrets(record, "finalPricingReview");
  const assessment = record.assessment;
  const target = assessment?.target;
  const profit = skuPackage.profitModels.find(model => model.profitModelVersion === skuPackage.activeProfitModelVersion);
  if (!target || target.candidateId !== skuPackage.g1Identity.candidateId || target.skuPackageId !== skuPackage.skuPackageId ||
      target.platform !== skuPackage.targetPlatform || target.store !== skuPackage.targetStore ||
      !sameStoreRef(target.storeRef, skuPackage.g1Identity.storeRef) || record.supplierSkuId !== skuPackage.supplierSkuId ||
      record.variantKey !== skuPackage.variantKey || record.profitModelVersion !== skuPackage.activeProfitModelVersion ||
      !profit || profit.result !== "passed" || profit.recommendedSalePriceRub !== assessment.selectedPriceRub) {
    throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_SOURCE_CHANGED", "最终价格、SKU或利润版本已变化，须重新复核。");
  }
  const expected = evaluateFinalMarketPricing({ assessmentId: assessment.assessmentId, assessedAt: assessment.assessedAt,
    target, salesSnapshots: record.salesSnapshots, reviews: record.reviews, selectedPriceRub: assessment.selectedPriceRub });
  if (expected.status !== "ready" || !isDeepStrictEqual(expected, assessment)) {
    throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_INVALID", "最终多样本比较与保存的证据不一致。");
  }
  return record;
}

/** Reuse a passed formal B price only while its exact frozen inputs remain applicable.
 * This reads existing evidence; it never selects a replacement or recalculates a price.
 */
export function assertProductionProfitPriceCurrent({ candidate, skuPackage, evidencePacks, currentCommissionCatalogs = [], observedAt }) {
  const fail = (code, message) => { throw new FinalPricingReviewError(code, message); };
  if (!candidate || !skuPackage || !Array.isArray(evidencePacks) || !isRuntimeConfigurationTimestamp(observedAt) ||
      candidate.id !== skuPackage.g1Identity?.candidateId || !Number.isSafeInteger(candidate.dataRevision) ||
      !isDeepStrictEqual(candidate.lifecycleV11?.skuPackage, skuPackage) ||
      candidate.targetPlatform !== skuPackage.targetPlatform || candidate.targetStore !== skuPackage.targetStore ||
      !sameStoreRef(candidate.storeRef, skuPackage.g1Identity.storeRef)) {
    fail("PRODUCTION_AUTHORIZATION_PROFIT_SOURCE_REQUIRED", "必须读取当前候选、商品和冻结利润证据后才能确认生产。");
  }
  const models = skuPackage.profitModels.filter(model => model.profitModelVersion === skuPackage.activeProfitModelVersion);
  const model = models[0];
  if (models.length !== 1 || !validateProfitModel(model).valid || model.result !== "passed" ||
      !["exact", "official_reference"].includes(model.commissionMode) || model.calculationType !== "formal" ||
      Date.parse(model.calculatedAt) > Date.parse(observedAt)) {
    fail("PRODUCTION_AUTHORIZATION_FORMAL_PROFIT_REQUIRED", "当前利润必须是证据完整的正式达标方案，估算方案不能用于生产。");
  }
  // A saved review is never bypassed, even when the original B price would qualify for reuse.
  if (skuPackage.finalPricingReview != null) assertFinalPricingReviewCurrent(skuPackage);
  const bundle = candidate.lifecycleV11.bSystemEvidenceBundle;
  const supply = skuPackage.selectedSupplySnapshot;
  const supplier = supply.supplierSku;
  if (!bundle || !validateLifecycleBInputBundle(bundle).valid || bundle.sourceCandidateId !== candidate.id ||
      bundle.sourceCandidateRevision > candidate.dataRevision || Date.parse(bundle.createdAt) > Date.parse(observedAt)) {
    fail("PRODUCTION_AUTHORIZATION_PROFIT_SOURCE_INVALID", "冻结 B 输入缺失、身份不符或时间无效。");
  }
  const fees = bundle.platformFeeEvidence, logistics = bundle.logisticsEvidence, fx = bundle.exchangeRateEvidence;
  const expectedRefs = [skuPackage.c1ProductPlan.inputSnapshots.salesSnapshot.snapshotId, supply.snapshotId, fees.evidenceId, logistics.evidenceId, fx.evidenceId];
  if (!isDeepStrictEqual(model.inputSnapshotRefs, expectedRefs) || supplier.supplierSkuId !== skuPackage.supplierSkuId || supplier.variantKey !== skuPackage.variantKey ||
      model.calculation?.version !== "profit-calculation-v3-cost-policy-snapshot" ||
      model.commissionMode !== fees.commissionEvidenceMode || model.commissionRate !== fees.commissionRate ||
      model.actualPurchaseCost.amount !== supplier.actualPurchaseCost || model.actualPurchaseCost.evidenceRef !== supply.snapshotId ||
      model.internationalFreight.amount !== logistics.amountRmb || model.internationalFreight.route !== logistics.route || model.internationalFreight.evidenceRef !== logistics.evidenceId ||
      model.priceConversion?.evidenceRef !== fx.evidenceId || model.priceConversion.rubPerCny !== fx.rubPerCny ||
      model.sellerSettlementRevenue.evidenceRef !== fees.evidenceId || model.otherCosts.evidenceRef !== fees.evidenceId ||
      !isDeepStrictEqual(model.otherCosts.costPolicySnapshot, fees.costPolicySnapshot) || !isDeepStrictEqual(model.otherCosts.costPolicyContext, fees.costPolicyContext) ||
      Object.entries(model.otherCosts.components).some(([key, value]) => fees.otherCosts[key] !== value) ||
      bundle.packagingSnapshot.weightKg !== supplier.weight.value ||
      ["length", "width", "height"].some(key => bundle.packagingSnapshot.dimensionsCm[key] !== supplier.dimensions[key])) {
    fail("PRODUCTION_AUTHORIZATION_PROFIT_INPUT_CHANGED", "当前 SKU、成本、包装或价格来源与正式利润输入不一致。");
  }
  try { resolveLifecycleBCostPolicy({ snapshot: fees.costPolicySnapshot, context: fees.costPolicyContext, asOf: observedAt }); }
  catch (error) {
    if (!error.code?.startsWith("B_COST_POLICY_")) throw error;
    fail("PRODUCTION_AUTHORIZATION_COST_POLICY_INVALID", "冻结成本政策在当前时间不再适用。");
  }
  const readiness = inspectProductionEvidenceReadiness({ candidate, evidencePacks, observedAt });
  if (readiness.status !== "current") fail("PRODUCTION_AUTHORIZATION_PROFIT_EVIDENCE_INVALID", "正式方案引用的费用、物流、汇率或类目资料缺失、失效或不匹配。");
  const exchange = evidencePacks.find(pack => pack.id === fx.evidenceId);
  if (Date.parse(model.priceConversion.checkedAt) > Date.parse(observedAt) ||
      !inspectLifecycleEvidenceValidity(exchange, { asOf: model.priceConversion.checkedAt }).usable ||
      Number((model.recommendedSalePriceRub / fx.rubPerCny).toFixed(2)) !== model.recommendedSalePriceCny) {
    fail("PRODUCTION_AUTHORIZATION_PROFIT_FX_INVALID", "冻结价格的汇率、核验时间或币种换算不一致。");
  }
  const commission = evidencePacks.find(pack => pack.id === fees.evidenceId);
  if (!inspectCommissionCatalogValidity({ pack: commission, currentCommissionCatalogs, asOf: observedAt }).available) {
    fail("PRODUCTION_AUTHORIZATION_COMMISSION_CATALOG_INVALID", "正式佣金引用的当前官方费表版本不匹配或已失效。");
  }
  if (model.commissionMode === "official_reference" && skuPackage.targetPlatform === "ozon") {
    const ref = fees.commissionCatalogRef;
    const price = model.recommendedSalePriceRub;
    const priceTier = value => value <= 1500 ? "le1500" : value <= 5000 ? "1500_5000" : "gt5000";
    const bindingPrice = fees.officialCommissionBinding.priceRub;
    if (commission.sourceType !== "ozon_official_commission_table" || !ref || ref.priceTier !== priceTier(price) ||
        Date.parse(ref.effectiveFrom) > Date.parse(observedAt) || !Number.isFinite(bindingPrice) || bindingPrice <= 0 || priceTier(bindingPrice) !== priceTier(price)) {
      fail("PRODUCTION_AUTHORIZATION_OFFICIAL_COMMISSION_BINDING_INVALID", "官方费表与冻结售价、适用价格档或生效时间不一致。");
    }
  }
  return model;
}
