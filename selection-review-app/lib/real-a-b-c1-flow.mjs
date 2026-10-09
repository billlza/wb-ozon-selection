import { readAProductDetailSupplierEvidence } from './a-product-detail-evidence.mjs';
import { readConfirmedSupplierPowerProfile, readConfirmedSupplierVariantAttributes } from './confirmed-supplier-inputs.mjs';
import { isDeepStrictEqual } from "node:util";
import { createC1ProductPlan } from "./c1-product-plan.mjs";
import { assessAStageMarket } from "./market-sample-policy.mjs";
import {
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  assertValidLifecyclePackage, validateLifecyclePackage
} from "./product-lifecycle-schema.mjs";
import { runSkuProfitModel, validateProfitModel } from "./profit-model.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { createLifecycleBInputBundle, assertValidLifecycleBInputBundle, inspectLifecycleBInputReadiness, validateLifecycleBInputBundle, inspectCommissionCatalogValidity } from "./lifecycle-b-input-bundle.mjs";
import {
  buildRealAConfirmationCard,
  validateRealAConfirmationSubmission
} from "./real-a-confirmation-card.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption
} from "./supplier-selection-flow.mjs";
import { assertValidSupplierOption, UNKNOWN } from "./supplier-option.mjs";
import { extractPinduoduoGoodsId, supplierCapturePlatform } from "./source-capture.mjs";

export const REAL_A_B_C1_FLOW_VERSION = "real-a-b-c1-flow-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function offerIdFromUrl(value) {
  if (supplierCapturePlatform(value) === "pinduoduo") return extractPinduoduoGoodsId(value) || null;
  return new URL(value).pathname.match(/\/offer\/(\d+)\.html/i)?.[1] || null;
}

function salesSnapshot(candidate, snapshotId) {
  return (candidate.salesSnapshotsV11 || []).find((snapshot) => snapshot.snapshotId === snapshotId) || null;
}

/**
 * 1688 详情页采到的商品级属性。采集层一直有（这件小猫背心采到 17 项，含「面料=牛津布」），
 * 但在 2026-09-17 之前它们**一个都没进冻结快照**：下面 material 被写死成 UNKNOWN，
 * attributes 里只有两个内部记账对象。结果是 C1 的已确认事实里没有任何真实商品属性，
 * 关键词无处可绑、Ozon 属性位也填不上。这里把它们照实带进来。
 *
 * 品牌两项**不带**：1688 卖家把「品牌」当成款式名随手写（这件写的是 WOSPORT，货是白牌），
 * 而主人在 C1 签的品牌与权利声明才是唯一权威。把它提升成「已确认事实」会造出一条
 * 和主人签字相矛盾的事实。原始采集仍原样留在 candidate.sourceCapture，保真不丢。
 */
const SUPPLIER_ATTRIBUTE_KEYS_NOT_FACTS = new Set(["品牌", "有可授权的自有品牌"]);

function capturedSupplierAttributes(candidate) {
  const raw = candidate?.sourceCapture?.supplierAttributes;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const kept = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SUPPLIER_ATTRIBUTE_KEYS_NOT_FACTS.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    kept[key] = value.trim();
  }
  return kept;
}

