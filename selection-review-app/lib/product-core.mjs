import { readDeclaredCargoFacts } from "./cargo-facts-declaration.mjs";
import { readOwnerProductFacts } from "./owner-product-facts.mjs";

/**
 * 商品中立核心（ProductCore）：一款货源商品在任何平台上架都要用到的事实、变体组和素材集。
 *
 * 这里不出现任何平台字段：没有 Ozon 属性 ID、字典值、类目，也没有 WB subjectID、nmID。
 * 平台只通过 platform-projection.mjs 从这份核心生成自己的映射，所以加一个平台不需要再采一遍、
 * 再确认一遍事实或再整理一遍图片。
 *
 * 核心只读不写：构建函数是纯函数，返回冻结对象；翻译、素材这类后续补充都返回新对象。
 */

export const PRODUCT_CORE_VERSION = "product-core-v1";
export const UNKNOWN = "unknown";

/** 中立事实的固定键。新增一项事实只需在这里登记，平台映射用 facts.<key> 引用。 */
export const PRODUCT_FACT_LABELS = Object.freeze({
  material: "材质",
  packedWeightKg: "打包重量（kg）",
  packageDimensionsCm: "包装尺寸（cm）",
  batteryType: "电池类型",
  batteryEnergyWh: "电池能量（Wh）",
  productForm: "商品形态",
  intendedUses: "适用对象",
  closureType: "闭合方式",
  adjustable: "是否可调",
  detachable: "是否可拆",
  countryOfOrigin: "产地国"
});
const FACT_KEYS = Object.keys(PRODUCT_FACT_LABELS);
const FACT_STATUSES = Object.freeze(["confirmed", "proposed", "unknown"]);

/** 货源页规格名 → 中立变体轴。没列出的规格名原样保留在 otherAxes 里，不猜它是颜色还是尺码。 */
const COLOR_AXIS_NAMES = Object.freeze(["颜色", "颜色分类", "颜色名称", "color", "colour", "цвет"]);
const SIZE_AXIS_NAMES = Object.freeze(["尺码", "尺寸", "大小", "size", "размер"]);

export class ProductCoreError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "ProductCoreError"; this.code = code; }
}
const fail = (code, message) => { throw new ProductCoreError(code, message); };

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const isoTime = value => text(value) && Number.isFinite(Date.parse(value));
const positive = value => Number.isFinite(value) && value > 0;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function axisOf(name) {
  const key = String(name).trim().toLowerCase();
  if (COLOR_AXIS_NAMES.includes(key)) return "color";
  if (SIZE_AXIS_NAMES.includes(key)) return "size";
  return null;
}

function axisValue(value) {
  return value === null || value === undefined || value === "" ? null : { source: String(value).trim(), ru: null, ruSourceRef: null };
}

function fact(value, status, sourceRef) {
  if (value === null || value === undefined || value === "" || value === UNKNOWN) {
    return { value: UNKNOWN, status: "unknown", sourceRef: null, ru: null, ruSourceRef: null };
  }
  return { value: structuredClone(value), status, sourceRef, ru: null, ruSourceRef: null };
}

/** 变体身份只来自货源 SKU，不来自任何平台编号。 */
export function productVariantId(productId, supplierSkuId) {
  return `${productId}:${supplierSkuId}`;
}

/**
 * 从一次货源采集和已保存的声明构建核心。
 *
 * - capture：供应采集记录（sourceCapture 形状：sourceUrl、offerId、title、skuChoices、supplierAttributes）。
 * - supplierDraft：主人填过的打包重量和尺寸（supplierDraftV1），可缺。
 * - cargoFacts：readDeclaredCargoFacts 的结果，可缺。
 * - ownerFacts：readOwnerProductFacts 的结果，可缺。
 * - selectedSupplierSkuIds：主人选中的规格；缺省时全部规格都进变体组，enabled 由此决定。
 *
 * 缺的事实一律是 unknown，不从标题、图片或其他规格倒推。
 */
