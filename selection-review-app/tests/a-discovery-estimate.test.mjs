import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateDiscoveredProduct, describeEstimate, estimateOutcomeForPool, parseWeightLimitKg, parseSizeLimitCm, roundDownCents, costPolicyFromStoreRule, pricingGuidance, pricePointAt, commissionTierForPrice } from '../lib/a-discovery-estimate.mjs';

// Synthetic inputs only. Tariff rows mirror the GUOO reader's row shape; rates are stand-ins, not the live table.
const rule = { pricingPolicyVersion: 'synthetic', minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either', advertisingReserveRate: 0,
  returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };
const row = (route, chargeableWeightRule, perKgRmb, perParcelRmb, weightLimit, sizeLimit) => ({ route, ruleVersion: 'guoo-synthetic', evidenceData: { chargeableWeightRule, perKgRmb, perParcelRmb,
  minimumChargeableWeightKg: 0, weightLimit, sizeLimit, ...(chargeableWeightRule === 'max_actual_volume' ? { volumeDivisorCm3PerKg: 12000 } : {}) } });
const tariffRows = [
  row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', '尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费'),
  row('GUOO Standard Small', 'actual_weight', 39.3, 17.97, '0.001-2KG', '尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费'),
  row('GUOO Economy Big', 'max_actual_volume', 19.1, 40.44, '2.001-30KG\n收抛', '尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM'),
  row('GUOO Standard Big', 'max_actual_volume', 28.1, 40.44, '2.001-30KG\n收抛', '尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM')
];
const fx = { rubPerCny: 12.7373, rateDate: '2026-09-10', sourceRef: 'cbr-xml-daily:R01375:2026-09-10' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2025-12-01', gaps: [] };
const assumptions = { packagingRmbDefault: 3 };
const product = (price, weightGrams, dimensionMm) => ({ productId: '1', price, weightGrams, volumeLitres: null, dimensionMm });

test('limit texts parse into numbers and cents round down like the workflow', () => {
  assert.deepEqual(parseWeightLimitKg('2.001-30KG\n收抛'), { minKg: 2.001, maxKg: 30 });
  assert.deepEqual(parseWeightLimitKg('0.001-2KG'), { minKg: 0.001, maxKg: 2 });
  assert.equal(parseWeightLimitKg('按实重'), null);
  assert.deepEqual(parseSizeLimitCm('尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重'), { sumMaxCm: 150, sideMaxCm: [60, 60, 60] });
  assert.deepEqual(parseSizeLimitCm('尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM'), { sumMaxCm: 310, sideMaxCm: [150, 80, 80] });
  assert.equal(parseSizeLimitCm('无'), null);
  assert.equal(roundDownCents(12.3456), 12.34); assert.equal(roundDownCents(-0.001), -0.01); assert.equal(roundDownCents(2.3), 2.3);
});

test('a 100x60x19 cm dog bed at 1835 RUB is volumetric, only fits big routes and ends negative', () => {
  const estimate = estimateDiscoveredProduct({ product: product(1835, 2500, '1000x600x190'), storeRule: rule, fx, commission, tariffRows, assumptions });
  assert.equal(estimate.freight.volumetricKg, 9.5); assert.equal(estimate.freight.oversize, true);
  assert.deepEqual(estimate.freight.feasibleRoutes.map(route => route.route), ['GUOO Economy Big', 'GUOO Standard Big']);
  assert.equal(estimate.freight.chosen.chargeableKg, 9.5); assert.equal(estimate.freight.chosen.freightRmb, roundDownCents(9.5 * 19.1 + 40.44));
  assert.deepEqual(estimate.freight.rejectedRoutes.map(route => route.reason), ['weight_outside_limit', 'weight_outside_limit']);
  const revenue = roundDownCents(1835 / 12.7373); assert.equal(estimate.revenueCny, revenue);
  const fixed = estimate.freight.chosen.freightRmb + 3 + 1.5;
  assert.equal(estimate.ceiling.marginLimitedCeilingRmb, roundDownCents(revenue * (1 - 0.26 - 0.15) - fixed));
  assert.equal(estimate.ceiling.profitLimitedCeilingRmb, roundDownCents(revenue * (1 - 0.26) - fixed - 20));
  assert.equal(estimate.ceiling.maximumAllInPurchaseRmb, Math.max(estimate.ceiling.marginLimitedCeilingRmb, estimate.ceiling.profitLimitedCeilingRmb));
  assert.ok(estimate.ceiling.maximumAllInPurchaseRmb < 0); assert.equal(estimate.status, 'negative'); assert.deepEqual(estimate.missing, []);
  assert.equal(estimateOutcomeForPool(estimate), 'excluded_negative'); assert.match(describeEstimate(estimate), /^预估负利润，已排除 · GUOO Economy Big 9.5kg 运费 ¥221\.89（超抛） · 佣金 14%$/);
});

test('a small cat bed fits the small route and reports the exact arithmetic', () => {
  const estimate = estimateDiscoveredProduct({ product: product(392, 700, '300x250x100'), storeRule: rule, fx, commission: { ...commission, rate: 0.12, tier: 'le1500' }, tariffRows, assumptions });
  assert.equal(estimate.freight.chosen.route, 'GUOO Economy Small'); assert.equal(estimate.freight.chosen.chargeableKg, 0.7); assert.equal(estimate.freight.volumetricKg, 0.625); assert.equal(estimate.freight.oversize, false);
  assert.equal(estimate.freight.chosen.freightRmb, roundDownCents(0.7 * 28.1 + 17.97));
  const revenue = roundDownCents(392 / 12.7373), fixed = estimate.freight.chosen.freightRmb + 4.5;
  const expected = Math.max(roundDownCents(revenue * (1 - 0.24 - 0.15) - fixed), roundDownCents(revenue * (1 - 0.24) - fixed - 20));
  assert.equal(estimate.ceiling.maximumAllInPurchaseRmb, expected);
  assert.equal(estimate.status, expected <= 0 ? 'negative' : 'ok');
  assert.equal(estimate.ceiling.freightShareOfRevenue, Math.round(estimate.freight.chosen.freightRmb / revenue * 10000) / 10000);
  const copy = estimateDiscoveredProduct({ product: product(392, 700, '300x250x100'), storeRule: rule, fx, commission: { ...commission, rate: 0.12, tier: 'le1500' }, tariffRows, assumptions });
  assert.deepEqual(copy, estimate);
  assert.deepEqual(Object.keys(estimate).sort(), ['assumptions', 'ceiling', 'commission', 'costPolicy', 'freight', 'fx', 'missing', 'priceRub', 'productId', 'revenueCny', 'schemaVersion', 'status']);
});

test('missing dimensions, missing commission, missing fx or no feasible route stay incomplete, never negative', () => {
  const noDims = estimateDiscoveredProduct({ product: product(1850, null, null), storeRule: rule, fx, commission, tariffRows, assumptions });
  assert.equal(noDims.status, 'incomplete'); assert.deepEqual(noDims.missing, ['包装尺寸重量']); assert.equal(noDims.ceiling, null);
  assert.equal(estimateOutcomeForPool(noDims), 'needs_data'); assert.match(describeEstimate(noDims), /无法估算：缺包装尺寸重量/);
  const noCommission = estimateDiscoveredProduct({ product: product(1835, 2500, '1000x600x190'), storeRule: rule, fx, commission: { rate: null, tier: null, sourceRef: null, gaps: [{ code: 'TYPE_NOT_FOUND', field: 'scope.typeIdentity', blocking: true }] }, tariffRows, assumptions });
  assert.equal(noCommission.status, 'incomplete'); assert.deepEqual(noCommission.missing, ['官方佣金']); assert.equal(noCommission.commission.gaps[0].code, 'TYPE_NOT_FOUND');
  const noFx = estimateDiscoveredProduct({ product: product(1835, 2500, '1000x600x190'), storeRule: rule, fx: null, commission, tariffRows, assumptions });
  assert.deepEqual(noFx.missing, ['汇率']); assert.equal(noFx.revenueCny, null);
  const huge = estimateDiscoveredProduct({ product: product(1835, 40000, '2000x900x900'), storeRule: rule, fx, commission, tariffRows, assumptions });
  assert.equal(huge.freight.noFeasibleRoute, true); assert.deepEqual(huge.missing, ['可行物流线路']); assert.equal(huge.status, 'incomplete');
  const dimsOnly = estimateDiscoveredProduct({ product: product(1835, null, '1000x600x190'), storeRule: rule, fx, commission, tariffRows, assumptions });
  assert.equal(dimsOnly.freight.chosen.route, 'GUOO Economy Big'); assert.equal(dimsOnly.freight.chosen.actualWeightMissing, true); assert.equal(dimsOnly.freight.oversize, false);
});

test('store rule mapping and input validation fail closed', () => {
  assert.deepEqual(costPolicyFromStoreRule(rule).thresholdPolicy, 'either');
  assert.equal(costPolicyFromStoreRule({ ...rule, thresholdPolicy: 'both' }).thresholdPolicy, 'both');
  assert.throws(() => costPolicyFromStoreRule({ ...rule, labelCostRmb: -1 }), /STORE_RULE_INVALID/);
  assert.throws(() => estimateDiscoveredProduct({ product: product(0, 1, '1x1x1'), storeRule: rule, fx, commission, tariffRows, assumptions }), /PRODUCT_INVALID/);
  assert.throws(() => estimateDiscoveredProduct({ product: product(10, 1, '1x1x1'), storeRule: rule, fx, commission, tariffRows, assumptions: {} }), /ASSUMPTIONS_INVALID/);
});

test('provider dimension text with the multiplication sign parses into the same sides as the x form', () => {
  const a = estimateDiscoveredProduct({ product: product(1850, 1300, '750x210x40'), storeRule: rule, fx, commission, tariffRows, assumptions });
  const b = estimateDiscoveredProduct({ product: product(1850, 1300, '750×210×40'), storeRule: rule, fx, commission, tariffRows, assumptions });
  assert.deepEqual(b.freight.sidesCm, a.freight.sidesCm); assert.deepEqual(b.freight.sidesCm, [75, 21, 4]);
  assert.equal(b.freight.status, a.freight.status); assert.equal(b.status, a.status);
});

// 定价指引 (owner question 2026-09-11). The numbers below are the owner's own hand calculation for one real product:
// 含运采购 ¥45、运费 ¥10.11、包装 ¥3、贴标 ¥1.5、储备 10%+2%、汇率 12.5637, Ozon 宠物用品 rFBS 12% / 14% / 15%.
// The band edges and the three rates are handed in exactly as the official table carries them; none are written here
// as a policy decision — they are this test's synthetic copy of that table, and the reader test covers the real read.
const OWNER_TIERS = [
  { tier: 'le1500', rate: 0.12, minRub: 0, maxRub: 1500 },
  { tier: '1500_5000', rate: 0.14, minRub: 1500.01, maxRub: 5000 },
  { tier: 'gt5000', rate: 0.15, minRub: 5000.01, maxRub: null }
];
const OWNER_FX = { rubPerCny: 12.5637 };
const OWNER_COSTS = { allInPurchaseRmb: 45, nonPurchaseFixedRmb: 10.11 + 3 + 1.5 };
const OWNER_POLICY = costPolicyFromStoreRule(rule);

test('定价指引反解出的保本价、达标价和市场价利润与主人自己手算的一致', () => {
  const guidance = pricingGuidance({ fx: OWNER_FX, tiers: OWNER_TIERS, costs: OWNER_COSTS, policy: OWNER_POLICY, marketPriceRub: 1666 });
  assert.equal(guidance.status, 'ok');
  // 主人手算：保本约 985 卢布，按 12% 档；整卢布向上取整后是 986，落在 12% 档内。
  assert.equal(guidance.breakEven.priceRub, 986);
  assert.equal(guidance.breakEven.commissionRate, 0.12);
  assert.ok(guidance.breakEven.unitProfitRmb >= 0 && guidance.breakEven.unitProfitRmb < 0.2);
  // 主人手算：达标最低约 1228 卢布，是"利润率 15%"先达到的（单件 ¥20 要到约 1316）。
  assert.equal(guidance.threshold.priceRub, 1228);
  assert.equal(guidance.threshold.basis, 'margin');
  assert.ok(guidance.threshold.marginRate >= 0.15);
  // 主人手算：市场价 1666 → 约 ¥38.5，1600 → ¥34.6，两档都在 14% 佣金档。
  assert.equal(guidance.market.priceRub, 1666);
  assert.equal(guidance.market.commissionRate, 0.14);
  assert.equal(guidance.market.unitProfitRmb, 38.51);
  const at1600 = pricePointAt({ priceRub: 1600, fx: OWNER_FX, tiers: OWNER_TIERS, costs: OWNER_COSTS, policy: OWNER_POLICY });
  assert.equal(at1600.unitProfitRmb, 34.62);
  assert.equal(at1600.commissionRate, 0.14);
  // 价格阶梯：保本价、达标价、市场价，外加两档整数价位，从低到高排好。
  assert.deepEqual(guidance.ladder.map(entry => entry.priceRub), [986, 1228, 1300, 1600, 1666]);
  assert.deepEqual(guidance.ladder.map(entry => entry.label), ['保本价', '达标价', '整数价位', '整数价位', '同款市场价']);
  assert.deepEqual(guidance.ladder.map(entry => entry.commissionRate), [0.12, 0.12, 0.12, 0.14, 0.14]);
  assert.equal(guidance.rubPerCny, 12.5637);
  assert.equal(guidance.allInPurchaseRmb, 45);
  assert.equal(guidance.thresholdPolicy, 'either');
});

test('佣金档位在分界线上换档，反解在每档内分别求解，只取落在本档里的价', () => {
  assert.equal(commissionTierForPrice(OWNER_TIERS, 1500).tier, 'le1500');
  assert.equal(commissionTierForPrice(OWNER_TIERS, 1500.01).tier, '1500_5000');
  assert.equal(commissionTierForPrice(OWNER_TIERS, 5001).tier, 'gt5000');
  assert.equal(commissionTierForPrice(OWNER_TIERS, 0), null, '0 不是一个售价');
  assert.equal(commissionTierForPrice([], 1600), null);
  // A purchase this expensive can only break even above the 1500 line, so the answer must carry the 14% rate.
  const costly = pricingGuidance({ fx: OWNER_FX, tiers: OWNER_TIERS, policy: OWNER_POLICY,
    costs: { allInPurchaseRmb: 120, nonPurchaseFixedRmb: 14.61 }, marketPriceRub: null });
  assert.ok(costly.breakEven.priceRub > 1500);
  assert.equal(costly.breakEven.commissionRate, 0.14);
  assert.equal(costly.breakEven.commissionTier, '1500_5000');
  // Every ladder line carries the rate of the band its own price falls in, never one rate for the whole ladder.
  for (const entry of costly.ladder) {
    assert.equal(entry.commissionRate, commissionTierForPrice(OWNER_TIERS, entry.priceRub).rate);
  }
});

test('门槛策略both要两项同时达到，缺费率或缺汇率时没有指引而不是猜一个', () => {
  const both = pricingGuidance({ fx: OWNER_FX, tiers: OWNER_TIERS, costs: OWNER_COSTS,
    policy: { ...OWNER_POLICY, thresholdPolicy: 'both' }, marketPriceRub: 1666 });
  assert.equal(both.threshold.basis, 'both');
  assert.ok(both.threshold.priceRub >= 1316, '两项同时达到要走单件利润那条更贵的线');
  assert.ok(both.threshold.unitProfitRmb >= OWNER_POLICY.minimumUnitProfitRmb);
  assert.ok(both.threshold.marginRate >= OWNER_POLICY.targetMarginRate);
  for (const missing of [
    { fx: null, tiers: OWNER_TIERS }, { fx: { rubPerCny: 0 }, tiers: OWNER_TIERS }, { fx: OWNER_FX, tiers: [] },
    { fx: OWNER_FX, tiers: [{ tier: 'broken', rate: 1.4, minRub: 0, maxRub: 1500 }] }
  ]) {
    const blank = pricingGuidance({ ...missing, costs: OWNER_COSTS, policy: OWNER_POLICY, marketPriceRub: 1666 });
    assert.equal(blank.status, 'unavailable', JSON.stringify(missing));
    assert.deepEqual(blank.ladder, []);
    assert.equal(blank.breakEven, null);
    assert.equal(blank.threshold, null);
  }
  // A price nobody can reach inside any band leaves that one answer empty; the rest of the panel still stands.
  const unreachable = pricingGuidance({ fx: OWNER_FX, tiers: [OWNER_TIERS[0]], policy: OWNER_POLICY,
    costs: { allInPurchaseRmb: 400, nonPurchaseFixedRmb: 14.61 }, marketPriceRub: null });
  assert.equal(unreachable.breakEven, null);
  assert.equal(unreachable.status, 'unavailable');
  assert.equal(pricePointAt({ priceRub: 9000, fx: OWNER_FX, tiers: [OWNER_TIERS[0]], costs: OWNER_COSTS, policy: OWNER_POLICY }), null);
});
