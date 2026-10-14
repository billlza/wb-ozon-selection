import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { blockingImportErrors } from './ozon-import-error-level.mjs';
export { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { assertOzonInventoryPrerequisitePolicy } from './ozon-inventory-prerequisite-policy.mjs';
import { observedWarehouseAvailableStock } from './e-stage-readback.mjs';
import { isDeepStrictEqual } from 'node:util';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef, isOpaqueProductionSourceRef } from './production-contract-primitives.mjs';
import { sameStoreRef, isCompleteStoreRef } from './store-binding.mjs';
import { decodeAttempt } from './d-execution-request-codec.mjs';
import { assertDCheckpointSources } from './d-production-job-cursor.mjs';
import { isProductionExecutionBinding } from './production-authorization-preparation.mjs';
import { readAuthorizedProductionSnapshot } from './production-authorization-snapshot.mjs';

export const D_PLATFORM_OBSERVATION_JOB_TYPE = 'e_d_platform_observation';
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireCondition = (value, code) => { if (!value) throw new Error(`D_PLATFORM_OBSERVATION_${code}`); };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const ref = isCanonicalFrozenRef;
const id = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const scopeFields = ['schemaVersion','candidateId','skuPackageId','supplierSkuId','revision','sourceDJobId','sourceExecutionKey',
  'authorizationRef','authorizationFingerprint','taskId','requestReceiptRef','platform','store','storeRef','warehouseRef','warehouseId',
  'credentialAlias','productionBinding','queryIndex','queryKind','nextEligibleAt','policy','inputFingerprint'];
