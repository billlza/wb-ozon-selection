import { c1PaidKeywordFixtureReceipt, collectFixtureMetrics } from './c1-paid-keyword-settlement-fixture.mjs';
import { createFormalC1DraftFixture } from './formal-c1-flow-fixture.mjs';
import { produceC1KeywordPlanningEvidence } from '../../lib/c1-keyword-planning-evidence-producer.mjs';
import { prepareC1KeywordSoftwareExecution } from '../../lib/c1-keyword-software-use-case.mjs';
import { KEYWORD_NOW, keywordPlanningSourceEvidence, keywordFactBinding } from './c1-keyword-planning-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../../lib/software-job-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { enqueueC1PaidKeywordEvidenceJob } from '../../lib/c1-keyword-software-use-case.mjs';
import { runC1PaidKeywordEvidenceSoftwareJob } from '../../lib/keyword-evidence-software-runner.mjs';
import { createSoftwareExecutionRuntime, blockExecutionForTechnicalFailure } from '../../lib/software-execution-state.mjs';
import { createC1DraftRuntimeServices } from '../../lib/c1-draft-runtime-services.mjs';

export const keywordHandoffDraftBinding=Object.freeze({schemaVersion:'c1-draft-service-binding-v1',provider:'terra',modelVersion:'gpt-5.6-terra',
  credentialAlias:'gateway-alias:synthetic-retry',workerId:'worker:synthetic:c1-retry',workerVersion:'1',
  gatewayOrigin:'http://127.0.0.1:49099',configurationVersion:'configuration:synthetic-retry:1',leaseDurationMs:90000});

