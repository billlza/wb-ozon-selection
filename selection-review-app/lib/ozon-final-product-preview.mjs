import { readProductionCommercialDraft } from './production-commercial-draft.mjs';
import { buildOzonOptionalAttributes } from './ozon-submission-attributes.mjs';
import { selectC1DescriptionParts } from './c1-description-content.mjs';
import { ozonHashtagAttributeValue } from './ozon-hashtag-attribute.mjs';

/** Read-only display projection. Never constructs a request or grants production readiness.
 * Keep the joins and attribute selection aligned with buildOzonSellerImportRequest;
 * adapter parity tests make a change to that boundary visible here.
 */
const text = value => typeof value === 'string' && value.trim().length > 0;
const confirmed = fact => fact?.verificationStatus === 'confirmed';
const OPTIONAL_MAPPING_ERRORS = new Set(['OZON_OPTIONAL_ATTRIBUTES_INPUT_INVALID', 'OZON_OPTIONAL_ATTRIBUTES_DUPLICATE',
  'OZON_OPTIONAL_ATTRIBUTE_FACT_INVALID', 'OZON_OPTIONAL_ATTRIBUTE_SCHEMA_REQUIRED', 'OZON_OPTIONAL_ATTRIBUTE_SCHEMA_MISMATCH',
  'OZON_OPTIONAL_ATTRIBUTE_SCHEMA_INVALID', 'OZON_OPTIONAL_ATTRIBUTE_VALUE_INVALID', 'OZON_OPTIONAL_ATTRIBUTE_DICTIONARY_REQUIRED']);
const hasRussian = value => typeof value === 'string' && /[А-Яа-яЁё]/u.test(value);

function readableValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && text(value.value)) return value.value;
  if (value && typeof value.value === 'number' && Number.isFinite(value.value)) return String(value.value);
  if (value && text(value.name)) return value.name;
  return null;
}

function editorialDisplayCopy({ editorialPreview, seoEvidenceLayer, candidateId, candidateRevision, skuPackageId }) {
  const view = editorialPreview;
  if (view?.schemaVersion !== 'c1-completed-editorial-preview-v1' || view.status !== 'proposal_only' || view.canConfirm !== false ||
      view.candidateId !== candidateId || view.expectedRevision !== candidateRevision || view.skuPackageId !== skuPackageId ||
      view.sourceReceiptId !== seoEvidenceLayer?.aiReceiptId || view.sourceOutputFingerprint !== seoEvidenceLayer?.outputFingerprint ||
      view.providerReceiptReplaced !== false || view.productionAuthorized !== false) throw new Error('OZON_PREVIEW_EDITORIAL_SOURCE_MISMATCH');
  const output = view.content;
  if (!output || !Array.isArray(output.bulletPoints) || !Array.isArray(output.searchKeywords) ||
      [output.title, output.description, ...output.bulletPoints, ...output.searchKeywords]
        .some(item => !text(item?.text) || !text(item?.reviewZh))) throw new Error('OZON_PREVIEW_EDITORIAL_COPY_INVALID');
  return { title: output.title, description: output.description, bulletPoints: output.bulletPoints,
    searchKeywords: { keywords: output.searchKeywords.map(item => ({ ...item, query: item.text })) } };
}