export function assertDPlatformObservationScope(scope) {
  requireCondition(exact(scope, scopeFields) && scope.schemaVersion === 'd-platform-observation-scope-v1', 'SCOPE_INVALID');
  assertDPlatformObservationPolicy(scope.policy);
  requireCondition(['candidateId','skuPackageId','supplierSkuId','sourceDJobId','sourceExecutionKey',
    'authorizationFingerprint','requestReceiptRef','warehouseRef','credentialAlias','inputFingerprint'].every(field => ref(scope[field])) && isOpaqueProductionSourceRef(scope.authorizationRef) &&
    scope.platform === 'ozon' && isCompleteStoreRef(scope.storeRef, scope.store) && id(scope.taskId) && id(scope.warehouseId) &&
    Number.isSafeInteger(scope.revision) && scope.revision >= 0 && Number.isSafeInteger(scope.queryIndex) && scope.queryIndex > 0 &&
    scope.queryIndex <= scope.policy.maxQueries && ['import_task','price_state','inventory_prerequisites'].includes(scope.queryKind) &&
    time(scope.nextEligibleAt) && Date.parse(scope.nextEligibleAt) < Date.parse(scope.policy.expiresAt) && isProductionExecutionBinding(scope.productionBinding), 'SCOPE_INVALID');
  const { inputFingerprint, ...core } = scope;
  requireCondition(inputFingerprint === fingerprintCanonicalRecord(core), 'SCOPE_FINGERPRINT_CONFLICT');
  return scope;
}
function source(document, sourceDJobId, observedAt, allowStarted = false) {
  requireCondition(time(observedAt), 'TIME_INVALID');
  const sourceDJob = document.runtime.softwareJobs.find(job => job.jobId === sourceDJobId);
  requireCondition(sourceDJob?.jobType === 'd_production_execution' && sourceDJob.attempt === 1 &&
    (allowStarted ? ['claimed','waiting_platform'].includes(sourceDJob.status) : sourceDJob.status === 'waiting_platform' && sourceDJob.externalRequestState === 'succeeded'), 'SOURCE_JOB_INVALID');
  const candidate = document.candidates.find(value => value.id === sourceDJob.candidateId), sku = candidate?.lifecycleV11?.skuPackage;
  const state = sku?.dSoftwareExecution, request = state?.attempt?.request, continuation = state?.platformContinuation;
  requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && (state.status === 'waiting_platform' || allowStarted && state.status === 'in_flight') &&
    state.attempt?.schemaVersion === 'd-software-execution-v2' && state.attempt.status === state.status &&
    continuation?.schemaVersion === 'd-platform-continuation-v1' && isDeepStrictEqual(continuation,state.attempt.platformContinuation) && (continuation.inventoryWriteState === 'not_sent' || allowStarted && continuation.inventoryWriteState === 'intent_persisted') &&
    state.continuationBlocked === false && state.softwareJobRef.jobId === sourceDJobId && candidate.dataRevision === state.expectedCandidateRevision &&
    candidate.id === request.candidateId && sku.skuPackageId === request.skuPackageId && sku.supplierSkuId === request.supplierSkuId &&
    sku.productionRecord === null && isDeepStrictEqual(state.productionPlan.sourceAuthorization, sku.productionAuthorization), 'SOURCE_CONFLICT');
  decodeAttempt(state.attempt);
  requireCondition(state.executionKey === request.executionKey && request.sourceAuthorizationId === sku.productionAuthorization.authorizationId &&
    request.sourceAuthorizationFingerprint === fingerprintCanonicalRecord(sku.productionAuthorization) &&
    sourceDJob.scopeBinding.authorizationFingerprint === request.sourceAuthorizationFingerprint &&
    sameStoreRef(candidate.storeRef, request.storeRef) && sameStoreRef(sku.productionAuthorization.lockedScope.storeRef, request.storeRef), 'SOURCE_CONFLICT');
  requireCondition(Array.isArray(continuation.observationHistory) && Number.isSafeInteger(continuation.queryCount) &&
    continuation.queryCount === continuation.observationHistory.length && id(continuation.taskId) && ref(continuation.requestReceiptRef), 'CURSOR_INVALID');
  readAuthorizedProductionSnapshot({productionAuthorization:sku.productionAuthorization,candidateId:candidate.id,
    candidateRevision:sku.productionAuthorization.resultCandidateRevision,skuPackage:sku,checkedAt:observedAt});
  return {candidate,sku,state,request,continuation,sourceDJob};
}
export function createDPlatformObservationScope({document,candidate,sourceDJob,policy,queryIndex,nextEligibleAt,observedAt}) {
  assertDPlatformObservationPolicy(policy);
  const current = source(document,sourceDJob.jobId,observedAt), c = current.continuation, r = current.request;
  requireCondition(candidate.id === current.candidate.id && queryIndex === c.queryCount + 1, 'SEQUENCE_CONFLICT');
  const queryKind = c.status === 'waiting_import' ? 'import_task' : c.status === 'waiting_price' ? 'price_state' :
    c.status === 'waiting_inventory' ? 'inventory_prerequisites' : null;
  requireCondition(queryKind !== null && (c.policy === null || isDeepStrictEqual(c.policy,policy)), 'POLICY_SOURCE_CONFLICT');
  const core = {schemaVersion:'d-platform-observation-scope-v1',candidateId:candidate.id,skuPackageId:r.skuPackageId,supplierSkuId:r.supplierSkuId,
    revision:candidate.dataRevision,sourceDJobId:sourceDJob.jobId,sourceExecutionKey:stateKey(current),authorizationRef:r.sourceAuthorizationId,
    authorizationFingerprint:r.sourceAuthorizationFingerprint,taskId:c.taskId,requestReceiptRef:c.requestReceiptRef,platform:r.platform,store:r.store,
    storeRef:clone(r.storeRef),warehouseRef:r.warehouseRef,warehouseId:r.inventoryWrite.warehouseId,credentialAlias:r.credentialAlias,
    productionBinding:clone(current.sku.productionAuthorization.executionBinding),queryIndex,queryKind,nextEligibleAt,policy:clone(policy)};
  return assertDPlatformObservationScope({...core,inputFingerprint:fingerprintCanonicalRecord(core)});
}
const stateKey = current => current.state.executionKey;
export function assertDPlatformObservationJobSource({document,job,observedAt}) {
  requireCondition(job?.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE, 'JOB_INVALID');
  const scope = assertDPlatformObservationScope(job.scopeBinding), current = source(document,scope.sourceDJobId,observedAt);
  requireCondition(job.candidateId === scope.candidateId && job.skuPackageId === scope.skuPackageId && job.revision === scope.revision &&
    current.candidate.dataRevision === scope.revision && current.continuation.queryCount + 1 === scope.queryIndex, 'JOB_SOURCE_CONFLICT');
  const expected = createDPlatformObservationScope({document,candidate:current.candidate,sourceDJob:current.sourceDJob,policy:scope.policy,
    queryIndex:scope.queryIndex,nextEligibleAt:scope.nextEligibleAt,observedAt});
  requireCondition(isDeepStrictEqual(expected,scope), 'JOB_SOURCE_CONFLICT');
  return {...current,scope};
}
export function assertDPlatformObservationSend({document,job,workerId,leaseId,observedAt,signal}) {
  const current = assertDPlatformObservationJobSource({document,job,observedAt});
  requireCondition(signal?.aborted !== true && ['claimed','waiting_platform'].includes(job.status) && job.attempt === 1 &&
    job.workerId === workerId && job.leaseId === leaseId && time(job.leaseExpiresAt) && Date.parse(observedAt) < Date.parse(job.leaseExpiresAt) &&
    Date.parse(observedAt) >= Date.parse(current.scope.nextEligibleAt) && Date.parse(observedAt) < Date.parse(current.scope.policy.expiresAt), 'SEND_NOT_AUTHORIZED');
  return current;
}
/** Reject an unsent queued read using its frozen source, even when current authorization has expired or changed. */
function historicalObservationSource({document,job,observedAt}) {
  const scope=assertDPlatformObservationScope(job.scopeBinding);
  requireCondition(time(observedAt) && job.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE, 'REJECTION_INVALID');
  const sourceDJob=document.runtime.softwareJobs.find(value=>value.jobId === scope.sourceDJobId);
  const candidate=document.candidates.find(value=>value.id === scope.candidateId),sku=candidate?.lifecycleV11?.skuPackage;
  requireCondition(sourceDJob?.status === 'waiting_platform' && sourceDJob.externalRequestState === 'succeeded' &&
    candidate && sku?.skuPackageId === scope.skuPackageId, 'REJECTION_SOURCE_INVALID');
  readDProductionJobWaiting({candidate,job:sourceDJob,observedAt});
  const state=sku.dSoftwareExecution,continuation=state.platformContinuation,request=decodeAttempt(state.attempt).request;
  requireCondition(job.candidateId === scope.candidateId && job.skuPackageId === scope.skuPackageId && job.revision === scope.revision &&
    state.expectedCandidateRevision === scope.revision && state.executionKey === scope.sourceExecutionKey &&
    request.sourceAuthorizationId === scope.authorizationRef && request.sourceAuthorizationFingerprint === scope.authorizationFingerprint &&
    ['candidateId','skuPackageId','supplierSkuId','platform','store','warehouseRef','credentialAlias'].every(field=>request[field] === scope[field]) &&
    isDeepStrictEqual(request.storeRef,scope.storeRef) && request.inventoryWrite.warehouseId === scope.warehouseId &&
    isDeepStrictEqual(state.productionPlan.sourceAuthorization.executionBinding,scope.productionBinding) &&
    continuation.taskId === scope.taskId && continuation.requestReceiptRef === scope.requestReceiptRef &&
    continuation.queryCount+1 === scope.queryIndex && continuation.queryCount === continuation.observationHistory.length,
    'REJECTION_SOURCE_INVALID');
  return {candidate,sku,state,request:state.attempt.request,continuation,sourceDJob,scope};
}
export function rejectDPlatformObservationInDocument({document,job,observedAt,failureClass}) {
  requireCondition(job.status === 'queued' && job.attempt === 0 && job.externalRequestState === 'not_sent' &&
    ['context_changed','inventory_policy_missing'].includes(failureClass), 'REJECTION_INVALID');
  const current=historicalObservationSource({document,job,observedAt});
  return saveDPlatformObservation({document,job,observedAt,current,rejectedBeforeClaim:true,
    result:{schemaVersion:'d-platform-observation-failure-v1',status:'blocked',failureClass,requestSent:false}});
}
export function recordDPlatformObservationInDocument({document,job,result,observedAt}) {
  const current = historicalObservationSource({document,job,observedAt});
  requireCondition(job.attempt === 1 && ['claimed','waiting_platform'].includes(job.status) && object(result), 'RESULT_INVALID');
  const sourceChanged=current.candidate.dataRevision !== current.scope.revision ||
    current.sku.supplierSkuId !== current.scope.supplierSkuId ||
    !isDeepStrictEqual(current.sku.productionAuthorization,current.state.productionPlan.sourceAuthorization) ||
    !sameStoreRef(current.candidate.storeRef,current.scope.storeRef);
  if(!sourceChanged)assertDPlatformObservationJobSource({document,job,observedAt});
  return saveDPlatformObservation({document,job,result,observedAt,current,sourceChanged});
}
function saveDPlatformObservation({document,job,result,observedAt,current,rejectedBeforeClaim=false,sourceChanged=false}) {
  const {continuation:c,scope}=current;
  validateObservationResult(result,current);
  const observation = {schemaVersion:'d-platform-observation-record-v1',jobId:job.jobId,queryIndex:scope.queryIndex,queryKind:scope.queryKind,
    sourceFingerprint:scope.inputFingerprint,observedAt,sourceContextChanged:sourceChanged,result:encodeDPlatformObservationResult(result)};
  let disposition;
  if(result.schemaVersion === 'd-platform-observation-failure-v1') { c.status = result.status; disposition = result.status; }
  else if(scope.queryKind === 'import_task') {
    requireCondition(['waiting_platform','imported','platform_failed','platform_skipped','unknown_outcome'].includes(result.classification) &&
      result.importObservation?.taskId === scope.taskId, 'RESULT_SOURCE_CONFLICT');
    disposition = result.classification;
    if(disposition === 'imported') { c.productId = result.importObservation.productId; c.status = 'waiting_price'; }
    else if(disposition !== 'waiting_platform') c.status = disposition;
  } else if(scope.queryKind === 'price_state') {
    requireCondition(['verified','unknown'].includes(result.priceSent), 'RESULT_INVALID');
    disposition = result.priceSent === 'verified' ? 'price_verified' : 'unknown_outcome';
    c.status = result.priceSent === 'verified' ? 'waiting_inventory' : 'unknown_outcome';
  } else {
    requireCondition(['observed','unknown'].includes(result.reservedObservation), 'RESULT_INVALID');
    disposition = result.reservedObservation === 'observed' ? 'inventory_observed' : 'unknown_outcome';
    c.status = result.reservedObservation === 'observed' ? 'prerequisites_observed' : 'unknown_outcome';
  }
  c.observationHistory.push(observation); c.queryCount++; c.policy = clone(scope.policy); c.activeObservationJobId = null;
  current.state.attempt.platformContinuation = clone(c);
  const nextAt = new Date(Date.parse(observedAt)+scope.policy.intervalMs).toISOString();
  let nextScope = null;
  const deadlineExpired = !rejectedBeforeClaim && (!time(job.leaseExpiresAt) || Date.parse(observedAt) >= Math.min(Date.parse(job.leaseExpiresAt),Date.parse(scope.policy.expiresAt)));
  if(deadlineExpired || sourceChanged) { c.status = result.schemaVersion === 'd-platform-observation-failure-v1' && result.requestSent === false ? 'blocked' : 'unknown_outcome'; current.state.continuationBlocked = true; disposition = c.status; }
  else if(['waiting_import','waiting_price','waiting_inventory'].includes(c.status)) {
    if(c.queryCount >= scope.policy.maxQueries || Date.parse(nextAt) >= Date.parse(scope.policy.expiresAt)) c.status = 'query_budget_exhausted';
    else nextScope = createDPlatformObservationScope({document,candidate:current.candidate,sourceDJob:current.sourceDJob,policy:scope.policy,
      queryIndex:c.queryCount+1,nextEligibleAt:nextAt,observedAt});
  }
  current.state.attempt.platformContinuation = clone(c);
  if(['platform_failed','platform_skipped','unknown_outcome','blocked','query_budget_exhausted'].includes(c.status)) {
    current.state.status = c.status === 'unknown_outcome' ? 'unknown_outcome' : 'failed';
    current.state.attempt.status = current.state.status;
    current.state.settledAt = observedAt;
    if(current.state.status === 'unknown_outcome') { current.state.attempt.markedAt=observedAt; current.state.attempt.reason='platform_observation_outcome_unknown'; }
    else { current.state.attempt.completedAt=observedAt; current.state.attempt.failure={layer:'platform_observation',code:c.status,message:'平台观察已停止，原导入不得重放'}; }
  }
  return {...current,observation,nextScope,disposition};
}
export function assertDRemainingInventoryContinuation({document,job,observationJobId,checkedAt,verifyInventoryPrerequisiteSource,allowStarted=false}) {
  const current = source(document,job.jobId,checkedAt,allowStarted), {continuation:c,sku,state,request} = current;
  requireCondition((c.status === 'prerequisites_observed' || allowStarted && c.status === 'inventory_running') && typeof verifyInventoryPrerequisiteSource === 'function' &&
    (allowStarted || !state.checkpoints.some(event=>event.kind === 'stock_intent')), 'INVENTORY_NOT_AUTHORIZED');
  assertDPlatformObservationPolicy(c.policy);
  requireCondition(Date.parse(checkedAt)<Date.parse(c.policy.expiresAt), 'POLICY_EXPIRED');
  const inventory = c.observationHistory.at(-1), price = c.observationHistory.findLast(value=>value.queryKind === 'price_state' && value.result.priceSent === 'verified');
  requireCondition(inventory?.jobId === observationJobId && inventory.queryKind === 'inventory_prerequisites' && price &&
    inventory.result.reservedObservation === 'observed', 'PREREQUISITE_SOURCE_CONFLICT');
  for(const receipt of [price,inventory]) {
    const savedJob = document.runtime.softwareJobs.find(value=>value.jobId === receipt.jobId);
    requireCondition(savedJob?.status === 'completed' && savedJob.scopeBinding.sourceDJobId === job.jobId &&
      savedJob.scopeBinding.inputFingerprint === receipt.sourceFingerprint, 'PREREQUISITE_SOURCE_CONFLICT');
    const terminal = readDPlatformObservationJobTerminal({document,job:savedJob,observedAt:checkedAt});
    requireCondition(isDeepStrictEqual(savedJob.resultEnvelope?.payload,terminal.payload), 'PREREQUISITE_ENVELOPE_CONFLICT');
  }
  const prerequisites = {priceSentObservation:decodeDPlatformObservationResult(price.result),inventoryPrerequisiteObservation:decodeDPlatformObservationResult(inventory.result)};
  requireCondition(verifyInventoryPrerequisiteSource({document,candidate:current.candidate,job,prerequisites,checkedAt}) === true, 'PREREQUISITE_SOURCE_UNVERIFIED');
  readAuthorizedProductionSnapshot({productionAuthorization:sku.productionAuthorization,candidateId:current.candidate.id,
    candidateRevision:sku.productionAuthorization.resultCandidateRevision,skuPackage:sku,checkedAt});
  return {...current,prerequisites};
}
export function resumeDRemainingInventoryInDocument(args) {
  const current = assertDRemainingInventoryContinuation(args), {state} = current;
  const imported = state.platformContinuation.observationHistory.find(value=>value.queryKind === 'import_task' && value.result.classification === 'imported');
  requireCondition(imported && state.checkpoints.length === 2, 'IMPORT_SOURCE_CONFLICT');
  state.checkpoints.push({...clone(imported.result.importObservation),observedAt:imported.observedAt});
  state.step = 'import_result_observed';
  state.status = 'in_flight'; state.attempt.status = 'in_flight';
  state.platformContinuation.status = 'inventory_running'; state.attempt.platformContinuation = clone(state.platformContinuation);
  state.softwareJobRef = {...state.softwareJobRef,workerId:args.workerId,leaseId:args.leaseId};
  return current;
}
const admissionFields = ['schemaVersion','admissionId','jobId','jobType','candidateId','skuPackageId','revision','scopeFingerprint','phase','observedAt','executionBindingSnapshot'];
function admissionCore(job) {
 const scope = assertDPlatformObservationScope(job.scopeBinding);
 const core = {schemaVersion:'d-platform-observation-admission-v1',jobId:job.jobId,jobType:job.jobType,candidateId:job.candidateId,
   skuPackageId:job.skuPackageId,revision:job.revision,scopeFingerprint:scope.inputFingerprint};
 return {...core,admissionId:`d-platform-observation-admission:${fingerprintCanonicalRecord(core)}`};
}
export function assertDPlatformObservationAdmission(job,decision) {
 requireCondition(exact(decision,admissionFields) && ['enqueue_current','claim','external_request'].includes(decision.phase) && time(decision.observedAt), 'ADMISSION_INVALID');
 requireCondition(Object.entries(admissionCore(job)).every(([key,value])=>isDeepStrictEqual(decision[key],value)), 'ADMISSION_SOURCE_CONFLICT');
 requireCondition(decision.phase === 'enqueue_current' ? decision.executionBindingSnapshot === null : object(decision.executionBindingSnapshot), 'ADMISSION_BINDING_INVALID');
 return decision;
}
export function createDPlatformObservationAdmission({document,job,worker=null,executionBinding=null,phase,observedAt}) {
 const current = assertDPlatformObservationJobSource({document,job,observedAt}), scope = current.scope;
 requireCondition(Date.parse(observedAt)<Date.parse(scope.policy.expiresAt), 'POLICY_EXPIRED');
 let snapshot = null;
 if(phase !== 'enqueue_current') {
  requireCondition(worker?.status === 'online' && worker.capabilities?.includes('ozon-independent-readback') &&
    executionBinding?.workerId === worker.workerId && executionBinding.workerVersion === worker.version &&
    isDeepStrictEqual(executionBinding.productionBinding,scope.productionBinding) && sameStoreRef(executionBinding.storeRef,scope.storeRef) &&
    executionBinding.warehouseRef === scope.warehouseRef && executionBinding.credentialAlias === scope.credentialAlias &&
    time(executionBinding.configurationEvidence?.expiresAt) && Date.parse(observedAt)<Date.parse(executionBinding.configurationEvidence.expiresAt), 'ADMISSION_BINDING_INVALID');
  requireCondition(Date.parse(observedAt)>=Date.parse(scope.nextEligibleAt), 'NOT_DUE');
  const previous = assertDPlatformObservationAdmission(job,job.admissionDecision);
  requireCondition(phase === 'claim' ? previous.phase === 'enqueue_current' : ['claim','external_request'].includes(previous.phase), 'ADMISSION_PHASE_CONFLICT');
  if(phase === 'external_request') requireCondition(isDeepStrictEqual(executionBinding,previous.executionBindingSnapshot), 'ADMISSION_BINDING_CHANGED');
  snapshot = clone(executionBinding);
 }
 return assertDPlatformObservationAdmission(job,{...admissionCore(job),phase,observedAt,executionBindingSnapshot:snapshot});
}
export function readDProductionJobWaiting({candidate,job,observedAt}) {
 const state = candidate?.lifecycleV11?.skuPackage?.dSoftwareExecution;
 requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && state.status === 'waiting_platform' &&
  state.attempt?.status === 'waiting_platform' && state.platformContinuation?.schemaVersion === 'd-platform-continuation-v1' &&
  state.platformContinuation.inventoryWriteState === 'not_sent' && state.checkpoints.length === 2 &&
  state.checkpoints[0].kind === 'import_intent' && state.checkpoints[1].kind === 'import_task_received' &&
  state.checkpoints[1].taskId === state.platformContinuation.taskId && state.platformWrites === 1 &&
  state.softwareJobRef.jobId === job.jobId && state.softwareJobRef.workerId === job.workerId &&
  (state.softwareJobRef.leaseId === job.leaseId || job.leaseId === null && job.leaseExpiresAt === null && job.status === 'waiting_platform' &&
   job.externalRequestState === 'succeeded' && isDeepStrictEqual(job.platformContinuation,state.platformContinuation)) &&
  state.executionKey === state.attempt.request.executionKey && candidate.id === job.candidateId &&
  state.attempt.request.sourceAuthorizationFingerprint === job.scopeBinding.authorizationFingerprint && time(observedAt) &&
  time(state.settledAt) && Date.parse(observedAt)>=Date.parse(state.settledAt), 'WAIT_SOURCE_INVALID');
 decodeAttempt(state.attempt);
 return {status:'waiting_platform',externalRequestState:'succeeded',platformContinuation:clone(state.platformContinuation)};
}

