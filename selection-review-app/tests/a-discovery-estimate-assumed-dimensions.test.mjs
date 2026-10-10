import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateDiscoveredProduct, describeEstimate, parsePriceLimitRub, roundDownCents } from '../lib/a-discovery-estimate.mjs';
import { categoryDefaultDimensions } from '../lib/category-default-dimensions.mjs';
import { readGuooTariffCatalog } from '../lib/guoo-tariff-reader.mjs';

// Synthetic inputs only, shaped like tests/a-discovery-estimate.test.mjs; rates and bands are stand-ins, not the live table.
const rule = { pricingPolicyVersion: 'synthetic', minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either', advertisingReserveRate: 0,
  returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };
const SMALL = '尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费';
const BIG = '尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM';
const row = (route, chargeableWeightRule, perKgRmb, perParcelRmb, weightLimit, sizeLimit, declaredValueLimitRub) => ({ route, ruleVersion: 'guoo-synthetic',
  evidenceData: { chargeableWeightRule, perKgRmb, perParcelRmb, minimumChargeableWeightKg: 0, weightLimit, sizeLimit,
    ...(declaredValueLimitRub === undefined ? {} : { declaredValueLimitRub }), ...(chargeableWeightRule === 'max_actual_volume' ? { volumeDivisorCm3PerKg: 12000 } : {}) } });
