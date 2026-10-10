import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInitialCandidate } from '../lib/candidate-initialization.mjs';
import { collectMockOzonSalesSnapshot } from '../lib/sales-snapshot.mjs';
import { SYNTHETIC_STORE_REF } from './fixtures/store-binding-fixture.mjs';
import { stopApiProcess } from './helpers/api-process-lifecycle.mjs';
import { authorizedProductionFixture } from './helpers/c2-software-fixture.mjs';
import { normalizeProductionEntities, PRODUCTION_ENTITY_REFERENCE_VERSION } from '../lib/production-entity-storage.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error('TEST_REQUIRES_ISOLATED_PORT');
const base = `http://127.0.0.1:${port}`;
const supplierSkuId = '6222816678023';
const originalSkuId = '6222816678021';
const secondSkuId = '6222816678020';
const at = '2026-09-24T12:00:00.000Z';
const binding = { targetStore: 'dandanshu', platform: 'ozon', storeRef: SYNTHETIC_STORE_REF };

function sourceCandidate() {
  const parent = createInitialCandidate({ input: { targetStore: 'dandanshu', productName: '合成背心',
    sourceUrl: 'https://detail.1688.com/offer/1038877014153.html' }, source: 'user', id: 'SYNTHETIC-VEST-PARENT',
  timestamp: at, storeBindings: [binding] });
  parent.dataRevision = 12;
  parent.sourceCapture = { captureId: 'synthetic:capture', mode: 'a_supplier_capture',
    status: 'captured_waiting_owner_selection', sourceUrl: parent.sourceUrl, offerId: '1038877014153',
    title: '合成背心', observedAt: at, collectionMethod: 'synthetic_fixture', titleSource: 'page', offerIdSource: 'url',
    priceRanges: [], pageFields: {}, supplierAttributes: { 材质: '牛津布' },
    selectedSkuIds: [supplierSkuId, secondSkuId, originalSkuId], skuChoices: [
      { sourceSkuId: supplierSkuId, variantName: '黑cp', attributes: { 颜色: '黑cp' } },
      { sourceSkuId: secondSkuId, variantName: 'CP', attributes: { 颜色: 'CP' } },
      { sourceSkuId: originalSkuId, variantName: '卡其色', attributes: { 颜色: '卡其色' } }
    ] };
  parent.salesSnapshotsV11 = [collectMockOzonSalesSnapshot({ sourceMode: 'mock_ozon_fixture',
    snapshotId: 'synthetic:sales', marketScope: 'unknown', sellerType: 'unknown',
    sellerIdentityEvidence: { status: 'unverified', signals: [], evidenceRef: 'synthetic:seller' },
    productUrl: 'https://www.ozon.ru/product/1234567890/', title: '合成背心', imageRefs: [], currentPrice: 900,
    currency: 'RUB', categoryPath: '宠物用品', attributes: {}, collectedAt: at, evidenceRef: 'synthetic:sales' })];
  parent.supplierDraftV1 = { offerId: '1038877014153', goodsPriceRmb: 18, packedWeightKg: 0.2,
    domesticShippingRmb: 0, allInPurchaseRmb: 18, dimensionsCm: { length: 20, width: 15, height: 4 }, targetSalePriceRub: 900 };
  parent.skuUniformSupplyV1 = { schemaVersion: 'candidate-sku-uniform-supply-v1', declaredBy: 'owner',
    captureId: parent.sourceCapture.captureId, sourceSkuIds: [supplierSkuId, secondSkuId, originalSkuId],
    sourceRef: 'synthetic:owner-declaration', basisAtDeclaration: { goodsPriceRmb: 18, packedWeightKg: 0.2 } };
  const authorized = authorizedProductionFixture({ candidateId: parent.id, supplierSkuId: originalSkuId,
    storeRef: SYNTHETIC_STORE_REF, sourceCandidateRevision: 11 });
  const sku = structuredClone(authorized.skuPackage);
  sku.dSoftwareExecution = { checkpoints: [{ kind: 'import_task_received', taskId: 'synthetic-task' }],
    attempt: { request: { productImport: { body: { items: [{ description_category_id: 17028665, type_id: 92935,
      attributes: [{ id: 9048, values: [{ value: 'SYNTHETIC-MODEL' }] },
        { id: 85, values: [{ value: 'Нет бренда' }] }] }] } } } } };
  parent.lifecycleV11 = { skuPackage: sku };
  const normalized = normalizeProductionEntities(parent, { candidateId: parent.id });
  assert.equal(normalized.value.lifecycleV11.skuPackage.productionAuthorization.schemaVersion,
    PRODUCTION_ENTITY_REFERENCE_VERSION);
  return { parent: normalized.value, productionEntityRecords: normalized.records };
}

