import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord, sameTeamUser } from './runtime-identity.mjs';
import { A_DISCOVERY_FAILURE_CLASSES,ADiscoveryError,assertADiscoveryReceipt,assertADiscoveryBatchSource } from './a-discovery-contract.mjs';
import { LINKFOX_DETAIL_CONTRACT_VERSION,buildLinkfoxProductDetailRequest,assertLinkfoxProductDetailResult } from './linkfox-product-detail-api.mjs';
export const A_PRODUCT_DETAIL_JOB_TYPE='a_product_detail_read';
export const A_PRODUCT_DETAIL_CAPABILITY='linkfox-product-detail-api';
export const A_PRODUCT_DETAIL_FAILURE_CLASSES=Object.freeze([...A_DISCOVERY_FAILURE_CLASSES.filter(code=>code!=='BATCH_CHANGED'),'CANDIDATE_CHANGED','SOURCE_INVALID']);
export class AProductDetailError extends Error{constructor(code){super(`A_PRODUCT_DETAIL_${code}`);this.name='AProductDetailError';this.code=code;}}
const closed=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const check=(v,code)=>{if(!v)throw new AProductDetailError(code);};
const ref=v=>isCanonicalFrozenRef(v)&&!['unknown','null','undefined'].includes(v);
const time=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v);
const safeClone=v=>{assertSafeRuntimeRecord(v);return structuredClone(v);};
export function assertAProductDetailPlan(plan){
 check(closed(plan,['schemaVersion','planId','version','contractVersion','requests','budget'])&&plan.schemaVersion==='a-product-detail-plan-v1'&&ref(plan.planId)&&ref(plan.version)&&
  plan.contractVersion===LINKFOX_DETAIL_CONTRACT_VERSION&&Array.isArray(plan.requests)&&plan.requests.length===2,'PLAN_INVALID');
 plan.requests.forEach((request,index)=>{buildLinkfoxProductDetailRequest(request);check(request.method===(index===0?'ozon_detail':'supplier_detail'),'PLAN_SEQUENCE_INVALID');});
 check(plan.requests[0].requestId!==plan.requests[1].requestId&&closed(plan.budget,['unit','maxRequests','maxCredits'])&&plan.budget.unit==='linkfox_credits'&&plan.budget.maxRequests===2&&plan.budget.maxCredits===13,'BUDGET_INVALID');
 return safeClone(plan);
}
export function assertAProductDetailScope(scope,job){
 check(closed(scope,['schemaVersion','candidateId','sourceRevision','resultRevision','targetStore','discoverySource','detailPlan','requestIndex','request','bindingId','configurationVersion','credentialAlias','budgetPolicyRef','authorizationRef','expiresAt'])&&
  scope.schemaVersion==='a-product-detail-scope-v1'&&['candidateId','bindingId','configurationVersion','credentialAlias','budgetPolicyRef','authorizationRef'].every(k=>ref(scope[k]))&&
  integer(scope.sourceRevision)&&scope.resultRevision===scope.sourceRevision&&['miska','dandanshu'].includes(scope.targetStore)&&[0,1].includes(scope.requestIndex)&&time(scope.expiresAt),'SCOPE_INVALID');
 const source=scope.discoverySource;
 check(closed(source,['batchId','batchRevision','planId','planVersion','marketProductId','marketReceiptRef','marketJobId','supplierOfferId','supplierReceiptRef','supplierJobId'])&&
  ['batchId','planId','planVersion','marketReceiptRef','marketJobId','supplierReceiptRef','supplierJobId'].every(k=>ref(source[k]))&&integer(source.batchRevision)&&
  id(source.marketProductId)&&id(source.supplierOfferId)&&source.marketReceiptRef===`a-discovery-receipt:${source.marketJobId}`&&source.supplierReceiptRef===`a-discovery-receipt:${source.supplierJobId}`,'SOURCE_INVALID');
 assertAProductDetailPlan(scope.detailPlan);
 check(scope.detailPlan.requests[0].productId===source.marketProductId&&scope.detailPlan.requests[1].productId===source.supplierOfferId&&
  isDeepStrictEqual(scope.request,scope.detailPlan.requests[scope.requestIndex]),'SOURCE_INVALID');
 if(job)check(job.schemaVersion==='software-job-v3'&&job.jobType===A_PRODUCT_DETAIL_JOB_TYPE&&closed(job.subject,['kind','candidateId','revision'])&&
  job.subject.kind==='a_candidate'&&job.subject.candidateId===scope.candidateId&&job.subject.revision===scope.sourceRevision&&job.revision===scope.sourceRevision&&
  !Object.hasOwn(job,'candidateId')&&!Object.hasOwn(job,'skuPackageId')&&isDeepStrictEqual(job.scopeBinding,scope),'JOB_SOURCE_CONFLICT');
 return safeClone(scope);
}
export function assertAProductDetailCandidateEligible(candidate){
 check(candidate?.workflowStatus==='needs_user_data'&&candidate.eliminatedAt==null&&candidate.lifecycleV11==null&&candidate.bPassedAt==null&&candidate.cCompletedAt==null&&
  candidate.executionRuntime?.exceptionCase?.status!=='open'&&candidate.executionRuntime?.technicalFailure?.status!=='stopped'&&
  (candidate.salesSnapshotsV11===undefined||Array.isArray(candidate.salesSnapshotsV11)&&candidate.salesSnapshotsV11.length===0),'CANDIDATE_CHANGED');
 return candidate;
}
export function assertAProductDetailCandidateSource(candidate,scope){
 assertAProductDetailScope(scope);const source=scope.discoverySource,evidence=candidate?.aDiscoveryEvidenceV1;
 assertAProductDetailCandidateEligible(candidate);
 check(candidate?.id===scope.candidateId&&candidate.dataRevision===scope.sourceRevision&&candidate.targetPlatform==='ozon'&&candidate.targetStore===scope.targetStore&&
  evidence?.schemaVersion==='a-discovery-candidate-evidence-v1'&&evidence.batchId===source.batchId&&evidence.sourceRevision===source.batchRevision&&
  evidence.planId===source.planId&&evidence.planVersion===source.planVersion&&evidence.marketProductId===source.marketProductId&&evidence.marketReceiptRef===source.marketReceiptRef&&
  Array.isArray(evidence.supplierReceiptRefs)&&evidence.supplierReceiptRefs[0]===source.supplierReceiptRef&&evidence.exactSkuMatch==='unknown'&&evidence.businessEffect==='discovery_evidence_only','CANDIDATE_CHANGED');
 return candidate;
}
/** Source identity is verified here; generic admission additionally verifies the source jobs' committed result envelopes. */
function readAProductDetailSource({document,candidate,scope}){
 assertAProductDetailCandidateSource(candidate,scope);const source=scope.discoverySource;
 check(Array.isArray(document?.runtime?.softwareJobs)&&document.runtime.aDiscoveryReceipts&&document.runtime.aDiscoveryBatches,'SOURCE_INVALID');
 const batch=document.runtime.aDiscoveryBatches[source.batchId];
 const receipts=[source.marketJobId,source.supplierJobId].map((jobId,index)=>{
  const jobs=document.runtime.softwareJobs.filter(job=>job.jobId===jobId);check(jobs.length===1,'SOURCE_INVALID');
  const job=jobs[0],receipt=assertADiscoveryReceipt(document.runtime.aDiscoveryReceipts[jobId],job);assertADiscoveryBatchSource(batch,receipt.scope);
  check(job.status==='completed'&&job.externalRequestState==='succeeded'&&receipt.status==='completed'&&receipt.steps[0].result.status==='candidates_found'&&
   sameTeamUser(job.ownerUserId,batch.ownerUserId)&&receipt.scope.requestIndex===index&&batch.batchId===source.batchId&&batch.revision===source.batchRevision&&
   batch.plan.planId===source.planId&&batch.plan.version===source.planVersion&&batch.targetStore===scope.targetStore,'SOURCE_INVALID');return receipt;
 });
 check(receipts[0].steps[0].result.products.some(row=>row.productId===source.marketProductId)&&receipts[1].steps[0].result.products[0].productId===source.supplierOfferId,'SOURCE_INVALID');
 return {batch,marketReceipt:receipts[0],supplierReceipt:receipts[1]};
}
export function assertAProductDetailSource(input){
 try{return readAProductDetailSource(input);}catch(error){if(error instanceof ADiscoveryError)throw new AProductDetailError('SOURCE_INVALID');throw error;}
}
function assertDetailResult(result,request){assertLinkfoxProductDetailResult(result);check(result.requestId===request.requestId&&result.method===request.method&&result.productId===request.productId,'STEP_RESULT_INVALID');}
export function assertAProductDetailAuthorization(record) {
  check(closed(record,['schemaVersion','authorizationId','authorizationType','status','action','scopeBinding','authorizedByUserId','authorizedAt','expiresAt','maxUses','useCount','consumedByJobId','consumedAt'])&&
    record.schemaVersion==='software-job-authorization-record-v3'&&record.authorizationType==='a_product_detail_once'&&record.status==='active'&&record.action===A_PRODUCT_DETAIL_JOB_TYPE&&
    ref(record.authorizationId)&&ref(record.authorizedByUserId)&&time(record.authorizedAt)&&time(record.expiresAt)&&Date.parse(record.authorizedAt)<Date.parse(record.expiresAt)&&
    record.maxUses===1&&[0,1].includes(record.useCount),'AUTHORIZATION_INVALID');
  const scope=assertAProductDetailScope(record.scopeBinding);
  check(record.authorizationId===scope.authorizationRef&&record.expiresAt===scope.expiresAt&&
    (record.useCount===0?record.consumedByJobId===null&&record.consumedAt===null:ref(record.consumedByJobId)&&time(record.consumedAt)&&
      Date.parse(record.consumedAt)>=Date.parse(record.authorizedAt)&&Date.parse(record.consumedAt)<Date.parse(record.expiresAt)),'AUTHORIZATION_INVALID');
  return safeClone(record);
}
export function assertAProductDetailCredential(record) {
  check(closed(record,['schemaVersion','bindingId','credentialAlias','status','provider','sideEffectScope','scopeBinding','allowedWorkerIds','redaction','boundAt','expiresAt'])&&
    record.schemaVersion==='software-job-credential-binding-v3'&&record.status==='active'&&record.provider==='linkfox'&&record.sideEffectScope===A_PRODUCT_DETAIL_JOB_TYPE&&
    ref(record.bindingId)&&record.redaction==='credential_alias_only'&&time(record.boundAt)&&time(record.expiresAt)&&Date.parse(record.boundAt)<Date.parse(record.expiresAt)&&
    Array.isArray(record.allowedWorkerIds)&&record.allowedWorkerIds.length===1&&record.allowedWorkerIds.every(ref),'CREDENTIAL_BINDING_INVALID');
  const scope=assertAProductDetailScope(record.scopeBinding);
  check(record.credentialAlias===scope.credentialAlias&&record.expiresAt===scope.expiresAt,'CREDENTIAL_BINDING_INVALID');return safeClone(record);
}
export function assertAProductDetailReceipt(receipt,job) {
  check(closed(receipt,['schemaVersion','receiptId','jobId','scope','workerId','leaseId','startedAt','completedAt','status','failureClass','steps',...(Object.hasOwn(receipt??{},'lateResult')?['lateResult']:[])])&&
    receipt.schemaVersion==='a-product-detail-receipt-v1'&&['receiptId','jobId','workerId','leaseId'].every(k=>ref(receipt[k]))&&time(receipt.startedAt)&&
    ['in_flight','completed','failed','unknown_outcome'].includes(receipt.status)&&Array.isArray(receipt.steps)&&receipt.steps.length<=1,'RECEIPT_INVALID');
  assertAProductDetailScope(receipt.scope,job);
  check(receipt.receiptId===`a-product-detail-receipt:${receipt.jobId}`,'RECEIPT_SOURCE_CONFLICT');
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
    check(step.errorCode===null||A_PRODUCT_DETAIL_FAILURE_CLASSES.includes(step.errorCode),'STEP_INVALID');
    if(step.result!==null){assertDetailResult(step.result,receipt.scope.request);check(step.externalRequestState==='succeeded'&&step.requestTransmission==='response_received'&&
      step.errorCode===null&&step.completedAt!==null&&Date.parse(step.result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(step.result.observedAt)<=Date.parse(step.completedAt),'STEP_RESULT_INVALID');}
  }
  if(receipt.status==='in_flight')check(receipt.completedAt===null&&receipt.failureClass===null,'RECEIPT_INVALID');
  else {
    check(time(receipt.completedAt)&&Date.parse(receipt.completedAt)>=Date.parse(receipt.startedAt)&&(!step||step.completedAt!==null&&Date.parse(receipt.completedAt)>=Date.parse(step.completedAt)),'RECEIPT_TIME_INVALID');
    if(receipt.status==='completed')check(step?.result!==null&&step?.result!==undefined&&receipt.failureClass===null,'RECEIPT_RESULT_INVALID');
    else check(A_PRODUCT_DETAIL_FAILURE_CLASSES.includes(receipt.failureClass)&&(!step||step.result===null&&step.errorCode===receipt.failureClass),'RECEIPT_FAILURE_INVALID');
    check(receipt.status==='unknown_outcome'?step?.externalRequestState==='unknown_outcome':!step||!['in_flight','unknown_outcome'].includes(step.externalRequestState),'RECEIPT_OUTCOME_CONFLICT');
  }
  if(Object.hasOwn(receipt,'lateResult')){
    const late=receipt.lateResult;
    check(receipt.status==='unknown_outcome'&&step?.sentAt!==null&&step?.sentAt!==undefined&&
      closed(late,['recordedAt','result'])&&time(late.recordedAt)&&Date.parse(late.recordedAt)>=Date.parse(receipt.completedAt),'LATE_RESULT_INVALID');
    assertDetailResult(late.result,receipt.scope.request);
    check(Date.parse(late.result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(late.result.observedAt)<=Date.parse(late.recordedAt),'LATE_RESULT_INVALID');
  }
  return safeClone(receipt);
}
export function readAProductDetailTerminal(receipt,job) {
  assertAProductDetailReceipt(receipt,job);check(receipt.status!=='in_flight','RECEIPT_NOT_TERMINAL');
  return {status:receipt.status,externalRequestState:receipt.steps[0]?.externalRequestState??'not_sent',failureClass:receipt.failureClass};
}
export function interruptAProductDetailReceipt(receipt,job,completedAt,failureClass) {
  const next=assertAProductDetailReceipt(receipt,job);check(next.status==='in_flight'&&time(completedAt)&&A_PRODUCT_DETAIL_FAILURE_CLASSES.includes(failureClass),'RECEIPT_INTERRUPTION_INVALID');
  const step=next.steps[0];if(step){step.completedAt=completedAt;step.errorCode=failureClass;if(step.externalRequestState==='in_flight')step.externalRequestState='unknown_outcome';}
  next.completedAt=completedAt;next.failureClass=failureClass;next.status=step?.externalRequestState==='unknown_outcome'?'unknown_outcome':'failed';
  return assertAProductDetailReceipt(next,job);
}
/** Both observations use the same candidate revision. Only the final application changes the candidate. */
export function nextAProductDetailRequest({candidate,scope,receipts}){
 assertAProductDetailCandidateSource(candidate,scope);check(Array.isArray(receipts)&&receipts.length<=2,'SEQUENCE_INVALID');
 const ordered=[...receipts].sort((a,b)=>a.scope.requestIndex-b.scope.requestIndex);
 for(const [index,receipt]of ordered.entries()){
  assertAProductDetailReceipt(receipt);assertAProductDetailCandidateSource(candidate,receipt.scope);
  check(receipt.scope.requestIndex===index&&isDeepStrictEqual(receipt.scope.detailPlan,scope.detailPlan)&&isDeepStrictEqual(receipt.scope.discoverySource,scope.discoverySource)&&
   ['bindingId','configurationVersion','credentialAlias','budgetPolicyRef','expiresAt'].every(k=>receipt.scope[k]===scope[k]),'SEQUENCE_INVALID');
  if(receipt.status!=='completed'||receipt.steps[0].result.status!=='observed'){check(index===ordered.length-1,'SEQUENCE_INVALID');return null;}
 }
 return ordered.length===2?null:structuredClone(scope.detailPlan.requests[ordered.length]);
}
export function assertAProductDetailAdmission({document,candidate,scope,authorization,receipts,checkedAt}){
 const {batch}=assertAProductDetailSource({document,candidate,scope});assertAProductDetailAuthorization(authorization);
 check(time(checkedAt)&&Date.parse(checkedAt)>=Date.parse(authorization.authorizedAt)&&Date.parse(checkedAt)<Date.parse(scope.expiresAt),'AUTHORIZATION_EXPIRED');
 check(sameTeamUser(authorization.authorizedByUserId,batch.ownerUserId)&&isDeepStrictEqual(authorization.scopeBinding,scope),'AUTHORIZATION_INVALID');
 check(isDeepStrictEqual(nextAProductDetailRequest({candidate,scope,receipts}),scope.request),'SEQUENCE_INVALID');return true;
}
