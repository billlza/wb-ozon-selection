import { createC1ImageTextUseCase } from '../../lib/c1-image-text-use-case.mjs';
import { createC1ContentReviewUseCase, fingerprintC1ReviewContent } from '../../lib/c1-content-review-use-case.mjs';
import { finalAssets, localFinalAssets, ownerDecision } from '../helpers/c2-software-fixture.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../../lib/c2-software-orchestrator.mjs';
import { prepareC1FinalPlanRevision } from '../../lib/c1-final-plan-revision-preparation.mjs';
import { createFinalProductPlanConfirmationCard } from '../../lib/final-product-plan-confirmation-card.mjs';
import assert from 'node:assert/strict';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './c1-local-draft-source-fixture.mjs';
import { c1DraftPaidReceipt } from './c1-draft-source-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { createC1DraftSoftwareUseCase } from '../../lib/c1-draft-software-use-case.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { validateC1AiDraftReceipt } from '../../lib/c1-ai-draft-contract.mjs';

/** A synthetic successful gateway result applied by the normal transaction.
 * The proposed edit is local test data, never another provider invocation. */
export async function createC1CompletedEditorialFixture({at=LOCAL_DRAFT_AT,sourceCandidate=null,historyRecord=null,withReferenceSources=false,referenceAttributeCount=0,additionalPlatformAttributeCount=0}={}) {
  const candidate=sourceCandidate===null?createSavedLocalPreparationCandidate({at,withReferenceSources,referenceAttributeCount,additionalPlatformAttributeCount}):structuredClone(sourceCandidate);
  if(sourceCandidate!==null) {
    const {produceC1LocalPreparation}=await import('../../lib/c1-keyword-planning-local-material.mjs');
    const prepared=produceC1LocalPreparation({candidate,expectedRevision:candidate.dataRevision,producedAt:at});
    assert.equal(prepared.status,'ready');
    candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1=structuredClone(prepared.material);
    candidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1=structuredClone(prepared.production);
    candidate.dataRevision+=1;
  }
  const repository=createMemoryBusinessStateRepository({meta:{version:2,automationStarted:false},rules:{},evidencePacks:[],dispatches:[],
    candidates:[candidate],c1FinalPlanRevisionHistoryRecords:historyRecord?[historyRecord]:[],
    runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],softwareJobCredentialBindings:[]}});
  const owner=createActorContext({userId:'owner:synthetic:completed-editorial',sessionId:'session:synthetic:completed-editorial-owner',
    actorType:'human',roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:at});
  const worker=createActorContext({userId:'worker:synthetic:completed-editorial',sessionId:'session:synthetic:completed-editorial-worker',
    actorType:'worker',roles:['operator'],source:'local_worker',authenticatedAt:at});
  const workerRegistry=createLocalDevelopmentWorkerRegistry({clock:()=>at});
  workerRegistry.register({workerId:worker.userId,version:'1',capabilities:['ai-draft-gateway'],observedAt:at});
  let gatewayCalls=0;
  const useCase=createC1DraftSoftwareUseCase({repository,runtimeMode:'local_development',serverClock:()=>at,workerRegistry,
    executionBinding:{provider:'terra',modelVersion:'gpt-5.6-terra',credentialAlias:'gateway-alias:synthetic:completed-editorial',allowedWorkerIds:[worker.userId]},
    requestGateway:async({request,authorizedExecution,onGatewayJobAccepted})=>{
      gatewayCalls++;
      const receipt=c1DraftPaidReceipt({request,authorizedExecution},at);
      assert.equal(validateC1AiDraftReceipt({request,receipt}).valid,true);
      await onGatewayJobAccepted({gatewayJobId:receipt.gatewayJobId});
      return {status:'receipt_ready',request,receipt,jobId:receipt.gatewayJobId};
    }});
  const prepared=await useCase.prepareLocal({actor:owner,input:{candidateId:candidate.id,expectedRevision:candidate.dataRevision,
    idempotencyKey:'completed-editorial:prepare',auditEventId:'completed-editorial:prepare-audit'}});
  const request=prepared.result.request;
  const enqueued=await useCase.authorizeAndEnqueue({actor:owner,input:{candidateId:candidate.id,expectedRevision:prepared.candidate.dataRevision,
    requestRef:request.requestId,requestFingerprint:request.requestFingerprint,confirmPaidCall:true,expiresAt:null,
    idempotencyKey:'completed-editorial:authorize',auditEventId:'completed-editorial:authorize-audit'}});
  const jobId=enqueued.result.softwareJobRef.jobId;
  const outcome=await useCase.run({actor:worker,input:{jobId,leaseId:'lease:synthetic:completed-editorial',leaseDurationMs:90000}});
  assert.equal(outcome.status,'receipt_saved');
  await useCase.apply({actor:worker,input:{jobId,payloadFingerprint:outcome.job.resultEnvelope.payloadFingerprint,
    expectedRevision:outcome.job.revision,idempotencyKey:'completed-editorial:apply',auditEventId:'completed-editorial:apply-audit'}});
  const document=await repository.readSnapshot();
  const sourceJob=document.runtime.softwareJobs.find(job=>job.jobId===jobId);
  assert.equal(sourceJob.status,'completed');
  assert.equal(sourceJob.externalRequestState,'succeeded');
  assert.equal(sourceJob.resultEnvelope.applicationDisposition,'applied');
  const receipt=sourceJob.resultEnvelope.payload.receipt;
  const original=receipt.output.description;
  const addedFact=request.verifiedFacts.find(fact=>!original.factRefs.includes(fact.factPath)&&
    fact.factPath.startsWith('productAttributes.ozonAttributes.')&&typeof fact.value?.value==='string');
  assert.ok(addedFact,'Fixture needs a confirmed unused attribute in the same request');
  const factPaths=[...original.factRefs,addedFact.factPath];
  const sourceRefs=[...new Set(factPaths.flatMap(factPath=>request.verifiedFacts.find(fact=>fact.factPath===factPath).evidenceRefs))];
  const correctionPlan={schemaVersion:'c1-draft-editorial-plan-v2',requestFingerprint:request.requestFingerprint,
    sourceOutputFingerprint:receipt.outputFingerprint,sourceSoftwareJobId:jobId,items:[{
      path:'output.description',originalText:original.text,originalReviewZh:original.reviewZh,
      originalFactRefs:structuredClone(original.factRefs),originalAssertions:structuredClone(original.assertions),
      correctedText:`${original.text}. ${addedFact.value.value}.`,correctedReviewZh:`${original.reviewZh}；补充已确认属性的测试释义。`,
      factPaths,sourceRefs,explanation:'Synthetic partial edit adds one unused fact from the same frozen request.'
    }]};
  return {at,repository,document,candidate:document.candidates[0],owner,addedFact,gatewayCalls:()=>gatewayCalls,
    bundle:{request:structuredClone(request),receipt:structuredClone(receipt),sourceJob:structuredClone(sourceJob),correctionPlan}};
}

