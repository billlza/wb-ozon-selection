import { createSyntheticDCompletionAdapter } from "../helpers/d-synthetic-completion-adapter.mjs";
import { preparedFixture, capabilities } from "../helpers/d-software-fixture.mjs";
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from "../../lib/business-state-repository.mjs";
import { createActorContext } from "../../lib/runtime-identity.mjs";
import { runPersistedDExecution } from "../../lib/d-e-software-integration.mjs";

export const DE_SCOPE_OBSERVED_AT = "2026-08-22T07:30:00.000Z";

/** Entirely synthetic: exercise the existing persisted D writer with explicit synthetic completion DTOs; not a real adapter integration. */
export async function deSoftwareJobScopeFixture(options = {}) {
  const { fixture, plan, preflight, prepared, currentProductionBinding } = await preparedFixture(options);
  const sku = structuredClone(fixture.skuPackage);
  const initialCandidate = { id: fixture.candidateId, dataRevision: fixture.candidateRevision,
    targetStore: sku.targetStore, storeRef: structuredClone(sku.g1Identity.storeRef), lifecycleV11: { skuPackage: sku } };
  const document = initialBusinessStateDocument({ now: DE_SCOPE_OBSERVED_AT });
  document.candidates = [structuredClone(initialCandidate)];
  const repository = createMemoryBusinessStateRepository(document);
  const request = prepared.executableRequest;
  const ownerExecutionDecision = { confirmed: true, authorizationId: request.sourceAuthorizationId,
    productionPlanId: request.sourceProductionPlanId, store: request.store, storeRef: request.storeRef,
    warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias, merchantSku: request.merchantSku,
    skuPackageId: request.skuPackageId, supplierSkuId: request.supplierSkuId, publishScope: request.publishScope,
    assetsFinalUploadsVersion: request.assetsFinalUploadsVersion, platformWritePrice: request.platformWritePrice,
    stock: request.stock, finalUploadAssetIds: request.finalUploads.map(asset => asset.assetId) };
  const adapterCapabilities = capabilities(request.store, plan.sourceAuthorization.lockedScope.finalUploads, request);
  adapterCapabilities.warehouseId = request.inventoryWrite.warehouseId;
  const outcome = await runPersistedDExecution({ repository, runtimeMode: "local_development",
    actor: createActorContext({ userId: "synthetic-owner", sessionId: "synthetic-session-d-scope", actorType: "human",
      roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: DE_SCOPE_OBSERVED_AT }),
    candidateId: initialCandidate.id, expectedCandidateRevision: initialCandidate.dataRevision,
    productionPlan: plan, platformWritePreflight: preflight, currentProductionBinding, adapterCapabilities,
    ownerExecutionDecision, serverClock: () => DE_SCOPE_OBSERVED_AT,
    createAdapter: ({request}) => createSyntheticDCompletionAdapter({request}) });
  if (outcome.status !== "succeeded") throw new Error(`Synthetic persisted D fixture did not succeed: ${outcome.status}`);
  return { initialCandidate, completedCandidate: (await repository.readSnapshot()).candidates[0] };
}
