import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTOR_TYPES,
  authorizeExceptionMaintenance,
  blockExecutionForTechnicalFailure,
  recoverC1KeywordHandoffTechnicalFailure,
  recoverBExactCommissionTechnicalFailure,
  releaseATerraAssistBlock,
  buildExecutionRuntimeView,
  codexDispatchGate,
  completeExecutionStep,
  createSoftwareExecutionRuntime,
  openExceptionCase,
  recordExceptionMaintenanceStarted,
  resolveExceptionCase,
  simulateNormalSoftwarePath,
  startSoftwareStep,
  startThirdPartyAiStep,
  validateExecutionRuntime,
  waitForOwner
} from "../lib/software-execution-state.mjs";

const at = "2026-08-22T01:00:00.000Z";

function runtime() {
  return createSoftwareExecutionRuntime({ candidateId: "SIM-1", dataRevision: 7, businessPhase: "A", at });
}

test("running projection requires matching process execution evidence and never changes saved state", () => {
  const executionRuntime = startThirdPartyAiStep(runtime(), { stepId: "C1_DRAFT", inputRevision: 7, inferenceJobId: "job-1", at });
  const candidate = { id: "SIM-1", dataRevision: 7, executionRuntime };
  const activeExecutionReference = { status: "running", candidateId: candidate.id, candidateRevision: 7, stepId: executionRuntime.stepId,
    inputRevision: 7, updatedAt: executionRuntime.updatedAt, inferenceJobId: "job-1", exceptionTurnId: null };
  const before = structuredClone(candidate);
  const history = buildExecutionRuntimeView(candidate);
  assert.equal(history.historicalExecution, true);
  assert.equal(history.currentExecutionConfirmed, false);
  const current = buildExecutionRuntimeView(candidate, { activeExecutionReference });
  assert.equal(current.currentExecutionConfirmed, true);
  assert.equal(current.historicalExecution, false);
  const waiting = buildExecutionRuntimeView(candidate, { activeExecutionReference: { ...activeExecutionReference, status: "permission_required" } });
  assert.equal(waiting.historicalExecution, false);
  assert.equal(waiting.currentPermissionRequired, true);
  assert.equal(waiting.currentExecutionConfirmed, false);
  for (const key of ["status", "candidateId", "candidateRevision", "stepId", "inputRevision", "updatedAt", "inferenceJobId", "exceptionTurnId"]) {
    const mismatched = { ...activeExecutionReference, [key]: "different" };
    assert.equal(buildExecutionRuntimeView(candidate, { activeExecutionReference: mismatched }).currentExecutionConfirmed, false);
  }
  const wrongCandidate = buildExecutionRuntimeView({ ...candidate, id: "other" }, { activeExecutionReference });
  assert.equal(wrongCandidate.recordIssue, "execution_record_invalid_or_wrong_candidate");
  assert.equal(wrongCandidate.currentExecutionConfirmed, false);
  const broken = buildExecutionRuntimeView({ ...candidate, executionRuntime: { ...executionRuntime, schemaVersion: "old" } });
  assert.equal(broken.recordIssue, "execution_record_invalid_or_wrong_candidate");
  assert.deepEqual(candidate, before);
});

test("四类执行者被固定为软件、第三方AI、Codex异常和主人", () => {
  assert.deepEqual(EXECUTOR_TYPES, ["software", "third_party_ai", "codex_exception", "owner"]);
  const software = startSoftwareStep(runtime(), { stepId: "A_VALIDATE", inputRevision: 7, at });
  assert.equal(software.executorType, "software");
  const ai = startThirdPartyAiStep(runtime(), { stepId: "A_AI_ASSIST", inputRevision: 7, inferenceJobId: "inf-1", at });
  assert.equal(ai.executorType, "third_party_ai");
  const owner = waitForOwner(runtime(), { stepId: "A_OWNER_CONFIRM", inputRevision: 7, at });
  assert.equal(owner.executorType, "owner");
  const exception = openExceptionCase(runtime(), {
    exceptionId: "exc-1",
    reasonCode: "evidence_conflict",
    failureLayer: "a_evidence",
    evidenceRefs: ["ev-1", "ev-2"],
    message: "两份证据冲突",
    at
  });
  assert.equal(exception.executorType, "software");
  assert.equal(exception.status, "blocked");
  assert.equal(exception.codexWakeupCount, 0);
});

test("正常软件SKU完成一步时Codex唤醒和派发均为0", () => {
  const result = simulateNormalSoftwarePath();
  assert.equal(result.runtime.status, "completed");
  assert.equal(result.codexWakeups, 0);
  assert.equal(result.dispatchesCreated, 0);
  assert.equal(result.platformAccesses, 0);
  assert.equal(result.platformWrites, 0);
});

