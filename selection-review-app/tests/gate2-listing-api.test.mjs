import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DEFAULT_RULES } from "../lib/workflow.mjs";
import { validateProductionAuthorizationRecord } from "../lib/product-lifecycle-schema.mjs";
import { createFinalPricingRevalidationFixture } from "./fixtures/final-pricing-revalidation-fixture.mjs";
import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;
const TEST_ID = "GATE2-LISTING-001";
const TEST_SKU = "SINK-ORGANIZER-BLUE";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");

test("传好图之后点一次「上架」：图片确认、方案卡和生产授权依次保存，内容与分步确认完全一致；卡变了什么都不存", async t => {
  // This shared fixture runs the real B -> C1 receipt merge -> C2 domain chain with synthetic evidence.
  // Paid provider HTTP execution belongs to the dedicated software use-case tests.
  // The final pricing fixture wraps the formal B -> C1 -> C2 fixture with the B evidence bundle, cost policy and synthetic
  // market samples that the owner's multi-sample final pricing review re-checks before production authorization.
  const pricing = createFinalPricingRevalidationFixture({ candidateId: TEST_ID, supplierSkuId: TEST_SKU, variantKey: "颜色:蓝色",
    candidateRevision: 1, sourceOfferId: "900000000001", captureId: "capture:synthetic:sink-organizer",
    productName: "硅胶水槽收纳架", material: "silicone", categoryName: "Органайзеры для кухни" });
  const formal = pricing.formal;
  const candidate = { ...pricing.candidate, salesSnapshotsV11: structuredClone(pricing.assessmentInput.salesSnapshots),
    workflowStatus: "listing_preparation", comments: [], history: [], processing: { state: "idle", manualHold: false } };
  const sourceSku = candidate.lifecycleV11.skuPackage;
  assert.equal(sourceSku.businessPhase, "C2");
  assert.equal(sourceSku.c1ProductPlan.status, "seo_draft_ready");
  assert.equal(sourceSku.c1ProductPlan.draftOnlySeo.providerJobRef.jobId, formal.receipt.gatewayJobId);
  assert.equal(sourceSku.supplierSkuId, TEST_SKU);
  const binding = { bindingId: "binding:synthetic:generic", configurationVersion: "generic-api-v1", platform: "ozon",
    storeRef: structuredClone(candidate.storeRef), storeName: "合成测试店铺", warehouseName: "合成测试仓库",
    warehouseRef: "warehouse:synthetic:generic", warehouseId: "70001", credentialAlias: "credential-alias:synthetic:generic",
    verification: { evidenceRef: "configuration-evidence:synthetic:generic", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } };
  const model = sourceSku.profitModels.find(item => item.profitModelVersion === sourceSku.activeProfitModelVersion);
  const conversion = model.priceConversion;
  const directory = await mkdtemp(path.join(tmpdir(), "gate2-listing-api-"));
  const businessDirectory = path.join(directory, "business");
  await mkdir(businessDirectory);
  const dataFile = path.join(businessDirectory, "candidates.json");
  const privateDirectory = path.join(directory, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const exchangePack = { id: conversion.evidenceRef, kind: "exchange_rate", status: "active",
    scope: { pair: "RUB/CNY" }, sourceType: "isolated_test", sourceRef: "fixture:generic-frozen-fx",
    checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", evidenceData: { rubPerCny: conversion.rubPerCny } };
  // The server uses its actual clock: the synthetic B evidence packs are declared current, not renewed real evidence.
  const evidencePacks = [exchangePack, ...pricing.evidencePacks.filter(pack => pack.id !== exchangePack.id)
    .map(pack => ({ ...pack, checkedAt: pack.kind === "schema"
      ? sourceSku.c1ProductPlan.inputSnapshots.platformSchemaRules.collectedAt : pack.checkedAt,
    expiresAt: "2099-01-01T00:00:00.000Z" }))];
  const rules = { ...structuredClone(DEFAULT_RULES), ozonDandanshu: { ...structuredClone(DEFAULT_RULES.ozonDandanshu), ...structuredClone(pricing.rules.ozonDandanshu) } };
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules,
    candidates: [candidate], dispatches: [], evidencePacks, currentCommissionCatalogs: [] }));
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir,
    env: { ...process.env, SELECTION_REVIEW_DATA_FILE: dataFile, SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(directory, "uploads"), SELECTION_REVIEW_AUTO_DELIVER: "off", SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, "owner.json"),
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
      SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([binding]) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 10000);
    let output = "";
    const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("").slice(0, 1200)}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
  });
  let cookie = "";
  const headers = () => ({ Origin: base, "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}) });
  async function post(route, input) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") };
  }
  async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: headers() });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function savedCandidate() {
    const snapshot = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
    return snapshot.candidates.find(item => item.id === TEST_ID);
  }
  const route = `/api/candidates/${TEST_ID}`;
  const anonymous = await post(`${route}/gate2/list`, { dataRevision: 1 });
  assert.equal(anonymous.status, 401, "没登录主人身份不能上架");
  const setup = await post("/api/owner-access/setup", { password: "synthetic gate2 listing owner password" });
  assert.equal(setup.status, 200, setup.body.message);
  cookie = setup.setCookie.split(";")[0];
  const ownerId = setup.body.user.userId;

  // 还没传图：没有可以预演的卡，列表里说的是「等传图」。
  const beforeImages = await get(`${route}/gate2/preview`);
  assert.equal(beforeImages.preview.stage, "images");
  assert.equal(beforeImages.preview.ready, false);
  async function upload(draftRevision, fileName, body) {
    const response = await fetch(`${base}${route}/lifecycle/c2/final-assets/upload?dataRevision=1&draftRevision=${draftRevision}&fileName=${fileName}`, {
      method: "POST", headers: { ...headers(), "Content-Type": "image/png" }, body });
    return { status: response.status, body: await response.json() };
  }
  const main = await upload(0, "sink-organizer-main.png", PNG);
  assert.equal(main.status, 201, main.body.message);
  const detail = await upload(main.body.draft.revision, "sink-organizer-detail.png", DETAIL_PNG);
  assert.equal(detail.status, 201, detail.body.message);
  const selection = [{ assetId: main.body.asset.assetId, order: 1 }, { assetId: detail.body.asset.assetId, order: 2 }];
  const selected = await post(`${route}/lifecycle/c2/upload-draft`, { dataRevision: 1, draftRevision: detail.body.draft.revision, selection });
  assert.equal(selected.status, 200, selected.body.message);

  const listed = (await get("/api/state")).candidates.find(item => item.id === TEST_ID);
  assert.deepEqual(listed.gate2ListingView, { schemaVersion: "gate2-listing-view-v1", stage: "preview" });
  const { preview } = await get(`${route}/gate2/preview`);
  assert.equal(preview.stage, "preview");
  assert.equal(preview.ready, true, JSON.stringify(preview.gaps));
  assert.match(preview.previewFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.skuPackage.productionConfirmationCard.c2Assets.finalUploads.map(asset => asset.assetId), selection.map(item => item.assetId));
  assert.equal(preview.productionOwnerPreparation.store.displayName, "合成测试店铺");
  assert.deepEqual(preview.productionOwnerPreparation.executionBindings.map(item => item.bindingId), [binding.bindingId]);
  assert.equal(preview.accountReadHours, 24);
  const unchanged = await savedCandidate();
  assert.equal(unchanged.dataRevision, 1, "预演上架卡不保存任何东西");
  assert.equal(unchanged.lifecycleV11.skuPackage.productionConfirmationCard ?? null, null);

  const listInput = { dataRevision: 1, previewFingerprint: preview.previewFingerprint, merchantSku: "MERCHANT-SINK-BLUE",
    bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, confirmed: true };
  const beforeList = await readFile(dataFile, "utf8");
  const stale = await post(`${route}/gate2/list`, { ...listInput, previewFingerprint: "0".repeat(64) });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "gate2_card_changed"); assert.equal(stale.body.stoppedAt, "check");
  const extra = await post(`${route}/gate2/list`, { ...listInput, platformWritePrice: { amount: 1, currency: "CNY" } });
  assert.equal(extra.status, 400);
  const wrongBinding = await post(`${route}/gate2/list`, { ...listInput, configurationVersion: "generic-api-v0" });
  assert.equal(wrongBinding.status, 409);
  assert.equal(await readFile(dataFile, "utf8"), beforeList, "卡对不上、字段多了或仓库不对，什么都不保存");

  const result = await post(`${route}/gate2/list`, listInput);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.saved, { finalAssets: true, productionAuthorization: true, accountRead: false });
  assert.equal(result.body.platformWrites, 0);
  const saved = await savedCandidate();
  const sku = saved.lifecycleV11.skuPackage;
  assert.equal(sku.c2FinalAssets.status, "completed");
  assert.deepEqual(sku.productionConfirmationCard.c2Assets.finalUploads.map(asset => asset.assetId), selection.map(item => item.assetId));
  const pa = sku.productionAuthorization;
  assert.equal(pa.schemaVersion, "production-authorization-v1.2");
  assert.equal(pa.authorizedByActorId, ownerId);
  assert.equal(pa.lockedScope.merchantSku, "MERCHANT-SINK-BLUE");
  assert.equal(pa.lockedScope.stock, 100);
  assert.deepEqual(pa.executionBinding, { bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, warehouseId: binding.warehouseId });
  assert.deepEqual(pa.lockedScope.buyerTargetPrice, { amount: model.recommendedSalePriceRub, currency: "RUB" });
  assert.deepEqual(pa.lockedScope.finalUploads.map(asset => asset.assetId), selection.map(item => item.assetId));
  assert.equal(validateProductionAuthorizationRecord(pa, { candidateId: TEST_ID, candidateRevision: saved.dataRevision,
    skuPackage: sku, lifecycleState: "persisted" }).valid, true);
  assert.equal(sku.productionRecord, null); assert.equal(saved.lifecycleV11.platformWrites, 0);
  // 授权之后这件不再走「上架」卡；再点一次不会再存第二份。
  const again = await post(`${route}/gate2/list`, { ...listInput, dataRevision: saved.dataRevision });
  assert.equal(again.status, 409);
  assert.equal((await savedCandidate()).dataRevision, saved.dataRevision);
  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.meta.automationStarted, false); assert.deepEqual(persisted.dispatches, []);
  assert.equal(stderr.join(""), "");
});
