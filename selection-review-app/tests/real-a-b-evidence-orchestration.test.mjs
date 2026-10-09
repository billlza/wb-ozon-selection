import { currentCostRule } from './fixtures/real-a-b-flow-fixture.mjs';
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createMusicBoxCandidate } from "./helpers/legacy-candidate-fixture.mjs";

import { runRealAConfirmationWithSystemEvidence } from "../lib/real-a-b-evidence-orchestration.mjs";
import { inspectLifecycleBInputReadiness } from "../lib/lifecycle-b-input-bundle.mjs";
import { DEFAULT_GUOO_TARIFF_PATH } from "../lib/guoo-tariff-reader.mjs";
import { compareGuooRoutes } from "../lib/guoo-route-comparison.mjs";
import { GLOBAL_PRICING_POLICY_VERSION } from "../lib/global-pricing-policy.mjs";

const confirmedAt = "2026-08-18T09:00:00.000Z";

async function sourceCandidate() {
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  candidate.workflowStatus = "codex_processing";
  candidate.listingHandoff = null;
  candidate.lifecycleEvidenceContextV11 = { ...candidate.lifecycleEvidenceContextV11, salesScheme: "rfbs" };
  return candidate;
}

function confirmation(candidate) {
  return {
    dataRevision: candidate.dataRevision, sourceCandidateId: candidate.id, sourceDataRevision: candidate.dataRevision,
    targetPlatform: "ozon", storeRef: structuredClone(candidate.storeRef),
    decision: "confirm",
    targetSalePriceRub: 2000,
    salesReview: {
      snapshotId: candidate.salesSnapshotsV11[0].snapshotId,
      comparability: "comparable",
      validityStatus: "current",
      confidence: "limited"
    },
    supplierConfirmation: {
      productUrl: "https://detail.1688.com/offer/876240928352.html",
      supplierSkuId: "SKU-SEWING-MACHINE-01",
      variantKey: "手摇缝纫机音乐盒",
      unitProductPrice: 15.3,
      unitDomesticFreight: 2,
      otherPurchaseCosts: 0,
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: true
    }
  };
}

test("缺映射、跨店或修订漂移在任何B提供器调用之前停止", async () => {
  for (const change of [
    (candidate) => { delete candidate.storeRef; },
    (_, input) => { input.storeRef.platformStoreId = "another-store"; },
    (_, input) => { input.storeRef.mappingVersion = "another-version"; },
    (_, input) => { input.sourceDataRevision -= 1; }
  ]) {
    const candidate = await sourceCandidate();
    const input = confirmation(candidate);
    change(candidate, input);
    const before = structuredClone(candidate);
    let calls = 0;
    const providers = new Proxy({}, { get() { calls += 1; throw new Error("unexpected provider access"); } });
    await assert.rejects(() => runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: input, providers, confirmedAt }), /REAL_A_CONFIRMATION_INVALID/);
    assert.equal(calls, 0);
    assert.deepEqual(candidate, before);
  }
});

function evidenceData(kind) {
  if (kind === "commission") return {
    commissionRate: 0.14, commissionEvidenceMode: "exact",
    descriptionCategoryId: 17028743,
    typeId: 971097529,
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
      pricingPolicyVersion: GLOBAL_PRICING_POLICY_VERSION
    }
  };
  if (kind === "logistics_tariff") return {
    chargeableWeightRule: "actual_weight",
    perKgRmb: 20,
    perParcelRmb: 10,
    minimumChargeableWeightKg: 0,
    weightRoundingRule: "none",
    weightRoundingKg: null
  };
  if (kind === "exchange_rate") return { rubPerCny: 12 };
  return {
    schemaRevision: "orchestration-test",
    requiredFields: [],
    descriptionCategoryId: 17028743,
    typeId: 971097529
  };
}

