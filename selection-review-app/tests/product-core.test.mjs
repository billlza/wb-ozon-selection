import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProductCore, productCoreFromCandidate, withMedia, withRussian, mediaForColor, validateProductCore, PRODUCT_CORE_VERSION
} from "../lib/product-core.mjs";
import {
  loadPlatformProfile, projectVariants, checkMediaForPlatform, resolveAttributeMappings, checkContentForPlatform, buildPlatformListingDraft
} from "../lib/platform-projection.mjs";

const builtAt = "2026-10-09T23:50:00.000Z";
const COLORS = ["卡其", "黑CP", "CP", "黑色"];
const SIZES = ["S", "M"];
const sha = n => n.toString(16).padStart(64, "0");

function vestCapture() {
  let id = 1000;
  return {
    captureId: "capture-vest-1", offerId: "887766", sourceUrl: "https://detail.1688.com/offer/887766.html", title: "宠物背心",
    supplierAttributes: { 材质: "涤纶", 风格: "休闲" },
    skuChoices: COLORS.flatMap(color => SIZES.map(size => ({
      sourceSkuId: String(id++), attributes: { 颜色: color, 尺码: size }, priceCny: 9.5, stock: 200, weight: { value: 0.08, unit: "kg" },
      imageUrl: `https://cbu01.alicdn.com/${color}.jpg`
    })))
  };
}

function vestCore(options = {}) {
  return buildProductCore({ productId: "product:1688:887766", sourcePlatform: "1688", capture: vestCapture(),
    supplierDraft: { packedWeightKg: 0.12, dimensionsCm: { length: 20, width: 15, height: 3 } },
    cargoFacts: { batteryType: "none", batteryEnergyWh: null, sourceRef: "owner-cargo-facts:CX-1:3:2026-10-01T00:00:00.000Z" },
    builtAt, ...options });
}

function vestMedia({ width = 900, height = 1200 } = {}) {
  const assets = COLORS.map((color, index) => ({ assetId: `main-${index}`, sha256: sha(index + 1), ref: `https://oss.example/${index}.jpg`,
    width, height, colorBinding: color }));
  assets.push({ assetId: "size-chart", sha256: sha(99), ref: "https://oss.example/size.jpg", width, height, colorBinding: null });
  return { assets, shared: ["size-chart"], byColor: Object.fromEntries(COLORS.map((color, index) => [color, [`main-${index}`]])) };
}

test("one supplier capture becomes one variant group with colour and size axes", () => {
  const core = vestCore({ selectedSupplierSkuIds: ["1000", "1001", "1002"] });
  assert.equal(core.coreVersion, PRODUCT_CORE_VERSION);
  assert.deepEqual(core.variantGroup.axes, ["color", "size"]);
  assert.equal(core.variantGroup.variants.length, 8);
  assert.deepEqual(core.variantGroup.variants[0].color, { source: "卡其", ru: null, ruSourceRef: null });
  assert.deepEqual(core.variantGroup.variants[1].size, { source: "M", ru: null, ruSourceRef: null });
  assert.equal(core.variantGroup.variants.filter(item => item.enabled).length, 3);
  assert.equal(core.variantGroup.variants[0].variantId, "product:1688:887766:1000");
  assert.ok(Object.isFrozen(core.variantGroup.variants[0]));
  assert.equal(JSON.stringify(core).includes("ozon"), false, "核心不得出现平台字段");
});

test("facts come only from saved declarations; missing ones stay unknown", () => {
  const core = vestCore();
  assert.equal(core.facts.packedWeightKg.value, 0.12);
  assert.equal(core.facts.packedWeightKg.status, "confirmed");
  assert.deepEqual(core.facts.packageDimensionsCm.value, { length: 20, width: 15, height: 3 });
  assert.equal(core.facts.batteryType.value, "none");
  assert.equal(core.facts.material.status, "proposed");
  assert.equal(core.facts.closureType.value, "unknown");
  assert.equal(core.facts.closureType.sourceRef, null);
  assert.equal(core.supplierAttributes.风格.value, "休闲");
});

