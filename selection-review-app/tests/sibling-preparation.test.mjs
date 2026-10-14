import {commitSiblingBatchC2Final} from '../lib/sibling-batch-c2-final.mjs';
import {commitSingleOwnerProductionAuthorization} from '../lib/production-authorization.mjs';
import {resolveProductionOwnerPreparation} from '../lib/production-owner-preparation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {createMemoryBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {saveSiblingPreparationDraft,preparationFamily} from '../lib/sibling-preparation-draft.mjs';
import {createPreparationValues,changePreparationImage,setPreparationHero,batchPreparationFunctions,adoptPreparationCopy,effectivePreparationValue} from '../src/siblingPreparationState.js';
import {oneColorFixture,threeColorFixture,threeColorC2Fixture,at} from './fixtures/sibling-batch-final-family-fixture.mjs';
import {previewSiblingBatchC1Preparation,commitSiblingBatchC1Preparation} from '../lib/sibling-batch-c1-preparation.mjs';
import {buildOzonOptionalAttributes} from '../lib/ozon-submission-attributes.mjs';
import {createLocalSiblingCatalogReader} from '../lib/sibling-preparation-catalog.mjs';
import {c1CopyFields,assertSiblingPreparationMatchesFinal} from '../lib/sibling-preparation-consistency.mjs';
import {readyAuthorizationFamily} from './fixtures/sibling-batch-final-fixture.mjs';
import {commitBatchOwnerProductionAuthorization} from '../lib/d-batch-production-authorization.mjs';
import {siblingBatchAuthorizationInput} from '../src/siblingBatchAuthorizationInput.js';
import {syntheticCatalog,writeSyntheticSiblingPreparationCatalog} from './fixtures/sibling-preparation-catalog-fixture.mjs';


test('draft is durable and versioned, rejects concurrent edit and foreign scope, and has no jobs or authorization',async()=>{
 const f=await threeColorFixture(),before=await f.repository.readSnapshot(),catalog=syntheticCatalog(before),values=createPreparationValues(catalog,before.candidates[0],before.candidates.slice(1));
 const input={parentCandidateId:before.candidates[0].id,parentRevision:before.candidates[0].dataRevision,memberRevisions:before.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),expectedDraftRevision:0,idempotencyKey:'synthetic:save:1',values};
 const args={repository:f.repository,runtimeMode:'local_development',actor:f.actor,catalog,input,serverClock:()=>at};
 const result=await saveSiblingPreparationDraft(args);assert.equal(result.draft.draftRevision,1);assert.equal(result.platformWrites,0);
 const saved=await f.repository.readSnapshot();for(const [i,c] of saved.candidates.entries()){assert.deepEqual(c.lifecycleV11,before.candidates[i].lifecycleV11);assert.equal(c.dataRevision,before.candidates[i].dataRevision);}assert.deepEqual(saved.runtime.softwareJobs,before.runtime.softwareJobs);assert.equal(result.draft.productionAuthorizationGranted,false);
 assert.deepEqual(await saveSiblingPreparationDraft(args),result);assert.deepEqual(await f.repository.readSnapshot(),saved);
 await assert.rejects(()=>saveSiblingPreparationDraft({...args,input:{...input,idempotencyKey:'synthetic:save:2'}}),/DRAFT_CONFLICT/);
 const extra=structuredClone(input);extra.memberRevisions[0].unexpected='not allowed';await assert.rejects(()=>saveSiblingPreparationDraft({...args,input:extra}),/INPUT_INVALID/);
 const stale={...input,expectedDraftRevision:1,idempotencyKey:'synthetic:save:3',parentRevision:input.parentRevision+1};await assert.rejects(()=>saveSiblingPreparationDraft({...args,input:stale}),/SOURCE_CHANGED/);
 const wrong=structuredClone(input);wrong.values.members[1].order.push('16');await assert.rejects(()=>saveSiblingPreparationDraft({...args,input:wrong}),/DRAFT_INVALID/);
 const restored=createMemoryBusinessStateRepository(saved);assert.deepEqual((await restored.readSnapshot()).runtime.siblingPreparationDrafts[0].values,values);
 const mismatch=structuredClone(before);mismatch.candidates[1].sourceCapture.captureId='other';assert.throws(()=>preparationFamily(mismatch,input.parentCandidateId,catalog),/MEMBERS_CHANGED/);
});

