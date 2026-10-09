import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createSavedLocalPreparationCandidate } from "./fixtures/c1-local-draft-source-fixture.mjs";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { c1DraftPaidReceipt } from "./fixtures/c1-draft-source-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createC1DraftSoftwareUseCase } from "../lib/c1-draft-software-use-case.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { C1AiGatewayError, buildC1GatewayJob, C1_GATEWAY_SOURCE_BINDING_VERSION } from "../lib/c1-ai-gateway.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if (![port, gatewayPort].every(value => Number.isSafeInteger(value) && value > 0 && ![4317, 4318, 4173].includes(value)) || port === gatewayPort) {
  throw new Error("TEST_REQUIRES_ISOLATED_PORT");
}
const base = `http://127.0.0.1:${port}`;
const workerId = "worker:synthetic:result-read";
const credentialAlias = "gateway-alias:synthetic:result-read";
const gatewayJobId = "gateway:synthetic:original-result";

async function unknownOutcomeFixture() {
  const at = new Date().toISOString();
  const candidate = createSavedLocalPreparationCandidate({ at });
  const legacy = structuredClone(createFormalC1C2Fixture({ at, candidateId: "SYNTHETIC-LEGACY-RESULT-READ",
    supplierSkuId: "SYNTHETIC-LEGACY-RESULT-SKU" }).candidate);
  delete legacy.lifecycleV11.skuPackage.g1Identity;
  const repository = createMemoryBusinessStateRepository({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [candidate, legacy], evidencePacks: [], dispatches: [],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } });
  const owner = createActorContext({ userId: "owner:synthetic:result-read", sessionId: "session:synthetic:owner",
    actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: at });
  const worker = createActorContext({ userId: workerId, sessionId: "session:synthetic:worker",
    actorType: "worker", roles: ["operator"], source: "local_worker", authenticatedAt: at });
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  workerRegistry.register({ workerId, capabilities: ["ai-draft-gateway"], version: "1", observedAt: at });
  let issued;
  const useCase = createC1DraftSoftwareUseCase({ repository, runtimeMode: "local_development", serverClock: () => at,
    workerRegistry, executionBinding: { provider: "terra", modelVersion: "gpt-5.6-terra", credentialAlias, allowedWorkerIds: [workerId] },
    requestGateway: async ({ request, authorizedExecution, onGatewayJobAccepted }) => {
      issued = { request, authorizedExecution };
      await onGatewayJobAccepted({ gatewayJobId });
      throw new C1AiGatewayError("C1_AI_GATEWAY_DEADLINE_EXCEEDED", "gateway_status", "Synthetic original result deadline",
        { jobId: gatewayJobId });
    } });
  const prepared = await useCase.prepareLocal({ actor: owner, input: { candidateId: candidate.id,
    expectedRevision: candidate.dataRevision, idempotencyKey: "result-read:prepare", auditEventId: "result-read:prepare-audit" } });
  const request = prepared.candidate.lifecycleV11.c1AiDraftRequestV1;
  const enqueued = await useCase.authorizeAndEnqueue({ actor: owner, input: { candidateId: candidate.id,
    expectedRevision: prepared.candidate.dataRevision, requestRef: request.requestId, requestFingerprint: request.requestFingerprint,
    confirmPaidCall: true, expiresAt: null, idempotencyKey: "result-read:authorize", auditEventId: "result-read:authorize-audit" } });
  const jobId = enqueued.result.softwareJobRef.jobId;
  const run = await useCase.run({ actor: worker, input: { jobId, leaseId: "lease:synthetic:original", leaseDurationMs: 90000 } });
  assert.equal(run.status, "unknown_outcome");
  const document = await repository.readSnapshot();
  assert.equal(document.runtime.softwareJobs[0].progressRef, gatewayJobId);
  assert.equal(document.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  return { document, candidate: document.candidates[0], legacy, issued, originalJob: structuredClone(document.runtime.softwareJobs[0]) };
}

