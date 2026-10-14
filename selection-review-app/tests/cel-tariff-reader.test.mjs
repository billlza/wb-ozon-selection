import test from "node:test";
import assert from "node:assert/strict";
import { celTariffRuleVersionFromPath, readCelWbTariffCatalog } from "../lib/cel-tariff-reader.mjs";
import { CEL_WB_CELLS, CEL_WB_MERGES, celWbWorkbook } from "./helpers/cel-wb-workbook-fixture.mjs";

const FILE = "/owner/工作台/data/logistics/CEL产品资费表 V7.24.xlsx";
const read = (workbook, filePath = FILE) => readCelWbTariffCatalog({ filePath, readFileImpl: async () => workbook,
  now: () => new Date("2026-10-11T15:00:00.000Z") });

test("the WB sheet reads as three CEL rows in the same shape as the GUOO rows", async () => {
  const catalog = await read(celWbWorkbook());
  assert.equal(catalog.ruleVersion, "cel-v7.24");
  assert.match(catalog.sourceRef, /^cel-xlsx:CEL产品资费表 V7\.24\.xlsx:sha256:[0-9a-f]{64}$/);
  assert.deepEqual(catalog.rows.map(row => [row.route, row.network, row.requiresPrestock, row.transitDays,
    row.evidenceData.perKgRmb, row.evidenceData.perParcelRmb, row.evidenceData.weightLimit, row.evidenceData.weightMinExclusive]), [
    ["CEL Wb-Express", "珲春仓备货", true, 10, 48, 9, "0-20KG", false],
    ["CEL Wb-Economy", "前端仓库", false, 20, 58, 2, "0-0.3KG", false],
    ["CEL Wb-Economy", "前端仓库", false, 20, 43, 8, "0.3-20KG", true]
  ]);
  for (const row of catalog.rows) {
    assert.equal(row.evidenceData.sizeLimit, "三边之和不超200CM，单边最大尺寸不超115CM");
    assert.equal(row.evidenceData.chargeableWeightRule, "actual_weight");
    assert.equal(row.evidenceData.weightRoundingRule, "step", "表头写的是「百克进位」");
    assert.equal(row.evidenceData.weightRoundingKg, 0.1);
    assert.equal(row.evidenceData.declaredValueLimitRub, null);
  }
  assert.deepEqual(catalog.sourceNotes.map(note => note.cellRef), ["A6", "A7"]);
  assert.match(catalog.sourceNotes[1].text, /清关失败退货42元\/票/);
});

test("a layout the reader was not written for stops instead of guessing", async () => {
  const changed = cells => read(celWbWorkbook({ cells: { ...CEL_WB_CELLS, ...cells } }));
  await assert.rejects(changed({ G5: "43元/kg+8元/件" }), /CEL_TARIFF_LAYOUT_UNSUPPORTED: 费用/);
  await assert.rejects(changed({ E5: "0.3-20kg" }), /CEL_TARIFF_LAYOUT_UNSUPPORTED: 包裹限重/);
  await assert.rejects(changed({ I2: "计费重量（kg）" }), /百克进位/);
  await assert.rejects(changed({ A1: "Ozon 运费测算表" }), /wildberries/);
  await assert.rejects(changed({ A8: "陆运\n（Wb-Economy)", B8: "前端仓库", C8: 20, D8: "到达取货点", E8: "≤50kg", F8: CEL_WB_CELLS.F3, G8: "40元/kg+8元/票" }),
    /正好是 Express 一档、Economy 两档/);
  await assert.rejects(read(celWbWorkbook({ merges: CEL_WB_MERGES.filter(ref => ref !== "C4:C5") })), /第 5 行时效不是天数/);
  await assert.rejects(read(celWbWorkbook({ sheetName: "Wildberries" })), /CEL_TARIFF_SHEET_MISSING/);
  await assert.rejects(read(Buffer.from("not a workbook")), /CEL_TARIFF_ARCHIVE_INVALID/);
});

test("the rule version comes from the file name and a name without one is refused", async () => {
  assert.equal(celTariffRuleVersionFromPath("/x/CEL产品资费表V7.24.xlsx"), "cel-v7.24");
  assert.equal(celTariffRuleVersionFromPath("/x/CEL产品资费表 v8.1.3.xlsx"), "cel-v8.1.3");
  assert.throws(() => celTariffRuleVersionFromPath("/x/CEL产品资费表.xlsx"), /CEL_TARIFF_VERSION_MISSING/);
  await assert.rejects(read(celWbWorkbook(), "/x/CEL产品资费表.xlsx"), /CEL_TARIFF_VERSION_MISSING/);
});
