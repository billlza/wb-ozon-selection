import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFormalC1C2Fixture } from './formal-c1-flow-fixture.mjs';
import { c1AiSoftwareJobFixture, c1AiSoftwareJobResultEnvelope } from './c1-ai-software-job-fixture.mjs';
import { finalAssets, productionAuthorizationInputFixture } from '../helpers/c2-software-fixture.mjs';
import { createProductionAuthorization } from '../../lib/production-authorization.mjs';
import { createJsonBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { bindSoftwareJobAdmissionForEnqueue } from '../../lib/software-job-admission.mjs';
import { claimSoftwareJobLease, markSoftwareJobExternalRequestStarted, settleSoftwareJob } from '../../lib/software-job-contract.mjs';
import { fingerprintCanonicalRecord } from '../../lib/production-contract-primitives.mjs';

const FIXED_AT = '2026-08-22T07:00:00.000Z';
const SOURCE_AT = '2026-08-22T06:00:00.000Z';
const JOB_TERMINAL_AT = '2026-08-22T02:02:00.000Z';
const clone = value => structuredClone(value);
const skuOf = candidate => candidate.lifecycleV11.skuPackage;

export const RUNTIME_READINESS_HISTORY_LIMITS = Object.freeze({
  minimumBytes: 16_800_001,
  maximumBytes: 32 * 1024 * 1024,
  maximumEvidenceRows: 320,
  maximumReferenceAttributes: 64,
  candidates: 65,
  productionCandidates: 5,
  idempotencyRecords: 24,
  detachedHistoryRecords: 1,
  productionEntityRecords: 5
});

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`RUNTIME_READINESS_HISTORY_FIXTURE_BUDGET_INVALID:${label}`);
  }
}

function evidenceHistory(candidateId, count) {
  const note = 'synthetic archived market observation '.repeat(64);
  return Array.from({ length: count }, (_, index) => ({
    evidenceRef: `evidence:synthetic-readiness:${candidateId}:${index}`,
    sourceUrl: `https://example.test/readiness/${index}`,
    observedAt: FIXED_AT,
    attributes: { ordinal: index, note }
  }));
}

function productionCandidate(index, { storeRef, evidenceRows, referenceAttributeCount }) {
  const candidateId = `candidate:synthetic-readiness:production:${index}`;
  const supplierSkuId = `SYNTHETIC-READINESS-${index}`;
  const formal = createFormalC1C2Fixture({
    candidateId, supplierSkuId, storeRef, at: SOURCE_AT,
    productName: '合成健康检查置物架', categoryPath: 'Дом / Полки',
    categoryName: 'Полки для ванной', material: 'plastic', variantKey: `颜色:${supplierSkuId}`,
    salesSnapshotVersion: 'sales-snapshot-v1.1',
    salesAttributes: Object.fromEntries(Array.from({ length: referenceAttributeCount }, (_, ordinal) =>
      [`Свойство ${ordinal}`, `Синтетическая характеристика ${ordinal}`]))
  });
  const sources = finalAssets();
  const assets = Array.from({ length: 15 }, (_, ordinal) => ({
    ...clone(sources[ordinal === 0 ? 0 : 1]),
    assetId: `final:synthetic-readiness:${index}:${ordinal}`,
    assetRef: `https://assets.example.com/readiness/${index}/${ordinal}.jpg`,
    sha256: fingerprintCanonicalRecord({ candidateId, ordinal, syntheticAssetIdentity: true }),
    order: ordinal + 1
  }));
  const input = productionAuthorizationInputFixture({
    candidateId, supplierSkuId, storeRef, sourceSkuPackage: formal.merged.skuPackage,
    assets, sourceCandidateRevision: 12, merchantSku: `SYNTHETIC-READINESS-MERCHANT-${index}`
  });
  const candidate = clone(input.candidate);
  let result = { schemaVersion: 'c1-content-review-result-v1', status: 'confirmed' };
  if (index === 0) {
    const authorization = createProductionAuthorization(input);
    candidate.lifecycleV11.skuPackage = clone(authorization.skuPackage);
    candidate.dataRevision = authorization.productionAuthorization.resultCandidateRevision;
    result = {
      schemaVersion: 'single-owner-production-authorization-result-v1',
      productionAuthorization: clone(authorization.productionAuthorization),
      dHandoff: clone(authorization.dHandoff), productionPlanCreated: false,
      executionIntentCreated: false, softwareJobCreated: false, dWritePermissionGranted: false,
      externalRequests: 0, platformWrites: 0
    };
  }
  candidate.productName = '合成健康检查置物架';
  candidate.workflowStatus = 'listing_preparation';
  candidate.history = [];
  candidate.readinessEvidenceHistory = evidenceHistory(candidateId, evidenceRows);
  return { candidate, result };
}

