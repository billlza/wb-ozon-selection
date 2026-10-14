import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedFixture, capabilities as formalCapabilities } from './helpers/d-software-fixture.mjs';
import { finalAssets as syntheticFinalAssets } from './helpers/c2-software-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../lib/ozon-seller-api-de-adapter.mjs';
import { OzonDEHttpTransportError } from '../lib/ozon-de-http-configuration.mjs';
import { createPersistedDBatchImportRuntime } from '../lib/d-batch-import-runtime.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';
import { deSoftwareJobScopeFixture } from './fixtures/d-e-software-job-scope-fixture.mjs';
import { validateProductionRecord } from '../lib/production-record-contract.mjs';

const at = '2026-08-22T07:25:00.000Z';
const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1',
  policyRef: 'policy:synthetic:batch-observation', version: 'v1', maxQueries: 10,
  intervalMs: 0, expiresAt: '2026-09-01T00:00:00.000Z', requestTimeoutMs: 10_000 };
const binding = { warehouseRef: 'warehouse:synthetic:dandanshu', credentialAlias: 'credential-alias:synthetic:dandanshu' };

async function fixture({ failReceipt = false, createAdapterFailures = 0, observationItems = null, count = 2,
  inventoryAction = null, maxItemsPerRequest = null, failImportCall = null,
  expireLimitAfterIntentChunk = null, failPrewriteCheckpoint = false,
  importFailure = null } = {}) {
  let currentTime = at;
  const colors = count === 2 ? ['white', 'black'] : ['black', 'navy', 'khaki'];
  const sources = [];
  for (let index = 0; index < count; index++) {
    const color = colors[index % colors.length];
    const name = count === 2 ? ['A', 'B'][index] : String(index + 2).padStart(2, '0');
    const assets = index === 0 && count === 2 ? undefined : syntheticFinalAssets().map((asset, assetIndex) => ({ ...asset,
      assetId: `${asset.assetId}:${name}`,
      assetRef: assetIndex === 0 ? `https://assets.example.com/${color}-main.jpg` : asset.assetRef,
      sha256: assetIndex === 0 ? ({ white: 'a', black: 'c', navy: 'e', khaki: 'f' })[color].repeat(64) : asset.sha256 }));
    sources.push(await preparedFixture({ candidateId: `candidate:batch-${name.toLowerCase()}`,
      supplierSkuId: `SHELF-${name}`, merchantSku: `BATCH-${name}`, assets, ...binding }));
  }
  const members = sources.map((source, index) => ({ request: source.prepared.executableRequest,
    executionContext: { ...source.executionContext, serverClock: () => currentTime },
    platformWritePreflight: source.preflight,
    colorKey: colors[index % colors.length],
    modelKey: 'same-product', sourceTechnicalStatus: 'not_started', observationPolicy }));
  const capability = formalCapabilities('dandanshu', members.flatMap(member => member.request.finalUploads), members[0].request);
  capability.warehouseId = '70001';
  capability.assetTransport.resolvedAssets = members.flatMap(member => member.request.finalUploads.map(asset => ({
    assetId: asset.assetId, platformAcceptedUrl: asset.platformAcceptedUrl, sha256: asset.sha256,
    order: asset.order, authorizationStatus: 'approved', stable: true, evidenceRef: `evidence:asset:${asset.assetId}` })));
  capability.productImport.endpoint = '/v3/product/import';
  capability.productImport.maxItemsPerRequest = maxItemsPerRequest ?? (count === 2 ? 2 : 10);
  capability.productImport.limitEvidenceRef = 'synthetic:batch-limit';
  capability.productImport.limitObservedAt = '2026-08-22T07:00:00.000Z';
  capability.productImport.validUntil = '2026-09-01T00:00:00.000Z';
  if (expireLimitAfterIntentChunk !== null)
    capability.productImport.validUntil = '2026-08-22T07:25:01.000Z';
  const document = initialBusinessStateDocument({ now: at });
  document.candidates = sources.map((source, index) => ({ id: source.fixture.candidateId,
    dataRevision: source.fixture.candidateRevision, targetPlatform: 'ozon', targetStore: 'dandanshu',
    storeRef: structuredClone(members[index].request.storeRef),
    lifecycleV11: { skuPackage: structuredClone(source.fixture.skuPackage) } }));
  document.runtime.dProductionBatches = [{ schemaVersion: inventoryAction===null ?
    'd-batch-production-authorization-v1':'d-batch-production-authorization-v2',
    batchId: 'd-batch:synthetic', status: 'authorized', externalRequestState: 'not_sent',
    storeRef: structuredClone(members[0].request.storeRef),
    excludedOfferIds: ['BATCH-FIRST'], ...(inventoryAction===null?{}:{postImportScope:{
      schemaVersion:'d-batch-post-import-scope-v1',inventoryAction,
      eReadbackOfferIds:members.map(member=>member.request.merchantSku)}}),
    members: sources.map((source, index) => ({
      candidateId: source.fixture.candidateId, skuPackageId: source.fixture.skuPackage.skuPackageId,
      offerId: members[index].request.merchantSku, resultRevision: source.fixture.candidateRevision,
      authorizationId: source.authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(source.authorization),
      status: 'authorized', taskId: null, productId: null })) }];
  const baseRepository = createMemoryBusinessStateRepository(document);
  let rejectReceipt = failReceipt;
  let rejectPrewrite = failPrewriteCheckpoint;
  const repository = failReceipt || failPrewriteCheckpoint ? { ...baseRepository, transact: mutator => baseRepository.transact(async saved => {
    const outcome = await mutator(saved);
    if (rejectReceipt && saved.runtime.dBatchImportJobs?.some(job => job.chunks.some(chunk => chunk.status === 'waiting_platform'))) {
      rejectReceipt = false;
      throw new Error('synthetic receipt persistence failure');
    }
    if (rejectPrewrite && saved.runtime.dBatchImportJobs?.some(job =>
      job.chunks.some(chunk => chunk.status === 'prewrite_blocked'))) {
      rejectPrewrite = false;
      throw new Error('synthetic prewrite checkpoint failure');
    }
    return outcome;
  }) } : baseRepository;
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:batch-synthetic', version: 'v1',
    capabilities: ['ozon-production-execution'], observedAt: at });
  const calls = [];
  let remainingAdapterFailures = createAdapterFailures;
  let readCount = 0;
  const runtimeOptions = { repository, workerRegistry, serverClock: () => currentTime,
    leaseDurationMs: 60_000,
    verifyCurrentBatchEvidence: async () => {
      const saved = await repository.readSnapshot();
      assert.equal(saved.runtime.dProductionBatches[0].members.length, members.length);
    },
    createAdapter: async () => {
      if (remainingAdapterFailures > 0) { remainingAdapterFailures--; throw new Error('synthetic adapter startup failure'); }
      const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: capability,
      requestJson: async request => {
        calls.push(request);
        if (request.write) {
          const sendCount=calls.filter(call=>call.write).length;
          if(sendCount===failImportCall)throw importFailure ?? new Error('synthetic import response lost');
          return { result: { task_id: 500 + sendCount } };
        }
        const items = observationItems?.[readCount++] ?? [
          { offer_id: 'BATCH-A', product_id: 910001, status: 'imported', errors: [] },
          { offer_id: 'BATCH-B', product_id: 0, status: 'failed', errors: [] }
        ];
        return { result: { items } };
      } });
      return expireLimitAfterIntentChunk === null ? adapter : { ...adapter,
        executeBatchImport: (input,options) => adapter.executeBatchImport(input,{...options,
          persistCheckpoint: async event => {
            await options.persistCheckpoint(event);
            if(event.kind==='batch_import_intent' && event.chunkIndex===expireLimitAfterIntentChunk)
              currentTime=capability.productImport.validUntil;
          }}) };
    } };
  const runtime = createPersistedDBatchImportRuntime(runtimeOptions);
  return { repository, runtime, members, capability, calls, workerRegistry,
    restartRuntime:()=>createPersistedDBatchImportRuntime(runtimeOptions),
    setTime: value => { currentTime = value; } };
}

