import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from "node:test";
import assert from "node:assert/strict";
// The shared isolated fixture starts the real server.mjs with a temporary owner and business store.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { productionOwnerDecisionHttpFixture, startSavedDEApi, confirmCurrentProduction } from "./helpers/d-e-saved-api-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";

const { api: port } = allocatedTestPorts();
const published = await loadPublishedSchemaValidator();
const validateSku = published.getSchema("product-lifecycle-v1.1"), validateJob = published.getSchema("software-job-v1.schema.json");

test("final-plan revision requires owner identity before revealing dictionary read state", async t => {
  const responses = [];
  for (const unsettled of [false, true]) {
    await t.test(unsettled ? "unsettled read" : "ordinary state", async child => {
      const fixture = await productionOwnerDecisionHttpFixture();
      if (unsettled) fixture.candidate.lifecycleV11.c1ColorDictionaryReadsV1 = { "10096": {
        schemaVersion: "c1-color-dictionary-read-v1", status: "request_sent",
        authorizationId: "synthetic:sent", externalRequestRef: "synthetic:sent:request"
      } };
      const directory = await mkdtemp(path.join(tmpdir(), "final-plan-owner-http-"));
      const api = await startSavedDEApi(child, { directory, port, document: fixture.document,
        binding: fixture.binding, services: [], identityProvider: "development_default" });
      const before = await api.readBytes();
      const input = { candidateId: fixture.candidate.id,
        skuPackageId: fixture.candidate.lifecycleV11.skuPackage.skuPackageId,
        dataRevision: fixture.candidate.dataRevision };
      const response = await api.post(`/api/candidates/${encodeURIComponent(input.candidateId)}/lifecycle/c1/revise-final-plan`,
        input, { authenticated: false });
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.code, "C1_FINAL_REVISION_OWNER_REQUIRED");
      assert.equal(response.body.externalRequests, 0);
      assert.equal(response.body.paidCalls, 0);
      assert.equal(response.body.platformWrites, 0);
      assert.deepEqual(await api.readBytes(), before);
      assert.equal(api.dependencyRequests(), 0);
      assert.equal(api.dictionaryRequests(), 0);
      responses.push(response.body);
      await api.assertClean();
    });
  }
  assert.deepEqual(responses[0], responses[1]);
});

test("new final-plan preparation reports missing local OCR without changing business state or authorizing production", async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), "final-plan-prepare-http-"));
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding, services: [] });
  await api.authenticate();
  const before = await api.readBytes();
  const input = { candidateId: fixture.candidate.id, skuPackageId: fixture.candidate.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: fixture.candidate.dataRevision };
  const route = `/api/candidates/${encodeURIComponent(input.candidateId)}/lifecycle/c1/revise-final-plan`;
  const response = await api.post(route, input);
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.code, "C1_IMAGE_TEXT_SERVICE_UNAVAILABLE");
  assert.equal(response.body.paidCalls, 0);
  assert.equal(response.body.platformWrites, 0);
  assert.deepEqual(await api.readBytes(), before);
  const stale = await api.post(route, { ...input, dataRevision: input.dataRevision + 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await api.readBytes(), before);
  await api.assertClean();
});

