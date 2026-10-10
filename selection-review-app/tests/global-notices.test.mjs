import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCOVERY_FAILURE_LABELS, INTAKE_BLOCKER_LABELS, UNSOURCED_BLOCKER_CODES, discoveryFailureLabel,
  failedRunTodos, globalNotices, sourceLinkCheck } from '../lib/global-notices.mjs';

// Synthetic display records only: nothing here reads saved data, a service or a platform.
const candidate = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: 'miska', dataRevision: 3,
  workflowStatus: 'codex_processing', ...extra });
const blocked = (id, code, retryable, extra = {}) => candidate(id, { intake: { sourceKind: 'pinduoduo',
  sourceUrl: `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`, stage: 'blocked',
  blocker: { code, message: null, retryable }, queue: null }, ...extra });
const round = (batchId, createdAt, jobs, extra = {}) => ({ batch: { batchId, revision: 1, targetStore: 'miska', createdAt,
  plan: { provider: 'seerfar', direction: '合成方向', planId: 'plan:synthetic' }, ...extra }, jobs });
const job = (status, failureClass = null, completedAt = '2026-10-10T03:00:00.000Z') => ({
  job: { status, completedAt, scopeBinding: { request: { method: 'category_detail' } } },
  receipt: { completedAt, failureClass, steps: [] } });

test('every intake blocker code from the shared contract has an owner sentence', () => {
  for (const code of ['slider_required', 'login_pinduoduo_required', 'login_1688_required', 'plugin_offline',
    'share_link_unresolved', 'source_out_of_stock', 'source_delisted', 'presale_too_late', 'no_source_price',
    'source_image_missing', 'unknown_outcome', 'source_unreadable', 'step_not_started']) {
    assert.ok(INTAKE_BLOCKER_LABELS[code], code);
  }
  assert.deepEqual([...UNSOURCED_BLOCKER_CODES].sort(), ['no_source_price', 'source_delisted', 'source_out_of_stock']);
});

test('nothing wrong means no notice at all', () => {
  assert.deepEqual(globalNotices({ extensionStatus: { code: 'connected' }, queueExtension: { online: true, login1688: 'ok' },
    candidates: [candidate('a')], discoveryView: { batches: [] }, store: 'miska' }), []);
});

test('plugin offline is said once for the page, with how many products wait', () => {
  const notices = globalNotices({ extensionStatus: { code: 'disconnected' }, queueExtension: null,
    candidates: [blocked('a', 'plugin_offline', true), blocked('b', 'plugin_offline', true), candidate('c')], store: 'miska' });
  assert.deepEqual(notices.map(notice => notice.key), ['plugin_offline']);
  assert.match(notices[0].detail, /2 件在等/u);
  assert.match(notices[0].detail, /点「接着找」才会再跑/u, 'the notice never promises an automatic rerun');
});

test('the live answer of this tab wins over a stale server flag', () => {
  const notices = globalNotices({ extensionStatus: { code: 'connected' }, queueExtension: { online: false, login1688: 'ok' } });
  assert.deepEqual(notices, []);
  assert.deepEqual(globalNotices({ extensionStatus: { code: 'page_refresh_required' }, queueExtension: { online: false } })
    .map(notice => notice.key), ['plugin_offline']);
});

test('1688 login expired comes from the queue flag or from a saved blocker, and only once', () => {
  const fromFlag = globalNotices({ extensionStatus: { code: 'connected' }, queueExtension: { online: true, login1688: 'expired' } });
  assert.deepEqual(fromFlag.map(notice => notice.key), ['login_1688_expired']);
  assert.equal(fromFlag[0].link.href, 'https://login.1688.com/');
  const fromBlockers = globalNotices({ extensionStatus: { code: 'connected' }, candidates: [
    blocked('a', 'login_1688_required', true), blocked('b', 'login_1688_required', true)], store: 'miska' });
  assert.deepEqual(fromBlockers.map(notice => notice.key), ['login_1688_expired']);
  assert.match(fromBlockers[0].detail, /2 件/u);
  // A login the queue reports as unknown is not expired.
  assert.deepEqual(globalNotices({ extensionStatus: { code: 'connected' }, queueExtension: { online: true, login1688: 'unknown' } }), []);
});

test('blockers of another store or of a dropped product raise nothing here', () => {
  const notices = globalNotices({ extensionStatus: { code: 'connected' }, store: 'miska', candidates: [
    blocked('a', 'slider_required', true, { targetStore: 'dandanshu' }),
    blocked('b', 'slider_required', true, { workflowStatus: 'eliminated' })] });
  assert.deepEqual(notices, []);
});

test('Seerfar login expired or changed is read from the newest finished Seerfar job only', () => {
  const view = failure => ({ batches: [
    round('old', '2026-10-09T01:00:00.000Z', [job('failed', failure, '2026-10-09T01:05:00.000Z')]),
    round('new', '2026-10-10T01:00:00.000Z', [job('failed', failure, '2026-10-10T01:05:00.000Z')])] });
  assert.deepEqual(globalNotices({ extensionStatus: { code: 'connected' }, discoveryView: view('AUTHENTICATION_REQUIRED') })
    .map(notice => notice.key), ['seerfar_login_expired']);
  assert.deepEqual(globalNotices({ extensionStatus: { code: 'connected' }, discoveryView: view('RESPONSE_INVALID') })
    .map(notice => notice.key), ['seerfar_page_changed']);
  // A later round that finished clears an older failure.
  const recovered = { batches: [round('old', '2026-10-09T01:00:00.000Z', [job('failed', 'AUTHENTICATION_REQUIRED', '2026-10-09T01:05:00.000Z')]),
    round('new', '2026-10-10T01:00:00.000Z', [job('completed', null, '2026-10-10T01:05:00.000Z')])] };
  assert.deepEqual(globalNotices({ extensionStatus: { code: 'connected' }, discoveryView: recovered }), []);
});