export function buildProductCore({
  productId, sourcePlatform, capture, supplierDraft = null, cargoFacts = null, ownerFacts = null,
  selectedSupplierSkuIds = null, builtAt
}) {
  if (!text(productId)) fail("PRODUCT_CORE_ID_REQUIRED", "缺少商品核心编号");
  if (!["1688", "pinduoduo"].includes(sourcePlatform)) fail("PRODUCT_CORE_SOURCE_INVALID", "货源平台只能是 1688 或拼多多");
  if (!isObject(capture) || !text(capture.offerId) || !text(capture.sourceUrl) || !Array.isArray(capture.skuChoices) || capture.skuChoices.length === 0) {
    fail("PRODUCT_CORE_CAPTURE_INVALID", "货源采集缺少商品编号、链接或规格");
  }
  if (!isoTime(builtAt)) fail("PRODUCT_CORE_TIME_INVALID", "构建时间无效");
  const selected = selectedSupplierSkuIds === null ? null : new Set(selectedSupplierSkuIds.map(String));
  const captureRef = text(capture.captureId) ? capture.captureId : `capture:${sourcePlatform}:${capture.offerId}`;

  const variants = capture.skuChoices.map((choice, index) => {
    const supplierSkuId = String(choice?.sourceSkuId ?? "");
    if (!text(supplierSkuId)) fail("PRODUCT_CORE_VARIANT_INVALID", `第 ${index + 1} 个规格没有货源 SKU 编号`);
    const axes = { color: null, size: null }, otherAxes = {};
    for (const [name, value] of Object.entries(isObject(choice.attributes) ? choice.attributes : {})) {
      const axis = axisOf(name);
      if (axis && axes[axis] === null) axes[axis] = axisValue(value);
      else if (value !== null && value !== undefined && value !== "") otherAxes[name] = String(value);
    }
    return {
      variantId: productVariantId(productId, supplierSkuId),
      supplierSkuId,
      color: axes.color,
      size: axes.size,
      otherAxes,
      unitPriceCny: positive(choice.priceCny) ? choice.priceCny : UNKNOWN,
      supplierStock: Number.isSafeInteger(choice.stock) ? choice.stock : UNKNOWN,
      weightKg: positive(choice.weight?.value) && choice.weight.unit === "kg" ? choice.weight.value : UNKNOWN,
      supplierImageRef: text(choice.imageUrl) ? choice.imageUrl : null,
      sourceRef: `${captureRef}#/skuChoices/${index}`,
      enabled: selected === null || selected.has(supplierSkuId)
    };
  });
  if (new Set(variants.map(item => item.supplierSkuId)).size !== variants.length) {
    fail("PRODUCT_CORE_VARIANT_DUPLICATE", "货源规格编号重复");
  }

  const facts = Object.fromEntries(FACT_KEYS.map(key => [key, fact(null)]));
  const supplierAttributes = isObject(capture.supplierAttributes) ? capture.supplierAttributes : {};
  if (text(supplierAttributes.材质)) facts.material = fact(supplierAttributes.材质, "proposed", `${captureRef}#/supplierAttributes/材质`);
  if (isObject(supplierDraft)) {
    const draftRef = `supplier-draft:${capture.offerId}`;
    if (positive(supplierDraft.packedWeightKg)) facts.packedWeightKg = fact(supplierDraft.packedWeightKg, "confirmed", `${draftRef}#/packedWeightKg`);
    const dims = supplierDraft.dimensionsCm;
    if (isObject(dims) && [dims.length, dims.width, dims.height].every(positive)) {
      facts.packageDimensionsCm = fact({ length: dims.length, width: dims.width, height: dims.height }, "confirmed", `${draftRef}#/dimensionsCm`);
    }
  }
  if (isObject(cargoFacts) && text(cargoFacts.sourceRef)) {
    if (cargoFacts.batteryType !== UNKNOWN) facts.batteryType = fact(cargoFacts.batteryType, "confirmed", cargoFacts.sourceRef);
    if (Number.isFinite(cargoFacts.batteryEnergyWh)) facts.batteryEnergyWh = fact(cargoFacts.batteryEnergyWh, "confirmed", cargoFacts.sourceRef);
  }
  if (isObject(ownerFacts) && isObject(ownerFacts.facts)) {
    for (const key of ["productForm", "intendedUses", "closureType", "adjustable", "detachable"]) {
      if (ownerFacts.facts[key] !== null && ownerFacts.facts[key] !== undefined) {
        facts[key] = fact(ownerFacts.facts[key], "confirmed", `${ownerFacts.declarationId}#/facts/${key}`);
      }
    }
  }

  const core = {
    coreVersion: PRODUCT_CORE_VERSION,
    productId,
    source: { platform: sourcePlatform, offerId: capture.offerId, productUrl: capture.sourceUrl, captureRef,
      title: text(capture.title) ? capture.title : null },
    facts,
    supplierAttributes: Object.fromEntries(Object.entries(supplierAttributes).filter(([, value]) => text(value) || Number.isFinite(value))
      .map(([key, value]) => [key, { value: String(value), ru: null, ruSourceRef: null }])),
    variantGroup: { axes: ["color", "size"].filter(axis => variants.some(item => item[axis] !== null)), variants },
    media: { assets: [], shared: [], byColor: {} },
    builtAt
  };
  assertValidProductCore(core);
  return deepFreeze(core);
}

