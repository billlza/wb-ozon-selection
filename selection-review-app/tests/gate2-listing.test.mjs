import test from "node:test";
import assert from "node:assert/strict";
import { buildGate2ListingPreview, buildGate2ListingView, c2OwnerListingAsset, gate2AccountReadInput, gate2ListingFingerprint,
  gate2ListingStage, gate2ProductionInput } from "../lib/gate2-listing.mjs";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";

const AT = "2026-10-11T08:00:00.000Z";

function product({ phase = "C2", c2Status = "awaiting_final_uploads", card = null, draft = null, extra = {}, sku = {} } = {}) {
  return { id: "cand-1", dataRevision: 9, targetPlatform: "ozon",
    lifecycleV11: { skuPackage: { skuPackageId: "sku-1", businessPhase: phase, dataRevision: 4, productionAuthorization: null, productionRecord: null,
      c2FinalAssets: { status: c2Status, softwareState: { sourceC1Fingerprint: "f" } }, productionConfirmationCard: card, ...sku },
    ...(draft ? { c2UploadDraft: draft } : {}) }, ...extra };
}
const arranged = (status = "ready") => ({ revision: 3, uploads: [{ assetId: "a1", status: "ready" }, { assetId: "a2", status }],
  selection: [{ assetId: "a1", order: 1 }] });
const openCard = { status: "awaiting_owner_business_confirmation", ownerDecision: null };

test("「上架」卡只管单件 Ozon 商品：等传图、图排好可以预演、卡已生成待授权；同款各色和已授权的不算", () => {
  assert.equal(gate2ListingStage(product()), "images");
  assert.equal(gate2ListingStage(product({ draft: arranged("uploading") })), "images", "还有图在传，不预演");
  assert.equal(gate2ListingStage(product({ draft: { revision: 1, uploads: [{ assetId: "a1", status: "ready" }], selection: [] } })), "images");
  assert.equal(gate2ListingStage(product({ draft: arranged() })), "preview");
  assert.equal(gate2ListingStage(product({ c2Status: "completed", card: openCard })), "card");
  assert.equal(gate2ListingStage(product({ c2Status: "completed", card: { ...openCard, ownerDecision: { id: "d" } } })), null);
  assert.equal(gate2ListingStage(product({ phase: "C1" })), null);
  assert.equal(gate2ListingStage(product({ draft: arranged(), extra: { siblingSourceV1: { parentCandidateId: "p" } } })), null);
  assert.equal(gate2ListingStage(product({ draft: arranged(), extra: { siblingPreparationDraftRefV1: { draftId: "x" } } })), null);
  assert.equal(gate2ListingStage(product({ draft: arranged(), extra: { targetPlatform: "wb" } })), null);
  assert.equal(gate2ListingStage(product({ card: openCard, sku: { productionAuthorization: { authorizationId: "a" } } })), null);
  assert.deepEqual(buildGate2ListingView(product({ draft: arranged() })), { schemaVersion: "gate2-listing-view-v1", stage: "preview" });
  assert.equal(buildGate2ListingView(product({ phase: "C1" })), null);
  assert.deepEqual(buildGate2ListingPreview({ candidate: product(), configuration: {}, observedAt: AT }),
    { schemaVersion: "gate2-listing-preview-v1", stage: "images", ready: false, gaps: [] });
});

test("上架素材的样子：主人排第一张的是主图，用途授权写明出自这一次确认", () => {
  const asset = { assetId: "a1", mediaType: "image", assetRef: "local-asset:a1", fileName: "1.png", sha256: "0".repeat(64), byteSize: 10,
    order: 1, stagedAt: AT, status: "ready", uploadId: "u" };
  assert.deepEqual(c2OwnerListingAsset(asset, 0, { candidateId: "cand-1", dataRevision: 9 }), { assetId: "a1", mediaType: "image",
    assetRef: "local-asset:a1", fileName: "1.png", sha256: "0".repeat(64), byteSize: 10, order: 1, role: "main_image", addedAt: AT,
    usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "owner-confirmation:c2:cand-1:9" } });
  assert.equal(c2OwnerListingAsset({ ...asset, order: 2 }, 1, { candidateId: "cand-1", dataRevision: 9 }).role, "gallery_image");
});

