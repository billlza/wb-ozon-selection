import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// The desk renders synthetic display data only: no saved records, no services, no requests.
let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./selection-desk-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/SelectionDesk.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'selection-desk-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Desk from ${JSON.stringify(component)};export const render=props=>renderToStaticMarkup(<Desk {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}

const product = (productId, extra = {}) => ({ productId, title: `Explicitly synthetic ${productId}`,
  productUrl: `https://www.ozon.ru/product/${productId}`, imageUrl: `https://ir.ozone.ru/s3/synthetic/${productId}.jpg`,
  price: 900, salesCount: 12, revenue: 4000, reviewCount: 4, reviewRating: 4.5,
  categoryPath: { cnTitlePath: '家居 > 收纳' }, ...extra });

const estimate = (outcome, extra = {}) => ({
  status: outcome === 'selectable' ? 'ok' : outcome === 'excluded_negative' ? 'negative' : 'incomplete',
  outcome, summary: '合成估算摘要', maximumAllInPurchaseRmb: null,
  freight: { route: null, chargeableKg: null, freightRmb: null, oversize: false }, commissionRate: 0.14, ...extra });

const view = ({ products = [], importedCandidates = [], declines = [], selections = [] } = {}) => ({
  schemaVersion: 'a-discovery-view-v1', targetStores: ['miska', 'dandanshu'],
  batches: [{ batch: { batchId: 'a-discovery-batch:synthetic', revision: 0, targetStore: 'miska',
    createdAt: '2026-09-09T04:00:00.000Z', plan: { provider: 'seerfar', direction: '普通非电桌面整理小件（合成）' } },
  jobs: [{ job: { status: 'completed', scopeBinding: { request: { method: 'category_detail' } } },
    receipt: { steps: [{ method: 'category_detail', result: { products } }] } }],
  selections, importedCandidates, declines }] });

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const props = (discoveryView, extra = {}) => ({ discoveryView, candidates: [], store: 'miska',
  onSelectProduct: forbidden, onDeclineProduct: forbidden, onLaterProduct: forbidden, onEstimate: forbidden,
  onTranslate: forbidden, onOpenCandidate: forbidden, onFindNewRound: forbidden, onOpenBoard: forbidden,
  onOpenInbox: forbidden, ...extra });

test('选品台先要求登录，再显示本店方向、查询时间和一件件商品卡', async () => {
  const locked = await render(props(null, { ownerReady: false }));
  assert.match(locked, /请先登录主人身份后查看选品台/);
  assert.doesNotMatch(locked, /待你决定/);
  const loading = await render(props(null));
  assert.match(loading, /正在读取本店的查询结果/);
  const html = await render(props(view({ products: [product('2107989735', { titleZh: '合成收纳盒' })] })));
  assert.match(html, /待你决定/);
  assert.match(html, /Miska · 本轮结果：普通非电桌面整理小件（合成）/u);
  // The round's own direction and query time head the cards it returned.
  assert.match(html, /本轮结果：普通非电桌面整理小件（合成） · 查询于 2026-09-0\d/u);
  assert.match(html, /合成收纳盒/);
  assert.match(html, /Explicitly synthetic 2107989735/);
  assert.match(html, /售价 900 卢布 · 月销 12 · 评价 4 · 评分 4\.5/);
  assert.match(html, /类目：家居 &gt; 收纳/);
  assert.match(html, /<img[^>]*src="https:\/\/ir\.ozone\.ru\/s3\/synthetic\/2107989735\.jpg"[^>]*width="132"/);
  assert.match(html, /找一轮新品/);
  // 2026-10-11 工作台评审：键盘提示和运费占比公式不再挂在页面上。
  assert.doesNotMatch(html, /J 下一件|运费占比＝/u);
});

test('没算过的商品明说要先算，算过的商品显示四格利润框和标记', async () => {
  const plain = await render(props(view({ products: [product('2107989735')] })));
  assert.match(plain, /点「算利润区间」后显示/);
  assert.match(plain, /待估算/);
  const html = await render(props(view({ products: [product('2107989735', {
    estimate: estimate('selectable', { maximumAllInPurchaseRmb: 120.5,
      freight: { route: 'GUOO Economy Small', chargeableKg: 0.7, freightRmb: 37.64, oversize: true } }) })] })));
  assert.match(html, /建议采购区间/);
  assert.match(html, /到手总价 ≤ ¥120\.50/);
  assert.match(html, /刚好达到本店利润门槛/);
  assert.match(html, /GUOO Economy Small · 计费 0\.7kg · ¥37\.64 · 超抛 · 占比 24%/);
  assert.match(html, /佣金<\/b><span>14%/);
  assert.doesNotMatch(html, /点「算利润区间」后显示/);
  const gap = await render(props(view({ products: [product('2107989735', { estimate: estimate('needs_data') })] })));
  assert.match(gap, /待补尺寸/);
  assert.match(gap, /资料不全，暂不能判断/);
  assert.match(gap, /待补尺寸重量/);
});

