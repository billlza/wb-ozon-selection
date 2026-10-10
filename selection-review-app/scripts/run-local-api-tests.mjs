import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { API_PROCESS_TESTS, SOURCE_CONTRACT_TESTS, SUBPROCESS_TESTS, ISOLATED_TESTS, BUILT_RUNTIME_TESTS } from "./ci-test-suites.mjs";
import { assertIsolatedApiTestSource, assertLocalApiTestPortsSource } from "./ci-test-policy.mjs";
import { createLocalProcessSandboxProfile } from "./local-process-sandbox-profile.mjs";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const requested = process.argv.slice(2);
const browserFixture = requested.length === 1 && requested[0] === '--browser-fixture';
const selected = browserFixture ? ['fixtures/start-s1-workspace-browser.mjs'] : requested;
if (process.platform !== "darwin") throw new Error("LOCAL_API_TESTS_REQUIRE_MACOS_SANDBOX");
if (!browserFixture && (!selected.length || new Set(selected).size !== selected.length || selected.some(file => !ISOLATED_TESTS.includes(file)))) {
  throw new Error("LOCAL_API_TESTS_REQUIRE_EXPLICIT_CLASSIFIED_FILES");
}
const nodeDirectory = await fs.realpath(path.dirname(process.execPath));
const nodeRuntimeRoot = path.basename(nodeDirectory) === "bin" ? path.dirname(nodeDirectory) : nodeDirectory;
const dependencyDirectory = await fs.realpath(path.join(appDirectory, "node_modules"));
const sharedFixtureSource = await fs.readFile(path.join(appDirectory, 'tests/helpers/d-e-saved-api-fixture.mjs'), 'utf8');
const portFixtureSource = await fs.readFile(path.join(appDirectory, 'tests/helpers/api-process-lifecycle.mjs'), 'utf8');
const launchScriptSource = await fs.readFile(path.join(appDirectory, 'scripts/launch-server.sh'), 'utf8');
// This classified test asserts a read of the adopted project workbook. No other data is copied.
const staticFixtureFiles = {
  'real-a-b-c1-api.test.mjs': ['data/logistics/GUOO产品资费测算表【2026.8.19更新】.xlsx', 'data/logistics/guoo-2026-08-19.source.json']
};

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  if ([4317, 4318, 4173, 4319].includes(port)) {
    await new Promise(resolve => server.close(resolve));
    throw new Error("LOCAL_API_TEST_PORT_CONFLICT");
  }
  return { port, release: () => new Promise(resolve => server.close(resolve)) };
}

