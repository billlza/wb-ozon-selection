import {
  CODEX_DECISION_LABELS,
  PROFIT_RULES,
  SOURCE_LABELS,
  STORE_LABELS,
  USER_DECISION_LABELS
} from "../constants";
import { ExternalIcon } from "./Icons";
import ExecutionRuntimeCard from "./ExecutionRuntimeCard";
import DESoftwareRuntimeCard from "./DESoftwareRuntimeCard";
import OzonAccountReadCard from "./OzonAccountReadCard";
import LifecycleStatusCard from "./LifecycleStatusCard";
import LifecycleEntryPreview from "./LifecycleEntryPreview";
import KeywordSoftwareRuntimeCard from "./KeywordSoftwareRuntimeCard";
import RealAConfirmationCard from "./RealAConfirmationCard";
import StatusBadge from "./StatusBadge";
import { safeWebUrl, safeImageUrl } from "../formState.js";
import { formatMoney } from "../finiteDisplay.js";
import { candidateRightsCompliancePresentation } from "../candidateViews.js";

function Link({ href, children }) {
  const url = safeWebUrl(href);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {children} <ExternalIcon />
    </a>
  );
}

function Value({ value, fallback = "未确认" }) {
  return <>{value === null || value === undefined || value === "" ? fallback : value}</>;
}

function ReviewList({ items }) {
  if (!items?.length) return <p className="muted">暂无</p>;
  return <ul className="compact-list">{items.map((item) => <li key={typeof item === "string" ? item : item.label}>{typeof item === "string" ? item : item.label}</li>)}</ul>;
}