export function dPlatformObservationQuery({scope,request,continuation}) {
 return {platform:scope.platform,store:scope.store,storeRef:clone(scope.storeRef),warehouseRef:scope.warehouseRef,
  credentialAlias:scope.credentialAlias,warehouseId:scope.warehouseId,taskId:scope.taskId,...(scope.queryKind === 'import_task' ? {} : {productId:continuation.productId}),
  merchantSku:request.merchantSku,supplierSkuId:scope.supplierSkuId,executionKey:scope.sourceExecutionKey,
  requestReceiptRef:scope.requestReceiptRef,writeAllowed:false};
}
const policyEndpoints = {priceSent:['/v3/product/info/list','ozon-product-info-v3'],reserved:['/v2/product/info/stocks-by-warehouse/fbs','ozon-product-stocks-by-warehouse-fbs-v2']};
export function encodeDPlatformObservationResult(result) {
 const saved = clone(result);
 if(saved.policy !== undefined && saved.policy !== null) {
  assertOzonInventoryPrerequisitePolicy(saved.policy);
  for(const [key,[endpoint,protocolId]] of Object.entries(policyEndpoints)) {
   requireCondition(saved.policy[key].endpoint === endpoint, 'POLICY_PROTOCOL_INVALID');
   delete saved.policy[key].endpoint; saved.policy[key].protocolId = protocolId;
  }
 }
 return saved;
}
export function decodeDPlatformObservationResult(result) {
 const decoded = clone(result);
 if(decoded.policy !== undefined && decoded.policy !== null) {
  for(const [key,[endpoint,protocolId]] of Object.entries(policyEndpoints)) {
   requireCondition(decoded.policy[key].protocolId === protocolId && !Object.hasOwn(decoded.policy[key],'endpoint'), 'POLICY_PROTOCOL_INVALID');
   delete decoded.policy[key].protocolId; decoded.policy[key].endpoint = endpoint;
  }
  assertOzonInventoryPrerequisitePolicy(decoded.policy);
 }
 return decoded;
}
function validateObservationResult(result,current) {
 const scope = current.scope;
 if(result.schemaVersion === 'd-platform-observation-failure-v1') {
  requireCondition(exact(result,['schemaVersion','status','failureClass','requestSent']) && ['unknown_outcome','blocked'].includes(result.status) &&
   ['request_timeout','request_cancelled','transport_failure','inventory_policy_missing','inventory_policy_outdated','system_failure','context_changed'].includes(result.failureClass) &&
   typeof result.requestSent === 'boolean' && (result.status !== 'blocked' || result.requestSent === false), 'RESULT_INVALID');
  return;
 }
 if(scope.queryKind === 'import_task') {
  requireCondition(exact(result,['classification','gapCode','importObservation','inventoryPrerequisites']) &&
   exact(result.importObservation,['kind','taskId','productId','merchantSku','itemCount','status','errorCount','requestReceiptRef','errors']) &&
   importErrorsShape(result.importObservation.errors, result.importObservation.errorCount) &&
   result.importObservation.kind === 'import_result_observed' && result.importObservation.taskId === scope.taskId &&
   (result.importObservation.productId === null || id(result.importObservation.productId)) &&
   (result.importObservation.merchantSku === null || result.importObservation.merchantSku === current.request.merchantSku) &&
   ['pending','imported','failed','skipped','unknown'].includes(result.importObservation.status) &&
   ['itemCount','errorCount'].every(key=>result.importObservation[key] === null || Number.isSafeInteger(result.importObservation[key]) && result.importObservation[key]>=0) &&
   ref(result.importObservation.requestReceiptRef) &&
   [null,'import_task_identity_unverified','import_task_response_invalid','import_task_status_unknown','import_task_errors_present'].includes(result.gapCode) &&
   isDeepStrictEqual(result.inventoryPrerequisites,{priceSent:'unknown',reservedObservation:'not_queried'}), 'RESULT_INVALID');
  const observation = result.importObservation;
  const classification = result.gapCode !== null ? 'unknown_outcome' : ({pending:'waiting_platform',imported:'imported',failed:'platform_failed',skipped:'platform_skipped'})[observation.status];
  requireCondition(result.classification === classification && (classification === 'unknown_outcome' || observation.itemCount === 1 &&
   observation.merchantSku === current.request.merchantSku && (observation.status === 'failed' || observation.errorCount === 0 ||
     // 全是警告时允许非零：与适配器的 classification 判定同用一条规则（ozon-import-error-level.mjs）
     blockingImportErrors(observation.errors).length === 0)) &&
   (classification !== 'imported' || id(observation.productId)), 'RESULT_CLASSIFICATION_CONFLICT');
  return;
 }
 const fields = scope.queryKind === 'price_state' ? ['scope','policy','priceSent','requestReceiptRef'] :
  ['scope','policy','priceSent','inventoryObservation','reservedObservation','requestReceiptRef'];
 const {writeAllowed,...expectedScope} = dPlatformObservationQuery(current);
 requireCondition(exact(result,fields) && isDeepStrictEqual(result.scope,expectedScope) && ref(result.requestReceiptRef), 'RESULT_SOURCE_CONFLICT');
 if(result.policy !== null) assertOzonInventoryPrerequisitePolicy(result.policy);
 if(scope.queryKind === 'price_state') requireCondition(result.policy !== null && ['verified','unknown'].includes(result.priceSent),'RESULT_INVALID');
 else requireCondition(result.priceSent === 'unknown' && ['observed','unknown'].includes(result.reservedObservation) &&
  (result.reservedObservation !== 'observed' || observedWarehouseAvailableStock(result.inventoryObservation,scope.warehouseId,
   {productId:current.continuation.productId,offerId:current.request.merchantSku}) !== 'unknown'), 'RESULT_INVALID');
}

