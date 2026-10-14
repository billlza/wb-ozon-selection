import test from 'node:test';
import assert from 'node:assert/strict';
import { productionOwnerDecisionHttpFixture } from './helpers/d-e-saved-api-fixture.mjs';
import { createSelectionReviewRuntimeConfiguration } from '../lib/runtime-configuration.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createOzonDEHttpTransport } from '../lib/ozon-de-http-transport.mjs';
import { createOzonAccountReadBindingResolver, accountReadBindingForProduction } from '../lib/ozon-account-read-preparation.mjs';
import { createOzonAccountReadEvidenceSource, composeOzonAccountPreflightEvidence } from '../lib/ozon-account-read-evidence.mjs';
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from '../lib/ozon-de-preflight-evidence-reader.mjs';
import { loadOzonDEProtocolCatalog } from '../lib/ozon-de-protocol-catalog.mjs';
import { createOzonDEPreflightProvider } from '../lib/ozon-de-preflight-provider.mjs';
import { createDEProductionRuntimeServices } from '../lib/d-e-runtime-services.mjs';
import { createOzonAccountReadServices } from '../lib/ozon-account-read-services.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { OZON_DE_READBACK_ENDPOINTS, OZON_DE_LEGACY_READBACK_ENDPOINTS, OZON_PRODUCT_IMPORT_INFO_ENDPOINT } from '../lib/ozon-seller-api-de-adapter.mjs';
import { createOzonAccountReadRuntime } from '../lib/ozon-account-read-runtime.mjs';
import { PRODUCTION_WRITE_FIELDS } from '../lib/production-authorization-preparation.mjs';
import { createProductionPlan } from '../lib/production-plan.mjs';
import { runPlatformWritePreflight } from '../lib/platform-write-preflight.mjs';
import { createDPlatformObservationPolicyResolver } from '../lib/runtime-configuration.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { loadOzonProductImportBatchLimitEvidence } from '../lib/ozon-product-import-batch-limit.mjs';

async function fixture({ clockOffsetMs = 0 } = {}) {
  const base = await productionOwnerDecisionHttpFixture(), clock = () => new Date(Date.parse(base.owner.formal.at) + clockOffsetMs).toISOString();
  const accountService = { ...base.service, schemaVersion: 'ozon-account-read-service-binding-v1',
    serviceId: 'service:synthetic:account-read', workerId: 'worker:synthetic:account-read' };
  const env = {
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: base.candidate.targetStore, platform: 'ozon', storeRef: base.candidate.storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([base.binding]),
    SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([base.service]),
    SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: JSON.stringify([accountService]),
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify([{ credentialAlias: base.binding.credentialAlias, clientId: '700123',
      keychainService: 'synthetic-account-source', keychainAccount: 'synthetic-account' }]),
    // r69 起：没有平台查询策略就不许上架（主人 2026-09-23 选定的严格档）。
    // 本文件测的是**账户核验**那条链，不是策略门，所以这里给足一条有效策略，
    // 免得策略缺失把账户缺口盖掉、让这些用例测的东西和名字对不上。
    SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: JSON.stringify({
      pumpIntervalMs: 1000,
      policies: [{
        candidateId: base.candidate.id,
        skuPackageId: base.candidate.lifecycleV11.skuPackage.skuPackageId,
        // 策略解析器不按 authorizationRef 匹配（runtime-configuration.mjs:44 只看候选+SKU+绑定两项），
        // 这里只是配置时的上下文记录；本 fixture 建立时授权还不存在，用合成值即可。
        authorizationRef: 'production-auth:synthetic:account-integration',
        productionBindingId: base.binding.bindingId,
        productionConfigurationVersion: base.binding.configurationVersion,
        revision: base.candidate.dataRevision,
        policy: { schemaVersion: 'd-platform-observation-policy-v1',
          policyRef: 'policy:synthetic:account-integration', version: 'version:1',
          maxQueries: 4, intervalMs: 10, requestTimeoutMs: 1000,
          expiresAt: '2099-01-01T00:00:00.000Z' }
      }]
    })
  };
  const configuration = createSelectionReviewRuntimeConfiguration({ env, appDir: '/tmp/synthetic-account-integration', argv: [] });
  const repository = createMemoryBusinessStateRepository(base.document), workerRegistry = createLocalDevelopmentWorkerRegistry({ clock });
  let secretReads = 0; const requests = [];
  const responses = {
    '/v1/roles': { expires_at: '2027-01-01T00:00:00.000Z', roles: [{ name: 'test', methods: ['/v3/product/import', '/v2/products/stocks',
      OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_READBACK_ENDPOINTS)] }] },
    '/v1/seller/info': { company: { currency: 'CNY', inn: 'private-tax-value' } },
    '/v2/warehouse/list': { has_next: false, warehouses: [{ warehouse_id: Number(base.binding.warehouseId), is_rfbs: true,
      status: 'created', warehouse_type: 'RFBS', pause_at: null }] }
  };
  const transport = createOzonDEHttpTransport({ productionBindings: configuration.productionBindings,
    credentialBindings: configuration.ozonDECredentialBindings, readSecret: async () => { secretReads++; return 'synthetic-secret'; },
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url).pathname; assert.ok(Object.hasOwn(responses, endpoint));
      requests.push({ endpoint, body: options.body });
      return new Response(JSON.stringify(responses[endpoint]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  const resolver = createOzonAccountReadBindingResolver(configuration);
  const source = createOzonAccountReadEvidenceSource({ repository, loadCurrentReadBinding: resolver });
  const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository, verifySourceReceipt: source.verifySourceReceipt });
  const provider = createOzonDEPreflightProvider({ readEvidence: reader, serverClock: clock });
  const de = createDEProductionRuntimeServices({ repository, runtimeMode: 'local_development', serverClock: clock, workerRegistry,
    deServiceBindings: configuration.deServiceBindings, productionBindings: configuration.productionBindings,
    requestJson: transport.requestJson, inspectPlatform: provider.inspectPlatform, loadAdapterCapabilities: provider.loadAdapterCapabilities,
    upload: async () => { throw new Error('unexpected asset request'); }, resolveLocalAsset: async () => { throw new Error('unexpected asset read'); },
    // 与正式服务同一接线：策略解析器是**同一个实例**，D 执行层与视图层读的是同一份，
    // 否则执行层取不到策略、r69 那道门会在发导入之前把整条路拒掉。
    loadDPlatformObservationPolicy: createDPlatformObservationPolicyResolver(configuration),
    preflightRequestMode: 'persisted_evidence_only' });
  const services = createOzonAccountReadServices({ configuration, repository, workerRegistry, serverClock: clock,
    requestJson: transport.requestJson, evidenceSource: source, preflightProvider: provider, deRuntimeServices: de });
  const preparation = services.preparation({ candidate: base.candidate, document: base.document }), option = preparation.options[0];
  const input = { candidateId: base.candidate.id, skuPackageId: preparation.skuPackageId, expectedRevision: preparation.expectedRevision,
    bindingId: option.bindingId, configurationVersion: option.configurationVersion, scopeRef: option.scopeRef,
    expiresAt: '2026-09-01T00:00:00.000Z', confirmReadOnce: true, idempotencyKey: 'owner-read:source-integration' };
  return { base, env, configuration, repository, source, reader, provider, services, input, requests, responses,
    connectCatalog(protocolCatalog, overrides = {}) {
      const source = createOzonAccountReadEvidenceSource({ repository, loadCurrentReadBinding: resolver, protocolCatalog });
      const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository, verifySourceReceipt: source.verifySourceReceipt });
      const provider = createOzonDEPreflightProvider({ readEvidence: reader, serverClock: clock });
      const restartedWorkers = createLocalDevelopmentWorkerRegistry({ clock });
      const restartedDE = createDEProductionRuntimeServices({ repository, runtimeMode: 'local_development', serverClock: clock,
        workerRegistry: restartedWorkers, deServiceBindings: configuration.deServiceBindings, productionBindings: configuration.productionBindings,
        requestJson: overrides.requestJson ?? transport.requestJson, inspectPlatform: provider.inspectPlatform, loadAdapterCapabilities: provider.loadAdapterCapabilities,
        upload: overrides.upload ?? (async () => { throw new Error('unexpected asset request'); }),
        resolveLocalAsset: async () => { throw new Error('unexpected asset read'); },
        // 重启后的实例同样要接策略解析器，否则 D 执行层取不到策略、发导入之前就被拒。
        loadDPlatformObservationPolicy: createDPlatformObservationPolicyResolver(configuration),
        preflightRequestMode: 'persisted_evidence_only' });
      const services = createOzonAccountReadServices({ configuration, repository, workerRegistry: restartedWorkers, serverClock: clock,
        requestJson: transport.requestJson, evidenceSource: source, preflightProvider: provider, deRuntimeServices: restartedDE });
      return { source, reader, provider, services };
    },
    advanceClock(ms) { clockOffsetMs += ms; }, get secretReads() { return secretReads; } };
}

