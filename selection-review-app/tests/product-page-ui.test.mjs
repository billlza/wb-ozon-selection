import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { finalAssets } from './helpers/c2-software-fixture.mjs';
import { siblingColorState } from './fixtures/sibling-color-state.mjs';

// The product page renders synthetic display data only: no saved records, no services, no requests.
let renderer;
async function pageModule() {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./product-page-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'product-page-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import {createPreparationSaveState} from ${JSON.stringify(fileURLToPath(new URL('../src/siblingPreparationState.js',import.meta.url)))};
      import Page, {stepNotice, thresholdBasisLine, captureStatusLine, captureNeedsOwnerReview, captureReviewPayload,
        captureRecaptureReady, captureRecaptureConfirmLine, captureRecapturePayload, CAPTURE_RECAPTURE_REASONS,
        currentProductStep, skuChoiceReady, skuChoiceSaved, showsSkuChoice, skuChoiceHeadline, skuChoiceSwing,
        skuChoiceSummary, selectAllState, skuChoicePayload, skuWeightGapNotice, skuUniformSupplyNotice,
        skuUniformSupplyPayload, foldedStepLine, foldedStepState,
        profitStepOpen, profitStepFirstSkuId, profitStepThresholdLine, profitStepCohortHeadline, profitStepExcludedLine,
        profitStepSuggestionLine, profitStepPriceDeltaLine, profitStepCommissionLine, profitStepSubmitState,
        profitStepOutcomeLine, cargoFactsFormState, cargoFactsPayload, cargoFactsStepGaps, cargoFactsHeadline,
        ozonCategoryStepGaps, ozonPageReadOutcomeLine, productStepPassed, extraHandlingFeesFormState,
        extraHandlingFeesPayload, extraHandlingFeesFormErrors, extraHandlingFeesFormTotal, extraHandlingFeesStepGaps,
        extraHandlingFeeBreakLine, extraHandlingFeeAppliedLine, CommissionEstimateBlock} from ${JSON.stringify(component)};
      export {stepNotice, thresholdBasisLine, captureStatusLine, captureNeedsOwnerReview, captureReviewPayload,
        captureRecaptureReady, captureRecaptureConfirmLine, captureRecapturePayload, CAPTURE_RECAPTURE_REASONS,
        currentProductStep, skuChoiceReady, skuChoiceSaved, showsSkuChoice, skuChoiceHeadline, skuChoiceSwing,
        skuChoiceSummary, selectAllState, skuChoicePayload, skuWeightGapNotice, skuUniformSupplyNotice,
        skuUniformSupplyPayload, foldedStepLine, foldedStepState,
        profitStepOpen, profitStepFirstSkuId, profitStepThresholdLine, profitStepCohortHeadline, profitStepExcludedLine,
        profitStepSuggestionLine, profitStepPriceDeltaLine, profitStepCommissionLine, profitStepSubmitState,
        profitStepOutcomeLine, cargoFactsFormState, cargoFactsPayload, cargoFactsStepGaps, cargoFactsHeadline,
        ozonCategoryStepGaps, ozonPageReadOutcomeLine, productStepPassed, extraHandlingFeesFormState,
        extraHandlingFeesPayload, extraHandlingFeesFormErrors, extraHandlingFeesFormTotal, extraHandlingFeesStepGaps,
        extraHandlingFeeBreakLine, extraHandlingFeeAppliedLine};
      export const render=props=>renderToStaticMarkup(<Page preparationSaveState={createPreparationSaveState()} {...props}/>);
      export const renderCommissionEstimate=props=>renderToStaticMarkup(<CommissionEstimateBlock {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer;
}
async function render(props) {
  return (await pageModule()).render(props);
}

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const candidate = (extra = {}) => ({
  id: 'candidate:synthetic-product-page', dataRevision: 4, targetStore: 'miska', targetPlatform: 'ozon',
  productName: 'Explicitly synthetic organizer', imageUrl: 'https://images.example.test/synthetic-organizer.png',
  storeRef: { stableStoreId: 'miska', platformStoreId: 'synthetic-seller', mappingVersion: 'synthetic-stores-v1' },
  workflowStatus: 'codex_processing', sourceUrl: '', purchasePriceRmb: 18.86, domesticShippingRmb: 2.96,
  packedWeightKg: 1.3, dimensionsCm: { length: 75, width: 21, height: 4 }, ...extra
});
const marketSnapshot = {
  schemaVersion: 'sales-snapshot-v1.1', snapshotId: 'sales-snapshot:seerfar_category_detail:synthetic',
  source: 'seerfar_category_detail', currentPrice: 1850, currency: 'RUB', collectedAt: '2026-09-10T06:30:00.000Z',
  marketMetrics: { salesCount: 330, salesWindow: null, revenue: 610500, reviewCount: 371, reviewRating: 4.7 }
};
const draft = {
  schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: '2026-09-11T02:00:00.000Z',
  sourceUrl: 'https://detail.1688.com/offer/876240928352.html', sourceUrlType: 'detail', offerId: '876240928352',
  goodsPriceRmb: 15.9, domesticShippingRmb: 2.96, allInPurchaseRmb: 18.86, packedWeightKg: 1.3,
  dimensionsCm: { length: 75, width: 21, height: 4 }, targetSalePriceRub: 1850, note: null, provenance: 'owner_declared'
};
const blockedEstimate = {
  schemaVersion: 'supplier-draft-estimate-v1', estimatedAt: '2026-09-11T02:00:01.000Z',
  estimate: { status: 'incomplete', missing: ['可行物流线路'], freight: { status: 'no_feasible_route' }, commission: { rate: 0.14 }, ceiling: null },
  profitAtDeclaredPurchase: null,
  routeBlock: { code: 'no_feasible_route', message: '当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米，或按大件重量（≥2.001 公斤）重新申报。',
    foldSideMaxCm: 60, bigParcelMinKg: 2.001,
    routes: [{ route: 'GUOO Economy Small', reason: 'side_outside_limit', detail: '单边最大 60 厘米，当前最长边 75 厘米' },
      { route: 'GUOO Economy Big', reason: 'weight_outside_limit', detail: '可走 2.001-30 公斤，当前 1.3 公斤' }] }
};
const okEstimate = {
  schemaVersion: 'supplier-draft-estimate-v1', estimatedAt: '2026-09-11T02:00:01.000Z',
  estimate: { status: 'ok', missing: [], commission: { rate: 0.14 },
    freight: { status: 'quoted', oversize: false, chosen: { route: 'GUOO Economy Small', chargeableKg: 1.3, freightRmb: 54.5 } },
    ceiling: { maximumAllInPurchaseRmb: 60.12 } },
  profitAtDeclaredPurchase: { allInPurchaseRmb: 18.86, unitProfitRmb: 41.26, marginRate: 0.284, passes: true,
    thresholdPolicy: 'either', meetsMinimumUnitProfit: true, meetsTargetMargin: true, withinPurchaseCeiling: true },
  routeBlock: null
};
const props = (extra = {}) => ({ candidate: candidate(), view: null, extensionStatus: { code: 'disconnected', label: '插件未安装或未连接' },
  onSaveDraft: forbidden, onRequestCapture: forbidden, onOpenLegacyCard: forbidden, onBack: forbidden, ...extra });

test('追加已采集颜色只需选规格，内部候选名称由软件生成', async () => {
  const parent = candidate({ sourceCapture: { mode: 'a_supplier_capture', status: 'captured_waiting_owner_selection',
    selectedSkuIds: ['6222816678023'], skuChoices: [
      { sourceSkuId: '6222816678023', attributes: { 颜色: '黑cp' } }
    ] }, lifecycleV11: { skuPackage: { supplierSkuId: '6222816678021',
      dSoftwareExecution: { checkpoints: [{ kind: 'import_task_received' }] } } } });
  const html = await render(props({ candidate: parent, onCreateSiblingSku: forbidden, siblingSkuIds: [] }));
  assert.match(html, /aria-label="追加同款规格"/u);
  assert.match(html, /黑cp · 6222816678023/u);
  assert.doesNotMatch(html, /这件规格的商品名称|请写明这个颜色/u);
});

test('one family page keeps created specifications visible with precise missing stages', async () => {
  const parent = candidate({ sourceCapture: { mode: 'a_supplier_capture', status: 'captured_waiting_owner_selection',
    selectedSkuIds: ['6222816678021', '6222816678023'], skuChoices: [
      { sourceSkuId: '6222816678021', attributes: { 颜色: '卡其色' } },
      { sourceSkuId: '6222816678023', attributes: { 颜色: '黑cp' } }
    ] }, lifecycleV11: { skuPackage: { supplierSkuId: '6222816678021', technicalStatus: 'unknown_outcome',
      dSoftwareExecution: { checkpoints: [{ kind: 'import_task_received' }] } } } });
  const child = { id: 'candidate:synthetic-black', siblingSourceV1: {
    parentCandidateId: parent.id, supplierSkuId: '6222816678023' } };
  const html = await render(props({ candidate: parent, onCreateSiblingSku: forbidden,
    siblingSkuIds: ['6222816678023'], siblingCandidates: [child] }));
  assert.match(html, /已排除首件供应 SKU 6222816678021/u);
  assert.match(html, /黑cp · 6222816678023/u);
  assert.match(html, /A 供应规格及数量 1 证据待确认/u);
  assert.match(html, /B 当前店铺正式利润待完成/u);
  assert.match(html, /整批尚有缺项，不能提交生产授权/u);
});

test('one family page waits for the batch workspace instead of showing misleading duplicate supply inputs', async () => {
  const parent = candidate({ sourceCapture: { mode: 'a_supplier_capture', status: 'captured_waiting_owner_selection',
    selectedSkuIds: ['6222816678021', '6222816678023'], skuChoices: [
      { sourceSkuId: '6222816678021', attributes: { 颜色: '卡其色' } },
      { sourceSkuId: '6222816678023', attributes: { 颜色: '黑cp' }, priceCny: null, weight: null }
    ] }, lifecycleV11: { skuPackage: { supplierSkuId: '6222816678021', technicalStatus: 'unknown_outcome',
      dSoftwareExecution: { checkpoints: [{ kind: 'import_task_received' }] } } } });
  const child = { id: 'candidate:synthetic-black', dataRevision: 1,
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: '6222816678023' },
    realAConfirmationCard: { salesReview: { snapshotId: 'synthetic:sales', title: '合成市场商品' } } };
  const html = await render(props({ candidate: parent, onCreateSiblingSku: forbidden,
    onConfirmSiblingBatchA: forbidden, onAuthorizeSiblingProductionBatch: forbidden,
    siblingSkuIds: ['6222816678023'], siblingCandidates: [child] }));
  assert.match(html, /当前正式流程与缺项/u);
  assert.match(html, /正在读取整批资料；读取完成前不能确认供货/u);
  assert.doesNotMatch(html, /各规格一件起订及单价的核对来源|其他采购费用 ¥/u);
  assert.doesNotMatch(html, /黑cp 单价|黑cp 本规格目标成交价|我已逐行核对所选规格为精确同款/u);
  assert.doesNotMatch(html, /整批确认供货并分别计算正式利润/u);
  assert.doesNotMatch(html, /确认上架（含创建和库存）/u);
});

test('C2 keeps the final decision disabled until the workspace is read and never falls back to legacy uploads while loading', async () => {
  const parent = candidate({ sourceCapture: { mode: 'a_supplier_capture', status: 'captured_waiting_owner_selection',
    selectedSkuIds: ['first-unknown', 'black'], skuChoices: [
      { sourceSkuId: 'first-unknown', attributes: { 颜色: '卡其色' } },
      { sourceSkuId: 'black', attributes: { 颜色: '黑色' } }
    ] }, lifecycleV11: { skuPackage: { supplierSkuId: 'first-unknown', technicalStatus: 'unknown_outcome' } } });
  const child = { id: 'candidate:synthetic-black', dataRevision: 5, productName: '合成黑色',
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: 'black' },
    lifecycleV11: { skuPackage: { businessPhase: 'C2', c2FinalAssets: { status: 'awaiting_final_uploads' } } } };
  const html = await render(props({ candidate: parent, siblingCandidates: [child],
    onConfirmSiblingBatchA: forbidden, onAuthorizeSiblingProductionBatch: forbidden,
    onUploadSiblingC2Asset: forbidden, onLinkSiblingC2Asset: forbidden, onConfirmSiblingBatchC2: forbidden }));
  assert.match(html, /正在读取整批资料/u);
  assert.doesNotMatch(html, /黑色 主图文件|共用图库文件|一次确认整批最终素材并生成各自方案卡/u);
  assert.match(html, /disabled=""[^>]*>确认上架（含创建和库存）/u);
  assert.doesNotMatch(html, /导入后库存动作|仅创建商品/u);
});

test('sibling product page shows frozen revision recovery and editable 10096/10097 mapping entry', async () => {
  const [frozen, editable] = siblingColorState().candidates;
  const frozenHtml = await render(props({ candidate: frozen, onReviseSiblingColor: forbidden }));
  assert.match(frozenHtml, /建立新的 C1 颜色修订/);
  assert.match(frozenHtml, /旧 C1\/C2 保留历史/);
  const editableHtml = await render(props({ candidate: editable, onSaveC1OzonAttributeMapping: forbidden,
    onLoadC1OzonAttributes: forbidden, onReadC1ColorDictionary: forbidden }));
  assert.match(editableHtml, /本规格供应原色：黑cp/);
  assert.match(editableHtml, /10096 商品颜色/);
  assert.match(editableHtml, /10097 颜色名称/);
  assert.match(editableHtml, /查看当前规格可映射的事实/);
  assert.match(editableHtml, /授权并读取本规格官方颜色候选/);
  assert.match(editableHtml, /需授权读取完整的官方字典候选，当前不能猜填/);
  assert.doesNotMatch(editableHtml, /填官方字典里的准确值/);
  editable.lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': { status: 'succeeded',
    schemaRevision: editable.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision,
    schemaEvidenceId: editable.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.evidenceId,
    schemaRuleVersion: editable.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.ruleVersion,
    c1PlanId: editable.lifecycleV11.skuPackage.c1ProductPlan.c1PlanId,
    evidence: { complete: true, sourceRef: 'synthetic:dictionary:10096',
      expiresAt: '2099-01-01T00:00:00.000Z', values: [
        { value: 'synthetic-broad-color', valueZh: '合成广义颜色', dictionaryValueId: 910096 }
      ] } } };
  const choicesHtml = await render(props({ candidate: editable, onSaveC1OzonAttributeMapping: forbidden,
    onLoadC1OzonAttributes: forbidden, onReadC1ColorDictionary: forbidden }));
  assert.match(choicesHtml, /请选择官方候选/);
  assert.match(choicesHtml, /合成广义颜色（synthetic-broad-color）/);
  assert.match(choicesHtml, /填写你确认的准确文字/);
});

test('C2 确认后从保存数据显示素材顺序和方案卡，缺少卡片不可宣称生成成功', async () => {
  const finalUploadAssets = finalAssets().map((asset, index) => ({ ...asset,
    fileName: index === 0 ? '首图.png' : '<script>详情.png' }));
  const source = productionOwnerDecisionFixture(undefined, { finalUploadAssets });
  const savedCandidate = { ...source.candidate, productionOwnerPreparation: source.preparedView };
  const skuPackage = savedCandidate.lifecycleV11.skuPackage;
  const html = await render(props({ candidate: structuredClone(savedCandidate) }));
  assert.match(html, /已保存 2 个最终素材，方案卡已生成。等待你核对方案卡。/u);
  assert.match(html, /主图：首图.png<\/li><li>&lt;script&gt;详情.png/u);
  assert.match(html, /aria-label="最终商品方案确认卡"/u);
  assert.match(html, /<h3>最终商品方案确认卡<\/h3>/u);
  assert.doesNotMatch(html, /查看已保存的方案卡/u, '已保存方案在当前商品页直接展示，不再要求跳到旧版');
  assert.doesNotMatch(html, /type="file"|确认最终素材并生成方案卡|<script>/u);
  const missing = await render(props({ candidate: { ...savedCandidate, lifecycleV11: { ...savedCandidate.lifecycleV11,
    skuPackage: { ...skuPackage, productionConfirmationCard: null } } } }));
  assert.match(missing, /未读取到方案卡/u);
  assert.doesNotMatch(missing, /方案卡已生成|查看已保存的方案卡|aria-label="最终商品方案确认卡"/u);
});

test('商品页显示中文标题、店铺和六步导航，当前停在找货', async () => {
  const html = await render(props({ titleZh: '合成收纳盒' }));
  assert.match(html, /合成收纳盒/);
  assert.match(html, /Miska/);
  assert.match(html, /Explicitly synthetic organizer/);
  for (const step of ['选定', '找货', '算利润', '文案素材', '上架', '回读']) assert.match(html, new RegExp(step));
  assert.match(html, /aria-current="step"[^>]*>[^<]*<span class="product-step-index">2<\/span>找货/);
  assert.match(html, /<img[^>]*src="https:\/\/images\.example\.test\/synthetic-organizer\.png"[^>]*width="88"/);
  // Every other step stays folded and says so plainly.
  assert.equal((html.match(/未开始/gu) ?? []).length, 5);
  assert.doesNotMatch(html, /保存A卡并等待插件自动采集/);
});

test('找货表单先按已保存的逐项资料预填，有找货方案后按方案预填', async () => {
  const prefilledFromFields = await render(props());
  assert.match(prefilledFromFields, /1688 \/ 拼多多 商品链接/);
  assert.match(prefilledFromFields, /id="supply-source-url"[^>]*value=""/);
  // The all-in purchase price minus the saved domestic shipping is the goods price the owner had declared.
  assert.match(prefilledFromFields, /id="supply-goods-price"[^>]*value="15\.9"/);
  assert.match(prefilledFromFields, /id="supply-domestic-shipping"[^>]*value="2\.96"/);
  assert.match(prefilledFromFields, /id="supply-weight"[^>]*value="1\.3"/);
  assert.match(prefilledFromFields, /id="supply-length"[^>]*value="75"/);
  assert.match(prefilledFromFields, /id="supply-width"[^>]*value="21"/);
  assert.match(prefilledFromFields, /id="supply-height"[^>]*value="4"/);
  assert.match(prefilledFromFields, /请粘贴1688或拼多多的商品链接或分享短链/);
  const saved = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.match(saved, /id="supply-source-url"[^>]*value="https:\/\/detail\.1688\.com\/offer\/876240928352\.html"/);
  assert.match(saved, /id="supply-target-price"[^>]*value="1850"/);
  assert.doesNotMatch(saved, /请粘贴1688或拼多多的商品链接或分享短链/);
  assert.match(saved, /市场快照：Seerfar 2026-09-10 · 售价 1850 卢布 · 30 天销量 330 · 评价 371/);
  assert.match(saved, /按你填的到手总价 ¥18\.86：单件利润 ¥41\.26 · 利润率 28% · 达到本店利润门槛/);
  assert.match(saved, /采购上限 ¥60\.12 · GUOO Economy Small · 计费 1\.3 公斤 · 运费 ¥54\.50 · 佣金 14%/);
});

