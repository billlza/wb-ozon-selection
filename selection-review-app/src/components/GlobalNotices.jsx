import { useEffect, useMemo, useState } from "react";
import { failedRunTodos, globalNotices } from "../../lib/global-notices.mjs";
import { deskErrorMessage, newRoundPlan, roundStartPayload } from "../selectionDeskView.js";

const QUEUE_POLL_MS = 10000;
/** Page-wide stops the intake page's own pause line already names. */
const INTAKE_PAGE_NOTICES = Object.freeze(["slider_required", "login_pinduoduo_required"]);
const QUEUE_POLL_MAX_MS = 60000;

/**
 * The intake queue's extension flags (1688 login, plugin online). One request at a time, dropped on unmount; a
 * missing endpoint stops the polling for good, any other failure slows it down. A failed read shows nothing rather
 * than guessing a state.
 */
export function useIntakeExtension(loadQueue) {
  const [extension, setExtension] = useState(null);
  useEffect(() => {
    if (typeof loadQueue !== "function") return undefined;
    const controller = new AbortController();
    let timer;
    let delay = QUEUE_POLL_MS;
    async function poll() {
      try {
        const queue = await loadQueue();
        if (controller.signal.aborted) return;
        setExtension(queue?.extension && typeof queue.extension === "object" ? queue.extension : null);
        delay = QUEUE_POLL_MS;
      } catch (cause) {
        if (controller.signal.aborted) return;
        setExtension(null);
        if (cause?.status === 404) return;
        delay = Math.min(delay * 2, QUEUE_POLL_MAX_MS);
      }
      timer = window.setTimeout(poll, delay);
    }
    poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [loadQueue]);
  return extension;
}

function RunTodo({ todo, plan, saving, onRerun }) {
  const [armed, setArmed] = useState(false);
  const discovery = todo.kind === "discovery";
  const label = todo.actionLabel ?? "重跑";
  // A stopped round reruns as a new, priced round, so its cost is said before the second click.
  const blocked = discovery && todo.canRerun && !plan.ready ? plan.reason : null;
  return <li className="run-todo">
    <div className="run-todo-body">
      <b>{todo.title}</b>
      <span>{todo.reason}</span>
      <span className="run-todo-hint">{blocked ?? todo.hint}</span>
      {todo.kind === "intake" && todo.items.length > 1
        ? <span className="run-todo-items">{todo.items.map(item => item.title).join("、")}</span> : null}
    </div>
    {todo.canRerun ? <div className="run-todo-actions">
      {armed ? <>
        <span className="run-todo-confirm">{discovery
          ? `重跑会新开一轮「${plan.direction ?? "本店方向"}」，预计扣 ${plan.estimatedPoints ?? "约 10"} 分。`
          : todo.kind === "intake_resume" ? `接着跑这 ${todo.items.length} 件停下的那一步，只读，不写任何平台。`
            : `重跑这 ${todo.items.length} 件，每件一次，只读，不写任何平台。`}</span>
        <button type="button" className="button primary" disabled={saving} onClick={() => { setArmed(false); onRerun(todo); }}>确认{label}</button>
        <button type="button" className="button secondary" disabled={saving} onClick={() => setArmed(false)}>取消</button>
      </> : <button type="button" className="button primary" disabled={saving || blocked !== null} onClick={() => setArmed(true)}>{label}</button>}
    </div> : null}
  </li>;
}

/**
 * The top of every desk page: login and plugin problems said once for the whole page, and every run that did not
 * happen as one to-do with its reason and a 重跑 button. Nothing reruns by itself (AGENTS.md §8.3); a click reruns
 * exactly what the to-do names, once.
 */
export default function GlobalNotices({ extensionStatus = null, candidates = [], discoveryView = null, store = null,
  intakeQueue, loadIntakeQueue, onRetryIntake, onResumeIntake, onStartRound, intakeShownOnPage = false }) {
  const polled = useIntakeExtension(intakeQueue === undefined ? loadIntakeQueue : null);
  const queueExtension = intakeQueue === undefined ? polled : intakeQueue?.extension ?? null;
  // The intake page already shows the paused queue with its own 接着找 and a 重跑 on each stopped row, so on that page
  // those are not repeated here; everything else (plugin, 1688 login, Seerfar, stopped rounds) still is.
  const notices = useMemo(() => globalNotices({ extensionStatus, queueExtension, candidates, discoveryView, store })
    .filter(notice => !(intakeShownOnPage && INTAKE_PAGE_NOTICES.includes(notice.key))),
  [extensionStatus, queueExtension, candidates, discoveryView, store, intakeShownOnPage]);
  const todos = useMemo(() => failedRunTodos({ candidates, discoveryView, store, queueExtension })
    .filter(todo => !(intakeShownOnPage && todo.kind !== "discovery")),
  [candidates, discoveryView, store, queueExtension, intakeShownOnPage]);
  const plan = useMemo(() => newRoundPlan(discoveryView, store), [discoveryView, store]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function rerun(todo) {
    if (saving) return;
    setSaving(true); setError(null); setDone(null);
    let count = 0;
    try {
      if (todo.kind === "discovery") {
        if (typeof onStartRound !== "function" || !plan.ready) return;
        await onStartRound(roundStartPayload({ plan: plan.plan, binding: plan.binding, store }));
        setDone("已重新开始这一轮，结果出来后会出现在选品台。");
      } else if (todo.kind === "intake_resume") {
        if (typeof onResumeIntake !== "function") return;
        // One request: the pipeline reruns each paused product's stopped step once (POST /api/intake/resume).
        await onResumeIntake();
        setDone(`已接着找，这 ${todo.items.length} 件会从停下的那一步接着走。`);
      } else {
        if (typeof onRetryIntake !== "function") return;
        // One item at a time, each once; a refusal stops the rest so nothing is sent twice.
        for (const item of todo.items) {
          await onRetryIntake({ candidateId: item.candidateId, dataRevision: item.dataRevision });
          count += 1;
        }
        setDone(`已重跑 ${count} 件。`);
      }
    } catch (cause) {
      setError(todo.kind === "intake" ? `${deskErrorMessage(cause)}（已重跑 ${count} 件，其余没有动）` : deskErrorMessage(cause));
    } finally { setSaving(false); }
  }

  if (notices.length === 0 && todos.length === 0 && error === null && done === null) return null;
  return <section className="global-notices" aria-label="全局提示">
    {notices.map(notice => <div key={notice.key} role="status" className="page-notice">
      <div className="page-notice-text"><strong>{notice.title}</strong><span>{notice.detail}</span></div>
      {notice.link ? <a className="button secondary" href={notice.link.href} target="_blank" rel="noreferrer">{notice.link.label}</a> : null}
    </div>)}
    {todos.length ? <div className="run-todos">
      <h3>没跑成的（{todos.length}）</h3>
      <ul>{todos.map(todo => <RunTodo key={todo.key} todo={todo} plan={plan} saving={saving} onRerun={rerun} />)}</ul>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {done ? <p role="status" className="desk-notice">{done}</p> : null}
  </section>;
}
