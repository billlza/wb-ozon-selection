import assert from 'node:assert/strict';
import test from 'node:test';
import { DESoftwareJobAdmissionError, isDESoftwareJob, deSoftwareJobScopeKey,
  assertDEJobAdmissionDecision, createDEJobAdmissionDecision } from '../lib/d-e-software-job-admission.mjs';
import { createDProductionJobScope, createEReadbackJobScope } from '../lib/d-e-software-job-scope.mjs';
import { createWorkerDescriptor } from '../lib/runtime-identity.mjs';
import { deSoftwareJobScopeFixture, DE_SCOPE_OBSERVED_AT as observedAt } from './fixtures/d-e-software-job-scope-fixture.mjs';
import { dProductionJobCursorFixture } from './fixtures/d-production-job-cursor-fixture.mjs';

const clone = value => structuredClone(value);
const fixture = await deSoftwareJobScopeFixture();
const cursorFixture = await dProductionJobCursorFixture({ oss: true });
const entries = [
  { candidate: fixture.initialCandidate, scope: createDProductionJobScope({ candidate: fixture.initialCandidate, observedAt }) },
  { candidate: fixture.completedCandidate, scope: createEReadbackJobScope({ candidate: fixture.completedCandidate, observedAt }) }
].map(({ candidate, scope }) => ({ candidate, job: { jobId: `job:synthetic:${scope.sideEffectScope}`, jobType: scope.sideEffectScope,
  candidateId: scope.candidateId, skuPackageId: scope.skuPackageId, revision: scope.resultRevision, scopeBinding: scope } }));

function configured(job) {
  const scope = job.scopeBinding;
  const worker = createWorkerDescriptor({ workerId: 'worker:synthetic:de', version: 'worker-version:1',
    capabilities: [job.jobType === 'd_production_execution' ? 'ozon-production-execution' : 'ozon-independent-readback'], observedAt });
  // Independent synthetic current-service evidence, not a claim that a credential was inspected.
  const executionBinding = { schemaVersion: 'd-e-execution-binding-v1', serviceId: 'service:synthetic:de',
    serviceConfigurationVersion: 'service-config:1', productionBinding: clone(scope.productionBinding), platform: 'ozon',
    storeRef: clone(scope.identity.storeRef), warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias,
    workerId: worker.workerId, workerVersion: worker.version,
    configurationEvidence: { evidenceRef: 'evidence:synthetic:service-config', checkedAt: '2026-08-22T07:00:00.000Z', expiresAt: '2026-08-22T08:00:00.000Z' } };
  return { executionBinding, worker };
}

function enqueue(entry) {
  return { ...clone(entry.job), admissionDecision: createDEJobAdmissionDecision({ ...entry, observedAt, phase: 'enqueue_current' }) };
}

function claimed(entry) {
  const job = enqueue(entry);
  return { ...job, admissionDecision: createDEJobAdmissionDecision({ candidate: entry.candidate, job, observedAt, phase: 'claim', ...configured(job) }) };
}

const rejected = suffix => error => error instanceof DESoftwareJobAdmissionError &&
  (suffix ? error.code === `SOFTWARE_JOB_ADMISSION_DE_${suffix}` : error.code.startsWith('SOFTWARE_JOB_ADMISSION_DE_'));

test('real D/E producers enqueue from the domain source without a credential or another owner authorization', () => {
  for (const entry of entries) {
    const before = clone(entry), decision = enqueue(entry).admissionDecision;
    assert.deepEqual(entry, before);
    assert.equal(Object.keys(decision).length, 15);
    assert.equal(decision.admissionKind, 'domain_handoff');
    assert.equal(decision.executionBindingSnapshot, null);
    assert.equal(decision.authorizationRef, entry.job.scopeBinding.authorizationRef);
    assert.ok(decision.authorizationRef.length > 256);
    assert.equal(decision.sourceFingerprint, entry.job.scopeBinding.inputFingerprint);
    assert.ok(Object.isFrozen(decision));
    assert.deepEqual(assertDEJobAdmissionDecision(entry.job, decision), decision);
    assert.deepEqual(createDEJobAdmissionDecision({ ...entry, observedAt, phase: 'enqueue_current', ...configured(entry.job) }), decision);
    assert.equal(Object.hasOwn(decision, 'credentialBindingFingerprint'), false);
    assert.equal(Object.hasOwn(decision, 'authorizationRecord'), false);
  }
});

