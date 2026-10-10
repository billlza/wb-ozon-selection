import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createMusicBoxCandidate } from './helpers/legacy-candidate-fixture.mjs';


// A still-current synthetic official rate, declared by this test only. No tariff table exists in this isolated run.
const FX_PACK = { id: 'evidence:synthetic-fx-recapture', kind: 'exchange_rate', status: 'active',
  scope: { pair: 'RUB/CNY' }, sourceRef: 'cbr-xml-daily:R01375:2026-09-12', sourceType: 'bank_of_russia_official_daily_xml',
  checkedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  evidenceData: { rubPerCny: 12.5637, rateDate: '2026-09-12', nominal: 1, officialValueRub: 12.5637 } };

const OFFER_URL = 'https://detail.1688.com/offer/943009939489.html';

const capturedSku = (id, colour, size, priceCny, stock, weightKg) => ({
  sourceSkuId: id, propPath: `1627207:${id}`,
  attributes: { 颜色: colour, 尺码: size },
  priceCny, priceSource: 'tradeModel.skuMap.price', stock, stockSource: 'tradeModel.skuMap.canBookCount',
  inStock: stock > 0, weight: weightKg === null ? null : { value: weightKg, unit: 'kg' },
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight', imageUrl: null
});

/**
 * The record this test exists for: a capture that already came back and is waiting on the owner's choice. Every
 * specification here is missing its weight, which is exactly the state the first real product of 2026-09-13 was left
 * in — captured before the server kept per-specification weights, so its 选规格 table could only show 待补.
 */