test('没有可走线路时按资费表原话给出折叠或按大件的提示', async () => {
  const html = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: blockedEstimate, marketSnapshot } }));
  assert.match(html, /当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米，或按大件重量（≥2\.001 公斤）重新申报。/);
  assert.match(html, /GUOO Economy Small：单边最大 60 厘米，当前最长边 75 厘米/);
  assert.match(html, /GUOO Economy Big：可走 2\.001-30 公斤，当前 1\.3 公斤/);
  assert.match(html, /还不能算利润：缺可行物流线路。/);
  assert.match(html, /role="alert"/);
});

test('插件没连上时给一句安装提示，连上后不再显示', async () => {
  const absent = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.match(absent, /插件状态：插件未安装或未连接/);
  assert.match(absent, /还没连上插件：打开 Chrome 的 chrome:\/\/extensions，开启开发者模式，点「加载已解压的扩展程序」，选择本项目的 extension\/1688-capture 目录。/);
  assert.match(absent, /申请插件采集/);
  assert.match(absent, /还没有申请过插件采集。/);
  const connected = await render(props({ extensionStatus: { code: 'connected', label: '插件已连接 · 等待采集任务' },
    view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot },
    candidate: candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } }) }));
  assert.doesNotMatch(connected, /还没连上插件/);
  assert.match(connected, /已排队，等插件领取本次采集。/);
});

test('没有找货方案时不能申请采集，也不显示假的市场快照或利润', async () => {
  const html = await render(props());
  assert.match(html, /市场快照：还没有本商品的查询结果快照。/);
  assert.match(html, /填好上面的资料并保存后，这里显示采购上限和利润。/);
  assert.match(html, /先保存上面的找货方案，才能申请采集。/);
  assert.match(html, /申请插件采集<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>申请插件采集<\/button>/);
  assert.match(html, /保存只记录你填的方案，不会确认供货，也不会开始采购。/);
});

test('商品页顶上写明自己在哪一层，选品台和我选的商品都能点回去，返回按钮还在', async () => {
  const html = await render(props({ titleZh: '合成收纳盒' }));
  assert.match(html, /<nav class="product-breadcrumb" aria-label="位置">/u);
  assert.match(html, /<button[^>]*class="product-breadcrumb-link"[^>]*>选品台<\/button>/u);
  assert.match(html, /<button[^>]*class="product-breadcrumb-link"[^>]*>我选的商品<\/button>/u);
  assert.match(html, /<span class="product-breadcrumb-current">合成收纳盒<\/span>/u);
  assert.match(html, /›/u);
  assert.match(html, />返回<\/button>/u);
  // Without a way back the breadcrumb still says where the page sits, but offers no dead link.
  const noBack = await render({ ...props({ titleZh: '合成收纳盒' }), onBack: undefined });
  assert.match(noBack, /product-breadcrumb/u);
  assert.doesNotMatch(noBack, /product-breadcrumb-link/u);
  assert.doesNotMatch(noBack, />返回<\/button>/u);
});

test('保存之后留在本页，并且只强调下一步：过线强调申请采集，没过线或缺资料强调表单', async () => {
  const passing = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.match(passing, /<div class="product-capture product-next" aria-label="插件采集">/u);
  assert.match(passing, /下一步：点下面的「申请插件采集」，让插件去读这个1688页面。/u);
  assert.match(passing, /<button[^>]*class="button primary"[^>]*>申请插件采集<\/button>/u);
  assert.doesNotMatch(passing, /<div class="product-form product-next">/u);
  const blocked = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: blockedEstimate, marketSnapshot } }));
  assert.match(blocked, /<div class="product-form product-next">/u);
  assert.match(blocked, /下一步：把上面缺的资料补齐，再保存一次。/u);
  assert.doesNotMatch(blocked, /product-capture product-next/u);
  const thin = await render(props({ view: { supplierDraftV1: draft, marketSnapshot,
    supplierDraftEstimateV1: { ...okEstimate, profitAtDeclaredPurchase: { ...okEstimate.profitAtDeclaredPurchase, passes: false } } } }));
  assert.match(thin, /<div class="product-form product-next">/u);
  assert.match(thin, /下一步：这件没到本店利润门槛，改上面的货价或目标成交价再保存一次。/u);
  // Before anything is saved there is no "next step" to shout about, only the form itself.
  const fresh = await render(props());
  assert.match(fresh, /<div class="product-form product-next">/u);
  assert.doesNotMatch(fresh, /下一步：/u);
});

test('采集这一步自己说出来的那句话占用本页原有的提示位，没有具体的话才回落到通用句', async () => {
  const { stepNotice } = await pageModule();
  const rejected = '这个标签页里没有采集插件：请用 http://127.0.0.1:4317 打开页面（不是 localhost）';
  assert.equal(stepNotice(rejected, '已申请插件采集，采到后这里会显示结果。'), rejected);
  // 保存找货方案返回的是视图对象，不是话；这类步骤仍旧显示它自己的通用句。
  assert.equal(stepNotice({ supplierDraftV1: draft }, '已保存你填的找货方案'), '已保存你填的找货方案');
  assert.equal(stepNotice(undefined, '已保存你填的找货方案'), '已保存你填的找货方案');
  assert.equal(stepNotice('   ', '已申请插件采集'), '已申请插件采集');
  // 提示位就是找货这一节里已有的那一个，没有新增第二处说话的地方。
  const html = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.equal(html.match(/class="product-notice"/gu), null, '没有提示时不占位');
  assert.equal((html.match(/role="status"/gu) ?? []).length, 0);
});

test('商品页的申请插件采集走专用处理：写操作不经读取守卫，排队回执后必须发开始信号', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /onRequestCapture=\{payload => requestProductCapture\(payload\)\}/u);
  assert.doesNotMatch(app, /onRequestCapture=\{payload => runProductStep\(/u,
    '走 runProductStep 就只调接口、永远不发开始信号，插件后台不轮询作业，主人只会空等到超时');
  const handler = app.match(/async function requestProductCapture\(payload\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '商品页采集必须有自己的处理函数');
  assert.match(handler[0], /runMutation\(\(\)=>api\.confirmRealAStage\(candidateId,payload\)/u);
  assert.doesNotMatch(handler[0], /productDraftReads\.current\.run\(/u,
    '写操作经过“只保留最新读取”的守卫会把服务端的真实回答丢成 null');
  assert.match(handler[0], /startQueuedSupplierCapture\(result\)/u);
  assert.match(handler[0], /await load\(true\);setProductDraftRefresh\(value=>value\+1\);/u);
  // 旧 A 卡仍然自己调用同一个信号与同一套文案映射，没有被改成另一条路径。
  assert.match(app, /const captureStart = await startQueuedSupplierCapture\(result\);/u);
  assert.match(app, /\$\{captureStart\.message\}/u);
  assert.match(app, /import \{ IMAGE_MATCH_CHANNEL, OZON_IMAGE_MATCH_CHANNEL, OZON_PAGE_READ_CHANNEL, startQueuedSupplierCapture \} from "\.\/captureStart\.js";/u);
});

// 定价指引 (owner question 2026-09-11). Synthetic guidance only: the page shows what the saved estimate carries.
const guidance = {
  status: 'ok', rubPerCny: 12.5637, allInPurchaseRmb: 45, nonPurchaseFixedRmb: 14.61,
  minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either',
  breakEven: { priceRub: 986, commissionRate: 0.12, commissionTier: 'le1500', revenueCny: 78.48, unitProfitRmb: 0.03, marginRate: 0.0004 },
  threshold: { priceRub: 1228, commissionRate: 0.12, commissionTier: 'le1500', revenueCny: 97.74, unitProfitRmb: 14.67, marginRate: 0.1501, basis: 'margin' },
  market: { priceRub: 1666, commissionRate: 0.14, commissionTier: '1500_5000', revenueCny: 132.6, unitProfitRmb: 38.51, marginRate: 0.2904 },
  ladder: [
    { label: '保本价', priceRub: 986, commissionRate: 0.12, unitProfitRmb: 0.03, marginRate: 0.0004 },
    { label: '达标价', priceRub: 1228, commissionRate: 0.12, unitProfitRmb: 14.67, marginRate: 0.1501 },
    { label: '整数价位', priceRub: 1600, commissionRate: 0.14, unitProfitRmb: 34.62, marginRate: 0.2718 },
    { label: '同款市场价', priceRub: 1666, commissionRate: 0.14, unitProfitRmb: 38.51, marginRate: 0.2904 }
  ]
};

test('保存找货资料后，商品页自己把保本价、达标价、市场价利润和价格阶梯算给主人看', async () => {
  const html = await render(props({ view: { supplierDraftV1: draft, marketSnapshot,
    supplierDraftEstimateV1: { ...okEstimate, pricingGuidance: guidance } } }));
  assert.match(html, /定价指引/u);
  assert.match(html, /保本价<\/dt><dd>986 卢布（佣金 12%）/u);
  assert.match(html, /达标最低售价<\/dt><dd>1228 卢布（佣金 12%） · 按「利润率 ≥ 15%」先达到/u);
  assert.match(html, /同款市场价<\/dt><dd>1666 卢布 · 按这个价单件利润 ¥38\.51 · 利润率 29%/u);
  // The ladder shows the rate of each price's own band, which is why 1600 carries 14% and 1228 carries 12%.
  assert.match(html, /价格阶梯：每个售价能落下多少/u);
  assert.match(html, /<td>1600 卢布<\/td><td>14%<\/td><td>¥34\.62<\/td><td>27%<\/td><td>整数价位<\/td>/u);
  assert.match(html, /<td>1228 卢布<\/td><td>12%<\/td>/u);
  assert.match(html, /超过档位分界线会换一档费率/u);
  assert.match(html, /1 元 ≈ 12\.5637 卢布/u);
  assert.match(html, /你填的到手总价 ¥45\.00/u);
  // 目标成交价 starts at the market price and says so; the owner no longer types a number out of thin air.
  assert.match(html, /id="supply-target-price"[^>]*value="1850"/u, '已经填过找货方案时按方案里的价预填');
  const fresh = await render(props({ view: { supplierDraftV1: null, marketSnapshot, supplierDraftEstimateV1: null } }));
  assert.match(fresh, /id="supply-target-price"[^>]*value="1850"/u, '还没填过时默认就是同款市场价');
  assert.match(fresh, /默认就是同款现在的市场价；它也是以后上架时的起价/u);
  assert.doesNotMatch(fresh, /定价指引/u, '还没保存找货方案时不显示定价指引');
});

test('算不出定价指引时直说缺什么，不给一个猜出来的价', async () => {
  const html = await render(props({ view: { supplierDraftV1: draft, marketSnapshot,
    supplierDraftEstimateV1: { ...okEstimate, pricingGuidance: null } } }));
  assert.match(html, /定价指引/u);
  assert.match(html, /还算不出来：需要官方汇率、官方佣金和一条可行运费线路都齐了才有这几个价。/u);
  assert.doesNotMatch(html, /卢布（佣金/u);
  const { thresholdBasisLine } = await pageModule();
  assert.equal(thresholdBasisLine(null), null);
  assert.equal(thresholdBasisLine({ threshold: null }), null);
  assert.equal(thresholdBasisLine({ ...guidance, threshold: { ...guidance.threshold, basis: 'unit_profit' } }),
    '按「单件利润 ≥ ¥20.00」先达到');
  assert.equal(thresholdBasisLine({ ...guidance, threshold: { ...guidance.threshold, basis: 'both' } }),
    '单件利润 ≥ ¥20.00 和利润率 ≥ 15% 同时达到');
});

// 结果未知：插件领走了作业，服务端没有收到结果。守卫会挡住之后的每一次采集申请，页面必须把这件事和出路一起说出来。
const unknownOutcomeCapture = {
  captureId: 'SCJ-synthetic-unknown-outcome', status: 'failed', jobStatus: 'unknown_outcome', failureCode: 'unknown_outcome',
  reason: '插件领取作业后中断，当前采集结果未知', mode: 'a_supplier_capture', attempt: 1, writeOccurred: false
};
const savedFind = { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot };

test('结果未知又没核实：页面说清被挡住了并给出唯一出路，「申请插件采集」当场就不可用', async () => {
  const { captureNeedsOwnerReview, captureReviewPayload, captureStatusLine } = await pageModule();
  const stuck = candidate({ sourceCapture: unknownOutcomeCapture });
  const settled = candidate({ sourceCapture: { ...unknownOutcomeCapture, jobStatus: 'failed',
    reviewedAt: '2026-09-11T09:00:00.000Z', reviewedBy: 'owner', acknowledgement: 'no_result_received' } });
  assert.equal(captureNeedsOwnerReview(stuck), true);
  assert.deepEqual(captureReviewPayload(stuck), { dataRevision: 4, acknowledgement: 'no_result_received' });
  // 核实过的同一条记录不再挡路，也就不再需要这个按钮；没采集过的商品从来不需要。
  assert.equal(captureNeedsOwnerReview(settled), false);
  assert.equal(captureReviewPayload(settled), null);
  assert.equal(captureNeedsOwnerReview(candidate()), false);
  assert.equal(captureNeedsOwnerReview(candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } })), false);
  assert.equal(captureStatusLine(stuck), '上一次采集的结果未知：插件领取作业后中断，当前采集结果未知。');
  assert.equal(captureStatusLine(settled), '上一次采集的结果未知：插件领取作业后中断，当前采集结果未知。你已确认这次没有结果，可以重新申请采集。');

  const blocked = await render(props({ candidate: stuck, view: savedFind, onReviewCaptureAndRequest: forbidden }));
  assert.match(blocked, /插件领走了上一次采集，但一直没有把结果传回来，服务端只能记成「结果未知」。/u);
  assert.match(blocked, /在你确认之前，这件商品不能再申请采集。/u);
  assert.match(blocked, /<p class="product-capture-blocked" role="alert">/u);
  assert.match(blocked, /<button[^>]*disabled[^>]*>申请插件采集<\/button>/u, '被挡住时不能让主人点了才收到 409');
  assert.match(blocked, /在你确认这条「结果未知」的记录之前，「申请插件采集」不可用/u);
  assert.match(blocked, /<button[^>]*class="button primary"[^>]*>这次采集没有结果，我确认并重新申请<\/button>/u);
  assert.match(blocked, /确认只是记下你的判断，不会替你补一份采集结果。/u);
  // 「下一步」不能再指向一个点不动的按钮。
  assert.match(blocked, /下一步：先确认下面那条「结果未知」的采集记录，才能重新申请采集。/u);
  assert.doesNotMatch(blocked, /下一步：点下面的「申请插件采集」/u);

  const after = await render(props({ candidate: settled, view: savedFind }));
  assert.doesNotMatch(after, /这次采集没有结果，我确认并重新申请/u);
  assert.doesNotMatch(after, /product-capture-blocked/u);
  assert.match(after, /<button[^>]*class="button primary"[^>]*>申请插件采集<\/button>/u);
  assert.doesNotMatch(after, /<button[^>]*disabled[^>]*>申请插件采集<\/button>/u);
  assert.match(after, /下一步：点下面的「申请插件采集」/u);
});

test('确认并重新申请是两步：先调核实接口，成功再走原有的申请采集链路，哪一步失败就说哪一步', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(apiClient, /reviewSourceCapture: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /source-capture\/review/u);
  assert.match(app, /onReviewCaptureAndRequest=\{payload => reviewCaptureAndRequest\(payload\)\}/u);
  const handler = app.match(/async function reviewCaptureAndRequest\(\{review,capture\}\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '确认并重新申请必须有自己的处理函数');
  assert.match(handler[0], /api\.reviewSourceCapture\(candidateId,review\)/u);
  assert.match(handler[0], /requestProductCapture\(\{\.\.\.capture,dataRevision:reviewed\.candidate\.dataRevision/u,
    '核实会推进修订号，第二步必须带服务端刚返回的那个修订号');
  assert.match(handler[0], /没能记下你的确认，这次也没有重新申请采集/u);
  assert.match(handler[0], /已记下你的确认（这条记录不再挡路），但这次重新申请采集没有成功/u);
  // 第二步就是原来的那条链路：核实自己既不建作业，也不发开始信号。
  assert.doesNotMatch(handler[0], /startQueuedSupplierCapture/u);
  assert.doesNotMatch(handler[0], /confirmRealAStage/u);
});

test('商品页头部也能淘汰这件商品，已经淘汰的只说明在哪里恢复', async () => {
  const live = await render(props({ onEliminateCandidate: forbidden }));
  assert.match(live, /product-header-actions/u);
  assert.match(live, /class="button secondary eliminate-button"[^>]*>淘汰</u);
  const dropped = await render(props({ candidate: candidate({ workflowStatus: 'eliminated' }), onEliminateCandidate: forbidden }));
  assert.match(dropped, /已淘汰 · 在选品台的「已淘汰」里可以恢复/u);
  assert.doesNotMatch(dropped, /eliminate-button/u);
});

/* ── 选规格 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * Synthetic display data only. The numbers below are the shape the server sends, not a second calculation: the money
 * itself is proved against the saved GUOO table in tests/sku-choice-estimate.test.mjs.
 */
const choiceRow = (id, colour, size, priceCny, freightRmb, unitProfitRmb, marginRate, weightKg, stock, extra = {}) => ({
  order: 0, sourceSkuId: id, propPath: null, attributes: { 颜色: colour, 尺码: size }, values: [colour, size],
  label: `${colour} · ${size}`, imageUrl: null, priceCny, stock, inStock: stock > 0, weightKg,
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight',
  chargeableKg: weightKg, route: weightKg === null ? null : 'GUOO Economy Extra Small', freightRmb,
  allInPurchaseRmb: priceCny === null ? null : priceCny + 3.5, unitProfitRmb, marginRate,
  passes: unitProfitRmb !== null, status: weightKg === null ? 'weight_missing' : 'ok',
  missing: weightKg === null ? ['规格重量'] : [], ...extra
});
const choiceTable = (extra = {}) => ({
  schemaVersion: 'sku-choice-table-v1', builtAt: '2026-09-13T01:00:01.000Z', columns: ['颜色', '尺码'],
  rows: [
    choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494),
    choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 10.11, 34.62, 0.2718, 0.24, 468),
    choiceRow('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, null, null, null, null, 479)
  ],
  total: 3, pricedCount: 2, weightMissingCount: 1,
  best: choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494),
  worst: choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 10.11, 34.62, 0.2718, 0.24, 468),
  profitDropRate: 0.4179, selectedSkuIds: [],
  sources: {
    targetSalePriceRub: 1600, rubPerCny: 12.5637, fxRateDate: '2026-09-12', fxSourceRef: 'cbr-xml-daily:R01375:2026-09-12',
    commissionRate: 0.14, commissionTier: '1500_5000', commissionSourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic',
    routes: ['GUOO Economy Extra Small'], tariffRuleVersion: 'guoo-2026-08-19', domesticShippingRmb: 3.5,
    packagingRmbDefault: 3, extraHandlingDeclared: true, labelCostRmb: 1.5,
    reserveParts: { advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02 },
    reserveRate: 0.12, dimensionsCm: { length: 25, width: 22, height: 2.5 }
  },
  ...extra
});
const waitingCapture = (extra = {}) => ({
  captureId: 'SCJ-synthetic-choice', status: 'captured_waiting_owner_selection', mode: 'a_supplier_capture',
  jobStatus: 'completed', offerId: '943009939489', sourceUrl: 'https://detail.1688.com/offer/943009939489.html',
  observedAt: '2026-09-13T00:30:00.000Z', selectedSkuIds: [], writeOccurred: false,
  skuChoices: [{ sourceSkuId: 'sku-xl-yellow' }, { sourceSkuId: 'sku-8xl-yellow' }, { sourceSkuId: 'sku-8xl-beige' }], ...extra
});
const choosingProps = (extra = {}, captureExtra = {}, tableExtra = {}) => props({
  candidate: candidate({ sourceCapture: waitingCapture(captureExtra) }),
  view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: choiceTable(tableExtra) },
  onChooseSkus: forbidden, ...extra
});

