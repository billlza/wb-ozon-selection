import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { commitDExecutionIntent, persistDExecutionCheckpoint, runPersistedDExecution, reconcilePersistedDExecutionOnRestart, buildDESoftwareIntegrationView } from "../lib/d-e-software-integration.mjs";
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository, initialBusinessStateDocument } from "../lib/business-state-repository.mjs";
import { createActorContext, assertSafeRuntimeRecord } from "../lib/runtime-identity.mjs";
import { preparedFixture, capabilities, exactObservation, historicalPlanFixture } from "./helpers/d-software-fixture.mjs";
import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import { assertCurrentDExecutionContext } from "../lib/platform-write-preflight.mjs";
import { createStoreIsolatedOzonSellerApiDEAdapter } from "../lib/ozon-seller-api-de-adapter.mjs";
import { projectProductionPlanInputs } from "../lib/production-plan.mjs";
import { C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS, fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";

import { assertDExecutableRequest, assertHistoricalDExecutableRequest, beginDSoftwareExecution, executeDSoftwareAttempt, runSystemCreatedEReadback } from "../lib/d-e-software-closure.mjs";

const NOW = "2026-08-22T07:30:00.000Z";
const schemaValidator = await loadPublishedSchemaValidator();
function validateSavedState(state) {
  const validate = schemaValidator.getSchema(state.schemaVersion);
  assert.ok(["d-software-execution-state-v1", "d-software-execution-state-v2"].includes(state.schemaVersion));
  const valid=validate(state);validateSavedState.errors=validate.errors;return valid;
}
async function persistenceFixture(createRepository = createMemoryBusinessStateRepository) {
  const { fixture, plan, preflight, prepared, currentProductionBinding } = await preparedFixture();
  const candidate = { id: fixture.candidateId, dataRevision: fixture.candidateRevision, lifecycleV11: { skuPackage: structuredClone(fixture.skuPackage) } };
  const document = initialBusinessStateDocument({ now: NOW }); document.candidates = [candidate];
  const memory = createRepository(document);
  const repository = { ...memory, transact: mutator => memory.transact(async document => {
    const outcome = await mutator(document);
    const state = outcome.document?.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
    if (outcome.changed && state) assert.equal(validateSavedState(state), true, JSON.stringify(validateSavedState.errors));
    return outcome;
  }) };
  const request = prepared.executableRequest;
  const ownerExecutionDecision = { confirmed: true, authorizationId: request.sourceAuthorizationId, productionPlanId: request.sourceProductionPlanId,
    store: request.store, storeRef: request.storeRef, warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias,
    merchantSku: request.merchantSku, skuPackageId: request.skuPackageId, supplierSkuId: request.supplierSkuId,
    publishScope: request.publishScope, assetsFinalUploadsVersion: request.assetsFinalUploadsVersion,
    platformWritePrice: request.platformWritePrice, stock: request.stock, finalUploadAssetIds: request.finalUploads.map(asset => asset.assetId) };
  const inputs = projectProductionPlanInputs(plan);
  const input = { repository, runtimeMode: "local_development", candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
    actor: createActorContext({ userId: "synthetic-owner", sessionId: "synthetic-authenticated-session", actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: NOW }),
    productionPlan: plan, platformWritePreflight: preflight, currentProductionBinding, adapterCapabilities: capabilities(inputs.store, inputs.finalUploads, inputs),
    ownerExecutionDecision, serverClock: () => NOW };
  return { input, candidate, request, repository };
}

async function savedCandidate(repository) { return (await repository.readSnapshot()).candidates[0]; }

async function advance(repository, candidateId, event) {
  const state = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
  return persistDExecutionCheckpoint({ repository, candidateId, executionKey: state.executionKey,
    expectedExecutionRevision: state.executionRevision, event, serverClock: () => NOW });
}

const task = { kind: "import_task_received", taskId: "501" };
function imported(request) { return { kind: "import_result_observed", taskId: "501", productId: "910001", merchantSku: request.merchantSku,
  itemCount: 1, status: "imported", errorCount: 0, requestReceiptRef: "receipt:import:501" }; }

test("atomic D admission commits one intent, preserves frozen authorization, and replays without another mutation", async () => {
  const { input, candidate, repository } = await persistenceFixture();
  const results = await Promise.all([commitDExecutionIntent(input), commitDExecutionIntent(input)]);
  assert.deepEqual(results.map(result => result.status).sort(), ["committed", "idempotent_replay"]);
  const saved = await savedCandidate(repository);
  const state = saved.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(saved.dataRevision, candidate.dataRevision + 1);
  assert.equal(state.executionRevision, 1);
  assert.equal(state.mustPersistBeforeSellerApi, true);
  assert.equal(state.canCallSellerApiBeforePersist, false);
  assert.equal(state.attemptLimit, 1);
  assert.equal(state.automaticRetry, false);
  assert.equal(state.platformWrites, 0);
  assert.equal(state.attempt.persistBeforeWrite, true);
  assert.equal(state.attempt.request.stock, 100);
  assert.equal(state.attempt.request.productImport.protocolId, "ozon-product-import-v3");
  assert.equal(Object.hasOwn(state.attempt.request.productImport, "endpoint"), false);
  assert.deepEqual(saved.lifecycleV11.skuPackage.productionAuthorization, candidate.lifecycleV11.skuPackage.productionAuthorization);
  assert.equal(saved.lifecycleV11.skuPackage.dataRevision, candidate.lifecycleV11.skuPackage.dataRevision);
  assert.equal((await repository.readSnapshot()).runtime.operationAudit.length, 1);
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitDExecutionIntent({ ...input, ownerExecutionDecision: { ...input.ownerExecutionDecision, stock: 99 } }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("D intent rejects unauthenticated owner, revision drift and unapproved protocol before commit", async () => {
  const { input, repository } = await persistenceFixture();
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitDExecutionIntent({ ...input, actor: { ...input.actor, source: "development_default" } }), /AUTHENTICATED_OWNER/);
  await assert.rejects(() => commitDExecutionIntent({ ...input, expectedCandidateRevision: input.expectedCandidateRevision + 1 }), /REVISION_CONFLICT/);
  const adapterCapabilities = structuredClone(input.adapterCapabilities); adapterCapabilities.inventoryWrite.endpoint = "/private/arbitrary";
  await assert.rejects(() => commitDExecutionIntent({ ...input, adapterCapabilities }), /PROTOCOL_REJECTED/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("current configuration drift stops D before intent persistence and adapter construction", async () => {
  const { input, repository } = await persistenceFixture();
  const before = await repository.readSnapshot(); let factories = 0;
  const current = input.currentProductionBinding;
  for (const patch of [{ bindingId: "binding:another" }, { configurationVersion: "config-v2" }, { warehouseId: "70002" },
    { warehouseRef: "warehouse:another" }, { credentialAlias: "credential-alias:another" },
    { storeRef: { ...current.storeRef, platformStoreId: "another-store" } },
    { verification: { ...current.verification, expiresAt: NOW } }]) {
    await assert.rejects(() => runPersistedDExecution({ ...input, currentProductionBinding: { ...current, ...patch },
      createAdapter: async () => { factories += 1; throw new Error("must not construct adapter"); } }), /PRODUCTION_(?:EXECUTION_BINDING_|BINDINGS_INVALID)/);
    assert.deepEqual(await repository.readSnapshot(), before);
  }
  await assert.rejects(() => runPersistedDExecution({ ...input, currentProductionBinding: null,
    createAdapter: async () => { factories += 1; throw new Error("must not construct adapter"); } }), /BINDING_REQUIRED/);
  const adapterCapabilities = structuredClone(input.adapterCapabilities); adapterCapabilities.inventoryWrite.warehouseId = "70002";
  await assert.rejects(() => runPersistedDExecution({ ...input, adapterCapabilities,
    createAdapter: async () => { factories += 1; throw new Error("must not construct adapter"); } }), /NOT_READY/);
  assert.equal(factories, 0); assert.deepEqual(await repository.readSnapshot(), before);
});

test("configuration verification expiring after D admission is a known zero-write failure, not an unknown platform outcome", async () => {
  const { input, repository } = await persistenceFixture();
  let reads = 0; let factories = 0;
  const result = await runPersistedDExecution({ ...input,
    serverClock: () => ++reads === 1 ? NOW : input.currentProductionBinding.verification.expiresAt,
    createAdapter: async () => { factories += 1; throw new Error("must not construct adapter"); } });
  assert.equal(result.status, "failed"); assert.equal(result.platformWrites, 0); assert.equal(factories, 0);
  const state = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
  assert.deepEqual(state.productionPlan.sourceAuthorization.executionBinding, input.productionPlan.sourceAuthorization.executionBinding);
  assert.equal(state.attempt.failure.code, "PRODUCTION_EXECUTION_BINDING_UNVERIFIED");
  assert.equal(state.attempt.failure.layer, "production_configuration");
  assert.equal(state.attempt.productionRecord, null); assert.deepEqual(state.checkpoints, []);
});

test("current rights expiry rejects before admission and persists a zero-write failure after admission across JSON restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "d-rights-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "business-state.json");
  const { input, repository } = await persistenceFixture(document => createJsonBusinessStateRepository({ filePath,
    initializeIfMissing: true, initialDocument: document }));
  const expiresAt = input.productionPlan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview.expiresAt;
  let factories = 0; const createAdapter = async () => { factories += 1; throw new Error("must not construct adapter"); };
  const before = await repository.readSnapshot();
  await assert.rejects(() => runPersistedDExecution({ ...input, serverClock: () => expiresAt, createAdapter }), /C1_SKU_RIGHTS_REVIEW_EXPIRED/);
  assert.deepEqual(await repository.readSnapshot(), before);
  let ticks = 0;
  const result = await runPersistedDExecution({ ...input, serverClock: () => ++ticks === 1 ? NOW : expiresAt, createAdapter });
  assert.equal(result.status, "failed"); assert.equal(result.platformWrites, 0); assert.equal(factories, 0);
  const reopened = createJsonBusinessStateRepository({ filePath });
  const candidate = await savedCandidate(reopened); const state = candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.attempt.failure.layer, "sku_rights_review"); assert.equal(state.attempt.failure.code, "C1_SKU_RIGHTS_REVIEW_EXPIRED");
  assert.equal(state.step, "intent_persisted"); assert.deepEqual(state.checkpoints, []); assert.equal(state.platformWrites, 0);
  assert.deepEqual(candidate.lifecycleV11.skuPackage.productionAuthorization, input.productionPlan.sourceAuthorization);
  assert.equal((await runPersistedDExecution({ ...input, repository: reopened, createAdapter })).status, "idempotent_replay");
  assert.equal(factories, 0); assert.deepEqual(await savedCandidate(reopened), candidate);
});

test("retired authorization cannot commit a new D intent or construct a platform adapter", async () => {
  const { input, repository } = await persistenceFixture();
  const { plan } = historicalPlanFixture();
  const before = await repository.readSnapshot(); let factories = 0;
  await assert.rejects(() => runPersistedDExecution({ ...input, productionPlan: plan,
    createAdapter: async () => { factories += 1; throw new Error("retired authorization cannot execute"); } }), /PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED/);
  assert.equal(factories, 0); assert.deepEqual(await repository.readSnapshot(), before);
});

test("exact owner decision mismatches never save an intent or permit platform execution", async () => {
  const { input, repository } = await persistenceFixture();
  const before = await repository.readSnapshot();
  const decision = input.ownerExecutionDecision;
  for (const patch of [{ confirmed: false }, { platformWritePrice: { ...decision.platformWritePrice, amount: 151 } },
    { merchantSku: decision.supplierSkuId }, { supplierSkuId: "another" }, { warehouseRef: "another" }, { credentialAlias: "another" },
    { storeRef: { ...decision.storeRef, mappingVersion: "another" } }, { stock: 99 },
    { finalUploadAssetIds: [...decision.finalUploadAssetIds].reverse() }, { publishScope: "another" },
    { authorizationId: "another" }, { productionPlanId: "another" }, { assetsFinalUploadsVersion: "another" }]) {
    await assert.rejects(() => commitDExecutionIntent({ ...input, ownerExecutionDecision: { ...decision, ...patch } }), /D_EXECUTION_OWNER_/);
    assert.deepEqual(await repository.readSnapshot(), before);
  }
  await assert.rejects(() => commitDExecutionIntent({ ...input, candidateId: "another-candidate" }), /CANDIDATE_NOT_FOUND/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("concurrent checkpoint claims grant only one import; task receipt survives later owner edits", async () => {
  const { input, repository, request } = await persistenceFixture();
  await commitDExecutionIntent(input);
  const state = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
  const claim = { repository, candidateId: input.candidateId, executionKey: state.executionKey, expectedExecutionRevision: 1,
    event: { kind: "import_intent" }, serverClock: () => NOW };
  const claims = await Promise.allSettled([persistDExecutionCheckpoint(claim), persistDExecutionCheckpoint(claim)]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  assert.match(claims.find(result => result.status === "rejected").reason.message, /REVISION_CONFLICT/);
  await repository.transact(document => {
    document.candidates[0].ownerNote = "Saved while import was in flight";
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: null };
  });
  await advance(repository, input.candidateId, task);
  await advance(repository, input.candidateId, imported(request));
  const saved = await savedCandidate(repository);
  assert.equal(saved.lifecycleV11.skuPackage.dSoftwareExecution.continuationBlocked, true);
  assert.equal(saved.lifecycleV11.skuPackage.dSoftwareExecution.checkpoints[1].taskId, "501");
  assert.equal(saved.ownerNote, "Saved while import was in flight");
  await assert.rejects(() => advance(repository, input.candidateId, { kind: "stock_intent", taskId: "501", productId: "910001",
    merchantSku: request.merchantSku, warehouseId: request.inventoryWrite.warehouseId, stock: 100 }), /CONTINUATION_BLOCKED/);
  const stopped = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(stopped.step, "import_result_observed");
  assert.equal(stopped.platformWrites, "unknown");
  assert.equal(stopped.checkpoints.some(event => event.kind === "stock_intent"), false);
});

function initialImportFactory({ repository, request, calls, factories }) {
  return async ({ executionContext }) => {
    factories.push("constructed");
    const inputs = projectProductionPlanInputs(executionContext.productionPlan);
    const adapterCapabilities = capabilities(request.store, inputs.finalUploads, inputs);
    adapterCapabilities.warehouseId = request.inventoryWrite.warehouseId;
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities, executionContext,
      requestJson: async call => {
        assert.equal(call.endpoint, "/v3/product/import");
        assert.equal((await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution.step, "import_intent");
        calls.push(call.endpoint);
        return { result: { task_id: 501 } };
      }
    });
    return { executeSellerApi: adapter.executeSellerApi,
      readbackSellerApi: async () => { throw new Error("Initial asynchronous import cannot read the final product"); } };
  };
}

// Domain persistence fault injection uses explicit synthetic DTOs. The real
// asynchronous adapter is covered by initialImportFactory and observation tests.
function syntheticCheckpointFactory({ repository, request, beforeResponse = async () => {}, failReadback = false, observationChange = {}, calls, factories }) {
  return async ({ executionContext }) => {
    factories.push("constructed");
    return createSyntheticDCompletionAdapter({ request,
      afterCheckpoint: async ({event}) => {
        const endpoint = { import_intent: "/v3/product/import", import_task_received: "/v1/product/import/info", stock_intent: "/v2/products/stocks" }[event.kind];
        if (!endpoint) return;
        if (event.kind !== "import_task_received") assertCurrentDExecutionContext({request,executionContext});
        const state = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
        assert.equal(state.step, event.kind, "checkpoint must be independently readable before the simulated response");
        calls.push(endpoint); await beforeResponse({endpoint});
      },
      readback: async () => {
        assert.equal((await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution.step, "stock_receipt_observed");
        if (failReadback) throw new Error("failed with cookie=private-value");
        return exactObservation(request, observationChange);
      }
    });
  };
}

test("a fresh committed D run persists every checkpoint and terminal record; concurrent replay constructs no adapter", async () => {
  const fixture = await persistenceFixture();
  const calls = []; const factories = [];
  const createAdapter = syntheticCheckpointFactory({ ...fixture, calls, factories });
  const results = await Promise.all([runPersistedDExecution({ ...fixture.input, createAdapter }), runPersistedDExecution({ ...fixture.input, createAdapter })]);
  assert.equal(results.filter(result => result.status === "succeeded").length, 1);
  assert.equal(results.filter(result => result.status === "idempotent_replay").length, 1);
  assert.equal(factories.length, 1);
  assert.deepEqual(calls, ["/v3/product/import", "/v1/product/import/info", "/v2/products/stocks"]);
  const saved = await savedCandidate(fixture.repository);
  const state = saved.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.executionRevision, 8);
  assert.equal(state.checkpoints.length, 6);
  assert.equal(state.platformWrites, 2);
  assert.equal(saved.lifecycleV11.skuPackage.productionRecord.platformProductId, "910001");
  assert.equal(saved.lifecycleV11.skuPackage.eVerificationRecord, null);
  assert.equal((await runPersistedDExecution({ ...fixture.input, createAdapter })).status, "idempotent_replay");
  assert.equal(factories.length, 1);
});

test("rights expiry after a durable write intent records zero only when no import was sent", async () => {
  for (const blockedStep of ["import_intent", "stock_intent"]) {
    const fixture = await persistenceFixture(); const calls = []; const factories = [];
    const backing = fixture.repository; let observedAt = NOW;
    const expiresAt = fixture.input.productionPlan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview.expiresAt;
    const repository = { ...backing, transact: async mutate => {
      let blockedBoundary = false;
      const result = await backing.transact(async document => {
        const outcome = await mutate(document);
        const state = outcome.document?.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
        blockedBoundary = outcome.changed && state?.step === blockedStep;
        return outcome;
      });
      if (blockedBoundary) observedAt = expiresAt;
      return result;
    } };
    const result = await runPersistedDExecution({ ...fixture.input, repository, serverClock: () => observedAt,
      createAdapter: (blockedStep === "import_intent" ? initialImportFactory : syntheticCheckpointFactory)({ ...fixture, calls, factories }) });
    const state = (await savedCandidate(backing)).lifecycleV11.skuPackage.dSoftwareExecution;
    assert.equal(state.step, blockedStep); assert.equal(factories.length, 1);
    if (blockedStep === "import_intent") {
      assert.equal(result.status, "failed"); assert.equal(state.platformWrites, 0); assert.deepEqual(calls, []);
    } else {
      assert.equal(result.status, "unknown_outcome"); assert.equal(state.platformWrites, "unknown");
      assert.deepEqual(calls, ["/v3/product/import", "/v1/product/import/info"]);
      assert.equal(state.checkpoints.find(event => event.kind === "import_task_received").taskId, "501");
      assert.equal(state.checkpoints.find(event => event.kind === "import_result_observed").productId, "910001");
      assert.equal(state.checkpoints.some(event => event.kind === "stock_receipt_observed"), false);
    }
    assert.equal(state.attempt.productionRecord, null);
  }
});

test("domain persists late synthetic import identities after owner edits and rejects the next stock checkpoint", async () => {
  const fixture = await persistenceFixture(); const calls = []; const factories = [];
  const createAdapter = syntheticCheckpointFactory({ ...fixture, calls, factories, beforeResponse: async call => {
    if (call.endpoint !== "/v3/product/import") return;
    await fixture.repository.transact(document => {
      document.candidates[0].ownerNote = "Owner changed input during request"; document.candidates[0].dataRevision += 1;
      return { changed: true, document, result: null };
    });
  } });
  const result = await runPersistedDExecution({ ...fixture.input, createAdapter });
  assert.equal(result.status, "unknown_outcome");
  assert.deepEqual(calls, ["/v3/product/import", "/v1/product/import/info"]);
  const state = result.candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.checkpoints.find(event => event.kind === "import_task_received").taskId, "501");
  assert.equal(state.checkpoints.find(event => event.kind === "import_result_observed").productId, "910001");
  assert.equal(state.continuationBlocked, true);
  assert.equal(result.candidate.ownerNote, "Owner changed input during request");
  assert.equal(result.candidate.lifecycleV11.skuPackage.productionRecord, null);
});

test("readback failure retains write receipts and fixed failure code without secret exception text", async () => {
  const fixture = await persistenceFixture(); const calls = []; const factories = [];
  const result = await runPersistedDExecution({ ...fixture.input, createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories, failReadback: true }) });
  assert.equal(result.status, "unknown_outcome");
  const state = result.candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.attempt.reason, "independent_readback_failed");
  assert.equal(state.attempt.platformResult.taskId, "501");
  assert.ok(state.attempt.platformResult.inventoryReceiptRef);
  assert.equal(state.checkpoints.length, 5);
  assert.equal(JSON.stringify(await fixture.repository.readSnapshot()).includes("private-value"), false);
  assert.equal(result.candidate.lifecycleV11.skuPackage.productionRecord, null);
});

test("restart projection preserves task identity and unknown write effect without changing the saved document", async () => {
  const { input, repository } = await persistenceFixture();
  await commitDExecutionIntent(input); await advance(repository, input.candidateId, { kind: "import_intent" });
  await advance(repository, input.candidateId, task);
  const before = await repository.readSnapshot();
  const state = before.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  const projection = reconcilePersistedDExecutionOnRestart({ executionState: state, restartedAt: NOW });
  assert.equal(projection.status, "unknown_outcome");
  assert.equal(projection.platformWrites, "unknown");
  assert.equal(projection.attempt.status, "unknown_outcome");
  assert.equal(projection.retryAllowed, false);
  assert.equal(projection.attempt.reason, "service_restart_after_persist_before_terminal_receipt");
  assert.equal(projection.checkpoints[1].taskId, "501");
  assert.deepEqual(await repository.readSnapshot(), before);
  const candidate = before.candidates[0];
  const passive = buildDESoftwareIntegrationView({ candidate, inspectedAt: NOW });
  assert.equal(passive.status, "execution_result_unconfirmed");
  assert.equal(passive.platformWrites, "unknown");
  assert.equal(passive.execution.taskId, "501");
  assert.equal(passive.canExecutePlatformWrite, false);
  assert.equal(buildDESoftwareIntegrationView({ candidate, inspectedAt: NOW, activeExecutionKey: "another" }).status, "execution_result_unconfirmed");
  assert.equal(buildDESoftwareIntegrationView({ candidate, inspectedAt: NOW, activeExecutionKey: state.executionKey }).status, "execution_in_progress");

});

test("a new JSON repository reads saved D receipts after restart and admission replay performs zero external calls", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "d-execution-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "business-state.json");
  const fixture = await persistenceFixture(document => createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, initialDocument: document }));
  await commitDExecutionIntent(fixture.input);
  await advance(fixture.repository, fixture.input.candidateId, { kind: "import_intent" });
  await advance(fixture.repository, fixture.input.candidateId, task);
  const savedBytes = await readFile(filePath);
  const repository = createJsonBusinessStateRepository({ filePath });
  const state = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(validateSavedState(state), true, JSON.stringify(validateSavedState.errors));
  assert.deepEqual(state.productionPlan.sourceAuthorization.executionBinding, fixture.input.productionPlan.sourceAuthorization.executionBinding);
  const projection = reconcilePersistedDExecutionOnRestart({ executionState: state, restartedAt: NOW });
  assert.equal(projection.status, "unknown_outcome");
  assert.equal(projection.checkpoints[1].taskId, "501");
  let factoryCalls = 0;
  const result = await runPersistedDExecution({ ...fixture.input, repository, createAdapter: async () => { factoryCalls += 1; throw new Error("must not execute"); } });
  assert.equal(result.status, "idempotent_replay");
  assert.equal(factoryCalls, 0);
  assert.deepEqual(await readFile(filePath), savedBytes);
  for (const edit of [value => { delete value.schemaVersion; }, value => { delete value.requestEncoding; }, value => { delete value.executionRevision; }]) {
    const incomplete = structuredClone(state); edit(incomplete);
    assert.throws(() => reconcilePersistedDExecutionOnRestart({ executionState: incomplete, restartedAt: NOW }), /D_EXECUTION_STATE_INVALID/);
  }
});

