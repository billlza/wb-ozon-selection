export const D_E_STATUS_LABELS = Object.freeze({
  not_applicable: "尚未进入生产阶段",
  awaiting_production_authorization: "等待主人生产授权",
  authorization_not_runnable: "授权不能生成生产计划",
  not_ready: "D/E能力尚未就绪",
  ready_for_explicit_execution: "已具备单SKU执行准备条件",
  awaiting_e_readback: "等待E阶段独立回读",
  listed_verified: "已完成E阶段验证",
  e_source_conflict: "历史验证来源冲突，当前结果待核对",
  execution_in_progress: "本次生产执行中",
  execution_result_unconfirmed: "本次未启动，执行结果待核对",
  execution_failed: "执行已停止"
});

export function dESoftwareRuntimeDisplay(view) {
  if (!view?.available) return null;
  return {
    statusLabel: D_E_STATUS_LABELS[view.status] || view.status,
    gaps: Array.isArray(view.gaps) ? view.gaps : [],
    execution: view.execution || null,
    assetTransport: {
      status: view.assetTransportStatus || "not_started",
      evidenceRef: view.assetTransportEvidenceRef || null,
      resolvedCount: Number(view.assetTransportResolvedCount || 0)
    },
    tone: view.status === "listed_verified"
      ? "completed"
      : view.status === "ready_for_explicit_execution"
        ? "ready"
        : "waiting"
  };
}

const E_READBACK_STATUS_LABELS = Object.freeze({
  in_flight: "正在独立读取平台结果",
  verified: "平台结果已独立验证",
  not_verified: "平台结果尚未通过验证",
  unknown_outcome: "平台读取结果待核对",
  not_applied: "已保存观察，商品来源变化待核对",
  source_conflict: "历史验证来源冲突，当前结果待核对"
});

const E_READBACK_GAP_LABELS = Object.freeze({
  readback_expectation_missing_or_invalid: "原写入记录缺少准确的图片或仓库要求",
  "technical_readback_failure:platform_read_failed": "平台读取失败或超时，未取得可信结果",
  media_identity_unverified: "平台图片与本次提交的图片尚未对应",
  media_duplicate: "平台返回了重复图片",
  media_manifest_mismatch: "平台图片数量与本次提交不一致",
  main_image_mismatch: "平台首图与确认的首图不一致",
  media_order_or_set_mismatch: "平台图片集合或顺序与确认内容不一致",
  warehouse_identity_or_quantity_unverified: "尚未取得指定仓库的准确库存",
  warehouse_stock_mismatch: "指定仓库库存与回读数量不一致",
  listedStatus: "平台审核或销售状态尚未达到可售要求",
  platformErrors: "平台仍有错误或尚未返回完整错误状态",
  currentPrice: "平台价格或币种与授权价格不一致",
  currentStock: "平台库存与授权库存不一致",
  imageCount: "平台图片数量尚未核实或不一致",
  executionBinding: "平台返回的店铺或执行连接与本件商品不一致",
  platformProductId: "平台商品编号不一致",
  merchantSku: "平台货号与授权货号不一致",
  supplierSkuId: "供应 SKU 对应关系不一致",
  skuPackageId: "商品规格包不一致",
  platform: "平台不一致",
  store: "店铺不一致",
  platformEvidenceRef: "平台证据引用尚未取得",
  observation: "尚未取得可核验的平台观察"
});

export function eReadbackRuntimeDisplay(view) {
  if (!view) return null;
  const status = (view.status === "in_flight" && view.live !== true) ||
    (view.status === "verified" && view.applicationDisposition !== "applied") ? "unknown_outcome" : view.status;
  const statusLabel = E_READBACK_STATUS_LABELS[status];
  if (!statusLabel) return { statusLabel: "平台回读记录需要检查", gaps: ["保存的读取状态无法识别"], verified: false };
  return { statusLabel, verified: status === "verified" && view.applicationDisposition === "applied" && view.currentVerified !== false,
    startedAt: view.startedAt, completedAt: view.completedAt,
    gaps: status === "source_conflict" ? ["已保存的独立回读证据仍保留，但商品来源与当时不一致，不能作为当前验证通过。"]
      : (view.result?.gaps ?? []).map(code => E_READBACK_GAP_LABELS[code] ?? `平台核验缺口：${code}`) };
}

