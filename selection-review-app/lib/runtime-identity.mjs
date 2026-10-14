import {
  assertNoProductionSecrets,
  BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED,
  assertNoRawPersistenceKeys,
  isCanonicalC1AuthorizationId,
  C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS,
  collectProductionSecretErrors,
  formatC2ReferenceDiagnostic,
  PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
  appendC2DiagnosticPath
} from "./production-contract-primitives.mjs";
import { normalizeProductionEntities, ProductionEntityStorageError } from "./production-entity-storage.mjs";

export const ACTOR_TYPES = Object.freeze(["human", "software", "worker", "maintenance"]);
export const USER_ROLES = Object.freeze(["owner", "operator", "reviewer", "production_authorizer", "technical_maintainer"]);
export const WORKER_CAPABILITIES = Object.freeze([
  "chrome", "ozon-login", "wb-login", "1688-login", "seerfar-browser", "company-vpn", "file-upload", "image-processing",
  "stable-asset-transport", "seerfar-open-api", "ai-draft-gateway", "ozon-production-execution", "ozon-independent-readback", "ozon-account-read", "linkfox-discovery-api", "seerfar-category-discovery-api", "linkfox-product-detail-api", "1688-image-search-browser"
]);

const SECRET_PATTERN = /(?:authorization|bearer|cookie|password|api[_-]?key|secret|token)\s*(?:=|:)/i;
const ACTOR_ROLE_COMPATIBILITY = Object.freeze({
  human: new Set(USER_ROLES),
  software: new Set(["operator"]),
  worker: new Set(["operator"]),
  maintenance: new Set(["technical_maintainer"])
});

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`RUNTIME_IDENTITY_INVALID: ${label}不能为空`);
  if (SECRET_PATTERN.test(normalized)) throw new Error(`RUNTIME_IDENTITY_INVALID: ${label}不得包含秘密`);
  return normalized;
}

function iso(value, label) {
  const normalized = text(value, label);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`RUNTIME_IDENTITY_INVALID: ${label}无效`);
  return new Date(normalized).toISOString();
}

export function assertSafeRuntimeRecord(value, path = "record") {
  return assertSafeRuntimeRecordInScope(value, path, "production_record");
}

/** Only trusted business transactions call this for the complete candidate aggregate. */
export function assertSafeBusinessMutationCandidate(value, path = "businessMutation.candidate") {
  return assertSafeRuntimeRecordInScope(value, path, "business_candidate");
}

function assertSafeRuntimeRecordInScope(value, path, resourceScope) {
  let projection;
  try {
    const opaquePaths = runtimeSecretInspectionPaths(value);
    projection = normalizeProductionEntities(value, { inspectEntity: (record, { pathSegments }) => {
      const relativePaths = opaquePaths.filter(segments => pathSegments.every((key, index) => segments[index] === key))
        .map(segments => segments.slice(pathSegments.length));
      const entityPath = pathSegments.reduce((current, key) => appendC2DiagnosticPath(current, key), path);
      assertSafeStoredRecordInScope(record.value, entityPath, "production_record", { pathSegments, opaquePaths: relativePaths });
    } });
  } catch (error) {
    if (error instanceof ProductionEntityStorageError && /RESOURCE_LIMIT/.test(error.code ?? error.message) &&
        resourceScope === "business_candidate") {
      throw Object.assign(new Error(BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED), { code: BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED, cause: error });
    }
    if (error instanceof ProductionEntityStorageError) {
      throw new Error(`RUNTIME_IDENTITY_INVALID: ${path}不得保存无效或超限生产实体`, { cause: error });
    }
    throw error;
  }
  assertSafeStoredRecordInScope(projection.value, path, resourceScope);
  for (const record of projection.records) assertSafeStoredProductionEntityRecord(record, `${path}.productionEntity`);
  return value;
}

/**
 * After entity hydration, re-check only the path-sensitive opaque-ID exception.
 * Root and individual records have already passed the ordinary secret scans.
 * This preserves their original declaration context without re-hashing entities.
 */
