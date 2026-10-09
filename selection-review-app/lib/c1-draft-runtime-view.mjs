import { assertCurrentC1AiDraftRequestSources, prepareCurrentC1AiDraftRequest } from "./c1-ai-draft-request-source.mjs";
import { C1SkuRightsReviewError, C1_SKU_RIGHTS_REVIEW_FAILURE_CODES } from "./c1-sku-rights-review.mjs";
import { assertC1PaidKeywordContinuationResult } from "./software-job-repository.mjs";
import { recoverC1KeywordHandoffTechnicalFailure } from "./software-execution-state.mjs";
import { C1_LOCAL_DRAFT_FAILURE_CODES } from "./c1-local-draft-source.mjs";
import { isC1AiDraftReconciliationPending } from "./software-job-contract.mjs";
import { buildC1GatewayJob, C1AiGatewayError } from "./c1-ai-gateway.mjs";
import { OwnerProductFactsError } from "./owner-product-facts.mjs";
import { ConfirmedSupplierInputError, assertC1SupplierFactRevisionProjection } from "./confirmed-supplier-inputs.mjs";

const OWNER_DECLARATION_SOURCE_CODES = new Set(["OWNER_PRODUCT_FACTS_SOURCE_MISMATCH", "OWNER_PRODUCT_FACTS_RECORD_INVALID"]);
const OWNER_PROJECTION_SOURCE_CODES = new Set(["C1_SUPPLIER_FACT_REVISION_OWNER_SOURCE_MISMATCH",
  "C1_SUPPLIER_FACT_REVISION_OWNER_TIME_INVALID", "C1_SUPPLIER_FACT_REVISION_OWNER_PROJECTION_CHANGED"]);

const SOURCE_GATE_CODES = new Set([
  "C1_DRAFT_REQUEST_INVALID", "C1_DRAFT_EVIDENCE_REQUIRED", "C1_DRAFT_EVIDENCE_NOT_CURRENT", "C1_DRAFT_REQUEST_SOURCE_CONFLICT",
  "C1_AI_REQUEST_INVALID", "C1_AI_REQUEST_GATE_REJECTED", "C1_AI_FACT_DRIFT_DETECTED", "C1_AI_SOURCE_BINDING_REJECTED",
  "C1_AI_COMPETITOR_EVIDENCE_INVALID", "C1_INPUT_PREPARATION_EVIDENCE_DRIFT", "C1_EVIDENCE_STAGE_DUPLICATE_DRIFT",
  "C1_PAID_KEYWORD_CONTINUATION_SOURCE_CONFLICT", "C1_KEYWORD_HANDOFF_RECOVERY_REJECTED",
  ...C1_LOCAL_DRAFT_FAILURE_CODES.filter(code => code !== "C1_SKU_RIGHTS_REVIEW_TIME_INVALID")
]);

function sourceBlockReasonFromError(error) {
  if (error instanceof C1AiGatewayError && error.code === "C1_AI_GATEWAY_INPUT_TOO_LARGE") return error.code;
  if ((error instanceof OwnerProductFactsError && OWNER_DECLARATION_SOURCE_CODES.has(error.code)) ||
      (error instanceof ConfirmedSupplierInputError && OWNER_PROJECTION_SOURCE_CODES.has(error.code))) return error.code;
  if (error instanceof C1SkuRightsReviewError && C1_SKU_RIGHTS_REVIEW_FAILURE_CODES.includes(error.code) &&
      error.code !== "C1_SKU_RIGHTS_REVIEW_TIME_INVALID") return error.code;
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
    const code = error.message.split(":", 1)[0];
    if (SOURCE_GATE_CODES.has(code) && !OWNER_DECLARATION_SOURCE_CODES.has(code) && !OWNER_PROJECTION_SOURCE_CODES.has(code)) return code;
  }
  throw error;
}

