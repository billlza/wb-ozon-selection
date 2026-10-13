export const EXECUTION_RUNTIME_VERSION = "software-execution-runtime-v1";

export const EXECUTOR_TYPES = Object.freeze([
  "software",
  "third_party_ai",
  "codex_exception",
  "owner"
]);

export const EXECUTION_STATUSES = Object.freeze([
  "not_started",
  "queued",
  "running",
  "completed",
  "blocked",
  "waiting_owner"
]);

export const EXCEPTION_REASONS = Object.freeze([
  "evidence_conflict",
  "output_schema_mismatch",
  "permission_required",
  "system_failure"
]);

export const TECHNICAL_FAILURE_KINDS = Object.freeze([
  "external_dependency",
  "known_technical_failure",
  "unknown_outcome"
]);

const NEW_EXCEPTION_REASONS = new Set([
  "evidence_conflict",
  "output_schema_mismatch",
  "system_failure"
]);

const SAFE_EXCEPTION_MESSAGES = Object.freeze({
  evidence_conflict: "证据存在无法由当前软件规则解决的冲突。",
  output_schema_mismatch: "严格输出结构或回执身份与当前规则不一致。",
  system_failure: "软件出现当前规则无法分类的内部异常，需要技术维护。"
});

const SAFE_TECHNICAL_FAILURE_MESSAGES = Object.freeze({
  external_dependency: "外部服务当前不可用，软件已安全停止且不会自动重试。",
  known_technical_failure: "已知技术条件未满足，软件已记录原因并安全停止。",
  unknown_outcome: "外部请求是否完成无法确定，软件已停止且禁止重复执行。"
});

function text(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`EXECUTION_CONTRACT_INVALID: ${label}不能为空`);
  return normalized;
}

function revision(value, label = "dataRevision") {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`EXECUTION_CONTRACT_INVALID: ${label}必须是非负整数`);
  }
  return value;
}

function time(value, label) {
  const normalized = text(value, label);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`EXECUTION_CONTRACT_INVALID: ${label}必须是有效时间`);
  return normalized;
}

