import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { assertWorkerRegistryBoundary } from './worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore } from './software-job-repository.mjs';
import { createSoftwareJobEnvelope, enqueueSoftwareJobInDocument, softwareJobsInDocument, findSoftwareJobInDocument,
  assertSoftwareJobExecutionLease, markSoftwareJobExternalRequestStarted, bindSoftwareJobAdmissionDecision,
  settleOzonAccountReadSoftwareJobInDocument } from './software-job-contract.mjs';
import { bindSoftwareJobAdmissionForEnqueue, assertSoftwareJobAdmittedForExternalRequest } from './software-job-admission.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { OZON_ACCOUNT_READ_JOB_TYPE, OZON_ACCOUNT_READ_CAPABILITY, OZON_ACCOUNT_READ_METHODS, OzonAccountReadError,
  OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION, assertOzonAccountPreparation, createOzonAccountDiscoveryScope,
  interruptOzonAccountReadReceipt, assertOzonAccountReadBinding, createOzonAccountReadScope, assertOzonAccountReadScope, assertOzonAccountReadCandidate, assertOzonAccountReadReceipt } from './ozon-account-read-contract.mjs';
import { buildOzonAccountReadRequest, normalizeOzonAccountReadResponse, OzonAccountReadApiError } from './ozon-account-read-api.mjs';
import { OzonDEHttpTransportError } from './ozon-de-http-configuration.mjs';

