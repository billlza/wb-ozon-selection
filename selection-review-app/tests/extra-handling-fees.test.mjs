import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticBCostPolicy } from './fixtures/b-cost-policy-fixture.mjs';
import { SYNTHETIC_STORE_REF } from './fixtures/store-binding-fixture.mjs';
import { buildLifecycleBExplicitOtherCosts, inspectLifecycleBCostReadiness,
  resolveLifecycleBProfitRule } from '../lib/lifecycle-b-evidence-runtime.mjs';
import { normalizeCandidateUserPatchInput } from '../lib/candidate-user-fields.mjs';
import { readGuooTariffCatalog } from '../lib/guoo-tariff-reader.mjs';
import { DEFAULT_RULES } from '../lib/workflow.mjs';
import { buildSkuChoiceTable } from '../lib/sku-choice-estimate.mjs';
import { costPolicyFromStoreRule, roundDownCents } from '../lib/a-discovery-estimate.mjs';
import { buildProfitStepReview, extraHandlingBreakPoint } from '../lib/profit-step-review.mjs';
import {
  EXTRA_HANDLING_FEES_RECORD_VERSION, buildExtraHandlingFeesStep, buildOwnerExtraHandlingFeesRecord,
  extraHandlingFeeAssumptions, extraHandlingFeesConsistency, extraHandlingFeesGate, extraHandlingFeesSentence,
  extraHandlingFeesTotalRmb, readDeclaredExtraHandlingFees, validateOwnerExtraHandlingFees
} from '../lib/extra-handling-fees.mjs';

/**
 * 每单额外操作费 — 包材、拆单费、合包费、额外材料费这一类，每单要另外花的钱。
 *
 * 这一组用例钉住的是主人 2026-09-15 定下的四件事，外加那个把他挡在最后一个按钮上的缺口：
 *   1. 明细各行加起来必须正好是权威总额 `packagingCostRmb`，不等就拒；
 *   2. 一行都没有 = ¥0.00，而且那是一次明确的声明，不是「没填」；
 *   3. 没声明过的时候，缺项在「算利润」这一步就报出来，不是走到最后那个按钮才报；
 *   4. 页面显示的利润按这件货自己的数算，不按项目假设值 ¥3；
 *   5. 「这笔费用涨到 ¥X 才掉线」按每个规格自己的利润和这家店自己的门槛现算，跨了门槛就会变。
 *
 * 门槛和资费都取自项目自己的东西：本店成本规则、项目保存的国欧资费表，没有一个数是写在用例里的。
 */

const DECLARED_AT = '2026-09-15T02:00:00.000Z';

function costRules() {
  const policy = { fixedOtherRmb: 0, advertisingReserveRate: 0, returnOpsReserveRate: 0.05,
    targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceRoundRmb: 1, thresholdPolicy: 'either' };
  return { ozonDandanshu: { ...policy, costPolicySnapshot: createSyntheticBCostPolicy({
    scope: { platform: 'ozon', store: 'dandanshu', storeRef: SYNTHETIC_STORE_REF, salesScheme: 'rfbs' },
    values: { returnReserveRate: 0.05 } }) } };
}

const bCandidate = (changes = {}) => ({
  id: 'candidate:synthetic-extra-handling', dataRevision: 7, targetStore: 'dandanshu', storeRef: SYNTHETIC_STORE_REF,
  lifecycleEvidenceContextV11: { salesScheme: 'rfbs' }, packagingCostRmb: 0, ...changes
});

/** 主人真正会写的那一份：包材 ¥1.50 ＋ 拆单费 ¥1.80，合计 ¥3.30。 */
const TWO_LINES = Object.freeze([{ name: '包材', amountRmb: 1.5 }, { name: '拆单费', amountRmb: 1.8 }]);

function declared(items, changes = {}) {
  const record = buildOwnerExtraHandlingFeesRecord({
    candidate: { id: 'candidate:synthetic-extra-handling', dataRevision: 7 }, items, declaredAt: DECLARED_AT });
  return bCandidate({ packagingCostRmb: record.totalRmb, extraHandlingFeesV1: record, ...changes });
}

