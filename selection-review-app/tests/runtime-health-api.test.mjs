import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stopApiProcess } from './helpers/api-process-lifecycle.mjs';
import { productionOwnerDecisionHttpFixture } from './helpers/d-e-saved-api-fixture.mjs';
import { runtimeReadinessHistoryFixture } from './fixtures/runtime-readiness-history-fixture.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || [4317, 4318, 4173].includes(port)) throw new Error('TEST_REQUIRES_ISOLATED_PORT');
const base = `http://127.0.0.1:${port}`;

async function start(t, { large = false, polling = false, observeWorkers = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-health-api-'));
  const dataFile = path.join(directory, 'business', 'state.json'), probe = path.join(directory, 'probe.json'), preload = path.join(directory, 'probe.mjs');
  await mkdir(path.join(directory, 'business'));
  await mkdir(path.join(directory, 'private'), { mode: 0o700 });
  const fixture = await productionOwnerDecisionHttpFixture();
  const document = large ? (await runtimeReadinessHistoryFixture({ storeRef: fixture.binding.storeRef })).document : { meta: { version: 2, automationStarted: false }, rules: {}, dispatches: [],
    candidates: Array.from({ length: large ? 65 : 1 }, (_, index) => ({ id: `SYNTHETIC-HEALTH-${index}`, dataRevision: 7,
      productName: '合成健康测试商品', targetPlatform: 'ozon', targetStore: fixture.binding.storeRef.stableStoreId,
      storeRef: fixture.binding.storeRef, workflowStatus: 'listing_preparation', history: [],
      ...(large ? { frozenEvidenceText: 'x'.repeat(256000) } : {}) })),
    runtime: { softwareJobs: [{ schemaVersion: 'software-job-v1', jobId: 'synthetic-health-unknown',
      candidateId: 'SYNTHETIC-HEALTH-0', skuPackageId: 'synthetic-health-package', revision: 7,
      jobType: 'd_production_execution', status: 'unknown_outcome', externalRequestState: 'unknown_outcome' }] } };
  const original = Buffer.from(JSON.stringify(document));
  if (large) assert.ok(original.length >= 16755632, String(original.length));
  await writeFile(dataFile, original);
  await writeFile(probe, JSON.stringify({ reads: 0, network: 0, credentials: 0,
    workerStarts: 0, workerExits: 0, workerActive: 0, workerPeak: 0 }));
  // Observe the real configured consumers; never grant an external operation.
  await writeFile(preload, `import fs from 'node:fs/promises';import cp from 'node:child_process';import workerThreads from 'node:worker_threads';import {writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const counts={reads:0,network:0,credentials:0,workerStarts:0,workerExits:0,workerActive:0,workerPeak:0};const save=()=>writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));
const read=fs.readFile;fs.readFile=async function(file,...args){if(String(file)===${JSON.stringify(dataFile)}){counts.reads++;save();}return read.call(this,file,...args);};
if(${observeWorkers}){const NativeWorker=workerThreads.Worker;workerThreads.Worker=class extends NativeWorker{constructor(...args){super(...args);counts.workerStarts++;counts.workerActive++;counts.workerPeak=Math.max(counts.workerPeak,counts.workerActive);save();this.once('exit',()=>{counts.workerExits++;counts.workerActive--;save();});}};}
cp.execFile=()=>{counts.credentials++;save();throw new Error('UNEXPECTED_TEST_CREDENTIAL_READ');};syncBuiltinESMExports();
globalThis.fetch=async()=>{counts.network++;save();throw new Error('UNEXPECTED_TEST_EXTERNAL_REQUEST');};`);
  const connector = { provider: 'linkfox', bindingId: 'route:synthetic-health', configurationVersion: 'version:1',
    gatewayOrigin: 'https://tool-gateway.linkfox.com', credentialAlias: 'synthetic-health-linkfox',
    contractVersion: 'linkfox-discovery-93a1dbf-v1', allowedMethods: ['ozon_market_search'], timeoutMs: 1000, budgetPolicyRef: 'budget:synthetic-health' };
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
    SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
    SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password', SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(directory, 'private', 'owner.json'),
    SELECTION_REVIEW_CODEX_DISPATCH: 'off', SELECTION_REVIEW_AUTO_DELIVER: 'off', SELECTION_REVIEW_INITIALIZE_STATE: 'false',
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: fixture.binding.storeRef.stableStoreId, platform: 'ozon', storeRef: fixture.binding.storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([fixture.binding]),
    SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify(polling ? [fixture.service] : []),
    SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: JSON.stringify({ policies: [], pumpIntervalMs: polling ? 1000 : null }),
    ...(polling ? { SELECTION_REVIEW_E_READBACK_PUMP_INTERVAL_MS: '1000' } : {}),
    SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON: JSON.stringify(polling ? [{ schemaVersion: 'c1-keyword-service-binding-v1',
      serviceId: 'service:synthetic-health-keyword', configurationVersion: '1', provider: 'seerfar_open_api',
      workerId: 'worker:synthetic-health-keyword', workerVersion: '1', leaseDurationMs: 60000, pumpIntervalMs: 1000, requestTimeoutMs: 1000 }] : []),
    SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: JSON.stringify(polling ? [connector] : []),
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: JSON.stringify(polling ? [{ schemaVersion: 'a-discovery-service-binding-v1',
      serviceId: 'service:synthetic-health-a', configurationVersion: 'version:1', connectorBindingId: connector.bindingId,
      connectorConfigurationVersion: connector.configurationVersion, workerId: 'worker:synthetic-health-a', workerVersion: 'version:1',
      leaseDurationMs: 60000, pumpIntervalMs: 1000 }] : []),
    SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: JSON.stringify(polling ? [{
      credentialAlias: connector.credentialAlias, keychainService: 'synthetic-health-absent-service', keychainAccount: 'synthetic-health-absent-account' }] : []) };
  if (!polling) delete env.SELECTION_REVIEW_E_READBACK_PUMP_INTERVAL_MS;
  const child = spawn(process.execPath, [path.join(appDir, 'server.mjs'), '--api-only'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const errors = []; child.stderr.on('data', chunk => errors.push(String(chunk)));
  t.after(async () => { try { await stopApiProcess(child); } finally { await rm(directory, { recursive: true, force: true }); } });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => finish(new Error('HEALTH_API_START_TIMEOUT')), 20000);
    const data = chunk => { output += chunk; if (output.includes(base)) finish(); };
    const exit = (code, signal) => finish(new Error(`HEALTH_API_START_FAILED:${code}:${signal}:${errors.join('').slice(-1000)}`));
    function finish(error) { clearTimeout(timer); child.stdout.off('data', data); child.off('exit', exit); child.off('error', finish); error ? reject(error) : resolve(); }
    child.stdout.on('data', data); child.once('error', finish); child.once('exit', exit);
  });
  return { dataFile, probe, original, document, errors, async get(route) {
    const started = performance.now(); const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(6500) });
    const body = await response.json(); const durationMs = performance.now() - started;
    console.log(JSON.stringify({ readinessRequest: { route, status: response.status, durationMs, code: body.readiness?.code ?? body.code ?? null } }));
    if (response.ok) assert.ok(durationMs < 4000, `Four-second gate failed: ${durationMs}`);
    return { status: response.status, body, durationMs };
  } };
}

