import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import {
  PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
  assertNoProductionSecrets,
  assertNoRawPersistenceKeys,
  assertCanonicalAnalysisAssetRef,
  assertCanonicalFrozenRef,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
import {
  C2_FINAL_MANIFEST_VERSION,
  assertC2FrozenContractCurrent,
  assertC2HasNoDownstreamState,
  assertValidC2AssetLifecycle,
  confirmFinalUploads,
  createC2AssetLifecycle,
  fingerprintC2AssetManifest,
  fingerprintC2FinalManifest,
  fingerprintC2SourceC1,
  normalizeC2FinalUploads,
  normalizeC2TargetContract,
  normalizeC2OwnerVideoRequirement,
  resolveC2FinalConfirmationTargetContract,
  resolveC2EffectiveVideoRequirement
} from "./c2-asset-lifecycle.mjs";

export const C2_SOFTWARE_INPUT_VERSION = "c2-software-input-v1";
export const C2_SOFTWARE_TECHNICAL_FAILURE_RECORD_VERSION = "c2-software-technical-failure-record-v1";
export { C2_FINAL_MANIFEST_VERSION };

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return fingerprintCanonicalRecord(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assertExpectedRevision(skuPackage, expectedDataRevision) {
  if (!Number.isInteger(expectedDataRevision) || skuPackage.dataRevision !== expectedDataRevision) {
    throw new Error(`C2_SOFTWARE_REVISION_CONFLICT: 期望${expectedDataRevision}，当前${skuPackage.dataRevision}`);
  }
}

function assertSha256(value, field) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw new Error(`C2_SOFTWARE_ASSET_INVALID: ${field}必须是SHA256`);
}

function assertUsageAuthorization(value, allowedStatus, field) {
  if (!isObject(value) || value.status !== allowedStatus || !nonEmpty(value.evidenceRef)) {
    throw new Error(`C2_SOFTWARE_ASSET_INVALID: ${field}缺少${allowedStatus}授权证据`);
  }
}

function assertNoSensitiveC2SourceSnapshots(skuPackage) {
  const activeProfitModel = skuPackage.profitModels?.find(
    (model) => model.profitModelVersion === skuPackage.activeProfitModelVersion
  );
  const sourceSnapshots = {
    selectedSupplySnapshot: skuPackage.selectedSupplySnapshot,
    activeProfitModel
  };
  try {
    assertNoProductionSecrets(sourceSnapshots, "skuPackage.c2SourceSnapshots");
  } catch (error) {
    const message = String(error?.message || "");
    if (message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:")) {
      throw new Error("C2_SOFTWARE_SENSITIVE_INPUT_REJECTED: C2源快照不得包含秘密");
    }
    if (message.startsWith(`${PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED}:`)) {
      throw new Error(`C2_SOFTWARE_SENSITIVE_INPUT_REJECTED:${message}`);
    }
    throw error;
  }
  assertNoRawPersistenceKeys({ ...sourceSnapshots, c1ProductPlan: skuPackage.c1ProductPlan }, "skuPackage.c2SourceSnapshots", {
    errorCode: "C2_SOFTWARE_SENSITIVE_INPUT_REJECTED"
  });
  try {
    assertNoProductionSecrets({ frozenC1Handoff: skuPackage.c1ProductPlan }, "skuPackage.c2SourceSnapshots.c1ProductPlan");
  } catch (error) {
    if (String(error?.message || "").startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:")) {
      throw new Error("C2_C1_CANONICAL_GATE_BLOCKED: C1 canonical不得包含秘密");
    }
    throw error;
  }
}

function validateCommonAsset(asset, path) {
  assertNoRawPersistenceKeys(asset, path, { errorCode: "C2_SOFTWARE_SENSITIVE_INPUT_REJECTED" });
  assertNoProductionSecrets(asset, path);
  if (!isObject(asset) || !nonEmpty(asset.assetId) || !["image", "video"].includes(asset.mediaType) ||
      !nonEmpty(asset.assetRef) || !nonEmpty(asset.assetVersion) || !nonEmpty(asset.sourceEvidenceRef)) {
    throw new Error(`C2_SOFTWARE_ASSET_INVALID: ${path}缺少身份、版本、来源或引用`);
  }
  assertSha256(asset.sha256, `${path}.sha256`);
  assertCanonicalAnalysisAssetRef(asset.assetRef, `${path}.assetRef`);
  for (const [field, ref] of [
    ["assetId", asset.assetId],
    ["assetVersion", asset.assetVersion],
    ["sourceEvidenceRef", asset.sourceEvidenceRef],
    ["usageAuthorization.evidenceRef", asset.usageAuthorization?.evidenceRef]
  ]) assertCanonicalFrozenRef(ref, `${path}.${field}`);
}

function normalizeCollected(asset, preparedAt) {
  validateCommonAsset(asset, "assets.collected");
  if (!["ozon", "wb", "1688", "pinduoduo"].includes(asset.sourcePlatform)) {
    throw new Error("C2_SOFTWARE_ASSET_INVALID: collected来源平台无效");
  }
  assertUsageAuthorization(asset.usageAuthorization, "analysis_reference_only", "assets.collected.usageAuthorization");
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    sourcePlatform: asset.sourcePlatform,
    sourceEvidenceRef: asset.sourceEvidenceRef,
    assetVersion: asset.assetVersion,
    sha256: asset.sha256,
    usageAuthorization: { status: "analysis_reference_only", evidenceRef: asset.usageAuthorization.evidenceRef },
    addedAt: asset.addedAt || preparedAt,
    lifecycleArea: "collected",
    usagePolicy: "analysis_reference_only",
    productionEligible: false
  };
}