/** Actual enqueue, keyword settlement and known-failure reducers with explicit synthetic provider evidence. No real transport. */
export async function createC1KeywordHandoffRetryFixture({ attributeSourceGranularity = 'field' } = {}) {
  if (!['field','collection'].includes(attributeSourceGranularity)) throw new Error('RETRY_FIXTURE_SOURCE_GRANULARITY_INVALID');
  const skuAttributes=Object.fromEntries(Array.from({length:19},(_,index)=>[`keywordFact${index+1}`,`synthetic decorative train phrase ${index+1}`]));
  const candidate=structuredClone(createFormalC1DraftFixture({at:KEYWORD_NOW,salesSnapshotVersion:'sales-snapshot-v1.1',skuAttributes}).candidate);
  const sku=candidate.lifecycleV11.skuPackage,plan=sku.c1ProductPlan;
  // Each synthetic keyword describes one saved attribute, so its evidence must
  // point to that scalar. Collection-level evidence is retained explicitly for
  // the oversized historical-input regression, not used by the normal fixture.
  if (attributeSourceGranularity === 'field') {
    for (const entry of plan.productAttributes.supplierAttributes.filter(value=>value.fieldKey.startsWith('keywordFact'))) {
      const pointer=entry.fieldKey.replaceAll('~','~0').replaceAll('/','~1');
      entry.fact.sourceRefs=entry.fact.sourceRefs.map(ref=>`${ref}/${pointer}`);
    }
  }
  // Explicit synthetic keyword-query mode, supplied before planning freezes the input.
  sku.fulfillmentMode='rfbs';
  const productFactTerms=plan.productAttributes.supplierAttributes.flatMap((entry,index)=>entry.fieldKey.startsWith('keywordFact')?[{
    term:entry.fact.value,sourceRefs:[...entry.fact.sourceRefs],factRefs:[...entry.fact.sourceRefs],
    factBindings:[keywordFactBinding(`productAttributes.supplierAttributes[${index}].fact`,entry.fact.value,entry.fact.sourceRefs[0])],
    sourceTrust:'confirmed_supply',matchType:'target_fact'
  }]:[]);
  const first=productFactTerms[0];
  const evidence=keywordPlanningSourceEvidence();
  evidence.productFactTerms=productFactTerms;
  evidence.comparables=evidence.comparables.map(value=>({...value,factRefs:[...first.factRefs],factBindings:structuredClone(first.factBindings)}));
  evidence.frozenSeoRules={rulesVersion:'seo:synthetic:keyword-retry',locale:'ru-RU',titleMaxLength:120,descriptionMaxLength:1800,
    bulletPointLimit:5,prohibitedClaims:[],evidenceRef:'policy:seo:synthetic-retry',frozenAt:KEYWORD_NOW};
  let produced=produceC1KeywordPlanningEvidence({candidate,expectedRevision:candidate.dataRevision,serverEvidence:evidence,producedAt:KEYWORD_NOW});
  if(produced.status!=='ready')throw new Error(`RETRY_FIXTURE_PLANNING_NOT_READY:${JSON.stringify(produced.production.gaps)}`);
  const preview=structuredClone(candidate);preview.dataRevision=produced.evidence.binding.candidateRevision;
  preview.lifecycleV11.skuPackage=structuredClone(produced.skuPackage);preview.lifecycleV11.c1KeywordPlanningEvidenceV1=structuredClone(produced.evidence);
  const execution=prepareC1KeywordSoftwareExecution({candidate:preview,clientInput:{dataRevision:preview.dataRevision},plannedAt:KEYWORD_NOW});
  // The synthetic expected receipt uses this formal supplier SKU, matching the provider adapter's query binding.
  const metricInput=structuredClone(execution.jobRuntimeInput);
  metricInput.providerEvidence.seerfarApiReceipt=c1PaidKeywordFixtureReceipt();
  metricInput.providerEvidence.seerfarApiReceipt.attempt.queryText=sku.supplierSkuId;
  evidence.keywordMetricEvidence=await collectFixtureMetrics({candidateId:candidate.id,skuPackage:preview.lifecycleV11.skuPackage,input:metricInput});
  produced=produceC1KeywordPlanningEvidence({candidate,expectedRevision:candidate.dataRevision,serverEvidence:evidence,producedAt:KEYWORD_NOW});
  if(produced.status!=='ready')throw new Error(`RETRY_FIXTURE_METRICS_NOT_READY:${JSON.stringify(produced.production.gaps)}`);
  candidate.dataRevision=produced.evidence.binding.candidateRevision;candidate.lifecycleV11.skuPackage=structuredClone(produced.skuPackage);
  candidate.lifecycleV11.c1KeywordPlanningEvidenceV1=structuredClone(produced.evidence);
  const repository=createMemoryBusinessStateRepository({candidates:[candidate],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],
    softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}});
  const clock=()=>KEYWORD_NOW;
  const owner=createActorContext({userId:'owner-1',sessionId:'session:keyword-handoff-retry',actorType:'human',roles:['owner'],
    source:'authenticated_identity_provider',authenticatedAt:KEYWORD_NOW});
  const registry=createLocalDevelopmentWorkerRegistry({clock});
  const worker=registry.register({workerId:'worker-seerfar-open-api-1',version:'1.0.0',capabilities:['seerfar-open-api'],observedAt:KEYWORD_NOW});
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry:registry,serverClock:clock});
  const queued=await enqueueC1PaidKeywordEvidenceJob({repository,runtimeMode:'local_development',actor:owner,
    candidateId:candidate.id,expectedRevision:candidate.dataRevision,clientInput:{dataRevision:candidate.dataRevision},serverClock:clock});
  let keywordCalls=0,gatewayCalls=0;
  await runC1PaidKeywordEvidenceSoftwareJob({repository,softwareJobStore:store,worker,jobId:queued.result.softwareJobRef.jobId,
    leaseId:'lease:synthetic:keyword-handoff-retry',leaseDurationMs:60000,serverClock:clock,openApiTransport:async()=>{
      keywordCalls++;const value=c1PaidKeywordFixtureReceipt();
      return {observation:{...value.attempt,completed:true},candidates:value.candidates,pointsBefore:value.pointsBefore,
        pointsAfter:value.pointsAfter,pointsSpent:value.pointsSpent,evidence:value.providerEvidence};
    }});
  await repository.transact(document=>{
    const current=document.candidates[0],job=document.runtime.softwareJobs[0];
    current.executionRuntime=blockExecutionForTechnicalFailure(createSoftwareExecutionRuntime({candidateId:current.id,dataRevision:current.dataRevision,
      businessPhase:'C1',stepId:'C1_KEYWORD_HANDOFF',at:KEYWORD_NOW}),{
      failureId:'failure:synthetic:keyword-handoff',kind:'known_technical_failure',errorCode:'C1_DRAFT_RUNTIME_UNAVAILABLE',
      failureLayer:'c1_keyword_handoff',evidenceRefs:[job.resultRef],softwareJobId:job.jobId,sourceRevision:job.revision,at:KEYWORD_NOW});
    return {changed:true,document,result:null};
  });
  const document=await repository.readSnapshot(),job=document.runtime.softwareJobs[0];
  const input={candidateId:candidate.id,expectedRevision:document.candidates[0].dataRevision,keywordJobId:job.jobId,
    failureId:document.candidates[0].executionRuntime.technicalFailure.failureId,idempotencyKey:'retry:keyword-handoff:1',auditEventId:'audit:retry:keyword-handoff:1'};
  const createServices=(options={})=>createC1DraftRuntimeServices({repository,runtimeMode:'local_development',serverClock:clock,
    workerRegistry:createLocalDevelopmentWorkerRegistry({clock}),serviceBindings:[keywordHandoffDraftBinding],
    fetchImpl:async()=>{gatewayCalls++;throw new Error('UNEXPECTED_SYNTHETIC_GATEWAY_CALL');},...options});
  return {repository,store,owner,input,document,job,clock,createServices,counts:()=>({keywordCalls,gatewayCalls})};
}
