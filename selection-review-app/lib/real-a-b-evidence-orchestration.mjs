import { buildLifecycleBExplicitOtherCosts } from "./lifecycle-b-evidence-runtime.mjs";
import { isDeepStrictEqual } from "node:util";
import { readGuooTariffCatalog } from "./guoo-tariff-reader.mjs";
import { compareGuooRoutes, assertGuooRouteComparison } from "./guoo-route-comparison.mjs";
import { evidenceScopeMatches } from "./lifecycle-evidence-scope.mjs";
import { createLifecycleBInputBundle } from "./lifecycle-b-input-bundle.mjs";
import { applyLifecycleBEvidenceContext } from "./lifecycle-b-evidence-context.mjs";
import { LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION, runLifecycleBEvidencePreparation } from "./lifecycle-b-evidence-preparation.mjs";
import { buildRealAConfirmationCard, validateRealAConfirmationSubmission } from "./real-a-confirmation-card.mjs";
import { readDeclaredCargoFacts } from "./cargo-facts-declaration.mjs";
import { runRealAConfirmationToBAndC1 } from "./real-a-b-c1-flow.mjs";

export const REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION = "real-a-b-evidence-orchestration-v1.1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function productIdFromSnapshot(snapshot) {
  if (String(snapshot?.productId || "").trim()) return String(snapshot.productId).trim();
  try {
    return new URL(String(snapshot?.productUrl || "")).pathname.match(/(\d{7,})(?:\/|$)/)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * 类目被冻成平台身份之后，这一轮刚读到的佣金和Schema证据必须跟着换成同一个键。
 *
 * 2026-09-14 主人第一件真货就栽在这里：A确认把 `lifecycleEvidenceContextV11.category` 改成了
 * `ozon:<descriptionCategoryId>:<typeId>`，可同一次事务提交的那两份证据仍然挂在读取时用的类目路径上。
 * 从那一刻起这件商品的证据和它自己的适用范围对不上，`inspectLifecycleBInputReadiness` 再也找不到
 * 佣金和Schema，「用更好的费用证据重算」那条路被 B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE 永久挡住——
 * 而记录本身一切正常，看不出哪里坏了。
 *
 * 所以冻结类目和重贴证据必须是同一件事：两者一起换，或者一样都不换。宁可这一轮不升级成平台身份键，
 * 也不能留下一件证据和适用范围对不上的商品。
 */
function rekeyFrozenCategoryPacks({ packsToCommit, categoryPacks, fromCategory, categoryToken }) {
  // 适用范围比对一律走 normalizeEvidenceScope 的那一套（去空白、转小写）：
  // 保存的范围留着原样的大小写，证据包里的键已经规范化过，直接比字符串会当成两个类目。
  const key = (value) => String(value ?? "").trim().toLowerCase();
  if (key(fromCategory) === key(categoryToken)) return { packs: packsToCommit, categoryToken };
  const committing = new Set(packsToCommit.map((pack) => pack.id));
  // 这一轮复用了库里旧证据（没有重新提交）时，改不动它的适用范围：那就连类目键也不换，两边继续对得上。
  if (categoryPacks.some((pack) => !committing.has(pack.id))) return { packs: packsToCommit, categoryToken: fromCategory };
  return {
    categoryToken,
    packs: packsToCommit.map((pack) => (["commission", "schema"].includes(pack.kind) && key(pack.scope?.category) === key(fromCategory)
      ? { ...structuredClone(pack), scope: { ...structuredClone(pack.scope), category: categoryToken } }
      : pack))
  };
}

function freezeResolvedCompetitorCategory({ candidate, submission, evidencePreparation, evidencePacks, verifiedAt }) {
  const readinessFields = Array.isArray(evidencePreparation?.finalReadiness?.fields)
    ? evidencePreparation.finalReadiness.fields
    : [];
  const evidenceById = new Map((Array.isArray(evidencePacks) ? evidencePacks : []).map((pack) => [pack.id, pack]));
  const categoryPacks = ["commission", "schema"].map((kind) => {
    const field = readinessFields.find((item) => item.key === kind && item.available === true);
    return field?.evidencePackId ? evidenceById.get(field.evidencePackId) : null;
  });
  if (categoryPacks.some((pack) => !pack)) {
    throw new Error("B_CATEGORY_EVIDENCE_GAP: 当前竞品类目缺少佣金或Schema的准确平台身份");
  }
  const identities = categoryPacks.map((pack) => ({
    descriptionCategoryId: positiveInteger(pack.evidenceData?.descriptionCategoryId),
    typeId: positiveInteger(pack.evidenceData?.typeId),
  }));
  if (identities.some((item) => !item.descriptionCategoryId || !item.typeId)) {
    throw new Error("B_CATEGORY_EVIDENCE_GAP: 当前竞品类目证据没有准确description_category_id和type_id");
  }
  const identityKeys = new Set(identities.map((item) => `${item.descriptionCategoryId}:${item.typeId}`));
  if (identityKeys.size !== 1) {
    throw new Error("B_CATEGORY_EVIDENCE_CONFLICT: 当前佣金和Schema返回的竞品类目身份不一致");
  }

  const source = structuredClone(candidate);
  const snapshotId = submission?.salesReview?.snapshotId;
  const snapshot = (source.salesSnapshotsV11 || []).find((item) => item.snapshotId === snapshotId);
  if (!snapshot) throw new Error("B_CATEGORY_EVIDENCE_GAP: 当前确认的竞品销售快照不存在");
  const identity = identities[0];
  const verifiedToken = `ozon:${identity.descriptionCategoryId}:${identity.typeId}`;
  const rekeyed = rekeyFrozenCategoryPacks({
    packsToCommit: Array.isArray(evidencePreparation?.evidencePacksToCommit) ? evidencePreparation.evidencePacksToCommit : [],
    categoryPacks,
    fromCategory: source.lifecycleEvidenceContextV11?.category ?? null,
    categoryToken: verifiedToken,
  });
  snapshot.attributes = {
    ...structuredClone(snapshot.attributes || {}),
    description_category_id: identity.descriptionCategoryId,
    type_id: identity.typeId,
  };
  snapshot.platformCategoryEvidence = {
    status: "verified",
    descriptionCategoryId: identity.descriptionCategoryId,
    typeId: identity.typeId,
    categoryToken: verifiedToken,
    sourceProductId: productIdFromSnapshot(snapshot),
    sourceSnapshotId: snapshot.snapshotId,
    sourceEvidenceRefs: categoryPacks.map((pack) => pack.id),
    verifiedAt,
  };
  const persistedEvidenceContext = {
    ...structuredClone(source.lifecycleEvidenceContextV11 || {}),
    category: rekeyed.categoryToken,
  };
  // B 要在冻结后的这一对上跑：范围和证据同时换过，算出来的输入包才和落盘后的记录是同一件事。
  source.lifecycleEvidenceContextV11 = structuredClone(persistedEvidenceContext);
  return {
    candidate: source,
    persistedEvidenceContext,
    evidencePacksToCommit: rekeyed.packs,
  };
}

function assertSelectedFreightBinding({ comparison, candidate, submission, evidencePreparation, evidencePacks, currentCommissionCatalogs, otherCosts }) {
  const selected = comparison.routes.find(route => route.route === comparison.selectedRoute);
  const field = evidencePreparation.finalReadiness.fields.find(item => item.key === "logistics_tariff" && item.available === true);
  const pack = field ? evidencePacks.find(item => item.id === field.evidencePackId) : null;
  const failure = () => { throw new Error("GUOO_FULL_FREIGHT_BINDING_REQUIRED: B物流证据必须与选中线路的来源、计费规则及完整金额一致"); };
  if (!selected || !selected.baseFreight || !pack || pack.sourceRef !== selected.baseFreight.evidenceId) failure();
  const fields = ["chargeableWeightRule", "perKgRmb", "perParcelRmb", "minimumChargeableWeightKg", "weightRoundingRule", "weightRoundingKg", "volumeDivisorCm3PerKg"];
  for (const key of fields) {
    if (Object.hasOwn(pack.evidenceData, key) !== Object.hasOwn(selected.baseFreight.tariff, key) ||
        !isDeepStrictEqual(pack.evidenceData[key], selected.baseFreight.tariff[key])) failure();
  }
  const bundle = createLifecycleBInputBundle({ candidate, evidencePacks, currentCommissionCatalogs, otherCosts, normalizedSubmission: submission,
    createdAt: evidencePreparation.finalReadiness.checkedAt });
  if (!evidenceScopeMatches("logistics_tariff", { route: bundle.logisticsEvidence.route, ruleVersion: bundle.logisticsEvidence.ruleVersion },
      { route: comparison.selectedRoute, ruleVersion: comparison.ruleVersion }) ||
      bundle.logisticsEvidence.amountRmb !== selected.totalFreightRmb) failure();
}

/**
 * A确认的一次性只读编排：先校验主人提交，再由服务端锁定技术证据范围，
 * 先读取本地GUOO完整线路目录并判定费用选择，缺证时零提供器访问。
 * 线路已确定后四类证据全有或全无准备，最后才运行纯函数B/C1闭环。
 * 本函数不持久化、不派发任务、不写平台；调用方负责修订号复核后的原子提交。
 */
export async function runRealAConfirmationWithSystemEvidence({
  candidate,
  submission,
  evidencePacks = [],
  currentCommissionCatalogs = [],
  profitRule,
  providers = {},
  confirmedAt,
  guooFilePath,
  readGuooCatalog = readGuooTariffCatalog,
  compareGuooRouteCatalog = compareGuooRoutes
}) {
  const card = buildRealAConfirmationCard(candidate);
  const validation = validateRealAConfirmationSubmission(card, submission);
  if (!validation.valid) {
    const detail = validation.errors.map((item) => `${item.label}：${item.reason}`).join("；");
    throw new Error(`REAL_A_CONFIRMATION_INVALID: ${detail}`);
  }

  // 淘汰是纯业务决定，绝不能触发佣金、物流、汇率或Schema读取。
  if (validation.decision === "reject") {
    return deepFreeze({
      orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
      status: "completed",
      contextualCandidate: structuredClone(candidate),
      evidenceContext: null,
      evidencePreparation: null,
      evidencePacksToCommit: [],
      result: runRealAConfirmationToBAndC1({
        candidate,
        submission,
        evidencePacks,
        currentCommissionCatalogs,
        confirmedAt
      }),
      externalAccesses: [],
      platformWrites: 0
    });
  }

  if (candidate.lifecycleV11?.skuPackage) {
    return deepFreeze({
      orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
      status: "completed",
      contextualCandidate: structuredClone(candidate),
      evidenceContext: structuredClone(candidate.lifecycleEvidenceContextV11 || null),
      evidencePreparation: null,
      evidencePacksToCommit: [],
      result: runRealAConfirmationToBAndC1({
        candidate,
        submission,
        evidencePacks,
        currentCommissionCatalogs,
        confirmedAt
      }),
      externalAccesses: [],
      platformWrites: 0,
      idempotentReplay: true
    });
  }

  if (card.targetPlatform !== "ozon") {
    throw new Error("B_EVIDENCE_CONTEXT_PLATFORM_UNSUPPORTED: 当前GUOO线路比较仅适用于Ozon");
  }
  if (typeof readGuooCatalog !== "function" || typeof compareGuooRouteCatalog !== "function") {
    throw new TypeError("REAL_A_GUOO_DEPENDENCY_INVALID");
  }
  const catalog = await readGuooCatalog({ filePath: guooFilePath, now: () => new Date(confirmedAt) });
  const supplier = validation.normalized.supplierConfirmation;
  const comparisonInput = {
    candidateId: candidate.id,
    sourceRevision: candidate.dataRevision,
    packaging: {
      weightKg: supplier.weightKg,
      dimensionsCm: structuredClone(supplier.dimensionsCm),
      sourceRef: `a-confirmation:${candidate.id}:${candidate.dataRevision}:${supplier.supplierSkuId}`
    },
    salePrice: validation.normalized.targetSalePriceRub == null ? null : {
      amountRub: validation.normalized.targetSalePriceRub,
      sourceRef: `a-confirmation:${candidate.id}:${candidate.dataRevision}:target-sale-price-rub`
    },
    // 运输属性只能来自主人自己在「算利润」之前签下的那一次声明（`cargoFactsV1`），带着它自己的来源。
    // 没有声明时这里仍然是 null：线路依旧判不出适用性，`transportVerified` 依旧为 false，B 依旧不放行——
    // 算出了运费不等于核验了运输方式，这道闸没有被这次改动放宽，只是终于有了合法的入口。
    cargoFacts: readDeclaredCargoFacts(candidate),
    catalog
  };
  const guooRouteComparison = assertGuooRouteComparison(compareGuooRouteCatalog(comparisonInput), {
    candidateId: candidate.id, sourceRevision: candidate.dataRevision, catalog
  });
  if (!isDeepStrictEqual(guooRouteComparison.inputSnapshot.packaging, comparisonInput.packaging)) {
    throw new Error("REAL_A_GUOO_PACKAGING_CONFLICT");
  }
  if (!isDeepStrictEqual(guooRouteComparison.inputSnapshot.salePrice, comparisonInput.salePrice)) {
    throw new Error("REAL_A_GUOO_SALE_PRICE_CONFLICT");
  }
  if (guooRouteComparison.status !== "compared" || guooRouteComparison.selectedRoute === null || !guooRouteComparison.transportVerified) {
    const reason = guooRouteComparison.status === "no_applicable_routes"
      ? "当前商品没有已证适用的GUOO线路。"
      : guooRouteComparison.status === "compared"
        ? guooRouteComparison.selectedRoute === null
          ? "表内最低运费存在并列线路，尚未确定可采用的线路族。"
          : guooRouteComparison.inputSnapshot.cargoFacts === null
            // 说清楚缺的是哪一样，主人才知道该去做什么：这一句对应「算利润」里那一块运输属性。
            ? "已得到GUOO表内推荐运费及线路族；这件商品的运输属性还没有你的确认，线路收不收这件货就核验不了，不能作为正式B放行。"
            : "已得到GUOO表内推荐运费及线路族；运输属性和配送映射尚未完成核验，不能作为正式B放行。"
        : "GUOO表内报价仍缺必要输入或存在无法计算的规则，不能准备正式B输入。";
    return deepFreeze({
      orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
      status: "blocked",
      contextualCandidate: structuredClone(candidate),
      evidenceContext: null,
      guooRouteComparison,
      evidencePreparation: {
        runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
        plan: null, status: "failed", providerCalls: [],
        failure: { layer: "guoo_route_comparison", reason },
        evidencePacksToCommit: [], discardedEvidencePackIds: [], finalReadiness: null,
        ownerActionRequired: false, businessStateEffect: "unchanged",
        automaticRetryAttempted: false, automaticRetryAllowed: false, platformWrites: 0
      },
      evidencePacksToCommit: [], result: null, externalAccesses: [], platformWrites: 0
    });
  }
  const contextResult = applyLifecycleBEvidenceContext(candidate, {
    submission: validation.normalized,
    guooFilePath,
    route: guooRouteComparison.selectedRoute
  });
  const otherCosts = buildLifecycleBExplicitOtherCosts(contextResult.candidate, profitRule, { asOf: confirmedAt });
  const evidencePreparation = await runLifecycleBEvidencePreparation({
    candidate: contextResult.candidate,
    evidencePacks,
    currentCommissionCatalogs,
    providers,
    plannedAt: confirmedAt,
    // 官方费表按成交价档取值，而这一笔确认的成交价要到这一轮结束才落盘：把主人本轮填的那个价随请求带下去。
    // 传的是已校验的 normalized，不是客户端原样的 input。
    submission: validation.normalized
  });
  if (evidencePreparation.status !== "completed") {
    return deepFreeze({
      orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
      status: "blocked",
      contextualCandidate: contextResult.candidate,
      evidenceContext: contextResult.context,
      evidencePreparation,
      guooRouteComparison,
      evidencePacksToCommit: [],
      result: null,
      externalAccesses: evidencePreparation.providerCalls,
      platformWrites: 0
    });
  }

  const combinedPacks = [...evidencePacks, ...evidencePreparation.evidencePacksToCommit];
  assertSelectedFreightBinding({ comparison: guooRouteComparison, candidate: contextResult.candidate,
    submission: validation.normalized, evidencePreparation, evidencePacks: combinedPacks, currentCommissionCatalogs, otherCosts });
  const categoryFreeze = freezeResolvedCompetitorCategory({
    candidate: contextResult.candidate,
    submission: validation.normalized,
    evidencePreparation,
    evidencePacks: combinedPacks,
    verifiedAt: confirmedAt,
  });
  // 冻结之后的证据才是要落盘的那一份：类目键换过的，B 也必须用换过的那一份算，不能拿读取时的旧键去算。
  const frozenPacks = [...evidencePacks, ...categoryFreeze.evidencePacksToCommit];
  const result = runRealAConfirmationToBAndC1({
    candidate: categoryFreeze.candidate,
    submission,
    evidencePacks: frozenPacks,
    currentCommissionCatalogs,
    otherCosts,
    confirmedAt,
    processedAt: evidencePreparation.finalReadiness.checkedAt
  });
  return deepFreeze({
    orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
    status: "completed",
    contextualCandidate: categoryFreeze.candidate,
    evidenceContext: categoryFreeze.persistedEvidenceContext,
    evidencePreparation,
    guooRouteComparison,
    evidencePacksToCommit: categoryFreeze.evidencePacksToCommit,
    result,
    externalAccesses: evidencePreparation.providerCalls,
    platformWrites: 0
  });
}