test('persisted batch intent sends once, then one task read settles each offer independently', async () => {
  const { repository, runtime, members, capability, calls } = await fixture();
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  const result = await runtime.run(input);
  assert.equal(result.status, 'waiting_platform');
  assert.equal(calls.filter(call => call.write).length, 1);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 1);
  const observed = await runtime.observe({ ...input, chunkIndex: 0 });
  assert.equal(observed.status, 'partial_failure');
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member => member.status),
    ['imported_awaiting_inventory_and_e', 'platform_failed']);
  assert.equal(saved.candidates.some(candidate => candidate.lifecycleV11.skuPackage.productionRecord), false);
  assert.deepEqual(calls.map(call => call.write), [true, false]);
});
test('v2 imported offer atomically creates only its own frozen stock continuation',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture({inventoryAction:'create_only'});
  const input={batchId:'d-batch:synthetic',members,adapterCapabilities:capability,workerId:'worker:batch-synthetic'};
  await runtime.run(input);
  const result=await runtime.observe({...input,chunkIndex:0});
  assert.equal(result.status,'partial_failure');
  const saved=await repository.readSnapshot();
  assert.equal(saved.runtime.dBatchStockJobs.length,1);
  const stock=saved.runtime.dBatchStockJobs[0];
  assert.equal(stock.offerId,'BATCH-A');
  assert.equal(stock.status,'inventory_deferred');
  assert.equal(stock.authorizationId,saved.runtime.dProductionBatches[0].members[0].authorizationId);
  assert.deepEqual(calls.map(call=>call.write),[true,false]);
});
test('mixed imported, failed and unknown offers retain separate results without an import replay',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture({count:3,
    inventoryAction:'create_only',observationItems:[[
      {offer_id:'BATCH-02',product_id:910002,status:'imported',errors:[]},
      {offer_id:'BATCH-03',product_id:0,status:'failed',errors:[]}
    ]]});
  const input={batchId:'d-batch:synthetic',members,adapterCapabilities:capability,
    workerId:'worker:batch-synthetic'};
  await runtime.run(input);
  assert.equal((await runtime.observe({...input,chunkIndex:0})).status,'unknown_outcome');
  const saved=await repository.readSnapshot();
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member=>member.status),
    ['imported_awaiting_inventory_and_e','platform_failed','unknown_outcome']);
  assert.deepEqual(saved.runtime.dBatchStockJobs.map(job=>job.offerId),['BATCH-02']);
  const view=projectDBatchExecutionView(saved,input.batchId);
  assert.deepEqual(view.members.map(member=>member.importStatus),
    ['imported','platform_failed','unknown_outcome']);
  assert.deepEqual(view.members.map(member=>member.eStatus),
    ['not_started','not_started','not_started']);
  assert.equal((await runtime.run(input)).status,'idempotent_replay');
  assert.equal(calls.filter(call=>call.write).length,1);
});

