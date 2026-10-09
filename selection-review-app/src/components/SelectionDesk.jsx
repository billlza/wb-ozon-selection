import { useEffect, useMemo, useRef, useState } from "react";
import { DECLINE_REASONS, FEED_SORTS, boardColumns, deskErrorMessage, eliminatedRows, feedRows, inboxItems,
  lastRoundUndecidedRows, myProductRows, newRoundPlan, pointsLine } from "../selectionDeskView.js";
import EliminateControl, { EliminatedFold } from "./EliminateControl.jsx";
import { PlusIcon } from "./Icons";

/** The one word the bulk drop is recorded under; free text is not accepted anywhere in this flow. */
const BULK_DECLINE_REASON = "其他";

const fact = value => (value === null || value === undefined || value === "unknown" ? "未知" : value);
const money = value => (typeof value === "number" && Number.isFinite(value) ? `¥${value.toFixed(2)}` : null);
const percent = value => (typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : null);
/** The block stays one glance tall; everything beyond it lives on 进行中. */
const MY_PRODUCT_PREVIEW = 6;

function ProfitBox({ row }) {
  const { estimate } = row;
  if (estimate === null) return <p className="desk-profit-empty">点「算利润区间」后显示</p>;
  const ceiling = money(estimate.maximumAllInPurchaseRmb);
  const freight = estimate.freight ?? {};
  const share = percent(row.freightShare);
  const freightText = freight.route === null || freight.route === undefined ? "待补尺寸重量"
    : [`${freight.route} · 计费 ${freight.chargeableKg}kg`, money(freight.freightRmb),
      freight.oversize === true ? "超抛" : null, share === null ? null : `占比 ${share}`].filter(Boolean).join(" · ");
  return <div className="desk-profit">
    <div><b>建议采购区间</b><span>{ceiling === null ? "待补数据" : `到手总价 ≤ ${ceiling}`}</span></div>
    <div><b>按区间中值</b><span>{estimate.outcome === "excluded_negative" ? "预估负利润，不建议做"
      : estimate.outcome === "needs_data" ? "资料不全，暂不能判断"
      : money(estimate.unitProfitAtMidRmb) === null ? "刚好达到本店利润门槛"
      : `单件利润 ${money(estimate.unitProfitAtMidRmb)} · 利润率 ${percent(estimate.marginAtMid) ?? "—"}`}</span></div>
    <div><b>运费</b><span>{freightText}</span></div>
    <div><b>佣金</b><span>{percent(estimate.commissionRate) ?? "未取得"}</span></div>
  </div>;
}

