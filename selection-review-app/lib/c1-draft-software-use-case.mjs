import { isDeepStrictEqual } from 'node:util';
import { prepareC1LocalDraftSource } from './c1-local-draft-source.mjs';
import { recoverC1KeywordHandoffTechnicalFailure } from './software-execution-state.mjs';
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { assertCurrentC1AiDraftRequest, validateC1AiDraftRequest } from "./c1-ai-draft-contract.mjs";
import { prepareCurrentC1AiDraftRequest, assertCurrentC1AiDraftRequestSources, assertC1DraftExecutionBinding } from "./c1-ai-draft-request-source.mjs";
import { C1AiGatewayError, C1_AI_GATEWAY_TOTAL_TIMEOUT_MS, buildC1GatewayJob } from "./c1-ai-gateway.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { authorizeOperation, workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { createRepositoryBackedSoftwareJobStore, assertC1PaidKeywordContinuationResult } from "./software-job-repository.mjs";
import { C1_AI_DRAFT_CAPABILITY, C1_AI_DRAFT_JOB_TYPE, createSoftwareJobEnvelope, createSoftwareJobResultEnvelope,
  normalizeC1AiDraftScopeBinding, projectC1AiSoftwareJobAuthorizedExecution, readC1PaidKeywordSourceForSettlement } from "./software-job-contract.mjs";

function closed(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(code);
}

function assertRequest(request) {
  if (!validateC1AiDraftRequest(request).valid) throw new Error("C1_DRAFT_REQUEST_INVALID");
}

function buildJobInput({ request, expectedRevision, authorizationRef, credentialAlias, jobId, ownerUserId, requestedByUserId, idempotencyKey }) {
  assertRequest(request);
  const identity = request.sourceIdentity;
  const input = { jobId, candidateId: identity.candidateId, skuPackageId: identity.skuPackageId,
    revision: expectedRevision + 1, jobType: C1_AI_DRAFT_JOB_TYPE, ownerUserId, requestedByUserId,
    requiredCapabilities: [C1_AI_DRAFT_CAPABILITY], idempotencyKey };
  input.scopeBinding = normalizeC1AiDraftScopeBinding({ schemaVersion: "software-job-scope-v1",
    candidateId: identity.candidateId, skuPackageId: identity.skuPackageId, sourceRevision: expectedRevision,
    resultRevision: input.revision, sourceSkuRevision: request.sourceSkuRevision, identity: structuredClone(identity),
    variantKey: request.identity.variantKey, sideEffectScope: C1_AI_DRAFT_JOB_TYPE, authorizationRef, credentialAlias,
    inputFingerprint: request.requestFingerprint, requestFingerprint: request.requestFingerprint, provider: request.provider }, input);
  // Reuse the public envelope validators before handing this declarative input to the transaction.
  createSoftwareJobEnvelope({ ...input, createdAt: request.requestedAt });
  return input;
}

function jobReference(input) {
  return { schemaVersion: "software-job-ref-v1", jobId: input.jobId, jobType: input.jobType,
    candidateId: input.candidateId, skuPackageId: input.skuPackageId,
    sourceRevision: input.scopeBinding.sourceRevision, resultRevision: input.revision,
    inputFingerprint: input.scopeBinding.inputFingerprint };
}

/** Pure preparation accepts a frozen domain request. It does not create a paid authorization. */
export function prepareC1DraftSoftwareExecution({ candidate, request, expectedRevision, authorizationRef, credentialAlias,
  jobId, ownerUserId, requestedByUserId, idempotencyKey }) {
  if (!candidate || candidate.id !== request?.sourceIdentity?.candidateId || candidate.dataRevision !== expectedRevision) {
    throw new Error("C1_DRAFT_CANDIDATE_REVISION_CONFLICT");
  }
  assertCurrentC1AiDraftRequest({ skuPackage: candidate.lifecycleV11?.skuPackage, request });
  buildC1GatewayJob({ candidateId: candidate.id, dataRevision: expectedRevision, request });
  const jobInput = buildJobInput({ request, expectedRevision, authorizationRef, credentialAlias, jobId, ownerUserId, requestedByUserId, idempotencyKey });
  return Object.freeze({ request: structuredClone(request), jobInput, jobRef: jobReference(jobInput) });
}

