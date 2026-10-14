import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfirmedSupplierPowerProfile, readConfirmedSupplierVariantAttributes, buildSavedSkuFactReconciliation, inspectSavedSkuFactReconciliation } from '../lib/confirmed-supplier-inputs.mjs';
import { createAProductDetailCandidateFixture } from './fixtures/a-product-detail-evidence-fixture.mjs';
import { SYNTHETIC_STORE_REF } from './fixtures/store-binding-fixture.mjs';
function candidate() {
  const c = { id: 'candidate:fixture', dataRevision: 9, targetPlatform: 'ozon', storeRef: structuredClone(SYNTHETIC_STORE_REF) };
  c.cargoFactsV1 = { schemaVersion: 'candidate-cargo-facts-v1', declaredBy: 'owner', declaredRevision: 3, declaredAt: '2026-09-16T12:00:00.000Z', facts: {
    batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true, irregularShape: false,
    sourceRef: 'owner-cargo-facts:candidate:fixture:3:2026-09-16T12:00:00.000Z'
  } };
  c.sourceCapture = { captureId: 'capture:fixture', skuChoices: [{ sourceSkuId: 'sku:1', propPath: 'khaki', attributes: { 颜色: '卡其色', 尺码: '均码', 规格: '卡其色>均码' } }], skuSelection: { selectedBy: 'owner', selectedSkuIds: ['sku:1'] } };
  c.lifecycleV11 = { skuPackage: { skuPackageId: 'package:1', supplierSkuId: 'sku:1', variantKey: 'khaki', g1Identity: { schemaVersion: 'g1-identity-v1', candidateId: c.id, platform: 'ozon', skuPackageId: 'package:1', supplierSkuId: 'sku:1', storeRef: c.storeRef, merchantSku: 'not_applicable', warehouseRef: 'not_applicable', credentialAlias: 'not_applicable', platformProductId: 'not_applicable' }, selectedSupplySnapshot: {
    snapshotId: 'supply:1', ownerSupplyConfirmation: { status: 'confirmed', supplierSkuId: 'sku:1', variantKey: 'khaki' }, supplierSku: { supplierSkuId: 'sku:1', variantKey: 'khaki', attributes: { quantityOneEvidence: { captureId: 'capture:fixture' } } }
  }, productionConfirmationCard: { cardId: 'card:1' } } };
  return c;
}
test('saved owner facts and exact variant are recovered without changing frozen history', () => {
  const c = candidate(), before = JSON.stringify(c);
  const result = buildSavedSkuFactReconciliation({ candidate: c });
  assert.deepEqual(result.records.map(r => r.valueZh), ['无电池', '卡其色', '均码', '卡其色>均码']);
  assert.equal(result.productionAuthorized, false);
  assert.equal(result.writesFrozenHistory, false);
  assert.equal(result.sourceCardId, 'card:1');
  assert.equal(JSON.stringify(c), before);
  assert.equal(Object.hasOwn(result.records[0].powerProfile, 'powered'), false, 'no battery does not prove lack of external power');
});
test('missing declaration stays absent; malformed and foreign declarations fail explicitly', () => {
  assert.equal(readConfirmedSupplierPowerProfile({}), null);
  for (const mutate of [c => c.cargoFactsV1.declaredBy = 'software', c => c.cargoFactsV1.declaredRevision = -1, c => c.cargoFactsV1.declaredRevision = 10, c => c.cargoFactsV1.facts.sourceRef = 'foreign', c => c.cargoFactsV1.facts.batteryType = 'invented']) {
    const c = candidate(); mutate(c);
    assert.throws(() => readConfirmedSupplierPowerProfile(c), /CONFIRMED_CARGO_/);
    assert.equal(inspectSavedSkuFactReconciliation({ candidate: c }).applicationStatus, 'blocked');
  }
});
test('capture identity, variant and exact unique SKU are mandatory', () => {
  for (const mutate of [c => c.sourceCapture.captureId = 'other', c => c.sourceCapture.skuChoices[0].propPath = 'black', c => c.sourceCapture.skuChoices.push(structuredClone(c.sourceCapture.skuChoices[0])), c => c.sourceCapture.skuChoices[0].attributes.颜色 = '']) {
    const c = candidate(); mutate(c);
    assert.throws(() => readConfirmedSupplierVariantAttributes(c, { supplierSkuId: 'sku:1', variantKey: 'khaki', captureId: 'capture:fixture' }), /CONFIRMED_VARIANT_/);
  }
});
test('reconciliation cannot cross store, candidate, SKU, or unsigned selection', () => {
  for (const mutate of [c => c.lifecycleV11.skuPackage.g1Identity.candidateId = 'other', c => c.lifecycleV11.skuPackage.g1Identity = null, c => c.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.supplierSkuId = 'other', c => c.sourceCapture.skuSelection.selectedBy = 'software']) {
    const c = candidate(); mutate(c);
    const result = inspectSavedSkuFactReconciliation({ candidate: c });
    assert.equal(result.applicationStatus, 'blocked');
    assert.equal(result.productionAuthorized, false);
    assert.deepEqual(result.records, []);
  }
});


test('variant identity follows the existing attribute-derived path without requiring propPath', () => {
  const c = candidate();
  delete c.sourceCapture.skuChoices[0].propPath;
  c.sourceCapture.skuChoices[0].attributes = { 颜色: '卡其色', 尺码: 1 };
  const expected = '尺码=1|颜色=卡其色';
  assert.deepEqual(readConfirmedSupplierVariantAttributes(c, { supplierSkuId: 'sku:1', variantKey: expected, captureId: 'capture:fixture' }), { 颜色: '卡其色', 尺码: 1 });
  c.sourceCapture.skuChoices[0].attributes = {};
  assert.deepEqual(readConfirmedSupplierVariantAttributes(c, { supplierSkuId: 'sku:1', variantKey: 'sku:1', captureId: 'capture:fixture' }), {});
});