export default function CandidateDetail({ candidate, seerfarRuntime, onRealAConfirm, onContinueSavedDE, onDispatchDProductionRound, onRollbackProductionAuthorization, onRecoverDInitialImport, onReobserveDUnknownOutcome, onReconcileDFromPlatformState = null, onAuthorizeAccountRead, onContinueAccountRead, realAConfirming = false }) {
  const dimensions = candidate.dimensionsCm || {};
  const rightsCompliance = candidateRightsCompliancePresentation(candidate);
  return (
    <main className="candidate-detail">
      <section className="product-hero">
        <div className="product-image">
          {safeImageUrl(candidate.imageUrl) ? (
            <img src={safeImageUrl(candidate.imageUrl)} alt={candidate.productName} />
          ) : (
            <div className="image-placeholder">等待商品图片</div>
          )}
        </div>
        <div className="product-overview">
          <div className="title-line">
            <div>
              <p className="product-id">{SOURCE_LABELS[candidate.source] ?? candidate.source ?? "unknown"} · {candidate.id}</p>
              <h2>{candidate.productName}</h2>
            </div>
            <StatusBadge status={candidate.workflowStatus} readback={candidate.eReadbackRuntimeView} />
          </div>
          <dl className="overview-grid">
            <div><dt>目标店铺</dt><dd>{STORE_LABELS[candidate.targetStore] ?? candidate.targetStore ?? "unknown"}</dd></div>
            <div><dt>来源</dt><dd>{SOURCE_LABELS[candidate.source] ?? candidate.source ?? "unknown"}</dd></div>
            <div><dt>采购到手总价（含国内运费）</dt><dd><Value value={formatMoney(candidate.purchasePriceRmb)} /></dd></div>
            <div><dt>申报装箱重量/尺寸</dt><dd><Value value={candidate.packedWeightKg ? `${candidate.packedWeightKg}kg · ${dimensions.length || "?"}×${dimensions.width || "?"}×${dimensions.height || "?"}cm` : null} /></dd></div>
          </dl>
          <div className="link-row">
            <Link href={candidate.productUrl}>打开商品</Link>
            <Link href={candidate.sourceUrl}>打开货源</Link>
            <Link href={candidate.competitorUrl}>打开俄区竞品</Link>
          </div>
          {candidate.notes ? <p className="product-note">{candidate.notes}</p> : null}
          <ExecutionRuntimeCard runtime={candidate.executionRuntimeView} />
          <KeywordSoftwareRuntimeCard candidate={candidate} runtimeStatus={seerfarRuntime} />
          {candidate.ozonAccountReadPreparation ? <OzonAccountReadCard preparation={candidate.ozonAccountReadPreparation}
            onAuthorize={onAuthorizeAccountRead} onContinue={onContinueAccountRead} /> : null}
          <DESoftwareRuntimeCard runtime={candidate.dESoftwareRuntimeView} readback={candidate.eReadbackRuntimeView}
            savedJobRuntime={candidate.dESavedJobRuntimeView}
            onContinueSaved={onContinueSavedDE ? payload => onContinueSavedDE(candidate.id, payload) : null}
            onDispatchNewRound={onDispatchDProductionRound ? payload => onDispatchDProductionRound(candidate.id, payload) : null}
            onRollbackAuthorization={onRollbackProductionAuthorization ? payload => onRollbackProductionAuthorization(candidate.id, payload) : null}
            onRecoverInitialImport={onRecoverDInitialImport ? payload => onRecoverDInitialImport(candidate.id, payload) : null}
            onReobserveUnknownOutcome={onReobserveDUnknownOutcome ? payload => onReobserveDUnknownOutcome(candidate.id, payload) : null}
            onReconcileFromPlatformState={onReconcileDFromPlatformState ? payload => onReconcileDFromPlatformState(candidate.id, payload) : null} />
          <LifecycleStatusCard candidate={candidate} />
          <LifecycleEntryPreview preview={candidate.lifecycleEntryPreview} />
          {candidate.supplierImageSearchPreparation?.status === 'not_configured' ? (
            <section className="inspector-section" aria-label="1688以图找货准备">
              <h3>1688以图找货</h3>
              <p role="status">图片搜索尚未就绪：页面操作规则和浏览器执行能力还未核验。</p>
              <p>指定供应链接的详情采集是独立步骤。图搜结果仍需核实同款、具体规格、一件起订和单件成本，再由你确认供货方案。</p>
            </section>
          ) : null}
          {candidate.realAConfirmationCard ? (
            <RealAConfirmationCard
              key={candidate.id}
              card={candidate.realAConfirmationCard}
              onSubmit={onRealAConfirm}
              disabled={realAConfirming}
            />
          ) : null}
          {candidate.selectionStage ? (
            <div className={`selection-stage stage-${candidate.selectionStage.stage}`}>
              <strong>{candidate.selectionStage.label}</strong>
              <span>{candidate.selectionStage.nextAction || ""}</span>
            </div>
          ) : null}
          {rightsCompliance ? (
            <div className="selection-stage stage-sourcePending" aria-label="权利与合规状态">
              <strong>{rightsCompliance.title}</strong>
              {rightsCompliance.details.map(detail => <span key={detail}>{detail}</span>)}
            </div>
          ) : null}
          {candidate.approvalGate?.autoElimination?.shouldEliminate ? (
            <div className="selection-stage stage-eliminated">
              <strong>证据充分 · 应自动淘汰</strong>
              <span>{candidate.approvalGate.autoElimination.reason}</span>
              <small>{candidate.approvalGate.autoElimination.formula}</small>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function Evidence({ evidence }) {
  if (!evidence?.length) return <p className="muted">尚无可验证证据链接</p>;
  return (
    <ul className="evidence-list">
      {evidence.map((item, index) => (
        <li key={`${item.url}-${index}`}>
          <Link href={item.url}>证据 {index + 1}</Link>
          <span>{item.checkedAt ? new Date(item.checkedAt).toLocaleString("zh-CN") : "未记录时间"} · {item.note || item.detail || "无说明"}</span>
        </li>
      ))}
    </ul>
  );
}

function PromotionPricingTable({ profit }) {
  const scenarios = Array.isArray(profit?.promotionPricing) ? profit.promotionPricing : [];
  if (!scenarios.length) {
    return <small className="legacy-profit-note">历史利润模型未按当前促销口径重算；旧20%–30%二次扣费结论不再沿用。</small>;
  }
  return (
    <div className="advertising-scenarios">
      {scenarios.map((scenario) => (
        <div key={scenario.key} className={`advertising-scenario scenario-${scenario.key}`}>
          <span>{scenario.label || scenario.key}</span>
          <b>建议标价 ¥{Number(scenario.suggestedListPriceRmb).toFixed(2)}</b>
          <small>目标折后成交价 ¥{Number(scenario.targetTransactionPriceRmb).toFixed(2)}；利润不再扣促销率</small>
        </div>
      ))}
    </div>
  );
}

function Profit({ review }) {
  const profit = review?.profitCalculation;
  if (profit?.status === "conditional_unverified") {
    return (
      <div className="profit-unverified profit-scenario">
        <strong>条件测算已完成 · 正式利润未验证</strong>
        <p>{profit.formula}</p>
        <div className="conditional-scenarios">
          {(profit.scenarios || []).map((scenario) => (
            <div key={scenario.key} className="conditional-scenario">
              <b>{scenario.label} · {scenario.transactionPriceRub} RUB</b>
              <span>条件卖家收入 ¥{scenario.conditionalSellerRevenueAfterCommissionCny} · 利润 ¥{scenario.unitProfitRmb} · 利润率 {(Number(scenario.marginRate) * 100).toFixed(1)}%</span>
              <small>促销20%/25%/30%建议标价：{scenario.promotionListPricesRub?.discount20}/{scenario.promotionListPricesRub?.discount25}/{scenario.promotionListPricesRub?.discount30} RUB</small>
            </div>
          ))}
        </div>
        <p>仍缺：{profit.missing?.join("、") || "当前真实完整证据"}</p>
      </div>
    );
  }
  if (profit?.directionalStatus === "passed" && profit?.status !== "verified") {
    return (
      <div className="profit-unverified profit-direction-passed">
        <strong>历史/方向利润为正 · 当前B阶段尚未正式通过</strong>
        <p>该数值只保留为历史参考；仍须满足当前市场、佣金、物流和促销口径后，系统才会自动进入待上架准备。1688精确SKU仍只在C阶段核验。</p>
        <div className="profit-grid">
          <div><span>单件利润</span><strong>¥{profit.unitProfitRmb}</strong></div>
          <div><span>利润率</span><strong>{(Number(profit.marginRate) * 100).toFixed(1)}%</strong></div>
        </div>
        <PromotionPricingTable profit={profit} />
      </div>
    );
  }
  if (profit?.status === "scenario") {
    return (
      <div className="profit-unverified profit-scenario">
        <strong>条件测算已完成</strong>
        <p>参考卖家收入 ¥{profit.targetPriceRmb} · 单件利润 ¥{profit.unitProfitRmb} · 利润率 {(Number(profit.marginRate) * 100).toFixed(1)}%</p>
        <p>{profit.stressScenario}</p>
        <PromotionPricingTable profit={profit} />
      </div>
    );
  }
  if (profit?.status !== "verified") {
    return (
      <div className="profit-unverified">
        <strong>利润未验证</strong>
        <p>缺：{review?.completeCost?.missing?.join("、") || "当前真实完整成本"}</p>
      </div>
    );
  }
  return (
    <>
      <div className="profit-grid">
        <div><span>目标售价</span><strong>{profit.targetPriceRmb ? `¥${profit.targetPriceRmb}` : `${profit.targetPriceRub || "?"} RUB`}</strong></div>
        <div><span>折后成交利润</span><strong>¥{profit.unitProfitRmb}</strong></div>
        <div><span>折后成交利润率</span><strong>{(Number(profit.marginRate) * 100).toFixed(1)}%</strong></div>
        <div><span>广告成本</span><strong>默认0；有真实投放另算</strong></div>
      </div>
      <PromotionPricingTable profit={profit} />
    </>
  );
}

export function CandidateReview({ candidate }) {
  const review = candidate.codexReview;
  return (
    <section className="candidate-review">
      <details className="review-disclosure">
        <summary>查看完整审核依据</summary>
        <div className="disclosure-content">
          <section className="rules-strip">
            <div>
              <h3>{STORE_LABELS[candidate.targetStore]} 利润与上架门槛</h3>
              <p>相似品参数不能直接套用；佣金和物流按当前真实类目、销售方案和最终包装重取。</p>
            </div>
            <div className="rule-items">{PROFIT_RULES.map((rule) => <span key={rule}>{rule}</span>)}</div>
          </section>

          <div className="decision-comparison">
            <div>
              <span>用户判断</span>
              <strong>{candidate.userEvaluation ? USER_DECISION_LABELS[candidate.userEvaluation.decision] : candidate.source === "user" ? "无需重复判断" : "未判断"}</strong>
              <p>{candidate.userEvaluation?.reason || "—"}</p>
            </div>
            <div>
              <span>Codex判断</span>
              <strong>{review ? CODEX_DECISION_LABELS[review.decision] : "等待审核"}</strong>
              <p>{review?.reason || "尚未写回审核结果"}</p>
            </div>
          </div>
          {candidate.opinionsDiffer ? <p className="disagreement"><strong>意见不一致</strong> 双方原始结论已保留。</p> : null}

          {review ? (
            <div className="review-sections">
              <section className="review-block">
                <h4>链接与货源</h4>
                <dl>
                  <div><dt>真实打开</dt><dd>{review.linkOpen?.detail || "未记录"}</dd></div>
                  <div><dt>SKU / 款式</dt><dd><Value value={[review.sourceSku?.sku, review.sourceSku?.variant].filter(Boolean).join(" · ")} /></dd></div>
                  <div><dt>MOQ / 采购价</dt><dd><Value value={review.sourceSku?.purchasePriceRmb !== null && review.sourceSku?.purchasePriceRmb !== undefined ? `${review.sourceSku.moq ? `${review.sourceSku.moq}件` : "MOQ留待C阶段"} / ¥${review.sourceSku.purchasePriceRmb}` : null} /></dd></div>
                </dl>
              </section>
              <section className="review-block">
                <h4>市场与费用</h4>
                <dl>
                  <div><dt>同规格竞品</dt><dd>{review.marketEvidence?.comparableCount || 0}条 · {review.marketEvidence?.status || "未验证"}</dd></div>
                  <div><dt>市场中位数</dt><dd><Value value={review.marketEvidence?.medianPriceRub ? `${review.marketEvidence.medianPriceRub} RUB` : null} /></dd></div>
                  <div><dt>Ozon类目 / 类型</dt><dd><Value value={review.category?.path ? `${review.category.path} · ${review.category.productType || "类型未记录"}` : null} /></dd></div>
                  <div><dt>佣金</dt><dd><Value value={review.commission?.rate !== null && review.commission?.rate !== undefined ? `${(review.commission.rate * 100).toFixed(1)}% · ${review.commission.source || "未记录来源"}` : null} /></dd></div>
                  <div><dt>官方汇率</dt><dd><Value value={review.exchangeRate?.rubPerCny ? `1 CNY = ${review.exchangeRate.rubPerCny} RUB · ${review.exchangeRate.rateDate || "日期未记录"}` : null} /></dd></div>
                  <div><dt>物流</dt><dd><Value value={review.logistics?.line ? `${review.logistics.line} · 实重${review.logistics.actualWeightKg ?? "?"}kg / 体积重${review.logistics.volumetricWeightKg ?? "?"}kg · ¥${review.logistics.freightRmb ?? "?"} · ${review.logistics.formula || ""}` : null} /></dd></div>
                  <div><dt>完整成本</dt><dd>{review.completeCost?.status === "complete" ? `¥${review.completeCost.totalRmb}` : `未完整：${review.completeCost?.missing?.join("、") || "待核"}`}</dd></div>
                </dl>
              </section>
              <section className="review-block profit-block"><h4>利润复算</h4><Profit review={review} /></section>
              <section className="review-block"><h4>风险</h4><ReviewList items={review.risks} /></section>
              <section className="review-block"><h4>材质与包装缺口</h4><ReviewList items={review.materialsPackagingGaps} /></section>
              <section className="review-block"><h4>还需要你补</h4><ReviewList items={candidate.needsFromUser} /></section>
              <section className="review-block evidence-block"><h4>证据链接与查询时间</h4><Evidence evidence={review.evidence} /></section>
              <section className="review-block"><h4>严格门槛</h4>{candidate.approvalGate.passed ? <p className="gate-passed">全部通过，已具备待上架资格。</p> : <ReviewList items={candidate.approvalGate.blockers} />}</section>
            </div>
          ) : <p className="review-empty">Codex审核写回后会自动显示，无需重新录入。</p>}
        </div>
      </details>
    </section>
  );
}