test("Russian is stored on the neutral field and reaches every variant of that colour", () => {
  const core = withRussian(vestCore(), [{ target: "color", key: "黑色", ru: "черный" }, { target: "fact", key: "material", ru: "полиэстер" }]);
  assert.deepEqual(core.variantGroup.variants.filter(item => item.color.source === "黑色").map(item => item.color.ru), ["черный", "черный"]);
  assert.equal(core.facts.material.ru, "полиэстер");
  assert.throws(() => withRussian(core, [{ target: "fact", key: "closureType", ru: "молния" }]), /PRODUCT_CORE_TRANSLATION_TARGET_MISSING/);
});

test("media: every image declares its colour and shared images must be colour-neutral", () => {
  const core = vestCore();
  const media = vestMedia();
  const withImages = withMedia(core, media);
  assert.deepEqual(mediaForColor(withImages, "黑色").map(asset => asset.assetId), ["main-3", "size-chart"]);
  assert.equal(core.media.assets.length, 0, "原核心不被改写");

  const unlabelled = structuredClone(media);
  delete unlabelled.assets[4].colorBinding;
  assert.throws(() => withMedia(core, unlabelled), /必须声明属于哪个颜色/);

  const scene = structuredClone(media);
  scene.assets.push({ assetId: "khaki-scene", sha256: sha(50), ref: "https://oss.example/scene.jpg", width: 900, height: 1200, colorBinding: "卡其" });
  scene.shared.push("khaki-scene");
  assert.throws(() => withMedia(core, scene), /共用图集只能放和颜色无关的图/);

  const crossed = structuredClone(media);
  crossed.byColor.黑色.push("main-0");
  assert.throws(() => withMedia(core, crossed), /这张图属于「卡其」，不能放进「黑色」/);

  const sharedFirst = structuredClone(media);
  sharedFirst.byColor.CP = ["size-chart", "main-2"];
  assert.throws(() => withMedia(core, sharedFirst), /首图必须是这个颜色自己的图/);
});

test("the same variant group projects to Ozon offers and to WB colour cards", async () => {
  const core = vestCore();
  const ozon = projectVariants(core, await loadPlatformProfile("ozon"));
  const wb = projectVariants(core, await loadPlatformProfile("wb"));
  assert.equal(ozon.offers.length, 8);
  assert.equal(new Set(ozon.offers.map(item => item.variantId)).size, 8);
  assert.deepEqual(wb.cards.map(card => card.colorKey), COLORS);
  assert.deepEqual(wb.cards[0].sizes.map(item => item.size.source), SIZES);
  assert.equal(ozon.groupKey, wb.groupKey);
});

test("media is checked against each platform's own rules from the same image set", async () => {
  const square = withMedia(vestCore(), vestMedia({ width: 800, height: 800 }));
  const ozon = checkMediaForPlatform(square, await loadPlatformProfile("ozon"));
  const wb = checkMediaForPlatform(square, await loadPlatformProfile("wb"));
  assert.equal(ozon.ready, true);
  assert.equal(wb.ready, false);
  assert.ok(wb.issues.some(issue => issue.code === "MEDIA_ASPECT_MISMATCH"));
  assert.ok(wb.issues.some(issue => issue.code === "MEDIA_TOO_SMALL"));
  const portrait = withMedia(vestCore(), vestMedia());
  assert.equal(checkMediaForPlatform(portrait, await loadPlatformProfile("wb")).ready, true);
  const missing = checkMediaForPlatform(vestCore(), await loadPlatformProfile("wb"));
  assert.equal(missing.issues.filter(issue => issue.code === "MEDIA_MISSING").length, 4);
});

