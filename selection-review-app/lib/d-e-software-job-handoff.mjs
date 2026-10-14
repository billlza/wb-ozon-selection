import { isDeepStrictEqual } from "node:util";
import { createDProductionJobScope, assertDProductionJobScope } from "./d-e-software-job-scope.mjs";
import { assertDEJobAdmissionDecision } from "./d-e-software-job-admission.mjs";
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { fingerprintCanonicalRecord, dProductionJobIdForRound, dProductionJobRound,
  D_PRODUCTION_MAX_ROUNDS } from "./production-contract-primitives.mjs";
import {
  D_PRODUCTION_EXECUTION_JOB_TYPE, D_PRODUCTION_EXECUTION_CAPABILITY,
  E_INDEPENDENT_READBACK_JOB_TYPE, E_INDEPENDENT_READBACK_CAPABILITY,
  createSoftwareJobEnvelope, enqueueSoftwareJobInDocument, findSoftwareJobInDocument, settleDProductionSoftwareJobInDocument,
  settleEReadbackSoftwareJobInDocument, settleDAssetTransportSoftwareJobInDocument, settleDPreparationSoftwareJobInDocument,
  softwareJobsInDocument
} from "./software-job-contract.mjs";
import { bindSoftwareJobAdmissionForEnqueue } from "./software-job-admission.mjs";

function referenceFor(job) {
  return { jobId: job.jobId, jobType: job.jobType, candidateId: job.candidateId, skuPackageId: job.skuPackageId,
    sourceRevision: job.scopeBinding.sourceRevision, resultRevision: job.revision, inputFingerprint: job.scopeBinding.inputFingerprint };
}

/**
 * dHandoff 记的是「这个授权交给了 D」，永远指向第一轮；轮次是执行尝试，不改候选、不占 revision。
 * 一个作业属于这次交接，当且仅当除作业号外逐字段相同，且作业号是同一授权指纹下的合法轮次。
 */
function handoffReferenceRound(handoff, job) {
  const reference = referenceFor(job), fingerprint = job.scopeBinding?.authorizationFingerprint;
  const round = dProductionJobRound(job.jobId, fingerprint);
  if (round === null || handoff?.softwareJobRef?.jobId !== dProductionJobIdForRound(fingerprint, 1) ||
      !isDeepStrictEqual({ ...handoff.softwareJobRef, jobId: null }, { ...reference, jobId: null })) return null;
  return round;
}

function dProductionRoundsFor(document, authorizationRef, authorizationFingerprint) {
  const rounds = softwareJobsInDocument(document).filter(entry => entry.jobType === D_PRODUCTION_EXECUTION_JOB_TYPE &&
    entry.scopeBinding?.authorizationRef === authorizationRef);
  const numbered = rounds.map(entry => ({ entry, round: dProductionJobRound(entry.jobId, authorizationFingerprint) }));
  if (numbered.length === 0 || numbered.some(value => value.round === null) ||
      new Set(numbered.map(value => value.round)).size !== numbered.length) return null;
  const latest = numbered.reduce((best, value) => value.round > best.round ? value : best, numbered[0]);
  // 只有最后一轮可以还在跑。每一个被后一轮取代的轮次都必须停在「失败，且一个请求都没发出去」——
  // 这正是允许再派一轮的唯一前提，也保证同一授权下永远不会有两条可能写平台的路径。
  const superseded = numbered.filter(value => value.round !== latest.round);
  if (!superseded.every(({ entry }) => entry.status === "failed" && entry.externalRequestState === "not_sent" &&
      entry.externalRequestRef === null && entry.resultEnvelope === null)) return null;
  return { numbered, latest: latest.entry, latestRound: latest.round };
}

/** 当前这一轮：轮次号最大的那一轮。之前每一轮都必须已经证明什么都没发出去。 */
export function currentDProductionRound(document, { authorizationRef, authorizationFingerprint }) {
  return dProductionRoundsFor(document, authorizationRef, authorizationFingerprint)?.latest ?? null;
}

