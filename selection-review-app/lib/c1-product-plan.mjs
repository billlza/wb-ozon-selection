import { derivePlatformWriteBindings } from "./platform-write-bindings.mjs";
import { resolveC1SupplierFactRevision, assertC1SupplierFactRevisionProjection, ConfirmedSupplierInputError } from "./confirmed-supplier-inputs.mjs";
import {
  assertValidLifecyclePackage,
  validateLifecycleTransition,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { assertValidProfitModel } from "./profit-model.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { assertCanonicalFrozenRef, assertNoRawPersistenceKeys, assertNoProductionSecrets, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { C1_CURRENT_FACT_VERIFICATION_VERSION, C1SkuRightsReviewError, assertC1SkuRightsReviewEvidence, assertC1SkuRightsReviewRecord, projectC1SkuRightsReviewFacts } from "./c1-sku-rights-review.mjs";

export const C1_CANONICAL_CONTRACT_VERSION = "g1-c1-domain-contract-v1";
export const C1_PRODUCT_PLAN_SCHEMA_VERSION = "c1-product-plan-v1.1";
export const C1_FACT_VERIFICATION_VERSION = C1_CURRENT_FACT_VERIFICATION_VERSION;

/**
 * 能形成正式B、因而能进文案素材的两种佣金来源。
 * `estimated`（主人授权的估算）不在其中——那是条件测算。上架那一刻另有更严的一道闸门，只认 `exact`。
 */
export const FORMAL_B_COMMISSION_MODES = Object.freeze(["exact", "official_reference"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const G1_IDENTITY_FIELDS = Object.freeze([
  "schemaVersion", "candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId",
  "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"
]);
const G1_STORE_REF_FIELDS = Object.freeze(["stableStoreId", "platformStoreId", "mappingVersion"]);
const G1_REQUIRED_SENTINELS = new Set(["unknown", "null", "undefined", "not_applicable"]);

function assertG1RequiredString(value, field) {
  if (!nonEmptyString(value) || G1_REQUIRED_SENTINELS.has(value.trim().toLowerCase())) {
    throw new Error(`C1_G1_IDENTITY_REQUIRED: ${field}必须是已持久的非哨兵身份`);
  }
  assertCanonicalFrozenRef(value, field);
}

export function normalizeC1SourceIdentity(value, path = "skuPackage.g1Identity") {
  assertNoRawPersistenceKeys(value, path);
  assertNoProductionSecrets(value, path);
  if (!isObject(value) || !sameJson(Object.keys(value).sort(), [...G1_IDENTITY_FIELDS].sort()) ||
      value.schemaVersion !== "g1-identity-v1") {
    throw new Error(`C1_G1_IDENTITY_REQUIRED: ${path}必须是完整g1-identity-v1`);
  }
  for (const field of ["candidateId", "skuPackageId", "platform", "supplierSkuId"]) {
    assertG1RequiredString(value[field], `${path}.${field}`);
  }
  if (!isObject(value.storeRef) ||
      !sameJson(Object.keys(value.storeRef).sort(), [...G1_STORE_REF_FIELDS].sort())) {
    throw new Error(`C1_G1_IDENTITY_REQUIRED: ${path}.storeRef必须是完整稳定店铺身份`);
  }
  for (const field of G1_STORE_REF_FIELDS) {
    assertG1RequiredString(value.storeRef[field], `${path}.storeRef.${field}`);
  }
  for (const field of ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    if (value[field] !== "not_applicable") {
      throw new Error(`C1_G1_IDENTITY_REQUIRED: ${path}.${field}在C1/C2准备阶段必须明确为not_applicable`);
    }
  }
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    candidateId: value.candidateId,
    skuPackageId: value.skuPackageId,
    platform: value.platform,
    storeRef: {
      stableStoreId: value.storeRef.stableStoreId,
      platformStoreId: value.storeRef.platformStoreId,
      mappingVersion: value.storeRef.mappingVersion
    },
    supplierSkuId: value.supplierSkuId,
    merchantSku: value.merchantSku,
    warehouseRef: value.warehouseRef,
    credentialAlias: value.credentialAlias,
    platformProductId: value.platformProductId
  });
}

export function validatePlatformSchemaEvidence(evidence) {
  const errors = [];
  if (!isObject(evidence)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  for (const field of ["evidenceId", "platform", "store", "schemaRevision"]) {
    if (!nonEmptyString(evidence[field]) || evidence[field] === "unknown") {
      push(errors, field, "必须是已确认的非空字符串");
    }
  }
  if (!isoDateTime(evidence.collectedAt)) push(errors, "collectedAt", "必须是有效时间");
  if (!Array.isArray(evidence.requiredFields)) {
    push(errors, "requiredFields", "必须是数组");
  } else {
    const seen = new Set();
    for (const [index, field] of evidence.requiredFields.entries()) {
      if (!isObject(field)) {
        push(errors, `requiredFields[${index}]`, "必须是对象");
        continue;
      }
      if (!nonEmptyString(field.fieldKey)) push(errors, `requiredFields[${index}].fieldKey`, "必须是非空字符串");
      if (!nonEmptyString(field.label)) push(errors, `requiredFields[${index}].label`, "必须是非空字符串");
      if (field.required !== true) push(errors, `requiredFields[${index}].required`, "这里只保存平台必填字段");
      if (field.sourceAttributeKeys !== undefined) {
        if (!Array.isArray(field.sourceAttributeKeys)) {
          push(errors, `requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组");
        } else {
          for (const key of field.sourceAttributeKeys) {
            if (!nonEmptyString(key)) {
              push(errors, `requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组");
              break;
            }
          }
        }
      }
      if (seen.has(field.fieldKey)) push(errors, `requiredFields[${index}].fieldKey`, "字段不得重复");
      seen.add(field.fieldKey);
    }
  }
  // 类目全部属性与字典号：2026-09-17 新增的可选字段。老计划里没有它，
  // 新计划给了就必须成形——字典号是发 import 时 dictionaryValueId 的唯一来源，
  // 这里放行一个坏形状，代价是真发商品那一刻才炸。
  if (Object.hasOwn(evidence, "attributes")) {
    if (!Array.isArray(evidence.attributes)) {
      push(errors, "attributes", "必须是数组");
    } else {
      const seenAttribute = new Set();
      for (const [index, attribute] of evidence.attributes.entries()) {
        if (!isObject(attribute)) {
          push(errors, `attributes[${index}]`, "必须是对象");
          continue;
        }
        if (!nonEmptyString(attribute.fieldKey)) push(errors, `attributes[${index}].fieldKey`, "必须是非空字符串");
        if (!nonEmptyString(attribute.label)) push(errors, `attributes[${index}].label`, "必须是非空字符串");
        if (typeof attribute.required !== "boolean") push(errors, `attributes[${index}].required`, "必须是布尔值");
        if (!Number.isInteger(attribute.dictionaryId) || attribute.dictionaryId < 0) {
          push(errors, `attributes[${index}].dictionaryId`, "必须是非负整数，0表示无字典");
        }
        if (seenAttribute.has(attribute.fieldKey)) push(errors, `attributes[${index}].fieldKey`, "属性不得重复");
        seenAttribute.add(attribute.fieldKey);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateC1ProductPlan(plan) {
  const errors = [];
  if (!isObject(plan)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (plan.schemaVersion !== C1_PRODUCT_PLAN_SCHEMA_VERSION) push(errors, "schemaVersion", `必须是${C1_PRODUCT_PLAN_SCHEMA_VERSION}`);
  if (!nonEmptyString(plan.c1PlanId)) push(errors, "c1PlanId", "必须是非空字符串");
  if (Object.hasOwn(plan, "supersedes") && (!isObject(plan.supersedes) || Object.keys(plan.supersedes).length !== 2 ||
      !isCanonicalFrozenRef(plan.supersedes.c1PlanId) || !isCanonicalFrozenRef(plan.supersedes.historyRef) ||
      plan.supersedes.c1PlanId === plan.c1PlanId)) push(errors, "supersedes", "必须引用不同的历史C1计划及原子保存的历史结果");
  if (!["inputs_ready", "facts_checked", "seo_draft_ready"].includes(plan.status)) {
    push(errors, "status", "必须是inputs_ready、facts_checked或seo_draft_ready");
  }
  if (!isoDateTime(plan.createdAt)) push(errors, "createdAt", "必须是有效时间");

  for (const section of ["inputRefs", "identity", "inputSnapshots"]) {
    if (!isObject(plan[section])) push(errors, section, "必须是对象");
  }
  if (isObject(plan.inputRefs)) {
    for (const field of ["salesSnapshotId", "selectedSupplySnapshotId", "profitModelVersion", "platformSchemaEvidenceId"]) {
      if (!nonEmptyString(plan.inputRefs[field])) push(errors, `inputRefs.${field}`, "必须是非空字符串");
    }
  }
  if (isObject(plan.identity)) {
    for (const field of ["parentOpportunityId", "skuPackageId", "supplierOptionId", "supplierSkuId", "variantKey", "targetPlatform", "targetStore"]) {
      if (!nonEmptyString(plan.identity[field])) push(errors, `identity.${field}`, "必须是非空字符串");
    }
  }
  if (isObject(plan.inputSnapshots)) {
    for (const field of ["salesSnapshot", "confirmedSupplierSkuSnapshot", "profitModel", "platformSchemaRules"]) {
      if (!isObject(plan.inputSnapshots[field])) push(errors, `inputSnapshots.${field}`, "必须是对象");
    }
    if (isObject(plan.inputSnapshots.platformSchemaRules)) {
      const schemaValidation = validatePlatformSchemaEvidence(plan.inputSnapshots.platformSchemaRules);
      for (const error of schemaValidation.errors) push(errors, `inputSnapshots.platformSchemaRules.${error.path}`, error.message);
    }
  }
  if (Object.hasOwn(plan, "sourceFactsRevision") || (isObject(plan.productAttributes) && Object.hasOwn(plan.productAttributes, "ownerDeclaredFacts"))) {
    try { assertC1SupplierFactRevisionProjection({ plan, sourceIdentity: plan.sourceFactsRevision?.sourceIdentity }); }
    catch (error) {
      if (!(error instanceof ConfirmedSupplierInputError)) throw error;
      push(errors, "sourceFactsRevision", error.code);
    }
  }
  if (!Array.isArray(plan.externalAccesses) || plan.externalAccesses.length !== 0) {
    push(errors, "externalAccesses", "C1数据进入不得访问Ozon、WB或1688");
  }
  if (plan.profitRecalculated !== false) push(errors, "profitRecalculated", "C1不得重新计算利润");
  if (plan.skuReplaced !== false) push(errors, "skuReplaced", "C1不得替换SKU");
  for (const field of ["finalSeo", "finalAttributes", "complianceDecision", "generatedAssets", "productionPayload"]) {
    if (plan[field] !== null) push(errors, field, "C1事实核验阶段必须保持null");
  }
  for (const field of [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ]) {
    if (!isObject(plan[field]) && plan[field] !== null) push(errors, field, "必须是对象或null");
  }
  if (plan.status === "inputs_ready") {
    for (const field of [
      "exactSkuVerification",
      "productAttributes",
      "platformCategory",
      "schemaSnapshot",
      "batteryAssessment",
      "categoryRestrictions",
      "platformCompliance"
    ]) if (plan[field] !== null) push(errors, field, "输入就绪阶段必须保持null");
  }
  if (["facts_checked", "seo_draft_ready"].includes(plan.status)) {
    if (!["c1-fact-verification-v1.1", C1_FACT_VERIFICATION_VERSION].includes(plan.factVerificationVersion)) {
      push(errors, "factVerificationVersion", "必须是已发布的C1事实核验版本");
    }
    if (plan.factVerificationVersion === C1_FACT_VERIFICATION_VERSION &&
        (!isObject(plan.inputSnapshots) || !Object.hasOwn(plan.inputSnapshots, "skuRightsReview") || !isObject(plan.platformCompliance?.skuRightsReview))) {
      push(errors, "platformCompliance.skuRightsReview", "当前C1核验必须显式保存逐SKU权利证据或unknown");
    }
    if (plan.factVerificationVersion === C1_FACT_VERIFICATION_VERSION && isObject(plan.inputSnapshots) && Object.hasOwn(plan.inputSnapshots, "skuRightsReview")) {
      const review = plan.inputSnapshots.skuRightsReview;
      try {
        if (review !== null) {
          assertC1SkuRightsReviewEvidence({ review, plan, sourceIdentity: review?.sourceIdentity, observedAt: plan.factsVerifiedAt });
          const bound = review.sourceIdentity;
          if (bound.candidateId !== plan.frozenInputRefs?.candidateId || bound.skuPackageId !== plan.identity?.skuPackageId ||
              bound.platform !== plan.identity?.targetPlatform || bound.supplierSkuId !== plan.identity?.supplierSkuId ||
              !sameStoreRef(bound.storeRef, plan.inputSnapshots.platformSchemaRules?.storeRef)) {
            throw new C1SkuRightsReviewError("C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH");
          }
        }
        if (!sameJson(plan.platformCompliance?.skuRightsReview, projectC1SkuRightsReviewFacts(review, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`))) {
          throw new C1SkuRightsReviewError("C1_SKU_RIGHTS_REVIEW_PROJECTION_DRIFT");
        }
      } catch (error) {
        if (!(error instanceof C1SkuRightsReviewError)) throw error;
        push(errors, "platformCompliance.skuRightsReview", error.code);
      }
    }
    if (!isoDateTime(plan.factsVerifiedAt)) push(errors, "factsVerifiedAt", "必须是有效时间");
    for (const field of [
      "exactSkuVerification",
      "productAttributes",
      "platformCategory",
      "schemaSnapshot",
      "batteryAssessment",
      "categoryRestrictions",
      "platformCompliance"
    ]) if (!isObject(plan[field])) push(errors, field, "事实核验完成后必须存在");
  }
  for (const field of ["seoTitleDraft", "descriptionDraft", "searchKeywordsDraft", "seoEvidenceLayer"]) {
    if (!isObject(plan[field]) && plan[field] !== null) push(errors, field, "必须是对象或null");
  }
  if (!Array.isArray(plan.bulletPointsDraft) && plan.bulletPointsDraft !== null) {
    push(errors, "bulletPointsDraft", "必须是数组或null");
  }
  if (plan.status !== "seo_draft_ready") {
    for (const field of ["seoTitleDraft", "descriptionDraft", "bulletPointsDraft", "searchKeywordsDraft", "seoEvidenceLayer"]) {
      if (plan[field] !== null) push(errors, field, "SEO草稿生成前必须保持null");
    }
  }
  if (plan.status === "seo_draft_ready") {
    for (const field of ["seoTitleDraft", "descriptionDraft", "searchKeywordsDraft", "seoEvidenceLayer"]) {
      if (!isObject(plan[field])) push(errors, field, "SEO草稿完成后必须存在");
    }
    if (!Array.isArray(plan.bulletPointsDraft)) push(errors, "bulletPointsDraft", "SEO草稿完成后必须存在");
  }
  if (plan.contractVersion === C1_CANONICAL_CONTRACT_VERSION) {
    if (!isObject(plan.revisionRefs) || !Number.isInteger(plan.revisionRefs.sourceRevision) ||
        plan.revisionRefs.sourceRevision < 0 || plan.revisionRefs.resultRevision !== plan.revisionRefs.sourceRevision + 1) {
      push(errors, "revisionRefs", "必须保存C1创建时实际source/result修订");
    }
    const frozen = plan.frozenInputRefs;
    if (!isObject(frozen) || frozen.sourceRevision !== plan.revisionRefs?.sourceRevision ||
        frozen.skuPackageId !== plan.identity?.skuPackageId || frozen.platform !== plan.identity?.targetPlatform ||
        frozen.storeRef !== plan.identity?.targetStore || frozen.salesSnapshotId !== plan.inputRefs?.salesSnapshotId ||
        frozen.selectedSupplySnapshotId !== plan.inputRefs?.selectedSupplySnapshotId ||
        frozen.profitModelVersion !== plan.inputRefs?.profitModelVersion ||
        frozen.schemaSnapshotRef !== plan.inputRefs?.platformSchemaEvidenceId ||
        plan.schemaSnapshotRef !== plan.inputRefs?.platformSchemaEvidenceId || !nonEmptyString(frozen.candidateId) ||
        frozen.ownerSupplyConfirmationRef !== `${plan.inputRefs?.selectedSupplySnapshotId}#ownerSupplyConfirmation`) {
      push(errors, "frozenInputRefs", "必须锁定当前C1的四类证据及主人供应确认");
    }
    if (!Array.isArray(plan.keywordEvidenceRefs) || !Array.isArray(plan.unknownManifest)) {
      push(errors, "canonical", "必须显式保存关键词引用与unknown清单");
    }
    // 槽位合同已废止。主人机器上更早写下的记录里还留着一个 mediaRequirements: null 的空壳，
    // 那里面没有任何槽位主张，照单放行，不逼主人去改自己的业务数据；但任何非 null 的槽位摘要一律拒收。
    if (Object.hasOwn(plan, "mediaRequirements") && plan.mediaRequirements !== null) {
      push(errors, "mediaRequirements", "槽位合同已废止：C1不得再保存平台媒体槽位摘要");
    }
    if (plan.status === "inputs_ready" && plan.draftOnlySeo !== null) {
      push(errors, "canonical", "C1创建时不得冒充provider已完成");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidC1ProductPlan(plan) {
  const result = validateC1ProductPlan(plan);
  if (!result.valid) {
    const canonicalError = result.errors.some(item => ["revisionRefs", "frozenInputRefs", "canonical"].includes(item.path));
    throw new Error(`${canonicalError ? "C1_CANONICAL_GATE_BLOCKED" : "C1ProductPlan校验失败"}：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }
  return plan;
}

/**
 * 第8阶段只把四类已冻结上游输入装入C1，不联网、不算利润、不生成内容或素材。
 */
function buildC1InputPlan({ skuPackage, activeProfitModel, salesSnapshot, confirmedSupplierSkuSnapshot,
  platformSchemaEvidence, createdAt, c1PlanId }) {
  const sourceIdentity = normalizeC1SourceIdentity(skuPackage.g1Identity);
  const [salesSnapshotId, selectedSupplySnapshotId] = activeProfitModel.inputSnapshotRefs;
  const plan = {
    schemaVersion: C1_PRODUCT_PLAN_SCHEMA_VERSION,
    contractVersion: C1_CANONICAL_CONTRACT_VERSION,
    c1PlanId,
    status: "inputs_ready",
    createdAt,
    revisionRefs: { sourceRevision: skuPackage.dataRevision, resultRevision: skuPackage.dataRevision + 1 },
    frozenInputRefs: {
      candidateId: sourceIdentity.candidateId,
      skuPackageId: sourceIdentity.skuPackageId,
      platform: sourceIdentity.platform,
      storeRef: sourceIdentity.storeRef.stableStoreId,
      sourceRevision: skuPackage.dataRevision,
      salesSnapshotId,
      selectedSupplySnapshotId,
      ownerSupplyConfirmationRef: `${selectedSupplySnapshotId}#ownerSupplyConfirmation`,
      profitModelVersion: activeProfitModel.profitModelVersion,
      schemaSnapshotRef: platformSchemaEvidence.evidenceId
    },
    schemaSnapshotRef: platformSchemaEvidence.evidenceId,
    draftOnlySeo: null,
    keywordEvidenceRefs: [],
    unknownManifest: [],
    inputRefs: {
      salesSnapshotId,
      selectedSupplySnapshotId,
      profitModelVersion: activeProfitModel.profitModelVersion,
      platformSchemaEvidenceId: platformSchemaEvidence.evidenceId
    },
    identity: {
      parentOpportunityId: skuPackage.parentOpportunityId,
      skuPackageId: skuPackage.skuPackageId,
      supplierOptionId: skuPackage.supplierOptionId,
      supplierSkuId: skuPackage.supplierSkuId,
      variantKey: skuPackage.variantKey,
      targetPlatform: skuPackage.targetPlatform,
      targetStore: skuPackage.targetStore
    },
    inputSnapshots: {
      salesSnapshot: structuredClone(salesSnapshot),
      confirmedSupplierSkuSnapshot: structuredClone(confirmedSupplierSkuSnapshot),
      profitModel: structuredClone(activeProfitModel),
      platformSchemaRules: structuredClone(platformSchemaEvidence)
    },
    externalAccesses: [],
    profitRecalculated: false,
    skuReplaced: false,
    finalSeo: null,
    finalAttributes: null,
    complianceDecision: null,
    generatedAssets: null,
    productionPayload: null
    ,
    factVerificationVersion: null,
    factsVerifiedAt: null,
    exactSkuVerification: null,
    productAttributes: null,
    platformCategory: null,
    schemaSnapshot: null,
    batteryAssessment: null,
    categoryRestrictions: null,
    platformCompliance: null
    ,
    seoTitleDraft: null,
    descriptionDraft: null,
    bulletPointsDraft: null,
    searchKeywordsDraft: null,
    seoEvidenceLayer: null
  };
  assertValidC1ProductPlan(plan);

  return plan;
}

export function createC1ProductPlan({
  opportunityPackage,
  skuPackage,
  platformSchemaEvidence,
  createdAt
}) {
  if (!validateOpportunityPackage(opportunityPackage).valid) throw new Error("C1_INPUT_GAP: OpportunityPackage校验失败");
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "B") throw new Error("C1_GATE_REJECTED: 当前SKU不在B阶段");
  if (skuPackage.businessResult !== "passed" || skuPackage.technicalStatus !== "completed") {
    throw new Error("C1_GATE_REJECTED: B阶段未通过或未完成");
  }
  if (skuPackage.c1ProductPlan !== null) throw new Error("C1_GATE_REJECTED: C1ProductPlan已经存在");
  if (skuPackage.parentOpportunityId !== opportunityPackage.parentOpportunityId) {
    throw new Error("C1_INPUT_GAP: SKU与OpportunityPackage不属于同一商品方向");
  }
  if (skuPackage.targetPlatform !== opportunityPackage.targetPlatform || skuPackage.targetStore !== opportunityPackage.targetStore) {
    throw new Error("C1_INPUT_GAP: SKU目标平台或店铺与A阶段不一致");
  }
  if (!isoDateTime(createdAt)) throw new Error("C1_INPUT_GAP: 创建时间无效");

  const activeProfitModel = skuPackage.profitModels.find(
    (model) => model.profitModelVersion === skuPackage.activeProfitModelVersion
  );
  if (!activeProfitModel) throw new Error("C1_GATE_REJECTED: 缺少当前B利润模型");
  assertValidProfitModel(activeProfitModel);
  // 正式B只有两种来源：平台实收的精确佣金，和主人已保存的官方费表版本命中的费率——利润计算里两者同级
  // （lib/profit-model.mjs 的 commissionMode，`official_reference` 的 calculationType 就是 "formal"）。
  // `estimated` 照旧拦住：条件测算不得进入文案素材。
  // 进入 C1 不授予生产权限；生产确认还须由 assertProductionProfitPriceCurrent 核对
  // 同 SKU 冻结成本、原价格和当前适用证据，正式佣金模式本身不能代替完整校验。
  if (!FORMAL_B_COMMISSION_MODES.includes(activeProfitModel.commissionMode)) {
    throw new Error("C1_GATE_REJECTED: 正式B必须先取得精确佣金或官方费表费率，估算或历史利润记录不得进入C1");
  }
  if (activeProfitModel.result !== "passed") {
    throw new Error("C1_GATE_REJECTED: 单件利润20元或利润率15%均未通过");
  }

  const [salesSnapshotId, selectedSupplySnapshotId] = activeProfitModel.inputSnapshotRefs;
  const salesSnapshot = opportunityPackage.salesSnapshots.find((item) => item.snapshotId === salesSnapshotId);
  if (!salesSnapshot || !skuPackage.inheritedSalesSnapshotRefs.includes(salesSnapshotId)) {
    throw new Error("C1_INPUT_GAP: 未找到B阶段实际使用且由A继承的销售快照");
  }
  const selectedSupplySnapshot = skuPackage.selectedSupplySnapshot;
  if (selectedSupplySnapshot?.snapshotId !== selectedSupplySnapshotId) {
    throw new Error("C1_INPUT_GAP: 当前供应快照与B利润模型引用不一致");
  }
  if (selectedSupplySnapshot.ownerSupplyConfirmation?.status !== "confirmed") {
    throw new Error("C1_INPUT_GAP: 供应方案未获主人确认");
  }
  const supplierSku = selectedSupplySnapshot.supplierSku;
  if (
    !isObject(supplierSku) ||
    supplierSku.supplierSkuId !== skuPackage.supplierSkuId ||
    supplierSku.variantKey !== skuPackage.variantKey
  ) {
    throw new Error("C1_INPUT_GAP: 已确认供应SKU身份不一致");
  }

  const schemaValidation = validatePlatformSchemaEvidence(platformSchemaEvidence);
  if (!schemaValidation.valid) throw new Error("C1_INPUT_GAP: 平台Schema证据校验失败");
  if (platformSchemaEvidence.platform !== skuPackage.targetPlatform || platformSchemaEvidence.store !== skuPackage.targetStore) {
    throw new Error("C1_INPUT_GAP: 平台Schema不适用于当前平台或店铺");
  }
  const sourceIdentity = normalizeC1SourceIdentity(skuPackage.g1Identity);
  if (platformSchemaEvidence.storeRef !== undefined &&
      !sameStoreRef(platformSchemaEvidence.storeRef, sourceIdentity.storeRef)) {
    throw new Error("C1_SCHEMA_STORE_SCOPE_MISMATCH: 平台Schema必须绑定同一完整店铺身份");
  }

  const plan = buildC1InputPlan({ skuPackage, activeProfitModel, salesSnapshot, platformSchemaEvidence, createdAt,
    c1PlanId: `c1:${skuPackage.skuPackageId}:${skuPackage.activeProfitModelVersion}`,
    confirmedSupplierSkuSnapshot: {
        snapshotId: selectedSupplySnapshot.snapshotId,
        ownerSupplyConfirmation: structuredClone(selectedSupplySnapshot.ownerSupplyConfirmation),
        supplierOptionIdentity: {
          supplierOptionId: selectedSupplySnapshot.supplierOption?.supplierOptionId,
          sourcePlatform: selectedSupplySnapshot.supplierOption?.sourcePlatform,
          productUrl: selectedSupplySnapshot.supplierOption?.productUrl,
          offerId: selectedSupplySnapshot.supplierOption?.offerId,
          evidenceRef: selectedSupplySnapshot.supplierOption?.evidenceRef
        },
        supplierSku: structuredClone(supplierSku)
      },
  });

  const previousProfitModels = structuredClone(skuPackage.profitModels);
  const previousActiveProfitModelVersion = skuPackage.activeProfitModelVersion;
  const next = structuredClone(skuPackage);
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.businessPhase = "C1";
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({
    event: "c1_inputs_created_from_four_frozen_upstream_sources",
    at: createdAt,
    c1PlanId: plan.c1PlanId,
    inputRefs: structuredClone(plan.inputRefs),
    finalSeoGenerated: false,
    assetsGenerated: false,
    productionStarted: false
  });

  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) {
    throw new Error(`C1生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }
  if (!sameJson(previousProfitModels, next.profitModels) || next.activeProfitModelVersion !== previousActiveProfitModelVersion) {
    throw new Error("C1_PROTECTED_DATA_CHANGED: B利润结果被改写");
  }
  if (next.supplierSkuId !== skuPackage.supplierSkuId || next.variantKey !== skuPackage.variantKey) {
    throw new Error("C1_PROTECTED_DATA_CHANGED: 供应SKU被替换");
  }

  return deepFreeze({
    flowVersion: "c1-input-flow-v1.1",
    skuPackage: next,
    c1ProductPlan: next.c1ProductPlan
  });
}

export function assertC1RightsReviewStage(skuPackage) {
  if (skuPackage?.businessPhase !== "C1" || ["c2FinalAssets", "productionConfirmationCard", "productionAuthorization", "dHandoff", "productionRecord", "externalListingRecord", "eVerificationRecord"]
    .some(field => skuPackage[field] !== null && skuPackage[field] !== undefined)) throw new C1SkuRightsReviewError("C1_RIGHTS_REPLACEMENT_NOT_ALLOWED");
}

/** A new C1 review retains B and its frozen inputs; it never simulates a B transition. */
export function replaceC1ProductPlanForRightsReview({ skuPackage, expectedC1PlanId, historyRef, createdAt }) {
  assertValidLifecyclePackage(skuPackage);
  const previous = skuPackage.c1ProductPlan;
  assertValidC1ProductPlan(previous);
  assertC1RightsReviewStage(skuPackage);
  if (previous.c1PlanId !== expectedC1PlanId) throw new C1SkuRightsReviewError("C1_RIGHTS_PLAN_CONFLICT");
  if (!isoDateTime(createdAt) || !isCanonicalFrozenRef(historyRef)) throw new C1SkuRightsReviewError("C1_RIGHTS_INPUT_INVALID");
  const snapshots = previous.inputSnapshots;
  const profit = skuPackage.profitModels.find(model => model.profitModelVersion === skuPackage.activeProfitModelVersion);
  const supply = snapshots.confirmedSupplierSkuSnapshot;
  const source = normalizeC1SourceIdentity(skuPackage.g1Identity);
  // 复核的是当初生成这份C1的同一份冻结利润记录：这里认的模式必须和 createC1ProductPlan 那道闸门一致，
  // 否则官方费表费率进得了C1、却做不了权利复核。
  if (!profit || !sameJson(profit, snapshots.profitModel) || profit.result !== "passed" ||
      !FORMAL_B_COMMISSION_MODES.includes(profit.commissionMode) ||
      profit.inputSnapshotRefs[0] !== previous.inputRefs.salesSnapshotId || profit.inputSnapshotRefs[1] !== previous.inputRefs.selectedSupplySnapshotId ||
      snapshots.salesSnapshot.snapshotId !== previous.inputRefs.salesSnapshotId ||
      !skuPackage.inheritedSalesSnapshotRefs.includes(snapshots.salesSnapshot.snapshotId) ||
      supply.snapshotId !== skuPackage.selectedSupplySnapshot.snapshotId ||
      !sameJson(supply.supplierSku, skuPackage.selectedSupplySnapshot.supplierSku) ||
      !sameJson(supply.ownerSupplyConfirmation, skuPackage.selectedSupplySnapshot.ownerSupplyConfirmation) ||
      supply.supplierSku.supplierSkuId !== source.supplierSkuId || supply.supplierSku.variantKey !== skuPackage.variantKey ||
      supply.ownerSupplyConfirmation.status !== "confirmed" || supply.ownerSupplyConfirmation.supplierSkuId !== source.supplierSkuId ||
      snapshots.platformSchemaRules.evidenceId !== previous.inputRefs.platformSchemaEvidenceId ||
      snapshots.platformSchemaRules.platform !== source.platform || snapshots.platformSchemaRules.store !== skuPackage.targetStore ||
      !sameStoreRef(snapshots.platformSchemaRules.storeRef, source.storeRef)) throw new C1SkuRightsReviewError("C1_RIGHTS_SOURCE_EVIDENCE_INVALID");
  assertValidProfitModel(profit);
  const plan = buildC1InputPlan({ skuPackage, activeProfitModel: profit, salesSnapshot: snapshots.salesSnapshot,
    confirmedSupplierSkuSnapshot: supply, platformSchemaEvidence: snapshots.platformSchemaRules, createdAt,
    c1PlanId: `c1:${skuPackage.skuPackageId}:${skuPackage.activeProfitModelVersion}:review:${skuPackage.dataRevision + 1}` });
  plan.supersedes = { c1PlanId: previous.c1PlanId, historyRef };
  assertValidC1ProductPlan(plan);
  const next = structuredClone(skuPackage);
  delete next.c1RightsReviewRecord;
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "review_compliance_risk";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({ event: "c1_rights_review_plan_replaced", at: createdAt,
    c1PlanId: plan.c1PlanId, supersedes: structuredClone(plan.supersedes),
    sourceRevision: skuPackage.dataRevision, resultRevision: next.dataRevision, externalAccesses: [] });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new C1SkuRightsReviewError("C1_RIGHTS_REPLACEMENT_NOT_ALLOWED");
  return deepFreeze({ skuPackage: next, c1ProductPlan: plan });
}

function sourcedFact(value, sourceRefs, reason = null) {
  const known = value !== undefined && value !== null && value !== "" && value !== "unknown";
  return {
    value: known ? structuredClone(value) : "unknown",
    verificationStatus: known ? "confirmed" : "unknown",
    sourceRefs: [...new Set(sourceRefs.filter(nonEmptyString))],
    reason: known ? null : (reason || "not_present_in_frozen_inputs")
  };
}

/**
 * 主人签过的「中文事实 → Ozon 字典值」映射，投影成**俄文值的已确认事实**。
 *
 * 为什么需要它：Ozon 的关键词和属性格都要俄文，而本品的已确认事实来自 1688，全是中文
 * （2026-09-17 实测：44 条已确认事实里，值是俄文的只有类目路径那一条）。
 * 关键词那条路要求词**逐字等于**某条已确认事实的值
 * （`c1-keyword-planning-evidence-producer.mjs`，bindingRelation 只认 exact_value），
 * 所以没有俄文值的事实，就永远凑不出俄文关键词；发 import 时字典属性也缺 dictionaryValueId。
 *
 * 两端都有真证据才算数：俄文那端是 Ozon 平台自己的字典读数（dictionaryValueId + evidenceRef），
 * 中文那端是冻结供应快照里的属性。中间的对应关系是主人的判断，如实记成他的确认。
 *
 * **漂移一律退回 unknown，绝不继续声称**：
 *  - 冻结事实的值变了（`sourceFactValue` 对不上）——那条映射依据的东西已经不在了；
 *  - schema 版本变了——属性号和字典可能已经不是同一套。
 */

function ozonAttributeFacts(skuPackage, plan, schemaRoot, supplyRoot, schema) {
  const record = skuPackage?.ozonAttributeMappingsV1;
  if (!isObject(record) || !Array.isArray(record.mappings)) return [];
  const schemaCurrent = record.schemaRevision === schema?.schemaRevision;
  const attributeById = new Map((Array.isArray(schema?.attributes) ? schema.attributes : []).map((item) => [item.fieldKey, item]));
  return record.mappings.filter(isObject).map((mapping) => {
    const declared = mapping.sourceFactValue;
    const current = String(mapping.sourceFactPath || "").split(".").reduce((node, key) => node?.[key], plan);
    // 深比较：事实值可能是对象（比如主人签的品牌声明 {value, brandStatus, …}），
    // 用 === 比对象永远不相等，会把好端端的映射全判成漂移。
    const sourceCurrent = isObject(current) && current.verificationStatus === "confirmed" &&
      JSON.stringify(current.value) === JSON.stringify(declared);
    const known = schemaCurrent && sourceCurrent && attributeById.has(String(mapping.attributeId));
    const refs = [...(mapping.dictionaryEvidenceRefs ?? []), mapping.dictionaryEvidenceRef, factPath(schemaRoot, `attributes/${mapping.attributeId}`),
      factPath(supplyRoot, "supplierSku/attributes"), mapping.confirmationRef ?? record.confirmationRef];
    return {
      fieldKey: String(mapping.attributeId),
      label: attributeById.get(String(mapping.attributeId))?.label ?? mapping.attributeLabel ?? null,
      dictionaryValueId: known ? (mapping.dictionaryValueId ?? null) : null,
      sourceFactPath: mapping.sourceFactPath,
      // **字典属性的事实值必须是对象** `{ value, dictionaryValueId }`：
      // 真发 import 时 `ozon-seller-api-production-adapter.mjs` 的 boundFactAttribute 对有字典的属性
      // 要取 raw.dictionaryValueId，拿到字符串就直接报 OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED。
      // 主人签的品牌声明本来就是这个形状（Бренд = {value:"Нет бренда", …}），这里对齐它。
      // 无字典的自由文本属性保持纯字符串。
      fact: known
        ? sourcedFact(Array.isArray(mapping.dictionaryValues) ? mapping.dictionaryValues : mapping.dictionaryValueId === null || mapping.dictionaryValueId === undefined
          ? mapping.value
          : { value: mapping.value, dictionaryValueId: mapping.dictionaryValueId }, refs)
        : sourcedFact(null, refs, schemaCurrent
          ? (sourceCurrent ? "ozon_attribute_not_in_current_schema" : "source_fact_drifted_since_mapping")
          : "schema_revision_changed_since_mapping")
    };
  });
}

function projectOzonAttributeMappings(skuPackage, plan, schemaRoot, supplyRoot, schema) {
  // 必须等**全部**事实段都赋值完再投影。映射的 sourceFactPath 可以指向计划里任何一块事实，
  // 早一步跑就会解析到赋值前的旧值，把好端端的映射判成漂移。
  // 2026-09-17 真数据实测：绑到 platformCategory.categoryPath 的两条正是这样被静默判掉的，
  // 合成夹具只绑 productAttributes，照不出这一条。也必须赶在 collectC1UnknownManifest 之前，
  // 否则清单看到的是空的那一份。
  plan.productAttributes.ozonAttributes = ozonAttributeFacts(skuPackage, plan, schemaRoot, supplyRoot, schema);

  // 主人签下的 Ozon 属性映射，就是「这个必填属性该填什么」的答案。
  //
  // 2026-09-18 真踩到：映射已经签好（8229 Тип = Одежда для животных，字典号 96063），
  // 可 requiredPlatformFields 仍然是 unknown、照旧阻断 C2——因为那一段只从 1688 供应属性里
  // 按 sourceAttributeKeys 找依据，**完全看不见 ozonAttributes 这一段**。
  // 加新段时没把这条线接上，等于让主人签了个不算数的字。
  //
  // 只补 unknown 的格子：供应属性本来就能确认的，保持原样，不拿映射去盖掉它。
  const mappedByFieldKey = new Map(plan.productAttributes.ozonAttributes
    .filter((item) => item.fact.verificationStatus === "confirmed")
    .map((item) => [String(item.fieldKey), item]));
  if (mappedByFieldKey.size > 0) {
    for (const field of plan.productAttributes.requiredPlatformFields) {
      const keys = [field.fieldKey, ...(Array.isArray(field.sourceAttributeKeys) ? field.sourceAttributeKeys : [])];
      const mapped = keys.map((key) => mappedByFieldKey.get(String(key))).find(Boolean);
      if (!mapped) continue;
      if (field.fact.verificationStatus === "unknown") {
        field.fact = structuredClone(mapped.fact);
        field.ozonDictionaryValueId = mapped.dictionaryValueId ?? null;
        field.resolvedFromOwnerAttributeMapping = true;
        continue;
      }
      // 已确认、但缺字典号的格子（主人签的品牌声明就是这样：值对、dictionaryValueId 是 null）。
      // 真发 import 时字典属性必须有正整数字典号，否则直接报 OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED。
      // **只在取值逐字相同的时候补号**：声明说的是什么就还是什么，这里只是把平台给这个值的编号填上，
      // 不替主人改任何一个字。
      const existing = field.fact.value;
      const existingText = isObject(existing) ? existing.value : existing;
      const needsId = isObject(existing) && !(Number.isInteger(existing.dictionaryValueId) && existing.dictionaryValueId > 0);
      if (!needsId || !Number.isInteger(mapped.dictionaryValueId) || mapped.dictionaryValueId <= 0) continue;
      const mappedText = isObject(mapped.fact.value) ? mapped.fact.value.value : mapped.fact.value;
      if (existingText !== mappedText) continue;
      field.fact = { ...structuredClone(field.fact),
        value: { ...structuredClone(existing), dictionaryValueId: mapped.dictionaryValueId } };
      field.ozonDictionaryValueId = mapped.dictionaryValueId;
      field.dictionaryValueIdResolvedFromOwnerAttributeMapping = true;
    }
    const stillUnknown = plan.productAttributes.requiredPlatformFields
      .filter((item) => item.fact.verificationStatus === "unknown").length;
    plan.productAttributes.status = sourcedFact(
      stillUnknown === 0 ? "all_required_fields_known" : "required_fields_incomplete",
      [factPath(schemaRoot, "requiredFields"), factPath(supplyRoot, "supplierSku/attributes")]
    );
    plan.platformCompliance.requiredFieldGapCount = sourcedFact(stillUnknown, [
      factPath(schemaRoot, "requiredFields"),
      factPath(supplyRoot, "supplierSku/attributes")
    ]);
  }

  if (plan.contractVersion === C1_CANONICAL_CONTRACT_VERSION) {
    // 槽位合同已整体废止（主人 2026-09-15 批准）：真实 import 只写 primary_image = urls[0] 和
    // images = urls.slice(1)（lib/ozon-seller-api-production-adapter.mjs），从不读槽位；而槽位所依赖的
    // schema.mediaRequirements 全仓库无人赋值、Ozon 证据服务也不返回。C1 不再产出任何媒体摘要，
    // 哪些图上架由主人在 C2 逐张确认，顺序即主人给的顺序，第一张就是主图。
    plan.unknownManifest = collectC1UnknownManifest(plan);
    if (!sameStoreRef(schema.storeRef, skuPackage.g1Identity.storeRef)) {
      plan.unknownManifest.push({ fieldPath: "schemaSnapshot.storeRef", reason: "full_store_scope_not_confirmed",
        sourceRefs: [schema.evidenceId], blockingScope: "required_field", blocksC2Handoff: true });
    }
  }

}

/** Apply a saved dictionary result to a prepared C1 revision without reopening
 * frozen inputs or rerunning fact verification. The application use case owns
 * receipt scope, owner authorization and final-plan lineage checks. */
export function applyPreparedC1OzonAttributeMapping({ skuPackage, mapping, confirmationRef, confirmedBy, mappedAt }) {
  assertValidLifecyclePackage(skuPackage);
  const current = skuPackage.c1ProductPlan;
  assertValidC1ProductPlan(current);
  if (skuPackage.businessPhase !== "C1" || current.status !== "facts_checked" || !current.supersedes ||
      !current.sourceFactsRevision || skuPackage.productionAuthorization || skuPackage.productionRecord ||
      skuPackage.productionConfirmationCard || skuPackage.c2FinalAssets || current.draftOnlySeo !== null ||
      current.seoEvidenceLayer !== null) throw new Error("C1_PREPARED_MAPPING_PHASE_REJECTED");
  if (!isObject(mapping) || !nonEmptyString(mapping.attributeId) || !nonEmptyString(mapping.value) ||
      !/^productAttributes\.supplierAttributes\.\d+\.fact$/.test(mapping.sourceFactPath) ||
      !Number.isSafeInteger(mapping.dictionaryValueId) || mapping.dictionaryValueId <= 0 ||
      !isCanonicalFrozenRef(mapping.dictionaryEvidenceRef) || !isCanonicalFrozenRef(confirmationRef) ||
      !nonEmptyString(confirmedBy) || !isoDateTime(mappedAt) || Date.parse(mappedAt) < Date.parse(current.factsVerifiedAt)) {
    throw new Error("C1_PREPARED_MAPPING_INPUT_INVALID");
  }
  const schema = current.inputSnapshots.platformSchemaRules;
  if (!Array.isArray(schema.attributes)) throw new Error("C1_PREPARED_MAPPING_SCHEMA_ATTRIBUTES_MISSING");
  const attributes = schema.attributes.filter(item => String(item.fieldKey) === mapping.attributeId);
  const fact = mapping.sourceFactPath.split(".").reduce((node, key) => node?.[key], current);
  if (attributes.length !== 1 || !(attributes[0].dictionaryId > 0) ||
      !isObject(fact) || fact.verificationStatus !== "confirmed" || !sameJson(fact.value, mapping.sourceFactValue)) {
    throw new Error("C1_PREPARED_MAPPING_SOURCE_MISMATCH");
  }
  const previous = skuPackage.ozonAttributeMappingsV1;
  if (previous && (previous.schemaRevision !== schema.schemaRevision || !Array.isArray(previous.mappings) ||
      new Set(previous.mappings.map(item => item.attributeId)).size !== previous.mappings.length)) {
    throw new Error("C1_PREPARED_MAPPING_PREVIOUS_RECORD_INVALID");
  }
  const next = structuredClone(skuPackage), plan = next.c1ProductPlan;
  const replacement = { attributeId: mapping.attributeId, attributeLabel: attributes[0].label ?? null,
    dictionaryId: attributes[0].dictionaryId, value: mapping.value, dictionaryValueId: mapping.dictionaryValueId,
    sourceFactPath: mapping.sourceFactPath, sourceFactValue: structuredClone(fact.value),
    dictionaryEvidenceRef: mapping.dictionaryEvidenceRef, confirmationRef };
  const mappings = (previous?.mappings ?? []).map(item => ({ ...structuredClone(item),
    confirmationRef: item.confirmationRef ?? previous.confirmationRef }));
  const index = mappings.findIndex(item => item.attributeId === mapping.attributeId);
  if (index < 0) mappings.push(replacement); else mappings[index] = replacement;
  next.ozonAttributeMappingsV1 = { schemaVersion: "c1-ozon-attribute-mapping-v1", schemaRevision: schema.schemaRevision,
    confirmationRef, confirmedBy, confirmedAt: mappedAt, mappings };
  // A required field previously filled by a mapping must follow its replacement,
  // while independently confirmed supplier values are never overwritten.
  for (const field of plan.productAttributes.requiredPlatformFields) {
    if (String(field.fieldKey) === mapping.attributeId && field.resolvedFromOwnerAttributeMapping === true) {
      field.fact = sourcedFact("unknown", field.fact.sourceRefs, "owner_attribute_mapping_replaced");
      delete field.ozonDictionaryValueId;
    }
  }
  projectOzonAttributeMappings(next, plan, plan.inputRefs.platformSchemaEvidenceId,
    plan.inputRefs.selectedSupplySnapshotId, schema);
  const validation = validateC1FactVerification(plan);
  if (!validation.valid) throw new Error("C1_PREPARED_MAPPING_FACTS_INVALID");
  assertValidC1ProductPlan(plan);
  next.dataRevision += 1;
  next.audit.updatedAt = mappedAt;
  next.audit.history.push({ event: "c1_prepared_revision_dictionary_mapping_applied", at: mappedAt,
    attributeId: mapping.attributeId, dictionaryEvidenceRef: mapping.dictionaryEvidenceRef,
    confirmationRef, externalCalls: 0, productionAuthorized: false });
  assertValidLifecyclePackage(next);
  return deepFreeze({ skuPackage: next });
}

function factPath(root, path) {
  return `${root}#/${path}`;
}

function validateSourcedFact(fact, path, errors) {
  if (!isObject(fact)) {
    push(errors, path, "必须是带来源的事实对象");
    return;
  }
  if (!["confirmed", "unknown"].includes(fact.verificationStatus)) push(errors, `${path}.verificationStatus`, "状态无效");
  if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0 || fact.sourceRefs.some((ref) => !nonEmptyString(ref))) {
    push(errors, `${path}.sourceRefs`, "每个事实必须至少有一个来源路径");
  }
  if (fact.verificationStatus === "unknown" && fact.value !== "unknown") push(errors, `${path}.value`, "无法确认时必须为unknown");
  if (fact.verificationStatus === "confirmed" && (fact.value === "unknown" || fact.value === null || fact.value === undefined)) {
    push(errors, `${path}.value`, "已确认事实必须有直接值");
  }
}

function validateFactCollection(value, path, errors) {
  if (isObject(value) && "verificationStatus" in value && "sourceRefs" in value) {
    validateSourcedFact(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateFactCollection(item, `${path}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["verificationVersion", "verifiedAt", "sourceRefs", "reason"].includes(key)) continue;
      validateFactCollection(child, `${path}.${key}`, errors);
    }
  }
}

export function validateC1FactVerification(plan) {
  const errors = [];
  const base = validateC1ProductPlan(plan);
  errors.push(...base.errors);
  if (!isObject(plan) || plan.status !== "facts_checked") return { valid: false, errors };
  for (const field of [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ]) validateFactCollection(plan[field], field, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * 第9A阶段：只读取C1已冻结的四类输入，为每个事实保存值、状态和具体来源路径。
 */
export const C1_UNKNOWN_CLASSIFICATION_VERSION = 'c1-schema-aware-unknown-v1';

/** Classification is derived from frozen schema and SKU facts, never from a client-provided exemption. */
export function collectC1UnknownManifest(plan) {
  const schema = plan.inputSnapshots?.platformSchemaRules;
  const schemaKnown = validatePlatformSchemaEvidence(schema).valid;
  const requiredKeys = new Set(schemaKnown ? schema.requiredFields.flatMap(field =>
    [field.fieldKey, ...(field.sourceAttributeKeys ?? [])]) : []);
  const necessarySupplierKeys = new Set(['weight','weightKg','dimensions','dimensionsCm','packedWeight','packaging',
    'powerProfile','powered','containsBattery','batteryIncluded','batteryType','batteryCount','batteryCapacity',
    'minimumOrderQuantity','unitProductPrice','unitDomesticFreight','otherPurchaseCosts','actualPurchaseCost',
    'purchaseCostComponents','quantityOneEvidence']);
  const rawPower = plan.inputSnapshots?.confirmedSupplierSkuSnapshot?.supplierSku?.powerProfile;
  const noBattery = isObject(rawPower) && (rawPower.containsBattery ?? rawPower.batteryIncluded) === false &&
    rawPower.containsBattery !== true && rawPower.batteryIncluded !== true &&
    plan.batteryAssessment?.containsBattery?.verificationStatus === 'confirmed' &&
    plan.batteryAssessment.containsBattery.value === false &&
    plan.batteryAssessment?.assessment?.verificationStatus === 'confirmed' &&
    plan.batteryAssessment.assessment.value === 'no_battery';
  const result = [];
  const visit = (value, path, attributeKey = null) => {
    if (isObject(value) && value.verificationStatus === "unknown") {
      let blockingScope = "required_field";
      if (schemaKnown && ((path === 'productAttributes.material' && !requiredKeys.has('material')) ||
          (/^productAttributes\.supplierAttributes\[/.test(path) && attributeKey !== null && !requiredKeys.has(attributeKey) && !necessarySupplierKeys.has(attributeKey))))
        blockingScope = 'informational';
      // 主人还没映射、或映射已漂移的 **非必填** Ozon 属性：资料不全而已，不该挡住进 C2。
      // 必填的那几个照旧阻断——它们缺了商品根本发不出去。
      if (/^productAttributes\.ozonAttributes\[/.test(path) && attributeKey !== null && !requiredKeys.has(attributeKey))
        blockingScope = 'informational';
      if (/^productAttributes\.requiredPlatformFields\[/.test(path) ||
          /^platformCategory\.(descriptionCategoryId|typeId)$/.test(path) ||
          /^schemaSnapshot\.(schemaRevision|writeBindings)$/.test(path)) blockingScope = "required_field";
      // 主人 2026-09-15 的决定：合规这一档不再拦人。
      // categoryRestrictions / platformCompliance 只可能来自冻结 Schema 的同名字段，而全仓库没有任何一处
      // 给它们赋过值（唯一路径是 lib/lifecycle-b-input-bundle.mjs 的 C1_SCHEMA_CONTENT_FIELDS 透传，
      // Ozon 证据服务不返回），按现有证据永远不可能确认；batteryAssessment 读的 supplierSku.powerProfile
      // 在现行 lib/real-a-b-c1-flow.mjs 里恒为 "unknown"。
      // 没有一起松动的：主人自己签的权利/品牌声明（platformCompliance.skuRightsReview）照旧阻断，
      // 而且另有 assertCurrentC1SkuRightsReview 一道独立闸门；利润由 B 的 result 把关。
      if (/^(batteryAssessment|categoryRestrictions)\./.test(path) ||
          /^platformCompliance\.(status|assessment)$/.test(path)) blockingScope = "informational";
      // 同理：categoryId / categoryName 冻结 Schema 从不携带，真实 import 只写
      // description_category_id + type_id（见 lib/ozon-seller-api-production-adapter.mjs），两者仍然阻断。
      if (/^platformCategory\.(categoryId|categoryName)$/.test(path)) blockingScope = "informational";
      const batteryDetail = path.match(/^batteryAssessment\.(batteryType|batteryCount|batteryCapacity)$/);
      if (schemaKnown && noBattery && batteryDetail && !requiredKeys.has(batteryDetail[1])) blockingScope = 'informational';
      result.push({ fieldPath: path, reason: value.reason, sourceRefs: [...new Set(value.sourceRefs)],
        blockingScope, blocksC2Handoff: blockingScope !== "informational" });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`, attributeKey));
    else if (isObject(value)) for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, nonEmptyString(value.fieldKey) ? value.fieldKey : attributeKey);
  };
  for (const field of ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot",
    "batteryAssessment", "categoryRestrictions", "platformCompliance"]) visit(plan[field], field);
  return result;
}

/**
 * Ozon 必填属性「Бренд」的属性号。冻结 Schema 的 requiredFields 用平台属性号当 fieldKey
 * （主人两件真实商品上就是 "85"），历史夹具用的是 "brand"，两种都认。
 */
const OZON_BRAND_ATTRIBUTE_KEYS = Object.freeze(["85", "brand"]);
/** 平台自己的“无品牌”标记；lib/c1-sku-rights-review.mjs 的品牌冲突检查已经在用同一个字符串。 */
const OZON_NO_BRAND_VALUE = "Нет бренда";

function isBrandRequiredField(field) {
  const keys = [field?.fieldKey, ...(Array.isArray(field?.sourceAttributeKeys) ? field.sourceAttributeKeys : [])];
  return keys.some((key) => OZON_BRAND_ATTRIBUTE_KEYS.includes(key));
}

/**
 * 主人已经在权利声明里签过品牌，不该再让他在必填属性里输一次同一个事实。
 * 这里只搬运那份已签的声明，不发明任何东西：字典属性要的 dictionaryValueId 冻结 Schema 读不出来，
 * 就如实留成 null——真发 import 时 lib/ozon-seller-api-production-adapter.mjs 会因此明确报
 * OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED，而不是写一个编出来的字典号上去。
 */
function declaredBrandPlatformFact(skuRightsReview, targetPlatform) {
  if (targetPlatform !== "ozon" || !isObject(skuRightsReview) || !isObject(skuRightsReview.brand)) return null;
  const { status, name, evidenceRefs } = skuRightsReview.brand;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) return null;
  let text = null;
  if (status === "unbranded") text = OZON_NO_BRAND_VALUE;
  else if (status === "branded" && nonEmptyString(name)) text = name;
  if (text === null) return null;
  return sourcedFact({ value: text, brandStatus: status, dictionaryValueId: null }, evidenceRefs);
}

export function verifyC1ProductFacts({ skuPackage, skuRightsReview = null, verifiedAt }) {
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "C1" || skuPackage.c1ProductPlan?.status !== "inputs_ready") {
    throw new Error("C1_FACT_GATE_REJECTED: 当前SKU不是待事实核验的C1输入包");
  }
  if (!isoDateTime(verifiedAt)) throw new Error("C1_FACT_INPUT_GAP: 核验时间无效");

  const plan = structuredClone(skuPackage.c1ProductPlan);
  assertValidC1ProductPlan(plan);
  const sales = plan.inputSnapshots.salesSnapshot;
  const supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  const revisedFacts = resolveC1SupplierFactRevision({ plan, sourceIdentity: skuPackage.g1Identity });
  const supplierSku = revisedFacts.supplierSku;
  const supplierOption = supply.supplierOptionIdentity;
  const profit = plan.inputSnapshots.profitModel;
  const schema = plan.inputSnapshots.platformSchemaRules;
  assertValidProfitModel(profit);
  const supplyRoot = plan.inputRefs.selectedSupplySnapshotId;
  const salesRoot = plan.inputRefs.salesSnapshotId;
  const schemaRoot = plan.inputRefs.platformSchemaEvidenceId;
  const profitRoot = plan.inputRefs.profitModelVersion;
  if (Object.hasOwn(plan.inputSnapshots, "skuRightsReview")) throw new Error("C1_SKU_RIGHTS_REVIEW_ALREADY_FROZEN");
  if (Object.hasOwn(skuPackage, "c1RightsReviewRecord")) {
    assertC1SkuRightsReviewRecord({ record: skuPackage.c1RightsReviewRecord, plan, sourceIdentity: normalizeC1SourceIdentity(skuPackage.g1Identity) });
    if (!sameJson(skuPackage.c1RightsReviewRecord.review, skuRightsReview)) throw new C1SkuRightsReviewError("C1_RIGHTS_RECORD_DECLARATION_MISMATCH");
  }
  if (skuRightsReview !== null) assertC1SkuRightsReviewEvidence({ review: skuRightsReview, plan,
    sourceIdentity: normalizeC1SourceIdentity(skuPackage.g1Identity), observedAt: verifiedAt });
  plan.inputSnapshots.skuRightsReview = structuredClone(skuRightsReview);

  if (
    supplierSku.supplierSkuId !== plan.identity.supplierSkuId ||
    supplierSku.variantKey !== plan.identity.variantKey ||
    supply.ownerSupplyConfirmation?.supplierSkuId !== plan.identity.supplierSkuId ||
    supply.ownerSupplyConfirmation?.status !== "confirmed"
  ) throw new Error("C1_FACT_INPUT_GAP: 冻结供应SKU身份不一致");
  if (profit.profitModelVersion !== plan.inputRefs.profitModelVersion || profit.result !== "passed") {
    throw new Error("C1_FACT_INPUT_GAP: 冻结B利润结果不是当前通过版本");
  }

  const supplierAttributes = Object.entries(isObject(supplierSku.attributes) ? supplierSku.attributes : {})
    .filter(([key, value]) => nonEmptyString(key) && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ({
      fieldKey: key,
      fact: sourcedFact(value, [revisedFacts.attributeSources[key] ?? factPath(supplyRoot, "supplierSku/attributes")])
    }));
  const attributeMap = new Map(supplierAttributes.map((item) => [item.fieldKey, item.fact]));
  const declaredBrand = declaredBrandPlatformFact(skuRightsReview, plan.identity.targetPlatform);
  const requiredPlatformFields = schema.requiredFields.map((field) => {
    const matchedKey = Array.isArray(field.sourceAttributeKeys)
      ? field.sourceAttributeKeys.find((key) => attributeMap.has(key))
      : null;
    if (!matchedKey && declaredBrand !== null && isBrandRequiredField(field)) {
      return { fieldKey: field.fieldKey, label: field.label, fact: structuredClone(declaredBrand) };
    }
    return {
      fieldKey: field.fieldKey,
      label: field.label,
      fact: matchedKey
        ? structuredClone(attributeMap.get(matchedKey))
        : sourcedFact("unknown", [
          factPath(schemaRoot, "requiredFields"),
          factPath(supplyRoot, "supplierSku/attributes")
        ], "required_platform_field_not_present_in_frozen_supplier_attributes")
    };
  });
  const requiredUnknownCount = requiredPlatformFields.filter((item) => item.fact.verificationStatus === "unknown").length;

  const powerProfile = isObject(supplierSku.powerProfile) ? supplierSku.powerProfile : {};
  const powerFactRef = path => revisedFacts.powerSourceRef ?? factPath(supplyRoot, path);
  const powered = sourcedFact(powerProfile.powered, [factPath(supplyRoot, "supplierSku/powerProfile/powered")]);
  const containsBattery = sourcedFact(
    powerProfile.containsBattery ?? powerProfile.batteryIncluded,
    [powerFactRef("supplierSku/powerProfile/containsBattery")]
  );
  const batteryType = sourcedFact(powerProfile.batteryType, [powerFactRef("supplierSku/powerProfile/batteryType")]);
  const batteryCount = sourcedFact(powerProfile.batteryCount, [factPath(supplyRoot, "supplierSku/powerProfile/batteryCount")]);
  const batteryCapacity = sourcedFact(powerProfile.batteryCapacity, [factPath(supplyRoot, "supplierSku/powerProfile/batteryCapacity")]);
  const directBatteryKnown = containsBattery.verificationStatus === "confirmed";
  const batteryAssessmentValue = directBatteryKnown
    ? (containsBattery.value === false ? "no_battery" : "battery_present")
    : "unknown";

  plan.status = "facts_checked";
  plan.factVerificationVersion = C1_FACT_VERIFICATION_VERSION;
  plan.factsVerifiedAt = verifiedAt;
  plan.exactSkuVerification = {
    status: sourcedFact("verified", [supplyRoot]),
    verifiedAt,
    sourceRefs: [supplyRoot],
    supplierOptionId: sourcedFact(plan.identity.supplierOptionId, [factPath(supplyRoot, "ownerSupplyConfirmation/supplierOptionId")]),
    supplierSkuId: sourcedFact(plan.identity.supplierSkuId, [factPath(supplyRoot, "supplierSku/supplierSkuId")]),
    variantKey: sourcedFact(plan.identity.variantKey, [factPath(supplyRoot, "supplierSku/variantKey")]),
    sourcePlatform: sourcedFact(supplierOption?.sourcePlatform, [factPath(supplyRoot, "supplierOptionIdentity/sourcePlatform")]),
    offerId: sourcedFact(supplierOption?.offerId, [factPath(supplyRoot, "supplierOptionIdentity/offerId")]),
    productUrl: sourcedFact(supplierOption?.productUrl, [factPath(supplyRoot, "supplierOptionIdentity/productUrl")])
  };
  plan.productAttributes = {
    status: sourcedFact(
      requiredUnknownCount === 0 ? "all_required_fields_known" : "required_fields_incomplete",
      [factPath(schemaRoot, "requiredFields"), factPath(supplyRoot, "supplierSku/attributes")]
    ),
    supplierAttributes,
    ...(revisedFacts.ownerFacts === undefined ? {} : { ownerDeclaredFacts: structuredClone(revisedFacts.ownerFacts) }),
    material: sourcedFact(supplierSku.material, [factPath(supplyRoot, "supplierSku/material")]),
    weight: sourcedFact(supplierSku.weight, [factPath(supplyRoot, "supplierSku/weight")]),
    dimensions: sourcedFact(supplierSku.dimensions, [factPath(supplyRoot, "supplierSku/dimensions")]),
    requiredPlatformFields
  };
  plan.platformCategory = {
    status: sourcedFact(
      [schema.descriptionCategoryId, schema.typeId].every(value => nonEmptyString(value) && value !== "unknown") ? "identified" : "incomplete",
      [factPath(schemaRoot, "descriptionCategoryId"), factPath(schemaRoot, "typeId")]
    ),
    platform: sourcedFact(plan.identity.targetPlatform, [factPath(schemaRoot, "platform")]),
    store: sourcedFact(plan.identity.targetStore, [factPath(schemaRoot, "store")]),
    categoryPath: sourcedFact(sales.categoryPath, [factPath(salesRoot, "categoryPath")]),
    categoryId: sourcedFact(schema.categoryId, [factPath(schemaRoot, "categoryId")], "category_id_not_present_in_frozen_schema"),
    categoryName: sourcedFact(schema.categoryName, [factPath(schemaRoot, "categoryName")]),
    descriptionCategoryId: sourcedFact(schema.descriptionCategoryId, [factPath(schemaRoot, "descriptionCategoryId")]),
    typeId: sourcedFact(schema.typeId, [factPath(schemaRoot, "typeId")])
  };
  plan.schemaSnapshot = {
    status: sourcedFact("frozen", [schemaRoot]),
    evidenceId: sourcedFact(schema.evidenceId, [factPath(schemaRoot, "evidenceId")]),
    schemaRevision: sourcedFact(schema.schemaRevision, [factPath(schemaRoot, "schemaRevision")]),
    requiredFields: sourcedFact(schema.requiredFields, [factPath(schemaRoot, "requiredFields")]),
    writeBindings: sourcedFact(derivePlatformWriteBindings(schema), [factPath(schemaRoot, "writeBindings"), factPath(schemaRoot, "attributes")], "schema_write_bindings_not_present_in_frozen_schema"),
    collectedAt: sourcedFact(schema.collectedAt, [factPath(schemaRoot, "collectedAt")])
  };
  plan.batteryAssessment = {
    status: sourcedFact(
      batteryAssessmentValue === "unknown" ? "unknown" : "fact_available",
      [powerFactRef("supplierSku/powerProfile")]
    ),
    assessment: sourcedFact(batteryAssessmentValue, [
      powerFactRef("supplierSku/powerProfile/containsBattery"),
      powerFactRef("supplierSku/powerProfile/batteryIncluded")
    ], "battery_presence_not_present_in_frozen_inputs"),
    powered,
    containsBattery,
    batteryType,
    batteryCount,
    batteryCapacity
  };
  plan.categoryRestrictions = {
    status: sourcedFact(
      schema.categoryRestrictions === undefined || schema.categoryRestrictions === "unknown" ? "unknown" : "known",
      [factPath(schemaRoot, "categoryRestrictions")]
    ),
    restrictions: sourcedFact(schema.categoryRestrictions, [factPath(schemaRoot, "categoryRestrictions")], "category_restrictions_not_present_in_frozen_schema")
  };
  plan.platformCompliance = {
    status: sourcedFact(
      schema.platformCompliance === undefined || schema.platformCompliance === "unknown" ? "unknown" : "known",
      [factPath(schemaRoot, "platformCompliance"), factPath(profitRoot, "result")]
    ),
    assessment: sourcedFact(schema.platformCompliance, [factPath(schemaRoot, "platformCompliance")], "platform_compliance_not_present_in_frozen_schema"),
    profitGate: sourcedFact(profit.result, [factPath(profitRoot, "result")]),
    skuRightsReview: projectC1SkuRightsReviewFacts(skuRightsReview, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`),
    requiredFieldGapCount: sourcedFact(requiredUnknownCount, [
      factPath(schemaRoot, "requiredFields"),
      factPath(supplyRoot, "supplierSku/attributes")
    ])
  };

  projectOzonAttributeMappings(skuPackage, plan, schemaRoot, supplyRoot, schema);

  const factsValidation = validateC1FactVerification(plan);
  if (!factsValidation.valid) {
    throw new Error(`C1事实核验校验失败：${factsValidation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }

  const profitModelsBefore = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.technicalStatus = "completed";
  next.audit.updatedAt = verifiedAt;
  next.audit.history.push({
    event: "c1_facts_checked_from_frozen_inputs_only",
    at: verifiedAt,
    factVerificationVersion: C1_FACT_VERIFICATION_VERSION,
    externalAccesses: [],
    seoGenerated: false,
    assetsGenerated: false,
    productionStarted: false
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C1事实核验生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(profitModelsBefore, next.profitModels) || next.activeProfitModelVersion !== skuPackage.activeProfitModelVersion) {
    throw new Error("C1_FACT_PROTECTED_DATA_CHANGED: B利润结果被改写");
  }
  if (next.supplierSkuId !== skuPackage.supplierSkuId || next.variantKey !== skuPackage.variantKey) {
    throw new Error("C1_FACT_PROTECTED_DATA_CHANGED: 供应SKU被替换");
  }
  return deepFreeze({
    flowVersion: "c1-fact-verification-flow-v1.1",
    skuPackage: next,
    c1ProductPlan: next.c1ProductPlan
  });
}

/** Demote ambiguous offer-level attributes in an already checked SKU. Source
 * snapshots and owner mappings remain immutable evidence; this review cannot
 * promote facts or supply a replacement value. */
export function applyC1SkuAttributeScopeReview({ skuPackage, scopeReview, reviewedAt }) {
  assertValidLifecyclePackage(skuPackage);
  const current = skuPackage.c1ProductPlan;
  assertValidC1ProductPlan(current);
  if (skuPackage.businessPhase !== "C1" || current.status !== "facts_checked") {
    throw new Error("C1_ATTRIBUTE_SCOPE_PHASE_REJECTED");
  }
  if (!isObject(scopeReview) || scopeReview.schemaVersion !== "c1-sku-attribute-scope-review-v1" ||
      !sameJson(Object.keys(scopeReview).sort(), ["attributes", "evidenceRef", "schemaVersion"]) ||
      !isCanonicalFrozenRef(scopeReview.evidenceRef) || !isoDateTime(reviewedAt) ||
      !Array.isArray(scopeReview.attributes) ||
      new Set(scopeReview.attributes.map(item => item?.fieldKey)).size !== scopeReview.attributes.length) {
    throw new Error("C1_ATTRIBUTE_SCOPE_REVIEW_INVALID");
  }
  const plan = structuredClone(current);
  const mappings = skuPackage.ozonAttributeMappingsV1?.mappings ?? [];
  const restrictedSourcePaths = new Set();
  const restrictedKeys = new Set();
  const unknown = fact => sourcedFact("unknown", [...new Set([...fact.sourceRefs, scopeReview.evidenceRef])], "sku_attribute_scope_unresolved");
  for (const item of scopeReview.attributes) {
    if (!isObject(item) || !sameJson(Object.keys(item).sort(), ["fieldKey", "sourceFactPath"]) ||
        !nonEmptyString(item.fieldKey) || !/^productAttributes\.supplierAttributes\.\d+\.fact$/.test(item.sourceFactPath)) {
      throw new Error("C1_ATTRIBUTE_SCOPE_REVIEW_INVALID");
    }
    const mapping = mappings.find(mapping => String(mapping.attributeId) === item.fieldKey);
    const sourceIndex = Number(item.sourceFactPath.split(".")[2]);
    const source = plan.productAttributes.supplierAttributes[sourceIndex];
    if (!mapping || mapping.sourceFactPath !== item.sourceFactPath || !source?.fact ||
        !plan.productAttributes.ozonAttributes.some(attribute => attribute.fieldKey === item.fieldKey)) {
      throw new Error("C1_ATTRIBUTE_SCOPE_SOURCE_MISMATCH");
    }
    restrictedKeys.add(item.fieldKey);
    // A new, independently verified SKU fact may have replaced the offer-level
    // list. Reject the stale platform mapping without erasing that new fact.
    if (sameJson(source.fact.value, mapping.sourceFactValue)) {
      restrictedSourcePaths.add(item.sourceFactPath);
      restrictedKeys.add(source.fieldKey);
      source.fact = unknown(source.fact);
    }
  }
  if (restrictedKeys.size === 0) return deepFreeze({ skuPackage: structuredClone(skuPackage), changed: false });
  for (const attribute of plan.productAttributes.ozonAttributes) {
    if (!restrictedKeys.has(attribute.fieldKey) && !restrictedSourcePaths.has(attribute.sourceFactPath)) continue;
    restrictedKeys.add(attribute.fieldKey);
    attribute.fact = unknown(attribute.fact);
    attribute.dictionaryValueId = null;
  }
  const schema = plan.inputSnapshots.platformSchemaRules;
  for (const field of plan.productAttributes.requiredPlatformFields) {
    const definition = schema.requiredFields.find(item => item.fieldKey === field.fieldKey);
    if (![field.fieldKey, ...(definition?.sourceAttributeKeys ?? [])].some(key => restrictedKeys.has(key))) continue;
    field.fact = unknown(field.fact);
    if (Object.hasOwn(field, "ozonDictionaryValueId")) field.ozonDictionaryValueId = null;
    delete field.resolvedFromOwnerAttributeMapping;
    delete field.dictionaryValueIdResolvedFromOwnerAttributeMapping;
  }
  const gapCount = plan.productAttributes.requiredPlatformFields.filter(field => field.fact.verificationStatus === "unknown").length;
  plan.productAttributes.status = sourcedFact(gapCount === 0 ? "all_required_fields_known" : "required_fields_incomplete", plan.productAttributes.status.sourceRefs);
  plan.platformCompliance.requiredFieldGapCount = sourcedFact(gapCount, plan.platformCompliance.requiredFieldGapCount.sourceRefs);
  plan.unknownManifest = collectC1UnknownManifest(plan);
  if (!sameStoreRef(schema.storeRef, skuPackage.g1Identity.storeRef)) {
    plan.unknownManifest.push({ fieldPath: "schemaSnapshot.storeRef", reason: "full_store_scope_not_confirmed",
      sourceRefs: [schema.evidenceId], blockingScope: "required_field", blocksC2Handoff: true });
  }
  const validation = validateC1FactVerification(plan);
  if (!validation.valid) throw new Error(`C1_ATTRIBUTE_SCOPE_RESULT_INVALID: ${validation.errors.map(item => item.path).join(",")}`);
  if (sameJson(plan, current)) return deepFreeze({ skuPackage: structuredClone(skuPackage), changed: false });
  const next = structuredClone(skuPackage);
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.audit.updatedAt = reviewedAt;
  next.audit.history.push({ event: "c1_attribute_scope_reviewed", at: reviewedAt, evidenceRef: scopeReview.evidenceRef,
    fieldKeys: [...restrictedKeys], externalAccesses: [], seoGenerated: false, assetsGenerated: false, productionStarted: false });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C1_ATTRIBUTE_SCOPE_TRANSITION_INVALID: ${transition.errors.map(item => item.path).join(",")}`);
  return deepFreeze({ skuPackage: next, changed: true });
}
