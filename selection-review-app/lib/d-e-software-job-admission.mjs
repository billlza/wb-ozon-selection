import { isDeepStrictEqual } from 'node:util';
import { DEJobScopeError, normalizeDESoftwareJobScope, assertDProductionJobScope, assertEReadbackJobScope } from './d-e-software-job-scope.mjs';
import { DProductionJobCursorError, assertCurrentDJobExecutionCursor } from './d-production-job-cursor.mjs';
import { C1SkuRightsReviewError } from './c1-sku-rights-review.mjs';
import { isProductionExecutionBinding } from './production-authorization-preparation.mjs';
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';

const TYPES = ['d_production_execution', 'e_independent_readback'];
const PHASES = ['enqueue_current', 'claim', 'external_request'];
const DECISION_FIELDS = ['schemaVersion', 'admissionKind', 'admissionId', 'jobId', 'candidateId', 'skuPackageId',
  'revision', 'jobType', 'normalizedScopeKey', 'authorizationRef', 'authorizationFingerprint', 'sourceFingerprint',
  'phase', 'observedAt', 'executionBindingSnapshot'];
const BINDING_FIELDS = ['schemaVersion', 'serviceId', 'serviceConfigurationVersion', 'productionBinding', 'platform',
  'storeRef', 'warehouseRef', 'credentialAlias', 'workerId', 'workerVersion', 'configurationEvidence'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const ref = value => isCanonicalFrozenRef(value) && !['unknown', 'null', 'undefined', 'not_applicable', 'missing'].includes(value.toLowerCase());

export class DESoftwareJobAdmissionError extends Error {
  constructor(suffix) { const code = `SOFTWARE_JOB_ADMISSION_DE_${suffix}`; super(code); this.name = 'DESoftwareJobAdmissionError'; this.code = code; }
}

function requireCondition(condition, suffix) { if (!condition) throw new DESoftwareJobAdmissionError(suffix); }

// These are validation boundaries only. Reject with a safe domain code; never persist
// raw validation messages, which can contain the rejected external input.
function validateBoundary(suffix, validate) {
  try { return validate(); } catch (error) {
    if (error instanceof DESoftwareJobAdmissionError) throw error;
    if (error instanceof DEJobScopeError || error instanceof DProductionJobCursorError || error instanceof C1SkuRightsReviewError ||
      (error?.constructor === Error && /^(?:C1_G1_IDENTITY_REQUIRED|C2_SENSITIVE_INPUT_REJECTED|C2_REFERENCE_REJECTED_NONCANONICAL|C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED|PRODUCTION_AUTHORIZATION_SECRET_REJECTED|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED):/.test(error.message))) {
      throw new DESoftwareJobAdmissionError(suffix);
    }
    throw error;
  }
}

function safe(value) {
  validateBoundary('UNSAFE_RECORD', () => {
    assertNoRawPersistenceKeys(value, 'deAdmission');
    assertNoProductionSecrets(value, 'deAdmission');
  });
}

function time(value) {
  const parts = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  requireCondition(parts && Number.isFinite(Date.parse(value)), 'TIME_INVALID');
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  requireCondition(day >= 1 && day <= maximumDay && Number(parts[4]) <= 23, 'TIME_INVALID');
  return Date.parse(value);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Detect reserved domain types even when a mismatching scope must subsequently be rejected. */
export function isDESoftwareJob(job) {
  return TYPES.includes(job?.jobType) || TYPES.includes(job?.scopeBinding?.sideEffectScope);
}

function scopeOf(job) {
  requireCondition(object(job) && ref(job.jobId), 'JOB_INVALID');
  return validateBoundary('SCOPE_INVALID', () => normalizeDESoftwareJobScope(job.scopeBinding, job));
}

function scopeKey(scope) {
  return `software-job-scope:${fingerprintCanonicalRecord({ schemaVersion: 'software-job-normalized-scope-v1',
    jobType: scope.sideEffectScope, identity: scope.identity, variantKey: scope.variantKey, sideEffectScope: scope.sideEffectScope })}`;
}

export function deSoftwareJobScopeKey(job) { return scopeKey(scopeOf(job)); }

function immutableDecision(job, scope) {
  const source = { jobId: job.jobId, candidateId: job.candidateId, skuPackageId: job.skuPackageId, revision: job.revision,
    jobType: job.jobType, normalizedScopeKey: scopeKey(scope), authorizationRef: scope.authorizationRef,
    authorizationFingerprint: scope.authorizationFingerprint, sourceFingerprint: scope.inputFingerprint };
  return { schemaVersion: 'software-job-admission-v1', admissionKind: 'domain_handoff',
    admissionId: `software-job-admission:${fingerprintCanonicalRecord({ ...source, scopeBinding: scope })}`, ...source };
}

function bindingSnapshot(binding, scope, observedAt) {
  requireCondition(binding !== null, 'BINDING_REQUIRED');
  requireCondition(closed(binding, BINDING_FIELDS) && binding.schemaVersion === 'd-e-execution-binding-v1' &&
    binding.platform === 'ozon' && ['serviceId', 'serviceConfigurationVersion', 'warehouseRef', 'credentialAlias', 'workerId', 'workerVersion']
      .every(field => ref(binding[field])) && isProductionExecutionBinding(binding.productionBinding) &&
    closed(binding.configurationEvidence, ['evidenceRef', 'checkedAt', 'expiresAt']) && ref(binding.configurationEvidence.evidenceRef), 'BINDING_INVALID');
  safe(binding);
  requireCondition(sameStoreRef(binding.storeRef, scope.identity.storeRef) &&
    isDeepStrictEqual(binding.productionBinding, scope.productionBinding) && binding.warehouseRef === scope.warehouseRef &&
    binding.credentialAlias === scope.credentialAlias, 'BINDING_SOURCE_CONFLICT');
  const checked = time(binding.configurationEvidence.checkedAt), expires = time(binding.configurationEvidence.expiresAt), now = time(observedAt);
  requireCondition(checked <= now && now < expires && checked < expires, 'BINDING_EVIDENCE_EXPIRED');
  return freeze(structuredClone(binding));
}

function assertWorker(worker, binding, observedAt) {
  requireCondition(object(worker), 'WORKER_REQUIRED');
  safe(worker);
  requireCondition(worker.schemaVersion === 'worker-descriptor-v1' && ref(worker.workerId) && ref(worker.version) &&
    worker.workerId === binding.workerId && worker.version === binding.workerVersion && worker.status === 'online', 'WORKER_CONFLICT');
  // 2026-09-22 主人决定删除“打卡时间不得晚于检查时间”的比较：单机上工人与检查方是同一进程，
  // 该比较无业务意义，且与领取后的心跳刷新顺序冲突，曾把 D 任务卡死在 claimed。
}

function stableBinding(binding) {
  const { configurationEvidence, ...stable } = binding;
  return { ...stable, configurationEvidence: { evidenceRef: configurationEvidence.evidenceRef } };
}

/** Historical binding validation: verifies immutable job source, not a current lease or runtime service. */
export function assertDEJobAdmissionDecision(job, decision) {
  const scope = scopeOf(job);
  requireCondition(closed(decision, DECISION_FIELDS), 'DECISION_INVALID');
  safe(decision);
  const expected = immutableDecision(job, scope);
  requireCondition(Object.entries(expected).every(([key, value]) => isDeepStrictEqual(decision[key], value)), 'DECISION_SOURCE_CONFLICT');
  requireCondition(PHASES.includes(decision.phase), 'PHASE_INVALID');
  time(decision.observedAt);
  if (decision.phase === 'enqueue_current') requireCondition(decision.executionBindingSnapshot === null, 'DECISION_SNAPSHOT_CONFLICT');
  else bindingSnapshot(decision.executionBindingSnapshot, scope, decision.observedAt);
  return freeze(structuredClone(decision));
}

/** Pure source/config admission. No I/O, authorization consumption, holder, lease or transport assertion. */
export function createDEJobAdmissionDecision({ candidate, job, observedAt, phase, executionBinding = null, worker = null }) {
  requireCondition(PHASES.includes(phase), 'PHASE_INVALID');
  time(observedAt);
  const scope = scopeOf(job);
  let prior = null;
  if (phase !== 'enqueue_current') {
    prior = assertDEJobAdmissionDecision(job, job.admissionDecision);
    requireCondition(phase === 'claim' ? prior.phase === 'enqueue_current' : ['claim', 'external_request'].includes(prior.phase), 'PHASE_CONFLICT');
    requireCondition(time(prior.observedAt) <= time(observedAt), 'TIME_CONFLICT');
  }
  validateBoundary('SOURCE_INVALID', () => {
    if (job.jobType === 'e_independent_readback') assertEReadbackJobScope({ scope, candidate, observedAt });
    else if (phase === 'enqueue_current') assertDProductionJobScope({ scope, candidate, observedAt });
    else assertCurrentDJobExecutionCursor({ job, candidate, observedAt });
  });
  let snapshot = null;
  if (phase !== 'enqueue_current') {
    snapshot = bindingSnapshot(executionBinding, scope, observedAt);
    assertWorker(worker, snapshot, observedAt);
    if (phase === 'external_request') requireCondition(isDeepStrictEqual(stableBinding(snapshot), stableBinding(prior.executionBindingSnapshot)), 'BINDING_CHANGED');
  }
  return assertDEJobAdmissionDecision(job, { ...immutableDecision(job, scope), phase, observedAt, executionBindingSnapshot: snapshot });
}
