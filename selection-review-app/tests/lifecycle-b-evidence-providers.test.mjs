import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createLifecycleBEvidenceProvider,
  createLifecycleBEvidenceProviderRegistry
} from "../lib/lifecycle-b-evidence-providers.mjs";
import { runLifecycleBEvidencePreparation } from "../lib/lifecycle-b-evidence-preparation.mjs";

const requestedAt = "2026-08-18T08:00:00.000Z";
const checkedAt = "2026-08-18T07:59:00.000Z";
const expiresAt = "2026-08-19T08:00:00.000Z";

test("店铺回执缺失或错绑时不能用请求scope回填为有效证据", async () => {
  for (const kind of ["commission", "schema"]) {
    for (const field of ["missing", "platformStoreId", "mappingVersion"]) {
      const response = result(kind);
      if (field === "missing") delete response.scope.storeRef;
      else response.scope.storeRef[field] = "different";
      let calls = 0;
      const provider = createLifecycleBEvidenceProvider({ kind, read: async () => { calls += 1; return response; } });
      await assert.rejects(() => provider(request(kind)), /B_EVIDENCE_PROVIDER_SCOPE_MISMATCH/);
      assert.equal(calls, 1);
    }
  }
});

const scopes = {
  commission: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", salesScheme: "rfbs" },
  logistics_tariff: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
  exchange_rate: { pair: "RUB/CNY" },
  schema: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", ruleVersion: "schema-2026-08-18" }
};

const evidenceData = {
  commission: {
    commissionRate: 0.14, commissionEvidenceMode: "exact",
    otherCosts: {
      packagingRmb: 1.5,
      labelRmb: 1.5,
      fixedOtherRmb: 0,
      advertisingRate: 0,
      returnReserveRate: 0,
      damageReserveRate: 0.05,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceIncrementCny: 1,
      thresholdLogic: "any",
      pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
    }
  },
  logistics_tariff: {
    chargeableWeightRule: "max_actual_volume",
    perKgRmb: 28.1,
    perParcelRmb: 17.97,
    minimumChargeableWeightKg: 0,
    weightRoundingKg: 0.1,
    volumeDivisorCm3PerKg: 6000
  },
  exchange_rate: { rubPerCny: 12.08 },
  schema: { schemaRevision: "schema-2026-08-18", requiredFields: [] }
};

function request(kind) {
  return {
    requestVersion: "lifecycle-b-evidence-preparation-v1.1",
    candidateId: "PROVIDER-SKU-1",
    candidateRevision: 7,
    kind,
    scope: structuredClone(scopes[kind]),
    maximumAttempts: 1,
    readOnly: true,
    platformWritesAllowed: false,
    requestedAt
  };
}

function result(kind) {
  return {
    current: true,
    scope: structuredClone(scopes[kind]),
    sourceType: "isolated_test",
    sourceRef: `fixture:${kind}:current`,
    checkedAt,
    expiresAt,
    evidenceData: structuredClone(evidenceData[kind])
  };
}

test("四类适配器都输出当前、精确范围、可追溯且可复用的证据包", async () => {
  const calls = [];
  const readers = Object.fromEntries(Object.keys(scopes).map((kind) => [
    kind,
    async (input) => {
      calls.push(input);
      return result(kind);
    }
  ]));
  const registry = createLifecycleBEvidenceProviderRegistry(readers);
  const packs = [];
  for (const kind of Object.keys(scopes)) packs.push(await registry[kind](request(kind)));
  assert.equal(packs.length, 4);
  assert.ok(packs.every((pack) => pack.status === "active" && pack.id.startsWith("b-evidence:")));
  assert.deepEqual(packs.map((pack) => pack.kind), Object.keys(scopes));
  assert.ok(calls.every((call) => call.readOnly === true && call.platformWritesAllowed === false));
  assert.ok(Object.isFrozen(registry));
});

test("请求不是只读或尝试次数不是1时，在调用真实读取器前拒绝", async () => {
  let calls = 0;
  const provider = createLifecycleBEvidenceProvider({
    kind: "commission",
    read: async () => { calls += 1; return result("commission"); }
  });
  const writable = request("commission");
  writable.platformWritesAllowed = true;
  await assert.rejects(() => provider(writable), /B_EVIDENCE_PROVIDER_NOT_READ_ONLY/);
  const retrying = request("commission");
  retrying.maximumAttempts = 2;
  await assert.rejects(() => provider(retrying), /B_EVIDENCE_PROVIDER_ATTEMPT_LIMIT/);
  assert.equal(calls, 0);
});

