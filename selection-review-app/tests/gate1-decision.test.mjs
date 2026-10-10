import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Gate1Error, applyGate1Shortfall, buildGate1Acceptance, gate1Open, gate1ShortfallFromProfitModel, gate1ShortfallLine,
  normalizeGate1AcceptInput, normalizeGate1ShortfallInput, normalizeGate1SkipInput, reopenGate1Round
} from '../lib/gate1-decision.mjs';
import { gate1OzonOptions, gate1Preselection, gate1SupplierOptions } from '../lib/gate1-preselect.mjs';
import { buildGate1RoughProfit, gate1PackageFacts } from '../lib/gate1-rough-profit.mjs';
import { estimateDiscoveredProduct } from '../lib/a-discovery-estimate.mjs';
import { profitAtPurchase } from '../lib/supplier-draft.mjs';

// Synthetic candidate and match records only. Rates and tariff rows are stand-ins, not live tables.
const offer = (id, extra = {}) => ({ offerId: String(id), sourceUrl: `https://detail.1688.com/offer/${id}.html`, title: `合成货源 ${id}`,
  imageUrl: null, priceCny: 20, priceNote: '运费5元', quantityBegin: 1, similarity: 'similar', distance: 10, ...extra });
const ozonItem = (id, extra = {}) => ({ productId: String(id), sourceUrl: `https://www.ozon.ru/product/${id}/`, title: `Синтетика ${id}`,
  imageUrl: null, priceRub: 1500, similarity: 'identical', distance: 0, ...extra });
const candidate = (extra = {}) => ({
  id: 'candidate:gate1', targetStore: 'miska', workflowStatus: 'needs_user_data', dataRevision: 4,
  ozonImageMatch: { captureId: 'OMJ-1', status: 'compared', results: [ozonItem(9001), ozonItem(9002, { similarity: 'similar', priceRub: 1700 })], judgements: {} },
  supplierImageMatch: { captureId: 'IMJ-1', status: 'compared', judgements: {},
    results: [offer(7001, { similarity: 'identical', distance: 0, priceCny: 25 }), offer(7002, { priceCny: 18, priceNote: '包邮' }),
      offer(7003, { priceCny: 9, quantityBegin: 5 }), offer(7004, { priceCny: 19, priceNote: '起批价' })] },
  ...extra
});
const realFacts = gate1PackageFacts({ marketWeightGrams: 400, marketDimensionMm: '300x200x100' });

function accept(input, extra = {}, facts = realFacts) {
  const current = extra.candidate ?? candidate();
  return buildGate1Acceptance({ candidate: current, input: normalizeGate1AcceptInput(input), ozonOptions: gate1OzonOptions(current),
    supplierOptions: gate1SupplierOptions(current), preselection: gate1Preselection(current), marketPriceRub: 1400, packageFacts: facts,
    brandRisk: null, decidedAt: '2026-10-10T05:00:00.000Z', decidedBy: 'owner-1', ...extra });
}

test('做这件的请求是封闭的：多一个字段、货源没选、补的数不对都在写之前拒绝', () => {
  assert.throws(() => normalizeGate1AcceptInput({ dataRevision: 4, supplierOfferId: '7002', ownerSupplyConfirmed: true }), Gate1Error);
  assert.throws(() => normalizeGate1AcceptInput({ dataRevision: 4 }), /先选一家货源/u);
  assert.throws(() => normalizeGate1AcceptInput({ dataRevision: 4, supplierOfferId: '7002', facts: { domesticShippingRmb: -1 } }), /包邮填 0/u);
  assert.throws(() => normalizeGate1AcceptInput({ dataRevision: 4, supplierOfferId: '7002', facts: { dimensionsCm: { length: 1 } } }), /长宽高/u);
  assert.throws(() => normalizeGate1AcceptInput({ supplierOfferId: '7002' }), /修订号/u);
  assert.deepEqual(normalizeGate1SkipInput({ dataRevision: 1, reason: 'too_large', note: ' 太占地方 ' }),
    { dataRevision: 1, reason: 'too_large', note: '太占地方' });
  assert.throws(() => normalizeGate1SkipInput({ dataRevision: 1, reason: 'other' }), /写一句/u);
  assert.deepEqual(normalizeGate1ShortfallInput({ dataRevision: 1, choice: 'skip' }), { dataRevision: 1, choice: 'skip', reason: 'thin_profit', note: null });
  assert.throws(() => normalizeGate1ShortfallInput({ dataRevision: 1, choice: 'change_price', reason: 'too_large' }), Gate1Error);
});