// Explicit synthetic gate allows these existing tests to isolate the downstream
// four-provider/B/C1 workflow. It is not a claim that the adopted workbook is ready.
function syntheticGuooGate() {
  const route = "GUOO Economy Small PUDO";
  const catalog = {
    schemaVersion: "guoo-tariff-catalog-v1", ruleVersion: "guoo-2026-07-20",
    sourceRef: "fixture:synthetic-complete-guoo", observedAt: confirmedAt, sourceNotes: [], unresolvedRules: [],
    rows: [{ rowNumber: 17, route, routeText: route, deliveryMethods: [route], sourceRefs: {}, unresolvedRules: [],
      feeCoverage: { status: "complete", additionalPerParcelRmb: 0, evidenceRef: "fixture:synthetic-fee-coverage" },
      evidenceData: { ...evidenceData("logistics_tariff"), productType: "Small", weightLimit: "0.001-2KG",
        declaredValueLimitRub: "1501-7000₽", sizeLimit: "尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费",
        batteryTransportRule: "可以运输内部装有电池的物品无需提供材料安全性数据表MSDS" } }]
  };
  const selected = catalog.rows[0];
  catalog.rows = Array.from({ length: 15 }, (_, index) => {
    const rowNumber = index + 10;
    if (rowNumber === selected.rowNumber) return selected;
    const excluded = structuredClone(selected);
    excluded.rowNumber = rowNumber;
    excluded.route = `GUOO Synthetic Excluded ${rowNumber} PUDO`;
    excluded.routeText = excluded.route;
    excluded.deliveryMethods = [excluded.route];
    excluded.evidenceData.weightLimit = "3-30KG";
    return excluded;
  });
  return {
    readGuooCatalog: async () => structuredClone(catalog),
    compareGuooRouteCatalog: input => compareGuooRoutes({ ...input,
      cargoFacts: { batteryType: "none", batteryEnergyWh: null, generalCargo: true, personalUse: null,
        irregularShape: null, sourceRef: "fixture:synthetic-cargo-facts" }
    })
  };
}

test("一次A确认会准备四类系统证据并直接完成B到唯一C1，不修改输入", async () => {
  const candidate = await sourceCandidate();
  const before = JSON.stringify(candidate);
  const calls = [];
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => {
      calls.push(kind);
      return {
        id: `orchestration:${kind}`,
        kind,
        status: "active",
        scope: request.scope,
        checkedAt: confirmedAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        sourceType: "isolated_test",
        sourceRef: kind === "logistics_tariff" ? "fixture:synthetic-complete-guoo:row-17" : `fixture:orchestration:${kind}`,
        evidenceData: evidenceData(kind)
      };
    }
  ]));
  const run = await runRealAConfirmationWithSystemEvidence({
    candidate, profitRule: currentCostRule(candidate),
    submission: confirmation(candidate),
    evidencePacks: [],
    providers,
    confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx",
    ...syntheticGuooGate()
  });
  assert.equal(run.status, "completed");
  assert.deepEqual(calls, ["commission", "logistics_tariff", "exchange_rate", "schema"]);
  assert.equal(run.evidencePacksToCommit.length, 4);
  assert.equal(run.result.profitModel.result, "passed");
  assert.equal(run.result.c1Handoff.uniqueOwner, "listing_task");
  const frozenSnapshot = run.result.opportunityPackage.salesSnapshots[0];
  assert.deepEqual(frozenSnapshot.platformCategoryEvidence, {
    status: "verified",
    descriptionCategoryId: 17028743,
    typeId: 971097529,
    categoryToken: "ozon:17028743:971097529",
    sourceProductId: "4403916892",
    sourceSnapshotId: candidate.salesSnapshotsV11[0].snapshotId,
    sourceEvidenceRefs: ["orchestration:commission", "orchestration:schema"],
    verifiedAt: confirmedAt
  });
  assert.equal(frozenSnapshot.attributes.description_category_id, 17028743);
  assert.equal(frozenSnapshot.attributes.type_id, 971097529);
  assert.equal(run.evidenceContext.category, "ozon:17028743:971097529");
  assert.equal(run.result.taskDispatches, 0);
  assert.equal(run.platformWrites, 0);
  assert.equal(JSON.stringify(candidate), before);
});