function normalizeAiDraft(asset, preparedAt) {
  validateCommonAsset(asset, "assets.aiDrafts");
  if (!nonEmpty(asset.generatorRef)) throw new Error("C2_SOFTWARE_ASSET_INVALID: AI草稿必须保留生成回执");
  assertCanonicalFrozenRef(asset.generatorRef, "assets.aiDrafts.generatorRef");
  assertUsageAuthorization(asset.usageAuthorization, "draft_reference_only", "assets.aiDrafts.usageAuthorization");
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    assetVersion: asset.assetVersion,
    sha256: asset.sha256,
    sourceType: "ai_generated_draft",
    generatorRef: asset.generatorRef,
    sourceEvidenceRef: asset.sourceEvidenceRef,
    usageAuthorization: { status: "draft_reference_only", evidenceRef: asset.usageAuthorization.evidenceRef },
    addedAt: asset.addedAt || preparedAt,
    lifecycleArea: "aiDrafts",
    productionEligible: false
  };
}

function normalizeInitialRegions(assetRegions, preparedAt) {
  if (!isObject(assetRegions) || !Array.isArray(assetRegions.collected) ||
      !Array.isArray(assetRegions.aiDrafts) || !Array.isArray(assetRegions.finalUploads)) {
    throw new Error("C2_SOFTWARE_INPUT_INVALID: 必须显式提供三个素材区域");
  }
  if (assetRegions.finalUploads.length !== 0) {
    throw new Error("C2_SOFTWARE_OWNER_CONFIRMATION_REQUIRED: 创建容器时不得预填finalUploads");
  }
  const collected = assetRegions.collected.map((asset) => normalizeCollected(asset, preparedAt));
  const aiDrafts = assetRegions.aiDrafts.map((asset) => normalizeAiDraft(asset, preparedAt));
  const allIds = [...collected, ...aiDrafts].map((asset) => asset.assetId);
  if (new Set(allIds).size !== allIds.length) throw new Error("C2_SOFTWARE_ASSET_INVALID: 素材ID不得跨区域重复");
  return { collected, aiDrafts, finalUploads: [] };
}