test('owner-only sibling API creates one persistent A branch; replay, conflicts and job isolation hold', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sibling-sku-api-'));
  const privateDirectory = path.join(directory, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const businessDirectory = path.join(directory, 'business');
  await mkdir(businessDirectory);
  const dataFile = path.join(businessDirectory, 'state.json');
  const { parent, productionEntityRecords } = sourceCandidate();
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [parent], productionEntityRecords, dispatches: [], nodeDispatches: [], evidencePacks: [],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } }));
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, 'server.mjs'), '--api-only'], { cwd: appDir,
    env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password',
      SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, 'owner.json'),
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([binding]),
      SELECTION_REVIEW_AUTO_DELIVER: 'off', SELECTION_REVIEW_CODEX_DISPATCH: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('API_START_TIMEOUT')), 15000);
    let output = '';
    const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join('').slice(-1000)}`));
    function done(error) { clearTimeout(timer); child.stdout.off('data', onData); child.off('error', done);
      child.off('exit', onExit); if (error) reject(error); else resolve(); }
    child.stdout.on('data', onData); child.once('error', done); child.once('exit', onExit);
  });
  const route = `/api/candidates/${parent.id}/sibling-sku`;
  const input = { dataRevision: 12, supplierSkuId };
  let cookie = '';
  async function post(uri, body, origin = base) {
    const response = await fetch(`${base}${uri}`, { method: 'POST', headers: { Origin: origin,
      'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const before = await readFile(dataFile, 'utf8');
  const anonymous = await post(route, input);
  assert.ok([401, 403].includes(anonymous.status));
  assert.equal(await readFile(dataFile, 'utf8'), before);
  const setup = await post('/api/owner-access/setup', { password: 'synthetic sibling test password' });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  cookie = setup.cookie.split(';')[0];
  const crossOrigin = await post(route, input, 'https://other.example.test');
  assert.equal(crossOrigin.status, 403);
  assert.equal(await readFile(dataFile, 'utf8'), before);
  const created = await post(route, input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.created, true);
  const saved = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.deepEqual(saved.candidates.find(candidate => candidate.id === parent.id), parent);
  const sibling = saved.candidates.find(candidate => candidate.id !== parent.id);
  assert.equal(sibling.siblingSourceV1.supplierSkuId, supplierSkuId);
  assert.equal(sibling.productName, `原商品同款：合成背心 · 供应商原色 黑cp · SKU ${supplierSkuId}`);
  assert.equal(sibling.lifecycleV11, undefined);
  assert.equal(saved.candidates.length, 2);
  assert.equal(saved.dispatches.length, 0);
  assert.equal(saved.runtime.softwareJobs.length, 0);
  const after = await readFile(dataFile, 'utf8');
  const replays = await Promise.all([post(route, input), post(route, input)]);
  for (const replay of replays) {
    assert.equal(replay.status, 200);
    assert.equal(replay.body.candidate.id, sibling.id);
  }
  for (const different of [{ ...input, productName: '另一个名称' }, { ...input, dataRevision: 11 },
    { ...input, supplierSkuId: originalSkuId }]) {
    const rejected = await post(route, different);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  }
  assert.equal(await readFile(dataFile, 'utf8'), after);
  const batchRoute = `/api/candidates/${parent.id}/sibling-sku-batch`;
  const batchInput = { dataRevision: 12, supplierSkuIds: [supplierSkuId, secondSkuId] };
  const prepared = await post(batchRoute, batchInput);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  assert.equal(prepared.body.createdCount, 1);
  assert.equal(prepared.body.status, 'a_preparation_only');
  const batchSaved = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.deepEqual(batchSaved.candidates.filter(candidate => candidate.siblingSourceV1).map(candidate => candidate.siblingSourceV1.supplierSkuId).sort(),
    [supplierSkuId, secondSkuId].sort());
  assert.equal(batchSaved.runtime.softwareJobs.length, 0);
  const replayBatch = await post(batchRoute, batchInput);
  assert.equal(replayBatch.status, 200);
  assert.equal(replayBatch.body.createdCount, 0);
  const beforeInvalid = await readFile(dataFile, 'utf8');
  assert.equal((await post(batchRoute, { dataRevision: 12, supplierSkuIds: [originalSkuId] })).status, 409);
  assert.equal(await readFile(dataFile, 'utf8'), beforeInvalid);
  const aRoute = `/api/candidates/${parent.id}/sibling-batch-a-confirm`;
  const aInvalid = await post(aRoute, { parentCandidateId: parent.id, parentRevision: 12,
    shared: {}, members: [] });
  assert.equal(aInvalid.status, 400);
  assert.equal(aInvalid.body.code, 'SIBLING_BATCH_A_INPUT_INVALID');
  assert.equal(await readFile(dataFile, 'utf8'), beforeInvalid);
  assert.equal((await post(aRoute, { parentCandidateId: parent.id }, 'https://other.example.test')).status, 403);
  assert.equal(await readFile(dataFile, 'utf8'), beforeInvalid);
  assert.equal(stderr.join(''), '');
});
