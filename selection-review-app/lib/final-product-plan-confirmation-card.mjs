import { collectC1UnknownManifest, C1_UNKNOWN_CLASSIFICATION_VERSION } from './c1-product-plan.mjs';
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { assertValidC2AssetLifecycle, selectConfirmedFinalUploadsForProduction } from "./c2-asset-lifecycle.mjs";
import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";

export const FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION = "final-product-plan-confirmation-card-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  if (!nonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) === value.slice(0, 10);
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

function push(errors, path, message) {
  errors.push({ path, message });
}

function sourceValue(value, sourceRefs) {
  return {
    value: structuredClone(value),
    sourceRefs: [...new Set(sourceRefs.filter(nonEmptyString))]
  };
}

function collectUnknownFacts(value, path = "", output = [], context = {}) {
  if (isObject(value) && value.verificationStatus === "unknown" && value.value === "unknown") {
    output.push({
      path,
      fieldKey: context.fieldKey || null,
      label: context.label || null,
      value: "unknown",
      reason: value.reason || "not_confirmed_in_frozen_evidence",
      sourceRefs: Array.isArray(value.sourceRefs) ? structuredClone(value.sourceRefs) : []
    });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnknownFacts(item, `${path}[${index}]`, output, context));
    return output;
  }
  if (isObject(value)) {
    const nextContext = {
      fieldKey: nonEmptyString(value.fieldKey) ? value.fieldKey : context.fieldKey,
      label: nonEmptyString(value.label) ? value.label : context.label
    };
    for (const [key, child] of Object.entries(value)) {
      collectUnknownFacts(child, path ? `${path}.${key}` : key, output, nextContext);
    }
  }
  return output;
}

function validateSourceValue(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是带来源的值");
    return;
  }
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0 || value.sourceRefs.some((ref) => !nonEmptyString(ref))) {
    push(errors, `${path}.sourceRefs`, "必须至少有一个来源");
  }
}

