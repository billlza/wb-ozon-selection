import { buildProductCore, withMedia, withRussian, validateProductCore } from "./product-core.mjs";
import { buildPlatformListingDraft } from "./platform-projection.mjs";
import { readDeclaredCargoFacts } from "./cargo-facts-declaration.mjs";
import { readOwnerProductFacts } from "./owner-product-facts.mjs";

/**
 * 从工作台现有记录组装一份商品中立核心：原商品和它的各个颜色候选（siblingSourceV1）算同一款。
 *
 * 只读：不改任何候选、不写状态、不调用平台。现有 C1 / C2 流程照旧按每个颜色各走一遍，
 * 这里把它们已经产出的东西收拢到核心里：
 * - C1 在 Ozon 属性映射时确认过的俄文（含颜色名），挂回对应的中立字段；
 * - C2 每个颜色主人确认的最终图，只出现在一个颜色里的归该颜色，多个颜色都用的归共用图集。
 * 收不进去或有冲突的地方写进 notes，不猜、不抛错，页面照样能看。
 */

export const PRODUCT_CORE_FAMILY_VERSION = "product-core-family-v1";
const COLOR_FIELD_KEYS = new Set(["颜色", "颜色分类", "颜色名称"]);
const OZON_COLOR_NAME_ATTRIBUTE = "10097";

export class ProductCoreFamilyError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "ProductCoreFamilyError"; this.code = code; }
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const supplierSkuOf = candidate => candidate.lifecycleV11?.skuPackage?.supplierSkuId ?? candidate.siblingSourceV1?.supplierSkuId ?? null;
const sourcePlatformOf = url => /yangkeduo\.com|pinduoduo\.com/.test(url ?? "") ? "pinduoduo" : "1688";

function familyOf(document, candidateId) {
  const candidates = Array.isArray(document?.candidates) ? document.candidates : null;
  if (!candidates) throw new ProductCoreFamilyError("PRODUCT_CORE_FAMILY_DOCUMENT_INVALID", "候选记录不可用");
  const start = candidates.find(item => item.id === candidateId);
  if (!start) throw new ProductCoreFamilyError("PRODUCT_CORE_FAMILY_CANDIDATE_MISSING", "候选不存在");
  const rootId = start.siblingSourceV1?.parentCandidateId ?? start.id;
  const root = candidates.find(item => item.id === rootId);
  if (!root) throw new ProductCoreFamilyError("PRODUCT_CORE_FAMILY_PARENT_MISSING", "原商品不存在");
  return [root, ...candidates.filter(item => item.siblingSourceV1?.parentCandidateId === root.id)];
}

function readOrNote(read, candidate, notes, label) {
  try { return read(candidate); }
  catch (error) { notes.push({ area: "facts", candidateId: candidate.id, message: `${label}记录无效，按未知处理（${error.code ?? error.message}）` }); return null; }
}

/** Ozon 属性映射里确认过的俄文 → 中立字段。颜色优先用「颜色名称」那一项。 */
function russianFromOzonMappings({ core, member, variantColor, notes }) {
  const sku = member.lifecycleV11?.skuPackage;
  const mappings = sku?.ozonAttributeMappingsV1?.mappings;
  const plan = sku?.c1ProductPlan;
  if (!Array.isArray(mappings) || !isObject(plan)) return [];
  const ordered = [...mappings.entries()].sort(([, a], [, b]) =>
    (a.attributeId === OZON_COLOR_NAME_ATTRIBUTE) - (b.attributeId === OZON_COLOR_NAME_ATTRIBUTE));
  const entries = [];
  for (const [index, mapping] of ordered) {
    const match = /^productAttributes\.supplierAttributes\.(\d+)\.fact$/.exec(mapping?.sourceFactPath ?? "");
    const field = match ? plan.productAttributes?.supplierAttributes?.[Number(match[1])] : null;
    if (!field || !text(mapping.value)) continue;
    const sourceRef = `${member.id}#/lifecycleV11/skuPackage/ozonAttributeMappingsV1/mappings/${index}`;
    if (COLOR_FIELD_KEYS.has(field.fieldKey)) {
      if (variantColor) entries.push({ target: "color", key: variantColor, ru: mapping.value, sourceRef });
    } else if (core.supplierAttributes[field.fieldKey]) {
      entries.push({ target: "supplierAttribute", key: field.fieldKey, ru: mapping.value, sourceRef });
      if (field.fieldKey === "材质" && core.facts.material.status !== "unknown") entries.push({ target: "fact", key: "material", ru: mapping.value, sourceRef });
    } else {
      notes.push({ area: "translation", candidateId: member.id, message: `「${field.fieldKey}」不在货源采集的属性里，俄文「${mapping.value}」没有收进核心` });
    }
  }
  return entries;
}