test('reconciliation binds the complete SKU identity including platform and package', () => {
  for (const mutate of [c => c.lifecycleV11.skuPackage.g1Identity.platform = 'wb',
    c => c.lifecycleV11.skuPackage.g1Identity.skuPackageId = 'package:other',
    c => c.lifecycleV11.skuPackage.g1Identity.supplierSkuId = 'sku:other',
    c => c.sourceCapture.skuChoices.push(null)]) {
    const c = candidate(); mutate(c);
    assert.equal(inspectSavedSkuFactReconciliation({ candidate: c }).applicationStatus, 'blocked');
  }
});

function reviewedCandidate() {
  const c = candidate(), sku = c.lifecycleV11.skuPackage;
  sku.dataRevision = 7;
  sku.c1ProductPlan = { inputSnapshots: { skuRightsReview: {
    schemaVersion: 'c1-sku-rights-review-v1', reviewId: 'rights:fixture', sourceIdentity: structuredClone(sku.g1Identity),
    variantKey: sku.variantKey, sourceSkuRevision: 2, sourceSupplySnapshotId: 'supply:1',
    reviewedAt: '2026-09-16T12:00:00.000Z', expiresAt: '2026-10-16T12:00:00.000Z',
    brand: { status: 'unbranded', name: null, evidenceRefs: ['owner-rights:fixture'] },
    rights: { status: 'verified', basis: 'no_third_party_rights_identified', evidenceRefs: ['owner-rights:fixture'] }
  } } };
  return c;
}
test('historical signed brand review remains bound to its supply without matching later C2 revision', () => {
  const c = reviewedCandidate(), before = structuredClone(c);
  assert.equal(buildSavedSkuFactReconciliation({ candidate: c }).records.find(r => r.field === 'brand').value, 'Нет бренда');
  assert.deepEqual(c, before);
  for (const mutate of [r => r.sourceSupplySnapshotId = 'supply:other', r => r.sourceIdentity.skuPackageId = 'package:other',
    r => r.sourceIdentity.platform = 'wb', r => r.brand.evidenceRefs = [], r => r.sourceSkuRevision = -1]) {
    const invalid = reviewedCandidate(); mutate(invalid.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview);
    assert.equal(inspectSavedSkuFactReconciliation({ candidate: invalid }).applicationStatus, 'blocked');
  }
});


test('API receipt identity takes precedence over an unrelated old browser capture', async () => {
  const fixture = await createAProductDetailCandidateFixture();
  fixture.candidate.sourceCapture = candidate().sourceCapture;
  const before = structuredClone(fixture.candidate);
  const selected = readConfirmedSupplierVariantAttributes(fixture.candidate, fixture.input.supplierConfirmation);
  assert.deepEqual(selected, fixture.card.supplierCapture.skuChoices.find(item => item.sourceSkuId === fixture.input.supplierConfirmation.supplierSkuId).attributes);
  assert.deepEqual(fixture.candidate, before);
});

test('new facts revision replays exact selected colour and size with canonical collection references', async () => {
  const { createC1SupplierFactRevision, resolveC1SupplierFactRevision } = await import('../lib/confirmed-supplier-inputs.mjs');
  const c = reviewedCandidate(), sku = c.lifecycleV11.skuPackage;
  sku.c1ProductPlan.c1PlanId = 'c1:original';
  const original = structuredClone(c);
  const revision = createC1SupplierFactRevision({ candidate: c, revisionId: 'facts:revision:10', targetC1PlanId: 'c1:revised', preparedAt: '2026-09-17T12:00:00.000Z' });
  const plan = { c1PlanId: 'c1:revised', sourceFactsRevision: revision, supersedes: { c1PlanId: 'c1:original' },
    frozenInputRefs: { candidateId: c.id }, identity: { skuPackageId: sku.skuPackageId, supplierSkuId: sku.supplierSkuId, targetPlatform: c.targetPlatform },
    inputSnapshots: { confirmedSupplierSkuSnapshot: sku.selectedSupplySnapshot, platformSchemaRules: { storeRef: c.storeRef } } };
  const resolved = resolveC1SupplierFactRevision({ plan, sourceIdentity: sku.g1Identity });
  assert.equal(resolved.supplierSku.attributes.颜色, '卡其色');
  assert.equal(resolved.supplierSku.attributes.尺码, '均码');
  assert.equal(resolved.supplierSku.attributes.规格, '卡其色>均码');
  assert.equal(resolved.supplierSku.powerProfile.containsBattery, false);
  assert.equal(Object.hasOwn(resolved.supplierSku.powerProfile, 'powered'), false);
  assert.deepEqual(revision.records.find(r => r.field === 'color').sourceRefs, ['capture:fixture#/skuChoices/0/attributes', 'supply:1']);
  assert.deepEqual(c, original);
  const changed = structuredClone(plan); changed.sourceFactsRevision.records.find(r => r.field === 'color').value = '黑色';
  assert.throws(() => resolveC1SupplierFactRevision({ plan: changed, sourceIdentity: sku.g1Identity }), /SOURCE_CHANGED/);
  assert.throws(() => createC1SupplierFactRevision({ candidate: c, revisionId: 'facts:revision:10', targetC1PlanId: 'c1:revised', preparedAt: '2026-02-30T00:00:00.000Z' }), /INPUT_INVALID/);
});