function c1InputSnapshot(plan, canonicalC1) {
  return {
    verifiedFacts: {
      exactSkuVerification: structuredClone(plan.exactSkuVerification),
      productAttributes: structuredClone(plan.productAttributes),
      platformCategory: structuredClone(plan.platformCategory),
      schemaSnapshot: structuredClone(plan.schemaSnapshot),
      batteryAssessment: structuredClone(plan.batteryAssessment),
      categoryRestrictions: structuredClone(plan.categoryRestrictions),
      platformCompliance: structuredClone(plan.platformCompliance),
      unknownManifest: structuredClone(plan.unknownManifest)
    },
    seoDraft: {
      status: "draft_only",
      title: structuredClone(plan.seoTitleDraft),
      description: structuredClone(plan.descriptionDraft),
      bulletPoints: structuredClone(plan.bulletPointsDraft),
      searchKeywords: structuredClone(plan.searchKeywordsDraft),
      evidenceLayer: structuredClone(plan.seoEvidenceLayer)
    },
    canonicalHandoff: structuredClone(canonicalC1)
  };
}

export function prepareC2SoftwareInput({ skuPackage, expectedDataRevision, assetRegions, preparedAt }) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertExpectedRevision(skuPackage, expectedDataRevision);
  assertNoSensitiveC2SourceSnapshots(skuPackage);
  if (skuPackage.businessPhase !== "C1" || skuPackage.c1ProductPlan?.status !== "seo_draft_ready") {
    throw new Error("C2_SOFTWARE_GATE_REJECTED: 当前SKU不是已完成SEO草稿的C1");
  }
  const targetContract = normalizeC2TargetContract(skuPackage);
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: preparedAt });

  if (!isoDateTime(preparedAt)) throw new Error("C2_SOFTWARE_INPUT_INVALID: 准备时间无效");
  const normalizedAssets = normalizeInitialRegions(assetRegions, preparedAt);
  const sourceC1Fingerprint = fingerprintC2SourceC1(skuPackage);
  const input = {
    schemaVersion: C2_SOFTWARE_INPUT_VERSION,
    status: "ready",
    preparedAt,
    expectedDataRevision,
    identity: structuredClone(targetContract.g1Identity),
    variantKey: targetContract.variantKey,
    sourceC1Fingerprint,
    c1: c1InputSnapshot(skuPackage.c1ProductPlan, targetContract.canonicalC1),
    assets: normalizedAssets,
    executionPolicy: {
      externalAccessAllowed: false,
      imageGenerationAllowed: false,
      xiaohouziAllowed: false,
      gptImageAllowed: false,
      gateway4318Allowed: false,
      codexDispatchAllowed: false,
      productionAllowed: false,
      automaticRetry: false
    }
  };
  return deepFreeze({ ...input, inputFingerprint: sha256(input) });
}