/** Called only inside the transaction that just created this PA. No transport or credential lookup occurs here. */
export function enqueueDProductionHandoffInDocument({ document, candidate, observedAt }) {
  const scopeBinding = createDProductionJobScope({ candidate, observedAt });
  const sku = candidate.lifecycleV11.skuPackage;
  const authorization = sku.productionAuthorization;
  if (sku.dHandoff?.schemaVersion !== "c2-d-handoff-v1" || sku.dHandoff.softwareJobCreated !== false ||
      authorization.authorizedAt !== observedAt || sku.dHandoff.createdAt !== observedAt ||
      !Array.isArray(document.candidates) || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  const jobId = dProductionJobIdForRound(scopeBinding.authorizationFingerprint, 1);
  const job = createSoftwareJobEnvelope({ jobId, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    revision: candidate.dataRevision, jobType: D_PRODUCTION_EXECUTION_JOB_TYPE, createdAt: observedAt,
    requestedByUserId: authorization.authorizedByActorId, ownerUserId: authorization.authorizedByActorId,
    requiredCapabilities: [D_PRODUCTION_EXECUTION_CAPABILITY], idempotencyKey: jobId, scopeBinding });
  const admittedJob = bindSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase: "enqueue_current" });
  const queued = enqueueSoftwareJobInDocument(document, admittedJob);
  if (!queued.changed) throw new Error("D_JOB_HANDOFF_ALREADY_EXISTS");
  sku.dHandoff = { ...sku.dHandoff, schemaVersion: "c2-d-handoff-v2", status: "software_job_queued",
    softwareJobCreated: true, softwareJobRef: referenceFor(queued.job) };
  sku.businessPhase = "D";
  sku.technicalStatus = "queued";
  const event = sku.audit.history.at(-1);
  if (event?.event !== "production_authorization_and_d_handoff_created_atomically" ||
      event.authorizationId !== authorization.authorizationId || event.at !== observedAt || event.softwareJobCreated !== false) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_AUDIT_REQUIRED");
  }
  event.event = "production_authorization_and_d_software_job_created_atomically";
  event.softwareJobCreated = true;
  event.softwareJobId = jobId;
  candidate.lifecycleV11.status = "production_authorized_d_job_queued";
  assertValidLifecyclePackage(sku);
  return { dHandoff: structuredClone(sku.dHandoff), softwareJobCreated: true,
    softwareJobRef: { jobId, jobType: job.jobType, candidateId: job.candidateId, skuPackageId: job.skuPackageId, revision: job.revision } };
}

export const D_PRODUCTION_ROUND_BLOCKERS = Object.freeze({
  NO_ROUND: "尚未创建生产作业，没有可重派的轮次。",
  ROUND_NOT_STOPPED: "上一轮生产作业还没停下来，不能再派一轮。",
  ROUND_MAY_HAVE_SENT: "上一轮无法证明一个请求都没发出去；必须先核对平台，不能再派一轮。",
  DOWNSTREAM_EXISTS: "本商品已经有素材传输、生产记录或回读结果，不能当作从未执行重派。",
  ROUND_LIMIT: "重派轮次已达上限，请先排查原因。",
  ROUND_MOVED: "这一轮已经重派过了，请刷新页面看当前那一轮。",
  REVISION_MOVED: "商品资料已经往前走过，和授权冻结的那一版对不上，不能直接重派。"
});

/**
 * 现在能不能再派一轮，以及被取代的是哪一轮。页面和真正的入队走同一套判断，不会各说各话。
 * 这里只看已持久化的状态；C1 权利复核是否仍然有效由入队时的作用域校验兜底。
 */