/** 用已有候选记录构建核心：只读现有声明，不改候选，也不要求候选已经走到哪个阶段。 */
export function productCoreFromCandidate(candidate, { builtAt }) {
  if (!isObject(candidate) || !text(candidate.id)) fail("PRODUCT_CORE_CANDIDATE_INVALID", "候选记录无效");
  const capture = candidate.sourceCapture;
  const sourcePlatform = /yangkeduo\.com|pinduoduo\.com/.test(capture?.sourceUrl ?? "") ? "pinduoduo" : "1688";
  return buildProductCore({
    productId: `product:${sourcePlatform}:${capture?.offerId}`,
    sourcePlatform, capture,
    supplierDraft: candidate.supplierDraftV1 ?? null,
    cargoFacts: readDeclaredCargoFacts(candidate),
    ownerFacts: candidate.lifecycleV11?.ownerProductFactsV1 === undefined ? null : readOwnerProductFacts(candidate),
    selectedSupplierSkuIds: Array.isArray(capture?.selectedSkuIds) && capture.selectedSkuIds.length > 0 ? capture.selectedSkuIds : null,
    builtAt
  });
}

/**
 * 给事实、货源属性或变体轴补俄文。俄文挂在中立字段上，任何平台都能用，
 * 不再像现在这样只存在于某个 Ozon 属性 ID 的取值里。
 * entries 每项：{ target: "fact" | "supplierAttribute" | "color" | "size", key, ru, sourceRef? }；sourceRef 记下这句俄文从哪来。
 */
export function withRussian(core, entries) {
  const next = structuredClone(core);
  for (const { target, key, ru, sourceRef = null } of entries) {
    if (!text(ru)) fail("PRODUCT_CORE_TRANSLATION_INVALID", `${target}:${key} 的俄文为空`);
    const variants = next.variantGroup.variants.filter(item => item[target]?.source === key);
    const apply = item => { item.ru = ru.trim(); item.ruSourceRef = text(sourceRef) ? sourceRef : null; };
    if (target === "fact" && next.facts[key] && next.facts[key].status !== "unknown") apply(next.facts[key]);
    else if (target === "supplierAttribute" && next.supplierAttributes[key]) apply(next.supplierAttributes[key]);
    else if ((target === "color" || target === "size") && variants.length > 0) for (const item of variants) apply(item[target]);
    else fail("PRODUCT_CORE_TRANSLATION_TARGET_MISSING", `${target}:${key} 不存在或还是 unknown`);
  }
  assertValidProductCore(next);
  return deepFreeze(next);
}

/**
 * 挂上最终素材。每张图都必须声明 colorBinding：null 表示和颜色无关（尺码表、测量图），
 * 否则写它属于哪个颜色。共用图集只能放和颜色无关的图，某个颜色的图集只能放该颜色或和颜色无关的图。
 * 没有声明的图直接拒绝，因为软件看不出图里是什么颜色（小狗雨衣就是共用图混进了别的颜色）。
 */
export function withMedia(core, { assets, shared = [], byColor = {} }) {
  const next = structuredClone(core);
  next.media = { assets: structuredClone(assets), shared: [...shared], byColor: structuredClone(byColor) };
  assertValidProductCore(next);
  return deepFreeze(next);
}

/** 某个颜色最终上传的图片顺序：先该颜色自己的图，再共用图。首图一定是该颜色自己的图。 */
export function mediaForColor(core, colorSource) {
  const own = core.media.byColor[colorSource] ?? [];
  const byId = new Map(core.media.assets.map(asset => [asset.assetId, asset]));
  return [...own, ...core.media.shared.filter(id => !own.includes(id))].map(id => byId.get(id));
}

