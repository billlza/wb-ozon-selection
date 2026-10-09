import { createSoftwareExecutionRuntime, openExceptionCase } from './software-execution-state.mjs';
import { createDPlatformObservationRuntime } from './d-platform-observation-use-case.mjs';
import { assertDPlatformObservationAdmission, assertDRemainingInventorySend, readOwnerStockDecision } from './d-platform-observation-contract.mjs';
import { randomUUID } from 'node:crypto';
import { assertCurrentDExecutionContext } from './platform-write-preflight.mjs';
import { decodeAttempt } from './d-execution-request-codec.mjs';
import { isDeepStrictEqual } from 'node:util';
import { normalizeDEServiceBindings } from './runtime-configuration.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { assertWorkerRegistryBoundary } from './worker-registry.mjs';
import { createActorContext } from './runtime-identity.mjs';
import { createRepositoryBackedSoftwareJobStore } from './software-job-repository.mjs';
import { findSoftwareJobInDocument, softwareJobsInDocument, bindSoftwareJobAdmissionDecision, markSoftwareJobExternalRequestStarted,
  settleDProductionPreSendStopInDocument } from './software-job-contract.mjs';
import { assertDProductionJobReference, settleDPreparationJobInDocument } from './d-e-software-job-handoff.mjs';
import { resolveRegisteredC2FinalAsset } from './c2-upload-draft.mjs';
import { assertDEJobAdmissionDecision } from './d-e-software-job-admission.mjs';
import { createProductionPlan } from './production-plan.mjs';
import { runPlatformWritePreflight, assertCurrentProductionExecutionBinding } from './platform-write-preflight.mjs';
import { productionJobPrewriteCode, AliyunOssLocalPreparationError } from './production-execution-failure.mjs';
import { prepareSingleSkuDExecution } from './d-e-software-closure.mjs';
import { runPersistedDExecution, runPersistedDRemainingInventory } from './d-e-software-integration.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from './ozon-seller-api-de-adapter.mjs';
import { createDBatchImportSoftwareService } from './d-batch-import-software-service.mjs';
import { createSystemEReadbackSoftwareRuntime } from './e-readback-software-use-case.mjs';
import { createDAssetTransportSoftwareRuntime } from './d-asset-transport-software-use-case.mjs';
import { createDProductionPreparationIntent, completeDProductionPreparation, markDProductionPreparationUnknown,
  assertDProductionPreparationContinuation } from './d-production-preparation-contract.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';

