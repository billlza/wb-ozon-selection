import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeerfarDiscoveryRuntimeFixture } from './fixtures/seerfar-discovery-runtime-fixture.mjs';
import { createADiscoveryEstimateUseCase, createADiscoveryEstimateInputs, readADiscoveryEstimates, readADiscoveryEstimateOutcome,
  attachADiscoveryEstimates, typeZhFromCategoryPath, aDiscoveryEstimateKey } from '../lib/a-discovery-estimate-store.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';

// Everything below is synthetic: injected fake readers, synthetic products, synthetic tariff rows. No catalogs, no network.
const RUB_PER_CNY = 12.7373;
const SHA = 'ab'.repeat(32);
const storeRule = { storeName: 'Synthetic', pricingPolicyVersion: 'synthetic-policy-1', minimumUnitProfitRmb: 20, targetMarginRate: 0.15,
  thresholdPolicy: 'either', advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05,
  withdrawalFeeRate: 0.02, labelCostRmb: 1.5, fixedOtherRmb: 0 };
const rules = { ozonMiska: storeRule, ozonDandanshu: storeRule };
const REFERENCE = { catalogPath: '/synthetic/ozon-commission.json', sellerRegion: 'CN',
  versionState: { fileSha256: SHA, effectiveFrom: '2025-12-01', status: 'active' } };
const row = (route, chargeableWeightRule, perKgRmb, perParcelRmb, weightLimit, sizeLimit) => ({ route, evidenceData: { chargeableWeightRule,
  perKgRmb, perParcelRmb, minimumChargeableWeightKg: 0, weightLimit, sizeLimit,
  ...(chargeableWeightRule === 'max_actual_volume' ? { volumeDivisorCm3PerKg: 12000 } : {}) } });
const TARIFF_ROWS = [
  row('GUOO Economy Small', 'actual_weight', 28.1, 17.97, '0.001-2KG', '尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重'),
  row('GUOO Economy Big', 'max_actual_volume', 19.1, 40.44, '2.001-30KG\n收抛', '尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM')
];
const category = { fullCategoryId: ['100_200'], titlePath: 'Товары для животных > Лежанки', cnTitlePath: '宠物用品 > 宠物躺床', enTitlePath: 'Pet > Beds' };
const product = (sku, price, extra = {}) => ({ sku, title: `Explicitly synthetic ${sku}`, productUrl: `https://www.ozon.ru/product/${sku}`,
  imageUrl: 'https://images.example.test/synthetic.png', price, sales: 2, ...extra });
const SELECTABLE = '2107989735', NEGATIVE = '2107989736', INCOMPLETE = '2107989737';
const PRODUCTS = [
  product(Number(SELECTABLE), 9000, { weight: 700, dimension: '300x250x100', categoryInfo: category }),
  product(Number(NEGATIVE), 1835, { weight: 2500, dimension: '1000x600x190', categoryInfo: category }),
  product(Number(INCOMPLETE), 500)
];
const FX_PACK = { id: 'evidence:synthetic-fx', kind: 'exchange_rate', status: 'active', scope: { pair: 'RUB/CNY' },
  sourceRef: 'cbr-xml-daily:R01375:2026-09-08', sourceType: 'bank_of_russia_official_daily_xml',
  checkedAt: '2026-09-09T00:00:00.000Z', expiresAt: '2026-09-10T00:00:00.000Z',
  evidenceData: { rubPerCny: RUB_PER_CNY, rateDate: '2026-09-08', nominal: 1, officialValueRub: RUB_PER_CNY } };

function fakeReaders({ commissionRate = 0.14, fxFails = false } = {}) {
  const calls = { commission: 0, fx: 0, tariff: 0, scopes: [], tariffPaths: [] };
  return { calls,
    commission: async ({ scope, versionState, catalogPath }) => {
      calls.commission += 1; calls.scopes.push({ ...scope, catalogPath, versionState });
      return { commissionRate, priceTier: scope.priceRub <= 1500 ? 'le1500' : scope.priceRub <= 5000 ? '1500_5000' : 'gt5000',
        source: { effectiveFrom: '2025-12-01', fileSha256: SHA }, matchedRows: [], gaps: [] };
    },
    fx: async () => {
      calls.fx += 1;
      if (fxFails) throw new Error('SYNTHETIC_FX_OUTAGE');
      return { sourceRef: 'cbr-xml-daily:R01375:2026-09-09', evidenceData: { rubPerCny: RUB_PER_CNY, rateDate: '2026-09-09' } };
    },
    tariff: async ({ filePath }) => { calls.tariff += 1; calls.tariffPaths.push(filePath); return { ruleVersion: 'guoo-synthetic', rows: TARIFF_ROWS }; } };
}

