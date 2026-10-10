import { useState } from "react";
import { DECLINE_REASONS } from "../selectionDeskView.js";

/**
 * 淘汰 in one place, so the desk, the board, the inbox and the product page all say the same sentence and send the
 * same request. Owner rule 2026-09-11: one click arms it, one short line says what will happen, and a second click
 * does it — never a dialog inside a dialog. The reason is optional and can only be one of the words the desk already
 * offers; nothing here is free text, and nothing here starts or cancels any work.
 */
export default function EliminateControl({ id, dataRevision, disabled = false, label = "淘汰", onEliminate }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(reason) {
    if (busy || typeof onEliminate !== "function") return;
    setBusy(true);
    // A refusal is reported by the list this control sits in, which is where the owner is already looking; swallowing
    // it here only keeps the click from becoming an unhandled rejection, and the control closes either way.
    try { await onEliminate({ id, dataRevision, reason }); }
    catch { /* reported by the surrounding list */ }
    finally { setArmed(false); setBusy(false); }
  }
  if (!armed) {
    return <button type="button" className="button secondary eliminate-button" disabled={disabled}
      onClick={() => setArmed(true)}>{label}</button>;
  }
  return <span className="eliminate-confirm" role="group" aria-label="确认淘汰">
    <span className="eliminate-confirm-line">确定淘汰这件？它会从各个列表里消失，随时能在「已淘汰」里恢复。</span>
    <span className="eliminate-confirm-reasons">
      <span className="eliminate-confirm-hint">顺便记个理由（可不选）：</span>
      {DECLINE_REASONS.map(reason => <button key={reason} type="button" className="button secondary" disabled={busy}
        onClick={() => run(reason)}>{reason}</button>)}
      <button type="button" className="button primary" disabled={busy} onClick={() => run(null)}>直接淘汰</button>
      <button type="button" className="button secondary" disabled={busy} onClick={() => setArmed(false)}>取消</button>
    </span>
  </span>;
}

/**
 * What the owner already dropped, folded away at the bottom of the list it was dropped from. Every row can come back
 * with one click; the reason and the time are shown exactly as they were saved.
 */
export function EliminatedFold({ rows, onRestore, disabled = false, title = "已淘汰" }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return <details className="desk-folded eliminated-fold">
    <summary>{title} {rows.length}（默认隐藏）</summary>
    <ul className="eliminated-list">
      {rows.map(row => <li key={row.id} className="eliminated-row">
        <span className="eliminated-body">
          <b>{row.title}</b>
          <span className="eliminated-meta">{row.reasonLine} · {row.eliminatedAtLabel}</span>
        </span>
        <button type="button" className="button secondary" disabled={disabled}
          onClick={() => typeof onRestore === "function" && onRestore({ id: row.id, dataRevision: row.dataRevision })}>恢复</button>
      </li>)}
    </ul>
  </details>;
}