test('这笔钱是一份清单：名目加金额，合计由行算出来，不由调用方说了算', () => {
  const record = buildOwnerExtraHandlingFeesRecord({ candidate: { id: 'c', dataRevision: 3 }, items: TWO_LINES, declaredAt: DECLARED_AT });
  assert.equal(record.schemaVersion, EXTRA_HANDLING_FEES_RECORD_VERSION);
  assert.equal(record.declaredBy, 'owner');
  assert.equal(record.declaredRevision, 3);
  assert.deepEqual(record.items, [{ name: '包材', amountRmb: 1.5 }, { name: '拆单费', amountRmb: 1.8 }]);
  // 1.5 + 1.8 在浮点里不是 3.3；合计必须落到分。
  assert.equal(record.totalRmb, 3.3);
  assert.equal(extraHandlingFeesTotalRmb(TWO_LINES), 3.3);
  assert.equal(record.headline, '每单额外操作费 ¥3.30：包材 ¥1.50 ＋ 拆单费 ¥1.80。');
  assert.equal(record.sourceRef, `owner-extra-handling-fees:c:3:${DECLARED_AT}`);

  // 名目随主人写，不是一张封闭的表。
  for (const name of ['合包费', '额外材料费', '这一批要单独套气泡袋']) {
    const one = buildOwnerExtraHandlingFeesRecord({ candidate: { id: 'c', dataRevision: 3 }, items: [{ name, amountRmb: 2 }], declaredAt: DECLARED_AT });
    assert.equal(one.items[0].name, name);
  }
});

test('一行都没有就是 ¥0.00，而且那是一次明确的声明，不是「没填」', () => {
  const empty = buildOwnerExtraHandlingFeesRecord({ candidate: { id: 'c', dataRevision: 3 }, items: [], declaredAt: DECLARED_AT });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.totalRmb, 0);
  assert.equal(empty.headline, '每单额外操作费 ¥0.00：这件商品你声明了不用另外加钱。');
  assert.equal(extraHandlingFeesSentence([]), '每单额外操作费 ¥0.00：这件商品你声明了不用另外加钱。');

  // 「没填」和「声明了 ¥0」在软件眼里必须是两件事：前者挡住这一步，后者放行。
  const nothingSaid = bCandidate({ packagingCostRmb: null });
  assert.equal(extraHandlingFeesConsistency(nothingSaid).status, 'absent');
  assert.equal(extraHandlingFeesGate(nothingSaid).ready, false);
  assert.match(extraHandlingFeesGate(nothingSaid).reason, /还没声明每单额外操作费/u);

  const zeroDeclared = declared([]);
  assert.equal(zeroDeclared.packagingCostRmb, 0);
  assert.equal(extraHandlingFeesConsistency(zeroDeclared).status, 'consistent');
  assert.deepEqual(extraHandlingFeesGate(zeroDeclared), { ready: true, reason: '' });
  // 软件提议的就是这一份空清单：主人一键确认就过，不用打字。
  assert.deepEqual(buildExtraHandlingFeesStep(nothingSaid).proposal,
    { items: [], totalRmb: 0, headline: '每单额外操作费 ¥0.00：这件商品你声明了不用另外加钱。' });
});