async function completedBatch(t, { products = PRODUCTS, savedFx = true, onSelectProduct = null } = {}) {
  const f = await createSeerfarDiscoveryRuntimeFixture(t, { products });
  const { service } = f.create(onSelectProduct === null ? {} : { onSelectProduct });
  const created = await f.prepare(service);
  await f.authorize(service, created);
  if (savedFx) {
    await f.repository.transact(document => { document.evidencePacks = [structuredClone(FX_PACK)]; return { changed: true, document, result: null }; });
  }
  const document = await f.repository.readSnapshot();
  const batch = document.runtime.aDiscoveryBatches[created.batch.batchId];
  return { ...f, service, created, batch, document, input: { batchId: batch.batchId, expectedRevision: batch.revision } };
}
const useCase = (f, readers, configuration = {}) => createADiscoveryEstimateUseCase({ repository: f.repository, serverClock: f.clock, rules,
  readers, configuration: { ozonCommissionReference: REFERENCE, guooTariffFile: '/synthetic/guoo-tariff.xlsx', packagingRmbDefault: 3, ...configuration } });
const savedRecords = async f => readADiscoveryEstimates(await f.repository.readSnapshot());
const recordFor = (records, f, id) => records[aDiscoveryEstimateKey({ batchId: f.batch.batchId, revision: f.batch.revision, productId: id })];

test('每件市场商品按官方输入估算一次，数字与来源一起落盘，回执字节不变', async t => {
  const f = await completedBatch(t);
  const readers = fakeReaders();
  const receiptsBefore = JSON.stringify(f.document.runtime.aDiscoveryReceipts);
  const result = await useCase(f, readers).estimateBatch({ actor: f.owner, input: f.input });
  assert.deepEqual({ estimated: result.estimated, negative: result.negative, needsData: result.needsData }, { estimated: 3, negative: 1, needsData: 1 });
  // A still-current saved official FX pack is reused; the reader is never called for a rate the project already has.
  assert.equal(readers.calls.fx, 0);
  assert.equal(result.inputs.fxSourceRef, FX_PACK.sourceRef);
  assert.equal(result.inputs.fxRateDate, '2026-09-08');
  assert.equal(result.inputs.tariffRuleVersion, 'guoo-synthetic');
  assert.equal(result.inputs.costPolicyVersion, 'synthetic-policy-1');
  assert.equal(result.inputs.packagingRmbDefault, 3);
  // One tariff read for the batch and one commission read per distinct type and price; the third product carries no category at all.
  assert.equal(readers.calls.tariff, 1);
  assert.deepEqual(readers.calls.tariffPaths, ['/synthetic/guoo-tariff.xlsx']);
  assert.equal(readers.calls.commission, 2);
  assert.deepEqual(readers.calls.scopes.map(scope => [scope.priceRub, scope.typeIdentity.typeZh, scope.salesScheme, scope.sellerRegion]),
    [[9000, '宠物躺床', 'rfbs', 'CN'], [1835, '宠物躺床', 'rfbs', 'CN']]);
  assert.deepEqual(readers.calls.scopes[0].versionState, REFERENCE.versionState);
  const records = await savedRecords(f);
  assert.deepEqual(Object.keys(records).sort(), [SELECTABLE, NEGATIVE, INCOMPLETE].sort()
    .map(id => `${f.batch.batchId}:${f.batch.revision}:${id}`).sort());
  const ok = recordFor(records, f, SELECTABLE), bad = recordFor(records, f, NEGATIVE), unknown = recordFor(records, f, INCOMPLETE);
  assert.equal(ok.schemaVersion, 'a-discovery-estimate-record-v1');
  assert.equal(ok.estimate.status, 'ok');
  assert.equal(ok.estimate.freight.chosen.route, 'GUOO Economy Small');
  assert.equal(ok.estimate.freight.chosen.freightRmb, 37.64);
  assert.equal(ok.estimate.freight.oversize, false);
  assert.ok(ok.estimate.ceiling.maximumAllInPurchaseRmb > 0);
  assert.equal(ok.inputs.commissionSourceRef, `ozon-official-commission:2025-12-01:sha256:${SHA}`);
  assert.equal(bad.estimate.status, 'negative');
  assert.equal(bad.estimate.freight.oversize, true);
  assert.ok(bad.estimate.ceiling.maximumAllInPurchaseRmb <= 0);
  assert.equal(unknown.estimate.status, 'incomplete');
  assert.deepEqual(unknown.estimate.missing, ['官方佣金', '包装尺寸重量']);
  assert.equal(unknown.inputs.commissionSourceRef, null);
  assert.equal(unknown.estimate.commission.gaps[0].code, 'CATEGORY_PATH_MISSING');
  // Estimates live beside the receipts; the saved provider receipt is untouched.
  assert.equal(JSON.stringify((await f.repository.readSnapshot()).runtime.aDiscoveryReceipts), receiptsBefore);
});

