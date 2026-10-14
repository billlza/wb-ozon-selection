/**
 * 首页待办里 Seerfar 这一路的条目（工作台 UI 评审 2026-10-10 定的形状）：从轮次记录和本店销量快照现算，不另存；
 * 记录一变，待办就跟着变或消失。没收成的商品留在轮次卡片里，不进待办。
 */
const SITE_NOTICE_CODES = new Set(['site_login_required', 'navigation_rejected', 'results_unverifiable']);

/** rounds: seerfarWebRoundPublic list; storeSales: store-sales view keyed by store. Only today's failures that nothing has replaced. */
export function seerfarTodos({ rounds, storeSales = {}, businessDate }) {
  const todos = [];
  const latest = new Map();
  for (const round of rounds.filter(value => value.businessDate === businessDate)) {
    const key = `${round.targetStore}|${round.query.queryId}`;
    const seen = latest.get(key);
    if (!seen || Date.parse(round.createdAt) > Date.parse(seen.createdAt)) latest.set(key, round);
  }
  let siteNotice = null;
  for (const round of latest.values()) {
    if (round.status !== 'failed' || !round.failure) continue;
    const action = { key: 'rerun', label: '重跑这一轮', target: { view: 'desk', roundId: round.roundId } };
    if (SITE_NOTICE_CODES.has(round.failure.code)) {
      // One notice for the site, however many rounds hit it: logging in or the page changing is not a per-store problem.
      if (!siteNotice || Date.parse(round.completedAt) > Date.parse(siteNotice.occurredAt)) {
        siteNotice = { id: `seerfar:site:${round.failure.code}`, source: 'seerfar', kind: 'notice', severity: 'blocker', store: null, platform: 'ozon',
          subject: null, reason: `${round.failure.reason}，今天的 Seerfar 榜单都收不了。`, action, occurredAt: round.completedAt };
      }
      continue;
    }
    todos.push({ id: `seerfar:${round.roundId}:failure`, source: 'seerfar', kind: 'failure', severity: 'action', store: round.targetStore, platform: 'ozon',
      subject: { title: `Seerfar ${round.query.routeLabel}` }, reason: `${round.failure.reason}，这一轮已停止。`, action, occurredAt: round.completedAt });
  }
  if (siteNotice) todos.unshift(siteNotice);
  for (const [store, sales] of Object.entries(storeSales)) {
    const record = sales?.latest;
    if (!record || record.status !== 'failed' || record.businessDate !== businessDate || sales.readToday) continue;
    todos.push({ id: `seerfar:${record.snapshotId}:failure`, source: 'seerfar', kind: 'failure', severity: 'action', store, platform: 'ozon',
      subject: { title: '读本店销量' }, reason: `${record.failure?.reason ?? '没读成'}，今天的爆款找相似先不搜。`,
      action: { key: 'reread_store_sales', label: '重读本店销量', target: { view: 'desk' } }, occurredAt: record.completedAt });
  }
  return todos;
}
