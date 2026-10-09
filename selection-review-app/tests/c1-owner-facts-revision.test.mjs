import test from 'node:test';
import assert from 'node:assert/strict';
import { finalPricingC1ReuseFixture } from './fixtures/final-pricing-c1-reuse-fixture.mjs';
import { createSavedLocalPreparationCandidate } from './fixtures/c1-local-draft-source-fixture.mjs';
import { c1DraftPaidReceipt } from './fixtures/c1-draft-source-fixture.mjs';
import { authorizedExecution, settledExecution } from './fixtures/c1-ai-draft-fixture.mjs';
import { mergeC1AiDraftReceipt, validateC1AiDraftRequest } from '../lib/c1-ai-draft-contract.mjs';
import { createC2SoftwareContainer } from '../lib/c2-software-orchestrator.mjs';
import { finalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { prepareC1FinalPlanRevision } from '../lib/c1-final-plan-revision-preparation.mjs';
import { prepareOwnerProductFacts, OWNER_PRODUCT_FACT_LABELS } from '../lib/owner-product-facts.mjs';
import { assertValidC1ProductPlan } from '../lib/c1-product-plan.mjs';
import { produceC1LocalPreparation } from '../lib/c1-keyword-planning-local-material.mjs';
import { prepareC1LocalDraftSource } from '../lib/c1-local-draft-source.mjs';
import { prepareCurrentC1AiDraftRequest, assertCurrentC1AiDraftRequestSources } from '../lib/c1-ai-draft-request-source.mjs';
import { resolveC1SupplierFactRevision } from '../lib/confirmed-supplier-inputs.mjs';

const at = '2026-08-22T02:04:00.000Z';
const facts = { productForm: '迷你背心', intendedUses: ['猫', '酒瓶'], closureType: '魔术贴', adjustable: true, detachable: null };
function fixture({ cargo = true, local = false } = {}) {
  let candidate;
  if (local) {
    const prepared = localRequest(createSavedLocalPreparationCandidate({at}));
    candidate = prepared.candidate;
    const request = prepared.request, execution = authorizedExecution(request, candidate.dataRevision);
    const receipt = c1DraftPaidReceipt({request, authorizedExecution:execution},at);
    const merged = mergeC1AiDraftReceipt({skuPackage:candidate.lifecycleV11.skuPackage,request,receipt,settledExecution:settledExecution(request,receipt,execution),mergedAt:at});
    candidate.lifecycleV11.skuPackage = structuredClone(createC2SoftwareContainer({skuPackage:merged.skuPackage,expectedDataRevision:merged.skuPackage.dataRevision,assetRegions:{collected:[],aiDrafts:[],finalUploads:[]},createdAt:at}).skuPackage);
    delete candidate.sourceCapture;
  } else candidate = finalPricingC1ReuseFixture().document.candidates[0];
  candidate.targetPlatform = 'ozon';
  const sku = candidate.lifecycleV11.skuPackage;
  const assets = Array.from({length:15}, (_, index) => ({ ...structuredClone(finalAssets()[index === 0 ? 0 : 1]),
    assetId: `final:owner-facts:synthetic:${index+1}`, assetRef: `https://assets.example.com/owner/facts-${index+1}.jpg`,
    sha256: (index+1).toString(16).padStart(64,'0'), order:index+1 }));
  const manifest = prepareC2FinalUploadManifest({ skuPackage:sku, expectedDataRevision:sku.dataRevision, finalUploadAssets:assets, preparedAt:at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage:sku, expectedDataRevision:sku.dataRevision, finalManifest:manifest, ownerDecision:ownerDecision(manifest), confirmedAt:at });
  candidate.lifecycleV11.skuPackage = structuredClone(createFinalProductPlanConfirmationCard({ skuPackage:confirmed.skuPackage, createdAt:at }).skuPackage);
  if (cargo) candidate.cargoFactsV1 = { schemaVersion:'candidate-cargo-facts-v1', declaredBy:'owner', declaredRevision:candidate.dataRevision, declaredAt:at,
    facts:{batteryType:'none',batteryEnergyWh:null,generalCargo:true,personalUse:true,irregularShape:false,sourceRef:`owner-cargo-facts:${candidate.id}:${candidate.dataRevision}:${at}`} };
  return candidate;
}
function declared(source = fixture()) {
  return prepareOwnerProductFacts({candidate:source,facts,confirmedByUserId:'synthetic:owner-facts-test',confirmedAt:at});
}
function revised(source = fixture()) {
  const saved = declared(source);
  return { saved, ...prepareC1FinalPlanRevision({candidate:saved.candidate,expectedRevision:saved.candidate.dataRevision,preparedAt:at}) };
}
function localRequest(candidate) {
  const current = structuredClone(candidate);
  const produced = produceC1LocalPreparation({candidate:current,expectedRevision:current.dataRevision,producedAt:at});
  assert.equal(produced.status,'ready',JSON.stringify(produced.production.gaps));
  current.lifecycleV11.c1KeywordPlanningLocalMaterialV1 = structuredClone(produced.material);
  current.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1 = structuredClone(produced.production);
  current.dataRevision += 1;
  const source = prepareC1LocalDraftSource({candidate:current,preparedAt:at});
  current.lifecycleV11.skuPackage = structuredClone(source.skuPackage);
  current.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(source.sourceEvidence);
  const request=prepareCurrentC1AiDraftRequest(current,at);
  assert.equal(validateC1AiDraftRequest(request).valid,true);
  assert.deepEqual(assertCurrentC1AiDraftRequestSources({candidate:current,request,observedAt:at}),request);
  return {candidate:current,source,request};
}

test('owner facts create four precise new facts while frozen C1, B, supply and all fifteen images stay unchanged', () => {
  const source = fixture(), original = structuredClone(source), result = revised(source);
  const old = original.lifecycleV11.skuPackage, plan = result.candidate.lifecycleV11.skuPackage.c1ProductPlan;
  assert.deepEqual(source,original);
  assert.deepEqual(result.saved.candidate.lifecycleV11.skuPackage,old);
  assert.equal(plan.sourceFactsRevision.schemaVersion,'c1-supplier-fact-revision-v2');
  assert.deepEqual(plan.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1,result.saved.declaration);
  assert.deepEqual(plan.productAttributes.ownerDeclaredFacts.map(row=>[row.fieldKey,row.fact.value]),Object.entries(facts).filter(([,value])=>value!==null));
  for (const row of plan.productAttributes.ownerDeclaredFacts) {
    assert.equal(row.label,OWNER_PRODUCT_FACT_LABELS[row.fieldKey]);
    assert.equal(row.fact.verificationStatus,'confirmed');
    assert.deepEqual(row.fact.sourceRefs,[result.saved.declaration.declarationId+'#/facts/'+row.fieldKey]);
  }
  assert.equal(plan.productAttributes.ownerDeclaredFacts.some(row=>row.fieldKey==='detachable'),false);
  assert.deepEqual(result.historyRecord.previousSkuPackage,old);
  assert.equal(result.historyRecord.previousSkuPackage.c2FinalAssets.assets.finalUploads.length,15);
  assert.deepEqual(result.candidate.lifecycleV11.skuPackage.profitModels,old.profitModels);
  assert.deepEqual(result.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot,old.selectedSupplySnapshot);
  assert.deepEqual(plan.inputSnapshots,old.c1ProductPlan.inputSnapshots);
  assert.equal(result.productionAuthorized,false);
});

test('local source and a new normal request include all four owner facts with fixed labels, without fetch', t => {
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw new Error('Unexpected external call');});
  const {candidate} = revised(fixture({local:true}));const {request,source} = localRequest(candidate);
  const owner = request.verifiedFacts.filter(row=>row.factPath.startsWith('productAttributes.ownerDeclaredFacts.'));
  assert.equal(owner.length,4);
  assert.deepEqual(owner.map(row=>row.value),['迷你背心',['猫','酒瓶'],'魔术贴',true]);
  for (const [index,row] of owner.entries()) {
    assert.ok(source.sourceEvidence.allowedFactPaths.includes(row.factPath));
    const definition=request.factDefinitions.find(value=>value.factPath===row.factPath);
    assert.equal(definition.label,OWNER_PRODUCT_FACT_LABELS[Object.keys(facts)[index]]);
  }
  assert.equal(request.verifiedFacts.some(row=>row.evidenceRefs.some(ref=>ref.endsWith('/detachable'))),false);
  assert.equal(calls,0);
});