test('没有可用汇率证据包时才读官方汇率，一次调用覆盖整批', async t => {
  const f = await completedBatch(t, { savedFx: false });
  const readers = fakeReaders();
  const result = await useCase(f, readers).estimateBatch({ actor: f.owner, input: f.input });
  assert.equal(readers.calls.fx, 1);
  assert.equal(result.inputs.fxSourceRef, 'cbr-xml-daily:R01375:2026-09-09');
  assert.equal(result.inputs.fxRateDate, '2026-09-09');
  assert.equal(result.estimated, 3);
  const records = await savedRecords(f);
  assert.equal(recordFor(records, f, SELECTABLE).inputs.fxSourceRef, 'cbr-xml-daily:R01375:2026-09-09');
  // An unavailable official rate is a recorded gap, never an invented number.
  const outage = await completedBatch(t, { savedFx: false });
  const failing = fakeReaders({ fxFails: true });
  const blocked = await useCase(outage, failing).estimateBatch({ actor: outage.owner, input: outage.input });
  assert.deepEqual({ estimated: blocked.estimated, negative: blocked.negative, needsData: blocked.needsData }, { estimated: 3, negative: 0, needsData: 3 });
  assert.equal(blocked.inputs.fxSourceRef, null);
  const record = recordFor(await savedRecords(outage), outage, SELECTABLE);
  assert.ok(record.estimate.missing.includes('汇率'));
  assert.equal(record.estimate.revenueCny, null);
});

test('未配置官方佣金表时全部标记待补数据，不猜佣金率', async t => {
  const f = await completedBatch(t);
  const readers = fakeReaders();
  const result = await useCase(f, readers, { ozonCommissionReference: null }).estimateBatch({ actor: f.owner, input: f.input });
  assert.deepEqual({ estimated: result.estimated, negative: result.negative, needsData: result.needsData }, { estimated: 3, negative: 0, needsData: 3 });
  assert.equal(readers.calls.commission, 0);
  assert.equal(result.inputs.commissionSourceRef, null);
  const record = recordFor(await savedRecords(f), f, NEGATIVE);
  assert.equal(record.estimate.status, 'incomplete');
  assert.deepEqual(record.estimate.commission.gaps, [{ code: 'REFERENCE_NOT_CONFIGURED', field: 'configuration.ozonCommissionReference', blocking: true }]);
  assert.deepEqual(record.estimate.missing, ['官方佣金']);
  assert.equal(readADiscoveryEstimateOutcome(await f.repository.readSnapshot(),
    { batchId: f.batch.batchId, revision: f.batch.revision, productId: NEGATIVE }), 'needs_data');
});

