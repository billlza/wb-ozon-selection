import { createInternalEvidenceValidity } from "../lib/lifecycle-evidence-validity.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLifecycleBEvidencePreparationPlan,
  runLifecycleBEvidencePreparation
} from "../lib/lifecycle-b-evidence-preparation.mjs";

const plannedAt = "2026-08-18T06:30:00.000Z";
const preparedAt = "2026-08-18T06:31:00.000Z";
const expiresAt = "2026-08-19T06:30:00.000Z";

test("换平台店铺ID或映射版本时，旧佣金与Schema不复用，通用汇率和物流不受影响", () => {
  for (const field of ["platformStoreId", "mappingVersion"]) {
    const value = candidate();
    value.storeRef[field] = "changed";
    value.lifecycleEvidenceContextV11.storeRef[field] = "changed";
    const packs = allPacks();
    const before = structuredClone(packs);
    const plan = buildLifecycleBEvidencePreparationPlan({ candidate: value, evidencePacks: packs, plannedAt });
    assert.deepEqual(plan.actions.filter(item => item.action === "prepare_once").map(item => item.kind), ["commission", "schema"]);
    assert.deepEqual(packs, before);
  }
  const packs = allPacks();
  for (const pack of packs.filter(item => ["commission", "schema"].includes(item.kind))) delete pack.scope.storeRef;
  const plan = buildLifecycleBEvidencePreparationPlan({ candidate: candidate(), evidencePacks: packs, plannedAt });
  assert.deepEqual(plan.actions.filter(item => item.action === "prepare_once").map(item => item.kind), ["commission", "schema"]);
});

function candidate(id = "EVIDENCE-PREP-SKU-1") {
  return {
    id,
    dataRevision: 4,
    targetStore: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    workflowStatus: "awaiting_user_direction",
    lifecycleEvidenceContextV11: {
      platform: "ozon",
      store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
      category: "music-box",
      salesScheme: "rfbs",
      route: "guoo-economy-small",
      logisticsRuleVersion: "guoo-2026-07-20",
      exchangePair: "RUB/CNY",
      schemaRuleVersion: "ozon-music-box-2026-08-18"
    }
  };
}

function pack(kind, id = `PACK-${kind}`) {
  const shared = {
    id,
    kind,
    status: "active",
    sourceType: "isolated_test",
    sourceRef: `fixture:${kind}`,
    checkedAt: plannedAt,
    expiresAt
  };
  if (kind === "commission") return {
    ...shared,
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", salesScheme: "rfbs" },
    evidenceData: {
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
    }
  };
  if (kind === "logistics_tariff") return {
    ...shared,
    scope: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
    evidenceData: {
      chargeableWeightRule: "actual_weight",
      perKgRmb: 28.1,
      perParcelRmb: 17.97,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1
    }
  };
  if (kind === "exchange_rate") return {
    ...shared,
    scope: { pair: "RUB/CNY" },
    evidenceData: { rubPerCny: 12 }
  };
  return {
    ...shared,
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", ruleVersion: "ozon-music-box-2026-08-18" },
    evidenceData: { schemaRevision: "ozon-music-box-2026-08-18", requiredFields: [] }
  };
}

function allPacks() {
  return ["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => pack(kind));
}

test("四类当前证据全部复用时不调用任何提供器", async () => {
  const source = candidate();
  const before = JSON.stringify(source);
  const plan = buildLifecycleBEvidencePreparationPlan({ candidate: source, evidencePacks: allPacks(), plannedAt });
  assert.equal(plan.status, "ready_from_reuse");
  assert.ok(plan.actions.every((action) => action.action === "reuse"));
  const result = await runLifecycleBEvidencePreparation({
    candidate: source,
    evidencePacks: allPacks(),
    providers: {},
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.equal(JSON.stringify(source), before);
});

test("计划时可复用但完成前已过期时停止，不把时效漂移标成完成", async () => {
  const expiring = allPacks();
  expiring[0].expiresAt = "2026-08-18T06:30:30.000Z";
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: expiring,
    providers: {},
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.layer, "reuse_validity_drift");
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.equal(result.businessStateEffect, "unchanged");
});

test("四类缺失时各提供器只调用一次并形成全有或全无的提交集合", async () => {
  const calls = [];
  const providers = Object.fromEntries(allPacks().map((item) => [
    item.kind,
    async (request) => {
      calls.push({ kind: item.kind, request });
      return pack(item.kind);
    }
  ]));
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: [],
    providers,
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "completed");
  assert.equal(result.finalReadiness.ready, true);
  assert.equal(result.evidencePacksToCommit.length, 4);
  assert.deepEqual(calls.map((item) => item.kind), ["commission", "logistics_tariff", "exchange_rate", "schema"]);
  assert.ok(calls.every((item) => item.request.maximumAttempts === 1 && item.request.readOnly === true));
  assert.ok(result.providerCalls.every((call) => call.attempt === 1 && call.status === "completed"));
  assert.equal(result.automaticRetryAttempted, false);
});

test("任一提供器失败立即停止并丢弃本轮已准备结果，不形成半套提交", async () => {
  const calls = [];
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: [],
    providers: {
      commission: async () => { calls.push("commission"); return pack("commission"); },
      logistics_tariff: async () => { calls.push("logistics_tariff"); throw new Error("GUOO规则文件不可读"); },
      exchange_rate: async () => { calls.push("exchange_rate"); return pack("exchange_rate"); },
      schema: async () => { calls.push("schema"); return pack("schema"); }
    },
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["commission", "logistics_tariff"]);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.deepEqual(result.discardedEvidencePackIds, ["PACK-commission"]);
  assert.equal(result.failure.layer, "provider:logistics_tariff");
  assert.equal(result.businessStateEffect, "unchanged");
  assert.equal(result.automaticRetryAttempted, false);
});