function FeedCard({ row, active, saving, declining, candidateRevision = null,
  onDeclining, onSelect, onDecline, onLater, onOpenCandidate, onEliminate }) {
  return <article className={`desk-card${active ? " desk-card-active" : ""}`}>
    {row.imageUrl
      ? <img className="desk-thumb" src={row.imageUrl} alt="" width="132" height="132" loading="lazy" referrerPolicy="no-referrer" />
      : <span className="desk-thumb desk-thumb-empty">主图</span>}
    <div className="desk-card-body">
      <p className="desk-card-title">{row.productUrl
        ? <a href={row.productUrl} target="_blank" rel="noreferrer">{row.titleZh ?? row.title}</a>
        : row.titleZh ?? row.title}</p>
      {row.titleZh === null ? null : <p className="desk-card-original">{row.title}</p>}
      <p className="desk-card-facts">售价 {fact(row.price)} 卢布{money(row.estimate?.revenueCny) === null ? "" : ` ≈ ${money(row.estimate.revenueCny)}`} · 月销 {fact(row.salesCount)} · 评价 {fact(row.reviewCount)} · 评分 {fact(row.reviewRating)}</p>
      <p className="desk-card-category">类目：{row.categoryZh ?? "未知"}</p>
      <ProfitBox row={row} />
      {row.chips.length ? <p className="desk-chips">{row.chips.map(chip => <span key={chip} className="desk-chip">{chip}</span>)}</p> : null}
      {row.failureClass ? <p role="alert">保存失败：{row.failureClass}</p> : null}
      {row.duplicate ? <p className="desk-card-note">这件商品记录里已经有了，没有重复建卡。</p> : null}
      <div className="desk-actions">
        {row.importedCandidateId !== null
          ? <><span>已在评审台</span><button type="button" className="button secondary" onClick={() => onOpenCandidate(row.importedCandidateId)}>查看</button>
            {/* This row already became a product, so dropping it is the same 淘汰 every other list offers. */}
            <EliminateControl id={row.importedCandidateId} dataRevision={candidateRevision}
              disabled={saving} onEliminate={onEliminate} /></>
          : <>
            <button type="button" className="button primary" disabled={saving || row.duplicate} onClick={() => onSelect(row)}>要</button>
            <details className="desk-decline" open={declining} onToggle={event => onDeclining(event.currentTarget.open ? row.key : null)}>
              {/* Nothing has been taken yet, so 不要 is this card's 淘汰: the row leaves the feed and the reason is kept. */}
              <summary>不要（淘汰）</summary>
              <div className="desk-decline-reasons">
                <span>选一个原因：</span>
                {DECLINE_REASONS.map(reason => <button key={reason} type="button" className="button secondary" disabled={saving}
                  onClick={() => onDecline(row, reason)}>{reason}</button>)}
                <button type="button" className="button secondary" disabled={saving} onClick={() => onDeclining(null)}>返回</button>
              </div>
            </details>
            <button type="button" className="button secondary" disabled={saving} onClick={() => onLater(row)}>稍后</button>
          </>}
      </div>
    </div>
  </article>;
}

/**
 * The owner's home page: one card per product still waiting for a decision, plus a rail with what is waiting on the
 * owner. Every number shown comes from a saved query result or a saved estimate; this page computes none of them.
 */
