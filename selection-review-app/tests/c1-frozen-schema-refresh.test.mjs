import test from "node:test";
import assert from "node:assert/strict";

import { phase7PassedState, platformSchemaEvidence } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createC1ProductPlan } from "../lib/c1-product-plan.mjs";
import { refreshC1FrozenPlatformSchema, C1FrozenSchemaRefreshError } from "../lib/c1-frozen-schema-refresh.mjs";

/*
 * 把计划里冻结的那份平台 Schema 换成刚读回来的同一个类目的新版本。
 *
 * 最危险的失败方式有两个：**换成别的类目**（那是另一件商品的资料），
 * 以及**只换一半引用**——C2 的规范门要求 inputRefs / frozenInputRefs / plan 三处逐字相同，
 * 少换一个，计划自己就不自洽，要到 C2 门口才炸。这组测试守的就是这两条。
 */

const NOW = "2026-09-18T02:00:00.000Z";

function freshPack(overrides = {}) {
  const base = platformSchemaEvidence();
  return {
    id: "b-evidence:schema:fresh0000000000000000",
    kind: "schema",
    status: "active",
    sourceType: "ozon_seller_api_current_schema",
    sourceRef: "ozon-seller-api:/v1/description-category/attribute:17028665:92935",
    checkedAt: NOW,
    expiresAt: "2026-09-19T02:00:00.000Z",
    scope: { platform: "ozon", store: base.store, category: "ozon:17028665:92935",
      ruleVersion: "ozon-current" },
    evidenceData: {
      schemaRevision: "ozon-schema-新版本",
      descriptionCategoryId: 17028665,
      typeId: 92935,
      requiredFields: structuredClone(base.requiredFields),
      attributes: [
        { fieldKey: "4967", label: "Материал", required: false, dictionaryId: 1503 },
        { fieldKey: "brand", label: "品牌", required: true, dictionaryId: 28732849 }
      ]
    },
    ...overrides
  };
}

async function skuAtInputsReady() {
  const state = await phase7PassedState();
  const plan = createC1ProductPlan({ ...state, platformSchemaEvidence: platformSchemaEvidence(), createdAt: NOW });
  return structuredClone(plan.skuPackage);
}

function packFor(sku, overrides = {}) {
  const rules = sku.c1ProductPlan.inputSnapshots.platformSchemaRules;
  const pack = freshPack(overrides);
  pack.scope.store = rules.store;
  if (rules.storeRef) pack.scope.storeRef = structuredClone(rules.storeRef); else delete pack.scope.storeRef;
  pack.evidenceData.descriptionCategoryId = Number(rules.descriptionCategoryId);
  pack.evidenceData.typeId = Number(rules.typeId);
  return pack;
}

const rejects = (code) => (error) => error instanceof C1FrozenSchemaRefreshError && error.code === code;

test("同一个类目的新读数换进来，三个引用一起换", async () => {
  const sku = await skuAtInputsReady();
  const before = sku.c1ProductPlan.inputSnapshots.platformSchemaRules.evidenceId;
  const { skuPackage, change } = refreshC1FrozenPlatformSchema({ skuPackage: sku, freshPack: packFor(sku), refreshedAt: NOW });
  const plan = skuPackage.c1ProductPlan;
  assert.equal(plan.inputSnapshots.platformSchemaRules.evidenceId, "b-evidence:schema:fresh0000000000000000");
  assert.equal(plan.inputSnapshots.platformSchemaRules.attributes.length, 2);
  assert.equal(plan.inputSnapshots.platformSchemaRules.ruleVersion, 'ozon-current');
  // 三处必须逐字相同，否则 C2 规范门会判计划不自洽。
  assert.equal(plan.inputRefs.platformSchemaEvidenceId, plan.frozenInputRefs.schemaSnapshotRef);
  assert.equal(plan.frozenInputRefs.schemaSnapshotRef, plan.schemaSnapshotRef);
  assert.equal(plan.schemaSnapshotRef, "b-evidence:schema:fresh0000000000000000");
  assert.equal(change.previousEvidenceId, before);
  assert.equal(change.attributeCount, 2);
  assert.equal(change.dictionaryBackedCount, 2);
  assert.deepEqual([change.requiredFieldsAdded, change.requiredFieldsRemoved], [[], []]);
  // 原对象不许被改。
  assert.equal(sku.c1ProductPlan.inputSnapshots.platformSchemaRules.evidenceId, before);
});

