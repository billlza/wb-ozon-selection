import { createC1ProductPlan, verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { resolveC1SkuRightsReviewForFacts } from "./c1-sku-rights-review.mjs";
import { createC1SeoDraft } from "./c1-seo-draft.mjs";
import { confirmFinalUploads, createC2AssetLifecycle } from "./c2-asset-lifecycle.mjs";
import { createFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 通用C1入口：只消费A/B已经冻结的数据和显式传入的平台Schema、文本及关键词证据。
 * 本函数不访问销售端或供应端，不重新算利润，也不替换SKU；完成后初始化空的C2素材区。
 */
export function completeC1AndStartC2({
  opportunityPackage,
  skuPackage,
  platformSchemaEvidence,
  competitorTextSnapshot,
  keywordEvidence,
  collectedAssets = [],
  completedAt
}) {
  const protectedProfitModels = structuredClone(skuPackage?.profitModels);
  const protectedSupplySnapshot = structuredClone(skuPackage?.selectedSupplySnapshot);
  const protectedSupplierSkuId = skuPackage?.supplierSkuId;

  let current = skuPackage;
  if (current.c1ProductPlan === null) {
    current = createC1ProductPlan({
      opportunityPackage,
      skuPackage: current,
      platformSchemaEvidence,
      createdAt: completedAt
    }).skuPackage;
  }
  if (current.c1ProductPlan?.status === "inputs_ready") {
    // 主人签过的那份权利声明必须跟着进来。不传它，事实冻结出来的计划会因为
    // 「已保存记录与冻结快照对不上」被 C1_RIGHTS_RECORD_DECLARATION_MISMATCH 判废——
    // 也就是说：只要主人签了声明，这条通用C1入口反而走不通了（2026-09-17 实测）。
    // 编排器那条路（c1-software-orchestrator）一直是先 resolve 再传，这里漏了同一步。
    // 声明本身仍然只是一次声明：它不驱动状态机，是这个显式入口来消费它。
    const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: current, observedAt: completedAt });
    current = verifyC1ProductFacts({
      skuPackage: current,
      skuRightsReview: rights.review,
      verifiedAt: completedAt
    }).skuPackage;
  }
  if (current.c1ProductPlan?.status === "facts_checked") {
    current = createC1SeoDraft({
      skuPackage: current,
      competitorTextSnapshot,
      keywordEvidence,
      createdAt: completedAt
    }).skuPackage;
  }
  if (current.c1ProductPlan?.status !== "seo_draft_ready") {
    throw new Error("C_STAGE_GATE_REJECTED: C1未能形成完整SEO草稿");
  }
  const c2 = current.c2FinalAssets === null
    ? createC2AssetLifecycle({ skuPackage: current, collectedAssets, createdAt: completedAt })
    : { skuPackage: current, c2AssetLifecycle: current.c2FinalAssets };

  if (!sameJson(protectedProfitModels, c2.skuPackage.profitModels)) {
    throw new Error("C_STAGE_PROTECTED_DATA_CHANGED: C1/C2不得改写B利润历史");
  }
  if (!sameJson(protectedSupplySnapshot, c2.skuPackage.selectedSupplySnapshot) ||
      protectedSupplierSkuId !== c2.skuPackage.supplierSkuId) {
    throw new Error("C_STAGE_PROTECTED_DATA_CHANGED: C1/C2不得替换主人确认的供应SKU");
  }
  if (c2.skuPackage.businessPhase !== "C2" || c2.c2AssetLifecycle.status !== "awaiting_final_uploads") {
    throw new Error("C_STAGE_BOUNDARY_VIOLATION: C1完成后只能进入等待最终素材的C2");
  }

  return deepFreeze({
    flowVersion: "generic-c1-to-c2-flow-v1.1",
    skuPackage: c2.skuPackage,
    c1ProductPlan: c2.skuPackage.c1ProductPlan,
    c2AssetLifecycle: c2.c2AssetLifecycle,
    externalAccesses: [],
    platformWrites: 0
  });
}

/**
 * 通用C2入口：主人确认的最终素材按原顺序进入finalUploads，并生成生产前确认卡。
 * collected与aiDrafts不会被提升为最终素材，也不会启动D。
 */
export function completeC2AndCreateConfirmationCard({
  skuPackage,
  finalUploadAssets,
  ownerDecision,
  completedAt
}) {
  const protectedC1 = structuredClone(skuPackage?.c1ProductPlan);
  const protectedProfitModels = structuredClone(skuPackage?.profitModels);
  const confirmed = confirmFinalUploads({
    skuPackage,
    finalUploadAssets,
    ownerDecision,
    confirmedAt: completedAt
  });
  const card = createFinalProductPlanConfirmationCard({
    skuPackage: confirmed.skuPackage,
    createdAt: completedAt
  });

  if (!sameJson(protectedC1, card.skuPackage.c1ProductPlan) ||
      !sameJson(protectedProfitModels, card.skuPackage.profitModels)) {
    throw new Error("C_STAGE_PROTECTED_DATA_CHANGED: C2不得改写C1事实、SEO或B利润历史");
  }
  if (card.skuPackage.businessPhase !== "C2" || card.skuPackage.productionAuthorization !== null ||
      card.skuPackage.productionRecord !== null) {
    throw new Error("C_STAGE_BOUNDARY_VIOLATION: C2确认卡不得进入D或创建生产记录");
  }

  return deepFreeze({
    flowVersion: "generic-c2-confirmation-card-flow-v1.1",
    skuPackage: card.skuPackage,
    c2AssetLifecycle: card.skuPackage.c2FinalAssets,
    confirmationCard: card.confirmationCard,
    platformWrites: 0
  });
}