function supplierOption(normalized, candidate, confirmedAt) {
  const supplier = normalized.supplierConfirmation;
  const offerId = offerIdFromUrl(supplier.productUrl);
  const evidenceRef = `owner-a-confirmation:${candidate.id}:${candidate.dataRevision}`;
  const saved = readAProductDetailSupplierEvidence(candidate);
  const capturedAttributes = saved ? {} : capturedSupplierAttributes(candidate);
  const variantAttributes = readConfirmedSupplierVariantAttributes(candidate, supplier);
  const declaredPowerProfile = readConfirmedSupplierPowerProfile(candidate);
  const platform = supplierCapturePlatform(supplier.productUrl) === "pinduoduo" ? "pinduoduo" : "1688";
  const option = {
    supplierOptionId: `supplier-option:${platform}:${offerId}`,
    sourcePlatform: platform,
    productUrl: supplier.productUrl,
    offerId,
    supplierSalesEvidence: UNKNOWN,
    supplierBadges: UNKNOWN,
    supplierSkus: [{
      supplierSkuId: supplier.supplierSkuId,
      variantKey: supplier.variantKey,
      attributes: {
        ...(supplier.quantityOneEvidenceSourceNote !== undefined ? { quantityOneEvidence: {
          source: 'owner_quantity_one_confirmation', candidateId: candidate.id, sourceRevision: candidate.dataRevision,
          captureId: supplier.captureId, productUrl: supplier.productUrl, supplierSkuId: supplier.supplierSkuId,
          variantKey: supplier.variantKey, minimumOrderQuantity: supplier.minimumOrderQuantity,
          unitProductPrice: supplier.unitProductPrice, currency: 'CNY', matchType: supplier.matchType,
          sourceNote: supplier.quantityOneEvidenceSourceNote, evidenceRef, confirmedAt
        } } : {}),
        purchaseCostComponents: {
          unitProductPrice: supplier.unitProductPrice,
          unitDomesticFreight: supplier.unitDomesticFreight,
          otherPurchaseCosts: supplier.otherPurchaseCosts,
          actualPurchaseCost: supplier.actualPurchaseCost,
          currency: "CNY"
        },
        ...structuredClone(capturedAttributes),
        ...structuredClone(variantAttributes ?? {})
      },
      unitProductPrice: supplier.unitProductPrice,
      unitDomesticFreight: supplier.unitDomesticFreight,
      actualPurchaseCost: supplier.actualPurchaseCost,
      weight: { value: supplier.weightKg, unit: "kg", evidenceRef },
      dimensions: { ...structuredClone(supplier.dimensionsCm), unit: "cm", evidenceRef },
      // 面料就是材质，页面上采到什么就是什么；采不到才回 UNKNOWN，不替主人猜一个。
      material: capturedAttributes["面料"] ?? UNKNOWN,
      powerProfile: declaredPowerProfile ?? UNKNOWN,
      imageRefs: UNKNOWN
    }],
    captureTime: confirmedAt,
    evidenceRef
  };
  if(saved){
    const original=saved.supplierOption.supplierSkus.find(sku=>sku.supplierSkuId===supplier.supplierSkuId);
    if(!original||original.variantKey!==supplier.variantKey)throw new Error('REAL_A_API_SUPPLIER_SOURCE_CHANGED');
    const confirmed=option.supplierSkus[0];
    if (declaredPowerProfile && isObject(original.powerProfile) &&
        typeof original.powerProfile.containsBattery === 'boolean' && original.powerProfile.containsBattery !== declaredPowerProfile.containsBattery) {
      throw new Error('REAL_A_POWER_SOURCE_CONFLICT');
    }
    const frozen={...structuredClone(saved.supplierOption),supplierSkus:[{...structuredClone(original),
      attributes:{...structuredClone(original.attributes),...confirmed.attributes},unitProductPrice:confirmed.unitProductPrice,
      powerProfile: declaredPowerProfile ?? structuredClone(original.powerProfile),
      unitDomesticFreight:confirmed.unitDomesticFreight,actualPurchaseCost:confirmed.actualPurchaseCost,weight:confirmed.weight,dimensions:confirmed.dimensions}]};
    assertValidSupplierOption(frozen);return frozen;
  }
  assertValidSupplierOption(option);
  return option;
}

