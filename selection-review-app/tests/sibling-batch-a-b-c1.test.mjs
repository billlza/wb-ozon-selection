import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { commitSiblingBatchABAndC1, prepareSiblingBatchEvidence } from '../lib/sibling-batch-a-b-c1.mjs';
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

// The vest run (2026-10-11): colours built from a parent whose own A froze its category to the Ozon card's ids.
const FAMILY_CATEGORY = 'ozon:17028966:96063';
async function familyFixture({ binding = { descriptionCategoryId: 17028966, typeId: 96063 } } = {}) {
  const f = await fixture();
  await f.repository.transact(document => {
    document.candidates[0].lifecycleEvidenceContextV11.category = FAMILY_CATEGORY;
    for (const child of document.candidates.slice(1)) {
      delete child.lifecycleEvidenceContextV11;
      child.siblingSourceV1.parentCardBinding = structuredClone(binding);
    }
    // Freight and exchange evidence is on file; nothing yet for fees or schema under the family's category.
    document.evidencePacks = document.evidencePacks.filter(pack => !['commission', 'schema'].includes(pack.kind));
    return { changed: true, document, result: null };
  });
  const calls = [];
  const providers = Object.fromEntries(['commission', 'logistics_tariff', 'exchange_rate', 'schema'].map(kind => [kind, async request => {
    calls.push([kind, request.candidateId, request.scope.category ?? null]);
    const source = evidencePacks().find(pack => pack.kind === kind);
    return { ...structuredClone(source), id: `synthetic:${kind}:${request.candidateId}`, scope: request.scope,
      checkedAt: confirmedAt, expiresAt: '2026-08-19T02:00:00.000Z', sourceType: 'isolated_test', sourceRef: `fixture:batch:${kind}`,
      evidenceData: { ...structuredClone(source.evidenceData),
        ...(['commission', 'schema'].includes(kind) ? { descriptionCategoryId: 17028966, typeId: 96063 } : {}) } };
  }]));
  const prepare = document => prepareSiblingBatchEvidence({ document, actor: f.actor, input: f.input, providers,
    serverClock: () => confirmedAt, guooFilePath });
  const commit = preparedEvidence => commitSiblingBatchABAndC1({ ...f, runtimeMode: 'local_development',
    serverClock: () => confirmedAt, guooFilePath, preparedEvidence });
  return { ...f, calls, prepare, commit };
}

test('each colour reads its own fee and schema evidence under the parent card category before the one save', async () => {
  const f = await familyFixture();
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => f.commit(null), /REAL_A_SYSTEM_EVIDENCE_GAP/);
  assert.deepEqual(await f.repository.readSnapshot(), before);

  const prepared = await f.prepare(await f.repository.readSnapshot());
  const [first, second] = f.children.map(child => child.id);
  assert.deepEqual(f.calls, [['commission', first, FAMILY_CATEGORY], ['schema', first, FAMILY_CATEGORY]],
    'the second colour reuses what the first one read; freight and exchange evidence on file is reused');
  assert.deepEqual(await f.repository.readSnapshot(), before, 'reading evidence saves nothing');

  const result = await f.commit(prepared);
  assert.deepEqual([result.members.length, result.externalRequests, result.platformWrites], [2, 2, 0]);
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.candidates[0], before.candidates[0]);
  for (const child of saved.candidates.slice(1)) {
    assert.equal(child.lifecycleEvidenceContextV11.category, FAMILY_CATEGORY);
    assert.equal(child.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence.evidenceId, `synthetic:commission:${first}`);
  }
  assert.deepEqual(saved.candidates.slice(1).map(child => child.lifecycleV11.externalAccesses.length), [2, 0]);
  const filed = saved.evidencePacks.filter(pack => pack.createdBy === 'sibling_batch_a_confirmation_system_evidence');
  assert.deepEqual(filed.map(pack => pack.id).sort(), [`synthetic:commission:${first}`, `synthetic:schema:${first}`]);
  assert.equal(second, saved.candidates[2].id);
});

