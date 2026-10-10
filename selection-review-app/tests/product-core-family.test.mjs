import test from "node:test";
import assert from "node:assert/strict";
import { assembleProductCoreForFamily, buildFamilyListingDrafts } from "../lib/product-core-family.mjs";
import { loadPlatformProfile } from "../lib/platform-projection.mjs";
import { mediaForColor } from "../lib/product-core.mjs";

const builtAt = "2026-10-10T01:30:00.000Z";
const sha = n => n.toString(16).padStart(64, "0");
const upload = (n, order) => ({ assetId: `final-${n}-${order}`, mediaType: "image", sha256: sha(n), assetRef: `https://oss.example/${n}.jpg`, order, width: 900, height: 1200 });
const SUPPLIER_ATTRIBUTES = [{ fieldKey: "颜色" }, { fieldKey: "材质" }];
const mapping = (attributeId, value, index) => ({ attributeId, value, sourceFactPath: `productAttributes.supplierAttributes.${index}.fact` });

function skuPackage({ supplierSkuId, mappings, uploads, extra = {} }) {
  return { supplierSkuId, businessPhase: "D", ozonAttributeMappingsV1: { mappings },
    c1ProductPlan: { productAttributes: { supplierAttributes: SUPPLIER_ATTRIBUTES }, ...extra.plan },
    c2FinalAssets: { assets: { finalUploads: uploads } }, ...extra.sku };
}

function vestDocument({ blackUploads = [upload(2, 1), upload(9, 2)], blackMaterial = "полиэстер" } = {}) {
  let id = 1000;
  const colors = ["卡其", "黑CP", "CP", "黑色"];
  const parent = {
    id: "CX-20261001-001", dataRevision: 12, targetStore: "miska", targetPlatform: "ozon",
    storeRef: { stableStoreId: "miska", platformStoreId: "1", mappingVersion: "stores-v1" },
    sourceCapture: { captureId: "capture-vest-1", offerId: "887766", sourceUrl: "https://detail.1688.com/offer/887766.html",
      supplierAttributes: { 材质: "涤纶" },
      skuChoices: colors.map(color => ({ sourceSkuId: String(id++), attributes: { 颜色: color }, priceCny: 9.5 })) },
    supplierDraftV1: { packedWeightKg: 0.12, dimensionsCm: { length: 20, width: 15, height: 3 } },
    lifecycleV11: { skuPackage: skuPackage({ supplierSkuId: "1000",
      mappings: [mapping("10097", "светлый хаки", 0), mapping("10096", "хаки", 0), mapping("4975", "полиэстер", 1)],
      uploads: [upload(1, 1), upload(9, 2)],
      extra: { plan: { seoTitleDraft: { text: "Жилет для собак и кошек флисовый теплый на липучке, хаки, размер S" },
        descriptionDraft: { text: "Описание" }, platformCategory: { descriptionCategoryId: 17028, typeId: 92851 } },
      sku: { productionAuthorization: { platformWritePrice: { amount: 59, currency: "CNY" } } } } }) }
  };
  const black = { id: "CX-20261001-002", dataRevision: 5, targetStore: "miska", targetPlatform: "ozon",
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: "1001" },
    lifecycleV11: { skuPackage: skuPackage({ supplierSkuId: "1001", mappings: [mapping("10097", "черный CP", 0), mapping("4975", blackMaterial, 1)], uploads: blackUploads }) } };
  const unrelated = { id: "CX-20261001-099", sourceCapture: { offerId: "1" } };
  return { candidates: [black, parent, unrelated] };
}

