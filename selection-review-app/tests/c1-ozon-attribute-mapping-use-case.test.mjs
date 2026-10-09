import test from "node:test";
import assert from "node:assert/strict";

import { phase7PassedState, platformSchemaEvidence } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createC1ProductPlan } from "../lib/c1-product-plan.mjs";
import { createActorContext, createLocalDevelopmentActor } from "../lib/runtime-identity.mjs";
import {
  createC1OzonAttributeMappingUseCase,
  C1OzonAttributeMappingError
} from "../lib/c1-ozon-attribute-mapping-use-case.mjs";

/*
 * 这一步把主人的「中文事实 → Ozon 俄文字典值」判断记下来。
 *
 * 它最危险的失败方式是**拿近似值顶替**：字典里有 "Оксфорд 210D" 没有 "Оксфорд"，
 * 却当成命中写下去——那个字典号发到 Ozon 上就是另一种面料。
 * 其次是中文那端根本没确认过，等于凭空给商品安一条属性。这组测试守的就是这两条。
 */

const NOW = "2026-09-17T15:00:00.000Z";
const REVISION = 40;
const ATTRIBUTES = [
  { fieldKey: "4967", label: "Материал", required: false, dictionaryId: 1503 },
  { fieldKey: "9048", label: "Название модели", required: true, dictionaryId: 0 }
];

function owner() {
  return createActorContext({ userId: "local-owner:test", sessionId: "ozon-attribute-mapping", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: NOW });
}

async function candidateAtInputsReady() {
  const state = await phase7PassedState();
  const plan = createC1ProductPlan({ ...state, platformSchemaEvidence: platformSchemaEvidence(), createdAt: NOW });
  const sku = structuredClone(plan.skuPackage);
  sku.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes = structuredClone(ATTRIBUTES);
  sku.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.material = "牛津布";
  sku.selectedSupplySnapshot.supplierSku.material = "牛津布";
  return { id: state.candidate.id, dataRevision: REVISION, lifecycleV11: { skuPackage: sku } };
}

function runner(candidate, { dictionaryResult, onRead } = {}) {
  const reads = [];
  const useCase = createC1OzonAttributeMappingUseCase({
    repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
    runtimeMode: "local_development", serverClock: () => new Date(NOW),
    readDictionaryValue: async (request) => {
      reads.push(request);
      if (onRead) onRead(request);
      return dictionaryResult ?? {
        sourceRef: "ozon-seller-api:/v1/description-category/attribute/values/search:17028665:92935:4967",
        evidenceData: { exactMatch: { dictionaryValueId: 61979, value: "Оксфорд" },
          matches: [{ dictionaryValueId: 61979, value: "Оксфорд" }] }
      };
    }
  });
  const call = (mappings, actor = owner()) => useCase.map({ actor, input: {
    candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    mappings, idempotencyKey: "ozon-mapping-1", auditEventId: "audit:ozon-mapping-1"
  } });
  return { call, reads };
}

const MATERIAL = { attributeId: "4967", value: "Оксфорд", sourceFactPath: "productAttributes.material" };
const rejects = (code) => (error) => error instanceof C1OzonAttributeMappingError && error.code === code;

test("字典逐字命中时写下真实字典号，中文那端的当时值一并记下来", async () => {
  const candidate = await candidateAtInputsReady();
  const { call, reads } = runner(candidate);
  const out = await call([MATERIAL]);
  assert.equal(out.status, "committed");
  assert.deepEqual(out.result.mappedAttributeIds, ["4967"]);
  assert.equal(out.result.dictionaryBackedCount, 1);
  assert.deepEqual([out.result.aiCalls, out.result.platformWrites, out.result.paidCalls], [0, 0, 0]);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].attributeId, "4967");
  assert.equal(reads[0].value, "Оксфорд");
  const record = out.candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1;
  assert.equal(record.schemaVersion, "c1-ozon-attribute-mapping-v1");
  assert.equal(record.schemaRevision, platformSchemaEvidence().schemaRevision);
  assert.deepEqual(record.mappings[0], {
    attributeId: "4967", attributeLabel: "Материал", dictionaryId: 1503,
    value: "Оксфорд", dictionaryValueId: 61979,
    sourceFactPath: "productAttributes.material", sourceFactValue: "牛津布",
    dictionaryEvidenceRef: "ozon-seller-api:/v1/description-category/attribute/values/search:17028665:92935:4967"
  });
});

test("字典里只有近似值时拒收，整轮不写", async () => {
  const candidate = await candidateAtInputsReady();
  const { call } = runner(candidate, { dictionaryResult: { evidenceData: {
    exactMatch: null, matches: [{ dictionaryValueId: 971199250, value: "Оксфорд 210D" }] } } });
  await assert.rejects(call([MATERIAL]), rejects("C1_OZON_ATTRIBUTE_MAPPING_DICTIONARY_VALUE_NOT_FOUND"));
});

