import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { commitSiblingBatchABAndC1 } from '../lib/sibling-batch-a-b-c1.mjs';
import { candidate, addEvidenceContext, confirmedAt, currentCostRule, evidencePacks } from './fixtures/real-a-b-flow-fixture.mjs';
import { buildOwnerSkuUniformSupplyRecord } from '../lib/sku-choice-estimate.mjs';

const guooFilePath = '/synthetic/GUOO-2026.7.20.xlsx';

async function fixture() {
  const base = addEvidenceContext(await candidate());
  const parent = structuredClone(base);
  parent.id = 'candidate:synthetic-parent';
  parent.lifecycleV11 = { skuPackage: { supplierSkuId: '6222816678021', technicalStatus: 'unknown_outcome' } };
  const ids = ['6222816678023', '6222816678020'];
  parent.sourceCapture = { captureId: 'synthetic:one-capture', mode: 'a_supplier_capture',
    status: 'captured_waiting_owner_selection', sourceUrl: base.sourceCapture.sourceUrl,
    offerId: base.sourceCapture.offerId, observedAt: confirmedAt,
    selectedSkuIds: ['6222816678021', ...ids],
    skuChoices: ids.map((sourceSkuId, index) => ({ sourceSkuId, variantName: `颜色 ${index}`,
      attributes: { 颜色: `颜色 ${index}` }, priceCny: null, weight: null })) };
  const children = ids.map((sourceSkuId, index) => {
    const child = structuredClone(base);
    child.id = `candidate:synthetic-${index}`;
    child.siblingSourceV1 = { parentCandidateId: parent.id, supplierSkuId: sourceSkuId };
    child.sourceCapture = { ...structuredClone(parent.sourceCapture), selectedSkuIds: [],
      skuChoices: [structuredClone(parent.sourceCapture.skuChoices[index])] };
    child.packagingCostRmb = 1.5;
    return child;
  });
  const document = initialBusinessStateDocument({ now: confirmedAt });
  document.candidates = [parent, ...children];
  document.evidencePacks = evidencePacks();
  document.rules.ozonDandanshu = currentCostRule(children[0]);
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'batch-a', actorType: 'human',
    roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: confirmedAt });
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    shared: { salesReview: { snapshotId: base.salesSnapshotsV11[0].snapshotId,
      comparability: 'comparable', validityStatus: 'current', confidence: 'limited' },
    targetSalePriceRub: 900, unitDomesticFreight: 2, otherPurchaseCosts: 0,
    packagingCostRmb: 1.5,
    route: 'guoo-economy-small', confirmExactSkuSupply: true, confirmSalesReview: true,
    minimumOrderQuantity: 1, quantityOneEvidenceSourceNote: '合成测试：两种颜色都按一件起订核对',
    dimensionsCm: { length: 12, width: 12, height: 7 } },
    members: children.map((child, index) => ({ candidateId: child.id,
      candidateRevision: child.dataRevision, sourceSkuId: child.siblingSourceV1.supplierSkuId, unitProductPrice: 15.3 + index,
      weightKg: 0.4, merchantSku: `SYNTHETIC-VEST-${index}`, stock: 20 + index,
      targetSalePriceRub: null })) };
  return { repository, actor, input, parent, children };
}

test('one owner submission computes distinct formal B and C1 records in one transaction', async () => {
  const { repository, actor, input, parent } = await fixture();
  const result = await commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => confirmedAt, guooFilePath });
  assert.equal(result.members.length, 2);
  assert.equal(new Set(result.members.map(member => member.c1HandoffId)).size, 2);
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.candidates[0], parent);
  assert.equal(saved.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.businessPhase === 'C1'), true);
  assert.equal(saved.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.productionAuthorization === null), true);
  assert.deepEqual(saved.candidates.slice(1).map(child => child.lifecycleV11.productionCommercialDraftV1.stock), [20, 21]);
  assert.equal(result.platformWrites, 0);
});

