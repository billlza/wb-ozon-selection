import test from "node:test";
import assert from "node:assert/strict";

import { phase7PassedState, platformSchemaEvidence } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createC1ProductPlan } from "../lib/c1-product-plan.mjs";
import { createActorContext, createLocalDevelopmentActor } from "../lib/runtime-identity.mjs";
import {
  createC1SupplyAttributeBackfillUseCase,
  C1SupplyAttributeBackfillError
} from "../lib/c1-frozen-supply-attribute-backfill-use-case.mjs";

/*
 * 这一步搬的是**同一次采集里已有、当时没搬进冻结快照**的供应商属性。
 * 它最危险的失败方式不是「补不上」，而是「悄悄改掉已经冻过的值」或者「把另一次采集的数据
 * 当成同一次搬进来」——那会让冻结快照与它自称的证据来源对不上。这组测试守的就是这两条，
 * 外加「事实一旦冻结就不准再补」。
 */

const NOW = "2026-09-17T14:00:00.000Z";
const REVISION = 40;
const CAPTURE_ID = "SCJ-backfill-test";

function owner() {
  return createActorContext({ userId: "local-owner:test", sessionId: "supply-backfill", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: NOW });
}

async function candidateAtInputsReady({ captured = null, captureId = CAPTURE_ID, frozenCaptureId = CAPTURE_ID } = {}) {
  const state = await phase7PassedState();
  const plan = createC1ProductPlan({ ...state, platformSchemaEvidence: platformSchemaEvidence(), createdAt: NOW });
  const sku = structuredClone(plan.skuPackage);
  for (const target of [sku.selectedSupplySnapshot, sku.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot]) {
    target.supplierSku.attributes = { quantityOneEvidence: { captureId: frozenCaptureId } };
    target.supplierSku.material = "unknown";
  }
  return {
    id: state.candidate.id,
    dataRevision: REVISION,
    sourceCapture: { captureId, supplierAttributes: captured ?? { "面料": "牛津布", "颜色": "黑色,卡其色", "品牌": "WOSPORT" } },
    lifecycleV11: { skuPackage: sku }
  };
}

function runner(candidate) {
  const useCase = createC1SupplyAttributeBackfillUseCase({
    repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
    runtimeMode: "local_development", serverClock: () => new Date(NOW)
  });
  return (actor = owner()) => useCase.backfill({ actor, input: {
    candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    idempotencyKey: "supply-backfill-1", auditEventId: "audit:supply-backfill-1"
  } });
}

const rejects = code => error => error instanceof C1SupplyAttributeBackfillError && error.code === code;

test("同一次采集的属性补进两份冻结快照，品牌不当事实，面料成为材质", async () => {
  const candidate = await candidateAtInputsReady();
  const out = await runner(candidate)();
  assert.equal(out.status, "committed");
  assert.deepEqual(out.result.addedAttributeKeys.sort(), ["颜色", "面料"].sort());
  assert.equal(out.result.materialResolved, "牛津布");
  assert.deepEqual(out.result.skippedNonFactKeys, ["品牌"]);
  assert.deepEqual([out.result.externalCalls, out.result.aiCalls, out.result.platformWrites, out.result.paidCalls], [0, 0, 0, 0]);
  const sku = out.candidate.lifecycleV11.skuPackage;
  for (const target of [sku.selectedSupplySnapshot, sku.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot]) {
    assert.equal(target.supplierSku.attributes["面料"], "牛津布");
    assert.equal(target.supplierSku.attributes["颜色"], "黑色,卡其色");
    assert.equal(target.supplierSku.material, "牛津布");
    // 品牌绝不能进冻结快照：主人签的是无品牌声明。
    assert.equal(Object.hasOwn(target.supplierSku.attributes, "品牌"), false);
    // 已经冻过的数量证据一字不动。
    assert.equal(target.supplierSku.attributes.quantityOneEvidence.captureId, CAPTURE_ID);
  }
});