export function assertDRemainingInventorySend(args) {
 requireCondition(args.signal?.aborted !== true && args.job.workerId === args.workerId && args.job.leaseId === args.leaseId &&
  ['claimed','waiting_platform'].includes(args.job.status) && time(args.job.leaseExpiresAt) &&
  Date.parse(args.checkedAt)<Date.parse(args.job.leaseExpiresAt), 'INVENTORY_HOLDER_INVALID');
 return assertDRemainingInventoryContinuation({...args,allowStarted:true});
}

export function readDPlatformObservationJobTerminal({document,job,observedAt}) {
 const scope = assertDPlatformObservationScope(job.scopeBinding);
 const candidate = document.candidates.find(value=>value.id===job.candidateId), state = candidate?.lifecycleV11?.skuPackage?.dSoftwareExecution;
 requireCondition(job.jobType === D_PLATFORM_OBSERVATION_JOB_TYPE && [0,1].includes(job.attempt) && state?.schemaVersion === 'd-software-execution-state-v2' &&
  state.executionKey === scope.sourceExecutionKey && state.softwareJobRef.jobId === scope.sourceDJobId && candidate.id === scope.candidateId, 'TERMINAL_SOURCE_INVALID');
 const matches = state.platformContinuation.observationHistory.filter(value=>value.jobId===job.jobId);
 requireCondition(matches.length === 1, 'TERMINAL_RECEIPT_INVALID');
 const observation = matches[0];
 requireCondition(observation.queryIndex === scope.queryIndex && observation.queryKind === scope.queryKind &&
  observation.sourceFingerprint === scope.inputFingerprint && typeof observation.sourceContextChanged === 'boolean' && time(observation.observedAt) && time(observedAt) &&
  Date.parse(observedAt)>=Date.parse(observation.observedAt), 'TERMINAL_RECEIPT_INVALID');
 const result=decodeDPlatformObservationResult(observation.result);
 validateObservationResult(result,{scope,request:state.attempt.request,continuation:state.platformContinuation});
 const technical=result.schemaVersion === 'd-platform-observation-failure-v1';
 requireCondition(job.attempt === 1 || technical && result.status === 'blocked' && result.requestSent === false &&
  ['context_changed','inventory_policy_missing'].includes(result.failureClass) && job.externalRequestState === 'not_sent' &&
  job.workerId === null && job.leaseId === null && job.leaseExpiresAt === null, 'TERMINAL_SOURCE_INVALID');
 const disposition=technical ? result.status : scope.queryKind === 'import_task' ? result.classification :
  scope.queryKind === 'price_state' ? result.priceSent === 'verified' ? 'price_verified' : 'unknown_outcome' :
  result.reservedObservation === 'observed' ? 'inventory_observed' : 'unknown_outcome';
 const late=time(job.leaseExpiresAt) && Date.parse(observation.observedAt)>=Math.min(Date.parse(job.leaseExpiresAt),Date.parse(scope.policy.expiresAt));
 const payload={schemaVersion:'d-platform-observation-job-result-v1',sourceDJobId:scope.sourceDJobId,sourceExecutionKey:scope.sourceExecutionKey,
  queryIndex:scope.queryIndex,scopeFingerprint:scope.inputFingerprint,observationFingerprint:fingerprintCanonicalRecord(observation),
  disposition:late || observation.sourceContextChanged ? technical && !result.requestSent ? 'blocked' : 'unknown_outcome' : disposition};
 return {status:technical ? result.requestSent ? 'unknown_outcome' : 'failed' : 'completed',
  externalRequestState:technical ? result.requestSent ? 'unknown_outcome' : 'not_sent' : 'succeeded',
  failureClass:technical ? `d-platform-observation-${result.failureClass.replaceAll('_','-')}` : null,payload,
  disposition:payload.disposition,observation,applicationDisposition:'result_recorded_no_candidate_mutation'};
}

