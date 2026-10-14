/** Read-only comparison of the saved human draft with the real frozen lifecycle. No missing fact is inferred. */
export function c1CopyFields(content) {
  return {titleRu:content?.seoTitleDraft?.text ?? '',titleZh:content?.seoTitleDraft?.reviewZh ?? '',
    descriptionRu:content?.descriptionDraft?.text ?? '',descriptionZh:content?.descriptionDraft?.reviewZh ?? '',
    bulletRu:content?.bulletPointsDraft?.map(p=>p.text).join('；') ?? '',bulletZh:content?.bulletPointsDraft?.map(p=>p.reviewZh ?? '').join('；') ?? ''};
}
const effective=(values,m,k)=>m.overrides?.[k] === undefined || m.overrides[k] === '' && !Object.keys(c1CopyFields(null)).includes(k) ? values.shared[k] : m.overrides[k];
export function siblingPreparationFinalGaps({parent,members,draft}) {
  if(!draft)return [];
  const gaps=[],add=(m,field,message)=>gaps.push({candidateId:m?.candidateId??parent.id,field,message});
  if(draft.sourceRevision!==parent.dataRevision)add(null,'revision','正式父商品版本已变化，请核对并保存新草稿版本');
  if(draft.values?.supplyReviewed!==true)add(null,'supply','共用供货资料尚未由主人核对');
  if(!Array.isArray(draft.values?.members) || draft.values.members.length!==members.length){add(null,'scope','草稿批次身份不一致');return gaps;}
  for(const candidate of members) {
    const m=draft.values.members.find(v=>v.candidateId===candidate.id),sku=candidate.lifecycleV11?.skuPackage;
    if(!m || m.sourceSkuId!==candidate.siblingSourceV1?.supplierSkuId){add(null,'scope','草稿供应SKU身份不一致');continue;}
    if(draft.memberRevisions?.find(r=>r.candidateId===candidate.id)?.revision!==candidate.dataRevision)add(m,'revision','本色正式版本已变化，请核对并保存新草稿版本');
    if(!sku){add(m,'A','本色正式供货确认和利润尚未完成');continue;}
    const supply=sku.selectedSupplySnapshot?.supplierSku;
    for(const [key,actual] of [['goods',supply?.unitProductPrice],['freight',supply?.unitDomesticFreight],['other',supply?.otherPurchaseCosts],
      ['packaging',candidate.packagingCostRmb],['weight',supply?.weight?.unit==='kg'?supply.weight.value:null],...['length','width','height'].map(k=>[k,supply?.dimensions?.unit==='cm'?supply.dimensions[k]:null])]) {
      const requested=effective(draft.values,m,key);
      if(requested==='' || !Number.isFinite(Number(requested)) || actual==null || Number(requested)!==actual)add(m,key,'草稿供货成本或包装与本色正式确认不一致，须修订正式供货资料');
    }
    if(effective(draft.values,m,'route')!==candidate.lifecycleEvidenceContextV11?.route)add(m,'route','草稿线路与正式利润适用线路不一致');
    const profit=sku.profitModels?.find(p=>p.profitModelVersion===sku.activeProfitModelVersion);
    if(profit?.result!=='passed' || effective(draft.values,m,'price')==='' || Number(effective(draft.values,m,'price'))!==profit.recommendedSalePriceRub)add(m,'price','草稿目标售价与正式利润方案不一致，须完成正式利润或定价修订');
    const commercial=candidate.lifecycleV11?.productionCommercialDraftV1;
    if(commercial?.merchantSku!==m.merchantSku || effective(draft.values,m,'stock')==='' || Number(effective(draft.values,m,'stock'))!==commercial?.stock)add(m,'stock','草稿货号或库存与已保存商业版本不一致');
    const copy=c1CopyFields(sku.c1ProductPlan);
    for(const key of Object.keys(copy))if(effective(draft.values,m,key)!==copy[key])add(m,key,'编辑文案尚未进入已核验C1；须采用正式预览文案，或先完成现有语义复核与C1修订');
    const mappings=sku.ozonAttributeMappingsV1?.mappings??[];
    const broad=mappings.find(a=>String(a.attributeId)==='10096')?.value;
    const exact=mappings.find(a=>String(a.attributeId)==='10097')?.value;
    if(exact!==m.colorRu || JSON.stringify(Array.isArray(broad)?broad:[broad])!==JSON.stringify(m.platformColors))add(m,'color','草稿颜色名称或基础色与本色已核验C1属性不一致');
    const locked=sku.c2FinalAssets?.productionAuthorizationPreparation?.finalUploads;
    const bindings=new Map((draft.assetBindings??[]).map(a=>[a.assetId,a]));
    if(m.hero===null || m.hero!==m.order[0] || !Array.isArray(locked) || locked.length!==m.order.length || m.order.some((id,i)=>!bindings.has(id)||bindings.get(id).sha256!==locked[i]?.sha256 || i===0 && locked[i]?.role!=='main_image'))add(m,'images','主图、图片集合或顺序尚未与本色冻结最终素材一致');
  }
  return gaps;
}
export function assertSiblingPreparationMatchesFinal(args) {
  const gaps=siblingPreparationFinalGaps(args);
  if(gaps.length)throw Object.assign(new Error('SIBLING_PREPARATION_FINAL_MISMATCH'),{code:'SIBLING_PREPARATION_FINAL_MISMATCH',gaps});
}

export function assertSiblingPreparationImageSelection({parent,candidate,draft,assets}) {
  if(!draft)return;
  const m=draft.values?.members?.find(item=>item.candidateId===candidate.id),bindings=new Map((draft.assetBindings??[]).map(a=>[a.assetId,a]));
  if(draft.sourceRevision!==parent.dataRevision || draft.memberRevisions?.find(r=>r.candidateId===candidate.id)?.revision!==candidate.dataRevision ||
    !m || m.sourceSkuId!==candidate.siblingSourceV1?.supplierSkuId || m.hero===null || m.hero!==m.order[0] || !Array.isArray(assets) || assets.length!==m.order.length ||
    m.order.some((id,i)=>!bindings.has(id)||bindings.get(id).sha256!==assets[i]?.sha256 || bindings.get(id).onlySourceSkuId && bindings.get(id).onlySourceSkuId!==m.sourceSkuId)) {
    throw new Error('SIBLING_BATCH_C2_PREPARATION_IMAGES_MISMATCH');
  }
}