test("错店铺、错线路或错币种的返回结果都不能被兜底接收", async () => {
  for (const kind of Object.keys(scopes)) {
    const wrong = result(kind);
    const firstKey = Object.keys(wrong.scope)[0];
    wrong.scope[firstKey] = "wrong-scope";
    const provider = createLifecycleBEvidenceProvider({ kind, read: async () => wrong });
    await assert.rejects(() => provider(request(kind)), /B_EVIDENCE_PROVIDER_SCOPE_MISMATCH/);
  }
});

test("非当前结果、缺时效和无效结构化数据明确失败，不生成默认值", async () => {
  const stale = result("exchange_rate");
  stale.current = false;
  await assert.rejects(
    () => createLifecycleBEvidenceProvider({ kind: "exchange_rate", read: async () => stale })(request("exchange_rate")),
    /B_EVIDENCE_PROVIDER_NOT_CURRENT/
  );

  const noExpiry = result("logistics_tariff");
  delete noExpiry.expiresAt;
  await assert.rejects(
    () => createLifecycleBEvidenceProvider({ kind: "logistics_tariff", read: async () => noExpiry })(request("logistics_tariff")),
    /B_EVIDENCE_PROVIDER_VALIDITY_INVALID/
  );

  const invalid = result("commission");
  delete invalid.evidenceData.commissionRate;
  await assert.rejects(
    () => createLifecycleBEvidenceProvider({ kind: "commission", read: async () => invalid })(request("commission")),
    /B_EVIDENCE_PROVIDER_DATA_INVALID/
  );
});

test("来源引用含凭证暗示时拒绝，错误不会泄露或保存为证据包", async () => {
  const unsafe = result("schema");
  unsafe.sourceRef = "https://example.test/schema?token=do-not-store";
  const provider = createLifecycleBEvidenceProvider({ kind: "schema", read: async () => unsafe });
  await assert.rejects(() => provider(request("schema")), /B_EVIDENCE_PROVIDER_SECRET_REJECTED/);
});

test("读取器故障只包装为明确失败，不自动调用第二次", async () => {
  let calls = 0;
  const provider = createLifecycleBEvidenceProvider({
    kind: "exchange_rate",
    read: async () => {
      calls += 1;
      throw new Error("官方汇率源暂不可读");
    }
  });
  await assert.rejects(() => provider(request("exchange_rate")), /B_EVIDENCE_PROVIDER_READ_FAILED/);
  assert.equal(calls, 1);
});

test("四类适配器可直接接入准备执行器并形成全有或全无的提交集合", async () => {
  const registry = createLifecycleBEvidenceProviderRegistry(Object.fromEntries(
    Object.keys(scopes).map((kind) => [kind, async () => result(kind)])
  ));
  const candidate = {
    id: "PROVIDER-SKU-1",
    dataRevision: 7,
    targetStore: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    lifecycleEvidenceContextV11: {
      platform: "ozon",
      store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
      category: "music-box",
      salesScheme: "rfbs",
      route: "guoo-economy-small",
      logisticsRuleVersion: "guoo-2026-07-20",
      exchangePair: "RUB/CNY",
      schemaRuleVersion: "schema-2026-08-18"
    }
  };
  const prepared = await runLifecycleBEvidencePreparation({
    candidate,
    evidencePacks: [],
    providers: registry,
    plannedAt: requestedAt,
    preparedAt: "2026-08-18T08:01:00.000Z"
  });
  assert.equal(prepared.status, "completed");
  assert.equal(prepared.evidencePacksToCommit.length, 4);
  assert.equal(prepared.finalReadiness.ready, true);
  assert.equal(prepared.platformWrites, 0);
  assert.equal(prepared.automaticRetryAttempted, false);
});

