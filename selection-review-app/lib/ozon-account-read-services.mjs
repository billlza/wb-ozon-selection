import { createOzonAccountReadRuntime } from './ozon-account-read-runtime.mjs';
import { assertOzonAccountReadReceipt, OzonAccountReadError } from './ozon-account-read-contract.mjs';
import { createOzonAccountReadBindingResolver, buildOzonAccountReadPreparation, currentOzonAccountReadJobs,
  accountReadBindingForProduction } from './ozon-account-read-preparation.mjs';
import { assertOzonDEPreflightEvidenceScope, inspectOzonDEPreflightCapabilities, OzonDEPreflightEvidenceError } from './ozon-de-preflight-provider.mjs';
import { buildDESavedJobRuntimeView } from './d-e-runtime-view.mjs';
import { createDPlatformObservationPolicyResolver } from './runtime-configuration.mjs';
import { validateSoftwareJobAdmission } from './software-job-admission.mjs';
import { softwareJobsInDocument } from './software-job-contract.mjs';
import { currentDProductionRound } from './d-e-software-job-handoff.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';

function scopeFor(candidate, binding) {
  const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization, locked = authorization.lockedScope;
  return assertOzonDEPreflightEvidenceScope({ candidateId: candidate.id, skuPackageId: locked.skuPackageId,
    supplierSkuId: locked.supplierSkuId, authorizationId: authorization.authorizationId, sourceCandidateRevision: authorization.sourceCandidateRevision,
    storeRef: structuredClone(locked.storeRef), warehouseRef: locked.warehouseRef, warehouseId: binding.warehouseId,
    credentialAlias: locked.credentialAlias, bindingId: binding.bindingId, configurationVersion: binding.configurationVersion });
}

const preflightGapLabels = Object.freeze({
  productImport: '商品导入与任务查询规则', inventoryWrite: '库存写入规则与写前条件',
  independentReadback: '独立回读规则', imagePermission: '图片提交规则与权限',
  storeIdentity: '目标店铺身份证据', permission: '当前接口方法权限',
  priceCurrency: '后台价格币种与授权币种一致性', writeScope: '授权写入字段对应的方法权限',
  apiConnection: 'Seller API 连接证据'
});

function currentEvidenceGapMessage(gaps) {
  const labels = [...new Set(gaps.map(gap => Object.hasOwn(preflightGapLabels, gap.field)
    ? preflightGapLabels[gap.field] : gap.message))];
  return `账户核验回执仍有效，可继续复用；当前缺项：${labels.join('、')}。原生产任务保持等待，无需重复账户核验。`;
}

