import { useSubmit } from "./FormRevisionNotice.jsx";

const itemLabel = path => path === "output.title" ? "标题" : path === "output.description" ? "描述"
  : path.startsWith("output.bulletPoints[") ? `卖点 ${Number(path.match(/\[(\d+)\]/)[1]) + 1}`
    : `搜索词 ${Number(path.match(/\[(\d+)\]/)[1]) + 1}`;

function BilingualText({ item }) {
  return <><p lang="ru" style={{ whiteSpace: "pre-wrap" }}>{item.text}</p>
    {item.reviewZh ? <p lang="zh-CN" style={{ whiteSpace: "pre-wrap" }}>中文释义：{item.reviewZh}</p> : null}</>;
}

export default function C1EditorialReviewPanel({ candidate, identity, onConfirm, provisional = false }) {
  const { saving, error, run } = useSubmit();
  const view = candidate?.c1EditorialReviewView;
  if (!view || view.status === "not_applicable") return null;
  if (view.status === "blocked") return <section className="product-section" aria-label="文案修订核对">
    <h3>文案修订需要重新核对</h3>
    <p role="alert">当前商品或修订来源与准备时不一致，尚不能确认。请刷新；如仍出现此提示，需要技术维护核对已有记录，不必重新填写商品事实。</p>
  </section>;
  const readOnly = provisional || view.status === "proposal_only";
  if (view.status === "confirmed" && !readOnly) return <section className="product-section" aria-label="文案修订核对">
    <h3>修订文案已确认</h3><p>{view.finalCardCreated ? "方案卡已更新，原图片、首图和顺序确认已保留。" : "可以准备本规格的图片。"}原文案、修订依据及原调用用量均已保留。</p>
  </section>;
  const content = view.content;
  const canConfirm = !readOnly && view.canConfirm && identity?.roles?.includes("owner") && typeof onConfirm === "function" && !saving;
  return <section className="product-section" aria-label="核对修订文案">
    <h3>{readOnly ? "修订文案预览（未确认）" : "核对修订文案"}</h3>
    {readOnly
      ? <p>这是基于已保存原稿整理的本地修订提案。原稿和调用记录均已保留；本次没有重新调用文案服务，也没有保存确认或推进流程。</p>
      : <p>这是原文案的修订版，原稿和调用记录仍保留；没有重新调用文案服务。{view.restoresConfirmedAssets ? "确认后更新方案卡，并保留原图片、首图和顺序确认。" : "请核对下面实际准备采用的内容，确认后进入图片。"}</p>}
    <h4>标题</h4><BilingualText item={content.title} />
    <h4>描述</h4><BilingualText item={content.description} />
    <h4>卖点</h4><ul>{content.bulletPoints.map((item, index) => <li key={index}><BilingualText item={item} /></li>)}</ul>
    <h4>搜索词</h4>{content.searchKeywords.length ? <ul>{content.searchKeywords.map((item, index) =>
      <li key={index}><BilingualText item={item} /></li>)}</ul> : <p>没有采用搜索词</p>}
    <details open={readOnly}><summary>查看原文、修订内容和依据</summary>
      {view.changes.map(change => <div key={change.path}>
        <h4>{itemLabel(change.path)}</h4><p>原文：{change.before.text}</p>
        {change.before.reviewZh ? <p>原中文释义：{change.before.reviewZh}</p> : null}
        <p>修订：{change.after.text}</p>
        {change.after.reviewZh ? <p>修订后中文释义：{change.after.reviewZh}</p> : null}
        <p>依据：{change.explanation}</p>
      </div>)}
    </details>
    {!readOnly ? <><p>本次确认仅采用本规格的属性与修订文案；不会生成图片，也不会提交上架。</p>
    <button type="button" className="button primary" disabled={!canConfirm} onClick={() => run(() => onConfirm({
      candidateId: candidate.id, expectedRevision: view.expectedRevision,
      editorialVersionId: view.editorialVersionId, outputFingerprint: view.outputFingerprint, confirmed: true,
      idempotencyKey: `c1-editorial:${candidate.id}:${view.expectedRevision}:${view.outputFingerprint}`,
      auditEventId: `c1-editorial-audit:${candidate.id}:${view.expectedRevision}`
    }))}>{saving ? "正在保存修订确认…" : view.restoresConfirmedAssets ? "确认修订文案并更新方案卡" : "确认修订文案，进入图片"}</button>
    {error ? <p role="alert">{error}</p> : null}</> : null}
  </section>;
}
