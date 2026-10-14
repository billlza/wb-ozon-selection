import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingMerchantSkuSuggestions, siblingBatchMemberDefaults } from '../src/siblingBatchFormDefaults.js';

const firstSkuId = '6222816678021';
const offerId = '1038877014153';
const firstMerchantSku = `OZ-1688-${offerId}-${firstSkuId}`;
const ids = ['6222816678023', '6222816678020', '6222816678019'];
function family() {
  const storeRef = { stableStoreId: 'synthetic-store', platformStoreId: 'synthetic-seller' };
  return { id: 'candidate:synthetic-parent', targetPlatform: 'ozon', storeRef,
    sourceCapture: { offerId, selectedSkuIds: [firstSkuId, ...ids] },
    supplierDraftV1: { offerId }, lifecycleV11: { productionCommercialDraftV1: { merchantSku: firstMerchantSku },
      skuPackage: { skuPackageId: 'sku:synthetic-first', supplierSkuId: firstSkuId,
        productionConfirmationCard: { ownerDecision: { merchantSku: firstMerchantSku } },
        productionAuthorization: { schemaVersion: 'production-authorization-v1.2', authorizationId: 'auth:synthetic',
          status: 'confirmed', identity: { candidateId: 'candidate:synthetic-parent', skuPackageId: 'sku:synthetic-first',
            platform: 'ozon', storeRef, supplierSkuId: firstSkuId, merchantSku: firstMerchantSku },
          lockedScope: { candidateId: 'candidate:synthetic-parent', skuPackageId: 'sku:synthetic-first',
            platform: 'ozon', storeRef, supplierSkuId: firstSkuId, merchantSku: firstMerchantSku } },
        dHandoff: { candidateId: 'candidate:synthetic-parent', skuPackageId: 'sku:synthetic-first',
          productionAuthorizationId: 'auth:synthetic',
          identity: { platform: 'ozon', storeRef, supplierSkuId: firstSkuId, merchantSku: firstMerchantSku } } } } };
}

test('three selected specifications get distinct stable suggestions without changing the first item', () => {
  const parent = family();
  const before = structuredClone(parent);
  const rows = ids.map(sourceSkuId => ({ sourceSkuId }));
  const first = siblingMerchantSkuSuggestions(parent, rows);
  assert.deepEqual(first, Object.fromEntries(ids.map(id => [id, `OZ-1688-${offerId}-${id}`])));
  assert.deepEqual(siblingMerchantSkuSuggestions(parent, rows), first);
  assert.equal(new Set(Object.values(first)).size, 3);
  assert.equal(Object.values(first).includes(firstMerchantSku), false);
  assert.deepEqual(parent, before);
});

test('legacy full authorization remains a valid frozen naming anchor', () => {
  const parent = family();
  parent.lifecycleV11.skuPackage.productionAuthorization.schemaVersion = 'production-authorization-v1.1';
  assert.deepEqual(siblingMerchantSkuSuggestions(parent, ids.map(sourceSkuId => ({ sourceSkuId }))),
    Object.fromEntries(ids.map(id => [id, `OZ-1688-${offerId}-${id}`])));
});