test("换成别的类目或别的店铺一律拒收", async () => {
  const sku = await skuAtInputsReady();
  for (const mutate of [
    (pack) => { pack.evidenceData.descriptionCategoryId = 17028966; },
    (pack) => { pack.evidenceData.typeId = 96063; },
    (pack) => { pack.scope.store = "别的店"; },
    (pack) => { pack.scope.platform = "wb"; },
    (pack) => { pack.scope.storeRef = { stableStoreId: "x", platformStoreId: "y", mappingVersion: "z" }; }
  ]) {
    const pack = packFor(sku);
    mutate(pack);
    assert.throws(() => refreshC1FrozenPlatformSchema({ skuPackage: sku, freshPack: pack, refreshedAt: NOW }),
      rejects("C1_FROZEN_SCHEMA_REFRESH_SCOPE_MISMATCH"));
  }
});

test("读回来仍然没有属性表就照实报错，不假装刷新成功", async () => {
  const sku = await skuAtInputsReady();
  for (const attributes of [undefined, [], null, "不是数组"]) {
    const pack = packFor(sku);
    if (attributes === undefined) delete pack.evidenceData.attributes; else pack.evidenceData.attributes = attributes;
    assert.throws(() => refreshC1FrozenPlatformSchema({ skuPackage: sku, freshPack: pack, refreshedAt: NOW }),
      rejects("C1_FROZEN_SCHEMA_REFRESH_ATTRIBUTES_MISSING"));
  }
});

test("事实已经冻结、或已经生产过，都不准再换", async () => {
  const frozen = await skuAtInputsReady();
  frozen.c1ProductPlan.status = "facts_checked";
  assert.throws(() => refreshC1FrozenPlatformSchema({ skuPackage: frozen, freshPack: packFor(frozen), refreshedAt: NOW }),
    rejects("C1_FROZEN_SCHEMA_REFRESH_FACTS_ALREADY_FROZEN"));
  const produced = await skuAtInputsReady();
  produced.productionAuthorization = { status: "authorized" };
  assert.throws(() => refreshC1FrozenPlatformSchema({ skuPackage: produced, freshPack: packFor(produced), refreshedAt: NOW }),
    rejects("C1_FROZEN_SCHEMA_REFRESH_ALREADY_PRODUCED"));
});

test("必填字段真的变了不拦，但如实报出来", async () => {
  const sku = await skuAtInputsReady();
  const pack = packFor(sku);
  pack.evidenceData.requiredFields = [
    ...structuredClone(sku.c1ProductPlan.inputSnapshots.platformSchemaRules.requiredFields).slice(1),
    { fieldKey: "新必填", label: "平台新加的", required: true }
  ];
  const { change } = refreshC1FrozenPlatformSchema({ skuPackage: sku, freshPack: pack, refreshedAt: NOW });
  assert.deepEqual(change.requiredFieldsAdded, ["新必填"]);
  assert.equal(change.requiredFieldsRemoved.length, 1);
});

test("坏证据包不收", async () => {
  const sku = await skuAtInputsReady();
  for (const mutate of [
    (pack) => { pack.kind = "commission"; },
    (pack) => { pack.status = "expired"; },
    (pack) => { pack.id = ""; },
    (pack) => { delete pack.evidenceData.schemaRevision; },
    (pack) => { pack.evidenceData.requiredFields = "不是数组"; }
  ]) {
    const pack = packFor(sku);
    mutate(pack);
    assert.throws(() => refreshC1FrozenPlatformSchema({ skuPackage: sku, freshPack: pack, refreshedAt: NOW }),
      (error) => error instanceof C1FrozenSchemaRefreshError);
  }
});