test('a sent unknown chunk never replays or sends a later untouched chunk',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture({count:3,
    maxItemsPerRequest:1,failImportCall:2});
  const input={batchId:'d-batch:synthetic',members,adapterCapabilities:capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await runtime.run(input)).status,'unknown_outcome');
  const chunks=(await repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks;
  assert.deepEqual(chunks.map(chunk=>chunk.status),['waiting_platform','unknown_outcome','not_sent']);
  assert.equal((await runtime.run(input)).status,'idempotent_replay');
  assert.equal(calls.filter(call=>call.write).length,2);
  assert.equal(calls.some(call=>call.body.items?.some(item=>item.offer_id==='BATCH-04')),false);
});

test('expired limit after durable intent is proven unsent, displayed per offer and never replayed',async()=>{
  const f=await fixture({expireLimitAfterIntentChunk:0});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  const stopped=await f.runtime.run(input);
  assert.equal(stopped.status,'prewrite_blocked');
  const saved=await f.repository.readSnapshot(),chunk=saved.runtime.dBatchImportJobs[0].chunks[0];
  assert.equal(saved.runtime.dBatchImportJobs[0].schemaVersion,'d-batch-import-job-v3');
  assert.equal(chunk.status,'prewrite_blocked');
  assert.equal(chunk.taskId,null);
  assert.equal(chunk.prewriteReasonCode,'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED');
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState,'not_sent');
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member=>member.status),
    ['prewrite_blocked','prewrite_blocked']);
  assert.deepEqual(projectDBatchExecutionView(saved,input.batchId).members.map(member=>
    [member.importStatus,member.importGapCode]),[
      ['prewrite_blocked','OZON_BATCH_LIMIT_EVIDENCE_REQUIRED'],
      ['prewrite_blocked','OZON_BATCH_LIMIT_EVIDENCE_REQUIRED']]);
  assert.equal(f.calls.length,0);
  const restarted=f.restartRuntime();
  const replay=await Promise.all([restarted.run(input),restarted.run(input)]);
  assert.deepEqual(replay.map(value=>value.status),['idempotent_replay','idempotent_replay']);
  assert.equal(f.calls.length,0);
});

