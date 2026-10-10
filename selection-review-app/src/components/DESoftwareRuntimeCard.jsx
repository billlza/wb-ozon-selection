import { dESoftwareRuntimeDisplay, eReadbackRuntimeDisplay, dESavedJobRuntimeDisplay } from "../dESoftwareRuntimeView";
import { useSubmit } from "./FormRevisionNotice.jsx";

export default function DESoftwareRuntimeCard({ runtime, readback, savedJobRuntime = null, onContinueSaved = null,
  onDispatchNewRound = null, onRollbackAuthorization = null, onRecoverInitialImport = null, onReobserveUnknownOutcome = null,
  onReconcileFromPlatformState = null }) {
  const { saving, error, run } = useSubmit();
  const saved = dESavedJobRuntimeDisplay(savedJobRuntime);
  if (saved) return (
    <section className={`de-software-runtime-card status-${saved.tone}`} aria-label="D和E软件闭环状态">
      <header><div><small>生产与平台核验</small><h3>{saved.statusLabel}</h3></div></header>
      {saved.stages.map(stage => <div key={stage.stage} aria-label={stage.title}>
        <h4>{stage.title}：{stage.statusLabel}</h4>
        <p>{stage.receiptLabel}。</p>
        {stage.reconciliationMessage ? <p>{stage.reconciliationMessage}</p> : null}
        {stage.blockers.length ? <ul>{stage.blockers.map(message => <li key={message}>{message}</li>)}</ul> : null}
      </div>)}
      {saved.canContinueSaved ? <button type="button" disabled={saving || typeof onContinueSaved !== "function"}
        onClick={() => run(async () => { await onContinueSaved(saved.continuation); })}>
        {saving ? "正在继续已保存任务…" : "继续已保存任务"}</button> : null}
      {saved.canDispatchNewRound ? <div aria-label="再派一轮生产作业">
        <p>上一轮已经停下，而且记录证明一个请求都没有发到平台。可以在同一份生产授权下再派一轮执行：
          价格、库存、图片和顺序都不变，也不需要你重新签任何确认卡。</p>
        <button type="button" disabled={saving || typeof onDispatchNewRound !== "function"}
          onClick={() => run(async () => { await onDispatchNewRound(saved.newRound); })}>
          {saving ? "正在再派一轮…" : "再派一轮生产作业"}</button>
      </div> : saved.newRoundBlocker ? <p>{saved.newRoundBlocker}</p> : null}
      {saved.canReconcileFromPlatformState ? <div aria-label="按平台现状收口">
        <p>平台已经把这件商品建好了（商品号 {saved.platformStateReconciliation?.productId}）。导入任务过一段时间会被平台清掉，
          清掉以后「按新分类重新观察一次」读不到它，只会再停一次。按平台现状收口改为<strong>只读</strong>查两次：
          这件商品现在的状态（同一商品号、没有错误、价格已生效），和你授权的那个仓库的库存。
          库存正好等于你授权的数，就把这一轮登记成「库存由你填写」并收口；
          <strong>不会重发导入，也不会写库存，读到 0 也不写</strong>。核实不了会照旧停下，并说明停在哪一步。
          {saved.platformStateReconciliationAttemptsLeft !== null ? ` 这个导入任务还能这样收口 ${saved.platformStateReconciliationAttemptsLeft} 次。` : ""}</p>
        <button type="button" disabled={saving || typeof onReconcileFromPlatformState !== "function"}
          onClick={() => run(async () => { await onReconcileFromPlatformState(saved.platformStateReconciliation); })}>
          {saving ? "正在按平台现状收口…" : "按平台现状收口"}</button>
      </div> : saved.platformStateReconciliationBlocker ? <p>{saved.platformStateReconciliationBlocker.message ?? saved.platformStateReconciliationBlocker}</p> : null}
      {saved.canReobserveUnknownOutcome ? <div aria-label="按新分类重新观察一次">
        <p>上一次查询时，平台在导入任务上报了错误，当时的软件只要见到错误就一律判「结果未知」并停下，
          不区分「警告」和「真错误」。现在已经会区分了，所以可以按新规则再看一次。
          这一步<strong>只做只读查询</strong>，不会重发导入、不会写库存、不会改你确认过的任何内容。
          上面列出的就是上次停在什么上。<strong>看一次不保证一定能继续</strong>——
          如果确实有真错误，它还会停，但会把每条错误的级别和文案都显示在这里。</p>
        <button type="button" disabled={saving || typeof onReobserveUnknownOutcome !== "function"}
          onClick={() => run(async () => { await onReobserveUnknownOutcome(saved.reobservation); })}>
          {saving ? "正在重新观察…" : "按新分类重新观察一次"}</button>
      </div> : saved.reobservationBlocker ? <p>{saved.reobservationBlocker.message ?? saved.reobservationBlocker}</p> : null}
      {saved.canRecoverInitialImport ? <div aria-label="对账并登记本轮导入">
        <p>平台已经接受了这次导入（导入任务 {saved.recovery?.taskId}），商品在店铺里已经建好了；
          只是当时的查询期限已过，软件停下了，没有继续核对。现在可以把这次导入对账登记回来：
          软件只会做只读查询，确认商品状态和仓库库存，<strong>不会再往平台写任何东西</strong>。
          库存如果已经是你自己填好的数，软件只登记「这是你填的」，不会覆盖。</p>
        <button type="button" disabled={saving || typeof onRecoverInitialImport !== "function"}
          onClick={() => run(async () => { await onRecoverInitialImport(saved.recovery); })}>
          {saving ? "正在对账并登记…" : "对账并登记本轮导入"}</button>
      </div> : saved.recoveryBlocker ? <p>{saved.recoveryBlocker.message ?? saved.recoveryBlocker}</p> : null}
      {saved.canRollbackAuthorization ? <div aria-label="作废本轮生产授权">
        <p>这一轮已经走不下去了，而且记录证明一个字节都没有写到平台。可以作废本轮生产授权、退回等你确认：
          旧授权、旧确认卡和两轮失败记录全部归档留底，一条不删；价格、库存、15张图和文案都不动。
          作废之后你在最终确认卡上重新签一次，软件会排一轮全新的生产作业。</p>
        <button type="button" disabled={saving || typeof onRollbackAuthorization !== "function"}
          onClick={() => run(async () => { await onRollbackAuthorization(saved.rollback); })}>
          {saving ? "正在作废本轮授权…" : "作废本轮授权、退回等我确认"}</button>
      </div> : saved.rollbackBlocker && !saved.canDispatchNewRound ? <p>{saved.rollbackBlocker}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <p>{savedJobRuntime.currentVerified ? "当前商品的独立验证结果已保存。" : "尚未形成当前商品的独立验证通过结果。"}</p>
      <small>配置存在不代表平台在线。继续时会重新检查当前条件；已经发出的请求不会自动重发。</small>
    </section>
  );
  const display = dESoftwareRuntimeDisplay(runtime);
  const readbackDisplay = eReadbackRuntimeDisplay(readback);
  if (!display) return null;
  return (
    <section className={`de-software-runtime-card status-${display.tone}`} aria-label="D和E软件闭环状态">
      <header>
        <div>
          <small>D / E 软件闭环</small>
          <h3>{display.statusLabel}</h3>
        </div>
        <strong>{runtime.canExecutePlatformWrite ? "可执行" : "未开放写入"}</strong>
      </header>
      <p>
        OSS最终素材：{display.assetTransport.status === "verified"
          ? `已验证（${display.assetTransport.resolvedCount}个）`
          : display.assetTransport.status === "unknown_outcome"
            ? "结果未知，已停止"
            : display.assetTransport.status === "failed"
              ? "执行条件检查未通过，未发起上传"
            : display.assetTransport.status === "in_flight"
              ? "已保存传输意图，结果待核对"
              : "尚未准备"}
      </p>
      {display.execution ? (
        <p>
          执行开始：{display.execution.startedAt || "未记录"}；最近进展：{display.execution.lastProgressAt || "未记录"}。
          {display.execution.taskId ? ` 平台任务号：${display.execution.taskId}。` : ""}
          {display.execution.productId ? ` 商品编号：${display.execution.productId}。` : ""}
        </p>
      ) : null}
      {display.gaps.length > 0 ? (
        <ul>
          {display.gaps.map((item) => <li key={`${item.code}:${item.field}`}>{item.message}</li>)}
        </ul>
      ) : <p>当前没有未解决的准备度缺口。</p>}
      {readbackDisplay ? <div aria-label="平台独立回读结果">
        <h4>{readbackDisplay.statusLabel}</h4>
        {readbackDisplay.startedAt ? <p>开始读取：{readbackDisplay.startedAt}；
          {readbackDisplay.completedAt ? `记录完成：${readbackDisplay.completedAt}` : "尚未保存完成结果"}。</p> : null}
        {readbackDisplay.gaps.length ? <ul>{readbackDisplay.gaps.map(message => <li key={message}>{message}</li>)}</ul> : null}
        <p>{readbackDisplay.verified ? "商品、图片顺序、价格、指定仓库库存和销售状态均已对应本次写入。"
          : "尚未形成当前商品的独立验证；读取失败后不会自动重复查询。"}</p>
      </div> : null}
      <small>每次执行一次，结果未知时停止并等待核对。平台写入：{runtime.platformWrites === "unknown" ? "结果待核对" : runtime.platformWrites}</small>
    </section>
  );
}
