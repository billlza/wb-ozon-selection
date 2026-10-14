import { inspectLifecycleEvidenceValidity } from "./lifecycle-evidence-validity.mjs";
import { buildExpectedEvidenceScope, evidenceScopeMatches } from "./lifecycle-evidence-scope.mjs";
import {
  inspectLifecycleBInputReadiness,
  resolveLifecycleEvidenceContext,
  validateLifecycleEvidenceData,
  isLifecycleEvidenceTraceValid,
  inspectCommissionCatalogValidity,
  normalizeCurrentCommissionCatalogs
} from "./lifecycle-b-input-bundle.mjs";
import { validateSalesSnapshot } from "./sales-snapshot.mjs";

export const LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION = "lifecycle-b-evidence-preparation-v1.1";

export const LIFECYCLE_B_EVIDENCE_KINDS = Object.freeze([
  "commission",
  "logistics_tariff",
  "exchange_rate",
  "schema"
]);

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

/** 官方费表 Full ChinaHK 那张表的中文类目树正好三级：平台大类 > 三级类目 > 类型。 */
const OFFICIAL_TABLE_CATEGORY_PATH_SEGMENTS = 3;

function categoryPathSegments(value) {
  if (!nonEmptyString(value)) return [];
  return String(value).split(/\s*(?:>|\/|→)\s*/u).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * 形状对得上官方费表中文类目树的那一份已冻结销售快照，取 collectedAt 最新的一份。
 *
 * 读的是 `candidate.salesSnapshotsV11`——这件商品自己保存的销售快照，和
 * `lib/discovery-market-snapshot.mjs` 的 `currentSalesSnapshot`、`lib/lifecycle-b-input-bundle.mjs` 的
 * `latestCategorySnapshot` 同一个数组。不读 `opportunityPackage.salesSnapshots`：那是A阶段挑出来做价格
 * 判断的市场样本子集，首次确认时它还不存在（本函数跑在 `runRealAConfirmationToBAndC1` 之前），历史数据里
 * 它的 `[0]` 还可能是个连 `categoryPath` 都没有的 legacy 占位记录——按下标取值从来就没有意义。
 */
function officialTableCategorySegments(candidate) {
  const snapshots = Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [];
  return snapshots
    .filter((snapshot) => validateSalesSnapshot(snapshot).valid && isoDateTime(snapshot?.collectedAt))
    .map((snapshot) => ({ collectedAt: snapshot.collectedAt, segments: categoryPathSegments(snapshot.categoryPath) }))
    .filter(({ segments }) => segments.length === OFFICIAL_TABLE_CATEGORY_PATH_SEGMENTS &&
      segments.every((segment) => segment.length <= 200 && /\p{Script=Han}/u.test(segment)))
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0]?.segments ?? null;
}

/**
 * 官方佣金表按“成交价档 + Ozon类型名称”取值，这两项都不属于可复用的证据范围，只能随本轮请求传入。
 *
 * 价格：只取这一笔确认正在冻结的成交价——主人自己在「找货」里填的目标成交价，随本轮提交上来，并且已经
 * 冻结进本轮 GUOO 线路比较；没有本轮提交时（独立的证据准备路由）退回A阶段早已冻结的建议成交价。两者都
 * 没有就留空。**绝不在这里从销售快照现推一个数**：那是市场行情，不是这件商品的成交价。
 * 已知落差：主人填的目标成交价和A阶段按可比样本中位数算出来的建议成交价可能不是同一个数（现场 1455 对
 * 1445）。两者同档时费率相同；万一跨档，记下来的 `officialCommissionBinding.priceRub` 就是实际取数用的
 * 那个价，查得出来。official_reference 也进不了上架那道闸门（那里只认 exact），写到平台上的价格永远要
 * 先用精确佣金复算一遍。
 *
 * 类型名称：官方费表 Full ChinaHK 那张表按**中文类目树**索引（mpCategoryZh > category3Zh > typeZh），
 * 不是按商品页面上的面包屑。2026-09-14 用主人那份真目录（sha256 be7832ff…、effectiveFrom 2025-12-01）实测：
 *   · 页面面包屑末段「Одежда」                → 0 行，命不中；
 *   · 中文类目树末段「宠物服装」               → 第1656行，命中（rfbs le1500 = 12%）；
 *   · 同一行的俄文类型名「Одежда для животных」 → 同一行，命中。
 * 面包屑是导航树、不是类型树（现场另一条候选的面包屑末段干脆是个店名「TipToPolis」），所以这里只认形状
 * 对得上费表的那一种：正好三段、每段都带汉字的类目路径。末段当类型名，首段当平台大类一起传下去——费表里
 * 有 298 个重名类型，不带大类的话重名行只能记成 TYPE_AMBIGUOUS 缺口。
 * 形状对不上就留空：reader 记成缺口回到主人授权估算路径，绝不拿一个已知不是类型名的词去撞表。
 */
