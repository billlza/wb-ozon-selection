import test from "node:test";
import assert from "node:assert/strict";
import { estimateDiscoveredProduct } from "../lib/a-discovery-estimate.mjs";
import { createADiscoveryEstimateInputs } from "../lib/a-discovery-estimate-store.mjs";
import { readCelWbTariffCatalog } from "../lib/cel-tariff-reader.mjs";
import { readWbCommissionReference } from "../lib/wb-commission-reference-reader.mjs";
import {
  buildWbRoughProfit, createWbRoughEstimateInputs, wbRoughFacts, wbRoughProfitForCandidate, wbRoughSubject, wbStoreRule
} from "../lib/wb-rough-estimate.mjs";
import { DEFAULT_RULES } from "../lib/workflow.mjs";
import { celWbWorkbook } from "./helpers/cel-wb-workbook-fixture.mjs";

const AT = "2026-10-11T15:00:00.000Z";
const FX = Object.freeze({ rubPerCny: 12.5457, rateDate: "2026-09-17", sourceRef: "fx-test" });
const workbook = celWbWorkbook();
const readers = { commission: input => readWbCommissionReference(input),
  tariff: input => readCelWbTariffCatalog({ ...input, readFileImpl: async () => workbook }) };
const inputs = createWbRoughEstimateInputs({ readers, configuration: { celTariffFile: "/owner/data/logistics/CEL产品资费表V7.24.xlsx" } });

/** The khaki vest as the owner declared it: ¥18 goods + ¥6.5 domestic, 0.2 kg, 20×30×5 cm, Ozon formal price 801 RUB. */
const vest = Object.freeze({
  id: "candidate:vest", dataRevision: 78, productName: "Мини-жилет для котенка, тактический, без пластины, регулируемый",
  sourceCapture: { title: "新款红酒微型JPC背心迷你战术装饰啤酒马甲户外军迷KTV酒吧装饰品" },
  supplierDraftV1: { allInPurchaseRmb: 24.5, packedWeightKg: 0.2, dimensionsCm: { length: 20, width: 30, height: 5 }, targetSalePriceRub: 848 },
  lifecycleV11: { skuPackage: { activeProfitModelVersion: "profit-v1", profitModels: [{ profitModelVersion: "profit-v1", recommendedSalePriceRub: 801 }] } }
});

async function vestEstimate(overrides = {}) {
  return wbRoughProfitForCandidate({ document: { rules: {} }, candidate: vest, at: AT, inputs, rules: DEFAULT_RULES,
    resolveExchangeRate: async () => FX, assumptions: { packagingRmbDefault: 0, extraHandlingDeclared: true }, ...overrides });
}

test("CEL bills the weight rounded up to 100 g and the Economy bands meet exactly at 0.3 kg", async () => {
  const { rows } = await inputs.resolveFreightRows();
  assert.deepEqual(rows.map(row => row.evidenceData.weightLimit), ["0-0.3KG", "0.3-20KG"], "陆空联运要先备货到珲春仓，不进直发粗算");
  const freight = grams => estimateDiscoveredProduct({ product: { price: 801, weightGrams: grams, dimensionMm: "200x300x50" },
    storeRule: DEFAULT_RULES.wbCrossListing, fx: FX, commission: { rate: 0.19 }, tariffRows: rows,
    assumptions: { packagingRmbDefault: 0 } }).freight.chosen;
  assert.deepEqual([200, 201, 300, 301, 1000].map(grams => [freight(grams).chargeableKg, freight(grams).freightRmb]),
    [[0.2, 13.6], [0.3, 19.4], [0.3, 19.4], [0.4, 25.2], [1, 51]]);
  assert.deepEqual(estimateDiscoveredProduct({ product: { price: 801, weightGrams: 300, dimensionMm: "200x300x50" },
    storeRule: DEFAULT_RULES.wbCrossListing, fx: FX, commission: { rate: 0.19 }, tariffRows: rows,
    assumptions: { packagingRmbDefault: 0 } }).freight.feasibleRoutes.length, 1, "0.3 kg 只落在 ≤0.3kg 那一档");
  const guooLike = [{ route: "GUOO Economy Extra Small", evidenceData: { perKgRmb: 30, perParcelRmb: 3, chargeableWeightRule: "actual_weight",
    weightRoundingRule: "none", weightRoundingKg: null, weightLimit: "0.001-0.5KG", sizeLimit: "三边之和不超90CM，单边最大尺寸不超60CM" } }];
  const guoo = estimateDiscoveredProduct({ product: { price: 801, weightGrams: 201, dimensionMm: "200x300x50" },
    storeRule: DEFAULT_RULES.ozonMiska, fx: FX, commission: { rate: 0.12 }, tariffRows: guooLike, assumptions: { packagingRmbDefault: 0 } });
  assert.equal(guoo.freight.chosen.chargeableKg, 0.201, "不进位的表照旧按实重");
});

