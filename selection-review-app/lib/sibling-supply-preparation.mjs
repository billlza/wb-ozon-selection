import { STORE_PLATFORMS, sameStoreRef, isCompleteStoreRef } from './store-binding.mjs';
import { inForceSkuUniformSupply } from './sku-choice-estimate.mjs';
import { quantityOneEvidenceNote } from './profit-step-review.mjs';

/** Legacy sibling records omitted this field. Resolve only within the verified family. */
export function siblingPlatform(parent, child) {
  const platform = STORE_PLATFORMS[parent.targetStore];
  if (!platform || parent.targetPlatform !== platform || !isCompleteStoreRef(parent.storeRef,parent.targetStore) || child.targetStore !== parent.targetStore ||
      typeof parent.sourceCapture?.captureId !== 'string' || !parent.sourceCapture.captureId.trim() ||
      typeof parent.sourceCapture?.offerId !== 'string' || !parent.sourceCapture.offerId.trim() ||
      !sameStoreRef(child.storeRef, parent.storeRef) ||
      child.siblingSourceV1?.parentCandidateId !== parent.id ||
      child.sourceCapture?.captureId !== parent.sourceCapture?.captureId ||
      child.sourceCapture?.offerId !== parent.sourceCapture?.offerId ||
      Object.hasOwn(child, 'targetPlatform') && child.targetPlatform !== platform ||
      child.lifecycleV11?.skuPackage?.targetPlatform && child.lifecycleV11.skuPackage.targetPlatform !== platform ||
      [parent,child].some(c => c.lifecycleV11?.skuPackage?.g1Identity?.platform !== undefined && c.lifecycleV11.skuPackage.g1Identity.platform !== platform)) {
    throw new Error('SIBLING_PLATFORM_IDENTITY_CONFLICT');
  }
  return platform;
}

/** Rebuild from captured offer quotes, never from another SKU's frozen confirmation. */
export function siblingSupplyPreparation(parent, members) {
  const capture = parent.sourceCapture;
  const draft = parent.supplierDraftV1;
  const uniform = inForceSkuUniformSupply(parent);
  const declared = uniform && uniform.basisAtDeclaration?.goodsPriceRmb === draft?.goodsPriceRmb &&
    uniform.basisAtDeclaration?.packedWeightKg === draft?.packedWeightKg;
  const gaps = [];
  const rows = members.map(child => {
    siblingPlatform(parent, child);
    const sourceSkuId = child.siblingSourceV1.supplierSkuId;
    const choices = Array.isArray(capture.skuChoices) ? capture.skuChoices.filter(c => c.sourceSkuId === sourceSkuId) : [];
    const choice = choices.length === 1 ? choices[0] : null;
    const capturedPrice = Number.isFinite(choice?.priceCny) && choice.priceCny > 0;
    const mayDeclare = declared && uniform.sourceSkuIds.includes(sourceSkuId);
    const priceCny = capturedPrice ? choice.priceCny : mayDeclare ? draft.goodsPriceRmb : null;
    const note = choice && quantityOneEvidenceNote({ capture, sku: {
      ...choice, priceCny, priceBasis: capturedPrice ? 'captured' : 'owner_declared'
    }, label: `${choice.attributes?.颜色 ?? sourceSkuId}（供应SKU ${sourceSkuId}）` });
    if (!note) gaps.push({ candidateId: child.id, message: '本规格缺少当前采集的一件起订报价或有效同价依据；不能沿用其他颜色的确认。' });
    return { candidateId: child.id, sourceSkuId, unitProductPrice: priceCny,
      quantityOneEvidenceSourceNote: note, ownerSupplyConfirmed: false };
  });
  const snapshot = parent.lifecycleV11?.skuPackage?.selectedSupplySnapshot;
  const components = snapshot?.supplierSku?.attributes?.purchaseCostComponents;
  const sameSource = snapshot?.supplierOption?.offerId === capture.offerId &&
    snapshot?.supplierSku?.attributes?.quantityOneEvidence?.captureId === capture.captureId &&
    snapshot?.ownerSupplyConfirmation?.status === 'confirmed' && draft?.offerId === capture.offerId &&
    components?.currency === 'CNY' && ['unitProductPrice', 'unitDomesticFreight', 'otherPurchaseCosts', 'actualPurchaseCost']
      .every(k => Number.isFinite(components[k]) && components[k] >= 0) &&
    Math.abs(components.unitProductPrice + components.unitDomesticFreight + components.otherPurchaseCosts - components.actualPurchaseCost) < 0.000001 &&
    components.unitProductPrice === draft.goodsPriceRmb && components.unitDomesticFreight === draft.domesticShippingRmb &&
    components.actualPurchaseCost === draft.allInPurchaseRmb && typeof snapshot.snapshotId === 'string';
  return { parentCandidateId: parent.id, sourceRevision: parent.dataRevision, captureId: capture.captureId,
    offerId: capture.offerId, declarationRef: declared ? uniform.sourceRef : null,
    costSourceRef: sameSource ? snapshot.snapshotId : null,
    otherPurchaseCosts: sameSource ? components.otherPurchaseCosts : null,
    rows, gaps, quantityOneEvidenceSourceNote: gaps.length ? '' :
      `依据当前采集 ${capture.captureId}（商品 ${capture.offerId}）的逐规格一件报价与有效价格来源，待本次确认：${rows.map(r => r.sourceSkuId).join('、')}。` };
}
