import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfirmedSupplierTextReferences } from '../lib/confirmed-supplier-inputs.mjs';
import { createFormalC1C2Fixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { createAProductDetailCandidateFixture } from './fixtures/a-product-detail-evidence-fixture.mjs';
import { runRealAConfirmationToBAndC1 } from '../lib/real-a-b-c1-flow.mjs';
import { currentOtherCosts, evidencePacks } from './fixtures/real-a-b-flow-fixture.mjs';

function browserCandidate() {
  const candidate = structuredClone(createFormalC1C2Fixture().candidate);
  candidate.targetPlatform = 'ozon';
  const sku = candidate.lifecycleV11.skuPackage, supply = sku.selectedSupplySnapshot;
  supply.supplierSku.attributes.quantityOneEvidence = { captureId: 'capture:text-fixture' };
  Object.assign(supply.supplierSku.attributes, { 面料: '合成测试面料', 颜色: '黑色,卡其色', 品牌: 'Supplier Fixture Brand', 有可授权的自有品牌: '否' });
  candidate.sourceCapture = { captureId: 'capture:text-fixture', offerId: supply.supplierOption.offerId,
    sourceUrl: supply.supplierOption.productUrl, observedAt: '2026-08-12T12:00:00.000Z',
    title: '合成迷你收纳袋装饰用品', titleSource: 'offerDetail.subject',
    skuChoices: [{ sourceSkuId: sku.supplierSkuId, propPath: sku.variantKey, attributes: { 颜色: '卡其色', 尺码: '均码' } }],
    skuSelection: { selectedBy: 'owner', selectedSkuIds: [sku.supplierSkuId] }, supplierAttributes: { 面料: '未冻结的错误面料' } };
  return candidate;
}
async function apiCandidate() {
  const f = await createAProductDetailCandidateFixture();
  const packs = evidencePacks().map(value => ({ ...value, checkedAt: '2026-09-08T12:00:00.000Z', expiresAt: '2026-09-09T12:00:00.000Z' }));
  const result = runRealAConfirmationToBAndC1({ candidate: f.candidate, otherCosts: currentOtherCosts(f.candidate),
    submission: f.input, evidencePacks: packs, confirmedAt: '2026-09-08T12:00:00.000Z' });
  const candidate = structuredClone(f.candidate);
  candidate.lifecycleV11 = { skuPackage: structuredClone(result.skuPackage) };
  candidate.targetPlatform = 'ozon';
  return candidate;
}
const isDomainError = error => error instanceof Error && !(error instanceof TypeError) && /CONFIRMED_|CANDIDATE_EVIDENCE_|LINKFOX_/.test(error.message);

test('exact confirmed supplier wording is reference only, frozen attributes override current product lists, and input is unchanged', () => {
  const candidate = browserCandidate(), before = structuredClone(candidate);
  const result = readConfirmedSupplierTextReferences(candidate);
  assert.deepEqual(result.find(row => row.kind === 'supplier_title'), { kind: 'supplier_title', text: candidate.sourceCapture.title, sourceRef: 'capture:text-fixture#/title' });
  assert.deepEqual(result.filter(row => row.text.startsWith('颜色：')).map(row => row.text), ['颜色：卡其色']);
  assert.ok(result.some(row => row.kind === 'supplier_attribute' && row.text === '面料：合成测试面料'));
  assert.equal(result.some(row => /错误面料|Supplier Fixture Brand|有可授权的自有品牌/.test(row.text)), false);
  assert.ok(result.every(row => Object.keys(row).sort().join(',') === 'kind,sourceRef,text'));
  assert.deepEqual(candidate, before);
  result[0].text = 'changed returned projection';
  assert.deepEqual(candidate, before);
});

test('absent capture is not provided, absent title keeps exact SKU references', () => {
  const absent = browserCandidate(); delete absent.sourceCapture;
  assert.deepEqual(readConfirmedSupplierTextReferences(absent), []);
  for (const value of [undefined, null, '']) {
    const candidate = browserCandidate(); candidate.sourceCapture.title = value;
    const references = readConfirmedSupplierTextReferences(candidate);
    assert.equal(references.some(row => row.kind === 'supplier_title'), false);
    assert.equal(references.some(row => row.kind === 'supplier_variant_attribute'), true);
  }
});

test('wrong offer, URL, owner option, capture, SKU, variant, duplicate SKU and unsigned owner selection fail explicitly', () => {
  for (const change of [c => c.sourceCapture.offerId = '999999', c => c.sourceCapture.sourceUrl = 'https://detail.1688.com/offer/999999.html',
    c => c.lifecycleV11.skuPackage.selectedSupplySnapshot.ownerSupplyConfirmation.supplierOptionId = 'supplier:foreign',
    c => c.sourceCapture.captureId = 'capture:foreign', c => c.sourceCapture.skuChoices[0].sourceSkuId = 'foreign',
    c => c.sourceCapture.skuChoices[0].propPath = 'foreign', c => c.sourceCapture.skuChoices.push(structuredClone(c.sourceCapture.skuChoices[0])),
    c => c.sourceCapture.skuSelection.selectedBy = 'software', c => c.lifecycleV11.skuPackage.g1Identity.storeRef.stableStoreId = 'foreign']) {
    const candidate = browserCandidate(); change(candidate);
    assert.throws(() => readConfirmedSupplierTextReferences(candidate), isDomainError);
  }
});

test('declared capture without its SKU collection is a source error, not not-provided', () => {
  const candidate = browserCandidate(); delete candidate.sourceCapture.skuChoices;
  assert.throws(() => readConfirmedSupplierTextReferences(candidate), isDomainError);
});

test('declared source without supplier option fails as a domain error', () => {
  const candidate = browserCandidate(); delete candidate.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierOption;
  assert.throws(() => readConfirmedSupplierTextReferences(candidate), isDomainError);
});

test('malformed title and missing declared title provenance fail', () => {
  for (const change of [c => c.sourceCapture.title = {}, c => c.sourceCapture.title = '   ', c => delete c.sourceCapture.titleSource]) {
    const candidate = browserCandidate(); change(candidate);
    assert.throws(() => readConfirmedSupplierTextReferences(candidate), isDomainError);
  }
});

test('attribute references resolve the original Unicode, slash and tilde keys as JSON Pointers', () => {
  const candidate = browserCandidate(), key = '颜色/尺寸~俄文';
  candidate.sourceCapture.skuChoices[0].attributes[key] = '卡其';
  candidate.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes['说明/材质~'] = '测试';
  const references = readConfirmedSupplierTextReferences(candidate);
  for (const [row, source] of [[references.find(row => row.text === key + '：卡其'), candidate.sourceCapture],
    [references.find(row => row.text === '说明/材质~：测试'), candidate.lifecycleV11.skuPackage.selectedSupplySnapshot]]) {
    const pointer = row.sourceRef.split('#')[1];
    const resolved = decodeURIComponent(pointer).slice(1).split('/').map(part => part.replaceAll('~1','/').replaceAll('~0','~')).reduce((node, part) => node?.[part], source);
    assert.equal(resolved, row.text.split('：')[1]);
  }
});

test('API normalized title is read from the verified receipt and an unrelated browser title is never substituted', async () => {
  const candidate = await apiCandidate(); candidate.sourceCapture = browserCandidate().sourceCapture;
  const before = structuredClone(candidate), references = readConfirmedSupplierTextReferences(candidate);
  assert.deepEqual(references.filter(row => row.kind === 'supplier_title').map(row => row.text), ['合成桌面收纳']);
  assert.equal(references.some(row => row.kind === 'supplier_description'), false);
  assert.equal(references.some(row => row.kind === 'supplier_variant_attribute'), false, 'normalized API contract has unknown SKU attributes');
  assert.equal(references.find(row => row.kind === 'supplier_title').sourceRef, candidate.aProductDetailEvidenceV1.supplierReceiptRef + '#/steps/0/result/facts/title');
  assert.deepEqual(candidate, before);
});

test('API missing required title and invented description violate the actual normalized contract', async () => {
  for (const change of [facts => delete facts.title, facts => facts.description = 'unsupported provider field', facts => facts.skus[0].attributes = { 颜色: 'invented' }]) {
    const candidate = await apiCandidate(); change(candidate.aProductDetailEvidenceV1.supplierResult.facts);
    assert.throws(() => readConfirmedSupplierTextReferences(candidate), isDomainError);
  }
});


test('API frozen receipt, offer and URL must match; browser evidence cannot replace the declared API chain', async () => {
  for (const change of [c => c.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierOption.evidenceRef = 'receipt:foreign',
    c => c.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierOption.offerId = '999999',
    c => c.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierOption.productUrl = 'https://detail.1688.com/offer/999999.html']) {
    const candidate = await apiCandidate();
    assert.equal(typeof candidate.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierOption.evidenceRef, 'string');
    candidate.sourceCapture = browserCandidate().sourceCapture;
    change(candidate);
    assert.throws(() => readConfirmedSupplierTextReferences(candidate), isDomainError);
  }
});