test('a stopped round of this store becomes one to-do with its reason; a replaced one does not', () => {
  const todos = failedRunTodos({ store: 'miska', discoveryView: { batches: [
    round('newest', '2026-10-10T02:00:00.000Z', [job('failed', 'TIMEOUT')]),
    round('older', '2026-10-09T02:00:00.000Z', [job('failed', 'NETWORK_FAILED')])] } });
  assert.equal(todos.length, 1);
  assert.equal(todos[0].kind, 'discovery');
  assert.equal(todos[0].reason, DISCOVERY_FAILURE_LABELS.TIMEOUT.reason);
  assert.equal(todos[0].canRerun, true);
  assert.deepEqual(failedRunTodos({ store: 'miska', discoveryView: { batches: [
    round('newest', '2026-10-10T02:00:00.000Z', [job('completed')]),
    round('older', '2026-10-09T02:00:00.000Z', [job('failed', 'TIMEOUT')])] } }), []);
});

test('an unknown outcome is a to-do without 重跑, and a configuration failure needs maintenance first', () => {
  const unknown = failedRunTodos({ store: 'miska', discoveryView: { batches: [round('r', '2026-10-10T02:00:00.000Z', [job('unknown_outcome')])] } });
  assert.equal(unknown[0].canRerun, false);
  assert.match(unknown[0].hint, /不能直接重跑/u);
  const config = failedRunTodos({ store: 'miska', discoveryView: { batches: [round('r', '2026-10-10T02:00:00.000Z', [job('failed', 'CREDENTIAL_MISSING')])] } });
  assert.equal(config[0].canRerun, false);
  const changed = failedRunTodos({ store: 'miska', discoveryView: { batches: [round('r', '2026-10-10T02:00:00.000Z', [job('failed', 'RESPONSE_INVALID')])] } });
  assert.equal(changed[0].canRerun, false, 'rerunning against a changed response would fail the same way');
});

test('page-wide stops are one 接着找 to-do; an item that stopped on its own is a 重跑 to-do; the rest are neither', () => {
  const page = (id, code, extra) => blocked(id, code, true, { ...extra, intake: { ...blocked(id, code, true).intake,
    blocker: { code, message: '插件没领这一步（Chrome 关着或插件没开），打开后点「接着找」', retryable: true, scope: 'page', step: 'capture_source' } } });
  const item = (id, code) => blocked(id, code, true, { intake: { ...blocked(id, code, true).intake,
    blocker: { code, message: null, retryable: true, scope: 'item', step: 'capture_source' } } });
  const todos = failedRunTodos({ store: 'miska', candidates: [
    page('a', 'plugin_offline'), page('b', 'plugin_offline', { dataRevision: 8 }), blocked('c', 'source_delisted', false),
    item('d', 'source_unreadable'), item('e', 'unknown_outcome')] });
  assert.deepEqual(todos.map(todo => todo.key), ['intake:resume', 'intake:source_unreadable', 'intake:unknown_outcome']);
  assert.equal(todos[0].kind, 'intake_resume');
  assert.equal(todos[0].actionLabel, '接着找');
  assert.equal(todos[0].title, '2 件商品没跑完');
  assert.deepEqual(todos[0].items.map(entry => [entry.candidateId, entry.dataRevision]), [['a', 3], ['b', 8]]);
  assert.match(todos[0].hint, /不会自动接着跑/u);
  assert.equal(todos[1].actionLabel, '重跑');
  assert.match(todos[2].hint, /就算你知道了/u, 'rerunning an unknown read says it counts as the owner knowing');
});

test('products whose 1688 search was skipped for login join 接着找 only once 1688 is logged in again', () => {
  const skipped = candidate('s', { intake: { sourceKind: 'pinduoduo', stage: 'ready', blocker: null, skips: { supplierMatch: 'login_1688_required' } } });
  assert.deepEqual(failedRunTodos({ store: 'miska', candidates: [skipped], queueExtension: { login1688: 'expired' } }), []);
  assert.deepEqual(failedRunTodos({ store: 'miska', candidates: [skipped], queueExtension: { login1688: 'unknown' } }), []);
  const todos = failedRunTodos({ store: 'miska', candidates: [skipped], queueExtension: { login1688: 'ok' } });
  assert.equal(todos.length, 1);
  assert.match(todos[0].reason, /1 件因为 1688 没登录跳过了 1688 找同款/u);
});

test('an unlisted failure class still reads as a sentence and offers no rerun', () => {
  const label = discoveryFailureLabel('SOMETHING_NEW');
  assert.equal(label.rerun, false);
  assert.match(label.reason, /SOMETHING_NEW/u);
  assert.equal(discoveryFailureLabel(null).reason, '没有记录停止原因');
});

test('only 1688 and 拼多多 links are accepted as a source', () => {
  assert.deepEqual(sourceLinkCheck('https://detail.1688.com/offer/123.html'),
    { ok: true, link: 'https://detail.1688.com/offer/123.html', sourceKind: '1688' });
  assert.equal(sourceLinkCheck(' https://mobile.yangkeduo.com/goods.html?goods_id=1 ').sourceKind, 'pinduoduo');
  assert.equal(sourceLinkCheck('https://www.ozon.ru/product/1').ok, false);
  assert.equal(sourceLinkCheck('https://evil1688.com/offer/1').ok, false, 'a look-alike host is not 1688');
  assert.equal(sourceLinkCheck('detail.1688.com/offer/1').ok, false);
  assert.equal(sourceLinkCheck('javascript:alert(1)').ok, false);
  assert.equal(sourceLinkCheck('').ok, false);
});
