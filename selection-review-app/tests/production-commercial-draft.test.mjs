// All long supplier, merchant, task and candidate identities in this test are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { createFormalC1C2Fixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createProductionCommercialDraftUseCase } from '../lib/production-commercial-draft-use-case.mjs';
import { prepareProductionCommercialDraft, readProductionCommercialDraft } from '../lib/production-commercial-draft.mjs';
import { buildOzonFinalProductPreview } from '../lib/ozon-final-product-preview.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
const MERCHANT_SKU = 'OZ-1688-9999999000001-9999999000002';
function setup() {
  const f = productionOwnerDecisionFixture();
  const input = { candidateId: f.candidate.id, skuPackageId: f.candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: f.candidate.dataRevision, merchantSku: MERCHANT_SKU, stock: 100 };
  return { ...f, input, api: createProductionCommercialDraftUseCase(f.args) };
}
test('atomic draft save preserves all frozen C1/C2 and leaves production authorization absent', async () => {
  const f = setup(), before = structuredClone(f.candidate.lifecycleV11.skuPackage);
  const saved = await f.api.save({ actor: f.args.actor, input: f.input });
  assert.equal(saved.status, 'committed');
  assert.equal(saved.candidate.dataRevision, f.input.expectedRevision + 1);
  assert.deepEqual(saved.candidate.lifecycleV11.skuPackage, before);
  assert.equal(saved.candidate.lifecycleV11.skuPackage.productionAuthorization, null);
  assert.deepEqual(saved.result, { draft: readProductionCommercialDraft(saved.candidate), productionAuthorized: false, externalRequests: 0, platformWrites: 0 });
  assert.equal(saved.result.draft.stock, 100);
  assert.equal(saved.result.draft.localUniquenessScope, 'saved_local_records_only');
  assert.equal(saved.result.draft.platformUniquenessVerified, false);
  const replay = await f.api.save({ actor: f.args.actor, input: f.input });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(replay.candidate, saved.candidate);
  const state = await f.repository.readSnapshot();
  assert.equal(state.runtime.operationAudit.length, 1);
  assert.equal(state.runtime.idempotencyRecords.length, 1);
});
test('new version appends old commercial draft and retains original source revisions', async () => {
  const f = setup();
  const first = await f.api.save({ actor: f.args.actor, input: f.input });
  const second = await f.api.save({ actor: f.args.actor, input: { ...f.input, expectedRevision: first.candidate.dataRevision, stock: 120 } });
  assert.deepEqual(second.candidate.lifecycleV11.productionCommercialDraftHistoryV1, [first.result.draft]);
  assert.equal(readProductionCommercialDraft(second.candidate).stock, 120);
  assert.equal(first.result.draft.stock, 100);
});
test('displayed preview and actual authorization use the same saved merchant SKU and stock', async () => {
  const f = setup();
  const saved = await f.api.save({ actor: f.args.actor, input: { ...f.input, stock: 123 } });
  const candidate = saved.candidate, sku = candidate.lifecycleV11.skuPackage;
  const preview = buildOzonFinalProductPreview({ candidate, candidateId: candidate.id, candidateRevision: candidate.dataRevision,
    card: sku.productionConfirmationCard, schemaSnapshot: sku.c1ProductPlan.schemaSnapshot });
  assert.deepEqual(preview.commercialDraft, saved.result.draft);
  const input = { ...f.args.input, dataRevision: candidate.dataRevision, merchantSku: MERCHANT_SKU };
  const result = await commitSingleOwnerProductionAuthorization({ ...f.args, input });
  assert.equal(result.candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope.stock, preview.commercialDraft.stock);
  assert.equal(result.candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope.merchantSku, preview.commercialDraft.merchantSku);
});
test('authorization cannot bypass saved merchant SKU and failed submission makes no write', async () => {
  const f = setup(), saved = await f.api.save({ actor: f.args.actor, input: f.input });
  const before = await f.repository.readSnapshot();
  await assert.rejects(commitSingleOwnerProductionAuthorization({ ...f.args, input: { ...f.args.input, dataRevision: saved.candidate.dataRevision } }), /经营草案/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});
test('concurrent claims of the same local store merchant SKU commit exactly once', async () => {
  const f = setup();
  const second = structuredClone(createFormalC1C2Fixture({ candidateId: 'candidate:second-local-claim', supplierSkuId: 'SECOND' }).candidate);
  second.lifecycleV11.skuPackage.businessPhase = 'C1';
  assert.equal(second.storeRef.platformStoreId, f.candidate.storeRef.platformStoreId);
  const state = await f.repository.readSnapshot(); state.candidates.push(second);
  const repository = createMemoryBusinessStateRepository(state), api = createProductionCommercialDraftUseCase({ ...f.args, repository });
  const results = await Promise.allSettled([api.save({ actor: f.args.actor, input: f.input }), api.save({ actor: f.args.actor,
    input: { ...f.input, candidateId: second.id, skuPackageId: second.lifecycleV11.skuPackage.skuPackageId, expectedRevision: second.dataRevision } })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /LOCAL_SKU_CONFLICT/);
  const saved = await repository.readSnapshot();
  assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(saved.candidates.filter(c => c.lifecycleV11.productionCommercialDraftV1).length, 1);
});
test('same physical shop remains duplicate across mapping revisions; another shop is isolated', async () => {
  for (const otherShop of [false, true]) {
    const f = setup(), state = await f.repository.readSnapshot();
    state.candidates.push({ id: 'historical-local-record', targetPlatform: f.candidate.targetPlatform, targetStore: f.candidate.targetStore,
      storeRef: { ...f.candidate.storeRef, mappingVersion: 'other-version', ...(otherShop ? { platformStoreId: 'different-shop' } : {}) },
      listingRecord: { merchantSku: MERCHANT_SKU } });
    const api = createProductionCommercialDraftUseCase({ ...f.args, repository: createMemoryBusinessStateRepository(state) });
    if (otherShop) assert.equal((await api.save({ actor: f.args.actor, input: f.input })).status, 'committed');
    else await assert.rejects(api.save({ actor: f.args.actor, input: f.input }), /LOCAL_SKU_CONFLICT/);
  }
});
test('bad stock, unsafe merchant SKU, stale identity/revision and extra authorization field are rejected', async () => {
  for (const patch of [{ stock: -1 }, { stock: 1.5 }, { merchantSku: '../foo' }, { skuPackageId: 'wrong' }, { expectedRevision: 999 }, { productionAuthorizationGranted: true }]) {
    const f = setup(), before = await f.repository.readSnapshot();
    await assert.rejects(f.api.save({ actor: f.args.actor, input: { ...f.input, ...patch } }), /INVALID|MISMATCH|CONFLICT/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});
test('pure isolated preview keeps explicit source annotation without inventing an authenticated owner', () => {
  const f = setup(), args = { candidate: f.candidate, merchantSku: MERCHANT_SKU, stock: 100,
    sourceInstructionRef: 'source:user_response_annotations', savedAt: f.args.serverClock(), merchantSkuClaims: [] };
  const prepared = prepareProductionCommercialDraft(args);
  assert.equal(prepared.draft.savedByUserId, null);
  assert.equal(prepared.draft.sourceInstructionRef, 'source:user_response_annotations');
  assert.equal(prepared.draft.productionAuthorizationGranted, false);
  assert.equal(f.candidate.lifecycleV11.productionCommercialDraftV1, undefined);
  assert.throws(() => prepareProductionCommercialDraft({ ...args, savedByUserId: 'fake-authenticated-user' }), /INPUT_INVALID/);
  assert.throws(() => prepareProductionCommercialDraft({ ...args, savedAt: '2026-02-30T00:00:00.000Z' }), /INPUT_INVALID/);
});
test('closed draft rejects foreign scope, unknown fields and future source revision', () => {
  const f = setup();
  const prepared = prepareProductionCommercialDraft({ candidate: f.candidate, merchantSku: MERCHANT_SKU, stock: 100,
    savedByUserId: f.args.actor.userId, savedAt: f.args.serverClock(), merchantSkuClaims: [] });
  for (const corrupt of [d => { d.storeRef.platformStoreId = 'foreign'; }, d => { d.supplierSkuId = 'other'; },
    d => { d.sourceSkuRevision = 9999; }, d => { d.extra = true; }, d => { d.platformUniquenessVerified = true; }]) {
    const c = structuredClone(prepared.candidate); corrupt(c.lifecycleV11.productionCommercialDraftV1);
    assert.throws(() => readProductionCommercialDraft(c), /DRAFT_INVALID/);
  }
});
test('claims include saved authorization, production record, external listing, draft and legacy listing paths', async () => {
  for (const record of [
    { lifecycleV11: { productionCommercialDraftV1: { merchantSku: MERCHANT_SKU } } },
    { lifecycleV11: { skuPackage: { productionAuthorization: { lockedScope: { merchantSku: MERCHANT_SKU } } } } },
    { lifecycleV11: { skuPackage: { productionRecord: { merchantSku: MERCHANT_SKU } } } },
    { lifecycleV11: { skuPackage: { externalListingRecord: { merchantSku: MERCHANT_SKU } } } },
    { listingRecord: { merchantSku: MERCHANT_SKU } }
  ]) {
    const f = setup(), document = await f.repository.readSnapshot();
    document.candidates.push({ id: 'historical-saved-claim', targetPlatform: f.candidate.targetPlatform,
      targetStore: f.candidate.targetStore, storeRef: f.candidate.storeRef, ...record });
    const repository = createMemoryBusinessStateRepository(document), api = createProductionCommercialDraftUseCase({ ...f.args, repository });
    await assert.rejects(api.save({ actor: f.args.actor, input: f.input }), /LOCAL_SKU_CONFLICT/);
    assert.deepEqual(await repository.readSnapshot(), document);
  }
});
test('authenticated owner is required; preview annotation cannot be injected through save API', async () => {
  const f = setup(), before = await f.repository.readSnapshot();
  for (const actor of [{ ...f.args.actor, roles: ['reviewer'] }, { ...f.args.actor, actorType: 'software' },
    { ...f.args.actor, source: 'source:user_response_annotations' }]) {
    await assert.rejects(f.api.save({ actor, input: f.input }), /FORBIDDEN|DENIED|OWNER_REQUIRED|INVALID|role/i);
  }
  await assert.rejects(f.api.save({ actor: f.args.actor, input: { ...f.input, sourceInstructionRef: 'source:user_response_annotations' } }), /INPUT_INVALID/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});
test('production authorization and historical phases cannot be edited as a commercial draft', () => {
  const f = setup();
  for (const corrupt of [sku => { sku.businessPhase = 'D'; }, sku => { sku.productionAuthorization = {}; },
    sku => { sku.productionRecord = {}; }, sku => { sku.dHandoff = {}; },
    sku => { sku.productionConfirmationCard.ownerDecision = {}; }]) {
    const candidate = structuredClone(f.candidate); corrupt(candidate.lifecycleV11.skuPackage);
    assert.throws(() => prepareProductionCommercialDraft({ candidate, merchantSku: MERCHANT_SKU, stock: 100,
      savedByUserId: f.args.actor.userId, savedAt: f.args.serverClock(), merchantSkuClaims: [] }), /PHASE_REJECTED/);
  }
});
test('same idempotency key with changed business input fails without rewriting its first result', async () => {
  const f = setup(); await f.api.save({ actor: f.args.actor, input: f.input });
  const before = await f.repository.readSnapshot();
  await assert.rejects(f.api.save({ actor: f.args.actor, input: { ...f.input, stock: 101 } }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});
test('atomic persistence failure leaves commercial draft, audit and idempotency absent', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { createJsonBusinessStateRepository } = await import('../lib/business-state-repository.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'commercial-draft-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = setup(), initial = await f.repository.readSnapshot(), filePath = `${directory}/state.json`;
  await writeFile(filePath, JSON.stringify(initial));
  let writes = 0;
  const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async (_path, document) => {
    writes++; assert.equal(document.candidates[0].lifecycleV11.productionCommercialDraftV1.merchantSku, MERCHANT_SKU);
    assert.equal(document.runtime.operationAudit.length, 1);
    throw new Error('synthetic_atomic_write_failure');
  } });
  const api = createProductionCommercialDraftUseCase({ ...f.args, repository });
  await assert.rejects(api.save({ actor: f.args.actor, input: f.input }), /synthetic_atomic_write_failure/);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), initial);
});