test('预估负利润不进入待决定，只留一条折叠记录，你排除过的也一样', async () => {
  const html = await render(props(view({ products: [
    product('2107989735'),
    product('2107989736', { estimate: estimate('excluded_negative', { maximumAllInPurchaseRmb: -3.2 }) }),
    product('2107989737')
  ], declines: [{ marketProductId: '2107989737', reason: '尺寸太大' }] })));
  assert.match(html, /已自动排除 1 条（预估负利润）/);
  assert.match(html, /已淘汰 1 条（你自己不要的，默认隐藏）/u);
  assert.match(html, /你的理由：尺寸太大/);
  assert.equal(html.match(/>要</gu).length, 1, '只有还没被排除的商品有「要」');
  assert.equal(html.match(/预估负利润，不建议做/gu), null, '被排除的商品不再占用主列表');
});

test('每张卡片给出要、不要的固定理由和稍后；已建卡的商品只给查看', async () => {
  const html = await render(props(view({ products: [product('2107989735')] })));
  assert.match(html, /<summary>不要（淘汰）<\/summary>/u);
  assert.match(html, /选一个原因：/);
  for (const reason of ['尺寸太大', '利润太薄', '品牌风险', '不想做这类', '其他', '返回']) {
    assert.match(html, new RegExp(`>${reason}<`, 'u'));
  }
  assert.match(html, />稍后</);
  const imported = await render(props(view({ products: [product('2107989735')],
    importedCandidates: [{ marketProductId: '2107989735', candidateId: 'candidate:synthetic' }] })));
  assert.match(imported, /已在评审台/);
  assert.match(imported, />查看</);
  assert.equal(imported.match(/>要</gu), null);
  assert.equal(imported.match(/<summary>不要（淘汰）<\/summary>/gu), null);
});

test('右栏只剩下一轮方向：需要你处理和进行中各有自己的页面，这里不再放第二份', async () => {
  const empty = await render(props(view({ products: [] })));
  assert.match(empty, /本店当前没有等你决定的商品/);
  const candidates = [
    { id: 'candidate:a', productName: '合成商品甲', targetStore: 'miska', workflowStatus: 'codex_processing',
      displayStatus: 'codex_processing', imageUrl: '', needsFromUser: ['补一个1688链接'],
      updatedAt: '2026-09-09T04:00:00.000Z', createdAt: '2026-09-09T04:00:00.000Z' }
  ];
  const html = await render(props(view({ products: [product('2107989735')] }), { candidates }));
  for (const gone of [/需要你处理（/u, /打开进行中/u, /我选的商品/u, /合成商品甲/u, /一键淘汰/u]) assert.doesNotMatch(html, gone);
  assert.match(html, /<h3>下一轮方向<\/h3>/u);
  assert.match(html, /普通非电桌面整理小件（合成）/);
});

// The rail names what the next click would query, which is not the direction the last round used.
const nextRoundView = (batches, direction = '宠物服装（合成）') => ({ schemaVersion: 'a-discovery-view-v1',
  targetStores: ['miska', 'dandanshu'], canPrepare: true, bindings: [{ bindingId: 'binding:x', configurationVersion: 'version:1' }],
  plans: [{ planId: 'plan:next', version: 'version:1', direction,
    budget: { maxCredits: 20, estimatedPointsByStep: { quota_before: 0, category_detail: 13, quota_after: 0 } } }],
  batches });

test('右栏写的是下一轮要查的方向和预计点数，不是上一轮的方向', async () => {
  const html = await render(props(nextRoundView(view({ products: [product('2107989735')] }).batches)));
  assert.match(html, /<h3>下一轮方向<\/h3>/u);
  assert.doesNotMatch(html, /<h3>本轮方向<\/h3>/u);
  assert.match(html, /<p class="desk-rail-direction">宠物服装（合成）<\/p>/u);
  assert.match(html, /这一轮预计扣 13 分/u);
  // The feed still reports the direction the shown products actually came from.
  assert.match(html, /本轮结果：普通非电桌面整理小件（合成）/u);
});