async function authorizeProduction(f) {
  return commitSingleOwnerProductionAuthorization({ ...f.base.owner.args, repository: f.repository });
}

test('real local transport, pre-PA read and later PA use the same saved source without repeating account requests', async () => {
  const f = await fixture(), original = await f.repository.readSnapshot();
  assert.equal(f.secretReads, 0); assert.deepEqual(f.requests, []);
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  assert.equal(read.status, 'completed'); assert.equal(read.requestsSent, 3); assert.equal(read.productionStatus, null);
  const observed = await f.repository.readSnapshot(); assert.deepEqual(observed.candidates, original.candidates);
  assert.equal(JSON.stringify(observed).includes('private-tax-value'), false);
  assert.equal(JSON.stringify(observed).includes('synthetic-secret'), false);
  assert.deepEqual(f.requests.map(value => value.endpoint), ['/v1/roles', '/v1/seller/info', '/v2/warehouse/list']);
  assert.equal(f.requests[0].body, undefined); assert.equal(f.requests[1].body, undefined);
  assert.deepEqual(JSON.parse(f.requests[2].body), { limit: 1, warehouse_ids: [f.base.binding.warehouseId] });
  const saved = await authorizeProduction(f), dRef = saved.result.softwareJobRef;
  const continuation = await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: dRef.jobId, expectedRevision: saved.candidate.dataRevision });
  assert.equal(continuation.status, 'account_evidence_gaps'); assert.equal(f.requests.length, 3);
  const document = await f.repository.readSnapshot(), sku = document.candidates[0].lifecycleV11.skuPackage;
  const dJob = document.runtime.softwareJobs.find(job => job.jobId === dRef.jobId);
  assert.equal(dJob.status, 'queued'); assert.equal(dJob.attempt, 0); assert.equal(dJob.externalRequestState, 'not_sent');
  const record = document.runtime.ozonDEPreflightEvidence[sku.productionAuthorization.authorizationId];
  assert.deepEqual(await f.reader(record.scope), record);
  assert.equal(record.inspection.connections.api.status, 'connected');
  assert.equal(record.inspection.permissionStatus, 'verified');
  assert.equal(record.inspection.storeIdentityStatus, 'matched'); assert.equal(record.inspection.priceFieldCurrency, 'CNY');
  assert.equal(record.inspection.connections.sellerBackend.status, 'unknown'); assert.equal(record.protocols.productImport, null);
  assert.equal(record.schemaVersion, 'ozon-de-preflight-evidence-v3');
  assert.deepEqual(record.protocols,{productImport:null,inventoryWrite:null,independentReadback:null});
  assert.equal(record.inspection.risks.some(risk => risk.code === 'account_seller_backend_not_checked'), false);
  const preparation = f.services.preparation({ candidate: document.candidates[0], document });
  assert.equal(preparation.runtime[0].isCurrent, true, 'pre-PA receipt remains visible after the production decision');
  assert.equal(preparation.runtime[0].canContinue, false);
  const before = await f.repository.readSnapshot();
  await f.source.publish({ scope: record.scope, jobId: read.jobId });
  assert.deepEqual(await f.repository.readSnapshot(), before, 'same source publication is idempotent');
  assert.equal(Object.hasOwn(sku, 'dAssetTransport'), false); assert.equal(Object.hasOwn(sku, 'dSoftwareExecution'), false);
});

