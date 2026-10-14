// 复现并钉死 2026-09-23 背心那次静默降级：视图因归档轮次判来源冲突 → continueProduction
// 跳过 evidenceSource.publish 裸跑 → 前检必然缺账户证据 → 新授权第一轮被烧掉。
// 全程合成 HTTP 传输，零真实外部请求、零平台写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { productionOwnerDecisionHttpFixture } from './helpers/d-e-saved-api-fixture.mjs';
import { createSelectionReviewRuntimeConfiguration } from '../lib/runtime-configuration.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createOzonDEHttpTransport } from '../lib/ozon-de-http-transport.mjs';
import { createOzonAccountReadBindingResolver } from '../lib/ozon-account-read-preparation.mjs';
import { createOzonAccountReadEvidenceSource } from '../lib/ozon-account-read-evidence.mjs';
import { loadOzonDEProtocolCatalog } from '../lib/ozon-de-protocol-catalog.mjs';
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from '../lib/ozon-de-preflight-evidence-reader.mjs';
import { createOzonDEPreflightProvider } from '../lib/ozon-de-preflight-provider.mjs';
import { createDEProductionRuntimeServices } from '../lib/d-e-runtime-services.mjs';
import { createOzonAccountReadServices } from '../lib/ozon-account-read-services.mjs';
import { buildDESavedJobRuntimeView } from '../lib/d-e-runtime-view.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { createProductionAuthorizationRollbackUseCase } from '../lib/production-authorization-rollback-use-case.mjs';
import { createDProductionRoundUseCase } from '../lib/d-production-round-use-case.mjs';
import { OZON_DE_READBACK_ENDPOINTS, OZON_PRODUCT_IMPORT_INFO_ENDPOINT } from '../lib/ozon-seller-api-de-adapter.mjs';

const OWNER = Object.freeze({ schemaVersion: 'actor-context-v1', userId: 'owner:continue', sessionId: 'session:continue',
  actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: '2026-08-01T00:00:00.000Z' });

