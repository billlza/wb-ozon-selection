import { authorizeOperation, createOperationAuditEvent } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { enqueueDProductionRoundInDocument } from './d-e-software-job-handoff.mjs';

export class DProductionRoundError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'DProductionRoundError'; this.code = code; }
}

const INPUT_KEYS = 'candidateId,confirmPreviousRoundSentNothing,expectedRevision,supersededJobId';

/**
 * 主人明确「再派一轮生产作业」。这一轮用的还是同一份不可变生产授权：价格、库存、素材、顺序、
 * 商品事实全都不动，候选 revision 也不动——轮次是技术执行尝试，不是新的商业决定，也不是新授权。
 * 本用例零外部请求、零平台写入；它只在中央状态里排一个新的受控作业，等主人自己去点执行。
 */
export function createDProductionRoundUseCase({ repository, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function') throw new Error('D_PRODUCTION_ROUND_DEPENDENCY_INVALID');
  return Object.freeze({
    async dispatch({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ['owner'] });
      if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
        throw new DProductionRoundError('OWNER_REQUIRED', '请先登录主人身份再派新一轮生产作业。');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== INPUT_KEYS || input.confirmPreviousRoundSentNothing !== true ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
          typeof input.candidateId !== 'string' || !input.candidateId ||
          typeof input.supersededJobId !== 'string' || !input.supersededJobId) {
        throw new DProductionRoundError('INPUT_INVALID', '重派请求必须准确引用当前这件商品和上一轮作业。');
      }
      return repository.transact(document => {
        const observedAt = serverClock();
        const candidate = document.candidates?.find(entry => entry.id === input.candidateId);
        if (!candidate) throw new DProductionRoundError('CANDIDATE_NOT_FOUND', '候选不存在。');
        if (candidate.dataRevision !== input.expectedRevision) {
          throw new DProductionRoundError('CANDIDATE_CHANGED', '商品资料已变化，请刷新后核对当前记录。');
        }
        const sku = candidate.lifecycleV11?.skuPackage;
        const authorization = sku?.productionAuthorization;
        if (!authorization) throw new DProductionRoundError('AUTHORIZATION_REQUIRED', '本商品尚无生产授权，无法重派。');
        const outcome = enqueueDProductionRoundInDocument({ document, candidate, observedAt,
          expectedSupersededJobId: input.supersededJobId });
        if (outcome.blocked !== null) throw new DProductionRoundError('ROUND_NOT_ALLOWED', outcome.blocked);
        const phase = String(sku.businessPhase);
        document.runtime.operationAudit.push(structuredClone(createOperationAuditEvent({
          eventId: `audit:d-production-round:${outcome.jobId}`, action: 'dispatch_d_production_execution_round',
          actor, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
          sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision,
          fromState: phase, toState: phase, externalRequestState: 'not_sent',
          idempotencyKey: outcome.jobId, serverTime: observedAt
        })));
        return { changed: true, document, result: Object.freeze({
          schemaVersion: 'd-production-execution-round-result-v1', round: outcome.round, jobId: outcome.jobId,
          supersededJobId: outcome.supersededJobId, supersededFailureClass: outcome.supersededFailureClass,
          expectedRevision: candidate.dataRevision, externalRequests: 0, platformWrites: 0
        }) };
      });
    }
  });
}