function opportunityPackage(candidate, normalized, confirmedAt) {
  const snapshot = salesSnapshot(candidate, normalized.salesReview.snapshotId);
  if (!snapshot) throw new Error("REAL_A_SNAPSHOT_CHANGED: 确认卡销售快照已经不存在");
  const option = supplierOption(normalized, candidate, confirmedAt);
  const opportunity = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "OpportunityPackage",
    parentOpportunityId: `opportunity:${candidate.id}`,
    directionName: candidate.productName,
    targetPlatform: candidate.targetStore === "wb" ? "wb" : "ozon",
    targetStore: candidate.targetStore,
    dataRevision: candidate.dataRevision,
    businessPhase: "A",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "confirm_supplier_option",
    salesSnapshots: [structuredClone(snapshot)],
    marketAssessment: null,
    supplierOptions: [option],
    recommendedSupplierOptionId: null,
    confirmedSupplierOptionId: null,
    supplierSearch: {
      status: "completed",
      limits: { maxSearchRounds: 1, maxSupplierOptions: 1, maxConsecutiveNoEvidenceRounds: 1 },
      searchRounds: 1,
      supplierOptionsFound: 1,
      consecutiveNoEvidenceRounds: 0,
      stopReason: "scope_completed",
      stoppedAt: confirmedAt
    },
    audit: {
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      history: [{
        event: "real_a_one_card_inputs_frozen",
        at: confirmedAt,
        sourceCandidateId: candidate.id,
        sourceCandidateRevision: candidate.dataRevision,
        externalAccesses: 0
      }]
    }
  };
  opportunity.marketAssessment = assessAStageMarket({
    opportunityPackage: opportunity,
    sampleReviews: {
      [snapshot.snapshotId]: {
        comparability: normalized.salesReview.comparability,
        priceEvidenceStatus: "verified",
        validityStatus: normalized.salesReview.validityStatus,
        evidenceTraceable: true
      }
    },
    assessedAt: confirmedAt,
    assessmentId: `a-market:${candidate.id}:${candidate.dataRevision}`,
    supplyDataStatus: "ready"
  });
  if (opportunity.marketAssessment.status !== "passed") {
    throw new Error(`REAL_A_MARKET_GATE_REJECTED: ${opportunity.marketAssessment.gateReason}`);
  }
  opportunity.businessResult = "passed";
  opportunity.ownerAction = "confirm_supplier_option";
  assertValidLifecyclePackage(opportunity);
  return opportunity;
}

function createC1Handoff({ opportunityPackage, skuPackage, profitModel, createdAt }) {
  return {
    handoffId: `c1-handoff:${skuPackage.skuPackageId}:${profitModel.profitModelVersion}`,
    status: "created",
    createdAt,
    trigger: "b_passed_auto_c1",
    fromOwner: "selection_task",
    toOwner: "listing_task",
    uniqueOwner: "listing_task",
    parentOpportunityId: opportunityPackage.parentOpportunityId,
    skuPackageId: skuPackage.skuPackageId,
    supplierSkuId: skuPackage.supplierSkuId,
    inheritedOpportunityRevision: opportunityPackage.dataRevision,
    inheritedSkuRevision: skuPackage.dataRevision,
    inputPackageRefs: [
      opportunityPackage.parentOpportunityId,
      skuPackage.skuPackageId,
      profitModel.profitModelVersion
    ],
    selectionTaskStopped: true,
    realTaskDispatched: false
  };
}