test('batch E reuses the completed account receipt after write verification expires and rejects a damaged read authorization', async () => {
  const f=await fixture(),catalog=await loadOzonDEProtocolCatalog(),connected=f.connectCatalog(catalog);
  const account=await connected.services.authorizeAndRun({actor:f.base.owner.args.actor,input:f.input});
  assert.equal(account.status,'completed');
  const saved=await authorizeProduction(f),pa=saved.candidate.lifecycleV11.skuPackage.productionAuthorization;
  await connected.services.continueProduction({candidateId:f.input.candidateId,
    jobId:saved.result.softwareJobRef.jobId,expectedRevision:saved.candidate.dataRevision});
  const document=await f.repository.readSnapshot(),candidate=document.candidates[0];
  const record=document.runtime.ozonDEPreflightEvidence[pa.authorizationId];
  assert.equal(record.schemaVersion,'ozon-de-preflight-evidence-v4');
  assert.equal(Object.hasOwn(candidate.lifecycleV11.skuPackage,'merchantSku'),false);
  assert.ok(pa.lockedScope.merchantSku);
  const binding=structuredClone(f.configuration.productionBindings[0]);
  binding.verification.expiresAt=new Date(Date.parse(f.base.owner.formal.at)-1).toISOString();
  const expiredSource=createOzonAccountReadEvidenceSource({repository:f.repository,
    loadCurrentReadBinding:createOzonAccountReadBindingResolver({...f.configuration,productionBindings:[binding]}),
    protocolCatalog:catalog});
  const expiredReader=createRepositoryBackedOzonDEPreflightEvidenceReader({repository:f.repository,
    verifySourceReceipt:expiredSource.verifySourceReceipt});
  const expiredProvider=createOzonDEPreflightProvider({readEvidence:expiredReader,
    serverClock:()=>f.base.owner.formal.at});
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic:account-e',status:'imported_awaiting_inventory',
    members:[{candidateId:candidate.id,skuPackageId:pa.lockedScope.skuPackageId,
      offerId:pa.lockedScope.merchantSku,authorizationId:pa.authorizationId,
      authorizationFingerprint:fingerprintCanonicalRecord(pa),resultRevision:candidate.dataRevision}]};
  batch.postImportScope={eReadbackOfferIds:[batch.members[0].offerId]};
  const input={candidate,productionBinding:binding,batch,offerId:batch.members[0].offerId};
  const before=f.requests.length;
  const ready=await expiredProvider.loadBatchEReadEvidence(input);
  assert.equal(ready.capabilities.independentReadback.status,'verified');
  assert.equal(f.requests.length,before,'saved receipt check must not issue another account request');
  const forgedBatch=structuredClone(batch);
  forgedBatch.members[0].offerId='UNCONFIRMED-OFFER';
  forgedBatch.postImportScope.eReadbackOfferIds=['UNCONFIRMED-OFFER'];
  await assert.rejects(expiredProvider.loadBatchEReadEvidence({...input,batch:forgedBatch,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(f.requests.length,before,'a substituted offer must stop before any account read');
  await f.repository.transact(state=>{
    const permission=state.runtime.softwareJobAuthorizationRecords.find(value=>value.authorizationId===record.provenance.readAuthorizationRef);
    permission.useCount=2;
    return {changed:true,document:state,result:null};
  });
  await assert.rejects(expiredProvider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(f.requests.length,before);
});

test('saved v4 account receipt and separate public limit jointly prepare a batch without altering the receipt',async()=>{
  const f=await fixture(),catalog=await loadOzonDEProtocolCatalog(),connected=f.connectCatalog(catalog);
  f.input.expiresAt='2026-10-15T00:00:00.000Z';
  const account=await connected.services.authorizeAndRun({actor:f.base.owner.args.actor,input:f.input});
  assert.equal(account.status,'completed');
  const saved=await authorizeProduction(f),pa=saved.candidate.lifecycleV11.skuPackage.productionAuthorization;
  await connected.services.continueProduction({candidateId:f.input.candidateId,
    jobId:saved.result.softwareJobRef.jobId,expectedRevision:saved.candidate.dataRevision});
  const before=await f.repository.readSnapshot(),candidate=before.candidates[0];
  const record=before.runtime.ozonDEPreflightEvidence[pa.authorizationId];
  assert.equal(record.schemaVersion,'ozon-de-preflight-evidence-v4');
  const batch={batchId:'d-batch:synthetic:account-limit',status:'authorized',
    members:[{candidateId:candidate.id,skuPackageId:pa.lockedScope.skuPackageId,
      authorizationId:pa.authorizationId,authorizationFingerprint:fingerprintCanonicalRecord(pa),
      resultRevision:candidate.dataRevision}]};
  const limit=await loadOzonProductImportBatchLimitEvidence();
  const provider=createOzonDEPreflightProvider({readEvidence:connected.reader,
    serverClock:()=> '2026-09-28T00:41:00.000Z',
    loadBatchLimitEvidence:async()=>limit});
  const input={candidate,productionBinding:f.configuration.productionBindings[0],batch};
  const prepared=await provider.loadBatchMemberEvidence(input);
  assert.equal(prepared.capabilities.productImport.status,'verified');
  assert.equal(prepared.capabilities.productImport.maxItemsPerRequest,100);
  assert.equal(prepared.capabilities.productImport.limitEvidenceRef,limit.evidenceRef);
  assert.notEqual(prepared.capabilities.productImport.limitEvidenceRef,
    prepared.capabilities.productImport.evidenceRef);
  const observer=createOzonDEPreflightProvider({readEvidence:connected.reader,
    serverClock:()=> '2026-09-28T00:41:00.000Z',
    loadBatchLimitEvidence:async()=>{throw new Error('LIMIT_SOURCE_REMOVED');}});
  const historical=await observer.loadBatchMemberEvidence({...input,purpose:'import_observation'});
  assert.equal(historical.capabilities.productImport.status,'verified');
  assert.equal(historical.capabilities.productImport.maxItemsPerRequest,null);
  assert.deepEqual(await f.repository.readSnapshot(),before,'limit projection cannot rewrite v4 account evidence');
  assert.equal(f.requests.length,3,'only the originally authorized account reads occurred');
  const denied=await fixture();
  denied.input.expiresAt='2026-10-15T00:00:00.000Z';
  denied.responses['/v1/roles'].roles[0].methods=denied.responses['/v1/roles'].roles[0].methods
    .filter(method=>method!=='/v3/product/import');
  const deniedConnected=denied.connectCatalog(catalog);
  assert.equal((await deniedConnected.services.authorizeAndRun({actor:denied.base.owner.args.actor,
    input:denied.input})).status,'completed');
  const deniedSaved=await authorizeProduction(denied),deniedPa=deniedSaved.candidate.lifecycleV11.skuPackage.productionAuthorization;
  await deniedConnected.services.continueProduction({candidateId:denied.input.candidateId,
    jobId:deniedSaved.result.softwareJobRef.jobId,expectedRevision:deniedSaved.candidate.dataRevision});
  const deniedDocument=await denied.repository.readSnapshot(),deniedCandidate=deniedDocument.candidates[0];
  const deniedBatch={batchId:'d-batch:synthetic:denied-import',status:'authorized',members:[{
    candidateId:deniedCandidate.id,skuPackageId:deniedPa.lockedScope.skuPackageId,
    authorizationId:deniedPa.authorizationId,authorizationFingerprint:fingerprintCanonicalRecord(deniedPa),
    resultRevision:deniedCandidate.dataRevision}]};
  const deniedProvider=createOzonDEPreflightProvider({readEvidence:deniedConnected.reader,
    serverClock:()=> '2026-09-28T00:41:00.000Z',loadBatchLimitEvidence:async()=>limit});
  const deniedPrepared=await deniedProvider.loadBatchMemberEvidence({candidate:deniedCandidate,
    productionBinding:denied.configuration.productionBindings[0],batch:deniedBatch});
  assert.equal(deniedPrepared.capabilities.productImport.status,'denied');
  assert.equal(deniedPrepared.capabilities.status,'not_ready');
  assert.equal(denied.requests.length,3);
});

// Reads the account once through the real transport and returns the completed receipt plus the composed evidence.
async function composedEvidence(f) {
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  assert.equal(read.status, 'completed');
  const saved = await authorizeProduction(f), authorization = saved.candidate.lifecycleV11.skuPackage.productionAuthorization;
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId,
    expectedRevision: saved.candidate.dataRevision });
  const document = await f.repository.readSnapshot();
  const record = document.runtime.ozonDEPreflightEvidence[authorization.authorizationId];
  return { read, authorization, document, record, receipt: document.runtime.ozonAccountReadReceipts[read.jobId] };
}

test('saved view names actual protocol gaps and reuses a current account receipt without requiring a backend login', async () => {
  const f = await fixture(), { document, record } = await composedEvidence(f);
  assert.equal(record.inspection.connections.sellerBackend.status, 'unknown');
  const view = { canContinueSaved: true, continueJobId: 'job:synthetic:queued', d: { status: 'queued', canContinueSaved: true, blockers: [] } };
  const before = structuredClone(document), requestCount = f.requests.length, secretReads = f.secretReads;
  const gated = f.services.gateSavedView({ candidate: document.candidates[0], document, view });
  assert.equal(gated.canContinueSaved, false); assert.equal(gated.continueJobId, null);
  assert.equal(gated.d.canContinueSaved, false);
  assert.equal(gated.d.blockers.length, 1);
  assert.equal(gated.d.blockers[0].code, 'OZON_ACCOUNT_EVIDENCE_REQUIRED');
  assert.equal(gated.d.blockers[0].message,
    '账户核验回执仍有效，可继续复用；当前缺项：商品导入与任务查询规则、库存写入规则与写前条件、独立回读规则、图片提交规则与权限。原生产任务保持等待，无需重复账户核验。');
  assert.doesNotMatch(gated.d.blockers[0].message, /后台连接|网页登录|店铺身份|价格币种/);
  assert.deepEqual(document, before); assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.equal(f.requests.length, requestCount); assert.equal(f.secretReads, secretReads);
  assert.equal(view.canContinueSaved, true); assert.deepEqual(view.d.blockers, []);
});

test('saved view reports a real account expiry instead of presenting the completed read as reusable', async () => {
  const f = await fixture(), { document, record } = await composedEvidence(f);
  f.advanceClock(Date.parse(record.expiresAt) - Date.parse(f.base.owner.formal.at));
  const before = structuredClone(document), requests = f.requests.length, secretReads = f.secretReads;
  const gated = f.services.gateSavedView({ candidate: document.candidates[0], document,
    view: { canContinueSaved: true, d: { status: 'queued', blockers: [] } } });
  assert.equal(gated.canContinueSaved, false);
  assert.match(gated.d.blockers[0].message, /账户核验回执已超过有效期或尚未生效/);
  assert.match(gated.d.blockers[0].message, /查看有效期并补充本次所需授权/);
  assert.doesNotMatch(gated.d.blockers[0].message, /仍有效|无需重复账户核验|后台连接|网页登录/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.equal(f.requests.length, requests); assert.equal(f.secretReads, secretReads);
});

test('saved view includes the currency gap only when the observed account currency does not satisfy the authorization', async () => {
  const f = await fixture(); f.responses['/v1/seller/info'].company.currency = 'USD';
  const { document } = await composedEvidence(f);
  const gated = f.services.gateSavedView({ candidate: document.candidates[0], document,
    view: { canContinueSaved: true, d: { status: 'queued', blockers: [] } } });
  assert.equal(gated.canContinueSaved, false);
  assert.match(gated.d.blockers[0].message, /后台价格币种与授权币种一致性/);
  assert.doesNotMatch(gated.d.blockers[0].message, /后台连接|网页登录/);
  assert.equal(f.requests.length, 3);
});

test('the price field currency is the company currency actually read back, on the seller_info step receipt', async () => {
  const f = await fixture(), { record, receipt } = await composedEvidence(f);
  assert.equal(receipt.steps[1].method, 'seller_info');
  assert.equal(receipt.steps[1].result.facts.companyCurrency, 'CNY');
  assert.equal(record.inspection.priceFieldCurrency, 'CNY', 'the currency is wired to the fact, not hard-coded');
  assert.equal(record.inspection.priceCurrencyEvidenceRef, `${receipt.receiptId}:seller-info`);
  const codes = record.inspection.risks.map(risk => risk.code);
  assert.equal(codes.includes('account_backend_price_currency_unverified'), false, 'the withdrawn risk is gone');
  assert.ok(codes.includes('account_price_currency_from_company_currency'), 'the evidence says where this belief comes from');
  assert.equal(codes.includes('account_price_currency_unsupported'), false);
  assert.equal(f.requests.length, 3);
});

test('a company currency outside the writable set stays unknown and is recorded as a risk, never forced through', async () => {
  const f = await fixture();
  f.responses['/v1/seller/info'] = { company: { currency: 'KZT' } };
  const { record, receipt } = await composedEvidence(f);
  assert.equal(receipt.steps[1].result.facts.companyCurrency, 'KZT');
  assert.equal(record.inspection.priceFieldCurrency, 'unknown');
  const risk = record.inspection.risks.find(value => value.code === 'account_price_currency_unsupported');
  assert.ok(risk); assert.ok(risk.message.includes('KZT'));
  assert.equal((await f.source.verifySourceReceipt(record, record.scope)).status, 'verified');
});

test('platform writable fields follow the granted roles: one missing method removes exactly that method\'s fields', async () => {
  const importFields = ['create_product', 'title', 'description', 'attributes', 'price', 'assets.finalUploads', 'publish_scope'];
  const full = await fixture(), complete = await composedEvidence(full);
  assert.deepEqual(complete.record.inspection.platformWritableFields, [...PRODUCTION_WRITE_FIELDS]);
  assert.deepEqual([...PRODUCTION_WRITE_FIELDS].sort(), [...importFields, 'stock'].sort());

  const noStock = await fixture();
  noStock.responses['/v1/roles'].roles[0].methods = ['/v3/product/import', OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_READBACK_ENDPOINTS)];
  const withoutStock = await composedEvidence(noStock);
  assert.deepEqual(withoutStock.record.inspection.platformWritableFields, importFields);

  const noImport = await fixture();
  noImport.responses['/v1/roles'].roles[0].methods = ['/v2/products/stocks', OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_READBACK_ENDPOINTS)];
  const withoutImport = await composedEvidence(noImport);
  assert.deepEqual(withoutImport.record.inspection.platformWritableFields, ['stock']);

  const none = await fixture();
  none.responses['/v1/roles'].roles[0].methods = [OZON_PRODUCT_IMPORT_INFO_ENDPOINT];
  assert.deepEqual((await composedEvidence(none)).record.inspection.platformWritableFields, []);
});

