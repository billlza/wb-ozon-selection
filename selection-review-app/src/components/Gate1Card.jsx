import { useState } from "react";
import { IMAGE_MATCH_JUDGEMENT_LABELS, supplierImageMatchView } from "../supplierImageMatchView.js";
import { ozonImageMatchView, ozonSearchQueryReady } from "../ozonImageMatchView.js";
import {
  GATE1_PICK_TAGS, GATE1_SKIP_REASONS, gate1AcceptPayload, gate1AcceptedLine, gate1CardView, gate1Mode, gate1ReopenLine,
  gate1ShortfallView, gate1SkipErrors, gate1SkipPayload, rubles, yuan
} from "../gate1View.js";

/**
 * 「做这件」确认卡（关口 1）。软件先选好最像的 Ozon 同款、最像的 1688 同款和最便宜又能一件起订的货源，主人只改不对的，
 * 一次点「做这件」或「不做这件」。软件从不替主人确认同款：卡上每一格都标着是软件先选的还是主人改过的，点之前什么都没定。
 *
 * 做这件只把认下来的东西存成找货方案并申请采集这家货源的规格；不确认供货、不下单、不碰平台（AGENTS.md §4.4）。
 * 正式利润没过线时卡回来，写明差多少，给换货源 / 改售价 / 不做三条路。
 */
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
const percent = value => (finite(value) === null ? null : `${Math.round(value * 100)}%`);

function StepResult({ at, noticeAt, error, notice }) {
  if (noticeAt !== at) return null;
  return <>
    {error ? <p role="alert" className="product-step-result">{error}</p> : null}
    {notice ? <p role="status" className="product-notice product-step-result">{notice}</p> : null}
  </>;
}

function Tag({ tag }) {
  if (!tag) return null;
  return <span className={`gate1-tag gate1-tag-${tag}`}>{GATE1_PICK_TAGS[tag]}</span>;
}

function Thumb({ url, label }) {
  return url
    ? <img className="image-match-thumb" src={url} alt={label} width="88" height="88" loading="lazy" referrerPolicy="no-referrer" />
    : <span className="image-match-thumb product-thumb-empty">{label}</span>;
}

/** 一格：下拉里是这次找同款结果里能当同款的几条，最像的在最上面。 */
function PickRow({ id, label, tag, value, options, optionLabel, onChange, emptyLine, children }) {
  return <div className="gate1-pick" role="group" aria-label={label}>
    <label className="gate1-pick-label" htmlFor={id}>{label} <Tag tag={tag} /></label>
    {options.length ? <select id={id} value={value ?? ""} onChange={event => onChange(event.target.value || null)}>
      {value === null ? <option value="">不选</option> : null}
      {options.map(option => <option key={option.value} value={option.value}>{optionLabel(option)}</option>)}
    </select> : <p className="product-actions-note">{emptyLine}</p>}
    {children}
  </div>;
}

function supplierFacts(row) {
  if (!row) return null;
  const parts = [row.priceCny === null ? "价格没读到" : yuan(row.priceCny),
    row.domesticShippingRmb === null ? "运费没读到" : row.domesticShippingRmb === 0 ? "包邮" : `运费 ${yuan(row.domesticShippingRmb)}`,
    row.moqOne ? "一件起订" : row.quantityBegin === null ? "起批量没读到，打开 1688 页面核对" : `${row.quantityBegin} 件起批`];
  if (row.shopName) parts.push(row.shopName);
  return parts.join(" · ");
}

