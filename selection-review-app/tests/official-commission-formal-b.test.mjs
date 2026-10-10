import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

import { readOzonCommissionReference } from "../lib/ozon-commission-reference-reader.mjs";
import { runLifecycleBEvidencePreparation } from "../lib/lifecycle-b-evidence-preparation.mjs";
import { createLifecycleBRealEvidenceProviderRegistry } from "../lib/lifecycle-b-real-evidence-readers.mjs";
import { runRealAConfirmationToBAndC1 } from "../lib/real-a-b-c1-flow.mjs";
import { createC1ProductPlan } from "../lib/c1-product-plan.mjs";
import { assertFormalCommissionBeforeProduction } from "../lib/commission-estimate-authorization.mjs";
import { buildRealAConfirmationCard } from "../lib/real-a-confirmation-card.mjs";
import { SALES_SNAPSHOT_SCHEMA_VERSION, SEERFAR_CATEGORY_DETAIL_SOURCE, SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE,
  SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION, validateSalesSnapshot } from "../lib/sales-snapshot.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { addEvidenceContext, candidate, confirmedAt, currentOtherCosts, evidencePacks, submission }
  from "./fixtures/real-a-b-flow-fixture.mjs";

/**
 * 主人那份官方费表（Ozon 官方 CDN 的 Tarifs_CN_01_12_2025，2025-12-01 起生效）里
 * 「宠物服装」那一行的逐字抄录：第1656行，Full ChinaHK 工作表。
 * 2026-09-14 现场核对过整份目录的 sha256 与这一行的六个费率列。
 */
const REAL_CATALOG_SHA256 = "be7832ff9dbd09ee7021aaefe9018a02287332bc22e4c6b470d6cfe0b3649cf0";
const REAL_CATALOG_EFFECTIVE_FROM = "2025-12-01";
const PET_CLOTHING_ROW = Object.freeze({
  row: 1656, typeRu: "Одежда для животных", typeZh: "宠物服装", typeEn: "Pet Clothing",
  category3Ru: "Одежда и обувь для животных", category3Zh: "宠物服装和靴子", category3En: "Pet Clothing & Boots",
  mpCategoryRu: "Товары для животных", mpCategoryZh: "宠物用品", mpCategoryEn: "Pet Products", brand: "All",
  rfbs_le1500: 0.12, rfbs_1500_5000: 0.14, rfbs_gt5000: 0.15,
  fbp_le1500: 0.11, fbp_1500_5000: 0.13, fbp_gt5000: 0.14
});
/** 页面面包屑末段「Одежда」在整份真目录里一行都没有，这里放一行同名同姓的诱饵也命不中：它不是类型列。 */
const DECOY_ROW = Object.freeze({
  row: 9001, typeRu: "Одежда для кукол", typeZh: "娃娃服装", typeEn: "Doll Clothing",
  category3Ru: "Куклы", category3Zh: "玩偶", category3En: "Dolls",
  mpCategoryRu: "Детские товары", mpCategoryZh: "儿童用品", mpCategoryEn: "Kids", brand: "All",
  rfbs_le1500: 0.2, rfbs_1500_5000: 0.21, rfbs_gt5000: 0.22,
  fbp_le1500: 0.19, fbp_1500_5000: 0.2, fbp_gt5000: 0.21
});

const VERSION_STATE = Object.freeze({ fileSha256: REAL_CATALOG_SHA256, effectiveFrom: REAL_CATALOG_EFFECTIVE_FROM, status: "active" });
const AS_OF = "2026-09-14T09:47:06.102Z";

function localCatalog() {
  return {
    schemaVersion: "ozon-official-commission-reference-v1", platform: "ozon", sellerRegion: "CN",
    effectiveFrom: REAL_CATALOG_EFFECTIVE_FROM,
    sourceUrl: "https://cdn.ozone.ru/s3/utils-common/Tarifs_CN_01_12_2025_1761720496.xlsx",
    sourcePage: "https://global-help.ozon.com/zh/commissions/ozon-fees/commissions/?region=CHN",
    fileSha256: REAL_CATALOG_SHA256, fileLastModified: "2026-08-12T09:53:49Z", downloadedAt: "2026-09-10T05:48:00Z",
    priceTiersRub: { le1500: [0, 1500], "1500_5000": [1500.01, 5000], gt5000: [5000.01, null] },
    salesSchemes: ["rfbs", "fbp"],
    sheets: {
      "MP Tree Tarifs CN": { rows: [] },
      "Full ChinaHK": { rows: [structuredClone(PET_CLOTHING_ROW), structuredClone(DECOY_ROW)] }
    }
  };
}

