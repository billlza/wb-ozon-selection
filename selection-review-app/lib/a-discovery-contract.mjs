import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord, sameTeamUser } from './runtime-identity.mjs';
import { LINKFOX_DISCOVERY_CONTRACT_VERSION, LINKFOX_DISCOVERY_COSTS, buildLinkfoxDiscoveryRequest, assertLinkfoxDiscoveryResult } from './linkfox-discovery-api.mjs';
import { SEERFAR_DISCOVERY_CONTRACT_VERSION, SEERFAR_DISCOVERY_CAPABILITY, SEERFAR_DISCOVERY_STEPS, SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES, SeerfarDiscoveryContractError,
  assertSeerfarDiscoveryRequest, assertSeerfarDiscoveryBudget, assertSeerfarDiscoveryMarketResult, assertSeerfarDiscoveryQuotaResult } from './seerfar-discovery-contract.mjs';
export const A_DISCOVERY_JOB_TYPE = 'a_product_discovery';
export const A_DISCOVERY_CAPABILITY = 'linkfox-discovery-api';
export class ADiscoveryError extends Error {
  constructor(code) { super(`A_DISCOVERY_${code}`); this.name='ADiscoveryError'; this.code=code; }
}
const closed=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const check=(v,code)=>{if(!v)throw new ADiscoveryError(code);};
const ref=v=>isCanonicalFrozenRef(v)&&!['unknown','null','undefined'].includes(v);
const time=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=256;
const safeClone=v=>{assertSafeRuntimeRecord(v);return structuredClone(v);};
export const A_DISCOVERY_FAILURE_CLASSES=Object.freeze(['INPUT_INVALID','RESPONSE_INVALID','RESPONSE_LIMIT','IDENTITY_INVALID','AUTHENTICATION_REQUIRED',
  'BILLING_FAILED','RATE_LIMITED','PROVIDER_FAILED','BINDING_INVALID','CREDENTIAL_MISSING','CREDENTIAL_UNAVAILABLE','CREDENTIAL_READ_FAILED','NETWORK_FAILED','TIMEOUT','ALREADY_ATTEMPTED',
  'BATCH_CHANGED','AUTHORIZATION_INVALID','AUTHORIZATION_EXPIRED','CREDENTIAL_BINDING_INVALID','LEASE_EXPIRED','CANCELLED','UNEXPECTED_SYSTEM_ERROR','BUDGET_EXCEEDED','QUOTA_INVALID',...SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES]);
