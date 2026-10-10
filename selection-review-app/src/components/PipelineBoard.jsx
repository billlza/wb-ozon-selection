import { useState } from "react";
import { boardColumns, eliminatedRows, storeLabel } from "../selectionDeskView.js";
import { errorMessage } from "../formState.js";
import EliminateControl, { EliminatedFold } from "./EliminateControl.jsx";

/** Five plain columns for one store. Clicking a card opens that product in the review board; nothing is started here. */
export default function PipelineBoard({ candidates, store, onOpenCandidate, onEliminateCandidate, onRestoreCandidate }) {
  const columns = boardColumns(candidates, store);
  const total = columns.reduce((count, column) => count + column.cards.length, 0);
  const dropped = eliminatedRows(candidates, store);
  const revisions = new Map((Array.isArray(candidates) ? candidates : []).map(candidate => [candidate?.id, candidate?.dataRevision]));
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  async function run(action, payload, done) {
    if (typeof action !== "function") return;
    setError(null); setNotice(null);
    try { await action(payload); setNotice(done); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  return <div className="page-panel board-page">
    <header className="board-header">
      <h2>进行中</h2>
      <p>{storeLabel(store)} · 共 {total} 件在做的商品。点一张卡片打开它的详情。</p>
    </header>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status" className="desk-notice">{notice}</p> : null}
    {total === 0 ? <p role="status">本店暂时没有在做的商品。</p> : null}
    <div className="board-columns">
      {columns.map(column => <section key={column.key} className="board-column" aria-label={column.title}>
        <h3>{column.title}<span>{column.cards.length}</span></h3>
        {column.cards.length === 0 ? <p className="board-empty">这一步暂时没有商品。</p> : null}
        {column.cards.map(card => <div key={card.id} className="board-card-shell">
          <button type="button" className="board-card" onClick={() => onOpenCandidate(card.id)}>
            {card.imageUrl
              ? <img src={card.imageUrl} alt="" width="40" height="40" loading="lazy" referrerPolicy="no-referrer" />
              : <span className="board-card-thumb-empty">主图</span>}
            <span className="board-card-body">
              <b>{card.title}</b>
              <span className="board-card-status">{card.statusLine}</span>
              {card.waitingLine === null ? null : <span className="board-card-waiting">等你：{card.waitingLine}</span>}
            </span>
          </button>
          {/* 淘汰 sits outside the card button so opening a product and dropping it can never be the same click. */}
          <EliminateControl id={card.id} dataRevision={revisions.get(card.id) ?? null}
            onEliminate={({ id, dataRevision, reason }) => run(onEliminateCandidate, { id, dataRevision, reason },
              "已淘汰，它折在下面的「已淘汰」里，随时可以恢复。")} />
        </div>)}
      </section>)}
    </div>
    <EliminatedFold rows={dropped} onRestore={payload => run(onRestoreCandidate, payload,
      "已恢复，它回到了淘汰前的那一步；没有自动继续任何事。")} />
  </div>;
}
