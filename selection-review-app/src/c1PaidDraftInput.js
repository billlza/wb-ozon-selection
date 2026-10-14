export function buildC1PaidDraftInput({ candidate, confirmed, sourceRevision }) {
  const view = candidate.c1DraftRuntimeView;
  const request = candidate.lifecycleV11?.c1AiDraftRequestV1;
  if (candidate.dataRevision !== sourceRevision || view?.status !== "awaiting_paid_confirmation" ||
      view.canAuthorize !== true || !request || request.requestId !== view.requestRef ||
      request.requestFingerprint !== view.requestFingerprint) throw new Error("当前文案请求已变化，请刷新核对后再确认。");
  if (confirmed !== true) throw new Error("请明确确认本件商品的一次付费文案调用。");
  return { candidateId: candidate.id, expectedRevision: sourceRevision,
    requestRef: request.requestId, requestFingerprint: request.requestFingerprint,
    confirmPaidCall: true, expiresAt: null,
    idempotencyKey: `c1-paid-confirm:${candidate.id}:${sourceRevision}`,
    auditEventId: `c1-paid-confirm-audit:${candidate.id}:${sourceRevision}` };
}

export function buildC1SavedDraftContinuationInput({ candidate, sourceRevision }) {
  const view = candidate.c1DraftRuntimeView;
  if (candidate.dataRevision !== sourceRevision || view?.canContinueSaved !== true ||
      view.jobRevision !== sourceRevision || typeof view.jobId !== "string") throw new Error("当前已许可任务不可继续，请核对保存状态。");
  return { candidateId: candidate.id, expectedRevision: sourceRevision, jobId: view.jobId };
}

export function buildC1DraftResultReadInput({ candidate, sourceRevision }) {
  const view = candidate.c1DraftRuntimeView;
  if (candidate.dataRevision !== sourceRevision || view?.canReadOriginalResult !== true ||
      view.jobRevision !== sourceRevision || typeof view.jobId !== "string") throw new Error("当前原任务结果不可读取，请核对保存状态。");
  return { candidateId: candidate.id, expectedRevision: sourceRevision, jobId: view.jobId };
}

export function buildC1KeywordHandoffRetryInput({ candidate, sourceRevision }) {
  const view = candidate.c1DraftRuntimeView;
  if (candidate.dataRevision !== sourceRevision || view?.canRetryKeywordHandoff !== true ||
      typeof view.keywordJobId !== "string" || typeof view.handoffFailureId !== "string") {
    throw new Error("当前交接记录不可继续，请核对商品和文案配置。");
  }
  return { candidateId: candidate.id, expectedRevision: sourceRevision,
    keywordJobId: view.keywordJobId, failureId: view.handoffFailureId,
    idempotencyKey: `c1-keyword-handoff:${candidate.id}:${sourceRevision}`,
    auditEventId: `c1-keyword-handoff-audit:${candidate.id}:${sourceRevision}` };
}
