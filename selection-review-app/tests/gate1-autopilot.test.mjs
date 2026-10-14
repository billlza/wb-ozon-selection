import test from "node:test";
import assert from "node:assert/strict";
import {
  GATE1_AUTOPILOT_ACTOR_SOURCE, GATE1_AUTOPILOT_ACTOR_USER_ID, buildGate1AutopilotGrant, debitGate1PublicRead, gate1AutopilotFailure,
  gate1AutopilotGrantCurrent, gate1AutopilotMayAct, gate1AutopilotRecordAfterRun, isGate1AutopilotActor, planGate1Autopilot
} from "../lib/gate1-autopilot.mjs";

const AT = "2026-10-11T10:00:00.000Z";
const decision = { decision: "accept", decidedAt: AT, roundIndex: 0 };
const softwareActor = { schemaVersion: "actor-context-v1", userId: GATE1_AUTOPILOT_ACTOR_USER_ID, actorType: "software",
  roles: ["operator"], source: GATE1_AUTOPILOT_ACTOR_SOURCE };

function product({ phase = "C1", planStatus = "inputs_ready", lifecycle = {}, sku = {}, granted = true, extra = {} } = {}) {
  const candidate = {
    id: "cand-1", dataRevision: 7, workflowStatus: "listing_preparation", gate1DecisionV1: decision,
    lifecycleV11: { status: "b_passed_auto_c1", skuPackage: { skuPackageId: "sku-1", targetPlatform: "ozon", businessPhase: phase,
      dataRevision: 3, c1ProductPlan: { status: planStatus }, ...sku }, ...lifecycle },
    ...extra
  };
  if (granted) candidate.gate1AutopilotGrantV1 = buildGate1AutopilotGrant({ candidateId: "cand-1", sourceRevision: 2, decision,
    via: "gate1_accept", grantedAt: AT, grantedBy: "owner" });
  return candidate;
}

const material = (status, extra = {}) => ({ schemaVersion: "c1-local-preparation-v2", resultCandidateRevision: 7, sourceSkuRevision: 3,
  materialFingerprint: "fp", status, gaps: [], ...extra });

test("做这件那一下发的许可绑在那一次决定上：重开一轮、淘汰、同款各色成员都不再算数", () => {
  const candidate = product();
  assert.equal(gate1AutopilotGrantCurrent(candidate), true);
  assert.equal(gate1AutopilotGrantCurrent({ ...candidate, gate1DecisionV1: null }), false);
  assert.equal(gate1AutopilotGrantCurrent({ ...candidate, gate1DecisionV1: { ...decision, decidedAt: "2026-10-12T00:00:00.000Z" } }), false);
  assert.equal(gate1AutopilotGrantCurrent({ ...candidate, workflowStatus: "eliminated" }), false);
  assert.equal(gate1AutopilotGrantCurrent({ ...candidate, siblingSourceV1: { parentCandidateId: "p" } }), false);
  assert.throws(() => buildGate1AutopilotGrant({ candidateId: "c", sourceRevision: 1, via: "gate1_accept", grantedAt: AT }),
    /GATE1_AUTOPILOT_GRANT_DECISION_REQUIRED/);
  // 许可编号里不能出现会被当成密钥的字样。
  assert.doesNotMatch(JSON.stringify(candidate.gate1AutopilotGrantV1), /authorization:/u);
});

test("老商品没有关口 1 记录时，许可绑在当时的 SKU 包上；换了 SKU 包就失效", () => {
  const candidate = product({ granted: false, extra: { gate1DecisionV1: undefined } });
  candidate.gate1AutopilotGrantV1 = buildGate1AutopilotGrant({ candidateId: "cand-1", sourceRevision: 7,
    skuPackageId: "sku-1", via: "owner_continue", grantedAt: AT, grantedBy: "owner" });
  assert.equal(gate1AutopilotGrantCurrent(candidate), true);
  candidate.lifecycleV11.skuPackage.skuPackageId = "sku-2";
  assert.equal(gate1AutopilotGrantCurrent(candidate), false);
  assert.throws(() => buildGate1AutopilotGrant({ candidateId: "c", sourceRevision: 1, via: "owner_continue", grantedAt: AT }),
    /GATE1_AUTOPILOT_GRANT_UNBOUND/);
});

test("只有那个软件身份、在许可范围里的步骤才放行", () => {
  const candidate = product();
  assert.equal(isGate1AutopilotActor(softwareActor), true);
  assert.equal(gate1AutopilotMayAct(softwareActor, candidate, "c1_prepare_copy"), true);
  assert.equal(gate1AutopilotMayAct(softwareActor, candidate, "c1_paid_draft"), false);
  assert.equal(gate1AutopilotMayAct({ ...softwareActor, source: "selection_review_state_machine" }, candidate, "c1_prepare_copy"), false);
  assert.equal(gate1AutopilotMayAct({ ...softwareActor, actorType: "human", roles: ["owner"] }, candidate, "c1_prepare_copy"), false);
  assert.equal(gate1AutopilotMayAct(softwareActor, product({ granted: false }), "c1_prepare_copy"), false);
});

