import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { stopApiProcess, allocatedTestPorts } from "./helpers/api-process-lifecycle.mjs";

function fakeProcess(onSignal) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    onSignal?.(child, signal);
    return true;
  };
  return child;
}

function assertListenersRemoved(child) {
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
}

const portEnvironment = { SELECTION_REVIEW_TEST_PORT: '20001', SELECTION_REVIEW_TEST_SECOND_PORT: '20002',
  SELECTION_REVIEW_TEST_GATEWAY_PORT: '20003' };

test('allocated ports preserve their distinct API, second and gateway roles', () => {
  const ports = allocatedTestPorts(portEnvironment);
  assert.deepEqual(ports, { api: 20001, second: 20002, gateway: 20003 });
  assert.equal(Object.isFrozen(ports), true);
});

test('allocated ports reject missing, malformed, reserved, duplicate and out-of-range values', () => {
  assert.throws(() => allocatedTestPorts({}), /TEST_REQUIRES_ISOLATED_PORT/);
  for (const key of Object.keys(portEnvironment)) {
    for (const value of [undefined, '', '0', '-1', '20.5', '20001junk', ' 20001', '020001', '65536', '4317', '4318', '4173', '4319']) {
      assert.throws(() => allocatedTestPorts({ ...portEnvironment, [key]: value }), /TEST_REQUIRES_ISOLATED_PORT/);
    }
  }
  for (const [first, second] of [['SELECTION_REVIEW_TEST_PORT', 'SELECTION_REVIEW_TEST_SECOND_PORT'],
    ['SELECTION_REVIEW_TEST_PORT', 'SELECTION_REVIEW_TEST_GATEWAY_PORT'],
    ['SELECTION_REVIEW_TEST_SECOND_PORT', 'SELECTION_REVIEW_TEST_GATEWAY_PORT']]) {
    assert.throws(() => allocatedTestPorts({ ...portEnvironment, [second]: portEnvironment[first] }), /TEST_REQUIRES_ISOLATED_PORT/);
  }
});

test("API process cleanup waits for graceful exit and removes its listeners", async () => {
  const child = fakeProcess();
  let completed = false;
  const cleanup = stopApiProcess(child).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.emit("exit", 0, null);
  await cleanup;
  assert.equal(completed, true);
  assertListenersRemoved(child);
});

test("API process cleanup accepts an already successful exit but exposes an earlier crash", async () => {
  const child = fakeProcess();
  child.exitCode = 0;
  await stopApiProcess(child);
  assert.deepEqual(child.signals, []);
  child.exitCode = 1;
  await assert.rejects(stopApiProcess(child), /API_PROCESS_EXIT_FAILED/);
  assertListenersRemoved(child);
});

test("API process cleanup accepts SIGTERM exit but rejects another signal", async () => {
  const child = fakeProcess((process, signal) => process.emit("exit", null, signal));
  await stopApiProcess(child);
  assertListenersRemoved(child);
  child.signalCode = "SIGSEGV";
  await assert.rejects(stopApiProcess(child), /API_PROCESS_EXIT_FAILED/);
});

