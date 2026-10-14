import test from "node:test";
import assert from "node:assert/strict";
import { estimateDiscoveredProduct, roundDownCents } from "../lib/a-discovery-estimate.mjs";
import { profitAtPurchase } from "../lib/supplier-draft.mjs";
import { buildIntakeRoughProfit, intakeRoughProfitPlan, roughCommissionTypeZh } from "../lib/intake-rough-profit.mjs";

// Synthetic inputs only: the rates, bands and prices are stand-ins shaped like the estimator tests, not the live tables.
const rule = { pricingPolicyVersion: "synthetic", minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: "either", advertisingReserveRate: 0,
  returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };
const SMALL = "尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费";
const row = (route, perKgRmb, perParcelRmb, declaredValueLimitRub) => ({ route, ruleVersion: "guoo-synthetic",
  evidenceData: { chargeableWeightRule: "actual_weight", perKgRmb, perParcelRmb, minimumChargeableWeightKg: 0, weightLimit: "0.001-2KG",
    sizeLimit: SMALL, declaredValueLimitRub } });
const tariffRows = [row("GUOO Economy Extra Small", 20, 3.37, "1-1500₽"), row("GUOO Economy Small", 28.1, 17.97, "1501-7000₽")];
const fx = { rubPerCny: 12.5, rateDate: "2026-10-10", sourceRef: "synthetic-fx" };
const commission = { rate: 0.12, tier: "synthetic", sourceRef: "synthetic-commission", gaps: [] };
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";

function candidate({ skus, title = "合成宠物背心 狗狗衣服", supplier = null, ozon = null, sourceKind = "pinduoduo", freight = null } = {}) {
  return {
    id: "RP-1", productName: "录入中的商品", intake: { sourceKind },
    sourceCapture: { captureId: "S", status: "captured_waiting_owner_selection", offerId: "600000000001", title, mainImageUrl: IMAGE, priceRanges: [],
      pageFields: { unitDomesticFreightCny: freight }, skuChoices: skus ?? [
        { sourceSkuId: "a", priceCny: 15.08, inStock: true, weight: { value: 0.18, unit: "kg" } },
        { sourceSkuId: "b", priceCny: 12.5, inStock: false, weight: { value: 0.2, unit: "kg" } },
        { sourceSkuId: "c", priceCny: 16.5, inStock: true, weight: null }] },
    supplierImageMatch: supplier, ozonImageMatch: ozon
  };
}
const ozonCompared = (results) => ({ captureId: "O", status: "compared", results });
const supplierCompared = (results) => ({ captureId: "I", status: "compared", results });
const build = (plan, extra = {}) => buildIntakeRoughProfit({ plan, storeRule: rule, fx, commission, tariffRows, packagingRmbDefault: 3,
  estimatedAt: "2026-10-10T06:00:00.000Z", ...extra });

test("佣金只按核对过的几类估，认不出来就空着", () => {
  assert.equal(roughCommissionTypeZh("合成宠物背心 狗狗衣服"), "宠物服装");
  assert.equal(roughCommissionTypeZh("猫窝 冬季保暖"), "宠物躺床");
  assert.equal(roughCommissionTypeZh("木质八音盒"), "音乐盒");
  assert.equal(roughCommissionTypeZh("3D 拼图 恐龙"), "立体拼图");
  assert.equal(roughCommissionTypeZh("可爱发夹"), null);
  assert.equal(roughCommissionTypeZh(""), null);
});