test("条件测算：读到店里实收费率就自己重算；只有官方费率或什么都没读到，停下等主人", () => {
  const conditional = product({ phase: "B", lifecycle: { status: "b_conditional_awaiting_exact_commission" } });
  const exact = planGate1Autopilot({ candidate: conditional, bExactCommissionRuntimeView: { canRecalculate: true,
    commissionEvidenceMode: "exact", failureId: "failure-1" } });
  assert.equal(exact.status, "running");
  assert.deepEqual({ step: exact.next.step, failureId: exact.next.failureId, skuPackageId: exact.next.skuPackageId },
    { step: "b_exact_recalculation", failureId: "failure-1", skuPackageId: "sku-1" });
  const official = planGate1Autopilot({ candidate: conditional, bExactCommissionRuntimeView: { canRecalculate: true,
    commissionEvidenceMode: "official_reference", failureId: "failure-1" } });
  assert.equal(official.status, "waiting_owner");
  assert.equal(official.stops[0].code, "b_official_reference_only");
  const none = planGate1Autopilot({ candidate: conditional, bExactCommissionRuntimeView: { canRecalculate: false } });
  assert.equal(none.stops[0].code, "b_evidence_required");
  assert.match(none.line, /读到店里的实收费率后软件自己重算/u);
  // 没有许可的老商品不许诺软件会自己重算。
  const legacy = planGate1Autopilot({ candidate: product({ phase: "B", granted: false, lifecycle: { status: "b_conditional_awaiting_exact_commission" } }),
    bExactCommissionRuntimeView: { canRecalculate: false } });
  assert.doesNotMatch(legacy.line, /软件自己重算/u);
});

test("C1：没有当前准备材料就整理，整理好了就准备文案请求，有缺口就把缺口原话列出来", () => {
  assert.equal(planGate1Autopilot({ candidate: product() }).next.step, "c1_local_material");
  // 资料变过（修订号对不上），旧材料不算当前的，重新整理。
  const stale = product({ lifecycle: { c1KeywordPlanningLocalMaterialV1: material("ready_for_review", { resultCandidateRevision: 5 }) } });
  assert.equal(planGate1Autopilot({ candidate: stale }).next.step, "c1_local_material");
  const ready = product({ lifecycle: { c1KeywordPlanningLocalMaterialV1: material("ready_for_review") } });
  assert.equal(planGate1Autopilot({ candidate: ready }).next.step, "c1_prepare_copy");
  const gaps = product({ lifecycle: { c1KeywordPlanningLocalMaterialV1: material("needs_information", { gaps: [
    { code: "C1_SKU_RIGHTS_REVIEW_REQUIRED", field: "skuRightsReview", message: "x" },
    { code: "required_attribute_missing", field: "8229", message: "必填属性「类型」仍需核对" }
  ] }) } });
  const view = planGate1Autopilot({ candidate: gaps });
  assert.equal(view.status, "waiting_owner");
  assert.deepEqual(view.stops.map(item => item.line), ["还没有保存这件商品的品牌与权利声明，这一步只能你来签", "必填属性「类型」仍需核对"]);
  assert.equal(view.next, null);
});

