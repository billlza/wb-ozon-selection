import test from "node:test";
import { authorizedProductionFixture, localFinalAssets } from "./helpers/c2-software-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertCurrentC2UploadDraft, reserveC2Upload, settleC2Upload, saveC2UploadSelection, selectedC2DraftAssets, resolveRegisteredC2FinalAsset } from "../lib/c2-upload-draft.mjs";
import { createC2LocalAssetStore, normalizeC2LocalUpload } from "../lib/c2-local-asset-store.mjs";

const TIME = "2026-09-07T00:00:00.000Z";
const ID = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000002";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const metadata = { fileName: "main.png", mediaType: "image", contentType: "image/png", startedAt: TIME };
function candidate() {
  return { id: "candidate-1", dataRevision: 12, lifecycleV11: { skuPackage: {
    skuPackageId: "sku-1", dataRevision: 8, businessPhase: "C2", c2FinalAssets: {
      status: "awaiting_final_uploads", softwareState: { sourceC1Fingerprint: "a".repeat(64) },
      targetContext: { schemaEvidenceRef: "schema:evidence:1" }
    }
  } } };
}
function reserve(current, uploadId = ID) {
  const draft = reserveC2Upload(current, { dataRevision: current.dataRevision, draftRevision: current.lifecycleV11.c2UploadDraft?.revision ?? 0, uploadId, ...metadata });
  current.lifecycleV11.c2UploadDraft = draft;
  return draft.uploads.find(upload => upload.uploadId === uploadId);
}

test("C2 local file and draft survive JSON save/reopen with selection and source revisions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "c2-upload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createC2LocalAssetStore({ directory: path.join(directory, "files") });
  const current = candidate();
  const sourceBefore = structuredClone(current.lifecycleV11.skuPackage);
  const upload = reserve(current);
  const asset = await store.write(upload, PNG);
  assert.equal(asset.width, 2);
  assert.equal(asset.height, 3);
  current.lifecycleV11.c2UploadDraft = settleC2Upload(current.lifecycleV11.c2UploadDraft, { uploadId: ID, asset, settledAt: TIME });
  current.lifecycleV11.c2UploadDraft = saveC2UploadSelection(current, {
    dataRevision: 12, draftRevision: 2, selection: [{ assetId: asset.assetId, order: 1 }]
  });
  const stateFile = path.join(directory, "state.json");
  await writeFile(stateFile, JSON.stringify(current));
  const reloaded = JSON.parse(await readFile(stateFile, "utf8"));
  const recovered = selectedC2DraftAssets(reloaded.lifecycleV11.c2UploadDraft);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].order, 1);
  assert.equal(reloaded.lifecycleV11.c2UploadDraft.revision, 3);
  assert.deepEqual((await store.read(recovered[0])).body, PNG);
  assert.deepEqual(reloaded.lifecycleV11.skuPackage, sourceBefore);
  assert.equal(reloaded.dataRevision, 12);
  assert.equal(recovered[0].ownerConfirmed, undefined);
  assert.equal(recovered[0].productionEligible, undefined);
  assert.doesNotMatch(JSON.stringify(recovered), /\/Users\/|\/private\/|\/tmp\//);
  await assert.rejects(store.write(upload, PNG), { code: "EEXIST" });
  assert.deepEqual((await store.read(recovered[0])).body, PNG);
  await writeFile(path.join(directory, "files", ID), Buffer.concat([PNG.subarray(0, -1), Buffer.from([0])]));
  await assert.rejects(store.read(recovered[0]), error => error.extra.code === "c2_upload_file_changed");
});

test("one verified upload can be linked under an independent sibling asset identity", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c2-linked-upload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createC2LocalAssetStore({ directory: path.join(directory, "files") });
  const source = await store.write({ assetId: `c2-local:${ID}`, fileName: "main.png",
    mediaType: "image", contentType: "image/png", stagedAt: TIME }, PNG);
  const target = { assetId: `c2-local:${SECOND}`, fileName: "main.png",
    mediaType: "image", contentType: "image/png", stagedAt: TIME };
  const linked = await store.linkExisting(source, target);
  assert.equal(linked.assetId, target.assetId);
  assert.equal(linked.sha256, source.sha256);
  assert.notEqual(linked.assetRef, source.assetRef);
  assert.deepEqual((await store.read(linked, { verifyContent: true })).body, PNG);
  await assert.rejects(store.linkExisting(source, target), { code: "EEXIST" });
  await assert.rejects(store.linkExisting(source, { ...target, assetId: `c2-local:00000000-0000-4000-8000-000000000003`,
    fileName: "other.png" }), error => error.extra?.code === "c2_link_identity_invalid");
});

