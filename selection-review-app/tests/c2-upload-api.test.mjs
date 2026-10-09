import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess, allocatedTestPorts } from "./helpers/api-process-lifecycle.mjs";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { validateProductionAuthorizationPreparation } from "../lib/production-authorization-preparation.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { api: port } = allocatedTestPorts();
const base = `http://127.0.0.1:${port}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");
const headers = { Origin: base, "Sec-Fetch-Site": "same-origin" };

async function startServer(t, dataFile, uploadDirectory, ownerIdentityFile = null) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_C2_UPLOAD_DIR: uploadDirectory, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      ...(ownerIdentityFile ? { SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password',
        SELECTION_REVIEW_OWNER_IDENTITY_FILE: ownerIdentityFile, SELECTION_REVIEW_PUBLIC_ORIGIN: base } : {}),
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" }, stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${stderr.join("")}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, stderr }; }
    catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Test server did not become healthy");
}

test("C2 upload and saved order survive restart, then local confirmation produces no platform writes", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c2-upload-api-"));
  const dataFile = path.join(directory, "state.json");
  const formal = createFormalC1C2Fixture({ candidateId: "synthetic-c2-upload", supplierSkuId: "SYNTHETIC-C2",
    variantKey: "规格:合成验收款", candidateRevision: 12, at: "2026-09-07T08:00:00.000Z" });
  const candidate = { ...formal.candidate,
    productName: "Synthetic upload confirmation", source: "user", workflowStatus: "listing_preparation", comments: [], history: [],
    processing: { state: "idle" }, lifecycleV11: { ...formal.candidate.lifecycleV11, status: "awaiting_final_assets" } };
  const original = { meta: { version: 2, automationStarted: false }, rules: {}, candidates: [candidate], dispatches: [], evidencePacks: [] };
  await writeFile(dataFile, JSON.stringify(original));
  const first = await startServer(t, dataFile, path.join(directory, "uploads"));
  const route = `/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2`;
  async function upload(draftRevision, fileName, bytes) {
    const response = await fetch(`${base}${route}/final-assets/upload?dataRevision=12&draftRevision=${draftRevision}&fileName=${fileName}`, {
      method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: bytes
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.dataRevision, 12);
    assert.equal(body.platformWrites, 0);
    assert.equal(body.businessPhaseChanged, false);
    assert.ok(body.asset.assetRef.startsWith("local-asset:c2-local:"));
    return body;
  }
  const uploaded = await upload(0, "main.png", PNG);
  assert.equal(uploaded.draft.revision, 2);
  await stopApiProcess(first.child);
  const restartBefore = await readFile(dataFile, "utf8");
  const second = await startServer(t, dataFile, path.join(directory, "uploads"));
  assert.equal(await readFile(dataFile, "utf8"), restartBefore);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.candidates[0].lifecycleV11.c2UploadDraft.uploads[0].assetId, uploaded.asset.assetId);
  const preview = await fetch(`${base}${route}/local-assets/${encodeURIComponent(uploaded.asset.assetId)}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
  const detail = await upload(2, "detail.png", DETAIL_PNG);
  const selection = [
    { assetId: uploaded.asset.assetId, order: 1 },
    { assetId: detail.asset.assetId, order: 2 }
  ];
  const save = await fetch(`${base}${route}/upload-draft`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 4, selection }) });
  const saved = await save.json();
  assert.equal(save.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.draft.selection, selection);
  const stale = await fetch(`${base}${route}/upload-draft`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 4, selection: [] }) });
  assert.equal(stale.status, 409);
  const confirm = await fetch(`${base}${route}/final-assets`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 5, confirmed: true, finalUploadAssets: selection,
      approvedAssetIds: selection.map(asset => asset.assetId), approvedMainImageAssetId: uploaded.asset.assetId, approvedVideoDisposition: "excludes_video" }) });
  const result = await confirm.json();
  assert.equal(confirm.status, 200, JSON.stringify(result));
  const after = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
  const final = after.candidates[0].lifecycleV11.skuPackage;
  assert.equal(final.c2FinalAssets.status, "completed");
  assert.equal(final.productionAuthorization, null);
  assert.equal(final.productionRecord, null);
  assert.equal(final.dataRevision, final.c2FinalAssets.productionAuthorizationPreparation.resultDataRevision);
  assert.equal(final.productionConfirmationCard.cardRevision, 1);
  assert.doesNotThrow(() => validateProductionAuthorizationPreparation({ preparation: final.c2FinalAssets.productionAuthorizationPreparation, candidateId: candidate.id, skuPackage: final }));
  assert.deepEqual(final.c2FinalAssets.assets.finalUploads.map(asset => asset.assetId), selection.map(asset => asset.assetId));
  assert.equal(after.dispatches.length, 0);
  assert.equal(after.meta.automationStarted, false);
  assert.equal(after.candidates[0].executionRuntime.status, "waiting_owner");
  assert.equal(after.candidates[0].executionRuntime.businessPhase, "C2");
  assert.equal(after.candidates[0].executionRuntime.stepId, "C2_OWNER_BUSINESS_CONFIRMATION");
  assert.equal(after.candidates[0].executionRuntime.inputRevision, after.candidates[0].dataRevision);
  assert.equal(after.candidates[0].executionRuntime.inferenceJobId, null);
  assert.equal(after.candidates[0].executionRuntime.codexWakeupCount, 0);
  const confirmedState = await fetch(`${base}/api/state`);
  assert.equal(confirmedState.status, 200, await confirmedState.clone().text());
  const projected = await confirmedState.json();
  assert.equal(projected.candidates[0].executionRuntimeView.status, "waiting_owner");
  assert.deepEqual(projected.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard, final.productionConfirmationCard);
  await stopApiProcess(second.child);
  const beforeConfirmedRestart = await readFile(dataFile, "utf8");
  const third = await startServer(t, dataFile, path.join(directory, "uploads"));
  const restartedState = await fetch(`${base}/api/state`);
  assert.equal(restartedState.status, 200, await restartedState.clone().text());
  const restarted = await restartedState.json();
  assert.deepEqual(restarted.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard, final.productionConfirmationCard);
  assert.deepEqual(restarted.candidates[0].executionRuntimeView, projected.candidates[0].executionRuntimeView);
  assert.equal(await readFile(dataFile, "utf8"), beforeConfirmedRestart);
  assert.equal(first.stderr.join(""), "");
  assert.equal(second.stderr.join(""), "");
  assert.equal(third.stderr.join(""), "");
});

