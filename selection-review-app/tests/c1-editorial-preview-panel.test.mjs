import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./c1-editorial-preview-panel-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/C1EditorialReviewPanel.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), {
      name: 'c1-editorial-preview-panel-test', resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
        import Panel from ${JSON.stringify(component)};
        export const render=props=>renderToStaticMarkup(<Panel {...props}/>);` : null
    }], ssr: { noExternal: true }, build: { ssr: true, write: false,
      rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}

const noWrite = () => { throw new Error('EDITORIAL_PREVIEW_MUST_NOT_SUBMIT'); };
function fixture(status = 'proposal_only') {
  const title = { text: 'Синтетический новый заголовок', reviewZh: '合成的新标题' };
  return { candidate: { id: 'candidate:synthetic-editorial-preview', c1EditorialReviewView: {
    status, canConfirm: status === 'awaiting_confirmation', expectedRevision: 10,
    editorialVersionId: 'editorial:synthetic-preview', outputFingerprint: 'a'.repeat(64),
    content: { title, description: { text: 'Синтетическое новое описание', reviewZh: '合成的新描述' },
      bulletPoints: [{ text: 'Синтетический дополнительный пункт', reviewZh: '合成的补充卖点' }],
      searchKeywords: [{ text: 'синтетический поисковый запрос', reviewZh: '合成的搜索词' }] },
    changes: [{ path: 'output.title', before: { text: 'Синтетический старый заголовок', reviewZh: '合成的旧标题' },
      after: title, explanation: '仅调整已保存事实的措辞，事实记录不变。' }]
  } }, identity: { roles: ['owner'] }, onConfirm: noWrite };
}

test('provisional preview displays each Russian field and its actual Chinese meaning with the bilingual change', async () => {
  const props = fixture(), before = structuredClone(props.candidate);
  const html = await render({ ...props, provisional: true });
  for (const text of ['Синтетический новый заголовок', '合成的新标题', 'Синтетическое новое описание', '合成的新描述',
    'Синтетический дополнительный пункт', '合成的补充卖点', 'синтетический поисковый запрос', '合成的搜索词',
    'Синтетический старый заголовок', '原中文释义：合成的旧标题', '修订后中文释义：合成的新标题', '仅调整已保存事实的措辞']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /修订文案预览（未确认）/u);
  assert.match(html, /本地修订提案/u);
  assert.match(html, /没有保存确认或推进流程/u);
  assert.match(html, /<details open="">/u);
  assert.doesNotMatch(html, /<button\b|<form\b|进入图片|失败记录|原模型输出/u);
  assert.deepEqual(props.candidate, before);
});

test('provisional flag suppresses mutation controls even when an owner receives a confirmable view', async () => {
  const html = await render({ ...fixture('awaiting_confirmation'), provisional: true });
  assert.doesNotMatch(html, /<button\b|<form\b|确认后进入图片|本次确认仅采用/u);
  const proposal = fixture(); proposal.candidate.c1EditorialReviewView.canConfirm = true;
  assert.doesNotMatch(await render(proposal), /<button\b|<form\b/u);
});

test('normal confirmation keeps its owner permission, callback and read-only viewer gates', async () => {
  const props = fixture('awaiting_confirmation');
  const owner = await render(props);
  assert.match(owner, /确认修订文案，进入图片/u);
  assert.doesNotMatch(owner, /disabled=""/u);
  for (const changes of [{ identity: { roles: ['viewer'] } }, { onConfirm: undefined }]) {
    assert.match(await render({ ...props, ...changes }), /disabled=""[^>]*>确认修订文案，进入图片/u);
  }
  assert.match(await render(fixture('confirmed')), /修订文案已确认/u);
  assert.doesNotMatch(await render(fixture('confirmed')), /<button\b/u);
});

test('missing, inapplicable and blocked views keep their existing behavior; legacy text has no invented translation', async () => {
  assert.equal(await render({ candidate: {} }), '');
  assert.equal(await render(fixture('not_applicable')), '');
  const blocked = await render({ ...fixture('blocked'), provisional: true });
  assert.match(blocked, /当前商品或修订来源与准备时不一致/u);
  assert.doesNotMatch(blocked, /<button\b|合成的新标题/u);
  const legacy = fixture('awaiting_confirmation'), view = legacy.candidate.c1EditorialReviewView;
  for (const item of [view.content.title, view.content.description, ...view.content.bulletPoints, ...view.content.searchKeywords,
    ...view.changes.flatMap(change => [change.before, change.after])]) delete item.reviewZh;
  const html = await render(legacy);
  assert.match(html, /Синтетический новый заголовок/u);
  assert.doesNotMatch(html, /中文释义/u);
});

test('revising an existing final plan preserves the image confirmation and names the actual next action', async () => {
  const props = fixture('awaiting_confirmation');
  props.candidate.c1EditorialReviewView.restoresConfirmedAssets = true;
  const html = await render(props);
  assert.match(html, /确认修订文案并更新方案卡/u);
  assert.match(html, /保留原图片、首图和顺序确认/u);
  assert.doesNotMatch(html, /确认修订文案，进入图片/u);
  const confirmed = fixture('confirmed');
  confirmed.candidate.c1EditorialReviewView.finalCardCreated = true;
  const saved = await render(confirmed);
  assert.match(saved, /方案卡已更新，原图片、首图和顺序确认已保留/u);
  assert.doesNotMatch(saved, /可以准备本规格的图片|<button\b/u);
});

test('Russian text, Chinese review and explanation are escaped as text rather than executable markup', async () => {
  const props = fixture(), view = props.candidate.c1EditorialReviewView;
  view.content.title.text = '<script>bad()</script>';
  view.content.title.reviewZh = '<img src=x onerror=bad()>';
  view.changes[0].explanation = '<iframe src="bad"></iframe>';
  const html = await render({ ...props, provisional: true });
  assert.doesNotMatch(html, /<script\b|<img\b|<iframe\b/u);
  assert.match(html, /&lt;script&gt;/u);
  assert.match(html, /&lt;img/u);
  assert.match(html, /&lt;iframe/u);
});
