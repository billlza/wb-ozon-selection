import test from 'node:test';
import assert from 'node:assert/strict';
import { createDBatchImportJob, applyDBatchImportEvent } from '../lib/d-batch-import-state.mjs';

const at = '2026-09-27T10:00:00.000Z';
const lease = '2026-09-27T10:01:00.000Z';
const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1',
  policyRef: 'policy:synthetic:batch-observation', version: 'v1', maxQueries: 10, intervalMs: 0,
  expiresAt: '2026-09-27T12:00:00.000Z', requestTimeoutMs: 10_000 };
const batch = { batchId: 'd-batch:synthetic', status: 'authorized', externalRequestState: 'not_sent',
  excludedOfferIds: ['offer-01'], members: Array.from({ length: 31 }, (_, index) => ({ offerId: `offer-${String(index + 2).padStart(2, '0')}` })) };
const chunks = [0, 10, 20, 30].map(start => ({ offerIds: batch.members.slice(start, start + 10).map(member => member.offerId),
  limitEvidenceRef: 'synthetic:current-limit' }));
const scope = { workerId: 'worker:synthetic', workerVersion: 'v1', leaseId: 'lease:synthetic', observedAt: at };
const apply = (job, event) => applyDBatchImportEvent({ job, event, ...scope });
const observe = (job, event) => apply(apply(job, { kind: 'batch_observation_started',
  chunkIndex: event.chunkIndex, offerIds: event.offerIds, taskId: event.taskId }), event);

test('32 specifications exclude the first; 31 offers persist four bounded task intents and per-offer results', () => {
  let job = createDBatchImportJob({ batch, chunks, ...scope, createdAt: at, leaseExpiresAt: lease, observationPolicy });
  assert.deepEqual(job.chunks.map(chunk => chunk.offerIds.length), [10, 10, 10, 1]);
  assert.equal(job.chunks.flatMap(chunk => chunk.offerIds).includes('offer-01'), false);
  for (const chunk of job.chunks) {
    const offerIds = chunk.offerIds;
    job = apply(job, { kind: 'batch_import_intent', chunkIndex: chunk.index, offerIds });
    assert.equal(job.chunks[chunk.index].status, 'intent');
    assert.throws(() => apply(job, { kind: 'batch_import_intent', chunkIndex: chunk.index, offerIds }), /REPLAY_BLOCKED/);
    job = apply(job, { kind: 'batch_import_task_received', chunkIndex: chunk.index,
      offerIds, taskId: String(501 + chunk.index) });
  }
  assert.equal(job.status, 'waiting_platform');
  for (const chunk of job.chunks) {
    job = observe(job, { kind: 'batch_import_observed', chunkIndex: chunk.index, offerIds: chunk.offerIds,
      taskId: String(501 + chunk.index), results: chunk.offerIds.map(offerId => ({ offerId,
        classification: offerId === 'offer-09' ? 'platform_failed' : 'imported',
        importObservation: { taskId: String(501 + chunk.index), merchantSku: offerId,
          productId: offerId === 'offer-09' ? null : '910001' } })) });
  }
  assert.equal(job.status, 'partial_failure');
  assert.equal(job.chunks.flatMap(chunk => chunk.results).filter(result => result.classification === 'imported').length, 30);
  assert.equal(job.chunks.flatMap(chunk => chunk.results).filter(result => result.classification === 'platform_failed').length, 1);
  assert.throws(() => apply(job, { kind: 'batch_import_intent', chunkIndex: 0, offerIds: chunks[0].offerIds }), /REPLAY_BLOCKED/);
});