export function assertRuntimeProductionEntityReferenceContext(value, path = "productionValue") {
  const allowed = new Set(runtimeSecretInspectionPaths(value).map(segments => JSON.stringify(segments)));
  const stack = [{ value, segments: [], path, depth: 0 }];
  let nodes = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      nodes += 1;
      if (nodes > 200000 || current.depth > 128 || nodes + stack.length > 200000) {
        throw new Error(PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED);
      }
      if (typeof current.value === "string") {
        if (isCanonicalC1AuthorizationId(current.value) && !allowed.has(JSON.stringify(current.segments))) {
          assertContextualProductionSecrets(current.value, current.path, current.segments, "production_record");
        }
      } else if (current.value !== null && typeof current.value === "object") {
        for (const key in current.value) {
          if (!Object.hasOwn(current.value, key)) continue;
          if (nodes + stack.length >= 200000) throw new Error(PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED);
          stack.push({ value: current.value[key], segments: [...current.segments, key],
            path: appendC2DiagnosticPath(current.path, key, Array.isArray(current.value)), depth: current.depth + 1 });
        }
      }
    }
  } catch (error) {
    throw new Error(`RUNTIME_IDENTITY_INVALID: ${path}不得在未声明位置保存授权引用`, { cause: error });
  }
  return value;
}

/** Repository read boundary: inspect normalized entity data before hydration. */
export function assertSafeStoredProductionEntityRecord(record, path = "productionEntity") {
  // Preserve the declared secret/reference semantics of a frozen C1 snapshot.
  const entity = record.kind === "final_card_input_snapshot"
    ? { finalCardInputSnapshot: record.value } : record.value;
  assertSafeStoredRecordInScope(entity, path, "production_record");
  return record;
}

function assertContextualProductionSecrets(value, path, pathSegments, resourceScope) {
  const errors = [];
  collectProductionSecretErrors(value, path, errors, pathSegments, resourceScope);
  if (errors.length === 0) return;
  const secrets = errors.filter(error => error.message !== PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED);
  throw new Error(formatC2ReferenceDiagnostic(secrets.length ? "PRODUCTION_AUTHORIZATION_SECRET_REJECTED" : PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
    (secrets.length ? secrets : errors).map(error => error.path), secrets.length ? "secret-rejected" : "resource-limit"));
}

function assertSafeStoredRecordInScope(value, path, resourceScope, context = null) {
  try {
    assertNoRawPersistenceKeys(value, path, { resourceScope });
    if (context) assertContextualProductionSecrets(projectOpaqueAuthorizationPaths(value, context.opaquePaths), path, context.pathSegments, resourceScope);
    else assertNoProductionSecrets(runtimeSecretInspectionProjection(value), path, { resourceScope });
  } catch (error) {
    if (error?.code === BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED) throw error;
    throw new Error(`RUNTIME_IDENTITY_INVALID: ${path}不得保存秘密字段或凭据值`, { cause: error });
  }
  const localReferenceProjections = (entry) => {
    const projections = [entry];
    let current = entry;
    for (let round = 0; round < 3; round += 1) {
      const decoded = current.replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      if (decoded === current) break;
      projections.push(decoded);
      current = decoded;
    }
    return projections;
  };
  const inspectLocalReference = (entry, currentPath) => {
    if (typeof entry === "string") {
      if (localReferenceProjections(entry).some((projection) =>
        /^(?:file:|\/|\\\\|[A-Za-z]:[\\/])/.test(projection) ||
        /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(projection))) {
        throw new Error(`RUNTIME_IDENTITY_INVALID: ${currentPath}不得保存本机路径或回环地址`);
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => inspectLocalReference(item, appendC2DiagnosticPath(currentPath, index, true)));
      return;
    }
    if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) inspectLocalReference(item, appendC2DiagnosticPath(currentPath, key));
    }
  };
  inspectLocalReference(value, path);
  return value;
}

function isPublishedProductionAuthorization(value) {
  return value?.schemaVersion === "production-authorization-v1.1" || value?.schemaVersion === "production-authorization-v1.2";
}

