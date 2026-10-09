import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

import { HEADER_STATUS_OK_LABEL, headerStatusIndicator } from '../src/headerStatusView.js';
import { EXPECTED_EXTENSION_VERSION, extensionConnectionStatus } from '../src/extensionStatus.js';
import { runtimeArchitectureView } from '../src/runtimeArchitectureView.js';

/**
 * 顶栏原来并排挂着三条工程状态。把它们收成一个指示器只有在一件事上是安全的：三条原来能表达的每一种不正常，
 * 新指示器都还说得出来。下面的用例就是守这一条 —— 状态枚举不是抄来的常量表，而是让那两个派生函数自己把
 * 它们能产生的每一种状态生成出来，再逐个过一遍指示器。
 */

/** 插件那条线自己能产生的全部状态，由 extensionConnectionStatus 自己生成，而不是这里手抄一份。 */
const EXTENSION_STATES = [
  extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: true }),
  extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false }),
  extensionConnectionStatus({ liveVersion: '0.9.1', backgroundReady: true }),
  extensionConnectionStatus({ cachedVersion: EXPECTED_EXTENSION_VERSION }),
  extensionConnectionStatus({ cachedVersion: '0.9.1' }),
  extensionConnectionStatus({}),
  extensionConnectionStatus({ serverHeartbeat: { fresh: true, version: EXPECTED_EXTENSION_VERSION, backgroundReady: true } }),
  extensionConnectionStatus({ serverHeartbeat: { fresh: true, version: EXPECTED_EXTENSION_VERSION, backgroundReady: false } })
];
const CONNECTED = extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: true });

/** 运行架构那条线同样由 runtimeArchitectureView 自己生成。 */
const LOCAL_RUNTIME = { schemaVersion: 'runtime-architecture-status-v1', multiUserReady: false, deploymentMode: 'local_development' };
const CENTRAL_RUNTIME = {
  schemaVersion: 'runtime-architecture-status-v1', status: 'central_runtime_ready', deploymentMode: 'central_test',
  multiUserReady: true, concurrencyScope: 'database_transaction', identityProvider: 'company_sso',
  softwareJobStore: 'postgres', workerRegistry: 'postgres', currentUser: { userId: 'synthetic-owner' }
};
const RUNTIME_STATES = [LOCAL_RUNTIME, CENTRAL_RUNTIME, null];

/** 采集控制那条线：服务端 captureControlSnapshot 只有这两种，外加「这一条根本没读到」。 */
const IDLE_CONTROL = { status: 'idle', label: '商品采集控制空闲', candidateId: null, platform: null };
const BUSY_CONTROL = { status: 'busy', label: '商品采集控制已由 candidate:synthetic 占用（1688）', candidateId: 'candidate:synthetic', platform: '1688' };
const CAPTURE_STATES = [IDLE_CONTROL, BUSY_CONTROL, null, undefined, { status: '', label: '' }];

const normalExtension = status => status.code === 'connected';
const normalRuntime = status => ['local_development', 'central_ready'].includes(runtimeArchitectureView(status).code);
const normalCapture = control => control?.status === 'idle';

test('三条状态都正常时，顶栏只剩一个圆点和「一切正常」', () => {
  for (const runtimeArchitecture of [LOCAL_RUNTIME, CENTRAL_RUNTIME]) {
    const view = headerStatusIndicator({ extensionStatus: CONNECTED, captureControl: IDLE_CONTROL, runtimeArchitecture });
    assert.equal(view.ok, true);
    assert.equal(view.tone, 'ok');
    assert.equal(view.label, HEADER_STATUS_OK_LABEL);
    assert.deepEqual(view.issues, []);
  }
});