test('functional batch adoption preserves other pictures and explicit hero, per-color cancel preserves other colors',async()=>{
 const f=await threeColorFixture(),d=await f.repository.readSnapshot(),catalog=syntheticCatalog(d);let v=createPreparationValues(catalog,d.candidates[0],d.candidates.slice(1));assert.ok(v.members.every(m=>m.hero===null));
 assert.deepEqual(v.members.map(m=>m.order),[['16','17'],['30','17'],['18','17']]);
 v=setPreparationHero(v,v.members[0].sourceSkuId,'16');const next=batchPreparationFunctions(v,catalog,true);assert.equal(next.members[0].hero,'16');assert.equal(next.members[1].hero,null);
 for(const [i,member] of next.members.entries())assert.deepEqual(member.order,[...v.members[i].order,'19','27','29']);
 const canceled=changePreparationImage(next,catalog,next.members[1].sourceSkuId,'19',false);assert.deepEqual(canceled.members[0],next.members[0]);assert.deepEqual(canceled.members[2],next.members[2]);assert.deepEqual(canceled.members[1].order,['30','17','27','29']);assert.equal(canceled.members[1].hero,null);assert.throws(()=>changePreparationImage(v,catalog,v.members[1].sourceSkuId,'16',true),/身份不符/);
});

test('multi-value color is emitted as verified dictionary entries and cannot bypass missing collection schema',async()=>{
 const f=await oneColorFixture([],{isCollection:true,maxValueCount:6});f.input.members[0].colorMappings['10096']=['synthetic-broad-color','synthetic-broad-cp'];f.input.previewFingerprint=previewSiblingBatchC1Preparation({document:await f.repository.readSnapshot(),actor:f.actor,input:f.input,serverClock:()=>at}).previewFingerprint;
 await commitSiblingBatchC1Preparation({repository:f.repository,runtimeMode:'local_development',actor:f.actor,input:f.input,serverClock:()=>at});const sku=(await f.repository.readSnapshot()).candidates[1].lifecycleV11.skuPackage;
 const result=buildOzonOptionalAttributes({attributes:sku.c1ProductPlan.productAttributes,platformSchemaAttributes:sku.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes});assert.deepEqual(result.attributes.find(a=>a.id===10096).values,[{dictionary_value_id:910096,value:'synthetic-broad-color'},{dictionary_value_id:910097,value:'synthetic-broad-cp'}]);
 const unsupported=await oneColorFixture();unsupported.input.members[0].colorMappings['10096']=['synthetic-broad-color','synthetic-broad-cp'];const before=await unsupported.repository.readSnapshot();assert.throws(()=>previewSiblingBatchC1Preparation({document:before,actor:unsupported.actor,input:unsupported.input,serverClock:()=>at}),/COLLECTION_SCHEMA_REQUIRED/);assert.deepEqual(await unsupported.repository.readSnapshot(),before);
});

test('changed SEO draft is visible in preview and cannot enter C2 without formal semantic review',async()=>{
 const f=await oneColorFixture();f.input.members[0].copyDraft={...c1CopyFields(null),titleRu:'unverified new material claim'};const before=await f.repository.readSnapshot();const preview=previewSiblingBatchC1Preparation({document:before,actor:f.actor,input:f.input,serverClock:()=>at});assert.equal(preview.members[0].copyReviewRequired,true);
 f.input.previewFingerprint=preview.previewFingerprint;await assert.rejects(()=>commitSiblingBatchC1Preparation({repository:f.repository,runtimeMode:'local_development',actor:f.actor,input:f.input,serverClock:()=>at}),/COPY_REVIEW_REQUIRED/);assert.deepEqual(await f.repository.readSnapshot(),before);
 f.input.members[0].copyDraft=c1CopyFields(preview.members[0].content);const adopted=previewSiblingBatchC1Preparation({document:before,actor:f.actor,input:f.input,serverClock:()=>at});assert.equal(adopted.members[0].copyReviewRequired,false);f.input.previewFingerprint=adopted.previewFingerprint;await commitSiblingBatchC1Preparation({repository:f.repository,runtimeMode:'local_development',actor:f.actor,input:f.input,serverClock:()=>at});assert.equal((await f.repository.readSnapshot()).candidates[1].lifecycleV11.skuPackage.c1ProductPlan.seoTitleDraft.text,f.input.members[0].copyDraft.titleRu);
});

