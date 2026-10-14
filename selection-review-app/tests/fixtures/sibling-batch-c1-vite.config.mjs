import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { s1WorkspaceFaultProxy } from './s1-workspace-fault-proxy.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const apiPort = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(apiPort) || apiPort <= 0) throw new Error('SIBLING_BATCH_BROWSER_API_PORT_REQUIRED');

const faultProxy=s1WorkspaceFaultProxy();
export default defineConfig({ plugins: [react(),...(faultProxy?[faultProxy]:[])],
  ...(faultProxy?{cacheDir:path.join(tmpdir(),'s1-workspace-vite-cache')}:{}),server: { host: '127.0.0.1',
  proxy: { '/api': `http://127.0.0.1:${apiPort}` } } });
