import {
  assertCanonicalC2ReferenceTree,
  assertNoProductionSecrets,
  assertCanonicalFrozenRef,
  assertFinalAssetLocation,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";

export const PRODUCTION_AUTHORIZATION_PREPARATION_VERSION = "c2-production-authorization-preparation-v1";
export const PRODUCTION_AUTHORIZATION_PENDING_INPUTS_VERSION = "c2-authorization-pending-inputs-v1";
export const PRODUCTION_AUTHORIZATION_FINAL_CARD_INPUT_SNAPSHOT_VERSION = "c2-final-card-input-snapshot-v1";
export const PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION = "c2-final-manifest-v1";
export const PRODUCTION_AUTHORIZED_MEDIA_VERSION = "production-authorized-media-v1";
export const PRODUCTION_AUTHORIZATION_VERSION = "production-authorization-v1.2";
export const DRAFT_ONLY_PUBLISH_SCOPE = "create_draft_only";
export const VALIDATION_MODERATION_PUBLISH_SCOPE = "create_and_allow_validation_moderation";
export const PRODUCTION_PUBLISH_SCOPES = Object.freeze([DRAFT_ONLY_PUBLISH_SCOPE, VALIDATION_MODERATION_PUBLISH_SCOPE]);
export const PRODUCTION_WRITE_FIELDS = Object.freeze([
  "create_product", "title", "description", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"
]);

// One lexical contract for current configuration, persisted authorization and published schema.
const EXECUTION_BINDING_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$";
function positiveSafeIntegerPattern() {
  const maximum = String(Number.MAX_SAFE_INTEGER);
  const alternatives = [`[1-9][0-9]{0,${maximum.length - 2}}`];
  for (let index = 0; index < maximum.length; index += 1) {
    const minimumDigit = index === 0 ? 1 : 0;
    const largestDigit = Number(maximum[index]) - 1;
    if (largestDigit < minimumDigit) continue;
    const digit = largestDigit === minimumDigit ? String(minimumDigit) : `[${minimumDigit}-${largestDigit}]`;
    const remaining = maximum.length - index - 1;
    alternatives.push(`${maximum.slice(0, index)}${digit}${remaining ? `[0-9]{${remaining}}` : ""}`);
  }
  alternatives.push(maximum);
  return `^(?:${alternatives.join("|")})$`;
}
const EXECUTION_WAREHOUSE_ID_PATTERN = positiveSafeIntegerPattern();
export const PRODUCTION_EXECUTION_BINDING_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: Object.freeze(["bindingId", "configurationVersion", "warehouseId"]),
  properties: Object.freeze({
    bindingId: Object.freeze({ type: "string", pattern: EXECUTION_BINDING_ID_PATTERN }),
    configurationVersion: Object.freeze({ type: "string", pattern: EXECUTION_BINDING_ID_PATTERN }),
    warehouseId: Object.freeze({ type: "string", pattern: EXECUTION_WAREHOUSE_ID_PATTERN })
  })
});
const executionBindingIdPattern = new RegExp(EXECUTION_BINDING_ID_PATTERN);
const executionWarehouseIdPattern = new RegExp(EXECUTION_WAREHOUSE_ID_PATTERN);
export function isProductionExecutionBinding(binding) {
  return binding !== null && typeof binding === "object" && !Array.isArray(binding) && Object.keys(binding).length === 3 &&
    PRODUCTION_EXECUTION_BINDING_SCHEMA.required.every(field => Object.hasOwn(binding, field)) &&
    [binding.bindingId, binding.configurationVersion].every(value => typeof value === "string" && executionBindingIdPattern.test(value)) &&
    typeof binding.warehouseId === "string" && executionWarehouseIdPattern.test(binding.warehouseId) && Number.isSafeInteger(Number(binding.warehouseId));
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NOT_APPLICABLE = "not_applicable";
const PREPARATION_FIELDS = Object.freeze([
  "schemaVersion", "status", "skuPackageId", "sourceDataRevision", "resultDataRevision",
  "sourceC1Fingerprint", "authorizedMediaFingerprint", "finalManifestVersion",
  "finalManifestSha256", "finalUploadsFingerprint", "mainImageAssetId", "videoDisposition",
  "ownerConfirmationAt", "targetContext", "frozenC1Handoff", "finalUploads",
  "effectiveVideoRequirement", "ownerVideoRequirement", "ownerFinalUploadConfirmation",
  "finalCardInputSnapshot", "finalCardInputFingerprint", "ownerFinalCardAuthorizationDecision",
  "pendingAuthorizationInputs", "preparationFingerprint", "productionAuthorizationCreated", "dHandoffCreated"
]);
const FINAL_CARD_FIELDS = Object.freeze([
  "schemaVersion", "skuPackageId", "sourceDataRevision", "resultDataRevision", "sourceC1Fingerprint",
  "identity", "variantKey", "inheritedSalesSnapshotRefs", "selectedSupplySnapshot",
  "activeProfitModelVersion", "activeProfitModel", "c1Snapshot", "canonicalC1"
]);
const FINAL_UPLOAD_FIELDS = Object.freeze([
  "assetId", "mediaType", "assetRef", "fileName", "assetVersion", "sha256", "sourceEvidenceRef",
  "stableUrlEvidenceRef", "usageAuthorization", "sourceType", "order", "role", "byteSize",
  "width", "height", "addedAt", "lifecycleArea", "ownerConfirmed", "productionEligible"
]);
const TARGET_CONTEXT_FIELDS = Object.freeze([
  "platform", "targetStore", "storeRef", "schemaRevision", "schemaEvidenceRef"
]);
const OWNER_UPLOAD_CONFIRMATION_FIELDS = Object.freeze([
  "status", "confirmedBy", "confirmedAt", "approvedManifestVersion", "approvedManifestSha256",
  "approvedAuthorizedMediaFingerprint", "approvedAssetIds", "approvedMainImageAssetId",
  "approvedVideoDisposition", "confirmationNote"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function hasExactKeys(value, fields) {
  return isObject(value) && sameJson(Object.keys(value).sort(), [...fields].sort());
}

function sha256(value) {
  return fingerprintCanonicalRecord(value);
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(String(value || ""))) {
    throw new Error(`PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:${label}`);
  }
}

function assertFrozenRef(value, path) {
  if (!nonEmptyString(value)) throw new Error(`PRODUCTION_AUTHORIZATION_INPUT_GAP:${path}`);
  return assertCanonicalFrozenRef(value, path);
}

export function createPendingProductionAuthorizationInputs() {
  return {
    schemaVersion: PRODUCTION_AUTHORIZATION_PENDING_INPUTS_VERSION,
    status: "awaiting_independent_owner_authorization",
    merchantSku: null,
    credentialAlias: null,
    warehouseRef: null,
    stock: null,
    price: null,
    allowedWriteFields: null,
    exclusions: null,
    sourceConfirmationCardId: null,
    ownerBusinessDecision: null,
    buyerTargetPrice: null,
    platformWritePrice: null,
    priceConversion: null,
    publishScope: null,
    confirmedAt: null
  };
}

export function fingerprintFinalCardInputSnapshot(snapshot) {
  return sha256(snapshot);
}

export function fingerprintC1Snapshot(identity, c1Snapshot) {
  return sha256({ g1Identity: identity, c1Snapshot });
}

export function fingerprintFinalUploads(finalUploads) {
  return sha256({ collected: [], aiDrafts: [], finalUploads });
}

/**
 * 主人授权的那批图的身份：按主人给的顺序取实际公网地址，第一张是主图，其余按序进图库。
 * 接受最终素材对象数组（要求 order 从 1 连续）或已经排好序的地址数组，两边算出来必须一致，
 * 这样从主人确认、授权、计划投影一直到 D 真正拼 import 请求那一刻都能拿同一个值对照。
 */
export function authorizedMediaUrls(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("PRODUCTION_AUTHORIZED_MEDIA_INVALID:empty");
  }
  return assets.map((asset, index) => {
    if (typeof asset === "string") {
      if (!nonEmptyString(asset)) throw new Error(`PRODUCTION_AUTHORIZED_MEDIA_INVALID:[${index}]`);
      return asset;
    }
    if (!isObject(asset) || !nonEmptyString(asset.assetRef) || asset.order !== index + 1) {
      throw new Error(`PRODUCTION_AUTHORIZED_MEDIA_INVALID:[${index}]`);
    }
    return asset.assetRef;
  });
}

/**
 * 「主人授权的那批图」和「手上这批图」必须是同一批：地址、顺序、张数一处不差。
 * 每一道还要往下走的闸门都重算一次，别人中途换掉任何一张地址都会在这里停住。
 */
export function assertAuthorizedMediaUnchanged(assets, expectedFingerprint, label) {
  let actual = null;
  try {
    actual = fingerprintAuthorizedMedia(assets);
  } catch (error) {
    throw new Error(`PRODUCTION_AUTHORIZED_MEDIA_INVALID:${label}:${error.message}`);
  }
  if (!SHA256_PATTERN.test(String(expectedFingerprint || "")) || actual !== expectedFingerprint) {
    throw new Error(`PRODUCTION_AUTHORIZED_MEDIA_DRIFT:${label}`);
  }
  return actual;
}

export function fingerprintAuthorizedMedia(assets) {
  const urls = authorizedMediaUrls(assets);
  if (new Set(urls).size !== urls.length) {
    throw new Error("PRODUCTION_AUTHORIZED_MEDIA_INVALID:duplicate");
  }
  return sha256({
    schemaVersion: PRODUCTION_AUTHORIZED_MEDIA_VERSION,
    primaryImage: urls[0],
    images: urls.slice(1)
  });
}

export function fingerprintFinalManifest({
  authorizedMediaFingerprint,
  effectiveVideoRequirement,
  mainImageAssetId,
  videoDisposition,
  assets
}) {
  return sha256({
    schemaVersion: PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION,
    authorizedMediaFingerprint,
    effectiveVideoRequirement,
    mainImageAssetId,
    videoDisposition,
    assets
  });
}

export function fingerprintProductionAuthorizationPreparation(preparation) {
  if (!isObject(preparation)) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:object");
  }
  const { preparationFingerprint: _ignored, ...core } = preparation;
  return sha256(core);
}

