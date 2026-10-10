import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTextFixture, OCR_AT } from './fixtures/c1-image-text-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { executeBusinessMutation } from '../lib/business-mutation-transaction.mjs';
import { prepareC1FinalPlanRevision } from '../lib/c1-final-plan-revision-preparation.mjs';
import { buildOwnerCargoFactsRecord } from '../lib/cargo-facts-declaration.mjs';
import { BUSINESS_CANDIDATE_MAX_NODES } from '../lib/production-contract-primitives.mjs';
function fixture() {
  const f = imageTextFixture();
  f.candidate.cargoFactsV1 = buildOwnerCargoFactsRecord({ candidate: f.candidate, declaredAt: OCR_AT,
    facts: { batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true, irregularShape: false } });
  const prepared = prepareC1FinalPlanRevision({ candidate: f.candidate, expectedRevision: f.candidate.dataRevision, preparedAt: OCR_AT });
  prepared.candidate.dataRevision = f.candidate.dataRevision;
  const outcome = { candidate: prepared.candidate, finalPlanHistoryRecord: prepared.historyRecord, result: { status: 'prepared' } };
  const repository = createMemoryBusinessStateRepository({ candidates: [f.candidate] });
  const input = { repository, runtimeMode: 'local_development', actor: f.owner, requiredRoles: ['owner'], action: 'prepare_final_plan_revision',
    candidateId: f.candidate.id, skuPackageId: f.candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: f.candidate.dataRevision, idempotencyKey: 'synthetic:history:prepare', inputFingerprint: 'synthetic:history:input',
    auditEventId: 'synthetic:history:audit', serverClock: f.serverClock, mutate: () => structuredClone(outcome) };
  return { ...f, repository, input, outcome };
}

test('detached history cannot be omitted, change predecessor identity, or appear under another operation', async () => {
  for (const mutate of [
    f => { delete f.outcome.finalPlanHistoryRecord; },
    f => { f.outcome.finalPlanHistoryRecord.candidateId = 'other'; },
    f => { f.outcome.finalPlanHistoryRecord.previousSkuPackage.supplierSkuId = 'other'; },
    f => { f.outcome.finalPlanHistoryRecord.sourceCandidateRevision -= 1; },
    f => { f.outcome.finalPlanHistoryRecord.unexpected = true; },
    f => { f.input.action = 'unrelated_operation'; }
  ]) {
    const f = fixture(); mutate(f); const before = await f.repository.readSnapshot();
    await assert.rejects(executeBusinessMutation(f.input), /C1_FINAL_REVISION_HISTORY_/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('history must preserve every archived C1 reference without accepting invented null reference names', async () => {
  for (const mutate of [
    history => { delete history.previousC1References.c2UploadDraft; },
    history => { history.previousC1References = []; },
    history => { history.previousC1References.unknownReference = null; }
  ]) {
    const f = fixture(); mutate(f.outcome.finalPlanHistoryRecord); const before = await f.repository.readSnapshot();
    await assert.rejects(executeBusinessMutation(f.input), /C1_FINAL_REVISION_HISTORY_/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('duplicate predecessor ID rejects the entire commit, including candidate and audit changes', async () => {
  const f = fixture();
  await f.repository.transact(document => {
    document.c1FinalPlanRevisionHistoryRecords = [structuredClone(f.outcome.finalPlanHistoryRecord)];
    return { changed: true, document, result: null };
  });
  const before = await f.repository.readSnapshot();
  await assert.rejects(executeBusinessMutation(f.input), /C1_FINAL_REVISION_HISTORY_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test('history loading rejects missing or duplicate records before invoking the mutation', async () => {
  for (const corrupt of [
    d => { d.c1FinalPlanRevisionHistoryRecords = []; },
    d => { d.c1FinalPlanRevisionHistoryRecords = [null]; },
    d => { d.c1FinalPlanRevisionHistoryRecords.push(structuredClone(d.c1FinalPlanRevisionHistoryRecords[0])); }
  ]) {
    const f = fixture(); await executeBusinessMutation(f.input);
    await f.repository.transact(document => { corrupt(document); return { changed: true, document, result: null }; });
    const before = await f.repository.readSnapshot(); let calls = 0;
    await assert.rejects(executeBusinessMutation({ ...f.input, expectedRevision: f.input.expectedRevision + 1,
      action: 'inspect_final_history', idempotencyKey: 'synthetic:history:read', includeFinalPlanHistory: true,
      mutate: ({ candidate }) => { calls++; return { candidate, result: { inspected: true } }; } }), /HISTORY_|RUNTIME_IDENTITY_INVALID/);
    assert.equal(calls, 0);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('history storage rejects foreign scope and secret-bearing records without persisting either', async () => {
  for (const [corrupt, error] of [
    [d => { d.c1FinalPlanRevisionHistoryRecords[0].candidateId = 'foreign'; }, /PRODUCTION_ENTITY_SCOPE_MISMATCH/],
    [d => { d.c1FinalPlanRevisionHistoryRecords[0].previousC1References.apiKey = 'synthetic-secret-value'; }, /RUNTIME_IDENTITY_INVALID/]
  ]) {
    const f = fixture(); await executeBusinessMutation(f.input);
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.repository.transact(document => { corrupt(document); return { changed: true, document, result: null }; }), error);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('explicit history loading supplies a detached copy and never overwrites central predecessor data', async () => {
  const f = fixture(); await executeBusinessMutation(f.input);
  const saved = await f.repository.readSnapshot(), beforeHistory = structuredClone(saved.c1FinalPlanRevisionHistoryRecords);
  await executeBusinessMutation({ ...f.input, expectedRevision: f.input.expectedRevision + 1,
    action: 'inspect_final_history', idempotencyKey: 'synthetic:history:read', includeFinalPlanHistory: true,
    mutate: ({ candidate, finalPlanHistoryRecord }) => {
      assert.deepEqual(finalPlanHistoryRecord, beforeHistory[0]);
      finalPlanHistoryRecord.previousSkuPackage.supplierSkuId = 'local-copy-edit';
      return { candidate, result: { inspected: true } };
    } });
  assert.deepEqual((await f.repository.readSnapshot()).c1FinalPlanRevisionHistoryRecords, beforeHistory);
});

test('history separation does not raise or bypass the candidate 20,000-node resource boundary', async () => {
  assert.equal(BUSINESS_CANDIDATE_MAX_NODES, 20000);
  const f = fixture(), before = await f.repository.readSnapshot();
  f.outcome.candidate.syntheticResourceOverflow = Array.from({ length: 20000 }, () => 1);
  await assert.rejects(executeBusinessMutation(f.input), /RESOURCE_LIMIT/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});