/** A confirmed import task can be retained without authorizing any observation or inventory write. */
export function readDInitialImportStoppedJobTerminal({candidate,job,observedAt}) {
 const sku=candidate?.lifecycleV11?.skuPackage,state=sku?.dSoftwareExecution,c=state?.platformContinuation;
 requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && state.status === 'failed' &&
  state.attempt?.schemaVersion === 'd-software-execution-v2' && state.attempt.status === 'failed' &&
  state.continuationBlocked === true && ['lease_expired','context_changed'].includes(state.blockReason) &&
  state.attempt.failure?.layer === 'platform_observation' && state.attempt.failure.code === state.blockReason &&
  c?.schemaVersion === 'd-platform-continuation-v1' && c.status === 'blocked' && c.inventoryWriteState === 'not_sent' &&
  c.productId === null && c.policy === null && c.activeObservationJobId === null && c.queryCount === 0 &&
  Array.isArray(c.observationHistory) && c.observationHistory.length === 0 && isDeepStrictEqual(c,state.attempt.platformContinuation) &&
  state.step === 'import_task_received' && state.checkpoints.length === 2 && state.platformWrites === 1 &&
  state.attempt.productionRecord === null && sku.productionRecord === null &&
  candidate.id === job.candidateId && sku.skuPackageId === job.skuPackageId && job.jobType === 'd_production_execution' && job.attempt === 1 &&
  isDeepStrictEqual(state.softwareJobRef,{jobId:job.jobId,revision:job.revision,workerId:job.workerId,leaseId:job.leaseId}) &&
  time(observedAt) && time(state.settledAt) && state.attempt.completedAt === state.settledAt &&
  (state.blockReason !== 'lease_expired' || time(job.leaseExpiresAt) && Date.parse(state.settledAt)>=Date.parse(job.leaseExpiresAt)) &&
  Date.parse(observedAt)>=Date.parse(state.settledAt), 'INITIAL_STOP_SOURCE_INVALID');
 const request=decodeAttempt(state.attempt).request,accepted=state.attempt.platformResult;
 assertDCheckpointSources(state,request,observedAt,{terminal:true});
 requireCondition(state.executionKey === request.executionKey && state.attempt.executionKey === request.executionKey &&
  request.executionProtocolVersion === 'ozon-single-sku-d-e-v3' && request.candidateId === candidate.id && request.skuPackageId === job.skuPackageId &&
  request.sourceAuthorizationId === job.scopeBinding.authorizationRef && request.sourceAuthorizationFingerprint === job.scopeBinding.authorizationFingerprint &&
  fingerprintCanonicalRecord(state.productionPlan.sourceAuthorization) === request.sourceAuthorizationFingerprint &&
  fingerprintCanonicalRecord(state.productionPlan) === request.sourceProductionPlanFingerprint &&
  request.sourceProductionPlanId === state.productionPlan.planId &&
  state.checkpoints[1].taskId === c.taskId && id(c.taskId) && ref(c.requestReceiptRef) &&
  Date.parse(state.checkpoints[1].observedAt)<=Date.parse(state.settledAt) &&
  exact(accepted,['status','taskId','productId','offerId','requestReceiptRef','inventoryWriteState','retryAllowed']) &&
  accepted.status === 'waiting_platform' && accepted.taskId === c.taskId && accepted.productId === null &&
  accepted.offerId === request.merchantSku && accepted.requestReceiptRef === c.requestReceiptRef &&
  accepted.inventoryWriteState === 'not_sent' && accepted.retryAllowed === false, 'INITIAL_STOP_RECEIPT_INVALID');
 const payload={schemaVersion:'d-initial-import-stop-job-result-v1',sourceExecutionKey:state.executionKey,taskId:c.taskId,
  requestReceiptRef:c.requestReceiptRef,stopReason:state.blockReason,checkpointFingerprint:fingerprintCanonicalRecord(state.checkpoints),inventoryWriteState:'not_sent'};
 return {status:'failed',externalRequestState:'succeeded',failureClass:`d-initial-import-${state.blockReason.replaceAll('_','-')}`,
  payload,applicationDisposition:'result_recorded_no_candidate_mutation'};
}

export function stopDInitialImportContinuationInDocument({document,job,workerId,leaseId,observedAt,failureClass}) {
 const candidate=document.candidates.find(value=>value.id === job.candidateId);
 requireCondition(job.status === 'waiting_platform' && job.externalRequestState === 'in_flight' &&
  job.workerId === workerId && job.leaseId === leaseId && ['lease_expired','context_changed'].includes(failureClass), 'INITIAL_STOP_HOLDER_INVALID');
 readDProductionJobWaiting({candidate,job,observedAt});
 const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
 state.status='failed';state.attempt.status='failed';state.continuationBlocked=true;state.blockReason=failureClass;
 state.platformContinuation.status='blocked';state.attempt.platformContinuation=clone(state.platformContinuation);
 state.settledAt=observedAt;state.attempt.completedAt=observedAt;
 state.attempt.failure={layer:'platform_observation',code:failureClass,message:'导入任务已接受，但执行上下文失效，停止后续查询和库存写入'};
 return readDInitialImportStoppedJobTerminal({candidate,job,observedAt});
}

/**
 * stopDInitialImportContinuationInDocument 的反向：把一次「导入已被平台接受、却因执行上下文判定
 * 而自断后路」的执行放回它本该在的位置（waiting_platform），交给现成的观察链继续。
 *
 * 2026-09-24 背心就是这样停的：r65 把查询策略的 expiresAt 设成一个绝对时刻，导入在 12 小时后才
 * 发出，过期判定又写在导入被接受之后，于是平台已经收下商品、软件却停了观察和库存。
 *
 * 这里不造第二套 productionRecord，也不自己调平台：恢复之后由观察作业按原路查 import/info、
 * 拿 product_id、再由 resumeInventory 按原授权锁定的仓库与数量写库存。
 * 只接受精确的 stopped 形状，任何一项不符都拒绝；原失败分类与 stopTrigger 原样留底。
 */
export function recoverDInitialImportStoppedInDocument({document,job,observedAt,actorId,policy,recoveryId}) {
 const candidate=document.candidates.find(value=>value.id === job.candidateId);
 requireCondition(job.status === 'failed' && job.externalRequestState === 'succeeded' &&
  job.failureClass === 'd-initial-import-context-changed' &&
  job.resultEnvelope?.payload?.schemaVersion === 'd-initial-import-stop-job-result-v1' &&
  typeof actorId === 'string' && actorId.trim().length > 0 && typeof recoveryId === 'string' && recoveryId.trim().length > 0,
  'INITIAL_RECOVERY_SOURCE_INVALID');
 // 精确的 stopped 形状由同一个读取器把关：平台写入恰好 1 次、库存未发、无生产记录、观察历史为空等。
 const stopped=readDInitialImportStoppedJobTerminal({candidate,job,observedAt});
 requireCondition(stopped.payload.taskId === job.resultEnvelope.payload.taskId &&
  stopped.payload.requestReceiptRef === job.resultEnvelope.payload.requestReceiptRef, 'INITIAL_RECOVERY_RECEIPT_CONFLICT');
 assertDPlatformObservationPolicy(policy);
 // 策略不但要当下有效，还要够跑完整场观察；否则恢复完又会在中途停一次。
 const required=policy.maxQueries*policy.intervalMs;
 requireCondition(Date.parse(policy.expiresAt)-Date.parse(observedAt) >= required, 'INITIAL_RECOVERY_POLICY_WINDOW_INVALID');
 const sku=candidate.lifecycleV11.skuPackage,state=sku.dSoftwareExecution;
 const archive={schemaVersion:'d-initial-import-recovery-v1',recoveryId,recoveredAt:observedAt,recoveredByActorId:actorId,
  taskId:stopped.payload.taskId,requestReceiptRef:stopped.payload.requestReceiptRef,
  sourceAuthorizationId:state.attempt.request.sourceAuthorizationId,sourceDJobId:job.jobId,
  stoppedFailureClass:job.failureClass,stoppedBlockReason:state.blockReason,
  stopTrigger:state.stopTrigger?clone(state.stopTrigger):null,stoppedSettledAt:state.settledAt,
  policyRef:policy.policyRef,policyVersion:policy.version,policyExpiresAt:policy.expiresAt,
  platformWrites:state.platformWrites,inventoryWriteState:state.platformContinuation.inventoryWriteState};
 const existing=candidate.lifecycleV11.dInitialImportRecoveryV1 ?? [];
 requireCondition(!existing.some(entry=>entry.taskId === archive.taskId), 'INITIAL_RECOVERY_ALREADY_DONE');
 state.status='waiting_platform';state.attempt.status='waiting_platform';
 state.continuationBlocked=false;state.blockReason=null;
 state.attempt.failure=null;state.attempt.completedAt=null;
 state.platformContinuation.status='waiting_import';
 state.attempt.platformContinuation=clone(state.platformContinuation);
 state.settledAt=observedAt;
 candidate.lifecycleV11.dInitialImportRecoveryV1=[...existing,archive];
 return {archive,stoppedPayload:stopped.payload};
}

