import { randomUUID } from "node:crypto";
import { createC1DraftSoftwareUseCase } from "./c1-draft-software-use-case.mjs";
import { createC1DraftSoftwareRuntime, C1DraftRuntimeUnavailableError } from "./c1-draft-software-runtime.mjs";
import { prepareCurrentC1AiDraftRequest } from "./c1-ai-draft-request-source.mjs";
import { prepareC1LocalDraftSource } from "./c1-local-draft-source.mjs";
import { runC1SavedDraftRequestThroughGateway, readC1SavedDraftResultFromGateway } from "./c1-ai-gateway.mjs";
import { normalizeC1DraftServiceBindings } from "./runtime-configuration.mjs";
import { C1_AI_DRAFT_CAPABILITY, C1_AI_DRAFT_JOB_TYPE } from "./software-job-contract.mjs";
import { createActorContext } from "./runtime-identity.mjs";
import { assertWorkerRegistryBoundary } from "./worker-registry.mjs";

/** Compose configured software capabilities; construction never reads jobs, resolves keys, or calls a gateway. */
export function createC1DraftRuntimeServices({ repository, runtimeMode, serverClock, workerRegistry,
  serviceBindings = [], fetchImpl = fetch, gatewayWait, gatewayTimeoutMs } = {}) {
  const bindings = normalizeC1DraftServiceBindings(serviceBindings, runtimeMode);
  if (!repository || typeof repository.readSnapshot !== "function" || typeof serverClock !== "function" ||
      !workerRegistry || ["register", "heartbeat", "get", "snapshot"].some(method => typeof workerRegistry[method] !== "function") ||
      typeof fetchImpl !== "function") throw new Error("C1_DRAFT_SERVICE_DEPENDENCY_INVALID");
  assertWorkerRegistryBoundary(workerRegistry);
  const services = new Map();
  for (const binding of bindings) {
    const worker = { workerId: binding.workerId, version: binding.workerVersion, capabilities: [C1_AI_DRAFT_CAPABILITY] };
    workerRegistry.register({ ...worker, observedAt: serverClock() });
    const executionBinding = { provider: binding.provider, modelVersion: binding.modelVersion,
      credentialAlias: binding.credentialAlias, allowedWorkerIds: [binding.workerId] };
    const useCase = createC1DraftSoftwareUseCase({ repository, runtimeMode, serverClock, workerRegistry, executionBinding,
      readGatewayResult: input => readC1SavedDraftResultFromGateway({ ...input,
        gatewayUrl: binding.gatewayOrigin, gatewayDeploymentMode: runtimeMode, fetchImpl }),
      requestGateway: input => {
        if (input.credentialAlias !== binding.credentialAlias || input.request.provider !== binding.provider) {
          throw new Error("C1_DRAFT_SERVICE_BINDING_CONFLICT");
        }
        return runC1SavedDraftRequestThroughGateway({ ...input,
          gatewayUrl: binding.gatewayOrigin, gatewayDeploymentMode: runtimeMode,
          fetchImpl, wait: gatewayWait, totalTimeoutMs: gatewayTimeoutMs });
      } });
    function refreshWorker() { workerRegistry.heartbeat({ ...worker, status: "online" }); }
    const runtime = createC1DraftSoftwareRuntime({ useCase, loadSavedExecution: async () => {
      refreshWorker();
      const observedAt = serverClock();
      return { workerActor: createActorContext({ userId: binding.workerId, sessionId: `worker-session:${binding.workerId}:${binding.configurationVersion}`,
        actorType: "worker", roles: ["operator"], source: "registered_runtime_worker", authenticatedAt: observedAt }),
      leaseId: `lease:c1-draft:${randomUUID()}`, leaseDurationMs: binding.leaseDurationMs };
    } });
    services.set(binding.provider, { binding, useCase, runtime, refreshWorker });
  }

  function configuredService(provider) {
    const service = services.get(provider);
    if (!service) throw new C1DraftRuntimeUnavailableError();
    return service;
  }

  async function snapshotCandidate(candidateId) {
    const document = await repository.readSnapshot();
    const candidate = document.candidates.find(value => value.id === candidateId);
    if (!candidate) throw new Error("C1_DRAFT_CANDIDATE_NOT_FOUND");
    return { document, candidate };
  }

  return Object.freeze({
    configurationView: Object.freeze(bindings.map(binding => Object.freeze({ provider: binding.provider,
      modelVersion: binding.modelVersion, configurationVersion: binding.configurationVersion }))),
    async prepareLocal({ actor, input }) {
      const { candidate } = await snapshotCandidate(input.candidateId);
      // Routing is read-only. The use case repeats preparation inside its CAS transaction.
      let request = candidate.lifecycleV11?.c1AiDraftRequestV1;
      if (!request) {
        const observedAt = serverClock();
        const prepared = prepareC1LocalDraftSource({ candidate, preparedAt: observedAt });
        const preview = structuredClone(candidate);
        preview.lifecycleV11.skuPackage = structuredClone(prepared.skuPackage);
        preview.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(prepared.sourceEvidence);
        request = prepareCurrentC1AiDraftRequest(preview, observedAt);
      }
      return configuredService(request.provider).useCase.prepareLocal({ actor, input });
    },
    async prepareCurrent({ actor, input }) {
      const { candidate } = await snapshotCandidate(input.candidateId);
      const request = prepareCurrentC1AiDraftRequest(candidate, serverClock());
      const service = configuredService(request.provider);
      return service.useCase.prepareCurrent({ actor, input });
    },
    async retryKeywordHandoff({ actor, input }) {
      const { candidate } = await snapshotCandidate(input.candidateId);
      // A saved request also routes exact idempotent replay; this never authorizes or invokes the gateway.
      const request = candidate.lifecycleV11?.c1AiDraftRequestV1 || prepareCurrentC1AiDraftRequest(candidate, serverClock());
      const service = configuredService(request.provider);
      return service.useCase.retryKeywordHandoff({ actor, input });
    },
    async authorizeAndEnqueue({ actor, input }) {
      const { candidate } = await snapshotCandidate(input.candidateId);
      const request = candidate.lifecycleV11?.c1AiDraftRequestV1;
      if (!request) throw new Error("C1_DRAFT_SAVED_REQUEST_REQUIRED");
      const service = configuredService(request.provider);
      service.refreshWorker();
      return service.useCase.authorizeAndEnqueue({ actor, input });
    },
    async reconcileSavedCurrent(input) {
      const { document } = await snapshotCandidate(input.candidateId);
      const job = document.runtime?.softwareJobs?.find(value => value.jobId === input.jobId);
      if (!job || job.jobType !== C1_AI_DRAFT_JOB_TYPE || job.candidateId !== input.candidateId) throw new Error("C1_DRAFT_JOB_NOT_FOUND");
      return configuredService(job.scopeBinding.provider).runtime.reconcileSavedCurrent(input);
    },
    async continueSavedCurrent(input) {
      const { document } = await snapshotCandidate(input.candidateId);
      const job = document.runtime?.softwareJobs?.find(value => value.jobId === input.jobId);
      if (!job || job.jobType !== C1_AI_DRAFT_JOB_TYPE || job.candidateId !== input.candidateId) throw new Error("C1_DRAFT_JOB_NOT_FOUND");
      const service = configuredService(job.scopeBinding.provider);
      // A completed receipt needs no new credential use. Queued execution must
      // still address the alias that its persisted authorization bound.
      if (job.status === "queued" && job.scopeBinding.credentialAlias !== service.binding.credentialAlias) {
        throw new Error("C1_DRAFT_SERVICE_BINDING_CONFLICT");
      }
      return service.runtime.continueSavedCurrent(input);
    }
  });
}