test("ordinary D transaction reads its clock after entering the serialized repository", async () => {
  const { input, repository } = await persistenceFixture();
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const blocker = repository.transact(async () => { entered.resolve(); await release.promise; return { changed: false, result: null }; });
  await entered.promise;
  let observedAt = NOW; let reads = 0;
  const admission = commitDExecutionIntent({ ...input, serverClock: () => { reads += 1; return observedAt; } });
  assert.equal(reads, 0);
  observedAt = "2026-08-22T07:35:00.000Z"; release.resolve(); await blocker;
  const result = await admission;
  assert.equal(result.candidate.lifecycleV11.skuPackage.dSoftwareExecution.attempt.startedAt, observedAt);
  assert.equal(reads, 1);
});

test("a checkpoint persistence failure stops execution and never returns a terminal success", async () => {
  const fixture = await persistenceFixture(); const calls = []; const factories = [];
  const backing = fixture.repository;
  const repository = { ...backing, transact: mutator => backing.transact(async document => {
    const outcome = await mutator(document);
    if (outcome.document?.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution?.step === "import_task_received") {
      throw new Error("disk failure includes cookie=private-value");
    }
    return outcome;
  }) };
  const createAdapter = initialImportFactory({ ...fixture, repository, calls, factories });
  await assert.rejects(() => runPersistedDExecution({ ...fixture.input, repository, createAdapter }), error => {
    assert.equal(error.code, "D_CHECKPOINT_PERSISTENCE_FAILED");
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes("private-value"), false);
    assert.equal(error.checkpoint.taskId, "501");
    return true;
  });
  assert.deepEqual(calls, ["/v3/product/import"]);
  const saved = await savedCandidate(backing);
  assert.equal(saved.lifecycleV11.skuPackage.dSoftwareExecution.step, "import_intent");
  assert.equal(saved.lifecycleV11.skuPackage.dSoftwareExecution.status, "in_flight");
  assert.equal(saved.lifecycleV11.skuPackage.productionRecord, null);
});