test('a stale member, duplicate submission or cost gap saves no partial lifecycle', async () => {
  for (const mutate of [
    input => { input.members[1].candidateId = input.members[0].candidateId; },
    input => { input.shared.minimumOrderQuantity = 2; },
    input => { input.parentRevision += 1; },
    input => { input.members[1].candidateRevision += 1; }
  ]) {
    const { repository, actor, input } = await fixture();
    mutate(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor,
      input, serverClock: () => confirmedAt, guooFilePath }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
  const { repository, actor, input } = await fixture();
  await repository.transact(document => {
    document.candidates[2].sourceCapture.skuChoices[0].priceCny = 99;
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => confirmedAt, guooFilePath }), /REAL_A_CONFIRMATION_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

async function reuseFixture() {
  const f=await fixture();
  await f.repository.transact(document=>{
    const parent=document.candidates[0];
    parent.sourceCapture.priceRanges=[{minimumQuantity:1,priceCny:18,source:'synthetic:one-piece-quote'}];
    parent.supplierDraftV1={offerId:parent.sourceCapture.offerId,goodsPriceRmb:18,domesticShippingRmb:2,allInPurchaseRmb:20,packedWeightKg:0.4};
    parent.skuUniformSupplyV1=buildOwnerSkuUniformSupplyRecord({candidate:parent,declaredAt:confirmedAt});
    parent.lifecycleV11.skuPackage.selectedSupplySnapshot={snapshotId:'synthetic:original-color-cost',ownerSupplyConfirmation:{status:'confirmed'},
      supplierOption:{offerId:parent.sourceCapture.offerId},supplierSku:{supplierSkuId:'6222816678021',attributes:{quantityOneEvidence:{captureId:parent.sourceCapture.captureId},purchaseCostComponents:{unitProductPrice:18,unitDomesticFreight:2,otherPurchaseCosts:0,actualPurchaseCost:20,currency:'CNY'}}}};
    for(const child of document.candidates.slice(1))delete child.targetPlatform;
    return {changed:true,document,result:null};
  });
  f.input.shared.reusePriorSupply=true;
  for(const member of f.input.members)member.unitProductPrice=18;
  return f;
}

test('one confirmation with no extra items creates independent A/B/C1 from captured quotes and fills only successfully confirmed legacy platforms',async()=>{
  const f=await reuseFixture(),before=await f.repository.readSnapshot();
  const result=await commitSiblingBatchABAndC1({...f,runtimeMode:'local_development',serverClock:()=>confirmedAt,guooFilePath});
  assert.equal(result.members.length,2);assert.equal(result.platformWrites,0);
  const saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates[0],before.candidates[0]);
  for(const child of saved.candidates.slice(1)){
    assert.equal(child.targetPlatform,'ozon');assert.equal(child.lifecycleV11.skuPackage.businessPhase,'C1');
    const reuse=child.lifecycleV11.aSiblingSupplyReuseV1;
    assert.equal(reuse.costDecision,'reuse_confirmed_cost_no_additions');assert.equal(reuse.otherPurchaseCosts,0);
    assert.equal(reuse.costSourceRef,'synthetic:original-color-cost');
    const evidence=child.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.quantityOneEvidence;
    assert.equal(evidence.supplierSkuId,child.siblingSourceV1.supplierSkuId);assert.match(evidence.sourceNote,/synthetic:one-piece-quote/);
    assert.equal(child.lifecycleV11.skuPackage.productionAuthorization,null);
  }
});

test('missing offer MOQ, explicit platform conflict or invalid B leaves legacy fields and all lifecycles unchanged',async()=>{
  for(const change of [document=>{document.candidates[0].sourceCapture.priceRanges=[];},
    document=>{document.candidates[1].targetPlatform=null;},
    document=>{document.candidates[1].sourceCapture.skuChoices[0].priceCny=99;}
  ]){
    const f=await reuseFixture();await f.repository.transact(document=>{change(document);return {changed:true,document,result:null};});
    const before=await f.repository.readSnapshot();await assert.rejects(()=>commitSiblingBatchABAndC1({...f,runtimeMode:'local_development',serverClock:()=>confirmedAt,guooFilePath}));
    assert.deepEqual(await f.repository.readSnapshot(),before);
  }
});

test('an explicit extra-cost revision is counted once in the new child confirmation and preserves original costs',async()=>{
  const f=await reuseFixture(),before=await f.repository.readSnapshot();f.input.shared.otherPurchaseCosts=3;
  await commitSiblingBatchABAndC1({...f,runtimeMode:'local_development',serverClock:()=>confirmedAt,guooFilePath});
  const saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates[0],before.candidates[0]);
  for(const child of saved.candidates.slice(1)){
    const cost=child.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.purchaseCostComponents;
    assert.equal(cost.otherPurchaseCosts,3);assert.equal(cost.actualPurchaseCost,23);
    assert.equal(child.lifecycleV11.aSiblingSupplyReuseV1.costDecision,'owner_explicit_cost_revision');
  }
});
