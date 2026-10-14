import test from "node:test";
import assert from "node:assert/strict";
import { derivePlatformWriteBindings } from "../lib/platform-write-bindings.mjs";
import { createProductionPlan, projectProductionPlanInputs } from "../lib/production-plan.mjs";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { authorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";

function attributes() {
  return [
    ...["4180", "4191", "23171"].map(fieldKey => ({ fieldKey, label: `synthetic:${fieldKey}`, required: false, complexId: 0, dictionaryId: 0 })),
    { fieldKey: "85", label: "synthetic:brand", required: true, complexId: 100001, dictionaryId: 28732849 }
  ];
}
function schema() {
  return { schemaRevision: "schema:synthetic:1", evidenceId: "schema-evidence:synthetic:1", attributes: attributes() };
}
function derivedFixture(change = () => {}) {
  const sku = structuredClone(createFormalC1C2Fixture().merged.skuPackage);
  const c1 = sku.c1ProductPlan, raw = c1.inputSnapshots.platformSchemaRules;
  delete raw.writeBindings;
  raw.attributes = attributes();
  c1.schemaSnapshot.writeBindings.value = derivePlatformWriteBindings(raw);
  change(c1, raw);
  return authorizedProductionFixture({ sourceSkuPackage: sku });
}

test("同一冻结Schema的共享producer保留精确ID、complexId、字典ID及来源，不改输入", () => {
  const raw = schema(), before = structuredClone(raw);
  const binding = derivePlatformWriteBindings(raw);
  assert.deepEqual(binding.content.description, { fieldKey: "description", attributeId: 4191, complexId: 0, dictionaryId: 0 });
  assert.deepEqual(binding.requiredAttributes, [{ fieldKey: "85", attributeId: 85, complexId: 100001, dictionaryId: 28732849 }]);
  assert.equal(binding.schemaRevision, raw.schemaRevision);
  assert.equal(binding.evidenceRef, raw.evidenceId);
  assert.deepEqual(raw, before);
});

test("已声明显式绑定优先；不会按类目表重写显式绑定", () => {
  const raw = schema();
  raw.writeBindings = { ...derivePlatformWriteBindings(raw), evidenceRef: "explicit:synthetic:binding" };
  raw.attributes = [];
  assert.deepEqual(derivePlatformWriteBindings(raw), raw.writeBindings);
  const plan = createProductionPlan(authorizedProductionFixture());
  assert.deepEqual(projectProductionPlanInputs(plan).schemaWriteBindings,
    plan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.platformSchemaRules.writeBindings);
});

test("派生必须有完整文字属性、非空来源版本及明确数字元数据；不能把null当0", () => {
  for (const change of [
    raw => { raw.attributes = raw.attributes.filter(item => item.fieldKey !== "4191"); },
    raw => { raw.attributes[0].dictionaryId = 7; },
    raw => { raw.attributes[0].complexId = null; },
    raw => { raw.attributes[0].dictionaryId = null; },
    raw => { delete raw.attributes[0].complexId; },
    raw => { raw.attributes[3].required = false; },
    raw => { raw.schemaRevision = ""; },
    raw => { raw.evidenceId = ""; }
  ]) {
    const raw = schema(); change(raw);
    assert.equal(derivePlatformWriteBindings(raw), null);
  }
});

test("D接受C1已确认的派生绑定，不要求原始Schema重复保存writeBindings，也不读取活动C1", () => {
  const fixture = derivedFixture();
  const frozen = fixture.productionAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot;
  assert.equal(Object.hasOwn(frozen.inputSnapshots.platformSchemaRules, "writeBindings"), false);
  const sku = structuredClone(fixture.skuPackage); sku.c1ProductPlan = null;
  const plan = createProductionPlan({ ...fixture, skuPackage: sku });
  assert.deepEqual(projectProductionPlanInputs(plan).schemaWriteBindings, derivePlatformWriteBindings(frozen.inputSnapshots.platformSchemaRules));
  assert.equal(plan.platformWrites, 0);
});

test("D对冻结派生内容缺失、字典改变、绑定篡改明确拒绝，不从当前资料补全", () => {
  for (const change of [
    (_c1, raw) => { raw.attributes = raw.attributes.filter(item => item.fieldKey !== "4191"); },
    (_c1, raw) => { raw.attributes[0].dictionaryId = 9; },
    (c1) => { c1.schemaSnapshot.writeBindings.value.content.title.attributeId = 99999; },
    (c1) => { c1.schemaSnapshot.writeBindings.value.schemaRevision = "schema:drift"; },
    (c1) => { c1.schemaSnapshot.writeBindings.value.evidenceRef = "schema-evidence:drift"; }
  ]) {
    const fixture = derivedFixture(change);
    assert.throws(() => createProductionPlan(fixture), /PRODUCTION_PLAN_INPUT_GAP: 写入绑定未与冻结Schema修订对齐/);
  }
});

test("D拒绝冻结显式绑定与确认绑定的差异", () => {
  const fixture = derivedFixture((c1, raw) => {
    raw.writeBindings = structuredClone(c1.schemaSnapshot.writeBindings.value);
    raw.writeBindings.content.description.complexId = 123;
  });
  assert.throws(() => createProductionPlan(fixture), /PRODUCTION_PLAN_INPUT_GAP: 写入绑定未与冻结Schema修订对齐/);
});