function currentSourceBlock(candidate, request, observedAt) {
  try {
    const plan = candidate.lifecycleV11.skuPackage.c1ProductPlan;
    // Preserve the typed owner-source failure before generic plan validation
    // formats its diagnostics. Legacy plans keep their existing validation path.
    if (plan.sourceFactsRevision?.schemaVersion === "c1-supplier-fact-revision-v2" ||
        Object.hasOwn(plan.productAttributes ?? {}, "ownerDeclaredFacts")) {
      assertC1SupplierFactRevisionProjection({ plan, sourceIdentity: candidate.lifecycleV11.skuPackage.g1Identity });
    }
    assertCurrentC1AiDraftRequestSources({ candidate, request, observedAt });
    buildC1GatewayJob({ candidateId: candidate.id, dataRevision: candidate.dataRevision, request });
    return null;
  } catch (error) {
    // Only declared evidence failures are display states. Invalid clocks and
    // unexpected/programming errors must remain visible to the caller.
    return sourceBlockReasonFromError(error);
  }
}

function configurationBlock(serviceBindings, provider, credentialAlias = null) {
  const binding = serviceBindings.find(value => value.provider === provider && value.modelVersion === `gpt-5.6-${provider}`);
  if (!binding) return { configurationBlockReason: "C1_DRAFT_RUNTIME_NOT_CONFIGURED",
    currentOwner: "技术维护", nextAction: "补齐原文案服务配置后再继续当前任务。",
    message: "尚未配置该文案服务，当前任务无法继续。" };
  if (credentialAlias !== null && binding.credentialAlias !== credentialAlias) {
    return { configurationBlockReason: "C1_DRAFT_SERVICE_BINDING_CONFLICT",
      currentOwner: "技术维护", nextAction: "核对并恢复与原任务一致的服务配置。",
      message: "当前文案服务配置与已许可任务不一致，请核对原任务的服务配置。" };
  }
  return null;
}

function savedDurationSeconds(startedAt, completedAt) {
  if (typeof startedAt !== "string" || typeof completedAt !== "string") return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 1000 : null;
}

function savedJobTimings(job, payload, observedAt) {
  const reconciliation = job.c1ResultReconciliation;
  const initialCompletedAt = reconciliation?.priorOutcome
    ? reconciliation.priorOutcome.completedAt : job.completedAt;
  const serviceTiming = payload?.receipt ??
    (payload?.serviceTiming?.schemaVersion === "c1-service-timing-v1" ? payload.serviceTiming : null);
  return {
    workbenchWaitSeconds: savedDurationSeconds(job.startedAt, initialCompletedAt),
    serviceGenerationSeconds: savedDurationSeconds(serviceTiming?.startedAt, serviceTiming?.completedAt),
    resultReadSeconds: savedDurationSeconds(reconciliation?.readAttempt?.startedAt, reconciliation?.readAttempt?.completedAt),
    totalElapsedSeconds: ["completed", "failed"].includes(job.status)
      ? savedDurationSeconds(job.startedAt, job.completedAt) : null,
    activeWaitSeconds: ["claimed", "waiting_platform"].includes(job.status) && !job.completedAt
      ? savedDurationSeconds(job.startedAt, observedAt) : null,
    activeReadWaitSeconds: job.status === "unknown_outcome" && reconciliation?.readAttempt?.status === "in_flight" &&
      Date.parse(reconciliation.readAttempt.expiresAt) > Date.parse(observedAt)
      ? savedDurationSeconds(reconciliation.readAttempt.startedAt, observedAt) : null
  };
}

function jobResponsibility(job) {
  if (["claimed", "waiting_platform"].includes(job.status)) return {
    currentOwner: "软件", nextAction: "等待本次执行结束；当前没有完成百分比。"
  };
  if (job.status === "completed") return {
    currentOwner: "主人", nextAction: "查看已保存的文案结果和当前内容确认入口。"
  };
  if (job.status === "queued") return {
    currentOwner: "主人", nextAction: "核对下方可用动作，继续已许可任务。"
  };
  return { currentOwner: "技术维护", nextAction: "检查已保存的失败记录；当前任务已停止，不会自动重试或自动核对。" };
}