function refs(value, label = "evidenceRefs") {
  if (!Array.isArray(value)) throw new Error(`EXECUTION_CONTRACT_INVALID: ${label}必须是数组`);
  const normalized = value.map((item) => {
    const normalizedItem = text(item, label);
    if (/(?:authorization|bearer|cookie|password|api[_-]?key|secret|token)\s*(?:=|:)/i.test(normalizedItem)) {
      throw new Error(`EXECUTION_CONTRACT_INVALID: ${label}不得包含秘密`);
    }
    return normalizedItem;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`EXECUTION_CONTRACT_INVALID: ${label}不能重复`);
  return normalized;
}

function optionalText(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return text(value, label);
}

function historyEvent(type, at, executorType, detail) {
  return { type, at, executorType, detail: String(detail || "").trim() };
}

export function createSoftwareExecutionRuntime({
  candidateId,
  dataRevision,
  businessPhase = "A",
  stepId = "A_ENTRY",
  at
}) {
  const timestamp = time(at, "at");
  return {
    schemaVersion: EXECUTION_RUNTIME_VERSION,
    candidateId: text(candidateId, "candidateId"),
    dataRevision: revision(dataRevision),
    businessPhase: text(businessPhase, "businessPhase"),
    executorType: "software",
    status: "not_started",
    stepId: text(stepId, "stepId"),
    inputRevision: revision(dataRevision, "inputRevision"),
    outputRevision: null,
    inferenceJobId: null,
    inferenceReceiptId: null,
    exceptionCase: null,
    technicalFailure: null,
    codexWakeupCount: 0,
    updatedAt: timestamp,
    history: [historyEvent("runtime_created", timestamp, "software", "软件状态机已建立，尚未执行商品任务")]
  };
}

export function validateExecutionRuntime(runtime) {
  const errors = [];
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return { valid: false, errors: ["runtime必须是对象"] };
  if (runtime.schemaVersion !== EXECUTION_RUNTIME_VERSION) errors.push("schemaVersion不匹配");
  if (!EXECUTOR_TYPES.includes(runtime.executorType)) errors.push("executorType无效");
  if (!EXECUTION_STATUSES.includes(runtime.status)) errors.push("status无效");
  if (!Number.isInteger(runtime.dataRevision) || runtime.dataRevision < 0) errors.push("dataRevision无效");
  if (!Number.isInteger(runtime.inputRevision) || runtime.inputRevision < 0) errors.push("inputRevision无效");
  if (!(runtime.outputRevision === null || (Number.isInteger(runtime.outputRevision) && runtime.outputRevision >= 0))) errors.push("outputRevision无效");
  if (!Number.isInteger(runtime.codexWakeupCount) || runtime.codexWakeupCount < 0) errors.push("codexWakeupCount无效");
  if (!Array.isArray(runtime.history)) errors.push("history必须是数组");
  const technicalFailure = runtime.technicalFailure;
  if (technicalFailure !== null && technicalFailure !== undefined) {
    if (!technicalFailure || typeof technicalFailure !== "object" || Array.isArray(technicalFailure)) errors.push("technicalFailure无效");
    else {
      if (!TECHNICAL_FAILURE_KINDS.includes(technicalFailure.kind)) errors.push("technicalFailure.kind无效");
      if (technicalFailure.status !== "stopped") errors.push("technicalFailure.status无效");
      if (technicalFailure.automaticRetryAllowed !== false) errors.push("technicalFailure禁止自动重试");
      if (runtime.status !== "blocked") errors.push("技术失败必须处于blocked");
    }
  }
  const exception = runtime.exceptionCase;
  if (exception !== null) {
    if (!exception || typeof exception !== "object" || Array.isArray(exception)) errors.push("exceptionCase无效");
    else {
      if (!EXCEPTION_REASONS.includes(exception.reasonCode)) errors.push("exceptionCase.reasonCode无效");
      if (!['open', 'resolved'].includes(exception.status)) errors.push("exceptionCase.status无效");
      if (!Array.isArray(exception.evidenceRefs)) errors.push("exceptionCase.evidenceRefs必须是数组");
      if (exception.status === "open" && runtime.status !== "blocked") {
        errors.push("开放异常必须处于blocked");
      }
      if (exception.schemaVersion === "exception-case-v2") {
        if (!['not_dispatched', 'queued', 'running', 'settled'].includes(exception.dispatchState)) errors.push("exceptionCase.dispatchState无效");
        if (exception.automaticRetryAllowed !== false) errors.push("exceptionCase禁止自动重试");
        if (exception.dispatchState === "running" && (!exception.turnId || runtime.executorType !== "codex_exception")) {
          errors.push("Codex维护运行必须绑定turnId");
        }
      } else if (exception.status === "open" && runtime.executorType !== "codex_exception") {
        errors.push("旧开放异常必须由Codex异常介入");
      }
    }
  }
  if (runtime.executorType === "third_party_ai" && runtime.status === "running" && !runtime.inferenceJobId) {
    errors.push("第三方AI运行时必须锁定inferenceJobId");
  }
  return { valid: errors.length === 0, errors };
}

function checked(runtime) {
  const result = validateExecutionRuntime(runtime);
  if (!result.valid) throw new Error(`EXECUTION_CONTRACT_INVALID: ${result.errors[0]}`);
  return structuredClone(runtime);
}

export function startSoftwareStep(runtime, { stepId, inputRevision, at }) {
  const next = checked(runtime);
  if (next.exceptionCase?.status === "open") throw new Error("EXECUTION_BLOCKED_BY_EXCEPTION");
  if (next.technicalFailure?.status === "stopped") throw new Error("EXECUTION_BLOCKED_BY_TECHNICAL_FAILURE");
  next.executorType = "software";
  next.status = "running";
  next.stepId = text(stepId, "stepId");
  next.inputRevision = revision(inputRevision, "inputRevision");
  next.outputRevision = null;
  next.inferenceJobId = null;
  next.inferenceReceiptId = null;
  next.updatedAt = time(at, "at");
  next.history.push(historyEvent("software_step_started", next.updatedAt, "software", next.stepId));
  return next;
}

export function startThirdPartyAiStep(runtime, { stepId, inputRevision, inferenceJobId, at }) {
  const next = checked(runtime);
  if (next.exceptionCase?.status === "open") throw new Error("EXECUTION_BLOCKED_BY_EXCEPTION");
  if (next.technicalFailure?.status === "stopped") throw new Error("EXECUTION_BLOCKED_BY_TECHNICAL_FAILURE");
  next.executorType = "third_party_ai";
  next.status = "running";
  next.stepId = text(stepId, "stepId");
  next.inputRevision = revision(inputRevision, "inputRevision");
  next.outputRevision = null;
  next.inferenceJobId = text(inferenceJobId, "inferenceJobId");
  next.inferenceReceiptId = null;
  next.updatedAt = time(at, "at");
  next.history.push(historyEvent("third_party_ai_started", next.updatedAt, "third_party_ai", next.inferenceJobId));
  return next;
}

export function completeExecutionStep(runtime, { outputRevision, inferenceReceiptId = null, at }) {
  const next = checked(runtime);
  if (next.status !== "running") throw new Error("EXECUTION_NOT_RUNNING");
  if (next.executorType === "third_party_ai" && !inferenceReceiptId) throw new Error("INFERENCE_RECEIPT_REQUIRED");
  next.status = "completed";
  next.outputRevision = revision(outputRevision, "outputRevision");
  next.inferenceReceiptId = inferenceReceiptId ? text(inferenceReceiptId, "inferenceReceiptId") : null;
  next.updatedAt = time(at, "at");
  next.history.push(historyEvent("step_completed", next.updatedAt, next.executorType, next.stepId));
  return next;
}

export function waitForOwner(runtime, { stepId, inputRevision, at, detail = "等待主人商业判断" }) {
  const next = checked(runtime);
  if (next.exceptionCase?.status === "open") throw new Error("EXECUTION_BLOCKED_BY_EXCEPTION");
  if (next.technicalFailure?.status === "stopped") throw new Error("EXECUTION_BLOCKED_BY_TECHNICAL_FAILURE");
  next.executorType = "owner";
  next.status = "waiting_owner";
  next.stepId = text(stepId, "stepId");
  next.inputRevision = revision(inputRevision, "inputRevision");
  next.outputRevision = null;
  next.inferenceJobId = null;
  next.inferenceReceiptId = null;
  next.updatedAt = time(at, "at");
  next.history.push(historyEvent("owner_decision_required", next.updatedAt, "owner", detail));
  return next;
}

export function openExceptionCase(runtime, {
  exceptionId,
  reasonCode,
  failureLayer,
  evidenceRefs,
  skuPackageId = null,
  softwareJobId = null,
  lastSuccessfulStepId = null,
  externalRequestRefs = [],
  unknownOutcome = false,
  sourceRevision = null,
  at
}) {
  const next = checked(runtime);
  if (next.exceptionCase?.status === "open") throw new Error("EXCEPTION_CASE_ALREADY_OPEN");
  if (!NEW_EXCEPTION_REASONS.has(reasonCode)) throw new Error("EXCEPTION_REASON_NOT_ALLOWED");
  const timestamp = time(at, "at");
  next.exceptionCase = {
    schemaVersion: "exception-case-v2",
    exceptionId: text(exceptionId, "exceptionId"),
    candidateId: next.candidateId,
    skuPackageId: optionalText(skuPackageId, "skuPackageId"),
    sourceRevision: sourceRevision === null ? next.dataRevision : revision(sourceRevision, "sourceRevision"),
    businessPhase: next.businessPhase,
    softwareJobId: optionalText(softwareJobId || next.inferenceJobId, "softwareJobId"),
    stepId: next.stepId,
    lastSuccessfulStepId: optionalText(lastSuccessfulStepId, "lastSuccessfulStepId"),
    businessStateChanged: false,
    reasonCode,
    failureLayer: text(failureLayer, "failureLayer"),
    evidenceRefs: refs(evidenceRefs),
    externalRequestRefs: refs(externalRequestRefs, "externalRequestRefs"),
    unknownOutcome: unknownOutcome === true,
    automaticRetryAllowed: false,
    forbiddenAutomaticActions: ["retry", "change_model", "change_path", "advance_business_stage"],
    safeMessageKey: `exception.${reasonCode}`,
    message: SAFE_EXCEPTION_MESSAGES[reasonCode],
    dispatchState: "not_dispatched",
    maintenanceAuthorizationId: null,
    turnId: null,
    status: "open",
    openedAt: timestamp,
    resolvedAt: null
  };
  next.executorType = "software";
  next.status = "blocked";
  next.updatedAt = timestamp;
  next.history.push(historyEvent("exception_opened", timestamp, "software", reasonCode));
  return next;
}

export function blockExecutionForTechnicalFailure(runtime, {
  failureId,
  kind,
  errorCode,
  failureLayer,
  evidenceRefs = [],
  softwareJobId = null,
  sourceRevision = null,
  at
}) {
  const next = checked(runtime);
  if (!TECHNICAL_FAILURE_KINDS.includes(kind)) throw new Error("TECHNICAL_FAILURE_KIND_NOT_ALLOWED");
  if (next.exceptionCase?.status === "open") throw new Error("EXECUTION_BLOCKED_BY_EXCEPTION");
  const timestamp = time(at, "at");
  next.executorType = "software";
  next.status = "blocked";
  next.technicalFailure = {
    schemaVersion: "technical-failure-record-v1",
    failureId: text(failureId, "failureId"),
    candidateId: next.candidateId,
    sourceRevision: sourceRevision === null ? next.dataRevision : revision(sourceRevision, "sourceRevision"),
    businessPhase: next.businessPhase,
    stepId: next.stepId,
    softwareJobId: optionalText(softwareJobId, "softwareJobId"),
    kind,
    errorCode: text(errorCode, "errorCode"),
    failureLayer: text(failureLayer, "failureLayer"),
    evidenceRefs: refs(evidenceRefs),
    safeMessageKey: `technical_failure.${kind}`,
    message: SAFE_TECHNICAL_FAILURE_MESSAGES[kind],
    businessStateChanged: false,
    automaticRetryAllowed: false,
    status: "stopped",
    stoppedAt: timestamp
  };
  next.updatedAt = timestamp;
  next.history.push(historyEvent("technical_failure_stopped", timestamp, "software", `${kind}:${errorCode}`));
  return next;
}

/** Only the explicit local handoff mutation may consume this recovery result. */
export function recoverC1KeywordHandoffTechnicalFailure(runtime, { failureId, softwareJobId, errorCode, at }) {
  const next = checked(runtime);
  const failure = next.technicalFailure;
  const timestamp = time(at, "at");
  if (next.exceptionCase?.status === "open" || next.status !== "blocked" || next.businessPhase !== "C1" ||
      next.stepId !== "C1_KEYWORD_HANDOFF" || !failure || failure.schemaVersion !== "technical-failure-record-v1" ||
      failure.failureId !== text(failureId, "failureId") || failure.softwareJobId !== text(softwareJobId, "softwareJobId") ||
      failure.candidateId !== next.candidateId || failure.businessPhase !== "C1" || failure.stepId !== "C1_KEYWORD_HANDOFF" ||
      failure.kind !== "known_technical_failure" || failure.status !== "stopped" ||
      failure.failureLayer !== "c1_keyword_handoff" || errorCode !== "C1_DRAFT_RUNTIME_UNAVAILABLE" || failure.errorCode !== errorCode ||
      failure.automaticRetryAllowed !== false || failure.businessStateChanged !== false ||
      !Number.isFinite(Date.parse(failure.stoppedAt)) || Date.parse(timestamp) < Date.parse(failure.stoppedAt)) {
    throw new Error("C1_KEYWORD_HANDOFF_RECOVERY_REJECTED");
  }
  const priorTechnicalFailure = structuredClone(failure);
  next.technicalFailure = null;
  next.executorType = "software";
  next.status = "waiting_owner";
  next.updatedAt = timestamp;
  next.history.push(historyEvent("c1_keyword_handoff_recovered", timestamp, "software", failure.failureId));
  return { runtime: next, priorTechnicalFailure };
}

/** Used only by the atomic formal B recalculation from saved exact evidence. */
export function recoverBExactCommissionTechnicalFailure(runtime, { failureId, candidateId, sourceRevision, at }) {
  const next = checked(runtime);
  const failure = next.technicalFailure;
  const timestamp = time(at, "at");
  const currentRevision = revision(sourceRevision, "sourceRevision");
  if (next.exceptionCase?.status === "open" || next.status !== "blocked" || next.executorType !== "software" ||
      next.candidateId !== text(candidateId, "candidateId") || next.businessPhase !== "B" || next.stepId !== "B_DETERMINISTIC_PROFIT" ||
      next.outputRevision !== currentRevision || next.inputRevision !== currentRevision - 1 || next.dataRevision > next.inputRevision ||
      !failure || failure.schemaVersion !== "technical-failure-record-v1" ||
      failure.failureId !== text(failureId, "failureId") || failure.candidateId !== next.candidateId || failure.sourceRevision !== currentRevision ||
      failure.businessPhase !== "B" || failure.stepId !== "B_DETERMINISTIC_PROFIT" || failure.softwareJobId !== null ||
      failure.kind !== "external_dependency" || failure.status !== "stopped" ||
      failure.failureLayer !== "b_commission_evidence" || failure.errorCode !== "B_EXACT_COMMISSION_REQUIRED" ||
      failure.automaticRetryAllowed !== false || failure.businessStateChanged !== false ||
      !Number.isFinite(Date.parse(failure.stoppedAt)) || Date.parse(timestamp) < Date.parse(failure.stoppedAt)) {
    throw new Error("B_EXACT_COMMISSION_RECOVERY_REJECTED");
  }
  const priorTechnicalFailure = structuredClone(failure);
  next.technicalFailure = null;
  next.executorType = "software";
  next.status = "waiting_owner";
  next.updatedAt = timestamp;
  next.history.push(historyEvent("b_exact_commission_evidence_recovered", timestamp, "software", failure.failureId));
  return { runtime: next, priorTechnicalFailure };
}

function aTerraAssistFailure(runtime) {
  const failure = runtime?.technicalFailure;
  return failure?.status === "stopped" && failure.candidateId === runtime.candidateId && failure.businessStateChanged === false &&
    failure.failureId === `technical-failure:${runtime.candidateId}:${failure.sourceRevision}:a-terra`;
}

function aTerraAssistException(runtime) {
  const exception = runtime?.exceptionCase;
  return exception?.status === "open" && exception.schemaVersion === "exception-case-v2" &&
    exception.dispatchState === "not_dispatched" && exception.candidateId === runtime.candidateId &&
    exception.businessStateChanged === false &&
    exception.exceptionId === `exception:${runtime.candidateId}:${exception.sourceRevision}:a-terra`;
}

/**
 * Terra's A-stage assist only ever produced a reference draft, yet older builds recorded its failure as the whole product's
 * technical failure or ExceptionCase, which then refused A confirmation, B recalculation and C2 confirmation with no way out.
 * Only those records (ids ending in ":a-terra", never handed to maintenance) are taken out of the runtime and returned for
 * archiving; any other blocking record stays exactly where it is. Returns null when the runtime holds none of them.
 */
export function releaseATerraAssistBlock(runtime, { at }) {
  if (!aTerraAssistFailure(runtime) && !aTerraAssistException(runtime)) return null;
  const next = checked(runtime);
  const timestamp = time(at, "at");
  const releasedTechnicalFailure = aTerraAssistFailure(next) ? structuredClone(next.technicalFailure) : null;
  const releasedExceptionCase = aTerraAssistException(next) ? structuredClone(next.exceptionCase) : null;
  if (releasedTechnicalFailure) next.technicalFailure = null;
  if (releasedExceptionCase) next.exceptionCase = null;
  const stillBlocked = next.technicalFailure?.status === "stopped" || next.exceptionCase?.status === "open";
  if (!stillBlocked) {
    next.executorType = "owner";
    next.status = "waiting_owner";
  }
  next.updatedAt = timestamp;
  next.history.push(historyEvent("a_terra_assist_block_released", timestamp, "software",
    [releasedTechnicalFailure?.failureId, releasedExceptionCase?.exceptionId].filter(Boolean).join(" ")));
  return { runtime: next, releasedTechnicalFailure, releasedExceptionCase };
}

export function authorizeExceptionMaintenance(runtime, {
  exceptionId,
  maintenanceAuthorizationId,
  at
}) {
  const next = checked(runtime);
  const exception = next.exceptionCase;
  if (!exception || exception.schemaVersion !== "exception-case-v2" || exception.status !== "open" || exception.exceptionId !== exceptionId) {
    throw new Error("EXCEPTION_CASE_NOT_ACTIVE");
  }
  if (exception.dispatchState !== "not_dispatched") throw new Error("EXCEPTION_CASE_ALREADY_AUTHORIZED");
  exception.dispatchState = "queued";
  exception.maintenanceAuthorizationId = text(maintenanceAuthorizationId, "maintenanceAuthorizationId");
  exception.authorizedAt = time(at, "at");
  next.updatedAt = exception.authorizedAt;
  next.history.push(historyEvent("exception_maintenance_authorized", next.updatedAt, "owner", exception.exceptionId));
  return next;
}

export function recordExceptionMaintenanceStarted(runtime, {
  exceptionId,
  turnId,
  at
}) {
  const next = checked(runtime);
  const exception = next.exceptionCase;
  if (!exception || exception.status !== "open" || exception.exceptionId !== exceptionId || exception.dispatchState !== "queued") {
    throw new Error("EXCEPTION_CASE_NOT_QUEUED");
  }
  exception.dispatchState = "running";
  exception.turnId = text(turnId, "turnId");
  exception.startedAt = time(at, "at");
  next.executorType = "codex_exception";
  next.codexWakeupCount += 1;
  next.updatedAt = exception.startedAt;
  next.history.push(historyEvent("exception_maintenance_started", next.updatedAt, "codex_exception", exception.turnId));
  return next;
}

export function resolveExceptionCase(runtime, {
  exceptionId,
  resolutionCode,
  evidenceRefs = [],
  at
}) {
  const next = checked(runtime);
  const exception = next.exceptionCase;
  if (!exception || exception.status !== "open" || exception.exceptionId !== exceptionId) throw new Error("EXCEPTION_CASE_NOT_ACTIVE");
  exception.status = "resolved";
  exception.dispatchState = "settled";
  exception.resolutionCode = text(resolutionCode, "resolutionCode");
  exception.resolutionEvidenceRefs = refs(evidenceRefs, "resolutionEvidenceRefs");
  exception.resolvedAt = time(at, "at");
  next.executorType = "software";
  next.status = "blocked";
  next.updatedAt = exception.resolvedAt;
  next.history.push(historyEvent("exception_resolved", next.updatedAt, "software", resolutionCode));
  return next;
}

export function codexDispatchGate(candidate) {
  const hasLifecycle = Boolean(candidate?.lifecycleV11?.opportunityPackage || candidate?.lifecycleV11?.skuPackage);
  const runtime = candidate?.executionRuntime;
  if (!hasLifecycle && !runtime) {
    return {
      allowed: false,
      mode: "legacy_read_only",
      reason: "旧M04、Codex处理中和旧派发只保留历史读取，不能继续生成或恢复执行。"
    };
  }
  if (!runtime || !validateExecutionRuntime(runtime).valid) {
    return {
      allowed: false,
      mode: "software_normal_flow",
      reason: "Normal production path attempted Codex dependency. 新版商品没有可验证的ExceptionCase维护授权，禁止派发Codex。"
    };
  }
  const exception = runtime?.exceptionCase;
  if (runtime?.status === "blocked" && exception?.schemaVersion === "exception-case-v2" && exception?.status === "open" &&
      exception?.dispatchState === "queued" && exception?.maintenanceAuthorizationId) {
    return { allowed: true, mode: "exception", exceptionId: exception.exceptionId };
  }
  return {
    allowed: false,
    mode: "software_normal_flow",
    reason: "Normal production path attempted Codex dependency. 新版正常步骤只能由软件、正式AI网关和受控连接器执行；ExceptionCase也必须先取得独立维护授权。"
  };
}

export function buildExecutionRuntimeView(candidate, { activeExecutionReference = null } = {}) {
  if (candidate?.executionRuntime) {
    const runtime = candidate.executionRuntime;
    const recordValid = validateExecutionRuntime(runtime).valid && runtime.candidateId === candidate.id;
    const active = recordValid && activeExecutionReference?.candidateId === candidate.id &&
      ["running", "permission_required"].includes(activeExecutionReference.status) &&
      activeExecutionReference.candidateRevision === candidate.dataRevision &&
      activeExecutionReference.stepId === runtime.stepId && activeExecutionReference.inputRevision === runtime.inputRevision &&
      activeExecutionReference.updatedAt === runtime.updatedAt && activeExecutionReference.inferenceJobId === runtime.inferenceJobId &&
      activeExecutionReference.exceptionTurnId === (runtime.exceptionCase?.turnId ?? null);
    const claimsRunning = runtime.status === "running" || runtime.exceptionCase?.dispatchState === "running";
    const currentPermissionRequired = active && activeExecutionReference.status === "permission_required";
    return {
      available: true,
      source: "execution_runtime",
      schemaVersion: runtime.schemaVersion,
      executorType: runtime.executorType,
      status: runtime.status,
      stepId: runtime.stepId,
      inputRevision: runtime.inputRevision,
      outputRevision: runtime.outputRevision,
      inferenceReceiptId: runtime.inferenceReceiptId,
      exceptionCase: runtime.exceptionCase,
      technicalFailure: runtime.technicalFailure || null,
      legacyReadOnly: false,
      recordIssue: recordValid ? null : "execution_record_invalid_or_wrong_candidate",
      historicalExecution: recordValid && claimsRunning && !active,
      currentExecutionConfirmed: active && claimsRunning && !currentPermissionRequired,
      currentPermissionRequired,
      codexWakeupCount: runtime.codexWakeupCount
    };
  }
  if (candidate?.lifecycleV11?.opportunityPackage || candidate?.lifecycleV11?.skuPackage) {
    return {
      available: true,
      source: "derived_new_lifecycle",
      schemaVersion: EXECUTION_RUNTIME_VERSION,
      executorType: "software",
      status: "not_started",
      stepId: `${candidate.lifecycleV11?.skuPackage?.businessPhase || candidate.lifecycleV11?.opportunityPackage?.businessPhase || "A"}_SOFTWARE_PENDING`,
      inputRevision: Number(candidate.dataRevision),
      outputRevision: null,
      inferenceReceiptId: null,
      exceptionCase: null,
      technicalFailure: null,
      legacyReadOnly: false,
      recordIssue: null,
      historicalExecution: false,
      currentExecutionConfirmed: false,
      currentPermissionRequired: false,
      codexWakeupCount: 0
    };
  }
  return {
    available: true,
    source: "legacy_projection",
    schemaVersion: null,
    executorType: null,
    status: "not_started",
    stepId: candidate?.processing?.currentStep || "历史Codex记录",
    inputRevision: Number(candidate?.dataRevision || 0),
    outputRevision: null,
    inferenceReceiptId: null,
    exceptionCase: null,
    technicalFailure: null,
    legacyReadOnly: true,
    recordIssue: null,
    historicalExecution: false,
    currentExecutionConfirmed: false,
    currentPermissionRequired: false,
    codexWakeupCount: 0
  };
}

export function simulateNormalSoftwarePath({ candidateId = "SIM-NORMAL-1", dataRevision = 1, at = "2026-08-22T00:00:00.000Z" } = {}) {
  const created = createSoftwareExecutionRuntime({ candidateId, dataRevision, at });
  const running = startSoftwareStep(created, { stepId: "A_VALIDATE_FROZEN_INPUT", inputRevision: dataRevision, at });
  const completed = completeExecutionStep(running, { outputRevision: dataRevision + 1, at });
  return {
    runtime: completed,
    codexWakeups: completed.codexWakeupCount,
    dispatchesCreated: 0,
    platformAccesses: 0,
    platformWrites: 0
  };
}
