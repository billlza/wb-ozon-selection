import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate1Service } from '../lib/gate1-service.mjs';
import { recordSkipReason } from '../lib/store-profile.mjs';
import { supplierDraftOrigins } from '../lib/supplier-draft.mjs';

// In-memory document and synthetic candidate only: no saved data, no platform, no extension.
const offer = (id, extra = {}) => ({ offerId: String(id), sourceUrl: `https://detail.1688.com/offer/${id}.html`, title: `合成货源 ${id}`,
  imageUrl: null, priceCny: 20, priceNote: '包邮', quantityBegin: 1, similarity: 'identical', distance: 0, ...extra });
const ozonItem = (id, extra = {}) => ({ productId: String(id), sourceUrl: `https://www.ozon.ru/product/${id}/`, title: `Синтетика ${id}`,
  imageUrl: null, priceRub: 1500, similarity: 'identical', distance: 0, ...extra });
const candidate = (extra = {}) => ({
  id: 'candidate:svc', targetStore: 'miska', workflowStatus: 'needs_user_data', dataRevision: 2, history: [],
  packedWeightKg: 0.4,
  ozonImageMatch: { captureId: 'OMJ-1', status: 'compared', results: [ozonItem(9001)], judgements: {} },
  supplierImageMatch: { captureId: 'IMJ-1', status: 'compared', results: [offer(7001)], judgements: {} },
  ...extra
});
const config = { profiles: { miska: { targetStore: 'miska', version: 'miska-synthetic-1' } } };
const rule = { pricingPolicyVersion: 'synthetic', minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either',
  advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };

function setup(current = candidate(), { storeConfig = config } = {}) {
  const document = { candidates: [current], rules: {}, runtime: {} };
  const history = [];
  const service = createGate1Service({
    readData: async () => structuredClone(document),
    mutateData: async mutator => mutator(document),
    now: () => '2026-10-10T05:00:00.000Z',
    estimateInputs: { assumptions: { packagingRmbDefault: 3 }, storeRule: () => rule,
      resolveExchangeRate: async () => ({ rubPerCny: 12.5, rateDate: '2026-10-09', sourceRef: 'synthetic-fx' }),
      resolveFreightRows: async () => ({ rows: [], ruleVersion: null }),
      resolveCommission: async () => ({ rate: 0.14, tier: 'synthetic', sourceRef: 'synthetic', gaps: [] }) },
    readDiscoveryMarketRecord: () => ({ status: 'no_discovery_evidence', product: null }),
    recordSkipReason, storeProfileConfig: storeConfig,
    addHistory: (target, actor, action, detail) => { history.push({ action, detail }); target.history.push({ action }); },
    publicCandidate: value => structuredClone(value),
    assertSafeCandidate: () => {},
    supplierDraftEstimate: async () => null
  });
  return { document, history, service };
}
const actor = { userId: 'owner-1' };

test('卡打开时给选项、软件先选的和粗算；缺尺寸就照实说算不了', async () => {
  const { document, service } = setup();
  const view = await service.view(document, document.candidates[0]);
  assert.equal(view.open, true);
  assert.equal(view.preselection.supplierOfferId, '7001');
  assert.equal(view.preselection.ozonProductId, '9001');
  assert.equal(view.packageFacts.weightBasis, 'declared');
  assert.deepEqual([...view.roughProfit.byPrice['9001'].estimate.missing], ['尺寸']);
});

