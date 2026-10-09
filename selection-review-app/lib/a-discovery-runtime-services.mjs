import { resolveSeerfarDiscoveryEvidence, SeerfarDiscoveryContractError, SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES } from './seerfar-discovery-contract.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { authorizeOperation } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { normalizeADiscoveryServiceBindings, assertADiscoveryConnectorBinding } from './runtime-configuration.mjs';
import { A_DISCOVERY_JOB_TYPE, getADiscoveryProviderCapability, readADiscoveryMarketResult, ADiscoveryError, assertADiscoveryPlan, assertADiscoveryBatch,
  assertADiscoveryScope, assertADiscoveryAuthorization, assertADiscoveryCredential, assertADiscoveryReceipt } from './a-discovery-contract.mjs';
import { createADiscoveryJobForScope, ADiscoveryExecutionBlockedError } from './software-job-repository.mjs';
import { runADiscoverySoftwareJob } from './a-discovery-software-runner.mjs';
import { assertADiscoveryCandidateImportRecord, assertADiscoveryCandidateSelectionRecord } from './a-discovery-candidate-import.mjs';
import { readDiscoveryTitleTranslations, attachDiscoveryTitleTranslations, readADiscoveryBatchMarketProducts } from './discovery-title-translation-store.mjs';
import { readADiscoveryEstimates, attachADiscoveryEstimates, readADiscoveryEstimateOutcome } from './a-discovery-estimate-store.mjs';

const clone=value=>structuredClone(value);
const closed=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const requireValue=(value,code)=>{if(!value)throw new ADiscoveryError(code);};

export const A_DISCOVERY_DECLINE_SCHEMA_VERSION='a-discovery-decline-v1';
export const A_DISCOVERY_DECLINE_COLLECTION='aDiscoveryDeclines';
/** The owner picks one of these words and nothing else; a free-text reason is not offered anywhere. */
export const A_DISCOVERY_DECLINE_REASONS=Object.freeze(['尺寸太大','利润太薄','品牌风险','不想做这类','其他']);
export const aDiscoveryDeclineKey=({batchId,revision,marketProductId})=>`${batchId}:${revision}:${marketProductId}`;
/** A round is in flight while its job has not finished, and while a just-created round is still waiting to be started. */
export const ROUND_IN_FLIGHT_JOB_STATUSES=Object.freeze(['queued','claimed','waiting_platform']);
export const ROUND_RESUMABLE_WINDOW_MS=10*60*1000;

/**
 * One saved "not this one" per market product and batch revision.
 * These records are the memory the future AI selection layer reads: they are the only place the owner's own reason for
 * turning a product down is kept, so a later automatic pass can apply the owner's taste instead of re-asking.
 */
export function assertADiscoveryDeclineRecord(record,{batchId,revision,marketProductId}){
  requireValue(closed(record,['schemaVersion','batchId','revision','marketProductId','reason','declinedByUserId','declinedAt'])&&
    record.schemaVersion===A_DISCOVERY_DECLINE_SCHEMA_VERSION&&record.batchId===batchId&&isCanonicalFrozenRef(batchId)&&
    record.revision===revision&&Number.isSafeInteger(revision)&&revision>=0&&
    record.marketProductId===marketProductId&&typeof marketProductId==='string'&&/^[1-9][0-9]*$/.test(marketProductId)&&
    typeof record.reason==='string'&&record.reason.length<=40&&A_DISCOVERY_DECLINE_REASONS.includes(record.reason)&&
    typeof record.declinedByUserId==='string'&&record.declinedByUserId!==''&&
    typeof record.declinedAt==='string'&&Number.isFinite(Date.parse(record.declinedAt)),'DECLINE_RECORD_INVALID');
  return clone(record);
}
const supportsPlan=(service,plan)=>service.connector.provider===plan.provider&&service.connector.contractVersion===plan.contractVersion&&
  (plan.provider!=='seerfar'||service.connector.budgetPolicyRef===plan.budget.policyRef)&&plan.requests.every(request=>service.connector.allowedMethods.includes(request.method));