test('the scoped warehouse read back is checked: a non-realFBS, paused or different warehouse each lands in risks', async () => {
  const f = await fixture();
  f.responses['/v2/warehouse/list'].warehouses[0].is_rfbs = false;
  f.responses['/v2/warehouse/list'].warehouses[0].pause_at = '2026-10-01T00:00:00.000Z';
  const { record, receipt, authorization } = await composedEvidence(f);
  const facts = receipt.steps[2].result.facts;
  assert.equal(receipt.steps[2].method, 'warehouse_list');
  assert.equal(facts.warehouses[0].warehouseId, record.scope.warehouseId, 'the receipt contract already pins the scoped id');
  const codes = record.inspection.risks.map(risk => risk.code);
  assert.ok(codes.includes('account_warehouse_not_rfbs'));
  assert.ok(codes.includes('account_warehouse_paused'));
  assert.equal(codes.includes('account_warehouse_scope_mismatch'), false);

  // The id check is defensive: a completed receipt can never carry another warehouse, so drive the composer directly.
  const clean = await fixture(), source = await composedEvidence(clean);
  assert.equal(source.record.inspection.risks.some(risk => risk.code.startsWith('account_warehouse_')), false);
  const strayed = structuredClone(source.receipt);
  strayed.steps[2].result.facts.warehouses[0].warehouseId = '999999';
  const strayedRecord = composeOzonAccountPreflightEvidence({ scope: source.record.scope, receipt: strayed, authorization: source.authorization });
  assert.ok(strayedRecord.inspection.risks.some(risk => risk.code === 'account_warehouse_scope_mismatch'));
  const emptied = structuredClone(source.receipt);
  emptied.steps[2].result.facts.warehouses = [];
  assert.ok(composeOzonAccountPreflightEvidence({ scope: source.record.scope, receipt: emptied, authorization: source.authorization })
    .inspection.risks.some(risk => risk.code === 'account_warehouse_scope_mismatch'));
  assert.ok(authorization);
});