export function createC2SoftwareContainer({ skuPackage, expectedDataRevision, assetRegions, createdAt }) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertExpectedRevision(skuPackage, expectedDataRevision);
  const sourceC1Fingerprint = fingerprintC2SourceC1(skuPackage);
  if (skuPackage.c2FinalAssets !== null) {
    if (!isObject(skuPackage.c2FinalAssets.softwareState)) {
      throw new Error("C2_SOFTWARE_LEGACY_STATE_REQUIRES_MIGRATION: 历史C2可继续读取，但不能冒充新软件状态");
    }
    assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
    assertC2FrozenContractCurrent(skuPackage);
    if (skuPackage.c2FinalAssets.softwareState.sourceC1Fingerprint !== sourceC1Fingerprint) {
      throw new Error("C2_SOFTWARE_SOURCE_DRIFT: 已存在C2绑定的C1事实、媒体要求或SEO版本不同");
    }
    const requestedAssets = normalizeInitialRegions(assetRegions, skuPackage.c2FinalAssets.createdAt);
    const storedInitialAssets = {
      collected: skuPackage.c2FinalAssets.assets.collected,
      aiDrafts: skuPackage.c2FinalAssets.assets.aiDrafts,
      finalUploads: []
    };
    if (fingerprintC2AssetManifest(storedInitialAssets) !== fingerprintC2AssetManifest(requestedAssets)) {
      throw new Error("C2_SOFTWARE_ASSET_MANIFEST_CONFLICT: 已存在C2绑定的初始素材版本不同");
    }
    return deepFreeze({
      flowVersion: "c2-software-container-flow-v1",
      idempotent: true,
      state: skuPackage.c2FinalAssets.softwareState.lifecycleStatus,
      skuPackage: structuredClone(skuPackage),
      c2AssetLifecycle: structuredClone(skuPackage.c2FinalAssets),
      ownerAction: skuPackage.ownerAction,
      confirmationCardPreparationReady: skuPackage.c2FinalAssets.status === "completed",
      productionAuthorizationCreated: false,
      dHandoffCreated: false
    });
  }
  const prepared = prepareC2SoftwareInput({ skuPackage, expectedDataRevision, assetRegions, preparedAt: createdAt });
  const created = createC2AssetLifecycle({
    skuPackage,
    collectedAssets: prepared.assets.collected,
    aiDraftAssets: prepared.assets.aiDrafts,
    createdAt
  });
  return deepFreeze({
    flowVersion: "c2-software-container-flow-v1",
    idempotent: false,
    state: "c2_waiting_final_uploads",
    skuPackage: created.skuPackage,
    c2AssetLifecycle: created.c2AssetLifecycle,
    preparedInput: prepared,
    ownerAction: "provide_final_assets",
    confirmationCardPreparationReady: false,
    productionAuthorizationCreated: false,
    dHandoffCreated: false
  });
}

function normalizeFinalAssets({ skuPackage, finalUploadAssets, effectiveVideoRequirement, addedAt }) {
  const normalized = normalizeC2FinalUploads({
    finalUploadAssets,
    existingAssets: skuPackage.c2FinalAssets.assets,
    effectiveVideoRequirement,
    addedAt
  });
  const assetIds = normalized.assets.map((asset) => asset.assetId);
  const manifestSha256 = fingerprintC2FinalManifest({
    authorizedMediaFingerprint: normalized.authorizedMediaFingerprint,
    effectiveVideoRequirement,
    mainImageAssetId: normalized.mainImageAssetId,
    videoDisposition: normalized.videoDisposition,
    assets: normalized.assets
  });
  return {
    ...normalized,
    assetIds,
    manifestSha256
  };
}

export function prepareC2FinalUploadManifest({
  skuPackage,
  expectedDataRevision,
  finalUploadAssets,
  ownerVideoRequirement = null,
  preparedAt
}) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertExpectedRevision(skuPackage, expectedDataRevision);
  if (!isObject(skuPackage.c2FinalAssets.softwareState)) {
    throw new Error("C2_SOFTWARE_LEGACY_STATE_REQUIRES_MIGRATION: 历史C2需由总控显式迁移后再确认");
  }
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads") {
    throw new Error("C2_SOFTWARE_GATE_REJECTED: 当前C2不在等待最终素材状态");
  }
  if (!isoDateTime(preparedAt)) throw new Error("C2_SOFTWARE_INPUT_INVALID: 最终素材清单时间无效");
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: preparedAt });
  const targetContract = resolveC2FinalConfirmationTargetContract(skuPackage);
  const normalizedOwnerVideoRequirement = normalizeC2OwnerVideoRequirement(ownerVideoRequirement, skuPackage);
  const effectiveVideoRequirement = resolveC2EffectiveVideoRequirement({
    skuPackage,
    ownerVideoRequirement: normalizedOwnerVideoRequirement
  });
  const manifest = normalizeFinalAssets({
    skuPackage,
    finalUploadAssets,
    effectiveVideoRequirement,
    addedAt: preparedAt
  });
  return deepFreeze({
    schemaVersion: C2_FINAL_MANIFEST_VERSION,
    status: "awaiting_owner_confirmation",
    preparedAt,
    skuPackageId: skuPackage.skuPackageId,
    sourceDataRevision: skuPackage.dataRevision,
    sourceC1Fingerprint: targetContract.targetContext.sourceC1Fingerprint,
    authorizedMediaFingerprint: manifest.authorizedMediaFingerprint,
    ownerVideoRequirement: structuredClone(normalizedOwnerVideoRequirement),
    effectiveVideoRequirement,
    manifestSha256: manifest.manifestSha256,
    approvedAssetIds: manifest.assetIds,
    mainImageAssetId: manifest.mainImageAssetId,
    videoDisposition: manifest.videoDisposition,
    assets: manifest.assets,
    ownerDecision: null,
    productionAuthorizationCreated: false,
    productionStarted: false
  });
}

