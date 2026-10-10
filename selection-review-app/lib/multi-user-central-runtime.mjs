import {
  assertBusinessStateRepositoryBoundary,
  assertCentralPersistenceBoundary
} from "./business-state-repository.mjs";
import { assertIdentityProviderBoundary } from "./runtime-identity-provider.mjs";
import { assertWorkerRegistryBoundary } from "./worker-registry.mjs";

export const MULTI_USER_RUNTIME_ERROR = "Local machine dependency entered production domain.";
export const CENTRAL_TRUTH_ERROR = "Production state has no central persistence boundary.";

export const MULTI_USER_CENTRAL_RUNTIME_INVARIANTS = Object.freeze({
  centralServiceIsBusinessAuthority: true,
  browserIsBusinessAuthority: false,
  localWorkerIsBusinessAuthority: false,
  codexIsBusinessAuthority: false,
  workerMayAdvanceLifecycle: false,
  revisionRequiredForBusinessMutation: true,
  idempotencyRequiredForExternalSideEffect: true,
  workerLeaseRequiredForLocalCapability: true,
  secretsStoredInBusinessRecord: false,
  localDevelopmentRemainsSupported: true
});

export const RUNTIME_SECRET_BOUNDARIES = Object.freeze({
  centralService: Object.freeze([
    "ai_model_api_key", "ozon_seller_api_credential", "oss_credential",
    "database_credential", "seerfar_open_api_token"
  ]),
  localWorker: Object.freeze([
    "browser_cookie", "browser_login_state", "local_vpn_credential", "local_certificate"
  ]),
  businessRecordMayContain: Object.freeze([
    "capability_name", "login_validity", "sanitized_failure_class", "safe_evidence_ref"
  ])
});

export const MULTI_USER_MIGRATION_STAGES = Object.freeze([
  Object.freeze({ order: 1, code: "single_machine_single_user", label: "单机单用户闭环" }),
  Object.freeze({ order: 2, code: "single_machine_multi_identity", label: "单机多身份模拟" }),
  Object.freeze({ order: 3, code: "central_test_service", label: "中央测试服务" }),
  Object.freeze({ order: 4, code: "two_user_pilot", label: "两人试用" }),
  Object.freeze({ order: 5, code: "postgres_migration", label: "PostgreSQL只读导入演练与切换" }),
  Object.freeze({ order: 6, code: "multi_worker", label: "多Worker" }),
  Object.freeze({ order: 7, code: "internal_team_launch", label: "三到五人内部上线" })
]);

export const LOCAL_RUNTIME_LOCK_IN_AUDIT = Object.freeze([
  ["localhost_and_fixed_ports", "development_local_reasonable", "运行配置已提供替换边界；本地继续使用4317及配置化服务端口"],
  ["macos_keychain", "development_local_reasonable", "本机密钥已改走按操作系统选择的凭据层（macOS 钥匙串、Windows 凭据管理器、Linux Secret Service），钥匙串名称不变；未来中央秘密管理替换"],
  ["json_state_file", "must_abstract_before_multi_user", "已建立Repository边界；当前适配器明确仅单进程"],
  ["whole_json_rewrite", "must_abstract_before_multi_user", "原子改名防半文件，不防多实例丢失更新"],
  ["in_memory_job_maps", "must_abstract_before_multi_user", "中央队列前不得宣称多Worker可用"],
  ["single_extension_heartbeat", "must_abstract_before_multi_user", "未来由Worker注册表和能力声明替换"],
  ["global_single_job_gate", "must_abstract_before_multi_user", "未来收敛为同SKU唯一和Worker租约"],
  ["missing_user_identity", "minimum_fix_now", "新契约必须记录具体userId与角色"],
  ["missing_worker_identity", "minimum_fix_now", "新作业必须绑定workerId、能力和租约"],
  ["hardcoded_ai_gateway_scope", "minimum_fix_now", "端点与安全策略移入运行配置"],
  ["fixed_local_paths", "must_abstract_before_multi_user", "只允许本地适配器或已禁用历史路径"],
  ["local_clock_as_authority", "must_abstract_before_multi_user", "新作业时间由中央服务时钟写入"],
  ["file_hash_as_concurrency", "development_local_reasonable", "哈希只用于检测意外损坏，不作并发控制"],
  ["service_restart_recovery", "development_local_reasonable", "已有unknown_outcome收口；中央队列后再验证多实例恢复"],
  ["central_and_local_secrets", "minimum_fix_now", "中央API秘密与本机Cookie/VPN能力必须分开"]
].map(([assumption, classification, disposition]) => Object.freeze({ assumption, classification, disposition })));

const FORBIDDEN_PRODUCTION_STATE_LOCATIONS = new Set([
  "react_memory", "browser_local_storage", "plugin_storage", "worker_temp_file", "codex_conversation"
]);

export function assertProductionStatePersistence({ stateType, persistenceBoundary }) {
  if (!stateType || FORBIDDEN_PRODUCTION_STATE_LOCATIONS.has(persistenceBoundary) || persistenceBoundary !== "central_repository") {
    const error = new Error(CENTRAL_TRUTH_ERROR);
    error.code = "CENTRAL_PERSISTENCE_BOUNDARY_REQUIRED";
    throw error;
  }
  return Object.freeze({ status: "centrally_persisted", stateType, persistenceBoundary });
}