test('卡只在还没做过、还没到 A 确认之后时打开；老商品已有手填方案的不再弹', () => {
  assert.equal(gate1Open(candidate()), true);
  assert.equal(gate1Open(candidate({ workflowStatus: 'eliminated' })), false);
  assert.equal(gate1Open(candidate({ supplierDraftV1: { sourceUrl: 'x' } })), false);
  assert.equal(gate1Open(candidate({ gate1DecisionV1: { decision: 'accept' } })), false);
  assert.equal(gate1Open(candidate({ gate1DecisionV1: { decision: 'skip' } })), true, '不做之后又恢复的，卡回来');
  assert.equal(gate1Open(candidate({ lifecycleV11: { aConfirmationReceipt: { receiptId: 'r' } } })), false);
});

test('全用软件先选的：方案里每个数都标着出处，三格都是「软件先选的」，没有确认供货', () => {
  const built = accept({ dataRevision: 4, ozonProductId: '9001', matchOfferId: '7001', supplierOfferId: '7002' });
  assert.equal(built.draft.sourceUrl, 'https://detail.1688.com/offer/7002.html');
  assert.equal(built.draft.goodsPriceRmb, 18);
  assert.equal(built.draft.domesticShippingRmb, 0);
  assert.equal(built.draft.packedWeightKg, 0.4);
  assert.deepEqual(built.draft.dimensionsCm, { length: 30, width: 20, height: 10 });
  assert.equal(built.draft.targetSalePriceRub, 1500);
  assert.deepEqual({ ...built.decision.factSources }, { goodsPriceRmb: '1688_image_search', domesticShippingRmb: '1688_price_note',
    packedWeightKg: 'seerfar', dimensionsCm: 'seerfar_volume', targetSalePriceRub: 'ozon_match' });
  assert.deepEqual(['ozon', 'match', 'supplier'].map(key => built.decision.picks[key].tag), ['software', 'software', 'software']);
  assert.equal(built.decision.ownerSupplyConfirmed, false);
  assert.match(built.history, /都是软件先选的/u);
  assert.match(built.history, /没有确认供货、没有下单、没有向平台写任何东西/u);
});

test('主人改过的格子标「你改过」；读不到的运费、尺寸只问缺的那一项，补上才能做', () => {
  const noDims = gate1PackageFacts({ marketWeightGrams: 400, categoryDefaultDimensionMm: '250x200x50' });
  assert.throws(() => accept({ dataRevision: 4, ozonProductId: '9002', supplierOfferId: '7004' }, {}, noDims),
    error => error.code === 'gate1_facts_missing' && error.details.missing.join() === 'domesticShippingRmb,dimensionsCm');
  const built = accept({ dataRevision: 4, ozonProductId: '9002', supplierOfferId: '7004',
    facts: { domesticShippingRmb: 4, dimensionsCm: { length: 25, width: 20, height: 5 } } }, {}, noDims);
  assert.equal(built.decision.picks.ozon.tag, 'owner');
  assert.equal(built.decision.picks.supplier.tag, 'owner');
  assert.equal(built.decision.factSources.domesticShippingRmb, 'owner');
  assert.equal(built.decision.factSources.dimensionsCm, 'owner', '类目常见尺寸只进粗算，不进方案');
  assert.equal(built.draft.targetSalePriceRub, 1700);
  assert.match(built.history, /改过 2 格/u);
});

test('不能一件起订、或不在这次找同款结果里的货源，不能当货源；卡没开时也不能做', () => {
  assert.throws(() => accept({ dataRevision: 4, supplierOfferId: '7003' }), error => error.code === 'gate1_supplier_moq');
  assert.throws(() => accept({ dataRevision: 4, supplierOfferId: '7999' }), error => error.code === 'gate1_supplier_unknown');
  assert.throws(() => accept({ dataRevision: 4, supplierOfferId: '7002', ozonProductId: '9999' }), error => error.code === 'gate1_ozon_unknown');
  assert.throws(() => accept({ dataRevision: 4, supplierOfferId: '7002' }, { candidate: candidate({ workflowStatus: 'eliminated' }) }),
    error => error.code === 'gate1_not_open');
});