function replayExistingLifecycle(candidate, validation) {
  const lifecycle = candidate.lifecycleV11;
  const opportunity = lifecycle?.opportunityPackage;
  const skuPackage = lifecycle?.skuPackage;
  if (!opportunity || !skuPackage) return null;
  if (validation.decision !== "confirm" || !validation.normalized) {
    throw new Error("REAL_A_ALREADY_CONFIRMED_CONFLICT: 已有SKU生命周期与本次决定不一致");
  }
  const expected = validation.normalized;
  const supply = skuPackage.selectedSupplySnapshot;
  const supplierSku = supply?.supplierSku;
  const components = supplierSku?.attributes?.purchaseCostComponents;
  const identity = supply?.supplierOption;
  const sameSales = opportunity.salesSnapshots?.some((item) => item.snapshotId === expected.salesReview.snapshotId);
  const sameSupply = identity?.productUrl === expected.supplierConfirmation.productUrl &&
    supplierSku?.supplierSkuId === expected.supplierConfirmation.supplierSkuId &&
    supplierSku?.variantKey === expected.supplierConfirmation.variantKey &&
    components?.unitProductPrice === expected.supplierConfirmation.unitProductPrice &&
    components?.unitDomesticFreight === expected.supplierConfirmation.unitDomesticFreight &&
    components?.otherPurchaseCosts === expected.supplierConfirmation.otherPurchaseCosts &&
    supplierSku?.actualPurchaseCost === expected.supplierConfirmation.actualPurchaseCost &&
    supplierSku?.weight?.value === expected.supplierConfirmation.weightKg &&
    supplierSku?.dimensions?.length === expected.supplierConfirmation.dimensionsCm.length &&
    supplierSku?.dimensions?.width === expected.supplierConfirmation.dimensionsCm.width &&
    supplierSku?.dimensions?.height === expected.supplierConfirmation.dimensionsCm.height;
  if (!sameSales || !sameSupply) {
    throw new Error("REAL_A_ALREADY_CONFIRMED_CONFLICT: 本次A确认输入与已冻结销售或供应数据不一致");
  }
  const receipt = lifecycle.aConfirmationReceipt;
  if (!Number.isSafeInteger(receipt?.sourceCandidateRevision) || !nonEmptyString(receipt?.receiptId) ||
      skuPackage.g1Identity?.candidateId !== candidate.id || !sameStoreRef(candidate.storeRef, skuPackage.g1Identity?.storeRef)) {
    throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: 历史生命周期缺少一致店铺身份或A确认修订");
  }
  assertValidLifecycleBInputBundle(lifecycle.bSystemEvidenceBundle, {
    candidate: { ...candidate, dataRevision: receipt.sourceCandidateRevision }, normalizedSubmission: validation.normalized
  });
  const profitModel = skuPackage.profitModels?.find((item) => item.profitModelVersion === skuPackage.activeProfitModelVersion);
  if (!profitModel) throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: 缺少当前B利润版本");
  const handoffs = Array.isArray(lifecycle.c1Handoffs) ? lifecycle.c1Handoffs : [];
  if (handoffs.length > 1) throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: 同一SKU存在多个C1交接");
  const c1Handoff = handoffs[0] || null;
  if (c1Handoff && (c1Handoff.skuPackageId !== skuPackage.skuPackageId || c1Handoff.inheritedSkuRevision !== skuPackage.dataRevision)) {
    throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: C1交接没有锁定同一SKU包及修订号");
  }
  assertValidLifecyclePackage(opportunity);
  assertValidLifecyclePackage(skuPackage);
  return deepFreeze({
    flowVersion: REAL_A_B_C1_FLOW_VERSION,
    decision: "confirm",
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: receipt.sourceCandidateRevision,
    confirmationReceiptId: receipt.receiptId,
    systemEvidenceBundle: structuredClone(lifecycle.bSystemEvidenceBundle),
    opportunityPackage: structuredClone(opportunity),
    ownerSupplyConfirmation: structuredClone(lifecycle.ownerSupplyConfirmation),
    skuPackage: structuredClone(skuPackage),
    profitModel: structuredClone(profitModel),
    c1Handoff: structuredClone(c1Handoff),
    uniqueOwner: c1Handoff ? "listing_task" : "none",
    idempotentReplay: true,
    externalAccesses: [],
    taskDispatches: 0,
    platformWrites: 0
  });
}

function calculateBAndCreateC1({ opportunity, skuPackage, salesSelection, evidence, processedAt }) {
  const bResult = runSkuProfitModel({
    opportunityPackage: opportunity,
    skuPackage,
    salesSelection,
    platformFeeEvidence: evidence.platformFeeEvidence,
    logisticsEvidence: evidence.logisticsEvidence,
    exchangeRateEvidence: evidence.exchangeRateEvidence,
    calculatedAt: processedAt
  });
  skuPackage = bResult.skuPackage;

  let c1Handoff = null;
  if (bResult.profitModel.result === "passed") {
    const c1Result = createC1ProductPlan({
      opportunityPackage: opportunity,
      skuPackage,
      platformSchemaEvidence: evidence.platformSchemaEvidence,
      createdAt: processedAt
    });
    skuPackage = c1Result.skuPackage;
    c1Handoff = createC1Handoff({
      opportunityPackage: opportunity,
      skuPackage,
      profitModel: bResult.profitModel,
      createdAt: processedAt
    });
  }
  return { skuPackage, profitModel: bResult.profitModel, c1Handoff };
}

