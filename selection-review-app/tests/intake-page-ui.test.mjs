import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import {
  FALLBACK_STORES,
  intakeExtensionIssues,
  intakePauseView,
  intakePreviewLine,
  intakeQueueGroups,
  intakeQueueHasActive,
  intakeQueueRows,
  intakeSubmitResults,
  linkSourceKind,
  parseIntakeLinks,
  platformOfStore,
  roughProfitLine,
  storeOptions,
  storesOfPlatform
} from '../src/intakeView.js';
import { headerStatusIndicator } from '../src/headerStatusView.js';

// 录入页只渲染合成的显示数据：没有保存记录、没有服务、没有请求。
let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./intake-page-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/IntakePage.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'intake-page-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Page from ${JSON.stringify(component)};export const render=props=>renderToStaticMarkup(<Page {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const props = (intake, extra = {}) => ({ ownerReady: true, storeLine: 'Ozon · Miska', intake, candidates: [],
  onSubmitLinks: forbidden, onRetry: forbidden, onResume: forbidden, onOpenCandidate: forbidden, onOpenSeerfar: forbidden,
  onOpenBoard: forbidden, onOpenMaintenance: forbidden, ...extra });
const queueItem = (candidateId, stage, extra = {}) => ({ candidateId, title: `合成商品 ${candidateId}`,
  sourceKind: 'pinduoduo', stage, blocker: null, queue: null, ...extra });
const candidate = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, dataRevision: 7, ...extra });

test('认链接：拼多多和 1688 混着贴，分享文案里也能取出链接，重复的只交一次，认不出的不交', () => {
  assert.equal(linkSourceKind('https://mobile.yangkeduo.com/goods.html?goods_id=1'), 'pinduoduo');
  assert.equal(linkSourceKind('https://detail.1688.com/offer/123.html'), '1688');
  assert.equal(linkSourceKind('https://qr.1688.com/s/synthetic'), '1688');
  assert.equal(linkSourceKind('https://evil-1688.com/offer/1.html'), null);
  assert.equal(linkSourceKind('https://www.ozon.ru/product/1'), null);
  assert.equal(linkSourceKind('不是链接'), null);
  const parsed = parseIntakeLinks([
    '【拼多多】合成分享文案 https://mobile.yangkeduo.com/goods.html?goods_id=1 快来看',
    '',
    'https://detail.1688.com/offer/123.html',
    'https://detail.1688.com/offer/123.html',
    'https://www.ozon.ru/product/1',
    '随手写的一行'
  ].join('\n'));
  assert.deepEqual(parsed.links.map(link => link.url), [
    'https://mobile.yangkeduo.com/goods.html?goods_id=1', 'https://detail.1688.com/offer/123.html']);
  assert.deepEqual(parsed.counts, { pinduoduo: 1, '1688': 1 });
  assert.equal(parsed.unrecognized.length, 2);
  assert.equal(intakePreviewLine(parsed), '认出 2 条：拼多多 1、1688 1；2 行不是拼多多或 1688 链接，不会提交');
  assert.equal(intakePreviewLine(parseIntakeLinks('   \n')), '');
  const many = parseIntakeLinks(Array.from({ length: 21 }, (_, index) => `https://detail.1688.com/offer/${index}.html`).join('\n'));
  assert.match(intakePreviewLine(many), /一次最多 20 条，请分开贴/u);
});

