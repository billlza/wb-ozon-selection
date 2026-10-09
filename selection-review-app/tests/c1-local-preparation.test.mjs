import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormalC1DraftFixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { produceC1LocalPreparation } from '../lib/c1-keyword-planning-local-material.mjs';
import { persistC1KeywordPlanningLocalMaterial } from '../lib/c1-keyword-planning-local-material-persistence.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { validateC1ProductPlan } from '../lib/c1-product-plan.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { prepareC1LocalDraftSource } from '../lib/c1-local-draft-source.mjs';
const NOW='2026-08-25T08:00:00.000Z';
function candidate(){
 const c=structuredClone(createFormalC1DraftFixture({at:NOW}).candidate),s=c.lifecycleV11.skuPackage;
 const definitions=[['8229','Тип','3D-пазл','platformCategory.categoryName'],['4967','Материал','Дерево','productAttributes.material'],['10096','Цвет','разноцветный','productAttributes.supplierAttributes.0.fact'],['9048','Модель','AL-123','productAttributes.supplierAttributes.1.fact']];
 s.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes=definitions.map(([id,label])=>({fieldKey:id,label,dictionaryId:1,required:id==='8229'}));
 s.ozonAttributeMappingsV1={schemaRevision:s.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision,confirmationRef:'owner:mapping:1',mappings:definitions.map(([id,label,value,path])=>({attributeId:id,attributeLabel:label,value,sourceFactValue:id==='10096'?'红,蓝':value,sourceFactPath:path,dictionaryEvidenceRef:`dictionary:${id}`}))};
 s.c1ProductPlan.productAttributes.ozonAttributes=s.ozonAttributeMappingsV1.mappings.map(m=>({fieldKey:m.attributeId,fact:{value:{value:m.value,dictionaryValueId:12},verificationStatus:'confirmed',sourceRefs:[m.dictionaryEvidenceRef]}}));
 c.sourceCapture={selectedSkuIds:[s.supplierSkuId,'OTHER-COLOUR'],skuChoices:[{sourceSkuId:s.supplierSkuId,attributes:{颜色:'红',规格:'红>均码'}}]};
 c.lifecycleV11.opportunityPackage.salesSnapshots=[];c.salesSnapshotsV11=[];return c;
}
function produce(c){assert.equal(validateC1ProductPlan(c.lifecycleV11.skuPackage.c1ProductPlan).valid,true,JSON.stringify(validateC1ProductPlan(c.lifecycleV11.skuPackage.c1ProductPlan).errors));return produceC1LocalPreparation({candidate:c,expectedRevision:c.dataRevision,producedAt:NOW});}
test('首次无快照、零对标：来源词和未知统计，保护阶段与其他颜色',()=>{
 const c=candidate(),before=structuredClone(c),p=produce(c);
 assert.equal(p.status,'ready');assert.equal(p.material.reusableKeywordSnapshot,null);assert.equal(p.material.competitorTextSnapshots.length,0);
 assert.deepEqual(p.material.keywords.map(k=>k.term),['3D-пазл','Дерево']);assert.deepEqual(p.material.keywords[0].purposes,['title','description']);
 assert.ok(p.material.keywords.every(k=>k.searchVolume===null&&k.conversion===null&&k.sourceRefs.length>0));
 assert.equal(p.material.attributes.find(a=>a.fieldKey==='10096').status,'scope_unresolved');assert.deepEqual(c,before);
 assert.equal(p.material.preparationOnly,true);assert.ok(Object.values(p.production.execution).slice(1).every(n=>n===0));
});
test('无合格标题词时仍保留材料，不拿材质和货号凑数',()=>{
 const c=candidate();c.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[0].fact.verificationStatus='unknown';
 const p=produce(c);assert.equal(p.status,'not_ready');assert.ok(p.material.keywords.some(k=>k.term==='Дерево'));
 assert.ok(p.production.gaps.some(g=>g.code==='title_keyword_missing'));assert.ok(p.production.gaps.some(g=>g.code==='required_attribute_missing'));
});
test('跨候选身份和过时修订拒绝，单条对标不变成本品事实',()=>{
 const c=candidate();c.salesSnapshotsV11=[{snapshotId:'s:1',platform:'ozon',title:'чужой бренд и водостойкость',evidenceRef:'e:1',collectedAt:NOW}];
 const p=produce(c);assert.equal(p.material.competitorTextSnapshots.length,1);assert.equal(p.material.keywords.some(k=>k.term.includes('водостойкость')),false);
 assert.throws(()=>produceC1LocalPreparation({candidate:c,expectedRevision:0,producedAt:NOW}),/INPUT_INVALID/);c.id='OTHER';assert.throws(()=>produce(c),/IDENTITY_INVALID/);
});
test('保存重读幂等，原A/B和其他商品不变，旧材料保留',async()=>{
 const c=candidate(),originalSku=structuredClone(c.lifecycleV11.skuPackage),other={id:'OTHER',dataRevision:4};
 c.lifecycleV11.c1KeywordPlanningLocalMaterialV1={schemaVersion:'c1-keyword-planning-local-material-v1',materialFingerprint:'old'};
 const repository=createMemoryBusinessStateRepository({candidates:[c,other]});
 const actor=createActorContext({userId:'test-owner',sessionId:'test',actorType:'human',roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:NOW});
 const args={repository,runtimeMode:'local_development',actor,candidateId:c.id,expectedRevision:c.dataRevision,producedAt:NOW,producer:produceC1LocalPreparation};
 const first=await persistC1KeywordPlanningLocalMaterial(args);assert.equal(first.status,'committed');assert.deepEqual(first.candidate.lifecycleV11.skuPackage,originalSku);
 assert.equal(first.candidate.lifecycleV11.c1KeywordPlanningLocalMaterialHistoryV1[0].materialFingerprint,'old');
 const again=await persistC1KeywordPlanningLocalMaterial({...args,expectedRevision:first.candidate.dataRevision});assert.equal(again.status,'already_current');
 const state=await repository.readSnapshot();assert.deepEqual(state.candidates[1],other);assert.equal(state.runtime.softwareJobs?.length??0,0);assert.equal(first.candidate.lifecycleV11.c1AiDraftRequestV1,undefined);
});