function commissionReferenceScope(candidate, submission) {
  const opportunity = candidate?.lifecycleV11?.opportunityPackage;
  const price = opportunity?.marketAssessment?.recommendedSalePrice;
  const submitted = isObject(submission) ? submission.targetSalePriceRub : undefined;
  const priceRub = Number.isFinite(submitted) && submitted > 0 ? submitted
    : isObject(price) && price.currency === "RUB" && Number.isFinite(price.amount) && price.amount > 0 ? price.amount
      : null;
  const segments = officialTableCategorySegments(candidate);
  const typeName = segments === null ? null : segments.at(-1);
  const mpCategoryZh = segments === null ? null : segments[0];
  return priceRub === null && typeName === null ? null : { priceRub, typeName, mpCategoryZh };
}

function validatePreparedPack(pack, kind, context, preparedAt, currentCommissionCatalogs) {
  const problems = [];
  if (!isObject(pack)) return ["提供器没有返回结构化证据包"];
  if (!nonEmptyString(pack.id)) problems.push("缺证据包ID");
  if (pack.kind !== kind) problems.push("证据类型不一致");
  if (pack.status !== "active") problems.push("证据状态必须为active");
  if (!nonEmptyString(pack.sourceType) || !nonEmptyString(pack.sourceRef)) problems.push("缺可追溯来源");
  if (!isoDateTime(pack.checkedAt)) problems.push("取得时间无效");
  if (!isLifecycleEvidenceTraceValid(pack)) problems.push("来源或有效期合同无效");
  if (isoDateTime(pack.checkedAt) && Date.parse(pack.checkedAt) > Date.parse(preparedAt)) problems.push("取得时间晚于本轮冻结时间");
  if (isoDateTime(pack.checkedAt) && isoDateTime(pack.expiresAt) && Date.parse(pack.expiresAt) <= Date.parse(pack.checkedAt)) {
    problems.push("失效时间必须晚于取得时间");
  }
  const validity = inspectLifecycleEvidenceValidity(pack, { asOf: preparedAt });
  if (!validity.usable) problems.push(validity.reason);
  if (!evidenceScopeMatches(kind, pack.scope, buildExpectedEvidenceScope(kind, context))) problems.push("证据适用范围不一致");
  const catalog = inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs, asOf: preparedAt });
  if (!catalog.available) problems.push(catalog.message);
  const evidenceValidation = validateLifecycleEvidenceData(kind, pack.evidenceData);
  if (!evidenceValidation.valid) {
    problems.push(...evidenceValidation.errors.map((item) => `${item.path} ${item.message}`));
  }
  return problems;
}

