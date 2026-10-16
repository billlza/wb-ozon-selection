import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { authorizeOperation, sameTeamUser, teamOperationRoles } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { normalizeAProductDetailServiceBindings } from './runtime-configuration.mjs';
import { assertLinkfoxProductDetailBinding } from './linkfox-product-detail-connector.mjs';
import { LINKFOX_DETAIL_CONTRACT_VERSION } from './linkfox-product-detail-api.mjs';
import { A_PRODUCT_DETAIL_JOB_TYPE, A_PRODUCT_DETAIL_CAPABILITY, AProductDetailError, assertAProductDetailPlan,
  assertAProductDetailScope, assertAProductDetailCandidateEligible, assertAProductDetailSource, assertAProductDetailAuthorization, assertAProductDetailCredential, assertAProductDetailReceipt } from './a-product-detail-contract.mjs';
import { createAProductDetailJobForScope, AProductDetailExecutionBlockedError } from './software-job-repository.mjs';
import { runAProductDetailSoftwareJob } from './a-product-detail-runner.mjs';
import { readCompletedADiscoveryBatch, assertADiscoveryCandidateImportRecord } from './a-discovery-candidate-import.mjs';
import { assertAProductDetailApplicationRecord } from './a-product-detail-application.mjs';

const clone=value=>structuredClone(value);
const closed=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const check=(value,code)=>{if(!value)throw new AProductDetailError(code);};
function owner(actor){authorizeOperation({actor,requiredRoles: teamOperationRoles(actor)});check(actor.actorType==='human'&&actor.source==='authenticated_identity_provider','AUTHENTICATED_OWNER_REQUIRED');}
function collection(document,key,array=false,create=false){
  if(!Object.hasOwn(document,'runtime')){
    if(!create)return array?[]:{};
    document.runtime={};
  }
  check(document.runtime!==null&&typeof document.runtime==='object'&&!Array.isArray(document.runtime),'REPOSITORY_INVALID');
  if(!Object.hasOwn(document.runtime,key)){
    if(!create)return array?[]:{};
    document.runtime[key]=array?[]:{};
  }
  const value=document.runtime[key];
  check(array?Array.isArray(value):value!==null&&typeof value==='object'&&!Array.isArray(value),'REPOSITORY_INVALID');return value;
}
function candidateFor(document,id,revision){
  check(Array.isArray(document.candidates),'REPOSITORY_INVALID');
  const matches=document.candidates.filter(candidate=>candidate.id===id);check(matches.length===1,'CANDIDATE_REQUIRED');
  const candidate=matches[0];check(candidate.dataRevision===revision,'CANDIDATE_CHANGED');return candidate;
}

