/**
 * 「上架」那一道确认：一件（非同款各色）Ozon 商品，主人传好图、排好顺序之后，在一张卡上看文案、属性、图片、店铺、价格和
 * 利润，点一次「上架」。这一下依次保存三条互相独立的记录，各自仍是主人本人的决定（AGENTS.md §7、§8.1、§9.1）：
 *   1. 这些图片按这个顺序作为上架素材（C2 最终素材确认，生成最终商品方案卡）；
 *   2. 按这张卡写入这个店铺的生产授权（ProductionAuthorization）；
 *   3. 写入前读一次这个店铺后台的只读许可（登录态读取授权，只读、限次、24 小时内有效）。
 * 卡在第 1 步之前先按同一份已保存资料「预演」出来给主人看，点的时候服务端再算一遍，指纹不同就不保存、请主人重看。
 * 本模块只做纯计算：预演卡、指纹、阶段判断和第 3 步的输入；真正的保存仍走原有的用例与路由逻辑。
 */
import { assertCurrentC2UploadDraft, selectedC2DraftAssets } from "./c2-upload-draft.mjs";
import { confirmC2SoftwareFinalUploads, prepareC2FinalUploadManifest } from "./c2-software-orchestrator.mjs";
import { createFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";
import { buildProductionOwnerPreparationView } from "./production-owner-preparation.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";

export const GATE2_LISTING_VIEW_SCHEMA_VERSION = "gate2-listing-view-v1";
export const GATE2_LISTING_PREVIEW_SCHEMA_VERSION = "gate2-listing-preview-v1";
export const GATE2_ACCOUNT_READ_HOURS = 24;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** 只管单件 Ozon 商品；同款各色走主人自己设计的整批工作区，这里不碰。已经授权或执行过的也不再算。 */
export function gate2ListingApplies(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  return isObject(sku) && candidate.targetPlatform === "ozon" && !candidate.siblingSourceV1 && !candidate.siblingPreparationDraftRefV1 &&
    !sku.productionAuthorization && !sku.productionRecord && !sku.dHandoff;
}

/**
 * images：还在等主人传图或排图；preview：图排好了，可以预演上架卡；card：方案卡已经存在、还没授权
 * （老商品，或上一次点「上架」停在了授权那一步）。别的情况返回 null。
 */
export function gate2ListingStage(candidate) {
  if (!gate2ListingApplies(candidate)) return null;
  const sku = candidate.lifecycleV11.skuPackage;
  const card = sku.productionConfirmationCard;
  if (sku.businessPhase === "C2" && isObject(card) && card.status === "awaiting_owner_business_confirmation" && card.ownerDecision === null) return "card";
  const c2 = sku.c2FinalAssets;
  if (sku.businessPhase !== "C2" || c2?.status !== "awaiting_final_uploads" || !isObject(c2.softwareState)) return null;
  const draft = candidate.lifecycleV11.c2UploadDraft;
  const uploads = Array.isArray(draft?.uploads) ? draft.uploads : [];
  if (!Array.isArray(draft?.selection) || draft.selection.length === 0 || uploads.some(upload => upload.status === "uploading")) return "images";
  return "preview";
}

/** 列表里每件商品都带的轻量一行；预演卡本身要单独取，免得列表变重。 */
export function buildGate2ListingView(candidate) {
  const stage = gate2ListingStage(candidate);
  return stage === null ? null : { schemaVersion: GATE2_LISTING_VIEW_SCHEMA_VERSION, stage };
}

/** 主人排定的素材变成上架素材时的样子。服务端核过文件内容之后用它；预演时不读文件，用同一个形状。 */
export function c2OwnerListingAsset(asset, index, { candidateId, dataRevision }) {
  const item = {};
  for (const key of ["assetId", "mediaType", "assetRef", "fileName", "assetVersion", "sha256", "byteSize", "sourceEvidenceRef",
    "stableUrlEvidenceRef", "sourceType", "width", "height", "order"]) {
    if (asset[key] !== undefined) item[key] = structuredClone(asset[key]);
  }
  // 主人排第一张的就是主图，软件不重排也不改选。
  return { ...item, role: index === 0 ? "main_image" : "gallery_image", addedAt: asset.stagedAt,
    usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: `owner-confirmation:c2:${candidateId}:${dataRevision}` } };
}