export function buildLifecycleBEvidencePreparationPlan({ candidate, evidencePacks = [], plannedAt, currentCommissionCatalogs = [] }) {
  if (!isObject(candidate) || !nonEmptyString(candidate.id) || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("B_EVIDENCE_PREPARATION_INVALID_CANDIDATE: 候选身份或修订号无效");
  }
  if (!isoDateTime(plannedAt)) throw new Error("B_EVIDENCE_PREPARATION_INVALID_TIME: 计划时间无效");
  const context = resolveLifecycleEvidenceContext(candidate);
  const readiness = inspectLifecycleBInputReadiness({ candidate, evidencePacks, asOf: plannedAt, currentCommissionCatalogs });
  const actions = readiness.fields.map((field) => ({
    kind: field.key,
    action: field.available ? "reuse" : "prepare_once",
    currentStatus: field.status,
    evidencePackId: field.evidencePackId,
    reason: field.message,
    expectedScope: context.ready ? buildExpectedEvidenceScope(field.key, context.values) : null,
    maximumAutomaticAttempts: field.available ? 0 : 1
  }));
  return deepFreeze({
    planVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
    planId: `b-evidence-plan:${candidate.id}:${candidate.dataRevision}:${plannedAt}`,
    candidateId: candidate.id,
    candidateRevision: candidate.dataRevision,
    plannedAt,
    status: context.ready ? (readiness.ready ? "ready_from_reuse" : "preparation_required") : "blocked_context",
    context,
    actions,
    currentEvidenceReady: readiness.ready,
    ownerActionRequired: false,
    businessStateEffect: "unchanged",
    automaticRetryAllowed: false,
    externalAccessStarted: false,
    platformWrites: 0
  });
}

function failureResult({ plan, providerCalls, failureLayer, reason, discardedEvidencePackIds = [] }) {
  return deepFreeze({
    runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
    plan,
    status: "failed",
    providerCalls,
    failure: { layer: failureLayer, reason },
    evidencePacksToCommit: [],
    discardedEvidencePackIds,
    finalReadiness: null,
    ownerActionRequired: false,
    businessStateEffect: "unchanged",
    automaticRetryAttempted: false,
    automaticRetryAllowed: false,
    platformWrites: 0
  });
}