test("complete pixel decoding rejects signature-only and damaged images before publishing a file", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c2-decode-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createC2LocalAssetStore({ directory: path.join(directory, "files") });
  const upload = reserve(candidate());
  const damaged = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64");
  for (const bytes of [PNG.subarray(0, 12), PNG.subarray(0, 65), damaged]) {
    await assert.rejects(store.write(upload, bytes), error => error.extra.code === "c2_upload_content_invalid");
  }
  await assert.rejects(readFile(path.join(directory, "files", ID)), { code: "ENOENT" });
  const video = { ...upload, fileName: "clip.mp4", mediaType: "video", contentType: "video/mp4" };
  await assert.rejects(store.write(video, Buffer.from("0000ftypisom")), error => error.extra.code === "c2_video_validation_unavailable");
});

test("upload reservations reject concurrency, stale draft and source identity drift without mutation", () => {
  const current = candidate();
  reserve(current);
  const before = structuredClone(current);
  assert.throws(() => reserve(current, SECOND), error => error.extra.code === "c2_upload_unfinished");
  assert.deepEqual(current, before);
  assert.throws(() => assertCurrentC2UploadDraft(current, { dataRevision: 12, draftRevision: 0 }), error => error.extra.code === "c2_upload_draft_conflict");
  for (const change of [
    item => { item.id = "another-candidate"; },
    item => { item.lifecycleV11.skuPackage.skuPackageId = "another-sku"; },
    item => { item.lifecycleV11.skuPackage.dataRevision++; },
    item => { item.lifecycleV11.skuPackage.c2FinalAssets.targetContext.schemaEvidenceRef = "schema:evidence:other"; },
    item => { item.lifecycleV11.skuPackage.c2FinalAssets.softwareState.sourceC1Fingerprint = "d".repeat(64); }
  ]) {
    const altered = structuredClone(current); change(altered);
    assert.throws(() => assertCurrentC2UploadDraft(altered, { dataRevision: 12, draftRevision: 1 }), error => error.extra.code === "c2_upload_source_changed");
  }
  const restarted = JSON.parse(JSON.stringify(current));
  assert.throws(() => reserve(restarted, SECOND), error => error.extra.code === "c2_upload_unfinished");
});

test("failed local upload retains a visible record and cannot fabricate a successful file", () => {
  const current = candidate(); reserve(current);
  const incomplete = structuredClone(current.lifecycleV11.c2UploadDraft);
  const failed = settleC2Upload(incomplete, { uploadId: ID, failureCode: "file_storage_unconfirmed", settledAt: TIME });
  assert.equal(failed.uploads[0].status, "failed");
  assert.equal(failed.uploads[0].failureCode, "file_storage_unconfirmed");
  assert.deepEqual(selectedC2DraftAssets(failed), []);
  assert.equal(incomplete.uploads[0].status, "uploading");
  assert.throws(() => settleC2Upload(incomplete, { uploadId: ID, asset: { assetId: "foreign" }, settledAt: TIME }), error => error.extra.code === "c2_upload_receipt_invalid");
  for (const [name, type] of [["../../private.png", "image/png"], ["image.svg", "image/svg+xml"], ["image.png", "text/html"]]) {
    assert.throws(() => normalizeC2LocalUpload(name, type));
  }
});