for (const missing of ["service", "transport"]) {
  test(`one authenticated PA confirmation persists its unique queued D job when ${missing} is missing`, async t => {
    const withService = missing !== "service";
    const fixture = await productionOwnerDecisionHttpFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "saved-pa-http-"));
    const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding,
      services: withService ? [fixture.service] : [] });
    const sourceBytes = await api.readBytes(), owner = await api.authenticate();
    assert.deepEqual(await api.readBytes(), sourceBytes, "authentication cannot create authorization or work");
    const { input, route, response } = await confirmCurrentProduction(api, fixture);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, "committed"); assert.equal(response.body.executionStatus, "not_configured");
    assert.equal(response.body.softwareJobCreated, true); assert.equal(response.body.dHandoff.schemaVersion, "c2-d-handoff-v2");
    const handoffRef = response.body.dHandoff.softwareJobRef;
    assert.deepEqual(response.body.softwareJobRef, { jobId: handoffRef.jobId, jobType: handoffRef.jobType,
      candidateId: handoffRef.candidateId, skuPackageId: handoffRef.skuPackageId, revision: handoffRef.resultRevision });
    assert.equal(response.body.executionIntentCreated, false); assert.equal(response.body.productionPlanCreated, false);
    assert.equal(response.body.externalRequests, 0); assert.equal(response.body.platformWrites, 0);
    const bytes = await api.readBytes(), document = await api.readDocument(), candidate = document.candidates[0], sku = candidate.lifecycleV11.skuPackage;
    assert.equal(document.runtime.softwareJobs.length, 1);
    const job = document.runtime.softwareJobs[0];
    assert.equal(job.jobId, response.body.softwareJobRef.jobId); assert.equal(job.jobType, "d_production_execution");
    assert.equal(job.status, "queued"); assert.equal(job.attempt, 0); assert.equal(job.externalRequestState, "not_sent");
    assert.equal(job.workerId, null); assert.equal(job.leaseId, null); assert.equal(job.resultEnvelope, null);
    assert.equal(job.revision, candidate.dataRevision); assert.equal(candidate.dataRevision, fixture.candidate.dataRevision + 1);
    assert.equal(sku.dHandoff.softwareJobCreated, true); assert.deepEqual(sku.dHandoff.softwareJobRef, handoffRef);
    assert.equal(handoffRef.sourceRevision, fixture.candidate.dataRevision); assert.equal(handoffRef.resultRevision, job.revision);
    assert.equal(handoffRef.inputFingerprint, job.scopeBinding.authorizationFingerprint);
    assert.equal(sku.productionAuthorization.authorizedByActorId, owner.userId);
    assert.equal(sku.productionAuthorization.schemaVersion, "production-authorization-v1.2");
    assert.deepEqual(sku.productionAuthorization.executionBinding, fixture.owner.commercialDecision.executionBinding);
    assert.deepEqual(sku.profitModels, fixture.candidate.lifecycleV11.skuPackage.profitModels);
    assert.equal(sku.productionRecord, null); assert.equal(sku.eVerificationRecord, null);
    assert.equal(Object.hasOwn(sku, "dSoftwareExecution"), false); assert.equal(Object.hasOwn(sku, "dAssetTransport"), false);
    assert.equal(validateSku(sku), true, JSON.stringify(validateSku.errors)); assert.equal(validateJob(job), true, JSON.stringify(validateJob.errors));
    assert.deepEqual(document.dispatches, []);
    const state = await api.get("/api/state"); assert.equal(state.status, 200);
    const view = state.body.candidates.find(item => item.id === candidate.id).dESavedJobRuntimeView;
    assert.equal(view.schemaVersion, "d-e-saved-job-runtime-view-v1"); assert.equal(view.status, "queued");
    assert.equal(view.d.jobId, job.jobId); assert.equal(view.d.jobRevision, job.revision); assert.equal(view.d.status, "queued");
    assert.equal(view.d.externalRequestState, "not_sent"); assert.equal(view.e, null);
    assert.equal(view.canContinueSaved, false); assert.equal(view.d.canContinueSaved, false);
    assert.equal(view.currentVerified, false); assert.equal(view.platformHealth, "not_checked"); assert.equal(view.automaticRetryAllowed, false);
    const reason = withService ? "DE_TRANSPORT_REQUIRED" : "DE_SERVICE_REQUIRED";
    assert.ok(view.d.blockers.some(blocker => blocker.code === reason), JSON.stringify(view.d.blockers));
    if (!withService) assert.equal(view.d.configurationBlockReason, reason);
    assert.deepEqual(response.body.candidate.dESavedJobRuntimeView, view);
    for (const replay of await Promise.all([api.post(route, input), api.post(route, input)])) {
      assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.status, "idempotent_replay");
      assert.equal(replay.body.softwareJobCreated, true); assert.equal(replay.body.executionStatus, "not_started");
      assert.deepEqual(replay.body.softwareJobRef, response.body.softwareJobRef);
    }
    assert.deepEqual(await api.readBytes(), bytes, "repeated confirmation cannot enqueue or claim a second job");
    await api.restart();
    assert.equal((await api.get("/api/owner-access")).body.status, "login_required");
    const afterRestart = await api.get("/api/state");
    assert.deepEqual(afterRestart.body.candidates.find(item => item.id === candidate.id).dESavedJobRuntimeView, view);
    assert.deepEqual(await api.readBytes(), bytes);
    assert.equal((await api.authenticate("login")).userId, owner.userId);
    const replay = await api.post(route, input);
    assert.equal(replay.status, 200); assert.equal(replay.body.status, "idempotent_replay"); assert.equal(replay.body.executionStatus, "not_started");
    assert.deepEqual(await api.readBytes(), bytes); await api.assertClean();
  });
}