async function withLocalCatalog(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "ozon-official-formal-b-"));
  const catalogPath = path.join(directory, "ozon-official-commission.json");
  await writeFile(catalogPath, JSON.stringify(localCatalog()), "utf8");
  try { return await run(catalogPath); } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * 主人保存的那份真官方目录：配置里指到哪读哪，否则找默认保存位置。
 * 找不到、或者内容哈希不是登记的那一份，就返回 null——宁可这条腿不跑，也不对着另一份表断言。
 */
async function ownerOfficialCatalogPath() {
  const configured = (() => {
    try { return JSON.parse(process.env.SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON ?? "null")?.catalogPath ?? null; }
    catch { return null; }
  })();
  const candidates = [configured, path.join(homedir(), "Documents", "wb & ozon 选品",
    "commission-reference-20260909", "ozon-official-20260910", "ozon-official-commission.json")].filter(Boolean);
  for (const value of candidates) {
    try {
      await access(value);
      const catalog = JSON.parse(await readFile(value, "utf8"));
      if (catalog?.fileSha256 === REAL_CATALOG_SHA256 && catalog?.effectiveFrom === REAL_CATALOG_EFFECTIVE_FROM) return value;
    } catch { /* 读不到就换下一个候选位置 */ }
  }
  return null;
}

const lookup = (catalogPath, typeIdentity, extra = {}, priceRub = 1455) => readOzonCommissionReference({
  catalogPath, versionState: VERSION_STATE, asOf: AS_OF,
  scope: { platform: "ozon", sellerRegion: "CN", salesScheme: "rfbs", priceRub, typeIdentity, ...extra }
});

test("官方费表按中文类目树索引：商品页面包屑末段命不中，类目树末段命中同一行", async () => {
  const assertions = async (catalogPath, label) => {
    const breadcrumb = await lookup(catalogPath, { typeRu: "Одежда" });
    assert.equal(breadcrumb.commissionRate, null, `${label}：面包屑末段不是类型名，不得命中`);
    assert.deepEqual(breadcrumb.gaps.map(gap => gap.code), ["TYPE_NOT_FOUND"], label);

    const chinese = await lookup(catalogPath, { typeZh: "宠物服装" }, { mpCategoryZh: "宠物用品" });
    assert.equal(chinese.commissionRate, 0.12, `${label}：中文类目树末段 + 平台大类必须命中 12%`);
    assert.equal(chinese.priceTier, "le1500", label);
    assert.deepEqual(chinese.gaps, [], label);
    assert.equal(chinese.matchedRows.length, 1, label);
    assert.equal(chinese.matchedRows[0].typeRu, "Одежда для животных", label);
    assert.equal(chinese.matchedRows[0].mpCategoryZh, "宠物用品", label);

    // 同一行的俄文类型名（B证据上下文里那条四级路径的末段）命中同一行同一费率。
    const russianType = await lookup(catalogPath, { typeRu: "Одежда для животных" });
    assert.equal(russianType.commissionRate, 0.12, label);
    assert.equal(russianType.matchedRows[0].typeZh, "宠物服装", label);

    // 价格档来自表自己的分档，不写死在调用方：1500.01 起跳到下一档。
    assert.equal((await lookup(catalogPath, { typeZh: "宠物服装" }, {}, 1500)).commissionRate, 0.12, label);
    assert.equal((await lookup(catalogPath, { typeZh: "宠物服装" }, {}, 1500.01)).commissionRate, 0.14, label);
    assert.equal((await lookup(catalogPath, { typeZh: "宠物服装" }, {}, 5000.01)).commissionRate, 0.15, label);

    // 平台大类对不上时宁可判不出来，也不退回到只按类型名匹配。
    const wrongCategory = await lookup(catalogPath, { typeZh: "宠物服装" }, { mpCategoryZh: "儿童用品" });
    assert.equal(wrongCategory.commissionRate, null, label);
    assert.deepEqual(wrongCategory.gaps.map(gap => gap.code), ["TYPE_NOT_FOUND"], label);
  };

  await withLocalCatalog(value => assertions(value, "逐字抄录的费表行"));

  const ownerCatalog = await ownerOfficialCatalogPath();
  if (ownerCatalog === null) {
    console.log("跳过真官方目录这一腿：本机没有已登记的那份 ozon-official-commission.json。");
    return;
  }
  await assertions(ownerCatalog, "主人保存的真官方目录");
});

