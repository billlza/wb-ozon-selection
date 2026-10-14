import { currentOtherCosts } from './fixtures/real-a-b-flow-fixture.mjs';
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runRealAConfirmationToBAndC1, assertCurrentBCommissionEvidence } from "../lib/real-a-b-c1-flow.mjs";
import { buildRealAConfirmationCard } from "../lib/real-a-confirmation-card.mjs";

import { confirmedAt, candidate, submission, evidencePacks, addEvidenceContext } from "./fixtures/real-a-b-flow-fixture.mjs";

test("真实A一次确认原子生成Opportunity、SKU、B利润和唯一C1交接", async () => {
  const source = addEvidenceContext(await candidate());
  const before = JSON.stringify(source);
  const card = buildRealAConfirmationCard(source);
  const result = runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: submission(card),
    evidencePacks: evidencePacks(),
    confirmedAt
  });

  assert.equal(result.decision, "confirm");
  assert.equal(result.opportunityPackage.businessResult, "passed");
  assert.equal(result.ownerSupplyConfirmation.status, "confirmed");
  assert.equal(result.skuPackage.supplierSkuId, "SKU-SEWING-MACHINE-01");
  assert.equal(result.profitModel.result, "passed");
  assert.equal(result.profitModel.thresholdVersion, "profit-threshold-v1.2-15pct-or-20cny");
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(result.c1Handoff.trigger, "b_passed_auto_c1");
  assert.equal(result.c1Handoff.uniqueOwner, "listing_task");
  assert.equal(result.c1Handoff.selectionTaskStopped, true);
  assert.equal(result.c1Handoff.skuPackageId, result.skuPackage.skuPackageId);
  assert.equal(result.c1Handoff.inheritedSkuRevision, result.skuPackage.dataRevision);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.taskDispatches, 0);
  assert.deepEqual(result.externalAccesses, []);
  assert.equal(result.platformWrites, 0);
  assert.equal(JSON.stringify(source), before);
});

test("系统B证据不齐时整轮拒绝且不产生半成品生命周期", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const before = JSON.stringify(source);
  assert.throws(() => runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: submission(card),
    evidencePacks: evidencePacks().slice(0, 1),
    confirmedAt
  }), /REAL_A_SYSTEM_EVIDENCE_GAP.*国际物流.*汇率.*Schema/);
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.lifecycleV11?.skuPackage, undefined);
});

test("B未达利润门槛时不创建C1交接", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const evidence = evidencePacks({ logistics: { perParcelRmb: 105 } });
  const result = runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: submission(card),
    evidencePacks: evidence,
    confirmedAt
  });
  assert.equal(result.profitModel.result, "rejected");
  assert.equal(result.skuPackage.businessPhase, "B");
  assert.equal(result.skuPackage.c1ProductPlan, null);
  assert.equal(result.c1Handoff, null);
  assert.equal(result.uniqueOwner, "none");
});

test("A供货确认保留，估算佣金无论数值高低均不形成正式B或C1", async () => {
  for (const perParcelRmb of [18, 105]) {
    const source = addEvidenceContext(await candidate());
    const before = JSON.stringify(source);
    const packs = evidencePacks({ logistics: { perParcelRmb } });
    Object.assign(packs[0].evidenceData, {
      commissionEvidenceMode: "estimated", estimateAuthorized: true,
      commissionEstimateAuthorization: {
        schemaVersion: "commission-estimate-authorization-v1", candidateId: source.id,
        candidateRevision: source.dataRevision, authorizationRef: "fixture:owner-commission-estimate",
        commissionRate: packs[0].evidenceData.commissionRate
      }
    });
    const result = runRealAConfirmationToBAndC1({
      candidate: source, otherCosts: currentOtherCosts(source), submission: submission(buildRealAConfirmationCard(source)), evidencePacks: packs, confirmedAt
    });
    assert.equal(result.ownerSupplyConfirmation.status, "confirmed");
    assert.equal(result.profitModel.result, "manual_review");
    assert.equal(result.profitModel.calculationType, "conditional");
    assert.equal(result.skuPackage.businessResult, "manual_review");
    assert.equal(result.skuPackage.businessPhase, "B");
    assert.equal(result.skuPackage.c1ProductPlan, null);
    assert.equal(result.c1Handoff, null);
    assert.equal(result.platformWrites, 0);
    assert.equal(result.taskDispatches, 0);
    assert.deepEqual(result.externalAccesses, []);
    assert.equal(JSON.stringify(source), before);
  }
});