test('scope detection fails closed on type/scope mismatch and uses the stable G1 branch rather than revision or PA identity', () => {
  assert.equal(isDESoftwareJob(null), false); assert.equal(isDESoftwareJob({ jobType: 'c1_ai_draft' }), false);
  for (const { job } of entries) {
    assert.equal(isDESoftwareJob(job), true);
    const mismatch = { ...clone(job), jobType: 'c1_ai_draft' };
    assert.equal(isDESoftwareJob(mismatch), true); assert.throws(() => deSoftwareJobScopeKey(mismatch), rejected('SCOPE_INVALID'));
    const changed = clone(job); changed.revision += 2; changed.scopeBinding.sourceRevision += 2; changed.scopeBinding.resultRevision += 2;
    assert.equal(deSoftwareJobScopeKey(job), deSoftwareJobScopeKey(changed));
    changed.scopeBinding.variantKey += '-other'; assert.notEqual(deSoftwareJobScopeKey(job), deSoftwareJobScopeKey(changed));
    const otherStore = clone(job); otherStore.scopeBinding.identity.storeRef.platformStoreId += '-other';
    assert.notEqual(deSoftwareJobScopeKey(job), deSoftwareJobScopeKey(otherStore));
  }
  assert.notEqual(deSoftwareJobScopeKey(entries[0].job), deSoftwareJobScopeKey(entries[1].job));
});

test('claim saves a detached current configuration snapshot, external renews only evidence times', () => {
  for (const entry of entries) {
    const job = enqueue(entry), configuration = configured(job), before = clone(configuration);
    const claim = createDEJobAdmissionDecision({ candidate: entry.candidate, job, observedAt, phase: 'claim', ...configuration });
    assert.deepEqual(configuration, before); assert.notEqual(claim.executionBindingSnapshot, configuration.executionBinding);
    assert.ok(Object.isFrozen(claim.executionBindingSnapshot.configurationEvidence));
    assert.equal(claim.admissionId, job.admissionDecision.admissionId);
    const claimedJob = { ...job, admissionDecision: claim };
    configuration.executionBinding.configurationEvidence.checkedAt = '2026-08-22T07:31:00.000Z';
    configuration.executionBinding.configurationEvidence.expiresAt = '2026-08-22T09:00:00.000Z';
    const external = createDEJobAdmissionDecision({ candidate: entry.candidate, job: claimedJob,
      observedAt: '2026-08-22T07:32:00.000Z', phase: 'external_request', ...configuration });
    assert.equal(external.admissionId, claim.admissionId);
    assert.equal(external.executionBindingSnapshot.configurationEvidence.checkedAt, '2026-08-22T07:31:00.000Z');
    assert.equal(claim.executionBindingSnapshot.configurationEvidence.checkedAt, before.executionBinding.configurationEvidence.checkedAt);
    assert.deepEqual(assertDEJobAdmissionDecision(job, claim), claim);
    assert.doesNotThrow(() => createDEJobAdmissionDecision({ candidate: entry.candidate, job: { ...job, admissionDecision: external },
      observedAt: '2026-08-22T07:33:00.000Z', phase: 'external_request', ...configuration }));
  }
});