test('v2 source identity, declaration content, source reference, label and presence cannot drift', () => {
  const {candidate} = revised();const plan=candidate.lifecycleV11.skuPackage.c1ProductPlan;
  for (const change of [p=>p.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1.sourceIdentity.supplierSkuId='foreign',
    p=>p.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1.facts.closureType='拉链',
    p=>p.productAttributes.ownerDeclaredFacts[0].fact.value='帽子',
    p=>p.productAttributes.ownerDeclaredFacts[0].fact.sourceRefs=['owner:foreign'],
    p=>p.productAttributes.ownerDeclaredFacts[0].label='材质',
    p=>delete p.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1]) {
    const changed=structuredClone(plan);change(changed);
    assert.throws(()=>assertValidC1ProductPlan(changed), /OWNER_PRODUCT_FACTS_|C1_SUPPLIER_FACT_REVISION_/);
  }
});

test('request validation and admission reject an owner fact label changed to another meaning', () => {
  const prepared=localRequest(revised(fixture({local:true})).candidate);
  const request=structuredClone(prepared.request);
  const definition=request.factDefinitions.find(row=>row.factPath.startsWith('productAttributes.ownerDeclaredFacts.'));
  definition.label='材质';
  assert.equal(validateC1AiDraftRequest(request).valid,false);
  assert.throws(()=>assertCurrentC1AiDraftRequestSources({candidate:prepared.candidate,request,observedAt:at}), /C1_DRAFT_REQUEST_INVALID/);
});

