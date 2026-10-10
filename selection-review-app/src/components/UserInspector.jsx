import { useMemo, useState } from "react";
import { buildBExactCommissionInput } from "../bExactCommissionInput.js";
import FormRevisionNotice, { useCandidateForm, useSubmit } from "./FormRevisionNotice.jsx";
import { platformOfStore } from "../../lib/store-registry.mjs";
import { optionalNumber, candidatePlatform, safeWebUrl } from "../formState.js";
import { finiteDisplayNumber, formatMoney, formatPercent } from "../finiteDisplay.js";
import { buildCandidateCommentInput, shouldClearSubmittedComment } from "../commentInput.js";
import C2FinalAssetsPanel from "./C2FinalAssetsPanel.jsx";
export { default as C2FinalAssetsPanel } from "./C2FinalAssetsPanel.jsx";
import FinalProductPlanCard from "./FinalProductPlanCard.jsx";
import FinalPricingReviewForm from "./FinalPricingReviewForm.jsx";
import C1RightsReviewPanel from "./C1RightsReviewPanel.jsx";
import C1PaidDraftPanel from "./C1PaidDraftPanel.jsx";
import C1OzonAttributePanel from "./C1OzonAttributePanel.jsx";
import { candidateStoreFrozen, candidateProductionFactsFrozen } from "../../lib/candidate-user-fields.mjs";
import { STORE_LABELS } from "../constants";
import { salesCaptureFailurePresentation } from "../extensionStatus";
import { wbPresentation } from "../wbPresentation";
import { MessageIcon } from "./Icons";
import { evaluatePostLaunchObservation, POST_LAUNCH_THRESHOLDS } from "../../lib/post-launch-observation.mjs";

function formFromCandidate(candidate) {
  const dimensions = candidate.dimensionsCm || {};
  return {
    productUrl: candidate.productUrl || "",
    sourceUrl: candidate.sourceUrl || "",
    purchasePriceRmb: candidate.purchasePriceRmb ?? "",
    packagingCostRmb: candidate.packagingCostRmb ?? "",
    packedWeightKg: candidate.packedWeightKg ?? "",
    length: dimensions.length ?? "",
    width: dimensions.width ?? "",
    height: dimensions.height ?? "",
    powered: candidate.powered === true ? "true" : candidate.powered === false ? "false" : "unknown",
    expectedPriceRub: candidate.expectedPriceRub ?? "",
    notes: candidate.notes || ""
  };
}