test("系统证据晚于主人确认时间取得时，按证据冻结时间进入B而不误报四类证据缺失", async () => {
  const candidate = await sourceCandidate();
  const evidenceCheckedAt = new Date(Date.parse(confirmedAt) + 1_000).toISOString();
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => ({
      id: `orchestration:delayed:${kind}`,
      kind,
      status: "active",
      scope: request.scope,
      checkedAt: evidenceCheckedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceType: "isolated_test",
      sourceRef: kind === "logistics_tariff" ? "fixture:synthetic-complete-guoo:row-17" : `fixture:orchestration:delayed:${kind}`,
      evidenceData: evidenceData(kind)
    })
  ]));
  const run = await runRealAConfirmationWithSystemEvidence({
    candidate, profitRule: currentCostRule(candidate),
    submission: confirmation(candidate),
    evidencePacks: [],
    providers,
    confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx",
    ...syntheticGuooGate()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.result.systemEvidenceBundle.createdAt, run.evidencePreparation.finalReadiness.checkedAt);
  assert.ok(Date.parse(run.result.profitModel.calculatedAt) >= Date.parse(evidenceCheckedAt));
  assert.equal(run.result.profitModel.result, "passed");
  assert.equal(run.result.c1Handoff.uniqueOwner, "listing_task");
});

test("主人选择淘汰或提交无效时不会调用任何系统证据提供器", async () => {
  const candidate = await sourceCandidate();
  const providers = new Proxy({}, {
    get() {
      throw new Error("不应读取提供器");
    }
  });
  const rejected = await runRealAConfirmationWithSystemEvidence({
    candidate,
    submission: { ...confirmation(candidate), decision: "reject" },
    evidencePacks: [],
    providers,
    confirmedAt,
    readGuooCatalog: async () => { throw new Error("淘汰不应读表"); }
  });
  assert.equal(rejected.result.decision, "reject");
  assert.deepEqual(rejected.externalAccesses, []);
  await assert.rejects(
    runRealAConfirmationWithSystemEvidence({
      candidate, profitRule: currentCostRule(candidate),
      submission: { dataRevision: candidate.dataRevision, decision: "confirm" },
      evidencePacks: [],
      providers,
      confirmedAt
    }),
    /REAL_A_CONFIRMATION_INVALID/
  );
});

test("已落盘的同一A/B结果重放时不再调用证据提供器或创建第二个C1", async () => {
  const candidate = await sourceCandidate();
  const input = confirmation(candidate);
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => ({
      id: `orchestration:replay:${kind}`,
      kind,
      status: "active",
      scope: request.scope,
      checkedAt: confirmedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceType: "isolated_test",
      sourceRef: kind === "logistics_tariff" ? "fixture:synthetic-complete-guoo:row-17" : `fixture:orchestration:replay:${kind}`,
      evidenceData: evidenceData(kind)
    })
  ]));
  const first = await runRealAConfirmationWithSystemEvidence({
    candidate, profitRule: currentCostRule(candidate),
    submission: input,
    evidencePacks: [],
    providers,
    confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx",
    ...syntheticGuooGate()
  });
  const persisted = structuredClone(candidate);
  persisted.dataRevision += 1;
  persisted.lifecycleEvidenceContextV11 = structuredClone(first.evidenceContext);
  persisted.lifecycleV11 = {
    aConfirmationReceipt: {
      receiptId: first.result.confirmationReceiptId,
      sourceCandidateRevision: first.result.sourceCandidateRevision
    },
    opportunityPackage: structuredClone(first.result.opportunityPackage),
    ownerSupplyConfirmation: structuredClone(first.result.ownerSupplyConfirmation),
    bSystemEvidenceBundle: structuredClone(first.result.systemEvidenceBundle),
    skuPackage: structuredClone(first.result.skuPackage),
    c1Handoffs: [structuredClone(first.result.c1Handoff)]
  };
  let replayCalls = 0;
  const replayProviders = new Proxy({}, { get() { replayCalls += 1; throw new Error("重放不应读取提供器"); } });
  const replay = await runRealAConfirmationWithSystemEvidence({
    candidate: persisted,
    submission: { ...input, sourceDataRevision: persisted.dataRevision, dataRevision: persisted.dataRevision },
    evidencePacks: [],
    providers: replayProviders,
    confirmedAt,
    guooFilePath: "/tmp/unused.xlsx",
    readGuooCatalog: async () => { throw new Error("重放不应读表"); }
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.result.idempotentReplay, true);
  assert.equal(replayCalls, 0);
  assert.equal(replay.evidencePacksToCommit.length, 0);
  assert.equal(replay.result.skuPackage.dataRevision, first.result.skuPackage.dataRevision);
  assert.deepEqual(replay.result.c1Handoff, first.result.c1Handoff);
});