async function harness() {
  const base = await productionOwnerDecisionHttpFixture();
  let offset = 0;
  const clock = () => new Date(Date.parse(base.owner.formal.at) + offset).toISOString();
  const accountService = { schemaVersion: 'ozon-account-read-service-binding-v1', serviceId: 'service:synthetic:account-read',
    configurationVersion: base.service.configurationVersion, productionBindingId: base.binding.bindingId,
    productionConfigurationVersion: base.binding.configurationVersion, workerId: 'worker:synthetic:account-read',
    workerVersion: base.service.workerVersion, leaseDurationMs: base.service.leaseDurationMs };
  const env = {
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: base.candidate.targetStore, platform: 'ozon', storeRef: base.candidate.storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([base.binding]),
    SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([base.service]),
    SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: JSON.stringify([accountService]),
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify([{ credentialAlias: base.binding.credentialAlias,
      clientId: '700123', keychainService: 'synthetic-continue', keychainAccount: 'synthetic-continue' }])
  };
  const configuration = createSelectionReviewRuntimeConfiguration({ env, appDir: '/tmp/synthetic-rollback-continue', argv: [] });
  const repository = createMemoryBusinessStateRepository(base.document);
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock });
  const accountResponses = {
    '/v1/roles': { expires_at: '2099-01-01T00:00:00.000Z', roles: [{ name: 'test', methods: ['/v3/product/import', '/v2/products/stocks',
      OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_READBACK_ENDPOINTS)] }] },
    '/v1/seller/info': { company: { currency: 'CNY' } },
    '/v2/warehouse/list': { has_next: false, warehouses: [{ warehouse_id: Number(base.binding.warehouseId), is_rfbs: true,
      status: 'created', warehouse_type: 'RFBS', pause_at: null }] }
  };
  const sellerCalls = [], uploaded = [], policyLoads = { count: 0, override: null };
  const loadPolicy = () => { policyLoads.count += 1;
    return policyLoads.override ? structuredClone(policyLoads.override(policyLoads.count)) : structuredClone(observationPolicy); };
  const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1', policyRef: 'policy:synthetic:rollback',
    version: 'version:1', maxQueries: 20, intervalMs: 15000, requestTimeoutMs: 30000,
    expiresAt: '2099-01-01T00:00:00.000Z' };
  const transport = createOzonDEHttpTransport({ productionBindings: configuration.productionBindings,
    credentialBindings: configuration.ozonDECredentialBindings, readSecret: async () => 'synthetic-secret',
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url).pathname;
      sellerCalls.push(endpoint);
      if (Object.hasOwn(accountResponses, endpoint)) {
        return new Response(JSON.stringify(accountResponses[endpoint]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (endpoint === '/v3/product/import') return new Response(JSON.stringify({ result: { task_id: 601 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`unexpected endpoint ${endpoint} ${options?.method ?? ''}`);
    } });
  const resolver = createOzonAccountReadBindingResolver(configuration);
  // 协议目录必须给：正式服务启动时就是这么接的。不给会让全部协议类能力退化成 not_verified，
  // 于是 gateSavedView 把「继续已保存任务」关掉——自己搭验证环境时最容易踩的假阴性。
  const evidenceSource = createOzonAccountReadEvidenceSource({ repository, loadCurrentReadBinding: resolver,
    protocolCatalog: await loadOzonDEProtocolCatalog() });
  const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository, verifySourceReceipt: evidenceSource.verifySourceReceipt });
  const provider = createOzonDEPreflightProvider({ readEvidence: reader, serverClock: clock });
  const de = createDEProductionRuntimeServices({ repository, runtimeMode: 'local_development', serverClock: clock, workerRegistry,
    deServiceBindings: configuration.deServiceBindings, productionBindings: configuration.productionBindings,
    requestJson: transport.requestJson, inspectPlatform: provider.inspectPlatform, loadAdapterCapabilities: provider.loadAdapterCapabilities,
    upload: async ({ finalUploads, beforePublicWrite }) => {
      for (const asset of finalUploads) { await beforePublicWrite({ assetId: asset.assetId, sha256: asset.sha256, order: asset.order }); uploaded.push(asset.assetId); }
      return { status: 'verified', mode: 'preapproved_stable_https', protocolVersion: 'aliyun-oss-final-assets-v1',
        evidenceRef: 'oss:synthetic:rollback-continue', approvedHosts: ['assets.example.com'],
        resolvedAssets: finalUploads.map(asset => ({ assetId: asset.assetId, sha256: asset.sha256, order: asset.order,
          role: asset.role, platformAcceptedUrl: `https://assets.example.com/rollback/${asset.sha256}.jpg`,
          stable: true, authorizationStatus: 'approved', evidenceRef: `oss:synthetic:${asset.assetId}` })) };
    },
    resolveLocalAsset: async asset => ({ body: Buffer.from(`synthetic-${asset.assetId}`), contentType: 'image/png' }),
    loadDPlatformObservationPolicy: loadPolicy,
    preflightRequestMode: 'persisted_evidence_only' });
  // 与 D 运行时注入同一个解析器：视图和执行层必须看同一份策略。
  const services = createOzonAccountReadServices({ configuration, repository, workerRegistry, serverClock: clock,
    requestJson: transport.requestJson, evidenceSource, preflightProvider: provider, deRuntimeServices: de,
    loadDPlatformObservationPolicy: loadPolicy });
  // 服务构造时可能已经登记过同一个 worker；重复登记会抛，这里只补缺。
  for (const [workerId, version, capabilities] of [
    [base.service.workerId, base.service.workerVersion, ['ozon-production-execution', 'ozon-independent-readback', 'ozon-account-read']],
    [accountService.workerId, accountService.workerVersion, ['ozon-account-read']]
  ]) {
    try { workerRegistry.register({ workerId, version, capabilities, observedAt: clock() }); }
    catch (error) { if (!/DUPLICATE_WORKER/.test(String(error.message))) throw error; }
  }
  return { base, configuration, repository, services, sellerCalls, uploaded, de, workerRegistry, clock,
    observationPolicy, policyLoads,
    advance: ms => { offset += ms; },
    rollbackUseCase: () => createProductionAuthorizationRollbackUseCase({ repository, serverClock: clock }) };
}

async function runAccountRead(h) {
  const document = await h.repository.readSnapshot();
  const preparation = h.services.preparation({ candidate: document.candidates[0], document });
  const option = preparation.options[0];
  assert.ok(option, '夹具必须给出账户核验选项');
  return h.services.authorizeAndRun({ actor: h.base.owner.args.actor, input: { candidateId: document.candidates[0].id,
    skuPackageId: preparation.skuPackageId, expectedRevision: preparation.expectedRevision, bindingId: option.bindingId,
    configurationVersion: option.configurationVersion, scopeRef: option.scopeRef, expiresAt: '2099-01-01T00:00:00.000Z',
    confirmReadOnce: true, idempotencyKey: `owner-read:${preparation.expectedRevision}` } });
}

/** 作废 → 重签，留下「归档两轮 + 新授权 :r2」的真实形状。 */
async function rollbackAndResign(h) {
  await commitSingleOwnerProductionAuthorization({ ...h.base.owner.args, repository: h.repository });
  let document = await h.repository.readSnapshot();
  const firstJob = document.runtime.softwareJobs.find(job => job.jobType === 'd_production_execution');
  // 让第一轮停在「失败、且一个请求都没发出去」，并把候选往前推一格（背心当时的形状）。
  await h.repository.transact(current => {
    const job = current.runtime.softwareJobs.find(entry => entry.jobId === firstJob.jobId);
    job.status = 'failed'; job.attempt = 1; job.externalRequestState = 'not_sent';
    job.externalRequestRef = null; job.resultEnvelope = null;
    job.failureClass = 'd-production-guard-rejected:SYNTHETIC';
    current.candidates[0].dataRevision += 1;
    return { changed: true, document: current, result: null };
  });
  document = await h.repository.readSnapshot();
  const archivedAuthorizationId = document.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  h.advance(1000);
  await h.rollbackUseCase().rollback({ actor: OWNER, input: { candidateId: document.candidates[0].id,
    authorizationId: archivedAuthorizationId, expectedRevision: document.candidates[0].dataRevision,
    confirmNothingWasSentToPlatform: true } });
  // 主人 13:34 就是在这个位置做的账户核验：已作废、未重签。
  // 它的 revision 等于此刻的候选修订，也就是新授权的 sourceCandidateRevision。
  const read = await runAccountRead(h);
  assert.equal(read.status, 'completed', `账户核验必须完成：${JSON.stringify(read).slice(0, 200)}`);
  const restored = (await h.repository.readSnapshot()).candidates[0];
  const sku = restored.lifecycleV11.skuPackage, card = sku.productionConfirmationCard;
  const preparation = sku.c2FinalAssets.productionAuthorizationPreparation;
  h.advance(1000);
  const signed = await commitSingleOwnerProductionAuthorization({ ...h.base.owner.args, repository: h.repository,
    input: { ...h.base.owner.args.input, dataRevision: restored.dataRevision, skuRevision: sku.dataRevision,
      cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint },
    serverClock: h.clock });
  return { archivedAuthorizationId, signed };
}

test('复现今天：归档轮次在场时，自动起跑必须先把账户证据发布到新授权键下，不得裸跑', async () => {
  const h = await harness();
  const { archivedAuthorizationId, signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  assert.notEqual(newAuthorizationId, archivedAuthorizationId);
  assert.match(newAuthorizationId, /:r2$/);

  const before = await h.repository.readSnapshot();
  assert.equal(before.runtime.ozonDEPreflightEvidence?.[newAuthorizationId], undefined, '重签之后新键下还没有证据');
  const job = before.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  assert.ok(job, '重签必须排出新一轮D作业');
  assert.equal(job.status, 'queued');

  // 这一步就是主人点「通过进入生产授权」之后服务端自动跑的那一下。
  const outcome = await h.services.continueProduction({ candidateId: before.candidates[0].id,
    jobId: job.jobId, expectedRevision: before.candidates[0].dataRevision });

  const after = await h.repository.readSnapshot();
  assert.ok(after.runtime.ozonDEPreflightEvidence?.[newAuthorizationId],
    `账户证据必须发布到新授权键下，实际结果：${JSON.stringify(outcome).slice(0, 300)}`);
  assert.equal(after.runtime.ozonDEPreflightEvidence[newAuthorizationId].scope.authorizationId, newAuthorizationId);
  assert.notEqual(outcome.status, 'saved_job_source_conflict', '归档轮次在场不是来源冲突');
  const settled = after.runtime.softwareJobs.find(entry => entry.jobId === job.jobId);
  assert.notEqual(settled.failureClass, 'd-production-preflight-not-ready',
    '不得再出现「账户证据齐全却因为跳过发布而前检失败」');
});

test('自动起跑遇到真的来源冲突时拒绝，不 claim、不发布、不落任何东西', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  // 制造真的来源冲突：把一条归档轮次改成外来授权号，归档里找不到出处。
  await h.repository.transact(document => {
    const stranger = document.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
      entry.scopeBinding.authorizationRef !== newAuthorizationId);
    stranger.scopeBinding = { ...stranger.scopeBinding, authorizationRef: `${stranger.scopeBinding.authorizationRef}:stranger` };
    return { changed: true, document, result: null };
  });
  const before = await h.repository.readSnapshot();
  const job = before.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  const callsBefore = h.sellerCalls.length;

  const outcome = await h.services.continueProduction({ candidateId: before.candidates[0].id,
    jobId: job.jobId, expectedRevision: before.candidates[0].dataRevision });

  assert.equal(outcome.status, 'saved_job_source_conflict');
  assert.equal(outcome.reason, 'DE_SAVED_JOB_REFERENCE_CONFLICT');
  assert.equal(outcome.externalRequests, 0);
  assert.equal(outcome.platformWrites, 0);
  const after = await h.repository.readSnapshot();
  const settled = after.runtime.softwareJobs.find(entry => entry.jobId === job.jobId);
  assert.equal(settled.status, 'queued', '拒绝之后作业必须还在排队');
  assert.equal(settled.attempt, 0);
  assert.equal(Object.hasOwn(settled, 'preparationEvidence'), false, '不得留下执行准备痕迹');
  assert.equal(after.runtime.ozonDEPreflightEvidence?.[newAuthorizationId], undefined, '不得发布证据');
  assert.equal(h.sellerCalls.length, callsBefore, '不得发出任何外部请求');
  assert.deepEqual(after, before, '整份文档逐字节不变');
});