test("不是同一次采集就拒绝——那属于新证据，必须走正经货源确认", async () => {
  const candidate = await candidateAtInputsReady({ captureId: "SCJ-another-capture" });
  await assert.rejects(runner(candidate)(), rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_CAPTURE_MISMATCH"));
});

test("已经冻过的键值对不上就停，不悄悄以新的为准", async () => {
  const state = await phase7PassedState();
  const plan = createC1ProductPlan({ ...state, platformSchemaEvidence: platformSchemaEvidence(), createdAt: NOW });
  const sku = structuredClone(plan.skuPackage);
  for (const target of [sku.selectedSupplySnapshot, sku.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot]) {
    target.supplierSku.attributes = { quantityOneEvidence: { captureId: CAPTURE_ID }, "面料": "涤纶" };
    target.supplierSku.material = "unknown";
  }
  const candidate = {
    id: state.candidate.id, dataRevision: REVISION,
    sourceCapture: { captureId: CAPTURE_ID, supplierAttributes: { "面料": "牛津布" } },
    lifecycleV11: { skuPackage: sku }
  };
  await assert.rejects(runner(candidate)(), rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_FROZEN_VALUE_CONFLICT"));
});

test("材质已经有别的值时不覆盖", async () => {
  const state = await phase7PassedState();
  const plan = createC1ProductPlan({ ...state, platformSchemaEvidence: platformSchemaEvidence(), createdAt: NOW });
  const sku = structuredClone(plan.skuPackage);
  for (const target of [sku.selectedSupplySnapshot, sku.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot]) {
    target.supplierSku.attributes = { quantityOneEvidence: { captureId: CAPTURE_ID } };
    target.supplierSku.material = "涤纶";
  }
  const candidate = {
    id: state.candidate.id, dataRevision: REVISION,
    sourceCapture: { captureId: CAPTURE_ID, supplierAttributes: { "面料": "牛津布" } },
    lifecycleV11: { skuPackage: sku }
  };
  await assert.rejects(runner(candidate)(), rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_FROZEN_VALUE_CONFLICT"));
});

test("事实已经冻结就不准再补——那时改的是已冻事实，不是冻前输入", async () => {
  const candidate = await candidateAtInputsReady();
  candidate.lifecycleV11.skuPackage.c1ProductPlan.status = "facts_checked";
  await assert.rejects(runner(candidate)(), rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_FACTS_ALREADY_FROZEN"));
});

test("已经生产授权或执行过的SKU不准补", async () => {
  const candidate = await candidateAtInputsReady();
  candidate.lifecycleV11.skuPackage.productionAuthorization = { status: "authorized" };
  await assert.rejects(runner(candidate)(), rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_ALREADY_PRODUCED"));
});

test("没有可搬的属性时诚实报错，不写一次空事务", async () => {
  const candidate = await candidateAtInputsReady({ captured: { "品牌": "WOSPORT", "有可授权的自有品牌": "否" } });
  await assert.rejects(runner(candidate)(), rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_NOTHING_TO_ADD"));
});

test("本地开发默认主体不算已认证主人，补冻不给过", async () => {
  // createActorContext 本身就不让非真人拿 owner 角色，所以这里能构造出来的不合格主体只有一种：
  // 真人、有 owner 角色，但来源是 development_default。服务端每条主人路由都在拦同一条件。
  const candidate = await candidateAtInputsReady();
  await assert.rejects(runner(candidate)(createLocalDevelopmentActor({ at: NOW })),
    rejects("C1_SUPPLY_ATTRIBUTE_BACKFILL_AUTHENTICATED_OWNER_REQUIRED"));
});

test("入参多一个键少一个键都不收", async () => {
  const candidate = await candidateAtInputsReady();
  const useCase = createC1SupplyAttributeBackfillUseCase({
    repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
    runtimeMode: "local_development", serverClock: () => new Date(NOW)
  });
  const base = { candidateId: candidate.id, expectedRevision: REVISION,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    idempotencyKey: "k", auditEventId: "a" };
  const invalid = code => error => error instanceof C1SupplyAttributeBackfillError && error.code === code;
  await assert.rejects(useCase.backfill({ actor: owner(), input: { ...base, extra: 1 } }),
    invalid("C1_SUPPLY_ATTRIBUTE_BACKFILL_INPUT_INVALID"));
  const { auditEventId, ...missing } = base;
  await assert.rejects(useCase.backfill({ actor: owner(), input: missing }),
    invalid("C1_SUPPLY_ATTRIBUTE_BACKFILL_INPUT_INVALID"));
});
