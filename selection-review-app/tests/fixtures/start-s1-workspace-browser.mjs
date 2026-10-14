import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { threeColorFixture } from './sibling-batch-final-family-fixture.mjs';
import { startSavedDEApi } from '../helpers/d-e-saved-api-fixture.mjs';
import { stopApiProcess, allocatedTestPorts } from '../helpers/api-process-lifecycle.mjs';
import { writeSyntheticSiblingPreparationCatalog } from './sibling-preparation-catalog-fixture.mjs';

const appDirectory = fileURLToPath(new URL('../..', import.meta.url));
const {api:apiPort,second:browserPort}=allocatedTestPorts();
const browserOrigin = `http://127.0.0.1:${browserPort}`;
const cleanups = [];
const testContext = { after: callback => cleanups.push(callback) };
const fixture = await threeColorFixture();
const document = await fixture.repository.readSnapshot();
const parent = document.candidates[0];
const directory=await mkdtemp(path.join(tmpdir(),'s1-workspace-browser-'));
await writeSyntheticSiblingPreparationCatalog({document,tempDir:directory});
const api=await startSavedDEApi(testContext, { directory, catalogDirectory:directory,
  port: apiPort, document, binding: { storeRef: parent.storeRef, platform: parent.targetPlatform },
  productionBindings: [], browserOrigin });
await api.authenticate();
const vite = spawn(process.execPath, [path.join(appDirectory, 'node_modules/vite/bin/vite.js'),
  '--config', path.join(appDirectory, 'tests/fixtures/sibling-batch-c1-vite.config.mjs'), '--configLoader','native',
  '--host', '127.0.0.1', '--port', String(browserPort), '--strictPort'],
{ cwd: appDirectory, env: { ...process.env,SELECTION_REVIEW_S1_BROWSER_FIXTURE:'1',
  SELECTION_REVIEW_S1_BROWSER_STATE_FILE:api.dataFile }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += chunk; process.stdout.write(chunk); });
vite.stderr.on('data', chunk => { viteOutput += chunk; process.stderr.write(chunk); });
async function waitForBrowser() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error(`SIBLING_BATCH_BROWSER_VITE_FAILED:${viteOutput}`);
    try {
      const response = await fetch(`${browserOrigin}/tests/fixtures/s1-workspace-browser.html`);
      if (response.ok) return;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('SIBLING_BATCH_BROWSER_START_TIMEOUT');
}
async function stopVite(parentSignal = null) {
  const wasRunning = vite.exitCode === null && vite.signalCode === null;
  try { await stopApiProcess(vite); }
  catch (error) {
    // Vite converts our planned SIGTERM into exit code 143 instead of reporting a signal.
    if ((wasRunning || parentSignal==='SIGTERM') && vite.exitCode === 143 && vite.signalCode === null &&
        error.message === 'API_PROCESS_EXIT_FAILED: code=143, signal=null') return;
    // An interactive Ctrl-C reaches the parent and Vite in the same terminal group.
    if (parentSignal === 'SIGINT' && vite.exitCode === null && vite.signalCode === 'SIGINT' &&
        error.message === 'API_PROCESS_EXIT_FAILED: code=null, signal=SIGINT') return;
    throw error;
  }
}
async function closeFixture(parentSignal = null) {
  const errors = [];
  try { await stopVite(parentSignal); }
  catch (error) { errors.push(error); }
  try { await api.assertClean(); }
  catch (error) { errors.push(error); }
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'SIBLING_BATCH_BROWSER_CLEANUP_FAILED');
}
try { await waitForBrowser(); }
catch (error) {
  try { await closeFixture(); }
  catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'SIBLING_BATCH_BROWSER_START_AND_CLEANUP_FAILED');
  }
  throw error;
}
process.stdout.write(`S1 actual software test: ${browserOrigin}/tests/fixtures/s1-workspace-browser.html\n`);
process.stdout.write('Press Ctrl-C to stop and remove the temporary synthetic state.\n');
let stopping = false;
async function stop(parentSignal) {
  if (stopping) return;
  stopping = true;
  await closeFixture(parentSignal);
  process.exitCode = 0;
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
