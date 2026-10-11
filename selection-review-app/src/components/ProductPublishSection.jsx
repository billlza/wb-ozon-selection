import DESoftwareRuntimeCard from "./DESoftwareRuntimeCard";
import OzonAccountReadCard from "./OzonAccountReadCard";

/**
 * 这件商品是不是已经走到了「上架」或「回读」：最终方案签过、生产授权或作业存下了、平台回读开始了，或者它已经在售。
 *
 * 服务端只要这件商品有 SKU 包就给出 D/E 运行状态和账户只读核验两份记录，还在写文案的商品也有——那时候摆出来只是一串
 * 「还不能写入」的缺口。这里只看已经保存的记录走到了哪一步，不探测、不读平台。
 */
export function showsProductPublish(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  if (candidate?.workflowStatus === "listed") return true;
  if (candidate?.dESavedJobRuntimeView) return true;
  if (/^[DE]/u.test(typeof sku?.businessPhase === "string" ? sku.businessPhase : "")) return true;
  return Boolean(sku?.productionAuthorization || sku?.dSoftwareExecution || sku?.productionRecord || sku?.eVerificationRecord);
}

/**
 * 上架与回读，放在这件商品自己的页面上。以前单件商品只能回旧版 A 卡去点「继续已保存任务」、看回读结果；这一节用的是
 * 同一张卡、同一组按钮、同一条服务端路由，只是挪到主人日常看的这一页。每个按钮只做卡上写的那一件事，结果未知时停下
 * 等主人核对，不自动重发（AGENTS.md §8.3）。
 */
export default function ProductPublishSection({ candidate, onContinueSavedDE = null, onDispatchDProductionRound = null,
  onRollbackProductionAuthorization = null, onRecoverDInitialImport = null, onReobserveDUnknownOutcome = null,
  onReconcileDFromPlatformState = null, onAuthorizeAccountRead = null, onContinueAccountRead = null }) {
  if (!showsProductPublish(candidate)) return null;
  const bind = handler => typeof handler === "function" ? payload => handler(candidate.id, payload) : null;
  return <section className="product-section product-publish" aria-label="上架与回读">
    <h3>上架与回读</h3>
    <p className="product-section-hint">这里是这件商品往 Ozon 上架的那一轮作业，以及上架后软件独立读回来的结果。
      每个按钮只做它上面写的那一件事；结果未知时软件停下等你核对，不会自己重发。</p>
    {candidate.ozonAccountReadPreparation ? <OzonAccountReadCard preparation={candidate.ozonAccountReadPreparation}
      onAuthorize={onAuthorizeAccountRead} onContinue={onContinueAccountRead} /> : null}
    <DESoftwareRuntimeCard runtime={candidate.dESoftwareRuntimeView} readback={candidate.eReadbackRuntimeView}
      savedJobRuntime={candidate.dESavedJobRuntimeView ?? null}
      onContinueSaved={bind(onContinueSavedDE)}
      onDispatchNewRound={bind(onDispatchDProductionRound)}
      onRollbackAuthorization={bind(onRollbackProductionAuthorization)}
      onRecoverInitialImport={bind(onRecoverDInitialImport)}
      onReobserveUnknownOutcome={bind(onReobserveDUnknownOutcome)}
      onReconcileFromPlatformState={bind(onReconcileDFromPlatformState)} />
  </section>;
}