test("文案请求准备好之后停在付费那一步；写好之后进入传图（老许可仍停在确认）；C2 停在素材和方案卡", () => {
  const paid = planGate1Autopilot({ candidate: product({ planStatus: "facts_checked", lifecycle: { c1AiDraftRequestV1: { requestId: "r" } } }) });
  assert.deepEqual([paid.status, paid.stops[0].code], ["waiting_owner", "c1_paid_draft"]);
  const running = planGate1Autopilot({ candidate: product({ planStatus: "facts_checked", lifecycle: {
    c1AiDraftRequestV1: { requestId: "r" }, c1AiDraftJobRefV1: { jobId: "j" } } }) });
  assert.equal(running.status, "working");
  // 文案写好了：v2 许可让它直接进入传图，文案到上架卡上和图片一起看。
  assert.deepEqual(planGate1Autopilot({ candidate: product({ planStatus: "seo_draft_ready" }) }).next,
    { step: "c1_forward_copy", skuPackageId: "sku-1", label: "把写好的文案送进传图" });
  // 老许可（v1）不含这一步；改版方案、有待采用的修订稿、已经确认或已经送过的，都停下等主人确认文案。
  const v1 = product({ planStatus: "seo_draft_ready" });
  v1.gate1AutopilotGrantV1 = { ...v1.gate1AutopilotGrantV1, scopeVersion: "gate1-autopilot-scope-v1",
    scope: ["b_exact_recalculation", "c1_supply_backfill", "c1_local_material", "c1_prepare_copy"] };
  assert.equal(gate1AutopilotGrantCurrent(v1), true, "v1 许可照旧算数");
  assert.equal(planGate1Autopilot({ candidate: v1 }).stops[0].code, "c1_content_review");
  assert.equal(gate1AutopilotMayAct(softwareActor, v1, "c1_forward_copy"), false);
  assert.equal(planGate1Autopilot({ candidate: product({ planStatus: "seo_draft_ready" }), c1EditorialPending: true }).stops[0].code, "c1_content_review");
  for (const lifecycle of [{ c1FinalPlanRevisionPreparation: { status: "facts_prepared" } }, { c1ContentReviewV1: { status: "confirmed" } },
    { c1ContentForwardV1: { status: "forwarded_for_listing" } }]) {
    assert.equal(planGate1Autopilot({ candidate: product({ planStatus: "seo_draft_ready", lifecycle }) }).stops[0].code, "c1_content_review");
  }
  assert.equal(planGate1Autopilot({ candidate: product({ planStatus: "seo_draft_ready", granted: false }) }).stops[0].code, "c1_content_review");
  assert.deepEqual(planGate1Autopilot({ candidate: product({ phase: "C2" }) }).stops.map(item => [item.code, item.line]),
    [["c2_assets", "文案已确认：传上架用的图片，排第一张的就是主图"]]);
  assert.deepEqual(planGate1Autopilot({ candidate: product({ phase: "C2", lifecycle: { c1ContentForwardV1: { status: "forwarded_for_listing" } } }) })
    .stops.map(item => [item.code, item.line]),
    [["c2_assets", "文案已经写好：传上架用的图片，排第一张的就是主图；文案到上架卡上和图片一起看"]]);
  // 图排好了（没有还在传的）就是「上架」那一道确认；还有图在传，仍然停在图片这一步。
  const arranged = (status) => product({ phase: "C2", lifecycle: { c2UploadDraft: { revision: 3,
    uploads: [{ assetId: "a1", status: "ready" }, { assetId: "a2", status }], selection: [{ assetId: "a1", order: 1 }] } } });
  assert.deepEqual(planGate1Autopilot({ candidate: arranged("ready") }).stops.map(item => [item.code, item.line]),
    [["gate2", "图片已经排好：在上架卡上看一眼，点「上架」"]]);
  assert.equal(planGate1Autopilot({ candidate: arranged("uploading") }).stops[0].code, "c2_assets");
  assert.equal(planGate1Autopilot({ candidate: product({ phase: "C2", sku: { productionConfirmationCard: { status: "awaiting_owner_business_confirmation" } } }) })
    .stops[0].code, "gate2");
  assert.equal(planGate1Autopilot({ candidate: product({ phase: "D1" }) }), null);
  assert.equal(planGate1Autopilot({ candidate: product({ sku: { productionAuthorization: { id: "a" } } }) }), null);
});

test("还没确认供货、已淘汰、同款各色成员、不是 Ozon：不归这里管", () => {
  assert.equal(planGate1Autopilot({ candidate: { id: "x", dataRevision: 1, workflowStatus: "needs_user_data" } }), null);
  assert.equal(planGate1Autopilot({ candidate: product({ extra: { workflowStatus: "eliminated" } }) }), null);
  assert.equal(planGate1Autopilot({ candidate: product({ extra: { siblingSourceV1: { parentCandidateId: "p" } } }) }), null);
  assert.equal(planGate1Autopilot({ candidate: product({ sku: { targetPlatform: "wb" } }) }), null);
});

test("没有许可时，不花钱的那一步摆出来让主人决定要不要让软件接着做", () => {
  const view = planGate1Autopilot({ candidate: product({ granted: false }) });
  assert.equal(view.status, "ready");
  assert.equal(view.granted, false);
  assert.match(view.line, /整理商品属性与关键词/u);
});

