import { businessDate } from "./workflow.mjs";
import { resolveConfiguredStoreRef } from "./store-binding.mjs";
import { createSoftwareExecutionRuntime } from "./software-execution-state.mjs";

export function queuedProcessing(previous = {}) {
  return {
    state: "queued",
    runId: null,
    startedAt: null,
    claimRevision: null,
    attempts: Number(previous.attempts || 0),
    attemptsToday: Number(previous.attemptsToday || 0),
    lastAttemptAt: previous.lastAttemptAt || null,
    lastError: previous.lastError || null,
    blockReason: previous.blockReason || null,
    userAction: previous.userAction || "",
    readAttempts: Array.isArray(previous.readAttempts) ? previous.readAttempts : [],
    deferredUntil: previous.deferredUntil || null,
    deferredRunId: previous.deferredRunId || null,
    lastAttemptRevision: previous.lastAttemptRevision ?? null,
    lastAttemptBusinessDate: previous.lastAttemptBusinessDate || null,
    dispatchState: previous.dispatchState || null,
    dispatchPriority: previous.dispatchPriority || null,
    dispatchRequestedAt: previous.dispatchRequestedAt || null,
    dispatchTrigger: previous.dispatchTrigger || null,
    manualHold: previous.manualHold === true,
    normalizedAt: previous.normalizedAt || null,
    normalizedFrom: previous.normalizedFrom || null,
    recoveryOptions: Array.isArray(previous.recoveryOptions) ? previous.recoveryOptions : [],
    currentStep: previous.currentStep || "",
    lastProgressAt: previous.lastProgressAt || null,
    progressEvents: Array.isArray(previous.progressEvents) ? previous.progressEvents : [],
    attemptLedger: Array.isArray(previous.attemptLedger) ? previous.attemptLedger : [],
    lastRunId: previous.lastRunId || null,
    stoppedAt: previous.stoppedAt || null,
    stopReason: previous.stopReason || "",
    controlAlertKey: previous.controlAlertKey || ""
  };
}

export function createInitialCandidate({ input, source, id, timestamp, storeBindings }) {
  if (!['user', 'codex', 'software'].includes(source)) throw new TypeError('CANDIDATE_SOURCE_INVALID');
  const discovery = source === 'software';
  const candidate = {
    id,
    source,
    group: source === "user" ? "userAdded" : input.group || "evergreen",
    targetStore: input.targetStore,
    storeRef: resolveConfiguredStoreRef(storeBindings, input.targetStore),
    productName: input.productName?.trim() || (source === "user" ? "用户添加的待识别商品" : "系统新增候选"),
    productUrl: input.productUrl?.trim() || "",
    sourceUrl: input.sourceUrl?.trim() || "",
    competitorUrl: input.competitorUrl?.trim() || "",
    purchasePriceRmb: input.purchasePriceRmb ?? null,
    domesticShippingRmb: input.domesticShippingRmb ?? null,
    // 主人 2026-09-15：新候选不带任何他没声明过的钱。手工新增过去一出生就背着 ¥1.50 的包材默认值，
    // 那是软件替他签的字。现在和 Seerfar 发现来的候选一样留空，由他在「算利润」里一键声明 ¥0 或写明细
    // （lib/extra-handling-fees.mjs 把空值读成 'absent'）。已经存下来的候选一个数都不动。
    packagingCostRmb: input.packagingCostRmb ?? null,
    moq: input.moq ?? null,
    netWeightKg: input.netWeightKg ?? null,
    packedWeightKg: input.packedWeightKg ?? null,
    dimensionsCm: input.dimensionsCm || { length: null, width: null, height: null },
    materialsAndAge: input.materialsAndAge?.trim() || "",
    powered: input.powered ?? "unknown",
    complianceStatus: input.complianceStatus || "needs_confirmation",
    authorizationStatus: input.authorizationStatus || "needs_confirmation",
    expectedPriceRub: input.expectedPriceRub ?? null,
    sellerRevenueCny: input.sellerRevenueCny ?? null,
    purchaseCeiling: input.purchaseCeiling || {
      status: "unavailable",
      scope: "purchase_plus_domestic_shipping",
      missing: [discovery ? '待取得当前市场、费用和供应SKU证据' : 'Codex尚未完成方向采购价反算']
    },
    acceptedTestRisk: input.acceptedTestRisk === true,
    imageUrl: input.imageUrl?.trim() || "",
    notes: input.notes?.trim() || "",
    createdAt: timestamp,
    updatedAt: timestamp,
    reviewedAt: null,
    lastModifiedBy: source,
    userEvaluation: null,
    codexReview: null,
    comments: [],
    history: [],
    workflowStatus: discovery ? 'needs_user_data' : 'awaiting_user_direction',
    processing: { ...queuedProcessing(), state: "idle" },
    dataRevision: 1,
    selectionDate: businessDate(timestamp),
    readyAt: null,
    bPassedAt: null,
    cCompletedAt: null,
    listingPreparation: null,
    defaultStock: discovery ? null : 100,
    eliminatedAt: null,
    eliminationReason: "",
    wbAssessment: null,
    sourceSearchAttempts: Number(input.sourceSearchAttempts || 0),
    sourceSearchAttemptLimit: 3
  };
  if (source === "user" || discovery) {
    candidate.executionRuntime = createSoftwareExecutionRuntime({
      candidateId: id,
      dataRevision: candidate.dataRevision,
      businessPhase: "A",
      stepId: discovery ? 'A_DETAIL_EVIDENCE_REQUIRED' : 'A_WAITING_OWNER_DIRECTION',
      at: timestamp
    });
  }
  return candidate;
}