export function confirmC2SoftwareFinalUploads({
  skuPackage,
  expectedDataRevision,
  finalManifest,
  ownerDecision,
  confirmedAt
}) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertExpectedRevision(skuPackage, expectedDataRevision);
  if (!isObject(skuPackage.c2FinalAssets.softwareState)) {
    throw new Error("C2_SOFTWARE_LEGACY_STATE_REQUIRES_MIGRATION: 历史C2需由总控显式迁移后再进入软件流");
  }
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (!isoDateTime(confirmedAt)) throw new Error("C2_SOFTWARE_INPUT_INVALID: 确认时间无效");
  if (!isObject(finalManifest) || finalManifest.schemaVersion !== C2_FINAL_MANIFEST_VERSION ||
      finalManifest.status !== "awaiting_owner_confirmation" || finalManifest.skuPackageId !== skuPackage.skuPackageId ||
      !Number.isInteger(finalManifest.sourceDataRevision) || !Array.isArray(finalManifest.assets)) {
    throw new Error("C2_SOFTWARE_FINAL_MANIFEST_INVALID: 必须使用当前SKU和修订生成的冻结最终素材清单");
  }
  const completed = skuPackage.c2FinalAssets.status === "completed";
  if ((!completed && finalManifest.sourceDataRevision !== skuPackage.dataRevision) ||
      (completed && finalManifest.sourceDataRevision !== skuPackage.c2FinalAssets.productionAuthorizationPreparation?.sourceDataRevision)) {
    throw new Error("C2_SOFTWARE_FINAL_MANIFEST_INVALID: 最终素材清单revision与当前确认状态不一致");
  }
  const targetContract = resolveC2FinalConfirmationTargetContract(skuPackage);
  const effectiveVideoRequirement = resolveC2EffectiveVideoRequirement({
    skuPackage: completed
      ? { ...skuPackage, dataRevision: finalManifest.sourceDataRevision }
      : skuPackage,
    ownerVideoRequirement: finalManifest.ownerVideoRequirement
  });
  if (!sameJson(effectiveVideoRequirement, finalManifest.effectiveVideoRequirement) ||
      finalManifest.sourceC1Fingerprint !== targetContract.targetContext.sourceC1Fingerprint) {
    throw new Error("C2_SOFTWARE_FINAL_MANIFEST_INVALID: C1来源或条件视频合同已漂移");
  }
  const manifest = normalizeFinalAssets({
    skuPackage,
    finalUploadAssets: finalManifest.assets,
    effectiveVideoRequirement,
    addedAt: finalManifest.preparedAt
  });
  if (manifest.manifestSha256 !== finalManifest.manifestSha256 ||
      manifest.authorizedMediaFingerprint !== finalManifest.authorizedMediaFingerprint ||
      manifest.mainImageAssetId !== finalManifest.mainImageAssetId ||
      manifest.videoDisposition !== finalManifest.videoDisposition ||
      !sameJson(manifest.assetIds, finalManifest.approvedAssetIds)) {
    throw new Error("C2_SOFTWARE_FINAL_MANIFEST_INVALID: 最终素材清单内容或指纹已漂移");
  }
  if (!isObject(ownerDecision) || ownerDecision.status !== "confirmed" || ownerDecision.confirmedBy !== "owner" ||
      ownerDecision.approvedManifestVersion !== C2_FINAL_MANIFEST_VERSION ||
      ownerDecision.approvedManifestSha256 !== manifest.manifestSha256 ||
      ownerDecision.approvedAuthorizedMediaFingerprint !== manifest.authorizedMediaFingerprint ||
      ownerDecision.approvedMainImageAssetId !== manifest.mainImageAssetId ||
      ownerDecision.approvedVideoDisposition !== manifest.videoDisposition ||
      !sameJson(ownerDecision.approvedAssetIds, manifest.assetIds)) {
    throw new Error("C2_SOFTWARE_OWNER_CONFIRMATION_REQUIRED: 主人确认必须锁定最终素材版本、SHA256、ID顺序、首图、实际授权图片地址清单和视频处置");
  }
  assertNoRawPersistenceKeys(ownerDecision, "ownerDecision", { errorCode: "C2_SOFTWARE_SENSITIVE_INPUT_REJECTED" });
  assertNoProductionSecrets(ownerDecision, "ownerDecision");
  if (ownerDecision.confirmationNote !== undefined && ownerDecision.confirmationNote !== null) {
    throw new Error("C2_SOFTWARE_SENSITIVE_INPUT_REJECTED: 主人确认不得持久化自由文本备注");
  }
  if (completed) {
    const confirmation = skuPackage.c2FinalAssets.ownerFinalUploadConfirmation;
    if (skuPackage.c2FinalAssets.softwareState.assetManifestFingerprint !== fingerprintC2AssetManifest(skuPackage.c2FinalAssets.assets) ||
        !sameJson(skuPackage.c2FinalAssets.assets.finalUploads, manifest.assets) ||
        confirmation.approvedManifestSha256 !== manifest.manifestSha256 ||
        confirmation.approvedMainImageAssetId !== manifest.mainImageAssetId ||
        confirmation.approvedVideoDisposition !== manifest.videoDisposition) {
      throw new Error("C2_SOFTWARE_FINAL_MANIFEST_CONFLICT: 已确认清单与本次输入不一致");
    }
    return deepFreeze({
      flowVersion: "c2-software-final-confirmation-flow-v1",
      idempotent: true,
      state: "c2_ready",
      skuPackage: structuredClone(skuPackage),
      c2AssetLifecycle: structuredClone(skuPackage.c2FinalAssets),
      confirmationCardPreparationReady: true,
      productionAuthorizationPreparation: structuredClone(skuPackage.c2FinalAssets.productionAuthorizationPreparation),
      productionAuthorizationCreated: false,
      dHandoffCreated: false
    });
  }
  const confirmed = confirmFinalUploads({
    skuPackage,
    finalUploadAssets: manifest.assets,
    ownerVideoRequirement: finalManifest.ownerVideoRequirement,
    ownerDecision,
    confirmedAt
  });
  return deepFreeze({
    flowVersion: "c2-software-final-confirmation-flow-v1",
    idempotent: false,
    state: "c2_ready",
    skuPackage: confirmed.skuPackage,
    c2AssetLifecycle: confirmed.c2AssetLifecycle,
    finalManifest: {
      schemaVersion: C2_FINAL_MANIFEST_VERSION,
      manifestSha256: manifest.manifestSha256,
      authorizedMediaFingerprint: manifest.authorizedMediaFingerprint,
      mainImageAssetId: manifest.mainImageAssetId,
      videoDisposition: manifest.videoDisposition,
      assets: manifest.assets
    },
    confirmationCardPreparationReady: true,
    productionAuthorizationPreparation: structuredClone(confirmed.c2AssetLifecycle.productionAuthorizationPreparation),
    productionAuthorizationCreated: false,
    dHandoffCreated: false
  });
}

