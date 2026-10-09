import { useSubmit } from "./FormRevisionNotice.jsx";

export default function C1ContentReviewPanel({ candidate, identity, onConfirm }) {
  const { saving, error, run } = useSubmit();
  const view = candidate?.c1ContentReviewView;
  if (!view || view.status === "not_ready") return null;
  if (view.status === "invalid") return <p role="alert">商品内容记录异常，请核对保存记录。</p>;
  const canConfirm = view.canConfirm && identity?.roles?.includes("owner") && typeof onConfirm === "function" && !saving;
  return <section className="product-section" aria-label="核对商品内容">
    <h3>核对商品内容</h3>
    <p>请核对实际采用的俄语文案。确认后进入图片；最终上架仍需另行确认。</p>
    <h4>标题</h4><p>{view.title.text}</p>
    <h4>描述</h4><p style={{ whiteSpace: "pre-wrap" }}>{view.description.text}</p>
    <h4>卖点</h4><ul>{view.bulletPoints.map((item, index) => <li key={index}>{item.text}</li>)}</ul>
    <h4>搜索词</h4><p>{view.searchKeywords.keywords.map(item => item.query).join("、") || "没有采用搜索词"}</p>
    {view.canConfirm ? <>
      <p>确认范围包含本规格的商品属性及上述文案。内容不准确时请先修正，不要确认进入图片。</p>
      <button type="button" className="button primary" disabled={!canConfirm} onClick={() => run(() => onConfirm({
        candidateId: candidate.id, expectedRevision: view.expectedRevision,
        contentFingerprint: view.contentFingerprint, confirmed: true,
        idempotencyKey: `c1-content-review:${candidate.id}:${view.expectedRevision}`,
        auditEventId: `c1-content-review-audit:${candidate.id}:${view.expectedRevision}`
      }))}>{saving ? "正在保存确认…" : "确认商品内容，进入图片"}</button>
    </> : <p role="status">{view.status === "confirmed" ? "商品内容已确认，可以准备本规格的图片。"
      : view.status === "confirmation_missing" ? "这是已有文案记录，尚无新版内容确认记录。"
        : "商品内容与原确认不一致，请核对当前资料。"}</p>}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