/** 主人在卡上看到、并据此决定的内容。时间戳和确认动作本身不算在里面。 */
export function gate2ListingFingerprint({ card, preparation }) {
  const { createdAt, c2Assets, ...rest } = card;
  return fingerprintCanonicalRecord({
    card: { ...rest, c2Assets: { sourceArea: c2Assets?.sourceArea ?? null, finalUploads: c2Assets?.finalUploads ?? null } },
    store: preparation?.store ?? null,
    scope: preparation?.scope ?? null,
    commercialDraft: preparation?.commercialDraft ?? null,
    executionBindings: preparation?.executionBindings ?? []
  });
}

/** 图片确认那一步要提交的内容，全部取自已保存的素材清单。 */
export function gate2FinalAssetInput(candidate) {
  const draft = candidate.lifecycleV11.c2UploadDraft;
  const assets = selectedC2DraftAssets(draft);
  if (!assets.length || assets[0].mediaType !== "image") throw new Error("GATE2_MAIN_IMAGE_REQUIRED");
  const includesVideo = assets.some(asset => asset.mediaType === "video");
  if (!includesVideo && candidate.lifecycleV11.skuPackage.c2FinalAssets.ownerVideoRequirement?.required === true) {
    throw new Error("GATE2_VIDEO_REQUIRED");
  }
  return {
    dataRevision: candidate.dataRevision,
    draftRevision: draft.revision,
    confirmed: true,
    finalUploadAssets: assets.map(asset => ({ assetId: asset.assetId, order: asset.order })),
    approvedAssetIds: assets.map(asset => asset.assetId),
    approvedMainImageAssetId: assets[0].assetId,
    approvedVideoDisposition: includesVideo ? "includes_video" : "excludes_video",
    confirmationNote: null
  };
}

function previewSkuPackage(candidate, observedAt) {
  const input = gate2FinalAssetInput(candidate);
  assertCurrentC2UploadDraft(candidate, { dataRevision: input.dataRevision, draftRevision: input.draftRevision });
  const skuPackage = candidate.lifecycleV11.skuPackage;
  const finalUploadAssets = selectedC2DraftAssets(candidate.lifecycleV11.c2UploadDraft)
    .map((asset, index) => c2OwnerListingAsset(asset, index, { candidateId: candidate.id, dataRevision: candidate.dataRevision }));
  const manifest = prepareC2FinalUploadManifest({ skuPackage, expectedDataRevision: skuPackage.dataRevision, finalUploadAssets, preparedAt: observedAt });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage, expectedDataRevision: skuPackage.dataRevision, finalManifest: manifest,
    ownerDecision: { status: "confirmed", confirmedBy: "owner", approvedManifestVersion: manifest.schemaVersion,
      approvedManifestSha256: manifest.manifestSha256, approvedAssetIds: manifest.approvedAssetIds,
      approvedAuthorizedMediaFingerprint: manifest.authorizedMediaFingerprint, approvedMainImageAssetId: input.approvedMainImageAssetId,
      approvedVideoDisposition: input.approvedVideoDisposition, confirmationNote: null },
    confirmedAt: observedAt });
  return createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: observedAt }).skuPackage;
}

const PREVIEW_ERROR_LINES = Object.freeze([
  [/^C2_UPLOAD|c2_upload/, "图片清单还没排好，或者还有图片没传完。"],
  [/^GATE2_MAIN_IMAGE_REQUIRED/, "排第一张的必须是图片，它就是主图。"],
  [/^GATE2_VIDEO_REQUIRED/, "这件商品要求有视频，清单里还没有。"],
  [/C1_SKU_RIGHTS|RIGHTS_REVIEW/, "品牌与权利声明过期了，要重新声明。"],
  [/^FINAL_PLAN_CARD_INPUT_GAP/, "利润结论不是「通过」，或者还缺资料，生成不了上架卡。"]
]);

function previewErrorGap(error) {
  const message = String(error?.extra?.code || error?.code || error?.message || "");
  const code = message.split(":", 1)[0] || "GATE2_PREVIEW_FAILED";
  const line = PREVIEW_ERROR_LINES.find(([pattern]) => pattern.test(message))?.[1] ?? "上架卡生成不了，软件已停下，没有保存任何东西。";
  return { code, message: line };
}

