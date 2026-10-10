import { buildOzonOptionalAttributes } from './ozon-submission-attributes.mjs';
import { isDeepStrictEqual } from 'node:util';
import { PRODUCTION_ENTITY_REFERENCE_VERSION } from './production-entity-storage.mjs';

const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function oneAttribute(item, id) {
  const matches = item.attributes.filter(attribute => attribute.id === id);
  if (matches.length > 1) throw new Error(`SIBLING_PARENT_IMPORT_ATTRIBUTE_AMBIGUOUS:${id}`);
  return matches[0] ?? null;
}

function attributeValue(attribute) {
  if (!attribute) return null;
  if (!Array.isArray(attribute.values) || attribute.values.length !== 1) return null;
  return text(attribute.values[0]?.value);
}

/** Bind this sibling to the exact accepted parent import, not to a mutable product title. */
export function parentCardBinding(parentSku, document) {
  const item = parentSku?.dSoftwareExecution?.attempt?.request?.productImport?.body?.items?.[0];
  const reference = parentSku?.productionAuthorization;
  let authorization = reference;
  if (reference?.schemaVersion === PRODUCTION_ENTITY_REFERENCE_VERSION) {
    const records = document?.productionEntityRecords;
    const matches = Array.isArray(records) ? records.filter(record => record.entityId === reference.entityId) : [];
    if (reference.kind !== 'production_authorization' || matches.length !== 1 ||
        matches[0].kind !== reference.kind || !isDeepStrictEqual(matches[0].scope, reference.scope) ||
        matches[0].value?.authorizationId !== reference.entityId) {
      throw new Error('SIBLING_PARENT_CARD_BINDING_MISSING');
    }
    authorization = matches[0].value;
  }
  const assets = authorization?.lockedScope?.finalUploads;
  const preparedAssets = parentSku?.c2FinalAssets?.productionAuthorizationPreparation?.finalUploads;
  if (!item || !Array.isArray(parentSku.dSoftwareExecution.attempt.request.productImport.body.items) ||
      parentSku.dSoftwareExecution.attempt.request.productImport.body.items.length !== 1 ||
      !Array.isArray(item.attributes) || !Number.isSafeInteger(item.description_category_id) ||
      !Number.isSafeInteger(item.type_id) || !Array.isArray(assets) || assets.length === 0 ||
      !Array.isArray(preparedAssets) || preparedAssets.length !== assets.length ||
      assets.some((asset, index) => !/^[a-f0-9]{64}$/.test(String(asset.sha256 ?? '')) ||
        asset.sha256 !== preparedAssets[index]?.sha256) ||
      authorization.lockedScope.supplierSkuId !== parentSku.supplierSkuId) {
    throw new Error('SIBLING_PARENT_CARD_BINDING_MISSING');
  }
  const model = attributeValue(oneAttribute(item, 9048));
  const brand = attributeValue(oneAttribute(item, 85));
  if (!model || !brand) throw new Error('SIBLING_PARENT_CARD_BINDING_MISSING');
  return {
    descriptionCategoryId: item.description_category_id, typeId: item.type_id,
    model, brand, parentImageSha256s: assets.map(asset => asset.sha256)
  };
}

function confirmedField(fields, key) {
  const matches = fields?.filter(field => field.fieldKey === key) ?? [];
  if (matches.length !== 1 || matches[0].fact?.verificationStatus !== 'confirmed') return null;
  const raw = matches[0].fact.value;
  return text(typeof raw === 'object' && raw !== null ? raw.value : raw);
}

