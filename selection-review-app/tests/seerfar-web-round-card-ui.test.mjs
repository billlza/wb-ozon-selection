import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { seerfarAccountIdentityFailure } from '../lib/seerfar-account-identity.mjs';

// The Seerfar card renders synthetic display data only: no saved records, no services, no keychain.
let renderer;
async function card(view) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./seerfar-web-round-card-ui-entry.jsx', import.meta.url));
    const component = JSON.stringify(fileURLToPath(new URL('../src/components/SeerfarWebRoundCard.jsx', import.meta.url)));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'seerfar-web-round-card-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Card from ${component};
      export const render=props=>renderToStaticMarkup(<Card {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
  return renderer.render({ view, onStart: forbidden, onReadStoreSales: forbidden, onOpenCandidate: forbidden });
}

const round = (roundId, accountIdentity) => ({ roundId, captureId: `SWR-${roundId}`, targetStore: 'miska', businessDate: '2026-10-15',
  query: { queryId: 'q', routeLabel: '本店类目', reason: '合成测试', categoryPaths: ['宠物用品'] }, status: 'completed', createdAt: '2026-10-15T09:00:00.000Z',
  completedAt: '2026-10-15T09:05:00.000Z', failure: null, resultCountLabel: '共812条记录', screening: null, importedCandidateIds: [],
  requestTemplateCaptured: true, accountIdentity });
const saved = (masked, sameAsPrevious) => ({ schemaVersion: 'seerfar-web-account-identity-v1', status: 'saved', fields: ['accountId', 'phone'],
  masked, sameAsPrevious, location: 'macos_keychain', failure: null });

test('each round says where the Seerfar account went, with masks only', async () => {
  const html = await card({ configError: null, plans: {}, todayRuns: {}, busy: false, rounds: [
    round('a', saved({ accountId: '80****45', phone: '138****5678', email: null }, null)),
    round('b', saved({ accountId: '90****01', phone: null, email: null }, false)),
    round('c', seerfarAccountIdentityFailure({ accountId: '80012345', phone: null, email: 'owner.test@qq.com' }, 'access_denied')),
    round('d', seerfarAccountIdentityFailure({ accountId: null, phone: null, email: null })),
    round('e', null)] });
  assert.match(html, /Seerfar 账号 80\*\*\*\*45 · 手机 138\*\*\*\*5678，完整的存在这台 Mac 的钥匙串里。/);
  assert.match(html, /和上一次存的不是同一个账号，已换成这个。/);
  assert.equal(html.match(/和上一次存的不是同一个账号/g).length, 1);
  assert.match(html, /Seerfar 账号 80\*\*\*\*45 · 邮箱 o\*\*\*@qq\.com 没存上：系统钥匙串没允许（可能点了「拒绝」）。这一轮的商品照常收了，没有重试。/);
  assert.match(html, /这次的搜索请求里没有 Seerfar 账号信息，没存。/);
  for (const full of ['80012345', 'owner.test@qq.com']) assert.equal(html.includes(full), false, full);
  // A round from before this change has no account line at all.
  assert.equal((html.match(/Seerfar 账号|账号信息/g) ?? []).length, 4);
});
