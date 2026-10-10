import { useCallback, useEffect, useRef, useState } from "react";
import {
  INTAKE_MAX_LINKS,
  INTAKE_UNAVAILABLE_MESSAGE,
  intakePauseView,
  intakePreviewLine,
  intakeQueueGroups,
  intakeQueueHasActive,
  intakeQueueRows,
  intakeSubmitResults,
  parseIntakeLinks
} from "../intakeView.js";
import StoreProfileCards from "./StoreProfileCards.jsx";

const ACTIVE_POLL_MS = 3000;

/**
 * 读录入队列。只在录入页打开时读；队列里还有在跑的才每 3 秒再读一次，跑完就停，不在后台空转。
 * 后台回 404 说明录入后台还没上线：停下来，说清楚，不重试。
 */
export function useIntakeQueue({ enabled, loadQueue }) {
  const [state, setState] = useState({ queue: null, error: null, unavailable: false });
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const queue = await loadQueue(controller.signal);
        if (controller.signal.aborted) return;
        setState({ queue, error: null, unavailable: false });
        if (intakeQueueHasActive(queue)) timer = window.setTimeout(read, ACTIVE_POLL_MS);
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(current => ({ ...current, error: error?.message ?? String(error), unavailable: error?.status === 404 }));
      }
    }
    read();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [enabled, loadQueue, epoch]);
  return { ...state, refresh };
}

