const skuText = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const numericSourceId = value => skuText(value) && /^\d+$/.test(value);

/** Suggestions only. The saved parent authorization is the naming anchor, not a new platform claim. */
export function siblingMerchantSkuSuggestions(parent, rows) {
  const firstSkuId = parent.lifecycleV11?.skuPackage?.supplierSkuId;
  const sku = parent.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization;
  // The repository restores stored entity references before /api/state reaches this page.
  const authorizationScope = authorization?.lockedScope;
  const decisionSku = sku?.productionConfirmationCard?.ownerDecision?.merchantSku;
  const handoff = sku?.dHandoff;
  const handoffSku = handoff?.identity?.merchantSku;
  const savedDraftSku = parent.lifecycleV11?.productionCommercialDraftV1?.merchantSku;
  const offerId = parent.sourceCapture?.offerId;
  const store = parent.storeRef;
  const frozenStore = handoff?.identity?.storeRef;
  if (!numericSourceId(firstSkuId) || !numericSourceId(offerId) ||
      !['production-authorization-v1.1', 'production-authorization-v1.2'].includes(authorization?.schemaVersion) ||
      authorization.status !== 'confirmed' ||
      !skuText(authorization.authorizationId) || authorization.authorizationId !== handoff?.productionAuthorizationId ||
      authorizationScope?.candidateId !== parent.id ||
      authorizationScope?.skuPackageId !== sku.skuPackageId ||
      authorizationScope?.supplierSkuId !== firstSkuId ||
      authorizationScope?.platform !== parent.targetPlatform ||
      authorizationScope?.storeRef?.stableStoreId !== store?.stableStoreId ||
      authorizationScope?.storeRef?.platformStoreId !== store?.platformStoreId ||
      authorization.identity?.candidateId !== parent.id ||
      authorization.identity?.skuPackageId !== sku.skuPackageId ||
      authorization.identity?.supplierSkuId !== firstSkuId ||
      authorization.identity?.platform !== parent.targetPlatform ||
      authorization.identity?.storeRef?.stableStoreId !== store?.stableStoreId ||
      authorization.identity?.storeRef?.platformStoreId !== store?.platformStoreId ||
      !skuText(decisionSku) || !skuText(handoffSku) ||
      authorizationScope?.merchantSku !== decisionSku ||
      authorization?.identity?.merchantSku !== handoffSku ||
      handoff?.candidateId !== parent.id || handoff?.skuPackageId !== sku.skuPackageId ||
      handoff.identity.supplierSkuId !== firstSkuId ||
      parent.targetPlatform !== 'ozon' || handoff.identity.platform !== parent.targetPlatform ||
      !skuText(store?.stableStoreId) || !skuText(store?.platformStoreId) ||
      store.stableStoreId !== frozenStore?.stableStoreId ||
      store.platformStoreId !== frozenStore?.platformStoreId ||
      parent.supplierDraftV1?.offerId !== offerId ||
      decisionSku !== handoffSku ||
      (savedDraftSku !== undefined && savedDraftSku !== handoffSku) ||
      handoffSku !== `OZ-1688-${offerId}-${firstSkuId}`) {
    throw new Error('首件冻结货号或来源身份不完整、不一致，无法建议本批商家货号；请先核对首件授权和 1688 来源。');
  }
  const ids = rows.map(row => row.sourceSkuId);
  if (!Array.isArray(parent.sourceCapture.selectedSkuIds) || ids.length === 0 ||
      ids.some(id => !numericSourceId(id) || id === firstSkuId ||
      !parent.sourceCapture.selectedSkuIds.includes(id)) || new Set(ids).size !== ids.length) {
    throw new Error('本批供应 SKU 身份缺失、重复或与首件相同，无法建议商家货号。');
  }
  return Object.fromEntries(ids.map(id => [id, `OZ-1688-${offerId}-${id}`]));
}

export function siblingBatchMemberDefaults(sourceSkuId, merchantSkus) {
  return { targetSalePriceRub: '', merchantSku: merchantSkus?.[sourceSkuId] ?? '', stock: '100' };
}
