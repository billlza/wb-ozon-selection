import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaForColor, UNKNOWN } from "./product-core.mjs";

/**
 * 平台薄映射：从商品中立核心（product-core.mjs）生成某个平台需要的形状，并指出缺什么。
 *
 * 每个平台只提供三样东西：一份平台规格（data/platform-profiles/<platform>.json）、
 * 一组「平台属性 ← 中立字段」映射、以及该平台自己的类目和价格。事实、变体和图片都从核心读，
 * 所以 Ozon 和 WB 共用同一份资料，各自只多一层映射。
 *
 * 这里只算和检查，不调用任何平台接口，也不写任何业务状态。
 */

export const PLATFORM_LISTING_DRAFT_VERSION = "platform-listing-draft-v1";
const VARIANT_MODELS = Object.freeze(["offer_per_variant_grouped_by_model", "card_per_color_sizes_inside"]);
const DEFAULT_PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "platform-profiles");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const positiveOrNull = value => value === null || (Number.isFinite(value) && value > 0);

export class PlatformProjectionError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "PlatformProjectionError"; this.code = code; }
}
const fail = (code, message) => { throw new PlatformProjectionError(code, message); };

export function validatePlatformProfile(profile) {
  if (!isObject(profile) || !text(profile.profileVersion) || !text(profile.platform) ||
      !["verified", "unverified"].includes(profile.verificationStatus) || !VARIANT_MODELS.includes(profile.variantModel) ||
      !isObject(profile.content) || !positiveOrNull(profile.content.titleMaxChars) || !positiveOrNull(profile.content.descriptionMaxChars) ||
      !isObject(profile.media) || !positiveOrNull(profile.media.maxImages) || !positiveOrNull(profile.media.minWidth) ||
      !positiveOrNull(profile.media.minHeight) || !positiveOrNull(profile.media.aspectRatio) ||
      (profile.media.aspectRatio !== null && !(profile.media.aspectTolerance >= 0)) ||
      !isObject(profile.price) || !text(profile.price.writeCurrency)) {
    fail("PLATFORM_PROFILE_INVALID", `平台规格 ${profile?.platform ?? "?"} 结构无效`);
  }
  return Object.freeze(structuredClone(profile));
}

export async function loadPlatformProfile(platform, { directory = DEFAULT_PROFILE_DIR } = {}) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(platform)) fail("PLATFORM_PROFILE_NAME_INVALID", "平台名无效");
  const profile = validatePlatformProfile(JSON.parse(await readFile(path.join(directory, `${platform}.json`), "utf8")));
  if (profile.platform !== platform) fail("PLATFORM_PROFILE_MISMATCH", `${platform}.json 写的是 ${profile.platform}`);
  return profile;
}

const enabledVariants = core => core.variantGroup.variants.filter(item => item.enabled);
const colorKey = variant => variant.color?.source ?? null;

/**
 * 变体在平台上的分组方式：
 * - Ozon：每个颜色×尺码是一个独立 offer，同一款用同一个型号合并成一张卡；
 * - WB：每个颜色一张卡（一个 nmID），尺码放在卡里面。
 * 两者都只是同一个变体组的不同投影，平台编号（offer_id、nmID、chrtID）由适配器写入时再产生。
 */
export function projectVariants(core, profile) {
  const variants = enabledVariants(core);
  if (variants.length === 0) fail("PLATFORM_PROJECTION_NO_VARIANTS", "没有选中要上的规格");
  if (profile.variantModel === "offer_per_variant_grouped_by_model") {
    return { model: profile.variantModel, groupKey: core.productId,
      offers: variants.map(item => ({ variantId: item.variantId, supplierSkuId: item.supplierSkuId, color: item.color, size: item.size })) };
  }
  const cards = new Map();
  for (const item of variants) {
    const key = colorKey(item);
    if (!cards.has(key)) cards.set(key, { colorKey: key, color: item.color, sizes: [] });
    cards.get(key).sizes.push({ variantId: item.variantId, supplierSkuId: item.supplierSkuId, size: item.size });
  }
  return { model: profile.variantModel, groupKey: core.productId, cards: [...cards.values()] };
}

