import { readDProductionJobWaiting, readDPlatformStoppedJobTerminal, readDInitialImportStoppedJobTerminal,
  readDOwnerStockRegisteredJobTerminal, D_OWNER_STOCK_REGISTRATION_FIELD,
  D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD, dPlatformStateReconciliationsFor, importedProductObservation,
  D_PLATFORM_STATE_RECONCILIATION_LIMIT } from './d-platform-observation-contract.mjs';
import { isDeepStrictEqual } from "node:util";
import { assertDProductionJobReference, assertEReadbackJobReference, currentDProductionRound,
  dProductionRoundDispatchable } from "./d-e-software-job-handoff.mjs";
import { assertDEJobAdmissionDecision, createDEJobAdmissionDecision, DESoftwareJobAdmissionError } from "./d-e-software-job-admission.mjs";
import { assertDProductionRecordSource, assertDProductionReceiptChain, DEJobScopeError } from "./d-e-software-job-scope.mjs";
import { DProductionJobCursorError } from "./d-production-job-cursor.mjs";
import { productionAuthorizationRollbackEligible, PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD } from "./production-authorization-rollback.mjs";
import { assertEReadbackAttempt } from "./e-readback-attempt.mjs";
import { validateSystemCreatedVerificationRecord } from "./e-stage-readback.mjs";
import { normalizeDEServiceBindings, isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";
import { isCanonicalFrozenRef, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { assertDProductionPreparation, DProductionPreparationError } from "./d-production-preparation-contract.mjs";

const TYPES = { D: "d_production_execution", E: "e_independent_readback" };
const knownCode = error => {
  if (error instanceof DESoftwareJobAdmissionError || error instanceof DEJobScopeError || error instanceof DProductionJobCursorError || error instanceof DProductionPreparationError) return error.code;
  if (error?.constructor === Error) {
    const code = error.message.split(":", 1)[0];
    if (/^(?:[DE]_JOB_HANDOFF_[A-Z_]+|E_READBACK_[A-Z_]+|DE_SERVICE_CONFIGURATION_INVALID|SOFTWARE_JOB_PREPARATION_SOURCE_CONFLICT|D_PLATFORM_OBSERVATION_[A-Z_]+)$/.test(code)) return code;
  }
  throw error;
};
const blocker = (code, message) => ({ code, message });
const conflict = (view, code) => ({ ...view, sourceBlockReason: code, canContinueSaved: false, currentVerified: false,
  blockers: [...view.blockers, blocker(code, "保存的任务与当前商品来源不一致，请核对原记录。") ] });

function stageBase(stage, job) {
  return { stage, jobId: isCanonicalFrozenRef(job?.jobId) ? job.jobId : null, jobRevision: job?.revision ?? null,
    status: job?.status ?? "source_conflict", externalRequestState: job?.externalRequestState ?? null,
    receiptStatus: "none", businessStatus: null, currentVerified: false, lateMaterial: false,
    canContinueSaved: false, sourceBlockReason: null, configurationBlockReason: null, blockers: [] };
}

function savedMaterial(stage, job, candidate, view, observedAt) {
  const sku = candidate.lifecycleV11.skuPackage;
  if (stage === "D") {
    const state = sku.dSoftwareExecution;
    // 登记档：商品由软件建、库存由主人手工写。没有生产记录是**正确**的，
    // 所以不能走下面那条「succeeded 必须有生产记录」的路。
    if (state?.status === "succeeded" && state.platformContinuation?.status === "owner_stock_registered") {
      readDOwnerStockRegisteredJobTerminal({ candidate, job, observedAt });
      view.receiptStatus = "owner_stock_registered";
    } else if (state?.status === "succeeded") {
      const authorization = state.productionPlan?.sourceAuthorization;
      if (!authorization || fingerprintCanonicalRecord(authorization) !== job.scopeBinding.authorizationFingerprint ||
          !isDeepStrictEqual(state.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId })) {
        throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
      }
      const record = assertDProductionRecordSource({ record: state.attempt?.productionRecord, authorization, observedAt });
      assertDProductionReceiptChain({ state, authorization, record, candidateId: candidate.id });
      view.receiptStatus = "production_record_saved";
      view.businessStatus = "production_recorded";
    } else if (state?.checkpoints?.length || job.preparationEvidence || sku.dAssetTransport) {
      view.receiptStatus = "progress_saved";
    }
    if (state?.schemaVersion === 'd-software-execution-state-v2' && state.platformContinuation) {
      const continuation=state.platformContinuation;
      if(state.status === 'waiting_platform') readDProductionJobWaiting({candidate,job,observedAt});
      else if(continuation.inventoryWriteState === 'not_sent' && ['failed','unknown_outcome'].includes(state.status)) {
        if (job.resultEnvelope?.payload?.schemaVersion === 'd-initial-import-stop-job-result-v1') {
          readDInitialImportStoppedJobTerminal({candidate,job,observedAt});
          // 导入已被平台接受、却因上下文变化停下——这一档主人可以「对账并登记」。
          // 按钮要点的东西都从这里给出去，界面不自己拼。
          const stopped=job.resultEnvelope.payload;
          const recovered=(candidate.lifecycleV11.dInitialImportRecoveryV1 ?? [])
            .some(entry=>entry.taskId === stopped.taskId);
          view.initialImportRecovery={
            canRecover: !recovered && job.failureClass === 'd-initial-import-context-changed',
            blocker: recovered ? {code:'ALREADY_RECOVERED',message:'这个导入任务已经对账恢复过一次了，不会重复恢复。'}
              : job.failureClass === 'd-initial-import-context-changed' ? null
              : {code:'NOT_CONTEXT_CHANGED',message:'本轮停止原因不是上下文变化，不能用对账恢复。'},
            sourceDJobId: job.jobId, taskId: stopped.taskId,
            requestReceiptRef: stopped.requestReceiptRef, expectedRevision: candidate.dataRevision };
        }
        else readDPlatformStoppedJobTerminal({candidate,job,observedAt});
      }
      view.businessStatus=continuation.status;
      view.platformObservation={status:continuation.status,queriesUsed:continuation.queryCount,
        queryLimit:continuation.policy?.maxQueries ?? null,inventoryWriteState:continuation.inventoryWriteState,
        nextJobId:continuation.activeObservationJobId};
      const messages={waiting_import:'平台已接收导入，等待有限只读查询确认。',waiting_price:'导入已确认，尚需核验库存写入前提。',
        waiting_inventory:'价格发送状态已核验，尚需核验准确仓库的预留库存。',prerequisites_observed:'只读前提已取得，等待原生产任务核验后续执行。',
        platform_failed:'平台明确报告导入失败；不会重新导入。',platform_skipped:'平台明确报告导入被跳过；不会自动写库存。',
        query_budget_exhausted:'本轮查询次数或期限已用尽，已停止。',unknown_outcome:'本轮观察结果无法确认，已停止且不会重放导入。',
        blocked:'缺少已核实的后续执行前提，库存尚未发送。',inventory_not_sent_interrupted:'库存发送前服务中断，原导入回执已保留。'};
      if (continuation.status === 'waiting_import' && continuation.policy === null) messages.waiting_import='平台已接收导入；查询策略未配置，尚未安排查询。';
      // 这两档原先都落进笼统的 blocked 文案（「缺少已核实的后续执行前提」），
      // 主人看不出该做什么，甚至可能去重签授权——**重签等于第二次导入、会在平台上建出重复商品**。
      // 所以逐档说清楚，并明确写「不要重签、不要重发」。
      if (state.attempt?.failure?.code === 'inventory_request_superseded') messages.blocked=
        '商品已经在平台上建好了（本轮导入已被接受）。但本轮冻结的导入内容与当前软件生成的已不一致，'
        + '为避免发出一份对不上的请求，库存没有发送，软件已安全停下。'
        + '**请不要重签授权、也不要重新导入**——重签会在平台上再建一个重复商品。请把这条告诉施工方处理。';
      if (state.attempt?.failure?.code === 'inventory_stock_mismatch') messages.blocked=
        '平台仓库里读到的库存，既不是 0 也不等于本轮授权锁定的数量，软件不会覆盖它，已安全停下。'
        + '**请不要重签授权、也不要重新导入。**请先在卖家后台确认该仓库实际应有多少件，再把结论告诉施工方。';
      if (job.resultEnvelope?.payload?.schemaVersion === 'd-initial-import-stop-job-result-v1') messages.blocked=
        state.blockReason === 'lease_expired' ? '导入任务已接收，但执行租约已过期；已停止后续查询，库存尚未发送。' :
          '导入任务已接收，但商品、执行配置或查询期限已不满足后续条件；已停止查询，库存尚未发送。';
      // 平台在导入任务上报了错误时，把每一条都摆给主人看——
      // 2026-09-24 背心停在 unknown_outcome，记录里只有「2 条」，主人只能去后台翻。
      const importErrors = continuation.observationHistory?.findLast(entry =>
        entry.queryKind === 'import_task' && Array.isArray(entry.result?.importObservation?.errors)
          && entry.result.importObservation.errors.length > 0)?.result.importObservation.errors;
      // r70 之前落的观察记录只有 errorCount、没有明细。如实说明，别让主人以为「没有错误」。
      const countOnly = continuation.observationHistory?.findLast(entry =>
        entry.queryKind === 'import_task' && (entry.result?.importObservation?.errorCount ?? 0) > 0
          && !Array.isArray(entry.result.importObservation.errors));
      // 已经按平台现状收口登记的这一轮，导入任务上的旧错误不再摆出来：商品现状已经核实过没有错误。
      const settledFromPlatform = continuation.status === 'owner_stock_registered' &&
        dPlatformStateReconciliationsFor(candidate, continuation.taskId).length > 0;
      if (countOnly && !Array.isArray(importErrors) && !settledFromPlatform) {
        view.blockers.push(blocker('D_IMPORT_ERRORS_DETAIL_MISSING',
          `平台在导入任务上报了 ${countOnly.result.importObservation.errorCount} 条错误，`
          + '但这条观察记录是本次改动之前落的，当时只记了条数、没有留下明细。'
          + '重新观察一次就会把每条错误的级别与文案补齐并显示在这里。'));
      }
      if (Array.isArray(importErrors) && !settledFromPlatform) {
        for (const [index, item] of importErrors.entries()) {
          const where = item.attributeName ?? item.field ?? null;
          view.blockers.push(blocker(`D_IMPORT_ERROR_${index + 1}`,
            `平台在导入任务上报的第 ${index + 1} 条${item.level ? `（${item.level}）` : ''}：`
            + `${item.message ?? item.code ?? '未提供文案'}`
            + `${where ? `｜位置：${where}` : ''}${item.code ? `｜代码：${item.code}` : ''}`));
        }
      }
      // 「按新分类重新观察一次」：只在**确实还有得看**时才亮。
      // 停在 unknown_outcome、平台已经把商品建出来（观察记录里有 product_id）、
      // 策略当下有效、且剩余预算还够把这一轮观察跑完——四条缺一不可。
      if (state.status === 'unknown_outcome' && continuation.status === 'unknown_outcome') {
        const withProduct = continuation.observationHistory?.findLast(entry =>
          entry.queryKind === 'import_task' && entry.result?.importObservation?.status === 'imported' &&
          entry.result.importObservation.productId);
        const already = (candidate.lifecycleV11[D_UNKNOWN_OUTCOME_REOBSERVATION_FIELD] ?? [])
          .some(entry => entry.taskId === continuation.taskId);
        const policy = continuation.policy;
        const remainingQueries = policy ? policy.maxQueries - (continuation.queryCount ?? 0) : 0;
        const policyCurrent = Boolean(policy) && Date.parse(policy.expiresAt) - Date.parse(observedAt)
          >= remainingQueries * policy.intervalMs;
        const blocker = already ? { code: 'ALREADY_REOBSERVED', message: '这个导入任务已经按新分类重新观察过一次了。' }
          : !withProduct ? { code: 'NO_PLATFORM_PRODUCT', message: '平台还没有给出商品号，重新观察也拿不到结论。' }
          : remainingQueries <= 0 ? { code: 'QUERY_BUDGET_EXHAUSTED', message: '本轮查询预算已用尽。' }
          : !policyCurrent ? { code: 'OBSERVATION_POLICY_UNAVAILABLE', message: '平台查询策略缺失或剩余寿命盖不住剩余预算。' }
          : null;
        view.unknownOutcomeReobservation = { canReobserve: blocker === null, blocker,
          sourceDJobId: job.jobId, taskId: continuation.taskId,
          productId: withProduct ? String(withProduct.result.importObservation.productId) : null,
          expectedRevision: candidate.dataRevision };
        // 「按平台现状收口」：导入任务过期读不到时，改读平台上这件商品的现状和库存（两次只读）。
        // 条件与合同 reconcileDUnknownOutcomeFromPlatformStateInDocument 同一口径，界面不自己拼。
        const imported = importedProductObservation(continuation);
        const reconciliations = dPlatformStateReconciliationsFor(candidate, continuation.taskId);
        const twoQueriesLeft = Boolean(policy) && policy.maxQueries - (continuation.queryCount ?? 0) >= 2;
        const twoQueriesFit = Boolean(policy) && Date.parse(policy.expiresAt) - Date.parse(observedAt) >= 2 * policy.intervalMs;
        const reconcileBlocker = job.failureClass !== 'd-platform-unknown-outcome' || continuation.inventoryWriteState !== 'not_sent' ||
            state.platformWrites !== 1 || state.checkpoints?.length !== 2
          ? { code: 'NOT_RECONCILABLE', message: '这一轮停下的原因不是导入结果未知，不能按平台现状收口。' }
          : !imported ? { code: 'NO_PLATFORM_PRODUCT', message: '平台还没有给出商品号，无法按平台现状收口。' }
          : reconciliations.length >= D_PLATFORM_STATE_RECONCILIATION_LIMIT
            ? { code: 'RECONCILE_LIMIT_REACHED', message: `已经按平台现状收口过 ${reconciliations.length} 次都没有核实，请把上面停在什么上告诉施工方。` }
          : !twoQueriesLeft ? { code: 'QUERY_BUDGET_EXHAUSTED', message: '本轮查询预算不够再查两次（商品现状和库存）。' }
          : !twoQueriesFit ? { code: 'OBSERVATION_POLICY_UNAVAILABLE', message: '平台查询策略缺失或已经到期。' }
          : null;
        view.platformStateReconciliation = { canReconcile: reconcileBlocker === null, blocker: reconcileBlocker,
          sourceDJobId: job.jobId, taskId: continuation.taskId,
          productId: imported ? String(imported.result.importObservation.productId) : null,
          expectedRevision: candidate.dataRevision, attempts: reconciliations.length,
          attemptsLeft: Math.max(D_PLATFORM_STATE_RECONCILIATION_LIMIT - reconciliations.length, 0) };
      }
      if (continuation.status === 'owner_stock_registered') {
        // 主人要求三句分开显示，不许合并成「已上架」：谁建的、库存谁写的、E 谁核的，是三件事。
        const registration = (candidate.lifecycleV11[D_OWNER_STOCK_REGISTRATION_FIELD] ?? []).at(-1);
        view.blockers.push(blocker('D_OWNER_STOCK_PRODUCT_CREATED',
          `商品由软件创建（导入任务 ${registration?.taskId ?? continuation.taskId}、商品号 ${registration?.productId ?? continuation.productId}）。`));
        view.blockers.push(blocker('D_OWNER_STOCK_WRITTEN_BY_OWNER',
          `库存由主人手工写入（登记时回读到 ${registration?.observedStock ?? '未知'} 件，授权锁定 ${registration?.authorizedStock ?? '未知'} 件）；软件未发送任何库存请求。`));
        view.blockers.push(blocker('D_OWNER_STOCK_E_MANUAL',
          'E 阶段由主人人工核对：本轮没有生产记录，软件不会自动回读。'));
      }
      else if(Object.hasOwn(messages,continuation.status)) view.blockers.push(blocker(`D_PLATFORM_${continuation.status.toUpperCase()}`,messages[continuation.status]));
    }
    if (job.preparationEvidence) {
      const preparation = assertDProductionPreparation(job.preparationEvidence, { job });
      if (preparation.status === "not_ready") {
        const messages = {
          account_evidence_missing: "尚未保存这家店铺的账户核验证据。",
          evidence_source_unverified: "账户资料的官方来源尚未核验。",
          account_evidence_not_current: "账户核验证据尚未生效或已过期。"
        };
        const fields = { permission: "账号权限", imagePermission: "图片权限", priceCurrency: "后台价格币种",
          apiConnection: "API连接", sellerBackendConnection: "卖家后台连接", writeScope: "授权字段的可写范围" };
        for (const gap of preparation.result.capabilities.gaps) {
          if (gap.code === "account_inspection_not_ready" && !Object.hasOwn(fields, gap.field)) throw new Error("D_JOB_HANDOFF_PREFLIGHT_FIELD_INVALID");
          const message = Object.hasOwn(messages, gap.code) ? messages[gap.code] : (gap.code === "account_inspection_not_ready"
            ? `${fields[gap.field]}尚未核验通过。`
            : gap.code.startsWith("OZON_DE_PREFLIGHT_EVIDENCE_") ? "保存的账户证据校验失败，需要修复。" : gap.message);
          if (!view.blockers.some(item => item.message === message)) view.blockers.push(blocker(gap.code, message));
        }
      } else if (preparation.status === "unknown_outcome" && preparation.requestMode === "persisted_evidence_only") {
        view.blockers.push(blocker("local_preflight_unavailable", "本地证据检查未完成，商品尚未写入店铺。"));
      }
    }
  } else {
    const attempts = sku.readbackHistory.filter(attempt => attempt?.softwareJobRef?.jobId === job.jobId);
    if (attempts.length > 1) throw new Error("E_READBACK_ATTEMPT_DUPLICATE");
    if (attempts.length === 0 && (job.status === "completed" || ["in_flight", "succeeded", "unknown_outcome"].includes(job.externalRequestState))) {
      throw new Error("E_READBACK_ATTEMPT_SCOPE_CONFLICT");
    }
    if (attempts.length === 1) {
      const attempt = assertEReadbackAttempt(attempts[0]);
      if (attempt.result) {
        view.receiptStatus = "readback_saved";
        view.businessStatus = attempt.result.status;
        if (attempt.candidateId !== job.candidateId || attempt.skuPackageId !== job.skuPackageId ||
            attempt.requestedByUserId !== job.workerId || attempt.sourceProductionRecordId !== job.scopeBinding.sourceProductionRecordId ||
            !isDeepStrictEqual(attempt.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId }) ||
            attempt.sourceFingerprint !== fingerprintCanonicalRecord({ productionRecord: sku.dSoftwareExecution?.attempt?.productionRecord,
              identity: job.scopeBinding.identity, variantKey: job.scopeBinding.variantKey })) throw new Error("E_READBACK_SOURCE_SCOPE_CONFLICT");
        view.currentVerified = job.status === "completed" && job.externalRequestState === "succeeded" &&
          attempt.status === "verified" && attempt.applicationDisposition === "applied" &&
          isDeepStrictEqual(sku.eVerificationRecord, attempt.result.eVerificationRecord) &&
          validateSystemCreatedVerificationRecord(attempt.result.eVerificationRecord, sku.productionRecord).valid;
      }
    }
  }
  view.lateMaterial = job.status === "unknown_outcome" && view.receiptStatus !== "none";
  return view;
}