function runtimeSecretInspectionPaths(value, budget = { remaining: 20000 }, depth = 0) {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 128) throw Object.assign(new Error(BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED), { code: BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED });
  const paths = [];
  if (value?.schemaVersion === "software-job-v1" && value.jobType === "c1_ai_draft") {
    paths.push(["scopeBinding", "authorizationRef"], ["admissionDecision", "authorizationRef"]);
  } else if (value?.schemaVersion === "software-job-scope-v1" && value.sideEffectScope === "c1_ai_draft") {
    paths.push(["authorizationRef"]);
  } else if (value?.schemaVersion === "software-job-authorization-record-v1" && value.action === "c1_ai_draft" && value.authorizationType === "paid_ai_draft") {
    paths.push(["authorizationId"], ["scopeBinding", "authorizationRef"]);
  } else if (value?.schemaVersion === "software-job-credential-binding-v1" && value.sideEffectScope === "c1_ai_draft") {
    paths.push(["scopeBinding", "authorizationRef"]);
  } else if (value?.schemaVersion === "software-job-admission-v1" && value.jobType === "c1_ai_draft") {
    paths.push(["authorizationRef"]);
  } else if (value?.schemaVersion === "c1-ai-authorized-execution-v1" && value.jobType === "c1_ai_draft") {
    paths.push(["authorizationRef", "authorizationId"]);
  } else if (value?.schemaVersion === "c1-ai-settled-execution-v1" && value.authorizedExecution?.jobType === "c1_ai_draft") {
    paths.push(["authorizedExecution", "authorizationRef", "authorizationId"]);
  } else if (value?.schemaVersion === "operation-audit-event-v1" && value.action === "c1_ai_draft") {
    paths.push(["authorizationRef"]);
  }
  const authorizationPrefixes = isPublishedProductionAuthorization(value) ? [[]]
    : value?.schemaVersion === "single-owner-production-authorization-result-v1" && value.productionAuthorization?.schemaVersion === "production-authorization-v1.2"
      ? [["productionAuthorization"]]
    : value?.schemaVersion === "production-plan-v1.1" && isPublishedProductionAuthorization(value.sourceAuthorization)
      ? [["sourceAuthorization"]]
      : ["d-software-execution-state-v1","d-software-execution-state-v2"].includes(value?.schemaVersion) && value.productionPlan?.schemaVersion === "production-plan-v1.1" &&
        isPublishedProductionAuthorization(value.productionPlan.sourceAuthorization)
        ? [["productionPlan", "sourceAuthorization"]]
        : value?.schemaVersion === "aliyun-oss-d-asset-integration-v1" && value.productionPlan?.schemaVersion === "production-plan-v1.1" &&
          isPublishedProductionAuthorization(value.productionPlan.sourceAuthorization)
          ? [["productionPlan", "sourceAuthorization"]]
          : value?.schemaVersion === "aliyun-oss-d-asset-state-v1" && value.intent?.schemaVersion === "aliyun-oss-d-asset-integration-v1" &&
            value.intent.productionPlan?.schemaVersion === "production-plan-v1.1" && isPublishedProductionAuthorization(value.intent.productionPlan.sourceAuthorization)
            ? [["intent", "productionPlan", "sourceAuthorization"]] : [];
  // The C1 provider result has two declared locations in the candidate/plan.
  // An arbitrary nested authorizationId never acquires these semantics.
  const planPrefixes = value?.schemaVersion === "c1-product-plan-v1.1" ? [[]]
    : value?.c1ProductPlan?.schemaVersion === "c1-product-plan-v1.1" ? [["c1ProductPlan"]]
    : value?.lifecycleV11?.skuPackage?.c1ProductPlan?.schemaVersion === "c1-product-plan-v1.1"
      ? [["lifecycleV11", "skuPackage", "c1ProductPlan"]] : [];
  for (const prefix of planPrefixes) {
    for (const layer of ["seoEvidenceLayer", "draftOnlySeo"]) paths.push([...prefix, layer, "providerJobRef", "authorizationRef", "authorizationId"]);
    let plan = value;
    for (const segment of prefix) plan = plan[segment];
    if (plan.draftOnlySeo?.pricingReuseRecord?.schemaVersion === "c1-pricing-result-reuse-v1") {
      for (const declaredPath of C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths) {
        if (declaredPath[0] === "frozenC1Handoff" && declaredPath[2] === "pricingReuseRecord") {
          paths.push([...prefix, ...declaredPath.slice(1)]);
        }
      }
    }
  }
  const skuPrefixes = value?.g1Identity?.schemaVersion === "g1-identity-v1" ? [[]]
    : value?.lifecycleV11?.skuPackage?.g1Identity?.schemaVersion === "g1-identity-v1"
      ? [["lifecycleV11", "skuPackage"]] : [];
  for (const prefix of skuPrefixes) {
    for (const rootPrefix of C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimeRootPrefixes) {
      for (const declaredPath of C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths) paths.push([...prefix, ...rootPrefix, ...declaredPath]);
    }
    let sku = value;
    for (const segment of prefix) sku = sku[segment];
    const authorizationContainers = [];
    if (isPublishedProductionAuthorization(sku.productionAuthorization)) authorizationContainers.push(["productionAuthorization"]);
    if (["d-software-execution-state-v1","d-software-execution-state-v2"].includes(sku.dSoftwareExecution?.schemaVersion) &&
        sku.dSoftwareExecution.productionPlan?.schemaVersion === "production-plan-v1.1" &&
        isPublishedProductionAuthorization(sku.dSoftwareExecution.productionPlan.sourceAuthorization)) {
      authorizationContainers.push(["dSoftwareExecution", "productionPlan", "sourceAuthorization"]);
    }
    if (sku.dAssetTransport?.schemaVersion === "aliyun-oss-d-asset-state-v1" &&
        sku.dAssetTransport.intent?.schemaVersion === "aliyun-oss-d-asset-integration-v1" &&
        sku.dAssetTransport.intent.productionPlan?.schemaVersion === "production-plan-v1.1" &&
        isPublishedProductionAuthorization(sku.dAssetTransport.intent.productionPlan.sourceAuthorization)) {
      authorizationContainers.push(["dAssetTransport", "intent", "productionPlan", "sourceAuthorization"]);
    }
    for (const container of authorizationContainers) authorizationPrefixes.push([...prefix, ...container]);
  }
  for (const prefix of authorizationPrefixes) {
    for (const declaredPath of C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths) {
      if (declaredPath[0] === "lockedScope") paths.push([...prefix, ...declaredPath]);
    }
  }
  const histories = ["finalPricingRevisionHistory"]
    .filter(key => Array.isArray(value?.lifecycleV11?.[key]) && value.lifecycleV11[key].length > 0);
  const detachedFinalHistory = value?.schemaVersion === "c1-final-plan-revision-history-v1" &&
    value.previousSkuPackage?.entityType === "SkuLifecyclePackage" && value.previousSkuPackage.g1Identity?.schemaVersion === "g1-identity-v1";
  const present = paths.filter(segments => {
    let current = value;
    for (const key of segments) current = current?.[key];
    return isCanonicalC1AuthorizationId(current);
  });
  if (detachedFinalHistory) {
    for (const segments of runtimeSecretInspectionPaths(value.previousSkuPackage, budget, depth + 1)) present.push(["previousSkuPackage", ...segments]);
  }
  for (const historyKey of histories) {
    const history = value.lifecycleV11[historyKey];
    if (history.length > budget.remaining) throw Object.assign(new Error(BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED), { code: BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED });
    for (let index = 0; index < history.length; index += 1) {
      const historicalSku = history[index]?.previousSkuPackage;
      if (historicalSku?.entityType === "SkuLifecyclePackage" && historicalSku.g1Identity?.schemaVersion === "g1-identity-v1") {
        for (const segments of runtimeSecretInspectionPaths(historicalSku, budget, depth + 1)) {
          present.push(["lifecycleV11", historyKey, String(index), "previousSkuPackage", ...segments]);
        }
      }
    }
  }
  return present;
}