test("independent readback for another lifecycle cannot create a ProductionRecord", async () => {
  const fixture = await persistenceFixture(); const calls = []; const factories = [];
  const result = await runPersistedDExecution({ ...fixture.input, createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories, observationChange: { skuPackageId: "another-lifecycle" } }) });
  assert.equal(result.status, "unknown_outcome");
  assert.match(result.candidate.lifecycleV11.skuPackage.dSoftwareExecution.attempt.reason, /skuPackageId/);
  assert.equal(result.candidate.lifecycleV11.skuPackage.productionRecord, null);
  assert.equal(result.candidate.lifecycleV11.skuPackage.dSoftwareExecution.checkpoints.length, 6);
});


test("published D schema rejects old unencoded states, unknown fields and transport endpoint injection", async () => {
  const { input, repository } = await persistenceFixture();
  await commitDExecutionIntent(input);
  const state = (await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(validateSavedState(state), true);
  for (const edit of [value => { delete value.executionRevision; }, value => { delete value.requestEncoding; },
    value => { value.extra = true; }, value => { value.attempt.request.productImport.endpoint = "/v3/product/import"; },
    value => { value.checkpoints = [{ kind: "stock_intent", observedAt: NOW }]; }]) {
    const invalid = structuredClone(state); edit(invalid);
    assert.equal(validateSavedState(invalid), false);
  }
});

test("published authorization guards preserve 13 historical C1 paths and permit 10 sibling paths only in v1.2", async () => {
  const allPaths = C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths.filter(segments => segments[0] === "lockedScope");
  const historicalPaths = allPaths.filter(segments => !segments.includes("siblingFormalReuseRecord"));
  const siblingPaths = allPaths.filter(segments => segments.includes("siblingFormalReuseRecord"));
  assert.equal(historicalPaths.length, 13);
  assert.equal(siblingPaths.length, 10);
  assert.equal(allPaths.length, 23);
  const paths = historicalPaths;
  assert.equal(new Set(paths.map(segments => segments.join("."))).size, paths.length);
  assert.deepEqual({
    direct: paths.filter(segments => !segments.includes("pricingReuseRecord") && !segments.includes("editorialSource")).length,
    pricingReuse: paths.filter(segments => segments.includes("pricingReuseRecord")).length,
    editorialSource: paths.filter(segments => segments.includes("editorialSource")).length
  }, { direct: 3, pricingReuse: 6, editorialSource: 4 });
  const opaqueId = "authorization:c1-ai-draft:synthetic-fixture";
  const nested = (segments, value) => segments.reduceRight((child, field) => ({ [field]: child }), value);
  for (const [version, permittedPaths] of [["v1.1", historicalPaths], ["v1.2", allPaths]]) {
    const validateGuard = schemaValidator.getSchema(`production-authorization-${version}#/$defs/authorizationSecretGuard`);
    assert.ok(validateGuard);
    assert.equal(new Set(permittedPaths.map(segments => segments.join("."))).size, permittedPaths.length);
    for (const segments of permittedPaths) {
      assert.equal(validateGuard(nested(segments, opaqueId)), true, JSON.stringify(validateGuard.errors));
      for (const value of [`${opaqueId}\n`, `${opaqueId}\r`, `${opaqueId}\r\n`, "authorization=private-value", "https://example.test/?token=private-value", { authorizationId: opaqueId }]) {
        assert.equal(validateGuard(nested(segments, value)), false, `${version} ${segments.join(".")}: ${JSON.stringify(value)}`);
      }
      const extraSecret = nested(segments, opaqueId);
      const parent = segments.slice(0, -1).reduce((object, field) => object[field], extraSecret);
      parent.cookie = "private-value";
      assert.equal(validateGuard(extraSecret), false);
      assert.equal(validateGuard(nested(["untrusted", ...segments], opaqueId)), false);
      assert.equal(validateGuard(nested([...segments.slice(0, -2), "anotherAuthorization", "authorizationId"], opaqueId)), false);
    }
    assert.equal(validateGuard({ authorizationId: opaqueId }), false);
  }
  const validateHistorical = schemaValidator.getSchema("production-authorization-v1.1#/$defs/authorizationSecretGuard");
  for (const segments of siblingPaths) assert.equal(validateHistorical(nested(segments, opaqueId)), false);
});

test("runtime guard preserves real ProductionAuthorization and D intent C1 paths but rejects adjacent or arbitrary opaque IDs", async () => {
  const { input, repository } = await persistenceFixture();
  await commitDExecutionIntent(input);
  const candidate = await savedCandidate(repository);
  const sku = candidate.lifecycleV11.skuPackage;
  for (const value of [candidate, sku, sku.productionAuthorization, sku.dSoftwareExecution, sku.dSoftwareExecution.productionPlan]) {
    const before = structuredClone(value);
    assert.equal(assertSafeRuntimeRecord(value), value); assert.deepEqual(value, before);
    const adjacent = structuredClone(value); adjacent.authorizationId = "authorization:c1-ai-draft:synthetic-fixture";
    assert.throws(() => assertSafeRuntimeRecord(adjacent), /RUNTIME_IDENTITY_INVALID/);
    assert.throws(() => assertSafeRuntimeRecord({ body: value }), /RUNTIME_IDENTITY_INVALID/);
  }
  const paths = C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths.filter(segments => segments[0] === "lockedScope");
  for (const invalidId of ["authorization:c1-ai-draft:fixture:extra", "authorization:c1-ai-draft:fixture\n", "authorization=private-value"]) {
    for (const prefix of [["productionAuthorization"], ["dSoftwareExecution", "productionPlan", "sourceAuthorization"]]) {
      for (const declaredPath of paths) {
        const malformed = structuredClone(candidate);
        const segments = ["lifecycleV11", "skuPackage", ...prefix, ...declaredPath];
        // Paths under a pricingReuseRecord do not exist on this fixture; the guard must reject a malformed id wherever the path is declared.
        const parent = segments.slice(0, -1).reduce((entry, key) => (entry[key] ??= {}), malformed);
        parent[segments.at(-1)] = invalidId;
        assert.throws(() => assertSafeRuntimeRecord(malformed), /RUNTIME_IDENTITY_INVALID/);
      }
    }
  }
});

test("unsafe platform observation is rejected without disguising it as disk failure or saving secret text", async () => {
  const fixture = await persistenceFixture(); const calls = []; const factories = [];
  const result = await runPersistedDExecution({ ...fixture.input,
    createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories, observationChange: { errors: [{ cookie: "private-value" }] } }) });
  assert.equal(result.status, "unknown_outcome");
  const state = result.candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.attempt.reason, "platform_observation_rejected");
  assert.equal(state.checkpoints.length, 5);
  assert.equal(state.checkpoints.find(event => event.kind === "import_task_received").taskId, "501");
  assert.ok(state.checkpoints.find(event => event.kind === "stock_receipt_observed").inventoryReceiptRef);
  assert.equal(JSON.stringify(await fixture.repository.readSnapshot()).includes("private-value"), false);
  assert.equal(result.candidate.lifecycleV11.skuPackage.productionRecord, null);
});