test('the store identity is inferred from the warehouse, never from a store number Ozon does not publish', async () => {
  const f = await fixture(), { record, receipt } = await composedEvidence(f);
  // Fact (2), observed: this key read the scoped warehouse back on step 3.
  assert.equal(receipt.steps[2].method, 'warehouse_list');
  assert.equal(receipt.steps[2].result.facts.warehouses[0].warehouseId, record.scope.warehouseId);
  assert.equal(record.inspection.storeIdentityStatus, 'matched');
  assert.equal(record.inspection.storeIdentityVia, 'scoped_warehouse');
  assert.equal(record.inspection.storeIdentityEvidenceRef, `${receipt.receiptId}:warehouse-list:${record.scope.warehouseId}`,
    'the conclusion points at the warehouse step, never at a store lookup that does not exist');
  // Fact (1), the owner's own seller-backend session: the record does not copy it, it pins the one binding row that
  // carries it. scope.bindingId + configurationVersion + warehouseId resolve to exactly that row.
  const binding = f.configuration.productionBindings.filter(value => value.bindingId === record.scope.bindingId &&
    value.configurationVersion === record.scope.configurationVersion && value.warehouseId === record.scope.warehouseId);
  assert.equal(binding.length, 1, 'the scope resolves to exactly one production binding');
  assert.equal(binding[0].verification.evidenceRef, f.base.binding.verification.evidenceRef,
    'and that row is where the owner-verified warehouse-to-store evidence lives');
  // seller_info still returns nothing to observe, and the record never reads as if it had.
  assert.deepEqual(Object.keys(receipt.steps[1].result.facts), ['companyCurrency'],
    'seller_info keeps only the company currency; no store or seller identifier exists to promote');
  assert.equal(record.inspection.observedStoreRef, null);
  const codes = record.inspection.risks.map(risk => risk.code);
  assert.ok(codes.includes('account_store_identity_not_provided'), 'the record still says no store number was returned');
  assert.ok(codes.includes('account_store_identity_from_scoped_warehouse'), 'and says where the identity actually came from');
});

test('the warehouse check decides the identity three ways, and observedStoreRef stays null in every one', async () => {
  const f = await fixture(), source = await composedEvidence(f);
  // A completed receipt can only carry the scoped warehouse, so the other two verdicts are driven directly.
  const compose = receipt => composeOzonAccountPreflightEvidence({ scope: source.record.scope, receipt, authorization: source.authorization });
  assert.equal(source.record.inspection.storeIdentityStatus, 'matched');

  const strayed = structuredClone(source.receipt);
  strayed.steps[2].result.facts.warehouses[0].warehouseId = '999999';
  const mismatched = compose(strayed);
  assert.equal(mismatched.inspection.storeIdentityStatus, 'mismatched');
  assert.equal(mismatched.inspection.storeIdentityVia, 'scoped_warehouse');
  assert.equal(mismatched.inspection.risks.some(risk => risk.code === 'account_store_identity_from_scoped_warehouse'), false,
    'a refuted warehouse never claims the store');

  const absent = structuredClone(source.receipt);
  absent.steps[2].result.facts = { hasNext: null, warehouses: null };
  const unverified = compose(absent);
  assert.equal(unverified.inspection.storeIdentityStatus, 'unverified');
  assert.equal(unverified.inspection.storeIdentityVia, 'none');
  assert.equal(unverified.inspection.storeIdentityEvidenceRef, `${source.receipt.receiptId}:store-identity-not-provided`);
  assert.ok(unverified.inspection.risks.some(risk => risk.code === 'account_warehouse_facts_unavailable'));

  // Pinned on purpose: Ozon publishes no store number, so nobody may ever "complete" this field later.
  for (const value of [source.record, mismatched, unverified]) {
    assert.equal(value.inspection.observedStoreRef, null);
    assert.ok(value.inspection.risks.some(risk => risk.code === 'account_store_identity_not_provided'));
  }

  // Same authorization, same receipt, same schema version, three different contents: three different ids.
  // An id that only covered those coordinates would collide here, and a changed composer would then leave old
  // records unverifiable (ACCOUNT_SOURCE_CONTENT_MISMATCH) and unrepublishable (EVIDENCE_VERSION_CONFLICT).
  const ids = [source.record, mismatched, unverified].map(value => value.evidenceId);
  assert.equal(new Set(ids).size, 3, 'the evidence id covers the content, not only the receipt coordinates');
  assert.deepEqual(compose(structuredClone(source.receipt)).evidenceId, source.record.evidenceId, 'and is still stable for one content');
});

test('the warehouse path fills the preflight store identity cell and completes the technical status', async () => {
  const f = await fixture(), { record, authorization, document } = await composedEvidence(f);
  const candidate = document.candidates.find(value => value.id === f.input.candidateId);
  const at = f.base.owner.formal.at;
  const plan = createProductionPlan({ productionAuthorization: authorization, candidateId: candidate.id,
    candidateRevision: candidate.dataRevision, skuPackage: candidate.lifecycleV11.skuPackage, createdAt: at });
  const run = inspection => runPlatformWritePreflight({ productionPlan: plan, checkedAt: at, inspectPlatform: async () => inspection });

  const preflight = await run(structuredClone(record.inspection));
  assert.equal(preflight.storeIdentity.status, 'matched');
  assert.equal(preflight.storeIdentity.observedStoreRef, null, 'matched without ever observing a store ref');
  assert.equal(preflight.storeIdentity.verifiedVia, 'scoped_warehouse');
  assert.equal(preflight.storeIdentity.evidenceRef, record.inspection.storeIdentityEvidenceRef);
  assert.equal(preflight.technicalStatus, 'completed');
  const codes = preflight.risks.map(risk => risk.code);
  assert.equal(codes.includes('store_identity_not_verified'), false);
  assert.ok(codes.includes('account_store_identity_not_provided'), 'the preflight still carries that no store number exists');
  assert.ok(codes.includes('account_store_identity_from_scoped_warehouse'), 'and that the identity is warehouse-inferred');

  // The same reading without the warehouse verdict is exactly where this field used to sit.
  const blind = { ...structuredClone(record.inspection), storeIdentityStatus: 'unverified', storeIdentityVia: 'none' };
  const before = await run(blind);
  assert.equal(before.storeIdentity.status, 'unverified');
  assert.equal(before.technicalStatus, 'data_unavailable');
});

test('versioned source keeps old method evidence unchanged and never expands it to the exact warehouse method', async () => {
  const f = await fixture();
  f.responses['/v1/roles'].roles[0].methods = ['/v3/product/import', '/v2/products/stocks',
    OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_LEGACY_READBACK_ENDPOINTS)];
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const saved = await authorizeProduction(f), authorization = saved.candidate.lifecycleV11.skuPackage.productionAuthorization;
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId,
    expectedRevision: saved.candidate.dataRevision });
  const current = await f.repository.readSnapshot(), record = current.runtime.ozonDEPreflightEvidence[authorization.authorizationId];
  assert.equal(record.inspection.permissionStatus, 'denied');
  const legacy = composeOzonAccountPreflightEvidence({ scope: record.scope,
    receipt: current.runtime.ozonAccountReadReceipts[read.jobId], authorization, schemaVersion: 'ozon-de-preflight-evidence-v1' });
  assert.equal(legacy.inspection.permissionStatus, 'verified');
  assert.ok(legacy.inspection.risks.some(risk => risk.code === 'account_seller_backend_not_checked'));
  assert.notEqual(legacy.evidenceId, record.evidenceId);
  assert.equal((await f.source.verifySourceReceipt(legacy, legacy.scope)).status, 'verified');
  const versionTwo=composeOzonAccountPreflightEvidence({scope:record.scope,receipt:current.runtime.ozonAccountReadReceipts[read.jobId],authorization,schemaVersion:'ozon-de-preflight-evidence-v2'});
  assert.equal(versionTwo.inspection.permissionStatus,'denied');assert.notEqual(versionTwo.evidenceId,record.evidenceId);
  assert.equal((await f.source.verifySourceReceipt(versionTwo,versionTwo.scope)).status,'verified');
  const promoted=structuredClone(versionTwo);promoted.schemaVersion='ozon-de-preflight-evidence-v3';
  await assert.rejects(()=>f.source.verifySourceReceipt(promoted,promoted.scope),/ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  const relabelled = structuredClone(legacy); relabelled.schemaVersion = 'ozon-de-preflight-evidence-v2';
  await assert.rejects(() => f.source.verifySourceReceipt(relabelled, relabelled.scope), /ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  await f.repository.transact(document => {
    document.runtime.ozonDEPreflightEvidence[authorization.authorizationId] = structuredClone(legacy);
    document.runtime.ozonDEPreflightEvidenceVersions[authorization.authorizationId] = [structuredClone(legacy)];
    return { changed: true, document };
  });
  const before = await f.repository.readSnapshot(), counts = { requests: f.requests.length, secrets: f.secretReads };
  assert.equal((await f.source.publish({ scope: record.scope, jobId: read.jobId })).status, 'published');
  const after = await f.repository.readSnapshot();
  assert.deepEqual(after.runtime.ozonDEPreflightEvidenceVersions[authorization.authorizationId], [legacy, record]);
  for (const field of ['ozonAccountReadReceipts', 'softwareJobs', 'softwareJobAuthorizationRecords', 'softwareJobCredentialBindings']) {
    assert.deepEqual(after.runtime[field], before.runtime[field]);
  }
  assert.equal(after.runtime.ozonDEPreflightEvidence[authorization.authorizationId].inspection.permissionStatus, 'denied');
  assert.equal(f.requests.length, counts.requests); assert.equal(f.secretReads, counts.secrets);
  assert.equal(f.requests.length, 3);
});

