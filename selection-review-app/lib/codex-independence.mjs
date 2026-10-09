export const CODEX_OFFLINE_MODE = "CODEX_OFFLINE";
export const NORMAL_PRODUCTION_PATH = "normal_production";
export const EXCEPTION_MAINTENANCE_PATH = "exception_case_maintenance";
export const NORMAL_PRODUCTION_CODEX_DEPENDENCY_ERROR = "Normal production path attempted Codex dependency.";

export const NORMAL_PRODUCTION_CODEX_DEPENDENCY_TYPES = Object.freeze([
  "dispatch",
  "wait",
  "queue_consumer",
  "api",
  "browser",
  "stage_advance",
  "result_required"
]);

export const SOFTWARE_LIFECYCLE_AUDIT_PHASES = Object.freeze(["A", "B", "C1", "C2", "D", "E"]);

export const CODEX_INDEPENDENCE_INVARIANTS = Object.freeze({
  normalProductionPath: NORMAL_PRODUCTION_PATH,
  offlineMode: CODEX_OFFLINE_MODE,
  normalProductionCodexDependencyCount: 0,
  exceptionCaseIsNormalProduction: false,
  exceptionCaseMayAdvanceBusinessStage: false,
  exceptionCaseMaySupplyRequiredBusinessResult: false,
  softwareCompleteRequiresZeroCodexDependencies: true
});