export function dProductionRoundDispatchable(document, candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage, authorization = sku?.productionAuthorization;
  const none = { dispatchable: false, blocker: D_PRODUCTION_ROUND_BLOCKERS.NO_ROUND, supersededJobId: null };
  if (!authorization || sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2" || sku.dHandoff.softwareJobCreated !== true) return none;
  const chain = dProductionRoundsFor(document, authorization.authorizationId, fingerprintCanonicalRecord(authorization));
  if (chain === null) return none;
  const previous = chain.latest;
  const blocker = !["completed", "failed", "unknown_outcome"].includes(previous.status) ? D_PRODUCTION_ROUND_BLOCKERS.ROUND_NOT_STOPPED
    : previous.status !== "failed" || previous.externalRequestState !== "not_sent" || previous.externalRequestRef !== null ||
      previous.resultEnvelope !== null ? D_PRODUCTION_ROUND_BLOCKERS.ROUND_MAY_HAVE_SENT
    : (sku.dAssetTransport ?? null) !== null || (sku.dSoftwareExecution ?? null) !== null || sku.productionRecord !== null ||
      sku.readbackHistory.length !== 0 ? D_PRODUCTION_ROUND_BLOCKERS.DOWNSTREAM_EXISTS
    : candidate.dataRevision !== authorization.resultCandidateRevision ? D_PRODUCTION_ROUND_BLOCKERS.REVISION_MOVED
    : chain.latestRound >= D_PRODUCTION_MAX_ROUNDS ? D_PRODUCTION_ROUND_BLOCKERS.ROUND_LIMIT
    : null;
  return { dispatchable: blocker === null, blocker, supersededJobId: previous.jobId,
    supersededFailureClass: previous.failureClass, round: chain.latestRound + 1 };
}

/**
 * 同一份不可变生产授权下再派一轮受控执行。授权、价格、库存、素材和候选一律不动，
 * 也不占用候选 revision——轮次是技术执行尝试，不是新的商业决定。
 * 只有在上一轮已经停在「失败，且一个请求都没发出去」时才允许；判定失败时返回原因，绝不放行。
 */
export function enqueueDProductionRoundInDocument({ document, candidate, observedAt, expectedSupersededJobId = null }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization;
  if (!authorization || sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2" || sku.dHandoff.softwareJobCreated !== true ||
      !Array.isArray(document.candidates) || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  const state = dProductionRoundDispatchable(document, candidate);
  if (state.supersededJobId === null) throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  // 页面上看到的那一轮必须就是当前记录里的最后一轮：重复点击的第二下会在这里被挡下来。
  if (expectedSupersededJobId !== null && expectedSupersededJobId !== state.supersededJobId) {
    return { blocked: D_PRODUCTION_ROUND_BLOCKERS.ROUND_MOVED };
  }
  if (!state.dispatchable) return { blocked: state.blocker };
  const authorizationFingerprint = fingerprintCanonicalRecord(authorization);
  const previous = findSoftwareJobInDocument(document, state.supersededJobId);
  // 作用域仍然只从授权推导，所以每一轮的冻结输入、revision 和身份与第一轮逐字节相同。
  const scopeBinding = createDProductionJobScope({ candidate, observedAt });
  if (scopeBinding.authorizationFingerprint !== authorizationFingerprint ||
      !isDeepStrictEqual(scopeBinding, previous.scopeBinding)) throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  const round = state.round, jobId = dProductionJobIdForRound(authorizationFingerprint, round);
  const job = createSoftwareJobEnvelope({ jobId, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    revision: candidate.dataRevision, jobType: D_PRODUCTION_EXECUTION_JOB_TYPE, createdAt: observedAt,
    requestedByUserId: authorization.authorizedByActorId, ownerUserId: authorization.authorizedByActorId,
    requiredCapabilities: [D_PRODUCTION_EXECUTION_CAPABILITY], idempotencyKey: jobId, scopeBinding });
  const admittedJob = bindSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase: "enqueue_current" });
  const queued = enqueueSoftwareJobInDocument(document, admittedJob);
  if (!queued.changed) throw new Error("D_JOB_HANDOFF_ALREADY_EXISTS");
  assertDProductionJobReference({ document, candidate, job: findSoftwareJobInDocument(document, jobId) });
  return { blocked: null, round, jobId, supersededJobId: previous.jobId, supersededFailureClass: previous.failureClass,
    softwareJobRef: { jobId, jobType: job.jobType, candidateId: job.candidateId, skuPackageId: job.skuPackageId, revision: job.revision } };
}

