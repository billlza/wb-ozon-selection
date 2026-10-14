import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationFamily } from '../lib/sibling-preparation-draft.mjs';
import { siblingSupplyPreparation } from '../lib/sibling-supply-preparation.mjs';
import { buildOwnerSkuUniformSupplyRecord } from '../lib/sku-choice-estimate.mjs';
import { createPreparationValues, createPreparationSession, requiredPreparationNumber, preparationWorkflowAvailable } from '../src/siblingPreparationState.js';

function fixture() {
  const ids = ['6222816678023', '6222816678020', '6222816678019'];
  const storeRef = {stableStoreId:'miska',platformStoreId:'synthetic-store',mappingVersion:'synthetic-v1'};
  const parent = {id:'candidate:synthetic-supply-parent',dataRevision:78,targetPlatform:'ozon',targetStore:'miska',storeRef,
    sourceCapture:{captureId:'synthetic:current-capture',offerId:'synthetic-offer',observedAt:'2026-10-01T00:00:00Z',
      selectedSkuIds:[...ids,'synthetic-khaki'],priceRanges:[{minimumQuantity:1,priceCny:18,source:'synthetic:offer-one-price'}],
      skuChoices:ids.map((sourceSkuId,i)=>({sourceSkuId,attributes:{颜色:['黑cp','CP','黑色'][i]},priceCny:null}))},
    packagingCostRmb:0,supplierDraftV1:{offerId:'synthetic-offer',goodsPriceRmb:18,domesticShippingRmb:6.5,allInPurchaseRmb:24.5,packedWeightKg:0.2,targetSalePriceRub:848,dimensionsCm:{length:20,width:30,height:5}},
    lifecycleV11:{skuPackage:{supplierSkuId:'synthetic-khaki',selectedSupplySnapshot:{snapshotId:'synthetic:khaki-cost-confirmation',
      ownerSupplyConfirmation:{status:'confirmed'},supplierOption:{offerId:'synthetic-offer'},supplierSku:{supplierSkuId:'synthetic-khaki',attributes:{
        quantityOneEvidence:{supplierSkuId:'synthetic-khaki',captureId:'synthetic:current-capture',minimumOrderQuantity:1,sourceNote:'khaki-only'},
        purchaseCostComponents:{unitProductPrice:18,unitDomesticFreight:6.5,otherPurchaseCosts:0,actualPurchaseCost:24.5,currency:'CNY'}}}}}}};
  parent.skuUniformSupplyV1=buildOwnerSkuUniformSupplyRecord({candidate:parent,declaredAt:'2026-10-01T00:01:00Z'});
  const members=ids.map((supplierSkuId,i)=>({id:`candidate:synthetic-color-${i}`,dataRevision:i+1,targetStore:'miska',storeRef:structuredClone(storeRef),
    siblingSourceV1:{parentCandidateId:parent.id,parentRevision:78,supplierSkuId,captureId:parent.sourceCapture.captureId},
    sourceCapture:{captureId:parent.sourceCapture.captureId,offerId:parent.sourceCapture.offerId,skuChoices:[structuredClone(parent.sourceCapture.skuChoices[i])]},
    supplierDraftV1:structuredClone(parent.supplierDraftV1)}));
  const catalog={offerId:parent.sourceCapture.offerId,platform:'ozon',supplierSkuIds:ids,excludedSupplierSkuIds:['synthetic-khaki'],
    defaults:{other:'0',quantityOneEvidenceSourceNote:''},colors:Object.fromEntries(ids.map(id=>[id,{colorRu:'synthetic',platformColors:[],defaultOrder:[]}]))};
  return {parent,members,catalog,document:{candidates:[parent,...members]}};
}

test('the three legacy colors without targetPlatform load read-only within the exact verified family',()=>{
  const f=fixture(),before=structuredClone(f.document);
  const family=preparationFamily(f.document,f.parent.id,f.catalog);
  assert.deepEqual(family.members.map(c=>c.id),f.members.map(c=>c.id));
  assert.deepEqual(f.document,before);
  assert.ok(f.members.every(c=>!Object.hasOwn(c,'targetPlatform')));
});

test('explicit platform, store, capture, offer and duplicate sibling conflicts remain blocked',()=>{
  for(const mutate of [
    f=>{f.members[0].targetPlatform=null;}, f=>{f.members[0].targetPlatform='';}, f=>{f.members[0].targetPlatform='wb';},
    f=>{f.members[0].targetStore='dandanshu';}, f=>{f.members[0].storeRef.platformStoreId='foreign';},
    f=>{f.members[0].sourceCapture.captureId='other';}, f=>{f.members[0].sourceCapture.offerId='other';},
    f=>{f.members[0].lifecycleV11={skuPackage:{g1Identity:{platform:'wb'}}};},
    f=>{f.document.candidates.push(structuredClone(f.members[0]));}, f=>{f.parent.targetPlatform='wb';}
  ]) {const f=fixture();mutate(f);const before=structuredClone(f.document);assert.throws(()=>preparationFamily(f.document,f.parent.id,f.catalog));assert.deepEqual(f.document,before);}
});

