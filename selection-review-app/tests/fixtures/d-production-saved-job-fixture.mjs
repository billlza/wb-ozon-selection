import assert from "node:assert/strict";
import { productionOwnerDecisionFixture } from "./production-owner-decision-fixture.mjs";
import { commitSingleOwnerProductionAuthorization } from "../../lib/production-authorization.mjs";
import { createProductionPlan, projectProductionPlanInputs } from "../../lib/production-plan.mjs";
import { runPlatformWritePreflight } from "../../lib/platform-write-preflight.mjs";
import { prepareSingleSkuDExecution } from "../../lib/d-e-software-closure.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../../lib/software-job-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../../lib/worker-registry.mjs";
import { createActorContext } from "../../lib/runtime-identity.mjs";
import { capabilities, exactObservation, ALL_WRITE_FIELDS } from "../helpers/d-software-fixture.mjs";
import { createStoreIsolatedOzonSellerApiDEAdapter } from "../../lib/ozon-seller-api-de-adapter.mjs";

const clone = value => structuredClone(value);

export async function savedDProductionJobFixture({owner = productionOwnerDecisionFixture()} = {}) {
  await commitSingleOwnerProductionAuthorization(owner.args);
  const repository = owner.repository;
  const candidate = (await repository.readSnapshot()).candidates[0], sku = candidate.lifecycleV11.skuPackage;
  let now = owner.formal.at, serviceVersion = "service-config:1";
  const clock = () => now;
  const currentProductionBinding = { ...clone(owner.commercialDecision.executionBinding), platform: "ozon", storeRef: clone(candidate.storeRef),
    storeName: "合成测试店铺", warehouseName: "合成测试仓库", warehouseRef: owner.commercialDecision.warehouseRef,
    credentialAlias: owner.commercialDecision.credentialAlias,
    verification: { evidenceRef: "configuration-evidence:synthetic:1", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" } };
  const plan = createProductionPlan({ productionAuthorization: sku.productionAuthorization, candidateId: candidate.id,
    candidateRevision: candidate.dataRevision, skuPackage: sku, createdAt: now });
  const inputs = projectProductionPlanInputs(plan);
  const adapterCapabilities = capabilities(inputs.store, inputs.finalUploads, inputs);
  adapterCapabilities.inventoryWrite.warehouseId = currentProductionBinding.warehouseId;
  adapterCapabilities.warehouseId = currentProductionBinding.warehouseId;
  // Explicit synthetic preapproved stable-address evidence for these exact owner-confirmed bytes.
  // This fixture performs no OSS upload and claims no real service verification.
  adapterCapabilities.assetTransport.resolvedAssets.forEach(asset => {
    asset.platformAcceptedUrl = `https://assets.example.com/saved/${asset.sha256}.jpg`;
  });
  const preflight = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: now, inspectPlatform: async () => ({
    observedStore: inputs.store, observedStoreRef: clone(inputs.storeRef), storeIdentityStatus: "matched",
    storeIdentityEvidenceRef: "evidence:synthetic:store", permissionStatus: "verified", permissionEvidenceRef: "evidence:synthetic:permission",
    connections: { api: { status: "connected", checkedVia: "seller_api_read_only", evidenceRef: "evidence:synthetic:api" },
      sellerBackend: { status: "connected", checkedVia: "seller_backend_read_only", evidenceRef: "evidence:synthetic:backend" } },
    platformWritableFields: ALL_WRITE_FIELDS, imagePermissionStatus: "verified", imagePermissionEvidenceRef: "evidence:synthetic:images",
    priceFieldCurrency: "CNY", priceCurrencyEvidenceRef: "evidence:synthetic:CNY", risks: []
  }) });
  const prepared = prepareSingleSkuDExecution({ productionPlan: plan, productionAuthorization: sku.productionAuthorization,
    platformWritePreflight: preflight, adapterCapabilities, currentProductionBinding, preparedAt: now });
  assert.equal(prepared.status, "ready", JSON.stringify(prepared.gaps));
  const registry = createLocalDevelopmentWorkerRegistry({ clock });
  const worker = registry.register({ workerId: "worker:synthetic:saved-d", version: "worker-version:1",
    capabilities: ["ozon-production-execution", "ozon-independent-readback"], observedAt: now });
  const resolveDEExecutionBinding = () => ({ schemaVersion: "d-e-execution-binding-v1", serviceId: "service:synthetic:saved-d",
    serviceConfigurationVersion: serviceVersion, productionBinding: clone(owner.commercialDecision.executionBinding),
    platform: "ozon", storeRef: clone(candidate.storeRef), warehouseRef: currentProductionBinding.warehouseRef,
    credentialAlias: currentProductionBinding.credentialAlias, workerId: worker.workerId, workerVersion: worker.version,
    configurationEvidence: clone(currentProductionBinding.verification) });
  const jobStore = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock: clock,
    workerRegistry: registry, resolveDEExecutionBinding });
  const jobId = sku.dHandoff.softwareJobRef.jobId, leaseId = "lease:synthetic:saved-d";
  const job = await jobStore.claim({ jobId, worker, leaseId, leaseDurationMs: 60_000 });
  const softwareJobContext = { jobStore, jobId, workerId: worker.workerId, leaseId };
  const input = { repository, runtimeMode: "local_development", candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
    actor: createActorContext({ userId: worker.workerId, sessionId: "session:synthetic:worker", actorType: "worker", roles: ["operator"],
      source: "registered_runtime_worker", authenticatedAt: now }), productionPlan: plan, platformWritePreflight: preflight,
    adapterCapabilities, currentProductionBinding, softwareJobContext, serverClock: clock };
  const calls = [], commits = [];
  let factories = 0;
  const createAdapter = (onCall = async () => {}) => async ({ executionContext, request }) => {
    factories += 1;
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ executionContext, adapterCapabilities,
      requestJson: async call => {
        calls.push(call.endpoint); commits.push(await repository.readSnapshot()); await onCall(call);
        if (call.endpoint === "/v3/product/import") return { result: { task_id: 501 } };
        if (call.endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: request.merchantSku, product_id: 910001, status: "imported", errors: [] }] } };
        if (call.endpoint === "/v2/products/stocks") return { result: [{ offer_id: request.merchantSku, product_id: 910001,
          warehouse_id: Number(request.inventoryWrite.warehouseId), updated: true, errors: [] }] };
        throw new Error("Unexpected synthetic D endpoint");
      } });
    return { executeSellerApi: adapter.executeSellerApi, readbackSellerApi: async () => exactObservation(request) };
  };
  return { owner, repository, input, candidate, job, jobStore, worker, registry, calls, commits, createAdapter,
    factories: () => factories, currentProductionBinding,
    changeServiceVersion: () => { serviceVersion = "service-config:2"; },
    advance: milliseconds => { now = new Date(Date.parse(now) + milliseconds).toISOString(); registry.heartbeat({ ...worker }); } };
}