/**
 * 2026-09-14，主人第一件真货（Miska 宠物雨衣）栽在这一条上。
 *
 * A确认把类目冻成平台身份（`ozon:<descriptionCategoryId>:<typeId>`）写进 lifecycleEvidenceContextV11，
 * 可同一次事务提交的佣金和Schema证据还挂在读取时用的那条类目路径上。落盘那一刻这件商品的证据就和
 * 它自己的适用范围对不上了：`inspectLifecycleBInputReadiness` 从此找不到佣金和Schema，
 * 「用更好的费用证据重算」被 B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE 永久挡住，而记录看上去毫无异常。
 *
 * 这一条钉的是那个不变量：服务端照它自己的写法落盘之后（context 存 evidenceContext、
 * 证据存 evidencePacksToCommit），这件商品必须还能找齐它自己的四类证据。
 */
test('类目冻成平台身份之后，落盘的证据仍然属于这件商品自己的适用范围', async () => {
  const candidate = structuredClone(await sourceCandidate());
  // 主人那件真货的形状：页面读回来只有类目路径，description_category_id / type_id 要等平台自己回答。
  // 固定件默认把这两个号预填好了，预填之下适用范围一开始就是平台身份键，这个 bug 根本不会显形。
  for (const snapshot of [...candidate.salesSnapshotsV11, ...(candidate.lifecycleV11?.opportunityPackage?.salesSnapshots ?? [])]) {
    const { description_category_id: _dropId, type_id: _dropType, ...rest } = snapshot.attributes ?? {};
    snapshot.attributes = rest;
  }
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => ({
      id: `orchestration:frozen:${kind}`, kind, status: "active", scope: request.scope, checkedAt: confirmedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceType: "isolated_test",
      sourceRef: kind === "logistics_tariff" ? "fixture:synthetic-complete-guoo:row-17" : `fixture:orchestration:frozen:${kind}`,
      evidenceData: evidenceData(kind)
    })
  ]));
  const run = await runRealAConfirmationWithSystemEvidence({
    candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate),
    evidencePacks: [], providers, confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx", ...syntheticGuooGate()
  });
  assert.equal(run.status, "completed");
  assert.equal(run.evidenceContext.category, "ozon:17028743:971097529");

  // 服务端的 a-confirm 路由就是这样落盘的：适用范围取 evidenceContext，证据取 evidencePacksToCommit。
  const persisted = structuredClone(candidate);
  persisted.dataRevision += 1;
  persisted.lifecycleEvidenceContextV11 = structuredClone(run.evidenceContext);
  const stored = structuredClone(run.evidencePacksToCommit);

  for (const kind of ["commission", "schema"]) {
    const pack = stored.find((item) => item.kind === kind);
    assert.equal(pack.scope.category, run.evidenceContext.category,
      `${kind}证据的类目必须和落盘的适用范围是同一个键`);
  }
  const readiness = inspectLifecycleBInputReadiness({
    candidate: persisted, evidencePacks: stored, currentCommissionCatalogs: [],
    asOf: run.evidencePreparation.finalReadiness.checkedAt
  });
  assert.equal(readiness.ready, true,
    `落盘之后仍应找齐四类证据，实际缺：${readiness.missing.join("、")}`);

  // 冻结后的输入包必须和落盘后的适用范围是同一件事，否则 assertCurrentBCommissionEvidence 会在下一次事务里翻脸。
  assert.equal(run.result.systemEvidenceBundle.context.category, run.evidenceContext.category);
});

