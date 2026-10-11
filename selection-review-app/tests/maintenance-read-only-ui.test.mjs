import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// 维护里的旧页面只能看，不能改。渲染只用合成的按钮，不读任何记录、不发任何请求。
let renderer;
async function wrapper() {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./maintenance-read-only-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/MaintenanceReadOnly.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'maintenance-read-only-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import ReadOnly from ${JSON.stringify(component)};
      export const render=props=>renderToStaticMarkup(<ReadOnly {...props}><button type="button">合成的保存按钮</button><a href="https://example.test/">合成链接</a></ReadOnly>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer;
}
const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };

test('旧页面整块放在禁用的 fieldset 里：按钮点不动，链接照常能开', async () => {
  const html = (await wrapper()).render({});
  assert.match(html, /<fieldset class="maint-readonly-body" disabled="">.*合成的保存按钮.*<\/fieldset>/u);
  assert.match(html, /<a href="https:\/\/example\.test\/">合成链接<\/a>/u);
  assert.match(html, /这是以前的页面，只能看，不能改。要处理商品，请从「进行中」或「需要你处理」打开它自己的页面。/u);
  assert.doesNotMatch(html, /打开这件商品自己的页面/u);
});

test('今日选品评审选中一件商品时，出口是这件商品自己的页面，按钮在 fieldset 外面', async () => {
  const html = (await wrapper()).render({ onOpenProduct: forbidden });
  const [note, body] = html.split('<fieldset');
  assert.match(note, /<button type="button" class="button secondary">打开这件商品自己的页面<\/button>/u);
  assert.doesNotMatch(body, /打开这件商品自己的页面/u);
});

test('维护里能写东西的四个旧页面都包在只读里；能力地图本来只读，不包', async () => {
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /<MaintenanceReadOnly><ProductDiscoveryCard view=\{discoveryView\}/u);
  assert.match(app, /<MaintenanceReadOnly><OzonAccountPreparationCard view=\{accountPreparationView\}/u);
  assert.match(app, /<MaintenanceReadOnly><Phase2ASimulation /u);
  assert.match(app, /<MaintenanceReadOnly onOpenProduct=\{\(\) => openDiscoveredCandidate\(selected\.id\)\}>[\s\S]*<CandidateDetail[\s\S]*<UserInspector[\s\S]*<CandidateReview candidate=\{selected\} \/>\s*<\/MaintenanceReadOnly>/u);
  assert.doesNotMatch(app, /<MaintenanceReadOnly>\s*<ThreeStoreMap/u);
  assert.match(app, /这些是以前的页面，现在只能看，不能改。/u);
  // 从旧页面打开商品页要走同一条读取保存记录的路。
  assert.match(app, /const CANDIDATE_LINK_VIEWS = \[[^\]]*"review"[^\]]*\];/u);
});