export async function runLifecycleBEvidencePreparation({
  candidate,
  evidencePacks = [],
  providers = {},
  plannedAt,
  preparedAt,
  // 本轮A确认已校验的提交（`validateRealAConfirmationSubmission().normalized`）。只用来取主人自己填的
  // 目标成交价——官方费表按成交价档取值，而那个价要到这一轮确认结束才落盘。没有提交时留 null。
  submission = null,
  clock = () => new Date(),
  currentCommissionCatalogs = [],
  getCurrentCommissionCatalogs = () => currentCommissionCatalogs
}) {
  if (typeof getCurrentCommissionCatalogs !== 'function') throw new Error('CURRENT_COMMISSION_CATALOGS_READER_INVALID');
  const currentCatalogs = () => normalizeCurrentCommissionCatalogs(getCurrentCommissionCatalogs());
  const plan = buildLifecycleBEvidencePreparationPlan({ candidate, evidencePacks, plannedAt, currentCommissionCatalogs: currentCatalogs() });
  if (preparedAt !== undefined && (!isoDateTime(preparedAt) || Date.parse(preparedAt) < Date.parse(plannedAt))) {
    throw new Error("B_EVIDENCE_PREPARATION_INVALID_TIME: 完成时间不得早于计划时间");
  }
  const completionTime = () => {
    const value = preparedAt || clock().toISOString();
    if (!isoDateTime(value) || Date.parse(value) < Date.parse(plannedAt)) {
      throw new Error("B_EVIDENCE_PREPARATION_INVALID_TIME: 完成时间不得早于计划时间");
    }
    return value;
  };
  if (plan.status === "blocked_context") {
    return failureResult({
      plan,
      providerCalls: [],
      failureLayer: "evidence_context",
      reason: `证据适用范围未锁定：${plan.context.missing.join("、")}`
    });
  }
  if (plan.status === "ready_from_reuse") {
    const finalReadiness = inspectLifecycleBInputReadiness({ candidate, evidencePacks, asOf: completionTime(), currentCommissionCatalogs: currentCatalogs() });
    if (!finalReadiness.ready) {
      return failureResult({
        plan,
        providerCalls: [],
        failureLayer: "reuse_validity_drift",
        reason: `复用证据在本轮结束前失效：${finalReadiness.missing.join("、")}`
      });
    }
    return deepFreeze({
      runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
      plan,
      status: "completed",
      providerCalls: [],
      failure: null,
      evidencePacksToCommit: [],
      discardedEvidencePackIds: [],
      finalReadiness,
      ownerActionRequired: false,
      businessStateEffect: "unchanged",
      automaticRetryAttempted: false,
      automaticRetryAllowed: false,
      platformWrites: 0
    });
  }

  const preparedPacks = [];
  const providerCalls = [];
  for (const action of plan.actions.filter((item) => item.action === "prepare_once")) {
    const provider = providers[action.kind];
    if (typeof provider !== "function") {
      return failureResult({
        plan,
        providerCalls,
        failureLayer: `provider:${action.kind}`,
        reason: `${action.kind}只读提供器未配置`,
        discardedEvidencePackIds: preparedPacks.map((pack) => pack.id)
      });
    }
    const request = deepFreeze({
      requestVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
      candidateId: candidate.id,
      candidateRevision: candidate.dataRevision,
      kind: action.kind,
      scope: structuredClone(action.expectedScope),
      relatedSchemaScope: action.kind === "commission" ? buildExpectedEvidenceScope("schema", plan.context.values) : null,
      commissionReferenceScope: action.kind === "commission" ? commissionReferenceScope(candidate, submission) : null,
      maximumAttempts: 1,
      readOnly: true,
      platformWritesAllowed: false,
      requestedAt: plannedAt
    });
    providerCalls.push({ kind: action.kind, attempt: 1, status: "started" });
    let pack;
    try {
      pack = await provider(request);
    } catch (error) {
      providerCalls[providerCalls.length - 1] = {
        kind: action.kind,
        attempt: 1,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      };
      return failureResult({
        plan,
        providerCalls,
        failureLayer: `provider:${action.kind}`,
        reason: providerCalls[providerCalls.length - 1].reason,
        discardedEvidencePackIds: preparedPacks.map((item) => item.id)
      });
    }
    const problems = validatePreparedPack(pack, action.kind, plan.context.values, completionTime(), currentCatalogs());
    if (problems.length) {
      providerCalls[providerCalls.length - 1] = {
        kind: action.kind,
        attempt: 1,
        status: "invalid_result",
        reason: problems.join("；")
      };
      return failureResult({
        plan,
        providerCalls,
        failureLayer: `provider_result:${action.kind}`,
        reason: problems.join("；"),
        discardedEvidencePackIds: [...preparedPacks.map((item) => item.id), nonEmptyString(pack?.id) ? pack.id : null].filter(Boolean)
      });
    }
    preparedPacks.push(structuredClone(pack));
    providerCalls[providerCalls.length - 1] = { kind: action.kind, attempt: 1, status: "completed", evidencePackId: pack.id };
  }

  const finalReadiness = inspectLifecycleBInputReadiness({
    candidate,
    evidencePacks: [...evidencePacks, ...preparedPacks],
    asOf: completionTime(),
    currentCommissionCatalogs: currentCatalogs()
  });
  if (!finalReadiness.ready) {
    return failureResult({
      plan,
      providerCalls,
      failureLayer: "final_readiness",
      reason: `四类证据未全部就绪：${finalReadiness.missing.join("、")}`,
      discardedEvidencePackIds: preparedPacks.map((pack) => pack.id)
    });
  }
  return deepFreeze({
    runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
    plan,
    status: "completed",
    providerCalls,
    failure: null,
    evidencePacksToCommit: preparedPacks,
    discardedEvidencePackIds: [],
    finalReadiness,
    ownerActionRequired: false,
    businessStateEffect: "unchanged",
    automaticRetryAttempted: false,
    automaticRetryAllowed: false,
    platformWrites: 0
  });
}