test("同一A确认结果落盘后重放保持SKU、利润版本、修订号和唯一C1交接不变", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const input = submission(card);
  const first = runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: input,
    evidencePacks: evidencePacks(),
    confirmedAt
  });
  const persisted = structuredClone(source);
  persisted.dataRevision += 1;
  persisted.lifecycleV11 = {
    schemaVersion: "product-lifecycle-v1.1",
    status: "b_passed_auto_c1",
    aConfirmationReceipt: {
      receiptId: first.confirmationReceiptId,
      decision: "confirm",
      sourceCandidateRevision: first.sourceCandidateRevision,
      confirmedAt
    },
    opportunityPackage: structuredClone(first.opportunityPackage),
    ownerSupplyConfirmation: structuredClone(first.ownerSupplyConfirmation),
    bSystemEvidenceBundle: structuredClone(first.systemEvidenceBundle),
    skuPackage: structuredClone(first.skuPackage),
    c1Handoffs: [structuredClone(first.c1Handoff)]
  };
  const replay = runRealAConfirmationToBAndC1({
    candidate: persisted,
    submission: { ...input, sourceDataRevision: persisted.dataRevision, dataRevision: persisted.dataRevision },
    evidencePacks: evidencePacks(),
    confirmedAt
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.skuPackage.skuPackageId, first.skuPackage.skuPackageId);
  assert.equal(replay.skuPackage.dataRevision, first.skuPackage.dataRevision);
  assert.deepEqual(replay.skuPackage.profitModels, first.skuPackage.profitModels);
  assert.deepEqual(replay.c1Handoff, first.c1Handoff);
  assert.equal(replay.taskDispatches, 0);
  for (const mutate of [
    value => { value.lifecycleV11.skuPackage.g1Identity.storeRef.platformStoreId = "another"; },
    value => { value.lifecycleV11.bSystemEvidenceBundle.context.storeRef.mappingVersion = "another"; },
    value => { delete value.lifecycleV11.bSystemEvidenceBundle.context.storeRef; },
    value => { delete value.lifecycleV11.bSystemEvidenceBundle; },
    value => { delete value.lifecycleV11.aConfirmationReceipt.sourceCandidateRevision; }
  ]) {
    const stale = structuredClone(persisted); mutate(stale);
    const before = structuredClone(stale);
    assert.throws(() => runRealAConfirmationToBAndC1({ candidate: stale,
      submission: { ...input, sourceDataRevision: stale.dataRevision, dataRevision: stale.dataRevision }, evidencePacks: [], confirmedAt }), /EXISTING_LIFECYCLE_INVALID|SYSTEM_EVIDENCE_GAP/);
    assert.deepEqual(stale, before);
  }
});

test("已有生命周期与重复A输入不一致时拒绝而不产生第二利润版本或C1", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const first = runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source), submission: submission(card), evidencePacks: evidencePacks(), confirmedAt });
  source.lifecycleV11 = {
    aConfirmationReceipt: { receiptId: first.confirmationReceiptId, sourceCandidateRevision: first.sourceCandidateRevision },
    opportunityPackage: structuredClone(first.opportunityPackage),
    ownerSupplyConfirmation: structuredClone(first.ownerSupplyConfirmation),
    bSystemEvidenceBundle: structuredClone(first.systemEvidenceBundle),
    skuPackage: structuredClone(first.skuPackage),
    c1Handoffs: [structuredClone(first.c1Handoff)]
  };
  const changed = submission(card);
  changed.supplierConfirmation.variantKey = "另一个SKU";
  assert.throws(() => runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source), submission: changed, evidencePacks: evidencePacks(), confirmedAt }), /ALREADY_CONFIRMED_CONFLICT/);
});