test('adopted August 19 workbook stops formal A before providers without inventing target price or cargo facts', async () => {
  const candidate = await sourceCandidate(), before = structuredClone(candidate);
  let providerAccesses = 0;
  const providers = new Proxy({}, { get() { providerAccesses++; throw new Error('No provider may run before route selection'); } });
  const result = await runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: { ...confirmation(candidate), targetSalePriceRub: null },
    providers, confirmedAt: '2026-09-09T04:00:00.000Z', guooFilePath: DEFAULT_GUOO_TARIFF_PATH });
  assert.equal(result.status, 'blocked');
  assert.equal(result.guooRouteComparison.ruleVersion, 'guoo-2026-08-19');
  assert.equal(result.guooRouteComparison.candidateId, candidate.id);
  assert.equal(result.guooRouteComparison.sourceRevision, candidate.dataRevision);
  assert.equal(result.guooRouteComparison.routes.length, 15);
  assert.equal(result.guooRouteComparison.status, 'blocked');
  assert.equal(result.guooRouteComparison.selectedRoute, null);
  assert.deepEqual(result.guooRouteComparison.minimumRoutes, []);
  assert.equal(result.guooRouteComparison.inputSnapshot.salePrice, null);
  assert.equal(result.guooRouteComparison.inputSnapshot.cargoFacts, null);
  assert.ok(result.guooRouteComparison.routes.some(route => route.reasons.some(reason => reason.code === 'SALE_PRICE_REQUIRED')));
  assert.equal(result.evidencePreparation.failure.layer, 'guoo_route_comparison');
  assert.deepEqual(result.evidencePreparation.providerCalls, []);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.deepEqual(result.externalAccesses, []);
  assert.equal(result.evidenceContext, null);
  assert.equal(result.result, null);
  assert.equal(providerAccesses, 0);
  assert.deepEqual(candidate, before);
});

test('local catalogue failure is explicit and cannot start a provider or default route', async () => {
  const candidate = await sourceCandidate(), original = new Error('synthetic unreadable workbook');
  let calls = 0;
  const providers = new Proxy({}, { get() { calls++; throw new Error('No provider'); } });
  await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate), providers, confirmedAt,
    readGuooCatalog: async () => { throw original; } }), error => error === original);
  assert.equal(calls, 0);
});

test('another candidate revision or catalogue cannot supply a route decision', async () => {
  for (const field of ['candidateId', 'sourceRevision', 'catalogSourceRef', 'ruleVersion', 'selectedRoute']) {
    const candidate = await sourceCandidate(), gate = syntheticGuooGate();
    let calls = 0;
    await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate), confirmedAt,
      guooFilePath: '/tmp/GUOO-2026.7.20.xlsx', providers: new Proxy({}, { get() { calls++; throw new Error('No provider'); } }),
      ...gate, compareGuooRouteCatalog: input => {
        const result = gate.compareGuooRouteCatalog(input);
        result[field] = field === 'sourceRevision' ? result[field] + 1 : 'mismatched-source';
        return result;
      } }), /GUOO.*(INVALID|CONFLICT)/);
    assert.equal(calls, 0);
  }
});

test('equal minimum routes remain blocked before providers and never default to one delivery route', async () => {
  const candidate = await sourceCandidate(), gate = syntheticGuooGate();
  let calls = 0;
  const run = await runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate), confirmedAt,
    providers: new Proxy({}, { get() { calls++; throw new Error('No provider for unresolved tie'); } }), ...gate,
    readGuooCatalog: async () => {
      const catalog = await gate.readGuooCatalog();
      const second = structuredClone(catalog.rows.find(row => row.rowNumber === 17));
      second.rowNumber = 16; second.route = 'GUOO Standard Small PUDO'; second.routeText = second.route; second.deliveryMethods = [second.route];
      catalog.rows[catalog.rows.findIndex(row => row.rowNumber === 16)] = second; return catalog;
    }
  });
  assert.equal(run.status, 'blocked');
  assert.equal(run.guooRouteComparison.status, 'compared');
  assert.equal(run.guooRouteComparison.minimumRoutes.length, 2);
  assert.equal(run.guooRouteComparison.selectedRoute, null);
  assert.equal(run.result, null); assert.equal(run.evidenceContext, null);
  assert.match(run.evidencePreparation.failure.reason, /并列/);
  assert.equal(calls, 0);
});