function validateSourceIdentity(identity, { candidateId, skuPackage }) {
  if (!isObject(identity) || identity.schemaVersion !== "g1-identity-v1" || !isObject(identity.storeRef)) {
    throw new Error("PRODUCTION_AUTHORIZATION_IDENTITY_INVALID:g1Identity");
  }
  for (const field of ["candidateId", "skuPackageId", "platform", "supplierSkuId"]) {
    assertFrozenRef(identity[field], `identity.${field}`);
  }
  for (const field of ["stableStoreId", "platformStoreId", "mappingVersion"]) {
    assertFrozenRef(identity.storeRef[field], `identity.storeRef.${field}`);
  }
  if (identity.candidateId !== candidateId || identity.skuPackageId !== skuPackage.skuPackageId ||
      identity.platform !== skuPackage.targetPlatform || identity.supplierSkuId !== skuPackage.supplierSkuId ||
      identity.storeRef.stableStoreId !== skuPackage.targetStore) {
    throw new Error("PRODUCTION_AUTHORIZATION_IDENTITY_DRIFT:候选、SKU、平台、店铺或供应SKU不一致");
  }
  for (const field of ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    if (identity[field] !== NOT_APPLICABLE) {
      throw new Error(`PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:identity.${field}`);
    }
  }
  if (skuPackage.g1Identity !== undefined && !sameJson(skuPackage.g1Identity, identity)) {
    throw new Error("PRODUCTION_AUTHORIZATION_IDENTITY_DRIFT:skuPackage.g1Identity");
  }
}