export function validateFinalProductPlanConfirmationCard(card) {
  const errors = [];
  if (!isObject(card)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (card.schemaVersion !== FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION) push(errors, "schemaVersion", `必须是${FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION}`);
  if (!nonEmptyString(card.cardId)) push(errors, "cardId", "必须是非空字符串");
  if (!Number.isInteger(card.cardRevision) || card.cardRevision < 1) push(errors, "cardRevision", "必须是正整数");
  if (!["awaiting_owner_business_confirmation", "owner_business_approved"].includes(card.status)) {
    push(errors, "status", "必须是等待确认或主人已通过");
  }
  if (!isoDateTime(card.createdAt)) push(errors, "createdAt", "必须是有效时间");
  if (card.status === "awaiting_owner_business_confirmation" && card.ownerDecision !== null) {
    push(errors, "ownerDecision", "等待阶段不得自动替主人决定");
  }
  if (card.status === "owner_business_approved") {
    const decision = card.ownerDecision;
    if (!isObject(decision) ||
        decision.selectedOption !== "approve_for_production_authorization" ||
        !["production-owner-confirmation-v1", "production-owner-confirmation-v2"].includes(decision.ownerConfirmation?.schemaVersion) ||
        decision.ownerConfirmation?.actorType !== "human" || decision.ownerConfirmation?.role !== "owner" ||
        !nonEmptyString(decision.ownerConfirmation?.actorId) || !isoDateTime(decision.ownerConfirmation?.confirmedAt) ||
        decision.sourceConfirmationCardId !== card.cardId ||
        decision.decisionId !== decision.ownerConfirmation?.decisionId ||
        decision.ownerDecisionFingerprint !== decision.ownerConfirmation?.ownerDecisionFingerprint) {
      push(errors, "ownerDecision", "通过状态必须保存主人的准确决定和时间");
    }
  }
  if (!Array.isArray(card.decisionOptions) || !sameJson(card.decisionOptions, ["approve_for_production_authorization", "return_to_c_stage", "reject_product"])) {
    push(errors, "decisionOptions", "必须提供通过、退回和淘汰三个商业选项");
  }
  for (const section of ["productInformation", "profitResult", "c1Facts", "seoDraft", "c2Assets", "riskAndUnknowns", "productionBoundary"]) {
    if (!isObject(card[section])) push(errors, section, "必须是对象");
  }
  if (isObject(card.productInformation)) {
    for (const field of ["productName", "sku", "supplierOption", "targetPlatform"]) validateSourceValue(card.productInformation[field], `productInformation.${field}`, errors);
  }
  if (isObject(card.profitResult)) {
    for (const field of ["recommendedSalePrice", "unitProfitRmb", "profitMargin"]) validateSourceValue(card.profitResult[field], `profitResult.${field}`, errors);
  }
  if (isObject(card.c2Assets)) {
    if (card.c2Assets.sourceArea !== "assets.finalUploads") push(errors, "c2Assets.sourceArea", "确认卡只能读取assets.finalUploads");
    if (!Array.isArray(card.c2Assets.finalUploads) || card.c2Assets.finalUploads.length === 0) push(errors, "c2Assets.finalUploads", "必须包含主人确认的最终素材");
    if ("collected" in card.c2Assets || "aiDrafts" in card.c2Assets) push(errors, "c2Assets", "确认卡不得包含采集素材或AI草稿");
    if (card.c2Assets.finalUploads?.some((asset) => asset.ownerConfirmed !== true || asset.productionEligible !== true)) {
      push(errors, "c2Assets.finalUploads", "最终素材必须逐项由主人确认");
    }
  }
  if (isObject(card.riskAndUnknowns) && !Array.isArray(card.riskAndUnknowns.unknownFields)) {
    push(errors, "riskAndUnknowns.unknownFields", "必须是数组");
  }
  if (isObject(card.riskAndUnknowns) && Object.hasOwn(card.riskAndUnknowns, 'classificationVersion')) {
    const risk = card.riskAndUnknowns;
    if (risk.classificationVersion !== C1_UNKNOWN_CLASSIFICATION_VERSION || !Array.isArray(risk.unknownFields) ||
        risk.unknownFields.some(field => !isObject(field) || !['informational','required_field','compliance'].includes(field.blockingScope) ||
          field.blocksProductionAuthorization !== (field.blockingScope !== 'informational')) ||
        risk.blockingUnknownCount !== risk.unknownFields.filter(field => field.blocksProductionAuthorization).length)
      push(errors, 'riskAndUnknowns', '未知字段分类必须完整且计数一致');
  }
  if (isObject(card.productionBoundary)) {
    if (card.productionBoundary.productionAuthorized !== false) push(errors, "productionBoundary.productionAuthorized", "确认卡自身不得执行生产");
    if (card.productionBoundary.dStarted !== false) push(errors, "productionBoundary.dStarted", "确认卡不得进入D");
    if (card.productionBoundary.platformWrites !== 0) push(errors, "productionBoundary.platformWrites", "确认卡不得产生平台写入");
    if (card.productionBoundary.requiresSeparateExactAuthorization !== true) push(errors, "productionBoundary.requiresSeparateExactAuthorization", "D必须另行取得精确授权");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidFinalProductPlanConfirmationCard(card) {
  const result = validateFinalProductPlanConfirmationCard(card);
  if (!result.valid) throw new Error(`最终商品方案确认卡校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return card;
}

/**
 * 第11阶段只生成主人商业确认视图，不记录决定、不创建生产授权、不进入D。
 */
export function createFinalProductPlanConfirmationCard({ skuPackage, createdAt }) {
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.businessPhase !== "C2" || skuPackage.c2FinalAssets.status !== "completed") {
    throw new Error("FINAL_PLAN_CARD_GATE_REJECTED: C2最终素材尚未由主人确认");
  }
  if (skuPackage.productionAuthorization !== null || skuPackage.productionRecord !== null) {
    throw new Error("FINAL_PLAN_CARD_GATE_REJECTED: 已存在生产授权或生产记录");
  }
  if (!isoDateTime(createdAt)) throw new Error("FINAL_PLAN_CARD_INPUT_GAP: 创建时间无效");
  if (skuPackage.productionConfirmationCard !== undefined && skuPackage.productionConfirmationCard !== null) {
    throw new Error("FINAL_PLAN_CARD_GATE_REJECTED: 确认卡已经存在");
  }

  const selection = selectConfirmedFinalUploadsForProduction(skuPackage);
  const frozen = selection.productionAuthorizationPreparation.finalCardInputSnapshot;
  const c1 = frozen.c1Snapshot;
  assertCurrentC1SkuRightsReview({ plan: c1, sourceIdentity: frozen.identity, observedAt: createdAt });
  const profit = frozen.activeProfitModel;
  if (!profit || profit.result !== "passed") throw new Error("FINAL_PLAN_CARD_INPUT_GAP: 缺少当前通过的B利润结果");
  const sales = c1.inputSnapshots.salesSnapshot;
  const supply = c1.inputSnapshots.confirmedSupplierSkuSnapshot;
  const supplyIdentity = supply.supplierOptionIdentity;
  const unknownFields = collectUnknownFacts({
    productAttributes: c1.productAttributes,
    platformCategory: c1.platformCategory,
    batteryAssessment: c1.batteryAssessment,
    categoryRestrictions: c1.categoryRestrictions,
    platformCompliance: c1.platformCompliance
  });
  const classification = new Map(collectC1UnknownManifest(c1).map(entry => [entry.fieldPath, entry]));
  for (const field of unknownFields) {
    const entry = classification.get(field.path);
    if (!entry) throw new Error('FINAL_PLAN_CARD_UNKNOWN_CLASSIFICATION_MISSING');
    field.blockingScope = entry.blockingScope;
    field.blocksProductionAuthorization = entry.blocksC2Handoff;
  }
  const blockingUnknownCount = unknownFields.filter(field => field.blocksProductionAuthorization).length;
  const materialRisks = [
    profit.commissionMode === "estimated" ? "exact_commission_required_before_production" : null,
    c1.batteryAssessment?.assessment?.value === "unknown" ? "battery_status_unknown" : null,
    c1.categoryRestrictions?.restrictions?.value === "unknown" ? "category_restrictions_unknown" : null,
    c1.platformCompliance?.assessment?.value === "unknown" ? "platform_compliance_unknown" : null,
    c1.productAttributes?.requiredPlatformFields?.some((field) => field.fact?.value === "unknown") ? "required_platform_attributes_incomplete" : null,
    c1.marketReferenceMismatch?.status === "known" ? "sales_reference_spec_differs_from_exact_supplier_sku" : null
  ].filter(Boolean);

  const card = {
    schemaVersion: FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION,
    cardId: `final-plan-card:${skuPackage.skuPackageId}:${skuPackage.dataRevision}`,
    cardRevision: skuPackage.finalPricingReview ? skuPackage.finalPricingReview.assessment.target.sourceRevision + 1 : 1,
    status: "awaiting_owner_business_confirmation",
    createdAt,
    ownerDecision: null,
    decisionOptions: ["approve_for_production_authorization", "return_to_c_stage", "reject_product"],
    productInformation: {
      productName: sourceValue(sales.title, [c1.inputRefs.salesSnapshotId, `${c1.inputRefs.salesSnapshotId}#/title`]),
      sku: sourceValue({
        skuPackageId: frozen.identity.skuPackageId,
        supplierSkuId: frozen.identity.supplierSkuId,
        variantKey: frozen.variantKey
      }, [c1.inputRefs.selectedSupplySnapshotId, `${c1.inputRefs.selectedSupplySnapshotId}#/supplierSku`]),
      supplierOption: sourceValue({
        supplierOptionId: c1.identity.supplierOptionId,
        sourcePlatform: supplyIdentity.sourcePlatform,
        offerId: supplyIdentity.offerId,
        productUrl: supplyIdentity.productUrl,
        ownerConfirmedAt: supply.ownerSupplyConfirmation.confirmedAt
      }, [c1.inputRefs.selectedSupplySnapshotId, `${c1.inputRefs.selectedSupplySnapshotId}#/ownerSupplyConfirmation`]),
      targetPlatform: sourceValue({ platform: frozen.identity.platform, store: frozen.identity.storeRef.stableStoreId, storeRef: structuredClone(frozen.identity.storeRef) }, [c1.inputRefs.platformSchemaEvidenceId])
    },
    profitResult: {
      finalPricingReview: skuPackage.finalPricingReview ? sourceValue({ assessmentId: skuPackage.finalPricingReview.assessment.assessmentId,
        coreSampleIds: skuPackage.finalPricingReview.assessment.coreSampleIds,
        supplementarySampleIds: skuPackage.finalPricingReview.assessment.supplementarySampleIds,
        insufficientSamples: skuPackage.finalPricingReview.assessment.insufficientSamples,
        priceBand: skuPackage.finalPricingReview.assessment.priceBand }, [skuPackage.finalPricingReview.assessment.assessmentId]) : null,
      profitModelVersion: profit.profitModelVersion,
      recommendedSalePrice: sourceValue({ rub: profit.recommendedSalePriceRub ?? null, cny: profit.recommendedSalePriceCny ?? null }, [profit.profitModelVersion]),
      unitProfitRmb: sourceValue(profit.unitProfitRmb, [profit.profitModelVersion]),
      profitMargin: sourceValue(profit.profitMargin, [profit.profitModelVersion]),
      result: sourceValue(profit.result, [profit.profitModelVersion]),
      commissionMode: sourceValue(profit.commissionMode ?? "unknown", [profit.profitModelVersion])
    },
    c1Facts: {
      exactSku: structuredClone(c1.exactSkuVerification),
      platformCategory: structuredClone(c1.platformCategory),
      productAttributes: structuredClone(c1.productAttributes),
      batteryStatus: structuredClone(c1.batteryAssessment),
      categoryRestrictions: structuredClone(c1.categoryRestrictions),
      platformCompliance: structuredClone(c1.platformCompliance)
    },
    seoDraft: {
      status: "draft_only",
      title: structuredClone(c1.seoTitleDraft),
      description: structuredClone(c1.descriptionDraft),
      bulletPoints: structuredClone(c1.bulletPointsDraft),
      searchKeywords: structuredClone(c1.searchKeywordsDraft),
      finalSeoConfirmed: false
    },
    c2Assets: {
      sourceArea: "assets.finalUploads",
      finalUploads: structuredClone(selection.assets),
      ownerFinalUploadConfirmation: structuredClone(selection.ownerConfirmation)
    },
    riskAndUnknowns: {
      classificationVersion: C1_UNKNOWN_CLASSIFICATION_VERSION,
      status: materialRisks.length > 0 || blockingUnknownCount > 0 ? 'owner_review_required' :
        unknownFields.length > 0 ? 'informational_unknowns' : 'no_recorded_gaps',
      blockingUnknownCount,
      materialRisks,
      unknownFields,
      unknownCount: unknownFields.length,
      marketReferenceMismatch: structuredClone(c1.marketReferenceMismatch || null)
    },
    productionBoundary: {
      productionAuthorized: false,
      dStarted: false,
      platformWrites: 0,
      requiresSeparateExactAuthorization: true,
      authorizationScopeRequired: ["platform", "store", "product", "sku", "price", "stock", "finalUploads", "publishScope", "exclusions"]
    }
  };
  assertValidFinalProductPlanConfirmationCard(card);

  const protectedC1 = structuredClone(skuPackage.c1ProductPlan);
  const protectedC2 = structuredClone(skuPackage.c2FinalAssets);
  const protectedProfit = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.productionConfirmationCard = card;
  // The card is a view of the frozen C2 preparation, not a new SKU transition.
  assertValidLifecyclePackage(next);
  if (!sameJson(protectedC1, next.c1ProductPlan) || !sameJson(protectedC2, next.c2FinalAssets) || !sameJson(protectedProfit, next.profitModels)) {
    throw new Error("FINAL_PLAN_CARD_PROTECTED_DATA_CHANGED: B、C1或C2数据被改写");
  }
  if (next.productionAuthorization !== null || next.productionRecord !== null || next.businessPhase !== "C2") {
    throw new Error("FINAL_PLAN_CARD_BOUNDARY_VIOLATION: 确认卡不得自动授权或进入D");
  }
  return deepFreeze({
    flowVersion: "final-product-plan-confirmation-card-flow-v1.1",
    skuPackage: next,
    confirmationCard: next.productionConfirmationCard
  });
}