export function getADiscoveryRequestCredits(request,budget) {
  if(request?.method==='category_detail'){seerfar(()=>assertSeerfarDiscoveryRequest(request));seerfar(()=>assertSeerfarDiscoveryBudget(budget));return SEERFAR_DISCOVERY_STEPS.reduce((sum,step)=>sum+budget.estimatedPointsByStep[step],0);}
  buildLinkfoxDiscoveryRequest(request);return LINKFOX_DISCOVERY_COSTS[request.method];
}
export function assertADiscoveryPlan(plan) {
  if(plan?.schemaVersion==='a-discovery-plan-v2')return assertSeerfarPlan(plan);
  check(closed(plan,['schemaVersion','planId','version','provider','contractVersion','direction','requests','budget','exclusions','selection'])&&
    plan.schemaVersion==='a-discovery-plan-v1'&&ref(plan.planId)&&ref(plan.version)&&plan.provider==='linkfox'&&
    plan.contractVersion===LINKFOX_DISCOVERY_CONTRACT_VERSION&&text(plan.direction),'PLAN_INVALID');
  check(Array.isArray(plan.requests)&&plan.requests.length>=1&&plan.requests.length<=3,'PLAN_INVALID');
  plan.requests.forEach((request,index)=>{buildLinkfoxDiscoveryRequest(request);check(request.method===(index===0?'ozon_market_search':'supplier_search'),'PLAN_SEQUENCE_INVALID');});
  check(new Set(plan.requests.map(v=>v.requestId)).size===plan.requests.length,'PLAN_INVALID');
  check(closed(plan.budget,['unit','maxRequests','maxCredits'])&&plan.budget.unit==='linkfox_credits'&&
    plan.budget.maxRequests===plan.requests.length&&Number.isSafeInteger(plan.budget.maxCredits)&&
    plan.budget.maxCredits>=plan.requests.reduce((n,v)=>n+getADiscoveryRequestCredits(v),0),'BUDGET_INVALID');
  check(Array.isArray(plan.exclusions)&&plan.exclusions.length>=1&&plan.exclusions.length<=20&&plan.exclusions.every(text)&&new Set(plan.exclusions).size===plan.exclusions.length,'PLAN_INVALID');
  check(closed(plan.selection,['schemaVersion','marketOrder','supplierOrder','maxCandidates'])&&plan.selection.schemaVersion==='a-discovery-selection-v1'&&plan.selection.marketOrder==='provider_order'&&plan.selection.supplierOrder==='provider_order'&&plan.selection.maxCandidates===1,'SELECTION_INVALID');
  return safeClone(plan);
}
export function assertADiscoveryBatch(batch) {
  check(closed(batch,['schemaVersion','batchId','revision','ownerUserId','createdAt','plan','targetStore','bindingId','configurationVersion','credentialAlias','budgetPolicyRef'])&&['a-discovery-batch-v1','a-discovery-batch-v2'].includes(batch.schemaVersion)&&
    ref(batch.batchId)&&integer(batch.revision)&&ref(batch.ownerUserId)&&time(batch.createdAt)&&['miska','dandanshu'].includes(batch.targetStore)&&['bindingId','configurationVersion','credentialAlias','budgetPolicyRef'].every(k=>ref(batch[k])),'BATCH_INVALID');
  assertADiscoveryPlan(batch.plan);
  check(batch.schemaVersion===(batch.plan.provider==='seerfar'?'a-discovery-batch-v2':'a-discovery-batch-v1'),'BATCH_INVALID');
  if(batch.plan.provider==='seerfar')check(batch.budgetPolicyRef===batch.plan.budget.policyRef,'BUDGET_INVALID');
  return safeClone(batch);
}
export function assertADiscoveryScope(scope,job) {
  if(isSeerfarADiscoveryScope(scope))return assertSeerfarScope(scope,job);
  check(closed(scope,['schemaVersion','batchId','sourceRevision','resultRevision','planId','planVersion','requestIndex','request','bindingId','configurationVersion',
    'credentialAlias','budgetPolicyRef','authorizationRef','expiresAt','targetStore'])&&scope.schemaVersion==='a-discovery-scope-v1'&&
    ['batchId','planId','planVersion','bindingId','configurationVersion','credentialAlias','budgetPolicyRef','authorizationRef'].every(k=>ref(scope[k]))&&
    ['miska','dandanshu'].includes(scope.targetStore)&&integer(scope.sourceRevision)&&scope.resultRevision===scope.sourceRevision&&integer(scope.requestIndex)&&scope.requestIndex<3&&time(scope.expiresAt),'SCOPE_INVALID');
  buildLinkfoxDiscoveryRequest(scope.request);
  check(scope.request.method===(scope.requestIndex===0?'ozon_market_search':'supplier_search'),'SCOPE_INVALID');
  if(job)check(job.schemaVersion==='software-job-v3'&&job.jobType===A_DISCOVERY_JOB_TYPE&&
    closed(job.subject,['kind','batchId','revision'])&&job.subject.kind==='discovery_batch'&&job.subject.batchId===scope.batchId&&
    job.subject.revision===scope.resultRevision&&job.revision===scope.resultRevision&&!Object.hasOwn(job,'candidateId')&&!Object.hasOwn(job,'skuPackageId')&&
    isDeepStrictEqual(job.scopeBinding,scope),'JOB_SOURCE_CONFLICT');
  return safeClone(scope);
}
export function assertADiscoveryBatchSource(batch,scope) {
  assertADiscoveryBatch(batch);assertADiscoveryScope(scope);
  check(['targetStore','bindingId','configurationVersion','credentialAlias','budgetPolicyRef'].every(k=>batch[k]===scope[k])&&batch.batchId===scope.batchId&&batch.revision===scope.sourceRevision&&batch.plan.planId===scope.planId&&batch.plan.version===scope.planVersion&&
    isDeepStrictEqual(batch.plan.requests[scope.requestIndex],scope.request)&&
    (batch.plan.provider==='seerfar'?isSeerfarADiscoveryScope(scope)&&isDeepStrictEqual(batch.plan.budget,scope.budget):!isSeerfarADiscoveryScope(scope)),'BATCH_CHANGED');return batch;
}
export function assertADiscoveryAuthorization(record) {
  check(closed(record,['schemaVersion','authorizationId','authorizationType','status','action','scopeBinding','authorizedByUserId','authorizedAt','expiresAt','maxUses','useCount','consumedByJobId','consumedAt'])&&
    record.schemaVersion==='software-job-authorization-record-v3'&&record.authorizationType===(isSeerfarADiscoveryScope(record.scopeBinding)?'a_seerfar_discovery_once':'a_discovery_once')&&record.status==='active'&&record.action===A_DISCOVERY_JOB_TYPE&&
    ref(record.authorizationId)&&ref(record.authorizedByUserId)&&time(record.authorizedAt)&&time(record.expiresAt)&&Date.parse(record.authorizedAt)<Date.parse(record.expiresAt)&&
    record.maxUses===1&&[0,1].includes(record.useCount),'AUTHORIZATION_INVALID');
  const scope=assertADiscoveryScope(record.scopeBinding);
  check(record.authorizationId===scope.authorizationRef&&record.expiresAt===scope.expiresAt&&
    (record.useCount===0?record.consumedByJobId===null&&record.consumedAt===null:ref(record.consumedByJobId)&&time(record.consumedAt)&&
      Date.parse(record.consumedAt)>=Date.parse(record.authorizedAt)&&Date.parse(record.consumedAt)<Date.parse(record.expiresAt)),'AUTHORIZATION_INVALID');
  return safeClone(record);
}
export function assertADiscoveryCredential(record) {
  check(closed(record,['schemaVersion','bindingId','credentialAlias','status','provider','sideEffectScope','scopeBinding','allowedWorkerIds','redaction','boundAt','expiresAt'])&&
    record.schemaVersion==='software-job-credential-binding-v3'&&record.status==='active'&&record.provider===(isSeerfarADiscoveryScope(record.scopeBinding)?'seerfar':'linkfox')&&record.sideEffectScope===A_DISCOVERY_JOB_TYPE&&
    ref(record.bindingId)&&record.redaction==='credential_alias_only'&&time(record.boundAt)&&time(record.expiresAt)&&Date.parse(record.boundAt)<Date.parse(record.expiresAt)&&
    Array.isArray(record.allowedWorkerIds)&&record.allowedWorkerIds.length===1&&record.allowedWorkerIds.every(ref),'CREDENTIAL_BINDING_INVALID');
  const scope=assertADiscoveryScope(record.scopeBinding);
  check(record.credentialAlias===scope.credentialAlias&&record.expiresAt===scope.expiresAt,'CREDENTIAL_BINDING_INVALID');return safeClone(record);
}
export function assertADiscoveryReceipt(receipt,job) {
  if(receipt?.schemaVersion==='a-discovery-receipt-v2')return assertSeerfarReceipt(receipt,job);
  check(closed(receipt,['schemaVersion','receiptId','jobId','scope','workerId','leaseId','startedAt','completedAt','status','failureClass','steps',...(Object.hasOwn(receipt??{},'lateResult')?['lateResult']:[])])&&
    receipt.schemaVersion==='a-discovery-receipt-v1'&&['receiptId','jobId','workerId','leaseId'].every(k=>ref(receipt[k]))&&time(receipt.startedAt)&&
    ['in_flight','completed','failed','unknown_outcome'].includes(receipt.status)&&Array.isArray(receipt.steps)&&receipt.steps.length<=1,'RECEIPT_INVALID');
  assertADiscoveryScope(receipt.scope,job);check(!isSeerfarADiscoveryScope(receipt.scope),'RECEIPT_SOURCE_CONFLICT');
  check(receipt.receiptId===`a-discovery-receipt:${receipt.jobId}`,'RECEIPT_SOURCE_CONFLICT');
  if(job)check(receipt.jobId===job.jobId&&receipt.workerId===job.workerId&&receipt.leaseId===job.leaseId,'RECEIPT_SOURCE_CONFLICT');
  const step=receipt.steps[0];
  if(step){
    check(closed(step,['method','intentAt','sentAt','completedAt','externalRequestState','requestTransmission','result','errorCode'])&&
      step.method===receipt.scope.request.method&&time(step.intentAt)&&Date.parse(step.intentAt)>=Date.parse(receipt.startedAt)&&
      ['not_sent','in_flight','succeeded','failed','unknown_outcome'].includes(step.externalRequestState)&&
      ['not_attempted','attempted','response_received','unknown'].includes(step.requestTransmission),'STEP_INVALID');
    check(step.sentAt===null?step.externalRequestState==='not_sent'&&step.requestTransmission==='not_attempted':
      time(step.sentAt)&&Date.parse(step.sentAt)>=Date.parse(step.intentAt)&&Date.parse(step.sentAt)<Date.parse(receipt.scope.expiresAt)&&
      (!job||Date.parse(step.sentAt)<Date.parse(job.leaseExpiresAt))&&step.externalRequestState!=='not_sent'&&step.requestTransmission!=='not_attempted','STEP_TRANSMISSION_INVALID');
    check(step.completedAt===null||time(step.completedAt)&&Date.parse(step.completedAt)>=Date.parse(step.sentAt??step.intentAt),'STEP_TIME_INVALID');
    check(step.errorCode===null||A_DISCOVERY_FAILURE_CLASSES.includes(step.errorCode),'STEP_INVALID');
    if(step.result!==null){assertLinkfoxDiscoveryResult(step.result,receipt.scope.request);check(step.externalRequestState==='succeeded'&&step.requestTransmission==='response_received'&&
      step.errorCode===null&&step.completedAt!==null&&Date.parse(step.result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(step.result.observedAt)<=Date.parse(step.completedAt),'STEP_RESULT_INVALID');}
  }
  if(receipt.status==='in_flight')check(receipt.completedAt===null&&receipt.failureClass===null,'RECEIPT_INVALID');
  else {
    check(time(receipt.completedAt)&&Date.parse(receipt.completedAt)>=Date.parse(receipt.startedAt)&&(!step||step.completedAt!==null&&Date.parse(receipt.completedAt)>=Date.parse(step.completedAt)),'RECEIPT_TIME_INVALID');
    if(receipt.status==='completed')check(step?.result!==null&&step?.result!==undefined&&receipt.failureClass===null,'RECEIPT_RESULT_INVALID');
    else check(A_DISCOVERY_FAILURE_CLASSES.includes(receipt.failureClass)&&(!step||step.result===null&&step.errorCode===receipt.failureClass),'RECEIPT_FAILURE_INVALID');
    check(receipt.status==='unknown_outcome'?step?.externalRequestState==='unknown_outcome':!step||!['in_flight','unknown_outcome'].includes(step.externalRequestState),'RECEIPT_OUTCOME_CONFLICT');
  }
  if(Object.hasOwn(receipt,'lateResult')){
    const late=receipt.lateResult;
    check(receipt.status==='unknown_outcome'&&step?.sentAt!==null&&step?.sentAt!==undefined&&
      closed(late,['recordedAt','result'])&&time(late.recordedAt)&&Date.parse(late.recordedAt)>=Date.parse(receipt.completedAt),'LATE_RESULT_INVALID');
    assertLinkfoxDiscoveryResult(late.result,receipt.scope.request);
    check(Date.parse(late.result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(late.result.observedAt)<=Date.parse(late.recordedAt),'LATE_RESULT_INVALID');
  }
  return safeClone(receipt);
}
export function readADiscoveryTerminal(receipt,job) {
  assertADiscoveryReceipt(receipt,job);check(receipt.status!=='in_flight','RECEIPT_NOT_TERMINAL');
  const step=isSeerfarADiscoveryScope(receipt.scope)?receipt.steps.at(-1):receipt.steps[0];
  const externalRequestState=receipt.status==='completed'?'succeeded':isSeerfarADiscoveryScope(receipt.scope)&&receipt.status==='failed'&&
    receipt.steps.some(value=>value.sentAt!==null)?'failed':step?.externalRequestState??'not_sent';
  return {status:receipt.status,externalRequestState,failureClass:receipt.failureClass};
}
export function interruptADiscoveryReceipt(receipt,job,completedAt,failureClass) {
  const next=assertADiscoveryReceipt(receipt,job);check(next.status==='in_flight'&&time(completedAt)&&A_DISCOVERY_FAILURE_CLASSES.includes(failureClass),'RECEIPT_INTERRUPTION_INVALID');
  if(isSeerfarADiscoveryScope(next.scope))return interruptSeerfarReceipt(next,job,completedAt,failureClass);
  const step=next.steps[0];if(step){step.completedAt=completedAt;step.errorCode=failureClass;if(step.externalRequestState==='in_flight')step.externalRequestState='unknown_outcome';}
  next.completedAt=completedAt;next.failureClass=failureClass;next.status=step?.externalRequestState==='unknown_outcome'?'unknown_outcome':'failed';
  return assertADiscoveryReceipt(next,job);
}
/** A query result is discovery material only. Empty/failure/unknown stops the bounded sequence. */
export function nextADiscoveryRequest({batch,receipts}) {
  assertADiscoveryBatch(batch);check(Array.isArray(receipts)&&receipts.length<=batch.plan.requests.length,'SEQUENCE_INVALID');
  const ordered=[...receipts].sort((a,b)=>a.scope.requestIndex-b.scope.requestIndex);
  for(const [index,receipt] of ordered.entries()){
    assertADiscoveryReceipt(receipt);assertADiscoveryBatchSource(batch,receipt.scope);check(receipt.scope.requestIndex===index,'SEQUENCE_INVALID');
    if(receipt.status!=='completed'||readADiscoveryMarketResult(receipt).status!=='candidates_found'){check(index===ordered.length-1,'SEQUENCE_INVALID');return null;}
  }
  return ordered.length===batch.plan.requests.length?null:structuredClone(batch.plan.requests[ordered.length]);
}
export function assertADiscoveryAdmission({batch,scope,authorization,receipts,checkedAt}) {
  assertADiscoveryBatchSource(batch,scope);assertADiscoveryAuthorization(authorization);
  check(time(checkedAt)&&Date.parse(checkedAt)>=Date.parse(authorization.authorizedAt)&&Date.parse(checkedAt)<Date.parse(scope.expiresAt),'AUTHORIZATION_EXPIRED');
  check(sameTeamUser(authorization.authorizedByUserId,batch.ownerUserId)&&isDeepStrictEqual(authorization.scopeBinding,scope),'AUTHORIZATION_INVALID');
  check(isDeepStrictEqual(nextADiscoveryRequest({batch,receipts}),scope.request),'SEQUENCE_INVALID');return true;
}

function seerfar(operation) {
  try { return operation(); }
  catch(error) { if(error instanceof SeerfarDiscoveryContractError)throw new ADiscoveryError(error.code);throw error; }
}
export function isSeerfarADiscoveryScope(scope) { return scope?.schemaVersion==='a-discovery-scope-v2'; }
export function getADiscoveryProviderCapability(provider,contractVersion) {
  if(provider==='seerfar'&&contractVersion===SEERFAR_DISCOVERY_CONTRACT_VERSION)return SEERFAR_DISCOVERY_CAPABILITY;
  check(provider==='linkfox'&&contractVersion===LINKFOX_DISCOVERY_CONTRACT_VERSION,'BINDING_INVALID');return A_DISCOVERY_CAPABILITY;
}
export function getADiscoveryCapability(value) {
  if(value?.schemaVersion==='a-discovery-plan-v2'){assertADiscoveryPlan(value);return SEERFAR_DISCOVERY_CAPABILITY;}
  if(isSeerfarADiscoveryScope(value)){assertADiscoveryScope(value);return SEERFAR_DISCOVERY_CAPABILITY;}
  if(value?.schemaVersion==='a-discovery-plan-v1')assertADiscoveryPlan(value);else assertADiscoveryScope(value);
  return A_DISCOVERY_CAPABILITY;
}
export function getADiscoveryHttpRequestLimit(scope) { assertADiscoveryScope(scope);return isSeerfarADiscoveryScope(scope)?3:1; }
export function readADiscoveryMarketResult(receipt) {
  assertADiscoveryReceipt(receipt);check(receipt.status==='completed','RECEIPT_NOT_TERMINAL');
  return safeClone(receipt.steps[isSeerfarADiscoveryScope(receipt.scope)?1:0].result);
}

function assertSeerfarPlan(plan) {
  check(closed(plan,['schemaVersion','planId','version','provider','contractVersion','direction','requests','budget','exclusions','selection'])&&
    plan.schemaVersion==='a-discovery-plan-v2'&&ref(plan.planId)&&ref(plan.version)&&plan.provider==='seerfar'&&
    plan.contractVersion===SEERFAR_DISCOVERY_CONTRACT_VERSION&&text(plan.direction),'PLAN_INVALID');
  check(Array.isArray(plan.requests)&&plan.requests.length===1,'PLAN_INVALID');
  seerfar(()=>assertSeerfarDiscoveryRequest(plan.requests[0]));seerfar(()=>assertSeerfarDiscoveryBudget(plan.budget));
  check(Array.isArray(plan.exclusions)&&plan.exclusions.length>=1&&plan.exclusions.length<=20&&plan.exclusions.every(text)&&
    new Set(plan.exclusions).size===plan.exclusions.length,'PLAN_INVALID');
  check(closed(plan.selection,['schemaVersion','marketOrder','supplierOrder','maxCandidates'])&&
    plan.selection.schemaVersion==='a-discovery-selection-v2'&&plan.selection.marketOrder==='provider_order'&&
    plan.selection.supplierOrder==='not_requested'&&plan.selection.maxCandidates===1,'SELECTION_INVALID');
  return safeClone(plan);
}

function assertSeerfarScope(scope,job) {
  check(closed(scope,['schemaVersion','batchId','sourceRevision','resultRevision','planId','planVersion','requestIndex','request',
    'bindingId','configurationVersion','credentialAlias','budgetPolicyRef','authorizationRef','expiresAt','targetStore',
    'provider','contractVersion','budget'])&&scope.schemaVersion==='a-discovery-scope-v2'&&scope.provider==='seerfar'&&
    scope.contractVersion===SEERFAR_DISCOVERY_CONTRACT_VERSION&&
    ['batchId','planId','planVersion','bindingId','configurationVersion','credentialAlias','budgetPolicyRef','authorizationRef'].every(key=>ref(scope[key]))&&
    ['miska','dandanshu'].includes(scope.targetStore)&&integer(scope.sourceRevision)&&scope.resultRevision===scope.sourceRevision&&
    scope.requestIndex===0&&time(scope.expiresAt),'SCOPE_INVALID');
  seerfar(()=>assertSeerfarDiscoveryRequest(scope.request));seerfar(()=>assertSeerfarDiscoveryBudget(scope.budget));
  check(scope.budget.policyRef===scope.budgetPolicyRef,'BUDGET_INVALID');
  if(job)check(job.schemaVersion==='software-job-v3'&&job.jobType===A_DISCOVERY_JOB_TYPE&&
    closed(job.subject,['kind','batchId','revision'])&&job.subject.kind==='discovery_batch'&&job.subject.batchId===scope.batchId&&
    job.subject.revision===scope.resultRevision&&job.revision===scope.resultRevision&&!Object.hasOwn(job,'candidateId')&&!Object.hasOwn(job,'skuPackageId')&&
    isDeepStrictEqual(job.scopeBinding,scope),'JOB_SOURCE_CONFLICT');
  return safeClone(scope);
}

function assertSeerfarStepResult(result,index,request) {
  return seerfar(()=>index===1?assertSeerfarDiscoveryMarketResult(result,request):assertSeerfarDiscoveryQuotaResult(result));
}

function assertSeerfarReceipt(receipt,job) {
  check(closed(receipt,['schemaVersion','receiptId','jobId','scope','workerId','leaseId','startedAt','completedAt','status','failureClass','steps',
    ...(Object.hasOwn(receipt??{},'lateResult')?['lateResult']:[])])&&receipt.schemaVersion==='a-discovery-receipt-v2'&&
    ['receiptId','jobId','workerId','leaseId'].every(key=>ref(receipt[key]))&&time(receipt.startedAt)&&
    ['in_flight','completed','failed','unknown_outcome'].includes(receipt.status)&&Array.isArray(receipt.steps)&&receipt.steps.length<=3,'RECEIPT_INVALID');
  assertSeerfarScope(receipt.scope,job);
  check(receipt.receiptId===`a-discovery-receipt:${receipt.jobId}`,'RECEIPT_SOURCE_CONFLICT');
  if(job)check(receipt.jobId===job.jobId&&receipt.workerId===job.workerId&&receipt.leaseId===job.leaseId,'RECEIPT_SOURCE_CONFLICT');
  for(const [index,step] of receipt.steps.entries()) {
    check(closed(step,['method','intentAt','sentAt','completedAt','externalRequestState','requestTransmission','result','errorCode'])&&
      step.method===SEERFAR_DISCOVERY_STEPS[index]&&time(step.intentAt)&&Date.parse(step.intentAt)>=Date.parse(receipt.startedAt)&&
      ['not_sent','in_flight','succeeded','failed','unknown_outcome'].includes(step.externalRequestState)&&
      ['not_attempted','attempted','response_received','unknown'].includes(step.requestTransmission),'STEP_INVALID');
    if(index>0)check(receipt.steps[index-1].externalRequestState==='succeeded'&&receipt.steps[index-1].result!==null&&
      Date.parse(step.intentAt)>=Date.parse(receipt.steps[index-1].completedAt),'STEP_SEQUENCE_INVALID');
    check(step.sentAt===null?step.externalRequestState==='not_sent'&&step.requestTransmission==='not_attempted':
      time(step.sentAt)&&Date.parse(step.sentAt)>=Date.parse(step.intentAt)&&Date.parse(step.sentAt)<Date.parse(receipt.scope.expiresAt)&&
      (!job||Date.parse(step.sentAt)<Date.parse(job.leaseExpiresAt))&&step.externalRequestState!=='not_sent'&&step.requestTransmission!=='not_attempted','STEP_TRANSMISSION_INVALID');
    check(step.completedAt===null||time(step.completedAt)&&Date.parse(step.completedAt)>=Date.parse(step.sentAt??step.intentAt),'STEP_TIME_INVALID');
    check(step.errorCode===null||A_DISCOVERY_FAILURE_CLASSES.includes(step.errorCode),'STEP_INVALID');
    if(step.result!==null) {
      assertSeerfarStepResult(step.result,index,receipt.scope.request);
      check(step.externalRequestState==='succeeded'&&step.requestTransmission==='response_received'&&step.errorCode===null&&
        step.completedAt!==null&&Date.parse(step.result.observedAt)>=Date.parse(step.sentAt)&&
        Date.parse(step.result.observedAt)<=Date.parse(step.completedAt),'STEP_RESULT_INVALID');
    } else check(step.externalRequestState!=='succeeded','STEP_RESULT_INVALID');
    if(['failed','unknown_outcome'].includes(step.externalRequestState))check(step.completedAt!==null&&step.errorCode!==null,'STEP_INVALID');
    if(step.externalRequestState==='in_flight')check(step.completedAt===null&&step.errorCode===null,'STEP_INVALID');
  }
  const last=receipt.steps.at(-1);
  if(receipt.status==='in_flight')check(receipt.completedAt===null&&receipt.failureClass===null&&
    (!last||!['failed','unknown_outcome'].includes(last.externalRequestState)&&last.errorCode===null),'RECEIPT_INVALID');
  else {
    check(time(receipt.completedAt)&&Date.parse(receipt.completedAt)>=Date.parse(receipt.startedAt)&&
      receipt.steps.every(step=>step.completedAt!==null&&Date.parse(receipt.completedAt)>=Date.parse(step.completedAt)),'RECEIPT_TIME_INVALID');
    if(receipt.status==='completed') {
      check(receipt.steps.length===3&&receipt.failureClass===null&&receipt.steps.every(step=>step.externalRequestState==='succeeded'&&step.result!==null),'RECEIPT_RESULT_INVALID');
      const before=receipt.steps[0].result.remainingPoints,after=receipt.steps[2].result.remainingPoints;
      check(before>=after&&before-after<=receipt.scope.budget.maxCredits,'BUDGET_EXCEEDED');
    } else check(A_DISCOVERY_FAILURE_CLASSES.includes(receipt.failureClass)&&
      (!last||last.result===null&&last.errorCode===receipt.failureClass||
        receipt.status==='failed'&&last.externalRequestState==='succeeded'&&
        (['BUDGET_EXCEEDED','QUOTA_INVALID'].includes(receipt.failureClass)||receipt.steps.length===3&&
          ['CANCELLED','LEASE_EXPIRED','AUTHORIZATION_EXPIRED',...SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES].includes(receipt.failureClass))),'RECEIPT_FAILURE_INVALID');
    check(receipt.status==='unknown_outcome'?last?.externalRequestState==='unknown_outcome':
      receipt.steps.every(step=>!['in_flight','unknown_outcome'].includes(step.externalRequestState)),'RECEIPT_OUTCOME_CONFLICT');
  }
  if(Object.hasOwn(receipt,'lateResult')) {
    const late=receipt.lateResult;
    check(receipt.status==='unknown_outcome'&&closed(late,['recordedAt','stepIndex','result'])&&
      late.stepIndex===receipt.steps.length-1&&last?.sentAt!==null&&time(late.recordedAt)&&
      Date.parse(late.recordedAt)>=Date.parse(receipt.completedAt),'LATE_RESULT_INVALID');
    assertSeerfarStepResult(late.result,late.stepIndex,receipt.scope.request);
    check(Date.parse(late.result.observedAt)>=Date.parse(last.sentAt)&&Date.parse(late.result.observedAt)<=Date.parse(late.recordedAt),'LATE_RESULT_INVALID');
  }
  return safeClone(receipt);
}

function interruptSeerfarReceipt(receipt,job,completedAt,failureClass) {
  let step=receipt.steps.at(-1);
  if(step?.externalRequestState==='succeeded') {
    if(receipt.steps.length===3) {
      check(['CANCELLED','LEASE_EXPIRED','AUTHORIZATION_EXPIRED',...SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES].includes(failureClass),'RECEIPT_INTERRUPTION_INVALID');
      receipt.completedAt=completedAt;receipt.failureClass=failureClass;receipt.status='failed';
      return assertSeerfarReceipt(receipt,job);
    }
    step={method:SEERFAR_DISCOVERY_STEPS[receipt.steps.length],intentAt:completedAt,sentAt:null,completedAt:null,
      externalRequestState:'not_sent',requestTransmission:'not_attempted',result:null,errorCode:null};
    receipt.steps.push(step);
  }
  if(step){step.completedAt=completedAt;step.errorCode=failureClass;if(step.externalRequestState==='in_flight')step.externalRequestState='unknown_outcome';}
  receipt.completedAt=completedAt;receipt.failureClass=failureClass;
  receipt.status=step?.externalRequestState==='unknown_outcome'?'unknown_outcome':'failed';
  return assertSeerfarReceipt(receipt,job);
}