test('evidence filed after the read, a provider gap or a colour outside the parent card saves nothing', async () => {
  const changed = await familyFixture();
  const prepared = await changed.prepare(await changed.repository.readSnapshot());
  await changed.repository.transact(document => {
    document.evidencePacks.push({ ...structuredClone(document.evidencePacks[0]), id: 'synthetic:filed-meanwhile' });
    return { changed: true, document, result: null };
  });
  const beforeChanged = await changed.repository.readSnapshot();
  await assert.rejects(() => changed.commit(prepared), /SIBLING_BATCH_A_EVIDENCE_CHANGED/);
  assert.deepEqual(await changed.repository.readSnapshot(), beforeChanged);

  const gap = await familyFixture();
  const document = await gap.repository.readSnapshot();
  const failing = await prepareSiblingBatchEvidence({ document, actor: gap.actor, input: gap.input, serverClock: () => confirmedAt, guooFilePath,
    providers: { commission: async () => { throw new Error('synthetic: fee service unavailable'); } } }).then(() => null, error => error);
  assert.deepEqual([failing?.code, failing?.candidateId, failing?.externalRequests], ['SIBLING_BATCH_A_EVIDENCE_BLOCKED', gap.children[0].id, 1]);
  assert.match(failing.message, /fee service unavailable/);

  const outside = await familyFixture({ binding: { descriptionCategoryId: 17028966, typeId: 1 } });
  const outsideDocument = await outside.repository.readSnapshot();
  await assert.rejects(() => outside.prepare(outsideDocument), /SIBLING_BATCH_A_CATEGORY_CONFLICT/);
  assert.deepEqual(outside.calls, []);

  const stale = await familyFixture();
  stale.input.members[1].candidateRevision += 1;
  const staleDocument = await stale.repository.readSnapshot();
  await assert.rejects(() => stale.prepare(staleDocument), /SIBLING_BATCH_A_MEMBER_CONFLICT/);
  assert.deepEqual(stale.calls, [], 'a stale row stops the batch before any read');
});

test('colours created before the family rule are still judged and saved on the parent frozen snapshot', async () => {
  const f = await fixture();
  let older, newer;
  await f.repository.transact(document => {
    const [parent, ...children] = document.candidates;
    older = structuredClone(parent.salesSnapshotsV11[0]);
    newer = { ...structuredClone(older), snapshotId: 'sales:synthetic-newer-copy', currentPrice: 475,
      collectedAt: new Date(Date.parse(older.collectedAt) + 86_400_000).toISOString() };
    parent.salesSnapshotsV11 = [older, newer];
    parent.lifecycleV11.opportunityPackage = { salesSnapshots: [structuredClone(older)] };
    parent.lifecycleV11.skuPackage.inheritedSalesSnapshotRefs = [older.snapshotId];
    for (const child of children) {
      child.salesSnapshotsV11 = [structuredClone(older), structuredClone(newer)];
      child.siblingSourceV1.salesSnapshotId = newer.snapshotId; // what creation used to record: the newest copy
    }
    return { changed: true, document, result: null };
  });
  const run = input => commitSiblingBatchABAndC1({ ...f, input, runtimeMode: 'local_development', serverClock: () => confirmedAt, guooFilePath });
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => run({ ...f.input, shared: { ...f.input.shared,
    salesReview: { ...f.input.shared.salesReview, snapshotId: newer.snapshotId } } }), /REAL_A_CONFIRMATION_INVALID/);
  assert.deepEqual(await f.repository.readSnapshot(), before);

  await run(f.input);
  for (const child of (await f.repository.readSnapshot()).candidates.slice(1)) {
    assert.equal(child.siblingSourceV1.salesSnapshotId, older.snapshotId);
    assert.deepEqual(child.lifecycleV11.opportunityPackage.salesSnapshots.map(snapshot => snapshot.snapshotId), [older.snapshotId]);
  }
});
