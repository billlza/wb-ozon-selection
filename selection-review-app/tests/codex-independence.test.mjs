import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExceptionCaseMaintenanceBoundary,
  assertNormalProductionCodexIndependent,
  assertRuntimeCodexDependencyAllowed,
  CODEX_INDEPENDENCE_INVARIANTS,
  CODEX_OFFLINE_MODE,
  CURRENT_CODEX_INDEPENDENCE_AUDIT,
  EXCEPTION_MAINTENANCE_PATH,
  NORMAL_PRODUCTION_CODEX_DEPENDENCY_ERROR,
  NORMAL_PRODUCTION_CODEX_DEPENDENCY_TYPES,
  NORMAL_PRODUCTION_PATH,
  SOFTWARE_LIFECYCLE_AUDIT_PHASES,
  codexOfflineModeFromEnvironment,
  dispatchDeliveryEnabledFromEnvironment,
  validateSoftwareLifecycleCodexIndependenceAudit
} from "../lib/codex-independence.mjs";

const SKU = "sku:music-box:offline";

function dependency(type, required = true) {
  return { type, required, evidenceRef: `audit:${type}` };
}

function phase(phaseName, completionStatus = "software_complete", codexDependencies = []) {
  return {
    phase: phaseName,
    completionStatus,
    codexDependencies,
    evidenceRefs: completionStatus === "software_complete" ? [`evidence:${phaseName}`] : []
  };
}

test("正式不变量锁定正常生产零Codex依赖与ExceptionCase非业务替代边界", () => {
  assert.deepEqual(NORMAL_PRODUCTION_CODEX_DEPENDENCY_TYPES, [
    "dispatch", "wait", "queue_consumer", "api", "browser", "stage_advance", "result_required"
  ]);
  assert.deepEqual(SOFTWARE_LIFECYCLE_AUDIT_PHASES, ["A", "B", "C1", "C2", "D", "E"]);
  assert.equal(CODEX_INDEPENDENCE_INVARIANTS.normalProductionCodexDependencyCount, 0);
  assert.equal(CODEX_INDEPENDENCE_INVARIANTS.exceptionCaseMayAdvanceBusinessStage, false);
  assert.equal(CODEX_INDEPENDENCE_INVARIANTS.exceptionCaseMaySupplyRequiredBusinessResult, false);
});

test("CODEX_OFFLINE下正常SKU对七类依赖全部fail-fast并保留统一错误消息", () => {
  for (const type of NORMAL_PRODUCTION_CODEX_DEPENDENCY_TYPES) {
    assert.throws(
      () => assertNormalProductionCodexIndependent({
        executionMode: CODEX_OFFLINE_MODE,
        pathType: NORMAL_PRODUCTION_PATH,
        skuPackageId: SKU,
        codexDependencies: [dependency(type)]
      }),
      (error) => error.code === "NORMAL_PRODUCTION_CODEX_DEPENDENCY_FORBIDDEN" &&
        error.dependencyType === type && error.message.includes(NORMAL_PRODUCTION_CODEX_DEPENDENCY_ERROR)
    );
  }
});

