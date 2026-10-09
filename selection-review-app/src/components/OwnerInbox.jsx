import { useState } from "react";
import { eliminatedRows, inboxItems, storeLabel } from "../selectionDeskView.js";
import { errorMessage } from "../formState.js";
import EliminateControl, { EliminatedFold } from "./EliminateControl.jsx";

/**
 * Every product that is waiting on the owner, one row each — and, since 2026-09-11, each row says what it is waiting
 * for and offers the one next thing to do. Owner feedback: "还有 5 条需要我处理，我不能直观看到它要处理什么，得挨个打开."
 * Every sentence comes from that product's own saved records; opening a row only shows it, it starts no work.
 */
export default function OwnerInbox({ candidates, store, onOpenCandidate,
  onEliminateCandidate, onRestoreCandidate }) {
  const items = inboxItems(candidates, store);
  const dropped = eliminatedRows(candidates, store);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  async function run(action, payload, done) {
    if (typeof action !== "function") return;
    setError(null); setNotice(null);
    try { await action(payload); setNotice(done); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  // Every row, 去选规格 included, opens that product's own page: since 2026-09-13 选规格 is a step of the page itself,
  // so nothing sends the owner to the old engineering card any more.
  const open = item => onOpenCandidate(item.id);
  return <div className="page-panel inbox-page">
    <header className="inbox-header">
      <h2>需要你处理</h2>
      <p>{storeLabel(store)} · 共 {items.length} 条等你。处理完一条，它会自己从这里消失。</p>
    </header>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status" className="desk-notice">{notice}</p> : null}
    {items.length === 0 ? <p role="status">现在没有等你处理的商品。</p> : <ul className="inbox-list">
      {items.map(item => <li key={item.id}>
        <div className="inbox-row-body">
          <b>{item.title}</b>
          <ul className="inbox-row-reasons">
            {item.reasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
          <span className="inbox-row-status">{item.storeLabel} · {item.statusLine}</span>
        </div>
        <div className="inbox-row-actions">
          <button type="button" className="button primary" onClick={() => open(item)}>{item.action.label}</button>
          <button type="button" className="button secondary" onClick={() => onOpenCandidate(item.id)}>打开</button>
          <EliminateControl id={item.id} dataRevision={item.dataRevision}
            onEliminate={({ id, dataRevision, reason }) => run(onEliminateCandidate, { id, dataRevision, reason },
              "已淘汰，它折在下面的「已淘汰」里，随时可以恢复。")} />
        </div>
      </li>)}
    </ul>}
    <EliminatedFold rows={dropped} onRestore={payload => run(onRestoreCandidate, payload,
      "已恢复，它回到了淘汰前的那一步；没有自动继续任何事。")} />
  </div>;
}
