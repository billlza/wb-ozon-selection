import { useState } from "react";
import { useSubmit } from "./FormRevisionNotice.jsx";
import { productionAuthorizationInputFromCard } from "../productionAuthorizationInput.js";

/**
 * 「上架」那一下。主人在卡上看完，填货号、（多个仓库时）选仓库、勾一句、点一次。服务端依次保存图片确认（文案由软件
 * 直接送进传图的，连同文案确认）、生产授权和写入前那一次只读核验许可（lib/gate2-listing.mjs）；三条记录各自独立，
 * 这里把三件事都写明，不让一个勾悄悄多管一件。
 */
export default function Gate2ListingForm({ candidate, identity, listing }) {
  const sku = candidate.lifecycleV11.skuPackage;
  const card = sku.productionConfirmationCard;
  const preparation = candidate.productionOwnerPreparation;
  const readiness = productionAuthorizationInputFromCard(candidate, card);
  const bindings = preparation?.executionBindings ?? [];
  const [merchantSku, setMerchantSku] = useState(preparation?.commercialDraft?.merchantSku ?? "");
  const [bindingId, setBindingId] = useState(bindings.length === 1 ? bindings[0].bindingId : "");
  const [confirmed, setConfirmed] = useState(false);
  const { saving, error, run } = useSubmit();
  const binding = bindings.find(item => item.bindingId === bindingId);
  const store = preparation?.store?.displayName ?? "这个店铺";
  const scope = readiness.ready ? preparation.scope : null;
  // 软件按「做这件」的许可把文案直接送进了传图的，文案也在这一下确认（服务端记成主人的文案确认）。
  const copyAtListing = candidate.c1ContentReviewView?.status === "awaiting_listing";
  const canList = identity?.canSaveProductionOwnerDecision === true && readiness.ready && Boolean(binding) &&
    Boolean(merchantSku.trim()) && confirmed && !saving && typeof listing.onList === "function";
  function list(event) {
    event.preventDefault();
    return run(async () => {
      if (!canList) throw new Error("货号、仓库或那一句确认还没填好。");
      await listing.onList({ dataRevision: candidate.dataRevision, previewFingerprint: listing.previewFingerprint,
        merchantSku: merchantSku.trim(), bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, confirmed: true });
    });
  }
  return <form className="production-owner-decision-form gate2-listing-form" onSubmit={list}>
    <b>上架</b>
    {identity?.canSaveProductionOwnerDecision !== true ? <p role="status">要先登录主人身份才能上架。</p> : null}
    {readiness.ready ? <fieldset disabled={saving}>
      <p>店铺：{store}{bindings.length === 1 ? ` · 仓库：${bindings[0].warehouseName}` : ""}</p>
      {bindings.length > 1 ? <label>仓库<select required value={bindingId} onChange={event => { setBindingId(event.target.value); setConfirmed(false); }}>
        <option value="">选一个仓库</option>
        {bindings.map(item => <option key={item.bindingId} value={item.bindingId}>{item.warehouseName}</option>)}
      </select></label> : null}
      <label>本店商品货号<input required value={merchantSku} autoComplete="off"
        onChange={event => { setMerchantSku(event.target.value); setConfirmed(false); }} /></label>
      <p>售价 {scope.buyerTargetPrice.amount} ₽（后台写入 {scope.platformWritePrice.amount} 元）· 库存 {scope.stock} 件 ·
        {scope.publishScope === "create_draft_only" ? " 只存草稿" : " 提交审核"}。</p>
      <label className="production-owner-scope-confirmation"><input type="checkbox" checked={confirmed}
        onChange={event => setConfirmed(event.target.checked)} />
        <span>我看过这张卡。按上面的图片、文案和价格，在{store}上架这件商品。</span></label>
    </fieldset> : <p role="status">{readiness.reason}</p>}
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" className="button primary" disabled={!canList}>{saving ? "正在上架…" : "上架"}</button>
    <small>点一下依次保存三件事：{copyAtListing ? "这份文案和这些图片作为上架内容" : "这些图片作为上架素材"}；按这张卡写入{store}的授权；写入前读一次店铺后台（只读，最多三次请求，
      {listing.accountReadHours ?? 24} 小时内有效）。哪一步没过就停在那一步，已保存的照原样留着，软件不会自己再发。</small>
  </form>;
}