function owner(actor){
  authorizeOperation({actor,requiredRoles:['owner']});
  requireValue(actor.actorType==='human'&&actor.source==='authenticated_identity_provider','AUTHENTICATED_OWNER_REQUIRED');
}
function collection(document,key,array=false){
  const value=readCollection(document,key,array);
  if(!Object.hasOwn(document,'runtime'))document.runtime={};
  if(!Object.hasOwn(document.runtime,key))document.runtime[key]=value;
  return value;
}
function readCollection(document,key,array=false){
  if(!Object.hasOwn(document,'runtime'))return array?[]:{};
  requireValue(document.runtime!==null&&typeof document.runtime==='object'&&!Array.isArray(document.runtime),'REPOSITORY_INVALID');
  if(!Object.hasOwn(document.runtime,key))return array?[]:{};
  const value=document.runtime[key];
  requireValue(array?Array.isArray(value):value!==null&&typeof value==='object'&&!Array.isArray(value),'REPOSITORY_INVALID');return value;
}

/** Saved plans and one-use jobs share the existing repository and worker queue. */
export function createADiscoveryRuntimeServices({repository,softwareJobStore,runtimeMode,serverClock,workerRegistry,
  serviceBindings=[],connectorBindings=[],plans=[],getEvidenceRecords=()=>[],readSecret,fetchImpl,onError,onBatchReady,onSelectProduct=null,sleep}={}){
  if(runtimeMode==='local_development')assertBusinessStateRepositoryBoundary(repository);
  else if(['central_test','central_production'].includes(runtimeMode))assertCentralPersistenceBoundary(repository);
  else throw new TypeError('A_DISCOVERY_RUNTIME_MODE_INVALID');
  if(typeof serverClock!=='function'||typeof readSecret!=='function'||typeof fetchImpl!=='function'||typeof onError!=='function'||typeof onBatchReady!=='function'||
    ['register','heartbeat'].some(key=>typeof workerRegistry?.[key]!=='function')||
    ['get','claim','listAssignableWithDiagnostics','enqueueADiscoveryInDocument','assertADiscoveryExecutionInDocument','settleADiscoveryInDocument'].some(key=>typeof softwareJobStore?.[key]!=='function'))throw new TypeError('A_DISCOVERY_SERVICE_DEPENDENCY_INVALID');
  requireValue(typeof getEvidenceRecords==='function','RUNNER_DEPENDENCY_INVALID');
  if(onSelectProduct!==null&&typeof onSelectProduct!=='function')throw new TypeError('A_DISCOVERY_SERVICE_DEPENDENCY_INVALID');
  const connectors=connectorBindings.map(assertADiscoveryConnectorBinding),bindings=normalizeADiscoveryServiceBindings(serviceBindings,connectors);
  requireValue(Array.isArray(plans)&&plans.length<=10,'PLAN_INVALID');
  const savedPlans=plans.map(assertADiscoveryPlan);
  requireValue(new Set(savedPlans.map(plan=>`${plan.planId}\n${plan.version}`)).size===savedPlans.length,'PLAN_INVALID');
  const services=bindings.map(binding=>{
    const connector=connectors.find(value=>value.bindingId===binding.connectorBindingId&&value.configurationVersion===binding.connectorConfigurationVersion);
    const worker={workerId:binding.workerId,version:binding.workerVersion,capabilities:[getADiscoveryProviderCapability(connector.provider,connector.contractVersion)]};
    workerRegistry.register({...worker,observedAt:serverClock()});
    return {binding,worker,connector};
  });
  function evidenceBlocker(plan) {
    if(plan.provider!=='seerfar')return null;
    try {resolveSeerfarDiscoveryEvidence({records:getEvidenceRecords(),request:plan.requests[0],budget:plan.budget,now:serverClock()});return null;}
    catch(error){if(error instanceof SeerfarDiscoveryContractError&&error.code.startsWith('EVIDENCE_'))return error.code;throw error;}
  }
  function batchConfigurationBlocker(batch){return batchPlanAvailable(batch)?evidenceBlocker(batch.plan):'PLAN_NOT_CONFIGURED';}
  function batchPlanAvailable(batch) {
    return savedPlans.some(plan=>isDeepStrictEqual(plan,batch.plan))&&services.some(service=>
      service.connector.bindingId===batch.bindingId&&service.connector.configurationVersion===batch.configurationVersion&&
      service.connector.credentialAlias===batch.credentialAlias&&service.connector.budgetPolicyRef===batch.budgetPolicyRef&&
      supportsPlan(service,batch.plan));
  }
  let active=null,activeExecution=null,lastAdmissionRejection=null,started=false,timer=null,failed=false,notificationError=null;
  const controllers=new Set();
  const heartbeat=service=>workerRegistry.heartbeat({...service.worker,status:'online'});
  function serviceFor(bindingId,configurationVersion){
    const matches=services.filter(value=>value.connector.bindingId===bindingId&&value.connector.configurationVersion===configurationVersion);
    requireValue(matches.length===1,'SERVICE_NOT_CONFIGURED');return matches[0];
  }
  function batchFor(document,batchId,actor){
    const batch=readCollection(document,'aDiscoveryBatches')[batchId];requireValue(batch!==undefined,'BATCH_REQUIRED');
    assertADiscoveryBatch(batch);requireValue(batch.ownerUserId===actor.userId,'OWNER_CONFLICT');return batch;
  }
  function singleflight(operation){if(active)return active;active=operation().catch(error=>{failed=true;throw error;}).finally(()=>{active=null;});return active;}
  async function continueReadyBatch(batchId=null){
    const document=await repository.readSnapshot(),receipts=readCollection(document,'aDiscoveryReceipts'),imports=readCollection(document,'aDiscoveryCandidateImports');
    for(const job of readCollection(document,'softwareJobs',true)){
      if(job.jobType!==A_DISCOVERY_JOB_TYPE||job.status!=='completed'||job.externalRequestState!=='succeeded'||batchId!==null&&job.subject.batchId!==batchId)continue;
      const batch=assertADiscoveryBatch(document.runtime.aDiscoveryBatches[job.subject.batchId]);
      if(job.revision!==batch.revision||job.scopeBinding.requestIndex!==batch.plan.requests.length-1)continue;
      if(Object.hasOwn(imports,`${batch.batchId}:${batch.revision}`)){
        assertADiscoveryCandidateImportRecord(imports[`${batch.batchId}:${batch.revision}`],{batchId:batch.batchId,revision:batch.revision});continue;
      }
      const all=readCollection(document,'softwareJobs',true).filter(value=>value.jobType===A_DISCOVERY_JOB_TYPE&&value.subject.batchId===batch.batchId&&value.revision===batch.revision);
      if(all.length!==batch.plan.requests.length||!all.every(value=>value.status==='completed'&&value.externalRequestState==='succeeded'))continue;
      for(const value of all)assertADiscoveryScope(value.scopeBinding,value);
      if(!all.every(value=>readADiscoveryMarketResult(assertADiscoveryReceipt(receipts[value.jobId],value)).status==='candidates_found'))continue;
      return onBatchReady({batchId:batch.batchId,revision:batch.revision});
    }
    return null;
  }
  async function runSelected(service,job){
    const currentJob=await softwareJobStore.get(job.jobId);
    if(currentJob?.status==='queued'&&currentJob.attempt===0&&currentJob.externalRequestState==='not_sent'){
      const document=await repository.readSnapshot();
      const batch=assertADiscoveryBatch(readCollection(document,'aDiscoveryBatches')[currentJob.subject.batchId]);
      const blocker=batchConfigurationBlocker(batch);
      if(blocker!==null){
        lastAdmissionRejection={jobId:job.jobId,code:`A_DISCOVERY_${blocker}`};
        return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};
      }
    }
    const leaseId=`lease:a-discovery:${randomUUID()}`,controller=new AbortController();controllers.add(controller);
    activeExecution={jobId:job.jobId,workerId:service.worker.workerId,leaseId};
    try{
      const result=await runADiscoverySoftwareJob({repository,softwareJobStore,worker:heartbeat(service),jobId:job.jobId,leaseId,
        leaseDurationMs:service.binding.leaseDurationMs,connectorBinding:service.connector,getEvidenceRecords,readSecret,fetchImpl,serverClock,sleep,signal:controller.signal});
      lastAdmissionRejection=null;
      if(result.status==='completed'){
        const imported=await continueReadyBatch(job.subject.batchId);
        if(imported!==null)return {...result,candidateImport:imported};
      }
      return result;
    }catch(error){
      if(error instanceof SeerfarDiscoveryContractError&&SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES.includes(error.code)){
        lastAdmissionRejection={jobId:job.jobId,code:`A_DISCOVERY_${error.code}`};return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};
      }
      if(error instanceof ADiscoveryExecutionBlockedError){lastAdmissionRejection={jobId:job.jobId,code:error.code};return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};}
      failed=true;throw error;
    }finally{controllers.delete(controller);activeExecution=null;}
  }
  function runDue(){return singleflight(async()=>{
    if(failed)return {status:'failed',externalRequests:0};
    if(services.length===0)return {status:'not_configured',externalRequests:0};
    const imported=await continueReadyBatch();
    if(imported!==null)return {status:'continued',candidateImport:imported,externalRequests:0};
    for(const service of services){
      const {assignable,rejected}=await softwareJobStore.listAssignableWithDiagnostics({worker:heartbeat(service),jobType:A_DISCOVERY_JOB_TYPE,limit:1});
      if(assignable.length)return runSelected(service,assignable[0]);
      if(rejected.length){lastAdmissionRejection=clone(rejected[0]);return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};}
    }
    return {status:'idle',externalRequests:0};
  });}
  /** The plan and service one round would use. Reading configuration creates nothing and spends nothing. */
  function plannedRound(input){
    const service=serviceFor(input.bindingId,input.configurationVersion),plan=savedPlans.find(value=>value.planId===input.planId&&value.version===input.planVersion);
    requireValue(plan!==undefined&&supportsPlan(service,plan),'PLAN_NOT_CONFIGURED');
    const blocker=evidenceBlocker(plan);requireValue(blocker===null,blocker);
    return {service,plan};
  }
  /**
   * One store queries one direction once at a time. A round whose job is still queued or running, and a round that was
   * just created and is waiting to be started from the desk, both mean the owner's question is already being answered:
   * opening a second batch for it would spend the points twice. Owner incident 2026-09-11: a lost answer to one click
   * made the next click open a second round. The saved round is refused, not replaced — every resume path still works,
   * because a repeated idempotency key names the existing batch and never reaches this check.
   */
  function assertNoRoundInFlight({document,actor,targetStore,planId,batchId}){
    const batches=readCollection(document,'aDiscoveryBatches'),jobs=readCollection(document,'softwareJobs',true),at=Date.parse(serverClock());
    for(const [id,saved] of Object.entries(batches)){
      if(id===batchId)continue;
      const batch=assertADiscoveryBatch(saved);
      if(batch.ownerUserId!==actor.userId||batch.targetStore!==targetStore||batch.plan.planId!==planId)continue;
      const own=jobs.filter(job=>job.jobType===A_DISCOVERY_JOB_TYPE&&job.subject?.batchId===batch.batchId);
      requireValue(!own.some(job=>ROUND_IN_FLIGHT_JOB_STATUSES.includes(job.status)),'ROUND_ALREADY_RUNNING');
      requireValue(own.length>0||!Number.isFinite(at)||at-Date.parse(batch.createdAt)>=ROUND_RESUMABLE_WINDOW_MS,'ROUND_ALREADY_RUNNING');
    }
  }
  /**
   * One saved batch per idempotency key, written into the caller's transaction. The same key always names the same
   * batch, so a repeated click resumes the round it already paid for instead of opening a second one.
   */
  function saveBatchInDocument({document,actor,input,plan,service}){
    const batchId=`a-discovery-batch:${fingerprintCanonicalRecord({ownerUserId:actor.userId,idempotencyKey:input.idempotencyKey})}`;
    const batches=collection(document,'aDiscoveryBatches'),exists=Object.hasOwn(batches,batchId),existing=exists?assertADiscoveryBatch(batches[batchId]):null;
    if(!exists)assertNoRoundInFlight({document,actor,targetStore:input.targetStore,planId:plan.planId,batchId});
    collection(document,'aDiscoveryReceipts');
    const batch=assertADiscoveryBatch({schemaVersion:plan.provider==='seerfar'?'a-discovery-batch-v2':'a-discovery-batch-v1',batchId,revision:0,ownerUserId:actor.userId,
      createdAt:exists?existing.createdAt:serverClock(),plan:clone(plan),targetStore:input.targetStore,bindingId:service.connector.bindingId,
      configurationVersion:service.connector.configurationVersion,credentialAlias:service.connector.credentialAlias,budgetPolicyRef:service.connector.budgetPolicyRef});
    if(exists){requireValue(isDeepStrictEqual(existing,batch),'IDEMPOTENCY_CONFLICT');return {batch:existing,created:false};}
    batches[batchId]=batch;return {batch,created:true};
  }
  /**
   * The one-use permits, credential bindings and first job of one saved batch, written into the caller's transaction.
   * The two-step card and the desk's single click share this function, so a round carries the same saved records
   * whichever way it was authorized; an already authorized batch returns its saved job and authorizes nothing again.
   */
  function authorizeBatchInDocument({document,batch,actor,expiresAt,idempotencyKey}){
    const service=serviceFor(batch.bindingId,batch.configurationVersion),at=serverClock();requireValue(Date.parse(expiresAt)>Date.parse(at),'AUTHORIZATION_EXPIRED');
    const authorizations=collection(document,'softwareJobAuthorizationRecords',true),credentials=collection(document,'softwareJobCredentialBindings',true);
    const scoped=authorizations.filter(value=>value.action===A_DISCOVERY_JOB_TYPE&&value.scopeBinding.batchId===batch.batchId&&value.scopeBinding.sourceRevision===batch.revision);
    const records=batch.plan.requests.map((request,requestIndex)=>{
      const authorizationRef=`a-discovery-permit:${fingerprintCanonicalRecord({batchId:batch.batchId,revision:batch.revision,requestIndex,idempotencyKey,ownerUserId:actor.userId})}`;
      const scope=assertADiscoveryScope({schemaVersion:batch.plan.provider==='seerfar'?'a-discovery-scope-v2':'a-discovery-scope-v1',
        ...(batch.plan.provider==='seerfar'?{provider:'seerfar',contractVersion:batch.plan.contractVersion,budget:clone(batch.plan.budget)}:{}),batchId:batch.batchId,sourceRevision:batch.revision,resultRevision:batch.revision,
        planId:batch.plan.planId,planVersion:batch.plan.version,requestIndex,request:clone(request),bindingId:batch.bindingId,configurationVersion:batch.configurationVersion,
        credentialAlias:batch.credentialAlias,budgetPolicyRef:batch.budgetPolicyRef,targetStore:batch.targetStore,authorizationRef,expiresAt});
      return {scope,authorization:assertADiscoveryAuthorization({schemaVersion:'software-job-authorization-record-v3',authorizationId:authorizationRef,
        authorizationType:batch.plan.provider==='seerfar'?'a_seerfar_discovery_once':'a_discovery_once',status:'active',action:A_DISCOVERY_JOB_TYPE,scopeBinding:scope,authorizedByUserId:actor.userId,authorizedAt:at,expiresAt,
        maxUses:1,useCount:0,consumedByJobId:null,consumedAt:null}),credential:assertADiscoveryCredential({schemaVersion:'software-job-credential-binding-v3',
        bindingId:`a-discovery-credential:${authorizationRef.slice('a-discovery-permit:'.length)}`,credentialAlias:batch.credentialAlias,status:'active',provider:batch.plan.provider,
        sideEffectScope:A_DISCOVERY_JOB_TYPE,scopeBinding:scope,allowedWorkerIds:[service.worker.workerId],redaction:'credential_alias_only',boundAt:at,expiresAt})};
    });
    if(scoped.length){
      requireValue(scoped.length===records.length&&records.every(record=>scoped.some(value=>value.authorizationId===record.scope.authorizationRef&&isDeepStrictEqual(value.scopeBinding,record.scope))),'ALREADY_AUTHORIZED');
      const first=document.runtime.softwareJobs.find(job=>job.jobType===A_DISCOVERY_JOB_TYPE&&job.scopeBinding.authorizationRef===records[0].scope.authorizationRef);
      requireValue(first!==undefined,'JOB_SOURCE_CONFLICT');return {changed:false,job:clone(first),serviceBindingId:service.binding.serviceId};
    }
    const blocker=batchConfigurationBlocker(batch);requireValue(blocker===null,blocker);
    for(const record of records){authorizations.push(record.authorization);credentials.push(record.credential);}
    const job=softwareJobStore.enqueueADiscoveryInDocument({document,job:createADiscoveryJobForScope({scope:records[0].scope,ownerUserId:actor.userId,createdAt:at}),observedAt:at});
    return {changed:true,job:clone(job),serviceBindingId:service.binding.serviceId};
  }
  /** Runs the job this call just authorized, exactly as the pump would; a busy service leaves it queued. */
  function runAuthorized({job,serviceBindingId}){
    if(active&&activeExecution?.jobId!==job.jobId)return null;
    return singleflight(()=>runSelected(services.find(value=>value.binding.serviceId===serviceBindingId),job));
  }
  function schedule(){
    if(!started)return;
    timer=setTimeout(async()=>{
      timer=null;
      try{await runDue();}catch(error){started=false;failed=true;try{await onError(error);}catch(cause){notificationError=cause;}return;}
      schedule();
    },bindings[0].pumpIntervalMs);
    timer.unref?.();
  }
  return Object.freeze({
    get status(){return failed?'failed':started?'running':services.length?'stopped':'not_configured';},
    get activeExecution(){return clone(activeExecution);},get lastAdmissionRejection(){return clone(lastAdmissionRejection);},get notificationError(){return notificationError;},
    configurationView:clone(bindings),runDue,
    view({document,actor}){
      owner(actor);
      const batches=Object.values(readCollection(document,'aDiscoveryBatches')).map(assertADiscoveryBatch).filter(batch=>batch.ownerUserId===actor.userId);
      const jobs=readCollection(document,'softwareJobs',true),receipts=readCollection(document,'aDiscoveryReceipts'),imports=readCollection(document,'aDiscoveryCandidateImports'),selections=readCollection(document,'aDiscoveryCandidateSelections');
      const declines=readCollection(document,A_DISCOVERY_DECLINE_COLLECTION);
      const candidates=Array.isArray(document.candidates)?document.candidates:[];
      // Display-only Chinese titles ride along on the view's receipt clones; the saved receipts keep the provider's own title.
      const titleTranslations=readDiscoveryTitleTranslations(document);
      // Saved estimates ride along the same way: display-only numbers on the view's receipt clone, never on the saved receipt.
      const estimates=readADiscoveryEstimates(document);
      const configurationBlockers=[];
      if(savedPlans.length===0)configurationBlockers.push('PLAN_NOT_CONFIGURED');
      if(connectors.length===0)configurationBlockers.push('CONNECTOR_NOT_CONFIGURED');
      if(services.length===0)configurationBlockers.push('SERVICE_NOT_CONFIGURED');
      const compatiblePlans=savedPlans.filter(plan=>services.some(service=>supportsPlan(service,plan)));
      const preparablePlans=compatiblePlans.filter(plan=>evidenceBlocker(plan)===null);
      if(savedPlans.length>0&&services.length>0&&compatiblePlans.length===0)configurationBlockers.push('PLAN_NOT_SUPPORTED');
      if(compatiblePlans.length>0&&preparablePlans.length===0)configurationBlockers.push(...new Set(compatiblePlans.map(evidenceBlocker)));
      return {schemaVersion:'a-discovery-view-v1',plans:clone(preparablePlans),bindings:services.map(({connector})=>({bindingId:connector.bindingId,configurationVersion:connector.configurationVersion})),
        canPrepare:configurationBlockers.length===0,configurationBlockers,
        targetStores:['miska','dandanshu'],batches:batches.slice(-100).map(batch=>{
          const current=jobs.filter(job=>job.jobType===A_DISCOVERY_JOB_TYPE&&job.subject.batchId===batch.batchId);
          const routeAvailable=services.some(value=>value.connector.bindingId===batch.bindingId&&value.connector.configurationVersion===batch.configurationVersion);
          const key=`${batch.batchId}:${batch.revision}`;
          const prefix=`${key}:`;
          const batchSelections=Object.entries(selections).filter(([id])=>id.startsWith(prefix)).map(([id,record])=>assertADiscoveryCandidateSelectionRecord(record,{batchId:batch.batchId,revision:batch.revision,marketProductId:id.slice(prefix.length)}));
          const batchDeclines=Object.entries(declines).filter(([id])=>id.startsWith(prefix)).map(([id,record])=>assertADiscoveryDeclineRecord(record,{batchId:batch.batchId,revision:batch.revision,marketProductId:id.slice(prefix.length)}));
          const importedCandidates=candidates.filter(candidate=>[candidate.aDiscoveryEvidenceV1,candidate.aDiscoveryEvidenceV2].some(evidence=>evidence?.batchId===batch.batchId))
            .map(candidate=>({candidateId:candidate.id,marketProductId:(candidate.aDiscoveryEvidenceV2??candidate.aDiscoveryEvidenceV1).marketProductId}));
          return {batch:clone(batch),candidateImport:Object.hasOwn(imports,key)?assertADiscoveryCandidateImportRecord(imports[key],{batchId:batch.batchId,revision:batch.revision}):null,
            selections:batchSelections,importedCandidates,declines:batchDeclines,
            jobs:current.map(job=>({job:clone(job),receipt:Object.hasOwn(receipts,job.jobId)?attachADiscoveryEstimates(
              attachDiscoveryTitleTranslations(assertADiscoveryReceipt(receipts[job.jobId],job),titleTranslations),estimates,{batchId:batch.batchId,revision:batch.revision}):null,
              canContinue:job.status==='queued'&&job.attempt===0&&job.externalRequestState==='not_sent'&&job.revision===batch.revision&&routeAvailable&&batchConfigurationBlocker(batch)===null&&Date.parse(serverClock())<Date.parse(job.scopeBinding.expiresAt)})),
            canAuthorize:current.length===0&&batchConfigurationBlocker(batch)===null,
            configurationBlocker:current.length===0||current.some(job=>job.status==='queued'&&job.attempt===0&&job.externalRequestState==='not_sent')?batchConfigurationBlocker(batch):null};
        }),hasMore:batches.length>100,runtimeStatus:failed?'failed':started?'running':services.length?'stopped':'not_configured',activeExecution:clone(activeExecution),
        lastAdmissionRejection:clone(lastAdmissionRejection),platformWrites:0};
    },
    async createBatch({actor,input}){
      owner(actor);requireValue(closed(input,['planId','planVersion','targetStore','bindingId','configurationVersion','idempotencyKey'])&&
        ['planId','planVersion','bindingId','configurationVersion','idempotencyKey'].every(key=>isCanonicalFrozenRef(input[key]))&&['miska','dandanshu'].includes(input.targetStore),'INPUT_INVALID');
      const {service,plan}=plannedRound(input);
      return repository.transact(document=>{
        const {batch,created}=saveBatchInDocument({document,actor,input,plan,service});
        const result={batch:clone(batch),idempotentReplay:!created,externalRequests:0};
        return created?{changed:true,document,result}:{changed:false,result};
      });
    },
    /**
     * One click on the desk. The round is created, authorized and enqueued in a single saved transaction, so the owner
     * can never be left holding a batch that was never started, and the same idempotency key always resumes that one
     * round: an existing batch without a permit is authorized, an already authorized one returns its saved job.
     */
    async startRound({actor,input}){
      owner(actor);requireValue(closed(input,['planId','planVersion','targetStore','bindingId','configurationVersion','expiresAt','idempotencyKey'])&&
        ['planId','planVersion','bindingId','configurationVersion','idempotencyKey'].every(key=>isCanonicalFrozenRef(input[key]))&&['miska','dandanshu'].includes(input.targetStore)&&
        typeof input.expiresAt==='string'&&Number.isFinite(Date.parse(input.expiresAt)),'INPUT_INVALID');
      const {service,plan}=plannedRound(input);
      const started=await repository.transact(document=>{
        const {batch,created}=saveBatchInDocument({document,actor,input,plan,service});
        const authorized=authorizeBatchInDocument({document,batch,actor,expiresAt:input.expiresAt,idempotencyKey:input.idempotencyKey});
        const result={batch:clone(batch),job:authorized.job,resumed:!created,serviceBindingId:authorized.serviceBindingId};
        return created||authorized.changed?{changed:true,document,result}:{changed:false,result};
      });
      const {serviceBindingId,...round}=started;
      // The batch and its one-use permit are already saved. A failure while running must not be reported as "nothing
      // happened": the owner's next click would open a second batch and spend a second time. The saved job, its receipt
      // and runtimeStatus carry the failure, and the round stays resumable from the saved permit.
      try{await runAuthorized({job:round.job,serviceBindingId});}catch{/* reported by the saved job and runtimeStatus */}
      return round;
    },
    async authorizeAndRun({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','expiresAt','idempotencyKey'])&&isCanonicalFrozenRef(input.batchId)&&isCanonicalFrozenRef(input.idempotencyKey)&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.expiresAt==='string'&&Number.isFinite(Date.parse(input.expiresAt)),'INPUT_INVALID');
      const authorized=await repository.transact(document=>{
        const batch=batchFor(document,input.batchId,actor);requireValue(batch.revision===input.expectedRevision,'BATCH_CHANGED');
        const result=authorizeBatchInDocument({document,batch,actor,expiresAt:input.expiresAt,idempotencyKey:input.idempotencyKey});
        return result.changed?{changed:true,document,result}:{changed:false,result};
      });
      const run=runAuthorized(authorized);
      return run===null?{status:'queued',jobId:authorized.job.jobId,externalRequests:0}:run;
    },
    async importSelected({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','marketProductId'])&&isCanonicalFrozenRef(input.batchId)&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.marketProductId==='string'&&/^[1-9][0-9]*$/.test(input.marketProductId),'INPUT_INVALID');
      requireValue(onSelectProduct!==null,'SERVICE_NOT_CONFIGURED');
      const document=await repository.readSnapshot(),batch=batchFor(document,input.batchId,actor);
      requireValue(batch.revision===input.expectedRevision,'BATCH_CHANGED');
      // Owner rule 2026-09-10: an estimated negative purchase ceiling leaves the product out of the selectable pool.
      requireValue(readADiscoveryEstimateOutcome(document,{batchId:batch.batchId,revision:batch.revision,productId:input.marketProductId})!=='excluded_negative','ESTIMATE_EXCLUDED');
      return onSelectProduct({batchId:batch.batchId,revision:batch.revision,marketProductId:input.marketProductId,selectedByUserId:actor.userId});
    },
    /**
     * The owner turns one market product down with one fixed reason. Nothing is created, nothing is spent, and the
     * product simply leaves the feed. The saved record is deliberately durable: it is the future AI selection layer's
     * memory of what this owner does not want, and the only place that judgment is kept.
     */
    async declineProduct({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','marketProductId','reason'])&&isCanonicalFrozenRef(input.batchId)&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.marketProductId==='string'&&/^[1-9][0-9]*$/.test(input.marketProductId)&&
        typeof input.reason==='string'&&input.reason.length<=40&&A_DISCOVERY_DECLINE_REASONS.includes(input.reason),'INPUT_INVALID');
      return repository.transact(document=>{
        const batch=batchFor(document,input.batchId,actor);
        requireValue(batch.revision===input.expectedRevision,'BATCH_CHANGED');
        requireValue(readADiscoveryBatchMarketProducts({document,batch}).some(product=>product.productId===input.marketProductId),'PRODUCT_REQUIRED');
        const store=collection(document,A_DISCOVERY_DECLINE_COLLECTION);
        const key=aDiscoveryDeclineKey({batchId:batch.batchId,revision:batch.revision,marketProductId:input.marketProductId});
        const identity={batchId:batch.batchId,revision:batch.revision,marketProductId:input.marketProductId};
        if(Object.hasOwn(store,key)){
          const existing=assertADiscoveryDeclineRecord(store[key],identity);
          requireValue(existing.reason===input.reason,'DECLINE_CONFLICT');
          return {changed:false,result:{decline:clone(existing),idempotentReplay:true,externalRequests:0}};
        }
        const record=assertADiscoveryDeclineRecord({schemaVersion:A_DISCOVERY_DECLINE_SCHEMA_VERSION,...identity,
          reason:input.reason,declinedByUserId:actor.userId,declinedAt:serverClock()},identity);
        store[key]=record;
        return {changed:true,document,result:{decline:clone(record),idempotentReplay:false,externalRequests:0}};
      });
    },
    continueSavedCurrent({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','jobId'])&&isCanonicalFrozenRef(input.batchId)&&isCanonicalFrozenRef(input.jobId)&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,'INPUT_INVALID');
      requireValue(!active||activeExecution?.jobId===input.jobId,'SERVICE_BUSY');
      return singleflight(async()=>{
        const document=await repository.readSnapshot(),batch=batchFor(document,input.batchId,actor),job=await softwareJobStore.get(input.jobId);
        requireValue(batch.revision===input.expectedRevision&&job?.subject?.batchId===batch.batchId&&job.revision===batch.revision,'BATCH_CHANGED');
        return runSelected(serviceFor(batch.bindingId,batch.configurationVersion),job);
      });
    },
    start(){if(started||failed||!services.length)return;started=true;schedule();},
    async stop(){started=false;clearTimeout(timer);timer=null;for(const controller of controllers)controller.abort(new ADiscoveryError('CANCELLED'));if(active)await active;}
  });
}