export const CURRENT_CODEX_INDEPENDENCE_AUDIT = Object.freeze([
  Object.freeze({
    phase: "A",
    completionStatus: "not_complete",
    executionAudit: Object.freeze({
      nextStepTrigger: "candidate_created_or_owner_a_card_submission",
      inputProducer: "selection_review_service_from_saved_sales_and_supply_evidence",
      externalExecutor: "official_connectors_and_controlled_local_worker",
      aiExecutor: "ai_gateway_4318_terra_optional",
      resultWriter: "business_state_repository",
      continuationAuthority: "owner_a_decision_then_software_state_machine",
      codexOfflineCanComplete: false,
      residualDependency: "automatic_discovery_plan_and_formal_market_supplier_search_connectors",
      dependencyClass: "normal_production_dependency"
    }),
    codexDependencies: Object.freeze([]),
    evidenceRefs: Object.freeze([
      "lib/real-a-b-evidence-orchestration.mjs",
      "extension/1688-capture/background.js",
      "lib/a-stage-terra-gateway.mjs"
    ])
  }),
  Object.freeze({
    phase: "B",
    completionStatus: "software_complete",
    executionAudit: Object.freeze({
      nextStepTrigger: "accepted_a_confirmation_transaction",
      inputProducer: "selection_review_service_from_frozen_a_and_current_evidence_packs",
      externalExecutor: "none_during_profit_calculation",
      aiExecutor: "none",
      resultWriter: "business_state_repository",
      continuationAuthority: "deterministic_profit_rule_then_atomic_c1_handoff",
      codexOfflineCanComplete: true,
      residualDependency: null,
      dependencyClass: "development_maintenance_only"
    }),
    codexDependencies: Object.freeze([]),
    evidenceRefs: Object.freeze([
      "lib/real-a-b-c1-flow.mjs",
      "lib/real-a-b-evidence-orchestration.mjs"
    ])
  }),
  Object.freeze({
    phase: "C1",
    completionStatus: "not_complete",
    executionAudit: Object.freeze({
      nextStepTrigger: "b_handoff_auto_produces_planning_evidence_when_saved_source_record_is_ready",
      inputProducer: "selection_review_service_from_frozen_c1_facts_and_saved_keyword_source_record",
      externalExecutor: "seerfar_connector_software_job",
      aiExecutor: "ai_gateway_4318_terra_or_preapproved_sol",
      resultWriter: "business_state_repository",
      continuationAuthority: "configured_keyword_service_then_saved_evidence_to_separately_authorized_ai_draft",
      codexOfflineCanComplete: false,
      residualDependency: "planning_source_collection_and_real_provider_runtime_acceptance",
      dependencyClass: "normal_production_dependency"
    }),
    codexDependencies: Object.freeze([
      Object.freeze({
        type: "stage_advance",
        required: true,
        evidenceRef: "lib/c1-keyword-planning-source-resolver.mjs: normal planning source collection is not implemented; maintenance must not supply business evidence"
      })
    ]),
    evidenceRefs: Object.freeze([
      "lib/c1-keyword-planning-software-use-case.mjs",
      "lib/c1-keyword-planning-source-resolver.mjs",
      "server.mjs:continueC1SoftwareWhenEvidenceReady"
    ])
  }),
  Object.freeze({
    phase: "C2",
    completionStatus: "software_complete",
    executionAudit: Object.freeze({
      nextStepTrigger: "c1_draft_ready_then_owner_final_asset_confirmation",
      inputProducer: "selection_review_service_from_c1_and_three_asset_regions",
      externalExecutor: "approved_asset_transport_only_when_needed",
      aiExecutor: "none_in_current_c2",
      resultWriter: "business_state_repository",
      continuationAuthority: "owner_final_asset_confirmation_then_software",
      codexOfflineCanComplete: true,
      residualDependency: null,
      dependencyClass: "development_maintenance_only"
    }),
    codexDependencies: Object.freeze([]),
    evidenceRefs: Object.freeze([
      "lib/c2-software-orchestrator.mjs",
      "server.mjs:/lifecycle/c2/final-assets"
    ])
  }),
  Object.freeze({
    phase: "D",
    completionStatus: "not_complete",
    executionAudit: Object.freeze({
      nextStepTrigger: "owner_production_authorization",
      inputProducer: "selection_review_service_from_production_authorization_only",
      externalExecutor: "ozon_seller_api_adapter_not_wired_to_server_runtime",
      aiExecutor: "none",
      resultWriter: "production_record_only_after_exact_platform_receipts",
      continuationAuthority: "software_adapter_contract_exists_but_runtime_route_is_missing",
      codexOfflineCanComplete: false,
      residualDependency: "seller_api_execution_and_receipt_persistence_not_runtime_wired",
      dependencyClass: "normal_production_dependency"
    }),
    codexDependencies: Object.freeze([
      Object.freeze({
        type: "api",
        required: true,
        evidenceRef: "lib/d-e-software-integration.mjs exposes readiness but server has no Seller API execution route"
      })
    ]),
    evidenceRefs: Object.freeze([])
  }),
  Object.freeze({
    phase: "E",
    completionStatus: "not_complete",
    executionAudit: Object.freeze({
      nextStepTrigger: "production_record_or_external_listing_record",
      inputProducer: "selection_review_service_from_platform_identity",
      externalExecutor: "independent_platform_readback_not_runtime_wired",
      aiExecutor: "none",
      resultWriter: "business_state_repository_after_exact_readback",
      continuationAuthority: "software_verification_rule_but_current_route_accepts_caller_observation",
      codexOfflineCanComplete: false,
      residualDependency: "independent_readback_producer_not_runtime_wired",
      dependencyClass: "normal_production_dependency"
    }),
    codexDependencies: Object.freeze([
      Object.freeze({
        type: "result_required",
        required: true,
        evidenceRef: "server.mjs:/lifecycle/e-readback still accepts caller-supplied verifiedObservation"
      })
    ]),
    evidenceRefs: Object.freeze([])
  })
]);