function runtimeSecretInspectionProjection(value) {
  return projectOpaqueAuthorizationPaths(value, runtimeSecretInspectionPaths(value));
}

function projectOpaqueAuthorizationPaths(value, paths) {
  if (paths.length === 0) return value;
  const projected = structuredClone(value);
  for (const segments of paths) {
    let container = projected;
    for (const segment of segments.slice(0, -1)) container = container?.[segment];
    const key = segments.at(-1);
    if (container && isCanonicalC1AuthorizationId(container[key])) container[key] = "approved-c1-authorization-id";
  }
  return projected;
}

export function createActorContext({ userId, sessionId, actorType, roles, source, authenticatedAt }) {
  if (!ACTOR_TYPES.includes(actorType) || !Array.isArray(roles) || roles.length === 0 || roles.some((role) => !USER_ROLES.includes(role))) {
    throw new Error("RUNTIME_IDENTITY_INVALID: actorType或roles无效");
  }
  if (roles.some((role) => !ACTOR_ROLE_COMPATIBILITY[actorType].has(role))) {
    throw new Error("RUNTIME_IDENTITY_INVALID: actorType与roles不兼容");
  }
  return Object.freeze({
    schemaVersion: "actor-context-v1",
    userId: text(userId, "userId"),
    sessionId: text(sessionId, "sessionId"),
    actorType,
    roles: Object.freeze([...new Set(roles)]),
    source: text(source, "source"),
    authenticatedAt: iso(authenticatedAt, "authenticatedAt")
  });
}

