/**
 * 「做这件」之后软件做到了哪一步、停在哪儿等你。整份来自服务端的 gate1AutopilotView（lib/gate1-autopilot.mjs），
 * 页面不自己判断。软件只做不花钱的几步（重算利润、补供应属性、整理属性和关键词、准备文案请求、文案写好后进入传图）；
 * 要花钱、要你声明权利、要你传图和点「上架」时停下，停在哪儿就在这里说一句。
 *
 * 只有两种情况有按钮：还没有许可的老商品（「让软件接着做」，点一下就是许可），和软件某一步出错停下的
 * （「让软件再试一次」）。软件不会自己在同一份资料上重试。
 */
const TITLES = Object.freeze({
  running: "软件正在接着做",
  working: "软件正在接着做",
  ready: "这一步可以让软件接着做",
  failed: "软件停下了",
  waiting_owner: "现在等你"
});

export function gate1AutopilotDoneLine(view) {
  const steps = Array.isArray(view?.ranSteps) ? view.ranSteps : [];
  const labels = [...new Set(steps.map(item => item.label).filter(Boolean))];
  if (!labels.length) return null;
  // 读那一次 Ozon 同款页面是唯一一步打开了平台的：照实说，只看、没写。
  const read = steps.some(item => item.step === "a_read_ozon_benchmark");
  return `软件已经替你做了：${labels.join("、")}。` + (read
    ? "除了用你的浏览器读那一次 Ozon 同款页面（只看，没写任何东西），都只用已经保存的资料，也没有花钱。"
    : "都只用已经保存的资料，没有打开平台，也没有花钱。");
}

export default function Gate1AutopilotSection({ candidate, saving = false, onContinue = null }) {
  const view = candidate?.gate1AutopilotView;
  if (!view || !TITLES[view.status]) return null;
  const done = gate1AutopilotDoneLine(view);
  const canContinue = ["ready", "failed"].includes(view.status) && typeof onContinue === "function";
  const stops = Array.isArray(view.stops) ? view.stops : [];
  return <section className={`product-section product-autopilot product-autopilot-${view.status}`} aria-label="软件接着做">
    <h3>{TITLES[view.status]}</h3>
    {view.status === "waiting_owner" && stops.length > 1
      ? <ul className="product-autopilot-stops">{stops.map(item => <li key={`${item.code}:${item.line}`}>{item.line}</li>)}</ul>
      : <p role="status">{view.line}。</p>}
    {view.moreStops > 0 ? <p className="product-section-hint">还有 {view.moreStops} 项，在下面各节里。</p> : null}
    {done ? <p className="product-section-hint">{done}</p> : null}
    {canContinue ? <button type="button" className="button primary" disabled={saving}
      onClick={() => onContinue({ dataRevision: candidate.dataRevision })}>
      {view.status === "failed" ? "让软件再试一次" : "让软件接着做"}</button> : null}
    {view.status === "ready" ? <p className="product-actions-note">点一下，这一步和之后不花钱的几步都由软件接着做；
      文案写好就直接进入传图，文案和图片最后在上架卡上一起看。要花钱、要你声明品牌与权利、要你传图和点「上架」时，它停下来等你。</p> : null}
  </section>;
}
