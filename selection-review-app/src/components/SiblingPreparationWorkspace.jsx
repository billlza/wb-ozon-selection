import './SiblingPreparationWorkspace.css';
import {c1CopyFields,siblingPreparationFinalGaps} from '../../lib/sibling-preparation-consistency.mjs';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { createPreparationValues, effectivePreparationValue as effective, changePreparationImage, setPreparationHero,
  movePreparationImage, batchPreparationFunctions, adoptPreparationCopy, createPreparationSession, preparationValuesEqual, preparationDraftScopeCurrent } from '../siblingPreparationState.js';

const commonFields=[['goods','单件商品价 ¥'],['freight','国内运费 ¥'],['packaging','额外操作费 ¥'],
  ['weight','打包重量 kg'],['length','包装长 cm'],['width','包装宽 cm'],['height','包装高 cm'],['price','买家目标成交价 RUB'],['stock','每款库存'],['route','线路'],
  ['titleRu','共用俄语标题'],['titleZh','中文标题复核'],['descriptionRu','共用俄语描述'],['descriptionZh','中文描述复核'],['bulletRu','共用俄语要点'],['bulletZh','中文要点复核'],['rightsExpiresAt','权利核对有效至（当地时间）']];
const tabs=['共用资料与文案','颜色与规格','选择图片与排序','整批确认'];