test("unknown warehouse or media quantity is durably retained with write receipts and never becomes a successful D record", async () => {
  for (const observationChange of [
    { currentStock: "unknown", inventoryObservation: { sourceProtocol: "ozon-product-stocks-v4", rows: [{ warehouseId: "unknown", type: "rfbs", present: 100, reserved: 0 }] } },
    { currentStock: 0, inventoryObservation: { sourceProtocol: "ozon-product-stocks-v4", rows: [
      { warehouseId: "70001", type: "rfbs", present: 0, reserved: 0 }, { warehouseId: "70002", type: "rfbs", present: 100, reserved: 0 }
    ] } },
    { imageCount: "unknown", mediaObservation: { sourceProtocol: "ozon-product-attributes-v4", primaryImageUrl: "unknown", images: "unknown" } }
  ]) {
    const fixture = await persistenceFixture(); const calls = []; const factories = [];
    const result = await runPersistedDExecution({ ...fixture.input,
      createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories, observationChange }) });
    assert.equal(result.status, "unknown_outcome");
    const sku = (await savedCandidate(fixture.repository)).lifecycleV11.skuPackage;
    assert.equal(sku.productionRecord, null);
    assert.equal(sku.dSoftwareExecution.step, "independent_readback_observed");
    assert.match(sku.dSoftwareExecution.attempt.reason, /^write_readback_mismatch:/);
    assert.ok(sku.dSoftwareExecution.checkpoints.find(event => event.kind === "stock_receipt_observed").inventoryReceiptRef);
    for (const [field, value] of Object.entries(observationChange)) {
      assert.deepEqual(sku.dSoftwareExecution.checkpoints.at(-1).observation[field], value);
    }
    const replay = await runPersistedDExecution({ ...fixture.input, createAdapter: async () => { throw new Error("unknown outcome cannot repeat writes"); } });
    assert.equal(replay.status, "idempotent_replay"); assert.equal(calls.length, 3);
  }
});

