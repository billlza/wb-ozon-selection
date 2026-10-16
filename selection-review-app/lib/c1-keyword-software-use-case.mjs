import { buildC1KeywordSoftwareJobPlan, assertC1KeywordSoftwareJobClientInput } from "./c1-keyword-software-job-planner.mjs";
import { executeBusinessMutation, assertReplaySoftwareJob } from "./business-mutation-transaction.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { legacyKeywordJobBlocksPaidExecution } from "./keyword-evidence-software-job-state.mjs";
import { authorizeOperation, teamOperationRoles } from "./runtime-identity.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER
} from "./software-job-contract.mjs";

export const C1_KEYWORD_SOFTWARE_EXECUTION_PREPARATION_VERSION = "c1-keyword-software-execution-preparation-v1";
export const C1_PAID_KEYWORD_DEFAULT_WORKER_ID = "worker-seerfar-open-api-1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function validatePlanIdentity(candidate, plan) {
  if (plan.candidateId !== candidate.id || plan.sourceCandidateRevision !== candidate.dataRevision) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_PLAN_SCOPE_DRIFT");
  }
  const skuPackage = candidate.lifecycleV11?.skuPackage;
  if (plan.status === "not_ready" && plan.skuPackageId === null && !isObject(skuPackage)) return null;
  if (!isObject(skuPackage) || !nonEmpty(skuPackage.skuPackageId) || plan.skuPackageId !== skuPackage.skuPackageId) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_PLAN_SCOPE_DRIFT");
  }
  return skuPackage;
}

function assertLegacyJobResolved(candidate) {
  if (legacyKeywordJobBlocksPaidExecution(candidate)) {
    const status = candidate.lifecycleV11.keywordEvidenceSoftwareJobV1.status.toUpperCase();
    throw new Error(`C1_KEYWORD_SOFTWARE_PREPARATION_LEGACY_JOB_${status}`);
  }
}

function resultBase(plan) {
  return {
    schemaVersion: C1_KEYWORD_SOFTWARE_EXECUTION_PREPARATION_VERSION,
    candidateId: plan.candidateId,
    sourceRevision: plan.sourceCandidateRevision,
    skuPackageId: plan.skuPackageId,
    planFingerprint: plan.planFingerprint,
    readinessClass: plan.readinessClass,
    gaps: structuredClone(plan.gaps),
    plan: structuredClone(plan),
    providerCallsPlanned: 0,
    jobIntent: null,
    runnerJob: null,
    softwareJobInput: null,
    softwareJobRef: null,
    jobRuntimeInput: null,
    seerfarRequest: null,
    reuseInput: null,
    sideEffects: {
      candidateWritesPerformed: 0,
      externalCallsPerformed: 0,
      browserActionsPerformed: 0,
      codexDispatchesPerformed: 0,
      c2Started: false,
      dStarted: false,
      eStarted: false
    }
  };
}

/**
 * 纯应用用例：校验HTTP边界输入，并把当前候选转换为可由服务层原子持久化/执行的准备结果。
 * 本函数不读写共享数据、不调用Seerfar，也不改变候选对象。
 */
