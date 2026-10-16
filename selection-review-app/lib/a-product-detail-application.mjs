import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeBusinessMutationCandidate, sameTeamUser } from './runtime-identity.mjs';
import { AProductDetailError, assertAProductDetailSource, assertAProductDetailReceipt,
  assertAProductDetailAuthorization, assertAProductDetailCredential, nextAProductDetailRequest } from './a-product-detail-contract.mjs';
import { assertCompletedAProductDetailJobResult } from './software-job-contract.mjs';
import { readCompletedADiscoveryBatch } from './a-discovery-candidate-import.mjs';
import { buildAProductDetailCandidateEvidence } from './a-product-detail-evidence.mjs';
import { waitForOwner } from './software-execution-state.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (condition, code) => { if (!condition) throw new AProductDetailError(code); };

export function assertAProductDetailApplicationRecord(record, { candidateId, sourceRevision }) {
  const fields = ['schemaVersion','candidateId','sourceRevision','resultRevision','status','recordedAt',
    'sourceJobIds','salesSnapshotId','supplierOptionId','failureClass'];
  check(object(record) && Object.keys(record).length === fields.length && fields.every(key=>Object.hasOwn(record,key)) &&
    record.schemaVersion === 'a-product-detail-application-v1' && record.candidateId === candidateId &&
    isCanonicalFrozenRef(candidateId) && record.sourceRevision === sourceRevision && Number.isSafeInteger(sourceRevision) && sourceRevision >= 0 &&
    typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt)) &&
    ['applied','blocked','failed'].includes(record.status) && Array.isArray(record.sourceJobIds) && record.sourceJobIds.length <= 2 &&
    record.sourceJobIds.every(isCanonicalFrozenRef) && new Set(record.sourceJobIds).size === record.sourceJobIds.length, 'APPLICATION_RECORD_INVALID');
  if (record.status === 'applied') {
    check(record.resultRevision === sourceRevision + 1 && Number.isSafeInteger(record.resultRevision) && record.sourceJobIds.length === 2 &&
      isCanonicalFrozenRef(record.salesSnapshotId) && isCanonicalFrozenRef(record.supplierOptionId) && record.failureClass === null, 'APPLICATION_RECORD_INVALID');
  } else {
    check(record.resultRevision === null && record.salesSnapshotId === null && record.supplierOptionId === null &&
      isCanonicalFrozenRef(record.failureClass), 'APPLICATION_RECORD_INVALID');
  }
  return structuredClone(record);
}

function applications(document) {
  check(object(document.runtime), 'APPLICATION_REPOSITORY_INVALID');
  if (!Object.hasOwn(document.runtime,'aProductDetailApplications')) document.runtime.aProductDetailApplications = {};
  check(object(document.runtime.aProductDetailApplications), 'APPLICATION_REPOSITORY_INVALID');
  return document.runtime.aProductDetailApplications;
}

export function readCompletedAProductDetails({document,candidateId,sourceRevision}) {
  check(Array.isArray(document.candidates) && Array.isArray(document.runtime.softwareJobs) &&
    object(document.runtime.aProductDetailReceipts) && Array.isArray(document.runtime.softwareJobAuthorizationRecords) &&
    Array.isArray(document.runtime.softwareJobCredentialBindings), 'APPLICATION_SOURCE_INVALID');
  const candidates = document.candidates.filter(value=>value.id===candidateId);
  check(candidates.length === 1, 'CANDIDATE_REQUIRED');
  const candidate = candidates[0];
  check(candidate.dataRevision === sourceRevision && candidate.aProductDetailEvidenceV1 === undefined &&
    (candidate.supplierOptionsV11 === undefined || Array.isArray(candidate.supplierOptionsV11) && candidate.supplierOptionsV11.length === 0), 'CANDIDATE_CHANGED');
  const jobs = document.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read' &&
    job.subject?.candidateId===candidateId && job.revision===sourceRevision).sort((a,b)=>a.scopeBinding.requestIndex-b.scopeBinding.requestIndex);
  check(jobs.length === 2, 'APPLICATION_SOURCE_INCOMPLETE');
  const receipts = jobs.map((job,index)=>{
    const receipt = assertAProductDetailReceipt(document.runtime.aProductDetailReceipts[job.jobId],job);
    const {batch} = assertAProductDetailSource({document,candidate,scope:receipt.scope});
    check(receipt.scope.requestIndex===index && receipt.status==='completed' && job.status==='completed' &&
      job.externalRequestState==='succeeded' && receipt.steps[0].result.status==='observed' &&
      job.requestedByUserId===job.ownerUserId && sameTeamUser(job.ownerUserId,batch.ownerUserId), 'APPLICATION_SOURCE_INCOMPLETE');
    assertCompletedAProductDetailJobResult({job,receipt});
    const permits = document.runtime.softwareJobAuthorizationRecords.filter(value=>value.authorizationId===receipt.scope.authorizationRef);
    const credentials = document.runtime.softwareJobCredentialBindings.filter(value=>value.sideEffectScope===job.jobType &&
      value.scopeBinding?.authorizationRef===receipt.scope.authorizationRef);
    check(permits.length===1 && credentials.length===1, 'APPLICATION_PERMISSION_CONFLICT');
    const permit=assertAProductDetailAuthorization(permits[0]),credential=assertAProductDetailCredential(credentials[0]);
    check(isDeepStrictEqual(permit.scopeBinding,receipt.scope) && isDeepStrictEqual(credential.scopeBinding,receipt.scope) &&
      permit.authorizedByUserId===job.ownerUserId && permit.useCount===1 && permit.consumedByJobId===job.jobId &&
      credential.allowedWorkerIds.includes(job.workerId) && Date.parse(permit.authorizedAt)<=Date.parse(receipt.startedAt) &&
      Date.parse(credential.boundAt)<=Date.parse(receipt.startedAt) && Date.parse(receipt.completedAt)<Date.parse(permit.expiresAt) &&
      Date.parse(receipt.completedAt)<Date.parse(credential.expiresAt), 'APPLICATION_PERMISSION_CONFLICT');
    return receipt;
  });
  nextAProductDetailRequest({candidate,scope:receipts[0].scope,receipts});
  const source=receipts[0].scope.discoverySource;
  readCompletedADiscoveryBatch({document,batchId:source.batchId,revision:source.batchRevision});
  return {candidate,jobs,receipts};
}

