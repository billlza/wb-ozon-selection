import { authorizeOperation, createOperationAuditEvent } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { reobserveDUnknownOutcomeInDocument, createDPlatformObservationScope,
  D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD } from './d-platform-observation-contract.mjs';
import { findSoftwareJobInDocument } from './software-job-contract.mjs';

export class DUnknownOutcomeReobservationError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'DUnknownOutcomeReobservationError'; this.code = code; }
}

const INPUT_KEYS = 'candidateId,confirmPlatformAlreadyCreatedProduct,expectedRevision,productId,sourceDJobId,taskId';

/**
 * 主人明确「按新分类重新观察一次」。
 *
 * 由来：2026-09-24 背心的导入被平台接受（商品号已建出），但导入任务上挂了 2 条错误。
 * 当时的判定是「errors 非空即结果未知」，**完全不看级别**，于是停在 unknown_outcome。
 * r70 改成按级别分类之后（只有 ERROR_LEVEL_WARNING 算警告），同一份平台事实可能得出不同结论。
 *
 * 这个用例只做一件事：把那一次停住的执行放回 waiting_platform，并排出一条新的观察作业。
 * **它不调用任何平台接口**——真正的只读查询由观察作业按策略去做。
 * 不重发导入、不写库存、不生成生产记录、不改授权。同一个 taskId 只能重新观察一次。
 *
 * 重新观察之后若仍判 unknown_outcome，也是有价值的：r70 ① 会把错误明细整份落盘并在视图逐条显示，
 * 主人不必再去卖家后台翻。
 */
export function createDUnknownOutcomeReobservationUseCase({ repository, serverClock, loadDPlatformObservationPolicy, jobStore }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function' || typeof loadDPlatformObservationPolicy !== 'function' ||
      typeof jobStore?.recoverDInitialImportStoppedJobInDocument !== 'function' ||
      typeof jobStore?.enqueueDPlatformObservationInDocument !== 'function') {
    throw new Error('D_UNKNOWN_OUTCOME_REOBSERVATION_DEPENDENCY_INVALID');
  }
  return Object.freeze({
    async reobserve({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ['owner'] });
      if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
        throw new DUnknownOutcomeReobservationError('OWNER_REQUIRED', '请先登录主人身份再重新观察。');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== INPUT_KEYS ||
          input.confirmPlatformAlreadyCreatedProduct !== true ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
          ['candidateId', 'sourceDJobId', 'taskId', 'productId'].some(field =>
            typeof input[field] !== 'string' || input[field].trim() === '')) {
        throw new DUnknownOutcomeReobservationError('INPUT_INVALID',
          '重新观察必须准确引用当前商品、那一轮作业，以及平台已经建出的那个商品号。');
      }
      return repository.transact(document => {
        const observedAt = serverClock();
        const candidate = document.candidates?.find(entry => entry.id === input.candidateId);
        if (!candidate) throw new DUnknownOutcomeReobservationError('CANDIDATE_NOT_FOUND', '候选不存在。');
        if (candidate.dataRevision !== input.expectedRevision) {
          throw new DUnknownOutcomeReobservationError('CANDIDATE_CHANGED', '商品资料已变化，请刷新后核对当前记录。');
        }
        const job = findSoftwareJobInDocument(document, input.sourceDJobId);
        if (!job || job.candidateId !== candidate.id) {
          throw new DUnknownOutcomeReobservationError('JOB_NOT_FOUND', '找不到这一轮生产作业。');
        }
        // 幂等先判：重新观察会改写 attempt 与 continuation，若把任务号比对放前面，
        // 第二次点击会报成「任务号不一致」——挡是挡住了，理由却是错的，会误导主人。
        const already = (candidate.lifecycleV11[D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD] ?? [])
          .find(entry => entry.taskId === input.taskId);
        if (already) {
          throw new DUnknownOutcomeReobservationError('ALREADY_REOBSERVED',
            `这个导入任务已经在 ${already.reobservedAt} 按新分类重新观察过一次了，不会重复观察。`);
        }
        const continuation = candidate.lifecycleV11.skuPackage.dSoftwareExecution?.platformContinuation;
        const last = continuation?.observationHistory?.at(-1);
        if (continuation?.taskId !== input.taskId ||
            String(last?.result?.importObservation?.productId ?? '') !== input.productId) {
          throw new DUnknownOutcomeReobservationError('TASK_MISMATCH',
            '任务号或平台商品号与这一轮观察记录不一致。');
        }
        const policy = loadDPlatformObservationPolicy({ candidate, job, checkedAt: observedAt });
        if (policy === null) {
          throw new DUnknownOutcomeReobservationError('OBSERVATION_POLICY_UNAVAILABLE',
            '当前没有可用的平台查询策略：重新观察之后无人跟进，因此不观察。');
        }
        const sourceRevision = candidate.dataRevision;
        const reobservationId = `d-unknown-outcome-reobservation:${job.jobId}:${input.taskId}`;
        let reobserved;
        try {
          reobserved = reobserveDUnknownOutcomeInDocument({ document, job, observedAt,
            actorId: actor.userId, policy, reobservationId });
        } catch (error) {
          const code = String(error.message || '').split(':', 1)[0];
          throw new DUnknownOutcomeReobservationError('REOBSERVE_NOT_ALLOWED', code || error.message);
        }
        // 作业放回 waiting_platform，并在同一事务里排出观察作业——
        // 否则迁移完没人动，等于把一个停住的状态换成另一个停住的状态。
        jobStore.recoverDInitialImportStoppedJobInDocument({ document, jobId: job.jobId, observedAt });
        const sourceDJob = findSoftwareJobInDocument(document, job.jobId);
        // 这不是本轮的第一次观察：已经查过 queryCount 次，序号必须接着往下数，
        // 否则 createDPlatformObservationScope 会判 SEQUENCE_CONFLICT。
        // 预算也照常扣——重新观察不是免费的重来。
        const scope = createDPlatformObservationScope({ document, candidate, sourceDJob, policy,
          queryIndex: continuation.queryCount + 1, nextEligibleAt: observedAt, observedAt });
        const observation = jobStore.enqueueDPlatformObservationInDocument({ document, candidate, sourceDJob,
          scope, policy, observedAt });
        document.runtime.operationAudit.push(structuredClone(createOperationAuditEvent({
          eventId: `audit:${reobservationId}`, action: 'reobserve_unknown_outcome_import_under_new_classification',
          actor, candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
          sourceRevision, resultRevision: candidate.dataRevision,
          fromState: 'D', toState: 'D', externalRequestState: 'not_sent',
          idempotencyKey: reobservationId, serverTime: observedAt
        })));
        return { changed: true, document, result: Object.freeze({
          schemaVersion: 'd-unknown-outcome-reobservation-result-v1',
          reobservationId, taskId: input.taskId, productId: input.productId,
          sourceDJobId: job.jobId, sourceRevision,
          archive: structuredClone(reobserved.archive),
          observationJobId: observation?.jobId ?? observation?.job?.jobId ?? null,
          externalRequests: 0, platformWrites: 0, productionRecordCreated: false
        }) };
      });
    }
  });
}