test("selection is limited to registered ready assets and current platform slots", () => {
  const current = candidate(); reserve(current);
  const asset = { assetId: `c2-local:${ID}`, assetRef: `local-asset:c2-local:${ID}`, ...metadata,
    assetVersion: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64), byteSize: 100, stableUrlEvidenceRef: "not_applicable" };
  current.lifecycleV11.c2UploadDraft = settleC2Upload(current.lifecycleV11.c2UploadDraft, { uploadId: ID, asset, settledAt: TIME });
  const before = structuredClone(current);
  for (const selection of [
    [{ assetId: "foreign", order: 1 }],
    [{ assetId: asset.assetId, order: 2 }],
    [{ assetId: asset.assetId, order: 1, assetRef: "/private/file" }],
    [{ assetId: asset.assetId, order: 1, slotId: "main" }]
  ]) assert.throws(() => saveC2UploadSelection(current, { dataRevision: 12, draftRevision: 2, selection }), error => error.extra.code === "c2_upload_selection_invalid");
  assert.deepEqual(current, before);
});

test("平台没有张数上限，但主人排第一张的必须是图片", () => {
  const current = candidate();
  for (const uploadId of [ID, SECOND]) {
    const upload = reserve(current, uploadId);
    const asset = { ...upload, assetRef: `local-asset:${upload.assetId}`, sha256: `${uploadId === ID ? "a" : "b"}`.repeat(64), byteSize: 100 };
    current.lifecycleV11.c2UploadDraft = settleC2Upload(current.lifecycleV11.c2UploadDraft, { uploadId, asset, settledAt: TIME });
    current.lifecycleV11.c2UploadDraft = saveC2UploadSelection(current, { dataRevision: 12, draftRevision: current.lifecycleV11.c2UploadDraft.revision, selection: [] });
  }
  const selection = current.lifecycleV11.c2UploadDraft.uploads.map((asset, index) => ({ assetId: asset.assetId, order: index + 1 }));
  const saved = saveC2UploadSelection(current, { dataRevision: 12, draftRevision: 6, selection });
  assert.deepEqual(saved.selection, selection);
  current.lifecycleV11.c2UploadDraft.uploads[0].mediaType = "video";
  assert.throws(() => saveC2UploadSelection(current, { dataRevision: 12, draftRevision: 6, selection }), error => error.extra.code === "c2_upload_selection_invalid");
});

test("D读取仅接受当前授权的登记文件，保留解码所需MIME并拒绝错绑", () => {
  const fixture = authorizedProductionFixture({ assets: localFinalAssets() });
  const authorization = fixture.productionAuthorization;
  const uploads = authorization.lockedScope.finalUploads.map(asset => ({ ...structuredClone(asset), status: "ready", contentType: "image/jpeg" }));
  const source = { id: fixture.candidateId, dataRevision: fixture.candidateRevision, lifecycleV11: {
    skuPackage: fixture.skuPackage, c2UploadDraft: { schemaVersion: "c2-upload-draft-v1", candidateId: fixture.candidateId, skuPackageId: fixture.skuPackage.skuPackageId,
      sourceC1Fingerprint: authorization.sourceC1Fingerprint, schemaEvidenceRef: authorization.lockedScope.schemaEvidenceRef,
      uploads, selection: uploads.map(asset => ({ assetId: asset.assetId, order: asset.order })) }
  } };
  const frozen = authorization.lockedScope.finalUploads[0];
  assert.equal(resolveRegisteredC2FinalAsset(source, frozen).contentType, "image/jpeg");
  // 2026-09-23 主人决定：C1 改版后复用原素材确认是正常路径，登记仍指向旧 C1 不再据此拒绝；
  // 下面 candidateId、sha256、width、order、status 五条继续逐条兜住文件身份。
  const afterC1Revision = structuredClone(source);
  afterC1Revision.lifecycleV11.c2UploadDraft.sourceC1Fingerprint = "b".repeat(64);
  assert.equal(resolveRegisteredC2FinalAsset(afterC1Revision, frozen).contentType, "image/jpeg");
  for (const change of [
    value => { value.lifecycleV11.c2UploadDraft.candidateId = "another"; },
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].sha256 = "c".repeat(64); },
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].width += 1; },
    value => { value.lifecycleV11.c2UploadDraft.selection[0].order = 2; },
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].status = "failed"; }
  ]) {
    const changed = structuredClone(source); change(changed);
    assert.throws(() => resolveRegisteredC2FinalAsset(changed, frozen), /最终素材|未完成的文件/);
  }
  assert.throws(() => resolveRegisteredC2FinalAsset(source, { ...frozen, assetRef: "/etc/passwd" }), /最终素材/);
});