/** 按平台规格检查每个颜色的最终图集。宽高不知道时不算通过，也不猜。 */
export function checkMediaForPlatform(core, profile) {
  const issues = [];
  const colors = [...new Set(enabledVariants(core).map(colorKey))];
  for (const color of colors) {
    const label = color ?? "（无颜色）";
    const assets = color === null ? mediaForColor(core, "") : mediaForColor(core, color);
    if (assets.length === 0) { issues.push({ color, code: "MEDIA_MISSING", message: `${label}没有最终图片` }); continue; }
    if (profile.media.maxImages !== null && assets.length > profile.media.maxImages) {
      issues.push({ color, code: "MEDIA_TOO_MANY", message: `${label}有 ${assets.length} 张图，超过 ${profile.media.maxImages} 张` });
    }
    for (const asset of assets) {
      if (!(asset.width > 0 && asset.height > 0)) {
        issues.push({ color, assetId: asset.assetId, code: "MEDIA_SIZE_UNKNOWN", message: `${label}的 ${asset.assetId} 不知道宽高` });
        continue;
      }
      if ((profile.media.minWidth !== null && asset.width < profile.media.minWidth) ||
          (profile.media.minHeight !== null && asset.height < profile.media.minHeight)) {
        issues.push({ color, assetId: asset.assetId, code: "MEDIA_TOO_SMALL",
          message: `${label}的 ${asset.assetId} 是 ${asset.width}×${asset.height}，小于 ${profile.media.minWidth}×${profile.media.minHeight}` });
      }
      if (profile.media.aspectRatio !== null && Math.abs(asset.width / asset.height - profile.media.aspectRatio) > profile.media.aspectTolerance) {
        issues.push({ color, assetId: asset.assetId, code: "MEDIA_ASPECT_MISMATCH",
          message: `${label}的 ${asset.assetId} 宽高比 ${(asset.width / asset.height).toFixed(2)}，要求 ${profile.media.aspectRatio}` });
      }
    }
  }
  return { ready: issues.length === 0, issues };
}

function readSource(core, from, variant) {
  const [kind, ...rest] = String(from).split(":");
  const key = rest.join(":");
  if (kind === "fact") {
    const item = core.facts[key];
    if (!item) fail("PLATFORM_MAPPING_SOURCE_INVALID", `${from} 不是登记过的中立事实`);
    return item.status === "unknown" ? null : { value: item.value, ru: item.ru, sourcePath: `facts.${key}` };
  }
  if (kind === "supplierAttribute") {
    const item = core.supplierAttributes[key];
    return item ? { value: item.value, ru: item.ru, sourcePath: `supplierAttributes.${key}` } : null;
  }
  if (kind === "color" || kind === "size") {
    if (!variant) fail("PLATFORM_MAPPING_VARIANT_REQUIRED", `${from} 要按规格解析`);
    const item = variant[kind];
    return item ? { value: item.source, ru: item.ru, sourcePath: `variants.${variant.variantId}.${kind}` } : null;
  }
  fail("PLATFORM_MAPPING_SOURCE_INVALID", `${from} 不是可识别的中立字段`);
}

/**
 * 把「平台属性 ← 中立字段」映射解析成取值。
 * 映射项：{ platformAttributeId, from: "fact:material" | "supplierAttribute:面料" | "color" | "size",
 *          use: "value" | "ru", valueMap?: { 中立取值: 平台取值 }, required?: boolean }
 * 每个取值都带 sourcePath，能追回中立核心里的哪一项。缺的进 gaps，不编造。
 */
export function resolveAttributeMappings(core, mappings, { variantId = null } = {}) {
  if (!Array.isArray(mappings)) fail("PLATFORM_MAPPING_INVALID", "映射必须是列表");
  const variant = variantId === null ? null : core.variantGroup.variants.find(item => item.variantId === variantId);
  if (variantId !== null && !variant) fail("PLATFORM_MAPPING_VARIANT_MISSING", `${variantId} 不在变体组里`);
  const values = [], gaps = [];
  for (const mapping of mappings) {
    if (!isObject(mapping) || !(text(mapping.platformAttributeId) || Number.isSafeInteger(mapping.platformAttributeId)) ||
        !["value", "ru"].includes(mapping.use ?? "value")) {
      fail("PLATFORM_MAPPING_INVALID", "映射项缺少平台属性或取值方式");
    }
    const source = readSource(core, mapping.from, variant);
    const raw = source === null ? null : (mapping.use === "ru" ? source.ru : source.value);
    const mapped = raw === null || raw === UNKNOWN ? null
      : isObject(mapping.valueMap) ? (Object.hasOwn(mapping.valueMap, String(raw)) ? mapping.valueMap[String(raw)] : null) : raw;
    if (mapped === null) {
      const reason = source === null ? "中立核心里还没有这项" : raw === null ? "还没有俄文" : "没有对应的平台取值";
      if (mapping.required !== false) gaps.push({ platformAttributeId: mapping.platformAttributeId, from: mapping.from, reason });
      continue;
    }
    values.push({ platformAttributeId: mapping.platformAttributeId, value: structuredClone(mapped), sourcePath: source.sourcePath });
  }
  return { values, gaps };
}