export function assertSiblingSkuColorProjection(candidate) {
  if (!candidate.siblingSourceV1) return;
  const sku = candidate.lifecycleV11?.skuPackage;
  const c1 = sku?.c1ProductPlan;
  const choice = candidate.sourceCapture?.skuChoices;
  const color = choice?.length === 1 && choice[0].sourceSkuId === sku.supplierSkuId
    ? text(choice[0].attributes?.颜色) : null;
  const supplierFacts = c1?.productAttributes?.supplierAttributes;
  const matchingFacts = Array.isArray(supplierFacts)
    ? supplierFacts.map((field, index) => ({ field, index }))
      .filter(({ field }) => field.fieldKey === '颜色' && field.fact?.verificationStatus === 'confirmed' && field.fact.value === color)
    : [];
  const mappings = sku?.ozonAttributeMappingsV1?.mappings;
  const mapped = c1?.productAttributes?.ozonAttributes;
  if (!color || matchingFacts.length !== 1 || !Array.isArray(mappings) || !Array.isArray(mapped)) {
    throw new Error('SIBLING_COLOR_BINDING_INVALID');
  }
  const sourcePath = `productAttributes.supplierAttributes.${matchingFacts[0].index}.fact`;
  const schemaAttributes = c1.inputSnapshots?.platformSchemaRules?.attributes;
  if (!Array.isArray(schemaAttributes)) throw new Error('SIBLING_COLOR_BINDING_INVALID');
  let optional;
  try {
    optional = buildOzonOptionalAttributes({ attributes: c1.productAttributes, platformSchemaAttributes: schemaAttributes });
  } catch (error) {
    if (!String(error.message).startsWith('OZON_OPTIONAL_')) throw error;
    throw new Error('SIBLING_COLOR_BINDING_INVALID');
  }
  // Both attributes must originate from this SKU's supplier fact. Their value
  // types come from the frozen category schema, not from a historical category.
  for (const fieldKey of ['10096', '10097']) {
    const matching = mappings.filter(mapping => String(mapping.attributeId) === fieldKey);
    const projection = mapped.filter(field => field.fieldKey === fieldKey);
    const schema = schemaAttributes.filter(field => field.fieldKey === fieldKey);
    const schemaField = schema[0];
    const requiredField = c1.productAttributes.requiredPlatformFields?.filter(field => field.fieldKey === fieldKey) ?? [];
    const emitted = optional.attributes.filter(field => field.id === Number(fieldKey));
    const required = schemaField?.required === true;
    const projectedValue = required ? requiredField[0]?.fact?.value : projection[0]?.fact?.value;
    if (matching.length === 1 && Array.isArray(matching[0].value)) {
      const mapping=matching[0], raw=mapping.dictionaryValues;
      if (fieldKey !== '10096' || schema.length !== 1 || schemaField.dictionaryId <= 0 || schemaField.isCollection !== true ||
          !Number.isSafeInteger(schemaField.maxValueCount) || !Array.isArray(raw) || raw.length < 1 || raw.length > schemaField.maxValueCount ||
          projection.length !== 1 || projection[0].sourceFactPath !== sourcePath || projection[0].fact?.verificationStatus !== 'confirmed' ||
          mapping.sourceFactPath !== sourcePath || mapping.sourceFactValue !== color || !text(mapping.confirmationRef ?? sku.ozonAttributeMappingsV1.confirmationRef) ||
          !isDeepStrictEqual(raw.map(item=>item.value),mapping.value) || new Set(raw.map(item=>item.dictionaryValueId)).size !== raw.length ||
          raw.some(item=>!text(item.value)||!Number.isSafeInteger(item.dictionaryValueId)||item.dictionaryValueId<=0) ||
          !isDeepStrictEqual(projection[0].fact.value,raw) || !isDeepStrictEqual(projectedValue,raw) ||
          (required ? requiredField.length !== 1 || requiredField[0].fact?.verificationStatus !== 'confirmed' || emitted.length !== 0 :
            emitted.length !== 1 || !isDeepStrictEqual(emitted[0].values,raw.map(item=>({dictionary_value_id:item.dictionaryValueId,value:item.value}))))) throw new Error('SIBLING_COLOR_BINDING_INVALID');
      continue;
    }
    if (matching.length !== 1 || projection.length !== 1 || schema.length !== 1 ||
        (required ? requiredField.length !== 1 || emitted.length !== 0 : emitted.length !== 1) ||
        matching[0].sourceFactPath !== sourcePath || matching[0].sourceFactValue !== color ||
        !text(matching[0].value) || !text(matching[0].confirmationRef ?? sku.ozonAttributeMappingsV1.confirmationRef) ||
        projection[0].sourceFactPath !== sourcePath || projection[0].fact?.verificationStatus !== 'confirmed' ||
        ![true, false].includes(schemaField.required) || !Number.isSafeInteger(schemaField.dictionaryId) ||
        (required ? requiredField[0].fact?.verificationStatus !== 'confirmed' :
          emitted[0].values?.length !== 1 || emitted[0].values[0].value !== matching[0].value)) {
      throw new Error('SIBLING_COLOR_BINDING_INVALID');
    }
    if (schemaField.dictionaryId > 0 ?
      (schema[0].dictionaryId <= 0 || !Number.isSafeInteger(matching[0].dictionaryValueId) ||
       matching[0].dictionaryValueId <= 0 || projection[0].fact.value?.value !== matching[0].value ||
       projection[0].fact.value?.dictionaryValueId !== matching[0].dictionaryValueId ||
       projectedValue?.value !== matching[0].value ||
       projectedValue?.dictionaryValueId !== matching[0].dictionaryValueId ||
       (!required && emitted[0].values[0].dictionary_value_id !== matching[0].dictionaryValueId)) :
      (matching[0].dictionaryValueId != null ||
       projection[0].fact.value !== matching[0].value || projectedValue !== matching[0].value ||
       (!required && emitted[0].values[0].dictionary_value_id !== 0))) {
      throw new Error('SIBLING_COLOR_BINDING_INVALID');
    }
  }
}

/** The final card must keep the same Ozon grouping keys and a distinct first image. */
export function assertSiblingSkuFinalCard(candidate) {
  const source = candidate.siblingSourceV1;
  if (!source) return;
  const binding = source.parentCardBinding;
  const sku = candidate.lifecycleV11?.skuPackage;
  const c1 = sku?.c1ProductPlan;
  const preparation = sku?.c2FinalAssets?.productionAuthorizationPreparation;
  const fields = c1?.productAttributes?.requiredPlatformFields;
  const category = Number(c1?.platformCategory?.descriptionCategoryId?.value);
  const type = Number(c1?.platformCategory?.typeId?.value);
  if (!binding || sku?.supplierSkuId !== source.supplierSkuId ||
      category !== binding.descriptionCategoryId || type !== binding.typeId ||
      confirmedField(fields, '9048') !== binding.model || confirmedField(fields, '85') !== binding.brand) {
    throw new Error('SIBLING_CARD_GROUPING_MISMATCH');
  }
  assertSiblingSkuColorProjection(candidate);
  const main = preparation?.finalUploads?.[0];
  if (main?.role !== 'main_image' || !/^[a-f0-9]{64}$/.test(String(main.sha256 ?? '')) ||
      binding.parentImageSha256s[0] === main.sha256 ||
      preparation.finalUploads.slice(1).some(asset => asset.sha256 === main.sha256)) {
    throw new Error('SIBLING_MAIN_IMAGE_NOT_DISTINCT');
  }
}
