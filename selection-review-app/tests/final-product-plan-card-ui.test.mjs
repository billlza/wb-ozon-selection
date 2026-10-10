import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { productionAuthorizationInputFromCard } from "../src/productionAuthorizationInput.js";
import { api } from "../src/api.js";
import { createC1CompletedEditorialFixture } from "./fixtures/c1-completed-editorial-fixture.mjs";
import { buildC1EditorialReviewView } from "../lib/c1-editorial-review-use-case.mjs";
import { buildC1ContentReviewView } from "../lib/c1-content-review-use-case.mjs";

let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL("./final-product-plan-card-ui-entry.jsx", import.meta.url));
    const component = fileURLToPath(new URL("../src/components/FinalProductPlanCard.jsx", import.meta.url));
    const product = fileURLToPath(new URL("../src/components/ProductPage.jsx", import.meta.url));
    const output = await build({ configFile: false, logLevel: "warn", plugins: [react(), {
      name: "final-product-plan-card-ui-test", resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
        import Card from ${JSON.stringify(component)};
        import ProductPage from ${JSON.stringify(product)};
        export const render=props=>renderToStaticMarkup(<Card {...props}/>);
        export const renderProduct=props=>renderToStaticMarkup(<ProductPage {...props}/>);
        export function interaction(props) {
          let button;
          function collect(element) {
            if (!React.isValidElement(element)) return;
            if (element.type === 'button' && element.props.children === '用现有资料准备新版方案') button = element;
            React.Children.forEach(element.props.children, collect);
          }
          function Subject() { const tree=Card(props); collect(tree); return tree; }
          const html=renderToStaticMarkup(<Subject/>);
          return {html,click:button?.props.onClick};
        }` : null
    }], ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
    const chunk = output.output.find(item => item.type === "chunk" && item.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  }
  return renderer.render(props);
}

const forbidden = () => { throw new Error("VIEWING_SAVED_CARD_MUST_NOT_START_WORK"); };

test('editorial copy is shown only in a bound read-only card and leaves original card content intact', async () => {
  const props = fixture(); props.provisional = true;
  const sku = props.candidate.lifecycleV11.skuPackage;
  const layer = sku.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.seoEvidenceLayer;
  const content = { title: { text: 'Новое название', reviewZh: '修订标题' },
    description: { text: 'Исправленное описание.', reviewZh: '修订后的描述。' },
    bulletPoints: [{ text: 'Сохранённый пункт.', reviewZh: '保留的卖点。' }],
    searchKeywords: [{ text: 'Ключ', reviewZh: '关键词', keywordRole: 'attribute' }] };
  props.editorialPreview = { schemaVersion: 'c1-completed-editorial-preview-v1', status: 'proposal_only', canConfirm: false,
    candidateId: props.candidate.id, expectedRevision: props.candidate.dataRevision, skuPackageId: sku.skuPackageId,
    sourceReceiptId: layer.aiReceiptId, sourceOutputFingerprint: layer.outputFingerprint,
    providerReceiptReplaced: false, productionAuthorized: false, content };
  const before = structuredClone(props.candidate);
  const html = await render(props);
  for (const item of [content.title, content.description, ...content.bulletPoints, ...content.searchKeywords]) {
    assert.ok(html.includes(item.text)); assert.ok(html.includes(item.reviewZh));
  }
  assert.match(html, /局部修订版/);
  assert.ok((html.match(/<button[^>]*>/g) || []).every(tag => tag.includes('disabled')));
  assert.deepEqual(props.candidate, before);
  await assert.rejects(render({ ...props, provisional: false }), /EDITORIAL_PREVIEW_REQUIRES_READ_ONLY_CARD/);
  for (const changed of [{ candidateId: 'foreign' }, { expectedRevision: props.candidate.dataRevision + 1 },
    { sourceReceiptId: 'foreign' }, { sourceOutputFingerprint: 'foreign' }, { canConfirm: true }, { productionAuthorized: true }]) {
    await assert.rejects(render({ ...props, editorialPreview: { ...props.editorialPreview, ...changed } }), /OZON_PREVIEW_EDITORIAL_SOURCE_MISMATCH/);
  }
});
function fixture() {
  const source = productionOwnerDecisionFixture();
  const candidate = structuredClone(source.candidate);
  candidate.productionOwnerPreparation = structuredClone(source.preparedView);
  return { candidate, identity: { canSaveProductionOwnerDecision: true },
    onSaveProductionOwnerDecision: forbidden, onSaveFinalPricingReview: forbidden };
}

function primaryContent(html) {
  let depth = 0, cursor = 0, output = '';
  for (const match of html.matchAll(/<\/?details\b[^>]*>/g)) {
    if (depth === 0) output += html.slice(cursor, match.index);
    depth += match[0].startsWith('</') ? -1 : 1;
    cursor = match.index + match[0].length;
  }
  assert.equal(depth, 0);
  return output + html.slice(cursor);
}
const cardOf = props => props.candidate.lifecycleV11.skuPackage.productionConfirmationCard;
const frozenC1 = props => props.candidate.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot;
const fact = value => ({ value, verificationStatus: 'confirmed', sourceRefs: ['synthetic:private-source'] });

test('provisional review retains the actual card contents but exposes no confirmation or mutation controls', async () => {
  const props = fixture();
  props.identity = { authenticated: true, roles: ['owner'], canSaveProductionOwnerDecision: true };
  props.onReviseC1FinalPlan = forbidden;
  const before = structuredClone(props.candidate);
  const html = await render({ ...props, provisional: true });
  assert.match(html, /新版方案预览 · 文案待验收/);
  assert.match(html, /尚未保存新的文案确认、最终方案卡或生产授权/);
  assert.doesNotMatch(html, /<form\b|<button\b|调整售价|用现有资料准备新版方案/);
  assert.match(html, /Ozon 提交文案/);
  assert.deepEqual(props.candidate, before);
});

test('confirmation view shows exact supply identity, saved profit, actual content mapping and all 15 image positions without action', async () => {
  const props = fixture(), card = cardOf(props);
  const first = card.c2Assets.finalUploads[0];
  card.c2Assets.finalUploads = Array.from({ length: 15 }, (_, index) => ({ ...first,
    assetId: `image-${index}`, assetRef: `local-asset:image-${index}`, fileName: `photo-${index}.png` }));
  card.seoDraft.description.text = 'Описание.';
  card.seoDraft.bulletPoints = [{ text: 'Первый пункт.' }, { text: 'Второй пункт.' }];
  const before = structuredClone(props.candidate), html = await render(props);
  for (const name of ['最终商品方案确认卡', '商品与价格', 'Ozon 提交文案', '类目、属性与包装', '技术详情与资料记录']) assert.ok(html.includes(name), name);
  assert.ok(html.includes(card.productInformation.sku.value.supplierSkuId));
  assert.ok(html.includes(`${card.profitResult.recommendedSalePrice.value.rub} RUB`));
  assert.ok(html.includes(`${card.profitResult.recommendedSalePrice.value.cny} CNY`));
  assert.ok(html.includes('Описание.\n\nПервый пункт.\n\nВторой пункт.'));
  assert.ok(html.includes(card.seoDraft.title.text));
  assert.match(html, /库存单独提交/);
  assert.match(html, /最终图片 · 15 张/);
  assert.equal((html.match(/<img /g) || []).length, 15);
  let previous = -1;
  for (let index = 0; index < 15; index++) {
    const position = html.indexOf(`/local-assets/image-${index}"`);
    assert.ok(position > previous); previous = position;
  }
  assert.match(html, /<b>1 · 主图<\/b>/);
  assert.match(html, /<button[^>]*disabled[^>]*>通过进入生产授权<\/button>/);
  assert.equal(props.candidate.lifecycleV11.skuPackage.productionAuthorization, null);
  assert.deepEqual(props.candidate, before);
});

test('raw JSON, source IDs, dictionary IDs and variant hashes stay out of the entire confirmation view', async () => {
  const props = fixture(), card = cardOf(props), attrs = card.c1Facts.productAttributes;
  card.productInformation.sku.value.variantKey = 'variant:private-hash';
  attrs.supplierAttributes = [{ fieldKey: '颜色', fact: fact('卡其色') }, { fieldKey: '尺码', fact: fact('均码') }];
  attrs.weight = fact({ value: 0.2, unit: 'kg', evidenceRef: 'weight:private-source' });
  attrs.dimensions = fact({ length: 20, width: 30, height: 5, unit: 'cm', evidenceRef: 'dimensions:private-source' });
  attrs.requiredPlatformFields = [{ fieldKey: 'brand', labelZh: '品牌', fact: fact({ dictionaryValueId: 999, value: 'Нет бренда' }) }];
  frozenC1(props).schemaSnapshot.requiredFields.value = [{ fieldKey: 'brand', required: true }];
  frozenC1(props).schemaSnapshot.writeBindings.value.requiredAttributes = [{ fieldKey: 'brand', attributeId: 85, complexId: 0, dictionaryId: 301 }];
  const html = await render(props);
  assert.match(html, /颜色：卡其色/); assert.match(html, /尺码：均码/);
  assert.match(html, /<dt>包装重量 · 必填<\/dt><dd>0.2 kg<\/dd>/);
  assert.match(html, /<dt>包装尺寸 · 必填<\/dt><dd>20 × 30 × 5 cm<\/dd>/);
  assert.match(html, /Нет бренда/);
  for (const value of ['variant:private-hash', 'synthetic:private-source', 'weight:private-source', 'dimensions:private-source', 'dictionaryValueId', '999', '<pre>', '[object Object]']) assert.ok(!html.includes(value), value);
});

test('every Russian copy part and canonical attribute uses only saved Chinese explanations', async () => {
  const props = fixture(), card = cardOf(props), c1 = frozenC1(props);
  card.seoDraft.title = { text: 'Товар', reviewZh: '合成标题译义' };
  card.seoDraft.description = { text: 'Описание.', reviewZh: '合成描述译义' };
  card.seoDraft.bulletPoints = [{ text: 'Пункт.', reviewZh: '合成卖点译义' }];
  card.seoDraft.searchKeywords = { keywords: [{ query: 'товар', reviewZh: '合成词义', keywordRole: 'core_product' }] };
  const attr = { fieldKey: 'material', labelZh: '材质', fact: fact('Дерево') };
  card.c1Facts.productAttributes.requiredPlatformFields = [attr];
  card.c1Facts.productAttributes.ozonAttributes = [structuredClone(attr)];
  c1.seoEvidenceLayer = {
    russianAttributes: [{ factPath: 'productAttributes.ozonAttributes.0.fact', valueRu: 'Дерево', reviewZh: '合成属性译义' }],
    categoryPathReview: [{ factPath: 'platformCategory.categoryPath', valueRu: card.c1Facts.platformCategory.categoryPath.value, reviewZh: '合成类目译义' }]
  };
  let html = await render(props);
  for (const value of ['合成标题译义', '合成描述译义', '合成卖点译义', '合成词义', '合成属性译义']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(primaryContent(html), /文案未就绪/);
  c1.seoEvidenceLayer.russianAttributes[0].valueRu = 'Несовпадение';
  delete card.seoDraft.title.reviewZh;
  html = await render(props);
  assert.match(primaryContent(html), /文案未就绪/);
  assert.match(html, /缺少正式中文释义/);
  assert.doesNotMatch(html, /合成属性译义|合成标题译义/);
});

test('expired evidence is readable and neither readiness nor unavailable score enables production', async () => {
  const props = fixture();
  props.candidate.productionOwnerPreparation.ready = false;
  props.candidate.productionOwnerPreparation.gaps = [{ code: 'SYNTHETIC_BLOCK', message: '生产资料缺口' }];
  props.candidate.productionOwnerPreparation.evidenceReadiness = { status: 'requires_refresh', message: '资料需要重新核验',
    entries: [{ kind: 'commission', label: '佣金资料', status: 'expired', evidenceId: 'private:evidence', expiresAt: '2026-08-02', message: '超过记录有效期' }] };
  const before = structuredClone(props.candidate), html = await render(props);
  assert.match(html, /佣金资料：记录已过期/);
  assert.doesNotMatch(primaryContent(html), /记录已过期|private:evidence/);
  assert.ok(html.includes('private:evidence'));
  assert.match(html, /暂无平台评分/);
  assert.doesNotMatch(primaryContent(html), /文案 3\/3|属性 \d+\/\d+/);
  assert.doesNotMatch(html, /<label>本店商品货号|<label>已核验仓库/);
  assert.match(html, /<button[^>]*disabled[^>]*>通过进入生产授权<\/button>/);
  assert.equal(productionAuthorizationInputFromCard(props.candidate, cardOf(props)).input, null);
  assert.deepEqual(props.candidate, before);
});

test('nonblocking unknowns stay explicit, unclassified records request software explanation, no dictionary value is invented', async () => {
  const props = fixture(), card = cardOf(props);
  card.c1Facts.productAttributes.requiredPlatformFields = [{ fieldKey: 'brand', labelZh: '品牌', fact: fact({ dictionaryValueId: 12345 }) }];
  card.riskAndUnknowns.unknownFields = [
    { path: 'batteryAssessment.batteryType', reason: 'not_present_in_frozen_inputs', blocksProductionAuthorization: false },
    { path: 'private:unclassified', reason: 'private:reason', blocksProductionAuthorization: true }
  ];
  const before = structuredClone(props.candidate), html = await render(props);
  assert.match(html, /电池类型/); assert.match(html, /已保存来源未提供这一项/);
  assert.match(html, /非阻断事项/); assert.match(html, /尚未分类的事实/);
  assert.match(html, /软件需补齐说明/); assert.match(html, /生产前需处理/);
  assert.match(html, /尚未完成确认或平台字典匹配/);
  assert.doesNotMatch(html, /12345|private:unclassified|private:reason/);
  assert.deepEqual(props.candidate, before);
});

test('saved facts reconciliation is bound to current SKU and revision without changing the old card or enabling writes', async () => {
  const props = fixture(), card = cardOf(props), c = props.candidate;
  const sku = card.productInformation.sku.value;
  c.savedSkuFactReconciliation = { schemaVersion: 'saved-sku-fact-reconciliation-v1', applicationStatus: 'prepared_from_saved_confirmations',
    sourceCandidateId: c.id, sourceRevision: c.dataRevision, ...sku, sourceCardId: card.cardId,
    records: [{ field: 'color', label: '颜色', valueZh: '卡其色', status: 'confirmed', sourceRefs: ['private:source'] },
      { field: 'battery', label: '电池', valueZh: '无电池', status: 'confirmed', sourceRefs: ['private:battery'] }] };
  const before = structuredClone(c);
  let html = await render(props);
  assert.match(html, /本次从已确认来源恢复的事实/); assert.match(html, /颜色：卡其色/); assert.match(html, /电池：无电池/);
  assert.doesNotMatch(primaryContent(html), /本次从已确认来源恢复|旧确认卡/);
  assert.match(primaryContent(html), /<dt>电池<\/dt><dd>无电池<\/dd>/);
  assert.match(html, /旧确认卡和生产授权未自动改写/); assert.doesNotMatch(html, /private:source|private:battery/);
  assert.deepEqual(c, before);
  c.savedSkuFactReconciliation.sourceRevision--;
  html = await render(props);
  assert.match(html, /恢复资料与当前商品版本不一致/);
  assert.doesNotMatch(html, /本次从已确认来源恢复的事实|电池：无电池/);
});

test('HTML text is escaped, unsafe URLs are omitted, price review is opt-in and historical cards have no write form', async () => {
  const props = fixture(), card = cardOf(props);
  card.seoDraft.title.text = '<script>synthetic title</script>';
  card.productInformation.supplierOption.value.productUrl = 'javascript:alert(1)';
  card.c2Assets.finalUploads[0].fileName = '<script>synthetic image';
  let html = await render(props);
  assert.match(html, /&lt;script&gt;synthetic title&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;synthetic image/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(html, /<details class="final-plan-price-change"><summary>/);
  assert.doesNotMatch(html, /<details[^>]*final-plan-price-change[^>]*open|checked=""/);
  card.status = 'owner_business_approved'; card.ownerDecision = { selectedOption: 'approve_for_production_authorization' };
  const before = structuredClone(props.candidate);
  html = await render(props);
  assert.match(html, /历史确认卡和主人决定保持只读/);
  assert.doesNotMatch(html, /production-owner-decision-form|final-plan-price-change/);
  assert.deepEqual(props.candidate, before);
});

test('software review reminders are not misrepresented as expired evidence or new production permission', async () => {
  const props = fixture();
  props.candidate.productionOwnerPreparation.ready = false;
  props.candidate.productionOwnerPreparation.gaps = [{ code: 'PRODUCTION_FINAL_CARD_INCOMPLETE', message: 'obsolete exact commission wording' }];
  props.candidate.productionOwnerPreparation.evidenceReadiness = { status: 'current', message: '软件复查时间不会阻止上架', entries: [
    { kind: 'commission', label: '佣金资料', status: 'refresh_due', message: '现有记录未显示来源失效或规则变更。' }] };
  const html = await render(props);
  assert.match(html, /到了复查提示时间（非失效、非阻断）/);
  assert.match(html, /现有记录未显示来源失效或规则变更/);
  assert.match(html, /软件需补齐最终商品资料/);
  assert.doesNotMatch(primaryContent(html), /记录已过期|obsolete exact commission wording|到了复查提示时间/);
  assert.match(html, /<button[^>]*disabled[^>]*>通过进入生产授权<\/button>/);
});

test('main confirmation is concise, shows final merged text once and moves nonblocking technical records into closed details', async () => {
  const props = fixture(), card = cardOf(props);
  card.seoDraft.title = { text: 'Уникальное название', reviewZh: '测试唯一标题' };
  card.seoDraft.description = { text: 'Уникальное описание. Первый пункт.', reviewZh: '测试唯一描述与第一点。' };
  card.seoDraft.bulletPoints = [{ text: 'Первый пункт.' }, { text: 'Второй пункт.', reviewZh: '测试第二点。' }];
  card.riskAndUnknowns.unknownFields = [{ path: 'batteryAssessment.batteryType', reason: 'not_present_in_frozen_inputs', blocksProductionAuthorization: false }];
  props.candidate.productionOwnerPreparation.evidenceReadiness = { status: 'current', message: '软件复查提示不阻断', entries: [
    { kind: 'commission', label: '佣金资料', status: 'refresh_due', evidenceId: 'synthetic:technical-source', message: '未显示来源失效。' }] };
  const html = await render(props), primary = primaryContent(html);
  for (const text of ['Уникальное название', 'Уникальное описание. Первый пункт.', 'Второй пункт.', '测试唯一标题', '测试唯一描述与第一点。', '测试第二点。']) {
    assert.equal(primary.split(text).length - 1, 1, `${text} appears exactly once`);
  }
  assert.match(primary, /商品标题 · 必填/); assert.match(primary, /后台写入价 · 必填/);
  assert.doesNotMatch(primary, /商品修订|方案卡版本|冻结|恢复|复查|非阻断|电池类型|synthetic:technical-source|3\/3|未声明必选性|中文释义：未保存/);
  assert.match(html, /synthetic:technical-source/); assert.match(html, /电池类型/);
  assert.match(html, /<details class="final-plan-technical-details"><summary>/);
  assert.doesNotMatch(html, /<details[^>]*final-plan-technical-details[^>]*open/);
  assert.equal((primary.match(/文案未就绪/g) || []).length, 1);
});

test('owner revision action submits the exact current source once and is hidden for unavailable owner or existing authorization', async () => {
  const props = fixture(), calls = []; let release;
  props.identity = { authenticated: true, roles: ['owner'] };
  const pending = new Promise(resolve => { release = resolve; });
  props.onReviseC1FinalPlan = async input => { calls.push(input); await pending; };
  await render(props);
  const page = renderer.interaction(props);
  assert.equal(typeof page.click, 'function');
  assert.match(page.html, /不收费、不上架/); assert.match(page.html, /此操作不生成新文案/);
  assert.deepEqual(calls, []);
  const first = page.click(), duplicate = page.click();
  assert.deepEqual(calls, [{ candidateId: props.candidate.id,
    skuPackageId: props.candidate.lifecycleV11.skuPackage.skuPackageId, dataRevision: props.candidate.dataRevision }]);
  release(); await Promise.all([first, duplicate]); assert.equal(calls.length, 1);
  for (const identity of [null, { authenticated: false, roles: ['owner'] }, { authenticated: true, roles: ['reviewer'] }]) {
    const denied = renderer.interaction({ ...props, identity });
    assert.equal(denied.click, undefined);
    assert.doesNotMatch(denied.html, />用现有资料准备新版方案</);
  }
  const authorized = structuredClone(props.candidate);
  authorized.lifecycleV11.skuPackage.productionAuthorization = { schemaVersion: 'production-authorization-v1.2' };
  assert.equal(renderer.interaction({ ...props, candidate: authorized }).click, undefined);
  const noCard = structuredClone(props.candidate); noCard.lifecycleV11.skuPackage.productionConfirmationCard = null;
  assert.equal(renderer.interaction({ ...props, candidate: noCard }).click, undefined);
  assert.equal(renderer.interaction({ ...props, onReviseC1FinalPlan: undefined }).click, undefined);
});

test('actual new product page forwards the owner preparation action to the saved final card', async () => {
  const props = fixture(), calls = [];
  props.candidate.comments = []; props.candidate.activity = [];
  await render(props);
  const html = renderer.renderProduct({ candidate: props.candidate, productionIdentity: { authenticated: true, roles: ['owner'] },
    onReviseC1FinalPlan: input => calls.push(input) });
  assert.match(html, />用现有资料准备新版方案</);
  assert.equal((html.match(/>用现有资料准备新版方案</g) || []).length, 1);
  assert.deepEqual(calls, []);
});

test('product page offers only the current editorial confirmation when the original draft is also confirmable', async () => {
  const f = await createC1CompletedEditorialFixture();
  const candidate = structuredClone(f.candidate);
  candidate.comments = []; candidate.activity = [];
  candidate.c1ContentReviewView = buildC1ContentReviewView(candidate);
  assert.equal(candidate.c1ContentReviewView.canConfirm, true);
  candidate.c1EditorialReviewView = buildC1EditorialReviewView({ candidate,
    sourceJob: f.bundle.sourceJob, proposalBundle: f.bundle, observedAt: f.at });
  assert.equal(candidate.c1EditorialReviewView.status, 'awaiting_confirmation');
  await render(fixture());
  const props = { candidate, productionIdentity: { authenticated: true, roles: ['owner'] },
    onConfirmC1Content: forbidden, onConfirmC1EditorialContent: forbidden };
  const html = renderer.renderProduct(props);
  assert.match(html, /确认修订文案，进入图片/u);
  assert.doesNotMatch(html, /确认商品内容，进入图片/u);
  assert.ok(html.includes(f.bundle.correctionPlan.items[0].correctedReviewZh));
  candidate.c1EditorialReviewView = { status: 'blocked', canConfirm: false };
  const blocked = renderer.renderProduct(props);
  assert.match(blocked, /文案修订需要重新核对/u);
  assert.doesNotMatch(blocked, /确认商品内容，进入图片|确认修订文案，进入图片/u);
});

test('revision API uses the normal endpoint and preserves explicit service errors without automatic retry', async () => {
  const originalFetch = globalThis.fetch, calls = [];
  const payload = { candidateId: 'candidate:synthetic', skuPackageId: 'sku:synthetic', dataRevision: 7 };
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200,
      json: async () => ({ status: 'committed', candidateId: payload.candidateId, dataRevision: 8, paidCalls: 0, platformWrites: 0 }) }; };
    const result = await api.reviseC1FinalPlan(payload.candidateId, payload);
    assert.equal(result.dataRevision, 8); assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/candidates/candidate%3Asynthetic/lifecycle/c1/revise-final-plan');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), payload);
    globalThis.fetch = async () => { calls.push('failed'); return { ok: false, status: 503,
      json: async () => ({ code: 'C1_IMAGE_TEXT_SERVICE_UNAVAILABLE', message: '本地图片文字服务尚未配置，需要工程配置。' }) }; };
    await assert.rejects(api.reviseC1FinalPlan(payload.candidateId, payload), error => {
      assert.equal(error.status, 503); assert.equal(error.body.code, 'C1_IMAGE_TEXT_SERVICE_UNAVAILABLE');
      assert.match(error.message, /本地图片文字服务尚未配置/); return true;
    });
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
