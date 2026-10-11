import test from "node:test";
import assert from "node:assert/strict";
import {
  GATE1_AUTOPILOT_ACTOR_SOURCE, GATE1_AUTOPILOT_ACTOR_USER_ID, buildGate1AutopilotGrant, gate1AutopilotGrantCurrent,
  gate1AutopilotMayAct, gate1AutopilotRecordAfterRun, isGate1AutopilotActor, planGate1Autopilot
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

test("文案请求准备好之后停在付费那一步；写好之后停在确认；C2 停在素材和方案卡", () => {
  const paid = planGate1Autopilot({ candidate: product({ planStatus: "facts_checked", lifecycle: { c1AiDraftRequestV1: { requestId: "r" } } }) });
  assert.deepEqual([paid.status, paid.stops[0].code], ["waiting_owner", "c1_paid_draft"]);
  const running = planGate1Autopilot({ candidate: product({ planStatus: "facts_checked", lifecycle: {
    c1AiDraftRequestV1: { requestId: "r" }, c1AiDraftJobRefV1: { jobId: "j" } } }) });
  assert.equal(running.status, "working");
  assert.equal(planGate1Autopilot({ candidate: product({ planStatus: "seo_draft_ready" }) }).stops[0].code, "c1_content_review");
  assert.equal(planGate1Autopilot({ candidate: product({ phase: "C2" }) }).stops[0].code, "c2_assets");
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

test("出错只挡同一份资料上的同一步：修订号变了就再试；不会自己重试同一份", () => {
  const failed = product({ extra: { gate1AutopilotV1: gate1AutopilotRecordAfterRun(null, {
    failure: { step: "c1_local_material", code: "C1_LOCAL_PREPARATION_IDENTITY_INVALID", at: AT, sourceRevision: 7 }, at: AT }) } });
  const view = planGate1Autopilot({ candidate: failed });
  assert.equal(view.status, "failed");
  assert.match(view.line, /C1_LOCAL_PREPARATION_IDENTITY_INVALID/u);
  failed.dataRevision = 8;
  assert.equal(planGate1Autopilot({ candidate: failed }).status, "running");
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
