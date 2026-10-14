import { derivePlatformWriteBindings } from "./platform-write-bindings.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertValidProductionAuthorization, assertCurrentProductionAuthorization, validateProductionAuthorization, readAuthorizedProductionSnapshot } from "./production-authorization.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { createOzonProductionStrategy } from "./ozon-production-strategy.mjs";
import { assertAuthorizedMediaUnchanged, fingerprintAuthorizedMedia } from "./production-authorization-preparation.mjs";

export const PRODUCTION_PLAN_VERSION = "production-plan-v1.1";
const PLAN_FIELDS = Object.freeze([
  "schemaVersion", "planId", "mode", "status", "createdAt", "sourceAuthorization", "sourceReadPolicy", "sourceDataAccess",
  "productResearchPerformed", "platformWrites", "productCreated", "assetsUploaded", "readbackPerformed"
]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = value => typeof value === "string" && value.trim().length > 0;
const iso = value => nonEmpty(value) && !Number.isNaN(Date.parse(value));

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function fingerprintProductionAuthorization(authorization) {
  assertValidProductionAuthorization(authorization);
  return fingerprintCanonicalRecord(authorization);
}

export function fingerprintProductionPlan(plan) {
  assertValidProductionPlan(plan);
  return fingerprintCanonicalRecord(plan);
}

function planId(authorization) {
  return `production-plan:${authorization.authorizationId}:${fingerprintProductionAuthorization(authorization).slice(0, 12)}`;
}

export function validateProductionPlan(plan) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });
  if (!isObject(plan)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (Object.keys(plan).length !== PLAN_FIELDS.length || PLAN_FIELDS.some(field => !Object.hasOwn(plan, field))) {
    push("$", "必须使用完整sourceAuthorization合同，禁止旧平铺镜像或未声明字段");
  }
  const constants = {
    schemaVersion: PRODUCTION_PLAN_VERSION, mode: "simulation", status: "prepared",
    sourceReadPolicy: "authorization_snapshot_only", sourceDataAccess: "production_authorization_only",
    productResearchPerformed: false, platformWrites: 0, productCreated: false, assetsUploaded: 0, readbackPerformed: false
  };
  for (const [field, value] of Object.entries(constants)) if (plan[field] !== value) push(field, "与计划合同不一致");
  if (!iso(plan.createdAt)) push("createdAt", "必须是有效时间");
  const authorization = validateProductionAuthorization(plan.sourceAuthorization);
  if (!authorization.valid) {
    for (const error of authorization.errors) push(`sourceAuthorization.${error.path}`, error.message);
  } else {
    if (plan.planId !== planId(plan.sourceAuthorization)) push("planId", "必须绑定完整正式授权");
    if (Date.parse(plan.createdAt) < Date.parse(plan.sourceAuthorization.authorizedAt)) push("createdAt", "不能早于正式授权");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidProductionPlan(plan) {
  const result = validateProductionPlan(plan);
  if (!result.valid) throw new Error(`ProductionPlan校验失败：${result.errors.map(item => `${item.path}: ${item.message}`).join("；")}`);
  return plan;
}

function requireFact(field, path) {
  if (!isObject(field) || field.verificationStatus !== "confirmed" || !Object.hasOwn(field, "value") ||
      !Array.isArray(field.sourceRefs) || field.sourceRefs.length === 0 || field.sourceRefs.some(ref => !nonEmpty(ref))) {
    throw new Error(`PRODUCTION_PLAN_INPUT_GAP: ${path}缺少已确认事实和来源`);
  }
  return field.value;
}

function requirePositive(value, path) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`PRODUCTION_PLAN_INPUT_GAP: ${path}必须是正数`);
}