test("提供器返回错店铺证据时停止，不用错误范围兜底", async () => {
  const wrong = pack("commission");
  wrong.scope.store = "miska";
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: allPacks().slice(1),
    providers: { commission: async () => wrong },
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.layer, "provider_result:commission");
  assert.match(result.failure.reason, /适用范围不一致/);
  assert.deepEqual(result.evidencePacksToCommit, []);
});

test("证据上下文不完整时零调用并保持商品业务状态不变", async () => {
  const source = candidate();
  delete source.lifecycleEvidenceContextV11.category;
  const before = JSON.stringify(source);
  let called = 0;
  const result = await runLifecycleBEvidencePreparation({
    candidate: source,
    evidencePacks: [],
    providers: { commission: async () => { called += 1; return pack("commission"); } },
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.layer, "evidence_context");
  assert.equal(called, 0);
  assert.equal(JSON.stringify(source), before);
  assert.equal(result.businessStateEffect, "unchanged");
});

test("不同SKU在相同适用范围内复用同一证据包且互不修改", async () => {
  const shared = allPacks();
  const first = await runLifecycleBEvidencePreparation({
    candidate: candidate("SKU-A"), evidencePacks: shared, providers: {}, plannedAt, preparedAt
  });
  const second = await runLifecycleBEvidencePreparation({
    candidate: candidate("SKU-B"), evidencePacks: shared, providers: {}, plannedAt, preparedAt
  });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.deepEqual(first.plan.actions.map((action) => action.evidencePackId), second.plan.actions.map((action) => action.evidencePackId));
  assert.deepEqual(first.providerCalls, []);
  assert.deepEqual(second.providerCalls, []);
});

test("真实读取完成时间由读取后时钟冻结，不要求调用方预猜未来时间", async () => {
  const source = candidate();
  const times = [
    "2026-08-18T02:00:01.000Z",
    "2026-08-18T02:00:02.000Z",
    "2026-08-18T02:00:03.000Z",
    "2026-08-18T02:00:04.000Z",
    "2026-08-18T02:00:05.000Z"
  ];
  let clockIndex = 0;
  const providers = Object.fromEntries(allPacks().map((pack) => [
    pack.kind,
    async () => ({ ...structuredClone(pack), checkedAt: "2026-08-18T02:00:00.500Z" })
  ]));
  const result = await runLifecycleBEvidencePreparation({
    candidate: source,
    evidencePacks: [],
    providers,
    plannedAt: "2026-08-18T02:00:00.000Z",
    clock: () => new Date(times[Math.min(clockIndex++, times.length - 1)])
  });
  assert.equal(result.status, "completed");
  assert.equal(result.evidencePacksToCommit.length, 4);
});

function syntheticWbPreparation() {
  const value=candidate(), evidence=allPacks(); value.targetStore='wb'; value.storeRef.stableStoreId='wb';
  Object.assign(value.lifecycleEvidenceContextV11,{platform:'wb',store:'wb',storeRef:structuredClone(value.storeRef),category:'wb:subject:5267',salesScheme:'fbs'});
  for(const p of evidence.filter(p=>['commission','schema'].includes(p.kind))){
    Object.assign(p.scope,{platform:'wb',store:'wb',storeRef:structuredClone(value.storeRef),category:'wb:subject:5267'});
    if(p.kind==='commission')p.scope.salesScheme='fbs';
  }
  const commission=evidence.find(p=>p.kind==='commission');
  commission.sourceType='wb_official_commission_reference';commission.expiresAt=null;
  commission.commissionCatalogRef={catalogId:'synthetic-catalog',catalogVersion:'v1',sellerRegion:'CN',subjectId:5267,
    sourceField:'kgvpChina',sourceReceiptRef:'synthetic-receipt',effectiveFrom:null};
  const catalogs=[{platform:'wb',sellerRegion:'CN',catalogId:'synthetic-catalog',catalogVersion:'v1',status:'active'}];
  return {candidate:value,evidencePacks:evidence,commission,catalogs};
}

test('WB catalog reuse rechecks current declarations at completion with zero provider calls', async()=>{
  const f=syntheticWbPreparation(), before=structuredClone(f); let reads=0;
  const result=await runLifecycleBEvidencePreparation({...f,plannedAt,preparedAt,getCurrentCommissionCatalogs:()=>{
    reads++;return reads===1?f.catalogs:[{...f.catalogs[0],status:'invalidated'}];
  }});
  assert.equal(result.plan.status,'ready_from_reuse');assert.equal(result.status,'failed');
  assert.equal(result.failure.layer,'reuse_validity_drift');assert.deepEqual(result.providerCalls,[]);
  assert.deepEqual(result.evidencePacksToCommit,[]);assert.deepEqual(f,before);
});

test('WB prepared references survive success but invalidation before final readiness discards them',async()=>{
  for(const invalidate of [false,true]){
    const f=syntheticWbPreparation();let reads=0,calls=0;
    const result=await runLifecycleBEvidencePreparation({...f,evidencePacks:f.evidencePacks.filter(p=>p.kind!=='commission'),plannedAt,preparedAt,
      providers:{commission:async()=>{calls++;return structuredClone(f.commission);}},
      getCurrentCommissionCatalogs:()=>{reads++;return invalidate&&reads>=3?[{...f.catalogs[0],status:'invalidated'}]:f.catalogs;}});
    assert.equal(calls,1);assert.equal(result.status,invalidate?'failed':'completed');
    if(invalidate){assert.equal(result.failure.layer,'final_readiness');assert.deepEqual(result.evidencePacksToCommit,[]);}
    else{assert.equal(result.evidencePacksToCommit[0].expiresAt,null);assert.deepEqual(result.evidencePacksToCommit[0].commissionCatalogRef,f.commission.commissionCatalogRef);}
  }
});

function frozenAOpportunity(price) {
  return {
    lifecycleV11: {
      opportunityPackage: {
        marketAssessment: price === null ? null : { recommendedSalePrice: { amount: price, currency: "RUB", method: "median_of_comparable_primary_samples" } },
        salesSnapshots: []
      }
    }
  };
}

/**
 * 一份能通过 validateSalesSnapshot 的销售快照，只为把 categoryPath 摆到正确的地方：
 * 官方费表的类型名称取的是**这件商品自己保存的销售快照**里那条中文类目树路径，
 * 不是 opportunityPackage 里挑出来做价格判断的市场样本（首次确认时它还不存在）。
 */
function snapshotWithCategory(categoryPath, collectedAt = "2026-08-17T06:30:00.000Z", snapshotId = "SNAP-1") {
  return {
    schemaVersion: "sales-snapshot-v1.1", snapshotId, platform: "ozon", marketScope: "ozon_general_market",
    sellerType: "unknown", sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "fixture:seller" },
    productUrl: "https://www.ozon.ru/product/1234567/", title: "Лежанка", imageRefs: [],
    currentPrice: 2490, currency: "RUB", categoryPath, attributes: {}, collectedAt,
    evidenceRef: "fixture:snapshot", collectorVersion: "real-ozon-sales-snapshot-v1",
    collectorMode: "real_page_read_only", readOnly: true
  };
}