/** 主人真正会走的那条路，每一步之后都用真实视图断言三个按钮。 */
test('主人那条路整条走通：重签自动起跑 → 证据发布 → 传图 → 导入 task_id → 等待平台 → 观察作业排队', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;

  const buttons = async label => {
    const document = await h.repository.readSnapshot();
    const candidate = document.candidates[0];
    const base = buildDESavedJobRuntimeView({ candidate, runtime: { ...document.runtime, workers: h.workerRegistry.snapshot() },
      serviceBindings: h.configuration.deServiceBindings, productionBindings: h.configuration.productionBindings,
      dependencyView: h.de.dependencyView, observedAt: h.clock() });
    const view = h.services.gateSavedView({ candidate, document, view: base });
    return { label, status: view?.status ?? null, continueSaved: view?.canContinueSaved === true,
      newRound: view?.canDispatchNewRound === true, rollback: view?.canRollbackAuthorization === true, document };
  };

  const afterResign = await buttons('重签之后');
  assert.equal(afterResign.status !== 'source_conflict', true, '重签之后不该是来源冲突');
  assert.equal(afterResign.continueSaved, true, '重签之后「继续已保存任务」必须亮');
  assert.equal(afterResign.newRound, false, '当前轮还没失败，「再派一轮」不该亮');
  assert.equal(afterResign.rollback, false, '「作废本轮授权」不该亮');

  const job = afterResign.document.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  const outcome = await h.services.continueProduction({ candidateId: afterResign.document.candidates[0].id,
    jobId: job.jobId, expectedRevision: afterResign.document.candidates[0].dataRevision });
  assert.equal(outcome.status, 'waiting_platform', `导入被接受后应当等待平台：${JSON.stringify(outcome).slice(0, 300)}`);

  const after = await h.repository.readSnapshot();
  assert.ok(after.runtime.ozonDEPreflightEvidence?.[newAuthorizationId], '账户证据必须发布到新授权键下');
  assert.equal(h.uploaded.length, after.candidates[0].lifecycleV11.skuPackage.productionAuthorization.lockedScope.finalUploads.length,
    '授权锁定的每一张素材都要过一次传输');
  assert.ok(h.sellerCalls.includes('/v3/product/import'), '必须真的调用过导入');
  const transport = after.candidates[0].lifecycleV11.skuPackage.dAssetTransport;
  assert.equal(transport?.status, 'verified', `素材传输应当完成：${JSON.stringify(transport?.status)}`);
  const observation = after.runtime.softwareJobs.find(entry => entry.jobType === 'e_d_platform_observation');
  assert.ok(observation, '导入被接受后必须排出平台观察作业');
  assert.equal(observation.status, 'queued');
  assert.equal(observation.externalRequestState, 'not_sent');
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.productionRecord, null, '仍在等待平台时不得有生产记录');

  const afterContinue = await buttons('继续之后');
  assert.equal(afterContinue.continueSaved, false, '已在等待平台，「继续已保存任务」必须灭');
  assert.equal(afterContinue.newRound, false, '等待平台时「再派一轮」必须灭');
  assert.equal(afterContinue.rollback, false, '等待平台时「作废本轮授权」必须灭');
});

