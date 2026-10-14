import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicBoxCandidate } from './helpers/legacy-candidate-fixture.mjs';
import { currentCostRule } from './fixtures/real-a-b-flow-fixture.mjs';
import { readGuooTariffCatalog, DEFAULT_GUOO_TARIFF_PATH } from '../lib/guoo-tariff-reader.mjs';
import { compareGuooRoutes } from '../lib/guoo-route-comparison.mjs';
import { runRealAConfirmationWithSystemEvidence } from '../lib/real-a-b-evidence-orchestration.mjs';
import {
  CARGO_FACT_KEYS, buildCargoFactsStep, buildOwnerCargoFactsRecord, cargoFactsGate, cargoFactsSentence,
  proposeCargoFacts, readDeclaredCargoFacts, validateOwnerCargoFactsDeclaration
} from '../lib/cargo-facts-declaration.mjs';

/**
 * 运输属性 — what the software may propose from the capture it holds, what the owner has to answer himself, and what
 * the declaration changes downstream. The route rules the last group is checked against are the project's own saved
 * GUOO workbook, not a paraphrase of it, so a declaration that passes here is one the real comparison accepts.
 */

const DECLARED_AT = '2026-09-13T02:00:00.000Z';
const FULL_FACTS = Object.freeze({
  batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true, irregularShape: false
});

/** 一件真实形状的雨衣：采到的类别、材质、品牌「无」，一件起订的报价，和主人填的打包盒子。 */
function raincoat(changes = candidate => candidate) {
  const candidate = {
    id: 'candidate:raincoat',
    dataRevision: 7,
    supplierDraftV1: { dimensionsCm: { length: 25, width: 22, height: 2.5 } },
    sourceCapture: {
      offerId: '943009939489',
      status: 'captured_waiting_owner_selection',
      title: '跨境中大型犬边牧拉布拉多柴犬四脚衣冲锋衣防水防风狗狗衣服雨衣',
      supplierAttributes: { 材质: '涤纶', 产品类别: '雨衣', 品牌: '无' },
      priceRanges: [{ minimumQuantity: 1, priceCny: 20.5, source: 'tradeModel.offerPriceModel.currentPrices' }],
      skuChoices: [{ sourceSkuId: 'sku-xl-yellow', attributes: { 颜色: '黄色', 尺码: 'XL' } }]
    }
  };
  changes(candidate);
  return candidate;
}

const fieldsOf = list => list.map(item => item.field).sort();
const undecidedFor = (result, field) => result.undecided.find(item => item.field === field) ?? null;

test('雨衣这一类，软件按它真读到的东西提议不带电、普货、个人自用、非异形，并把依据一起说出来', () => {
  const result = proposeCargoFacts(raincoat());

  assert.deepEqual(result.proposal, FULL_FACTS);
  assert.deepEqual(result.undecided, []);
  assert.equal(result.headline, '这件是普货、不带电、不是异形件，按个人自用一单一件发出。');
  assert.deepEqual(fieldsOf(result.basis), ['batteryType', 'generalCargo', 'irregularShape', 'personalUse']);

  // 依据必须说清楚读了哪些地方，而不是只给一个结论。
  const battery = result.basis.find(item => item.field === 'batteryType');
  assert.equal(battery.because,
    '依据采到的类别「雨衣」、全部 3 项属性、1 个规格自己的属性、商品标题里没有出现电池／锂电／充电／发热／USB／电动／遥控这类字样。');
  assert.match(result.basis.find(item => item.field === 'personalUse').because, /起订量 1 件/u);
  assert.match(result.basis.find(item => item.field === 'irregularShape').because, /25×22×2\.5 厘米/u);

  // 提议永远不给电池瓦时：说了不带电就不能再有瓦时，这是线路比较自己的冲突规则。
  assert.equal(result.proposal.batteryEnergyWh, null);
});