test("D accepts known CDN media quantity while E leaves unmapped media identity unverified", async () => {
  const fixture = await persistenceFixture(); const calls = []; const factories = [];
  const mediaObservation = { sourceProtocol: "ozon-product-attributes-v4", primaryImageUrl: "https://cdn.ozon/main.png",
    images: ["https://cdn.ozon/detail.png"] };
  const result = await runPersistedDExecution({ ...fixture.input,
    createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories, observationChange: { mediaObservation } }) });
  assert.equal(result.status, "succeeded");
  const sku = (await savedCandidate(fixture.repository)).lifecycleV11.skuPackage;
  assert.equal(sku.dSoftwareExecution.status, "succeeded");
  assert.equal(sku.dSoftwareExecution.step, "independent_readback_observed");
  assert.deepEqual(sku.dSoftwareExecution.checkpoints.at(-1).observation.mediaObservation, mediaObservation);
  assert.ok(sku.dSoftwareExecution.checkpoints.find(event => event.kind === "stock_receipt_observed").inventoryReceiptRef);
  assert.ok(sku.productionRecord);
  assert.deepEqual(calls, ["/v3/product/import", "/v1/product/import/info", "/v2/products/stocks"]);
  assert.equal(factories.length, 1);

  let eReads = 0;
  const eObservation = { ...sku.dSoftwareExecution.checkpoints.at(-1).observation,
    moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" };
  const e = await runSystemCreatedEReadback({ productionRecord: sku.productionRecord,
    readPlatform: async () => { eReads += 1; return eObservation; },
    verifiedAt: "2026-08-22T08:00:00.000Z" });
  assert.equal(eReads, 1);
  assert.equal(e.status, "not_verified");
  assert.equal(e.eVerificationRecord, null);
  assert.deepEqual(e.gaps, ["media_identity_unverified"]);
  assert.equal((await runPersistedDExecution({ ...fixture.input,
    createAdapter: async () => { throw new Error("successful D cannot repeat writes"); } })).status, "idempotent_replay");
  assert.equal(calls.length, 3);
});

