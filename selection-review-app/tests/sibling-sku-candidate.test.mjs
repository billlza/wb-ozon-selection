// All long supplier, merchant, task and candidate identities in this test are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialCandidate } from '../lib/candidate-initialization.mjs';
import { collectMockOzonSalesSnapshot } from '../lib/sales-snapshot.mjs';
import { collectRealOzonSalesSnapshot } from '../lib/sales-snapshot.mjs';
import { buildDiscoveryMarketSalesSnapshot } from '../lib/discovery-market-snapshot.mjs';
import { buildRealAConfirmationCard } from '../lib/real-a-confirmation-card.mjs';
import { assertSafeBusinessMutationCandidate } from '../lib/runtime-identity.mjs';
import { createSiblingSkuCandidate, createSiblingSkuCandidatesBatch, siblingSkuCandidateName } from '../lib/sibling-sku-candidate.mjs';
import { assertSiblingSkuFinalCard } from '../lib/sibling-sku-card-guard.mjs';
import { SYNTHETIC_STORE_REF } from './fixtures/store-binding-fixture.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { buildProductionOwnerPreparationView, resolveProductionOwnerPreparation } from '../lib/production-owner-preparation.mjs';
import { PRODUCTION_ENTITY_REFERENCE_VERSION, PRODUCTION_ENTITY_RECORD_VERSION } from '../lib/production-entity-storage.mjs';
import { addEvidenceContext, currentOtherCosts, evidencePacks } from './fixtures/real-a-b-flow-fixture.mjs';
import { runRealAConfirmationToBAndC1 } from '../lib/real-a-b-c1-flow.mjs';

const KHaki = '9999999000001';
const BLACK_CP = '9999999000002';
const timestamp = '2026-09-24T12:00:00.000Z';
const bindings = [{ targetStore: 'dandanshu', storeRef: SYNTHETIC_STORE_REF }];