// Transient execution inputs have one source. They are never saved as a second plan or accepted from the browser.
export function projectProductionPlanInputs(plan) {
  assertValidProductionPlan(plan);
  const authorization = plan.sourceAuthorization;
  const scope = authorization.lockedScope;
  const c1 = scope.finalCardInputSnapshot.c1Snapshot;
  if (!isObject(c1)) throw new Error("PRODUCTION_PLAN_INPUT_GAP: 缺少冻结C1");
  const title = c1.seoTitleDraft?.text;
  const description = c1.descriptionDraft?.text;
  const bullets = Array.isArray(c1.bulletPointsDraft) ? c1.bulletPointsDraft.map(item => item?.text) : null;
  const keywords = Array.isArray(c1.searchKeywordsDraft?.keywords) ? c1.searchKeywordsDraft.keywords.map(item => item?.query) : null;
  if (!nonEmpty(title) || !nonEmpty(description) || !Array.isArray(bullets) || !bullets.length || bullets.some(value => !nonEmpty(value)) ||
      !Array.isArray(keywords) || !keywords.length || keywords.some(value => !nonEmpty(value))) {
    throw new Error("PRODUCTION_PLAN_INPUT_GAP: 冻结标题、描述、五点或搜索词不完整");
  }
  const weight = requireFact(c1.productAttributes?.weight, "productAttributes.weight");
  const dimensions = requireFact(c1.productAttributes?.dimensions, "productAttributes.dimensions");
  if (!isObject(weight) || !["g", "kg"].includes(weight.unit) || !isObject(dimensions) || !["mm", "cm"].includes(dimensions.unit)) {
    throw new Error("PRODUCTION_PLAN_INPUT_GAP: 包装重量或尺寸单位不明确");
  }
  requirePositive(weight.value, "packing.weight");
  for (const field of ["length", "width", "height"]) requirePositive(dimensions[field], `packing.dimensions.${field}`);
  const writeBindings = requireFact(c1.schemaSnapshot?.writeBindings, "schemaSnapshot.writeBindings");
  const rawSchema = c1.inputSnapshots?.platformSchemaRules;
  if (!isObject(writeBindings) || writeBindings.schemaRevision !== scope.schemaRevision ||
      rawSchema?.schemaRevision !== scope.schemaRevision || !isDeepStrictEqual(writeBindings, derivePlatformWriteBindings(rawSchema)) ||
      !nonEmpty(writeBindings.evidenceRef) || !isObject(writeBindings.content) || !Array.isArray(writeBindings.requiredAttributes)) {
    throw new Error("PRODUCTION_PLAN_INPUT_GAP: 写入绑定未与冻结Schema修订对齐");
  }
  if (scope.platform === "ozon") {
    for (const field of ["descriptionCategoryId", "typeId"]) {
      const value = requireFact(c1.platformCategory?.[field], `platformCategory.${field}`);
      if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`PRODUCTION_PLAN_INPUT_GAP: ${field}不是准确平台ID`);
    }
  }
  return deepFreeze({
    platform: scope.platform, store: scope.storeRef.stableStoreId, storeRef: structuredClone(scope.storeRef), candidateId: scope.candidateId,
    skuPackageId: scope.skuPackageId, sku: { supplierSkuId: scope.supplierSkuId, merchantSku: scope.merchantSku, variantKey: scope.variantKey },
    warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias,
    title, titleVersion: authorization.sourceC1Fingerprint,
    content: { description, bulletPoints: [...bullets], searchKeywords: [...keywords] }, contentVersion: authorization.sourceC1Fingerprint,
    attributes: structuredClone(c1.productAttributes), attributeVersion: c1.factVerificationVersion,
    packing: { weight: structuredClone(weight), dimensions: structuredClone(dimensions) },
    schemaWriteBindings: structuredClone(writeBindings), platformCategory: structuredClone(c1.platformCategory),
    platformSchemaAttributes: rawSchema.attributes === undefined ? null : structuredClone(rawSchema.attributes),
    buyerTargetPrice: structuredClone(scope.buyerTargetPrice), platformWritePrice: structuredClone(scope.platformWritePrice), priceConversion: structuredClone(scope.priceConversion),
    stock: scope.stock, assetsFinalUploadsVersion: scope.finalManifestVersion, finalUploads: structuredClone(scope.finalUploads),
    authorizedMediaFingerprint: scope.authorizedMediaFingerprint,
    executionStrategy: createOzonProductionStrategy({ platform: scope.platform, finalUploads: scope.finalUploads }),
    publishScope: scope.publishScope, exclusions: [...scope.exclusions], allowedWriteFields: [...scope.allowedWriteFields]
  });
}