test('fresh readiness preserves unknown outcomes and all bytes under 16.8MB state and real one-second A/keyword/D/E consumers', async t => {
  const api = await start(t, { large: true, polling: true });
  const before = JSON.parse(await readFile(api.probe, 'utf8')).reads;
  await new Promise(resolve => setTimeout(resolve, 2200));
  const durations = [];
  for (const route of ['/api/live', '/api/ready', '/api/health', '/api/ready']) {
    const result = await api.get(route); assert.equal(result.status, 200, JSON.stringify(result.body)); durations.push(result.durationMs);
    if (route === '/api/live') { assert.equal(result.body.live, true); assert.equal(Object.hasOwn(result.body, 'dataVersion'), false); }
    else { assert.equal(result.body.ready, true); assert.equal(result.body.dataVersion, 2); assert.equal(result.body.readiness.fresh, true); }
  }
  const counts = JSON.parse(await readFile(api.probe, 'utf8'));
  assert.ok(counts.reads >= before + 4, `Configured polling did not execute: ${JSON.stringify(counts)}`);
  assert.equal(counts.network, 0); assert.equal(counts.credentials, 0);
  assert.deepEqual(await readFile(api.dataFile), api.original);
  assert.equal(JSON.parse(await readFile(api.dataFile, 'utf8')).runtime.softwareJobs.at(-1).status, 'unknown_outcome');
  assert.deepEqual(api.errors, []);
  console.log(JSON.stringify({ healthPerformance: { bytes: api.original.length, candidates: 65, pumpIntervalMs: 1000, durationsMs: durations, backgroundReads: counts.reads - before, externalRequests: 0, dataChanged: false } }));
});

test('corrupt, missing, wrong-version and invalid production records cannot report ready or reuse healthy state', async t => {
  const api = await start(t);
  assert.equal((await api.get('/api/health')).body.ok, true);
  const cases = ['{', JSON.stringify({ meta: { version: 1 }, candidates: [] }),
    JSON.stringify({ meta: { version: 2 }, candidates: [], productionEntityRecords: [{}] })];
  for (const bytes of cases) {
    await writeFile(api.dataFile, bytes); const failed = await api.get('/api/health');
    assert.equal(failed.status, 503); assert.equal(failed.body.ready, false); assert.equal(failed.body.dataVersion, null);
    assert.equal(JSON.stringify(failed.body).includes(api.dataFile), false);
    assert.equal((await api.get('/api/live')).body.live, true);
    assert.equal(await readFile(api.dataFile, 'utf8'), bytes);
  }
  await rm(api.dataFile); const missing = await api.get('/api/ready'); assert.equal(missing.status, 503);
  await assert.rejects(readFile(api.dataFile), error => error.code === 'ENOENT');
  const replacement = `${api.dataFile}.replacement`; await writeFile(replacement, api.original); await rename(replacement, api.dataFile);
  assert.equal((await api.get('/api/ready')).body.ready, true);
  assert.deepEqual(await readFile(api.dataFile), api.original);
  const counts = JSON.parse(await readFile(api.probe, 'utf8')); assert.equal(counts.network, 0); assert.equal(counts.credentials, 0);
});