function wbFinalCommissionFixture() {
  const pack = structuredClone(evidencePacks().find(value => value.kind === "commission"));
  pack.scope = { ...pack.scope, platform: "wb", store: "wb", storeRef: { ...pack.scope.storeRef, stableStoreId: "wb" }, category: "wb:subject:5267", salesScheme: "fbs" };
  pack.sourceType = "wb_official_commission_reference"; pack.expiresAt = null;
  pack.commissionCatalogRef = { catalogId: "synthetic-wb-catalog", catalogVersion: "synthetic-version-1", sellerRegion: "CN",
    subjectId: 5267, sourceField: "kgvpChina", sourceReceiptRef: "synthetic-official-receipt", effectiveFrom: null };
  const bundle = { context: structuredClone(pack.scope), platformFeeEvidence: { evidenceId: pack.id,
    commissionRate: pack.evidenceData.commissionRate, commissionEvidenceMode: "exact", commissionCatalogRef: structuredClone(pack.commissionCatalogRef) } };
  const catalogs = [{ platform: "wb", sellerRegion: "CN", catalogId: "synthetic-wb-catalog", catalogVersion: "synthetic-version-1", status: "active" }];
  return { pack, bundle, catalogs };
}

test("B提交最终检查读取最新WB目录，拒绝准备后失效或换版并保持冻结历史不变", () => {
  const f = wbFinalCommissionFixture();
  const original = JSON.stringify(f);
  const input = { bundle: f.bundle, evidencePacks: [f.pack], currentCommissionCatalogs: f.catalogs, asOf: confirmedAt };
  assert.equal(assertCurrentBCommissionEvidence(input), undefined);
  for (const [catalogs, code] of [[[{ ...f.catalogs[0], status: "invalidated" }], "B_COMMISSION_CATALOG_INVALIDATED"],
    [[{ ...f.catalogs[0], catalogVersion: "replacement" }], "B_COMMISSION_CATALOG_VERSION_MISMATCH"],
    [[], "B_COMMISSION_CATALOG_MISSING"]]) {
    assert.throws(() => assertCurrentBCommissionEvidence({ ...input, currentCommissionCatalogs: catalogs }), error => error.code === code);
  }
  assert.equal(JSON.stringify(f), original);
});

test("B最终检查拒绝缺包、重复ID、同ID换包或跨平台来源", () => {
  const f = wbFinalCommissionFixture();
  const input = { bundle: f.bundle, evidencePacks: [f.pack], currentCommissionCatalogs: f.catalogs, asOf: confirmedAt };
  assert.throws(() => assertCurrentBCommissionEvidence({ ...input, evidencePacks: [] }), error => error.code === "B_COMMISSION_EVIDENCE_MISSING");
  assert.throws(() => assertCurrentBCommissionEvidence({ ...input, evidencePacks: [f.pack, f.pack] }), error => error.code === "B_COMMISSION_EVIDENCE_AMBIGUOUS");
  for (const change of [pack => { pack.scope.platform = "ozon"; }, pack => { pack.evidenceData.commissionRate = 0.99; },
    pack => { pack.commissionCatalogRef.catalogVersion = "replacement"; }]) {
    const changed = structuredClone(f.pack); change(changed);
    assert.throws(() => assertCurrentBCommissionEvidence({ ...input, evidencePacks: [changed] }), error => error.code === "B_COMMISSION_SOURCE_CONFLICT");
  }
});

 test('shared commission and schema never carry one SKU packaging cost into another SKU profit', async () => {
  const shared = evidencePacks(), before = JSON.stringify(shared), results = [];
  for (const [id, packagingCostRmb] of [['synthetic-packaging-a', 1.5], ['synthetic-packaging-b', 9.5]]) {
    const source = addEvidenceContext(await candidate()); Object.assign(source, { id, packagingCostRmb });
    results.push(runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source),
      submission: submission(buildRealAConfirmationCard(source)), evidencePacks: shared, confirmedAt }));
  }
  assert.deepEqual(results.map(result => result.systemEvidenceBundle.platformFeeEvidence.otherCosts.packagingRmb), [1.5, 9.5]);
  assert.equal(Number((results[0].profitModel.unitProfitRmb - results[1].profitModel.unitProfitRmb).toFixed(2)), 8);
  assert.equal(results[0].systemEvidenceBundle.platformFeeEvidence.evidenceId, results[1].systemEvidenceBundle.platformFeeEvidence.evidenceId);
  assert.equal(results[0].systemEvidenceBundle.platformSchemaEvidence.evidenceId, results[1].systemEvidenceBundle.platformSchemaEvidence.evidenceId);
  assert.equal(JSON.stringify(shared), before);
  assert.ok(results.every(result => result.externalAccesses.length === 0));
});

