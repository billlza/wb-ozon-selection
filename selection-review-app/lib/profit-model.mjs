import {
  CURRENT_PROFIT_THRESHOLD_VERSION,
  MINIMUM_PROFIT_MARGIN,
  MINIMUM_UNIT_PROFIT_RMB,
  appendProfitModelVersion,
  assertValidLifecyclePackage,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { isDeepStrictEqual } from "node:util";
import { PROFIT_THRESHOLD_POLICIES, validateProfitThresholds } from "./profit-threshold-policy.mjs";
import { resolveBMarketPrice } from "./market-sample-policy.mjs";
import { validateOwnerSupplyConfirmation } from "./supplier-selection-flow.mjs";
import { PROFIT_CALCULATION_VERSION, FORMAL_COMMISSION_CALCULATION_VERSION, validateProfitCalculation } from "./profit-model-calculation.mjs";
import {
  GLOBAL_DAMAGE_LOSS_RESERVE_RATE,
  GLOBAL_LABEL_FEE_PER_ORDER_CNY,
  GLOBAL_PRICING_POLICY_VERSION,
  GLOBAL_WITHDRAWAL_FEE_RATE,
  calculateProjectSourceMarketFit,
  resolveLifecycleBCostPolicy,
} from "./global-pricing-policy.mjs";

export const PROFIT_MODEL_SCHEMA_VERSION = "profit-model-v1.1";
export const PROFIT_THRESHOLD_VERSION = CURRENT_PROFIT_THRESHOLD_VERSION;

function thresholdPassed(unitProfitRmb, profitMargin, policy) {
  if (policy.logic === "all") {
    return unitProfitRmb >= policy.minimumUnitProfitRmb && profitMargin >= policy.minimumProfitMargin;
  }
  return unitProfitRmb >= policy.minimumUnitProfitRmb || profitMargin >= policy.minimumProfitMargin;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function finite(value) {
  return Number.isFinite(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`B_INPUT_GAP: 缺少${label}`);
  return value;
}

function requireString(value, label) {
  if (!nonEmptyString(value) || value === "unknown") throw new Error(`B_INPUT_GAP: 缺少${label}`);
  return value;
}

function requireNumber(value, label, { positive = false, nonNegative = false } = {}) {
  if (!finite(value)) throw new Error(`B_INPUT_GAP: 缺少${label}`);
  if (positive && value <= 0) throw new Error(`B_INPUT_GAP: ${label}必须大于0`);
  if (nonNegative && value < 0) throw new Error(`B_INPUT_GAP: ${label}不得小于0`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundRate(value) {
  return Number(value.toFixed(4));
}

function nextProfitVersion(skuPackage) {
  const last = skuPackage.profitModels.at(-1)?.profitModelVersion;
  const match = /^profit-v([1-9]\d*)$/.exec(String(last || ""));
  return `profit-v${match ? Number(match[1]) + 1 : 1}`;
}

function validateMoneyObject(value, path, errors) {
  if (!isObject(value)) {
    errors.push({ path, message: "必须是金额对象" });
    return;
  }
  if (!finite(value.amount) || value.amount < 0) errors.push({ path: `${path}.amount`, message: "必须是非负数字" });
  if (!nonEmptyString(value.currency)) errors.push({ path: `${path}.currency`, message: "必须有币种" });
  if (!nonEmptyString(value.evidenceRef)) errors.push({ path: `${path}.evidenceRef`, message: "必须有证据引用" });
}

export function validateProfitModel(model) {
  const errors = [];
  const requiredNumbers = [
    "recommendedSalePriceRub",
    "recommendedSalePriceCny",
    "commissionRate",
    "unitProfitRmb",
    "profitMargin"
  ];
  if (!isObject(model)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (model.schemaVersion !== PROFIT_MODEL_SCHEMA_VERSION) errors.push({ path: "schemaVersion", message: `必须是${PROFIT_MODEL_SCHEMA_VERSION}` });
  if (!/^profit-v[1-9]\d*$/.test(String(model.profitModelVersion || ""))) errors.push({ path: "profitModelVersion", message: "必须使用profit-vN" });
  if (!isoDateTime(model.calculatedAt)) errors.push({ path: "calculatedAt", message: "必须是有效时间" });
  if (!Array.isArray(model.inputSnapshotRefs) || model.inputSnapshotRefs.length !== 5 || model.inputSnapshotRefs.some((item) => !nonEmptyString(item))) {
    errors.push({ path: "inputSnapshotRefs", message: "必须恰好引用五类输入证据" });
  }
  for (const field of requiredNumbers) {
    if (!finite(model[field])) errors.push({ path: field, message: "必须是有限数字" });
  }
  if (finite(model.recommendedSalePriceRub) && model.recommendedSalePriceRub <= 0) errors.push({ path: "recommendedSalePriceRub", message: "必须大于0" });
  if (finite(model.recommendedSalePriceCny) && model.recommendedSalePriceCny <= 0) errors.push({ path: "recommendedSalePriceCny", message: "必须大于0" });
  if (finite(model.commissionRate) && (model.commissionRate < 0 || model.commissionRate >= 1)) errors.push({ path: "commissionRate", message: "必须在0到1之间" });
  if (model.commissionMode !== undefined && !["exact", "estimated", "official_reference"].includes(model.commissionMode)) {
    errors.push({ path: "commissionMode", message: "必须明确为exact、estimated或official_reference" });
  }
  if (![FORMAL_COMMISSION_CALCULATION_VERSION, PROFIT_CALCULATION_VERSION].includes(model.calculation?.version) && model.commissionMode === "estimated" && model.exactCommissionRequiredAtC !== true) {
    errors.push({ path: "exactCommissionRequiredAtC", message: "估算佣金必须在C阶段补取精确佣金" });
  }
  validateMoneyObject(model.sellerSettlementRevenue, "sellerSettlementRevenue", errors);
  validateMoneyObject(model.internationalFreight, "internationalFreight", errors);
  validateMoneyObject(model.actualPurchaseCost, "actualPurchaseCost", errors);
  validateMoneyObject(model.otherCosts, "otherCosts", errors);
  if (model.priceConversion !== undefined) {
    if (!isObject(model.priceConversion) || !finite(model.priceConversion.rubPerCny) || model.priceConversion.rubPerCny <= 0 ||
        !nonEmptyString(model.priceConversion.evidenceRef) || !isoDateTime(model.priceConversion.checkedAt)) {
      errors.push({ path: "priceConversion", message: "必须保存有效汇率、证据引用和核验时间" });
    }
  }
  if (model.pricingPolicyVersion !== undefined) {
    if (model.calculation?.version !== PROFIT_CALCULATION_VERSION && model.pricingPolicyVersion !== GLOBAL_PRICING_POLICY_VERSION) errors.push({ path: "pricingPolicyVersion", message: "必须使用当前全局定价政策" });
    if (model.pricingMode !== "source-market-fit") errors.push({ path: "pricingMode", message: "选品B阶段必须使用source-market-fit" });
    if (!isObject(model.priceFloors) || !finite(model.priceFloors.breakEvenPriceCny) || !finite(model.priceFloors.marginFloorCny) ||
        !finite(model.priceFloors.minimumProfitFloorCny) || !finite(model.priceFloors.qualifyingFloorCny) ||
        model.priceFloors.qualifyingLogic !== "any" || !finite(model.priceFloors.priceIncrementCny)) {
      errors.push({ path: "priceFloors", message: "必须保存完整价格线和项目OR门槛" });
    }
    if (!isObject(model.marketFit) || !nonEmptyString(model.marketFit.status) || !finite(model.marketFit.marketReferencePriceCny) ||
        !finite(model.marketFit.qualifyingFloorCny) || !finite(model.marketFit.headroomCny) || model.marketFit.comparableCountIsHardGate !== false) {
      errors.push({ path: "marketFit", message: "必须保存市场价格与成本价格线比较，竞品数量不得成为硬门槛" });
    }
    const components = model.otherCosts?.components;
    if (model.calculation?.version !== PROFIT_CALCULATION_VERSION && (!isObject(components) || components.labelRmb !== GLOBAL_LABEL_FEE_PER_ORDER_CNY ||
        components.damageReserveRate !== GLOBAL_DAMAGE_LOSS_RESERVE_RATE ||
        components.withdrawalFeeRate !== GLOBAL_WITHDRAWAL_FEE_RATE)) {
      errors.push({ path: "otherCosts.components", message: "全局贴单、破损丢失和提现费必须各计一次" });
    }
  }
  const thresholdPolicy = PROFIT_THRESHOLD_POLICIES[model.thresholdVersion];
  errors.push(...validateProfitThresholds(model));
  if (!Array.isArray(model.externalAccesses) || model.externalAccesses.length !== 0) errors.push({ path: "externalAccesses", message: "B阶段不得访问外部平台" });
  if (!Array.isArray(model.requestedExistingFields) || model.requestedExistingFields.length !== 0) errors.push({ path: "requestedExistingFields", message: "不得重新询问已有字段" });
  if (!nonEmptyString(model.marketAssessmentRef)) errors.push({ path: "marketAssessmentRef", message: "必须引用A阶段市场评估" });
  if (!Array.isArray(model.marketSampleRefs) || model.marketSampleRefs.length === 0 || model.marketSampleRefs.some((item) => !nonEmptyString(item))) {
    errors.push({ path: "marketSampleRefs", message: "必须保留A阶段主要价格样本引用" });
  }
  if (Object.hasOwn(model, "calculation")) {
    errors.push(...validateProfitCalculation(model));
  } else if (finite(model.unitProfitRmb) && finite(model.recommendedSalePriceCny) && finite(model.profitMargin)) {
    const expected = roundRate(model.unitProfitRmb / model.recommendedSalePriceCny);
    if (Math.abs(model.profitMargin - expected) > 0.0001) errors.push({ path: "profitMargin", message: "必须等于单件利润除以建议成交价人民币" });
    const passed = thresholdPolicy ? thresholdPassed(model.unitProfitRmb, model.profitMargin, thresholdPolicy) : false;
    if (model.result !== (passed ? "passed" : "rejected")) errors.push({ path: "result", message: "结果与统一利润门槛不一致" });
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidProfitModel(model) {
  const result = validateProfitModel(model);
  if (!result.valid) throw new Error(`ProfitModel校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return model;
}

/**
 * 第7阶段B利润计算器：只消费五类上游证据对象，不发起任何外部访问。
 */
export function runSkuProfitModel({
  opportunityPackage,
  skuPackage,
  salesSelection,
  platformFeeEvidence,
  logisticsEvidence,
  exchangeRateEvidence,
  calculatedAt,
  supplySourceOpportunity = null
}) {
  if (!validateOpportunityPackage(opportunityPackage).valid) throw new Error("B_INPUT_GAP: OpportunityPackage校验失败");
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "B") throw new Error("B_INPUT_GAP: 当前SKU不在B阶段");
  if (skuPackage.parentOpportunityId !== opportunityPackage.parentOpportunityId) throw new Error("B_INPUT_GAP: SKU与销售快照不属于同一商品方向");
  const supplyOpportunity = supplySourceOpportunity ?? opportunityPackage;
  if (supplySourceOpportunity !== null) {
    const frozen = skuPackage.selectedSupplySnapshot;
    const confirmation = frozen?.ownerSupplyConfirmation;
    const options = supplySourceOpportunity.supplierOptions?.filter(option => option.supplierOptionId === skuPackage.supplierOptionId);
    const sourceSkus = options?.length === 1 ? options[0].supplierSkus.filter(sku => sku.supplierSkuId === skuPackage.supplierSkuId) : [];
    if (!validateOwnerSupplyConfirmation(confirmation).valid || confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner" ||
        confirmation.parentOpportunityId !== skuPackage.parentOpportunityId || confirmation.supplierOptionId !== skuPackage.supplierOptionId ||
        confirmation.supplierSkuId !== skuPackage.supplierSkuId || confirmation.variantKey !== skuPackage.variantKey ||
        supplySourceOpportunity.confirmedSupplierOptionId !== confirmation.supplierOptionId ||
        sourceSkus.length !== 1 || !isDeepStrictEqual(sourceSkus[0], frozen.supplierSku)) {
      throw new Error("B_INPUT_GAP: 最终定价复核的原供货确认身份不一致");
    }
  }
  if (supplySourceOpportunity !== null && (!validateOpportunityPackage(supplySourceOpportunity).valid ||
      supplySourceOpportunity.parentOpportunityId !== opportunityPackage.parentOpportunityId ||
      supplySourceOpportunity.targetPlatform !== opportunityPackage.targetPlatform || supplySourceOpportunity.targetStore !== opportunityPackage.targetStore ||
      supplySourceOpportunity.dataRevision >= opportunityPackage.dataRevision ||
      !isDeepStrictEqual(supplySourceOpportunity.supplierOptions, opportunityPackage.supplierOptions) ||
      supplySourceOpportunity.confirmedSupplierOptionId !== opportunityPackage.confirmedSupplierOptionId ||
      skuPackage.selectedSupplySnapshot?.ownerSupplyConfirmation?.sourceOpportunityRevision !== supplySourceOpportunity.dataRevision)) {
    throw new Error("B_INPUT_GAP: 市场复核不得改变已冻结供货确认");
  }
  if (skuPackage.selectedSupplySnapshot?.sourceOpportunityRevision !== supplyOpportunity.dataRevision) throw new Error("B_INPUT_GAP: 供应SKU快照不是当前OpportunityPackage版本");

  const selection = requireObject(salesSelection, "A销售端快照选择");
  const salesSnapshotId = requireString(selection.salesSnapshotId, "销售快照ID");
  const resolvedMarket = resolveBMarketPrice(opportunityPackage, salesSnapshotId);
  const salesSnapshot = resolvedMarket.snapshot;
  if (!salesSnapshot || !skuPackage.inheritedSalesSnapshotRefs.includes(salesSnapshotId)) throw new Error("B_INPUT_GAP: SKU未继承所选销售快照");
  const recommendedSalePriceRub = requireNumber(
    resolvedMarket.recommendedSalePrice.amount,
    "A销售建议价格",
    { positive: true }
  );
  if (resolvedMarket.recommendedSalePrice.currency !== "RUB") throw new Error("B_INPUT_GAP: 当前测试销售价格必须为RUB");

  const supplySnapshot = requireObject(skuPackage.selectedSupplySnapshot, "主人确认供应SKU快照");
  const supplySku = requireObject(supplySnapshot.supplierSku, "主人确认供应SKU");
  if (supplySku.supplierSkuId !== skuPackage.supplierSkuId || supplySku.variantKey !== skuPackage.variantKey) throw new Error("B_INPUT_GAP: 供应SKU身份与生命周期包不一致");
  const actualPurchaseCostAmount = requireNumber(supplySku.actualPurchaseCost, "实际采购到手成本", { nonNegative: true });

  const fees = requireObject(platformFeeEvidence, "平台费用证据");
  const feeEvidenceId = requireString(fees.evidenceId, "平台费用证据ID");
  const commissionRate = requireNumber(fees.commissionRate, "平台佣金率", { nonNegative: true });
  if (commissionRate >= 1) throw new Error("B_INPUT_GAP: 平台佣金率必须小于100%");
  const commissionMode = fees.commissionEvidenceMode;
  // official_reference是主人已保存的官方费表版本命中的费率：与exact一样直接进入正式计算。
  if (!["exact", "estimated", "official_reference"].includes(commissionMode)) {
    throw new Error("B_INPUT_GAP: 佣金证据必须明确为exact、estimated或official_reference");
  }
  if (commissionMode === "estimated" && fees.estimateAuthorized !== true) {
    throw new Error("B_INPUT_GAP: 估算佣金缺少当前SKU主人授权");
  }
  const other = requireObject(fees.otherCosts, "其他成本证据");
  const packagingRmb = requireNumber(other.packagingRmb, "包装成本", { nonNegative: true });
  const labelRmb = requireNumber(other.labelRmb, "贴标成本", { nonNegative: true });
  const fixedOtherRmb = requireNumber(other.fixedOtherRmb, "其他固定成本", { nonNegative: true });
  const advertisingRate = requireNumber(other.advertisingRate, "广告成本率", { nonNegative: true });
  const returnReserveRate = requireNumber(other.returnReserveRate, "退货预留率", { nonNegative: true });
  const damageReserveRate = requireNumber(other.damageReserveRate, "破损预留率", { nonNegative: true });
  const withdrawalFeeRate = requireNumber(other.withdrawalFeeRate, "提现费率", { nonNegative: true });
  const targetMarginRate = requireNumber(other.targetMarginRate, "目标利润率", { nonNegative: true });
  const minimumUnitProfitRmb = requireNumber(other.minimumUnitProfitRmb, "最低单件利润", { nonNegative: true });
  const priceIncrementCny = requireNumber(other.priceIncrementCny, "售价步进", { positive: true });
  if (other.thresholdLogic !== "any") throw new Error("B_INPUT_GAP: 当前项目利润门槛必须为满足任一项");
  const costPolicyContext = requireObject(fees.costPolicyContext, "成本政策适用范围");
  if (costPolicyContext.platform !== skuPackage.targetPlatform || costPolicyContext.store !== skuPackage.targetStore ||
      !isDeepStrictEqual(costPolicyContext.storeRef, skuPackage.g1Identity.storeRef)) {
    throw new Error("B_INPUT_GAP: 成本政策范围与当前SKU不一致");
  }
  const costPolicySnapshot = requireObject(fees.costPolicySnapshot, "完整成本政策快照");
  const resolvedCostPolicy = resolveLifecycleBCostPolicy({ snapshot: costPolicySnapshot, context: costPolicyContext, asOf: calculatedAt });
  for (const [key, value] of Object.entries(resolvedCostPolicy)) {
    if (!["policyId", "policyVersion"].includes(key) && other[key] !== value) throw new Error(`B_INPUT_GAP: 成本政策与费用数值不一致: ${key}`);
  }
  if (other.pricingPolicyVersion !== resolvedCostPolicy.policyVersion) throw new Error("B_INPUT_GAP: 成本政策版本不一致");
  if (targetMarginRate !== MINIMUM_PROFIT_MARGIN || minimumUnitProfitRmb !== MINIMUM_UNIT_PROFIT_RMB) {
    throw new Error("B_INPUT_GAP: 项目利润门槛与当前配置不一致");
  }

  const logistics = requireObject(logisticsEvidence, "国际物流证据");
  const logisticsEvidenceId = requireString(logistics.evidenceId, "国际物流证据ID");
  const internationalFreightAmount = requireNumber(logistics.amountRmb, "国际运费", { nonNegative: true });

  const fx = requireObject(exchangeRateEvidence, "汇率证据");
  const exchangeEvidenceId = requireString(fx.evidenceId, "汇率证据ID");
  const rubPerCny = requireNumber(fx.rubPerCny, "RUB/CNY汇率", { positive: true });
  const inputSnapshotRefs = [
    salesSnapshotId,
    supplySnapshot.snapshotId,
    feeEvidenceId,
    logisticsEvidenceId,
    exchangeEvidenceId
  ];
  const calculationTime = requireString(calculatedAt, "利润计算时间");
  const existing = skuPackage.profitModels.find((item) =>
    item.calculation?.version === PROFIT_CALCULATION_VERSION &&
    item.marketAssessmentRef === resolvedMarket.assessment.assessmentId &&
    item.calculatedAt === calculationTime && JSON.stringify(item.inputSnapshotRefs) === JSON.stringify(inputSnapshotRefs)
  );
  const rawPriceCny = recommendedSalePriceRub / rubPerCny;
  const recommendedSalePriceCny = roundMoney(rawPriceCny);
  const pricing = calculateProjectSourceMarketFit({
    resolvedCostPolicy,
    marketReferencePriceCny: rawPriceCny,
    actualPurchaseCostCny: actualPurchaseCostAmount,
    packagingCostCny: packagingRmb,
    internationalFreightPerOrderCny: internationalFreightAmount,
    fixedOtherCostCny: fixedOtherRmb,
    commissionRate,
    advertisingRate,
    returnOperationsRate: returnReserveRate,
    targetMarginRate,
    minimumUnitProfitCny: minimumUnitProfitRmb,
    priceIncrementCny,
    quantity: 1,
    marketSampleCount: resolvedMarket.assessment.primarySampleIds.length,
  });
  const settlementAmount = roundMoney(rawPriceCny * (1 - commissionRate));
  const variableOtherCosts = rawPriceCny * Object.entries(pricing.variableRates).filter(([key]) => key !== "commission").reduce((sum, [, value]) => sum + value, 0);
  const totalOtherCosts = roundMoney(packagingRmb + labelRmb + fixedOtherRmb + variableOtherCosts);
  const rawUnitProfitRmb = pricing.evaluatedAtMarketPrice.unroundedUnitProfitCny;
  const unitProfitRmb = roundMoney(rawUnitProfitRmb);
  const profitMargin = roundRate(rawUnitProfitRmb / rawPriceCny);
  const conditional = commissionMode === "estimated";
  const result = conditional ? "manual_review" : pricing.evaluatedAtMarketPrice.thresholdPassed ? "passed" : "rejected";

  const model = {
    schemaVersion: PROFIT_MODEL_SCHEMA_VERSION,
    profitModelVersion: nextProfitVersion(skuPackage),
    calculatedAt: calculationTime,
    inputSnapshotRefs,
    marketAssessmentRef: resolvedMarket.assessment.assessmentId,
    marketSampleRefs: structuredClone(resolvedMarket.assessment.primarySampleIds),
    marketSellerTypesUsed: structuredClone(resolvedMarket.assessment.sellerTypesUsed),
    marketConfidence: resolvedMarket.assessment.confidence,
    containsLocalRuBackground: resolvedMarket.assessment.containsLocalRuBackground,
    pricingPolicyVersion: pricing.pricingPolicyVersion,
    pricingMode: pricing.pricingMode,
    recommendedSalePriceRub,
    recommendedSalePriceCny,
    calculation: {
      version: PROFIT_CALCULATION_VERSION,
      recommendedSalePriceCny: rawPriceCny,
      unitProfitRmb: rawUnitProfitRmb
    },
    priceFloors: structuredClone(pricing.priceFloors),
    marketFit: structuredClone(pricing.marketFit),
    costScope: {
      quantity: pricing.quantity,
      fixedCosts: structuredClone(pricing.fixedCosts),
      variableRates: structuredClone(pricing.variableRates),
      orderFixedCostCny: pricing.orderFixedCostCny,
      equivalentFixedCostPerUnitCny: pricing.equivalentFixedCostPerUnitCny,
      totalVariableRate: pricing.totalVariableRate,
      logisticsQuoteBasis: "per_order",
    },
    priceConversion: {
      rubPerCny,
      evidenceRef: exchangeEvidenceId,
      checkedAt: calculatedAt
    },
    sellerSettlementRevenue: {
      amount: settlementAmount,
      currency: "CNY",
      evidenceRef: feeEvidenceId,
      formula: "recommendedSalePriceCny × (1 - commissionRate)"
    },
    commissionRate,
    commissionMode,
    calculationType: conditional ? "conditional" : "formal",
    exactCommissionRequiredForFormalB: conditional,
    internationalFreight: {
      amount: internationalFreightAmount,
      currency: "CNY",
      evidenceRef: logisticsEvidenceId,
      route: logistics.route
    },
    actualPurchaseCost: {
      amount: actualPurchaseCostAmount,
      currency: "CNY",
      evidenceRef: supplySnapshot.snapshotId
    },
    otherCosts: {
      costPolicySnapshot: structuredClone(costPolicySnapshot),
      costPolicyContext: structuredClone(costPolicyContext),
      amount: totalOtherCosts,
      currency: "CNY",
      evidenceRef: feeEvidenceId,
      components: {
        packagingRmb,
        labelRmb,
        fixedOtherRmb,
        advertisingRate,
        returnReserveRate,
        damageReserveRate,
        withdrawalFeeRate,
        acquiringRate: resolvedCostPolicy.acquiringRate,
        taxRate: resolvedCostPolicy.taxRate,
        otherRate: resolvedCostPolicy.otherRate
      }
    },
    unitProfitRmb,
    profitMargin,
    thresholdVersion: PROFIT_THRESHOLD_VERSION,
    thresholds: {
      minimumProfitMargin: MINIMUM_PROFIT_MARGIN,
      minimumUnitProfitRmb: MINIMUM_UNIT_PROFIT_RMB,
      logic: "any"
    },
    result,
    executionMode: "five_upstream_evidence_sources_only",
    externalAccesses: [],
    requestedExistingFields: [],
    formula: "先按采购到手成本、包材、整单国际物流、每单贴单费和全部收入费率反推价格线；项目合格底线取15%利润率线与20元利润线的较低者（满足任一项）；再用A阶段市场目标价计算实际利润并比较市场余量。"
  };
  assertValidProfitModel(model);

  if (existing) {
    assertValidProfitModel(existing);
    if (existing.profitModelVersion !== skuPackage.activeProfitModelVersion ||
        !isDeepStrictEqual(existing, { ...model, profitModelVersion: existing.profitModelVersion })) {
      throw new Error("PROFIT_REPLAY_CONFLICT: 相同计算标识的冻结输入已变化，或该结果不是当前生效版本");
    }
    return deepFreeze({
      flowVersion: "sku-profit-flow-v1.1",
      skuPackage: structuredClone(skuPackage),
      profitModel: structuredClone(existing),
      idempotentReplay: true
    });
  }

  const previousModels = structuredClone(skuPackage.profitModels);
  const next = appendProfitModelVersion(skuPackage, model);
  if (JSON.stringify(previousModels) !== JSON.stringify(next.profitModels.slice(0, previousModels.length))) {
    throw new Error("PROFIT_HISTORY_PROTECTED: 历史利润版本发生变化");
  }
  const completed = structuredClone(next);
  completed.businessPhase = "B";
  completed.businessResult = result;
  completed.technicalStatus = "completed";
  completed.ownerAction = conditional ? "review_business_exception" : "none";
  completed.audit.history.push({
    event: "b_profit_model_completed_from_five_upstream_sources",
    at: calculatedAt,
    profitModelVersion: model.profitModelVersion,
    inputSnapshotRefs: structuredClone(model.inputSnapshotRefs),
    nextPhaseStarted: false
  });
  assertValidLifecyclePackage(completed);
  return deepFreeze({
    flowVersion: "sku-profit-flow-v1.1",
    skuPackage: completed,
    profitModel: completed.profitModels.at(-1),
    idempotentReplay: false
  });
}
