import { authorizeOperation, createOperationAuditEvent } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { recoverDInitialImportStoppedInDocument, createDPlatformObservationScope } from './d-platform-observation-contract.mjs';
import { findSoftwareJobInDocument } from './software-job-contract.mjs';

export class DInitialImportRecoveryError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'DInitialImportRecoveryError'; this.code = code; }
}

const INPUT_KEYS = 'candidateId,confirmImportAlreadyAcceptedByPlatform,expectedRevision,requestReceiptRef,sourceDJobId,taskId';

/**
 * 主人明确「对账并恢复已接受的导入」。这一次动作只做一件事：把一次被软件自己误停、
 * 而平台其实已经接受的导入执行，放回 waiting_platform，并排出第一条观察作业。
 *
 * 之后查 import/info、拿 product_id、按原授权锁定的仓库与数量写库存、出回执、生成生产记录，
 * 全部由现成的观察链完成——本用例不调用任何平台接口，也不新造生产记录。
 * 它只对「已被平台接受、停在 d-initial-import-context-changed」的那一次执行有效，
 * 同一个 taskId 只能恢复一次。
 */
export function createDInitialImportRecoveryUseCase({ repository, serverClock, loadDPlatformObservationPolicy, jobStore }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function' || typeof loadDPlatformObservationPolicy !== 'function' ||
      typeof jobStore?.recoverDInitialImportStoppedJobInDocument !== 'function' ||
      typeof jobStore?.enqueueDPlatformObservationInDocument !== 'function') {
    throw new Error('D_INITIAL_IMPORT_RECOVERY_DEPENDENCY_INVALID');
  }
  return Object.freeze({
    async recover({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ['owner'] });
      if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
        throw new DInitialImportRecoveryError('OWNER_REQUIRED', '请先登录主人身份再对账恢复已接受的导入。');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== INPUT_KEYS ||
          input.confirmImportAlreadyAcceptedByPlatform !== true ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
          ['candidateId', 'sourceDJobId', 'taskId', 'requestReceiptRef'].some(field =>
            typeof input[field] !== 'string' || input[field].trim() === '')) {
        throw new DInitialImportRecoveryError('INPUT_INVALID', '恢复请求必须准确引用当前商品、那一轮作业和平台已接受的那个任务。');
      }
      return repository.transact(document => {
        const observedAt = serverClock();
        const candidate = document.candidates?.find(entry => entry.id === input.candidateId);
        if (!candidate) throw new DInitialImportRecoveryError('CANDIDATE_NOT_FOUND', '候选不存在。');
        if (candidate.dataRevision !== input.expectedRevision) {
          throw new DInitialImportRecoveryError('CANDIDATE_CHANGED', '商品资料已变化，请刷新后核对当前记录。');
        }
        const job = findSoftwareJobInDocument(document, input.sourceDJobId);
        if (!job || job.candidateId !== candidate.id) {
          throw new DInitialImportRecoveryError('JOB_NOT_FOUND', '找不到这一轮生产作业。');
        }
        // 幂等先判：恢复之后 resultEnvelope 会被清空，若把任务号比对放在前面，
        // 第二次点击会报成「任务号不一致」——挡是挡住了，但理由是错的，会误导主人。
        const alreadyRecovered = (candidate.lifecycleV11.dInitialImportRecoveryV1 ?? [])
          .find(entry => entry.taskId === input.taskId);
        if (alreadyRecovered) {
          throw new DInitialImportRecoveryError('ALREADY_RECOVERED',
            `这个导入任务已经在 ${alreadyRecovered.recoveredAt} 对账恢复过一次了，不会重复恢复。`);
        }
        if (job.resultEnvelope?.payload?.taskId !== input.taskId ||
            job.resultEnvelope.payload.requestReceiptRef !== input.requestReceiptRef) {
          throw new DInitialImportRecoveryError('TASK_MISMATCH', '任务号或平台回执与这一轮作业的记录不一致。');
        }
        const policy = loadDPlatformObservationPolicy({ candidate, job, checkedAt: observedAt });
        if (policy === null) {
          throw new DInitialImportRecoveryError('OBSERVATION_POLICY_UNAVAILABLE',
            '当前没有可用的平台查询策略：恢复之后无人跟进，因此不恢复。');
        }
        const sourceRevision = candidate.dataRevision;
        const recoveryId = `d-initial-import-recovery:${job.jobId}:${input.taskId}`;
        let recovered;
        try {
          recovered = recoverDInitialImportStoppedInDocument({ document, job, observedAt,
            actorId: actor.userId, policy, recoveryId });
        } catch (error) {
          const code = String(error.message || '').split(':', 1)[0];
          throw new DInitialImportRecoveryError('RECOVERY_NOT_ALLOWED', code || error.message);
        }
        // 作业侧放回 waiting_platform，并在同一事务里排出第一条观察作业——
        // 否则迁移完没人动，等于把一个停住的状态换成另一个停住的状态。
        jobStore.recoverDInitialImportStoppedJobInDocument({ document, jobId: job.jobId, observedAt });
        const sourceDJob = findSoftwareJobInDocument(document, job.jobId);
        const scope = createDPlatformObservationScope({ document, candidate, sourceDJob, policy,
          queryIndex: 1, nextEligibleAt: observedAt, observedAt });
        const observation = jobStore.enqueueDPlatformObservationInDocument({ document, candidate, sourceDJob,
          scope, policy, observedAt });
        document.runtime.operationAudit.push(structuredClone(createOperationAuditEvent({
          eventId: `audit:${recoveryId}`, action: 'recover_accepted_initial_import_and_enqueue_observation',
          actor, candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
          sourceRevision, resultRevision: candidate.dataRevision,
          fromState: 'D', toState: 'D', externalRequestState: 'not_sent',
          idempotencyKey: recoveryId, serverTime: observedAt
        })));
        return { changed: true, document, result: Object.freeze({
          schemaVersion: 'd-initial-import-recovery-result-v1',
          recoveryId, taskId: input.taskId, requestReceiptRef: input.requestReceiptRef,
          sourceDJobId: job.jobId, sourceRevision,
          archive: structuredClone(recovered.archive),
          observationJobId: observation?.jobId ?? observation?.job?.jobId ?? null,
          externalRequests: 0, platformWrites: 0, productionRecordCreated: false
        }) };
      });
    }
  });
}