/** Existing job queue composition. No background scan, automatic authorization, retry, or extra production decision. */
export function createOzonAccountReadServices({ configuration, repository, workerRegistry, serverClock, requestJson,
  loadDPlatformObservationPolicy = null,
  evidenceSource, preflightProvider, deRuntimeServices }) {
  const loadCurrentReadBinding = createOzonAccountReadBindingResolver(configuration), services = new Map();
  for (const binding of configuration.ozonAccountReadServiceBindings) {
    services.set(binding.productionBindingId, createOzonAccountReadRuntime({ repository, workerRegistry, serverClock,
      worker: { workerId: binding.workerId, version: binding.workerVersion, leaseDurationMs: binding.leaseDurationMs },
      loadCurrentReadBinding, requestJson }));
  }
  function savedReads(document, candidateId) {
    const hasRuntime = Object.hasOwn(document, 'runtime');
    const runtime = hasRuntime ? document.runtime : {};
    if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime) ||
        (Object.hasOwn(runtime, 'softwareJobs') && !Array.isArray(runtime.softwareJobs)) ||
        (Object.hasOwn(runtime, 'ozonAccountReadReceipts') && (runtime.ozonAccountReadReceipts === null ||
          typeof runtime.ozonAccountReadReceipts !== 'object' || Array.isArray(runtime.ozonAccountReadReceipts)))) {
      throw new OzonAccountReadError('REPOSITORY_INVALID');
    }
    // Historical v2 documents may predate runtime. Normalize only absent collections
    // in a read projection; the shared collection helper must not repair corrupt data.
    const jobs = softwareJobsInDocument({ runtime: { ...runtime } });
    const candidate = document.candidates.find(value => value.id === candidateId);
    if (!candidate?.lifecycleV11?.skuPackage || candidate.targetPlatform !== 'ozon') return [];
    const candidateJobs = jobs.filter(job => job.jobType === 'ozon_account_read' && job.candidateId === candidateId);
    const relevantBindings = configuration.productionBindings.filter(production => candidateJobs.some(job =>
      job.scopeBinding.bindingId === production.bindingId && job.scopeBinding.configurationVersion === production.configurationVersion));
    const currentIds = new Set(relevantBindings.flatMap(production => {
      const binding = loadCurrentReadBinding({ document, candidateId, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
        bindingId: production.bindingId, configurationVersion: production.configurationVersion });
      return binding === null ? [] : currentOzonAccountReadJobs({ document, candidate, binding }).slice(0, 1).map(job => job.jobId);
    }));
    return candidateJobs.map(job => {
      const receipt = runtime.ozonAccountReadReceipts?.[job.jobId];
      if (runtime.ozonAccountReadReceipts && Object.hasOwn(runtime.ozonAccountReadReceipts, job.jobId)) {
        assertOzonAccountReadReceipt(receipt, job);
      }
      const isCurrent = currentIds.has(job.jobId), expired = Date.parse(serverClock()) >= Date.parse(job.scopeBinding.expiresAt);
      let admissionBlocker = null;
      if (isCurrent && !expired && job.status === 'queued' && job.revision === candidate.dataRevision) {
        try { validateSoftwareJobAdmission({ document, job, observedAt: serverClock(), phase: 'claim', workerId:
          configuration.ozonAccountReadServiceBindings.find(value => value.productionBindingId === job.scopeBinding.bindingId)?.workerId ?? null }); }
        catch (error) {
          if (error?.constructor !== Error || !/^SOFTWARE_JOB_ADMISSION_[A-Z_]+$/.test(error.message)) throw error;
          admissionBlocker = error.message;
        }
      }
      return { jobId: job.jobId, status: job.status, expectedRevision: job.revision, bindingId: job.scopeBinding.bindingId,
        isCurrent, expired, admissionBlocker,
        configurationVersion: job.scopeBinding.configurationVersion, createdAt: job.createdAt,
        requestsSent: receipt?.steps.some(step => step.requestTransmission === 'unknown') ? 'unknown'
          : receipt ? receipt.steps.filter(step => step.requestTransmission !== 'not_attempted').length : 0,
        observedMethods: receipt ? receipt.steps.filter(step => step.result?.status === 'observed').map(step => step.method) : [],
        companyCurrency: receipt?.steps.find(step => step.method === 'seller_info')?.result?.facts.companyCurrency ?? null,
        failureClass: receipt?.failureClass ?? null,
        gaps: receipt ? receipt.steps.flatMap(step => step.result?.gaps ?? []) : [],
        canContinue: isCurrent && !expired && admissionBlocker === null && job.revision === candidate.dataRevision &&
          job.status === 'queued' && job.attempt === 0 && services.has(job.scopeBinding.bindingId) };
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async function continueProduction(input) {
    const document = await repository.readSnapshot(), candidate = document.candidates.find(value => value.id === input.candidateId);
    const job = document.runtime.softwareJobs?.find(value => value.jobId === input.jobId);
    if (!candidate || !job || candidate.dataRevision !== input.expectedRevision || job.candidateId !== candidate.id) throw new OzonAccountReadError('CANDIDATE_CHANGED');
    if (job.jobType !== 'd_production_execution' || job.status !== 'queued') return deRuntimeServices.continueSavedCurrent(input);
    const view = buildDESavedJobRuntimeView({ candidate, runtime: { ...document.runtime, workers: workerRegistry.snapshot() },
      serviceBindings: configuration.deServiceBindings, productionBindings: configuration.productionBindings,
      dependencyView: deRuntimeServices.dependencyView, observedAt: serverClock() });
    // 来源冲突时绝不裸跑。2026-09-23 背心就死在这一步：视图判 DE_SAVED_JOB_REFERENCE_CONFLICT，
    // 旧代码直接落到下面的 continueSavedCurrent，把「发布账户证据」整段跳过，前检必然缺证据，
    // 新授权的第一轮被静默烧掉。自动起跑只有两个入口（授权路由、账户核验完成后接续），
    // 到达时都是刚排队的新轮次，带着 source 冲突只可能是异常，拒绝并说清是哪一条。
    if (view?.status === 'source_conflict') {
      return { status: 'saved_job_source_conflict',
        reason: view.d?.sourceBlockReason ?? view.e?.sourceBlockReason ?? null,
        externalRequests: 0, platformWrites: 0 };
    }
    // 配置阻断（continuationConfiguration 产出的 blockers）与第 97 行的 replay/E/observation 入口维持原样。
    if (!view?.canContinueSaved) return deRuntimeServices.continueSavedCurrent(input);
    const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
    const binding = configuration.productionBindings.find(value => value.bindingId === authorization.executionBinding.bindingId);
    const scope = scopeFor(candidate, binding);
    const reads = currentOzonAccountReadJobs({ document, candidate, binding: accountReadBindingForProduction(configuration, binding) });
    if (reads.length === 0) return { status: 'awaiting_account_read', externalRequests: 0, platformWrites: 0 };
    if (reads[0].status !== 'completed') return { status: 'account_read_incomplete', externalRequests: 0, platformWrites: 0 };
    await evidenceSource.publish({ scope, jobId: reads[0].jobId });
    const capabilities = await preflightProvider.loadAdapterCapabilities({ candidate, job, productionBinding: binding });
    if (capabilities.gaps.some(gap => gap.code !== 'asset_transport_not_verified')) {
      return { status: 'account_evidence_gaps', externalRequests: 0, platformWrites: 0, gaps: capabilities.gaps };
    }
    return deRuntimeServices.continueSavedCurrent(input);
  }
  async function continueAfterRead(candidateId, outcome) {
    if (outcome.status !== 'completed') return null;
    const document = await repository.readSnapshot(), candidate = document.candidates.find(value => value.id === candidateId);
    const authorization = candidate?.lifecycleV11?.skuPackage?.productionAuthorization;
    // 账户核验完成后接续的是「当前这一轮」；主人重派过的话，第一轮早已停在终态。
    const job = authorization ? currentDProductionRound(document, { authorizationRef: authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(authorization) }) : null;
    if (!candidate || !job || job.status !== 'queued') return null;
    return continueProduction({ candidateId, jobId: job.jobId, expectedRevision: candidate.dataRevision });
  }
  // 视图与执行层必须读同一份策略来源：优先用调用方注入的那一个（正式服务注入的就是给 D 运行时的同一个），
  // 没注入才退回按当前配置构造。两处读法不一致会让「按钮说能继续、执行层说不能」这种自相矛盾出现。
  const resolveObservationPolicy = typeof loadDPlatformObservationPolicy === 'function'
    ? loadDPlatformObservationPolicy
    : configuration?.dPlatformObservation ? createDPlatformObservationPolicyResolver(configuration) : () => null;

  /** 与 d-e-runtime-services 发导入前那道检查同一判定，供视图提前关掉按钮。 */
  function observationPolicyGapFor({ candidate, document, observedAt }) {
    const job = currentDProductionRound(document, {
      authorizationRef: candidate.lifecycleV11.skuPackage.productionAuthorization?.authorizationId ?? null,
      authorizationFingerprint: candidate.lifecycleV11.skuPackage.productionAuthorization
        ? fingerprintCanonicalRecord(candidate.lifecycleV11.skuPackage.productionAuthorization) : null });
    if (job === null) return null;
    let policy = null;
    try { policy = resolveObservationPolicy({ candidate, job, checkedAt: observedAt }); }
    catch { return { code: 'OZON_OBSERVATION_POLICY_UNAVAILABLE', message: '平台查询策略读取失败，当前不能继续；请核对启动配置里的查询策略。' }; }
    if (policy === null) {
      return { code: 'OZON_OBSERVATION_POLICY_MISSING',
        message: '本商品还没有平台查询策略：导入发出后将无人跟进，因此现在不继续。请先配置查询策略。' };
    }
    const remaining = Date.parse(policy.expiresAt) - Date.parse(observedAt);
    const required = policy.maxQueries * policy.intervalMs;
    if (remaining <= 0) {
      return { code: 'OZON_OBSERVATION_POLICY_EXPIRED',
        message: `平台查询策略已于 ${policy.expiresAt} 过期：导入发出后将无人跟进，因此现在不继续。请先更新查询策略。` };
    }
    if (remaining < required) {
      return { code: 'OZON_OBSERVATION_POLICY_EXPIRING_WITHIN_WINDOW',
        message: `平台查询策略将于 ${policy.expiresAt} 过期，不足以覆盖一次完整观察（约 ${Math.round(required / 60000)} 分钟）：导入发到一半就会没人跟进，因此现在不继续。请先延长查询策略。` };
    }
    return null;
  }

  return Object.freeze({
    gateSavedView({ candidate, document, view }) {
      if (!view?.canContinueSaved || view.d?.status !== 'queued') return view;
      const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
      const binding = configuration.productionBindings.find(value => value.bindingId === authorization.executionBinding.bindingId);
      const scope = scopeFor(candidate, binding), persisted = document.runtime.ozonDEPreflightEvidence?.[scope.authorizationId];
      const currentJobs = currentOzonAccountReadJobs({ document, candidate,
        binding: accountReadBindingForProduction(configuration, binding) });
      const sourceJob = currentJobs[0];
      let record = null, reason = 'account_evidence_missing';
      if (persisted || sourceJob?.status === 'completed') {
        try {
          if (persisted) evidenceSource.verifyHistoricalSnapshot(document, persisted, scope);
          // A read projection can show newly installed rules without rewriting historical evidence.
          // The normal continuation publishes this same composition before executing any work.
          record = sourceJob?.status === 'completed'
            ? evidenceSource.prospective({ document, scope, jobId: sourceJob.jobId })
            : evidenceSource.verifySnapshot(document, persisted, scope);
          if (Date.parse(serverClock()) < Date.parse(record.collectedAt) || Date.parse(serverClock()) >= Date.parse(record.expiresAt)) {
            record = null; reason = 'account_evidence_not_current';
          } else reason = null;
        } catch (error) {
          if (!(error instanceof OzonDEPreflightEvidenceError)) throw error;
          reason = error.code;
        }
      }
      const gaps = inspectOzonDEPreflightCapabilities({ candidate, authorization, scope, record, reason, now: serverClock() })
        .gaps.filter(gap => gap.code !== 'asset_transport_not_verified');
      if (gaps.length === 0) {
        // 账户证据齐全之后，才轮到「平台查询策略」这道门。
        // 顺序是有讲究的：账户证据缺失或过期时本来就不会发导入，
        // 此时再报「没有查询策略」只会把更具体、更可操作的账户缺口盖掉——
        // r69 最初把这道门放在最前面，正是这样让 7 条账户用例读不到真实缺口。
        // 与执行层发导入之前那道零副作用拒绝用同一判定，免得主人点下去才被拒。
        const observationGap = observationPolicyGapFor({ candidate, document, observedAt: serverClock() });
        if (observationGap === null) return view;
        return { ...view, canContinueSaved: false, continueJobId: null,
          d: { ...view.d, canContinueSaved: false, blockers: [...view.d.blockers,
            { code: observationGap.code, message: observationGap.message }] } };
      }
      const reads = savedReads(document, candidate.id).filter(value => value.isCurrent);
      const current = reads[0];
      const invalidSource = reason !== null && reason.startsWith('OZON_DE_PREFLIGHT_EVIDENCE_');
      const message = invalidSource ? '已保存的账户证据校验失败，请核对原始回执与当前范围。原生产任务保持等待。'
        : reason === 'account_evidence_not_current' ? '账户核验回执已超过有效期或尚未生效，当前不能复用；请在账户核验卡查看有效期并补充本次所需授权。原生产任务保持等待。'
        : record !== null ? currentEvidenceGapMessage(gaps)
        : current?.status === 'completed' ? '账户读取已完成，但尚缺当前生产范围对应的可验证证据连接。原生产任务保持等待。'
        : current ? '账户核验尚未完成，原生产任务保持等待。' : '等待本次账户只读核验，请在账户核验卡确认准确范围。';
      return { ...view, canContinueSaved: false, continueJobId: null,
        d: { ...view.d, canContinueSaved: false, blockers: [...view.d.blockers, { code: invalidSource ? reason : 'OZON_ACCOUNT_EVIDENCE_REQUIRED', message }] } };
    },
    preparation({ candidate, document }) {
      return buildOzonAccountReadPreparation({ candidate, configuration, runtimeView: savedReads(document, candidate.id) });
    },
    continueProduction,
    async authorizeAndRun({ actor, input }) {
      const service = services.get(input.bindingId);
      if (!service) throw new OzonAccountReadError('SERVICE_NOT_CONFIGURED');
      const authorized = await service.authorizeAndEnqueue({ actor, input });
      const execution = await service.continueSaved({ candidateId: input.candidateId, jobId: authorized.job.jobId, expectedRevision: input.expectedRevision });
      const production = await continueAfterRead(input.candidateId, execution);
      return { status: execution.status, requestsSent: execution.requestsSent, platformWrites: production === null ? 0 : production.platformWrites ?? 'unknown',
        jobId: execution.job.jobId, productionStatus: production?.status ?? null };
    },
    async continueSavedRead(input) {
      const document = await repository.readSnapshot(), job = document.runtime.softwareJobs?.find(value => value.jobId === input.jobId);
      if (!job || job.jobType !== 'ozon_account_read' || job.candidateId !== input.candidateId) throw new OzonAccountReadError('JOB_SOURCE_CONFLICT');
      const service = services.get(job.scopeBinding.bindingId);
      if (!service) throw new OzonAccountReadError('SERVICE_NOT_CONFIGURED');
      const execution = await service.continueSaved(input), production = await continueAfterRead(input.candidateId, execution);
      return { status: execution.status, requestsSent: execution.requestsSent, platformWrites: production === null ? 0 : production.platformWrites ?? 'unknown',
        jobId: execution.job.jobId, productionStatus: production?.status ?? null };
    }
  });
}
