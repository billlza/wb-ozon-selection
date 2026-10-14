import { isDeepStrictEqual } from 'node:util';
import { ADiscoveryError, A_DISCOVERY_FAILURE_CLASSES, assertADiscoveryScope, assertADiscoveryReceipt,
  isSeerfarADiscoveryScope } from './a-discovery-contract.mjs';
import { assertSeerfarDiscoveryBinding, resolveSeerfarDiscoveryEvidence, SeerfarDiscoveryContractError,
  SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES, SEERFAR_MARKET_RESULT_SCHEMA_VERSION } from './seerfar-discovery-contract.mjs';
import { ADiscoveryExecutionBlockedError } from './software-job-repository.mjs';
import { createSeerfarRuntimeTransport } from './seerfar-runtime-connector.mjs';
import { SeerfarTransportError } from './seerfar-open-api-transport.mjs';

const METHODS = Object.freeze(['quota_before', 'category_detail', 'quota_after']);
const TERMINAL = new Set(['completed', 'failed', 'unknown_outcome']);
const clone = value => structuredClone(value);
const requireValue = (value, code) => { if (!value) throw new ADiscoveryError(code); };
const failureCodes = Object.freeze({ credential_missing:'CREDENTIAL_MISSING', credential_access_denied:'CREDENTIAL_UNAVAILABLE',
  network_timeout:'TIMEOUT', network_error:'NETWORK_FAILED', schema_error:'RESPONSE_INVALID', login_required:'AUTHENTICATION_REQUIRED',
  quota_or_rate_limit:'RATE_LIMITED', provider_server_error:'PROVIDER_FAILED', stale_result:'RESPONSE_INVALID' });
function newStep(method, at) {
  return {method,intentAt:at,sentAt:null,completedAt:null,externalRequestState:'not_sent',requestTransmission:'not_attempted',result:null,errorCode:null};
}
function held(document, jobId, workerId, leaseId) {
  const job = document.runtime.softwareJobs.find(value => value.jobId === jobId);
  requireValue(job && job.workerId === workerId && job.leaseId === leaseId, 'JOB_SOURCE_CONFLICT');
  assertADiscoveryScope(job.scopeBinding, job);
  const receipt = document.runtime.aDiscoveryReceipts[jobId];
  return {job,receipt};
}
function stepResult(observation, scope) {
  const base = {provider:'seerfar',requestId:observation.requestId,observedAt:observation.completedAt,evidenceRef:observation.evidenceRef};
  if (observation.step !== 'category_detail') {
    requireValue(Number.isFinite(observation.remainingPoints) && observation.remainingPoints >= 0, 'QUOTA_INVALID');
    return {schemaVersion:'seerfar-discovery-quota-result-v1',...base,remainingPoints:observation.remainingPoints};
  }
  requireValue(Array.isArray(observation.marketProducts), 'RESPONSE_INVALID');
  // The saved result states the owner's conditions back; the contract rejects an echo that differs from
  // the authorized request, so a filtered page can never be saved as if it were the whole category.
  return {schemaVersion:SEERFAR_MARKET_RESULT_SCHEMA_VERSION,...base,requestId:scope.request.requestId,
    contractVersion:scope.contractVersion,platform:scope.request.platform,categoryId:scope.request.categoryId,
    fulfillment:scope.request.fulfillment,status:observation.marketProducts.length ? 'candidates_found' : 'true_empty',
    products:clone(observation.marketProducts),dateRange:clone(observation.dateRange),
    appliedFilters:clone(observation.appliedFilters ?? null),collection:clone(observation.collection)};
}

