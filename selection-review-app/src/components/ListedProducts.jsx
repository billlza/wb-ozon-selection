import { listedProductGroups } from "../listedProductsView.js";
import { storeLabel } from "../selectionDeskView.js";

function ListedRow({ row, onOpen }) {
  return <li className="listed-row">
    {row.imageUrl
      ? <img className="listed-thumb" src={row.imageUrl} alt="" width="56" height="56" loading="lazy" referrerPolicy="no-referrer" />
      : <span className="listed-thumb listed-thumb-empty" aria-hidden="true" />}
    <div className="listed-body">
      <b>{row.title}</b>
      <span className={`listed-readback tone-${row.readback.tone}`}>{row.readback.label}{row.readback.at ? ` · ${row.readback.at}` : ""}</span>
      {row.observed || row.platformProductId
        ? <span className="listed-observed">{[row.platformProductId ? `平台商品号 ${row.platformProductId}` : null, row.observed].filter(Boolean).join(" · ")}</span>
        : null}
    </div>
    <button type="button" className="button secondary" onClick={() => onOpen(row.id)}>打开</button>
  </li>;
}

/**
 * 在售：这家店已经在卖的商品，每件带它的回读结果；下面是已经写到平台、回读还没通过的。只读页面，打开一件就进它自己的页面，
 * 回读要再跑、要核对，都在那一页的「上架与回读」里做。
 */
export default function ListedProducts({ candidates, store, discoveryView = null, onOpenCandidate }) {
  const { live, pending } = listedProductGroups(candidates, store, discoveryView);
  return <main className="page-panel listed-page">
    <h2>在售</h2>
    <p>{storeLabel(store)} · 在售 {live.length} 件。回读结果来自软件保存的记录，这一页不去读平台。</p>
    {live.length ? <ul className="listed-list" aria-label="在售的商品">{live.map(row =>
      <ListedRow key={row.id} row={row} onOpen={onOpenCandidate} />)}</ul>
      : <p role="status">这家店还没有在售的商品。</p>}
    {pending.length ? <section aria-label="已写到平台，回读还没通过">
      <h3>已写到平台，回读还没通过（{pending.length}）</h3>
      <ul className="listed-list">{pending.map(row => <ListedRow key={row.id} row={row} onOpen={onOpenCandidate} />)}</ul>
    </section> : null}
  </main>;
}