test('claim requires an explicit current service binding and current matching worker, while PA binding alone is insufficient', () => {
  for (const entry of entries) {
    const job = enqueue(entry), args = { candidate: entry.candidate, job, observedAt, phase: 'claim' };
    assert.throws(() => createDEJobAdmissionDecision(args), rejected('BINDING_REQUIRED'));
    assert.throws(() => createDEJobAdmissionDecision({ ...args, executionBinding: job.scopeBinding.productionBinding }), rejected('BINDING_INVALID'));
    assert.throws(() => createDEJobAdmissionDecision({ ...args, executionBinding: configured(job).executionBinding }), rejected('WORKER_REQUIRED'));
    for (const change of [w => { w.workerId += '-other'; }, w => { w.version += '-other'; }, w => { w.status = 'offline'; },
      w => { w.status = 'busy'; }, w => { w.schemaVersion = 'worker-descriptor-v2'; }]) {
      const configuration = configured(job); configuration.worker = clone(configuration.worker); change(configuration.worker);
      assert.throws(() => createDEJobAdmissionDecision({ ...args, ...configuration }), rejected());
    }
  }
});

test('current service cannot cross the frozen store, warehouse, alias or production binding/version', () => {
  for (const entry of entries) for (const change of [b => { b.storeRef.platformStoreId += '-other'; },
    b => { b.storeRef.mappingVersion += '-other'; }, b => { b.warehouseRef += '-other'; }, b => { b.credentialAlias += '-other'; },
    b => { b.productionBinding.bindingId += '-other'; }, b => { b.productionBinding.configurationVersion += '-other'; },
    b => { b.productionBinding.warehouseId = '70002'; }, b => { b.platform = 'wb'; }]) {
    const job = enqueue(entry), configuration = configured(job); change(configuration.executionBinding);
    assert.throws(() => createDEJobAdmissionDecision({ candidate: entry.candidate, job, observedAt, phase: 'claim', ...configuration }), rejected());
  }
});

test('external rejects every stable technical change, even a newly matching worker or configuration evidence', () => {
  for (const entry of entries) for (const change of [c => { c.executionBinding.serviceId += '-other'; },
    c => { c.executionBinding.serviceConfigurationVersion += '-other'; },
    c => { c.executionBinding.configurationEvidence.evidenceRef += '-other'; },
    c => { c.executionBinding.workerId += '-other'; c.worker.workerId = c.executionBinding.workerId; },
    c => { c.executionBinding.workerVersion += '-other'; c.worker.version = c.executionBinding.workerVersion; }]) {
    const job = claimed(entry), configuration = clone(configured(job)); change(configuration);
    assert.throws(() => createDEJobAdmissionDecision({ candidate: entry.candidate, job, observedAt, phase: 'external_request', ...configuration }), rejected('BINDING_CHANGED'));
  }
});

test('service evidence must have a valid nonempty interval containing the explicit observation time', () => {
  for (const entry of entries) for (const change of [e => { e.checkedAt = '2026-08-22T07:31:00.000Z'; },
    e => { e.expiresAt = observedAt; }, e => { e.expiresAt = e.checkedAt; }, e => { e.expiresAt = null; },
    e => { e.checkedAt = 'today'; }, e => { e.checkedAt = '2026-02-30T00:00:00.000Z'; },
    e => { e.checkedAt = '2026-08-21T24:00:00.000Z'; }, e => { e.expiresAt = '2026-99-01T00:00:00.000Z'; }]) {
    const job = enqueue(entry), configuration = configured(job); change(configuration.executionBinding.configurationEvidence);
    assert.throws(() => createDEJobAdmissionDecision({ candidate: entry.candidate, job, observedAt, phase: 'claim', ...configuration }), rejected());
  }
});