/** One consumed authorization owns the ordered three-request transaction. Each step is durable before sending. */
export async function runSeerfarDiscoverySoftwareJob({repository,softwareJobStore,worker,jobId,leaseId,leaseDurationMs,
  connectorBinding,getEvidenceRecords=()=>[],readSecret,fetchImpl,serverClock,sleep,signal}) {
  requireValue(typeof repository?.transact === 'function' && typeof serverClock === 'function' &&
    typeof readSecret === 'function' && typeof fetchImpl === 'function', 'RUNNER_DEPENDENCY_INVALID');
  requireValue(typeof getEvidenceRecords==='function','RUNNER_DEPENDENCY_INVALID');
  const binding = assertSeerfarDiscoveryBinding(connectorBinding), queued = await softwareJobStore.get(jobId);
  requireValue(queued && isSeerfarADiscoveryScope(queued.scopeBinding), 'JOB_SOURCE_CONFLICT');
  const scope = assertADiscoveryScope(queued.scopeBinding, queued);
  requireValue(['bindingId','configurationVersion','credentialAlias','budgetPolicyRef','contractVersion','provider']
    .every(key => scope[key] === binding[key]), 'BINDING_INVALID');
  if (queued.status !== 'queued') return {status:'idempotent_replay',jobId,executionStatus:queued.status,externalRequests:0,platformWrites:0};
  const assertCurrentEvidence=()=>resolveSeerfarDiscoveryEvidence({records:getEvidenceRecords(),request:scope.request,budget:scope.budget,now:serverClock()});
  assertCurrentEvidence();
  const claimed = await softwareJobStore.claim({jobId,worker,leaseId,leaseDurationMs});
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  let externalRequests = 0, currentIndex = -1, beforePoints = null;
  const attempts = METHODS.map(() => ({attempted:false,responseReceived:false}));
  await repository.transact(document => {
    const {job} = held(document,jobId,worker.workerId,leaseId), at = serverClock();
    requireValue(!Object.hasOwn(document.runtime.aDiscoveryReceipts,jobId), 'ALREADY_ATTEMPTED');
    document.runtime.aDiscoveryReceipts[jobId] = assertADiscoveryReceipt({schemaVersion:'a-discovery-receipt-v2',
      receiptId:`a-discovery-receipt:${jobId}`,jobId,scope:clone(scope),workerId:worker.workerId,leaseId,
      startedAt:at,completedAt:null,status:'in_flight',failureClass:null,steps:[]},job);
    return {changed:true,document,result:null};
  });
  async function guard(stage = null, markAttempt = false) {
    return repository.transact(document => {
      requireValue(!controller.signal.aborted, 'CANCELLED');
      assertCurrentEvidence();
      const {job,receipt} = held(document,jobId,worker.workerId,leaseId), at = serverClock();
      requireValue(!TERMINAL.has(job.status) && receipt.status === 'in_flight', 'CANCELLED');
      if (stage !== null) {
        requireValue(METHODS[receipt.steps.length] === stage && receipt.steps.every(step => step.externalRequestState === 'succeeded'), 'ALREADY_ATTEMPTED');
        receipt.steps.push(newStep(stage,at));
      }
      const checked = softwareJobStore.assertADiscoveryExecutionInDocument({document,jobId,workerId:worker.workerId,leaseId,
        observedAt:at,markRequestSent:stage !== null,requestStep:stage});
      if (stage !== null) {
        const step = receipt.steps.at(-1);
        step.sentAt=at;step.externalRequestState='in_flight';step.requestTransmission='unknown';
      }
      if (markAttempt) {
        const step=receipt.steps[currentIndex];
        requireValue(step && step.externalRequestState === 'in_flight' && step.requestTransmission === 'unknown', 'ALREADY_ATTEMPTED');
        step.requestTransmission='attempted';
      }
      assertADiscoveryReceipt(receipt,checked.job);
      return {changed:stage !== null || markAttempt,...(stage !== null || markAttempt ? {document} : {}),result:null};
    });
  }
  async function saveStep(observation) {
    requireValue(observation.step === METHODS[currentIndex], 'RESPONSE_INVALID');
    const result = stepResult(observation,scope);
    const saved = await repository.transact(document => {
      const {job,receipt:savedReceipt} = held(document,jobId,worker.workerId,leaseId);
      const receipt=assertADiscoveryReceipt(savedReceipt,job),step=receipt.steps[currentIndex];
      requireValue(step && step.sentAt !== null, 'RECEIPT_SOURCE_CONFLICT');
      if (TERMINAL.has(job.status)) {
        requireValue(job.status === 'unknown_outcome' && receipt.status === 'unknown_outcome' &&
          step.externalRequestState === 'unknown_outcome', 'CANCELLED');
        const lateResult={recordedAt:serverClock(),stepIndex:currentIndex,result};
        if (receipt.lateResult !== undefined) {
          requireValue(isDeepStrictEqual(receipt.lateResult.result,result) && receipt.lateResult.stepIndex === currentIndex, 'LATE_RESULT_INVALID');
          return {changed:false,result:false};
        }
        receipt.lateResult=lateResult;
        document.runtime.aDiscoveryReceipts[jobId]=assertADiscoveryReceipt(receipt,job);
        return {changed:true,document,result:false};
      }
      requireValue(receipt.status === 'in_flight' && step.externalRequestState === 'in_flight', 'RECEIPT_SOURCE_CONFLICT');
      step.completedAt=serverClock();step.externalRequestState='succeeded';step.requestTransmission='response_received';step.result=result;
      document.runtime.aDiscoveryReceipts[jobId]=assertADiscoveryReceipt(receipt,job);
      return {changed:true,document,result:true};
    });
    requireValue(saved, 'CANCELLED');
    if (observation.step === 'quota_before') {
      beforePoints=result.remainingPoints;
      requireValue(beforePoints >= scope.budget.maxCredits, 'BUDGET_EXCEEDED');
    } else if (observation.step === 'quota_after') {
      requireValue(beforePoints !== null && result.remainingPoints <= beforePoints, 'QUOTA_INVALID');
      requireValue(beforePoints - result.remainingPoints <= scope.budget.maxCredits, 'BUDGET_EXCEEDED');
    }
  }
  async function finish(failureClass = null) {
    return repository.transact(document => {
      const {job,receipt:saved} = held(document,jobId,worker.workerId,leaseId);
      if (TERMINAL.has(job.status)) return {changed:false,result:{status:'idempotent_replay',jobId,executionStatus:job.status,externalRequests,platformWrites:0}};
      const receipt=assertADiscoveryReceipt(saved,job),at=serverClock();
      let terminalFailure = failureClass ?? (controller.signal.aborted ? 'CANCELLED' :
        Date.parse(at) >= Date.parse(scope.expiresAt) ? 'AUTHORIZATION_EXPIRED' :
        Date.parse(at) >= Date.parse(job.leaseExpiresAt) ? 'LEASE_EXPIRED' : null);
      if(terminalFailure===null){
        try {assertCurrentEvidence();}
        catch(error){if(error instanceof SeerfarDiscoveryContractError&&SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES.includes(error.code))terminalFailure=error.code;else throw error;}
      }
      receipt.completedAt=at;receipt.failureClass=terminalFailure;
      if (terminalFailure === null) {
        requireValue(receipt.steps.length === 3 && receipt.steps.every(step=>step.externalRequestState === 'succeeded'), 'RECEIPT_RESULT_INVALID');
        receipt.status='completed';
      } else {
        let step=receipt.steps.at(-1);
        if (step?.externalRequestState === 'succeeded' && receipt.steps.length < 3) {
          step=newStep(METHODS[receipt.steps.length],at);receipt.steps.push(step);
        }
        if (step && step.externalRequestState !== 'succeeded') {
          const attempt=attempts[receipt.steps.length-1];
          step.completedAt=at;step.errorCode=terminalFailure;
          step.externalRequestState=step.sentAt===null?'not_sent':attempt.responseReceived?'failed':'unknown_outcome';
          step.requestTransmission=step.sentAt===null?'not_attempted':attempt.responseReceived?'response_received':attempt.attempted?'attempted':'unknown';
        }
        receipt.status=step?.externalRequestState==='unknown_outcome'?'unknown_outcome':'failed';
      }
      document.runtime.aDiscoveryReceipts[jobId]=assertADiscoveryReceipt(receipt,job);
      const settled=softwareJobStore.settleADiscoveryInDocument({document,jobId,workerId:worker.workerId,leaseId,observedAt:at});
      return {changed:true,document,result:{status:settled.job.status,jobId,job:clone(settled.job),receipt:clone(receipt),
        externalRequests,platformWrites:0,nextJobId:null}};
    });
  }
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort',abort,{once:true});
  try {
    const now=Date.parse(serverClock());
    requireValue(now<Date.parse(scope.expiresAt),'AUTHORIZATION_EXPIRED');
    requireValue(now<Date.parse(claimed.leaseExpiresAt),'LEASE_EXPIRED');
    const transport=createSeerfarRuntimeTransport({
      timeoutMs:Math.min(binding.timeoutMs,Date.parse(scope.expiresAt)-now,Date.parse(claimed.leaseExpiresAt)-now),
      signal:controller.signal,clock:{now:()=>Date.parse(serverClock())},...(sleep ? {sleep} : {}),
      secretReader:async()=>{await guard();return readSecret({credentialAlias:scope.credentialAlias,provider:'seerfar',signal:controller.signal});},
      beforeRequestSend:async({stage})=>{await guard(stage);currentIndex=METHODS.indexOf(stage);},
      onStepResult:saveStep,
      fetchImpl:async(...args)=>{
        await guard(null,true);controller.signal.throwIfAborted();
        attempts[currentIndex].attempted=true;externalRequests+=1;
        const response=await fetchImpl(...args);attempts[currentIndex].responseReceived=true;return response;
      }
    });
    const result=await transport({targetPlatform:scope.request.platform,fulfillment:scope.request.fulfillment,attemptLimit:1,
      seerfarRequest:{operation:'category_detail',platform:scope.request.platform,categoryId:scope.request.categoryId,
        filters:clone(scope.request.filters??null),
        attemptId:jobId,queryId:scope.request.requestId,receiptId:`a-discovery-receipt:${jobId}`,startedAt:serverClock()}});
    if (!result.observation.completed) {
      const code=result.observation.failureKind;
      throw new ADiscoveryError(failureCodes[code] ?? (result.observation.httpStatus === 500 ? 'PROVIDER_FAILED' : 'UNEXPECTED_SYSTEM_ERROR'));
    }
    assertCurrentEvidence();
    return await finish();
  } catch(error) {
    const classified=error instanceof ADiscoveryExecutionBlockedError ? error.failureClass :
      error instanceof SeerfarDiscoveryContractError ? error.code : error instanceof SeerfarTransportError ? failureCodes[error.code] : error instanceof ADiscoveryError ? error.code : null;
    const failureClass=controller.signal.aborted?'CANCELLED':A_DISCOVERY_FAILURE_CLASSES.includes(classified)?classified:'UNEXPECTED_SYSTEM_ERROR';
    const result=await finish(failureClass);
    if(failureClass==='UNEXPECTED_SYSTEM_ERROR')throw error;
    return result;
  } finally { signal?.removeEventListener('abort',abort); }
}
