import { createPreparationSaveState } from '../../src/siblingPreparationState.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SiblingBatchPreparation from '../../src/components/SiblingBatchPreparation.jsx';
import '../../src/styles.css';
import fixture from './sibling-batch-browser-data.json';

const firstSkuId = '6222816678021';
const offerId = '1038877014153';
const merchantSku = `OZ-1688-${offerId}-${firstSkuId}`;
const colors = [['6222816678023', '黑cp'], ['6222816678020', 'CP'], ['6222816678019', '黑色']];
const storeRef = { stableStoreId: 'synthetic-store', platformStoreId: 'synthetic-seller' };
const aParent = {
  id: 'candidate:synthetic-a-parent', dataRevision: 12, targetPlatform: 'ozon', storeRef,
  supplierDraftV1: { offerId, goodsPriceRmb: 18, packedWeightKg: 0.2, targetSalePriceRub: 848,
    domesticShippingRmb: 6.5, dimensionsCm: { length: 25, width: 35, height: 2 } },
  sourceCapture: { offerId, selectedSkuIds: [firstSkuId, ...colors.map(([id]) => id)],
    skuChoices: [[firstSkuId, '卡其色'], ...colors].map(([sourceSkuId, color]) => ({
      sourceSkuId, attributes: { 颜色: color }, priceCny: 18, weightKg: 0.2 })) },
  lifecycleV11: { productionCommercialDraftV1: { merchantSku }, skuPackage: {
    skuPackageId: 'sku:synthetic-first', supplierSkuId: firstSkuId,
    productionAuthorization: { schemaVersion: 'production-authorization-v1.2', authorizationId: 'auth:synthetic',
      status: 'confirmed', identity: { candidateId: 'candidate:synthetic-a-parent', skuPackageId: 'sku:synthetic-first',
        platform: 'ozon', storeRef, supplierSkuId: firstSkuId, merchantSku },
      lockedScope: { candidateId: 'candidate:synthetic-a-parent', skuPackageId: 'sku:synthetic-first',
        platform: 'ozon', storeRef, supplierSkuId: firstSkuId, merchantSku } },
    productionConfirmationCard: { ownerDecision: { merchantSku } },
    dHandoff: { candidateId: 'candidate:synthetic-a-parent', skuPackageId: 'sku:synthetic-first',
      productionAuthorizationId: 'auth:synthetic',
      identity: { platform: 'ozon', storeRef, supplierSkuId: firstSkuId, merchantSku } } } }
};
const aSiblings = colors.map(([sourceSkuId, color]) => ({ id: `candidate:synthetic-${sourceSkuId}`,
  dataRevision: 1, siblingSourceV1: { parentCandidateId: aParent.id, supplierSkuId: sourceSkuId },
  realAConfirmationCard: { salesReview: { snapshotId: 'sales:synthetic', title: `合成背心 ${color}` } } }));

function AFormFixture() {
  const [preparationSaveState]=useState(createPreparationSaveState);
  const [payload, setPayload] = useState(null);
  return <main className="page-panel" style={{ maxWidth: 1320, margin: '24px auto', padding: 16 }}>
    <h1>合成三色批次 A 表单</h1>
    <SiblingBatchPreparation preparationSaveState={preparationSaveState} parent={aParent} siblings={aSiblings} onConfirmA={value => {
      setPayload(value); return Promise.resolve({ saved: false }); }} />
    {payload ? <pre id="a-payload">{JSON.stringify(payload, null, 2)}</pre> : null}
  </main>;
}

function BrowserFixture() {
  const [preparationSaveState]=useState(createPreparationSaveState);
  const [siblings, setSiblings] = useState(fixture.siblings);
  const [executionView, setExecutionView] = useState(null);
  const [authorizationInput, setAuthorizationInput] = useState(null);
  const [stockSaveCount, setStockSaveCount] = useState(0);
  const parent = fixture.parent;
  function saveStockDrafts(payload) {
    setSiblings(current => current.map(candidate => {
      const member = payload.members.find(item => item.candidateId === candidate.id);
      if (!member) throw new Error('浏览器夹具成员缺失');
      const next = structuredClone(candidate);
      next.dataRevision += 1;
      next.lifecycleV11.productionCommercialDraftV1.stock = member.stock;
      next.productionOwnerPreparation.commercialDraft.stock = member.stock;
      next.productionOwnerPreparation.scope.stock = member.stock;
      next.productionOwnerPreparation.source.dataRevision = next.dataRevision;
      return next;
    }));
    setStockSaveCount(value => value + 1);
    return Promise.resolve({ members: payload.members });
  }
  function authorize(input) {
    setAuthorizationInput(input);
    setExecutionView({ batchId: 'd-batch:synthetic-browser', status: 'observing', externalRequestState: 'unknown_outcome',
      excludedOfferIds: input.excludedOfferIds,
      members: input.members.map((member, index) => ({ candidateId: member.candidateId,
        offerId: member.ownerInput.merchantSku, importStatus: index === 1 ? 'unknown_outcome' : 'imported',
        importGapCode: index === 1 ? 'synthetic_unknown' : null,
        inventoryStatus: index === 0 ? 'awaiting_prerequisites' : 'not_started', inventoryReason: null,
        eStatus: index === 2 ? 'needs_owner' : 'not_started', eGaps: index === 2 ? ['synthetic_readback_gap'] : [],
        listedVerified: false })) });
    return Promise.resolve({ batch: { members: input.members } });
  }
  return <main><h1>合成三色批次最终确认</h1>
    <p id="stock-save-count">库存草稿保存次数：{stockSaveCount}</p>
    <SiblingBatchPreparation preparationSaveState={preparationSaveState} parent={parent} siblings={siblings} onAuthorize={authorize}
      onSaveStockDrafts={saveStockDrafts} executionView={executionView}
      onRefreshExecution={() => Promise.resolve(executionView)} onResumeStock={() => Promise.resolve(executionView)} />
    {authorizationInput ? <pre id="authorized-payload">{JSON.stringify(authorizationInput)}</pre> : null}
  </main>;
}

createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).get('view') === 'a'
  ? <AFormFixture /> : <BrowserFixture />);