export function readDPlatformStoppedJobTerminal({candidate,job,observedAt}) {
 const state=candidate?.lifecycleV11?.skuPackage?.dSoftwareExecution,c=state?.platformContinuation;
 requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && c?.schemaVersion === 'd-platform-continuation-v1' &&
  ['platform_failed','platform_skipped','unknown_outcome','blocked','query_budget_exhausted','inventory_not_sent_interrupted'].includes(c.status) &&
  state.status === (c.status === 'unknown_outcome' ? 'unknown_outcome' : 'failed') && state.attempt.status === state.status &&
  c.inventoryWriteState === 'not_sent' && state.checkpoints.length === (c.status === 'inventory_not_sent_interrupted'?3:2) && state.checkpoints[0].kind === 'import_intent' &&
  state.checkpoints[1].kind === 'import_task_received' && state.checkpoints[1].taskId === c.taskId && state.platformWrites === 1 &&
  state.softwareJobRef.jobId === job.jobId && state.executionKey === state.attempt.request.executionKey &&
  state.attempt.request.sourceAuthorizationFingerprint === job.scopeBinding.authorizationFingerprint &&
  state.attempt.productionRecord === null && candidate.lifecycleV11.skuPackage.productionRecord === null &&
  time(state.settledAt) && time(observedAt) && Date.parse(observedAt)>=Date.parse(state.settledAt), 'STOP_SOURCE_INVALID');
 decodeAttempt(state.attempt);
 const last=c.observationHistory.at(-1);requireCondition(last && c.queryCount === c.observationHistory.length,'STOP_RECEIPT_INVALID');
 const payload={schemaVersion:'d-platform-stop-job-result-v1',sourceExecutionKey:state.executionKey,taskId:c.taskId,requestReceiptRef:c.requestReceiptRef,
  stopReason:c.status,lastObservationJobId:last.jobId,observationFingerprint:fingerprintCanonicalRecord(last),inventoryWriteState:'not_sent'};
 return {status:state.status,externalRequestState:state.status === 'unknown_outcome'?'unknown_outcome':'succeeded',
  failureClass:`d-platform-${c.status.replaceAll('_','-')}`,payload,applicationDisposition:'result_recorded_no_candidate_mutation'};
}

/** Restart can preserve confirmed import success only when the remaining write has no saved intent. */
export function reconcileDRemainingInventoryInDocument({document,job,observedAt}) {
 const candidate=document.candidates.find(value=>value.id===job.candidateId),state=candidate?.lifecycleV11?.skuPackage?.dSoftwareExecution;
 if(state?.schemaVersion !== 'd-software-execution-state-v2' || state.platformContinuation?.status !== 'inventory_running') return null;
 requireCondition(state.status === 'in_flight' && state.attempt.status === 'in_flight' &&
  state.softwareJobRef.jobId === job.jobId && state.softwareJobRef.workerId === job.workerId && state.softwareJobRef.leaseId === job.leaseId,
  'RESTART_SOURCE_INVALID');
 decodeAttempt(state.attempt);
 if(state.platformContinuation.inventoryWriteState !== 'not_sent' || state.checkpoints.some(value=>value.kind === 'stock_intent')) return null;
 const imported=state.platformContinuation.observationHistory.find(value=>value.queryKind === 'import_task' && value.result.classification === 'imported');
 requireCondition(job.status === 'claimed' && job.externalRequestState === 'not_sent' && job.externalRequestRef === null && state.platformWrites === 1 &&
  state.checkpoints.length === 3 && imported && isDeepStrictEqual(state.checkpoints[2],{...imported.result.importObservation,observedAt:imported.observedAt}) &&
  state.checkpoints[1].taskId === state.platformContinuation.taskId, 'RESTART_RECEIPT_INVALID');
 state.status='failed';state.attempt.status='failed';state.settledAt=observedAt;state.continuationBlocked=true;
 state.platformContinuation.status='inventory_not_sent_interrupted';state.attempt.platformContinuation=clone(state.platformContinuation);
 state.attempt.completedAt=observedAt;state.attempt.failure={layer:'platform_observation',code:'inventory_not_sent_interrupted',message:'库存发送前执行中断，保留原导入事实'};
 return readDPlatformStoppedJobTerminal({candidate,job,observedAt});
}

export function rejectDRemainingInventoryInDocument({document,job,observationJobId,observedAt,failureClass}) {
  requireCondition(['context_changed','inventory_policy_missing','inventory_stock_mismatch','inventory_request_superseded'].includes(failureClass), 'REJECTION_INVALID');
  const candidate=document.candidates.find(value=>value.id === job.candidateId);
  readDProductionJobWaiting({candidate,job,observedAt});
  const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution,c=state.platformContinuation;
  requireCondition(c.status === 'prerequisites_observed' && c.inventoryWriteState === 'not_sent' &&
    c.observationHistory.at(-1)?.jobId === observationJobId, 'REJECTION_SOURCE_INVALID');
  const observationJob=document.runtime.softwareJobs.find(value=>value.jobId === observationJobId);
  const terminal=readDPlatformObservationJobTerminal({document,job:observationJob,observedAt});
  requireCondition(observationJob.status === 'completed' && terminal.disposition === 'inventory_observed' &&
    isDeepStrictEqual(observationJob.resultEnvelope?.payload,terminal.payload), 'REJECTION_SOURCE_INVALID');
  c.status='blocked';state.attempt.platformContinuation=clone(c);state.status='failed';state.attempt.status='failed';
  state.settledAt=observedAt;state.continuationBlocked=true;state.attempt.completedAt=observedAt;
  state.attempt.failure={layer:'platform_observation',code:failureClass,message:'库存续执行前提失效，未发送库存请求'};
  return readDPlatformStoppedJobTerminal({candidate,job,observedAt});
}

export const D_OWNER_STOCK_REGISTRATION_FIELD = 'dOwnerStockRegistrationV1';

/**
 * 主人自己在卖家后台填好库存时走的「登记」档：软件**不发**任何库存写请求，
 * 只把「平台当前库存等于授权锁定值、这是主人写的」这件事如实记下来。
 *
 * 为什么不生成 productionRecord：AGENTS 10.2 要求 ProductionRecord 必须绑定**本轮真实执行回执**。
 * 库存不是软件写的，就没有库存写入回执；照抄一个或拿回读结果倒填一个，
 * 等于把回读事实冒充成写入回执。所以这一档止于登记，E 由主人人工核对（AGENTS 10.1）。
 *
 * 三岔判定由调用方做，这里只接受「回读值恰好等于授权锁定值」这一种，
 * 其余（0 或任何其他数）都不该走到这里。
 */
/**
 * 导入错误明细的形状：按官方合同 v1ItemError 的字段落盘（见 ozon-seller-api-de-adapter.mjs
 * 的 observedImportErrors）。允许 "unknown"（平台没给 errors 数组时）。
 * 条数必须与 errorCount 对得上——否则说明有人只改了一边。
 */
function importErrorsShape(value, errorCount) {
  if (value === 'unknown') return errorCount === null;
  if (!Array.isArray(value) || value.length > 50 || value.length !== errorCount) return false;
  const nullableText = (entry, max) => entry === null
    || typeof entry === 'string' && entry.length > 0 && entry.length <= max;
  return value.every(entry => exact(entry, ['code','message','state','level','field','attributeId','attributeName'])
    && nullableText(entry.code,128) && nullableText(entry.message,512) && nullableText(entry.state,128)
    && nullableText(entry.level,64) && nullableText(entry.field,128) && nullableText(entry.attributeName,256)
    && (entry.attributeId === null || Number.isSafeInteger(entry.attributeId)));
}