test('明细各行之和必须等于权威总额，不等就拒，而且拒的是最后那道钱的门', () => {
  const rules = costRules();
  const rule = resolveLifecycleBProfitRule(bCandidate(), rules);

  const ok = declared(TWO_LINES);
  assert.equal(buildLifecycleBExplicitOtherCosts(ok, rule).packagingRmb, 3.3);

  // 总额被单独改掉，明细就不再是这笔钱的分解：整份成本政策停在这里，而不是拿一份对不上的分解去支撑利润。
  const drifted = declared(TWO_LINES, { packagingCostRmb: 3.2 });
  assert.equal(extraHandlingFeesConsistency(drifted).status, 'inconsistent');
  assert.throws(() => buildLifecycleBExplicitOtherCosts(drifted, rule),
    { code: 'B_EVIDENCE_COST_POLICY_INCOMPLETE', message: /明细各行加起来是 ¥3\.30，这件商品记着的合计却是 ¥3\.20/u });
  assert.equal(extraHandlingFeesGate(drifted).ready, false);

  // 记录本身写了一个和自己各行对不上的合计，同样不认。
  const forged = declared(TWO_LINES);
  forged.extraHandlingFeesV1 = { ...forged.extraHandlingFeesV1, totalRmb: 9.9 };
  assert.throws(() => readDeclaredExtraHandlingFees(forged), /EXTRA_HANDLING_FEES_RECORD_INVALID/u);
  assert.equal(extraHandlingFeesConsistency(forged).status, 'inconsistent');
  assert.throws(() => buildLifecycleBExplicitOtherCosts(forged, rule), { code: 'B_EVIDENCE_COST_POLICY_INCOMPLETE' });

  // 有合计没有明细是历史数据，不是错：总额照旧，利润链路一个字都不用改。
  const historical = bCandidate({ packagingCostRmb: 1.5 });
  assert.equal(extraHandlingFeesConsistency(historical).status, 'total_only');
  assert.deepEqual(extraHandlingFeesGate(historical), { ready: true, reason: '' });
  assert.equal(buildLifecycleBExplicitOtherCosts(historical, rule).packagingRmb, 1.5);
});

test('总额不能绕过明细单独改；旧表单改它会被拒，并把人指回明细', () => {
  const current = declared(TWO_LINES);
  assert.throws(() => normalizeCandidateUserPatchInput({ packagingCostRmb: 2 }, current),
    { status: 409, message: /有一份明细（合计 ¥3\.30）；要改金额请改那份明细/u });
  // 没有明细的商品照旧能改总额——这条路没有被顺手关掉。
  assert.deepEqual(normalizeCandidateUserPatchInput({ packagingCostRmb: 2 }, bCandidate({ packagingCostRmb: 1.5 })),
    { packagingCostRmb: 2 });
  // 改成和明细一样的数不算改，不拒。
  assert.deepEqual(normalizeCandidateUserPatchInput({ packagingCostRmb: 3.3 }, current), { packagingCostRmb: 3.3 });
  // 明细本身已经坏掉的商品更不能只改总额；这条路给的是一句能照做的话，不是一个没人接的异常。
  const broken = declared(TWO_LINES);
  broken.extraHandlingFeesV1 = { ...broken.extraHandlingFeesV1, items: [{ name: '包材', amountRmb: -1 }] };
  assert.throws(() => normalizeCandidateUserPatchInput({ packagingCostRmb: 2 }, broken),
    { status: 409, message: /请先在「算利润」里重新确认一次这份明细/u });
});

test('填得不成立的清单在保存之前就被挡住，并逐行说清楚哪里不对', () => {
  const cases = [
    [[{ name: '', amountRmb: 1.5 }], /要写清楚这笔钱叫什么/u],
    [[{ name: '包材', amountRmb: 0 }], /这一笔不用花钱就把这一行删掉/u],
    [[{ name: '包材', amountRmb: -1 }], /这一笔不用花钱就把这一行删掉/u],
    [[{ name: '包材', amountRmb: 1.555 }], /最多两位小数/u],
    [[{ name: '包材', amountRmb: '1.5' }], /最多两位小数/u],
    [[{ name: '包材', amountRmb: 1.5 }, { name: '包材', amountRmb: 2 }], /写了两行/u],
    [[{ name: '包材', amountRmb: 1.5, note: 'x' }], /只接受「名目」和「金额」两项/u],
    [Array.from({ length: 13 }, (_, index) => ({ name: `第${index}笔`, amountRmb: 1 })), /最多 12 行/u],
    ['不是清单', /要是一份清单/u]
  ];
  for (const [items, pattern] of cases) {
    const validation = validateOwnerExtraHandlingFees(items);
    assert.equal(validation.valid, false, JSON.stringify(items));
    assert.match(validation.errors.map(item => item.message).join('；'), pattern);
    assert.throws(() => buildOwnerExtraHandlingFeesRecord({ candidate: { id: 'c', dataRevision: 1 }, items, declaredAt: DECLARED_AT }),
      /EXTRA_HANDLING_FEES_INVALID/u);
  }
  assert.deepEqual(validateOwnerExtraHandlingFees([]), { valid: true, errors: [] });
  assert.deepEqual(validateOwnerExtraHandlingFees(TWO_LINES), { valid: true, errors: [] });
});