export function createProductionPlan({ productionAuthorization, candidateId, candidateRevision, skuPackage, createdAt }) {
  if (!iso(createdAt)) throw new Error("PRODUCTION_PLAN_INPUT_GAP: 创建时间无效");
  assertCurrentProductionAuthorization(productionAuthorization, { observedAt: createdAt });
  const authorization = readAuthorizedProductionSnapshot({ productionAuthorization, candidateId, candidateRevision, skuPackage, checkedAt: createdAt });
  const plan = {
    schemaVersion: PRODUCTION_PLAN_VERSION, planId: planId(authorization), mode: "simulation", status: "prepared", createdAt,
    sourceAuthorization: authorization, sourceReadPolicy: "authorization_snapshot_only", sourceDataAccess: "production_authorization_only",
    productResearchPerformed: false, platformWrites: 0, productCreated: false, assetsUploaded: 0, readbackPerformed: false
  };
  projectProductionPlanInputs(plan);
  return deepFreeze(plan);
}

/** One transient payload projection, shared by preparation and the final write boundary. */
export function projectProductionPlanImportPayload({ productionPlan, resolvedFinalUploads }) {
  const inputs = projectProductionPlanInputs(productionPlan);
  if (!Array.isArray(resolvedFinalUploads) || resolvedFinalUploads.length !== inputs.finalUploads.length) {
    throw new Error("D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH: 最终素材数量不属于冻结计划");
  }
  // 换地址之前先确认：计划里这批地址就是主人当初授权的那批，顺序一字不差。
  assertAuthorizedMediaUnchanged(inputs.finalUploads, inputs.authorizedMediaFingerprint, "productionPlanInputs");
  const finalUploads = inputs.finalUploads.map((asset, index) => {
    const resolved = resolvedFinalUploads[index];
    if (!resolved || ["assetId", "sha256", "order", "role"].some(field => resolved[field] !== asset[field]) ||
        !nonEmpty(resolved.platformAcceptedUrl)) throw new Error("D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH: 最终素材不属于冻结计划");
    return { ...structuredClone(asset), assetRef: resolved.platformAcceptedUrl };
  });
  // 真正会写进 import 请求的那批地址，也按同一规则取一次指纹，交给适配器在发出前再对一次。
  const authorizedMedia = {
    fingerprint: fingerprintAuthorizedMedia(finalUploads),
    primaryImage: finalUploads[0].assetRef,
    images: finalUploads.slice(1).map(asset => asset.assetRef)
  };
  return deepFreeze({
    mode: "single_sku_create_and_moderate", merchantSku: inputs.sku.merchantSku,
    platform: inputs.platform, store: inputs.store, storeRef: structuredClone(inputs.storeRef),
    warehouseRef: inputs.warehouseRef, credentialAlias: inputs.credentialAlias,
    skuPackageId: inputs.skuPackageId, supplierSkuId: inputs.sku.supplierSkuId, variantKey: inputs.sku.variantKey,
    title: inputs.title, content: structuredClone(inputs.content), attributes: structuredClone(inputs.attributes),
    packing: structuredClone(inputs.packing), schemaWriteBindings: structuredClone(inputs.schemaWriteBindings),
    platformSchemaAttributes: structuredClone(inputs.platformSchemaAttributes),
    platformCategory: structuredClone(inputs.platformCategory), platformWritePrice: structuredClone(inputs.platformWritePrice),
    finalUploads, authorizedMedia, publishScope: inputs.publishScope
  });
}

export function validateProductionPlanAuthorizationBinding(plan, authorization) {
  assertValidProductionPlan(plan);
  assertValidProductionAuthorization(authorization);
  const matches = isDeepStrictEqual(plan.sourceAuthorization, authorization);
  return deepFreeze({ valid: matches, status: matches ? "authorization_unchanged" : "authorization_drift_detected", planId: plan.planId,
    sourceAuthorizationId: plan.sourceAuthorization.authorizationId, currentAuthorizationId: authorization.authorizationId });
}
