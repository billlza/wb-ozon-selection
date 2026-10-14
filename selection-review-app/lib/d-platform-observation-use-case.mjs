import { createSoftwareExecutionRuntime, openExceptionCase } from './software-execution-state.mjs';
import { randomUUID } from 'node:crypto';
import { OzonDEHttpTransportError } from './ozon-de-http-configuration.mjs';
import { markSoftwareJobExternalRequestStarted, bindSoftwareJobAdmissionDecision } from './software-job-contract.mjs';
import { assertDPlatformObservationJobSource, assertDPlatformObservationSend, dPlatformObservationQuery } from './d-platform-observation-contract.mjs';

class ObservationDeadlineError extends Error {}
const findJob = (document,id) => document.runtime.softwareJobs.find(job=>job.jobId === id);
/** One persisted read per job. Timers discover only explicitly queued observation jobs. */
export function createDPlatformObservationRuntime({repository,jobStore,serverClock,resolveExecution,onPrerequisitesObserved,
  onError=null,pumpIntervalMs=null}) {
 if(typeof serverClock !== 'function' || typeof resolveExecution !== 'function' || onError !== null && typeof onError !== 'function' ||
  pumpIntervalMs !== null && (!Number.isSafeInteger(pumpIntervalMs) || pumpIntervalMs<1 || pumpIntervalMs>2147483647)) throw new Error('D_OBSERVATION_RUNTIME_CONFIGURATION_INVALID');
 let started=false,timer=null,active=null; const controllers=new Set();
 async function runJob({jobId}) {
  const before=await repository.readSnapshot(),saved=findJob(before,jobId);
  if(!saved || saved.jobType !== 'e_d_platform_observation') throw new Error('D_OBSERVATION_JOB_INVALID');
  if(saved.status !== 'queued') return {status:'idempotent_replay',job:saved};
  let source,execution,claimed;
  const leaseId=`lease:d-observation:${randomUUID()}`;
  try {
   source=assertDPlatformObservationJobSource({document:before,job:saved,observedAt:serverClock()});
   if(Date.parse(serverClock())>=Date.parse(saved.scopeBinding.policy.expiresAt))
    return await jobStore.rejectDPlatformObservation({jobId,failureClass:'context_changed'});
   execution=await resolveExecution({candidate:source.candidate,job:saved});
   claimed=await jobStore.claim({jobId,worker:execution.worker,leaseId,leaseDurationMs:execution.leaseDurationMs});
  } catch(error) {
   const contextFailure=['D_PLATFORM_OBSERVATION_SOURCE_CONFLICT','D_PLATFORM_OBSERVATION_JOB_SOURCE_CONFLICT',
    'D_PLATFORM_OBSERVATION_ADMISSION_BINDING_CHANGED','D_PLATFORM_OBSERVATION_ADMISSION_BINDING_INVALID','D_PLATFORM_OBSERVATION_POLICY_EXPIRED',
    'DE_RUNTIME_UNAVAILABLE_SERVICE','DE_RUNTIME_UNAVAILABLE_PRODUCTION_BINDING',
    'SOFTWARE_JOB_ADMISSION_DE_CURRENT_SOURCE_CONFLICT','SOFTWARE_JOB_ADMISSION_DE_BINDING_CONFLICT'].includes(error.message);
   if(!contextFailure)throw error;
   return jobStore.rejectDPlatformObservation({jobId,failureClass:'context_changed'});
  }
  const controller=new AbortController();controllers.add(controller);let deadline,requestSent=false;
  const guard=async(mark=false)=>repository.transact(document=>{
   const job=findJob(document,jobId),observedAt=serverClock();
   assertDPlatformObservationSend({document,job,workerId:execution.worker.workerId,leaseId,observedAt,signal:controller.signal});
   const admitted=jobStore.assertDPlatformObservationExecutionInDocument({document,jobId,workerId:execution.worker.workerId,leaseId,observedAt});
   if(mark) {
    const next=markSoftwareJobExternalRequestStarted({job:bindSoftwareJobAdmissionDecision(job,admitted.admissionDecision),
     workerId:execution.worker.workerId,leaseId,externalRequestRef:`d-observation-request:${job.scopeBinding.inputFingerprint}`,serverTime:observedAt});
    document.runtime.softwareJobs[document.runtime.softwareJobs.findIndex(value=>value.jobId===jobId)]=structuredClone(next);
    requestSent=true;
   }
   return {changed:mark,document,result:null};
  });
  let result;
  try {
   await guard();
   const adapter=await execution.createAdapter();
   const methods={import_task:'observeImportTask',price_state:'observePriceSent',inventory_prerequisites:'observeInventoryPrerequisites'};
   const query=dPlatformObservationQuery(source);
   const remaining=Math.min(saved.scopeBinding.policy.requestTimeoutMs,
    Date.parse(saved.scopeBinding.policy.expiresAt)-Date.parse(serverClock()),Date.parse(claimed.leaseExpiresAt)-Date.parse(serverClock()));
   const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{const error=new ObservationDeadlineError();controller.abort(error);reject(error);},remaining);});
   try {result=await Promise.race([adapter[methods[saved.scopeBinding.queryKind]](query,{signal:controller.signal,beforeRequestSend:()=>guard(true)}),timeout]);}
   catch(error) {
    if(error instanceof ObservationDeadlineError) result={schemaVersion:'d-platform-observation-failure-v1',status:'unknown_outcome',failureClass:'request_timeout',requestSent};
    else if(error instanceof OzonDEHttpTransportError) result={schemaVersion:'d-platform-observation-failure-v1',status:'unknown_outcome',failureClass:'transport_failure',requestSent};
    else if(error?.message === 'OZON_DE_INVENTORY_POLICY_NOT_VERIFIED') result={schemaVersion:'d-platform-observation-failure-v1',status:'blocked',failureClass:'inventory_policy_missing',requestSent:false};
    else if(error?.message === 'OZON_DE_INVENTORY_POLICY_OUTDATED' && !requestSent) result={schemaVersion:'d-platform-observation-failure-v1',status:'blocked',failureClass:'inventory_policy_outdated',requestSent:false};
    else throw error;
   }
   const outcome=await repository.transact(document=>{
    const current=findJob(document,jobId);
    if(!['claimed','waiting_platform'].includes(current.status) || current.workerId!==execution.worker.workerId || current.leaseId!==leaseId) {
     throw new Error('D_OBSERVATION_LATE_RESULT_REJECTED');
    }
    return {changed:true,document,result:jobStore.recordDPlatformObservationInDocument({document,jobId,workerId:execution.worker.workerId,
     leaseId,result,observedAt:serverClock()})};
   });
   if(outcome.disposition === 'inventory_observed' && typeof onPrerequisitesObserved === 'function') {
    await onPrerequisitesObserved({sourceDJobId:source.sourceDJob.jobId,observationJobId:jobId});
   }
   return outcome;
  }catch(error){
   const knownContext=['D_PLATFORM_OBSERVATION_SEND_NOT_AUTHORIZED','D_PLATFORM_OBSERVATION_NOT_DUE','D_PLATFORM_OBSERVATION_POLICY_EXPIRED','D_OBSERVATION_LATE_RESULT_REJECTED'].includes(error.message);
   await repository.transact(document=>{
    const job=findJob(document,jobId),candidate=document.candidates.find(value=>value.id===job.candidateId),at=serverClock();
    if(['claimed','waiting_platform'].includes(job.status) && job.workerId===execution.worker.workerId && job.leaseId===leaseId) {
      jobStore.recordDPlatformObservationInDocument({document,jobId,workerId:execution.worker.workerId,leaseId,observedAt:at,
        result:{schemaVersion:'d-platform-observation-failure-v1',status:requestSent?'unknown_outcome':'blocked',failureClass:knownContext?'context_changed':'system_failure',requestSent}});
    }
    const prior=candidate.executionRuntime || createSoftwareExecutionRuntime({candidateId:candidate.id,dataRevision:candidate.dataRevision,businessPhase:'D',stepId:'E_D_PLATFORM_OBSERVATION',at});
    if(!knownContext && prior.exceptionCase?.status !== 'open') candidate.executionRuntime=openExceptionCase({...prior,businessPhase:'D',stepId:'E_D_PLATFORM_OBSERVATION'}, {
      exceptionId:`exception:d-observation:${jobId}`,reasonCode:'system_failure',failureLayer:'d_platform_observation',evidenceRefs:[`d-observation-job:${jobId}`],
      skuPackageId:job.skuPackageId,softwareJobId:jobId,lastSuccessfulStepId:'import_task_received',externalRequestRefs:job.externalRequestRef?[job.externalRequestRef]:[],
      unknownOutcome:requestSent,sourceRevision:job.revision,at});
    return {changed:true,document,result:null};
   });
   throw error;
  }finally{clearTimeout(deadline);controllers.delete(controller);}
 }
 async function runDue() {
  if(active) return active;
  active=(async()=>{const jobs=await jobStore.listDPlatformObservationJobs({limit:1});
   if(jobs.length>0)return runJob({jobId:jobs[0].jobId});
   const pending=await jobStore.listDRemainingInventoryJobs({limit:1});
   if(pending.length===0)return {status:'idle'};
   if(typeof onPrerequisitesObserved !== 'function')throw new Error('D_OBSERVATION_CONTINUATION_HANDLER_MISSING');
   return onPrerequisitesObserved(pending[0]);})();
  try{return await active;}finally{active=null;}
 }
 function schedule(){if(started)timer=setTimeout(()=>{runDue().then(schedule,error=>{started=false;onError(error);});},pumpIntervalMs);}
 return Object.freeze({runJob,runDue,start(){if(pumpIntervalMs === null || onError === null) throw new Error('D_OBSERVATION_PUMP_NOT_CONFIGURED');if(!started){started=true;schedule();}},async stop(){started=false;clearTimeout(timer);
  for(const controller of controllers)controller.abort(new Error('D_OBSERVATION_RUNTIME_STOPPED'));if(active)await active;}});
}