test('closed DTOs reject missing/additional fields and unsafe refs without echoing secrets', () => {
  const entry = entries[0], job = enqueue(entry), args = { candidate: entry.candidate, job, observedAt, phase: 'claim' };
  for (const field of Object.keys(configured(job).executionBinding)) {
    const configuration = configured(job); delete configuration.executionBinding[field];
    assert.throws(() => createDEJobAdmissionDecision({ ...args, ...configuration }), rejected('BINDING_INVALID'));
  }
  for (const change of [b => { b.extra = true; }, b => { b.configurationEvidence.verified = true; },
    b => { b.storeRef.extra = true; }, b => { b.productionBinding.verified = true; },
    b => { b.serviceId = 'x'.repeat(257); }, b => { b.serviceConfigurationVersion = 'unknown'; },
    b => { b.configurationEvidence.evidenceRef = 'https://example.com/config'; },
    b => { b.serviceId = 'secret=synthetic-private-value'; }, b => { b.workerVersion = 'Bearer synthetic-private-value'; },
    b => { b.credentialAlias = 'alias%0asecret'; }, b => { b.configurationEvidence.rawResponse = {}; }]) {
    const configuration = configured(job); change(configuration.executionBinding);
    assert.throws(() => createDEJobAdmissionDecision({ ...args, ...configuration }), error => rejected()(error) && !error.message.includes('synthetic-private-value'));
  }
});

test('historical decision validation is closed and binds each immutable source field and phase snapshot', () => {
  for (const entry of entries) {
    const decision = claimed(entry).admissionDecision;
    for (const field of Object.keys(decision)) {
      const invalid = clone(decision); delete invalid[field]; assert.throws(() => assertDEJobAdmissionDecision(entry.job, invalid), rejected('DECISION_INVALID'));
    }
    for (const field of ['schemaVersion', 'admissionKind', 'admissionId', 'jobId', 'candidateId', 'skuPackageId', 'revision', 'jobType',
      'normalizedScopeKey', 'authorizationRef', 'authorizationFingerprint', 'sourceFingerprint']) {
      const invalid = clone(decision); invalid[field] = typeof invalid[field] === 'number' ? invalid[field] + 1 : `${invalid[field]}-other`;
      assert.throws(() => assertDEJobAdmissionDecision(entry.job, invalid), rejected('DECISION_SOURCE_CONFLICT'));
    }
    for (const change of [s => { s.productionBinding.configurationVersion += '-other'; }, s => { s.merchantSku += '-other'; },
      s => { s.warehouseRef += '-other'; }, s => { s.credentialAlias += '-other'; }]) {
      const changedJob = clone(entry.job); change(changedJob.scopeBinding);
      assert.throws(() => assertDEJobAdmissionDecision(changedJob, enqueue(entry).admissionDecision), rejected('DECISION_SOURCE_CONFLICT'));
    }
    for (const change of [d => { d.extra = true; }, d => { d.phase = 'enqueue'; }, d => { d.phase = 'enqueue_current'; },
      d => { d.executionBindingSnapshot = null; }, d => { d.observedAt = 'yesterday'; },
      d => { d.executionBindingSnapshot.configurationEvidence.expiresAt = d.observedAt; }]) {
      const invalid = clone(decision); change(invalid); assert.throws(() => assertDEJobAdmissionDecision(entry.job, invalid), rejected());
    }
  }
});

test('phase chain cannot skip claim, move time backwards or claim twice', () => {
  for (const entry of entries) {
    const job = enqueue(entry), configuration = configured(job), args = { candidate: entry.candidate, observedAt, ...configuration };
    assert.throws(() => createDEJobAdmissionDecision({ ...args, job: entry.job, phase: 'claim' }), rejected('DECISION_INVALID'));
    assert.throws(() => createDEJobAdmissionDecision({ ...args, job, phase: 'external_request' }), rejected('PHASE_CONFLICT'));
    assert.throws(() => createDEJobAdmissionDecision({ ...args, job: claimed(entry), phase: 'claim' }), rejected('PHASE_CONFLICT'));
    assert.throws(() => createDEJobAdmissionDecision({ ...args, job, phase: 'claim', observedAt: '2026-08-22T07:29:00.000Z' }), rejected('TIME_CONFLICT'));
  }
});