test("sibling gallery link keeps independent registrations and rejects another color main image", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c2-sibling-link-api-"));
  await mkdir(path.join(directory, 'business'));
  await mkdir(path.join(directory, 'private'), { mode: 0o700 });
  const dataFile = path.join(directory, 'business', "state.json");
  function child(id, supplierSkuId, color) {
    const formal = createFormalC1C2Fixture({ candidateId: id, supplierSkuId, variantKey: `颜色:${color}` });
    return { ...formal.candidate, dataRevision: 12, source: "user", workflowStatus: "listing_preparation",
      comments: [], history: [], processing: { state: "idle" },
      sourceCapture: { skuChoices: [{ sourceSkuId: supplierSkuId, attributes: { 颜色: color } }] },
      siblingSourceV1: { parentCandidateId: "candidate:synthetic-family", supplierSkuId },
      lifecycleV11: { ...formal.candidate.lifecycleV11, status: "awaiting_final_assets" } };
  }
  const source = child("candidate:synthetic-black", "synthetic-black", "黑色");
  const target = child("candidate:synthetic-green", "synthetic-green", "绿色");
  const parent = { id: 'candidate:synthetic-family', dataRevision: 7,
    sourceCapture: { selectedSkuIds: ['synthetic-first', 'synthetic-black', 'synthetic-green'] },
    lifecycleV11: { skuPackage: { supplierSkuId: 'synthetic-first', technicalStatus: 'unknown_outcome' } } };
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [parent, source, target], dispatches: [], evidencePacks: [] }));
  await startServer(t, dataFile, path.join(directory, "uploads"), path.join(directory, 'private', 'owner.json'));
  const setup = await fetch(`${base}/api/owner-access/setup`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'synthetic gallery link password' }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  async function upload(id, revision, fileName, bytes) {
    const response = await fetch(`${base}/api/candidates/${id}/lifecycle/c2/final-assets/upload?dataRevision=12&draftRevision=${revision}&fileName=${fileName}`,
      { method: "POST", headers: { ...headers, "Content-Type": "image/png", Cookie: cookie }, body: bytes });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body;
  }
  const blackMain = await upload(source.id, 0, "black.png", PNG);
  const greenMain = await upload(target.id, 0, "green.png", DETAIL_PNG);
  async function link(sourceAssetId, draftRevision) {
    const response = await fetch(`${base}/api/candidates/${target.id}/lifecycle/c2/final-assets/link`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ dataRevision: 12, draftRevision, role: "gallery_image",
        sourceCandidateId: source.id, sourceDataRevision: 12, sourceAssetId }) });
    return { response, body: await response.json() };
  }
  const rejected = await link(blackMain.asset.assetId, greenMain.draft.revision);
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.code, "c2_link_main_color_mismatch");
  const detail = await upload(source.id, blackMain.draft.revision, "shared.png", DETAIL_PNG);
  const linked = await link(detail.asset.assetId, greenMain.draft.revision);
  assert.equal(linked.response.status, 201, JSON.stringify(linked.body));
  assert.notEqual(linked.body.asset.assetId, detail.asset.assetId);
  assert.equal(linked.body.asset.sha256, detail.asset.sha256);
  assert.equal(linked.body.draft.selection[0].assetId, greenMain.asset.assetId);
  assert.equal(linked.body.draft.selection[1].assetId, linked.body.asset.assetId);
  const saved = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
  assert.equal(saved.candidates[2].lifecycleV11.c2UploadDraft.uploads[1].assetRef, linked.body.asset.assetRef);
  assert.equal(saved.candidates[1].lifecycleV11.c2UploadDraft.uploads.length, 2);
  const beforeFinal = await readFile(dataFile, 'utf8');
  const c2Decision = await fetch(`${base}/api/candidates/${parent.id}/sibling-batch-c2-confirm`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ parentCandidateId: parent.id, parentRevision: parent.dataRevision, confirmed: true,
      members: [
        { candidateId: source.id, candidateRevision: 12, draftRevision: detail.draft.revision,
          approvedAssetIds: detail.draft.selection.map(item => item.assetId) },
        { candidateId: target.id, candidateRevision: 12, draftRevision: linked.body.draft.revision,
          approvedAssetIds: linked.body.draft.selection.map(item => item.assetId) }
      ] }) });
  assert.equal(c2Decision.status, 409, await c2Decision.clone().text());
  assert.match(JSON.stringify(await c2Decision.json()), /C1_|C2_|SIBLING_/);
  assert.equal(await readFile(dataFile, 'utf8'), beforeFinal);
});
