import { adapt1688CaptureToSupplierOption } from './supplier-option.mjs';
import { readAProductDetailSupplierEvidence } from './a-product-detail-evidence.mjs';
import { currentSalesSnapshot } from "./discovery-market-snapshot.mjs";
import { sourceCaptureFailureDestinationLabel } from "./source-capture.mjs";
import { STORE_PLATFORMS, isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";

export const REAL_A_CONFIRMATION_CARD_VERSION = "real-a-confirmation-card-v1.1";

const UNKNOWN = "unknown";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function known(value) {
  return value !== null && value !== undefined && value !== "" && value !== UNKNOWN;
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined || value === UNKNOWN) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed > 0;
}

function nonNegative(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0;
}

/**
 * The current snapshot is the newest saved entry that still validates, whichever source produced it: a real page read,
 * a provider detail read, or the read-only projection of an already-saved discovery receipt. The card only requires
 * that one exists and that the owner confirms it; it never ranks the sources itself.
 */
function newestValidSalesSnapshot(candidate) {
  return currentSalesSnapshot(candidate);
}

function selectedCaptureSku(candidate) {
  const capture = candidate?.sourceCapture;
  if (!isObject(capture) || capture.status !== "verified") return null;
  const selectedIds = Array.isArray(capture.selectedSkuIds) ? capture.selectedSkuIds : [];
  const choices = Array.isArray(capture.skuChoices) ? capture.skuChoices : [];
  if (selectedIds.length !== 1) return null;
  return choices.find((choice) => String(choice.sourceSkuId) === String(selectedIds[0])) || null;
}

function exact1688Url(value) {
  return /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#].*)?$/i.test(String(value || "").trim());
}

function aSupplierInputUrl(value) {
  const input = String(value || "").trim();
  return exact1688Url(input) || /^https:\/\/qr\.1688\.com\/s\/[A-Za-z0-9_-]{1,160}\/?$/i.test(input);
}

function field(value, source, status = known(value) ? "available" : "missing") {
  return { value: known(value) ? value : null, source, status };
}

function unavailableSystemEvidence() {
  return {
    ready: false,
    contextReady: false,
    fields: [],
    missing: ["服务端尚未匹配到当前商品的B系统证据包"],
    ownerMustProvide: false
  };
}

/**
 * 只为真实候选生成一张A阶段确认卡的数据契约。
 * 不修改候选、不创建生命周期、不启动B、不派发任务。
 */