test('concurrent duplicate starts commit one proven-unsent verdict and no import request',async()=>{
  const f=await fixture({expireLimitAfterIntentChunk:0});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  const outcomes=await Promise.all([f.runtime.run(input),f.runtime.run(input)]);
  assert.equal(outcomes.some(result=>result.status==='prewrite_blocked'),true);
  assert.equal(outcomes.every(result=>['prewrite_blocked','idempotent_replay'].includes(result.status)),true);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs.length,1);
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].status,'prewrite_blocked');
  assert.equal(f.calls.length,0);
});

test('concurrent normal starts still send only one import task',async()=>{
  const f=await fixture();
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  const outcomes=await Promise.all([f.runtime.run(input),f.runtime.run(input)]);
  assert.equal(outcomes.some(result=>result.status==='waiting_platform'),true);
  assert.equal(outcomes.every(result=>['waiting_platform','idempotent_replay'].includes(result.status)),true);
  assert.equal(f.calls.filter(call=>call.write).length,1);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status,
    'waiting_platform');
});

test('a failed prewrite checkpoint retains the unknown intent and forbids replay',async()=>{
  const f=await fixture({expireLimitAfterIntentChunk:0,failPrewriteCheckpoint:true});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await f.runtime.run(input)).status,'unknown_outcome');
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].status,'intent');
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState,'intent_persisted');
  assert.equal((await f.restartRuntime().run(input)).status,'idempotent_replay');
  assert.equal(f.calls.length,0);
});

test('a sent first chunk remains observable after the next chunk is proven unsent',async()=>{
  const f=await fixture({count:3,maxItemsPerRequest:1,expireLimitAfterIntentChunk:1,
    observationItems:[[{offer_id:'BATCH-02',product_id:910002,status:'imported',errors:[]}]]});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await f.runtime.run(input)).status,'waiting_platform');
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchImportJobs[0].chunks.map(chunk=>chunk.status),
    ['waiting_platform','prewrite_blocked','not_sent']);
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState,'task_received');
  assert.deepEqual(f.calls.map(call=>call.write),[true]);
  assert.equal((await f.restartRuntime().run(input)).status,'idempotent_replay');
  assert.equal((await f.restartRuntime().observe({...input,chunkIndex:0})).status,'partial_failure');
  assert.deepEqual(f.calls.map(call=>call.write),[true,false]);
  assert.equal(f.calls.some(call=>call.body.items?.some(item=>item.offer_id==='BATCH-04')),false);
});

test('typed transport with attempted transmission remains unknown after one write',async()=>{
  const f=await fixture({failImportCall:1,importFailure:new OzonDEHttpTransportError(
    'OZON_DE_HTTP_CONNECTION_FAILED',{externalRequestState:'unknown_outcome',
      requestTransmission:'attempted'})});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await f.runtime.run(input)).status,'unknown_outcome');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status,
    'unknown_outcome');
  assert.equal((await f.restartRuntime().run(input)).status,'idempotent_replay');
  assert.equal(f.calls.filter(call=>call.write).length,1);
});

test('adapter startup failure can resume only a never-sent chunk', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ createAdapterFailures: 1 });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await assert.rejects(() => runtime.run(input), /synthetic adapter startup failure/);
  assert.equal((await repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status, 'not_sent');
  assert.equal((await runtime.run(input)).status, 'waiting_platform');
  assert.equal(calls.filter(call => call.write).length, 1);
});