test('current domain source rejects identity, revision and real receipt drift before enqueue or external admission', () => {
  for (const entry of entries) for (const change of [c => { c.id += '-other'; }, c => { c.dataRevision += 1; },
    c => { c.lifecycleV11.skuPackage.dataRevision += 1; }, c => { c.lifecycleV11.skuPackage.g1Identity.storeRef.platformStoreId += '-other'; },
    c => { c.lifecycleV11.skuPackage.productionAuthorization.authorizationId += '-other'; }]) {
    const candidate = clone(entry.candidate); change(candidate);
    assert.throws(() => createDEJobAdmissionDecision({ candidate, job: entry.job, observedAt, phase: 'enqueue_current' }), rejected('SOURCE_INVALID'));
    assert.throws(() => createDEJobAdmissionDecision({ candidate, job: claimed(entry), observedAt, phase: 'external_request', ...configured(entry.job) }), rejected('SOURCE_INVALID'));
  }
  const entry = entries[1], candidate = clone(entry.candidate); candidate.lifecycleV11.skuPackage.productionRecord.requestReceiptRef += '-other';
  assert.throws(() => createDEJobAdmissionDecision({ candidate, job: entry.job, observedAt, phase: 'enqueue_current' }), rejected('SOURCE_INVALID'));
});

test('fixed PA job revision follows only actual OSS and D checkpoints; unknown, terminal and tampered cursors reject', () => {
  const { job: sourceJob, snapshots } = cursorFixture;
  const entry = { candidate: snapshots[0], job: sourceJob }, job = claimed(entry), configuration = configured(job);
  for (const candidate of snapshots.slice(0, -1)) {
    const result = createDEJobAdmissionDecision({ candidate, job, observedAt, phase: 'external_request', ...configuration });
    assert.equal(result.revision, sourceJob.revision);
  }
  assert.throws(() => createDEJobAdmissionDecision({ candidate: snapshots.at(-1), job, observedAt, phase: 'external_request', ...configuration }), rejected('SOURCE_INVALID'));
  for (const change of [c => { c.dataRevision += 1; }, c => { c.lifecycleV11.skuPackage.dSoftwareExecution.executionRevision += 1; },
    c => { c.lifecycleV11.skuPackage.dSoftwareExecution.status = 'unknown_outcome'; }]) {
    const candidate = clone(snapshots.at(-2)); change(candidate);
    assert.throws(() => createDEJobAdmissionDecision({ candidate, job, observedAt, phase: 'external_request', ...configuration }), rejected('SOURCE_INVALID'));
  }
});

test('D rechecks actual frozen rights expiry for a new send while a historical decision remains readable', () => {
  const entry = entries[0], job = claimed(entry);
  const rights = entry.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview;
  const later = new Date(Date.parse(rights.expiresAt) + 1).toISOString();
  const configuration = configured(job);
  configuration.executionBinding.configurationEvidence.checkedAt = later;
  configuration.executionBinding.configurationEvidence.expiresAt = new Date(Date.parse(later) + 60_000).toISOString();
  assert.throws(() => createDEJobAdmissionDecision({ candidate: entry.candidate, job, observedAt: later,
    phase: 'external_request', ...configuration }), rejected('SOURCE_INVALID'));
  assert.deepEqual(assertDEJobAdmissionDecision(job, job.admissionDecision), job.admissionDecision);
});

test('unexpected implementation errors propagate unchanged instead of becoming a business admission rejection', () => {
  const entry = entries[0], candidate = clone(entry.candidate), unexpected = new TypeError('synthetic programmer failure');
  Object.defineProperty(candidate.lifecycleV11.skuPackage, 'productionAuthorization', { get() { throw unexpected; } });
  assert.throws(() => createDEJobAdmissionDecision({ candidate, job: entry.job, observedAt, phase: 'enqueue_current' }), error => error === unexpected);
});