async function runChild(args, options, { budgetMs = 70000, plannedInterrupt = false, command = '/usr/bin/sandbox-exec' } = {}) {
  // Pipes keep parent log files outside the child's writable filesystem boundary.
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let timedOut = false;
  let cleanupSent = false;
  let cleanupOutcome = 'not_requested';
  let cleanupFailure = null;
  let rejectCompletion;
  const recordCleanupFailure = error => {
    cleanupFailure = ['EPERM', 'ESRCH', 'EINVAL'].includes(error.code) ? error.code : 'SIGNAL_OR_PROBE_FAILED';
    console.log('ISOLATED_CLEANUP_FAILURE ' + JSON.stringify({ pid: child.pid, failureCode: cleanupFailure,
      observedAt: new Date().toISOString() }));
  };
  const killGroup = signal => {
    if (signal === "SIGKILL" && cleanupSent) return;
    if (signal === "SIGKILL") cleanupSent = true;
    try { process.kill(-child.pid, signal); if (signal === "SIGKILL") cleanupOutcome = 'signal_sent'; }
    catch (error) { if (error.code !== "ESRCH") throw error; if (signal === "SIGKILL") cleanupOutcome = 'already_absent'; }
  };
  const requestSignal = signal => {
    try { killGroup(signal); }
    catch (error) { recordCleanupFailure(error); rejectCompletion(new Error('LOCAL_API_TEST_SIGNAL_FAILED')); }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    requestSignal("SIGKILL");
    rejectCompletion(new Error('LOCAL_API_TEST_TERMINATED:deadline'));
  }, budgetMs);
  let interruptSent = false;
  const interrupt = () => { if (!interruptSent) { interruptSent = true; requestSignal("SIGTERM"); } };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    console.log('ISOLATED_PROCESS ' + JSON.stringify({ pid: child.pid, parentPid: process.pid, startedAt: new Date().toISOString(), budgetMs }));
    const result = await new Promise((resolve, reject) => {
      rejectCompletion = reject;
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    console.log('ISOLATED_EXIT ' + JSON.stringify({ pid: child.pid, ...result, timedOut, observedAt: new Date().toISOString() }));
    if (plannedInterrupt && interruptSent && !timedOut &&
        (result.code === 0 || result.signal === 'SIGTERM' || result.code === 143)) return 0;
    if (timedOut || result.signal) throw new Error(`LOCAL_API_TEST_TERMINATED:${timedOut ? "deadline" : result.signal}`);
    if (plannedInterrupt && result.code === 0) throw new Error('LOCAL_BROWSER_FIXTURE_EXITED_WITHOUT_STOP');
    return result.code;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (child.pid) {
      try { killGroup("SIGKILL"); }
      catch (error) { recordCleanupFailure(error); }
    }
    if (child.pid) {
      const deadline = performance.now() + 1000;
      for (;;) {
        let exists = true;
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if (error.code !== 'ESRCH') {
            recordCleanupFailure(error);
            throw Object.assign(new Error('LOCAL_API_TEST_CLEANUP_UNKNOWN'), { cleanupUnknown: true });
          }
          exists = false;
        }
        if (!exists) break;
        if (performance.now() >= deadline) {
          console.log('ISOLATED_CLEANUP_FAILURE ' + JSON.stringify({ pid: child.pid, failureCode: 'GROUP_STILL_PRESENT', observedAt: new Date().toISOString() }));
          throw Object.assign(new Error('LOCAL_API_TEST_CLEANUP_UNKNOWN'), { cleanupUnknown: true });
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      console.log('ISOLATED_GROUP_CLEANUP ' + JSON.stringify({ pid: child.pid, action: cleanupOutcome, groupAbsent: true, observedAt: new Date().toISOString() }));
      if (cleanupFailure !== null) throw new Error('LOCAL_API_TEST_SIGNAL_FAILED');
    }
  }
}

for (const file of selected) {
  const source = await fs.readFile(path.join(appDirectory, "tests", file), "utf8");
  let portSource = null;
  if (API_PROCESS_TESTS.includes(file)) {
    assertIsolatedApiTestSource({ file, source, sharedFixtureSource, launchScriptSource });
    portSource = assertLocalApiTestPortsSource({ file, source, portFixtureSource, sharedFixtureSource });
  }
  if (SUBPROCESS_TESTS.includes(file) && !source.includes("node:child_process") ||
      SOURCE_CONTRACT_TESTS.includes(file) && !source.includes("readFile") && !source.includes("server.mjs")) throw new Error(`LOCAL_API_TEST_CLASSIFICATION_INVALID:${file}`);
  const fixtureFiles = staticFixtureFiles[file] ?? [];
  for (const entry of fixtureFiles) {
    const stat = await fs.lstat(path.join(appDirectory, entry));
    if (!stat.isFile() || stat.size === 0) throw new Error(`LOCAL_API_TEST_STATIC_FIXTURE_INVALID:${entry}`);
  }
  console.log('ISOLATED_PREFLIGHT ' + JSON.stringify({ file, portSource, fixtureFiles, passed: true, observedAt: new Date().toISOString() }));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "selection-api-isolated-")));
  const ports = [];
  let removeCopy = true;
  try {
    const copy = path.join(root, "app");
    await fs.mkdir(copy);
    // Copy only code and declared static configuration. Never copy candidates or machine settings.
    // docs/contracts 是运行期真要读的官方合同：server.mjs 一启动就 readFile 它们，漏拷会让隔离副本起不来。
    for (const entry of ["server.mjs", "package.json", "index.html", "启动今日选品评审台.command", "lib", "schema", "src", "extension", "tests", "scripts", "docs/contracts",
      ...(BUILT_RUNTIME_TESTS.includes(file) ? ["dist"] : [])]) {
      await fs.cp(path.join(appDirectory, entry), path.join(copy, entry), { recursive: true, dereference: false,
        filter: source => source !== path.join(appDirectory,'lib','batch-catalogs') });
    }
    await fs.mkdir(path.join(copy, "data"));
    await fs.copyFile(path.join(appDirectory, "data", "workflow-map.json"), path.join(copy, "data", "workflow-map.json"));
    for (const entry of fixtureFiles) {
      await fs.mkdir(path.dirname(path.join(copy, entry)), { recursive: true });
      await fs.copyFile(path.join(appDirectory, entry), path.join(copy, entry));
    }
    await fs.symlink(dependencyDirectory, path.join(copy, "node_modules"), "dir");
    await fs.mkdir(path.join(root, "home"));
    await fs.mkdir(path.join(root, "tmp"));
    for (let i = 0; i < 3; i++) ports.push(await reservePort());
    const [api, second, gateway] = ports.map(item => item.port);
    if (new Set([api, second, gateway]).size !== 3) throw new Error("LOCAL_API_TEST_PORT_CONFLICT");
    const profile = createLocalProcessSandboxProfile({ writableRoot: root,
      readOnlyDirectories: [nodeRuntimeRoot, dependencyDirectory], ports: [api, second, gateway] });
    const env = {
      PATH: `${nodeDirectory}:/usr/bin:/bin`, LC_ALL: "C", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), NODE_OPTIONS: "--throw-deprecation",
      SELECTION_REVIEW_TEST_PORT: String(api), SELECTION_REVIEW_TEST_SECOND_PORT: String(second), SELECTION_REVIEW_TEST_GATEWAY_PORT: String(gateway),
      SELECTION_REVIEW_PUBLIC_ORIGIN: `http://127.0.0.1:${api}`,
      SELECTION_REVIEW_ALLOWED_ORIGINS: `http://127.0.0.1:${api}`, SELECTION_REVIEW_WORKFLOW_MAP_FILE: path.join(copy, "data", "workflow-map.json"),
      SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(root, "uploads"), SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${gateway}`,
      SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: `http://127.0.0.1:${gateway}`,
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off"
    };
    for (const item of ports) await item.release();
    ports.length = 0;
    // A boundary test needs a trusted unsandboxed fixture parent to apply the server's
    // profile once; macOS refuses nested sandbox_apply. No other entry uses this route.
    const osBoundaryFixture = file === 'runtime-preflight-api.test.mjs';
    console.log(osBoundaryFixture ? `Running ${file}: trusted fixture parent; each package/probe process applies one OS sandbox.` :
      `Running ${file} in a temporary copy; only test ports ${api}, ${second}, ${gateway} are accessible.`);
    const childArgs = browserFixture ? [path.join('tests', file)] :
      ['--test', '--test-concurrency=1', '--test-timeout=60000', path.join('tests', file)];
    const code = await runChild(osBoundaryFixture ? childArgs : ['-p', profile, process.execPath, ...childArgs], { cwd: copy, env },
      osBoundaryFixture ? { command: process.execPath } : browserFixture ? { budgetMs: 600000, plannedInterrupt: true } : {});
    if (code !== 0) { process.exitCode = code || 1; break; }
  } catch (error) {
    if (error.cleanupUnknown === true) removeCopy = false;
    throw error;
  } finally {
    for (const item of ports) await item.release();
    if (removeCopy) {
      await fs.rm(root, { recursive: true, force: true });
      console.log('ISOLATED_COPY_REMOVED ' + JSON.stringify({ file, observedAt: new Date().toISOString() }));
    } else console.log('ISOLATED_COPY_RETAINED ' + JSON.stringify({ file, root, reason: 'cleanup_unknown', observedAt: new Date().toISOString() }));
  }
}