export function createLocalDevelopmentActor({ at, userId = "local-development-owner", sessionId = "local-development-session" }) {
  return createActorContext({
    userId,
    sessionId,
    actorType: "human",
    roles: ["owner", "production_authorizer"],
    source: "development_default",
    authenticatedAt: at
  });
}

export function authorizeOperation({ actor, requiredRoles }) {
  if (!actor || actor.schemaVersion !== "actor-context-v1" || !Array.isArray(requiredRoles) || requiredRoles.length === 0 ||
      requiredRoles.some((role) => !USER_ROLES.includes(role))) {
    throw new Error("RUNTIME_AUTHORIZATION_INVALID");
  }
  if (!requiredRoles.some((role) => actor.roles.includes(role))) {
    const error = new Error("RUNTIME_OPERATION_FORBIDDEN");
    error.code = "RUNTIME_OPERATION_FORBIDDEN";
    throw error;
  }
  return Object.freeze({ allowed: true, userId: actor.userId, roles: Object.freeze([...actor.roles]) });
}

export function createOperationAuditEvent({
  eventId,
  action,
  actor,
  workerId = null,
  candidateId,
  skuPackageId,
  sourceRevision,
  resultRevision,
  fromState,
  toState,
  authorizationRef = null,
  externalRequestState = "not_sent",
  externalRequestRef = null,
  idempotencyKey,
  serverTime
}) {
  if (!actor || actor.schemaVersion !== "actor-context-v1") throw new Error("RUNTIME_IDENTITY_INVALID: actor无效");
  if (!Number.isInteger(sourceRevision) || !Number.isInteger(resultRevision) || resultRevision < sourceRevision) {
    throw new Error("RUNTIME_IDENTITY_INVALID: revision范围无效");
  }
  if (!['not_sent', 'failed', 'unknown_outcome', 'succeeded'].includes(externalRequestState)) {
    throw new Error("RUNTIME_IDENTITY_INVALID: externalRequestState无效");
  }
  const event = {
    schemaVersion: "operation-audit-event-v1",
    eventId: text(eventId, "eventId"),
    action: text(action, "action"),
    actor: structuredClone(actor),
    workerId: workerId ? text(workerId, "workerId") : null,
    candidateId: text(candidateId, "candidateId"),
    skuPackageId: text(skuPackageId, "skuPackageId"),
    sourceRevision,
    resultRevision,
    fromState: text(fromState, "fromState"),
    toState: text(toState, "toState"),
    authorizationRef: authorizationRef ? action === "c1_ai_draft" && isCanonicalC1AuthorizationId(authorizationRef)
      ? authorizationRef : text(authorizationRef, "authorizationRef") : null,
    externalRequestState,
    externalRequestRef: externalRequestRef ? text(externalRequestRef, "externalRequestRef") : null,
    idempotencyKey: text(idempotencyKey, "idempotencyKey"),
    serverTime: iso(serverTime, "serverTime")
  };
  assertSafeRuntimeRecord(event, "operationAuditEvent");
  return Object.freeze(event);
}

export function createWorkerDescriptor({ workerId, capabilities, version, status = "online", observedAt }) {
  if (!Array.isArray(capabilities) || capabilities.some((capability) => !WORKER_CAPABILITIES.includes(capability))) {
    throw new Error("RUNTIME_IDENTITY_INVALID: capabilities无效");
  }
  if (!['online', 'offline', 'busy', 'blocked'].includes(status)) throw new Error("RUNTIME_IDENTITY_INVALID: worker status无效");
  return Object.freeze({
    schemaVersion: "worker-descriptor-v1",
    workerId: text(workerId, "workerId"),
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    version: text(version, "version"),
    status,
    observedAt: iso(observedAt, "observedAt")
  });
}

export function workerSatisfiesCapabilities(worker, requiredCapabilities) {
  if (!worker || !Array.isArray(worker.capabilities) || !Array.isArray(requiredCapabilities)) return false;
  const available = new Set(worker.capabilities);
  return requiredCapabilities.every((capability) => WORKER_CAPABILITIES.includes(capability) && available.has(capability));
}
