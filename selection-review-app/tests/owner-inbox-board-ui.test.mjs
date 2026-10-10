import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// 进行中 and 需要你处理 render synthetic display data only: no saved records, no services, no requests.
let renderer;
async function pages() {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./owner-inbox-board-ui-entry.jsx', import.meta.url));
    const board = fileURLToPath(new URL('../src/components/PipelineBoard.jsx', import.meta.url));
    const inbox = fileURLToPath(new URL('../src/components/OwnerInbox.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'owner-inbox-board-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Board from ${JSON.stringify(board)};import Inbox from ${JSON.stringify(inbox)};
      export const board=props=>renderToStaticMarkup(<Board {...props}/>);
      export const inbox=props=>renderToStaticMarkup(<Inbox {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer;
}

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const candidate = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: 'miska', dataRevision: 4,
  workflowStatus: 'codex_processing', displayStatus: 'codex_processing', imageUrl: '', needsFromUser: [],
  updatedAt: '2026-09-09T04:00:00.000Z', createdAt: '2026-09-09T04:00:00.000Z', ...extra });
const dropped = (id, extra = {}) => candidate(id, { workflowStatus: 'eliminated', displayStatus: 'eliminated',
  eliminatedAt: '2026-09-11T06:00:00.000Z', eliminationReason: '主人淘汰：品牌风险', dataRevision: 9, ...extra });
const props = (candidates, extra = {}) => ({ candidates, store: 'miska', onOpenCandidate: forbidden,
  onEliminateCandidate: forbidden, onRestoreCandidate: forbidden, ...extra });

test('进行中每张卡片都能淘汰，已淘汰折在最下面并能恢复', async () => {
  const html = (await pages()).board(props([
    candidate('candidate:a', { executionRuntime: { businessPhase: 'A' } }),
    candidate('candidate:b', { executionRuntime: { businessPhase: 'B' } }),
    dropped('candidate:gone', { productName: '被淘汰的合成商品' })
  ]));
  assert.match(html, /共 2 件在做的商品/u, '已淘汰的不算在进行中里');
  assert.doesNotMatch(html, /被淘汰的合成商品<\/b><span class="board-card-status"/u);
  assert.equal((html.match(/eliminate-button/gu) ?? []).length, 2, '每张卡片一个淘汰');
  // 淘汰 is its own control outside the card button, so opening a product and dropping it are never one click.
  assert.match(html, /<\/button><button type="button" class="button secondary eliminate-button">淘汰<\/button><\/div>/u);
  assert.match(html, /已淘汰 1（默认隐藏）/u);
  assert.match(html, /主人淘汰：品牌风险/u);
  assert.match(html, />恢复</u);
  const empty = (await pages()).board(props([]));
  assert.match(empty, /本店暂时没有在做的商品/u);
  assert.doesNotMatch(empty, /已淘汰/u, '没有淘汰过就不出现这一块');
});

test('需要你处理每行直接写出为什么等你和下一步按钮，不用挨个打开', async () => {
  const draft = { schemaVersion: 'supplier-draft-v1', sourceUrl: 'https://detail.1688.com/offer/876240928352.html' };
  const html = (await pages()).inbox(props([
    candidate('candidate:draft', { productName: '还没填找货的商品', needsFromUser: ['补一个1688链接'] }),
    candidate('candidate:blocked', { productName: '没过线的商品', supplierDraftV1: draft, needsFromUser: ['确认采购价'],
      supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: false, unitProfitRmb: 1.2, marginRate: 0.03 } } }),
    candidate('candidate:sku', { productName: '等你选规格的商品', supplierDraftV1: draft,
      sourceCapture: { status: 'captured_waiting_owner_selection' },
      supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: true, unitProfitRmb: 41.26 } } }),
    dropped('candidate:gone')
  ]));
  assert.match(html, /共 3 条等你/u);
  // Every reason is a sentence read from that product's own saved records, on its own line.
  assert.match(html, /找货还没填/u);
  assert.match(html, /补一个1688链接/u);
  assert.match(html, /按你填的到手总价没到本店利润门槛：单件利润 ¥1\.20 · 利润率 3%/u);
  assert.match(html, /插件已采到1688页面，等你选具体规格/u);
  for (const label of ['去填找货', '去改找货', '去选规格']) assert.match(html, new RegExp(`>${label}<`, 'u'));
  assert.equal((html.match(/eliminate-button/gu) ?? []).length, 3, '每行一个淘汰');
  assert.match(html, /已淘汰 1（默认隐藏）/u);
  assert.match(html, /主人淘汰：品牌风险/u);
  const empty = (await pages()).inbox(props([]));
  assert.match(empty, /现在没有等你处理的商品/u);
});

test('需要你处理的每一行都开到那件商品自己的页面，「去选规格」不再把主人丢回旧版工程页', async () => {
  const { readFile } = await import('node:fs/promises');
  const inbox = await readFile(fileURLToPath(new URL('../src/components/OwnerInbox.jsx', import.meta.url)), 'utf8');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(inbox, /const open = item => onOpenCandidate\(item\.id\);/u);
  assert.doesNotMatch(inbox, /onOpenLegacyCandidate/u, '选规格已经是商品页自己的一步，收件箱不再有第二条出口');
  assert.doesNotMatch(app, /openLegacyCandidate/u);
  // 旧版A卡仍然进得去，只是要主人自己点，而不是收件箱替他决定。
  assert.match(app, /view: "review", label: "今日选品评审"/u);
});