test("运行环境门禁默认关闭，显式CODEX_OFFLINE=true后正常路径依赖立即失败", () => {
  assert.equal(codexOfflineModeFromEnvironment({}), false);
  assert.equal(codexOfflineModeFromEnvironment({ CODEX_OFFLINE: "true" }), true);
  assert.throws(() => assertRuntimeCodexDependencyAllowed({
    codexOffline: true,
    pathType: NORMAL_PRODUCTION_PATH,
    skuPackageId: SKU,
    dependencyType: "dispatch",
    evidenceRef: "runtime:dispatch"
  }), new RegExp(NORMAL_PRODUCTION_CODEX_DEPENDENCY_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(assertRuntimeCodexDependencyAllowed({
    codexOffline: true,
    pathType: EXCEPTION_MAINTENANCE_PATH,
    skuPackageId: SKU,
    dependencyType: "dispatch",
    evidenceRef: "runtime:maintenance"
  }).allowed, true);
});

test("旧派发通道开关必须两个显式开关同时打开且未进入CODEX_OFFLINE", () => {
  assert.equal(dispatchDeliveryEnabledFromEnvironment({}), false);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    CODEX_OFFLINE: "true",
    SELECTION_REVIEW_CODEX_DISPATCH: "off",
    SELECTION_REVIEW_AUTO_DELIVER: "off"
  }), false, "正式生产环境必须保持关闭");
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    SELECTION_REVIEW_CODEX_DISPATCH: "on",
    SELECTION_REVIEW_AUTO_DELIVER: "on"
  }), true);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({ SELECTION_REVIEW_CODEX_DISPATCH: "on" }), false);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({ SELECTION_REVIEW_AUTO_DELIVER: "on" }), false);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    SELECTION_REVIEW_CODEX_DISPATCH: "on",
    SELECTION_REVIEW_AUTO_DELIVER: "off"
  }), false);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    CODEX_OFFLINE: "true",
    SELECTION_REVIEW_CODEX_DISPATCH: "on",
    SELECTION_REVIEW_AUTO_DELIVER: "on"
  }), false, "CODEX_OFFLINE优先于任何派发开关");
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    SELECTION_REVIEW_CODEX_DISPATCH: "TRUE",
    SELECTION_REVIEW_AUTO_DELIVER: " on "
  }), true);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    SELECTION_REVIEW_CODEX_DISPATCH: " On ",
    SELECTION_REVIEW_AUTO_DELIVER: "True"
  }), true);
  assert.equal(dispatchDeliveryEnabledFromEnvironment({
    SELECTION_REVIEW_CODEX_DISPATCH: "yes",
    SELECTION_REVIEW_AUTO_DELIVER: "on"
  }), false);
});

test("正常SKU只有所有依赖均为非必需时才证明软件独立", () => {
  const result = assertNormalProductionCodexIndependent({
    executionMode: CODEX_OFFLINE_MODE,
    pathType: NORMAL_PRODUCTION_PATH,
    skuPackageId: SKU,
    codexDependencies: NORMAL_PRODUCTION_CODEX_DEPENDENCY_TYPES.map((type) => dependency(type, false))
  });
  assert.deepEqual([result.status, result.activeCodexDependencies, result.businessAdvanceAuthority], ["independent", 0, "software_state_machine"]);
  assert.equal(Object.isFrozen(result), true);
});

test("ExceptionCase仅允许开发维护，不能推进阶段或提供必需业务结果", () => {
  const maintenance = assertExceptionCaseMaintenanceBoundary({
    pathType: EXCEPTION_MAINTENANCE_PATH,
    exceptionCaseId: "exception:music-box:1",
    action: "diagnose"
  });
  assert.equal(maintenance.normalProductionPath, false);
  assert.equal(maintenance.advancesBusinessStage, false);
  assert.throws(() => assertExceptionCaseMaintenanceBoundary({
    pathType: EXCEPTION_MAINTENANCE_PATH,
    exceptionCaseId: "exception:music-box:1",
    action: "repair_code",
    advancesBusinessStage: true
  }), /BUSINESS_SUBSTITUTION_FORBIDDEN/);
  assert.throws(() => assertExceptionCaseMaintenanceBoundary({
    pathType: EXCEPTION_MAINTENANCE_PATH,
    exceptionCaseId: "exception:music-box:1",
    action: "verify_recovery",
    suppliesRequiredBusinessResult: true
  }), /BUSINESS_SUBSTITUTION_FORBIDDEN/);
  assert.throws(() => assertExceptionCaseMaintenanceBoundary({
    pathType: EXCEPTION_MAINTENANCE_PATH,
    exceptionCaseId: "exception:music-box:1",
    action: "advance_business_stage"
  }), /INPUT_INVALID/);
});

test("A到E全部零依赖且有证据时审计可标记software_complete", () => {
  const result = validateSoftwareLifecycleCodexIndependenceAudit({
    executionMode: CODEX_OFFLINE_MODE,
    skuPackageId: SKU,
    phases: SOFTWARE_LIFECYCLE_AUDIT_PHASES.map((name) => phase(name))
  });
  assert.equal(result.status, "software_complete");
  assert.equal(result.normalProductionCodexDependencyCount, 0);
  assert.deepEqual(result.incompletePhases, []);
});