test("指纹只认主人看到的内容：卡生成的时间和确认动作本身不算，价格、图片或仓库变了就不同", () => {
  const source = productionOwnerDecisionFixture();
  const card = source.candidate.lifecycleV11.skuPackage.productionConfirmationCard;
  const preparation = source.preparedView;
  const base = gate2ListingFingerprint({ card, preparation });
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(gate2ListingFingerprint({ card: { ...card, createdAt: "2030-01-01T00:00:00.000Z",
    c2Assets: { ...card.c2Assets, ownerFinalUploadConfirmation: { confirmedAt: "2030-01-01T00:00:00.000Z" } } }, preparation }), base);
  assert.notEqual(gate2ListingFingerprint({ card, preparation: { ...preparation, scope: { ...preparation.scope, stock: 1 } } }), base);
  assert.ok(card.c2Assets.finalUploads.length > 1);
  assert.notEqual(gate2ListingFingerprint({ card: { ...card, c2Assets: { ...card.c2Assets,
    finalUploads: [...card.c2Assets.finalUploads].reverse() } }, preparation }), base);
  assert.notEqual(gate2ListingFingerprint({ card, preparation: { ...preparation, executionBindings: [] } }), base);
  // card 阶段：预演的就是已经保存的那张卡。
  const preview = buildGate2ListingPreview({ candidate: source.candidate, configuration: source.configuration,
    evidencePacks: source.evidencePacks, currentCommissionCatalogs: source.currentCommissionCatalogs, observedAt: source.formal.at });
  assert.equal(preview.stage, "card");
  assert.deepEqual(preview.skuPackage.productionConfirmationCard, card);
});

test("授权和核验的输入只取自卡与准备视图；核验许可只给刚授权的那个仓库，24 小时，同一修订再点找回原来那次", () => {
  const preparation = { contractVersion: "production-authorization-v1.2", source: { dataRevision: 9, skuRevision: 5, cardId: "card", cardRevision: 1,
    sourcePreparationFingerprint: "p", sourceFinalCardInputFingerprint: "i" } };
  assert.deepEqual(gate2ProductionInput({ preparation, merchantSku: "  SKU-1 ", bindingId: "b1", configurationVersion: "v1" }), {
    contractVersion: "production-authorization-v1.2", dataRevision: 9, skuRevision: 5, cardId: "card", cardRevision: 1,
    sourcePreparationFingerprint: "p", sourceFinalCardInputFingerprint: "i", bindingId: "b1", configurationVersion: "v1",
    merchantSku: "SKU-1", confirmExactScope: true });
  const read = { candidateId: "cand-1", skuPackageId: "sku-1", expectedRevision: 10,
    options: [{ bindingId: "b0", configurationVersion: "v1", scopeRef: "s0" }, { bindingId: "b1", configurationVersion: "v1", scopeRef: "s1" }] };
  const authorization = { authorizationId: "auth", executionBinding: { bindingId: "b1", configurationVersion: "v1", warehouseId: "1" } };
  assert.deepEqual(gate2AccountReadInput({ preparation: read, authorization, observedAt: AT }), { candidateId: "cand-1", skuPackageId: "sku-1",
    expectedRevision: 10, bindingId: "b1", configurationVersion: "v1", scopeRef: "s1", expiresAt: "2026-10-12T08:00:00.000Z",
    confirmReadOnce: true, idempotencyKey: "gate2-account-read:cand-1:10" });
  assert.equal(gate2AccountReadInput({ preparation: { ...read, options: [read.options[0]] }, authorization, observedAt: AT }), null);
  assert.equal(gate2AccountReadInput({ preparation: null, authorization, observedAt: AT }), null);
});
