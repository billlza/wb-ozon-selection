import { authorizeOperation, createActorContext } from "./runtime-identity.mjs";
import { assertSoftwareJobStrictRef } from "./software-job-contract.mjs";

function closed(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error("C1_DRAFT_RUNTIME_INPUT_INVALID");
  }
}

export class C1DraftRuntimeUnavailableError extends Error {
  constructor() {
    super("C1_DRAFT_RUNTIME_NOT_CONFIGURED: 尚未配置正式身份、已保存的精确付费授权与网关连接");
    this.name = "C1DraftRuntimeUnavailableError";
    this.code = "C1_DRAFT_RUNTIME_NOT_CONFIGURED";
  }
}

/**
 * A trusted service supplies only the registered worker and bounded lease for an
 * explicitly identified saved job. The use case rereads its request and authorization.
 * Construction never grants permission, scans jobs or starts work.
 */
export function createC1DraftSoftwareRuntime({ useCase, loadSavedExecution = null }) {
  if (!useCase || typeof useCase.runSaved !== "function" ||
      (loadSavedExecution !== null && typeof loadSavedExecution !== "function")) throw new Error("C1_DRAFT_RUNTIME_DEPENDENCY_INVALID");
  async function savedWorkerInput(input) {
      closed(input, ["candidateId", "expectedRevision", "jobId"]);
      assertSoftwareJobStrictRef(input.candidateId, "candidateId");
      assertSoftwareJobStrictRef(input.jobId, "jobId");
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("C1_DRAFT_RUNTIME_INPUT_INVALID");
      if (loadSavedExecution === null) throw new C1DraftRuntimeUnavailableError();
      const execution = structuredClone(await loadSavedExecution(Object.freeze({ ...input })));
      closed(execution, ["workerActor", "leaseId", "leaseDurationMs"]);
      const worker = createActorContext(execution.workerActor);
      if (worker.actorType !== "worker") throw new Error("C1_DRAFT_WORKER_REQUIRED");
      authorizeOperation({ actor: worker, requiredRoles: ["operator"] });
      assertSoftwareJobStrictRef(execution.leaseId, "leaseId");
      if (!Number.isInteger(execution.leaseDurationMs) || execution.leaseDurationMs < 1000 || execution.leaseDurationMs > 1_800_000) throw new Error("C1_DRAFT_RUNTIME_INPUT_INVALID");
      return { actor: worker, input: { ...input, leaseId: execution.leaseId, leaseDurationMs: execution.leaseDurationMs } };
  }
  return Object.freeze({
    async continueSavedCurrent(input) {
      return useCase.runSaved(await savedWorkerInput(input));
    },
    async reconcileSavedCurrent(input) {
      if (typeof useCase.reconcileSaved !== "function") throw new C1DraftRuntimeUnavailableError();
      return useCase.reconcileSaved(await savedWorkerInput(input));
    }
  });
}