test('属性或标题里出现电池、充电、发热这类词时，软件不提议不带电，也不提议普货，并说出它在哪里读到的', () => {
  const powered = raincoat(candidate => {
    candidate.sourceCapture.title = 'USB充电暖手宝迷你便携';
    candidate.sourceCapture.supplierAttributes = { 材质: '塑料', 产品类别: '暖手宝', 电池容量: '2000mAh', 品牌: '无' };
  });
  const result = proposeCargoFacts(powered);

  assert.equal(result.proposal.batteryType, null);
  assert.equal(result.proposal.generalCargo, null);
  assert.equal(result.headline, null);
  assert.deepEqual(fieldsOf(result.undecided), ['batteryType', 'generalCargo']);
  assert.match(undecidedFor(result, 'batteryType').why, /写着「充电」/u);
  assert.match(undecidedFor(result, 'batteryType').why, /你来选/u);
  assert.deepEqual(fieldsOf(result.basis), ['irregularShape', 'personalUse']);

  // 一个个词都要能挡住，包括只出现在规格属性里的。
  for (const [where, apply] of [
    ['标题', candidate => { candidate.sourceCapture.title = '锂电池驱蚊手环'; }],
    ['属性', candidate => { candidate.sourceCapture.supplierAttributes.功能 = '发热护膝'; }],
    ['规格', candidate => { candidate.sourceCapture.skuChoices[0].attributes.类型 = '遥控款'; }],
    ['市场类目', candidate => { candidate.salesSnapshotsV11 = []; candidate.sourceCapture.supplierAttributes.描述 = '内置马达'; }]
  ]) {
    const one = proposeCargoFacts(raincoat(apply));
    assert.equal(one.proposal.batteryType, null, where);
    assert.equal(one.proposal.generalCargo, null, where);
  }
});

test('带磁、刀具这类非普货的词只挡普货；品牌栏写了牌子时仿牌风险同样让软件闭嘴', () => {
  const magnetic = proposeCargoFacts(raincoat(candidate => { candidate.sourceCapture.supplierAttributes.工艺 = '磁吸扣'; }));
  assert.equal(magnetic.proposal.batteryType, 'none');
  assert.equal(magnetic.proposal.generalCargo, null);
  assert.match(undecidedFor(magnetic, 'generalCargo').why, /磁吸/u);

  const branded = proposeCargoFacts(raincoat(candidate => { candidate.sourceCapture.supplierAttributes.品牌 = '阿迪达斯'; }));
  assert.equal(branded.proposal.batteryType, 'none');
  assert.equal(branded.proposal.generalCargo, null);
  assert.match(undecidedFor(branded, 'generalCargo').why, /品牌」写的是「阿迪达斯」/u);
  assert.match(undecidedFor(branded, 'generalCargo').why, /仿牌/u);

  // 「无」「其他」「OEM」这些等于没写牌子，不该把一件普通货挡住。
  for (const value of ['无', '无品牌', '其他', 'OEM', 'oem']) {
    const none = proposeCargoFacts(raincoat(candidate => { candidate.sourceCapture.supplierAttributes.品牌 = value; }));
    assert.equal(none.proposal.generalCargo, true, value);
  }
});

test('词表按整词匹配拉丁字母，颜色「White」不会被当成瓦时，「LED灯」仍然算命中', () => {
  const white = proposeCargoFacts(raincoat(candidate => {
    candidate.sourceCapture.skuChoices[0].attributes.颜色 = 'White';
  }));
  assert.equal(white.proposal.batteryType, 'none');

  const led = proposeCargoFacts(raincoat(candidate => { candidate.sourceCapture.supplierAttributes.配件 = 'LED灯条'; }));
  assert.equal(led.proposal.batteryType, null);
});

test('没有采集证据时一项也不提议；缺打包尺寸或缺一件起订的报价时，只有对应那一项判不定', () => {
  const empty = proposeCargoFacts({ id: 'candidate:empty', dataRevision: 0 });
  assert.deepEqual(empty.proposal,
    { batteryType: null, batteryEnergyWh: null, generalCargo: null, personalUse: null, irregularShape: null });
  assert.deepEqual(empty.basis, []);
  assert.deepEqual(fieldsOf(empty.undecided), ['batteryType', 'generalCargo', 'irregularShape', 'personalUse']);
  assert.match(empty.undecided[0].why, /还没有采到属性和标题/u);

  const noBox = proposeCargoFacts(raincoat(candidate => { delete candidate.supplierDraftV1; }));
  assert.equal(noBox.proposal.irregularShape, null);
  assert.equal(noBox.proposal.generalCargo, true);
  assert.match(undecidedFor(noBox, 'irregularShape').why, /还没有填打包的长宽高/u);

  const noQuote = proposeCargoFacts(raincoat(candidate => { candidate.sourceCapture.priceRanges = []; }));
  assert.equal(noQuote.proposal.personalUse, null);
  assert.equal(noQuote.proposal.irregularShape, false);
  assert.match(undecidedFor(noQuote, 'personalUse').why, /一件起订/u);
});

