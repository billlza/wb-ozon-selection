import { isDeepStrictEqual } from 'node:util';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { isCompleteStoreRef } from './store-binding.mjs';
import { validateProductionReadbackExpectation } from './e-stage-readback.mjs';

export const D_BATCH_IMPORT_JOB_VERSION = 'd-batch-import-job-v3';
const historicalJobVersion = 'd-batch-import-job-v2';
const validRef = value => typeof value === 'string' && value.trim().length > 0;
const validTime = value => validRef(value) && !Number.isNaN(Date.parse(value));
const clone = value => structuredClone(value);
const chunkStatuses = new Set(['not_sent', 'intent', 'waiting_platform', 'observed_pending',
  'observed_imported', 'platform_failed', 'platform_skipped', 'unknown_outcome', 'observation_stopped',
  'prewrite_blocked']);
const safeReasonCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,119}$/.test(value);

export const D_BATCH_FROZEN_IMPORT_VERSION = 'd-batch-frozen-import-v1';

export function projectDBatchFrozenMemberSource(request) {
  return { candidateId: request.candidateId, skuPackageId: request.skuPackageId,
    merchantSku: request.merchantSku, supplierSkuId: request.supplierSkuId,
    sourceAuthorizationId: request.sourceAuthorizationId,
    sourceAuthorizationFingerprint: request.sourceAuthorizationFingerprint,
    sourceProductionPlanId: request.sourceProductionPlanId,
    sourceProductionPlanFingerprint: request.sourceProductionPlanFingerprint,
    platform: request.platform, store: request.store, storeRef: clone(request.storeRef),
    warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias,
    warehouseId: request.inventoryWrite.warehouseId,
    platformWritePrice: clone(request.platformWritePrice), stock: request.stock,
    readbackExpectation: clone(request.independentReadback.expectation) };
}

/** Admission freezes exactly what the adapter will send and the validated source for each item. */
export function assertDBatchFrozenImport(frozen, offerIds) {
  if (frozen?.schemaVersion !== D_BATCH_FROZEN_IMPORT_VERSION || !Array.isArray(frozen.items) ||
      !Array.isArray(frozen.memberSources) || frozen.items.length !== offerIds.length ||
      frozen.memberSources.length !== offerIds.length ||
      !isDeepStrictEqual(frozen.items.map(item => item.offer_id), offerIds) ||
      !isDeepStrictEqual(frozen.memberSources.map(source => source.merchantSku), offerIds) ||
      fingerprintCanonicalRecord(frozen.items) !== frozen.itemFingerprint ||
      fingerprintCanonicalRecord({items:frozen.items,memberSources:frozen.memberSources}) !== frozen.contentFingerprint) {
    throw new Error('D_BATCH_FROZEN_IMPORT_INVALID');
  }
  for (const source of frozen.memberSources) {
    if(!source || !source.candidateId || !source.skuPackageId || !source.supplierSkuId ||
        !source.sourceAuthorizationId || !source.sourceAuthorizationFingerprint ||
        !source.sourceProductionPlanId || !source.sourceProductionPlanFingerprint ||
        source.platform!=='ozon' || !isCompleteStoreRef(source.storeRef,source.store) ||
        !source.warehouseRef || !source.credentialAlias || !source.warehouseId ||
        !Number.isFinite(source.platformWritePrice?.amount) || source.platformWritePrice.currency!=='CNY' ||
        !Number.isSafeInteger(source.stock) || source.stock<0 ||
        !validateProductionReadbackExpectation(source.readbackExpectation) ||
        source.readbackExpectation.warehouseId!==source.warehouseId)
      throw new Error('D_BATCH_FROZEN_MEMBER_SOURCE_INVALID');
  }
  return frozen;
}

