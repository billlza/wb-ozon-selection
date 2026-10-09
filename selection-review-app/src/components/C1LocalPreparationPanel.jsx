import { useSubmit } from "./FormRevisionNotice.jsx";
import { storeLabel } from "../selectionDeskView.js";

const STATUS = { confirmed: "已确认", not_supplied: "待补", scope_unresolved: "整款资料，本规格归属待核对", needs_review: "原确认需核对", dictionary_pending: "事实已确认，平台字典编号待补" };
const SCOPE = { supplier_product: "供应商整款资料", category: "已确认类目", sku: "当前规格/声明" };
const PURPOSE = { title: "标题", attributes: "属性/标签", description: "描述" };
function text(value) {
  if (value === null || value === undefined) return "未提供";
  if (value?.status === "unbranded" && value.name === null) return "主人已确认：无品牌";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function showsC1LocalPreparation(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  return ["C1", "C2"].includes(sku?.businessPhase) && sku.targetPlatform === "ozon";
}

export default function C1LocalPreparationPanel({ candidate, identity, onPrepare }) {
  const { saving, error, run } = useSubmit();
  const sku = candidate?.lifecycleV11?.skuPackage;
  if (!showsC1LocalPreparation(candidate)) return null;
  const saved = candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1;
  const material = saved?.schemaVersion === "c1-local-preparation-v2" ? saved : null;
  const adopted = Boolean(material && candidate.lifecycleV11.c1LocalDraftSourceV1?.materialFingerprint === material.materialFingerprint);
  const current = adopted || (material?.resultCandidateRevision === candidate.dataRevision && material?.sourceSkuRevision === sku.dataRevision);
  const canPrepareCopy = current && material?.status === "ready_for_review";
  const hasRequest = Boolean(candidate.lifecycleV11.c1AiDraftRequestV1);
  const choice = candidate.sourceCapture?.skuChoices?.find(item => String(item.sourceSkuId) === sku.supplierSkuId);
  const variant = choice?.attributes?.["规格"] || sku.supplierSkuId;
  const canPrepare = identity?.roles?.includes("owner") && typeof onPrepare === "function" && !saving;
  return <section className="product-section c1-local-preparation" aria-label="商品属性与关键词准备">
    <h3>商品属性与关键词准备</h3>
    <p><b>{variant}</b> · {storeLabel(sku.targetStore)} · SKU {sku.supplierSkuId}</p>
    <p>当前先核查这一规格；已选的其他颜色仍保留。只整理已保存的商品和对标资料，不产生采集或付费调用。</p>
    {!hasRequest && sku.businessPhase === "C1" ? <button className="button primary" type="button" disabled={!canPrepare}
      onClick={() => run(() => onPrepare({ candidateId: candidate.id, dataRevision: candidate.dataRevision,
        mode: canPrepareCopy ? "prepare_copy" : "saved_material_only" }))}>
      {saving ? "正在准备…" : canPrepareCopy ? "准备文案请求" : "准备商品属性与关键词"}
    </button> : null}
    {!identity?.roles?.includes("owner") ? <p>请先登录主人身份。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!material ? <p role="status">尚未保存本节点准备结果。已有属性确认仍保留；点击上方按钮后在这里查看。</p> : <>
      <p role="status">{!current ? "商品资料已变化，下面是历史准备结果，请重新整理当前资料。"
        : adopted ? "已保存的属性与关键词已用于本次文案请求。"
          : material.status === "ready_for_review" ? "属性与关键词已准备好，可以继续准备文案请求。" : "准备结果已保存，仍有缺项；已取得的资料如下。"}</p>
      <p>保存修订 {material.resultCandidateRevision} · {material.producedAt} · 仅本地准备</p>
      <h4>商品属性</h4>
      <div className="c1-ozon-attribute-rows"><table>
        <thead><tr><th>属性</th><th>已保存值</th><th>状态 / 归属</th><th>依据</th></tr></thead>
        <tbody>{material.attributes.filter(item => item.required || item.value !== null).map(item => <tr key={item.fieldKey}>
          <td>{item.label}{item.required ? "（必填）" : ""}</td><td>{text(item.value)}</td>
          <td>{STATUS[item.status]}<br /><small>{SCOPE[item.sourceScope]}</small></td>
          <td>{text(item.sourceValue)}{item.sourceRefs.length ? <details><summary>查看来源</summary>{item.sourceRefs.map(ref => <p key={ref}>{ref}</p>)}</details> : null}</td>
        </tr>)}</tbody>
      </table></div>
      <details><summary>查看其余未提供属性（{material.attributes.filter(item => !item.required && item.value === null).length}）</summary>
        <p>{material.attributes.filter(item => !item.required && item.value === null).map(item => item.label).join("、") || "无"}。未提供不等于不适用。</p>
      </details>
      <h4>关键词与用途</h4>
      <p>标题至少有一个合格商品类型词；标签和长尾可为空，不固定总词数。搜索量、转化数据：未知；本次未查询 Seerfar。</p>
      <div className="c1-ozon-attribute-rows"><table>
        <thead><tr><th>词语</th><th>允许用途</th><th>依据</th></tr></thead>
        <tbody>{material.keywords.map(item => <tr key={item.term}><td>{item.term}</td>
          <td>{item.purposes.map(purpose => PURPOSE[purpose]).join("、")}</td>
          <td>已确认属性与平台字典<details><summary>查看来源</summary>{item.sourceRefs.map(ref => <p key={ref}>{ref}</p>)}</details></td></tr>)}</tbody>
      </table></div>
      {!material.keywords.length ? <p>还没有可采用词，不用无关词补数量。</p> : null}
      <p>本次没有新编长尾表达。后续文案可按事实自然组织表达，不能据此声称已有搜索验证。</p>
      <details><summary>已采商品与对标措辞参考（{material.competitorTextSnapshots.length}）</summary>
        <p>这些是来源原文，未自动采用为本品关键词或商品事实。</p>
        {material.competitorTextSnapshots.map(item => <div key={item.snapshotId}><p>{item.title}</p><small>{item.collectedAt} · {item.sourceRef}</small></div>)}
      </details>
      <h4>后续文案使用规则</h4><ul>{material.writingRules.map(rule => <li key={rule}>{rule}</li>)}</ul>
      {material.gaps.length ? <><h4>剩余缺项</h4><ul>{material.gaps.map((item, index) => <li key={`${item.code}:${index}`}>{item.message}</li>)}</ul></> : null}
      <p>文案请求准备完成后，页面会显示本次生成许可。取得实际文案并确认内容后，再进入图片。</p>
    </>}
  </section>;
}
