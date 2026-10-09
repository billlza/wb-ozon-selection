import { isDeepStrictEqual } from 'node:util';
import { createProductionPlan } from './production-plan.mjs';
import { runPlatformWritePreflight } from './platform-write-preflight.mjs';
import { prepareSingleSkuDExecution } from './d-e-software-closure.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter, OZON_DE_READBACK_ENDPOINTS } from './ozon-seller-api-de-adapter.mjs';
import { createPersistedDBatchImportRuntime } from './d-batch-import-runtime.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { applyDBatchStockEvent, reclaimDBatchStockJob } from './d-batch-stock-state.mjs';
import { randomUUID } from 'node:crypto';
import { OzonDEHttpTransportError } from './ozon-de-http-configuration.mjs';
import { createDBatchOfferRecord, createDBatchEJob, applyDBatchEJobEvent,
  reclaimDBatchEJob, createDBatchEReadback } from './d-batch-offer-readback.mjs';
import { assertDBatchFrozenImport } from './d-batch-import-state.mjs';

const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.trim() !== '';

function savedBatch(document, batchId) {
  const matches = document.runtime?.dProductionBatches?.filter(batch => batch.batchId === batchId);
  if (matches?.length !== 1 || !['d-batch-production-authorization-v1',
    'd-batch-production-authorization-v2'].includes(matches[0].schemaVersion)) {
    throw new Error('D_BATCH_SERVICE_BATCH_NOT_UNIQUE');
  }
  return matches[0];
}

function candidateFor(document, saved) {
  const matches = document.candidates.filter(candidate => candidate.id === saved.candidateId);
  if (matches.length !== 1) throw new Error('D_BATCH_SERVICE_CANDIDATE_NOT_UNIQUE');
  const candidate = matches[0], sku = candidate.lifecycleV11?.skuPackage;
  if (candidate.dataRevision !== saved.resultRevision || sku?.skuPackageId !== saved.skuPackageId ||
      sku?.productionAuthorization?.authorizationId !== saved.authorizationId ||
      fingerprintCanonicalRecord(sku.productionAuthorization) !== saved.authorizationFingerprint ||
      sku.dSoftwareExecution || sku.productionRecord || sku.eVerificationRecord) {
    throw new Error('D_BATCH_SERVICE_MEMBER_CHANGED');
  }
  return candidate;
}

function memberGrouping(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  const choices = candidate.sourceCapture?.skuChoices;
  const color = choices?.length === 1 && choices[0].sourceSkuId === sku.supplierSkuId
    ? choices[0].attributes?.颜色 : null;
  const model = candidate.siblingSourceV1?.parentCardBinding?.model;
  if (!text(color) || !text(model)) throw new Error('D_BATCH_SERVICE_GROUPING_UNVERIFIED');
  return { colorKey: color.trim(), modelKey: model.trim() };
}

function combineCapabilities(members, batch) {
  const first = members[0].adapterCapabilities;
  if (first?.status !== 'ready' || !sameStoreRef(first.storeRef, batch.storeRef)) {
    throw new Error('D_BATCH_SERVICE_CAPABILITIES_NOT_READY');
  }
  const fields = ['platform','store','storeRef','warehouseRef','credentialAlias','warehouseId',
    'adapterVersion','protocolVersion'];
  const sameProtocol = (a, b) => {
    if (!text(a?.evidenceRef) || !text(b?.evidenceRef)) return false;
    const { evidenceRef: aRef, ...aFacts } = a;
    const { evidenceRef: bRef, ...bFacts } = b;
    return text(aRef) && text(bRef) && isDeepStrictEqual(aFacts, bFacts);
  };
  const assets = new Map();
  for (const member of members) {
    const capability = member.adapterCapabilities;
    if (capability?.status !== 'ready' || fields.some(field => !isDeepStrictEqual(capability[field], first[field])) ||
        ['productImport','inventoryWrite','independentReadback'].some(field =>
          !sameProtocol(capability[field], first[field])) ||
        capability.assetTransport?.status !== 'verified' ||
        !isDeepStrictEqual(capability.assetTransport.approvedHosts, first.assetTransport?.approvedHosts)) {
      throw new Error('D_BATCH_SERVICE_ACCOUNT_EVIDENCE_CONFLICT');
    }
    for (const asset of capability.assetTransport.resolvedAssets) {
      const prior = assets.get(asset.assetId);
      if (prior && !isDeepStrictEqual(prior, asset)) throw new Error('D_BATCH_SERVICE_ASSET_ID_CONFLICT');
      assets.set(asset.assetId, asset);
    }
  }
  if (!Number.isSafeInteger(first.productImport?.maxItemsPerRequest) ||
      first.productImport.maxItemsPerRequest > 100 ||
      !text(first.productImport?.limitEvidenceRef) ||
      !text(first.productImport?.limitObservedAt) ||
      !text(first.productImport?.validUntil)) throw new Error('D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED');
  return { ...clone(first), assetTransport: { ...clone(first.assetTransport), resolvedAssets: [...assets.values()].map(asset => clone(asset)) } };
}

function sameCurrentCapabilities(saved, checked) {
  const { inspectedAt: savedAt, ...savedFacts } = saved;
  const { inspectedAt: checkedAt, ...checkedFacts } = checked;
  return text(savedAt) && text(checkedAt) && isDeepStrictEqual(savedFacts, checkedFacts);
}

