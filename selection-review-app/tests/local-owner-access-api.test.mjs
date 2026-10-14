import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { productionAuthorizationInputFixture } from "./helpers/c2-software-fixture.mjs";
import { validateProductionAuthorizationRecord } from "../lib/product-lifecycle-schema.mjs";
import { restoreProductionEntities } from "../lib/production-entity-storage.mjs";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;

test("local owner authentication, one exact production confirmation and restart preserve separate authority boundaries", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-owner-access-api-"));
  const privateDirectory = path.join(directory, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const businessDirectory = path.join(directory, "business");
  await mkdir(businessDirectory);
  const dataFile = path.join(businessDirectory, "state.json");
  const fixture = productionAuthorizationInputFixture({ candidateId: "SYNTHETIC-OWNER-FLOW" });
  const candidate = { ...structuredClone(fixture.candidate), productName: "合成主人授权验证商品",
    workflowStatus: "listing_preparation", history: [] };
  const binding = { ...fixture.commercialDecision.executionBinding, platform: "ozon", storeRef: candidate.storeRef,
    storeName: "合成测试店铺", warehouseName: "合成测试仓库", warehouseRef: fixture.commercialDecision.warehouseRef,
    credentialAlias: fixture.commercialDecision.credentialAlias,
    verification: { evidenceRef: "configuration-evidence:synthetic:owner-api", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } };
  const source = { meta: { version: 2, automationStarted: false }, rules: {}, candidates: [candidate], dispatches: [],
    evidencePacks: fixture.evidencePacks.map(pack => ({ ...structuredClone(pack), expiresAt: "2099-01-01T00:00:00.000Z" })) };
  const rightsFixtures = [false, true].map(frozen => {
    const formal = createFormalC1DraftFixture({ candidateId: frozen ? "SYNTHETIC-C1-FROZEN" : "SYNTHETIC-C1-RIGHTS", storeRef: candidate.storeRef });
    const entry = { ...structuredClone(formal.candidate), workflowStatus: "listing_preparation" };
    if (!frozen) entry.lifecycleV11.skuPackage = structuredClone(formal.created.skuPackage);
    source.candidates.push(entry);
    return { frozen, candidate: entry };
  });
  await writeFile(dataFile, JSON.stringify(source));
  const originalBytes = await readFile(dataFile);
  const stderr = [];
  let child;
  async function start() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
      cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
        SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
        SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, "owner.json"),
        SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
        SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([binding]), SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 10000);
      let output = "";
      const onData = chunk => { output += chunk; if (output.includes(`http://127.0.0.1:${port}`)) done(); };
      const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}: ${stderr.join("").slice(-2000)}`));
      function done(error) {
        clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
        if (error) reject(error); else resolve();
      }
      child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
    });
  }
  t.after(async () => { if (child) await stopApiProcess(child); });
  await start();
  let cookie = "";
  async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function post(route, body, headers = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: {
      Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") };
  }
  const password = "aB4!";
  assert.equal((await get("/api/owner-access")).status, "setup_required");
  assert.equal((await get("/api/state")).runtimeArchitecture.currentUser.authenticated, false);
  assert.deepEqual(await readFile(dataFile), originalBytes);
  const forbiddenOrigin = await post("/api/owner-access/setup", { password }, { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" });
  assert.equal(forbiddenOrigin.status, 403);
  const injected = await post("/api/owner-access/setup", { password, userId: "forged-owner", role: "owner" });
  assert.equal(injected.status, 400);
  const oversized = await post("/api/owner-access/setup", { password: "x".repeat(9000) });
  assert.equal(oversized.status, 413);
  const tooShort = await post("/api/owner-access/setup", { password: "abc" });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body.code, "OWNER_PASSWORD_INPUT_INVALID");
  assert.equal((await get("/api/owner-access")).status, "setup_required");
  await assert.rejects(readFile(path.join(privateDirectory, "owner.json")), error => error.code === "ENOENT");
  assert.deepEqual(await readFile(dataFile), originalBytes);
  const setup = await post("/api/owner-access/setup", { password });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.status, "authenticated");
  assert.match(setup.setCookie, /HttpOnly/);
  assert.match(setup.setCookie, /SameSite=Strict/);
  cookie = setup.setCookie.split(";")[0];
  const bearer = cookie.slice(cookie.indexOf("=") + 1);
  const ownerId = setup.body.user.userId;
  assert.equal(JSON.stringify(setup.body).includes(bearer), false);
  assert.equal(JSON.stringify(setup.body).includes(password), false);
  assert.deepEqual(await readFile(dataFile), originalBytes, "setup authenticates only; it cannot modify business records");
  assert.equal((await post("/api/owner-access/setup", { password })).status, 409);
  assert.equal((await get("/api/state")).runtimeArchitecture.currentUser.canAuthorizeProduction, true);
  const preparation = await get(`/api/candidates/${candidate.id}/lifecycle/production-owner-preparation`);
  assert.equal(preparation.ready, true, JSON.stringify(preparation.gaps));
  assert.equal(preparation.scope.platformWritePrice.currency, "CNY");
  assert.equal(preparation.scope.buyerTargetPrice.currency, "RUB");
  const input = { contractVersion: preparation.contractVersion, ...preparation.source, bindingId: binding.bindingId,
    configurationVersion: binding.configurationVersion, merchantSku: fixture.commercialDecision.merchantSku, confirmExactScope: true };
  const authorized = await post(`/api/candidates/${candidate.id}/lifecycle/production-owner-decision`, input);
  assert.equal(authorized.status, 200, stderr.join("").replaceAll(password, "[REDACTED]").replaceAll(bearer, "[REDACTED]"));
  const savedBytes = await readFile(dataFile);
  const saved = JSON.parse(savedBytes);
  const current = saved.candidates[0];
  const sku = restoreProductionEntities(current, saved.productionEntityRecords).lifecycleV11.skuPackage;
  assert.equal(sku.productionAuthorization.schemaVersion, "production-authorization-v1.2");
  assert.equal(sku.productionAuthorization.authorizedByActorId, ownerId);
  assert.deepEqual(sku.productionAuthorization.executionBinding, fixture.commercialDecision.executionBinding);
  assert.equal(validateProductionAuthorizationRecord(sku.productionAuthorization, { candidateId: candidate.id,
    candidateRevision: current.dataRevision, skuPackage: sku, lifecycleState: "persisted" }).valid, true);
  assert.equal(sku.productionRecord, null);
  assert.equal(sku.dHandoff.schemaVersion, "c2-d-handoff-v2");
  assert.equal(sku.dHandoff.softwareJobCreated, true);
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(saved.runtime.softwareJobs[0].jobId, sku.dHandoff.softwareJobRef.jobId);
  assert.equal(saved.runtime.softwareJobs[0].status, "queued");
  assert.equal(saved.runtime.softwareJobs[0].externalRequestState, "not_sent");
  assert.deepEqual(saved.dispatches, []);
  assert.equal(savedBytes.includes(password), false);
  assert.equal(savedBytes.includes(bearer), false);
  const currentView = (await get("/api/state")).candidates[0].dESavedJobRuntimeView;
  assert.equal(currentView.d.jobId, sku.dHandoff.softwareJobRef.jobId);
  assert.equal(currentView.status, "queued");
  assert.equal(currentView.currentVerified, false);
  assert.equal(currentView.canContinueSaved, false);
  assert.equal(currentView.d.configurationBlockReason, "DE_SERVICE_REQUIRED");
  await stopApiProcess(child);
  await start();
  assert.equal((await get("/api/owner-access")).status, "login_required", "restart invalidates the old cookie");
  assert.equal((await get("/api/state")).runtimeArchitecture.currentUser.canAuthorizeProduction, false);
  assert.equal((await post(`/api/candidates/${candidate.id}/lifecycle/production-owner-decision`, input,
    { "x-session-id": ownerId, "x-user-id": ownerId })).status, 401);
  assert.deepEqual(await readFile(dataFile), savedBytes, "restart and rejected replay preserve the exact saved authorization");
  const invalidLogin = await post("/api/owner-access/login", { password: "wrong synthetic password" });
  assert.equal(invalidLogin.status, 401);
  const login = await post("/api/owner-access/login", { password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.userId, ownerId);
  cookie = login.setCookie.split(";")[0];
  assert.equal((await get("/api/owner-access")).status, "authenticated");
  assert.equal((await post("/api/owner-access/logout", {})).status, 200);
  assert.equal((await get("/api/owner-access")).status, "login_required");
  assert.deepEqual(await readFile(dataFile), savedBytes);
  assert.equal(stderr.join(""), "");

  await t.test("独立权利声明与冻结C1替代经认证接口保存，重放和重启不改写历史或其他商品", async () => {
    const first = rightsFixtures[0].candidate;
    const denied = await post(`/api/candidates/${first.id}/lifecycle/c1/rights-review`, { candidateId: first.id });
    assert.equal(denied.status, 401);
    const relogin = await post("/api/owner-access/login", { password });
    assert.equal(relogin.status, 200);
    cookie = relogin.setCookie.split(";")[0];
    assert.equal((await get("/api/state")).runtimeArchitecture.currentUser.canSaveC1RightsReview, true);
    for (const f of rightsFixtures) {
      const originalSku = f.candidate.lifecycleV11.skuPackage;
      const rightsInput = { candidateId: f.candidate.id, skuPackageId: originalSku.skuPackageId,
        expectedRevision: f.candidate.dataRevision, idempotencyKey: `rights:api:${f.candidate.id}`,
        expectedC1PlanId: originalSku.c1ProductPlan.c1PlanId, replacesC1PlanId: f.frozen ? originalSku.c1ProductPlan.c1PlanId : null,
        brand: { status: "branded", name: "SYNTHETIC_TEST_BRAND" }, rights: { status: "verified", basis: "licensed" },
        reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" };
      const route = `/api/candidates/${f.candidate.id}/lifecycle/c1/rights-review`;
      const beforeRights = await readFile(dataFile);
      assert.equal((await post(route, { ...rightsInput, reviewId: "forged-review" })).status, 400);
      assert.equal((await post(route, { ...rightsInput, candidateId: "another-candidate" })).status, 400);
      if (f.frozen) assert.equal((await post(route, { ...rightsInput, replacesC1PlanId: null })).status, 409);
      assert.deepEqual(await readFile(dataFile), beforeRights);
      const response = await post(route, rightsInput);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.result.rightsView.status, "verified");
      const readback = (await get("/api/state")).candidates.find(item => item.id === f.candidate.id);
      const declared = readback.lifecycleV11.skuPackage;
      assert.equal(readback.dataRevision, f.candidate.dataRevision + 1);
      assert.equal(readback.c1ReviewPresentation.rights.status, "verified");
      assert.equal(declared.c1RightsReviewRecord.declaredByUserId, ownerId);
      assert.equal(declared.c1RightsReviewRecord.review.rights.basis, "licensed");
      assert.deepEqual(declared.profitModels, originalSku.profitModels);
      assert.equal(declared.productionAuthorization, null);
      assert.equal(declared.c1ProductPlan.status, "inputs_ready");
      if (f.frozen) {
        assert.notEqual(declared.c1ProductPlan.c1PlanId, originalSku.c1ProductPlan.c1PlanId);
        assert.deepEqual(response.body.result.supersededC1.c1ProductPlan, originalSku.c1ProductPlan);
        assert.equal(declared.c1ProductPlan.supersedes.c1PlanId, originalSku.c1ProductPlan.c1PlanId);
        assert.equal(declared.dataRevision, originalSku.dataRevision + 1);
      } else assert.equal(declared.dataRevision, originalSku.dataRevision);
      const bytesAfter = await readFile(dataFile);
      assert.equal((await post(route, rightsInput)).body.status, "idempotent_replay");
      assert.deepEqual(await readFile(dataFile), bytesAfter);
      assert.equal((await post(route, { ...rightsInput, idempotencyKey: `${rightsInput.idempotencyKey}:stale` })).status, 409);
      assert.deepEqual(await readFile(dataFile), bytesAfter);
    }
    const rightsBytes = await readFile(dataFile), persisted = JSON.parse(rightsBytes);
    assert.deepEqual(persisted.candidates[0], saved.candidates[0], "声明不改变另一件已保存PA的商品");
    assert.deepEqual(persisted.runtime.softwareJobs, saved.runtime.softwareJobs);
    assert.deepEqual(persisted.dispatches, []);
    assert.equal(rightsBytes.includes(password), false);
    assert.equal(rightsBytes.includes(cookie.slice(cookie.indexOf("=") + 1)), false);
    await stopApiProcess(child);
    await start();
    const restartedState = await get("/api/state");
    assert.equal(restartedState.runtimeArchitecture.currentUser.canSaveC1RightsReview, false);
    for (const f of rightsFixtures) {
      const currentCandidate = restartedState.candidates.find(item => item.id === f.candidate.id);
      assert.deepEqual(currentCandidate.lifecycleV11.skuPackage.c1RightsReviewRecord,
        persisted.candidates.find(item => item.id === f.candidate.id).lifecycleV11.skuPackage.c1RightsReviewRecord);
    }
    assert.deepEqual(await readFile(dataFile), rightsBytes);
    assert.equal(stderr.join(""), "");
  });
});
