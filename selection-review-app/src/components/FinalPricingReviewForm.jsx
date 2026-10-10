import FormRevisionNotice, { useCandidateForm, useSubmit } from './FormRevisionNotice.jsx';
import { buildFinalPricingReviewInput, newFinalPricingReview, FINAL_PRICING_FACT_LABELS } from '../finalPricingReviewInput.js';

export default function FinalPricingReviewForm({ candidate, onSave, disabled = false }) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const snapshots = candidate.salesSnapshotsV11 || [];
  const profit = sku?.profitModels?.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
  const [form, setForm, guard] = useCandidateForm(candidate, { selectedPriceRub: '', reviews: [] });
  const { saving, error, run } = useSubmit();
  const reviewable = sku?.businessPhase === 'C2' || (sku?.businessPhase === 'B' && candidate.lifecycleV11.finalPricingReviewStatus === 'profit_rejected');
  const locked = disabled || saving || guard.conflict || !onSave || !reviewable || Boolean(sku?.productionAuthorization || sku?.productionRecord || sku?.dHandoff);
  function change(snapshotId, update) {
    setForm(value => ({ ...value, reviews: value.reviews.map(review => review.snapshotId === snapshotId ? update(review) : review) }));
  }
  function save() {
    return run(async () => {
      guard.assertCurrent();
      await onSave(buildFinalPricingReviewInput({ candidate, sourceRevision: guard.sourceRevision, ...form }));
    });
  }
  return <section className="workflow-card" aria-label="最终定价多样本比较">
    <h3>最终定价多样本比较</h3>
    <p>本表用于主人主动复核或调整售价，只使用已保存资料，不打开外站。有效且达到批准门槛的正式方案优先沿用，不要求为价格差异重复研究。</p>
    <p>已保存成交价：{profit?.recommendedSalePriceRub ?? '未取得'} RUB。提交本表时，仍须完成所选样本的核验。</p>
    <FormRevisionNotice guard={guard} disabled={saving} />
    {error && <p role="alert">{error}</p>}
    <p>已选择 {form.reviews.length} 条待审样本，尚不代表有效可比样本数量。</p>
    {form.reviews.length < 3 && <p>当前选择不足3条；2条有效样本可比较并保留不足3条提示，只有1条不能形成最终比较。</p>}
    {!snapshots.length && <p>没有已保存销售样本，请先补充可追溯资料。</p>}
    <fieldset disabled={locked}>
      <legend>选择已保存样本并逐项核对</legend>
      {snapshots.map(snapshot => {
        const review = form.reviews.find(item => item.snapshotId === snapshot.snapshotId);
        return <div key={snapshot.snapshotId}>
          <label><input type="checkbox" checked={Boolean(review)} onChange={event => setForm(value => ({ ...value, reviews: event.target.checked ? [...value.reviews, newFinalPricingReview(snapshot.snapshotId)] : value.reviews.filter(item => item.snapshotId !== snapshot.snapshotId) }))} />{snapshot.title} · {snapshot.currentPrice} {snapshot.currency} · {snapshot.snapshotId}</label>
          <small>保存来源：{snapshot.evidenceRef} · 采集时间：{snapshot.collectedAt}</small>
          {review && <>
            {Object.entries(FINAL_PRICING_FACT_LABELS).map(([key, label]) => <div key={key}>
              <label>{label}<select value={review[key].value} onChange={event => change(snapshot.snapshotId, item => ({ ...item, [key]: { ...item[key], value: event.target.value } }))}><option value="">尚未核对</option><option value="true">已核实是</option><option value="false">已核实否，排除此样本</option></select></label>
              <label>{label}来源引用<input maxLength={500} value={review[key].evidenceRef} onChange={event => change(snapshot.snapshotId, item => ({ ...item, [key]: { ...item[key], evidenceRef: event.target.value } }))} /></label>
            </div>)}
            <label>销量证据<select value={review.salesWindow ? 'provided' : 'missing'} onChange={event => change(snapshot.snapshotId, item => ({ ...item, salesWindow: event.target.value === 'missing' ? null : { count: '', startDate: '', endDate: '', dayCount: '', provenance: '', evidenceRef: '', validityStatus: 'unknown', validityEvidenceRef: '' } }))}><option value="missing">缺少，不猜销量或周期</option><option value="provided">填写已取得的周期和来源</option></select></label>
            {review.salesWindow && <div>
              {[['count', '周期销量', 'number'], ['startDate', '周期开始', 'date'], ['endDate', '周期结束', 'date'], ['dayCount', '来源明确的统计天数', 'number'], ['evidenceRef', '销量来源引用', 'text'], ['validityEvidenceRef', '时效核验来源引用', 'text']].map(([key, label, type]) => <label key={key}>{label}<input type={type} value={review.salesWindow[key]} onChange={event => change(snapshot.snapshotId, item => ({ ...item, salesWindow: { ...item.salesWindow, [key]: event.target.value } }))} /></label>)}
              <label>销量来源类型<select value={review.salesWindow.provenance} onChange={event => change(snapshot.snapshotId, item => ({ ...item, salesWindow: { ...item.salesWindow, provenance: event.target.value } }))}><option value="">尚未明确</option><option value="official_actual">官方实际销量</option><option value="third_party_estimate">第三方估算销量</option></select></label>
              <label>销量时效<select value={review.salesWindow.validityStatus} onChange={event => change(snapshot.snapshotId, item => ({ ...item, salesWindow: { ...item.salesWindow, validityStatus: event.target.value } }))}><option value="unknown">未核验</option><option value="current">已核验当前适用</option><option value="expired">已失效</option></select></label>
            </div>}
            <label>已发现的异常<select value={review.anomaly?.reason || ''} onChange={event => change(snapshot.snapshotId, item => ({ ...item, anomaly: event.target.value ? { reason: event.target.value, evidenceRef: '' } : null }))}><option value="">未记录异常</option><option value="brand_difference">品牌差异</option><option value="promotion">促销</option><option value="specification_difference">规格差异</option><option value="anomalous_price">异常价格</option></select></label>
            {review.anomaly && <label>异常来源引用<input value={review.anomaly.evidenceRef} onChange={event => change(snapshot.snapshotId, item => ({ ...item, anomaly: { ...item.anomaly, evidenceRef: event.target.value } }))} /></label>}
          </>}
        </div>;
      })}
      <label>主人选择的最终成交价（RUB）<input type="number" min="0.01" step="0.01" value={form.selectedPriceRub} onChange={event => setForm(value => ({ ...value, selectedPriceRub: event.target.value }))} /></label>
    </fieldset>
    <p>改价会创建新利润版本并重建依赖的冻结资料；浏览器不计算利润。保存比较不等于生产授权。</p>
    <button type="button" disabled={locked || form.reviews.length === 0} onClick={save}>保存最终定价比较</button>
  </section>;
}