const tariffRows = [
  row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', SMALL),
  row('GUOO Economy Big', 'max_actual_volume', 19.1, 40.44, '2.001-30KG\n收抛', BIG)
];
const fx = { rubPerCny: 12.7373, rateDate: '2026-09-10', sourceRef: 'cbr-xml-daily:R01375:2026-09-10' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2025-12-01', gaps: [] };
const CLOTHING = { lengthCm: 30, widthCm: 25, heightCm: 4, label: '衣服类常见大小' };
const product = (price, weightGrams, { dimensionMm = null, volumeLitres = null } = {}) => ({ productId: '1', price, weightGrams, volumeLitres, dimensionMm });
const estimate = (item, assumptions = {}, rows = tariffRows) =>
  estimateDiscoveredProduct({ product: item, storeRule: rule, fx, commission, tariffRows: rows, assumptions: { packagingRmbDefault: 3, ...assumptions } });

test('default off: a weight-only product stays exactly as incomplete as before, even with a default handed in', () => {
  const base = estimate(product(1835, 400, { volumeLitres: 3 }));
  assert.equal(base.status, 'incomplete'); assert.deepEqual(base.missing, ['可行物流线路']); assert.equal(base.ceiling, null);
  assert.equal(base.freight.sidesCm, null); assert.equal(base.freight.dimensionsBasis, null);
  assert.equal(base.freight.dimensionsAssumed, false); assert.equal(base.freight.dimensionsLabel, null);
  assert.deepEqual(base.freight.rejectedRoutes.map(route => route.reason), ['dimensions_missing', 'dimensions_missing']);
  assert.deepEqual(estimate(product(1835, 400, { volumeLitres: 3 }), { defaultDimensionsCm: CLOTHING }), base);
  assert.deepEqual(estimate(product(1835, 400, { volumeLitres: 3 }), { allowAssumedDimensions: false, defaultDimensionsCm: CLOTHING }), base);
  // Without a captured weight nothing is assumed: an assumed box alone never becomes a quote.
  const noWeight = estimate(product(1835, null, { volumeLitres: 3 }), { allowAssumedDimensions: true, defaultDimensionsCm: CLOTHING });
  assert.equal(noWeight.freight.status, 'unknown_dimensions'); assert.deepEqual(noWeight.missing, ['包装尺寸重量']); assert.equal(noWeight.freight.dimensionsBasis, null);
});

test('volume fallback: the provider volume becomes a cube rounded up to the millimetre', () => {
  const result = estimate(product(1835, 400, { volumeLitres: 3 }), { allowAssumedDimensions: true, defaultDimensionsCm: CLOTHING });
  assert.deepEqual(result.freight.sidesCm, [14.5, 14.5, 14.5]); // cbrt(3000) = 14.42…
  assert.equal(result.freight.dimensionsBasis, 'seerfar_volume'); assert.equal(result.freight.dimensionsAssumed, true); assert.equal(result.freight.dimensionsLabel, null);
  assert.equal(result.freight.chosen.route, 'GUOO Economy Small'); assert.equal(result.freight.chosen.chargeableKg, 0.4);
  assert.equal(result.freight.chosen.freightRmb, roundDownCents(0.4 * 28.1 + 17.97)); assert.deepEqual(result.missing, []);
  assert.match(describeEstimate(result), /（尺寸按体积假设，仅粗算）/);
  const exactCube = estimate(product(1835, 400, { volumeLitres: 8 }), { allowAssumedDimensions: true });
  assert.deepEqual(exactCube.freight.sidesCm, [20, 20, 20]);
});

test('category default fallback: the default sides are sorted and the label travels with the freight', () => {
  const defaultDimensionsCm = categoryDefaultDimensions({ typeZh: '宠物服装' });
  const result = estimate(product(1835, 300), { allowAssumedDimensions: true, defaultDimensionsCm });
  assert.deepEqual(result.freight.sidesCm, [30, 25, 4]); assert.equal(result.freight.dimensionsBasis, 'category_default');
  assert.equal(result.freight.dimensionsAssumed, true); assert.equal(result.freight.dimensionsLabel, '衣服类常见大小');
  assert.equal(result.freight.chosen.route, 'GUOO Economy Small'); assert.equal(result.freight.volumetricKg, 0.25);
  assert.notEqual(result.status, 'incomplete');
  assert.match(describeEstimate(result), /（尺寸按衣服类常见大小假设，仅粗算） · 佣金 14%$/);
  const unsorted = estimate(product(1835, 300), { allowAssumedDimensions: true, defaultDimensionsCm: { lengthCm: 4, widthCm: 30, heightCm: 25, label: '测试' } });
  assert.deepEqual(unsorted.freight.sidesCm, [30, 25, 4]);
});

test('captured dimensions win over both the volume and the category default', () => {
  const item = product(1835, 700, { dimensionMm: '300x250x100', volumeLitres: 3 });
  const assumed = estimate(item, { allowAssumedDimensions: true, defaultDimensionsCm: CLOTHING });
  assert.deepEqual(assumed.freight.sidesCm, [30, 25, 10]); assert.equal(assumed.freight.dimensionsBasis, 'captured');
  assert.equal(assumed.freight.dimensionsAssumed, false); assert.equal(assumed.freight.dimensionsLabel, null);
  assert.deepEqual(assumed, estimate(item));
  assert.doesNotMatch(describeEstimate(assumed), /假设/);
});

test('price band (opt-in): a parsed GUOO band rejects an out-of-band price, an unparsed band never rejects', () => {
  assert.deepEqual(parsePriceLimitRub('1-1500₽'), { min: 1, max: 1500 });
  assert.deepEqual(parsePriceLimitRub(' 1501 - 7000 ₽\n'), { min: 1501, max: 7000 });
  for (const text of ['1500-1₽', '0-1500₽', '1-1500 RUB', '不限', '', null, undefined]) assert.equal(parsePriceLimitRub(text), null, String(text));
  const banded = [row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', SMALL, '1501-7000₽'),
    row('GUOO Standard Small', 'actual_weight', 39.3, 17.97, '0.001-2KG', SMALL, '1-1500₽')];
  const item = price => product(price, 700, { dimensionMm: '300x250x100' });
  const enforce = { enforcePriceLimit: true };
  const high = estimate(item(1835), enforce, banded);
  assert.equal(high.freight.chosen.route, 'GUOO Economy Small'); assert.deepEqual(high.freight.chosen.priceLimitRub, { min: 1501, max: 7000 });
  assert.deepEqual(high.freight.rejectedRoutes, [{ route: 'GUOO Standard Small', reason: 'price_outside_limit' }]);
  const low = estimate(item(1500), enforce, banded);
  assert.equal(low.freight.chosen.route, 'GUOO Standard Small'); assert.deepEqual(low.freight.rejectedRoutes, [{ route: 'GUOO Economy Small', reason: 'price_outside_limit' }]);
  const none = estimate(item(9000), enforce, banded);
  assert.equal(none.freight.status, 'no_feasible_route'); assert.deepEqual(none.missing, ['可行物流线路']);
  for (const band of [undefined, '1501-7000 RUB', '', '0-1500₽']) {
    const loose = estimate(item(9000), enforce, [row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', SMALL, band)]);
    assert.equal(loose.freight.chosen.route, 'GUOO Economy Small', String(band)); assert.equal(loose.freight.chosen.priceLimitRub, null);
  }
});

test('price band default off: the 1600 ₽ draft keeps Economy Extra Small on the saved GUOO table, and moves off it only with the flag', async () => {
  const catalog = await readGuooTariffCatalog({});
  const rows = catalog.rows.map(entry => ({ ...entry, ruleVersion: catalog.ruleVersion }));
  // The sku-choice baseline parcel: 1600 ₽, 0.24 kg, 25×22×2.5 cm.
  const item = product(1600, 240, { dimensionMm: '250x220x25' });
  const off = estimate(item, {}, rows);
  assert.equal(off.freight.chosen.route, 'GUOO Economy Extra Small'); assert.equal(off.freight.chosen.freightRmb, 10.11);
  assert.deepEqual(off.freight.chosen.priceLimitRub, { min: 1, max: 1500 }, 'the limit stays visible even when it is not enforced');
  assert.equal(off.freight.rejectedRoutes.some(route => route.reason === 'price_outside_limit'), false);
  assert.deepEqual(estimate(item, { enforcePriceLimit: false }, rows), off);
  const on = estimate(item, { enforcePriceLimit: true }, rows);
  assert.equal(on.freight.chosen.route, 'GUOO Economy Small'); assert.deepEqual(on.freight.chosen.priceLimitRub, { min: 1501, max: 7000 });
  assert.equal(on.freight.chosen.freightRmb, roundDownCents(0.24 * 28.1 + 17.97));
  assert.deepEqual(on.freight.rejectedRoutes.filter(route => route.route === 'GUOO Economy Extra Small'), [{ route: 'GUOO Economy Extra Small', reason: 'price_outside_limit' }]);
});

test('a malformed category default or opt-in flag fails closed; an absent default is fine', () => {
  for (const defaultDimensionsCm of [{ ...CLOTHING, lengthCm: 0 }, { ...CLOTHING, widthCm: '25' }, { ...CLOTHING, heightCm: Infinity },
    { lengthCm: 30, widthCm: 25, heightCm: 4 }, { ...CLOTHING, label: '  ' }, [30, 25, 4], 'clothing', 0]) {
    assert.throws(() => estimate(product(1835, 300), { allowAssumedDimensions: true, defaultDimensionsCm }), /A_DISCOVERY_ESTIMATE_ASSUMPTIONS_INVALID: defaultDimensionsCm/, JSON.stringify(defaultDimensionsCm));
  }
  assert.throws(() => estimate(product(1835, 300), { allowAssumedDimensions: 'yes' }), /A_DISCOVERY_ESTIMATE_ASSUMPTIONS_INVALID: allowAssumedDimensions/);
  assert.throws(() => estimate(product(1835, 300), { enforcePriceLimit: 1 }), /A_DISCOVERY_ESTIMATE_ASSUMPTIONS_INVALID: enforcePriceLimit/);
  for (const defaultDimensionsCm of [undefined, null]) {
    assert.equal(estimate(product(1835, 300), { allowAssumedDimensions: true, defaultDimensionsCm }).freight.sidesCm, null);
  }
});

test('categoryDefaultDimensions matches Chinese and Russian keywords and returns null for anything unknown', () => {
  assert.deepEqual(categoryDefaultDimensions({ typeZh: '宠物服装' }), { lengthCm: 30, widthCm: 25, heightCm: 4, label: '衣服类常见大小', ruleId: 'pet_clothing' });
  assert.equal(categoryDefaultDimensions({ typeRu: 'Одежда для животных' }).ruleId, 'pet_clothing');
  assert.equal(categoryDefaultDimensions({ categoryPathZh: '宠物用品 > 背心' }).ruleId, 'pet_clothing');
  assert.equal(categoryDefaultDimensions({ typeZh: '宠物躺床' }).ruleId, 'pet_bed_mat');
  assert.equal(categoryDefaultDimensions({ typeRu: 'лежак ДЛЯ  животных' }).ruleId, 'pet_bed_mat');
  assert.equal(categoryDefaultDimensions({ title: '瓦楞纸猫抓板 耐磨' }).ruleId, 'cat_scratcher');
  assert.equal(categoryDefaultDimensions({ typeRu: 'Когтеточки' }).ruleId, 'cat_scratcher');
  assert.equal(categoryDefaultDimensions({ typeRu: 'Мягкая игрушка' }).ruleId, 'plush_toy');
  assert.equal(categoryDefaultDimensions({ typeRu: '3D-пазл' }).ruleId, 'toy_other');
  assert.equal(categoryDefaultDimensions({ title: '可爱发夹 两件装' }).ruleId, 'small_accessory');
  assert.equal(categoryDefaultDimensions({ typeRu: 'Брелок' }).ruleId, 'small_accessory');
  assert.equal(categoryDefaultDimensions({ typeZh: '音乐盒' }).ruleId, 'home_decor');
  assert.equal(categoryDefaultDimensions({ categoryPathZh: '家居 > 收纳' }).ruleId, 'storage');
  // The official type outranks the title.
  assert.equal(categoryDefaultDimensions({ typeZh: '宠物躺床', title: '猫抓板' }).ruleId, 'pet_bed_mat');
  for (const input of [{ typeZh: '查无此类', title: 'USB 数据线' }, { typeRu: 'Кабель' }, {}, undefined]) assert.equal(categoryDefaultDimensions(input), null, JSON.stringify(input));
});