export function assertProductionStateRepository({ runtimeMode, repository }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode)) {
    throw new Error("MULTI_USER_RUNTIME_MODE_INVALID");
  }
  const boundary = runtimeMode === "local_development"
    ? assertBusinessStateRepositoryBoundary(repository)
    : assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    status: runtimeMode === "local_development" ? "local_repository_boundary_present" : "central_repository_boundary_present",
    ...boundary
  });
}

const LOCAL_DEPENDENCY_PATTERNS = Object.freeze([
  { rule: "loopback_address", pattern: /(?:127\.0\.0\.1|localhost|\[?::1\]?)/g },
  { rule: "personal_home_path", pattern: /\/Users\/[^/'"\s]+(?:\/|\b)/g },
  { rule: "dynamic_home_dependency", pattern: /(?:os\.homedir\(\)|process\.env\.HOME)/g },
  { rule: "fixed_worker_identity", pattern: /(?:fixed-worker|only-worker|first-connected-worker)/g }
]);

export function findLocalMachineDependencies(sourceText) {
  const source = String(sourceText ?? "");
  return LOCAL_DEPENDENCY_PATTERNS.flatMap(({ rule, pattern }) => {
    const matches = source.match(pattern) || [];
    return matches.map((value) => Object.freeze({ rule, value }));
  });
}

export function assertNoUnreviewedLocalMachineDependency({
  filePath,
  sourceText,
  boundary = "domain",
  reviewedFindingCounts = null,
  allowedInfrastructureFile = false
}) {
  const findings = findLocalMachineDependencies(sourceText);
  if (allowedInfrastructureFile) {
    throw new Error(`${MULTI_USER_RUNTIME_ERROR} broad infrastructure allowlist is forbidden`);
  }
  if (!["domain", "application", "local_adapter", "worker_adapter"].includes(boundary)) {
    throw new Error("MULTI_USER_RUNTIME_BOUNDARY_INVALID");
  }
  const actualCounts = Object.fromEntries([...new Set(findings.map((item) => item.rule))].map((rule) => [
    rule,
    findings.filter((item) => item.rule === rule).length
  ]));
  const reviewed = reviewedFindingCounts && typeof reviewedFindingCounts === "object" ? reviewedFindingCounts : {};
  const exactReview = ["local_adapter", "worker_adapter"].includes(boundary) &&
    JSON.stringify(actualCounts, Object.keys(actualCounts).sort()) === JSON.stringify(reviewed, Object.keys(reviewed).sort());
  if (findings.length > 0 && !exactReview) {
    const error = new Error(`${MULTI_USER_RUNTIME_ERROR} file=${String(filePath || "unknown")} rule=${findings[0].rule}`);
    error.code = "LOCAL_MACHINE_DEPENDENCY_FORBIDDEN";
    error.findings = findings;
    throw error;
  }
  return Object.freeze({
    status: findings.length > 0 ? "reviewed_local_adapter" : "portable",
    boundary,
    findings
  });
}

export function assertRuntimeBoundaries({
  configuration,
  businessStateRepository,
  identityProvider,
  softwareJobStore,
  workerRegistry,
  legacyBusinessMutationPathsPresent = true
}) {
  if (!configuration || configuration.schemaVersion !== "selection-review-runtime-configuration-v1") {
    throw new Error("MULTI_USER_RUNTIME_CONFIGURATION_INVALID");
  }
  const repository = assertProductionStateRepository({
    runtimeMode: configuration.deploymentMode,
    repository: businessStateRepository
  });
  const identity = assertIdentityProviderBoundary(identityProvider);
  const workers = assertWorkerRegistryBoundary(workerRegistry);
  if (!softwareJobStore || softwareJobStore.boundaryType !== "software_job_store") {
    throw new Error("SOFTWARE_JOB_STORE_BOUNDARY_REQUIRED");
  }
  const centralMode = configuration.deploymentMode !== "local_development";
  if (centralMode && (
    identity.multiUserReady !== true || softwareJobStore.multiUserReady !== true || workers.multiUserReady !== true ||
    legacyBusinessMutationPathsPresent === true
  )) {
    const error = new Error("MULTI_USER_CENTRAL_RUNTIME_NOT_READY");
    error.code = "MULTI_USER_CENTRAL_RUNTIME_NOT_READY";
    throw error;
  }
  const limitations = centralMode ? [] : [
    "JSON状态适配器仅支持单进程事务",
    "开发默认身份不等于正式团队登录",
    "本机Worker注册表重启后不保留",
    "旧业务写路由尚未全部迁移到统一事务入口"
  ];
  return Object.freeze({
    schemaVersion: "runtime-architecture-status-v1",
    status: centralMode ? "central_runtime_ready" : "local_development_ready",
    deploymentMode: configuration.deploymentMode,
    businessAuthority: "selection_review_service",
    stateAdapter: repository.adapter,
    concurrencyScope: repository.concurrencyScope,
    identityProvider: identity.providerType,
    softwareJobStore: softwareJobStore.persistenceClass,
    workerRegistry: workers.persistenceClass,
    multiUserReady: centralMode,
    limitations: Object.freeze(limitations)
  });
}
