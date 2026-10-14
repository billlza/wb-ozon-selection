import { assertSafeBusinessMutationCandidate } from '../lib/runtime-identity.mjs';
import { validateC2AssetLifecycle, fingerprintC2FinalCardInputSnapshot, fingerprintC2AuthorizationPreparation } from '../lib/c2-asset-lifecycle.mjs';
import { assertNoProductionSecrets, assertCanonicalC2ReferenceTree, BUSINESS_CANDIDATE_MAX_NODES, BUSINESS_CANDIDATE_MAX_BYTES } from '../lib/production-contract-primitives.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createC1CompletedEditorialFixture, finalImageRevisionFixture } from './fixtures/c1-completed-editorial-fixture.mjs';
import { createC1EditorialReviewUseCase, buildC1EditorialReviewView } from '../lib/c1-editorial-review-use-case.mjs';
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { assertC1EditorialPlan } from '../lib/c1-editorial-review-contract.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';

function useCase(f,repository=f.repository) {
  return createC1EditorialReviewUseCase({repository,runtimeMode:'local_development',serverClock:()=>f.at,proposalBundle:f.bundle});
}
function confirmation(f) {
  const view=buildC1EditorialReviewView({candidate:f.candidate,sourceJob:f.bundle.sourceJob,proposalBundle:f.bundle,observedAt:f.at});
  assert.equal(view.status,'awaiting_confirmation',JSON.stringify(view));
  assert.equal(view.canConfirm,true);
  return {candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision,editorialVersionId:view.editorialVersionId,
    outputFingerprint:view.outputFingerprint,confirmed:true,idempotencyKey:'completed-editorial:confirm',auditEventId:'completed-editorial:confirm-audit'};
}
function assertProtected(before,after) {
  assert.deepEqual(after.runtime.softwareJobs,before.runtime.softwareJobs);
  assert.deepEqual(after.runtime.softwareJobAuthorizationRecords,before.runtime.softwareJobAuthorizationRecords);
  assert.deepEqual(after.runtime.softwareJobCredentialBindings,before.runtime.softwareJobCredentialBindings);
  assert.deepEqual(after.candidates[0].lifecycleV11.c1AiDraftRequestV1,before.candidates[0].lifecycleV11.c1AiDraftRequestV1);
  for(const key of ['profitModels','selectedSupplySnapshot']) assert.deepEqual(after.candidates[0].lifecycleV11.skuPackage[key],before.candidates[0].lifecycleV11.skuPackage[key]);
}

test('v2 owner adoption is atomic and idempotent while its applied source stays unchanged',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected external call');});
  const f=await createC1CompletedEditorialFixture(),input=confirmation(f),service=useCase(f);
  const before=await f.repository.readSnapshot();
  assert.equal(before.candidates[0].lifecycleV11.skuPackage.c2FinalAssets,null);
  const outcomes=await Promise.all([service.confirm({actor:f.owner,input}),service.confirm({actor:f.owner,input})]);
  assert.deepEqual(new Set(outcomes.map(result=>result.status)),new Set(['committed','idempotent_replay']));
  const after=await f.repository.readSnapshot(),candidate=after.candidates[0],sku=candidate.lifecycleV11.skuPackage;
  assert.equal(candidate.dataRevision,f.candidate.dataRevision+1);
  assert.equal(before.candidates[0].lifecycleV11.skuPackage.dataRevision,f.bundle.request.sourceSkuRevision+1);
  assert.equal(candidate.lifecycleV11.c1EditorialContentReviewV1.editorialSkuRevision,f.bundle.request.sourceSkuRevision+2);
  assert.equal(sku.dataRevision,f.bundle.request.sourceSkuRevision+3);
  assert.equal(sku.businessPhase,'C2');assert.deepEqual(sku.c2FinalAssets.assets.finalUploads,[]);
  assert.equal(sku.c1ProductPlan.descriptionDraft.text,f.bundle.correctionPlan.items[0].correctedText);
  assert.equal(sku.c1ProductPlan.descriptionDraft.reviewZh,f.bundle.correctionPlan.items[0].correctedReviewZh);
  assert.equal(sku.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted,false);
  for(const key of ['productionAuthorization','productionRecord','externalListingRecord','eVerificationRecord']) assert.equal(sku[key],null);
  assertProtected(before,after);
  assert.equal(after.runtime.operationAudit.filter(row=>row.action==='c1_confirm_editorial_content').length,1);
  assert.equal(f.gatewayCalls(),1);
  assertC1EditorialPlan({plan:sku.c1ProductPlan,identity:sku.g1Identity,resultSkuRevision:sku.c1ProductPlan.draftOnlySeo.editorialSource.ownerConfirmation.resultSkuRevision});
  const validator=await loadPublishedSchemaValidator();
  for(const [name,value] of [['c1-product-plan-v1.1',sku.c1ProductPlan],['c2-asset-lifecycle-v1.1',sku.c2FinalAssets]]) {
    const validate=validator.getSchema(name);assert.equal(validate(value),true,JSON.stringify(validate.errors));
  }
  assert.equal((await service.confirm({actor:f.owner,input})).status,'idempotent_replay');
  assert.deepEqual(await f.repository.readSnapshot(),after);
});

