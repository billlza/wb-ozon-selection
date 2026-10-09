import { finiteDisplayNumber, formatMoney, formatPercent } from "../finiteDisplay.js";
import { safeWebUrl } from "../formState.js";
import { storeLabel } from "../selectionDeskView.js";
import { productionAuthorizationInputFromCard } from "../productionAuthorizationInput.js";
import { buildOzonFinalProductPreview } from "../../lib/ozon-final-product-preview.mjs";
import ProductionOwnerDecisionForm from "./ProductionOwnerDecisionForm.jsx";
import FinalPricingReviewForm from "./FinalPricingReviewForm.jsx";
import { useSubmit } from "./FormRevisionNotice.jsx";

const VALUE_LABELS = { unknown: "未确认", no_battery: "无电池", battery_present: "含电池", verified: "已核验",
  allowed: "允许", not_applicable: "不适用", compliant: "符合已保存规则", passed: "通过", rejected: "未通过" };
const FIELD_LABELS = { length: "长", width: "宽", height: "高", unit: "单位", value: "数值", name: "名称",
  material: "材质", color: "颜色", size: "尺码", brand: "品牌", status: "状态", reason: "原因",
  "Пол животного": "适用宠物性别", "Сезон": "适用季节", "Материал": "材质", "10096": "颜色", "Цвет товара": "颜色", "Бренд": "品牌", "Тип": "商品类型", "Предназначено для": "适用对象",
  "Название модели (для объединения в одну карточку)": "型号（用于同卡规格）" };
const SPECIFICATION_FIELDS = new Set(["颜色", "尺码", "规格", "color", "size"]);
const UNKNOWN_PATH_LABELS = { "platformCategory.categoryId": "平台类目编号", "platformCategory.categoryName": "平台类目名称",
  "batteryAssessment.status": "电池核验状态", "batteryAssessment.assessment": "电池判断", "batteryAssessment.powered": "是否需要供电",
  "batteryAssessment.containsBattery": "是否含电池", "batteryAssessment.batteryType": "电池类型", "batteryAssessment.batteryCount": "电池数量",
  "batteryAssessment.batteryCapacity": "电池容量", "categoryRestrictions.status": "类目限制核验状态",
  "categoryRestrictions.restrictions": "类目限制", "platformCompliance.status": "平台合规核验状态", "platformCompliance.assessment": "平台合规判断" };
const UNKNOWN_REASON_LABELS = { sku_attribute_scope_unresolved: "已保存来源还不能确认这一属性属于当前精确规格",
  category_id_not_present_in_frozen_schema: "冻结的平台资料未提供类目编号", not_present_in_frozen_inputs: "已保存来源未提供这一项",
  battery_presence_not_present_in_frozen_inputs: "已保存来源未明确说明是否含电池",
  category_restrictions_not_present_in_frozen_schema: "冻结的平台资料未提供类目限制",
  platform_compliance_not_present_in_frozen_schema: "冻结的平台资料未提供合规判断" };
const EVIDENCE_STATUS_LABELS = { current: "当前有效", refresh_due: "到了复查提示时间（非失效、非阻断）", expired: "记录已过期", missing: "缺少记录", invalid: "记录待核对", scope_mismatch: "适用范围不符" };
const RISK_LABELS = { exact_commission_required_before_production: "利润使用估算佣金，生产前仍需取得正式费用依据。",
  battery_status_unknown: "电池状态尚未确认。", category_restrictions_unknown: "类目限制尚未确认。",
  platform_compliance_unknown: "平台合规状态尚未确认。", required_platform_attributes_incomplete: "平台必填属性尚不完整。",
  sales_reference_spec_differs_from_exact_supplier_sku: "销售参考商品与精确供应 SKU 存在已知规格差异。" };