test('missing receipt, wrong offer, wrong task and expired lease never reopen a write', () => {
  const admitted = createDBatchImportJob({ batch, chunks, ...scope, createdAt: at, leaseExpiresAt: lease, observationPolicy });
  assert.throws(() => apply(admitted, { kind: 'batch_import_intent', chunkIndex: 1, offerIds: chunks[1].offerIds }), /REPLAY_BLOCKED/);
  const sent = apply(admitted, { kind: 'batch_import_intent', chunkIndex: 0, offerIds: chunks[0].offerIds });
  assert.equal(sent.status, 'unknown_outcome');
  assert.throws(() => apply(sent, { kind: 'batch_import_intent', chunkIndex: 0, offerIds: chunks[0].offerIds }), /REPLAY_BLOCKED/);
  assert.throws(() => apply(sent, { kind: 'batch_import_task_received', chunkIndex: 0,
    offerIds: ['wrong'], taskId: '501' }), /OFFER_SCOPE_MISMATCH/);
  assert.throws(() => applyDBatchImportEvent({ job: sent, event: { kind: 'batch_import_task_received',
    chunkIndex: 0, offerIds: chunks[0].offerIds, taskId: '501' }, workerId: scope.workerId,
  leaseId: scope.leaseId, observedAt: lease }), /LEASE_OR_SCOPE_INVALID/);
  const received = apply(sent, { kind: 'batch_import_task_received', chunkIndex: 0,
    offerIds: chunks[0].offerIds, taskId: '501' });
  assert.throws(() => observe(received, { kind: 'batch_import_observed', chunkIndex: 0,
    offerIds: chunks[0].offerIds, taskId: '502', results: [] }), /OBSERVATION_NOT_DUE/);
  assert.throws(() => createDBatchImportJob({ batch, chunks: [chunks[0]], ...scope,
    createdAt: at, leaseExpiresAt: lease, observationPolicy }), /MEMBER_SCOPE_MISMATCH/);
});

test('proven prewrite stop is terminal, idempotent and distinct from historical intent',()=>{
  const admitted=createDBatchImportJob({batch,chunks,...scope,createdAt:at,leaseExpiresAt:lease,
    observationPolicy});
  const intent=apply(admitted,{kind:'batch_import_intent',chunkIndex:0,offerIds:chunks[0].offerIds});
  assert.equal(intent.status,'unknown_outcome');
  const event={kind:'batch_import_prewrite_blocked',chunkIndex:0,offerIds:chunks[0].offerIds,
    requestTransmission:'not_attempted',reasonCode:'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED'};
  assert.throws(()=>apply(intent,{...event,requestTransmission:'attempted'}),/PREWRITE_PROOF_INVALID/);
  assert.throws(()=>apply(intent,{...event,reasonCode:'secret: raw message'}),/PREWRITE_PROOF_INVALID/);
  const blocked=apply(intent,event);
  assert.equal(blocked.status,'prewrite_blocked');
  assert.equal(blocked.chunks[0].taskId,null);
  assert.equal(blocked.chunks[0].requestTransmission,'not_attempted');
  assert.equal(apply(blocked,event),blocked);
  assert.throws(()=>apply(blocked,{...event,reasonCode:'D_BATCH_IMPORT_SEND_GUARD_BLOCKED'}),
    /PREWRITE_PROOF_INVALID/);
  assert.throws(()=>apply(blocked,{kind:'batch_import_intent',chunkIndex:0,
    offerIds:chunks[0].offerIds}),/REPLAY_BLOCKED/);
  assert.throws(()=>apply(blocked,{kind:'batch_import_task_received',chunkIndex:0,
    offerIds:chunks[0].offerIds,taskId:'501'}),/TASK_RECEIPT_INVALID/);
});

