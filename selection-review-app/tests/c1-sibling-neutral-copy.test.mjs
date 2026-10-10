import test from 'node:test';
import assert from 'node:assert/strict';
import { buildC1SiblingNeutralContent } from '../lib/c1-sibling-neutral-copy.mjs';

// The saved first vest's editorial shape, reduced to the facts and content this projection reads.
const paths = {
  type: 'productAttributes.ozonAttributes.3.fact', color: 'productAttributes.ozonAttributes.4.fact',
  colorName: 'productAttributes.ozonAttributes.8.fact',
  material: 'productAttributes.ozonAttributes.5.fact', cats: 'productAttributes.ozonAttributes.6.fact',
  season: 'productAttributes.ozonAttributes.7.fact', form: 'productAttributes.ownerDeclaredFacts.0.fact',
  uses: 'productAttributes.ownerDeclaredFacts.1.fact', closure: 'productAttributes.ownerDeclaredFacts.2.fact',
  adjustable: 'productAttributes.ownerDeclaredFacts.3.fact' };
const colorRef = 'saved-vest-keywords/1';
const keyword = (query, path, evidenceRef, reviewZh) => ({ query, factRefs: [path],
  evidenceRefs: [evidenceRef], reviewZh, keywordRole: 'attribute',
  assertions: [{ factPath: path, value: query === 'хаки' ? { value: 'хаки', dictionaryValueId: 258411654 }
    : { value: query, dictionaryValueId: query === 'Оксфорд' ? 61979 : 33754 } }] });
const piece = (text, reviewZh, factRefs, keywordEvidenceRefs, values) => ({ status: 'draft_only', text, reviewZh,
  factRefs, keywordEvidenceRefs, assertions: factRefs.map((factPath, index) => ({ factPath, value: values[index] })),
  productionApproved: false });
const vestPlan = {
  productAttributes: {
    supplierAttributes: [{ fieldKey: '颜色', fact: { value: '卡其色', verificationStatus: 'confirmed', sourceRefs: ['saved:color'] } }],
    ozonAttributes: [
      {}, {}, {}, { fieldKey: '8229', fact: { value: { value: 'Одежда для животных', dictionaryValueId: 96063 }, verificationStatus: 'confirmed', sourceRefs: ['saved:type'] } },
      { fieldKey: '10096', fact: { value: { value: 'хаки', dictionaryValueId: 258411654 }, verificationStatus: 'confirmed', sourceRefs: ['saved:color'] } },
      { fieldKey: '4967', fact: { value: { value: 'Оксфорд', dictionaryValueId: 61979 }, verificationStatus: 'confirmed', sourceRefs: ['saved:material'] } },
      { fieldKey: '4958', fact: { value: { value: 'Для кошек', dictionaryValueId: 33754 }, verificationStatus: 'confirmed', sourceRefs: ['saved:cats'] } },
      { fieldKey: '5954', fact: { value: { value: 'На любой сезон', dictionaryValueId: 30937 }, verificationStatus: 'confirmed', sourceRefs: ['saved:season'] } },
      { fieldKey: '10097', fact: { value: 'хаки', verificationStatus: 'confirmed', sourceRefs: ['saved:color-name'] } }
    ]
  },
  platformCategory: { categoryName: { value: 'Одежда для животных', verificationStatus: 'confirmed', sourceRefs: ['saved:category'] } },
  seoTitleDraft: piece('Одежда для животных: мини-жилет для кошек, хаки', '宠物服装：适用于猫的卡其色迷你背心。',
    [paths.type, paths.form, paths.cats, paths.color, paths.colorName], ['saved-vest-keywords/0'],
    [{ value: 'Одежда для животных', dictionaryValueId: 96063 }, '迷你背心', { value: 'Для кошек', dictionaryValueId: 33754 },
      { value: 'хаки', dictionaryValueId: 258411654 }, 'хаки']),
  descriptionDraft: piece('Мини-жилет цвета хаки из ткани оксфорд подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.',
    '卡其色牛津布迷你背心适用于猫，也可以套在酒瓶上，四季适用。',
    [paths.form, paths.type, paths.cats, paths.color, paths.material, paths.season, paths.uses],
    ['saved-vest-keywords/0', colorRef, 'saved-vest-keywords/2', 'saved-vest-keywords/3', 'saved-vest-keywords/4'],
    ['迷你背心', { value: 'Одежда для животных', dictionaryValueId: 96063 }, { value: 'Для кошек', dictionaryValueId: 33754 },
      { value: 'хаки', dictionaryValueId: 258411654 }, { value: 'Оксфорд', dictionaryValueId: 61979 },
      { value: 'На любой сезон', dictionaryValueId: 30937 }, ['猫', '酒瓶']]),
  bulletPointsDraft: [piece('Для кошек: застёжка-липучка и регулируемая конструкция.',
    '适用于猫：配有魔术贴闭合方式，并且结构可调节。', [paths.cats, paths.closure, paths.adjustable],
    ['saved-vest-keywords/3'], [{ value: 'Для кошек', dictionaryValueId: 33754 }, '魔术贴', true])],
  searchKeywordsDraft: { status: 'draft_only', productionApproved: false, keywords: [
    keyword('хаки', paths.color, colorRef, '卡其色。'),
    keyword('Оксфорд', paths.material, 'saved-vest-keywords/2', '牛津布。'),
    keyword('Для кошек', paths.cats, 'saved-vest-keywords/3', '适用于猫。') ] },
  keywordEvidenceRefs: ['saved-vest-keywords/0', colorRef, 'saved-vest-keywords/2', 'saved-vest-keywords/3', 'saved-vest-keywords/4'],
  seoEvidenceLayer: { russianAttributes: [
    { factPath: paths.color, valueRu: 'хаки', reviewZh: '卡其色。' },
    { factPath: paths.colorName, valueRu: 'хаки', reviewZh: '卡其色。' },
    { factPath: paths.material, valueRu: 'Оксфорд', reviewZh: '牛津布。' },
    { factPath: paths.cats, valueRu: 'Для кошек', reviewZh: '适用于猫。' } ] }
};