const REQUIREMENT_LABELS = { required: "必填", optional: "选填", undeclared: "必选性待核对" };
const BLOCKER_LABELS = {
  PRODUCTION_FINAL_CARD_INCOMPLETE: "软件需补齐最终商品资料。",
  PRODUCTION_BINDING_NOT_CONFIGURED: "软件需完成本店仓库配置。",
  PRODUCTION_BINDING_EXPIRED: "软件需核验本店仓库配置。",
  PRODUCTION_FROZEN_C1_CHANGED: "软件需将已确认商品资料同步到新方案。",
  PRODUCTION_FROZEN_PREPARATION_INVALID: "软件需重新准备当前商品的方案。",
  PRODUCTION_FINAL_CARD_CHANGED: "软件需核对方案与商品资料的一致性。",
  PRODUCTION_FROZEN_PROFIT_INVALID: "软件需核对当前价格与利润依据。"
};
function unknownLabel(field) {
  return FIELD_LABELS[field.label] || FIELD_LABELS[field.fieldKey] || UNKNOWN_PATH_LABELS[field.path] || field.label || "尚未分类的事实";
}
function displayNumber(value, unit) {
  return finiteDisplayNumber(value) === null || !unit ? "待确认" : `${value} ${unit}`;
}
function FactValue({ value }) {
  if (value === null || value === undefined || value === "") return <>未取得</>;
  if (typeof value === "boolean") return <>{value ? "是" : "否"}</>;
  if (typeof value === "string") return <>{VALUE_LABELS[value] || value}</>;
  if (typeof value === "number") return <>{finiteDisplayNumber(value) === null ? "未取得" : value}</>;
  if (Array.isArray(value)) return <>{value.filter(item => typeof item === "string").join(" / ") || "待软件整理"}</>;
  if (value.unit && [value.length, value.width, value.height].every(item => finiteDisplayNumber(item) !== null))
    return <>{value.length} × {value.width} × {value.height} {value.unit}</>;
  if (value.unit && finiteDisplayNumber(value.value) !== null) return <>{value.value} {value.unit}</>;
  if (typeof value.value === "string") return <>{value.value}</>;
  if (typeof value.name === "string") return <>{value.name}</>;
  return <>文字待确认</>;
}
function FactRow({ label, fact }) {
  return <div><dt>{label}</dt><dd><FactValue value={fact?.value} /></dd></div>;
}
function Translation({ value }) {
  return value ? <p className="final-plan-translation" lang="zh-CN">{value}</p> : null;
}
function FinalImages({ candidateId, assets }) {
  return <ol className="final-plan-images">{assets.map((asset, index) => {
    const local = asset.assetRef === `local-asset:${asset.assetId}`;
    return <li key={asset.assetId}>
      {local && asset.mediaType === "image" ? <img loading="lazy"
        src={`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/local-assets/${encodeURIComponent(asset.assetId)}`}
        alt={`${index === 0 ? "主图" : `第 ${index + 1} 张`}：${asset.fileName}`} />
        : <span className="final-plan-image-placeholder">{asset.mediaType === "video" ? "视频素材" : "远程素材，未在此加载"}</span>}
      <b>{index === 0 ? "1 · 主图" : `${index + 1} · 图库图`}</b><span>{asset.fileName || `第 ${index + 1} 张图片`}</span>
    </li>;
  })}</ol>;
}