test("出错一直挡住同一步：之后改了资料（修订号变了）也不再试；主人点「让软件再试一次」或者重新点「做这件」换了许可，才再做", () => {
  const failed = product();
  failed.gate1AutopilotV1 = gate1AutopilotRecordAfterRun(null, { failure: gate1AutopilotFailure({ candidate: failed,
    step: "c1_local_material", code: "C1_LOCAL_PREPARATION_IDENTITY_INVALID", at: AT }), at: AT });
  assert.deepEqual({ ...failed.gate1AutopilotV1.failure }, { step: "c1_local_material", code: "C1_LOCAL_PREPARATION_IDENTITY_INVALID",
    at: AT, sourceRevision: 7, grantId: failed.gate1AutopilotGrantV1.grantId });
  const view = planGate1Autopilot({ candidate: failed });
  assert.equal(view.status, "failed");
  assert.match(view.line, /C1_LOCAL_PREPARATION_IDENTITY_INVALID/u);
  assert.match(view.line, /之后改了资料它也不会自己再试，要它再做一次就点「让软件再试一次」/u);
  // 主人之后改了别的资料（修订号变了）：照样挡着，软件不自己再试（AGENTS.md §8.3）。
  failed.dataRevision = 8;
  assert.equal(planGate1Autopilot({ candidate: failed }).status, "failed");
  assert.equal(planGate1Autopilot({ candidate: failed }).next.step, "c1_local_material");
  // 「让软件再试一次」那条路清掉出错记录，才再做。
  const retried = { ...failed, gate1AutopilotV1: { ...failed.gate1AutopilotV1, failure: null } };
  assert.equal(planGate1Autopilot({ candidate: retried }).status, "running");
  // 重新点了「做这件」：换了一份许可，上一份许可下的出错不再挡。
  const again = { ...decision, decidedAt: "2026-10-12T00:00:00.000Z", roundIndex: 1 };
  const reaccepted = { ...failed, gate1DecisionV1: again, gate1AutopilotGrantV1: buildGate1AutopilotGrant({ candidateId: "cand-1",
    sourceRevision: 8, decision: again, via: "gate1_accept", grantedAt: again.decidedAt, grantedBy: "owner" }) };
  assert.equal(planGate1Autopilot({ candidate: reaccepted }).status, "running");
  // 别的一步出的错不挡这一步。
  const other = product();
  other.gate1AutopilotV1 = gate1AutopilotRecordAfterRun(null, { failure: gate1AutopilotFailure({ candidate: other,
    step: "c1_prepare_copy", code: "X", at: AT }), at: AT });
  assert.equal(planGate1Autopilot({ candidate: other }).status, "running");
});

test("改法之前存下的出错记录没有许可编号：能确定出在现在这份许可之前才放开，分不清就照样挡", () => {
  const legacy = at => product({ extra: { gate1AutopilotV1: { schemaVersion: "gate1-autopilot-v1", lastRunAt: AT, ranSteps: [],
    failure: { step: "c1_local_material", code: "C1_LOCAL_PREPARATION_IDENTITY_INVALID", at, sourceRevision: 6 } } } });
  assert.equal(planGate1Autopilot({ candidate: legacy("2026-10-11T09:00:00.000Z") }).status, "running", "许可之前出的错");
  assert.equal(planGate1Autopilot({ candidate: legacy(AT) }).status, "failed", "和许可同一刻，分不清");
  assert.equal(planGate1Autopilot({ candidate: legacy("2026-10-12T00:00:00.000Z") }).status, "failed", "许可之后出的错");
  assert.equal(planGate1Autopilot({ candidate: legacy("not-a-time") }).status, "failed", "时间读不出来");
});

test("补齐供应属性只在冻结快照里还没有页面属性、又是同一次采集时才做", () => {
  const snapshot = () => ({ supplierSku: { attributes: { quantityOneEvidence: { captureId: "cap-1" } } } });
  const sku = { selectedSupplySnapshot: snapshot() };
  const candidate = product({ sku, extra: { sourceCapture: { captureId: "cap-1", supplierAttributes: { "面料": "牛津布", "品牌": "X" } } } });
  candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots = { confirmedSupplierSkuSnapshot: snapshot() };
  assert.equal(planGate1Autopilot({ candidate }).next.step, "c1_supply_backfill");
  candidate.sourceCapture.captureId = "cap-2";
  assert.equal(planGate1Autopilot({ candidate }).next.step, "c1_local_material");
  candidate.sourceCapture.captureId = "cap-1";
  candidate.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes["面料"] = "牛津布";
  assert.equal(planGate1Autopilot({ candidate }).next.step, "c1_local_material");
});

test("做完的几步记下来只留最近几条；有一步做成了就清掉旧的出错记录", () => {
  let record = gate1AutopilotRecordAfterRun(null, { failure: { step: "c1_prepare_copy", code: "X", at: AT, sourceRevision: 1 }, at: AT });
  record = gate1AutopilotRecordAfterRun(record, { ranSteps: [{ step: "c1_local_material", at: AT, sourceRevision: 2 }], at: AT });
  assert.equal(record.failure, null);
  for (let index = 0; index < 20; index += 1) record = gate1AutopilotRecordAfterRun(record, { ranSteps: [{ step: "c1_local_material", at: AT }], at: AT });
  assert.equal(record.ranSteps.length, 12);
  assert.equal(gate1AutopilotRecordAfterRun({ failure: { step: "x" } }, { at: AT }).failure.step, "x");
});