test("货源价取有货的最低价；1688 首图一致、一件起订、更便宜的才换过去；售价取首图一致的最低价", () => {
  const ozon = ozonCompared([
    { productId: "900001", priceRub: 1290, similarity: "identical" }, { productId: "900002", priceRub: 1190, similarity: "identical" },
    { productId: "900003", priceRub: 590, similarity: "similar" }, { productId: "900004", priceRub: 9990, similarity: "different" }]);
  const own = intakeRoughProfitPlan(candidate({ ozon }));
  assert.deepEqual(own.purchase, { rmb: 15.08, basis: "pinduoduo", offerId: "600000000001", skuId: "a", domesticFreightIncluded: false });
  assert.deepEqual(own.salePrice, { rub: 1190, basis: "ozon_identical", productId: "900002", sampleCount: 2 });
  assert.deepEqual([own.weightKg, own.dimensions.label, own.commissionTypeZh, own.missing], [0.2, "衣服类常见大小", "宠物服装", []]);

  const supplier = supplierCompared([
    { offerId: "700000000001", priceCny: 9.9, quantityBegin: 2, similarity: "identical" },
    { offerId: "700000000002", priceCny: 8.8, quantityBegin: 1, similarity: "similar" },
    { offerId: "700000000003", priceCny: 7.7, quantityBegin: 1, similarity: "identical", isSourceOffer: true },
    { offerId: "700000000004", priceCny: 11.2, quantityBegin: 1, similarity: "identical" }]);
  const matched = intakeRoughProfitPlan(candidate({ ozon, supplier }));
  assert.deepEqual(matched.purchase, { rmb: 11.2, basis: "1688_match", offerId: "700000000004", skuId: null, domesticFreightIncluded: false });
  const withFreight = intakeRoughProfitPlan(candidate({ ozon, freight: 2, sourceKind: "1688" }));
  assert.deepEqual([withFreight.purchase.rmb, withFreight.purchase.basis, withFreight.purchase.domesticFreightIncluded], [17.08, "1688_link", true]);

  const nearOnly = intakeRoughProfitPlan(candidate({ ozon: ozonCompared([{ productId: "1", priceRub: 900, similarity: "similar" },
    { productId: "2", priceRub: 1100, similarity: "similar" }, { productId: "3", priceRub: 1500, similarity: "similar" }]) }));
  assert.deepEqual(nearOnly.salePrice, { rub: 1100, basis: "ozon_similar", productId: null, sampleCount: 3 });
});

test("缺什么写什么，不猜：没有 Ozon 售价、没有重量、认不出类目时粗算空着", () => {
  const plan = intakeRoughProfitPlan(candidate({ title: "合成神秘商品", skus: [{ sourceSkuId: "a", priceCny: 5, inStock: true, weight: null }] }));
  assert.deepEqual(plan.missing, ["Ozon 售价", "重量", "尺寸（认不出类目，没有常见大小可以假设）", "佣金（要先确认 Ozon 类目）"]);
  const result = build(plan);
  assert.deepEqual([result.status, result.assumed, result.profitPerUnitRmb, result.purchaseRmb, result.purchaseBasis],
    ["incomplete", true, null, 5, "pinduoduo"]);
  assert.deepEqual(result.missing, plan.missing);
});

test("粗算和找货、选规格是同一条公式；尺寸按类目常见大小，物流按申报价限价挑线路", () => {
  const ozon = ozonCompared([{ productId: "900002", priceRub: 1190, similarity: "identical" }]);
  const plan = intakeRoughProfitPlan(candidate({ ozon }));
  const result = build(plan);
  const estimate = estimateDiscoveredProduct({ product: { productId: "900002", price: 1190, weightGrams: 200, dimensionMm: null }, storeRule: rule, fx,
    commission, tariffRows, assumptions: { packagingRmbDefault: 3, allowAssumedDimensions: true, defaultDimensionsCm: plan.dimensions, enforcePriceLimit: true } });
  const profit = profitAtPurchase({ estimate, allInPurchaseRmb: 15.08 });
  assert.equal(result.status, "ok");
  assert.deepEqual([result.profitPerUnitRmb, result.marginRate, result.passes], [profit.unitProfitRmb, profit.marginRate, profit.passes]);
  assert.deepEqual([result.route, result.freightRmb, result.dimensionsBasis, result.dimensionsLabel, result.commissionRate, result.revenueCny],
    ["GUOO Economy Extra Small", roundDownCents(0.2 * 20 + 3.37), "category_default", "衣服类常见大小", 0.12, roundDownCents(1190 / 12.5)]);

  // 1600 ₽ 超出 Extra Small 的申报价上限，只能走 Small。
  const dearer = build(intakeRoughProfitPlan(candidate({ ozon: ozonCompared([{ productId: "900005", priceRub: 1600, similarity: "identical" }]) })));
  assert.equal(dearer.route, "GUOO Economy Small");

  const negative = build({ ...plan, purchase: { ...plan.purchase, rmb: 200 } });
  assert.equal(negative.status, "negative");
  assert.ok(negative.profitPerUnitRmb < 0);

  const noFx = build(plan, { fx: null });
  assert.deepEqual([noFx.status, noFx.missing], ["incomplete", ["汇率"]]);
  const noCommission = build(plan, { commission: { rate: null, gaps: [{ code: "REFERENCE_NOT_CONFIGURED" }] } });
  assert.deepEqual([noCommission.status, noCommission.missing], ["incomplete", ["官方佣金"]]);
});
