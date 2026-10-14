import { assertSafeRuntimeRecord, createWorkerDescriptor, workerSatisfiesCapabilities } from "./runtime-identity.mjs";

function clone(value) {
  return structuredClone(value);
}

export function createLocalDevelopmentWorkerRegistry({ clock = () => new Date().toISOString(), heartbeatTtlMs = 30_000 } = {}) {
  if (typeof clock !== "function" || !Number.isInteger(heartbeatTtlMs) || heartbeatTtlMs < 1_000) {
    throw new Error("WORKER_REGISTRY_CONFIGURATION_INVALID");
  }
  const workers = new Map();

  function observedNow() {
    const value = clock();
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new Error("WORKER_REGISTRY_CLOCK_INVALID");
    return Object.freeze({ value: new Date(timestamp).toISOString(), timestamp });
  }

  function observedAgeMs(worker, now = observedNow()) {
    const observedAt = Date.parse(worker.observedAt);
    if (Number.isNaN(observedAt)) throw new Error("WORKER_REGISTRY_OBSERVED_AT_INVALID");
    return now.timestamp - observedAt;
  }

  function assertObservedAtNotFuture(worker, now = observedNow()) {
    if (observedAgeMs(worker, now) < 0) throw new Error("WORKER_REGISTRY_OBSERVED_AT_IN_FUTURE");
  }

  function isCurrent(worker, now = observedNow()) {
    const age = observedAgeMs(worker, now);
    return age >= 0 && age <= heartbeatTtlMs;
  }

  return Object.freeze({
    boundaryType: "worker_registry",
    persistenceClass: "local_development_ephemeral",
    multiUserReady: false,
    heartbeatTtlMs,
    register(input) {
      const worker = createWorkerDescriptor(input);
      if (workers.has(worker.workerId)) throw new Error("WORKER_REGISTRY_DUPLICATE_WORKER");
      assertObservedAtNotFuture(worker);
      assertSafeRuntimeRecord(worker, "workerDescriptor");
      workers.set(worker.workerId, worker);
      return clone(worker);
    },
    heartbeat({ workerId, capabilities, version, status = "online" }) {
      if (!workers.has(workerId)) throw new Error("WORKER_REGISTRY_UNKNOWN_WORKER");
      const now = observedNow();
      const worker = createWorkerDescriptor({ workerId, capabilities, version, status, observedAt: now.value });
      assertSafeRuntimeRecord(worker, "workerDescriptor");
      workers.set(worker.workerId, worker);
      return clone(worker);
    },
    get(workerId) {
      return workers.has(workerId) ? clone(workers.get(workerId)) : null;
    },
    findEligible(requiredCapabilities) {
      const now = observedNow();
      return [...workers.values()]
        .filter((worker) => worker.status === "online" && isCurrent(worker, now) && workerSatisfiesCapabilities(worker, requiredCapabilities))
        .map(clone);
    },
    markOffline(workerId) {
      const current = workers.get(workerId);
      if (!current) throw new Error("WORKER_REGISTRY_UNKNOWN_WORKER");
      const now = observedNow();
      const worker = createWorkerDescriptor({
        workerId: current.workerId,
        capabilities: current.capabilities,
        version: current.version,
        status: "offline",
        observedAt: now.value
      });
      workers.set(workerId, worker);
      return clone(worker);
    },
    snapshot() {
      const now = observedNow();
      return [...workers.values()].map((worker) => ({ ...clone(worker), heartbeatCurrent: isCurrent(worker, now) }));
    }
  });
}

export function assertWorkerRegistryBoundary(registry) {
  if (!registry || registry.boundaryType !== "worker_registry" || typeof registry.findEligible !== "function") {
    throw new Error("WORKER_REGISTRY_BOUNDARY_REQUIRED");
  }
  return Object.freeze({
    persistenceClass: String(registry.persistenceClass || "unknown"),
    multiUserReady: registry.multiUserReady === true
  });
}