test('插件采回来之后，商品页停在「选定」，这一步展开成规格选择表', async () => {
  const { currentProductStep, skuChoiceReady, skuChoiceSaved, showsSkuChoice } = await pageModule();
  const waiting = candidate({ sourceCapture: waitingCapture() });
  assert.equal(skuChoiceReady(waiting), true);
  assert.equal(skuChoiceSaved(waiting), false);
  assert.equal(currentProductStep(waiting), 'select');
  assert.equal(showsSkuChoice(waiting), true);
  // 没采过、采失败、或者根本没有规格，这一步都不该打开。
  assert.equal(skuChoiceReady(candidate()), false);
  assert.equal(currentProductStep(candidate()), 'find');
  assert.equal(skuChoiceReady(candidate({ sourceCapture: waitingCapture({ skuChoices: [] }) })), false);
  assert.equal(skuChoiceReady(candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } })), false);

  const html = await render(choosingProps());
  assert.match(html, /aria-current="step"[^>]*>[^<]*<span class="product-step-index">1<\/span>选定/u);
  assert.match(html, /<section class="product-section product-sku-choice" aria-label="选规格">/u);
  assert.match(html, /<h3>选哪个规格上架<\/h3>/u);
  assert.match(html, /插件已经把这件1688货源的 3 个规格采回来了/u);
  assert.match(html, /货源 1688 \/ 943009939489 · 目标售价 1600 卢布 · 2026-09-13 采到/u);
  // 找货 folds away below it, complete, because those inputs still drive every row.
  assert.match(html, /<details class="product-folded" aria-label="找货"><summary>找货<span class="product-folded-state">已保存<\/span><\/summary>/u);
  assert.match(html, /id="supply-target-price"[^>]*value="1850"/u);
  // 选定 is no longer one of the folded "未开始" steps.
  assert.doesNotMatch(html, /<summary>选定/u);
  assert.equal((html.match(/未开始/gu) ?? []).length, 4);
  // 采回来之后，找货里那句「去申请采集」已经过去了：不再出现，也不再是被高亮的下一步。
  assert.doesNotMatch(html, /下一步：/u);
  assert.doesNotMatch(html, /product-capture product-next/u);
  assert.doesNotMatch(html, /product-form product-next/u);
});

test('顶上一行结论用表里自己的两个数字：最赚和最少各自的单件利润', async () => {
  const { skuChoiceHeadline, skuChoiceSwing } = await pageModule();
  assert.equal(skuChoiceHeadline(choiceTable()), '同一件货，选错规格少赚 42%');
  assert.equal(skuChoiceHeadline({ profitDropRate: null }), '同一件货，不同规格赚的不一样');
  assert.equal(skuChoiceHeadline({ profitDropRate: 0 }), '同一件货，不同规格赚的不一样');
  assert.deepEqual(skuChoiceSwing(choiceTable()).best, { label: '黄色 · XL（背长35cm）', unitProfitRmb: 59.47 });
  assert.deepEqual(skuChoiceSwing(choiceTable()).worst, { label: '黄色 · 8XL（背长72cm）', unitProfitRmb: 34.62 });
  assert.deepEqual(skuChoiceSwing({ best: null, worst: null }), { best: null, worst: null });

  const html = await render(choosingProps());
  assert.match(html, /<h4>同一件货，选错规格少赚 42%<\/h4>/u);
  assert.match(html, /最赚 · 黄色 · XL（背长35cm）<\/span><strong>¥59\.47<\/strong>/u);
  assert.match(html, /最少 · 黄色 · 8XL（背长72cm）<\/span><strong>¥34\.62<\/strong>/u);
});

test('表按单件利润从高到低列出九列，页面没给重量的那一行运费和利润写待补', async () => {
  const html = await render(choosingProps());
  assert.match(html, /<h4>3 个规格 · 按单件利润从高到低<\/h4>/u);
  assert.match(html, /可以多选：同一件货源的不同尺码可以一起上架 · 表头方框是全选/u);
  for (const header of ['颜色', '尺码', '货价', '计费重', '运费', '单件利润', '利润率', '库存']) {
    assert.match(html, new RegExp(`<th scope="col">${header}</th>`, 'u'));
  }
  assert.match(html, /<td>黄色<\/td><td>XL（背长35cm）<\/td><td>¥20\.50<\/td><td>0\.103 公斤<\/td><td>¥6\.26<\/td><td class="product-sku-profit">¥59\.47<\/td><td>47%<\/td><td>494<\/td>/u);
  assert.match(html, /<td>黄色<\/td><td>8XL（背长72cm）<\/td><td>¥41\.50<\/td><td>0\.24 公斤<\/td><td>¥10\.11<\/td><td class="product-sku-profit">¥34\.62<\/td><td>27%<\/td><td>468<\/td>/u);
  // 页面没给重量：运费和利润留空写「待补」，绝不借另一条尺码的重量。
  assert.match(html, /<td>米色<\/td><td>8XL（背长72cm）<\/td><td>¥41\.50<\/td><td>待补<\/td><td>待补<\/td><td class="product-sku-pending">待补<\/td><td>待补<\/td><td>479<\/td>/u);
  assert.equal((html.match(/aria-label="选 /gu) ?? []).length, 3);
});

test('表头第一个方框是全选，全选、全不选、半选三种状态都如实写出来', async () => {
  const { selectAllState } = await pageModule();
  const rows = choiceTable().rows;
  assert.equal(selectAllState([], rows), 'none');
  assert.equal(selectAllState(['sku-xl-yellow'], rows), 'some');
  assert.equal(selectAllState(rows.map(row => row.sourceSkuId), rows), 'all');
  assert.equal(selectAllState(['sku-xl-yellow'], []), 'none');

  const html = await render(choosingProps());
  assert.match(html, /<input type="checkbox" id="sku-choice-all"[^>]*aria-checked="false"[^>]*aria-label="全选这 3 个规格"/u);
  const saved = await render(choosingProps({}, { selectedSkuIds: ['sku-xl-yellow'] }, { selectedSkuIds: ['sku-xl-yellow'] }));
  assert.match(saved, /id="sku-choice-all"[^>]*aria-checked="mixed"/u);
  const all = await render(choosingProps({},
    { selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow', 'sku-8xl-beige'] },
    { selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow', 'sku-8xl-beige'] }));
  assert.match(all, /id="sku-choice-all"[^>]*aria-checked="true"[^>]*checked=""/u);
});

test('底下一行说清已选几个、单件利润多少，没选时按钮点不动', async () => {
  const { skuChoiceSummary, skuChoicePayload } = await pageModule();
  const table = choiceTable();
  assert.equal(skuChoiceSummary(table, []), '还没选。点一行前面的方框就行。');
  assert.equal(skuChoiceSummary(table, ['sku-xl-yellow']), '已选 1 个规格 · 单件利润 ¥59.47 · 按 1600 卢布售价算');
  assert.equal(skuChoiceSummary(table, ['sku-xl-yellow', 'sku-8xl-yellow']),
    '已选 2 个规格 · 单件利润 ¥34.62 – ¥59.47 · 按 1600 卢布售价算');
  assert.equal(skuChoiceSummary(table, ['sku-xl-yellow', 'sku-8xl-yellow', 'sku-8xl-beige']),
    '已选 全部 3 个规格 · 单件利润 ¥34.62 – ¥59.47（其中 1 个待补） · 按 1600 卢布售价算');
  assert.equal(skuChoiceSummary(table, ['sku-8xl-beige']), '已选 1 个规格 · 单件利润待补 · 按 1600 卢布售价算');
  // 提交的是封闭输入：当前修订号，加上按表里顺序排好的规格。
  assert.deepEqual(skuChoicePayload(table, ['sku-8xl-yellow', 'sku-xl-yellow'], 4),
    { dataRevision: 4, sourceSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] });
  assert.deepEqual(skuChoicePayload(table, ['sku-not-here'], 4), { dataRevision: 4, sourceSkuIds: [] });

  const html = await render(choosingProps());
  assert.match(html, /<p class="product-sku-summary">还没选。点一行前面的方框就行。<\/p>/u);
  assert.match(html, /<button[^>]*disabled[^>]*>选定这些规格<\/button>/u);
  const picked = await render(choosingProps({}, { selectedSkuIds: ['sku-xl-yellow'] }, { selectedSkuIds: ['sku-xl-yellow'] }));
  assert.match(picked, /已选 1 个规格 · 单件利润 ¥59\.47 · 按 1600 卢布售价算/u);
  assert.match(picked, /<button[^>]*class="button primary"[^>]*>选定这些规格<\/button>/u);
  assert.doesNotMatch(picked, /<button[^>]*disabled[^>]*>选定这些规格<\/button>/u);
  assert.match(picked, /已经选定过 1 个规格，它们在这件商品的供货方案里/u);
});

test('数字来源那一栏照实给出这一轮真正用到的输入，没有写死的值', async () => {
  const html = await render(choosingProps());
  assert.match(html, /<dl class="product-pricing-facts product-sku-sources" aria-label="数字来源">/u);
  assert.match(html, /<dt>目标售价<\/dt><dd>1600 卢布 · 你填的<\/dd>/u);
  assert.match(html, /<dt>央行汇率<\/dt><dd>1 元 ≈ 12\.5637 卢布 · 2026-09-12<\/dd>/u);
  assert.match(html, /<dt>Ozon 官方佣金<\/dt><dd>14% · 按你填的售价所在档<\/dd>/u);
  assert.match(html, /<dt>物流线路<\/dt><dd>GUOO Economy Extra Small · guoo-2026-08-19 资费<\/dd>/u);
  assert.match(html, /<dt>国内运费<\/dt><dd>¥3\.50 · 你填的<\/dd>/u);
  // 这笔钱单独一栏，并且说出它是主人自己声明的还是一个还没签过字的暂算值。
  assert.match(html, /<dt>每单额外操作费<\/dt><dd>¥3\.00 · 你声明的<\/dd>/u);
  assert.match(html, /<dt>贴标<\/dt><dd>¥1\.50<\/dd>/u);
  assert.match(html, /<dt>店铺预留<\/dt><dd>12% · 退货5% 破损5% 提现2%<\/dd>/u);
  assert.match(html, /<dt>规格重量<\/dt><dd>来自采集到的页面 · 每个规格各自的重量（有 1 个规格页面没给，运费和利润留空）<\/dd>/u);
  // 官方输入缺一样就直说未取得，不给一个猜出来的数。
  const bare = await render(choosingProps({}, {}, { sources: { ...choiceTable().sources, rubPerCny: null, commissionRate: null, routes: [] } }));
  assert.match(bare, /<dt>央行汇率<\/dt><dd>未取得<\/dd>/u);
  assert.match(bare, /<dt>Ozon 官方佣金<\/dt><dd>未取得 · 按你填的售价所在档<\/dd>/u);
  assert.match(bare, /<dt>物流线路<\/dt><dd>未取得<\/dd>/u);
});

test('「选完会发生什么」把边界说全：锁进供货方案、进度条前进，不下单、不联系供应商、不写 Ozon', async () => {
  const html = await render(choosingProps());
  assert.match(html, /<strong>选完之后会发生什么：<\/strong>软件把你选中的规格锁进这件商品的供货方案，商品页的进度条从「选定」走到「算利润」。/u);
  assert.match(html, /这一步<strong>不会<\/strong>下单、不会联系供应商、也不会向 Ozon 写任何东西。/u);
  assert.match(html, /货价与库存来自这次采到的1688页面，运费按各规格自己的重量查国欧资费表，佣金取自 Ozon 官方表，汇率取自央行。/u);
  // 内部词不出现在主人看的界面上。
  for (const word of ['SKU', '批次', '修订', '作业', 'dataRevision']) assert.doesNotMatch(html, new RegExp(word, 'u'));
});

test('选定之后进度条走到「算利润」，选定这一步记成已完成', async () => {
  const { currentProductStep, skuChoiceSaved, foldedStepLine, foldedStepState } = await pageModule();
  const chosen = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] }) });
  assert.equal(skuChoiceSaved(chosen), true);
  assert.equal(currentProductStep(chosen), 'profit');
  assert.equal(foldedStepState('select', 'profit', chosen), '已完成');
  assert.equal(foldedStepLine('select', 'profit', chosen), '已选定 2 个规格，已经锁进这件商品的供货方案。');
  assert.equal(foldedStepState('copy', 'profit', chosen), '未开始');
  assert.equal(foldedStepLine('copy', 'profit', chosen), '等前面的步骤完成后再开始。');
  assert.equal(foldedStepLine('profit', 'profit', chosen), '这一步的详细界面还在旧版页面里，先用「打开旧版A卡」查看。');

  const html = await render(choosingProps({ candidate: chosen }, {}, { selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] }));
  assert.match(html, /aria-current="step"[^>]*>[^<]*<span class="product-step-index">3<\/span>算利润/u);
  // 表还在，主人随时能改主意；A确认之后才收起来。
  assert.match(html, /<section class="product-section product-sku-choice" aria-label="选规格">/u);
  const confirmed = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow'] }),
    lifecycleV11: { aConfirmationReceipt: { decision: 'confirm' } } });
  assert.equal(currentProductStep(confirmed), 'profit');
  const after = await render(choosingProps({ candidate: confirmed }, {}, { selectedSkuIds: ['sku-xl-yellow'] }));
  assert.doesNotMatch(after, /选哪个规格上架/u);
  assert.match(after, /<summary>选定<span class="product-folded-state">已完成<\/span><\/summary>/u);
  assert.match(after, /已选定 1 个规格，已经锁进这件商品的供货方案。/u);
});

test('还没保存找货资料就采回来了：直说算不出来该先做什么，不给一张假的表', async () => {
  const html = await render(props({ candidate: candidate({ sourceCapture: waitingCapture() }),
    view: { supplierDraftV1: null, supplierDraftEstimateV1: null, marketSnapshot, skuChoiceTableV1: null } }));
  assert.match(html, /<h3>选哪个规格上架<\/h3>/u);
  assert.match(html, /但现在还算不出每个规格的运费和利润：/u);
  assert.match(html, /先把下面「找货」里的资料填好保存一次，这里就会按每个规格自己的重量算给你看。/u);
  assert.doesNotMatch(html, /按单件利润从高到低/u);
  assert.doesNotMatch(html, /选定这些规格/u);
  // 找货已经填过、但官方输入还缺一样：说的是缺哪一类，不是让主人再填一次表。
  const saved = await render(props({ candidate: candidate({ sourceCapture: waitingCapture() }),
    view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: null } }));
  assert.match(saved, /汇率、佣金、资费表或本店成本规则里还缺东西/u);
  assert.doesNotMatch(saved, /先把下面「找货」里的资料填好保存一次/u);
});

test('采集刚刚回来时商品页会自己重读这一步，不停在「还没有规格」上', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /const productRevision=view==='product'/u);
  assert.match(app, /\[view,accountOwnerId,selectedId,productDraftRefresh,productRevision\]/u,
    '保存记录的修订号一变，这一步就重读一次服务端');
});

test('选规格走商品页原有的那条保存通道，只发规格和当前修订号，不触发任何派发', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(apiClient, /chooseSourceSkus: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /lifecycle\/sku-choice/u);
  assert.match(app, /onChooseSkus=\{payload => runProductStep\(api\.chooseSourceSkus, payload\)\}/u);
  // 旧的 select-sku 接口（它会派发C阶段）没有被商品页接上。
  assert.doesNotMatch(app, /onChooseSkus=\{payload => runProductStep\(api\.selectSourceCaptureSku/u);
  // 保存走的是商品页原有的那条通道：保存完留在本页，本页的提示位说结果。
  assert.match(app, /async function runProductStep\(action,payload\)\{/u);
});

/* ── 重新采集 ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * 采到之后，「申请插件采集」不会再建新的采集（服务端认得同一个链接已经采过），所以重读同一个1688页面必须自己有一个入口。
 * 2026-09-13 第一件商品正是因为没有这个入口，被钉死在一次没有重量的采集结果上，整列运费和利润只能显示「待补」。
 */
test('只有已采到、等你选规格时才有「重新采集」，点之前先说清楚会作废哪几样', async () => {
  const { captureRecaptureReady, captureRecaptureConfirmLine, captureRecapturePayload,
    CAPTURE_RECAPTURE_REASONS } = await pageModule();
  const waiting = candidate({ sourceCapture: waitingCapture() });
  const picked = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'],
    skuSelection: { schemaVersion: 'source-capture-sku-selection-v1', selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] } }) });
  assert.equal(captureRecaptureReady(waiting), true);
  // 还在排队、正在读、读失败、根本没采过：都没有可以作废的东西，也就没有这个按钮。
  assert.equal(captureRecaptureReady(candidate()), false);
  assert.equal(captureRecaptureReady(candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } })), false);
  assert.equal(captureRecaptureReady(candidate({ sourceCapture: { status: 'capturing', jobStatus: 'claimed' } })), false);
  assert.equal(captureRecaptureReady(candidate({ sourceCapture: unknownOutcomeCapture })), false);
  assert.equal(captureRecaptureConfirmLine(candidate()), null);
  assert.equal(captureRecapturePayload(candidate()), null);

  // 确认这句话用的是记录里真实的条数，不是「一些规格」。
  assert.equal(captureRecaptureConfirmLine(waiting),
    '确定重新去读一次这个1688页面？现在这 3 个规格会作废。重新读一次不会下单、不会联系供应商、也不会向 Ozon 写任何东西。');
  assert.equal(captureRecaptureConfirmLine(picked),
    '确定重新去读一次这个1688页面？现在这 3 个规格会作废，连你已经选定的那 2 个也一起作废，要重新选一次。重新读一次不会下单、不会联系供应商、也不会向 Ozon 写任何东西。');
  // 封闭输入：当前修订号，外加一个只能来自这张表的理由；自由文本永远不会被发出去。
  assert.deepEqual(captureRecapturePayload(waiting), { dataRevision: 4 });
  assert.deepEqual(captureRecapturePayload(waiting, 'weight_missing'), { dataRevision: 4, reason: 'weight_missing' });
  assert.deepEqual(captureRecapturePayload(waiting, '因为重量没采到'), { dataRevision: 4 });
  assert.deepEqual(CAPTURE_RECAPTURE_REASONS.map(item => item.code),
    ['weight_missing', 'page_changed', 'wrong_specifications']);
});