const DEPENDENCY_TYPES = new Set(NORMAL_PRODUCTION_CODEX_DEPENDENCY_TYPES);
const PHASES = new Set(SOFTWARE_LIFECYCLE_AUDIT_PHASES);
const COMPLETION_STATUSES = new Set(["software_complete", "not_complete"]);
const EXCEPTION_ACTIONS = new Set(["diagnose", "inspect", "repair_code", "verify_recovery"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function validateDependency(dependency, path) {
  if (!isObject(dependency) || !DEPENDENCY_TYPES.has(dependency.type) ||
      typeof dependency.required !== "boolean" || !nonEmpty(dependency.evidenceRef)) {
    throw new Error(`CODEX_INDEPENDENCE_DEPENDENCY_INVALID:${path}`);
  }
  return dependency;
}

function activeDependencies(dependencies, path) {
  if (!Array.isArray(dependencies)) throw new Error(`CODEX_INDEPENDENCE_DEPENDENCIES_INVALID:${path}`);
  return dependencies
    .map((dependency, index) => validateDependency(dependency, `${path}[${index}]`))
    .filter((dependency) => dependency.required === true);
}

function dependencyError(dependency, phase = null) {
  const error = new Error(`${NORMAL_PRODUCTION_CODEX_DEPENDENCY_ERROR} type=${dependency.type}${phase ? ` phase=${phase}` : ""}`);
  error.code = "NORMAL_PRODUCTION_CODEX_DEPENDENCY_FORBIDDEN";
  error.dependencyType = dependency.type;
  error.phase = phase;
  return error;
}

export function codexOfflineModeFromEnvironment(environment = process.env) {
  return String(environment?.CODEX_OFFLINE || "").trim().toLowerCase() === "true";
}

function explicitSwitchEnabled(value) {
  return ["on", "true"].includes(String(value || "").trim().toLowerCase());
}

/**
 * 旧Codex派发通道的唯一开关判定：只校验环境变量，不调度、不写数据。
 * 只有在没有开启CODEX_OFFLINE、且派发开关与自动投递开关都显式打开时才允许派发。
 */
export function dispatchDeliveryEnabledFromEnvironment(environment = process.env) {
  if (codexOfflineModeFromEnvironment(environment)) return false;
  return explicitSwitchEnabled(environment?.SELECTION_REVIEW_CODEX_DISPATCH) &&
    explicitSwitchEnabled(environment?.SELECTION_REVIEW_AUTO_DELIVER);
}

export function assertRuntimeCodexDependencyAllowed({
  codexOffline,
  pathType,
  skuPackageId,
  dependencyType,
  evidenceRef
}) {
  if (typeof codexOffline !== "boolean" || !nonEmpty(pathType) || !nonEmpty(dependencyType) || !nonEmpty(evidenceRef)) {
    throw new Error("CODEX_INDEPENDENCE_RUNTIME_GUARD_INPUT_INVALID");
  }
  if (!codexOffline || pathType === EXCEPTION_MAINTENANCE_PATH) {
    return freeze({ allowed: true, pathType, codexOffline });
  }
  return assertNormalProductionCodexIndependent({
    executionMode: CODEX_OFFLINE_MODE,
    pathType,
    skuPackageId,
    codexDependencies: [{ type: dependencyType, required: true, evidenceRef }]
  });
}

/**
 * 正常生产路径的离线门禁。此函数只校验，不调度、不等待、不访问浏览器或API。
 */
export function assertNormalProductionCodexIndependent({
  executionMode,
  pathType,
  skuPackageId,
  codexDependencies
}) {
  if (executionMode !== CODEX_OFFLINE_MODE || pathType !== NORMAL_PRODUCTION_PATH || !nonEmpty(skuPackageId)) {
    throw new Error("CODEX_INDEPENDENCE_NORMAL_PATH_INPUT_INVALID");
  }
  const active = activeDependencies(codexDependencies, "codexDependencies");
  if (active.length > 0) throw dependencyError(active[0]);
  return freeze({
    status: "independent",
    executionMode,
    pathType,
    skuPackageId,
    activeCodexDependencies: 0,
    businessAdvanceAuthority: "software_state_machine"
  });
}

/**
 * ExceptionCase只能承载诊断/维护；它不属于正常生产，也不能产出业务推进或必需业务结果。
 */
export function assertExceptionCaseMaintenanceBoundary({
  pathType,
  exceptionCaseId,
  action,
  advancesBusinessStage = false,
  suppliesRequiredBusinessResult = false
}) {
  if (pathType !== EXCEPTION_MAINTENANCE_PATH || !nonEmpty(exceptionCaseId) || !EXCEPTION_ACTIONS.has(action) ||
      typeof advancesBusinessStage !== "boolean" || typeof suppliesRequiredBusinessResult !== "boolean") {
    throw new Error("CODEX_INDEPENDENCE_EXCEPTION_CASE_INPUT_INVALID");
  }
  if (advancesBusinessStage || suppliesRequiredBusinessResult) {
    throw new Error("CODEX_INDEPENDENCE_EXCEPTION_CASE_BUSINESS_SUBSTITUTION_FORBIDDEN");
  }
  return freeze({
    status: "maintenance_only",
    pathType,
    exceptionCaseId,
    action,
    normalProductionPath: false,
    advancesBusinessStage: false,
    suppliesRequiredBusinessResult: false
  });
}

/**
 * 校验A→B→C1→C2→D→E各阶段的软件独立性审计清单。
 * 阶段可保留为not_complete，但有任何Codex残余依赖时不得标记software_complete。
 */
export function validateSoftwareLifecycleCodexIndependenceAudit({
  executionMode,
  skuPackageId,
  phases
}) {
  if (executionMode !== CODEX_OFFLINE_MODE || !nonEmpty(skuPackageId) || !Array.isArray(phases) ||
      phases.length !== SOFTWARE_LIFECYCLE_AUDIT_PHASES.length) {
    throw new Error("CODEX_INDEPENDENCE_AUDIT_INPUT_INVALID");
  }
  const seen = new Set();
  const normalized = phases.map((entry, index) => {
    if (!isObject(entry) || !PHASES.has(entry.phase) || seen.has(entry.phase) ||
        !COMPLETION_STATUSES.has(entry.completionStatus) || !Array.isArray(entry.evidenceRefs) ||
        entry.evidenceRefs.some((ref) => !nonEmpty(ref))) {
      throw new Error(`CODEX_INDEPENDENCE_AUDIT_PHASE_INVALID:${index}`);
    }
    seen.add(entry.phase);
    const active = activeDependencies(entry.codexDependencies, `phases[${index}].codexDependencies`);
    if (entry.completionStatus === "software_complete" && active.length > 0) {
      throw dependencyError(active[0], entry.phase);
    }
    if (entry.completionStatus === "software_complete" && entry.evidenceRefs.length === 0) {
      throw new Error(`CODEX_INDEPENDENCE_AUDIT_EVIDENCE_REQUIRED:${entry.phase}`);
    }
    return {
      phase: entry.phase,
      completionStatus: entry.completionStatus,
      activeCodexDependencies: active.map((dependency) => ({
        type: dependency.type,
        evidenceRef: dependency.evidenceRef
      })),
      evidenceRefs: [...entry.evidenceRefs]
    };
  });
  if (SOFTWARE_LIFECYCLE_AUDIT_PHASES.some((phase) => !seen.has(phase))) {
    throw new Error("CODEX_INDEPENDENCE_AUDIT_PHASE_SET_INCOMPLETE");
  }
  normalized.sort((left, right) => SOFTWARE_LIFECYCLE_AUDIT_PHASES.indexOf(left.phase) - SOFTWARE_LIFECYCLE_AUDIT_PHASES.indexOf(right.phase));
  const incomplete = normalized.filter((entry) => entry.completionStatus !== "software_complete");
  return freeze({
    status: incomplete.length === 0 ? "software_complete" : "not_complete",
    executionMode,
    skuPackageId,
    normalProductionCodexDependencyCount: normalized.reduce((sum, entry) => sum + entry.activeCodexDependencies.length, 0),
    phases: normalized,
    incompletePhases: incomplete.map((entry) => entry.phase)
  });
}
