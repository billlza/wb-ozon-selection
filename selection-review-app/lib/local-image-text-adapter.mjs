import path from 'node:path';
import { spawn } from 'node:child_process';
export class ImageTextAdapterError extends Error {
  constructor(code) { super(code); this.name = 'ImageTextAdapterError'; this.code = code; }
}
export function createLocalImageTextAdapter({ executablePath, timeoutMs = 30000 }) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new ImageTextAdapterError('IMAGE_TEXT_CONFIGURATION_INVALID');
  }
  let running = false;
  return Object.freeze({ version: 'apple-vision-text-v1', async extract({ body, signal }) {
    if (!Buffer.isBuffer(body) || body.length < 12 || body.length > 20 * 1024 * 1024) throw new ImageTextAdapterError('IMAGE_TEXT_BYTES_INVALID');
    if (running) throw new ImageTextAdapterError('IMAGE_TEXT_BUSY');
    if (signal?.aborted) throw new ImageTextAdapterError('IMAGE_TEXT_CANCELLED');
    running = true;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(executablePath, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        const chunks = []; let size = 0, failed = null, settled = false;
        const fail = code => { if (!failed) failed = code; child.kill('SIGKILL'); };
        const timer = setTimeout(() => fail('IMAGE_TEXT_TIMEOUT'), timeoutMs);
        const abort = () => fail('IMAGE_TEXT_CANCELLED');
        signal?.addEventListener('abort', abort, { once: true });
        const finish = (error, value) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        child.on('error', () => finish(new ImageTextAdapterError('IMAGE_TEXT_EXECUTABLE_UNAVAILABLE')));
        child.stdin.on('error', () => fail('IMAGE_TEXT_PROCESS_IO_FAILED'));
        child.stderr.on('data', () => { /* Drained; process errors are classified at exit, never exposed raw. */ });
        child.stdout.on('data', chunk => { size += chunk.length; if (size > 256000) fail('IMAGE_TEXT_OUTPUT_TOO_LARGE'); else chunks.push(chunk); });
        child.on('close', code => {
          if (failed || code !== 0) return finish(new ImageTextAdapterError(failed ?? 'IMAGE_TEXT_RECOGNITION_FAILED'));
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return finish(new ImageTextAdapterError('IMAGE_TEXT_RESULT_INVALID')); }
          if (!result || typeof result !== 'object' || Array.isArray(result) || result.version !== 'apple-vision-text-v1' || !Number.isInteger(result.revision) || !Array.isArray(result.lines) ||
              result.lines.length > 500 || result.lines.some(line => typeof line !== 'string' || !line.trim()) ||
              !Array.isArray(result.languages) || !result.languages.includes('ru-RU')) return finish(new ImageTextAdapterError('IMAGE_TEXT_RESULT_INVALID'));
          const text = result.lines.join('\n');
          if (text.length > 30000) return finish(new ImageTextAdapterError('IMAGE_TEXT_OUTPUT_TOO_LARGE'));
          finish(null, { text, language: 'ru-RU', extractorVersion: `${result.version}:revision-${result.revision}` });
        });
        if (signal?.aborted) abort();
        child.stdin.end(body);
      });
    } finally { running = false; }
  } });
}