function mediaFromFinalUploads({ core, members, notes }) {
  const perMember = [];
  for (const member of members) {
    const uploads = member.lifecycleV11?.skuPackage?.c2FinalAssets?.assets?.finalUploads;
    if (!Array.isArray(uploads) || uploads.length === 0) continue;
    const variant = core.variantGroup.variants.find(item => item.supplierSkuId === supplierSkuOf(member));
    perMember.push({ member, color: variant?.color?.source ?? null,
      uploads: [...uploads].filter(item => /^[a-f0-9]{64}$/.test(item?.sha256 ?? "") && item.mediaType === "image").sort((a, b) => a.order - b.order) });
  }
  if (perMember.length === 0) return null;
  const colorsBySha = new Map();
  for (const { color, uploads } of perMember) for (const item of uploads) {
    if (!colorsBySha.has(item.sha256)) colorsBySha.set(item.sha256, new Set());
    colorsBySha.get(item.sha256).add(color);
  }
  // 某个颜色的首图一定是这个颜色的图；它若又出现在别的颜色图集里，就不能当共用图（小狗雨衣就是这样串色的）。
  const crossed = perMember.filter(({ uploads }) => uploads.length > 0 && colorsBySha.get(uploads[0].sha256).size > 1);
  if (crossed.length > 0) {
    notes.push({ area: "media", message: `最终图没能收进素材集：${crossed.map(({ color }) => `「${color}」的首图也出现在别的颜色图集里`).join("；")}` });
    return null;
  }
  const assets = new Map(), shared = [], byColor = {};
  for (const { color, uploads } of perMember) {
    for (const item of uploads) {
      const assetId = `sha256:${item.sha256}`;
      const multi = colorsBySha.get(item.sha256).size > 1 || color === null;
      if (!assets.has(assetId)) {
        assets.set(assetId, { assetId, sha256: item.sha256, ref: item.assetRef, width: item.width ?? null, height: item.height ?? null,
          colorBinding: multi ? null : color, colorBindingSource: multi ? "inferred_shared" : "inferred_single_color" });
      }
      if (multi) { if (!shared.includes(assetId)) shared.push(assetId); }
      else (byColor[color] ??= []).push(assetId);
    }
  }
  const sharedCount = shared.length;
  if (sharedCount > 0) {
    notes.push({ area: "media", message: `${sharedCount} 张图在多个颜色里都用了，按和颜色无关的共用图处理；请确认这些图里没有具体颜色（尺码表、测量图可以，某个颜色的场景图不行）` });
  }
  return { assets: [...assets.values()], shared, byColor };
}

/**
 * 组装一款商品的中立核心。返回 { core, members, notes }：
 * members 是这款商品在工作台里的各个颜色候选，notes 是收不进核心或需要人看一眼的地方。
 */
