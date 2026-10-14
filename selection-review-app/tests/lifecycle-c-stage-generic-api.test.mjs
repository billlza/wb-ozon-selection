import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DEFAULT_RULES } from "../lib/workflow.mjs";
import { validateProductionAuthorizationRecord } from "../lib/product-lifecycle-schema.mjs";
import { createTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { createFinalPricingRevalidationFixture } from "./fixtures/final-pricing-revalidation-fixture.mjs";
import { assertProductionProfitPriceCurrent } from "../lib/final-pricing-review.mjs";
import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;
const TEST_ID = "GENERIC-NON-TRAIN-001";
const TEST_SKU = "SINK-ORGANIZER-BLUE";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");

test("非火车SKU从正式C1回执经HTTP持久素材确认和单主人授权，旧手工C1入口不能越过合同", async t => {
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
  const fireTrain = createTrainCandidate();
  const originalFireTrain = structuredClone(fireTrain);
  const binding = { bindingId: "binding:synthetic:generic", configurationVersion: "generic-api-v1", platform: "ozon",
    storeRef: structuredClone(candidate.storeRef), storeName: "合成测试店铺", warehouseName: "合成测试仓库",
    warehouseRef: "warehouse:synthetic:generic", warehouseId: "70001", credentialAlias: "credential-alias:synthetic:generic",
    verification: { evidenceRef: "configuration-evidence:synthetic:generic", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } };
  const model = sourceSku.profitModels.find(item => item.profitModelVersion === sourceSku.activeProfitModelVersion);
  const conversion = model.priceConversion;
  const directory = await mkdtemp(path.join(tmpdir(), "generic-c-stage-api-"));
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
    candidates: [fireTrain, candidate], dispatches: [], evidencePacks, currentCommissionCatalogs: [] }));
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
  const route = `/api/candidates/${TEST_ID}/lifecycle`;
  const initialBytes = await readFile(dataFile, "utf8");
  const anonymous = await post(`${route}/c1/complete`, { dataRevision: 1, confirmed: true });
  assert.equal(anonymous.status, 401);
  assert.equal(await readFile(dataFile, "utf8"), initialBytes);
  const setup = await post("/api/owner-access/setup", { password: "synthetic generic flow owner password" });
  assert.equal(setup.status, 200, setup.body.message);
  cookie = setup.setCookie.split(";")[0];
  const ownerId = setup.body.user.userId;
  assert.equal(await readFile(dataFile, "utf8"), initialBytes, "登录不应改变业务状态");
  for (const retiredRoute of [`${route}/final-assets`, `/api/legacy/fire-train/candidates/${TEST_ID}/lifecycle/c1-owner-facts`, `${route}/c1/complete`]) {
    const retired = await post(retiredRoute, { dataRevision: 1, confirmed: true });
    assert.equal(retired.status, 410, retired.body.message);
  }
  assert.equal(await readFile(dataFile, "utf8"), initialBytes, "退役入口不得改变任何候选或C1结果");

  async function upload(draftRevision, fileName, body) {
    const response = await fetch(`${base}${route}/c2/final-assets/upload?dataRevision=1&draftRevision=${draftRevision}&fileName=${fileName}`, {
      method: "POST", headers: { ...headers(), "Content-Type": "image/png" }, body });
    return { status: response.status, body: await response.json() };
  }
  const invalidUpload = await upload(0, "not-an-image.png", Buffer.from("not an image"));
  assert.equal(invalidUpload.status, 415, invalidUpload.body.message);
  const rejected = await savedCandidate();
  assert.equal(rejected.dataRevision, 1);
  assert.deepEqual(rejected.lifecycleV11.skuPackage, sourceSku, "失败上传仅保存明确素材失败记录，不修改冻结业务资料");
  assert.equal(rejected.lifecycleV11.c2UploadDraft.uploads[0].status, "failed");
  const main = await upload(rejected.lifecycleV11.c2UploadDraft.revision, "sink-organizer-main.png", PNG);
  assert.equal(main.status, 201, main.body.message);
  const detail = await upload(main.body.draft.revision, "sink-organizer-detail.png", DETAIL_PNG);
  assert.equal(detail.status, 201, detail.body.message);
  assert.equal(detail.body.platformWrites, 0); assert.equal(detail.body.businessPhaseChanged, false);
  const afterUpload = await savedCandidate();
  assert.equal(afterUpload.dataRevision, 1);
  assert.deepEqual(afterUpload.lifecycleV11.skuPackage, sourceSku);
  const selection = [{ assetId: main.body.asset.assetId, order: 1 }, { assetId: detail.body.asset.assetId, order: 2 }];
  const selected = await post(`${route}/c2/upload-draft`, { dataRevision: 1, draftRevision: detail.body.draft.revision, selection });
  assert.equal(selected.status, 200, selected.body.message);
  const draftRevision = selected.body.draft.revision;
  const confirmation = { dataRevision: 1, draftRevision, confirmed: true, finalUploadAssets: selection,
    approvedAssetIds: selection.map(asset => asset.assetId), approvedMainImageAssetId: main.body.asset.assetId, approvedVideoDisposition: "excludes_video" };
  const beforeConfirm = await readFile(dataFile, "utf8");
  const tampered = await post(`${route}/c2/final-assets`, { ...confirmation,
    finalUploadAssets: [{ ...selection[0], sourceEvidenceRef: "owner-supplied:forged" }, selection[1]] });
  assert.equal(tampered.status, 409); assert.equal(tampered.body.code, "c2_upload_selection_changed");
  assert.equal(await readFile(dataFile, "utf8"), beforeConfirm);
  const c2 = await post(`${route}/c2/final-assets`, confirmation);
  assert.equal(c2.status, 200, c2.body.message);
  const finalSku = c2.body.candidate.lifecycleV11.skuPackage;
  assert.equal(finalSku.c2FinalAssets.status, "completed");
  assert.equal(finalSku.productionAuthorization, null);
  assert.equal(finalSku.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
  assert.deepEqual(finalSku.productionConfirmationCard.c2Assets.finalUploads.map(asset => asset.assetId), selection.map(asset => asset.assetId));
  const beforeAuthorization = await readFile(dataFile, "utf8");
  const oldAuthorization = await post(`${route}/production-authorization`, { dataRevision: c2.body.candidate.dataRevision,
    confirmed: true, cardId: finalSku.productionConfirmationCard.cardId });
  assert.equal(oldAuthorization.status, 409); assert.equal(oldAuthorization.body.code, "production_authorization_reconfirmation_required");
  assert.equal(await readFile(dataFile, "utf8"), beforeAuthorization);
  // An unchanged formal B price remains usable without a saved final pricing review.
  // Once a review exists, a malformed or stale one must be rejected rather than bypassed.
  const blockedPreparation = await get(`${route}/production-owner-preparation`);
  assert.equal(blockedPreparation.ready, true, JSON.stringify(blockedPreparation.gaps));
  assert.equal(blockedPreparation.gaps.some(item => item.code === "FINAL_PRICING_REVIEW_REQUIRED"), false);
  const invalidReviewCandidate = structuredClone(await savedCandidate());
  invalidReviewCandidate.lifecycleV11.skuPackage.finalPricingReview = { schemaVersion: "final-pricing-review-v1" };
  assert.throws(() => assertProductionProfitPriceCurrent({ candidate: invalidReviewCandidate,
    skuPackage: invalidReviewCandidate.lifecycleV11.skuPackage, evidencePacks,
    observedAt: new Date().toISOString() }), error => error.code === "FINAL_PRICING_REVIEW_INVALID");
  const beforeDecision = await readFile(dataFile, "utf8");
  const preparation = await get(`${route}/production-owner-preparation`);
  assert.equal(preparation.ready, true, preparation.gaps.map(item => item.code).join(","));
  const input = { contractVersion: preparation.contractVersion, ...preparation.source,
    bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, merchantSku: "MERCHANT-SINK-BLUE", confirmExactScope: true };
  const tamperedPrice = await post(`${route}/production-owner-decision`, { ...input, platformWritePrice: { amount: 1, currency: "CNY" } });
  assert.equal(tamperedPrice.status, 400); assert.equal(await readFile(dataFile, "utf8"), beforeDecision);
  const authorization = await post(`${route}/production-owner-decision`, input);
  assert.equal(authorization.status, 200, authorization.body.message);
  const saved = await savedCandidate();
  const authorizedSku = saved.lifecycleV11.skuPackage;
  const pa = authorizedSku.productionAuthorization;
  assert.equal(pa.schemaVersion, "production-authorization-v1.2");
  assert.equal(pa.authorizedByActorId, ownerId); assert.equal(pa.confirmedByActorId, ownerId);
  assert.equal(pa.lockedScope.supplierSkuId, TEST_SKU); assert.equal(pa.lockedScope.merchantSku, input.merchantSku);
  assert.equal(pa.lockedScope.stock, 100);
  assert.deepEqual(pa.executionBinding, { bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, warehouseId: binding.warehouseId });
  assert.deepEqual(pa.lockedScope.buyerTargetPrice, { amount: model.recommendedSalePriceRub, currency: "RUB" });
  assert.deepEqual(pa.lockedScope.platformWritePrice, { amount: model.recommendedSalePriceCny, currency: "CNY" });
  assert.deepEqual(pa.lockedScope.finalUploads.map(asset => asset.assetId), selection.map(asset => asset.assetId));
  assert.equal(validateProductionAuthorizationRecord(pa, { candidateId: TEST_ID, candidateRevision: saved.dataRevision,
    skuPackage: authorizedSku, lifecycleState: "persisted" }).valid, true);
  assert.equal(authorizedSku.productionRecord, null); assert.equal(saved.lifecycleV11.platformWrites, 0);
  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  const authorizationRef = persisted.candidates.find(item => item.id === TEST_ID).lifecycleV11.skuPackage.productionAuthorization;
  assert.equal(authorizationRef.schemaVersion, "production-entity-reference-v1");
  assert.equal(authorizationRef.entityId, pa.authorizationId);
  assert.equal(persisted.productionEntityRecords.filter(record => record.kind === "production_authorization" &&
    record.entityId === pa.authorizationId).length, 1);
  assert.deepEqual(persisted.candidates.find(item => item.id === fireTrain.id), originalFireTrain);
  const serialized = JSON.stringify(authorizedSku);
  for (const unrelated of [fireTrain.id, "4993364145574", "豪华小火车", "Паровоз", "DVP", "282件"]) assert.equal(serialized.includes(unrelated), false, unrelated);
  assert.equal(persisted.meta.automationStarted, false); assert.deepEqual(persisted.dispatches, []);
  assert.equal(stderr.join(""), "");
});