/** A saved job cannot adopt a historical PA or another job's candidate reference. */
export function assertDProductionJobReference({ document, candidate, job }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization;
  const handoff = sku?.dHandoff;
  if (!authorization || handoff?.schemaVersion !== "c2-d-handoff-v2" || handoff.softwareJobCreated !== true ||
      job?.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || job.scopeBinding?.authorizationRef !== authorization.authorizationId ||
      job.scopeBinding.authorizationFingerprint !== fingerprintCanonicalRecord(authorization) ||
      handoffReferenceRound(handoff, job) === null ||
      handoff.productionAuthorizationId !== authorization.authorizationId ||
      job.ownerUserId !== authorization.authorizedByActorId || job.requestedByUserId !== authorization.authorizedByActorId ||
      !Array.isArray(document.runtime?.softwareJobs) ||
      dProductionRoundsFor(document, authorization.authorizationId, job.scopeBinding.authorizationFingerprint) === null ||
      !isDeepStrictEqual(findSoftwareJobInDocument(document, job.jobId), job)) {
    throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
}

/** A replay must find both immutable PA and the same unique job; later execution progress is allowed. */
export function assertPersistedDProductionHandoff({ document, candidate, job, sourceCandidate }) {
  assertDProductionJobReference({ document, candidate, job });
  const { productionAuthorization: authorization, dHandoff: handoff } = candidate.lifecycleV11.skuPackage;
  if (!sourceCandidate || !isDeepStrictEqual(handoff, sourceCandidate.lifecycleV11?.skuPackage?.dHandoff) ||
      job.createdAt !== authorization.authorizedAt || job.idempotencyKey !== job.jobId) {
    throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
  // Validate the frozen input at its original clock, not today's rights expiry.
  assertDProductionJobScope({ scope: job.scopeBinding, candidate: sourceCandidate, observedAt: job.createdAt });
  assertDEJobAdmissionDecision(job, job.admissionDecision);
}

function assertFrozenDJobHandoff(document, candidate, before) {
  const handoff = candidate.lifecycleV11?.skuPackage?.dHandoff;
  if (before.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || handoff?.schemaVersion !== "c2-d-handoff-v2" ||
      handoff.softwareJobCreated !== true || handoffReferenceRound(handoff, before) === null ||
      handoff.productionAuthorizationId !== before.scopeBinding.authorizationRef ||
      before.idempotencyKey !== before.jobId ||
      dProductionRoundsFor(document, before.scopeBinding.authorizationRef, before.scopeBinding.authorizationFingerprint) === null) {
    throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
}

/** Existing D settlement calls this before committing its ProductionRecord. E is created only with the verified D source. */
export function settleDProductionJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  assertFrozenDJobHandoff(document, candidate, before);
  const { job, eScope, reconciliationRequired } = settleDProductionSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
  if (reconciliationRequired) {
    candidate.lifecycleV11.skuPackage.dSoftwareExecution.continuationBlocked = true;
    candidate.lifecycleV11.skuPackage.dSoftwareExecution.blockReason = "software_job_reconciliation_required";
  }
  if (eScope === null) return Object.freeze({ job, eJobRef: null });
  if (Object.hasOwn(candidate.lifecycleV11, "eIndependentReadbackJobRefV1")) throw new Error("E_JOB_HANDOFF_ALREADY_EXISTS");
  const eJobId = `e-readback-job:${eScope.inputFingerprint}`;
  const pending = createSoftwareJobEnvelope({ jobId: eJobId, candidateId: candidate.id, skuPackageId: job.skuPackageId,
    revision: candidate.dataRevision, jobType: E_INDEPENDENT_READBACK_JOB_TYPE, createdAt: observedAt,
    requestedByUserId: job.requestedByUserId, ownerUserId: job.ownerUserId,
    requiredCapabilities: [E_INDEPENDENT_READBACK_CAPABILITY], idempotencyKey: eJobId, scopeBinding: eScope });
  const admitted = bindSoftwareJobAdmissionForEnqueue({ document, job: pending, observedAt, phase: "enqueue_current" });
  const queued = enqueueSoftwareJobInDocument(document, admitted);
  if (!queued.changed) throw new Error("E_JOB_HANDOFF_ALREADY_EXISTS");
  const eJobRef = referenceFor(queued.job);
  candidate.lifecycleV11.eIndependentReadbackJobRefV1 = eJobRef;
  candidate.lifecycleV11.skuPackage.businessPhase = "E";
  candidate.lifecycleV11.skuPackage.technicalStatus = "queued";
  candidate.lifecycleV11.status = "d_created_e_readback_queued";
  return Object.freeze({ job, eJobRef: structuredClone(eJobRef) });
}

export function settleEReadbackJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("E_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  if (before.jobType !== E_INDEPENDENT_READBACK_JOB_TYPE ||
      !isDeepStrictEqual(candidate.lifecycleV11?.eIndependentReadbackJobRefV1, referenceFor(before)) ||
      before.jobId !== `e-readback-job:${before.scopeBinding.inputFingerprint}` || before.idempotencyKey !== before.jobId ||
      document.runtime.softwareJobs.filter(entry => entry.jobType === before.jobType &&
        entry.scopeBinding?.authorizationRef === before.scopeBinding.authorizationRef).length !== 1) {
    throw new Error("E_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
  return settleEReadbackSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
}

export function assertEReadbackJobReference({ document, candidate, job }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const ref = candidate?.lifecycleV11?.eIndependentReadbackJobRefV1;
  if (!sku || job?.jobType !== E_INDEPENDENT_READBACK_JOB_TYPE || !isDeepStrictEqual(ref, referenceFor(job)) ||
      job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId ||
      job.jobId !== `e-readback-job:${job.scopeBinding?.inputFingerprint}` || job.idempotencyKey !== job.jobId ||
      sku.productionRecord?.productionRecordId !== job.scopeBinding?.sourceProductionRecordId ||
      fingerprintCanonicalRecord(sku.productionRecord) !== job.scopeBinding.sourceProductionRecordFingerprint ||
      job.ownerUserId !== sku.productionAuthorization?.authorizedByActorId || job.requestedByUserId !== job.ownerUserId ||
      !Array.isArray(document.runtime?.softwareJobs) || document.runtime.softwareJobs.filter(entry => entry.jobType === job.jobType &&
        entry.scopeBinding?.authorizationRef === job.scopeBinding.authorizationRef).length !== 1) {
    throw new Error("E_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
}

export function settleDAssetTransportJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_ASSET_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  assertFrozenDJobHandoff(document, candidate, before);
  const result = settleDAssetTransportSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
  if (result.continuationBlocked) {
    const state = candidate.lifecycleV11.skuPackage.dAssetTransport;
    state.continuationBlocked = true;
    if (result.reconciliationRequired) state.blockReason = "software_job_reconciliation_required";
    else if (!state.blockReason) state.blockReason = result.job.failureClass;
  }
  return result;
}

export function settleDPreparationJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_PREPARATION_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  assertFrozenDJobHandoff(document, candidate, before);
  return settleDPreparationSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
}