test("admission, replay read and terminal persistence failures expose only safe context and retain durable receipts", async () => {
  for (const stage of ["admission", "replay_read", "terminal"]) {
    const fixture = await persistenceFixture(); const calls = []; const factories = [];
    if (stage === "replay_read") await commitDExecutionIntent(fixture.input);
    const original = fixture.repository;
    const failure = Object.assign(new Error("EIO with cookie=private-value"), {
      code: "ATOMIC_JSON_DURABILITY_UNCONFIRMED", replaced: true, targetFile: "/private/local/state.json",
      cause: new Error("token=private-value")
    });
    const repository = { ...original,
      readSnapshot: async () => { if (stage === "replay_read") throw failure; return original.readSnapshot(); },
      transact: mutator => original.transact(async document => {
        const result = await mutator(document);
        const state = result.document?.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
        if (result.changed && ((stage === "admission" && state?.step === "intent_persisted") || (stage === "terminal" && state?.status === "succeeded"))) throw failure;
        return result;
      })
    };
    await assert.rejects(() => runPersistedDExecution({ ...fixture.input, repository,
      createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories }) }), error => {
      assert.equal(error.code, "D_EXECUTION_PERSISTENCE_FAILED");
      assert.equal(error.persistenceStage, stage);
      assert.equal(error.replacementState, "replacement_written_durability_unconfirmed");
      assert.equal(error.cause, undefined);
      assert.equal(error.targetFile, undefined);
      assert.equal(`${error.message}${JSON.stringify(error)}`.includes("private-value"), false);
      return true;
    });
    assert.equal(calls.length, stage === "terminal" ? 3 : 0);
    const saved = await savedCandidate(original);
    assert.equal(saved.lifecycleV11.skuPackage.productionRecord, null);
    if (stage === "terminal") {
      const state = saved.lifecycleV11.skuPackage.dSoftwareExecution;
      assert.equal(state.status, "in_flight");
      assert.equal(state.checkpoints.length, 6);
      assert.equal(state.checkpoints[1].taskId, "501");
      assert.ok(state.checkpoints[4].inventoryReceiptRef);
      assert.equal((await runPersistedDExecution({ ...fixture.input, createAdapter: async () => { throw new Error("must not repeat writes"); } })).status, "idempotent_replay");
    }
  }
});