export function recordC2SoftwareTechnicalFailure({ skuPackage, expectedDataRevision, failure, failedAt }) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertExpectedRevision(skuPackage, expectedDataRevision);
  if (!isObject(skuPackage.c2FinalAssets.softwareState)) {
    throw new Error("C2_SOFTWARE_LEGACY_STATE_REQUIRES_MIGRATION: 历史C2需由总控显式迁移后再记录软件技术状态");
  }
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  assertC2FrozenContractCurrent(skuPackage);
  assertNoProductionSecrets(failure, "technicalFailureRecord.failure");
  assertNoRawPersistenceKeys(failure, "failure", { errorCode: "C2_SOFTWARE_SENSITIVE_INPUT_REJECTED" });
  if (!isObject(failure) ||
      !sameJson(Object.keys(failure).sort(), ["layer", "failureClass", "code", "evidenceRef"].sort()) ||
      !nonEmpty(failure.layer) || failure.layer.length > 64 ||
      !nonEmpty(failure.failureClass) || failure.failureClass.length > 64 ||
      !/^[A-Z0-9_]{1,64}$/.test(String(failure.code || "")) ||
      !nonEmpty(failure.evidenceRef) || failure.evidenceRef.length > 256 || !isoDateTime(failedAt)) {
    throw new Error("C2_SOFTWARE_FAILURE_INVALID: 只能记录固定失败层、分类、代码、脱敏证据引用和时间");
  }
  assertCanonicalFrozenRef(failure.evidenceRef, "technicalFailureRecord.failure.evidenceRef");
  const recordCore = {
    schemaVersion: C2_SOFTWARE_TECHNICAL_FAILURE_RECORD_VERSION,
    candidateId: skuPackage.g1Identity.candidateId,
    skuPackageId: skuPackage.skuPackageId,
    assetPackageId: skuPackage.c2FinalAssets.assetPackageId,
    sourceDataRevision: skuPackage.dataRevision,
    businessPhase: skuPackage.businessPhase,
    lifecycleStatus: skuPackage.c2FinalAssets.softwareState.lifecycleStatus,
    sourceC1Fingerprint: skuPackage.c2FinalAssets.softwareState.sourceC1Fingerprint,
    assetManifestFingerprint: skuPackage.c2FinalAssets.softwareState.assetManifestFingerprint,
    failure: {
      layer: failure.layer,
      failureClass: failure.failureClass,
      code: failure.code,
      evidenceRef: failure.evidenceRef,
      failedAt
    },
    automaticRetry: false
  };
  const failureRecordId = `c2-technical-failure:${sha256(recordCore)}`;
  const technicalFailureRecord = deepFreeze({
    ...recordCore,
    failureRecordId,
    status: "stopped",
    businessResultChanged: false,
    c1Changed: false,
    productionStarted: false,
    productionAuthorizationCreated: false,
    dHandoffCreated: false,
    recordedAt: failedAt,
    auditEvent: {
      event: "c2_software_technical_failure_stopped",
      at: failedAt,
      failureRecordId,
      sourceDataRevision: skuPackage.dataRevision,
      automaticRetry: false,
      businessResultChanged: false,
      c1Changed: false,
      productionStarted: false
    }
  });
  return deepFreeze({
    flowVersion: "c2-software-failure-flow-v1",
    state: skuPackage.c2FinalAssets.softwareState.lifecycleStatus,
    technicalStatus: "failed",
    automaticRetry: false,
    candidateChanged: false,
    skuPackage: structuredClone(skuPackage),
    technicalFailureRecord,
    productionAuthorizationCreated: false,
    dHandoffCreated: false
  });
}
