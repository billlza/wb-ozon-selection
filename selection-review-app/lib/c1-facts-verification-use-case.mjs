import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { resolveC1SkuRightsReviewForFacts } from "./c1-sku-rights-review.mjs";

export class C1FactsVerificationError extends Error {
  constructor(code) { super(code); this.name = "C1FactsVerificationError"; this.code = code; }
}

/**
 * 把「按主人签下的权利声明冻结 C1 事实」单独做成一次显式动作。
 *
 * 2026-09-17 之前没有这一步，结果是一个死锁：本地素材生产器要求 C1 计划已经是 facts_checked
 * （`c1-keyword-planning-local-material.mjs` 只拒绝、不自己核验），而真正会核验的编排器排在它后面，
 * 于是主人签完声明之后整条链一步也走不动，界面上三个 can* 全是 false。
 *
 * 这一步只读已经冻结的输入加主人自己签的那份声明，是确定性的：不联网、不调 AI、不碰平台、不花钱。
 * 声明本身仍然只是一次声明——是这个显式动作来消费它，而不是保存声明时顺手推状态机
 * （那条边界由 local-owner-access-api 的测试守着，2026-09-17 我试着推翻过一次，被它逮回来了）。
 */
export function createC1FactsVerificationUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") {
    throw new TypeError("C1_FACTS_VERIFICATION_DEPENDENCY_INVALID");
  }
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    async verify({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "expectedRevision", "skuPackageId", "idempotencyKey", "auditEventId"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
          keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          keys.filter(key => key !== "expectedRevision").some(key => typeof input[key] !== "string" || !input[key].trim())) {
        throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_INPUT_INVALID");
      }
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_AUTHENTICATED_OWNER_REQUIRED");
      }
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "c1_verify_facts_from_owner_declaration", candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate, relatedSoftwareJobs, observedAt }) => {
          const sku = candidate.lifecycleV11?.skuPackage;
          if (sku?.skuPackageId !== input.skuPackageId) throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_SOURCE_CONFLICT");
          if (sku.businessPhase !== "C1") throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_PHASE_REJECTED");
          // 已经冻结过就不再冻一次：这一步是幂等的，重复点不产生第二份事实。
          if (sku.c1ProductPlan?.status !== "inputs_ready") throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_ALREADY_FROZEN");
          // 有在跑的 C1 作业时不动事实：冻结中途换掉事实会让那个作业的输入指纹对不上。
          if (relatedSoftwareJobs.length !== 0) throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_JOBS_PRESENT");
          const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt });
          if (rights.status !== "verified") throw new C1FactsVerificationError("C1_FACTS_VERIFICATION_RIGHTS_REQUIRED");
          const verified = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights.review, verifiedAt: observedAt });
          candidate.lifecycleV11.skuPackage = structuredClone(verified.skuPackage);
          candidate.updatedAt = observedAt;
          candidate.lastModifiedBy = "software";
          return {
            candidate,
            result: {
              schemaVersion: "c1-facts-verification-result-v1",
              c1PlanId: verified.skuPackage.c1ProductPlan.c1PlanId,
              status: verified.skuPackage.c1ProductPlan.status,
              factsVerifiedAt: verified.skuPackage.c1ProductPlan.factsVerifiedAt,
              factVerificationVersion: verified.skuPackage.c1ProductPlan.factVerificationVersion,
              externalCalls: 0, aiCalls: 0, codexDispatches: 0, platformWrites: 0, paidCalls: 0
            }
          };
        }
      });
    }
  });
}