test("the WB category is taken only from a checked mapping, our own product name first", () => {
  assert.equal(wbRoughSubject({ titles: [vest.productName, vest.sourceCapture.title] }).subjectId, 734);
  assert.equal(wbRoughSubject({ titles: ["小猫战术背心 可调节"] }).subjectId, 734);
  assert.equal(wbRoughSubject({ titles: [vest.sourceCapture.title] }), null, "货源标题是酒瓶装饰，不当成宠物背心");
  assert.equal(wbRoughSubject({ titles: ["宠物雨衣"] }), null, "没核对过的类目不拿背心的佣金顶");
  assert.deepEqual(wbRoughSubject({ titles: [], wbSubject: "1234" }), { subjectId: 1234, subjectName: null, basis: "requested" });
  assert.equal(wbRoughSubject({ wbSubject: "abc" }), null);
});

test("the vest on WB at its Ozon price: WB commission and CEL freight, not past the bar", async () => {
  const result = await vestEstimate();
  assert.equal(result.status, "ok");
  assert.equal(result.assumed, true);
  assert.equal(result.storeId, "wb");
  assert.deepEqual([result.salePriceRub, result.priceBasis, result.purchaseRmb, result.weightKg, result.dimensionsBasis],
    [801, "ozon_formal_price", 24.5, 0.2, "saved"]);
  assert.deepEqual([result.subjectId, result.subjectName, result.commissionRate], [734, "Жилеты для животных", 0.19]);
  assert.deepEqual([result.route, result.chargeableKg, result.freightRmb], ["CEL Wb-Economy", 0.2, 13.6]);
  // 63.84 × (1 − 19% − 5% − 5% − 2%) − 13.60 运费 − 1.50 贴单 − 24.50 进价
  assert.deepEqual([result.revenueCny, result.profitPerUnitRmb, result.marginRate, result.passes], [63.84, 4.44, 0.0695, false]);
  assert.deepEqual([result.breakEvenPriceRub, result.thresholdPriceRub, result.thresholdBasis], [721, 921, "margin"]);
  assert.equal(result.inputs.tariffRuleVersion, "cel-v7.24");
  assert.equal(result.inputs.commissionSourceRef, "wb-commission:2026-09-09T05:02:34.628109Z:subject-734");
  assert.ok(result.commissionGaps.some(gap => gap.code === "SALES_SCHEME_APPLICABILITY_UNKNOWN"), "佣金表的缺口跟着走，不当正式证据");
  const higher = await vestEstimate({ priceRub: "1000" });
  assert.deepEqual([higher.salePriceRub, higher.priceBasis, higher.profitPerUnitRmb, higher.passes], [1000, "requested", 15.39, true]);
});

test("whatever is missing is named, and nothing is filled in by guessing", async () => {
  const noFile = createWbRoughEstimateInputs({ readers: { ...readers, tariff: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } },
    configuration: { celTariffFile: "/owner/data/logistics/CEL产品资费表V7.24.xlsx" } });
  assert.deepEqual((await vestEstimate({ inputs: noFile })).missing, ["WB 物流表（工作台里还没有 CEL 资费表文件）"]);
  assert.deepEqual((await vestEstimate({ inputs: createWbRoughEstimateInputs({ readers }) })).missing, ["WB 物流表（没配置 CEL 资费表）"]);
  assert.deepEqual((await vestEstimate({ priceRub: "-5" })).missing, ["售价（请求里的价格无效）"]);
  assert.deepEqual((await vestEstimate({ resolveExchangeRate: async () => null })).missing, ["汇率"]);
  const bare = await vestEstimate({ candidate: { id: "candidate:bare", dataRevision: 1, sourceCapture: { title: "新款红酒微型JPC背心" } } });
  assert.equal(bare.status, "incomplete");
  assert.deepEqual(bare.missing, ["售价", "货源价", "重量", "WB 类目（标题认不出来，要指定类目号）"]);
  assert.equal(bare.dimensionsBasis, "category_default", "尺寸按类目常见大小假设，只用于粗算");
  const tooHeavy = buildWbRoughProfit({ facts: { ...wbRoughFacts(vest), weightKg: 25 }, subject: { subjectId: 734, basis: "requested" },
    storeRule: wbStoreRule({}, DEFAULT_RULES), fx: FX, commission: { rate: 0.19, gaps: [] }, freight: await inputs.resolveFreightRows(),
    assumptions: { packagingRmbDefault: 0 }, estimatedAt: AT });
  assert.deepEqual(tooHeavy.missing, ["可走的 WB 物流线路（重量或尺寸超出 CEL 限制）"]);
});

test("the owner's saved WB cost rule wins over the defaults", () => {
  const rule = wbStoreRule({ rules: { wbCrossListing: { returnOpsReserveRate: 0.08 } } }, DEFAULT_RULES);
  assert.equal(rule.returnOpsReserveRate, 0.08);
  assert.equal(rule.labelCostRmb, DEFAULT_RULES.wbCrossListing.labelCostRmb);
});

test("the Ozon estimate inputs refuse a WB store instead of lending it Ozon's commission and GUOO freight", () => {
  const ozonInputs = createADiscoveryEstimateInputs({ rules: DEFAULT_RULES, configuration: { packagingRmbDefault: 3 },
    readers: { commission: async () => null, fx: async () => null, tariff: async () => null } });
  assert.throws(() => ozonInputs.storeRule({ rules: {} }, "wb"), /A_DISCOVERY_ESTIMATE_PLATFORM_UNSUPPORTED/);
  assert.equal(ozonInputs.storeRule({ rules: {} }, "miska").storeName, DEFAULT_RULES.ozonMiska.storeName);
});
