import { useEffect, useState } from "react";
import { useSubmit } from "./FormRevisionNotice.jsx";

/**
 * Ozon 属性建议仍由软件生成、主人确认。追加规格的颜色缺口也提供
 * 主人显式映射入口：字典属性由现有服务端读数逐字核对，无字典属性
 * 按冻结类目资料接受主人确认的文字；页面不推断俄文值。
 */
export default function C1OzonAttributePanel({ candidate, identity, onBackfill, onSaveMapping, onRefreshSchema, onProposeAttributes, onLoadMappingFacts, onReadColorDictionary }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  const [proposal, setProposal] = useState(null);
  const [picked, setPicked] = useState({});
  const [mappingFacts, setMappingFacts] = useState(null);
  const [colorValues, setColorValues] = useState({ '10096': '', '10097': '' });
  const { saving, error, run } = useSubmit();
  const revision = candidate?.dataRevision;
  const active = sku?.businessPhase === "C1" && plan?.status === "inputs_ready";

  // 商品资料一变，上一轮建议就作废——它是按那一版的事实算出来的。
  useEffect(() => { setProposal(null); setPicked({}); setMappingFacts(null); setColorValues({ '10096': '', '10097': '' }); }, [revision, candidate?.id]);

  if (!active) return null;

  const canAct = identity?.canSaveC1RightsReview === true;
  const frozenSchema = plan?.inputSnapshots?.platformSchemaRules;
  const schemaHasAttributes = Array.isArray(frozenSchema?.attributes) && frozenSchema.attributes.length > 0;
  // 冻结的那份可能是**旧版读取器**读的，缺后来才加的字段。这里逐项检查，缺哪样都提示重读：
  //  - labelZh：没有中文属性名，主人读不懂就没法判断；
  //  - complexId：发 import 时每个属性都要它，缺了就拼不出 writeBindings，C2 那道门开不了。
  // 「只有完全没有属性表才给重读按钮」这条件写窄过一次，主人因此被卡在纯俄文表上。
  const schemaHasChinese = schemaHasAttributes && frozenSchema.attributes.some(item => item.labelZh);
  const schemaHasComplexId = schemaHasAttributes && frozenSchema.attributes.every(item => Number.isInteger(item.complexId));
  const schemaHasRuleVersion = typeof frozenSchema?.ruleVersion === 'string' && frozenSchema.ruleVersion.trim().length > 0;
  const needsSchemaRefresh = !schemaHasAttributes || !schemaHasChinese || !schemaHasComplexId ||
    candidate.siblingSourceV1 && !schemaHasRuleVersion;
  const schemaReady = schemaHasAttributes && schemaHasChinese && schemaHasComplexId;
  const supplyAttributes = plan?.inputSnapshots?.confirmedSupplierSkuSnapshot?.supplierSku?.attributes ?? {};
  const capturedKeys = Object.keys(supplyAttributes).filter(key => key !== "quantityOneEvidence" && key !== "purchaseCostComponents");
  const saved = sku?.ozonAttributeMappingsV1?.mappings ?? [];
  const supplierColor = candidate.sourceCapture?.skuChoices?.find(choice => choice.sourceSkuId === sku.supplierSkuId)?.attributes?.颜色;
  const colorSchema = ['10096', '10097'].map(id => frozenSchema?.attributes?.find(item => String(item.fieldKey) === id));
  const colorDictionaryReads = candidate.lifecycleV11?.c1ColorDictionaryReadsV1 ?? {};
  const currentColorCandidates = attributeId => {
    const record = colorDictionaryReads[attributeId];
    return record?.status === 'succeeded' && record.schemaRevision === frozenSchema?.schemaRevision &&
      record.schemaEvidenceId === frozenSchema?.evidenceId &&
      record.schemaRuleVersion === frozenSchema?.ruleVersion &&
      record.c1PlanId === plan?.c1PlanId && record.evidence?.complete === true &&
      Array.isArray(record.evidence.values) &&
      Date.parse(record.evidence.expiresAt) > Date.now() ? record.evidence.values : null;
  };
  const colorFact = mappingFacts?.confirmedFacts?.filter(fact =>
    fact.value === supplierColor && fact.factPath.startsWith('productAttributes.supplierAttributes.')) ?? [];

  /**
   * 事实值不一定是字符串：主人签的品牌声明就是 {status:"unbranded", name:null}。
   * React 直接渲染对象会抛异常、整页白屏——2026-09-18 真让主人白屏了一次。
   * 凡是要显示的值，一律先转成可读文字。
   */
  function readableFact(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "object" && typeof value.value === "string") return value.value;
    try {
      const text = JSON.stringify(value);
      return typeof text === "string" && text.length <= 120 ? text : "（结构化值，详见证据引用）";
    } catch { return "（结构化值，详见证据引用）"; }
  }

  function optionsFor(row) {
    const list = [];
    if (row.suggestion) list.push({ ...row.suggestion, kind: "suggestion" });
    for (const item of row.alternatives) list.push({ ...item, kind: "alternative" });
    return list;
  }
  function chosenFor(row) {
    if (Object.hasOwn(picked, row.attributeId)) return picked[row.attributeId];
    return row.suggestion ? row.suggestion.value : "";
  }
  function setChoice(attributeId, value) { setPicked(current => ({ ...current, [attributeId]: value })); }

  const pending = (proposal?.rows ?? []).map(row => {
    const value = chosenFor(row);
    if (!value) return null;
    const option = optionsFor(row).find(item => item.value === value);
    const fact = row.suggestion?.sourceFactPath;
    // 抄对标的值没有「我们自己的事实」当依据，就用建议那条；两者都没有就不能保存这一行。
    if (!option || !fact) return null;
    return { attributeId: row.attributeId, value, sourceFactPath: fact };
  }).filter(Boolean);

  function act(fn) {
    return event => {
      event.preventDefault();
      return run(async () => {
        if (!canAct) throw new Error("请先登录主人身份");
        await fn();
      });
    };
  }
  const backfill = act(() => onBackfill(candidate.id, { candidateId: candidate.id, dataRevision: revision }));
  const refreshSchema = act(() => onRefreshSchema(candidate.id, { candidateId: candidate.id, dataRevision: revision }));
  const propose = act(async () => {
    const result = await onProposeAttributes(candidate.id, { candidateId: candidate.id, dataRevision: revision });
    setProposal(result?.proposal ?? null);
    setPicked({});
  });
  const saveAll = act(async () => {
    if (pending.length === 0) throw new Error("没有可保存的行；先生成建议，或从候选里挑一个值");
    await onSaveMapping(candidate.id, { candidateId: candidate.id, dataRevision: revision, mappings: pending });
  });
  const readColorFacts = act(async () => {
    const result = await onLoadMappingFacts(candidate.id);
    setMappingFacts(result?.proposal ?? null);
  });
  const readColorCandidates = attributeId => act(async () => {
    const record = colorDictionaryReads[attributeId];
    await onReadColorDictionary(candidate.id, { attributeId,
      authorizationId: record?.status === 'authorized' && record.schemaEvidenceId === frozenSchema?.evidenceId &&
        record.schemaRuleVersion === frozenSchema?.ruleVersion && Date.parse(record.expiresAt) > Date.now()
        ? record.authorizationId : null });
  });
  const saveColor = act(async () => {
    if (colorFact.length !== 1 || colorSchema.some(item => !item) ||
        !colorValues['10096'].trim() || !colorValues['10097'].trim() ||
        ['10096', '10097'].some((id, index) => colorSchema[index].dictionaryId > 0 &&
          !currentColorCandidates(id)?.some(item => item.value === colorValues[id]))) {
      throw new Error('先核对唯一的供应颜色依据，并填写这两个属性的真实 Ozon 值');
    }
    const retained = saved.filter(item => !['10096', '10097'].includes(String(item.attributeId)))
      .map(item => ({ attributeId: String(item.attributeId), value: item.value, sourceFactPath: item.sourceFactPath }));
    await onSaveMapping(candidate.id, { candidateId: candidate.id, dataRevision: revision,
      mappings: [...retained, ...['10096', '10097'].map(attributeId => ({ attributeId,
        value: colorValues[attributeId].trim(), sourceFactPath: colorFact[0].factPath }))] });
  });

  return <section className="workflow-card c1-ozon-attribute-panel">
    <h3>Ozon 商品属性</h3>
    {candidate.siblingSourceV1 ? <div className="c1-sibling-color-mapping">
      <p><b>本规格供应原色：{supplierColor || '未取得'}</b>。10096 是广义商品颜色，10097 是这件规格的颜色名称；两项都须由你对当前规格确认。这里不会沿用父卡颜色，也不会替你翻译。</p>
      <p>冻结类目资料：{frozenSchema?.schemaRevision || '未取得'}；适用规则 {frozenSchema?.ruleVersion || '未保留，须重读'}；采集于 {frozenSchema?.collectedAt || '未取得'}。证据有效性由服务端核对。</p>
      <p>一次字典作业最多包含俄文和可选中文两次只读子请求；必须由主人先授权，不会触发平台写入。</p>
      {colorSchema.map((item, index) => <p key={index}>{index === 0 ? '10096 商品颜色' : '10097 颜色名称'}：{item ? `${item.labelZh || item.label || ''} · ${item.dictionaryId > 0 ? '官方字典逐字核对' : '按类目资料填写文字'}` : '当前冻结类目资料缺此属性，请先核对类目资料'}</p>)}
      <button type="button" disabled={!canAct || saving || !onLoadMappingFacts} onClick={readColorFacts}>查看当前规格可映射的事实</button>
      <p>可用的当前颜色依据：{!mappingFacts ? '先查看当前规格事实' : colorFact.length === 1 ? `${colorFact[0].value} · ${colorFact[0].factPath}` : '没有找到唯一依据，请核对供应颜色资料'}。</p>
      <form onSubmit={saveColor}>
          {['10096', '10097'].map((attributeId, index) => {
            const attribute = colorSchema[index];
            const read = colorDictionaryReads[attributeId];
            const candidates = currentColorCandidates(attributeId);
            return <div key={attributeId}>
              <label>{attributeId === '10096' ? '10096 广义商品颜色' : '10097 当前规格颜色名称'}
                {attribute?.dictionaryId > 0
                  ? candidates ? <select value={colorValues[attributeId]} disabled={saving}
                    onChange={event => setColorValues(current => ({ ...current, [attributeId]: event.target.value }))} required>
                    <option value="">请选择官方候选</option>
                    {candidates.map(item => <option key={item.dictionaryValueId} value={item.value}>
                      {item.valueZh ? `${item.valueZh}（${item.value}）` : item.value}
                    </option>)}
                  </select> : <span>需授权读取完整的官方字典候选，当前不能猜填。</span>
                  : attribute?.dictionaryId === 0 ? <input value={colorValues[attributeId]}
                    onChange={event => setColorValues(current => ({ ...current, [attributeId]: event.target.value }))}
                    placeholder="填写你确认的准确文字" disabled={saving} required />
                    : <span>冻结类目资料缺此属性，请先核对类目资料。</span>}
              </label>
              {attribute?.dictionaryId > 0 && candidates ? <p>完整候选证据：{read.evidence.sourceRef}；有效至 {read.evidence.expiresAt}。</p> : null}
              {attribute?.dictionaryId > 0 && !candidates && !['request_sent', 'unknown_outcome'].includes(read?.status)
                ? <button type="button" disabled={!canAct || saving || !onReadColorDictionary ||
                    colorFact.length !== 1 || !schemaHasRuleVersion}
                  onClick={readColorCandidates(attributeId)}>
                  {read?.status === 'authorized' && read.schemaEvidenceId === frozenSchema?.evidenceId &&
                    read.schemaRuleVersion === frozenSchema?.ruleVersion && Date.parse(read.expiresAt) > Date.now()
                    ? '继续已授权的只读查询' : '授权并读取本规格官方颜色候选'}
                </button> : null}
              {attribute?.dictionaryId > 0 && ['request_sent', 'unknown_outcome', 'incomplete'].includes(read?.status)
                ? <p role="status">本次字典读取{read.status === 'incomplete' ? '候选不完整；可由主人明确重新授权读取' : '结果尚未确定；必须先核对'}；不可用这份结果映射，也不会自动重试。</p> : null}
            </div>;
          })}
          <button type="submit" disabled={!canAct || saving || colorFact.length !== 1 || colorSchema.some(item => !item) ||
            ['10096', '10097'].some((id, index) => colorSchema[index].dictionaryId > 0 && !currentColorCandidates(id))}>
            核对并保存本规格两个颜色属性
          </button>
      </form>
    </div> : null}
    <p>
      <b>这张表是中文的</b>——属性名和取值都用 Ozon 自己给的中文显示（括号里是发到平台上的俄文原值）。
      两边靠同一个字典号锁死：你看的是中文，发出去的是俄文，不会错位。
      字典属性按 Ozon 的准确候选核对；类目资料标为无字典的属性由你确认文字。
      每一行都标明它依据的是<b>我们自己的哪条事实</b>。你只需要看一眼，然后一次点头。
    </p>

    {capturedKeys.length === 0 ? <form onSubmit={backfill}>
      <p><b>冻结供应快照里还没有 1688 页面属性</b>（面料、适合季节、颜色…）。它们在同一次采集里已经采到了。</p>
      <button type="submit" disabled={!canAct || saving}>{saving ? "正在补齐…" : "补齐已采到的供应属性"}</button>
    </form> : <p>已采到的供应属性：{capturedKeys.join("、")}。</p>}

    {needsSchemaRefresh || candidate.siblingSourceV1 ? <form onSubmit={refreshSchema}>
      <p>{!schemaHasAttributes
        ? <><b>冻结的 Ozon 类目资料里没有属性表</b>，重读一次就能拿到全部属性和字典号——只读、免费。</>
        : !schemaHasChinese
          ? <><b>冻结的类目资料还是纯俄文的</b>（它是中文对照上线之前读的）。重读一次就能拿到 Ozon 官方的中文属性名——只读、免费。</>
          : !schemaHasComplexId
            ? <><b>冻结的类目资料缺少发商品时要用的属性编号</b>（它是这一项加上之前读的）。重读一次就补齐了——只读、免费。</>
            : !schemaHasRuleVersion
              ? <><b>冻结的类目资料没有保存适用规则版本</b>，无法核对当前官方候选与原冻结范围是否相同；须先受控重读同一类目。</>
            : <>当前类目资料的时间可能已过期。可由主人主动重读同一类目的官方资料，再判断当前规格颜色；这一步只读、免费。</>}</p>
      <button type="submit" disabled={!canAct || saving}>{saving ? "正在重读…" : "重读这个类目的 Ozon 资料"}</button>
    </form> : null}

    {saved.length > 0 ? <p>已签 {saved.length} 条：{saved.map(item => `${item.attributeLabel}=${readableFact(item.value)}`).join("、")}。</p> : null}

    {schemaReady && !proposal && !candidate.siblingSourceV1 ? <form onSubmit={propose}>
      <p>
        类目里有 {frozenSchema.attributes.length} 个属性、
        {frozenSchema.attributes.filter(item => item.dictionaryId > 0).length} 个带字典。
        点下面这个按钮，软件会读一遍字典、把能填的都填上。
        <b>这一步会花一次 AI 调用的钱</b>（几分钱量级），所以要你主动点。上方本规格颜色可直接核对，无需生成付费建议。
      </p>
      <button type="submit" disabled={!canAct || saving}>{saving ? "正在生成建议…（要十几秒）" : "让软件把这张表填好"}</button>
    </form> : null}

    {proposal ? <form onSubmit={saveAll}>
      <p>
        建议 {proposal.suggestedCount} 条（依据我们自己的事实，已默认选好）；
        另有 {proposal.alternativeOnlyCount} 行只有对标备选——
        <b>那是别人家商品的属性，默认不选</b>，你认为适用才挑。
      </p>
      <div className="c1-ozon-attribute-rows">
        <table>
          <thead><tr><th>Ozon 属性</th><th>取值</th><th>依据</th></tr></thead>
          <tbody>
            {proposal.rows.map(row => {
              const options = optionsFor(row);
              const chosen = chosenFor(row);
              if (options.length === 0) return null;
              return <tr key={row.attributeId}>
                <td>
                  <b>{row.labelZh || row.label || row.attributeId}</b>
                  {row.required ? <b> · 必填</b> : null}
                  {row.labelZh ? <div><small>{row.label}</small></div> : null}
                </td>
                <td>
                  <select value={chosen} disabled={saving} onChange={event => setChoice(row.attributeId, event.target.value)}>
                    <option value="">不填这一项</option>
                    {options.map(item => <option key={`${item.kind}:${item.value}`} value={item.value}>
                      {item.valueZh ? `${item.valueZh}（${item.value}）` : item.value}
                      {item.dictionaryValueId ? ` · 字典号 ${item.dictionaryValueId}` : " · 自由文本"}
                      {item.kind === "alternative" ? ` · 抄自对标${item.capturedFrom ? ` ${item.capturedFrom}` : ""}` : ""}
                    </option>)}
                  </select>
                </td>
                <td>
                  {row.suggestion
                    ? <span>{row.suggestion.sourceFactText || readableFact(row.suggestion.sourceFactValue)}<br /><small>{row.suggestion.sourceFactPath}</small></span>
                    : <b>我们自己没有这项事实，抄对标要你自己判断</b>}
                  {row.rejectedByDictionary
                    ? <div><small>模型给过「{row.rejectedByDictionary}」，字典里没有这个值，已挡下</small></div> : null}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <button type="submit" disabled={!canAct || saving || pending.length === 0}>
        {saving ? "正在核对字典并保存…" : `全部同意并保存这 ${pending.length} 条`}
      </button>
      <button type="button" disabled={saving} onClick={() => { setProposal(null); setPicked({}); }}>重新生成</button>
      {!canAct ? <p role="status">请先登录主人身份后保存。</p> : null}
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