export function prepareC1KeywordSoftwareExecution(
  { candidate, clientInput, plannedAt, existingPlan = null },
  {
    buildPlan = buildC1KeywordSoftwareJobPlan
  } = {}
) {
  if (!isObject(candidate) || !nonEmpty(candidate.id) || !Number.isInteger(candidate.dataRevision) ||
      !nonEmpty(plannedAt) || Number.isNaN(Date.parse(plannedAt))) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_INPUT_INVALID");
  }
  const { dataRevision } = assertC1KeywordSoftwareJobClientInput(clientInput);
  if (candidate.dataRevision !== dataRevision) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_REVISION_CONFLICT");
  }
  assertLegacyJobResolved(candidate);

  const plan = buildPlan({
    candidate,
    expectedRevision: dataRevision,
    plannedAt,
    existingPlan
  });
  if (!isObject(plan) || !["not_ready", "reuse_ready", "ready"].includes(plan.status) ||
      !nonEmpty(plan.planFingerprint)) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_PLAN_INVALID");
  }
  validatePlanIdentity(candidate, plan);

  const base = resultBase(plan);
  if (plan.status === "not_ready") {
    return freeze({ ...base, status: "not_ready", executionKind: "none" });
  }

  if (plan.status === "reuse_ready") {
    if (plan.mode !== "reuse_existing_evidence" || !isObject(plan.runtimeInputTemplate) || plan.seerfarRequest !== null ||
        plan.executionPolicy.provider !== "none" || plan.executionPolicy.attemptLimit !== 0) {
      throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_REUSE_PLAN_INVALID");
    }
    return freeze({
      ...base,
      status: "reuse_ready",
      executionKind: "reuse_existing_evidence",
      reuseInput: structuredClone(plan.runtimeInputTemplate)
    });
  }

  if (plan.mode !== "seerfar_open_api_once" || !isObject(plan.job) || !isObject(plan.runtimeInputTemplate) ||
      !isObject(plan.seerfarRequest) || plan.executionPolicy.provider !== "seerfar_open_api" ||
      plan.executionPolicy.attemptLimit !== 1) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_PROVIDER_PLAN_INVALID");
  }
  if (plan.job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      plan.job.sourceRevision !== dataRevision || plan.job.resultRevision !== dataRevision + 1 ||
      !isObject(plan.job.scopeBinding) || plan.job.scopeBinding.sourceRevision !== dataRevision ||
      plan.job.scopeBinding.resultRevision !== dataRevision + 1) {
    throw new Error("C1_KEYWORD_SOFTWARE_PREPARATION_SOFTWARE_JOB_INVALID");
  }
  const softwareJobInput = {
    jobId: plan.job.jobId,
    candidateId: plan.job.candidateId,
    skuPackageId: plan.job.skuPackageId,
    revision: plan.job.resultRevision,
    jobType: plan.job.jobType,
    requestedByUserId: null,
    ownerUserId: null,
    requiredCapabilities: structuredClone(plan.job.requiredCapabilities),
    idempotencyKey: plan.job.idempotencyKey,
    scopeBinding: structuredClone(plan.job.scopeBinding)
  };
  const softwareJobRef = {
    schemaVersion: "software-job-ref-v1",
    jobId: softwareJobInput.jobId,
    jobType: softwareJobInput.jobType,
    candidateId: softwareJobInput.candidateId,
    skuPackageId: softwareJobInput.skuPackageId,
    sourceRevision: softwareJobInput.scopeBinding.sourceRevision,
    resultRevision: softwareJobInput.revision,
    inputFingerprint: softwareJobInput.scopeBinding.inputFingerprint
  };

  return freeze({
    ...base,
    status: "ready",
    executionKind: "seerfar_open_api_once",
    providerCallsPlanned: 1,
    softwareJobInput,
    softwareJobRef,
    jobRuntimeInput: structuredClone(plan.runtimeInputTemplate),
    seerfarRequest: structuredClone(plan.seerfarRequest)
  });
}

function actorUserId(actor, label) {
  const value = String(actor?.userId ?? "").trim();
  if (!value) throw new Error(`C1_KEYWORD_SOFTWARE_ENQUEUE_${label}_REQUIRED`);
  return value;
}

function uniqueWorkerIds(workerIds) {
  const source = workerIds === undefined ? [C1_PAID_KEYWORD_DEFAULT_WORKER_ID] : workerIds;
  if (Array.isArray(source) && source.length === 0) throw new Error("C1_KEYWORD_SERVICE_NOT_CONFIGURED");
  if (!Array.isArray(source) || source.length === 0 || source.length > 32) {
    throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_WORKER_BINDING_INVALID");
  }
  const normalized = [...new Set(source.map((workerId) => String(workerId ?? "").trim()).filter(Boolean))].sort();
  if (normalized.length !== source.length) throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_WORKER_BINDING_INVALID");
  return normalized;
}

function c1PaidKeywordAdmissionRecords({ softwareJobInput, actor, allowedWorkerIds }) {
  const scope = softwareJobInput.scopeBinding;
  const ownerUserId = actorUserId(actor, "OWNER_USER");
  const workerIds = uniqueWorkerIds(allowedWorkerIds);
  return {
    schemaVersion: "business-mutation-software-job-admission-effect-v1",
    authorizationRecord: {
      schemaVersion: "software-job-authorization-record-v1",
      authorizationId: scope.authorizationRef,
      status: "active",
      action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      authorizationSubject: "c1_paid_keyword_evidence:seerfar_open_api_once",
      candidateId: scope.candidateId,
      skuPackageId: scope.skuPackageId,
      sourceRevision: scope.sourceRevision,
      resultRevision: scope.resultRevision,
      platform: scope.platform,
      targetStore: scope.targetStore,
      supplierSkuId: scope.supplierSkuId,
      variantKey: scope.variantKey,
      sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      provider: C1_PAID_KEYWORD_PROVIDER,
      credentialAlias: scope.credentialAlias,
      inputFingerprint: scope.inputFingerprint,
      planningEvidenceFingerprint: scope.planningEvidenceFingerprint,
      runtimeInputFingerprint: scope.runtimeInputFingerprint,
      seerfarRequestFingerprint: scope.seerfarRequestFingerprint,
      salesSnapshotFingerprint: scope.salesSnapshotFingerprint,
      supplySnapshotFingerprint: scope.supplySnapshotFingerprint,
      profitModelFingerprint: scope.profitModelFingerprint,
      c1FactsFingerprint: scope.c1FactsFingerprint,
      pointBudgetEvidenceRef: scope.pointBudgetEvidenceRef,
      quotaEvidenceRef: scope.quotaEvidenceRef,
      pointsAuthorized: C1_PAID_KEYWORD_POINTS,
      authorizedByUserId: ownerUserId,
      authorizedAt: null,
      expiresAt: null,
      maxUses: 1,
      useCount: 0,
      consumedByJobId: null,
      consumedAt: null
    },
    credentialBinding: {
      schemaVersion: "software-job-credential-binding-v1",
      bindingId: `credential-binding:c1-paid-keyword:${scope.inputFingerprint.slice(0, 32)}`,
      credentialAlias: scope.credentialAlias,
      status: "active",
      provider: C1_PAID_KEYWORD_PROVIDER,
      platform: scope.platform,
      targetStore: scope.targetStore,
      sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      candidateId: scope.candidateId,
      skuPackageId: scope.skuPackageId,
      sourceRevision: scope.sourceRevision,
      resultRevision: scope.resultRevision,
      inputFingerprint: scope.inputFingerprint,
      planningEvidenceFingerprint: scope.planningEvidenceFingerprint,
      runtimeInputFingerprint: scope.runtimeInputFingerprint,
      seerfarRequestFingerprint: scope.seerfarRequestFingerprint,
      allowedWorkerIds: workerIds,
      redaction: "credential_alias_only",
      boundAt: null,
      expiresAt: null
    }
  };
}