const SAVED_JOB_STATUS_LABELS = Object.freeze({
  queued: "任务已保存，等待执行",
  claimed: "任务已领取，尚未完成",
  waiting_platform: "请求已发出，等待结果",
  completed: "本次任务已结束",
  failed: "本次任务已停止",
  unknown_outcome: "结果待对账",
  source_conflict: "保存记录与当前商品不一致"
});

export function dESavedJobRuntimeDisplay(view) {
  if (!view) return null;
  const stages = [view.d, view.e].filter(Boolean).map(stage => ({
    stage: stage.stage,
    title: stage.stage === "D" ? "生产执行" : "平台独立回读",
    statusLabel: stage.sourceBlockReason ? SAVED_JOB_STATUS_LABELS.source_conflict
      : stage.currentVerified ? "当前商品已独立验证"
      : stage.stage === "E" && stage.businessStatus === "not_verified" ? "读取已结束，商品尚未通过验证"
      : SAVED_JOB_STATUS_LABELS[stage.status] ?? "保存的任务状态需要检查",
    receiptLabel: stage.receiptStatus === "production_record_saved" ? "生产回执已保存"
      : stage.receiptStatus === "readback_saved" ? "平台观察已保存"
      : stage.receiptStatus === "progress_saved" ? "已保存本次执行进展" : "尚未保存完成回执",
    reconciliationMessage: stage.status === "unknown_outcome"
      ? stage.lateMaterial ? "晚到材料已经保留，仍需对账；不会自动继续或重发。" : "请求结果尚不确定，需要先对账；不会自动重发。"
      : null,
    blockers: stage.blockers.map(item => item.message)
  }));
  return { stages, tone: view.currentVerified ? "completed" : view.canContinueSaved ? "ready" : "waiting",
    statusLabel: view.status === "source_conflict" ? "保存记录需要核对"
      : view.currentVerified ? "当前商品已完成独立验证"
      : view.canContinueSaved ? "原任务可以继续" : "已保存任务的当前进展",
    canContinueSaved: view.canContinueSaved === true,
    continuation: { jobId: view.continueJobId, expectedRevision: view.expectedRevision },
    canDispatchNewRound: view.canDispatchNewRound === true,
    newRoundBlocker: view.d?.newRound?.canDispatch === false ? view.d.newRound.blocker ?? null : null,
    newRound: { supersededJobId: view.newRoundSupersededJobId, expectedRevision: view.expectedRevision },
    canRollbackAuthorization: view.canRollbackAuthorization === true,
    rollbackBlocker: view.canRollbackAuthorization === true ? null : view.rollbackBlocker ?? null,
    rollback: { authorizationId: view.rollbackAuthorizationId, expectedRevision: view.expectedRevision },
    canReobserveUnknownOutcome: view.canReobserveUnknownOutcome === true,
    reobservationBlocker: view.canReobserveUnknownOutcome === true ? null : view.reobservationBlocker ?? null,
    reobservation: view.unknownOutcomeReobservation ?? null,
    canReconcileFromPlatformState: view.canReconcileFromPlatformState === true,
    platformStateReconciliationBlocker: view.canReconcileFromPlatformState === true ? null : view.platformStateReconciliationBlocker ?? null,
    platformStateReconciliation: view.platformStateReconciliation ?? null,
    platformStateReconciliationAttemptsLeft: view.platformStateReconciliationAttemptsLeft ?? null,
    canRecoverInitialImport: view.canRecoverInitialImport === true,
    recoveryBlocker: view.canRecoverInitialImport === true ? null : view.recoveryBlocker ?? null,
    recovery: view.initialImportRecovery ?? null };
}
