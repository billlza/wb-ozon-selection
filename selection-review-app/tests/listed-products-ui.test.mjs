import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { listedProductGroups, listedReadback } from '../src/listedProductsView.js';

// 在售只渲染合成的记录：不读保存的数据、不读平台、不发请求。
let renderer;
async function page() {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./listed-products-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/ListedProducts.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'listed-products-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Listed from ${JSON.stringify(component)};
      export const render=props=>renderToStaticMarkup(<Listed {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer;
}
const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const verified = (id, verifiedAt, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: 'miska', workflowStatus: 'listed',
  imageUrl: '', updatedAt: verifiedAt,
  lifecycleV11: { skuPackage: { productionRecord: { platformProductId: '9000001', createdAt: verifiedAt },
    eVerificationRecord: { outcome: 'listed_verified', verifiedAt, platformProductId: '9000001',
      currentPrice: { amount: 801, currency: 'RUB' }, currentStock: 5, saleStatus: 'unknown' } } }, ...extra });

test('在售按店分开，最近回读通过的在上面；已写到平台但回读还没通过的单列一组', () => {
  const groups = listedProductGroups([
    verified('candidate:old', '2026-10-01T02:00:00.000Z'),
    verified('candidate:new', '2026-10-10T02:00:00.000Z'),
    verified('candidate:other-store', '2026-10-11T02:00:00.000Z', { targetStore: 'dandanshu' }),
    verified('candidate:dropped', '2026-10-11T02:00:00.000Z', { workflowStatus: 'eliminated' }),
    { id: 'candidate:written', productName: '合成已写入', targetStore: 'miska', workflowStatus: 'ready_to_list',
      lifecycleV11: { skuPackage: { productionRecord: { platformProductId: '9000002', createdAt: '2026-10-11T03:00:00.000Z' } } },
      eReadbackRuntimeView: { status: 'failed', startedAt: '2026-10-11T03:10:00.000Z', completedAt: '2026-10-11T03:11:00.000Z', result: { gaps: ['listedStatus'] } } },
    { id: 'candidate:writing', productName: '合成写文案', targetStore: 'miska', workflowStatus: 'listing_preparation', lifecycleV11: { skuPackage: {} } }
  ], 'miska');
  assert.deepEqual(groups.live.map(row => row.id), ['candidate:new', 'candidate:old']);
  assert.deepEqual(groups.pending.map(row => row.id), ['candidate:written']);
  assert.equal(groups.live[0].platformProductId, '9000001');
  // 平台没读出来的销售状态不写成一个状态。
  assert.equal(groups.live[0].observed, '售价 801 RUB · 库存 5');
  assert.equal(groups.live[0].readback.tone, 'ok');
  assert.match(groups.live[0].readback.label, /^回读通过：软件上架的商品/u);
  assert.equal(groups.pending[0].readback.tone, 'warning');
});

test('回读的说法只来自保存的记录：来源对不上要核对，旧版手动标记的照实说没有回读', () => {
  assert.equal(listedReadback(verified('candidate:conflict', '2026-10-10T02:00:00.000Z', { eReadbackRuntimeView: { status: 'source_conflict' } })).label,
    '回读记录和这件商品现在的资料对不上，需要核对');
  assert.equal(listedReadback({ workflowStatus: 'listed', listedAt: null }).label, '以前手动标成已上架的，没有软件回读记录');
  assert.equal(listedReadback({ workflowStatus: 'listed', lifecycleV11: { skuPackage: { eVerificationRecord: { outcome: 'externally_verified',
    verifiedAt: '2026-10-10T02:00:00.000Z' } } } }).label, '回读通过：平台上原本就有的商品');
  assert.equal(listedReadback({ workflowStatus: 'ready_to_list', lifecycleV11: { skuPackage: { productionRecord: {} } } }).label, '已经写到平台，还没有回读');
});

test('在售页只读：每行一个「打开」，渲染时什么也不发', async () => {
  const html = (await page()).render({ candidates: [verified('candidate:new', '2026-10-10T02:00:00.000Z')], store: 'miska', onOpenCandidate: forbidden });
  assert.match(html, /<h2>在售<\/h2>/u);
  assert.match(html, /在售 1 件。回读结果来自软件保存的记录，这一页不去读平台。/u);
  assert.match(html, /合成商品 candidate:new/u);
  assert.match(html, /平台商品号 9000001 · 售价 801 RUB · 库存 5/u);
  assert.equal((html.match(/<button/gu) ?? []).length, 1);
  const empty = (await page()).render({ candidates: [], store: 'miska', onOpenCandidate: forbidden });
  assert.match(empty, /这家店还没有在售的商品。/u);
  assert.doesNotMatch(empty, /已写到平台，回读还没通过/u);
});

test('录入页底部有「在售的商品」，打开一件走同一条读取保存记录的路', async () => {
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const intake = await readFile(fileURLToPath(new URL('../src/components/IntakePage.jsx', import.meta.url)), 'utf8');
  assert.match(app, /onOpenLive=\{\(\) => setView\("live"\)\}/u);
  assert.match(app, /<ListedProducts candidates=\{state\.candidates\} store=\{deskStore\} discoveryView=\{discoveryView\} onOpenCandidate=\{openDiscoveredCandidate\} \/>/u);
  assert.match(app, /const CANDIDATE_LINK_VIEWS = \[[^\]]*"live"[^\]]*\];/u);
  assert.match(intake, />在售的商品<\/button>/u);
});