test("有许可的软件身份能把整理好的材料准备成文案请求，停在付费那一步；没许可的不能", async () => {
  const { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } = await import("./fixtures/c1-local-draft-source-fixture.mjs");
  const { createMemoryBusinessStateRepository } = await import("../lib/business-state-repository.mjs");
  const { createC1DraftSoftwareUseCase } = await import("../lib/c1-draft-software-use-case.mjs");
  const { createActorContext } = await import("../lib/runtime-identity.mjs");
  const run = async granted => {
    const candidate = createSavedLocalPreparationCandidate();
    if (granted) {
      candidate.gate1DecisionV1 = { decision: "accept", decidedAt: LOCAL_DRAFT_AT, roundIndex: 0 };
      candidate.gate1AutopilotGrantV1 = buildGate1AutopilotGrant({ candidateId: candidate.id, sourceRevision: 1,
        decision: candidate.gate1DecisionV1, via: "gate1_accept", grantedAt: LOCAL_DRAFT_AT, grantedBy: "owner" });
    }
    const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
    const useCase = createC1DraftSoftwareUseCase({ repository, runtimeMode: "local_development", serverClock: () => LOCAL_DRAFT_AT });
    const actor = createActorContext({ userId: GATE1_AUTOPILOT_ACTOR_USER_ID, sessionId: "gate1-autopilot:test", actorType: "software",
      roles: ["operator"], source: GATE1_AUTOPILOT_ACTOR_SOURCE, authenticatedAt: LOCAL_DRAFT_AT });
    assert.equal(planGate1Autopilot({ candidate }).next.step, "c1_prepare_copy");
    const result = await useCase.prepareLocal({ actor, input: { candidateId: candidate.id, expectedRevision: candidate.dataRevision,
      idempotencyKey: "gate1-autopilot:c1-local-draft:test", auditEventId: "gate1-autopilot-audit:c1-local-draft:test" } });
    return { result, saved: (await repository.readSnapshot()).candidates[0] };
  };
  await assert.rejects(run(false), /C1_LOCAL_DRAFT_AUTOPILOT_GRANT_REQUIRED/);
  const { result, saved } = await run(true);
  assert.equal(result.result.status, "awaiting_paid_confirmation");
  assert.equal(result.result.providerCalls, 0);
  const view = planGate1Autopilot({ candidate: saved });
  assert.deepEqual([view.status, view.stops[0].code], ["waiting_owner", "c1_paid_draft"]);
});

test("「做这件」卡上声明过品牌与权利：C1 计划一生成就由软件记下；老许可、过期、计划已冻结或已有声明都不动", async () => {
  const { buildGate1RightsDeclaration } = await import("../lib/gate1-rights-declaration.mjs");
  const declared = (extra = {}) => {
    const candidate = product({ sku: { c1ProductPlan: { status: "inputs_ready", c1PlanId: "c1:sku-1:v1", inputSnapshots: {} } }, ...extra });
    candidate.gate1RightsDeclarationV1 = buildGate1RightsDeclaration({ candidateId: "cand-1", sourceRevision: 2,
      input: { brandStatus: "unbranded", brandName: null, rights: "no_third_party_rights_identified", validMonths: 3 }, decision,
      declaredByUserId: "owner", declaredAt: AT });
    return candidate;
  };
  const view = planGate1Autopilot({ candidate: declared(), observedAt: AT });
  assert.equal(view.status, "running");
  assert.deepEqual(view.next, { step: "c1_apply_rights", skuPackageId: "sku-1", c1PlanId: "c1:sku-1:v1", label: "按你在「做这件」卡上的声明记下品牌与权利" });
  assert.equal(view.line, "软件正在按你在「做这件」卡上的声明记下品牌与权利");
  assert.equal(gate1AutopilotMayAct(softwareActor, declared(), "c1_apply_rights"), true);
  // 不记的几种：都回到原来那一步（整理属性与关键词），缺声明的话到时候照旧停下等主人。
  assert.equal(planGate1Autopilot({ candidate: declared(), observedAt: "2027-01-11T10:00:00.000Z" }).next.step, "c1_local_material", "过期");
  const v2 = declared();
  v2.gate1AutopilotGrantV1 = { ...v2.gate1AutopilotGrantV1, scopeVersion: "gate1-autopilot-scope-v2",
    scope: v2.gate1AutopilotGrantV1.scope.filter(step => step !== "c1_apply_rights") };
  assert.equal(planGate1Autopilot({ candidate: v2, observedAt: AT }).next.step, "c1_local_material", "v2 许可不含这一步");
  const recorded = declared();
  recorded.lifecycleV11.skuPackage.c1RightsReviewRecord = { recordId: "r" };
  assert.equal(planGate1Autopilot({ candidate: recorded, observedAt: AT }).next.step, "c1_local_material", "已经有声明");
  const frozen = declared();
  frozen.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview = { reviewId: "x" };
  assert.equal(planGate1Autopilot({ candidate: frozen, observedAt: AT }).next.step, "c1_local_material", "计划已冻结");
  const newRound = declared();
  newRound.gate1DecisionV1 = { ...decision, decidedAt: "2026-10-12T00:00:00.000Z" };
  assert.equal(planGate1Autopilot({ candidate: newRound, observedAt: AT }).status, "ready", "换了一轮：许可和声明都不算了");
});

