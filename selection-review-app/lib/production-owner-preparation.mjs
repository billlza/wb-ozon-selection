import { readProductionCommercialDraft } from './production-commercial-draft.mjs';
import { isDeepStrictEqual } from "node:util";
import { inspectProductionEvidenceReadiness } from "./production-evidence-readiness.mjs";
import { inspectLifecycleEvidenceValidity } from "./lifecycle-evidence-validity.mjs";
import { assertProductionProfitPriceCurrent, FinalPricingReviewError } from "./final-pricing-review.mjs";
import { C1_UNKNOWN_CLASSIFICATION_VERSION } from "./c1-product-plan.mjs";
import { isConfiguredProductionReference, isRuntimeConfigurationTimestamp, normalizeProductionBindings, normalizeStoreBindings } from "./runtime-configuration.mjs";
import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { validateLifecycleEvidenceData } from "./lifecycle-b-input-bundle.mjs";
import { evidenceScopeMatches } from "./lifecycle-evidence-scope.mjs";
import { validateProfitModel } from "./profit-model.mjs";
import { validateSkuLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { createFinalProductPlanConfirmationCard, validateFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";
import { assertAuthorizedMediaUnchanged } from "./production-authorization-preparation.mjs";
import { assertSiblingSkuFinalCard } from './sibling-sku-card-guard.mjs';
import { assertCurrentC1MatchesProductionPreparation, PRODUCTION_AUTHORIZATION_VERSION, PRODUCTION_WRITE_FIELDS,
  VALIDATION_MODERATION_PUBLISH_SCOPE } from "./production-authorization-preparation.mjs";

const SUBMISSION_FIELDS = ["contractVersion", "dataRevision", "skuRevision", "cardId", "cardRevision",
  "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "bindingId", "configurationVersion", "merchantSku", "confirmExactScope"];

export class ProductionOwnerPreparationError extends Error {
  constructor(code, message) { super(message); this.name = "ProductionOwnerPreparationError"; this.code = code; }
}

function reject(code, message) { throw new ProductionOwnerPreparationError(code, message); }
function knownEvidenceSource(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2048 &&
    !["unknown", "null", "undefined", "not_applicable"].includes(value.trim().toLowerCase());
}
function currentWindow(evidence, observedAt) {
  return isRuntimeConfigurationTimestamp(evidence.checkedAt) && isRuntimeConfigurationTimestamp(evidence.expiresAt) &&
    Date.parse(evidence.checkedAt) <= Date.parse(observedAt) && Date.parse(observedAt) < Date.parse(evidence.expiresAt);
}
function sourceOf(candidate) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const card = sku?.productionConfirmationCard;
  const preparation = sku?.c2FinalAssets?.productionAuthorizationPreparation;
  return { dataRevision: candidate.dataRevision, skuRevision: sku?.dataRevision ?? null, cardId: card?.cardId ?? null,
    cardRevision: card?.cardRevision ?? null, sourcePreparationFingerprint: preparation?.preparationFingerprint ?? null,
    sourceFinalCardInputFingerprint: preparation?.finalCardInputFingerprint ?? null };
}
function inspectFrozenSource(candidate, observedAt) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const card = sku?.productionConfirmationCard;
  if (!sku || !validateSkuLifecyclePackage(sku).valid || !card || !validateFinalProductPlanConfirmationCard(card).valid) {
    reject("PRODUCTION_FINAL_CARD_REQUIRED", "尚无有效的最终商品确认卡");
  }
  if (Date.parse(card.createdAt) > Date.parse(observedAt)) reject("PRODUCTION_PREPARATION_CLOCK_INVALID", "最终确认卡时间晚于本次服务端时间");
  if (card.riskAndUnknowns.classificationVersion !== C1_UNKNOWN_CLASSIFICATION_VERSION) {
    reject("PRODUCTION_FINAL_CARD_CLASSIFICATION_REQUIRED", "旧确认卡须按当前冻结输入重新生成，不能直接用于生产准备");
  }
  if (sku.businessPhase !== "C2" || sku.productionAuthorization !== null || sku.productionRecord !== null ||
      (sku.dHandoff !== null && sku.dHandoff !== undefined) || card.status !== "awaiting_owner_business_confirmation" || card.ownerDecision !== null) {
    reject("PRODUCTION_CURRENT_CONFIRMATION_REQUIRED", "已有授权或历史决定需保持只读，不能复用本次提交");
  }
  if (sku.g1Identity.candidateId !== candidate.id || !isCompleteStoreRef(candidate.storeRef, candidate.targetStore) ||
      !sameStoreRef(sku.g1Identity.storeRef, candidate.storeRef)) reject("PRODUCTION_STORE_SCOPE_CHANGED", "当前候选与冻结商品的店铺身份不一致");
  try { assertSiblingSkuFinalCard(candidate); }
  catch (error) {
    if (error.message === 'SIBLING_CARD_GROUPING_MISMATCH') reject('SIBLING_CARD_GROUPING_MISMATCH', '追加规格的型号、类目、类型或品牌与原商品导入不一致');
    if (error.message === 'SIBLING_MAIN_IMAGE_NOT_DISTINCT') reject('SIBLING_MAIN_IMAGE_NOT_DISTINCT', '本色主图与原商品的已确认图片重复');
    if (error.message === 'SIBLING_COLOR_BINDING_INVALID') reject('SIBLING_COLOR_BINDING_INVALID', '追加规格缺少与供应颜色对应的已确认 Ozon 字典值或实际导入属性');
    throw error;
  }
  const preparation = sku.c2FinalAssets.productionAuthorizationPreparation;
  let expectedCard;
  try {
    assertCurrentC1MatchesProductionPreparation({ preparation, candidateId: candidate.id, skuPackage: sku });
    const withoutCard = structuredClone(sku); withoutCard.productionConfirmationCard = null;
    expectedCard = createFinalProductPlanConfirmationCard({ skuPackage: withoutCard, createdAt: card.createdAt }).confirmationCard;
    if (!isDeepStrictEqual(card, expectedCard)) reject("PRODUCTION_FINAL_CARD_CHANGED", "最终商品确认卡与冻结事实不一致");
    assertAuthorizedMediaUnchanged(preparation.finalUploads, preparation.authorizedMediaFingerprint, "ownerPreparation");
  } catch (error) {
    if (error instanceof ProductionOwnerPreparationError) throw error;
    if (error.message === "PRODUCTION_AUTHORIZATION_PREPARATION_DRIFT:currentC1Snapshot") {
      reject("PRODUCTION_FROZEN_C1_CHANGED", "当前 C1 事实或平台规则与最终卡冻结输入不一致，需重新准备");
    }
    if (/^(PRODUCTION_AUTHORIZATION_PREPARATION_|C2_|FINAL_PLAN_CARD_|FINAL_PLAN_CARD_GATE_|FINAL_PLAN_CARD_INPUT_)/.test(error.message)) {
      reject("PRODUCTION_FROZEN_PREPARATION_INVALID", "冻结素材、事实或平台素材规则已失效，需重新准备");
    }
    throw error;
  }
  if (expectedCard.riskAndUnknowns.blockingUnknownCount > 0 || !["exact", "official_reference"].includes(expectedCard.profitResult.commissionMode.value)) {
    reject("PRODUCTION_FINAL_CARD_INCOMPLETE", "最终商品事实仍有缺口或正式佣金证据不完整");
  }
  const model = preparation.finalCardInputSnapshot.activeProfitModel;
  const current = sku.profitModels.filter(item => item.profitModelVersion === sku.activeProfitModelVersion);
  if (!validateProfitModel(model).valid || model.result !== "passed" || !["exact", "official_reference"].includes(model.commissionMode) || current.length !== 1 ||
      !isDeepStrictEqual(model, current[0])) reject("PRODUCTION_FROZEN_PROFIT_INVALID", "冻结 B 利润模型不完整或已漂移");
  return { sku, model };
}
function frozenPriceScope(model, evidencePacks, observedAt) {
  const conversion = model.priceConversion;
  if (!conversion || !isConfiguredProductionReference(conversion.evidenceRef) || !isRuntimeConfigurationTimestamp(conversion.checkedAt) ||
      Date.parse(conversion.checkedAt) > Date.parse(observedAt) || !model.inputSnapshotRefs.includes(conversion.evidenceRef)) {
    reject("PRODUCTION_FROZEN_FX_REQUIRED", "冻结 B 模型缺少同源汇率引用");
  }
  const matches = evidencePacks.filter(pack => pack.id === conversion.evidenceRef);
  if (matches.length !== 1) reject("PRODUCTION_FROZEN_FX_REQUIRED", "冻结 B 引用的汇率证据缺失或不唯一");
  const pack = matches[0];
  if (pack.kind !== "exchange_rate" || pack.status !== "active" || !knownEvidenceSource(pack.sourceRef) ||
      !knownEvidenceSource(pack.sourceType) || !isRuntimeConfigurationTimestamp(pack.checkedAt) || !isRuntimeConfigurationTimestamp(pack.expiresAt) ||
      !inspectLifecycleEvidenceValidity(pack, { asOf: observedAt }).usable ||
      !inspectLifecycleEvidenceValidity(pack, { asOf: conversion.checkedAt }).usable || !validateLifecycleEvidenceData("exchange_rate", pack.evidenceData).valid ||
      !evidenceScopeMatches("exchange_rate", pack.scope, { pair: "RUB/CNY" }) || pack.evidenceData.rubPerCny !== conversion.rubPerCny ||
      Number((model.recommendedSalePriceRub / conversion.rubPerCny).toFixed(2)) !== model.recommendedSalePriceCny) {
    reject("PRODUCTION_FROZEN_FX_INVALID", "冻结 B 的同源汇率证据不在有效期内或与价格不一致");
  }
  return { buyerTargetPrice: { amount: model.recommendedSalePriceRub, currency: "RUB" },
    platformWritePrice: { amount: model.recommendedSalePriceCny, currency: "CNY" }, priceConversion: structuredClone(conversion),
    stock: 100, publishScope: VALIDATION_MODERATION_PUBLISH_SCOPE, allowedWriteFields: [...PRODUCTION_WRITE_FIELDS],
    exclusions: ["no_activation", "no_advertising", "no_other_sku_write"] };
}

/** Pure local projection. Saved configuration declarations are not fresh platform observations. */
export function buildProductionOwnerPreparationView({ candidate, configuration, evidencePacks = [], currentCommissionCatalogs = [], observedAt }) {
  if (!candidate || !Number.isSafeInteger(candidate.dataRevision) || candidate.dataRevision < 0 || !isCanonicalFrozenRef(candidate.id) ||
      !isRuntimeConfigurationTimestamp(observedAt) || !Array.isArray(evidencePacks)) {
    reject("PRODUCTION_PREPARATION_INPUT_INVALID", "准备输入或服务端时间无效");
  }
  const commercialDraft = readProductionCommercialDraft(candidate);
  const storeBindings = normalizeStoreBindings(configuration.storeBindings);
  const bindings = normalizeProductionBindings(configuration.productionBindings, storeBindings);
  const matching = bindings.filter(binding => binding.platform === candidate.targetPlatform && sameStoreRef(binding.storeRef, candidate.storeRef));
  const eligible = matching.filter(binding => currentWindow(binding.verification, observedAt));
  const gaps = [];
  if (!matching.length) gaps.push({ code: "PRODUCTION_BINDING_NOT_CONFIGURED", message: "尚未配置当前店铺的生产仓库与凭据绑定" });
  else if (!eligible.length) gaps.push({ code: "PRODUCTION_BINDING_EXPIRED", message: "当前店铺的生产绑定核验声明已过期或尚未生效" });
  let scope = null;
  try {
    const { model } = inspectFrozenSource(candidate, observedAt);
    scope = frozenPriceScope(model, evidencePacks, observedAt);
    assertProductionProfitPriceCurrent({ candidate, skuPackage: candidate.lifecycleV11.skuPackage, evidencePacks, currentCommissionCatalogs, observedAt });
    if (commercialDraft) scope.stock = commercialDraft.stock;
  } catch (error) {
    if (!(error instanceof ProductionOwnerPreparationError) && !(error instanceof FinalPricingReviewError)) throw error;
    scope = null;
    gaps.push({ code: error.code, message: error.message });
  }
  return { contractVersion: PRODUCTION_AUTHORIZATION_VERSION, ready: gaps.length === 0, gaps, commercialDraft, source: sourceOf(candidate),
    evidenceReadiness: inspectProductionEvidenceReadiness({ candidate, evidencePacks, observedAt }),
    store: { displayName: matching[0]?.storeName ?? null, storeRef: isCompleteStoreRef(candidate.storeRef, candidate.targetStore) ? structuredClone(candidate.storeRef) : null },
    executionBindings: eligible.map(binding => ({ bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, warehouseName: binding.warehouseName })), scope };
}

/** Call with the transaction's current candidate AND evidencePacks; never reuse a prepared browser scope. */
export function resolveProductionOwnerPreparation({ candidate, input, configuration, evidencePacks, currentCommissionCatalogs = [], observedAt }) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== SUBMISSION_FIELDS.length ||
      SUBMISSION_FIELDS.some(field => !Object.hasOwn(input, field)) || input.contractVersion !== PRODUCTION_AUTHORIZATION_VERSION || input.confirmExactScope !== true ||
      !isConfiguredProductionReference(input.bindingId) || !isConfiguredProductionReference(input.configurationVersion) || !isConfiguredProductionReference(input.merchantSku)) {
    reject("PRODUCTION_PREPARATION_INPUT_INVALID", "提交字段、商家货号或确认范围无效");
  }
  assertNoProductionSecrets(input, "productionPreparationInput");
  const view = buildProductionOwnerPreparationView({ candidate, configuration, evidencePacks, currentCommissionCatalogs, observedAt });
  if (!Object.entries(view.source).every(([key, value]) => input[key] === value)) reject("PRODUCTION_PREPARATION_SOURCE_CHANGED", "商品、素材或确认卡已更新，请查看当前版本");
  if (view.commercialDraft && input.merchantSku !== view.commercialDraft.merchantSku) {
    reject("PRODUCTION_COMMERCIAL_DRAFT_CHANGED", "商家货号与已保存经营草案不一致，请先保存新的经营草案");
  }
  if (!view.ready) reject(view.gaps[0].code, view.gaps[0].message);
  const binding = configuration.productionBindings.find(item => item.bindingId === input.bindingId && item.configurationVersion === input.configurationVersion);
  if (!binding || !view.executionBindings.some(item => item.bindingId === input.bindingId && item.configurationVersion === input.configurationVersion)) {
    reject("PRODUCTION_BINDING_CHANGED", "仓库选择或配置版本已变化，请重新选择");
  }
  return { selectedOption: "approve_for_production_authorization", merchantSku: input.merchantSku, warehouseRef: binding.warehouseRef,
    credentialAlias: binding.credentialAlias,
    executionBinding: { bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, warehouseId: binding.warehouseId },
    ...structuredClone(view.scope) };
}