test('a restart sends only the frozen canonical items and rejects saved content drift',async()=>{
  const f=await fixture({createAdapterFailures:1});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  await assert.rejects(()=>f.runtime.run(input),/synthetic adapter startup failure/);
  const saved=(await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0];
  assert.equal(saved.frozenImport.schemaVersion,'d-batch-frozen-import-v1');
  assert.equal(JSON.stringify(saved.frozenImport).includes('local-asset:'),false);
  assert.equal((await f.runtime.run(input)).status,'waiting_platform');
  assert.deepEqual(f.calls.find(call=>call.write).body.items,saved.frozenImport.items);
  const drift=await fixture({createAdapterFailures:1});
  const driftInput={...input,members:drift.members,adapterCapabilities:drift.capability};
  await assert.rejects(()=>drift.runtime.run(driftInput),/synthetic adapter startup failure/);
  await drift.repository.transact(document=>{
    document.runtime.dBatchImportJobs[0].chunks[0].frozenImport.items[0].name='mutated after admission';
    return {changed:true,document,result:null};
  });
  await assert.rejects(()=>drift.runtime.run(driftInput),/D_BATCH_FROZEN_IMPORT_INVALID/);
  assert.equal(drift.calls.filter(call=>call.write).length,0);
  await drift.repository.transact(document=>{
    const frozen=document.runtime.dBatchImportJobs[0].chunks[0].frozenImport;
    frozen.items[0].name=saved.frozenImport.items[0].name;
    frozen.memberSources[0].stock+=1;
    return {changed:true,document,result:null};
  });
  await assert.rejects(()=>drift.runtime.run(driftInput),/D_BATCH_FROZEN_IMPORT_INVALID/);
  assert.equal(drift.calls.filter(call=>call.write).length,0);
});

test('current single-SKU preflight must still pass for every batch member before admission', async () => {
  const { repository, runtime, members, capability, calls } = await fixture();
  const before = await repository.readSnapshot();
  const changed = members.map(member => ({ ...member }));
  changed[1].platformWritePreflight = structuredClone(changed[1].platformWritePreflight);
  changed[1].platformWritePreflight.permission.status = 'denied';
  await assert.rejects(() => runtime.run({ batchId: 'd-batch:synthetic', members: changed,
    adapterCapabilities: capability, workerId: 'worker:batch-synthetic' }), /MEMBER_NOT_READY/);
  assert.deepEqual(await repository.readSnapshot(), before);
  assert.equal(calls.length, 0);
});

test('a live single-SKU D job reserves the same offer against batch admission',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture();
  await repository.transact(document=>{
    document.runtime.softwareJobs=[{candidateId:members[0].request.candidateId,
      jobType:'d_production_execution',status:'claimed'}];
    return {changed:true,document,result:null};
  });
  await assert.rejects(runtime.run({batchId:'d-batch:synthetic',members,
    adapterCapabilities:capability,workerId:'worker:batch-synthetic'}),
  /MEMBER_CHANGED_OR_SINGLE_BUSY/);
  assert.equal(calls.length,0);
  assert.equal((await repository.readSnapshot()).runtime.dBatchImportJobs,undefined);
});

test('a failed receipt checkpoint leaves the sent intent unknown and forbids replay', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ failReceipt: true });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  assert.equal((await runtime.run(input)).status, 'unknown_outcome');
  const job = (await repository.readSnapshot()).runtime.dBatchImportJobs[0];
  assert.equal(job.chunks[0].status, 'intent');
  assert.equal(calls.filter(call => call.write).length, 1);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 1);
});