test("有残余依赖的阶段只能保持not_complete，冒充software_complete立即拒绝", () => {
  const incomplete = SOFTWARE_LIFECYCLE_AUDIT_PHASES.map((name) =>
    name === "C1" ? phase(name, "not_complete", [dependency("result_required")]) : phase(name)
  );
  const result = validateSoftwareLifecycleCodexIndependenceAudit({ executionMode: CODEX_OFFLINE_MODE, skuPackageId: SKU, phases: incomplete });
  assert.equal(result.status, "not_complete");
  assert.deepEqual(result.incompletePhases, ["C1"]);
  assert.equal(result.normalProductionCodexDependencyCount, 1);

  const disguised = SOFTWARE_LIFECYCLE_AUDIT_PHASES.map((name) =>
    name === "D" ? phase(name, "software_complete", [dependency("browser")]) : phase(name)
  );
  assert.throws(
    () => validateSoftwareLifecycleCodexIndependenceAudit({ executionMode: CODEX_OFFLINE_MODE, skuPackageId: SKU, phases: disguised }),
    (error) => error.phase === "D" && error.message.includes(NORMAL_PRODUCTION_CODEX_DEPENDENCY_ERROR)
  );
});

test("审计清单必须精确覆盖A/B/C1/C2/D/E且完成态必须有证据", () => {
  const missing = SOFTWARE_LIFECYCLE_AUDIT_PHASES.slice(0, -1).map((name) => phase(name));
  assert.throws(() => validateSoftwareLifecycleCodexIndependenceAudit({ executionMode: CODEX_OFFLINE_MODE, skuPackageId: SKU, phases: missing }), /AUDIT_INPUT_INVALID/);

  const duplicate = SOFTWARE_LIFECYCLE_AUDIT_PHASES.map((name) => phase(name));
  duplicate[5] = phase("D");
  assert.throws(() => validateSoftwareLifecycleCodexIndependenceAudit({ executionMode: CODEX_OFFLINE_MODE, skuPackageId: SKU, phases: duplicate }), /AUDIT_PHASE_INVALID/);

  const noEvidence = SOFTWARE_LIFECYCLE_AUDIT_PHASES.map((name) => phase(name));
  noEvidence[1].evidenceRefs = [];
  assert.throws(() => validateSoftwareLifecycleCodexIndependenceAudit({ executionMode: CODEX_OFFLINE_MODE, skuPackageId: SKU, phases: noEvidence }), /AUDIT_EVIDENCE_REQUIRED:B/);
});

test("当前真实审计不得把缺自动发现的A及C1、D、E冒充为已完成软件化", () => {
  const result = validateSoftwareLifecycleCodexIndependenceAudit({
    executionMode: CODEX_OFFLINE_MODE,
    skuPackageId: SKU,
    phases: CURRENT_CODEX_INDEPENDENCE_AUDIT
  });
  assert.equal(result.status, "not_complete");
  assert.deepEqual(result.incompletePhases, ["A", "C1", "D", "E"]);
  assert.deepEqual(result.phases.filter((entry) => entry.completionStatus === "software_complete").map((entry) => entry.phase), ["B", "C2"]);
  for (const entry of CURRENT_CODEX_INDEPENDENCE_AUDIT) {
    assert.deepEqual(Object.keys(entry.executionAudit), [
      "nextStepTrigger", "inputProducer", "externalExecutor", "aiExecutor", "resultWriter",
      "continuationAuthority", "codexOfflineCanComplete", "residualDependency", "dependencyClass"
    ]);
    assert.equal(entry.executionAudit.codexOfflineCanComplete, entry.completionStatus === "software_complete");
    assert.equal(entry.executionAudit.dependencyClass,
      entry.completionStatus === "software_complete" ? "development_maintenance_only" : "normal_production_dependency");
  }
});