function zeroDownstream() {
  return {
    productionAuthorizationCreated: false,
    dHandoffCreated: false,
    productionPlanCreated: false,
    executionIntentCreated: false,
    platformWrites: 0,
    externalCallsPerformed: 0,
    browserActionsPerformed: 0,
    codexDispatchesPerformed: 0
  };
}

function replayCommittedC1PaidKeywordEnqueue({ snapshot, candidateId, clientInput, actor }) {
  const sourceRevision = clientInput.dataRevision;
  const records = Array.isArray(snapshot?.runtime?.idempotencyRecords) ? snapshot.runtime.idempotencyRecords : [];
  const record = records.find((entry) =>
    entry?.action === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE &&
    entry.candidateId === candidateId &&
    entry.sourceRevision === sourceRevision &&
    entry.result?.softwareJobRef?.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE &&
    entry.result?.jobRef?.sourceRevision === sourceRevision &&
    entry.candidateSnapshot?.lifecycleV11?.c1PaidKeywordEvidenceJobRefV1?.jobId === entry.result.softwareJobRef.jobId
  );
  if (!record) return null;
  if (record.auditEvent?.actor?.userId !== actor.userId) {
    throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_REPLAY_OWNER_MISMATCH");
  }
  assertReplaySoftwareJob(snapshot, record.result);
  return freeze({
    status: "idempotent_replay",
    candidate: structuredClone(record.candidateSnapshot),
    result: structuredClone(record.result),
    auditEvent: structuredClone(record.auditEvent)
  });
}

