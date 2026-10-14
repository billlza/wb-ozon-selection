import { createLatestRead, optionalNumber } from './formState.js';

export function requiredPreparationNumber(value) {
  const number = optionalNumber(value);
  if (number === null) throw new Error('费用、包装、售价或库存仍有空白，不能按零提交');
  return number;
}

export const preparationWorkflowAvailable = status => status === 'configured' || status === 'unconfigured';

export function preparationValuesEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => preparationValuesEqual(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && preparationValuesEqual(left[key], right[key]));
}

/** Equal values only avoid a save when the persisted draft still describes this exact source scope. */
export function preparationDraftScopeCurrent(draft, parent, siblings, catalog) {
  if(!draft || !catalog || draft.parentCandidateId!==parent.id || draft.sourceRevision!==parent.dataRevision ||
    draft.catalogId!==catalog.catalogId || draft.catalogVersion!==catalog.version ||
    draft.memberRevisions.length!==catalog.supplierSkuIds.length)return false;
  const members=draft.memberRevisions.map(row=>siblings.find(candidate=>candidate.id===row.candidateId));
  return members.every((member,index)=>member && member.dataRevision===draft.memberRevisions[index].revision &&
    catalog.supplierSkuIds.includes(member.siblingSourceV1.supplierSkuId)) &&
    new Set(members.map(member=>member.siblingSourceV1.supplierSkuId)).size===catalog.supplierSkuIds.length;
}

const preparationRejectionStatus = new Map([
  ['SIBLING_PREPARATION_CATALOG_SCOPE', 422], ['SIBLING_PREPARATION_DRAFT_INVALID', 422],
  ['SIBLING_PREPARATION_INPUT_INVALID', 422], ['SIBLING_PREPARATION_VERSION_LIMIT', 422],
  ['SIBLING_PREPARATION_MEMBERS_CHANGED', 409], ['SIBLING_PREPARATION_SOURCE_CHANGED', 409],
  ['SIBLING_PREPARATION_DRAFT_CONFLICT', 409], ['SIBLING_PREPARATION_FROZEN', 409]
]);

function preparationDraftMatches(draft, input, catalog) {
  return draft !== null && typeof draft === 'object' &&
    draft.schemaVersion === 'sibling-preparation-draft-v1' && draft.parentCandidateId === input.parentCandidateId &&
    draft.sourceRevision === input.parentRevision && draft.idempotencyKey === input.idempotencyKey &&
    draft.draftRevision === input.expectedDraftRevision + 1 && draft.catalogId === catalog.catalogId &&
    draft.catalogVersion === catalog.version && draft.productionAuthorizationGranted === false &&
    preparationValuesEqual(draft.memberRevisions, input.memberRevisions) && preparationValuesEqual(draft.values, input.values);
}

/** One local editing session shares this coordinator across both draft-save entry points. */
export function createPreparationSaveState() {
  let pending = null;
  const zeroActions = response => response !== null && typeof response === 'object' &&
    response.externalRequests === 0 && response.platformWrites === 0;
  const matches = response => zeroActions(response) &&
    preparationDraftMatches(response.draft, pending.input, pending.catalog);
  return Object.freeze({
    get status() { return pending === null ? 'idle' : pending.status; },
    get pendingParentCandidateId() { return pending?.input.parentCandidateId ?? null; },
    begin(input, catalog) {
      if (pending !== null) throw new Error('上次草稿提交尚未核对，不能建立新的保存请求。请先只读核对保存版本。');
      if (!catalog || typeof catalog.catalogId !== 'string' || !Number.isSafeInteger(catalog.version)) {
        throw new Error('草稿素材目录尚未读取成功，不能保存。');
      }
      const request = Object.freeze({ input: structuredClone(input) });
      pending = { request, input: structuredClone(input),
        catalog: { catalogId: catalog.catalogId, version: catalog.version }, status: 'saving' };
      return request;
    },
    confirm(request, response) {
      if (pending === null || pending.request !== request) return false;
      if (!matches(response)) { pending.status = 'unknown'; return false; }
      pending = null;
      return true;
    },
    fail(request, error) {
      if (pending === null || pending.request !== request) return 'stale';
      if (zeroActions(error.body) && preparationRejectionStatus.has(error.body.code) &&
          error.status === preparationRejectionStatus.get(error.body.code)) {
        pending = null;
        return 'idle';
      }
      pending.status = 'unknown';
      return 'unknown';
    },
    reconcile(response) {
      if (pending === null) return 'none';
      if (pending.status === 'saving') return 'pending';
      if (zeroActions(response) && response.configured === true && response.catalog &&
          response.catalog.catalogId === pending.catalog.catalogId && response.catalog.version === pending.catalog.version && matches(response)) {
        pending = null;
        return 'confirmed';
      }
      return 'unknown';
    }
  });
}

