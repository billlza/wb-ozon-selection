import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingBatchReview } from '../src/siblingBatchReview.js';

function family(count) {
  const first = '6222816678021';
  const selected = Array.from({ length: count }, (_, index) => String(6222816678021 + index));
  const parent = { id: 'candidate:synthetic-family', dataRevision: 12,
    lifecycleV11: { skuPackage: { supplierSkuId: first, technicalStatus: 'unknown_outcome' } },
    sourceCapture: { selectedSkuIds: selected, skuChoices: selected.map((sourceSkuId, index) => ({
      sourceSkuId, variantName: `颜色 ${index}`, attributes: { 颜色: `颜色 ${index}` }
    })) } };
  const children = selected.slice(1).map(sourceSkuId => ({ id: `candidate:${sourceSkuId}`,
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: sourceSkuId } }));
  return { parent, children };
}

test('one selected 32-variant family projects 31 internal rows and never includes the unknown first import', () => {
  const { parent, children } = family(32);
  const before = structuredClone({ parent, children });
  const review = siblingBatchReview(parent, [parent, ...children]);
  assert.equal(review.rows.length, 31);
  assert.deepEqual(review.excludedSourceSkuIds, ['6222816678021']);
  assert.equal(review.rows.every(row => row.candidateId !== parent.id && row.status === 'blocked'), true);
  assert.equal(review.rows.every(row => row.gaps.includes('B 当前店铺正式利润待完成')), true);
  assert.deepEqual({ parent, children }, before);
});

test('current three selected colors show their own missing evidence and leave the unselected color out', () => {
  const { parent, children } = family(4);
  parent.sourceCapture.selectedSkuIds = [parent.sourceCapture.selectedSkuIds[0],
    ...parent.sourceCapture.selectedSkuIds.slice(1, 4)];
  parent.sourceCapture.skuChoices.push({ sourceSkuId: '6222816679000', attributes: { 颜色: '未选颜色' } });
  children[0].lifecycleV11 = { skuPackage: { selectedSupplySnapshot: { ownerSupplyConfirmation: { status: 'confirmed' } },
    profitModels: [{ profitModelVersion: 'profit:synthetic', result: 'passed', commissionMode: 'exact' }],
    activeProfitModelVersion: 'profit:synthetic' } };
  const review = siblingBatchReview(parent, children);
  assert.equal(review.rows.length, 3);
  assert.equal(review.rows.some(row => row.sourceSkuId === '6222816679000'), false);
  assert.equal(review.rows[0].gaps.includes('A 供应规格及数量 1 证据待确认'), false);
  assert.equal(review.rows[0].gaps.includes('B 当前店铺正式利润待完成'), false);
  assert.equal(review.rows[0].gaps.includes('C1 本规格事实及官方颜色属性待确认'), true);
  assert.equal(review.rows[1].gaps.includes('A 供应规格及数量 1 证据待确认'), true);
});

function readyFamily() {
  const { parent, children } = family(3);
  for (const [index, child] of children.entries()) {
    child.lifecycleV11 = { skuPackage: {
      selectedSupplySnapshot: { ownerSupplyConfirmation: { status: 'confirmed' } },
      profitModels: [{ profitModelVersion: 'profit:synthetic', result: 'passed', commissionMode: 'exact' }],
      activeProfitModelVersion: 'profit:synthetic', c1ProductPlan: { status: 'seo_draft_ready' },
      c2FinalAssets: { productionAuthorizationPreparation: { finalUploads: [{ assetId: `synthetic-main-${index}` }] } },
      productionConfirmationCard: { status: 'awaiting_owner_business_confirmation' }
    } };
    child.productionOwnerPreparation = { ready: true, gaps: [],
      commercialDraft: { merchantSku: `MERCHANT-COLOR-${index}`, stock: 10 + index },
      scope: { buyerTargetPrice: { amount: 900 + index, currency: 'RUB' },
        platformWritePrice: { amount: 75 + index, currency: 'CNY' }, stock: 10 + index },
      executionBindings: [{ bindingId: 'warehouse:A', configurationVersion: 'config:1', warehouseName: '仓 A' },
        { bindingId: 'warehouse:B', configurationVersion: 'config:1', warehouseName: '仓 B' }] };
  }
  return { parent, children };
}

test('final batch rows expose each missing item and the exact merchant SKU, stock and two currency prices', () => {
  const { parent, children } = readyFamily();
  children[1].productionOwnerPreparation = { ...children[1].productionOwnerPreparation, ready: false,
    gaps: [{ code: 'PRODUCTION_BINDING_EXPIRED', message: '当前店铺的生产绑定核验声明已过期' }],
    scope: null };
  const review = siblingBatchReview(parent, children);
  assert.equal(review.rows[0].merchantSku, 'MERCHANT-COLOR-0');
  assert.equal(review.rows[0].stock, 10);
  assert.equal(review.rows[0].buyerPriceRub, 900);
  assert.equal(review.rows[0].writePriceCny, 75);
  assert.deepEqual(review.rows[1].gaps, ['当前店铺的生产绑定核验声明已过期']);
  assert.equal(review.rows[1].merchantSku, 'MERCHANT-COLOR-1');
  assert.equal(review.rows[1].stock, 11);
  assert.equal(review.rows[1].buyerPriceRub, null);
  assert.equal(review.rows[1].writePriceCny, null);
  assert.equal(review.ready, false);
});

test('final batch offers only currently valid warehouses shared by every selected member', () => {
  const { parent, children } = readyFamily();
  children[1].productionOwnerPreparation.executionBindings = [
    { bindingId: 'warehouse:B', configurationVersion: 'config:1', warehouseName: '仓 B' },
    { bindingId: 'warehouse:C', configurationVersion: 'config:1', warehouseName: '仓 C' }
  ];
  const review = siblingBatchReview(parent, children);
  assert.deepEqual(review.executionBindings, [
    { bindingId: 'warehouse:B', configurationVersion: 'config:1', warehouseName: '仓 B' }
  ]);
  children[1].productionOwnerPreparation.executionBindings = [];
  const noCommonBinding = siblingBatchReview(parent, children);
  assert.deepEqual(noCommonBinding.executionBindings, []);
  assert.equal(noCommonBinding.ready, false);
  assert.match(noCommonBinding.rows[1].gaps.join('；'), /仓库|绑定/);
});
