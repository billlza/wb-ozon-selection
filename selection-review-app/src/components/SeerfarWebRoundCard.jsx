import { useState } from 'react';
import { STORE_LABELS } from '../constants.js';
import { errorMessage } from '../formState.js';
import { formatInstant } from '../selectionDeskView.js';

/**
 * Seerfar 榜单（方案 B 第一段）：今天每家店建议搜什么，点"收一轮"后插件打开你已登录的 Seerfar 热销榜单选品页，
 * 你按这里写的条件搜一次，插件收下那一页；软件按固定规则筛完，把排在前面的几个放进待处理。会员前台，不花积分。
 */
const statusLabels = { waiting_extension: '等插件领取', capturing: '等你在 Seerfar 里搜', completed: '已收完', failed: '没收成，已停止' };

function priceText(band) {
  if (!band) return '不限';
  if (band.min !== null && band.max !== null) return `${band.min}–${band.max} 卢布`;
  return band.min !== null ? `${band.min} 卢布以上` : `${band.max} 卢布以下`;
}

function QueryRow({ store, query, ranRoundId, busy, onStart }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  async function start() {
    if (saving) return;
    setSaving(true); setMessage(null);
    try { setMessage(await onStart({ targetStore: store, queryId: query.queryId })); }
    catch (cause) { setMessage({ type: 'error', text: errorMessage(cause) }); }
    finally { setSaving(false); }
  }
  return <li className="seerfar-query">
    <p><strong>{query.routeLabel}</strong>：{query.reason}</p>
    <p className="seerfar-muted">类目：{query.categoryPaths.join('；')} · 跨境卖家 · 近 30 天 · 价格 {priceText(query.priceRub)} · 重量 {query.maxWeightGrams ? `${query.maxWeightGrams} 克以内` : '不限'}</p>
    {ranRoundId ? <p className="seerfar-muted">今天已经收过这一条，同一天不重复查。</p> :
      <button type="button" className="button secondary" disabled={saving || busy} onClick={start}>{saving ? '正在开始…' : '收一轮'}</button>}
    {message ? <p role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
  </li>;
}

const kindLabels = { hot: '卖得最多', rising: '销量在涨', potential: '加购多、下单少' };

/** 本店销量：爆款从这里自动挑，主人不用手标。读的是本机只读 Seller API，一家店一天读一次。 */
function StoreSales({ store, sales, onRead }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  if (!sales) return null;
  async function read() {
    if (saving) return;
    setSaving(true); setMessage(null);
    try { setMessage(await onRead(store)); }
    catch (cause) { setMessage({ type: 'error', text: errorMessage(cause) }); }
    finally { setSaving(false); }
  }
  const done = sales.latestCompleted;
  const latest = sales.latest;
  return <div className="seerfar-store-sales">
    {!sales.configured ? <p className="seerfar-muted">这台电脑没有配这家店的只读 Seller API，读不了本店销量，"本店爆款找相似"先不搜。</p>
      : sales.running ? <p role="status">正在读本店近 8 周的销量…</p>
      : sales.readToday ? null
      : <button type="button" className="button secondary" disabled={saving} onClick={read}>{saving ? '正在开始…' : '读本店销量，挑爆款'}</button>}
    {latest?.status === 'failed' && latest !== done ? <p role="alert">上次没读成：{latest.failure?.reason}。已停止，没有重试。</p> : null}
    {done ? <>
      <p className="seerfar-muted">本店销量 {done.businessDate} 读的：{done.windows.recent.from} 至 {done.windows.recent.to} 共 {done.recentUnits} 件（前 28 天 {done.priorUnits} 件），{done.skuCount} 个 SKU。</p>
      {done.seeds.length ? <ul>{done.seeds.map(seed => <li key={seed.seedId}>
        {kindLabels[seed.kind] ?? seed.kind}：{seed.title} · {seed.evidence} · 约 {seed.priceRmb} 元（约 {seed.priceRub} 卢布）{seed.hasStock === false ? ' · 现在没库存' : ''}
      </li>)}</ul> : <p className="seerfar-muted">按档案的门槛，这次没有挑出爆款。</p>}
    </> : null}
    {message ? <p role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
  </div>;
}

function RoundCard({ round, onOpenCandidate }) {
  const [showDropped, setShowDropped] = useState(false);
  const imported = round.importedCandidateIds;
  return <li className="seerfar-round">
    <p><strong>{STORE_LABELS[round.targetStore] ?? round.targetStore}</strong> · {round.query.routeLabel} · {statusLabels[round.status] ?? round.status}
      {round.completedAt ? ` · ${formatInstant(round.completedAt)}` : ''}</p>
    {round.status === 'capturing' ? <p role="status">Seerfar 页面已经打开：请在 3 分钟内选上面这几个类目、跨境卖家、近 30 天，点一次搜索。插件收到这一页就会自己关掉标签页。</p> : null}
    {round.failure ? <p role="alert">{round.failure.reason}。这一轮已停止，没有收任何商品；需要的话再点一次"收一轮"。</p> : null}
    {round.screening ? <>
      <p>这一页 {round.screening.counts.total} 个商品（页面显示{round.resultCountLabel}），收了 {round.screening.counts.kept} 个，其余 {round.screening.counts.dropped} 个没收。</p>
      {round.screening.kept.length ? <ol>{round.screening.kept.map((entry, index) => <li key={entry.productId}>
        {entry.title} · {entry.priceRub} 卢布 · 近 30 天卖 {entry.salesCount} 件 · {entry.weightGrams} 克 · 粗算最高能接受采购价 {entry.ceilingRmb} 元{entry.newListing ? ' · 新品' : ''}
        {imported[index] ? <> <button type="button" className="button secondary seerfar-inline" onClick={() => onOpenCandidate(imported[index])}>打开</button></> : null}
      </li>)}</ol> : <p className="seerfar-muted">这一页没有过线的商品。</p>}
      {round.screening.dropped.length ? <>
        <button type="button" className="button secondary seerfar-inline" onClick={() => setShowDropped(value => !value)}>{showDropped ? '收起没收的' : `看没收的 ${round.screening.dropped.length} 个和原因`}</button>
        {showDropped ? <ul>{round.screening.dropped.map(entry => <li key={entry.productId}>{entry.title}：{entry.reason}</li>)}</ul> : null}
      </> : null}
      <p className="seerfar-muted">收进来的只是待核验商品：还没有货源、没有确认供货，也没有正式利润。下一步在商品页用 Ozon 主图去 1688 找同款。</p>
    </> : null}
  </li>;
}

export default function SeerfarWebRoundCard({ view, onStart, onReadStoreSales, onOpenCandidate }) {
  if (view.configError) return <section className="page-panel seerfar-web"><h2>Seerfar 榜单</h2><p role="alert">选品档案或季节日历读不出来（{view.configError}），今天不能收。</p></section>;
  return <section className="page-panel seerfar-web">
    <h2>Seerfar 榜单 · 今天建议搜这些</h2>
    <p className="seerfar-muted">走 Seerfar 会员前台，不花积分。点"收一轮"会在你的 Chrome 里打开热销榜单选品页，你按下面的条件搜一次就行；软件筛完把排在前面的几个放进待处理。</p>
    {Object.entries(view.plans).map(([store, plan]) => <div key={store}>
      <h3>{STORE_LABELS[store] ?? store}</h3>
      <StoreSales store={store} sales={view.storeSales?.[store]} onRead={onReadStoreSales} />
      {plan.queries.length ? <ul>{plan.queries.map(query => <QueryRow key={query.queryId} store={store} query={query} busy={view.busy}
        ranRoundId={view.todayRuns[`${store}|${query.queryId}`] ?? null} onStart={onStart} />)}</ul> : null}
      {plan.gaps.map(gap => <p key={`${gap.code}:${gap.windowId ?? ''}`} className="seerfar-muted">{gap.reason}</p>)}
    </div>)}
    {view.rounds.length ? <><h3>最近几轮</h3><ul>{view.rounds.map(round => <RoundCard key={round.roundId} round={round} onOpenCandidate={onOpenCandidate} />)}</ul></> : null}
  </section>;
}
