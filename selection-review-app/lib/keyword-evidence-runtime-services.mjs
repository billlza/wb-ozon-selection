import { randomUUID } from 'node:crypto';
import { createSoftwareExecutionRuntime, openExceptionCase, blockExecutionForTechnicalFailure } from './software-execution-state.mjs';
import { C1_PAID_KEYWORD_EVIDENCE_CAPABILITY, C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE } from './software-job-contract.mjs';
import { runC1PaidKeywordEvidenceSoftwareJob } from './keyword-evidence-software-runner.mjs';
import { normalizeKeywordEvidenceServiceBindings } from './runtime-configuration.mjs';

export class C1KeywordContinuationRevisionConflictError extends Error {
  constructor(){super('C1_KEYWORD_CONTINUATION_REVISION_CONFLICT');this.name='C1KeywordContinuationRevisionConflictError';this.code='C1_KEYWORD_CONTINUATION_REVISION_CONFLICT';}
}

/** Compose existing paid jobs. Construction and an idle pump never resolve credentials. */
export function createKeywordEvidenceRuntimeServices({repository,softwareJobStore,runtimeMode,serverClock,workerRegistry,
  serviceBindings=[],createTransport,onEvidenceReady,onError}={}) {
  const bindings=normalizeKeywordEvidenceServiceBindings(serviceBindings);
  if(!['local_development','central_test','central_production'].includes(runtimeMode) || typeof repository?.readSnapshot!=='function' || typeof serverClock!=='function' ||
    ['register','heartbeat'].some(method=>typeof workerRegistry?.[method]!=='function') ||
    ['get','listAssignableWithDiagnostics','listC1KeywordContinuationJobs'].some(method=>typeof softwareJobStore?.[method]!=='function') ||
    typeof createTransport!=='function' || typeof onEvidenceReady!=='function' || typeof onError!=='function')throw new Error('KEYWORD_SERVICE_DEPENDENCY_INVALID');
  const services=bindings.map(binding=>{
    const descriptor={workerId:binding.workerId,version:binding.workerVersion,capabilities:[C1_PAID_KEYWORD_EVIDENCE_CAPABILITY]};
    workerRegistry.register({...descriptor,observedAt:serverClock()});
    return {binding,descriptor};
  });
  let active=null,started=false,timer=null,lastError=false,activeJobId=null,activeExecution=null,lastAdmissionRejection=null,notificationError=null;
  const controllers=new Set();
  function refresh(service){return workerRegistry.heartbeat({...service.descriptor,status:'online'});}
  async function recordContinuationFailure(entry,{known=false}={}) {
    return repository.transact(document=>{
      const job=document.runtime.softwareJobs.find(value=>value.jobId===entry.jobId);
      const candidate=document.candidates.find(value=>value.id===entry.candidateId);
      if(!job || !candidate || job.candidateId!==candidate.id || job.status!=='completed' || job.externalRequestState!=='succeeded') {
        throw new Error('KEYWORD_CONTINUATION_EXCEPTION_SOURCE_INVALID');
      }
      const at=serverClock();
      const prior=candidate.executionRuntime || createSoftwareExecutionRuntime({candidateId:candidate.id,dataRevision:candidate.dataRevision,
        businessPhase:'C1',stepId:'C1_KEYWORD_HANDOFF',at});
      if(prior.exceptionCase?.status==='open')return {changed:false,result:null};
      const runtime={...prior,businessPhase:'C1',stepId:'C1_KEYWORD_HANDOFF'};
      candidate.executionRuntime=known?blockExecutionForTechnicalFailure(runtime,{
        failureId:`failure:c1-keyword-handoff:${job.jobId}`,kind:'known_technical_failure',
        errorCode:'C1_DRAFT_RUNTIME_UNAVAILABLE',failureLayer:'c1_keyword_handoff',
        evidenceRefs:[job.resultRef],softwareJobId:job.jobId,sourceRevision:job.revision,at
      }):openExceptionCase(runtime, {
        exceptionId:`exception:c1-keyword-handoff:${job.jobId}`,reasonCode:'system_failure',failureLayer:'c1_keyword_handoff',
        evidenceRefs:[job.resultRef],skuPackageId:job.skuPackageId,softwareJobId:job.jobId,sourceRevision:job.revision,
        lastSuccessfulStepId:'keyword_evidence_persisted',externalRequestRefs:[job.externalRequestRef],unknownOutcome:false,at});
      return {changed:true,document,result:null};
    });
  }
  async function continueResult(entry){
    try {
      const result=await onEvidenceReady(entry.candidateId,entry.resultRevision);
      if(result?.status==='blocked') {
        if(Object.keys(result).length!==2 || result.failureClass!=='C1_DRAFT_RUNTIME_UNAVAILABLE')throw new Error('KEYWORD_CONTINUATION_RESULT_INVALID');
        await recordContinuationFailure(entry,{known:true});
        return {status:'blocked',jobId:entry.jobId,failureClass:result.failureClass};
      }
    } catch(error) {
      if(error instanceof C1KeywordContinuationRevisionConflictError)return {status:'blocked',jobId:entry.jobId,failureClass:error.code};
      await recordContinuationFailure(entry);
      throw error;
    }
    return {status:'continued',jobId:entry.jobId};
  }
  async function runSelected(service,job){
    if(lastAdmissionRejection?.jobId===job.jobId)lastAdmissionRejection=null;
    activeJobId=job.jobId;
    const leaseId=`lease:c1-keyword:${randomUUID()}`;
    activeExecution={jobId:job.jobId,workerId:service.binding.workerId,leaseId};
    const controller=new AbortController();controllers.add(controller);
    try{
      const result=await runC1PaidKeywordEvidenceSoftwareJob({repository,softwareJobStore,worker:refresh(service),jobId:job.jobId,
        leaseId,leaseDurationMs:service.binding.leaseDurationMs,serverClock,
        createTransport:args=>createTransport({...args,binding:service.binding,job}),signal:controller.signal});
      const continuations=await softwareJobStore.listC1KeywordContinuationJobs({limit:1,jobId:job.jobId});
      if(continuations.length){const continuation=await continueResult(continuations[0]);if(continuation.status==='blocked')return continuation;}
      return result;
    }finally{controllers.delete(controller);activeJobId=null;activeExecution=null;}
  }
  function singleflight(operation){
    if(active)return active;
    active=operation().finally(()=>{active=null;});return active;
  }
  function runDue(){return singleflight(async()=>{
    if(!services.length)return {status:'not_configured',externalRequests:0};
    const continuations=await softwareJobStore.listC1KeywordContinuationJobs({limit:1});
    if(continuations.length)return continueResult(continuations[0]);
    for(const service of services){
      const diagnostic=await softwareJobStore.listAssignableWithDiagnostics({worker:refresh(service),limit:1,jobType:C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE});
      if(diagnostic.assignable.length)return runSelected(service,diagnostic.assignable[0]);
      if(diagnostic.rejected.length){lastAdmissionRejection=structuredClone(diagnostic.rejected[0]);return {status:'blocked',rejections:[lastAdmissionRejection],externalRequests:0};}
    }
    return {status:'idle',externalRequests:0};
  });}
  function schedule(){
    if(!started)return;
    timer=setTimeout(async()=>{
      timer=null;
      try{await runDue();}catch(error){
        started=false;lastError=true;
        try{await onError(error);}catch(cause){notificationError=cause;}
        return;
      }
      schedule();
    },Math.min(...bindings.map(binding=>binding.pumpIntervalMs)));
    timer.unref?.();
  }
  return Object.freeze({configurationView:bindings,
    get activeJobId(){return activeJobId;},
    get activeExecution(){return structuredClone(activeExecution);},
    get lastAdmissionRejection(){return structuredClone(lastAdmissionRejection);},
    get notificationError(){return notificationError;},
    get status(){return lastError?'failed':started?'running':bindings.length?'stopped':'not_configured';},runDue,
    continueSavedCurrent({candidateId,expectedRevision,jobId}){return singleflight(async()=>{
      const job=await softwareJobStore.get(jobId);
      if(!job || job.jobType!==C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || job.candidateId!==candidateId)throw new Error('KEYWORD_SERVICE_JOB_INVALID');
      const pending=await softwareJobStore.listC1KeywordContinuationJobs({limit:1,jobId});
      if(pending.length){if(pending[0].resultRevision!==expectedRevision)throw new Error('KEYWORD_SERVICE_REVISION_CONFLICT');return continueResult(pending[0]);}
      if(job.status!=='queued')return {status:'idempotent_replay',jobId,executionStatus:job.status};
      if(job.revision!==expectedRevision)throw new Error('KEYWORD_SERVICE_REVISION_CONFLICT');
      if(!services.length)throw new Error('KEYWORD_SERVICE_NOT_CONFIGURED');
      return runSelected(services[0],job);
    });},
    start(){if(started || !bindings.length || lastError)return;started=true;schedule();},
    async stop(){started=false;if(timer!==null)clearTimeout(timer);timer=null;for(const controller of controllers)controller.abort();if(active)await active;}
  });
}