/** Independent detail permission enriches one saved A candidate; it never confirms a supplier SKU. */
export function createAProductDetailRuntimeServices({repository,softwareJobStore,runtimeMode,serverClock,workerRegistry,
  serviceBindings=[],connectorBindings=[],readSecret,fetchImpl,onError,onDetailsReady}={}){
  if(runtimeMode==='local_development')assertBusinessStateRepositoryBoundary(repository);
  else if(['central_test','central_production'].includes(runtimeMode))assertCentralPersistenceBoundary(repository);
  else throw new TypeError('A_PRODUCT_DETAIL_RUNTIME_MODE_INVALID');
  if(typeof serverClock!=='function'||typeof readSecret!=='function'||typeof fetchImpl!=='function'||typeof onError!=='function'||typeof onDetailsReady!=='function'||
    ['register','heartbeat'].some(key=>typeof workerRegistry?.[key]!=='function')||
    ['get','claim','listAssignableWithDiagnostics','enqueueAProductDetailInDocument','assertAProductDetailExecutionInDocument','settleAProductDetailInDocument'].some(key=>typeof softwareJobStore?.[key]!=='function'))throw new TypeError('A_PRODUCT_DETAIL_SERVICE_DEPENDENCY_INVALID');
  const connectors=connectorBindings.map(assertLinkfoxProductDetailBinding),bindings=normalizeAProductDetailServiceBindings(serviceBindings,connectors);
  const services=bindings.map(binding=>{
    const worker={workerId:binding.workerId,version:binding.workerVersion,capabilities:[A_PRODUCT_DETAIL_CAPABILITY]};
    workerRegistry.register({...worker,observedAt:serverClock()});
    return {binding,worker,connector:connectors.find(value=>value.bindingId===binding.connectorBindingId&&value.configurationVersion===binding.connectorConfigurationVersion)};
  });
  let active=null,activeExecution=null,lastAdmissionRejection=null,started=false,timer=null,failed=false,notificationError=null;
  const controllers=new Set();
  const heartbeat=service=>workerRegistry.heartbeat({...service.worker,status:'online'});
  function serviceFor(bindingId,configurationVersion){
    const matches=services.filter(value=>value.connector.bindingId===bindingId&&value.connector.configurationVersion===configurationVersion);
    check(matches.length===1,'SERVICE_NOT_CONFIGURED');return matches[0];
  }
  function discoverySourceFor(document,candidate,actor){
    assertAProductDetailCandidateEligible(candidate);
    const evidence=candidate.aDiscoveryEvidenceV1;check(evidence?.schemaVersion==='a-discovery-candidate-evidence-v1','SOURCE_INVALID');
    check(Object.hasOwn(collection(document,'aDiscoveryBatches'),evidence.batchId),'SOURCE_INVALID');
    const {batch,receipts}=readCompletedADiscoveryBatch({document,batchId:evidence.batchId,revision:evidence.sourceRevision});
    check(sameTeamUser(batch.ownerUserId,actor.userId),'OWNER_CONFLICT');
    check(Object.hasOwn(collection(document,'aDiscoveryCandidateImports'),`${batch.batchId}:${batch.revision}`),'SOURCE_INVALID');
    const imported=assertADiscoveryCandidateImportRecord(collection(document,'aDiscoveryCandidateImports')[`${batch.batchId}:${batch.revision}`],{batchId:batch.batchId,revision:batch.revision});
    check(imported.status==='imported'&&imported.candidateId===candidate.id&&imported.marketProductId===evidence.marketProductId&&
      evidence.planId===batch.plan.planId&&evidence.planVersion===batch.plan.version&&evidence.marketReceiptRef===receipts[0].receiptId&&
      candidate.targetStore===batch.targetStore&&candidate.targetPlatform==='ozon'&&evidence.exactSkuMatch==='unknown'&&evidence.businessEffect==='discovery_evidence_only'&&
      receipts.length>=2&&Array.isArray(evidence.supplierReceiptRefs)&&evidence.supplierReceiptRefs[0]===receipts[1].receiptId,'SOURCE_INVALID');
    const market=receipts[0],supplier=receipts[1];
    return {batchId:evidence.batchId,batchRevision:evidence.sourceRevision,planId:evidence.planId,planVersion:evidence.planVersion,
      marketProductId:evidence.marketProductId,marketReceiptRef:market.receiptId,marketJobId:market.jobId,
      supplierOfferId:supplier.steps[0].result.products[0].productId,supplierReceiptRef:supplier.receiptId,supplierJobId:supplier.jobId};
  }
  function scopesFor(document,candidate,service,actor,expiresAt,idempotencyKey){
    const discoverySource=discoverySourceFor(document,candidate,actor);
    const identity=fingerprintCanonicalRecord({candidateId:candidate.id,revision:candidate.dataRevision,discoverySource});
    const detailPlan=assertAProductDetailPlan({schemaVersion:'a-product-detail-plan-v1',planId:`a-product-detail-plan:${identity}`,version:'version:1',
      contractVersion:LINKFOX_DETAIL_CONTRACT_VERSION,requests:[{requestId:`detail-market:${identity}`,method:'ozon_detail',productId:discoverySource.marketProductId},
        {requestId:`detail-supplier:${identity}`,method:'supplier_detail',productId:discoverySource.supplierOfferId}],budget:{unit:'linkfox_credits',maxRequests:2,maxCredits:13}});
    return detailPlan.requests.map((request,requestIndex)=>{
      const authorizationRef=`a-product-detail-permit:${fingerprintCanonicalRecord({candidateId:candidate.id,revision:candidate.dataRevision,requestIndex,idempotencyKey,ownerUserId:actor.userId})}`;
      const scope=assertAProductDetailScope({schemaVersion:'a-product-detail-scope-v1',candidateId:candidate.id,sourceRevision:candidate.dataRevision,resultRevision:candidate.dataRevision,
        targetStore:candidate.targetStore,discoverySource,detailPlan,requestIndex,request,authorizationRef,expiresAt,bindingId:service.connector.bindingId,
        configurationVersion:service.connector.configurationVersion,credentialAlias:service.connector.credentialAlias,budgetPolicyRef:service.connector.budgetPolicyRef});
      assertAProductDetailSource({document,candidate,scope});return scope;
    });
  }
  function singleflight(operation){if(active)return active;active=operation().catch(error=>{failed=true;throw error;}).finally(()=>{active=null;});return active;}
  async function continueReady(candidateId=null){
    const document=await repository.readSnapshot(),jobs=collection(document,'softwareJobs',true),receipts=collection(document,'aProductDetailReceipts'),applications=collection(document,'aProductDetailApplications');
    for(const job of jobs){
      if(job.jobType!==A_PRODUCT_DETAIL_JOB_TYPE||job.status!=='completed'||job.externalRequestState!=='succeeded'||job.scopeBinding.requestIndex!==1||candidateId!==null&&job.subject.candidateId!==candidateId)continue;
      const id=job.subject.candidateId,sourceRevision=job.scopeBinding.sourceRevision,key=`${id}:${sourceRevision}`;
      if(Object.hasOwn(applications,key)){assertAProductDetailApplicationRecord(applications[key],{candidateId:id,sourceRevision});continue;}
      const related=jobs.filter(value=>value.jobType===A_PRODUCT_DETAIL_JOB_TYPE&&value.subject.candidateId===id&&value.revision===sourceRevision);
      if(related.length!==2||!related.every(value=>value.status==='completed'&&value.externalRequestState==='succeeded'))continue;
      if(!related.every(value=>assertAProductDetailReceipt(receipts[value.jobId],value).steps[0].result.status==='observed'))continue;
      return onDetailsReady({candidateId:id,sourceRevision});
    }
    return null;
  }
  async function runSelected(service,job){
    const leaseId=`lease:a-product-detail:${randomUUID()}`,controller=new AbortController();controllers.add(controller);
    activeExecution={jobId:job.jobId,workerId:service.worker.workerId,leaseId};
    try{
      const result=await runAProductDetailSoftwareJob({repository,softwareJobStore,worker:heartbeat(service),jobId:job.jobId,leaseId,
        leaseDurationMs:service.binding.leaseDurationMs,connectorBinding:service.connector,readSecret,fetchImpl,serverClock,signal:controller.signal});
      lastAdmissionRejection=null;
      if(result.status==='completed'){const application=await continueReady(job.subject.candidateId);if(application!==null)return {...result,application};}
      return result;
    }catch(error){
      if(error instanceof AProductDetailExecutionBlockedError){lastAdmissionRejection={jobId:job.jobId,code:error.code};return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};}
      failed=true;throw error;
    }finally{controllers.delete(controller);activeExecution=null;}
  }
  function runDue(){return singleflight(async()=>{
    if(failed)return {status:'failed',externalRequests:0};
    if(services.length===0)return {status:'not_configured',externalRequests:0};
    const application=await continueReady();if(application!==null)return {status:'continued',application,externalRequests:0};
    for(const service of services){
      const {assignable,rejected}=await softwareJobStore.listAssignableWithDiagnostics({worker:heartbeat(service),jobType:A_PRODUCT_DETAIL_JOB_TYPE,limit:1});
      if(assignable.length)return runSelected(service,assignable[0]);
      if(rejected.length){lastAdmissionRejection=clone(rejected[0]);return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};}
    }
    return {status:'idle',externalRequests:0};
  });}
  function schedule(){if(!started)return;timer=setTimeout(async()=>{
    timer=null;try{await runDue();}catch(error){started=false;failed=true;try{await onError(error);}catch(cause){notificationError=cause;}return;}schedule();
  },bindings[0].pumpIntervalMs);timer.unref?.();}
  return Object.freeze({
    get status(){return failed?'failed':started?'running':services.length?'stopped':'not_configured';},
    get activeExecution(){return clone(activeExecution);},get lastAdmissionRejection(){return clone(lastAdmissionRejection);},get notificationError(){return notificationError;},
    configurationView:clone(bindings),runDue,
    view({document,actor,candidateId,expectedRevision}){
      owner(actor);const candidate=candidateFor(document,candidateId,expectedRevision),jobs=collection(document,'softwareJobs',true).filter(job=>job.jobType===A_PRODUCT_DETAIL_JOB_TYPE&&job.subject.candidateId===candidateId),
        receipts=collection(document,'aProductDetailReceipts'),applications=collection(document,'aProductDetailApplications');
      const batch=collection(document,'aDiscoveryBatches')[candidate.aDiscoveryEvidenceV1?.batchId];if(batch!==undefined)check(sameTeamUser(batch.ownerUserId,actor.userId),'OWNER_CONFLICT');
      const savedApplications=Object.values(applications).filter(value=>value.candidateId===candidateId).map(value=>assertAProductDetailApplicationRecord(value,{candidateId,sourceRevision:value.sourceRevision}));
      let discoverySource,preparationBlockCode=null;
      const existing=jobs.find(job=>job.scopeBinding.requestIndex===0);
      if(existing){discoverySource=assertAProductDetailScope(existing.scopeBinding,existing).discoverySource;preparationBlockCode=savedApplications.length?'ALREADY_APPLIED':'ALREADY_AUTHORIZED';}
      else{
        try{discoverySource=discoverySourceFor(document,candidate,actor);}
        catch(error){
          if(error instanceof AProductDetailError&&['CANDIDATE_CHANGED','SOURCE_INVALID'].includes(error.code))preparationBlockCode=error.code;
          else throw error;
        }
        if(preparationBlockCode===null&&services.length!==1)preparationBlockCode='SERVICE_NOT_CONFIGURED';
      }
      const proposedReads=discoverySource?[{method:'ozon_detail',productId:discoverySource.marketProductId,productUrl:`https://www.ozon.ru/product/${discoverySource.marketProductId}/`},
        {method:'supplier_detail',productId:discoverySource.supplierOfferId,productUrl:`https://detail.1688.com/offer/${discoverySource.supplierOfferId}.html`}]:[];
      return {schemaVersion:'a-product-detail-view-v1',candidateId,revision:expectedRevision,bindings:connectors.map(value=>({bindingId:value.bindingId,configurationVersion:value.configurationVersion})),
        budget:{unit:'linkfox_credits',maxRequests:2,maxCredits:13},proposedReads,preparationBlockCode,jobs:jobs.map(job=>({job:clone(job),receipt:Object.hasOwn(receipts,job.jobId)?assertAProductDetailReceipt(receipts[job.jobId],job):null,
          canContinue:job.status==='queued'&&job.attempt===0&&job.externalRequestState==='not_sent'&&job.revision===expectedRevision&&Date.parse(serverClock())<Date.parse(job.scopeBinding.expiresAt)&&
            services.some(value=>['bindingId','configurationVersion','credentialAlias','budgetPolicyRef'].every(key=>value.connector[key]===job.scopeBinding[key]))})),
        applications:savedApplications,canAuthorize:preparationBlockCode===null,runtimeStatus:failed?'failed':started?'running':services.length?'stopped':'not_configured',
        activeExecution:clone(activeExecution),lastAdmissionRejection:clone(lastAdmissionRejection),platformWrites:0};
    },
    async authorizeAndRun({actor,input}){
      owner(actor);check(closed(input,['candidateId','expectedRevision','bindingId','configurationVersion','expiresAt','idempotencyKey'])&&
        ['candidateId','bindingId','configurationVersion','idempotencyKey'].every(key=>isCanonicalFrozenRef(input[key]))&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&
        typeof input.expiresAt==='string'&&Number.isFinite(Date.parse(input.expiresAt)),'INPUT_INVALID');
      const service=serviceFor(input.bindingId,input.configurationVersion);
      const authorized=await repository.transact(document=>{
        const candidate=candidateFor(document,input.candidateId,input.expectedRevision),at=serverClock();check(Date.parse(input.expiresAt)>Date.parse(at),'AUTHORIZATION_EXPIRED');
        const scopes=scopesFor(document,candidate,service,actor,input.expiresAt,input.idempotencyKey),authorizations=collection(document,'softwareJobAuthorizationRecords',true,true),credentials=collection(document,'softwareJobCredentialBindings',true,true);
        const existing=authorizations.filter(value=>value.action===A_PRODUCT_DETAIL_JOB_TYPE&&value.scopeBinding.candidateId===candidate.id);
        const applications=collection(document,'aProductDetailApplications');check(!Object.values(applications).some(value=>value.candidateId===candidate.id),'ALREADY_APPLIED');
        if(existing.length){
          check(existing.length===2&&scopes.every(scope=>existing.some(record=>record.authorizationId===scope.authorizationRef&&isDeepStrictEqual(record.scopeBinding,scope))),'ALREADY_AUTHORIZED');
          const job=collection(document,'softwareJobs',true).find(value=>value.jobType===A_PRODUCT_DETAIL_JOB_TYPE&&value.scopeBinding.authorizationRef===scopes[0].authorizationRef);
          check(job!==undefined,'JOB_SOURCE_CONFLICT');return {changed:false,result:clone(job)};
        }
        for(const scope of scopes){
          authorizations.push(assertAProductDetailAuthorization({schemaVersion:'software-job-authorization-record-v3',authorizationId:scope.authorizationRef,authorizationType:'a_product_detail_once',
            status:'active',action:A_PRODUCT_DETAIL_JOB_TYPE,scopeBinding:scope,authorizedByUserId:actor.userId,authorizedAt:at,expiresAt:scope.expiresAt,maxUses:1,useCount:0,consumedByJobId:null,consumedAt:null}));
          credentials.push(assertAProductDetailCredential({schemaVersion:'software-job-credential-binding-v3',bindingId:`a-product-detail-credential:${scope.authorizationRef.slice('a-product-detail-permit:'.length)}`,
            credentialAlias:scope.credentialAlias,status:'active',provider:'linkfox',sideEffectScope:A_PRODUCT_DETAIL_JOB_TYPE,scopeBinding:scope,allowedWorkerIds:[service.worker.workerId],redaction:'credential_alias_only',boundAt:at,expiresAt:scope.expiresAt}));
        }
        collection(document,'aProductDetailReceipts',false,true);
        const job=softwareJobStore.enqueueAProductDetailInDocument({document,job:createAProductDetailJobForScope({scope:scopes[0],ownerUserId:actor.userId,createdAt:at}),observedAt:at});
        return {changed:true,document,result:clone(job)};
      });
      if(active&&activeExecution?.jobId!==authorized.jobId)return {status:'queued',jobId:authorized.jobId,externalRequests:0};
      return singleflight(()=>runSelected(service,authorized));
    },
    continueSavedCurrent({actor,input}){
      owner(actor);check(closed(input,['candidateId','expectedRevision','jobId'])&&isCanonicalFrozenRef(input.candidateId)&&isCanonicalFrozenRef(input.jobId)&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,'INPUT_INVALID');
      check(!active||activeExecution?.jobId===input.jobId,'SERVICE_BUSY');
      return singleflight(async()=>{
        const document=await repository.readSnapshot(),candidate=candidateFor(document,input.candidateId,input.expectedRevision),job=await softwareJobStore.get(input.jobId);
        check(job?.subject?.candidateId===candidate.id&&job.revision===candidate.dataRevision,'CANDIDATE_CHANGED');
        const {batch}=assertAProductDetailSource({document,candidate,scope:job.scopeBinding});check(sameTeamUser(batch.ownerUserId,actor.userId),'OWNER_CONFLICT');
        return runSelected(serviceFor(job.scopeBinding.bindingId,job.scopeBinding.configurationVersion),job);
      });
    },
    start(){if(started||failed||!services.length)return;started=true;schedule();},
    async stop(){started=false;clearTimeout(timer);timer=null;for(const controller of controllers)controller.abort(new AProductDetailError('CANCELLED'));if(active)await active;}
  });
}