function StoreSelectionPanel({ candidate, onUpdate }) {
  const [store, setStore, guard] = useCandidateForm(candidate, candidate.targetStore);
  const { saving, error, run } = useSubmit();
  const frozen = candidateStoreFrozen(candidate);
  function save(event) {
    event.preventDefault();
    return run(async () => {
      guard.assertCurrent();
      await onUpdate({ targetStore: store, dataRevision: guard.sourceRevision });
    });
  }
  return <section className="workflow-card" aria-label="目标店铺选择">
    <h3>目标店铺</h3>
    {frozen ? <p>{STORE_LABELS[candidate.targetStore]} · 已冻结，不能换绑店铺。</p> : <form onSubmit={save}>
      <label>保存时使用已配置的店铺身份
        <select aria-label="目标店铺" value={store} disabled={saving || guard.conflict} onChange={event => setStore(event.target.value)}>
          {Object.entries(STORE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <FormRevisionNotice guard={guard} disabled={saving} />
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="button secondary" disabled={saving || guard.conflict || !onUpdate}>{saving ? "保存中…" : "保存店铺选择"}</button>
    </form>}
  </section>;
}

function DirectionPanel({ candidate, onEvaluate }) {
  const [reason, setReason, guard] = useCandidateForm(candidate, candidate.userEvaluation?.reason || "");
  const { saving, error, run } = useSubmit();

  async function decide(decision) {
    return run(async () => {
      guard.assertCurrent();
      await onEvaluate({ decision, reason, dataRevision: guard.sourceRevision });
    });
  }

  return (
    <section className="workflow-card direction-card">
      <div>
        <h3>只需判断方向</h3>
        <p>不行会立即淘汰；确认方向后先完成A阶段供应方案与精确SKU确认，不会从这里跳过A直接计算B利润。</p>
      </div>
      {candidate.sourceReview?.status === "mismatch" ? (
        <div className="source-review-notice">
          <strong>历史来源不一致记录（只拦当前SKU，不是方向淘汰）</strong>
          <span>{candidate.sourceReview.reason}</span>
          <small>{candidate.sourceReview.nextAction}</small>
        </div>
      ) : null}
      <PurchaseCeiling ceiling={candidate.purchaseCeiling} />
      <textarea
        aria-label="判断理由"
        rows="2"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="理由可选，不填写也可以"
      />
      <FormRevisionNotice guard={guard} disabled={saving} />
      {error && <p role="alert">{error}</p>}
      <div className="direction-actions">
        <button type="button" className="decision viable" disabled={Boolean(saving) || guard.conflict} onClick={() => decide("viable")}>{saving ? "提交中…" : "可做"}</button>
        <button type="button" className="decision reject" disabled={Boolean(saving) || guard.conflict} onClick={() => decide("reject")}>{saving ? "淘汰中…" : "不行"}</button>
      </div>
      <small>精确供应链接、具体供应SKU、货价、国内运费、到手总价、重量和尺寸统一在新版A确认卡中完成；主人确认后系统才自动进入B。</small>
    </section>
  );
}

function PurchaseCeiling({ ceiling }) {
  if (["verified", "estimated"].includes(ceiling?.status)) {
    const maximum = finiteDisplayNumber(ceiling.maximumAllInPurchaseRmb);
    const estimated = ceiling.status === "estimated";
    const referencePrice = finiteDisplayNumber(ceiling.sellerRevenueRmb);
    const referencePriceRub = finiteDisplayNumber(ceiling.marketReferenceRub);
    const exchangeRate = finiteDisplayNumber(ceiling.exchangeRateRubPerCny);
    const commission = finiteDisplayNumber(ceiling.commissionRate);
    const freight = finiteDisplayNumber(ceiling.internationalLogisticsRmb);
    const marketPriceLabel = ceiling.marketAvailability === "sold_out"
      ? "精确商品已售罄，上次可见价"
      : "Ozon保守参考价";
    const promotionPricing = Array.isArray(ceiling.promotionPricing)
      ? ceiling.promotionPricing
      : [];
    return (
      <aside className={`purchase-ceiling ${estimated ? "estimated" : "verified"}`} aria-label="含国内邮费采购价区间">
        <span>{estimated ? "含国内邮费建议采购区间" : "含国内邮费采购区间"}</span>
        <strong>{maximum === null ? "未取得" : maximum >= 0 ? `¥0–¥${maximum.toFixed(2)}` : "没有可行采购价"}</strong>
        <small>
          {Number.isFinite(referencePriceRub) && Number.isFinite(referencePrice)
            ? `${marketPriceLabel} ${referencePriceRub.toFixed(0)}₽≈¥${referencePrice.toFixed(2)} · `
            : Number.isFinite(referencePrice) ? `Ozon参考售价 ¥${referencePrice.toFixed(2)} · ` : ""}
          {Number.isFinite(exchangeRate) ? `央行汇率 1¥=${exchangeRate.toFixed(4)}₽ · ` : ""}
          {`佣金 ${formatPercent(commission)}${estimated ? "(方向参考)" : ""} · `}
          {Number.isFinite(freight) ? `${ceiling.route || "GUOO"}运费约 ¥${freight.toFixed(2)}。` : ""}
          {estimated ? ceiling.caveat || "这是找货上限；找到1688精确SKU后按最终包装重算。" : "已按最终规格验证。"}
        </small>
        {promotionPricing.length ? (
          <PromotionPricingTable scenarios={promotionPricing} />
        ) : (
          <em className="legacy-profit-note">历史利润模型未按当前促销口径重算；旧二次扣费结论不再沿用。</em>
        )}
      </aside>
    );
  }
  const missing = (ceiling?.missing || []).slice(0, 4);
  return (
    <aside className="purchase-ceiling unverified" aria-label="采购上限未验证">
      <span>含国内邮费采购区间</span>
      <strong>Codex反算中</strong>
      <small>{missing.length ? `Codex当前缺口：${missing.join("、")}` : "你无需补资料，完成取证后会自动更新。"}</small>
    </aside>
  );
}

function PromotionPricingTable({ scenarios }) {
  if (!Array.isArray(scenarios) || !scenarios.length) return null;
  return (
    <div className="advertising-scenarios">
      {scenarios.map((scenario) => (
        <div key={scenario.key} className={`advertising-scenario scenario-${scenario.key}`}>
          <span>{scenario.label || scenario.key}</span>
          <b>建议标价 {formatMoney(scenario.suggestedListPriceRmb)}</b>
          <small>目标折后成交价 {formatMoney(scenario.targetTransactionPriceRmb)}</small>
        </div>
      ))}
    </div>
  );
}

function ProcessingPanel({ candidate, onRecoveryAction }) {
  const review = candidate.codexReview;
  const profit = review?.profitCalculation;
  const status = candidate.processingStatus || { key: "idle", label: "空闲" };
  const activeDispatch = candidate.activeDispatch;
  const latestDispatch = candidate.latestDispatch;
  const dispatch = activeDispatch;
  const recoverableTerminal = !activeDispatch &&
    ["failed", "blocked", "needs_decision", "responded_unverified"].includes(latestDispatch?.status) &&
    (latestDispatch?.status !== "blocked" || candidate.processing?.manualHold === true);
  const returnPathFailed = latestDispatch?.status === "responded_unverified" ||
    latestDispatch?.failureLayer === "missing_business_readback";
  const businessBlocker = candidate.selectionStage?.nextAction || candidate.profitReviewGate?.blockers?.[0] || "";
  const recoveryDecision = candidate.processing?.recoveryDecision || null;
  const recoveryActions = Array.isArray(recoveryDecision?.actions) ? recoveryDecision.actions : [];
  const { saving: savingRecovery, error: recoveryError, run: submitRecovery } = useSubmit();
  const running = status.actualRunning === true && status.key === "running";
  const attempts = Number(candidate.processing?.attempts || 0);
  const error = ["blocked", "stalled", "state_anomaly"].includes(status.key)
    ? String(status.reason || candidate.processing?.lastError || "")
    : "";
  let currentStep = status.currentStep || "当前没有实际任务在运行";
  if (recoverableTerminal) {
    currentStep = latestDispatch.status === "responded_unverified"
      ? "任务确实已经运行并回复；卡在结果回传，今日选品评审没有收到可验收的结构化结果"
      : `最近一次派发已停止：${latestDispatch.error || latestDispatch.agentReply || "等待明确恢复方式"}`;
  } else if (dispatch?.status === "running") currentStep = dispatch.currentStep || currentStep;
  else if (["received", "permission_required"].includes(dispatch?.status)) currentStep = "负责人任务已接收，等待登记真实执行步骤";
  else if (["queued", "waiting_assignee", "delivering"].includes(dispatch?.status)) currentStep = "已派发一次，等待负责人空闲并领取";
  if (!recoverableTerminal) {
    if (status.key === "blocked") currentStep = "本次处理已停止；系统不会自动重试";
    else if (status.key === "queued" && !dispatch) currentStep = "候选已进入A/B处理，但尚未取得真实派发记录";
    else if (status.key === "idle" || status.key === "state_anomaly") currentStep = "当前没有实际任务在运行";
  }
  const statusTitle = recoverableTerminal
    ? latestDispatch.status === "responded_unverified"
      ? "任务已回复 · 结果未验证"
      : "派发已停止 · 等待明确恢复"
    : dispatch?.status === "running"
    ? "运行中 · 有实际任务"
    : ["received", "permission_required"].includes(dispatch?.status)
      ? "负责人已接收"
      : ["queued", "waiting_assignee", "delivering"].includes(dispatch?.status)
        ? "已派发 · 等待负责人领取"
    : running
    ? "运行中 · 有实际任务"
    : status.key === "queued"
      ? "已确认 · 尚未派发"
      : status.key === "blocked"
          ? "处理失败 · 已停止重试"
          : status.key === "state_anomaly"
            ? "状态异常 · 当前无人运行"
            : status.key === "stalled"
              ? "运行超时 · 无法确认仍在运行"
              : status.key === "historical_unconfirmed"
                ? "历史处理记录 · 当前运行未确认"
              : "无人运行 · 等待明确指令";
  const canRecover = candidate.workflowStatus === "codex_processing" && recoveryActions.length > 0;

  async function confirmRecovery(actionId) {
    return submitRecovery(() => onRecoveryAction(actionId));
  }

  return (
    <>
      <section className="workflow-card processing-card">
        {recoveryError && <p role="alert">{recoveryError}</p>}
        <span className={`processing-mark ${running ? "running" : ""}`} aria-hidden="true" />
        <div>
          <h3>{statusTitle}</h3>
          <p>{currentStep}</p>
          {status.dispatchRequestedAt ? <small className="processing-attempts">用户操作触发：{new Date(status.dispatchRequestedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {dispatch ? <small className="processing-attempts">一次性派发：{dispatch.id} · 负责人：{dispatch.assigneeTitle || dispatch.assigneeRole}</small> : null}
          {dispatch?.runId ? <small className="processing-attempts">真实运行编号：{dispatch.runId}</small> : null}
          {dispatch?.deliveryDetail ? <small className="processing-attempts">派发状态：{dispatch.deliveryDetail}</small> : null}
          {dispatch?.error ? <small className="processing-error">派发失败层：{dispatch.failureLayer || "未知"} · {dispatch.error}</small> : null}
          {returnPathFailed ? <small className="processing-error">系统卡点：执行任务无法把结构化结果交回今日选品评审；这不等于商品审核失败。</small> : null}
          {businessBlocker ? <small className="processing-attempts">商品当前业务卡点：{businessBlocker}</small> : null}
          {status.lastAttemptAt ? <small className="processing-attempts">最近尝试：{new Date(status.lastAttemptAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {status.lastProgressAt ? <small className="processing-attempts">最近实质进展：{new Date(status.lastProgressAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {attempts ? <small className="processing-attempts">累计历史尝试 {attempts} 次；新规则下同轮同层同目标只允许一次。</small> : null}
          {error ? <small className="processing-error">卡点：{error}</small> : null}
          {!canRecover && status.userAction ? <small className="processing-error">下一步：{status.userAction}</small> : null}
          {canRecover ? (
            <div className="recovery-confirmation">
              <b>{recoveryDecision.summary || "请选择当前SKU的处理方式"}</b>
              <div className="recovery-actions">
                {recoveryActions.map((action) => (
                  <button
                    type="button"
                    className={`button ${action.id === "keep_stopped" ? "secondary" : "primary"}`}
                    disabled={Boolean(savingRecovery)}
                    onClick={() => confirmRecovery(action.id)}
                    key={action.id}
                  >
                    {savingRecovery === action.id ? "正在处理…" : action.label}
                  </button>
                ))}
              </div>
              <small>无需手写建议。系统错误会自动纠正；这里只处理真实技术失败或必须由你决定的事项。</small>
            </div>
          ) : null}
        </div>
      </section>
      <section className="result-preview" aria-label="审核结果预览">
        <div><span>利润</span><strong>{profit?.status === "verified" ? `${formatMoney(profit.unitProfitRmb)} / ${formatPercent(profit.marginRate)}` : "未验证"}</strong></div>
        <div><span>市场证据</span><strong>{review?.marketEvidence?.comparableCount || 0}条</strong></div>
        <div><span>你要做什么</span><strong>{canRecover ? "选择一个明确处理方式" : activeDispatch ? "无需操作，等待负责人处理" : "当前状态没有要求你操作"}</strong></div>
      </section>
    </>
  );
}

function MissingField({ field, form, update }) {
  if (field === "dimensionsCm") {
    return (
      <fieldset className="dimensions span-2">
        <legend>包装长宽高（cm）</legend>
        {["length", "width", "height"].map((key, index) => (
          <input key={key} aria-label={["长", "宽", "高"][index]} placeholder={["长", "宽", "高"][index]} type="text" inputMode="decimal" value={form[key]} onChange={(event) => update(key, event.target.value)} />
        ))}
      </fieldset>
    );
  }
  if (field === "powered") {
    return <label>是否带电<select value={form.powered} onChange={(event) => update("powered", event.target.value)}><option value="unknown">不确定</option><option value="false">否，完全非电</option><option value="true">是，交给Codex核验平台和线路</option></select></label>;
  }
  const definitions = {
    productUrl: ["商品链接", "url", ""],
    sourceUrl: ["1688/拼多多货源链接", "url", ""],
    purchasePriceRmb: ["采购到手总价（含国内运费，RMB）", "decimal"],
    packedWeightKg: ["真实打包重量（kg）", "decimal"],
    expectedPriceRub: ["预期俄区售价（RUB）", "numeric"]
  };
  const definition = definitions[field];
  if (field === "notes") {
    return <label className="span-2">补充说明<textarea rows="3" value={form.notes} onChange={(event) => update("notes", event.target.value)} placeholder="例如：玻璃厚度、防碎包装方式" /></label>;
  }
  if (!definition) return null;
  return <label>{definition[0]}<input type="text" inputMode={definition[1]} value={form[field]} onChange={(event) => update(field, event.target.value)} /></label>;
}

/**
 * 「这件的佣金还是估算的」那一块。
 *
 * 它摆在所有阶段面板的最前面，不属于任何一个阶段——主人从条件测算走到上架之间会换好几屏、隔好几天，只在
 * 出事那一屏说一次他会忘，忘了最坏的结果是拿一个估算费率去上架。
 *
 * 整块由服务端构建（`estimatedCommissionNoticeStepV1`），页面一个字都不自己写：上架那道闸门和这几句话读的
 * 是同一份记录的同一个字段，所以不会出现「页面说没事、服务端拦下来」这种事。佣金换成精确的那一刻服务端把
 * present 置为 false，这一块自己消失。
 *
 * 不是警告。利润门槛本来就过了，市场价也容得下——所以这里用 role="status" 而不是 alert，样式也跟着选品页
 * 那几块说明走，不用红字。
 */
export function EstimatedCommissionNotice({ step }) {
  if (step?.present !== true) return null;
  const sentences = Array.isArray(step.sentences) ? step.sentences : [];
  if (sentences.length === 0) return null;
  return (
    <div className="source-capture-summary" role="status" aria-label="佣金还是估算的">
      <b>这件商品的佣金还是估算的，上架之前要先复算一次</b>
      {sentences.map(sentence => <span key={sentence}>{sentence}</span>)}
    </div>
  );
}

function NeedsDataPanel({ candidate, onUpdate, identity, onRecalculateBWithExactCommission }) {
  const [form, setForm, guard] = useCandidateForm(candidate, formFromCandidate(candidate));
  const { saving, error, run } = useSubmit();
  const fields = (candidate.neededFieldKeys || []).filter(
    (field) => !["domesticShippingRmb", "packagingCostRmb", "complianceStatus", "authorizationStatus"].includes(field) &&
      (!candidateProductionFactsFrozen(candidate) || field === "notes")
  );

  if (candidate.lifecycleV11?.status === "b_conditional_awaiting_exact_commission") {
    const sku = candidate.lifecycleV11.skuPackage;
    const profit = sku?.profitModels?.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
    const conditional = profit?.calculationType === "conditional" && profit.result === "manual_review";
    const view = candidate.bExactCommissionRuntimeView;
    const ownerAuthenticated = identity?.authenticated === true && identity.roles.includes("owner");
    const canRecalculate = conditional && view?.canRecalculate === true && ownerAuthenticated &&
      !saving && !guard.conflict && Boolean(onRecalculateBWithExactCommission);
    return (
      <section className="workflow-card needs-card" aria-label="B条件测算">
        {/* 这条路能用两种证据收尾（店里实收 / 官方费率表），所以名字不能再叫「精确费用」——
            那是在替软件许一个它不一定做得到的承诺。标题、按钮和下面那一行说的是同一件事。 */}
        <h3>{view?.canRecalculate ? "已经有更好的费用证据，可以重算利润" : "条件测算已保存，等更好的费用证据"}</h3>
        <p>供货方案已确认。当前保存的仍是条件测算，未通过正式B，也未进入C1。</p>
        {conditional ? <p>估算佣金率 {formatPercent(profit.commissionRate, 2)} · 条件单件利润 {formatMoney(profit.unitProfitRmb)} · 条件利润率 {formatPercent(profit.profitMargin, 2)}</p>
          : <p>当前条件测算记录待核对，暂不展示利润数字。</p>}
        <p>无需重新填写已确认的供货价格和包装。{view?.message || "还没有比估算更好的费用证据可用，系统不会自动重试。"}</p>
        {view?.canRecalculate ? <>
          {/* 这一次会用哪一种证据，点之前就摆在按钮上面，不是点完才说。 */}
          {view.commissionEvidenceLabel
            ? <p>这一次会用：{view.commissionEvidenceLabel}
              {view.commissionRate === null ? "" : ` ${formatPercent(view.commissionRate, 2)}`}。
              {view.commissionEvidenceMode === "official_reference"
                ? "这不是你这个店被扣过的钱，是公开费率表上写着的数；上架之前仍然要读到店里的实收费率。" : ""}</p>
            : null}
          <FormRevisionNotice guard={guard} disabled={saving} />
          {!ownerAuthenticated ? <p>请先登录主人身份后重算。</p> : null}
          <button type="button" className="button primary" disabled={!canRecalculate}
            onClick={() => run(async () => {
              guard.assertCurrent();
              await onRecalculateBWithExactCommission(buildBExactCommissionInput({ candidate, sourceRevision: guard.sourceRevision }));
            })}>{saving ? "正在重算正式利润…" : "用更好的费用证据重算"}</button>
        </> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    );
  }


  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    return run(async () => {
    guard.assertCurrent();
    const payload = { dataRevision: guard.sourceRevision };
    for (const field of fields) {
      if (["purchasePriceRmb", "packagingCostRmb", "packedWeightKg", "expectedPriceRub"].includes(field)) {
        payload[field] = optionalNumber(form[field]);
      } else if (field === "dimensionsCm") {
        payload.dimensionsCm = {
          length: optionalNumber(form.length),
          width: optionalNumber(form.width),
          height: optionalNumber(form.height)
        };
      } else if (field === "powered") {
        payload.powered = form.powered === "false" ? false : form.powered === "true" ? true : "unknown";
      } else {
        payload[field] = form[field];
      }
    }
    await onUpdate(payload);
    });
  }

  return (
    <section className="workflow-card needs-card">
      <div>
        <h3>只需你完成这一项</h3>
        <ul>{candidate.needsFromUser.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
      <FormRevisionNotice guard={guard} disabled={saving} />
      {candidateProductionFactsFrozen(candidate) ? <p>最终方案中的采购、规格和价格事实已冻结，普通资料保存仅允许补充说明。</p> : null}
      {error && <p role="alert">{error}</p>}
      <form className="missing-form" onSubmit={submit}>
        {fields.map((field) => <MissingField key={field} field={field} form={form} update={update} />)}
        <button type="submit" className="button primary span-2" disabled={saving || guard.conflict || !fields.length}>{saving ? "保存中…" : "保存资料"}</button>
      </form>
    </section>
  );
}

function numeric(value) {
  return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

function WbNotSuitableDetails({ candidate, rules }) {
  const wb = candidate.wbAssessment || {};
  const market = wb.marketEvidence || {};
  const profit = wb.profitCalculation || {};
  const rule = rules?.wbCrossListing || {};
  const sellerRevenue = numeric(profit.targetPriceRmb);
  const purchase = numeric(candidate.purchasePriceRmb);
  const packaging = numeric(candidate.packagingCostRmb);
  const freight = numeric(wb.logistics?.freightRmb);
  const commissionRate = numeric(wb.commission?.rate);
  const promotionPricing = Array.isArray(profit.promotionPricing) ? profit.promotionPricing : [];
  const advertisingRate = numeric(profit.advertisingReserveRate ?? rule.advertisingReserveRate);
  const fixedComplete = [sellerRevenue, purchase, packaging, freight, commissionRate, advertisingRate, rule.labelCostRmb, rule.returnOpsReserveRate, rule.damageLossReserveRate].every(Number.isFinite);
  const reserveRate =
    advertisingRate +
    numeric(rule.returnOpsReserveRate) +
    numeric(rule.damageLossReserveRate);
  const totalVariableRate = commissionRate + reserveRate;
  const variableCost = fixedComplete ? sellerRevenue * totalVariableRate : null;
  const calculatedProfit = fixedComplete
    ? sellerRevenue - purchase - packaging - freight - numeric(rule.labelCostRmb) - variableCost
    : null;
  const calculatedMargin = fixedComplete && sellerRevenue > 0 ? calculatedProfit / sellerRevenue : null;
  const blockers = candidate.wbAssessmentGate?.blockers || [];

  return (
    <section className="wb-not-suitable-details">
      <h4>WB不适合上架 · 详细原因</h4>
      <p>{wb.reason || "当前WB市场和完整成本未通过门槛。"}</p>
      {market.exactMatchStatus === "found" ? (
        <p>
          已核到 {market.exactMatchCount || market.competitors?.length || 0} 个WB同款，
          买家可见中位价 <b>{market.medianPriceRub} RUB</b>；以下利润按该中位价计算，不使用Ozon售价。
        </p>
      ) : null}
      {blockers.length ? <ul>{blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      <dl className="wb-cost-grid">
        <div><dt>WB卖家收入</dt><dd>{money(sellerRevenue)}</dd></div>
        <div><dt>采购到手总价（含国内运费）</dt><dd>{money(purchase)}</dd></div>
        <div><dt>包材</dt><dd>{money(packaging)}</dd></div>
        <div><dt>CEL运费</dt><dd>{money(freight)}</dd></div>
        <div><dt>WB佣金</dt><dd>{Number.isFinite(commissionRate) ? `${(commissionRate * 100).toFixed(1)}%` : "未取得"}</dd></div>
      </dl>
      <div className="wb-formula">
        <strong>计算公式</strong>
        <p>单件利润 = WB折后卖家收入 − 采购到手总价（含国内运费）− 包材 − CEL运费 − 贴标费 − WB折后卖家收入 ×（佣金率＋广告、退货/运营、破损/丢失的当前配置费率）。促销折扣只反推标价，不再扣一次。</p>
        {fixedComplete ? (
          <p>
            = {money(sellerRevenue)} − {money(purchase)} − {money(packaging)} − {money(freight)} − {money(rule.labelCostRmb)} − {money(sellerRevenue)} × {(totalVariableRate * 100).toFixed(1)}% = <b>{money(calculatedProfit)}</b>
          </p>
        ) : <p>当前存在未取得项，不能生成数值代入结果。</p>}
        <p>利润率 = 单件利润 ÷ WB卖家收入 × 100%{calculatedMargin !== null ? ` = ${(calculatedMargin * 100).toFixed(2)}%` : ""}</p>
        <p className="wb-threshold">{Number.isFinite(rule.minimumUnitProfitRmb) && Number.isFinite(rule.targetMarginRate) ? `当前配置门槛：单件利润≥${rule.minimumUnitProfitRmb} RMB，利润率≥${rule.targetMarginRate * 100}%；组合方式：${rule.thresholdPolicy || "未取得"}` : "当前利润门槛配置未取得，不显示默认通过条件。"}</p>
      </div>
      {promotionPricing.length ? <PromotionPricingTable scenarios={promotionPricing} /> : <p className="legacy-profit-note">历史利润模型未按当前促销口径重算。</p>}
      {profit.stressScenario ? <p className="wb-stress">压力/补充情景：{profit.stressScenario}</p> : null}
    </section>
  );
}

function WbMarketSummary({ candidate, presentation }) {
  const wb = candidate.wbAssessment || {};
  const market = wb.marketEvidence || {};
  const profit = wb.profitCalculation || {};
  if (presentation.kind === "not-in-scope") {
    return (
      <section className="wb-market-summary wb-not-in-scope">
        <strong>{presentation.heading}</strong>
        <p>{presentation.detail}</p>
        <small>历史WB记录仍保留在完整审核依据中，但不代表本轮正在计算或等待处理。</small>
      </section>
    );
  }
  if (!candidate.wbAssessmentGate?.passed) {
    return (
      <section className="wb-market-summary wb-recheck">
        <strong>{presentation.heading}</strong>
        {presentation.riskAccepted ? (
          <div className="wb-risk-handoff">
            <b>{presentation.paused ? "当前暂停，不进行任何WB上架操作" : "不等于WB已验证通过"}</b>
            <span>{presentation.paused ? "恢复后执行者：软件；异常才进入上架维护" : "下一阶段执行者：软件"}</span>
            <span>{presentation.paused ? "恢复条件：重新提供并确认最终图片附件清单。" : "正式写入前仍须确认：店铺、价格、库存、图片、发布范围。"}</span>
          </div>
        ) : null}
        <p>{presentation.detail}</p>
        {presentation.conditional ? (
          <p>
            条件测算（非最终）：建议价 <b>{presentation.conditional.recommendedPriceRub} RUB</b>，
            单件利润约 <b>{formatMoney(presentation.conditional.unitProfitRmb)}</b>，
            利润率约 <b>{formatPercent(presentation.conditional.marginRate, 2)}</b>。
          </p>
        ) : null}
        {presentation.nextStep ? <small>下一步：{presentation.nextStep}</small> : null}
      </section>
    );
  }
  if (market.exactMatchStatus === "not_found") {
    return (
      <section className="wb-market-summary">
        <strong>WB未发现完全同款，默认可上架</strong>
        <p>建议售价 {profit.recommendedPriceRub} RUB；该售价按WB佣金、CEL运费和完整成本反算。</p>
      </section>
    );
  }
  return (
    <section className="wb-market-summary">
      <strong>WB已发现完全同款</strong>
      <p>同款中位价 {market.medianPriceRub} RUB；利润按该中位价判断。</p>
    </section>
  );
}

function captureExecutionConfirmed(candidate, capture, proof) {
  return proof?.currentExecutionConfirmed === true &&
    proof.candidateId === candidate.id && proof.candidateRevision === candidate.dataRevision &&
    typeof proof.captureId === "string" && proof.captureId.trim().length > 0 && proof.captureId === capture.captureId;
}


/**
 * 对标样本。
 *
 * 最终定价那一步要「多个有效样本比较」，只有 1 条不能形成比较；关键词本地素材同样要 3–5 个已审查竞品。
 * 两处读的都是 candidate.salesSnapshotsV11，而在 2026-09-17 之前**没有任何入口能往里加第二个商品**——
 * A 阶段那个采集面板采的是这件商品自己那一页，而且进了 C 阶段就不再显示。
 *
 * 这里补上那个入口：主人自己贴地址，软件不替他从类目里挑「像的」商品当可比样本。
 * 采回来的快照带 comparable 标记，反推「这件商品自己的页面」时会跳过它们。
 */
function ComparableCapturePanel({ candidate, captureControl, onStart }) {
  const [url, setUrl] = useState("");
  const { saving, error, run } = useSubmit();
  const snapshots = Array.isArray(candidate.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [];
  const comparables = snapshots.filter(snapshot => snapshot?.comparable === true);
  const own = snapshots.filter(snapshot => snapshot?.comparable !== true);
  const busy = captureControl?.status === "busy";
  const valid = /^https:\/\/(?:www\.)?ozon\.ru\/product\/[^\s]+$/i.test(url.trim());
  if (!candidate.lifecycleV11?.skuPackage) return null;
  return (
    <section className="workflow-card">
      <h3>对标样本</h3>
      <p>最终定价要多个有效样本比较，只有 1 条不能形成比较。这里由你贴 Ozon 商品页地址，
        软件<strong>不替你从类目里挑「像的」商品</strong>当可比样本。每次读一个页面，只读不写。</p>
      <p>当前：这件商品自己的快照 {own.length} 条 · <strong>对标 {comparables.length} 条</strong>
        {comparables.length < 2 ? "（最终定价至少要 2 条有效样本，3 条起不再提示不足）" : ""}</p>
      {comparables.length ? (
        <ul className="c2-final-asset-list">
          {comparables.map(snapshot => (
            <li key={snapshot.snapshotId}>
              <div className="c2-final-asset-copy">
                <b>{snapshot.title}</b>
                <span>{snapshot.currentPrice} {snapshot.currency} · {snapshot.productUrl}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <label>Ozon 商品页地址
        {/* 采集进行中只禁按钮，不禁输入：贴一个地址不伤害任何东西，而等插件那几十秒里
            把下一个地址先贴好是很自然的事。2026-09-17 主人第一次用就卡在这儿。 */}
        <input type="url" value={url} placeholder="https://www.ozon.ru/product/..." disabled={saving}
          onChange={event => setUrl(event.target.value)} />
      </label>
      {url.trim() && !valid ? <p role="alert">这不是一个 Ozon 商品页地址，软件不改写它去凑一个。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" className="button secondary" disabled={!valid || saving || busy}
        onClick={() => run(async () => { await onStart(url.trim()); setUrl(""); })}>
        {saving ? "正在连接Chrome…" : busy ? "其他商品正在采集" : "用Chrome读这个对标页面（一次）"}
      </button>
    </section>
  );
}

function ListingPreparationPanel({ candidate, captureControl, onStartOzonSalesCapture, onRecoveryAction, onCapture, onSelectSku, onUploadLifecycleFinalAsset, onSaveC2UploadDraft, onConfirmLifecycleFinalAssets, onSaveProductionOwnerDecision, onSaveFinalPricingReview, onSaveC1RightsReview, onAuthorizeC1PaidDraft, onContinueSavedC1Draft, onReadOriginalC1DraftResult, onRetryC1KeywordHandoff, onContinueC1Preparation, onBackfillC1SupplyAttributes, onSaveC1OzonAttributeMapping, onLoadC1OzonAttributes, onReadC1ColorDictionary, onRefreshC1CategorySchema, onProposeC1OzonAttributes, productionIdentity }) {
  const handoff = candidate.listingHandoff || {};
  const preparation = candidate.listingPreparation || {};
  const sourceCapture = candidate.sourceCapture || {};
  const currentCapture = captureExecutionConfirmed(candidate, sourceCapture, candidate.currentSourceCapture);
  const dispatch = candidate.activeDispatch;
  const currentExecution = candidate.executionRuntimeView?.currentExecutionConfirmed === true;
  const waitingPermission = dispatch?.status === "permission_required";
  const historicalActivity = !currentExecution && !waitingPermission && ["queued", "claimed", "running", "permission_required"].includes(handoff.state);
  const waiting = handoff.state === "awaiting_user_start";
  const needsOwnerDecision = handoff.state === "needs_decision" || preparation.status === "needs_decision";
  const stopped = ["blocked", "needs_decision", "paused_user_stopped"].includes(handoff.state) ||
    ["blocked", "needs_decision"].includes(preparation.status);
  const stoppedReason = sourceCapture.reason || handoff.blockReason || preparation.reason || "本次核验已停止；系统不会自动重试。";
  const decisionItems = Array.isArray(handoff.decisionItems) && handoff.decisionItems.length
    ? handoff.decisionItems
    : Array.isArray(preparation.decisionItems) ? preparation.decisionItems : [];
  const capturing = ["waiting_extension", "capturing"].includes(sourceCapture.status) || handoff.state === "capturing_source";
  const choosingSku = sourceCapture.status === "needs_sku_selection" && sourceCapture.mode === "listed_evidence_recovery";
  const legacySkuSelection = sourceCapture.status === "needs_sku_selection" && sourceCapture.mode !== "listed_evidence_recovery";
  const suggestedSkuKey = Array.isArray(sourceCapture.suggestedSkuIds) ? sourceCapture.suggestedSkuIds.join("|") : "";
  const is1688 = /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#]|$)/i.test(candidate.sourceUrl || "");
  const dimensions = candidate.dimensionsCm || {};
  const inheritedDimensions = [dimensions.length, dimensions.width, dimensions.height].every((value) => Number(value) > 0)
    ? `${dimensions.length} × ${dimensions.width} × ${dimensions.height} cm`
    : "未填写";
  const requiredSkills = (dispatch?.requiredSkills || []).map((skill) => skill.name).filter(Boolean);
  const attachedSkills = Array.isArray(dispatch?.attachedSkills) ? dispatch.attachedSkills : [];
  const lifecycle = candidate.lifecycleV11 || null;
  const lifecycleSku = lifecycle?.skuPackage || null;
  const c1Plan = lifecycleSku?.c1ProductPlan || null;
  const c2Assets = lifecycleSku?.c2FinalAssets || null;
  const activeProfit = lifecycleSku?.profitModels?.find((model) => model.profitModelVersion === lifecycleSku.activeProfitModelVersion) || null;
  const finalCard = lifecycleSku?.productionConfirmationCard || null;
  const supplierFactSummary = (c1Plan?.productAttributes?.supplierAttributes || [])
    .filter((item) => item?.fact?.verificationStatus === "confirmed")
    .map((item) => `${item.fieldKey}：${String(item.fact.value)}`)
    .join(" · ");
  const materialFact = c1Plan?.productAttributes?.material;
  const batteryFact = c1Plan?.batteryAssessment?.assessment;
  const [selectedSkuIds, setSelectedSkuIds, guard] = useCandidateForm(candidate, suggestedSkuKey ? suggestedSkuKey.split("|") : []);
  const { saving, error, run: submitOnce } = useSubmit();

  function toggleSku(sourceSkuId) {
    setSelectedSkuIds((current) => current.includes(sourceSkuId)
      ? current.filter((id) => id !== sourceSkuId)
      : [...current, sourceSkuId]);
  }

  async function run(action) {
    return submitOnce(async () => {
      guard.assertCurrent();
      if (action === "capture") throw new Error("旧C阶段采集入口已退役，不能从C1/C2重访供应商。");
      else if (action === "select-sku") await onSelectSku(selectedSkuIds, { dataRevision: guard.sourceRevision });
      else await onRecoveryAction(action);
    });
  }

  return (
    <section className="workflow-card listing-preparation-card">
      <FormRevisionNotice guard={guard} disabled={saving} />
      {error && <p role="alert">{error}</p>}
      <div>
        <h3>{capturing ? currentCapture ? "正在读取1688商品" : "采集记录 · 当前执行未确认" : legacySkuSelection ? "历史1688 SKU选择记录" : choosingSku ? "请选择一个或多个1688 SKU" : waiting ? "历史待上架准备记录" : lifecycleSku?.businessPhase === "C2" && c2Assets?.status === "awaiting_final_uploads" ? "C1商品方案完成 · 等待C2最终素材" : needsOwnerDecision ? "C阶段待你确认" : stopped ? "C阶段已停止" : waitingPermission ? "C阶段技术维护 · 等待权限决定" : currentExecution ? dispatch?.status === "running" ? "C阶段技术维护中" : "软件正在执行C阶段" : historicalActivity ? "历史C阶段记录 · 当前运行未确认" : "C阶段等待软件执行"}</h3>
        <p>
          {capturing
            ? currentCapture ? "本次服务已确认后台领取当前商品采集，等待精确SKU证据回传。" : "这里只保留采集等待记录，尚无本次后台领取与执行证明；打开页面不会恢复旧采集。"
            : legacySkuSelection
              ? "这是旧流程留下的SKU选择状态，只读保留；不能再由此创建旧C阶段派发。"
            : choosingSku
              ? "商品页面中的全部SKU已经列出。勾选本次要核验的一个或多个规格后，由软件保存并继续当前商品；不会派发Codex任务。"
              : waiting
            ? "这是旧流程遗留状态。本阶段不改变商品状态，也不再提供人工启动C的旧按钮。"
            : stopped
              ? stoppedReason === "paid_job_admission_required" ? "尚未取得当前商品的单次付费授权与服务连接" : stoppedReason
            : waitingPermission
              ? "本次维护任务正在等待权限决定；尚未继续执行。"
            : historicalActivity
              ? "旧领取、排队或运行状态仅供追溯；当前服务未确认这次执行，不会自动恢复或重试。"
              : handoff.currentStep || "等待软件状态机继续当前SKU。"}
        </p>
        {needsOwnerDecision ? (
          <div className="recovery-confirmation owner-decision-card">
            <b>现在只需要确认这些真实缺口</b>
            {decisionItems.length ? (
              <ol>
                {decisionItems.map((item) => <li key={item}>{item}</li>)}
              </ol>
            ) : null}
            <p>{handoff.userAction || "确认前不会重新采集、重新核算或继续上架。"}</p>
            <small>这不是1688采集失败，也不需要再次点击采集；确认结果会继续留在当前SKU的C阶段。</small>
          </div>
        ) : null}
        {lifecycleSku ? (
          <div className="capability-receipt lifecycle-c1-receipt">
            <b>新版生命周期 · C1商品方案</b>
            <span>精确SKU：{lifecycleSku.supplierSkuId} · 当前阶段：{lifecycleSku.businessPhase} · 技术状态：{lifecycleSku.technicalStatus}</span>
            <span>商品事实：{supplierFactSummary || "供应属性未完整确认"}{materialFact?.verificationStatus === "confirmed" ? ` · 材质：${String(materialFact.value)}` : " · 材质：unknown"}{batteryFact?.verificationStatus === "confirmed" ? ` · 电池：${String(batteryFact.value)}` : " · 电池：unknown"}</span>
            {activeProfit ? <span>市场目标成交价：{finiteDisplayNumber(activeProfit.recommendedSalePriceRub) === null ? "未取得" : `${activeProfit.recommendedSalePriceRub} RUB`} · 单件利润 {formatMoney(activeProfit.unitProfitRmb)} · 利润率 {formatPercent(activeProfit.profitMargin, 2)}</span> : null}
            {activeProfit?.priceFloors ? <span>成本反推合格底线：¥{activeProfit.priceFloors.qualifyingFloorCny} · 盈亏线 ¥{activeProfit.priceFloors.breakEvenPriceCny} · 市场余量 ¥{activeProfit.marketFit?.headroomCny}</span> : null}
            {c1Plan?.seoTitleDraft?.text ? <span>俄语标题草稿：{c1Plan.seoTitleDraft.text}</span> : null}
            <span>关键词证据：仅展示当前冻结草稿；来源与用量请以正式作业回执为准，缺失不记为0。</span>
            <span>最终素材：{c2Assets?.assets?.finalUploads?.length || 0}个 · 生产授权：{lifecycleSku.productionAuthorization ? "已生成" : "未生成"} · 平台写入：0</span>
            {finalCard ? <FinalProductPlanCard candidate={candidate} identity={productionIdentity}
              onSaveProductionOwnerDecision={onSaveProductionOwnerDecision} onSaveFinalPricingReview={onSaveFinalPricingReview} /> : null}
          </div>
        ) : null}
        {lifecycleSku?.businessPhase === "C1" && c1Plan ? <C1RightsReviewPanel candidate={candidate} identity={productionIdentity} onSave={onSaveC1RightsReview} /> : null}
        <C1OzonAttributePanel candidate={candidate} identity={productionIdentity} onBackfill={onBackfillC1SupplyAttributes} onSaveMapping={onSaveC1OzonAttributeMapping} onRefreshSchema={onRefreshC1CategorySchema} onProposeAttributes={onProposeC1OzonAttributes} onLoadMappingFacts={onLoadC1OzonAttributes} onReadColorDictionary={onReadC1ColorDictionary} />
        <ComparableCapturePanel candidate={candidate} captureControl={captureControl} onStart={onStartOzonSalesCapture} />
        <C1PaidDraftPanel candidate={candidate} identity={productionIdentity} onAuthorize={onAuthorizeC1PaidDraft} onContinueSaved={onContinueSavedC1Draft} onReadOriginalResult={onReadOriginalC1DraftResult} onRetryKeywordHandoff={onRetryC1KeywordHandoff} onContinuePreparation={onContinueC1Preparation} />
        {lifecycleSku?.businessPhase === "C2" && !finalCard && !lifecycleSku.productionAuthorization ? <FinalPricingReviewForm candidate={candidate} onSave={onSaveFinalPricingReview} disabled={productionIdentity?.canSaveProductionOwnerDecision !== true} /> : null}
        {lifecycleSku?.businessPhase === "C2" && c2Assets?.status === "awaiting_final_uploads" ? (
          c2Assets.softwareState ? (
            <C2FinalAssetsPanel candidate={candidate} onUpload={onUploadLifecycleFinalAsset} onSave={onSaveC2UploadDraft} onConfirm={onConfirmLifecycleFinalAssets} />
          ) : (
            <div className="recovery-confirmation">
              <b>历史C2记录仅可读取</b>
              <p>当前记录缺少新版软件状态，不能冒充新C2继续上传；需要先做明确迁移。</p>
            </div>
          )
        ) : null}
        <small>正常执行者：C1软件状态机 · 上架任务只负责领域开发与异常维护。C1只继承A阶段确认的供应SKU和B利润结果；不得重新寻找或替换供应SKU。</small>
        <div className="inherited-input-card">
          <b>前期继承资料 · 不需要重新填写</b>
          <div className="inherited-input-grid">
            <span><small>目标店铺</small>{STORE_LABELS[candidate.targetStore] || candidate.targetStore || "未填写"}</span>
            <span><small>采购到手总价</small>{candidate.purchasePriceRmb === null || candidate.purchasePriceRmb === undefined ? "未填写" : `¥${candidate.purchasePriceRmb}（含国内运费）`}</span>
            <span><small>真实打包重量</small>{candidate.packedWeightKg ? `${candidate.packedWeightKg} kg` : "未填写"}</span>
            <span><small>包装尺寸</small>{inheritedDimensions}</span>
            <span className="inherited-source"><small>精确货源链接</small>{safeWebUrl(candidate.sourceUrl) ? <a href={safeWebUrl(candidate.sourceUrl)} target="_blank" rel="noreferrer">打开已保存链接</a> : "未填写"}</span>
            <span><small>数据修订号</small>{candidate.dataRevision}</span>
          </div>
        </div>
        {sourceCapture.offerId ? (
          <div className={`source-capture-summary capture-${sourceCapture.status || "unknown"}`}>
            <b>1688只读证据 · offer {sourceCapture.offerId}</b>
            {sourceCapture.title ? <span>{sourceCapture.title}</span> : null}
            {(sourceCapture.selectedSkus || (sourceCapture.selectedSku ? [sourceCapture.selectedSku] : [])).map((sku) => (
              <span key={sku.sourceSkuId}>
                SKU {sku.sourceSkuId} · {sku.priceCny ? `页面直接价格 ¥${sku.priceCny}` : "页面直接价格未取得"}
                {sku.stock === null || sku.stock === undefined ? " · 库存未取得" : ` · 库存${sku.stock}`}
              </span>
            ))}
            {sourceCapture.observedAt ? <small>取得时间：{new Date(sourceCapture.observedAt).toLocaleString("zh-CN")}</small> : null}
          </div>
        ) : null}
        {dispatch ? (
          <div className="capability-receipt">
            <b>本轮能力包</b>
            <span>派发编号：{dispatch.id}{dispatch.runId ? ` · 运行编号：${dispatch.runId}` : ""}</span>
            <span>1688采集：{dispatch.capabilityPlan?.sourceCapture?.status === "attached" ? `已附加 ${dispatch.capabilityPlan.sourceCapture.captureId}` : is1688 ? "尚未附加" : "当前链接无需插件"}</span>
            <span>必需Skill：{requiredSkills.length ? requiredSkills.join("、") : "无"}</span>
            <span>实际注入：{dispatch.skillsAttachedAt ? attachedSkills.join("、") || "无" : "尚未取得真实运行编号"}</span>
          </div>
        ) : (
          <div className="capability-receipt planned">
            <b>C阶段只读继承已冻结资料</b>
            <span>正常流程由软件处理；没有真实作业回执时不表示正在执行。</span>
          </div>
        )}
        {choosingSku && candidate.supplyConfirmation?.stage === "A" ? (
          <div className="source-sku-selector">
            <div className="source-sku-selector-heading">
              <b>本次要采购/上架的SKU（可多选）</b>
              <span>已选 {selectedSkuIds.length}/{(sourceCapture.skuChoices || []).length}</span>
            </div>
            <details className="source-sku-dropdown" open>
              <summary>展开/收起全部 {(sourceCapture.skuChoices || []).length} 个SKU</summary>
              <div className="source-sku-options">
                {(sourceCapture.skuChoices || []).map((sku) => {
                  const attributes = Object.entries(sku.attributes || {}).map(([key, value]) => `${key}:${value}`).join(" · ");
                  return (
                    <label className={`source-sku-option ${selectedSkuIds.includes(sku.sourceSkuId) ? "selected" : ""}`} key={sku.sourceSkuId}>
                      <input
                        type="checkbox"
                        checked={selectedSkuIds.includes(sku.sourceSkuId)}
                        onChange={() => toggleSku(sku.sourceSkuId)}
                      />
                      <span className="source-sku-option-main">
                        <b>{attributes || sku.propPath || `SKU ${sku.sourceSkuId}`}</b>
                        <small>SKU ID：{sku.sourceSkuId}</small>
                      </span>
                      <span className={sku.priceCny ? "source-sku-price" : "source-sku-price missing"}>
                        {sku.priceCny ? `¥${sku.priceCny}` : "直接价格未取得"}
                      </span>
                      <small>{sku.stock === null || sku.stock === undefined ? "库存未取得" : `库存 ${sku.stock}`}</small>
                    </label>
                  );
                })}
              </div>
            </details>
            <button type="button" className="button primary" disabled={saving || !selectedSkuIds.length} onClick={() => run("select-sku")}>
              {saving ? "正在确认…" : `确认${selectedSkuIds.length ? ` ${selectedSkuIds.length} 个` : ""}供应SKU并进入B`}
            </button>
            <button type="button" className="button secondary" disabled title="C1/C2只读冻结供货数据，不重访供应商">旧C阶段重新采集入口已退役</button>
            <small>所有采到的SKU都会显示；商品价、国内运费、实际采购成本、重量和尺寸未齐全时不得进入B。</small>
          </div>
        ) : null}
        {waiting ? <small>这条awaiting_user_start只作历史状态读取，不再提供人工启动C或旧1688采集按钮。新版流程在A阶段一张卡确认供应SKU，B通过后自动进入C1。</small> : null}
        {legacySkuSelection ? <small>旧1688采集结果仍可查看，但所有选择和继续按钮已停用；新版供应SKU只能在A阶段完整确认卡中一次确认。</small> : null}
        {stopped && !is1688 ? (
          <div className="recovery-confirmation">
            <b>{handoff.recoveryDecision?.summary || "本次C阶段已停止"}</b>
            <div className="recovery-actions">
              {(handoff.recoveryDecision?.actions || []).map((action) => (
                <button
                  type="button"
                  className={`button ${action.id === "keep_stopped" ? "secondary" : "primary"}`}
                  disabled={saving}
                  onClick={() => run(action.id)}
                  key={action.id}
                >
                  {saving ? "正在处理…" : action.label}
                </button>
              ))}
            </div>
            <small>无需手写建议；再次真实失败仍立即停止，也不会触发店铺写入。</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReadyPanel({ candidate, rules, onMarkListed }) {
  const [showListedForm, setShowListedForm] = useState(false);
  const { saving, error, run } = useSubmit();
  const emptyForm = () => ({
    platform: platformOfStore(candidate.targetStore) ?? "",
    productId: "",
    merchantSku: "",
    productUrl: "",
    moderationStatus: "",
    saleStatus: "",
    confirmedAt: ""
  });
  const [form, setForm, guard] = useCandidateForm(candidate, emptyForm());
  const preparation = candidate.listingPreparation || {};
  const profit = candidate.codexReview?.profitCalculation;
  const wb = candidate.wbAssessment || { status: "notSuitable", reason: "尚无完整WB复算依据" };
  const wbView = wbPresentation(candidate);
  const wbCurrent = wbView.current;

  const preparationComplete = preparation.status === "prepared" && Boolean(candidate.cCompletedAt);
  if (!preparationComplete) {
    return (
      <section className="workflow-card listing-preparation-card">
        <div>
          <h3>历史待上架 · 需补做C阶段</h3>
          <p>这条旧记录没有当前精确货源SKU、佣金/物流、带电/IP/合规、Schema和素材的完整C阶段完成证据，不能直接开始上架。</p>
          <small>这是历史兼容记录。本阶段不迁移业务状态，也不恢复旧的人工启动C按钮。</small>
        </div>
      </section>
    );
  }
  return (
    <>
      <section className="workflow-card ready-card">
        <div>
          <h3>C阶段通过 · 可上架</h3>
          {profit?.status === "verified" ? (
            <p>单件利润 {formatMoney(profit.unitProfitRmb)} · 利润率 {formatPercent(profit.marginRate)} · 目标售价 {finiteDisplayNumber(profit.targetPriceRub) === null ? formatMoney(profit.targetPriceRmb) : `${profit.targetPriceRub} RUB`}</p>
          ) : <p>旧利润结论已失效或尚未验证，不显示伪精确数值。</p>}
          <small className="handoff-owner">正常执行者：软件 · 当前尚未获得生产写入授权；上架任务未被正常流程唤醒</small>
        </div>
        <span className={`wb-result wb-${wbView.kind}`} title={wbView.detail || wb.reason || ""}>{wbView.label}</span>
      </section>
      <WbMarketSummary candidate={candidate} presentation={wbView} />
      {wbCurrent && wb.status === "notSuitable" ? <WbNotSuitableDetails candidate={candidate} rules={rules} /> : null}
      <section className="listing-confirmation">
        <div className="automatic-listing-note">
          <strong>旧直接启动D的生产卡已退役</strong>
          <span>请使用独立的最终商品卡授权流程；图片确认不能代替生产授权，这里不会启动D。</span>
        </div>
        <FormRevisionNotice guard={guard} disabled={saving} />
        {error && <p role="alert">{error}</p>}
        <hr />
        <button type="button" className="button secondary" onClick={() => setShowListedForm((value) => !value)}>无法自动回读？手动标记</button>
        <small>仅作兜底：确定上架任务无法取得当前回读时使用。</small>
        {showListedForm ? (
          <form onSubmit={async (event) => {
            event.preventDefault();
            await run(async () => {
              guard.assertCurrent();
              const platform = candidatePlatform(candidate);
              await onMarkListed({
                ...form,
                platform,
                store: candidate.targetStore,
                dataRevision: guard.sourceRevision,
                confirmedAt: form.confirmedAt ? new Date(form.confirmedAt).toISOString() : new Date().toISOString()
              });
            });
          }}>
            <label>平台<input value={form.platform || "目标身份未取得"} readOnly /></label>
            <label>店铺<input value={STORE_LABELS[candidate.targetStore] || candidate.targetStore} readOnly /></label>
            <label>商品ID<input value={form.productId} onChange={(event) => setForm((current) => ({ ...current, productId: event.target.value }))} placeholder="平台商品ID" /></label>
            <label>商家货号<input value={form.merchantSku} onChange={(event) => setForm((current) => ({ ...current, merchantSku: event.target.value }))} placeholder="offer_id / vendorCode" /></label>
            <label className="span-2">商品链接<input type="url" value={form.productUrl} onChange={(event) => setForm((current) => ({ ...current, productUrl: event.target.value }))} placeholder="商品ID和链接至少填一个" /></label>
            <label>审核状态<input value={form.moderationStatus} onChange={(event) => setForm((current) => ({ ...current, moderationStatus: event.target.value }))} placeholder="例如：审核通过" /></label>
            <label>销售状态<input value={form.saleStatus} onChange={(event) => setForm((current) => ({ ...current, saleStatus: event.target.value }))} placeholder="例如：可销售/无库存" /></label>
            <label className="span-2">确认时间<input type="datetime-local" value={form.confirmedAt} onChange={(event) => setForm((current) => ({ ...current, confirmedAt: event.target.value }))} /></label>
            <button type="submit" className="button primary span-2" disabled={saving || guard.conflict || !form.platform || (!form.productId.trim() && !form.productUrl.trim())}>{saving ? "保存中…" : "确认并移入已上架"}</button>
          </form>
        ) : null}
      </section>
    </>
  );
}

function ListedPanel({ candidate, onCapture, onSelectSku }) {
  const record = candidate.listingRecord || {};
  const sourceConflict = candidate.eReadbackRuntimeView?.status === "source_conflict";
  const observation = evaluatePostLaunchObservation({
    listedAt: candidate.listedAt || record.confirmedAt,
    ...(candidate.postLaunchMetrics || {}),
    stableForSale: candidate.postLaunchMetrics?.stableForSale,
  });
  const sourceCapture = candidate.sourceCapture || {};
  const currentCapture = captureExecutionConfirmed(candidate, sourceCapture, candidate.currentSourceCapture);
  const automatic = record.method === "automatic_readback";
  const listedRecoveryAllowed = record.stateOnly === true &&
    candidate.listingPreparation?.status === "queued" &&
    /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#]|$)/i.test(candidate.sourceUrl || "") &&
    sourceCapture.status !== "verified";
  const suggestedSkuKey = Array.isArray(sourceCapture.suggestedSkuIds) ? sourceCapture.suggestedSkuIds.join("|") : "";
  const [selectedSkuIds, setSelectedSkuIds, guard] = useCandidateForm(candidate, suggestedSkuKey ? suggestedSkuKey.split("|") : []);
  const { saving, error, run: submitOnce } = useSubmit();

  function toggleSku(sourceSkuId) {
    setSelectedSkuIds((current) => current.includes(sourceSkuId)
      ? current.filter((id) => id !== sourceSkuId)
      : [...current, sourceSkuId]);
  }

  async function captureOnce() {
    return submitOnce(async () => { guard.assertCurrent(); await onCapture("", "listed_evidence_recovery"); });
  }

  async function saveSelection() {
    return submitOnce(async () => { guard.assertCurrent(); await onSelectSku(selectedSkuIds, { dataRevision: guard.sourceRevision }); });
  }

  return (
    <section className="workflow-card listed-card">
      <FormRevisionNotice guard={guard} disabled={saving} />
      {error && <p role="alert">{error}</p>}
      <div>
        <div className="listed-heading">
          <h3>{sourceConflict ? "历史上架记录 · 来源待核对" : "已上架"}</h3>
          <span>{automatic ? "上架任务自动回读" : "手动兜底记录"}</span>
        </div>
        {sourceConflict ? <p>以下保留历史回读证据；商品来源已变化，不能代表当前验证通过。</p> : null}
        <dl className="listed-record-grid">
          <div><dt>平台 / 店铺</dt><dd>{String(record.platform || "").toUpperCase()} · {STORE_LABELS[record.store] || record.store || "未记录"}</dd></div>
          <div><dt>商品ID</dt><dd>{record.productId || "未记录"}</dd></div>
          <div><dt>商家货号</dt><dd>{record.merchantSku || "未记录"}</dd></div>
          <div><dt>确认时间</dt><dd>{record.confirmedAt ? new Date(record.confirmedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未记录"}</dd></div>
          <div><dt>审核状态</dt><dd>{record.moderationStatus || "未记录"}</dd></div>
          <div><dt>销售状态</dt><dd>{record.saleStatus || "未记录"}</dd></div>
          {record.eVerificationOutcome ? <div><dt>E阶段结果</dt><dd>{sourceConflict ? "历史验证来源冲突" : record.eVerificationOutcome === "externally_verified" ? "外部发现并验证" : "系统创建并验证"}</dd></div> : null}
          {record.eVerificationOutcome ? <div><dt>是否本轮创建</dt><dd>{record.createdByCurrentRun ? "是" : "否"}</dd></div> : null}
          {record.currentPrice ? <div><dt>当前价格</dt><dd>{record.currentPrice.amount} {record.currentPrice.currency}</dd></div> : null}
          {record.currentStock !== undefined ? <div><dt>当前库存</dt><dd>{record.currentStock === "unknown" ? "未验证" : record.currentStock}</dd></div> : null}
          {record.imageCount !== undefined ? <div><dt>图片数量</dt><dd>{record.imageCount === "unknown" ? "未验证" : record.imageCount}</dd></div> : null}
          {record.validationStatus ? <div><dt>校验状态</dt><dd>{record.validationStatus}</dd></div> : null}
          {record.errors !== undefined ? <div><dt>单品错误</dt><dd>{record.errors === "unknown" ? "未验证" : `${record.errors.length}条`}</dd></div> : null}
        </dl>
        {record.ownerPriceDecision?.decision === "keep_current_live_price" ? (
          <p className="readback-evidence">主人最终价格决定：保留 {record.ownerPriceDecision.price.amount} {record.ownerPriceDecision.price.currency}</p>
        ) : null}
        {automatic && record.readback?.checkedAt ? <p className="readback-evidence">最近回读：{new Date(record.readback.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {record.readback.evidenceRef}</p> : null}
        <aside className={`post-launch-observation status-${observation.status}`}>
          <div className="post-launch-observation-heading">
            <b>上架后选品表现</b>
            <span>{observation.days === null ? "尚未计时" : `第 ${observation.days} 天`}</span>
          </div>
          <strong>{observation.label}</strong>
          <ol>
            <li>上架满 {POST_LAUNCH_THRESHOLDS.firstReviewDay} 天，访客少于 {POST_LAUNCH_THRESHOLDS.insufficientTrafficVisitors}：只说明流量不足，不判选品失败。</li>
            <li>{POST_LAUNCH_THRESHOLDS.engagementVisitorsMin}–{POST_LAUNCH_THRESHOLDS.engagementVisitorsMax} 个相关访客仍零加购：检查主图、价格、配送和产品吸引力。</li>
            <li>稳定在售 {POST_LAUNCH_THRESHOLDS.failureReviewDayMin}–{POST_LAUNCH_THRESHOLDS.failureReviewDayMax} 天，累计超过 {POST_LAUNCH_THRESHOLDS.failureVisitors} 个相关访客仍零订单：本轮测试失败。</li>
          </ol>
          {!observation.metricsComplete ? <small>当前没有把访客、加购、订单缺口写成零；接入真实平台指标后才自动判断。</small> : null}
        </aside>
        {safeWebUrl(record.productUrl) ? <a href={safeWebUrl(record.productUrl)} target="_blank" rel="noreferrer">打开已上架商品</a> : null}
        {["waiting_extension", "capturing"].includes(sourceCapture.status) && sourceCapture.mode === "listed_evidence_recovery" ? (
          <div className="source-capture-summary">
            <b>{currentCapture ? "正在补采1688只读证据" : "历史1688采集记录 · 当前执行未确认"}</b>
            <span>{currentCapture ? "本次服务已确认后台领取当前商品的只读证据采集。" : "保留上次等待记录；本次服务未确认该采集，打开页面不会自动恢复。"}</span>
          </div>
        ) : null}
        {sourceCapture.status === "needs_sku_selection" && sourceCapture.mode === "listed_evidence_recovery" ? (
          <div className="source-sku-selector">
            <div className="source-sku-selector-heading">
              <b>选择DD-H1对应的1688规格</b>
              <span>已选 {selectedSkuIds.length}/{(sourceCapture.skuChoices || []).length}</span>
            </div>
            <div className="source-sku-options">
              {(sourceCapture.skuChoices || []).map((sku) => {
                const attributes = Object.entries(sku.attributes || {}).map(([key, value]) => `${key}:${value}`).join(" · ");
                return (
                  <label className={`source-sku-option ${selectedSkuIds.includes(sku.sourceSkuId) ? "selected" : ""}`} key={sku.sourceSkuId}>
                    <input type="checkbox" checked={selectedSkuIds.includes(sku.sourceSkuId)} onChange={() => toggleSku(sku.sourceSkuId)} />
                    <span className="source-sku-option-main">
                      <b>{attributes || sku.propPath || `SKU ${sku.sourceSkuId}`}</b>
                      <small>SKU ID：{sku.sourceSkuId}</small>
                    </span>
                    <span className={sku.priceCny ? "source-sku-price" : "source-sku-price missing"}>{sku.priceCny ? `¥${sku.priceCny}` : "直接价格未取得"}</span>
                    <small>{sku.stock === null || sku.stock === undefined ? "库存未取得" : `库存 ${sku.stock}`}</small>
                  </label>
                );
              })}
            </div>
            <button type="button" className="button primary" disabled={saving || !selectedSkuIds.length} onClick={saveSelection}>
              {saving ? "正在保存…" : "确认规格并保存证据"}
            </button>
            <small>只保存1688证据，不退回选品、不自动派发，也不修改Ozon。</small>
          </div>
        ) : null}
        {sourceCapture.status === "verified" && sourceCapture.mode === "listed_evidence_recovery" ? (
          <div className="source-capture-summary">
            <b>1688精确证据已补齐</b>
            {(sourceCapture.selectedSkus || []).map((sku) => (
              <span key={sku.sourceSkuId}>SKU {sku.sourceSkuId} · {Object.values(sku.attributes || {}).join(" · ") || sku.propPath || "规格已锁定"}</span>
            ))}
          </div>
        ) : null}
        {listedRecoveryAllowed && !["waiting_extension", "capturing", "needs_sku_selection"].includes(sourceCapture.status) ? (
          <div className="recovery-confirmation">
            {sourceCapture.status === "failed" ? <b>{sourceCapture.reason || "上次采集已停止"}</b> : null}
            <button type="button" className="button primary" disabled={saving} onClick={captureOnce}>
              {saving ? "正在连接Chrome…" : "重新采集1688证据（一次）"}
            </button>
            <small>仅补当前商品的精确SKU和页面事实；原已上架记录保持不变。</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EliminatedPanel({ candidate, onComment }) {
  const [feedback, setFeedback] = useState("");
  const { saving, error: actionError, run: submitAction } = useSubmit();

  async function saveFeedback(event) {
    event.preventDefault();
    if (!feedback.trim()) return;
    return submitAction(async () => {
      const submittedFeedback = feedback;
      await onComment(buildCandidateCommentInput(candidate, submittedFeedback, "elimination_feedback"));
      setFeedback(current => shouldClearSubmittedComment(current, submittedFeedback) ? "" : current);
    });
  }

  return (
    <section className="workflow-card eliminated-card">
      {actionError && <p role="alert">{actionError}</p>}
      <div><h3>已淘汰</h3><p>{candidate.eliminationReason || "该商品不符合当前选品门槛"}</p></div>
      {candidate.codexReview?.profitCalculation?.status === "scenario" ? (
        <div className="conditional-profit">
          <strong>已按你填写的采购到手总价先算</strong>
          <span>参考卖家收入 {formatMoney(candidate.codexReview.profitCalculation.targetPriceRmb)} · 单件利润 {formatMoney(candidate.codexReview.profitCalculation.unitProfitRmb)} · 利润率 {formatPercent(candidate.codexReview.profitCalculation.marginRate)}</span>
          <small>{candidate.codexReview.profitCalculation.stressScenario}</small>
        </div>
      ) : null}
      <form className="elimination-feedback" onSubmit={saveFeedback}>
        <label>
          告诉Codex为什么不想做
          <textarea
            rows="2"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="例如：售价太低、体积太大、风格不适合蛋蛋鼠"
          />
        </label>
        <button type="submit" className="button secondary" disabled={!feedback.trim() || saving}>
          {saving ? "保存中…" : "保存淘汰原因"}
        </button>
        <small>仅记录为后续选品避坑条件，不会把商品重新送审。</small>
      </form>
    </section>
  );
}

function Activity({ candidate, onComment }) {
  const [comment, setComment] = useState("");
  const { saving, error: actionError, run: submitAction } = useSubmit();
  const entries = useMemo(() => [
    ...(candidate.comments || []).map((item) => ({ ...item, kind: "comment", message: item.message })),
    ...(candidate.history || []).map((item) => ({ ...item, message: item.detail }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-16), [candidate.comments, candidate.history]);

  async function send() {
    if (!comment.trim()) return;
    const submittedComment = comment;
    return submitAction(async () => {
      await onComment(buildCandidateCommentInput(candidate, submittedComment));
      setComment(current => shouldClearSubmittedComment(current, submittedComment) ? "" : current);
    });
  }

  return (
    <details className="activity-disclosure">
      {actionError && <p role="alert">{actionError}</p>}
      <summary>双方记录与留言 <small>{entries.length}条</small></summary>
      <div className="timeline">
        {entries.map((entry) => (
          <div className={`timeline-item actor-${entry.actor}`} key={entry.id}>
            <span>{entry.actor === "codex" ? "C" : entry.actor === "user" ? "我" : "系"}</span>
            <p>
              {entry.message}
              {entry.kind === "comment" &&
              (entry.requiresResponse === true || entry.status === "responded") ? (
                <small className={`comment-state ${entry.status === "responded" ? "responded" : "pending"}`}>
                  {entry.status === "responded" ? "已回复" : "待Codex回复"}
                </small>
              ) : null}
            </p>
            <time>{new Date(entry.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
          </div>
        ))}
      </div>
      <div className="comment-box">
        <MessageIcon />
        <textarea rows="2" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="补充说明给Codex" />
        <div className="comment-actions">
          <button type="button" className="button secondary" onClick={send} disabled={!comment.trim() || saving}>{saving ? "保存中…" : "仅留言"}</button>
          <small>普通留言不会启动任务；真实失败或业务决定请使用状态卡里的固定选项。</small>
        </div>
      </div>
    </details>
  );
}

function OzonSalesCapturePanel({ candidate, captureControl, extensionStatus, onStart }) {
  const capture = candidate.salesCapture || {};
  const failedPresentation = salesCaptureFailurePresentation(capture, extensionStatus);
  const marketAssessment = candidate.lifecycleV11?.opportunityPackage?.marketAssessment || null;
  const sampleAssessment = marketAssessment?.sampleSummaries?.find((item) => item.snapshotId === capture.snapshotId) || null;
  const sellerLabels = {
    cross_border_cn: "中国跨境卖家",
    other_cross_border: "其他跨境卖家",
    unknown: "卖家身份未确认",
    local_ru: "俄罗斯本土卖家"
  };
  const priorityLabels = {
    cross_border_cn: "最高（中国跨境）",
    other_cross_border: "次优（其他跨境）",
    unknown: "可用（身份未确认）",
    local_ru: "仅作背景"
  };
  const confidenceLabels = { high: "高", medium: "中", limited: "有限", unavailable: "暂不可判断" };
  const canShow = /^https:\/\/(?:www\.)?ozon\.ru\/product\//i.test(candidate.productUrl || "") &&
    ["awaiting_user_direction", "codex_processing", "needs_user_data"].includes(candidate.workflowStatus) &&
    !candidate.lifecycleV11?.skuPackage;
  const captureBusy = captureControl?.status === "busy";
  const { saving, error: actionError, run: submitAction } = useSubmit();
  if (!canShow) return null;

  async function start() {
    return submitAction(async () => {
      await onStart();
    });
  }

  return (
    <section className="workflow-card">
      {actionError && <p role="alert">{actionError}</p>}
      <div>
        <h3>销售端快照</h3>
        <p>由本机Chrome读取当前Ozon商品的结构化标题、价格、图片、属性和卖家身份证据。只保存证据，不推进业务阶段。</p>
        {capture.status === "waiting_extension" ? (
          <div className="source-capture-summary">
            <b>历史Ozon采集记录 · 当前执行未确认</b>
            <span>保留上次等待记录；当前销售采集领取协议尚未接通，打开页面不会恢复采集。</span>
          </div>
        ) : null}
        {capture.status === "verified" ? (
          <div className="source-capture-summary">
            <b>当前Ozon快照已保存</b>
            <span>卖家类型：{sellerLabels[capture.sellerType] || capture.sellerType || "未取得"} · 身份证据：{capture.sellerType === "unknown" ? "未确认" : "已确认"}</span>
            {capture.sellerType === "unknown" ? <span>卖家身份未确认，当前商品和价格证据可用。</span> : null}
            <span>当前价格：{capture.currentPrice} {capture.currency} · 图片 {capture.imageCount} 张 · 样本优先级：{priorityLabels[capture.sellerType] || "待判断"}</span>
            <span>商品可比性：{sampleAssessment?.comparability === "comparable" ? "可比" : sampleAssessment?.comparability === "not_comparable" ? "不可比" : "待A阶段综合判断"}</span>
            {marketAssessment ? (
              <>
                <span>价格带采用：{marketAssessment.sellerTypesUsed.map((type) => sellerLabels[type] || type).join("、") || "暂无"}；样本 {marketAssessment.primarySampleIds.length} 条；可信度 {confidenceLabels[marketAssessment.confidence] || marketAssessment.confidence}</span>
                <span>俄罗斯本土背景价：{marketAssessment.containsLocalRuBackground ? "包含，未作为主要价格基准" : "未包含"}；当前影响：{marketAssessment.status === "passed" ? "A销售证据已放行" : marketAssessment.gateReason}</span>
              </>
            ) : (
              <span>当前影响：卖家身份未知本身不阻断A/B；是否采用取决于商品可比性、价格、时效和证据完整度。</span>
            )}
            <span>商品ID {capture.productId} · {capture.observedAt ? new Date(capture.observedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</span>
          </div>
        ) : null}
        {capture.status === "failed" ? (
          <div className="source-capture-summary capture-failed">
            <b>{failedPresentation.heading}</b>
            <span>{failedPresentation.reason}</span>
            {failedPresentation.observedAt ? <span>失败记录时间：{new Date(failedPresentation.observedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span> : null}
            <span>{failedPresentation.currentExtension}</span>
            <span>{failedPresentation.explanation}</span>
            <span>技术状态：{capture.technicalStatus || "未验证"}；商品业务状态未改变。</span>
          </div>
        ) : null}
        {captureBusy && capture.status !== "waiting_extension" ? (
          <div className="source-capture-summary capture-busy">
            <b>商品采集控制正在使用</b>
            <span>{captureControl.label}；当前商品不会排队，也不会自动重试。</span>
          </div>
        ) : null}
        {capture.status !== "waiting_extension" ? (
          <button type="button" className="button primary" disabled={saving || captureBusy} onClick={start}>
            {saving ? "正在连接Chrome…" : captureBusy ? "其他商品正在采集" : capture.status === "failed" ? "按当前页面重试一次" : "用Chrome采集当前Ozon快照（一次）"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default function UserInspector({ candidate, rules, captureControl, extensionStatus, onUpdate, onEvaluate, onComment, onMarkListed, onRecoveryAction, onStartSourceCapture, onStartOzonSalesCapture, onSelectSourceCaptureSku, onUploadLifecycleFinalAsset, onSaveC2UploadDraft, onConfirmLifecycleFinalAssets, onSaveProductionOwnerDecision, onSaveFinalPricingReview, onSaveC1RightsReview, onAuthorizeC1PaidDraft, onContinueSavedC1Draft, onReadOriginalC1DraftResult, onRetryC1KeywordHandoff, onContinueC1Preparation, onBackfillC1SupplyAttributes, onSaveC1OzonAttributeMapping, onLoadC1OzonAttributes, onReadC1ColorDictionary, onRefreshC1CategorySchema, onProposeC1OzonAttributes, onRecalculateBWithExactCommission, productionIdentity }) {
  return (
    <section className="workflow-region">
      {/* 不属于任何一个阶段，所以摆在所有阶段面板之前：从条件测算一路到上架之前的每一屏都看得见。 */}
      <EstimatedCommissionNotice step={candidate.estimatedCommissionNoticeStepV1} />
      {candidate.lifecycleV11?.c1PricingReuse ? (
        <div className="source-capture-summary" role="status">
          <b>{candidate.lifecycleV11.c1PricingReuse.status === "reused" ? "改价后的文案核验已完成" : "改价后的文案复用待处理"}</b>
          <span>{candidate.lifecycleV11.c1PricingReuse.message}</span>
        </div>
      ) : null}
      <OzonSalesCapturePanel candidate={candidate} captureControl={captureControl} extensionStatus={extensionStatus} onStart={onStartOzonSalesCapture} />
      {candidate.workflowStatus === "awaiting_user_direction" ? <DirectionPanel candidate={candidate} onEvaluate={onEvaluate} /> : null}
      {candidate.workflowStatus === "codex_processing" ? <ProcessingPanel candidate={candidate} onRecoveryAction={onRecoveryAction} /> : null}
      {candidate.workflowStatus === "listing_preparation" ? (
        <ListingPreparationPanel candidate={candidate} captureControl={captureControl} onStartOzonSalesCapture={onStartOzonSalesCapture} onRecoveryAction={onRecoveryAction} onCapture={onStartSourceCapture} onSelectSku={onSelectSourceCaptureSku} onUploadLifecycleFinalAsset={onUploadLifecycleFinalAsset} onSaveC2UploadDraft={onSaveC2UploadDraft} onConfirmLifecycleFinalAssets={onConfirmLifecycleFinalAssets} onSaveProductionOwnerDecision={onSaveProductionOwnerDecision} onSaveFinalPricingReview={onSaveFinalPricingReview} onSaveC1RightsReview={onSaveC1RightsReview} onAuthorizeC1PaidDraft={onAuthorizeC1PaidDraft} onContinueSavedC1Draft={onContinueSavedC1Draft} onReadOriginalC1DraftResult={onReadOriginalC1DraftResult} onRetryC1KeywordHandoff={onRetryC1KeywordHandoff} onContinueC1Preparation={onContinueC1Preparation} onBackfillC1SupplyAttributes={onBackfillC1SupplyAttributes} onSaveC1OzonAttributeMapping={onSaveC1OzonAttributeMapping} onLoadC1OzonAttributes={onLoadC1OzonAttributes} onReadC1ColorDictionary={onReadC1ColorDictionary} onRefreshC1CategorySchema={onRefreshC1CategorySchema} onProposeC1OzonAttributes={onProposeC1OzonAttributes} productionIdentity={productionIdentity} />
      ) : null}
      <StoreSelectionPanel key={candidate.id} candidate={candidate} onUpdate={onUpdate} />
      {candidate.workflowStatus === "needs_user_data" ? <NeedsDataPanel candidate={candidate} onUpdate={onUpdate} identity={productionIdentity} onRecalculateBWithExactCommission={onRecalculateBWithExactCommission} /> : null}
      {candidate.lifecycleV11?.skuPackage?.businessPhase === "B" && candidate.lifecycleV11.finalPricingReviewStatus === "profit_rejected" ? <FinalPricingReviewForm candidate={candidate} onSave={onSaveFinalPricingReview} disabled={productionIdentity?.canSaveProductionOwnerDecision !== true} /> : null}
      {candidate.workflowStatus === "ready_to_list" ? <ReadyPanel candidate={candidate} rules={rules} onMarkListed={onMarkListed} /> : null}
      {candidate.workflowStatus === "listed" ? <ListedPanel candidate={candidate} onCapture={onStartSourceCapture} onSelectSku={onSelectSourceCaptureSku} /> : null}
      {candidate.workflowStatus === "eliminated" ? <EliminatedPanel candidate={candidate} onComment={onComment} /> : null}
      <Activity candidate={candidate} onComment={onComment} />
    </section>
  );
}
