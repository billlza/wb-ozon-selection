import FormRevisionNotice, { useCandidateForm, useSubmit } from "./FormRevisionNotice.jsx";
import { buildAConfirmationInput, selectAConfirmationSku } from "../aConfirmationInput.js";
import { toggleLocalSupplierSkuSelection } from "../aSupplierCaptureSelection";
import { isCompleteStoreRef } from "../../lib/store-binding.mjs";

const SELLER_LABELS = {
  cross_border_cn: "中国跨境卖家",
  other_cross_border: "其他跨境卖家",
  unknown: "卖家身份未确认",
  local_ru: "俄罗斯本土卖家（仅背景）"
};

const EVIDENCE_STATUS_LABELS = {
  current: "当前可复用",
  waiting_context: "等待适用范围",
  metadata_only: "只有摘要",
  invalid: "证据无效",
  expired: "已经过期",
  refresh_due: "到了复查提示时间（非失效、非阻断）",
  scope_mismatch: "适用范围不匹配",
  missing: "尚未准备"
};

const CONTEXT_STATUS_LABELS = {
  available: "已确定",
  missing: "待系统确定",
  conflict: "存在冲突"
};

function dateTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-CN");
}

function inputValue(field) {
  return field?.value ?? "";
}

function contextValue(field) {
  if (field.key !== "storeRef") return field.value || CONTEXT_STATUS_LABELS[field.status] || "待确定";
  const storeRef = field.value;
  if (field.status === "missing" || !isCompleteStoreRef(storeRef, storeRef?.stableStoreId)) return "店铺身份未取得";
  return `内部店铺 ${storeRef.stableStoreId} · 平台店铺 ${storeRef.platformStoreId} · 映射版本 ${storeRef.mappingVersion}`;
}