test('插件那条线的每一种不正常都还说得出来，而且说的是它影响什么', () => {
  // 先证明枚举本身没有漏：这些输入确实覆盖了 extensionConnectionStatus 能返回的全部 code。
  assert.deepEqual(new Set(EXTENSION_STATES.map(status => status.code)),
    new Set(['connected', 'background_unavailable', 'reload_required', 'page_refresh_required', 'disconnected']));
  const said = new Map();
  for (const extensionStatus of EXTENSION_STATES) {
    const view = headerStatusIndicator({ extensionStatus, captureControl: IDLE_CONTROL, runtimeArchitecture: LOCAL_RUNTIME });
    if (normalExtension(extensionStatus)) { assert.equal(view.ok, true); continue; }
    assert.equal(view.ok, false, `${extensionStatus.code} 必须被顶栏说出来`);
    assert.equal(view.issues.length, 1);
    assert.equal(view.issues[0].source, 'extension');
    assert.equal(view.issues[0].code, extensionStatus.code);
    assert.match(view.label, /插件/u);
    assert.notEqual(view.label, HEADER_STATUS_OK_LABEL);
    said.set(extensionStatus.code, view.label);
    // 每一句都必须说清楚现在做不了什么，而不是只报一个状态名。
    assert.match(view.label, /采集|失败|发不出/u);
  }
  assert.equal(said.get('disconnected'), '插件没连上，现在没法采集1688页面');
  assert.equal(said.get('background_unavailable'), '插件后台没有响应，现在发不出采集任务');
  assert.match(said.get('reload_required'), /旧版本.*重新加载/u);
  assert.match(said.get('page_refresh_required'), /刷新这一页/u);
  // 认不出来的 code 也算不正常：「不知道」不能显示成「一切正常」。
  for (const unknown of [{ code: 'brand_new_failure' }, { code: '' }, {}, null]) {
    const view = headerStatusIndicator({ extensionStatus: unknown, captureControl: IDLE_CONTROL, runtimeArchitecture: LOCAL_RUNTIME });
    assert.equal(view.ok, false);
    assert.equal(view.tone, 'error');
    assert.match(view.label, /插件状态没取到/u);
  }
});

test('运行方式：本地开发和中央运行都是正常，只有读不出来才占注意力', () => {
  assert.deepEqual(RUNTIME_STATES.map(status => runtimeArchitectureView(status).code),
    ['local_development', 'central_ready', 'unavailable']);
  for (const runtimeArchitecture of [LOCAL_RUNTIME, CENTRAL_RUNTIME]) {
    assert.equal(headerStatusIndicator({ extensionStatus: CONNECTED, captureControl: IDLE_CONTROL, runtimeArchitecture }).ok, true);
  }
  const unreadable = headerStatusIndicator({ extensionStatus: CONNECTED, captureControl: IDLE_CONTROL, runtimeArchitecture: null });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.tone, 'error');
  assert.equal(unreadable.issues[0].source, 'runtime');
  assert.match(unreadable.label, /运行方式没读出来.*保存/u);
  // 「本地开发模式」被收起来了，但没有被丢掉：鼠标停上去仍然能看到它和它的原话。
  const normal = headerStatusIndicator({ extensionStatus: CONNECTED, captureControl: IDLE_CONTROL, runtimeArchitecture: LOCAL_RUNTIME });
  assert.match(normal.detail, /本地开发模式/u);
  assert.match(normal.detail, /当前服务的本地数据文件/u);
  assert.match(normal.detail, /插件已连接 · 等待采集任务/u);
  assert.match(normal.detail, /商品采集控制空闲/u);
});

test('采集控制：有一件商品占着时说清楚谁在采，状态没取到算不正常', () => {
  const busy = headerStatusIndicator({ extensionStatus: CONNECTED, captureControl: BUSY_CONTROL, runtimeArchitecture: LOCAL_RUNTIME });
  assert.equal(busy.ok, false);
  assert.equal(busy.tone, 'busy');
  assert.equal(busy.issues[0].source, 'capture');
  assert.match(busy.label, /candidate:synthetic 正在采集（1688）/u);
  assert.match(busy.label, /别的商品要等它结束/u);
  for (const captureControl of [null, undefined, { status: '', label: '' }, { status: 'brand_new_state' }]) {
    const view = headerStatusIndicator({ extensionStatus: CONNECTED, captureControl, runtimeArchitecture: LOCAL_RUNTIME });
    assert.equal(view.ok, false);
    assert.equal(view.tone, 'error');
    assert.match(view.label, /商品采集控制的状态没取到/u);
  }
});

