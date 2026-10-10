import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE1_SKIP_REASONS, cheapestMoqOne, domesticShippingFromPriceNote, gate1BrandRisk, gate1OzonOptions, gate1PickTag,
  gate1Preselection, gate1SkipInputErrors, gate1SupplierOptions
} from '../lib/gate1-preselect.mjs';
import { SKIP_REASONS } from '../lib/store-profile.mjs';

// Synthetic match records only: offer ids, product ids, titles and prices are made up.
const offer = (id, extra = {}) => ({ offerId: String(id), sourceUrl: `https://detail.1688.com/offer/${id}.html`, title: `合成货源 ${id}`,
  imageUrl: null, priceCny: 20, priceNote: '运费5元', quantityBegin: 1, similarity: 'similar', distance: 10, ...extra });
const ozonItem = (id, extra = {}) => ({ productId: String(id), sourceUrl: `https://www.ozon.ru/product/${id}/`, title: `Синтетика ${id}`,
  imageUrl: null, priceRub: 1500, similarity: 'similar', distance: 10, ...extra });
const record = (results, judgements = {}, status = 'compared') => ({ captureId: 'X-1', status, results, judgements });
const judged = judgement => ({ judgement, judgedAt: '2026-10-10T00:00:00.000Z', judgedBy: 'owner' });

test('不做原因和店铺档案的 SKIP_REASONS 逐字一致', () => {
  assert.deepEqual({ ...GATE1_SKIP_REASONS }, { ...SKIP_REASONS });
});

test('软件先选最像的那一条：主人点过是同款的优先，近似款、不是、首图不像的永远不选', () => {
  const candidate = {
    ozonImageMatch: record([ozonItem(1, { similarity: 'similar', distance: 12 }), ozonItem(2, { similarity: 'identical', distance: 0 }),
      ozonItem(3, { similarity: 'different' }), ozonItem(4, { similarity: 'identical', distance: 1 })], { 4: judged('near') }),
    supplierImageMatch: record([offer(11, { similarity: 'similar', distance: 3 }), offer(12, { similarity: 'different', distance: 40 }),
      offer(13, { similarity: 'identical', distance: 0 })], { 12: judged('exact'), 13: judged('wrong') })
  };
  assert.deepEqual(gate1OzonOptions(candidate).map(row => row.productId), ['2', '1']);
  // 主人点过「是同款」的那一条即使首图不像也排第一；点过「不是」的被拿掉。
  assert.deepEqual(gate1SupplierOptions(candidate).map(row => row.offerId), ['12', '11']);
  assert.equal(gate1Preselection(candidate).ozonProductId, '2');
  assert.equal(gate1Preselection(candidate).matchOfferId, '12');
});

test('还没读回、还在找、或者没有结果时，什么都不先选', () => {
  assert.deepEqual(gate1Preselection({}), { ozonProductId: null, matchOfferId: null, supplierOfferId: null });
  assert.deepEqual(gate1Preselection({ supplierImageMatch: record([offer(1)], {}, 'searching') }).matchOfferId, null);
});

test('货源取最便宜又确定能一件起订的；起批量没读到或多件起批的不算，运费读得懂才加上', () => {
  const candidate = { supplierImageMatch: record([
    offer(1, { priceCny: 10, quantityBegin: 3 }),
    offer(2, { priceCny: 12, quantityBegin: null }),
    offer(3, { priceCny: 15, priceNote: '运费8元' }),
    offer(4, { priceCny: 18, priceNote: '包邮' }),
    offer(5, { priceCny: null })
  ]) };
  const options = gate1SupplierOptions(candidate);
  const byId = Object.fromEntries(options.map(row => [row.offerId, row]));
  assert.equal(byId['3'].allInPurchaseRmb, 23);
  assert.equal(byId['4'].allInPurchaseRmb, 18);
  assert.equal(byId['2'].moqOne, false);
  assert.equal(cheapestMoqOne(options).offerId, '4');
  assert.equal(gate1Preselection(candidate).supplierOfferId, '4');
});

test('价格说明里的运费：包邮是 0，写了几元就是几元，看不懂就是 null', () => {
  assert.equal(domesticShippingFromPriceNote('包邮'), 0);
  assert.equal(domesticShippingFromPriceNote('运费5元'), 5);
  assert.equal(domesticShippingFromPriceNote('运费 ¥3.5'), 3.5);
  assert.equal(domesticShippingFromPriceNote('满2件减1元'), null);
  assert.equal(domesticShippingFromPriceNote(null), null);
});

test('每一格标软件先选的还是你改过', () => {
  assert.equal(gate1PickTag('1', '1'), 'software');
  assert.equal(gate1PickTag('1', '2'), 'owner');
  assert.equal(gate1PickTag(null, '2'), 'owner');
  assert.equal(gate1PickTag('1', null), null);
});

test('品牌风险：看见品牌或授权字样就直说，什么都没看见也不说没有风险', () => {
  const warn = gate1BrandRisk({ marketBrand: 'SyntheticBrand', supplierTitle: '正品授权 合成猫窝' });
  assert.equal(warn.level, 'warn');
  assert.match(warn.line, /标着品牌「SyntheticBrand」/u);
  assert.match(warn.line, /1688 货源标题里有「正品」/u);
  const none = gate1BrandRisk({ marketBrand: 'Нет бренда', supplierTitle: '合成猫窝' });
  assert.equal(none.level, 'none_seen');
  assert.match(none.line, /没看到品牌或授权字样/u);
  assert.match(none.line, /要你自己看一眼/u);
});

test('不做的原因：只收五个码，「其他」必须写一句，备注不超过 200 字', () => {
  assert.equal(gate1SkipInputErrors({ reason: 'too_large' }), null);
  assert.match(gate1SkipInputErrors({ reason: '尺寸太大' }), /请选一个/u);
  assert.match(gate1SkipInputErrors({ reason: 'other', note: '  ' }), /写一句/u);
  assert.equal(gate1SkipInputErrors({ reason: 'other', note: '颜色不好看' }), null);
  assert.match(gate1SkipInputErrors({ reason: 'thin_profit', note: 'x'.repeat(201) }), /200/u);
});