test("第三方AI必须绑定作业与结果凭证，不能把无凭证输出标完成", () => {
  assert.throws(
    () => startThirdPartyAiStep(runtime(), { stepId: "A_AI_ASSIST", inputRevision: 7, inferenceJobId: "", at }),
    /inferenceJobId/
  );
  const running = startThirdPartyAiStep(runtime(), { stepId: "A_AI_ASSIST", inputRevision: 7, inferenceJobId: "inf-1", at });
  assert.throws(() => completeExecutionStep(running, { outputRevision: 8, at }), /INFERENCE_RECEIPT_REQUIRED/);
  const completed = completeExecutionStep(running, { outputRevision: 8, inferenceReceiptId: "receipt-1", at });
  assert.equal(completed.inferenceReceiptId, "receipt-1");
  assert.equal(validateExecutionRuntime(completed).valid, true);
});

test("ExceptionCase创建、授权、真实领取和解决分别记录，创建本身不冒充Codex唤醒", () => {
  for (const reasonCode of ["evidence_conflict", "output_schema_mismatch", "system_failure"]) {
    const opened = openExceptionCase(runtime(), {
      exceptionId: `exc-${reasonCode}`,
      reasonCode,
      failureLayer: "test_layer",
      evidenceRefs: ["ev-1"],
      sourceRevision: 9,
      message: "模拟异常",
      at
    });
    assert.equal(opened.businessPhase, "A");
    assert.equal(opened.exceptionCase.businessStateChanged, false);
    assert.equal(opened.exceptionCase.schemaVersion, "exception-case-v2");
    assert.equal(opened.exceptionCase.sourceRevision, 9, "异常必须锁定失败现场修订，不沿用旧runtime修订");
    assert.equal(opened.exceptionCase.automaticRetryAllowed, false);
    assert.equal(opened.exceptionCase.dispatchState, "not_dispatched");
    assert.equal(opened.codexWakeupCount, 0);
    assert.equal(codexDispatchGate({ lifecycleV11: { opportunityPackage: {} }, executionRuntime: opened }).allowed, false);

    const authorized = authorizeExceptionMaintenance(opened, {
      exceptionId: opened.exceptionCase.exceptionId,
      maintenanceAuthorizationId: `maintenance-auth:${reasonCode}`,
      at
    });
    assert.equal(codexDispatchGate({ lifecycleV11: { opportunityPackage: {} }, executionRuntime: authorized }).allowed, true);
    assert.equal(authorized.codexWakeupCount, 0);

    const started = recordExceptionMaintenanceStarted(authorized, {
      exceptionId: authorized.exceptionCase.exceptionId,
      turnId: `turn:${reasonCode}`,
      at
    });
    assert.equal(started.executorType, "codex_exception");
    assert.equal(started.codexWakeupCount, 1);

    const resolved = resolveExceptionCase(started, {
      exceptionId: started.exceptionCase.exceptionId,
      resolutionCode: "code_fixed_and_verified",
      evidenceRefs: ["test:verification"],
      at
    });
    assert.equal(resolved.exceptionCase.status, "resolved");
    assert.equal(resolved.status, "blocked", "解决技术案件不能自动恢复业务执行");
  }
  assert.throws(() => openExceptionCase(runtime(), {
    exceptionId: "exc-bad", reasonCode: "permission_required", failureLayer: "x", evidenceRefs: [], at
  }), /EXCEPTION_REASON_NOT_ALLOWED/);
  assert.throws(() => openExceptionCase(runtime(), {
    exceptionId: "exc-secret",
    reasonCode: "system_failure",
    failureLayer: "x",
    evidenceRefs: ["request:token=do-not-store"],
    at
  }), /不得包含秘密/);
});