test('做这件：方案、关口 1 记录和历史一起写，修订号加一；修订号不对就不写', async () => {
  const { document, history, service } = setup();
  await assert.rejects(() => service.accept({ candidateId: 'candidate:svc', actor,
    input: { dataRevision: 1, supplierOfferId: '7001' } }), error => error.code === 'revision_conflict');
  const result = await service.accept({ candidateId: 'candidate:svc', actor, input: { dataRevision: 2, ozonProductId: '9001',
    matchOfferId: '7001', supplierOfferId: '7001', facts: { dimensionsCm: { length: 30, width: 20, height: 10 } } } });
  const saved = document.candidates[0];
  assert.equal(saved.dataRevision, 3);
  assert.equal(saved.supplierDraftV1.sourceUrl, 'https://detail.1688.com/offer/7001.html');
  // 货价、运费、重量、售价是软件读的，只有长宽高是主人在卡上补的：方案逐项记着，不整份写成「主人声明」。
  assert.equal(saved.supplierDraftV1.provenance, 'owner_accepted_software_read');
  assert.deepEqual({ ...saved.supplierDraftV1.fieldSources }, { goodsPriceRmb: '1688_image_search', domesticShippingRmb: '1688_price_note',
    packedWeightKg: 'declared', dimensionsCm: 'owner', targetSalePriceRub: 'ozon_match' });
  const origins = supplierDraftOrigins(saved.supplierDraftV1);
  assert.deepEqual(Object.values(origins).filter(item => item.owner).map(item => item.field), ['dimensionsCm']);
  assert.equal(origins.goodsPriceRmb.label, '1688 搜图卡片上的价');
  assert.equal(saved.gate1DecisionV1.decision, 'accept');
  assert.equal(saved.gate1DecisionV1.decidedBy, 'owner-1');
  // 录入流水线看这个标记，在就不再替它补搜。
  assert.deepEqual([saved.gate1.decision, saved.gate1.record], ['accept', 'gate1DecisionV1']);
  assert.equal(saved.expectedPriceRub, 1500);
  assert.equal(result.decision.picks.supplier.tag, 'software');
  assert.deepEqual(history.map(item => item.action), ['gate1Accepted']);
  // 做过之后卡关上，再点一次不会再写一份。
  await assert.rejects(() => service.accept({ candidateId: 'candidate:svc', actor, input: { dataRevision: 3, supplierOfferId: '7001',
    facts: { dimensionsCm: { length: 30, width: 20, height: 10 } } } }), error => error.code === 'gate1_not_open');
});

test('做这件时带着卡上那句许可说明的版本，就一起存下软件接着做的许可；版本对不上就不收；不带就不发许可', async () => {
  const { GATE1_AUTOPILOT_SCOPE_VERSION, gate1AutopilotGrantCurrent } = await import('../lib/gate1-autopilot.mjs');
  const input = { dataRevision: 2, ozonProductId: '9001', supplierOfferId: '7001', facts: { dimensionsCm: { length: 30, width: 20, height: 10 } } };
  const stale = setup();
  await assert.rejects(() => stale.service.accept({ candidateId: 'candidate:svc', actor, input: { ...input, autopilot: 'gate1-autopilot-scope-v0' } }),
    error => error.code === 'gate1_autopilot_scope_stale');
  assert.equal(stale.document.candidates[0].dataRevision, 2);

  const { document, history, service } = setup();
  await service.accept({ candidateId: 'candidate:svc', actor, input: { ...input, autopilot: GATE1_AUTOPILOT_SCOPE_VERSION } });
  const saved = document.candidates[0];
  assert.equal(saved.gate1AutopilotGrantV1.via, 'gate1_accept');
  assert.equal(saved.gate1AutopilotGrantV1.grantedBy, 'owner-1');
  assert.equal(saved.gate1AutopilotGrantV1.gate1DecidedAt, saved.gate1DecisionV1.decidedAt);
  assert.equal(gate1AutopilotGrantCurrent(saved), true);
  assert.match(history[0].detail, /由软件接着做/u);

  const plain = setup();
  await plain.service.accept({ candidateId: 'candidate:svc', actor, input });
  assert.equal(plain.document.candidates[0].gate1AutopilotGrantV1, null);
});

test('卡上声明了品牌与权利：单独存一份，声明人是点「做这件」的主人，绑在这一次决定上；没声明就清掉上一轮的', async () => {
  const { GATE1_AUTOPILOT_SCOPE_VERSION } = await import('../lib/gate1-autopilot.mjs');
  const { gate1RightsDeclarationCurrent } = await import('../lib/gate1-rights-declaration.mjs');
  const input = { dataRevision: 2, ozonProductId: '9001', supplierOfferId: '7001', facts: { dimensionsCm: { length: 30, width: 20, height: 10 } },
    autopilot: GATE1_AUTOPILOT_SCOPE_VERSION };
  const rights = { brandStatus: 'branded', brandName: ' Miska ', rights: 'owned', validMonths: 6 };
  const bad = setup();
  await assert.rejects(() => bad.service.accept({ candidateId: 'candidate:svc', actor, input: { ...input, rights: { ...rights, brandName: '' } } }),
    error => error.code === 'gate1_rights_brand_name');
  await assert.rejects(() => bad.service.accept({ candidateId: 'candidate:svc', actor, input: { ...input, autopilot: undefined, rights } }),
    error => error.code === 'gate1_rights_without_autopilot');
  assert.equal(bad.document.candidates[0].dataRevision, 2, '被拒的不写');

  const { document, history, service } = setup();
  await service.accept({ candidateId: 'candidate:svc', actor, input: { ...input, rights } });
  const saved = document.candidates[0];
  const declaration = saved.gate1RightsDeclarationV1;
  assert.equal(declaration.declaredByUserId, 'owner-1');
  assert.equal(declaration.gate1DecidedAt, saved.gate1DecisionV1.decidedAt);
  assert.equal(declaration.declaredAt, saved.gate1DecisionV1.decidedAt);
  assert.deepEqual(declaration.brand, { status: 'branded', name: 'Miska' });
  assert.deepEqual(declaration.rights, { status: 'verified', basis: 'owned' });
  assert.equal(gate1RightsDeclarationCurrent(saved, declaration.declaredAt), declaration);
  assert.equal(saved.gate1DecisionV1.ownerSupplyConfirmed, false, '声明品牌与权利不等于确认供货');
  assert.match(history[0].detail, /主人在卡上声明了品牌与权利：有品牌「Miska」，我拥有所需权利，6 个月内有效/u);

  const plain = setup();
  plain.document.candidates[0].gate1RightsDeclarationV1 = { schemaVersion: 'gate1-rights-declaration-v1', candidateId: 'candidate:svc' };
  await plain.service.accept({ candidateId: 'candidate:svc', actor, input });
  assert.equal(plain.document.candidates[0].gate1RightsDeclarationV1, null);
});