// 「做这件」之后、确认供货之前：软件只做一件事，读一次主人认的那个 Ozon 同款页面。
const OZON_ID = "3605840795";
const OZON_URL = `https://www.ozon.ru/product/kurtka-${OZON_ID}/?at=abc`;
const pickedDecision = { ...decision, picks: { ozon: { id: OZON_ID, sourceUrl: OZON_URL }, match: null, supplier: { id: "771" } } };
const pageSnapshot = (productId = OZON_ID) => ({
  schemaVersion: "sales-snapshot-v1.1", snapshotId: `sales-snapshot:${productId}`, platform: "ozon", marketScope: "unknown",
  sellerType: "unknown", sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "test-evidence" },
  productUrl: `https://www.ozon.ru/product/${productId}/`, title: "Тестовая куртка", imageRefs: [], currentPrice: 1457, currency: "RUB",
  categoryPath: "Одежда > Куртки", attributes: {}, collectedAt: "2026-10-11T10:30:00.000Z", evidenceRef: "test-evidence",
  collectorMode: "real_page_read_only", collectorVersion: "real-ozon-sales-snapshot-v1", readOnly: true
});

function choosing({ granted = true, capture = "captured_waiting_owner_selection", extra = {} } = {}) {
  const candidate = { id: "cand-1", dataRevision: 9, workflowStatus: "needs_user_data", gate1DecisionV1: pickedDecision,
    sourceCapture: capture === null ? undefined : { captureId: "SC-1", status: capture }, ...extra };
  if (granted) candidate.gate1AutopilotGrantV1 = buildGate1AutopilotGrant({ candidateId: "cand-1", sourceRevision: 8,
    decision: pickedDecision, via: "gate1_accept", grantedAt: AT, grantedBy: "owner" });
  return candidate;
}

test("许可里单独存一份公开页面读取授权：只读认下的那一个 Ozon 商品页、只读一次、只在确认供货之前", () => {
  const grant = choosing().gate1AutopilotGrantV1;
  assert.equal(grant.scopeVersion, "gate1-autopilot-scope-v4");
  assert.ok(grant.scope.includes("a_read_ozon_benchmark"));
  assert.deepEqual({ ...grant.publicRead, excludes: [...grant.publicRead.excludes] }, {
    schemaVersion: "gate1-public-read-v1", site: "www.ozon.ru", action: "read_product_page", productId: OZON_ID,
    productUrl: `https://www.ozon.ru/product/${OZON_ID}/`, maxReads: 1, stage: "A", candidateId: "cand-1", sourceRevision: 8,
    excludes: ["store_backend", "login_required_page", "platform_write", "paid_call"] });
  // 卡上没认 Ozon 同款、地址不是商品页、或者已经有 SKU 包：没有这份授权。
  for (const ozon of [null, { id: OZON_ID, sourceUrl: "https://ozon.ru/search?q=1" }, { id: "999999999", sourceUrl: OZON_URL }]) {
    const built = buildGate1AutopilotGrant({ candidateId: "cand-1", sourceRevision: 8, decision: { ...pickedDecision, picks: { ozon } },
      via: "gate1_accept", grantedAt: AT, grantedBy: "owner" });
    assert.equal(Object.hasOwn(built, "publicRead"), false);
  }
  const later = buildGate1AutopilotGrant({ candidateId: "cand-1", sourceRevision: 8, decision: pickedDecision, skuPackageId: "sku-1",
    via: "owner_continue", grantedAt: AT, grantedBy: "owner" });
  assert.equal(Object.hasOwn(later, "publicRead"), false);
});