/**
 * 预演上架卡。preview 阶段在副本上走一遍「图片确认 → 生成方案卡」；card 阶段用已经存在的卡。
 * 返回给页面的只有画卡需要的那几块，外加生产准备视图（店铺、仓库、价格、库存、缺口）和指纹。
 */
export function buildGate2ListingPreview({ candidate, configuration, evidencePacks = [], currentCommissionCatalogs = [], observedAt }) {
  const stage = gate2ListingStage(candidate);
  if (stage === null || stage === "images") return { schemaVersion: GATE2_LISTING_PREVIEW_SCHEMA_VERSION, stage, ready: false, gaps: [] };
  let skuPackage;
  try {
    skuPackage = stage === "card" ? candidate.lifecycleV11.skuPackage : previewSkuPackage(candidate, observedAt);
  } catch (error) {
    return { schemaVersion: GATE2_LISTING_PREVIEW_SCHEMA_VERSION, stage, ready: false, gaps: [previewErrorGap(error)],
      candidateId: candidate.id, dataRevision: candidate.dataRevision };
  }
  const previewCandidate = { ...candidate, lifecycleV11: { ...candidate.lifecycleV11, skuPackage } };
  const preparation = buildProductionOwnerPreparationView({ candidate: previewCandidate, configuration, evidencePacks, currentCommissionCatalogs, observedAt });
  const card = skuPackage.productionConfirmationCard;
  const gaps = [...preparation.gaps];
  if (card.riskAndUnknowns?.blockingUnknownCount > 0 && !gaps.some(gap => gap.code === "PRODUCTION_FINAL_CARD_INCOMPLETE")) {
    gaps.push({ code: "PRODUCTION_FINAL_CARD_INCOMPLETE", message: "商品资料还有必须补齐的项" });
  }
  return {
    schemaVersion: GATE2_LISTING_PREVIEW_SCHEMA_VERSION,
    stage,
    candidateId: candidate.id,
    dataRevision: candidate.dataRevision,
    draftRevision: stage === "preview" ? candidate.lifecycleV11.c2UploadDraft.revision : null,
    ready: gaps.length === 0,
    gaps,
    skuPackage: {
      skuPackageId: skuPackage.skuPackageId,
      supplierSkuId: skuPackage.supplierSkuId,
      dataRevision: skuPackage.dataRevision,
      businessPhase: skuPackage.businessPhase,
      productionAuthorization: null,
      productionConfirmationCard: structuredClone(card),
      c2FinalAssets: { productionAuthorizationPreparation: structuredClone(skuPackage.c2FinalAssets.productionAuthorizationPreparation) }
    },
    productionOwnerPreparation: structuredClone(preparation),
    accountReadHours: GATE2_ACCOUNT_READ_HOURS,
    previewFingerprint: gate2ListingFingerprint({ card, preparation })
  };
}

/** 生产授权要提交的内容：卡和准备视图里的来源字段，加上主人在卡上填的货号和选的仓库。 */
export function gate2ProductionInput({ preparation, merchantSku, bindingId, configurationVersion }) {
  return { contractVersion: preparation.contractVersion, ...preparation.source, bindingId, configurationVersion,
    merchantSku: merchantSku.trim(), confirmExactScope: true };
}

/** 写入前那一次只读核验的许可：只给刚授权的那个仓库绑定，24 小时内有效；同一修订再点只会找回原来那次，不会再发。 */
export function gate2AccountReadInput({ preparation, authorization, observedAt }) {
  const binding = authorization?.executionBinding;
  const option = preparation?.options?.find(item => item.bindingId === binding?.bindingId && item.configurationVersion === binding?.configurationVersion);
  if (!option) return null;
  return {
    candidateId: preparation.candidateId,
    skuPackageId: preparation.skuPackageId,
    expectedRevision: preparation.expectedRevision,
    bindingId: option.bindingId,
    configurationVersion: option.configurationVersion,
    scopeRef: option.scopeRef,
    expiresAt: new Date(Date.parse(observedAt) + GATE2_ACCOUNT_READ_HOURS * 3600_000).toISOString(),
    confirmReadOnce: true,
    idempotencyKey: `gate2-account-read:${preparation.candidateId}:${preparation.expectedRevision}`
  };
}
