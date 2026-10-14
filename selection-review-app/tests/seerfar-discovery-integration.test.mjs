import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { buildRealAConfirmationCard } from '../lib/real-a-confirmation-card.mjs';
import { describeSeerfarFilters } from '../lib/seerfar-discovery-contract.mjs';
import { createSeerfarDiscoveryRuntimeFixture, syntheticMarketProduct } from './fixtures/seerfar-discovery-runtime-fixture.mjs';

const receiptFor = saved => saved.runtime.aDiscoveryReceipts[saved.runtime.softwareJobs[0].jobId];
const importInput = created => ({ batchId: created.batch.batchId, revision: created.batch.revision });

function assertUnverified(candidate) {
  assert.equal(candidate.executionRuntime.businessPhase, 'A');
  assert.equal(candidate.executionRuntime.stepId, 'A_DETAIL_EVIDENCE_REQUIRED');
  assert.equal(candidate.processing.state, 'idle');
  for (const field of ['expectedPriceRub', 'sellerRevenueCny', 'purchasePriceRmb', 'domesticShippingRmb', 'packagingCostRmb', 'defaultStock']) {
    assert.equal(candidate[field], null, field);
  }
  assert.equal(candidate.listingPreparation, null);
  assert.equal(candidate.lifecycle, undefined);
  assert.equal(buildRealAConfirmationCard(candidate).confirmation.ownerSupplyConfirmed, false);
}