test('提交回执：新建、重复（给出原来那件）、认不出的结果各说一句', () => {
  const results = intakeSubmitResults({ items: [
    { candidateId: 'candidate:new', created: true, duplicateOfCandidateId: null, sourceKind: 'pinduoduo' },
    { candidateId: 'candidate:old', created: false, duplicateOfCandidateId: 'candidate:old', sourceKind: '1688' },
    { created: 'maybe' }
  ] }, [{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c' }]);
  assert.deepEqual(results.map(result => result.kind), ['created', 'duplicate', 'unknown']);
  assert.equal(results[0].sentence, '拼多多 已加入找货队列');
  assert.equal(results[1].candidateId, 'candidate:old');
  assert.match(results[1].sentence, /以前录过，没有重复新建/u);
  assert.match(results[2].sentence, /不要重复提交/u);
  const withRejected = intakeSubmitResults({ items: [
    { candidateId: 'candidate:gone', created: false, duplicateOfCandidateId: 'candidate:gone', duplicateEliminated: true, sourceKind: '1688' }
  ], rejected: [{ raw: '随手写的', code: 'link_unrecognized' }] });
  assert.match(withRejected[0].sentence, /已经淘汰了/u);
  assert.equal(withRejected[1].sentence, '没认出来，没有提交：随手写的');
  assert.deepEqual(intakeSubmitResults(null), []);
});

test('队列：阶段、卡点、第几条、粗算，重跑只给只拦这一件、能重跑、有当前版本的', () => {
  const pageBlocker = { code: 'login_1688_required', message: '1688 登录过期了，在 Chrome 里重新登录一次再点「接着找」', retryable: true, scope: 'page', step: 'read_source' };
  const queue = { items: [
    queueItem('candidate:q', 'queued', { queue: { position: 2, total: 5 }, batch: { position: 3, total: 8 }, dataRevision: 1 }),
    queueItem('candidate:s', 'searching_1688', { batch: { position: 1, total: 1 }, imageUrl: 'https://img.example/synthetic.jpg' }),
    queueItem('candidate:r', 'ready', { sourceKind: '1688', dataRevision: 4,
      roughProfit: { status: 'ok', profitPerUnitRmb: 23.456, passes: true, assumed: true, missing: [] } }),
    queueItem('candidate:b', 'blocked', { dataRevision: 6,
      blocker: { code: 'source_unreadable', message: '这次没读成货源页，点「重跑」再读一次', retryable: true, scope: 'item' } }),
    queueItem('candidate:d', 'blocked', { dataRevision: 6,
      blocker: { code: 'source_delisted', message: '合成：下架', retryable: false, scope: 'item' } }),
    queueItem('candidate:p', 'blocked', { dataRevision: 6, blocker: pageBlocker }),
    queueItem('candidate:nr', 'blocked', { blocker: { code: 'step_not_started', message: '', retryable: true, scope: 'item' } }),
    queueItem('candidate:x', 'mystery', { imageUrl: 'http://insecure.example/a.jpg' })
  ], pause: { code: 'login_1688_required', message: pageBlocker.message, candidateId: 'candidate:p' },
  extension: { online: true, versionOk: true, login1688: 'expired' } };
  const rows = intakeQueueRows(queue, [candidate('candidate:s'),
    candidate('candidate:nr', { dataRevision: undefined, roughProfit: { status: 'incomplete', missing: ['Ozon 售价'] } })]);
  const byId = Object.fromEntries(rows.map(row => [row.candidateId, row]));
  assert.equal(byId['candidate:q'].positionLine, '第 3 / 8 条 · 排第 2 / 5');
  assert.equal(byId['candidate:q'].stageLabel, '排队中');
  assert.equal(byId['candidate:s'].positionLine, null, '只贴了一条时不说第 1 / 1 条');
  assert.equal(byId['candidate:s'].imageUrl, 'https://img.example/synthetic.jpg');
  assert.equal(byId['candidate:s'].dataRevision, 7, '队列回执没给版本时看候选商品上保存的');
  assert.equal(byId['candidate:x'].imageUrl, null, '只显示 https 图片');
  assert.equal(byId['candidate:r'].sourceLabel, '1688');
  assert.deepEqual(byId['candidate:r'].roughProfit, { tone: 'ok', label: '粗算 约 ¥23.46/件' });
  assert.equal(byId['candidate:b'].blockerLine, '这次没读成货源页，点「重跑」再读一次', '后台的话优先');
  assert.equal(byId['candidate:b'].canRetry, true);
  assert.equal(byId['candidate:b'].dataRevision, 6);
  assert.equal(byId['candidate:d'].canRetry, false, '后台说不能重跑就不给按钮');
  assert.equal(byId['candidate:p'].canRetry, false, '整页那类事用「接着找」，不给单件重跑');
  assert.equal(byId['candidate:p'].pageBlocked, true);
  assert.equal(byId['candidate:nr'].canRetry, false, '没有当前 dataRevision 就不给按钮');
  assert.match(byId['candidate:nr'].blockerLine, /这一步没能开始/u, '后台没给话时用兜底');
  assert.deepEqual(byId['candidate:nr'].roughProfit, { tone: 'muted', label: '粗算 还缺：Ozon 售价' });
  assert.equal(byId['candidate:x'].stageLabel, '状态没认出来');
  const groups = intakeQueueGroups(rows);
  assert.deepEqual(groups.ready.map(row => row.candidateId), ['candidate:r']);
  assert.deepEqual(groups.running.map(row => row.candidateId), ['candidate:q', 'candidate:s']);
  assert.deepEqual(groups.blocked.map(row => row.candidateId), ['candidate:b', 'candidate:d', 'candidate:p', 'candidate:nr']);
  assert.deepEqual(groups.unknown.map(row => row.candidateId), ['candidate:x']);
  assert.deepEqual(intakePauseView(queue), { code: 'login_1688_required',
    message: '1688 登录过期了，在 Chrome 里重新登录一次再点「接着找」', candidateId: 'candidate:p' });
  assert.equal(intakePauseView({ items: [], pause: null }), null);
  assert.equal(intakeQueueHasActive(queue), true);
  assert.equal(intakeQueueHasActive({ items: [queueItem('candidate:r', 'ready')] }), false);
  assert.equal(intakeQueueHasActive(null), false);
});

test('粗算永远是估算：过线说约多少，亏说不过线，缺资料说缺什么', () => {
  assert.equal(roughProfitLine(null), null);
  assert.deepEqual(roughProfitLine({ status: 'negative', profitPerUnitRmb: -3 }), { tone: 'warning', label: '粗算 约 ¥-3.00/件，不过线' });
  assert.deepEqual(roughProfitLine({ status: 'ok', profitPerUnitRmb: 8, passes: false }), { tone: 'warning', label: '粗算 约 ¥8.00/件，不过线' });
  assert.deepEqual(roughProfitLine({ status: 'incomplete', profitPerUnitRmb: null, missing: ['重量', '货价'] }),
    { tone: 'muted', label: '粗算 还缺：重量、货价' });
  assert.equal(roughProfitLine({ status: 'ok', profitPerUnitRmb: null }), null);
});

test('平台和店铺：接口没上线时用写死的两家 Ozon 店，上线后按接口给的来', () => {
  const fallback = storeOptions(null);
  assert.equal(fallback.fallback, true);
  assert.deepEqual(fallback.platforms, [{ value: 'ozon', label: 'Ozon' }]);
  assert.deepEqual(storesOfPlatform(fallback, 'ozon').map(store => store.label), ['Miska', '蛋蛋鼠']);
  assert.deepEqual(FALLBACK_STORES.map(store => store.storeKey), ['miska', 'dandanshu']);
  assert.equal(platformOfStore(fallback, 'dandanshu'), 'ozon');
  const live = storeOptions({ stores: [
    { platform: 'ozon', storeKey: 'miska', label: 'Miska' },
    { platform: 'WB', storeId: 'wb-main', displayName: '合成 WB 店' },
    { platform: '', storeKey: 'broken', label: '缺平台' }
  ] });
  assert.equal(live.fallback, false);
  assert.deepEqual(live.platforms, [{ value: 'ozon', label: 'Ozon' }, { value: 'wb', label: 'WB' }]);
  assert.deepEqual(storesOfPlatform(live, 'wb'), [{ platform: 'wb', storeKey: 'wb-main', label: '合成 WB 店' }]);
  // lib/store-registry.mjs listStores 的真实形状：平台名从回执里取，没确认的显示名标出来。
  const registry = storeOptions({ registryVersion: 'stores-v1',
    platforms: [{ platform: 'ozon', label: 'Ozon', storeIds: ['dandanshu', 'miska'] }, { platform: 'wb', label: 'WB', storeIds: ['wb'] }],
    stores: [
      { storeId: 'dandanshu', platform: 'ozon', label: '蛋蛋鼠', labelConfirmed: true, identityConfigured: true },
      { storeId: 'miska', platform: 'ozon', label: 'Miska', labelConfirmed: true, identityConfigured: true },
      { storeId: 'wb', platform: 'wb', label: 'WB', labelConfirmed: false, identityConfigured: false }
    ] });
  assert.deepEqual(registry.platforms, [{ value: 'ozon', label: 'Ozon' }, { value: 'wb', label: 'WB' }]);
  assert.deepEqual(storesOfPlatform(registry, 'ozon').map(store => store.storeKey), ['dandanshu', 'miska']);
  assert.deepEqual(storesOfPlatform(registry, 'wb').map(store => store.label), ['WB（名字待定）']);
  assert.equal(platformOfStore(registry, 'wb'), 'wb');
});

test('顶栏状态把录入队列回报的插件离线和 1688 登录过期说出来', () => {
  assert.deepEqual(intakeExtensionIssues(null), []);
  assert.deepEqual(intakeExtensionIssues({ extension: { online: true, login1688: true } }), []);
  assert.deepEqual(intakeExtensionIssues({ extension: { online: true, versionOk: true, login1688: 'ok' } }), []);
  assert.deepEqual(intakeExtensionIssues({ extension: { online: true, versionOk: true, login1688: 'unknown' } }), []);
  assert.deepEqual(intakeExtensionIssues({ extension: { online: true, login1688: 'expired' } }).map(issue => issue.code), ['login_1688_required']);
  assert.deepEqual(intakeExtensionIssues({ extension: { online: true, versionOk: false, login1688: 'ok' } }).map(issue => issue.code), ['plugin_version']);
  assert.deepEqual(intakeExtensionIssues({ extension: { online: false, login1688: false } }).map(issue => issue.code), ['plugin_offline']);
  const connected = { code: 'connected', label: '插件已连接' };
  const calm = { status: 'idle', label: '空闲' };
  const runtime = { mode: 'local_development' };
  const expired = headerStatusIndicator({ extensionStatus: connected, captureControl: calm, runtimeArchitecture: runtime,
    intakeQueue: { items: [], extension: { online: true, versionOk: true, login1688: 'expired' } } });
  assert.ok(expired.issues.some(issue => issue.sentence === '1688 登录过期，要用 1688 的商品先排着'));
  // 插件那条已经说没连上时，录入队列的「插件没连上」不再重复一遍。
  const down = headerStatusIndicator({ extensionStatus: { code: 'disconnected' }, captureControl: calm, runtimeArchitecture: runtime,
    intakeQueue: { items: [], extension: { online: false, login1688: null } } });
  assert.equal(down.issues.filter(issue => /插件没连上/u.test(issue.sentence)).length, 1);
});

test('录入页：先要求登录；贴链接框、默认店铺、Seerfar 入口、找货队列和重复跳转都在', async () => {
  assert.match(await render(props(null, { ownerReady: false })), /请先登录主人身份后录入商品/u);
  const loading = await render(props({ queue: null, error: null, unavailable: false, refresh: forbidden }));
  assert.match(loading, /贴拼多多或 1688 链接，软件去找同款/u);
  assert.match(loading, /<textarea/u);
  assert.match(loading, /Ozon · Miska/u);
  assert.match(loading, /开始找同款/u);
  assert.match(loading, /看今天的 Seerfar 结果/u);
  assert.match(loading, /正在读取找货队列/u);
  assert.match(loading, /进行中的商品/u);
  assert.doesNotMatch(loading, /添加我找到的商品/u);
  // 没贴链接时按钮不能点，什么也提交不了。
  assert.match(loading, /<button type="submit" class="button primary intake-submit" disabled="">/u);

  const queue = { items: [
    queueItem('candidate:q', 'queued', { batch: { position: 3, total: 8 } }),
    queueItem('candidate:r', 'ready'),
    queueItem('candidate:b', 'blocked', { blocker: { code: 'source_unreadable', message: '这次没读成货源页，点「重跑」再读一次', retryable: true, scope: 'item' } })
  ], pause: { code: 'slider_required', message: '要你在自己的 Chrome 里拖一下滑块，过了再点「接着找」（拼多多）', candidateId: 'candidate:q' },
  extension: { online: true, versionOk: true, login1688: 'ok' } };
  const html = await render(props({ queue, error: null, unavailable: false, refresh: forbidden },
    { candidates: [candidate('candidate:b'), candidate('candidate:r', { roughProfit: { status: 'ok', profitPerUnitRmb: 12 } })] }));
  assert.match(html, /找货中（3）/u);
  assert.match(html, /找完了，等你确认（1）/u);
  assert.match(html, /停下来了（1）/u);
  assert.match(html, /还在找（1）/u);
  assert.match(html, /排队中 · 第 3 \/ 8 条/u);
  assert.match(html, /这次没读成货源页，点「重跑」再读一次/u);
  assert.match(html, /找货先停下来了/u);
  assert.match(html, /拖一下滑块，过了再点「接着找」（拼多多）。排着的什么都不会丢。/u);
  assert.match(html, />接着找</u);
  assert.match(html, />重跑</u);
  assert.match(html, />去确认</u);
  assert.match(html, /粗算 约 ¥12\.00\/件/u);
});

test('录入后台没上线、读失败时说清楚，不假装有队列', async () => {
  const unavailable = await render(props({ queue: null, error: 'HTTP 404', unavailable: true, refresh: forbidden }));
  assert.match(unavailable, /录入后台还没上线，链接暂时提交不了/u);
  assert.match(unavailable, /<button type="submit" class="button primary intake-submit" disabled="">/u);
  const failed = await render(props({ queue: null, error: '合成失败', unavailable: false, refresh: forbidden }));
  assert.match(failed, /读取找货队列失败：合成失败/u);
  assert.match(failed, /再读一次/u);
  const empty = await render(props({ queue: { items: [] }, error: null, unavailable: false, refresh: forbidden }));
  assert.match(empty, /队列是空的/u);
});

test('首页接线：录入页是首页，Seerfar 结果页另开一页，接口按 piece A 的合同调用', async () => {
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const api = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(app, /const \[view, setView\] = useState\("desk"\)/u);
  assert.match(app, /view === "desk" \? \(\s*<IntakePage /u);
  assert.match(app, /view === "seerfar" \? \(\s*<SelectionDesk/u);
  assert.match(app, /onOpenSeerfar=\{\(\) => setView\("seerfar"\)\}/u);
  assert.match(app, /useIntakeQueue\(\{ enabled: view === "desk" && accountOwner, loadQueue: loadIntakeQueue \}\)/u);
  assert.match(app, /const loadIntakeQueue = \(\) => api\.getIntakeQueue\(\);/u);
  assert.match(app, /onRetry=\{api\.retryIntake\} onResume=\{api\.resumeIntake\}/u);
  assert.match(app, /targetStore=\{deskPlatform === "ozon" \? deskStore : null\}/u);
  // piece A 的接口：贴链接可以带默认店铺，重跑带 dataRevision。
  assert.match(api, /submitIntakeLinks: \(links, targetStore\) => request\("\/api\/intake\/links"/u);
  assert.match(api, /JSON\.stringify\(targetStore \? \{ links, targetStore \} : \{ links \}\)/u);
  assert.match(api, /retryIntake: \(candidateId, dataRevision\) =>/u);
  assert.match(api, /resumeIntake: \(\) => request\("\/api\/intake\/resume"/u);
  assert.match(api, /getStores: signal => request\('\/api\/stores', \{ signal \}\)/u);
  // 页面从不自动重跑：重跑只在主人点按钮时发出。
  const page = await readFile(fileURLToPath(new URL('../src/components/IntakePage.jsx', import.meta.url)), 'utf8');
  assert.equal((page.match(/onRetry\(/gu) ?? []).length, 2, '一处是按钮，一处是提交');
  assert.equal((page.match(/onResume\(/gu) ?? []).length, 1, '「接着找」只在主人点时发出');
  assert.match(page, /onClick=\{\(\) => onRetry\(row\)\}/u);
});

const syntheticProfile = (store, extra = {}) => ({ targetStore: store, version: `${store}-synthetic-1`, source: 'config',
  editedBy: null, editedAt: null, positioning: '合成定位', categoryPaths: ['合成类目 > 子类'], excludedCategoryPaths: ['合成排除'],
  priceRub: { min: 800, max: 5000 }, maxWeightGrams: 2000, presaleMaxDays: 14, history: [],
  skipReasons: { total: 0, counts: {}, recent: [] }, ...extra });

test('店铺档案卡：两家 Ozon 店按顺序，价格带、重量、预售天数说成人话', async () => {
  const { storeProfileCards } = await import('../src/storeProfileCardView.js');
  const cards = storeProfileCards({ profiles: {
    dandanshu: syntheticProfile('dandanshu', { priceRub: null, maxWeightGrams: 500, source: 'owner_edit', skipReasons: { total: 2 } }),
    miska: syntheticProfile('miska')
  } });
  assert.deepEqual(cards.map(card => card.store), ['miska', 'dandanshu']);
  assert.equal(cards[0].title, 'Ozon · Miska 的店铺档案');
  assert.equal(cards[0].priceLine, '800 到 5000 ₽');
  assert.equal(cards[0].weightLine, '2 kg 以内');
  assert.equal(cards[0].presaleLine, '14 天，晚于这个就提醒你');
  assert.equal(cards[0].categoriesLine, '合成类目 > 子类');
  assert.equal(cards[0].sourceLine, '默认版本');
  assert.equal(cards[1].title, 'Ozon · 蛋蛋鼠 的店铺档案');
  assert.equal(cards[1].priceLine, '不限');
  assert.equal(cards[1].weightLine, '500 g 以内');
  assert.equal(cards[1].sourceLine, '你改过的版本');
  assert.equal(cards[1].skipLine, '你点「不做」记了 2 次原因');
  assert.deepEqual(storeProfileCards(null), []);
});

test('店铺档案表单：来回转换不丢值，错的在提交前就说清楚', async () => {
  const { storeProfileForm, storeProfileValues, storeProfileSaveError } = await import('../src/storeProfileCardView.js');
  const form = storeProfileForm(syntheticProfile('miska'));
  assert.deepEqual(form, { positioning: '合成定位', categoryPaths: '合成类目 > 子类', excludedCategoryPaths: '合成排除',
    priceMin: '800', priceMax: '5000', maxWeightKg: '2', presaleMaxDays: '14' });
  assert.deepEqual(storeProfileValues(form), { errors: [], values: { positioning: '合成定位', categoryPaths: ['合成类目 > 子类'],
    excludedCategoryPaths: ['合成排除'], priceRub: { min: 800, max: 5000 }, maxWeightGrams: 2000, presaleMaxDays: 14 } });
  // 层级之间的空格不齐也按同一种写法存；价格和重量留空就是不限。
  const loose = storeProfileValues({ ...form, categoryPaths: '甲>乙\n  丙  ', priceMin: '', priceMax: '', maxWeightKg: '0.35' });
  assert.deepEqual(loose.values.categoryPaths, ['甲 > 乙', '丙']);
  assert.equal(loose.values.priceRub, null);
  assert.equal(loose.values.maxWeightGrams, 350);
  const halfOpen = storeProfileValues({ ...form, priceMin: '', priceMax: '3000' });
  assert.deepEqual(halfOpen.values.priceRub, { min: null, max: 3000 });
  const bad = storeProfileValues({ ...form, positioning: ' ', categoryPaths: '甲\n甲', excludedCategoryPaths: '甲',
    priceMin: '900', priceMax: '100', maxWeightKg: '-1', presaleMaxDays: '91' });
  assert.equal(bad.values, null);
  for (const pattern of [/店铺定位不能空着/u, /主打类目里有重复的/u, /不能既是主打又是不做/u, /价格下限不能高于上限/u,
    /重量上限要填大于 0 的数字/u, /0 到 90 的整数/u]) {
    assert.ok(bad.errors.some(error => pattern.test(error)), String(pattern));
  }
  assert.equal(storeProfileSaveError({ status: 409 }).conflict, true);
  assert.match(storeProfileSaveError({ status: 404 }).message, /还没合进来/u);
  assert.match(storeProfileSaveError({ status: 400, message: '合成' }).message, /没有保存成功：合成/u);
});

test('录入页的 Seerfar 区块带店铺档案；档案按 PR #2 的接口读写', async () => {
  const html = await render(props({ queue: { items: [] }, error: null, unavailable: false, refresh: forbidden },
    { loadStoreProfiles: forbidden, saveStoreProfile: forbidden }));
  assert.match(html, /Seerfar 自动选品/u);
  assert.match(html, /正在读取店铺档案/u);
  const api = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(api, /getStoreProfiles: signal => request\('\/api\/store-profiles', \{ signal \}\)/u);
  assert.match(api, /\/api\/store-profiles\/\$\{encodeURIComponent\(store\)\}`, \{\s*method: 'POST', body: JSON\.stringify\(\{ baseVersion, values \}\)/u);
});
