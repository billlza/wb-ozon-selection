import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { authorizeOperation, teamOperationRoles } from './runtime-identity.mjs';
import { isCanonicalFrozenRef, fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { createSoftwareJobResultEnvelope } from './software-job-contract.mjs';
import { createOzonAccountReadRuntime } from './ozon-account-read-runtime.mjs';
import { assertOzonAccountDiscoveryBinding, assertOzonAccountPreparation, assertOzonAccountReadAuthorization,
  assertOzonAccountReadCredential, readOzonAccountReadTerminal, OzonAccountReadError } from './ozon-account-read-contract.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const closed=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const requireValue=(value,code)=>{if(!value)throw new OzonAccountReadError(code);};
const bindingFields=['scopeRef','bindingId','configurationVersion','platform','targetStore','storeIdentityStatus','credentialAlias','clientIdRef','officialContractRefs'];
function owner(actor){authorizeOperation({actor,requiredRoles: teamOperationRoles(actor)});requireValue(actor.actorType==='human'&&actor.source==='authenticated_identity_provider','AUTHENTICATED_OWNER_REQUIRED');}
function map(document,key){if(!Object.hasOwn(document.runtime,key))document.runtime[key]={};requireValue(object(document.runtime[key]),'REPOSITORY_INVALID');return document.runtime[key];}
function preparationFor(document,id,actor){
  const value=document.runtime.ozonAccountPreparations?.[id];requireValue(value!==undefined,'PREPARATION_REQUIRED');
  const preparation=assertOzonAccountPreparation(value);requireValue(preparation.createdByUserId===actor.userId,'PREPARATION_OWNER_CONFLICT');return preparation;
}
function jobsFor(document,preparation){
  requireValue(document.runtime.softwareJobs===undefined||Array.isArray(document.runtime.softwareJobs),'REPOSITORY_INVALID');
  return (document.runtime.softwareJobs??[]).filter(job=>job.jobType==='ozon_account_read'&&job.subject?.preparationId===preparation.preparationId)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

/** Account preparation is a real subject in the existing queue. Creation and warehouse selection are local owner decisions only. */
export function createOzonAccountDiscoveryServices({repository,workerRegistry,serverClock,worker,loadCurrentReadBinding,listBindings,requestJson}){
  requireValue(typeof listBindings==='function','CONFIGURATION_INVALID');
  const runtime=createOzonAccountReadRuntime({repository,workerRegistry,serverClock,worker,loadCurrentReadBinding,requestJson,subjectKind:'account_preparation'});
  function currentBinding(document,preparationId,input){
    const value=loadCurrentReadBinding({document,preparationId,bindingId:input.bindingId,configurationVersion:input.configurationVersion,checkedAt:serverClock()});
    requireValue(value!==null,'BINDING_REQUIRED');const binding=assertOzonAccountDiscoveryBinding(value);
    requireValue(['bindingId','configurationVersion','scopeRef'].every(field=>binding[field]===input[field]),'BINDING_CHANGED');return binding;
  }
  function sourceForSelection(document,preparation,jobId){
    const jobs=jobsFor(document,preparation),job=jobs.find(value=>value.jobId===jobId);
    requireValue(job!==undefined&&jobs[0]?.jobId===jobId&&(jobs.length<2||jobs[0].createdAt!==jobs[1].createdAt),'SOURCE_SUPERSEDED');
    const receipt=document.runtime.ozonAccountReadReceipts?.[jobId],terminal=readOzonAccountReadTerminal(receipt,job);
    requireValue(job.schemaVersion==='software-job-v2'&&job.status==='completed'&&terminal.status==='completed'&&
      job.externalRequestState==='succeeded'&&terminal.externalRequestState==='succeeded'&&job.ownerUserId===preparation.createdByUserId&&
      job.requestedByUserId===preparation.createdByUserId&&job.revision<=preparation.revision,'SOURCE_NOT_COMPLETED');
    const scope=receipt.scope;
    const expected=createSoftwareJobResultEnvelope({job,resultRef:receipt.receiptId,payloadKind:'ozon_account_read',
      payload:{schemaVersion:'ozon-account-read-job-result-v1',receiptRef:receipt.receiptId,scopeFingerprint:scope.inputFingerprint},recordedAt:receipt.completedAt});
    requireValue(job.resultRef===receipt.receiptId&&isDeepStrictEqual(job.resultEnvelope,expected),'SOURCE_RESULT_CONFLICT');
    requireValue(bindingFields.every(field=>isDeepStrictEqual(scope[field],preparation.binding[field]))&&
      isDeepStrictEqual(currentBinding(document,preparation.preparationId,preparation.binding),preparation.binding),'BINDING_CHANGED');
    requireValue(Array.isArray(document.runtime.softwareJobAuthorizationRecords)&&Array.isArray(document.runtime.softwareJobCredentialBindings),'SOURCE_PERMISSION_REQUIRED');
    const permissions=document.runtime.softwareJobAuthorizationRecords.filter(value=>value.authorizationId===scope.authorizationRef);
    const credentials=document.runtime.softwareJobCredentialBindings.filter(value=>value.sideEffectScope==='ozon_account_read'&&value.scopeBinding?.authorizationRef===scope.authorizationRef);
    requireValue(permissions.length===1&&credentials.length===1,'SOURCE_PERMISSION_REQUIRED');
    const permission=assertOzonAccountReadAuthorization(permissions[0]),credential=assertOzonAccountReadCredential(credentials[0]);
    requireValue(permission.useCount===1&&permission.consumedByJobId===jobId&&permission.authorizedByUserId===preparation.createdByUserId&&
      isDeepStrictEqual(permission.scopeBinding,scope)&&isDeepStrictEqual(credential.scopeBinding,scope)&&credential.allowedWorkerIds.includes(job.workerId)&&
      Date.parse(permission.authorizedAt)<=Date.parse(receipt.startedAt)&&Date.parse(credential.boundAt)<=Date.parse(receipt.startedAt)&&
      Date.parse(receipt.completedAt)<Date.parse(permission.expiresAt)&&Date.parse(receipt.completedAt)<Date.parse(credential.expiresAt),'SOURCE_PERMISSION_CONFLICT');
    const at=Date.parse(serverClock()),roles=receipt.steps[0].result.facts;
    requireValue(at>=Date.parse(receipt.completedAt)&&at<Date.parse(scope.expiresAt)&&at<Date.parse(roles.expiresAt),'SOURCE_EXPIRED');
    return {job,receipt,warehouses:receipt.steps[2].result.facts.warehouses,hasNext:receipt.steps[2].result.facts.hasNext};
  }
  function view({document,actor}){
    owner(actor);
    const bindings=listBindings().map(value=>{
      const binding=assertOzonAccountDiscoveryBinding(Object.fromEntries(bindingFields.map(field=>[field,value[field]])));
      requireValue(typeof value.storeName==='string'&&value.storeName.length>0&&value.storeName.length<=256&&typeof value.clientId==='string'&&/^[1-9][0-9]{0,18}$/.test(value.clientId),'CONFIGURATION_INVALID');
      return {...binding,storeName:value.storeName,clientId:value.clientId};
    });
    const saved=document.runtime.ozonAccountPreparations;
    requireValue(saved===undefined||object(saved),'REPOSITORY_INVALID');
    const preparations=Object.values(saved??{}).filter(value=>value.createdByUserId===actor.userId).map(value=>{
      const preparation=assertOzonAccountPreparation(value),jobs=runtime.view({document,preparationId:preparation.preparationId}).sort((a,b)=>b.job.createdAt.localeCompare(a.job.createdAt));
      const currentRoute=loadCurrentReadBinding({document,preparationId:preparation.preparationId,bindingId:preparation.binding.bindingId,
        configurationVersion:preparation.binding.configurationVersion,checkedAt:serverClock()});
      const bindingAvailable=currentRoute!==null&&isDeepStrictEqual(assertOzonAccountDiscoveryBinding(currentRoute),preparation.binding);
      const current=jobs[0];let source=null,sourceBlocker=null;
      if(current?.status==='completed'){
        try{source=sourceForSelection(document,preparation,current.job.jobId);}catch(error){if(!(error instanceof OzonAccountReadError))throw error;sourceBlocker=error.code;}
      }
      return {preparation,...(source?{warehouses:structuredClone(source.warehouses),hasNext:source.hasNext,sourceJobId:source.job.jobId,sourceReceiptId:source.receipt.receiptId}:{warehouses:[],hasNext:null,sourceJobId:null,sourceReceiptId:null}),
        sourceBlocker,configurationBlocker:bindingAvailable?null:'account_route_unavailable',canSelectWarehouse:bindingAvailable&&source!==null,
        jobs:jobs.map(value=>({jobId:value.job.jobId,status:value.status,expectedRevision:value.job.revision,requestsSent:value.requestsSent,
          failureClass:value.receipt?.failureClass??null,observedMethods:value.observedMethods,
          canContinue:bindingAvailable&&value.status==='queued'&&value.job.attempt===0&&value.job.revision===preparation.revision&&Date.parse(serverClock())<Date.parse(value.job.scopeBinding.expiresAt)})),
        canAuthorize:bindingAvailable&&(jobs.length===0||jobs.every(value=>value.status==='failed'&&value.job.externalRequestState!=='unknown_outcome'))};
    });
    return {schemaVersion:'ozon-account-discovery-view-v1',bindings,preparations,platformWrites:0};
  }
  return Object.freeze({view,
    async createPreparation({actor,input}){
      owner(actor);requireValue(closed(input,['bindingId','configurationVersion','scopeRef','idempotencyKey'])&&Object.values(input).every(isCanonicalFrozenRef),'INPUT_INVALID');
      const fingerprint=fingerprintCanonicalRecord({action:'create_account_preparation',input,ownerUserId:actor.userId});
      return repository.transact(document=>{
        const idempotency=map(document,'ozonAccountPreparationIdempotency'),saved=idempotency[input.idempotencyKey];
        if(saved!==undefined){requireValue(saved.inputFingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return {changed:false,result:structuredClone(saved.result)};}
        const binding=currentBinding(document,null,input),at=serverClock();
        // A new click key cannot duplicate an unresolved/completed preparation for the same account route.
        const preparations=map(document,'ozonAccountPreparations');
        requireValue(!Object.values(preparations).some(value=>value.createdByUserId===actor.userId&&isDeepStrictEqual(assertOzonAccountPreparation(value).binding,binding)),'PREPARATION_ALREADY_EXISTS');
        const preparation=assertOzonAccountPreparation({schemaVersion:'ozon-account-preparation-v1',preparationId:`account-preparation:${randomUUID()}`,revision:0,
          createdByUserId:actor.userId,createdAt:at,updatedAt:at,binding,warehouseSelections:[]});
        preparations[preparation.preparationId]=preparation;const result={preparation:structuredClone(preparation),externalRequests:0,platformWrites:0};
        idempotency[input.idempotencyKey]={inputFingerprint:fingerprint,result};return {changed:true,document,result};
      });
    },
    async authorizeAndRun({actor,input}){
      const authorized=await runtime.authorizeAndEnqueue({actor,input});
      return runtime.continueSaved({preparationId:input.preparationId,jobId:authorized.job.jobId,expectedRevision:input.expectedRevision});
    },
    async continueSavedRead({actor,input}){
      owner(actor);const document=await repository.readSnapshot();preparationFor(document,input.preparationId,actor);
      return runtime.continueSaved(input);
    },
    async selectWarehouse({actor,input}){
      owner(actor);requireValue(closed(input,['preparationId','expectedRevision','sourceJobId','sourceReceiptId','warehouseId','idempotencyKey'])&&
        ['preparationId','sourceJobId','sourceReceiptId','idempotencyKey'].every(field=>isCanonicalFrozenRef(input[field]))&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.warehouseId==='string'&&/^[1-9][0-9]*$/.test(input.warehouseId)&&Number.isSafeInteger(Number(input.warehouseId)),'INPUT_INVALID');
      const fingerprint=fingerprintCanonicalRecord({action:'select_account_warehouse',input,ownerUserId:actor.userId});
      return repository.transact(document=>{
        const idempotency=map(document,'ozonAccountPreparationIdempotency'),saved=idempotency[input.idempotencyKey];
        if(saved!==undefined){requireValue(saved.inputFingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return {changed:false,result:structuredClone(saved.result)};}
        const preparation=preparationFor(document,input.preparationId,actor);requireValue(preparation.revision===input.expectedRevision,'PREPARATION_CHANGED');
        const source=sourceForSelection(document,preparation,input.sourceJobId);requireValue(source.receipt.receiptId===input.sourceReceiptId,'SOURCE_RECEIPT_CONFLICT');
        const rows=source.warehouses.filter(value=>value.warehouseId===input.warehouseId);requireValue(rows.length===1,'WAREHOUSE_NOT_OBSERVED');
        const at=serverClock(),next={...preparation,revision:preparation.revision+1,updatedAt:at,warehouseSelections:[...preparation.warehouseSelections,
          {selectionId:`account-warehouse-selection:${randomUUID()}`,revision:preparation.revision+1,selectedAt:at,selectedByUserId:actor.userId,
            sourceJobId:source.job.jobId,sourceReceiptId:source.receipt.receiptId,sourceRevision:source.job.revision,warehouse:structuredClone(rows[0])}]};
        map(document,'ozonAccountPreparations')[preparation.preparationId]=assertOzonAccountPreparation(next);
        const result={preparation:structuredClone(next),externalRequests:0,platformWrites:0};idempotency[input.idempotencyKey]={inputFingerprint:fingerprint,result};return {changed:true,document,result};
      });
    }
  });
}