const SEERFAR_SNAPSHOT_ID = "sales-snapshot:seerfar_category_detail:receipt-001:3605840795";
const PAGE_SNAPSHOT_ID = "sales-snapshot:ozon:3605840795:OPR-001";

/** 服务商品类查询结果投影出来的销售快照：中文类目树路径就在这里。 */
function seerfarSnapshot(categoryPath = "宠物用品 > 宠物服装和靴子 > 宠物服装") {
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION, snapshotId: SEERFAR_SNAPSHOT_ID, platform: "ozon",
    source: SEERFAR_CATEGORY_DETAIL_SOURCE, marketScope: "ozon_general_market", sellerType: "unknown",
    sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "seerfar:record:1" },
    productUrl: "https://www.ozon.ru/product/3605840795/", title: "Дождевик для собак",
    imageRefs: [], currentPrice: 1457, currency: "RUB", priceCurrencySource: "ozon_platform_currency",
    categoryPath, attributes: {},
    marketMetrics: { salesCount: 12, salesWindow: null, revenue: null, reviewCount: 3, reviewRating: 4.8 },
    evidenceRefs: ["seerfar:record:1", "receipt-001"], collectedAt: "2026-09-11T02:54:12.318Z",
    evidenceRef: "seerfar:record:1", collectorVersion: SEERFAR_CATEGORY_DETAIL_COLLECTOR_VERSION,
    collectorMode: SEERFAR_CATEGORY_DETAIL_COLLECTOR_MODE, readOnly: true
  };
  assert.equal(validateSalesSnapshot(snapshot).valid, true);
  return snapshot;
}

/** 真读商品页得到的销售快照：categoryPath 是页面面包屑，比上面那一份新。 */
function pageSnapshot(categoryPath = "Товары для животных > Для собак > Одежда") {
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION, snapshotId: PAGE_SNAPSHOT_ID, platform: "ozon",
    marketScope: "ozon_general_market", sellerType: "unknown",
    sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "ozon-page:3605840795" },
    productUrl: "https://www.ozon.ru/product/3605840795/", title: "Дождевик для собак",
    imageRefs: [], currentPrice: 1445, currency: "RUB", categoryPath, attributes: {},
    collectedAt: "2026-09-14T05:09:52.551Z", evidenceRef: "ozon-loaded-page-widgets:OPR-001:3605840795",
    collectorVersion: "real-ozon-sales-snapshot-v1", collectorMode: "real_page_read_only", readOnly: true
  };
  assert.equal(validateSalesSnapshot(snapshot).valid, true);
  return snapshot;
}

function candidateWithSnapshots(snapshots) {
  return {
    id: "candidate:official-reference-scope", dataRevision: 7, targetStore: "dandanshu",
    storeRef: structuredClone(SYNTHETIC_STORE_REF), salesSnapshotsV11: snapshots,
    lifecycleEvidenceContextV11: {
      platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
      category: "ozon:17028966:96063", salesScheme: "rfbs", route: "guoo economy extra small",
      logisticsRuleVersion: "guoo-2026-08-19", exchangePair: "RUB/CNY", schemaRuleVersion: "ozon-current"
    }
  };
}