test("Ozon and WB attribute mappings both trace back to the same neutral fields", () => {
  const core = withRussian(vestCore(), [{ target: "fact", key: "material", ru: "полиэстер" }, { target: "color", key: "黑色", ru: "черный" }]);
  const variantId = core.variantGroup.variants.find(item => item.color.source === "黑色").variantId;
  const ozon = resolveAttributeMappings(core, [
    { platformAttributeId: 10096, from: "color", use: "value", valueMap: { 黑色: 61574 } },
    { platformAttributeId: 10097, from: "color", use: "ru" },
    { platformAttributeId: 4975, from: "fact:material", use: "ru" }
  ], { variantId });
  const wb = resolveAttributeMappings(core, [
    { platformAttributeId: "wb-charc-color", from: "color", use: "ru" },
    { platformAttributeId: "wb-charc-material", from: "fact:material", use: "ru" }
  ], { variantId });
  assert.deepEqual(ozon.gaps, []);
  assert.deepEqual(ozon.values.map(item => item.value), [61574, "черный", "полиэстер"]);
  assert.deepEqual(wb.values.map(item => item.value), ["черный", "полиэстер"]);
  assert.deepEqual(wb.values.map(item => item.sourcePath), [ozon.values[1].sourcePath, ozon.values[2].sourcePath]);

  const khaki = core.variantGroup.variants.find(item => item.color.source === "卡其").variantId;
  const gaps = resolveAttributeMappings(core, [
    { platformAttributeId: 10097, from: "color", use: "ru" },
    { platformAttributeId: 9048, from: "fact:closureType" }
  ], { variantId: khaki }).gaps;
  assert.deepEqual(gaps.map(item => item.reason), ["还没有俄文", "中立核心里还没有这项"]);
});

test("content length is judged per platform, not baked into the copy", async () => {
  const content = { title: "Жилет для собак и кошек флисовый теплый на липучке, размер S-M", description: "Описание" };
  assert.equal(checkContentForPlatform(content, await loadPlatformProfile("ozon")).ready, true);
  const wb = checkContentForPlatform(content, await loadPlatformProfile("wb"));
  assert.deepEqual(wb.issues.map(issue => issue.code), ["CONTENT_TITLE_TOO_LONG"]);
});

test("listing drafts for both platforms come from one core and list what is still missing", async () => {
  const core = withMedia(withRussian(vestCore(), COLORS.map(color => ({ target: "color", key: color, ru: `ru-${color}` }))), vestMedia());
  const mappings = [{ platformAttributeId: "color", from: "color", use: "ru" }];
  const content = { title: "Жилет для собак", description: "Описание" };
  const ozon = buildPlatformListingDraft({ core, profile: await loadPlatformProfile("ozon"), storeRef: { stableStoreId: "miska" },
    category: { descriptionCategoryId: 1, typeId: 2 }, attributeMappings: mappings, content, price: { currency: "CNY", amount: 59 } });
  const wb = buildPlatformListingDraft({ core, profile: await loadPlatformProfile("wb"), storeRef: { stableStoreId: "wb" },
    attributeMappings: mappings, content, price: { currency: "CNY", amount: 59 } });
  assert.equal(ozon.ready, true, JSON.stringify(ozon.gaps));
  assert.equal(ozon.profileVerified, false);
  assert.equal(ozon.attributes.perVariant.length, 8);
  assert.equal(wb.ready, false);
  assert.deepEqual(wb.gaps.map(gap => gap.area), ["category", "price"]);
  assert.deepEqual(ozon.core, wb.core);
});

test("an existing candidate record can be read into the core without changing it", () => {
  const candidate = { id: "CX-20261009-001", dataRevision: 4, sourceCapture: { ...vestCapture(), selectedSkuIds: ["1000"] },
    supplierDraftV1: { packedWeightKg: 0.12, dimensionsCm: { length: 20, width: 15, height: 3 } } };
  const before = JSON.stringify(candidate);
  const core = productCoreFromCandidate(candidate, { builtAt });
  assert.equal(core.productId, "product:1688:887766");
  assert.equal(core.variantGroup.variants.filter(item => item.enabled).length, 1);
  assert.equal(core.facts.batteryType.status, "unknown");
  assert.equal(JSON.stringify(candidate), before);
});

test("validation rejects a core that smuggles in an unregistered fact", () => {
  const core = structuredClone(vestCore());
  core.facts.ozonTypeId = { value: 1, status: "confirmed", sourceRef: "x", ru: null, ruSourceRef: null };
  assert.equal(validateProductCore(core).valid, false);
});
