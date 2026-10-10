import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { gate1AcceptPayload, gate1CardView, gate1Mode, gate1ShortfallView, gate1SkipPayload } from '../src/gate1View.js';

// Synthetic display data only: no saved records, no services, no requests.
const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const option = (id, extra = {}) => ({ offerId: String(id), sourceUrl: `https://detail.1688.com/offer/${id}.html`, title: `合成货源 ${id}`,
  imageUrl: null, similarity: 'identical', judgement: null, priceCny: 18, priceNote: '包邮', domesticShippingRmb: 0, allInPurchaseRmb: 18,
  shippingKnown: true, quantityBegin: 1, moqOne: true, shopName: '合成店', isSourceOffer: false, ...extra });
const ozon = (id, extra = {}) => ({ productId: String(id), sourceUrl: `https://www.ozon.ru/product/${id}/`, title: `Синтетика ${id}`,
  imageUrl: null, similarity: 'identical', judgement: null, priceRub: 1500, reviewCount: 3, isSourceProduct: false, ...extra });
const profit = (unit, passes, extra = {}) => ({ allInPurchaseRmb: 18, unitProfitRmb: unit, marginRate: unit / 120, passes,
  minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either', shippingAssumedZero: false, ...extra });
const estimate = { status: 'ok', priceRub: 1500, revenueCny: 120, commissionRate: 0.14, freightRmb: 25, route: 'GUOO', maximumAllInPurchaseRmb: 40, missing: [] };
const gate1 = (extra = {}) => ({
  open: true, targetStore: 'miska', decision: null, shortfall: null, reopen: null,
  ozonOptions: [ozon(9001), ozon(9002, { priceRub: 1700, similarity: 'similar' })],
  supplierOptions: [option(7001, { priceCny: 25, allInPurchaseRmb: 25 }), option(7002), option(7003, { domesticShippingRmb: null, shippingKnown: false, priceNote: null, allInPurchaseRmb: 19, priceCny: 19 })],
  preselection: { ozonProductId: '9001', matchOfferId: '7001', supplierOfferId: '7002' },
  marketPriceRub: 1400, marketBrand: null,
  packageFacts: { weightGrams: 400, weightBasis: 'seerfar', dimensionMm: '300x200x100', dimensionsBasis: 'seerfar_volume' },
  roughProfit: { assumed: true, weightBasis: 'seerfar', dimensionsBasis: 'seerfar_volume', byPrice: {
    9001: { estimate, profits: { 7001: profit(20.5, true), 7002: profit(27.4, true), 7003: profit(26, true, { shippingAssumedZero: true }) } },
    9002: { estimate: { ...estimate, priceRub: 1700 }, profits: { 7002: profit(41, true) } },
    market: { estimate, profits: { 7002: profit(12, false) } } } },
  ...extra
});
const candidate = (extra = {}) => ({ id: 'candidate:card', productName: '合成猫窝', targetStore: 'miska', workflowStatus: 'needs_user_data',
  dataRevision: 5, imageUrl: null, ...extra });

let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./gate1-card-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url));
    const state = fileURLToPath(new URL('../src/siblingPreparationState.js', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'gate1-card-ui-test',
      resolveId: id => (id === entry ? entry : null),
      load: id => (id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
        import {createPreparationSaveState} from ${JSON.stringify(state)};import Page from ${JSON.stringify(component)};
        export const render=props=>renderToStaticMarkup(<Page preparationSaveState={createPreparationSaveState()} {...props}/>);` : null) }],
    ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render({ extensionStatus: { code: 'connected', label: '插件已连接' }, onRequestCapture: forbidden, onBack: forbidden,
    onAcceptGate1: forbidden, onSkipGate1: forbidden, onResolveGate1Shortfall: forbidden, onStartImageMatch: forbidden,
    onCompareImageMatch: forbidden, onJudgeImageMatch: forbidden, onStartOzonMatch: forbidden, onCompareOzonMatch: forbidden,
    onJudgeOzonMatch: forbidden, ...props });
}
const card = html => html.match(/<section class="product-section gate1-card[^"]*"[\s\S]*?<details class="product-folded gate1-matches"|<section class="product-section gate1-card[^"]*"[\s\S]*?<\/section>/u)?.[0] ?? '';

test('卡上三格都已先选好并标「软件先选的」，粗算一行说过不过线，品牌一行、默认店铺、做和不做都在', async () => {
  const html = card(await render({ candidate: candidate(), view: { gate1V1: gate1() } }));
  assert.match(html, /<h3>做这件？<\/h3>/u);
  assert.equal((html.match(/软件先选的<\/span>/gu) ?? []).length, 3);
  assert.doesNotMatch(html, /你改过<\/span>/u);
  assert.match(html, /<option value="7002" selected="">合成货源 7002 · ¥18\.00 · 包邮 · 一件起订 · 合成店<\/option>/u);
  assert.match(html, /粗算：每件赚 ¥27\.40（利润率 22\.8%），过线。本店门槛：每件 ≥ ¥20\.00 或利润率 ≥ 15%。这是估算，不是正式利润。/u);
  assert.match(html, /重量按Seerfar 记录的重量，尺寸按Seerfar 记录的尺寸。/u);
  assert.match(html, /品牌风险：品牌字段和两边标题里没看到品牌或授权字样/u);
  assert.match(html, /店铺：Miska（默认；上架那一步再选平台和店铺）/u);
  assert.match(html, /<button type="button" class="button primary">做这件<\/button>/u);
  assert.match(html, />不做这件<\/button>/u);
  assert.doesNotMatch(html, /aria-label="软件读不到的几项"/u, '都读得到时不问任何东西');
  assert.match(html, /不确认供货、不下单、不碰平台/u);
});

test('主人换了一格：标「你改过」，粗算按那一对取服务端算好的数；运费没读到时只问运费', () => {
  const changed = gate1CardView(gate1(), { local: { supplierOfferId: '7003' } });
  assert.equal(changed.tags.supplier, 'owner');
  assert.equal(changed.tags.ozon, 'software');
  assert.match(changed.profit.text, /国内运费没读到，先按 0 算/u);
  assert.deepEqual(changed.askFor.map(item => item.key), ['domesticShippingRmb']);
  assert.equal(changed.canAccept, false);
  const filled = gate1CardView(gate1(), { local: { supplierOfferId: '7003' }, facts: { domesticShippingRmb: '4' } });
  assert.equal(filled.canAccept, true);
  assert.deepEqual(gate1AcceptPayload(gate1(), filled, { domesticShippingRmb: '4' }, 5),
    { dataRevision: 5, ozonProductId: '9001', matchOfferId: '7001', supplierOfferId: '7003', facts: { domesticShippingRmb: 4 } });
  const otherPrice = gate1CardView(gate1(), { local: { ozonProductId: '9002' } });
  assert.match(otherPrice.profit.text, /每件赚 ¥41\.00/u);
  const noOzon = gate1CardView(gate1(), { local: { ozonProductId: null } });
  assert.match(noOzon.profit.text, /每件赚 ¥12\.00.*不过线/u);
});

test('没有能当货源的同款、或者尺寸读不到时，按钮不给点，并说清楚差什么', async () => {
  const empty = gate1({ supplierOptions: [], preselection: { ozonProductId: '9001', matchOfferId: null, supplierOfferId: null },
    packageFacts: { weightGrams: 400, weightBasis: 'seerfar', dimensionMm: '250x200x50', dimensionsBasis: 'category_default' },
    roughProfit: { assumed: true, weightBasis: 'seerfar', dimensionsBasis: 'category_default', byPrice: {} } });
  const view = gate1CardView(empty);
  assert.equal(view.canAccept, false);
  assert.ok(view.blockers.some(line => /1688 找同款还没有找到同款/u.test(line)));
  assert.deepEqual(view.askFor.map(item => item.key), ['dimensionsCm']);
  const html = card(await render({ candidate: candidate(), view: { gate1V1: empty } }));
  assert.match(html, /<button type="button" class="button primary" disabled="">做这件<\/button>/u);
  assert.match(html, /包装长（厘米）/u);
  assert.match(html, /尺寸按这一类商品常见的尺寸（估的）/u);
});

test('品牌字段或标题里有品牌字样时，那一行变成提醒', async () => {
  const html = card(await render({ candidate: candidate(), view: { gate1V1: gate1({ marketBrand: 'SyntheticBrand' }) } }));
  assert.match(html, /role="alert">品牌风险：Ozon 上这件商品标着品牌「SyntheticBrand」/u);
});

test('做过之后只剩一行；不做之后卡不出现', async () => {
  const decision = { decision: 'accept', picks: { ozon: { title: 'Синтетика 9001', tag: 'software' },
    supplier: { title: '合成货源 7003', priceCny: 19, tag: 'owner' } }, roughProfitAtDecision: { unitProfitRmb: 26 } };
  const done = await render({ candidate: candidate(), view: { gate1V1: { open: false, decision, shortfall: null } } });
  assert.match(done, /已做这件：Ozon 同款 Синтетика 9001（软件先选的）；货源 合成货源 7003 ¥19\.00（你改过）；当时粗算每件 ¥26\.00。/u);
  assert.doesNotMatch(done, /<h3>做这件？<\/h3>/u);
  assert.equal(gate1Mode({ open: false, decision: { decision: 'skip' } }, candidate({ workflowStatus: 'eliminated' })), 'skipped');
  const skipped = await render({ candidate: candidate({ workflowStatus: 'eliminated' }), view: { gate1V1: { open: false, decision: { decision: 'skip' } } } });
  assert.doesNotMatch(skipped, /gate1-card/u);
});

test('正式利润没过线：写明差多少，给换货源、改售价、不做三条路', async () => {
  const shortfall = { unitProfitRmb: 8.4, profitMargin: 0.07, shortfallRmb: 9.6, minimumUnitProfitRmb: 20, minimumProfitMargin: 0.15,
    choices: ['change_supplier', 'change_price', 'skip'] };
  const view = gate1ShortfallView(shortfall);
  assert.equal(view.line, '正式利润没过线：每件赚 ¥8.40、利润率 7.0%，离门槛还差每件 ¥9.60（门槛：每件 ≥ ¥20.00 或利润率 ≥ 15%）。');
  const html = await render({ candidate: candidate(), view: { gate1V1: { open: false, decision: { decision: 'accept' }, shortfall } } });
  assert.match(html, /aria-label="正式利润没过线"/u);
  assert.match(html, />换货源<\/button>/u);
  assert.match(html, />改售价<\/button>/u);
  assert.match(html, />不做<\/button>/u);
});

test('改售价重开的那一轮，卡顶上说上一轮怎么了，并且一定问售价', async () => {
  const reopened = gate1({ reopen: { choice: 'change_price', previousTargetSalePriceRub: 1500, shortfallRmb: 9.6 } });
  assert.deepEqual(gate1CardView(reopened).askFor.map(item => item.key), ['targetSalePriceRub']);
  const html = card(await render({ candidate: candidate(), view: { gate1V1: reopened } }));
  assert.match(html, /上一轮按 1 500 ₽ 卖正式利润没过线，差每件 ¥9\.60。改一个售价再做这件；上一轮的记录都留着。/u);
  assert.match(html, /Ozon 同款现在卖 1 500 ₽/u);
});

test('不做的请求体只带原因码和一句备注', () => {
  assert.deepEqual(gate1SkipPayload('other', '  颜色不好看 ', 5), { dataRevision: 5, reason: 'other', note: '颜色不好看' });
  assert.deepEqual(gate1SkipPayload('too_large', '', 5), { dataRevision: 5, reason: 'too_large' });
});