test("configured providers preserve the queued D job while awaiting explicit account read permission", async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), "saved-pa-preflight-http-"));
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding,
    services: [fixture.service],
    credentialBindings: [{ credentialAlias: fixture.binding.credentialAlias, clientId: "700123",
      keychainService: "synthetic-de-http", keychainAccount: "synthetic-seller-key" }],
    ossConfiguration: { region: "oss-cn-beijing", endpoint: "https://oss-cn-beijing.aliyuncs.com",
      bucket: "synthetic-http-assets", publicBaseUrl: "https://synthetic-http-assets.oss-cn-beijing.aliyuncs.com",
      objectPrefix: "synthetic-final/", keychainService: "synthetic-de-oss",
      keychainAccounts: { accessKeyId: "synthetic-id-account", accessKeySecret: "synthetic-secret-account" } } });
  const sourceBytes = await api.readBytes(); await api.authenticate();
  assert.deepEqual(await api.readBytes(), sourceBytes);
  const { input, route, response } = await confirmCurrentProduction(api, fixture);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, "committed"); assert.equal(response.body.executionStatus, "awaiting_account_read");
  assert.equal(response.body.softwareJobCreated, true); assert.equal(response.body.productionPlanCreated, false);
  assert.equal(response.body.executionIntentCreated, false); assert.equal(response.body.externalRequests, 0);
  assert.equal(response.body.platformWrites, 0);
  const document = await api.readDocument(), candidate = document.candidates[0], sku = candidate.lifecycleV11.skuPackage;
  assert.equal(document.runtime.softwareJobs.length, 1);
  const job = document.runtime.softwareJobs[0];
  assert.equal(job.status, "queued"); assert.equal(job.attempt, 0);
  assert.equal(job.externalRequestState, "not_sent"); assert.equal(job.externalRequestRef, null);
  assert.equal(job.workerId, null); assert.equal(job.leaseId, null);
  assert.equal(job.preparationEvidence, undefined);
  assert.equal(sku.productionRecord, null); assert.equal(sku.eVerificationRecord, null);
  assert.equal(Object.hasOwn(sku, "dAssetTransport"), false); assert.equal(Object.hasOwn(sku, "dSoftwareExecution"), false);
  assert.deepEqual(sku.profitModels, fixture.candidate.lifecycleV11.skuPackage.profitModels);
  assert.equal(validateSku(sku), true, JSON.stringify(validateSku.errors)); assert.equal(validateJob(job), true, JSON.stringify(validateJob.errors));
  const bytes = await api.readBytes(), state = await api.get("/api/state");
  const view = state.body.candidates.find(item => item.id === candidate.id).dESavedJobRuntimeView;
  assert.equal(view.d.status, "queued"); assert.equal(view.d.externalRequestState, "not_sent");
  assert.ok(view.d.blockers.some(item => item.code === "OZON_ACCOUNT_EVIDENCE_REQUIRED" && item.message.includes("账户只读核验")));
  assert.equal(view.canContinueSaved, false); assert.equal(view.currentVerified, false);
  assert.equal(view.platformHealth, "not_checked"); assert.equal(view.automaticRetryAllowed, false);
  for (const replay of await Promise.all([api.post(route, input), api.post(route, input)])) {
    assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.status, "idempotent_replay");
    assert.equal(replay.body.executionStatus, "not_started"); assert.equal(replay.body.softwareJobRef.jobId, job.jobId);
  }
  assert.deepEqual(await api.readBytes(), bytes);
  await api.restart(); await api.authenticate("login");
  assert.deepEqual((await api.get("/api/state")).body.candidates.find(item => item.id === candidate.id).dESavedJobRuntimeView, view);
  const replay = await api.post(route, input); assert.equal(replay.status, 200);
  assert.equal(replay.body.status, "idempotent_replay"); assert.deepEqual(await api.readBytes(), bytes);
  await api.assertClean();
});