/** The injected gateway receives only a saved request, a persisted execution DTO and a credential alias. */
export function createC1DraftSoftwareUseCase({ repository, runtimeMode, serverClock, workerRegistry = null, requestGateway = null, readGatewayResult = null, executionBinding = null }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode)) throw new Error("C1_DRAFT_RUNTIME_MODE_INVALID");
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  if (typeof serverClock !== "function" || (requestGateway !== null && typeof requestGateway !== "function") ||
      (readGatewayResult !== null && typeof readGatewayResult !== "function")) {
    throw new Error("C1_DRAFT_DEPENDENCY_INVALID");
  }
  const configuredBinding = executionBinding === null ? null : assertC1DraftExecutionBinding(executionBinding);
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock, workerRegistry });

  async function savedJob(jobId) {
    const job = await store.get(jobId);
    if (!job || job.jobType !== C1_AI_DRAFT_JOB_TYPE) throw new Error("C1_DRAFT_JOB_NOT_FOUND");
    return job;
  }

  async function candidateSnapshot(candidateId) {
    const document = await repository.readSnapshot();
    const candidate = document.candidates.find(value => value.id === candidateId);
    if (!candidate) throw new Error("C1_DRAFT_CANDIDATE_NOT_FOUND");
    return { document, candidate };
  }

  function prepareDraftRequest(current, relatedJobs, observedAt) {
    if (relatedJobs.some(job => job.jobType === C1_AI_DRAFT_JOB_TYPE &&
        (["queued", "claimed", "waiting_platform", "unknown_outcome"].includes(job.status) ||
          (job.status === "completed" && job.resultEnvelope?.applicationDisposition !== "applied")))) throw new Error("C1_DRAFT_CURRENT_JOB_UNRESOLVED");
    const request = prepareCurrentC1AiDraftRequest(current, observedAt);
    buildC1GatewayJob({ candidateId: current.id, dataRevision: current.dataRevision, request });
    current.lifecycleV11.c1AiDraftRequestV1 = structuredClone(request);
    return { candidate: current, result: { status: "awaiting_paid_confirmation", requestRef: request.requestId,
      requestFingerprint: request.requestFingerprint, request, providerCalls: 0 } };
  }

  const useCase = {
    async prepareLocal({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      closed(input, ["candidateId", "expectedRevision", "idempotencyKey", "auditEventId"], "C1_DRAFT_PREPARE_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") throw new Error("C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED");
      const { candidate } = await candidateSnapshot(input.candidateId);
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], action: "c1_local_draft_prepare",
        candidateId: input.candidateId, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate: current, observedAt, relatedSoftwareJobs }) => {
          if (current.lifecycleV11.c1AiDraftRequestV1) throw new Error("C1_LOCAL_DRAFT_REQUEST_ALREADY_SAVED");
          const prepared = prepareC1LocalDraftSource({ candidate: current, preparedAt: observedAt });
          current.lifecycleV11.skuPackage = structuredClone(prepared.skuPackage);
          current.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(prepared.sourceEvidence);
          return prepareDraftRequest(current, relatedSoftwareJobs, observedAt);
        } });
    },
    async prepareCurrent({ actor, input }) {
      input = structuredClone(input);
      actor = structuredClone(actor);
      closed(input, ["candidateId", "expectedRevision", "idempotencyKey", "auditEventId"], "C1_DRAFT_PREPARE_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["owner", "operator"] });
      const { candidate } = await candidateSnapshot(input.candidateId);
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner", "operator"], action: "c1_ai_draft_prepare",
        candidateId: input.candidateId, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId, serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate: current, observedAt, relatedSoftwareJobs }) => {
          return prepareDraftRequest(current, relatedSoftwareJobs, observedAt);
        } });
    },

    async retryKeywordHandoff({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      closed(input, ["candidateId", "expectedRevision", "keywordJobId", "failureId", "idempotencyKey", "auditEventId"], "C1_KEYWORD_HANDOFF_RETRY_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") throw new Error("C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED");
      if (configuredBinding === null) throw new Error("C1_DRAFT_EXECUTION_BINDING_REQUIRED");
      const { candidate, document } = await candidateSnapshot(input.candidateId);
      const sourceJob = document.runtime?.softwareJobs?.find(job => job.jobId === input.keywordJobId);
      if (!sourceJob || sourceJob.candidateId !== input.candidateId) throw new Error("C1_KEYWORD_HANDOFF_RETRY_SOURCE_CONFLICT");
      readC1PaidKeywordSourceForSettlement(document, sourceJob);
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], action: "c1_keyword_handoff_retry",
        candidateId: input.candidateId, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate: current, relatedSoftwareJobs, observedAt }) => {
          const job = relatedSoftwareJobs.find(value => value.jobId === input.keywordJobId);
          if (!isDeepStrictEqual(job, sourceJob) || relatedSoftwareJobs.some(value => value.jobType === C1_AI_DRAFT_JOB_TYPE)) {
            throw new Error("C1_KEYWORD_HANDOFF_RETRY_SOURCE_CONFLICT");
          }
          assertC1PaidKeywordContinuationResult({ candidate: current, job });
          const failure = current.executionRuntime?.technicalFailure;
          if (current.executionRuntime?.candidateId !== current.id || failure?.sourceRevision !== job.revision ||
              !isDeepStrictEqual(failure.evidenceRefs, [job.resultRef])) throw new Error("C1_KEYWORD_HANDOFF_RETRY_SOURCE_CONFLICT");
          const recovered = recoverC1KeywordHandoffTechnicalFailure(current.executionRuntime, {
            failureId: input.failureId, softwareJobId: job.jobId, errorCode: "C1_DRAFT_RUNTIME_UNAVAILABLE", at: observedAt
          });
          const prepared = prepareDraftRequest(current, relatedSoftwareJobs, observedAt);
          if (prepared.result.request.provider !== configuredBinding.provider) throw new Error("C1_DRAFT_EXECUTION_BINDING_PROVIDER_CONFLICT");
          current.executionRuntime = recovered.runtime;
          return { candidate: current, result: { ...prepared.result, schemaVersion: "c1-keyword-handoff-resumption-v1",
            keywordJobId: job.jobId, priorTechnicalFailure: recovered.priorTechnicalFailure } };
        } });
    },

    async authorizeAndEnqueue({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      closed(input, ["candidateId", "expectedRevision", "requestRef", "requestFingerprint", "confirmPaidCall", "expiresAt", "idempotencyKey", "auditEventId"], "C1_DRAFT_AUTHORIZE_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") throw new Error("C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED");
      if (input.confirmPaidCall !== true || (input.expiresAt !== null && (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt))))) throw new Error("C1_DRAFT_PAID_CONFIRMATION_INVALID");
      if (configuredBinding === null) throw new Error("C1_DRAFT_EXECUTION_BINDING_REQUIRED");
      const { candidate } = await candidateSnapshot(input.candidateId);
      const request = candidate.lifecycleV11.c1AiDraftRequestV1;
      assertRequest(request);
      if (request.requestId !== input.requestRef || request.requestFingerprint !== input.requestFingerprint) throw new Error("C1_DRAFT_SAVED_REQUEST_CONFLICT");
      if (request.provider !== configuredBinding.provider) throw new Error("C1_DRAFT_EXECUTION_BINDING_PROVIDER_CONFLICT");
      const authorizationRef = `authorization:c1-ai-draft:${request.requestFingerprint.slice(0, 32)}`;
      const jobId = `software-job:c1-draft:${request.requestFingerprint.slice(0, 32)}`;
      const jobInput = buildJobInput({ request, expectedRevision: input.expectedRevision, authorizationRef,
        credentialAlias: configuredBinding.credentialAlias, jobId, ownerUserId: actor.userId, requestedByUserId: actor.userId, idempotencyKey: input.idempotencyKey });
      const admissionRecords = { schemaVersion: "business-mutation-software-job-admission-effect-v1",
        authorizationRecord: { schemaVersion: "software-job-authorization-record-v1", authorizationId: authorizationRef,
          authorizationType: "paid_ai_draft", status: "active", action: C1_AI_DRAFT_JOB_TYPE, scopeBinding: jobInput.scopeBinding,
          authorizedByUserId: actor.userId, authorizedAt: null, expiresAt: input.expiresAt, maxUses: 1, useCount: 0, consumedByJobId: null, consumedAt: null },
        credentialBinding: { schemaVersion: "software-job-credential-binding-v1", bindingId: `binding:c1-draft:${request.requestFingerprint.slice(0, 32)}`,
          credentialAlias: configuredBinding.credentialAlias, status: "active", provider: configuredBinding.provider, sideEffectScope: C1_AI_DRAFT_JOB_TYPE,
          scopeBinding: jobInput.scopeBinding, allowedWorkerIds: configuredBinding.allowedWorkerIds, redaction: "credential_alias_only", boundAt: null, expiresAt: input.expiresAt } };
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], action: C1_AI_DRAFT_JOB_TYPE,
        candidateId: input.candidateId, skuPackageId: jobInput.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord({ input, jobInput, admissionRecords }),
        auditEventId: input.auditEventId, authorizationRef, serverClock,
        softwareJobEffect: { schemaVersion: "business-mutation-effect-v1", kind: "software_job", operation: "enqueue", jobInput, admissionRecords },
        mutate: ({ candidate: current, observedAt }) => {
          if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.parse(observedAt)) throw new Error("C1_DRAFT_AUTHORIZATION_EXPIRED");
          if (!workerRegistry || typeof workerRegistry.snapshot !== "function") throw new Error("C1_DRAFT_WORKER_REGISTRY_REQUIRED");
          const registered = workerRegistry.snapshot();
          for (const workerId of configuredBinding.allowedWorkerIds) {
            const worker = registered.find(entry => entry.workerId === workerId);
            if (!worker || worker.status !== "online" || worker.heartbeatCurrent !== true || !workerSatisfiesCapabilities(worker, [C1_AI_DRAFT_CAPABILITY])) throw new Error("C1_DRAFT_WORKER_NOT_CURRENT");
          }
          if (fingerprintCanonicalRecord(current.lifecycleV11.c1AiDraftRequestV1) !== fingerprintCanonicalRecord(request)) throw new Error("C1_DRAFT_SAVED_REQUEST_CONFLICT");
          assertCurrentC1AiDraftRequestSources({ candidate: current, request, observedAt });
          buildC1GatewayJob({ candidateId: current.id, dataRevision: current.dataRevision, request });
          current.lifecycleV11.c1AiDraftJobRefV1 = jobReference(jobInput);
          return { candidate: current, result: { status: "queued", requestFingerprint: request.requestFingerprint, providerCalls: 0 } };
        } });
    },

    async runSaved({ actor, input }) {
      input = structuredClone(input);
      actor = structuredClone(actor);
      closed(input, ["candidateId", "expectedRevision", "jobId", "leaseId", "leaseDurationMs"], "C1_DRAFT_RUN_SAVED_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["operator"] });
      if (actor.actorType !== "worker") throw new Error("C1_DRAFT_WORKER_REQUIRED");
      const job = await savedJob(input.jobId);
      if (job.candidateId !== input.candidateId || job.revision !== input.expectedRevision) throw new Error("C1_DRAFT_CANDIDATE_REVISION_CONFLICT");
      const applyInput = { jobId: job.jobId, payloadFingerprint: job.resultEnvelope?.payloadFingerprint,
        expectedRevision: job.revision, idempotencyKey: `c1-apply:${job.jobId}`, auditEventId: `c1-apply-audit:${job.jobId}` };
      if (job.resultEnvelope?.applicationDisposition === "applied") {
        const document = await repository.readSnapshot();
        const completed = document.runtime?.idempotencyRecords?.filter(entry => entry.action === "c1_ai_draft_apply" &&
          entry.candidateId === job.candidateId && entry.result?.softwareJobRef?.jobId === job.jobId &&
          entry.result?.payloadFingerprint === job.resultEnvelope.payloadFingerprint && entry.result.applicationDisposition === "applied");
        if (!completed || completed.length !== 1 || job.status !== "completed" || job.externalRequestState !== "succeeded") throw new Error("BUSINESS_MUTATION_HALF_STATE_REJECTED");
        return Object.freeze({ status: "idempotent_replay", result: structuredClone(completed[0].result) });
      }
      if (job.status === "completed" && job.externalRequestState === "succeeded") {
        const result = await useCase.apply({ actor, input: applyInput });
        return Object.freeze({ status: "applied", result });
      }
      if (["claimed", "waiting_platform", "unknown_outcome", "failed"].includes(job.status)) {
        return Object.freeze({ status: "stopped", technicalStatus: job.status, externalRequestState: job.externalRequestState, jobId: job.jobId });
      }
      if (job.status !== "queued" || job.attempt !== 0 || job.externalRequestState !== "not_sent") throw new Error("C1_DRAFT_JOB_STATE_INVALID");
      const outcome = await useCase.run({ actor, input: { jobId: job.jobId, leaseId: input.leaseId, leaseDurationMs: input.leaseDurationMs } });
      if (outcome.status !== "receipt_saved") return outcome;
      const result = await useCase.apply({ actor, input: { ...applyInput, payloadFingerprint: outcome.job.resultEnvelope.payloadFingerprint } });
      return Object.freeze({ status: "applied", result });
    },

    async reconcileSaved({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      closed(input, ["candidateId", "expectedRevision", "jobId", "leaseId", "leaseDurationMs"], "C1_DRAFT_RECONCILIATION_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["operator"] });
      if (actor.actorType !== "worker") throw new Error("C1_DRAFT_WORKER_REQUIRED");
      if (readGatewayResult === null) throw new Error("C1_DRAFT_RECONCILIATION_READER_REQUIRED");
      const claim = await store.beginC1AiDraftReconciliation({ ...input, workerId: actor.userId });
      if (claim.terminal) {
        if (claim.job.status === "completed") return useCase.runSaved({ actor, input });
        return Object.freeze({ status: "failed", job: claim.job });
      }
      if (!claim.acquired) return Object.freeze({ status: "pending", jobId: input.jobId, reconciliationInProgress: true });
      const { job, request, authorizedExecution, gatewayJobId } = claim;
      const settlement = { jobId: job.jobId, workerId: actor.userId, attemptId: job.c1ResultReconciliation.readAttempt.attemptId };
      let outcome;
      try {
        outcome = await readGatewayResult({ request, authorizedExecution, gatewayJobId, credentialAlias: job.scopeBinding.credentialAlias,
          totalTimeoutMs: Math.min(C1_AI_GATEWAY_TOTAL_TIMEOUT_MS, input.leaseDurationMs) });
      } catch (error) {
        const known = error instanceof C1AiGatewayError;
        const terminalFailure = known && ["failed", "succeeded"].includes(error.externalRequestState) &&
          error.jobId === gatewayJobId && error.accounting?.gatewayJobId === gatewayJobId;
        if (terminalFailure) {
          const envelope = createSoftwareJobResultEnvelope({ job, resultRef: gatewayJobId, payloadKind: C1_AI_DRAFT_JOB_TYPE,
            externalRequestState: error.externalRequestState, recordedAt: serverClock(),
            payload: { schemaVersion: "c1-ai-draft-software-failure-v1", request, accounting: error.accounting,
              errorCode: error.code, providerOutcome: error.providerOutcome ?? null,
              ...(error.serviceTiming ? { serviceTiming: structuredClone(error.serviceTiming) } : {}) } });
          const failed = await store.settleC1AiDraftReconciliation({ ...settlement, observationStatus: "failed", resultEnvelope: envelope, failureClass: error.code });
          return Object.freeze({ status: "failed", job: failed });
        }
        const stopped = await store.settleC1AiDraftReconciliation({ ...settlement, observationStatus: "read_failed",
          failureClass: known ? error.code : "C1_DRAFT_RECONCILIATION_UNEXPECTED_ERROR" });
        if (!known) throw error;
        return Object.freeze({ status: "unknown_outcome", job: stopped });
      }
      if (!outcome || outcome.jobId !== gatewayJobId || !isDeepStrictEqual(outcome.request, request) ||
          !["receipt_ready", "pending"].includes(outcome.status)) {
        await store.settleC1AiDraftReconciliation({ ...settlement, observationStatus: "read_failed", failureClass: "C1_DRAFT_GATEWAY_RESULT_INVALID" });
        throw new Error("C1_DRAFT_GATEWAY_RESULT_INVALID");
      }
      if (outcome.status === "pending") {
        const pending = await store.settleC1AiDraftReconciliation({ ...settlement, observationStatus: "pending" });
        return Object.freeze({ status: "pending", job: pending });
      }
      const envelope = createSoftwareJobResultEnvelope({ job, resultRef: outcome.receipt?.receiptId, payloadKind: C1_AI_DRAFT_JOB_TYPE,
        payload: { schemaVersion: "c1-ai-draft-software-result-v1", request, receipt: outcome.receipt }, recordedAt: serverClock() });
      const completed = await store.settleC1AiDraftReconciliation({ ...settlement, observationStatus: "completed", resultEnvelope: envelope });
      const result = await useCase.apply({ actor, input: { jobId: job.jobId, payloadFingerprint: completed.resultEnvelope.payloadFingerprint,
        expectedRevision: job.revision, idempotencyKey: `c1-apply:${job.jobId}`, auditEventId: `c1-apply-audit:${job.jobId}` } });
      return Object.freeze({ status: "applied", result });
    },

    async enqueue({ actor, input }) {
      input = structuredClone(input);
      actor = structuredClone(actor);
      closed(input, ["request", "expectedRevision", "authorizationRef", "credentialAlias", "jobId", "idempotencyKey", "auditEventId"], "C1_DRAFT_ENQUEUE_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      const frozen = structuredClone(input);
      const jobInput = buildJobInput({ ...frozen, ownerUserId: actor.userId, requestedByUserId: actor.userId });
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], action: C1_AI_DRAFT_JOB_TYPE,
        candidateId: jobInput.candidateId, skuPackageId: jobInput.skuPackageId, expectedRevision: frozen.expectedRevision,
        idempotencyKey: frozen.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord(jobInput),
        auditEventId: frozen.auditEventId, authorizationRef: frozen.authorizationRef, serverClock,
        softwareJobEffect: { schemaVersion: "business-mutation-effect-v1", kind: "software_job", operation: "enqueue", jobInput },
        mutate: ({ candidate }) => {
          const prepared = prepareC1DraftSoftwareExecution({ ...frozen, candidate, ownerUserId: actor.userId, requestedByUserId: actor.userId });
          candidate.lifecycleV11.c1AiDraftRequestV1 = prepared.request;
          candidate.lifecycleV11.c1AiDraftJobRefV1 = prepared.jobRef;
          return { candidate, result: { status: "queued", requestFingerprint: frozen.request.requestFingerprint, providerCalls: 0 } };
        }
      });
    },

    async run({ actor, input }) {
      input = structuredClone(input);
      actor = structuredClone(actor);
      closed(input, ["jobId", "leaseId", "leaseDurationMs"], "C1_DRAFT_RUN_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["operator"] });
      if (actor.actorType !== "worker") throw new Error("C1_DRAFT_WORKER_REQUIRED");
      if (requestGateway === null) throw new Error("C1_DRAFT_GATEWAY_REQUIRED");
      const queued = await savedJob(input.jobId);
      if (queued.status !== "queued" || queued.attempt !== 0 || queued.externalRequestState !== "not_sent") {
        throw new Error("C1_DRAFT_REQUEST_ALREADY_ATTEMPTED");
      }
      const document = await repository.readSnapshot();
      const candidate = document.candidates.find(value => value.id === queued.candidateId);
      if (!candidate || candidate.dataRevision !== queued.revision || candidate.lifecycleV11?.c1AiDraftJobRefV1?.jobId !== queued.jobId) {
        throw new Error("C1_DRAFT_CANDIDATE_REVISION_CONFLICT");
      }
      const request = assertCurrentC1AiDraftRequest({ skuPackage: candidate.lifecycleV11.skuPackage, request: candidate.lifecycleV11.c1AiDraftRequestV1 });
      if (request.requestFingerprint !== queued.scopeBinding.requestFingerprint) throw new Error("C1_DRAFT_SAVED_REQUEST_CONFLICT");
      buildC1GatewayJob({ candidateId: candidate.id, dataRevision: candidate.dataRevision, request });
      await store.claim({ ...input, worker: { workerId: actor.userId } });
      const job = await store.markExternalRequestStarted({ jobId: queued.jobId, workerId: actor.userId, leaseId: input.leaseId,
        externalRequestRef: `c1-request:${queued.jobId}:${request.requestFingerprint}` });
      const authorizedExecution = projectC1AiSoftwareJobAuthorizedExecution(job, request);
      let outcome;
      try {
        outcome = await requestGateway({ request, authorizedExecution, credentialAlias: job.scopeBinding.credentialAlias,
          onGatewayJobAccepted: async input => {
            closed(input, ["gatewayJobId"], "C1_DRAFT_GATEWAY_ACCEPTANCE_INPUT_INVALID");
            return store.recordC1GatewayAcceptance({ jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId,
              requestFingerprint: request.requestFingerprint, gatewayJobId: input.gatewayJobId });
          } });
      } catch (error) {
        if (!(error instanceof C1AiGatewayError)) throw error;
        if (!["succeeded", "failed", "unknown_outcome"].includes(error.externalRequestState)) throw new Error("C1_DRAFT_GATEWAY_ERROR_CONTRACT_INVALID");
        const resultEnvelope = createSoftwareJobResultEnvelope({ job,
          resultRef: error.jobId ?? `c1-outcome:${job.jobId}`, payloadKind: C1_AI_DRAFT_JOB_TYPE,
          externalRequestState: error.externalRequestState, recordedAt: serverClock(),
          payload: { schemaVersion: "c1-ai-draft-software-failure-v1", request, accounting: error.accounting, errorCode: error.code,
            providerOutcome: error.providerOutcome ?? null,
              ...(error.serviceTiming ? { serviceTiming: structuredClone(error.serviceTiming) } : {}) } });
        const settled = await store.settle({ jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId,
          status: error.externalRequestState === "unknown_outcome" ? "unknown_outcome" : "failed", externalRequestState: error.externalRequestState,
          failureClass: error.code, resultEnvelope });
        return Object.freeze({ status: settled.status, job: settled });
      }
      if (!outcome || outcome.status !== "receipt_ready" || outcome.jobId !== outcome.receipt?.gatewayJobId ||
          fingerprintCanonicalRecord(outcome.request) !== fingerprintCanonicalRecord(request)) throw new Error("C1_DRAFT_GATEWAY_RESULT_INVALID");
      const envelope = createSoftwareJobResultEnvelope({ job, resultRef: outcome.receipt.receiptId,
        payloadKind: C1_AI_DRAFT_JOB_TYPE, payload: { schemaVersion: "c1-ai-draft-software-result-v1", request, receipt: outcome.receipt }, recordedAt: serverClock() });
      const settled = await store.settle({ jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId,
        status: "completed", externalRequestState: "succeeded", resultEnvelope: envelope });
      return Object.freeze({ status: "receipt_saved", job: settled });
    },

    async apply({ actor, input }) {
      input = structuredClone(input);
      actor = structuredClone(actor);
      closed(input, ["jobId", "payloadFingerprint", "expectedRevision", "idempotencyKey", "auditEventId"], "C1_DRAFT_APPLY_INPUT_INVALID");
      authorizeOperation({ actor, requiredRoles: ["operator", "owner"] });
      const job = await savedJob(input.jobId);
      if (input.expectedRevision !== job.revision) throw new Error("C1_DRAFT_CANDIDATE_REVISION_CONFLICT");
      const effect = { schemaVersion: "c1-ai-draft-application-effect-v1", jobId: job.jobId, payloadFingerprint: input.payloadFingerprint };
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["operator", "owner"],
        action: "c1_ai_draft_apply", candidateId: job.candidateId, skuPackageId: job.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(effect), auditEventId: input.auditEventId, serverClock,
        softwareJobApplicationEffect: effect });
    }
  };
  return Object.freeze(useCase);
}