/** Builds only from saved batch members, current bindings and persisted account evidence. */
export function createDBatchImportSoftwareService({ repository, runtimeMode, workerRegistry, serverClock,
  services, loadCurrentProductionBinding, loadBatchMemberEvidence, loadBatchEReadEvidence, loadBatchObservationPolicy, requestJson }) {
  if (typeof loadBatchMemberEvidence !== 'function' || typeof loadBatchEReadEvidence !== 'function' || typeof requestJson !== 'function') {
    throw new Error('D_BATCH_SERVICE_DEPENDENCY_REQUIRED');
  }
  if (typeof loadBatchObservationPolicy !== 'function') throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_REQUIRED');
  const resolveService = candidate => {
    const bindingId = candidate.lifecycleV11.skuPackage.productionAuthorization.executionBinding.bindingId;
    const service = services.get(bindingId);
    if (!service) throw new Error('D_BATCH_SERVICE_BINDING_NOT_REGISTERED');
    const binding = loadCurrentProductionBinding(candidate, service);
    if (!binding || binding.then) throw new Error('D_BATCH_SERVICE_CURRENT_BINDING_REQUIRED');
    return { service, binding };
  };
  async function prepare(batchId, createdAt = serverClock()) {
    const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
    if (!['authorized','import_admitted','claimed','waiting_platform','partial_failure','unknown_outcome',
      'imported_awaiting_inventory'].includes(batch.status)) {
      throw new Error('D_BATCH_SERVICE_BATCH_NOT_RUNNABLE');
    }
    const members = [];
    const planCreatedAt=batch.schemaVersion==='d-batch-production-authorization-v2'
      ?batch.confirmedAt:createdAt;
    if(!text(planCreatedAt)||Number.isNaN(Date.parse(planCreatedAt)))
      throw new Error('D_BATCH_SERVICE_PLAN_TIME_REQUIRED');
    let workerId = null;
    for (const saved of batch.members) {
      const candidate = candidateFor(document, saved);
      const { service, binding } = resolveService(candidate);
      if (workerId !== null && workerId !== service.worker.workerId) throw new Error('D_BATCH_SERVICE_WORKER_CONFLICT');
      workerId = service.worker.workerId;
      const observationPolicy = loadBatchObservationPolicy({ candidate: clone(candidate),
        productionBinding: clone(binding), batch: clone(batch) });
      if (!observationPolicy) throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_MISSING');
      assertDPlatformObservationPolicy(observationPolicy);
      if (members.length > 0 && !isDeepStrictEqual(observationPolicy, members[0].observationPolicy)) {
        throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_CONFLICT');
      }
      const sku = candidate.lifecycleV11.skuPackage;
      const plan = sku.dAssetTransport?.intent?.productionPlan ?? createProductionPlan({
        productionAuthorization: sku.productionAuthorization, candidateId: candidate.id,
        candidateRevision: candidate.dataRevision, skuPackage: sku, createdAt:planCreatedAt });
      const evidence = await loadBatchMemberEvidence({ candidate: clone(candidate), productionBinding: clone(binding), batch: clone(batch) });
      const preflight = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: evidence.checkedAt,
        inspectPlatform: async () => clone(evidence.inspection) });
      const prepared = prepareSingleSkuDExecution({ productionPlan: plan,
        productionAuthorization: plan.sourceAuthorization, platformWritePreflight: preflight,
        adapterCapabilities: evidence.capabilities, currentProductionBinding: binding, preparedAt: evidence.checkedAt });
      if (prepared.status !== 'ready') throw new Error(`D_BATCH_SERVICE_MEMBER_NOT_READY:${candidate.id}:${prepared.gaps.map(gap => gap.code).join(',')}`);
      const grouping = memberGrouping(candidate);
      members.push({ request: prepared.executableRequest, executionContext: { productionPlan: plan,
        currentProductionBinding: binding, serverClock: () => evidence.checkedAt },
      platformWritePreflight: preflight, adapterCapabilities: evidence.capabilities,
      ...grouping, sourceTechnicalStatus: 'not_started', observationPolicy });
    }
    return { batch, members, adapterCapabilities: combineCapabilities(members, batch), workerId };
  }
  async function prepareObservation(batchId, chunkIndex) {
    const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
    const jobs = document.runtime?.dBatchImportJobs?.filter(job => job.batchId === batchId) ?? [];
    if (jobs.length !== 1 || !Number.isSafeInteger(chunkIndex) ||
        !['waiting_platform','observed_pending','unknown_outcome'].includes(jobs[0].chunks[chunkIndex]?.status) ||
        !text(jobs[0].chunks[chunkIndex].taskId)) throw new Error('D_BATCH_SERVICE_OBSERVATION_TASK_REQUIRED');
    const offerId = jobs[0].chunks[chunkIndex].offerIds[0];
    const saved = batch.members.filter(member => member.offerId === offerId);
    if (saved.length !== 1) throw new Error('D_BATCH_SERVICE_OBSERVATION_MEMBER_MISSING');
    const candidate = candidateFor(document, saved[0]);
    const { service, binding } = resolveService(candidate);
    const evidence = await loadBatchMemberEvidence({ candidate: clone(candidate),
      productionBinding: clone(binding), batch: clone(batch),purpose:'import_observation' });
    const capability = evidence.capabilities;
    if (capability?.status !== 'ready' || !sameStoreRef(capability.storeRef, batch.storeRef) ||
        capability.productImport?.status !== 'verified' ||
        capability.productImport?.endpoint !== '/v3/product/import' ||
        capability.productImport?.statusEndpoint !== '/v1/product/import/info' ||
        !text(capability.productImport.protocolVersion) || !text(capability.productImport.evidenceRef)) {
      throw new Error('D_BATCH_SERVICE_OBSERVATION_EVIDENCE_NOT_READY');
    }
    return { adapterCapabilities: capability, workerId: service.worker.workerId };
  }
  const runtime = createPersistedDBatchImportRuntime({ repository, runtimeMode, workerRegistry, serverClock,
    createAdapter: async ({ adapterCapabilities }) => createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities }),
    verifyCurrentBatchEvidence: async ({ batchId, members, adapterCapabilities, chunkIndex }) => {
      const checked = await prepare(batchId, members[0].executionContext.productionPlan.createdAt);
      if (checked.workerId === null || !sameCurrentCapabilities(adapterCapabilities, checked.adapterCapabilities) ||
          members.length !== checked.members.length || members.some((member, index) =>
            !isDeepStrictEqual(member.request, checked.members[index].request) ||
            !isDeepStrictEqual(member.observationPolicy, checked.members[index].observationPolicy)) ||
          !Number.isSafeInteger(chunkIndex)) throw new Error('D_BATCH_SERVICE_EVIDENCE_DRIFT');
    } });
  let activeObservation = null;
  async function runDueBatchObservations() {
    if (activeObservation) return activeObservation;
    activeObservation = (async () => {
      const document = await repository.readSnapshot(), observedAt = serverClock();
      for (const job of document.runtime?.dBatchImportJobs ?? []) {
        if (!['d-batch-import-job-v2','d-batch-import-job-v3'].includes(job.schemaVersion))
          throw new Error('D_BATCH_SERVICE_JOB_VERSION_INVALID');
        for (const chunk of job.chunks) {
          if (chunk.taskId === null ||
              !['waiting_platform','observed_pending','unknown_outcome'].includes(chunk.status)) continue;
          if (Date.parse(observedAt) >= Date.parse(job.leaseExpiresAt)) {
            await runtime.reclaim({ batchId: job.batchId, workerId: job.workerId });
          } else if (chunk.observationInFlight) continue;
          if (Date.parse(observedAt) >= Date.parse(job.observationPolicy.expiresAt) ||
              chunk.observationReads >= job.observationPolicy.maxQueries) {
            const reason = chunk.observationReads >= job.observationPolicy.maxQueries ? 'query_limit' : 'policy_expired';
            const stopped = await runtime.stopObservation({ batchId: job.batchId,
              workerId: job.workerId, chunkIndex: chunk.index, reason });
            return { status: 'observation_stopped', reason, job: stopped };
          }
          if (Date.parse(observedAt) < Date.parse(chunk.nextObservationAt)) continue;
          const ready = await prepareObservation(job.batchId, chunk.index);
          return runtime.observe({ batchId: job.batchId, members: [],
            adapterCapabilities: ready.adapterCapabilities, workerId: ready.workerId,
            chunkIndex: chunk.index });
        }
      }
      return { status: 'idle' };
    })();
    try { return await activeObservation; } finally { activeObservation = null; }
  }
  function stockSource(document,stockJob){
    const batch=savedBatch(document,stockJob.batchId);
    if(batch.schemaVersion!=='d-batch-production-authorization-v2'||
        batch.postImportScope?.inventoryAction!==stockJob.inventoryAction||
        !batch.postImportScope.eReadbackOfferIds.includes(stockJob.offerId))
      throw new Error('D_BATCH_STOCK_SCOPE_CHANGED');
    const matching=batch.members.filter(member=>member.offerId===stockJob.offerId);
    if(matching.length!==1||matching[0].candidateId!==stockJob.candidateId||
        matching[0].skuPackageId!==stockJob.skuPackageId||
        matching[0].authorizationId!==stockJob.authorizationId||
        matching[0].authorizationFingerprint!==stockJob.authorizationFingerprint)
      throw new Error('D_BATCH_STOCK_MEMBER_CHANGED');
    const importJobs=document.runtime?.dBatchImportJobs?.filter(job=>job.batchId===batch.batchId)??[];
    const observations=importJobs.flatMap(job=>job.chunks.flatMap(chunk=>(chunk.results??[])
      .filter(result=>result.offerId===stockJob.offerId)
      .map(result=>({chunk,chunkIndex:chunk.index,taskId:chunk.taskId,result}))));
    if(importJobs.length!==1||observations.length!==1||observations[0].taskId!==stockJob.taskId||
        observations[0].result.classification!=='imported'||
        observations[0].result.importObservation?.productId!==stockJob.productId)
      throw new Error('D_BATCH_STOCK_IMPORT_SOURCE_CHANGED');
    return {batch,member:matching[0],candidate:candidateFor(document,matching[0]),
      importChunk:observations[0].chunk,
      chunkIndex:observations[0].chunkIndex,
      importObservation:observations[0].result.importObservation};
  }
  async function prepareBatchEReadback(document,stockJob){
    const source=stockSource(document,stockJob);
    const frozen=assertDBatchFrozenImport(source.importChunk.frozenImport,source.importChunk.offerIds);
    const position=source.importChunk.offerIds.indexOf(stockJob.offerId);
    if(position<0||frozen.items[position].offer_id!==stockJob.offerId)
      throw new Error('D_BATCH_E_FROZEN_SOURCE_MISSING');
    const sourceRequest=frozen.memberSources[position];
    const {service,binding}=resolveService(source.candidate);
    if(service.worker.workerId!==stockJob.workerId||
        binding.bindingId!==source.candidate.lifecycleV11.skuPackage.productionAuthorization.executionBinding.bindingId)
      throw new Error('D_BATCH_E_WORKER_SCOPE_CHANGED');
    const evidence=await loadBatchEReadEvidence({candidate:clone(source.candidate),
      productionBinding:clone(binding),batch:clone(source.batch),offerId:stockJob.offerId});
    const capability=evidence.capabilities;
    if(capability?.platform!=='ozon'||
        !sameStoreRef(capability.storeRef,source.batch.storeRef)||
        !sameStoreRef(capability.storeRef,sourceRequest.storeRef)||
        capability.store!==sourceRequest.store||capability.warehouseRef!==sourceRequest.warehouseRef||
        capability.credentialAlias!==sourceRequest.credentialAlias||
        capability.warehouseId!==sourceRequest.warehouseId||
        capability.independentReadback?.status!=='verified'||
        capability.independentReadback.protocolVersion!=='ozon-independent-readback-v2'||
        !text(capability.independentReadback.evidenceRef)||
        !isDeepStrictEqual(capability.independentReadback.endpoints,OZON_DE_READBACK_ENDPOINTS))
      throw new Error('D_BATCH_E_READ_EVIDENCE_NOT_READY');
    // Readback is gated by the current read protocol and a transport that rejects writes.
    // The seller adapter's constructor also carries write capability fields, which are
    // deliberately not reused as authorization for this independent observation.
    return {source:sourceRequest,capabilities:{...clone(capability),status:'ready',
      inventoryWrite:{warehouseId:sourceRequest.warehouseId,prerequisitePolicy:null}}};
  }
  function eligibleStockWorker(stockJob){
    const worker=workerRegistry.findEligible(['ozon-production-execution'])
      .find(value=>value.workerId===stockJob.workerId);
    if(!worker||worker.version!==stockJob.workerVersion)
      throw new Error('D_BATCH_STOCK_WORKER_NOT_CURRENT');
    return worker;
  }
  async function stockCheckpoint(stockJob,event){
    return repository.transact(document=>{
      const jobs=document.runtime?.dBatchStockJobs;
      if(!Array.isArray(jobs))throw new Error('D_BATCH_STOCK_STORE_INVALID');
      const matches=jobs.filter(job=>job.jobId===stockJob.jobId);
      if(matches.length!==1)throw new Error('D_BATCH_STOCK_JOB_NOT_UNIQUE');
      stockSource(document,matches[0]);
      const next=applyDBatchStockEvent({job:matches[0],event:{...event,offerId:stockJob.offerId,
        taskId:stockJob.taskId,productId:stockJob.productId},workerId:stockJob.workerId,
        leaseId:stockJob.leaseId,observedAt:serverClock()});
      jobs[jobs.indexOf(matches[0])]=next;
      return {changed:true,document,result:clone(next)};
    });
  }
  async function prepareStock(stockJob){
    const document=await repository.readSnapshot();
    const {batch,candidate,importObservation}=stockSource(document,stockJob);
    const {service,binding}=resolveService(candidate);
    if(service.worker.workerId!==stockJob.workerId)
      throw new Error('D_BATCH_STOCK_WORKER_SCOPE_CHANGED');
    const sku=candidate.lifecycleV11.skuPackage;
    if(!text(batch.confirmedAt)||Number.isNaN(Date.parse(batch.confirmedAt)))
      throw new Error('D_BATCH_STOCK_PLAN_TIME_REQUIRED');
    const plan=sku.dAssetTransport?.intent?.productionPlan??createProductionPlan({
      productionAuthorization:sku.productionAuthorization,candidateId:candidate.id,
      candidateRevision:candidate.dataRevision,skuPackage:sku,createdAt:batch.confirmedAt});
    const evidence=await loadBatchMemberEvidence({candidate:clone(candidate),
      productionBinding:clone(binding),batch:clone(batch),purpose:'stock_write'});
    const preflight=await runPlatformWritePreflight({productionPlan:plan,checkedAt:evidence.checkedAt,
      inspectPlatform:async()=>clone(evidence.inspection)});
    const prepared=prepareSingleSkuDExecution({productionPlan:plan,
      productionAuthorization:plan.sourceAuthorization,platformWritePreflight:preflight,
      adapterCapabilities:evidence.capabilities,currentProductionBinding:binding,preparedAt:evidence.checkedAt});
    if(prepared.status!=='ready'||prepared.executableRequest.merchantSku!==stockJob.offerId||
        !sameStoreRef(evidence.capabilities.storeRef,batch.storeRef))
      throw new Error('D_BATCH_STOCK_MEMBER_NOT_READY');
    const request=prepared.executableRequest;
    const query={platform:request.platform,store:request.store,storeRef:request.storeRef,
      warehouseRef:request.warehouseRef,credentialAlias:request.credentialAlias,
      warehouseId:request.inventoryWrite.warehouseId,writeAllowed:false,
      merchantSku:request.merchantSku,supplierSkuId:request.supplierSkuId,
      executionKey:request.executionKey,requestReceiptRef:importObservation.requestReceiptRef,
      taskId:stockJob.taskId,productId:stockJob.productId};
    return {request,query,capabilities:evidence.capabilities,executionContext:{productionPlan:plan,
      currentProductionBinding:binding,serverClock}};
  }
  async function runDueBatchStockPrerequisites(){
    const document=await repository.readSnapshot();
    for(const saved of document.runtime?.dBatchStockJobs??[]){
      if(saved.status!=='awaiting_prerequisites')continue;
      let job=saved;
      if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)){
        const worker=eligibleStockWorker(job);
        job=await repository.transact(current=>{
          const jobs=current.runtime?.dBatchStockJobs??[];
          const held=jobs.find(value=>value.jobId===saved.jobId);
          if(!held)throw new Error('D_BATCH_STOCK_JOB_MISSING');
          stockSource(current,held);
          const at=serverClock();
          const next=reclaimDBatchStockJob({job:held,workerId:worker.workerId,
            workerVersion:worker.version,leaseId:`lease:${randomUUID()}`,
            leaseExpiresAt:new Date(Date.parse(at)+held.leaseDurationMs).toISOString(),observedAt:at});
          jobs[jobs.indexOf(held)]=next;
          return {changed:true,document:current,result:clone(next)};
        });
      }
      eligibleStockWorker(job);
      if(Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
        return {status:'precheck_failed',job:await stockCheckpoint(job,{kind:'precheck_blocked',reason:'policy_expired'})};
      const ready=await prepareStock(job);
      await stockCheckpoint(job,{kind:'prerequisites_started'});
      const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:ready.capabilities,
        executionContext:ready.executionContext});
      const beforeRequestSend=async()=>{
        eligibleStockWorker(job);
        const latest=await repository.readSnapshot();
        const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
        if(!held)throw new Error('D_BATCH_STOCK_JOB_MISSING');
        stockSource(latest,held);
        if(held.leaseId!==job.leaseId||held.status!=='prerequisites_in_flight'||
            Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)||
            Date.parse(serverClock())>=Date.parse(held.observationPolicy.expiresAt))
          throw new Error('D_BATCH_STOCK_READ_GUARD_BLOCKED');
      };
      const controller=new AbortController();
      const timeoutMs=Math.min(job.observationPolicy.requestTimeoutMs,
        Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()),
        Date.parse(job.observationPolicy.expiresAt)-Date.parse(serverClock()));
      const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_STOCK_READ_TIMEOUT')),
        Math.max(1,timeoutMs));
      try{
        const priceSentObservation=await adapter.observePriceSent(ready.query,
          {signal:controller.signal,beforeRequestSend});
        const inventoryPrerequisiteObservation=await adapter.observeInventoryPrerequisites(ready.query,
          {signal:controller.signal,beforeRequestSend});
        const next=await stockCheckpoint(job,{kind:'prerequisites_observed',priceSentObservation,
          inventoryPrerequisiteObservation});
        return {status:next.status,job:next};
      }catch(error){
        const reason=controller.signal.aborted?'request_timeout':
          error instanceof OzonDEHttpTransportError?'transport_failure':'system_failure';
        let next;
        try{next=await stockCheckpoint(job,{kind:'prerequisites_failed',reason});}
        catch(checkpointError){throw new AggregateError([error,checkpointError],
          'D_BATCH_STOCK_PRECHECK_FAILURE_CHECKPOINT_FAILED');}
        if(reason==='system_failure')throw error;
        return {status:next.status,job:next};
      }finally{clearTimeout(timer);}
    }
    return {status:'idle'};
  }
  async function runDueBatchStockWrites({allowedBatchIds=null}={}){
    const document=await repository.readSnapshot();
    for(const saved of document.runtime?.dBatchStockJobs??[]){
      if(saved.status!=='ready_to_write'||allowedBatchIds!==null&&!allowedBatchIds.has(saved.batchId))continue;
      let job=saved;
      if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)){
        const worker=eligibleStockWorker(job);
        job=await repository.transact(current=>{
          const jobs=current.runtime?.dBatchStockJobs??[];
          const held=jobs.find(value=>value.jobId===saved.jobId);
          if(!held||held.status!=='ready_to_write')throw new Error('D_BATCH_STOCK_JOB_CHANGED');
          stockSource(current,held);
          const at=serverClock();
          const next=reclaimDBatchStockJob({job:held,workerId:worker.workerId,
            workerVersion:worker.version,leaseId:`lease:${randomUUID()}`,
            leaseExpiresAt:new Date(Date.parse(at)+held.leaseDurationMs).toISOString(),observedAt:at});
          jobs[jobs.indexOf(held)]=next;
          return {changed:true,document:current,result:clone(next)};
        });
      }
      eligibleStockWorker(job);
      const ready=await prepareStock(job);
      const policy=ready.capabilities.inventoryWrite?.prerequisitePolicy;
      if(!policy||fingerprintCanonicalRecord(policy)!==job.prerequisitePolicyFingerprint)
        return {status:'prewrite_blocked',job:await stockCheckpoint(job,
          {kind:'stock_prewrite_blocked',reason:'prerequisite_policy_changed'})};
      if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)||
          Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
        throw new Error('D_BATCH_STOCK_WRITE_LEASE_EXPIRED');
      const observation={priceSentObservation:{...clone(job.priceSentObservation),policy:clone(policy)},
        inventoryPrerequisiteObservation:{...clone(job.inventoryPrerequisiteObservation),policy:clone(policy)}};
      const assertAuthorization=async()=>{
        eligibleStockWorker(job);
        const latest=await repository.readSnapshot();
        const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
        if(!held)throw new Error('D_BATCH_STOCK_JOB_MISSING');
        stockSource(latest,held);
        if(held.leaseId!==job.leaseId||!['ready_to_write','stock_intent'].includes(held.status)||
            held.observedFreeStock!==0||held.prerequisitePolicyFingerprint!==fingerprintCanonicalRecord(policy)||
            Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)||
            Date.parse(serverClock())>=Date.parse(held.observationPolicy.expiresAt))
          throw new Error('D_BATCH_STOCK_WRITE_GUARD_BLOCKED');
      };
      const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson,
        adapterCapabilities:ready.capabilities,executionContext:ready.executionContext});
      const controller=new AbortController();
      const timeoutMs=Math.min(job.observationPolicy.requestTimeoutMs,
        Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()),
        Date.parse(job.observationPolicy.expiresAt)-Date.parse(serverClock()));
      const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_STOCK_WRITE_TIMEOUT')),
        Math.max(1,timeoutMs));
      try{
        const result=await adapter.executeRemainingInventory(ready.request,{observation,
          assertRemainingInventoryAuthorization:assertAuthorization,
          beforeRequestSend:async()=>{
            await assertAuthorization();
            const current=await repository.readSnapshot();
            const held=current.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
            if(held?.status!=='stock_intent')throw new Error('D_BATCH_STOCK_INTENT_REQUIRED');
          },signal:controller.signal,persistCheckpoint:async event=>{
            if(event.kind==='stock_intent')await stockCheckpoint(job,{kind:'stock_intent'});
            else if(event.kind==='stock_receipt_observed'){
              const accepted=event.updated===true&&event.itemCount===1&&event.errorCount===0&&
                event.productId===job.productId&&event.merchantSku===job.offerId&&
                event.warehouseId===ready.request.inventoryWrite.warehouseId;
              await stockCheckpoint(job,accepted?
                {kind:'stock_receipt',accepted:true,inventoryReceiptRef:event.inventoryReceiptRef}:
                {kind:'stock_unknown',reason:'inventory_receipt_incomplete_or_identity_mismatch'});
            }else throw new Error('D_BATCH_STOCK_CHECKPOINT_EVENT_INVALID');
          }});
        if(result.status==='blocked'){
          const latest=await repository.readSnapshot();
          const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
          if(held?.status==='stock_intent')return {status:'prewrite_blocked',job:await stockCheckpoint(job,
            {kind:'stock_prewrite_blocked',reason:result.code})};
          throw new Error(`D_BATCH_STOCK_ADAPTER_BLOCKED:${result.code}`);
        }
        if(result.status==='unknown_outcome'){
          const latest=await repository.readSnapshot();
          const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
          if(held?.status==='stock_intent')return {status:'unknown_outcome',job:await stockCheckpoint(job,
            {kind:'stock_unknown',reason:result.reason})};
          if(held?.status==='unknown_outcome')return {status:'unknown_outcome',job:clone(held)};
        }
        const latest=await repository.readSnapshot();
        const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
        if(result.status!=='accepted'||held?.status!=='stock_accepted')
          throw new Error('D_BATCH_STOCK_RESULT_CHECKPOINT_MISMATCH');
        return {status:'stock_accepted',job:clone(held)};
      }finally{clearTimeout(timer);}
    }
    return {status:'idle'};
  }
  let activeEReadback=null;
  async function runDueBatchEReadbacks(){
    if(activeEReadback)return activeEReadback;
    activeEReadback=(async()=>{
      const snapshot=await repository.readSnapshot();
      for(const saved of snapshot.runtime?.dBatchStockJobs??[]){
        if(!['inventory_deferred','stock_accepted'].includes(saved.status))continue;
        if(saved.inventoryAction==='create_only'&&saved.status!=='inventory_deferred'||
            saved.inventoryAction==='write_authorized_stock'&&saved.status!=='stock_accepted')continue;
        const priorJobs=snapshot.runtime?.dBatchEJobs?.filter(job=>job.batchId===saved.batchId&&
          job.offerId===saved.offerId)??[];
        if(priorJobs.length>1)throw new Error('D_BATCH_E_JOB_NOT_UNIQUE');
        if(priorJobs[0]&&(['completed','read_failed','observation_stopped'].includes(priorJobs[0].status)||
            priorJobs[0].status==='read_in_flight'&&
              Date.parse(serverClock())<Date.parse(priorJobs[0].leaseExpiresAt)))continue;
        const worker=workerRegistry.findEligible(['ozon-independent-readback'])
          .find(value=>value.workerId===saved.workerId);
        if(!worker||worker.version!==saved.workerVersion)
          throw new Error('D_BATCH_E_WORKER_NOT_CURRENT');
        const source=stockSource(snapshot,saved);
        const ready=await prepareBatchEReadback(snapshot,saved);
        const projected=createDBatchOfferRecord({batch:source.batch,member:source.member,
          chunkIndex:source.chunkIndex,stockJob:saved,source:ready.source,
          frozenImport:source.importChunk.frozenImport,chunkOfferIds:source.importChunk.offerIds,
          importObservation:source.importObservation,createdAt:saved.createdAt});
        let job=await repository.transact(document=>{
          const stock=document.runtime?.dBatchStockJobs?.find(value=>value.jobId===saved.jobId);
          if(!stock||stock.status!==saved.status||stock.leaseId!==saved.leaseId)
            throw new Error('D_BATCH_E_STOCK_SOURCE_CHANGED');
          const current=stockSource(document,stock);
          const record=createDBatchOfferRecord({batch:current.batch,member:current.member,
            chunkIndex:current.chunkIndex,stockJob:stock,source:ready.source,
            frozenImport:current.importChunk.frozenImport,chunkOfferIds:current.importChunk.offerIds,
            importObservation:current.importObservation,createdAt:stock.createdAt});
          if(!isDeepStrictEqual(record,projected))throw new Error('D_BATCH_E_RECORD_DRIFT');
          const records=document.runtime.dBatchOfferRecords??[];
          const jobs=document.runtime.dBatchEJobs??[];
          if(!Array.isArray(records)||!Array.isArray(jobs))throw new Error('D_BATCH_E_STORE_INVALID');
          const existingRecords=records.filter(value=>value.recordId===record.recordId);
          const existingJobs=jobs.filter(value=>value.recordId===record.recordId);
          if(existingRecords.length>1||existingJobs.length>1||
              (existingRecords.length===1&&!isDeepStrictEqual(existingRecords[0],record))||
              existingRecords.length!==existingJobs.length)
            throw new Error('D_BATCH_E_SOURCE_CONFLICT');
          if(existingJobs.length===1){
            let held=existingJobs[0];
            if(Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)){
              const at=serverClock();
              held=reclaimDBatchEJob({job:held,workerId:worker.workerId,
                workerVersion:worker.version,leaseId:`lease:${randomUUID()}`,
                leaseExpiresAt:new Date(Date.parse(at)+held.leaseDurationMs).toISOString(),observedAt:at});
              jobs[jobs.indexOf(existingJobs[0])]=held;
              return {changed:true,document,result:clone(held)};
            }
            return {changed:false,result:clone(held)};
          }
          const at=serverClock();
          const created=createDBatchEJob({record,workerId:worker.workerId,workerVersion:worker.version,
            leaseId:`lease:${randomUUID()}`,
            leaseExpiresAt:new Date(Date.parse(at)+stock.leaseDurationMs).toISOString(),
            leaseDurationMs:stock.leaseDurationMs,observationPolicy:stock.observationPolicy,createdAt:at});
          records.push(record);jobs.push(created);
          document.runtime.dBatchOfferRecords=records;document.runtime.dBatchEJobs=jobs;
          return {changed:true,document,result:clone(created)};
        });
        const checkpoint=async(event,result=null)=>repository.transact(document=>{
          const jobs=document.runtime?.dBatchEJobs??[];
          const held=jobs.find(value=>value.jobId===job.jobId);
          if(!held)throw new Error('D_BATCH_E_JOB_MISSING');
          const stock=document.runtime?.dBatchStockJobs?.find(value=>value.jobId===saved.jobId);
          if(!stock||stock.status!==saved.status)throw new Error('D_BATCH_E_STOCK_SOURCE_CHANGED');
          stockSource(document,stock);
          const next=applyDBatchEJobEvent({job:held,event,workerId:job.workerId,
            leaseId:job.leaseId,observedAt:serverClock()});
          jobs[jobs.indexOf(held)]=next;
          if(result){
            if(result.sourceRecordId!==projected.recordId||result.readbackId!==event.resultId)
              throw new Error('D_BATCH_E_RESULT_SCOPE_INVALID');
            const results=document.runtime.dBatchEReadbacks??[];
            if(!Array.isArray(results)||results.some(value=>value.readbackId===result.readbackId))
              throw new Error('D_BATCH_E_RESULT_DUPLICATE');
            results.push(result);document.runtime.dBatchEReadbacks=results;
            if(result.status!=='not_verified'){
              const batch=savedBatch(document,saved.batchId);
              const member=batch.members.find(value=>value.offerId===saved.offerId);
              if(!member)throw new Error('D_BATCH_E_MEMBER_MISSING');
              member.status=result.status;
            }
          }
          return {changed:true,document,result:clone(next)};
        });
        if(Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt)||
            job.readCount>=job.observationPolicy.maxQueries){
          const stopped=await checkpoint({kind:'observation_stopped',
            reason:job.readCount>=job.observationPolicy.maxQueries?'query_limit':'policy_expired'});
          return {status:'observation_stopped',job:stopped};
        }
        job=await checkpoint({kind:'read_started'});
        const guard=async()=>{
          const currentWorker=workerRegistry.findEligible(['ozon-independent-readback'])
            .find(value=>value.workerId===job.workerId);
          if(!currentWorker||currentWorker.version!==job.workerVersion)
            throw new Error('D_BATCH_E_WORKER_NOT_CURRENT');
          const current=await repository.readSnapshot();
          const held=current.runtime?.dBatchEJobs?.find(value=>value.jobId===job.jobId);
          const stock=current.runtime?.dBatchStockJobs?.find(value=>value.jobId===saved.jobId);
          if(!held||!stock||held.leaseId!==job.leaseId||held.status!=='read_in_flight'||
              stock.status!==saved.status||Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)||
              Date.parse(serverClock())>=Date.parse(held.observationPolicy.expiresAt))
            throw new Error('D_BATCH_E_READ_GUARD_BLOCKED');
          stockSource(current,stock);
        };
        const guardedRequest=async(request,options)=>{
          if(request.write!==false)throw new Error('D_BATCH_E_READ_ONLY_REQUIRED');
          await guard();
          return requestJson(request,{...options,beforeRequestSend:guard});
        };
        const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson:guardedRequest,
          adapterCapabilities:ready.capabilities});
        const controller=new AbortController();
        const timeoutMs=Math.min(job.observationPolicy.requestTimeoutMs,
          Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()),
          Date.parse(job.observationPolicy.expiresAt)-Date.parse(serverClock()));
        const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_E_READ_TIMEOUT')),
          Math.max(1,timeoutMs));
        try{
          const observation=await adapter.readbackSellerApi({platform:projected.platform,
            store:projected.store,storeRef:projected.storeRef,warehouseRef:projected.warehouseRef,
            credentialAlias:projected.credentialAlias,warehouseId:projected.warehouseId,
            skuPackageId:projected.skuPackageId,supplierSkuId:projected.supplierSkuId,
            merchantSku:projected.offerId,platformProductId:projected.productId,writeAllowed:false},
          {signal:controller.signal});
          const result=createDBatchEReadback({record:projected,observation,readAt:serverClock()});
          const settled=await checkpoint({kind:'read_completed',resultId:result.readbackId},result);
          return {status:result.status,job:settled,result};
        }catch(error){
          const reason=controller.signal.aborted?'request_timeout':
            error instanceof OzonDEHttpTransportError?'transport_failure':
            String(error?.message).startsWith('OZON_DE_READBACK_')?'platform_data_invalid':'system_failure';
          const result=createDBatchEReadback({record:projected,observation:null,
            readAt:serverClock(),readFailure:reason});
          let settled;
          try{settled=await checkpoint({kind:'read_failed',resultId:result.readbackId},result);}
          catch(checkpointError){throw new AggregateError([error,checkpointError],
            'D_BATCH_E_FAILURE_CHECKPOINT_FAILED');}
          if(reason==='system_failure')throw error;
          return {status:'read_failed',job:settled,result};
        }finally{clearTimeout(timer);}
      }
      return {status:'idle'};
    })();
    try{return await activeEReadback;}finally{activeEReadback=null;}
  }
  const activeWriteBatches=new Set();
  const MAX_ACTIVE_BATCH_WRITES=32;
  function activateStockContinuation(batchId){
    if(!activeWriteBatches.has(batchId)&&activeWriteBatches.size>=MAX_ACTIVE_BATCH_WRITES)
      throw new Error('D_BATCH_SERVICE_ACTIVE_WRITE_CAPACITY_REACHED');
    activeWriteBatches.add(batchId);
  }
  async function runDueBatchContinuations(){
    const current=await repository.readSnapshot();
    for(const batchId of activeWriteBatches){
      const job=current.runtime?.dBatchImportJobs?.find(value=>value.batchId===batchId);
      if(!job||Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
        activeWriteBatches.delete(batchId);
    }
    const importObservation=await runDueBatchObservations();
    if(importObservation.status!=='idle')return importObservation;
    const prerequisite=await runDueBatchStockPrerequisites();
    if(prerequisite.status!=='idle')return prerequisite;
    if(activeWriteBatches.size>0){
      const snapshot=await repository.readSnapshot();
      const due=snapshot.runtime?.dBatchStockJobs?.some(job=>
        activeWriteBatches.has(job.batchId)&&job.status==='ready_to_write');
      if(due){
        const write=await runDueBatchStockWrites({allowedBatchIds:activeWriteBatches});
        if(write.status!=='idle')return write;
      }
    }
    return runDueBatchEReadbacks();
  }
  return Object.freeze({
    async runAuthorizedBatch({ batchId }) {
      const snapshot = await repository.readSnapshot();
      const batch=savedBatch(snapshot, batchId);
      const jobs = snapshot.runtime?.dBatchImportJobs?.filter(job => job.batchId === batchId) ?? [];
      if (jobs.length > 1) throw new Error('D_BATCH_SERVICE_JOB_NOT_UNIQUE');
      if (jobs.length === 1 && (jobs[0].chunks.every(chunk => chunk.status !== 'not_sent') ||
          jobs[0].chunks.some(chunk => ['intent', 'unknown_outcome', 'prewrite_blocked'].includes(chunk.status)))) {
        return { status: 'idempotent_replay', executionStatus: jobs[0].status, job: clone(jobs[0]) };
      }
      if(batch.schemaVersion==='d-batch-production-authorization-v2'&&
          !activeWriteBatches.has(batchId)&&activeWriteBatches.size>=MAX_ACTIVE_BATCH_WRITES)
        throw new Error('D_BATCH_SERVICE_ACTIVE_WRITE_CAPACITY_REACHED');
      const ready = await prepare(batchId);
      const result=await runtime.run({ batchId, members: ready.members, adapterCapabilities: ready.adapterCapabilities,
        workerId: ready.workerId });
      if(batch.schemaVersion==='d-batch-production-authorization-v2')activateStockContinuation(batchId);
      return result;
    },
    async resumeAuthorizedBatchContinuations({batchId}){
      const document=await repository.readSnapshot(),batch=savedBatch(document,batchId);
      if(batch.schemaVersion!=='d-batch-production-authorization-v2')
        throw new Error('D_BATCH_SERVICE_RESUME_SCOPE_INVALID');
      const jobs=document.runtime?.dBatchImportJobs?.filter(job=>job.batchId===batchId)??[];
      if(jobs.length!==1)throw new Error('D_BATCH_SERVICE_RESUME_JOB_REQUIRED');
      const stockJobs=document.runtime?.dBatchStockJobs?.filter(job=>job.batchId===batchId)??[];
      if(stockJobs.length===0||!stockJobs.some(job=>['awaiting_prerequisites','ready_to_write'].includes(job.status)))
        throw new Error('D_BATCH_SERVICE_RESUME_NOTHING_UNSENT');
      for(const job of stockJobs.filter(value=>['awaiting_prerequisites','ready_to_write'].includes(value.status))){
        eligibleStockWorker(job);
        if(Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
          throw new Error('D_BATCH_SERVICE_RESUME_POLICY_EXPIRED');
        await prepareStock(job);
      }
      activateStockContinuation(batchId);
      return {status:'continuation_activated',batchId};
    },
    async observeBatchChunk({ batchId, chunkIndex }) {
      const ready = await prepareObservation(batchId, chunkIndex);
      return runtime.observe({ batchId, members: [], adapterCapabilities: ready.adapterCapabilities,
        workerId: ready.workerId, chunkIndex });
    },
    async reclaimBatchLease({ batchId }) {
      const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
      if (batch.members.length === 0) throw new Error('D_BATCH_SERVICE_EMPTY_BATCH');
      const workerId = resolveService(candidateFor(document, batch.members[0])).service.worker.workerId;
      return runtime.reclaim({ batchId, workerId });
    },
    runDueBatchObservations,runDueBatchStockPrerequisites,runDueBatchStockWrites,
    runDueBatchEReadbacks,runDueBatchContinuations
  });
}