test('粗算和 Seerfar、找货用的是同一套公式：每一对售价 × 货源都等于 estimateDiscoveredProduct + profitAtPurchase', async () => {
  const rule = { pricingPolicyVersion: 'synthetic', minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either',
    advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };
  const tariffRows = [{ route: 'GUOO Economy Small', ruleVersion: 'guoo-synthetic', evidenceData: { chargeableWeightRule: 'actual_weight',
    perKgRmb: 28.1, perParcelRmb: 17.97, minimumChargeableWeightKg: 0, weightLimit: '0.001-2KG', sizeLimit: '三边之和不超150CM，单边最大尺寸不超60CM' } }];
  const fx = { rubPerCny: 12.5, rateDate: '2026-10-09', sourceRef: 'synthetic-fx' };
  const commission = { rate: 0.14, tier: 'synthetic', sourceRef: 'synthetic-commission', gaps: [] };
  const current = candidate();
  const suppliers = gate1SupplierOptions(current);
  const rough = await buildGate1RoughProfit({ prices: [{ key: '9001', priceRub: 1500 }, { key: 'market', priceRub: 1400 }], suppliers,
    packageFacts: realFacts, storeRule: rule, fx, resolveCommission: async () => commission, tariffRows,
    assumptions: { packagingRmbDefault: 3 }, builtAt: '2026-10-10T05:00:00.000Z' });
  assert.equal(rough.assumed, true);
  const estimate = estimateDiscoveredProduct({ product: { productId: '9001', price: 1500, weightGrams: 400, volumeLitres: null, dimensionMm: '300x200x100' },
    storeRule: rule, fx, commission, tariffRows, assumptions: { packagingRmbDefault: 3 } });
  const direct = profitAtPurchase({ estimate, allInPurchaseRmb: 18 });
  assert.equal(rough.byPrice['9001'].profits['7002'].unitProfitRmb, direct.unitProfitRmb);
  assert.equal(rough.byPrice['9001'].profits['7002'].passes, direct.passes);
  assert.equal(rough.byPrice['9001'].profits['7004'].shippingAssumedZero, true);
  // 缺尺寸时照实说缺什么，不给数。
  const missing = await buildGate1RoughProfit({ prices: [{ key: 'market', priceRub: 1400 }], suppliers, packageFacts: gate1PackageFacts({}),
    storeRule: rule, fx, resolveCommission: async () => commission, tariffRows, assumptions: { packagingRmbDefault: 3 }, builtAt: 'x' });
  assert.deepEqual([...missing.byPrice.market.estimate.missing], ['重量和尺寸']);
  assert.equal(missing.byPrice.market.profits['7002'], null);
});

const profitModel = { profitModelVersion: 'pm-1', unitProfitRmb: 8.4, profitMargin: 0.07, recommendedSalePriceCny: 120, recommendedSalePriceRub: 1500,
  thresholds: { minimumUnitProfitRmb: 20, minimumProfitMargin: 0.15 } };

test('正式利润差多少：门槛任一项过就行，所以差额取更容易补上的那一条', () => {
  const shortfall = gate1ShortfallFromProfitModel(profitModel, { at: 't' });
  // 单件差 11.6；按利润率要 18 元，差 9.6 —— 取 9.6。
  assert.equal(shortfall.shortfallRmb, 9.6);
  assert.match(gate1ShortfallLine(shortfall), /每件赚 ¥8\.40、利润率 7\.0%，离门槛还差每件 ¥9\.60/u);
});

test('做过关口 1 的商品利润没过线不淘汰，回到需要你处理；没做过的照旧交给调用方淘汰', () => {
  const plain = candidate();
  assert.equal(applyGate1Shortfall(plain, { profitModel, at: 't' }), false);
  assert.equal(plain.gate1ShortfallV1, undefined);
  const done = candidate({ workflowStatus: 'codex_processing', gate1DecisionV1: { decision: 'accept' } });
  assert.equal(applyGate1Shortfall(done, { profitModel, at: 't' }), true);
  assert.equal(done.workflowStatus, 'needs_user_data');
  assert.match(done.neededFields[0], /正式利润没过线/u);
});

test('换货源 / 改售价：旧的一轮整份留存，卡重新打开，不覆盖历史', () => {
  const lifecycle = { status: 'b_rejected', aConfirmationReceipt: { receiptId: 'r-1' }, skuPackage: { skuPackageId: 'sku-1' } };
  const current = candidate({ gate1DecisionV1: { decision: 'accept', picks: { supplier: { id: '7002' }, ozon: { id: '9001' } } },
    supplierDraftV1: { targetSalePriceRub: 1500 }, lifecycleV11: lifecycle });
  applyGate1Shortfall(current, { profitModel, at: 't1' });
  reopenGate1Round(current, { choice: 'change_price', at: 't2', decidedBy: 'owner-1' });
  assert.equal(current.gate1RoundsV1.length, 1);
  assert.deepEqual(current.gate1RoundsV1[0].lifecycleV11, lifecycle);
  assert.equal(current.gate1RoundsV1[0].shortfall.resolution, 'change_price');
  assert.equal(current.lifecycleV11, undefined);
  assert.equal(current.supplierDraftV1, null);
  assert.equal(current.gate1ReopenV1.previousTargetSalePriceRub, 1500);
  assert.equal(gate1Open(current), true);
});