/**
 * 主人 2026-09-14 的决定是「把钱的闸门从文案素材挪到上架」。上架那道闸门已经加好了
 * （lib/commission-estimate-authorization.mjs 的 assertFormalCommissionBeforeProduction，由
 * commitSingleOwnerProductionAuthorization 在原子事务里调用）。放行 C1 这一半没有做，这条测试把「为什么还没做」
 * 钉成可执行的事实，而不是一句写在报告里的话。
 *
 * 一、真正拦住 C1 的不是 HTTP 路由里那一行触发条件，是 lib/c1-product-plan.mjs 里
 *     `activeProfitModel.commissionMode !== "exact"` 那一道。放行判据本身已经说这件商品够格了。
 * 二、可是 C1 只要往这件商品上写第一笔，「使用精确费用复算」那条出路当场就没了：写一次把 dataRevision 顶高
 *     一格，而 prepareSavedConditionalBExactInputs 把失败记录和运行时的修订号钉死在当前版本上。
 *
 * 所以谁要放行 C1，必须连着把第二条一起解决（参考 lib/final-pricing-revalidation.mjs 的做法：拿一份工作副本
 * 临时置回 B 阶段再算）。在那之前，这条测试红了就说明 C1 被放行了而出路没跟上。
 */
test("放行C1之前，精确佣金复算必须先活得过C1的第一次落盘", async () => {
  const { createSavedConditionalBFixture } = await import("./fixtures/real-a-b-flow-fixture.mjs");
  const { createMemoryBusinessStateRepository } = await import("../lib/business-state-repository.mjs");
  const { runC1KeywordPlanningEvidenceProduction } = await import("../lib/c1-keyword-planning-software-use-case.mjs");
  const { createActorContext } = await import("../lib/runtime-identity.mjs");
  const { buildBExactCommissionRuntimeView } = await import("../lib/b-exact-commission-runtime-view.mjs");
  const { createC1ProductPlan } = await import("../lib/c1-product-plan.mjs");
  const { resolveConditionalCommissionRelease } = await import("../lib/commission-estimate-authorization.mjs");

  const fixture = await createSavedConditionalBFixture();
  const lifecycle = fixture.candidate.lifecycleV11;
  const sku = lifecycle.skuPackage;
  const model = sku.profitModels.at(-1);

  // 放行判据说这件商品够格：条件测算只因为佣金是估算的，利润门槛、市场判定、异常记录三道全过。
  assert.equal(resolveConditionalCommissionRelease({ profitModel: model,
    executionRuntime: fixture.candidate.executionRuntime }).conditionalOnEstimatedCommissionOnly, true);
  // 拦住它的是 createC1ProductPlan 里那两道，不是 HTTP 路由里那一行触发条件。两道分开钉：
  // 任何一道被放开，这里就要红，好让放开它的人同时看见下面那半段。
  const plan = skuPackage => createC1ProductPlan({ opportunityPackage: lifecycle.opportunityPackage, skuPackage,
    platformSchemaEvidence: lifecycle.bSystemEvidenceBundle.platformSchemaEvidence, createdAt: fixture.at });
  // 第一道：条件测算的 SKU 结论是 manual_review，不是 passed。
  assert.throws(() => plan(sku), /^Error: C1_GATE_REJECTED: B阶段未通过或未完成$/u);
  // 第二道：就算把结论换成 passed，佣金还是估算的，仍然进不去。
  // （这道闸门认两种正式B佣金：exact 与 official_reference。estimated 不在其中，照旧拦住。）
  assert.throws(() => plan({ ...structuredClone(sku), businessResult: "passed" }),
    /^Error: C1_GATE_REJECTED: 正式B必须先取得精确佣金或官方费表费率，估算或历史利润记录不得进入C1$/u);

  // 出路现在是通的。
  const repository = createMemoryBusinessStateRepository({ meta: { version: 2 }, ...fixture.document });
  const runtimeView = candidate => buildBExactCommissionRuntimeView({ candidate, evidencePacks: fixture.evidencePacks,
    currentCommissionCatalogs: [], rules: fixture.document.rules, observedAt: fixture.at });
  const before = (await repository.readSnapshot()).candidates[0];
  assert.equal(runtimeView(before).canRecalculate, true);
  assert.equal(runtimeView(before).status, "ready");

  // C1 往这件商品上写的第一笔——连最无害的那一笔（「这件还没有 C1 包」的准备度记录）——就足以关掉它。
  await runC1KeywordPlanningEvidenceProduction({ repository, runtimeMode: "local_development",
    actor: createActorContext({ userId: "selection-review-software", sessionId: `c1-planning:${before.id}`,
      actorType: "software", roles: ["operator"], source: "selection_review_state_machine", authenticatedAt: fixture.at }),
    candidateId: before.id, expectedRevision: before.dataRevision, producedAt: fixture.at, codexOffline: true });
  const after = (await repository.readSnapshot()).candidates[0];
  assert.equal(after.dataRevision, before.dataRevision + 1);
  assert.equal(runtimeView(after).canRecalculate, false);
  assert.equal(runtimeView(after).blockReason, "B_EXACT_RECALCULATION_NOT_AVAILABLE");
});