export function checkContentForPlatform(content, profile) {
  const issues = [];
  if (!isObject(content) || !text(content.title)) issues.push({ code: "CONTENT_TITLE_MISSING", message: "缺少标题" });
  else if (profile.content.titleMaxChars !== null && [...content.title].length > profile.content.titleMaxChars) {
    issues.push({ code: "CONTENT_TITLE_TOO_LONG", message: `标题 ${[...content.title].length} 字，超过 ${profile.content.titleMaxChars}` });
  }
  if (!isObject(content) || !text(content.description)) issues.push({ code: "CONTENT_DESCRIPTION_MISSING", message: "缺少描述" });
  else if (profile.content.descriptionMaxChars !== null && [...content.description].length > profile.content.descriptionMaxChars) {
    issues.push({ code: "CONTENT_DESCRIPTION_TOO_LONG", message: `描述 ${[...content.description].length} 字，超过 ${profile.content.descriptionMaxChars}` });
  }
  return { ready: issues.length === 0, issues };
}

/**
 * 某个平台＋店铺的上架草稿：核心的投影加上该平台自己的类目、属性映射、文案和价格。
 * ready=false 时 gaps 写清楚还缺什么；这里不产生授权，也不发起写入。
 */
export function buildPlatformListingDraft({ core, profile, storeRef, category = null, attributeMappings = [], content = null, price = null }) {
  if (!isObject(storeRef) || !text(storeRef.stableStoreId)) fail("PLATFORM_LISTING_STORE_REQUIRED", "缺少稳定店铺身份");
  const variants = projectVariants(core, profile);
  const shared = resolveAttributeMappings(core, attributeMappings.filter(item => !["color", "size"].includes(item.from)));
  const perVariant = enabledVariants(core).map(item => ({ variantId: item.variantId,
    ...resolveAttributeMappings(core, attributeMappings.filter(mapping => ["color", "size"].includes(mapping.from)), { variantId: item.variantId }) }));
  const media = checkMediaForPlatform(core, profile);
  const contentCheck = checkContentForPlatform(content, profile);
  const gaps = [];
  if (!isObject(category)) gaps.push({ area: "category", message: "还没有平台类目" });
  for (const gap of shared.gaps) gaps.push({ area: "attributes", ...gap });
  for (const item of perVariant) for (const gap of item.gaps) gaps.push({ area: "attributes", variantId: item.variantId, ...gap });
  for (const issue of media.issues) gaps.push({ area: "media", ...issue });
  for (const issue of contentCheck.issues) gaps.push({ area: "content", ...issue });
  if (!isObject(price) || !(price.amount > 0)) gaps.push({ area: "price", message: "还没有价格" });
  else if (price.currency !== profile.price.writeCurrency) {
    gaps.push({ area: "price", message: `写入币种应为 ${profile.price.writeCurrency}，不是 ${price.currency}` });
  }
  return Object.freeze({
    draftVersion: PLATFORM_LISTING_DRAFT_VERSION,
    platform: profile.platform, profileVersion: profile.profileVersion, profileVerified: profile.verificationStatus === "verified",
    storeRef: structuredClone(storeRef),
    core: { productId: core.productId, builtAt: core.builtAt },
    category: structuredClone(category), variants, attributes: { shared: shared.values, perVariant: perVariant.map(({ variantId, values }) => ({ variantId, values })) },
    content: structuredClone(content), price: structuredClone(price),
    gaps, ready: gaps.length === 0
  });
}
