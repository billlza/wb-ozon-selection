import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { readyAuthorizationFamily, secondReadyMember } from './fixtures/sibling-batch-final-fixture.mjs';
import { stopApiProcess, allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const port = allocatedTestPorts().api;
const base = `http://127.0.0.1:${port}`;

test('owner batch stock API rejects stale or conflicting members without partial writes', async t => {
  const { source, parent, child } = readyAuthorizationFamily();
  const second = secondReadyMember(parent);
  const document = initialBusinessStateDocument({ now: source.args.serverClock() });
  document.candidates = [parent, child, second];
  const directory = await mkdtemp(path.join(tmpdir(), 'sibling-batch-commercial-api-'));
  const privateDirectory = path.join(directory, 'private');
  const businessDirectory = path.join(directory, 'business');
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(businessDirectory);
  const dataFile = path.join(businessDirectory, 'state.json');
  await writeFile(dataFile, JSON.stringify(document));
  const binding = { targetStore: child.targetStore, platform: child.targetPlatform, storeRef: child.storeRef };
  const stderr = [];
  const started = performance.now();
  const startup = { port, startedAt: new Date().toISOString(), listenAfterMs: null, connectionRefusals: 0,
    healthAttempts: 0, lastHealthStatus: null, stdoutBytes: 0 };
  let output = '';
  const server = spawn(process.execPath, [path.join(appDir, 'server.mjs'), '--api-only'], { cwd: appDir,
    env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password',
      SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, 'owner.json'),
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([binding]),
      SELECTION_REVIEW_AUTO_DELIVER: 'off', SELECTION_REVIEW_CODEX_DISPATCH: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => {
    startup.stdoutBytes += chunk.length;
    output = (output + String(chunk)).slice(-4096);
    if (output.includes(base) && startup.listenAfterMs === null) startup.listenAfterMs = Math.round(performance.now() - started);
  });
  server.stderr.on('data', chunk => stderr.push(String(chunk)));
  t.after(async () => {
    await stopApiProcess(server);
    console.log('API_CLEANUP ' + JSON.stringify({ pid: server.pid, exitCode: server.exitCode, signalCode: server.signalCode }));
  });
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`API_START_FAILED:${stderr.join('').slice(-1000)}`);
    startup.healthAttempts += 1;
    try {
      const response = await fetch(`${base}/api/health`);
      startup.lastHealthStatus = response.status;
      await response.arrayBuffer();
      if (response.ok) { healthy = true; break; }
    }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; startup.connectionRefusals += 1; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  console.log('API_STARTUP ' + JSON.stringify({ ...startup, pid: server.pid, healthy, observedAfterMs: Math.round(performance.now() - started) }));
  assert.equal(healthy, true, stderr.join(''));
  let cookie = '';
  async function post(body, origin = base) {
    const response = await fetch(`${base}/api/sibling-batches/commercial-drafts`, { method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    members: [child, second].map((candidate, index) => ({ candidateId: candidate.id,
      expectedRevision: candidate.dataRevision, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
      merchantSku: candidate.lifecycleV11.productionCommercialDraftV1.merchantSku, stock: 70 + index })) };
  const before = await readFile(dataFile, 'utf8');
  assert.ok([401, 403].includes((await post(input)).status));
  assert.equal(await readFile(dataFile, 'utf8'), before);
  const setup = await fetch(`${base}/api/owner-access/setup`, { method: 'POST',
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'synthetic batch stock test password' }) });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get('set-cookie').split(';')[0];
  const execution = await fetch(`${base}/api/sibling-batches/${encodeURIComponent(parent.id)}/execution`, {
    headers: { Cookie: cookie } });
  assert.equal(execution.status, 200);
  assert.deepEqual(await execution.json(), { executionView: null });
  assert.equal((await post(input, 'https://other.example.test')).status, 403);
  const stale = structuredClone(input);
  stale.members[1].expectedRevision -= 1;
  assert.equal((await post(stale)).status, 409);
  const duplicate = structuredClone(input);
  duplicate.members[1].merchantSku = duplicate.members[0].merchantSku;
  assert.equal((await post(duplicate)).status, 422);
  assert.equal(await readFile(dataFile, 'utf8'), before);
  const saved = await post(input);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.members.length, 2);
  const after = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.deepEqual(after.candidates.slice(1).map(candidate => candidate.lifecycleV11.productionCommercialDraftV1.stock), [70, 71]);
  assert.deepEqual(after.candidates[0], parent);
  const again = await post(input);
  assert.equal(again.status, 409);
  assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')).candidates, after.candidates);
  assert.equal(stderr.join(''), '');
});