test('a later genuine failed source supersedes a saved success at the verifier and publication boundaries', async () => {
  const f = await fixture(), read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const saved = await authorizeProduction(f);
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  const original = await f.repository.readSnapshot(), record = original.runtime.ozonDEPreflightEvidence[saved.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId];
  // A second independently produced historical receipt models an older producer's saved attempt.
  const later = await fixture({ clockOffsetMs: 1000 }); later.responses['/v1/roles'] = {};
  const failed = await later.services.authorizeAndRun({ actor: later.base.owner.args.actor,
    input: { ...later.input, idempotencyKey: 'owner-read:later-history' } });
  assert.equal(failed.status, 'failed');
  const laterDocument = await later.repository.readSnapshot();
  await f.repository.transact(document => {
    for (const collection of ['softwareJobs', 'softwareJobAuthorizationRecords', 'softwareJobCredentialBindings']) {
      document.runtime[collection].push(...laterDocument.runtime[collection]);
    }
    Object.assign(document.runtime.ozonAccountReadReceipts, laterDocument.runtime.ozonAccountReadReceipts);
    return { changed: true, document };
  });
  await assert.rejects(() => f.source.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_SUPERSEDED/);
  await assert.rejects(() => f.source.publish({ scope: record.scope, jobId: read.jobId }), /ACCOUNT_SOURCE_SUPERSEDED/);
  assert.deepEqual((await f.repository.readSnapshot()).runtime.ozonDEPreflightEvidence, original.runtime.ozonDEPreflightEvidence);
  assert.equal(f.requests.length, 3); assert.equal(later.requests.length, 1);
});

test('source reconstruction validates author identity, credential validity and every D/E method permission', async () => {
  const f = await fixture(); f.responses['/v1/roles'].roles[0].methods = ['/v3/product/import', '/v2/products/stocks'];
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input }), saved = await authorizeProduction(f);
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  const original = await f.repository.readSnapshot(), record = original.runtime.ozonDEPreflightEvidence[saved.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId];
  assert.equal(record.inspection.permissionStatus, 'denied');
  assert.ok(record.inspection.risks.some(value => value.code === 'account_method_permissions_incomplete'));
  for (const change of ['owner', 'future_binding', 'expired_credential']) {
    await f.repository.transact(() => {
      const document = structuredClone(original), runtime = document.runtime;
      if (change === 'owner') runtime.softwareJobAuthorizationRecords.find(value => value.consumedByJobId === read.jobId).authorizedByUserId = 'owner:other';
      else {
        const credential = runtime.softwareJobCredentialBindings.find(value => value.sideEffectScope === 'ozon_account_read');
        if (change === 'future_binding') credential.boundAt = '2026-08-31T23:00:00.000Z';
        else credential.expiresAt = credential.boundAt;
      }
      return { changed: true, document };
    });
    await assert.rejects(() => f.source.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_(AUTHORIZATION_INVALID|CREDENTIAL_INVALID|INVALID)/);
  }
  assert.equal(f.requests.length, 3);
});

test('source verifier rejects changed factual content, missing consumed authorization, and changed Client ID under an unchanged alias', async () => {
  const f = await fixture(), read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const saved = await authorizeProduction(f);
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  const original = await f.repository.readSnapshot();
  const record = original.runtime.ozonDEPreflightEvidence[saved.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId];
  const tampered = structuredClone(record); tampered.inspection.platformWritableFields = ['title'];
  await assert.rejects(() => f.source.verifySourceReceipt(tampered, record.scope), /ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  const changedConfig = createSelectionReviewRuntimeConfiguration({ env: { ...f.env,
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify([{ credentialAlias: f.base.binding.credentialAlias,
      clientId: '700124', keychainService: 'synthetic-account-source', keychainAccount: 'synthetic-account' }]) },
    appDir: '/tmp/synthetic-account-integration', argv: [] });
  const other = createOzonAccountReadEvidenceSource({ repository: f.repository, loadCurrentReadBinding: createOzonAccountReadBindingResolver(changedConfig) });
  await assert.rejects(() => other.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_CONFIGURATION_CHANGED/);
  await f.repository.transact(document => { document.runtime.softwareJobAuthorizationRecords = document.runtime.softwareJobAuthorizationRecords
    .filter(value => value.consumedByJobId !== read.jobId); return { changed: true, document }; });
  await assert.rejects(() => f.source.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_AUTHORIZATION_INVALID/);
  assert.equal(f.requests.length, 3);
});

test('new PA waits before D claim without reading credentials when no account permission exists', async () => {
  const f = await fixture(), saved = await authorizeProduction(f);
  const result = await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  assert.equal(result.status, 'awaiting_account_read'); assert.equal(f.secretReads, 0); assert.deepEqual(f.requests, []);
  const document = await f.repository.readSnapshot(), job = document.runtime.softwareJobs.find(value => value.jobId === saved.result.softwareJobRef.jobId);
  assert.equal(job.status, 'queued'); assert.equal(job.attempt, 0); assert.equal(job.externalRequestState, 'not_sent');
});

test('account routing requires an explicit binding and detects Client ID or configuration drift without inventing platform verification', async () => {
  const f = await fixture(), document = await f.repository.readSnapshot(), resolver = createOzonAccountReadBindingResolver(f.configuration);
  assert.equal(resolver({ document, candidateId: f.input.candidateId, skuPackageId: f.input.skuPackageId }), null);
  const binding = resolver({ document, ...f.input });
  assert.equal(binding.scopeRef, f.input.scopeRef); assert.equal(Object.hasOwn(binding, 'verification'), false);
  const changed = { ...f.configuration, ozonDECredentialBindings: [{ ...f.configuration.ozonDECredentialBindings[0], clientId: '700124' }] };
  assert.notEqual(accountReadBindingForProduction(changed, f.base.binding).scopeRef, binding.scopeRef);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({ env: { ...f.env,
    SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: JSON.stringify([{ ...f.configuration.ozonAccountReadServiceBindings[0], workerId: f.base.service.workerId }]) },
    appDir: '/tmp/synthetic-account-integration', argv: [] }), /Worker/);
  assert.equal(f.secretReads, 0);
});

