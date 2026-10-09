import { createInitialCandidate } from './candidate-initialization.mjs';
import { currentSalesSnapshot } from './discovery-market-snapshot.mjs';
import { normalizeSupplierCaptureSource } from './source-capture.mjs';
import { inForceSkuUniformSupply } from './sku-choice-estimate.mjs';
import { isCompleteStoreRef, sameStoreRef, STORE_PLATFORMS } from './store-binding.mjs';
import { parentCardBinding } from './sibling-sku-card-guard.mjs';
import { siblingSkuCandidateName, SiblingSkuCandidateError } from './sibling-sku-name.mjs';
import { validateSalesSnapshot } from './sales-snapshot.mjs';

export { siblingSkuCandidateName, SiblingSkuCandidateError } from './sibling-sku-name.mjs';

const fail = (code, message) => { throw new SiblingSkuCandidateError(code, message); };
const text = value => typeof value === 'string' ? value.trim() : '';

export function siblingSkuCandidateInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['dataRevision', 'supplierSkuId', 'productName'].includes(key)) ||
      !Number.isSafeInteger(value.dataRevision) || value.dataRevision < 1 ||
      text(value.supplierSkuId) !== value.supplierSkuId || !/^[1-9][0-9]{0,39}$/.test(value.supplierSkuId) ||
      (value.productName !== undefined && (text(value.productName) !== value.productName ||
        value.productName.length > 200 || value.productName.length === 0 ||
        /[\u0000-\u001f\u007f]/u.test(value.productName)))) {
    fail('SIBLING_INPUT_INVALID', '追加规格必须提供当前修订和精确供应 SKU');
  }
  return value;
}