export function validateProductCore(core) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });
  if (!isObject(core)) return { valid: false, errors: [{ path: "ProductCore", message: "必须是对象" }] };
  if (core.coreVersion !== PRODUCT_CORE_VERSION) push("coreVersion", `必须是 ${PRODUCT_CORE_VERSION}`);
  if (!text(core.productId)) push("productId", "必须是非空字符串");
  if (!isObject(core.facts)) push("facts", "必须是对象");
  else {
    for (const key of Object.keys(core.facts)) if (!FACT_KEYS.includes(key)) push(`facts.${key}`, "不是登记过的中立事实");
    for (const key of FACT_KEYS) {
      const item = core.facts[key];
      if (!isObject(item) || !FACT_STATUSES.includes(item.status)) push(`facts.${key}`, "缺少事实或状态无效");
      else if ((item.status === "unknown") !== (item.value === UNKNOWN)) push(`facts.${key}`, "unknown 状态和取值不一致");
      else if (item.status !== "unknown" && !text(item.sourceRef)) push(`facts.${key}.sourceRef`, "已知事实必须有来源");
    }
  }
  const variants = core.variantGroup?.variants;
  if (!Array.isArray(variants) || variants.length === 0) push("variantGroup.variants", "至少要有一个规格");
  else {
    const combos = new Set();
    variants.forEach((item, index) => {
      if (item.variantId !== productVariantId(core.productId, item.supplierSkuId)) push(`variantGroup.variants[${index}].variantId`, "必须由商品编号和货源 SKU 组成");
      const combo = `${item.color?.source ?? ""}|${item.size?.source ?? ""}|${JSON.stringify(item.otherAxes ?? {})}`;
      if (combos.has(combo)) push(`variantGroup.variants[${index}]`, "颜色、尺码和其他规格完全相同的规格重复");
      combos.add(combo);
    });
  }
  const media = core.media;
  if (!isObject(media) || !Array.isArray(media.assets) || !Array.isArray(media.shared) || !isObject(media.byColor)) {
    push("media", "素材集结构无效");
  } else {
    const colors = new Set((variants ?? []).map(item => item.color?.source).filter(Boolean));
    const byId = new Map();
    media.assets.forEach((asset, index) => {
      const path = `media.assets[${index}]`;
      if (!isObject(asset) || !text(asset.assetId) || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "") || !text(asset.ref)) {
        push(path, "缺少素材编号、sha256 或地址"); return;
      }
      if (byId.has(asset.assetId)) push(`${path}.assetId`, "素材编号重复");
      if (!Object.hasOwn(asset, "colorBinding")) push(`${path}.colorBinding`, "必须声明属于哪个颜色，和颜色无关写 null");
      else if (asset.colorBinding !== null && !colors.has(asset.colorBinding)) push(`${path}.colorBinding`, "不是变体组里的颜色");
      for (const field of ["width", "height"]) if (asset[field] !== null && asset[field] !== undefined && !positive(asset[field])) push(`${path}.${field}`, "必须是正数或 null");
      byId.set(asset.assetId, asset);
    });
    media.shared.forEach((id, index) => {
      const asset = byId.get(id);
      if (!asset) push(`media.shared[${index}]`, "引用了不存在的素材");
      else if (asset.colorBinding !== null) push(`media.shared[${index}]`, "共用图集只能放和颜色无关的图");
    });
    for (const [color, ids] of Object.entries(media.byColor)) {
      if (!colors.has(color)) push(`media.byColor.${color}`, "不是变体组里的颜色");
      if (!Array.isArray(ids)) { push(`media.byColor.${color}`, "必须是素材编号列表"); continue; }
      if (ids.length > 0 && byId.get(ids[0])?.colorBinding !== color) push(`media.byColor.${color}[0]`, "首图必须是这个颜色自己的图");
      ids.forEach((id, index) => {
        const asset = byId.get(id);
        if (!asset) push(`media.byColor.${color}[${index}]`, "引用了不存在的素材");
        else if (asset.colorBinding !== null && asset.colorBinding !== color) push(`media.byColor.${color}[${index}]`, `这张图属于「${asset.colorBinding}」，不能放进「${color}」`);
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidProductCore(core) {
  const result = validateProductCore(core);
  if (!result.valid) fail("PRODUCT_CORE_INVALID", result.errors.map(item => `${item.path}：${item.message}`).join("；"));
  return core;
}