test('历史轮次没处理的商品默认藏在一个折叠里，最新一轮在上面', async () => {
  const round = (batchId, createdAt, direction, products) => ({ batch: { batchId, revision: 0, targetStore: 'miska', createdAt,
    plan: { provider: 'seerfar', direction } },
    jobs: [{ job: { status: 'completed', scopeBinding: { request: { method: 'category_detail' } } },
      receipt: { steps: [{ method: 'category_detail', result: { products } }] } }],
    selections: [], importedCandidates: [], declines: [] });
  const html = await render(props(nextRoundView([
    round('a-discovery-batch:older', '2026-09-08T04:00:00.000Z', '旧方向（合成）', [product('2107989730', { titleZh: '去年的收纳盒' })]),
    round('a-discovery-batch:newer', '2026-09-10T04:00:00.000Z', '新方向（合成）', [product('2107989735', { titleZh: '本轮的收纳盒' })])
  ])));
  assert.match(html, /历史轮次未处理的 1 条（默认隐藏）/u);
  assert.match(html, /本轮结果：新方向（合成） · 查询于 2026-09-\d\d/u);
  assert.ok(html.indexOf('本轮的收纳盒') < html.indexOf('历史轮次未处理的'), '最新一轮排在折叠之前');
  assert.ok(html.indexOf('历史轮次未处理的') < html.indexOf('去年的收纳盒'), '历史商品只出现在折叠里');
  assert.doesNotMatch(html, /<details class="desk-folded" open/u);
});

// The candidate shapes the server returns for a product that came out of a query round.
const picked = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: 'miska',
  workflowStatus: 'codex_processing', displayStatus: 'codex_processing', needsFromUser: [],
  imageUrl: 'https://ir.ozone.ru/s3/synthetic/2107989735.jpg', createdAt: '2026-09-09T04:00:00.000Z',
  updatedAt: '2026-09-09T04:00:00.000Z',
  aDiscoveryEvidenceV2: { schemaVersion: 'a-discovery-candidate-evidence-v2', provider: 'seerfar', platform: 'ozon',
    batchId: 'a-discovery-batch:synthetic', marketProductId: '2107989735', observedMarketPrice: { value: 297, currency: '₽' } },
  ...extra });
const draft = { schemaVersion: 'supplier-draft-v1', sourceUrl: 'https://detail.1688.com/offer/876240928352.html', allInPurchaseRmb: 18.86 };

test('顶栏在商品页写明是哪件商品，并留一条回选品台的路', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /商品 · \{shortProductTitle\(productCandidate, productTitleZh\)\}/u);
  assert.match(app, /className="app-brand-back" onClick=\{\(\) => setView\("desk"\)\}>← 选品台/u);
  // The product page and the top bar read the same candidate and the same translated title.
  assert.match(app, /const productCandidate = view === "product" \? state\.candidates\.find\(item => item\.id === selectedId\) \?\? null : null;/u);
  assert.match(app, /candidate=\{productCandidate\}/u);
  assert.match(app, /titleZh=\{productTitleZh\}/u);
  assert.match(app, /onBack=\{\(\) => setView\("desk"\)\}/u);
});

test('已建卡的那一行还能淘汰；已淘汰的商品在进行中和需要你处理里恢复，不在这里另放一份', async () => {
  const gone = (id, extra = {}) => picked(id, { workflowStatus: 'eliminated', displayStatus: 'eliminated',
    eliminatedAt: new Date(2026, 8, 11, 13, 45).toISOString(), eliminationReason: '主人淘汰：利润太薄', dataRevision: 9, ...extra });
  const html = await render(props(view({ products: [product('2107989735', { titleZh: '合成收纳盒' })],
    importedCandidates: [{ marketProductId: '2107989735', candidateId: 'candidate:filled' }] }), {
    candidates: [picked('candidate:filled', { dataRevision: 4 }), gone('candidate:dropped', { productName: '被淘汰的合成商品' })]
  }));
  assert.equal((html.match(/eliminate-button/gu) ?? []).length, 1);
  assert.match(html, /已在评审台/u);
  assert.doesNotMatch(html, /被淘汰的合成商品|已淘汰 1（默认隐藏）/u);
});

test('淘汰按钮的确认是一句话加固定几个理由，不套第二层弹窗', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(fileURLToPath(new URL('../src/components/EliminateControl.jsx', import.meta.url)), 'utf8');
  assert.match(source, /确定淘汰这件？它会从各个列表里消失，随时能在「已淘汰」里恢复。/u);
  assert.match(source, /DECLINE_REASONS\.map/u, '理由只能是选品台已有的那五个词');
  assert.doesNotMatch(source, /window\.confirm|role="dialog"/u, '不再套一层弹窗');
  assert.match(source, />直接淘汰</u, '理由可以不写');
  assert.match(source, />取消</u);
});