export function assembleProductCoreForFamily({ document, candidateId, builtAt }) {
  const members = familyOf(document, candidateId);
  const root = members[0];
  const capture = root.sourceCapture;
  if (!isObject(capture) || !text(capture.offerId) || !Array.isArray(capture.skuChoices) || capture.skuChoices.length === 0) {
    throw new ProductCoreFamilyError("PRODUCT_CORE_FAMILY_CAPTURE_MISSING", "原商品还没有货源采集记录");
  }
  const notes = [];
  const choiceIds = new Set(capture.skuChoices.map(item => String(item.sourceSkuId)));
  const memberSkus = members.map(supplierSkuOf).filter(id => id !== null && choiceIds.has(String(id))).map(String);
  const sourcePlatform = sourcePlatformOf(capture.sourceUrl);
  let core = buildProductCore({
    productId: `product:${sourcePlatform}:${capture.offerId}`, sourcePlatform, capture,
    supplierDraft: root.supplierDraftV1 ?? null,
    cargoFacts: readOrNote(readDeclaredCargoFacts, root, notes, "运输属性"),
    ownerFacts: root.lifecycleV11?.ownerProductFactsV1 === undefined ? null : readOrNote(readOwnerProductFacts, root, notes, "主人商品事实"),
    selectedSupplierSkuIds: memberSkus.length > 0 ? memberSkus : null,
    builtAt
  });

  const translations = new Map();
  for (const member of members) {
    const variant = core.variantGroup.variants.find(item => item.supplierSkuId === String(supplierSkuOf(member)));
    for (const entry of russianFromOzonMappings({ core, member, variantColor: variant?.color?.source ?? null, notes })) {
      const key = `${entry.target}:${entry.key}`, prior = translations.get(key);
      // 同一个颜色候选里后面的覆盖前面的（颜色名称排在最后）；不同候选给出不同译法时保留先到的并记下来。
      if (prior && prior.memberId !== member.id) {
        if (prior.ru !== entry.ru) notes.push({ area: "translation", message: `「${entry.key}」在不同颜色里译法不同：「${prior.ru}」和「${entry.ru}」，暂用前者` });
        continue;
      }
      entry.memberId = member.id;
      translations.set(key, entry);
    }
  }
  if (translations.size > 0) core = withRussian(core, [...translations.values()].map(({ memberId: _member, ...entry }) => entry));

  const media = mediaFromFinalUploads({ core, members, notes });
  if (media) {
    const result = validateProductCore({ ...structuredClone(core), media });
    if (result.valid) core = withMedia(core, media);
    else notes.push({ area: "media", message: `最终图没能收进素材集：${result.errors.map(item => item.message).join("；")}` });
  }

  return {
    familyVersion: PRODUCT_CORE_FAMILY_VERSION,
    core,
    members: members.map(member => ({ candidateId: member.id, supplierSkuId: supplierSkuOf(member),
      color: core.variantGroup.variants.find(item => item.supplierSkuId === String(supplierSkuOf(member)))?.color?.source ?? null,
      targetStore: member.targetStore ?? null, businessPhase: member.lifecycleV11?.skuPackage?.businessPhase ?? null })),
    notes
  };
}

/** 用同一份核心分别给出 Ozon 和 WB 的上架草稿。Ozon 沿用原商品已有的类目、文案和授权价格；WB 还没有映射，缺口照实列出。 */
export function buildFamilyListingDrafts({ assembled, document, profiles }) {
  const root = document.candidates.find(item => item.id === assembled.members[0].candidateId);
  const sku = root.lifecycleV11?.skuPackage, plan = sku?.c1ProductPlan;
  const content = text(plan?.seoTitleDraft?.text) || text(plan?.descriptionDraft?.text)
    ? { title: plan.seoTitleDraft?.text ?? null, description: plan.descriptionDraft?.text ?? null } : null;
  const category = plan?.platformCategory;
  const drafts = {};
  if (profiles.ozon) {
    drafts.ozon = buildPlatformListingDraft({ core: assembled.core, profile: profiles.ozon,
      storeRef: root.targetPlatform === "ozon" && isObject(root.storeRef) ? root.storeRef : { stableStoreId: root.targetStore ?? "unknown" },
      category: Number(category?.descriptionCategoryId) > 0 && Number(category?.typeId) > 0
        ? { descriptionCategoryId: Number(category.descriptionCategoryId), typeId: Number(category.typeId) } : null,
      attributeMappings: [{ platformAttributeId: OZON_COLOR_NAME_ATTRIBUTE, from: "color", use: "ru" }],
      content, price: sku?.productionAuthorization?.platformWritePrice ?? null });
  }
  if (profiles.wb) {
    drafts.wb = buildPlatformListingDraft({ core: assembled.core, profile: profiles.wb, storeRef: { stableStoreId: "wb" },
      category: null, attributeMappings: [{ platformAttributeId: "颜色", from: "color", use: "ru" }], content, price: null });
  }
  return drafts;
}