export function buildRealAConfirmationCard(candidate, options = {}) {
  if (!isObject(candidate) || !candidate.id || !Number.isInteger(candidate.dataRevision)) {
    throw new TypeError("REAL_A_CARD_INPUT_GAP: 候选身份或修订号无效");
  }
  const before = JSON.stringify(candidate);
  const apiEvidence = readAProductDetailSupplierEvidence(candidate);
  const sales = apiEvidence?.salesSnapshot ?? newestValidSalesSnapshot(candidate);
  const capturedSku = selectedCaptureSku(candidate);
  const supplierCapture = apiEvidence?.supplierCapture ?? (isObject(candidate.sourceCapture) && candidate.sourceCapture.mode === "a_supplier_capture"
    ? candidate.sourceCapture
    : null);
  const browserCapture = !apiEvidence && supplierCapture?.status === 'captured_waiting_owner_selection';
  let projectedSkus = supplierCapture?.skuChoices;
  if (browserCapture) {
    const adapted = adapt1688CaptureToSupplierOption({ ...supplierCapture, skus: supplierCapture.skuChoices },
      { evidenceRef: `source-capture:${supplierCapture.captureId}` });
    projectedSkus = supplierCapture.skuChoices.map((sku, index) => ({ ...structuredClone(sku),
      variantKey: adapted.supplierSkus[index].variantKey, minimumOrderQuantity: null }));
  }
  const legacySupply = candidate.lifecycleV11?.opportunityPackage?.supplierOptions?.[0] || null;
  const capturedUrl = apiEvidence?.sourceUrl ?? candidate.sourceCapture?.sourceUrl;
  const sourceUrl = aSupplierInputUrl(capturedUrl)
    ? capturedUrl
    : aSupplierInputUrl(candidate.sourceUrl)
      ? candidate.sourceUrl
      : null;
  const dimensions = isObject(candidate.dimensionsCm) ? candidate.dimensionsCm : {};
  const terraDraft = sales?.auxiliaryDrafts?.filter((item) => item.provider === "terra").at(-1) || null;
  const guooRouteComparison = Array.isArray(candidate.guooRouteComparisonsV1) && candidate.guooRouteComparisonsV1.length > 0
    ? structuredClone(candidate.guooRouteComparisonsV1.at(-1)) : null;

  const card = {
    cardVersion: REAL_A_CONFIRMATION_CARD_VERSION,
    readOnlyPreparation: true,
    sourceCandidateId: candidate.id,
    sourceDataRevision: candidate.dataRevision,
    productName: candidate.productName,
    targetPlatform: STORE_PLATFORMS[candidate.targetStore] ?? null,
    targetStore: candidate.targetStore,
    storeRef: isCompleteStoreRef(candidate.storeRef, candidate.targetStore) ? structuredClone(candidate.storeRef) : null,
    storeBindingStatus: isCompleteStoreRef(candidate.storeRef, candidate.targetStore) ? "bound" : candidate.storeRef == null ? "missing" : "invalid",
    decisions: ["confirm", "reject"],
    targetSalePriceRub: guooRouteComparison?.resultRevision === candidate.dataRevision
      ? guooRouteComparison.inputSnapshot?.salePrice?.amountRub ?? null : null,
    guooRouteComparison,
    salesReview: sales ? {
      snapshotId: sales.snapshotId,
      source: sales.source ?? "platform_page_read",
      marketMetrics: isObject(sales.marketMetrics) ? structuredClone(sales.marketMetrics) : null,
      sourceDataRevision: sales.sourceDataRevision,
      productUrl: sales.productUrl,
      title: sales.title,
      currentPrice: sales.currentPrice,
      currency: sales.currency,
      sellerType: sales.sellerType,
      sellerIdentityStatus: sales.sellerIdentityEvidence.status,
      collectedAt: sales.collectedAt,
      evidenceRef: sales.evidenceRef,
      comparability: "unknown",
      validityStatus: "unknown",
      confidence: "unknown",
      terraAssist: terraDraft ? {
        status: "draft",
        authoritative: false,
        modelVersion: terraDraft.modelVersion,
        generatedAt: terraDraft.generatedAt,
        draftId: terraDraft.draftId,
        output: structuredClone(terraDraft.output)
      } : null
    } : null,
    aiAssist: isObject(candidate.aStageAi) ? structuredClone(candidate.aStageAi) : {
      status: terraDraft ? "completed" : "not_started",
      taskType: "sales_comparability_assist",
      model: "gpt-5.6-terra",
      authoritative: false
    },
    supplierConfirmation: {
      ...(apiEvidence ? {captureId:field(apiEvidence.supplierCapture.captureId,'provider_api_read_only'),minimumOrderQuantity:field(apiEvidence.supplierCapture.minimumOrderQuantity,'provider_api_read_only'),matchType:field('unknown','requires_owner_confirmation')} : {}),
      ...(browserCapture ? {captureId:field(supplierCapture.captureId,'chrome_extension_structured_page_v1'),minimumOrderQuantity:field(null,'requires_owner_quantity_one_evidence'),matchType:field('unknown','requires_owner_confirmation'),quantityOneEvidenceSourceNote:field(null,'requires_owner_quantity_one_evidence')} : {}),
      productUrl: field(sourceUrl, sourceUrl ? "exact_1688_url" : "missing_exact_1688_url"),
      supplierSkuId: field(capturedSku?.sourceSkuId, capturedSku ? "verified_source_capture" : "missing_verified_sku"),
      variantKey: field(capturedSku?.variantKey || capturedSku?.variantName, capturedSku ? "verified_source_capture" : "missing_verified_sku"),
      unitProductPrice: field(capturedSku?.unitProductPrice, capturedSku ? "verified_source_capture" : "unknown_not_inferred"),
      unitDomesticFreight: field(null, "unknown_not_inferred"),
      otherPurchaseCosts: field(null, "unknown_requires_explicit_confirmation"),
      actualPurchaseCost: field(candidate.purchasePriceRmb ?? legacySupply?.actualPurchaseCost, "candidate_confirmed_all_in_cost"),
      weightKg: field(candidate.packedWeightKg ?? legacySupply?.packedWeightKg, "candidate_confirmed_packaging"),
      dimensionsCm: {
        length: field(dimensions.length ?? legacySupply?.dimensionsCm?.length, "candidate_confirmed_packaging"),
        width: field(dimensions.width ?? legacySupply?.dimensionsCm?.width, "candidate_confirmed_packaging"),
        height: field(dimensions.height ?? legacySupply?.dimensionsCm?.height, "candidate_confirmed_packaging")
      }
    },
    supplierCapture: supplierCapture ? {
      status: supplierCapture.status,
      ...(apiEvidence ? {sourceMode:"provider_api_read_only",mode:"provider_api_read_only",complianceStatus:apiEvidence.complianceStatus,minimumOrderQuantity:supplierCapture.minimumOrderQuantity,evidenceGaps:apiEvidence.gaps} : {}),
      ...(browserCapture ? {sourceMode:'chrome_extension_structured_page_v1',quantityOneEvidenceRequired:true} : {}),
      captureId: supplierCapture.captureId,
      jobId: supplierCapture.jobId || null,
      jobStatus: supplierCapture.jobStatus || null,
      attempt: Number(supplierCapture.attempt || 0),
      requiredExtensionVersion: supplierCapture.requiredExtensionVersion || null,
      claimedExtensionVersion: supplierCapture.claimedExtensionVersion || null,
      originalSourceUrl: supplierCapture.originalSourceUrl || null,
      sourceUrl: supplierCapture.sourceUrl || null,
      offerId: supplierCapture.offerId || null,
      observedAt: supplierCapture.observedAt || null,
      pageFields: structuredClone(supplierCapture.pageFields || {
        unitProductPriceCny: null,
        unitProductPriceSource: null,
        unitDomesticFreightCny: null,
        unitDomesticFreightSource: null
      }),
      skuChoices: structuredClone(Array.isArray(projectedSkus) ? projectedSkus : []),
      selectedSkuIds: [],
      ownerSupplyConfirmed: false,
      failureCode: supplierCapture.failureCode || null,
      failureDiagnostics: isObject(supplierCapture.failureDiagnostics)
        ? structuredClone(supplierCapture.failureDiagnostics)
        : null,
      failureDestinationLabel: supplierCapture.failureDestinationLabel ||
        sourceCaptureFailureDestinationLabel(supplierCapture.failureDiagnostics, supplierCapture.failureCode) || null,
      reason: supplierCapture.reason || null
    } : null,
    confirmation: {
      ownerSupplyConfirmed: false,
      oneCardSubmission: true,
      startsB: true,
      createsDispatch: false,
      businessStateChanged: false
    },
    blockedByException: candidate.executionRuntime?.exceptionCase?.status === "open",
    costPolicyReadiness: isObject(options.costPolicyReadiness) ? structuredClone(options.costPolicyReadiness) : null,
    systemEvidenceReadiness: isObject(options.systemEvidenceReadiness)
      ? structuredClone(options.systemEvidenceReadiness)
      : unavailableSystemEvidence(),
    systemEvidencePreparationPlan: isObject(options.systemEvidencePreparationPlan)
      ? structuredClone(options.systemEvidencePreparationPlan)
      : null,
    boundaries: {
      candidateWrites: 0,
      platformAccesses: 0,
      platformWrites: 0,
      taskDispatches: 0,
      automationStarted: false
    }
  };
  if (JSON.stringify(candidate) !== before) throw new Error("REAL_A_CARD_READ_ONLY_VIOLATION");
  return Object.freeze(card);
}