test('v2 wrong owner, revision, proposal and explicit confirmation leave the complete state unchanged',async()=>{
  const f=await createC1CompletedEditorialFixture(),input=confirmation(f),service=useCase(f),before=await f.repository.readSnapshot();
  for(const actor of [{...f.owner,roles:['viewer']},{...f.owner,actorType:'worker'},{...f.owner,source:'local_worker'}]) {
    await assert.rejects(()=>service.confirm({actor,input}));assert.deepEqual(await f.repository.readSnapshot(),before);
  }
  for(const change of [{confirmed:false},{expectedRevision:input.expectedRevision-1},{editorialVersionId:'editorial:other'},
    {outputFingerprint:'0'.repeat(64)},{correctedText:'injected'}]) {
    await assert.rejects(()=>service.confirm({actor:f.owner,input:{...input,...change}}));assert.deepEqual(await f.repository.readSnapshot(),before);
  }
  await service.confirm({actor:f.owner,input});const saved=await f.repository.readSnapshot();
  await assert.rejects(()=>service.confirm({actor:{...f.owner,userId:'owner:other'},input}),/IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(),saved);
});

test('v2 source, saved facts and source version drift reject adoption without partial mutation',async()=>{
  const f=await createC1CompletedEditorialFixture(),input=confirmation(f);
  for(const mutate of [d=>d.runtime.softwareJobs[0].resultEnvelope.applicationDisposition='result_recorded_no_candidate_mutation',
    d=>d.runtime.softwareJobs[0].resultEnvelope.payloadFingerprint='0'.repeat(64),
    d=>d.candidates[0].lifecycleV11.c1AiDraftJobRefV1.jobId='job:other',
    d=>d.candidates[0].lifecycleV11.c1AiDraftRequestV1.requestFingerprint='0'.repeat(64),
    d=>d.candidates[0].lifecycleV11.skuPackage.dataRevision++,
    d=>d.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[0].fact.value='changed']) {
    const document=structuredClone(f.document);mutate(document);const repository=createMemoryBusinessStateRepository(document);
    await assert.rejects(()=>useCase(f,repository).confirm({actor:f.owner,input}));
    assert.deepEqual(await repository.readSnapshot(),document);
  }
});