/** 主人明天真正走的那条：当前轮已 failed → 自己点「再派一轮」→ 再点「继续已保存任务」。 */
test('从「再派一轮」进：新一轮排队 → 继续 → 证据发布 → 传图 → 导入 → 等待平台 → 观察作业排队', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;

  const buttons = async () => {
    const document = await h.repository.readSnapshot();
    const candidate = document.candidates[0];
    const base = buildDESavedJobRuntimeView({ candidate, runtime: { ...document.runtime, workers: h.workerRegistry.snapshot() },
      serviceBindings: h.configuration.deServiceBindings, productionBindings: h.configuration.productionBindings,
      dependencyView: h.de.dependencyView, observedAt: h.clock() });
    const view = h.services.gateSavedView({ candidate, document, view: base });
    return { status: view?.status ?? null, continueSaved: view?.canContinueSaved === true,
      newRound: view?.canDispatchNewRound === true, rollback: view?.canRollbackAuthorization === true, document };
  };

  // 新授权的第一轮停在「失败、且一个请求都没发出去」——正是背心现在的形状。
  const firstRound = (await h.repository.readSnapshot()).runtime.softwareJobs.find(entry =>
    entry.jobType === 'd_production_execution' && entry.scopeBinding.authorizationRef === newAuthorizationId);
  await h.repository.transact(document => {
    const job = document.runtime.softwareJobs.find(entry => entry.jobId === firstRound.jobId);
    job.status = 'failed'; job.attempt = 1; job.externalRequestState = 'not_sent';
    job.externalRequestRef = null; job.resultEnvelope = null;
    job.failureClass = 'd-production-preflight-not-ready';
    return { changed: true, document, result: null };
  });

  const stuck = await buttons();
  assert.equal(stuck.newRound, true, '当前轮失败且未发出，「再派一轮」必须亮');
  assert.equal(stuck.continueSaved, false, '失败的那一轮不该还能继续');
  assert.equal(stuck.rollback, false, '还能再派一轮时不给作废');

  // 主人点「再派一轮生产作业」——走真实用例，不直接改文档。
  const roundUseCase = createDProductionRoundUseCase({ repository: h.repository, serverClock: h.clock });
  const dispatched = await roundUseCase.dispatch({ actor: OWNER, input: { candidateId: stuck.document.candidates[0].id,
    expectedRevision: stuck.document.candidates[0].dataRevision, supersededJobId: firstRound.jobId,
    confirmPreviousRoundSentNothing: true } });
  const dispatchResult = dispatched.result ?? dispatched;
  assert.equal(dispatchResult.round, 2);
  assert.equal(dispatchResult.externalRequests, 0);
  assert.equal(dispatchResult.platformWrites, 0);
  assert.notEqual(dispatchResult.jobId, firstRound.jobId);

  const afterRound = await buttons();
  assert.notEqual(afterRound.status, 'source_conflict', '再派一轮之后不该是来源冲突');
  assert.equal(afterRound.continueSaved, true, '再派一轮之后「继续已保存任务」必须亮');
  assert.equal(afterRound.newRound, false, '已经排了新一轮，不该再给「再派一轮」');
  assert.equal(afterRound.rollback, false, '「作废本轮授权」不该亮');

  // 主人点「继续已保存任务」。
  const outcome = await h.services.continueProduction({ candidateId: afterRound.document.candidates[0].id,
    jobId: dispatchResult.jobId, expectedRevision: afterRound.document.candidates[0].dataRevision });
  assert.equal(outcome.status, 'waiting_platform', `导入被接受后应当等待平台：${JSON.stringify(outcome).slice(0, 300)}`);

  const after = await h.repository.readSnapshot();
  const sku = after.candidates[0].lifecycleV11.skuPackage;
  assert.ok(after.runtime.ozonDEPreflightEvidence?.[newAuthorizationId], '账户证据必须发布到新授权键下');
  assert.equal(h.uploaded.length, sku.productionAuthorization.lockedScope.finalUploads.length, '每张素材都要过一次传输');
  assert.ok(h.sellerCalls.includes('/v3/product/import'), '必须真的调用过导入');
  assert.equal(sku.dAssetTransport?.status, 'verified');
  const observation = after.runtime.softwareJobs.find(entry => entry.jobType === 'e_d_platform_observation');
  assert.ok(observation, '必须排出平台观察作业');
  assert.equal(observation.status, 'queued');
  assert.equal(observation.externalRequestState, 'not_sent');
  assert.equal(observation.scopeBinding.sourceDJobId, dispatchResult.jobId, '观察作业必须指向再派的那一轮');
  assert.equal(sku.productionRecord, null, '仍在等待平台时不得有生产记录');

  const done = await buttons();
  assert.equal(done.continueSaved, false);
  assert.equal(done.newRound, false);
  assert.equal(done.rollback, false);
});