test('saved vest shaped content keeps common Russian and Chinese claims but removes khaki references', () => {
  const content = buildC1SiblingNeutralContent(vestPlan);
  assert.equal(content.seoTitleDraft.text, 'Одежда для животных: мини-жилет для кошек');
  assert.equal(content.seoTitleDraft.reviewZh, '宠物服装：适用于猫的迷你背心。');
  assert.equal(content.descriptionDraft.text,
    'Мини-жилет из ткани оксфорд подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.');
  assert.equal(content.descriptionDraft.reviewZh, '牛津布迷你背心适用于猫，也可以套在酒瓶上，四季适用。');
  assert.equal(content.bulletPointsDraft[0].text, vestPlan.bulletPointsDraft[0].text);
  assert.deepEqual(content.searchKeywordsDraft.keywords.map(item => item.query), ['Оксфорд', 'Для кошек']);
  assert.deepEqual(content.seoEvidenceLayer.russianAttributes.map(item => item.valueRu), ['Оксфорд', 'Для кошек']);
  const { differences, ...productCopy } = content;
  assert.ok(!JSON.stringify(productCopy).includes('хаки'));
  assert.ok(!JSON.stringify(productCopy).includes('卡其色'));
  assert.ok(!JSON.stringify(productCopy).includes(paths.color));
  assert.ok(!JSON.stringify(productCopy).includes(paths.colorName));
  assert.ok(!JSON.stringify(productCopy).includes(colorRef));
  assert.deepEqual(differences.removedKeywords, ['хаки']);
  assert.equal(vestPlan.seoTitleDraft.text.endsWith('хаки'), true);
});

test('unverified color aliases in either language require an explicit source revision', () => {
  for (const change of [
    plan => { plan.seoTitleDraft.text = 'Одежда для животных: мини-жилет для кошек, Khaki'; },
    plan => { plan.seoTitleDraft.reviewZh = '宠物服装：适用于猫的卡其迷你背心。'; }
  ]) {
    const source = structuredClone(vestPlan);
    change(source);
    assert.throws(() => buildC1SiblingNeutralContent(source), /C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION/);
  }
});

test('a known color mixed with an unverified alias in the same field cannot be projected', () => {
  for (const change of [
    plan => { plan.seoTitleDraft.text = 'Одежда для животных: мини-жилет для кошек, хаки Khaki'; },
    plan => { plan.seoTitleDraft.reviewZh = '宠物服装：适用于猫的卡其色 卡其迷你背心。'; },
    plan => { plan.seoTitleDraft.text = 'Одежда для животных: хаки, мини-жилет для кошек Khaki'; },
    plan => { plan.seoTitleDraft.reviewZh = '宠物服装：卡其色迷你背心，适用于猫。卡其'; },
    plan => { plan.seoTitleDraft.text = 'Одежда для животных: мини-жилет для кошек, песочный хаки'; },
    plan => { plan.seoTitleDraft.reviewZh = '宠物服装：适用于猫的棕黄 卡其色迷你背心。'; }
  ]) {
    const source = structuredClone(vestPlan);
    change(source);
    assert.throws(() => buildC1SiblingNeutralContent(source), /C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION/);
  }
});

test('reviewed color slots allow normal words after the exact color without interpreting them as aliases', () => {
  const source = structuredClone(vestPlan);
  source.descriptionDraft.text = 'Мини-жилет из ткани оксфорд цвета хаки подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.';
  source.seoTitleDraft.reviewZh = '宠物服装：适用于猫的卡其色 迷你背心。';
  const content = buildC1SiblingNeutralContent(source);
  assert.equal(content.descriptionDraft.text,
    'Мини-жилет из ткани оксфорд подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.');
  assert.equal(content.seoTitleDraft.reviewZh, '宠物服装：适用于猫的迷你背心。');
});
