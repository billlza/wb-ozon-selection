import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPLIER_DRAFT_INPUT_KEYS, SupplierDraftError, buildSupplierDraftEstimate, buildSupplierDraftV1,
  normalizeSupplierDraftInput, supplierDraftEstimateProduct, supplierDraftRouteBlock } from '../lib/supplier-draft.mjs';
import { roundDownCents } from '../lib/a-discovery-estimate.mjs';

// Everything below is synthetic: stand-in tariff rows, a stand-in store rule, a stand-in rate. No catalogs, no network.
const storeRule = { pricingPolicyVersion: 'synthetic-policy-1', minimumUnitProfitRmb: 20, targetMarginRate: 0.15,
  thresholdPolicy: 'either', advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05,
  withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };
const row = (route, chargeableWeightRule, perKgRmb, perParcelRmb, weightLimit, sizeLimit) => ({ route, ruleVersion: 'guoo-synthetic',
  evidenceData: { chargeableWeightRule, perKgRmb, perParcelRmb, minimumChargeableWeightKg: 0, weightLimit, sizeLimit,
    ...(chargeableWeightRule === 'max_actual_volume' ? { volumeDivisorCm3PerKg: 12000 } : {}) } });
const SMALL_SIZE = '尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费';
const BIG_SIZE = '尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM';
const TARIFF_ROWS = [
  row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', SMALL_SIZE),
  row('GUOO Economy Big', 'max_actual_volume', 19.1, 40.44, '2.001-30KG\n收抛', BIG_SIZE)
];
const fx = { rubPerCny: 12.7373, rateDate: '2026-09-10', sourceRef: 'cbr-xml-daily:R01375:2026-09-10' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2025-12-01', gaps: [] };
const assumptions = { packagingRmbDefault: 3 };
const at = '2026-09-11T02:00:00.000Z';
const input = (extra = {}) => ({ dataRevision: 4, sourceUrl: 'https://detail.1688.com/offer/876240928352.html',
  goodsPriceRmb: 15.9, domesticShippingRmb: 2.96, packedWeightKg: 1.3,
  dimensionsCm: { length: 75, width: 21, height: 4 }, targetSalePriceRub: 1850, ...extra });
const draftFrom = (extra = {}) => buildSupplierDraftV1(normalizeSupplierDraftInput(input(extra)), { declaredAt: at });
const rejects = (patch, code) => {
  assert.throws(() => normalizeSupplierDraftInput(input(patch)), error => {
    assert.ok(error instanceof SupplierDraftError);
    assert.equal(error.status, 400);
    assert.equal(error.code, code);
    return true;
  });
};

test('主人声明的找货资料是封闭输入，链接、金额、重量和尺寸都逐项校验', () => {
  assert.deepEqual([...SUPPLIER_DRAFT_INPUT_KEYS].sort(), ['dataRevision', 'dimensionsCm', 'domesticShippingRmb',
    'goodsPriceRmb', 'note', 'packedWeightKg', 'sourceUrl', 'targetSalePriceRub']);
  rejects({ ownerSupplyConfirmed: true }, 'supplier_draft_field_forbidden');
  rejects({ dataRevision: '4' }, 'supplier_draft_revision_required');
  rejects({ sourceUrl: 'https://item.taobao.com/item.htm?id=1' }, 'supplier_draft_source_url_invalid');
  rejects({ sourceUrl: 'https://m.1688.com/offer/876240928352.html' }, 'supplier_draft_source_url_invalid');
  // A tracked link the owner copied from the app keeps its offer identity and loses only the tracking query.
  assert.equal(normalizeSupplierDraftInput(input({ sourceUrl: 'https://detail.1688.com/offer/876240928352.html?spm=x' })).sourceUrl,
    'https://detail.1688.com/offer/876240928352.html');
  rejects({ goodsPriceRmb: 0 }, 'supplier_draft_goods_price_invalid');
  rejects({ domesticShippingRmb: -1 }, 'supplier_draft_domestic_shipping_invalid');
  rejects({ packedWeightKg: 0 }, 'supplier_draft_weight_invalid');
  rejects({ dimensionsCm: { length: 75, width: 21 } }, 'supplier_draft_dimensions_invalid');
  rejects({ dimensionsCm: { length: 75, width: 21, height: 4, depth: 2 } }, 'supplier_draft_dimensions_invalid');
  rejects({ targetSalePriceRub: -1 }, 'supplier_draft_target_price_invalid');
  rejects({ note: 'x'.repeat(1001) }, 'supplier_draft_note_invalid');
  // A short share link is a legitimate owner input; the extension resolves it later, the draft keeps it as declared.
  assert.equal(normalizeSupplierDraftInput(input({ sourceUrl: 'https://qr.1688.com/s/7OnLCakq/' })).sourceUrl, 'https://qr.1688.com/s/7OnLCakq');
  assert.equal(normalizeSupplierDraftInput(input({ sourceUrl: 'https://qr.1688.com/s/7OnLCakq/' })).offerId, null);
});

test('保存的找货方案是主人声明资料，到手总价等于货价加国内运费', () => {
  const draft = draftFrom({ note: '  卖家说一件可买  ' });
  assert.equal(draft.schemaVersion, 'supplier-draft-v1');
  assert.equal(draft.declaredBy, 'owner');
  assert.equal(draft.provenance, 'owner_declared');
  assert.equal(draft.declaredAt, at);
  assert.equal(draft.sourceUrl, 'https://detail.1688.com/offer/876240928352.html');
  assert.equal(draft.sourceUrlType, 'detail');
  assert.equal(draft.offerId, '876240928352');
  assert.equal(draft.allInPurchaseRmb, 18.86);
  assert.equal(draft.note, '卖家说一件可买');
  assert.deepEqual(draft.dimensionsCm, { length: 75, width: 21, height: 4 });
  assert.deepEqual(Object.keys(draft).sort(), ['allInPurchaseRmb', 'declaredAt', 'declaredBy', 'dimensionsCm', 'domesticShippingRmb',
    'goodsPriceRmb', 'note', 'offerId', 'packedWeightKg', 'provenance', 'schemaVersion', 'sourceUrl', 'sourceUrlType', 'targetSalePriceRub']);
  assert.deepEqual(supplierDraftEstimateProduct(draft), { productId: null, price: 1850, categoryPath: null,
    weightGrams: 1300, volumeLitres: null, dimensionMm: '750x210x40' });
});

test('75厘米长边配1.3公斤没有可走线路，提示直接引用资费表自己的限制', () => {
  const draft = draftFrom();
  const result = buildSupplierDraftEstimate({ draft, storeRule, fx, commission, tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.equal(result.estimate.status, 'incomplete');
  assert.deepEqual(result.estimate.missing, ['可行物流线路']);
  assert.equal(result.profitAtDeclaredPurchase, null);
  assert.equal(result.routeBlock.code, 'no_feasible_route');
  assert.equal(result.routeBlock.message, '当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米，或按大件重量（≥2.001 公斤）重新申报。');
  assert.equal(result.routeBlock.foldSideMaxCm, 60);
  assert.equal(result.routeBlock.bigParcelMinKg, 2.001);
  assert.deepEqual(result.routeBlock.routes, [
    { route: 'GUOO Economy Small', reason: 'side_outside_limit', detail: '单边最大 60 厘米，当前最长边 75 厘米' },
    { route: 'GUOO Economy Big', reason: 'weight_outside_limit', detail: '可走 2.001-30 公斤，当前 1.3 公斤' }
  ]);
  // The limits are read from the rows, so a table carrying other numbers reports those numbers instead.
  const wider = [row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', '尺寸限制：三边之和不超150CM，单边最大尺寸不超80CM'),
    row('GUOO Economy Big', 'max_actual_volume', 19.1, 40.44, '3-30KG\n收抛', BIG_SIZE)];
  const widened = buildSupplierDraftEstimate({ draft: draftFrom({ dimensionsCm: { length: 95, width: 21, height: 4 } }),
    storeRule, fx, commission, tariffRows: wider, assumptions, estimatedAt: at });
  assert.equal(widened.routeBlock.message, '当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤80 厘米，或按大件重量（≥3 公斤）重新申报。');
  assert.equal(supplierDraftRouteBlock({ estimate: widened.estimate, tariffRows: [] }).routes[0].detail, 'side_outside_limit');
});

test('折叠后能走小包时，报出采购上限和按声明采购价的真实单件利润', () => {
  const draft = draftFrom({ dimensionsCm: { length: 40, width: 21, height: 4 }, packedWeightKg: 1.3 });
  const result = buildSupplierDraftEstimate({ draft, storeRule, fx, commission, tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at,
    inputs: { fxSourceRef: fx.sourceRef, fxRateDate: fx.rateDate, commissionSourceRef: commission.sourceRef,
      tariffRuleVersion: 'guoo-synthetic', costPolicyVersion: storeRule.pricingPolicyVersion } });
  assert.equal(result.schemaVersion, 'supplier-draft-estimate-v1');
  assert.equal(result.routeBlock, null);
  assert.equal(result.estimate.status, 'ok');
  assert.equal(result.estimate.freight.chosen.route, 'GUOO Economy Small');
  assert.equal(result.estimate.freight.chosen.chargeableKg, 1.3);
  const revenue = roundDownCents(1850 / fx.rubPerCny);
  const fixed = roundDownCents(result.estimate.freight.chosen.freightRmb + 3 + 1.5);
  const expectedProfit = roundDownCents(revenue * (1 - 0.26) - fixed - 18.86);
  const profit = result.profitAtDeclaredPurchase;
  assert.equal(profit.allInPurchaseRmb, 18.86);
  assert.equal(profit.revenueCny, revenue);
  assert.equal(profit.unitProfitRmb, expectedProfit);
  assert.equal(profit.marginRate, Math.round(expectedProfit / revenue * 10000) / 10000);
  assert.equal(profit.thresholdPolicy, 'either');
  assert.equal(profit.passes, profit.meetsMinimumUnitProfit || profit.meetsTargetMargin);
  assert.equal(profit.withinPurchaseCeiling, 18.86 <= result.estimate.ceiling.maximumAllInPurchaseRmb);
  assert.deepEqual(result.inputs, { fxSourceRef: fx.sourceRef, fxRateDate: '2026-09-10',
    commissionSourceRef: commission.sourceRef, tariffRuleVersion: 'guoo-synthetic',
    costPolicyVersion: 'synthetic-policy-1', packagingRmbDefault: 3, commissionTiersSourceRef: null });
  // No official rate ladder was handed in, so there is no pricing guidance at all — never a guessed one.
  assert.equal(result.pricingGuidance, null);
});

test('门槛策略决定通过口径：either任一达标即通过，both必须同时达标', () => {
  const draft = draftFrom({ dimensionsCm: { length: 40, width: 21, height: 4 } });
  const either = buildSupplierDraftEstimate({ draft, storeRule, fx, commission, tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  const both = buildSupplierDraftEstimate({ draft, storeRule: { ...storeRule, thresholdPolicy: 'both' }, fx, commission,
    tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.equal(either.profitAtDeclaredPurchase.passes,
    either.profitAtDeclaredPurchase.meetsMinimumUnitProfit || either.profitAtDeclaredPurchase.meetsTargetMargin);
  assert.equal(both.profitAtDeclaredPurchase.passes,
    both.profitAtDeclaredPurchase.meetsMinimumUnitProfit && both.profitAtDeclaredPurchase.meetsTargetMargin);
  // A purchase price above the ceiling must report a real loss, never an encouraging rounded number.
  const expensive = buildSupplierDraftEstimate({ draft: draftFrom({ dimensionsCm: { length: 40, width: 21, height: 4 }, goodsPriceRmb: 400 }),
    storeRule, fx, commission, tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.ok(expensive.profitAtDeclaredPurchase.unitProfitRmb < 0);
  assert.equal(expensive.profitAtDeclaredPurchase.passes, false);
  assert.equal(expensive.profitAtDeclaredPurchase.withinPurchaseCeiling, false);
});

test('缺汇率或缺佣金时估算保持不完整，不产生任何利润数字', () => {
  const draft = draftFrom({ dimensionsCm: { length: 40, width: 21, height: 4 } });
  const noFx = buildSupplierDraftEstimate({ draft, storeRule, fx: null, commission, tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.deepEqual(noFx.estimate.missing, ['汇率']);
  assert.equal(noFx.profitAtDeclaredPurchase, null);
  assert.equal(noFx.estimate.revenueCny, null);
  const noCommission = buildSupplierDraftEstimate({ draft, storeRule, fx, commission: { rate: null, tier: null, sourceRef: null, gaps: [] },
    tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.deepEqual(noCommission.estimate.missing, ['官方佣金']);
  assert.equal(noCommission.profitAtDeclaredPurchase, null);
  assert.equal(noCommission.routeBlock, null);
});

// 定价指引 rides on the same saved estimate: same FX, same reserves, same freight, plus the official rate ladder.
const TIERS = { tiers: [{ tier: 'le1500', rate: 0.12, minRub: 0, maxRub: 1500 },
  { tier: '1500_5000', rate: 0.14, minRub: 1500.01, maxRub: 5000 },
  { tier: 'gt5000', rate: 0.15, minRub: 5000.01, maxRub: null }],
sourceRef: 'ozon-official-commission:2025-12-01:sha256:synthetic', gaps: [] };

test('保存找货资料后同时给出保本价、达标价、市场价利润和价格阶梯，口径与利润判断同一套', () => {
  const draft = draftFrom({ dimensionsCm: { length: 40, width: 21, height: 4 } });
  const marketProduct = { productId: '2107989735', price: 1666, categoryPath: { cnTitlePath: '宠物用品 > 宠物躺床' } };
  const result = buildSupplierDraftEstimate({ draft, storeRule, fx, commission, commissionTiers: TIERS,
    tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at, marketProduct });
  const guidance = result.pricingGuidance;
  assert.equal(result.inputs.commissionTiersSourceRef, TIERS.sourceRef);
  assert.equal(guidance.status, 'ok');
  // Same arithmetic as profitAtDeclaredPurchase, only solved the other way round: at 保本价 the profit is barely ≥ 0.
  assert.equal(guidance.allInPurchaseRmb, draft.allInPurchaseRmb);
  assert.equal(guidance.nonPurchaseFixedRmb, result.estimate.ceiling.nonPurchaseFixedRmb);
  assert.equal(guidance.rubPerCny, fx.rubPerCny);
  assert.ok(guidance.breakEven.unitProfitRmb >= 0);
  const belowBreakEven = guidance.breakEven.priceRub - 1;
  const revenue = roundDownCents(belowBreakEven / fx.rubPerCny);
  const reserve = guidance.breakEven.commissionRate + 0.05 + 0.05 + 0.02;
  assert.ok(roundDownCents(revenue * (1 - reserve) - guidance.nonPurchaseFixedRmb - draft.allInPurchaseRmb) < 0,
    '再低一卢布就亏，保本价确实是最低的那个整卢布');
  // 达标价 reaches this store's own threshold, and says which of the two it reached.
  assert.ok(['unit_profit', 'margin', 'both'].includes(guidance.threshold.basis));
  assert.ok(guidance.threshold.unitProfitRmb >= storeRule.minimumUnitProfitRmb ||
    guidance.threshold.marginRate >= storeRule.targetMarginRate);
  // 市场价 is the Seerfar snapshot price of this very product, never the owner's typed target price.
  assert.equal(guidance.market.priceRub, 1666);
  assert.notEqual(guidance.market.priceRub, draft.targetSalePriceRub);
  assert.ok(guidance.ladder.length >= 3);
  assert.deepEqual(guidance.ladder.map(entry => entry.priceRub), [...guidance.ladder.map(entry => entry.priceRub)].sort((a, b) => a - b));
});

test('没有官方费率档位、或估算本身就不完整时，一个定价指引都不给', () => {
  const draft = draftFrom({ dimensionsCm: { length: 40, width: 21, height: 4 } });
  const noTiers = buildSupplierDraftEstimate({ draft, storeRule, fx, commission, commissionTiers: { tiers: [], sourceRef: null, gaps: [] },
    tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.equal(noTiers.pricingGuidance, null);
  assert.equal(noTiers.inputs.commissionTiersSourceRef, null);
  // The declared package has no feasible route here, so there is no freight and therefore no price at all.
  const blocked = buildSupplierDraftEstimate({ draft: draftFrom(), storeRule, fx, commission, commissionTiers: TIERS,
    tariffRows: TARIFF_ROWS, assumptions, estimatedAt: at });
  assert.equal(blocked.estimate.status, 'incomplete');
  assert.equal(blocked.pricingGuidance, null);
});
