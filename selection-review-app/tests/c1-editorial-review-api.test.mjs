import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createC1EditorialReviewFixture } from "./fixtures/c1-editorial-review-fixture.mjs";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const dependencyPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if (![port, dependencyPort].every(value => Number.isSafeInteger(value) && value > 0 && ![4317, 4318, 4173].includes(value)) || port === dependencyPort) {
  throw new Error("TEST_REQUIRES_ISOLATED_PORT");
}
const base = `http://127.0.0.1:${port}`;

test("saved editorial proposal is read-only until owner confirmation and enters images exactly once", async t => {
  const fixture = await createC1EditorialReviewFixture();
  const { candidate, bundle } = fixture;
  const legacy = structuredClone(createFormalC1C2Fixture({ at: fixture.at,
    candidateId: "SYNTHETIC-EDITORIAL-UNRELATED", supplierSkuId: "SYNTHETIC-EDITORIAL-OTHER-SKU" }).candidate);
  delete legacy.lifecycleV11.skuPackage.g1Identity;
  fixture.document.candidates.push(legacy);
  const directory = await mkdtemp(path.join(tmpdir(), "c1-editorial-review-api-"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  await mkdir(path.join(directory, "business"));
  const dataFile = path.join(directory, "business/state.json");
  const proposalFile = path.join(directory, "private/editorial-proposal.json");
  await writeFile(dataFile, JSON.stringify(fixture.document));
  await writeFile(proposalFile, JSON.stringify(bundle), { mode: 0o600 });
  const readDocument = async () => JSON.parse(await readFile(dataFile, "utf8"));
  const originalProtected = {
    jobs: structuredClone(fixture.document.runtime.softwareJobs),
    authorizations: structuredClone(fixture.document.runtime.softwareJobAuthorizationRecords),
    credentials: structuredClone(fixture.document.runtime.softwareJobCredentialBindings),
    request: structuredClone(candidate.lifecycleV11.c1AiDraftRequestV1),
    profitModels: structuredClone(candidate.lifecycleV11.skuPackage.profitModels)
  };
  let dependencyRequests = 0, child, cookie = "";
  const stderr = [];
  const dependency = createServer((req, res) => {
    dependencyRequests += 1;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "UNEXPECTED_EDITORIAL_EXTERNAL_REQUEST" }));
  });
  t.after(async () => {
    try { if (child) await stopApiProcess(child); }
    finally {
      dependency.closeAllConnections();
      if (dependency.listening) await new Promise((resolve, reject) => dependency.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => { dependency.once("error", reject); dependency.listen(dependencyPort, "127.0.0.1", resolve); });
  function launch() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir,
      env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
        SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
        SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(directory, "private/owner.json"),
        SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE: proposalFile,
        SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(directory, "uploads"),
        SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
        SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: "[]", SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "[]",
        SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: "[]",
        SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${dependencyPort}`,
        SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: `http://127.0.0.1:${dependencyPort}`,
        SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" }, stdio: ["ignore", "pipe", "pipe"] });
    return child;
  }
  async function start() {
    const process = launch();
    process.stderr.on("data", chunk => stderr.push(String(chunk)));
    await new Promise((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => done(new Error(`API_START_TIMEOUT:stdout=${stdout}:stderr=${stderr.join("")}`)), 10000);
      const onData = chunk => { stdout += chunk; if (stdout.includes(base)) done(); };
      const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("")}`));
      function done(error) {
        clearTimeout(timer); process.stdout.off("data", onData); process.off("error", done); process.off("exit", onExit);
        if (error) reject(error); else resolve();
      }
      process.stdout.on("data", onData); process.once("error", done); process.once("exit", onExit);
    });
  }
  async function post(route, body, { authenticated = true, origin = base } = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  async function authenticate(action) {
    const response = await post(`/api/owner-access/${action}`, { password: "synthetic editorial review password" }, { authenticated: false });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    cookie = response.cookie.split(";")[0];
  }
  async function state() {
    const response = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function assertProtectedHistory() {
    const saved = await readDocument();
    assert.deepEqual(saved.runtime.softwareJobs, originalProtected.jobs);
    assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords, originalProtected.authorizations);
    assert.deepEqual(saved.runtime.softwareJobCredentialBindings, originalProtected.credentials);
    assert.deepEqual(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1, originalProtected.request);
    assert.deepEqual(saved.candidates[0].lifecycleV11.skuPackage.profitModels, originalProtected.profitModels);
    assert.deepEqual(saved.candidates[1], legacy);
    assert.deepEqual(saved.dispatches, []);
    assert.equal(dependencyRequests, 0);
    assert.deepEqual(JSON.parse(await readFile(proposalFile, "utf8")), bundle);
  }
  const route = `/api/candidates/${candidate.id}/lifecycle/c1/confirm-editorial-content`;
  let confirmation;
  await start();
  await t.test("login and repeated previews never write business state or call external services", async () => {
    const bytes = await readFile(dataFile);
    await authenticate("setup"); await authenticate("login");
    for (let index = 0; index < 2; index += 1) {
      const snapshot = await state();
      const view = snapshot.candidates.find(item => item.id === candidate.id).c1EditorialReviewView;
      assert.equal(view.status, "awaiting_confirmation"); assert.equal(view.canConfirm, true);
      assert.equal(view.expectedRevision, candidate.dataRevision);
      assert.deepEqual(view.semanticValidation, { status: "maintenance_review_recorded", automatedSemanticProof: false });
      assert.deepEqual(view.changes.map(change => change.path), ["output.title", "output.description",
        ...["bulletPoints", "searchKeywords"].flatMap(field => bundle.receipt.output[field].map((_, itemIndex) => `output.${field}[${itemIndex}]`))]);
      assert.equal(view.content.title.text, bundle.receipt.output.title.text);
      assert.equal(snapshot.candidates.find(item => item.id === legacy.id).c1EditorialReviewView.status, "not_applicable");
      confirmation = { candidateId: candidate.id, expectedRevision: view.expectedRevision,
        editorialVersionId: view.editorialVersionId, outputFingerprint: view.outputFingerprint,
        confirmed: true, idempotencyKey: "editorial:api-confirm", auditEventId: "editorial:api-confirm-audit" };
    }
    assert.deepEqual(await readFile(dataFile), bytes);
    await assertProtectedHistory();
  });

  await t.test("authentication, origin, revision, version and exact input scope reject before writes", async () => {
    const bytes = await readFile(dataFile);
    const unauthenticated = await post(route, confirmation, { authenticated: false });
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.body));
    assert.equal(unauthenticated.body.code, "OWNER_LOGIN_REQUIRED");
    assert.equal((await post(route, confirmation, { origin: "https://untrusted.invalid" })).status, 403);
    const otherSku = await post(`/api/candidates/${legacy.id}/lifecycle/c1/confirm-editorial-content`, {
      ...confirmation, candidateId: legacy.id, expectedRevision: legacy.dataRevision
    });
    assert.equal(otherSku.status, 409, JSON.stringify(otherSku.body));
    assert.deepEqual(await readFile(dataFile), bytes);
    for (const [change, status] of [
      [{ candidateId: legacy.id }, 400],
      [{ expectedRevision: confirmation.expectedRevision - 1 }, 409],
      [{ editorialVersionId: "c1-draft-editorial:obsolete" }, 409],
      [{ outputFingerprint: "0".repeat(64) }, 409],
      [{ confirmed: false }, 400],
      [{ content: { title: "Untrusted replacement" } }, 400],
      [{ sourceJob: bundle.sourceJob }, 400]
    ]) {
      const rejected = await post(route, { ...confirmation, ...change });
      assert.equal(rejected.status, status, JSON.stringify(rejected.body));
      assert.deepEqual(await readFile(dataFile), bytes);
    }
    await assertProtectedHistory();
  });

  await t.test("concurrent and duplicate owner confirmation create one C2 container and preserve the rejected paid execution", async () => {
    const responses = await Promise.all([post(route, confirmation), post(route, confirmation)]);
    for (const response of responses) assert.equal(response.status, 200, `${JSON.stringify(response.body)}\nserver stderr: ${stderr.join("")}`);
    assert.deepEqual(new Set(responses.map(response => response.body.status)), new Set(["committed", "idempotent_replay"]));
    const saved = await readDocument();
    const life = saved.candidates[0].lifecycleV11, sku = life.skuPackage;
    assert.equal(saved.candidates[0].dataRevision, candidate.dataRevision + 1);
    assert.equal(life.c1EditorialContentReviewV1.status, "confirmed");
    assert.equal(life.c1EditorialContentReviewV1.editorialVersionId, confirmation.editorialVersionId);
    assert.equal(life.c1EditorialContentReviewV1.outputFingerprint, confirmation.outputFingerprint);
    assert.equal(life.c1EditorialContentReviewV1.productionAuthorizationGranted, false);
    assert.equal(sku.businessPhase, "C2");
    assert.equal(sku.c2FinalAssets.status, "awaiting_final_uploads");
    assert.deepEqual(sku.c2FinalAssets.assets, { collected: [], aiDrafts: [], finalUploads: [] });
    for (const key of ["productionAuthorization", "productionRecord", "externalListingRecord", "eVerificationRecord"]) assert.equal(sku[key], null);
    const bytes = await readFile(dataFile);
    const repeated = await post(route, confirmation);
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.status, "idempotent_replay");
    assert.deepEqual(await readFile(dataFile), bytes);
    await assertProtectedHistory();
  });

  await t.test("confirmed content and the same C2 container survive restart without applying the original failed receipt", async () => {
    const bytes = await readFile(dataFile);
    await stopApiProcess(child); child = null; cookie = "";
    await start(); await authenticate("login");
    const current = (await state()).candidates.find(item => item.id === candidate.id);
    assert.equal(current.c1EditorialReviewView.status, "confirmed");
    assert.equal(current.c1EditorialReviewView.canConfirm, false);
    assert.equal(current.c1EditorialReviewView.editorialVersionId, confirmation.editorialVersionId);
    assert.equal(current.lifecycleV11.skuPackage.c2FinalAssets.status, "awaiting_final_uploads");
    assert.deepEqual(await readFile(dataFile), bytes);
    await assertProtectedHistory();
    assert.equal(stderr.join(""), "");
  });

  await t.test("invalid configured proposal fails startup without business writes or an API listener", async () => {
    await stopApiProcess(child); child = null;
    const bytes = await readFile(dataFile);
    const invalid = structuredClone(bundle);
    invalid.correctionPlan.sourceOutputFingerprint = "0".repeat(64);
    for (const [content, expectedError] of [
      [JSON.stringify(invalid), /C1_EDITORIAL_REVIEW_PROPOSAL_BLOCKED/],
      ['{"syntheticSecret":"DO_NOT_LOG_EDITORIAL_PRIVATE_MARKER", invalid}', /C1_EDITORIAL_PROPOSAL_FILE_INVALID/]
    ]) {
      await writeFile(proposalFile, content);
      const process = launch();
      let stdout = "", failure = "";
      process.stdout.on("data", chunk => { stdout += chunk; });
      process.stderr.on("data", chunk => { failure += chunk; });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("INVALID_PROPOSAL_STARTUP_DID_NOT_FAIL")), 10000);
        process.once("error", error => { clearTimeout(timer); reject(error); });
        process.once("exit", code => { clearTimeout(timer); resolve(code); });
      });
      assert.notEqual(code, 0);
      assert.match(failure, expectedError);
      assert.doesNotMatch(stdout, new RegExp(base.replaceAll(".", "\\.")));
      assert.doesNotMatch(failure + stdout, /DO_NOT_LOG_EDITORIAL_PRIVATE_MARKER|syntheticSecret|synthetic editorial review password|Untrusted replacement/);
      assert.deepEqual(await readFile(dataFile), bytes);
      assert.equal(dependencyRequests, 0);
      child = null;
    }
  });
});