const fullWeightTable = (extra = {}) => choiceTable({
  rows: [
    choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494),
    choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 10.11, 34.62, 0.2718, 0.24, 468)
  ],
  total: 2, pricedCount: 2, weightMissingCount: 0, ...extra
});
/** 2026-09-13 线上那件狗雨衣的形状：采到了规格，但一个重量都没采到。 */
const noWeightTable = () => choiceTable({
  rows: [
    choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, null, null, null, null, 494),
    choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, null, null, null, null, 468),
    choiceRow('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, null, null, null, null, 479)
  ],
  total: 3, pricedCount: 0, weightMissingCount: 3, best: null, worst: null, profitDropRate: null
});

test('「重新采集」是次要按钮，一次点击只是打开确认，主按钮仍旧是那张选规格表', async () => {
  const html = await render(choosingProps({ onRecaptureSource: forbidden }, {}, fullWeightTable()));
  assert.match(html, /<button[^>]*class="button secondary product-recapture-button"[^>]*>重新采集<\/button>/u);
  // 确认要等主人点了才出现：它不能一点就把这次采到的规格作废掉。
  assert.doesNotMatch(html, /product-recapture-confirm/u);
  assert.doesNotMatch(html, /确定重新去读一次这个1688页面/u);
  assert.match(html, /这些规格是上一次读到的。页面改了、或者规格不对，就重新读一遍这个1688页面。/u);
  // 主按钮仍旧是选规格；重读只是采得不对时的退路。
  assert.match(html, /<button type="button" class="button primary"[^>]*>选定这些规格<\/button>/u);
  // 还没采到过的商品不给这个按钮。
  const fresh = await render(props({ view: savedFind, onRecaptureSource: forbidden }));
  assert.doesNotMatch(fresh, /重新采集/u);
  assert.doesNotMatch(fresh, /product-recapture-button/u);
});

/* ── 重新采集看得见 ───────────────────────────────────────────────────────────────────────────────────────────────
 * 采到之后，「1688 采集」那一块会被折进「找货」的 <details> 里，主人要先展开才看得见里面的「重新采集」。规格表才是
 * 他这时候看着的东西，所以重读的入口必须在规格表这一步就露出来 —— 尤其是采到的规格根本没有重量、整列运费和利润
 * 都算不出来的时候（2026-09-13 首件狗雨衣，24 个规格全部无重量）。
 */
test('规格表这一步就能看见「重新采集」，不必先展开「找货」', async () => {
  const html = await render(choosingProps({ onRecaptureSource: forbidden }, {}, fullWeightTable()));
  const table = html.indexOf('product-sku-table');
  const folded = html.indexOf('<details class="product-folded" aria-label="找货">');
  const button = html.indexOf('product-recapture-button');
  assert.ok(table > 0 && folded > 0 && button > 0);
  assert.ok(button < folded, '重新采集必须在折起来的「找货」之前就出现');
  // 同一件商品只有一个重新采集入口：规格表在场时，「1688 采集」块里那个不再重复出现。
  assert.equal((html.match(/product-recapture-button/gu) ?? []).length, 1);
  assert.match(html, /这些规格要重新读一次，用上面「选哪个规格上架」里的「重新采集」。/u);
  assert.doesNotMatch(html, /上面这些规格是上一次读到的。页面改了、规格不对，或者这次没采到重量/u);

  // 规格表不在场时（采到了，却一个规格都没解析出来），它还留在「1688 采集」块里，不能凭空消失。
  const noRows = await render(props({
    candidate: candidate({ sourceCapture: waitingCapture({ skuChoices: [] }) }),
    view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: null },
    onRecaptureSource: forbidden
  }));
  assert.doesNotMatch(noRows, /product-sku-choice/u);
  assert.equal((noRows.match(/product-recapture-button/gu) ?? []).length, 1);
  assert.match(noRows, /上面这些规格是上一次读到的。页面改了、规格不对，或者这次没采到重量/u);
});

test('采到的规格没有重量时，页面直说算不出运费和利润，并把「重新采集」放在这句话旁边', async () => {
  const { skuWeightGapNotice } = await pageModule();
  // 一个规格都没有重量：整列算不出来。
  const all = skuWeightGapNotice(noWeightTable());
  assert.equal(all.all, true);
  assert.deepEqual([all.total, all.missing], [3, 3]);
  assert.equal(all.heading, '这些规格没有重量，运费和利润算不出来');
  assert.match(all.message, /这 3 个规格是早先采的/u);
  assert.match(all.message, /运费、单件利润、利润率整列都是「待补」/u);
  assert.match(all.message, /点「重新采集」/u);
  // 只有一部分没有重量：说清楚是几个，也说清楚其余的照常。
  const some = skuWeightGapNotice(choiceTable());
  assert.equal(some.all, false);
  assert.deepEqual([some.total, some.missing], [3, 1]);
  assert.equal(some.heading, '有 1 个规格没有重量，运费和利润算不出来');
  assert.match(some.message, /另外 2 个照常/u);
  // 规格齐全就没有这句话。
  assert.equal(skuWeightGapNotice(fullWeightTable()), null);
  assert.equal(skuWeightGapNotice(null), null);
  assert.equal(skuWeightGapNotice({ total: 0, weightMissingCount: 0 }), null);

  const html = await render(choosingProps({ onRecaptureSource: forbidden }, {}, noWeightTable()));
  assert.match(html, /<div class="product-sku-weight-gap" role="status">/u);
  assert.match(html, /<h4>这些规格没有重量，运费和利润算不出来<\/h4>/u);
  assert.match(html, /这 3 个规格是早先采的/u);
  // 这句话和重读的按钮在同一个框里，并且排在表前面。
  const banner = html.indexOf('product-sku-weight-gap');
  assert.ok(banner > 0 && banner < html.indexOf('product-sku-table'));
  assert.ok(html.indexOf('product-recapture-button') > banner);
  assert.ok(html.indexOf('product-recapture-button') < html.indexOf('product-sku-table'));
  // 一个规格都算不出利润时，「最赚 / 最少」只会是两个「待补」，那不是结论，就不显示；开头那句也不再许诺「按利润挑」。
  assert.doesNotMatch(html, /product-sku-verdict/u);
  assert.match(html, /这一次没有采到重量，所以现在还挑不了利润/u);
  assert.doesNotMatch(html, /这一步就是让你按利润挑/u);
  assert.doesNotMatch(html, /最赚 · /u);
  // 表本身照旧：每一行的运费和利润写「待补」，不借用别的规格的重量。
  assert.equal((html.match(/待补/gu) ?? []).length > 0, true);
  assert.match(html, /有 3 个规格页面没给，运费和利润留空/u);

  // 缺一部分时，同一个框只报缺的那几个，其余照常显示。
  const partial = await render(choosingProps({ onRecaptureSource: forbidden }));
  assert.match(partial, /<h4>有 1 个规格没有重量，运费和利润算不出来<\/h4>/u);
  assert.match(partial, /product-sku-verdict/u);
  assert.equal((partial.match(/product-recapture-button/gu) ?? []).length, 1);
  // 规格齐全时它是不显眼的次要动作，没有这条黄框。
  const complete = await render(choosingProps({ onRecaptureSource: forbidden }, {}, fullWeightTable()));
  assert.doesNotMatch(complete, /product-sku-weight-gap/u);
  assert.match(complete, /product-sku-recapture/u);
});

/* ── 同重同价声明 ──────────────────────────────────────────────────────────────────────────────────────────────────
 * 2026-09-16 那件小猫战术背心：5 个规格全是「均码」只差颜色，重量和货价一个都没采到，而主人在「找货」里早就填了。
 * 软件不许自己去借那个数，所以页面上给他一个签字的地方——一个按钮、一句大白话，签完之后表里标着「你填的」。
 */
const uniformStep = (extra = {}) => ({
  schemaVersion: 'sku-uniform-supply-step-v1', candidateId: 'candidate:synthetic-product-page', dataRevision: 4,
  label: '同重同价声明', status: 'absent', declared: false, offered: true, blockedReason: '', lapsedReason: '',
  total: 3, gapCount: 3, weightGapCount: 3, priceGapCount: 0, basis: { packedWeightKg: 0.2, goodsPriceRmb: 18 },
  declaredAt: null, declaredRevision: null, basisAtDeclaration: null,
  appliedWeightCount: 0, appliedPriceCount: 0, sourceRef: null, ...extra
});
const uniformProps = (step, table = noWeightTable(), extra = {}) => choosingProps({
  view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: table,
    skuUniformSupplyStepV1: step },
  onRecaptureSource: forbidden, onDeclareUniformSupply: forbidden, ...extra
});

test('规格没采到重量时，页面除了「重新采集」还给主人一个签字的地方：同重同价按他填的算', async () => {
  const { skuUniformSupplyNotice, skuUniformSupplyPayload } = await pageModule();
  // 缺东西才提议，而且说清楚这是「你填的」不是「采到的」。
  const offer = skuUniformSupplyNotice(uniformStep());
  assert.equal(offer.mode, 'offer');
  assert.equal(offer.heading, '这些规格是同一件货吗？');
  assert.match(offer.message, /3 个规格没采到重量/u);
  assert.match(offer.message, /按你在「找货」里填的 0\.2 公斤 \/ ¥18\.00 算/u);
  assert.match(offer.message, /这是你自己填的数，不是采到的/u);
  assert.match(offer.message, /采到了真实重量或货价的规格仍然按采到的算/u);
  assert.equal(offer.buttonLabel, '这些规格同重同价，按我填的算');
  assert.deepEqual(skuUniformSupplyPayload(uniformStep(), offer.uniform), { dataRevision: 4, uniform: true });

  // 签过之后：改说他签了什么、顶了几行，并且随时能撤回。
  const declared = skuUniformSupplyNotice(uniformStep({
    status: 'in_force', declared: true, offered: false, gapCount: 0, weightGapCount: 0,
    appliedWeightCount: 3, appliedPriceCount: 3, declaredAt: '2026-09-16T14:40:00.000Z'
  }));
  assert.equal(declared.mode, 'declared');
  assert.equal(declared.heading, '这些规格按你填的算');
  assert.match(declared.message, /3 个规格的重量 和 3 个规格的货价用的是你在「找货」里填的 0\.2 公斤 \/ ¥18\.00/u);
  assert.match(declared.message, /采到了真实数字的规格还是按采到的算/u);
  assert.equal(declared.buttonLabel, '撤回这个声明');
  assert.deepEqual(skuUniformSupplyPayload(uniformStep(), declared.uniform), { dataRevision: 4, uniform: false });

  // 找货还没填那两个数：不给签，只说先去哪儿填。
  const blocked = skuUniformSupplyNotice(uniformStep({ offered: false, blockedReason: '先在上面「找货」里填好打包重量和货价。' }));
  assert.equal(blocked.mode, 'blocked');
  assert.equal(blocked.buttonLabel, null);
  // 规格齐全、没有事要他做：这一块整个不出现。
  assert.equal(skuUniformSupplyNotice(uniformStep({ offered: false, gapCount: 0 })), null);
  assert.equal(skuUniformSupplyNotice(null), null);

  // 页面上：这句话和那个按钮在表前面，「重新采集」照旧还在，两条出路并排。
  const html = await render(uniformProps(uniformStep()));
  assert.match(html, /<div class="product-sku-uniform" role="status">/u);
  assert.match(html, /<h4>这些规格是同一件货吗？<\/h4>/u);
  assert.match(html, /这些规格同重同价，按我填的算<\/button>/u);
  assert.ok(html.indexOf('product-sku-uniform') < html.indexOf('product-sku-table'));
  assert.equal((html.match(/product-recapture-button/gu) ?? []).length, 1);
  // 没签字的时候，表里一个「你填的」都不许出现。
  assert.doesNotMatch(html, /product-sku-declared/u);
});

test('签过字之后表里每一行都标明这个数是「你填的」，采到的那几行一个字都不加', async () => {
  const mixed = choiceTable({
    rows: [
      // 采到的：一个字都不加。
      choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494,
        { weightBasis: 'captured', priceBasis: 'captured' }),
      // 只缺重量：重量是他填的，货价还是采到的。
      choiceRow('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, 9.0, 20.0, 0.16, 0.2, 479,
        { status: 'ok', missing: [], weightBasis: 'owner_declared', priceBasis: 'captured' })
    ],
    total: 2, pricedCount: 2, weightMissingCount: 0,
    uniformSupply: {
      schemaVersion: 'candidate-sku-uniform-supply-v1', declaredBy: 'owner', declaredAt: '2026-09-16T14:40:00.000Z',
      captureId: 'SCJ-synthetic-choice', sourceRef: 'owner-sku-uniform-supply:x:3:2026-09-16T14:40:00.000Z',
      packedWeightKg: 0.2, goodsPriceRmb: 18, weightSource: 'owner_declared:supplierDraftV1.packedWeightKg',
      priceSource: 'owner_declared:supplierDraftV1.goodsPriceRmb',
      appliedWeightSkuIds: ['sku-8xl-beige'], appliedPriceSkuIds: []
    }
  });
  const html = await render(uniformProps(uniformStep({
    status: 'in_force', declared: true, offered: false, total: 2, gapCount: 0, weightGapCount: 0,
    appliedWeightCount: 1, appliedPriceCount: 0, declaredAt: '2026-09-16T14:40:00.000Z'
  }), mixed));
  // 主人的原话：表里要标明「你填的」。他填的那个重量标了，采到的货价没标。
  assert.equal((html.match(/product-sku-declared/gu) ?? []).length, 1);
  assert.match(html, /0\.2 公斤<span class="product-sku-declared"> · 你填的<\/span>/u);
  assert.doesNotMatch(html, /¥41\.50<span class="product-sku-declared">/u);
  // 「数字来源」那一栏也说得出这一次签字：几行按他填的算、什么时候签的。
  assert.match(html, /<dt>你声明的同重同价<\/dt>/u);
  assert.match(html, /1 个规格按你填的 0\.2 公斤算运费/u);
  assert.match(html, /2026-09-16 你声明的/u);
  // 缺重量那条黄框已经不该再出现，取而代之的是「这些规格按你填的算」和撤回。
  assert.doesNotMatch(html, /product-sku-weight-gap/u);
  assert.match(html, /<h4>这些规格按你填的算<\/h4>/u);
  assert.match(html, /撤回这个声明<\/button>/u);
});

/* 这条路本身（仅主人、封闭输入、修订号不符 409、存档、不派发）由 tests/supplier-draft-api.test.mjs 对着真服务端证。
 * 这里只证页面走的是那一条，别自己另开一条。 */
test('同重同价声明走商品页原有的那条保存通道，页面自己不另开一条路', async () => {
  const { readFile } = await import('node:fs/promises');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(apiClient, /declareSkuUniformSupply: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /lifecycle\/sku-uniform-supply/u);
  assert.match(app, /onDeclareUniformSupply=\{payload => runProductStep\(api\.declareSkuUniformSupply, payload\)\}/u);
});