test('服务端第二次校验按线路比较自己的形状和冲突规则拒绝，并说出拒的是哪一条', () => {
  assert.equal(validateOwnerCargoFactsDeclaration({ ...FULL_FACTS }).valid, true);

  const conflict = validateOwnerCargoFactsDeclaration({ ...FULL_FACTS, batteryType: 'installed' });
  assert.equal(conflict.valid, false);
  assert.deepEqual(conflict.errors.map(item => item.field), ['generalCargo']);
  assert.match(conflict.errors[0].message, /普货和带电不能同时成立/u);
  assert.equal(validateOwnerCargoFactsDeclaration({ ...FULL_FACTS, batteryType: 'standalone' }).valid, false);

  const energy = validateOwnerCargoFactsDeclaration({ ...FULL_FACTS, batteryEnergyWh: 100 });
  assert.equal(energy.valid, false);
  assert.deepEqual(energy.errors.map(item => item.field), ['batteryEnergyWh']);
  assert.match(energy.errors[0].message, /不带电，就不能同时填电池瓦时/u);

  // 带电而不是普货是合法的；这一组必须放行，否则真的带电商品就没法声明了。
  assert.equal(validateOwnerCargoFactsDeclaration(
    { batteryType: 'installed', batteryEnergyWh: 96, generalCargo: false, personalUse: true, irregularShape: false }).valid, true);

  for (const broken of [
    { ...FULL_FACTS, batteryType: 'maybe' },
    { ...FULL_FACTS, batteryType: null },
    { ...FULL_FACTS, generalCargo: 'true' },
    { ...FULL_FACTS, personalUse: 1 },
    { ...FULL_FACTS, irregularShape: 'no' },
    { ...FULL_FACTS, batteryType: 'installed', generalCargo: null, batteryEnergyWh: 0 },
    { ...FULL_FACTS, batteryType: 'installed', generalCargo: null, batteryEnergyWh: -5 },
    { ...FULL_FACTS, sourceRef: 'owner' },
    { batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true },
    null, [], 'none'
  ]) {
    const result = validateOwnerCargoFactsDeclaration(broken);
    assert.equal(result.valid, false, JSON.stringify(broken));
    assert.ok(result.errors.length > 0);
  }
});

test('存下来的记录写明是主人确认的、软件依据什么提议的，来源能追回这一次声明', () => {
  const candidate = raincoat();
  const record = buildOwnerCargoFactsRecord({ candidate, facts: { ...FULL_FACTS }, declaredAt: DECLARED_AT });

  assert.equal(record.schemaVersion, 'candidate-cargo-facts-v1');
  assert.equal(record.declaredBy, 'owner');
  assert.equal(record.declaredAt, DECLARED_AT);
  assert.equal(record.declaredRevision, 7);
  assert.equal(record.headline, '这件是普货、不带电、不是异形件，按个人自用一单一件发出。');
  assert.equal(record.matchesProposal, true);
  // 来源写着候选 id、修订号和时间，三样都能追回这一次声明本身。
  assert.equal(record.facts.sourceRef, `owner-cargo-facts:candidate:raincoat:7:${DECLARED_AT}`);
  assert.deepEqual(Object.keys(record.facts).sort(), [...CARGO_FACT_KEYS, 'sourceRef'].sort());
  // 软件当初的依据整份存下来，日后能看出主人是照着什么签的。
  assert.deepEqual(fieldsOf(record.basis), ['batteryType', 'generalCargo', 'irregularShape', 'personalUse']);
  assert.match(record.basis.find(item => item.field === 'batteryType').because, /采到的类别「雨衣」/u);
  assert.deepEqual(record.proposal, FULL_FACTS);

  // 主人改掉其中一项时，记录如实说它和提议不一样。
  const changed = buildOwnerCargoFactsRecord({
    candidate, facts: { ...FULL_FACTS, irregularShape: true }, declaredAt: DECLARED_AT
  });
  assert.equal(changed.matchesProposal, false);
  assert.equal(changed.facts.irregularShape, true);
  assert.deepEqual(changed.proposal, FULL_FACTS);
  assert.match(changed.headline, /是异形件/u);

  assert.throws(() => buildOwnerCargoFactsRecord({ candidate, facts: { ...FULL_FACTS, batteryType: 'installed' }, declaredAt: DECLARED_AT }),
    /CARGO_FACTS_INVALID/u);
  assert.throws(() => buildOwnerCargoFactsRecord({ candidate, facts: { ...FULL_FACTS }, declaredAt: 'not-a-time' }),
    /CARGO_FACTS_DECLARED_AT_INVALID/u);
});

