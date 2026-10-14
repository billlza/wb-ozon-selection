const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = value => typeof value === "string" && value.trim().length > 0;

/**
 * Ozon 平台通用的三个内容字段属性号。发 import 时标题、描述、搜索词是作为**属性**写进去的
 * （`ozon-seller-api-production-adapter.mjs` 的 generated 三项），不是只发顶层 name。
 * 这三个号在 Ozon 是全站通用的；下面 derivePlatformWriteBindings 仍会逐个去当前类目的属性表里核对，
 * 对不上就不给绑定——宁可照实说缺，不编一个号发出去。
 */
const OZON_CONTENT_ATTRIBUTE_IDS = Object.freeze({ title: 4180, description: 4191, searchKeywords: 23171 });

/**
 * C1准备和D授权投影共用同一冻结Schema producer。
 * 显式绑定优先；没有显式绑定时，每个属性ID及元数据必须来自该Schema。
 * 缺少必要内容属性或数字元数据时返回null，由调用方保留unknown或明确阻断。
 */
export function derivePlatformWriteBindings(schema) {
  if (isObject(schema?.writeBindings)) return schema.writeBindings;
  const attributes = Array.isArray(schema?.attributes) ? schema.attributes : [];
  if (attributes.length === 0 || !nonEmptyString(schema?.schemaRevision) || !nonEmptyString(schema?.evidenceId)) return null;
  const byKey = new Map(attributes.map((item) => [String(item.fieldKey), item]));
  const bind = (fieldKey, attributeId, { textOnly = false } = {}) => {
    const attribute = byKey.get(String(attributeId));
    if (!isObject(attribute)) return null;
    if (attribute.complexId === null || attribute.dictionaryId === null) return null;
    const complexId = Number(attribute.complexId);
    const dictionaryId = Number(attribute.dictionaryId);
    if (!Number.isInteger(complexId) || complexId < 0 || !Number.isInteger(dictionaryId) || dictionaryId < 0) return null;
    // 标题/描述/搜索词走 textAttribute，那条路要求 dictionaryId 必须是 0。
    if (textOnly && dictionaryId !== 0) return null;
    return { fieldKey, attributeId: Number(attributeId), complexId, dictionaryId,
      ...(attribute.isCollection === true && Number.isSafeInteger(attribute.maxValueCount) ? {isCollection:true,maxValueCount:attribute.maxValueCount} : {}) };
  };
  const content = {};
  for (const [fieldKey, attributeId] of Object.entries(OZON_CONTENT_ATTRIBUTE_IDS)) {
    const binding = bind(fieldKey, attributeId, { textOnly: true });
    if (!binding) return null;
    content[fieldKey] = binding;
  }
  const requiredAttributes = [];
  for (const attribute of attributes) {
    if (attribute.required !== true) continue;
    const binding = bind(String(attribute.fieldKey), attribute.fieldKey);
    if (!binding) return null;
    requiredAttributes.push(binding);
  }
  if (requiredAttributes.length === 0) return null;
  return { schemaRevision: schema.schemaRevision, evidenceRef: schema.evidenceId, content, requiredAttributes };
}