/** 跑一次B证据准备，只为看清 commission 请求里那份每SKU查询输入；提供器一律立即停住，不产生任何证据。 */
async function capturedCommissionReferenceScope({ candidate: source, submission: input }) {
  const captured = [];
  const stop = async (request) => { captured.push(request); throw new Error("STOP_AFTER_REQUEST"); };
  await runLifecycleBEvidencePreparation({
    candidate: source, evidencePacks: [], plannedAt: AS_OF, submission: input,
    providers: { commission: stop, logistics_tariff: stop, exchange_rate: stop, schema: stop }
  });
  return captured.find(request => request.kind === "commission")?.commissionReferenceScope ?? null;
}

test("每SKU费表查询输入：类型名只来自中文类目树快照，价格来自本轮正在冻结的成交价", async () => {
  // 页面面包屑那一份更新，但它不是类型树：类型名仍然取中文类目树那一份，并带上平台大类。
  const both = await capturedCommissionReferenceScope({
    candidate: candidateWithSnapshots([seerfarSnapshot(), pageSnapshot()]),
    submission: { targetSalePriceRub: 1455 }
  });
  assert.deepEqual(both, { priceRub: 1455, typeName: "宠物服装", mpCategoryZh: "宠物用品" });

  // 只有页面面包屑时不假装拿到了类型名：留空，交给 reader 记缺口。
  const pageOnly = await capturedCommissionReferenceScope({
    candidate: candidateWithSnapshots([pageSnapshot()]),
    submission: { targetSalePriceRub: 1455 }
  });
  assert.deepEqual(pageOnly, { priceRub: 1455, typeName: null, mpCategoryZh: null });

  // 段数不是三段的中文路径也不算：费表的中文类目树正好三级。
  const wrongShape = await capturedCommissionReferenceScope({
    candidate: candidateWithSnapshots([seerfarSnapshot("宠物用品 > 宠物服装")]),
    submission: { targetSalePriceRub: 1455 }
  });
  assert.equal(wrongShape.typeName, null);

  // 没有本轮提交、A阶段也还没冻结建议成交价时，价格留空；绝不从销售快照的市场价现推一个数。
  const noPrice = await capturedCommissionReferenceScope({
    candidate: candidateWithSnapshots([seerfarSnapshot(), pageSnapshot()]), submission: null
  });
  assert.deepEqual(noPrice, { priceRub: null, typeName: "宠物服装", mpCategoryZh: "宠物用品" });

  // A阶段已经冻结建议成交价、而本轮没有提交（独立的证据准备路由）时，用已冻结的那个价。
  const frozen = candidateWithSnapshots([seerfarSnapshot(), pageSnapshot()]);
  frozen.lifecycleV11 = { opportunityPackage: { marketAssessment: {
    recommendedSalePrice: { amount: 1445, currency: "RUB" } } } };
  assert.equal((await capturedCommissionReferenceScope({ candidate: frozen, submission: null })).priceRub, 1445);
});

const OFFICIAL_SCOPE = Object.freeze({ platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF,
  category: "ozon:17028966:96063", salesScheme: "rfbs" });