test('JSON restart retains v2 adoption and persistence failure leaves original bytes and state intact',async t=>{
  const f=await createC1CompletedEditorialFixture(),input=confirmation(f);
  const directory=await mkdtemp(path.join(tmpdir(),'completed-editorial-adoption-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'state.json');await writeFile(filePath,JSON.stringify(f.document));
  const bytes=await readFile(filePath);
  const failing=createJsonBusinessStateRepository({filePath,atomicWriter:async()=>{throw new Error('SYNTHETIC_STORAGE_FAILURE');}});
  await assert.rejects(()=>useCase(f,failing).confirm({actor:f.owner,input}),/SYNTHETIC_STORAGE_FAILURE/);
  assert.deepEqual(await readFile(filePath),bytes);assert.deepEqual(await failing.readSnapshot(),f.document);
  const repository=createJsonBusinessStateRepository({filePath});await useCase(f,repository).confirm({actor:f.owner,input});
  const saved=await repository.readSnapshot(),savedBytes=await readFile(filePath),restarted=createJsonBusinessStateRepository({filePath});
  const reread=await restarted.readSnapshot();assert.deepEqual(reread,saved);assertProtected(f.document,reread);
  assert.equal(buildC1EditorialReviewView({candidate:reread.candidates[0],observedAt:f.at}).status,'confirmed');
  assert.equal((await useCase(f,restarted).confirm({actor:f.owner,input})).status,'idempotent_replay');
  assert.deepEqual(await readFile(filePath),savedBytes);
});

test('v2 adoption reuses all fifteen signed images through detached history and rejects image/history drift',async()=>{
  const {f,original}=await finalImageRevisionFixture(),input=confirmation(f);
  for(const mutate of [d=>d.c1FinalPlanRevisionHistoryRecords=[],d=>d.c1FinalPlanRevisionHistoryRecords.push(structuredClone(d.c1FinalPlanRevisionHistoryRecords[0])),
    d=>d.candidates[0].lifecycleV11.c1FinalPlanRevisionHistory[0].sourceFinalAssets.assets.finalUploads[0].sha256='f'.repeat(64)]) {
    const document=structuredClone(f.document);mutate(document);const repository=createMemoryBusinessStateRepository(document);
    await assert.rejects(()=>useCase(f,repository).confirm({actor:f.owner,input}));assert.deepEqual(await repository.readSnapshot(),document);
  }
  const outcome=await useCase(f).confirm({actor:f.owner,input}),saved=await f.repository.readSnapshot(),sku=saved.candidates[0].lifecycleV11.skuPackage;
  assert.equal(outcome.result.finalCardCreated,true);assert.equal(sku.c2FinalAssets.status,'completed');
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads,original.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads);
  assert.deepEqual(sku.c2FinalAssets.ownerFinalUploadConfirmation,original.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation);
  assert.equal(sku.c2FinalAssets.assets.finalUploads.length,15);assert.ok(sku.productionConfirmationCard);assert.equal(sku.productionAuthorization,null);
  assertProtected(f.document,saved);assert.deepEqual(saved.c1FinalPlanRevisionHistoryRecords,f.document.c1FinalPlanRevisionHistoryRecords);
  assert.equal(buildC1EditorialReviewView({candidate:saved.candidates[0],observedAt:f.at}).status,'confirmed');
});


test('v3 reference pointers and persisted OCR survive v2 adoption, fifteen-image recovery and JSON readback',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected external call');});
  const {f,original}=await finalImageRevisionFixture({withReferenceSources:true}),input=confirmation(f);
  const context=f.bundle.request.referenceContext;
  assert.equal(context.schemaVersion,'c1-seo-reference-context-v3');
  assert.equal(context.imageTextEvidence.assets.length,15);
  assert.equal(context.imageTextEvidence.role,'unverified_language_reference');
  for(const kind of ['competitor_text','competitor_description','supplier_title','supplier_variant_attribute','supplier_attribute']) {
    assert.ok(context.referenceTexts.some(row=>row.kind===kind),kind);
  }
  assert.ok(context.referenceTexts.some(row=>row.kind==='competitor_text'&&row.sourceRef.includes('Описание на русском')));
  assert.ok(context.referenceTexts.some(row=>row.kind==='supplier_title'&&row.sourceRef==='SCJ-synthetic-editorial#/title'));
  assert.ok(context.referenceTexts.some(row=>row.kind==='supplier_variant_attribute'&&row.sourceRef.includes('~1')&&row.sourceRef.includes('~0')));
  assert.ok(context.referenceTexts.some(row=>row.kind==='supplier_variant_attribute'&&row.sourceRef.endsWith('%E7%BC%96%E7%A0%81%252F')));
  assert.ok(context.referenceTexts.some(row=>row.kind==='supplier_attribute'&&row.sourceRef.includes('~1')&&row.sourceRef.includes('~0')));
  const before=await f.repository.readSnapshot();
  const outcome=await useCase(f).confirm({actor:f.owner,input});
  assert.equal(outcome.result.finalCardCreated,true);
  const saved=await f.repository.readSnapshot(),reloaded=JSON.parse(JSON.stringify(saved)),sku=reloaded.candidates[0].lifecycleV11.skuPackage;
  assert.deepEqual(sku.c1ProductPlan.draftOnlySeo.editorialSource.bundle.request,f.bundle.request);
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads,original.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads);
  assert.equal(sku.c2FinalAssets.assets.finalUploads.length,15);assert.equal(sku.c2FinalAssets.status,'completed');
  assert.ok(sku.productionConfirmationCard);assert.equal(sku.productionAuthorization,null);
  assertProtected(before,reloaded);assert.equal(f.gatewayCalls(),1);
  assert.deepEqual(reloaded.c1FinalPlanRevisionHistoryRecords,before.c1FinalPlanRevisionHistoryRecords);
  assert.doesNotThrow(()=>assertCanonicalC2ReferenceTree(sku.c2FinalAssets));
  const validator=await loadPublishedSchemaValidator();
  for(const [name,value] of [['c1-product-plan-v1.1',sku.c1ProductPlan],['c2-asset-lifecycle-v1.1',sku.c2FinalAssets],
    ['final-product-plan-confirmation-card-v1.1',sku.productionConfirmationCard]]) {
    const validate=validator.getSchema(name);assert.equal(validate(value),true,JSON.stringify(validate.errors));
  }
  const sourceRequest=sku.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.editorialSource.bundle.request;
  const roots=[[],['productionAuthorizationPreparation'],['c2FinalAssets','productionAuthorizationPreparation']];
  const containers=[['frozenC1Handoff','draftOnlySeo'],['finalCardInputSnapshot','c1Snapshot','draftOnlySeo'],
    ['finalCardInputSnapshot','canonicalC1','draftOnlySeo'],['lockedScope','finalCardInputSnapshot','c1Snapshot','draftOnlySeo'],
    ['lockedScope','finalCardInputSnapshot','canonicalC1','draftOnlySeo'],['c1','canonicalHandoff','draftOnlySeo'],
    ['draftOnlySeo'],['c1ProductPlan','draftOnlySeo'],['lifecycleV11','skuPackage','c1ProductPlan','draftOnlySeo']];
  const wrap=(segments,request)=>segments.reduceRight((value,key)=>({[key]:value}),{editorialSource:{bundle:{request}}});
  for(const root of roots) for(const container of containers) {
    assert.doesNotThrow(()=>assertCanonicalC2ReferenceTree(wrap([...root,...container],sourceRequest)),[...root,...container].join('.'));
  }
  const withoutTitle=structuredClone(sourceRequest);
  withoutTitle.referenceContext.referenceTexts=withoutTitle.referenceContext.referenceTexts.filter(row=>row.kind!=='supplier_title');
  withoutTitle.referenceContext.availability.supplierTitle='not_provided';
  assert.doesNotThrow(()=>assertCanonicalC2ReferenceTree(wrap(['draftOnlySeo'],withoutTitle)), 'variant references do not require an available supplier title');
  for(const change of [
    request=>{request.referenceContext.referenceTexts=Object.assign({},request.referenceContext.referenceTexts);},
    request=>{request.referenceContext.referenceTexts.find(row=>row.kind==='supplier_variant_attribute'&&row.sourceRef.includes('~1')).kind='competitor_text';},
    request=>{const row=request.referenceContext.referenceTexts.find(item=>item.kind==='competitor_text'&&item.sourceRef.includes('Описание'));
      row.sourceRef='evidence:other'+row.sourceRef.slice(row.sourceRef.indexOf('#'));},
    request=>{const row=request.referenceContext.referenceTexts.find(item=>item.kind==='supplier_attribute'&&item.sourceRef.includes('~1'));
      row.sourceRef='supply:other'+row.sourceRef.slice(row.sourceRef.indexOf('#'));}
  ]) {
    const changed=structuredClone(sourceRequest);change(changed);
    assert.throws(()=>assertCanonicalC2ReferenceTree(wrap(['draftOnlySeo'],changed)),/C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/);
  }
  for(const sourceRef of ['javascript:alert(1)', 'file:///private/tmp/secret', 'https://user:password@example.com/source',
    'https://127.0.0.1/private', 'https://example.com/source?token=private-value',
    'SCJ-synthetic-editorial#/skuChoices/0/attributes/../secret',
    'SCJ-synthetic-editorial#/skuChoices/0/attributes/%E4%ZZ',
    'SCJ-synthetic-editorial#/skuChoices/01/attributes/%E5%B0%BA%E7%A0%81',
    'SCJ-synthetic-editorial#/skuChoices/0/attributes/颜色~2尺寸']) {
    const changed=structuredClone(sku.c2FinalAssets);
    const rows=changed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.editorialSource.bundle.request.referenceContext.referenceTexts;
    rows.find(row=>row.kind==='supplier_variant_attribute').sourceRef=sourceRef;
    assert.throws(()=>assertCanonicalC2ReferenceTree(changed),/C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/,sourceRef);
  }
  const pointer=sourceRequest.referenceContext.referenceTexts.find(row=>row.kind==='supplier_variant_attribute'&&row.sourceRef.includes('~1')).sourceRef;
  for(const fake of [{sourceRef:pointer}, {referenceContext:{referenceTexts:[{sourceRef:pointer}]}},
    {unexpected:{draftOnlySeo:{editorialSource:{bundle:{request:sourceRequest}}}}}]) {
    assert.throws(()=>assertCanonicalC2ReferenceTree(fake),/C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/);
  }
  const repository=createMemoryBusinessStateRepository(reloaded);
  assert.equal((await useCase(f,repository).confirm({actor:f.owner,input})).status,'idempotent_replay');
  assert.deepEqual(await repository.readSnapshot(),reloaded);
});