test('one live server rejects overlapping readiness with BUSY and starts fresh workers after success and failure', async t => {
  const api = await start(t, { observeWorkers: true });
  const counts = async () => JSON.parse(await readFile(api.probe, 'utf8'));
  const concurrent = () => Promise.all(['/api/health', '/api/ready', '/api/health'].map(route => api.get(route)));
  const assertReady = result => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.ready, true);
    assert.equal(result.body.dataVersion, 2);
    assert.equal(result.body.readiness.fresh, true);
    assert.ok(Number.isFinite(result.body.readiness.durationMs) && result.body.readiness.durationMs >= 0 &&
      result.body.readiness.durationMs < 4000, JSON.stringify(result.body.readiness));
  };
  const assertBusy = result => {
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.code, 'RUNTIME_READINESS_BUSY');
    assert.equal(result.body.ok, false);
    assert.equal(result.body.ready, false);
    assert.equal(result.body.dataVersion, null);
    assert.equal(JSON.stringify(result.body).includes(api.dataFile), false);
  };
  const assertReleased = (before, after) => {
    assert.equal(after.workerStarts, before.workerStarts + 1, 'Only the admitted request may start a native worker');
    assert.equal(after.workerExits, before.workerExits + 1);
    assert.equal(after.workerActive, 0, 'HTTP completion must follow worker termination');
    assert.equal(after.workerPeak, 1, 'Readiness must keep one worker at most');
  };

  assert.equal((await api.get('/api/live')).body.live, true);
  assert.equal((await counts()).workerStarts, 0, 'Liveness does not start a readiness worker');
  for (let round = 0; round < 2; round++) {
    const before = await counts();
    const results = await concurrent();
    const successful = results.filter(result => result.status === 200);
    const busy = results.filter(result => result.body.code === 'RUNTIME_READINESS_BUSY');
    assert.equal(successful.length, 1, JSON.stringify(results));
    assert.equal(busy.length, 2, JSON.stringify(results));
    assertReady(successful[0]);
    for (const result of busy) assertBusy(result);
    assertReleased(before, await counts());
    assert.deepEqual(await readFile(api.dataFile), api.original);
  }

  await writeFile(api.dataFile, '{');
  const beforeFailure = await counts();
  const failed = await concurrent();
  const busy = failed.filter(result => result.body.code === 'RUNTIME_READINESS_BUSY');
  const invalid = failed.filter(result => result.body.code === 'RUNTIME_READINESS_DATA_INVALID');
  assert.equal(busy.length, 2, JSON.stringify(failed));
  assert.equal(invalid.length, 1, JSON.stringify(failed));
  assert.equal(failed.filter(result => result.status === 200).length, 0);
  for (const result of busy) assertBusy(result);
  assert.equal(invalid[0].status, 503);
  assert.equal(invalid[0].body.ok, false);
  assert.equal(invalid[0].body.ready, false);
  assert.equal(invalid[0].body.dataVersion, null);
  assert.equal(JSON.stringify(invalid[0].body).includes(api.dataFile), false);
  assertReleased(beforeFailure, await counts());
  assert.equal(await readFile(api.dataFile, 'utf8'), '{', 'Readiness must preserve the failing file');
  assert.equal((await api.get('/api/live')).body.live, true);

  const replacement = `${api.dataFile}.replacement`;
  await writeFile(replacement, api.original);
  await rename(replacement, api.dataFile);
  for (const route of ['/api/health', '/api/ready']) {
    const before = await counts();
    assertReady(await api.get(route));
    assertReleased(before, await counts());
  }
  assert.deepEqual(await readFile(api.dataFile), api.original);
  const stored = JSON.parse(await readFile(api.dataFile, 'utf8'));
  assert.deepEqual(stored.runtime.softwareJobs, api.document.runtime.softwareJobs);
  assert.equal(stored.runtime.softwareJobs[0].status, 'unknown_outcome');
  const final = await counts();
  assert.equal(final.workerStarts, 5);
  assert.equal(final.workerExits, final.workerStarts);
  assert.equal(final.workerActive, 0);
  assert.equal(final.network, 0);
  assert.equal(final.credentials, 0);
  assert.deepEqual(api.errors, []);
});