test('预估负利润的商品退出可选池：选这个被拒绝，其他商品照常', async t => {
  const picked = [];
  const f = await completedBatch(t, { onSelectProduct: async input => { picked.push(input.marketProductId); return { status: 'imported', candidateId: 'candidate:synthetic' }; } });
  await useCase(f, fakeReaders()).estimateBatch({ actor: f.owner, input: f.input });
  const document = await f.repository.readSnapshot();
  assert.equal(readADiscoveryEstimateOutcome(document, { batchId: f.batch.batchId, revision: f.batch.revision, productId: NEGATIVE }), 'excluded_negative');
  assert.equal(readADiscoveryEstimateOutcome(document, { batchId: f.batch.batchId, revision: f.batch.revision, productId: SELECTABLE }), 'selectable');
  assert.equal(readADiscoveryEstimateOutcome(document, { batchId: f.batch.batchId, revision: f.batch.revision, productId: '2107989999' }), null);
  await assert.rejects(f.service.importSelected({ actor: f.owner, input: { ...f.input, marketProductId: NEGATIVE } }),
    error => error.code === 'ESTIMATE_EXCLUDED');
  assert.deepEqual(picked, []);
  const selected = await f.service.importSelected({ actor: f.owner, input: { ...f.input, marketProductId: SELECTABLE } });
  assert.equal(selected.status, 'imported');
  assert.deepEqual(picked, [SELECTABLE]);
  // Products still waiting for data are not excluded; only a proven negative ceiling is.
  await f.service.importSelected({ actor: f.owner, input: { ...f.input, marketProductId: INCOMPLETE } });
  assert.deepEqual(picked, [SELECTABLE, INCOMPLETE]);
});

test('再次估算替换同一批次版本的记录，视图只在自己的回执副本上显示摘要', async t => {
  const f = await completedBatch(t);
  const readers = fakeReaders();
  const usecase = useCase(f, readers);
  const first = await usecase.estimateBatch({ actor: f.owner, input: f.input });
  const before = recordFor(await savedRecords(f), f, SELECTABLE);
  f.advance(60 * 60 * 1000);
  const second = await usecase.estimateBatch({ actor: f.owner, input: f.input });
  assert.deepEqual(second, first);
  const records = await savedRecords(f);
  assert.equal(Object.keys(records).length, 3);
  const after = recordFor(records, f, SELECTABLE);
  assert.notEqual(after.estimatedAt, before.estimatedAt);
  assert.deepEqual({ ...after, estimatedAt: before.estimatedAt }, before);
  const document = await f.repository.readSnapshot();
  const view = f.service.view({ document, actor: f.owner });
  const products = view.batches[0].jobs[0].receipt.steps[1].result.products;
  const shown = new Map(products.map(value => [value.productId, value.estimate]));
  assert.deepEqual(Object.keys(shown.get(SELECTABLE)).sort(), ['commissionRate', 'freight', 'marginAtMid', 'maximumAllInPurchaseRmb', 'outcome', 'revenueCny', 'status', 'summary', 'unitProfitAtMidRmb']);
  assert.equal(shown.get(SELECTABLE).outcome, 'selectable');
  assert.match(shown.get(SELECTABLE).summary, /^预估采购上限 ¥\d+\.\d{2} · GUOO Economy Small 0\.7kg 运费 ¥37\.64 · 佣金 14%$/);
  assert.equal(shown.get(SELECTABLE).commissionRate, 0.14);
  assert.deepEqual(shown.get(NEGATIVE).freight, { route: 'GUOO Economy Big', chargeableKg: 9.5, freightRmb: 221.89, oversize: true });
  assert.equal(shown.get(NEGATIVE).outcome, 'excluded_negative');
  assert.match(shown.get(NEGATIVE).summary, /^预估负利润，已排除 /);
  assert.equal(shown.get(INCOMPLETE).outcome, 'needs_data');
  assert.equal(shown.get(INCOMPLETE).maximumAllInPurchaseRmb, null);
  assert.equal(shown.get(INCOMPLETE).freight.route, null);
  // The saved receipt never carries the estimate; only the view's own clone does.
  const saved = document.runtime.aDiscoveryReceipts[view.batches[0].jobs[0].job.jobId];
  assert.ok(saved.steps[1].result.products.every(value => value.estimate === undefined));
  const untouched = structuredClone(saved);
  attachADiscoveryEstimates(untouched, {}, { batchId: f.batch.batchId, revision: f.batch.revision });
  assert.equal(JSON.stringify(untouched), JSON.stringify(saved));
});

