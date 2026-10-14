import FormRevisionNotice, { useCandidateForm, useSubmit } from "./FormRevisionNotice.jsx";
import { productionAuthorizationInputFromCard } from "../productionAuthorizationInput.js";

export default function ProductionOwnerDecisionForm({ candidate, identity, onSave, showReadinessReason = true }) {
  const sku = candidate.lifecycleV11.skuPackage;
  const card = sku.productionConfirmationCard;
  const preparation = candidate.productionOwnerPreparation;
  const readiness = productionAuthorizationInputFromCard(candidate, card);
  const [form, setForm, guard] = useCandidateForm({ id: candidate.id, dataRevision: card.cardRevision }, {
    sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: sku.dataRevision,
    merchantSku: preparation?.commercialDraft?.merchantSku ?? "", bindingId: "", configurationVersion: "", confirmed: false
  });
  const { saving, error, run } = useSubmit();
  const sourceChanged = form.sourceCandidateRevision !== candidate.dataRevision || form.sourceSkuRevision !== sku.dataRevision;
  const binding = preparation?.executionBindings?.find(item => item.bindingId === form.bindingId && item.configurationVersion === form.configurationVersion);
  const canSave = identity?.canSaveProductionOwnerDecision === true && readiness.ready && !sourceChanged && !guard.conflict &&
    Boolean(binding) && Boolean(form.merchantSku.trim()) && form.confirmed && !saving && Boolean(onSave);
  function field(key, value) { setForm(current => ({ ...current, [key]: value, confirmed: key === "confirmed" ? value : false })); }
  function selectBinding(value) {
    const selected = preparation.executionBindings.find(item => item.bindingId === value);
    setForm(current => ({ ...current, bindingId: selected?.bindingId || "", configurationVersion: selected?.configurationVersion || "", confirmed: false }));
  }
  function save(event) {
    event.preventDefault();
    return run(async () => {
      guard.assertCurrent();
      if (!canSave) throw new Error("身份、商品资料、仓库配置或准确范围尚未满足确认条件");
      await onSave({ ...readiness.input, bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
        merchantSku: form.merchantSku.trim(), confirmExactScope: true });
    });
  }
  const scope = readiness.ready ? preparation.scope : null;
  return <form className="production-owner-decision-form" onSubmit={save}>
    <b>确认本件商品并通过进入生产授权</b>
    {showReadinessReason ? <p>{readiness.reason}</p> : null}
    <FormRevisionNotice guard={guard} disabled={saving} />
    {sourceChanged ? <p role="alert">商品资料已更新，旧输入仍保留。<button type="button" onClick={guard.reload}>核对后载入新版</button></p> : null}
    {identity?.canSaveProductionOwnerDecision !== true ? <p role="status">正式主人身份尚不可用，不能保存生产授权。</p> : null}
    {readiness.ready ? <fieldset disabled={saving}>
      <p>店铺：{preparation.store.displayName} · 供应规格：{sku.supplierSkuId} · 最终图片：{card.c2Assets.finalUploads.length} 张。</p>
      <label>本店商品货号<input required value={form.merchantSku} onChange={event => field("merchantSku", event.target.value)} autoComplete="off" /></label>
      <label>已核验仓库<select required value={form.bindingId} onChange={event => selectBinding(event.target.value)}>
        <option value="">请选择仓库</option>
        {preparation.executionBindings.map(item => <option key={item.bindingId} value={item.bindingId}>{item.warehouseName}</option>)}
      </select></label>
      <p>买家目标成交价：{scope.buyerTargetPrice.amount} RUB · 后台写入价：{scope.platformWritePrice.amount} CNY。</p>
      <p>如需改价，请先使用下方“调整售价”。</p>
      <p>范围：仅本件商品的建卡、标题、描述、属性、价格、库存 {scope.stock}、已确认图片及{scope.publishScope === "create_draft_only" ? "保存草稿" : "提交审核"}；不包含其他商品、独立激活或广告操作。</p>
      <label className="production-owner-scope-confirmation"><input type="checkbox" checked={form.confirmed} onChange={event => field("confirmed", event.target.checked)} /><span>我确认当前商品、仓库、以上价格、库存、最终图片顺序和执行范围，授权按此方案生产。</span></label>
    </fieldset> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" className="button primary" disabled={!canSave}>{saving ? "正在保存授权…" : "通过进入生产授权"}</button>
    <small>此次确认保存生产授权和唯一任务。软件随后检查执行条件，满足后按上述范围上传素材、写入店铺并独立核验；条件不足时保存卡点并停止。</small>
  </form>;
}
