export function buildBExactCommissionInput({ candidate, sourceRevision }) {
  const view = candidate.bExactCommissionRuntimeView;
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || candidate.dataRevision !== sourceRevision ||
      view?.expectedRevision !== sourceRevision || view.candidateId !== candidate.id || view.canRecalculate !== true ||
      typeof view.skuPackageId !== "string" || !view.skuPackageId || typeof view.failureId !== "string" || !view.failureId) {
    throw new Error("当前精确费用或商品记录不可复算，请刷新核对；未提交旧资料。");
  }
  return { candidateId: candidate.id, expectedRevision: sourceRevision, skuPackageId: view.skuPackageId, failureId: view.failureId,
    idempotencyKey: `b-exact-recalculation:${candidate.id}:${sourceRevision}`,
    auditEventId: `b-exact-recalculation-audit:${candidate.id}:${sourceRevision}` };
}

/**
 * 「重新读一次费用证据」那一步的提交。它和复算是两次独立的点击，所以不共用幂等键。
 *
 * 这里不看 `canRecalculate`：还没有可用证据、正是要去读的时候，那一项本来就是 false。
 * 只核对眼前这一版资料和服务端那份记录说的是同一版——对不上就拒绝，旧版本号绝不提交出去。
 */
export function buildBEvidenceRefreshInput({ candidate, sourceRevision }) {
  const view = candidate.bExactCommissionRuntimeView;
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || candidate.dataRevision !== sourceRevision ||
      view?.expectedRevision !== sourceRevision || view.candidateId !== candidate.id) {
    throw new Error("当前商品记录已变化，请刷新核对；未按旧资料去读费用证据。");
  }
  return { candidateId: candidate.id, expectedRevision: sourceRevision };
}