function QueueRow({ row, retrying, onRetry, onOpenCandidate }) {
  return (
    <li className={`intake-row ${row.blocked ? "blocked" : row.ready ? "ready" : ""}`} data-testid="intake-row">
      {row.imageUrl
        ? <img className="intake-row-image" src={row.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        : <span className="intake-row-image" aria-hidden="true" />}
      <div className="intake-row-main">
        <strong>{row.title}</strong>
        <span className="intake-row-meta">
          来自 {row.sourceLabel} · {row.stageLabel}{row.positionLine ? ` · ${row.positionLine}` : ""}
        </span>
        {row.blockerLine ? <span className="intake-row-blocker" title={row.blockerDetail ?? undefined}>{row.blockerLine}</span> : null}
      </div>
      <div className="intake-row-chips">
        {row.roughProfit ? <span className={`intake-chip ${row.roughProfit.tone}`}>{row.roughProfit.label}</span> : null}
      </div>
      <div className="intake-row-actions">
        {row.canRetry
          ? <button type="button" className="button secondary" disabled={retrying}
            onClick={() => onRetry(row)}>{retrying ? "正在提交…" : "重跑"}</button>
          : null}
        {row.candidateId
          ? <button type="button" className={`button ${row.ready ? "primary" : "secondary"}`}
            onClick={() => onOpenCandidate(row.candidateId)}>{row.ready ? "去确认" : "看这件"}</button>
          : null}
      </div>
    </li>
  );
}

function QueueGroup({ title, rows, ...rowProps }) {
  if (rows.length === 0) return null;
  return (
    <div className="intake-group">
      <h3>{title}（{rows.length}）</h3>
      <ul className="intake-rows">
        {rows.map(row => <QueueRow key={row.candidateId || row.title} row={row} retrying={rowProps.retryingId === row.candidateId}
          onRetry={rowProps.onRetry} onOpenCandidate={rowProps.onOpenCandidate} />)}
      </ul>
    </div>
  );
}

/**
 * 选品台首页：贴拼多多或 1688 链接，软件去找同款。
 * 取代原来的「添加我找到的商品」弹窗。这一页只提交链接和主人点的「重跑」；找同款、粗算、排队都在录入后台。
 */
export default function IntakePage({
  ownerReady = true,
  storeLine,
  targetStore = null,
  intake,
  candidates = [],
  onSubmitLinks,
  onRetry,
  onResume,
  onOpenCandidate,
  onOpenSeerfar,
  loadStoreProfiles,
  saveStoreProfile,
  onOpenBoard,
  onOpenMaintenance
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [results, setResults] = useState([]);
  const [retryingId, setRetryingId] = useState(null);
  const [retryError, setRetryError] = useState(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState(null);
  const inFlight = useRef(false);

  const parsed = parseIntakeLinks(draft);
  const preview = intakePreviewLine(parsed);
  const rows = intakeQueueRows(intake?.queue, candidates);
  const groups = intakeQueueGroups(rows);
  const unavailable = intake?.unavailable === true;
  const pause = intakePauseView(intake?.queue);
  const tooMany = parsed.links.length > INTAKE_MAX_LINKS;

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || parsed.links.length === 0 || tooMany) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await onSubmitLinks(parsed.links.map(link => link.url), targetStore);
      setResults(intakeSubmitResults(response, parsed.links));
      setDraft("");
      intake?.refresh?.();
    } catch (error) {
      setSubmitError(error?.status === 404 ? INTAKE_UNAVAILABLE_MESSAGE
        : error?.status === 422 ? "这几条都不是拼多多或 1688 的商品链接，什么也没有提交。"
        : `提交没有确认成功：${error?.message ?? error}。先刷新看队列里有没有，再决定要不要重新提交。`);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function retry(row) {
    if (retryingId !== null) return;
    setRetryingId(row.candidateId);
    setRetryError(null);
    try {
      await onRetry(row.candidateId, row.dataRevision);
      intake?.refresh?.();
    } catch (error) {
      setRetryError(`「${row.title}」重跑没有提交成功：${error?.message ?? error}`);
    } finally {
      setRetryingId(null);
    }
  }

  async function resume() {
    if (resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      await onResume();
      intake?.refresh?.();
    } catch (error) {
      setResumeError(error?.status === 409 ? "现在没有可以接着找的，刷新看看队列。" : `「接着找」没有提交成功：${error?.message ?? error}`);
    } finally {
      setResuming(false);
    }
  }

  if (!ownerReady) {
    return <div className="page-panel"><p role="status">请先登录主人身份后录入商品。</p></div>;
  }

  return (
    <main className="intake-page" data-testid="intake-page">
      {pause
        ? <div role="status" className="intake-pause">
          <div>
            <strong>找货先停下来了</strong>
            <span>{pause.message}。排着的什么都不会丢。</span>
            {resumeError ? <span role="alert" className="intake-error">{resumeError}</span> : null}
          </div>
          <button type="button" className="button secondary" disabled={resuming} onClick={resume}>{resuming ? "正在提交…" : "接着找"}</button>
        </div>
        : null}
      <section className="intake-card" aria-labelledby="intake-title">
        <div className="intake-heading">
          <h2 id="intake-title">贴拼多多或 1688 链接，软件去找同款</h2>
          <p>不用再填 Ozon 竞品、货价、运费。软件读完货源页面，用首图去补还缺的那一边（1688 货源、Ozon 同款），粗算一遍利润，找完放进「需要你处理」等你确认。</p>
        </div>
        <form className="intake-form" onSubmit={submit}>
          <label className="intake-links">拼多多或 1688 商品链接（一次可以贴多条，一行一条，两家可以混着贴）
            <textarea rows={4} value={draft} onChange={event => setDraft(event.target.value)}
              placeholder="https://mobile.yangkeduo.com/goods.html?…&#10;https://detail.1688.com/offer/….html" />
            {preview ? <span className="intake-preview" role="status">{preview}</span> : null}
          </label>
          <div className="intake-side">
            <span className="intake-side-label">默认店铺</span>
            <span className="intake-store">{storeLine}</span>
            <span className="intake-side-note">这里不用选。上哪家店，到「上架」时再定。</span>
            <button type="submit" className="button primary intake-submit"
              disabled={submitting || parsed.links.length === 0 || tooMany || unavailable}>
              {submitting ? "正在提交…" : "开始找同款"}
            </button>
          </div>
        </form>
        {submitError ? <p role="alert" className="intake-error">{submitError}</p> : null}
        {results.length > 0
          ? <ul className="intake-results" aria-label="刚提交的链接">
            {results.map(result => <li key={result.key} className={result.kind}>
              <span>{result.sentence}</span>
              {result.kind === "duplicate"
                ? <button type="button" className="intake-link" onClick={() => onOpenCandidate(result.candidateId)}>去看那张卡片</button>
                : null}
            </li>)}
          </ul>
          : null}
      </section>

      <section className="intake-card" aria-labelledby="intake-seerfar-title">
        <div className="intake-heading row">
          <div>
            <h2 id="intake-seerfar-title">Seerfar 自动选品</h2>
            <p>另一条路，不用贴链接：每天按每家店的店铺档案从 Seerfar 榜单里挑，自动找 1688 货源、粗算利润。确认方式和贴链接来的一样。</p>
          </div>
          <button type="button" className="button secondary" onClick={onOpenSeerfar}>看今天的 Seerfar 结果</button>
        </div>
        <StoreProfileCards loadProfiles={loadStoreProfiles} saveProfile={saveStoreProfile} />
      </section>

      <section className="intake-card" aria-labelledby="intake-queue-title">
        <div className="intake-heading">
          <h2 id="intake-queue-title">找货中（{rows.length}）</h2>
          <p>不用守着，找完会出现在「需要你处理」。插件一次只跑一条，多条链接按顺序排队。</p>
        </div>
        {unavailable ? <p role="status" className="intake-unavailable">{INTAKE_UNAVAILABLE_MESSAGE}</p>
          : intake?.error ? <p role="alert" className="intake-error">读取找货队列失败：{intake.error}
            <button type="button" className="intake-link" onClick={() => intake.refresh()}>再读一次</button></p>
          : intake?.queue === null || intake?.queue === undefined ? <p role="status">正在读取找货队列…</p>
          : rows.length === 0 ? <p className="intake-empty">队列是空的。贴一条链接试试。</p>
          : null}
        {retryError ? <p role="alert" className="intake-error">{retryError}</p> : null}
        <QueueGroup title="找完了，等你确认" rows={groups.ready} retryingId={retryingId} onRetry={retry} onOpenCandidate={onOpenCandidate} />
        <QueueGroup title="停下来了" rows={groups.blocked} retryingId={retryingId} onRetry={retry} onOpenCandidate={onOpenCandidate} />
        <QueueGroup title="还在找" rows={groups.running} retryingId={retryingId} onRetry={retry} onOpenCandidate={onOpenCandidate} />
        <QueueGroup title="状态没认出来" rows={groups.unknown} retryingId={retryingId} onRetry={retry} onOpenCandidate={onOpenCandidate} />
      </section>

      <nav className="intake-more" aria-label="其他页面">
        <span>其他页面：</span>
        <button type="button" className="intake-link" onClick={onOpenBoard}>进行中的商品</button>
        <button type="button" className="intake-link" onClick={onOpenMaintenance}>维护</button>
      </nav>
    </main>
  );
}