test("API process cleanup uses SIGKILL after a timeout and still fails the test", async () => {
  const child = fakeProcess((process, signal) => {
    if (signal === "SIGKILL") process.emit("exit", null, signal);
  });
  await assert.rejects(stopApiProcess(child, { timeoutMs: 5, killTimeoutMs: 20 }), /API_PROCESS_SHUTDOWN_TIMEOUT/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assertListenersRemoved(child);
});

test("API process cleanup has a bounded wait even when SIGKILL cannot produce an exit event", async () => {
  const child = fakeProcess();
  await assert.rejects(stopApiProcess(child, { timeoutMs: 5, killTimeoutMs: 5 }), /API_PROCESS_SHUTDOWN_TIMEOUT/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assertListenersRemoved(child);
});

test("API process cleanup reports signal failures and child errors", async () => {
  const rejectedSignal = fakeProcess();
  rejectedSignal.kill = () => false;
  await assert.rejects(stopApiProcess(rejectedSignal), /API_PROCESS_SIGNAL_FAILED/);
  assertListenersRemoved(rejectedSignal);
  const failure = new Error("fixture failure");
  const childError = fakeProcess((child) => child.emit("error", failure));
  await assert.rejects(stopApiProcess(childError), { message: "API_PROCESS_CLEANUP_FAILED", cause: failure });
  assertListenersRemoved(childError);
});

test("API process cleanup rejects invalid timeout configuration before signaling", async () => {
  const child = fakeProcess();
  await assert.rejects(stopApiProcess(child, { timeoutMs: 0 }), /API_PROCESS_CLEANUP_INVALID_TIMEOUT/);
  assert.deepEqual(child.signals, []);
});

async function syntheticLocalRunner({ killFailure = null, group = 'absent' } = {}) {
  const source = await readFile(new URL('../scripts/run-local-api-tests.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function runChild(');
  const end = source.indexOf('\nfor (const file of selected)', start);
  assert.ok(start >= 0 && end > start, 'the actual local runner function must be available');
  let now = 0, timerId = 0;
  const timers = new Map(), signals = [], logs = [], launches = [], pipes = [];
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = { pipe: target => pipes.push(target) };
  child.stderr = { pipe: target => pipes.push(target) };
  const owner = new EventEmitter();
  owner.stdout = {};
  owner.stderr = {};
  owner.kill = (pid, signal) => {
    signals.push({ pid, signal });
    const code = signal === 0 ? (group === 'absent' ? 'ESRCH' : group === 'denied' ? 'EPERM' : null) : killFailure;
    if (code) throw Object.assign(new Error('synthetic signal failure'), { code });
    return true;
  };
  const context = {
    process: owner,
    performance: { now: () => now },
    console: { log: text => logs.push(text) },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    ['sp' + 'awn']: (...args) => { launches.push(args); return child; },
  };
  const run = vm.runInNewContext(source.slice(start, end) + '\nrunChild;', context);
  async function advance(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now && timers.delete(id)) timer.callback();
    }
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  }
  function assertFinished() {
    assert.equal(launches.length, 1);
    assert.equal(pipes.length, 2);
    assert.deepEqual(signals.filter(item => item.signal === 'SIGKILL'), [{ pid: -12345, signal: 'SIGKILL' }]);
    assert.equal(owner.listenerCount('SIGINT'), 0);
    assert.equal(owner.listenerCount('SIGTERM'), 0);
    assert.equal(timers.size, 0);
  }
  return { run, advance, assertFinished, logs, signals };
}

test('local runner synthetic deadline rejects after one successful kill without an exit event', { timeout: 1000 }, async () => {
  const fixture = await syntheticLocalRunner();
  const rejected = assert.rejects(fixture.run([], {}), /LOCAL_API_TEST_TERMINATED:deadline/);
  await fixture.advance(70000);
  await rejected;
  fixture.assertFinished();
  assert.ok(fixture.logs.some(line => line.startsWith('ISOLATED_GROUP_CLEANUP ') && JSON.parse(line.slice(line.indexOf(' ') + 1)).groupAbsent === true));
});

test('local runner synthetic signal denial rejects under control without repeating the kill', { timeout: 1000 }, async () => {
  const fixture = await syntheticLocalRunner({ killFailure: 'EPERM' });
  const rejected = assert.rejects(fixture.run([], {}), /LOCAL_API_TEST_SIGNAL_FAILED/);
  await fixture.advance(70000);
  await rejected;
  fixture.assertFinished();
  assert.ok(fixture.logs.some(line => line.startsWith('ISOLATED_CLEANUP_FAILURE ') && JSON.parse(line.slice(line.indexOf(' ') + 1)).failureCode === 'EPERM'));
});

test('local runner synthetic uncertain group cleanup is bounded and explicitly unknown', { timeout: 1000 }, async () => {
  for (const group of ['present', 'denied']) {
    const fixture = await syntheticLocalRunner({ group });
    const rejected = assert.rejects(fixture.run([], {}), error => {
      assert.equal(error.message, 'LOCAL_API_TEST_CLEANUP_UNKNOWN');
      assert.equal(error.cleanupUnknown, true);
      return true;
    });
    await fixture.advance(70000);
    if (group === 'present') for (let attempt = 0; attempt < 40; attempt++) await fixture.advance(25);
    await rejected;
    fixture.assertFinished();
    assert.ok(!fixture.logs.some(line => line.startsWith('ISOLATED_GROUP_CLEANUP ')));
    const expected = group === 'present' ? 'GROUP_STILL_PRESENT' : 'EPERM';
    assert.ok(fixture.logs.some(line => line.startsWith('ISOLATED_CLEANUP_FAILURE ') && JSON.parse(line.slice(line.indexOf(' ') + 1)).failureCode === expected));
  }
});

async function preflightLifecycle() {
  const source = await readFile(new URL('../scripts/verify-package-with-real-env.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const failure ='), end = source.indexOf('\nfunction assertQuiescent(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + '\n({observeServer,stopServer});', {
    setTimeout: (callback, milliseconds) => setTimeout(callback, Math.min(milliseconds, 5)), clearTimeout
  });
}

test('preflight records a spawned process error without treating error or exit as a closed process', async () => {
  const { observeServer } = await preflightLifecycle(), child = new EventEmitter();
  child.pid = 12345;
  const observation = observeServer(child);
  let completed = false; observation.completion.then(() => { completed = true; });
  child.emit('error', Object.assign(new Error('synthetic signal denial'), {code:'EPERM'}));
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(observation.failed(), true); assert.equal(observation.current(), null); assert.equal(completed, false);
  child.emit('close', 0, null); await observation.completion;
  assert.equal(observation.current().code, 0); assert.equal(completed, true);
});

test('preflight proves a process that never spawned cannot own a retained copy', async () => {
  const { observeServer } = await preflightLifecycle(), child = new EventEmitter();
  const observation = observeServer(child);
  child.emit('error', Object.assign(new Error('synthetic spawn failure'), {code:'ENOENT'}));
  assert.equal((await observation.completion).startupError, true);
  assert.equal(observation.current().startupError, true);
});

test('preflight signal failure and missing close retain uncertain process ownership', async () => {
  const { observeServer, stopServer } = await preflightLifecycle();
  for (const rejectedSignal of [true, false]) {
    const child = new EventEmitter(); child.pid = 12345;
    const signals = [];
    child.kill = signal => { signals.push(signal); if (!rejectedSignal) child.emit('error', new Error('synthetic kill error')); return !rejectedSignal; };
    const observation = observeServer(child);
    await assert.rejects(stopServer(child, observation), {code: rejectedSignal ? 'RUNTIME_PREFLIGHT_SIGNAL_FAILED' : 'RUNTIME_PREFLIGHT_SHUTDOWN_TIMEOUT'});
    assert.equal(observation.current(), null);
    assert.deepEqual(signals, rejectedSignal ? ['SIGTERM'] : ['SIGTERM','SIGKILL']);
    child.emit('close', null, 'SIGKILL'); await observation.completion;
  }
});

test('preflight graceful stop waits for close, including diagnostic pipe completion', async () => {
  const { observeServer, stopServer } = await preflightLifecycle(), child = new EventEmitter();
  child.pid = 12345; child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
  const observation = observeServer(child), result = await stopServer(child, observation);
  assert.equal(result.code, 0); assert.equal(result.exitedBeforeStop, false); assert.equal(observation.failed(), false);
});
