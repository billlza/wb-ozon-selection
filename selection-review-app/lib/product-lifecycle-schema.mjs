import { sameStoreRef } from "./store-binding.mjs";
import { validateAMarketAssessment } from "./market-sample-policy.mjs";
import { validateProfitCalculation } from "./profit-model-calculation.mjs";
import { MINIMUM_PROFIT_MARGIN, MINIMUM_UNIT_PROFIT_RMB, LEGACY_PROFIT_THRESHOLD_VERSION } from "./profit-threshold-policy.mjs";
export { MINIMUM_PROFIT_MARGIN, MINIMUM_UNIT_PROFIT_RMB, CURRENT_PROFIT_THRESHOLD_VERSION, LEGACY_PROFIT_THRESHOLD_VERSION } from "./profit-threshold-policy.mjs";
import {
  assertFinalAssetLocation,
  assertNoProductionSecrets,
  collectProductionSecretErrors,
  dProductionJobRound,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
import { validateProductionAuthorizationPreparation, isProductionExecutionBinding, assertAuthorizedMediaUnchanged } from "./production-authorization-preparation.mjs";
import { validateC1SkuRightsReviewRecord } from "./c1-sku-rights-review.mjs";
import { isAssetTransportPrewriteFailure } from "./production-execution-failure.mjs";

export {
  assertNoProductionSecrets,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
export {
  validateProductionAuthorizationPreparation,
  validateProductionAuthorizationPreparation as validateC2ProductionAuthorizationPreparationRecord
} from "./production-authorization-preparation.mjs";

export const PRODUCT_LIFECYCLE_SCHEMA_VERSION = "product-lifecycle-v1.1";

export const ENTITY_TYPES = Object.freeze({
  OPPORTUNITY: "OpportunityPackage",
  SKU: "SkuLifecyclePackage"
});

export const BUSINESS_PHASES = Object.freeze({
  OPPORTUNITY: ["A", "closed", "unknown"],
  SKU: ["B", "C1", "C2", "D", "E", "closed", "unknown"]
});

export const BUSINESS_RESULTS = Object.freeze([
  "pending",
  "passed",
  "rejected",
  "manual_review",
  "unknown"
]);

export const TECHNICAL_STATUSES = Object.freeze([
  "not_started",
  "queued",
  "running",
  "completed",
  "data_acquisition_failed",
  "system_error",
  "permission_required",
  "stopped",
  "unknown"
]);

export const OWNER_ACTIONS = Object.freeze([
  "none",
  "confirm_direction",
  "confirm_supplier_option",
  "provide_supply_data",
  "review_business_exception",
  "review_compliance_risk",
  "confirm_c1_plan",
  "provide_final_assets",
  "confirm_final_assets",
  "authorize_production",
  "decide_readback_failure",
  "unknown"
]);

export const SUPPLIER_SEARCH_STATUSES = Object.freeze([
  "not_started",
  "running",
  "completed",
  "stopped",
  "unknown"
]);

export const SUPPLIER_SEARCH_STOP_REASONS = Object.freeze([
  "enough_qualified_options",
  "max_search_rounds",
  "max_supplier_options",
  "max_consecutive_no_evidence_rounds",
  "technical_failure",
  "owner_stop",
  "scope_completed"
]);

export const READBACK_STATUSES = Object.freeze([
  "not_started",
  "running",
  "completed",
  "stopped"
]);

export const READBACK_STOP_REASONS = Object.freeze([
  "max_automatic_attempts",
  "max_consecutive_same_failure",
  "technical_failure",
  "permission_required",
  "owner_stop"
]);

const TECHNICAL_FAILURES = new Set([
  "data_acquisition_failed",
  "system_error",
  "permission_required",
  "stopped"
]);

const G1_IDENTITY_FIELDS = Object.freeze([
  "schemaVersion", "candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId",
  "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"
]);
const STORE_REF_FIELDS = Object.freeze(["stableStoreId", "platformStoreId", "mappingVersion"]);
const PRODUCTION_AUTHORIZATION_FIELDS = Object.freeze([
  "schemaVersion", "authorizationId", "status", "confirmedBy", "confirmedByActorId", "confirmedAt",
  "authorizedByActorId", "authorizedAt", "ownerDecisionId", "ownerConfirmation", "technicalAuthorization",
  "ownerDecisionFingerprint", "ownerDecisionSnapshot",
  "sourceConfirmationCardId", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint",
  "sourceC1Fingerprint", "sourceCandidateRevision", "resultCandidateRevision", "authorizedDataRevision",
  "resultDataRevision", "sourceIdentity", "identity", "lockedScope", "scopeExpansionAllowed",
  "fieldMutationAllowed", "skuReplacementAllowed", "assetReplacementAllowed", "readPolicy",
  "productionExecuted", "platformWrites"
]);
const SINGLE_OWNER_AUTHORIZATION_FIELDS = Object.freeze([...PRODUCTION_AUTHORIZATION_FIELDS.map(field => field === "technicalAuthorization" ? "ownerAuthorization" : field), "executionBinding"]);
const OWNER_AUTHORIZATION_FIELDS = Object.freeze(["schemaVersion", "actorId", "actorType", "role", "source", "authorizedAt"]);
const OWNER_CONFIRMATION_FIELDS = Object.freeze([
  "schemaVersion", "decisionId", "actorId", "actorType", "role", "confirmedAt",
  "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "sourceC1Fingerprint",
  "sourceCandidateRevision", "sourceSkuRevision", "ownerDecisionFingerprint"
]);
const TECHNICAL_AUTHORIZATION_FIELDS = Object.freeze([
  "schemaVersion", "actorId", "actorType", "role", "authorizedAt"
]);
const OWNER_DECISION_SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "decisionId", "sourceConfirmationCardId", "sourcePreparationFingerprint",
  "sourceFinalCardInputFingerprint", "sourceC1Fingerprint", "sourceCandidateRevision", "sourceSkuRevision",
  "identity", "buyerTargetPrice", "platformWritePrice", "priceConversion", "stock", "publishScope",
  "allowedWriteFields", "exclusions", "authorizedMediaFingerprint", "finalManifestSha256",
  "finalUploadsFingerprint", "mainImageAssetId", "videoDisposition", "effectiveVideoRequirement"
]);
const SINGLE_OWNER_DECISION_SNAPSHOT_FIELDS = Object.freeze([...OWNER_DECISION_SNAPSHOT_FIELDS, "executionBinding"]);
const PRODUCTION_EXECUTION_BINDING_FIELDS = Object.freeze(["bindingId", "configurationVersion", "warehouseId"]);
const LOCKED_SCOPE_FIELDS = Object.freeze([
  "candidateId", "skuPackageId", "variantKey", "platform", "storeRef", "merchantSku", "supplierSkuId",
  "warehouseRef", "credentialAlias", "schemaRevision", "schemaEvidenceRef",
  "activeProfitModelVersion", "buyerTargetPrice", "platformWritePrice", "priceConversion", "stock",
  "authorizedMediaFingerprint", "finalManifestVersion", "finalManifestSha256", "finalUploadsFingerprint",
  "mainImageAssetId", "videoDisposition", "effectiveVideoRequirement", "finalUploads",
  "finalCardInputSnapshot", "publishScope", "allowedWriteFields", "exclusions"
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
const D_HANDOFF_FIELDS = Object.freeze([
  "schemaVersion", "handoffId", "status", "candidateId", "skuPackageId", "identity", "variantKey",
  "productionAuthorizationId", "ownerDecisionId", "sourcePreparationFingerprint",
  "sourceFinalCardInputFingerprint", "sourceCandidateRevision", "resultCandidateRevision",
  "sourceSkuRevision", "resultSkuRevision", "createdAt", "uniqueOwner", "productionPlanCreated",
  "executionIntentCreated", "softwareJobCreated", "dWritePermissionGranted", "externalRequests", "platformWrites"
]);
const PRODUCTION_WRITE_FIELDS = new Set([
  "create_product", "title", "description", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"
]);
const PLACEHOLDER_VALUES = new Set(["unknown", "null", "undefined", "not_applicable"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, fields) {
  return isObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isUnknown(value) {
  return value === "unknown";
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIsoDateTime(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是对象");
    return false;
  }
  return true;
}

function requireString(value, path, errors) {
  if (!isNonEmptyString(value)) push(errors, path, "必须是非空字符串");
}

function validateDAssetTransportGate(value, errors) {
  if (value === undefined || value === null) return;
  if (!isObject(value)) {
    push(errors, "dAssetTransport", "必须是对象或null");
    return;
  }
  if (value.schemaVersion !== "aliyun-oss-d-asset-state-v1") {
    push(errors, "dAssetTransport.schemaVersion", "必须使用aliyun-oss-d-asset-state-v1");
  }
  if (!["in_flight", "verified", "unknown_outcome", "failed"].includes(value.status)) {
    push(errors, "dAssetTransport.status", "必须是in_flight、verified、unknown_outcome或failed");
  }
  if (value.automaticRetry !== false) push(errors, "dAssetTransport.automaticRetry", "OSS素材传输禁止自动重试");
  if (value.platformWrites !== 0) push(errors, "dAssetTransport.platformWrites", "OSS素材传输不得产生平台写入");
  if (!isObject(value.intent) || value.intent.schemaVersion !== "aliyun-oss-d-asset-integration-v1") {
    push(errors, "dAssetTransport.intent", "必须保存绑定当前授权的一次性OSS传输意图");
  }
  if (value.status === "in_flight" && value.intent?.status !== "in_flight") {
    push(errors, "dAssetTransport.intent.status", "执行中状态必须对应已持久化的in_flight意图");
  }
  if (value.status === "verified") {
    if (value.intent?.status !== "completed") push(errors, "dAssetTransport.intent.status", "验证完成后意图必须为completed");
    if (!isObject(value.assetTransport) || value.assetTransport.status !== "verified" ||
        value.assetTransport.mode !== "preapproved_stable_https" || !isNonEmptyString(value.assetTransport.evidenceRef) ||
        !Array.isArray(value.assetTransport.resolvedAssets) || value.assetTransport.resolvedAssets.length === 0) {
      push(errors, "dAssetTransport.assetTransport", "必须保存已独立验证的稳定HTTPS素材证据");
    }
  }
  if (value.status === "unknown_outcome") {
    if (value.intent?.status !== "unknown_outcome") push(errors, "dAssetTransport.intent.status", "结果未知时意图必须同步为unknown_outcome");
    if (value.assetTransport !== null) push(errors, "dAssetTransport.assetTransport", "结果未知时不得保存可用于生产的素材证据");
  }
  if (value.status === "failed" && (value.intent?.status !== "failed" || value.intent.ossWrites !== 0 ||
      value.intent.externalRequestState !== "not_attempted" ||
      !isAssetTransportPrewriteFailure({ layer: value.intent.failureLayer, code: value.intent.failureCode }) ||
      !isNonEmptyString(value.intent.failureCode) || value.assetTransport !== null)) {
    push(errors, "dAssetTransport.intent", "配置前检失败必须保存未尝试上传和零写入，不得有可用素材回执");
  }
}

function requireEnum(value, values, path, errors) {
  if (!values.includes(value)) push(errors, path, `必须是以下值之一：${values.join(", ")}`);
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) push(errors, path, "必须是数组");
}

function validateCommon(pkg, entityType, phases, errors) {
  if (!requireObject(pkg, "$", errors)) return;
  if (pkg.schemaVersion !== PRODUCT_LIFECYCLE_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `必须是${PRODUCT_LIFECYCLE_SCHEMA_VERSION}`);
  }
  if (pkg.entityType !== entityType) push(errors, "entityType", `必须是${entityType}`);
  requireString(pkg.parentOpportunityId, "parentOpportunityId", errors);
  if (!isNonNegativeInteger(pkg.dataRevision)) push(errors, "dataRevision", "必须是非负整数");
  requireEnum(pkg.businessPhase, phases, "businessPhase", errors);
  requireEnum(pkg.businessResult, BUSINESS_RESULTS, "businessResult", errors);
  requireEnum(pkg.technicalStatus, TECHNICAL_STATUSES, "technicalStatus", errors);
  requireEnum(pkg.ownerAction, OWNER_ACTIONS, "ownerAction", errors);

  if (requireObject(pkg.audit, "audit", errors)) {
    if (!isIsoDateTime(pkg.audit.createdAt)) push(errors, "audit.createdAt", "必须是有效时间");
    if (!isIsoDateTime(pkg.audit.updatedAt)) push(errors, "audit.updatedAt", "必须是有效时间");
    requireArray(pkg.audit.history, "audit.history", errors);
  }
}

function validateSupplierSearch(search, errors) {
  if (!requireObject(search, "supplierSearch", errors)) return;
  requireEnum(search.status, SUPPLIER_SEARCH_STATUSES, "supplierSearch.status", errors);

  if (requireObject(search.limits, "supplierSearch.limits", errors)) {
    for (const key of ["maxSearchRounds", "maxSupplierOptions", "maxConsecutiveNoEvidenceRounds"]) {
      if (!isPositiveInteger(search.limits[key]) && !isUnknown(search.limits[key])) {
        push(errors, `supplierSearch.limits.${key}`, "必须是有限的正整数");
      }
    }
  }

  for (const key of ["searchRounds", "supplierOptionsFound", "consecutiveNoEvidenceRounds"]) {
    if (!isNonNegativeInteger(search[key]) && !isUnknown(search[key])) {
      push(errors, `supplierSearch.${key}`, "必须是非负整数或unknown");
    }
  }
  if (!isNullableString(search.stopReason)) push(errors, "supplierSearch.stopReason", "必须是字符串或null");
  if (!isNullableString(search.stoppedAt)) push(errors, "supplierSearch.stoppedAt", "必须是时间字符串或null");

  const limits = search.limits || {};
  if (search.status === "running") {
    for (const key of ["maxSearchRounds", "maxSupplierOptions", "maxConsecutiveNoEvidenceRounds"]) {
      if (!isPositiveInteger(limits[key])) push(errors, `supplierSearch.limits.${key}`, "开始搜索前必须确定有限上限");
    }
    for (const key of ["searchRounds", "supplierOptionsFound", "consecutiveNoEvidenceRounds"]) {
      if (!isNonNegativeInteger(search[key])) push(errors, `supplierSearch.${key}`, "运行时必须是非负整数");
    }
    const reached =
      search.searchRounds >= limits.maxSearchRounds ||
      search.supplierOptionsFound >= limits.maxSupplierOptions ||
      search.consecutiveNoEvidenceRounds >= limits.maxConsecutiveNoEvidenceRounds;
    if (reached) push(errors, "supplierSearch.status", "达到停止条件后不得继续运行");
  }
  if (["completed", "stopped"].includes(search.status)) {
    requireEnum(search.stopReason, SUPPLIER_SEARCH_STOP_REASONS, "supplierSearch.stopReason", errors);
    if (!isIsoDateTime(search.stoppedAt)) push(errors, "supplierSearch.stoppedAt", "停止后必须记录有效时间");
  }
}

function parseProfitVersion(value) {
  const match = /^profit-v([1-9]\d*)$/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

function validateProfitModels(pkg, errors) {
  if (!Array.isArray(pkg.profitModels)) {
    push(errors, "profitModels", "必须是数组");
    return;
  }

  const seen = new Set();
  let previousVersion = 0;
  pkg.profitModels.forEach((model, index) => {
    const path = `profitModels[${index}]`;
    if (!requireObject(model, path, errors)) return;
    const numericVersion = parseProfitVersion(model.profitModelVersion);
    if (numericVersion === null) push(errors, `${path}.profitModelVersion`, "必须使用profit-vN格式");
    if (seen.has(model.profitModelVersion)) push(errors, `${path}.profitModelVersion`, "版本不得重复或覆盖");
    if (numericVersion !== null && numericVersion <= previousVersion) {
      push(errors, `${path}.profitModelVersion`, "利润版本必须严格递增");
    }
    seen.add(model.profitModelVersion);
    if (numericVersion !== null) previousVersion = numericVersion;
    if (!isIsoDateTime(model.calculatedAt)) push(errors, `${path}.calculatedAt`, "必须是有效时间");
    requireArray(model.inputSnapshotRefs, `${path}.inputSnapshotRefs`, errors);
    for (const key of ["recommendedSalePriceCny", "unitProfitRmb", "profitMargin"] ) {
      if (!Number.isFinite(model[key])) push(errors, `${path}.${key}`, "必须是有限数字");
    }
    requireEnum(model.result, BUSINESS_RESULTS, `${path}.result`, errors);
    if (Number.isFinite(model.recommendedSalePriceCny) && model.recommendedSalePriceCny <= 0) {
      push(errors, `${path}.recommendedSalePriceCny`, "建议成交价必须大于0");
    }
    if (model.calculation?.version === "profit-calculation-v3-cost-policy-snapshot") {
      const context = model.otherCosts?.costPolicyContext;
      if (context?.platform !== pkg.targetPlatform || context?.store !== pkg.targetStore ||
          !sameStoreRef(context?.storeRef, pkg.g1Identity?.storeRef)) {
        push(errors, `${path}.otherCosts.costPolicyContext`, "成本政策必须属于父SKU的同一平台、店铺和完整店铺身份");
      }
    }
    if (Object.hasOwn(model, "calculation")) {
      for (const entry of validateProfitCalculation(model)) push(errors, `${path}.${entry.path}`, entry.message);
    } else if (Number.isFinite(model.recommendedSalePriceCny) && Number.isFinite(model.unitProfitRmb) && Number.isFinite(model.profitMargin)) {
      const expectedMargin = model.unitProfitRmb / model.recommendedSalePriceCny;
      if (Math.abs(model.profitMargin - expectedMargin) > 0.0001) {
        push(errors, `${path}.profitMargin`, "必须等于单件利润除以建议成交价人民币");
      }
      const legacyThreshold = model.thresholdVersion === LEGACY_PROFIT_THRESHOLD_VERSION;
      const thresholdPassed = legacyThreshold
        ? model.unitProfitRmb >= 20 && model.profitMargin >= 0.25
        : model.unitProfitRmb >= MINIMUM_UNIT_PROFIT_RMB || model.profitMargin >= MINIMUM_PROFIT_MARGIN;
      if (model.result === "passed" && !thresholdPassed) {
        push(errors, `${path}.result`, legacyThreshold
          ? "历史利润版本通过必须同时满足利润率25%和单件利润20元"
          : "当前利润版本通过必须满足单件利润20元或利润率15%中的任一项");
      }
      if (model.result === "rejected" && thresholdPassed) {
        push(errors, `${path}.result`, "达到统一利润门槛时不得标记为淘汰");
      }
    }
  });

  if (pkg.activeProfitModelVersion !== null && !seen.has(pkg.activeProfitModelVersion)) {
    push(errors, "activeProfitModelVersion", "必须指向已保留的利润版本");
  }
}

function validateReadbackPolicy(policy, errors) {
  if (!requireObject(policy, "readbackPolicy", errors)) return;
  requireEnum(policy.status, READBACK_STATUSES, "readbackPolicy.status", errors);
  for (const key of ["maxAutomaticAttempts", "maxConsecutiveSameFailure"]) {
    if (!isPositiveInteger(policy[key])) push(errors, `readbackPolicy.${key}`, "必须是有限的正整数");
  }
  for (const key of ["automaticAttempts", "consecutiveSameFailureCount"]) {
    if (!isNonNegativeInteger(policy[key])) push(errors, `readbackPolicy.${key}`, "必须是非负整数");
  }
  if (!isNullableString(policy.lastFailureLayer)) push(errors, "readbackPolicy.lastFailureLayer", "必须是字符串或null");
  if (!isNullableString(policy.stopReason)) push(errors, "readbackPolicy.stopReason", "必须是字符串或null");
  if (!isNullableString(policy.stoppedAt)) push(errors, "readbackPolicy.stoppedAt", "必须是时间字符串或null");

  if (policy.automaticAttempts > policy.maxAutomaticAttempts) {
    push(errors, "readbackPolicy.automaticAttempts", "不得超过自动回读上限");
  }
  if (policy.consecutiveSameFailureCount > policy.maxConsecutiveSameFailure) {
    push(errors, "readbackPolicy.consecutiveSameFailureCount", "不得超过同层连续失败上限");
  }
  const reached =
    policy.automaticAttempts >= policy.maxAutomaticAttempts ||
    policy.consecutiveSameFailureCount >= policy.maxConsecutiveSameFailure;
  if (policy.status === "running" && reached) {
    push(errors, "readbackPolicy.status", "达到回读停止条件后不得继续自动回读");
  }
  if (policy.status === "stopped") {
    requireEnum(policy.stopReason, READBACK_STOP_REASONS, "readbackPolicy.stopReason", errors);
    if (!isIsoDateTime(policy.stoppedAt)) push(errors, "readbackPolicy.stoppedAt", "停止后必须记录有效时间");
  }
}

function validateC2AssetLifecycleGate(value, errors) {
  if (!isObject(value)) return;
  if (value.schemaVersion !== "c2-asset-lifecycle-v1.1") {
    push(errors, "c2FinalAssets.schemaVersion", "必须使用c2-asset-lifecycle-v1.1");
  }
  if (!["awaiting_final_uploads", "completed"].includes(value.status)) {
    push(errors, "c2FinalAssets.status", "素材状态无效");
  }
  if (!isObject(value.assets)) {
    push(errors, "c2FinalAssets.assets", "必须存在三个素材区域");
  } else {
    for (const region of ["collected", "aiDrafts", "finalUploads"]) {
      if (!Array.isArray(value.assets[region])) push(errors, `c2FinalAssets.assets.${region}`, "必须是数组");
    }
  }
  if (!isObject(value.dReadPolicy) ||
      value.dReadPolicy.onlyAllowedArea !== "assets.finalUploads" ||
      value.dReadPolicy.collectedAllowed !== false ||
      value.dReadPolicy.aiDraftsAllowed !== false ||
      value.dReadPolicy.ownerConfirmationRequired !== true) {
    push(errors, "c2FinalAssets.dReadPolicy", "D只能读取主人确认的assets.finalUploads");
  }
  if (value.platformUploads !== 0) push(errors, "c2FinalAssets.platformUploads", "C2基础设施不得产生平台上传");
  if (value.productionStarted !== false) push(errors, "c2FinalAssets.productionStarted", "C2基础设施不得开始D生产");
  if (value.status === "completed") {
    const confirmation = value.ownerFinalUploadConfirmation;
    if (!isObject(confirmation) || confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner") {
      push(errors, "c2FinalAssets.ownerFinalUploadConfirmation", "完成C2必须有主人确认");
    }
    if (!Array.isArray(value.assets?.finalUploads) || value.assets.finalUploads.length === 0) {
      push(errors, "c2FinalAssets.assets.finalUploads", "完成C2必须有最终上传素材");
    } else if (value.assets.finalUploads.some((asset) => !isObject(asset) || asset.ownerConfirmed !== true || asset.productionEligible !== true)) {
      push(errors, "c2FinalAssets.assets.finalUploads", "最终上传素材必须逐项由主人确认");
    }
  }
}

function validateG1Identity(identity, pkg, errors, path = "g1Identity") {
  if (!isObject(identity)) {
    push(errors, path, "必须保存完整G1身份");
    return;
  }
  if (identity.schemaVersion !== "g1-identity-v1") push(errors, `${path}.schemaVersion`, "必须使用g1-identity-v1");
  for (const field of ["candidateId", "skuPackageId", "platform", "supplierSkuId", "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    if (!isNonEmptyString(identity[field]) || ["unknown", "null", "undefined"].includes(identity[field])) push(errors, `${path}.${field}`, "必须是明确身份值");
  }
  if (!isObject(identity.storeRef)) {
    push(errors, `${path}.storeRef`, "必须是稳定结构化店铺引用");
  } else {
    for (const field of ["stableStoreId", "platformStoreId", "mappingVersion"]) {
      if (!isNonEmptyString(identity.storeRef[field]) || ["unknown", "null", "undefined", "not_applicable"].includes(identity.storeRef[field])) {
        push(errors, `${path}.storeRef.${field}`, "必须是明确店铺身份值");
      }
    }
  }
  if (identity.skuPackageId !== pkg.skuPackageId) push(errors, `${path}.skuPackageId`, "必须与SKU生命周期一致");
  if (pkg.g1Identity?.candidateId && identity.candidateId !== pkg.g1Identity.candidateId) push(errors, `${path}.candidateId`, "必须与G1候选身份一致");
  if (identity.platform !== pkg.targetPlatform) push(errors, `${path}.platform`, "必须与目标平台一致");
  if (identity.storeRef?.stableStoreId !== pkg.targetStore) push(errors, `${path}.storeRef.stableStoreId`, "必须与目标店铺一致");
  if (identity.supplierSkuId !== pkg.supplierSkuId) push(errors, `${path}.supplierSkuId`, "供应SKU不得替换");
}

function validateExactObject(value, fields, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是对象");
    return false;
  }
  if (!hasExactKeys(value, fields)) push(errors, path, "字段必须与唯一公共合同完全一致，禁止缺失或额外字段");
  return true;
}

function validateAuthorizationG1(identity, path, errors, { source = false } = {}) {
  if (!validateExactObject(identity, G1_IDENTITY_FIELDS, path, errors)) return;
  if (identity.schemaVersion !== "g1-identity-v1") push(errors, `${path}.schemaVersion`, "必须使用g1-identity-v1");
  for (const field of ["candidateId", "skuPackageId", "platform", "supplierSkuId", "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    if (!isNonEmptyString(identity[field]) || (field !== "merchantSku" && field !== "warehouseRef" && field !== "credentialAlias" && field !== "platformProductId" && PLACEHOLDER_VALUES.has(String(identity[field]).toLowerCase())) ||
        (["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"].includes(field) && ["unknown", "null", "undefined"].includes(String(identity[field]).toLowerCase()))) push(errors, `${path}.${field}`, "必须是明确身份值");
  }
  if (!validateExactObject(identity.storeRef, STORE_REF_FIELDS, `${path}.storeRef`, errors)) return;
  for (const field of STORE_REF_FIELDS) {
    if (!isNonEmptyString(identity.storeRef[field]) || PLACEHOLDER_VALUES.has(String(identity.storeRef[field]).toLowerCase())) push(errors, `${path}.storeRef.${field}`, "必须是明确店铺身份值");
  }
  if (source) {
    for (const field of ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
      if (identity[field] !== "not_applicable") push(errors, `${path}.${field}`, "C2源身份尚不得包含生产身份值");
    }
  } else {
    for (const field of ["merchantSku", "warehouseRef", "credentialAlias"]) {
      if (PLACEHOLDER_VALUES.has(String(identity[field]).toLowerCase())) push(errors, `${path}.${field}`, "授权身份必须由主人明确锁定");
    }
  }
}

function validateMoney(value, currency, path, errors) {
  if (!validateExactObject(value, ["amount", "currency"], path, errors)) return;
  if (!Number.isFinite(value.amount) || value.amount <= 0) push(errors, `${path}.amount`, "必须是正数");
  if (value.currency !== currency) push(errors, `${path}.currency`, `必须是${currency}`);
}

function validateFinalUploads(finalUploads, lockedScope, errors) {
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    push(errors, "productionAuthorization.lockedScope.finalUploads", "必须锁定至少一个最终素材");
    return;
  }
  const ids = new Set();
  let mainCount = 0;
  let videoCount = 0;
  finalUploads.forEach((asset, index) => {
    const path = `productionAuthorization.lockedScope.finalUploads[${index}]`;
    if (!validateExactObject(asset, FINAL_UPLOAD_FIELDS, path, errors)) return;
    for (const field of ["assetId", "assetRef", "fileName", "assetVersion", "sha256", "sourceEvidenceRef", "stableUrlEvidenceRef", "addedAt"]) {
      if (!isNonEmptyString(asset[field])) push(errors, `${path}.${field}`, "必须是非空字符串");
    }
    // 主人给的第一张就是主图，其余按序进图库；角色只能由顺序推出来，软件不许自己指定。
    if (asset.role !== (index === 0 ? "main_image" : "gallery_image")) push(errors, `${path}.role`, "角色必须由主人给的顺序推出");
    if (!SHA256_PATTERN.test(String(asset.sha256 || ""))) push(errors, `${path}.sha256`, "必须是SHA256");
    if (!["image", "video"].includes(asset.mediaType)) push(errors, `${path}.mediaType`, "必须是image或video");
    if (asset.sourceType !== "owner_provided_final_upload" || asset.lifecycleArea !== "finalUploads" || asset.ownerConfirmed !== true || asset.productionEligible !== true) {
      push(errors, path, "只允许主人确认的finalUploads素材");
    }
    if (!hasExactKeys(asset.usageAuthorization, ["status", "evidenceRef"]) || asset.usageAuthorization?.status !== "owner_authorized_for_listing" || !isNonEmptyString(asset.usageAuthorization?.evidenceRef)) {
      push(errors, `${path}.usageAuthorization`, "必须保存主人上架用途授权");
    }
    for (const field of ["byteSize", "width", "height"]) {
      if (asset[field] !== null && (!Number.isFinite(asset[field]) || asset[field] < 0)) push(errors, `${path}.${field}`, "必须是非负数或null");
    }
    if (!isIsoDateTime(asset.addedAt)) push(errors, `${path}.addedAt`, "必须是有效时间");
    if (!Number.isInteger(asset.order) || asset.order !== index + 1) push(errors, `${path}.order`, "素材顺序必须从1连续递增");
    if (ids.has(asset.assetId)) push(errors, `${path}.assetId`, "assetId不得重复");
    ids.add(asset.assetId);
    if (asset.role === "main_image") mainCount += 1;
    if (asset.mediaType === "video") videoCount += 1;
    try {
      assertFinalAssetLocation(asset, path);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("C2_")) throw error;
      push(errors, `${path}.assetRef`, "必须是登记的不可变本地素材或有证据的稳定HTTPS素材");
    }
  });
  if (mainCount !== 1 || !ids.has(lockedScope.mainImageAssetId) || finalUploads[0]?.assetId !== lockedScope.mainImageAssetId ||
      finalUploads[0]?.mediaType !== "image") {
    push(errors, "productionAuthorization.lockedScope.mainImageAssetId", "必须且只能锁定主人排第一张的图片为首图");
  }
  // 授权的就是发出去的：锁定范围里这批地址、这个顺序一旦被换，指纹立刻对不上。
  try {
    assertAuthorizedMediaUnchanged(finalUploads, lockedScope.authorizedMediaFingerprint, "lockedScope");
  } catch (error) {
    push(errors, "productionAuthorization.lockedScope.authorizedMediaFingerprint", error.message);
  }
  if (lockedScope.videoDisposition === "includes_video" && videoCount === 0) push(errors, "productionAuthorization.lockedScope.videoDisposition", "声明包含视频时必须有视频素材");
  if (lockedScope.videoDisposition === "excludes_video" && videoCount > 0) push(errors, "productionAuthorization.lockedScope.videoDisposition", "声明排除视频时不得夹带视频素材");
  if (lockedScope.effectiveVideoRequirement?.status === "required" && lockedScope.videoDisposition !== "includes_video") {
    push(errors, "productionAuthorization.lockedScope.effectiveVideoRequirement", "条件视频为required时必须锁定视频");
  }
}

export function validateProductionAuthorizationRecord(value, context = {}) {
  const errors = [];
  const path = "productionAuthorization";
  const singleOwner = value?.schemaVersion === "production-authorization-v1.2";
  if (!validateExactObject(value, singleOwner ? SINGLE_OWNER_AUTHORIZATION_FIELDS : PRODUCTION_AUTHORIZATION_FIELDS, path, errors)) return { valid: false, errors };
  if (!["production-authorization-v1.1", "production-authorization-v1.2"].includes(value.schemaVersion)) push(errors, `${path}.schemaVersion`, "必须使用已发布的生产授权版本");
  if (value.status !== "confirmed" || value.confirmedBy !== "owner") push(errors, `${path}.status`, "必须保存独立主人确认");
  for (const field of ["authorizationId", "confirmedByActorId", "authorizedByActorId", "ownerDecisionId", "sourceConfirmationCardId"]) {
    if (!isNonEmptyString(value[field])) push(errors, `${path}.${field}`, "必须是非空字符串");
  }
  for (const field of ["confirmedAt", "authorizedAt"]) if (!isIsoDateTime(value[field])) push(errors, `${path}.${field}`, "必须是有效时间");
  for (const field of ["sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "sourceC1Fingerprint"]) {
    if (!SHA256_PATTERN.test(String(value[field] || ""))) push(errors, `${path}.${field}`, "必须是SHA256");
  }
  for (const field of ["sourceCandidateRevision", "resultCandidateRevision", "authorizedDataRevision", "resultDataRevision"]) {
    if (!isNonNegativeInteger(value[field])) push(errors, `${path}.${field}`, "必须是非负修订号");
  }
  if (value.resultCandidateRevision !== value.sourceCandidateRevision + 1 || value.resultDataRevision !== value.authorizedDataRevision + 1) push(errors, `${path}.resultDataRevision`, "candidate与SKU修订必须单步递增");

  if (validateExactObject(value.ownerConfirmation, OWNER_CONFIRMATION_FIELDS, `${path}.ownerConfirmation`, errors)) {
    const owner = value.ownerConfirmation;
    if (owner.schemaVersion !== (singleOwner ? "production-owner-confirmation-v2" : "production-owner-confirmation-v1") || owner.actorType !== "human" || owner.role !== "owner") push(errors, `${path}.ownerConfirmation`, "必须是独立human-owner确认记录");
    if (!isNonEmptyString(owner.actorId) || owner.actorId !== value.confirmedByActorId || owner.decisionId !== value.ownerDecisionId || owner.confirmedAt !== value.confirmedAt) push(errors, `${path}.ownerConfirmation`, "主人身份、决定与时间必须和授权同源");
    if (owner.sourcePreparationFingerprint !== value.sourcePreparationFingerprint || owner.sourceFinalCardInputFingerprint !== value.sourceFinalCardInputFingerprint || owner.sourceC1Fingerprint !== value.sourceC1Fingerprint || owner.sourceCandidateRevision !== value.sourceCandidateRevision || owner.sourceSkuRevision !== value.authorizedDataRevision || owner.ownerDecisionFingerprint !== value.ownerDecisionFingerprint) push(errors, `${path}.ownerConfirmation`, "主人确认必须锁定完整决定、同一preparation和当前revision");
  }
  if (singleOwner) {
    if (validateExactObject(value.ownerAuthorization, OWNER_AUTHORIZATION_FIELDS, `${path}.ownerAuthorization`, errors)) {
      const owner = value.ownerAuthorization;
      if (owner.schemaVersion !== "production-owner-authorization-v1" || owner.actorType !== "human" || owner.role !== "owner" ||
          owner.source !== "authenticated_identity_provider") push(errors, `${path}.ownerAuthorization`, "必须是本次已认证主人的准确生产授权");
      if (owner.actorId !== value.confirmedByActorId || owner.actorId !== value.authorizedByActorId || owner.authorizedAt !== value.authorizedAt ||
          value.confirmedAt !== value.authorizedAt) push(errors, `${path}.ownerAuthorization`, "一次主人确认必须使用同一身份和时间");
    }
  } else {
    if (validateExactObject(value.technicalAuthorization, TECHNICAL_AUTHORIZATION_FIELDS, `${path}.technicalAuthorization`, errors)) {
      const technical = value.technicalAuthorization;
      if (technical.schemaVersion !== "production-technical-authorization-v1" || technical.actorType !== "human" || technical.role !== "production_authorizer") push(errors, `${path}.technicalAuthorization`, "旧版本必须保持原技术授权记录");
      if (!isNonEmptyString(technical.actorId) || technical.actorId !== value.authorizedByActorId || technical.authorizedAt !== value.authorizedAt) push(errors, `${path}.technicalAuthorization`, "旧技术授权身份与时间必须同源");
    }
    if (value.confirmedByActorId === value.authorizedByActorId) push(errors, `${path}.authorizedByActorId`, "旧版本主人确认者与技术授权者必须是独立人员");
    if (isIsoDateTime(value.confirmedAt) && isIsoDateTime(value.authorizedAt) && Date.parse(value.confirmedAt) > Date.parse(value.authorizedAt)) {
      push(errors, `${path}.authorizedAt`, "旧技术授权不得早于主人确认");
    }
  }

  if (singleOwner && validateExactObject(value.executionBinding, PRODUCTION_EXECUTION_BINDING_FIELDS, `${path}.executionBinding`, errors)) {
    const binding = value.executionBinding;
    if (!isProductionExecutionBinding(binding)) {
      push(errors, `${path}.executionBinding`, "必须锁定本次配置选择、版本和精确平台仓库ID");
    }
  }
  const ownerSnapshot = value.ownerDecisionSnapshot;
  if (validateExactObject(ownerSnapshot, singleOwner ? SINGLE_OWNER_DECISION_SNAPSHOT_FIELDS : OWNER_DECISION_SNAPSHOT_FIELDS, `${path}.ownerDecisionSnapshot`, errors)) {
    if (ownerSnapshot.schemaVersion !== (singleOwner ? "production-owner-decision-snapshot-v2" : "production-owner-decision-snapshot-v1") || ownerSnapshot.decisionId !== value.ownerDecisionId ||
        ownerSnapshot.sourceConfirmationCardId !== value.sourceConfirmationCardId || ownerSnapshot.sourcePreparationFingerprint !== value.sourcePreparationFingerprint ||
        ownerSnapshot.sourceFinalCardInputFingerprint !== value.sourceFinalCardInputFingerprint || ownerSnapshot.sourceC1Fingerprint !== value.sourceC1Fingerprint ||
        ownerSnapshot.sourceCandidateRevision !== value.sourceCandidateRevision || ownerSnapshot.sourceSkuRevision !== value.authorizedDataRevision) {
      push(errors, `${path}.ownerDecisionSnapshot`, "主人决定身份、卡片、fingerprint与revision必须同源");
    }
    if (singleOwner && !sameJson(ownerSnapshot.executionBinding, value.executionBinding)) push(errors, `${path}.executionBinding`, "实际执行绑定必须属于主人本次确认范围");
    if (!SHA256_PATTERN.test(String(value.ownerDecisionFingerprint || "")) || fingerprintCanonicalRecord(ownerSnapshot) !== value.ownerDecisionFingerprint) {
      push(errors, `${path}.ownerDecisionFingerprint`, "主人完整决定指纹不一致");
    }
  }

  validateAuthorizationG1(value.sourceIdentity, `${path}.sourceIdentity`, errors, { source: true });
  validateAuthorizationG1(value.identity, `${path}.identity`, errors);
  if (isObject(value.sourceIdentity) && isObject(value.identity)) {
    for (const field of ["schemaVersion", "candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId", "platformProductId"]) {
      if (!sameJson(value.sourceIdentity[field], value.identity[field])) push(errors, `${path}.identity.${field}`, "授权身份只能补充merchantSku、warehouseRef和credentialAlias");
    }
  }

  const scope = value.lockedScope;
  if (validateExactObject(scope, LOCKED_SCOPE_FIELDS, `${path}.lockedScope`, errors)) {
    for (const field of ["candidateId", "skuPackageId", "variantKey", "platform", "merchantSku", "supplierSkuId", "warehouseRef", "credentialAlias", "schemaRevision", "schemaEvidenceRef", "activeProfitModelVersion", "mainImageAssetId"]) {
      if (!isNonEmptyString(scope[field])) push(errors, `${path}.lockedScope.${field}`, "必须是非空字符串");
    }
    if (!sameJson(scope.storeRef, value.identity?.storeRef) || scope.candidateId !== value.identity?.candidateId || scope.skuPackageId !== value.identity?.skuPackageId || scope.platform !== value.identity?.platform || scope.supplierSkuId !== value.identity?.supplierSkuId || scope.merchantSku !== value.identity?.merchantSku || scope.warehouseRef !== value.identity?.warehouseRef || scope.credentialAlias !== value.identity?.credentialAlias) push(errors, `${path}.lockedScope`, "身份、平台、结构化店铺与SKU必须同源");
    validateMoney(scope.buyerTargetPrice, "RUB", `${path}.lockedScope.buyerTargetPrice`, errors);
    validateMoney(scope.platformWritePrice, "CNY", `${path}.lockedScope.platformWritePrice`, errors);
    if (validateExactObject(scope.priceConversion, ["rubPerCny", "evidenceRef", "checkedAt"], `${path}.lockedScope.priceConversion`, errors)) {
      if (!Number.isFinite(scope.priceConversion.rubPerCny) || scope.priceConversion.rubPerCny <= 0 || !isNonEmptyString(scope.priceConversion.evidenceRef) || !isIsoDateTime(scope.priceConversion.checkedAt)) push(errors, `${path}.lockedScope.priceConversion`, "必须锁定有效汇率证据");
      const converted = scope.buyerTargetPrice?.amount / scope.priceConversion.rubPerCny;
      if (Number.isFinite(converted) && Math.abs(converted - scope.platformWritePrice?.amount) > 0.02) push(errors, `${path}.lockedScope.priceConversion`, "RUB/CNY价格换算不一致");
    }
    if (!Number.isInteger(scope.stock) || scope.stock < 0) push(errors, `${path}.lockedScope.stock`, "必须由主人明确锁定非负整数库存");
    for (const field of ["authorizedMediaFingerprint", "finalManifestSha256", "finalUploadsFingerprint"]) if (!SHA256_PATTERN.test(String(scope[field] || ""))) push(errors, `${path}.lockedScope.${field}`, "必须是SHA256");
    if (scope.finalManifestVersion !== "c2-final-manifest-v1") push(errors, `${path}.lockedScope.finalManifestVersion`, "必须使用c2-final-manifest-v1");
    if (!["includes_video", "excludes_video"].includes(scope.videoDisposition)) push(errors, `${path}.lockedScope.videoDisposition`, "视频处置无效");
    if (!hasExactKeys(scope.effectiveVideoRequirement, ["status", "requiredBy", "evidenceRefs"]) || !["required", "not_required"].includes(scope.effectiveVideoRequirement?.status) || !isNonEmptyString(scope.effectiveVideoRequirement?.requiredBy) || !Array.isArray(scope.effectiveVideoRequirement?.evidenceRefs)) push(errors, `${path}.lockedScope.effectiveVideoRequirement`, "必须锁定条件视频要求");
    validateFinalUploads(scope.finalUploads, scope, errors);
    if (!validateExactObject(scope.finalCardInputSnapshot, FINAL_CARD_FIELDS, `${path}.lockedScope.finalCardInputSnapshot`, errors)) {
      // Exact shape error already recorded.
    } else {
      const card = scope.finalCardInputSnapshot;
      validateAuthorizationG1(card.identity, `${path}.lockedScope.finalCardInputSnapshot.identity`, errors, { source: true });
      if (card.schemaVersion !== "c2-final-card-input-snapshot-v1" || card.skuPackageId !== scope.skuPackageId || card.variantKey !== scope.variantKey || card.sourceC1Fingerprint !== value.sourceC1Fingerprint || card.resultDataRevision !== value.authorizedDataRevision || card.sourceDataRevision + 1 !== card.resultDataRevision || card.activeProfitModelVersion !== scope.activeProfitModelVersion || card.activeProfitModel?.result !== "passed" || !sameJson(card.identity, value.sourceIdentity)) push(errors, `${path}.lockedScope.finalCardInputSnapshot`, "最终卡、身份、利润与revision必须同源");
      if (singleOwner && (!["exact", "official_reference"].includes(card.activeProfitModel?.commissionMode) ||
          scope.buyerTargetPrice?.amount !== card.activeProfitModel?.recommendedSalePriceRub || scope.platformWritePrice?.amount !== card.activeProfitModel?.recommendedSalePriceCny ||
          !sameJson(scope.priceConversion, card.activeProfitModel?.priceConversion))) push(errors, `${path}.lockedScope.platformWritePrice`, "新版授权价格必须保持当前冻结正式利润方案，不得原地改价");
      if (fingerprintCanonicalRecord(card) !== value.sourceFinalCardInputFingerprint) push(errors, `${path}.sourceFinalCardInputFingerprint`, "最终卡指纹不一致");
      if (fingerprintCanonicalRecord({ g1Identity: card.identity, c1Snapshot: card.c1Snapshot }) !== value.sourceC1Fingerprint) push(errors, `${path}.sourceC1Fingerprint`, "C1指纹不一致");
    }
    if (fingerprintCanonicalRecord({ collected: [], aiDrafts: [], finalUploads: scope.finalUploads }) !== scope.finalUploadsFingerprint) push(errors, `${path}.lockedScope.finalUploadsFingerprint`, "finalUploads指纹不一致");
    if (fingerprintCanonicalRecord({ schemaVersion: "c2-final-manifest-v1", authorizedMediaFingerprint: scope.authorizedMediaFingerprint, effectiveVideoRequirement: scope.effectiveVideoRequirement, mainImageAssetId: scope.mainImageAssetId, videoDisposition: scope.videoDisposition, assets: scope.finalUploads }) !== scope.finalManifestSha256) push(errors, `${path}.lockedScope.finalManifestSha256`, "最终素材清单指纹不一致");
    if (!["create_draft_only", "create_and_allow_validation_moderation"].includes(scope.publishScope)) push(errors, `${path}.lockedScope.publishScope`, "授权范围无效");
    if (!Array.isArray(scope.allowedWriteFields) || scope.allowedWriteFields.length === 0 || new Set(scope.allowedWriteFields).size !== scope.allowedWriteFields.length || scope.allowedWriteFields.some((field) => !PRODUCTION_WRITE_FIELDS.has(field))) push(errors, `${path}.lockedScope.allowedWriteFields`, "写字段必须非空、唯一且来自白名单");
    if (!Array.isArray(scope.exclusions) || new Set(scope.exclusions).size !== scope.exclusions.length || scope.exclusions.some((field) => !isNonEmptyString(field))) push(errors, `${path}.lockedScope.exclusions`, "排除项必须是唯一非空字符串");
    if (!sameJson(ownerSnapshot?.identity, value.identity) || !sameJson(ownerSnapshot?.buyerTargetPrice, scope.buyerTargetPrice) ||
        !sameJson(ownerSnapshot?.platformWritePrice, scope.platformWritePrice) || !sameJson(ownerSnapshot?.priceConversion, scope.priceConversion) ||
        ownerSnapshot?.stock !== scope.stock || ownerSnapshot?.publishScope !== scope.publishScope ||
        !sameJson(ownerSnapshot?.allowedWriteFields, scope.allowedWriteFields) || !sameJson(ownerSnapshot?.exclusions, scope.exclusions) ||
        ownerSnapshot?.authorizedMediaFingerprint !== scope.authorizedMediaFingerprint || ownerSnapshot?.finalManifestSha256 !== scope.finalManifestSha256 ||
        ownerSnapshot?.finalUploadsFingerprint !== scope.finalUploadsFingerprint || ownerSnapshot?.mainImageAssetId !== scope.mainImageAssetId ||
        ownerSnapshot?.videoDisposition !== scope.videoDisposition || !sameJson(ownerSnapshot?.effectiveVideoRequirement, scope.effectiveVideoRequirement)) {
      push(errors, `${path}.ownerDecisionSnapshot`, "主人决定必须不可变锁定生产身份、价格、库存、范围与媒体条件");
    }
  }

  if (value.scopeExpansionAllowed !== false || value.fieldMutationAllowed !== false || value.skuReplacementAllowed !== false || value.assetReplacementAllowed !== false) push(errors, path, "授权不得允许扩大、改字段、换SKU或换素材");
  if (value.readPolicy !== "authorization_snapshot_only" || value.productionExecuted !== false || value.platformWrites !== 0) push(errors, `${path}.readPolicy`, "B1只能冻结授权快照，禁止D或平台写入");
  collectProductionSecretErrors(value, path, errors);

  const pkg = context.skuPackage;
  if (isObject(pkg)) {
    const preparation = pkg.c2FinalAssets?.productionAuthorizationPreparation;
    if (!isObject(preparation)) {
      push(errors, `${path}.sourcePreparationFingerprint`, "缺少真实C2 preparation时授权必须fail-closed");
    } else {
      try {
        validateProductionAuthorizationPreparation({
          preparation,
          candidateId: value.identity?.candidateId,
          skuPackage: pkg,
          expectedSkuRevision: value.authorizedDataRevision
        });
      } catch (error) {
        push(errors, `${path}.sourcePreparationFingerprint`, error.message);
      }
      if (value.sourcePreparationFingerprint !== preparation.preparationFingerprint || value.sourceFinalCardInputFingerprint !== preparation.finalCardInputFingerprint || value.sourceC1Fingerprint !== preparation.sourceC1Fingerprint || value.authorizedDataRevision !== preparation.resultDataRevision || !sameJson(value.sourceIdentity, preparation.finalCardInputSnapshot?.identity)) push(errors, `${path}.sourcePreparationFingerprint`, "必须与同一C2 preparation同源");
      if (scope?.authorizedMediaFingerprint !== preparation.authorizedMediaFingerprint || scope?.finalManifestSha256 !== preparation.finalManifestSha256 || scope?.finalUploadsFingerprint !== preparation.finalUploadsFingerprint || scope?.mainImageAssetId !== preparation.mainImageAssetId || scope?.videoDisposition !== preparation.videoDisposition || !sameJson(scope?.effectiveVideoRequirement, preparation.effectiveVideoRequirement) || !sameJson(scope?.finalUploads, preparation.finalUploads) || !sameJson(scope?.finalCardInputSnapshot, preparation.finalCardInputSnapshot)) push(errors, `${path}.lockedScope`, "媒体、最终卡和preparation必须逐字段同源");
      if (scope?.schemaRevision !== preparation.targetContext?.schemaRevision || scope?.schemaEvidenceRef !== preparation.targetContext?.schemaEvidenceRef) push(errors, `${path}.lockedScope.schemaRevision`, "Schema证据必须来自同一preparation");
    }
    if (!sameJson(value.sourceIdentity, pkg.g1Identity) || scope?.candidateId !== pkg.g1Identity?.candidateId || scope?.skuPackageId !== pkg.skuPackageId || scope?.variantKey !== pkg.variantKey || scope?.platform !== pkg.targetPlatform || scope?.storeRef?.stableStoreId !== pkg.targetStore || scope?.supplierSkuId !== pkg.supplierSkuId) push(errors, `${path}.identity`, "必须与当前SKU生命周期G1身份同源");
    const lifecycleState = context.lifecycleState || (pkg.productionAuthorization === value ? "persisted" : "source");
    if (singleOwner && lifecycleState === "persisted") {
      const card = pkg.productionConfirmationCard;
      const decision = card?.ownerDecision;
      if (card?.cardId !== value.sourceConfirmationCardId || card?.status !== "owner_business_approved" || !Number.isInteger(card?.cardRevision) || card.cardRevision < 2 ||
          decision?.decisionId !== value.ownerDecisionId || decision?.selectedOption !== "approve_for_production_authorization" ||
          decision?.ownerDecisionFingerprint !== value.ownerDecisionFingerprint || !sameJson(decision?.ownerConfirmation, value.ownerConfirmation) ||
          !sameJson(decision?.executionBinding, value.executionBinding) ||
          decision?.sourceConfirmationCardId !== value.sourceConfirmationCardId || decision?.sourcePreparationFingerprint !== value.sourcePreparationFingerprint ||
          decision?.sourceFinalCardInputFingerprint !== value.sourceFinalCardInputFingerprint ||
          ["merchantSku", "warehouseRef", "credentialAlias", "stock", "buyerTargetPrice", "platformWritePrice", "priceConversion", "publishScope", "allowedWriteFields", "exclusions"].some(field => !sameJson(decision?.[field], scope?.[field]))) {
        push(errors, `${path}.ownerConfirmation`, "本次主人决定、准确范围、卡片与授权必须同一事务保存且不可漂移");
      }
    }
    const expectedRevision = lifecycleState === "persisted" ? value.resultDataRevision : value.authorizedDataRevision;
    if (pkg.dataRevision !== expectedRevision) push(errors, `${path}.resultDataRevision`, "必须绑定当前SKU revision");
  }
  if (context.candidateId !== undefined && value.identity?.candidateId !== context.candidateId) push(errors, `${path}.identity.candidateId`, "必须绑定当前candidateId");
  if (context.candidateRevision !== undefined) {
    const expectedRevision = context.lifecycleState === "persisted" ? value.resultCandidateRevision : value.sourceCandidateRevision;
    if (context.candidateRevision !== expectedRevision) push(errors, `${path}.resultCandidateRevision`, "必须绑定当前candidate revision");
  }
  const expectedAuthorizationId = `production-auth:${value.identity?.skuPackageId}:${value.sourcePreparationFingerprint}:${value.ownerDecisionId}`;
  if (value.authorizationId !== expectedAuthorizationId) push(errors, `${path}.authorizationId`, "授权ID必须确定性绑定SKU、preparation和主人决定");
  const expectedConfirmationCardId = `final-plan-card:${value.identity?.skuPackageId}:${value.authorizedDataRevision}`;
  if (value.sourceConfirmationCardId !== expectedConfirmationCardId) push(errors, `${path}.sourceConfirmationCardId`, "主人决定必须绑定当前C2最终确认卡");
  return { valid: errors.length === 0, errors };
}

function validateProductionAuthorizationGate(value, pkg, errors) {
  if (!isObject(value)) return;
  const result = validateProductionAuthorizationRecord(value, { skuPackage: pkg, candidateId: pkg.g1Identity?.candidateId, lifecycleState: "persisted" });
  errors.push(...result.errors);
}

function validateDHandoff(value, pkg, errors) {
  if (!isObject(value)) return;
  const hasSoftwareJob = value.schemaVersion === "c2-d-handoff-v2";
  validateExactObject(value, hasSoftwareJob ? [...D_HANDOFF_FIELDS, "softwareJobRef"] : D_HANDOFF_FIELDS, "dHandoff", errors);
  if (hasSoftwareJob ? value.status !== "software_job_queued"
    : value.schemaVersion !== "c2-d-handoff-v1" || value.status !== "awaiting_explicit_d_start") {
    push(errors, "dHandoff.status", "必须明确区分历史交接与同笔创建的软件作业交接");
  }
  for (const field of ["handoffId", "candidateId", "skuPackageId", "productionAuthorizationId", "ownerDecisionId", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint"]) {
    if (!isNonEmptyString(value[field])) push(errors, `dHandoff.${field}`, "必须是非空字符串");
  }
  for (const field of ["sourceCandidateRevision", "resultCandidateRevision", "sourceSkuRevision", "resultSkuRevision"]) {
    if (!isNonNegativeInteger(value[field])) push(errors, `dHandoff.${field}`, "必须是非负修订号");
  }
  if (value.resultCandidateRevision !== value.sourceCandidateRevision + 1 || value.resultSkuRevision !== value.sourceSkuRevision + 1) push(errors, "dHandoff.resultSkuRevision", "交接修订必须单步递增");
  if (value.skuPackageId !== pkg.skuPackageId || value.variantKey !== pkg.variantKey || value.resultSkuRevision !== pkg.dataRevision) push(errors, "dHandoff.skuPackageId", "SKU、variantKey或当前revision不一致");
  validateG1Identity(value.identity, pkg, errors, "dHandoff.identity");
  if (value.productionPlanCreated !== false || value.executionIntentCreated !== false || value.softwareJobCreated !== hasSoftwareJob ||
      value.dWritePermissionGranted !== false || value.externalRequests !== 0 || value.platformWrites !== 0) {
    push(errors, "dHandoff", "交接只记录授权与已声明的作业，不得宣称已执行外部动作");
  }
  const authorization = pkg.productionAuthorization;
  if (!isObject(authorization) || value.productionAuthorizationId !== authorization.authorizationId ||
      value.ownerDecisionId !== authorization.ownerDecisionId || value.sourcePreparationFingerprint !== authorization.sourcePreparationFingerprint ||
      value.sourceFinalCardInputFingerprint !== authorization.sourceFinalCardInputFingerprint || !sameJson(value.identity, authorization.identity) ||
      value.sourceCandidateRevision !== authorization.sourceCandidateRevision || value.resultCandidateRevision !== authorization.resultCandidateRevision ||
      value.sourceSkuRevision !== authorization.authorizedDataRevision || value.resultSkuRevision !== authorization.resultDataRevision) {
    push(errors, "dHandoff", "必须与同一事务生成的ProductionAuthorization完全绑定");
  }
  if (value.candidateId !== authorization?.identity?.candidateId || value.handoffId !== `d-handoff:${value.productionAuthorizationId}`) {
    push(errors, "dHandoff.handoffId", "handoff身份与确定性ID必须绑定授权");
  }
  if (!isIsoDateTime(value.createdAt) || value.createdAt !== authorization?.authorizedAt || value.uniqueOwner !== "d_software") {
    push(errors, "dHandoff.createdAt", "handoff时间与唯一D owner必须锁定同一ProductionAuthorization");
  }
  if (hasSoftwareJob) {
    const ref = value.softwareJobRef;
    validateExactObject(ref, ["jobId", "jobType", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "inputFingerprint"], "dHandoff.softwareJobRef", errors);
    const fingerprint = isObject(authorization) ? fingerprintCanonicalRecord(authorization) : null;
    if (!isObject(ref) || ref.jobType !== "d_production_execution" || ref.candidateId !== value.candidateId ||
        ref.skuPackageId !== value.skuPackageId || ref.sourceRevision !== value.sourceCandidateRevision ||
        ref.resultRevision !== value.resultCandidateRevision || ref.inputFingerprint !== fingerprint ||
        dProductionJobRound(ref.jobId, fingerprint) !== 1) {
      push(errors, "dHandoff.softwareJobRef", "必须精确绑定同一PA的唯一D作业和冻结修订");
    }
  }
}

export function validateOpportunityPackage(pkg) {
  const errors = [];
  validateCommon(pkg, ENTITY_TYPES.OPPORTUNITY, BUSINESS_PHASES.OPPORTUNITY, errors);
  if (!isObject(pkg)) return { valid: false, errors };
  requireString(pkg.directionName, "directionName", errors);
  requireString(pkg.targetPlatform, "targetPlatform", errors);
  requireString(pkg.targetStore, "targetStore", errors);
  requireArray(pkg.salesSnapshots, "salesSnapshots", errors);
  if (pkg.marketAssessment !== undefined && pkg.marketAssessment !== null) {
    const marketValidation = validateAMarketAssessment(pkg.marketAssessment);
    for (const error of marketValidation.errors) {
      push(errors, "marketAssessment." + error.path, error.message);
    }
    if (pkg.marketAssessment?.sourceOpportunityRevision !== pkg.dataRevision) {
      push(errors, "marketAssessment.sourceOpportunityRevision", "必须对应当前OpportunityPackage修订号");
    }
  }
  requireArray(pkg.supplierOptions, "supplierOptions", errors);
  if (!isNullableString(pkg.recommendedSupplierOptionId)) {
    push(errors, "recommendedSupplierOptionId", "必须是字符串或null");
  }
  if (!isNullableString(pkg.confirmedSupplierOptionId)) {
    push(errors, "confirmedSupplierOptionId", "必须是字符串或null");
  }
  validateSupplierSearch(pkg.supplierSearch, errors);
  return { valid: errors.length === 0, errors };
}

export function validateSkuLifecyclePackage(pkg) {
  const errors = [];
  validateCommon(pkg, ENTITY_TYPES.SKU, BUSINESS_PHASES.SKU, errors);
  if (!isObject(pkg)) return { valid: false, errors };
  for (const [key, label] of [
    ["skuPackageId", "SKU生命周期ID"],
    ["supplierOptionId", "已确认供应方案ID"],
    ["supplierSkuId", "供应商SKU ID"],
    ["variantKey", "变体标识"],
    ["targetPlatform", "目标平台"],
    ["targetStore", "目标店铺"]
  ]) {
    if (!isNonEmptyString(pkg[key])) push(errors, key, `${label}必须是非空字符串`);
  }
  validateG1Identity(pkg.g1Identity, pkg, errors);
  requireArray(pkg.inheritedSalesSnapshotRefs, "inheritedSalesSnapshotRefs", errors);
  if (!isObject(pkg.selectedSupplySnapshot)) push(errors, "selectedSupplySnapshot", "必须保存已确认供应快照");
  if (!isObject(pkg.skuFacts)) push(errors, "skuFacts", "必须是对象");
  if (!isObject(pkg.c1ProductPlan) && pkg.c1ProductPlan !== null) push(errors, "c1ProductPlan", "必须是对象或null");
  if (Object.hasOwn(pkg, "c1RightsReviewRecord")) {
    const review = validateC1SkuRightsReviewRecord(pkg.c1RightsReviewRecord);
    for (const code of review.errors) push(errors, "c1RightsReviewRecord", code);
  }
  if (!isObject(pkg.c2FinalAssets) && pkg.c2FinalAssets !== null) push(errors, "c2FinalAssets", "必须是对象或null");
  if (isObject(pkg.c2FinalAssets)) validateC2AssetLifecycleGate(pkg.c2FinalAssets, errors);
  if (!isObject(pkg.productionAuthorization) && pkg.productionAuthorization !== null) {
    push(errors, "productionAuthorization", "必须是对象或null");
  }
  if (isObject(pkg.productionAuthorization)) validateProductionAuthorizationGate(pkg.productionAuthorization, pkg, errors);
  if (!isObject(pkg.dHandoff) && pkg.dHandoff !== null && pkg.dHandoff !== undefined) {
    push(errors, "dHandoff", "必须是对象或null");
  }
  if (isObject(pkg.dHandoff)) validateDHandoff(pkg.dHandoff, pkg, errors);
  if (isObject(pkg.productionAuthorization) !== isObject(pkg.dHandoff)) {
    push(errors, "dHandoff", "ProductionAuthorization与唯一D handoff必须同生同缺");
  }
  if (!isObject(pkg.productionConfirmationCard) && pkg.productionConfirmationCard !== null && pkg.productionConfirmationCard !== undefined) {
    push(errors, "productionConfirmationCard", "必须是对象或null");
  }
  if (isObject(pkg.productionConfirmationCard)) {
    if (pkg.productionConfirmationCard.status === "awaiting_owner_business_confirmation") {
      if (pkg.businessPhase !== "C2") push(errors, "businessPhase", "等待主人确认商品方案时必须停留在C2");
      if (pkg.productionAuthorization !== null) push(errors, "productionAuthorization", "商品方案确认前不得生成生产授权");
    }
    // Owner approval can be saved before a different authorized person issues ProductionAuthorization.
  }
  if (!isObject(pkg.productionRecord) && pkg.productionRecord !== null) push(errors, "productionRecord", "必须是对象或null");
  validateDAssetTransportGate(pkg.dAssetTransport, errors);
  if (!isObject(pkg.externalListingRecord) && pkg.externalListingRecord !== null) push(errors, "externalListingRecord", "必须是对象或null");
  if (!isObject(pkg.eVerificationRecord) && pkg.eVerificationRecord !== null) push(errors, "eVerificationRecord", "必须是对象或null");
  if (isObject(pkg.productionRecord) && isObject(pkg.externalListingRecord)) {
    push(errors, "externalListingRecord", "ProductionRecord与ExternalListingRecord互斥，禁止把外部发现冒充系统创建");
  }
  validateProfitModels(pkg, errors);
  validateReadbackPolicy(pkg.readbackPolicy, errors);
  requireArray(pkg.readbackHistory, "readbackHistory", errors);
  if (["D", "E"].includes(pkg.businessPhase)) {
    if (!["completed", "seo_draft_ready"].includes(pkg.c1ProductPlan?.status)) push(errors, "c1ProductPlan.status", "进入D/E前C1必须完成事实核验和SEO草稿");
    if (pkg.c2FinalAssets?.status !== "completed") push(errors, "c2FinalAssets.status", "进入D/E前C2必须完成");
    if (pkg.productionAuthorization?.status !== "confirmed") {
      push(errors, "productionAuthorization.status", "进入D/E前必须取得精确生产授权");
    }
  }
  if (pkg.businessPhase === "E" && !isObject(pkg.productionRecord) && !isObject(pkg.externalListingRecord)) {
    push(errors, "productionRecord", "进入E前必须存在ProductionRecord或ExternalListingRecord");
  }
  if (isObject(pkg.eVerificationRecord)) {
    if (pkg.businessPhase !== "E") push(errors, "businessPhase", "完成E验证后业务阶段必须为E");
    if (pkg.eVerificationRecord.outcome === "listed_verified" && !isObject(pkg.productionRecord)) {
      push(errors, "productionRecord", "listed_verified必须来自ProductionRecord");
    }
    if (pkg.eVerificationRecord.outcome === "externally_verified" && !isObject(pkg.externalListingRecord)) {
      push(errors, "externalListingRecord", "externally_verified必须来自ExternalListingRecord");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateLifecyclePackage(pkg) {
  if (pkg?.entityType === ENTITY_TYPES.OPPORTUNITY) return validateOpportunityPackage(pkg);
  if (pkg?.entityType === ENTITY_TYPES.SKU) return validateSkuLifecyclePackage(pkg);
  return { valid: false, errors: [{ path: "entityType", message: "未知的数据包类型" }] };
}

export function assertValidLifecyclePackage(pkg) {
  const result = validateLifecyclePackage(pkg);
  if (!result.valid) {
    const detail = result.errors.map((item) => `${item.path}: ${item.message}`).join("；");
    throw new Error(`商品生命周期数据校验失败：${detail}`);
  }
  return pkg;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateLifecycleTransition(previous, next) {
  const errors = [...validateLifecyclePackage(next).errors];
  if (!isObject(previous) || !isObject(next)) {
    return { valid: false, errors: [...errors, { path: "$", message: "前后数据包都必须存在" }] };
  }
  if (previous.entityType !== next.entityType) push(errors, "entityType", "生命周期内不得更换数据包类型");
  if (previous.parentOpportunityId !== next.parentOpportunityId) push(errors, "parentOpportunityId", "不得更换所属商品方向");
  if (previous.skuPackageId !== next.skuPackageId) push(errors, "skuPackageId", "不得更换SKU生命周期ID");
  if (next.dataRevision !== previous.dataRevision + 1) push(errors, "dataRevision", "必须在原修订号上加1");

  if (TECHNICAL_FAILURES.has(next.technicalStatus)) {
    if (previous.businessPhase !== next.businessPhase) push(errors, "businessPhase", "技术失败不得改变业务阶段");
    if (previous.businessResult !== next.businessResult) push(errors, "businessResult", "技术失败不得改变业务结果");
  }

  if (previous.entityType === ENTITY_TYPES.SKU) {
    const previousModels = Array.isArray(previous.profitModels) ? previous.profitModels : [];
    const nextModels = Array.isArray(next.profitModels) ? next.profitModels : [];
    if (nextModels.length < previousModels.length) {
      push(errors, "profitModels", "历史利润版本不得删除");
    } else if (!sameJson(previousModels, nextModels.slice(0, previousModels.length))) {
      push(errors, "profitModels", "历史利润版本不得覆盖或改写");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function appendProfitModelVersion(pkg, model) {
  assertValidLifecyclePackage(pkg);
  if (pkg.entityType !== ENTITY_TYPES.SKU) throw new Error("只有SKU生命周期包可以追加利润版本");
  const nextNumber = pkg.profitModels.length
    ? parseProfitVersion(pkg.profitModels[pkg.profitModels.length - 1].profitModelVersion) + 1
    : 1;
  if (model.profitModelVersion !== `profit-v${nextNumber}`) {
    throw new Error(`新的利润版本必须是profit-v${nextNumber}`);
  }
  const next = structuredClone(pkg);
  next.profitModels.push(structuredClone(model));
  next.activeProfitModelVersion = model.profitModelVersion;
  next.dataRevision += 1;
  next.audit.updatedAt = model.calculatedAt;
  assertValidLifecyclePackage(next);
  return next;
}

export function supplierSearchStopReason(search) {
  if (!isObject(search?.limits)) return "invalid_limits";
  if (search.searchRounds >= search.limits.maxSearchRounds) return "max_search_rounds";
  if (search.supplierOptionsFound >= search.limits.maxSupplierOptions) return "max_supplier_options";
  if (search.consecutiveNoEvidenceRounds >= search.limits.maxConsecutiveNoEvidenceRounds) {
    return "max_consecutive_no_evidence_rounds";
  }
  return null;
}

export function readbackStopReason(policy) {
  if (!isObject(policy)) return "invalid_policy";
  if (policy.automaticAttempts >= policy.maxAutomaticAttempts) return "max_automatic_attempts";
  if (policy.consecutiveSameFailureCount >= policy.maxConsecutiveSameFailure) {
    return "max_consecutive_same_failure";
  }
  return null;
}