function evidenceServiceStub() {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const payload = body.kind === "commission"
      ? { ok: true, evidence: { status: "data_unavailable", current: false, reasonCode: "exact_commission_unavailable",
          scope: structuredClone(OFFICIAL_SCOPE), sourceType: "ozon_seller_api_current_products",
          sourceRef: "ozon-seller-api:/v3/product/info/list:no-listed-product", checkedAt: AS_OF, evidenceData: {} } }
      : { ok: true, evidence: { current: true, scope: { platform: "ozon", store: "dandanshu",
          storeRef: structuredClone(SYNTHETIC_STORE_REF), category: OFFICIAL_SCOPE.category, ruleVersion: "ozon-current" },
          sourceType: "ozon_seller_api_current_schema", sourceRef: "ozon-seller-api:/v1/description-category/attribute:17028966:96063",
          checkedAt: AS_OF, expiresAt: "2026-09-15T09:47:06.102Z",
          evidenceData: { schemaRevision: "ozon-schema-test", requiredFields: [], descriptionCategoryId: 17028966, typeId: 96063 } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}

test("费表查询输入缺哪一样，就记哪一个缺口，并且一次本地费表都不读", async () => {
  for (const [inputs, expected] of [
    [{ priceRub: null, typeName: "宠物服装", mpCategoryZh: "宠物用品" }, /OFFICIAL_TABLE_PRICE_MISSING/],
    [{ priceRub: 1455, typeName: null, mpCategoryZh: null }, /OFFICIAL_TABLE_TYPE_IDENTITY_MISSING/]
  ]) {
    let reads = 0;
    const registry = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: "http://127.0.0.1:4173", now: () => new Date(AS_OF),
      ozonCommissionReference: { catalogPath: "/owner/ozon-official-commission.json", sellerRegion: "CN",
        versionState: structuredClone(VERSION_STATE) },
      readOzonCommissionReferenceImpl: async () => { reads += 1; throw new Error("SHOULD_NOT_READ"); },
      fetchImpl: evidenceServiceStub()
    });
    await assert.rejects(registry.commission({ ...requestShape(), commissionReferenceScope: inputs }), expected);
    assert.equal(reads, 0, "每SKU输入不全时不读本地费表");
  }
});

test("命中时把平台大类一起传给本地费表，作为重名类型的消歧键", async () => {
  const observed = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173", now: () => new Date(AS_OF),
    ozonCommissionReference: { catalogPath: "/owner/ozon-official-commission.json", sellerRegion: "CN",
      versionState: structuredClone(VERSION_STATE) },
    readOzonCommissionReferenceImpl: async (input) => {
      observed.push(structuredClone(input));
      return withLocalCatalog(async catalogPath => {
        const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
        // This producer declares its internal refresh hint only for the reviewed official attachment source.
        catalog.sourceUrl = "https://cdn.ozone.ru/s3/ozon-disk-api/global-education/ru/commissions/ozon-fees/comissions/Tarifs_CN_01_12_2025_1761720496.xlsx";
        await writeFile(catalogPath, JSON.stringify(catalog), "utf8");
        return readOzonCommissionReference({ ...input, catalogPath, asOf: AS_OF });
      });
    },
    fetchImpl: evidenceServiceStub()
  });
  const pack = await registry.commission({ ...requestShape(),
    commissionReferenceScope: { priceRub: 1455, typeName: "宠物服装", mpCategoryZh: "宠物用品" } });
  assert.deepEqual(observed[0].scope, { platform: "ozon", sellerRegion: "CN", salesScheme: "rfbs",
    priceRub: 1455, typeIdentity: { typeZh: "宠物服装" }, mpCategoryZh: "宠物用品" });
  assert.equal(pack.evidenceData.commissionEvidenceMode, "official_reference");
  assert.equal(pack.evidenceData.commissionRate, 0.12);
  assert.equal(pack.commissionCatalogRef.priceTier, "le1500");
  assert.deepEqual(pack.evidenceData.officialCommissionBinding,
    { schemaVersion: "ozon-official-commission-binding-v1", candidateId: "TEST-OFFICIAL", candidateRevision: 3, priceRub: 1455 });
});

function requestShape() {
  const { salesScheme, ...shared } = structuredClone(OFFICIAL_SCOPE);
  return { providerVersion: "lifecycle-b-evidence-provider-v1.1", kind: "commission",
    scope: structuredClone(OFFICIAL_SCOPE), relatedSchemaScope: { ...shared, ruleVersion: "ozon-current" },
    candidateId: "TEST-OFFICIAL", candidateRevision: 3, requestedAt: AS_OF,
    readOnly: true, platformWritesAllowed: false, maximumAttempts: 1 };
}