test('missing frozen anchor and mismatched offer or first SKU block suggestions', () => {
  const rows = ids.map(sourceSkuId => ({ sourceSkuId }));
  const missing = family();
  delete missing.lifecycleV11.skuPackage.productionAuthorization;
  assert.throws(() => siblingMerchantSkuSuggestions(missing, rows), /首件冻结货号/);
  const changedOffer = family();
  changedOffer.sourceCapture.offerId = 'different';
  assert.throws(() => siblingMerchantSkuSuggestions(changedOffer, rows), /来源身份/);
  const changedSku = family();
  changedSku.lifecycleV11.skuPackage.dHandoff.identity.supplierSkuId = 'different';
  assert.throws(() => siblingMerchantSkuSuggestions(changedSku, rows), /来源身份/);
  const changedDraft = family();
  changedDraft.lifecycleV11.productionCommercialDraftV1.merchantSku = 'different';
  assert.throws(() => siblingMerchantSkuSuggestions(changedDraft, rows), /来源身份/);
  const changedStore = family();
  changedStore.lifecycleV11.skuPackage.dHandoff.identity.storeRef = { ...changedStore.storeRef,
    platformStoreId: 'different-seller' };
  assert.throws(() => siblingMerchantSkuSuggestions(changedStore, rows), /来源身份/);
  const changedAuthorization = family();
  changedAuthorization.lifecycleV11.skuPackage.productionAuthorization.lockedScope.storeRef = {
    ...changedAuthorization.storeRef, platformStoreId: 'different-seller' };
  assert.throws(() => siblingMerchantSkuSuggestions(changedAuthorization, rows), /来源身份/);
  const changedAuthorizationId = family();
  changedAuthorizationId.lifecycleV11.skuPackage.productionAuthorization.authorizationId = 'auth:other';
  assert.throws(() => siblingMerchantSkuSuggestions(changedAuthorizationId, rows), /来源身份/);
  const changedAuthorizationScope = family();
  changedAuthorizationScope.lifecycleV11.skuPackage.productionAuthorization.lockedScope.supplierSkuId = 'different';
  assert.throws(() => siblingMerchantSkuSuggestions(changedAuthorizationScope, rows), /来源身份/);
  for (const field of ['candidateId', 'skuPackageId', 'platform']) {
    const changed = family();
    changed.lifecycleV11.skuPackage.productionAuthorization.lockedScope[field] = 'different';
    assert.throws(() => siblingMerchantSkuSuggestions(changed, rows), /来源身份/, field);
  }
  const changedLockedSku = family();
  changedLockedSku.lifecycleV11.skuPackage.productionAuthorization.lockedScope.merchantSku = 'different';
  assert.throws(() => siblingMerchantSkuSuggestions(changedLockedSku, rows), /来源身份/);
  const changedIdentitySku = family();
  changedIdentitySku.lifecycleV11.skuPackage.productionAuthorization.identity.merchantSku = 'different';
  assert.throws(() => siblingMerchantSkuSuggestions(changedIdentitySku, rows), /来源身份/);
  for (const field of ['candidateId', 'skuPackageId', 'supplierSkuId', 'platform']) {
    const changed = family();
    changed.lifecycleV11.skuPackage.productionAuthorization.identity[field] = 'different';
    assert.throws(() => siblingMerchantSkuSuggestions(changed, rows), /来源身份/, field);
  }
  const changedIdentityStore = family();
  changedIdentityStore.lifecycleV11.skuPackage.productionAuthorization.identity.storeRef = {
    ...changedIdentityStore.storeRef, platformStoreId: 'different-seller' };
  assert.throws(() => siblingMerchantSkuSuggestions(changedIdentityStore, rows), /来源身份/);
  const unconfirmed = family();
  unconfirmed.lifecycleV11.skuPackage.productionAuthorization.status = 'pending';
  assert.throws(() => siblingMerchantSkuSuggestions(unconfirmed, rows), /来源身份/);
  const rawReference = family();
  rawReference.lifecycleV11.skuPackage.productionAuthorization = { schemaVersion: 'production-entity-reference-v1',
    entityId: 'auth:synthetic', scope: structuredClone(rawReference.lifecycleV11.skuPackage.productionAuthorization.lockedScope) };
  assert.throws(() => siblingMerchantSkuSuggestions(rawReference, rows), /来源身份/);
  assert.throws(() => siblingMerchantSkuSuggestions(family(), [{ sourceSkuId: firstSkuId }]), /本批供应 SKU/);
  assert.throws(() => siblingMerchantSkuSuggestions(family(), [{ sourceSkuId: ids[0] }, { sourceSkuId: ids[0] }]), /重复/);
});

test('member defaults have 100 stock, inherited shared price, and no confirmation state', () => {
  const suggestions = siblingMerchantSkuSuggestions(family(), ids.map(sourceSkuId => ({ sourceSkuId })));
  const defaults = siblingBatchMemberDefaults(ids[0], suggestions);
  assert.deepEqual(defaults, { targetSalePriceRub: '', merchantSku: suggestions[ids[0]], stock: '100' });
  assert.equal(Object.hasOwn(defaults, 'confirmed'), false);
});