function fixture() {
  const parent = createInitialCandidate({
    input: { targetStore: 'dandanshu', productName: '小猫战术背心', sourceUrl: 'https://detail.1688.com/offer/9999999000003.html' },
    source: 'user', id: 'candidate:vest-parent', timestamp, storeBindings: bindings
  });
  parent.dataRevision = 12;
  parent.sourceCapture = {
    captureId: 'source-capture:vest-fixture', mode: 'a_supplier_capture', status: 'captured_waiting_owner_selection',
    sourceUrl: parent.sourceUrl, offerId: '9999999000003', title: '小猫战术背心', observedAt: timestamp,
    collectionMethod: 'synthetic_fixture', titleSource: 'page', offerIdSource: 'url', priceRanges: [], pageFields: {},
    supplierAttributes: { 材质: '牛津布' }, selectedSkuIds: [BLACK_CP, KHaki],
    skuChoices: [
      { sourceSkuId: BLACK_CP, variantName: '黑cp', attributes: { 颜色: '黑cp' }, priceCny: null, weight: null },
      { sourceSkuId: KHaki, variantName: '卡其色', attributes: { 颜色: '卡其色' }, priceCny: null, weight: null }
    ]
  };
  parent.salesSnapshotsV11 = [collectMockOzonSalesSnapshot({
    sourceMode: 'mock_ozon_fixture', snapshotId: 'sales:vest-fixture', marketScope: 'unknown', sellerType: 'unknown',
    sellerIdentityEvidence: { status: 'unverified', signals: [], evidenceRef: 'sales-identity:vest-fixture' },
    productUrl: 'https://www.ozon.ru/product/9999000004/', title: '战术背心', imageRefs: [], currentPrice: 900,
    currency: 'RUB', categoryPath: '宠物用品', attributes: {}, collectedAt: timestamp, evidenceRef: 'sales:vest-fixture'
  })];
  parent.supplierDraftV1 = {
    schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: timestamp,
    sourceUrl: parent.sourceUrl, sourceUrlType: 'detail', offerId: '9999999000003',
    goodsPriceRmb: 18, domesticShippingRmb: 0, allInPurchaseRmb: 18, packedWeightKg: 0.2,
    dimensionsCm: { length: 20, width: 15, height: 4 }, targetSalePriceRub: 900, note: null,
    provenance: 'owner_declared'
  };
  parent.skuUniformSupplyV1 = {
    schemaVersion: 'candidate-sku-uniform-supply-v1', declaredBy: 'owner', declaredAt: timestamp,
    declaredRevision: 8, captureId: parent.sourceCapture.captureId, sourceSkuIds: [BLACK_CP, KHaki],
    sourceRef: 'owner-sku-uniform-supply:vest-fixture', basisAtDeclaration: { packedWeightKg: 0.2, goodsPriceRmb: 18 }
  };
  parent.lifecycleV11 = { skuPackage: {
    supplierSkuId: KHaki, selectedSupplySnapshot: { ownerSupplyConfirmation: { status: 'confirmed' } },
    dSoftwareExecution: { checkpoints: [{ kind: 'import_task_received', taskId: '9999000005' }],
      attempt: { request: { productImport: { body: { items: [{
        description_category_id: 99000006, type_id: 92935,
        attributes: [{ id: 9048, values: [{ value: 'AL999999000007' }] },
          { id: 85, values: [{ value: 'Нет бренда' }] }]
      }] } } } } },
    productionAuthorization: { schemaVersion: PRODUCTION_ENTITY_REFERENCE_VERSION, entityId: 'parent-only',
      kind: 'production_authorization', scope: { candidateId: parent.id, skuPackageId: 'synthetic-parent-sku',
        platform: 'ozon', storeRef: structuredClone(parent.storeRef), supplierSkuId: KHaki, variantKey: '颜色:卡其色' } },
    c2FinalAssets: { productionAuthorizationPreparation: { finalUploads: [
      { sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }
    ] } }
  } };
  const ref = parent.lifecycleV11.skuPackage.productionAuthorization;
  return { candidates: [parent], productionEntityRecords: [{ schemaVersion: PRODUCTION_ENTITY_RECORD_VERSION,
    entityId: ref.entityId, kind: ref.kind, scope: structuredClone(ref.scope),
    value: { authorizationId: ref.entityId, lockedScope: { supplierSkuId: KHaki, finalUploads: [
      { sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }
    ] } } }] };
}

const input = { dataRevision: 12, supplierSkuId: BLACK_CP };

test('one selected-variant list prepares three A records and excludes the first and unselected color', () => {
  const document = fixture(), parent = document.candidates[0];
  for (const [sourceSkuId, color] of [['9999999000008', 'CP'], ['9999999000009', '黑色']]) {
    parent.sourceCapture.selectedSkuIds.push(sourceSkuId);
    parent.sourceCapture.skuChoices.push({ sourceSkuId, variantName: color, attributes: { 颜色: color }, priceCny: null, weight: null });
    parent.skuUniformSupplyV1.sourceSkuIds.push(sourceSkuId);
  }
  parent.sourceCapture.skuChoices.push({ sourceSkuId: '9999999000010', variantName: '军绿', attributes: { 颜色: '军绿' } });
  const before = structuredClone(parent);
  let next = 0;
  const run = supplierSkuIds => createSiblingSkuCandidatesBatch({ document, parentCandidateId: parent.id,
    input: { dataRevision: 12, supplierSkuIds }, nextId: () => `candidate:batch-${++next}`,
    timestamp, storeBindings: bindings });
  const selected = [BLACK_CP, '9999999000008', '9999999000009'];
  const result = run(selected);
  assert.equal(result.createdCount, 3);
  assert.deepEqual(result.candidates.map(candidate => candidate.siblingSourceV1.supplierSkuId), selected);
  assert.deepEqual(document.candidates.at(-1), before);
  assert.equal(run(selected).createdCount, 0);
  const saved = structuredClone(document);
  assert.throws(() => run([BLACK_CP, KHaki]), error => error.code === 'SIBLING_PARENT_SKU_REJECTED');
  assert.throws(() => run(['9999999000010']), error => error.code === 'SIBLING_CAPTURE_INVALID');
  assert.deepEqual(document, saved);
});
const create = (document, override = input) => createSiblingSkuCandidate({ document,
  parentCandidateId: 'candidate:vest-parent', input: override, id: 'candidate:vest-blackcp', timestamp, storeBindings: bindings });