/** A new single-SKU A branch. Every B/C1/C2/D record must be created by that branch's normal use cases. */
export function createSiblingSkuCandidate({ document, parentCandidateId, input, id, timestamp, storeBindings }) {
  siblingSkuCandidateInput(input);
  const candidates = document?.candidates;
  if (!Array.isArray(candidates)) fail('SIBLING_DOCUMENT_INVALID', '候选记录不可用');
  const parent = candidates.find(candidate => candidate.id === parentCandidateId);
  if (!parent) fail('SIBLING_PARENT_MISSING', '原商品不存在');
  const existing = candidates.find(candidate => candidate.siblingSourceV1?.parentCandidateId === parentCandidateId &&
    candidate.siblingSourceV1?.supplierSkuId === input.supplierSkuId);
  if (existing) {
    if (existing.siblingSourceV1.parentRevision !== input.dataRevision ||
        (input.productName !== undefined && existing.productName !== input.productName)) {
      fail('SIBLING_REPLAY_CONFLICT', '该供应 SKU 已按另一份输入建立候选，请打开已有候选');
    }
    return { candidate: existing, created: false };
  }
  if (parent.dataRevision !== input.dataRevision) fail('SIBLING_PARENT_CHANGED', '原商品已更新，请刷新后重新核对规格');
  if (!isCompleteStoreRef(parent.storeRef, parent.targetStore)) fail('SIBLING_STORE_INVALID', '原商品店铺身份无效');
  if (parent.lifecycleV11?.skuPackage?.supplierSkuId === input.supplierSkuId) {
    fail('SIBLING_PARENT_SKU_REJECTED', '这个供应 SKU 已属于原商品，不能重新建卡或重发');
  }
  const parentSku = parent.lifecycleV11?.skuPackage;
  if (!parentSku || parentSku.selectedSupplySnapshot?.ownerSupplyConfirmation?.status !== 'confirmed' ||
      !parentSku.dSoftwareExecution?.checkpoints?.some(checkpoint => checkpoint.kind === 'import_task_received')) {
    fail('SIBLING_PARENT_IMPORT_UNVERIFIED', '原商品尚无已接受导入的持久回执');
  }
  const capture = parent.sourceCapture;
  const source = normalizeSupplierCaptureSource(capture?.sourceUrl);
  if (capture?.mode !== 'a_supplier_capture' || capture.status !== 'captured_waiting_owner_selection' ||
      source.type !== 'detail' || source.offerId !== capture.offerId || !text(capture.captureId) ||
      !Array.isArray(capture.selectedSkuIds) || !capture.selectedSkuIds.includes(input.supplierSkuId) ||
      !Array.isArray(capture.skuChoices)) {
    fail('SIBLING_CAPTURE_INVALID', '原商品没有覆盖目标 SKU 的有效采集与主人选择');
  }
  const choices = capture.skuChoices.filter(choice => String(choice.sourceSkuId) === input.supplierSkuId);
  if (choices.length !== 1) fail('SIBLING_SKU_IDENTITY_INVALID', '目标 SKU 在采集记录中不是唯一规格');
  const productName = siblingSkuCandidateName(parent, choices[0]);
  if (input.productName !== undefined && input.productName !== productName) {
    fail('SIBLING_NAME_CONFLICT', '商品名称由已采集规格生成，请刷新页面后重新建立');
  }
  const sales = currentSalesSnapshot(parent);
  if (!sales) fail('SIBLING_MARKET_EVIDENCE_MISSING', '原商品没有可复用的有效市场快照');
  const salesSnapshots = parent.salesSnapshotsV11.filter(snapshot => validateSalesSnapshot(snapshot).valid);
  const uniform = inForceSkuUniformSupply(parent);
  if (!uniform || !uniform.sourceSkuIds.includes(input.supplierSkuId) ||
      uniform.captureId !== capture.captureId || !parent.supplierDraftV1 ||
      parent.supplierDraftV1.offerId !== capture.offerId ||
      uniform.basisAtDeclaration?.goodsPriceRmb !== parent.supplierDraftV1.goodsPriceRmb ||
      uniform.basisAtDeclaration?.packedWeightKg !== parent.supplierDraftV1.packedWeightKg) {
    fail('SIBLING_OWNER_DECLARATION_MISSING', '目标 SKU 缺少当前采集对应的同重同价主人声明');
  }
  let grouping;
  try { grouping = parentCardBinding(parentSku, document); }
  catch (error) {
    if (error.message === 'SIBLING_PARENT_CARD_BINDING_MISSING' ||
        error.message.startsWith('SIBLING_PARENT_IMPORT_ATTRIBUTE_AMBIGUOUS:')) {
      fail('SIBLING_PARENT_CARD_BINDING_MISSING', '原商品导入请求缺少可核对的同卡型号、类目或图片来源');
    }
    throw error;
  }
  const child = createInitialCandidate({
    input: { targetStore: parent.targetStore, productName, sourceUrl: source.sourceUrl,
      productUrl: sales.productUrl, group: parent.group },
    source: 'user', id, timestamp, storeBindings
  });
  if (!sameStoreRef(child.storeRef, parent.storeRef)) fail('SIBLING_STORE_CHANGED', '店铺映射已变化，请先核对当前店铺');
  child.targetPlatform = STORE_PLATFORMS[parent.targetStore];
  child.siblingSourceV1 = {
    schemaVersion: 'sibling-sku-source-v1', parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    supplierSkuId: input.supplierSkuId, captureId: capture.captureId, salesSnapshotId: sales.snapshotId,
    ownerDeclarationRef: uniform.sourceRef, parentCardBinding: grouping
  };
  child.salesSnapshotsV11 = structuredClone(salesSnapshots);
  child.sourceCapture = {
    captureId: capture.captureId, status: 'captured_waiting_owner_selection', mode: 'a_supplier_capture',
    jobId: null, jobStatus: null, sourceUrl: source.sourceUrl, offerId: capture.offerId,
    title: capture.title, observedAt: capture.observedAt, collectionMethod: capture.collectionMethod,
    titleSource: capture.titleSource, offerIdSource: capture.offerIdSource,
    priceRanges: structuredClone(capture.priceRanges ?? []), pageFields: structuredClone(capture.pageFields ?? {}),
    supplierAttributes: structuredClone(capture.supplierAttributes ?? {}), skuChoices: structuredClone(choices),
    selectedSkuIds: [], ownerSupplyConfirmed: false, writeOccurred: false, businessStateEffect: 'unchanged'
  };
  child.supplierDraftV1 = structuredClone(parent.supplierDraftV1);
  child.skuUniformSupplyV1 = structuredClone(uniform);
  child.purchasePriceRmb = child.supplierDraftV1.allInPurchaseRmb;
  child.domesticShippingRmb = child.supplierDraftV1.domesticShippingRmb;
  child.packedWeightKg = child.supplierDraftV1.packedWeightKg;
  child.dimensionsCm = structuredClone(child.supplierDraftV1.dimensionsCm);
  child.expectedPriceRub = child.supplierDraftV1.targetSalePriceRub;
  child.notes = '同款独立规格；市场快照、采集和同重同价声明按来源引用。供应确认、利润、文案、素材、授权和导入须在本规格独立完成。';
  candidates.unshift(child);
  return { candidate: child, created: true };
}

/** Prepare the owner's selected variants in one atomic candidate mutation. */
export function createSiblingSkuCandidatesBatch({ document, parentCandidateId, input, nextId, timestamp, storeBindings }) {
  if (!input || Object.keys(input).sort().join() !== 'dataRevision,supplierSkuIds' ||
      !Number.isSafeInteger(input.dataRevision) || input.dataRevision < 1 ||
      !Array.isArray(input.supplierSkuIds) || input.supplierSkuIds.length === 0 ||
      new Set(input.supplierSkuIds).size !== input.supplierSkuIds.length ||
      input.supplierSkuIds.some(supplierSkuId => typeof supplierSkuId !== 'string' ||
        !/^[1-9][0-9]{0,39}$/.test(supplierSkuId)) || typeof nextId !== 'function') {
    fail('SIBLING_BATCH_INPUT_INVALID', '请提交当前修订及不重复的精确供应规格');
  }
  const draft = structuredClone(document);
  const results = input.supplierSkuIds.map(supplierSkuId => createSiblingSkuCandidate({
    document: draft, parentCandidateId, input: { dataRevision: input.dataRevision, supplierSkuId },
    id: nextId(draft.candidates), timestamp, storeBindings
  }));
  document.candidates = draft.candidates;
  return { candidates: results.map(result => result.candidate),
    createdIds: results.filter(result => result.created).map(result => result.candidate.id),
    createdCount: results.filter(result => result.created).length };
}