/** Both paid observations are committed already. This single transaction only prepares the existing A card. */
export function createAProductDetailApplicationUseCase({repository,serverClock}) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock!=='function') throw new TypeError('A_PRODUCT_DETAIL_APPLICATION_CLOCK_REQUIRED');
  return Object.freeze({async applyDetails({candidateId,sourceRevision}) {
    check(isCanonicalFrozenRef(candidateId) && Number.isSafeInteger(sourceRevision) && sourceRevision>=0, 'APPLICATION_INPUT_INVALID');
    const recordedAt=serverClock(),key=`${candidateId}:${sourceRevision}`;
    if(typeof recordedAt!=='string'||!Number.isFinite(Date.parse(recordedAt))) throw new TypeError('A_PRODUCT_DETAIL_APPLICATION_CLOCK_INVALID');
    const base={schemaVersion:'a-product-detail-application-v1',candidateId,sourceRevision,resultRevision:null,status:'failed',recordedAt,
      sourceJobIds:[],salesSnapshotId:null,supplierOptionId:null,failureClass:null};
    let originalError,hasOriginalError=false;
    const result=await repository.transact(document=>{
      const saved=applications(document)[key];
      if(saved!==undefined)return {changed:false,result:assertAProductDetailApplicationRecord(saved,{candidateId,sourceRevision})};
      let record;
      try {
        const {candidate,jobs,receipts}=readCompletedAProductDetails({document,candidateId,sourceRevision});
        const resultRevision=sourceRevision+1;
        const {evidence,salesSnapshot,supplierOption}=buildAProductDetailCandidateEvidence({candidateId,sourceRevision,resultRevision,
          marketReceipt:receipts[0],supplierReceipt:receipts[1]});
        check(salesSnapshot!==null && supplierOption!==null, 'APPLICATION_FACTS_INCOMPLETE');
        const updated=structuredClone(candidate);
        updated.dataRevision=resultRevision; updated.updatedAt=recordedAt;
        updated.salesSnapshotsV11=[salesSnapshot]; updated.supplierOptionsV11=[supplierOption]; updated.aProductDetailEvidenceV1=evidence;
        updated.sourceUrl=supplierOption.productUrl;
        updated.executionRuntime=waitForOwner({...updated.executionRuntime,dataRevision:resultRevision},{
          stepId:'A_WAITING_OWNER_SUPPLY_CONFIRMATION',inputRevision:resultRevision,at:recordedAt,
          detail:'详情证据已保存，等待核对同款、具体供应SKU、成本与包装。'});
        updated.history.push({id:`history:${randomUUID()}`,actor:'software',action:'product_details_applied',
          detail:'两份详情证据已保存，等待主人核对同款并在A卡选择具体供应SKU、确认成本与包装。',at:recordedAt});
        assertSafeBusinessMutationCandidate(updated);
        record=assertAProductDetailApplicationRecord({...base,status:'applied',resultRevision,sourceJobIds:jobs.map(job=>job.jobId),
          salesSnapshotId:salesSnapshot.snapshotId,supplierOptionId:supplierOption.supplierOptionId},{candidateId,sourceRevision});
        document.candidates[document.candidates.indexOf(candidate)]=updated;
      } catch(error) {
        record={...base,status:error instanceof AProductDetailError?'blocked':'failed',
          failureClass:error instanceof AProductDetailError?error.code:'UNEXPECTED_SYSTEM_ERROR'};
        if(!(error instanceof AProductDetailError)){originalError=error;hasOriginalError=true;}
      }
      applications(document)[key]=assertAProductDetailApplicationRecord(record,{candidateId,sourceRevision});
      return {changed:true,document,result:structuredClone(record)};
    });
    if(hasOriginalError)throw originalError;
    return result;
  }});
}
