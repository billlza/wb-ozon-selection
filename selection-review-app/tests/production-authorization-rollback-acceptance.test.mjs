// 验收：作废 → 重签 → 新D作业排队 → 领取 → 素材守卫 → 导入被接受 → 观察（E）作业排队。
// 全程用合成卖家适配器，零真实外部请求、零真实平台写入。
import assert from "node:assert/strict";
import test from "node:test";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";
import { createProductionPlan, projectProductionPlanInputs } from "../lib/production-plan.mjs";
import { runPlatformWritePreflight } from "../lib/platform-write-preflight.mjs";
import { prepareSingleSkuDExecution } from "../lib/d-e-software-closure.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { capabilities, ALL_WRITE_FIELDS, exactObservation } from "./helpers/d-software-fixture.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { settleDProductionPreSendStopInDocument } from "../lib/software-job-contract.mjs";
import { normalizeDPlatformObservationConfiguration, createDPlatformObservationPolicyResolver } from "../lib/runtime-configuration.mjs";
import { createProductionAuthorizationRollbackUseCase } from "../lib/production-authorization-rollback-use-case.mjs";

const clone = value => structuredClone(value);
const OWNER = Object.freeze({ schemaVersion: "actor-context-v1", userId: "owner:acceptance", sessionId: "session:acceptance",
  actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: "2026-08-01T00:00:00.000Z" });

/** 按当前已签授权重建 D 执行所需的计划、前检、准备和作业，与既有夹具同一条路径。 */
async function prepareCurrentDExecution({ repository, currentProductionBinding, executionBinding, at, workerSuffix }) {
  const candidate = (await repository.readSnapshot()).candidates[0];
  const sku = candidate.lifecycleV11.skuPackage;
  const plan = createProductionPlan({ productionAuthorization: sku.productionAuthorization, candidateId: candidate.id,
    candidateRevision: candidate.dataRevision, skuPackage: sku, createdAt: at });
  const inputs = projectProductionPlanInputs(plan);
  const adapterCapabilities = capabilities(inputs.store, inputs.finalUploads, inputs);
  adapterCapabilities.inventoryWrite.warehouseId = currentProductionBinding.warehouseId;
  adapterCapabilities.warehouseId = currentProductionBinding.warehouseId;
  adapterCapabilities.assetTransport.resolvedAssets.forEach(asset => {
    asset.platformAcceptedUrl = `https://assets.example.com/saved/${asset.sha256}.jpg`;
  });
  const preflight = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: at, inspectPlatform: async () => ({
    observedStore: inputs.store, observedStoreRef: clone(inputs.storeRef), storeIdentityStatus: "matched",
    storeIdentityEvidenceRef: "evidence:synthetic:store", permissionStatus: "verified",
    permissionEvidenceRef: "evidence:synthetic:permission",
    connections: { api: { status: "connected", checkedVia: "seller_api_read_only", evidenceRef: "evidence:synthetic:api" },
      sellerBackend: { status: "connected", checkedVia: "seller_backend_read_only", evidenceRef: "evidence:synthetic:backend" } },
    platformWritableFields: ALL_WRITE_FIELDS, imagePermissionStatus: "verified",
    imagePermissionEvidenceRef: "evidence:synthetic:images", priceFieldCurrency: "CNY",
    priceCurrencyEvidenceRef: "evidence:synthetic:CNY", risks: [] }) });
  const prepared = prepareSingleSkuDExecution({ productionPlan: plan, productionAuthorization: sku.productionAuthorization,
    platformWritePreflight: preflight, adapterCapabilities, currentProductionBinding, preparedAt: at });
  assert.equal(prepared.status, "ready", JSON.stringify(prepared.gaps));

  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  const worker = registry.register({ workerId: `worker:acceptance:${workerSuffix}`, version: "worker-version:1",
    capabilities: ["ozon-production-execution", "ozon-independent-readback"], observedAt: at });
  const jobStore = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock: () => at,
    workerRegistry: registry, resolveDEExecutionBinding: () => ({ schemaVersion: "d-e-execution-binding-v1",
      serviceId: "service:acceptance", serviceConfigurationVersion: "service-config:1",
      productionBinding: clone(executionBinding), platform: "ozon", storeRef: clone(candidate.storeRef),
      warehouseRef: currentProductionBinding.warehouseRef, credentialAlias: currentProductionBinding.credentialAlias,
      workerId: worker.workerId, workerVersion: worker.version, configurationEvidence: clone(currentProductionBinding.verification) }) });
  const jobId = sku.dHandoff.softwareJobRef.jobId, leaseId = `lease:acceptance:${workerSuffix}`;
  const job = await jobStore.claim({ jobId, worker, leaseId, leaseDurationMs: 60_000 });
  const input = { repository, runtimeMode: "local_development", candidateId: candidate.id,
    expectedCandidateRevision: candidate.dataRevision,
    actor: createActorContext({ userId: worker.workerId, sessionId: "session:acceptance:worker", actorType: "worker",
      roles: ["operator"], source: "registered_runtime_worker", authenticatedAt: at }),
    productionPlan: plan, platformWritePreflight: preflight, adapterCapabilities, currentProductionBinding,
    softwareJobContext: { jobStore, jobId, workerId: worker.workerId, leaseId }, serverClock: () => at };
  return { candidate, sku, jobId, job, input, worker, leaseId };
}