test('重新采集有自己的处理函数：写操作不经读取守卫，拿到回执后复用今天那条开始信号', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(apiClient, /recaptureSourceCapture: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /source-capture\/recapture/u);
  assert.match(app, /onRecaptureSource=\{payload => recaptureProductSource\(payload\)\}/u);
  assert.doesNotMatch(app, /onRecaptureSource=\{payload => runProductStep\(/u,
    '走 runProductStep 就只调接口、永远不发开始信号，插件后台不轮询作业，主人只会空等到超时');
  const handler = app.match(/async function recaptureProductSource\(payload\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '重新采集必须有自己的处理函数');
  assert.match(handler[0], /runMutation\(\(\)=>api\.recaptureSourceCapture\(candidateId,payload\)/u);
  assert.doesNotMatch(handler[0], /productDraftReads\.current\.run\(/u,
    '写操作经过“只保留最新读取”的守卫会把服务端的真实回答丢成 null');
  // 开始信号只有 captureStart.js 里那一个，重新采集没有另写一套。
  assert.match(handler[0], /const start=await startQueuedSupplierCapture\(result\);/u);
  assert.doesNotMatch(handler[0], /postMessage|CAPTURE_REQUEST|addEventListener/u);
  assert.match(handler[0], /await load\(true\);setProductDraftRefresh\(value=>value\+1\);/u);
});

/* ── 算利润 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * 主人 2026-09-13 定的口径：凡是过利润线的规格他全都要上，所以这一步不挑「最赚的那一个」——整套一起核线，指定一个
 * 变体先上架跑通，其余排队等同一张卡追加。页面自己不算钱，它只负责把服务端已经算好的那份东西说清楚，并且在资料
 * 凑不齐的时候如实说缺什么、不许提交。
 */
const profitSpec = (id, label, values, priceCny, freightRmb, unitProfitRmb, marginRate, weightKg, extra = {}) => ({
  sourceSkuId: id, label, values, attributes: { 尺码: values[0], 颜色: values[1] },
  priceCny, weightKg, chargeableKg: weightKg, route: 'GUOO Economy Extra Small', freightRmb,
  allInPurchaseRmb: priceCny + 3.5, unitProfitRmb, marginRate,
  breakEvenRub: 1069, thresholdRub: 1331, thresholdBasis: 'margin',
  // 「每单额外操作费涨到多少这个规格才掉线」：门槛取两条里较松的那条（min(¥20, 15% × ¥127.35) = ¥19.10），
  // 余地 = 单件利润 − 门槛，X = 现在这笔费用 ¥3.00 + 余地。
  extraHandling: { currentRmb: 3, thresholdRmb: 19.1, thresholdBasis: 'margin',
    headroomRmb: Math.round((unitProfitRmb - 19.1) * 100) / 100,
    breakRmb: Math.round((3 + unitProfitRmb - 19.1) * 100) / 100 },
  breakdown: { revenueCny: 127.35, commissionRate: 0.14, commissionRmb: 17.82, storeReserveRate: 0.12,
    storeReserveRmb: 15.28, freightRmb, packagingRmb: 3, labelCostRmb: 1.5, otherFixedRmb: 0,
    allInPurchaseRmb: priceCny + 3.5, unitProfitRmb, marginRate, roundingRmb: 0.02 },
  priceDelta: priceCny === 20.5 ? null : { pageRmb: priceCny, declaredRmb: 20.5, deltaRmb: Math.round((priceCny - 20.5) * 100) / 100 },
  variantKey: `1627207:${id}`, unitProductPrice: priceCny, actualPurchaseCost: priceCny + 3.5,
  quantityOneEvidenceSourceNote: '按 2026-09-13 采到的 1688 页面（商品 943009939489）核对：页面报的起订量是 1 件。',
  isSuggested: false, gaps: [], ...extra
});
const profitReview = (extra = {}) => ({
  schemaVersion: 'profit-step-review-v1', builtAt: '2026-09-13T01:00:02.000Z',
  candidateId: 'candidate:synthetic-product-page', dataRevision: 4, columns: ['尺码', '颜色'],
  total: 3, passCount: 2, excludedCount: 1,
  unitProfitRange: { low: 34.62, high: 59.47 }, marginRange: { low: 0.2718, high: 0.467 },
  excluded: [{ sourceSkuId: 'sku-8xl-navy', label: '8XL · 藏青色', kind: 'below_threshold', missing: [],
    unitProfitRmb: 16.12, marginRate: 0.1266, unitProfitShortRmb: 3.88, marginShortRate: 0.0234 }],
  threshold: { minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either', policyVersion: 'synthetic-pricing-v1' },
  // 这一整套利润是按哪笔「每单额外操作费」算出来的，以及那个数主人签过字没有。
  extraHandlingFee: { appliedRmb: 3, declared: true },
  benchmark: { productNumber: '3605840795', productUrl: 'https://www.ozon.ru/product/3605840795',
    title: 'Водонепроницаемый дождевик для собак, светоотражающий -8XL', currentPrice: 1457, currency: 'RUB',
    collectedOn: '2026-09-11', snapshotId: marketSnapshot.snapshotId,
    matchedAttributeKey: '尺码', matchedValue: '8XL', sameAttributeCount: 1 },
  suggestedSkuId: 'sku-8xl-yellow',
  specifications: [
    profitSpec('sku-xl-yellow', 'XL · 黄色', ['XL', '黄色'], 20.5, 6.26, 59.47, 0.467, 0.103),
    profitSpec('sku-8xl-yellow', '8XL · 黄色', ['8XL', '黄色'], 41.5, 10.11, 34.62, 0.2718, 0.24, { isSuggested: true })
  ],
  queue: [
    { key: 'sku-xl-yellow', sourceSkuIds: ['sku-xl-yellow'], count: 1, label: 'XL · 黄色', values: [['XL'], ['黄色']],
      priceCny: 20.5, weightKg: 0.103, chargeableKg: 0.103, freightRmb: 6.26, allInPurchaseRmb: 24,
      unitProfitRmb: 59.47, marginRate: 0.467, breakEvenRub: 658, thresholdRub: 820, thresholdBasis: 'margin',
      extraHandling: { currentRmb: 3, thresholdRmb: 19.1, thresholdBasis: 'margin', headroomRmb: 40.37, breakRmb: 43.37 } },
    { key: 'sku-8xl-yellow', sourceSkuIds: ['sku-8xl-yellow'], count: 1, label: '8XL · 黄色', values: [['8XL'], ['黄色']],
      priceCny: 41.5, weightKg: 0.24, chargeableKg: 0.24, freightRmb: 10.11, allInPurchaseRmb: 45,
      unitProfitRmb: 34.62, marginRate: 0.2718, breakEvenRub: 1069, thresholdRub: 1331, thresholdBasis: 'margin',
      extraHandling: { currentRmb: 3, thresholdRmb: 19.1, thresholdBasis: 'margin', headroomRmb: 15.52, breakRmb: 18.52 } }
  ],
  commission: { bands: [{ rate: 0.12, minRub: 0, maxRub: 1500, tier: 'le1500' },
    { rate: 0.14, minRub: 1500.01, maxRub: 5000, tier: '1500_5000' }],
    current: { rate: 0.12, minRub: 0, maxRub: 1500, tier: 'le1500' },
    next: { rate: 0.14, minRub: 1500.01, maxRub: 5000, tier: '1500_5000' } },
  supply: { productUrl: 'https://detail.1688.com/offer/943009939489.html', offerId: '943009939489',
    observedOn: '2026-09-13', declaredGoodsPriceRmb: 20.5, unitDomesticFreight: 3.5, otherPurchaseCosts: 0,
    dimensionsCm: { length: 25, width: 22, height: 2.5 }, targetSalePriceRub: 1600 },
  submissionBase: { dataRevision: 4, sourceCandidateId: 'candidate:synthetic-product-page', sourceDataRevision: 4,
    targetPlatform: 'ozon', storeRef: { stableStoreId: 'miska', platformStoreId: 'synthetic-seller', mappingVersion: 'synthetic-stores-v1' },
    targetSalePriceRub: 1600, snapshotId: marketSnapshot.snapshotId, confidence: 'unknown',
    captureId: 'SCJ-synthetic-choice', productUrl: 'https://detail.1688.com/offer/943009939489.html',
    unitDomesticFreight: 3.5, otherPurchaseCosts: 0, dimensionsCm: { length: 25, width: 22, height: 2.5 } },
  baseGaps: [], ...extra
});
/**
 * 运输属性 — the block that sits before the confirm button. The server works out the proposal, the evidence sentence
 * and whether the declaration is complete; the page only lays them out. The fixture below is the shape that record
 * has, both before the owner has confirmed and after.
 */
const CARGO_FULL_FACTS = { batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true, irregularShape: false };
const CARGO_HEADLINE = '这件是普货、不带电、不是异形件，按个人自用一单一件发出。';
const cargoBasis = () => [
  { field: 'batteryType', label: '带不带电', value: 'none',
    because: '依据采到的类别「雨衣」、全部 3 项属性、商品标题里没有出现电池／锂电／充电／发热／USB／电动／遥控这类字样。' },
  { field: 'generalCargo', label: '是不是普货', value: true,
    because: '依据采到的类别「雨衣」里没有出现带磁／液体／粉末／刀具这类字样，采到的属性里也没有写牌子。' },
  { field: 'personalUse', label: '个人自用还是商业用', value: true, because: '依据这次采到的 1688 报价里写着起订量 1 件。' },
  { field: 'irregularShape', label: '是不是异形件', value: false, because: '依据你在「找货」里填的打包尺寸是 25×22×2.5 厘米 的方盒子。' }
];
const cargoFields = () => [
  { field: 'batteryType', label: '带不带电', options: [{ value: 'none', label: '不带电' }, { value: 'installed', label: '电池装在里面' },
    { value: 'standalone', label: '单独的电池' }, { value: 'unknown', label: '我也说不准' }] },
  { field: 'batteryEnergyWh', label: '电池瓦时（Wh）', options: null },
  { field: 'generalCargo', label: '是不是普货', options: [{ value: true, label: '是普货' }, { value: false, label: '不是普货' }, { value: null, label: '我也说不准' }] },
  { field: 'personalUse', label: '个人自用还是商业用', options: [{ value: true, label: '个人自用' }, { value: false, label: '商业用途' }, { value: null, label: '我也说不准' }] },
  { field: 'irregularShape', label: '是不是异形件', options: [{ value: false, label: '不是异形件' }, { value: true, label: '是异形件' }, { value: null, label: '我也说不准' }] }
];
const cargoStep = (extra = {}) => ({
  schemaVersion: 'cargo-facts-step-v1', candidateId: 'candidate:synthetic-product-page', dataRevision: 4,
  declared: false, declaration: null,
  proposal: { ...CARGO_FULL_FACTS }, basis: cargoBasis(), undecided: [], headline: CARGO_HEADLINE,
  fields: cargoFields(), gate: { ready: false, reason: '还没有确认这件商品的运输属性。软件要先知道它带不带电、是不是普货，才能核验线路收不收这件货。' },
  ...extra
});
const cargoDeclared = (extra = {}) => cargoStep({
  declared: true,
  declaration: { declaredAt: '2026-09-13T02:00:00.000Z', declaredRevision: 3, headline: CARGO_HEADLINE,
    facts: { ...CARGO_FULL_FACTS, sourceRef: 'owner-cargo-facts:candidate:synthetic-product-page:3:2026-09-13T02:00:00.000Z' },
    basis: cargoBasis(), matchesProposal: true },
  gate: { ready: true, reason: '' }, ...extra
});
// 类目那一小块。默认给一条「已经是真实读过的页面给的」，因为下面这些用例核的是别的东西；
// 类目本身不成立时会挡住确认按钮，那条由 tests/ozon-category-read-step.test.mjs 单独核。
const CATEGORY_PATH = 'Товары для животных > Одежда и обувь для животных > Одежда для собак';
const categoryReadStep = (extra = {}) => ({
  schemaVersion: 'ozon-category-read-step-v1', candidateId: 'candidate:synthetic-product-page', dataRevision: 4,
  ready: true, readySource: 'real_page_snapshot', category: CATEGORY_PATH,
  categoryFrom: '真实打开过的 Ozon 商品页', categoryCollectorMode: 'real_page_read_only',
  target: { productId: '3605840795', productUrl: 'https://www.ozon.ru/product/3605840795/', from: 'sales_snapshot:fixture-sales' },
  blocked: null, lastRead: null, inFlight: false,
  why: `这件商品的类目「${CATEGORY_PATH}」是软件真实打开 Ozon 商品页读到的，算利润可以用它。`,
  scopeLine: '读的时候软件只用你自己的浏览器打开这一个商品页看一眼，不下单、不联系任何人，也不向 Ozon 写任何东西。',
  action: { label: '读一次这个 Ozon 页面', available: false, reason: '这件商品的类目已经是真实读过的页面给的，不用再读一次。' },
  ...extra
});
/**
 * 每单额外操作费那一小块。默认给一份「已经声明过」的记录，因为下面这些用例核的是别的东西；没声明时它会挡住确认
 * 按钮，那一条由本文件末尾那个用例单独核。
 */
const extraHandlingStep = (extra = {}) => ({
  schemaVersion: 'extra-handling-fees-step-v1', candidateId: 'candidate:synthetic-product-page', dataRevision: 4,
  label: '每单额外操作费', status: 'consistent', declared: true, totalRmb: 3,
  items: [{ name: '包材', amountRmb: 1.5 }, { name: '拆单费', amountRmb: 1.5 }],
  declaredAt: '2026-09-15T02:00:00.000Z', declaredRevision: 3,
  headline: '每单额外操作费 ¥3.00：包材 ¥1.50 ＋ 拆单费 ¥1.50。',
  proposal: { items: [], totalRmb: 0, headline: '每单额外操作费 ¥0.00：这件商品你声明了不用另外加钱。' },
  nameSuggestions: ['包材', '拆单费', '合包费', '额外材料费'], maxItems: 12,
  gate: { ready: true, reason: '' }, ...extra
});
const EXTRA_HANDLING_NOT_DECLARED_WHY = '这件商品还没声明每单额外操作费——包材、拆单费、合包费、额外材料费这一类，' +
  '每单要另外花的钱。不用加钱就一键确认 ¥0.00；要加就写上名目和金额。下面的利润在你声明之前只是暂按 ¥0.00 算的。';
const extraHandlingNotDeclared = (extra = {}) => extraHandlingStep({
  status: 'absent', declared: false, totalRmb: null, items: [], declaredAt: null, declaredRevision: null,
  headline: null, gate: { ready: false, reason: EXTRA_HANDLING_NOT_DECLARED_WHY }, ...extra
});
const profitProps = (reviewExtra = {}, extra = {}, cargo = cargoDeclared(), category = categoryReadStep(),
  commission = null, extraHandling = extraHandlingStep()) => props({
  candidate: candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] }) }),
  view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot,
    skuChoiceTableV1: choiceTable({ selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] }),
    profitStepV1: profitReview(reviewExtra), cargoFactsStepV1: cargo, ozonCategoryReadStepV1: category,
    commissionEstimateStepV1: commission, extraHandlingFeesStepV1: extraHandling },
  onChooseSkus: forbidden, onConfirmProfitStep: forbidden, onDeclareCargoFacts: forbidden,
  onDeclareExtraHandlingFees: forbidden, onReadOzonPage: forbidden, ...extra
});

test('选定规格之后走到算利润：整套一起核线，不过线的自动排除并说明原因', async () => {
  const { profitStepOpen, profitStepCohortHeadline, profitStepThresholdLine, profitStepExcludedLine } = await pageModule();
  const chosen = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow'] }) });
  assert.equal(profitStepOpen(chosen, { profitStepV1: profitReview() }), true);
  // 还没选定规格、或者服务端还没算出这一步，都不显示。
  assert.equal(profitStepOpen(candidate({ sourceCapture: waitingCapture() }), { profitStepV1: profitReview() }), false);
  assert.equal(profitStepOpen(chosen, { profitStepV1: null }), false);

  assert.equal(profitStepCohortHeadline(profitReview()), '这一套 3 个变体，2 个过线，1 个没到本店门槛');
  assert.equal(profitStepCohortHeadline(profitReview({ total: 3, passCount: 3, excludedCount: 0 })), '这一套 3 个变体，全部过线');
  // 门槛的两个数字取自本店成本政策，页面不写死。
  assert.equal(profitStepThresholdLine(profitReview()), '本店门槛：单件利润 ≥ ¥20.00 或 利润率 ≥ 15%，先达者算过');
  assert.equal(profitStepThresholdLine(profitReview({ threshold: { minimumUnitProfitRmb: 25, targetMarginRate: 0.3, thresholdPolicy: 'both' } })),
    '本店门槛：单件利润 ≥ ¥25.00 且 利润率 ≥ 30%，两个都要到');
  // 排除的理由说的是它自己的两个数字，以及各差多少。
  assert.equal(profitStepExcludedLine(profitReview().excluded[0]),
    '8XL · 藏青色：单件利润 ¥16.12 · 利润率 13%（差 ¥3.88，差 2.3 个百分点）');
  assert.equal(profitStepExcludedLine({ label: '8XL · 灰色', kind: 'not_priced', missing: ['规格重量'] }),
    '8XL · 灰色：算不出利润，缺规格重量');

  const html = await render(profitProps());
  assert.match(html, /<section class="product-section product-profit" aria-label="算利润">/u);
  assert.match(html, /这一步不再让你挑哪个最赚/u);
  assert.match(html, /<h4>这一套 3 个变体，2 个过线，1 个没到本店门槛<\/h4>/u);
  assert.match(html, /本店门槛：单件利润 ≥ ¥20.00 或 利润率 ≥ 15%，先达者算过/u);
  assert.match(html, /<ul class="product-profit-excluded" aria-label="不过线，已排除">/u);
  assert.match(html, /8XL · 藏青色：单件利润 ¥16\.12 · 利润率 13%（差 ¥3\.88，差 2\.3 个百分点）/u);
  // 区间和「不过线，已排除」的条数都照记录说。
  assert.match(html, /¥34\.62 – ¥59\.47/u);
  assert.match(html, /27% – 47%/u);
  // 这一步在场时，下面就不再折一个空的「算利润」出来。
  assert.doesNotMatch(html, /<summary>算利润<span/u);
});

test('先上这一个：默认建议同尺码那一个，算式摊开，其余排队', async () => {
  const { profitStepFirstSkuId, profitStepSuggestionLine, profitStepCommissionLine } = await pageModule();
  const review = profitReview();
  // 主人没指定时用建议；他指定过的那一个只要还在表里就一直算他的。
  assert.equal(profitStepFirstSkuId(review, null), 'sku-8xl-yellow');
  assert.equal(profitStepFirstSkuId(review, 'sku-xl-yellow'), 'sku-xl-yellow');
  // 指定的那一个已经不在表里（比如重新采过），就退回建议，绝不带着一个不存在的规格提交。
  assert.equal(profitStepFirstSkuId(review, 'sku-gone'), 'sku-8xl-yellow');
  assert.equal(profitStepFirstSkuId(profitReview({ suggestedSkuId: null }), null), null);
  assert.match(profitStepSuggestionLine(review), /标题里写着 8XL/u);
  // 对标标题里判断不出规格时，页面直说判断不出来，不瞎猜。
  assert.match(profitStepSuggestionLine(profitReview({ benchmark: { matchedValue: null } })),
    /标题里没写规格，软件判断不出该先上哪一个，你自己定/u);
  // 档位分界线取自官方表，不是页面里写死的 1500。
  assert.match(profitStepCommissionLine(review), /售价跨过 1500 卢布，官方佣金就从 12% 跳到 14%/u);
  assert.match(profitStepCommissionLine(profitReview({ commission: { bands: [], current: null, next: null } })),
    /售价跨过官方佣金的档位分界线，费率会换一档/u);

  const html = await render(profitProps());
  assert.match(html, /<h4>先上这一个，跑通上架通路<\/h4>/u);
  assert.match(html, /其余 1 个在同一张卡上追加，内容不重做/u);
  assert.match(html, /<select id="profit-first-variant"[^>]*>/u);
  assert.match(html, /8XL · 黄色.*（建议）/u);
  // 算式的每一项都在，并且是这一个规格自己的运费。
  assert.match(html, /<dt>成交收入<\/dt><dd>¥127\.35<\/dd>/u);
  assert.match(html, /<dt>官方佣金 14%<\/dt><dd>−¥17\.82<\/dd>/u);
  assert.match(html, /<dt>国际运费<\/dt><dd>−¥10\.11 · GUOO Economy Extra Small · 计费 0\.24 公斤<\/dd>/u);
  assert.match(html, /<dt>到手采购<\/dt><dd>−¥45\.00<\/dd>/u);
  assert.match(html, /<dt>每单额外操作费<\/dt><dd>−¥3\.00 · 你声明的<\/dd>/u);
  assert.match(html, /<dt>贴标<\/dt><dd>−¥1\.50<\/dd>/u);
  assert.match(html, /<dt>店铺预留 12%<\/dt><dd>−¥15\.28<\/dd>/u);
  assert.match(html, /<dd class="product-sku-profit">¥34\.62 · 利润率 27%<\/dd>/u);
  // 排队表给每个规格自己的保本价和达标最低售价，先上的那一行标出来。
  assert.match(html, /<th scope="col">保本价<\/th><th scope="col">达标最低售价<\/th>/u);
  assert.match(html, /658 卢布/u);
  assert.match(html, /820 卢布/u);
  assert.match(html, /1069 卢布/u);
  assert.match(html, /1331 卢布/u);
  assert.match(html, /<tr class="product-sku-row-on">/u);
  assert.match(html, /<b> · 先上<\/b>/u);
});

