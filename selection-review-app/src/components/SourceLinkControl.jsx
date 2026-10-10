import { useState } from "react";
import { sourceLinkCheck } from "../../lib/global-notices.mjs";
import { errorMessage } from "../formState.js";
import { sourceLinkPayload, sourceLinkRefusal, sourceLinkResult } from "../selectionDeskView.js";

/**
 * 贴货源链接 on one product (item 9 of the 2026-10-10 list). One click opens a single field; the link is checked to be
 * a 1688 or 拼多多 page and sent once to the intake pipeline, which reads it. Pasted on a product, the link attaches to
 * that product and its reading starts over; pasted on a market row, it becomes a product of its own. A link pasted
 * before is never a second card: the answer names the card it already belongs to, with a way to open it.
 * Nothing runs until the owner submits.
 */
export default function SourceLinkControl({ target, disabled = false, onSubmit, onOpenCandidate }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  async function submit(event) {
    event.preventDefault();
    if (busy || typeof onSubmit !== "function") return;
    const check = sourceLinkCheck(value);
    if (!check.ok) { setError(check.reason); return; }
    setBusy(true); setError(null);
    try {
      setResult(sourceLinkResult(await onSubmit(sourceLinkPayload(check.link, target))));
      setOpen(false); setValue("");
    } catch (cause) {
      // A link that already belongs to another card is an answer, not a failure: it says which card.
      const refusal = sourceLinkRefusal(cause);
      if (refusal !== null) { setResult(refusal); setOpen(false); setValue(""); }
      else setError(errorMessage(cause));
    }
    finally { setBusy(false); }
  }
  if (result !== null) {
    return <span className="source-link-result" role="status">{result.message}
      {result.candidateId && typeof onOpenCandidate === "function"
        ? <button type="button" className="button secondary" onClick={() => onOpenCandidate(result.candidateId)}>打开那件</button> : null}
    </span>;
  }
  if (!open) {
    return <button type="button" className="button secondary source-link-button" disabled={disabled || typeof onSubmit !== "function"}
      onClick={() => setOpen(true)}>贴货源链接</button>;
  }
  return <form className="source-link-form" onSubmit={submit}>
    <label>1688 或拼多多商品链接（要能一件起订）
      <input type="url" value={value} placeholder="https://detail.1688.com/offer/…" disabled={busy}
        onChange={event => { setValue(event.target.value); setError(null); }} />
    </label>
    <button type="submit" className="button primary" disabled={busy}>{busy ? "正在提交…" : "用这个货源"}</button>
    <button type="button" className="button secondary" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>取消</button>
    {error ? <span role="alert">{error}</span> : null}
  </form>;
}