function countNodes(value) {
  const stack=[value];let count=0;
  while(stack.length){const item=stack.pop();count++;if(item!==null&&typeof item==='object')stack.push(...Object.values(item));}
  return count;
}
function resealPreparation(c2) {
  const p=c2.productionAuthorizationPreparation;
  p.finalCardInputFingerprint=fingerprintC2FinalCardInputSnapshot(p.finalCardInputSnapshot);
  p.preparationFingerprint=fingerprintC2AuthorizationPreparation(p);
}

test('completed editorial canonical projections retain two full sources, reject resealed reference drift, and read old full snapshots unchanged',async()=>{
  const {f}=await finalImageRevisionFixture({withReferenceSources:true});
  await useCase(f).confirm({actor:f.owner,input:confirmation(f)});
  const saved=await f.repository.readSnapshot(),sku=saved.candidates[0].lifecycleV11.skuPackage;
  const p=sku.c2FinalAssets.productionAuthorizationPreparation,full=sku.c1ProductPlan.draftOnlySeo.editorialSource;
  assert.equal(full.schemaVersion,'c1-editorial-source-v2');
  assert.deepEqual(p.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.editorialSource,full);
  for(const draft of [p.frozenC1Handoff.draftOnlySeo,p.finalCardInputSnapshot.canonicalC1.draftOnlySeo]) {
    const ref=draft.editorialSource;
    assert.equal(ref.schemaVersion,'c1-editorial-source-reference-v1');
    assert.equal(ref.sourceSchemaVersion,full.schemaVersion);assert.equal(Object.hasOwn(ref,'bundle'),false);
    assert.equal(ref.requestId,full.bundle.request.requestId);assert.equal(ref.requestFingerprint,full.bundle.request.requestFingerprint);
    assert.equal(ref.sourceReceiptId,full.bundle.receipt.receiptId);assert.equal(ref.sourceSoftwareJobId,full.bundle.sourceJob.jobId);
    assert.equal(ref.sourceOutputFingerprint,full.bundle.receipt.outputFingerprint);
    assert.equal(ref.editorialVersionId,full.ownerConfirmation.editorialVersionId);
    assert.equal(ref.outputFingerprint,full.ownerConfirmation.outputFingerprint);
    assert.deepEqual(ref.ownerConfirmation,full.ownerConfirmation);
  }
  for(const change of [
    ref=>{ref.requestId='request:other';},ref=>{ref.requestFingerprint='0'.repeat(64);},ref=>{ref.sourceReceiptId='receipt:other';},
    ref=>{ref.sourceSoftwareJobId='job:other';},ref=>{ref.sourceOutputFingerprint='0'.repeat(64);},ref=>{ref.editorialVersionId='version:other';},
    ref=>{ref.outputFingerprint='0'.repeat(64);},ref=>{ref.sourceSchemaVersion='c1-editorial-source-v1';},
    ref=>{ref.ownerConfirmation.resultSkuRevision++;},ref=>{ref.ownerConfirmation.confirmedByUserId='owner:other';}
  ]) {
    const changed=structuredClone(sku.c2FinalAssets),prepared=changed.productionAuthorizationPreparation;
    for(const draft of [prepared.frozenC1Handoff.draftOnlySeo,prepared.finalCardInputSnapshot.canonicalC1.draftOnlySeo])change(draft.editorialSource);
    resealPreparation(changed);assert.equal(validateC2AssetLifecycle(changed).valid,false,change.toString());
  }
  for(const change of [source=>{delete source.bundle;},source=>{source.bundle.request.requestFingerprint='0'.repeat(64);},
    source=>{source.ownerConfirmation.resultSkuRevision++;}]) {
    const changed=structuredClone(sku.c2FinalAssets);change(changed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.editorialSource);
    resealPreparation(changed);assert.equal(validateC2AssetLifecycle(changed).valid,false);
  }
  // Reconstruct the previously published full canonical representation using the same exact source.
  // Only its documented consistency digests are recomputed; no receipt, request or authorization is changed.
  const old=structuredClone(sku),prepared=old.c2FinalAssets.productionAuthorizationPreparation;
  for(const draft of [prepared.frozenC1Handoff.draftOnlySeo,prepared.finalCardInputSnapshot.canonicalC1.draftOnlySeo])draft.editorialSource=structuredClone(full);
  resealPreparation(old.c2FinalAssets);old.productionConfirmationCard=null;
  const before=structuredClone(old);
  assert.equal(validateC2AssetLifecycle(old.c2FinalAssets).valid,true);
  const validator=await loadPublishedSchemaValidator(),validateOld=validator.getSchema('c2-asset-lifecycle-v1.1');
  assert.equal(validateOld(old.c2FinalAssets),true,JSON.stringify(validateOld.errors));
  const reread=createFinalProductPlanConfirmationCard({skuPackage:old,createdAt:p.ownerConfirmationAt}).skuPackage;
  assert.deepEqual(old,before);assert.deepEqual(reread.c2FinalAssets,old.c2FinalAssets);
  assert.deepEqual(reread.c2FinalAssets.productionAuthorizationPreparation.frozenC1Handoff.draftOnlySeo.editorialSource,full);
  assertProtected(f.document,saved);
});