function currentSource(stage, job, candidate, document) {
  if (stage === "D") assertDProductionJobReference({ document, candidate, job });
  else assertEReadbackJobReference({ document, candidate, job });
  assertDEJobAdmissionDecision(job, job.admissionDecision);
  const sku = candidate.lifecycleV11.skuPackage, scope = job.scopeBinding;
  if (!isDeepStrictEqual(scope.identity, sku.g1Identity) || scope.variantKey !== sku.variantKey ||
      candidate.targetStore !== scope.identity.storeRef.stableStoreId || !isDeepStrictEqual(candidate.storeRef, scope.identity.storeRef) ||
      sku.supplierSkuId !== scope.identity.supplierSkuId || sku.targetPlatform !== scope.identity.platform ||
      sku.targetStore !== scope.identity.storeRef.stableStoreId) throw new Error("E_READBACK_SOURCE_SCOPE_CONFLICT");
}

function continuationConfiguration({ stage, job, candidate, runtime, serviceBindings, productionBindings, dependencyView, observedAt }) {
  const blockers = [];
  const services = serviceBindings.filter(binding => binding.productionBindingId === job.scopeBinding.productionBinding.bindingId);
  const productions = productionBindings.filter(binding => binding.bindingId === job.scopeBinding.productionBinding.bindingId);
  if (services.length !== 1) blockers.push(blocker("DE_SERVICE_REQUIRED", "尚未配置本店的生产与回读服务。"));
  if (productions.length !== 1) blockers.push(blocker("DE_PRODUCTION_BINDING_REQUIRED", "尚未配置本店对应的仓库与连接。"));
  for (const [key, message] of [["transport", "尚未接入平台连接。"], ["capabilities", "尚未接入平台能力检查。"],
    ...(stage === "D" ? [["preflight", "尚未接入生产前检查。"]] : [])]) {
    if (dependencyView[key] !== true) blockers.push(blocker(`DE_${key.toUpperCase()}_REQUIRED`, message));
  }
  const sku = candidate.lifecycleV11.skuPackage;
  if (stage === "D" && sku.productionAuthorization.lockedScope.finalUploads.some(asset => asset.assetRef.startsWith("local-asset:")) &&
      dependencyView.assetTransport !== true) blockers.push(blocker("DE_ASSET_TRANSPORT_REQUIRED", "尚未接入最终素材传输。"));
  if (services.length !== 1 || productions.length !== 1) return blockers;
  try { normalizeDEServiceBindings(services, productions); }
  catch (error) { blockers.push(blocker(knownCode(error), "保存任务所需的服务配置不完整或版本不一致。")); return blockers; }
  const service = services[0], production = productions[0];
  const workers = (runtime.workers ?? []).filter(worker => worker.workerId === service.workerId);
  const worker = workers[0];
  if (workers.length !== 1 || worker.status !== "online" || worker.version !== service.workerVersion ||
      !workerSatisfiesCapabilities(worker, job.requiredCapabilities)) {
    blockers.push(blocker("DE_WORKER_REQUIRED", "当前没有符合本任务要求的执行端，请检查服务接线。"));
    return blockers;
  }
  const executionBinding = { schemaVersion: "d-e-execution-binding-v1", serviceId: service.serviceId,
    serviceConfigurationVersion: service.configurationVersion,
    productionBinding: { bindingId: production.bindingId, configurationVersion: production.configurationVersion, warehouseId: production.warehouseId },
    platform: production.platform, storeRef: production.storeRef, warehouseRef: production.warehouseRef, credentialAlias: production.credentialAlias,
    workerId: service.workerId, workerVersion: service.workerVersion, configurationEvidence: production.verification };
  try { createDEJobAdmissionDecision({ candidate, job, observedAt, phase: "claim", executionBinding, worker }); }
  catch (error) {
    const code = knownCode(error);
    blockers.push(blocker(code, code.includes("EVIDENCE_EXPIRED") ? "本店连接与仓库的核验记录已过期，请先更新配置。"
      : "当前商品、执行端或店铺连接与原任务不一致，暂不能继续。"));
  }
  return blockers;
}

