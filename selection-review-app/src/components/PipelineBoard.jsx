import { useState } from "react";
import { boardColumns, eliminatedRows, storeLabel } from "../selectionDeskView.js";
import { errorMessage } from "../formState.js";
import EliminateControl, { EliminatedFold } from "./EliminateControl.jsx";

function BoardCard({ card, busy, onOpenCandidate, onAction, onEliminate }) {
  // 淘汰不在卡面上：收在「更多」里，打开商品和淘汰永远不是同一下。合起来的卡按颜色各给一个。
  const targets = card.members.length > 1 ? card.members : [{ id: card.id, dataRevision: card.dataRevision, label: null }];
  return <div className={`board-card-shell${card.stuck ? " stuck" : ""}`} data-testid="board-card">
    <button type="button" className="board-card" onClick={() => onOpenCandidate(card.id)}>
      {card.imageUrl
        ? <img src={card.imageUrl} alt="" width="40" height="40" loading="lazy" referrerPolicy="no-referrer" />
        : <span className="board-card-thumb-empty">主图</span>}
      <span className="board-card-body">
        <b>{card.title}</b>
        <span className="board-card-status">{card.statusLine}{card.positionLine ? ` · ${card.positionLine}` : ""}</span>
        {card.stuck ? <span className="board-card-stuck">卡住了{card.stuckLine ? `：${card.stuckLine}` : ""}</span> : null}
        {card.waitingLine === null ? null : <span className="board-card-waiting">等你：{card.waitingLine}</span>}
        {card.roughProfit ? <span className={`intake-chip ${card.roughProfit.tone}`}>{card.roughProfit.label}</span> : null}
      </span>
    </button>
    {/* 同一件货的几个颜色合在这张卡上；点颜色打开那个颜色自己的商品页。 */}
    {card.members.length > 1
      ? <ul className="board-card-colours" aria-label={`${card.title} 的颜色`}>
        {card.members.map(member => <li key={member.id}>
          <button type="button" className="intake-link" onClick={() => onOpenCandidate(member.id)}>{member.label}</button>
          <span>{member.statusLine}</span>
        </li>)}
      </ul>
      : null}
    {card.elsewhereLine ? <span className="board-card-elsewhere">{card.elsewhereLine}</span> : null}
    <div className="board-card-actions">
      {card.action ? <button type="button" className={`button ${card.action.key === "open" ? "primary" : "secondary"}`} disabled={busy}
        onClick={() => onAction(card)}>{busy ? "正在提交…" : card.action.label}</button> : null}
      {typeof onEliminate === "function"
        ? <details className="board-card-more">
          <summary aria-label={`${card.title} 的更多操作`}>更多</summary>
          {targets.map(target => <EliminateControl key={target.id} id={target.id} dataRevision={target.dataRevision ?? null}
            label={target.label ? `淘汰「${target.label}」` : "淘汰"} onEliminate={onEliminate} />)}
        </details>
        : null}
    </div>
  </div>;
}

/**
 * 进行中：本店每件在做的商品在哪一步、卡没卡住、等不等你。点卡片打开那件商品；卡住的给一个按钮（接着找、重跑或核实、
 * 去处理），只在主人点时发一次。淘汰收在每张卡的「更多」里；已淘汰的折在最下面，可以恢复。
 */
export default function PipelineBoard({ candidates, store, discoveryView = null, intakeQueue = null, onOpenCandidate,
  onEliminateCandidate, onRestoreCandidate, onRetryIntake, onResumeIntake }) {
  const columns = boardColumns(candidates, store, { discoveryView, intakeQueue });
  const total = columns.reduce((count, column) => count + column.count, 0);
  const stuck = columns.reduce((count, column) => count + column.cards.filter(card => card.stuck).length, 0);
  const dropped = eliminatedRows(candidates, store, discoveryView);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  async function run(action, payload, done) {
    if (typeof action !== "function") return;
    setError(null); setNotice(null);
    try { await action(payload); setNotice(done); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  /** 卡上的一个按钮：去处理只是打开商品；接着找、重跑/核实各发一次，和录入页上的是同一个请求。 */
  async function act(card) {
    const action = card.action;
    if (action.key === "open") return onOpenCandidate(action.id ?? card.id);
    if (busyId !== null) return;
    setBusyId(card.id);
    try {
      if (action.key === "resume") await run(onResumeIntake, undefined, "已经让找货接着走；还卡着的会再停下来说为什么。");
      if (action.key === "retry") await run(() => onRetryIntake(card.id, action.dataRevision), undefined,
        action.label === "核实" ? "已记下上一次没收到结果；要再读一次就点「重跑」。" : "已重新排进找货队列。");
    } finally { setBusyId(null); }
  }
  return <div className="page-panel board-page">
    <header className="board-header">
      <h2>进行中</h2>
      <p>{storeLabel(store)} · 共 {total} 件在做的商品{stuck > 0 ? `，${stuck} 张卡卡住了` : ""}。同一件货的几个颜色合成一张卡。点一张卡片打开它的详情。</p>
    </header>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status" className="desk-notice">{notice}</p> : null}
    {total === 0 ? <p role="status">本店暂时没有在做的商品。</p> : null}
    <div className="board-columns">
      {columns.map(column => <section key={column.key} className="board-column" aria-label={column.title}>
        <h3>{column.title}<span>{column.count}</span></h3>
        {column.cards.length === 0 ? <p className="board-empty">这一步暂时没有商品。</p> : null}
        {column.cards.map(card => <BoardCard key={card.id} card={card} busy={busyId === card.id} onOpenCandidate={onOpenCandidate}
          onAction={act} onEliminate={typeof onEliminateCandidate === "function"
            ? ({ id, dataRevision, reason }) => run(onEliminateCandidate, { id, dataRevision, reason }, "已淘汰，它折在下面的「已淘汰」里，随时可以恢复。")
            : null} />)}
      </section>)}
    </div>
    <EliminatedFold rows={dropped} onRestore={payload => run(onRestoreCandidate, payload,
      "已恢复，它回到了淘汰前的那一步；没有自动继续任何事。")} />
  </div>;
}