test('blackcp starts its own A branch with one captured SKU and no inherited production state', () => {
  const document = fixture();
  const before = structuredClone(document.candidates[0]);
  const result = create(document);
  assert.equal(result.created, true);
  assert.deepEqual(document.candidates[1], before);
  const child = result.candidate;
  assert.equal(child.productName, `原商品同款：小猫战术背心 · 供应商原色 黑cp · SKU ${BLACK_CP}`);
  assert.equal(child.siblingSourceV1.supplierSkuId, BLACK_CP);
  assert.equal(child.siblingSourceV1.parentRevision, 12);
  assert.equal(child.siblingSourceV1.parentCardBinding.model, 'AL999999000007');
  assert.deepEqual(child.siblingSourceV1.parentCardBinding.parentImageSha256s,
    ['a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(before.lifecycleV11.skuPackage.productionAuthorization.lockedScope, undefined);
  assert.deepEqual(child.sourceCapture.skuChoices.map(choice => choice.sourceSkuId), [BLACK_CP]);
  assert.deepEqual(child.sourceCapture.selectedSkuIds, []);
  assert.equal(child.lifecycleV11, undefined);
  assert.equal(child.sourceCapture.jobId, null);
  assert.equal(child.salesSnapshotsV11[0].snapshotId, before.salesSnapshotsV11[0].snapshotId);
  assert.notEqual(child.salesSnapshotsV11[0], before.salesSnapshotsV11[0]);
  assert.equal(child.skuUniformSupplyV1.sourceRef, before.skuUniformSupplyV1.sourceRef);
  assert.equal(buildRealAConfirmationCard(child).supplierCapture.skuChoices.length, 1);
  assertSafeBusinessMutationCandidate(child);
});

test('final card gate requires same grouping keys and a new color main image', () => {
  const child = create(fixture()).candidate;
  child.lifecycleV11 = { skuPackage: {
    supplierSkuId: BLACK_CP,
    ozonAttributeMappingsV1: { confirmationRef: 'synthetic:owner-color', mappings: [
      { attributeId: '10096', sourceFactPath: 'productAttributes.supplierAttributes.0.fact',
        sourceFactValue: '黑cp', value: 'synthetic broad black', dictionaryValueId: 1234 },
      { attributeId: '10097', sourceFactPath: 'productAttributes.supplierAttributes.0.fact',
        sourceFactValue: '黑cp', value: 'synthetic exact black cp', dictionaryValueId: null }] },
    c1ProductPlan: {
      platformCategory: { descriptionCategoryId: { value: '99000006' }, typeId: { value: '92935' } },
      inputSnapshots: { platformSchemaRules: { attributes: [
        { fieldKey: '10096', required: false, complexId: 0, dictionaryId: 1 },
        { fieldKey: '10097', required: false, complexId: 0, dictionaryId: 0 }] } },
      productAttributes: { requiredPlatformFields: [
        { fieldKey: '9048', fact: { value: 'AL999999000007', verificationStatus: 'confirmed' } },
        { fieldKey: '85', fact: { value: { value: 'Нет бренда' }, verificationStatus: 'confirmed' } }
      ], supplierAttributes: [{ fieldKey: '颜色', fact: { value: '黑cp', verificationStatus: 'confirmed' } }],
      ozonAttributes: [{ fieldKey: '10096', sourceFactPath: 'productAttributes.supplierAttributes.0.fact',
        fact: { verificationStatus: 'confirmed', sourceRefs: ['synthetic-dictionary', 'synthetic-owner'],
          value: { value: 'synthetic broad black', dictionaryValueId: 1234 } } },
      { fieldKey: '10097', sourceFactPath: 'productAttributes.supplierAttributes.0.fact',
        fact: { verificationStatus: 'confirmed', sourceRefs: ['synthetic-owner'],
          value: 'synthetic exact black cp' } }] }
    },
    c2FinalAssets: { productionAuthorizationPreparation: { finalUploads: [
      { role: 'main_image', sha256: 'c'.repeat(64) }
    ] } }
  } };
  assert.doesNotThrow(() => assertSiblingSkuFinalCard(child));
  child.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalUploads[0].sha256 = 'a'.repeat(64);
  assert.throws(() => assertSiblingSkuFinalCard(child), /SIBLING_MAIN_IMAGE_NOT_DISTINCT/);
  child.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalUploads[0].sha256 = 'c'.repeat(64);
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.requiredPlatformFields[0].fact.value = 'wrong-model';
  assert.throws(() => assertSiblingSkuFinalCard(child), /SIBLING_CARD_GROUPING_MISMATCH/);
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.requiredPlatformFields[0].fact.value = 'AL999999000007';
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[0].fact.value.value = 'synthetic khaki';
  assert.throws(() => assertSiblingSkuFinalCard(child), /SIBLING_COLOR_BINDING_INVALID/);
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[0].fact.value.value = 'synthetic broad black';
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[1].fact.value = 'synthetic khaki';
  assert.throws(() => assertSiblingSkuFinalCard(child), /SIBLING_COLOR_BINDING_INVALID/);
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[1].fact.value = 'synthetic exact black cp';
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes.pop();
  assert.throws(() => assertSiblingSkuFinalCard(child), /SIBLING_COLOR_BINDING_INVALID/);
  child.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes.push({ fieldKey: '10097',
    sourceFactPath: 'productAttributes.supplierAttributes.0.fact', fact: { verificationStatus: 'confirmed',
      sourceRefs: ['synthetic-owner'], value: 'synthetic exact black cp' } });
  child.lifecycleV11.skuPackage.ozonAttributeMappingsV1.mappings[0].sourceFactValue = '卡其色';
  assert.throws(() => assertSiblingSkuFinalCard(child), /SIBLING_COLOR_BINDING_INVALID/);
});

test('production authorization preparation rejects a sibling grouping mismatch before any D job exists', () => {
  const fixture = productionOwnerDecisionFixture();
  const candidate = structuredClone(fixture.candidate);
  const before = structuredClone(candidate);
  candidate.siblingSourceV1 = { supplierSkuId: candidate.lifecycleV11.skuPackage.supplierSkuId,
    parentCardBinding: { descriptionCategoryId: 1, typeId: 1, model: 'different-model', brand: 'Нет бренда',
      parentImageSha256s: ['a'.repeat(64)] } };
  const view = buildProductionOwnerPreparationView({ candidate, configuration: fixture.configuration,
    evidencePacks: fixture.evidencePacks, currentCommissionCatalogs: fixture.currentCommissionCatalogs,
    observedAt: fixture.formal.at });
  assert.equal(view.ready, false);
  assert.ok(view.gaps.some(gap => gap.code === 'SIBLING_CARD_GROUPING_MISMATCH'));
  assert.throws(() => resolveProductionOwnerPreparation({ candidate, input: fixture.args.input,
    configuration: fixture.configuration, evidencePacks: fixture.evidencePacks,
    currentCommissionCatalogs: fixture.currentCommissionCatalogs, observedAt: fixture.formal.at }),
  { code: 'SIBLING_CARD_GROUPING_MISMATCH' });
  delete candidate.siblingSourceV1;
  assert.deepEqual(candidate, before);
});

test('repeated request returns the same child and never creates a second import path', () => {
  const document = fixture();
  const first = create(document);
  const serialized = JSON.stringify(document);
  const replay = create(document);
  assert.equal(first.candidate, replay.candidate);
  assert.equal(replay.created, false);
  assert.equal(JSON.stringify(document), serialized);
  assert.equal(document.candidates.length, 2);
  for (const changed of [{ ...input, productName: '另一名称' }, { ...input, dataRevision: 11 }]) {
    assert.throws(() => create(document, changed), { code: 'SIBLING_REPLAY_CONFLICT' });
    assert.equal(JSON.stringify(document), serialized);
  }
});

test('internal sibling label comes only from the captured colour and rejects invalid old source values', () => {
  assert.equal(siblingSkuCandidateName({ productName: '小猫战术背心' },
    { sourceSkuId: BLACK_CP, attributes: { 颜色: ' 黑cp ' } }),
    `原商品同款：小猫战术背心 · 供应商原色 黑cp · SKU ${BLACK_CP}`);
  for (const color of ['', ' ', '黑cp\n', '<script>', 'https://example.test/private', 'token=private', 'x'.repeat(121)]) {
    const document = fixture();
    document.candidates[0].sourceCapture.skuChoices[0].attributes.颜色 = color;
    const before = JSON.stringify(document);
    assert.throws(() => create(document), { code: 'SIBLING_NAME_SOURCE_INVALID' });
    assert.equal(JSON.stringify(document), before);
  }
  const document = fixture();
  assert.throws(() => create(document, { ...input, productName: '卡其色背心' }),
    { code: 'SIBLING_NAME_CONFLICT' });
  assert.equal(document.candidates.length, 1);
  const unsafeParent = fixture();
  unsafeParent.candidates[0].productName = 'https://example.test/private';
  assert.throws(() => create(unsafeParent), { code: 'SIBLING_NAME_SOURCE_INVALID' });
  assert.equal(unsafeParent.candidates.length, 1);
});

test('newer provider snapshot preserves older real page category evidence for B', () => {
  const document = fixture();
  const real = collectRealOzonSalesSnapshot({ sourceMode: 'real_ozon_page_observation', technicalStatus: 'completed',
    snapshotId: 'sales:real-category', marketScope: 'ozon_general_market', sellerIdentitySignals: [],
    sellerIdentityEvidenceRef: 'synthetic:seller', productUrl: 'https://www.ozon.ru/product/9999000004/',
    title: '战术背心', imageRefs: [], currentPrice: 900, currency: 'RUB', categoryPath: '宠物用品 > 背心',
    attributes: {}, collectedAt: '2026-09-23T12:00:00.000Z', evidenceRef: 'synthetic:real-page' });
  const provider = buildDiscoveryMarketSalesSnapshot({ product: { productId: '9999000004',
    providerRecordRef: 'synthetic:provider-row', productUrl: 'https://www.ozon.ru/product/9999000004/',
    title: '战术背心', imageUrl: null, price: 900, salesCount: 20, revenue: 18000,
    reviewCount: 2, reviewRating: 4.5, categoryPath: { cnTitlePath: '宠物用品 > 背心' } },
  receipt: { receiptId: 'synthetic:provider-receipt', completedAt: '2026-09-24T12:00:00.000Z' } });
  document.candidates[0].salesSnapshotsV11 = [real, provider];
  const child = create(document).candidate;
  assert.deepEqual(child.salesSnapshotsV11.map(snapshot => snapshot.snapshotId), [real.snapshotId, provider.snapshotId]);
  assert.equal(child.siblingSourceV1.salesSnapshotId, provider.snapshotId);
  assert.notEqual(child.salesSnapshotsV11[0], real);
});

test('blackcp child enters the normal owner A confirmation and frozen independent SKU lifecycle', () => {
  const document = fixture();
  const parent = structuredClone(document.candidates[0]);
  const child = addEvidenceContext(create(document).candidate);
  child.packagingCostRmb = 1.5; // Synthetic per-SKU owner cost input; the sibling does not inherit the parent's B conclusion.
  const category = 'synthetic:pet-vest';
  child.lifecycleEvidenceContextV11.category = category;
  const packs = evidencePacks().map(pack => ({ ...pack,
    checkedAt: '2026-09-23T12:00:00.000Z', expiresAt: '2026-09-25T12:00:00.000Z',
    scope: pack.kind === 'commission' || pack.kind === 'schema' ? { ...pack.scope, category } : pack.scope }));
  const card = buildRealAConfirmationCard(child);
  const chosen = card.supplierCapture.skuChoices[0];
  const submission = { decision: 'confirm', dataRevision: child.dataRevision,
    sourceCandidateId: child.id, sourceDataRevision: child.dataRevision, targetPlatform: card.targetPlatform,
    storeRef: structuredClone(child.storeRef),
    salesReview: { snapshotId: card.salesReview.snapshotId, comparability: 'comparable', validityStatus: 'current', confidence: 'limited' },
    supplierConfirmation: { captureId: child.sourceCapture.captureId, productUrl: child.sourceUrl,
      supplierSkuId: BLACK_CP, variantKey: chosen.variantKey, minimumOrderQuantity: 1, matchType: 'exact_match',
      quantityOneEvidenceSourceNote: 'Synthetic owner checked quantity one and this SKU price in the fixture.',
      unitProductPrice: 18, unitDomesticFreight: 0, otherPurchaseCosts: 0, actualPurchaseCost: 18,
      weightKg: 0.2, dimensionsCm: { length: 20, width: 15, height: 4 }, ownerSupplyConfirmed: true } };
  const before = structuredClone(child);
  const result = runRealAConfirmationToBAndC1({ candidate: child, submission, evidencePacks: packs,
    otherCosts: currentOtherCosts(child), confirmedAt: '2026-09-24T12:00:00.000Z' });
  assert.equal(result.ownerSupplyConfirmation.status, 'confirmed');
  assert.equal(result.skuPackage.supplierSkuId, BLACK_CP);
  assert.equal(result.skuPackage.selectedSupplySnapshot.supplierSku.attributes.颜色, '黑cp');
  assert.equal(result.profitModel.result, 'passed');
  assert.equal(result.skuPackage.businessPhase, 'C1');
  assert.equal(result.c1Handoff.supplierSkuId, BLACK_CP);
  assert.equal(result.c1Handoff.trigger, 'b_passed_auto_c1');
  assert.equal(result.skuPackage.g1Identity.candidateId, child.id);
  assert.deepEqual(result.skuPackage.g1Identity.storeRef, child.storeRef);
  assert.notEqual(result.skuPackage.skuPackageId, parent.lifecycleV11.skuPackage.skuPackageId);
  assert.equal(result.platformWrites, 0);
  assert.deepEqual(result.externalAccesses, []);
  assert.deepEqual(child, before);
  assert.deepEqual(document.candidates[1], parent);
});

test('khaki and stale or missing source evidence fail before any candidate write', () => {
  for (const variant of ['parent-sku', 'stale', 'missing-declaration', 'changed-price', 'changed-weight', 'no-import', 'wrong-store', 'wrong-capture', 'missing-frozen-assets', 'missing-authorization-record', 'wrong-authorization-scope', 'changed-authorized-image']) {
    const document = fixture();
    const before = structuredClone(document);
    let request = input;
    if (variant === 'parent-sku') request = { ...input, supplierSkuId: KHaki };
    if (variant === 'stale') request = { ...input, dataRevision: 11 };
    if (variant === 'missing-declaration') delete document.candidates[0].skuUniformSupplyV1;
    if (variant === 'changed-price') document.candidates[0].supplierDraftV1.goodsPriceRmb = 19;
    if (variant === 'changed-weight') document.candidates[0].supplierDraftV1.packedWeightKg = 0.3;
    if (variant === 'no-import') document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.checkpoints = [];
    if (variant === 'wrong-store') document.candidates[0].storeRef.platformStoreId = 'another-store';
    if (variant === 'wrong-capture') document.candidates[0].sourceCapture.offerId = 'another-offer';
    if (variant === 'missing-frozen-assets') delete document.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation;
    if (variant === 'missing-authorization-record') document.productionEntityRecords = [];
    if (variant === 'wrong-authorization-scope') document.productionEntityRecords[0].scope.candidateId = 'other-candidate';
    if (variant === 'changed-authorized-image') document.productionEntityRecords[0].value.lockedScope.finalUploads[0].sha256 = 'c'.repeat(64);
    const prepared = structuredClone(document);
    assert.throws(() => create(document, request), { name: 'SiblingSkuCandidateError' }, variant);
    assert.deepEqual(document, prepared, variant);
    if (variant === 'parent-sku' || variant === 'stale') assert.deepEqual(document, before);
  }
});
