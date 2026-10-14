/** Validate actual configuration keys on a quiescent copy, inside an OS sandbox. */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createLocalProcessSandboxProfile } from './local-process-sandbox-profile.mjs';

const failure = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const observableServiceCodes = ['RUNTIME_CONFIGURATION_INVALID', 'OWNER_IDENTITY_STORAGE_PERMISSIONS',
  'OWNER_IDENTITY_STORAGE_INVALID', 'OWNER_IDENTITY_READ_FAILED', 'ENOENT', 'EPERM', 'EACCES',
  'EADDRINUSE', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'GUOO_TARIFF_VERSION_MISSING'];

async function boundedCompletion(completion, milliseconds) {
  let timer;
  try {
    return await Promise.race([completion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('RUNTIME_PREFLIGHT_SHUTDOWN_TIMEOUT')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function observeServer(child) {
  let settled = null, failed = false;
  const completion = new Promise(resolve => {
    child.on('error', () => {
      failed = true;
      // An error after spawn can mean signal failure, not process termination.
      if (child.pid === undefined) { settled = { startupError: true }; resolve(settled); }
    });
    child.once('close', (code, signal) => { settled ??= { code, signal }; resolve(settled); });
  });
  return { completion, current: () => settled, failed: () => failed };
}

async function stopServer(child, observation) {
  if (observation.current()) return { ...observation.current(), exitedBeforeStop: true };
  if (!child.kill('SIGTERM')) throw failure('RUNTIME_PREFLIGHT_SIGNAL_FAILED');
  try { return { ...await boundedCompletion(observation.completion, 5000), exitedBeforeStop: false }; }
  catch (error) {
    if (error.code !== 'RUNTIME_PREFLIGHT_SHUTDOWN_TIMEOUT') throw error;
    if (!child.kill('SIGKILL')) throw failure('RUNTIME_PREFLIGHT_SIGNAL_FAILED');
    await boundedCompletion(observation.completion, 1000);
    throw error;
  }
}

function assertQuiescent(bytes, environment) {
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw failure('RUNTIME_PREFLIGHT_DATA_INVALID'); throw error; }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw failure('RUNTIME_PREFLIGHT_DATA_INVALID');
  const jobs = document.runtime?.softwareJobs;
  if (jobs !== undefined && (!Array.isArray(jobs) || jobs.some(job => job === null || typeof job !== 'object' ||
      Array.isArray(job) || typeof job.status !== 'string'))) throw failure('RUNTIME_PREFLIGHT_JOBS_INVALID');
  if (document.meta?.automationStarted !== false ||
      (jobs && jobs.some(job => !['completed', 'failed', 'unknown_outcome', 'cancelled'].includes(job.status))) ||
      environment.SELECTION_REVIEW_CODEX_DISPATCH !== 'off' || environment.SELECTION_REVIEW_AUTO_DELIVER !== 'off') {
    throw failure('RUNTIME_PREFLIGHT_REQUIRES_QUIESCENT_COPY');
  }
}

/** No configuration values or service diagnostics are emitted or persisted. Never deploys. */
export async function verifyRuntimePackage({ appDirectory, dataCopy, port, homeDirectory = homedir() }) {
  if (process.platform !== 'darwin') throw failure('RUNTIME_PREFLIGHT_REQUIRES_MACOS_SANDBOX');
  if (![appDirectory, dataCopy, homeDirectory].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw failure('RUNTIME_PREFLIGHT_ABSOLUTE_PATH_REQUIRED');
  }
  const packageRoot = await fs.realpath(appDirectory), inputFile = await fs.realpath(dataCopy);
  const plistFile = path.join(homeDirectory, 'Library/LaunchAgents/com.shuaizhang.selection-review-app.plist');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistFile],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const environment = plist.EnvironmentVariables;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      Object.values(environment).some(value => typeof value !== 'string')) throw failure('RUNTIME_PREFLIGHT_ENVIRONMENT_INVALID');
  const liveFiles = [path.join(homeDirectory, 'Library/Application Support/今日选品评审台/data/candidates.json')];
  if (environment.SELECTION_REVIEW_DATA_FILE !== undefined) {
    if (!path.isAbsolute(environment.SELECTION_REVIEW_DATA_FILE)) throw failure('RUNTIME_PREFLIGHT_CONFIGURATION_FILE_INVALID');
    liveFiles.push(environment.SELECTION_REVIEW_DATA_FILE);
  }
  // Reject default and configured live identities, including symlinks/hard links, before reading the input.
  const inputStat = await fs.stat(inputFile);
  if (!inputStat.isFile()) throw failure('RUNTIME_PREFLIGHT_COPY_REQUIRED');
  for (const liveFile of liveFiles) {
    let liveStat;
    try { liveStat = await fs.stat(liveFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (inputFile === path.resolve(liveFile) || liveStat && inputStat.dev === liveStat.dev && inputStat.ino === liveStat.ino) {
      throw failure('RUNTIME_PREFLIGHT_COPY_REQUIRED');
    }
  }
  const originalBytes = await fs.readFile(inputFile);
  assertQuiescent(originalBytes, environment);
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'runtime-preflight-')));
  let child = null, observation, interrupted = false, diagnosticBytes = 0, diagnosticLimitExceeded = false;
  let listening = false, stdoutTail = '';
  let serviceFailureCode = null, stderrTail = '';
  let removeCopy = true;
  let receipt, primaryError, cleanupError;
  const controller = new AbortController();
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    // The single server can create readiness Worker threads, but cannot create subprocesses.
    const profile = createLocalProcessSandboxProfile({ writableRoot: root,
      readOnlyDirectories: [packageRoot, path.dirname(process.execPath)], ports: [port] }) + '\n(deny process-fork)';
    const stateDirectory = path.join(root, 'state'), identityDirectory = path.join(root, 'identity');
    await fs.mkdir(stateDirectory, {mode:0o700}); await fs.mkdir(identityDirectory, {mode:0o700});
    const copyFile = path.join(stateDirectory, 'state.json');
    await fs.writeFile(copyFile, originalBytes, { flag: 'wx', mode: 0o600 });
    const copiedEnvironment = { ...environment };
    const settingsDirectory = path.join(root, 'settings'); await fs.mkdir(settingsDirectory, {mode:0o700});
    for (const key of ['SELECTION_REVIEW_WORKFLOW_MAP_FILE', 'SELECTION_REVIEW_GUOO_TARIFF_FILE', 'SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE']) {
      if (!Object.hasOwn(environment, key)) continue;
      const source = await fs.realpath(environment[key]);
      if (!(await fs.stat(source)).isFile()) throw failure('RUNTIME_PREFLIGHT_CONFIGURATION_FILE_INVALID');
      // The tariff filename carries its rule version; preserve names while isolating each setting.
      const settingRoot = path.join(settingsDirectory, key); await fs.mkdir(settingRoot, {mode:0o700});
      const target = path.join(settingRoot, path.basename(source));
      await fs.copyFile(source, target); await fs.chmod(target, 0o600); copiedEnvironment[key] = target;
    }
    const isolatedHome = path.join(root, 'home'), isolatedTmp = path.join(root, 'tmp');
    await fs.mkdir(isolatedHome, {mode:0o700}); await fs.mkdir(isolatedTmp, {mode:0o700});
    const origin = `http://127.0.0.1:${port}`;
    const nodeExecutable = path.join(packageRoot, 'runtime/node');
    await fs.access(nodeExecutable);
    const env = { ...copiedEnvironment, PATH: `${path.dirname(nodeExecutable)}:/usr/bin:/bin`,
      LC_ALL: 'C', HOME: isolatedHome, TMPDIR: isolatedTmp, NODE_OPTIONS: '--throw-deprecation',
      SELECTION_REVIEW_DATA_FILE: copyFile, SELECTION_REVIEW_PORT: String(port), SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_PUBLIC_ORIGIN: origin, SELECTION_REVIEW_ALLOWED_ORIGINS: origin,
      SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(root, 'uploads'),
      SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(identityDirectory, 'isolated-owner.json') };
    // Inherit the caller's process group so the outer isolated runner also owns cleanup.
    child = spawn('/usr/bin/sandbox-exec', ['-p', profile, nodeExecutable, path.join(packageRoot, 'server.mjs')],
      { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    observation = observeServer(child);
    const consume = chunk => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 1024 * 1024) { diagnosticLimitExceeded = true; controller.abort(); }
    };
    child.stdout.on('data', chunk => {
      consume(chunk); stdoutTail = (stdoutTail + chunk.toString()).slice(-1024);
      if (stdoutTail.includes(origin)) listening = true;
    });
    let stderrBytes = 0;
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length; consume(chunk); stderrTail = (stderrTail + chunk.toString()).slice(-2048);
      serviceFailureCode ??= observableServiceCodes.find(code => new RegExp(`\\b${code}\\b`, 'u').test(stderrTail)) ?? null;
    });
    const deadline = performance.now() + 30000;
    for (;;) {
      if (interrupted) throw failure('RUNTIME_PREFLIGHT_INTERRUPTED');
      if (diagnosticLimitExceeded) throw failure('RUNTIME_PREFLIGHT_DIAGNOSTIC_LIMIT');
      if (observation.current() || observation.failed()) throw Object.assign(failure('RUNTIME_PREFLIGHT_STARTUP_FAILED'), {serviceCode:serviceFailureCode});
      if (performance.now() >= deadline) throw failure('RUNTIME_PREFLIGHT_STARTUP_TIMEOUT');
      if (listening) break;
      await pause(100);
    }
    const live = await fetch(origin + '/api/live', { redirect:'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) });
    if (live.status !== 200 || (await live.json()).live !== true) throw failure('RUNTIME_PREFLIGHT_LIVENESS_FAILED');
    const started = performance.now();
    const health = await fetch(origin + '/api/health', { redirect:'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) });
    const body = await health.json();
    if (health.status !== 200 || body.ok !== true || body.ready !== true || body.readiness?.fresh !== true) {
      throw failure('RUNTIME_PREFLIGHT_READINESS_FAILED');
    }
    const durationMs = performance.now() - started;
    const exit = await stopServer(child, observation);
    if (exit.exitedBeforeStop || exit.startupError || observation.failed() || !(exit.code === 0 || exit.code === null && exit.signal === 'SIGTERM')) {
      throw failure('RUNTIME_PREFLIGHT_SERVICE_EXIT_FAILED');
    }
    if (stderrBytes !== 0) throw failure('RUNTIME_PREFLIGHT_SERVICE_DIAGNOSTIC');
    if (!(await fs.readFile(copyFile)).equals(originalBytes) || !(await fs.readFile(inputFile)).equals(originalBytes)) {
      throw failure('RUNTIME_PREFLIGHT_COPY_CHANGED');
    }
    receipt = { status: 'verified', startupVerified: true, healthStatus: 200, readinessFresh: true,
      healthDurationMs: durationMs, environmentKeyCount: Object.keys(environment).length,
      osSandboxed: true, externalNetworkAllowed: false, credentialAccessAllowed: false,
      dataCopyUnchanged: true, installed: false, activated: false };
  } catch (error) { primaryError = error; }
  finally {
    if (child) {
      try { await stopServer(child, observation); }
      catch (error) { removeCopy = false; cleanupError = error; }
    }
    try { if (removeCopy) await fs.rm(root, { recursive: true, force: true }); }
    catch (error) { cleanupError = error; }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  }
  if (cleanupError && primaryError) throw Object.assign(new AggregateError([primaryError, cleanupError], 'RUNTIME_PREFLIGHT_CLEANUP_FAILED'), {code:'RUNTIME_PREFLIGHT_CLEANUP_FAILED'});
  if (cleanupError) throw cleanupError;
  if (interrupted) throw failure('RUNTIME_PREFLIGHT_INTERRUPTED');
  if (diagnosticLimitExceeded || controller.signal.aborted) throw failure('RUNTIME_PREFLIGHT_DIAGNOSTIC_LIMIT');
  if (primaryError) throw primaryError;
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [appDirectory, dataCopy, rawPort, extra] = process.argv.slice(2);
    if (extra !== undefined || typeof rawPort !== 'string' || !/^[1-9][0-9]*$/u.test(rawPort)) throw failure('RUNTIME_PREFLIGHT_ARGUMENTS_INVALID');
    const receipt = await verifyRuntimePackage({ appDirectory, dataCopy, port: Number(rawPort) });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    // Emit finite diagnostic codes or standard I/O codes, never raw service text or values.
    const code = typeof error.code === 'string' && /^(?:RUNTIME_PREFLIGHT_[A-Z_]+|LOCAL_PROCESS_SANDBOX_[A-Z_]+|E[A-Z]+)$/u.test(error.code) ? error.code : 'RUNTIME_PREFLIGHT_FAILED';
    console.error(JSON.stringify({ status: 'failed', code,
      serviceCode: observableServiceCodes.includes(error.serviceCode) ? error.serviceCode : null, installed: false, activated: false }));
    process.exitCode = 1;
  }
}