function acceptedAdapter(request) {
  return { executeSellerApi: async (_request, { persistCheckpoint }) => {
    const identity = { taskId: "501", productId: "910001", merchantSku: request.merchantSku };
    for (const event of [{ kind: "import_intent" }, { kind: "import_task_received", taskId: "501" },
      { kind: "import_result_observed", ...identity, itemCount: 1, status: "imported", errorCount: 0,
        requestReceiptRef: "receipt:acceptance:import" },
      { kind: "stock_intent", ...identity, warehouseId: request.inventoryWrite.warehouseId, stock: 100 },
      { kind: "stock_receipt_observed", ...identity, warehouseId: request.inventoryWrite.warehouseId, updated: true,
        itemCount: 1, errorCount: 0, inventoryReceiptRef: "receipt:acceptance:stock" }]) await persistCheckpoint(event);
    return { status: "accepted", taskId: "501", productId: "910001", offerId: request.merchantSku,
      requestReceiptRef: "receipt:acceptance:import", inventoryReceiptRef: "receipt:acceptance:stock" };
  }, readbackSellerApi: async () => exactObservation(request) };
}

test("作废后重签的新一轮：领取、素材守卫、导入被接受、观察作业排队，全程零真实外部请求", async () => {
  const d = await savedDProductionJobFixture();
  const repository = d.repository;
  const binding = d.currentProductionBinding;
  const before = await repository.readSnapshot();
  const archivedAuthorizationId = before.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  const archivedJobIds = before.runtime.softwareJobs.filter(job => job.jobType === "d_production_execution").map(job => job.jobId);
  const at = d.input.serverClock();

  // 第1轮停在「失败，且一个请求都没发出去」，并让候选往前走一格（背心当时的形状）。
  await repository.transact(document => {
    settleDProductionPreSendStopInDocument(document, { jobId: d.input.softwareJobContext.jobId,
      workerId: d.worker.workerId, leaseId: d.input.softwareJobContext.leaseId,
      failureClass: "d-production-guard-rejected:OSS_LOCAL_ASSET_INVALID" }, at);
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: null };
  });

  // 主人点「作废本轮授权、退回等我确认」。
  const rollbackAt = new Date(Date.parse(at) + 1000).toISOString();
  const useCase = createProductionAuthorizationRollbackUseCase({ repository, serverClock: () => rollbackAt });
  const current = (await repository.readSnapshot()).candidates[0];
  await useCase.rollback({ actor: OWNER, input: { candidateId: current.id,
    authorizationId: archivedAuthorizationId, expectedRevision: current.dataRevision,
    confirmNothingWasSentToPlatform: true } });

  // 主人在最终确认卡上重签。
  const restored = (await repository.readSnapshot()).candidates[0];
  const restoredSku = restored.lifecycleV11.skuPackage;
  const card = restoredSku.productionConfirmationCard;
  const preparation = restoredSku.c2FinalAssets.productionAuthorizationPreparation;
  const resignAt = new Date(Date.parse(at) + 2000).toISOString();
  await commitSingleOwnerProductionAuthorization({ ...d.owner.args,
    input: { ...d.owner.args.input, dataRevision: restored.dataRevision, skuRevision: restoredSku.dataRevision,
      cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint },
    serverClock: () => resignAt });

  const signed = (await repository.readSnapshot()).candidates[0];
  const signedSku = signed.lifecycleV11.skuPackage;
  assert.notEqual(signedSku.productionAuthorization.authorizationId, archivedAuthorizationId);
  assert.match(signedSku.productionAuthorization.ownerDecisionId, /:r2$/);

  // 新一轮：领取 → 守卫 → 执行。
  const next = await prepareCurrentDExecution({ repository, currentProductionBinding: binding,
    executionBinding: d.owner.commercialDecision.executionBinding, at: resignAt, workerSuffix: "round2" });
  assert.ok(!archivedJobIds.includes(next.jobId), "新D作业号必须与已归档那两轮不同");

  const executed = await runPersistedDExecution({ ...next.input,
    createAdapter: async ({ request }) => acceptedAdapter(request) });
  assert.equal(executed.status, "succeeded", JSON.stringify(executed).slice(0, 400));

  const after = await repository.readSnapshot();
  const finalSku = after.candidates[0].lifecycleV11.skuPackage;
  assert.ok(finalSku.productionRecord, "导入被接受后必须有本轮生产记录");
  assert.equal(finalSku.productionRecord.sourceAuthorizationId, signedSku.productionAuthorization.authorizationId,
    "生产记录必须绑定新授权，不能沿用已归档那一份");
  const observation = after.runtime.softwareJobs.find(job => job.jobType === "e_independent_readback");
  assert.ok(observation, "导入被接受后必须排出独立回读（观察）作业");
  assert.equal(observation.status, "queued");
  assert.equal(observation.externalRequestState, "not_sent");

  // 归档仍在，两轮失败作业一条没删。
  const [archive] = after.candidates[0].lifecycleV11.productionAuthorizationRollbackArchiveV1;
  assert.equal(archive.productionAuthorizationRef.authorizationId, archivedAuthorizationId);
  for (const jobId of archivedJobIds) {
    assert.ok(after.runtime.softwareJobs.some(job => job.jobId === jobId), `已归档那一轮的作业 ${jobId} 必须原地保留`);
  }
});