/** Read-only display projection. Presence of configured providers is not a platform health check or permission to send. */
/**
 * 作废一轮授权之后，被归档那几轮仍然留在作业表里（按规矩一条不删），它们带的是旧授权号。
 * 因此"本商品的全部D作业必须同属一个授权"这条断言会把正常状态误判成来源错乱，
 * 2026-09-23 背心就是这样把三个按钮全关掉的。
 *
 * 换成两条，合起来比原来严：
 *   一、当前授权下的各轮次仍然必须同源（原语义一字不减）；
 *   二、不属于当前授权的作业，必须逐个能在本候选的作废归档里找到出处，
 *       并且都停在「失败、且证明一个请求都没发出去」。
 * 来路不明的外来作业照旧判冲突。
 */
function dJobsHaveSingleTraceableSource(candidate, relevant, job) {
  const currentRef = job?.scopeBinding?.authorizationRef;
  if (!job || !currentRef) return false;
  const archivedRefs = new Set((candidate.lifecycleV11?.[PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD] ?? [])
    .map(entry => entry.productionAuthorizationRef?.authorizationId)
    .filter(value => typeof value === "string" && value.length > 0));
  return relevant.every(entry => {
    const entryRef = entry.scopeBinding?.authorizationRef;
    if (entryRef === currentRef) return true;
    return archivedRefs.has(entryRef) && entry.status === "failed" &&
      entry.externalRequestState === "not_sent" && entry.externalRequestRef === null &&
      entry.resultEnvelope === null;
  });
}