test('unknown task observation is read-only reconcilable after lease expiry', async () => {
  const incomplete = [{ offer_id: 'BATCH-A', product_id: 910001, status: 'imported', errors: [] }];
  const complete = [...incomplete, { offer_id: 'BATCH-B', product_id: 910002, status: 'imported', errors: [] }];
  const { repository, runtime, members, capability, calls, workerRegistry, setTime } = await fixture({
    observationItems: [incomplete, complete] });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await runtime.run(input);
  assert.equal((await runtime.observe({ ...input, chunkIndex: 0 })).status, 'unknown_outcome');
  setTime('2026-08-22T07:26:01.000Z');
  workerRegistry.heartbeat({ workerId: input.workerId, version: 'v1', capabilities: ['ozon-production-execution'] });
  await assert.rejects(() => runtime.observe({ ...input, chunkIndex: 0 }), /NOT_ADMITTED/);
  await runtime.reclaim({ batchId: input.batchId, workerId: input.workerId });
  const observed = await runtime.observe({ ...input, chunkIndex: 0 });
  assert.equal(observed.status, 'imported_awaiting_inventory');
  assert.deepEqual((await repository.readSnapshot()).runtime.dProductionBatches[0].members.map(member => member.status),
    ['imported_awaiting_inventory_and_e', 'imported_awaiting_inventory_and_e']);
  assert.deepEqual(calls.map(call => call.write), [true, false, false]);
});

test('an expired worker heartbeat cannot renew itself through a batch checkpoint', async () => {
  const { runtime, members, capability, calls, workerRegistry, setTime } = await fixture();
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await runtime.run(input);
  setTime('2026-08-22T07:25:31.000Z');
  await assert.rejects(() => runtime.observe({ ...input, chunkIndex: 0 }), /WORKER_CHANGED/);
  assert.equal(workerRegistry.findEligible(['ozon-production-execution']).length, 0);
  assert.equal(calls.filter(call => !call.write).length, 0);
  workerRegistry.heartbeat({ workerId: input.workerId, version: 'v1',
    capabilities: ['ozon-production-execution'] });
  assert.equal((await runtime.observe({ ...input, chunkIndex: 0 })).status, 'partial_failure');
});

test('a selected 32-SKU family imports 31 once after its first SKU already succeeded', async t => {
  const { completedCandidate } = await deSoftwareJobScopeFixture({ merchantSku: 'BATCH-FIRST' });
  const firstRecord = completedCandidate.lifecycleV11.skuPackage.productionRecord;
  const { repository, runtime, restartRuntime, members, capability, calls } = await fixture({ count: 31 });
  await repository.transact(document => {
    document.candidates.unshift(structuredClone(completedCandidate));
    return { changed: true, document, result: null };
  });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  const outcome = await runtime.run(input);
  const replay = await runtime.run(input);
  const restartedReplay = await restartRuntime().run(input);
  const saved = await repository.readSnapshot();
  const writes = structuredClone(calls.filter(call => call.write));
  const excludedCandidate = structuredClone(saved.candidates.find(candidate => candidate.id === completedCandidate.id));
  const batch = structuredClone(saved.runtime.dProductionBatches[0]);
  const job = structuredClone(saved.runtime.dBatchImportJobs[0]);
  await t.test('31 authorized members send four persisted tasks within the synthetic limit', () => {
    assert.equal(outcome.status, 'waiting_platform');
    assert.deepEqual(writes.map(call => call.body.items.length), [10, 10, 10, 1]);
    assert.equal(job.chunks.every(chunk => chunk.status === 'waiting_platform'), true);
    assert.equal(new Set(job.chunks.map(chunk => chunk.taskId)).size, 4);
    assert.equal(writes.some(call => call.body.items?.some(item => item.offer_id === 'BATCH-FIRST')), false);
    assert.equal(replay.status, 'idempotent_replay');
    assert.equal(writes.length, 4);
  });
  await t.test('a previously successful first SKU stays excluded when the other 31 import as one batch', () => {
    assert.equal(validateProductionRecord(firstRecord).valid, true);
    assert.equal(firstRecord.merchantSku, 'BATCH-FIRST');
    assert.equal(writes.flatMap(call => call.body.items).some(item => item.offer_id === firstRecord.merchantSku), false);
    assert.deepEqual(excludedCandidate, completedCandidate);
    assert.deepEqual(batch.excludedOfferIds, [firstRecord.merchantSku]);
    assert.equal(restartedReplay.status, 'idempotent_replay');
    assert.equal(writes.length, 4);
  });
});