test("owner reads only the original C1 result; pending, concurrent clicks and restart preserve one paid execution", async t => {
  const fixture = await unknownOutcomeFixture();
  const { candidate, legacy, issued, originalJob } = fixture;
  const directory = await mkdtemp(path.join(tmpdir(), "c1-result-read-api-"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  await mkdir(path.join(directory, "data"));
  const dataFile = path.join(directory, "data/state.json");
  await writeFile(dataFile, JSON.stringify(fixture.document));
  const readDocument = async () => JSON.parse(await readFile(dataFile, "utf8"));
  const expected = buildC1GatewayJob({ candidateId: candidate.id, dataRevision: issued.authorizedExecution.candidateRevision,
    request: issued.request });
  const sourceBinding = { schemaVersion: C1_GATEWAY_SOURCE_BINDING_VERSION, softwareJobId: originalJob.jobId,
    requestFingerprint: issued.request.requestFingerprint, sourceSkuRevision: issued.request.sourceSkuRevision,
    c1PlanId: issued.request.identity.c1PlanId, platform: issued.request.sourceIdentity.platform,
    storeRef: structuredClone(issued.request.sourceIdentity.storeRef), supplierSkuId: issued.request.sourceIdentity.supplierSkuId,
    variantKey: issued.request.identity.variantKey };
  let reads = 0, posts = 0, gatewayFailure, gatewayMode = "pending", releaseRead, readEntered;
  const gateway = createServer(async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") posts += 1;
      assert.equal(req.method, "GET", "Result retrieval must never create another gateway job");
      assert.equal(req.url, `/v1/inference-jobs/${encodeURIComponent(gatewayJobId)}`);
      reads += 1;
      if (gatewayMode === "held_completed") {
        const waiting = new Promise(resolve => { releaseRead = resolve; });
        readEntered();
        await waiting;
      }
      const responseAt = new Date().toISOString();
      const output = c1DraftPaidReceipt(issued, responseAt).output;
      const completed = gatewayMode !== "pending";
      res.end(JSON.stringify({ jobId: gatewayJobId, sourceBinding, candidateId: expected.candidateId,
        skuPackageId: expected.skuPackageId, dataRevision: expected.dataRevision, businessPhase: "C1",
        taskType: expected.taskType, model: expected.model, status: completed ? "completed" : "running", attempt: 1,
        startedAt: originalJob.startedAt, completedAt: completed ? responseAt : null,
        receipt: completed ? { receiptVersion: "inference-receipt-v1", providerRequestId: "provider:synthetic:original-result",
          requestHash: "b".repeat(64), requestedAt: originalJob.startedAt, completedAt: responseAt,
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, validation: { schemaValid: true, strictJson: true }, output } : null }));
    } catch (error) {
      gatewayFailure = error;
      res.writeHead(500); res.end(JSON.stringify({ code: "SYNTHETIC_GATEWAY_ASSERTION_FAILED" }));
    }
  });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "127.0.0.1", resolve); });
  let child, cookie = "";
  const stderr = [];
  t.after(async () => {
    if (releaseRead) releaseRead();
    try { if (child) await stopApiProcess(child); }
    finally {
      gateway.closeAllConnections();
      await new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function start() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir,
      env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
        SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
        SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(directory, "private/owner.json"),
        SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(directory, "uploads"),
        SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
        SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: "[]", SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "[]",
        SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([{ schemaVersion: "c1-draft-service-binding-v1",
          provider: "terra", modelVersion: "gpt-5.6-terra", credentialAlias, workerId, workerVersion: "1",
          gatewayOrigin: `http://127.0.0.1:${gatewayPort}`, configurationVersion: "synthetic:result-read:1", leaseDurationMs: 90000 }]),
        SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => done(new Error(`API_START_TIMEOUT:stdout=${output}:stderr=${stderr.join("")}`)), 10000);
      const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
      const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("")}`));
      function done(error) {
        clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
        if (error) reject(error); else resolve();
      }
      child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
    });
  }
  async function post(route, body, { authenticated = true, origin = base } = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  async function authenticate(action) {
    const response = await post(`/api/owner-access/${action}`, { password: "synthetic result read test password" }, { authenticated: false });
    assert.equal(response.status, 200, JSON.stringify(response.body)); cookie = response.cookie.split(";")[0];
  }
  async function state() {
    const response = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  }
  const route = `/api/candidates/${candidate.id}/lifecycle/c1/paid-draft/reconcile-result`;
  const input = { candidateId: candidate.id, jobId: originalJob.jobId, expectedRevision: candidate.dataRevision };
  await start();
  await authenticate("setup");

  await t.test("unauthenticated, foreign origin, stale revision and foreign job cannot issue a GET", async () => {
    const before = await readDocument();
    assert.equal((await post(route, input, { authenticated: false })).status, 401);
    assert.equal((await post(route, input, { origin: "https://untrusted.invalid" })).status, 403);
    assert.equal((await post(route, { ...input, expectedRevision: input.expectedRevision - 1 })).status, 409);
    assert.equal((await post(route, { ...input, jobId: "software-job:foreign" })).status, 409);
    assert.equal((await post(route, { ...input, gatewayJobId: "gateway:foreign" })).status, 400);
    assert.deepEqual(await readDocument(), before); assert.equal(reads, 0); assert.equal(posts, 0);
  });
  await t.test("one pending read preserves original failure and paid counters; restart creates no background read", async () => {
    const pending = await post(route, input);
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.executionStatus, "pending");
    assert.equal(reads, 1); assert.equal(posts, 0);
    const saved = await readDocument();
    assert.equal(saved.runtime.softwareJobs[0].status, "unknown_outcome");
    assert.deepEqual(saved.runtime.softwareJobs[0].resultEnvelope, originalJob.resultEnvelope);
    assert.equal(saved.runtime.softwareJobs[0].attempt, 1);
    assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
    assert.deepEqual(saved.candidates, fixture.document.candidates);
    await stopApiProcess(child); child = null; await start(); await authenticate("login");
    const view = (await state()).candidates.find(item => item.id === candidate.id);
    assert.equal(view.c1DraftRuntimeView.canReadOriginalResult, true);
    assert.equal(reads, 1); assert.equal(posts, 0);
  });
  await t.test("concurrent clicks retrieve once and apply once while retaining original unknown history", async () => {
    gatewayMode = "held_completed";
    const entered = new Promise(resolve => { readEntered = resolve; });
    const first = post(route, input);
    await Promise.race([entered, first.then(result => {
      throw new Error(`Expected an in-flight gateway read: ${JSON.stringify(result)}`);
    })]);
    const duplicate = await post(route, input);
    assert.ok([200, 409].includes(duplicate.status), JSON.stringify(duplicate.body));
    if (duplicate.status === 200) assert.equal(duplicate.body.executionStatus, "pending");
    assert.equal(reads, 2); assert.equal(posts, 0);
    releaseRead();
    const completed = await first;
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const saved = await readDocument(), job = saved.runtime.softwareJobs[0], current = saved.candidates[0];
    assert.equal(job.status, "completed"); assert.equal(job.externalRequestState, "succeeded"); assert.equal(job.attempt, 1);
    assert.equal(job.resultEnvelope.applicationDisposition, "applied");
    assert.equal(job.c1ResultReconciliation.priorOutcome.status, "unknown_outcome");
    assert.equal(job.c1ResultReconciliation.priorOutcome.failureClass, "C1_AI_GATEWAY_DEADLINE_EXCEEDED");
    assert.deepEqual(job.c1ResultReconciliation.priorOutcome.resultEnvelope, originalJob.resultEnvelope);
    assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
    assert.equal(saved.runtime.softwareJobs.length, 1);
    assert.equal(current.dataRevision, candidate.dataRevision + 1);
    assert.equal(current.lifecycleV11.skuPackage.businessPhase, "C1");
    assert.equal(current.lifecycleV11.skuPackage.c1ProductPlan.status, "seo_draft_ready");
    assert.equal(current.lifecycleV11.skuPackage.ownerAction, "confirm_c1_plan");
    assert.equal(current.lifecycleV11.skuPackage.c2FinalAssets, null);
    assert.equal(completed.body.candidate.c1ContentReviewView.status, "awaiting_confirmation");
    assert.equal(saved.runtime.idempotencyRecords.filter(record => record.action === "c1_ai_draft_apply").length, 1);
    assert.deepEqual(current.lifecycleV11.skuPackage.profitModels, candidate.lifecycleV11.skuPackage.profitModels);
    assert.deepEqual(current.lifecycleV11.skuPackage.selectedSupplySnapshot, candidate.lifecycleV11.skuPackage.selectedSupplySnapshot);
  });
  await t.test("completed replay and restart never issue another GET or apply, and legacy candidates remain readable", async () => {
    const before = await readDocument();
    assert.equal((await post(route, input)).status, 409);
    assert.equal((await post(route, { ...input, expectedRevision: before.candidates[0].dataRevision })).status, 409);
    await stopApiProcess(child); child = null; await start(); await authenticate("login");
    const views = await state();
    assert.equal(views.candidates.find(item => item.id === candidate.id).c1ContentReviewView.status, "awaiting_confirmation");
    assert.deepEqual(views.candidates.find(item => item.id === legacy.id).c1ContentReviewView,
      { status: "not_ready", reason: "C1_CONTENT_REVIEW_WORKFLOW_NOT_APPLICABLE", canConfirm: false });
    assert.deepEqual(await readDocument(), before);
    assert.equal(reads, 2); assert.equal(posts, 0); assert.equal(gatewayFailure, undefined);
    assert.deepEqual(stderr, []);
  });
});