test('没声明的时候 B 阶段那句缺口点名说的是这笔钱，不是一句「成本规则不完整」', () => {
  const rules = costRules();
  const readiness = inspectLifecycleBCostReadiness({ candidate: bCandidate({ packagingCostRmb: null }), rules,
    asOf: '2026-09-15T02:00:00.000Z' });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'B_EVIDENCE_COST_POLICY_INCOMPLETE');
  assert.equal(readiness.missing.length, 1);
  assert.match(readiness.missing[0], /还没声明每单额外操作费/u);
  assert.match(readiness.missing[0], /一键确认 ¥0\.00/u);
  // 声明过了这条缺口就没了。
  assert.deepEqual(inspectLifecycleBCostReadiness({ candidate: declared([]), rules, asOf: '2026-09-15T02:00:00.000Z' }),
    { ready: true, missing: [], code: null });
});

test('这件货自己的声明就是算钱用的那个数，没声明时是 ¥0 且带着「没签过字」的标记', () => {
  assert.deepEqual(extraHandlingFeeAssumptions(declared(TWO_LINES)),
    { packagingRmbDefault: 3.3, extraHandlingDeclared: true, extraHandlingStatus: 'consistent' });
  assert.deepEqual(extraHandlingFeeAssumptions(declared([])),
    { packagingRmbDefault: 0, extraHandlingDeclared: true, extraHandlingStatus: 'consistent' });
  assert.deepEqual(extraHandlingFeeAssumptions(bCandidate({ packagingCostRmb: null })),
    { packagingRmbDefault: 0, extraHandlingDeclared: false, extraHandlingStatus: 'absent' });
  // 历史数据只有合计：那个合计就是主人的钱，照旧算，标记为已声明。
  assert.deepEqual(extraHandlingFeeAssumptions(bCandidate({ packagingCostRmb: 1.5 })),
    { packagingRmbDefault: 1.5, extraHandlingDeclared: true, extraHandlingStatus: 'total_only' });
  // 明细和合计对不上：那个数不能拿来算钱。
  assert.equal(extraHandlingFeeAssumptions(declared(TWO_LINES, { packagingCostRmb: 3.2 })).extraHandlingDeclared, false);
});

/* ── 「这笔费用涨到 ¥X 才掉线」 ─────────────────────────────────────────────────────────────────────────────────────
 * 主人 2026-09-15 最看重的那一句。X 由这个规格自己的利润和这家店自己的门槛现算：门槛是两条里较松的那条
 * （本店 thresholdPolicy 是 either），X = 现在这笔费用 + (单件利润 − 门槛)。
 */