// 1688 详情页采到的商品级属性，2026-09-17 之前**一项都没进冻结快照**：material 被写死成 unknown，
// attributes 里只有两个内部记账对象。下面三条钉住修法，尤其第三条——品牌不能变成「已确认事实」。
function withCapturedAttributes(source, attributes) {
  return { ...source, sourceCapture: { ...(source.sourceCapture || {}), supplierAttributes: attributes } };
}

function confirmWith(source) {
  const card = buildRealAConfirmationCard(source);
  return runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source), submission: submission(card),
    evidencePacks: evidencePacks(), confirmedAt
  });
}

test("1688 采到的商品级属性进入冻结供货快照，面料成为材质", async () => {
  const source = withCapturedAttributes(addEvidenceContext(await candidate()),
    { "面料": "牛津布", "产品类别": "作训服", "尺码": "均码", "功能": "", "重量": "   ", "颜色": 5 });
  const sku = confirmWith(source).skuPackage.selectedSupplySnapshot.supplierSku;
  assert.equal(sku.material, "牛津布", "页面采到面料就不该再回 unknown");
  for (const empty of ["功能", "重量", "颜色"]) {
    assert.equal(Object.hasOwn(sku.attributes, empty), false, `空值或非字符串不能冒充已确认事实：${empty}`);
  }
  assert.equal(sku.attributes["产品类别"], "作训服");
  assert.equal(sku.attributes["尺码"], "均码");
  assert.ok(sku.attributes.purchaseCostComponents, "原有的内部记账对象不能被挤掉");
});

test("采不到属性时照旧回 unknown，不替主人猜一个", async () => {
  const source = addEvidenceContext(await candidate());
  const sku = confirmWith(source).skuPackage.selectedSupplySnapshot.supplierSku;
  assert.equal(sku.material, "unknown");
});

test("1688 写的品牌绝不进冻结事实：主人自己签的品牌声明才是唯一权威", async () => {
  const source = withCapturedAttributes(addEvidenceContext(await candidate()),
    { "品牌": "WOSPORT", "有可授权的自有品牌": "否", "面料": "牛津布" });
  const sku = confirmWith(source).skuPackage.selectedSupplySnapshot.supplierSku;
  assert.equal(Object.hasOwn(sku.attributes, "品牌"), false, "1688 卖家把品牌当款式名写，不能当成已确认事实");
  assert.equal(Object.hasOwn(sku.attributes, "有可授权的自有品牌"), false);
  assert.equal(JSON.stringify(sku).includes("WOSPORT"), false);
  assert.equal(sku.material, "牛津布", "排除品牌不该连累其他属性");
});