// These are pure, synthetic lease/result transitions. No consumer, gateway or
// platform request is executed, and every returned job is already terminal.
function terminalJob(index, storeRef) {
  const fixture = c1AiSoftwareJobFixture({
    candidateId: `candidate:synthetic-readiness:job:${index}`,
    supplierSkuId: `SYNTHETIC-READINESS-JOB-${index}`, storeRef,
    jobId: `software-job:synthetic-readiness:${index}`,
    authorizationId: `authorization:c1-ai-draft:synthetic-readiness-${index}`,
    credentialAlias: `gateway-alias:synthetic-readiness-${index}`
  });
  const admitted = bindSoftwareJobAdmissionForEnqueue({
    document: fixture.document, job: fixture.job, observedAt: fixture.at, phase: 'enqueue_current'
  });
  const claimed = claimSoftwareJobLease({
    job: admitted, worker: fixture.worker, leaseId: `lease:synthetic-readiness:${index}`,
    serverTime: fixture.at, leaseDurationMs: 180_000
  });
  const waiting = markSoftwareJobExternalRequestStarted({
    job: claimed, workerId: fixture.worker.workerId, leaseId: claimed.leaseId,
    externalRequestRef: `request:synthetic-readiness:${index}`, serverTime: fixture.at
  });
  const status = index < 8 ? 'completed' : index < 15 ? 'failed' : 'unknown_outcome';
  const resultEnvelope = status === 'completed' ? c1AiSoftwareJobResultEnvelope(waiting, fixture.request) : null;
  const job = settleSoftwareJob({
    job: waiting, workerId: fixture.worker.workerId, leaseId: waiting.leaseId, status,
    externalRequestState: status === 'completed' ? 'succeeded' : status,
    serverTime: JOB_TERMINAL_AT, resultEnvelope,
    resultRef: resultEnvelope?.resultRef ?? null,
    failureClass: status === 'failed' ? 'synthetic-readiness-explicit-failure' : null
  });
  return {
    candidate: clone(fixture.candidate), job: clone(job),
    authorization: clone(fixture.document.runtime.softwareJobAuthorizationRecords[0]),
    credentialBinding: clone(fixture.credentialBinding)
  };
}

function idempotencyRecord(production, index) {
  const { candidate, result } = production;
  const input = { action: 'synthetic_readiness_history', candidateId: candidate.id,
    sourceRevision: candidate.dataRevision - 1, ordinal: index };
  return {
    schemaVersion: 'business-idempotency-record-v1', candidateId: candidate.id,
    skuPackageId: skuOf(candidate).skuPackageId, action: input.action,
    idempotencyKey: `synthetic:readiness-history:${String(index).padStart(2, '0')}`,
    sourceRevision: input.sourceRevision, resultRevision: candidate.dataRevision,
    inputFingerprint: fingerprintCanonicalRecord(input), actorId: 'synthetic-owner',
    savedAt: FIXED_AT, candidateSnapshot: clone(candidate), result: clone(result)
  };
}

/** Return a persisted JSON shape, not a hydrated domain snapshot.
 * Four current aggregates and their replies pass through the real JSON writer;
 * the fifth aggregate, one predecessor and four replies remain historical inline
 * DTOs, as covered by production-entity-persistence.test.mjs. The registry's five
 * identities are generated by the existing producers and repository, never edited.
 * File padding fills only the final size gap; production-bearing candidates and
 * repeated idempotent snapshots carry bounded nested evidence before that padding.
 */
