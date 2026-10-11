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
import { c1DraftPaidReceipt } from "./fixtures/c1-draft-source-fixture.mjs";
import { buildC1PaidDraftInput } from "../src/c1PaidDraftInput.js";
import { gate2FinalAssetInput } from "../lib/gate2-listing.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if (![port, gatewayPort].every(value => Number.isSafeInteger(value) && value > 0 && ![4317, 4318, 4173].includes(value)) || port === gatewayPort) {
  throw new Error("TEST_REQUIRES_ISOLATED_PORT");
}
const base = `http://127.0.0.1:${port}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");


test("「做这件」许可下，文案写好软件直接送进传图；主人不用单独确认，旧的图片确认按钮也不能替上架卡确认文案", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c1-forward-listing-api-"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  await mkdir(path.join(directory, "business"));
  const dataFile = path.join(directory, "business/state.json");
  const at = new Date().toISOString();
  const candidate = createSavedLocalPreparationCandidate({ at });
  assert.equal(candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1, undefined);
  assert.equal(candidate.lifecycleV11.c1SoftwareEvidenceV1, undefined);
  assert.equal(candidate.lifecycleV11.c1AiDraftRequestV1, undefined);
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [candidate], evidencePacks: [], dispatches: [], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } }));
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
            providerRequestId: "provider:synthetic:forward-listing", requestHash: "a".repeat(64),
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
  const password = "synthetic forward listing test password";
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
  async function upload(dataRevision, draftRevision, fileName, bytes) {
    const response = await fetch(`${base}/api/candidates/${candidate.id}/lifecycle/c2/final-assets/upload?${new URLSearchParams({ dataRevision, draftRevision, fileName })}`, {
      method: "POST", headers: { Origin: base, "Sec-Fetch-Site": "same-origin", Cookie: cookie, "Content-Type": "image/png" }, body: bytes
    });
    return { status: response.status, body: await response.json() };
  }

  async function waitFor(check, label) {
    for (let index = 0; index < 100; index += 1) {
      const document = await readDocument();
      if (check(document)) return document;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`WAIT_TIMEOUT:${label}:${stderr.join("")}`);
  }
  const route = `/api/candidates/${candidate.id}`;
  await start();
  await authenticate("setup");

  // 老商品没有许可：主人点「让软件接着做」，这一下就是 v2 许可；软件准备好文案请求，停在付费那一步。
  const continued = await post(`${route}/gate1/autopilot/continue`, { dataRevision: candidate.dataRevision });
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  let saved = await readDocument();
  assert.equal(saved.candidates[0].gate1AutopilotGrantV1.scopeVersion, "gate1-autopilot-scope-v2");
  assert.ok(saved.candidates[0].gate1AutopilotGrantV1.scope.includes("c1_forward_copy"));
  assert.ok(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1, JSON.stringify(continued.body));
  assert.equal(saved.runtime.softwareJobs.length, 0);
  assert.equal(providerCalls, 0, "软件自己不花钱");
  let view = await current();
  assert.equal(view.gate1AutopilotView.stops[0].code, "c1_paid_draft");

  // 主人批准那一次付费生成；回执落库后，软件按许可把文案送进传图，不替主人确认。
  const approval = buildC1PaidDraftInput({ candidate: view, confirmed: true, sourceRevision: view.dataRevision });
  const paid = await post(`${route}/lifecycle/c1/paid-draft/authorize`, approval);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(gatewayFailure, undefined);
  assert.equal(providerCalls, 1);
  // 软件这一轮做完才记下做过的几步，所以等到记录里有了这一步再看。
  saved = await waitFor(document => document.candidates[0].lifecycleV11.c1ContentForwardV1 &&
    document.candidates[0].gate1AutopilotV1?.ranSteps?.some(item => item.step === "c1_forward_copy"), "forward");
  const life = saved.candidates[0].lifecycleV11;
  assert.equal(life.skuPackage.businessPhase, "C2");
  assert.equal(life.c1ContentReviewV1, undefined);
  assert.equal(life.c1ContentForwardV1.ownerContentConfirmation, "at_listing");
  assert.equal(life.c1ContentForwardV1.forwardedBy, "selection-review-software");
  assert.equal(life.skuPackage.productionAuthorization, null);
  assert.equal(saved.candidates[0].lastModifiedBy, "software");
  view = await current();
  assert.equal(view.c1ContentReviewView.status, "awaiting_listing");
  assert.equal(view.c1ContentReviewView.canConfirm, false);
  assert.deepEqual(view.gate1AutopilotView.stops.map(item => item.code), ["c2_assets"]);
  assert.match(view.gate1AutopilotView.stops[0].line, /文案到上架卡上和图片一起看/u);
  assert.deepEqual(view.gate1AutopilotView.ranSteps.map(item => item.step).slice(-1), ["c1_forward_copy"]);
  assert.deepEqual(view.gate2ListingView, { schemaVersion: "gate2-listing-view-v1", stage: "images" });
  const confirmContent = await post(`${route}/lifecycle/c1/confirm-content`, { candidateId: candidate.id, expectedRevision: view.dataRevision,
    contentFingerprint: life.c1ContentForwardV1.contentFingerprint, confirmed: true,
    idempotencyKey: "synthetic:content:after-forward", auditEventId: "synthetic:content-audit:after-forward" });
  assert.equal(confirmContent.status, 409, "文案已经送进传图，确认只在上架卡上");

  // 传图、排序照旧；旧的「确认素材」按钮不能绕过上架卡把文案当成已确认。
  const first = await upload(view.dataRevision, 0, "main.png", PNG);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await upload(view.dataRevision, first.body.draft.revision, "detail.png", DETAIL_PNG);
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const selection = [{ assetId: first.body.asset.assetId, order: 1 }, { assetId: second.body.asset.assetId, order: 2 }];
  const selected = await post(`${route}/lifecycle/c2/upload-draft`, { dataRevision: view.dataRevision, draftRevision: second.body.draft.revision, selection });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  view = await current();
  assert.deepEqual(view.gate2ListingView, { schemaVersion: "gate2-listing-view-v1", stage: "preview" });
  const before = await readFile(dataFile);
  const bypass = await post(`${route}/lifecycle/c2/final-assets`, gate2FinalAssetInput(view));
  assert.equal(bypass.status, 409, JSON.stringify(bypass.body));
  assert.equal(bypass.body.code, "c1_content_confirmed_at_listing");
  assert.deepEqual(await readFile(dataFile), before, "什么都没保存");
  assert.equal(providerCalls, 1);
  assert.deepEqual((await readDocument()).dispatches, []);
  assert.equal(stderr.join(""), "");
});