async function pricingDraftFixture() {
  const { finalPricingC1ReuseFixture } = await import('./fixtures/final-pricing-c1-reuse-fixture.mjs');
  const f = finalPricingC1ReuseFixture();
  const original = structuredClone(f.document.candidates[0]);
  const upload = reserve(original);
  original.lifecycleV11.c2UploadDraft = settleC2Upload(original.lifecycleV11.c2UploadDraft, {
    uploadId: ID, asset: { ...upload, assetRef: `local-asset:${upload.assetId}`, sha256: 'a'.repeat(64),
      byteSize: 100, width: 1000, height: 1000, assetVersion: 'synthetic-asset-v1' }, settledAt: TIME
  });
  original.lifecycleV11.c2UploadDraft = saveC2UploadSelection(original, {
    dataRevision: original.dataRevision, draftRevision: 2,
    selection: [{ assetId: upload.assetId, order: 1 }]
  });
  await f.usecase.review({ actor: f.actor, input: f.input });
  const target = (await f.repository.readSnapshot()).candidates[0];
  const resultCandidateRevision = target.dataRevision;
  target.dataRevision--;
  const history = target.lifecycleV11.finalPricingRevisionHistory.at(-1);
  history.previousC1References.c2UploadDraft = structuredClone(original.lifecycleV11.c2UploadDraft);
  return { target, original, args: { historyRevisionId: history.revisionId, resultCandidateRevision } };
}

test('pricing draft rebase preserves ready registration and selection without changing history or final uploads', async () => {
  const { rebaseC2UploadDraftAfterPricing } = await import('../lib/c2-pricing-upload-reuse.mjs');
  const { target, original, args } = await pricingDraftFixture();
  const bytes = JSON.stringify(target);
  const next = rebaseC2UploadDraftAfterPricing(target, args);
  assert.equal(next.sourceCandidateRevision, args.resultCandidateRevision);
  assert.equal(next.sourceSkuRevision, target.lifecycleV11.skuPackage.dataRevision);
  assert.notEqual(next.sourceC1Fingerprint, original.lifecycleV11.c2UploadDraft.sourceC1Fingerprint);
  assert.deepEqual(next.uploads, original.lifecycleV11.c2UploadDraft.uploads);
  assert.deepEqual(next.selection, original.lifecycleV11.c2UploadDraft.selection);
  assert.deepEqual(target.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads, []);
  assert.equal(JSON.stringify(target), bytes);
  const current = structuredClone(target); current.dataRevision = args.resultCandidateRevision;
  current.lifecycleV11.c2UploadDraft = next;
  assert.doesNotThrow(() => assertCurrentC2UploadDraft(current, { dataRevision: current.dataRevision, draftRevision: next.revision }));
});

test('pricing draft rebase rejects foreign or incomplete history and never filters failed uploads', async () => {
  const { rebaseC2UploadDraftAfterPricing } = await import('../lib/c2-pricing-upload-reuse.mjs');
  const { target, args } = await pricingDraftFixture();
  const mutations = [
    c => { c.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft.candidateId = 'different'; },
    c => { c.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft.sourceSkuRevision++; },
    c => { c.lifecycleV11.skuPackage.c2FinalAssets.targetContext.schemaRevision = 'schema-v9';  },
    c => { c.lifecycleV11.c1PricingReuse.status = 'blocked'; },
    c => { c.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft.uploads[0].status = 'uploading'; },
    c => { c.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft.uploads[0].status = 'failed'; },
    c => { delete c.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft.uploads[0].sha256; },
    c => { c.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft.selection[0].order = 2; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(target); mutate(changed); const bytes = JSON.stringify(changed);
    assert.throws(() => rebaseC2UploadDraftAfterPricing(changed, args), error => /^c2_upload_/.test(error.extra?.code));
    assert.equal(JSON.stringify(changed), bytes);
  }
  assert.throws(() => rebaseC2UploadDraftAfterPricing(target, { ...args, resultCandidateRevision: target.dataRevision }), error => error.extra.code === 'c2_upload_rebase_source_invalid');
  delete target.lifecycleV11.finalPricingRevisionHistory.at(-1).previousC1References.c2UploadDraft;
  assert.equal(rebaseC2UploadDraftAfterPricing(target, args), null);
});