test("估算provider严格保留本轮授权，拒绝旧包、错候选、错修订和额外字段", async () => {
  const req = request("commission");
  const raw = result("commission");
  raw.evidenceData.commissionEvidenceMode = "estimated";
  const binding = { schemaVersion: "commission-estimate-authorization-v1", candidateId: req.candidateId,
    candidateRevision: req.candidateRevision, authorizationRef: "owner-estimate:synthetic", commissionRate: raw.evidenceData.commissionRate };
  raw.evidenceData.commissionEstimateAuthorization = binding;
  const saved = await createLifecycleBEvidenceProvider({ kind: "commission", read: async () => raw })(req);
  assert.deepEqual(saved.evidenceData.commissionEstimateAuthorization, binding);
  for (const invalid of [undefined, { ...binding, candidateId: "wrong" }, { ...binding, candidateRevision: req.candidateRevision + 1 },
    { ...binding, commissionRate: 0.9 }, { ...binding, extra: true }]) {
    const response = structuredClone(raw);
    if (invalid === undefined) delete response.evidenceData.commissionEstimateAuthorization;
    else response.evidenceData.commissionEstimateAuthorization = invalid;
    await assert.rejects(() => createLifecycleBEvidenceProvider({ kind: "commission", read: async () => response })(req), /B_EVIDENCE_PROVIDER_ESTIMATE_SCOPE_MISMATCH/);
  }
});

// Synthetic formal metadata tests the contract only; the real WB reader stays NOT_FORMAL.
test('versioned WB commission preserves its reference and unknown expiry without weakening other traces', async () => {
  const input = request('commission'), response = result('commission');
  Object.assign(input.scope, {platform:'wb',store:'wb',category:'wb:subject:5267',salesScheme:'fbs'});
  input.scope.storeRef.stableStoreId = 'wb';
  response.scope = structuredClone(input.scope);
  response.sourceType = 'wb_official_commission_reference'; response.expiresAt = null;
  response.commissionCatalogRef = {catalogId:'synthetic-catalog',catalogVersion:'v1',sellerRegion:'CN',subjectId:5267,
    sourceField:'kgvpChina',sourceReceiptRef:'synthetic-receipt',effectiveFrom:null};
  const normalized = await createLifecycleBEvidenceProvider({kind:'commission',read:async()=>response})(input);
  assert.equal(normalized.expiresAt,null); assert.deepEqual(normalized.commissionCatalogRef,response.commissionCatalogRef);
  assert.notEqual(normalized.commissionCatalogRef,response.commissionCatalogRef);
  for (const mutate of [r=>{delete r.commissionCatalogRef;},r=>{r.evidenceData.commissionEvidenceMode='estimated';},
    r=>{r.commissionCatalogRef.sourceReceiptRef='token=private';},r=>{r.evidenceData.otherCosts={};}]) {
    const invalid=structuredClone(response); mutate(invalid);
    await assert.rejects(createLifecycleBEvidenceProvider({kind:'commission',read:async()=>invalid})(input),/B_EVIDENCE_PROVIDER_/);
  }
  for (const kind of ['commission','logistics_tariff','exchange_rate','schema']) {
    const invalid=result(kind); invalid.expiresAt=null;
    await assert.rejects(createLifecycleBEvidenceProvider({kind,read:async()=>invalid})(request(kind)),/B_EVIDENCE_PROVIDER_VALIDITY_INVALID/);
  }
});

test("官方费表查询输入只随佣金请求原样传给reader，其他类型一律为空", async () => {
  const observed = [];
  const readers = Object.fromEntries(Object.keys(scopes).map((kind) => [
    kind,
    async (input) => { observed.push({ kind, commissionReferenceScope: input.commissionReferenceScope }); return result(kind); }
  ]));
  const registry = createLifecycleBEvidenceProviderRegistry(readers);
  const reference = { priceRub: 2490, typeName: "宠物躺床" };
  await registry.commission({ ...request("commission"), commissionReferenceScope: reference });
  for (const kind of Object.keys(scopes).filter((value) => value !== "commission")) {
    await registry[kind]({ ...request(kind), commissionReferenceScope: reference });
  }
  assert.deepEqual(observed.find((entry) => entry.kind === "commission").commissionReferenceScope, reference);
  for (const entry of observed.filter((value) => value.kind !== "commission")) assert.equal(entry.commissionReferenceScope, null);
  const observedAgain = [];
  const plainRegistry = createLifecycleBEvidenceProviderRegistry({
    commission: async (input) => { observedAgain.push(input.commissionReferenceScope); return result("commission"); }
  });
  await plainRegistry.commission(request("commission"));
  await plainRegistry.commission({ ...request("commission"), commissionReferenceScope: "宠物躺床" });
  assert.deepEqual(observedAgain, [null, null], "缺失或非结构化输入不传给reader");
});
