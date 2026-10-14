import { isDeepStrictEqual } from 'node:util';
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { validatePlatformWritePreflight, assertCurrentPlatformWritePreflight, PLATFORM_WRITE_PREFLIGHT_VERSION } from './platform-write-preflight-contract.mjs';

export const D_PRODUCTION_PREPARATION_VERSION = 'd-production-preparation-v1';
const fields = ['schemaVersion', 'preparationId', 'jobId', 'candidateId', 'skuPackageId', 'revision', 'sourceCandidateRevision',
  'sourceAuthorizationFingerprint', 'sourceProductionPlanId', 'sourceProductionPlanFingerprint', 'workerId', 'leaseId',
  'startedAt', 'completedAt', 'status', 'result', 'continuationBlocked', 'requestMode'];
const historicalFields = fields.filter(field => field !== 'requestMode');
const immutableFields = fields.filter(field => !['completedAt', 'status', 'result', 'continuationBlocked'].includes(field));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const ref = value => isCanonicalFrozenRef(value) && !['unknown', 'null', 'undefined', 'missing', 'not_applicable'].includes(value.toLowerCase());
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function time(value) {
  const parts=typeof value==='string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts || !Number.isFinite(Date.parse(value))) return false;
  const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]);
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
  return day>=1 && day<=days && Number(parts[4])<=23;
}
export class DProductionPreparationError extends Error {
  constructor(code) { super(`D_PRODUCTION_PREPARATION_${code}`); this.name = 'DProductionPreparationError'; this.code = this.message; }
}
function requireValue(value, code) { if (!value) throw new DProductionPreparationError(code); }
function gaps(value) { return Array.isArray(value) && value.length <= 100 && value.every(entry => closed(entry, ['code', 'field', 'message']) && ref(entry.code) && text(entry.field) && text(entry.message, 2048)); }
function safe(value) { assertNoRawPersistenceKeys(value, 'dPreparation'); assertNoProductionSecrets(value, 'dPreparation'); }
function preflightShape(value) {
  function boundedStrings(node) {
    if(typeof node==='string') return text(node,2048);
    if(Array.isArray(node)) return node.length<=100 && node.every(boundedStrings);
    if(object(node)) return Object.values(node).every(boundedStrings);
    return true;
  }
  const keys = ['schemaVersion','preflightId','sourceProductionPlanId','sourceProductionPlanFingerprint','targetPlatform','storeIdentity','permission','connectionStatus','authorizedWriteFields','platformWritableFields','effectiveWritableFields','imagePermission','priceCurrency','risks','technicalStatus','businessStateEffect','checkedAt','readyForPlatformWrite','productCreated','imagesUploaded','inventoryModified','storeDataModified','productionRecordCreated','platformWrites'];
  if (value?.schemaVersion === PLATFORM_WRITE_PREFLIGHT_VERSION) keys.push('connectionRequirements');
  requireValue(closed(value, keys) && boundedStrings(value) && validatePlatformWritePreflight(value).valid, 'PREFLIGHT_INVALID');
  // verifiedVia names the anchor the identity stands on; results written before owner decision 2026-09-16 omit it.
  const identityKeys = ['expectedStore','observedStore','status','evidenceRef','expectedStoreRef','observedStoreRef'];
  requireValue((closed(value.storeIdentity, identityKeys) || closed(value.storeIdentity, [...identityKeys, 'verifiedVia'])) &&
    [value.storeIdentity.expectedStoreRef,value.storeIdentity.observedStoreRef].every(store=>store===null || closed(store,['stableStoreId','platformStoreId','mappingVersion'])) &&
    closed(value.permission, ['status','evidenceRef']) && closed(value.imagePermission, ['status','evidenceRef']) &&
    closed(value.priceCurrency, ['expected','observed','status','evidenceRef']) && closed(value.connectionStatus, ['api','sellerBackend']) &&
    ['api','sellerBackend'].every(key => closed(value.connectionStatus[key], ['status','checkedVia','evidenceRef'])) &&
    value.risks.length <= 100 && value.risks.every(risk => closed(risk, ['code','message']) && ref(risk.code) && text(risk.message, 2048)) &&
    ['authorizedWriteFields','platformWritableFields','effectiveWritableFields'].every(key => value[key].length <= 100 && value[key].every(ref)), 'PREFLIGHT_INVALID');
}
function preparationId(value) {
  // Existing v1 evidence retains its original identity; every newly created intent includes requestMode.
  return `d-preparation:${fingerprintCanonicalRecord(Object.fromEntries(immutableFields.filter(key => key !== 'preparationId' &&
    (key !== 'requestMode' || Object.hasOwn(value, key))).map(key => [key, value[key]])))}`;
}
/** Pure historical shape/source validation. Current candidate, configuration and lease remain locked admission boundaries. */
export function assertDProductionPreparation(evidence, { job } = {}) {
  requireValue((closed(evidence, fields) || closed(evidence, historicalFields)) && evidence.schemaVersion === D_PRODUCTION_PREPARATION_VERSION, 'INVALID');
  requireValue(!Object.hasOwn(evidence, 'requestMode') || ['external_read', 'persisted_evidence_only'].includes(evidence.requestMode), 'REQUEST_MODE_INVALID');
  requireValue(['preparationId','jobId','candidateId','skuPackageId','workerId','leaseId'].every(key => ref(evidence[key])) &&
    integer(evidence.revision) && integer(evidence.sourceCandidateRevision) && evidence.sourceCandidateRevision >= evidence.revision &&
    hash(evidence.sourceAuthorizationFingerprint) && hash(evidence.sourceProductionPlanFingerprint) && text(evidence.sourceProductionPlanId) &&
    time(evidence.startedAt) && typeof evidence.continuationBlocked === 'boolean' && preparationId(evidence) === evidence.preparationId, 'SOURCE_INVALID');
  safe(evidence);
  if (job !== undefined) {
    // 这份证据记的是「当初是谁、用哪个租约做的前检」，是历史事实：workerId/leaseId 都在
    // immutableFields 里、参与 preparationId 指纹，改一个字节 preparationId 就对不上（见上面 SOURCE_INVALID）。
    // 只有**库存续写**这一档允许持有者与当初不同：续写会重新领取、铸出新租约
    // （lease:d-inventory:* vs 准备时的 lease:de:*，前缀由构造决定，永不相等）。
    // 在那一档仍拿历史租约去比当前租约，会让失败档结算整体抛错、事务回滚，失败反而落不了盘。
    // 非续写档照旧逐项比对——parked 作业（leaseId 为 null）若被人删掉 platformContinuation 标记，
    // 必须在这里被挡住。当前持有者另有两道独立断言盯着，闸不放松：
    //   1) d-e-software-job-results.mjs:148 —— state.softwareJobRef 必须逐字段等于作业当前持有者；
    //   2) settleSoftwareJobCore → issuedRequestTerminalTime —— 结算方的 workerId/leaseId
    //      必须等于作业当前持有者，否则 SOFTWARE_JOB_LEASE_REJECTED。
    const continuation = job.platformContinuation?.schemaVersion === 'd-platform-continuation-v1';
    const holderKeys = continuation ? [] : ['workerId', 'leaseId'];
    requireValue(job.jobType === 'd_production_execution' &&
      ['jobId','candidateId','skuPackageId','revision',...holderKeys].every(key => evidence[key] === job[key]) &&
      evidence.sourceAuthorizationFingerprint === job.scopeBinding.authorizationFingerprint, 'JOB_CONFLICT');
  }
  if (evidence.status === 'in_flight') requireValue(evidence.completedAt === null && evidence.result === null && evidence.continuationBlocked === false, 'STATE_INVALID');
  else {
    requireValue(time(evidence.completedAt) && Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt), 'TIME_INVALID');
    if (evidence.status === 'unknown_outcome') requireValue(evidence.result === null && evidence.continuationBlocked, 'STATE_INVALID');
    else {
      requireValue(['ready','not_ready'].includes(evidence.status) && closed(evidence.result, ['platformWritePreflight','capabilities','preparedExecution']), 'STATE_INVALID');
      const { platformWritePreflight: preflight, capabilities, preparedExecution } = evidence.result;
      preflightShape(preflight);
      requireValue(preflight.sourceProductionPlanId === evidence.sourceProductionPlanId && preflight.sourceProductionPlanFingerprint === evidence.sourceProductionPlanFingerprint &&
        preflight.checkedAt === evidence.startedAt && preflight.targetPlatform === 'ozon', 'PREFLIGHT_SOURCE_CONFLICT');
      requireValue(closed(capabilities, ['status','adapterVersion','protocolVersion','inspectedAt','evidenceRef','gaps']) &&
        ['ready','not_ready'].includes(capabilities.status) && ref(capabilities.adapterVersion) && ref(capabilities.protocolVersion) &&
        time(capabilities.inspectedAt) && Date.parse(capabilities.inspectedAt) <= Date.parse(evidence.completedAt) &&
        (capabilities.evidenceRef === null || ref(capabilities.evidenceRef)) && gaps(capabilities.gaps), 'CAPABILITIES_INVALID');
      requireValue(closed(preparedExecution, ['status','gaps']) && preparedExecution.status === evidence.status && gaps(preparedExecution.gaps) &&
        (evidence.status === 'ready' ? preparedExecution.gaps.length === 0 && capabilities.status === 'ready' && capabilities.evidenceRef !== null && preflight.technicalStatus === 'completed' : preparedExecution.gaps.length > 0), 'RESULT_INVALID');
    }
  }
  return structuredClone(evidence);
}
export function validateDProductionPreparation(value, options) {
  try { assertDProductionPreparation(value, options); return { valid: true, errors: [] }; }
  catch (error) {
    if (error instanceof DProductionPreparationError) return { valid: false, errors: [{ path: '$', message: error.code }] };
    if (error?.constructor === Error && /^(?:PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C2_SENSITIVE_INPUT_REJECTED|C2_REFERENCE_REJECTED_NONCANONICAL|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED):/.test(error.message)) return { valid: false, errors: [{ path: '$', message: 'D_PRODUCTION_PREPARATION_UNSAFE_RECORD' }] };
    throw error;
  }
}
export function createDProductionPreparationIntent({ job, candidateRevision, productionPlan, startedAt, requestMode = 'external_read' }) {
  const evidence = { schemaVersion: D_PRODUCTION_PREPARATION_VERSION, jobId: job.jobId, candidateId: job.candidateId,
    skuPackageId: job.skuPackageId, revision: job.revision, sourceCandidateRevision: candidateRevision,
    sourceAuthorizationFingerprint: fingerprintCanonicalRecord(productionPlan.sourceAuthorization), sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintCanonicalRecord(productionPlan), workerId: job.workerId, leaseId: job.leaseId,
    startedAt, completedAt: null, status: 'in_flight', result: null, continuationBlocked: false, requestMode };
  evidence.preparationId = preparationId(evidence);
  return assertDProductionPreparation(evidence, { job });
}
export function completeDProductionPreparation({ evidence, platformWritePreflight, adapterCapabilities, preparedExecution, completedAt, continuationBlocked = false }) {
  assertDProductionPreparation(evidence); requireValue(evidence.status === 'in_flight', 'ALREADY_RECORDED');
  assertCurrentPlatformWritePreflight(platformWritePreflight);
  requireValue(preparedExecution?.schemaVersion === 'd-software-execution-v2' &&
    preparedExecution.sourceProductionPlanId === evidence.sourceProductionPlanId &&
    preparedExecution.sourceProductionPlanFingerprint === evidence.sourceProductionPlanFingerprint &&
    preparedExecution.sourceAuthorizationFingerprint === evidence.sourceAuthorizationFingerprint &&
    time(preparedExecution.preparedAt) && Date.parse(preparedExecution.preparedAt) >= Date.parse(evidence.startedAt) &&
    Date.parse(preparedExecution.preparedAt) <= Date.parse(completedAt), 'PREPARED_SOURCE_CONFLICT');
  const capabilities = Object.fromEntries(['status','adapterVersion','protocolVersion','inspectedAt','evidenceRef','gaps'].map(key => [key, structuredClone(adapterCapabilities[key])]));
  return assertDProductionPreparation({ ...evidence, completedAt, continuationBlocked, status: preparedExecution.status,
    result: { platformWritePreflight: structuredClone(platformWritePreflight), capabilities,
      preparedExecution: { status: preparedExecution.status, gaps: structuredClone(preparedExecution.gaps) } } });
}
export function markDProductionPreparationUnknown({ evidence, completedAt }) {
  assertDProductionPreparation(evidence); requireValue(evidence.status === 'in_flight', 'ALREADY_RECORDED');
  return assertDProductionPreparation({ ...evidence, status: 'unknown_outcome', completedAt, result: null, continuationBlocked: true });
}
export function assertDProductionPreparationContinuation(previous, next) {
  assertDProductionPreparation(previous); assertDProductionPreparation(next);
  requireValue(previous.status === 'in_flight' && next.status !== 'in_flight' && immutableFields.every(key => isDeepStrictEqual(previous[key], next[key])), 'CONTINUATION_CONFLICT');
  return next;
}