test('不做这件：原因记进店铺档案，商品退出正常处理，可以恢复', async () => {
  const { document, history, service } = setup();
  await service.skip({ candidateId: 'candidate:svc', actor, input: { dataRevision: 2, reason: 'too_large', note: '太占地方' } });
  const saved = document.candidates[0];
  assert.equal(saved.workflowStatus, 'eliminated');
  assert.equal(saved.eliminatedFromStatus, 'needs_user_data');
  assert.equal(saved.eliminationReason, '主人不做：尺寸太大');
  assert.equal(saved.gate1.decision, 'skip');
  const skips = Object.values(document.runtime.storeSkipReasons);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].reason, 'too_large');
  assert.equal(skips[0].profileVersion, 'miska-synthetic-1');
  assert.equal(saved.gate1DecisionV1.storeSkipRecordId, skips[0].skipId);
  assert.match(history[0].detail, /原因已记进店铺档案/u);
});

test('没有店铺档案的店也能不做，只是照实说原因没进档案', async () => {
  const { document, history, service } = setup(candidate({ targetStore: 'wb' }));
  await service.skip({ candidateId: 'candidate:svc', actor, input: { dataRevision: 2, reason: 'brand_risk' } });
  assert.equal(document.candidates[0].workflowStatus, 'eliminated');
  assert.equal(document.candidates[0].gate1DecisionV1.storeSkipRecordId, null);
  assert.match(history[0].detail, /还没有店铺档案/u);
});

test('利润没过线之后：只有等主人决定时能选；改售价重开卡，不做就记原因', async () => {
  const shortfall = { schemaVersion: 'gate1-shortfall-v1', shortfallRmb: 9.6, unitProfitRmb: 8.4, resolvedAt: null, choices: ['change_supplier', 'change_price', 'skip'] };
  const pending = () => candidate({ gate1DecisionV1: { decision: 'accept', picks: {} }, gate1ShortfallV1: { ...shortfall },
    supplierDraftV1: { targetSalePriceRub: 1500 }, lifecycleV11: { status: 'b_rejected' } });
  const none = setup();
  await assert.rejects(() => none.service.shortfall({ candidateId: 'candidate:svc', actor, input: { dataRevision: 2, choice: 'change_price' } }),
    error => error.code === 'gate1_shortfall_not_pending');
  const price = setup(pending());
  await price.service.shortfall({ candidateId: 'candidate:svc', actor, input: { dataRevision: 2, choice: 'change_price' } });
  const reopened = price.document.candidates[0];
  assert.equal(reopened.gate1ReopenV1.choice, 'change_price');
  assert.equal(reopened.gate1RoundsV1.length, 1);
  assert.equal(reopened.lifecycleV11, undefined);
  const view = await price.service.view(price.document, reopened);
  assert.equal(view.open, true);
  assert.equal(view.reopen.previousTargetSalePriceRub, 1500);
  const drop = setup(pending());
  await drop.service.shortfall({ candidateId: 'candidate:svc', actor, input: { dataRevision: 2, choice: 'skip' } });
  assert.equal(drop.document.candidates[0].workflowStatus, 'eliminated');
  assert.equal(drop.document.candidates[0].gate1ShortfallV1.resolution, 'skip');
  assert.equal(Object.values(drop.document.runtime.storeSkipReasons)[0].reason, 'thin_profit');
});
