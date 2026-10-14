import { authorizeOperation, createOperationAuditEvent } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { rollbackProductionAuthorizationInDocument } from './production-authorization-rollback.mjs';

export class ProductionAuthorizationRollbackError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ProductionAuthorizationRollbackError'; this.code = code; }
}

const INPUT_KEYS = 'authorizationId,candidateId,confirmNothingWasSentToPlatform,expectedRevision';

/**
 * 主人明确「作废本轮生产授权，退回等我确认」。旧授权、旧交接、旧素材传输和主人的旧决定整体归档留底，
 * 一条不删；两轮失败作业原地保留。SKU 包恢复到签这份授权之前的那一刻，候选 revision 照常往前走。
 * 本用例零外部请求、零平台写入、零AI调用，也不创建任何新授权——新授权仍由主人在最终确认卡上重签。
 */
export function createProductionAuthorizationRollbackUseCase({ repository, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function') throw new Error('PRODUCTION_AUTHORIZATION_ROLLBACK_DEPENDENCY_INVALID');
  return Object.freeze({
    async rollback({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ['owner'] });
      if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
        throw new ProductionAuthorizationRollbackError('OWNER_REQUIRED', '请先登录主人身份再作废生产授权。');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== INPUT_KEYS || input.confirmNothingWasSentToPlatform !== true ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
          typeof input.candidateId !== 'string' || !input.candidateId ||
          typeof input.authorizationId !== 'string' || !input.authorizationId) {
        throw new ProductionAuthorizationRollbackError('INPUT_INVALID', '作废请求必须准确引用当前这件商品和当前这份授权。');
      }
      return repository.transact(document => {
        const observedAt = serverClock();
        const candidate = document.candidates?.find(entry => entry.id === input.candidateId);
        if (!candidate) throw new ProductionAuthorizationRollbackError('CANDIDATE_NOT_FOUND', '候选不存在。');
        if (candidate.dataRevision !== input.expectedRevision) {
          throw new ProductionAuthorizationRollbackError('CANDIDATE_CHANGED', '商品资料已变化，请刷新后核对当前记录。');
        }
        const sku = candidate.lifecycleV11?.skuPackage;
        if (!sku) throw new ProductionAuthorizationRollbackError('SKU_NOT_FOUND', '本候选没有SKU生命周期包。');
        const sourceRevision = candidate.dataRevision;
        const outcome = rollbackProductionAuthorizationInDocument({ document, candidate, observedAt,
          actorId: actor.userId, expectedAuthorizationId: input.authorizationId });
        if (outcome.blocked !== null) throw new ProductionAuthorizationRollbackError('ROLLBACK_NOT_ALLOWED', outcome.blocked);
        document.runtime.operationAudit.push(structuredClone(createOperationAuditEvent({
          eventId: `audit:pa-rollback:${outcome.archive.archiveId}`,
          action: 'rollback_production_authorization_to_pre_signature',
          actor, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
          sourceRevision, resultRevision: candidate.dataRevision,
          fromState: 'D', toState: 'C2', externalRequestState: 'not_sent',
          idempotencyKey: outcome.archive.archiveId, serverTime: observedAt
        })));
        return { changed: true, document, result: Object.freeze({
          schemaVersion: 'production-authorization-rollback-result-v1',
          archiveId: outcome.archive.archiveId,
          archivedAuthorizationId: outcome.archive.productionAuthorizationRef.authorizationId,
          restoredSkuRevision: outcome.archive.restoredSkuRevision,
          resultAuthorizationRound: outcome.archive.resultAuthorizationRound,
          archivedDProductionJobIds: [...outcome.archive.dProductionJobIds],
          expectedRevision: candidate.dataRevision,
          externalRequests: 0, platformWrites: 0, productionAuthorizationCreated: false
        }) };
      });
    }
  });
}
