import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const RUNTIME_READINESS_TIMEOUT_MS = 4000;
export const RUNTIME_READINESS_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 });
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
const identity = s => Object.fromEntries(fields.map(k => [k, String(s[k])]));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const failure = code => Object.assign(new Error('RUNTIME_READINESS_FAILED'), { code });

// This is an operational storage reader, never a business job or a state cache.
// The local JSON adapter is explicit; other adapters must supply their own reader.
export function createRuntimeHealth({ filePath, storageAdapter = 'json', timeoutMs = RUNTIME_READINESS_TIMEOUT_MS,
  createWorker = options => new Worker(new URL('./runtime-health-worker.mjs', import.meta.url), options),
  readIdentity = async () => identity(await stat(filePath, { bigint: true })), clock = () => performance.now() } = {}) {
  if (typeof filePath !== 'string' || !filePath || storageAdapter !== 'json' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_READINESS_TIMEOUT_MS) throw failure('configuration_invalid');
  let phase = 'starting', active = null;
  async function ready({ signal } = {}) {
    if (phase !== 'ready') throw failure(phase === 'closed' ? 'closed' : 'starting');
    if (signal?.aborted) throw failure('cancelled');
    if (active) throw failure('busy');
    let complete;
    const operation = { cancel: null, done: new Promise(resolve => { complete = resolve; }) }; active = operation;
    const started = clock(); let worker, timer, abort, response;
    const remaining = () => timeoutMs - (clock() - started);
    try {
      worker = createWorker({ workerData: { filePath }, env: {}, execArgv: [], resourceLimits: { ...RUNTIME_READINESS_RESOURCE_LIMITS } });
      response = await new Promise((resolve, reject) => {
        let settled = false, received = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; error ? reject(error) : resolve(value);
        };
        operation.cancel = code => finish(failure(code));
        abort = () => operation.cancel('cancelled');
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => operation.cancel('timeout'), Math.max(0, remaining()));
        worker.once('error', () => finish(failure('worker_failed')));
        worker.once('exit', code => { if (!received || code !== 0) finish(failure('worker_failed')); });
        worker.once('message', async message => {
          try {
            if (remaining() <= 0) throw failure('timeout');
            if (exactKeys(message, ['ok', 'code']) && message.ok === false &&
                ['data_unavailable', 'data_invalid', 'source_changed'].includes(message.code)) throw failure(message.code);
            if (!exactKeys(message, ['ok', 'dataVersion', 'fileIdentity']) || message.ok !== true || message.dataVersion !== 2 ||
                !exactKeys(message.fileIdentity, fields) || !fields.every(k => typeof message.fileIdentity[k] === 'string' && /^\d+$/.test(message.fileIdentity[k]))) throw failure('worker_failed');
            // Verify the same file is still current at publication. A successful
            // worker response never survives a replacement/change or a deadline.
            received = true;
            const current = await readIdentity();
            if (phase !== 'ready') throw failure('closed');
            if (remaining() <= 0) throw failure('timeout');
            if (!fields.every(k => current[k] === message.fileIdentity[k])) throw failure('source_changed');
            finish(null, { dataVersion: message.dataVersion, fresh: true, durationMs: clock() - started });
          } catch (error) { finish(error.code ? error : failure('data_unavailable')); }
        });
        if (signal?.aborted) abort();
      });
    } finally {
      clearTimeout(timer);signal?.removeEventListener('abort', abort);
      // Retain admission ownership until the old worker has actually terminated.
      try { if (worker) await worker.terminate(); }
      catch { phase = 'closed';throw failure('worker_failed'); }
      finally { if (active === operation) active = null;complete(); }
    }
    if (phase !== 'ready') throw failure('closed');
    if (remaining() <= 0) throw failure('timeout');
    return { ...response, durationMs: clock() - started };
  }
  return Object.freeze({
    markListening() { if (phase !== 'starting') throw failure('lifecycle_invalid'); phase = 'ready'; },
    get live() { return phase === 'ready'; },
    ready,
    async close() { phase = 'closed';active?.cancel?.('closed');if (active) await active.done; }
  });
}