test('a valid comparison for different packaging cannot replace the current owner submission', async () => {
  const candidate = await sourceCandidate(), gate = syntheticGuooGate();
  let calls = 0;
  await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate), confirmedAt,
    providers: new Proxy({}, { get() { calls++; throw new Error('No provider'); } }), ...gate,
    compareGuooRouteCatalog: input => gate.compareGuooRouteCatalog({ ...input, packaging: { ...input.packaging, weightKg: 0.2 } })
  }), /REAL_A_GUOO_PACKAGING_CONFLICT/);
  assert.equal(calls, 0);
});

test('unsupported WB branch stops before any local GUOO or provider access', async () => {
  const candidate = await sourceCandidate(); candidate.targetStore = 'wb'; candidate.targetPlatform = 'wb';
  candidate.storeRef = { ...SYNTHETIC_STORE_REF, stableStoreId: 'wb' };
  const input = { ...confirmation(candidate), targetPlatform: 'wb' };
  let reads = 0, calls = 0;
  await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, submission: input, confirmedAt,
    readGuooCatalog: async () => { reads++; throw new Error('No GUOO read'); },
    providers: new Proxy({}, { get() { calls++; throw new Error('No provider'); } })
  }), /B_EVIDENCE_CONTEXT_PLATFORM_UNSUPPORTED/);
  assert.equal(reads, 0); assert.equal(calls, 0);
});

for (const mismatch of ['source', 'tariff', 'additional-fee']) {
  test(`formal B cannot consume logistics ${mismatch} inconsistent with complete selected-route comparison`, async () => {
    const candidate = await sourceCandidate(), before = structuredClone(candidate), gate = syntheticGuooGate();
    const providers = Object.fromEntries(['commission', 'logistics_tariff', 'exchange_rate', 'schema'].map(kind => [kind, async request => {
      const data = evidenceData(kind);
      if (kind === 'logistics_tariff' && mismatch === 'tariff') data.perParcelRmb += 1;
      return { id: `orchestration:mismatch:${kind}`, kind, status: 'active', scope: request.scope,
        checkedAt: confirmedAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), sourceType: 'isolated_test',
        sourceRef: kind === 'logistics_tariff' ? mismatch === 'source' ? 'fixture:another-guoo-source:row-17' :
          'fixture:synthetic-complete-guoo:row-17' : `fixture:mismatch:${kind}`, evidenceData: data };
    }]));
    await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate), providers, confirmedAt,
      guooFilePath: '/tmp/GUOO-2026.7.20.xlsx', ...gate, readGuooCatalog: async () => {
        const catalog = await gate.readGuooCatalog();
        if (mismatch === 'additional-fee') catalog.rows.find(row => row.rowNumber === 17).feeCoverage.additionalPerParcelRmb = 1;
        return catalog;
      }
    }), /GUOO_FULL_FREIGHT_BINDING_REQUIRED/);
    assert.deepEqual(candidate, before);
    assert.equal(candidate.lifecycleV11, undefined);
  });
}