export function validateRealAConfirmationSubmission(card, input) {
  if (!isObject(card) || card.cardVersion !== REAL_A_CONFIRMATION_CARD_VERSION) {
    throw new TypeError("REAL_A_CARD_INVALID: 确认卡版本无效");
  }
  const decision = input?.decision;
  const identityErrors = [];
  if (input?.sourceCandidateId !== card.sourceCandidateId || input?.sourceDataRevision !== card.sourceDataRevision ||
      input?.dataRevision !== card.sourceDataRevision) {
    identityErrors.push({ field: "sourceCandidateId", label: "候选身份和修订", reason: "必须提交当前候选确认卡及其修订号" });
  }
  if (decision !== "reject" && (input?.targetPlatform !== card.targetPlatform ||
      !isCompleteStoreRef(card.storeRef, card.targetStore) || !sameStoreRef(input?.storeRef, card.storeRef))) {
    identityErrors.push({ field: "storeRef", label: "店铺身份", reason: "必须确认当前卡片保存的完整平台和店铺映射" });
  }
  if (decision === "reject") {
    return Object.freeze({
      valid: identityErrors.length === 0,
      decision,
      sourceCandidateId: card.sourceCandidateId,
      sourceDataRevision: card.sourceDataRevision,
      normalized: null,
      errors: identityErrors
    });
  }
  const supplier = isObject(input?.supplierConfirmation) ? input.supplierConfirmation : {};
  const sales = isObject(input?.salesReview) ? input.salesReview : {};
  const errors = identityErrors;
  const push = (fieldName, label, reason) => errors.push({ field: fieldName, label, reason });

  if (decision !== "confirm") push("decision", "方向决定", "请选择确认或淘汰");
  if (input.targetSalePriceRub !== undefined && input.targetSalePriceRub !== null &&
      (!Number.isFinite(input.targetSalePriceRub) || input.targetSalePriceRub <= 0)) {
    push("targetSalePriceRub", "目标成交价RUB", "必须是大于0的卢布成交价，不能填写采购价或后台人民币价格");
  }
  if (!card.salesReview || sales.snapshotId !== card.salesReview.snapshotId) {
    push("salesReview.snapshotId", "销售快照", "必须确认当前卡片展示的销售快照");
  }
  if (sales.comparability !== "comparable") {
    push("salesReview.comparability", "商品可比性", "只有确认商品合理可比才能进入B");
  }
  if (sales.validityStatus !== "current") {
    push("salesReview.validityStatus", "销售快照时效", "当前快照必须经系统确认仍然有效");
  }
  if (!exact1688Url(supplier.productUrl)) push("productUrl", "精确1688供应链接", "必须是detail.1688.com的准确商品链接");
  if (!String(supplier.supplierSkuId || "").trim()) push("supplierSkuId", "具体供应SKU", "必须锁定具体供应SKU");
  if (!String(supplier.variantKey || "").trim()) push("variantKey", "规格/变体", "必须明确具体规格或变体");
  if (!positive(supplier.unitProductPrice)) push("unitProductPrice", "商品价", "必须填写大于0的单件商品价");
  if (!nonNegative(supplier.unitDomesticFreight)) push("unitDomesticFreight", "国内运费", "必须明确填写，免运费时填0");
  if (!nonNegative(supplier.otherPurchaseCosts)) push("otherPurchaseCosts", "其他采购费用", "必须明确填写，没有时填0");
  if (!positive(supplier.actualPurchaseCost)) push("actualPurchaseCost", "实际采购成本", "必须填写实际采购到手总成本");
  if (!positive(supplier.weightKg)) push("weightKg", "实际打包重量", "必须填写大于0的打包重量");
  const dimensions = isObject(supplier.dimensionsCm) ? supplier.dimensionsCm : {};
  for (const [key, label] of [["length", "长度"], ["width", "宽度"], ["height", "高度"]]) {
    if (!positive(dimensions[key])) push(`dimensionsCm.${key}`, label, `必须填写大于0的包装${label}`);
  }
  if (supplier.ownerSupplyConfirmed !== true) {
    push("ownerSupplyConfirmed", "主人供应方案确认", "主人必须明确确认当前链接、SKU和成本包装属于同一采购方案");
  }

  const boundCapture = card.supplierCapture?.sourceMode === 'provider_api_read_only' || card.supplierCapture?.quantityOneEvidenceRequired === true;
  if (boundCapture) {
    const capture=card.supplierCapture;
    const choices=capture.skuChoices.filter(sku=>sku.sourceSkuId===supplier.supplierSkuId);
    const selected=choices.length===1?choices[0]:null;
    if(supplier.captureId!==capture.captureId)push('captureId','供应详情回执','必须绑定当前已保存的供应详情回执');
    if(supplier.productUrl!==capture.sourceUrl)push('productUrl','供应链接','不能替换本次详情绑定的供应商品');
    if(!selected)push('supplierSkuId','供应SKU','必须选择当前详情中的唯一具体SKU');
    if(selected&&supplier.variantKey!==selected.variantKey)push('variantKey','供应规格','规格标识必须与所选SKU一致');
    const browser = capture.quantityOneEvidenceRequired === true;
    if (!selected || typeof supplier.unitProductPrice !== 'number' || (!browser || selected.priceCny !== null) &&
        (typeof selected.priceCny !== 'number' || typeof supplier.unitProductPrice !== 'number' || supplier.unitProductPrice !== selected.priceCny))
      push('unitProductPrice','单件商品价','已取得的所选SKU直接价格不能替换；未取得时须补充该SKU数量1的实际价格及来源');
    if ((!browser && (!selected || selected.minimumOrderQuantity !== 1)) ||
        (browser && selected?.minimumOrderQuantity != null && selected.minimumOrderQuantity !== UNKNOWN && selected.minimumOrderQuantity !== 1) ||
        supplier.minimumOrderQuantity !== 1)
      push('minimumOrderQuantity','一件起订','必须明确当前SKU一件可买，未知不得按1件处理');
    if (browser && (typeof supplier.quantityOneEvidenceSourceNote !== 'string' ||
        supplier.quantityOneEvidenceSourceNote.trim().length === 0 || supplier.quantityOneEvidenceSourceNote.length > 1000 ||
        /[\u0000-\u001f\u007f]/u.test(supplier.quantityOneEvidenceSourceNote)))
      push('quantityOneEvidenceSourceNote','数量1购买证据来源','请说明当前SKU一件起订及数量1单价的实际核对来源，不得以其他SKU或阶梯批发价代替');
    if(supplier.matchType!=='exact_match')push('matchType','同款判断','主人必须明确确认精确同款，近似或未知不能通过');
    if(capture.complianceStatus==='brand_review_required')push('complianceStatus','品牌核对','当前来源有品牌信息，正常无品牌选品流程不能放行');
  }

  const goods = numberOrNull(supplier.unitProductPrice);
  const freight = numberOrNull(supplier.unitDomesticFreight);
  const other = numberOrNull(supplier.otherPurchaseCosts);
  const total = numberOrNull(supplier.actualPurchaseCost);
  if ([goods, freight, other, total].every((value) => value !== null) && Math.abs(goods + freight + other - total) > 0.01) {
    push("actualPurchaseCost", "实际采购成本", "必须等于商品价＋国内运费＋其他采购费用");
  }

  const valid = errors.length === 0;
  return Object.freeze({
    valid,
    decision,
    sourceCandidateId: card.sourceCandidateId,
    sourceDataRevision: card.sourceDataRevision,
    normalized: valid ? {
      targetSalePriceRub: input.targetSalePriceRub ?? null,
      salesReview: {
        snapshotId: sales.snapshotId,
        comparability: sales.comparability,
        validityStatus: sales.validityStatus,
        confidence: String(sales.confidence || "limited")
      },
      supplierConfirmation: {
        productUrl: supplier.productUrl.trim(),
        supplierSkuId: String(supplier.supplierSkuId).trim(),
        variantKey: String(supplier.variantKey).trim(),
        unitProductPrice: goods,
        unitDomesticFreight: freight,
        otherPurchaseCosts: other,
        actualPurchaseCost: total,
        weightKg: numberOrNull(supplier.weightKg),
        dimensionsCm: {
          length: numberOrNull(dimensions.length),
          width: numberOrNull(dimensions.width),
          height: numberOrNull(dimensions.height)
        },
        ownerSupplyConfirmed: true,
        ...(boundCapture?{captureId:supplier.captureId,minimumOrderQuantity:1,matchType:'exact_match'}:{}),
        ...(card.supplierCapture?.quantityOneEvidenceRequired===true?{quantityOneEvidenceSourceNote:supplier.quantityOneEvidenceSourceNote.trim()}: {})
      }
    } : null,
    errors
  });
}
