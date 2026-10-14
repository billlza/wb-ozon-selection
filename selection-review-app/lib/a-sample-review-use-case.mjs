import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { assessAStageMarket } from "./market-sample-policy.mjs";

export class ASampleReviewError extends Error {
  constructor(code) { super(code); this.name = "ASampleReviewError"; this.code = code; }
}

/**
 * 主人复核「哪几个采到的对标算数」，软件据此重算 A 阶段市场判定。
 *
 * 为什么需要这一步：C1 的关键词本地素材要求 3–5 个**已审查**的主要竞品
 * （`c1-keyword-planning-local-material.mjs` 的 comparableTexts），判据是
 * marketAssessment.sampleSummaries 里那四项——可比性、价格证据、时效、可追溯。
 * 这四项是**商业判断，软件读不出来**，只能由主人给。
 *
 * 而在 2026-09-17 之前，这个判断只在 C2 的最终定价复核里做，C1 够不着——
 * 于是「A 只带了一个样本进来」的候选（对标门在 A 是软的，1 个也放行）
 * 到了 C1 就永远凑不齐关键词素材。这一步把那个判断提到 C1。
 *
 * 语义与 C2 那条路完全一致（`final-pricing-revalidation.mjs`）：**选中即代表那四项都成立**，
 * 没选中的记为未知/缺失。不另外问四遍，也不替主人默认任何一项。
 *
 * 这一步**不碰价格**：重算后把原来的 recommendedSalePrice 原样写回。
 * 定价是「最终定价复核」那一步的决定，不能被一次样本复核顺手改掉——
 * B 阶段那份利润模型是按旧价冻结的，价格一动它就对不上了。
 */
export function createASampleReviewUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") {
    throw new TypeError("A_SAMPLE_REVIEW_DEPENDENCY_INVALID");
  }
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    async review({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "expectedRevision", "skuPackageId", "selectedSnapshotIds", "idempotencyKey", "auditEventId"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
          keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          !Array.isArray(input.selectedSnapshotIds) ||
          keys.filter(key => !["expectedRevision", "selectedSnapshotIds"].includes(key))
            .some(key => typeof input[key] !== "string" || !input[key].trim())) {
        throw new ASampleReviewError("A_SAMPLE_REVIEW_INPUT_INVALID");
      }
      const selected = [...new Set(input.selectedSnapshotIds)];
      if (selected.length !== input.selectedSnapshotIds.length ||
          selected.some(id => typeof id !== "string" || !id.trim())) {
        throw new ASampleReviewError("A_SAMPLE_REVIEW_INPUT_INVALID");
      }
      // 少于 3 个成不了本地素材，多于 5 个这套判定本身不认。这两条都不是我加的门槛，
      // 是 comparableTexts 和 assessAStageMarket 现成的要求，这里提前说清楚而不是等下游报一句难懂的话。
      if (selected.length < 3 || selected.length > 5) throw new ASampleReviewError("A_SAMPLE_REVIEW_COUNT_OUT_OF_RANGE");
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new ASampleReviewError("A_SAMPLE_REVIEW_AUTHENTICATED_OWNER_REQUIRED");
      }
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "a_sample_comparability_review", candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock,
        mutate: ({ candidate, observedAt }) => {
          const lifecycle = candidate.lifecycleV11;
          const sku = lifecycle?.skuPackage;
          if (sku?.skuPackageId !== input.skuPackageId) throw new ASampleReviewError("A_SAMPLE_REVIEW_SOURCE_CONFLICT");
          const opportunity = lifecycle?.opportunityPackage;
          if (opportunity === null || typeof opportunity !== "object" || Array.isArray(opportunity) ||
              !Array.isArray(opportunity.salesSnapshots)) {
            throw new ASampleReviewError("A_SAMPLE_REVIEW_OPPORTUNITY_MISSING");
          }
          // 候选身上采到的对标要先并进机会包——assessAStageMarket 只看机会包里的快照。
          // 已经在里面的不覆盖：同一个 snapshotId 两份内容不一致时停下来，不悄悄以新的为准。
          const bySnapshotId = new Map(opportunity.salesSnapshots.map(item => [item.snapshotId, item]));
          for (const snapshot of (candidate.salesSnapshotsV11 || [])) {
            if (!bySnapshotId.has(snapshot.snapshotId)) {
              opportunity.salesSnapshots.push(structuredClone(snapshot));
              bySnapshotId.set(snapshot.snapshotId, snapshot);
            }
          }
          const missing = selected.filter(id => !bySnapshotId.has(id));
          if (missing.length) throw new ASampleReviewError("A_SAMPLE_REVIEW_SNAPSHOT_NOT_FOUND");

          const sampleReviews = Object.fromEntries(opportunity.salesSnapshots.map(snapshot => [snapshot.snapshotId, {
            comparability: selected.includes(snapshot.snapshotId) ? "comparable" : "unknown",
            priceEvidenceStatus: selected.includes(snapshot.snapshotId) ? "verified" : "missing",
            validityStatus: selected.includes(snapshot.snapshotId) ? "current" : "unknown",
            evidenceTraceable: selected.includes(snapshot.snapshotId)
          }]));
          const previousPrice = opportunity.marketAssessment?.recommendedSalePrice ?? null;
          const assessed = assessAStageMarket({
            opportunityPackage: { ...opportunity, salesSnapshots: opportunity.salesSnapshots.filter(s => selected.includes(s.snapshotId)) },
            sampleReviews, assessedAt: observedAt,
            assessmentId: `a-market-review:${input.candidateId}:${input.expectedRevision}`
          });
          opportunity.marketAssessment = structuredClone(assessed);
          // 价格不动：B 那份利润模型是按旧价冻结的。定价在「最终定价复核」那一步决定。
          if (previousPrice !== null) opportunity.marketAssessment.recommendedSalePrice = structuredClone(previousPrice);
          candidate.updatedAt = observedAt;
          candidate.lastModifiedBy = "software";
          return {
            candidate,
            result: {
              schemaVersion: "a-sample-review-result-v1",
              assessmentId: opportunity.marketAssessment.assessmentId,
              reviewedSnapshotIds: [...selected],
              primarySampleIds: [...(opportunity.marketAssessment.primarySampleIds || [])],
              excludedSampleIds: [...(opportunity.marketAssessment.excludedSampleIds || [])],
              confidence: opportunity.marketAssessment.confidence,
              priceBand: structuredClone(opportunity.marketAssessment.priceBand ?? null),
              recommendedSalePriceUnchanged: true,
              externalCalls: 0, aiCalls: 0, platformWrites: 0, paidCalls: 0
            }
          };
        }
      });
    }
  });
}