/** Display only: authority, revisions, saved facts and price decisions stay server-owned. */
export default function FinalProductPlanCard({ candidate, identity, onSaveProductionOwnerDecision, onSaveFinalPricingReview, onReviseC1FinalPlan, provisional = false, editorialPreview = null }) {
  const { saving, error, run } = useSubmit();
  const sku = candidate.lifecycleV11?.skuPackage;
  const card = sku?.productionConfirmationCard;
  if (!card) return null;
  if (editorialPreview !== null && !provisional) throw new Error("EDITORIAL_PREVIEW_REQUIRES_READ_ONLY_CARD");
  const preparation = candidate.productionOwnerPreparation;
  const readiness = productionAuthorizationInputFromCard(candidate, card);
  const currentCard = Number.isSafeInteger(card.cardRevision) && card.cardRevision >= 1 &&
    card.status === "awaiting_owner_business_confirmation" && card.ownerDecision === null;
  const authorized = sku.productionAuthorization;
  const canPrepareRevision = !provisional && currentCard && !authorized && identity?.authenticated === true && identity.roles?.includes("owner") &&
    typeof onReviseC1FinalPlan === "function";
  function prepareRevision() {
    return run(async () => {
      if (!canPrepareRevision) throw new Error("当前商品或主人身份不满足准备新版本的条件。");
      await onReviseC1FinalPlan({ candidateId: candidate.id, skuPackageId: sku.skuPackageId, dataRevision: candidate.dataRevision });
    });
  }
  const scope = authorized?.lockedScope || preparation?.scope;
  const snapshot = sku.c2FinalAssets?.productionAuthorizationPreparation?.finalCardInputSnapshot;
  const c1 = snapshot?.c1Snapshot;
  const preview = buildOzonFinalProductPreview({ card, schemaSnapshot: c1?.schemaSnapshot, platformSchemaAttributes: c1?.inputSnapshots?.platformSchemaRules?.attributes, seoEvidenceLayer: c1?.seoEvidenceLayer, savedSkuFactReconciliation: candidate.savedSkuFactReconciliation, candidateId: candidate.id, candidateRevision: candidate.dataRevision, candidate, editorialPreview });
  const product = card.productInformation;
  const facts = card.c1Facts;
  const supplier = product?.supplierOption?.value;
  const supplierUrl = safeWebUrl(supplier?.productUrl);
  const prices = card.profitResult?.recommendedSalePrice?.value;
  const supplierAttributes = facts?.productAttributes?.supplierAttributes || [];
  const specification = supplierAttributes.filter(field => SPECIFICATION_FIELDS.has(field.fieldKey));
  const recoveredSpecification = preview.reconciledFacts.filter(field => ["color", "size"].includes(field.field));
  const assets = card.c2Assets?.finalUploads;
  const unknowns = card.riskAndUnknowns?.unknownFields;
  const evidence = preparation?.evidenceReadiness;
  const profit = snapshot?.activeProfitModel;
  const blockingUnknowns = (unknowns || []).filter(field => field.blocksProductionAuthorization);
  const omittedAttributes = preview.attributes.filter(field => !field.mapped && field.requirement !== "required");
  const modelMatches = Boolean(profit?.profitModelVersion && profit.profitModelVersion === card.profitResult?.profitModelVersion);

  return <section className="product-section final-product-plan-card" aria-label="最终商品方案确认卡">
    <h3>{provisional ? "新版方案预览 · 文案待验收" : "最终商品方案确认卡"}</h3>
    {provisional ? <p role="status">{editorialPreview ? "本页展示原稿的局部修订版与原已确认图片；原模型回执保留。" : "本页展示真实文案与原已确认图片，"}尚未保存新的文案确认、最终方案卡或生产授权。</p> : null}
    {!currentCard && !authorized ? <p className="final-plan-status">历史确认卡和主人决定保持只读。</p> : null}
    {!provisional && !authorized && !readiness.ready ? <div className="final-plan-readiness is-blocked" role="status">
      <b>暂不能确认生产</b>
      {preparation?.gaps?.length ? <ul>{preparation.gaps.map((gap, index) => <li key={index}>
        {BLOCKER_LABELS[gap.code] || gap.message}
      </li>)}</ul> : <p>{readiness.reason}</p>}
      {blockingUnknowns.length ? <p>需补齐：{blockingUnknowns.map(unknownLabel).join("、")}。</p> : null}
      <p>以上由软件处理；你可以先核对方案，资料补齐后再确认。</p>
    </div> : null}
    {!preview.copyReadyForReview ? <p className="final-plan-copy-pending" role="status"><b>文案未就绪：</b>正式文案或中文释义尚未补齐，需软件完成后再核对。</p> : null}
    {canPrepareRevision ? <div className="final-plan-revision-action">
      <p>使用已有资料准备新版本，不收费、不上架；此操作不生成新文案。</p>
      <button type="button" className="button secondary" disabled={saving} onClick={prepareRevision}>
        {saving ? "正在准备新版方案…" : "用现有资料准备新版方案"}
      </button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}

    <section className="final-plan-part" aria-label="商品与价格"><h4>商品与价格</h4>
      <dl className="final-plan-facts">
        <div><dt>平台与店铺</dt><dd>{product?.targetPlatform?.value?.platform || "未取得"} · {preparation?.store?.displayName || storeLabel(candidate.targetStore)}</dd></div>
        <div><dt>供应 SKU</dt><dd>{product?.sku?.value?.supplierSkuId || "未取得"}
          {supplierUrl ? <> · <a href={supplierUrl} target="_blank" rel="noreferrer">供货商品</a></> : null}</dd></div>
        <div><dt>本店商品货号 · 必填</dt><dd>{authorized?.lockedScope?.merchantSku || preview.commercialDraft?.merchantSku || "生产确认时填写"}</dd></div>
        <div><dt>规格</dt><dd>{recoveredSpecification.length ? recoveredSpecification.map(field => <div key={field.field}>{field.label}：{field.valueZh}</div>) : specification.length ? specification.map(field => <div key={field.fieldKey}>
          {FIELD_LABELS[field.fieldKey] || field.fieldKey}：<FactValue value={field.fact?.value} /></div>) : "未取得已确认规格"}</dd></div>
        <div><dt>买家目标成交价</dt><dd>{displayNumber(scope ? scope.buyerTargetPrice?.amount : prices?.rub, scope ? scope.buyerTargetPrice?.currency : "RUB")}</dd></div>
        <div><dt>后台写入价 · 必填</dt><dd>{displayNumber(scope ? scope.platformWritePrice?.amount : prices?.cny, scope ? scope.platformWritePrice?.currency : "CNY")}</dd></div>
        <div><dt>已保存利润 / 利润率</dt><dd>{formatMoney(card.profitResult?.unitProfitRmb?.value)} / {formatPercent(card.profitResult?.profitMargin?.value, 2)}</dd></div>
        <div><dt>计划库存</dt><dd>{preview.commercialDraft ? `${preview.commercialDraft.stock} 件` : Number.isInteger(scope?.stock) && scope.stock >= 0 ? `${scope.stock} 件` : "待软件读取配置"}</dd></div>
      </dl>
    </section>

    <section className="final-plan-part" aria-label="Ozon 提交文案"><h4>Ozon 提交文案</h4>
      {preview.content.map(field => <article key={field.key} className="final-plan-content-field">
        <h5>{field.label} · 必填</h5>
        <div className="final-plan-bilingual"><p lang="ru" className="final-plan-copy">{field.value || "尚未保存"}</p><Translation value={field.reviewZh} /></div>
      </article>)}
    </section>

    <section className="final-plan-part" aria-label="类目属性与包装"><h4>类目、属性与包装</h4>
      <dl className="final-plan-facts">
        <div><dt>类目 · 必填</dt><dd>{preview.categoryParts.map(part => <div key={part.key}>
          <span lang="ru">{part.value || "待软件补齐"}</span><Translation value={part.reviewZh} />
        </div>)}</dd></div>
        <FactRow label="包装重量 · 必填" fact={facts?.productAttributes?.weight} />
        <FactRow label="包装尺寸 · 必填" fact={facts?.productAttributes?.dimensions} />
        {preview.reconciledFacts.filter(field => field.field === "battery").map(field => <div key={field.field}><dt>{field.label}</dt><dd>{field.valueZh}</dd></div>)}
      </dl>
      <div className="final-plan-attribute-grid">{preview.attributes.filter(field => field.mapped || field.requirement === "required").map(field => <article key={field.fieldKey}>
        <h5>{field.labelZh || FIELD_LABELS[field.label] || FIELD_LABELS[field.fieldKey] || field.label} · {REQUIREMENT_LABELS[field.requirement]}</h5>
        <p lang="ru"><FactValue value={field.value} /></p><Translation value={field.reviewZh} />
        {!field.mapped ? <small>需软件完成属性匹配。</small> : null}
      </article>)}</div>
      {preview.optionalMappingIssue ? <p role="alert">软件需完成平台属性匹配，当前不能按此属性方案提交。</p> : null}
    </section>

    <section className="final-plan-part" aria-label="最终图片首图与顺序"><h4>最终图片{Array.isArray(assets) ? ` · ${assets.length} 张` : ""}</h4>
      {Array.isArray(assets) ? <FinalImages candidateId={candidate.id} assets={assets} /> : <p role="alert">素材清单待软件核对。</p>}
    </section>
    <p className="product-section-hint">{preview.score.message}</p>

    {!provisional && !authorized && currentCard ? <ProductionOwnerDecisionForm key={`${candidate.id}:${card.cardRevision}`} candidate={candidate}
      identity={identity} onSave={onSaveProductionOwnerDecision} showReadinessReason={false} /> : null}
    {!provisional && !authorized && currentCard && onSaveFinalPricingReview ? <details className="final-plan-price-change"><summary>调整售价</summary>
      <p>仅在主动调整售价时使用。保存会重新核验成本及后续确认要求。</p>
      <FinalPricingReviewForm candidate={candidate} onSave={onSaveFinalPricingReview} disabled={identity?.canSaveProductionOwnerDecision !== true} />
    </details> : null}

    <details className="final-plan-technical-details"><summary>技术详情与资料记录</summary>
      <p>商品修订 {candidate.dataRevision} · 方案卡版本 {card.cardRevision}。查看本页不会提交平台。</p>
      <p>库存单独提交；卖点已按空行并入描述，搜索词通过保存的平台属性提交。必填标题、描述、搜索词、货号、价格和包装来自当前提交要求；属性必选性来自已保存的平台资料。</p>
      <p>有效且达到批准门槛的正式利润方案优先沿用；查看本页不会重新算价。</p>
      {scope?.priceConversion ? <p>当前确认范围的换算汇率：1 CNY = {scope.priceConversion.rubPerCny} RUB。</p> : null}
      {authorized ? <p>主人生产授权已经保存。</p> : <p>{readiness.reason}</p>}
      {preview.reconciledFacts.length ? <div><b>本次从已确认来源恢复的事实</b><p>{preview.reconciledFacts.map(field => `${field.label}：${field.valueZh}`).join("；")}。</p>
        <p>旧确认卡和生产授权未自动改写。</p></div> : null}
      {preview.reconciliationStale ? <p>恢复资料与当前商品版本不一致，未作为当前事实使用。</p> : null}
      {evidence ? <div><h5>资料有效性</h5><p>{evidence.message}</p><ul>{evidence.entries.map(entry => <li key={entry.kind}>
        <b>{entry.label}：{EVIDENCE_STATUS_LABELS[entry.status] || "待核对"}</b><p>{entry.message}</p>
        {entry.evidenceId ? <small>来源：{entry.evidenceId}</small> : null}
      </li>)}</ul></div> : null}
      {modelMatches ? <div><h5>保存的成本</h5><dl className="final-plan-facts">
        <div><dt>采购到手成本</dt><dd>{formatMoney(profit.actualPurchaseCost?.amount)}</dd></div>
        <div><dt>国际运费</dt><dd>{formatMoney(profit.internationalFreight?.amount)}</dd></div>
        <div><dt>佣金率</dt><dd>{formatPercent(profit.commissionRate, 2)}</dd></div>
        <div><dt>其他应计成本</dt><dd>{formatMoney(profit.otherCosts?.amount)}</dd></div>
      </dl></div> : null}
      {preview.translationGaps.length ? <p>缺少正式中文释义：{preview.translationGaps.map(field => field.label).join("、")}。</p> : null}
      {omittedAttributes.length ? <div><h5>当前未提交的选填属性</h5><ul>{omittedAttributes.map(field => <li key={field.fieldKey}>
        {field.labelZh || FIELD_LABELS[field.label] || FIELD_LABELS[field.fieldKey] || field.label}：尚未完成确认或平台字典匹配。
      </li>)}</ul></div> : null}
      {card.riskAndUnknowns?.materialRisks?.length ? <ul>{card.riskAndUnknowns.materialRisks.map((risk, index) => <li key={index}>{RISK_LABELS[risk] || "还有一项已保存风险，需软件补充可读说明。"}</li>)}</ul> : null}
      {Array.isArray(unknowns) ? unknowns.length ? <ul>{unknowns.map((field, index) => <li key={index}>
        <b>{unknownLabel(field)}</b>：{UNKNOWN_REASON_LABELS[field.reason] || "此项尚未确认，软件需补齐说明"}。
        {field.blocksProductionAuthorization ? "生产前需处理。" : "非阻断事项，未据此推断商品事实。"}
      </li>)}</ul> : <p>方案卡未列出未知事实。</p> : <p>未知事实清单未取得。</p>}
    </details>
  </section>;
}
