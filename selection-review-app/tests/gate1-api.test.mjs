import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createMusicBoxCandidate } from './helpers/legacy-candidate-fixture.mjs';

// Synthetic candidates and match results only. The rate is declared by this test; the tariff table is absent on purpose.
const FX_PACK = { id: 'evidence:synthetic-fx-gate1', kind: 'exchange_rate', status: 'active',
  scope: { pair: 'RUB/CNY' }, sourceRef: 'cbr-xml-daily:R01375:2026-09-10', sourceType: 'bank_of_russia_official_daily_xml',
  checkedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  evidenceData: { rubPerCny: 12.7373, rateDate: '2026-09-10', nominal: 1, officialValueRub: 12.7373 } };

const offer = (id, extra = {}) => ({ offerId: String(id), sourceUrl: `https://detail.1688.com/offer/${id}.html`, title: `合成货源 ${id}`,
  imageUrl: null, priceCny: 20, priceNote: '包邮', quantityBegin: 1, similarity: 'identical', distance: 0, ...extra });
const ozonItem = (id, extra = {}) => ({ productId: String(id), sourceUrl: `https://www.ozon.ru/product/${id}/`, title: `Синтетика ${id}`,
  imageUrl: null, priceRub: 1500, similarity: 'identical', distance: 0, ...extra });

function gate1Candidate(fixture, id) {
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  delete candidate.sourceCapture;
  delete candidate.supplierDraftV1;
  Object.assign(candidate, { id, workflowStatus: 'needs_user_data', sourceUrl: '', packedWeightKg: 0.4,
    storeRef: structuredClone(fixture.binding.storeRef), targetStore: fixture.binding.storeRef.stableStoreId,
    ozonImageMatch: { captureId: 'OMJ-synthetic-1', status: 'compared', results: [ozonItem(9001)], judgements: {} },
    supplierImageMatch: { captureId: 'IMJ-synthetic-1', status: 'compared',
      results: [offer(7001, { priceCny: 25 }), offer(7002, { priceCny: 18 }), offer(7003, { priceCny: 9, quantityBegin: 3 })], judgements: {} } });
  return candidate;
}

test('「做这件」接口：只认已登录主人和当前修订号；做这件存方案不确认供货，不做这件退出正常处理', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const accepted = gate1Candidate(fixture, 'candidate:gate1-accept');
  const skipped = gate1Candidate(fixture, 'candidate:gate1-skip');
  const document = { ...fixture.document, candidates: [accepted, skipped], evidencePacks: [structuredClone(FX_PACK)],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'gate1-api-'));
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
  const route = (id, action) => `/api/candidates/${encodeURIComponent(id)}/gate1/${action}`;
  const dims = { dimensionsCm: { length: 30, width: 20, height: 10 } };

  const bytesBefore = await api.readBytes();
  const anonymous = await api.post(route(accepted.id, 'accept'), { dataRevision: accepted.dataRevision, supplierOfferId: '7002' }, { authenticated: false });
  assert.equal(anonymous.status, 401);
  await api.authenticate();

  const view = await api.get(`/api/candidates/${encodeURIComponent(accepted.id)}/lifecycle/supplier-draft`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const gate1 = view.body.gate1V1;
  assert.equal(gate1.open, true);
  // 最便宜又确定一件起订的那家；3 件起批的更便宜也不选。
  assert.deepEqual(gate1.preselection, { ozonProductId: '9001', matchOfferId: '7001', supplierOfferId: '7002' });
  assert.equal(gate1.decision, null);

  const conflict = await api.post(route(accepted.id, 'accept'), { dataRevision: accepted.dataRevision + 1, supplierOfferId: '7002', facts: dims });
  assert.equal(conflict.status, 409);
  const moq = await api.post(route(accepted.id, 'accept'), { dataRevision: accepted.dataRevision, supplierOfferId: '7003', facts: dims });
  assert.deepEqual([moq.status, moq.body.code], [409, 'gate1_supplier_moq']);
  const noDims = await api.post(route(accepted.id, 'accept'), { dataRevision: accepted.dataRevision, ozonProductId: '9001', supplierOfferId: '7002' });
  assert.equal(noDims.body.code, 'gate1_facts_missing');
  assert.deepEqual(await api.readBytes(), bytesBefore, '被拒绝的决定不得写入任何东西');

  const ok = await api.post(route(accepted.id, 'accept'), { dataRevision: accepted.dataRevision, ozonProductId: '9001',
    matchOfferId: '7001', supplierOfferId: '7002', facts: dims });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.dispatch, null);
  assert.equal(ok.body.supplierDraftV1.sourceUrl, 'https://detail.1688.com/offer/7002.html');
  const saved = (await api.readDocument()).candidates.find(item => item.id === accepted.id);
  assert.equal(saved.dataRevision, accepted.dataRevision + 1);
  assert.equal(saved.gate1DecisionV1.decision, 'accept');
  assert.equal(saved.gate1.decision, 'accept', '录入流水线靠 candidate.gate1 知道这件过了第一关');
  assert.equal(saved.gate1DecisionV1.ownerSupplyConfirmed, false, '做这件不是供货确认');
  assert.equal(saved.gate1DecisionV1.picks.supplier.tag, 'software');
  assert.equal(saved.lifecycleV11 ?? null, null, '做这件不得创建生命周期');
  const again = await api.post(route(accepted.id, 'accept'), { dataRevision: saved.dataRevision, supplierOfferId: '7002', facts: dims });
  assert.equal(again.body.code, 'gate1_not_open');

  const badReason = await api.post(route(skipped.id, 'skip'), { dataRevision: skipped.dataRevision, reason: '尺寸太大' });
  assert.equal(badReason.status, 400);
  const skip = await api.post(route(skipped.id, 'skip'), { dataRevision: skipped.dataRevision, reason: 'too_large', note: '合成备注' });
  assert.equal(skip.status, 200, JSON.stringify(skip.body));
  const gone = (await api.readDocument()).candidates.find(item => item.id === skipped.id);
  assert.equal(gone.workflowStatus, 'eliminated');
  assert.equal(gone.eliminationReason, '主人不做：尺寸太大');
  assert.equal(gone.gate1DecisionV1.decision, 'skip');
  const notPending = await api.post(route(accepted.id, 'shortfall'), { dataRevision: saved.dataRevision, choice: 'change_price' });
  assert.equal(notPending.body.code, 'gate1_shortfall_not_pending');
  await api.assertClean();
});
