const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Read-only family projection. It never turns shared evidence into a child conclusion. */
export function siblingBatchReview(parent, candidates) {
  const capture = parent?.sourceCapture;
  const selected = capture?.selectedSkuIds;
  const choices = capture?.skuChoices;
  if (!Array.isArray(selected) || !Array.isArray(choices) || !Array.isArray(candidates)) return null;
  const parentSkuId = parent.lifecycleV11?.skuPackage?.supplierSkuId;
  const siblings = candidates.filter(candidate => candidate.siblingSourceV1?.parentCandidateId === parent.id);
  const rows = selected.filter(id => id !== parentSkuId).map(sourceSkuId => {
    const matches = choices.filter(choice => choice.sourceSkuId === sourceSkuId);
    const children = siblings.filter(candidate => candidate.siblingSourceV1.supplierSkuId === sourceSkuId);
    const choice = matches.length === 1 ? matches[0] : null;
    const child = children.length === 1 ? children[0] : null;
    const sku = child?.lifecycleV11?.skuPackage;
    const preparation = child?.productionOwnerPreparation;
    const commercial = preparation?.commercialDraft;
    const gaps = [];
    if (!choice || !text(choice.attributes?.颜色)) gaps.push('供应颜色身份待核验');
    if (!child) gaps.push('内部规格记录未建立');
    else {
      if (!sku?.selectedSupplySnapshot?.ownerSupplyConfirmation ||
          sku.selectedSupplySnapshot.ownerSupplyConfirmation.status !== 'confirmed') gaps.push('A 供应规格及数量 1 证据待确认');
      const profit = sku?.profitModels?.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
      if (profit?.result !== 'passed' || !['exact', 'official_reference'].includes(profit?.commissionMode)) {
        gaps.push('B 当前店铺正式利润待完成');
      }
      if (!['facts_checked', 'seo_draft_ready'].includes(sku?.c1ProductPlan?.status)) {
        gaps.push('C1 本规格事实及官方颜色属性待确认');
      }
      if (!Array.isArray(sku?.c2FinalAssets?.productionAuthorizationPreparation?.finalUploads) ||
          sku.c2FinalAssets.productionAuthorizationPreparation.finalUploads.length === 0) {
        gaps.push('C2 本色最终素材及主图待确认');
      }
      if (sku?.productionConfirmationCard?.status !== 'awaiting_owner_business_confirmation') {
        gaps.push('最终商品确认卡待生成');
      }
      if (preparation?.ready !== true) {
        const details = preparation?.gaps;
        if (Array.isArray(details) && details.length > 0) {
          gaps.push(...details.map(item => item.message).filter(Boolean));
        } else gaps.push('生产价格、库存及店铺绑定待核验');
      }
      if (!text(commercial?.merchantSku) || !Number.isSafeInteger(commercial?.stock) || commercial.stock < 0) {
        if (preparation?.ready === true) gaps.push('商家货号或已保存库存缺失');
      }
      if (preparation?.ready === true && (!Number.isFinite(preparation.scope?.buyerTargetPrice?.amount) ||
          preparation.scope.buyerTargetPrice.currency !== 'RUB' ||
          !Number.isFinite(preparation.scope?.platformWritePrice?.amount) ||
          preparation.scope.platformWritePrice.currency !== 'CNY')) {
        gaps.push('正式 B 的 RUB 买家价或 CNY 后台写入价缺失');
      }
      if (commercial && preparation?.scope && commercial.stock !== preparation.scope.stock) {
        gaps.push('已保存库存与当前生产准备不一致');
      }
    }
    return { sourceSkuId, color: text(choice?.attributes?.颜色) || text(choice?.variantName) || '颜色待核验',
      candidateId: child?.id ?? null, status: gaps.length === 0 ? 'ready_for_batch_owner_review' : 'blocked', gaps,
      merchantSku: commercial?.merchantSku ?? null,
      buyerPriceRub: preparation?.scope?.buyerTargetPrice?.currency === 'RUB' ? preparation.scope.buyerTargetPrice.amount : null,
      writePriceCny: preparation?.scope?.platformWritePrice?.currency === 'CNY' ? preparation.scope.platformWritePrice.amount : null,
      stock: commercial?.stock ?? null };
  });
  const bindingLists = rows.map(row => siblings.find(candidate => candidate.id === row.candidateId)
    ?.productionOwnerPreparation?.executionBindings ?? []);
  const executionBindings = (bindingLists[0] ?? []).filter(binding => text(binding.bindingId) &&
    text(binding.configurationVersion) && text(binding.warehouseName) && bindingLists.every(list =>
    list.some(other => other.bindingId === binding.bindingId &&
      other.configurationVersion === binding.configurationVersion && other.warehouseName === binding.warehouseName)));
  if (rows.length > 0 && executionBindings.length === 0) {
    for (const row of rows) {
      if (row.candidateId && !row.gaps.some(gap => /仓库|绑定/.test(gap))) {
        row.gaps.push('本批所有规格没有共同有效仓库绑定');
        row.status = 'blocked';
      }
    }
  }
  return { parentCandidateId: parent.id, sourceRevision: parent.dataRevision,
    excludedSourceSkuIds: parentSkuId ? [parentSkuId] : [], rows, executionBindings,
    ready: rows.length > 0 && executionBindings.length > 0 &&
      rows.every(row => row.status === 'ready_for_batch_owner_review') };
}