test('主人身份、批次版本和封闭输入在任何读取之前检查', async t => {
  const f = await completedBatch(t);
  const readers = fakeReaders();
  const usecase = useCase(f, readers);
  const stranger = createActorContext({ authenticatedAt: f.clock(), userId: 'user:someone-else', sessionId: 'session:other',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider' });
  await assert.rejects(usecase.estimateBatch({ actor: stranger, input: f.input }), error => error.code === 'OWNER_CONFLICT');
  await assert.rejects(usecase.estimateBatch({ actor: f.owner, input: { ...f.input, extra: 1 } }), error => error.code === 'INPUT_INVALID');
  await assert.rejects(usecase.estimateBatch({ actor: f.owner, input: { ...f.input, expectedRevision: 9 } }), error => error.code === 'BATCH_CHANGED');
  await assert.rejects(usecase.estimateBatch({ actor: f.owner, input: { batchId: 'a-discovery-batch:none', expectedRevision: 0 } }),
    error => error.code === 'BATCH_REQUIRED');
  assert.deepEqual({ commission: readers.calls.commission, fx: readers.calls.fx, tariff: readers.calls.tariff }, { commission: 0, fx: 0, tariff: 0 });
  assert.deepEqual(await savedRecords(f), {});
  assert.equal(typeZhFromCategoryPath(category), '宠物躺床');
  assert.equal(typeZhFromCategoryPath(null), null);
  assert.equal(typeZhFromCategoryPath({ cnTitlePath: '   ' }), null);
  assert.throws(() => createADiscoveryEstimateUseCase({ repository: f.repository, serverClock: f.clock, rules,
    readers: { commission: async () => ({}), fx: async () => ({}) }, configuration: { packagingRmbDefault: 3 } }), /A_DISCOVERY_ESTIMATE_DEPENDENCY_INVALID/);
});

// The rate ladder every pricing answer needs, resolved through the same configured reference as the single rate.
test('佣金档位读取走同一份官方目录配置，缺配置或读不到时只留缺口不猜费率', async () => {
  const tierCalls = [];
  const readers = {
    ...fakeReaders(),
    commissionTiers: async ({ scope, catalogPath, versionState }) => {
      tierCalls.push({ scope, catalogPath, versionState });
      return { tiers: [{ tier: 'le1500', rate: 0.12, minRub: 0, maxRub: 1500 },
        { tier: '1500_5000', rate: 0.14, minRub: 1500.01, maxRub: 5000 }],
      source: { effectiveFrom: '2025-12-01', fileSha256: SHA }, matchedRows: [], gaps: [] };
    }
  };
  const inputs = createADiscoveryEstimateInputs({ rules, readers,
    configuration: { ozonCommissionReference: REFERENCE, guooTariffFile: '/synthetic/guoo-tariff.xlsx', packagingRmbDefault: 3 } });
  const read = await inputs.resolveCommissionTiers({ categoryPath: category }, '2026-09-10T12:00:00.000Z');
  assert.deepEqual(read.tiers.map(tier => tier.rate), [0.12, 0.14]);
  assert.equal(read.sourceRef, `ozon-official-commission:2025-12-01:sha256:${SHA}`);
  assert.deepEqual(read.gaps, []);
  // The scope carries no price at all: this read is the whole ladder, and it uses the same configured catalog.
  assert.deepEqual(tierCalls[0].scope, { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: { typeZh: '宠物躺床' } });
  assert.equal(tierCalls[0].catalogPath, REFERENCE.catalogPath);
  assert.deepEqual(tierCalls[0].versionState, REFERENCE.versionState);

  const gapCases = [
    [{ categoryPath: null }, inputs, 'CATEGORY_PATH_MISSING'],
    [{ categoryPath: category }, createADiscoveryEstimateInputs({ rules, readers: fakeReaders(),
      configuration: { ozonCommissionReference: REFERENCE, packagingRmbDefault: 3 } }), 'TIER_READER_NOT_CONFIGURED'],
    [{ categoryPath: category }, createADiscoveryEstimateInputs({ rules, readers, configuration: { packagingRmbDefault: 3 } }), 'REFERENCE_NOT_CONFIGURED'],
    [{ categoryPath: category }, createADiscoveryEstimateInputs({ rules,
      readers: { ...readers, commissionTiers: async () => { const error = new Error('x'); error.code = 'CATALOG_UNREADABLE'; throw error; } },
      configuration: { ozonCommissionReference: REFERENCE, packagingRmbDefault: 3 } }), 'CATALOG_UNREADABLE']
  ];
  for (const [product, resolver, code] of gapCases) {
    const blocked = await resolver.resolveCommissionTiers(product, '2026-09-10T12:00:00.000Z');
    assert.deepEqual(blocked.tiers, [], code);
    assert.equal(blocked.sourceRef, null);
    assert.deepEqual(blocked.gaps.map(gap => gap.code), [code]);
  }
});