test('large real-shaped reference input fits unchanged candidate bounds after canonical projection removes duplicate bundles',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected external call');});
  const {f}=await finalImageRevisionFixture({withReferenceSources:true,referenceAttributeCount:36,additionalPlatformAttributeCount:20});
  const before=await f.repository.readSnapshot();
  const outcome=await useCase(f).confirm({actor:f.owner,input:confirmation(f)});
  assert.equal(outcome.result.finalCardCreated,true);
  const saved=await f.repository.readSnapshot(),candidate=saved.candidates[0],sku=candidate.lifecycleV11.skuPackage;
  const duplicated=structuredClone(candidate),p=duplicated.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation;
  for(const draft of [p.frozenC1Handoff.draftOnlySeo,p.finalCardInputSnapshot.canonicalC1.draftOnlySeo]) {
    draft.editorialSource=structuredClone(p.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.editorialSource);
  }
  const currentNodes=countNodes(candidate),oldNodes=countNodes(duplicated);
  assert.ok(oldNodes>BUSINESS_CANDIDATE_MAX_NODES,`old four-source structure must reproduce capacity failure: ${oldNodes}`);
  assert.ok(currentNodes<=BUSINESS_CANDIDATE_MAX_NODES,`new structure: ${currentNodes}`);
  assert.ok(Buffer.byteLength(JSON.stringify(candidate))<BUSINESS_CANDIDATE_MAX_BYTES);
  assert.throws(()=>assertNoProductionSecrets(duplicated, "candidate", {resourceScope:"business_candidate"}),/BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED/);
  assert.doesNotThrow(()=>assertSafeBusinessMutationCandidate(candidate));
  assert.equal(sku.c2FinalAssets.assets.finalUploads.length,15);
  assert.deepEqual(sku.c1ProductPlan.draftOnlySeo.editorialSource.bundle.request,f.bundle.request);
  assertProtected(before,saved);assert.equal(f.gatewayCalls(),1);assert.equal(sku.productionAuthorization,null);
  t.diagnostic(`original duplicated structure ${oldNodes} nodes/${Buffer.byteLength(JSON.stringify(duplicated))} bytes; reference structure ${currentNodes} nodes/${Buffer.byteLength(JSON.stringify(candidate))} bytes`);
});