test('five owner inputs quote the adopted table and recommend Economy Small without releasing formal B', async () => {
  const candidate = await sourceCandidate(), before = structuredClone(candidate);
  const submission = confirmation(candidate);
  submission.supplierConfirmation.weightKg = 1;
  submission.supplierConfirmation.dimensionsCm = { length: 20, width: 20, height: 8 };
  let providerAccesses = 0;
  const run = await runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission,
    providers: new Proxy({}, { get() { providerAccesses++; throw new Error('No provider before transport verification'); } }),
    confirmedAt: '2026-09-09T04:00:00.000Z', guooFilePath: DEFAULT_GUOO_TARIFF_PATH });
  const comparison = run.guooRouteComparison;
  assert.equal(comparison.status, 'compared');
  assert.equal(comparison.quoteScope, 'realfbs_main_table');
  assert.equal(comparison.routes.length, 15);
  assert.deepEqual(comparison.routes.filter(row => [15, 16, 17].includes(row.rowNumber))
    .map(row => [row.route, row.totalFreightRmb]),
    [['GUOO Express Small', 68.47], ['GUOO Standard Small', 57.27], ['GUOO Economy Small', 46.07]]);
  assert.equal(comparison.selectedRoute, 'GUOO Economy Small');
  assert.equal(comparison.selectedRouteLabel, '经济轻小件');
  assert.equal(comparison.transportVerified, false);
  assert.deepEqual(comparison.inputSnapshot.salePrice, { amountRub: 2000,
    sourceRef: `a-confirmation:${candidate.id}:${candidate.dataRevision}:target-sale-price-rub` });
  assert.equal(comparison.inputSnapshot.cargoFacts, null);
  const selected = comparison.routes.find(row => row.rowNumber === 17);
  assert.equal(selected.quoteEligibility, 'eligible');
  assert.equal(selected.eligibility, 'unknown');
  assert.ok(selected.deliveryMethods.some(method => method.includes('PUDO')));
  assert.ok(selected.deliveryMethods.some(method => method.includes('Courier')));
  assert.equal(run.status, 'blocked');
  assert.equal(run.evidencePreparation.failure.layer, 'guoo_route_comparison');
  assert.match(run.evidencePreparation.failure.reason, /表内推荐/);
  assert.equal(run.result, null);
  assert.equal(run.evidenceContext, null);
  assert.deepEqual(run.evidencePacksToCommit, []);
  assert.deepEqual(run.externalAccesses, []);
  assert.equal(providerAccesses, 0);
  assert.deepEqual(candidate, before);
});

test('comparison cannot replace the current owner target price or its source', async () => {
  for (const change of [price => ({ ...price, amountRub: 2500 }), price => ({ ...price, sourceRef: 'fixture:other-owner-price' })]) {
    const candidate = await sourceCandidate(), gate = syntheticGuooGate();
    let calls = 0;
    await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, profitRule: currentCostRule(candidate), submission: confirmation(candidate), confirmedAt,
      providers: new Proxy({}, { get() { calls++; throw new Error('No provider'); } }), ...gate,
      compareGuooRouteCatalog: input => gate.compareGuooRouteCatalog({ ...input, salePrice: change(input.salePrice) })
    }), /REAL_A_GUOO_SALE_PRICE_CONFLICT/);
    assert.equal(calls, 0);
  }
});

test('unknown or missing current cost policy stops A before any evidence provider', async () => {
  for (const mode of ['missing', 'unknown', 'included_in_settlement']) {
    const candidate = await sourceCandidate();
    const profitRule = currentCostRule(candidate);
    if (mode === 'missing') delete profitRule.costPolicySnapshot;
    else {
      profitRule.costPolicySnapshot.items.withdrawalFeeRate = {
        status: mode, value: null, basis: 'target_price_cny_rate',
        evidenceRef: 'fixture:unverified-withdrawal', includedIn: mode === 'included_in_settlement' ? 'seller_settlement' : null
      };
    }
    let providerAccesses = 0;
    const providers = new Proxy({}, { get() { providerAccesses++; throw new Error('Unexpected provider access'); } });
    const before = JSON.stringify(candidate);
    const code = { missing: 'B_COST_POLICY_INVALID', unknown: 'B_COST_POLICY_UNKNOWN',
      included_in_settlement: 'B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS' }[mode];
    await assert.rejects(runRealAConfirmationWithSystemEvidence({ candidate, profitRule, submission: confirmation(candidate),
      evidencePacks: [], providers, confirmedAt, guooFilePath: '/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx',
      ...syntheticGuooGate() }), { code });
    assert.equal(providerAccesses, 0);
    assert.equal(JSON.stringify(candidate), before);
  }
});