export default function SiblingPreparationWorkspace({parent,siblings,onValues,onPage,onDirty,onStageAssets,formalCopyAdoption,onSaved,onStatus,onSupplyPreparation,onSaving,saveState,onCatalog,confirmingSupply=false,supplyConfirmationReceipt}) {
  const [catalog,setCatalog]=useState(null),[values,setValues]=useState(null),[saved,setSaved]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  const session=useRef(null), currentValues=useRef(null);
  if (!session.current) session.current=createPreparationSession();
  const [supplyPreparation,setSupplyPreparation]=useState(null);
  const [loadStatus,setLoadStatus]=useState('loading');
  function status(next){const value=['configured','unconfigured'].includes(next) && saveState.status!=='idle' ?
    (saveState.status==='unknown'?'save_unknown':'save_pending'):next;setLoadStatus(value);onStatus?.(value);}
  function publishValues(next){currentValues.current=next;setValues(next);onValues(next);}
  async function reload() {
    setError('');status('loading');
    const token=session.current.capture();
    try {
      await session.current.read(()=>api.getSiblingPreparation(parent.id),response=>{
      if(!response.configured){if(values)throw new Error('本批来源已变化；当前输入保留，不能改用旧供货表单确认。');onValues(null);status('unconfigured');if(saveState.status!=='idle')setError('另一整批的草稿请求尚未核实；请返回原商品只读核对保存版本。');return;}
      if(!response.supplyPreparation)throw new Error('当前服务没有返回本批可核对的供货来源，不能确认。');
      if(values && (response.catalog.catalogId!==catalog.catalogId || response.catalog.version!==catalog.version)) throw new Error('素材目录已变化；当前输入保留，需核对目录版本后继续。');
      const reconciliation=saveState.reconcile(response);
      const next=response.draft?.values ?? createPreparationValues(response.catalog,parent,siblings,response.supplyPreparation);
      onCatalog(response.catalog);
      setSupplyPreparation(response.supplyPreparation);
      onSupplyPreparation?.(response.supplyPreparation);
      if(values){setSaved(response.draft);onSaved(response.draft);onDirty(reconciliation==='unknown' || !preparationValuesEqual(currentValues.current,response.draft?.values));status('configured');
        if(reconciliation==='unknown')setError('上次保存结果仍未核实；本次回读未与原请求完全匹配，保存和正式动作继续暂停。当前输入保留。');
        setNotice(reconciliation==='confirmed'?'已独立核对原请求的保存结果；当前输入保留。':'已只读核对保存版本；当前输入保留。');return;}
      setCatalog(response.catalog);setSaved(response.draft);publishValues(next);onPage(next.page);
      onDirty(saveState.status!=='idle' || !response.draft);onSaved(response.draft);status('configured');
      if(saveState.status!=='idle')setError(saveState.pendingParentCandidateId===parent.id?
        '上次草稿请求尚未核实，请只读核对保存版本。':'另一整批的草稿请求尚未核实；请返回原商品只读核对保存版本。');
      });
    }catch(cause){if(session.current.unchanged(token)){setError(cause.message);status('error');}}
  }
  useEffect(()=>{session.current.select(parent.id);void reload();return()=>session.current.dispose();},[parent.id]);
  function change(next){session.current.edited();publishValues(next);onPage(next.page);onDirty(saveState.status==='unknown' || !preparationValuesEqual(next,saved?.values));if(loadStatus==='loading')status('configured');setNotice(saveState.status==='unknown'?'当前修改已保留；上次保存结果仍未知，请只读核对保存版本。':'有未保存修改；保存草稿不会产生生产授权。');}
  useEffect(()=>{if(formalCopyAdoption && values){change(adoptPreparationCopy(values,formalCopyAdoption.map(c=>({candidateId:c.candidateId,fields:c1CopyFields(c.content)}))));}},[formalCopyAdoption]);
  useEffect(()=>{
    if(!supplyConfirmationReceipt || supplyConfirmationReceipt.draft.parentCandidateId!==parent.id)return;
    const receipt=supplyConfirmationReceipt;
    session.current.cancelReads();status('configured');
    setSaved(receipt.draft);onSaved(receipt.draft);
    if(preparationValuesEqual(currentValues.current,receipt.values)){
      publishValues(receipt.draft.values);onDirty(false);
      setNotice(`已保存并确认供货草稿版本 ${receipt.draft.draftRevision}；是否通过以正式利润结果为准。`);
    }
  },[supplyConfirmationReceipt]);
  async function save(){
    if(saving || !values)return;
    if(saveState.status!=='idle'){setError('上次草稿提交尚未核对，请先只读核对保存版本；不能创建新的保存请求。');return;}
    if(preparationDraftScopeCurrent(saved,parent,siblings,catalog) && preparationValuesEqual(values,saved.values)){onDirty(false);setNotice('当前内容已保存，无需重复提交。');return;}
    setSaving(true);onSaving?.(true);setError('');
    const token=session.current.capture();
    let request;
    try{const payload={parentCandidateId:parent.id,parentRevision:parent.dataRevision,
      memberRevisions:values.members.map(m=>({candidateId:m.candidateId,revision:siblings.find(c=>c.id===m.candidateId).dataRevision})),
      expectedDraftRevision:saved?.draftRevision ?? 0,idempotencyKey:`workspace:${crypto.randomUUID()}`,values};
      request=saveState.begin(payload,catalog);const response=await api.saveSiblingPreparation(parent.id,request.input);
      if(!saveState.confirm(request,response))throw new Error('保存回执与提交内容或身份不符，结果尚未确认');
      if(!session.current.current(token))return;session.current.cancelReads();status('configured');setSaved(response.draft);onSaved(response.draft);
      const unchanged=preparationValuesEqual(currentValues.current,response.draft.values);onDirty(!unchanged);
      setNotice(unchanged?`已保存草稿版本 ${response.draft.draftRevision}；未推进阶段或写入店铺。`:'提交时的草稿已保存；随后输入的修改仍未保存，已保留。');}
    catch(cause){const outcome=request?saveState.fail(request,cause):'idle';if(session.current.current(token)){status('configured');onDirty(true);setError(cause.message+(outcome==='unknown'?'。保存结果未知；当前输入和原请求已保留，请只读核对保存版本。':'。本次未保存；当前输入保留，请核对版本或修正输入后再保存。'));}}
    finally{if(session.current.current(token)){setSaving(false);onSaving?.(false);}}
  }
  if(loadStatus==='unconfigured')return null;
  if(!catalog || !values)return error?<p role="alert">整批草稿读取失败：{error} <button type="button" onClick={reload}>重新读取当前草稿</button></p>:<p role="status">正在读取整批资料；读取完成前不能确认供货。</p>;
  const assets=new Map(catalog.assets.map(a=>[a.assetId,a]));
  function memberChange(i,patch){const next=structuredClone(values);Object.assign(next.members[i],patch);next.supplyReviewed=false;change(next);}
  function imageAction(action){try{change(action());}catch(cause){setError(cause.message);}}
  const sourceChanged=saved && !preparationDraftScopeCurrent(saved,parent,siblings,catalog);
  function selectedImages(m){return <div className="sibling-workspace-images">{m.order.map((id,pos)=><figure key={id}><img src={assets.get(id).previewSrc} alt={assets.get(id).name}/><figcaption>{pos+1} · {m.hero===id?'主图':'附图'} · {assets.get(id).name}</figcaption></figure>)}</div>;}
  return <section aria-label="整批准备工作台" className="sibling-workspace">
    <fieldset disabled={confirmingSupply} style={{border:0,padding:0,margin:0,minWidth:0}}>
    <h3>三色整批准备</h3><p>共用资料填写一次，本色不同才修改。所有值先保存为草稿；正式阶段仍核对当前事实、利润和素材。历史首件与卡其排除。</p>
    <nav aria-label="整批准备页面">{tabs.map((name,i)=><button key={name} type="button" aria-pressed={values.page===i} onClick={()=>change({...values,page:i})}>{name}</button>)}</nav>
    {values.page===0?<section aria-label={tabs[0]}><div className="product-batch-common">{commonFields.map(([key,label])=><label key={key}>{label}{['descriptionRu','descriptionZh','bulletRu','bulletZh'].includes(key)?<textarea value={values.shared[key]} maxLength={1500} onChange={e=>change({...values,supplyReviewed:false,shared:{...values.shared,[key]:e.target.value}})}/>:<input type={key==='rightsExpiresAt'?'datetime-local':'text'} value={values.shared[key]} maxLength={1500} onChange={e=>change({...values,supplyReviewed:false,shared:{...values.shared,[key]:e.target.value}})}/>}</label>)}</div>
      <p>库存100是预填草稿；RUB目标价不等于正式利润或后台CNY写入价。空白字段保持待确认，不作为零。</p>
      <p>沿用其他采购费用：{values.shared.other===''?'原费用待补充':`${values.shared.other} 元`}；历史来源：{supplyPreparation?.costSourceRef??'未找到适用的已确认费用，不能默认零'}。</p>
      <details><summary>额外添加项（有变更时展开）</summary><label>调整本批其他采购费用总额 ¥<input value={values.shared.other} maxLength={1500} onChange={e=>change({...values,supplyReviewed:false,shared:{...values.shared,other:e.target.value}})}/></label><p>填写本批确认的总额；没有新增费用时沿用上方原值。</p></details>
      <details><summary>一件起订及逐规格单价来源（只读）</summary>{supplyPreparation?.rows.map(row=><p key={row.sourceSkuId}>{row.quantityOneEvidenceSourceNote??'本规格缺少依据'}；待本次供货确认，尚非本规格已确认结果。</p>)}</details>
      {supplyPreparation?.gaps.map(gap=><p role="alert" key={gap.candidateId}>{gap.message}</p>)}
      <p>点击下方“整批确认供货并分别计算正式利润”即一次确认上述供应规格、起订、费用、包装与共用销售证据；费用未修改时沿用上述值、无新增费用。不代表实际采购。</p>
    </section>:null}
    {values.page===1?<section aria-label={tabs[1]}><div className="sibling-workspace-colors">{values.members.map((m,i)=>{const c=catalog.colors[m.sourceSkuId];return <article key={m.sourceSkuId}><h4>{c.name}</h4><p>供应SKU：{m.sourceSkuId} · 来源：{c.sourceRef}</p><p>{c.colorNote}</p>
      <label>俄语颜色名称<input value={m.colorRu} onChange={e=>memberChange(i,{colorRu:e.target.value})}/></label>
      <label>基础颜色（用、分隔，正式字典核对）<input value={m.platformColors.join('、')} onChange={event=>memberChange(i,{platformColors:event.target.value.split('、').map(v=>v.trim()).filter(Boolean)})}/></label><p>平台基础颜色建议：{m.platformColors.join('、')}。建议来源为既有官方字典核对；正式确认仍要求当前SKU的有效Schema与字典证据。</p>
      <label>商家货号<input value={m.merchantSku} onChange={e=>memberChange(i,{merchantSku:e.target.value})}/></label><p>货号仍须服务端查重；规格草稿为均码，须与本色正式事实核对。</p>
      <details><summary>本色有差异时再修改</summary>{commonFields.filter(([k])=>['goods','weight','price','stock','titleRu','descriptionRu','bulletRu'].includes(k)).map(([k,label])=><label key={k}>{label}<input value={m.overrides[k]??''} placeholder={`留空沿用 ${values.shared[k]}`} onChange={e=>{const overrides={...m.overrides};if(e.target.value==='')delete overrides[k];else overrides[k]=e.target.value;memberChange(i,{overrides});}}/></label>)}</details>
    </article>;})}</div></section>:null}
    {values.page===2?<section aria-label={tabs[2]}><h4>功能图批量采用</h4><p>05酒瓶用途、06猫咪与魔术贴、10展开细节是待核对的功能候选，显示CP配色；不代表其他颜色外观。批量采用只追加附图，可逐色取消，不自动覆盖主图。</p>
      <button type="button" onClick={()=>imageAction(()=>batchPreparationFunctions(values,catalog,true))}>将这3张功能候选用于三色</button><button type="button" onClick={()=>imageAction(()=>batchPreparationFunctions(values,catalog,false))}>取消这3张在三色的使用</button>
      <div className="sibling-workspace-colors">{values.members.map(m=><article key={m.sourceSkuId}><h4>{catalog.colors[m.sourceSkuId].name} · 已选{m.order.length}张</h4><p>主图：{m.hero===null?'待你选择；附图第1张不代表主图':assets.get(m.hero).name}</p>
        {m.order.map((id,pos)=><div key={id} className="sibling-workspace-sequence"><img src={assets.get(id).previewSrc} alt={assets.get(id).name}/><p>{pos+1} / {m.order.length} · {assets.get(id).name} · {m.hero===id?'主图':'附图'}</p><p>{assets.get(id).note}</p>
          <button type="button" disabled={m.hero===id} onClick={()=>imageAction(()=>setPreparationHero(values,m.sourceSkuId,id))}>设为主图</button><button type="button" disabled={pos===0} onClick={()=>imageAction(()=>movePreparationImage(values,m.sourceSkuId,id,-1))}>上移</button><button type="button" disabled={pos===m.order.length-1} onClick={()=>imageAction(()=>movePreparationImage(values,m.sourceSkuId,id,1))}>下移</button><button type="button" onClick={()=>imageAction(()=>changePreparationImage(values,catalog,m.sourceSkuId,id,false))}>取消选中</button></div>)}</article>)}</div>
      <h4>可选图片 · 15张成品＋3张本色白底图</h4><p>不确定适用性的成品仍可由你选择颜色；尺寸、标签和使用权疑点保留。三张用户确认保留本色图仅归对应颜色；其他供应原图排除。</p><div className="sibling-workspace-gallery">{[...catalog.assets].sort((a,b)=>(a.onlySourceSkuId?0:1)-(b.onlySourceSkuId?0:1)).map(a=><article key={a.assetId}><img src={a.previewSrc} alt={a.name}/><h5>{a.name}</h5><p>{a.kind==='owner_color_exception'?'用户确认保留本色图':'用户成品图'}</p><p>{a.note}</p>{values.members.filter(m=>!a.onlySourceSkuId || a.onlySourceSkuId===m.sourceSkuId).map(m=><label key={m.sourceSkuId}><input type="checkbox" aria-label={`${a.name} 用于 ${catalog.colors[m.sourceSkuId].name}`} checked={m.order.includes(a.assetId)} onChange={e=>imageAction(()=>changePreparationImage(values,catalog,m.sourceSkuId,a.assetId,e.target.checked))}/>{catalog.colors[m.sourceSkuId].name}</label>)}
        {!a.onlySourceSkuId?<button type="button" onClick={()=>imageAction(()=>values.members.reduce((v,m)=>changePreparationImage(v,catalog,m.sourceSkuId,a.assetId,!values.members.every(x=>x.order.includes(a.assetId))),values))}>{values.members.every(m=>m.order.includes(a.assetId))?'取消全部颜色':'用于全部颜色'}</button>:null}
      </article>)}</div><button type="button" disabled={saving || saveState.status!=='idle' || loadStatus!=='configured' || !saved || values.members.some(m=>m.hero===null) || sourceChanged} onClick={async()=>{setSaving(true);setError('');try{if(saveState.status!=='idle')throw new Error('草稿提交尚未核实，不能暂存素材');await onStageAssets(values,catalog);onDirty(true);setNotice('所选素材已暂存为各SKU独立登记；仍需核对来源权利并冻结。');}catch(cause){setError(cause.message);}finally{setSaving(false);}}}>准备当前选中素材（本地暂存，不写店铺）</button>
    </section>:null}
    {values.page===3?<section aria-label={tabs[3]}><div className="sibling-workspace-colors">{values.members.map(m=>{const child=siblings.find(c=>c.id===m.candidateId),prep=child.productionOwnerPreparation;return <article key={m.sourceSkuId}><h4>{catalog.colors[m.sourceSkuId].name}</h4><p>供应SKU {m.sourceSkuId} · 商家货号 {m.merchantSku}</p><p>俄语颜色：{m.colorRu}</p><p>标题草稿：{effective(values,m,'titleRu')}</p><p>正式C1标题：{child.lifecycleV11?.skuPackage?.c1ProductPlan?.seoTitleDraft?.text??'待核验'}</p><p>描述草稿：{effective(values,m,'descriptionRu')}</p><p>库存草稿：{effective(values,m,'stock')} · 买家目标价草稿：{effective(values,m,'price')} RUB</p><p>正式利润：{child.lifecycleV11?.skuPackage?.profitModels?.find(p=>p.profitModelVersion===child.lifecycleV11.skuPackage.activeProfitModelVersion)?.result??'待完成'} · 后台CNY价格：{prep?.scope?.platformWritePrice?.amount??'待核对'} · 仓库：{prep?.executionBindings?.map(b=>b.warehouseName).join('、')||'待核对'}</p><p>主图：{m.hero===null?'待选择（附图第1张不代表主图）':assets.get(m.hero).name} · {m.order.length}张</p>{selectedImages(m)}<details><summary>已选图片的具体疑点</summary>{m.order.map(id=><p key={id}>{assets.get(id).name}：{assets.get(id).note}</p>)}</details></article>;})}</div>
      <p>正式最终授权范围包含本批商品创建、上架审核提交与逐款库存；以服务端当前最终卡锁定的价格、仓库、素材和库存为准。以下正式门禁有缺项时不能授权。卡其及历史首件不在范围内。</p>
    </section>:null}
    {values.page===3 && saved?<details open aria-label="草稿与正式方案差异"><summary>正式方案仍有缺项</summary><ul>{[...new Map(siblingPreparationFinalGaps({parent,members:siblings.filter(c=>values.members.some(m=>m.candidateId===c.id)),draft:saved}).map(gap=>[gap.candidateId+gap.message,gap])).values()].map((gap,i)=><li key={i}>{catalog.colors[values.members.find(m=>m.candidateId===gap.candidateId)?.sourceSkuId]?.name??'整批'}：{gap.message}</li>)}</ul></details>:null}
    {sourceChanged?<p role="status">正式商品版本已变化；草稿内容仍保留。请核对当前资料并保存新草稿版本。</p>:null}
    <button type="button" disabled={saving || saveState.status!=='idle' || loadStatus!=='configured' || saved && !sourceChanged && preparationValuesEqual(values,saved.values)} onClick={save}>{saving?'正在保存…':'保存整批草稿'}</button><p role="status">{notice}</p>{error || saveState.status==='unknown'?<p role="alert">{error || '上次草稿保存结果未知；当前输入和原请求已保留。'} <button type="button" disabled={saving} onClick={reload}>只读核对保存版本（保留本页输入）</button></p>:null}
    </fieldset>
  </section>;
}