function officialCommissionPack(source, packs) {
  const pack = structuredClone(packs[0]);
  pack.id = "commission:official:pet-clothing";
  pack.sourceType = "ozon_official_commission_table";
  pack.sourceRef = `ozon-official-commission:${REAL_CATALOG_EFFECTIVE_FROM}:sha256:${REAL_CATALOG_SHA256}:le1500`;
  pack.commissionCatalogRef = { effectiveFrom: REAL_CATALOG_EFFECTIVE_FROM, fileSha256: REAL_CATALOG_SHA256,
    sourceUrl: "https://cdn.ozone.ru/s3/utils-common/Tarifs_CN_01_12_2025_1761720496.xlsx", priceTier: "le1500",
    matchedRow: { typeRu: PET_CLOTHING_ROW.typeRu, typeZh: PET_CLOTHING_ROW.typeZh, mpCategoryZh: PET_CLOTHING_ROW.mpCategoryZh } };
  pack.evidenceData = { ...structuredClone(pack.evidenceData), commissionRate: 0.12,
    commissionEvidenceMode: "official_reference", estimateAuthorized: false, exactCommissionRequiredAtC: true,
    officialCommissionBinding: { schemaVersion: "ozon-official-commission-binding-v1",
      candidateId: source.id, candidateRevision: source.dataRevision, priceRub: 1455 } };
  return [pack, ...packs.slice(1)];
}

function estimatedCommissionPack(source, packs) {
  const pack = structuredClone(packs[0]);
  pack.evidenceData = { ...structuredClone(pack.evidenceData), commissionEvidenceMode: "estimated",
    estimateAuthorized: true, commissionEstimateAuthorization: { schemaVersion: "commission-estimate-authorization-v1",
      candidateId: source.id, candidateRevision: source.dataRevision, authorizationRef: "fixture:official-vs-estimate",
      commissionRate: pack.evidenceData.commissionRate } };
  return [pack, ...packs.slice(1)];
}

test("官方费表命中形成正式B并放行文案素材；估算佣金照旧被文案素材和上架两道闸门拦住", async () => {
  const official = addEvidenceContext(await candidate());
  const officialRun = runRealAConfirmationToBAndC1({
    candidate: official, otherCosts: currentOtherCosts(official),
    submission: submission(buildRealAConfirmationCard(official)),
    evidencePacks: officialCommissionPack(official, evidencePacks()), confirmedAt
  });
  assert.equal(officialRun.profitModel.commissionMode, "official_reference");
  assert.equal(officialRun.profitModel.calculationType, "formal");
  assert.equal(officialRun.profitModel.exactCommissionRequiredForFormalB, false);
  assert.equal(officialRun.profitModel.result, "passed");
  assert.equal(officialRun.skuPackage.businessPhase, "C1");
  assert.equal(officialRun.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(officialRun.c1Handoff.trigger, "b_passed_auto_c1");

  // 正式佣金类型可进入后续完整冻结输入核验；这本身不创建生产授权。
  assert.equal(assertFormalCommissionBeforeProduction(officialRun.skuPackage).commissionMode, "official_reference");

  const estimated = addEvidenceContext(await candidate());
  const estimatedRun = runRealAConfirmationToBAndC1({
    candidate: estimated, otherCosts: currentOtherCosts(estimated),
    submission: submission(buildRealAConfirmationCard(estimated)),
    evidencePacks: estimatedCommissionPack(estimated, evidencePacks()), confirmedAt
  });
  assert.equal(estimatedRun.profitModel.commissionMode, "estimated");
  assert.equal(estimatedRun.profitModel.calculationType, "conditional");
  assert.equal(estimatedRun.profitModel.result, "manual_review");
  assert.equal(estimatedRun.skuPackage.businessPhase, "B");
  assert.equal(estimatedRun.skuPackage.c1ProductPlan, null);
  assert.equal(estimatedRun.c1Handoff, null);
  assert.throws(() => assertFormalCommissionBeforeProduction(estimatedRun.skuPackage),
    /PRODUCTION_AUTHORIZATION_EXACT_COMMISSION_REQUIRED/);

  // 同一份B利润记录直接送进文案素材那道闸门：估算被拦，官方费表放行。
  const forcedIntoC1 = structuredClone(estimatedRun.skuPackage);
  forcedIntoC1.businessResult = "passed";
  assert.throws(() => createC1ProductPlan({
    opportunityPackage: estimatedRun.opportunityPackage, skuPackage: forcedIntoC1,
    platformSchemaEvidence: officialRun.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules,
    createdAt: confirmedAt
  }), /C1_GATE_REJECTED/);
});
