import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { inboxItems, roundStartPayload, sourceLinkPayload, sourceLinkRefusal, sourceLinkResult, unsourcedReason,
  unsourcedRows } from '../src/selectionDeskView.js';

// 需要你处理, the desk and the page-wide notices render synthetic display data only: no saved records, no services.
let renderer;
async function pages() {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./inbox-notices-ui-entry.jsx', import.meta.url));
    const file = name => JSON.stringify(fileURLToPath(new URL(`../src/components/${name}`, import.meta.url)));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'inbox-notices-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Notices from ${file('GlobalNotices.jsx')};import Inbox from ${file('OwnerInbox.jsx')};import Desk from ${file('SelectionDesk.jsx')};
      export const notices=props=>renderToStaticMarkup(<Notices {...props}/>);
      export const inbox=props=>renderToStaticMarkup(<Inbox {...props}/>);
      export const desk=props=>renderToStaticMarkup(<Desk {...props}/>);` : null }],
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
  updatedAt: '2026-10-10T04:00:00.000Z', createdAt: '2026-10-10T04:00:00.000Z', ...extra });
const intake = (stage, blocker = null, sourceKind = 'seerfar') => ({ sourceKind, sourceUrl: 'https://synthetic.example/x',
  submittedAt: '2026-10-10T04:00:00.000Z', stage, blocker, queue: null });
const sourced = extra => candidate('sourced', { sourceCapture: { status: 'verified' }, ...extra });

test('a product without a source says why; one with a source or still being read says nothing', () => {
  assert.equal(unsourcedReason(candidate('a', { intake: intake('blocked', { code: 'no_source_price', message: null, retryable: false }) })),
    '一个货源价都没读到');
  assert.equal(unsourcedReason(candidate('b', { intake: intake('blocked', { code: 'source_delisted', message: '这条拼多多已下架', retryable: false }) })),
    '这条拼多多已下架', 'a saved message is repeated as saved');
  assert.equal(unsourcedReason(candidate('c')), '还没有货源');
  assert.equal(unsourcedReason(candidate('d', { supplierImageMatch: { status: 'compared', results: [{ similarity: 'similar' }], judgements: {} } })),
    '1688 以图搜没找到首图一致的货源', 'a near match is never a source');
  assert.equal(unsourcedReason(candidate('e', { supplierImageMatch: { status: 'compared', results: [{ similarity: 'identical' }] } })), '还没有货源');
  assert.equal(unsourcedReason(candidate('f', { supplierImageMatch: { status: 'searching', results: [] } })), null);
  assert.equal(unsourcedReason(candidate('g', { intake: intake('searching_1688') })), null);
  assert.equal(unsourcedReason(candidate('h', { intake: intake('ready', null, 'pinduoduo') })), null);
  assert.equal(unsourcedReason(candidate('i', { roughProfit: { purchaseBasis: '1688_match' } })), null);
  assert.equal(unsourcedReason(sourced()), null);
  assert.equal(unsourcedReason(candidate('j', { workflowStatus: 'listed' })), null);
});

test('a blocked-without-source product is a 需要你处理 row whose action is 贴货源链接; the rest are folded rows', () => {
  const candidates = [candidate('blocked', { intake: intake('blocked', { code: 'source_out_of_stock', message: null, retryable: false }) }),
    candidate('legacy'), sourced(), candidate('gone', { workflowStatus: 'eliminated' }), candidate('other', { targetStore: 'dandanshu' })];
  const items = inboxItems(candidates, 'miska');
  assert.deepEqual(items.map(item => item.id), ['blocked']);
  assert.deepEqual(items[0].action, { key: 'source_link', label: '贴货源链接' });
  assert.match(items[0].reasons[0], /货源所有规格都没货，贴一个能一件起订的货源链接/u);
  assert.deepEqual(unsourcedRows(candidates, 'miska').map(row => [row.id, row.reason]), [['legacy', '还没有货源']]);
});

test('a link pasted on a product attaches to that product; on a market row it is a product of its own', () => {
  assert.deepEqual(sourceLinkPayload('https://detail.1688.com/offer/1.html', { candidateId: 'c1', dataRevision: 7 }),
    { links: ['https://detail.1688.com/offer/1.html'], attachTo: { candidateId: 'c1', dataRevision: 7 } });
  assert.deepEqual(sourceLinkPayload('https://detail.1688.com/offer/1.html', { batchId: 'b', marketProductId: 'm' }),
    { links: ['https://detail.1688.com/offer/1.html'] });
  const attached = sourceLinkResult({ items: [{ candidateId: 'c1', created: false, attached: true }], rejected: [] });
  assert.deepEqual(attached, { message: '已换上这个货源，这件会从读货源页重新开始，找完回到需要你处理。', candidateId: null });
  const fresh = sourceLinkResult({ items: [{ candidateId: 'new', created: true, duplicateOfCandidateId: null }], rejected: [] });
  assert.equal(fresh.candidateId, 'new');
  for (const result of [attached, fresh]) assert.doesNotMatch(result.message, /原来这件不会自动合并/u);
  assert.match(sourceLinkResult({ items: [], rejected: [{ raw: 'x', code: 'link_unrecognized' }] }).message, /没认出/u);
  assert.match(sourceLinkResult({}).message, /未确认/u);
});

test('a link that already belongs to another card is an answer naming that card, not an error', () => {
  assert.deepEqual(sourceLinkResult({ items: [{ candidateId: 'old', created: false, duplicateOfCandidateId: 'old',
    duplicateEliminated: false, sourceKind: '1688' }], rejected: [] }),
  { message: '这个货源之前贴过，已经在另一件商品上，没有多建一张卡。', candidateId: 'old' });
  assert.match(sourceLinkResult({ items: [{ candidateId: 'old', created: false, duplicateOfCandidateId: 'old', duplicateEliminated: true }] }).message,
    /已经淘汰了/u);
  const refused = Object.assign(new Error('x'), { status: 409, body: { code: 'intake_attach_duplicate',
    duplicateOfCandidateId: 'old', duplicateEliminated: false } });
  assert.deepEqual(sourceLinkRefusal(refused), { message: '这个货源之前贴过，已经在另一件商品上，没有多建一张卡。', candidateId: 'old' });
  for (const code of ['revision_conflict', 'intake_attach_busy', 'intake_attach_has_source']) {
    assert.equal(sourceLinkRefusal(Object.assign(new Error('x'), { status: 409, body: { code } })), null, code);
  }
  assert.equal(sourceLinkRefusal(new Error('network')), null);
});

test('重跑 of a round is the same priced start as 找一轮新品, with a fresh key', () => {
  const payload = roundStartPayload({ plan: { planId: 'p', version: 2 }, binding: { bindingId: 'b', configurationVersion: 'v1' }, store: 'miska' },
    Date.parse('2026-10-10T04:00:00.000Z'), 'k1');
  assert.deepEqual(payload, { planId: 'p', planVersion: 2, targetStore: 'miska', bindingId: 'b', configurationVersion: 'v1',
    expiresAt: '2026-10-10T06:00:00.000Z', idempotencyKey: 'desk-round:k1' });
});

test('the page-wide notices render once, and a stopped run is one to-do with 重跑 that starts nothing on render', async () => {
  const html = (await pages()).notices({ extensionStatus: { code: 'disconnected' }, intakeQueue: { items: [], pause: null, extension: { online: false, login1688: 'expired' } },
    store: 'miska', discoveryView: { batches: [] }, onRetryIntake: forbidden, onStartRound: forbidden,
    candidates: [candidate('a', { intake: intake('blocked', { code: 'plugin_offline', message: null, retryable: true, scope: 'page' }, 'pinduoduo') }),
      candidate('b', { intake: intake('blocked', { code: 'plugin_offline', message: null, retryable: true, scope: 'page' }, 'pinduoduo') })] });
  assert.equal((html.match(/插件没连上，或者 Chrome 关着<\/strong>/gu) ?? []).length, 1);
  assert.match(html, /1688 登录过期了/u);
  assert.match(html, /href="https:\/\/login\.1688\.com\/"/u);
  assert.match(html, /没跑成的（1）/u);
  assert.match(html, /2 件商品没跑完/u);
  assert.equal((html.match(/>接着找</gu) ?? []).length, 1);
});

test('on the intake page the paused queue is not repeated; the plugin notice still is', async () => {
  const html = (await pages()).notices({ extensionStatus: { code: 'disconnected' }, intakeShownOnPage: true,
    intakeQueue: { items: [], pause: null, extension: { online: false, login1688: 'ok' } }, store: 'miska', discoveryView: { batches: [] },
    onRetryIntake: forbidden, onResumeIntake: forbidden, onStartRound: forbidden,
    candidates: [candidate('a', { intake: intake('blocked', { code: 'slider_required', message: null, retryable: true, scope: 'page' }, 'pinduoduo') })] });
  assert.match(html, /插件没连上，或者 Chrome 关着/u);
  assert.doesNotMatch(html, /要你验证一下/u);
  assert.doesNotMatch(html, /接着找</u);
});

test('nothing wrong renders nothing at the top of the page', async () => {
  const html = (await pages()).notices({ extensionStatus: { code: 'connected' }, intakeQueue: { items: [], pause: null, extension: { online: true, login1688: 'ok' } },
    store: 'miska', discoveryView: { batches: [] }, candidates: [sourced()] });
  assert.equal(html, '');
});

test('a stopped round that needs maintenance shows its reason without a 重跑 button', async () => {
  const html = (await pages()).notices({ extensionStatus: { code: 'connected' }, intakeQueue: null, store: 'miska', candidates: [],
    discoveryView: { batches: [{ batch: { batchId: 'r', revision: 1, targetStore: 'miska', createdAt: '2026-10-10T02:00:00.000Z',
      plan: { provider: 'seerfar', direction: '合成方向' } },
    jobs: [{ job: { status: 'failed', completedAt: '2026-10-10T02:05:00.000Z', scopeBinding: { request: { method: 'category_detail' } } },
      receipt: { completedAt: '2026-10-10T02:05:00.000Z', failureClass: 'RESPONSE_INVALID', steps: [] } }] }] } });
  assert.match(html, /Seerfar 可能改版了/u);
  assert.match(html, /查询「合成方向」没跑成/u);
  assert.doesNotMatch(html, />重跑</u);
});

test('需要你处理 offers 贴货源链接 on the blocked row and on every folded unsourced row', async () => {
  const html = (await pages()).inbox({ store: 'miska', onOpenCandidate: forbidden, onEliminateCandidate: forbidden,
    onRestoreCandidate: forbidden, onSubmitSourceLink: forbidden, candidates: [
      candidate('blocked', { intake: intake('blocked', { code: 'no_source_price', message: null, retryable: false }) }),
      candidate('legacy-1'), candidate('legacy-2'), sourced()] });
  assert.match(html, /共 1 条等你/u);
  assert.match(html, /还没有货源的 2 件（逐件贴货源链接）/u);
  assert.equal((html.match(/source-link-button">贴货源链接</gu) ?? []).length, 3);
});

test('the desk gives every folded history row 贴货源链接 and points the rail at the unsourced products', async () => {
  const product = productId => ({ productId, title: `Explicitly synthetic ${productId}`, productUrl: `https://www.ozon.ru/product/${productId}`,
    imageUrl: '', price: 900, salesCount: 12, reviewCount: 4, reviewRating: 4.5, categoryPath: { cnTitlePath: '家居' } });
  const batch = (batchId, createdAt, productId) => ({ batch: { batchId, revision: 0, targetStore: 'miska', createdAt,
    plan: { provider: 'seerfar', direction: '合成方向' } },
  jobs: [{ job: { status: 'completed', completedAt: createdAt, scopeBinding: { request: { method: 'category_detail' } } },
    receipt: { steps: [{ method: 'category_detail', result: { products: [product(productId)] } }] } }],
  importedCandidates: [], selections: [], declines: [] });
  const html = (await pages()).desk({ store: 'miska', candidates: [candidate('legacy')], onSubmitSourceLink: forbidden,
    discoveryView: { schemaVersion: 'a-discovery-view-v1', targetStores: ['miska'], plans: [], bindings: [],
      batches: [batch('new', '2026-10-10T04:00:00.000Z', '1'), batch('old', '2026-10-09T04:00:00.000Z', '2')] },
    onSelectProduct: forbidden, onDeclineProduct: forbidden, onLaterProduct: forbidden, onOpenCandidate: forbidden,
    onEliminateCandidate: forbidden, onRestoreCandidate: forbidden });
  assert.match(html, /历史轮次未处理的 1 条/u);
  assert.equal((html.match(/source-link-button">贴货源链接</gu) ?? []).length, 1, 'only the folded row, not the current round');
  assert.match(html, /还有 1 件没有货源/u);
});