test('观察策略已过期时，导入绝不发出：零外部请求、零上传、零副作用', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  // 把策略设成早已过期——2026-09-24 背心正是这个形状（r65 设的 09-23 14:00Z）。
  h.observationPolicy.expiresAt = '2026-08-01T00:00:00.000Z';

  const before = await h.repository.readSnapshot();
  const job = before.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  const callsBefore = h.sellerCalls.length, uploadsBefore = h.uploaded.length;

  const outcome = await h.services.continueProduction({ candidateId: before.candidates[0].id,
    jobId: job.jobId, expectedRevision: before.candidates[0].dataRevision });

  assert.equal(outcome.status, 'observation_policy_unavailable', JSON.stringify(outcome).slice(0, 300));
  assert.equal(outcome.reason, 'observation_policy_expired');
  assert.equal(outcome.policyExpiresAt, '2026-08-01T00:00:00.000Z');
  assert.equal(outcome.externalRequests, 0);
  assert.equal(outcome.platformWrites, 0);

  const after = await h.repository.readSnapshot();
  assert.equal(h.sellerCalls.length, callsBefore, '不得发出任何外部请求');
  assert.equal(h.uploaded.length, uploadsBefore, '不得上传任何素材');
  const settled = after.runtime.softwareJobs.find(entry => entry.jobId === job.jobId);
  assert.equal(settled.status, 'queued', '作业必须仍在排队');
  assert.equal(settled.attempt, 0);
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.dAssetTransport ?? null, null, '不得留下素材传输痕迹');
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution ?? null, null, '不得落执行意图');
  assert.equal(after.candidates[0].lifecycleV11.platformWrites, 0);
});

