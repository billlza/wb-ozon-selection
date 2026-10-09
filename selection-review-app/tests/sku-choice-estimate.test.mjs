import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuooTariffCatalog } from '../lib/guoo-tariff-reader.mjs';
import { resolveLifecycleBProfitRule } from '../lib/lifecycle-b-evidence-runtime.mjs';
import { DEFAULT_RULES } from '../lib/workflow.mjs';
import { buildSupplierDraftEstimate } from '../lib/supplier-draft.mjs';
import {
  OWNER_DECLARED_PRICE_SOURCE, OWNER_DECLARED_WEIGHT_SOURCE, SKU_UNIFORM_SUPPLY_RECORD_VERSION,
  buildOwnerSkuUniformSupplyRecord, buildSkuChoiceTable, buildSkuUniformSupplyStep, capturedSkuWeightKg,
  inForceSkuUniformSupply, readSkuUniformSupplyDeclaration, skuChoiceColumns, skuChoiceLabel
} from '../lib/sku-choice-estimate.mjs';

// The project's own saved GUOO table, the store's own cost policy, and the two official rates declared by this test.
// Nothing here is a stand-in: the freight comes out of the real rows, which is the whole point of the two baselines.
const catalog = await readGuooTariffCatalog({});
const tariffRows = catalog.rows.map(row => ({ ...row, ruleVersion: catalog.ruleVersion }));
const storeRule = resolveLifecycleBProfitRule({ targetStore: 'miska' }, DEFAULT_RULES);
const fx = { rubPerCny: 12.5637, rateDate: '2026-09-12', sourceRef: 'cbr-xml-daily:R01375:2026-09-12' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic', gaps: [] };
const assumptions = { packagingRmbDefault: 3 };
const inputs = { tariffRuleVersion: catalog.ruleVersion };

/** The owner's own 找货 declaration: target price, domestic freight and packing size. The weight here is never used per row. */
const draft = Object.freeze({
  schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: '2026-09-13T01:00:00.000Z',
  sourceUrl: 'https://detail.1688.com/offer/943009939489.html', sourceUrlType: 'detail', offerId: '943009939489',
  goodsPriceRmb: 20.5, domesticShippingRmb: 3.5, allInPurchaseRmb: 24,
  packedWeightKg: 0.2, dimensionsCm: { length: 25, width: 22, height: 2.5 },
  targetSalePriceRub: 1600, note: null, provenance: 'owner_declared'
});

const sku = (id, colour, size, priceCny, stock, weightKg) => ({
  sourceSkuId: id,
  propPath: `1627207:${id}`,
  attributes: { 规格: `${colour}>${size}`, 颜色: colour, 尺码: size },
  priceCny, priceSource: 'tradeModel.skuMap.price',
  stock, stockSource: 'tradeModel.skuMap.canBookCount',
  inStock: stock > 0,
  weight: weightKg === null ? null : { value: weightKg, unit: 'kg' },
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight',
  imageUrl: null
});

const XL = sku('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 494, 0.103);
const XXXXXXXXL = sku('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 468, 0.24);
const NO_WEIGHT = sku('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, 479, null);

const table = (choices, extra = {}) => buildSkuChoiceTable({
  choices, draft, storeRule, fx, commission, tariffRows, assumptions, inputs,
  builtAt: '2026-09-13T01:00:01.000Z', ...extra
});

test('每个规格按它自己的重量算运费和利润：两条线上同款输入的校验基准必须对得上', () => {
  const built = table([XL, XXXXXXXXL]);
  const [best, worst] = built.rows;
  // 目标售价 1600 ₽、汇率 12.5637、佣金 14%、国内运费 ¥3.5、包装 ¥3、贴标 ¥1.5、预留 12%、25×22×2.5cm。
  assert.equal(best.sourceSkuId, 'sku-xl-yellow');
  assert.equal(best.weightKg, 0.103);
  assert.equal(best.chargeableKg, 0.103);
  assert.equal(best.route, 'GUOO Economy Extra Small');
  assert.equal(best.freightRmb, 6.26);
  assert.equal(best.allInPurchaseRmb, 24);
  assert.equal(best.unitProfitRmb, 59.47);
  assert.equal(best.marginRate, 0.467);

  assert.equal(worst.sourceSkuId, 'sku-8xl-yellow');
  assert.equal(worst.weightKg, 0.24);
  assert.equal(worst.chargeableKg, 0.24);
  assert.equal(worst.freightRmb, 10.11);
  assert.equal(worst.allInPurchaseRmb, 45);
  assert.equal(worst.unitProfitRmb, 34.62);
  assert.equal(worst.marginRate, 0.2718);

  assert.equal(built.best.sourceSkuId, 'sku-xl-yellow');
  assert.equal(built.worst.sourceSkuId, 'sku-8xl-yellow');
  assert.equal(built.profitDropRate, 0.4179);
  assert.equal(built.pricedCount, 2);
  assert.equal(built.total, 2);
});

test('同一套引擎、同一批输入：规格表的钱和找货估算的钱逐分相同', () => {
  // The 找货 estimate priced for exactly the 8XL parcel must produce exactly the 8XL row of the table.
  const sameParcel = { ...draft, goodsPriceRmb: 41.5, allInPurchaseRmb: 45, packedWeightKg: 0.24 };
  const estimate = buildSupplierDraftEstimate({ draft: sameParcel, storeRule, fx, commission, tariffRows,
    assumptions, estimatedAt: '2026-09-13T01:00:01.000Z', inputs });
  const row = table([XXXXXXXXL]).rows[0];
  assert.equal(estimate.estimate.freight.chosen.route, row.route);
  assert.equal(estimate.estimate.freight.chosen.freightRmb, row.freightRmb);
  assert.equal(estimate.profitAtDeclaredPurchase.unitProfitRmb, row.unitProfitRmb);
  assert.equal(estimate.profitAtDeclaredPurchase.marginRate, row.marginRate);
  assert.equal(estimate.profitAtDeclaredPurchase.passes, row.passes);
});

test('页面没给重量的规格只标待补：不借别的规格的重量，也不拿主人填的打包重量顶替', () => {
  const built = table([XL, XXXXXXXXL, NO_WEIGHT]);
  const pending = built.rows.at(-1);
  assert.equal(pending.sourceSkuId, 'sku-8xl-beige');
  assert.equal(pending.status, 'weight_missing');
  assert.deepEqual(pending.missing, ['规格重量']);
  assert.equal(pending.weightKg, null);
  assert.equal(pending.chargeableKg, null);
  assert.equal(pending.route, null);
  assert.equal(pending.freightRmb, null);
  assert.equal(pending.unitProfitRmb, null);
  assert.equal(pending.marginRate, null);
  assert.equal(pending.allInPurchaseRmb, null);
  // Its captured facts survive: the owner can still see and still pick it.
  assert.equal(pending.priceCny, 41.5);
  assert.equal(pending.stock, 479);
  assert.equal(built.weightMissingCount, 1);
  assert.equal(built.pricedCount, 2);
  // The same size with a declared weight is priced, so nothing was copied across.
  assert.equal(built.rows.find(row => row.sourceSkuId === 'sku-8xl-yellow').freightRmb, 10.11);
});

test('按单件利润从高到低排序，算不出来的排在最后并保持采到的顺序', () => {
  const middle = sku('sku-5xl', '黑色', '5XL（背长55cm）', 32.5, 471, 0.163);
  const alsoPending = sku('sku-xl-beige', '米色', 'XL（背长35cm）', 20.5, 489, null);
  const built = table([XXXXXXXXL, alsoPending, XL, NO_WEIGHT, middle]);
  assert.deepEqual(built.rows.map(row => row.sourceSkuId),
    ['sku-xl-yellow', 'sku-5xl', 'sku-8xl-yellow', 'sku-xl-beige', 'sku-8xl-beige']);
  assert.deepEqual(built.rows.map(row => row.unitProfitRmb), [59.47, 45.78, 34.62, null, null]);
});

test('规格列从采到的属性里推出来：会变的属性才当列，合并标签让位给拆开的颜色和尺码', () => {
  // Colour and size both differ across these three, so both earn a column and the combined 规格 label steps aside.
  assert.deepEqual(skuChoiceColumns([XL, XXXXXXXXL, NO_WEIGHT]), ['颜色', '尺码']);
  // Only the size differs → only the size is a column.
  assert.deepEqual(skuChoiceColumns([XL, XXXXXXXXL]), ['尺码']);
  // Only the colour differs → only the colour is a column.
  assert.deepEqual(skuChoiceColumns([XL, sku('b', '米色', 'XL（背长35cm）', 20.5, 10, 0.103)]), ['颜色']);
  // Nothing differs → the offer still names itself with its first declared attribute.
  assert.deepEqual(skuChoiceColumns([XL]), ['规格']);
  assert.deepEqual(skuChoiceColumns([{ sourceSkuId: 'x', attributes: {} }]), []);
  assert.deepEqual(skuChoiceColumns(null), []);
  const built = table([XL, XXXXXXXXL, NO_WEIGHT]);
  assert.deepEqual(built.columns, ['颜色', '尺码']);
  assert.deepEqual(built.rows[0].values, ['黄色', 'XL（背长35cm）']);
  assert.equal(built.rows[0].label, '黄色 · XL（背长35cm）');
  assert.equal(skuChoiceLabel({ sourceSkuId: 'only-id', values: [], attributes: {}, propPath: null }), 'only-id');
});

test('重量只认页面按公斤给出的正数，别的一律当没给', () => {
  assert.equal(capturedSkuWeightKg({ weight: { value: 0.103, unit: 'kg' } }), 0.103);
  assert.equal(capturedSkuWeightKg({ weight: 0.24 }), 0.24);
  assert.equal(capturedSkuWeightKg({ weight: { value: 103, unit: 'g' } }), null);
  assert.equal(capturedSkuWeightKg({ weight: { value: 0, unit: 'kg' } }), null);
  assert.equal(capturedSkuWeightKg({ weight: { value: -1, unit: 'kg' } }), null);
  assert.equal(capturedSkuWeightKg({ weight: '0.103' }), null);
  assert.equal(capturedSkuWeightKg({}), null);
  assert.equal(capturedSkuWeightKg(null), null);
});

test('数字来源那一栏全部取自本次解析的输入，没有一处写死', () => {
  const built = table([XL, XXXXXXXXL, NO_WEIGHT]);
  assert.deepEqual(built.sources, {
    targetSalePriceRub: 1600,
    rubPerCny: 12.5637,
    fxRateDate: '2026-09-12',
    fxSourceRef: 'cbr-xml-daily:R01375:2026-09-12',
    commissionRate: 0.14,
    commissionTier: '1500_5000',
    commissionSourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic',
    routes: ['GUOO Economy Extra Small'],
    tariffRuleVersion: 'guoo-2026-08-19',
    domesticShippingRmb: 3.5,
    packagingRmbDefault: 3,
    // 这个数是不是主人自己声明过的每单额外操作费。这份 assumptions 没说，那就是没声明。
    extraHandlingDeclared: false,
    labelCostRmb: 1.5,
    reserveParts: { advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02 },
    reserveRate: 0.12,
    dimensionsCm: { length: 25, width: 22, height: 2.5 }
  });
  assert.equal(built.schemaVersion, 'sku-choice-table-v1');
  assert.equal(built.builtAt, '2026-09-13T01:00:01.000Z');
});

test('缺官方输入时整张表留空，不产生任何猜出来的运费或利润', () => {
  const noFx = table([XL, XXXXXXXXL], { fx: null });
  assert.deepEqual(noFx.rows.map(row => row.status), ['not_priced', 'not_priced']);
  assert.deepEqual(noFx.rows.map(row => row.unitProfitRmb), [null, null]);
  assert.ok(noFx.rows[0].missing.includes('汇率'));
  assert.equal(noFx.best, null);
  assert.equal(noFx.worst, null);
  assert.equal(noFx.profitDropRate, null);
  assert.equal(noFx.sources.rubPerCny, null);
  const noTariff = table([XL], { tariffRows: [] });
  assert.equal(noTariff.rows[0].status, 'not_priced');
  assert.equal(noTariff.rows[0].freightRmb, null);
  assert.deepEqual(noTariff.sources.routes, []);
});

test('页面没给直接价格的规格同样只标待补，勾选状态只认这次采到的规格', () => {
  const noPrice = { ...sku('sku-no-price', '黑色', '3XL', 0, 12, 0.133), priceCny: null, priceSource: null };
  const built = table([XL, noPrice], { selectedSkuIds: ['sku-xl-yellow', 'sku-xl-yellow', 'sku-not-here'] });
  const row = built.rows.find(item => item.sourceSkuId === 'sku-no-price');
  assert.equal(row.status, 'price_missing');
  assert.deepEqual(row.missing, ['货价']);
  assert.equal(row.priceCny, null);
  assert.equal(row.unitProfitRmb, null);
  assert.deepEqual(built.selectedSkuIds, ['sku-xl-yellow']);
});

test('没有找货声明就没有表', () => {
  assert.throws(() => buildSkuChoiceTable({ choices: [XL], draft: null, storeRule, fx, commission, tariffRows, assumptions }),
    /SKU_CHOICE_TABLE_DRAFT_REQUIRED/);
});

/* ── 同重同价声明 ──────────────────────────────────────────────────────────────────────────────────────────────────
 * 主人 2026-09-16 的场景：采回来的规格全是「均码」只差颜色，重量和货价一个都没采到，而他在「找货」里填过。软件不许
 * 自己去借那个数，所以这里做的是把签字权给他。下面第一条测试是这一整组的地基：没签字的时候，一切和 2026-09-16 之前
 * 逐字相同。
 */
const DECLARED_AT = '2026-09-16T14:40:00.000Z';
/** 主人手上那件货的形状：五个规格全是「均码」只差颜色，重量和货价都没采到。 */
const colourOnly = (id, colour) => ({
  sourceSkuId: id, propPath: `1627207:${id}`, attributes: { 规格: `${colour}>均码`, 颜色: colour, 尺码: '均码' },
  priceCny: null, priceSource: null, stock: 498, stockSource: 'tradeModel.skuMap.canBookCount', inStock: true,
  weight: null, weightSource: null, imageUrl: null
});
const BLACK = colourOnly('6222816678019', '黑色');
const KHAKI = colourOnly('6222816678021', '卡其色');
const candidateOf = (extra = {}) => ({
  id: 'candidate:synthetic-uniform', dataRevision: 7,
  sourceCapture: {
    captureId: 'SCJ-uniform-1', status: 'captured_waiting_owner_selection', observedAt: '2026-09-16T14:37:09.986Z',
    skuChoices: [BLACK, KHAKI]
  },
  supplierDraftV1: draft,
  ...extra
});
const declarationOf = (extra = {}) =>
  buildOwnerSkuUniformSupplyRecord({ candidate: candidateOf(extra), declaredAt: DECLARED_AT });

test('没有同重同价声明时，缺重量缺货价的规格逐字还是「待补」——2026-09-16 之前的表一个字都没有变', () => {
  const noPrice = { ...sku('sku-no-price', '黑色', '3XL', 0, 12, 0.133), priceCny: null, priceSource: null };
  const built = table([XL, NO_WEIGHT, noPrice]);
  // 缺重量的那一行：整行留空，不拿主人填的 0.2 公斤顶替。
  const missingWeight = built.rows.find(row => row.sourceSkuId === 'sku-8xl-beige');
  assert.equal(missingWeight.status, 'weight_missing');
  assert.deepEqual(missingWeight.missing, ['规格重量']);
  assert.deepEqual([missingWeight.weightKg, missingWeight.chargeableKg, missingWeight.route, missingWeight.freightRmb],
    [null, null, null, null]);
  assert.deepEqual([missingWeight.unitProfitRmb, missingWeight.marginRate, missingWeight.allInPurchaseRmb], [null, null, null]);
  assert.equal(missingWeight.weightSource, null);
  assert.equal(missingWeight.weightBasis, null);
  // 缺货价的那一行：同样留空，不拿主人填的 ¥20.5 顶替。
  const missingPrice = built.rows.find(row => row.sourceSkuId === 'sku-no-price');
  assert.equal(missingPrice.status, 'price_missing');
  assert.deepEqual(missingPrice.missing, ['货价']);
  assert.equal(missingPrice.priceCny, null);
  assert.equal(missingPrice.priceBasis, null);
  assert.equal(missingPrice.unitProfitRmb, null);
  // 采到了的那一行还是采到的那一份，来源也还是采集给的那一句。
  const captured = built.rows.find(row => row.sourceSkuId === 'sku-xl-yellow');
  assert.equal(captured.weightSource, 'detailDescription.freightInfo.skuWeight');
  assert.equal(captured.priceSource, 'tradeModel.skuMap.price');
  assert.deepEqual([captured.weightBasis, captured.priceBasis], ['captured', 'captured']);
  assert.equal(built.weightMissingCount, 1);
  assert.equal(built.pricedCount, 1);
  // 没签过字就没有这份来源：这张表里一个数字都不是主人声明的。
  assert.equal(built.uniformSupply, null);
  // 全是「均码」只差颜色、什么都没采到的那一批，没签字时照样整列待补。
  const owners = table([BLACK, KHAKI]);
  assert.deepEqual(owners.rows.map(row => row.status), ['weight_missing', 'weight_missing']);
  assert.deepEqual(owners.rows.map(row => row.unitProfitRmb), [null, null]);
  assert.equal(owners.weightMissingCount, 2);
  assert.equal(owners.pricedCount, 0);
  assert.equal(owners.uniformSupply, null);
});

test('主人签了字之后，没采到的那一半按他在找货里填的算，而且逐分等于找货自己的估算', () => {
  const built = table([BLACK, KHAKI], { uniformSupply: declarationOf() });
  assert.equal(built.weightMissingCount, 0);
  assert.equal(built.pricedCount, 2);
  for (const row of built.rows) {
    assert.equal(row.status, 'ok');
    assert.deepEqual(row.missing, []);
    assert.equal(row.weightKg, 0.2);
    assert.equal(row.priceCny, 20.5);
    // 来源必须说清楚这是主人声明的，不是采到的。
    assert.equal(row.weightSource, OWNER_DECLARED_WEIGHT_SOURCE);
    assert.equal(row.priceSource, OWNER_DECLARED_PRICE_SOURCE);
    assert.deepEqual([row.weightBasis, row.priceBasis], ['owner_declared', 'owner_declared']);
  }
  // 「按我填的算」就是找货那一份：同一个包裹、同一个到手价，两处逐分相同。
  const estimate = buildSupplierDraftEstimate({ draft, storeRule, fx, commission, tariffRows, assumptions,
    estimatedAt: '2026-09-13T01:00:01.000Z', inputs });
  const row = built.rows[0];
  assert.equal(row.allInPurchaseRmb, draft.allInPurchaseRmb);
  assert.equal(row.route, estimate.estimate.freight.chosen.route);
  assert.equal(row.freightRmb, estimate.estimate.freight.chosen.freightRmb);
  assert.equal(row.unitProfitRmb, estimate.profitAtDeclaredPurchase.unitProfitRmb);
  assert.equal(row.marginRate, estimate.profitAtDeclaredPurchase.marginRate);
  // 这张表自己说得出：签的是哪一次采集、顶了哪几行、按的是哪两个数。
  assert.equal(built.uniformSupply.captureId, 'SCJ-uniform-1');
  assert.equal(built.uniformSupply.declaredAt, DECLARED_AT);
  assert.equal(built.uniformSupply.packedWeightKg, 0.2);
  assert.equal(built.uniformSupply.goodsPriceRmb, 20.5);
  assert.deepEqual(built.uniformSupply.appliedWeightSkuIds, [BLACK.sourceSkuId, KHAKI.sourceSkuId]);
  assert.deepEqual(built.uniformSupply.appliedPriceSkuIds, [BLACK.sourceSkuId, KHAKI.sourceSkuId]);
});

test('声明永远盖不掉采到的真实数据：采到了的按采到的算，一张表里一半采集一半声明各走各的', () => {
  // XL 重量货价都采到了；NO_WEIGHT 采到货价没采到重量；BLACK 两个都没采到。
  const built = table([XL, NO_WEIGHT, BLACK], { uniformSupply: declarationOf() });
  const captured = built.rows.find(row => row.sourceSkuId === 'sku-xl-yellow');
  // 采到的那一行必须和没有声明的时候逐分相同——2026-09-13 狗雨衣那条规矩没有被推翻。
  const untouched = table([XL, NO_WEIGHT, BLACK]).rows.find(row => row.sourceSkuId === 'sku-xl-yellow');
  assert.equal(captured.weightKg, 0.103);
  assert.equal(captured.priceCny, 20.5);
  assert.equal(captured.freightRmb, untouched.freightRmb);
  assert.equal(captured.unitProfitRmb, untouched.unitProfitRmb);
  assert.equal(captured.weightSource, 'detailDescription.freightInfo.skuWeight');
  assert.deepEqual([captured.weightBasis, captured.priceBasis], ['captured', 'captured']);

  // 只缺重量的那一行：重量按主人填的，货价还是页面给的 ¥41.5。
  const half = built.rows.find(row => row.sourceSkuId === 'sku-8xl-beige');
  assert.equal(half.status, 'ok');
  assert.equal(half.weightKg, 0.2);
  assert.equal(half.priceCny, 41.5);
  assert.equal(half.weightSource, OWNER_DECLARED_WEIGHT_SOURCE);
  assert.equal(half.priceSource, 'tradeModel.skuMap.price');
  assert.deepEqual([half.weightBasis, half.priceBasis], ['owner_declared', 'captured']);
  assert.equal(half.allInPurchaseRmb, 45);

  // 两个都缺的那一行：两个都按主人填的。
  const both = built.rows.find(row => row.sourceSkuId === BLACK.sourceSkuId);
  assert.deepEqual([both.weightBasis, both.priceBasis], ['owner_declared', 'owner_declared']);
  // 顶了哪几行说得一清二楚：重量顶了两行，货价只顶了一行。
  assert.deepEqual(built.uniformSupply.appliedWeightSkuIds, ['sku-8xl-beige', BLACK.sourceSkuId]);
  assert.deepEqual(built.uniformSupply.appliedPriceSkuIds, [BLACK.sourceSkuId]);
  assert.equal(built.weightMissingCount, 0);
  assert.equal(built.pricedCount, 3);
});

test('找货没填打包重量时，签了字也补不出重量来——软件不会凭空造一个数', () => {
  const noWeightDraft = { ...draft, packedWeightKg: null };
  const built = buildSkuChoiceTable({ choices: [BLACK], draft: noWeightDraft, storeRule, fx, commission, tariffRows,
    assumptions, inputs, builtAt: '2026-09-16T14:41:00.000Z', uniformSupply: declarationOf() });
  assert.equal(built.rows[0].status, 'weight_missing');
  assert.equal(built.rows[0].weightKg, null);
  assert.equal(built.rows[0].weightBasis, null);
  assert.equal(built.uniformSupply.packedWeightKg, null);
  assert.deepEqual(built.uniformSupply.appliedWeightSkuIds, []);
});

test('声明只对签字那一次采集有效：重新采过之后它自己失效，不静悄悄留着', () => {
  const record = declarationOf();
  assert.equal(record.schemaVersion, SKU_UNIFORM_SUPPLY_RECORD_VERSION);
  assert.equal(record.declaredBy, 'owner');
  assert.equal(record.declaredRevision, 7);
  assert.equal(record.captureId, 'SCJ-uniform-1');
  assert.deepEqual(record.sourceSkuIds, [BLACK.sourceSkuId, KHAKI.sourceSkuId]);
  assert.deepEqual(record.basisAtDeclaration, { packedWeightKg: 0.2, goodsPriceRmb: 20.5 });
  assert.equal(record.sourceRef, `owner-sku-uniform-supply:candidate:synthetic-uniform:7:${DECLARED_AT}`);

  // 没签过字。
  assert.equal(readSkuUniformSupplyDeclaration(candidateOf()).status, 'absent');
  assert.equal(inForceSkuUniformSupply(candidateOf()), null);
  // 签的就是这一次。
  const signed = candidateOf({ skuUniformSupplyV1: record });
  assert.equal(readSkuUniformSupplyDeclaration(signed).status, 'in_force');
  assert.equal(inForceSkuUniformSupply(signed), record);
  // 重新采过了：这一批规格是新采回来的，上一次的签字不再生效。
  const recaptured = candidateOf({ skuUniformSupplyV1: record });
  recaptured.sourceCapture = { ...recaptured.sourceCapture, captureId: 'SCJ-uniform-2' };
  const lapsed = readSkuUniformSupplyDeclaration(recaptured);
  assert.equal(lapsed.status, 'superseded');
  assert.match(lapsed.reason, /是对上一次采集说的/u);
  assert.equal(inForceSkuUniformSupply(recaptured), null);
  // 存着一份不是本软件写下的记录：不当成没有，也不拿来算钱。
  const broken = candidateOf({ skuUniformSupplyV1: { ...record, schemaVersion: 'something-else' } });
  assert.equal(readSkuUniformSupplyDeclaration(broken).status, 'invalid');
  assert.equal(inForceSkuUniformSupply(broken), null);
});

test('签不出意义的字就不给签：没有采集、没有规格、找货还没填数，都当场说清楚为什么', () => {
  const noCapture = candidateOf();
  delete noCapture.sourceCapture;
  assert.throws(() => buildOwnerSkuUniformSupplyRecord({ candidate: noCapture, declaredAt: DECLARED_AT }),
    /SKU_UNIFORM_SUPPLY_CAPTURE_MISSING/u);
  const noChoices = candidateOf();
  noChoices.sourceCapture = { ...noChoices.sourceCapture, skuChoices: [] };
  assert.throws(() => buildOwnerSkuUniformSupplyRecord({ candidate: noChoices, declaredAt: DECLARED_AT }),
    /SKU_UNIFORM_SUPPLY_CAPTURE_MISSING/u);
  assert.throws(() => buildOwnerSkuUniformSupplyRecord({
    candidate: candidateOf({ supplierDraftV1: { ...draft, goodsPriceRmb: null } }), declaredAt: DECLARED_AT
  }), /SKU_UNIFORM_SUPPLY_DRAFT_MISSING/u);
  assert.throws(() => buildOwnerSkuUniformSupplyRecord({ candidate: candidateOf({ dataRevision: -1 }), declaredAt: DECLARED_AT }),
    /SKU_UNIFORM_SUPPLY_CANDIDATE_INVALID/u);
  assert.throws(() => buildOwnerSkuUniformSupplyRecord({ candidate: candidateOf(), declaredAt: 'not a time' }),
    /SKU_UNIFORM_SUPPLY_DECLARED_AT_INVALID/u);
});

test('页面那一小块：缺东西才提议签字，签过之后改说他签了什么，找货没填就说先去填', () => {
  const candidate = candidateOf();
  const gapTable = table([BLACK, KHAKI]);
  const offer = buildSkuUniformSupplyStep({ candidate, draft, table: gapTable });
  assert.equal(offer.status, 'absent');
  assert.equal(offer.declared, false);
  assert.equal(offer.offered, true);
  assert.deepEqual([offer.total, offer.gapCount, offer.weightGapCount, offer.priceGapCount], [2, 2, 2, 0]);
  assert.deepEqual(offer.basis, { packedWeightKg: 0.2, goodsPriceRmb: 20.5 });
  assert.equal(offer.dataRevision, 7);
  assert.equal(offer.blockedReason, '');

  // 签过之后：说的是他签了什么、顶了几行。
  const record = declarationOf();
  const signed = candidateOf({ skuUniformSupplyV1: record });
  const done = buildSkuUniformSupplyStep({ candidate: signed, draft,
    table: table([BLACK, KHAKI], { uniformSupply: record }) });
  assert.equal(done.status, 'in_force');
  assert.equal(done.declared, true);
  assert.equal(done.offered, false);
  assert.deepEqual([done.gapCount, done.appliedWeightCount, done.appliedPriceCount], [0, 2, 2]);
  assert.equal(done.declaredAt, DECLARED_AT);
  assert.deepEqual(done.basisAtDeclaration, { packedWeightKg: 0.2, goodsPriceRmb: 20.5 });
  assert.equal(done.sourceRef, record.sourceRef);

  // 规格齐全：没有事要主人做，连提议都不提。
  const complete = buildSkuUniformSupplyStep({ candidate, draft, table: table([XL, XXXXXXXXL]) });
  assert.equal(complete.offered, false);
  assert.equal(complete.gapCount, 0);
  assert.equal(complete.blockedReason, '');

  // 找货还没填那两个数：不给签，并且说清楚先去哪儿填。
  const noBasis = { ...draft, packedWeightKg: null };
  const blocked = buildSkuUniformSupplyStep({ candidate: candidateOf({ supplierDraftV1: noBasis }), draft: noBasis, table: gapTable });
  assert.equal(blocked.offered, false);
  assert.match(blocked.blockedReason, /先在上面「找货」里填好打包重量和货价/u);

  // 重新采过之后：上一次的签字不再生效，页面重新提议，并且说明白上一次为什么不算数。
  const recaptured = candidateOf({ skuUniformSupplyV1: record });
  recaptured.sourceCapture = { ...recaptured.sourceCapture, captureId: 'SCJ-uniform-2' };
  const again = buildSkuUniformSupplyStep({ candidate: recaptured, draft, table: gapTable });
  assert.equal(again.status, 'superseded');
  assert.equal(again.declared, false);
  assert.equal(again.offered, true);
  assert.match(again.lapsedReason, /是对上一次采集说的/u);

  assert.equal(buildSkuUniformSupplyStep({ candidate, draft, table: null }), null);
});