test('offer quotes and the valid declaration produce separate pending three-color evidence, not khaki confirmations',()=>{
  const f=fixture(),before=structuredClone(f.document),reuse=siblingSupplyPreparation(f.parent,f.members);
  assert.deepEqual(reuse.gaps,[]);assert.equal(reuse.otherPurchaseCosts,0);assert.equal(reuse.costSourceRef,'synthetic:khaki-cost-confirmation');
  for(const row of reuse.rows){assert.equal(row.ownerSupplyConfirmed,false);assert.match(row.quantityOneEvidenceSourceNote,new RegExp(row.sourceSkuId));assert.match(row.quantityOneEvidenceSourceNote,/页面报的起订量是 1 件/);assert.match(row.quantityOneEvidenceSourceNote,/不是页面给的/);assert.doesNotMatch(row.quantityOneEvidenceSourceNote,/khaki-only/);}
  const values=createPreparationValues(f.catalog,f.parent,f.members,reuse);
  assert.equal(values.shared.other,'0');assert.equal(values.supplyReviewed,false);assert.ok(values.shared.quantityOneEvidenceSourceNote);
  assert.equal(values.shared.freight,'6.5');assert.equal(values.shared.weight,'0.2');assert.equal(values.shared.height,'5');assert.equal(values.shared.price,'848');assert.equal(values.shared.packaging,'0');
  assert.deepEqual(f.document,before);
});

test('a khaki note alone, conflicting offer quotes, changed capture/price and incomplete declaration never create three-color MOQ evidence',()=>{
  for(const mutate of [f=>{f.parent.sourceCapture.priceRanges=[];},
    f=>{f.parent.sourceCapture.priceRanges.push({minimumQuantity:1,priceCny:19});},
    f=>{f.parent.skuUniformSupplyV1.captureId='previous';},
    f=>{f.parent.supplierDraftV1.goodsPriceRmb=19;},
    f=>{f.parent.skuUniformSupplyV1.sourceSkuIds.pop();}
  ]){const f=fixture();mutate(f);const reuse=siblingSupplyPreparation(f.parent,f.members);assert.ok(reuse.gaps.length);assert.equal(reuse.quantityOneEvidenceSourceNote,'');}
});

test('unknown, stale or inconsistent original costs remain blank despite catalog zero and no added items',()=>{
  for(const mutate of [f=>{delete f.parent.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.purchaseCostComponents.otherPurchaseCosts;},
    f=>{f.parent.supplierDraftV1.domesticShippingRmb=7;},
    f=>{f.parent.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierOption.offerId='other';},
    f=>{f.parent.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.quantityOneEvidence.captureId='previous';},
    f=>{f.parent.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.purchaseCostComponents.actualPurchaseCost=20;}
  ]){const f=fixture();mutate(f);const reuse=siblingSupplyPreparation(f.parent,f.members),v=createPreparationValues(f.catalog,f.parent,f.members,reuse);assert.equal(reuse.otherPurchaseCosts,null);assert.equal(reuse.costSourceRef,null);assert.equal(v.shared.other,'');}
});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('late reads cannot replace edited values, newer reads or a different family, including returning to the first family',async()=>{
  const session=createPreparationSession();session.select('A');let value='user input';
  const old=deferred(),read=session.read(()=>old.promise,x=>{value=x;});session.edited();old.resolve('late draft');await read;assert.equal(value,'user input');
  const a=deferred(),b=deferred();const ra=session.read(()=>a.promise,x=>{value=x;}),rb=session.read(()=>b.promise,x=>{value=x;});b.resolve('new draft');await rb;a.resolve('old draft');await ra;assert.equal(value,'new draft');
  const token=session.capture(),different=deferred(),rd=session.read(()=>different.promise,x=>{value=x;});session.select('B');session.select('A');different.resolve('old A');await rd;assert.equal(value,'new draft');assert.equal(session.current(token),false);
  const unmounted=deferred(),ru=session.read(()=>unmounted.promise,x=>{value=x;});session.dispose();unmounted.resolve('unmounted');await ru;assert.equal(value,'new draft');
});

test('saving an older editing version may retain its receipt but cannot clear newer unsaved inputs',()=>{
  const session=createPreparationSession();session.select('A');const save=session.capture();session.edited();
  assert.equal(session.current(save),true);assert.equal(session.unchanged(save),false);
  const latest=session.capture();assert.equal(session.unchanged(latest),true);session.select('B');assert.equal(session.current(latest),false);
});

test('whitespace and unknown numeric inputs cannot become zero in a supply confirmation',()=>{
  for(const value of ['', ' ', '\t', '\n', null, undefined, 'NaN','1,5','-1'])assert.throws(()=>requiredPreparationNumber(value));
  assert.equal(requiredPreparationNumber('0'),0);assert.equal(requiredPreparationNumber('6.5'),6.5);
});

test('accepting a save receipt invalidates an older pending read without changing the editing version',async()=>{
  const session=createPreparationSession();session.select('A');const token=session.capture(),old=deferred();let receipt='version 2';
  const read=session.read(()=>old.promise,value=>{receipt=value;});session.cancelReads();old.resolve('version 1');await read;
  assert.equal(receipt,'version 2');assert.equal(session.unchanged(token),true);
});

test('loading, errors and unknown load results close the formal workflow rather than enabling the legacy fallback',()=>{
  for(const status of ['loading','error','',null,undefined,'unknown'])assert.equal(preparationWorkflowAvailable(status),false);
  assert.equal(preparationWorkflowAvailable('configured'),true);assert.equal(preparationWorkflowAvailable('unconfigured'),true);
});