export async function finalImageRevisionFixture({withReferenceSources=false,referenceAttributeCount=0,additionalPlatformAttributeCount=0}={}) {
  const original=await createC1CompletedEditorialFixture({withReferenceSources,referenceAttributeCount,additionalPlatformAttributeCount});
  const content=createC1ContentReviewUseCase({repository:original.repository,runtimeMode:'local_development',serverClock:()=>original.at});
  await content.confirm({actor:original.owner,input:{candidateId:original.candidate.id,expectedRevision:original.candidate.dataRevision,
    contentFingerprint:fingerprintC1ReviewContent(original.candidate.lifecycleV11.skuPackage),confirmed:true,
    idempotencyKey:'completed-source:content',auditEventId:'completed-source:content-audit'}});
  let candidate=(await original.repository.readSnapshot()).candidates[0];
  const sku=candidate.lifecycleV11.skuPackage;
  const images=Array.from({length:15},(_,index)=>({...structuredClone(finalAssets()[index===0?0:1]),assetId:`final:synthetic:editorial:${index+1}`,
    assetRef:`https://assets.example.com/editorial/${index+1}.jpg`,sha256:(index+1).toString(16).padStart(64,'0'),order:index+1}));
  if (withReferenceSources) {
    for (const [index, asset] of images.entries()) {
      const assetId = `c2-local:00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      Object.assign(asset, structuredClone(localFinalAssets()[index === 0 ? 0 : 1]), { assetId, assetRef: `local-asset:${assetId}`,
        sha256: (index+1).toString(16).padStart(64,'0'), order:index+1 });
      asset.assetVersion = `sha256:${asset.sha256}`;
    }
  }
  const manifest=prepareC2FinalUploadManifest({skuPackage:sku,expectedDataRevision:sku.dataRevision,finalUploadAssets:images,preparedAt:original.at});
  const confirmed=confirmC2SoftwareFinalUploads({skuPackage:sku,expectedDataRevision:sku.dataRevision,finalManifest:manifest,ownerDecision:ownerDecision(manifest),confirmedAt:original.at});
  candidate.lifecycleV11.skuPackage=structuredClone(createFinalProductPlanConfirmationCard({skuPackage:confirmed.skuPackage,createdAt:original.at}).skuPackage);
  candidate.targetPlatform='ozon';
  if (!withReferenceSources) delete candidate.sourceCapture;
  else {
    const c2 = candidate.lifecycleV11.skuPackage.c2FinalAssets, preparation = c2.productionAuthorizationPreparation;
    candidate.lifecycleV11.c2UploadDraft = { schemaVersion:'c2-upload-draft-v1',candidateId:candidate.id,skuPackageId:sku.skuPackageId,
      sourceCandidateRevision:candidate.dataRevision,sourceSkuRevision:candidate.lifecycleV11.skuPackage.dataRevision,
      sourceC1Fingerprint:preparation.sourceC1Fingerprint,schemaEvidenceRef:preparation.targetContext.schemaEvidenceRef,revision:1,
      uploads:c2.assets.finalUploads.map(asset=>({...structuredClone(asset),status:'ready'})),
      selection:c2.assets.finalUploads.map(asset=>({assetId:asset.assetId,order:asset.order})) };
    await original.repository.transact(document=>{document.candidates[0]=candidate;return {changed:true,document,result:null};});
    const ocr=createC1ImageTextUseCase({repository:original.repository,runtimeMode:'local_development',serverClock:()=>original.at,
      assetStore:{async read(){return {body:Buffer.from('synthetic image bytes')};}},
      extractor:{version:'synthetic-ocr-reference-v1',async extract(){return {text:'Синтетический текст изображения',language:'ru-RU'};}}});
    const extracted=await ocr.extract({actor:original.owner,input:{candidateId:candidate.id,expectedRevision:candidate.dataRevision}});
    assert.equal(extracted.result.status,'completed');
    candidate=(await original.repository.readSnapshot()).candidates[0];
  }
  const revision=prepareC1FinalPlanRevision({candidate,expectedRevision:candidate.dataRevision,preparedAt:original.at});
  const f=await createC1CompletedEditorialFixture({at:original.at,sourceCandidate:revision.candidate,historyRecord:revision.historyRecord});
  return {f,original:candidate};
}