test("a colour candidate opens the whole product: one core, one variant group, every colour's own Russian name", () => {
  const document = vestDocument();
  const before = JSON.stringify(document);
  const { core, members, notes } = assembleProductCoreForFamily({ document, candidateId: "CX-20261001-002", builtAt });
  assert.equal(core.productId, "product:1688:887766");
  assert.deepEqual(members.map(item => [item.candidateId, item.color]), [["CX-20261001-001", "卡其"], ["CX-20261001-002", "黑CP"]]);
  assert.deepEqual(core.variantGroup.variants.filter(item => item.enabled).map(item => item.supplierSkuId), ["1000", "1001"]);
  const ru = Object.fromEntries(core.variantGroup.variants.map(item => [item.color.source, item.color.ru]));
  assert.deepEqual(ru, { 卡其: "светлый хаки", 黑CP: "черный CP", CP: null, 黑色: null });
  assert.equal(core.facts.material.ru, "полиэстер");
  assert.equal(core.supplierAttributes.材质.ru, "полиэстер");
  assert.match(core.facts.material.ruSourceRef, /^CX-20261001-001#\/lifecycleV11\/skuPackage\/ozonAttributeMappingsV1\/mappings\/2$/);
  assert.equal(notes.filter(item => item.area === "translation").length, 0);
  assert.equal(JSON.stringify(document), before, "只读");
});

test("final images unique to one colour belong to it; images every colour uses become the shared set with a note", () => {
  const { core, notes } = assembleProductCoreForFamily({ document: vestDocument(), candidateId: "CX-20261001-001", builtAt });
  assert.deepEqual(mediaForColor(core, "卡其").map(item => item.sha256), [sha(1), sha(9)]);
  assert.deepEqual(mediaForColor(core, "黑CP").map(item => item.sha256), [sha(2), sha(9)]);
  assert.equal(core.media.assets.find(item => item.sha256 === sha(9)).colorBinding, null);
  assert.ok(notes.some(item => item.area === "media" && /1 张图在多个颜色里都用了/.test(item.message)));
});

test("a colour whose first image is another colour's is kept out of the media set instead of guessed", () => {
  const { core, notes } = assembleProductCoreForFamily({ document: vestDocument({ blackUploads: [upload(1, 1), upload(2, 2)] }), candidateId: "CX-20261001-001", builtAt });
  assert.equal(core.media.assets.length, 0);
  assert.ok(notes.some(item => item.area === "media" && /「卡其」的首图也出现在别的颜色图集里/.test(item.message)));
});

test("different translations of the same attribute across colours keep the first and say so", () => {
  const { core, notes } = assembleProductCoreForFamily({ document: vestDocument({ blackMaterial: "полиэфир" }), candidateId: "CX-20261001-001", builtAt });
  assert.equal(core.facts.material.ru, "полиэстер");
  assert.ok(notes.some(item => /译法不同/.test(item.message)));
});

test("Ozon reuses what the product already has; WB shows exactly what is still missing", async () => {
  const document = vestDocument();
  const assembled = assembleProductCoreForFamily({ document, candidateId: "CX-20261001-001", builtAt });
  const { ozon, wb } = buildFamilyListingDrafts({ assembled, document,
    profiles: { ozon: await loadPlatformProfile("ozon"), wb: await loadPlatformProfile("wb") } });
  assert.equal(ozon.ready, true, JSON.stringify(ozon.gaps));
  assert.deepEqual(ozon.category, { descriptionCategoryId: 17028, typeId: 92851 });
  assert.equal(ozon.variants.offers.length, 2);
  assert.equal(wb.ready, false);
  assert.deepEqual(wb.variants.cards.map(card => card.colorKey), ["卡其", "黑CP"]);
  assert.deepEqual([...new Set(wb.gaps.map(gap => gap.area))], ["category", "content", "price"]);
  assert.ok(wb.gaps.some(gap => gap.code === "CONTENT_TITLE_TOO_LONG"));
});

test("a candidate without a supplier capture is reported, not crashed on", () => {
  assert.throws(() => assembleProductCoreForFamily({ document: vestDocument(), candidateId: "CX-20261001-099", builtAt }), /PRODUCT_CORE/);
  assert.throws(() => assembleProductCoreForFamily({ document: vestDocument(), candidateId: "nope", builtAt }), /PRODUCT_CORE_FAMILY_CANDIDATE_MISSING/);
});
