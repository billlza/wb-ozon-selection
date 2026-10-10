import { authorizeOperation, createOperationAuditEvent } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { reconcileDUnknownOutcomeFromPlatformStateInDocument, createDPlatformObservationScope, importedProductObservation,
  dPlatformStateReconciliationsFor, D_PLATFORM_STATE_RECONCILIATION_LIMIT } from './d-platform-observation-contract.mjs';
import { findSoftwareJobInDocument } from './software-job-contract.mjs';

export class DPlatformStateReconciliationError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'DPlatformStateReconciliationError'; this.code = code; }
}

const INPUT_KEYS = 'candidateId,confirmPlatformStateMatchesThisRound,expectedRevision,productId,sourceDJobId,taskId';

/**
 * 主人明确「按平台现状收口」。
 *
 * 由来：2026-09-24 背心的导入被平台接受（商品号已建出），导入任务上挂了错误，停在 unknown_outcome；
 * 之后商品在平台上已经审核通过、在售、库存由主人在后台填好。导入任务过期以后，「按新分类重新观察一次」
 * 读不到它，只会再停一次。
 *
 * 这个用例只做一件事：把那一次停住的执行放回 waiting_platform，从「平台已给商品号」那一格接着排一条观察作业，
 * 由它去读商品现状（价格）和仓库库存。**它不调用任何平台接口**，真正的只读查询由观察作业按策略去做。
 * 不重发导入、不写库存（回读到 0 也不写）、不生成生产记录、不改授权。
 */
export function createDPlatformStateReconciliationUseCase({ repository, serverClock, loadDPlatformObservationPolicy, jobStore }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function' || typeof loadDPlatformObservationPolicy !== 'function' ||
      typeof jobStore?.recoverDInitialImportStoppedJobInDocument !== 'function' ||
      typeof jobStore?.enqueueDPlatformObservationInDocument !== 'function') {
    throw new Error('D_PLATFORM_STATE_RECONCILIATION_DEPENDENCY_INVALID');
  }
  return Object.freeze({
    async reconcile({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ['owner'] });
      if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
        throw new DPlatformStateReconciliationError('OWNER_REQUIRED', '请先登录主人身份再按平台现状收口。');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== INPUT_KEYS ||
          input.confirmPlatformStateMatchesThisRound !== true ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
          ['candidateId', 'sourceDJobId', 'taskId', 'productId'].some(field =>
            typeof input[field] !== 'string' || input[field].trim() === '')) {
        throw new DPlatformStateReconciliationError('INPUT_INVALID',
          '按平台现状收口必须准确引用当前商品、那一轮作业，以及平台已经建出的那个商品号。');
      }
      return repository.transact(document => {
        const observedAt = serverClock();
        const candidate = document.candidates?.find(entry => entry.id === input.candidateId);
        if (!candidate) throw new DPlatformStateReconciliationError('CANDIDATE_NOT_FOUND', '候选不存在。');
        if (candidate.dataRevision !== input.expectedRevision) {
          throw new DPlatformStateReconciliationError('CANDIDATE_CHANGED', '商品资料已变化，请刷新后核对当前记录。');
        }
        const job = findSoftwareJobInDocument(document, input.sourceDJobId);
        if (!job || job.candidateId !== candidate.id) {
          throw new DPlatformStateReconciliationError('JOB_NOT_FOUND', '找不到这一轮生产作业。');
        }
        const continuation = candidate.lifecycleV11.skuPackage.dSoftwareExecution?.platformContinuation;
        const previous = dPlatformStateReconciliationsFor(candidate, input.taskId);
        if (job.status !== 'unknown_outcome' && previous.length > 0) {
          throw new DPlatformStateReconciliationError('ALREADY_RECONCILING',
            `这个导入任务已经在 ${previous.at(-1).reconciledAt} 按平台现状收口过，正在查询或已经收口，不会重复。`);
        }
        if (previous.length >= D_PLATFORM_STATE_RECONCILIATION_LIMIT) {
          throw new DPlatformStateReconciliationError('RECONCILE_LIMIT_REACHED',
            `这个导入任务已经按平台现状收口过 ${previous.length} 次都没有核实，不再自动查询，请把停在什么上告诉施工方。`);
        }
        const imported = importedProductObservation(continuation);
        if (continuation?.taskId !== input.taskId ||
            String(imported?.result?.importObservation?.productId ?? '') !== input.productId) {
          throw new DPlatformStateReconciliationError('TASK_MISMATCH',
            '任务号或平台商品号与这一轮观察记录不一致。');
        }
        const policy = loadDPlatformObservationPolicy({ candidate, job, checkedAt: observedAt });
        if (policy === null) {
          throw new DPlatformStateReconciliationError('OBSERVATION_POLICY_UNAVAILABLE',
            '当前没有可用的平台查询策略：收口之后无人跟进，因此不收口。');
        }
        const sourceRevision = candidate.dataRevision;
        const reconciliationId = `d-platform-state-reconciliation:${job.jobId}:${input.taskId}:${previous.length + 1}`;
        let reconciled;
        try {
          reconciled = reconcileDUnknownOutcomeFromPlatformStateInDocument({ document, job, observedAt,
            actorId: actor.userId, policy, reconciliationId });
        } catch (error) {
          const code = String(error.message || '').split(':', 1)[0];
          throw new DPlatformStateReconciliationError('RECONCILE_NOT_ALLOWED', code || error.message);
        }
        // 作业放回 waiting_platform，并在同一事务里排出观察作业（同重新观察）。
        jobStore.recoverDInitialImportStoppedJobInDocument({ document, jobId: job.jobId, observedAt });
        const sourceDJob = findSoftwareJobInDocument(document, job.jobId);
        // 序号接着往下数，预算照常扣。
        const scope = createDPlatformObservationScope({ document, candidate, sourceDJob, policy,
          queryIndex: continuation.queryCount + 1, nextEligibleAt: observedAt, observedAt });
        const observation = jobStore.enqueueDPlatformObservationInDocument({ document, candidate, sourceDJob,
          scope, policy, observedAt });
        document.runtime.operationAudit.push(structuredClone(createOperationAuditEvent({
          eventId: `audit:${reconciliationId}`, action: 'reconcile_unknown_outcome_import_from_platform_state',
          actor, candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
          sourceRevision, resultRevision: candidate.dataRevision,
          fromState: 'D', toState: 'D', externalRequestState: 'not_sent',
          idempotencyKey: reconciliationId, serverTime: observedAt
        })));
        return { changed: true, document, result: Object.freeze({
          schemaVersion: 'd-platform-state-reconciliation-result-v1',
          reconciliationId, taskId: input.taskId, productId: input.productId,
          sourceDJobId: job.jobId, sourceRevision,
          archive: structuredClone(reconciled.archive),
          observationJobId: observation?.jobId ?? observation?.job?.jobId ?? null,
          externalRequests: 0, platformWrites: 0, productionRecordCreated: false
        }) };
      });
    }
  });
}