test('策略缺失时同样在零副作用处拒绝', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  h.policyLoads.override = () => null;

  const before = await h.repository.readSnapshot();
  const job = before.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  // 基线不是 0：账户核验本身已经发过 3 次只读请求，本条要断言的是「这一步之后没有新增」。
  const callsBefore = h.sellerCalls.length, uploadsBefore = h.uploaded.length;
  const outcome = await h.services.continueProduction({ candidateId: before.candidates[0].id,
    jobId: job.jobId, expectedRevision: before.candidates[0].dataRevision });
  assert.equal(outcome.status, 'observation_policy_unavailable');
  assert.equal(outcome.reason, 'observation_policy_missing');
  assert.equal(h.sellerCalls.length, callsBefore, '不得新增任何外部请求');
  assert.equal(h.uploaded.length, uploadsBefore, '不得上传任何素材');
  const after = await h.repository.readSnapshot();
  assert.equal(after.runtime.softwareJobs.find(e => e.jobId === job.jobId).status, 'queued');
});

test('万一仍在接受之后停下，停止记录必须写清是哪一条判定、比的哪两个值', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  // 第 1 次加载（发导入前的零副作用检查）给未过期，第 2 次（传进执行层的那次）给已过期，
  // 模拟「检查之后、结算之前过期」这一窄窗口，走到接受之后才停的那条路。
  h.policyLoads.override = count => ({ ...h.observationPolicy,
    expiresAt: count === 1 ? '2099-01-01T00:00:00.000Z' : '2026-08-01T00:00:00.000Z' });

  const before = await h.repository.readSnapshot();
  const job = before.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  await h.services.continueProduction({ candidateId: before.candidates[0].id,
    jobId: job.jobId, expectedRevision: before.candidates[0].dataRevision });

  const after = await h.repository.readSnapshot();
  const state = after.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.ok(state, '应当已落执行记录');
  assert.ok(state.stopTrigger, '停止记录必须带 stopTrigger');
  assert.equal(state.stopTrigger.failureClass, 'context_changed');
  assert.equal(state.stopTrigger.condition, 'settledAt >= platformObservationPolicy.expiresAt');
  assert.equal(state.stopTrigger.right, '2026-08-01T00:00:00.000Z', '必须记下被比较的策略到期时间');
  assert.ok(typeof state.stopTrigger.left === 'string' && Number.isFinite(Date.parse(state.stopTrigger.left)),
    '必须记下被比较的结算时刻');
});