test("规格采回来以后软件读一次认下的 Ozon 同款；在读就说在读，读过没读到就停下等主人，不再自己读", () => {
  const ready = planGate1Autopilot({ candidate: choosing() });
  assert.equal(ready.status, "running");
  assert.deepEqual({ ...ready.next }, { step: "a_read_ozon_benchmark", productId: OZON_ID,
    productUrl: `https://www.ozon.ru/product/${OZON_ID}/`, label: "读一次你认的那个 Ozon 同款页面" });
  assert.equal(gate1AutopilotMayAct(softwareActor, choosing(), "a_read_ozon_benchmark"), true);

  // 1688 采集还没采回来（采集控制同一时刻只给一个作业），没有许可，已经确认过供货，或者已经读到过这一页：不归这里管。
  assert.equal(planGate1Autopilot({ candidate: choosing({ capture: "waiting_extension" }) }), null);
  assert.equal(planGate1Autopilot({ candidate: choosing({ capture: null }) }), null);
  assert.equal(planGate1Autopilot({ candidate: choosing({ granted: false }) }), null);
  assert.equal(planGate1Autopilot({ candidate: choosing({ extra: { lifecycleV11: { aConfirmationReceipt: { decision: "confirm" } } } }) }), null);
  assert.equal(planGate1Autopilot({ candidate: choosing({ extra: { salesSnapshotsV11: [pageSnapshot()] } }) }), null);
  assert.equal(planGate1Autopilot({ candidate: choosing({ extra: { salesSnapshotsV11: [pageSnapshot("1234567")] } }) }).next.step,
    "a_read_ozon_benchmark", "读到的是别的商品，不算读过认下的这一页");
  // 老许可（v3）没有这一步。
  const v3 = choosing();
  v3.gate1AutopilotGrantV1 = { ...v3.gate1AutopilotGrantV1, scopeVersion: "gate1-autopilot-scope-v3",
    scope: v3.gate1AutopilotGrantV1.scope.filter(step => step !== "a_read_ozon_benchmark") };
  assert.equal(planGate1Autopilot({ candidate: v3 }), null);

  const reading = planGate1Autopilot({ candidate: choosing({ extra: { salesCapture: { captureId: "OPR-1", productId: OZON_ID,
    status: "waiting_extension", jobStatus: "queued", queuedBy: GATE1_AUTOPILOT_ACTOR_SOURCE } } }) });
  assert.equal(reading.status, "working");
  assert.equal(reading.next, null);
  assert.match(reading.line, /正在读你认的那个 Ozon 同款页面/u);

  // 读失败时那条记录整份重写、不带 queuedBy；「读过」看软件自己的运行记录。
  const ran = { schemaVersion: "gate1-autopilot-v1", ranSteps: [{ step: "a_read_ozon_benchmark", at: "2026-10-11T10:05:00.000Z", sourceRevision: 9 }] };
  const failed = planGate1Autopilot({ candidate: choosing({ extra: { gate1AutopilotV1: ran, salesCapture: { captureId: "OPR-1",
    productId: OZON_ID, status: "failed", jobStatus: "failed", reason: "页面要求登录。" } } }) });
  assert.equal(failed.status, "waiting_owner");
  assert.equal(failed.stops[0].code, "a_ozon_read_failed");
  assert.match(failed.line, /没读到（页面要求登录）；它不会自己再读，在这件商品的「算利润」里点「读一次这个 Ozon 页面」/u);
  assert.match(planGate1Autopilot({ candidate: choosing({ extra: { gate1AutopilotV1: ran } }) }).line, /没读到；它不会自己再读/u);
  // 许可之前的那次运行记录不算这一轮读过。
  const before = { ...ran, ranSteps: [{ ...ran.ranSteps[0], at: "2026-10-11T09:00:00.000Z" }] };
  assert.equal(planGate1Autopilot({ candidate: choosing({ extra: { gate1AutopilotV1: before } }) }).next.step, "a_read_ozon_benchmark");
});