const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const closed=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const ref=isCanonicalFrozenRef;
function requireValue(value,code){if(!value)throw new OzonAccountReadError(code);}
function collection(document,key){
  if(!Object.hasOwn(document.runtime,key))document.runtime[key]={};
  requireValue(object(document.runtime[key]),'REPOSITORY_INVALID');return document.runtime[key];
}
function arrayCollection(document,key){
  if(!Object.hasOwn(document.runtime,key))document.runtime[key]=[];
  requireValue(Array.isArray(document.runtime[key]),'REPOSITORY_INVALID');return document.runtime[key];
}
function candidateFor(document,id,skuPackageId){
  const found=document.candidates.filter(value=>value.id===id);
  requireValue(found.length===1&&found[0].lifecycleV11?.skuPackage?.skuPackageId===skuPackageId,'CANDIDATE_REQUIRED');return found[0];
}
function replaceJob(document,job){const jobs=softwareJobsInDocument(document),index=jobs.findIndex(value=>value.jobId===job.jobId);requireValue(index>=0,'JOB_REQUIRED');jobs[index]=clone(job);}
// A new click key is not an evidence-refresh authorization. Only a known failed read may be authorized again.
function assertReadScopeCanBeAuthorized(document,candidate,scope){
  if(scope.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION){
    const fields=['targetStore','bindingId','configurationVersion','credentialAlias','clientIdRef','scopeRef'];
    for(const job of softwareJobsInDocument(document)){
      if(job.jobType!==OZON_ACCOUNT_READ_JOB_TYPE||job.subject?.preparationId!==scope.subject.preparationId)continue;
      const saved=assertOzonAccountReadScope(job.scopeBinding,job);
      if(!fields.every(field=>isDeepStrictEqual(saved[field],scope[field])))continue;
      requireValue(job.status!=='completed','REFRESH_NOT_SUPPORTED');
      requireValue(job.status!=='unknown_outcome'&&job.externalRequestState!=='unknown_outcome','OUTCOME_RECONCILIATION_REQUIRED');
      requireValue(job.status==='failed'&&['not_sent','failed','succeeded'].includes(job.externalRequestState),'SCOPE_ALREADY_AUTHORIZED');
    }return;
  }
  const identityFields=['candidateId','skuPackageId','supplierSkuId','platform','storeRef',
    'warehouseRef','warehouseId','credentialAlias','clientIdRef','bindingId','configurationVersion'];
  const revisions=new Set([scope.resultRevision]);
  const authorization=candidate.lifecycleV11.skuPackage.productionAuthorization;
  if(authorization!==undefined&&authorization!==null){
    requireValue(Number.isSafeInteger(authorization.sourceCandidateRevision)&&authorization.sourceCandidateRevision>=0&&
      authorization.sourceCandidateRevision<scope.resultRevision,'PRODUCTION_AUTHORIZATION_SOURCE_CONFLICT');
    revisions.add(authorization.sourceCandidateRevision);
  }
  for(const job of softwareJobsInDocument(document)){
    if(job.jobType!==OZON_ACCOUNT_READ_JOB_TYPE||job.candidateId!==scope.candidateId||job.skuPackageId!==scope.skuPackageId||!revisions.has(job.revision))continue;
    const saved=assertOzonAccountReadScope(job.scopeBinding,job);
    if(!identityFields.every(field=>isDeepStrictEqual(saved[field],scope[field])))continue;
    requireValue(job.status!=='completed','REFRESH_NOT_SUPPORTED');
    requireValue(job.status!=='unknown_outcome'&&job.externalRequestState!=='unknown_outcome','OUTCOME_RECONCILIATION_REQUIRED');
    requireValue(job.status==='failed'&&['not_sent','failed','succeeded'].includes(job.externalRequestState),'SCOPE_ALREADY_AUTHORIZED');
  }
}
function viewJob(document,job){
  const receipt=document.runtime.ozonAccountReadReceipts?.[job.jobId];
  if(receipt)assertOzonAccountReadReceipt(receipt,job);
  const requestsSent=receipt?.steps.some(step=>step.requestTransmission==='unknown')?'unknown':receipt?receipt.steps.filter(step=>step.requestTransmission!=='not_attempted').length:0;
  return {status:job.status,job:clone(job),receipt:receipt?clone(receipt):null,requestsSent,
    observedMethods:receipt?receipt.steps.filter(step=>step.result?.status==='observed').map(step=>step.method):[],platformWrites:0};
}
/** Explicitly invoked runtime. Construction registers capability only; it never reads credentials or starts jobs. */
export function createOzonAccountReadRuntime({repository,serverClock,workerRegistry,worker,loadCurrentReadBinding,requestJson,subjectKind='candidate_sku'}){
  assertBusinessStateRepositoryBoundary(repository);assertWorkerRegistryBoundary(workerRegistry);
  requireValue(typeof serverClock==='function'&&typeof loadCurrentReadBinding==='function'&&typeof requestJson==='function'&&
    closed(worker,['workerId','version','leaseDurationMs'])&&ref(worker.workerId)&&ref(worker.version)&&Number.isSafeInteger(worker.leaseDurationMs)&&
    worker.leaseDurationMs>=1000&&worker.leaseDurationMs<=1800000,'CONFIGURATION_INVALID');
  requireValue(['candidate_sku','account_preparation'].includes(subjectKind),'SUBJECT_KIND_INVALID');
  const discovery=subjectKind==='account_preparation';
  function sourceFor(document,identity){
    if(!discovery)return candidateFor(document,identity.candidateId,identity.skuPackageId);
    const id=identity.subject?.preparationId??identity.preparationId;
    const source=document.runtime.ozonAccountPreparations?.[id];
    requireValue(source!==undefined,'PREPARATION_REQUIRED');return assertOzonAccountPreparation(source);
  }
  const sourceId=identity=>discovery?(identity.subject?.preparationId??identity.preparationId):identity.candidateId;
  const registered=workerRegistry.register({workerId:worker.workerId,version:worker.version,capabilities:[OZON_ACCOUNT_READ_CAPABILITY],observedAt:serverClock()});
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,serverClock,workerRegistry});
  function bindingFor(document,candidateId,skuPackageId,checkedAt,selection){
    const binding=loadCurrentReadBinding({document,...(discovery?{preparationId:candidateId}:{candidateId,skuPackageId}),checkedAt,bindingId:selection.bindingId,configurationVersion:selection.configurationVersion});
    requireValue(binding!==null,'BINDING_REQUIRED');return assertOzonAccountReadBinding(binding);
  }
  function refreshActiveWorker(expectedVersion){
    const current=workerRegistry.snapshot().find(value=>value.workerId===worker.workerId);
    requireValue(current?.status==='online'&&current.version===expectedVersion&&current.version===registered.version&&
      isDeepStrictEqual(current.capabilities,registered.capabilities),'WORKER_CHANGED');
    // Executing this checkpoint proves local liveness, but does not override a changed worker identity or status.
    workerRegistry.heartbeat({workerId:current.workerId,version:current.version,capabilities:current.capabilities,status:current.status});
    requireValue(workerRegistry.snapshot().find(value=>value.workerId===worker.workerId)?.heartbeatCurrent===true,'WORKER_CHANGED');
  }
  function guard(document,job,leaseId,at){
    const candidate=sourceFor(document,job);
    assertOzonAccountReadCandidate(candidate,job.scopeBinding);
    if(discovery)requireValue(candidate.createdByUserId===job.ownerUserId&&candidate.createdByUserId===job.requestedByUserId,'PREPARATION_OWNER_CONFLICT');
    const binding=bindingFor(document,sourceId(job),job.skuPackageId,at,job.scopeBinding);
    requireValue(Object.keys(binding).every(field=>isDeepStrictEqual(binding[field],job.scopeBinding[field])),'BINDING_CHANGED');
    requireValue(Date.parse(at)<Date.parse(job.leaseExpiresAt),'LEASE_EXPIRED');
    assertSoftwareJobExecutionLease({job,workerId:worker.workerId,leaseId,serverTime:at});
    refreshActiveWorker(job.workerVersion);
    return assertSoftwareJobAdmittedForExternalRequest({document,job,workerId:worker.workerId,observedAt:at});
  }
  function isPermissionStop(error){
    return error instanceof OzonAccountReadError&&['CANDIDATE_CHANGED','CANDIDATE_REQUIRED','PREPARATION_CHANGED','PREPARATION_REQUIRED','PREPARATION_OWNER_CONFLICT','BINDING_CHANGED','BINDING_REQUIRED','WORKER_CHANGED','LEASE_EXPIRED'].some(code=>error.code===`OZON_ACCOUNT_READ_${code}`)||
      ['SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED','SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED','SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED','SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED','SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND'].includes(error.message);
  }
  async function stopCurrent(jobId,leaseId,failureClass){
    return repository.transact(document=>{
      const job=findSoftwareJobInDocument(document,jobId);
      if(!['claimed','waiting_platform'].includes(job.status))return {changed:false,result:viewJob(document,job)};
      const at=serverClock(),receipts=collection(document,'ozonAccountReadReceipts');
      receipts[jobId]=interruptOzonAccountReadReceipt(receipts[jobId],job,at,failureClass);
      settleOzonAccountReadSoftwareJobInDocument(document,{jobId,workerId:worker.workerId,leaseId},at);
      return {changed:true,document,result:viewJob(document,findSoftwareJobInDocument(document,jobId))};
    });
  }
  async function snapshot(input){
    const document=await repository.readSnapshot(),job=findSoftwareJobInDocument(document,input.jobId);
    requireValue(job?.jobType===OZON_ACCOUNT_READ_JOB_TYPE&&sourceId(job)===sourceId(input)&&job.revision===input.expectedRevision&&Boolean(job.subject)===discovery,'JOB_SOURCE_CONFLICT');
    return {document,job};
  }
  async function finish(jobId,leaseId,{method,result=null,errorCode=null,externalRequestState=null,requestTransmission='unknown'}){
    return repository.transact(document=>{
      const job=findSoftwareJobInDocument(document,jobId),receipts=collection(document,'ozonAccountReadReceipts'),receipt=clone(receipts[jobId]);
      assertOzonAccountReadReceipt(receipt,job);
      if(receipt.status!=='in_flight'||!['claimed','waiting_platform'].includes(job.status))return {changed:false,result:viewJob(document,job)};
      const at=serverClock(),step=receipt.steps.at(-1);
      requireValue(receipt.leaseId===leaseId&&receipt.workerId===worker.workerId,'LEASE_CHANGED');
      requireValue(step?.method===method&&step.completedAt===null,'STEP_CONFLICT');
      step.completedAt=at;
      if(result!==null){
        requireValue(step.sentAt!==null,'SEND_FACT_REQUIRED');
        const {endpoint:_endpoint,...savedResult}=result;
        step.result=clone(savedResult);step.externalRequestState='succeeded';step.requestTransmission='response_received';
      }else{
        step.errorCode=errorCode;
        step.externalRequestState=step.sentAt===null?'not_sent':externalRequestState;
        step.requestTransmission=step.sentAt===null?'not_attempted':requestTransmission;
      }
      let sourceFailure=null;
      if(result!==null){
        try{
          const source=sourceFor(document,job);
          assertOzonAccountReadCandidate(source,job.scopeBinding);
          if(discovery)requireValue(source.createdByUserId===job.ownerUserId&&source.createdByUserId===job.requestedByUserId,'PREPARATION_OWNER_CONFLICT');
          const binding=bindingFor(document,sourceId(job),job.skuPackageId,at,job.scopeBinding);
          requireValue(Object.keys(binding).every(field=>isDeepStrictEqual(binding[field],job.scopeBinding[field])),'BINDING_CHANGED');
        }catch(error){if(!isPermissionStop(error))throw error;sourceFailure=error.code??error.message;}
      }
      const stop=sourceFailure!==null||result===null||result.status!=='observed'||receipt.steps.length===3;
      if(stop){
        receipt.completedAt=at;receipt.status=step.externalRequestState==='unknown_outcome'?'unknown_outcome':result?.status==='observed'&&sourceFailure===null?'completed':'failed';
        receipt.failureClass=receipt.status==='completed'?null:sourceFailure??errorCode??'ozon-account-read-data-unavailable';
      }
      receipts[jobId]=assertOzonAccountReadReceipt(receipt,job);
      if(stop)settleOzonAccountReadSoftwareJobInDocument(document,{jobId,workerId:worker.workerId,leaseId},at);
      return {changed:true,document,result:viewJob(document,findSoftwareJobInDocument(document,jobId))};
    });
  }
  return Object.freeze({
    async authorizeAndEnqueue({actor,input}){
      authorizeOperation({actor,requiredRoles:['owner']});
      requireValue(actor.actorType==='human'&&actor.source==='authenticated_identity_provider','AUTHENTICATED_OWNER_REQUIRED');
      requireValue(closed(input,[...(discovery?['preparationId']:['candidateId','skuPackageId']),'expectedRevision','bindingId','configurationVersion','scopeRef','confirmReadOnce','expiresAt','idempotencyKey'])&&
        [...(discovery?['preparationId']:['candidateId','skuPackageId']),'bindingId','configurationVersion','scopeRef','idempotencyKey'].every(field=>ref(input[field]))&&input.confirmReadOnce===true&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.expiresAt==='string'&&Number.isFinite(Date.parse(input.expiresAt)),'INPUT_INVALID');
      const fingerprint=fingerprintCanonicalRecord({input,ownerUserId:actor.userId});
      return repository.transact(document=>{
        const at=serverClock(),idempotency=collection(document,'ozonAccountReadIdempotency');
        if(Object.hasOwn(idempotency,input.idempotencyKey)){
          const existing=idempotency[input.idempotencyKey];requireValue(existing.inputFingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');
          const job=findSoftwareJobInDocument(document,existing.jobId);requireValue(job?.jobType===OZON_ACCOUNT_READ_JOB_TYPE,'JOB_REQUIRED');
          return {changed:false,result:{...viewJob(document,job),idempotentReplay:true}};
        }
        const candidate=sourceFor(document,input),binding=bindingFor(document,sourceId(input),input.skuPackageId,at,input);
        if(discovery)requireValue(candidate.createdByUserId===actor.userId,'PREPARATION_OWNER_CONFLICT');
        requireValue((discovery?candidate.revision:candidate.dataRevision)===input.expectedRevision,discovery?'PREPARATION_CHANGED':'CANDIDATE_CHANGED');
        requireValue(['bindingId','configurationVersion','scopeRef'].every(field=>binding[field]===input[field]),'BINDING_CHANGED');
        requireValue(Date.parse(input.expiresAt)>Date.parse(at),'AUTHORIZATION_EXPIRED');
        const authorizationRef=`account-read-authorization:${fingerprint}`,jobId=`account-read-job:${fingerprint}`;
        const scope=discovery?createOzonAccountDiscoveryScope({preparation:candidate,binding,authorizationRef,expiresAt:input.expiresAt}):createOzonAccountReadScope({candidateId:candidate.id,skuPackageId:input.skuPackageId,supplierSkuId:candidate.lifecycleV11.skuPackage.supplierSkuId,
          revision:input.expectedRevision,binding,authorizationRef,expiresAt:input.expiresAt});
        assertOzonAccountReadCandidate(candidate,scope);
        assertReadScopeCanBeAuthorized(document,candidate,scope);
        arrayCollection(document,'softwareJobAuthorizationRecords').push({schemaVersion:discovery?'software-job-authorization-record-v2':'software-job-authorization-record-v1',authorizationId:authorizationRef,
          authorizationType:discovery?'account_discovery_once':'account_read_once',status:'active',action:OZON_ACCOUNT_READ_JOB_TYPE,scopeBinding:clone(scope),authorizedByUserId:actor.userId,
          authorizedAt:at,expiresAt:input.expiresAt,maxUses:1,useCount:0,consumedByJobId:null,consumedAt:null});
        arrayCollection(document,'softwareJobCredentialBindings').push({schemaVersion:discovery?'software-job-credential-binding-v2':'software-job-credential-binding-v1',bindingId:`account-read-credential:${fingerprint}`,
          credentialAlias:binding.credentialAlias,status:'active',provider:'ozon_seller_api',sideEffectScope:OZON_ACCOUNT_READ_JOB_TYPE,scopeBinding:clone(scope),
          allowedWorkerIds:[worker.workerId],redaction:'credential_alias_only',boundAt:at,expiresAt:input.expiresAt});
        const job=createSoftwareJobEnvelope({jobId,...(discovery?{subject:scope.subject}:{candidateId:candidate.id,skuPackageId:input.skuPackageId}),revision:input.expectedRevision,jobType:OZON_ACCOUNT_READ_JOB_TYPE,
          createdAt:at,requestedByUserId:actor.userId,ownerUserId:actor.userId,requiredCapabilities:[OZON_ACCOUNT_READ_CAPABILITY],idempotencyKey:`account-read:${fingerprint}`,scopeBinding:scope});
        const admitted=bindSoftwareJobAdmissionForEnqueue({document,job,observedAt:at,phase:'enqueue_current'});
        enqueueSoftwareJobInDocument(document,admitted);idempotency[input.idempotencyKey]={inputFingerprint:fingerprint,jobId};
        return {changed:true,document,result:viewJob(document,admitted)};
      });
    },
    async continueSaved(input){
      requireValue(closed(input,[discovery?'preparationId':'candidateId','jobId','expectedRevision'])&&ref(sourceId(input))&&ref(input.jobId)&&Number.isSafeInteger(input.expectedRevision),'CONTINUATION_INPUT_INVALID');
      let current=await snapshot(input);if(current.job.status!=='queued')return viewJob(current.document,current.job);
      refreshActiveWorker(registered.version);
      const leaseId=`account-read-lease:${randomUUID()}`;
      try{await store.claim({jobId:input.jobId,worker:registered,leaseId,leaseDurationMs:worker.leaseDurationMs});}
      catch(error){
        if(error.message!=='SOFTWARE_JOB_CLAIM_REJECTED: 作业不是可领取状态')throw error;
        current=await snapshot(input);return viewJob(current.document,current.job);
      }
      await repository.transact(document=>{
        const job=findSoftwareJobInDocument(document,input.jobId),at=serverClock();
        collection(document,'ozonAccountReadReceipts')[job.jobId]=assertOzonAccountReadReceipt({schemaVersion:discovery?'ozon-account-read-receipt-v2':'ozon-account-read-receipt-v1',
          receiptId:`account-read-receipt:${job.jobId}`,jobId:job.jobId,scope:clone(job.scopeBinding),workerId:worker.workerId,leaseId,
          startedAt:at,completedAt:null,status:'in_flight',failureClass:null,steps:[]},job);
        return {changed:true,document};
      });
      for(const method of OZON_ACCOUNT_READ_METHODS){
        let begun;
        try{begun=await repository.transact(document=>{
          const job=findSoftwareJobInDocument(document,input.jobId),at=serverClock();guard(document,job,leaseId,at);
          const receipts=collection(document,'ozonAccountReadReceipts'),receipt=clone(receipts[job.jobId]);assertOzonAccountReadReceipt(receipt,job);
          requireValue(receipt.status==='in_flight'&&receipt.steps.length===OZON_ACCOUNT_READ_METHODS.indexOf(method),'STEP_ALREADY_ATTEMPTED');
          receipt.steps.push({method,intentAt:at,sentAt:null,completedAt:null,externalRequestState:'not_sent',requestTransmission:'not_attempted',result:null,errorCode:null});
          receipts[job.jobId]=assertOzonAccountReadReceipt(receipt,job);return {changed:true,document,result:clone(job)};
        });
        }catch(error){
          if(!isPermissionStop(error))throw error;
          return stopCurrent(input.jobId,leaseId,error.code??error.message);
        }
        const controller=new AbortController(),remaining=Math.max(1,Math.min(Date.parse(begun.leaseExpiresAt),Date.parse(begun.scopeBinding.expiresAt))-Date.parse(serverClock()));
        let timer;
        const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{const error=new OzonAccountReadError('LEASE_TIMEOUT');controller.abort(error);reject(error);},remaining);});
        let result;
        try{
          const request=buildOzonAccountReadRequest({method,scope:begun.scopeBinding,executionKey:`account-read-execution:${begun.jobId}:${method}`});
          const response=await Promise.race([requestJson(request,{signal:controller.signal,beforeRequestSend:async()=>{
            controller.signal.throwIfAborted();
            await repository.transact(document=>{
              controller.signal.throwIfAborted();
              let job=findSoftwareJobInDocument(document,input.jobId);const at=serverClock(),admission=guard(document,job,leaseId,at);
              const receipts=collection(document,'ozonAccountReadReceipts'),receipt=clone(receipts[job.jobId]);assertOzonAccountReadReceipt(receipt,job);
              const step=receipt.steps.at(-1);requireValue(receipt.status==='in_flight'&&step.method===method&&step.sentAt===null&&step.completedAt===null,'STEP_ALREADY_ATTEMPTED');
              controller.signal.throwIfAborted();
              // sentAt is the durable send-start intent time; requestTransmission records actual transport evidence.
              step.sentAt=at;step.externalRequestState='in_flight';step.requestTransmission='unknown';job=bindSoftwareJobAdmissionDecision(job,admission);
              if(job.status==='claimed')job=markSoftwareJobExternalRequestStarted({job,workerId:worker.workerId,leaseId,externalRequestRef:`account-read-request:${job.jobId}`,serverTime:at});
              replaceJob(document,job);receipts[job.jobId]=assertOzonAccountReadReceipt(receipt,job);return {changed:true,document};
            });
            controller.signal.throwIfAborted();
          }}),deadline]);
          result=normalizeOzonAccountReadResponse({method,response,scope:begun.scopeBinding,observedAt:serverClock(),officialContractRef:begun.scopeBinding.officialContractRefs[method]});
        }catch(error){
          controller.abort(error);
          if(!(error instanceof OzonDEHttpTransportError)&&!(error instanceof OzonAccountReadApiError)&&!(error instanceof OzonAccountReadError&&error.code==='OZON_ACCOUNT_READ_LEASE_TIMEOUT')&&!isPermissionStop(error))throw error;
          return finish(begun.jobId,leaseId,{method,errorCode:error.code??error.message,
            requestTransmission:error instanceof OzonAccountReadApiError?'response_received':error instanceof OzonDEHttpTransportError?error.requestTransmission:'unknown',
            externalRequestState:error instanceof OzonAccountReadApiError?'succeeded':error instanceof OzonDEHttpTransportError?error.externalRequestState:'unknown_outcome'});
        }finally{clearTimeout(timer);}
        const outcome=await finish(begun.jobId,leaseId,{method,result});if(outcome.status!=='waiting_platform')return outcome;
      }
      current=await snapshot(input);return viewJob(current.document,current.job);
    },
    view({document,candidateId,preparationId}){
      requireValue(document.runtime.softwareJobs===undefined||Array.isArray(document.runtime.softwareJobs),'REPOSITORY_INVALID');
      return (document.runtime.softwareJobs??[]).filter(job=>job.jobType===OZON_ACCOUNT_READ_JOB_TYPE&&Boolean(job.subject)===discovery&&sourceId(job)===(discovery?preparationId:candidateId)).map(job=>viewJob(document,job));
    }
  });
}