test('两个勾选都勾上才能提交，页面价与找货价的差额就写在勾选旁边', async () => {
  const { profitStepPriceDeltaLine, profitStepSubmitState } = await pageModule();
  const review = profitReview();
  const spec = review.specifications.find(item => item.sourceSkuId === 'sku-8xl-yellow');
  assert.equal(profitStepPriceDeltaLine(spec),
    '你在「找货」里填的货价是 ¥20.50；这一步按这个规格自己的页面价 ¥41.50 算，页面价比你填的贵 ¥21.00。');
  // 页面价和找货填的一样时没有这句话。
  assert.equal(profitStepPriceDeltaLine(review.specifications[0]), null);
  assert.match(profitStepPriceDeltaLine({ priceDelta: { pageRmb: 20.2, declaredRmb: 20.5, deltaRmb: -0.3 } }),
    /页面价比你填的便宜 ¥0\.30。$/u);

  const base = { review, firstSkuId: 'sku-8xl-yellow', gaps: [] };
  assert.equal(profitStepSubmitState({ ...base, comparabilityConfirmed: false, supplyConfirmed: false }).ready, false);
  assert.equal(profitStepSubmitState({ ...base, comparabilityConfirmed: true, supplyConfirmed: false }).ready, false);
  assert.equal(profitStepSubmitState({ ...base, comparabilityConfirmed: false, supplyConfirmed: true }).ready, false);
  assert.equal(profitStepSubmitState({ ...base, comparabilityConfirmed: true, supplyConfirmed: false }).hint,
    '两件都确认后才能进入下一步。');
  const ready = profitStepSubmitState({ ...base, comparabilityConfirmed: true, supplyConfirmed: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.hint, '8XL · 黄色 先上，其余 1 个变体排队等同一张卡追加。');
  // 一个变体都没指定时也不能提交。
  assert.equal(profitStepSubmitState({ review, firstSkuId: null, gaps: [], comparabilityConfirmed: true, supplyConfirmed: true }).ready, false);

  const html = await render(profitProps());
  assert.match(html, /<h4>只有你能确认的两件事<\/h4>/u);
  assert.match(html, /<b>这两件商品是可比的同类<\/b>/u);
  assert.match(html, /Ozon 3605840795/u);
  assert.match(html, /Водонепроницаемый дождевик для собак, светоотражающий -8XL/u);
  assert.match(html, /1457 卢布/u);
  assert.match(html, /快照采于 2026-09-11/u);
  assert.match(html, /<b>链接、规格、成本、包装是同一套采购方案<\/b>/u);
  assert.match(html, /https:\/\/detail\.1688\.com\/offer\/943009939489\.html/u);
  assert.match(html, /货价 ¥41\.50（这个规格在 1688 页面上自己的价） ＋ 国内运费 ¥3\.50（你填的） ＋ 其他采购费用 ¥0\.00 ＝ 到手 ¥45\.00/u);
  assert.match(html, /打包 0\.24 公斤 · 25×22×2\.5 厘米/u);
  assert.match(html, /<p class="product-profit-delta">你在「找货」里填的货价是 ¥20\.50；/u);
  assert.match(html, /其他采购费用按 ¥0\.00 算：你在「找货」里只填了货价和国内运费/u);
  // 两个勾选都还没勾，按钮就是不可点的。
  assert.match(html, /<button type="button" class="button primary" disabled[^>]*>确认，进入文案素材<\/button>/u);
  assert.match(html, /两件都确认后才能进入下一步。/u);
  // 渲染这一步不会向服务端发任何东西。
  assert.doesNotMatch(html, /RENDER_MUST_NOT_START_WORK/u);

  // 主人签过同重同价之后，页面从来没给过这个规格一个价，这句话就不许再说成「页面上自己的价」。
  const declared = await render(profitProps({
    specifications: profitReview().specifications.map(item => item.sourceSkuId === 'sku-8xl-yellow'
      ? { ...item, priceCny: 20.5, unitProductPrice: 20.5, actualPurchaseCost: 24, priceDelta: null,
        priceBasis: 'owner_declared', weightBasis: 'owner_declared' }
      : item)
  }));
  assert.match(declared,
    /货价 ¥20\.50（页面没有按规格分列价格，这是你在「找货」里填的） ＋ 国内运费 ¥3\.50（你填的） ＋ 其他采购费用 ¥0\.00 ＝ 到手 ¥24\.00/u);
  assert.match(declared, /打包 0\.24 公斤（你填的） · 25×22×2\.5 厘米/u);
  assert.match(declared, /你的货：1688 943009939489 8XL · 黄色，货价 ¥20\.50（你填的），打包 0\.24 公斤（你填的）/u);
  assert.doesNotMatch(declared, /¥20\.50（这个规格在 1688 页面上自己的价）/u);
  // 页面从没给过这个规格一个价，所以也没有「页面价比你填的差多少」这句话。
  assert.doesNotMatch(declared, /<p class="product-profit-delta">/u);
});

test('资料凑不齐就如实列出来并禁用提交，页面不替主人补一个像样的数字', async () => {
  const { profitStepSubmitState } = await pageModule();
  const gaps = [{ field: 'unitDomesticFreight', label: '国内运费', why: '你在「找货」里还没有填国内运费，包邮请填 0。' }];
  const blocked = profitStepSubmitState({ review: profitReview(), firstSkuId: 'sku-8xl-yellow',
    comparabilityConfirmed: true, supplyConfirmed: true, gaps });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.hint, '资料还缺东西，先补齐下面列出的这几项才能确认。');
  assert.deepEqual(blocked.gaps, gaps);

  const html = await render(profitProps({
    baseGaps: [{ field: 'unitDomesticFreight', label: '国内运费', why: '你在「找货」里还没有填国内运费，包邮请填 0。' }],
    submissionBase: null
  }));
  assert.match(html, /<div class="product-profit-gaps" role="alert">/u);
  assert.match(html, /<h4>还差这些，现在不能确认<\/h4>/u);
  assert.match(html, /<b>国内运费<\/b>：你在「找货」里还没有填国内运费，包邮请填 0。/u);
  // 其他采购费用报不出来时，那句「按 ¥0.00 算」就不能出现——它是软件替主人报的一个数，不是随口的安慰。
  const noFreight = await render(profitProps({
    supply: { ...profitReview().supply, unitDomesticFreight: null, otherPurchaseCosts: null },
    baseGaps: [{ field: 'unitDomesticFreight', label: '国内运费', why: '你在「找货」里还没有填国内运费，包邮请填 0。' }],
    submissionBase: null
  }));
  assert.doesNotMatch(noFreight, /其他采购费用按 ¥0\.00 算/u);
  assert.match(html, /其他采购费用按 ¥0\.00 算/u, '能报出来时这句话要在，主人才知道这个 0 是哪来的');
  assert.match(html, /<button type="button" class="button primary" disabled[^>]*>确认，进入文案素材<\/button>/u);
  assert.match(html, /资料还缺东西，先补齐下面列出的这几项才能确认。/u);

  // 采集里缺「一件可买」的凭据时，缺的是那一条，说的也是那一条。
  const missingEvidence = await render(profitProps({
    specifications: profitReview().specifications.map(item => item.sourceSkuId === 'sku-8xl-yellow'
      ? { ...item, quantityOneEvidenceSourceNote: null, gaps: [{ field: 'quantityOneEvidenceSourceNote',
        label: '一件可买的凭据', why: '这一次采集没有读到「一件起订」的报价，软件不会替你写这句话；重新采集一次这个 1688 页面再来。' }] }
      : item)
  }));
  assert.match(missingEvidence, /<b>一件可买的凭据<\/b>：这一次采集没有读到「一件起订」的报价/u);
  assert.match(missingEvidence, /<button type="button" class="button primary" disabled[^>]*>确认，进入文案素材<\/button>/u);
});

test('运输属性：一行结论、一句依据、一个确认按钮，就摆在「确认，进入文案素材」之前', async () => {
  const { cargoFactsHeadline, cargoFactsFormState, cargoFactsPayload } = await pageModule();

  assert.equal(cargoFactsHeadline(cargoStep()), CARGO_HEADLINE);
  assert.equal(cargoFactsHeadline(cargoDeclared()), CARGO_HEADLINE);
  assert.equal(cargoFactsHeadline(cargoStep({ headline: null })), null);
  // 表单从已保存的那份起手；还没确认过就从软件的提议起手。
  assert.deepEqual(cargoFactsFormState(cargoStep()), { ...CARGO_FULL_FACTS, batteryEnergyWh: '' });
  assert.deepEqual(cargoFactsFormState(cargoDeclared()), { ...CARGO_FULL_FACTS, batteryEnergyWh: '' });
  assert.deepEqual(cargoFactsFormState(cargoStep({ proposal: { batteryType: null, batteryEnergyWh: null,
    generalCargo: null, personalUse: true, irregularShape: false } })),
    { batteryType: null, batteryEnergyWh: '', generalCargo: null, personalUse: true, irregularShape: false });

  // 提交的是封闭的一份：当前修订号加那五项，空着的瓦时就是没填。
  assert.deepEqual(cargoFactsPayload(cargoFactsFormState(cargoStep()), 4), { dataRevision: 4, ...CARGO_FULL_FACTS });
  assert.deepEqual(cargoFactsPayload({ batteryType: 'installed', batteryEnergyWh: '96', generalCargo: false,
    personalUse: true, irregularShape: false }, 9),
    { dataRevision: 9, batteryType: 'installed', batteryEnergyWh: 96, generalCargo: false, personalUse: true, irregularShape: false });
  for (const energy of ['', '  ', 'abc', '0', '-3']) {
    assert.equal(cargoFactsPayload({ batteryType: 'installed', batteryEnergyWh: energy }, 1).batteryEnergyWh, null, energy);
  }

  const html = await render(profitProps({}, {}, cargoStep()));
  assert.match(html, /<div class="product-profit-cargo">/u);
  assert.match(html, /<h4>这件货是什么，运输上得先说清楚<\/h4>/u);
  assert.match(html, /软件只按它真看到的东西提议，判断不了的让你选/u);
  assert.match(html, new RegExp(`<p class="product-cargo-headline">${CARGO_HEADLINE}</p>`, 'u'));
  assert.match(html, /依据采到的类别「雨衣」、全部 3 项属性、商品标题里没有出现电池／锂电／充电／发热／USB／电动／遥控这类字样。/u);
  assert.match(html, /确认只是记下你对这件货的说法，不会下单、不会联系供应商、也不会向 Ozon 写任何东西。/u);
  // 这一块在确认按钮之前。
  assert.ok(html.indexOf('product-profit-cargo') < html.indexOf('确认，进入文案素材'));
  // 四项全提议得出来时不摆四个下拉，只有「逐项修改」。
  assert.doesNotMatch(html, /<div class="product-cargo-ask">/u);
  assert.match(html, /逐项修改<\/button>/u);
});

test('判不定的那几项才变成选择，并且说清楚软件为什么不敢提议；已确认之后显示存档的那句话', async () => {
  const partial = cargoStep({
    proposal: { batteryType: null, batteryEnergyWh: null, generalCargo: null, personalUse: true, irregularShape: false },
    basis: cargoBasis().filter(item => ['personalUse', 'irregularShape'].includes(item.field)),
    undecided: [
      { field: 'batteryType', label: '带不带电', why: '采到的商品标题里写着「充电」，软件不敢替你说这件不带电，你来选。' },
      { field: 'generalCargo', label: '是不是普货', why: '属性「品牌」写的是「阿迪达斯」，不是「无」；牌子真假软件判断不了，仿牌走不了普货线路，你来选。' }
    ],
    headline: null
  });
  const html = await render(profitProps({}, {}, partial));
  assert.match(html, /这几项里有软件判断不了的，下面标出来了，那几项要你自己选。/u);
  assert.match(html, /<div class="product-cargo-ask">/u);
  assert.match(html, /采到的商品标题里写着「充电」，软件不敢替你说这件不带电，你来选。/u);
  assert.match(html, /牌子真假软件判断不了，仿牌走不了普货线路，你来选。/u);
  assert.match(html, /<select id="cargo-batteryType"/u);
  assert.match(html, /<select id="cargo-generalCargo"/u);
  // 判得出来的那两项不变成选择器，它们是依据里那两句话。
  assert.doesNotMatch(html, /<select id="cargo-personalUse"/u);
  assert.match(html, /依据这次采到的 1688 报价里写着起订量 1 件。/u);

  // 一项也判不出来的时候如实说。
  const blind = await render(profitProps({}, {}, cargoStep({ proposal: { batteryType: null, batteryEnergyWh: null,
    generalCargo: null, personalUse: null, irregularShape: null }, basis: [], headline: null,
    undecided: cargoFields().filter(item => item.options !== null).map(item => ({ field: item.field, label: item.label,
      why: '这件商品还没有采到属性和标题，软件手上没有可以依据的东西，这几项只能你自己选。' })) })));
  assert.match(blind, /这件商品软件一项也判断不了，下面这几项要你自己选。/u);

  const declared = await render(profitProps());
  assert.match(declared, /<span>已确认<\/span>/u);
  assert.match(declared, new RegExp(`<p class="product-cargo-headline">${CARGO_HEADLINE}</p>`, 'u'));
  assert.match(declared, /你在 2026-09-13 确认的，记录里写明是你确认的。/u);
  assert.match(declared, /改成这样<\/button>/u);
});

test('运输属性没确认，「算利润」的确认按钮就不可点，并把原因说在缺项单里', async () => {
  const { cargoFactsStepGaps } = await pageModule();
  const gap = { field: 'cargoFacts', label: '运输属性',
    why: '还没有确认这件商品的运输属性。软件要先知道它带不带电、是不是普货，才能核验线路收不收这件货。' };
  assert.deepEqual(cargoFactsStepGaps(cargoStep()), [gap]);
  assert.deepEqual(cargoFactsStepGaps(cargoDeclared()), []);
  // 读不到这一块时按钮同样不亮：宁可不亮，也不让主人点了才吃服务端的 422。
  assert.equal(cargoFactsStepGaps(null).length, 1);
  assert.equal(cargoFactsStepGaps(undefined).length, 1);
  // 确认里还留着「说不准」时，说的是服务端那句为什么还不行。
  assert.deepEqual(cargoFactsStepGaps(cargoDeclared({ gate: { ready: false,
    reason: '运输属性里还有「带不带电」你标着说不准；线路核验用不了说不准的值，补一下再确认。' } })),
    [{ ...gap, why: '运输属性里还有「带不带电」你标着说不准；线路核验用不了说不准的值，补一下再确认。' }]);

  const html = await render(profitProps({}, {}, cargoStep()));
  assert.match(html, /<div class="product-profit-gaps" role="alert">/u);
  assert.match(html, /<b>运输属性<\/b>：还没有确认这件商品的运输属性。软件要先知道它带不带电、是不是普货，才能核验线路收不收这件货。/u);
  assert.match(html, /<button type="button" class="button primary" disabled[^>]*>确认，进入文案素材<\/button>/u);
  assert.match(html, /资料还缺东西，先补齐下面列出的这几项才能确认。/u);
});

// 2026-09-14：类目来自 Seerfar 接口，服务端只认真实读过的页面，主人点了确认才吃到那句 B_EVIDENCE_CONTEXT_INCOMPLETE。
const categoryNotRead = (extra = {}) => categoryReadStep({
  ready: false, readySource: null, categoryFrom: 'Seerfar 的接口结果', categoryCollectorMode: 'provider_category_result_read_only',
  category: '宠物用品 > 宠物服装和靴子 > 宠物服装',
  why: '算利润要用的类目，必须来自真实打开过的 Ozon 商品页。现在这条类目「宠物用品 > 宠物服装和靴子 > 宠物服装」是 Seerfar 的接口结果给的，不是页面上读到的，所以这一步还不能确认。',
  action: { label: '读一次这个 Ozon 页面', available: true, reason: '' }, ...extra
});

test('类目还不是真实页面读来的，「算利润」的确认按钮就不可点，并把出路摆在按钮前面', async () => {
  const { ozonCategoryStepGaps, ozonPageReadOutcomeLine } = await pageModule();
  const step = categoryNotRead();
  assert.deepEqual(ozonCategoryStepGaps(step), [{ field: 'ozonCategory', label: '当前类目', why: step.why }]);
  assert.deepEqual(ozonCategoryStepGaps(categoryReadStep()), []);
  // 读不到这一块时按钮同样不亮：宁可不亮，也不让主人点了才吃服务端那个 422。
  assert.equal(ozonCategoryStepGaps(null).length, 1);
  assert.equal(ozonCategoryStepGaps(undefined).length, 1);

  const html = await render(profitProps({}, {}, cargoDeclared(), step));
  assert.match(html, /<div class="product-profit-category" role="group" aria-label="这条类目是哪儿来的">/u);
  assert.match(html, /这条类目还不是从 Ozon 页面上读来的/u);
  assert.match(html, /现在这条类目「宠物用品 &gt; 宠物服装和靴子 &gt; 宠物服装」是 Seerfar 的接口结果给的/u);
  assert.match(html, /不下单、不联系任何人，也不向 Ozon 写任何东西/u);
  assert.match(html, /要读的页面：https:\/\/www\.ozon\.ru\/product\/3605840795\//u);
  assert.match(html, /<button type="button" class="button primary">读一次这个 Ozon 页面<\/button>/u);
  assert.match(html, /<b>当前类目<\/b>：算利润要用的类目，必须来自真实打开过的 Ozon 商品页。/u);
  assert.match(html, /<button type="button" class="button primary" disabled[^>]*>确认，进入文案素材<\/button>/u);

  // 类目已经是真实读过的页面给的，这一小块就不出现——没有事要主人做，缺项单里也不再有「当前类目」。
  const ready = await render(profitProps());
  assert.doesNotMatch(ready, /product-profit-category/u);
  assert.doesNotMatch(ready, /读一次这个 Ozon 页面/u);
  assert.doesNotMatch(ready, /product-profit-gaps/u);
  assert.match(ready, /两件都确认后才能进入下一步。/u, '这时候挡着的只剩主人自己那两个勾');

  // 上一次读页面的结局原样说出来；等插件的时候按钮不给点，也不承诺重试。
  assert.equal(ozonPageReadOutcomeLine(categoryReadStep()), null);
  const waiting = categoryNotRead({ inFlight: true, lastRead: { captureId: 'OPR-1', status: 'waiting_extension', jobStatus: 'queued' },
    action: { label: '读一次这个 Ozon 页面', available: false, reason: '上一次读这个页面还没有结束，等它结束之后再说。' } });
  assert.match(ozonPageReadOutcomeLine(waiting), /还没有结果/u);
  const waitingHtml = await render(profitProps({}, {}, cargoDeclared(), waiting));
  assert.match(waitingHtml, /<button type="button" class="button primary" disabled[^>]*>读一次这个 Ozon 页面<\/button>/u);
  assert.match(waitingHtml, /上一次读这个页面还没有结束，等它结束之后再说。/u);
  const stopped = categoryNotRead({ lastRead: { captureId: 'OPR-2', status: 'failed', failureCode: 'site_verification_required',
    reason: 'Ozon页面要求人工完成验证', writeOccurred: false } });
  assert.match(ozonPageReadOutcomeLine(stopped), /上一次没读成：Ozon页面要求人工完成验证。软件不会自动重试。/u);
  assert.match(await render(profitProps({}, {}, cargoDeclared(), stopped)), /上一次没读成：Ozon页面要求人工完成验证。/u);
});

test('运输属性走自己的接口，只记录主人的说法，不经过算利润那条确认路', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const page = await readFile(fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url)), 'utf8');
  const api = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(api, /lifecycle\/cargo-facts/u);
  assert.match(app, /onDeclareCargoFacts=\{payload => runProductStep\(api\.declareCargoFacts, payload\)\}/u);
  assert.match(page, /const declareCargoFacts = payload => run\(onDeclareCargoFacts, payload,/u);
  // 判断这件货是什么的那张词表和那些依据都在 lib 里，页面一个字都不重写；它只摆服务端给的那份记录。
  assert.doesNotMatch(page, /锂电|仿牌|磁吸|起订量 1 件/u, '词表和依据都在 lib 里，页面不重写一份');
  assert.match(page, /step\?\.gate\?\.reason/u, '为什么还不能确认，说的是服务端那句话');
});