const waitingSourceCapture = (extra = {}) => ({
  captureId: 'SCJ-synthetic-recapture-first', status: 'captured_waiting_owner_selection', mode: 'a_supplier_capture',
  jobId: 'SCJ-synthetic-recapture-first', jobStatus: 'completed', attempt: 1, requiredExtensionVersion: '1.3.0',
  offerId: '943009939489', sourceUrl: OFFER_URL, originalSourceUrl: 'https://qr.1688.com/s/7OnLCakq',
  title: '合成狗雨衣', offerStatus: null, observedAt: '2026-09-13T03:23:00.000Z',
  collectionMethod: 'chrome_extension_structured_page_v1', titleSource: 'page.h1', offerIdSource: 'page.url',
  pageSelectedSkuId: null, priceRanges: [],
  pageFields: { unitProductPriceCny: null, unitProductPriceSource: null, unitDomesticFreightCny: null, unitDomesticFreightSource: null },
  supplierAttributes: {},
  skuChoices: [
    capturedSku('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 494, null),
    capturedSku('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 468, null),
    capturedSku('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, 479, null)
  ],
  selectedSkuIds: [], ownerSupplyConfirmed: false, suggestedSkuIds: [], matchTerms: [],
  writeOccurred: false, businessStateEffect: 'unchanged', ...extra
});

function seedCandidate(fixture, id, sourceCapture) {
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  candidate.id = id;
  candidate.workflowStatus = 'needs_user_data';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  candidate.salesSnapshotsV11 = candidate.salesSnapshotsV11.map(snapshot => ({ ...snapshot, snapshotId: `fixture-sales:${id}` }));
  candidate.sourceUrl = OFFER_URL;
  if (sourceCapture === null) delete candidate.sourceCapture;
  else candidate.sourceCapture = sourceCapture;
  return candidate;
}

const draftInput = (dataRevision, extra = {}) => ({ dataRevision,
  sourceUrl: OFFER_URL, goodsPriceRmb: 20.5, domesticShippingRmb: 3.5,
  packedWeightKg: 0.2, dimensionsCm: { length: 25, width: 22, height: 2.5 }, targetSalePriceRub: 1600, ...extra });

/** One isolated server per test: no tariff table, a closed loopback for the rate, and a dependency tripwire. */
async function startRecaptureApi(t, candidates) {
  const fixture = await productionOwnerDecisionHttpFixture();
  const document = { ...fixture.document, candidates: candidates(fixture), evidencePacks: [structuredClone(FX_PACK)],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'source-capture-recapture-api-'));
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
  try { Object.assign(process.env, env); return await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

const recaptureRoute = id => `/api/candidates/${id}/source-capture/recapture`;

/**
 * 重新采集 — 让软件重新去读一次同一个1688页面。
 *
 * Why this route had to exist: once a capture comes back with specifications, /lifecycle/a-confirm sees
 * captureReadyForSameSource and stops creating capture jobs for that product, so 申请插件采集 quietly becomes a no-op and
 * the product is frozen on whatever that one read contained. On 2026-09-13 the first real product of the day was
 * captured while the server still dropped every per-specification weight; its whole 运费 and 单件利润 columns read 待补
 * and nothing anywhere in the application could ask for a second read. This test proves the way out exists, that it is
 * narrow (only 已采到、等你选规格), that it re-queues through the one shared capture path, and above all that it is
 * honest: a second read voids the captured specifications and any supply plan frozen out of them, and says so.
 */
test('重新采集只在已采到、等你选规格时放行，作废这次采到的规格和已选定的供货方案，复用同一条采集作业，不派发也不碰平台', async t => {
  let waiting, untouched;
  const api = await startRecaptureApi(t, fixture => {
    waiting = seedCandidate(fixture, 'RECAPTURE-WAITING', waitingSourceCapture());
    // A capture this process never created: startup reconciliation closes it as a run whose result never arrived, which
    // is exactly the kind of record that must NOT be recaptured — 结果未知 has its own exit (source-capture/review).
    const running = seedCandidate(fixture, 'RECAPTURE-RUNNING', {
      captureId: 'SCJ-synthetic-recapture-running', status: 'capturing', mode: 'a_supplier_capture',
      jobId: 'SCJ-synthetic-recapture-running', jobStatus: 'claimed', attempt: 1, offerId: '943009939489',
      sourceUrl: OFFER_URL, originalSourceUrl: OFFER_URL, writeOccurred: false
    });
    const never = seedCandidate(fixture, 'RECAPTURE-NEVER', null);
    untouched = seedCandidate(fixture, 'RECAPTURE-OTHER', waitingSourceCapture());
    return [waiting, running, never, untouched];
  });
  const route = recaptureRoute;
  const recordOf = async id => (await api.readDocument()).candidates.find(item => item.id === id);
  const originalOther = JSON.stringify(untouched);

  // 没登录就不能重采：这是主人自己的决定，软件不接受匿名代办。
  const beforeLogin = await api.readBytes();
  assert.equal((await api.post(route('RECAPTURE-WAITING'), { dataRevision: waiting.dataRevision }, { authenticated: false })).status, 401);
  assert.deepEqual(await api.readBytes(), beforeLogin);
  await api.authenticate();
  assert.deepEqual(await api.readBytes(), beforeLogin, '登录本身不得改动业务数据');

  // 先把找货资料填好并选定两个规格：这是主人已经冻结过供货方案的那种情况，重采必须一并处理。
  const draftRoute = `/api/candidates/RECAPTURE-WAITING/lifecycle/supplier-draft`;
  const savedDraft = await api.post(draftRoute, draftInput(waiting.dataRevision));
  assert.equal(savedDraft.status, 200, JSON.stringify(savedDraft.body));
  const chosen = await api.post('/api/candidates/RECAPTURE-WAITING/lifecycle/sku-choice',
    { dataRevision: savedDraft.body.dataRevision, sourceSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  const frozen = await recordOf('RECAPTURE-WAITING');
  assert.deepEqual(frozen.sourceCapture.selectedSkuIds, ['sku-xl-yellow', 'sku-8xl-yellow']);
  assert.equal(frozen.sourceCapture.skuSelection.schemaVersion, 'source-capture-sku-selection-v1');
  const revision = frozen.dataRevision;

  // 封闭输入：修订号必须是整数，理由必须来自固定列表，任何多余字段（包括自由文本）一律拒绝；错的修订号是冲突不是猜测。
  const beforeRejections = await api.readBytes();
  for (const body of [
    {}, { dataRevision: String(revision) }, { dataRevision: revision, reason: 'because_i_want_to' },
    { dataRevision: revision, note: '重量没采到' }, { dataRevision: revision, reason: 'weight_missing', force: true }
  ]) {
    const rejected = await api.post(route('RECAPTURE-WAITING'), body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(rejected.body.code, 'source_capture_recapture_input_invalid');
  }
  const stale = await api.post(route('RECAPTURE-WAITING'), { dataRevision: revision - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'revision_conflict');
  assert.equal((await api.post(route('RECAPTURE-WAITING'), { dataRevision: revision },
    { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api.post(route('RECAPTURE-WAITING'), { dataRevision: revision },
    { headers: { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await api.post(route('RECAPTURE-MISSING'), { dataRevision: 1 })).status, 404);

  // 只有「已采到、等你选规格」放行。读停了的、从没采过的，都当场拒绝并说出当前是什么状态。
  const stopped = await recordOf('RECAPTURE-RUNNING');
  assert.equal(stopped.sourceCapture.status, 'failed', '启动对账会把上一个进程遗留的在跑记录收口成失败');
  const midFlight = await api.post(route('RECAPTURE-RUNNING'), { dataRevision: stopped.dataRevision });
  assert.equal(midFlight.status, 409);
  assert.equal(midFlight.body.code, 'source_capture_recapture_not_applicable');
  assert.match(midFlight.body.message, /当前采集状态：failed／作业状态：failed/u);
  const neverCaptured = await api.post(route('RECAPTURE-NEVER'),
    { dataRevision: (await recordOf('RECAPTURE-NEVER')).dataRevision });
  assert.equal(neverCaptured.status, 409);
  assert.equal(neverCaptured.body.code, 'source_capture_recapture_not_applicable');
  assert.match(neverCaptured.body.message, /还没有采到过这个1688页面/u);
  assert.deepEqual(await api.readBytes(), beforeRejections, '被拒绝的重采请求不得写入任何数据');

  // 真的重采一次。
  const again = await api.post(route('RECAPTURE-WAITING'), { dataRevision: revision, reason: 'weight_missing' });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  // 回执与「申请插件采集」一模一样，页面因此复用同一条开始信号，没有第二套采集流程。
  assert.equal(again.body.status, 'supplier_capture_job_queued');
  assert.equal(again.body.duplicate, false);
  assert.equal(again.body.dispatch, null);
  assert.equal(again.body.bStarted, false);
  assert.equal(again.body.c1Created, false);
  assert.equal(again.body.captureJob.status, 'queued');
  assert.equal(again.body.captureJob.requiredExtensionVersion, '1.3.0');
  assert.notEqual(again.body.captureJob.jobId, 'SCJ-synthetic-recapture-first');
  assert.match(again.body.captureJob.jobId, /^SCJ-/u);

  const requeued = await recordOf('RECAPTURE-WAITING');
  assert.equal(requeued.dataRevision, revision + 1);
  assert.equal(requeued.sourceCapture.status, 'waiting_extension');
  assert.equal(requeued.sourceCapture.jobStatus, 'queued');
  assert.equal(requeued.sourceCapture.captureId, again.body.captureJob.jobId);
  assert.equal(requeued.sourceCapture.attempt, 0);
  assert.equal(requeued.sourceCapture.writeOccurred, false);
  assert.equal(requeued.sourceCapture.businessStateEffect, 'unchanged');
  // 同一个已保存的1688链接，读的还是上一次真正读过的那个页面。
  assert.equal(requeued.sourceCapture.sourceUrl, OFFER_URL);
  assert.equal(requeued.sourceUrl, OFFER_URL);
  // 这次采到的规格和主人已经冻结的供货方案，随重采一起作废——不留一份指向旧规格的方案。
  assert.equal(requeued.sourceCapture.skuChoices, undefined);
  assert.equal(requeued.sourceCapture.selectedSkuIds, undefined);
  assert.equal(requeued.sourceCapture.skuSelection, undefined);
  // 历史里两句话在同一次写入里：建了作业，以及作废了什么。
  const queuedLine = requeued.history.filter(entry => entry.action === 'aSupplierCaptureJobQueued');
  const recaptureLine = requeued.history.filter(entry => entry.action === 'aSupplierCaptureRecaptureRequested');
  assert.equal(queuedLine.length, 1);
  assert.equal(recaptureLine.length, 1);
  assert.equal(queuedLine[0].at, recaptureLine[0].at);
  assert.match(recaptureLine[0].detail, /主人要求重新读一次这个1688页面（主人给的理由：上一次没采到重量）/u);
  assert.match(recaptureLine[0].detail, /上一次采到的3个规格已经作废/u);
  assert.match(recaptureLine[0].detail, /之前选定的2个规格已随重新采集作废，需要重新选/u);
  assert.match(recaptureLine[0].detail, /重新采集不下单、不联系供应商、不向平台写入任何内容/u);
  // 业务状态一律不动，也没有任何派发。
  assert.equal(requeued.workflowStatus, 'needs_user_data');
  assert.equal(requeued.lifecycleV11 ?? null, null);
  assert.equal(requeued.listingHandoff ?? null, null);
  const persisted = await api.readDocument();
  assert.deepEqual(persisted.dispatches ?? [], []);
  assert.equal(persisted.meta.automationStarted, false);
  assert.equal(JSON.stringify(persisted.candidates.find(item => item.id === 'RECAPTURE-OTHER')), originalOther);

  // 作业已经在跑了，就不能再重采一次：这条记录里已经没有可以作废的东西了。
  const beforeSecond = await api.readBytes();
  const second = await api.post(route('RECAPTURE-WAITING'), { dataRevision: requeued.dataRevision });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'source_capture_recapture_not_applicable');
  assert.match(second.body.message, /当前采集状态：waiting_extension／作业状态：queued/u);
  assert.deepEqual(await api.readBytes(), beforeSecond);

  // 选规格这一步也随之关上：没有采到的规格，就没有可以选的东西，页面不会拿旧规格再冻一份方案。
  const stillChoosing = await api.post('/api/candidates/RECAPTURE-WAITING/lifecycle/sku-choice',
    { dataRevision: requeued.dataRevision, sourceSkuIds: ['sku-xl-yellow'] });
  assert.equal(stillChoosing.status, 409);
  assert.equal(stillChoosing.body.code, 'sku_choice_not_available');

  // 一次只采一件：另一件同样等着选规格的商品这时候重采不了，用的是既有的那把采集控制锁，不是另开一条路。
  const other = await recordOf('RECAPTURE-OTHER');
  const busy = await api.post(route('RECAPTURE-OTHER'), { dataRevision: other.dataRevision });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.captureControl.candidateId, 'RECAPTURE-WAITING');
  assert.equal(JSON.stringify((await api.readDocument()).candidates.find(item => item.id === 'RECAPTURE-OTHER')), originalOther);

  await api.assertClean();
});

/**
 * 理由是可选的，而且这句历史从不多说一件没发生过的事：没选过规格的商品，重采时不会写「之前选定的 N 个已作废」。
 */
test('不给理由也能重新采集，历史只说这一次真正作废了什么', async t => {
  const api = await startRecaptureApi(t, fixture => [seedCandidate(fixture, 'RECAPTURE-PLAIN', waitingSourceCapture())]);
  await api.authenticate();
  const before = await api.readDocument();
  const candidate = before.candidates[0];
  assert.deepEqual(candidate.sourceCapture.selectedSkuIds, [], '这一件主人还没有选过规格');

  const plain = await api.post(recaptureRoute('RECAPTURE-PLAIN'), { dataRevision: candidate.dataRevision });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  assert.equal(plain.body.status, 'supplier_capture_job_queued');
  const record = (await api.readDocument()).candidates[0];
  assert.equal(record.sourceCapture.status, 'waiting_extension');
  assert.equal(record.sourceCapture.skuChoices, undefined);
  const line = record.history.filter(entry => entry.action === 'aSupplierCaptureRecaptureRequested');
  assert.equal(line.length, 1);
  assert.doesNotMatch(line[0].detail, /主人给的理由/u);
  assert.match(line[0].detail, /上一次采到的3个规格已经作废/u);
  assert.doesNotMatch(line[0].detail, /之前选定的/u, '没选过就不该说作废了几个选定');
  assert.match(line[0].detail, /重新采集不下单、不联系供应商、不向平台写入任何内容/u);
  assert.deepEqual((await api.readDocument()).dispatches ?? [], []);
  await api.assertClean();
});