test('没有声明就读出 null；读出来的永远是线路比较认的那六个字段；记录坏了要报出来而不是默默阻断', () => {
  assert.equal(readDeclaredCargoFacts(raincoat()), null);
  assert.equal(readDeclaredCargoFacts({}), null);
  assert.equal(readDeclaredCargoFacts(undefined), null);

  const candidate = raincoat();
  candidate.cargoFactsV1 = buildOwnerCargoFactsRecord({ candidate, facts: { ...FULL_FACTS }, declaredAt: DECLARED_AT });
  const facts = readDeclaredCargoFacts(candidate);
  assert.deepEqual(Object.keys(facts).sort(), [...CARGO_FACT_KEYS, 'sourceRef'].sort());
  assert.deepEqual(facts, { ...FULL_FACTS, sourceRef: `owner-cargo-facts:candidate:raincoat:7:${DECLARED_AT}` });

  for (const damage of [
    record => { record.schemaVersion = 'something-else'; },
    record => { delete record.facts; },
    record => { record.facts.sourceRef = ''; },
    record => { record.facts.batteryType = 'maybe'; },
    record => { record.facts.generalCargo = 'true'; }
  ]) {
    const broken = raincoat();
    broken.cargoFactsV1 = buildOwnerCargoFactsRecord({ candidate: broken, facts: { ...FULL_FACTS }, declaredAt: DECLARED_AT });
    damage(broken.cargoFactsV1);
    assert.throws(() => readDeclaredCargoFacts(broken), /CARGO_FACTS_RECORD_INVALID/u);
  }
});

test('没确认、或确认里还留着「说不准」，这一步就说得出为什么还不能算利润', () => {
  assert.equal(cargoFactsGate(null).ready, false);
  assert.match(cargoFactsGate(null).reason, /还没有确认这件商品的运输属性/u);

  const candidate = raincoat();
  const complete = buildOwnerCargoFactsRecord({ candidate, facts: { ...FULL_FACTS }, declaredAt: DECLARED_AT });
  assert.deepEqual(cargoFactsGate(complete), { ready: true, reason: '' });

  for (const [facts, expected] of [
    [{ ...FULL_FACTS, batteryType: 'unknown' }, /带不带电/u],
    [{ ...FULL_FACTS, generalCargo: null }, /是不是普货/u],
    [{ ...FULL_FACTS, personalUse: null }, /个人自用还是商业用/u],
    [{ ...FULL_FACTS, irregularShape: null }, /是不是异形件/u],
    [{ batteryType: 'installed', batteryEnergyWh: null, generalCargo: false, personalUse: true, irregularShape: false }, /电池瓦时/u]
  ]) {
    const gate = cargoFactsGate(buildOwnerCargoFactsRecord({ candidate, facts, declaredAt: DECLARED_AT }));
    assert.equal(gate.ready, false, JSON.stringify(facts));
    assert.match(gate.reason, expected);
  }
});