export function registerOwnerWrittenInventoryInDocument({document,job,observationJobId,observedAt,verifyInventoryPrerequisiteSource,actorId}) {
  const current = assertDRemainingInventoryContinuation({document,job,observationJobId,checkedAt:observedAt,verifyInventoryPrerequisiteSource});
  const {continuation:c,state,request,candidate,prerequisites} = current;
  requireCondition(isCanonicalFrozenRef(actorId), 'OWNER_STOCK_ACTOR_INVALID');
  const authorizedStock = request.inventoryWrite.stock;
  const observed = observedWarehouseAvailableStock(prerequisites.inventoryPrerequisiteObservation.inventoryObservation,
    request.inventoryWrite.warehouseId, {productId:c.productId, offerId:request.merchantSku});
  requireCondition(observed !== 'unknown' && observed === authorizedStock, 'OWNER_STOCK_NOT_AUTHORIZED_VALUE');
  const existing = candidate.lifecycleV11[D_OWNER_STOCK_REGISTRATION_FIELD] ?? [];
  // 同一个导入任务只登记一次。
  requireCondition(!existing.some(entry=>entry.taskId === c.taskId), 'OWNER_STOCK_ALREADY_REGISTERED');
  const lastObservation = c.observationHistory.at(-1);
  const registration = {schemaVersion:'d-owner-stock-registration-v1', taskId:c.taskId, productId:c.productId,
    merchantSku:request.merchantSku, warehouseId:request.inventoryWrite.warehouseId,
    authorizedStock, observedStock:observed, stockSource:'owner_manual',
    observationJobId, observationFingerprint:fingerprintCanonicalRecord(lastObservation),
    requestReceiptRef:c.requestReceiptRef, registeredByActorId:actorId, registeredAt:observedAt};
  candidate.lifecycleV11[D_OWNER_STOCK_REGISTRATION_FIELD] = [...existing, registration];
  // 与 resumeDRemainingInventoryInDocument:198-201 同样把「导入结果已观察」落成 checkpoint：
  // 商品确实是本轮导入建的，product_id 是真读到的，这一条必须留痕。
  const imported = c.observationHistory.find(value=>value.queryKind === 'import_task' && value.result.classification === 'imported');
  let importCheckpoint = imported ? {...clone(imported.result.importObservation),observedAt:imported.observedAt} : null;
  if (!imported && dPlatformStateReconciliationsFor(candidate, c.taskId).some(entry=>entry.productId === c.productId)) {
    // 按平台现状收口：导入任务已经读不到，这一格由价格那次只读查询核实的商品现状落——
    // 同一商品号、同一货号、0 错误、未归档、价格已生效（adapter observePriceSent），并指向那次查询的回执。
    const price = c.observationHistory.findLast(value=>value.queryKind === 'price_state' && value.result.priceSent === 'verified');
    if (price) importCheckpoint = {kind:'import_result_observed',taskId:c.taskId,productId:c.productId,
      merchantSku:request.merchantSku,itemCount:1,status:'imported',errorCount:0,
      requestReceiptRef:price.result.requestReceiptRef,observedAt:price.observedAt};
  }
  requireCondition(importCheckpoint && state.checkpoints.length === 2, 'OWNER_STOCK_IMPORT_SOURCE_CONFLICT');
  state.checkpoints.push(importCheckpoint);
  state.step = 'import_result_observed';
  state.executionRevision += 1;
  c.status = 'owner_stock_registered';
  c.inventoryWriteState = 'not_sent';
  state.attempt.platformContinuation = clone(c);
  state.status = 'succeeded'; state.attempt.status = 'succeeded';
  state.settledAt = observedAt; state.attempt.completedAt = observedAt;
  state.continuationBlocked = false;
  // 生产记录保持 null；平台写入次数仍是 1（只有那一次导入）。
  return readDOwnerStockRegisteredJobTerminal({candidate,job,observedAt});
}

/** 登记档的终态：作业 completed，但回执里明说没有库存写入回执、没有生产记录、不排 E。 */
export function readDOwnerStockRegisteredJobTerminal({candidate,job,observedAt}) {
  const state=candidate?.lifecycleV11?.skuPackage?.dSoftwareExecution,c=state?.platformContinuation;
  const registrations=candidate?.lifecycleV11?.[D_OWNER_STOCK_REGISTRATION_FIELD] ?? [];
  const registration=registrations.at(-1);
  requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && c?.schemaVersion === 'd-platform-continuation-v1' &&
    c.status === 'owner_stock_registered' && c.inventoryWriteState === 'not_sent' &&
    state.status === 'succeeded' && state.attempt.status === 'succeeded' &&
    state.checkpoints.length === 3 && state.checkpoints[0].kind === 'import_intent' &&
    state.checkpoints[1].kind === 'import_task_received' && state.checkpoints[1].taskId === c.taskId &&
    state.platformWrites === 1 && state.softwareJobRef.jobId === job.jobId &&
    state.executionKey === state.attempt.request.executionKey &&
    state.attempt.request.sourceAuthorizationFingerprint === job.scopeBinding.authorizationFingerprint &&
    // 这一档的要害：两处生产记录都必须是空的。
    state.attempt.productionRecord === null && candidate.lifecycleV11.skuPackage.productionRecord === null &&
    registration?.taskId === c.taskId && registration.stockSource === 'owner_manual' &&
    time(state.settledAt) && time(observedAt) && Date.parse(observedAt)>=Date.parse(state.settledAt),
    'OWNER_STOCK_SOURCE_INVALID');
  decodeAttempt(state.attempt);
  const payload={schemaVersion:'d-owner-stock-registered-job-result-v1', sourceExecutionKey:state.executionKey,
    taskId:c.taskId, productId:c.productId, requestReceiptRef:c.requestReceiptRef,
    stockSource:'owner_manual', observedStock:registration.observedStock, authorizedStock:registration.authorizedStock,
    observationFingerprint:registration.observationFingerprint,
    inventoryWriteState:'not_sent', inventoryReceiptRef:null, productionRecordCreated:false, eReadbackQueued:false};
  return {status:'completed', externalRequestState:'succeeded', failureClass:null, payload,
    applicationDisposition:'applied', eScope:null};
}

/**
 * 库存续写前的三岔判定，口径集中在这里，调用方不自己解码观察结果。
 *   observed === 授权锁定值  → 'register'        主人已经填好，只登记不写
 *   observed === 0          → 'software_write'  仍是空的，走软件写入
 *   其他任何数               → 'mismatch'        停下报主人，不覆盖、不重写
 */
export function readOwnerStockDecision({document,job,observationJobId,checkedAt,verifyInventoryPrerequisiteSource}) {
  const current = assertDRemainingInventoryContinuation({document,job,observationJobId,checkedAt,verifyInventoryPrerequisiteSource});
  const {continuation:c,request,prerequisites} = current;
  const authorizedStock = request.inventoryWrite.stock;
  const observed = observedWarehouseAvailableStock(prerequisites.inventoryPrerequisiteObservation.inventoryObservation,
    request.inventoryWrite.warehouseId, {productId:c.productId, offerId:request.merchantSku});
  if (observed === 'unknown') return {decision:'mismatch', observed, authorizedStock};
  if (observed === authorizedStock) return {decision:'register', observed, authorizedStock};
  // 走过「按平台现状收口」的这一轮只许登记：回读到 0 也停下报主人，不由软件写。
  if (observed === 0 && dPlatformStateReconciliationsFor(current.candidate, c.taskId).length === 0) {
    return {decision:'software_write', observed, authorizedStock};
  }
  return {decision:'mismatch', observed, authorizedStock};
}

export const D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD = 'dUnknownOutcomeReobservationV1';

/**
 * 「按新分类重新观察一次」——主人显式点击的收口动作。
 *
 * 由来：2026-09-24 背心的导入被平台接受（商品号 6440150538 已建出），但导入任务上挂了 2 条错误。
 * 当时的判定是「errors 非空即结果未知」，**完全不看级别**，于是停在 unknown_outcome。
 * r70 改成按级别分类（只有 ERROR_LEVEL_WARNING 算警告）之后，同一份平台事实可能得出不同结论，
 * 所以要给已经停住的执行一次**重新观察**的机会。
 *
 * 硬要求：
 *  - 只读。这里不发任何请求，只把状态放回「等待观察」，由观察作业去做一次受控只读查询。
 *  - 幂等：同一个 taskId 只能重新观察一次（再要就得主人另起一轮）。
 *  - 不重发导入、不写库存、不生成生产记录、不改授权。
 *  - 只受理「因导入任务带错误而停」这一档；别的停止原因不归它管。
 */