const terminal = job => ['completed','failed','unknown_outcome'].includes(job.status);
const clone = value => structuredClone(value);
const remainingInventoryPreSendFailures = new Set([
  'DE_RUNTIME_INVENTORY_PROOF_UNAVAILABLE', 'DE_RUNTIME_INVENTORY_OBSERVATION_CHANGED',
  'D_PLATFORM_OBSERVATION_SOURCE_CONFLICT', 'D_PLATFORM_OBSERVATION_JOB_SOURCE_CONFLICT',
  'D_PLATFORM_OBSERVATION_POLICY_EXPIRED', 'D_PLATFORM_OBSERVATION_INVENTORY_HOLDER_INVALID',
  'D_PLATFORM_OBSERVATION_PREREQUISITE_SOURCE_UNVERIFIED'
]);
function knownRemainingInventoryPreSendFailure(error) {
  return error instanceof DERuntimeUnavailableError || productionJobPrewriteCode(error)!==null ||
    error?.constructor===Error && remainingInventoryPreSendFailures.has(error.message);
}
export class DERuntimeUnavailableError extends Error {
  constructor(code) { super(`DE_RUNTIME_UNAVAILABLE_${code}`); this.name='DERuntimeUnavailableError'; this.code=this.message; }
}
/** Explicit transport-boundary error; unrelated internal errors retain their original identity. */
export class DEPreflightTransportError extends Error {
  constructor(code) {
    if (!['timeout','cancelled','connection_failed','response_lost'].includes(code)) throw new TypeError('DE_PREFLIGHT_TRANSPORT_CODE_INVALID');
    super(`DE_PREFLIGHT_TRANSPORT_${code.toUpperCase()}`); this.name='DEPreflightTransportError'; this.code=this.message;
  }
}
function inputShape(input) {
  if (!input || Object.keys(input).length!==3 || !['candidateId','jobId','expectedRevision'].every(k=>Object.hasOwn(input,k)) ||
      !isCanonicalFrozenRef(input.candidateId) || !isCanonicalFrozenRef(input.jobId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0) throw new Error('DE_RUNTIME_INPUT_INVALID');
}
function candidateIn(document, id) {
  const candidates=document.candidates.filter(candidate=>candidate.id===id);
  if(candidates.length!==1) throw new Error('DE_RUNTIME_CANDIDATE_NOT_FOUND');
  return candidates[0];
}
function replaceJob(document, job) {
  const jobs=softwareJobsInDocument(document),index=jobs.findIndex(value=>value.jobId===job.jobId);
  if(index<0) throw new Error('DE_RUNTIME_JOB_NOT_FOUND'); jobs[index]=clone(job);
}
/** Construct routing and registered capabilities only. No candidate/job read, credential resolution or provider invocation. */
export function createDEProductionRuntimeServices({ repository, runtimeMode, serverClock, workerRegistry,
  deServiceBindings=[],productionBindings=[],requestJson=null,inspectPlatform=null,loadAdapterCapabilities=null,loadBatchMemberEvidence=null,loadBatchEReadEvidence=null,
  upload=null,resolveLocalAsset=null,loadCurrentProductionBinding=null,preflightRequestMode='external_read',loadDPlatformObservationPolicy=null,verifyInventoryPrerequisiteSource=null,
  observationPumpIntervalMs=null,onObservationError=null,eReadbackPumpIntervalMs=null,onReadbackError=null }={}) {
  assertBusinessStateRepositoryBoundary(repository); assertWorkerRegistryBoundary(workerRegistry);
  if(typeof serverClock!=='function' || [requestJson,inspectPlatform,loadAdapterCapabilities,loadBatchMemberEvidence,loadBatchEReadEvidence,upload,resolveLocalAsset,loadCurrentProductionBinding,loadDPlatformObservationPolicy,verifyInventoryPrerequisiteSource,onObservationError,onReadbackError]
    .some(value=>value!==null&&typeof value!=='function')) throw new Error('DE_RUNTIME_DEPENDENCY_INVALID');
  if((loadBatchMemberEvidence===null)!==(loadBatchEReadEvidence===null))
    throw new Error('DE_RUNTIME_BATCH_EVIDENCE_DEPENDENCY_INCOMPLETE');
  if(!['external_read','persisted_evidence_only'].includes(preflightRequestMode)) throw new Error('DE_RUNTIME_PREFLIGHT_REQUEST_MODE_INVALID');
  if(eReadbackPumpIntervalMs!==null && (!Number.isSafeInteger(eReadbackPumpIntervalMs)||eReadbackPumpIntervalMs<1000||eReadbackPumpIntervalMs>2147483647)) throw new Error('DE_RUNTIME_E_PUMP_INTERVAL_INVALID');
  const bindings=normalizeDEServiceBindings(deServiceBindings,productionBindings), services=new Map();
  for(const binding of bindings){
    const worker=workerRegistry.register({workerId:binding.workerId,version:binding.workerVersion,
      capabilities:['ozon-production-execution','ozon-independent-readback'],observedAt:serverClock()});
    services.set(binding.productionBindingId,{binding,worker});
  }
  function production(candidate, service) {
    const binding=loadCurrentProductionBinding===null ? productionBindings.find(value=>value.bindingId===service.binding.productionBindingId) : loadCurrentProductionBinding(candidate);
    if(binding && typeof binding.then==='function') throw new TypeError('DE_RUNTIME_CURRENT_BINDING_MUST_BE_SYNCHRONOUS');
    return binding;
  }
  const batchImportService = requestJson !== null && loadBatchMemberEvidence !== null && loadBatchEReadEvidence !== null
    ? createDBatchImportSoftwareService({ repository, runtimeMode, workerRegistry, serverClock, services,
      loadCurrentProductionBinding: production, loadBatchMemberEvidence, loadBatchEReadEvidence,
      loadBatchObservationPolicy: ({candidate,productionBinding}) => loadDPlatformObservationPolicy?.({candidate,
        job:{skuPackageId:candidate.lifecycleV11.skuPackage.skuPackageId,
          scopeBinding:{productionBinding:{bindingId:productionBinding.bindingId,
            configurationVersion:productionBinding.configurationVersion}}}}) ?? null,
      requestJson }) : null;
  const localWorkerHeartbeatIntervalMs=workerRegistry.persistenceClass==='local_development_ephemeral'
    ? Math.floor(workerRegistry.heartbeatTtlMs/3) : null;
  if(batchImportService!==null && observationPumpIntervalMs!==null &&
    localWorkerHeartbeatIntervalMs!==null &&
    (!Number.isSafeInteger(localWorkerHeartbeatIntervalMs)||localWorkerHeartbeatIntervalMs<250))
    throw new Error('DE_RUNTIME_LOCAL_WORKER_HEARTBEAT_INTERVAL_INVALID');
  let batchObservationPumpStarted=false,batchObservationTimer=null,batchObservationActive=null;
  let localWorkerHeartbeatStarted=false,localWorkerHeartbeatTimer=null;
  function scheduleLocalWorkerHeartbeat() {
    if(!localWorkerHeartbeatStarted)return;
    localWorkerHeartbeatTimer=setTimeout(()=>{
      try{
        for(const service of services.values()){
          const eligible=workerRegistry.findEligible(['ozon-production-execution'])
            .find(worker=>worker.workerId===service.worker.workerId);
          if(!eligible || eligible.version!==service.worker.version ||
            !isDeepStrictEqual(eligible.capabilities,service.worker.capabilities))
            throw new Error('DE_RUNTIME_LOCAL_WORKER_HEARTBEAT_EXPIRED');
          workerRegistry.heartbeat({workerId:eligible.workerId,version:eligible.version,
            capabilities:eligible.capabilities,status:eligible.status});
        }
      }catch(error){
        localWorkerHeartbeatStarted=false;
        batchObservationPumpStarted=false;clearTimeout(batchObservationTimer);
        onObservationError(error);
        return;
      }
      scheduleLocalWorkerHeartbeat();
    },localWorkerHeartbeatIntervalMs);
  }
  function scheduleBatchObservation() {
    if(!batchObservationPumpStarted)return;
    batchObservationTimer=setTimeout(()=>{
      batchObservationActive=batchImportService.runDueBatchContinuations();
      batchObservationActive.then(()=>{batchObservationActive=null;scheduleBatchObservation();},error=>{
        batchObservationActive=null;
        batchObservationPumpStarted=false;
        onObservationError(error);
      });
    },observationPumpIntervalMs);
  }
  function resolveBinding({candidate,job}) {
    const service=services.get(job.scopeBinding.productionBinding.bindingId);
    if(!service) throw new DERuntimeUnavailableError('SERVICE');
    const current=production(candidate,service);
    if(!current) throw new DERuntimeUnavailableError('PRODUCTION_BINDING');
    return {schemaVersion:'d-e-execution-binding-v1',serviceId:service.binding.serviceId,serviceConfigurationVersion:service.binding.configurationVersion,
      productionBinding:{bindingId:current.bindingId,configurationVersion:current.configurationVersion,warehouseId:current.warehouseId},
      platform:current.platform,storeRef:clone(current.storeRef),warehouseRef:current.warehouseRef,credentialAlias:current.credentialAlias,
      workerId:service.worker.workerId,workerVersion:service.worker.version,configurationEvidence:clone(current.verification)};
  }
  function refreshActiveWorker(service, expectedVersion=service.worker.version) {
    const current=workerRegistry.get(service.worker.workerId);
    if(current?.status!=='online' || current.version!==expectedVersion || current.version!==service.worker.version ||
      !isDeepStrictEqual(current.capabilities,service.worker.capabilities)) throw new Error('WORKER_REGISTRY_WORKER_NOT_CURRENT');
    // A running checkpoint proves local liveness, never a renewed lease or permission to revive a changed worker.
    workerRegistry.heartbeat({workerId:current.workerId,version:current.version,capabilities:current.capabilities,status:current.status});
  }
  function refreshJobWorker({document,jobId,workerId,leaseId,observedAt}) {
    const job=findSoftwareJobInDocument(document,jobId);
    if(!job || job.workerId!==workerId || job.leaseId!==leaseId || Date.parse(observedAt)>=Date.parse(job.leaseExpiresAt)) return;
    const service=services.get(job.scopeBinding.productionBinding.bindingId);
    if(!service || service.worker.workerId!==workerId) throw new Error('WORKER_REGISTRY_WORKER_NOT_CURRENT');
    refreshActiveWorker(service,job.workerVersion);
  }
  const activeReadbacks=new Map();
  const eExecutions=new Map(),eControllers=new Map();
  let ePumpStarted=false,ePumpTimer=null,ePumpActive=null,stopping=false;
  const historyReadback=createSystemEReadbackSoftwareRuntime({repository,runtimeMode,serverClock,readPlatform:null});
  const persistedJobStore=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,serverClock,workerRegistry,resolveDEExecutionBinding:resolveBinding});
  // Keep liveness in the runtime; the repository still owns every source, authorization and lease check.
  const jobStore=Object.freeze({...persistedJobStore,
    assertDEExecutionInDocument(context) {
      refreshJobWorker(context);
      return persistedJobStore.assertDEExecutionInDocument(context);
    },
    assertDPlatformObservationExecutionInDocument(context) {
      refreshJobWorker(context);
      return persistedJobStore.assertDPlatformObservationExecutionInDocument(context);
    }
  });
  async function snapshot(input) {
    const document=await repository.readSnapshot(),candidate=candidateIn(document,input.candidateId),job=findSoftwareJobInDocument(document,input.jobId);
    if(!job) throw new Error('DE_RUNTIME_JOB_NOT_FOUND');
    if(job.candidateId!==candidate.id||job.skuPackageId!==candidate.lifecycleV11.skuPackage.skuPackageId||!['d_production_execution','e_independent_readback','e_d_platform_observation'].includes(job.jobType)) throw new Error('DE_RUNTIME_JOB_SOURCE_CONFLICT');
    if(job.jobType === 'e_d_platform_observation') assertDPlatformObservationAdmission(job,job.admissionDecision);
    else assertDEJobAdmissionDecision(job,job.admissionDecision);
    return {document,candidate,job};
  }
  function replay({document,candidate,job},input) {
    if(input.expectedRevision!==job.revision && input.expectedRevision!==candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
    if(job.jobType==='d_production_execution') assertDProductionJobReference({document,candidate,job});
    else if(job.jobType === 'e_independent_readback' && fingerprintCanonicalRecord(candidate.lifecycleV11.skuPackage.productionRecord)!==job.scopeBinding.sourceProductionRecordFingerprint) throw new Error('DE_RUNTIME_REPLAY_SOURCE_CONFLICT');
    return {status:'idempotent_replay',candidate:clone(candidate),job:clone(job)};
  }
  function available(candidate,job) {
    const service=services.get(job.scopeBinding.productionBinding.bindingId);
    if(!service) throw new DERuntimeUnavailableError('SERVICE');
    for(const [name,value] of [['TRANSPORT',requestJson],['CAPABILITIES',loadAdapterCapabilities],...(job.jobType==='d_production_execution'?[['PREFLIGHT',inspectPlatform]]:[])]) {
      if(value===null) throw new DERuntimeUnavailableError(name);
    }
    const sku=candidate.lifecycleV11.skuPackage;
    if(job.jobType==='d_production_execution' && sku.productionAuthorization.lockedScope.finalUploads.some(asset=>asset.assetRef.startsWith('local-asset:')) && !sku.dAssetTransport && (upload===null||resolveLocalAsset===null)) throw new DERuntimeUnavailableError('ASSET_TRANSPORT');
    return service;
  }
  function actor(service) { return createActorContext({userId:service.worker.workerId,sessionId:`worker-session:${service.worker.workerId}:${service.binding.configurationVersion}`,
    actorType:'worker',roles:['operator'],source:'registered_runtime_worker',authenticatedAt:serverClock()}); }
  async function prepare(candidate,job,service,context,plan,capabilities) {
    const begun=await repository.transact(document=>{
      const observedAt=serverClock(),guard=jobStore.assertDEExecutionInDocument({document,...context,observedAt});
      if(guard.candidate.dataRevision!==candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
      if(guard.job.preparationEvidence) return {changed:false,result:{replay:true}};
      const productionBinding=production(guard.candidate,service);
      assertCurrentProductionExecutionBinding({productionAuthorization:plan.sourceAuthorization,currentProductionBinding:productionBinding,checkedAt:observedAt});
      let next=bindSoftwareJobAdmissionDecision(guard.job,guard.admissionDecision);
      if(preflightRequestMode==='external_read'&&next.status==='claimed') next=markSoftwareJobExternalRequestStarted({job:next,...context,externalRequestRef:`d-production-request:${job.scopeBinding.authorizationFingerprint}`,serverTime:observedAt});
      const evidence=createDProductionPreparationIntent({job:next,candidateRevision:candidate.dataRevision,productionPlan:plan,startedAt:observedAt,requestMode:preflightRequestMode});
      next={...next,preparationEvidence:evidence};replaceJob(document,next);
      return {changed:true,document,result:{evidence,inspectionContext:clone({candidate:guard.candidate,job:next,
        candidateRevision:guard.candidate.dataRevision,sourceRevision:next.revision,productionAuthorization:plan.sourceAuthorization,
        productionPlan:plan,productionBinding,preparationEvidence:evidence,workerId:next.workerId,leaseId:next.leaseId})}};
    });
    if(begun.replay) return {proceed:false};
    let next;
    try {
      const preflight=await runPlatformWritePreflight({productionPlan:plan,checkedAt:begun.evidence.startedAt,inspectPlatform:async query=>{
        const controller=new AbortController();
        const remaining=Math.max(1,Date.parse(begun.inspectionContext.job.leaseExpiresAt)-Date.parse(serverClock()));
        let timer;
        const deadline=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>{const error=new DEPreflightTransportError('timeout');controller.abort(error);reject(error);},remaining);
        });
        try { return await Promise.race([Promise.resolve().then(()=>inspectPlatform(query,{...clone(begun.inspectionContext),signal:controller.signal})),deadline]); }
        finally { clearTimeout(timer); }
      }});
      let prepared;
      try {
        prepared=prepareSingleSkuDExecution({productionPlan:plan,productionAuthorization:plan.sourceAuthorization,platformWritePreflight:preflight,
          adapterCapabilities:capabilities,currentProductionBinding:production(candidate,service),preparedAt:serverClock()});
      } catch(error) {
        const code=productionJobPrewriteCode(error); if(code===null) throw error;
        prepared={schemaVersion:'d-software-execution-v2',preparedAt:serverClock(),
          sourceProductionPlanId:begun.evidence.sourceProductionPlanId,sourceProductionPlanFingerprint:begun.evidence.sourceProductionPlanFingerprint,
          sourceAuthorizationFingerprint:begun.evidence.sourceAuthorizationFingerprint,
          status:'not_ready',gaps:[{code,field:'productionExecution',message:'当前生产执行条件已变化，本轮停止'}]};
      }
      next=completeDProductionPreparation({evidence:begun.evidence,platformWritePreflight:preflight,adapterCapabilities:capabilities,preparedExecution:prepared,completedAt:serverClock()});
    } catch(error) {
      if(!(error instanceof DEPreflightTransportError)) throw error;
      next=markDProductionPreparationUnknown({evidence:begun.evidence,completedAt:serverClock()});
    }
    return repository.transact(document=>{
      const current=candidateIn(document,candidate.id),saved=findSoftwareJobInDocument(document,job.jobId);
      if(!isDeepStrictEqual(saved.preparationEvidence,begun.evidence)) throw new Error('DE_RUNTIME_PREPARATION_CONFLICT');
      const sourceChanged=current.dataRevision!==next.sourceCandidateRevision || !isDeepStrictEqual(current.lifecycleV11.skuPackage.productionAuthorization,plan.sourceAuthorization);
      let admissionBlocked=false;
      if(!terminal(saved)) {
        try { jobStore.assertDEExecutionInDocument({document,...context,observedAt:serverClock()}); }
        catch(error) { if(productionJobPrewriteCode(error)===null) throw error; admissionBlocked=true; }
      }
      const evidence={...next,continuationBlocked:next.continuationBlocked||sourceChanged||admissionBlocked||terminal(saved)};
      assertDProductionPreparationContinuation(saved.preparationEvidence,evidence);
      replaceJob(document,{...saved,preparationEvidence:evidence});
      if(evidence.requestMode==='persisted_evidence_only'&&saved.status==='failed'&&saved.externalRequestState==='not_sent'&&saved.externalRequestRef===null){
        return {changed:true,document,result:{proceed:false,evidence}};
      }
      const settled=settleDPreparationJobInDocument({document,candidate:current,jobId:job.jobId,...context,observedAt:serverClock()});
      const resulting=findSoftwareJobInDocument(document,job.jobId);
      return {changed:true,document,result:{proceed:evidence.status==='ready'&&!evidence.continuationBlocked&&!terminal(resulting),evidence,settled}};
    });
  }
  /**
   * 纯元数据检查，不读一个字节、不发一个请求：每张已授权素材在上传登记里都找得到、且逐字段对得上。
   * 2026-09-23 背心就是死在这一条上——而它是在执行意图落盘之后才被发现的，那一下已经把候选
   * revision 推过了授权那一版，这个授权就再也建不出新一轮。能在动候选之前查的，就必须在那之前查。
   * 文件字节仍由上传器在建立凭据、发出第一个 put 之前逐张核验，这里不重复读 36 MB。
   */
  function assertFinalUploadsRegistered({candidate,finalUploads}) {
    if(!candidate.lifecycleV11?.c2UploadDraft) return;
    for(const asset of finalUploads){
      if(!asset.assetRef.startsWith('local-asset:')) continue;
      try { resolveRegisteredC2FinalAsset(candidate,asset); }
      catch(error) {
        if(error?.constructor===Error&&String(error.extra?.code).startsWith('c2_')) throw new AliyunOssLocalPreparationError('OSS_LOCAL_ASSET_INVALID');
        throw error;
      }
    }
  }
  /**
   * A guard that rejects after the claim used to leave the job held as `claimed` with no failureClass: no request had
   * been sent, but nothing recorded the stop either, so the task could never be read as finished or continued again.
   * The known technical failure is persisted here instead. This never retries, renews a lease or re-enqueues; it only
   * refuses when the holder has already moved on, in which case the original error stays the visible result.
   */
  async function stopClaimedDBeforeSend(context,failureCode) {
    return repository.transact(document=>{
      const observedAt=serverClock();
      const settled=settleDProductionPreSendStopInDocument(document,{jobId:context.jobId,workerId:context.workerId,
        leaseId:context.leaseId,failureClass:`d-production-guard-rejected:${failureCode}`},observedAt);
      return {changed:true,document,result:{status:settled.status,candidate:clone(candidateIn(document,settled.candidateId)),job:clone(settled)}};
    });
  }
  async function runE(input,known=null) {
    const active=eExecutions.get(input.jobId);
    if(active){
      if(!isDeepStrictEqual(active.input,input))throw new Error('DE_RUNTIME_E_CONCURRENT_INPUT_CONFLICT');
      return active.execution;
    }
    if(stopping)return {status:'stopped'};
    const controller=new AbortController();eControllers.set(input.jobId,controller);
    const execution=performE(input,known,controller.signal);eExecutions.set(input.jobId,{input:clone(input),execution});
    try{return await execution;}finally{eExecutions.delete(input.jobId);eControllers.delete(input.jobId);}
  }
  async function performE(input,known,stopSignal) {
    const initial=known||await snapshot(input);
    if(terminal(initial.job)||initial.job.status!=='queued') return replay(initial,input);
    if(input.expectedRevision!==initial.candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
    const service=available(initial.candidate,initial.job);refreshActiveWorker(service);
    const leaseId=`lease:de:${randomUUID()}`,workerActor=actor(service);
    await jobStore.claim({jobId:input.jobId,worker:service.worker,leaseId,leaseDurationMs:service.binding.leaseDurationMs});
    const context={jobStore,jobId:input.jobId,workerId:service.worker.workerId,leaseId};
    const runtime=createSystemEReadbackSoftwareRuntime({repository,runtimeMode,serverClock,readPlatform:async(query,options)=>{
      const current=await snapshot(input);
      const capabilities=await loadAdapterCapabilities({candidate:clone(current.candidate),productionBinding:clone(production(current.candidate,service)),job:clone(current.job)});
      const guardedRead=async(request,options)=>{
        const beforeRequestSend=()=>repository.transact(document=>{
          jobStore.assertDEExecutionInDocument({document,...context,observedAt:serverClock()});
          return {changed:false,result:null};
        });
        await beforeRequestSend();
        return requestJson(request,{...options,beforeRequestSend});
      };
      return createStoreIsolatedOzonSellerApiDEAdapter({requestJson:guardedRead,adapterCapabilities:capabilities}).readbackSellerApi(query,
        {...options,signal:AbortSignal.any([options.signal,stopSignal])});
    }});
    activeReadbacks.set(input.jobId,runtime);
    try {
      return await runtime.run({actor:workerActor,input:{candidateId:input.candidateId,expectedCandidateRevision:initial.candidate.dataRevision,
        sourceRecordId:initial.candidate.lifecycleV11.skuPackage.productionRecord.productionRecordId},softwareJobContext:context});
    } finally { activeReadbacks.delete(input.jobId); }
  }
  async function resumeInventory({sourceDJobId,observationJobId}) {
    const document=await repository.readSnapshot(),job=findSoftwareJobInDocument(document,sourceDJobId),candidate=candidateIn(document,job.candidateId);
    let service,capabilities;
    const leaseId=`lease:d-inventory:${randomUUID()}`;
    try {
      const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
      if(candidate.dataRevision!==state.expectedCandidateRevision ||
        !isDeepStrictEqual(candidate.lifecycleV11.skuPackage.productionAuthorization,state.productionPlan.sourceAuthorization) ||
        Date.parse(serverClock())>=Date.parse(state.platformContinuation.policy.expiresAt))
        return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'context_changed'});
    service=available(candidate,job);refreshActiveWorker(service);
    capabilities=await loadAdapterCapabilities({candidate:clone(candidate),job:clone(job),productionBinding:clone(production(candidate,service))});
    if(verifyInventoryPrerequisiteSource === null || !capabilities.inventoryWrite.prerequisitePolicy) return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'inventory_policy_missing'});
    const initialProof=await verifyInventoryPrerequisiteSource({candidate:clone(candidate),job:clone(job),productionBinding:clone(production(candidate,service))});
    if(initialProof === null) return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'context_changed'});
    if(typeof initialProof.assertCurrent !== 'function') throw new Error('DE_RUNTIME_INVENTORY_PROOF_INVALID');
    const verify=args=>initialProof.assertCurrent(args) === true &&
      isDeepStrictEqual(args.prerequisites.priceSentObservation.policy,capabilities.inventoryWrite.prerequisitePolicy) &&
      isDeepStrictEqual(args.prerequisites.inventoryPrerequisiteObservation.policy,capabilities.inventoryWrite.prerequisitePolicy);
    // 三岔（主人 2026-09-24 决定：库存他自己填）：
    //   回读值 === 授权锁定值 → 只登记，不发任何库存写请求，也不生成 productionRecord；
    //   回读值 === 0          → 软件写入档，现行路径不变；
    //   其他任何数            → 停下报主人，不覆盖、不重写。
    const stock=readOwnerStockDecision({document,job,observationJobId,checkedAt:serverClock(),
      verifyInventoryPrerequisiteSource:verify});
    if(stock.decision==='register') {
      return jobStore.registerOwnerWrittenInventory({jobId:sourceDJobId,observationJobId,
        verifyInventoryPrerequisiteSource:verify,actorId:job.ownerUserId});
    }
    if(stock.decision==='mismatch') {
      return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'inventory_stock_mismatch'});
    }
    // 冻结的导入请求若已经无法按当前代码重建（背心就是：23171 标签格式在 r69 改过，
    // 它那份是旧格式），软件写入必然在执行中途撞 D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH。
    // 与其给主人留一条注定失败的路，不如在**发出任何请求之前**停下并说清楚。
    // 新授权的品其冻结请求是按当前代码现建的，这里必然通过，正常写库存的路不受影响。
    try {
      assertCurrentDExecutionContext({request:decodeAttempt(state.attempt).request,
        executionContext:{productionPlan:state.productionPlan,
          currentProductionBinding:production(candidate,service),serverClock}});
    } catch(error) {
      if(!String(error?.message).startsWith('D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH')) throw error;
      return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'inventory_request_superseded'});
    }
    await jobStore.claimDRemainingInventory({jobId:sourceDJobId,worker:service.worker,leaseId,
      leaseDurationMs:service.binding.leaseDurationMs,observationJobId,verifyInventoryPrerequisiteSource:verify});
    } catch(error) {
      if(!(error instanceof DERuntimeUnavailableError) && ![
        'D_PLATFORM_OBSERVATION_SOURCE_CONFLICT','D_PLATFORM_OBSERVATION_POLICY_EXPIRED',
        'D_PLATFORM_OBSERVATION_PREREQUISITE_SOURCE_UNVERIFIED',
        'SOFTWARE_JOB_ADMISSION_DE_BINDING_EVIDENCE_EXPIRED','SOFTWARE_JOB_ADMISSION_DE_BINDING_CHANGED'
      ].includes(error.message))throw error;
      return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'context_changed'});
    }
    const context={jobStore,jobId:sourceDJobId,workerId:service.worker.workerId,leaseId};
    let observation;
    const assertRemainingInventoryAuthorization=async()=>{
      const latest=await repository.readSnapshot(),latestJob=findSoftwareJobInDocument(latest,sourceDJobId),latestCandidate=candidateIn(latest,latestJob.candidateId);
      const proof=await verifyInventoryPrerequisiteSource({candidate:clone(latestCandidate),job:clone(latestJob),productionBinding:clone(production(latestCandidate,service))});
      if(proof === null) throw new Error('DE_RUNTIME_INVENTORY_PROOF_UNAVAILABLE');
      if(typeof proof.assertCurrent !== 'function') throw new TypeError('DE_RUNTIME_INVENTORY_PROOF_INVALID');
      return repository.transact(current=>{
      const held=findSoftwareJobInDocument(current,sourceDJobId),observedAt=serverClock();
      const currentCandidate=candidateIn(current,held.candidateId);
      assertCurrentProductionExecutionBinding({productionAuthorization:currentCandidate.lifecycleV11.skuPackage.productionAuthorization,
        currentProductionBinding:production(currentCandidate,service),checkedAt:observedAt});
      const validated=assertDRemainingInventorySend({document:current,job:held,observationJobId,checkedAt:observedAt,
        workerId:service.worker.workerId,leaseId,verifyInventoryPrerequisiteSource:proof.assertCurrent});
      if(observation !== undefined && !isDeepStrictEqual(observation,validated.prerequisites)) throw new Error('DE_RUNTIME_INVENTORY_OBSERVATION_CHANGED');
      observation=validated.prerequisites;
      return {changed:false,result:null};
      });
    };
    try {
      await assertRemainingInventoryAuthorization();
    } catch(error) {
      const known=knownRemainingInventoryPreSendFailure(error);
      const stopped=await repository.transact(current=>{
        const at=serverClock();
        const settled=jobStore.stopDRemainingInventoryBeforeSendInDocument({document:current,...context,observedAt:at});
        const currentCandidate=candidateIn(current,settled.candidateId);
        if(!known) {
          const prior=currentCandidate.executionRuntime || createSoftwareExecutionRuntime({candidateId:currentCandidate.id,
            dataRevision:currentCandidate.dataRevision,businessPhase:'D',stepId:'D_REMAINING_INVENTORY',at});
          if(prior.exceptionCase?.status!=='open')currentCandidate.executionRuntime=openExceptionCase({...prior,
            businessPhase:'D',stepId:'D_REMAINING_INVENTORY'}, {
            exceptionId:`exception:d-inventory-pre-send:${sourceDJobId}`,reasonCode:'system_failure',failureLayer:'d_inventory_pre_send',
            evidenceRefs:[settled.resultRef],skuPackageId:settled.skuPackageId,softwareJobId:sourceDJobId,
            lastSuccessfulStepId:'import_result_observed',externalRequestRefs:[settled.platformContinuation.requestReceiptRef],
            unknownOutcome:false,sourceRevision:settled.revision,at});
        }
        return {changed:true,document:current,result:{status:settled.status,job:clone(settled),candidate:clone(currentCandidate)}};
      });
      if(!known)throw error;
      return stopped;
    }
    const outcome=await runPersistedDRemainingInventory({repository,candidateId:candidate.id,softwareJobContext:context,serverClock,
      currentProductionBinding:production(candidate,service),observation,assertRemainingInventoryAuthorization,
      createAdapter:({executionContext})=>createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities,executionContext})});
    if(outcome.status!=='succeeded')return outcome;
    const saved=await repository.readSnapshot(),current=candidateIn(saved,candidate.id),source=findSoftwareJobInDocument(saved,sourceDJobId);
    const eRef=current.lifecycleV11.eIndependentReadbackJobRefV1;
    if(source.status!=='completed'||source.resultEnvelope.applicationDisposition!=='applied'||!eRef)throw new Error('DE_RUNTIME_E_HANDOFF_MISSING');
    const e=await runE({candidateId:current.id,jobId:eRef.jobId,expectedRevision:current.dataRevision});
    return {status:e.status,d:outcome,e};
  }
  const observationRuntime=createDPlatformObservationRuntime({repository,jobStore,serverClock,pumpIntervalMs:observationPumpIntervalMs,
    onError:onObservationError,onPrerequisitesObserved:resumeInventory,resolveExecution:async({candidate,job})=>{
      const service=available(candidate,job);refreshActiveWorker(service);
      return {worker:service.worker,leaseDurationMs:service.binding.leaseDurationMs,createAdapter:async()=>{
        const capabilities=await loadAdapterCapabilities({candidate:clone(candidate),job:clone(job),productionBinding:clone(production(candidate,service))});
        return createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities});
      }};
    }});
  async function runDueEReadbacks() {
    if(ePumpActive)return ePumpActive;
    ePumpActive=(async()=>{
      let rejection=null;
      for(const service of services.values()){
        refreshActiveWorker(service);
        const {assignable:jobs,rejected}=await jobStore.listAssignableWithDiagnostics({worker:service.worker,jobType:'e_independent_readback',limit:1});
        if(rejected.length>0&&rejection===null)rejection=rejected[0];
        if(jobs.length===0)continue;
        const job=jobs[0];
        if(job.status!=='queued'||job.attempt!==0||job.externalRequestState!=='not_sent'||job.externalRequestRef!==null)throw new Error('DE_RUNTIME_E_QUEUE_SOURCE_CONFLICT');
        try{return await runE({candidateId:job.candidateId,jobId:job.jobId,expectedRevision:job.revision});}
        catch(error){
          if(!(error instanceof DERuntimeUnavailableError))throw error;
          return {status:'blocked',rejection:{jobId:job.jobId,candidateId:job.candidateId,code:error.code}};
        }
      }
      return rejection===null?{status:'idle'}:{status:'blocked',rejection};
    })();
    try{return await ePumpActive;}finally{ePumpActive=null;}
  }
  function scheduleEReadback(){
    if(ePumpStarted)ePumpTimer=setTimeout(()=>{
      runDueEReadbacks().then(scheduleEReadback,error=>{ePumpStarted=false;onReadbackError(error);});
    },eReadbackPumpIntervalMs);
  }
  return Object.freeze({
    start(){
      if(eReadbackPumpIntervalMs!==null && onReadbackError===null)throw new Error('DE_RUNTIME_E_PUMP_ERROR_HANDLER_REQUIRED');
      if(batchImportService!==null && observationPumpIntervalMs!==null && onObservationError===null)
        throw new Error('DE_RUNTIME_BATCH_OBSERVATION_ERROR_HANDLER_REQUIRED');
      stopping=false;
      if(observationPumpIntervalMs!==null)observationRuntime.start();
      if(batchImportService!==null && observationPumpIntervalMs!==null && !batchObservationPumpStarted){
        batchObservationPumpStarted=true;scheduleBatchObservation();
      }
      if(batchImportService!==null && observationPumpIntervalMs!==null &&
        workerRegistry.persistenceClass==='local_development_ephemeral' && !localWorkerHeartbeatStarted){
        localWorkerHeartbeatStarted=true;scheduleLocalWorkerHeartbeat();
      }
      if(eReadbackPumpIntervalMs!==null&&!ePumpStarted){ePumpStarted=true;scheduleEReadback();}
    },
    async stop(){
      stopping=true;ePumpStarted=false;clearTimeout(ePumpTimer);
      batchObservationPumpStarted=false;clearTimeout(batchObservationTimer);
      localWorkerHeartbeatStarted=false;clearTimeout(localWorkerHeartbeatTimer);
      for(const controller of eControllers.values())controller.abort(new Error('DE_RUNTIME_STOPPED'));
      await observationRuntime.stop();
      if(batchObservationActive)await batchObservationActive;
      await Promise.all([...eExecutions.values()].map(value=>value.execution));
      if(ePumpActive)await ePumpActive;
    },runDueObservations:observationRuntime.runDue,runDueEReadbacks,resumeInventory,
    readbackView(candidate) {
      const jobId=candidate?.lifecycleV11?.eIndependentReadbackJobRefV1?.jobId;
      const active=activeReadbacks.get(jobId);
      return (active || historyReadback).view(candidate);
    },
    configurationView:Object.freeze(bindings.map(binding=>Object.freeze(clone(binding)))),
    dependencyView:Object.freeze({transport:requestJson!==null,preflight:inspectPlatform!==null,capabilities:loadAdapterCapabilities!==null,
      assetTransport:upload!==null&&resolveLocalAsset!==null}),
    async continueAuthorizedBatchImport(input) {
      if(batchImportService===null) throw new DERuntimeUnavailableError('BATCH_IMPORT');
      return batchImportService.runAuthorizedBatch(input);
    },
    async resumeAuthorizedBatchContinuations(input){
      if(batchImportService===null)throw new DERuntimeUnavailableError('BATCH_IMPORT');
      return batchImportService.resumeAuthorizedBatchContinuations(input);
    },
    async observeBatchImportChunk(input) {
      if(batchImportService===null) throw new DERuntimeUnavailableError('BATCH_IMPORT');
      return batchImportService.observeBatchChunk(input);
    },
    async runDueBatchImportObservations() {
      if(batchImportService===null) throw new DERuntimeUnavailableError('BATCH_IMPORT');
      return batchImportService.runDueBatchObservations();
    },
    async reclaimBatchImportLease(input) {
      if(batchImportService===null) throw new DERuntimeUnavailableError('BATCH_IMPORT');
      return batchImportService.reclaimBatchLease(input);
    },
    async continueSavedCurrent(input) {
      inputShape(input);let current=await snapshot(input);
      if(current.job.jobType==='e_independent_readback') return runE(input,current);
      if(current.job.jobType==='e_d_platform_observation') {
        if(input.expectedRevision !== current.candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
        return observationRuntime.runJob({jobId:input.jobId});
      }
      if(current.job.status!=='queued') return replay(current,input);
      if(input.expectedRevision!==current.candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
      const service=available(current.candidate,current.job);refreshActiveWorker(service);
      // 平台查询策略必须在「发导入之前」就查。2026-09-24 背心死在这一条上：策略在 r65 被设成
      // 一个绝对时刻（09-23 14:00Z），导入在 09-24 02:14Z 才发出，而过期判定写在导入被接受之后
      // （d-e-software-integration.mjs:651），于是平台已经收下商品、软件却自断后路，观察和库存全没做。
      // 该砍的要在最早能判断的那一刻砍：这里是零副作用位置，还没传图、还没落执行意图。
      const observationPolicyCheckedAt=serverClock();
      const earlyObservationPolicy=loadDPlatformObservationPolicy===null?null
        :await loadDPlatformObservationPolicy({candidate:clone(current.candidate),job:clone(current.job),checkedAt:observationPolicyCheckedAt});
      // 光判「此刻没过期」不够：观察最长要跑 maxQueries × intervalMs（现配置 100 × 30 秒 = 50 分钟）。
      // 策略若在这段窗口里到期，观察作业会在中途以 context_changed 停下——又是一次「发出去了没人管」。
      // 所以要求剩余寿命覆盖整个观察窗口，再加一个租约时长的余量。
      const observationWindowMs=earlyObservationPolicy===null?0
        :earlyObservationPolicy.maxQueries*earlyObservationPolicy.intervalMs+(service.binding.leaseDurationMs??0);
      const observationRemainingMs=earlyObservationPolicy===null?0
        :Date.parse(earlyObservationPolicy.expiresAt)-Date.parse(observationPolicyCheckedAt);
      const observationPolicyGap=earlyObservationPolicy===null?'observation_policy_missing'
        :observationRemainingMs<=0?'observation_policy_expired'
        :observationRemainingMs<observationWindowMs?'observation_policy_expiring_within_window':null;
      if(observationPolicyGap!==null){
        const held=await snapshot(input);
        return {status:'observation_policy_unavailable',reason:observationPolicyGap,
          policyExpiresAt:earlyObservationPolicy?.expiresAt??null,checkedAt:observationPolicyCheckedAt,
          requiredWindowMs:observationWindowMs,remainingMs:Math.max(0,observationRemainingMs),
          candidate:clone(held.candidate),job:clone(held.job),externalRequests:0,platformWrites:0};
      }
      const leaseId=`lease:de:${randomUUID()}`,workerActor=actor(service);
      const claimed=await jobStore.claim({jobId:input.jobId,worker:service.worker,leaseId,leaseDurationMs:service.binding.leaseDurationMs});
      const context={jobStore,jobId:input.jobId,workerId:service.worker.workerId,leaseId};
      try {
      current=await snapshot(input);
      // Read persisted protocol/account evidence before any public asset upload.
      let capabilities=await loadAdapterCapabilities({candidate:clone(current.candidate),productionBinding:clone(production(current.candidate,service)),job:clone(current.job)});
      let sku=current.candidate.lifecycleV11.skuPackage;
      const accountAndProtocolsReady=capabilities.gaps.every(gap=>gap.code==='asset_transport_not_verified');
      if(accountAndProtocolsReady&&sku.productionAuthorization.lockedScope.finalUploads.some(asset=>asset.assetRef.startsWith('local-asset:'))&&!sku.dAssetTransport){
        // 先把「本地这几张图读不读得出、登记对不对得上」全部查完，再去落盘执行意图。
        // 落盘那一下会把候选 revision 推到下一版，而 D 作用域钉死在授权那一版；一旦推过去，
        // 这个授权就再也建不出新一轮了。本地能查的事就必须在那之前查，失败停在零副作用。
        assertFinalUploadsRegistered({candidate:current.candidate,finalUploads:sku.productionAuthorization.lockedScope.finalUploads});
        const assets=createDAssetTransportSoftwareRuntime({repository,runtimeMode,serverClock,upload,resolveLocalAsset,loadCurrentProductionBinding:({candidate})=>production(candidate,service)});
        const result=await assets.run({actor:workerActor,input:{candidateId:input.candidateId,expectedCandidateRevision:current.candidate.dataRevision},softwareJobContext:context});
        if(result.assetTransportState.status!=='verified'||result.assetTransportState.continuationBlocked) return result;
        current=await snapshot(input);
        capabilities=await loadAdapterCapabilities({candidate:clone(current.candidate),productionBinding:clone(production(current.candidate,service)),job:clone(current.job)});
      }
      current=await snapshot(input);sku=current.candidate.lifecycleV11.skuPackage;
      const plan=sku.dAssetTransport?.intent.productionPlan||createProductionPlan({productionAuthorization:sku.productionAuthorization,candidateId:current.candidate.id,
        candidateRevision:current.candidate.dataRevision,skuPackage:sku,createdAt:serverClock()});
      const preparation=await prepare(current.candidate,claimed,service,context,plan,capabilities);
      if(!preparation.proceed) {
        const stopped=await snapshot(input);
        return {status:stopped.job.status,candidate:clone(stopped.candidate),job:clone(stopped.job)};
      }
      // 上面已在零副作用处确认策略存在且未过期；这里重新取一次当前值，仍按原样传给执行层。
      const platformObservationPolicy=loadDPlatformObservationPolicy === null ? null : await loadDPlatformObservationPolicy({candidate:clone(current.candidate),job:clone(current.job),checkedAt:serverClock()});
      const d=await runPersistedDExecution({repository,runtimeMode,platformObservationPolicy,serverClock,actor:workerActor,candidateId:input.candidateId,
        expectedCandidateRevision:current.candidate.dataRevision,productionPlan:plan,platformWritePreflight:preparation.evidence.result.platformWritePreflight,
        adapterCapabilities:capabilities,currentProductionBinding:production(current.candidate,service),softwareJobContext:context,
        createAdapter:async({executionContext})=>createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities,executionContext})});
      current=await snapshot(input);
      const eRef=current.candidate.lifecycleV11.eIndependentReadbackJobRefV1;
      if(d.status==='succeeded'&&current.job.status==='completed'&&current.job.resultEnvelope.applicationDisposition==='applied'&&eRef){
        const e=await runE({candidateId:input.candidateId,jobId:eRef.jobId,expectedRevision:current.candidate.dataRevision});return {status:e.status,d,e};
      }
      return d;
      } catch(error) {
        // 本地素材准备失败同样是「证明一个请求都没发出去」的已知技术失败。
        const failureCode=productionJobPrewriteCode(error) ??
          (error instanceof AliyunOssLocalPreparationError ? error.code : null);
        if(failureCode===null) throw error;
        let stopped=null;
        // Refusing to stop means the holder already moved past "claimed, nothing sent"; the original failure stands.
        try { stopped=await stopClaimedDBeforeSend(context,failureCode); } catch { stopped=null; }
        if(stopped===null) throw error;
        return stopped;
      }
    }
  });
}