test('synthetic catalog retains real file identities, 15 finished PNGs and three color-bound white exceptions',async t=>{
 const f=await threeColorFixture(),document=await f.repository.readSnapshot();
 const directory=await mkdtemp(path.join(tmpdir(),'sibling-catalog-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const written=await writeSyntheticSiblingPreparationCatalog({document,tempDir:directory}),reader=createLocalSiblingCatalogReader({directory}),catalog=await reader.readCatalog();assert.deepEqual(catalog,written);
 assert.equal(catalog.assets.length,18);assert.equal(catalog.assets.filter(a=>a.kind==='finished').length,15);assert.equal(catalog.assets.filter(a=>a.kind==='owner_color_exception'&&a.onlySourceSkuId).length,3);
 assert.deepEqual(catalog.assets.filter(a=>a.kind==='owner_color_exception').map(a=>[a.assetId,a.onlySourceSkuId]),[['16',catalog.supplierSkuIds[0]],['30',catalog.supplierSkuIds[1]],['18',catalog.supplierSkuIds[2]]]);
 assert.deepEqual(catalog.functionalAssetIds,['19','27','29']);assert.deepEqual(catalog.assets.filter(a=>a.functionalCandidate).map(a=>a.assetId),catalog.functionalAssetIds);
 assert.equal(new Set(catalog.assets.map(a=>a.sha256)).size,18);
 for(const asset of catalog.assets) {
  const {body,contentType}=await reader.readAsset(catalog,asset.assetId);assert.equal(contentType,'image/png');assert.equal(body.length,asset.byteSize);assert.equal(createHash('sha256').update(body).digest('hex'),asset.sha256);
  assert.equal(body.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(body.readUInt32BE(16),2);assert.equal(body.readUInt32BE(20),2);assert.equal(body[24],8);assert.equal(body[25],2);
  assert.equal(body.subarray(12,16).toString('ascii'),'IHDR');assert.equal(body.subarray(37,41).toString('ascii'),'IDAT');assert.equal(body.subarray(-8,-4).toString('ascii'),'IEND');
  const pixels=inflateSync(body.subarray(41,41+body.readUInt32BE(33)));assert.equal(pixels.length,14);assert.equal(pixels[0],0);assert.equal(pixels[7],0);
  if(asset.kind==='owner_color_exception')assert.deepEqual([...pixels.subarray(1,7)],[255,255,255,255,255,255]);
 }
 await assert.rejects(()=>reader.readAsset(catalog,'../secret'),/NOT_ALLOWED/);
 assert.throws(()=>createLocalSiblingCatalogReader({directory:'relative'}),/DIRECTORY_REQUIRED/);
 await assert.rejects(()=>writeSyntheticSiblingPreparationCatalog({document,tempDir:'relative'}),/TEMP_DIRECTORY_REQUIRED/);
});

test('synthetic catalog rejects malformed metadata, changed bytes, changed size and symlink paths without fallback',async t=>{
 const f=await threeColorFixture(),document=await f.repository.readSnapshot();
 const directory=await mkdtemp(path.join(tmpdir(),'sibling-catalog-invalid-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const catalog=await writeSyntheticSiblingPreparationCatalog({document,tempDir:directory}),reader=createLocalSiblingCatalogReader({directory}),catalogFile=path.join(directory,'catalog.json');
 const mutations=[c=>{c.assets[1].assetId=c.assets[0].assetId;},c=>{c.assets[0].storageKey='../outside.png';},c=>{c.assets[0].sha256='invalid';},c=>{c.assets[0].contentType='image/svg+xml';},c=>{c.assets.find(a=>a.kind==='owner_color_exception').onlySourceSkuId='synthetic-foreign-sku';}];
 for(const mutate of mutations) {const invalid=structuredClone(catalog);mutate(invalid);await writeFile(catalogFile,JSON.stringify(invalid));await assert.rejects(()=>reader.readCatalog(),/SIBLING_CATALOG_INVALID/);}
 await writeFile(catalogFile,'{');await assert.rejects(()=>reader.readCatalog(),/SIBLING_CATALOG_INVALID/);await writeFile(catalogFile,JSON.stringify(catalog));assert.deepEqual(await reader.readCatalog(),catalog);
 const asset=catalog.assets[0],assetFile=path.join(directory,asset.storageKey),original=await readFile(assetFile),changed=Buffer.from(original);changed[changed.length-1]^=1;
 await writeFile(assetFile,changed);await assert.rejects(()=>reader.readAsset(catalog,asset.assetId),/SIBLING_CATALOG_ASSET_CHANGED/);
 await writeFile(assetFile,original.subarray(0,-1));await assert.rejects(()=>reader.readAsset(catalog,asset.assetId),/SIBLING_CATALOG_ASSET_CHANGED/);
 await writeFile(assetFile,original);assert.deepEqual((await reader.readAsset(catalog,asset.assetId)).body,original);
 await rm(assetFile);await symlink(path.join(directory,catalog.assets[1].storageKey),assetFile);await assert.rejects(()=>reader.readAsset(catalog,asset.assetId),/SIBLING_CATALOG_ASSET_PATH_CHANGED/);
 await rm(catalogFile);await assert.rejects(()=>reader.readCatalog(),/SIBLING_CATALOG_UNAVAILABLE/);
});

test('server-side final gate rejects saved draft changes despite a valid old final card and bypassed browser',async()=>{
 const {source,parent,child}=readyAuthorizationFamily();parent.sourceCapture.selectedSkuIds.reverse();const initial=await source.repository.readSnapshot();initial.candidates=[parent,child];const catalog=syntheticCatalog(initial),values=createPreparationValues(catalog,parent,[child]);values.supplyReviewed=true;
 initial.runtime.siblingPreparationDrafts=[{parentCandidateId:parent.id,sourceRevision:parent.dataRevision,memberRevisions:[{candidateId:child.id,revision:child.dataRevision}],values,assetBindings:catalog.assets}];const repository=createMemoryBusinessStateRepository(initial),input=siblingBatchAuthorizationInput(parent,[child],child.productionOwnerPreparation.executionBindings[0].bindingId,{inventoryAction:'write_authorized_stock'}).input;
 const before=await repository.readSnapshot();await assert.rejects(()=>commitBatchOwnerProductionAuthorization({repository,runtimeMode:'local_development',actor:source.args.actor,input,configuration:source.configuration,serverClock:source.args.serverClock}),/SIBLING_PREPARATION_FINAL_MISMATCH/);assert.deepEqual(await repository.readSnapshot(),before);
 assert.throws(()=>assertSiblingPreparationMatchesFinal({parent,members:[child],draft:initial.runtime.siblingPreparationDrafts[0]}),/FINAL_MISMATCH/);
});


test('C2 rejects a saved explicit hero/sequence mismatch without freezing an old upload selection',async()=>{
 const f=await threeColorC2Fixture();await f.repository.transact(d=>{const catalog=syntheticCatalog(d),values=createPreparationValues(catalog,d.candidates[0],d.candidates.slice(1));d.runtime.siblingPreparationDrafts=[{parentCandidateId:d.candidates[0].id,sourceRevision:d.candidates[0].dataRevision,memberRevisions:d.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),values,assetBindings:catalog.assets}];return {changed:true,document:d,result:null};});
 const before=await f.repository.readSnapshot();await assert.rejects(()=>commitSiblingBatchC2Final({repository:f.repository,runtimeMode:'local_development',actor:f.actor,input:f.input,verifiedAssets:f.verifiedAssets,serverClock:()=>at}),/PREPARATION_IMAGES_MISMATCH/);assert.deepEqual(await f.repository.readSnapshot(),before);
});

test('a previous gallery image can become this color explicitly confirmed hero; previous hero remains protected',async()=>{
 const f=await threeColorC2Fixture();await f.repository.transact(d=>{for(const c of d.candidates.slice(1))c.siblingSourceV1.parentCardBinding.parentImageSha256s.push(f.verifiedAssets.get(c.id)[0].sha256);return {changed:true,document:d,result:null};});
 const result=await commitSiblingBatchC2Final({repository:f.repository,runtimeMode:'local_development',actor:f.actor,input:f.input,verifiedAssets:f.verifiedAssets,serverClock:()=>at});assert.equal(result.members.length,3);
});

test('saved batch draft cannot be bypassed through the single-candidate production authorization entry',async()=>{
 const {source,parent,child}=readyAuthorizationFamily();child.siblingPreparationDraftRefV1={parentCandidateId:parent.id,draftRevision:1};const initial=await source.repository.readSnapshot();initial.candidates=[parent,child];const repository=createMemoryBusinessStateRepository(initial),input=siblingBatchAuthorizationInput(parent,[child],child.productionOwnerPreparation.executionBindings[0].bindingId,{inventoryAction:'write_authorized_stock'}).input.members[0].ownerInput;
 const before=await repository.readSnapshot();await assert.rejects(()=>commitSingleOwnerProductionAuthorization({repository,runtimeMode:'local_development',actor:source.args.actor,candidateId:child.id,input,serverClock:source.args.serverClock,resolveProductionAuthorizationDecision:context=>resolveProductionOwnerPreparation({...context,configuration:source.configuration})}),/BATCH_CONFIRMATION_REQUIRED/);assert.deepEqual(await repository.readSnapshot(),before);
});

test('adopting verified common copy clears inherited review text and retains explicit empty per-color review',async()=>{
 const f=await threeColorFixture(),d=await f.repository.readSnapshot(),catalog=syntheticCatalog(d);const values=createPreparationValues(catalog,d.candidates[0],d.candidates.slice(1));values.shared.titleZh='old review';
 const fields={...c1CopyFields(null),titleRu:'verified synthetic'};const copies=values.members.map(m=>({candidateId:m.candidateId,fields}));const common=adoptPreparationCopy(values,copies);assert.equal(common.shared.titleRu,fields.titleRu);assert.equal(common.shared.titleZh,'');assert.ok(common.members.every(m=>effectivePreparationValue(common,m,'titleZh')===''));
 const varying=adoptPreparationCopy(values,copies.map((c,i)=>({...c,fields:{...fields,titleZh:i===0?'one review':''}})));assert.equal(effectivePreparationValue(varying,varying.members[1],'titleZh'),'');assert.equal(values.shared.titleZh,'old review');
});