export async function runtimeReadinessHistoryFixture({
  targetBytes = RUNTIME_READINESS_HISTORY_LIMITS.minimumBytes,
  evidenceRows = 64,
  referenceAttributeCount = 36,
  storeRef = { stableStoreId: 'dandanshu', platformStoreId: 'seller-dandanshu-001', mappingVersion: 'stores-v1' }
} = {}) {
  boundedInteger(targetBytes, RUNTIME_READINESS_HISTORY_LIMITS.minimumBytes, RUNTIME_READINESS_HISTORY_LIMITS.maximumBytes, 'targetBytes');
  boundedInteger(evidenceRows, 0, RUNTIME_READINESS_HISTORY_LIMITS.maximumEvidenceRows, 'evidenceRows');
  boundedInteger(referenceAttributeCount, 0, RUNTIME_READINESS_HISTORY_LIMITS.maximumReferenceAttributes, 'referenceAttributeCount');
  const production = Array.from({ length: 5 }, (_, index) =>
    productionCandidate(index, { storeRef, evidenceRows, referenceAttributeCount }));
  const jobs = Array.from({ length: 16 }, (_, index) => terminalJob(index, storeRef));
  const records = Array.from({ length: 24 }, (_, index) => idempotencyRecord(production[index % 5], index));
  const legacyId = production[4].candidate.id;
  const candidates = [
    ...production.slice(0, 4).map(item => clone(item.candidate)),
    ...jobs.map(item => clone(item.candidate)),
    ...Array.from({ length: 44 }, (_, index) => ({
      id: `candidate:synthetic-readiness:ordinary:${index}`, dataRevision: 7,
      productName: '合成健康检查普通候选', targetPlatform: 'ozon',
      targetStore: storeRef.stableStoreId, storeRef: clone(storeRef),
      workflowStatus: 'listing_preparation', history: []
    }))
  ];
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-readiness-history-fixture-'));
  try {
    const filePath = path.join(directory, 'synthetic-state.json');
    await writeFile(filePath, JSON.stringify({
      meta: { version: 2, automationStarted: false, updatedAt: FIXED_AT }, rules: {},
      candidates: [], evidencePacks: [], currentCommissionCatalogs: [], dispatches: [],
      runtime: { softwareJobs: [], idempotencyRecords: [], operationAudit: [] }
    }));
    const repository = createJsonBusinessStateRepository({ filePath });
    await repository.transact(document => {
      document.candidates = candidates;
      document.runtime.softwareJobs = jobs.map(item => clone(item.job));
      document.runtime.softwareJobAuthorizationRecords = jobs.map(item => clone(item.authorization));
      document.runtime.softwareJobCredentialBindings = jobs.map(item => clone(item.credentialBinding));
      document.runtime.idempotencyRecords = records.filter(record => record.candidateId !== legacyId);
      return { changed: true, document, result: null };
    });
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    document.candidates.splice(4, 0, clone(production[4].candidate));
    document.runtime.idempotencyRecords.push(...records.filter(record => record.candidateId === legacyId));
    document.runtime.idempotencyRecords.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
    document.c1FinalPlanRevisionHistoryRecords = [{
      schemaVersion: 'c1-final-plan-revision-history-v1',
      preparationId: 'final-plan:synthetic-readiness:inline-history',
      candidateId: production[0].candidate.id,
      previousSkuPackage: clone(skuOf(production[0].candidate)), previousC1References: {},
      createdAt: FIXED_AT
    }];
    document.syntheticReadinessSizePadding = '';
    const unpaddedBytes = Buffer.byteLength(JSON.stringify(document));
    if (unpaddedBytes > targetBytes) {
      throw new Error(`RUNTIME_READINESS_HISTORY_FIXTURE_TARGET_TOO_SMALL:${unpaddedBytes}:${targetBytes}`);
    }
    document.syntheticReadinessSizePadding = 'x'.repeat(targetBytes - unpaddedBytes);
    const bytes = Buffer.byteLength(JSON.stringify(document));
    const terminalJobs = Object.fromEntries(['completed', 'failed', 'unknown_outcome'].map(status =>
      [status, document.runtime.softwareJobs.filter(job => job.status === status).length]));
    const shape = {
      bytes, unpaddedBytes, sizePaddingBytes: targetBytes - unpaddedBytes,
      candidates: document.candidates.length, productionCandidates: 5,
      productionEntityRecords: document.productionEntityRecords.length,
      productionEntityKinds: Object.fromEntries(['final_card_input_snapshot', 'production_authorization'].map(kind =>
        [kind, document.productionEntityRecords.filter(record => record.kind === kind).length])),
      detachedHistoryRecords: document.c1FinalPlanRevisionHistoryRecords.length,
      idempotencyRecords: document.runtime.idempotencyRecords.length,
      legacyInlineCandidates: 1, legacyInlineIdempotencySnapshots: records.filter(record => record.candidateId === legacyId).length,
      terminalJobs, activeJobs: document.runtime.softwareJobs.filter(job => !Object.hasOwn(terminalJobs, job.status)).length,
      evidenceRowsPerProductionCandidate: evidenceRows, referenceAttributeCount,
      fixedAt: FIXED_AT, externalRequests: 0, platformWrites: 0
    };
    assert.equal(bytes, targetBytes);
    assert.equal(shape.candidates, RUNTIME_READINESS_HISTORY_LIMITS.candidates);
    assert.equal(shape.productionEntityRecords, RUNTIME_READINESS_HISTORY_LIMITS.productionEntityRecords);
    assert.equal(shape.idempotencyRecords, RUNTIME_READINESS_HISTORY_LIMITS.idempotencyRecords);
    assert.deepEqual(terminalJobs, { completed: 8, failed: 7, unknown_outcome: 1 });
    assert.equal(shape.activeJobs, 0);
    return { document, shape };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
