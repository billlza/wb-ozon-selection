import test from "node:test";
import assert from "node:assert/strict";
import { createSavedConditionalBFixture, currentOtherCosts } from "./fixtures/real-a-b-flow-fixture.mjs";
import { prepareSavedConditionalBExactInputs, BExactCommissionRecalculationError } from "../lib/real-a-b-c1-flow.mjs";
import { createBExactCommissionRecalculationUseCase } from "../lib/b-exact-commission-recalculation-use-case.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentActor, createActorContext } from "../lib/runtime-identity.mjs";
import { openExceptionCase } from "../lib/software-execution-state.mjs";
import { inspectLifecycleBInputReadiness } from "../lib/lifecycle-b-input-bundle.mjs";
import { buildBExactCommissionRuntimeView, B_BETTER_COMMISSION_EVIDENCE_LABELS } from "../lib/b-exact-commission-runtime-view.mjs";
import { assertFormalCommissionBeforeProduction, PRODUCTION_EXACT_COMMISSION_REQUIRED } from "../lib/commission-estimate-authorization.mjs";

async function fixture(options = {}) {
  const { candidate, original, document, at } = await createSavedConditionalBFixture(options);
  const repository = createMemoryBusinessStateRepository(document);
  const owner = createActorContext({ userId: "owner-b", sessionId: "owner-session-b", actorType: "human", roles: ["owner"],
    source: "authenticated_identity_provider", authenticatedAt: at });
  const input = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, skuPackageId: original.skuPackage.skuPackageId,
    failureId: "failure:b-exact", idempotencyKey: "b-recalculate:1", auditEventId: "audit:b-recalculate:1" };
  const usecase = createBExactCommissionRecalculationUseCase({ repository, runtimeMode: "local_development", serverClock: () => at });
  return { repository, candidate, original, owner, input, usecase, document, at };
}

test("saved conditional B uses exact evidence once, preserves A and history, and creates one C1 atomically", async () => {
  const f = await fixture();
  const before = await f.repository.readSnapshot();
  const ready = prepareSavedConditionalBExactInputs({ candidate: f.candidate, evidencePacks: before.evidencePacks, otherCosts: currentOtherCosts(f.candidate), processedAt: f.at });
  assert.equal(ready.skuPackage.businessPhase, "B");
  assert.deepEqual(await f.repository.readSnapshot(), before);
  const results = await Promise.all([f.usecase.recalculate({ actor: f.owner, input: f.input }), f.usecase.recalculate({ actor: f.owner, input: f.input })]);
  assert.deepEqual(results.map(item => item.status).sort(), ["committed", "idempotent_replay"]);
  const saved = await f.repository.readSnapshot(), candidate = saved.candidates[0], life = candidate.lifecycleV11;
  assert.equal(results[0].result.status, "passed");
  assert.equal(candidate.dataRevision, f.input.expectedRevision + 1);
  assert.deepEqual(life.opportunityPackage, f.original.opportunityPackage);
  assert.deepEqual(life.ownerSupplyConfirmation, f.original.ownerSupplyConfirmation);
  assert.deepEqual(life.aConfirmationReceipt, before.candidates[0].lifecycleV11.aConfirmationReceipt);
  assert.deepEqual(life.skuPackage.selectedSupplySnapshot, f.original.skuPackage.selectedSupplySnapshot);
  assert.deepEqual(life.skuPackage.profitModels.slice(0, -1), f.original.skuPackage.profitModels);
  assert.equal(life.skuPackage.profitModels.at(-1).calculationType, "formal");
  assert.equal(life.skuPackage.businessPhase, "C1");
  assert.equal(life.c1Handoffs.length, 1);
  assert.equal(candidate.executionRuntime.technicalFailure, null);
  assert.deepEqual(results[0].result.priorTechnicalFailure, before.candidates[0].executionRuntime.technicalFailure);
  assert.deepEqual(results[0].result.priorSystemEvidenceBundle, f.original.systemEvidenceBundle);
  assert.deepEqual(saved.runtime.softwareJobs, []);
  assert.deepEqual(results[0].result.externalAccesses, []);
  assert.equal(saved.runtime.operationAudit.length, 1);
  await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input: { ...f.input, idempotencyKey: "b-recalculate:2", auditEventId: "audit:2" } }), /REVISION_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
  const restartedRepository = createMemoryBusinessStateRepository(saved);
  const restarted = createBExactCommissionRecalculationUseCase({ repository: restartedRepository, runtimeMode: "local_development", serverClock: () => f.at });
  assert.equal((await restarted.recalculate({ actor: f.owner, input: f.input })).status, "idempotent_replay");
  assert.deepEqual(await restartedRepository.readSnapshot(), saved);
});