test('queued read view checks current persisted permission without reading credentials or consuming authorization again', async () => {
  const f = await fixture(), serverClock = () => f.base.owner.formal.at;
  const configured = f.configuration.ozonAccountReadServiceBindings[0];
  const runtime = createOzonAccountReadRuntime({ repository: f.repository, serverClock,
    workerRegistry: createLocalDevelopmentWorkerRegistry({ clock: serverClock }),
    worker: { workerId: configured.workerId, version: configured.workerVersion, leaseDurationMs: configured.leaseDurationMs },
    loadCurrentReadBinding: createOzonAccountReadBindingResolver(f.configuration),
    requestJson: async () => { throw new Error('queued view made a request'); } });
  await runtime.authorizeAndEnqueue({ actor: f.base.owner.args.actor, input: f.input });
  let document = await f.repository.readSnapshot();
  assert.equal(f.services.preparation({ candidate: document.candidates[0], document }).runtime[0].canContinue, true);
  await f.repository.transact(current => { current.runtime.softwareJobAuthorizationRecords = []; return { changed: true, document: current }; });
  document = await f.repository.readSnapshot();
  const view = f.services.preparation({ candidate: document.candidates[0], document }).runtime[0];
  assert.equal(view.canContinue, false); assert.equal(view.admissionBlocker, 'SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED');
  assert.deepEqual(await f.repository.readSnapshot(), document); assert.equal(f.secretReads, 0); assert.equal(f.requests.length, 0);
});

test('historical v2 SKU preparation reads absent runtime without changing the document or accessing providers', async () => {
  const f = await fixture(), document = await f.repository.readSnapshot();
  delete document.runtime;
  assert.ok(document.candidates[0].lifecycleV11.skuPackage);
  const before = JSON.stringify(document);
  Object.freeze(document);
  const view = f.services.preparation({ candidate: document.candidates[0], document });
  assert.deepEqual(view.runtime, []);
  assert.equal(view.options.length, 1);
  assert.equal(JSON.stringify(document), before);
  assert.equal(Object.hasOwn(document, 'runtime'), false);
  assert.equal(f.secretReads, 0);
  assert.deepEqual(f.requests, []);
});

test('account preparation rejects malformed runtime collections instead of treating them as absent history', async () => {
  const f = await fixture(), original = await f.repository.readSnapshot();
  for (const runtime of [null, [], false, 0, 'invalid', { softwareJobs: null }, { softwareJobs: {} },
    { ozonAccountReadReceipts: null }, { ozonAccountReadReceipts: [] }, { ozonAccountReadReceipts: false }]) {
    const document = { ...original, runtime }, before = JSON.stringify(document);
    assert.throws(() => f.services.preparation({ candidate: document.candidates[0], document }),
      { code: 'OZON_ACCOUNT_READ_REPOSITORY_INVALID' });
    assert.equal(JSON.stringify(document), before);
  }
  assert.equal(f.secretReads, 0);
  assert.deepEqual(f.requests, []);
});

test('saved account receipts remain visible and explicit corrupt receipt entries fail read-only projection', async () => {
  const f = await fixture();
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const document = await f.repository.readSnapshot(), before = JSON.stringify(document);
  const view = f.services.preparation({ candidate: document.candidates[0], document });
  assert.equal(view.runtime[0].jobId, read.jobId);
  assert.equal(view.runtime[0].status, 'completed');
  assert.equal(view.runtime[0].requestsSent, 3);
  assert.deepEqual(view.runtime[0].observedMethods, ['roles', 'seller_info', 'warehouse_list']);
  assert.equal(view.runtime[0].companyCurrency, 'CNY');
  assert.equal(JSON.stringify(document), before);
  for (const receipt of [null, false, 0, {}]) {
    const corrupt = structuredClone(document);
    corrupt.runtime.ozonAccountReadReceipts[read.jobId] = receipt;
    const saved = JSON.stringify(corrupt);
    assert.throws(() => f.services.preparation({ candidate: corrupt.candidates[0], document: corrupt }),
      error => error.name === 'OzonAccountReadError');
    assert.equal(JSON.stringify(corrupt), saved);
  }
  assert.equal(f.requests.length, 3);
  assert.equal(f.secretReads, 3);
});