test('old v1 replay ignores later current declarations and rejects injecting one into its frozen source', () => {
  const source=fixture();const old=prepareC1FinalPlanRevision({candidate:source,expectedRevision:source.dataRevision,preparedAt:at});
  const plan=old.candidate.lifecycleV11.skuPackage.c1ProductPlan,before=structuredClone(plan);
  assert.equal(plan.sourceFactsRevision.schemaVersion,'c1-supplier-fact-revision-v1');
  const saved=declared(old.candidate);
  assert.deepEqual(saved.candidate.lifecycleV11.skuPackage.c1ProductPlan,before);
  const projection=resolveC1SupplierFactRevision({plan,sourceIdentity:plan.sourceFactsRevision.sourceIdentity});
  assert.equal(Object.hasOwn(projection,'ownerFacts'),false);
  assertValidC1ProductPlan(plan);
  const injected=structuredClone(plan);injected.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1=structuredClone(saved.declaration);
  assert.throws(()=>assertValidC1ProductPlan(injected), /OWNER_PRODUCT_FACTS_|C1_SUPPLIER_FACT_REVISION_/);
});

test('owner-only declarations can prepare a new plan without unrelated legacy battery or variant records', () => {
  const result=revised(fixture({cargo:false}));
  assert.equal(result.candidate.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ownerDeclaredFacts.length,4);
});

test('owner facts without a saved source revision cannot enter a plan or request', () => {
  const {candidate}=localRequest(revised(fixture({local:true})).candidate);
  const plan=candidate.lifecycleV11.skuPackage.c1ProductPlan;
  delete plan.sourceFactsRevision;
  assert.throws(()=>assertValidC1ProductPlan(plan), /C1_SUPPLIER_FACT_REVISION_OWNER_SOURCE_MISMATCH/);
  assert.throws(()=>prepareCurrentC1AiDraftRequest(candidate,at), /^Error: C1_LOCAL_DRAFT_SOURCE_DRIFT$/);
});

test('published schema accepts ordinary and owner-only v2 facts while preserving version requirements', async () => {
  const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs');
  const validator=await loadPublishedSchemaValidator();
  const validate=validator.getSchema('c1-product-plan-v1.1');
  for (const cargo of [true,false]) {
    const plan=structuredClone(revised(fixture({cargo})).candidate.lifecycleV11.skuPackage.c1ProductPlan);
    assert.equal(plan.sourceFactsRevision.schemaVersion,'c1-supplier-fact-revision-v2');
    assert.equal(plan.sourceFactsRevision.records.length>0,cargo);
    assert.equal(validate(plan),true,JSON.stringify(validate.errors));
    const missing=structuredClone(plan);
    delete missing.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1;
    assert.equal(validate(missing),false);
  }
  const source=fixture();
  const legacy=structuredClone(prepareC1FinalPlanRevision({candidate:source,expectedRevision:source.dataRevision,preparedAt:at}).candidate.lifecycleV11.skuPackage.c1ProductPlan);
  assert.equal(legacy.sourceFactsRevision.schemaVersion,'c1-supplier-fact-revision-v1');
  assert.equal(validate(legacy),true,JSON.stringify(validate.errors));
  legacy.sourceFactsRevision.records=[];
  assert.equal(validate(legacy),false);
});


test('a declaration from after preparation is rejected during creation and frozen replay', () => {
  const source=fixture();
  const saved=prepareOwnerProductFacts({candidate:source,facts,confirmedByUserId:'synthetic:owner-facts-test',confirmedAt:'2026-08-22T02:05:00.000Z'});
  assert.throws(()=>prepareC1FinalPlanRevision({candidate:saved.candidate,expectedRevision:saved.candidate.dataRevision,preparedAt:at}), /C1_SUPPLIER_FACT_REVISION_|OWNER_PRODUCT_FACTS_/);
  const {candidate}=revised();const plan=structuredClone(candidate.lifecycleV11.skuPackage.c1ProductPlan);
  plan.sourceFactsRevision.sourceCandidate.lifecycleV11.ownerProductFactsV1.confirmedAt='2026-08-22T02:05:00.000Z';
  assert.throws(()=>assertValidC1ProductPlan(plan), /C1_SUPPLIER_FACT_REVISION_|OWNER_PRODUCT_FACTS_/);
});