test("durability uncertainty after replacement preserves saved states and never grants a second execution", async () => {
  for (const stage of ["admission", "checkpoint", "terminal"]) {
    const fixture = await persistenceFixture(); const calls = []; const factories = [];
    const backing = fixture.repository;
    const repository = { ...backing, transact: async mutator => {
      let replaced = false;
      const result = await backing.transact(async document => {
        const outcome = await mutator(document);
        const state = outcome.document?.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
        replaced = outcome.changed && (stage === "admission" ? state?.step === "intent_persisted"
          : stage === "checkpoint" ? state?.step === "import_task_received" : state?.status === "succeeded");
        return outcome;
      });
      if (replaced) throw Object.assign(new Error("durability failure with cookie=synthetic-private-value"), {
        code: "ATOMIC_JSON_DURABILITY_UNCONFIRMED", replaced: true, cause: new Error("synthetic-private-value") });
      return result;
    } };
    await assert.rejects(() => runPersistedDExecution({ ...fixture.input, repository,
      createAdapter: syntheticCheckpointFactory({ ...fixture, calls, factories }) }), error => {
      assert.equal(error.code, stage === "checkpoint" ? "D_CHECKPOINT_PERSISTENCE_FAILED" : "D_EXECUTION_PERSISTENCE_FAILED");
      assert.equal(error.persistenceStage, stage);
      assert.equal(error.replacementState, "replacement_written_durability_unconfirmed");
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes("synthetic-private-value"), false);
      return true;
    });
    const saved = await savedCandidate(backing);
    const state = saved.lifecycleV11.skuPackage.dSoftwareExecution;
    assert.equal(state.step, stage === "admission" ? "intent_persisted" : stage === "checkpoint" ? "import_task_received" : "independent_readback_observed");
    assert.equal(calls.length, stage === "admission" ? 0 : stage === "checkpoint" ? 1 : 3);
    if (stage !== "admission") assert.equal(state.checkpoints[1].taskId, "501");
    assert.equal(Boolean(saved.lifecycleV11.skuPackage.productionRecord), stage === "terminal");
    const replay = await runPersistedDExecution({ ...fixture.input, createAdapter: async () => { throw new Error("must not construct another adapter"); } });
    assert.equal(replay.status, "idempotent_replay");
    assert.deepEqual(await savedCandidate(backing), saved);
  }
});