/**
 * 真实A确认后的纯函数闭环。调用者负责在一个原子持久化事务中保存结果。
 * 本函数不访问平台、不派发Codex任务，也不修改输入候选。
 */
export function runRealAConfirmationToBAndC1({
  candidate,
  submission,
  evidencePacks,
  currentCommissionCatalogs = [],
  otherCosts,
  confirmedAt,
  processedAt = confirmedAt
}) {
  if (!isObject(candidate) || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("REAL_A_INPUT_GAP: 候选或修订号无效");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("REAL_A_INPUT_GAP: 确认时间无效");
  if (!isoDateTime(processedAt) || Date.parse(processedAt) < Date.parse(confirmedAt)) {
    throw new Error("REAL_A_INPUT_GAP: B处理时间不得早于主人确认时间");
  }
  const before = JSON.stringify(candidate);
  const card = buildRealAConfirmationCard(candidate);
  const validation = validateRealAConfirmationSubmission(card, submission);
  if (!validation.valid) {
    const detail = validation.errors.map((item) => `${item.label}：${item.reason}`).join("；");
    throw new Error(`REAL_A_CONFIRMATION_INVALID: ${detail}`);
  }
  if (candidate.lifecycleV11?.skuPackage) return replayExistingLifecycle(candidate, validation);
  if (validation.decision === "reject") {
    return deepFreeze({
      flowVersion: REAL_A_B_C1_FLOW_VERSION,
      decision: "reject",
      sourceCandidateId: candidate.id,
      sourceCandidateRevision: candidate.dataRevision,
      confirmationReceiptId: `a-confirmation:${candidate.id}:${candidate.dataRevision}:reject`,
      opportunityPackage: null,
      ownerSupplyConfirmation: null,
      skuPackage: null,
      profitModel: null,
      c1Handoff: null,
      uniqueOwner: "none",
      externalAccesses: [],
      taskDispatches: 0,
      platformWrites: 0
    });
  }

  const evidence = createLifecycleBInputBundle({
    candidate,
    evidencePacks,
    currentCommissionCatalogs,
    otherCosts,
    normalizedSubmission: validation.normalized,
    createdAt: processedAt
  });
  let opportunity = opportunityPackage(candidate, validation.normalized, confirmedAt);
  const targetVariantKey = validation.normalized.supplierConfirmation.variantKey;
  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey,
    scoredAt: confirmedAt
  });
  const confirmationResult = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: recommendation.recommendedSupplierOptionId,
      supplierSkuId: validation.normalized.supplierConfirmation.supplierSkuId,
      variantKey: targetVariantKey
    },
    confirmedAt
  });
  opportunity = confirmationResult.opportunityPackage;
  let skuPackage = createSkuLifecycleFromConfirmedSupply({
    candidateId: candidate.id,
    opportunityPackage: opportunity,
    storeRef: candidate.storeRef,
    ownerSupplyConfirmation: confirmationResult.confirmation,
    skuPackageId: `sku-lifecycle:${candidate.id}:${validation.normalized.supplierConfirmation.supplierSkuId}`,
    createdAt: confirmedAt
  });
  const bResult = calculateBAndCreateC1({ opportunity, skuPackage,
    salesSelection: { salesSnapshotId: validation.normalized.salesReview.snapshotId }, evidence, processedAt });
  skuPackage = bResult.skuPackage;
  const c1Handoff = bResult.c1Handoff;
  if (JSON.stringify(candidate) !== before) throw new Error("REAL_A_INPUT_MUTATED");
  assertValidLifecyclePackage(opportunity);
  assertValidLifecyclePackage(skuPackage);

  return deepFreeze({
    flowVersion: REAL_A_B_C1_FLOW_VERSION,
    decision: "confirm",
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: candidate.dataRevision,
    confirmationReceiptId: `a-confirmation:${candidate.id}:${candidate.dataRevision}:confirm`,
    systemEvidenceBundle: evidence,
    opportunityPackage: opportunity,
    ownerSupplyConfirmation: confirmationResult.confirmation,
    skuPackage,
    profitModel: bResult.profitModel,
    c1Handoff,
    uniqueOwner: c1Handoff ? "listing_task" : "none",
    idempotentReplay: false,
    externalAccesses: [],
    taskDispatches: 0,
    platformWrites: 0
  });
}