test("软件读认下的 Ozon 同款页面，建作业那一刻按许可扣一次：扣过就不再读，作业后来没读成也不退", () => {
  const at = "2026-10-11T10:10:00.000Z";
  const candidate = choosing();
  const grantId = candidate.gate1AutopilotGrantV1.grantId;
  const debit = debitGate1PublicRead(candidate, { productId: OZON_ID, captureId: "OPR-1", at });
  assert.equal(debit.ok, true);
  assert.deepEqual(debit.record, { schemaVersion: "gate1-autopilot-v1", lastRunAt: null, ranSteps: [], failure: null,
    publicReads: [{ grantId, productId: OZON_ID, captureId: "OPR-1", at, sourceRevision: 9 }] });
  assert.equal(candidate.gate1AutopilotV1, undefined, "只返回要存的记录，不改传进来的商品");
  const debited = { ...candidate, gate1AutopilotV1: debit.record };
  assert.deepEqual({ ...debitGate1PublicRead(debited, { productId: OZON_ID, captureId: "OPR-2", at }) },
    { ok: false, code: "GATE1_PUBLIC_READ_EXHAUSTED" });

  // 读页面失败时那条记录整份重写（不带 queuedBy），软件的运行记录也可能没来得及存：只凭扣下的那一次，就不再排读页面。
  const failedRead = planGate1Autopilot({ candidate: { ...debited, salesCapture: { captureId: "OPR-1", productId: OZON_ID,
    status: "failed", jobStatus: "failed", reason: "页面要求登录。" } } });
  assert.deepEqual([failedRead.status, failedRead.next, failedRead.stops[0].code], ["waiting_owner", null, "a_ozon_read_failed"]);
  const inFlight = planGate1Autopilot({ candidate: { ...debited, salesCapture: { captureId: "OPR-1", productId: OZON_ID,
    status: "waiting_extension", jobStatus: "queued" } } });
  assert.deepEqual([inFlight.status, inFlight.next], ["working", null]);
  // 跑完记运行记录、主人点「让软件再试一次」清出错：扣下的次数都原样留着。
  const after = gate1AutopilotRecordAfterRun(debit.record, { ranSteps: [{ step: "a_read_ozon_benchmark", at, sourceRevision: 9 }], at });
  assert.deepEqual(after.publicReads, debit.record.publicReads);
  assert.deepEqual(gate1AutopilotRecordAfterRun(after, { failure: { step: "x", code: "Y", at }, at }).publicReads, debit.record.publicReads);
  // 上一份许可下扣的不算这一份的：重新点「做这件」换了许可，又有一次。
  const again = { ...pickedDecision, decidedAt: "2026-10-12T00:00:00.000Z", roundIndex: 1 };
  const reaccepted = { ...debited, dataRevision: 12, gate1DecisionV1: again, gate1AutopilotGrantV1: buildGate1AutopilotGrant({
    candidateId: "cand-1", sourceRevision: 11, decision: again, via: "gate1_accept", grantedAt: again.decidedAt, grantedBy: "owner" }) };
  assert.equal(debitGate1PublicRead(reaccepted, { productId: OZON_ID, captureId: "OPR-3", at: again.decidedAt }).ok, true);
  // 已有的运行记录原样带着，只往后加这一次。
  const withRuns = { ...candidate, gate1AutopilotV1: { schemaVersion: "gate1-autopilot-v1", lastRunAt: AT,
    ranSteps: [{ step: "c1_local_material", at: AT, sourceRevision: 3 }], failure: null } };
  const kept = debitGate1PublicRead(withRuns, { productId: OZON_ID, captureId: "OPR-4", at }).record;
  assert.deepEqual([kept.lastRunAt, kept.ranSteps, kept.publicReads.length], [AT, withRuns.gate1AutopilotV1.ranSteps, 1]);
});

test("不给读的几种：许可不算数、已经确认过供货、许可里没有读页面授权、要读的不是认下的那一页；一个都不扣", () => {
  const at = "2026-10-11T10:10:00.000Z";
  const refused = (candidate, productId = OZON_ID) => {
    const result = debitGate1PublicRead(candidate, { productId, captureId: "OPR-1", at });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "record"), false);
    return result.code;
  };
  assert.equal(refused(choosing({ granted: false })), "GATE1_PUBLIC_READ_GRANT_NOT_CURRENT");
  assert.equal(refused(choosing({ extra: { workflowStatus: "eliminated" } })), "GATE1_PUBLIC_READ_GRANT_NOT_CURRENT");
  assert.equal(refused(choosing({ extra: { lifecycleV11: { aConfirmationReceipt: { decision: "confirm" } } } })), "GATE1_PUBLIC_READ_STAGE_CLOSED");
  assert.equal(refused(choosing({ extra: { lifecycleV11: { skuPackage: { skuPackageId: "sku-1" } } } })), "GATE1_PUBLIC_READ_STAGE_CLOSED");
  assert.equal(refused(choosing(), "1234567"), "GATE1_PUBLIC_READ_TARGET_MISMATCH");
  const without = choosing();
  const { publicRead: _omitted, ...grantWithoutRead } = without.gate1AutopilotGrantV1;
  assert.equal(refused({ ...without, gate1AutopilotGrantV1: grantWithoutRead }), "GATE1_PUBLIC_READ_NOT_AUTHORIZED");
  const zero = choosing();
  assert.equal(refused({ ...zero, gate1AutopilotGrantV1: { ...zero.gate1AutopilotGrantV1,
    publicRead: { ...zero.gate1AutopilotGrantV1.publicRead, maxReads: 0 } } }), "GATE1_PUBLIC_READ_NOT_AUTHORIZED");
  const v3 = choosing();
  assert.equal(refused({ ...v3, gate1AutopilotGrantV1: { ...v3.gate1AutopilotGrantV1, scopeVersion: "gate1-autopilot-scope-v3",
    scope: v3.gate1AutopilotGrantV1.scope.filter(step => step !== "a_read_ozon_benchmark") } }), "GATE1_PUBLIC_READ_NOT_AUTHORIZED");
  assert.throws(() => debitGate1PublicRead(choosing(), { productId: OZON_ID, captureId: "", at }), /GATE1_PUBLIC_READ_DEBIT_INPUT_INVALID/);
});