function validateFinalUploads(preparation) {
  const assets = preparation.finalUploads;
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_INVALID:finalUploads");
  }
  const ids = new Set();
  const orders = new Set();
  let mainImages = 0;
  let videos = 0;
  for (const [index, asset] of assets.entries()) {
    if (!hasExactKeys(asset, FINAL_UPLOAD_FIELDS) || !nonEmptyString(asset.assetId) || !["image", "video"].includes(asset.mediaType) ||
        !nonEmptyString(asset.assetRef) || !nonEmptyString(asset.assetVersion) || !nonEmptyString(asset.sha256) ||
        !nonEmptyString(asset.fileName) || !nonEmptyString(asset.sourceEvidenceRef) ||
        !nonEmptyString(asset.stableUrlEvidenceRef) || asset.role !== (index === 0 ? "main_image" : "gallery_image") ||
        !Number.isInteger(asset.order) || asset.order < 1 || !isoDateTime(asset.addedAt) ||
        asset.ownerConfirmed !== true || asset.productionEligible !== true || asset.lifecycleArea !== "finalUploads" ||
        asset.sourceType !== "owner_provided_final_upload" ||
        !hasExactKeys(asset.usageAuthorization, ["status", "evidenceRef"]) ||
        asset.usageAuthorization.status !== "owner_authorized_for_listing" ||
        !nonEmptyString(asset.usageAuthorization.evidenceRef) ||
        ["byteSize", "width", "height"].some((field) => asset[field] !== null &&
          (!Number.isFinite(asset[field]) || asset[field] < 0))) {
      throw new Error(`PRODUCTION_AUTHORIZATION_MEDIA_INVALID:finalUploads[${index}]`);
    }
    assertSha256(asset.sha256, `finalUploads[${index}].sha256`);
    assertFinalAssetLocation(asset, `finalUploads[${index}]`);
    for (const [field, ref] of [
      ["assetId", asset.assetId],
      ["sourceEvidenceRef", asset.sourceEvidenceRef],
      ["stableUrlEvidenceRef", asset.stableUrlEvidenceRef],
      ["usageAuthorization.evidenceRef", asset.usageAuthorization.evidenceRef]
    ]) assertCanonicalFrozenRef(ref, `finalUploads[${index}].${field}`);
    if (ids.has(asset.assetId) || orders.has(asset.order)) {
      throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_INVALID:duplicate");
    }
    ids.add(asset.assetId);
    orders.add(asset.order);
    if (asset.role === "main_image") mainImages += 1;
    if (asset.mediaType === "video") videos += 1;
  }
  // 主人给的第一张就是主图；软件不许重排，也不许自己挑另一张当主图。
  if (mainImages !== 1 || !assets.every((asset, index) => asset.order === index + 1) ||
      assets[0].mediaType !== "image" || assets[0].role !== "main_image") {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_INVALID:mainImageOrOrder");
  }
  if (assets[0].assetId !== preparation.mainImageAssetId) {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_DRIFT:mainImageAssetId");
  }
  if (fingerprintAuthorizedMedia(assets) !== preparation.authorizedMediaFingerprint) {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_DRIFT:authorizedMediaFingerprint");
  }
  if (preparation.videoDisposition === "includes_video" && videos === 0) {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_INVALID:videoRequired");
  }
  if (preparation.videoDisposition === "excludes_video" && videos > 0) {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_INVALID:videoExcluded");
  }
  if (preparation.effectiveVideoRequirement?.status === "required" &&
      preparation.videoDisposition !== "includes_video") {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_INVALID:conditionalVideo");
  }
  const confirmation = preparation.ownerFinalUploadConfirmation;
  if (!hasExactKeys(confirmation, OWNER_UPLOAD_CONFIRMATION_FIELDS) ||
      confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner" ||
      !isoDateTime(confirmation.confirmedAt) || confirmation.approvedManifestVersion !== PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION ||
      confirmation.confirmationNote !== null ||
      !sameJson(confirmation.approvedAssetIds, assets.map((asset) => asset.assetId)) ||
      confirmation.approvedMainImageAssetId !== preparation.mainImageAssetId ||
      confirmation.approvedVideoDisposition !== preparation.videoDisposition ||
      confirmation.approvedManifestSha256 !== preparation.finalManifestSha256 ||
      confirmation.approvedAuthorizedMediaFingerprint !== preparation.authorizedMediaFingerprint) {
    throw new Error("PRODUCTION_AUTHORIZATION_MEDIA_DRIFT:ownerFinalUploadConfirmation");
  }
}

