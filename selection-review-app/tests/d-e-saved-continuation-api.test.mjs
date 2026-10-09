import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import test from "node:test";
import assert from "node:assert/strict";
// The shared isolated fixture starts the real server.mjs with a temporary owner and business store.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { productionOwnerDecisionHttpFixture, startSavedDEApi, confirmCurrentProduction } from "./helpers/d-e-saved-api-fixture.mjs";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";

const { api: port } = allocatedTestPorts();

test("saved continuation requires authenticated owner, closed current input, exact job and available service without modifying queued work", async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), "saved-de-continuation-http-"));
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding });
  await api.authenticate();
  const confirmed = await confirmCurrentProduction(api, fixture);
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.response.body));
  const saved = await api.readDocument(), candidate = saved.candidates[0], job = saved.runtime.softwareJobs[0];
  assert.equal(job.status, "queued"); assert.equal(job.attempt, 0);
  const bytes = await api.readBytes(), route = `/api/candidates/${candidate.id}/lifecycle/d-e/continue-saved`;
  const input = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, jobId: job.jobId };
  const unauthenticated = await api.post(route, input, { authenticated: false,
    headers: { "x-user-id": "synthetic-owner", "x-session-id": "synthetic-session" } });
  assert.equal(unauthenticated.status, 401);
  for (const [invalid, status] of [
    [{ ...input, confirmed: true }, 400], [{ ...input, ownerDecision: { confirmed: true } }, 400],
    [{ candidateId: input.candidateId, expectedRevision: input.expectedRevision }, 400],
    [{ ...input, candidateId: "candidate:different" }, 400], [{ ...input, expectedRevision: 1.5 }, 400],
    [{ ...input, expectedRevision: input.expectedRevision + 1 }, 409], [{ ...input, expectedRevision: input.expectedRevision - 1 }, 409],
    [{ ...input, jobId: "d-production-job:another-saved-job" }, 409]
  ]) {
    const rejected = await api.post(route, invalid);
    assert.equal(rejected.status, status, JSON.stringify(rejected.body)); assert.deepEqual(await api.readBytes(), bytes);
  }
  const crossSite = await api.post(route, input, { headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  for (const result of await Promise.all([api.post(route, input), api.post(route, input)])) {
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(typeof result.body.message, "string"); assert.ok(result.body.message.length > 0);
  }
  const legacyOss = await api.post(`/api/candidates/${candidate.id}/lifecycle/d/asset-transport`, {
    dataRevision: candidate.dataRevision, confirmed: true, authorizationId: candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId,
    finalUploadAssetIds: candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope.finalUploads.map(asset => asset.assetId) });
  assert.equal(legacyOss.status, 409); assert.match(legacyOss.body.message, /已保存/);
  assert.deepEqual(await api.readBytes(), bytes);
  const view = (await api.get("/api/state")).body.candidates.find(value => value.id === candidate.id).dESavedJobRuntimeView;
  assert.equal(view.d.jobId, job.jobId); assert.equal(view.d.status, "queued"); assert.equal(view.canContinueSaved, false);
  assert.equal(view.d.configurationBlockReason, "DE_SERVICE_REQUIRED"); assert.equal(view.d.externalRequestState, "not_sent");
  assert.equal(view.currentVerified, false); assert.deepEqual(await api.readBytes(), bytes); await api.assertClean();
});

test("the old OSS endpoint also rejects a persisted D job when its candidate handoff reference is missing", async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  await commitSingleOwnerProductionAuthorization(fixture.owner.args);
  const document = await fixture.owner.repository.readSnapshot(), candidate = document.candidates[0];
  assert.equal(document.runtime.softwareJobs.length, 1);
  // Explicit lost-reference corruption: the real saved job remains authoritative and cannot be bypassed by the old endpoint.
  delete candidate.lifecycleV11.skuPackage.dHandoff;
  const directory = await mkdtemp(path.join(tmpdir(), "saved-de-lost-ref-http-"));
  const api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); await api.authenticate();
  const bytes = await api.readBytes();
  const response = await api.post(`/api/candidates/${candidate.id}/lifecycle/d/asset-transport`, {
    dataRevision: candidate.dataRevision, confirmed: true, authorizationId: candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId,
    finalUploadAssetIds: candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope.finalUploads.map(asset => asset.assetId) });
  assert.equal(response.status, 409, JSON.stringify(response.body)); assert.match(response.body.message, /已保存/);
  assert.deepEqual(await api.readBytes(), bytes); await api.assertClean();
});

test("domain-produced synthetic D completion leaves one queued E job; old owner E and unconfigured saved continuation preserve its source and history across restart", async t => {
  const d = await savedDProductionJobFixture();
  const syntheticCheckpoints=[];
  const completed = await runPersistedDExecution({...d.input,createAdapter:({request})=>createSyntheticDCompletionAdapter({request,
    afterCheckpoint:({event})=>{syntheticCheckpoints.push(event.kind);}
  })});
  assert.equal(completed.status,"succeeded");assert.deepEqual(d.calls,[]);
  assert.deepEqual(syntheticCheckpoints,['import_intent','import_task_received','import_result_observed','stock_intent','stock_receipt_observed']);
  const document = await d.repository.readSnapshot(), candidate = document.candidates[0], sku = candidate.lifecycleV11.skuPackage;
  const jobs = document.runtime.softwareJobs.filter(job => job.jobType === "e_independent_readback");
  assert.equal(jobs.length, 1); const job = jobs[0]; assert.equal(job.status, "queued");
  const directory = await mkdtemp(path.join(tmpdir(), "saved-e-continuation-http-"));
  const api = await startSavedDEApi(t, { directory, port, document, binding: d.currentProductionBinding }); await api.authenticate();
  const bytes = await api.readBytes();
  const oldRoute = `/api/candidates/${candidate.id}/lifecycle/e-readback`;
  const oldInput = { dataRevision: candidate.dataRevision, path: "system_created", sourceRecordId: sku.productionRecord.productionRecordId };
  const old = await api.post(oldRoute, oldInput);
  assert.equal(old.status, 409, JSON.stringify(old.body)); assert.match(old.body.message, /保存的生产或核验任务/);
  const continuation = await api.post(`/api/candidates/${candidate.id}/lifecycle/d-e/continue-saved`, {
    candidateId: candidate.id, expectedRevision: candidate.dataRevision, jobId: job.jobId });
  assert.equal(continuation.status, 409, JSON.stringify(continuation.body)); assert.deepEqual(await api.readBytes(), bytes);
  const state = (await api.get("/api/state")).body.candidates.find(value => value.id === candidate.id);
  assert.equal(state.dESavedJobRuntimeView.e.jobId, job.jobId); assert.equal(state.dESavedJobRuntimeView.e.status, "queued");
  assert.equal(state.dESavedJobRuntimeView.e.externalRequestState, "not_sent"); assert.equal(state.dESavedJobRuntimeView.canContinueSaved, false);
  assert.equal(state.dESavedJobRuntimeView.currentVerified, false);
  assert.deepEqual(state.lifecycleV11.skuPackage.readbackHistory, sku.readbackHistory);
  assert.deepEqual(state.lifecycleV11.skuPackage.productionRecord, sku.productionRecord);
  await api.restart(); await api.authenticate("login");
  assert.equal((await api.post(oldRoute, oldInput)).status, 409);
  assert.deepEqual(await api.readBytes(), bytes); assert.deepEqual(d.calls,[]);assert.equal(syntheticCheckpoints.length,5);await api.assertClean();
});