test('这一小块交给页面的东西：提议、依据、判不定的那几项、五个可改的字段，和为什么现在还不能确认', () => {
  const fresh = buildCargoFactsStep(raincoat());
  assert.equal(fresh.schemaVersion, 'cargo-facts-step-v1');
  assert.equal(fresh.declared, false);
  assert.equal(fresh.declaration, null);
  assert.deepEqual(fresh.proposal, FULL_FACTS);
  assert.equal(fresh.headline, '这件是普货、不带电、不是异形件，按个人自用一单一件发出。');
  assert.equal(fresh.gate.ready, false);
  assert.deepEqual(fresh.fields.map(item => item.field), [...CARGO_FACT_KEYS]);
  assert.equal(fresh.fields.find(item => item.field === 'batteryEnergyWh').options, null);
  assert.deepEqual(fresh.fields.find(item => item.field === 'batteryType').options.map(item => item.value),
    ['none', 'installed', 'standalone', 'unknown']);

  const candidate = raincoat();
  candidate.cargoFactsV1 = buildOwnerCargoFactsRecord({ candidate, facts: { ...FULL_FACTS }, declaredAt: DECLARED_AT });
  const saved = buildCargoFactsStep(candidate);
  assert.equal(saved.declared, true);
  assert.equal(saved.declaration.headline, '这件是普货、不带电、不是异形件，按个人自用一单一件发出。');
  assert.equal(saved.declaration.declaredAt, DECLARED_AT);
  assert.equal(saved.declaration.matchesProposal, true);
  assert.deepEqual(fieldsOf(saved.declaration.basis), ['batteryType', 'generalCargo', 'irregularShape', 'personalUse']);
  assert.equal(saved.gate.ready, true);

  assert.equal(cargoFactsSentence({ batteryType: 'unknown', batteryEnergyWh: null, generalCargo: null, personalUse: null, irregularShape: null }),
    '这件是不是普货说不准、带不带电说不准、是不是异形件说不准，个人自用还是商业用说不准。');
});

test('对着项目自己那份GUOO表：声明之后经济超级轻小件判成 eligible 且 transportVerified 为真，没有声明时照旧全线不适用', async () => {
  const catalog = await readGuooTariffCatalog({});
  const request = cargoFacts => ({
    candidateId: 'candidate:raincoat',
    sourceRevision: 7,
    // 0.24 公斤、1400 卢布：表里 0.001-0.5KG、1-1500₽ 那三条线（10、11、12 行）才收得下这件货。
    packaging: { weightKg: 0.24, dimensionsCm: { length: 25, width: 22, height: 2.5 }, sourceRef: 'evidence:raincoat-packaging' },
    salePrice: { amountRub: 1400, sourceRef: 'evidence:raincoat-target-sale' },
    cargoFacts,
    catalog
  });

  const declared = compareGuooRoutes(request({ ...FULL_FACTS, sourceRef: `owner-cargo-facts:candidate:raincoat:7:${DECLARED_AT}` }));
  const economyExtraSmall = declared.routes.find(route => route.route === 'GUOO Economy Extra Small');
  assert.equal(economyExtraSmall.rowNumber, 12);
  assert.equal(economyExtraSmall.eligibility, 'eligible');
  assert.deepEqual(economyExtraSmall.reasons, []);
  assert.equal(declared.status, 'compared');
  assert.equal(declared.selectedRoute, 'GUOO Economy Extra Small');
  assert.equal(declared.selectedRouteLabel, '经济超级轻小件');
  assert.equal(declared.transportVerified, true);

  // 同一件货、同一张表，没有声明就还是今天线上撞到的那个样子：运费照样算得出来，最便宜的线路族也照样指得出来，
  // 但每条线都判不出「收不收这件货」，所以运输核验不通过，正式B不放行。
  const undeclared = compareGuooRoutes(request(null));
  assert.equal(undeclared.transportVerified, false);
  assert.equal(undeclared.status, 'compared');
  assert.equal(undeclared.selectedRoute, 'GUOO Economy Extra Small');
  assert.equal(undeclared.routes.find(route => route.route === 'GUOO Economy Extra Small').eligibility, 'unknown');
  assert.ok(undeclared.routes.every(route => route.eligibility !== 'eligible'));
  assert.ok(undeclared.routes.find(route => route.route === 'GUOO Economy Extra Small')
    .reasons.some(reason => reason.code === 'CARGO_RULE_UNRESOLVED'));
  // 一模一样的两次比较，只差主人的那一次声明：运费没有变，变的只有运输核验这一项。
  assert.equal(undeclared.routes.find(route => route.rowNumber === 12).totalFreightRmb,
    economyExtraSmall.totalFreightRmb);
});

/** 音乐盒那份候选，接 A 确认编排用：0.4 公斤、2000 卢布，落在表里 0.001-2KG、1501-7000₽ 那三条线上。 */
function orchestrationCandidate(declaration = null) {
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  candidate.workflowStatus = 'codex_processing';
  candidate.listingHandoff = null;
  candidate.lifecycleEvidenceContextV11 = { ...candidate.lifecycleEvidenceContextV11, salesScheme: 'rfbs' };
  if (declaration !== null) candidate.cargoFactsV1 = declaration;
  return candidate;
}