test('v4 connects official call rules to the saved account receipt prospectively without account requests or business writes', async () => {
  const f = await fixture(), { document, record, read } = await composedEvidence(f);
  const connected = f.connectCatalog(await loadOzonDEProtocolCatalog());
  const input = { document, scope: record.scope, jobId: read.jobId };
  const next = connected.source.prospective(input);
  assert.equal(next.schemaVersion, 'ozon-de-preflight-evidence-v4');
  assert.equal(next.inspection.connections.sellerBackend.status, 'unknown');
  assert.equal(next.inspection.imagePermissionStatus, 'verified');
  assert.equal(next.protocols.productImport.status, 'verified');
  assert.equal(next.protocols.independentReadback.status, 'verified');
  assert.deepEqual(next.protocols.inventoryWrite.prerequisitePolicy.priceSent.acceptedValues, ['price_sent']);
  assert.equal(next.protocols.inventoryWrite.prerequisitePolicy.stockRequest.quantSize, 'not_applicable');
  assert.ok(next.inspection.risks.some(risk => risk.code === 'inventory_price_state_engineering_mapping'));
  assert.equal(Object.hasOwn(document.candidates[0].lifecycleV11.skuPackage, 'dAssetTransport'), false);
  const view = { canContinueSaved: true, d: { status: 'queued', canContinueSaved: true, blockers: [] } };
  assert.equal(connected.services.gateSavedView({ document, candidate: document.candidates[0], view }), view);
  assert.deepEqual(await f.repository.readSnapshot(), document, 'GET projection does not publish or change business data');
  assert.equal(f.requests.length, 3); assert.equal(f.secretReads, 3);
  assert.deepEqual(connected.source.verifySnapshot(document, record, record.scope), record, 'v3 history reconstructs unchanged');
  await connected.source.publish(input);
  const published = await f.repository.readSnapshot();
  assert.deepEqual(published.runtime.ozonDEPreflightEvidence[record.scope.authorizationId], next);
  assert.deepEqual(await connected.reader(record.scope), next);
  assert.deepEqual(published.candidates, document.candidates);
  assert.deepEqual(published.runtime.ozonDEPreflightEvidenceVersions[record.scope.authorizationId], [record, next]);
  assert.equal((await connected.source.publish(input)).status, 'unchanged');
  assert.deepEqual(await f.repository.readSnapshot(), published);
  assert.equal(f.requests.length, 3); assert.equal(f.secretReads, 3);
  await assert.rejects(() => f.source.verifySourceReceipt(next, next.scope), /PROTOCOL_CATALOG_UNAVAILABLE/);
  for (const mutate of [
    value => { value.protocols.inventoryWrite.prerequisitePolicy.priceSent.acceptedValues.push('imported'); },
    value => { value.protocols.productImport.evidenceRef = 'invented:source'; },
    value => { value.inspection.imagePermissionStatus = 'unknown'; },
    value => { value.provenance.officialContractRefs.pop(); },
    value => { value.inspection.connections.sellerBackend.status = 'connected'; }
  ]) {
    const forged = structuredClone(next); mutate(forged);
    assert.throws(() => connected.source.verifySnapshot(published, forged, next.scope), /ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  }
});

test('v4 prospective gate preserves current source, expiry, method permission and routing stops', async () => {
  const f = await fixture(), { document, record, read } = await composedEvidence(f);
  const connected = f.connectCatalog(await loadOzonDEProtocolCatalog());
  const view = { canContinueSaved: true, d: { status: 'queued', blockers: [] } };
  const tampered = structuredClone(document);
  tampered.runtime.ozonAccountReadReceipts[read.jobId].steps[0].result.facts.roles[0].methods = [];
  const invalid = connected.services.gateSavedView({ document: tampered, candidate: tampered.candidates[0], view });
  assert.equal(invalid.canContinueSaved, false);
  assert.match(invalid.d.blockers[0].message, /证据校验失败/);
  const changedScope = { ...record.scope, warehouseId: '999999' };
  assert.throws(() => connected.source.prospective({ document, scope: changedScope, jobId: read.jobId }), /SCOPE_MISMATCH/);
  f.advanceClock(Date.parse(record.expiresAt) - Date.parse(f.base.owner.formal.at));
  const expired = connected.services.gateSavedView({ document, candidate: document.candidates[0], view });
  assert.equal(expired.canContinueSaved, false);
  assert.match(expired.d.blockers[0].message, /超过有效期/);
  assert.deepEqual(await f.repository.readSnapshot(), document);
  assert.equal(f.requests.length, 3);
});


test('v4 official continuation cannot overwrite a conflicting persisted source to bypass the saved-view gate', async () => {
  const f = await fixture(), { record } = await composedEvidence(f);
  const connected = f.connectCatalog(await loadOzonDEProtocolCatalog());
  await f.repository.transact(document => {
    document.runtime.ozonDEPreflightEvidence[record.scope.authorizationId].inspection.priceFieldCurrency = 'RUB';
    return { changed: true, document, result: null };
  });
  const before = await f.repository.readSnapshot(), candidate = before.candidates[0];
  const job = before.runtime.softwareJobs.find(value => value.jobType === 'd_production_execution');
  await assert.rejects(() => connected.services.continueProduction({ candidateId: candidate.id, jobId: job.jobId,
    expectedRevision: candidate.dataRevision }), /ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.equal(f.requests.length, 3); assert.equal(f.secretReads, 3);
});


test('v4 account read at the original D job revision survives actual saved asset and import progress', async () => {
  const f = await fixture(), saved = await authorizeProduction(f);
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor,
    input: { ...f.input, expectedRevision: saved.candidate.dataRevision } });
  assert.equal(read.status, 'completed');
  const before = await f.repository.readSnapshot(), authorization = before.candidates[0].lifecycleV11.skuPackage.productionAuthorization;
  const old = before.runtime.ozonDEPreflightEvidence[authorization.authorizationId];
  assert.equal(before.runtime.ozonAccountReadReceipts[read.jobId].scope.sourceRevision, authorization.resultCandidateRevision);
  let uploads = 0; const calls = [];
  const connected = f.connectCatalog(await loadOzonDEProtocolCatalog(), {
    upload: async ({ finalUploads, beforePublicWrite }) => {
      uploads++;
      for (const { assetId, order, sha256 } of finalUploads) await beforePublicWrite({ assetId, order, sha256 });
      return { status: 'verified', mode: 'preapproved_stable_https', protocolVersion: 'aliyun-oss-final-assets-v1',
        evidenceRef: 'oss:synthetic:v4-regression', approvedHosts: ['assets.example.com'], resolvedAssets: finalUploads.map(asset => ({
          assetId: asset.assetId, sha256: asset.sha256, order: asset.order, role: asset.role,
          platformAcceptedUrl: `https://assets.example.com/saved/${asset.sha256}.jpg`, stable: true,
          authorizationStatus: 'approved', evidenceRef: `oss:synthetic:${asset.assetId}` })) };
    },
    requestJson: async ({ endpoint }) => {
      calls.push(endpoint);
      if (endpoint === '/v3/product/import') return { result: { task_id: 9876 } };
      if (endpoint === '/v1/product/import/info') return { result: { items: [{ offer_id: authorization.lockedScope.merchantSku,
        product_id: 910001, status: 'pending', errors: [] }] } };
      throw new Error(`unexpected synthetic call ${endpoint}`);
    }
  });
  await connected.services.continueProduction({ candidateId: saved.candidate.id, jobId: saved.result.softwareJobRef.jobId,
    expectedRevision: saved.candidate.dataRevision });
  const after = await f.repository.readSnapshot(), candidate = after.candidates[0];
  assert.equal(uploads, 1); assert.ok(candidate.dataRevision > authorization.resultCandidateRevision);
  assert.equal(candidate.lifecycleV11.skuPackage.dAssetTransport.status, 'verified');
  assert.deepEqual(calls, ['/v3/product/import']);
  assert.equal(candidate.lifecycleV11.skuPackage.dSoftwareExecution.status, 'waiting_platform');
  const next = after.runtime.ozonDEPreflightEvidence[authorization.authorizationId];
  assert.deepEqual(await connected.reader(next.scope), next);
  assert.deepEqual(connected.source.verifyHistoricalSnapshot(after, old, old.scope), old);
  const crossed = structuredClone(after);
  crossed.candidates[0].lifecycleV11.skuPackage.dHandoff.softwareJobRef.jobId = 'job:unrelated';
  assert.throws(() => connected.source.prospective({ document: crossed, scope: next.scope, jobId: read.jobId }), /ACCOUNT_SOURCE_INVALID/);
  assert.equal(f.requests.length, 3);
});

test('v4 publication accepts a later genuine receipt while verifying the older immutable record before replacement', async () => {
  const f = await fixture(), { record, read } = await composedEvidence(f), later = await fixture({ clockOffsetMs: 1000 });
  const newer = await later.services.authorizeAndRun({ actor: later.base.owner.args.actor,
    input: { ...later.input, idempotencyKey: 'owner-read:new-success' } });
  assert.equal(newer.status, 'completed');
  const laterDocument = await later.repository.readSnapshot();
  await f.repository.transact(document => {
    for (const collection of ['softwareJobs', 'softwareJobAuthorizationRecords', 'softwareJobCredentialBindings']) {
      document.runtime[collection].push(...laterDocument.runtime[collection]);
    }
    Object.assign(document.runtime.ozonAccountReadReceipts, laterDocument.runtime.ozonAccountReadReceipts);
    return { changed: true, document };
  });
  f.advanceClock(1000);
  const connected = f.connectCatalog(await loadOzonDEProtocolCatalog()), before = await f.repository.readSnapshot();
  assert.throws(() => connected.source.verifySnapshot(before, record, record.scope), /ACCOUNT_SOURCE_SUPERSEDED/);
  assert.deepEqual(connected.source.verifyHistoricalSnapshot(before, record, record.scope), record);
  await assert.rejects(() => connected.source.publish({ scope: record.scope, jobId: read.jobId }), /ACCOUNT_SOURCE_SUPERSEDED/);
  const view = { canContinueSaved: true, d: { status: 'queued', blockers: [] } };
  assert.equal(connected.services.gateSavedView({ document: before, candidate: before.candidates[0], view }), view);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.equal((await connected.source.publish({ scope: record.scope, jobId: newer.jobId })).status, 'published');
  const after = await f.repository.readSnapshot(), next = after.runtime.ozonDEPreflightEvidence[record.scope.authorizationId];
  assert.equal(next.provenance.softwareJobRef, newer.jobId);
  assert.deepEqual(after.runtime.ozonDEPreflightEvidenceVersions[record.scope.authorizationId], [record, next]);
  assert.deepEqual(await connected.reader(record.scope), next);
  assert.equal(f.requests.length, 3); assert.equal(later.requests.length, 3);
});
