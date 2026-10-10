import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const clone = value => structuredClone(value);
function preparation(runtime = [], options = undefined) {
  return { schemaVersion: 'ozon-account-read-preparation-v1', candidateId: 'candidate:synthetic:account-ui',
    skuPackageId: 'sku:synthetic:account-ui', expectedRevision: 12, maxRequests: 3, platformWrites: 0,
    message: '核验本件商品的账户权限、公司币种和指定仓库，每项读取一次。', runtime,
    options: options ?? [{ bindingId: 'binding:synthetic:account-ui', configurationVersion: 'configuration:1', scopeRef: 'scope:synthetic:account-ui',
      storeName: '合成店铺', warehouseName: '合成仓库', warehouseId: '10001', clientId: '123456', credentialAlias: 'credential-alias:synthetic:account-ui' }] };
}
function saved(patch = {}) {
  return { jobId: 'job:synthetic:account-ui', status: 'queued', expectedRevision: 12, bindingId: 'binding:synthetic:account-ui',
    configurationVersion: 'configuration:1', createdAt: '2026-09-08T00:00:00.000Z', isCurrent: true, expired: false,
    requestsSent: 0, observedMethods: [], companyCurrency: null, failureClass: null, gaps: [], canContinue: true, ...patch };
}

let renderersPromise;
function renderers() {
  if (renderersPromise !== undefined) return renderersPromise;
  renderersPromise = (async () => {
    const entry = fileURLToPath(new URL('./ozon-account-read-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/OzonAccountReadCard.jsx', import.meta.url));
    const built = await build({ configFile: false, logLevel: 'warn', plugins: [react(), {
      name: 'ozon-account-read-ui-test', resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
        import Card from ${JSON.stringify(component)};
        export const render = props => renderToStaticMarkup(<Card {...props}/>);
        export function interaction(props) {
          let form, button;
          function collect(element) {
            if (!React.isValidElement(element)) return;
            if (element.type === 'form') form = element;
            if (element.type === 'button' && element.props.type === 'button') button = element;
            React.Children.forEach(element.props.children, collect);
          }
          function Subject() { const tree = Card(props); collect(tree); return tree; }
          const html = renderToStaticMarkup(<Subject/>);
          return {html, submit: form?.props.onSubmit, click: button?.props.onClick};
        }` : null
    }], ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const output = built.output.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(output, 'Expected an SSR entry chunk for the actual account-read card');
    return import(`data:text/javascript;base64,${Buffer.from(output.code).toString('base64')}`);
  })();
  return renderersPromise;
}

test('actual initial card never selects an account or grants permission during render', async () => {
  const {render} = await renderers(), calls = [];
  const input = preparation(), before = clone(input);
  const html = render({preparation: input, onAuthorize: value => calls.push(value), onContinue: value => calls.push(value)});
  assert.match(html, /<option value="" selected="">请选择本次范围<\/option>/);
  assert.doesNotMatch(html, /<option value="binding:synthetic:account-ui" selected/);
  assert.match(html, /本次读取许可截止时间/);
  assert.match(html, /<input[^>]*type="datetime-local"[^>]*required=""/);
  assert.match(html, /<input[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html, /我确认以上账户和仓库，允许软件在截止时间前执行本次只读核验/);
  assert.match(html, /各一次，合计最多三次；失败即停止/);
  assert.match(html, /<button(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>/);
  assert.deepEqual(calls, []); assert.deepEqual(input, before);
});

test('actual untouched form handler rejects submission without an explicit account, expiry and checkbox', async () => {
  const {interaction} = await renderers(), calls = [];
  const card = interaction({preparation: preparation(), onAuthorize: async input => calls.push(input)});
  let prevented = false;
  assert.equal(typeof card.submit, 'function');
  await assert.doesNotReject(card.submit({preventDefault() { prevented = true; }}));
  assert.equal(prevented, true); assert.deepEqual(calls, []);
});

test('continuation needs the handler and uses the exact saved job revision with duplicate-click protection', async () => {
  const {render, interaction} = await renderers(), input = preparation([saved()]);
  assert.match(render({preparation: input}), /<button[^>]*disabled=""[^>]*>继续已授权的账户核验<\/button>/);
  const enabled = render({preparation: input, onContinue: async () => { throw new Error('Rendering must not continue a job'); }});
  assert.match(enabled, /继续已授权的账户核验/); assert.doesNotMatch(enabled, /<form|type="checkbox"/);
  const calls = []; let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const card = interaction({preparation: input, onContinue: async value => { calls.push(value); await pending; }});
  const first = card.click(), duplicate = card.click();
  assert.deepEqual(calls, [{candidateId: input.candidateId, jobId: input.runtime[0].jobId, expectedRevision: 12}]);
  settle(); await Promise.all([first, duplicate]); assert.equal(calls.length, 1);
});

test('completed pre-PA evidence remains current when the saved revision is older, without offering another authorization', async () => {
  const {render} = await renderers();
  const html = render({preparation: preparation([saved({status: 'completed', expectedRevision: 11, isCurrent: true,
    requestsSent: 3, observedMethods: ['roles', 'seller_info', 'warehouse_list'], companyCurrency: 'CNY', canContinue: false})]),
    onAuthorize: async () => { throw new Error('Rendering must not authorize'); }});
  assert.match(html, /三项账户资料已保存/); assert.match(html, /方法权限、公司币种、指定仓库/);
  assert.match(html, /已读取的公司币种：CNY。/);
  assert.match(html, /账户资料已保存；能否继续生产，以生产任务的当前校验结果为准/);
  assert.doesNotMatch(html, /后台写入价格的币种仍需独立核验|原生产任务保持等待|后台连接|网页登录|上架成功/);
  assert.doesNotMatch(html, /<form|type="checkbox"|授权读取一次|继续已授权/);
});

test('unknown request counts display reconciliation rather than zero or an action to restart', async () => {
  const {render} = await renderers();
  const html = render({preparation: preparation([saved({status: 'unknown_outcome', requestsSent: 'unknown', canContinue: false})]),
    onAuthorize: async () => {}, onContinue: async () => {}});
  assert.match(html, /请求结果待核对/); assert.match(html, /已发送读取请求：待核对/);
  assert.match(html, /未自动重发/);
  assert.doesNotMatch(html, /0 次|<button|<form|重新授权/);
});

test('expired queued permission cannot continue or appear freshly authorized', async () => {
  const {render} = await renderers();
  const html = render({preparation: preparation([saved({expired: true, canContinue: false})]), onContinue: async () => {}, onAuthorize: async () => {}});
  assert.match(html, /本次读取许可已过期，不能继续发送请求/);
  assert.doesNotMatch(html, /<button|<form|继续已授权/);
});

test('historical success is never displayed as current account evidence', async () => {
  const {render} = await renderers();
  const history = saved({status: 'completed', expectedRevision: 9, isCurrent: false, canContinue: false, requestsSent: 3,
    observedMethods: ['roles', 'seller_info', 'warehouse_list'], companyCurrency: 'USD'});
  const html = render({preparation: preparation([history]), onAuthorize: async () => {}});
  assert.doesNotMatch(html, /三项账户资料已保存|公司币种：USD|已发送读取请求：3/);
  assert.match(html, /请选择本次范围/); assert.match(html, /type="checkbox"/);
  const current = render({preparation: preparation([history, saved({jobId: 'job:synthetic:current', status: 'failed', canContinue: false,
    gaps: [{code: 'account_company_missing', field: 'company', message: '本次公司资料缺失'}]})]), onAuthorize: async () => {}});
  assert.match(current, /本次账户核验已停止/); assert.match(current, /本次公司资料缺失/);
  assert.doesNotMatch(current, /三项账户资料已保存|公司币种：USD/);
});

test('missing configured account options never expose an authorization form', async () => {
  const {render} = await renderers();
  const input = preparation([], []); input.message = '尚未配置本件商品的准确账户、仓库及读取服务。';
  const html = render({preparation: input, onAuthorize: async () => {}});
  assert.match(html, /尚未配置本件商品的准确账户、仓库及读取服务/);
  assert.doesNotMatch(html, /<form|<button|type="checkbox"/);
});
