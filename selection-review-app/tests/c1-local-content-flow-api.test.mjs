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
import { buildC1PaidDraftInput } from "../src/c1PaidDraftInput.js";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if (![port, gatewayPort].every(value => Number.isSafeInteger(value) && value > 0 && ![4317, 4318, 4173].includes(value)) || port === gatewayPort) {
  throw new Error("TEST_REQUIRES_ISOLATED_PORT");
}
const base = `http://127.0.0.1:${port}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");

function assertUnresolvedColour(plan) {
  const colourIndex = plan.productAttributes.ozonAttributes.findIndex(attribute => attribute.fieldKey === "10096");
  assert.notEqual(colourIndex, -1);
  const colour = plan.productAttributes.ozonAttributes[colourIndex];
  assert.equal(colour.fact.verificationStatus, "unknown");
  assert.equal(colour.fact.value, "unknown");
  assert.equal(colour.dictionaryValueId, null);
  assert.ok(plan.unknownManifest.some(item => item.fieldPath === `productAttributes.ozonAttributes[${colourIndex}].fact` &&
    item.reason === "sku_attribute_scope_unresolved" && item.blockingScope === "informational" && item.blocksC2Handoff === false));
}

test("local material becomes one paid draft, owner reviewed content and durable SKU-bound image order", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c1-local-content-api-"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  await mkdir(path.join(directory, "business"));
  const dataFile = path.join(directory, "business/state.json");
  const at = new Date().toISOString();
  const candidate = createSavedLocalPreparationCandidate({ at });
  assert.equal(candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1, undefined);
  assert.equal(candidate.lifecycleV11.c1SoftwareEvidenceV1, undefined);
  assert.equal(candidate.lifecycleV11.c1AiDraftRequestV1, undefined);
  const originalSku = structuredClone(candidate.lifecycleV11.skuPackage);
  // Historical stored drafts can predate G1; reading them must not apply new review contracts or migrate them.
  const legacy = structuredClone(createFormalC1C2Fixture({ at, candidateId: "SYNTHETIC-LEGACY-NO-G1",
    supplierSkuId: "SYNTHETIC-LEGACY-SKU" }).candidate);
  delete legacy.lifecycleV11.skuPackage.g1Identity;
  assert.equal(legacy.lifecycleV11.skuPackage.c1ProductPlan.status, "seo_draft_ready");
  assert.equal(legacy.lifecycleV11.c1LocalDraftSourceV1, undefined);
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [candidate, legacy], evidencePacks: [], dispatches: [], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } }));
  const readDocument = async () => JSON.parse(await readFile(dataFile, "utf8"));
  let providerCalls = 0, gatewayJob, gatewayFailure;
  const gateway = createServer(async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/v1/inference-jobs") {
        providerCalls += 1;
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw);
        const saved = await readDocument();
        const job = saved.runtime.softwareJobs.find(item => item.jobId === input.sourceBinding.softwareJobId);
        const request = saved.candidates[0].lifecycleV11.c1AiDraftRequestV1;
        assert.equal(request.keywordEvidence.collectionMode, "local_preparation");
        assert.equal(input.sourceBinding.requestFingerprint, request.requestFingerprint);
        assert.equal(job.externalRequestState, "in_flight");
        assert.equal(saved.runtime.softwareJobAuthorizationRecords.find(item => item.authorizationId === job.scopeBinding.authorizationRef).useCount, 1);
        assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c2FinalAssets, null);
        const responseAt = new Date().toISOString();
        const output = c1DraftPaidReceipt({ request, authorizedExecution: { jobId: job.jobId } }, responseAt).output;
        gatewayJob = { jobId: `gateway:synthetic:${candidate.id}`, sourceBinding: input.sourceBinding,
          candidateId: input.candidateId, skuPackageId: input.skuPackageId, dataRevision: input.dataRevision,
          businessPhase: "C1", taskType: input.taskType, model: input.model, status: "completed", attempt: 1,
          startedAt: responseAt, completedAt: responseAt, receipt: { receiptVersion: "inference-receipt-v1",
            providerRequestId: "provider:synthetic:local-content", requestHash: "a".repeat(64),
            requestedAt: responseAt, completedAt: responseAt, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            validation: { schemaValid: true, strictJson: true }, output } };
        res.writeHead(202);
        return res.end(JSON.stringify({ jobId: gatewayJob.jobId, status: "queued", sourceBinding: input.sourceBinding }));
      }
      assert.equal(req.method, "GET");
      assert.equal(req.url, `/v1/inference-jobs/${encodeURIComponent(gatewayJob.jobId)}`);
      const saved = await readDocument();
      assert.equal(saved.runtime.softwareJobs[0].progressRef, gatewayJob.jobId);
      res.end(JSON.stringify(gatewayJob));
    } catch (error) {
      gatewayFailure = error;
      res.writeHead(500);
      res.end(JSON.stringify({ code: "SYNTHETIC_GATEWAY_ASSERTION_FAILED" }));
    }
  });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "127.0.0.1", resolve); });
  let child, cookie = "";
  const stderr = [];
  t.after(async () => {
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
        SELECTION_REVIEW_LEGACY_MANUAL_C1_INPUT: "true",
        SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
        SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: "[]", SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "[]",
        SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([{ schemaVersion: "c1-draft-service-binding-v1",
          provider: "terra", modelVersion: "gpt-5.6-terra", credentialAlias: "gateway-alias:synthetic:local-content",
          workerId: "worker:synthetic:local-content", workerVersion: "1", gatewayOrigin: `http://127.0.0.1:${gatewayPort}`,
          configurationVersion: "synthetic:local-content:1", leaseDurationMs: 90000 }]),
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
  const password = "synthetic local content test password";
  async function post(route, body, { authenticated = true, origin = base } = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  async function authenticate(action) {
    const response = await post(`/api/owner-access/${action}`, { password }, { authenticated: false });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    cookie = response.cookie.split(";")[0];
  }
  async function state() {
    const response = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function current() {
    return (await state()).candidates.find(item => item.id === candidate.id);
  }
  const route = `/api/candidates/${candidate.id}/lifecycle/c1`;
  const prepareInput = { candidateId: candidate.id, dataRevision: candidate.dataRevision, mode: "prepare_copy" };
  await start();

  await t.test("legacy ready drafts without G1 preserve login and state reads without changing business data", async () => {
    const bytes = await readFile(dataFile);
    await authenticate("setup");
    await authenticate("login");
    const saved = await state();
    assert.equal(saved.runtimeArchitecture.currentUser.authenticated, true);
    const legacyView = saved.candidates.find(item => item.id === legacy.id).c1ContentReviewView;
    assert.deepEqual(legacyView, {
      status: "not_ready", reason: "C1_CONTENT_REVIEW_WORKFLOW_NOT_APPLICABLE", canConfirm: false
    });
    assert.equal(saved.candidates.find(item => item.id === candidate.id).c1ContentReviewView.status, "not_ready");
    assert.deepEqual(await readFile(dataFile), bytes);
    assert.deepEqual((await readDocument()).candidates[1], legacy);
    assert.equal(providerCalls, 0);
  });

  await t.test("only current authenticated owner input prepares the saved request without a paid call", async () => {
    const bytes = await readFile(dataFile);
    assert.equal((await post(`${route}/continue-preparation`, prepareInput, { authenticated: false })).status, 401);
    assert.deepEqual(await readFile(dataFile), bytes);
    assert.equal((await post(`${route}/continue-preparation`, prepareInput, { origin: "https://untrusted.invalid" })).status, 403);
    assert.equal((await post(`${route}/continue-preparation`, { ...prepareInput, dataRevision: prepareInput.dataRevision - 1 })).status, 409);
    assert.deepEqual(await readFile(dataFile), bytes);
    const prepared = await post(`${route}/continue-preparation`, prepareInput);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const saved = await readDocument();
    assert.ok(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1);
    assertUnresolvedColour(saved.candidates[0].lifecycleV11.skuPackage.c1ProductPlan);
    assert.equal(saved.candidates[0].lifecycleV11.k3KeywordEvidenceSnapshotV1, undefined);
    assert.equal(saved.runtime.softwareJobs.length, 0);
    assert.equal(saved.runtime.softwareJobAuthorizationRecords.length, 0);
    assert.equal(providerCalls, 0);
  });

  let approval;
  await t.test("one paid receipt is persisted and applied but images remain blocked pending content review", async () => {
    const view = await current();
    approval = buildC1PaidDraftInput({ candidate: view, confirmed: true, sourceRevision: view.dataRevision });
    const response = await post(`${route}/paid-draft/authorize`, approval);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(gatewayFailure, undefined);
    assert.equal(response.body.executionStatus, "applied");
    assert.equal(providerCalls, 1);
    const saved = await readDocument();
    const sku = saved.candidates[0].lifecycleV11.skuPackage;
    assert.equal(sku.businessPhase, "C1");
    assert.equal(sku.ownerAction, "confirm_c1_plan");
    assert.equal(sku.c1ProductPlan.status, "seo_draft_ready");
    assert.equal(sku.c2FinalAssets, null);
    assert.deepEqual(sku.profitModels, originalSku.profitModels);
    assert.equal(saved.runtime.softwareJobs.length, 1);
    assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
    assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "applied");
    const before = await readFile(dataFile);
    const retry = await post(`${route}/paid-draft/authorize`, approval);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.authorizationStatus, "idempotent_replay");
    assert.deepEqual(await readFile(dataFile), before);
    assert.equal(providerCalls, 1);
    const draft = await current();
    assert.equal(draft.c1ContentReviewView.canConfirm, true);
    const legacy = await post(`${route}/complete`, { dataRevision: draft.dataRevision });
    assert.equal(legacy.status, 409, JSON.stringify(legacy.body));
    assert.deepEqual(await readFile(dataFile), before);
    const blocked = await upload(draft.dataRevision, 0, "premature.png", PNG);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.deepEqual(await readFile(dataFile), before);
  });

  async function upload(dataRevision, draftRevision, fileName, bytes) {
    const response = await fetch(`${base}/api/candidates/${candidate.id}/lifecycle/c2/final-assets/upload?${new URLSearchParams({ dataRevision, draftRevision, fileName })}`, {
      method: "POST", headers: { Origin: base, "Sec-Fetch-Site": "same-origin", Cookie: cookie, "Content-Type": "image/png" }, body: bytes
    });
    return { status: response.status, body: await response.json() };
  }

  await t.test("content confirmation checks owner, revision and fingerprint and creates C2 only once", async () => {
    const view = await current();
    const input = { candidateId: candidate.id, expectedRevision: view.dataRevision,
      contentFingerprint: view.c1ContentReviewView.contentFingerprint, confirmed: true,
      idempotencyKey: `synthetic:content:${view.dataRevision}`, auditEventId: `synthetic:content-audit:${view.dataRevision}` };
    const before = await readFile(dataFile);
    assert.equal((await post(`${route}/confirm-content`, input, { authenticated: false })).status, 401);
    for (const change of [{ expectedRevision: view.dataRevision - 1 }, { contentFingerprint: "0".repeat(64) }]) {
      const rejected = await post(`${route}/confirm-content`, { ...input, ...change });
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.deepEqual(await readFile(dataFile), before);
    }
    const responses = await Promise.all([post(`${route}/confirm-content`, input), post(`${route}/confirm-content`, input)]);
    for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(new Set(responses.map(response => response.body.status)), new Set(["committed", "idempotent_replay"]));
    const saved = await readDocument();
    const life = saved.candidates[0].lifecycleV11;
    assert.equal(saved.candidates[0].dataRevision, view.dataRevision + 1);
    assert.equal(life.c1ContentReviewV1.status, "confirmed");
    assert.equal(life.c1ContentReviewV1.contentFingerprint, input.contentFingerprint);
    assert.equal(life.c1ContentReviewV1.productionAuthorizationGranted, false);
    assert.equal(life.skuPackage.businessPhase, "C2");
    assertUnresolvedColour(life.skuPackage.c1ProductPlan);
    assert.deepEqual(life.skuPackage.c2FinalAssets.assets, { collected: [], aiDrafts: [], finalUploads: [] });
    assert.equal(life.skuPackage.productionAuthorization, null);
    assert.equal(life.skuPackage.productionRecord, null);
    assert.equal(life.skuPackage.eVerificationRecord, null);
    assert.equal(saved.runtime.softwareJobs.length, 1);
    assert.equal(providerCalls, 1);
  });

  await t.test("images and chosen order persist for the confirmed SKU through restart without another paid call", async () => {
    const view = await current();
    const first = await upload(view.dataRevision, 0, "main.png", PNG);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await upload(view.dataRevision, first.body.draft.revision, "detail.png", DETAIL_PNG);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const selection = [{ assetId: second.body.asset.assetId, order: 1 }, { assetId: first.body.asset.assetId, order: 2 }];
    const selectionRoute = `/api/candidates/${candidate.id}/lifecycle/c2/upload-draft`;
    const selected = await post(selectionRoute, { dataRevision: view.dataRevision, draftRevision: second.body.draft.revision, selection });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const saved = await readDocument();
    const draft = saved.candidates[0].lifecycleV11.c2UploadDraft;
    assert.equal(draft.candidateId, candidate.id);
    assert.equal(draft.skuPackageId, originalSku.skuPackageId);
    assert.equal(draft.sourceSkuRevision, saved.candidates[0].lifecycleV11.skuPackage.dataRevision);
    assert.deepEqual(draft.selection, selection);
    const bytes = await readFile(dataFile);
    assert.equal((await post(selectionRoute, { dataRevision: view.dataRevision, draftRevision: second.body.draft.revision, selection: [] })).status, 409);
    assert.deepEqual(await readFile(dataFile), bytes);
    await stopApiProcess(child);
    cookie = "";
    await start();
    await authenticate("login");
    const restarted = await current();
    assert.deepEqual(restarted.lifecycleV11.c2UploadDraft.selection, selection);
    assert.deepEqual(await readFile(dataFile), bytes);
    assert.equal(providerCalls, 1);
    assert.equal((await readDocument()).runtime.softwareJobs.length, 1);
    assert.deepEqual((await readDocument()).dispatches, []);
  });
  assert.equal(gatewayFailure, undefined);
  assert.equal(stderr.join(""), "");
  assert.deepEqual((await readDocument()).candidates[1], legacy);
  assert.equal((await readFile(dataFile, "utf8")).includes(password), false);
});