export async function enqueueC1PaidKeywordEvidenceJob({
  repository,
  runtimeMode,
  actor,
  candidateId,
  expectedRevision,
  clientInput,
  serverTime = null,
  serverClock = null,
  allowedWorkerIds = undefined
}) {
  if (!repository || typeof repository.readSnapshot !== "function" || typeof repository.transact !== "function") {
    throw new Error("C1_KEYWORD_SOFTWARE_REPOSITORY_REQUIRED");
  }
  authorizeOperation({ actor, requiredRoles: teamOperationRoles(actor) });
  const plannedAt = typeof serverClock === "function" ? serverClock() : serverTime;
  if (!nonEmpty(plannedAt) || Number.isNaN(Date.parse(plannedAt))) {
    throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_CLOCK_INVALID");
  }
  const normalizedClientInput = assertC1KeywordSoftwareJobClientInput(clientInput);
  if (Number(expectedRevision) !== normalizedClientInput.dataRevision) {
    throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_REVISION_CONFLICT");
  }
  const snapshot = await repository.readSnapshot();
  const source = snapshot.candidates?.find((item) => item.id === candidateId);
  if (!source) throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_CANDIDATE_NOT_FOUND");
  if (Number(source.dataRevision) !== Number(expectedRevision)) {
    const replay = replayCommittedC1PaidKeywordEnqueue({
      snapshot,
      candidateId,
      clientInput: normalizedClientInput,
      actor
    });
    if (replay) return replay;
    throw new Error("C1_KEYWORD_SOFTWARE_ENQUEUE_REVISION_CONFLICT");
  }
  const preparation = prepareC1KeywordSoftwareExecution({
    candidate: source,
    clientInput: normalizedClientInput,
    plannedAt,
    existingPlan: source.lifecycleV11?.c1KeywordSoftwareJobPlanV1 ?? null
  });
  if (preparation.status !== "ready") return preparation;

  const softwareJobInput = {
    ...structuredClone(preparation.softwareJobInput),
    requestedByUserId: actorUserId(actor, "REQUESTED_BY_USER"),
    ownerUserId: actorUserId(actor, "OWNER_USER")
  };
  const admissionRecords = c1PaidKeywordAdmissionRecords({
    softwareJobInput,
    actor,
    allowedWorkerIds
  });
  const inputFingerprint = fingerprintCanonicalRecord({
    clientInput: normalizedClientInput,
    softwareJobInput,
    admissionRecords,
    planFingerprint: preparation.planFingerprint,
    jobRuntimeInput: preparation.jobRuntimeInput,
    seerfarRequest: preparation.seerfarRequest
  });

  return executeBusinessMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: teamOperationRoles(actor),
    action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: softwareJobInput.candidateId,
    skuPackageId: softwareJobInput.skuPackageId,
    expectedRevision,
    idempotencyKey: softwareJobInput.idempotencyKey,
    inputFingerprint,
    auditEventId: `audit:c1-paid-keyword:${softwareJobInput.jobId}`,
    authorizationRef: softwareJobInput.scopeBinding.authorizationRef,
    externalRequestState: "not_sent",
    externalRequestRef: null,
    serverTime,
    serverClock,
    softwareJobEffect: {
      schemaVersion: "business-mutation-effect-v1",
      kind: "software_job",
      operation: "enqueue",
      jobInput: softwareJobInput,
      admissionRecords
    },
    mutate: ({ candidate, observedAt }) => {
      assertLegacyJobResolved(candidate);
      const next = structuredClone(candidate);
      if (!isObject(next.lifecycleV11)) next.lifecycleV11 = {};
      next.lifecycleV11.c1KeywordSoftwareJobPlanV1 = structuredClone(preparation.plan);
      next.lifecycleV11.c1PaidKeywordEvidenceJobRefV1 = structuredClone(preparation.softwareJobRef);
      next.lifecycleV11.c1PaidKeywordEvidenceRuntimeInputV1 = structuredClone(preparation.jobRuntimeInput);
      next.lifecycleV11.c1PaidKeywordEvidenceSeerfarRequestV1 = structuredClone(preparation.seerfarRequest);
      next.lifecycleV11.c1PaidKeywordEvidenceInputArtifactRefV1 = {
        schemaVersion: "c1-paid-keyword-evidence-input-artifact-ref-v1",
        jobId: softwareJobInput.jobId,
        jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
        candidateId: softwareJobInput.candidateId,
        skuPackageId: softwareJobInput.skuPackageId,
        sourceRevision: softwareJobInput.scopeBinding.sourceRevision,
        resultRevision: softwareJobInput.revision,
        planFingerprint: preparation.planFingerprint,
        runtimeInputFingerprint: softwareJobInput.scopeBinding.runtimeInputFingerprint,
        seerfarRequestFingerprint: softwareJobInput.scopeBinding.seerfarRequestFingerprint,
        immutable: true,
        storedAt: observedAt
      };
      next.lifecycleV11.c1PaidKeywordEvidenceQueuedAt = observedAt;
      return {
        candidate: next,
        result: {
          schemaVersion: "c1-paid-keyword-evidence-enqueue-result-v1",
          status: "queued",
          jobRef: structuredClone(preparation.softwareJobRef),
          ...zeroDownstream()
        }
      };
    }
  });
}

export function reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument({ document, restartedAt }) {
  if (!isObject(document) || !Array.isArray(document.candidates) || !nonEmpty(restartedAt) || Number.isNaN(Date.parse(restartedAt))) {
    throw new Error("C1_KEYWORD_SOFTWARE_LEGACY_RECONCILE_INPUT_INVALID");
  }
  const observedAt = new Date(Date.parse(restartedAt)).toISOString();
  const reconciled = [];
  for (const candidate of document.candidates) {
    const legacy = candidate?.lifecycleV11?.keywordEvidenceSoftwareJobV1;
    if (!isObject(legacy) || legacy.status !== "in_flight") continue;
    candidate.lifecycleV11.keywordEvidenceSoftwareJobV1 = {
      ...structuredClone(legacy),
      status: "unknown_outcome",
      completedAt: observedAt,
      failureClass: "legacy_keyword_software_job_unknown_after_restart",
      retryAllowed: false
    };
    candidate.dataRevision = Number(candidate.dataRevision || 0) + 1;
    candidate.updatedAt = observedAt;
    candidate.lastModifiedBy = "system";
    reconciled.push({ candidateId: candidate.id, jobId: legacy.jobId });
  }
  return freeze({ changed: reconciled.length > 0, reconciled });
}
