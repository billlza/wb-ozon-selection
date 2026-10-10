import { buildLifecycleBExplicitOtherCosts, resolveLifecycleBProfitRule } from "./lifecycle-b-evidence-runtime.mjs";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { BExactCommissionRecalculationError, runSavedConditionalBWithExactEvidence } from "./real-a-b-c1-flow.mjs";
import { recoverBExactCommissionTechnicalFailure, startSoftwareStep, completeExecutionStep } from "./software-execution-state.mjs";

/** Explicit owner action over saved evidence only; no connector or scheduler dependency. */
export function createBExactCommissionRecalculationUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") {
    throw new TypeError("B_EXACT_RECALCULATION_DEPENDENCY_INVALID");
  }
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    async recalculate({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "expectedRevision", "skuPackageId", "failureId", "idempotencyKey", "auditEventId"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
          keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          keys.filter(key => key !== "expectedRevision").some(key => typeof input[key] !== "string" || !input[key].trim())) {
        throw new BExactCommissionRecalculationError("B_EXACT_RECALCULATION_INPUT_INVALID");
      }
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new BExactCommissionRecalculationError("B_EXACT_RECALCULATION_AUTHENTICATED_OWNER_REQUIRED");
      }
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "b_exact_commission_recalculate", candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate, evidencePacks, currentCommissionCatalogs, rules, relatedSoftwareJobs, observedAt }) => {
          if (candidate.lifecycleV11?.skuPackage?.skuPackageId !== input.skuPackageId ||
              candidate.executionRuntime?.technicalFailure?.failureId !== input.failureId) {
            throw new BExactCommissionRecalculationError("B_EXACT_RECALCULATION_SOURCE_CONFLICT");
          }
          if (relatedSoftwareJobs.length !== 0) throw new BExactCommissionRecalculationError("B_EXACT_RECALCULATION_JOBS_PRESENT");
          const otherCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules), { asOf: observedAt });
          const computed = runSavedConditionalBWithExactEvidence({ candidate, evidencePacks, currentCommissionCatalogs, otherCosts, processedAt: observedAt });
          const priorSystemEvidenceBundle = structuredClone(candidate.lifecycleV11.bSystemEvidenceBundle);
          const recovered = recoverBExactCommissionTechnicalFailure(candidate.executionRuntime, {
            failureId: input.failureId, candidateId: input.candidateId, sourceRevision: input.expectedRevision, at: observedAt
          });
          const passed = computed.profitModel.result === "passed";
          candidate.lifecycleV11.skuPackage = structuredClone(computed.skuPackage);
          candidate.lifecycleV11.bSystemEvidenceBundle = structuredClone(computed.systemEvidenceBundle);
          candidate.lifecycleV11.c1Handoffs = computed.c1Handoff ? [structuredClone(computed.c1Handoff)] : [];
          candidate.lifecycleV11.status = passed ? "b_passed_auto_c1" : "b_rejected";
          candidate.executionRuntime = completeExecutionStep(startSoftwareStep(recovered.runtime, {
            stepId: "B_DETERMINISTIC_PROFIT", inputRevision: input.expectedRevision, at: observedAt
          }), { outputRevision: input.expectedRevision + 1, at: observedAt });
          candidate.executionRuntime.businessPhase = passed ? "C1" : "B";
          candidate.workflowStatus = passed ? "listing_preparation" : "eliminated";
          candidate.neededFields = [];
          candidate.bPassedAt = passed ? observedAt : null;
          candidate.updatedAt = observedAt;
          candidate.listingPreparation = passed ? { status: "c1_inputs_ready", reason: "精确佣金已保存，正式B复算通过；C1输入已原子创建。",
            decisionItems: [], writeOccurred: false, platformWrites: 0 } : null;
          candidate.listingHandoff = passed ? { state: "created", owner: "listing_task", runId: null,
            currentStep: "B利润通过，C1输入已自动创建", blockReason: null, userAction: "无需再次点击开始上架准备",
            inheritedInputRevision: computed.c1Handoff.inheritedSkuRevision, handoffId: computed.c1Handoff.handoffId,
            realTaskDispatched: false } : null;
          if (!passed) {
            candidate.eliminatedAt = observedAt;
            candidate.eliminationReason = `B阶段利润未达到当前门槛：单件利润${computed.profitModel.unitProfitRmb}元，利润率${(computed.profitModel.profitMargin * 100).toFixed(1)}%`;
          }
          // 这一次到底用了哪一种费用证据，跟着结果一起回去。复算接受店里的实收费率和官方费率表两种，
          // 两种都算正式B，但不是一回事；不带上这一项，页面只能说「复算成功了」，主人会当成拿到了平台实收。
          const usedFee = computed.systemEvidenceBundle.platformFeeEvidence;
          return { candidate, result: { schemaVersion: "b-exact-commission-recalculation-v1",
            status: passed ? "passed" : "rejected", priorSystemEvidenceBundle,
            priorTechnicalFailure: recovered.priorTechnicalFailure,
            commissionEvidenceMode: usedFee.commissionEvidenceMode, commissionRate: usedFee.commissionRate,
            newBundleRef: computed.systemEvidenceBundle.bundleId, profitModelVersion: computed.profitModel.profitModelVersion,
            c1HandoffId: computed.c1Handoff?.handoffId ?? null, externalAccesses: [], platformWrites: 0 } };
        }
      });
    }
  });
}