const B_RECALCULATION_ERROR_CODES = new Set([
  "B_EXACT_RECALCULATION_INPUT_INVALID", "B_EXACT_RECALCULATION_AUTHENTICATED_OWNER_REQUIRED", "B_EXACT_RECALCULATION_SOURCE_CONFLICT",
  "B_EXACT_RECALCULATION_NOT_AVAILABLE", "B_EXACT_RECALCULATION_EXACT_EVIDENCE_REQUIRED",
  "B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE", "B_EXACT_RECALCULATION_JOBS_PRESENT"
]);
export class BExactCommissionRecalculationError extends Error {
  constructor(code) {
    if (!B_RECALCULATION_ERROR_CODES.has(code)) throw new TypeError("B_EXACT_RECALCULATION_ERROR_CODE_INVALID");
    super(code); this.name = "BExactCommissionRecalculationError"; this.code = code;
  }
}
function rejectB(code) { throw new BExactCommissionRecalculationError(code); }

class BCommissionEvidenceError extends Error {
  constructor(code) {
    super(code); this.name = "BCommissionEvidenceError"; this.code = code;
  }
}
function rejectCommission(code) { throw new BCommissionEvidenceError(code); }

/** Recheck the frozen commission against the current transaction's evidence and catalog declarations. */
export function assertCurrentBCommissionEvidence({ bundle, evidencePacks, currentCommissionCatalogs = [], asOf }) {
  const fee = bundle?.platformFeeEvidence, context = bundle?.context;
  if (!isObject(fee) || !nonEmptyString(fee.evidenceId) || !isObject(context) || !Array.isArray(evidencePacks) || !isoDateTime(asOf))
    rejectCommission("B_COMMISSION_INPUT_INVALID");
  const matches = evidencePacks.filter(pack => pack?.id === fee.evidenceId);
  if (matches.length === 0) rejectCommission("B_COMMISSION_EVIDENCE_MISSING");
  if (matches.length !== 1) rejectCommission("B_COMMISSION_EVIDENCE_AMBIGUOUS");
  const pack = matches[0];
  if (pack.kind !== "commission" || !isObject(pack.scope) ||
      ["platform", "store", "category", "salesScheme"].some(key => pack.scope[key] !== context[key]) ||
      !sameStoreRef(pack.scope.storeRef, context.storeRef) || pack.evidenceData?.commissionRate !== fee.commissionRate ||
      pack.evidenceData?.commissionEvidenceMode !== fee.commissionEvidenceMode ||
      !isDeepStrictEqual(pack.commissionCatalogRef ?? null, fee.commissionCatalogRef ?? null)) rejectCommission("B_COMMISSION_SOURCE_CONFLICT");
  const validity = inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs, asOf });
  if (!validity.available) rejectCommission(`B_COMMISSION_CATALOG_${validity.status.toUpperCase()}`);
}