/** A read-only projection of the saved request/job. It never grants admission. */
export function buildC1DraftRuntimeView({ candidate, runtime, serviceBindings, observedAt }) {
  const lifecycle = candidate.lifecycleV11;
  const sku = lifecycle?.skuPackage;
  if (!sku || !["C1", "C2"].includes(sku.businessPhase)) return null;
  const request = lifecycle.c1AiDraftRequestV1;
  const ref = lifecycle.c1AiDraftJobRefV1;
  const base = { schemaVersion: "c1-draft-runtime-view-v1", automaticRetryAllowed: false,
    canAuthorize: false, canContinueSaved: false, canReadOriginalResult: false, canRetryKeywordHandoff: false,
    keywordJobId: null, handoffFailureId: null, jobRevision: null, configurationBlockReason: null, sourceBlockReason: null,
    requestRef: request?.requestId ?? null, requestFingerprint: request?.requestFingerprint ?? null,
    provider: request?.provider ?? null, modelVersion: request ? `gpt-5.6-${request.provider}` : null,
    maxCalls: 1, accounting: null, providerOutcome: null };
  if (ref) {
    const job = runtime?.softwareJobs?.find(value => value.jobId === ref.jobId);
    if (!job || job.jobType !== "c1_ai_draft" || job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId ||
        job.revision !== ref.resultRevision || job.scopeBinding.requestFingerprint !== ref.inputFingerprint) {
      return { ...base, status: "source_conflict", message: "已保存作业与当前商品引用不一致，请核对记录。" };
    }
    const payload = job.resultEnvelope?.payload;
    const view = { ...base, status: job.status, jobId: job.jobId, jobRevision: job.revision, externalRequestState: job.externalRequestState,
      applicationDisposition: job.resultEnvelope?.applicationDisposition ?? null,
      accounting: structuredClone(payload?.receipt?.accounting ?? payload?.accounting ?? null),
      providerOutcome: structuredClone(payload?.providerOutcome ?? null),
      timings: savedJobTimings(job, payload, observedAt), ...jobResponsibility(job) };
    if (job.status === "failed" && job.externalRequestState === "succeeded" && job.failureClass === "C1_AI_GATEWAY_RECEIPT_REJECTED") {
      return { ...view, nextAction: "请技术维护检查文案中的事实引用与保存请求；本次结果未采用，不会自动修正文案或重新生成。",
        message: "文案服务已返回结果，但内容引用未通过商品事实与请求核验，尚未采用。本次处理已结束，已保留本次用量，没有再次生成。" };
    }
    if (isC1AiDraftReconciliationPending(job)) {
      const blocked = configurationBlock(serviceBindings, job.scopeBinding.provider);
      if (blocked) return { ...view, ...blocked };
      if (candidate.dataRevision !== job.revision || !request || request.requestFingerprint !== job.scopeBinding.requestFingerprint) {
        return { ...view, sourceBlockReason: "C1_DRAFT_CANDIDATE_REVISION_CONFLICT",
          message: "商品资料与原文案任务已不一致，不能读取并应用旧版本结果。" };
      }
      const readAttempt = job.c1ResultReconciliation?.readAttempt;
      const reading = readAttempt?.status === "in_flight" && Date.parse(readAttempt.expiresAt) > Date.parse(observedAt);
      return { ...view, canReadOriginalResult: !reading,
        currentOwner: reading ? "软件" : "主人",
        nextAction: reading ? "等待这一次原结果读取结束。" : "点击“读取本次文案结果”核对原任务；软件不会在后台自动核对。",
        message: reading ? "软件正在读取原任务结果，请等待本次核对完成。"
          : readAttempt?.status === "pending" ? "上次核对时文案服务仍在处理。稍后可再次读取原结果；不会重新生成或再次发起付费调用。"
            : readAttempt?.status === "read_failed" ? "上次读取没有取得确定结果，原任务已保留。可以再次读取；不会重新生成或再次发起付费调用。"
              : "本轮等待已结束，文案服务可能已经完成。请读取本次结果；不会重新生成，也不会再次发起付费调用。" };
    }
    const queued = job.status === "queued" && job.attempt === 0 && job.externalRequestState === "not_sent";
    const receiptOnly = job.status === "completed" && job.externalRequestState === "succeeded" &&
      job.resultEnvelope?.applicationDisposition === "result_recorded_no_candidate_mutation";
    if (!queued && !receiptOnly) return view;
    const blocked = configurationBlock(serviceBindings, job.scopeBinding.provider, queued ? job.scopeBinding.credentialAlias : null);
    if (blocked) return { ...view, ...blocked };
    if (candidate.dataRevision !== job.revision) return { ...view, sourceBlockReason: "C1_DRAFT_CANDIDATE_REVISION_CONFLICT",
      message: "商品资料已变更，原任务不能按旧修订继续，请核对保存记录。" };
    // Applying an already saved receipt is not a new external action. Its own
    // transaction checks the frozen source without requiring current evidence.
    if (receiptOnly) return { ...view, canContinueSaved: true };
    const sourceBlockReason = currentSourceBlock(candidate, request, observedAt);
    if (sourceBlockReason) return { ...view, sourceBlockReason, message: "当前商品事实或关键词、权益证据尚未通过核验，原任务暂不能执行。" };
    if (request.requestFingerprint !== job.scopeBinding.requestFingerprint || request.provider !== job.scopeBinding.provider) {
      return { ...view, sourceBlockReason: "C1_DRAFT_REQUEST_SOURCE_CONFLICT", message: "已保存请求与原任务不一致，请核对记录。" };
    }
    return { ...view, canContinueSaved: true };
  }
  const failure = candidate.executionRuntime?.technicalFailure;
  if (!request && failure?.failureLayer === "c1_keyword_handoff" && failure.errorCode === "C1_DRAFT_RUNTIME_UNAVAILABLE") {
    const stopped = { ...base, status: "keyword_handoff_blocked", keywordJobId: failure.softwareJobId,
      handoffFailureId: failure.failureId };
    let prepared;
    try {
      const job = runtime?.softwareJobs?.find(value => value.jobId === failure.softwareJobId);
      assertC1PaidKeywordContinuationResult({ candidate, job });
      if (failure.sourceRevision !== job.revision || !failure.evidenceRefs.includes(job.resultRef)) {
        throw new Error("C1_KEYWORD_HANDOFF_RECOVERY_REJECTED");
      }
      recoverC1KeywordHandoffTechnicalFailure(candidate.executionRuntime, {
        failureId: failure.failureId, softwareJobId: job.jobId, errorCode: failure.errorCode, at: observedAt
      });
      prepared = prepareCurrentC1AiDraftRequest(candidate, observedAt);
    } catch (error) {
      return { ...stopped, sourceBlockReason: sourceBlockReasonFromError(error),
        message: "已保存的关键词证据或交接记录未通过核对，当前不能继续准备文案。" };
    }
    const blocked = configurationBlock(serviceBindings, prepared.provider);
    if (blocked) return { ...stopped, ...blocked };
    return { ...stopped, canRetryKeywordHandoff: true,
      message: "文案配置已就绪，可以继续准备请求。此动作只使用已保存证据，不会查询关键词或产生付费调用。" };
  }
  if (!request) return { ...base, status: serviceBindings.length ? "evidence_required" : "configuration_required",
    message: serviceBindings.length ? "正在等待当前商品的完整事实和关键词证据。" : "尚未配置文案服务，当前没有发起付费调用。" };
  const sourceBlockReason = currentSourceBlock(candidate, request, observedAt);
  if (sourceBlockReason) return { ...base, status: "source_conflict", sourceBlockReason,
    message: sourceBlockReason === "C1_AI_GATEWAY_INPUT_TOO_LARGE" ? "文案输入超过服务容量，尚未创建付费任务；需要调整资料传输后继续。" :
      "保存请求的商品事实或关键词、权益证据已失效或不一致，请先核对当前证据。" };
  const blocked = configurationBlock(serviceBindings, request.provider);
  if (blocked) return { ...base, status: "configuration_required", ...blocked };
  return { ...base, status: "awaiting_paid_confirmation", canAuthorize: true,
    message: "文案请求已保存，等待本件商品的一次付费许可。" };
}