function assertJob(job) {
  assertDPlatformObservationPolicy(job?.observationPolicy);
  if (![historicalJobVersion,D_BATCH_IMPORT_JOB_VERSION].includes(job?.schemaVersion) ||
      !validRef(job.jobId) || !validRef(job.batchId) ||
      !Number.isSafeInteger(job.revision) || job.revision < 1 || !validRef(job.workerId) || !validRef(job.workerVersion) ||
      !validRef(job.leaseId) || !validTime(job.leaseExpiresAt) || !Array.isArray(job.chunks) ||
      job.chunks.length === 0 || job.chunks.some((chunk, index) => chunk.index !== index ||
        !Array.isArray(chunk.offerIds) || chunk.offerIds.length === 0 ||
        !validRef(chunk.limitEvidenceRef) || !chunkStatuses.has(chunk.status) ||
        !Number.isSafeInteger(chunk.observationReads) || chunk.observationReads < 0 ||
        chunk.observationReads > job.observationPolicy.maxQueries || !validTime(chunk.nextObservationAt) ||
        typeof chunk.observationInFlight !== 'boolean' ||
        chunk.offerIds.some(offerId => !validRef(offerId)) || new Set(chunk.offerIds).size !== chunk.offerIds.length ||
        (['not_sent', 'intent'].includes(chunk.status) && (chunk.taskId !== null || chunk.results !== null)) ||
        (['waiting_platform', 'observed_pending', 'observed_imported', 'platform_failed', 'platform_skipped'].includes(chunk.status) &&
          (!/^[1-9][0-9]*$/.test(chunk.taskId) || !Number.isSafeInteger(Number(chunk.taskId)))) ||
        (chunk.status === 'waiting_platform' && chunk.results !== null) ||
        (['observed_pending', 'observed_imported', 'platform_failed', 'platform_skipped'].includes(chunk.status) &&
          (!Array.isArray(chunk.results) ||
            !isDeepStrictEqual(chunk.results.map(result => result.offerId), chunk.offerIds))) ||
        (chunk.status === 'unknown_outcome' && chunk.taskId !== null &&
          (!/^[1-9][0-9]*$/.test(chunk.taskId) || !Number.isSafeInteger(Number(chunk.taskId)))) ||
        (chunk.status === 'prewrite_blocked' && (job.schemaVersion !== D_BATCH_IMPORT_JOB_VERSION ||
          chunk.taskId !== null || chunk.results !== null ||
          !safeReasonCode(chunk.prewriteReasonCode) || chunk.requestTransmission !== 'not_attempted')) ||
        (chunk.status === 'observation_stopped' &&
          (chunk.taskId === null || !['query_limit','policy_expired'].includes(chunk.stopReason)))) ||
      new Set(job.chunks.flatMap(chunk => chunk.offerIds)).size !== job.chunks.flatMap(chunk => chunk.offerIds).length ||
      job.status !== statusFor(job.chunks)) {
    throw new Error('D_BATCH_IMPORT_JOB_INVALID');
  }
  for (const chunk of job.chunks) {
    if (chunk.frozenImport != null) assertDBatchFrozenImport(chunk.frozenImport, chunk.offerIds);
  }
  assertSafeRuntimeRecord(job, 'dBatchImportJob');
  return job;
}

function statusFor(chunks) {
  if (chunks.some(chunk => ['unknown_outcome','intent','observation_stopped'].includes(chunk.status))) return 'unknown_outcome';
  if (chunks.some(chunk => chunk.status === 'waiting_platform' || chunk.status === 'observed_pending')) return 'waiting_platform';
  if (chunks.some(chunk => chunk.status === 'prewrite_blocked')) return chunks.some(chunk =>
    !['not_sent','prewrite_blocked'].includes(chunk.status)) ? 'partial_failure' : 'prewrite_blocked';
  if (chunks.some(chunk => chunk.status === 'platform_failed' || chunk.status === 'platform_skipped')) return 'partial_failure';
  if (chunks.every(chunk => chunk.status === 'observed_imported')) return 'imported_awaiting_inventory';
  return 'claimed';
}

/** Persisted batch import state. Every chunk belongs to one task and every offer has one terminal observation. */
export function createDBatchImportJob({ batch, chunks, workerId, workerVersion, leaseId, leaseExpiresAt, createdAt,
  observationPolicy }) {
  assertDPlatformObservationPolicy(observationPolicy);
  if (batch?.status !== 'authorized' || batch.externalRequestState !== 'not_sent' ||
      !validRef(batch.batchId) || !Array.isArray(batch.members) || !Array.isArray(chunks) ||
      !Array.isArray(batch.excludedOfferIds) ||
      chunks.length === 0 || !validRef(workerId) || !validRef(workerVersion) || !validRef(leaseId) ||
      !validTime(createdAt) || !validTime(leaseExpiresAt) || Date.parse(leaseExpiresAt) <= Date.parse(createdAt)) {
    throw new Error('D_BATCH_IMPORT_ADMISSION_INVALID');
  }
  const expected = batch.members.map(member => member.offerId);
  const actual = chunks.flatMap(chunk => chunk.offerIds);
  if (!isDeepStrictEqual(actual, expected) || actual.some(offerId => batch.excludedOfferIds.includes(offerId))) {
    throw new Error('D_BATCH_IMPORT_MEMBER_SCOPE_MISMATCH');
  }
  const job = { schemaVersion: D_BATCH_IMPORT_JOB_VERSION, jobId: `d-batch-import:${batch.batchId}`,
    batchId: batch.batchId, revision: 1, workerId, workerVersion, leaseId, leaseExpiresAt, status: 'claimed',
    createdAt, updatedAt: createdAt, observationPolicy: clone(observationPolicy), chunks: chunks.map((chunk, index) => ({ index,
      offerIds: [...chunk.offerIds], limitEvidenceRef: chunk.limitEvidenceRef,
      // Historical v2 jobs remain observable; the runtime blocks any unsent chunk without this source.
      frozenImport: chunk.frozenImport ? clone(assertDBatchFrozenImport(chunk.frozenImport, chunk.offerIds)) : null,
      status: 'not_sent', taskId: null, results: null, observationReads: 0, observationInFlight: false,
      nextObservationAt: createdAt })) };
  return Object.freeze(assertJob(job));
}