test('已确认必填事实仍显示，缺字典编号不伪装成缺商品事实，也不直接变成关键词',()=>{
 const c=candidate(),s=c.lifecycleV11.skuPackage,p=s.c1ProductPlan;
 p.inputSnapshots.platformSchemaRules.attributes.push({fieldKey:'85',label:'Бренд',dictionaryId:1,required:true});
 p.productAttributes.requiredPlatformFields.push({fieldKey:'85',label:'Бренд',fact:{value:{value:'Нет бренда',brandStatus:'unbranded',dictionaryValueId:null},sourceRefs:['owner:unbranded'],verificationStatus:'confirmed'}});
 const result=produce(c),brand=result.material.attributes.find(a=>a.fieldKey==='85');
 assert.equal(brand.value,'Нет бренда');assert.equal(brand.status,'dictionary_pending');assert.deepEqual(brand.sourceRefs,['owner:unbranded']);
 assert.ok(result.material.gaps.some(g=>g.code==='required_dictionary_value_missing'&&g.field==='85'));
 assert.ok(!result.material.gaps.some(g=>g.code==='required_attribute_missing'&&g.field==='85'));
 assert.ok(!result.material.keywords.some(k=>k.term==='Нет бренда'));
});

test('无映射必填颜色即使字典编号有效，也须与当前SKU颜色完全一致才可准备',()=>{
 const c=candidate(),s=c.lifecycleV11.skuPackage,p=s.c1ProductPlan;
 s.ozonAttributeMappingsV1.mappings=s.ozonAttributeMappingsV1.mappings.filter(m=>m.attributeId!=='10096');
 p.inputSnapshots.platformSchemaRules.attributes.find(a=>a.fieldKey==='10096').required=true;
 p.productAttributes.requiredPlatformFields.push({fieldKey:'10096',label:'Цвет',fact:{value:{value:'разноцветный',dictionaryValueId:12},sourceRefs:['supplier:offer-colours'],verificationStatus:'confirmed'}});
 const before=structuredClone(c),result=produce(c);
 assert.equal(result.status,'not_ready');
 assert.equal(result.material.status,'needs_information');
 assert.equal(result.material.attributes.find(a=>a.fieldKey==='10096').status,'needs_review');
 assert.ok(result.material.gaps.some(g=>g.code==='required_attribute_missing'&&g.field==='10096'));
 assert.ok(!result.material.keywords.some(k=>k.term==='разноцветный'));
 assert.deepEqual(c,before);
 const saved=structuredClone(c);
 saved.lifecycleV11.c1KeywordPlanningLocalMaterialV1=structuredClone(result.material);
 saved.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1=structuredClone(result.production);
 saved.dataRevision+=1;
 assert.throws(()=>prepareC1LocalDraftSource({candidate:saved,preparedAt:NOW}),/C1_LOCAL_DRAFT_MATERIAL_INVALID/);
 c.sourceCapture.skuChoices[0].attributes.颜色='разноцветный';
 const matched=produce(c);
 assert.equal(matched.material.attributes.find(a=>a.fieldKey==='10096').status,'confirmed');
 assert.equal(matched.status,'ready');
 delete c.sourceCapture.skuChoices[0].attributes.颜色;
 assert.equal(produce(c).status,'not_ready');
});
