import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ozonHashtagAttributeValue } from "./ozon-hashtag-attribute.mjs";
export { ozonHashtagAttributeValue };
import { fingerprintAuthorizedMedia } from "./production-authorization-preparation.mjs";
import { buildOzonOptionalAttributes } from "./ozon-submission-attributes.mjs";
import { selectC1DescriptionParts } from "./c1-description-content.mjs";

export const OZON_SELLER_API_ADAPTER_VERSION = "ozon-seller-api-production-adapter-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unwrap(value) {
  return isObject(value) && Object.hasOwn(value, "value") ? value.value : value;
}

function numberId(value, code) {
  const parsed = Number(unwrap(value));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${code}: 必须是当前Schema确认的正整数ID`);
  return parsed;
}

function unitToMm(value, unit) {
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "mm") return value;
  if (normalized === "cm") return value * 10;
  if (normalized === "m") return value * 1000;
  throw new Error("OZON_ADAPTER_PACKING_UNIT_REJECTED: 尺寸单位必须是mm、cm或m");
}

function weightToGrams(value, unit) {
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "g") return value;
  if (normalized === "kg") return value * 1000;
  throw new Error("OZON_ADAPTER_WEIGHT_UNIT_REJECTED: 重量单位必须是g或kg");
}


function textAttribute(binding, value) {
  if (!isObject(binding) || !Number.isInteger(binding.attributeId) || binding.attributeId <= 0 ||
      !Number.isInteger(binding.complexId) || binding.complexId < 0 || binding.dictionaryId !== 0) {
    throw new Error("OZON_ADAPTER_SCHEMA_BINDING_REJECTED: 普通文字字段缺少当前Schema写入绑定");
  }
  return {
    id: binding.attributeId,
    complex_id: binding.complexId,
    values: [{ dictionary_value_id: 0, value: String(value) }]
  };
}

function schemaBindings(value) {
  if (!isObject(value) || !nonEmpty(value.schemaRevision) || !nonEmpty(value.evidenceRef) ||
      !isObject(value.content) || !Array.isArray(value.requiredAttributes)) {
    throw new Error("OZON_ADAPTER_SCHEMA_BINDING_REJECTED: 未锁定当前Schema写入方式");
  }
  for (const binding of [...Object.values(value.content), ...value.requiredAttributes]) {
    if (!isObject(binding) || !nonEmpty(binding.fieldKey) || !Number.isInteger(binding.attributeId) || binding.attributeId <= 0 ||
        !Number.isInteger(binding.complexId) || binding.complexId < 0 ||
        !Number.isInteger(binding.dictionaryId) || binding.dictionaryId < 0) {
      throw new Error("OZON_ADAPTER_SCHEMA_BINDING_REJECTED: Schema字段绑定无效");
    }
  }
  return value;
}

function boundFactAttribute(field, binding) {
  const fact = field?.fact;
  if (!isObject(fact) || fact.verificationStatus !== "confirmed" || unwrap(fact) === "unknown") {
    throw new Error(`OZON_ADAPTER_REQUIRED_ATTRIBUTE_UNKNOWN: ${field?.fieldKey || "unknown"}`);
  }
  const raw = fact.value;
  if (Array.isArray(raw)) {
    if (binding.dictionaryId <= 0 || binding.isCollection !== true || !Number.isSafeInteger(binding.maxValueCount) || raw.length < 1 || raw.length > binding.maxValueCount ||
        raw.some(item=>!isObject(item) || !Number.isSafeInteger(item.dictionaryValueId) || item.dictionaryValueId <= 0 || !nonEmpty(item.value)) || new Set(raw.map(item=>item.dictionaryValueId)).size !== raw.length) throw new Error('OZON_ADAPTER_COLLECTION_VALUE_INVALID');
    return {id:binding.attributeId,complex_id:binding.complexId,values:raw.map(item=>({dictionary_value_id:item.dictionaryValueId,value:item.value}))};
  }
  if (binding.dictionaryId === 0) {
    const text = isObject(raw) ? raw.value : raw;
    if (!nonEmpty(String(text ?? ""))) throw new Error(`OZON_ADAPTER_REQUIRED_ATTRIBUTE_VALUE_INVALID: ${field.fieldKey}`);
    return textAttribute(binding, text);
  }
  if (!isObject(raw) || !Number.isInteger(raw.dictionaryValueId) || raw.dictionaryValueId <= 0 || !nonEmpty(raw.value)) {
    throw new Error(`OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED: ${field.fieldKey}`);
  }
  return {
    id: binding.attributeId,
    complex_id: binding.complexId,
    values: [{ dictionary_value_id: raw.dictionaryValueId, value: raw.value }]
  };
}

function requiredAttributes(attributes, bindings) {
  const fields = attributes?.requiredPlatformFields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("OZON_ADAPTER_REQUIRED_ATTRIBUTES_MISSING: 没有锁定平台必填属性");
  }
  const byKey = new Map(bindings.requiredAttributes.map((binding) => [binding.fieldKey, binding]));
  if (byKey.size !== fields.length || fields.some((field) => !byKey.has(field.fieldKey))) {
    throw new Error("OZON_ADAPTER_SCHEMA_BINDING_MISMATCH: 必填属性与当前Schema绑定不一致");
  }
  return fields.map((field) => boundFactAttribute(field, byKey.get(field.fieldKey)));
}

function assertRemoteAssets(finalUploads) {
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    throw new Error("OZON_ADAPTER_FINAL_ASSETS_MISSING: 没有主人确认的最终素材");
  }
  for (const asset of finalUploads) {
    if (asset?.ownerConfirmed !== true || asset?.productionEligible !== true || !nonEmpty(asset.assetId) || !/^https:\/\//i.test(String(asset.assetRef || ""))) {
      throw new Error("OZON_ADAPTER_REMOTE_ASSET_REQUIRED: Seller API只接受已确认的HTTPS最终素材地址");
    }
  }
}

/**
 * 发出去之前的最后一道：即将写进 import 请求的这批地址，必须就是主人授权的那批，
 * 顺序一字不差、第一张是主图。中途被换掉任何一张，这里的指纹立刻对不上。
 */
function assertAuthorizedMediaIsWhatWeSend(authorizedMedia, primaryImage, images) {
  if (!isObject(authorizedMedia) || !nonEmpty(authorizedMedia.fingerprint) ||
      !nonEmpty(authorizedMedia.primaryImage) || !Array.isArray(authorizedMedia.images)) {
    throw new Error("OZON_ADAPTER_AUTHORIZED_MEDIA_MISSING: 缺少主人授权的图片地址清单，不能发出");
  }
  if (authorizedMedia.primaryImage !== primaryImage ||
      images.length !== authorizedMedia.images.length ||
      images.some((url, index) => url !== authorizedMedia.images[index])) {
    throw new Error("OZON_ADAPTER_AUTHORIZED_MEDIA_DRIFT: 即将发出的图片地址或顺序与主人授权的不一致");
  }
  if (fingerprintAuthorizedMedia([primaryImage, ...images]) !== authorizedMedia.fingerprint) {
    throw new Error("OZON_ADAPTER_AUTHORIZED_MEDIA_DRIFT: 图片地址清单指纹与主人授权的不一致");
  }
}

/**
 * 主人的话是「确认都是 https 且能访问」。https 由 assertRemoteAssets 把关；
 * 「能访问」必须真的去碰一下每个地址——没给探针就直接拒绝，不许默认放行。
 */
export async function assertFinalAssetUrlsReachable({ finalUploads, probeAssetUrl }) {
  if (typeof probeAssetUrl !== "function") {
    throw new Error("OZON_ADAPTER_ASSET_REACHABILITY_PROBE_REQUIRED: 没有可用的地址可达性校验手段，不能发出");
  }
  for (const asset of finalUploads) {
    const url = String(asset?.assetRef || "");
    let result = null;
    try {
      result = await probeAssetUrl({ assetId: asset?.assetId, url, order: asset?.order });
    } catch (error) {
      throw new Error(`OZON_ADAPTER_ASSET_NOT_REACHABLE: ${url}访问失败（${error?.message || "unknown"}）`);
    }
    if (!isObject(result) || result.reachable !== true || !Number.isInteger(result.statusCode) ||
        result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`OZON_ADAPTER_ASSET_NOT_REACHABLE: ${url}不是公网可访问的图片地址`);
    }
  }
}

function evidenceRef(prefix, value) {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

export function buildOzonSellerImportRequest(payload) {
  if (!nonEmpty(payload?.merchantSku) || !nonEmpty(payload?.supplierSkuId)) throw new Error("OZON_ADAPTER_SKU_IDENTITY_REQUIRED: 必须分别锁定商家货号和供应SKU");
  if (!isObject(payload) || payload.platform !== "ozon") throw new Error("OZON_ADAPTER_PLATFORM_REJECTED: 只支持Ozon");
  if (payload.mode !== "single_sku_create_and_moderate" || payload.publishScope !== "create_and_allow_validation_moderation") {
    throw new Error("OZON_ADAPTER_SCOPE_REJECTED: Seller API商品导入会进入校验/审核，不支持伪装成仅保存草稿");
  }
  if (payload.platformWritePrice?.currency !== "CNY" || !Number.isFinite(payload.platformWritePrice?.amount) || payload.platformWritePrice.amount <= 0) {
    throw new Error("OZON_ADAPTER_PRICE_REJECTED: Ozon中国卖家后台价格必须是正数CNY");
  }
  if (!nonEmpty(payload.title) || !isObject(payload.content) || !nonEmpty(payload.content.description)) {
    throw new Error("OZON_ADAPTER_CONTENT_GAP: 标题或描述未锁定");
  }
  if (!isObject(payload.packing?.weight) || !isObject(payload.packing?.dimensions)) {
    throw new Error("OZON_ADAPTER_PACKING_GAP: 包装重量或尺寸未锁定");
  }
  assertRemoteAssets(payload.finalUploads);

  const descriptionCategoryId = numberId(payload.platformCategory?.descriptionCategoryId, "OZON_ADAPTER_CATEGORY_REJECTED");
  const typeId = numberId(payload.platformCategory?.typeId, "OZON_ADAPTER_TYPE_REJECTED");
  const bindings = schemaBindings(payload.schemaWriteBindings);
  const dimensions = payload.packing.dimensions;
  const weight = payload.packing.weight;
  const required = requiredAttributes(payload.attributes, bindings);
  const optional = buildOzonOptionalAttributes({ attributes: payload.attributes, platformSchemaAttributes: payload.platformSchemaAttributes }).attributes;
  const description = selectC1DescriptionParts(payload.content.description, payload.content.bulletPoints || []).map(part => part.text).join("\n\n");
  const keywords = ozonHashtagAttributeValue(payload.content.searchKeywords);

  const generated = [
    textAttribute(bindings.content.title, payload.title),
    textAttribute(bindings.content.description, description),
    textAttribute(bindings.content.searchKeywords, keywords)
  ];
  const allIds = [...required, ...optional, ...generated].map((item) => item.id);
  if (new Set(allIds).size !== allIds.length) throw new Error("OZON_ADAPTER_SCHEMA_BINDING_MISMATCH: 内容字段与必填属性ID冲突");
  const byId = new Map([...required, ...optional, ...generated].map((item) => [item.id, item]));
  const urls = payload.finalUploads.map((asset) => asset.assetRef);
  assertAuthorizedMediaIsWhatWeSend(payload.authorizedMedia, urls[0], urls.slice(1));
  // Keep the validated import shape: VAT uses "0", the optional old_price is omitted,
  // and new_description_category_id does not duplicate description_category_id.
  const item = {
    attributes: [...byId.values()],
    barcode: "",
    description_category_id: descriptionCategoryId,
    color_image: "",
    complex_attributes: [],
    currency_code: "CNY",
    depth: Math.round(unitToMm(Number(dimensions.length), dimensions.unit)),
    dimension_unit: "mm",
    height: Math.round(unitToMm(Number(dimensions.height), dimensions.unit)),
    images: urls.slice(1),
    name: payload.title,
    offer_id: payload.merchantSku,
    pdf_list: [],
    price: payload.platformWritePrice.amount.toFixed(2),
    primary_image: urls[0],
    type_id: typeId,
    vat: "0",
    weight: Math.round(weightToGrams(Number(weight.value), weight.unit)),
    weight_unit: "g",
    width: Math.round(unitToMm(Number(dimensions.width), dimensions.unit))
  };
  for (const field of ["depth", "height", "weight", "width"]) {
    if (!Number.isFinite(item[field]) || item[field] <= 0) throw new Error(`OZON_ADAPTER_PACKING_GAP: ${field}无效`);
  }
  return Object.freeze({
    adapterVersion: OZON_SELLER_API_ADAPTER_VERSION,
    schemaWriteBindings: structuredClone(bindings),
    endpoint: "/v3/product/import",
    body: { items: [item] },
    batchSize: 1,
    inventoryIncluded: false,
    published: false,
    activated: false
  });
}

/** Combine already validated, independently scoped SKU payloads into one import task. */
export function buildOzonSellerBatchImportRequests({ members, excludedOfferIds = [], productImportCapability, checkedAt }) {
  if (!Array.isArray(members) || members.length === 0) throw new Error("OZON_BATCH_MEMBERS_REQUIRED");
  if (!Array.isArray(excludedOfferIds) || excludedOfferIds.some(value => !nonEmpty(value)) ||
      new Set(excludedOfferIds).size !== excludedOfferIds.length) throw new Error("OZON_BATCH_EXCLUSIONS_INVALID");
  const limit = productImportCapability?.maxItemsPerRequest;
  if (productImportCapability?.status !== "verified" || !nonEmpty(productImportCapability.evidenceRef) ||
      !nonEmpty(productImportCapability.limitEvidenceRef) ||
      productImportCapability.endpoint !== "/v3/product/import" ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !nonEmpty(productImportCapability.validUntil) ||
      !nonEmpty(productImportCapability.limitObservedAt) ||
      !nonEmpty(checkedAt) || Number.isNaN(Date.parse(checkedAt)) ||
      Number.isNaN(Date.parse(productImportCapability.limitObservedAt)) ||
      Number.isNaN(Date.parse(productImportCapability.validUntil)) ||
      Date.parse(checkedAt) < Date.parse(productImportCapability.limitObservedAt) ||
      Date.parse(checkedAt) >= Date.parse(productImportCapability.validUntil)) {
    throw new Error("OZON_BATCH_LIMIT_EVIDENCE_REQUIRED");
  }
  const offers = new Set();
  const byColor = new Map();
  const mainColors = new Map();
  let expectedGrouping = null;
  const first = members[0]?.payload;
  const requests = members.map(member => {
    const { payload, colorKey, modelKey, sourceTechnicalStatus } = member ?? {};
    if (sourceTechnicalStatus !== "not_started") throw new Error("OZON_BATCH_SOURCE_ALREADY_STARTED");
    if (!nonEmpty(colorKey) || !nonEmpty(modelKey) || !isObject(payload) || payload.store !== first?.store ||
        !isObject(payload.storeRef) || !isDeepStrictEqual(payload.storeRef, first.storeRef) ||
        payload.warehouseRef !== first.warehouseRef || payload.credentialAlias !== first.credentialAlias) {
      throw new Error("OZON_BATCH_MEMBER_SCOPE_MISMATCH");
    }
    const request = buildOzonSellerImportRequest(payload);
    const item = request.body.items[0];
    if (excludedOfferIds.includes(item.offer_id)) throw new Error("OZON_BATCH_EXCLUDED_OFFER");
    if (offers.has(item.offer_id)) throw new Error("OZON_BATCH_DUPLICATE_OFFER");
    offers.add(item.offer_id);
    const grouping = `${item.description_category_id}:${item.type_id}:${modelKey}`;
    if (expectedGrouping !== null && grouping !== expectedGrouping) throw new Error("OZON_BATCH_GROUPING_MISMATCH");
    expectedGrouping = grouping;
    const priorImage = byColor.get(colorKey);
    if (priorImage && priorImage !== item.primary_image) throw new Error("OZON_BATCH_SAME_COLOR_IMAGE_MISMATCH");
    const priorColor = mainColors.get(item.primary_image);
    if (priorColor && priorColor !== colorKey) throw new Error("OZON_BATCH_DIFFERENT_COLOR_IMAGE_MISMATCH");
    byColor.set(colorKey, item.primary_image);
    mainColors.set(item.primary_image, colorKey);
    return { item, grouping };
  });
  const chunks = [];
  for (let start = 0; start < requests.length; start += limit) {
    const items = requests.slice(start, start + limit).map(({ item }) => structuredClone(item));
    chunks.push(Object.freeze({ endpoint: "/v3/product/import", body: { items },
      offerIds: items.map(item => item.offer_id), batchSize: items.length,
      limitEvidenceRef: productImportCapability.limitEvidenceRef, limitValidUntil: productImportCapability.validUntil }));
  }
  return Object.freeze(chunks);
}

function importItem(payload, offerId) {
  const items = payload?.result?.items;
  return Array.isArray(items) ? items.find((item) => String(item?.offer_id || "") === offerId) : null;
}

export function createOzonSellerApiProductionAdapter({ requestJson, probeAssetUrl }) {
  if (typeof requestJson !== "function") throw new Error("OZON_ADAPTER_TRANSPORT_REQUIRED: 缺少受控店铺传输器");
  const submitted = new Map();
  return Object.freeze({
    async createPlatformDraft(payload) {
      const request = buildOzonSellerImportRequest(payload);
      await assertFinalAssetUrlsReachable({ finalUploads: payload.finalUploads, probeAssetUrl });
      const offerId = payload.merchantSku;
      const imported = await requestJson({ store: payload.store, method: "POST", endpoint: request.endpoint, body: request.body, write: true });
      const taskId = imported?.result?.task_id;
      if (!nonEmpty(String(taskId || ""))) throw new Error("OZON_ADAPTER_IMPORT_RESPONSE_INVALID: 平台未返回task_id，结果未知");
      const info = await requestJson({ store: payload.store, method: "POST", endpoint: "/v1/product/import/info", body: { task_id: taskId }, write: false });
      const item = importItem(info, offerId);
      if (!item || item.status === "pending") throw new Error("OZON_ADAPTER_IMPORT_PENDING_UNKNOWN_OUTCOME: 单次状态回读未取得终态，禁止自动轮询");
      if (item.status === "failed" || (Array.isArray(item.errors) && item.errors.length > 0)) {
        throw new Error("OZON_ADAPTER_IMPORT_REJECTED: Ozon校验未通过");
      }
      const productId = String(item.product_id || item.productId || "");
      if (!nonEmpty(productId)) throw new Error("OZON_ADAPTER_PRODUCT_ID_MISSING: 导入终态没有商品ID");
      submitted.set(productId, {
        store: payload.store,
        offerId,
        title: payload.title,
        price: structuredClone(payload.platformWritePrice),
        finalUploads: structuredClone(payload.finalUploads)
      });
      return {
        status: "validation_or_moderation",
        productId,
        offerId,
        writeEvidenceRef: evidenceRef("ozon-seller-api:import", { taskId: String(taskId), productId, offerId }),
        moderationSubmitted: true,
        published: false,
        activated: false,
        advertisingOpened: false,
        inventoryModified: false,
        imagesUploaded: payload.finalUploads.length
      };
    },
    async readbackPlatformDraft(request) {
      const expected = submitted.get(String(request.productId));
      if (!expected) throw new Error("OZON_ADAPTER_READBACK_CONTEXT_MISSING: 当前进程没有该单SKU提交上下文");
      const info = await requestJson({ store: expected.store, method: "POST", endpoint: "/v3/product/info/list", body: { offer_id: [expected.offerId] }, write: false });
      const attributes = await requestJson({ store: expected.store, method: "POST", endpoint: "/v4/product/info/attributes", body: { filter: { offer_id: [expected.offerId], visibility: "ALL" }, limit: 10, sort_dir: "ASC" }, write: false });
      const item = (info?.items || []).find((entry) => String(entry?.offer_id || "") === expected.offerId);
      const attrItem = (attributes?.result || []).find((entry) => String(entry?.offer_id || "") === expected.offerId);
      const observedImages = [attrItem?.primary_image, ...(attrItem?.images || [])].filter(nonEmpty);
      if (!item || String(item.id || item.product_id || "") !== String(request.productId)) throw new Error("OZON_ADAPTER_READBACK_IDENTITY_MISMATCH: 商品ID或货号不一致");
      if (observedImages.length !== expected.finalUploads.length) throw new Error("OZON_ADAPTER_READBACK_MEDIA_MISMATCH: 平台图片数量与授权素材不一致");
      const observedPrice = Number(item.price?.price ?? item.price ?? NaN);
      if (!Number.isFinite(observedPrice)) throw new Error("OZON_ADAPTER_READBACK_PRICE_MISSING: 平台未返回可核验价格");
      return {
        status: "validation_or_moderation",
        productId: String(request.productId),
        title: item.name,
        price: { amount: observedPrice, currency: "CNY" },
        inventoryModified: false,
        finalUploadAssetIds: expected.finalUploads.map((asset) => asset.assetId),
        mainImageAssetId: expected.finalUploads[0].assetId,
        evidenceRef: evidenceRef("ozon-seller-api:readback", { productId: String(request.productId), offerId: expected.offerId, observedImages }),
        moderationSubmitted: true,
        published: false,
        activated: false
      };
    }
  });
}