test('三条里任意一条不正常，顶栏必须说出来；三条都不正常就三句都在', () => {
  let combinations = 0;
  for (const extensionStatus of EXTENSION_STATES) {
    for (const captureControl of CAPTURE_STATES) {
      for (const runtimeArchitecture of RUNTIME_STATES) {
        combinations += 1;
        const view = headerStatusIndicator({ extensionStatus, captureControl, runtimeArchitecture });
        const abnormal = [
          normalExtension(extensionStatus) ? null : 'extension',
          normalCapture(captureControl) ? null : 'capture',
          normalRuntime(runtimeArchitecture) ? null : 'runtime'
        ].filter(source => source !== null);
        assert.equal(view.ok, abnormal.length === 0);
        assert.deepEqual(new Set(view.issues.map(issue => issue.source)), new Set(abnormal));
        if (abnormal.length === 0) { assert.equal(view.label, HEADER_STATUS_OK_LABEL); continue; }
        assert.notEqual(view.label, HEADER_STATUS_OK_LABEL, '任意一条不正常都不能显示成一切正常');
        assert.equal(view.label, view.issues[0].sentence);
        // 最要紧的那一条排在最前面：读不出来 > 要动手修 > 只是占着。
        const rank = { error: 3, warning: 2, busy: 1 };
        for (let index = 1; index < view.issues.length; index += 1) {
          assert.ok(rank[view.issues[index - 1].tone] >= rank[view.issues[index].tone]);
        }
        assert.equal(view.tone, view.issues[0].tone);
      }
    }
  }
  assert.equal(combinations, EXTENSION_STATES.length * CAPTURE_STATES.length * RUNTIME_STATES.length);
  // 三条同时不正常时，三句话都要在，一句都不能被另一句盖掉。
  const all = headerStatusIndicator({ extensionStatus: extensionConnectionStatus({}), captureControl: BUSY_CONTROL, runtimeArchitecture: null });
  assert.deepEqual(all.issues.map(issue => issue.source), ['extension', 'runtime', 'capture']);
});