function Field({ label, hint, children, wide = false }) {
  return (
    <label className={wide ? "span-2" : ""}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export default function RealAConfirmationCard({ card, onSubmit, disabled = false }) {
  const quotedPackaging = card.guooRouteComparison?.resultRevision === card.sourceDataRevision
    ? card.guooRouteComparison.inputSnapshot?.packaging : null;
  const initial = {
    decision: "confirm",
    targetSalePriceRub: card.targetSalePriceRub ?? "",
    salesReview: {
      snapshotId: card.salesReview?.snapshotId || "",
      comparability: card.salesReview?.comparability || "unknown",
      validityStatus: card.salesReview?.validityStatus || "unknown",
      confidence: card.salesReview?.confidence || "unknown"
    },
    supplierConfirmation: {
      captureId: inputValue(card.supplierConfirmation.captureId),
      minimumOrderQuantity: inputValue(card.supplierConfirmation.minimumOrderQuantity),
      quantityOneEvidenceSourceNote: "",
      matchType: inputValue(card.supplierConfirmation.matchType) || "unknown",
      productUrl: inputValue(card.supplierConfirmation.productUrl),
      supplierSkuId: inputValue(card.supplierConfirmation.supplierSkuId),
      variantKey: inputValue(card.supplierConfirmation.variantKey),
      unitProductPrice: inputValue(card.supplierConfirmation.unitProductPrice),
      unitDomesticFreight: inputValue(card.supplierConfirmation.unitDomesticFreight),
      otherPurchaseCosts: inputValue(card.supplierConfirmation.otherPurchaseCosts),
      actualPurchaseCost: inputValue(card.supplierConfirmation.actualPurchaseCost),
      weightKg: quotedPackaging?.weightKg ?? inputValue(card.supplierConfirmation.weightKg),
      dimensionsCm: {
        length: quotedPackaging?.dimensionsCm.length ?? inputValue(card.supplierConfirmation.dimensionsCm.length),
        width: quotedPackaging?.dimensionsCm.width ?? inputValue(card.supplierConfirmation.dimensionsCm.width),
        height: quotedPackaging?.dimensionsCm.height ?? inputValue(card.supplierConfirmation.dimensionsCm.height)
      },
      ownerSupplyConfirmed: false
    }
  };
  const record = { id: card.sourceCandidateId, dataRevision: card.sourceDataRevision };
  const [draft, setDraft, guard] = useCandidateForm(record, { form: initial, localSelectedSkuIds: [] });
  const { form, localSelectedSkuIds } = draft;
  const setForm = update => setDraft(current => ({ ...current, form: update(current.form) }));
  const setLocalSelectedSkuIds = update => setDraft(current => ({ ...current, localSelectedSkuIds: update(current.localSelectedSkuIds) }));
  const { saving, error, run } = useSubmit();

  function updateSupplier(key, value) {
    setForm((current) => ({
      ...current,
      supplierConfirmation: { ...current.supplierConfirmation, [key]: value }
    }));
  }

  function updateDimension(key, value) {
    setForm((current) => ({
      ...current,
      supplierConfirmation: {
        ...current.supplierConfirmation,
        dimensionsCm: { ...current.supplierConfirmation.dimensionsCm, [key]: value }
      }
    }));
  }

  async function submit(decision) {
    return run(async () => {
      guard.assertCurrent();
      if (decision === "confirm" && captureReady && !costReady) throw new Error("正式成本尚未就绪，请先补齐成本策略缺口。");
      await onSubmit(buildAConfirmationInput(card, form, decision, guard.sourceRevision));
    });
  }

  const sales = card.salesReview;
  const readiness = card.systemEvidenceReadiness;
  const preparationPlan = card.systemEvidencePreparationPlan;
  const supplierCapture = card.supplierCapture;
  const providerEvidence = supplierCapture?.sourceMode === 'provider_api_read_only';
  const captureInProgress = ["waiting_extension", "capturing", "extension_version_mismatch"].includes(supplierCapture?.status);
  const captureReady = supplierCapture?.status === "captured_waiting_owner_selection";
  const browserEvidence = supplierCapture?.quantityOneEvidenceRequired === true &&
    supplierCapture?.sourceMode === "chrome_extension_structured_page_v1";
  const selectedSku = captureReady
    ? supplierCapture.skuChoices.find(sku => sku.sourceSkuId === form.supplierConfirmation.supplierSkuId) : null;
  const canEnterSkuPrice = browserEvidence && selectedSku && selectedSku.priceCny == null;
  const canEnterMoq = browserEvidence && selectedSku &&
    (selectedSku.minimumOrderQuantity == null || selectedSku.minimumOrderQuantity === "unknown");
  const selectedSpecification = selectedSku
    ? Object.entries(selectedSku.attributes || {}).map(([key, value]) => `${key}：${value}`).join(" · ") || selectedSku.propPath || null : null;
  const systemReady = readiness?.ready === true;
  const costReadiness = card.costPolicyReadiness;
  const costReady = costReadiness?.ready === true;
  const prepareCount = (preparationPlan?.actions || []).filter((action) => action.action === "prepare_once").length;
  const reuseCount = (preparationPlan?.actions || []).filter((action) => action.action === "reuse").length;
  return (
    <section className="real-a-confirmation-card" aria-label="真实A阶段完整确认卡">
      <FormRevisionNotice guard={guard} disabled={saving} />
      {error && <p role="alert" className="form-error">{error}</p>}
      <header>
        <div>
          <small>{card.cardVersion} · 修订 {card.sourceDataRevision}</small>
          <h3>A阶段完整确认卡</h3>
          <p>销售判断、精确供应SKU、成本和包装资料一次确认；不会连续弹出重复问题。</p>
        </div>
        <strong>{card.targetPlatform ? card.targetPlatform.toUpperCase() : "平台未确认"} · {card.targetStore}</strong>
      </header>
      {card.storeBindingStatus !== "bound" && <p role="alert" className="form-error">店铺身份尚未配置或无效。可以保存资料或淘汰商品；配置完成并保存店铺选择后，才能确认进入B。</p>}
      {card.guooRouteComparison && <div className="real-a-sales-proof">
        <b>上次国欧物流比较 · {card.guooRouteComparison.ruleVersion}</b>
        <span>采用主人指定表版本，未证明它是官方最新版本。</span>
        {card.guooRouteComparison.selectedRoute ? <>
          <span>自动预填：{card.guooRouteComparison.selectedRouteLabel} · 表内最低运费 {card.guooRouteComparison.minimumRoutes[0].totalFreightRmb} 元</span>
          {card.guooRouteComparison.routes.filter(route => route.route === card.guooRouteComparison.selectedRoute).map(route =>
            <span key={route.route}>对应配送方式：{route.deliveryMethods.join(" / ")}；具体方式及仓库尚未核定。</span>)}
          {!card.guooRouteComparison.transportVerified && <span>此为表内报价推荐，商品运输限制仍需核实。</span>}
        </> : <span>{card.guooRouteComparison.status === "blocked" ? "输入或表内边界尚未明确，未形成最低报价。" : "尚未确定唯一最低价线路族。"}</span>}
        {[...new Set([...card.guooRouteComparison.globalIssues.map(issue => issue.message),
          ...card.guooRouteComparison.routes.flatMap(route => route.reasons.map(reason => reason.message))])].map(message => <span key={message}>{message}</span>)}
      </div>}

      <div className="real-a-sales-proof">
        <b>A销售快照</b>
        {sales ? (
          <>
            <span>{sales.title}</span>
            <span>当前价格 {sales.currentPrice} {sales.currency} · {SELLER_LABELS[sales.sellerType] || sales.sellerType}</span>
            <span>采集于 {new Date(sales.collectedAt).toLocaleString("zh-CN")} · 身份证据 {sales.sellerIdentityStatus}</span>
          </>
        ) : <span>没有有效销售快照，不能确认进入B。</span>}
      </div>

      <div className="real-a-sales-proof">
        <Field label="目标成交价（RUB）" hint="与下方包装重量、长宽高一起用于国欧realFBS表内运费比较。">
          <input type="number" min="0.01" step="0.01" value={form.targetSalePriceRub}
            onChange={event => setForm(current => ({ ...current, targetSalePriceRub: event.target.value }))} disabled={disabled || saving} />
        </Field>
      </div>
      <section className="real-a-ai-assist" aria-label="A阶段AI辅助判断">
        <b>Terra辅助整理</b>
        {sales?.terraAssist ? (
          <>
            <span>{sales.terraAssist.output?.summary || "已生成结构化辅助草稿"}</span>
            <small>模型 {sales.terraAssist.modelVersion} · 仅供参考，不覆盖页面价格、标题、类目或卖家身份。</small>
          </>
        ) : card.aiAssist?.status === "failed" ? (
          <>
            <span>AI整理已停止：{card.aiAssist.failure?.message || "技术失败"}</span>
            <small>商品业务结论未改变；没有换Sol，也没有自动重试。</small>
          </>
        ) : (
          <span>{providerEvidence ? '本轮尚无已保存的辅助草稿；请按商品证据核对，模型建议不能替代事实。' : '销售快照保存后由软件调用Terra一次；尚未生成辅助草稿。'}</span>
        )}
      </section>

      <section className="real-a-supplier-capture" aria-label="A阶段1688供应采集">
        <header>
          <div>
            <b>{providerEvidence ? '1688供应SKU详情证据' : '1688供应SKU只读采集'}</b>
            <span>{providerEvidence ? '来源为本轮已保存的 LinkFox 详情回执；供应SKU尚未确认。' : '短链由插件只打开一次；采集后只列出全部真实SKU，不自动选择或进入B。'}</span>
          </div>
          {supplierCapture?.status === "waiting_extension" ? <strong>等待插件后台领取</strong> : null}
          {supplierCapture?.status === "capturing" ? <strong>插件已领取 · 第1次采集</strong> : null}
          {supplierCapture?.status === "extension_version_mismatch" ? <strong>插件版本不匹配</strong> : null}
        </header>
        {providerEvidence && supplierCapture.complianceStatus === 'brand_review_required' ? <p role="alert">商品详情含品牌信息，权利未核清，不能按普通无品牌商品确认进入B。</p> : null}
        {providerEvidence ? <p>起订量：{supplierCapture.minimumOrderQuantity === 'unknown' ? '未取得，不能确认供货' : `${supplierCapture.minimumOrderQuantity} 件`}
          {supplierCapture.minimumOrderQuantity !== 1 && supplierCapture.minimumOrderQuantity !== 'unknown' ? '；当前方案不满足一件起订。' : ''}</p> : null}
        {supplierCapture?.status === "captured_waiting_owner_selection" ? (
          <>
            <p>已取得 offer {supplierCapture.offerId}，共 {supplierCapture.skuChoices.length} 个SKU；当前本地勾选 {localSelectedSkuIds.length} 个，尚未保存或确认供应方案。</p>
            <details>
              <summary>{providerEvidence ? '查看并比较详情返回的SKU、单件价格和库存' : '查看并临时多选全部SKU、页面直接价格和库存'}</summary>
              <div className="real-a-supplier-skus">
                {supplierCapture.skuChoices.map((sku) => (
                  <label key={sku.sourceSkuId}>
                    <input
                      type="checkbox"
                      checked={localSelectedSkuIds.includes(String(sku.sourceSkuId))}
                      onChange={(event) => setLocalSelectedSkuIds((current) => toggleLocalSupplierSkuSelection(current, sku.sourceSkuId, event.target.checked))}
                    />
                    <span>
                      <b>{sku.sourceSkuId}</b>
                      <em>{Object.entries(sku.attributes || {}).map(([key, value]) => `${key}：${value}`).join(" · ") || sku.propPath || "规格名称未取得"}</em>
                      <small>直接价格：{sku.priceCny ?? "未取得"}{Number.isFinite(sku.priceCny) ? " CNY" : ""} · 库存：{sku.stock ?? "未取得"}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
            <small>本地勾选只帮助你比较规格；本轮不会调用接口、保存选择、确认供应方案或进入B/C1。</small>
          </>
        ) : supplierCapture?.status === "capturing" ? (
          <p>插件后台已经领取当前单候选作业，正在执行唯一一次只读采集；无需主人或Codex继续点击。</p>
        ) : supplierCapture?.status === "extension_version_mismatch" ? (
          <p>{supplierCapture.reason || "当前插件版本与作业要求不一致；作业不会被领取，也不会打开1688。"}</p>
        ) : ["failed", "unknown_outcome"].includes(supplierCapture?.status) ? (
          <div className="real-a-capture-failure">
            <strong>{supplierCapture.failureDestinationLabel ? `采集停在：${supplierCapture.failureDestinationLabel}` : "本次采集已停止"}</strong>
            <p>{supplierCapture.reason || "上次采集已停止；A阶段业务状态未改变。"}</p>
            <small>登录页／人机验证页／移动页／中间跳转页／详情页加载超时／标签不可读取／地址未就绪／其他非白名单页面／不同商品会分别显示；不会保存完整跳转地址、查询参数或页面内容。</small>
          </div>
        ) : (
          <p>本卡只提交供应资料与主人决定；采集是否获准、是否已领取，以服务端作业和插件回执为准。</p>
        )}
      </section>

      <div className="real-a-form-grid">
        <Field label="商品可比性">
          <select value={form.salesReview.comparability} onChange={(event) => setForm((current) => ({ ...current, salesReview: { ...current.salesReview, comparability: event.target.value } }))}>
            <option value="unknown">尚未判断</option>
            <option value="comparable">确认合理可比</option>
            <option value="not_comparable">确认不可比</option>
          </select>
        </Field>
        <Field label="销售快照时效">
          <select value={form.salesReview.validityStatus} onChange={(event) => setForm((current) => ({ ...current, salesReview: { ...current.salesReview, validityStatus: event.target.value } }))}>
            <option value="unknown">尚未核验</option>
            <option value="current">当前有效</option>
            <option value="stale">已经过期</option>
          </select>
        </Field>
        <Field label="1688供应链接" wide hint={providerEvidence ? '已绑定本轮详情回执的精确商品，完整供货方案仍需你确认。' : '可先保存qr短链；插件采集成功后必须回填并锁定准确detail链接。'}>
          <input readOnly={providerEvidence || captureReady} value={form.supplierConfirmation.productUrl} onChange={(event) => updateSupplier("productUrl", event.target.value)} />
        </Field>
        <Field label="具体供应SKU">
          <input readOnly={captureReady} value={form.supplierConfirmation.supplierSkuId} onChange={(event) => updateSupplier("supplierSkuId", event.target.value)} />
        </Field>
        <Field label={captureReady ? "所选SKU规格标识" : "规格/变体"} hint={captureReady ? selectedSpecification || "规格名称未取得；此处仅为SKU身份。请在来源说明中描述实际规格，并核对精确同款。" : undefined}>
          <input value={form.supplierConfirmation.variantKey} readOnly={captureReady} onChange={(event) => updateSupplier("variantKey", event.target.value)} />
        </Field>
        <Field label="商品价（元/件）" hint={canEnterSkuPrice ? "当前SKU未取得直接价格，请按购买1件的实际单价补充，并填写来源说明。" : captureReady ? "采用所选SKU已取得的直接价格，不使用其他SKU或阶梯起价。" : undefined}>
          <input type="number" min="0" step="0.01" readOnly={captureReady && !canEnterSkuPrice} value={form.supplierConfirmation.unitProductPrice} onChange={(event) => updateSupplier("unitProductPrice", event.target.value)} />
        </Field>
        <Field label="国内运费（元/件）" hint="未知可暂留空，但确认完整供货方案前必须补齐；确认免运费时才填0。">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.unitDomesticFreight} onChange={(event) => updateSupplier("unitDomesticFreight", event.target.value)} />
        </Field>
        <Field label="其他采购费用（元/件）" hint="没有其他费用时明确填0。">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.otherPurchaseCosts} onChange={(event) => updateSupplier("otherPurchaseCosts", event.target.value)} />
        </Field>
        <Field label="实际采购成本（元/件）" hint="必须等于商品价＋国内运费＋其他采购费用。">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.actualPurchaseCost} onChange={(event) => updateSupplier("actualPurchaseCost", event.target.value)} />
        </Field>
        <Field label="实际打包重量（kg）">
          <input type="number" min="0" step="0.001" value={form.supplierConfirmation.weightKg} onChange={(event) => updateSupplier("weightKg", event.target.value)} />
        </Field>
        {[["length", "长（cm）"], ["width", "宽（cm）"], ["height", "高（cm）"]].map(([key, label]) => (
          <Field key={key} label={label}>
            <input type="number" min="0" step="0.1" value={form.supplierConfirmation.dimensionsCm[key]} onChange={(event) => updateDimension(key, event.target.value)} />
          </Field>
        ))}
      </div>

      {captureReady ? <div className="real-a-form-grid">
        <Field label="选择本次确认的唯一供应SKU">
          <select value={form.supplierConfirmation.supplierSkuId} onChange={event => setForm(current => selectAConfirmationSku(current, card, event.target.value))}>
            <option value="" disabled>请选择；不会自动选择</option>
            {supplierCapture.skuChoices.map(sku => <option key={sku.sourceSkuId} value={sku.sourceSkuId}>{sku.sourceSkuId} · {sku.variantKey || sku.propPath || "规格待核"}</option>)}
          </select>
        </Field>
        <Field label="同款判断"><select value={form.supplierConfirmation.matchType} onChange={event => updateSupplier("matchType", event.target.value)}>
          <option value="unknown">尚未确认</option><option value="exact_match">明确精确同款</option><option value="near_match">近似款，不能通过</option>
        </select></Field>
        <Field label="当前SKU起订量" hint={browserEvidence ? "未取得时请核实当前SKU是否一件可买后填写；已知起订量不能覆盖。" : "使用当前详情返回值，未知不能按1件处理。"}>
          <input type="number" min="1" step="1" value={form.supplierConfirmation.minimumOrderQuantity} readOnly={!canEnterMoq}
            onChange={event => updateSupplier("minimumOrderQuantity", event.target.value)} />
        </Field>
        {browserEvidence ? <Field label="当前SKU一件购买与规格的来源说明" wide hint="说明在哪里核实此SKU一件可买及其单价；规格名称未知时，请同时描述实际规格。切换SKU会清空本次补证。">
          <input maxLength={1000} value={form.supplierConfirmation.quantityOneEvidenceSourceNote} disabled={!selectedSku}
            onChange={event => updateSupplier("quantityOneEvidenceSourceNote", event.target.value)} />
        </Field> : null}
      </div> : null}

      <label className="real-a-owner-confirmation">
        <input type="checkbox" checked={form.supplierConfirmation.ownerSupplyConfirmed} onChange={(event) => updateSupplier("ownerSupplyConfirmed", event.target.checked)} />
        <span>我确认以上链接、供应SKU、价格、费用、重量和尺寸属于同一个采购方案。</span>
      </label>

      <section className={`real-a-evidence-panel ${systemReady ? "is-ready" : "has-gap"}`} aria-label="B阶段系统证据准备情况">
        <header>
          <div>
            <strong>{systemReady ? "系统B证据已齐" : "确认后由系统准备B证据"}</strong>
            <span>{systemReady ? "佣金、物流、汇率和Schema技术证据已齐；正式B仍需完整成本策略。" : "同一次确认会只读准备佣金、物流、汇率和Schema，不要求主人另点一次。"}</span>
          </div>
          <b>{systemReady ? "技术证据已齐" : "技术证据待准备"}</b>
        </header>

        {preparationPlan ? (
          <div className="real-a-evidence-plan">
            <strong>系统准备方式</strong>
            <span>沿用当前证据 {reuseCount} 类 · 需要只读准备 {prepareCount} 类</span>
            <small>{preparationPlan.status === "blocked_context" ? "先锁定适用范围，当前不会调用提供器。" : "每类缺口最多调用一次；任何失败立即停止，不自动重试，也不提交半套证据。"}</small>
          </div>
        ) : null}

        <div className="real-a-evidence-context">
          <strong>证据适用范围</strong>
          <div>
            {(readiness?.context?.fields || []).map((field) => (
              <span key={field.key} className={`status-${field.status}`}>
                <small>{field.label}</small>
                <b>{contextValue(field)}</b>
                <em>{CONTEXT_STATUS_LABELS[field.status] || field.status}</em>
              </span>
            ))}
          </div>
        </div>

        <div className="real-a-evidence-list">
          {(readiness?.fields || []).map((field) => (
            <article key={field.key} className={`evidence-${field.status}`}>
              <div>
                <strong>{field.label}</strong>
                <span>{field.message}</span>
              </div>
              <b>{EVIDENCE_STATUS_LABELS[field.status] || field.status}</b>
              {field.available ? (
                <small>取得 {dateTime(field.checkedAt)} · 有效至 {dateTime(field.expiresAt)}</small>
              ) : null}
            </article>
          ))}
        </div>

        {!systemReady ? (
          <footer>
            <span>当前需由系统准备：{readiness?.missing?.join("、") || "结构化系统证据"}。</span>
            <small>确认后每类只读一次；任一来源失败立即停止，不改变商品状态，也不保存半套证据。</small>
          </footer>
        ) : null}
      </section>

      <section className={`real-a-evidence-panel ${costReady ? "is-ready" : "has-gap"}`} aria-label="B阶段完整成本准备情况">
        <strong>{costReady ? "完整成本策略已就绪" : "正式成本尚未就绪"}</strong>
        <p>技术证据齐全不等于正式成本完整；必要成本确认后才能计算正式B利润。</p>
        {!costReady ? <>
          <p>{costReadiness ? "请补齐当前成本策略缺口：" : "当前成本策略尚未验证，不能进入正式B。"}</p>
          <ul>{(costReadiness?.missing || []).map((message, index) => <li key={index}>{message}</li>)}</ul>
          <small>可以继续核对供货资料或淘汰商品；尚未采集的供应链接仍可保存并申请采集。</small>
        </> : null}
      </section>

      <div className="real-a-actions">
        <button className="button secondary" type="button" disabled={disabled || saving || guard.conflict || !onSubmit || captureInProgress} onClick={() => submit("reject")}>淘汰商品</button>
        <button className="button primary" type="button" disabled={disabled || saving || guard.conflict || !onSubmit || captureInProgress || (captureReady && !costReady) || card.blockedByException || card.storeBindingStatus !== "bound"} onClick={() => submit("confirm")}>
          {saving ? "正在保存…" : captureReady ? "一次确认并进入B" : "保存A卡并等待插件自动采集"}
        </button>
      </div>
      {!onSubmit ? <p className="real-a-not-live">当前确认服务不可用；不会改变商品状态。</p> : null}
    </section>
  );
}