test("已知外部失败和结果未知由软件安全停止，不创建ExceptionCase或唤醒Codex", () => {
  for (const kind of ["external_dependency", "known_technical_failure", "unknown_outcome"]) {
    const blocked = blockExecutionForTechnicalFailure(runtime(), {
      failureId: `failure:${kind}`,
      kind,
      errorCode: "TEST_FAILURE",
      failureLayer: "test_layer",
      evidenceRefs: ["test:evidence"],
      softwareJobId: kind === "unknown_outcome" ? "job:unknown" : null,
      sourceRevision: 10,
      at
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.executorType, "software");
    assert.equal(blocked.exceptionCase, null);
    assert.equal(blocked.codexWakeupCount, 0);
    assert.equal(blocked.technicalFailure.automaticRetryAllowed, false);
    assert.equal(blocked.technicalFailure.businessStateChanged, false);
    assert.equal(blocked.technicalFailure.sourceRevision, 10);
    assert.throws(() => startSoftwareStep(blocked, { stepId: "RETRY", inputRevision: 7, at }), /EXECUTION_BLOCKED_BY_TECHNICAL_FAILURE/);
  }
});

test("新版正常商品禁止Codex派发，旧记录只读展示", () => {
  const normal = { lifecycleV11: { opportunityPackage: { businessPhase: "A" } }, executionRuntime: runtime(), dataRevision: 7 };
  assert.equal(codexDispatchGate(normal).allowed, false);
  const forgedException = {
    lifecycleV11: { opportunityPackage: { businessPhase: "A" } },
    executionRuntime: {
      status: "blocked",
      exceptionCase: {
        schemaVersion: "exception-case-v2",
        status: "open",
        dispatchState: "queued",
        maintenanceAuthorizationId: "maintenance:forged"
      }
    }
  };
  assert.equal(codexDispatchGate(forgedException).allowed, false, "不完整或伪造的ExceptionCase不能绕过派发门禁");
  const derived = buildExecutionRuntimeView({ lifecycleV11: { skuPackage: { businessPhase: "C1" } }, dataRevision: 4 });
  assert.equal(derived.executorType, "software");
  assert.equal(derived.legacyReadOnly, false);
  const legacy = buildExecutionRuntimeView({ workflowStatus: "codex_processing", processing: { currentStep: "M04" }, dataRevision: 2 });
  assert.equal(legacy.legacyReadOnly, true);
  assert.equal(legacy.executorType, null);
  const legacyGate = codexDispatchGate({ workflowStatus: "codex_processing", processing: { currentStep: "M04" } });
  assert.equal(legacyGate.allowed, false);
  assert.equal(legacyGate.mode, "legacy_read_only");
});


test("local keyword handoff recovery preserves the exact failure and rejects unrelated or unknown stops", () => {
  const blocked = blockExecutionForTechnicalFailure(createSoftwareExecutionRuntime({
    candidateId: "SIM-1", dataRevision: 8, businessPhase: "C1", stepId: "C1_KEYWORD_HANDOFF", at
  }), { failureId: "failure:keyword-handoff", softwareJobId: "job:keyword", sourceRevision: 7,
    kind: "known_technical_failure", errorCode: "C1_DRAFT_RUNTIME_UNAVAILABLE", failureLayer: "c1_keyword_handoff",
    evidenceRefs: ["result:keyword"], at });
  const args = { failureId: "failure:keyword-handoff", softwareJobId: "job:keyword", errorCode: "C1_DRAFT_RUNTIME_UNAVAILABLE", at };
  const original = structuredClone(blocked);
  const result = recoverC1KeywordHandoffTechnicalFailure(blocked, args);
  assert.deepEqual(blocked, original);
  assert.deepEqual(result.priorTechnicalFailure, original.technicalFailure);
  assert.equal(result.runtime.technicalFailure, null);
  assert.equal(result.runtime.status, "waiting_owner");
  assert.deepEqual(result.runtime.history.slice(0, -1), original.history);
  assert.equal(result.runtime.history.at(-1).type, "c1_keyword_handoff_recovered");
  assert.equal(result.runtime.history.at(-1).detail, args.failureId);
  assert.equal(validateExecutionRuntime(result.runtime).valid, true);
  for (const mutate of [
    value => { value.technicalFailure.kind = "unknown_outcome"; },
    value => { value.technicalFailure.errorCode = "NETWORK_TIMEOUT"; },
    value => { value.technicalFailure.failureLayer = "c1_keyword_query"; },
    value => { value.technicalFailure.softwareJobId = "job:other"; },
    value => { value.technicalFailure.failureId = "failure:other"; },
    value => { value.technicalFailure.candidateId = "OTHER"; },
    value => { value.technicalFailure.businessStateChanged = true; },
    value => { value.businessPhase = "D"; },
    value => { value.technicalFailure.stoppedAt = "2026-08-23T00:00:00.000Z"; }
  ]) {
    const changed = structuredClone(blocked); mutate(changed);
    assert.throws(() => recoverC1KeywordHandoffTechnicalFailure(changed, args), /C1_KEYWORD_HANDOFF_RECOVERY_REJECTED/);
  }
  const withCase = openExceptionCase(blocked, { exceptionId: "exception:other", reasonCode: "system_failure",
    failureLayer: "other", evidenceRefs: [], at });
  assert.throws(() => recoverC1KeywordHandoffTechnicalFailure(withCase, args), /C1_KEYWORD_HANDOFF_RECOVERY_REJECTED/);
  assert.throws(() => recoverC1KeywordHandoffTechnicalFailure(result.runtime, args), /C1_KEYWORD_HANDOFF_RECOVERY_REJECTED/);
});

test("formal B recovery consumes only the current exact-commission stop and preserves its full history", () => {
  const completed = completeExecutionStep(startSoftwareStep(createSoftwareExecutionRuntime({
    candidateId: "SIM-1", dataRevision: 7, businessPhase: "A", stepId: "A_CONFIRMATION", at
  }), { stepId: "B_DETERMINISTIC_PROFIT", inputRevision: 7, at }), { outputRevision: 8, at });
  completed.businessPhase = "B";
  const blocked = blockExecutionForTechnicalFailure(completed, {
    failureId: "failure:b-exact", sourceRevision: 8, kind: "external_dependency",
    errorCode: "B_EXACT_COMMISSION_REQUIRED", failureLayer: "b_commission_evidence", evidenceRefs: ["fee:estimated"], at
  });
  const args = { failureId: "failure:b-exact", candidateId: "SIM-1", sourceRevision: 8, at };
  const original = structuredClone(blocked);
  const result = recoverBExactCommissionTechnicalFailure(blocked, args);
  assert.deepEqual(blocked, original);
  assert.deepEqual(result.priorTechnicalFailure, original.technicalFailure);
  assert.equal(result.runtime.dataRevision, 7, "preserve the producer's historical runtime revision");
  assert.equal(result.runtime.outputRevision, 8);
  assert.equal(result.runtime.technicalFailure, null);
  assert.equal(result.runtime.status, "waiting_owner");
  assert.deepEqual(result.runtime.history.slice(0, -1), original.history);
  assert.deepEqual(result.runtime.history.at(-1), {
    type: "b_exact_commission_evidence_recovered", at, executorType: "software", detail: args.failureId
  });
  assert.equal(validateExecutionRuntime(result.runtime).valid, true);
  const finished = completeExecutionStep(startSoftwareStep(result.runtime, {
    stepId: "B_DETERMINISTIC_PROFIT", inputRevision: 8, at
  }), { outputRevision: 9, at });
  assert.equal(finished.status, "completed");
  assert.deepEqual(result.priorTechnicalFailure, original.technicalFailure);
  for (const mutate of [
    value => { value.candidateId = "OTHER"; },
    value => { value.businessPhase = "C1"; },
    value => { value.stepId = "OTHER"; },
    value => { value.executorType = "owner"; },
    value => { value.outputRevision = 7; },
    value => { value.inputRevision = 6; },
    value => { value.dataRevision = 9; },
    value => { value.technicalFailure.failureId = "other"; },
    value => { value.technicalFailure.candidateId = "OTHER"; },
    value => { value.technicalFailure.sourceRevision = 7; },
    value => { value.technicalFailure.businessPhase = "C1"; },
    value => { value.technicalFailure.stepId = "OTHER"; },
    value => { value.technicalFailure.softwareJobId = "job:paid"; },
    value => { value.technicalFailure.kind = "unknown_outcome"; },
    value => { value.technicalFailure.kind = "known_technical_failure"; },
    value => { value.technicalFailure.failureLayer = "network"; },
    value => { value.technicalFailure.errorCode = "OTHER"; },
    value => { value.technicalFailure.businessStateChanged = true; },
    value => { value.technicalFailure.stoppedAt = "2026-08-23T00:00:00.000Z"; }
  ]) {
    const changed = structuredClone(blocked); mutate(changed);
    assert.throws(() => recoverBExactCommissionTechnicalFailure(changed, args), /B_EXACT_COMMISSION_RECOVERY_REJECTED/);
  }
  for (const overrides of [{ candidateId: "OTHER" }, { failureId: "other" }, { sourceRevision: 9 }]) {
    assert.throws(() => recoverBExactCommissionTechnicalFailure(blocked, { ...args, ...overrides }), /B_EXACT_COMMISSION_RECOVERY_REJECTED/);
  }
  const withCase = openExceptionCase(blocked, {
    exceptionId: "exception:other", reasonCode: "system_failure", failureLayer: "other", evidenceRefs: [], at
  });
  assert.throws(() => recoverBExactCommissionTechnicalFailure(withCase, args), /B_EXACT_COMMISSION_RECOVERY_REJECTED/);
  assert.throws(() => recoverBExactCommissionTechnicalFailure(result.runtime, args), /B_EXACT_COMMISSION_RECOVERY_REJECTED/);
});

test("AI 辅助整理留下的那种阻断只解它自己：存档原记录，等主人；别的阻断、维护中的异常一律不碰", () => {
  const terraFailure = blockExecutionForTechnicalFailure(runtime(), {
    failureId: "technical-failure:SIM-1:7:a-terra", kind: "unknown_outcome", errorCode: "A_TERRA_GATEWAY_TIMEOUT",
    failureLayer: "inference", evidenceRefs: ["sales-snapshot:1"], softwareJobId: "inf-1", sourceRevision: 7, at
  });
  const before = structuredClone(terraFailure);
  const released = releaseATerraAssistBlock(terraFailure, { at: "2026-08-22T02:00:00.000Z" });
  assert.deepEqual(terraFailure, before, "不改动传进来的记录");
  assert.deepEqual(released.releasedTechnicalFailure, before.technicalFailure);
  assert.equal(released.releasedExceptionCase, null);
  assert.equal(released.runtime.technicalFailure, null);
  assert.equal(released.runtime.status, "waiting_owner");
  assert.equal(released.runtime.executorType, "owner");
  assert.equal(validateExecutionRuntime(released.runtime).valid, true);
  assert.deepEqual(released.runtime.history.at(-1),
    { type: "a_terra_assist_block_released", at: "2026-08-22T02:00:00.000Z", executorType: "software", detail: "technical-failure:SIM-1:7:a-terra" });
  // 解开之后下一步照常能开始，不再撞上 EXECUTION_BLOCKED_BY_TECHNICAL_FAILURE。
  assert.equal(startSoftwareStep(released.runtime, { stepId: "B_DETERMINISTIC_PROFIT", inputRevision: 8, at }).status, "running");

  const terraException = openExceptionCase(runtime(), {
    exceptionId: "exception:SIM-1:7:a-terra", reasonCode: "output_schema_mismatch", failureLayer: "output_schema",
    evidenceRefs: ["sales-snapshot:1"], sourceRevision: 7, at
  });
  const exceptionReleased = releaseATerraAssistBlock(terraException, { at });
  assert.equal(exceptionReleased.runtime.exceptionCase, null);
  assert.equal(exceptionReleased.releasedExceptionCase.exceptionId, "exception:SIM-1:7:a-terra");
  assert.equal(exceptionReleased.runtime.status, "waiting_owner");

  // AI 的异常压在另一条正常的技术停止上：只拿走 AI 那条，另一条连同 blocked 原样留着。
  const otherStop = blockExecutionForTechnicalFailure(runtime(), {
    failureId: "b-exact-commission-required:SIM-1:8", kind: "external_dependency", errorCode: "B_EXACT_COMMISSION_REQUIRED",
    failureLayer: "b_commission_evidence", evidenceRefs: [], sourceRevision: 8, at
  });
  const stacked = openExceptionCase(otherStop, {
    exceptionId: "exception:SIM-1:7:a-terra", reasonCode: "output_schema_mismatch", failureLayer: "output_schema",
    evidenceRefs: [], sourceRevision: 7, at
  });
  const partly = releaseATerraAssistBlock(stacked, { at });
  assert.equal(partly.runtime.exceptionCase, null);
  assert.deepEqual(partly.runtime.technicalFailure, otherStop.technicalFailure);
  assert.equal(partly.runtime.status, "blocked");
  assert.equal(partly.releasedTechnicalFailure, null);

  assert.equal(releaseATerraAssistBlock(otherStop, { at }), null, "别的技术停止不归它解");
  assert.equal(releaseATerraAssistBlock(runtime(), { at }), null);
  assert.equal(releaseATerraAssistBlock(null, { at }), null);
  assert.equal(releaseATerraAssistBlock(undefined, { at }), null);
  const maintained = authorizeExceptionMaintenance(terraException, {
    exceptionId: "exception:SIM-1:7:a-terra", maintenanceAuthorizationId: "maintenance:1", at
  });
  assert.equal(releaseATerraAssistBlock(maintained, { at }), null, "已经交给维护的异常不在这里解");
  const changedCandidate = structuredClone(terraFailure);
  changedCandidate.technicalFailure.failureId = "technical-failure:OTHER:7:a-terra";
  assert.equal(releaseATerraAssistBlock(changedCandidate, { at }), null, "编号必须是这件商品自己的");
  const businessChanged = structuredClone(terraFailure);
  businessChanged.technicalFailure.businessStateChanged = true;
  assert.equal(releaseATerraAssistBlock(businessChanged, { at }), null);
  assert.throws(() => releaseATerraAssistBlock({ ...terraFailure, schemaVersion: "old" }, { at }), /EXECUTION_CONTRACT_INVALID/);
});
