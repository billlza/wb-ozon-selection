import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createMusicBoxCandidate } from './helpers/legacy-candidate-fixture.mjs';


// A still-current synthetic official rate, declared by this test only. The tariff table is deliberately absent, so the
// route must report a missing freight input instead of inventing one.
const FX_PACK = { id: 'evidence:synthetic-fx-supplier-draft', kind: 'exchange_rate', status: 'active',
  scope: { pair: 'RUB/CNY' }, sourceRef: 'cbr-xml-daily:R01375:2026-09-10', sourceType: 'bank_of_russia_official_daily_xml',
  checkedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  evidenceData: { rubPerCny: 12.7373, rateDate: '2026-09-10', nominal: 1, officialValueRub: 12.7373 } };

const draftInput = (dataRevision, extra = {}) => ({ dataRevision,
  sourceUrl: 'https://detail.1688.com/offer/876240928352.html', goodsPriceRmb: 15.9, domesticShippingRmb: 2.96,
  packedWeightKg: 1.3, dimensionsCm: { length: 75, width: 21, height: 4 }, targetSalePriceRub: 1850, ...extra });

test('找货资料接口只接受已登录主人的封闭输入和当前修订号，保存后立刻回报估算', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  delete candidate.sourceCapture;
  candidate.workflowStatus = 'needs_user_data';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  candidate.sourceUrl = '';
  const document = { ...fixture.document, candidates: [candidate], evidencePacks: [structuredClone(FX_PACK)],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'supplier-draft-api-'));
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const closedPort = allocatedTestPorts().second;
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    // The declared tariff file does not exist in this isolated run, and the rate URL points at a closed loopback port.
    SELECTION_REVIEW_GUOO_TARIFF_FILE: path.join(directory, 'GUOO-2026.8.19-absent.xlsx'),
    SELECTION_REVIEW_CBR_FX_URL: `http://127.0.0.1:${closedPort}/scripts/XML_daily.asp`,
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON: '[]' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const route = `/api/candidates/${candidate.id}/lifecycle/supplier-draft`;

  assert.equal((await api.get(route)).status, 401);
  assert.equal((await api.post(route, draftInput(candidate.dataRevision), { authenticated: false })).status, 401);
  await api.authenticate();

  const bytesBeforeRead = await api.readBytes();
  const empty = await api.get(route);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.schemaVersion, 'supplier-draft-view-v1');
  assert.equal(empty.body.candidateId, candidate.id);
  assert.equal(empty.body.dataRevision, candidate.dataRevision);
  assert.equal(empty.body.supplierDraftV1, null);
  assert.equal(empty.body.supplierDraftEstimateV1, null);
  // This candidate already carries a real page read and no discovery receipt, so the derived projection never runs.
  assert.equal(empty.body.marketSnapshot.snapshotId, candidate.salesSnapshotsV11[0].snapshotId);
  assert.equal(empty.body.marketSnapshot.collectorMode, 'real_page_read_only');
  assert.equal(empty.body.marketSnapshot.source ?? null, null);
  assert.deepEqual(await api.readBytes(), bytesBeforeRead, '只读打开找货不得改写业务数据');

  assert.equal((await api.get(`/api/candidates/candidate:missing/lifecycle/supplier-draft`)).status, 404);
  const extraKey = await api.post(route, { ...draftInput(candidate.dataRevision), ownerSupplyConfirmed: true });
  assert.equal(extraKey.status, 400);
  assert.equal(extraKey.body.code, 'supplier_draft_field_forbidden');
  const badUrl = await api.post(route, draftInput(candidate.dataRevision, { sourceUrl: 'https://item.taobao.com/item.htm?id=1' }));
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.body.code, 'supplier_draft_source_url_invalid');
  assert.equal((await api.post(route, draftInput(candidate.dataRevision + 1))).status, 409);
  assert.equal((await api.post(route, draftInput(candidate.dataRevision), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api.post(route, draftInput(candidate.dataRevision),
    { headers: { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(await api.readBytes(), bytesBeforeRead, '被拒绝的提交不得写入任何数据');

  const saved = await api.post(route, draftInput(candidate.dataRevision, { note: '卖家说一件可买' }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.dataRevision, candidate.dataRevision + 1);
  const draft = saved.body.supplierDraftV1;
  assert.equal(draft.schemaVersion, 'supplier-draft-v1');
  assert.equal(draft.declaredBy, 'owner');
  assert.equal(draft.provenance, 'owner_declared');
  assert.equal(draft.sourceUrl, 'https://detail.1688.com/offer/876240928352.html');
  assert.equal(draft.offerId, '876240928352');
  assert.equal(draft.allInPurchaseRmb, 18.86);
  assert.equal(draft.targetSalePriceRub, 1850);
  assert.deepEqual(draft.dimensionsCm, { length: 75, width: 21, height: 4 });
  assert.ok(Number.isFinite(Date.parse(draft.declaredAt)));
  const estimate = saved.body.supplierDraftEstimateV1;
  assert.equal(estimate.schemaVersion, 'supplier-draft-estimate-v1');
  assert.equal(estimate.estimate.status, 'incomplete');
  assert.equal(estimate.profitAtDeclaredPurchase, null);
  assert.deepEqual(estimate.estimate.missing, ['官方佣金', '可行物流线路']);
  assert.equal(estimate.routeBlock.code, 'no_feasible_route');
  assert.equal(estimate.inputs.fxSourceRef, FX_PACK.sourceRef);
  assert.equal(estimate.inputs.tariffRuleVersion, null);
  assert.equal(estimate.estimate.fx.rubPerCny, 12.7373);

  const persisted = (await api.readDocument()).candidates[0];
  assert.equal(persisted.dataRevision, candidate.dataRevision + 1);
  assert.deepEqual(persisted.supplierDraftV1, draft);
  // The same declaration also fills the per-field owner columns the older cards read, so nothing regresses.
  assert.equal(persisted.sourceUrl, draft.sourceUrl);
  assert.equal(persisted.purchasePriceRmb, 18.86);
  assert.equal(persisted.domesticShippingRmb, 2.96);
  assert.equal(persisted.packedWeightKg, 1.3);
  assert.deepEqual(persisted.dimensionsCm, { length: 75, width: 21, height: 4 });
  assert.equal(persisted.expectedPriceRub, 1850);
  assert.equal(persisted.supplierDraftEstimateV1.schemaVersion, 'supplier-draft-estimate-v1');
  assert.ok(persisted.history.some(entry => entry.action === 'supplierDraftDeclared'));
  assert.equal(persisted.lifecycleV11 ?? null, null, '保存找货资料不得创建生命周期');

  const stale = await api.post(route, draftInput(candidate.dataRevision));
  assert.equal(stale.status, 409);
  const reread = await api.get(route);
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.body.supplierDraftV1, draft);
  assert.equal(reread.body.supplierDraftEstimateV1.estimate.status, 'incomplete');
  assert.equal(reread.body.candidate.supplierDraftV1.provenance, 'owner_declared');
  await api.assertClean();
});

test('淘汰与恢复是主人自己的软删除：封闭输入、认修订号、只改状态，不派发也不碰平台', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  delete candidate.sourceCapture;
  candidate.workflowStatus = 'codex_processing';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  const document = { ...fixture.document, candidates: [candidate], evidencePacks: [],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'owner-elimination-api-'));
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON: '[]' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const eliminate = `/api/candidates/${candidate.id}/workflow/eliminate`;
  const restore = `/api/candidates/${candidate.id}/workflow/restore`;

  assert.equal((await api.post(eliminate, { dataRevision: candidate.dataRevision }, { authenticated: false })).status, 401);
  await api.authenticate();

  const bytesBefore = await api.readBytes();
  assert.equal((await api.post(eliminate, { dataRevision: candidate.dataRevision, note: '自由文本' })).status, 400);
  assert.equal((await api.post(eliminate, { dataRevision: candidate.dataRevision, reason: '我就是不想要' })).status, 400);
  assert.equal((await api.post(eliminate, { dataRevision: '4' })).status, 400);
  assert.equal((await api.post(restore, { dataRevision: candidate.dataRevision, reason: '尺寸太大' })).status, 400, '恢复不收理由');
  assert.equal((await api.post(eliminate, { dataRevision: candidate.dataRevision + 1 })).status, 409);
  assert.equal((await api.post(restore, { dataRevision: candidate.dataRevision })).status, 409, '没淘汰过就不用恢复');
  assert.equal((await api.post('/api/candidates/candidate:missing/workflow/eliminate', { dataRevision: 0 })).status, 404);
  assert.deepEqual(await api.readBytes(), bytesBefore, '被拒绝的提交不得写入任何数据');

  const gone = await api.post(eliminate, { dataRevision: candidate.dataRevision, reason: '利润太薄' });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.dispatch, null, '淘汰不得派发任何任务');
  assert.equal(gone.body.candidate.workflowStatus, 'eliminated');
  const eliminated = (await api.readDocument()).candidates[0];
  assert.equal(eliminated.workflowStatus, 'eliminated');
  assert.equal(eliminated.eliminationReason, '主人淘汰：利润太薄');
  assert.equal(eliminated.eliminatedFromStatus, 'codex_processing');
  assert.ok(Number.isFinite(Date.parse(eliminated.eliminatedAt)));
  assert.equal(eliminated.dataRevision, candidate.dataRevision + 1);
  assert.equal(eliminated.processing.state, 'idle');
  assert.equal(eliminated.processing.manualHold, true);
  assert.ok(eliminated.history.some(entry => entry.action === 'ownerEliminated'));
  assert.equal((await api.readDocument()).dispatches?.length ?? 0, 0);
  assert.equal((await api.post(eliminate, { dataRevision: eliminated.dataRevision })).status, 409, '已经淘汰过不能再淘汰');

  const back = await api.post(restore, { dataRevision: eliminated.dataRevision });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const restored = (await api.readDocument()).candidates[0];
  assert.equal(restored.workflowStatus, 'codex_processing', '回到淘汰前的那一步');
  assert.equal(restored.eliminatedAt, null);
  assert.equal(restored.eliminationReason, '');
  assert.equal(restored.eliminatedFromStatus, null);
  assert.equal(restored.dataRevision, eliminated.dataRevision + 1);
  assert.ok(restored.history.some(entry => entry.action === 'ownerRestored'));
  assert.equal((await api.readDocument()).dispatches?.length ?? 0, 0, '恢复也不派发任何任务');
  await api.assertClean();
});

/**
 * 选规格 — the owner picks which captured specifications this product will be listed with.
 * The route only records that choice and freezes it into this product's supply plan: owner-only, closed input, the
 * current revision, one history line, and no dispatch, no supplier contact and no platform write.
 */
const capturedSku = (id, colour, size, priceCny, stock, weightKg) => ({
  sourceSkuId: id, propPath: `1627207:${id}`,
  attributes: { 颜色: colour, 尺码: size },
  priceCny, priceSource: 'tradeModel.skuMap.price', stock, stockSource: 'tradeModel.skuMap.canBookCount',
  inStock: stock > 0, weight: weightKg === null ? null : { value: weightKg, unit: 'kg' },
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight', imageUrl: null
});
const waitingSourceCapture = () => ({
  captureId: 'SCJ-synthetic-sku-choice', status: 'captured_waiting_owner_selection', mode: 'a_supplier_capture',
  jobStatus: 'completed', attempt: 1, offerId: '876240928352',
  sourceUrl: 'https://detail.1688.com/offer/876240928352.html',
  originalSourceUrl: 'https://detail.1688.com/offer/876240928352.html',
  title: '合成雨衣', offerStatus: null, observedAt: '2026-09-13T00:30:00.000Z',
  collectionMethod: 'chrome_extension_structured_page_v1', titleSource: 'page.h1', offerIdSource: 'page.url',
  pageSelectedSkuId: null, priceRanges: [],
  pageFields: { unitProductPriceCny: null, unitProductPriceSource: null, unitDomesticFreightCny: null, unitDomesticFreightSource: null },
  supplierAttributes: {},
  skuChoices: [
    capturedSku('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 494, 0.103),
    capturedSku('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 468, 0.24),
    capturedSku('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, 479, null)
  ],
  selectedSkuIds: [], ownerSupplyConfirmed: false, suggestedSkuIds: [], matchTerms: [],
  writeOccurred: false, businessStateEffect: 'unchanged'
});

test('选规格只接受已登录主人的封闭输入和当前修订号，保存后把选中的规格锁进供货方案，不派发也不碰平台', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  candidate.workflowStatus = 'needs_user_data';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  candidate.sourceUrl = 'https://detail.1688.com/offer/876240928352.html';
  candidate.sourceCapture = waitingSourceCapture();
  const document = { ...fixture.document, candidates: [candidate], evidencePacks: [structuredClone(FX_PACK)],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'sku-choice-api-'));
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const closedPort = allocatedTestPorts().second;
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    SELECTION_REVIEW_GUOO_TARIFF_FILE: path.join(directory, 'GUOO-2026.8.19-absent.xlsx'),
    SELECTION_REVIEW_CBR_FX_URL: `http://127.0.0.1:${closedPort}/scripts/XML_daily.asp`,
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON: '[]' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const draftRoute = `/api/candidates/${candidate.id}/lifecycle/supplier-draft`;
  const route = `/api/candidates/${candidate.id}/lifecycle/sku-choice`;

  assert.equal((await api.post(route, { dataRevision: candidate.dataRevision, sourceSkuIds: ['sku-xl-yellow'] }, { authenticated: false })).status, 401);
  await api.authenticate();

  // Before the owner's own 找货 declaration exists there is nothing to price the specifications against.
  const withoutDraft = await api.get(draftRoute);
  assert.equal(withoutDraft.status, 200);
  assert.equal(withoutDraft.body.skuChoiceTableV1, null);

  const saved = await api.post(draftRoute, draftInput(candidate.dataRevision,
    { sourceUrl: 'https://detail.1688.com/offer/876240928352.html', goodsPriceRmb: 20.5, domesticShippingRmb: 3.5,
      packedWeightKg: 0.2, dimensionsCm: { length: 25, width: 22, height: 2.5 }, targetSalePriceRub: 1600 }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const revision = saved.body.dataRevision;
  // The table is there, one row per captured specification, each carrying that specification's own captured facts.
  const table = saved.body.skuChoiceTableV1;
  assert.equal(table.schemaVersion, 'sku-choice-table-v1');
  assert.equal(table.total, 3);
  assert.deepEqual(table.columns, ['颜色', '尺码']);
  assert.deepEqual(table.rows.map(row => row.sourceSkuId).sort(), ['sku-8xl-beige', 'sku-8xl-yellow', 'sku-xl-yellow']);
  assert.deepEqual(table.rows.map(row => row.weightKg).sort(), [0.103, 0.24, null]);
  assert.equal(table.sources.targetSalePriceRub, 1600);
  assert.equal(table.sources.domesticShippingRmb, 3.5);
  assert.equal(table.sources.rubPerCny, 12.7373);
  // This isolated run has no tariff table and no commission catalogue, so no row is priced and none is guessed.
  assert.deepEqual(table.rows.map(row => row.unitProfitRmb), [null, null, null]);
  assert.equal(table.weightMissingCount, 1);
  assert.deepEqual(table.selectedSkuIds, []);

  const bytesBeforeRejects = await api.readBytes();
  assert.equal((await api.post(route, { dataRevision: revision })).status, 400);
  assert.equal((await api.post(route, { dataRevision: revision, sourceSkuIds: [] })).status, 400);
  assert.equal((await api.post(route, { dataRevision: revision, sourceSkuIds: ['sku-xl-yellow'], ownerSupplyConfirmed: true })).status, 400);
  assert.equal((await api.post(route, { dataRevision: revision + 1, sourceSkuIds: ['sku-xl-yellow'] })).status, 409);
  const unknown = await api.post(route, { dataRevision: revision, sourceSkuIds: ['sku-not-captured'] });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.code, 'sku_choice_invalid');
  assert.equal((await api.post(route, { dataRevision: revision, sourceSkuIds: ['sku-xl-yellow'] },
    { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api.post(route, { dataRevision: revision, sourceSkuIds: ['sku-xl-yellow'] },
    { headers: { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(await api.readBytes(), bytesBeforeRejects, '被拒绝的选规格不得写入任何数据');

  const chosen = await api.post(route, { dataRevision: revision, sourceSkuIds: ['sku-8xl-yellow', 'sku-xl-yellow'] });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.equal(chosen.body.schemaVersion, 'supplier-draft-view-v1');
  assert.equal(chosen.body.dataRevision, revision + 1);
  assert.deepEqual(chosen.body.skuChoiceTableV1.selectedSkuIds, ['sku-8xl-yellow', 'sku-xl-yellow']);

  const persisted = (await api.readDocument()).candidates[0];
  assert.equal(persisted.dataRevision, revision + 1);
  // The capture keeps the status the A confirmation still reads, so nothing downstream is re-queued by this step.
  assert.equal(persisted.sourceCapture.status, 'captured_waiting_owner_selection');
  assert.deepEqual(persisted.sourceCapture.selectedSkuIds, ['sku-8xl-yellow', 'sku-xl-yellow']);
  assert.equal(persisted.sourceCapture.skuChoices.length, 3, '没被选中的规格仍然留着，随时可以改');
  const selection = persisted.sourceCapture.skuSelection;
  assert.equal(selection.schemaVersion, 'source-capture-sku-selection-v1');
  assert.equal(selection.selectedBy, 'owner');
  assert.ok(Number.isFinite(Date.parse(selection.selectedAt)));
  assert.deepEqual(selection.missingWeightSkuIds, []);
  // 供货方案走既有适配器：规格标识、直接货价和采到的重量原样冻结，页面没给的照旧是 unknown。
  assert.equal(selection.supplierOption.supplierOptionId, 'supplier-option:1688:876240928352');
  assert.equal(selection.supplierOption.sourcePlatform, '1688');
  assert.equal(selection.supplierOption.productUrl, 'https://detail.1688.com/offer/876240928352.html');
  assert.equal(selection.supplierOption.evidenceRef, 'source-capture:SCJ-synthetic-sku-choice');
  assert.deepEqual(selection.supplierOption.supplierSkus.map(sku => sku.supplierSkuId), ['sku-8xl-yellow', 'sku-xl-yellow']);
  assert.deepEqual(selection.supplierOption.supplierSkus.map(sku => sku.unitProductPrice), [41.5, 20.5]);
  assert.deepEqual(selection.supplierOption.supplierSkus.map(sku => sku.weight), [{ value: 0.24, unit: 'kg' }, { value: 0.103, unit: 'kg' }]);
  assert.deepEqual(selection.supplierOption.supplierSkus.map(sku => sku.unitDomesticFreight), ['unknown', 'unknown']);
  const history = persisted.history.filter(entry => entry.action === 'aSupplierSkuChoiceSaved');
  assert.equal(history.length, 1);
  assert.match(history[0].detail, /主人选定了2个1688规格并锁进本商品的供货方案/u);
  assert.match(history[0].detail, /未派发任务、未联系供应商、未向平台写入任何内容/u);
  // 没有派发、没有生命周期、没有平台写入。
  assert.deepEqual((await api.readDocument()).dispatches ?? [], []);
  assert.equal(persisted.lifecycleV11 ?? null, null);
  assert.equal(persisted.listingHandoff ?? null, null);

  // 改主意就是再选一次：同一条路由，认新的修订号，把页面没给重量的那一个也记成缺口。
  const changed = await api.post(route, { dataRevision: revision + 1, sourceSkuIds: ['sku-8xl-beige'] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const rechosen = (await api.readDocument()).candidates[0];
  assert.deepEqual(rechosen.sourceCapture.selectedSkuIds, ['sku-8xl-beige']);
  assert.deepEqual(rechosen.sourceCapture.skuSelection.missingWeightSkuIds, ['sku-8xl-beige']);
  assert.equal(rechosen.sourceCapture.skuSelection.supplierOption.supplierSkus[0].weight, 'unknown');
  assert.match(rechosen.history.at(-1).detail, /其中1个规格页面没有给出重量，运费与利润留空未补/u);
  await api.assertClean();
});

/**
 * 同重同价声明 — the owner's own statement about one capture: 「这些规格是同一件货的不同规格，缺的重量和货价按我在
 * 找货里填的算」.
 *
 * 2026-09-16 那件小猫战术背心：采回来 5 个规格全是「均码」只差颜色，重量和货价一个都没采到，整张表整列「待补」，而他
 * 在「找货」里早就填了。软件不许自己去借那个数（2026-09-13 狗雨衣八个尺码 103 克到 240 克），所以这条路做的是把签字
 * 权交给他：仅主人、封闭输入、认当前修订号、一条存档，不派发、不联系供应商、不碰平台。
 */
const colourOnlySku = (id, colour) => ({
  sourceSkuId: id, propPath: `1627207:${id}`, attributes: { 颜色: colour, 尺码: '均码' },
  priceCny: null, priceSource: null, stock: 498, stockSource: 'tradeModel.skuMap.canBookCount', inStock: true,
  weight: null, weightSource: null, imageUrl: null
});

test('同重同价声明只接受已登录主人的封闭输入和当前修订号，签了字才按他填的算，采到的真实值不受影响', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  candidate.workflowStatus = 'needs_user_data';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  candidate.sourceUrl = 'https://detail.1688.com/offer/876240928352.html';
  candidate.sourceCapture = {
    ...waitingSourceCapture(),
    captureId: 'SCJ-synthetic-uniform',
    skuChoices: [
      colourOnlySku('6222816678019', '黑色'),
      colourOnlySku('6222816678021', '卡其色'),
      // 这一个页面给了重量和货价：签了字也必须还是按采到的算。
      capturedSku('6222816678022', '军绿色', '均码', 19.5, 7849, 0.18)
    ]
  };
  const document = { ...fixture.document, candidates: [candidate], evidencePacks: [structuredClone(FX_PACK)],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'sku-uniform-api-'));
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const closedPort = allocatedTestPorts().second;
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    SELECTION_REVIEW_GUOO_TARIFF_FILE: path.join(directory, 'GUOO-2026.8.19-absent.xlsx'),
    SELECTION_REVIEW_CBR_FX_URL: `http://127.0.0.1:${closedPort}/scripts/XML_daily.asp`,
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON: '[]' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const draftRoute = `/api/candidates/${candidate.id}/lifecycle/supplier-draft`;
  const route = `/api/candidates/${candidate.id}/lifecycle/sku-uniform-supply`;

  assert.equal((await api.post(route, { dataRevision: candidate.dataRevision, uniform: true }, { authenticated: false })).status, 401);
  await api.authenticate();

  const saved = await api.post(draftRoute, draftInput(candidate.dataRevision,
    { sourceUrl: 'https://detail.1688.com/offer/876240928352.html', goodsPriceRmb: 18, domesticShippingRmb: 6.5,
      packedWeightKg: 0.2, dimensionsCm: { length: 20, width: 30, height: 5 }, targetSalePriceRub: 848 }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const revision = saved.body.dataRevision;

  // 签字之前：两个没采到的规格整行「待补」，一个字都没有被借。
  const before = saved.body.skuChoiceTableV1;
  assert.equal(before.weightMissingCount, 2);
  assert.equal(before.uniformSupply, null);
  const beforeGap = before.rows.find(row => row.sourceSkuId === '6222816678019');
  assert.equal(beforeGap.status, 'weight_missing');
  assert.deepEqual([beforeGap.weightKg, beforeGap.priceCny, beforeGap.weightBasis, beforeGap.priceBasis], [null, null, null, null]);
  const step = saved.body.skuUniformSupplyStepV1;
  assert.equal(step.schemaVersion, 'sku-uniform-supply-step-v1');
  assert.equal(step.status, 'absent');
  assert.equal(step.offered, true);
  assert.deepEqual(step.basis, { packedWeightKg: 0.2, goodsPriceRmb: 18 });

  // 封闭输入、认修订号、不收第三种答案；被拒绝的一次一个字节都不许落盘。
  const bytesBeforeRejects = await api.readBytes();
  assert.equal((await api.post(route, { dataRevision: revision })).status, 400);
  assert.equal((await api.post(route, { dataRevision: revision, uniform: true, note: 'x' })).status, 400);
  assert.equal((await api.post(route, { dataRevision: revision, uniform: 'yes' })).status, 400);
  assert.equal((await api.post(route, { dataRevision: revision + 1, uniform: true })).status, 409);
  assert.equal((await api.post(route, { dataRevision: revision, uniform: false })).status, 409, '没签过就没得撤回');
  assert.equal((await api.post(route, { dataRevision: revision, uniform: true }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api.post(route, { dataRevision: revision, uniform: true },
    { headers: { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(await api.readBytes(), bytesBeforeRejects, '被拒绝的声明不得写入任何数据');

  const declared = await api.post(route, { dataRevision: revision, uniform: true });
  assert.equal(declared.status, 200, JSON.stringify(declared.body));
  assert.equal(declared.body.schemaVersion, 'supplier-draft-view-v1');
  const after = declared.body.skuChoiceTableV1;
  assert.equal(after.weightMissingCount, 0, '签了字之后没有一行再卡在缺重量上');
  assert.equal(after.uniformSupply.captureId, 'SCJ-synthetic-uniform');
  assert.deepEqual(after.uniformSupply.appliedWeightSkuIds.sort(), ['6222816678019', '6222816678021']);
  const filled = after.rows.find(row => row.sourceSkuId === '6222816678019');
  assert.equal(filled.weightKg, 0.2);
  assert.equal(filled.priceCny, 18);
  assert.equal(filled.weightSource, 'owner_declared:supplierDraftV1.packedWeightKg');
  assert.equal(filled.priceSource, 'owner_declared:supplierDraftV1.goodsPriceRmb');
  assert.deepEqual([filled.weightBasis, filled.priceBasis], ['owner_declared', 'owner_declared']);
  // 采到了的那一个：签了字也还是采到的那一份。
  const captured = after.rows.find(row => row.sourceSkuId === '6222816678022');
  assert.equal(captured.weightKg, 0.18);
  assert.equal(captured.priceCny, 19.5);
  assert.deepEqual([captured.weightBasis, captured.priceBasis], ['captured', 'captured']);
  assert.equal(captured.weightSource, 'detailDescription.freightInfo.skuWeight');
  assert.equal(declared.body.skuUniformSupplyStepV1.declared, true);

  const persisted = (await api.readDocument()).candidates[0];
  assert.equal(persisted.dataRevision, revision + 1);
  assert.equal(persisted.skuUniformSupplyV1.schemaVersion, 'candidate-sku-uniform-supply-v1');
  assert.equal(persisted.skuUniformSupplyV1.declaredBy, 'owner');
  assert.equal(persisted.skuUniformSupplyV1.captureId, 'SCJ-synthetic-uniform');
  assert.deepEqual(persisted.skuUniformSupplyV1.basisAtDeclaration, { packedWeightKg: 0.2, goodsPriceRmb: 18 });
  // 采集记录本身一个字都没被改：声明是主人的话，不是采到的证据。
  assert.deepEqual(persisted.sourceCapture.skuChoices.map(sku => sku.weight), [null, null, { value: 0.18, unit: 'kg' }]);
  assert.deepEqual(persisted.sourceCapture.skuChoices.map(sku => sku.priceCny), [null, null, 19.5]);
  const history = persisted.history.filter(entry => entry.action === 'ownerSkuUniformSupplyDeclared');
  assert.equal(history.length, 1);
  assert.match(history[0].detail, /主人声明了本商品这一次采集（SCJ-synthetic-uniform）的 3 个规格同重同价/u);
  assert.match(history[0].detail, /未派发任务、未联系供应商、未向平台写入任何内容/u);
  assert.deepEqual((await api.readDocument()).dispatches ?? [], []);
  assert.equal(persisted.lifecycleV11 ?? null, null);

  // 撤回：同一条路，回到「待补」，记录被删掉。
  const withdrawn = await api.post(route, { dataRevision: revision + 1, uniform: false });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.skuChoiceTableV1.weightMissingCount, 2);
  assert.equal(withdrawn.body.skuChoiceTableV1.uniformSupply, null);
  const back = (await api.readDocument()).candidates[0];
  assert.equal(back.skuUniformSupplyV1 ?? null, null);
  assert.match(back.history.at(-1).detail, /主人撤回了本商品的同重同价声明/u);
  await api.assertClean();
});