/** Validate saved preparation without depending on later mutable C1 state. */
export function validateProductionAuthorizationPreparation({
  preparation,
  candidateId,
  skuPackage,
  expectedSkuRevision = skuPackage?.dataRevision
}) {
  assertCanonicalC2ReferenceTree(preparation);
  if (!hasExactKeys(preparation, PREPARATION_FIELDS) ||
      preparation.schemaVersion !== PRODUCTION_AUTHORIZATION_PREPARATION_VERSION ||
      preparation.status !== "awaiting_final_card_approval" ||
      preparation.skuPackageId !== skuPackage.skuPackageId ||
      !Number.isInteger(preparation.sourceDataRevision) || preparation.sourceDataRevision < 0 ||
      preparation.resultDataRevision !== preparation.sourceDataRevision + 1 ||
      preparation.resultDataRevision !== expectedSkuRevision ||
      preparation.ownerFinalCardAuthorizationDecision !== null ||
      preparation.productionAuthorizationCreated !== false || preparation.dHandoffCreated !== false) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:stateOrRevision");
  }
  if (preparation.finalManifestVersion !== PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION ||
      !isoDateTime(preparation.ownerConfirmationAt) ||
      !hasExactKeys(preparation.effectiveVideoRequirement, ["status", "requiredBy", "evidenceRefs"]) ||
      !["required", "not_required"].includes(preparation.effectiveVideoRequirement.status) ||
      !nonEmptyString(preparation.effectiveVideoRequirement.requiredBy) ||
      !Array.isArray(preparation.effectiveVideoRequirement.evidenceRefs) ||
      !["includes_video", "excludes_video"].includes(preparation.videoDisposition)) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:manifestOrVideoRequirement");
  }
  for (const field of [
    "sourceC1Fingerprint", "authorizedMediaFingerprint", "finalManifestSha256",
    "finalUploadsFingerprint", "finalCardInputFingerprint", "preparationFingerprint"
  ]) {
    assertSha256(preparation[field], field);
  }
  if (!sameJson(preparation.pendingAuthorizationInputs, createPendingProductionAuthorizationInputs())) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:pendingAuthorizationInputs");
  }
  const snapshot = preparation.finalCardInputSnapshot;
  if (!hasExactKeys(snapshot, FINAL_CARD_FIELDS) ||
      snapshot.schemaVersion !== PRODUCTION_AUTHORIZATION_FINAL_CARD_INPUT_SNAPSHOT_VERSION ||
      snapshot.skuPackageId !== skuPackage.skuPackageId ||
      snapshot.sourceDataRevision !== preparation.sourceDataRevision ||
      snapshot.resultDataRevision !== preparation.resultDataRevision ||
      snapshot.sourceC1Fingerprint !== preparation.sourceC1Fingerprint ||
      snapshot.variantKey !== skuPackage.variantKey || snapshot.activeProfitModel?.result !== "passed" ||
      snapshot.activeProfitModelVersion !== skuPackage.activeProfitModelVersion ||
      !Array.isArray(snapshot.canonicalC1?.unknownManifest) || snapshot.canonicalC1.unknownManifest.length !== 0) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:finalCardInputSnapshot");
  }
  validateSourceIdentity(snapshot.identity, { candidateId, skuPackage });
  const target = preparation.targetContext;
  if (!hasExactKeys(target, TARGET_CONTEXT_FIELDS)) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:targetContext");
  }
  const schemaRules = snapshot.c1Snapshot?.inputSnapshots?.platformSchemaRules;
  if (!sameJson(snapshot.identity, preparation.frozenC1Handoff?.identity) ||
      !sameJson(snapshot.canonicalC1, preparation.frozenC1Handoff) ||
      target.platform !== snapshot.identity.platform ||
      target.storeRef !== snapshot.identity.storeRef.stableStoreId ||
      target.targetStore !== snapshot.identity.storeRef.stableStoreId ||
      !nonEmptyString(target.schemaRevision) || !nonEmptyString(target.schemaEvidenceRef) ||
      target.schemaRevision !== schemaRules?.schemaRevision ||
      target.schemaEvidenceRef !== schemaRules?.evidenceId ||
      target.schemaEvidenceRef !== preparation.frozenC1Handoff?.schemaSnapshotRef) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_INVALID:canonicalBinding");
  }
  const expectedC1Fingerprint = fingerprintC1Snapshot(snapshot.identity, snapshot.c1Snapshot);
  if (preparation.sourceC1Fingerprint !== expectedC1Fingerprint ||
      preparation.finalCardInputFingerprint !== fingerprintFinalCardInputSnapshot(snapshot) ||
      preparation.finalUploadsFingerprint !== fingerprintFinalUploads(preparation.finalUploads) ||
      preparation.finalManifestSha256 !== fingerprintFinalManifest({
        authorizedMediaFingerprint: preparation.authorizedMediaFingerprint,
        effectiveVideoRequirement: preparation.effectiveVideoRequirement,
        mainImageAssetId: preparation.mainImageAssetId,
        videoDisposition: preparation.videoDisposition,
        assets: preparation.finalUploads
      }) || preparation.preparationFingerprint !== fingerprintProductionAuthorizationPreparation(preparation)) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_DRIFT:fingerprint");
  }
  if (skuPackage.c2FinalAssets?.status !== "completed" ||
      !sameJson(skuPackage.c2FinalAssets.assets?.finalUploads, preparation.finalUploads) ||
      !sameJson(skuPackage.c2FinalAssets.ownerFinalUploadConfirmation, preparation.ownerFinalUploadConfirmation) ||
      !sameJson(skuPackage.c2FinalAssets.productionAuthorizationPreparation, preparation)) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_DRIFT:c2FinalAssets");
  }
  assertNoProductionSecrets(preparation, "productionAuthorizationPreparation");
  validateFinalUploads(preparation);
  return preparation;
}

/** New authorization decisions additionally require current C1 to match the saved projection. */
export function assertCurrentC1MatchesProductionPreparation({ preparation, candidateId, skuPackage }) {
  validateProductionAuthorizationPreparation({ preparation, candidateId, skuPackage });
  const snapshot = preparation.finalCardInputSnapshot.c1Snapshot;
  if (!isObject(snapshot) || !isObject(skuPackage.c1ProductPlan) ||
      !Object.entries(snapshot).every(([field, value]) => sameJson(skuPackage.c1ProductPlan[field], value))) {
    throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_DRIFT:currentC1Snapshot");
  }
  return preparation;
}
