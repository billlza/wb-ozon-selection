import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOzonFinalProductPreview } from '../lib/ozon-final-product-preview.mjs';
import { buildOzonSellerImportRequest } from '../lib/ozon-seller-api-production-adapter.mjs';
import { fingerprintAuthorizedMedia } from '../lib/production-authorization-preparation.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';

function fixture() {
  const source = productionOwnerDecisionFixture();
  const sku = source.candidate.lifecycleV11.skuPackage;
  const c1 = sku.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot;
  return { card: structuredClone(sku.productionConfirmationCard), schemaSnapshot: structuredClone(c1.schemaSnapshot),
    platformSchemaAttributes: [], seoEvidenceLayer: { categoryPathReview: [{ factPath: 'platformCategory.categoryPath', valueRu: c1.platformCategory.categoryPath.value, reviewZh: '测试类目译义' }] } };
}
const fact = value => ({ value, verificationStatus: 'confirmed', sourceRefs: ['synthetic:fact'] });

test('preview content and optional attributes match the actual Ozon import builder without generating authority', () => {
  const input = fixture();
  input.card.seoDraft = { title: { text: 'Тестовый товар' }, description: { text: 'Описание.' },
    bulletPoints: [{ text: 'Описание.' }, { text: 'Первый пункт.' }, { text: 'Второй пункт.' }, { text: 'Первый пункт.' }], searchKeywords: { keywords: [{ query: 'тестовый товар' }, { query: 'дерево' }] } };
  input.card.c1Facts.productAttributes.requiredPlatformFields.push({ fieldKey: '1500', label: 'Numeric fixture', fact: fact(150) });
  input.schemaSnapshot.writeBindings.value.requiredAttributes.push({ fieldKey: '1500', attributeId: 1500, complexId: 0, dictionaryId: 0 });
  input.card.c1Facts.productAttributes.ozonAttributes = [{ fieldKey: '1001', label: 'Материал', fact: fact({ value: 'Дерево', dictionaryValueId: 501 }) },
    { fieldKey: '1002', label: 'Цвет', fact: { value: 'unknown', verificationStatus: 'unknown', sourceRefs: ['synthetic:color'] } }];
  input.platformSchemaAttributes.push({ fieldKey: '1001', label: 'Материал', required: false, complexId: 0, dictionaryId: 11 },
    { fieldKey: '1002', label: 'Цвет', required: false, complexId: 0, dictionaryId: 12 });
  const before = structuredClone(input), preview = buildOzonFinalProductPreview(input);
  const urls = ['https://assets.example/main.jpg', 'https://assets.example/detail.jpg'];
  const request = buildOzonSellerImportRequest({ platform: 'ozon', supplierSkuId: 'synthetic-supplier', merchantSku: 'synthetic-merchant',
    mode: 'single_sku_create_and_moderate', publishScope: 'create_and_allow_validation_moderation',
    title: input.card.seoDraft.title.text, content: { description: input.card.seoDraft.description.text,
      bulletPoints: input.card.seoDraft.bulletPoints.map(item => item.text), searchKeywords: input.card.seoDraft.searchKeywords.keywords.map(item => item.query) },
    attributes: input.card.c1Facts.productAttributes, platformSchemaAttributes: input.platformSchemaAttributes,
    schemaWriteBindings: input.schemaSnapshot.writeBindings.value, platformCategory: input.card.c1Facts.platformCategory,
    packing: { weight: input.card.c1Facts.productAttributes.weight.value, dimensions: input.card.c1Facts.productAttributes.dimensions.value },
    platformWritePrice: { amount: 63.85, currency: 'CNY' },
    finalUploads: urls.map((assetRef, index) => ({ assetId: `synthetic:${index}`, assetRef, ownerConfirmed: true, productionEligible: true })),
    authorizedMedia: { fingerprint: fingerprintAuthorizedMedia(urls), primaryImage: urls[0], images: urls.slice(1) } });
  const item = request.body.items[0];
  assert.equal(preview.content[0].value, item.name);
  for (const field of preview.content) assert.equal(item.attributes.find(attr => attr.id === field.binding.attributeId).values[0].value, field.value);
  assert.equal(preview.content[1].value, 'Описание.\n\nПервый пункт.\n\nВторой пункт.');
  // 23171 是 Хештеги：逐词加 #、词内空格换下划线。上一行逐字段比对已经证明
  // 预览与真正发出的 import 请求同源，所以主人在确认卡上看到的就是真正会发出去的标签。
  assert.equal(preview.content[2].value, '#тестовый_товар #дерево');
  assert.equal(Object.hasOwn(item, 'bulletPoints'), false);
  assert.equal(Object.hasOwn(item, 'searchKeywords'), false);
  assert.equal(request.inventoryIncluded, false);
  assert.equal(preview.attributes.find(field => field.fieldKey === '1500').value, '150');
  assert.equal(item.attributes.find(attr => attr.id === 1500).values[0].value, '150');
  const material = preview.attributes.find(field => field.fieldKey === '1001');
  assert.equal(material.value, item.attributes.find(attr => attr.id === 1001).values[0].value);
  assert.equal(material.requirement, 'optional');
  assert.equal(material.mapped, true);
  const color = preview.attributes.find(field => field.fieldKey === '1002');
  assert.equal(color.mapped, false);
  assert.equal(color.omission, 'fact_unconfirmed');
  assert.equal(item.attributes.some(attr => attr.id === 1002), false);
  assert.equal(preview.score.status, 'unavailable');
  assert.equal(Object.hasOwn(preview, 'ready'), false);
  assert.deepEqual(input, before);
});

