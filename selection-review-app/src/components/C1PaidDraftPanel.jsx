import FormRevisionNotice, { useCandidateForm, useSubmit } from "./FormRevisionNotice.jsx";
import { buildC1PaidDraftInput, buildC1SavedDraftContinuationInput, buildC1KeywordHandoffRetryInput, buildC1DraftResultReadInput } from "../c1PaidDraftInput.js";
import { STORE_LABELS } from "../constants.js";

const STATUS = { queued: "许可已保存，等待软件执行", claimed: "软件正在执行", waiting_platform: "正在等待文案服务结果",
  completed: "已取得文案回执", failed: "本次处理已结束，未取得可采用的文案，请核对失败记录", unknown_outcome: "调用结果未知，需要先核对，不能再次调用" };

const TIMING_LABELS = [
  ["workbenchWaitSeconds", "工作台首次等待"], ["serviceGenerationSeconds", "服务生成"],
  ["resultReadSeconds", "本次读取"], ["totalElapsedSeconds", "总经过"]
];

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "暂无准确耗时";
  return `${seconds} 秒`;
}

export default function C1PaidDraftPanel({ candidate, identity, onAuthorize, onContinueSaved, onReadOriginalResult, onRetryKeywordHandoff, onContinuePreparation, showLegacyPreparation = true }) {
  const [form, setForm, guard] = useCandidateForm(candidate, { confirmed: false });
  const { saving, error, run } = useSubmit();
  const view = candidate.c1DraftRuntimeView;
  if (!view) return null;
  const sku = candidate.lifecycleV11.skuPackage;
  const ready = view.status === "awaiting_paid_confirmation" && view.canAuthorize === true;
  const canSubmit = ready && identity?.canAuthorizeC1PaidCall === true && form.confirmed && !saving && !guard.conflict && Boolean(onAuthorize);
  function submit(event) {
    event.preventDefault();
    return run(async () => {
      guard.assertCurrent();
      if (!canSubmit) throw new Error("请先登录主人身份，并核对本次文案请求。");
      await onAuthorize(buildC1PaidDraftInput({ candidate, confirmed: form.confirmed, sourceRevision: guard.sourceRevision }));
    });
  }
  const usage = view.accounting?.usage;
  return <form className="workflow-card" onSubmit={submit}>
    <h3>本件商品的文案制作</h3>
    <p>供应规格：{sku.supplierSkuId} · {sku.variantKey}。目标：{sku.targetPlatform === "wb" ? "WB" : "Ozon"} · {STORE_LABELS[sku.targetStore] ?? sku.targetStore}。</p>
    <p role="status">{view.message || STATUS[view.status] || "当前调用状态需要核对"}</p>
    {view.currentOwner ? <p>当前处理方：{view.currentOwner}。下一步：{view.nextAction}</p> : null}
    {["claimed", "waiting_platform"].includes(view.status) ? <p>当前阶段：{view.status === "claimed" ? "执行已许可任务" : "等待文案服务返回"}。
      本轮已等待：{durationText(view.timings?.activeWaitSeconds)}。这不是已完成的生成耗时。</p> : null}
    {Number.isFinite(view.timings?.activeReadWaitSeconds) ? <p>当前阶段：读取原任务结果。本次读取已等待：{durationText(view.timings.activeReadWaitSeconds)}。</p> : null}
    {view.jobId ? <>
      <dl>{TIMING_LABELS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{durationText(view.timings?.[key])}</dd></div>)}</dl>
      <p>耗时按已保存的起止时间计算。总经过包含等待再次读取的间隔，不代表服务一直在生成。</p>
    </> : null}
    {view.modelVersion ? <p>本次服务：{view.modelVersion}，最多调用一次。使用已保存的商品事实和关键词生成俄语标题、描述与搜索词草稿。</p> : null}
    {usage && usage !== "unknown" ? <p>实际用量：输入 {usage.prompt_tokens ?? "未知"}，输出 {usage.completion_tokens ?? "未知"}，合计 {usage.total_tokens ?? "未知"} tokens。金额以服务账单为准。</p>
      : view.jobId ? <p>实际用量尚未取得，金额未确认。</p> : null}
    {ready ? <>
      <p>本次会产生文案服务费用，实际用量与回执会保存。该许可只用于当前商品的这一次请求；失败或结果未知不会自动重发。</p>
      <FormRevisionNotice guard={guard} disabled={saving} />
      {identity?.canAuthorizeC1PaidCall !== true ? <p>请先登录主人身份后确认。</p> : null}
      <label className="c2-owner-confirmation"><input type="checkbox" disabled={saving || guard.conflict} checked={form.confirmed}
        onChange={event => setForm({ confirmed: event.target.checked })} /><span>我确认当前商品与文案范围，允许这一次付费调用。</span></label>
      <button className="button primary" disabled={!canSubmit} type="submit">{saving ? "正在保存并执行…" : "确认本件商品的一次文案调用"}</button>
    </> : null}
    {view.canRetryKeywordHandoff ? <>
      <FormRevisionNotice guard={guard} disabled={saving} />
      <button className="button primary" type="button" disabled={saving || guard.conflict || identity?.canAuthorizeC1PaidCall !== true || !onRetryKeywordHandoff}
        onClick={() => run(async () => { guard.assertCurrent(); await onRetryKeywordHandoff(buildC1KeywordHandoffRetryInput({ candidate, sourceRevision: guard.sourceRevision })); })}>
        {saving ? "正在准备文案请求…" : "继续准备文案"}
      </button>
    </> : null}
    {showLegacyPreparation && view.status === "evidence_required" && !view.canRetryKeywordHandoff ? <>
      <FormRevisionNotice guard={guard} disabled={saving} />
      <p>还没有准备好这一次文案请求。这一步只用本机已冻结的商品事实和竞品文本生成关键词准备证据，
        <strong>不查询关键词、不产生任何付费调用</strong>；付费那一次仍然要你在下面单独许可。</p>
      <button className="button secondary" type="button"
        disabled={saving || guard.conflict || identity?.canAuthorizeC1PaidCall !== true || !onContinuePreparation}
        onClick={() => run(async () => { guard.assertCurrent();
          await onContinuePreparation({ candidateId: candidate.id, dataRevision: guard.sourceRevision }); })}>
        {saving ? "正在准备文案素材…" : "继续准备文案素材"}
      </button>
    </> : null}
    {view.canReadOriginalResult ? <>
      <FormRevisionNotice guard={guard} disabled={saving} />
      <p>只读取这一次已提交任务。读到文案并通过核验后会显示内容；尚未完成则明确提示，等待你再次读取。</p>
      <button className="button primary" type="button" disabled={saving || guard.conflict || identity?.canAuthorizeC1PaidCall !== true || !onReadOriginalResult}
        onClick={() => run(async () => { guard.assertCurrent(); await onReadOriginalResult(buildC1DraftResultReadInput({ candidate, sourceRevision: guard.sourceRevision })); })}>
        {saving ? "正在读取本次结果…" : "读取本次文案结果"}
      </button>
    </> : null}
    {view.canContinueSaved ? <>
      <FormRevisionNotice guard={guard} disabled={saving} />
      <p>{view.status === "completed" ? "回执已经保存，可继续应用到商品。" : "已保存这一次许可，原任务尚未发送，可继续执行。"}</p>
      <button className="button primary" type="button" disabled={saving || guard.conflict || identity?.canAuthorizeC1PaidCall !== true || !onContinueSaved}
        onClick={() => run(async () => { guard.assertCurrent(); await onContinueSaved(buildC1SavedDraftContinuationInput({ candidate, sourceRevision: guard.sourceRevision })); })}>
        {saving ? "正在继续已保存任务…" : "继续已许可任务"}
      </button>
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