export function reobserveDUnknownOutcomeInDocument({document,job,observedAt,actorId,policy,reobservationId}) {
  const candidate=document.candidates.find(value=>value.id === job.candidateId);
  requireCondition(job.jobType === 'd_production_execution' && job.status === 'unknown_outcome' &&
    job.externalRequestState === 'unknown_outcome' && job.failureClass === 'd-platform-unknown-outcome' &&
    typeof actorId === 'string' && actorId.trim().length > 0 &&
    typeof reobservationId === 'string' && reobservationId.trim().length > 0, 'REOBSERVE_SOURCE_INVALID');
  const sku=candidate?.lifecycleV11?.skuPackage,state=sku?.dSoftwareExecution,c=state?.platformContinuation;
  requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && state.status === 'unknown_outcome' &&
    state.attempt?.status === 'unknown_outcome' && c?.status === 'unknown_outcome' &&
    c.inventoryWriteState === 'not_sent' && sku.productionRecord === null && state.attempt.productionRecord === null &&
    state.platformWrites === 1 && state.softwareJobRef?.jobId === job.jobId, 'REOBSERVE_STATE_INVALID');
  // 只受理「导入任务带错误」这一档，并且平台确实已经把商品建出来了（有 product_id）。
  const last=c.observationHistory.at(-1);
  requireCondition(last?.queryKind === 'import_task' && last.result?.gapCode === 'import_task_errors_present' &&
    last.result.importObservation?.status === 'imported' && id(last.result.importObservation.productId),
    'REOBSERVE_NOT_ERRORS_PRESENT');
  assertDPlatformObservationPolicy(policy);
  requireCondition(Date.parse(policy.expiresAt)-Date.parse(observedAt) >= policy.maxQueries*policy.intervalMs,
    'REOBSERVE_POLICY_WINDOW_INVALID');
  const archive={schemaVersion:'d-unknown-outcome-reobservation-v1',reobservationId,reobservedAt:observedAt,
    reobservedByActorId:actorId,taskId:c.taskId,productId:last.result.importObservation.productId,
    sourceDJobId:job.jobId,priorClassification:last.result.classification,priorGapCode:last.result.gapCode,
    priorErrorCount:last.result.importObservation.errorCount,
    // 错误明细**不复制进归档**：它留在 observationHistory 里（那是追加的，重新观察不会覆盖），
    // 这里只留指针。r67 归档嵌实体正文被实体归一化拒绝过一次，同一个教训不重复。
    priorObservationJobId:last.jobId,priorObservationFingerprint:fingerprintCanonicalRecord(last),
    priorAttemptReason:state.attempt.reason??null,priorSettledAt:state.settledAt,
    policyRef:policy.policyRef,policyVersion:policy.version,policyExpiresAt:policy.expiresAt};
  const existing=candidate.lifecycleV11[D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD] ?? [];
  requireCondition(!existing.some(entry=>entry.taskId === archive.taskId), 'REOBSERVE_ALREADY_DONE');
  candidate.lifecycleV11[D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD]=[...existing,archive];
  state.status='waiting_platform';state.attempt.status='waiting_platform';
  state.attempt.reason=null;state.attempt.failure=null;state.attempt.completedAt=null;
  state.continuationBlocked=false;state.blockReason=null;
  c.status='waiting_import';
  state.attempt.platformContinuation=clone(c);
  state.settledAt=observedAt;
  return {archive,candidate,state};
}

export const D_PLATFORM_STATE_RECONCILIATION_FIELD = 'dPlatformStateReconciliationV1';
export const D_PLATFORM_STATE_RECONCILIATION_LIMIT = 3;

/** 这一轮导入任务曾经读到「已导入、平台给了商品号」的那一次观察（取最近一次）。 */
export function importedProductObservation(continuation) {
  return continuation?.observationHistory?.findLast(entry => entry.queryKind === 'import_task' &&
    entry.result?.importObservation?.status === 'imported' && id(entry.result.importObservation.productId)) ?? null;
}

/** 这个导入任务走过的「按平台现状收口」。走过的话，库存只许登记成主人填写，回读到 0 也不由软件写。 */
export function dPlatformStateReconciliationsFor(candidate, taskId) {
  return (candidate?.lifecycleV11?.[D_PLATFORM_STATE_RECONCILIATION_FIELD] ?? []).filter(entry => entry.taskId === taskId);
}

/**
 * 「按平台现状收口」——主人显式点击的收口动作。
 *
 * 由来：2026-09-24 背心的导入被平台接受（商品号 6440150538 已建出），导入任务上挂了 2 条错误，停在 unknown_outcome。
 * 之后商品在平台上审核通过、在售、0 错误，库存是主人在后台填的（与授权锁定值相同）。
 * 「按新分类重新观察一次」要重读那个导入任务，可 Ozon 只保留导入任务一段时间，过期后读不到，
 * 重新观察只会再判一次 unknown_outcome，而且同一个任务号只能重新观察一次。
 *
 * 这里不再读导入任务，改读平台上这件商品的现状：
 *  - 用观察记录里平台已经给出的商品号，接着走价格、库存两次只读查询（同一条观察链、同一份策略和预算）；
 *  - 商品号、货号、0 错误、未归档、价格已生效由价格那次查询核实，核实不了就照旧停在 unknown_outcome；
 *  - 库存只认「回读值 === 授权锁定值」→ 登记为主人填写；回读到 0 也**不由软件写**，和其他不一致一样停下报主人。
 * 只读：这一步本身不发请求，不重发导入、不写库存、不生成生产记录、不改授权。
 * 只读查询没有副作用，所以核实不了时主人可以再点，但同一个导入任务最多 D_PLATFORM_STATE_RECONCILIATION_LIMIT 次。
 */
export function reconcileDUnknownOutcomeFromPlatformStateInDocument({document,job,observedAt,actorId,policy,reconciliationId}) {
  const candidate=document.candidates.find(value=>value.id === job.candidateId);
  requireCondition(job.jobType === 'd_production_execution' && job.status === 'unknown_outcome' &&
    job.externalRequestState === 'unknown_outcome' && job.failureClass === 'd-platform-unknown-outcome' &&
    typeof actorId === 'string' && actorId.trim().length > 0 &&
    typeof reconciliationId === 'string' && reconciliationId.trim().length > 0 && time(observedAt), 'RECONCILE_SOURCE_INVALID');
  const sku=candidate?.lifecycleV11?.skuPackage,state=sku?.dSoftwareExecution,c=state?.platformContinuation;
  requireCondition(state?.schemaVersion === 'd-software-execution-state-v2' && state.status === 'unknown_outcome' &&
    state.attempt?.status === 'unknown_outcome' && c?.status === 'unknown_outcome' &&
    c.inventoryWriteState === 'not_sent' && sku.productionRecord === null && state.attempt.productionRecord === null &&
    state.platformWrites === 1 && state.softwareJobRef?.jobId === job.jobId && state.checkpoints.length === 2, 'RECONCILE_STATE_INVALID');
  // 平台必须已经把商品建出来过：观察记录里有「已导入 + 商品号」的那一次。
  const imported=importedProductObservation(c);
  requireCondition(imported !== null && (c.productId === null || c.productId === imported.result.importObservation.productId),
    'RECONCILE_NO_PLATFORM_PRODUCT');
  assertDPlatformObservationPolicy(policy);
  requireCondition(c.policy === null || isDeepStrictEqual(c.policy,policy), 'RECONCILE_POLICY_CONFLICT');
  // 价格、库存两次查询都要盖得住。
  requireCondition(c.queryCount + 2 <= policy.maxQueries &&
    Date.parse(policy.expiresAt)-Date.parse(observedAt) >= 2*policy.intervalMs, 'RECONCILE_POLICY_WINDOW_INVALID');
  const previous=dPlatformStateReconciliationsFor(candidate,c.taskId);
  requireCondition(previous.length < D_PLATFORM_STATE_RECONCILIATION_LIMIT, 'RECONCILE_LIMIT_REACHED');
  requireCondition(!previous.some(entry=>entry.reconciliationId === reconciliationId), 'RECONCILE_ALREADY_DONE');
  const last=c.observationHistory.at(-1);
  const productId=imported.result.importObservation.productId;
  const archive={schemaVersion:'d-platform-state-reconciliation-v1',reconciliationId,reconciledAt:observedAt,
    reconciledByActorId:actorId,taskId:c.taskId,productId,sourceDJobId:job.jobId,
    priorQueryKind:last?.queryKind ?? null,priorClassification:last?.result?.classification ?? null,priorGapCode:last?.result?.gapCode ?? null,
    // 明细不复制进归档，只留指针（同 reobserve 的教训）。
    importObservationJobId:imported.jobId,importObservationFingerprint:fingerprintCanonicalRecord(imported),
    priorAttemptReason:state.attempt.reason??null,priorSettledAt:state.settledAt,
    inventoryWrite:'owner_registration_only',
    policyRef:policy.policyRef,policyVersion:policy.version,policyExpiresAt:policy.expiresAt};
  candidate.lifecycleV11[D_PLATFORM_STATE_RECONCILIATION_FIELD]=[...(candidate.lifecycleV11[D_PLATFORM_STATE_RECONCILIATION_FIELD] ?? []),archive];
  state.status='waiting_platform';state.attempt.status='waiting_platform';
  state.attempt.reason=null;state.attempt.failure=null;state.attempt.completedAt=null;
  state.continuationBlocked=false;state.blockReason=null;
  // 不读导入任务：直接从「平台已给商品号」那一格接着读价格。
  c.productId=productId;c.status='waiting_price';
  state.attempt.platformContinuation=clone(c);
  state.settledAt=observedAt;
  return {archive,candidate,state};
}