export function buildOzonFinalProductPreview({ card, schemaSnapshot, platformSchemaAttributes, seoEvidenceLayer, savedSkuFactReconciliation, candidateId, candidateRevision, candidate, editorialPreview = null }) {
  if (!card || !card.seoDraft || !card.c1Facts) throw new Error('OZON_PREVIEW_CARD_REQUIRED');
  const commercialDraft = candidate === undefined ? null : readProductionCommercialDraft(candidate);
  if (commercialDraft && (candidate.id !== candidateId || candidate.dataRevision !== candidateRevision ||
      commercialDraft.skuPackageId !== card.productInformation?.sku?.value?.skuPackageId ||
      commercialDraft.supplierSkuId !== card.productInformation?.sku?.value?.supplierSkuId ||
      commercialDraft.variantKey !== card.productInformation?.sku?.value?.variantKey)) throw new Error('OZON_PREVIEW_COMMERCIAL_SOURCE_MISMATCH');
  const seo = editorialPreview === null ? card.seoDraft : editorialDisplayCopy({ editorialPreview, seoEvidenceLayer,
    candidateId, candidateRevision, skuPackageId: card.productInformation?.sku?.value?.skuPackageId });
  const bindings = confirmed(schemaSnapshot?.writeBindings) ? schemaSnapshot.writeBindings.value : null;
  const schemaFields = confirmed(schemaSnapshot?.requiredFields) && Array.isArray(schemaSnapshot.requiredFields.value)
    ? schemaSnapshot.requiredFields.value : [];
  const requirement = fieldKey => {
    const field = schemaFields.find(item => item.fieldKey === fieldKey) || platformSchemaAttributes?.find(item => item.fieldKey === fieldKey);
    return field?.required === true ? 'required' : field?.required === false ? 'optional' : 'undeclared';
  };
  const translationGaps = [];
  const copyPart = (key, label, value, reviewZh) => {
    const translated = text(reviewZh) ? reviewZh : null;
    if (hasRussian(value) && !translated) translationGaps.push({ key, label });
    return { key, label, value: text(value) ? value : null, reviewZh: translated };
  };
  const title = copyPart('title', '商品标题', seo.title?.text, seo.title?.reviewZh);
  let selectedDescriptionParts, descriptionIssue = null;
  try {
    selectedDescriptionParts = selectC1DescriptionParts(seo.description?.text, (seo.bulletPoints || []).map(item => item.text));
  } catch (error) {
    if (error.message !== 'C1_DESCRIPTION_CONTENT_INVALID') throw error;
    descriptionIssue = error.message;
  }
  const descriptionParts = (selectedDescriptionParts || []).map(part => part.source === 'description'
    ? copyPart('description', '描述正文', part.text, seo.description.reviewZh)
    : copyPart(`bullet:${part.index}`, `描述中的卖点 ${part.index + 1}`, part.text, seo.bulletPoints[part.index].reviewZh));
  const keywordParts = (seo.searchKeywords?.keywords || []).map((item, index) => ({
    ...copyPart(`keyword:${index}`, `搜索词 ${index + 1}`, item.query, item.reviewZh), keywordRole: item.keywordRole || null
  }));
  const content = [
    { ...title, binding: bindings?.content?.title || null, requirement: 'required', requirementSource: 'adapter', destination: 'name_and_attribute' },
    { key: 'description', label: '商品描述（含卖点）', value: descriptionParts.map(item => item.value).filter(text).join('\n\n'),
      reviewZh: descriptionParts.filter(part => part.value).every(part => part.reviewZh) ? descriptionParts.filter(part => part.value).map(part => part.reviewZh).join('\n\n') : null,
      parts: descriptionParts, binding: bindings?.content?.description || null, requirement: 'required', requirementSource: 'adapter', destination: 'attribute' },
    // 标签值必须与真正发出的 import 请求同源，所以调用适配器导出的那一个，不在这里另拼一份。
    { key: 'searchKeywords', label: '主题标签（Хештеги）', value: ozonHashtagAttributeValue(keywordParts.map(item => item.value).filter(text)),
      reviewZh: keywordParts.filter(part => part.value).every(part => part.reviewZh) ? keywordParts.filter(part => part.value).map(part => part.reviewZh).join('；') : null,
      parts: keywordParts, binding: bindings?.content?.searchKeywords || null, requirement: 'required', requirementSource: 'adapter', destination: 'attribute' }
  ];
  const attributeTranslations = seoEvidenceLayer?.russianAttributes || [];
  const categoryFact = card.c1Facts.platformCategory?.categoryPath;
  const categoryValues = Array.isArray(categoryFact?.value) ? categoryFact.value : [categoryFact?.value];
  const categoryParts = categoryValues.map((value, index) => {
    const factPath = Array.isArray(categoryFact?.value) ? `platformCategory.categoryPath.${index}` : 'platformCategory.categoryPath';
    const translation = confirmed(categoryFact) ? seoEvidenceLayer?.categoryPathReview?.find(item => item.factPath === factPath && item.valueRu === value) : null;
    return copyPart(`category:${index}`, `类目${categoryValues.length > 1 ? `第 ${index + 1} 级` : '路径'}`, value, translation?.reviewZh);
  });
  const productAttributes = card.c1Facts.productAttributes;
  const canonical = productAttributes?.ozonAttributes || [];
  const attributes = (productAttributes?.requiredPlatformFields || []).map(field => {
    const binding = bindings?.requiredAttributes?.find(item => item.fieldKey === field.fieldKey) || null;
    const raw = field.fact?.value;
    const value = readableValue(raw);
    const canonicalIndex = canonical.findIndex(item => item.fieldKey === field.fieldKey && readableValue(item.fact?.value) === value);
    const factPath = canonicalIndex >= 0 ? `productAttributes.ozonAttributes.${canonicalIndex}.fact` : null;
    const matchingTranslation = factPath ? attributeTranslations.find(item => item.factPath === factPath && item.valueRu === value) : null;
    const part = copyPart(`attribute:${field.fieldKey}`, field.labelZh || field.label || '商品属性', value, matchingTranslation?.reviewZh);
    const dictionaryReady = binding?.dictionaryId === 0 || (Number.isInteger(raw?.dictionaryValueId) && raw.dictionaryValueId > 0 && text(raw.value));
    return { ...part, fieldKey: field.fieldKey, labelZh: field.labelZh || null, binding,
      requirement: requirement(field.fieldKey), mapped: Boolean(binding && confirmed(field.fact) && value !== 'unknown' && value !== null && dictionaryReady) };
  });
  let optional, optionalMappingIssue = null;
  try {
    optional = buildOzonOptionalAttributes({ attributes: productAttributes, platformSchemaAttributes });
  } catch (error) {
    if (!OPTIONAL_MAPPING_ERRORS.has(error.message)) throw error;
    // A known submission blocker remains explicit; no attributes are claimed writable.
    optionalMappingIssue = error.message;
  }
  const requiredKeys = new Set(attributes.map(field => field.fieldKey));
  const optionalAttributes = canonical.flatMap((field, index) => {
    if (requiredKeys.has(field.fieldKey)) return [];
    const submitted = optional?.attributes.find(item => String(item.id) === field.fieldKey);
    const value = submitted ? submitted.values[0].value : readableValue(field.fact?.value);
    const factPath = `productAttributes.ozonAttributes.${index}.fact`;
    const matchingTranslation = attributeTranslations.find(item => item.factPath === factPath && item.valueRu === value);
    const part = copyPart(`attribute:${field.fieldKey}`, field.labelZh || field.label || '商品属性', value, matchingTranslation?.reviewZh);
    return [{ ...part, fieldKey: field.fieldKey, labelZh: field.labelZh || null,
      requirement: requirement(field.fieldKey), mapped: Boolean(submitted), binding: submitted ? { attributeId: submitted.id } : null,
      omission: optional?.omissions.find(item => item.fieldKey === field.fieldKey)?.reason || null }];
  });
  attributes.push(...optionalAttributes);
  const reconciliationMatches = Boolean(savedSkuFactReconciliation && savedSkuFactReconciliation.schemaVersion === 'saved-sku-fact-reconciliation-v1' &&
    savedSkuFactReconciliation.applicationStatus === 'prepared_from_saved_confirmations' &&
    savedSkuFactReconciliation.sourceCandidateId === candidateId && savedSkuFactReconciliation.sourceRevision === candidateRevision &&
    savedSkuFactReconciliation.skuPackageId === card.productInformation?.sku?.value?.skuPackageId &&
    savedSkuFactReconciliation.supplierSkuId === card.productInformation?.sku?.value?.supplierSkuId &&
    savedSkuFactReconciliation.variantKey === card.productInformation?.sku?.value?.variantKey &&
    savedSkuFactReconciliation.sourceCardId === card.cardId);
  const reconciledFacts = reconciliationMatches ? savedSkuFactReconciliation.records.filter(record => record.status === 'confirmed')
    .map(({ field, label, valueZh }) => ({ field, label, valueZh })) : [];
  return { commercialDraft, content, attributes, categoryParts, descriptionIssue, translationGaps, copyReadyForReview: content.every(field => text(field.value)) && translationGaps.length === 0, optionalMappingIssue, reconciledFacts, reconciliationStale: Boolean(savedSkuFactReconciliation && !reconciliationMatches), schemaAvailable: bindings !== null,
    completion: { contentFilled: content.filter(item => text(item.value)).length, contentTotal: content.length,
      attributesMapped: attributes.filter(item => item.mapped).length, attributesTotal: attributes.length,
      images: Array.isArray(card.c2Assets?.finalUploads) ? card.c2Assets.finalUploads.length : null },
    score: { status: 'unavailable', message: '暂无平台评分' } };
}