test('required and optional labels only derive from saved schema declarations', () => {
  const input = fixture();
  let result = buildOzonFinalProductPreview(input);
  assert.equal(result.attributes[0].requirement, 'required');
  assert.equal(result.content[0].requirement, 'required');
  assert.equal(result.content[0].requirementSource, 'adapter');
  input.schemaSnapshot.requiredFields.verificationStatus = 'unknown';
  input.platformSchemaAttributes = [];
  result = buildOzonFinalProductPreview(input);
  assert.equal(result.attributes[0].requirement, 'undeclared');
});

test('translations require exact saved Russian text and canonical attribute path; old content remains a visible gap', () => {
  const input = fixture();
  input.card.seoDraft.title = { text: 'Товар', reviewZh: '测试译义' };
  input.card.seoDraft.description = { text: 'Описание.' };
  input.card.seoDraft.bulletPoints = [{ text: 'Пункт.', reviewZh: '测试卖点译义' }];
  input.card.seoDraft.searchKeywords = { keywords: [{ query: 'товар', reviewZh: '测试词义', keywordRole: 'core_product' }] };
  const attr = { fieldKey: 'material', label: 'Материал', fact: fact('Дерево') };
  input.card.c1Facts.productAttributes.requiredPlatformFields = [attr];
  input.card.c1Facts.productAttributes.ozonAttributes = [structuredClone(attr)];
  input.seoEvidenceLayer.russianAttributes = [{ factPath: 'productAttributes.ozonAttributes.0.fact', valueRu: 'Дерево', reviewZh: '测试属性译义' }];
  let result = buildOzonFinalProductPreview(input);
  assert.equal(result.attributes[0].reviewZh, '测试属性译义');
  assert.equal(result.content[0].reviewZh, '测试译义');
  assert.equal(result.content[2].parts[0].keywordRole, 'core_product');
  assert.deepEqual(result.translationGaps, [{ key: 'description', label: '描述正文' }]);
  input.seoEvidenceLayer.russianAttributes[0].valueRu = 'Другой товар';
  result = buildOzonFinalProductPreview(input);
  assert.equal(result.attributes[0].reviewZh, null);
  assert.ok(result.translationGaps.some(item => item.key === 'attribute:material'));
  input.seoEvidenceLayer.russianAttributes[0] = { factPath: 'productAttributes.ozonAttributes.9.fact', valueRu: 'Дерево', reviewZh: '错误位置' };
  assert.equal(buildOzonFinalProductPreview(input).attributes[0].reviewZh, null);
});

test('invalid optional dictionary mapping is explicit and cannot be presented as submitted', () => {
  const input = fixture();
  input.card.c1Facts.productAttributes.ozonAttributes = [{ fieldKey: '1001', fact: fact({ value: 'Дерево' }) }];
  input.platformSchemaAttributes.push({ fieldKey: '1001', required: false, complexId: 0, dictionaryId: 11 });
  const before = structuredClone(input), result = buildOzonFinalProductPreview(input);
  assert.equal(result.optionalMappingIssue, 'OZON_OPTIONAL_ATTRIBUTE_DICTIONARY_REQUIRED');
  assert.equal(result.attributes.find(field => field.fieldKey === '1001').mapped, false);
  assert.deepEqual(input, before);
  assert.throws(() => buildOzonFinalProductPreview({}), /OZON_PREVIEW_CARD_REQUIRED/);
});

test('description review follows shared de-duplication, omitting translations only for text no longer submitted', () => {
  const input = fixture();
  input.card.seoDraft.description = { text: 'Описание. Первый пункт.', reviewZh: '测试描述与第一点。' };
  input.card.seoDraft.bulletPoints = [{ text: 'Первый пункт.' }, { text: 'Второй пункт.', reviewZh: '测试第二点。' }, { text: 'Второй пункт.' }];
  let result = buildOzonFinalProductPreview(input);
  const description = result.content.find(field => field.key === 'description');
  assert.equal(description.value, 'Описание. Первый пункт.\n\nВторой пункт.');
  assert.equal(description.reviewZh, '测试描述与第一点。\n\n测试第二点。');
  assert.equal(result.translationGaps.some(field => field.key.startsWith('bullet:')), false);
  input.card.seoDraft.description.text = '';
  result = buildOzonFinalProductPreview(input);
  assert.equal(result.descriptionIssue, 'C1_DESCRIPTION_CONTENT_INVALID');
  assert.equal(result.content.find(field => field.key === 'description').value, '');
  assert.equal(result.copyReadyForReview, false);
});

test('category review matches exact saved segments and cannot split a string into invented levels', () => {
  const input = fixture();
  input.card.c1Facts.platformCategory.categoryPath = fact(['Товары для животных', 'Одежда']);
  input.seoEvidenceLayer.categoryPathReview = [
    { factPath: 'platformCategory.categoryPath.0', valueRu: 'Товары для животных', reviewZh: '测试宠物用品' },
    { factPath: 'platformCategory.categoryPath.1', valueRu: 'Одежда', reviewZh: '测试服装' }
  ];
  let result = buildOzonFinalProductPreview(input);
  assert.deepEqual(result.categoryParts.map(part => part.reviewZh), ['测试宠物用品', '测试服装']);
  input.seoEvidenceLayer.categoryPathReview[0].valueRu = 'Другой раздел';
  result = buildOzonFinalProductPreview(input);
  assert.equal(result.categoryParts[0].reviewZh, null);
  assert.ok(result.translationGaps.some(field => field.key === 'category:0'));
  input.card.c1Facts.platformCategory.categoryPath = fact('Товары для животных / Одежда');
  result = buildOzonFinalProductPreview(input);
  assert.equal(result.categoryParts.length, 1);
  assert.equal(result.categoryParts[0].reviewZh, null);
});