function SkipControl({ saving, defaultReason = null, onSkip, label = "不做这件" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const [note, setNote] = useState("");
  const error = reason === null ? null : gate1SkipErrors(reason, note);
  if (!open) return <button type="button" className="button secondary" disabled={saving} onClick={() => setOpen(true)}>{label}</button>;
  return <div className="gate1-skip" role="group" aria-label="不做的原因">
    <span className="product-actions-note">为什么不做？原因会记进店铺档案，下次选品参考。</span>
    <span className="gate1-skip-reasons">
      {Object.entries(GATE1_SKIP_REASONS).map(([code, text]) => <button key={code} type="button" aria-pressed={reason === code}
        className={`button ${reason === code ? "primary" : "secondary"}`} disabled={saving} onClick={() => setReason(code)}>{text}</button>)}
    </span>
    <label className="product-field" htmlFor="gate1-skip-note">
      <span className="product-field-label">{reason === "other" ? "写一句为什么" : "补一句（可不填）"}</span>
      <input id="gate1-skip-note" type="text" maxLength={200} value={note} onChange={event => setNote(event.target.value)} />
    </label>
    {reason !== null && error ? <span className="product-field-error" role="alert">{error}</span> : null}
    <span className="gate1-actions">
      <button type="button" className="button primary" disabled={saving || reason === null || error !== null}
        onClick={() => onSkip(reason, note)}>确认不做</button>
      <button type="button" className="button secondary" disabled={saving} onClick={() => setOpen(false)}>取消</button>
    </span>
  </div>;
}

export default function Gate1Card({ candidate, gate1, storeName, saving, noticeAt, error, notice, run, onAccept, onSkip, onShortfall,
  onStartImageMatch = null, onCompareImageMatch = null, onJudgeImageMatch = null,
  onStartOzonMatch = null, onCompareOzonMatch = null, onJudgeOzonMatch = null }) {
  const [local, setLocal] = useState({});
  const [facts, setFacts] = useState({});
  const [seenRevision, setSeenRevision] = useState(candidate?.dataRevision);
  // 服务端存下新的一版（比如找同款刚读回来），软件先选的可能换了：主人改过的格子作废，按新的一版重新先选。
  if (candidate?.dataRevision !== seenRevision) { setSeenRevision(candidate?.dataRevision); setLocal({}); }
  const mode = gate1Mode(gate1, candidate);
  if (mode === "hidden" || mode === "skipped") return null;
  const matchSections = <MatchSections candidate={candidate} saving={saving} noticeAt={noticeAt} error={error} notice={notice} run={run}
    onStartImageMatch={onStartImageMatch} onCompareImageMatch={onCompareImageMatch} onJudgeImageMatch={onJudgeImageMatch}
    onStartOzonMatch={onStartOzonMatch} onCompareOzonMatch={onCompareOzonMatch} onJudgeOzonMatch={onJudgeOzonMatch} />;

  if (mode === "accepted") {
    return <section className="product-section gate1-card gate1-card-done" aria-label="做这件">
      <h3>做这件</h3>
      <p className="gate1-done-line">{gate1AcceptedLine(gate1.decision)}</p>
      <StepResult at="gate1" noticeAt={noticeAt} error={error} notice={notice} />
    </section>;
  }

  if (mode === "shortfall") {
    const view = gate1ShortfallView(gate1.shortfall);
    const choose = choice => run(onShortfall, { dataRevision: candidate.dataRevision, choice },
      choice === "change_price" ? "「做这件」卡重新打开了：改一个售价再做；上一轮的记录都留着。"
        : "「做这件」卡重新打开了：换一家货源再做；上一轮的记录都留着。", "gate1");
    return <section className="product-section gate1-card gate1-card-shortfall" aria-label="正式利润没过线">
      <h3>正式利润没过线</h3>
      <p className="product-capture-blocked" role="alert">{view.line}</p>
      <div className="gate1-actions">
        {view.choices.filter(item => item.choice !== "skip").map(item => <button key={item.choice} type="button"
          className="button primary" disabled={saving} onClick={() => choose(item.choice)}>{item.label}</button>)}
        <SkipControl saving={saving} defaultReason="thin_profit" label="不做"
          onSkip={(reason, note) => run(onShortfall, { dataRevision: candidate.dataRevision, choice: "skip", ...gate1SkipPayload(reason, note, candidate.dataRevision) },
            "已不做这件，原因记进了店铺档案；可以在「已淘汰」里恢复。", "gate1")} />
      </div>
      <StepResult at="gate1" noticeAt={noticeAt} error={error} notice={notice} />
    </section>;
  }

  const card = gate1CardView(gate1, { local, facts });
  const choose = key => value => setLocal(current => ({ ...current, [key]: value }));
  const changeFact = key => event => setFacts(current => ({ ...current, [key]: event.target.value }));
  const reopenLine = gate1ReopenLine(gate1.reopen);
  return <section className="product-section gate1-card" aria-label="做这件">
    <h3>做这件？</h3>
    {reopenLine ? <p className="product-capture-status" role="status">{reopenLine}</p> : null}
    <p className="product-section-hint">软件已经按找同款的结果先选好了下面三格，你只改不对的。点「做这件」之前什么都没定；点了也只是存下方案、去采这家货源的规格，
      不确认供货、不下单、不碰平台。</p>
    <p className="gate1-store">店铺：{storeName}（默认；上架那一步再选平台和店铺）</p>

    <div className="gate1-compare" aria-label="首图对比">
      <figure><Thumb url={candidate.imageUrl} label="这件商品" /><figcaption>这件商品</figcaption></figure>
      <figure><Thumb url={card.ozon?.imageUrl} label="Ozon 同款" /><figcaption>Ozon 同款</figcaption></figure>
      <figure><Thumb url={card.supplier?.imageUrl} label="货源" /><figcaption>货源</figcaption></figure>
    </div>

    <PickRow id="gate1-ozon" label="Ozon 同款" tag={card.tags.ozon} value={card.picks.ozonProductId}
      options={card.ozonOptions.map(row => ({ ...row, value: row.productId }))} onChange={choose("ozonProductId")}
      optionLabel={row => `${row.judgement === "exact" ? "你点过是同款 · " : ""}${row.title}${row.priceRub === null ? "" : ` · ${rubles(row.priceRub)}`}`}
      emptyLine="Ozon 找同款还没有找到首图一致或很像的商品；售价先按这件商品自己的 Ozon 价算。">
      {card.ozon ? <a className="gate1-link" href={card.ozon.sourceUrl} target="_blank" rel="noreferrer noopener">打开这件 Ozon 商品</a> : null}
    </PickRow>

    <PickRow id="gate1-match" label="1688 同款（最像的）" tag={card.tags.match} value={card.picks.matchOfferId}
      options={card.supplierOptions.map(row => ({ ...row, value: row.offerId }))} onChange={choose("matchOfferId")}
      optionLabel={row => `${row.judgement === "exact" ? "你点过是同款 · " : ""}${row.title}`}
      emptyLine="1688 找同款还没有找到首图一致或很像的商品。" />

    <PickRow id="gate1-supplier" label="货源（最便宜又能一件起订）" tag={card.tags.supplier} value={card.picks.supplierOfferId}
      options={card.supplierOptions.map(row => ({ ...row, value: row.offerId }))} onChange={choose("supplierOfferId")}
      optionLabel={row => `${row.title} · ${supplierFacts(row)}`}
      emptyLine="还没有能当货源的 1688 同款。">
      {card.supplier ? <p className="image-match-facts">{supplierFacts(card.supplier)}
        {" · "}<a href={card.supplier.sourceUrl} target="_blank" rel="noreferrer noopener">打开 1688 页面核对</a></p> : null}
    </PickRow>

    <p className={`gate1-profit gate1-profit-${card.profit.status}`}>{card.profit.text}</p>
    <p className="product-actions-note">{card.basisLine}</p>
    <p className={card.brand.level === "warn" ? "product-capture-blocked" : "product-actions-note"}
      role={card.brand.level === "warn" ? "alert" : undefined}>{card.brand.line}</p>

    {card.askFor.length ? <div className="product-form gate1-facts" aria-label="软件读不到的几项">
      {card.askFor.map(item => item.key === "dimensionsCm"
        ? ["length", "width", "height"].map(side => <label key={side} className="product-field" htmlFor={`gate1-${side}`}>
          <span className="product-field-label">{{ length: "包装长（厘米）", width: "包装宽（厘米）", height: "包装高（厘米）" }[side]}</span>
          <input id={`gate1-${side}`} type="number" inputMode="decimal" value={facts[side] ?? ""} onChange={changeFact(side)} />
          {card.factErrors[side] && facts[side] ? <span className="product-field-error">{card.factErrors[side]}</span>
            : side === "length" ? <span className="product-field-hint">{item.hint}</span> : null}
        </label>)
        : <label key={item.key} className="product-field" htmlFor={`gate1-${item.key}`}>
          <span className="product-field-label">{item.label}</span>
          <input id={`gate1-${item.key}`} type="number" inputMode="decimal" value={facts[item.key] ?? ""} onChange={changeFact(item.key)} />
          {card.factErrors[item.key] && facts[item.key] ? <span className="product-field-error">{card.factErrors[item.key]}</span>
            : item.hint ? <span className="product-field-hint">{item.hint}</span> : null}
        </label>)}
    </div> : null}

    <div className="gate1-actions">
      <button type="button" className="button primary" disabled={saving || !card.canAccept}
        onClick={() => run(onAccept, gate1AcceptPayload(gate1, card, facts, candidate.dataRevision),
          "已做这件：方案存下了，正在让插件去采这家货源的规格。", "gate1")}>
        {saving && noticeAt === "gate1" ? "正在保存…" : "做这件"}</button>
      <SkipControl saving={saving} onSkip={(reason, note) => run(onSkip, gate1SkipPayload(reason, note, candidate.dataRevision),
        "已不做这件，原因记进了店铺档案；可以在「已淘汰」里恢复。", "gate1")} />
      {card.blockers.length ? <span className="product-actions-note">{card.blockers.join("；")}。</span> : null}
    </div>
    <StepResult at="gate1" noticeAt={noticeAt} error={error} notice={notice} />
    {matchSections}
  </section>;
}

/** 两个找同款区块，原样从商品页挪进卡里：结果逐条由主人判断，判断会让软件先选的那一格跟着变。 */
function MatchSections({ candidate, saving, noticeAt, error, notice, run, onStartImageMatch, onCompareImageMatch, onJudgeImageMatch,
  onStartOzonMatch, onCompareOzonMatch, onJudgeOzonMatch }) {
  return <details className="product-folded gate1-matches" open={!candidate.supplierImageMatch || !candidate.ozonImageMatch}>
    <summary>找同款结果<span className="product-folded-state">逐条判断，软件按你的判断重新先选</span></summary>
    {typeof onStartOzonMatch === "function" ? <OzonMatchSection candidate={candidate} saving={saving} noticeAt={noticeAt}
      error={error} notice={notice}
      onStart={payload => run(onStartOzonMatch, payload, payload.searchBy === "image"
        ? "已经让插件去 Ozon 用首图搜一次，读完这里会按首图像不像列出结果。"
        : `已经让插件去 Ozon 搜「${payload.query}」，读完这里会按首图像不像列出结果。`, "ozon-match")}
      onCompare={payload => run(onCompareOzonMatch, payload, "正在重新比对首图，比完这里会更新。", "ozon-match")}
      onJudge={payload => run(onJudgeOzonMatch, payload, payload.judgement === "clear"
        ? "已撤回这条判断。" : `已记下：这条${IMAGE_MATCH_JUDGEMENT_LABELS[payload.judgement]}。这只是同款判断，没有改这件商品的任何东西。`,
      "ozon-match")} /> : null}
    {typeof onStartImageMatch === "function" ? <ImageMatchSection candidate={candidate} saving={saving} noticeAt={noticeAt}
      error={error} notice={notice}
      onStart={payload => run(onStartImageMatch, payload, "已经让插件去 1688 用首图搜一次，读完这里会列出最像的结果。", "image-match")}
      onCompare={payload => run(onCompareImageMatch, payload, "正在重新比对首图，比完这里会更新。", "image-match")}
      onJudge={payload => run(onJudgeImageMatch, payload, payload.judgement === "clear"
        ? "已撤回这条判断。" : `已记下：这条${IMAGE_MATCH_JUDGEMENT_LABELS[payload.judgement]}。这只是同款判断，没有改货源、也没有确认供货。`,
      "image-match")} /> : null}
  </details>;
}

/**
 * 在 1688 找同款：拿拼多多或 1688 货源首图（没有就用 Ozon 主图），用主人自己 Chrome 里登录的 1688 搜一次，列出最像的结果。
 * 软件只标首图像不像，是不是同款由主人逐条点；点了也只是记下判断，不改货源链接、不确认供货（AGENTS.md §4.3）。
 */
export function ImageMatchSection({ candidate, saving, noticeAt, error, notice, onStart, onCompare, onJudge }) {
  const view = supplierImageMatchView(candidate);
  if (view === null) return null;
  const start = acknowledgeUnknownOutcome => onStart({ dataRevision: candidate.dataRevision,
    ...(acknowledgeUnknownOutcome ? { acknowledgeUnknownOutcome: true } : {}) });
  const judge = (offerId, judgement) => onJudge({ dataRevision: candidate.dataRevision, captureId: view.captureId, offerId, judgement });
  return <section className="product-image-match" aria-label="在 1688 找同款">
    <h4>在 1688 找同款</h4>
    <div className="image-match-source">
      {view.sourceImageUrl
        ? <img className="image-match-thumb" src={view.sourceImageUrl} alt={view.sourceLabel} width="96" height="96" loading="lazy" referrerPolicy="no-referrer" />
        : <span className="image-match-thumb product-thumb-empty">首图</span>}
      <div>
        <p className="product-section-hint">用这张{view.sourceLabel}，在你 Chrome 里登录的 1688 上搜一次图，读回最像的 20 条。软件只比两张首图像不像；
          是不是同款由你逐条判断，判断只记在这里，不会改货源链接，也不会确认供货。</p>
        {view.lowestPriceCny !== null ? <p className="image-match-price">
          {view.sourcePlatform === "1688" ? "你给的这家 1688 最低价" : "拼多多最低拼单价"}：{yuan(view.lowestPriceCny)}</p> : null}
        {view.sourceReason ? <p className="product-capture-hint">{view.sourceReason}</p> : null}
      </div>
    </div>
    {view.statusLine ? <p className={view.failed ? "product-capture-blocked" : "product-capture-status"} role={view.failed ? "alert" : "status"}>
      {view.statusLine}</p> : null}
    <div className="product-actions">
      {view.unknownOutcome
        ? <button type="button" className="button primary" disabled={saving || !view.canStart}
          onClick={() => start(true)}>我知道上次结果未知，重新找一次</button>
        : <button type="button" className={`button ${view.status === null ? "primary" : "secondary"}`} disabled={saving || !view.canStart}
          onClick={() => start(false)}>{saving && noticeAt === "image-match" ? "正在申请…" : view.status === null ? "用首图在 1688 找同款" : "再找一次"}</button>}
      {view.canCompare ? <button type="button" className="button secondary" disabled={saving}
        onClick={() => onCompare({ dataRevision: candidate.dataRevision, captureId: view.captureId })}>重新比对首图</button> : null}
    </div>
    <StepResult at="image-match" noticeAt={noticeAt} error={error} notice={notice} />
    {view.rows.length ? <ol className="image-match-results">
      {view.rows.map(row => <li key={row.offerId} className={`image-match-row image-match-${row.similarity}`}>
        {row.imageUrl
          ? <img className="image-match-thumb" src={row.imageUrl} alt="" width="72" height="72" loading="lazy" referrerPolicy="no-referrer" />
          : <span className="image-match-thumb product-thumb-empty">无图</span>}
        <div className="image-match-body">
          <p className="image-match-head">
            <span className={`image-match-badge image-match-badge-${row.similarity}`}
              title={row.distance === null ? undefined : `首图指纹相差 ${row.distance} / 64`}>{row.similarityLabel}</span>
            {row.isAd ? <span className="image-match-tag">广告</span> : null}
            {row.superFactory ? <span className="image-match-tag">超级工厂</span> : null}
            {row.isSourceOffer ? <span className="image-match-tag">就是你给的这家</span> : null}
            <a href={row.sourceUrl} target="_blank" rel="noreferrer noopener">{row.title}</a>
          </p>
          <p className="image-match-facts">
            {row.priceCny === null ? "价格没读到" : yuan(row.priceCny)}
            {row.priceNote ? ` · ${row.priceNote}` : ""}
            {row.priceDifferenceCny === null || row.isSourceOffer ? "" : row.priceDifferenceCny === 0 ? ` · 和${view.priceBaseLabel}一样`
              : ` · 比${view.priceBaseLabel}${row.priceDifferenceCny < 0 ? "低" : "高"} ${yuan(Math.abs(row.priceDifferenceCny))}`}
          </p>
          <p className={`image-match-facts${row.quantity.ok === false ? " product-capture-blocked" : ""}`}>
            {row.quantity.text}
            {row.saleQuantity === null ? "" : ` · 已售 ${row.saleQuantity}`}
            {row.shopName ? ` · ${row.shopName}` : ""}{row.location ? ` · ${row.location}` : ""}
            {row.vendorSimilarity === null ? "" : ` · 1688 相似度 ${percent(row.vendorSimilarity)}`}
          </p>
          {view.judgeable ? <div className="image-match-judge" role="group" aria-label={`判断 ${row.title}`}>
            {Object.entries(IMAGE_MATCH_JUDGEMENT_LABELS).map(([judgement, label]) =>
              <button key={judgement} type="button" aria-pressed={row.judgement === judgement}
                className={`button ${row.judgement === judgement ? "primary" : "secondary"}`} disabled={saving}
                onClick={() => judge(row.offerId, row.judgement === judgement ? "clear" : judgement)}>{label}</button>)}
          </div> : null}
        </div>
      </li>)}
    </ol> : null}
    {view.rows.length ? <p className="product-actions-note">近似款只能当价格参考，不能当供货方案。要用其中一个 1688 货源，打开它核对规格、一件起订和运费后，
      在上面「货源」那一格选它。</p> : null}
  </section>;
}

/**
 * 在 Ozon 找同款：先用首图在 Ozon 以图搜，只找到近似款时用俄文词再搜（后备），再拿首图和每件结果的主图比，最像的排前面。
 * 软件只标首图像不像，是不是同款由主人逐条点；点了也只是记下判断，不改这件商品的任何东西（AGENTS.md §4.3）。
 */
export function OzonMatchSection({ candidate, saving, noticeAt, error, notice, onStart, onCompare, onJudge }) {
  const view = ozonImageMatchView(candidate);
  const [query, setQuery] = useState(view?.suggestedQuery ?? "");
  const [seeded, setSeeded] = useState(view?.suggestedQuery ?? "");
  // A newer suggestion (the last search's words, once it is saved) replaces the box only while the owner has not typed.
  if (view && view.suggestedQuery !== seeded) {
    setSeeded(view.suggestedQuery);
    if (query === seeded) setQuery(view.suggestedQuery);
  }
  if (view === null) return null;
  const ready = ozonSearchQueryReady(query);
  // 以图搜不带词；词搜带上框里的词。上次结果未知时，两种都要主人先说一声知道了。
  const start = searchBy => onStart({ dataRevision: candidate.dataRevision, searchBy,
    ...(searchBy === "text" ? { query: query.trim() } : {}), ...(view.unknownOutcome ? { acknowledgeUnknownOutcome: true } : {}) });
  const judge = (productId, judgement) => onJudge({ dataRevision: candidate.dataRevision, captureId: view.captureId, productId, judgement });
  const requesting = saving && noticeAt === "ozon-match";
  const known = view.unknownOutcome ? "我知道上次结果未知，" : "";
  return <section className="product-image-match product-ozon-match" aria-label="在 Ozon 找同款">
    <h4>在 Ozon 找同款</h4>
    <div className="image-match-source">
      {view.sourceImageUrl
        ? <img className="image-match-thumb" src={view.sourceImageUrl} alt={view.sourceLabel} width="96" height="96" loading="lazy" referrerPolicy="no-referrer" />
        : <span className="image-match-thumb product-thumb-empty">首图</span>}
      <div>
        <p className="product-section-hint">先用这张{view.sourceLabel}在 Ozon 以图搜一次，再拿它和搜到的每件商品的主图比，最像的排在前面。
          是不是同款由你逐条判断，判断只记在这里，不会改这件商品的任何东西。</p>
        {view.sourceReason ? <p className="product-capture-hint">{view.sourceReason}</p> : null}
      </div>
    </div>
    {view.statusLine ? <p className={view.failed ? "product-capture-blocked" : "product-capture-status"} role={view.failed ? "alert" : "status"}>
      {view.statusLine}</p> : null}
    <div className="product-actions">
      <button type="button" className="button primary" disabled={saving || !view.canStart}
        onClick={() => start("image")}>{requesting ? "正在申请…" : `${known}${view.status === null ? "用首图在 Ozon 搜" : "用首图再搜一次"}`}</button>
      {view.canCompare ? <button type="button" className="button secondary" disabled={saving}
        onClick={() => onCompare({ dataRevision: candidate.dataRevision, captureId: view.captureId })}>重新比对首图</button> : null}
    </div>
    <div className="image-match-fallback">
      <label className="product-field" htmlFor="ozon-match-query">
        <span className="product-field-label">以图搜只找到近似款时，用俄文词再搜（后备）</span>
        <input id="ozon-match-query" type="text" name="ozon-match-query" value={query} maxLength={100}
          placeholder="например: жилет для кошки" onChange={event => setQuery(event.target.value)} />
        <span className="product-actions-note">{query === view.suggestedQuery && query ? view.suggestionNote
          : query ? "用你填的词搜。" : view.suggestionNote}</span>
      </label>
      <button type="button" className="button secondary" disabled={saving || !view.canStart || !ready}
        onClick={() => start("text")}>{`${known}用俄文词搜`}</button>
    </div>
    <StepResult at="ozon-match" noticeAt={noticeAt} error={error} notice={notice} />
    {view.rows.length ? <ol className="image-match-results">
      {view.rows.map(row => <li key={row.productId} className={`image-match-row image-match-${row.similarity}`}>
        {row.imageUrl
          ? <img className="image-match-thumb" src={row.imageUrl} alt="" width="72" height="72" loading="lazy" referrerPolicy="no-referrer" />
          : <span className="image-match-thumb product-thumb-empty">无图</span>}
        <div className="image-match-body">
          <p className="image-match-head">
            <span className={`image-match-badge image-match-badge-${row.similarity}`}
              title={row.distance === null ? undefined : `首图指纹相差 ${row.distance} / 64`}>{row.similarityLabel}</span>
            {row.isAd ? <span className="image-match-tag">广告</span> : null}
            {row.isSourceProduct ? <span className="image-match-tag">就是这件商品自己</span> : null}
            {row.samePictureOthers > 0 ? <span className="image-match-tag">同一张图还有 {row.samePictureOthers} 个商品，可能是别的规格</span> : null}
            <a href={row.sourceUrl} target="_blank" rel="noreferrer noopener">{row.title}</a>
          </p>
          <p className="image-match-facts">
            {row.priceRub === null ? "价格没读到" : rubles(row.priceRub)}
            {row.originalPriceRub === null ? "" : ` · 原价 ${rubles(row.originalPriceRub)}`}
            {row.rating === null ? "" : ` · ${row.rating} 分`}
            {row.reviewCount === null ? "" : ` · ${row.reviewCount} 条评价`}
          </p>
          {view.judgeable ? <div className="image-match-judge" role="group" aria-label={`判断 ${row.title}`}>
            {Object.entries(IMAGE_MATCH_JUDGEMENT_LABELS).map(([judgement, label]) =>
              <button key={judgement} type="button" aria-pressed={row.judgement === judgement}
                className={`button ${row.judgement === judgement ? "primary" : "secondary"}`} disabled={saving}
                onClick={() => judge(row.productId, row.judgement === judgement ? "clear" : judgement)}>{label}</button>)}
          </div> : null}
        </div>
      </li>)}
    </ol> : null}
    {view.rows.length ? <p className="product-actions-note">{view.searchBy === "image"
      ? "以图搜按样子找，不保证有一模一样的；首图不像的也可能是换了图的同款，没搜到也不说明 Ozon 上没有同款。可以用俄文词再搜一次。"
      : "搜到的是这几个词的结果，首图不像的也可能是换了图的同款，没搜到也不说明 Ozon 上没有同款；换几个词可以再搜一次。"}</p> : null}
  </section>;
}