test("官方费表所需的成交价与类型名称只取已冻结结果，未冻结或形状不对时留空不猜测", async () => {
  const chinese = [snapshotWithCategory("宠物用品 > 携带和睡眠配件 > 宠物躺床")];
  const russian = [snapshotWithCategory("Товары для животных > Для кошек > Лежанки")];
  const cases = [
    // 本轮提交带着主人填的成交价时用它；类型名称取中文类目树末段，平台大类一起带上。
    { snapshots: chinese, frozen: {}, submission: { targetSalePriceRub: 2490 },
      expected: { priceRub: 2490, typeName: "宠物躺床", mpCategoryZh: "宠物用品" } },
    // 没有本轮提交时退回A阶段已冻结的建议成交价。
    { snapshots: chinese, frozen: frozenAOpportunity(2490), submission: null,
      expected: { priceRub: 2490, typeName: "宠物躺床", mpCategoryZh: "宠物用品" } },
    // 页面面包屑不是类型树：不拿它去撞表，留空记缺口。
    { snapshots: russian, frozen: frozenAOpportunity(2490), submission: null,
      expected: { priceRub: 2490, typeName: null, mpCategoryZh: null } },
    // 中文类目树必须正好三级，多一级少一级都不算。
    { snapshots: [snapshotWithCategory("宠物用品 > 宠物躺床")], frozen: frozenAOpportunity(2490), submission: null,
      expected: { priceRub: 2490, typeName: null, mpCategoryZh: null } },
    // 两份都在时按 collectedAt 取最新的那份中文类目树快照。
    { snapshots: [snapshotWithCategory("宠物用品 > 旧的分法 > 旧躺床", "2026-08-10T06:30:00.000Z", "SNAP-OLD"), ...chinese],
      frozen: frozenAOpportunity(2490), submission: null,
      expected: { priceRub: 2490, typeName: "宠物躺床", mpCategoryZh: "宠物用品" } },
    // 价格与类型名称都取不到时整份留空。
    { snapshots: [], frozen: {}, submission: null, expected: null },
    { snapshots: [], frozen: frozenAOpportunity(0), submission: null, expected: null },
    { snapshots: [], frozen: {}, submission: { targetSalePriceRub: 0 }, expected: null },
    // 建议成交价不是卢布时不采用。
    { snapshots: [], submission: null, expected: null,
      frozen: { lifecycleV11: { opportunityPackage: { marketAssessment: { recommendedSalePrice: { amount: 2490, currency: "CNY" } }, salesSnapshots: [] } } } }
  ];
  for (const item of cases) {
    const observed = [];
    const providers = Object.fromEntries(allPacks().map((entry) => [
      entry.kind,
      async (request) => { observed.push({ kind: entry.kind, commissionReferenceScope: request.commissionReferenceScope }); return pack(entry.kind); }
    ]));
    const result = await runLifecycleBEvidencePreparation({
      candidate: { ...candidate(), salesSnapshotsV11: item.snapshots, ...item.frozen },
      evidencePacks: [],
      providers,
      plannedAt,
      preparedAt,
      submission: item.submission
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(observed.find((entry) => entry.kind === "commission").commissionReferenceScope, item.expected);
    for (const entry of observed.filter((value) => value.kind !== "commission")) {
      assert.equal(entry.commissionReferenceScope, null, "只有佣金请求携带官方费表查询输入");
    }
  }
});


test("内部24小时提示不触发重复采集，未知来源过期仍需刷新且不改历史", async () => {
  const packs = allPacks();
  for (const value of packs) value.expiresAt = "2026-10-01T06:30:00.000Z";
  const fx = packs.find(value => value.kind === "exchange_rate");
  Object.assign(fx, { checkedAt: plannedAt, expiresAt, sourceType: "bank_of_russia_official_daily_xml",
    sourceRef: "cbr-xml-daily:R01375:2026-08-18", validity: createInternalEvidenceValidity("exchange_rate"),
    evidenceData: { rubPerCny: 12.3, rateDate: "2026-08-18", nominal: 1, officialValueRub: 12.3 } });
  const afterHint = "2026-09-21T08:00:00.000Z";
  const before = structuredClone(packs);
  const plan = buildLifecycleBEvidencePreparationPlan({ candidate: candidate(), evidencePacks: packs, plannedAt: afterHint });
  assert.equal(plan.status, "ready_from_reuse");
  assert.equal(plan.actions.find(value => value.kind === "exchange_rate").currentStatus, "refresh_due");
  let calls = 0;
  const result = await runLifecycleBEvidencePreparation({ candidate: candidate(), evidencePacks: packs, plannedAt: afterHint,
    preparedAt: afterHint, providers: Object.fromEntries(packs.map(value => [value.kind, async () => { calls += 1; throw new Error("must not collect"); }])) });
  assert.equal(result.status, "completed");
  assert.equal(calls, 0);
  assert.deepEqual(packs, before);
  delete fx.validity;
  fx.sourceType = "unknown";
  const blocked = buildLifecycleBEvidencePreparationPlan({ candidate: candidate(), evidencePacks: packs, plannedAt: afterHint });
  assert.equal(blocked.actions.find(value => value.kind === "exchange_rate").action, "prepare_once");
});
