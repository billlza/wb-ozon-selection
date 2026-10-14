import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { imageTextFixture, OCR_AT } from './fixtures/c1-image-text-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createC1FinalPlanRevisionUseCase } from '../lib/c1-final-plan-revision-use-case.mjs';
import { buildOwnerCargoFactsRecord } from '../lib/cargo-facts-declaration.mjs';
function setup() {
  const f = imageTextFixture();
  f.candidate.cargoFactsV1 = buildOwnerCargoFactsRecord({ candidate: f.candidate, declaredAt: OCR_AT,
    facts: { batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true, irregularShape: false } });
  f.repository = createMemoryBusinessStateRepository({ candidates: [f.candidate] });
  f.input.skuPackageId = f.candidate.lifecycleV11.skuPackage.skuPackageId;
  f.api = createC1FinalPlanRevisionUseCase({ repository: f.repository, runtimeMode: 'local_development', serverClock: f.serverClock });
  return f;
}
test('new final-plan preparation is atomically persisted once with immutable predecessor and no authorization', async () => {
  const f = setup(), before = structuredClone(f.candidate);
  const result = await f.api.prepare({ actor: f.owner, input: f.input });
  assert.equal(result.candidate.dataRevision, before.dataRevision + 1);
  assert.equal(result.result.resultCandidateRevision, result.candidate.dataRevision);
  assert.equal(result.candidate.lifecycleV11.skuPackage.c1ProductPlan.batteryAssessment.containsBattery.value, false);
  const snapshot = await f.repository.readSnapshot();
  assert.equal(snapshot.c1FinalPlanRevisionHistoryRecords.length, 1);
  assert.deepEqual(snapshot.c1FinalPlanRevisionHistoryRecords[0].previousSkuPackage, before.lifecycleV11.skuPackage);
  assert.equal(Object.hasOwn(result.candidate.lifecycleV11.c1FinalPlanRevisionHistory[0], 'previousSkuPackage'), false);
  assert.equal(result.result.productionAuthorized, false);
  const replay = await f.api.prepare({ actor: f.owner, input: f.input });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(replay.candidate, result.candidate);
  assert.equal((await f.repository.readSnapshot()).c1FinalPlanRevisionHistoryRecords.length, 1);
});
test('identity or revision mismatch is rejected before creating a new plan', async () => {
  for (const input of [{ skuPackageId: 'another-sku' }, { expectedRevision: 999 }]) {
    const f = setup();
    await assert.rejects(f.api.prepare({ actor: f.owner, input: { ...f.input, ...input } }), /SOURCE_MISMATCH|REVISION_CONFLICT/);
    assert.equal((await f.repository.readSnapshot()).candidates[0].dataRevision, f.candidate.dataRevision);
  }
});

test('unsettled color dictionary read cannot be cleared by a new final plan', async () => {
  for (const status of ['request_sent', 'unknown_outcome']) {
    const f = setup();
    await f.repository.transact(document => {
      document.candidates[0].lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': {
        schemaVersion: 'c1-color-dictionary-read-v1', status,
        authorizationId: `synthetic:${status}`, externalRequestRef: `synthetic:${status}:request`
      } };
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.api.prepare({ actor: f.owner, input: f.input }),
      /C1_COLOR_DICTIONARY_READ_UNSETTLED/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal(f.calls.length, 0);
  }
});

test('concurrent duplicate preparation commits one candidate, predecessor, audit and idempotency record', async () => {
  const f = setup();
  const results = await Promise.all([f.api.prepare({ actor: f.owner, input: f.input }), f.api.prepare({ actor: f.owner, input: f.input })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['committed', 'idempotent_replay']);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.c1FinalPlanRevisionHistoryRecords.length, 1);
  assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(saved.runtime.idempotencyRecords.length, 1);
  assert.equal(saved.candidates[0].dataRevision, f.candidate.dataRevision + 1);
});

test('idempotent replay rejects missing, duplicate or replaced detached predecessor history', async () => {
  for (const corrupt of [
    d => { d.c1FinalPlanRevisionHistoryRecords = []; },
    d => { d.c1FinalPlanRevisionHistoryRecords.push(structuredClone(d.c1FinalPlanRevisionHistoryRecords[0])); },
    d => { d.c1FinalPlanRevisionHistoryRecords[0].previousSkuPackage.supplierSkuId = 'foreign-sku'; }
  ]) {
    const f = setup(); await f.api.prepare({ actor: f.owner, input: f.input });
    await f.repository.transact(document => { corrupt(document); return { changed: true, document, result: null }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.api.prepare({ actor: f.owner, input: f.input }), /HISTORY_|HALF_STATE/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('atomic JSON write failure rolls back candidate, detached history, audit and idempotency together', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { createJsonBusinessStateRepository } = await import('../lib/business-state-repository.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'final-revision-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = `${directory}/state.json`, f = setup(), initial = await f.repository.readSnapshot();
  await writeFile(filePath, JSON.stringify(initial));
  let writes = 0;
  const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async (_path, document) => {
    writes++; assert.equal(document.c1FinalPlanRevisionHistoryRecords.length, 1);
    assert.equal(document.candidates[0].dataRevision, f.candidate.dataRevision + 1);
    assert.equal(document.runtime.idempotencyRecords.length, 1);
    throw new Error('synthetic_atomic_replace_failure');
  } });
  const api = createC1FinalPlanRevisionUseCase({ repository, runtimeMode: 'local_development', serverClock: f.serverClock });
  await assert.rejects(api.prepare({ actor: f.owner, input: f.input }), /synthetic_atomic_replace_failure/);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), initial);
  assert.deepEqual(await repository.readSnapshot(), initial);
});

test('image extraction settles first, preparation failure preserves its receipt and retry performs zero extra extraction', async () => {
  const { createC1ImageTextUseCase } = await import('../lib/c1-image-text-use-case.mjs');
  const f = setup(), ocr = createC1ImageTextUseCase({ ...f, runtimeMode: 'local_development' });
  const extracted = await ocr.extract({ actor: f.owner, input: { candidateId: f.input.candidateId, expectedRevision: f.input.expectedRevision } });
  assert.equal(extracted.result.status, 'completed');
  const afterOcr = await f.repository.readSnapshot(), calls = f.calls.length;
  assert.deepEqual(afterOcr.candidates[0].lifecycleV11.skuPackage, f.candidate.lifecycleV11.skuPackage);
  await assert.rejects(f.api.prepare({ actor: f.owner, input: { ...f.input, expectedRevision: extracted.candidate.dataRevision, skuPackageId: 'wrong' } }), /SOURCE_MISMATCH/);
  assert.deepEqual(await f.repository.readSnapshot(), afterOcr);
  const reused = await ocr.extract({ actor: f.owner, input: { candidateId: f.input.candidateId, expectedRevision: extracted.candidate.dataRevision } });
  assert.equal(reused.status, 'already_current');
  assert.equal(f.calls.length, calls);
  const prepared = await f.api.prepare({ actor: f.owner, input: { ...f.input, expectedRevision: reused.candidate.dataRevision } });
  assert.equal(prepared.status, 'committed');
  assert.equal(prepared.candidate.lifecycleV11.c1ImageTextEvidenceV1.receiptId, extracted.result.receiptId);
  assert.equal(prepared.candidate.lifecycleV11.skuPackage.productionAuthorization, null);
});