test('策略还没过期、但剩余寿命盖不住整个观察窗口时，导入同样不发', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  // 观察最长要跑 maxQueries × intervalMs；把到期时间设在这段窗口之内，
  // 现在还没过期，但跑到一半必然过期——正是「发出去了没人管」的另一半。
  const windowMs = h.observationPolicy.maxQueries * h.observationPolicy.intervalMs;
  h.observationPolicy.expiresAt = new Date(Date.parse(h.clock()) + Math.floor(windowMs / 2)).toISOString();

  const before = await h.repository.readSnapshot();
  const job = before.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  const callsBefore = h.sellerCalls.length, uploadsBefore = h.uploaded.length;

  const outcome = await h.services.continueProduction({ candidateId: before.candidates[0].id,
    jobId: job.jobId, expectedRevision: before.candidates[0].dataRevision });

  assert.equal(outcome.status, 'observation_policy_unavailable', JSON.stringify(outcome).slice(0, 300));
  assert.equal(outcome.reason, 'observation_policy_expiring_within_window');
  assert.ok(outcome.remainingMs < outcome.requiredWindowMs, '必须报出剩余寿命不足以覆盖观察窗口');
  assert.ok(outcome.requiredWindowMs >= windowMs, '所需窗口至少是 maxQueries × intervalMs');
  assert.equal(h.sellerCalls.length, callsBefore, '不得发出任何外部请求');
  assert.equal(h.uploaded.length, uploadsBefore, '不得上传任何素材');
  const after = await h.repository.readSnapshot();
  const settled = after.runtime.softwareJobs.find(entry => entry.jobId === job.jobId);
  assert.equal(settled.status, 'queued');
  assert.equal(settled.attempt, 0);
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution ?? null, null);
});