test("字典读数自称命中但值对不上，同样拒收", async () => {
  const candidate = await candidateAtInputsReady();
  const { call } = runner(candidate, { dictionaryResult: { evidenceData: {
    exactMatch: { dictionaryValueId: 971199250, value: "Оксфорд 210D" }, matches: [] } } });
  await assert.rejects(call([MATERIAL]), rejects("C1_OZON_ATTRIBUTE_MAPPING_DICTIONARY_VALUE_NOT_FOUND"));
});

test("无字典的自由文本属性不查字典，也不发外部调用", async () => {
  const candidate = await candidateAtInputsReady();
  const { call, reads } = runner(candidate);
  const out = await call([{ attributeId: "9048", value: "Мини-жилет", sourceFactPath: "productAttributes.material" }]);
  assert.equal(out.status, "committed");
  assert.equal(reads.length, 0, "无字典属性不该发字典查询");
  assert.equal(out.result.dictionaryBackedCount, 0);
  assert.equal(out.result.freeTextCount, 1);
  assert.equal(out.result.externalCalls, 0);
  assert.equal(out.candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1.mappings[0].dictionaryValueId, null);
});

test("属性号不在当前冻结schema里就拒收", async () => {
  const candidate = await candidateAtInputsReady();
  const { call } = runner(candidate);
  await assert.rejects(call([{ ...MATERIAL, attributeId: "999999" }]),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_ATTRIBUTE_NOT_IN_SCHEMA"));
});

test("中文那端没确认过就拒收——不能凭空给商品安一条属性", async () => {
  const candidate = await candidateAtInputsReady();
  candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.material = "unknown";
  const { call } = runner(candidate);
  await assert.rejects(call([MATERIAL]), rejects("C1_OZON_ATTRIBUTE_MAPPING_SOURCE_FACT_NOT_CONFIRMED"));
});

test("冻结schema没带属性表时说清楚，不含糊放行", async () => {
  const candidate = await candidateAtInputsReady();
  delete candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes;
  const { call } = runner(candidate);
  await assert.rejects(call([MATERIAL]), rejects("C1_OZON_ATTRIBUTE_MAPPING_SCHEMA_ATTRIBUTES_MISSING"));
});

test("事实已经冻结就不准再映射", async () => {
  const candidate = await candidateAtInputsReady();
  candidate.lifecycleV11.skuPackage.c1ProductPlan.status = "facts_checked";
  const { call } = runner(candidate);
  await assert.rejects(call([MATERIAL]), rejects("C1_OZON_ATTRIBUTE_MAPPING_FACTS_ALREADY_FROZEN"));
});

test("同一个属性映射两次就拒收", async () => {
  const candidate = await candidateAtInputsReady();
  const { call } = runner(candidate);
  await assert.rejects(call([MATERIAL, { ...MATERIAL, value: "Хлопок" }]),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_DUPLICATE_ATTRIBUTE"));
});

test("本地开发默认主体不算已认证主人", async () => {
  const candidate = await candidateAtInputsReady();
  const { call } = runner(candidate);
  await assert.rejects(call([MATERIAL], createLocalDevelopmentActor({ at: NOW })),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_AUTHENTICATED_OWNER_REQUIRED"));
});

test("入参多一个键少一个键、条目形状不对都不收", async () => {
  const candidate = await candidateAtInputsReady();
  const useCase = createC1OzonAttributeMappingUseCase({
    repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
    runtimeMode: "local_development", serverClock: () => new Date(NOW),
    readDictionaryValue: async () => { throw new Error("不该走到这里"); }
  });
  const base = { candidateId: candidate.id, expectedRevision: REVISION,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    mappings: [MATERIAL], idempotencyKey: "k", auditEventId: "a" };
  await assert.rejects(useCase.map({ actor: owner(), input: { ...base, extra: 1 } }),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID"));
  const { auditEventId, ...missing } = base;
  await assert.rejects(useCase.map({ actor: owner(), input: missing }),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID"));
  await assert.rejects(useCase.map({ actor: owner(), input: { ...base, mappings: [] } }),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID"));
  await assert.rejects(useCase.map({ actor: owner(), input: { ...base, mappings: [{ ...MATERIAL, extra: 1 }] } }),
    rejects("C1_OZON_ATTRIBUTE_MAPPING_ENTRY_INVALID"));
});

test("摊开给主人挑时不查字典、不改数据，已签过的映射原样带出来", async () => {
  const candidate = await candidateAtInputsReady();
  const before = JSON.stringify(candidate);
  let dictionaryReads = 0;
  const useCase = createC1OzonAttributeMappingUseCase({
    repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
    runtimeMode: "local_development", serverClock: () => new Date(NOW),
    readDictionaryValue: async () => { dictionaryReads += 1; return {}; }
  });
  const proposal = await useCase.propose({ actor: owner(), input: {
    candidateId: candidate.id, expectedRevision: REVISION,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId
  } });
  assert.equal(dictionaryReads, 0, "摊开这一步绝不该发字典查询");
  assert.equal(JSON.stringify(candidate), before, "只读这一步不许改数据");
  assert.deepEqual(proposal.attributes.map((item) => item.fieldKey), ["4967", "9048"]);
  assert.equal(proposal.attributes[0].dictionaryId, 1503);
  assert.equal(proposal.attributes[0].mapping, null);
  assert.equal(proposal.category, "ozon:17028665:92935");
  // 中文那一端：值必须是已确认且非 unknown 的字符串事实。
  assert.ok(proposal.confirmedFacts.some((item) => item.factPath === "productAttributes.material" && item.value === "牛津布"));
  assert.equal(proposal.confirmedFacts.some((item) => item.value === "unknown"), false);
});

test("签过映射之后再摊开，那一条挂在对应属性上", async () => {
  const candidate = await candidateAtInputsReady();
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const useCase = createC1OzonAttributeMappingUseCase({
    repository, runtimeMode: "local_development", serverClock: () => new Date(NOW),
    readDictionaryValue: async () => ({ sourceRef: "ozon-seller-api:4967",
      evidenceData: { exactMatch: { dictionaryValueId: 61979, value: "Оксфорд" }, matches: [] } })
  });
  const committed = await useCase.map({ actor: owner(), input: {
    candidateId: candidate.id, expectedRevision: REVISION,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    mappings: [MATERIAL], idempotencyKey: "k", auditEventId: "a"
  } });
  const proposal = await useCase.propose({ actor: owner(), input: {
    candidateId: candidate.id, expectedRevision: committed.candidate.dataRevision,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId
  } });
  assert.equal(proposal.attributes.find((item) => item.fieldKey === "4967").mapping.dictionaryValueId, 61979);
  assert.equal(proposal.attributes.find((item) => item.fieldKey === "9048").mapping, null);
});


test("依据不能是另一条映射自己产出的结果——那等于自己给自己作证", async () => {
  // 2026-09-18 真踩到：第一轮签完后，映射被投影成 productAttributes.ozonAttributes.N.fact
  // （值是俄文的）；第二轮生成建议时把它们也当成「我们自己的事实」，6 条里 5 条绑回了自己。
  // 后果不是难看而已：漂移守卫比的是「依据的那条事实值有没有变」，而事实就是它自己，
  // 永远不会变——牛津布改成别的面料也发现不了。
  const candidate = await candidateAtInputsReady();
  const { call } = runner(candidate);
  for (const path of [
    "productAttributes.ozonAttributes.0.fact",
    // 第二次踩到的形状：必填格**也会被映射回填**，绑过去同样是自己给自己作证。
    // 只排 ozonAttributes 的话，同一个毛病换个地方又长出来（2026-09-18 真踩到两次）。
    "productAttributes.requiredPlatformFields.0.fact"
  ]) {
    await assert.rejects(
      call([{ attributeId: "4967", value: "Оксфорд", sourceFactPath: path }]),
      rejects("C1_OZON_ATTRIBUTE_MAPPING_SELF_REFERENCED_FACT"), path);
  }
});

test("摊开给主人挑时，不把映射自己的产出列进可选依据", async () => {
  const candidate = await candidateAtInputsReady();
  candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1 = {
    schemaVersion: "c1-ozon-attribute-mapping-v1",
    schemaRevision: candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision,
    confirmationRef: "owner-ozon-attribute-mapping:test", confirmedBy: "o", confirmedAt: NOW,
    mappings: [{ attributeId: "4967", attributeLabel: "Материал", dictionaryId: 1503,
      value: "Оксфорд", dictionaryValueId: 61979,
      sourceFactPath: "productAttributes.material", sourceFactValue: "牛津布",
      dictionaryEvidenceRef: "ozon-seller-api:4967" }]
  };
  const useCase = createC1OzonAttributeMappingUseCase({
    repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
    runtimeMode: "local_development", serverClock: () => new Date(NOW),
    readDictionaryValue: async () => ({})
  });
  const proposal = await useCase.propose({ actor: owner(), input: {
    candidateId: candidate.id, expectedRevision: REVISION,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId } });
  for (const prefix of ["productAttributes.ozonAttributes", "productAttributes.requiredPlatformFields"]) {
    assert.equal(proposal.confirmedFacts.some(item => item.factPath.startsWith(prefix)), false,
      `派生事实不得出现在可选依据里：${prefix}`);
  }
  assert.ok(proposal.confirmedFacts.some(item => item.factPath === "productAttributes.material"),
    "真正的中文事实必须还在");
});