test('Seerfar service, one job, three actual transport requests and real importer survive JSON cold restart', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t, { products: [syntheticMarketProduct(), syntheticMarketProduct(2107989736)] });
  const { service, importer } = f.create(), created = await f.prepare(service);
  assert.deepEqual(f.counts(), { secretReads: 0, requests: 0 });
  const result = await f.authorize(service, created);
  assert.equal(result.status, 'completed');
  assert.equal(result.candidateImport.status, 'imported');
  assert.deepEqual(f.calls.map(call => call.step), ['quota_before', 'category_detail', 'quota_after']);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  const sent = JSON.parse(f.calls[1].body);
  assert.equal(sent.categoryId, '100_200'); assert.equal(sent.fulfillment, 'rfbs');
  assert.deepEqual([sent.page.pageNumber, sent.page.pageSize], [1, 20]);
  const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(saved.runtime.softwareJobs[0].status, 'completed');
  const validator = await loadPublishedSchemaValidator();
  const schemaRecords = [
    ['software-job-v3.schema.json', saved.runtime.softwareJobs[0]],
    ['a-discovery-v2.schema.json#/$defs/scope', saved.runtime.softwareJobs[0].scopeBinding],
    ['a-discovery-v2.schema.json#/$defs/receipt', receipt],
    ['a-discovery-v2.schema.json#/$defs/authorization', saved.runtime.softwareJobAuthorizationRecords[0]],
    ['a-discovery-v2.schema.json#/$defs/credential', saved.runtime.softwareJobCredentialBindings[0]],
    ['a-discovery-v2.schema.json#/$defs/evidence', saved.candidates[0].aDiscoveryEvidenceV2]
  ];
  for (const [schema, record] of schemaRecords) {
    const validate = validator.getSchema(schema);
    assert.equal(typeof validate, 'function', schema);
    assert.equal(validate(record), true, `${schema}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...record, unexpectedField: 'must-reject' }), false, `${schema} must remain closed`);
  }
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length, 1);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].authorizationType, 'a_seerfar_discovery_once');
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(saved.runtime.softwareJobCredentialBindings[0].provider, 'seerfar');
  assert.deepEqual(receipt.steps.map(step => step.method), ['quota_before', 'category_detail', 'quota_after']);
  assert.ok(receipt.steps.every(step => step.externalRequestState === 'succeeded'));
  assert.equal(receipt.steps[1].result.products.length, 2);
  assert.ok(receipt.steps[1].result.products.every(product => product.currency === null && product.sellerIdentity === 'unknown'));
  assert.equal(saved.candidates.length, 1); assertUnverified(saved.candidates[0]);
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV1, undefined);
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV2.schemaVersion, 'a-discovery-candidate-evidence-v2');
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV2.provider, 'seerfar');
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV2.contractVersion, 'seerfar-category-discovery-v1');
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV2.platform, 'ozon');
  assert.deepEqual(saved.candidates[0].aDiscoveryEvidenceV2.supplierReceiptRefs, []);
  // The provider's main image travels to the candidate card so the owner can image-search 1688; nothing else is filled in.
  assert.equal(saved.candidates[0].imageUrl, 'https://images.example.test/synthetic-organizer.png');
  assert.equal(saved.candidates[0].productUrl, syntheticMarketProduct().productUrl);
  const bytes = await fs.readFile(f.filePath, 'utf8');
  assert.equal(bytes.includes('synthetic-secret-only'), false);
  await Promise.all([importer.importBatch(importInput(created)), importer.importBatch(importInput(created))]);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), bytes);
  await service.stop();
  const cold = f.create({ repository: f.coldRepository() });
  assert.deepEqual(await cold.importer.importBatch(importInput(created)), result.candidateImport);
  assert.deepEqual(await cold.service.runDue(), { status: 'idle', externalRequests: 0 });
  assert.equal(await fs.readFile(f.filePath, 'utf8'), bytes);
  assert.deepEqual(f.counts(), { secretReads: 1, requests: 3 });
});

test('parallel owner submissions and pumps share one execution and one candidate', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { service } = f.create({ respond: async (call, response) => {
    if (call.step === 'quota_before') { entered.resolve(); await release.promise; }
    return response(call);
  } });
  const created = await f.prepare(service), first = f.authorize(service, created);
  await entered.promise;
  const repeated = f.authorize(service, created), pump = service.runDue();
  release.resolve(); await Promise.all([first, repeated, pump]);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs.length, 1); assert.equal(saved.candidates.length, 1);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords.length, 1);
  assert.deepEqual(f.counts(), { secretReads: 1, requests: 3 });
});

for (const [failedStep, expectedRequests] of [['quota_before', 1], ['category_detail', 2], ['quota_after', 3]]) {
  test(`HTTP 500 at ${failedStep} preserves preceding receipts and does not import or replay`, async t => {
    const f = await createSeerfarDiscoveryRuntimeFixture(t);
    const { service } = f.create({ respond: (call, response) => response(call, { status: call.step === failedStep ? 500 : 200 }) });
    const result = await f.authorize(service, await f.prepare(service));
    assert.equal(result.status, 'failed');
    const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
    assert.equal(saved.candidates.length, 0); assert.equal(receipt.failureClass, 'PROVIDER_FAILED');
    assert.equal(receipt.steps.length, expectedRequests);
    assert.ok(receipt.steps.slice(0, -1).every(step => step.externalRequestState === 'succeeded' && step.result !== null));
    assert.equal(receipt.steps.at(-1).externalRequestState, 'failed');
    if (failedStep === 'quota_after') assert.equal(receipt.steps[1].result.products[0].productId, '2107989735');
    await service.stop();
    const cold = f.create({ repository: f.coldRepository() });
    assert.deepEqual(await cold.service.runDue(), { status: 'idle', externalRequests: 0 });
    assert.equal(f.calls.length, expectedRequests);
    assert.equal((await cold.repository.readSnapshot()).candidates.length, 0);
  });
}

test('unknown category transmission persists its original error boundary and cold restart never replays', async t => {
  const original = new TypeError('synthetic-private-error-detail');
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create({ respond: (call, response) => { if (call.step === 'category_detail') throw original; return response(call); } });
  const created = await f.prepare(service);
  await assert.rejects(() => f.authorize(service, created), error => error === original);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].status, 'unknown_outcome');
  assert.equal(receiptFor(saved).failureClass, 'UNEXPECTED_SYSTEM_ERROR');
  assert.equal(receiptFor(saved).steps[0].externalRequestState, 'succeeded');
  assert.equal(saved.candidates.length, 0);
  assert.equal((await fs.readFile(f.filePath, 'utf8')).includes(original.message), false);
  await service.stop();
  const cold = f.create({ repository: f.coldRepository() });
  assert.deepEqual(await cold.service.runDue(), { status: 'idle', externalRequests: 0 });
  assert.equal(f.calls.length, 2);
});

test('authorization expiring during rate-limit sleep blocks the next actual send', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create({ sleep: async () => { f.advance(2000); } });
  const created = await f.prepare(service);
  const result = await f.authorize(service, created, { expiresAt: '2026-09-09T04:00:01.000Z' });
  assert.equal(result.status, 'failed');
  const saved = await f.repository.readSnapshot();
  assert.equal(receiptFor(saved).failureClass, 'AUTHORIZATION_EXPIRED');
  assert.equal(saved.candidates.length, 0);
  assert.deepEqual(f.calls.map(call => call.step), ['quota_before']);
});

test('revision drift during secret resolution has zero HTTP requests and no candidate', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create({ readSecret: async () => {
    await f.repository.transact(document => {
      Object.values(document.runtime.aDiscoveryBatches)[0].revision++;
      return { changed: true, document };
    });
    return 'synthetic-secret-only';
  } });
  const result = await f.authorize(service, await f.prepare(service));
  assert.equal(result.status, 'failed');
  const saved = await f.repository.readSnapshot();
  assert.equal(receiptFor(saved).failureClass, 'BATCH_CHANGED');
  assert.equal(saved.runtime.softwareJobs[0].externalRequestState, 'not_sent');
  assert.equal(saved.candidates.length, 0); assert.equal(f.calls.length, 0);
});

test('completed empty category remains distinct from malformed nonempty data', async t => {
  for (const malformed of [false, true]) {
    const f = await createSeerfarDiscoveryRuntimeFixture(t, { products: malformed ? [{ sku: 12 }] : [] });
    const { service } = f.create();
    const result = await f.authorize(service, await f.prepare(service));
    const saved = await f.repository.readSnapshot();
    assert.equal(saved.candidates.length, 0);
    if (malformed) {
      assert.equal(result.status, 'failed');
      assert.equal(receiptFor(saved).failureClass, 'RESPONSE_INVALID');
      assert.equal(f.calls.length, 2);
    } else {
      assert.equal(result.status, 'completed');
      assert.equal(receiptFor(saved).steps[1].result.status, 'true_empty');
      assert.equal(f.calls.length, 3);
    }
  }
});

test('previously eliminated market identity is never revived and next ordered product stays unverified', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t, { products: [syntheticMarketProduct(), syntheticMarketProduct(2107989736)] });
  const historical = { id: 'candidate:synthetic-eliminated', workflowStatus: 'eliminated',
    productUrl: 'https://www.ozon.ru/product/old-organizer-2107989735/?from=archive', eliminationReason: 'Owner rejected synthetic record' };
  await f.repository.transact(document => { document.candidates.push(historical); return { changed: true, document }; });
  const { service } = f.create();
  const result = await f.authorize(service, await f.prepare(service));
  assert.equal(result.candidateImport.marketProductId, '2107989736');
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.candidates.length, 2);
  assert.deepEqual(saved.candidates.find(candidate => candidate.id === historical.id), historical);
  assertUnverified(saved.candidates.find(candidate => candidate.id !== historical.id));
});

test('importer rejects another-provider credential and altered category receipt without creating a candidate', async t => {
  for (const altered of ['credential-provider', 'category-identity']) {
    const f = await createSeerfarDiscoveryRuntimeFixture(t);
    const { service, importer } = f.create({ onBatchReady: async () => ({ status: 'paused-for-source-integrity-test' }) });
    const created = await f.prepare(service);
    assert.equal((await f.authorize(service, created)).status, 'completed');
    await f.repository.transact(document => {
      if (altered === 'credential-provider') document.runtime.softwareJobCredentialBindings[0].provider = 'linkfox';
      else receiptFor(document).steps[1].result.categoryId = '100_999';
      return { changed: true, document };
    });
    const result = await importer.importBatch(importInput(created));
    assert.equal(result.status, 'blocked', altered);
    assert.equal((await f.repository.readSnapshot()).candidates.length, 0);
    const bytes = await fs.readFile(f.filePath, 'utf8');
    assert.deepEqual(await importer.importBatch(importInput(created)), result);
    assert.equal(await fs.readFile(f.filePath, 'utf8'), bytes);
    assert.equal(f.calls.length, 3);
  }
});

for (const scenario of [
  { name: 'insufficient initial points', before: 14, after: 0, code: 'BUDGET_EXCEEDED', requests: 1 },
  { name: 'increasing final points', before: 100, after: 101, code: 'QUOTA_INVALID', requests: 3 },
  { name: 'actual points exceed authorized budget', before: 100, after: 84, code: 'BUDGET_EXCEEDED', requests: 3 }
]) {
  test(`${scenario.name} keeps billing evidence and blocks candidate import`, async t => {
    const f = await createSeerfarDiscoveryRuntimeFixture(t);
    const { service } = f.create({ respond: (call, response) => call.step === 'category_detail' ? response(call) :
      response(call, { body: { code: 200, data: { remaining: call.step === 'quota_before' ? scenario.before : scenario.after } } }) });
    const result = await f.authorize(service, await f.prepare(service));
    assert.equal(result.status, 'failed');
    const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
    assert.equal(receipt.failureClass, scenario.code);
    assert.equal(saved.candidates.length, 0); assert.equal(f.calls.length, scenario.requests);
    assert.equal(receipt.steps[0].result.remainingPoints, scenario.before);
    if (scenario.requests === 3) {
      assert.ok(receipt.steps.every(step => step.externalRequestState === 'succeeded'));
      assert.equal(receipt.steps[2].result.remainingPoints, scenario.after);
      assert.equal(receipt.steps[1].result.products[0].productId, '2107989735');
    }
    await service.stop();
    const cold = f.create({ repository: f.coldRepository() });
    assert.deepEqual(await cold.service.runDue(), { status: 'idle', externalRequests: 0 });
    assert.equal(f.calls.length, scenario.requests);
  });
}

test('category response arriving after lease recovery remains late evidence without final quota or import', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { service, store } = f.create({ respond: async (call, response) => {
    if (call.step === 'category_detail') { entered.resolve(); await release.promise; }
    return response(call);
  } });
  const running = f.authorize(service, await f.prepare(service));
  await entered.promise; f.advance(60001); await store.reconcileAfterRestart();
  const recovered = await f.repository.readSnapshot(), job = structuredClone(recovered.runtime.softwareJobs[0]);
  assert.equal(job.status, 'unknown_outcome');
  release.resolve();
  assert.equal((await running).status, 'idempotent_replay');
  const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
  assert.deepEqual(saved.runtime.softwareJobs[0], job);
  assert.equal(receipt.status, 'unknown_outcome');
  assert.equal(receipt.lateResult.stepIndex, 1);
  assert.equal(receipt.lateResult.result.products[0].productId, '2107989735');
  assert.equal(saved.candidates.length, 0);
  assert.deepEqual(f.calls.map(call => call.step), ['quota_before', 'category_detail']);
  assert.deepEqual(await service.runDue(), { status: 'idle', externalRequests: 0 });
});

for (const boundary of ['lease', 'authorization']) {
  test(`final quota received after ${boundary} expiry retains three steps but cannot import`, async t => {
    const f = await createSeerfarDiscoveryRuntimeFixture(t);
    const { service } = f.create({ respond: (call, response) => {
      if (call.step === 'quota_after') f.advance(boundary === 'lease' ? 60001 : 1001);
      return response(call);
    } });
    const created = await f.prepare(service);
    const result = await f.authorize(service, created, boundary === 'authorization' ? { expiresAt: '2026-09-09T04:00:07.000Z' } : {});
    assert.equal(result.status, 'failed');
    const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
    assert.equal(receipt.failureClass, boundary === 'lease' ? 'LEASE_EXPIRED' : 'AUTHORIZATION_EXPIRED');
    assert.equal(receipt.steps.length, 3);
    assert.ok(receipt.steps.every(step => step.externalRequestState === 'succeeded'));
    assert.equal(saved.candidates.length, 0);
    assert.equal(f.calls.length, 3);
  });
}

 test('response review facts survive formal transport, receipt, import and byte-stable cold read', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const product = { ...syntheticMarketProduct(), reviewCount: 142, reviewRating: 4.8, sellerType: 1, weight: 850, volume: 12.4, dimension: '600x450x150' };
  const { service } = f.create({ respond: (call, response) => call.step === 'category_detail'
    ? response(call, { body: { code: 200, data: { id: '100_200', productList: [product], hasNextPage: false, startDate: '2026-07-01', endDate: '2026-07-27' } } }) : response(call) });
  const result = await f.authorize(service, await f.prepare(service));
  assert.equal(result.status, 'completed'); assert.equal(result.candidateImport.status, 'imported');
  const saved = await f.repository.readSnapshot(), market = receiptFor(saved).steps[1].result;
  assert.equal(market.schemaVersion, 'seerfar-discovery-market-result-v3');
  assert.deepEqual(market.dateRange, { startDate: '2026-07-01', endDate: '2026-07-27' });
  assert.deepEqual([market.products[0].weightGrams, market.products[0].volumeLitres, market.products[0].dimensionMm], [850, 12.4, '600x450x150']);
  assert.deepEqual([market.products[0].reviewCount, market.products[0].reviewRating, market.products[0].rawSellerType, market.products[0].sellerIdentity], [142, 4.8, 1, 'unknown']);
  assert.equal(saved.candidates[0].aDiscoveryEvidenceV2.marketReceiptRef, receiptFor(saved).receiptId);
  assertUnverified(saved.candidates[0]);
  const bytes = await fs.readFile(f.filePath, 'utf8'); await service.stop();
  const cold = f.create({ repository: f.coldRepository() });
  const read = await cold.repository.readSnapshot();
  assert.deepEqual(receiptFor(read).steps[1].result, market);
  assert.equal((await cold.service.runDue()).status, 'idle');
  assert.equal(await fs.readFile(f.filePath, 'utf8'), bytes); assert.equal(f.calls.length, 3);
});


for (const empty of [false, true]) test(`wrong category identity cannot import or become true_empty (empty=${empty})`, async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create({ respond: (call, response) => call.step === 'category_detail'
    ? response(call, { body: { code: 200, data: { id: '100_201', productList: empty ? [] : [syntheticMarketProduct()], hasNextPage: false } } })
    : response(call) });
  const result = await f.authorize(service, await f.prepare(service));
  assert.equal(result.status, 'failed');
  const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
  assert.equal(receipt.failureClass, 'RESPONSE_INVALID');
  assert.equal(receipt.steps.length, 2);
  assert.equal(receipt.steps[0].externalRequestState, 'succeeded');
  assert.equal(receipt.steps[1].result, null);
  assert.equal(saved.candidates.length, 0);
  assert.deepEqual(f.calls.map(call => call.step), ['quota_before', 'category_detail']);
  const bytes = await fs.readFile(f.filePath, 'utf8');
  await service.stop();
  const cold = f.create({ repository: f.coldRepository() });
  assert.deepEqual(await cold.service.runDue(), { status: 'idle', externalRequests: 0 });
  assert.equal(await fs.readFile(f.filePath, 'utf8'), bytes);
  assert.equal(f.calls.length, 2);
});


for (const change of ['removed', 'same_version_budget_changed', 'credential_changed']) {
  test(`unapproved prepared batch cannot authorize after configuration change: ${change}`, async t => {
    const f = await createSeerfarDiscoveryRuntimeFixture(t), original = f.create();
    const created = await f.prepare(original.service);
    await original.service.stop();
    const overrides = change === 'removed' ? { plans: [] }
      : change === 'same_version_budget_changed' ? { plans: [{ ...f.plan, budget: { ...f.plan.budget, maxCredits: f.plan.budget.maxCredits + 1 } }] }
      : { connectorBindings: [{ ...f.connectorBinding, credentialAlias: 'changed:alias' }] };
    const cold = f.create({ repository: f.coldRepository(), ...overrides });
    const before = await fs.readFile(f.filePath, 'utf8');
    const view = cold.service.view({ document: await cold.repository.readSnapshot(), actor: f.owner });
    assert.equal(view.batches[0].canAuthorize, false);
    await assert.rejects(f.authorize(cold.service, created), /A_DISCOVERY_PLAN_NOT_CONFIGURED/);
    assert.equal(await fs.readFile(f.filePath, 'utf8'), before);
    assert.deepEqual(f.counts(), { secretReads: 0, requests: 0 });
  });
}

test('removed plan stops previously queued work through pump and repeated authorization without replaying completed history', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  // One store runs one direction at a time (ROUND_ALREADY_RUNNING), so the round queued behind the running one is a
  // second saved direction; what this test is about — a removed plan stopping queued work — is unchanged.
  const secondPlan = { ...f.plan, planId: 'plan:synthetic-seerfar-second' };
  const { service } = f.create({ plans: [f.plan, secondPlan], respond: async (call, response) => {
    if (call.step === 'quota_before') { entered.resolve(); await release.promise; }
    return response(call);
  } });
  const first = await f.prepare(service), running = f.authorize(service, first);
  await entered.promise;
  const second = await service.createBatch({ actor: f.owner, input: { planId: secondPlan.planId, planVersion: secondPlan.version,
    targetStore: 'miska', bindingId: f.connectorBinding.bindingId, configurationVersion: f.connectorBinding.configurationVersion,
    idempotencyKey: 'create:second-category' } });
  assert.equal((await f.authorize(service, second)).status, 'queued');
  release.resolve(); await running; await service.stop();
  const cold = f.create({ repository: f.coldRepository(), plans: [] });
  const before = await fs.readFile(f.filePath, 'utf8'), counts = f.counts();
  const queued = (await cold.repository.readSnapshot()).runtime.softwareJobs.find(job => job.status === 'queued');
  const view = cold.service.view({ document: await cold.repository.readSnapshot(), actor: f.owner });
  assert.equal(view.batches.find(row => row.batch.batchId === second.batch.batchId).jobs[0].canContinue, false);
  for (const action of [() => cold.service.runDue(), () => f.authorize(cold.service, second),
    () => cold.service.continueSavedCurrent({ actor: f.owner, input: { batchId: second.batch.batchId, expectedRevision: 0, jobId: queued.jobId } })]) {
    const result = await action();
    assert.equal(result.status, 'blocked'); assert.equal(result.rejection.code, 'A_DISCOVERY_PLAN_NOT_CONFIGURED');
    assert.deepEqual(f.counts(), counts); assert.equal(await fs.readFile(f.filePath, 'utf8'), before);
  }
  const repeated = await f.authorize(cold.service, first);
  assert.equal(repeated.status, 'idempotent_replay');
  assert.deepEqual(f.counts(), counts); assert.equal(await fs.readFile(f.filePath, 'utf8'), before);
});


test('missing evidence declarations block preparation and later authorization without writes or requests', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const empty = f.create({ getEvidenceRecords: () => [] });
  const initial = await fs.readFile(f.filePath, 'utf8');
  const view = empty.service.view({ document: await f.repository.readSnapshot(), actor: f.owner });
  assert.equal(view.canPrepare, false); assert.ok(view.configurationBlockers.includes('EVIDENCE_UNAVAILABLE'));
  await assert.rejects(f.prepare(empty.service), /A_DISCOVERY_EVIDENCE_UNAVAILABLE/);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), initial);
  const configured = f.create(), prepared = await f.prepare(configured.service);
  const before = await fs.readFile(f.filePath, 'utf8');
  await assert.rejects(f.authorize(empty.service, prepared), /A_DISCOVERY_EVIDENCE_UNAVAILABLE/);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), before);
  assert.deepEqual(f.counts(), { secretReads: 0, requests: 0 });
});

for (const revokedAfter of ['quota_before', 'category_detail', 'quota_after']) {
  test(`current evidence revoked after ${revokedAfter} preserves successful steps and stops further work`, async t => {
    const f = await createSeerfarDiscoveryRuntimeFixture(t);
    let current = structuredClone(f.evidence);
    const { service } = f.create({ getEvidenceRecords: () => [current], respond: (call, response) => {
      const result = response(call);
      if (call.step === revokedAfter) current = { ...current, status: 'revoked' };
      return result;
    } });
    const result = await f.authorize(service, await f.prepare(service));
    assert.equal(result.status, 'failed');
    const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved);
    assert.equal(receipt.failureClass, 'EVIDENCE_REVOKED');
    const count = ['quota_before', 'category_detail', 'quota_after'].indexOf(revokedAfter) + 1;
    assert.equal(f.calls.length, count); assert.equal(saved.candidates.length, 0);
    assert.ok(receipt.steps.slice(0, count).every(step => step.externalRequestState === 'succeeded'));
    const validator = await loadPublishedSchemaValidator();
    const validate = validator.getSchema('a-discovery-v2.schema.json#/$defs/receipt');
    assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
    await service.stop(); const before = await fs.readFile(f.filePath, 'utf8');
    const cold = f.create({ repository: f.coldRepository(), getEvidenceRecords: () => [] });
    assert.deepEqual(await cold.service.runDue(), { status: 'idle', externalRequests: 0 });
    assert.equal(await fs.readFile(f.filePath, 'utf8'), before); assert.equal(f.calls.length, count);
  });
}


test('evidence revoked at the queued-to-claim boundary is blocked without failing the service', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t), base = f.create();
  const prepared = await f.prepare(base.service);
  let current = structuredClone(f.evidence), sawQueued = false;
  const store = {...base.store,get:async id=>{
    const job = await base.store.get(id);
    if(job?.status==='queued') {if(sawQueued)current={...current,status:'revoked'};sawQueued=true;}
    return job;
  }};
  const next = f.create({softwareJobStore:store,getEvidenceRecords:()=>[current]});
  const result = await f.authorize(next.service,prepared);
  assert.equal(result.status,'blocked');assert.equal(result.rejection.code,'A_DISCOVERY_EVIDENCE_REVOKED');
  assert.equal(next.service.status,'stopped');assert.deepEqual(f.counts(),{secretReads:0,requests:0});
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].status,'queued');
  assert.equal(saved.runtime.softwareJobs[0].attempt,0);assert.deepEqual(saved.runtime.aDiscoveryReceipts,{});
});

test('evidence revoked while waiting for the final transaction cannot commit completed or import', async t => {
  const f=await createSeerfarDiscoveryRuntimeFixture(t);
  let current=structuredClone(f.evidence), revokedAtCommit=false;
  const repository={...f.repository,transact:operation=>f.repository.transact(document=>{
    const receipts=Object.values(document.runtime?.aDiscoveryReceipts??{});
    if(receipts.some(receipt=>receipt.status==='in_flight'&&receipt.steps.length===3&&receipt.steps.every(step=>step.externalRequestState==='succeeded'))){
      current={...current,status:'revoked'};revokedAtCommit=true;
    }
    return operation(document);
  })};
  const {service}=f.create({repository,getEvidenceRecords:()=>[current]});
  const result=await f.authorize(service,await f.prepare(service));
  assert.equal(revokedAtCommit,true);assert.equal(result.status,'failed');
  const saved=await f.repository.readSnapshot(),receipt=receiptFor(saved);
  assert.equal(receipt.failureClass,'EVIDENCE_REVOKED');assert.equal(receipt.steps.length,3);
  assert.ok(receipt.steps.every(step=>step.externalRequestState==='succeeded'));
  assert.equal(saved.candidates.length,0);assert.equal(f.calls.length,3);
});

test('an owner-filtered plan sends its conditions and every saved record states which filters produced the result', async t => {
  const filters = { priceRub: { min: 800, max: null }, weightGrams: { min: null, max: 1000 } };
  const f = await createSeerfarDiscoveryRuntimeFixture(t, { filters });
  const { service } = f.create(), created = await f.prepare(service);
  assert.deepEqual(created.batch.plan.requests[0].filters, filters);
  const result = await f.authorize(service, created);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.calls.map(call => call.step), ['quota_before', 'category_detail', 'quota_after']);
  const sent = JSON.parse(f.calls[1].body);
  assert.deepEqual(sent.price, { min: 800, max: null });
  assert.deepEqual(sent.weight, { min: null, max: 1000 });
  for (const slot of ['volume', 'monthlySales', 'monthlyRevenue', 'reviewCount', 'grossMargin']) {
    assert.deepEqual(sent[slot], { min: null, max: null }, slot);
  }
  const saved = await f.repository.readSnapshot(), receipt = receiptFor(saved), market = receipt.steps[1].result;
  assert.deepEqual(receipt.scope.request.filters, filters);
  assert.deepEqual(saved.runtime.softwareJobs[0].scopeBinding.request.filters, filters);
  assert.equal(market.schemaVersion, 'seerfar-discovery-market-result-v3');
  assert.deepEqual(market.appliedFilters, filters);
  assert.equal(describeSeerfarFilters(market.appliedFilters), '售价 ≥800 卢布 · 重量 ≤1000 克');
  const validator = await loadPublishedSchemaValidator();
  for (const [schema, record] of [['a-discovery-v2.schema.json#/$defs/scope', saved.runtime.softwareJobs[0].scopeBinding],
    ['a-discovery-v2.schema.json#/$defs/receipt', receipt], ['a-discovery-v2.schema.json#/$defs/result', market]]) {
    const validate = validator.getSchema(schema);
    assert.equal(validate(record), true, `${schema}: ${JSON.stringify(validate.errors)}`);
  }
  // The desk reads the conditions from the batch view without spending a second query.
  const view = service.view({ document: saved, actor: f.owner });
  assert.deepEqual(view.plans[0].requests[0].filters, filters);
  const shown = view.batches[0];
  assert.deepEqual(shown.batch.plan.requests[0].filters, filters);
  assert.deepEqual(shown.jobs[0].receipt.scope.request.filters, filters);
  assert.deepEqual(shown.jobs[0].receipt.steps[1].result.appliedFilters, filters);
  await service.stop();

  const plain = await createSeerfarDiscoveryRuntimeFixture(t);
  const unfiltered = plain.create(), plainCreated = await plain.prepare(unfiltered.service);
  assert.equal(Object.hasOwn(plainCreated.batch.plan.requests[0], 'filters'), false);
  assert.equal((await plain.authorize(unfiltered.service, plainCreated)).status, 'completed');
  const plainSaved = await plain.repository.readSnapshot(), plainMarket = receiptFor(plainSaved).steps[1].result;
  assert.equal(plainMarket.appliedFilters, null);
  assert.equal(describeSeerfarFilters(plainMarket.appliedFilters), '无筛选条件');
  const plainSent = JSON.parse(plain.calls[1].body);
  for (const slot of ['price', 'weight', 'volume', 'monthlySales']) assert.deepEqual(plainSent[slot], { min: null, max: null }, slot);
  await unfiltered.service.stop();
});