test("formal rejected recalculation saves a new profit version and no C1", async () => {
  const f = await fixture({ rejected: true });
  const result = await f.usecase.recalculate({ actor: f.owner, input: f.input });
  assert.equal(result.result.status, "rejected");
  const candidate = (await f.repository.readSnapshot()).candidates[0];
  assert.equal(candidate.lifecycleV11.status, "b_rejected");
  assert.equal(candidate.lifecycleV11.skuPackage.profitModels.at(-1).calculationType, "formal");
  assert.equal(candidate.lifecycleV11.skuPackage.c1ProductPlan, null);
  assert.deepEqual(candidate.lifecycleV11.c1Handoffs, []);
  assert.equal(candidate.executionRuntime.technicalFailure, null);
});

test("missing, old, estimated or mismatched evidence and source drift cannot save or advance B", async () => {
  const mutations = [
    d => { d.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution = { status: "unknown_outcome" }; },
    d => { d.candidates[0].lifecycleV11.skuPackage.dHandoff = { status: "queued" }; },
    d => { d.evidencePacks = d.evidencePacks.filter(p => p.kind !== "commission"); },
    d => { d.evidencePacks[0].expiresAt = "2026-08-18T02:30:00.000Z"; },
    d => { d.evidencePacks[0].scope.storeRef.platformStoreId = "wrong-store"; },
    d => { d.evidencePacks[0].evidenceData.commissionEvidenceMode = "estimated"; },
    d => { d.candidates[0].lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.weight.value += 1; },
    d => { d.candidates[0].lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.actualPurchaseCost += 1; },
    d => { d.candidates[0].executionRuntime.technicalFailure.evidenceRefs = ["wrong-ref"]; },
    d => { d.candidates[0].lifecycleV11.ownerSupplyConfirmation.supplierSkuId = "wrong-sku"; },
    d => { const c=d.candidates[0]; c.executionRuntime=openExceptionCase(c.executionRuntime, { exceptionId:"unknown:b", reasonCode:"system_failure", failureLayer:"test", evidenceRefs:["test:unknown"], at:"2026-08-18T02:30:00.000Z" }); }
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    await f.repository.transact(document => { mutate(document); return { document, changed: true, result: null }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input: f.input }), BExactCommissionRecalculationError);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test("closed input and wrong failure identity reject before mutation", async () => {
  const f = await fixture(), before = await f.repository.readSnapshot();
  await assert.rejects(() => f.usecase.recalculate({ actor: createLocalDevelopmentActor({ at: f.at }), input: f.input }), /AUTHENTICATED_OWNER_REQUIRED/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  for (const input of [{ ...f.input, commissionRate: 0 }, { ...f.input, failureId: "other" }, { ...f.input, skuPackageId: "other" }]) {
    await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input }), BExactCommissionRecalculationError);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

 test('exact recalculation uses current transaction rules instead of cached commission costs and preserves frozen history', async () => {
  const baseline = await fixture();
  await baseline.usecase.recalculate({ actor: baseline.owner, input: baseline.input });
  const baselineLife = (await baseline.repository.readSnapshot()).candidates[0].lifecycleV11;
  const f = await fixture();
  const stalePage = await f.repository.readSnapshot();
  await f.repository.transact(document => {
    document.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 8;
    document.evidencePacks.find(pack => pack.kind === 'commission').evidenceData.otherCosts.packagingRmb = 999;
    return { document, changed: true };
  });
  const before = await f.repository.readSnapshot();
  assert.equal(stalePage.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value, 0);
  const result = await f.usecase.recalculate({ actor: f.owner, input: f.input });
  const saved = await f.repository.readSnapshot(), life = saved.candidates[0].lifecycleV11;
  assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.otherCosts.fixedOtherRmb, 8);
  assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.otherCosts.packagingRmb, before.candidates[0].packagingCostRmb);
  assert.equal(Number((baselineLife.skuPackage.profitModels.at(-1).unitProfitRmb - life.skuPackage.profitModels.at(-1).unitProfitRmb).toFixed(2)), 8);
  assert.equal(JSON.stringify(life.skuPackage.profitModels.slice(0, -1)), JSON.stringify(before.candidates[0].lifecycleV11.skuPackage.profitModels));
  for (const field of ['opportunityPackage', 'ownerSupplyConfirmation', 'aConfirmationReceipt']) {
    assert.equal(JSON.stringify(life[field]), JSON.stringify(before.candidates[0].lifecycleV11[field]));
  }
  assert.deepEqual(saved.evidencePacks, before.evidencePacks);
  assert.deepEqual(result.result.externalAccesses, []);
});

test('missing current rules stop exact recalculation atomically despite complete cached otherCosts', async () => {
  for (const [mutate, expectedCode] of [[document => { delete document.rules; }, "B_EVIDENCE_COST_POLICY_INCOMPLETE"], [document => { delete document.rules.ozonDandanshu; }, "B_EVIDENCE_COST_POLICY_INCOMPLETE"], [document => { delete document.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb; }, "B_COST_POLICY_INVALID"]]) {
    const f = await fixture();
    await f.repository.transact(document => { mutate(document); return { document, changed: true }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.usecase.recalculate({ actor: f.owner, input: f.input }), { code: expectedCode });
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

/**
 * 主人第一件真货那一轮定下来的事：复算不再只认「店里实收」。
 *
 * 复算的本意是拿比主人签下的估算更好的证据换掉那一次条件测算。比估算更好的证据有两种——
 * 店里同类目在售商品的实收费率，和主人保存的那一版Ozon官方费率表命中的费率。两种都能形成正式B。
 * 下面三条分别钉：官方费率表能走通、估算仍旧走不通、以及走通之后上架那道闸门照样不放行。
 */
const OFFICIAL_COMMISSION_SHA = "d".repeat(64);

function makeOfficialCommissionPack(document, { commissionRate } = {}) {
  const candidate = document.candidates[0];
  const pack = document.evidencePacks.find(item => item.kind === "commission");
  pack.id = "commission:current:official";
  pack.sourceType = "ozon_official_commission_table";
  pack.sourceRef = `ozon-official-commission:2026-08-01:sha256:${OFFICIAL_COMMISSION_SHA}:le1500`;
  pack.commissionCatalogRef = {
    effectiveFrom: "2026-08-01", fileSha256: OFFICIAL_COMMISSION_SHA,
    sourceUrl: "https://docs.ozon.ru/common/pravila-raboty/komissii/", priceTier: "le1500",
    matchedRow: { typeRu: "Музыкальные шкатулки", typeZh: "音乐盒", mpCategoryZh: "家居用品" }
  };
  pack.evidenceData = {
    ...pack.evidenceData,
    ...(commissionRate === undefined ? {} : { commissionRate }),
    commissionEvidenceMode: "official_reference",
    officialCommissionBinding: { schemaVersion: "ozon-official-commission-binding-v1",
      candidateId: candidate.id, candidateRevision: candidate.dataRevision, priceRub: 1462 },
    estimateAuthorized: false, exactCommissionRequiredAtC: true
  };
  return pack;
}

function makeAuthorizedEstimatePack(document) {
  const candidate = document.candidates[0];
  const pack = document.evidencePacks.find(item => item.kind === "commission");
  pack.id = "commission:current:estimated";
  pack.evidenceData = {
    ...pack.evidenceData,
    commissionEvidenceMode: "estimated",
    estimateAuthorized: true,
    exactCommissionRequiredAtC: true,
    commissionEstimateAuthorization: { schemaVersion: "commission-estimate-authorization-v1",
      candidateId: candidate.id, candidateRevision: candidate.dataRevision,
      authorizationRef: "fixture:b-estimate-current", commissionRate: pack.evidenceData.commissionRate }
  };
  return pack;
}

test("官方费率表命中的费率能让复算走到正式B并创建C1，而上架那道闸门照样不放行", async () => {
  const f = await fixture();
  await f.repository.transact(document => { makeOfficialCommissionPack(document); return { document, changed: true }; });
  const result = await f.usecase.recalculate({ actor: f.owner, input: f.input });
  assert.equal(result.result.status, "passed");
  assert.equal(result.result.commissionEvidenceMode, "official_reference");
  const saved = await f.repository.readSnapshot(), candidate = saved.candidates[0], life = candidate.lifecycleV11;
  assert.equal(life.status, "b_passed_auto_c1");
  assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.commissionEvidenceMode, "official_reference");
  const model = life.skuPackage.profitModels.at(-1);
  assert.equal(model.calculationType, "formal");
  assert.equal(model.commissionMode, "official_reference");
  assert.equal(model.exactCommissionRequiredForFormalB, false);
  assert.equal(life.skuPackage.businessPhase, "C1");
  assert.equal(life.c1Handoffs.length, 1);
  assert.equal(candidate.workflowStatus, "listing_preparation");
  assert.equal(candidate.executionRuntime.technicalFailure, null);
  assert.deepEqual(result.result.externalAccesses, []);
  assert.equal(result.result.platformWrites, 0);
  // 正式佣金类型通过前置检查，生产仍要求当前完整证据。
  assert.equal(assertFormalCommissionBeforeProduction(life.skuPackage).commissionMode, "official_reference");
});

test("同一个费率换成官方费率表来源时，利润数字一个都不许变，只变证据强度", async () => {
  // 主人首件就是这个形状：他签的估算是12%，官方费率表这条类目命中的也是12%。
  // 换来源不换数——利润、利润率必须逐位不动，变的只有 calculationType / commissionMode。
  const baseline = await fixture();
  const conditional = (await baseline.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.profitModels.at(-1);
  assert.equal(conditional.calculationType, "conditional");
  assert.equal(conditional.commissionMode, "estimated");

  const f = await fixture();
  await f.repository.transact(document => {
    makeOfficialCommissionPack(document, { commissionRate: conditional.commissionRate });
    return { document, changed: true };
  });
  await f.usecase.recalculate({ actor: f.owner, input: f.input });
  const formal = (await f.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.profitModels.at(-1);
  assert.equal(formal.commissionRate, conditional.commissionRate);
  assert.equal(formal.unitProfitRmb, conditional.unitProfitRmb);
  assert.equal(formal.profitMargin, conditional.profitMargin);
  assert.equal(formal.calculationType, "formal");
  assert.equal(formal.commissionMode, "official_reference");
});

test("估算佣金仍然不能用来复算：就算证据齐全、绑定当前修订，也只会被那一道闸门挡回去", async () => {
  const f = await fixture();
  await f.repository.transact(document => { makeAuthorizedEstimatePack(document); return { document, changed: true }; });
  const before = await f.repository.readSnapshot();
  // 证据本身是齐的：挡回去的一定是「模式不够好」，不是「读不到证据」。
  const readiness = inspectLifecycleBInputReadiness({ candidate: before.candidates[0],
    evidencePacks: before.evidencePacks, currentCommissionCatalogs: [], asOf: f.at });
  assert.equal(readiness.ready, true);
  await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input: f.input }),
    { code: "B_EXACT_RECALCULATION_EXACT_EVIDENCE_REQUIRED" });
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test("这次复算会用哪一种费用证据，点之前就说得出来", async () => {
  const exact = await fixture();
  const exactSnapshot = await exact.repository.readSnapshot();
  const exactView = buildBExactCommissionRuntimeView({ candidate: exactSnapshot.candidates[0],
    evidencePacks: exactSnapshot.evidencePacks, currentCommissionCatalogs: [], rules: exactSnapshot.rules, observedAt: exact.at });
  assert.equal(exactView.canRecalculate, true);
  assert.equal(exactView.commissionEvidenceMode, "exact");
  assert.equal(exactView.commissionEvidenceLabel, B_BETTER_COMMISSION_EVIDENCE_LABELS.exact);

  const official = await fixture();
  await official.repository.transact(document => { makeOfficialCommissionPack(document); return { document, changed: true }; });
  const officialSnapshot = await official.repository.readSnapshot();
  const officialView = buildBExactCommissionRuntimeView({ candidate: officialSnapshot.candidates[0],
    evidencePacks: officialSnapshot.evidencePacks, currentCommissionCatalogs: [], rules: officialSnapshot.rules, observedAt: official.at });
  assert.equal(officialView.canRecalculate, true);
  assert.equal(officialView.commissionEvidenceMode, "official_reference");
  assert.equal(officialView.commissionEvidenceLabel, B_BETTER_COMMISSION_EVIDENCE_LABELS.official_reference);
  // 说清楚这不是平台实收，免得主人以为可以直接上架。
  assert.match(officialView.message, /不是这个店被扣过的钱/u);
});