test('策略有问题时「继续已保存任务」按钮就不亮，并说明原因（不是点了才被拒）', async () => {
  const h = await harness();
  const { signed } = await rollbackAndResign(h);
  const newAuthorizationId = signed.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  const windowMs = h.observationPolicy.maxQueries * h.observationPolicy.intervalMs;

  const buttons = async () => {
    const document = await h.repository.readSnapshot();
    const candidate = document.candidates[0];
    const base = buildDESavedJobRuntimeView({ candidate, runtime: { ...document.runtime, workers: h.workerRegistry.snapshot() },
      serviceBindings: h.configuration.deServiceBindings, productionBindings: h.configuration.productionBindings,
      dependencyView: h.de.dependencyView, observedAt: h.clock() });
    const view = h.services.gateSavedView({ candidate, document, view: base });
    return { continueSaved: view?.canContinueSaved === true,
      codes: (view?.d?.blockers ?? []).map(entry => entry.code) };
  };

  assert.ok((await buttons()).continueSaved, '策略正常时应当可以继续');

  h.observationPolicy.expiresAt = '2026-08-01T00:00:00.000Z';
  let state = await buttons();
  assert.equal(state.continueSaved, false, '策略已过期时按钮必须不亮');
  assert.ok(state.codes.includes('OZON_OBSERVATION_POLICY_EXPIRED'), JSON.stringify(state.codes));

  h.observationPolicy.expiresAt = new Date(Date.parse(h.clock()) + Math.floor(windowMs / 2)).toISOString();
  state = await buttons();
  assert.equal(state.continueSaved, false, '剩余寿命盖不住观察窗口时按钮必须不亮');
  assert.ok(state.codes.includes('OZON_OBSERVATION_POLICY_EXPIRING_WITHIN_WINDOW'), JSON.stringify(state.codes));

  h.policyLoads.override = () => null;
  state = await buttons();
  assert.equal(state.continueSaved, false, '策略缺失时按钮必须不亮');
  assert.ok(state.codes.includes('OZON_OBSERVATION_POLICY_MISSING'), JSON.stringify(state.codes));

  // 与执行层同一判定：按钮不亮的三种情形，后端也一律拒绝。
  h.policyLoads.override = null;
  h.observationPolicy.expiresAt = '2026-08-01T00:00:00.000Z';
  const document = await h.repository.readSnapshot();
  const job = document.runtime.softwareJobs.find(entry => entry.jobType === 'd_production_execution' &&
    entry.scopeBinding.authorizationRef === newAuthorizationId);
  const outcome = await h.services.continueProduction({ candidateId: document.candidates[0].id,
    jobId: job.jobId, expectedRevision: document.candidates[0].dataRevision });
  assert.equal(outcome.status, 'observation_policy_unavailable');
});