test('顶栏真正画出来的东西：正常时一句，不正常时逐条展开', async () => {
  const entry = fileURLToPath(new URL('./header-status-entry.jsx', import.meta.url));
  const component = fileURLToPath(new URL('../src/components/HeaderStatus.jsx', import.meta.url));
  const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'header-status-test',
    resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
    import HeaderStatus from ${JSON.stringify(component)};
    export const render=props=>renderToStaticMarkup(<HeaderStatus {...props}/>);` : null }],
    ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
  const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
  assert.ok(chunk);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

  const calm = render({ extensionStatus: CONNECTED, captureControl: IDLE_CONTROL, runtimeArchitecture: LOCAL_RUNTIME });
  assert.match(calm, /class="header-status ok"/u);
  assert.match(calm, /一切正常/u);
  // 平时不再把三条工程状态摊在主人面前，但它们仍然在 title 里。
  assert.doesNotMatch(calm, />本地开发模式</u);
  assert.doesNotMatch(calm, />插件已连接/u);
  assert.match(calm, /title="[^"]*本地开发模式/u);

  const broken = render({ extensionStatus: extensionConnectionStatus({}), captureControl: BUSY_CONTROL, runtimeArchitecture: null });
  assert.match(broken, /class="header-status error"/u);
  assert.match(broken, /插件没连上，现在没法采集1688页面/u);
  assert.match(broken, /运行方式没读出来/u);
  assert.match(broken, /candidate:synthetic 正在采集/u);
  assert.doesNotMatch(broken, /一切正常/u);
});

test('顶栏只剩：我在哪儿、哪家店、有没有异常', async () => {
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const header = app.slice(app.indexOf('<header className="app-header">'), app.indexOf('</header>'));
  // 留下的：品牌与位置、四个入口加数字、店铺选择、一个状态指示器。
  assert.match(header, /className="desk-nav"/u);
  assert.match(header, /className="desk-store-switch"/u);
  assert.match(header, /className="app-brand-back" onClick=\{\(\) => setView\("desk"\)\}>← 选品台/u);
  assert.match(header, /<HeaderStatus extensionStatus=\{effectiveExtensionStatus\} captureControl=\{state\.captureControl\}/u);
  assert.match(header, /runtimeArchitecture=\{state\.runtimeArchitecture\}/u);
  // 收走的：三条状态各自的横条、找一轮新品、刷新数据、添加我找到的商品。
  for (const gone of [/找一轮新品/u, /刷新数据/u, /添加我找到的商品/u, /extension-status/u, /capture-control-status/u,
    /runtime-architecture-status/u, /RuntimeArchitectureStatus/u]) {
    assert.doesNotMatch(header, gone, `顶栏不该再有：${gone}`);
  }
  // 顶栏那个「找一轮新品」进的是旧的商品发现工程页；整个应用里现在只有「维护」还能进得去。
  assert.equal((app.match(/setView\("discovery"\)/gu) ?? []).length, 0);
  assert.match(app, /\{ view: "discovery", label: "软件找商品" \}/u);
  assert.equal((app.match(/view: "discovery"/gu) ?? []).length, 1);
});

test('刷新数据和退出登录收进「维护」，添加我找到的商品搬到选品台', async () => {
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const desk = await readFile(fileURLToPath(new URL('../src/components/SelectionDesk.jsx', import.meta.url)), 'utf8');
  const maintenance = app.slice(app.indexOf('<h2>维护</h2>'), app.indexOf('<h2>维护</h2>') + 1400);
  assert.match(maintenance, /刷新数据/u);
  assert.match(maintenance, /setPollEpoch\(epoch => epoch \+ 1\)/u);
  // 轮询本身一个字没改：还是三秒一次，读失败仍然停下来。
  assert.match(app, /timer = window\.setTimeout\(poll, 3000\)/u);
  // 读失败时那句话必须说清楚「刷新数据」现在在哪儿。
  assert.match(app, /轮询已暂停；到「维护」里点“刷新数据”恢复/u);
  // 已登录时那一条不再常驻顶部；未登录、读不出来、预览身份仍然显眼（组件内只对 authenticated 这一种做了收起）。
  assert.match(app, /<LocalOwnerAccessPanel showAuthenticated=\{view === "maint"\}/u);
  const panel = await readFile(fileURLToPath(new URL('../src/components/LocalOwnerAccessPanel.jsx', import.meta.url)), 'utf8');
  assert.match(panel, /access\.status === "authenticated"\) return showAuthenticated \?/u);
  assert.equal((panel.match(/showAuthenticated \?/gu) ?? []).length, 1);
  // 添加我找到的商品：顶栏不再有，选品台自己有一个，打开的还是原来那个弹窗。
  assert.match(app, /onAddProduct=\{\(\) => setAddOpen\(true\)\}/u);
  assert.match(app, /<AddCandidateModal open=\{addOpen\}/u);
  assert.match(desk, /onClick=\{onAddProduct\}>\s*<PlusIcon \/> 添加我找到的商品/u);
  // 空列表那句话原来指着顶栏的按钮，顶栏那个已经没了。
  assert.doesNotMatch(desk, /点右上角「找一轮新品」/u);
  assert.match(desk, /点右边「下一轮方向」里的「找一轮新品」/u);
});