// Build a synthetic archived v1 document before opening the new runtime. This is not a migration path.
function archivedV1Document(source){
 const document=structuredClone(source),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 state.schemaVersion="d-software-execution-state-v1";state.attempt.schemaVersion="d-software-execution-v1";
 delete state.attempt.request.executionProtocolVersion;
 const request=structuredClone(state.attempt.request),previousKey=state.executionKey;
 request.productImport.endpoint="/v3/product/import";delete request.productImport.protocolId;
 request.inventoryWrite.endpoint="/v2/products/stocks";delete request.inventoryWrite.protocolId;
 request.independentReadback.expectation.schemaVersion="production-readback-expectation-v1";
 request.independentReadback.expectation.stockBasis="present_minus_reserved";
 const {executionKey:_key,idempotencyKey:_idem,...requestCore}=request;
 const key=`d-execution:${fingerprintCanonicalRecord({sourceAuthorizationFingerprint:request.sourceAuthorizationFingerprint,
  sourceProductionPlanFingerprint:request.sourceProductionPlanFingerprint,requestCore})}`;
 request.executionKey=key;request.idempotencyKey=key;
 assertHistoricalDExecutableRequest(request);
 const replaceKeys=value=>{
  if(value===previousKey)return key;
  if(Array.isArray(value))return value.map(replaceKeys);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([field,item])=>[field,replaceKeys(item)]));
  return value;
 };
 const legacy=replaceKeys(document),saved=legacy.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 saved.attempt.request.independentReadback.expectation=structuredClone(request.independentReadback.expectation);
 saved.attempt.attemptId=`d-attempt:${fingerprintCanonicalRecord({executionKey:key})}`;
 return {document:legacy,request};
}

test("archived v1 request survives cold restart and idempotent reads byte-for-byte but cannot execute",async t=>{
 const fixture=await persistenceFixture();await commitDExecutionIntent(fixture.input);
 await advance(fixture.repository,fixture.input.candidateId,{kind:"import_intent"});await advance(fixture.repository,fixture.input.candidateId,task);
 const archived=archivedV1Document(await fixture.repository.readSnapshot());
 const directory=await mkdtemp(path.join(os.tmpdir(),"d-archived-v1-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const filePath=path.join(directory,"state.json");await writeFile(filePath,JSON.stringify(archived.document));
 const bytes=await readFile(filePath),repository=createJsonBusinessStateRepository({filePath});
 const state=(await savedCandidate(repository)).lifecycleV11.skuPackage.dSoftwareExecution;
 const originalKey=state.executionKey,originalRequest=JSON.stringify(state.attempt.request);
 const projection=reconcilePersistedDExecutionOnRestart({executionState:state,restartedAt:NOW});
 assert.equal(projection.status,"unknown_outcome");assert.equal(projection.platformWrites,"unknown");assert.equal(projection.attempt.status,"unknown_outcome");
 assert.equal(projection.executionKey,originalKey);assert.equal(JSON.stringify(projection.attempt.request),originalRequest);assert.equal(projection.checkpoints[1].taskId,"501");
 let requests=0;const replay=await runPersistedDExecution({...fixture.input,repository,createAdapter:async()=>{requests++;throw new Error("must not run");}});
 assert.equal(replay.status,"idempotent_replay");assert.equal(requests,0);assert.deepEqual(await readFile(filePath),bytes);
 assert.throws(()=>assertDExecutableRequest(archived.request),/D_EXECUTABLE_REQUEST_INVALID/);
 assert.throws(()=>beginDSoftwareExecution({preparedExecution:{schemaVersion:"d-software-execution-v1",status:"ready",executableRequest:archived.request},startedAt:NOW}),/D_SOFTWARE_NOT_READY/);
 await assert.rejects(()=>executeDSoftwareAttempt({executionAttempt:{...state.attempt,request:archived.request},executionContext:{},
  executeSellerApi:async()=>{requests++;},readbackSellerApi:async()=>{requests++;},completedAt:NOW}),/D_SOFTWARE_ATTEMPT_STATE_REJECTED/);
 assert.equal(requests,0);
});

test("historical decoding rejects retagged, changed media or changed warehouse even with internally recomputed request keys",async()=>{
 const fixture=await persistenceFixture();await commitDExecutionIntent(fixture.input);
 const {document,request}=archivedV1Document(await fixture.repository.readSnapshot());
 for(const edit of [value=>{value.independentReadback.expectation.schemaVersion="production-readback-expectation-v2";},
  value=>{value.independentReadback.expectation.media[0].submittedUrl="https://other.example/changed.png";},
  value=>{value.independentReadback.expectation.warehouseId="70002";}]){
  const changed=structuredClone(request);edit(changed);
  const {executionKey:_key,idempotencyKey:_idem,...requestCore}=changed;
  changed.executionKey=`d-execution:${fingerprintCanonicalRecord({sourceAuthorizationFingerprint:changed.sourceAuthorizationFingerprint,
   sourceProductionPlanFingerprint:changed.sourceProductionPlanFingerprint,requestCore})}`;changed.idempotencyKey=changed.executionKey;
  assert.throws(()=>assertHistoricalDExecutableRequest(changed),/D_EXECUTABLE_REQUEST_INVALID/);
  const state=structuredClone(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution);
  state.attempt.request.independentReadback.expectation=structuredClone(changed.independentReadback.expectation);
  assert.throws(()=>reconcilePersistedDExecutionOnRestart({executionState:state,restartedAt:NOW}),/D_EXECUTABLE_REQUEST_INVALID/);
 }
});