test('算利润的确认走既有的 A 阶段确认接口，写操作不经读取守卫', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const page = await readFile(fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url)), 'utf8');
  assert.match(app, /onConfirmProfitStep=\{payload => confirmProductProfitStep\(payload\)\}/u);
  const handler = app.match(/async function confirmProductProfitStep\(payload\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '算利润的确认必须有自己的处理函数');
  // 既有的那条路，不另开一个接口。
  assert.match(handler[0], /runMutation\(\(\)=>api\.confirmRealAStage\(candidateId,payload\)/u);
  assert.doesNotMatch(handler[0], /productDraftReads\.current\.run\(/u,
    '写操作经过“只保留最新读取”的守卫会把服务端的真实回答丢成 null');
  assert.match(handler[0], /await load\(true\);setProductDraftRefresh\(value=>value\+1\);/u);
  // 组装那一份东西的是 lib 里那一个纯函数，页面自己不拼字段。
  assert.match(page, /import \{ profitStepGaps, profitStepSubmission \} from "\.\.\/\.\.\/lib\/profit-step-review\.mjs";/u);
  assert.match(page, /const payload = profitStepSubmission\(profitReview, firstSkuId, judgments\);/u);
  assert.match(page, /if \(payload === null\) \{ setError\("这一份确认还凑不齐，没有提交；请看上面列出的缺项。"\); return undefined; \}/u);
  // 这一页的根节点是 .page-panel，那里的 label 规则是 grid 且限宽；勾选那两条必须压过它，否则方框会掉到文字上面一行。
  const css = await readFile(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  assert.match(css, /\.page-panel \.product-profit-check \{[^}]*flex-direction: row;[^}]*max-width: none;/u);
  assert.ok(css.indexOf('.page-panel .product-profit-check') > css.indexOf('.page-panel label'),
    '同样特指度时靠先后顺序取胜，这条必须排在 .page-panel label 之后');
});

test('精确佣金读不到才出现的那一块：说清四件事，主人勾了才带授权', async () => {
  const { renderCommissionEstimate } = await pageModule();
  // 2026-09-14 现场那一件的真实取值：Miska 店在这条类目的第一件商品。
  const SOURCE_REF = 'ozon-official-commission:2025-12-01:sha256:be7832ff9dbd09ee7021aaefe9018a02287332bc22e4c6b470d6cfe0b3649cf0';
  const estimate = {
    proposal: { commissionRate: 0.12, commissionTier: 'le1500', commissionSourceRef: SOURCE_REF, targetSalePriceRub: 1455 },
    storeLabel: 'Miska', category: 'Товары для животных > Для собак > Одежда > Одежда для животных'
  };
  const html = await renderCommissionEstimate({ estimate, authorized: false, saving: false, onAuthorize: forbidden });

  // 一、为什么读不到：说的是「你店里还没有这条类目的商品」，并且明说重试没用。
  assert.match(html, /<div class="product-profit-commission" role="group" aria-label="估算佣金授权">/u);
  assert.match(html, /<h4>这条类目在Miska里还没有商品，精确佣金读不到<\/h4>/u);
  assert.match(html, /这件是这条类目在Miska的第一件，店里没有同类商品可读，所以读不到。再点几次也还是读不到，这不是网络卡了。/u);
  assert.match(html, /这条类目：Товары для животных &gt; Для собак &gt; Одежда &gt; Одежда для животных/u);
  // 二、拿什么替：前提必须说对。服务端是先让官方费率表自己上，立住了直接返回真证据，主人根本看不到这一块；
  //     所以这一块一出现，就一定是那张表这一次没能自己立成证据。不能写成「官方表好好的，只是还要你多签一次字」。
  assert.match(html, /<span>官方费率表这一次没能自己立成证据，所以要你亲自签这一次<\/span>/u);
  assert.match(html, /能替它的只有 Ozon 官方费率表上的公开费率。这一次软件没能靠那张表自己把这件商品的佣金证据立起来——立住了你根本不会看见这一块，软件会直接按它算完往下走，用不着你签字。/u);
  // 费率、档位、来源引用、目标成交价，全部来自传进来的那份解析结果，页面不写死。
  assert.match(html, /所以现在要你亲自签一次字。你填的目标成交价 1455 卢布落在这一档，页面上这份官方费率表解析给出的是 12%。/u);
  assert.match(html, /费率 12% · 档位 le1500 · 目标成交价 1455 卢布/u);
  assert.match(html, new RegExp(`取自 ${SOURCE_REF}`, 'u'));
  assert.match(html, /价格跨过档位分界线就换一档，这里显示的也跟着换，不会留着一个旧数/u);
  // 三、会被记成估算佣金，不是精确佣金，也不会进 C1。
  assert.match(html, /这一笔会记成估算佣金，不是精确佣金。这件商品的 B 会停在「条件测算」，不算正式通过，也不会进 C1/u);
  // 四、将来怎么复算：指向仓库里已经有的那条路，不另造一条。
  assert.match(html, /等这条类目在Miska里有了第一件在售商品，店里的实收费率就读得到了/u);
  assert.match(html, /「条件测算已保存，等更好的费用证据」那张卡，点「用更好的费用证据重算」/u);
  // 那个勾，以及不勾会怎么样。
  assert.match(html, /<input type="checkbox" id="profit-commission-estimate"\/>/u);
  assert.doesNotMatch(html, /checked=""/u);
  assert.match(html, /<b>先按官方费率表的 12% 算，记成估算佣金<\/b>/u);
  assert.match(html, /不勾就不带这个授权，这一次确认还是会停在同一处。/u);
  assert.match(html, /这个授权只管这一件、这一版资料、这一个费率/u);
  assert.match(await renderCommissionEstimate({ estimate, authorized: true, saving: false, onAuthorize: forbidden }),
    /id="profit-commission-estimate" checked=""/u);

  // 跨过 1500 卢布分界线的时候，显示的就是另一档：这一块不记数，只照那份解析结果说。
  const higher = await renderCommissionEstimate({ authorized: false, saving: false, onAuthorize: forbidden,
    estimate: { ...estimate, proposal: { ...estimate.proposal, commissionRate: 0.14, commissionTier: 'le5000', targetSalePriceRub: 1666 } } });
  assert.match(higher, /费率 14% · 档位 le5000 · 目标成交价 1666 卢布/u);
  assert.doesNotMatch(higher, /12%/u);

  // 费率、档位或来源引用拿不齐：软件什么也不提议，也就没有那个勾可点。这里的前提同样要说对。
  const refused = await renderCommissionEstimate({ authorized: false, saving: false, onAuthorize: forbidden,
    estimate: { ...estimate, proposal: null } });
  assert.match(refused, /这一次软件没能靠那张表自己把这件商品的佣金证据立起来/u);
  assert.match(refused, /页面上这份官方费率表解析也连费率、档位和来源引用都拿不齐，软件不会替你写一个数上去/u);
  assert.doesNotMatch(refused, /profit-commission-estimate/u);

  // 没撞上这件事的时候，这一块根本不存在：它不是一个随时可勾的高级选项。
  assert.equal(await renderCommissionEstimate({ estimate: null, authorized: false, saving: false, onAuthorize: forbidden }), '');
  assert.doesNotMatch(await render(profitProps()), /估算佣金授权/u);
});

test('官方佣金表这一次卡在哪几处，逐字摆给主人；服务端没说就一个字都不造', async () => {
  const { renderCommissionEstimate } = await pageModule();
  const SOURCE_REF = 'ozon-official-commission:2025-12-01:sha256:be7832ff9dbd09ee7021aaefe9018a02287332bc22e4c6b470d6cfe0b3649cf0';
  const estimate = {
    proposal: { commissionRate: 0.12, commissionTier: 'le1500', commissionSourceRef: SOURCE_REF, targetSalePriceRub: 1455 },
    storeLabel: 'Miska', category: '宠物用品 > 狗狗 > 服饰'
  };
  const block = async officialGaps => renderCommissionEstimate({ authorized: false, saving: false, onAuthorize: forbidden,
    estimate: { ...estimate, officialGaps } });

  // 有缺口：一句交代 + 逐字的缺口，顺序照服务端说的。主人有权知道那张表本来可以自己成交、这一次为什么没成。
  const gapped = await block(['TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH']);
  assert.match(gapped, /服务端说，官方佣金表这一次卡在这几处（原话照抄）：/u);
  assert.match(gapped, /<li>TYPE_NOT_FOUND<\/li><li>CATALOG_VERSION_MISMATCH<\/li>/u);
  // 缺口摆在「那张表没能自己立成证据」之后：主人先知道这几个码是什么意思，再看那几个码。
  assert.ok(gapped.indexOf('这一次软件没能靠那张表自己把这件商品的佣金证据立起来') < gapped.indexOf('TYPE_NOT_FOUND'));
  // 重复的那几处只摆一次。
  assert.equal((await block(['TYPE_NOT_FOUND', 'TYPE_NOT_FOUND'])).match(/<li>TYPE_NOT_FOUND<\/li>/gu).length, 1);
  // 一个字都不改：大小写、下划线、中文说明，服务端写成什么样就摆成什么样，不概括也不翻译。
  assert.match(await block(['OFFICIAL_TABLE_CATALOG_UNREADABLE', '版本状态 status=stale']),
    /<li>OFFICIAL_TABLE_CATALOG_UNREADABLE<\/li><li>版本状态 status=stale<\/li>/u);
  // 软件拿不出提议的时候，这几处一样要说给主人听。
  assert.match(await renderCommissionEstimate({ authorized: false, saving: false, onAuthorize: forbidden,
    estimate: { ...estimate, proposal: null, officialGaps: ['TYPE_NOT_FOUND'] } }), /<li>TYPE_NOT_FOUND<\/li>/u);

  // 服务端没提官方佣金表（比如这台机器上压根没配）：一个字都不造，那一整段不出现。
  for (const quiet of [undefined, null, [], ['', '   '], 'TYPE_NOT_FOUND', { code: 'TYPE_NOT_FOUND' }]) {
    const html = await block(quiet);
    assert.doesNotMatch(html, /原话照抄/u, JSON.stringify(quiet) ?? 'undefined');
    assert.doesNotMatch(html, /卡在这几处|官方佣金表/u, JSON.stringify(quiet) ?? 'undefined');
    assert.doesNotMatch(html, /<li>TYPE_NOT_FOUND<\/li>/u, JSON.stringify(quiet) ?? 'undefined');
    // 缺口没有不代表这一块不出现：那张表没配的时候，照样只有主人签字这一条路。
    assert.match(html, /这一次软件没能靠那张表自己把这件商品的佣金证据立起来/u, JSON.stringify(quiet) ?? 'undefined');
  }
});

test('那一块在场与否整份由服务端那条已保存的记录说了算，勾了才带授权', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url)), 'utf8');
  // 页面只从服务端那一块读，自己不记「刚才撞上没撞上」——记在内存里，主人一硬刷新就没了，而软件一直在让他刷。
  assert.match(page, /const commissionStep = view\?\.commissionEstimateStepV1 \?\? null;/u);
  assert.match(page, /commissionEstimate=\{commissionStep\?\.present !== true \? null : \{/u);
  assert.doesNotMatch(page, /commissionEstimateSignal/u, '页面内存里那个信号必须整个删掉，不留死代码');
  assert.doesNotMatch(page, /useState\([^)]*\)[^\n]*[Cc]ommissionEstimate/u, '这一块不再有页面自己的状态');
  // 认那两个机器可读码的活整个搬到服务端了：页面连那两个函数都不再 import，更不在自己这儿写死任何一个码。
  assert.match(page, /import \{ commissionEstimateProposal \} from "\.\.\/\.\.\/lib\/commission-estimate-authorization\.mjs";/u);
  assert.doesNotMatch(page, /exactCommissionUnavailable|officialCommissionTableGaps/u, '认码这件事只在服务端做一次');
  assert.doesNotMatch(page, /OZON_EVIDENCE_COMMISSION_UNAVAILABLE|B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED/u, '那两个码只在 lib 里有一份');
  assert.doesNotMatch(page, /店铺当前没有同|官方佣金表未能成交/u, '不靠服务端那几句中文判断，也不自己拆那句话');
  // 服务端说的那几处缺口只是被带下去，页面不改一个字。
  assert.match(page, /officialGaps: commissionStep\.officialGaps/u);
  // 确认失败之后页面什么都不记：那一条路由带回的整份资料里已经有这一块了。
  assert.doesNotMatch(page, /onFailure/u, '失败回调没有别的用处，一并清掉');
  // 费率、档位、来源引用都不在页面里写死，每次渲染都从当前那份解析结果里取——提议从来不进记录。
  assert.match(page, /proposal: commissionEstimateProposal\(skuTable\?\.sources \?\? null\)/u);
  assert.match(page, /proposal\.commissionTier/u);
  assert.match(page, /proposal\.commissionSourceRef/u);
  assert.doesNotMatch(page, /le1500|ozon-official-commission/u, '费率、档位和来源引用一律取自解析结果');
  // 勾了才带授权，费率来自提议本身；没勾就是 false，profitStepSubmission 那边就不带这个字段。
  assert.match(page, /commissionEstimateRate: commissionEstimateAuthorized \? commissionProposal\.commissionRate : null/u);
  assert.match(page, /const commissionEstimateAuthorized = commissionProposal !== null && commissionEstimateTicked;/u);
  // 这一块和运输属性那一块同一套观感，不自创一套。
  const css = await readFile(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  assert.match(css, /\.product-profit-commission \{[^}]*background: var\(--amber-soft\);/u);
});

/**
 * 2026-09-14 那个 bug 在页面这一侧的形状：那一块原来只活在页面内存里，服务端在同一次失败里把物流比较落了盘、
 * 把 dataRevision 顶高一格，页面重读资料时就把它当成旧版本清掉了。现在它整份来自服务端那条已保存的记录，
 * 所以「重读一次资料」「硬刷新一次页面」都是同一件事：记录在，它就在。
 */
test('这一块跟着服务端那条记录走：重读资料它还在，说的不是这一版就照实说', async () => {
  const { renderCommissionEstimate } = await pageModule();
  const step = (extra = {}) => ({ schemaVersion: 'commission-estimate-step-v1',
    candidateId: 'candidate:synthetic-product-page', dataRevision: 29, present: true, current: true,
    recordedRevision: 29, recordedAt: '2026-09-14T06:30:00.000Z', officialGaps: [], ...extra });

  // 服务端说这一块在场：整页渲染就有它，费率来自当前那份解析结果（choiceTable 的 sources 是 14%）。
  const live = await render(profitProps({}, {}, cargoDeclared(), categoryReadStep(), step()));
  assert.match(live, /<div class="product-profit-commission" role="group" aria-label="估算佣金授权">/u);
  assert.match(live, /费率 14% · 档位 1500_5000/u);
  assert.doesNotMatch(live, /这一块说的是上一次确认停下来那一刻的事/u);

  // 服务端说不在场（没撞上过、或者已经确认成功）：这一块根本不存在，页面自己也不记得它曾经在过。
  for (const absent of [null, undefined, step({ present: false, current: false, recordedRevision: null })]) {
    assert.doesNotMatch(await render(profitProps({}, {}, cargoDeclared(), categoryReadStep(), absent)),
      /估算佣金授权/u, JSON.stringify(absent) ?? 'undefined');
  }

  // 记录说的不是当前这一版资料：这一块不消失，而是把它说的是哪一版照实摆在最前面。
  // 那句话只说资料动过，不说是主人改的——把版本顶高的也可能是软件自己存的另一条记录。
  const stale = await render(profitProps({}, {}, cargoDeclared(), categoryReadStep(),
    step({ current: false, recordedRevision: 27 })));
  assert.match(stale, /这一块说的是上一次确认停下来那一刻的事：它说的是第 27 版资料，现在是第 29 版。这之后这件商品的资料又动过，软件没有因此重新读过佣金。/u);
  assert.match(stale, /照它签一次字，或者直接再点一次下面那个确认，让软件按现在这一版重新读一次，都可以。/u);
  // 过期不等于不能签：费率照样是现在这份解析结果给的，那个勾也还在。
  assert.match(stale, /费率 14% · 档位 1500_5000/u);
  assert.match(stale, /id="profit-commission-estimate"/u);
  // 服务端连版本号都说不清的时候，那句话照说，但不编一个版本号出来。
  const vague = await renderCommissionEstimate({ authorized: false, saving: false, onAuthorize: forbidden,
    estimate: { proposal: null, storeLabel: 'Miska', current: false, recordedRevision: null, dataRevision: null } });
  assert.match(vague, /这一块说的是上一次确认停下来那一刻的事。这之后这件商品的资料又动过/u);
  assert.doesNotMatch(vague, /第 null 版|第 undefined 版/u);
});

test('确认之后说的是服务端真的保存成什么样，同一个成功回执底下的四种结果各说各的', async () => {
  const { profitStepOutcomeLine } = await pageModule();
  // 服务端没有确认，而是又排了一次采集：不能报成「已确认」。
  assert.equal(profitStepOutcomeLine({ status: 'supplier_capture_job_queued', candidate: {} }),
    '没有确认成功：服务端认为这个1688链接还要重新读一次，已经排了一次采集。等它采完，再回到这一步。');
  // 之前已经确认过的，说清楚这次没有重复确认。
  assert.match(profitStepOutcomeLine({ idempotentReplay: true, candidate: {} }), /之前已经确认过了，服务端没有再确认一次/u);
  // 确认之后利润过线：走到文案素材，并且把边界说全。
  assert.match(profitStepOutcomeLine({ candidate: { workflowStatus: 'listing_preparation' } }),
    /利润也算过了，这件商品走到了「文案素材」。没有下单、没有联系供应商、也没有向 Ozon 写任何东西。/u);
  // 确认之后利润没过线：商品当场被淘汰，必须照服务端给的原因说，并且说清在哪恢复。
  assert.match(profitStepOutcomeLine({ candidate: { workflowStatus: 'eliminated',
    eliminationReason: 'B阶段利润未达到当前门槛：单件利润12元，利润率9.8%' } }),
    /这件商品已经淘汰：B阶段利润未达到当前门槛：单件利润12元，利润率9\.8%。可以在选品台的「已淘汰」里恢复。/u);
  // 确认了但缺精确佣金：不能说成算完了。
  assert.match(profitStepOutcomeLine({ candidate: { workflowStatus: 'needs_user_data',
    neededFields: ['系统待取得当前店铺、类目和销售模式的精确佣金；现有结果仅为条件测算，未通过正式B。'] } }),
    /已确认，但利润还没有算完：系统待取得当前店铺、类目和销售模式的精确佣金/u);
  assert.match(profitStepOutcomeLine({}), /已提交这一步的确认；下面显示的是服务端现在保存的状态。/u);

  const { readFile } = await import('node:fs/promises');
  const page = await readFile(fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url)), 'utf8');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  // 页面读的是服务端那份回执本身，所以 App 里那条路必须把回执交回来，不能吞掉。
  assert.match(page, /profitStepOutcomeLine\(await onConfirmProfitStep\(input\)\)/u);
  assert.match(app, /return await runMutation\(\(\)=>api\.confirmRealAStage\(candidateId,payload\)/u);
});