test('historical v2 intent remains readable and cannot acquire a v3 prewrite verdict',()=>{
  const current=createDBatchImportJob({batch,chunks,...scope,createdAt:at,leaseExpiresAt:lease,
    observationPolicy});
  const historical={...structuredClone(current),schemaVersion:'d-batch-import-job-v2'};
  const intent=apply(historical,{kind:'batch_import_intent',chunkIndex:0,offerIds:chunks[0].offerIds});
  assert.equal(intent.schemaVersion,'d-batch-import-job-v2');
  assert.equal(intent.status,'unknown_outcome');
  assert.throws(()=>apply(intent,{kind:'batch_import_prewrite_blocked',chunkIndex:0,
    offerIds:chunks[0].offerIds,requestTransmission:'not_attempted',
    reasonCode:'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED'}),/PREWRITE_PROOF_INVALID/);
  const received=apply(intent,{kind:'batch_import_task_received',chunkIndex:0,
    offerIds:chunks[0].offerIds,taskId:'501'});
  assert.equal(received.status,'waiting_platform');
  assert.equal(received.schemaVersion,'d-batch-import-job-v2');
});

test('a sent task stays observable when a later chunk is proven unsent',()=>{
  let job=createDBatchImportJob({batch,chunks,...scope,createdAt:at,leaseExpiresAt:lease,
    observationPolicy});
  job=apply(job,{kind:'batch_import_intent',chunkIndex:0,offerIds:chunks[0].offerIds});
  job=apply(job,{kind:'batch_import_task_received',chunkIndex:0,offerIds:chunks[0].offerIds,taskId:'501'});
  job=apply(job,{kind:'batch_import_intent',chunkIndex:1,offerIds:chunks[1].offerIds});
  job=apply(job,{kind:'batch_import_prewrite_blocked',chunkIndex:1,offerIds:chunks[1].offerIds,
    requestTransmission:'not_attempted',reasonCode:'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED'});
  assert.equal(job.status,'waiting_platform');
  assert.deepEqual(job.chunks.map(chunk=>chunk.status),['waiting_platform','prewrite_blocked','not_sent','not_sent']);
  job=observe(job,{kind:'batch_import_observed',chunkIndex:0,offerIds:chunks[0].offerIds,
    taskId:'501',results:chunks[0].offerIds.map(offerId=>({offerId,classification:'imported',
      importObservation:{taskId:'501',merchantSku:offerId,productId:'910001'}}))});
  assert.equal(job.status,'partial_failure');
});

test('mixed failed and pending offers remain observable until the pending offer settles', () => {
  const two = { ...batch, members: batch.members.slice(0, 2) };
  const offerIds = two.members.map(member => member.offerId);
  let job = createDBatchImportJob({ batch: two, chunks: [{ offerIds, limitEvidenceRef: 'synthetic:limit' }],
    ...scope, createdAt: at, leaseExpiresAt: lease, observationPolicy });
  job = apply(job, { kind: 'batch_import_intent', chunkIndex: 0, offerIds });
  job = apply(job, { kind: 'batch_import_task_received', chunkIndex: 0, offerIds, taskId: '501' });
  const failed = { offerId: offerIds[0], classification: 'platform_failed',
    importObservation: { taskId: '501', merchantSku: offerIds[0], productId: null } };
  const pending = { offerId: offerIds[1], classification: 'waiting_platform',
    importObservation: { taskId: '501', merchantSku: offerIds[1], productId: null } };
  job = observe(job, { kind: 'batch_import_observed', chunkIndex: 0, offerIds, taskId: '501',
    results: [failed, pending] });
  assert.equal(job.status, 'waiting_platform');
  assert.equal(job.chunks[0].status, 'observed_pending');
  assert.throws(() => observe(job, { kind: 'batch_import_observed', chunkIndex: 0, offerIds,
    taskId: '501', results: [{ ...failed, classification: 'imported',
      importObservation: { ...failed.importObservation, productId: '9001' } }, pending] }),
  /TERMINAL_OFFER_CHANGED/);
  job = observe(job, { kind: 'batch_import_observed', chunkIndex: 0, offerIds, taskId: '501',
    results: [failed, { ...pending, classification: 'imported',
      importObservation: { ...pending.importObservation, productId: '9002' } }] });
  assert.equal(job.status, 'partial_failure');
  assert.deepEqual(job.chunks[0].results.map(result => result.classification), ['platform_failed', 'imported']);
});
