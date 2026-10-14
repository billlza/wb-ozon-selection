import { useEffect, useState } from "react";
import FinalProductPlanCard from "./FinalProductPlanCard.jsx";

/**
 * 「上架」卡：图排好之后，服务端按已保存资料预演出那张最终方案卡（lib/gate2-listing.mjs），主人看完点一次「上架」。
 * 卡已经生成、还没授权的（老商品，或上次停在授权那一步）也走这里，同一个按钮。预演单独取，不放进商品列表。
 */
export function gate2PreviewCandidate(candidate, preview) {
  if (!preview?.skuPackage?.productionConfirmationCard) return null;
  const sku = candidate.lifecycleV11.skuPackage;
  return { ...candidate, productionOwnerPreparation: preview.productionOwnerPreparation,
    lifecycleV11: { ...candidate.lifecycleV11, skuPackage: { ...sku, ...preview.skuPackage,
      c2FinalAssets: { ...sku.c2FinalAssets, ...preview.skuPackage.c2FinalAssets } } } };
}

export default function Gate2ListingCard({ candidate, identity, onLoadPreview, onList, onSaveFinalPricingReview, onReviseC1FinalPlan }) {
  const stage = candidate.gate2ListingView?.stage;
  const draftRevision = candidate.lifecycleV11?.c2UploadDraft?.revision ?? null;
  const key = `${candidate.id}:${candidate.dataRevision}:${draftRevision}:${stage}`;
  const [loaded, setLoaded] = useState({ key: null, preview: null, error: null });
  useEffect(() => {
    if (!["preview", "card"].includes(stage) || typeof onLoadPreview !== "function") return undefined;
    const controller = new AbortController();
    onLoadPreview(candidate.id, controller.signal)
      .then(body => { if (!controller.signal.aborted) setLoaded({ key, preview: body.preview, error: null }); })
      .catch(error => { if (!controller.signal.aborted) setLoaded({ key, preview: null, error: error.message || "上架卡没取到" }); });
    return () => controller.abort();
  }, [key]);
  if (!["preview", "card"].includes(stage)) return null;
  const current = loaded.key === key ? loaded : { preview: null, error: null };
  if (current.error) return <section className="product-section" aria-label="上架"><h3>上架</h3>
    <p role="alert">{current.error}。刷新一下再看；没有保存任何东西。</p></section>;
  if (!current.preview) return <section className="product-section" aria-label="上架"><h3>上架</h3>
    <p role="status">正在按已保存的资料准备上架卡…</p></section>;
  const preview = current.preview;
  const previewCandidate = gate2PreviewCandidate(candidate, preview);
  if (!previewCandidate) return <section className="product-section" aria-label="上架"><h3>上架</h3>
    <ul>{(preview.gaps ?? []).map(gap => <li key={gap.code}>{gap.message}</li>)}</ul>
    <p className="product-section-hint">这些处理好之后，这里会出现上架卡。没有保存任何东西。</p></section>;
  return <FinalProductPlanCard candidate={previewCandidate} identity={identity}
    onSaveFinalPricingReview={onSaveFinalPricingReview} onReviseC1FinalPlan={onReviseC1FinalPlan}
    listing={{ stage: preview.stage, previewFingerprint: preview.previewFingerprint, accountReadHours: preview.accountReadHours,
      onList, candidate }} />;
}