/** An unclassified intent cannot be resent; only the live pre-send proof can settle it as not sent. */
export function applyDBatchImportEvent({ job, event, workerId, leaseId, observedAt }) {
  assertJob(job);
  if (!validTime(observedAt) || workerId !== job.workerId || leaseId !== job.leaseId ||
      Date.parse(observedAt) >= Date.parse(job.leaseExpiresAt) ||
      !Number.isSafeInteger(event?.chunkIndex) || event.chunkIndex < 0 || event.chunkIndex >= job.chunks.length) {
    throw new Error('D_BATCH_IMPORT_LEASE_OR_SCOPE_INVALID');
  }
  const next = clone(job), chunk = next.chunks[event.chunkIndex];
  if (!isDeepStrictEqual(event.offerIds, chunk.offerIds)) throw new Error('D_BATCH_IMPORT_OFFER_SCOPE_MISMATCH');
  if (event.kind === 'batch_import_prewrite_blocked' && chunk.status === 'prewrite_blocked' &&
      chunk.prewriteReasonCode === event.reasonCode && event.requestTransmission === 'not_attempted') return job;
  if (event.kind === 'batch_import_intent') {
    if (chunk.status !== 'not_sent' || next.chunks.slice(0, chunk.index).some(prior =>
      !['waiting_platform', 'observed_imported', 'platform_failed', 'platform_skipped'].includes(prior.status))) {
      throw new Error('D_BATCH_IMPORT_INTENT_REPLAY_BLOCKED');
    }
    chunk.status = 'intent';
  } else if (event.kind === 'batch_import_task_received') {
    if (chunk.status !== 'intent' || !/^[1-9][0-9]*$/.test(event.taskId) ||
        !Number.isSafeInteger(Number(event.taskId))) throw new Error('D_BATCH_IMPORT_TASK_RECEIPT_INVALID');
    chunk.taskId = event.taskId;
    chunk.status = 'waiting_platform';
  } else if (event.kind === 'batch_import_unknown') {
    if (chunk.status !== 'intent' || !validRef(event.reason)) throw new Error('D_BATCH_IMPORT_UNKNOWN_INVALID');
    chunk.status = 'unknown_outcome';
    chunk.unknownReason = event.reason;
  } else if (event.kind === 'batch_import_prewrite_blocked') {
    if (job.schemaVersion !== D_BATCH_IMPORT_JOB_VERSION || chunk.status !== 'intent' ||
        event.requestTransmission !== 'not_attempted' ||
        !safeReasonCode(event.reasonCode)) throw new Error('D_BATCH_IMPORT_PREWRITE_PROOF_INVALID');
    chunk.status = 'prewrite_blocked';
    chunk.prewriteReasonCode = event.reasonCode;
    chunk.requestTransmission = 'not_attempted';
  } else if (event.kind === 'batch_observation_started') {
    if (!['waiting_platform', 'observed_pending', 'unknown_outcome'].includes(chunk.status) ||
        chunk.taskId === null || event.taskId !== chunk.taskId || chunk.observationInFlight ||
        chunk.observationReads >= job.observationPolicy.maxQueries ||
        Date.parse(observedAt) < Date.parse(chunk.nextObservationAt) ||
        Date.parse(observedAt) >= Date.parse(job.observationPolicy.expiresAt)) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_NOT_DUE');
    }
    chunk.observationReads++;
    chunk.observationInFlight = true;
    chunk.nextObservationAt = new Date(Date.parse(observedAt) + job.observationPolicy.intervalMs).toISOString();
  } else if (event.kind === 'batch_observation_failed') {
    if (!chunk.observationInFlight || chunk.taskId === null || event.taskId !== chunk.taskId ||
        !validRef(event.reason)) throw new Error('D_BATCH_IMPORT_OBSERVATION_FAILURE_INVALID');
    chunk.observationInFlight = false;
    chunk.lastObservationFailure = event.reason;
    if (chunk.observationReads >= job.observationPolicy.maxQueries) {
      chunk.status = 'observation_stopped';
      chunk.stopReason = 'query_limit';
    }
  } else if (event.kind === 'batch_observation_stopped') {
    if (!['waiting_platform','observed_pending','unknown_outcome'].includes(chunk.status) ||
        chunk.taskId === null || event.taskId !== chunk.taskId || chunk.observationInFlight ||
        !['query_limit','policy_expired'].includes(event.reason) ||
        (event.reason === 'query_limit' && chunk.observationReads < job.observationPolicy.maxQueries) ||
        (event.reason === 'policy_expired' && Date.parse(observedAt) < Date.parse(job.observationPolicy.expiresAt))) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_STOP_INVALID');
    }
    chunk.status = 'observation_stopped';
    chunk.stopReason = event.reason;
  } else if (event.kind === 'batch_import_observed') {
    if (!['waiting_platform', 'observed_pending', 'unknown_outcome'].includes(chunk.status) ||
        !chunk.observationInFlight ||
        Date.parse(observedAt) >= Date.parse(job.observationPolicy.expiresAt) ||
        chunk.taskId === null || event.taskId !== chunk.taskId ||
        !Array.isArray(event.results) || !isDeepStrictEqual(event.results.map(result => result.offerId), chunk.offerIds) ||
        event.results.some(result => !['imported', 'platform_failed', 'platform_skipped', 'waiting_platform', 'unknown_outcome'].includes(result.classification) ||
          result.importObservation?.taskId !== event.taskId ||
          (result.importObservation.merchantSku !== null && result.importObservation.merchantSku !== result.offerId) ||
          (result.classification === 'imported' && (!/^[1-9][0-9]*$/.test(result.importObservation.productId) ||
            !Number.isSafeInteger(Number(result.importObservation.productId)))))) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_INVALID');
    }
    if (chunk.results?.some((prior, index) =>
      ['imported', 'platform_failed', 'platform_skipped'].includes(prior.classification) &&
      (event.results[index].classification !== prior.classification ||
        (prior.classification === 'imported' &&
          event.results[index].importObservation.productId !== prior.importObservation.productId)))) {
      throw new Error('D_BATCH_IMPORT_TERMINAL_OFFER_CHANGED');
    }
    chunk.results = clone(event.results);
    chunk.observationInFlight = false;
    chunk.status = event.results.some(result => result.classification === 'unknown_outcome') ? 'unknown_outcome' :
      event.results.some(result => result.classification === 'waiting_platform') ? 'observed_pending' :
      event.results.some(result => result.classification === 'platform_failed') ? 'platform_failed' :
      event.results.some(result => result.classification === 'platform_skipped') ? 'platform_skipped' : 'observed_imported';
    if (['unknown_outcome','observed_pending'].includes(chunk.status) &&
        chunk.observationReads >= job.observationPolicy.maxQueries) {
      chunk.status = 'observation_stopped';
      chunk.stopReason = 'query_limit';
    }
  } else throw new Error('D_BATCH_IMPORT_EVENT_INVALID');
  next.revision++;
  next.updatedAt = observedAt;
  next.status = statusFor(next.chunks);
  assertJob(next);
  return Object.freeze(next);
}

/** Expired leases can be replaced without changing a saved intent or replaying a task. */
export function reclaimDBatchImportJob({ job, workerId, workerVersion, leaseId, leaseExpiresAt, observedAt }) {
  assertJob(job);
  if (!validRef(workerId) || !validRef(workerVersion) || !validRef(leaseId) || !validTime(observedAt) || !validTime(leaseExpiresAt) ||
      Date.parse(observedAt) < Date.parse(job.leaseExpiresAt) ||
      Date.parse(leaseExpiresAt) <= Date.parse(observedAt)) throw new Error('D_BATCH_IMPORT_RECLAIM_INVALID');
  const next = { ...clone(job), workerId, workerVersion, leaseId, leaseExpiresAt, updatedAt: observedAt,
    revision: job.revision + 1 };
  for (const chunk of next.chunks) chunk.observationInFlight = false;
  assertJob(next);
  return Object.freeze(next);
}