const catalog = await readGuooTariffCatalog({});
const tariffRows = catalog.rows.map(row => ({ ...row, ruleVersion: catalog.ruleVersion }));
const storeRule = resolveLifecycleBProfitRule({ targetStore: 'miska' }, DEFAULT_RULES);
const fx = { rubPerCny: 12.5637, rateDate: '2026-09-12', sourceRef: 'cbr-xml-daily:R01375:2026-09-12' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic', gaps: [] };
const OFFER_URL = 'https://detail.1688.com/offer/943009939489.html';
const draft = Object.freeze({
  schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: '2026-09-13T01:00:00.000Z',
  sourceUrl: OFFER_URL, sourceUrlType: 'detail', offerId: '943009939489',
  goodsPriceRmb: 20.5, domesticShippingRmb: 3.5, allInPurchaseRmb: 24,
  packedWeightKg: 0.2, dimensionsCm: { length: 25, width: 22, height: 2.5 },
  targetSalePriceRub: 1600, note: null, provenance: 'owner_declared'
});
const sku = (id, size, priceCny, weightKg) => ({
  sourceSkuId: id, propPath: `1627207:${id}`, attributes: { 尺码: size },
  priceCny, priceSource: 'tradeModel.skuMap.price', stock: 400, inStock: true,
  weight: { value: weightKg, unit: 'kg' }, weightSource: 'detailDescription.freightInfo.skuWeight', imageUrl: null
});
const ROOMY = sku('sku-xl', 'XL', 20.5, 0.103);
const TIGHT = sku('sku-8xl', '8XL', 41.5, 0.24);

const tableFor = (feeRmb, declaredFee) => buildSkuChoiceTable({
  choices: [ROOMY, TIGHT], draft, storeRule, fx, commission, tariffRows,
  assumptions: { packagingRmbDefault: feeRmb, extraHandlingDeclared: declaredFee },
  marketProduct: { productId: '3605840795', categoryPath: null },
  selectedSkuIds: ['sku-xl', 'sku-8xl'], builtAt: '2026-09-13T01:00:01.000Z', inputs: {}
});

test('「涨到 ¥X 才掉线」按每个规格自己的利润现算，宽的和紧的答案不一样', () => {
  const policy = costPolicyFromStoreRule(storeRule);
  const rows = tableFor(3, false).rows;
  const roomy = rows.find(row => row.sourceSkuId === 'sku-xl');
  const tight = rows.find(row => row.sourceSkuId === 'sku-8xl');

  // 门槛取两条里较松的那条：min(单件利润 ¥20, 15% × 成交收入)。收入同一件商品同一个成交价，所以两个规格一样。
  const line = Math.round(Math.min(policy.minimumUnitProfitRmb, policy.targetMarginRate * roomy.revenueCny) * 100) / 100;
  const roomyPoint = extraHandlingBreakPoint({ row: roomy, policy, currentRmb: 3 });
  const tightPoint = extraHandlingBreakPoint({ row: tight, policy, currentRmb: 3 });
  assert.equal(roomyPoint.thresholdRmb, line);
  assert.equal(roomyPoint.thresholdBasis, 'margin');
  // 用引擎自己那一把尺子往下取整到分，不另起一套四舍五入。
  assert.equal(roomyPoint.headroomRmb, roundDownCents(roomy.unitProfitRmb - line));
  assert.equal(roomyPoint.breakRmb, roundDownCents(3 + roomy.unitProfitRmb - line));
  assert.equal(tightPoint.breakRmb, roundDownCents(3 + tight.unitProfitRmb - line));
  // 余地宽的那个规格的答案必须明显比紧的那个大——这一句的全部意义就在这个差别上。
  assert.ok(roomyPoint.breakRmb > tightPoint.breakRmb + 10, `${roomyPoint.breakRmb} vs ${tightPoint.breakRmb}`);

  // 现在这笔费用换了，X 跟着它走：费用降 ¥3，利润升 ¥3，X 不动——它问的是「这笔钱能涨到多少」，不是「现在剩多少」。
  const zeroRows = tableFor(0, true).rows;
  const zeroTight = zeroRows.find(row => row.sourceSkuId === 'sku-8xl');
  assert.equal(Math.round((zeroTight.unitProfitRmb - tight.unitProfitRmb) * 100) / 100, 3);
  assert.equal(extraHandlingBreakPoint({ row: zeroTight, policy, currentRmb: 0 }).breakRmb, tightPoint.breakRmb);
});

test('门槛换了一条，「涨到 ¥X」就跟着换，不是一个写死的数', () => {
  const row = tableFor(3, false).rows.find(item => item.sourceSkuId === 'sku-8xl');
  const loose = costPolicyFromStoreRule(storeRule);
  // 把单件利润门槛压到利润率那条之下，较松的一条就换成了单件利润，答案跟着变。
  const byUnitProfit = { ...loose, minimumUnitProfitRmb: 5 };
  const before = extraHandlingBreakPoint({ row, policy: loose, currentRmb: 3 });
  const after = extraHandlingBreakPoint({ row, policy: byUnitProfit, currentRmb: 3 });
  assert.equal(before.thresholdBasis, 'margin');
  assert.equal(after.thresholdBasis, 'unit_profit');
  assert.equal(after.thresholdRmb, 5);
  assert.ok(after.breakRmb > before.breakRmb);

  // 两条都要到（thresholdPolicy: both）时取较严的那条，答案只会更小。
  const both = extraHandlingBreakPoint({ row, policy: { ...loose, thresholdPolicy: 'both' }, currentRmb: 3 });
  assert.ok(both.breakRmb <= before.breakRmb);

  // 已经在线下的规格没有「再涨多少」可言，这时候一个字都不说。
  assert.equal(extraHandlingBreakPoint({ row, policy: { ...loose, minimumUnitProfitRmb: 999, targetMarginRate: 0.99 }, currentRmb: 3 }), null);
  assert.equal(extraHandlingBreakPoint({ row: { ...row, unitProfitRmb: null }, policy: loose, currentRmb: 3 }), null);
  assert.equal(extraHandlingBreakPoint({ row, policy: loose, currentRmb: null }), null);
});

test('算利润那一步把这笔费用算到哪个数、签没签过字，都摆在记录里', () => {
  const candidate = { id: 'candidate:synthetic-extra-handling', dataRevision: 7, sourceCapture: { offerId: '943009939489' } };
  const estimate = { estimate: { costPolicy: costPolicyFromStoreRule(storeRule), fx } };
  const undeclaredReview = buildProfitStepReview({ candidate, draft, table: tableFor(0, false), estimate, builtAt: null });
  assert.deepEqual(undeclaredReview.extraHandlingFee, { appliedRmb: 0, declared: false });
  const declaredReview = buildProfitStepReview({ candidate, draft, table: tableFor(3.3, true), estimate, builtAt: null });
  assert.deepEqual(declaredReview.extraHandlingFee, { appliedRmb: 3.3, declared: true });

  // 每个规格和排队表的每一行都带着自己的那个答案，排队行的答案就是它自己那一行的。
  for (const spec of declaredReview.specifications) {
    assert.equal(spec.extraHandling.currentRmb, 3.3);
    assert.ok(spec.extraHandling.breakRmb > 3.3);
  }
  for (const row of declaredReview.queue) {
    const spec = declaredReview.specifications.find(item => row.sourceSkuIds.includes(item.sourceSkuId));
    assert.deepEqual(row.extraHandling, spec.extraHandling);
  }
});

test('页面那一小块整份来自服务端记录：声明过什么、还缺什么、一键确认的是哪一份', () => {
  const nothingSaid = buildExtraHandlingFeesStep(bCandidate({ packagingCostRmb: null }));
  assert.equal(nothingSaid.label, '每单额外操作费');
  assert.equal(nothingSaid.status, 'absent');
  assert.equal(nothingSaid.declared, false);
  assert.equal(nothingSaid.totalRmb, null);
  assert.equal(nothingSaid.headline, null);
  assert.equal(nothingSaid.gate.ready, false);
  assert.deepEqual(nothingSaid.nameSuggestions, ['包材', '拆单费', '合包费', '额外材料费']);

  const withDetail = buildExtraHandlingFeesStep(declared(TWO_LINES));
  assert.equal(withDetail.status, 'consistent');
  assert.equal(withDetail.declared, true);
  assert.equal(withDetail.totalRmb, 3.3);
  assert.deepEqual(withDetail.items, [{ name: '包材', amountRmb: 1.5 }, { name: '拆单费', amountRmb: 1.8 }]);
  assert.equal(withDetail.declaredAt, DECLARED_AT);
  assert.equal(withDetail.headline, '每单额外操作费 ¥3.30：包材 ¥1.50 ＋ 拆单费 ¥1.80。');
  assert.equal(withDetail.gate.ready, true);

  const historical = buildExtraHandlingFeesStep(bCandidate({ packagingCostRmb: 1.5 }));
  assert.equal(historical.status, 'total_only');
  assert.equal(historical.declared, true);
  assert.deepEqual(historical.items, []);
  assert.match(historical.headline, /早先存下来的，没有留下它由哪几笔组成/u);
});