/** Read-only preparation: never calculates profit, creates C1, or reads a provider. */
export function prepareSavedConditionalBExactInputs({ candidate, evidencePacks, currentCommissionCatalogs = [], otherCosts, processedAt }) {
  if (!isObject(candidate) || !nonEmptyString(candidate.id) || !Number.isSafeInteger(candidate.dataRevision) ||
      !Array.isArray(evidencePacks) || !isoDateTime(processedAt)) rejectB("B_EXACT_RECALCULATION_INPUT_INVALID");
  const lifecycle = candidate.lifecycleV11, runtime = candidate.executionRuntime;
  const failure = runtime?.technicalFailure, sku = lifecycle?.skuPackage;
  if (lifecycle?.status !== "b_conditional_awaiting_exact_commission" || runtime?.businessPhase !== "B" ||
      failure?.status !== "stopped" || failure.kind !== "external_dependency" || failure.errorCode !== "B_EXACT_COMMISSION_REQUIRED" ||
      failure.failureLayer !== "b_commission_evidence" || failure.sourceRevision !== candidate.dataRevision ||
      runtime.status !== "blocked" || runtime.executorType !== "software" || failure.schemaVersion !== "technical-failure-record-v1" || runtime.stepId !== "B_DETERMINISTIC_PROFIT" ||
      runtime.outputRevision !== candidate.dataRevision || runtime.inputRevision !== candidate.dataRevision - 1 ||
      runtime.dataRevision > runtime.inputRevision || failure.candidateId !== candidate.id || failure.businessPhase !== "B" ||
      failure.stepId !== "B_DETERMINISTIC_PROFIT" || failure.softwareJobId !== null ||
      failure.automaticRetryAllowed !== false || failure.businessStateChanged !== false ||
      !isoDateTime(failure.stoppedAt) || Date.parse(processedAt) < Date.parse(failure.stoppedAt) ||
      runtime.candidateId !== candidate.id || runtime.exceptionCase?.status === "open" ||
      !Array.isArray(lifecycle.c1Handoffs) || lifecycle.c1Handoffs.length !== 0 || sku?.businessPhase !== "B" ||
      sku.c1ProductPlan || sku.productionAuthorization || sku.productionRecord || sku.dSoftwareExecution || sku.dHandoff ||
      lifecycle.c1AiDraftRequestV1 || lifecycle.c1AiDraftSoftwareJobRef) rejectB("B_EXACT_RECALCULATION_NOT_AVAILABLE");
  const opportunity = lifecycle.opportunityPackage, receipt = lifecycle.aConfirmationReceipt;
  const supply = sku.selectedSupplySnapshot, supplier = supply?.supplierSku;
  const priorBundle = lifecycle.bSystemEvidenceBundle;
  const active = sku.profitModels?.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
  if (!validateLifecyclePackage(opportunity).valid || !validateLifecyclePackage(sku).valid ||
      !active || !validateProfitModel(active).valid || active.calculationType !== "conditional" || active.commissionMode !== "estimated" ||
      lifecycle.ownerSupplyConfirmation?.status !== "confirmed" ||
      !isDeepStrictEqual(lifecycle.ownerSupplyConfirmation, supply?.ownerSupplyConfirmation) ||
      receipt?.decision !== "confirm" || !Number.isSafeInteger(receipt.sourceCandidateRevision) ||
      receipt.sourceCandidateRevision >= candidate.dataRevision || !nonEmptyString(receipt.receiptId) ||
      sku.g1Identity?.candidateId !== candidate.id || !sameStoreRef(sku.g1Identity?.storeRef, candidate.storeRef) ||
      sku.parentOpportunityId !== opportunity.parentOpportunityId ||
      supply.sourceOpportunityRevision !== opportunity.dataRevision || supplier.supplierSkuId !== sku.supplierSkuId ||
      supplier.variantKey !== sku.variantKey) rejectB("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
  const confirmation = lifecycle.ownerSupplyConfirmation;
  const sourceOption = opportunity.supplierOptions.find(item => item.supplierOptionId === confirmation.supplierOptionId);
  const sourceSupplier = sourceOption?.supplierSkus?.find(item => item.supplierSkuId === sku.supplierSkuId);
  if (opportunity.confirmedSupplierOptionId !== confirmation.supplierOptionId ||
      confirmation.parentOpportunityId !== opportunity.parentOpportunityId || confirmation.sourceOpportunityRevision !== opportunity.dataRevision ||
      confirmation.supplierSkuId !== sku.supplierSkuId || confirmation.variantKey !== sku.variantKey ||
      supply.sourceOpportunityId !== opportunity.parentOpportunityId ||
      !isDeepStrictEqual(sourceOption, supply.supplierOption) || !isDeepStrictEqual(sourceSupplier, supplier) ||
      !isDeepStrictEqual(active, sku.profitModels.at(-1)) || Date.parse(processedAt) < Date.parse(active.calculatedAt)) {
    rejectB("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
  }
  if (!validateLifecycleBInputBundle(priorBundle).valid) rejectB("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
  const packaging = priorBundle.packagingSnapshot;
  const normalizedSubmission = { supplierConfirmation: { weightKg: packaging?.weightKg, dimensionsCm: packaging?.dimensionsCm } };
  if (!validateLifecycleBInputBundle(priorBundle, {
    candidate: { ...candidate, dataRevision: receipt.sourceCandidateRevision }, normalizedSubmission
  }).valid || supplier.weight?.unit !== "kg" || supplier.weight.value !== packaging.weightKg ||
      supplier.dimensions?.unit !== "cm" || !isDeepStrictEqual(
        { length: supplier.dimensions.length, width: supplier.dimensions.width, height: supplier.dimensions.height }, packaging.dimensionsCm) ||
      !isDeepStrictEqual(failure.evidenceRefs, [priorBundle.platformFeeEvidence.evidenceId]) ||
      !active.inputSnapshotRefs.includes(priorBundle.platformFeeEvidence.evidenceId) ||
      !active.inputSnapshotRefs.includes(supply.snapshotId)) rejectB("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
  const salesSnapshotId = active.inputSnapshotRefs[0];
  if (!isDeepStrictEqual(active.inputSnapshotRefs, [salesSnapshotId, supply.snapshotId,
    priorBundle.platformFeeEvidence.evidenceId, priorBundle.logisticsEvidence.evidenceId, priorBundle.exchangeRateEvidence.evidenceId])) {
    rejectB("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
  }
  if (!sku.inheritedSalesSnapshotRefs.includes(salesSnapshotId) || !opportunity.salesSnapshots.some(item => item.snapshotId === salesSnapshotId)) {
    rejectB("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
  }
  if (!inspectLifecycleBInputReadiness({ candidate, evidencePacks, currentCommissionCatalogs, asOf: processedAt }).ready) rejectB("B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE");
  const evidence = createLifecycleBInputBundle({ candidate, evidencePacks, currentCommissionCatalogs, otherCosts, normalizedSubmission, createdAt: processedAt });
  // 复算的本意是「拿比主人签下的估算更好的证据，把那一次条件测算换掉」。比估算更好的证据有两种：
  // 店里同类目在售商品的实收费率（exact），和主人保存的那一版Ozon官方费率表命中的费率（official_reference）。
  // 两种都能形成正式B（lib/profit-model.mjs 里 conditional 只认 estimated），所以两种都放进来。
  //
  // 读取顺序没有被这里放宽：createLifecycleBInputBundle 仍然按 COMMISSION_EVIDENCE_STRENGTH 先挑 exact，
  // 店里读得到实收就轮不到官方费表——这一行只决定「读回来的是什么就接不接」，不决定「先读谁」。
  //
  // estimated 仍然拒绝：用估算复算等于把主人已经签过的同一个数原样再签一次，换不出正式B，只会白走一遍。
  // 正式 B 通过不授予生产权限；生产确认仍须校验同 SKU 冻结成本、原价格、当前适用证据及主人授权。
  if (!["exact", "official_reference"].includes(evidence.platformFeeEvidence.commissionEvidenceMode)) {
    rejectB("B_EXACT_RECALCULATION_EXACT_EVIDENCE_REQUIRED");
  }
  return deepFreeze({ opportunityPackage: structuredClone(opportunity), skuPackage: structuredClone(sku),
    salesSelection: { salesSnapshotId }, evidence, priorTechnicalFailure: structuredClone(failure) });
}

export function runSavedConditionalBWithExactEvidence(input) {
  const prepared = prepareSavedConditionalBExactInputs(input);
  return deepFreeze({ ...calculateBAndCreateC1({ opportunity: prepared.opportunityPackage,
    skuPackage: prepared.skuPackage, salesSelection: prepared.salesSelection,
    evidence: prepared.evidence, processedAt: input.processedAt }),
    systemEvidenceBundle: prepared.evidence, priorTechnicalFailure: prepared.priorTechnicalFailure });
}
