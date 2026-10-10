import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { prepareOwnerProductFacts, readOwnerProductFacts, OWNER_PRODUCT_FACT_LABELS } from '../lib/owner-product-facts.mjs';
import { createOwnerProductFactsUseCase } from '../lib/owner-product-facts-use-case.mjs';
const facts = { productForm: '迷你背心', intendedUses: ['猫', '酒瓶'], closureType: '魔术贴', adjustable: true, detachable: null };
function setup() {
  const f = productionOwnerDecisionFixture();
  const input = { candidateId: f.candidate.id, skuPackageId: f.candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: f.candidate.dataRevision, facts: structuredClone(facts) };
  const pure = { candidate: f.candidate, facts, confirmedByUserId: f.args.actor.userId, confirmedAt: f.args.serverClock() };
  return { ...f, pure, input, api: createOwnerProductFactsUseCase(f.args) };
}
test('saved owner declaration binds exact supply and preserves all frozen state without assuming detachable', async () => {
  const f = setup(), frozen = structuredClone(f.candidate.lifecycleV11.skuPackage);
  const result = await f.api.save({ actor: f.args.actor, input: f.input });
  const declaration = readOwnerProductFacts(result.candidate);
  assert.deepEqual(declaration.facts, facts);
  assert.equal(declaration.facts.detachable, null);
  assert.equal(declaration.confirmedByUserId, f.args.actor.userId);
  assert.equal(declaration.sourceInstructionRef, null);
  assert.equal(declaration.sourceSupplySnapshotId, frozen.selectedSupplySnapshot.snapshotId);
  assert.deepEqual(declaration.sourceIdentity, frozen.g1Identity);
  assert.deepEqual(result.candidate.lifecycleV11.skuPackage, frozen);
  assert.equal(result.candidate.dataRevision, f.candidate.dataRevision + 1);
  assert.deepEqual(result.result, { declaration, productionAuthorized: false, newPlanCreated: false, externalRequests: 0, paidCalls: 0, platformWrites: 0 });
  assert.equal(OWNER_PRODUCT_FACT_LABELS.detachable, '是否可拆');
});
test('same revision repeated or concurrent save creates one declaration, audit and idempotency record', async () => {
  const f = setup();
  const results = await Promise.all([f.api.save({ actor: f.args.actor, input: f.input }), f.api.save({ actor: f.args.actor, input: f.input })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['committed', 'idempotent_replay']);
  assert.deepEqual(results[0].candidate, results[1].candidate);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(saved.runtime.idempotencyRecords.length, 1);
  assert.equal(saved.candidates[0].lifecycleV11.ownerProductFactsHistoryV1, undefined);
  await assert.rejects(f.api.save({ actor: f.args.actor, input: { ...f.input, facts: { ...facts, detachable: true } } }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
});
test('changed declaration appends history; explicit unknown withdraws a previous claim without changing old record', async () => {
  const f = setup(), first = await f.api.save({ actor: f.args.actor, input: f.input });
  const second = await f.api.save({ actor: f.args.actor, input: { ...f.input, expectedRevision: first.candidate.dataRevision,
    facts: { ...facts, closureType: null, adjustable: null } } });
  assert.deepEqual(second.candidate.lifecycleV11.ownerProductFactsHistoryV1, [first.result.declaration]);
  assert.equal(second.result.declaration.facts.adjustable, null);
  assert.equal(first.result.declaration.facts.adjustable, true);
  assert.equal(second.result.declaration.sourceCandidateRevision, first.candidate.dataRevision);
});
test('isolated annotation preserves actual provenance without claiming authenticated identity', () => {
  const f = setup(), prepared = prepareOwnerProductFacts({ ...f.pure, confirmedByUserId: null, sourceInstructionRef: 'source:user_response_annotations' });
  assert.equal(prepared.declaration.confirmedByUserId, null);
  assert.equal(prepared.declaration.sourceInstructionRef, 'source:user_response_annotations');
  assert.equal(prepared.declaration.status, 'saved_for_new_plan');
  assert.equal(f.candidate.lifecycleV11.ownerProductFactsV1, undefined);
  assert.throws(() => prepareOwnerProductFacts({ ...f.pure, sourceInstructionRef: 'source:user_response_annotations' }), /INPUT_INVALID/);
  assert.throws(() => prepareOwnerProductFacts({ ...f.pure, confirmedByUserId: null }), /INPUT_INVALID/);
});
test('normal save rejects nonowner, nonhuman, self-reported identity and source overrides', async () => {
  const f = setup(), before = await f.repository.readSnapshot();
  for (const actor of [{ ...f.args.actor, roles: ['reviewer'] }, { ...f.args.actor, actorType: 'software' },
    { ...f.args.actor, source: 'source:user_response_annotations' }]) {
    await assert.rejects(f.api.save({ actor, input: f.input }), /FORBIDDEN|DENIED|OWNER_REQUIRED|INVALID|role/i);
  }
  for (const extra of [{ confirmedByUserId: 'fake-owner' }, { sourceInstructionRef: 'source:user_response_annotations' }]) {
    await assert.rejects(f.api.save({ actor: f.args.actor, input: { ...f.input, ...extra } }), /INPUT_INVALID/);
  }
  assert.deepEqual(await f.repository.readSnapshot(), before);
});
test('malformed facts, dates, unresolved strings and extra fields are explicit errors', () => {
  const f = setup();
  for (const changed of [null, {}, { ...facts, detachable: 'false' }, { ...facts, adjustable: 1 },
    { ...facts, intendedUses: [] }, { ...facts, intendedUses: ['猫', '猫'] }, { ...facts, intendedUses: ['猫', null] },
    { ...facts, productForm: 'unknown' }, { ...facts, closureType: '' }, { ...facts, intendedUses: '猫和酒瓶' },
    { ...facts, unsupportedFunction: '防弹' }, { ...facts, productForm: 'a'.repeat(241) }]) {
    assert.throws(() => prepareOwnerProductFacts({ ...f.pure, facts: changed }), /INPUT_INVALID/);
  }
  assert.throws(() => prepareOwnerProductFacts({ ...f.pure, confirmedAt: '2026-02-30T00:00:00.000Z' }), /INPUT_INVALID/);
  assert.throws(() => prepareOwnerProductFacts({ ...f.pure, facts: { ...facts, productForm: 'api_key=sk-live-secret-example' } }), /SECRET|secret|秘密/);
});
test('same supply can reuse a saved declaration at later revisions, foreign or altered identity cannot', () => {
  const f = setup(), prepared = prepareOwnerProductFacts(f.pure);
  const later = structuredClone(prepared.candidate); later.dataRevision += 5; later.lifecycleV11.skuPackage.dataRevision += 3;
  assert.deepEqual(readOwnerProductFacts(later), prepared.declaration);
  for (const mutate of [c => { c.lifecycleV11.skuPackage.supplierSkuId = 'other'; },
    c => { c.lifecycleV11.skuPackage.variantKey = 'other'; }, c => { c.storeRef.platformStoreId = 'other'; },
    c => { c.lifecycleV11.skuPackage.selectedSupplySnapshot.snapshotId = 'other:supply'; },
    c => { c.lifecycleV11.ownerProductFactsV1.sourceSkuRevision = 999; }, c => { c.lifecycleV11.ownerProductFactsV1.extra = true; },
    c => { c.lifecycleV11.ownerProductFactsV1.productionAuthorizationGranted = true; }]) {
    const changed = structuredClone(prepared.candidate); mutate(changed);
    assert.throws(() => readOwnerProductFacts(changed), /SOURCE_MISMATCH|RECORD_INVALID/);
  }
});
test('D, production authorization, external listing and already decided cards cannot be edited', () => {
  const f = setup();
  for (const mutate of [s => { s.businessPhase = 'D'; }, s => { s.productionAuthorization = {}; },
    s => { s.productionRecord = {}; }, s => { s.externalListingRecord = {}; }, s => { s.dHandoff = {}; },
    s => { s.productionConfirmationCard.ownerDecision = {}; }]) {
    const candidate = structuredClone(f.candidate); mutate(candidate.lifecycleV11.skuPackage);
    assert.throws(() => prepareOwnerProductFacts({ ...f.pure, candidate }), /PHASE_REJECTED/);
  }
});
test('stale source and SKU mismatch cannot partially save any declaration', async () => {
  const f = setup(), before = await f.repository.readSnapshot();
  for (const patch of [{ expectedRevision: 999 }, { skuPackageId: 'wrong:sku' }]) {
    await assert.rejects(f.api.save({ actor: f.args.actor, input: { ...f.input, ...patch } }), /REVISION_CONFLICT|SOURCE_MISMATCH/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});
test('atomic storage failure leaves declarations, history, audit and idempotency unchanged', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { createJsonBusinessStateRepository } = await import('../lib/business-state-repository.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'owner-product-facts-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const f = setup(), initial = await f.repository.readSnapshot(), filePath = `${directory}/state.json`;
  await writeFile(filePath, JSON.stringify(initial));
  const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async (_path, document) => {
    assert.deepEqual(document.candidates[0].lifecycleV11.ownerProductFactsV1.facts, facts);
    assert.equal(document.runtime.operationAudit.length, 1); throw new Error('synthetic_atomic_write_failed');
  } });
  const api = createOwnerProductFactsUseCase({ ...f.args, repository });
  await assert.rejects(api.save({ actor: f.args.actor, input: f.input }), /synthetic_atomic_write_failed/);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), initial);
});