export function buildDESavedJobRuntimeView({ candidate, runtime, serviceBindings = [], productionBindings = [], dependencyView = {}, observedAt }) {
  if (!isRuntimeConfigurationTimestamp(observedAt)) throw new TypeError("DE_RUNTIME_VIEW_TIME_INVALID");
  if (!runtime || (runtime.softwareJobs !== undefined && !Array.isArray(runtime.softwareJobs)) || !Array.isArray(serviceBindings) || !Array.isArray(productionBindings) ||
      (runtime.workers !== undefined && !Array.isArray(runtime.workers)) || !dependencyView || typeof dependencyView !== "object" ||
      ["transport", "preflight", "capabilities", "assetTransport"].some(key => Object.hasOwn(dependencyView, key) && typeof dependencyView[key] !== "boolean")) {
    throw new TypeError("DE_RUNTIME_VIEW_INPUT_INVALID");
  }
  const lifecycle = candidate.lifecycleV11, sku = lifecycle?.skuPackage;
  if (!sku) return null;
  const refs = { D: sku.dHandoff?.softwareJobRef, E: lifecycle.eIndependentReadbackJobRefV1 };
  const jobs = (runtime.softwareJobs ?? []).filter(job => job.candidateId === candidate.id || job.jobId === refs.D?.jobId || job.jobId === refs.E?.jobId);
  if (sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2" && !refs.D && !refs.E &&
      !jobs.some(job => Object.values(TYPES).includes(job.jobType))) return null;
  const document = { candidates: [candidate], runtime: { softwareJobs: jobs } };
  const stages = {};
  for (const stage of ["D", "E"]) {
    const relevant = jobs.filter(job => job.jobType === TYPES[stage] && job.candidateId === candidate.id);
    const expectsE = sku.dSoftwareExecution?.status === "succeeded" && sku.dSoftwareExecution.continuationBlocked === false &&
      stages.d?.status === "completed";
    if (stage === "E" && !refs.E && relevant.length === 0 && !expectsE) { stages.e = null; continue; }
    // D 可能有不止一轮受控执行；当前轮由轮次链决定，被取代的轮次必须都已证明一个请求都没发出去。
    const job = stage === "D"
      ? currentDProductionRound(document, { authorizationRef: sku.productionAuthorization?.authorizationId,
        authorizationFingerprint: sku.productionAuthorization ? fingerprintCanonicalRecord(sku.productionAuthorization) : null })
      : relevant.find(entry => entry.jobId === refs[stage]?.jobId) ?? relevant[0];
    let view = stageBase(stage, job);
    const sameSource = stage === "D" ? dJobsHaveSingleTraceableSource(candidate, relevant, job) : relevant.length === 1;
    if (!job || !sameSource || !refs[stage]) { stages[stage.toLowerCase()] = conflict(view, "DE_SAVED_JOB_REFERENCE_CONFLICT"); continue; }
    try {
      view = savedMaterial(stage, job, candidate, view, observedAt);
      currentSource(stage, job, candidate, document);
    } catch (error) { stages[stage.toLowerCase()] = conflict(view, knownCode(error)); continue; }
    const queued = job.status === "queued" && job.attempt === 0 && job.externalRequestState === "not_sent" &&
      job.workerId === null && job.leaseId === null && job.externalRequestRef === null;
    if (job.status === "queued" && !queued) view = conflict(view, "DE_SAVED_JOB_NOT_PRISTINE");
    if (queued) {
      const existingWork = stage === "D" ? sku.dSoftwareExecution || sku.dAssetTransport || Object.hasOwn(job, "preparationEvidence") :
        sku.readbackHistory.some(attempt => attempt?.sourceProductionRecordId === job.scopeBinding.sourceProductionRecordId);
      if (existingWork || candidate.dataRevision !== job.revision) view = conflict(view, existingWork ? "DE_SAVED_INTENT_EXISTS" : "DE_CANDIDATE_REVISION_CONFLICT");
      else {
        try { createDEJobAdmissionDecision({ candidate, job, observedAt, phase: "enqueue_current" }); }
        catch (error) { stages[stage.toLowerCase()] = conflict(view, knownCode(error)); continue; }
        view.blockers = continuationConfiguration({ stage, job, candidate, runtime, serviceBindings, productionBindings, dependencyView, observedAt });
        view.configurationBlockReason = view.blockers[0]?.code ?? null;
        view.canContinueSaved = view.blockers.length === 0;
      }
    }
    stages[stage.toLowerCase()] = view;
  }
  // 上一轮已经停下且证明什么都没发出去时，主人可以在同一份授权下再派一轮；这不是重试，要他自己点。
  const round = stages.d && !stages.d.sourceBlockReason && !stages.e ? dProductionRoundDispatchable(document, candidate)
    : { dispatchable: false, blocker: null, supersededJobId: null };
  if (stages.d) stages.d.newRound = { canDispatch: round.dispatchable, blocker: round.dispatchable ? null : round.blocker,
    supersededJobId: round.supersededJobId ?? null, supersededFailureClass: round.supersededFailureClass ?? null,
    nextRound: round.dispatchable ? round.round : null };
  // 再派一轮和作废授权互斥：还能直接再派时 eligible 必为 false（ROUND_STILL_DISPATCHABLE），
  // 只有被 DOWNSTREAM_EXISTS / REVISION_MOVED 挡住且六项证据齐全，才轮到作废这条路。
  const rollback = stages.d && !stages.d.sourceBlockReason && !stages.e
    ? productionAuthorizationRollbackEligible(document, candidate)
    : { eligible: false, blocker: null, authorizationId: null };
  const sourceConflict = [stages.d, stages.e].some(stage => stage?.sourceBlockReason);
  if (sourceConflict && stages.e) stages.e.currentVerified = false;
  const active = stages.e ?? stages.d;
  const currentVerified = !sourceConflict && stages.e?.currentVerified === true;
  const canContinueSaved = !sourceConflict && active.canContinueSaved;
  return { schemaVersion: "d-e-saved-job-runtime-view-v1", ...stages,
    status: sourceConflict ? "source_conflict" : currentVerified ? "verified" : active.status,
    currentVerified, canContinueSaved, continueJobId: canContinueSaved ? active.jobId : null,
    canDispatchNewRound: !sourceConflict && stages.d?.newRound.canDispatch === true,
    newRoundSupersededJobId: !sourceConflict && stages.d?.newRound.canDispatch === true ? stages.d.newRound.supersededJobId : null,
    canRollbackAuthorization: !sourceConflict && rollback.eligible === true,
    rollbackAuthorizationId: !sourceConflict && rollback.eligible === true ? rollback.authorizationId : null,
    rollbackBlocker: !sourceConflict && rollback.eligible === true ? null : (rollback.blocker ?? null),
    // 导入已被平台接受、却因上下文变化停下：主人可以「对账并登记」。
    // 按钮要用的几项从这里一并给出去，界面不自己拼。
    canReobserveUnknownOutcome: !sourceConflict && stages.d?.unknownOutcomeReobservation?.canReobserve === true,
    unknownOutcomeReobservation: !sourceConflict && stages.d?.unknownOutcomeReobservation?.canReobserve === true
      ? { sourceDJobId: stages.d.unknownOutcomeReobservation.sourceDJobId,
          taskId: stages.d.unknownOutcomeReobservation.taskId,
          productId: stages.d.unknownOutcomeReobservation.productId,
          expectedRevision: stages.d.unknownOutcomeReobservation.expectedRevision }
      : null,
    reobservationBlocker: !sourceConflict && stages.d?.unknownOutcomeReobservation
      && stages.d.unknownOutcomeReobservation.canReobserve !== true
      ? stages.d.unknownOutcomeReobservation.blocker ?? null : null,
    canReconcileFromPlatformState: !sourceConflict && stages.d?.platformStateReconciliation?.canReconcile === true,
    platformStateReconciliation: !sourceConflict && stages.d?.platformStateReconciliation?.canReconcile === true
      ? { sourceDJobId: stages.d.platformStateReconciliation.sourceDJobId,
          taskId: stages.d.platformStateReconciliation.taskId,
          productId: stages.d.platformStateReconciliation.productId,
          expectedRevision: stages.d.platformStateReconciliation.expectedRevision }
      : null,
    platformStateReconciliationAttemptsLeft: !sourceConflict && stages.d?.platformStateReconciliation
      ? stages.d.platformStateReconciliation.attemptsLeft : null,
    platformStateReconciliationBlocker: !sourceConflict && stages.d?.platformStateReconciliation
      && stages.d.platformStateReconciliation.canReconcile !== true
      ? stages.d.platformStateReconciliation.blocker ?? null : null,
    canRecoverInitialImport: !sourceConflict && stages.d?.initialImportRecovery?.canRecover === true,
    initialImportRecovery: !sourceConflict && stages.d?.initialImportRecovery?.canRecover === true
      ? { sourceDJobId: stages.d.initialImportRecovery.sourceDJobId, taskId: stages.d.initialImportRecovery.taskId,
          requestReceiptRef: stages.d.initialImportRecovery.requestReceiptRef,
          expectedRevision: stages.d.initialImportRecovery.expectedRevision }
      : null,
    recoveryBlocker: !sourceConflict && stages.d?.initialImportRecovery && stages.d.initialImportRecovery.canRecover !== true
      ? stages.d.initialImportRecovery.blocker ?? null : null,
    expectedRevision: candidate.dataRevision, automaticRetryAllowed: false, platformHealth: "not_checked" };
}