function orchestrationSubmission(candidate) {
  return {
    dataRevision: candidate.dataRevision, sourceCandidateId: candidate.id, sourceDataRevision: candidate.dataRevision,
    targetPlatform: 'ozon', storeRef: structuredClone(candidate.storeRef), decision: 'confirm', targetSalePriceRub: 2000,
    salesReview: {
      snapshotId: candidate.salesSnapshotsV11[0].snapshotId,
      comparability: 'comparable', validityStatus: 'current', confidence: 'limited'
    },
    supplierConfirmation: {
      productUrl: 'https://detail.1688.com/offer/876240928352.html',
      supplierSkuId: 'SKU-SEWING-MACHINE-01', variantKey: '手摇缝纫机音乐盒',
      unitProductPrice: 15.3, unitDomesticFreight: 2, otherPurchaseCosts: 0, actualPurchaseCost: 17.3,
      weightKg: 0.4, dimensionsCm: { length: 12, width: 12, height: 7 }, ownerSupplyConfirmed: true
    }
  };
}

test('A确认编排把主人已确认的声明原样传进线路比较，运输核验因此通过，缺证的地方才往后移', async () => {
  const plain = orchestrationCandidate();
  const declaration = buildOwnerCargoFactsRecord({ candidate: plain, facts: { ...FULL_FACTS }, declaredAt: DECLARED_AT });
  const candidate = orchestrationCandidate(declaration);
  const before = structuredClone(candidate);

  const run = await runRealAConfirmationWithSystemEvidence({
    candidate, profitRule: currentCostRule(candidate), submission: orchestrationSubmission(candidate),
    providers: {}, confirmedAt: '2026-09-13T03:00:00.000Z', guooFilePath: DEFAULT_GUOO_TARIFF_PATH
  });

  assert.deepEqual(run.guooRouteComparison.inputSnapshot.cargoFacts, {
    ...FULL_FACTS, sourceRef: declaration.facts.sourceRef
  });
  assert.match(run.guooRouteComparison.inputSnapshot.cargoFacts.sourceRef, /^owner-cargo-facts:/u);
  assert.equal(run.guooRouteComparison.status, 'compared');
  assert.equal(run.guooRouteComparison.transportVerified, true);
  assert.equal(run.guooRouteComparison.selectedRoute, 'GUOO Economy Small');
  // 这一轮已经过了线路这道闸，停在后面没有配置的只读提供器上——不再是运输属性挡着。
  assert.equal(run.evidencePreparation.failure.layer, 'provider:commission');
  assert.equal(run.platformWrites, 0);
  assert.deepEqual(candidate, before);
});

test('没有声明时编排的行为与今天完全一致：cargoFacts 仍为 null，仍在线路这一层停住，并说清楚缺的是运输属性', async () => {
  const candidate = orchestrationCandidate();
  const before = structuredClone(candidate);

  const run = await runRealAConfirmationWithSystemEvidence({
    candidate, profitRule: currentCostRule(candidate), submission: orchestrationSubmission(candidate),
    providers: {}, confirmedAt: '2026-09-13T03:00:00.000Z', guooFilePath: DEFAULT_GUOO_TARIFF_PATH
  });

  assert.equal(run.status, 'blocked');
  assert.equal(run.guooRouteComparison.inputSnapshot.cargoFacts, null);
  assert.equal(run.guooRouteComparison.transportVerified, false);
  assert.equal(run.evidencePreparation.failure.layer, 'guoo_route_comparison');
  assert.match(run.evidencePreparation.failure.reason, /运输属性还没有你的确认/u);
  assert.equal(run.result, null);
  assert.deepEqual(run.evidencePacksToCommit, []);
  assert.equal(run.platformWrites, 0);
  assert.deepEqual(candidate, before);

  // 存着的声明坏了就报出来，不会悄悄按「没有声明」继续走。
  const damaged = orchestrationCandidate({ schemaVersion: 'candidate-cargo-facts-v1', facts: { batteryType: 'maybe' } });
  await assert.rejects(runRealAConfirmationWithSystemEvidence({
    candidate: damaged, profitRule: currentCostRule(damaged), submission: orchestrationSubmission(damaged),
    providers: {}, confirmedAt: '2026-09-13T03:00:00.000Z', guooFilePath: DEFAULT_GUOO_TARIFF_PATH
  }), /CARGO_FACTS_RECORD_INVALID/u);
});