/** Scope asynchronous reads and save receipts to one family and one editing version. */
export function createPreparationSession() {
  const reads = createLatestRead();
  let parentId, revision = 0, generation = 0, active = true;
  const current = token => active && token.parentId === parentId && token.generation === generation;
  return {
    select(id) { reads.cancel(); parentId = id; revision = 0; generation += 1; active = true; },
    capture() { return { parentId, revision, generation }; },
    current,
    unchanged(token) { return current(token) && token.revision === revision; },
    edited() { revision += 1; reads.cancel(); },
    cancelReads() { reads.cancel(); },
    dispose() { active = false; reads.cancel(); },
    async read(request, publish) {
      const token = this.capture();
      return reads.run(request, result => { if (this.unchanged(token)) publish(result); });
    }
  };
}

export function createPreparationValues(catalog, parent, siblings, supplyPreparation = null) {
  const draft=parent.supplierDraftV1;
  const inherited=supplyPreparation ? {
    goods:String(draft?.goodsPriceRmb??''),freight:String(draft?.domesticShippingRmb??''),
    weight:String(draft?.packedWeightKg??''),price:String(draft?.targetSalePriceRub??''),
    length:String(draft?.dimensionsCm?.length??''),width:String(draft?.dimensionsCm?.width??''),height:String(draft?.dimensionsCm?.height??''),
    packaging:String(parent.packagingCostRmb??''),route:parent.lifecycleEvidenceContextV11?.route??catalog.defaults.route
  } : {};
  return { page: 0, supplyReviewed: false, shared: { ...catalog.defaults,...inherited,
    other: supplyPreparation?.otherPurchaseCosts == null ? '' : String(supplyPreparation.otherPurchaseCosts),
    quantityOneEvidenceSourceNote: supplyPreparation?.quantityOneEvidenceSourceNote ?? '' }, members: catalog.supplierSkuIds.map(sourceSkuId => {
    const child = siblings.find(c=>c.siblingSourceV1?.supplierSkuId===sourceSkuId);
    const color = catalog.colors[sourceSkuId];
    const reusedPrice=supplyPreparation?.rows.find(r=>r.sourceSkuId===sourceSkuId)?.unitProductPrice;
    return { candidateId: child.id, sourceSkuId, colorRu: color.colorRu, platformColors: [...color.platformColors],
      merchantSku: child.lifecycleV11?.productionCommercialDraftV1?.merchantSku ?? `OZ-1688-${catalog.offerId}-${sourceSkuId}`,
      overrides: reusedPrice != null ? {goods:String(reusedPrice)} : {},
      order: [...color.defaultOrder], hero: null };
  }) };
}
const copyKeys=['titleRu','titleZh','descriptionRu','descriptionZh','bulletRu','bulletZh'];
export const effectivePreparationValue = (values,member,key) => member.overrides[key] === undefined || member.overrides[key] === '' && !copyKeys.includes(key) ? values.shared[key] : member.overrides[key];
export function adoptPreparationCopy(values,copies) {
  const next=structuredClone(values);
  for(const key of copyKeys){const all=next.members.map(m=>copies.find(c=>c.candidateId===m.candidateId)?.fields[key]);
    if(all.every(v=>v!==undefined && v===all[0])){next.shared[key]=all[0];for(const m of next.members)delete m.overrides[key];}
    else for(const m of next.members){const value=copies.find(c=>c.candidateId===m.candidateId)?.fields[key];if(value!==undefined)m.overrides[key]=value;}
  }return next;
}
export function changePreparationImage(values,catalog,sourceSkuId,assetId,selected) {
  const next=structuredClone(values), member=next.members.find(m=>m.sourceSkuId===sourceSkuId), asset=catalog.assets.find(a=>a.assetId===assetId);
  if(!member || !asset || asset.onlySourceSkuId && asset.onlySourceSkuId!==sourceSkuId)throw new Error('本色图片身份不符');
  if(selected && !member.order.includes(assetId)){if(member.order.length>=20)throw new Error('最多选择20张');member.order.push(assetId);}
  if(!selected){member.order=member.order.filter(id=>id!==assetId);if(member.hero===assetId)member.hero=null;}
  return next;
}
export function setPreparationHero(values,sourceSkuId,assetId) {
  const next=structuredClone(values), member=next.members.find(m=>m.sourceSkuId===sourceSkuId);
  if(!member?.order.includes(assetId))throw new Error('请先选择这张图片');
  member.order=member.order.filter(id=>id!==assetId);member.order.unshift(assetId);member.hero=assetId;return next;
}
export function movePreparationImage(values,sourceSkuId,assetId,direction) {
  const next=structuredClone(values), member=next.members.find(m=>m.sourceSkuId===sourceSkuId);
  const i=member?.order.indexOf(assetId), j=i+direction;
  if(!member || ![-1,1].includes(direction) || i<0)throw new Error('图片排序输入无效');
  if(j<0 || j>=member.order.length)return next;
  [member.order[i],member.order[j]]=[member.order[j],member.order[i]];
  if(member.hero!==null)member.hero=member.order[0];return next;
}
export function batchPreparationFunctions(values,catalog,selected) {
  const candidates=catalog.functionalAssetIds?catalog.functionalAssetIds.map(id=>catalog.assets.find(a=>a.assetId===id)).filter(Boolean):catalog.assets.filter(a=>a.functionalCandidate);
  return values.members.reduce((next,m)=>candidates.reduce((v,a)=>changePreparationImage(v,catalog,m.sourceSkuId,a.assetId,selected),next),values);
}