/**
 * 算利润停在条件测算之后，这一页必须把唯一的出路摆出来。
 *
 * 2026-09-14 主人第一件真货就卡在这一步：这一页对已确认的商品只剩一句「详细界面还在旧版页面里」，
 * 而「重算」那个按钮只长在旧版 A 卡上——他在自己要用的这一页看不到还能做什么。
 * 这一条钉的是：服务端给出那份记录时，这一页自己要有这一块，并且说得出这一次会用哪一种费用证据。
 */
function recalculationCandidate(runtimeView) {
  return candidate({
    workflowStatus: 'needs_user_data',
    executionRuntime: { businessPhase: 'B' },
    lifecycleV11: { status: 'b_conditional_awaiting_exact_commission',
      aConfirmationReceipt: { decision: 'confirm' } },
    bExactCommissionRuntimeView: runtimeView
  });
}

const readyRecalculationView = (mode) => ({
  schemaVersion: 'b-exact-commission-runtime-view-v1',
  candidateId: 'candidate:synthetic-product-page', expectedRevision: 4,
  skuPackageId: 'sku-lifecycle:synthetic', failureId: 'failure:synthetic',
  canRecalculate: true, automaticRetryAllowed: false, externalRequests: 0,
  status: 'ready', evidencePackIds: [], blockReason: null,
  commissionEvidenceMode: mode,
  commissionEvidenceLabel: mode === 'exact' ? '店里同类目在售商品的实收费率' : 'Ozon 官方费率表上这条类目的公开费率',
  commissionRate: 0.12,
  message: '服务端原话：可以重算。'
});

test('条件测算停下来之后，这一页自己就有重算入口，并说明这一次用的是哪一种费用证据', async () => {
  const official = await render({ candidate: recalculationCandidate(readyRecalculationView('official_reference')),
    view: null, onRecalculateBWithExactCommission: forbidden, onOpenLegacyCard: forbidden });
  assert.match(official, /已经有更好的费用证据，可以重算利润/u);
  assert.match(official, /<button[^>]*>用更好的费用证据重算<\/button>/u);
  assert.match(official, /这一次会用：Ozon 官方费率表上这条类目的公开费率 12%。/u);
  // 官方费率表能让 B 正式通过，但上不了架——这一句不许省。
  assert.match(official, /上架那道闸门只认店里的实收费率，这件商品还是上不了架/u);
  assert.match(official, /服务端原话：可以重算。/u);
  // 这一块在场时，算利润那一步不再折叠成「详细界面还在旧版页面里」。
  assert.doesNotMatch(official, /算利润<span class="product-folded-state">/u);

  const exact = await render({ candidate: recalculationCandidate(readyRecalculationView('exact')),
    view: null, onRecalculateBWithExactCommission: forbidden, onOpenLegacyCard: forbidden });
  assert.match(exact, /这一次会用：店里同类目在售商品的实收费率 12%。/u);
  assert.match(exact, /重算通过之后这件商品可以继续往上架走/u);
  assert.doesNotMatch(exact, /上架那道闸门只认店里的实收费率/u);
});

test('还没有更好的证据时，这一页照实说，不给按钮也不自己重试', async () => {
  const blocked = await render({ candidate: recalculationCandidate({
    ...readyRecalculationView('exact'), canRecalculate: false, status: 'evidence_required',
    commissionEvidenceMode: null, commissionEvidenceLabel: null, commissionRate: null,
    blockReason: 'B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE', message: '服务端原话：还读不到。'
  }), view: null, onRecalculateBWithExactCommission: forbidden, onOpenLegacyCard: forbidden });
  assert.match(blocked, /条件测算已保存，等更好的费用证据/u);
  assert.match(blocked, /服务端原话：还读不到。/u);
  assert.match(blocked, /软件不会自己重试，也不会替你把估算当成实收/u);
  assert.doesNotMatch(blocked, /用更好的费用证据重算<\/button>/u);
});

/**
 * 上面那一块说「还读不到」的时候，这一页必须同时给出那条出路，并且把它说成一次「读证据」，
 * 不是一次「算利润」——两次点击是两个决定，页面上也得是两句话。
 */
test('读不到更好的证据时，这一页给出重读入口，并说清它不碰什么、读完还要做什么', async () => {
  const stranded = await render({ candidate: recalculationCandidate({
    ...readyRecalculationView('exact'), canRecalculate: false, status: 'evidence_required',
    commissionEvidenceMode: null, commissionEvidenceLabel: null, commissionRate: null,
    blockReason: 'B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE', message: '服务端原话：还读不到。'
  }), view: null, onRecalculateBWithExactCommission: forbidden, onOpenLegacyCard: forbidden,
    onRefreshBFeeEvidence: forbidden });

  assert.match(stranded, /<button[^>]*>重新读一次费用证据<\/button>/u);
  // 一、这一步做什么。
  assert.match(stranded, /重新读一次平台佣金和 Schema/u);
  // 页面不自己诊断为什么用不了：为什么用不了是服务端那句原话，就在上面那一块里。
  assert.match(stranded, /为什么用不了，服务端那句话就在上面/u);
  assert.match(stranded, /软件不会自己去读/u);
  // 二、这一步不做什么——三件都要说到。
  assert.match(stranded, /不碰已经定下来的规格、货价、重量、包装、线路、运费和供货确认/u);
  assert.match(stranded, /不向 Ozon 写任何东西/u);
  assert.match(stranded, /不改这件商品的利润结论/u);
  // 三、读完之后还要主人再点一次，两次点击不合并。
  assert.match(stranded, /请再点一次上面的「用更好的费用证据重算」/u);
  assert.match(stranded, /那是第二个决定，由主人自己按/u);
});

test('已经有可用证据时这一块还在，但说清它不是必须的；服务端没给重读入口就整块不出现', async () => {
  const ready = await render({ candidate: recalculationCandidate(readyRecalculationView('official_reference')),
    view: null, onRecalculateBWithExactCommission: forbidden, onOpenLegacyCard: forbidden,
    onRefreshBFeeEvidence: forbidden });
  assert.match(ready, /也可以重新读一次费用证据/u);
  assert.match(ready, /这一步不是必须的/u);
  assert.match(ready, /<button[^>]*>用更好的费用证据重算<\/button>/u);

  // 页面不自己造这条路：没有接上重读处理时，这一块一个字都不出现。
  const withoutHandler = await render({ candidate: recalculationCandidate(readyRecalculationView('exact')),
    view: null, onRecalculateBWithExactCommission: forbidden, onOpenLegacyCard: forbidden });
  assert.doesNotMatch(withoutHandler, /重新读一次费用证据/u);
});

/* ── 每单额外操作费 ────────────────────────────────────────────────────────────────────────────────────────────────
 * 主人 2026-09-14、2026-09-15 两次走到最后一个按钮才撞上这堵墙：`packagingCostRmb` 是 B 阶段证据的硬要求，从
 * Seerfar 发现进来的候选一律没有它，而新版商品页没有任何地方能填。这一组用例钉住的是那个入口本身、它说的那几句话，
 * 以及「没声明」必须在「算利润」这一步就报出来。
 */
test('没声明每单额外操作费，「算利润」这一步就报缺项，按钮不给点，并且当场就能一键确认 ¥0.00', async () => {
  const { extraHandlingFeesStepGaps } = await pageModule();
  const missing = extraHandlingFeesStepGaps(extraHandlingNotDeclared());
  assert.deepEqual(missing, [{ field: 'extraHandlingFees', label: '每单额外操作费', why: EXTRA_HANDLING_NOT_DECLARED_WHY }]);
  assert.deepEqual(extraHandlingFeesStepGaps(extraHandlingStep()), []);
  // 读不到这一块时按钮同样不亮：宁可不亮，也不让主人点了才吃服务端那句 B_EVIDENCE_COST_POLICY_INCOMPLETE。
  assert.equal(extraHandlingFeesStepGaps(null).length, 1);
  assert.equal(extraHandlingFeesStepGaps(undefined).length, 1);

  const html = await render(profitProps({}, {}, cargoDeclared(), categoryReadStep(), null, extraHandlingNotDeclared()));
  assert.match(html, /<div class="product-profit-extra-handling" role="group" aria-label="每单额外操作费">/u);
  assert.match(html, /<h4>这件商品还没声明每单额外操作费<\/h4>/u);
  assert.match(html, /包材 \/ 拆单费 \/ 合包费 \/ 额外材料费这一类，每单要另外花的钱/u);
  // 缺项单里点名说的就是这笔钱，不是一句「成本规则不完整」。
  assert.match(html, /<b>每单额外操作费<\/b>：这件商品还没声明每单额外操作费/u);
  assert.match(html, /<button type="button" class="button primary" disabled[^>]*>确认，进入文案素材<\/button>/u);
  // 出路就在缺项旁边：一键确认 ¥0.00，不用打字。
  assert.match(html, /<button type="button" class="button primary"[^>]*>确认：这件不用加钱（¥0\.00）<\/button>/u);
  assert.match(html, /<button type="button" class="button secondary"[^>]*>加一行<\/button>/u);
  assert.match(html, /确认只是记下这件商品每单要另外花多少钱，不会下单、不会联系供应商、也不会向 Ozon 写任何东西。/u);

  // 声明过了，这一块说的是那份声明本身，缺项单里也不再有它。
  const declaredHtml = await render(profitProps());
  assert.match(declaredHtml, /<h4>每单额外操作费：¥3\.00<\/h4>/u);
  assert.match(declaredHtml, /每单额外操作费 ¥3\.00：包材 ¥1\.50 ＋ 拆单费 ¥1\.50。/u);
  assert.match(declaredHtml, /你在 2026-09-15 确认的，记录里写明是你确认的。/u);
  assert.doesNotMatch(declaredHtml, /product-profit-gaps/u);
});

test('页面显示的利润用这件货自己的那个数；没声明时明说它还没签过字，不冒充一个定下来的数', async () => {
  const { extraHandlingFeeAppliedLine } = await pageModule();
  assert.equal(extraHandlingFeeAppliedLine(profitReview()),
    '上面每个规格的利润都扣了你声明的每单额外操作费 ¥3.00。');
  assert.match(extraHandlingFeeAppliedLine(profitReview({ extraHandlingFee: { appliedRmb: 0, declared: false } })),
    /暂按每单额外操作费 ¥0\.00 算的——这件商品你还没声明过这笔钱，这个数没签过字/u);
  assert.equal(extraHandlingFeeAppliedLine(profitReview({ extraHandlingFee: null })), null);

  // 算式里这笔钱自己一行，并且说出它是主人签的还是暂算的；它和贴标不再被合成一行蒙混过去。
  const undeclared = await render(profitProps({ extraHandlingFee: { appliedRmb: 0, declared: false } },
    {}, cargoDeclared(), categoryReadStep(), null, extraHandlingNotDeclared()));
  assert.match(undeclared, /<dt>每单额外操作费<\/dt><dd>−¥3\.00 · 还没声明，暂按这个数<\/dd>/u);
  assert.match(undeclared, /在你确认之前，上面那些利润是暂按 ¥0\.00 算的——这个数还没签过字。/u);

  // 数字来源那一栏也照实说：这个数是主人声明的，还是还没签过字的。
  const sources = await render(choosingProps({}, {},
    { sources: { ...choiceTable().sources, packagingRmbDefault: 0, extraHandlingDeclared: false } }));
  assert.match(sources, /<dt>每单额外操作费<\/dt><dd>¥0\.00 · 还没声明，暂按这个数<\/dd>/u);
});

test('每个规格旁边说清「这笔费用涨到 ¥X 以上它才掉线」，X 跟着这个规格自己的余地走', async () => {
  const { extraHandlingFeeBreakLine } = await pageModule();
  const roomy = profitReview().specifications.find(item => item.sourceSkuId === 'sku-xl-yellow');
  const tight = profitReview().specifications.find(item => item.sourceSkuId === 'sku-8xl-yellow');
  assert.equal(extraHandlingFeeBreakLine(tight),
    '这笔费用涨到 ¥18.52 以上，这个规格才会掉出本店利润线（现在按 ¥3.00 算，还剩 ¥15.52 的余地，卡住它的是利润率那条门槛 ¥19.10）。');
  assert.match(extraHandlingFeeBreakLine(roomy), /涨到 ¥43\.37 以上/u);
  // 服务端没给这个答案时一个字都不说，页面不自己算。
  assert.equal(extraHandlingFeeBreakLine({ extraHandling: null }), null);
  assert.equal(extraHandlingFeeBreakLine(null), null);

  const html = await render(profitProps());
  assert.match(html, /<p class="product-profit-extra-handling-break">这笔费用涨到 ¥18\.52 以上/u);
  // 排队表里每一行都有自己的那一格。
  assert.match(html, /<th scope="col">额外操作费涨到<\/th>/u);
  assert.match(html, /<td>¥43\.37 以上<\/td>/u);
  assert.match(html, /<td>¥18\.52 以上<\/td>/u);
  assert.match(html, /余地宽的不必为几毛钱纠结，窄的要当心/u);
});

test('已经走过去的那几步显示成已完成，不再说「等前面的步骤完成后再开始」', async () => {
  const { currentProductStep, foldedStepState, foldedStepLine, productStepPassed } = await pageModule();
  // 主人首件就是这个状态：B 已经正式通过，商品停在「文案素材」。
  const passedB = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow'] }),
    executionRuntime: { businessPhase: 'C1' }, workflowStatus: 'listing_preparation',
    lifecycleV11: { status: 'b_passed_auto_c1', aConfirmationReceipt: { decision: 'confirm' },
      skuPackage: { businessPhase: 'C1' } } });
  assert.equal(currentProductStep(passedB), 'copy');
  assert.equal(foldedStepState('profit', 'copy', passedB), '已完成');
  assert.equal(foldedStepState('find', 'copy', passedB), '已完成');
  assert.equal(foldedStepState('select', 'copy', passedB), '已完成');
  assert.equal(foldedStepState('copy', 'copy', passedB), '进行中');
  assert.equal(foldedStepState('publish', 'copy', passedB), '未开始');
  assert.equal(foldedStepLine('profit', 'copy', passedB), '这一步已经做完了；详细内容还在旧版页面里，用「打开旧版A卡」可以回看。');
  assert.equal(foldedStepLine('publish', 'copy', passedB), '等前面的步骤完成后再开始。');

  // 先后按这件商品上真实发生的顺序，不按进度条的排版顺序——「选定」排在最前面，但真正先做的是「找货」。
  assert.equal(productStepPassed('find', 'select'), true);
  assert.equal(productStepPassed('select', 'find'), false);
  assert.equal(productStepPassed('profit', 'readback'), true);
  assert.equal(productStepPassed('copy', 'copy'), false);

  const html = await render({ candidate: passedB, view: null });
  assert.match(html, /<summary>算利润<span class="product-folded-state">已完成<\/span><\/summary>/u);
  assert.match(html, /<summary>文案素材<span class="product-folded-state">进行中<\/span><\/summary>/u);
  assert.match(html, /<summary>上架<span class="product-folded-state">未开始<\/span><\/summary>/u);
});

test('Ozon C1 显示本地准备节点，WB C1 保留原文案素材区', async () => {
 const make = platform => props({candidate:candidate({targetPlatform:platform,executionRuntime:{businessPhase:'C1'},workflowStatus:'listing_preparation',lifecycleV11:{skuPackage:{businessPhase:'C1',targetPlatform:platform,targetStore:'miska',supplierSkuId:'synthetic-sku'}}}),productionIdentity:{roles:['owner']},onPrepareC1Local:forbidden});
 const ozon=await render(make('ozon'));assert.match(ozon,/准备商品属性与关键词/u);assert.doesNotMatch(ozon,/<summary>文案素材/u);
 const wb=await render(make('wb'));assert.doesNotMatch(wb,/准备商品属性与关键词/u);assert.match(wb,/<summary>文案素材/u);
});

test('新版商品页显示实际文案，内容确认前不出现上传入口', async () => {
  const record = candidate({ lifecycleV11: { skuPackage: { businessPhase: 'C1', targetPlatform: 'ozon',
    targetStore: 'miska', supplierSkuId: 'synthetic-sku' }, c1AiDraftRequestV1: { requestId: 'synthetic-request' } },
    c1ContentReviewView: { status: 'awaiting_confirmation', canConfirm: true, expectedRevision: 4,
      contentFingerprint: 'a'.repeat(64), title: { text: 'Одежда для кошек' }, description: { text: 'Проверенное описание' },
      bulletPoints: [{ text: 'Проверенный факт' }], searchKeywords: { keywords: [{ query: 'Для кошек' }] } } });
  const html = await render(props({ candidate: record, productionIdentity: { roles: ['owner'] }, onConfirmC1Content: forbidden }));
  for (const value of ['Одежда для кошек', 'Проверенное описание', 'Проверенный факт', 'Для кошек', '确认商品内容，进入图片']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /\[object Object\]|type="file"|准备文案请求/u);
  const viewer = await render(props({ candidate: record, productionIdentity: { roles: ['viewer'] }, onConfirmC1Content: forbidden }));
  assert.match(viewer, /disabled=""[^>]*>确认商品内容，进入图片/u);
});

test('修订稿与原稿明确区分，确认前隐藏付费与图片入口，来源失配不可确认', async () => {
  const content = { title: { text: 'Одежда для кошек' }, description: { text: 'Размеры упаковки: 20 × 30 × 5 см. Без бренда.' },
    bulletPoints: [{ text: 'Вес товара в упаковке — 0,2 кг.' }], searchKeywords: [{ text: 'Для кошек' }] };
  const record = candidate({ lifecycleV11: { skuPackage: { businessPhase: 'C1', targetPlatform: 'ozon', targetStore: 'miska',
    supplierSkuId: 'synthetic-sku' } }, c1EditorialReviewView: { status: 'awaiting_confirmation', canConfirm: true,
    expectedRevision: 4, editorialVersionId: 'editorial:fixture', outputFingerprint: 'b'.repeat(64), content,
    changes: [{ path: 'output.description', before: { text: '<script>wrong</script>' }, after: content.description,
      explanation: '包装口径来自原确认，未新增商品尺寸。' }] } });
  const html = await render(props({ candidate: record, productionIdentity: { roles: ['owner'] }, onConfirmC1EditorialContent: forbidden }));
  assert.match(html, /核对修订文案|Размеры упаковки/u);
  assert.match(html, /确认修订文案，进入图片/u);
  assert.match(html, /&lt;script&gt;wrong&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>wrong|type="file"|本件商品的文案制作|确认本件商品的一次文案调用/u);
  const viewer = await render(props({ candidate: record, productionIdentity: { roles: ['viewer'] }, onConfirmC1EditorialContent: forbidden }));
  assert.match(viewer, /disabled=""[^>]*>确认修订文案，进入图片/u);
  const blocked = await render(props({ candidate: { ...record, c1EditorialReviewView: { status: 'blocked', canConfirm: false } },
    productionIdentity: { roles: ['owner'] }, onConfirmC1EditorialContent: forbidden }));
  assert.match(blocked, /文案修订需要重新核对/u);
  assert.doesNotMatch(blocked, /确认修订文案，进入图片/u);
});
