import { parentPort, workerData } from 'node:worker_threads';
import { open, stat } from 'node:fs/promises';
import { createJsonBusinessStateRepository } from './business-state-repository.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const identity = s => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k])]));
const same = (a, b) => Object.keys(a).every(k => a[k] === b[k]);
let handle;
try {
  handle = await open(workerData.filePath, 'r');
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new Error('data_unavailable');
  // One fresh, bounded read of the open canonical file. Use the existing repository
  // to retain parsing, production entity restoration and reference validation.
  // Cap allocation and reads even if another process grows the open file.
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (length !== Number(before.size)) throw new Error('source_changed');
  const bytes = buffer.toString('utf8', 0, length);
  const repository = createJsonBusinessStateRepository({ filePath: workerData.filePath,
    initializeIfMissing: false, fileSystem: { readFile: async () => bytes } });
  const document = await repository.readSnapshot();
  if (document.meta?.version !== 2 || !Array.isArray(document.candidates)) throw new Error('data_invalid');
  const after = await handle.stat({ bigint: true });
  const current = await stat(workerData.filePath, { bigint: true });
  const fileIdentity = identity(before);
  if (!same(fileIdentity, identity(after)) || !same(fileIdentity, identity(current))) throw new Error('source_changed');
  parentPort.postMessage({ ok: true, dataVersion: document.meta.version, fileIdentity });
} catch (error) {
  const code = error.code === 'ENOENT' ? 'data_unavailable'
    : ['data_unavailable', 'data_invalid', 'source_changed'].includes(error.message) ? error.message : 'data_invalid';
  // No file paths, raw data, exception messages or secrets cross this boundary.
  parentPort.postMessage({ ok: false, code });
} finally {
  await handle?.close();
  parentPort.close();
}
