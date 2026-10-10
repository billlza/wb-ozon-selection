import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuntimeHealth, RUNTIME_READINESS_TIMEOUT_MS, RUNTIME_READINESS_RESOURCE_LIMITS } from '../lib/runtime-health.mjs';

const identity = { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' };
const good = () => ({ ok: true, dataVersion: 2, fileIdentity: { ...identity } });
function fixture(options = {}) {
  const workers = [], settings = [];
  const health = createRuntimeHealth({ filePath: '/synthetic/state.json', readIdentity: async () => ({ ...identity }),
    createWorker: configuration => {
      settings.push(configuration);
      const worker = new EventEmitter(); worker.terminated = 0;
      worker.terminate = async () => { worker.terminated++; return 0; };
      workers.push(worker); return worker;
    }, ...options });
  return { health, workers, settings };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === 'RUNTIME_READINESS_FAILED');

test('starting and closed runtimes cannot report ready; liveness is separate', async () => {
  const { health, workers } = fixture();
  assert.equal(health.live, false); await rejects(health.ready(), 'starting');
  health.markListening(); assert.equal(health.live, true);
  await health.close(); assert.equal(health.live, false); await rejects(health.ready(), 'closed');
  assert.equal(workers.length, 0);
});

test('each readiness request gets a fresh bounded worker with no inherited secrets or Node options', async () => {
  const { health, workers, settings } = fixture(); health.markListening();
  for (let index = 0; index < 2; index++) {
    const result = health.ready(); workers[index].emit('message', good());
    assert.equal((await result).fresh, true); assert.equal(workers[index].terminated, 1);
    assert.deepEqual(settings[index], { workerData: { filePath: '/synthetic/state.json' }, env: {}, execArgv: [], resourceLimits: RUNTIME_READINESS_RESOURCE_LIMITS });
  }
  await health.close();
});

test('busy requests do not queue or spawn, and admission remains held until termination finishes', async () => {
  const { health, workers } = fixture(); health.markListening();
  const first = health.ready(); let release;
  workers[0].terminate = () => new Promise(resolve => { release = resolve; });
  await rejects(health.ready(), 'busy'); workers[0].emit('message', good());
  await new Promise(resolve => setImmediate(resolve));
  await rejects(health.ready(), 'busy'); assert.equal(workers.length, 1);
  release(0); await first; await health.close();
});

test('a replaced file or a fresh read failure cannot reuse a previous success', async () => {
  let current = { ...identity }; const { health, workers } = fixture({ readIdentity: async () => current }); health.markListening();
  const first = health.ready(); workers[0].emit('message', good()); await first;
  current = { ...identity, ino: '99' };
  const second = health.ready(); workers[1].emit('message', good()); await rejects(second, 'source_changed');
  const third = health.ready(); workers[2].emit('message', { ok: false, code: 'data_invalid' }); await rejects(third, 'data_invalid');
  await health.close();
});

test('invalid DTOs, worker errors and premature exits fail closed', async () => {
  const { health, workers } = fixture(); health.markListening();
  const emissions = [worker => worker.emit('message', { ...good(), secret: 'must-not-pass' }),
    worker => worker.emit('message', { ...good(), dataVersion: 1 }), worker => worker.emit('error', new Error('private diagnostic')),
    worker => worker.emit('exit', 0), worker => worker.emit('exit', 1)];
  for (let index = 0; index < emissions.length; index++) {
    const result = health.ready(); emissions[index](workers[index]); await rejects(result, 'worker_failed');
  }
  await health.close();
});

test('normal worker exit after a message waits for current identity validation', async () => {
  let release; const { health, workers } = fixture({ readIdentity: () => new Promise(resolve => { release = resolve; }) }); health.markListening();
  const result = health.ready(); workers[0].emit('message', good()); workers[0].emit('exit', 0);
  release(identity); assert.equal((await result).dataVersion, 2); await health.close();
});

test('the monotonic deadline rejects late success even when the event loop delays the timeout callback', async () => {
  let now = 0; const { health, workers } = fixture({ clock: () => now }); health.markListening();
  const result = health.ready(); now = RUNTIME_READINESS_TIMEOUT_MS + 1;
  workers[0].emit('message', good()); await rejects(result, 'timeout'); await health.close();
  assert.throws(() => fixture({ timeoutMs: 4001 }), error => error.code === 'configuration_invalid');
});

test('disconnect and shutdown cancel the active worker; late messages cannot make either ready', async () => {
  const { health, workers } = fixture(); health.markListening(); const controller = new AbortController();
  const first = health.ready({ signal: controller.signal }); controller.abort(); await rejects(first, 'cancelled');
  assert.equal(workers[0].terminated, 1);
  const second = health.ready(); const rejected = rejects(second, 'closed'); const closed = health.close();
  workers[1].emit('message', good()); await rejected; await closed;
  assert.equal(workers[1].terminated, 1); assert.equal(health.live, false);
});
