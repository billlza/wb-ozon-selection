import { isDeepStrictEqual } from 'node:util';
import { isCompleteStoreRef, sameStoreRef, STORE_PLATFORMS } from './store-binding.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef, assertNoProductionSecrets, assertNoRawPersistenceKeys } from './production-contract-primitives.mjs';
import { sameTeamUser } from './runtime-identity.mjs';

export const OZON_ACCOUNT_READ_JOB_TYPE='ozon_account_read';
export const OZON_ACCOUNT_READ_CAPABILITY='ozon-account-read';
export const OZON_ACCOUNT_READ_METHODS=Object.freeze(['roles','seller_info','warehouse_list']);
export class OzonAccountReadError extends Error {
  constructor(code){super(`OZON_ACCOUNT_READ_${code}`);this.name='OzonAccountReadError';this.code=this.message;}
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const ref=value=>isCanonicalFrozenRef(value)&&!['unknown','null','undefined'].includes(value);
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const closed=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const requireValue=(value,code)=>{if(!value)throw new OzonAccountReadError(code);};
const nullableText=value=>value===null||typeof value==='string'&&value.length<=512&&!/[\u0000-\u001f]/u.test(value);
function safe(value){assertNoRawPersistenceKeys(value,'accountRead');assertNoProductionSecrets(value,'accountRead');}
function assertFacts(method,facts,discovery=false){
  if(method==='roles')requireValue(closed(facts,['expiresAt','roles'])&&(facts.expiresAt===null||facts.expiresAt===''||time(facts.expiresAt))&&
    (facts.roles===null||Array.isArray(facts.roles)&&facts.roles.length<=1000&&facts.roles.every(role=>closed(role,['name','methods'])&&nullableText(role.name)&&
      (role.methods===null||Array.isArray(role.methods)&&role.methods.length<=10000&&role.methods.every(value=>typeof value==='string'&&value.length<=512&&!/[\u0000-\u001f]/u.test(value))))),'FACTS_INVALID');
  if(method==='roles'&&facts.roles!==null)requireValue(facts.roles.reduce((sum,role)=>sum+(role.methods?.length??0),0)<=10000,'FACTS_INVALID');
  if(method==='seller_info')requireValue(closed(facts,['companyCurrency'])&&(facts.companyCurrency===null||typeof facts.companyCurrency==='string'&&['RUB','EUR','USD','CNY','BYN','KZT','KGS'].includes(facts.companyCurrency)),'FACTS_INVALID');
  if(method==='warehouse_list')requireValue(closed(facts,['hasNext','warehouses'])&&(facts.hasNext===null||typeof facts.hasNext==='boolean')&&
    (facts.warehouses===null||Array.isArray(facts.warehouses)&&facts.warehouses.length<=(discovery?20:200)&&facts.warehouses.every(value=>
      closed(value,['warehouseId','isRfbs','status','warehouseType','pauseAt','pauseAtPresent',...(discovery?['name']:[])])&&(discovery?nullableText(value.name):true)&&
      (value.warehouseId===null||typeof value.warehouseId==='string'&&/^[1-9][0-9]*$/.test(value.warehouseId))&&
      (value.isRfbs===null||typeof value.isRfbs==='boolean')&&nullableText(value.status)&&nullableText(value.warehouseType)&&(value.pauseAt===null||time(value.pauseAt))&&typeof value.pauseAtPresent==='boolean'&&(value.pauseAtPresent||value.pauseAt===null))),'FACTS_INVALID');
}
const bindingFields=['scopeRef','bindingId','configurationVersion','platform','storeRef','warehouseRef','warehouseId','credentialAlias','clientIdRef','officialContractRefs'];
export function assertOzonAccountReadBinding(binding){
  if(binding?.storeIdentityStatus==='unverified')return assertOzonAccountDiscoveryBinding(binding);
  requireValue(closed(binding,bindingFields)&&binding.platform==='ozon'&&isCompleteStoreRef(binding.storeRef,binding.storeRef?.stableStoreId)&&
    ['scopeRef','bindingId','configurationVersion','warehouseRef','credentialAlias','clientIdRef'].every(field=>ref(binding[field]))&&
    typeof binding.warehouseId==='string'&&/^[1-9][0-9]{0,18}$/.test(binding.warehouseId)&&BigInt(binding.warehouseId)<=9223372036854775807n&&
    closed(binding.officialContractRefs,OZON_ACCOUNT_READ_METHODS)&&Object.values(binding.officialContractRefs).every(ref),'BINDING_INVALID');
  safe(binding);return structuredClone(binding);
}
const scopeFields=['schemaVersion','candidateId','skuPackageId','supplierSkuId','sourceRevision','resultRevision','sideEffectScope','authorizationRef','readMethods','expiresAt','inputFingerprint',...bindingFields];
function scopeFingerprint(scope){return fingerprintCanonicalRecord(Object.fromEntries(Object.entries(scope).filter(([key])=>!['authorizationRef','inputFingerprint'].includes(key))));}
export function createOzonAccountReadScope({candidateId,skuPackageId,supplierSkuId,revision,binding,authorizationRef,expiresAt}){
  const scope={schemaVersion:'software-job-scope-v1',candidateId,skuPackageId,supplierSkuId,sourceRevision:revision,resultRevision:revision,
    sideEffectScope:OZON_ACCOUNT_READ_JOB_TYPE,authorizationRef,readMethods:[...OZON_ACCOUNT_READ_METHODS],expiresAt,...assertOzonAccountReadBinding(binding)};
  return assertOzonAccountReadScope({...scope,inputFingerprint:scopeFingerprint(scope)});
}
export function assertOzonAccountReadScope(scope,job){
  if(scope?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION)return assertOzonAccountDiscoveryScope(scope,job);
  requireValue(closed(scope,scopeFields)&&scope.schemaVersion==='software-job-scope-v1'&&scope.sideEffectScope===OZON_ACCOUNT_READ_JOB_TYPE&&
    ['candidateId','skuPackageId','supplierSkuId','authorizationRef'].every(field=>ref(scope[field]))&&integer(scope.sourceRevision)&&scope.resultRevision===scope.sourceRevision&&
    time(scope.expiresAt)&&isDeepStrictEqual(scope.readMethods,OZON_ACCOUNT_READ_METHODS)&&scope.inputFingerprint===scopeFingerprint(scope),'SCOPE_INVALID');
  assertOzonAccountReadBinding(Object.fromEntries(bindingFields.map(field=>[field,scope[field]])));
  if(job)requireValue(job.jobType===OZON_ACCOUNT_READ_JOB_TYPE&&scope.candidateId===job.candidateId&&scope.skuPackageId===job.skuPackageId&&scope.resultRevision===job.revision,'JOB_SOURCE_CONFLICT');
  safe(scope);return structuredClone(scope);
}
export function assertOzonAccountReadCandidate(candidate,scope){
  if(scope?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION)return assertOzonAccountPreparationSource(candidate,scope);
  assertOzonAccountReadScope(scope);
  const sku=candidate?.lifecycleV11?.skuPackage;
  requireValue(candidate?.id===scope.candidateId&&candidate.dataRevision===scope.sourceRevision&&sku?.skuPackageId===scope.skuPackageId&&
    sku.supplierSkuId===scope.supplierSkuId&&candidate.targetPlatform==='ozon'&&candidate.targetStore===scope.storeRef.stableStoreId&&sameStoreRef(candidate.storeRef,scope.storeRef)&&
    sku.targetPlatform==='ozon'&&sku.targetStore===scope.storeRef.stableStoreId,'CANDIDATE_CHANGED');
  return sku;
}
export function assertOzonAccountReadAuthorization(record){
  requireValue(closed(record,['schemaVersion','authorizationId','authorizationType','status','action','scopeBinding','authorizedByUserId','authorizedAt','expiresAt','maxUses','useCount','consumedByJobId','consumedAt'])&&
    record.schemaVersion===(record.scopeBinding?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION?'software-job-authorization-record-v2':'software-job-authorization-record-v1')&&record.authorizationType===(record.scopeBinding?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION?'account_discovery_once':'account_read_once')&&record.status==='active'&&record.action===OZON_ACCOUNT_READ_JOB_TYPE&&
    ref(record.authorizationId)&&ref(record.authorizedByUserId)&&time(record.authorizedAt)&&time(record.expiresAt)&&Date.parse(record.expiresAt)>Date.parse(record.authorizedAt)&&
    record.maxUses===1&&[0,1].includes(record.useCount),'AUTHORIZATION_INVALID');
  const scope=assertOzonAccountReadScope(record.scopeBinding);
  requireValue(record.authorizationId===scope.authorizationRef&&record.expiresAt===scope.expiresAt&&
    (record.useCount===0?record.consumedByJobId===null&&record.consumedAt===null:ref(record.consumedByJobId)&&time(record.consumedAt)&&Date.parse(record.consumedAt)>=Date.parse(record.authorizedAt)&&Date.parse(record.consumedAt)<Date.parse(record.expiresAt)),'AUTHORIZATION_INVALID');
  safe(record);return structuredClone(record);
}
export function assertOzonAccountReadCredential(record){
  requireValue(closed(record,['schemaVersion','bindingId','credentialAlias','status','provider','sideEffectScope','scopeBinding','allowedWorkerIds','redaction','boundAt','expiresAt'])&&
    record.schemaVersion===(record.scopeBinding?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION?'software-job-credential-binding-v2':'software-job-credential-binding-v1')&&record.status==='active'&&record.provider==='ozon_seller_api'&&record.sideEffectScope===OZON_ACCOUNT_READ_JOB_TYPE&&
    ref(record.bindingId)&&record.redaction==='credential_alias_only'&&time(record.boundAt)&&time(record.expiresAt)&&
    Array.isArray(record.allowedWorkerIds)&&record.allowedWorkerIds.length===1&&record.allowedWorkerIds.every(ref),'CREDENTIAL_BINDING_INVALID');
  const scope=assertOzonAccountReadScope(record.scopeBinding);
  requireValue(record.credentialAlias===scope.credentialAlias&&record.expiresAt===scope.expiresAt,'CREDENTIAL_BINDING_INVALID');
  safe(record);return structuredClone(record);
}
export function assertOzonAccountReadReceipt(receipt,job){
  const discovery=receipt?.scope?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION;
  requireValue(closed(receipt,['schemaVersion','receiptId','jobId','scope','workerId','leaseId','startedAt','completedAt','status','failureClass','steps'])&&
    receipt.schemaVersion===(discovery?'ozon-account-read-receipt-v2':'ozon-account-read-receipt-v1')&&['receiptId','jobId','workerId','leaseId'].every(field=>ref(receipt[field]))&&
    time(receipt.startedAt)&&['in_flight','completed','failed','unknown_outcome'].includes(receipt.status)&&
    Array.isArray(receipt.steps)&&receipt.steps.length<=3,'RECEIPT_INVALID');
  assertOzonAccountReadScope(receipt.scope,job);
  if(job)requireValue(receipt.receiptId===`account-read-receipt:${job.jobId}`&&receipt.jobId===job.jobId&&receipt.workerId===job.workerId&&receipt.leaseId===job.leaseId&&
    isDeepStrictEqual(receipt.scope,job.scopeBinding),'RECEIPT_SOURCE_CONFLICT');
  let previous=receipt.startedAt;
  for(const [index,step] of receipt.steps.entries()){
    requireValue(closed(step,['method','intentAt','sentAt','completedAt','externalRequestState','requestTransmission','result','errorCode'])&&step.method===OZON_ACCOUNT_READ_METHODS[index]&&
      time(step.intentAt)&&Date.parse(step.intentAt)>=Date.parse(previous)&&['not_sent','in_flight','succeeded','failed','unknown_outcome'].includes(step.externalRequestState),'STEP_INVALID');
    requireValue(['not_attempted','attempted','response_received','unknown'].includes(step.requestTransmission),'STEP_TRANSMISSION_INVALID');
    if(index>0)requireValue(receipt.steps[index-1].completedAt!==null&&receipt.steps[index-1].result?.status==='observed'&&receipt.steps[index-1].externalRequestState==='succeeded','STEP_SEQUENCE_INVALID');
    requireValue(step.sentAt===null?step.externalRequestState==='not_sent':time(step.sentAt)&&Date.parse(step.sentAt)>=Date.parse(step.intentAt)&&Date.parse(step.sentAt)<Date.parse(receipt.scope.expiresAt)&&(!job||Date.parse(step.sentAt)<Date.parse(job.leaseExpiresAt)),'STEP_TRANSMISSION_INVALID');
    if(step.completedAt!==null)requireValue(time(step.completedAt)&&Date.parse(step.completedAt)>=Date.parse(step.sentAt===null?step.intentAt:step.sentAt),'STEP_TIME_INVALID');
    requireValue(step.externalRequestState==='not_sent'?step.requestTransmission==='not_attempted':step.sentAt!==null,'STEP_TRANSMISSION_INVALID');
    requireValue(step.errorCode===null||ref(step.errorCode),'STEP_ERROR_INVALID');
    if(step.result!==null){
      const result=step.result;
      requireValue(closed(result,['schemaVersion','method','officialContractRef','observedAt','status','facts','gaps'])&&result.schemaVersion===(discovery?'ozon-account-read-result-v2':'ozon-account-read-result-v1')&&
        result.method===step.method&&result.officialContractRef===receipt.scope.officialContractRefs[step.method]&&time(result.observedAt)&&step.completedAt!==null&&Date.parse(result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(result.observedAt)<=Date.parse(step.completedAt)&&
        ['observed','data_unavailable'].includes(result.status)&&object(result.facts)&&Array.isArray(result.gaps)&&result.gaps.length<=30&&step.externalRequestState==='succeeded'&&step.requestTransmission==='response_received'&&step.errorCode===null,'STEP_RESULT_INVALID');
      assertFacts(step.method,result.facts,discovery);
      if(result.status==='observed'){
        const facts=result.facts;
        if(step.method==='roles')requireValue(time(facts.expiresAt)&&Date.parse(facts.expiresAt)>Date.parse(result.observedAt)&&Array.isArray(facts.roles)&&facts.roles.length>0&&facts.roles.every(role=>Array.isArray(role.methods)),'OBSERVED_FACTS_INVALID');
        if(step.method==='seller_info')requireValue(facts.companyCurrency!==null,'OBSERVED_FACTS_INVALID');
        if(step.method==='warehouse_list'&&discovery)requireValue(typeof facts.hasNext==='boolean'&&Array.isArray(facts.warehouses)&&facts.warehouses.length<=20&&new Set(facts.warehouses.map(row=>row.warehouseId)).size===facts.warehouses.length&&facts.warehouses.every(row=>typeof row.warehouseId==='string'&&/^[1-9][0-9]*$/.test(row.warehouseId)&&Number.isSafeInteger(Number(row.warehouseId))&&typeof row.name==='string'&&row.name.length>0&&typeof row.isRfbs==='boolean'&&typeof row.status==='string'&&row.status.length>0&&typeof row.warehouseType==='string'&&row.warehouseType.length>0),'OBSERVED_FACTS_INVALID');
        if(step.method==='warehouse_list'&&!discovery)requireValue(facts.hasNext===false&&Array.isArray(facts.warehouses)&&facts.warehouses.length===1&&facts.warehouses[0].warehouseId===receipt.scope.warehouseId&&typeof facts.warehouses[0].isRfbs==='boolean'&&typeof facts.warehouses[0].status==='string'&&facts.warehouses[0].status.length>0&&typeof facts.warehouses[0].warehouseType==='string'&&facts.warehouses[0].warehouseType.length>0,'OBSERVED_FACTS_INVALID');
      }
      requireValue(result.gaps.every(gap=>closed(gap,['code','field','message'])&&ref(gap.code)&&typeof gap.field==='string'&&gap.field.length<=256&&typeof gap.message==='string'&&gap.message.length<=2048)&&
        (result.status==='observed'?result.gaps.length===0:result.gaps.length>0),'STEP_RESULT_INVALID');
    }
    previous=step.completedAt===null?step.intentAt:step.completedAt;
  }
  requireValue(receipt.status==='in_flight'?receipt.completedAt===null&&receipt.failureClass===null:
    time(receipt.completedAt)&&Date.parse(receipt.completedAt)>=Date.parse(previous)&&
    (receipt.status==='completed'?receipt.failureClass===null&&receipt.steps.length===3&&receipt.steps.every(step=>step.result?.status==='observed'):ref(receipt.failureClass)),'RECEIPT_TERMINAL_INVALID');
  if(receipt.status!=='in_flight')requireValue(receipt.steps.every(step=>step.completedAt!==null),'RECEIPT_TERMINAL_INVALID');
  safe(receipt);return structuredClone(receipt);
}
export function readOzonAccountReadTerminal(receipt,job){
  assertOzonAccountReadReceipt(receipt,job);requireValue(receipt.status!=='in_flight','RECEIPT_NOT_TERMINAL');
  const sent=receipt.steps.filter(step=>step.requestTransmission!=='not_attempted');
  const externalRequestState=sent.length===0?'not_sent':sent.some(step=>['unknown_outcome','in_flight'].includes(step.externalRequestState))?'unknown_outcome':
    sent.some(step=>step.externalRequestState==='failed')?'failed':'succeeded';
  requireValue(receipt.status==='unknown_outcome'?externalRequestState==='unknown_outcome':externalRequestState!=='unknown_outcome','RECEIPT_OUTCOME_CONFLICT');
  return {status:receipt.status,externalRequestState,failureClass:receipt.failureClass};
}

/** Stop this one-use read locally; only an unfinished send stays an unknown external outcome. */
export function interruptOzonAccountReadReceipt(receipt,job,completedAt,failureClass){
  const next=assertOzonAccountReadReceipt(receipt,job);
  requireValue(next.status==='in_flight'&&time(completedAt)&&ref(failureClass),'RECEIPT_INTERRUPTION_INVALID');
  const step=next.steps.at(-1);
  if(step&&step.completedAt===null){
    step.completedAt=completedAt;step.errorCode=failureClass;
    if(step.externalRequestState==='in_flight')step.externalRequestState='unknown_outcome';
  }
  next.completedAt=completedAt;next.failureClass=failureClass;
  next.status=next.steps.some(value=>value.externalRequestState==='unknown_outcome')?'unknown_outcome':'failed';
  return assertOzonAccountReadReceipt(next,job);
}


export const OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION='ozon-account-discovery-scope-v1';
export const OZON_ACCOUNT_PREPARATION_VERSION='ozon-account-preparation-v1';
const discoveryBindingFields=['scopeRef','bindingId','configurationVersion','platform','targetStore','storeIdentityStatus','credentialAlias','clientIdRef','officialContractRefs'];
export function assertOzonAccountDiscoveryBinding(binding){
  requireValue(closed(binding,discoveryBindingFields)&&binding.platform==='ozon'&&STORE_PLATFORMS[binding.targetStore]==='ozon'&&binding.storeIdentityStatus==='unverified'&&
    ['scopeRef','bindingId','configurationVersion','credentialAlias','clientIdRef'].every(field=>ref(binding[field]))&&
    closed(binding.officialContractRefs,OZON_ACCOUNT_READ_METHODS)&&Object.values(binding.officialContractRefs).every(ref),'DISCOVERY_BINDING_INVALID');
  safe(binding);return structuredClone(binding);
}
export function assertOzonAccountPreparation(value){
  requireValue(closed(value,['schemaVersion','preparationId','revision','createdByUserId','createdAt','updatedAt','binding','warehouseSelections'])&&
    value.schemaVersion===OZON_ACCOUNT_PREPARATION_VERSION&&ref(value.preparationId)&&integer(value.revision)&&ref(value.createdByUserId)&&
    time(value.createdAt)&&time(value.updatedAt)&&Date.parse(value.updatedAt)>=Date.parse(value.createdAt)&&Array.isArray(value.warehouseSelections)&&value.warehouseSelections.length<=100,'PREPARATION_INVALID');
  assertOzonAccountDiscoveryBinding(value.binding);
  let previousAt=value.createdAt;
  for(const [index,selection] of value.warehouseSelections.entries()){
    requireValue(closed(selection,['selectionId','revision','selectedAt','selectedByUserId','sourceJobId','sourceReceiptId','sourceRevision','warehouse'])&&
      ref(selection.selectionId)&&selection.revision===index+1&&time(selection.selectedAt)&&sameTeamUser(selection.selectedByUserId,value.createdByUserId)&&ref(selection.sourceJobId)&&ref(selection.sourceReceiptId)&&integer(selection.sourceRevision)&&selection.sourceRevision<selection.revision&&
      Date.parse(selection.selectedAt)>=Date.parse(previousAt)&&Date.parse(selection.selectedAt)<=Date.parse(value.updatedAt),'WAREHOUSE_SELECTION_INVALID');
    assertFacts('warehouse_list',{hasNext:false,warehouses:[selection.warehouse]},true);
    const row=selection.warehouse;
    requireValue(typeof row.warehouseId==='string'&&Number.isSafeInteger(Number(row.warehouseId))&&typeof row.isRfbs==='boolean'&&
      ['name','status','warehouseType'].every(field=>typeof row[field]==='string'&&row[field].length>0),'WAREHOUSE_SELECTION_INVALID');
    previousAt=selection.selectedAt;
  }
  requireValue(value.revision===value.warehouseSelections.length,'PREPARATION_REVISION_INVALID');
  safe(value);return structuredClone(value);
}
export function createOzonAccountDiscoveryScope({preparation,binding,authorizationRef,expiresAt}){
  assertOzonAccountPreparation(preparation);
  const scope={schemaVersion:OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION,subject:{kind:'account_preparation',preparationId:preparation.preparationId,revision:preparation.revision},
    sourceRevision:preparation.revision,resultRevision:preparation.revision,sideEffectScope:OZON_ACCOUNT_READ_JOB_TYPE,authorizationRef,
    readMethods:[...OZON_ACCOUNT_READ_METHODS],warehouseMode:'discovery',warehouseLimit:20,maxRequests:3,expiresAt,...assertOzonAccountDiscoveryBinding(binding)};
  return assertOzonAccountDiscoveryScope({...scope,inputFingerprint:scopeFingerprint(scope)});
}
export function assertOzonAccountDiscoveryScope(scope,job){
  requireValue(closed(scope,['schemaVersion','subject','sourceRevision','resultRevision','sideEffectScope','authorizationRef','readMethods','warehouseMode','warehouseLimit','maxRequests','expiresAt','inputFingerprint',...discoveryBindingFields])&&
    scope.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION&&closed(scope.subject,['kind','preparationId','revision'])&&scope.subject.kind==='account_preparation'&&ref(scope.subject.preparationId)&&integer(scope.subject.revision)&&
    scope.sourceRevision===scope.subject.revision&&scope.resultRevision===scope.sourceRevision&&scope.sideEffectScope===OZON_ACCOUNT_READ_JOB_TYPE&&ref(scope.authorizationRef)&&
    isDeepStrictEqual(scope.readMethods,OZON_ACCOUNT_READ_METHODS)&&scope.warehouseMode==='discovery'&&scope.warehouseLimit===20&&scope.maxRequests===3&&time(scope.expiresAt)&&scope.inputFingerprint===scopeFingerprint(scope),'DISCOVERY_SCOPE_INVALID');
  assertOzonAccountDiscoveryBinding(Object.fromEntries(discoveryBindingFields.map(field=>[field,scope[field]])));
  if(job)requireValue(job.schemaVersion==='software-job-v2'&&job.jobType===OZON_ACCOUNT_READ_JOB_TYPE&&isDeepStrictEqual(job.subject,scope.subject)&&job.revision===scope.resultRevision&&!Object.hasOwn(job,'candidateId')&&!Object.hasOwn(job,'skuPackageId'),'JOB_SOURCE_CONFLICT');
  safe(scope);return structuredClone(scope);
}
export function assertOzonAccountPreparationSource(preparation,scope){
  assertOzonAccountPreparation(preparation);assertOzonAccountDiscoveryScope(scope);
  requireValue(preparation.preparationId===scope.subject.preparationId&&preparation.revision===scope.sourceRevision&&discoveryBindingFields.every(field=>isDeepStrictEqual(preparation.binding[field],scope[field])),'PREPARATION_CHANGED');
  return preparation;
}

export const assertOzonAccountReadSubject=assertOzonAccountReadCandidate;