test("作废重签后走生产路径：导入被接受后停在等待平台，且用旧授权号配的查询策略仍能取到、观察作业真的排队", async () => {
  const d = await savedDProductionJobFixture();
  const repository = d.repository;
  const binding = d.currentProductionBinding;
  const before = await repository.readSnapshot();
  const archivedAuthorizationId = before.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  const archivedJob = before.runtime.softwareJobs.find(job => job.jobType === "d_production_execution");
  const at = d.input.serverClock();

  await repository.transact(document => {
    settleDProductionPreSendStopInDocument(document, { jobId: d.input.softwareJobContext.jobId,
      workerId: d.worker.workerId, leaseId: d.input.softwareJobContext.leaseId,
      failureClass: "d-production-guard-rejected:OSS_LOCAL_ASSET_INVALID" }, at);
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: null };
  });

  const rollbackAt = new Date(Date.parse(at) + 1000).toISOString();
  const useCase = createProductionAuthorizationRollbackUseCase({ repository, serverClock: () => rollbackAt });
  const current = (await repository.readSnapshot()).candidates[0];
  await useCase.rollback({ actor: OWNER, input: { candidateId: current.id, authorizationId: archivedAuthorizationId,
    expectedRevision: current.dataRevision, confirmNothingWasSentToPlatform: true } });

  const restored = (await repository.readSnapshot()).candidates[0];
  const restoredSku = restored.lifecycleV11.skuPackage;
  const card = restoredSku.productionConfirmationCard;
  const preparation = restoredSku.c2FinalAssets.productionAuthorizationPreparation;
  const resignAt = new Date(Date.parse(at) + 2000).toISOString();
  await commitSingleOwnerProductionAuthorization({ ...d.owner.args,
    input: { ...d.owner.args.input, dataRevision: restored.dataRevision, skuRevision: restoredSku.dataRevision,
      cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint },
    serverClock: () => resignAt });

  const next = await prepareCurrentDExecution({ repository, currentProductionBinding: binding,
    executionBinding: d.owner.commercialDecision.executionBinding, at: resignAt, workerSuffix: "observation" });

  // 查询策略按正式启动配置的形状配置：同候选、同SKU、同仓库绑定、同配置版本，
  // 但 authorizationRef 和 revision 故意留旧值——这正是重签一版授权之后的真实处境。
  const policy = { schemaVersion: "d-platform-observation-policy-v1", policyRef: "policy:acceptance:rollback",
    version: "version:1", maxQueries: 20, intervalMs: 15000, requestTimeoutMs: 30000,
    expiresAt: new Date(Date.parse(resignAt) + 3_600_000).toISOString() };
  const entry = { candidateId: next.candidate.id, skuPackageId: next.job.skuPackageId,
    authorizationRef: archivedJob.scopeBinding.authorizationRef, revision: archivedJob.revision,
    productionBindingId: next.job.scopeBinding.productionBinding.bindingId,
    productionConfigurationVersion: next.job.scopeBinding.productionBinding.configurationVersion, policy };
  const dPlatformObservation = normalizeDPlatformObservationConfiguration({ policies: [entry], pumpIntervalMs: 1000 }, [binding]);
  const loadDPlatformObservationPolicy = createDPlatformObservationPolicyResolver({ dPlatformObservation });

  const resolved = loadDPlatformObservationPolicy({ candidate: next.candidate, job: next.job });
  assert.deepEqual(resolved, policy, "旧授权号下配的查询策略，在重签一版授权之后必须仍然取得到");

  // 导入被平台接受但仍在处理：这才是生产路径，不能一步走完库存。
  const executed = await runPersistedDExecution({ ...next.input, platformObservationPolicy: policy,
    createAdapter: d.createAdapter() });
  assert.equal(executed.status, "waiting_platform", JSON.stringify(executed).slice(0, 300));

  const after = await repository.readSnapshot();
  const observation = after.runtime.softwareJobs.find(job => job.jobType === "e_d_platform_observation");
  assert.ok(observation, "导入被接受后必须排出平台观察作业");
  assert.equal(observation.status, "queued");
  assert.equal(observation.externalRequestState, "not_sent");
  assert.equal(observation.scopeBinding.sourceDJobId, next.jobId, "观察作业必须指向本轮新的D作业");
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.productionRecord, null, "仍在等待平台时不得产生生产记录");
  assert.equal(after.candidates[0].lifecycleV11.platformWrites, 0);
});