export default function SelectionDesk({
  discoveryView, candidates, store, ownerReady = true, loadingLabel = "正在读取本店的查询结果…",
  onSelectProduct, onDeclineProduct, onLaterProduct, onEstimate, onTranslate,
  onOpenCandidate, onStartNewRound, onResumeRound, onOpenBoard, onOpenInbox, onAddProduct,
  onEliminateCandidate, onRestoreCandidate, skipped = []
}) {
  const [sort, setSort] = useState("profit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [cursor, setCursor] = useState(0);
  const feed = useMemo(() => feedRows(discoveryView, store, sort), [discoveryView, store, sort]);
  const skippedKeys = useMemo(() => new Set(skipped), [skipped]);
  const rows = useMemo(() => feed.rows.filter(row => !skippedKeys.has(row.key)), [feed, skippedKeys]);
  const history = useMemo(() => feed.history.filter(row => !skippedKeys.has(row.key)), [feed, skippedKeys]);
  const board = useMemo(() => boardColumns(candidates, store), [candidates, store]);
  // The fixed way back into a product the owner already took: it never depends on which round the feed is showing.
  const mine = useMemo(() => myProductRows(candidates, discoveryView, store), [candidates, discoveryView, store]);
  const dropped = useMemo(() => eliminatedRows(candidates, store, discoveryView), [candidates, discoveryView, store]);
  const revisions = useMemo(() => new Map((Array.isArray(candidates) ? candidates : [])
    .map(candidate => [candidate?.id, candidate?.dataRevision])), [candidates]);
  const inbox = useMemo(() => inboxItems(candidates, store), [candidates, store]);
  // What the newest round still has no answer on; the count shown before the click is the list acted on after it.
  const undecided = useMemo(() => lastRoundUndecidedRows(feed).filter(row => !skippedKeys.has(row.key)), [feed, skippedKeys]);
  const points = pointsLine(discoveryView, store);
  // What the next click would query, read before anything is created: the rail names that direction, not the last one.
  const nextRound = useMemo(() => newRoundPlan(discoveryView, store), [discoveryView, store]);
  const activeKey = rows.length === 0 ? null : rows[Math.min(cursor, rows.length - 1)].key;

  async function run(action, payload) {
    if (saving || typeof action !== "function") return null;
    setSaving(true); setError(null); setNotice(null);
    try {
      const result = await action(payload);
      setDeclining(null);
      return result;
    } catch (cause) { setError(deskErrorMessage(cause)); return null; }
    finally { setSaving(false); }
  }
  async function select(row) {
    const result = await run(onSelectProduct, { batchId: row.batchId, expectedRevision: row.expectedRevision, marketProductId: row.marketProductId });
    if (result !== null) setNotice("已收下，去「进行中」看它的下一步。");
  }
  async function decline(row, reason) {
    const result = await run(onDeclineProduct, { batchId: row.batchId, expectedRevision: row.expectedRevision, marketProductId: row.marketProductId, reason });
    if (result !== null) setNotice(`已记下：${reason}。以后再遇到同类，会先按你的这些理由过一遍。`);
  }
  function later(row) {
    setDeclining(null); setError(null);
    setNotice("已跳过，本次浏览不再显示；没有保存任何记录。");
    if (typeof onLaterProduct === "function") onLaterProduct(row);
  }
  /** One arming click, one sentence with the real count, then one row at a time; a refusal stops the rest. */
  const [bulkArmed, setBulkArmed] = useState(false);
  async function dropUndecided() {
    setBulkArmed(false);
    if (saving || typeof onDeclineProduct !== "function" || undecided.length === 0) return;
    setSaving(true); setError(null); setNotice(null);
    let done = 0;
    try {
      for (const row of undecided) {
        await onDeclineProduct({ batchId: row.batchId, expectedRevision: row.expectedRevision,
          marketProductId: row.marketProductId, reason: BULK_DECLINE_REASON });
        done += 1;
      }
      setNotice(`已淘汰上一轮未选的 ${done} 条，理由记为「${BULK_DECLINE_REASON}」；它们折在下面的「已淘汰」里。`);
    } catch (cause) {
      setError(`${deskErrorMessage(cause)}（已淘汰 ${done} 条，其余没有动）`);
    } finally { setSaving(false); setDeclining(null); }
  }
  async function eliminate({ id, dataRevision, reason }) {
    if (typeof onEliminateCandidate !== "function") return;
    setError(null); setNotice(null);
    try {
      await onEliminateCandidate({ id, dataRevision: dataRevision ?? revisions.get(id) ?? null, reason });
      setNotice("已淘汰，它现在折在「已淘汰」里，随时可以恢复。");
    } catch (cause) { setError(deskErrorMessage(cause)); }
  }
  async function restore({ id, dataRevision }) {
    if (typeof onRestoreCandidate !== "function") return;
    setError(null); setNotice(null);
    try {
      await onRestoreCandidate({ id, dataRevision: dataRevision ?? revisions.get(id) ?? null });
      setNotice("已恢复，它回到了淘汰前的那一步；没有自动继续任何事。");
    } catch (cause) { setError(deskErrorMessage(cause)); }
  }
  const batchAction = action => run(action, feed.current === null ? null : { ...feed.current });
  const [roundDialog, setRoundDialog] = useState(null);
  function openRoundDialog() { setError(null); setRoundDialog(newRoundPlan(discoveryView, store)); }
  async function confirmRound({ resume }) {
    const dialog = roundDialog; setRoundDialog(null);
    if (!dialog?.ready) return;
    // A round that was created but never started is continued from its own saved batch; no second batch is opened.
    // The owner can still say no to that one and open a fresh round instead, so an old batch never blocks the button.
    const resuming = resume && dialog.resume !== null;
    const action = resuming ? onResumeRound : onStartNewRound;
    if (typeof action !== "function") return;
    const result = await run(action, resuming
      ? { batchId: dialog.resume.batchId, expectedRevision: dialog.resume.expectedRevision }
      : { plan: dialog.plan, binding: dialog.binding, store });
    if (result !== null) {
      setNotice(resuming
        ? "已继续上一次点的那一轮：没有新建批次，查询、算数、翻译都自动进行。"
        : "已开始这一轮：查询、算数、翻译都自动进行，几分钟内结果出现在这里。");
    }
  }

  // The keyboard shortcuts always act on what the page shows right now, so they read the latest render, not a closure.
  const live = useRef(null);
  live.current = { rows, cursor, select };
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    function onKeyDown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName) || event.target?.isContentEditable) return;
      const key = String(event.key).toLowerCase();
      if (!["j", "k", "y", "n"].includes(key)) return;
      const state = live.current;
      const row = state.rows.length === 0 ? null : state.rows[Math.min(state.cursor, state.rows.length - 1)];
      event.preventDefault();
      if (key === "j") setCursor(value => Math.min(value + 1, Math.max(state.rows.length - 1, 0)));
      else if (key === "k") setCursor(value => Math.max(value - 1, 0));
      else if (row === null) return;
      else if (key === "y") state.select(row);
      else setDeclining(row.key);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!ownerReady) return <div className="page-panel"><p role="status">请先登录主人身份后查看选品台。</p></div>;
  if (discoveryView === null) return <div className="page-panel"><p role="status">{loadingLabel}</p></div>;

  return <div className="page-panel desk-page">
    <section className="desk-mine" aria-label="我选的商品">
      <header className="desk-mine-header">
        <h2>我选的商品（{mine.length}）</h2>
        {mine.length > MY_PRODUCT_PREVIEW
          ? <button type="button" className="button secondary" onClick={onOpenBoard}>查看全部 {mine.length} 件</button> : null}
        {/* 自己在别处找到的商品也进这张单子，所以入口就在这张单子的头上，不在每一页的顶栏里。 */}
        {typeof onAddProduct === "function"
          ? <button type="button" className="button add-button desk-mine-add" onClick={onAddProduct}>
            <PlusIcon /> 添加我找到的商品</button> : null}
      </header>
      {/* The button below the cards is called 要, so the empty state has to say 要 — owner mis-click 2026-09-11. */}
      {mine.length === 0 ? <p className="desk-mine-empty" role="status">还没有选定的商品。在下面的列表里点「要」。</p>
        : <ul className="desk-mine-list">
          {mine.slice(0, MY_PRODUCT_PREVIEW).map(row => <li key={row.id} className="desk-mine-row">
            <button type="button" className="desk-mine-open" onClick={() => onOpenCandidate(row.id)}>
              {row.imageUrl
                ? <img className="desk-mine-thumb" src={row.imageUrl} alt="" width="52" height="52" loading="lazy" referrerPolicy="no-referrer" />
                : <span className="desk-mine-thumb desk-mine-thumb-empty">主图</span>}
              <span className="desk-mine-body">
                <b>{row.title}</b>
                <span className="desk-mine-price">{row.priceLine}</span>
              </span>
              <span className="desk-chip desk-mine-chip">{row.chip}</span>
            </button>
            <button type="button" className="button secondary desk-mine-action"
              onClick={() => onOpenCandidate(row.id)}>{row.action}</button>
            <EliminateControl id={row.id} dataRevision={revisions.get(row.id) ?? null} disabled={saving} onEliminate={eliminate} />
          </li>)}
        </ul>}
      <EliminatedFold rows={dropped} onRestore={restore} disabled={saving} />
    </section>
    <div className="desk-layout">
      <section className="desk-feed" aria-label="待你决定">
        <header className="desk-feed-header">
          <div>
            <h2>待你决定</h2>
            <p className="desk-subline">{feed.storeLabel} · 本轮结果：{feed.direction ?? "还没有本店的查询结果"}</p>
          </div>
          <div className="desk-feed-tools">
            <label>排序<select value={sort} onChange={event => setSort(event.target.value)}>
              {FEED_SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <button type="button" className="button secondary" disabled={saving || feed.current === null || feed.estimable === 0}
              onClick={() => batchAction(onEstimate)}>算利润区间</button>
            <button type="button" className="button secondary" disabled={saving || feed.current === null || feed.pendingTranslations === 0}
              onClick={() => batchAction(onTranslate)}>翻译标题（{feed.pendingTranslations} 条待翻）</button>
            <button type="button" className="button secondary" disabled={saving || undecided.length === 0}
              onClick={() => setBulkArmed(true)}>一键淘汰上一轮全部未选（{undecided.length}）</button>
          </div>
        </header>
        {bulkArmed ? <p className="desk-bulk-confirm" role="status">
          这会把上一轮里你既没点「要」也没点「不要」的 {undecided.length} 条一次淘汰，理由记为「{BULK_DECLINE_REASON}」；已经要过的不动。
          <button type="button" className="button primary" disabled={saving} onClick={dropUndecided}>确定淘汰这 {undecided.length} 条</button>
          <button type="button" className="button secondary" disabled={saving} onClick={() => setBulkArmed(false)}>取消</button>
        </p> : null}
        <p className="desk-hint">键盘：J 下一件 · K 上一件 · Y 要 · N 不要。运费占比＝运费 ÷（采购上限 ＋ 运费），只用已保存的估算数字。</p>
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status" className="desk-notice">{notice}</p> : null}
        {/* 顶栏那个同名按钮去的是旧工程页，已经去掉了；这里只能指向本页右边「下一轮方向」里的那一个。 */}
        {rows.length === 0 ? <p role="status">本店当前没有等你决定的商品。点右边「下一轮方向」里的「找一轮新品」再找一批。</p> : null}
        {feed.direction === null ? null : <p className="desk-round-header">本轮结果：{feed.direction} · 查询于 {feed.queriedAt ?? "未记录时间"}</p>}
        {rows.map(row => <FeedCard key={row.key} row={row} active={activeKey === row.key} saving={saving}
          declining={declining === row.key} onDeclining={setDeclining} candidateRevision={revisions.get(row.importedCandidateId) ?? null}
          onSelect={select} onDecline={decline} onLater={later} onOpenCandidate={onOpenCandidate} onEliminate={eliminate} />)}
        {history.length ? <details className="desk-folded"><summary>历史轮次未处理的 {history.length} 条（默认隐藏）</summary>
          {history.map(row => <FeedCard key={row.key} row={row} active={false} saving={saving}
            declining={declining === row.key} onDeclining={setDeclining} candidateRevision={revisions.get(row.importedCandidateId) ?? null}
            onSelect={select} onDecline={decline} onLater={later} onOpenCandidate={onOpenCandidate} onEliminate={eliminate} />)}
        </details> : null}
        {feed.excluded.length ? <details className="desk-folded"><summary>已自动排除 {feed.excluded.length} 条（预估负利润）</summary>
          <ul>{feed.excluded.map(row => <li key={row.key}>{row.titleZh ?? row.title} · 售价 {fact(row.price)} 卢布 · {row.estimate?.summary ?? "预估负利润"}</li>)}</ul>
        </details> : null}
        {/* These rows were never taken, so there is no saved product to restore; the reason stays as the memory of it. */}
        {feed.declined.length ? <details className="desk-folded"><summary>已淘汰 {feed.declined.length} 条（你自己不要的，默认隐藏）</summary>
          <ul>{feed.declined.map(row => <li key={row.key}>{row.titleZh ?? row.title} · 你的理由：{row.declineReason}</li>)}</ul>
        </details> : null}
      </section>
      <aside className="desk-rail" aria-label="本店概览">
        <section className="desk-rail-block">
          <h3>需要你处理（{inbox.length}）</h3>
          {inbox.length === 0 ? <p className="desk-rail-empty">现在没有等你处理的商品。</p> : <ul className="desk-rail-list">
            {inbox.slice(0, 6).map(item => <li key={item.id}>
              <b>{item.title}</b><span>{item.need}{item.moreNeeds > 0 ? `（还有 ${item.moreNeeds} 项）` : ""}</span>
              <button type="button" className="button secondary" onClick={() => onOpenCandidate(item.id)}>{item.action.label}</button>
            </li>)}</ul>}
          {inbox.length > 6 ? <button type="button" className="button secondary" onClick={onOpenInbox}>查看全部 {inbox.length} 条</button> : null}
        </section>
        <section className="desk-rail-block">
          <h3>进行中</h3>
          {board.some(column => column.cards.length) ? <ul className="desk-rail-progress">
            {board.map(column => <li key={column.key}><span>{column.title}</span><b>{column.cards.length}</b></li>)}</ul>
            : <p className="desk-rail-empty">本店暂时没有在做的商品。</p>}
          <button type="button" className="button secondary" onClick={onOpenBoard}>打开进行中</button>
        </section>
        <section className="desk-rail-block">
          <h3>下一轮方向</h3>
          <p className="desk-rail-direction">{nextRound.direction || "还没有配置下一轮的查询方向。"}</p>
          {nextRound.estimatedPoints === null ? null : <p className="desk-rail-estimate">这一轮预计扣 {nextRound.estimatedPoints} 分</p>}
          {points === null ? null : <p className="desk-rail-points">{points}</p>}
          <button type="button" className="button primary" disabled={saving} onClick={openRoundDialog}>找一轮新品</button>
          {roundDialog === null ? null : <div className="desk-dialog" role="dialog" aria-label="找一轮新品">
            {roundDialog.ready ? <>
              <p><b>这一轮会做什么</b></p>
              {roundDialog.resume === null
                ? <p>向 Seerfar 查一次「{roundDialog.direction}」，预计扣 {roundDialog.estimatedPoints ?? "约 10"} 分，本轮上限 {roundDialog.maxCredits ?? "20"} 分。确认后自动创建并开始，查询、算数、翻译都不用你再点；结果出现在"待你决定"。</p>
                : <p>上一次点「找一轮新品」已经建好了这一轮「{roundDialog.resume.direction}」（{roundDialog.resume.createdAt ?? "时间未记录"}），但没有真正开始查询。确认后继续这一轮，不会再建一个新的批次；预计扣 {roundDialog.estimatedPoints ?? "约 10"} 分，只扣这一次。</p>}
              {roundDialog.warning ? <p className="desk-dialog-warning">{roundDialog.warning}</p> : null}
              {/* The server refuses a second round while the saved one is this young; say the wait before the click. */}
              {roundDialog.resume !== null && roundDialog.resume.canReopenNow === false
                ? <p className="desk-dialog-warning">刚建好的这一轮在 10 分钟内不能另开一轮，还要等约 {roundDialog.resume.reopenWaitMinutes} 分钟（{roundDialog.resume.reopenAt ?? "时间未记录"} 之后）。现在可以直接继续它；要重新找一轮，等过了这段时间再点。</p>
                : null}
              <div className="desk-dialog-actions">
                <button type="button" className="button secondary" onClick={() => setRoundDialog(null)}>取消</button>
                {roundDialog.resume === null ? null : <button type="button" className="button secondary"
                  disabled={saving || roundDialog.resume.canReopenNow === false}
                  onClick={() => confirmRound({ resume: false })}>不要这一轮了，重新找一轮</button>}
                <button type="button" className="button primary" disabled={saving}
                  onClick={() => confirmRound({ resume: true })}>{roundDialog.resume === null ? "确认，开始这一轮" : "确认，继续这一轮"}</button>
              </div>
            </> : <>
              <p>{roundDialog.reason}</p>
              <div className="desk-dialog-actions"><button type="button" className="button secondary" onClick={() => setRoundDialog(null)}>知道了</button></div>
            </>}
          </div>}
        </section>
      </aside>
    </div>
  </div>;
}
