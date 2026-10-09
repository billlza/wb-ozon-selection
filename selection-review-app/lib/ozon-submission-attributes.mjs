const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const fail = code => { throw new Error(code); };

/** Build only explicitly confirmed optional attributes against the locked category schema. */
export function buildOzonOptionalAttributes({ attributes, platformSchemaAttributes }) {
  if (!object(attributes) || !Array.isArray(attributes.requiredPlatformFields)) fail("OZON_OPTIONAL_ATTRIBUTES_INPUT_INVALID");
  if (attributes.ozonAttributes === undefined) return { attributes: [], omissions: [] };
  if (!Array.isArray(attributes.ozonAttributes)) fail("OZON_OPTIONAL_ATTRIBUTES_INPUT_INVALID");
  const required = new Set(attributes.requiredPlatformFields.map(field => field.fieldKey));
  const optional = attributes.ozonAttributes.filter(field => !required.has(field.fieldKey));
  if (new Set(optional.map(field => field.fieldKey)).size !== optional.length) fail("OZON_OPTIONAL_ATTRIBUTES_DUPLICATE");
  const output = [], omissions = [];
  for (const field of optional) {
    if (field.fact?.verificationStatus === "unknown") {
      omissions.push({ fieldKey: field.fieldKey, reason: "fact_unconfirmed" });
      continue;
    }
    if (field.fact?.verificationStatus !== "confirmed" || !Array.isArray(field.fact.sourceRefs) ||
        field.fact.sourceRefs.length === 0 || !field.fact.sourceRefs.every(text)) fail("OZON_OPTIONAL_ATTRIBUTE_FACT_INVALID");
    if (!Array.isArray(platformSchemaAttributes)) fail("OZON_OPTIONAL_ATTRIBUTE_SCHEMA_REQUIRED");
    const matches = platformSchemaAttributes.filter(item => item.fieldKey === field.fieldKey);
    if (matches.length !== 1) fail("OZON_OPTIONAL_ATTRIBUTE_SCHEMA_MISMATCH");
    const schema = matches[0], id = Number(schema.fieldKey);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(schema.complexId) || schema.complexId < 0 ||
        !Number.isSafeInteger(schema.dictionaryId) || schema.dictionaryId < 0 || schema.required !== false) fail("OZON_OPTIONAL_ATTRIBUTE_SCHEMA_INVALID");
    const raw = field.fact.value;
    if (Array.isArray(raw)) {
      if (schema.dictionaryId <= 0 || schema.isCollection !== true || !Number.isSafeInteger(schema.maxValueCount) || raw.length < 1 || raw.length > schema.maxValueCount ||
          raw.some(item => !object(item) || !text(item.value) || !Number.isSafeInteger(item.dictionaryValueId) || item.dictionaryValueId <= 0) || new Set(raw.map(item=>item.dictionaryValueId)).size !== raw.length) fail('OZON_OPTIONAL_ATTRIBUTE_COLLECTION_INVALID');
      output.push({ id, complex_id: schema.complexId, values: raw.map(item=>({dictionary_value_id:item.dictionaryValueId,value:item.value})) });
      continue;
    }
    let value, dictionaryValueId;
    if (schema.dictionaryId === 0) {
      value = object(raw) ? raw.value : raw;
      if (!text(value) && !(typeof value === "number" && Number.isFinite(value))) fail("OZON_OPTIONAL_ATTRIBUTE_VALUE_INVALID");
      dictionaryValueId = 0;
    } else {
      if (!object(raw) || !text(raw.value) || !Number.isSafeInteger(raw.dictionaryValueId) || raw.dictionaryValueId <= 0) {
        fail("OZON_OPTIONAL_ATTRIBUTE_DICTIONARY_REQUIRED");
      }
      value = raw.value; dictionaryValueId = raw.dictionaryValueId;
    }
    output.push({ id, complex_id: schema.complexId, values: [{ dictionary_value_id: dictionaryValueId, value: String(value) }] });
  }
  return { attributes: output, omissions };
}
