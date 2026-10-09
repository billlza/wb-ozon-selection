/**
 * 三店能力注册表。
 *
 * 这里只记录代码能力、关系和可追溯证据，不保存候选、SKU、授权或平台结果。
 * 正常业务状态仍以生命周期 Repository 和正式回执为准。
 */

export const CAPABILITY_REGISTRY_VERSION = "three-store-capability-registry-v3";

export const CAPABILITY_SNAPSHOT_VERSION = "three-store-capability-snapshot-v2";

export const CAPABILITY_HEALTH_STATES = Object.freeze({
  verified: Object.freeze({
    label: "已验证可用",
    shortLabel: "已验证",
    tone: "verified",
    description: "声明范围内的代码、接线和验证记录与当前源码一致；不自动扩大为真实平台闭环。"
  }),
  unverified: Object.freeze({
    label: "已实现但未验证",
    shortLabel: "待验证",
    tone: "unverified",
    description: "代码或接线存在，但没有与当前源码匹配的有效验证记录。"
  }),
  risk: Object.freeze({
    label: "可用但有风险",
    shortLabel: "有风险",
    tone: "risk",
    description: "能力已有可用证据，但存在明确局限、低置信度或技术债。"
  }),
  blocked: Object.freeze({
    label: "当前阻塞",
    shortLabel: "已阻塞",
    tone: "blocked",
    description: "存在已知断点，当前路线不能继续。"
  })
});

export const REGISTRATION_STATES = Object.freeze({
  official: "正式能力",
  candidate: "待验收能力",
  legacy: "历史兼容",
  simulation: "模拟或培训",
  experimental: "实验",
  unknown: "尚未归类",
  duplicate: "疑似重复",
  retiring: "退役候选"
});

export const INTEGRATION_STATES = Object.freeze({
  connected: "已接通",
  partial: "部分接通",
  disconnected: "尚未接通",
  isolated: "已隔离",
  not_implemented: "尚未实现"
});

export const VERIFICATION_STATES = Object.freeze({
  current_source_verified: "当前源码已验证",
  test_files_present_not_run: "有测试文件但本轮未运行",
  source_changed_revalidation_required: "源码变化后待重新验证",
  non_blocking_risk: "存在非阻塞风险",
  blocked: "当前阻塞",
  unknown: "证据未知"
});

export const RUNTIME_SCOPES = Object.freeze({
  pure_domain: "纯规则或领域代码",
  local_development: "本地开发",
  simulation_adapter: "模拟适配器",
  external_read_only: "真实外部只读",
  external_paid_call: "真实付费调用",
  external_service_write: "外部素材存储写入",
  platform_write: "真实平台写入",
  independent_readback: "写后独立回读",
  current_runtime: "当前运行副本",
  central_runtime: "中央运行",
  not_available: "当前不存在运行实现"
});

export const MAINLINE_QUALIFICATIONS = Object.freeze({
  normal_mainline: "正常主线",
  exception_branch: "异常处理支路",
  historical_compatibility: "历史兼容支路",
  simulation: "模拟",
  engineering_support: "工程辅助",
  owner_decision: "待主人决定"
});

export const SIDE_EFFECT_TYPES = Object.freeze({
  none: "不产生副作用",
  local_save: "产生本地保存",
  external_read_only: "访问外部只读来源",
  paid_call: "产生付费调用",
  external_asset_write: "写入外部素材存储",
  platform_write: "写入销售平台"
});

export const CAPABILITY_RELATION_KINDS = Object.freeze({
  normal: "正常先后",
  optional: "按条件进入",
  parallel: "并行分支",
  merge: "等待汇合",
  human_gate: "等待主人确认",
  loop: "补齐后返回",
  exception: "异常停机",
  recovery: "维护后返回",
  reference_only: "只供参考",
  planned: "尚未接通"
});

function freezeList(value = []) {
  return Object.freeze([...value]);
}

const VERIFICATION_BY_HEALTH = Object.freeze({
  verified: "current_source_verified",
  unverified: "test_files_present_not_run",
  risk: "non_blocking_risk",
  blocked: "blocked"
});

const RUNTIME_SCOPES_BY_LEGACY_SCOPE = Object.freeze({
  local_development: Object.freeze(["local_development"]),
  controlled_local_browser: Object.freeze(["local_development", "external_read_only"]),
  ai_gateway: Object.freeze(["local_development", "external_paid_call"]),
  external_paid_api: Object.freeze(["local_development", "external_paid_call"]),
  external_platform_write: Object.freeze(["local_development", "platform_write"]),
  external_platform_read: Object.freeze(["local_development", "external_read_only", "independent_readback"]),
  not_available: Object.freeze(["not_available"])
});

const SIDE_EFFECTS_BY_CAPABILITY_ID = Object.freeze({
  "1.1": ["local_save"], "1.2": ["local_save"], "1.3": ["local_save"], "1.4": ["local_save"],
  "1.5": ["none"], "2.1": ["local_save"], "2.2": ["external_read_only", "local_save"],
  "2.3": ["external_read_only", "local_save"], "2.4": ["local_save"], "2.5": ["paid_call", "local_save"],
  "2.6": ["none"], "2.7": ["local_save"], "2.8": ["local_save"], "3.1": ["none"],
  "3.2": ["external_read_only", "local_save"], "3.3": ["external_read_only", "local_save"],
  "3.4": ["local_save"], "3.5": ["local_save"], "3.6": ["local_save"], "4.1": ["local_save"],
  "4.2": ["local_save"], "4.3": ["local_save"], "4.4": ["external_read_only", "paid_call", "local_save"],
  "4.5": ["local_save"], "4.6": ["paid_call", "local_save"], "4.7": ["local_save"],
  "5.1": ["local_save"], "5.2": ["local_save"], "5.3": ["local_save"], "5.4": ["local_save"],
  "5.5": ["local_save"], "6.1": ["local_save"], "6.2": ["local_save"], "6.3": ["none"],
  "6.4": ["local_save"], "6.5": ["external_asset_write", "local_save"],
  "6.6": ["platform_write", "local_save"], "6.7": ["local_save"], "6.8": ["platform_write"],
  "7.1": ["local_save"], "7.2": ["external_read_only"], "7.3": ["local_save"],
  "7.4": ["external_read_only"], "8.1": ["local_save"], "8.2": ["local_save"],
  "8.3": ["local_save"], "8.4": ["none"], "8.5": ["local_save"], "8.6": ["none"]
});

const UNPLACED_DETAILS_BY_ID = Object.freeze({
  "9.1": Object.freeze({
    inputs: ["历史 workflow-map 配置", "候选旧状态和留言"],
    outputs: ["M01—M12 历史节点投影", "旧派发与恢复目标"],
    calledBy: ["server.mjs 的旧 workflow-map、留言、恢复和派发路由"],
    calls: ["lib/workflow-map.mjs", "历史 dispatch 数据"],
    sideEffects: ["local_save"], uiConnectionStatus: "历史 UI/API 仍有入口"
  }),
  "9.2": Object.freeze({
    inputs: ["旧派发记录", "候选快照和固定负责人路由"],
    outputs: ["Codex 任务轮次或明确派发失败", "旧 dispatch 回写"],
    calledBy: ["server.mjs 的历史派发与恢复路径"],
    calls: ["lib/codex-dispatcher.mjs", "本机 Codex 任务接口"],
    sideEffects: ["local_save"], uiConnectionStatus: "旧状态仍会显示，正常主线禁止使用"
  }),
  "9.3": Object.freeze({
    inputs: ["固定演示输入", "模拟确认选择"],
    outputs: ["隔离的 A→B→C1 演示结果"],
    calledBy: ["Phase2ASimulation.jsx 和模拟 API"],
    calls: ["lib/phase-2a-simulation.mjs"],
    sideEffects: ["none"], uiConnectionStatus: "独立模拟入口"
  }),
  "9.4": Object.freeze({
    inputs: ["历史候选、特殊 SKU 或手工 C1 输入"],
    outputs: ["旧 C1/C2 准备结果或历史审计信息"],
    calledBy: ["server.mjs 的旧 C 阶段兼容路由和相关测试"],
    calls: ["lib/real-c1-preparation.mjs", "lib/lifecycle-c-stage.mjs"],
    sideEffects: ["local_save"], uiConnectionStatus: "部分旧详情入口仍可见"
  }),
  "9.5": Object.freeze({
    inputs: ["阶段源码清单和构建参数"],
    outputs: ["阶段部署包、清单和偶然损坏检测摘要"],
    calledBy: ["开发者手工执行的 build-phase 脚本和边界测试"],
    calls: ["文件系统和项目构建工具"],
    sideEffects: ["local_save"], uiConnectionStatus: "不进入业务 UI"
  }),
  "9.6": Object.freeze({
    inputs: ["本机源码、依赖和启动配置"],
    outputs: ["本地开发服务、4317 运行副本或浏览器入口"],
    calledBy: ["主人或开发者手工启动、构建、部署"],
    calls: ["Vite、Node、本机 LaunchAgent 和文件复制"],
    sideEffects: ["local_save"], uiConnectionStatus: "只提供本机入口"
  }),
  "9.7": Object.freeze({
    inputs: ["生产计划、授权、平台能力或观察结果"],
    outputs: ["多套候选 D/E 请求、回执或能力判断"],
    calledBy: ["D/E 领域组合代码和各自测试；没有唯一正式服务端入口"],
    calls: ["候选 Ozon 适配器、历史策略和草稿执行"],
    sideEffects: ["platform_write"], uiConnectionStatus: "只展示准备度，未接正式执行"
  }),
  "9.8": Object.freeze({
    inputs: ["旧候选记录"],
    outputs: ["保持 unknown 的只读 OpportunityPackage 投影"],
    calledBy: ["生命周期入口预览和评审台详情"],
    calls: ["lib/legacy-candidate-adapter.mjs"],
    sideEffects: ["none"], uiConnectionStatus: "只读展示已接 UI"
  }),
  "9.9": Object.freeze({
    inputs: ["旧候选状态、主人手工上架或回读输入"],
    outputs: ["旧扁平 workflow 状态、手工上架标记或人工回读记录"],
    calledBy: ["server.mjs、src/api.js 和旧评审台动作"],
    calls: ["lib/workflow.mjs 和本地候选 JSON"],
    sideEffects: ["local_save"], uiConnectionStatus: "部分旧按钮或 API 表面仍存在"
  }),
  "9.10": Object.freeze({
    inputs: ["启动期安全运行事实和旧静态节点定义"],
    outputs: ["14 节点只读三店地图草稿"],
    calledBy: ["主源码 /api/three-store-map 与 ThreeStoreMap.jsx"],
    calls: ["lib/three-store-map.mjs"],
    sideEffects: ["none"], uiConnectionStatus: "主源码有入口；4317 实测没有对应 API"
  }),
  "9.11": Object.freeze({
    inputs: ["与 server.mjs 相似的本地服务输入"],
    outputs: ["另一份未被 package 启动脚本调用的服务实现"],
    calledBy: ["未发现正式调用方"],
    calls: ["历史候选、派发和本地数据模块"],
    sideEffects: ["local_save"], uiConnectionStatus: "未接 UI"
  }),
  "9.12": Object.freeze({
    inputs: ["历史候选 JSON 和一次性人工参数"],
    outputs: ["迁移、归一化、回填或特殊 SKU 标记"],
    calledBy: ["开发者曾经手工执行；没有业务运行调用方"],
    calls: ["本地业务数据文件"],
    sideEffects: ["local_save"], uiConnectionStatus: "不进入 UI"
  }),
  "9.13": Object.freeze({
    inputs: ["Ozon D/E 环境能力和只读客户端"],
    outputs: ["只读能力探测结果"],
    calledBy: ["仅测试文件；未发现 server 或 UI 调用"],
    calls: ["lib/ozon-de-readonly-capability-probe.mjs"],
    sideEffects: ["external_read_only"], uiConnectionStatus: "未接 UI"
  }),
  "9.14": Object.freeze({
    inputs: ["A 冻结输入、费用证据和利润配置"],
    outputs: ["另一套 B 结果和 C1 交接对象"],
    calledBy: ["仅测试文件；未发现 server 或 UI 调用"],
    calls: [],
    sideEffects: ["none"], uiConnectionStatus: "未接 UI"
  })
});

const UNPLACED_MAINLINE_BY_ID = Object.freeze({
  "9.1": "historical_compatibility", "9.2": "historical_compatibility", "9.3": "simulation",
  "9.4": "historical_compatibility", "9.5": "engineering_support", "9.6": "engineering_support",
  "9.7": "owner_decision", "9.8": "historical_compatibility", "9.9": "historical_compatibility",
  "9.10": "engineering_support", "9.11": "owner_decision", "9.12": "historical_compatibility",
  "9.13": "engineering_support", "9.14": "owner_decision"
});

const UNPLACED_RUNTIME_SCOPES_BY_ID = Object.freeze({
  "9.1": ["local_development", "current_runtime"],
  "9.2": ["local_development", "current_runtime"],
  "9.3": ["simulation_adapter", "local_development", "current_runtime"],
  "9.4": ["local_development", "current_runtime"],
  "9.5": ["local_development"], "9.6": ["local_development", "current_runtime"],
  "9.7": ["local_development", "platform_write", "independent_readback"],
  "9.8": ["local_development", "current_runtime"], "9.9": ["local_development", "current_runtime"],
  "9.10": ["local_development"], "9.11": ["local_development"], "9.12": ["local_development"],
  "9.13": ["local_development", "external_read_only"], "9.14": ["pure_domain", "local_development"]
});

export function capabilityRef(path, anchor, label = anchor) {
  return Object.freeze({ path, anchor, label });
}

function area(id, title, summary, x, y) {
  return Object.freeze({ id, title, summary, overviewPosition: Object.freeze({ x, y }) });
}

function capability(definition) {
  const registrationState = definition.registrationState ?? "official";
  const integrationStatus = definition.integrationStatus ?? "disconnected";
  const flowClass = definition.flowClass ?? "normal";
  const baselineHealth = definition.baselineHealth ?? { state: "unverified", reason: "当前验证证据未知。" };
  if (!Object.hasOwn(CAPABILITY_HEALTH_STATES, baselineHealth.state)) throw new Error(`CAPABILITY_HEALTH_INVALID:${definition.id}`);
  const mainlineQualification = definition.mainlineQualification ?? (
    flowClass === "exception" ? "exception_branch" : "normal_mainline"
  );
  const legacyRuntimeScope = definition.runtimeScope ?? "local_development";
  const verificationStatus = definition.verificationStatus ?? VERIFICATION_BY_HEALTH[baselineHealth.state] ?? "unknown";
  const normalPathAllowed = definition.normalPathAllowed ?? (
    mainlineQualification === "normal_mainline" &&
    registrationState === "official" &&
    ["connected", "partial"].includes(integrationStatus) &&
    verificationStatus !== "blocked"
  );
  return Object.freeze({
    registrationState,
    identityState: registrationState,
    flowClass,
    mainlineQualification,
    normalPathAllowed,
    integrationStatus,
    wiringStatus: integrationStatus,
    runtimeScope: legacyRuntimeScope,
    runtimeScopes: freezeList(definition.runtimeScopes ?? RUNTIME_SCOPES_BY_LEGACY_SCOPE[legacyRuntimeScope] ?? ["not_available"]),
    verificationStatus,
    sideEffects: freezeList(definition.sideEffects ?? SIDE_EFFECTS_BY_CAPABILITY_ID[definition.id] ?? ["none"]),
    uiConnectionStatus: definition.uiConnectionStatus ?? ((definition.uiRefs?.length ?? 0) > 0 ? "present_in_main_source" : "not_in_main_ui"),
    realExecutionEvidence: Object.freeze({
      status: definition.realExecutionEvidence?.status ?? "unknown",
      note: definition.realExecutionEvidence?.note ?? "未找到与当前源码快照绑定的真实执行回执；运行副本对象只在冻结快照中单独说明。",
      refs: freezeList(definition.realExecutionEvidence?.refs)
    }),
    uiRole: "read_only_status",
    ownerAction: "正常情况下无需主人额外操作。",
    stopConditions: "输入、身份、revision 或必要证据不完整时停止。",
    codexRule: "正常流程不得依赖 Codex。",
    knownRisk: null,
    aliases: freezeList(),
    codeRefs: freezeList(),
    uiRefs: freezeList(),
    testRefs: freezeList(),
    artifactRefs: freezeList(),
    ...definition,
    inputs: freezeList(definition.inputs),
    outputs: freezeList(definition.outputs),
    aliases: freezeList(definition.aliases),
    codeRefs: freezeList(definition.codeRefs),
    uiRefs: freezeList(definition.uiRefs),
    testRefs: freezeList(definition.testRefs),
    artifactRefs: freezeList(definition.artifactRefs),
    position: Object.freeze({ ...definition.position }),
    baselineHealth: Object.freeze({ ...baselineHealth })
  });
}

function relation(definition) {
  const health = definition.health ?? { state: "unverified", reason: "当前连接验证证据未知。" };
  const normalPathAllowed = definition.normalPathAllowed ?? (
    ["normal", "optional", "parallel", "merge", "human_gate"].includes(definition.kind) &&
    health.state !== "blocked"
  );
  return Object.freeze({
    normalPathAllowed,
    ...definition,
    verificationStatus: definition.verificationStatus ?? VERIFICATION_BY_HEALTH[health.state] ?? "unknown",
    health: Object.freeze({ ...health })
  });
}

function unplaced(definition) {
  const legacyStatusMap = {
    awaiting_placement: "unknown",
    temporarily_retained: "legacy",
    suspected_duplicate: "duplicate",
    retirement_candidate: "retiring"
  };
  const identityState = definition.identityState ?? legacyStatusMap[definition.status] ?? "unknown";
  const details = UNPLACED_DETAILS_BY_ID[definition.id] ?? {};
  return Object.freeze({
    ownerDecisionRequired: true,
    resolutionStatus: "unresolved",
    identityState,
    wiringStatus: definition.wiringStatus ?? "isolated",
    verificationStatus: definition.verificationStatus ?? "unknown",
    runtimeScopes: freezeList(definition.runtimeScopes ?? UNPLACED_RUNTIME_SCOPES_BY_ID[definition.id] ?? ["local_development"]),
    mainlineQualification: definition.mainlineQualification ?? UNPLACED_MAINLINE_BY_ID[definition.id] ?? "owner_decision",
    inputs: freezeList(definition.inputs ?? details.inputs),
    outputs: freezeList(definition.outputs ?? details.outputs),
    calledBy: freezeList(definition.calledBy ?? details.calledBy),
    calls: freezeList(definition.calls ?? details.calls),
    sideEffects: freezeList(definition.sideEffects ?? details.sideEffects ?? ["none"]),
    uiConnectionStatus: definition.uiConnectionStatus ?? details.uiConnectionStatus ?? "未验证",
    evidenceRefs: freezeList(),
    artifactRefs: freezeList(),
    candidateTargets: freezeList(),
    missingEvidence: freezeList(),
    ...definition,
    evidenceRefs: freezeList(definition.evidenceRefs),
    artifactRefs: freezeList(definition.artifactRefs),
    candidateTargets: freezeList(definition.candidateTargets),
    missingEvidence: freezeList(definition.missingEvidence)
  });
}

function overlapMember(definition) {
  return Object.freeze({
    inputs: freezeList(definition.inputs),
    outputs: freezeList(definition.outputs),
    calledBy: freezeList(definition.calledBy),
    testRefs: freezeList(definition.testRefs),
    uiStatus: definition.uiStatus ?? "未接 UI",
    runtimePresence: definition.runtimePresence ?? "以冻结快照逐文件判定",
    ...definition,
    inputs: freezeList(definition.inputs),
    outputs: freezeList(definition.outputs),
    calledBy: freezeList(definition.calledBy),
    testRefs: freezeList(definition.testRefs)
  });
}

function overlapGroup(definition) {
  return Object.freeze({
    currentPrimary: null,
    ownerDecisionRequired: true,
    resolutionStatus: "unresolved",
    ...definition,
    members: Object.freeze(definition.members.map(overlapMember)),
    possibleMainlinePositions: freezeList(definition.possibleMainlinePositions),
    missingEvidence: freezeList(definition.missingEvidence),
    ownerDecision: definition.ownerDecision
  });
}

function artifactAssignment(id, title, ownerIds, reason, paths) {
  return Object.freeze({
    id,
    title,
    ownerIds: freezeList(ownerIds),
    reason,
    paths: freezeList(paths)
  });
}

export const CAPABILITY_AREAS = Object.freeze([
  area("1", "运行底座与状态保存", "保存候选、revision、作业和当前本地运行边界。", 60, 260),
  area("2", "A：市场、供货与主人确认", "收集可追溯证据，并由主人锁定准确供应 SKU。", 350, 80),
  area("3", "B：完整成本与利润", "并行取得费用证据，汇合后计算正式利润并交给 C1。", 640, 80),
  area("4", "C1：商品事实、关键词与 SEO", "准备事实、Schema、关键词证据和只读草稿。", 930, 80),
  area("5", "C2：最终素材与最终方案", "隔离参考、草稿和主人确认的最终素材。", 1220, 80),
  area("6", "D：授权与平台执行", "授权后才准备写店；当前真实执行仍有断点。", 1510, 80),
  area("7", "E：独立平台回读", "重新读取平台结果，而不是相信写入请求成功。", 1800, 80),
  area("8", "异常维护与中央运行", "已知失败由软件停机，Codex 只处理真正未知异常。", 930, 500)
]);

export const CAPABILITY_NODES = Object.freeze([
  capability({
    id: "1.1", capabilityId: "runtime.candidate-state", areaId: "1",
    title: "保存候选和当前修订号", technicalName: "BusinessStateRepository",
    plainDescription: "把候选和当前版本保存下来，页面刷新后仍能读到同一份本地状态。",
    serves: "评审台、软件状态机和所有后续阶段",
    inputs: ["主人或软件提交的候选资料", "当前 dataRevision"],
    outputs: ["带修订号的候选记录", "评审台可读取的状态快照"],
    integrationStatus: "connected", uiRole: "owner_input",
    baselineHealth: { state: "unverified", reason: "本地 Repository 与评审台已接线；本轮尚无匹配当前源码的验证回执。" },
    stopConditions: "读取或保存失败时必须显示技术错误，不能变成空候选或假成功。",
    breakpoint: "当前是单进程 JSON 本地开发适配器，不是中央多人状态。",
    nextStep: "保持 Repository 边界，后续替换为中央持久化。",
    position: { x: 60, y: 180 },
    codeRefs: [capabilityRef("lib/business-state-repository.mjs", "createConfiguredBusinessStateRepository", "业务状态 Repository"),
      capabilityRef("lib/production-entity-storage.mjs", "normalizeProductionEntities", "冻结生产资料集中保存")],
    uiRefs: [capabilityRef("src/App.jsx", "function App", "评审台读取状态")],
    testRefs: [capabilityRef("tests/business-state-repository.test.mjs", "test(", "Repository 测试"),
      capabilityRef("tests/production-entity-storage.test.mjs", "test(", "生产资料引用与恢复测试"),
      capabilityRef("tests/production-entity-persistence.test.mjs", "test(", "生产资料原子保存与重启测试")],
    artifactRefs: ["lib/atomic-json-persistence.mjs", "server.mjs", "lib/runtime-health.mjs",
      "lib/runtime-health-worker.mjs", "tests/runtime-health.test.mjs", "tests/runtime-health-api.test.mjs",
      "tests/fixtures/runtime-readiness-history-fixture.mjs"]
  }),
  capability({
    id: "1.2", capabilityId: "runtime.atomic-mutation", areaId: "1",
    title: "原子保存一次业务变化", technicalName: "BusinessMutationTransaction",
    plainDescription: "把状态变化、结果引用和新的 revision 一次保存，避免只写一半。",
    serves: "A 到 E 的所有状态推进",
    inputs: ["sourceRevision", "本次领域变化和结果引用"],
    outputs: ["resultRevision", "完整保存或明确冲突"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "原子事务代码存在；当前完整回归结果尚未重新记录。" },
    stopConditions: "revision 不一致或保存失败时整次拒绝，不允许部分成功。",
    breakpoint: "JSON 原子改名不能解决多进程并发。",
    nextStep: "中央化时由数据库事务和并发控制替换。",
    position: { x: 360, y: 180 },
    codeRefs: [capabilityRef("lib/business-mutation-transaction.mjs", "executeBusinessMutation", "业务原子事务")],
    testRefs: [capabilityRef("tests/business-mutation-transaction.test.mjs", "test(", "原子事务测试"), capabilityRef("tests/business-candidate-capacity.test.mjs", "test(", "候选聚合容量与安全边界")],
    artifactRefs: ["lib/product-lifecycle-schema.mjs", "schema/product-lifecycle-v1.1.schema.json"]
  }),
  capability({
    id: "1.3", capabilityId: "runtime.software-jobs", areaId: "1",
    title: "保存一次软件作业", technicalName: "SoftwareJobStore",
    plainDescription: "为一次明确的软件动作保存对象、revision、attempt 和最终结果，避免重复执行。",
    serves: "需要异步执行的正式软件步骤",
    inputs: ["当前对象身份和 revision", "一次性作业计划"],
    outputs: ["持久化 SoftwareJob", "完成、失败或 unknown_outcome"],
    integrationStatus: "partial",
    baselineHealth: { state: "risk", reason: "通用作业合同和本地存储存在，但 C1 付费关键词等能力尚未全部迁入。" },
    stopConditions: "相同幂等键不能创建第二个作业；结果未知时禁止自动重发。",
    breakpoint: "部分阶段仍使用候选局部状态或旧入口。",
    nextStep: "把 C1、D、E 的正式作业逐步迁入同一作业边界。",
    position: { x: 660, y: 180 },
    codeRefs: [capabilityRef("lib/software-job-repository.mjs", "createRepositoryBackedSoftwareJobStore", "软件作业存储")],
    testRefs: [capabilityRef("tests/software-job-repository.test.mjs", "test(", "作业存储测试")],
    artifactRefs: ["lib/software-job-contract.mjs", "schema/software-job-v1.schema.json", "schema/software-job-v2.schema.json"]
  }),
  capability({
    id: "1.4", capabilityId: "runtime.identity-worker", areaId: "1",
    title: "识别操作者和受控 Worker", technicalName: "RuntimeIdentity / WorkerRegistry",
    plainDescription: "记录谁在操作、Worker 会什么，并限制它只能领取匹配的作业。",
    serves: "未来多人协作、浏览器 Worker 和高风险授权",
    inputs: ["操作者身份与角色", "Worker ID、能力和心跳"],
    outputs: ["授权判断", "可领取作业的受控 Worker"],
    integrationStatus: "partial", runtimeScope: "local_development",
    baselineHealth: { state: "risk", reason: "本地身份和 Worker 注册表存在，但没有中央身份、租约和多机验收。" },
    stopConditions: "身份、角色、能力或心跳不满足时不得领取或执行。",
    breakpoint: "本地主人认证已接入可替换提供器；中央身份与多Worker尚未接通。",
    nextStep: "完成中央身份、租约与店铺范围能力。",
    position: { x: 960, y: 180 },
    codeRefs: [
      capabilityRef("lib/runtime-identity.mjs", "createActorContext", "运行身份"),
      capabilityRef("lib/worker-registry.mjs", "createLocalDevelopmentWorkerRegistry", "本地 Worker 注册表")
    ],
    uiRefs: [capabilityRef("src/components/HeaderStatus.jsx", "HeaderStatus", "顶栏那一个状态指示器：运行方式、插件、采集控制三条合成一条")],
    testRefs: [capabilityRef("tests/runtime-identity-software-job.test.mjs", "test(", "身份与作业测试")],
    artifactRefs: ["lib/runtime-identity-provider.mjs", "lib/runtime-configuration.mjs", "lib/local-owner-identity.mjs",
      "src/components/LocalOwnerAccessPanel.jsx", "src/ownerAccess.js", "src/runtimeArchitectureView.js", "src/headerStatusView.js"]
  }),
  capability({
    id: "1.5", capabilityId: "presentation.review-desk", areaId: "1",
    title: "把当前商品和交接情况展示给主人", technicalName: "Selection review application shell",
    plainDescription: "评审台读取已经保存的候选和派生状态，展示进度、断点和主人入口；页面本身不决定业务结果。",
    serves: "主人查看具体商品、提交明确决定并发现当前卡点",
    inputs: ["服务端返回的候选状态", "只读运行状态和派生视图"],
    outputs: ["今日选品评审台页面", "主人明确提交的单次操作请求"],
    integrationStatus: "connected", uiRole: "owner_entry",
    mainlineQualification: "engineering_support", normalPathAllowed: false,
    verificationStatus: "source_changed_revalidation_required",
    baselineHealth: { state: "unverified", reason: "主源码 UI 入口完整，但与 4317 运行副本内容不同，本轮未做 UI 行为验证。" },
    ownerAction: "主人从这里查看和提交决定；页面按钮、卡片或文字不等于后台能力已执行。",
    stopConditions: "服务端读取失败时显示失败，不能伪装成没有候选。",
    breakpoint: "主源码和当前 4317 运行副本存在差异，运行副本没有新的能力地图 API。",
    nextStep: "能力快照对账完成后，再由独立施工轮决定如何让 UI 读取同一注册表。",
    position: { x: 1260, y: 180 },
    codeRefs: [capabilityRef("src/App.jsx", "function App", "评审台应用外壳"), capabilityRef("src/api.js", "const api", "前端 API 表面")],
    uiRefs: [capabilityRef("src/components/CandidateRail.jsx", "CandidateRail", "候选列表"), capabilityRef("src/components/CandidateDetail.jsx", "CandidateDetail", "候选详情")],
    testRefs: [capabilityRef("tests/candidateViews.test.mjs", "test(", "评审台派生视图测试"),
      capabilityRef("tests/candidate-rights-compliance-ui.test.mjs", "test(", "权利与合规证据显示测试"),
      capabilityRef("tests/header-status-view.test.mjs", "test(", "顶栏只剩位置、店铺和一个状态指示器，三条状态里任意一条异常都要说出来")],
    artifactRefs: ["src/main.jsx", "src/styles.css", "index.html"]
  }),

  capability({
    id: "2.1", capabilityId: "selection.a.candidate-entry", areaId: "2",
    title: "接收一个商品方向", technicalName: "Candidate entry",
    plainDescription: "把主人给的商品链接或软件找到的方向变成一个可追踪候选，但不自动判定通过。",
    serves: "A 阶段市场与供货核实",
    inputs: ["目标店铺", "商品或供应链接，或明确批准的有限发现计划"],
    outputs: ["A 阶段候选", "需要补齐的证据范围"],
    integrationStatus: "connected", uiRole: "owner_input",
    baselineHealth: { state: "unverified", reason: "添加候选入口存在；本轮未重新验证完整行为。" },
    ownerAction: "主人可以添加商品或批准有限搜索计划；仅保存计划不查询、不扣费。",
    stopConditions: "目标店铺或链接无效时拒绝保存。",
    breakpoint: "历史候选仍需只读适配，不能冒充新版完整输入。",
    nextStep: "按已有证据决定是否需要销售或供应采集。",
    position: { x: 60, y: 220 },
    codeRefs: [capabilityRef("server.mjs", "pathname === \"/api/candidates\"", "候选保存入口"),
      capabilityRef("lib/a-discovery-runtime-services.mjs", "createADiscoveryRuntimeServices", "有限主动发现作业"),
      capabilityRef("lib/a-discovery-candidate-import.mjs", "createADiscoveryCandidateImportUseCase", "发现材料原子进入A")],
    uiRefs: [capabilityRef("src/components/AddCandidateModal.jsx", "AddCandidateModal", "添加候选界面"),
      capabilityRef("src/components/ProductDiscoveryCard.jsx", "ProductDiscoveryCard", "有限查询确认与结果"),
      capabilityRef("src/components/SelectionDesk.jsx", "SelectionDesk", "选品台首页与右栏"),
      capabilityRef("src/components/PipelineBoard.jsx", "PipelineBoard", "进行中五列看板"),
      capabilityRef("src/components/OwnerInbox.jsx", "OwnerInbox", "需要主人处理清单"),
      capabilityRef("src/components/EliminateControl.jsx", "EliminateControl", "各列表通用的淘汰确认与已淘汰恢复"),
      capabilityRef("src/components/ProductPage.jsx", "ProductPage", "商品页六步与找货填写")],
    testRefs: [capabilityRef("tests/collaboration-api.test.mjs", "test(", "候选 API 测试")]
  }),
  capability({
    id: "2.2", capabilityId: "selection.a.ozon-sales-capture", areaId: "2",
    title: "读取 Ozon 当前销售证据", technicalName: "Ozon sales capture",
    plainDescription: "主人发起一次只读采集，扩展读取当前 Ozon 商品页并返回脱敏价格、图片和卖家证据。",
    serves: "A 阶段市场判断",
    inputs: ["单次采集请求", "当前 Ozon 商品页和本机登录态"],
    outputs: ["SalesSnapshot 所需证据", "明确的失败分类"],
    integrationStatus: "partial", runtimeScope: "controlled_local_browser", uiRole: "owner_input",
    baselineHealth: { state: "risk", reason: "代码与本机桥接存在，但当前真实页面、登录态和跨机器能力未验证。" },
    ownerAction: "只有需要当前页面证据时由主人主动发起一次。",
    stopConditions: "登录、验证、商品身份、价格或页面解析失败时停止，不能写成零结果。",
    breakpoint: "尚未成为中央可租约 Worker。",
    nextStep: "将登录有效性、能力和回执接入正式 Worker 作业。",
    position: { x: 360, y: 60 },
    codeRefs: [capabilityRef("lib/ozon-sales-capture.mjs", "sanitizeOzonCaptureEvidence", "Ozon 证据脱敏"),
      capabilityRef("lib/ozon-page-capture-job.mjs", "ozonCapturePageTarget", "读哪一个 Ozon 页面：只认候选已保存的地址，判不出就停"),
      capabilityRef("lib/ozon-page-capture-job.mjs", "ozonCapturePageJobPayload", "插件领取这次读页面时拿到的作业形状"),
      capabilityRef("lib/ozon-category-read-step.mjs", "buildOzonCategoryReadStep", "类目是不是真实页面读来的，不是就挡住算利润并给出出路")],
    uiRefs: [capabilityRef("src/App.jsx", "startOzonSalesCapture", "评审台采集桥接"),
      capabilityRef("src/App.jsx", "readOzonProductPage", "商品页发起读页面：排队回执之后必须发开始信号"),
      capabilityRef("src/captureStart.js", "OZON_PAGE_READ_CHANNEL", "开始信号按消息类型参数化，1688 与 Ozon 共用同一条实现"),
      capabilityRef("src/components/ProductPage.jsx", "OzonCategoryReadBlock", "确认按钮之前的那一小块：为什么要读、读一次做什么")],
    testRefs: [capabilityRef("tests/ozon-sales-capture-api.test.mjs", "test(", "Ozon 采集 API 测试"),
      capabilityRef("tests/ozon-page-capture-job.test.mjs", "test(", "读页面作业形状与插件契约的对照基准"),
      capabilityRef("tests/ozon-extension-collector.test.mjs", "test(", "真实商品页三个价并存时按标签认价的回归基准"),
      capabilityRef("tests/ozon-category-read-step.test.mjs", "test(", "类目判定、文案与页面契约的基准")],
    artifactRefs: ["extension/1688-capture/collector-ozon.js", "extension/1688-capture/bridge.js", "extension/1688-capture/background.js",
      "tests/fixtures/ozon-price-widget-fixture.mjs", "tests/helpers/ozon-page-dom.mjs"]
  }),
  capability({
    id: "2.3", capabilityId: "selection.a.supplier-capture", areaId: "2",
    title: "读取 1688 供应 SKU", technicalName: "1688 source capture",
    plainDescription: "主人发起一次只读采集，扩展读取精确商品和真实 SKU，不自动替主人选择。",
    serves: "A 阶段供货方案",
    inputs: ["单次采集请求", "1688 精确商品页和本机登录态"],
    outputs: ["SupplierOption 和 SKU 证据", "等待主人选择或明确失败"],
    integrationStatus: "partial", runtimeScope: "controlled_local_browser", uiRole: "owner_input",
    baselineHealth: { state: "risk", reason: "详情采集链保留；图搜已补正式作业合同，页面执行器与浏览器能力未核验，默认禁止发起。尚未作为中央 Worker 验收。" },
    ownerAction: "主人确认要读取当前供应页后发起；采集成功后仍必须回到确认卡。",
    stopConditions: "短链未解析、页面身份不一致、登录失效或字段不足时停止。",
    breakpoint: "采集成功只代表取得证据，不代表供货方案已确认。",
    nextStep: "回到 2.6/2.7，由主人锁定准确 SKU。",
    position: { x: 360, y: 380 },
    aliases: ["旧 2.2"],
    codeRefs: [capabilityRef("lib/source-capture.mjs", "sanitize1688Evidence", "1688 证据脱敏"),
      capabilityRef("lib/sku-choice-estimate.mjs", "buildSkuChoiceTable", "每个规格按自己的重量算运费与利润"),
      capabilityRef("lib/sku-choice-estimate.mjs", "buildOwnerSkuUniformSupplyRecord", "同重同价声明：主人自己对某一次采集签字，缺的重量货价才按他在找货里填的算，软件永远不自己借"),
      capabilityRef("lib/sku-choice-estimate.mjs", "readSkuUniformSupplyDeclaration", "签的字只对那一次采集有效，重新采过之后自动失效，采到的真实值永远优先"),
      capabilityRef("lib/a-supplier-image-search-contract.mjs", "assertASupplierImageSearchScope", "单次图搜合同"),
      capabilityRef("lib/a-supplier-image-search-runner.mjs", "runASupplierImageSearchSoftwareJob", "图搜受控执行边界"),
      capabilityRef("lib/a-supplier-image-search-runtime-services.mjs", "supplierImageSearchAvailability", "图搜未配置门禁")],
    uiRefs: [capabilityRef("src/App.jsx", "startSourceCapture", "评审台采集桥接"),
      capabilityRef("src/components/ProductPage.jsx", "skuChoiceReady", "商品页的选规格一步"),
      capabilityRef("src/components/ProductPage.jsx", "skuUniformSupplyNotice", "同重同价那一个按钮，以及表里标出「你填的」")],
    testRefs: [capabilityRef("tests/sku-choice-estimate.test.mjs", "test(", "每个规格按自己重量计价的校验基准"),
      capabilityRef("tests/source-capture-job-api.test.mjs", "test(", "1688 作业 API 测试"),
      capabilityRef("tests/source-capture-inline-context.test.mjs", "test(", "1688 内联 context 页面采集回归测试"),
      capabilityRef("tests/pinduoduo-capture.test.mjs", "test(", "拼多多链接识别、页面读取与回传核验测试"),
      capabilityRef("tests/source-capture-review-api.test.mjs", "test(", "结果未知记录的主人核实出口测试"),
      capabilityRef("tests/source-capture-recapture-api.test.mjs", "test(", "已采到之后重新读一次同一个1688页面的出口测试"),
      capabilityRef("tests/a-supplier-image-search-contract.test.mjs", "test(", "图搜合同测试"),
      capabilityRef("tests/a-supplier-image-search-runner.test.mjs", "test(", "图搜执行边界测试"),
      capabilityRef("tests/a-supplier-image-search-runtime-services.test.mjs", "test(", "图搜配置门禁测试"),
      capabilityRef("tests/a-supplier-image-search-api.test.mjs", "test(", "图搜未配置API测试")],
    artifactRefs: ["extension/1688-capture/collector.js", "extension/1688-capture/collector-pinduoduo.js", "scripts/check-pinduoduo-saved-page.mjs", "extension/1688-capture/capture-request.js", "extension/1688-capture/source-routing.js", "extension/1688-capture/manifest.json",
      "schema/a-supplier-image-search-v1.schema.json", "tests/a-supplier-image-search-store.test.mjs", "tests/helpers/a-supplier-image-search-fixture.mjs",
      "tests/fixtures/a-supplier-1688-inline-context-fixture.mjs"]
  }),
  capability({
    id: "2.4", capabilityId: "selection.a.evidence-assembly", areaId: "2",
    title: "整理市场和供应证据", technicalName: "SalesSnapshot / SupplierOption",
    plainDescription: "把销售样本、供应 SKU、价格、重量尺寸和来源整理成可比较、可追溯的数据。",
    serves: "A 确认卡和后续 B 利润",
    inputs: ["销售采集或已有销售证据", "供应采集或主人提供的供应数据"],
    outputs: ["市场判断", "SupplierOption 和字段缺口"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "领域整理与校验代码存在；当前源码对应的验证回执未记录。" },
    stopConditions: "同款身份、来源或关键字段无法确定时保持 unknown。",
    breakpoint: "外部证据是否当前有效仍依赖具体来源。",
    nextStep: "生成同一张 A 阶段确认卡。",
    position: { x: 700, y: 220 },
    codeRefs: [
      capabilityRef("lib/market-sample-policy.mjs", "assessAStageMarket", "市场样本判断"),
      capabilityRef("lib/a-sample-review-use-case.mjs", "createASampleReviewUseCase", "主人复核哪几个对标算数，据此重算市场判定"),
      capabilityRef("lib/supplier-option.mjs", "adapt1688CaptureToSupplierOption", "供应证据转换"),
      capabilityRef("lib/a-product-detail-runtime-services.mjs", "createAProductDetailRuntimeServices", "独立许可下的双详情作业"),
      capabilityRef("lib/a-product-detail-application.mjs", "createAProductDetailApplicationUseCase", "双回执原子更新原A卡"),
      capabilityRef("lib/a-product-detail-evidence.mjs", "readAProductDetailSupplierEvidence", "有明确API来源的商品事实")
    ],
    uiRefs: [capabilityRef("src/components/ProductDetailPreparationCard.jsx", "ProductDetailPreparationCard", "当前商品详情许可和回执")],
    testRefs: [capabilityRef("tests/supplier-option.test.mjs", "test(", "供应证据测试")],
    artifactRefs: ["lib/sales-snapshot.mjs", "lib/supplier-selection-flow.mjs", "schema/sales-snapshot-v1.1.schema.json", "schema/supplier-option-v1.1.schema.json", "schema/a-market-assessment-v1.1.schema.json"]
  }),
  capability({
    id: "2.5", capabilityId: "selection.a.ai-assist", areaId: "2",
    title: "让 AI 帮忙整理 A 阶段材料", technicalName: "AStageTerraGateway",
    plainDescription: "把已经取得的证据交给正式 AI 网关整理成建议，结果仍要由规则和主人核实。",
    serves: "A 阶段评审辅助",
    inputs: ["已保存的候选和销售证据", "正式 AI 作业身份"],
    outputs: ["待核验的整理建议", "AI 回执或明确失败"],
    integrationStatus: "partial", flowClass: "normal", runtimeScope: "ai_gateway",
    baselineHealth: { state: "unverified", reason: "网关合同和调用代码存在；本轮未验证 4318 当前可用性。" },
    ownerAction: "主人不需要为普通建议逐次操作；建议不能替代供货确认。",
    stopConditions: "网关、Schema 或回执失败时停止，不自动换模型。",
    breakpoint: "真实网关可用性未验证。",
    nextStep: "将建议展示在 A 确认卡中供主人判断。",
    position: { x: 980, y: 40 },
    codeRefs: [capabilityRef("lib/a-stage-terra-gateway.mjs", "runAStageTerraAssist", "A 阶段 AI 网关")],
    testRefs: [capabilityRef("tests/a-stage-terra-gateway.test.mjs", "test(", "A 阶段网关测试")]
  }),
  capability({
    id: "2.6", capabilityId: "selection.a.confirmation-card", areaId: "2",
    title: "把供货方案放进一张确认卡", technicalName: "RealAConfirmationCard",
    plainDescription: "把市场、链接、SKU、价格、运费、成本、重量和尺寸放在一起，让主人一次看清。",
    serves: "主人最终供货判断",
    inputs: ["整理后的销售和供应证据", "字段缺口和可选 AI 建议"],
    outputs: ["可提交的 A 确认卡", "明确待补字段"],
    integrationStatus: "connected", uiRole: "owner_confirmation",
    baselineHealth: { state: "unverified", reason: "确认卡和服务端校验已接入；本轮未重新验证。" },
    ownerAction: "主人在同一张卡确认或淘汰，不需要重复确认。",
    stopConditions: "精确 SKU、实际成本、重量尺寸或来源不完整时不能提交通过。",
    breakpoint: "外部证据缺失时仍需回到受控采集。",
    nextStep: "等待主人在 2.7 做最终供货决定。",
    position: { x: 980, y: 250 },
    aliases: ["旧 2.1"],
    codeRefs: [capabilityRef("lib/real-a-confirmation-card.mjs", "buildRealAConfirmationCard", "A 确认卡"),
      capabilityRef("lib/profit-step-review.mjs", "buildProfitStepReview", "算利润：整套核线、指定先上的一个、其余排队"),
      capabilityRef("lib/profit-step-review.mjs", "profitStepSubmission", "用已保存的资料把确认组装齐，缺一样就不组装"),
      capabilityRef("lib/cargo-facts-declaration.mjs", "proposeCargoFacts", "运输属性：只按已有采集证据提议，判不定的如实交给主人选"),
      capabilityRef("lib/cargo-facts-declaration.mjs", "buildOwnerCargoFactsRecord", "存档写明主人确认及软件当时的依据"),
      capabilityRef("lib/extra-handling-fees.mjs", "buildOwnerExtraHandlingFeesRecord", "每单额外操作费：主人自己写名目和金额，合计由各行算出来，空清单就是明确声明的 ¥0.00"),
      capabilityRef("lib/extra-handling-fees.mjs", "extraHandlingFeesConsistency", "明细各行之和必须等于权威总额 packagingCostRmb；只有总额没有明细是历史数据，不是错"),
      capabilityRef("lib/extra-handling-fees.mjs", "extraHandlingFeeAssumptions", "算钱用这件货自己声明的那个数，没声明时是 ¥0 且带着「没签过字」的标记"),
      capabilityRef("lib/profit-step-review.mjs", "extraHandlingBreakPoint", "这笔费用涨到多少这个规格才掉出本店利润线，按该规格自己的利润和门槛现算"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "exactCommissionUnavailable", "认出「店里还没有这条类目的商品，精确佣金读不到」这一类失败：新旧两代证据服务的说法都认"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "officialCommissionTableGaps", "服务端说的官方佣金表缺口逐字捡出来，没说就不造一句"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "commissionEstimateProposal", "替代费率整份取自已解析的官方费率表结果，缺一样就不提议"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "buildCommissionEstimateSignal", "把这一次确认停在哪存成事实：是不是这一类、官方表缺口逐字、落盘之后的修订号"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "buildCommissionEstimateStep", "那一块整份由服务端从已保存的记录构建，主人硬刷新之后它还在"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "buildEstimatedCommissionNoticeStep", "「这件的佣金还是估算的」那一块，跟着商品走到上架之前的每一屏")],
    uiRefs: [capabilityRef("src/components/RealAConfirmationCard.jsx", "RealAConfirmationCard", "确认卡 UI"),
      capabilityRef("src/components/ProductPage.jsx", "profitStepOpen", "商品页的算利润一步"),
      capabilityRef("src/components/ProductPage.jsx", "cargoFactsStepGaps", "运输属性未确认时算利润的确认按钮不可点"),
      capabilityRef("src/components/ProductPage.jsx", "ExtraHandlingFeesBlock", "每单额外操作费就在算利润里填：默认空清单 = ¥0.00 一键确认，要加就加行写名目和金额"),
      capabilityRef("src/components/ProductPage.jsx", "extraHandlingFeeBreakLine", "每个规格旁边说清这笔费用涨到多少它才掉出利润线"),
      capabilityRef("src/components/ProductPage.jsx", "ozonCategoryStepGaps", "类目还不是真实页面读来的时候，算利润的确认按钮不可点"),
      capabilityRef("src/components/ProductPage.jsx", "CommissionEstimateBlock", "精确佣金读不到时，软件按官方费率表提议、主人一键授权估算佣金"),
      capabilityRef("src/components/UserInspector.jsx", "EstimatedCommissionNotice", "佣金还是估算的那一块摆在所有阶段面板之前，换屏、隔几天都还看得见")],
    testRefs: [capabilityRef("tests/real-a-confirmation-card.test.mjs", "test(", "确认卡测试"),
      capabilityRef("tests/profit-step-review.test.mjs", "test(", "算利润这一步的校验基准"),
      capabilityRef("tests/cargo-facts-declaration.test.mjs", "test(", "运输属性提议、校验与接进核验链路的基准"),
      capabilityRef("tests/extra-handling-fees.test.mjs", "test(", "每单额外操作费：明细与总额一致、空清单即 ¥0.00 声明、缺它在算利润就报、涨到 ¥X 才掉线"),
      capabilityRef("tests/commission-estimate-authorization.test.mjs", "test(", "估算佣金授权的识别与提议基准")]
  }),
  capability({
    id: "2.7", capabilityId: "selection.a.owner-supply-confirmation", areaId: "2",
    title: "等待主人确认准确供应 SKU", technicalName: "OwnerSupplyConfirmation",
    plainDescription: "软件在这里停住，只有主人能确认具体供应 SKU、成本和包装，或淘汰这个方向。",
    serves: "供货决策和 B 阶段入口",
    inputs: ["完整 A 确认卡", "当前 revision"],
    outputs: ["主人确认的供应方案", "淘汰决定或补证据要求"],
    integrationStatus: "connected", uiRole: "owner_confirmation",
    baselineHealth: { state: "unverified", reason: "主人确认门有代码与 UI；本轮未重新验证。" },
    ownerAction: "必须由主人明确确认；任何采集、AI或排序都不能代替。",
    stopConditions: "未确认、revision 过期或字段变化时保持等待。",
    breakpoint: "无；这是故意存在的人类商业确认点。",
    nextStep: "确认后冻结 A 输入并创建独立 SKU 生命周期。",
    position: { x: 1280, y: 250 },
    codeRefs: [capabilityRef("lib/supplier-selection-flow.mjs", "createOwnerSupplyConfirmation", "主人供货确认")],
    testRefs: [capabilityRef("tests/supplier-selection-flow.test.mjs", "test(", "供货确认测试")],
    artifactRefs: ["schema/owner-supply-confirmation-v1.1.schema.json"]
  }),
  capability({
    id: "2.8", capabilityId: "selection.a.freeze-sku-lifecycle", areaId: "2",
    title: "冻结 A 输入并建立 SKU 生命周期", technicalName: "SkuLifecyclePackage",
    plainDescription: "把主人确认的供应方案冻结成可追溯版本，后续 B 只能读取这一份。",
    serves: "B、C1、C2、D、E",
    inputs: ["主人确认的供应方案", "当前平台和店铺分支"],
    outputs: ["SkuLifecyclePackage", "冻结证据引用"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "生命周期创建与 A→B/C1 编排存在；当前验证回执未记录。" },
    stopConditions: "供应身份或 revision 不匹配时不能冻结。",
    breakpoint: "当前中央持久化尚未完成。",
    nextStep: "进入 B 输入完整性检查。",
    position: { x: 1580, y: 250 },
    codeRefs: [capabilityRef("lib/supplier-selection-flow.mjs", "createSkuLifecycleFromConfirmedSupply", "SKU 生命周期创建")],
    testRefs: [capabilityRef("tests/real-a-b-c1-flow.test.mjs", "test(", "A→B→C1 测试")],
    artifactRefs: ["lib/real-a-b-c1-flow.mjs"]
  }),

  capability({
    id: "3.1", capabilityId: "selection.b.input-readiness", areaId: "3",
    title: "检查 B 的冻结输入够不够", technicalName: "LifecycleBInputBundle",
    plainDescription: "只检查 A 已冻结的 SKU、成本、包装和证据是否足以做正式利润，不重新找货。",
    serves: "B 证据准备和利润计算",
    inputs: ["冻结 A 数据", "当前适用证据包"],
    outputs: ["B 输入包", "明确缺口"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "输入合同和完整性检查存在；本轮未重新验证。" },
    stopConditions: "任何必要输入缺失、失效或适用键不一致时停止。",
    breakpoint: "真实佣金、物流和汇率仍可能缺失。",
    nextStep: "并行准备平台费用与物流/汇率证据。",
    position: { x: 60, y: 220 },
    codeRefs: [capabilityRef("lib/lifecycle-b-input-bundle.mjs", "inspectLifecycleBInputReadiness", "B 输入检查")],
    testRefs: [capabilityRef("tests/lifecycle-b-input-bundle.test.mjs", "test(", "B 输入测试")]
  }),
  capability({
    id: "3.2", capabilityId: "selection.b.platform-fees", areaId: "3",
    title: "取得当前平台费用", technicalName: "LifecycleBEvidenceReaders",
    plainDescription: "按平台、店铺、类目和销售模式取得佣金等应计费用，失败不能写成零。",
    serves: "正式利润模型",
    inputs: ["平台、店铺、类目和销售模式", "一次只读证据作业"],
    outputs: ["平台费用证据包", "权限、网络或数据缺口"],
    integrationStatus: "partial",
    baselineHealth: { state: "unverified", reason: "读者与 provider 边界存在；当前真实平台证据未验证。" },
    stopConditions: "适用键不一致、证据过期或外部失败时停止。",
    breakpoint: "当前精确平台证据来源并非都具备实时正式连接。",
    nextStep: "与物流/汇率证据在 3.4 汇合。",
    position: { x: 360, y: 70 },
    codeRefs: [capabilityRef("lib/lifecycle-b-real-evidence-readers.mjs", "createLifecycleBRealEvidenceReaders", "B 真实证据读者")],
    testRefs: [capabilityRef("tests/lifecycle-b-real-evidence-readers.test.mjs", "test(", "证据读者测试"),
      capabilityRef("tests/official-commission-formal-b.test.mjs", "官方费表按中文类目树索引",
        "官方费表按中文类目树索引：页面面包屑末段命不中、类目树末段命中，用主人那份真目录钉住")],
    artifactRefs: ["lib/lifecycle-b-evidence-providers.mjs", "lib/wb-commission-reference-reader.mjs", "tests/wb-commission-reference-reader.test.mjs",
      "lib/ozon-commission-reference-reader.mjs", "tests/ozon-commission-reference-reader.test.mjs"]
  }),
  capability({
    id: "3.3", capabilityId: "selection.b.logistics-fx", areaId: "3",
    title: "取得物流和汇率证据", technicalName: "GUOO / Official FX",
    plainDescription: "按当前包装、线路和币种取得物流与汇率证据，不能用旧商品或默认值补齐。",
    serves: "正式利润模型",
    inputs: ["包装重量尺寸和线路", "币种和适用时间"],
    outputs: ["物流资费与汇率证据", "明确缺口"],
    integrationStatus: "partial",
    baselineHealth: { state: "unverified", reason: "物流与汇率读取代码存在；当前外部有效性未验证。" },
    stopConditions: "重量、尺寸、线路、币种或证据失效时停止。",
    breakpoint: "外部资费和汇率当前可用性未验证。",
    nextStep: "与平台费用证据在 3.4 汇合。",
    position: { x: 360, y: 360 },
    codeRefs: [capabilityRef("lib/guoo-tariff-reader.mjs", "readGuooTariffCatalog", "指定版本realFBS资费目录"),
      capabilityRef("lib/guoo-route-comparison.mjs", "compareGuooRoutes", "完整目录适用性与费用比较"),
      capabilityRef("lib/cargo-facts-declaration.mjs", "readDeclaredCargoFacts", "运输属性只来自主人的声明，没有声明仍然判不出适用性")],
    testRefs: [capabilityRef("tests/lifecycle-b-evidence-preparation.test.mjs", "test(", "B 证据准备测试")],
    artifactRefs: ["lib/official-fx-reader.mjs", "lib/lifecycle-b-evidence-preparation.mjs", "tests/guoo-tariff-reader.test.mjs", "tests/guoo-route-comparison.test.mjs"]
  }),
  capability({
    id: "3.4", capabilityId: "selection.b.evidence-merge", areaId: "3",
    title: "汇合全部应计成本", technicalName: "BEvidenceContext",
    plainDescription: "等平台费用、物流、汇率和采购成本都齐全后，再组成同一口径的正式计算输入。",
    serves: "ProfitModel",
    inputs: ["平台费用证据", "物流与汇率证据", "冻结采购成本"],
    outputs: ["完整 B 证据上下文", "缺失或冲突清单"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "证据合并和持久化代码存在；本轮验证记录未知。" },
    stopConditions: "任一必要成本缺失或合计不一致时不形成正式利润。",
    breakpoint: "上游外部证据可能未取得。",
    nextStep: "把完整输入交给 3.5 计算。",
    position: { x: 700, y: 220 },
    codeRefs: [capabilityRef("lib/lifecycle-b-evidence-runtime.mjs", "commitLifecycleBEvidencePacks", "证据包提交")],
    testRefs: [capabilityRef("tests/lifecycle-b-evidence-runtime.test.mjs", "test(", "证据汇合测试")],
    artifactRefs: ["lib/lifecycle-b-evidence-context.mjs", "lib/real-a-b-evidence-orchestration.mjs"]
  }),
  capability({
    id: "3.5", capabilityId: "selection.b.profit-model", areaId: "3",
    title: "计算具体 SKU 的正式利润", technicalName: "ProfitModel",
    plainDescription: "使用冻结输入和完整应计成本，算建议成交价、单件利润、利润率和采用的门槛。",
    serves: "具体平台和店铺的商业判断",
    inputs: ["完整 B 输入包", "版本化利润门槛"],
    outputs: ["ProfitModel", "通过、不通过或证据不足"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "确定性利润模型存在；当前源码验证回执未记录。" },
    stopConditions: "成本、币种或适用键不完整时只能显示条件测算，不能正式通过。",
    breakpoint: "真实精确证据仍取决于 3.2/3.3。",
    nextStep: "保存结果；通过时原子创建一次 C1 交接。",
    position: { x: 1020, y: 220 },
    aliases: ["旧 3.1"],
    codeRefs: [capabilityRef("lib/profit-model.mjs", "runSkuProfitModel", "利润模型")],
    testRefs: [capabilityRef("tests/profit-model.test.mjs", "test(", "利润模型测试")],
    artifactRefs: ["lib/global-pricing-policy.mjs", "tests/global-pricing-policy.test.mjs", "tests/fixtures/b-cost-policy-fixture.mjs", "schema/profit-model-v1.1.schema.json",
      "lib/b-exact-commission-recalculation-use-case.mjs", "lib/b-exact-commission-runtime-view.mjs", "src/bExactCommissionInput.js",
      "tests/b-exact-commission-recalculation-http.test.mjs", "tests/b-exact-commission-recalculation-use-case.test.mjs",
      "tests/b-exact-commission-runtime-view.test.mjs", "tests/fixtures/real-a-b-flow-fixture.mjs",
      "tests/b-fee-evidence-refresh.test.mjs"]
  }),
  capability({
    id: "3.6", capabilityId: "selection.b.atomic-c1-handoff", areaId: "3",
    title: "保存 B 结果并只交接一次 C1", technicalName: "Atomic B→C1 handoff",
    plainDescription: "利润正式通过时，软件在同一次保存里创建且只创建一个 C1 输入，不再让主人重复点击。",
    serves: "C1 正常入口",
    inputs: ["正式通过的 ProfitModel", "当前 revision 和幂等指纹"],
    outputs: ["保存的 B 结论", "唯一 C1 交接"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "原子交接代码存在；当前新鲜回归证据未记录。" },
    stopConditions: "利润未通过、证据不足或重复请求时不得新建 C1。",
    breakpoint: "C1 后续付费关键词作业仍未接通。",
    nextStep: "进入 4.1/4.2 的 C1 准备。",
    position: { x: 1340, y: 220 },
    codeRefs: [capabilityRef("lib/real-a-b-c1-flow.mjs", "runRealAConfirmationToBAndC1", "B→C1 原子交接")],
    testRefs: [capabilityRef("tests/real-a-b-c1-flow.test.mjs", "test(", "B通过后的原子C1交接")],
    artifactRefs: []
  }),

  capability({
    id: "4.1", capabilityId: "listing.c1.fact-schema", areaId: "4",
    title: "核对商品事实、类目和 Schema", technicalName: "C1ProductPlan",
    plainDescription: "只读取冻结 A/B 数据，核对准确 SKU、属性、类目、Schema、电池和合规事实。",
    serves: "C1 商品方案和 SEO 草稿",
    inputs: ["冻结 A/B 输入", "当前平台 Schema 和规则证据"],
    outputs: ["有来源的商品事实", "unknown 或合规缺口"],
    integrationStatus: "partial",
    baselineHealth: { state: "unverified", reason: "领域事实和 Schema 代码存在；普通生产 C1 尚未完整闭环。" },
    stopConditions: "无法确认的材质、品牌、电池、尺寸或认证保持 unknown。",
    breakpoint: "完整 C1 普通生产作业尚未持久接通。",
    nextStep: "与正式关键词结果汇合后生成草稿。",
    position: { x: 60, y: 80 },
    aliases: ["旧 4.1"],
    codeRefs: [capabilityRef("lib/c1-product-plan.mjs", "verifyC1ProductFacts", "C1 商品事实")],
    testRefs: [capabilityRef("tests/c1-product-plan.test.mjs", "test(", "C1 事实测试"),
      capabilityRef("tests/c1-unapproved-gate-removal.test.mjs", "test(", "撤掉没人批准过的门之后，还剩哪几条在挡")],
    artifactRefs: ["lib/c1-software-input-preparation.mjs", "lib/c1-fact-keyword-pipeline.mjs", "schema/c1-product-plan-v1.1.schema.json"]
  }),
  capability({
    id: "4.2", capabilityId: "listing.c1.keyword-source", areaId: "4",
    title: "准备关键词查询材料", technicalName: "Keyword planning source",
    plainDescription: "从冻结商品事实和可比竞品中整理一次关键词查询需要的材料，不重新找供应商。",
    serves: "付费关键词作业",
    inputs: ["冻结商品事实", "可比竞品和已有关键词证据"],
    outputs: ["版本化查询材料", "缺少来源或不可比原因"],
    integrationStatus: "partial",
    baselineHealth: { state: "unverified", reason: "本地材料、来源解析和持久化模块存在；尚未形成完整正常作业。" },
    stopConditions: "SKU、revision、事实指纹或竞品可比性不满足时停止。",
    breakpoint: "后续付费作业未进入通用 SoftwareJobStore。",
    nextStep: "由 4.3 创建一次持久作业。",
    position: { x: 60, y: 390 },
    codeRefs: [capabilityRef("lib/c1-keyword-planning-source-resolver.mjs", "resolveC1KeywordPlanningSourceEvidence", "关键词来源材料")],
    testRefs: [capabilityRef("tests/c1-keyword-planning-source-resolver.test.mjs", "test(", "来源解析测试")],
    artifactRefs: ["lib/c1-keyword-planning-local-material.mjs", "lib/c1-keyword-planning-local-material-persistence.mjs", "schema/c1-keyword-planning-local-material-v1.schema.json"]
  }),
  capability({
    id: "4.3", capabilityId: "listing.c1.keyword-job", areaId: "4",
    title: "创建一次持久关键词作业", technicalName: "C1 Keyword SoftwareJob",
    plainDescription: "把付费关键词查询变成可重启、单次 attempt、有明确终态的软件作业。",
    serves: "C1 正常软件链",
    inputs: ["版本化查询材料", "授权、revision 和来源策略"],
    outputs: ["持久 SoftwareJob", "可对账的单次执行结果"],
    registrationState: "candidate", integrationStatus: "disconnected",
    baselineHealth: { state: "blocked", reason: "规划器和候选局部作业代码存在，但未接入通用持久 SoftwareJobStore。" },
    stopConditions: "无授权、revision 漂移或相同幂等键已存在时零外部请求。",
    breakpoint: "这是当前 C1 正常链的主要断点。",
    nextStep: "迁入通用作业存储、租约和重启对账后再接 4.4。",
    position: { x: 380, y: 390 },
    codeRefs: [capabilityRef("lib/c1-keyword-software-job-planner.mjs", "planC1KeywordEvidenceSoftwareJob", "关键词作业规划")],
    uiRefs: [capabilityRef("src/components/KeywordSoftwareRuntimeCard.jsx", "KeywordSoftwareRuntimeCard", "关键词运行状态")],
    testRefs: [capabilityRef("tests/c1-keyword-software-job-planner.test.mjs", "test(", "作业规划测试")],
    artifactRefs: ["lib/c1-keyword-software-use-case.mjs", "lib/keyword-evidence-software-job-state.mjs", "schema/c1-keyword-software-job-plan-v1.schema.json"]
  }),
  capability({
    id: "4.4", capabilityId: "listing.c1.keyword-provider", areaId: "4",
    title: "调用正式关键词来源一次", technicalName: "Seerfar connector",
    plainDescription: "按预先批准的来源和范围调用一次 Seerfar，保存额度、请求和脱敏回执，不自动换路。",
    serves: "K1/K2/K3 关键词证据",
    inputs: ["持久关键词作业", "正式凭据和额度"],
    outputs: ["来源尝试和结果", "登录、额度、网络或 Schema 失败"],
    registrationState: "candidate", integrationStatus: "disconnected", runtimeScope: "external_paid_api",
    baselineHealth: { state: "unverified", reason: "连接器和generic SoftwareJob worker消费链已存在；真实密钥、额度和worker部署仍需生产前验收。" },
    stopConditions: "失败后不自动重试、不自动切浏览器或其他来源。",
    breakpoint: "真实Worker部署、凭据和额度回执尚未做生产验收。",
    nextStep: "验证真实密钥、额度、worker租约和脱敏回执后再开放生产运行。",
    position: { x: 700, y: 390 },
    aliases: ["旧 4.2"],
    codeRefs: [capabilityRef("lib/keyword-evidence-software-runner.mjs", "runC1PaidKeywordEvidenceSoftwareJob", "generic关键词Worker消费"), capabilityRef("lib/keyword-evidence-runtime-services.mjs", "createKeywordEvidenceRuntimeServices", "显式配置的关键词服务")],
    testRefs: [capabilityRef("tests/seerfar-software-server-integration.test.mjs", "test(", "Seerfar 服务接线测试"), capabilityRef("tests/keyword-evidence-runtime-services.test.mjs", "test(", "关键词消费与交接恢复"), capabilityRef("tests/c1-keyword-runtime-store.test.mjs", "test(", "发送门与原持有者收口"), capabilityRef("tests/keyword-evidence-runtime-http.test.mjs", "test(", "隔离HTTP与零外访")],
    artifactRefs: ["lib/seerfar-open-api-transport.mjs", "lib/seerfar-runtime-connector.mjs", "lib/keyword-evidence-provider-adapter.mjs"]
  }),
  capability({
    id: "4.5", capabilityId: "listing.c1.keyword-evidence", areaId: "4",
    title: "整理和评分关键词证据", technicalName: "K1 / K2 / K3",
    plainDescription: "区分真实零结果和技术失败，合并来源、评分并限制关键词只能放到合适位置。",
    serves: "C1 SEO 草稿",
    inputs: ["一次来源结果", "冻结商品事实和可比竞品"],
    outputs: ["K1 快照、K2 融合和 K3 分组", "拒绝词及原因"],
    integrationStatus: "partial",
    baselineHealth: { state: "unverified", reason: "K1/K2/K3 领域链与测试存在，但正常上游作业阻塞。" },
    stopConditions: "来源失败不得写成 true_empty；低语义匹配词不得进标题或标签。",
    breakpoint: "受 4.3/4.4 阻塞，尚不能构成正常 C1 完成。",
    nextStep: "与 4.1 商品事实汇合生成受约束草稿。",
    position: { x: 1020, y: 390 },
    codeRefs: [
      capabilityRef("lib/keyword-evidence-snapshot.mjs", "createKeywordEvidenceSnapshot", "K1 快照"),
      capabilityRef("lib/keyword-evidence-scoring.mjs", "scoreAndGroupKeywordEvidence", "K3 评分")
    ],
    testRefs: [capabilityRef("tests/keyword-evidence-scoring.test.mjs", "test(", "关键词评分测试")],
    artifactRefs: ["lib/keyword-evidence-orchestrator.mjs", "lib/c1-k3-keyword-adapter.mjs", "lib/c1-k3-runtime-bridge.mjs", "schema/keyword-evidence-snapshot-v1.schema.json", "schema/keyword-scoring-v1.schema.json"]
  }),
  capability({
    id: "4.6", capabilityId: "listing.c1.seo-ai-draft", areaId: "4",
    title: "生成有事实约束的 SEO 草稿", technicalName: "C1 AI draft",
    plainDescription: "把已核实事实和合格关键词交给正式 AI 网关，生成只读草稿，不能创造不存在的卖点。",
    serves: "主人最终商品方案",
    inputs: ["C1 已核实事实", "K3 合格关键词和位置限制"],
    outputs: ["draft_only 标题、描述和搜索词", "AI 回执或明确失败"],
    integrationStatus: "partial", runtimeScope: "ai_gateway",
    baselineHealth: { state: "unverified", reason: "AI 合同、网关和编排代码存在；正常 C1 上游尚未闭环。" },
    stopConditions: "事实绑定、关键词绑定、Schema 或模型回执不合格时停止。",
    breakpoint: "上游正式关键词作业未接通。",
    nextStep: "保存 C1ProductPlan，满足条件后进入 C2。",
    position: { x: 1340, y: 220 },
    codeRefs: [capabilityRef("lib/c1-ai-gateway.mjs", "runC1AiDraftThroughGateway", "C1 AI 网关")],
    testRefs: [capabilityRef("tests/c1-ai-draft-contract.test.mjs", "test(", "AI 草稿合同测试")],
    artifactRefs: ["lib/c1-ai-draft-contract.mjs", "lib/c1-seo-draft.mjs", "lib/c1-software-orchestrator.mjs", "schema/c1-ai-draft-request-v1.schema.json", "schema/c1-ai-draft-receipt-v1.schema.json"]
  }),
  capability({
    id: "4.7", capabilityId: "listing.c1.persist-plan", areaId: "4",
    title: "保存 C1 商品方案并交给 C2", technicalName: "C1 persistence / ready event",
    plainDescription: "把事实、关键词和草稿按同一 revision 保存，只有完整结果才允许创建 C2。",
    serves: "C2 素材生命周期",
    inputs: ["C1ProductPlan", "关键词和 AI 回执"],
    outputs: ["保存的 C1 方案", "C2 ready 事件或明确阻塞"],
    registrationState: "candidate", integrationStatus: "disconnected",
    baselineHealth: { state: "blocked", reason: "持久化与 ready-event 代码存在，但完整正常 C1 作业没有闭环。" },
    stopConditions: "任何输入指纹或 revision 漂移时不创建 C2。",
    breakpoint: "4.3/4.4 未完成导致 C1→C2 线路阻塞。",
    nextStep: "C1 正常闭环验收后开放 4.7→5.1。",
    position: { x: 1660, y: 220 },
    codeRefs: [capabilityRef("lib/c1-fact-keyword-persistence.mjs", "buildC1FactKeywordAtomicPatch", "C1 原子保存")],
    testRefs: [capabilityRef("tests/c1-fact-keyword-persistence.test.mjs", "test(", "C1 保存测试")],
    artifactRefs: ["lib/c1-keyword-evidence-auto-trigger.mjs", "lib/keyword-evidence-ready-event-producer.mjs", "lib/c1-software-evidence-stage.mjs", "schema/c1-keyword-evidence-ready-event-v1.schema.json"]
  }),

  capability({
    id: "5.1", capabilityId: "listing.c2.asset-container", areaId: "5",
    title: "建立三个互不混用的素材区", technicalName: "C2 asset lifecycle",
    plainDescription: "把参考素材、AI 草稿和最终上传素材分开保存，前两类不能自动进入生产。",
    serves: "C2 素材管理和主人最终确认",
    inputs: ["完成的 C1 方案", "已有参考或草稿素材"],
    outputs: ["collected、aiDrafts、finalUploads 三个区域"],
    integrationStatus: "connected",
    baselineHealth: { state: "unverified", reason: "三素材域和软件容器存在；本轮未重新验证。" },
    stopConditions: "C1 revision 不一致时不能建立或继续 C2。",
    breakpoint: "真实端到端受 C1 上游阻塞。",
    nextStep: "主人提供最终上传素材。",
    position: { x: 60, y: 220 },
    codeRefs: [capabilityRef("lib/c2-asset-lifecycle.mjs", "createC2AssetLifecycle", "C2 素材生命周期")],
    testRefs: [capabilityRef("tests/c2-software-orchestrator.test.mjs", "test(", "C2 软件测试")],
    artifactRefs: ["lib/c2-software-orchestrator.mjs", "schema/c2-asset-lifecycle-v1.1.schema.json", "schema/c2-software-input-v1.schema.json"]
  }),
  capability({
    id: "5.2", capabilityId: "listing.c2.reference-assets", areaId: "5",
    title: "保留参考素材但禁止上传", technicalName: "assets.collected",
    plainDescription: "保存平台或供应端参考图用于分析，明确禁止直接进入 D。",
    serves: "主人和素材制作工具",
    inputs: ["有来源的参考图片或视频"],
    outputs: ["只读 collected 素材"],
    integrationStatus: "connected", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "参考素材隔离规则存在；当前无新鲜验证回执。" },
    stopConditions: "来源不明或越过 finalUploads 时立即阻止。",
    breakpoint: "无；这是故意隔离的参考支路。",
    nextStep: "只能供主人参考，不能自动升级。",
    position: { x: 360, y: 50 },
    codeRefs: [capabilityRef("lib/c2-asset-lifecycle.mjs", "COLLECTED_ASSET_PLATFORMS", "参考素材域")],
    testRefs: [capabilityRef("tests/phase5-c2-software-boundary.test.mjs", "test(", "C2 边界测试")]
  }),
  capability({
    id: "5.3", capabilityId: "listing.c2.ai-draft-assets", areaId: "5",
    title: "保留 AI 素材草稿", technicalName: "assets.aiDrafts",
    plainDescription: "保存 AI 或工具生成的素材草稿，主人未确认前不能成为最终素材。",
    serves: "主人和素材制作工具",
    inputs: ["AI 或工具草稿及来源"],
    outputs: ["只读 aiDrafts 素材"],
    integrationStatus: "connected", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "AI 草稿隔离规则存在；当前无新鲜验证回执。" },
    stopConditions: "禁止自动提升到 finalUploads。",
    breakpoint: "无；这是故意隔离的草稿支路。",
    nextStep: "主人可参考后重新提供最终文件。",
    position: { x: 360, y: 220 },
    codeRefs: [capabilityRef("lib/c2-asset-lifecycle.mjs", "addAiDraftAssets", "AI 草稿素材")],
    testRefs: [capabilityRef("tests/c2-software-orchestrator.test.mjs", "test(", "C2 草稿隔离测试")]
  }),
  capability({
    id: "5.4", capabilityId: "listing.c2.final-uploads", areaId: "5",
    title: "接收主人提供的最终素材", technicalName: "assets.finalUploads",
    plainDescription: "只接收主人明确提供的最终图片或视频，并绑定当前候选和 revision。",
    serves: "最终商品确认卡和 D 授权",
    inputs: ["主人上传的最终文件", "当前候选和 revision"],
    outputs: ["待确认的 finalUploads 清单"],
    integrationStatus: "connected", uiRole: "owner_input",
    baselineHealth: { state: "unverified", reason: "上传、类型校验和候选/revision 绑定已接线；本轮未重新验证。" },
    ownerAction: "主人选择真正准备上传店铺的最终素材。",
    stopConditions: "文件类型、内容、候选、revision 或身份不一致时拒绝。",
    breakpoint: "本机素材仍需在 D 前转换为平台可接受的稳定地址。",
    nextStep: "验证顺序、首图、SHA 和完整性。",
    position: { x: 360, y: 400 },
    codeRefs: [capabilityRef("lib/c2-software-orchestrator.mjs", "prepareC2FinalUploadManifest", "最终素材清单")],
    uiRefs: [capabilityRef("src/components/UserInspector.jsx", "onUploadLifecycleFinalAsset", "最终素材上传 UI")],
    testRefs: [capabilityRef("tests/c2-final-assets-ui-contract.test.mjs", "test(", "最终素材 UI 合同")]
  }),
  capability({
    id: "5.5", capabilityId: "listing.c2.owner-final-confirmation", areaId: "5",
    title: "等待主人锁定素材和最终方案", technicalName: "Final product confirmation",
    plainDescription: "检查素材版本、顺序、首图和完整性后停住，由主人一次确认最终商品方案。",
    serves: "ProductionAuthorization 前的商业判断",
    inputs: ["finalUploads 清单", "C1 商品方案和 B 利润"],
    outputs: ["锁定的最终素材", "最终商品方案卡"],
    integrationStatus: "connected", uiRole: "owner_confirmation",
    baselineHealth: { state: "unverified", reason: "确认、幂等和方案卡代码存在；本轮未重新验证。" },
    ownerAction: "主人确认素材集合、顺序和最终商品方案；这仍不是生产授权。",
    stopConditions: "素材变化、revision 漂移或必要字段 unknown 时保持等待。",
    breakpoint: "上游 C1 正常作业未完成。",
    nextStep: "确认后才显示 6.1 生产授权。",
    position: { x: 760, y: 220 },
    aliases: ["旧 5.1"],
    codeRefs: [capabilityRef("lib/final-product-plan-confirmation-card.mjs", "createFinalProductPlanConfirmationCard", "最终商品方案卡")],
    uiRefs: [capabilityRef("src/components/UserInspector.jsx", "onConfirmLifecycleFinalAssets", "最终素材确认 UI")],
    testRefs: [capabilityRef("tests/real-13c-final-assets.test.mjs", "test(", "最终素材确认测试")],
    artifactRefs: ["schema/final-product-plan-confirmation-card-v1.1.schema.json",
      "lib/final-pricing-review.mjs", "lib/final-pricing-review-use-case.mjs", "lib/final-pricing-revalidation.mjs",
      "src/finalPricingReviewInput.js", "src/components/FinalPricingReviewForm.jsx",
      "tests/final-pricing-revalidation.test.mjs", "tests/final-pricing-review-use-case.test.mjs",
      "tests/final-pricing-review-api.test.mjs", "tests/final-pricing-review-input.test.mjs",
      "tests/fixtures/final-pricing-review-fixture.mjs", "tests/fixtures/final-pricing-revalidation-fixture.mjs",
      "lib/c1-pricing-result-reuse.mjs", "lib/c2-pricing-upload-reuse.mjs", "tests/c1-pricing-result-reuse.test.mjs",
      "tests/final-pricing-c1-reuse-integration.test.mjs", "tests/fixtures/final-pricing-c1-reuse-fixture.mjs"]
  }),

  capability({
    id: "6.1", capabilityId: "listing.d.production-authorization", areaId: "6",
    title: "等待主人锁定生产授权", technicalName: "ProductionAuthorization",
    plainDescription: "把平台、店铺、SKU、价格、库存、素材和允许写入范围冻结下来，但此时不写店。",
    serves: "D 唯一合法输入",
    inputs: ["最终商品方案卡", "精确平台、店铺和写入范围"],
    outputs: ["不可变 ProductionAuthorization"],
    integrationStatus: "partial", uiRole: "owner_confirmation",
    baselineHealth: { state: "risk", reason: "单主人v1.2确认与本地登录已接线，隔离HTTP已验证；实际店铺配置与D/E执行服务仍待核实。" },
    ownerAction: "主人必须针对当前精确对象授权，任何变化都要创建新授权。",
    stopConditions: "对象、价格、素材、库存、revision 或排除项不完整时拒绝。",
    breakpoint: "正式使用须由主人设置登录并配置准确店铺仓库；D/E真实服务尚未贯通。",
    nextStep: "由软件只读授权生成 ProductionPlan。",
    position: { x: 60, y: 220 },
    codeRefs: [
      capabilityRef("lib/production-authorization.mjs", "commitSingleOwnerProductionAuthorization", "单次决定与授权原子保存"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "assertFormalCommissionBeforeProduction", "钱的闸门：佣金还是估算的就不给授权，判在服务端那一次原子事务里"),
      capabilityRef("lib/commission-estimate-authorization.mjs", "resolveConditionalCommissionRelease", "条件测算是不是仅仅因为佣金是估算：判据全部来自结构化字段，三处共用"),
      capabilityRef("lib/production-owner-preparation.mjs", "resolveProductionOwnerPreparation", "同一事务重验配置与冻结价格"),
      capabilityRef("server.mjs", "realProductionOwnerDecisionRoute", "单主人确认API")
    ],
    uiRefs: [
      capabilityRef("src/components/ProductionOwnerDecisionForm.jsx", "ProductionOwnerDecisionForm", "准确范围确认表单"),
      capabilityRef("src/productionAuthorizationInput.js", "productionAuthorizationInputFromCard", "当前卡片与配置引用")
    ],
    testRefs: [capabilityRef("tests/production-owner-decision.test.mjs", "test(", "授权原子事务测试")],
    artifactRefs: ["schema/production-authorization-v1.1.schema.json"]
  }),
  capability({
    id: "6.2", capabilityId: "listing.d.production-plan", areaId: "6",
    title: "只按授权生成生产计划", technicalName: "ProductionPlan",
    plainDescription: "从不可变授权快照生成生产计划，不允许临时回读 A/B/C 再修改内容。",
    serves: "D 写前检查和执行",
    inputs: ["ProductionAuthorization"],
    outputs: ["绑定授权指纹的 ProductionPlan"],
    integrationStatus: "connected",
    baselineHealth: { state: "risk", reason: "计划合同存在，但 mode=simulation 的历史命名与 D 使用语义仍需收敛。" },
    stopConditions: "授权指纹、revision 或对象身份不一致时停止。",
    breakpoint: "supplierSkuId 与 merchantSku 身份仍需彻底分离。",
    nextStep: "完成店铺、凭据、仓库和 Worker 写前检查。",
    position: { x: 350, y: 220 },
    codeRefs: [capabilityRef("lib/production-plan.mjs", "createProductionPlan", "生产计划"),
      capabilityRef("lib/platform-write-bindings.mjs", "derivePlatformWriteBindings", "冻结平台属性写入绑定")],
    testRefs: [capabilityRef("tests/production-plan.test.mjs", "test(", "生产计划测试"),
      capabilityRef("tests/platform-write-bindings.test.mjs", "test(", "冻结平台属性绑定测试")],
    artifactRefs: ["schema/production-plan-v1.1.schema.json"]
  }),
  capability({
    id: "6.3", capabilityId: "listing.d.preflight", areaId: "6",
    title: "写店前核对身份、权限和能力", technicalName: "Platform write preflight",
    plainDescription: "在任何外部请求前核对店铺、凭据、仓库、Worker、素材地址、授权和 revision。",
    serves: "Ozon/WB 写入安全门",
    inputs: ["ProductionPlan", "店铺与 Worker 当前能力"],
    outputs: ["可执行前检或 rejected_before_write"],
    integrationStatus: "partial",
    baselineHealth: { state: "risk", reason: "前检合同存在，但稳定 sellerId/storeId、credentialAlias 和仓库绑定尚未完成。" },
    stopConditions: "任一身份、权限、能力、素材或 revision 不一致时零外部请求。",
    breakpoint: "多店身份和 Worker 能力模型不足以证明生产隔离。",
    nextStep: "修正身份模型后才允许持久化执行意图。",
    position: { x: 660, y: 220 },
    codeRefs: [capabilityRef("lib/platform-write-preflight.mjs", "runPlatformWritePreflight", "平台写前检查")],
    testRefs: [capabilityRef("tests/platform-write-preflight.test.mjs", "test(", "写前检查测试")],
    artifactRefs: ["schema/platform-write-preflight-v1.1.schema.json", "schema/platform-write-preflight-v1.2.schema.json"]
  }),
  capability({
    id: "6.4", capabilityId: "listing.d.execution-intent", areaId: "6",
    title: "先保存一次性执行意图", technicalName: "D execution intent",
    plainDescription: "在请求平台前先保存本次要写什么、幂等键和授权身份，防止重复点击或重启后重复写。",
    serves: "D 受控执行",
    inputs: ["通过前检的 ProductionPlan", "一次性幂等身份"],
    outputs: ["持久执行意图", "明确未发出、失败或 unknown_outcome"],
    integrationStatus: "partial",
    baselineHealth: { state: "blocked", reason: "领域执行意图存在，但服务端正式 Seller API 执行和回执持久化尚未接通。" },
    stopConditions: "意图未持久化时绝不能请求平台；结果未知时禁止自动重放。",
    breakpoint: "server 只有受控 OSS 素材传输入口，没有正式 Seller API 平台写入路由。",
    nextStep: "先让素材传输和平台写入保持两个独立意图，再决定 Seller API 接线。",
    position: { x: 970, y: 220 },
    codeRefs: [capabilityRef("lib/d-e-software-closure.mjs", "beginDSoftwareExecution", "D 执行意图")],
    testRefs: [capabilityRef("tests/d-e-software-closure.test.mjs", "test(", "D/E 领域闭环测试")],
    artifactRefs: ["lib/d-e-software-integration.mjs", "schema/d-software-execution-v1.schema.json", "schema/d-software-execution-state-v1.schema.json", "schema/d-software-execution-v2.schema.json", "schema/d-software-execution-state-v2.schema.json"]
  }),
  capability({
    id: "6.5", capabilityId: "listing.d.ozon-assets-write", areaId: "6",
    title: "把最终素材转成 Ozon 可用地址", technicalName: "Aliyun OSS asset transport",
    plainDescription: "把主人确认的 finalUploads 按一次性意图上传到 OSS，得到稳定素材地址；这一步不是把商品写进 Ozon。",
    serves: "Ozon D 阶段的素材准备",
    inputs: ["已保存的素材传输意图", "主人确认的 finalUploads", "受控 OSS 配置"],
    outputs: ["逐素材 OSS 上传回执", "明确失败或 unknown_outcome"],
    registrationState: "official", integrationStatus: "partial",
    runtimeScopes: ["local_development", "external_service_write"],
    sideEffects: ["external_asset_write", "local_save"],
    baselineHealth: { state: "risk", reason: "主源码有受控服务端入口、先存意图和重启对账；本轮未执行真实上传，4317 是否含同版实现待快照说明。" },
    ownerAction: "必须使用精确素材传输确认；该确认不能扩大成 Ozon 商品写入授权。",
    stopConditions: "素材身份、revision、授权、配置或请求终态不明确时停止；unknown_outcome 禁止自动重发。",
    breakpoint: "只完成外部素材存储，不产生 Ozon 商品写入回执。",
    nextStep: "如将来接入 6.6，必须由独立 Seller API 意图和授权接收素材地址。",
    position: { x: 1270, y: 70 },
    aliases: ["旧 6.2"],
    codeRefs: [
      capabilityRef("lib/aliyun-oss-d-asset-integration.mjs", "createPersistableAliyunOssAssetIntent", "素材传输意图"),
      capabilityRef("lib/aliyun-oss-asset-transport.mjs", "uploadAliyunOssFinalAssets", "OSS 单次上传")
    ],
    uiRefs: [capabilityRef("src/components/DESoftwareRuntimeCard.jsx", "DESoftwareRuntimeCard", "D/E 准备度展示")],
    testRefs: [capabilityRef("tests/aliyun-oss-d-asset-integration.test.mjs", "test(", "OSS 持久意图测试"), capabilityRef("tests/aliyun-oss-asset-transport.test.mjs", "test(", "OSS 传输测试")]
  }),
  capability({
    id: "6.6", capabilityId: "listing.d.ozon-platform-write", areaId: "6",
    title: "调用 Ozon Seller API 写商品", technicalName: "Ozon Seller API production adapter",
    plainDescription: "按冻结授权向 Ozon Seller API 提交商品、价格、库存和素材；当前只有候选适配器，没有正式服务端执行入口。",
    serves: "Ozon D 阶段的平台商品写入",
    inputs: ["独立的 Seller API 执行意图", "冻结 ProductionPlan", "6.5 素材地址", "目标店铺身份"],
    outputs: ["Ozon Seller API 原始终态的归一化回执", "明确失败或 unknown_outcome"],
    registrationState: "candidate", integrationStatus: "disconnected", runtimeScope: "external_platform_write",
    baselineHealth: { state: "blocked", reason: "适配器和合同代码存在，但 server 没有正式 Seller API 写入路由，当前 canExecutePlatformWrite=false。" },
    ownerAction: "只能使用 6.1 锁定的生产授权；素材传输确认不能代替平台写入授权。",
    stopConditions: "店铺、revision、币种、权限、幂等身份或终态不明时停止。",
    breakpoint: "没有真实 Ozon 平台写入入口和与当前源码绑定的生产回执。",
    nextStep: "未来先完成身份、一次性作业与单 SKU 安全验收；本轮不接线。",
    position: { x: 1500, y: 70 },
    codeRefs: [capabilityRef("lib/ozon-seller-api-production-adapter.mjs", "createOzonSellerApiProductionAdapter", "Ozon 写入候选适配器")],
    uiRefs: [capabilityRef("src/components/DESoftwareRuntimeCard.jsx", "DESoftwareRuntimeCard", "D/E 准备度展示")],
    testRefs: [capabilityRef("tests/ozon-seller-api-production-adapter.test.mjs", "test(", "Ozon 适配器测试")]
  }),
  capability({
    id: "6.7", capabilityId: "listing.d.production-record", areaId: "6",
    title: "保存真实平台写入回执", technicalName: "ProductionRecord",
    plainDescription: "只有拿到真实平台身份和完整回执后，才保存本轮系统创建的 ProductionRecord。",
    serves: "E 独立回读",
    inputs: ["Ozon/WB 写入回执", "执行意图和幂等身份"],
    outputs: ["ProductionRecord", "unknown_outcome 或明确失败"],
    registrationState: "candidate", integrationStatus: "disconnected",
    baselineHealth: { state: "blocked", reason: "领域合同存在，但没有正式平台执行回执可供服务端持久化。" },
    stopConditions: "没有真实 productId/offerId 或身份不一致时不得创建记录。",
    breakpoint: "依赖尚未接通的 6.6 或 6.8。",
    nextStep: "记录成功后进入独立 E 读取。",
    position: { x: 1760, y: 220 },
    codeRefs: [capabilityRef("lib/d-e-software-closure.mjs", "executeDSoftwareAttempt", "D 执行与 ProductionRecord")],
    testRefs: [capabilityRef("tests/d-e-software-integration.test.mjs", "test(", "D/E 接缝测试")]
  }),
  capability({
    id: "6.8", capabilityId: "listing.d.wb-write", areaId: "6",
    title: "把商品正式写进 WB", technicalName: "WB production adapter",
    plainDescription: "这里应负责 WB 建卡、素材、价格库存和真实回执，但当前没有正式实现。",
    serves: "WB D 阶段",
    inputs: ["未来需要：WB 精确授权、类目、素材、价格库存和店铺身份"],
    outputs: ["未来需要：WB ProductionRecord 或 unknown_outcome"],
    registrationState: "unknown", integrationStatus: "not_implemented", runtimeScope: "not_available",
    mainlineQualification: "owner_decision", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "尚未实现，不用红色伪装成一次运行失败。" },
    ownerAction: "未来仍需独立 WB 生产授权。",
    stopConditions: "当前无执行能力，必须保持断开。",
    breakpoint: "缺少 WB adapter、执行作业、回执持久化和测试。",
    nextStep: "先定义 WB DTO、前检和独立回读合同。",
    position: { x: 1270, y: 400 },
    aliases: ["旧 6.3"],
    codeRefs: [], uiRefs: [], testRefs: []
  }),

  capability({
    id: "7.1", capabilityId: "listing.e.readback-identity", areaId: "7",
    title: "确定要回读哪个平台商品", technicalName: "ProductionRecord / ExternalListingRecord",
    plainDescription: "明确这是本轮系统创建的商品还是外部已存在商品，并锁定平台、店铺和商品身份。",
    serves: "E 独立回读",
    inputs: ["ProductionRecord 或 ExternalListingRecord"],
    outputs: ["不可混用的回读身份"],
    integrationStatus: "partial",
    baselineHealth: { state: "unverified", reason: "两类身份合同存在；服务端正式 E 生产者未接通。" },
    stopConditions: "不能用外部商品冒充本轮创建，也不能伪造 ProductionRecord。",
    breakpoint: "浏览器只提交来源记录引用；正式平台读取连接尚未配置。",
    nextStep: "按平台选择独立只读 provider。",
    position: { x: 60, y: 220 },
    codeRefs: [capabilityRef("lib/e-stage-readback.mjs", "createExternalListingRecord", "外部商品身份")],
    testRefs: [capabilityRef("tests/e-stage-readback.test.mjs", "test(", "E 身份与验证测试")],
    artifactRefs: ["schema/external-listing-record-v1.1.schema.json"]
  }),
  capability({
    id: "7.2", capabilityId: "listing.e.ozon-readback", areaId: "7",
    title: "独立读取 Ozon 当前结果", technicalName: "Ozon readback provider",
    plainDescription: "通过独立只读接口重新取得商品、图片、价格、库存、审核和销售状态。",
    serves: "Ozon E 阶段",
    inputs: ["Ozon 商品和店铺身份", "只读平台能力"],
    outputs: ["脱敏平台观察值", "明确失败或 unknown_outcome"],
    registrationState: "candidate", integrationStatus: "disconnected", runtimeScope: "external_platform_read",
    baselineHealth: { state: "blocked", reason: "DTO、mock适配器和规则存在，但正式独立 Ozon 读取者未接服务端。" },
    stopConditions: "身份不一致、权限或网络失败时不能显示已验证。",
    breakpoint: "浏览器观察入口已关闭；可信独立读取未接线，当前请求503。",
    nextStep: "接入店铺隔离的正式只读 provider。",
    position: { x: 380, y: 80 },
    aliases: ["旧 7.1"],
    codeRefs: [capabilityRef("lib/ozon-seller-api-de-adapter.mjs", "createStoreIsolatedOzonSellerApiDEAdapter", "Ozon D/E 适配器")],
    testRefs: [capabilityRef("tests/ozon-seller-api-de-adapter.test.mjs", "test(", "Ozon D/E 适配器测试")],
    artifactRefs: ["lib/ozon-de-readonly-capability-probe.mjs"]
  }),
  capability({
    id: "7.3", capabilityId: "listing.e.verify-persist", areaId: "7",
    title: "比对并保存 E 验证结果", technicalName: "EVerificationRecord",
    plainDescription: "把独立回读与写入记录逐项核对，只有身份和关键字段一致才标记已验证。",
    serves: "最终业务完成证明",
    inputs: ["独立平台观察值", "ProductionRecord 或 ExternalListingRecord"],
    outputs: ["EVerificationRecord", "不一致、失败或待对账"],
    registrationState: "candidate", integrationStatus: "partial",
    baselineHealth: { state: "blocked", reason: "已实现独立读取意图和结果持久化、并发去重及重启保护；正式平台读取器仍未配置。" },
    stopConditions: "没有独立来源或关键字段不一致时不能完成 E。",
    breakpoint: "上游 7.2/7.4 均未形成正式生产读取。",
    nextStep: "真实 provider 接通后分别验收系统创建和外部发现路径。",
    position: { x: 760, y: 220 },
    codeRefs: [capabilityRef("lib/e-stage-readback.mjs", "verifySystemCreatedListing", "系统创建商品验证"),
      capabilityRef("lib/e-readback-software-use-case.mjs", "createSystemEReadbackSoftwareRuntime", "独立读取与结果持久化")],
    testRefs: [capabilityRef("tests/lifecycle-e-readback-generic-api.test.mjs", "test(", "E API 测试"),
      capabilityRef("tests/e-readback-software-use-case.test.mjs", "test(", "独立读取持久化测试")],
    artifactRefs: ["schema/e-verification-record-v1.1.schema.json", "schema/e-system-readback-v1.schema.json", "schema/e-readback-attempt-v1.schema.json"]
  }),
  capability({
    id: "7.4", capabilityId: "listing.e.wb-readback", areaId: "7",
    title: "独立读取 WB 当前结果", technicalName: "WB readback provider",
    plainDescription: "这里应独立读取 WB 商品、图片、价格、库存和审核，但当前没有正式实现。",
    serves: "WB E 阶段",
    inputs: ["未来需要：WB 商品身份和只读平台能力"],
    outputs: ["未来需要：WB 平台观察和 EVerificationRecord"],
    registrationState: "unknown", integrationStatus: "not_implemented", runtimeScope: "not_available",
    mainlineQualification: "owner_decision", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "尚未实现，不冒充一次运行失败。" },
    stopConditions: "当前无执行能力，必须保持断开。",
    breakpoint: "缺少 WB 只读适配器、路由、状态保存和测试。",
    nextStep: "先定义只读 DTO 和能力探针。",
    position: { x: 380, y: 380 },
    aliases: ["旧 7.2"],
    codeRefs: [], uiRefs: [], testRefs: []
  }),

  capability({
    id: "8.1", capabilityId: "runtime.known-failure-stop", areaId: "8",
    title: "把已知失败分类并停住", technicalName: "Technical failure state",
    plainDescription: "权限、网络、额度、解析或证据冲突等已知问题由软件分类、保存并停止，不自动找 Codex。",
    serves: "所有外部和技术步骤",
    inputs: ["结构化失败和请求是否发出", "最后一个确定成功步骤"],
    outputs: ["明确技术状态", "主人可理解的最小恢复动作"],
    integrationStatus: "partial", flowClass: "exception", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "技术失败状态机存在；各阶段尚未全部统一接入。" },
    ownerAction: "只有需要新授权、补资料或商业判断时才提示主人。",
    stopConditions: "已知失败不得自动重试、换模型或换路径。",
    breakpoint: "旧路径仍可能使用不同失败字段。",
    nextStep: "统一固定 failureClass、安全错误码和 evidenceRef。",
    position: { x: 60, y: 80 },
    codeRefs: [capabilityRef("lib/software-execution-state.mjs", "blockExecutionForTechnicalFailure", "技术失败停机")],
    uiRefs: [capabilityRef("src/components/ExecutionRuntimeCard.jsx", "ExecutionRuntimeCard", "异常状态展示")],
    testRefs: [capabilityRef("tests/software-execution-state.test.mjs", "test(", "执行状态机测试")]
  }),
  capability({
    id: "8.2", capabilityId: "runtime.unknown-outcome", areaId: "8",
    title: "结果未知时先对账", technicalName: "unknown_outcome reconciliation",
    plainDescription: "外部请求可能已经发出但终态不明时，保存 unknown_outcome 并禁止再次点击重放。",
    serves: "付费调用、素材传输、平台写入和回读",
    inputs: ["已持久执行意图", "请求发送阶段和最后证据"],
    outputs: ["unknown_outcome", "必须先对账的动作"],
    integrationStatus: "partial", flowClass: "exception", normalPathAllowed: false,
    baselineHealth: { state: "risk", reason: "多个领域模块已有 unknown_outcome 规则，但真实 D/E 对账尚未接通。" },
    ownerAction: "主人不能用“再试一次”绕过对账。",
    stopConditions: "没有独立对账结果前保持停止。",
    breakpoint: "平台级对账 producer 尚未完成。",
    nextStep: "能分类的走软件对账；真正未知系统异常才进入 8.3。",
    position: { x: 60, y: 350 },
    codeRefs: [capabilityRef("lib/d-e-software-closure.mjs", "markDSoftwareUnknownOutcome", "D 结果未知")],
    testRefs: [capabilityRef("tests/recovery-classification.test.mjs", "test(", "恢复分类测试")]
  }),
  capability({
    id: "8.3", capabilityId: "runtime.exception-case", areaId: "8",
    title: "真正未知异常才建立维修案件", technicalName: "ExceptionCase",
    plainDescription: "只有现有软件规则无法分类的系统异常，才保存脱敏维修案件；它不表示 Codex 已经在线。",
    serves: "技术维护人员",
    inputs: ["真正未知系统异常", "脱敏证据和原作业身份"],
    outputs: ["持久 ExceptionCase", "保持停止的业务状态"],
    integrationStatus: "partial", flowClass: "exception", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "ExceptionCase 状态机和离线门禁存在；完整 UI 详情仍需增强。" },
    ownerAction: "主人决定是否授权一次技术维护轮。",
    stopConditions: "商业确认、权限不足和已知技术失败不得伪装成未知异常。",
    breakpoint: "维护仍是施工期能力，不是在线正常服务。",
    nextStep: "取得维护授权后才能进入 8.4。",
    position: { x: 420, y: 220 },
    aliases: ["旧 8.1"],
    codeRefs: [capabilityRef("lib/software-execution-state.mjs", "openExceptionCase", "异常案件")],
    testRefs: [capabilityRef("tests/codex-independence.test.mjs", "test(", "Codex 离线门禁测试")]
  }),
  capability({
    id: "8.4", capabilityId: "runtime.codex-maintenance", areaId: "8",
    title: "Codex 只做异常诊断和修复", technicalName: "Exception maintenance",
    plainDescription: "Codex 只在真实维护轮中检查异常、修代码和做回归，不能提供正常商品结果。",
    serves: "真正未知系统异常",
    inputs: ["已授权 ExceptionCase", "安全脱敏证据"],
    outputs: ["诊断、代码修复和回归建议", "不推进业务阶段"],
    integrationStatus: "isolated", flowClass: "exception", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "维护门禁存在；维护本身不是正常生产能力。" },
    ownerAction: "主人只授权精确维护范围，不授权 Codex 代跑业务。",
    codexRule: "这里是唯一允许 Codex 出现的地图位置。",
    stopConditions: "不得读取秘密、执行正常平台动作或直接修改业务结论。",
    breakpoint: "没有持久维护轮时不能显示“Codex处理中”。",
    nextStep: "修复后进入 8.5 回归验证。",
    position: { x: 780, y: 220 },
    codeRefs: [capabilityRef("lib/codex-independence.mjs", "assertExceptionCaseMaintenanceBoundary", "异常维护边界")],
    testRefs: [capabilityRef("tests/codex-independence.test.mjs", "test(", "Codex 独立性测试")]
  }),
  capability({
    id: "8.5", capabilityId: "runtime.regression-resume", areaId: "8",
    title: "回归通过后交还原状态机", technicalName: "Recovery verification",
    plainDescription: "维护结果通过局部和回归验证后，只把证据交还原状态机，由它按新 revision 决定是否继续。",
    serves: "发生异常的原始阶段",
    inputs: ["修复结果", "局部测试和回归证据"],
    outputs: ["已验证恢复证据", "回到原断点重新判断"],
    integrationStatus: "partial", flowClass: "exception", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "恢复原则明确；尚未形成所有阶段统一的恢复验收记录。" },
    ownerAction: "需要新业务授权时仍由主人重新确认。",
    stopConditions: "验证失败或原输入已变化时继续保持停止。",
    breakpoint: "恢复证据尚未统一进入能力地图。",
    nextStep: "按原阶段、原对象和新 revision 返回。",
    position: { x: 1140, y: 220 },
    codeRefs: [capabilityRef("lib/software-execution-state.mjs", "resolveExceptionCase", "异常恢复")],
    testRefs: [capabilityRef("tests/software-execution-state.test.mjs", "test(", "异常恢复测试")]
  }),
  capability({
    id: "8.6", capabilityId: "runtime.central-multi-user", areaId: "8",
    title: "让中央服务和多 Worker 接管运行", technicalName: "Multi-user central runtime",
    plainDescription: "未来由中央服务保存唯一状态，本机 Worker 只领取分配给自己的作业；当前尚未实现。",
    serves: "未来 3—5 人内部协作",
    inputs: ["中央数据库、身份、队列、租约和店铺隔离"],
    outputs: ["可多机续作的中央状态和受控作业"],
    registrationState: "unknown", integrationStatus: "not_implemented", runtimeScope: "not_available",
    mainlineQualification: "owner_decision", normalPathAllowed: false,
    baselineHealth: { state: "unverified", reason: "只有边界、迁移阶段和本地适配器，没有中央运行闭环。" },
    ownerAction: "当前只能按本地开发使用，不能宣称多人就绪。",
    stopConditions: "中央状态、身份、租约和迁移未验收前保持未实现。",
    breakpoint: "缺少中央数据库、正式身份、持久队列和多 Worker 验收。",
    nextStep: "按单机多身份、中央测试、两人试用、迁移、多 Worker 顺序推进。",
    position: { x: 780, y: 500 },
    aliases: ["旧 8.2"],
    codeRefs: [capabilityRef("lib/multi-user-central-runtime.mjs", "MULTI_USER_MIGRATION_STAGES", "多人迁移阶段")],
    uiRefs: [capabilityRef("src/components/HeaderStatus.jsx", "HeaderStatus", "顶栏运行方式提示")],
    testRefs: [capabilityRef("tests/multi-user-central-runtime.test.mjs", "test(", "中央运行边界测试")]
  })
]);

const edgeHealth = (state, reason) => ({ state, reason });

export const CAPABILITY_RELATIONS = Object.freeze([
  relation({ id: "r-1.1-1.2", from: "1.1", to: "1.2", kind: "normal", label: "保存业务变化", condition: "有明确状态变化", health: edgeHealth("unverified", "本地事务接线存在，当前验证回执未知。") }),
  relation({ id: "r-1.1-1.5", from: "1.1", to: "1.5", kind: "reference_only", label: "只读展示当前状态", condition: "评审台读取服务端状态", normalPathAllowed: false, health: edgeHealth("risk", "主源码 UI 已接入，但 4317 运行副本与主源码不同。") }),
  relation({ id: "r-1.2-1.3", from: "1.2", to: "1.3", kind: "optional", label: "需要异步动作时创建作业", condition: "当前阶段需要软件作业", health: edgeHealth("risk", "只有部分阶段使用通用作业存储。") }),
  relation({ id: "r-1.1-2.1", from: "1.1", to: "2.1", kind: "normal", label: "进入 A 阶段", condition: "候选已保存", health: edgeHealth("unverified", "入口存在，当前新鲜验证未知。") }),
  relation({ id: "r-2.1-2.2", from: "2.1", to: "2.2", kind: "optional", label: "缺销售证据时只读采集", condition: "没有当前可追溯销售证据", health: edgeHealth("risk", "依赖本机浏览器和登录态。") }),
  relation({ id: "r-2.1-2.3", from: "2.1", to: "2.3", kind: "optional", label: "缺供应证据时只读采集", condition: "没有精确供应 SKU 证据", health: edgeHealth("risk", "依赖本机浏览器和登录态。") }),
  relation({ id: "r-2.1-2.4", from: "2.1", to: "2.4", kind: "optional", label: "已有可靠证据可直接整理", condition: "已有同款、当前、可追溯证据", health: edgeHealth("unverified", "证据复用仍需逐项校验。") }),
  relation({ id: "r-2.2-2.4", from: "2.2", to: "2.4", kind: "merge", label: "提交销售证据", condition: "采集完成并通过身份校验", health: edgeHealth("risk", "真实页面可用性未验证。") }),
  relation({ id: "r-2.3-2.4", from: "2.3", to: "2.4", kind: "merge", label: "提交供应证据", condition: "采集完成并保持待主人选择", health: edgeHealth("risk", "采集不能自动确认 SKU。") }),
  relation({ id: "r-2.4-2.5", from: "2.4", to: "2.5", kind: "optional", label: "可选 AI 整理", condition: "已创建正式 AI 作业", health: edgeHealth("unverified", "4318 当前可用性未验证。") }),
  relation({ id: "r-2.4-2.6", from: "2.4", to: "2.6", kind: "normal", label: "生成确认卡", condition: "证据已整理", health: edgeHealth("unverified", "领域接线存在，当前验证未知。") }),
  relation({ id: "r-2.5-2.6", from: "2.5", to: "2.6", kind: "merge", label: "建议只作辅助", condition: "AI 回执有效", health: edgeHealth("unverified", "AI 建议不能替代事实。") }),
  relation({ id: "r-2.6-2.7", from: "2.6", to: "2.7", kind: "human_gate", label: "等待主人确认", condition: "确认卡完整", health: edgeHealth("unverified", "UI 人类确认门存在。") }),
  relation({ id: "r-2.7-2.3", from: "2.7", to: "2.3", kind: "loop", label: "缺证据时返回补采", condition: "主人发现供应证据不足", normalPathAllowed: false, health: edgeHealth("risk", "返回只能新建一次受控采集。") }),
  relation({ id: "r-2.7-2.8", from: "2.7", to: "2.8", kind: "normal", label: "确认后冻结", condition: "主人确认精确供应 SKU", health: edgeHealth("unverified", "冻结接线存在，当前验证未知。") }),
  relation({ id: "r-2.8-3.1", from: "2.8", to: "3.1", kind: "normal", label: "交给 B", condition: "A 冻结完成", health: edgeHealth("unverified", "A→B 边界存在。") }),
  relation({ id: "r-3.1-3.2", from: "3.1", to: "3.2", kind: "parallel", label: "并行取得平台费用", condition: "需要当前费用证据", health: edgeHealth("unverified", "真实外部证据未验证。") }),
  relation({ id: "r-3.1-3.3", from: "3.1", to: "3.3", kind: "parallel", label: "并行取得物流与汇率", condition: "需要当前物流和汇率", health: edgeHealth("unverified", "真实外部证据未验证。") }),
  relation({ id: "r-3.2-3.4", from: "3.2", to: "3.4", kind: "merge", label: "平台费用到齐", condition: "适用键一致且有效", health: edgeHealth("unverified", "等待与其他成本汇合。") }),
  relation({ id: "r-3.3-3.4", from: "3.3", to: "3.4", kind: "merge", label: "物流汇率到齐", condition: "适用键一致且有效", health: edgeHealth("unverified", "等待与其他成本汇合。") }),
  relation({ id: "r-3.4-3.5", from: "3.4", to: "3.5", kind: "normal", label: "完整后计算利润", condition: "全部应计成本齐全", health: edgeHealth("unverified", "领域计算接线存在。") }),
  relation({ id: "r-3.5-3.6", from: "3.5", to: "3.6", kind: "normal", label: "通过后原子交接", condition: "正式利润通过", health: edgeHealth("unverified", "幂等交接代码存在。") }),
  relation({ id: "r-3.6-4.1", from: "3.6", to: "4.1", kind: "parallel", label: "准备商品事实", condition: "C1 交接已创建", health: edgeHealth("unverified", "C1 领域入口存在。") }),
  relation({ id: "r-3.6-4.2", from: "3.6", to: "4.2", kind: "parallel", label: "准备关键词材料", condition: "C1 交接已创建", health: edgeHealth("unverified", "本地材料准备存在。") }),
  relation({ id: "r-4.2-4.3", from: "4.2", to: "4.3", kind: "normal", label: "创建持久作业", condition: "查询材料完整", health: edgeHealth("blocked", "未接通通用 SoftwareJobStore。") }),
  relation({ id: "r-4.3-4.4", from: "4.3", to: "4.4", kind: "normal", label: "只执行一次来源", condition: "作业已持久且获授权", health: edgeHealth("blocked", "正式耐久队列与运行开关未完成。") }),
  relation({ id: "r-4.4-4.5", from: "4.4", to: "4.5", kind: "normal", label: "归一化和评分", condition: "取得可验证来源回执", health: edgeHealth("blocked", "上游正常作业未接通。") }),
  relation({ id: "r-4.1-4.6", from: "4.1", to: "4.6", kind: "merge", label: "商品事实到齐", condition: "事实有来源或明确 unknown", health: edgeHealth("unverified", "等待关键词支路汇合。") }),
  relation({ id: "r-4.5-4.6", from: "4.5", to: "4.6", kind: "merge", label: "关键词证据到齐", condition: "K3 结果 ready", health: edgeHealth("blocked", "正式关键词支路未闭环。") }),
  relation({ id: "r-4.6-4.7", from: "4.6", to: "4.7", kind: "normal", label: "保存 C1 方案", condition: "草稿合同和事实绑定通过", health: edgeHealth("blocked", "完整 C1 正常作业未闭环。") }),
  relation({ id: "r-4.7-5.1", from: "4.7", to: "5.1", kind: "normal", label: "创建 C2", condition: "C1 完整结果已持久化", health: edgeHealth("blocked", "这是当前 C1→C2 的真实断点。") }),
  relation({ id: "r-5.1-5.2", from: "5.1", to: "5.2", kind: "reference_only", label: "保留参考素材", condition: "存在参考素材", normalPathAllowed: false, health: edgeHealth("unverified", "明确禁止进入 D。") }),
  relation({ id: "r-5.1-5.3", from: "5.1", to: "5.3", kind: "reference_only", label: "保留 AI 草稿", condition: "存在 AI 草稿", normalPathAllowed: false, health: edgeHealth("unverified", "明确禁止自动升级。") }),
  relation({ id: "r-5.1-5.4", from: "5.1", to: "5.4", kind: "normal", label: "等待最终素材", condition: "主人提供最终文件", health: edgeHealth("unverified", "上传入口存在。") }),
  relation({ id: "r-5.2-5.4", from: "5.2", to: "5.4", kind: "reference_only", label: "只供主人参考", condition: "主人自行重新提供最终文件", normalPathAllowed: false, health: edgeHealth("unverified", "不能自动复制到 finalUploads。") }),
  relation({ id: "r-5.3-5.4", from: "5.3", to: "5.4", kind: "reference_only", label: "只供主人参考", condition: "主人自行重新提供最终文件", normalPathAllowed: false, health: edgeHealth("unverified", "不能自动提升草稿。") }),
  relation({ id: "r-5.4-5.5", from: "5.4", to: "5.5", kind: "human_gate", label: "等待主人确认最终素材", condition: "清单、顺序、首图和 SHA 有效", health: edgeHealth("unverified", "确认门存在。") }),
  relation({ id: "r-5.5-6.1", from: "5.5", to: "6.1", kind: "human_gate", label: "另行等待生产授权", condition: "最终商品方案已确认", health: edgeHealth("unverified", "C2 确认不自动授权 D。") }),
  relation({ id: "r-6.1-6.2", from: "6.1", to: "6.2", kind: "normal", label: "按授权生成计划", condition: "授权已持久化", health: edgeHealth("risk", "身份字段和历史 mode 仍需收敛。") }),
  relation({ id: "r-6.1-6.5", from: "6.1", to: "6.5", kind: "parallel", label: "另行准备最终素材地址", condition: "主人明确确认本次 OSS 素材传输", health: edgeHealth("risk", "受控入口存在，但本轮未真实上传。") }),
  relation({ id: "r-6.2-6.3", from: "6.2", to: "6.3", kind: "parallel", label: "并行执行写前检查", condition: "计划与授权绑定一致", health: edgeHealth("risk", "店铺与 Worker 身份尚未完整。") }),
  relation({ id: "r-6.3-6.4", from: "6.3", to: "6.4", kind: "merge", label: "写前检查到齐", condition: "全部前检通过", health: edgeHealth("blocked", "Seller API 服务端执行路由缺失。") }),
  relation({ id: "r-6.5-6.4", from: "6.5", to: "6.4", kind: "merge", label: "素材地址到齐", condition: "全部 finalUploads 已取得稳定地址", health: edgeHealth("blocked", "OSS 结果尚未接入正式 Seller API 执行链。") }),
  relation({ id: "r-6.4-6.6", from: "6.4", to: "6.6", kind: "planned", label: "Ozon Seller API 分支", condition: "授权目标为 Ozon", health: edgeHealth("blocked", "真实 Ozon 商品写入未接通。") }),
  relation({ id: "r-6.4-6.8", from: "6.4", to: "6.8", kind: "planned", label: "WB 分支", condition: "授权目标为 WB", health: edgeHealth("unverified", "WB 能力尚未实现。") }),
  relation({ id: "r-6.6-6.7", from: "6.6", to: "6.7", kind: "normal", label: "保存 Ozon 真实回执", condition: "平台身份和回执完整", health: edgeHealth("blocked", "没有正式运行回执。") }),
  relation({ id: "r-6.8-6.7", from: "6.8", to: "6.7", kind: "planned", label: "未来保存 WB 回执", condition: "WB 写入未来实现", health: edgeHealth("unverified", "尚未实现。") }),
  relation({ id: "r-6.7-7.1", from: "6.7", to: "7.1", kind: "normal", label: "交给独立回读", condition: "ProductionRecord 已持久化", health: edgeHealth("blocked", "D 没有正式输出。") }),
  relation({ id: "r-7.1-7.2", from: "7.1", to: "7.2", kind: "planned", label: "Ozon 只读分支", condition: "平台为 Ozon", health: edgeHealth("blocked", "独立 Ozon provider 未接通。") }),
  relation({ id: "r-7.1-7.4", from: "7.1", to: "7.4", kind: "planned", label: "WB 只读分支", condition: "平台为 WB", health: edgeHealth("unverified", "WB provider 尚未实现。") }),
  relation({ id: "r-7.2-7.3", from: "7.2", to: "7.3", kind: "merge", label: "核对 Ozon 结果", condition: "取得独立观察", health: edgeHealth("blocked", "没有正式独立观察。") }),
  relation({ id: "r-7.4-7.3", from: "7.4", to: "7.3", kind: "planned", label: "未来核对 WB 结果", condition: "取得独立观察", health: edgeHealth("unverified", "尚未实现。") }),

  relation({ id: "r-2.2-8.1", from: "2.2", to: "8.1", kind: "exception", label: "采集技术失败", condition: "已知权限、网络、页面或解析失败", normalPathAllowed: false, health: edgeHealth("risk", "已知失败必须软件停机。") }),
  relation({ id: "r-2.3-8.1", from: "2.3", to: "8.1", kind: "exception", label: "采集技术失败", condition: "已知权限、网络、页面或解析失败", normalPathAllowed: false, health: edgeHealth("risk", "已知失败必须软件停机。") }),
  relation({ id: "r-4.4-8.1", from: "4.4", to: "8.1", kind: "exception", label: "关键词来源失败", condition: "登录、额度、网络或 Schema 失败", normalPathAllowed: false, health: edgeHealth("risk", "不得写成 true_empty。") }),
  relation({ id: "r-6.5-8.2", from: "6.5", to: "8.2", kind: "exception", label: "素材传输终态未知", condition: "OSS 请求已发出但无法确认结果", normalPathAllowed: false, health: edgeHealth("blocked", "必须先对账，禁止重发。") }),
  relation({ id: "r-6.6-8.2", from: "6.6", to: "8.2", kind: "exception", label: "平台写入终态未知", condition: "Seller API 请求已发出但无法确认结果", normalPathAllowed: false, health: edgeHealth("blocked", "必须先对账，禁止重发。") }),
  relation({ id: "r-7.2-8.2", from: "7.2", to: "8.2", kind: "exception", label: "回读结果未知", condition: "无法判断平台当前终态", normalPathAllowed: false, health: edgeHealth("blocked", "不得显示已验证。") }),
  relation({ id: "r-8.2-8.3", from: "8.2", to: "8.3", kind: "exception", label: "仅真正未知异常建案", condition: "现有软件规则无法分类", normalPathAllowed: false, health: edgeHealth("unverified", "商业或已知失败不能进入。") }),
  relation({ id: "r-8.3-8.4", from: "8.3", to: "8.4", kind: "human_gate", label: "授权一次维护轮", condition: "主人明确授权技术维护", normalPathAllowed: false, health: edgeHealth("unverified", "没有维护轮不能显示 Codex 介入。") }),
  relation({ id: "r-8.4-8.5", from: "8.4", to: "8.5", kind: "recovery", label: "修复后回归验证", condition: "代码或配置修复完成", normalPathAllowed: false, health: edgeHealth("unverified", "验证失败继续保持停止。") }),
  relation({ id: "r-8.5-2.6", from: "8.5", to: "2.6", kind: "recovery", label: "返回 A 原断点", condition: "异常来自 A 且新 revision 有效", normalPathAllowed: false, health: edgeHealth("unverified", "由状态机重判，不自动通过。") }),
  relation({ id: "r-8.5-4.3", from: "8.5", to: "4.3", kind: "recovery", label: "返回 C1 原断点", condition: "异常来自 C1 且新 revision 有效", normalPathAllowed: false, health: edgeHealth("blocked", "C1 主断点尚未修复。") }),
  relation({ id: "r-8.5-6.4", from: "8.5", to: "6.4", kind: "recovery", label: "返回 D 原断点", condition: "异常来自 D 且已完成对账", normalPathAllowed: false, health: edgeHealth("blocked", "D 正常路线未接通。") }),
  relation({ id: "r-8.5-7.1", from: "8.5", to: "7.1", kind: "recovery", label: "返回 E 原断点", condition: "异常来自 E 且身份仍一致", normalPathAllowed: false, health: edgeHealth("blocked", "E 正常路线未接通。") })
]);

export const UNPLACED_CAPABILITIES = Object.freeze([
  unplaced({
    id: "9.1", title: "历史候选分派地图", status: "temporarily_retained",
    plainDescription: "旧 M01—M12 负责历史候选分派、留言和恢复，不是代码健康地图。",
    reason: "后端仍有历史调用，当前不能直接删除；同时绝不能接回正常 A→E。",
    candidateTargets: ["只保留在历史兼容与审计区"],
    missingEvidence: ["全部真实调用方清单", "历史数据迁移与退役验收"],
    evidenceRefs: [capabilityRef("lib/workflow-map.mjs", "Legacy dispatch/comment compatibility", "历史兼容声明")],
    artifactRefs: ["lib/workflow-map.mjs", "data/workflow-map.json"]
  }),
  unplaced({
    id: "9.2", title: "旧 Codex 分派与协作路线", status: "retirement_candidate",
    plainDescription: "旧代码会把候选交给 Codex 任务处理；正常商品已经禁止依赖这条路线。",
    reason: "仍有历史路由和数据读取，需先证明无正常调用方。",
    candidateTargets: ["8.3—8.5 真正异常维护", "历史只读审计"],
    missingEvidence: ["正常路径不可达证明", "历史记录迁移决定", "主人确认退役"],
    evidenceRefs: [capabilityRef("lib/codex-dispatcher.mjs", "CodexDispatcher", "旧分派器")],
    artifactRefs: ["lib/codex-dispatcher.mjs", "tests/codex-dispatcher.test.mjs", "tests/dispatch-api.test.mjs", "tests/dispatch-delivery-integration.test.mjs", "tests/structured-dispatch-integration.test.mjs"]
  }),
  unplaced({
    id: "9.3", title: "第2A模拟验收", status: "temporarily_retained",
    identityState: "simulation", wiringStatus: "isolated", verificationStatus: "test_files_present_not_run",
    plainDescription: "用固定模拟数据演示 A→B→C1，不读取真实候选，也不访问平台。",
    reason: "可用于讲解和测试，但不能进入真实主线或作为业务完成证据。",
    candidateTargets: ["隔离沙盒与培训入口"],
    missingEvidence: ["主人决定长期保留还是退役"],
    evidenceRefs: [capabilityRef("lib/phase-2a-simulation.mjs", "runPhase2AConfirmation", "第2A模拟")],
    artifactRefs: ["lib/phase-2a-simulation.mjs", "src/components/Phase2ASimulation.jsx", "tests/phase-2a-simulation.test.mjs", "tests/phase-2a-api-guards.test.mjs"]
  }),
  unplaced({
    id: "9.4", title: "旧 C1 / FireTrain 兼容代码", status: "retirement_candidate",
    plainDescription: "旧特殊商品生产工厂已删除，服务端旧入口返回410；仅保留历史输入读取和旧C阶段兼容模块。",
    reason: "历史输入读取仍供审计使用，正式测试经A/B/C1领域函数生成，不再借旧工厂直达C2。",
    candidateTargets: ["4.1—4.7 正式 C1", "5.1—5.5 正式 C2"],
    missingEvidence: ["旧C阶段兼容模块的调用方收敛", "完整替代链服务验收"],
    evidenceRefs: [capabilityRef("lib/real-c1-preparation.mjs", "readLegacyC1PreparationInputs", "旧 C1 只读输入")],
    artifactRefs: ["lib/real-c1-preparation.mjs", "lib/lifecycle-c-stage.mjs", "tests/real-c1-preparation.test.mjs"]
  }),
  unplaced({
    id: "9.5", title: "分阶段构建与部署边界", status: "temporarily_retained",
    identityState: "official", wiringStatus: "isolated", verificationStatus: "test_files_present_not_run",
    plainDescription: "这些代码打包或检查阶段产物，服务开发发布，不推进任何商品。",
    reason: "属于工程辅助，不应画进 A→E；是否继续保留由发布流程决定。",
    candidateTargets: ["工程辅助能力区"],
    missingEvidence: ["七个历史build-phase脚本本轮未集成；当前仅保留边界模块", "统一构建策略"],
    evidenceRefs: [capabilityRef("lib/phase3-ab-deployment-boundary.mjs", "PHASE3_AB_RUNTIME_FILES", "阶段部署边界")],
    artifactRefs: [
      "lib/phase3-ab-deployment-boundary.mjs", "lib/phase4-c1-deployment-boundary.mjs", "lib/phase4-c1-fact-keyword-deployment-boundary.mjs",
      "lib/phase4-c1-keyword-auto-trigger-deployment-boundary.mjs", "lib/phase4-k3-c1-deployment-boundary.mjs", "lib/phase5-c2-deployment-boundary.mjs",
      "lib/phase5b-c2-ui-deployment-boundary.mjs"
    ],
    historicalArtifactRefs: ["scripts/build-phase3-ab-deploy-package.mjs", "scripts/build-phase4-c1-deploy-package.mjs",
      "scripts/build-phase4-c1-fact-keyword-deploy-package.mjs", "scripts/build-phase4-c1-keyword-auto-trigger-deploy-package.mjs",
      "scripts/build-phase4-k3-c1-deploy-package.mjs", "scripts/build-phase5-c2-deploy-package.mjs", "scripts/build-phase5b-c2-ui-deploy-package.mjs"
    ]
  }),
  unplaced({
    id: "9.6", title: "本机启动与运行副本部署脚本", status: "awaiting_placement",
    identityState: "candidate", wiringStatus: "partial", verificationStatus: "source_changed_revalidation_required",
    plainDescription: "这些脚本用于本地启动、代码包准备与部署前核验，不属于商品业务能力。verify-package-with-real-env.mjs 用实际配置键和无活跃作业的数据副本，在系统隔离内验证新包；仅测试端口可访问，外网、凭据和子进程被禁止。该核验不会安装或授权部署。",
    reason: "4317 由独立 Application Support 副本运行；代码包准备、隔离启动验证、正式授权及安装后回读必须分别记录。正式切换仍须当前部署确认卡。",
    candidateTargets: ["工程辅助能力区", "退役候选"],
    missingEvidence: ["当前发布流程验收", "脏工作树部署保护", "主人保留/退役决定"],
    evidenceRefs: [],
    artifactRefs: ["scripts/dev.mjs", "scripts/launch-server.sh", "scripts/deploy-local-runtime.sh",
      "scripts/verify-package-with-real-env.mjs", "scripts/local-process-sandbox-profile.mjs", "tests/local-process-sandbox-profile.test.mjs", "tests/runtime-preflight-api.test.mjs", "scripts/deployment-diagnostic-redaction.mjs",
      "tests/deployment-diagnostic-redaction.test.mjs", "package.json", "vite.config.js"]
  }),
  unplaced({
    id: "9.7", title: "Ozon D/E 多套候选实现", status: "suspected_duplicate",
    plainDescription: "仓库里有生产适配器、D/E组合适配器、策略、探针和草稿执行等相近能力，但没有一条正式生产主线。",
    reason: "它们可能分工，也可能部分重复；必须按输入输出和调用方比较后才能指定唯一正式实现。",
    candidateTargets: ["6.3—6.6 Ozon D", "7.1—7.3 Ozon E"],
    missingEvidence: ["逐导出调用图", "真实协议与店铺身份", "唯一正式实现决定"],
    evidenceRefs: [capabilityRef("lib/ozon-seller-api-de-adapter.mjs", "inspectAdapterCapabilities", "D/E 适配器能力")],
    artifactRefs: ["lib/ozon-seller-api-de-adapter.mjs", "lib/ozon-production-strategy.mjs", "lib/draft-production-execution.mjs", "lib/post-launch-observation.mjs"]
  }),
  unplaced({
    id: "9.8", title: "历史候选只读适配", status: "temporarily_retained",
    plainDescription: "把旧候选转换成可查看的 OpportunityPackage，但 unknown 仍保持 unknown。",
    reason: "评审台仍需查看历史数据，不能直接删除；不得让它推进新版生命周期。",
    candidateTargets: ["1.1 历史只读投影", "2.1 新版候选入口"],
    missingEvidence: ["历史候选迁移策略", "何时停止兼容读取"],
    evidenceRefs: [capabilityRef("lib/legacy-candidate-adapter.mjs", "LEGACY_ADAPTER_MODE", "历史只读适配")],
    artifactRefs: ["lib/legacy-candidate-adapter.mjs", "lib/real-lifecycle-entry-preview.mjs", "tests/legacy-candidate-adapter.test.mjs"]
  }),
  unplaced({
    id: "9.9", title: "旧扁平业务状态与人工上架回读", status: "temporarily_retained",
    plainDescription: "旧 workflow 把多个阶段混在候选状态里，还保留人工标记已上架和手工回读入口。",
    reason: "server 和评审台仍有调用；它只能作为历史兼容，不能冒充 D 写入或 E 独立回读。",
    candidateTargets: ["1.1 历史状态兼容", "6/7 区历史人工支路"],
    missingEvidence: ["逐个旧 API 的当前调用方", "历史记录迁移方案", "主人决定保留或退役"],
    evidenceRefs: [capabilityRef("lib/workflow.mjs", "validateListingRecord", "旧人工上架记录"), capabilityRef("lib/workflow.mjs", "validateListingReadback", "旧人工回读校验"), capabilityRef("src/api.js", "applyListingReadback", "旧手工回读 API")],
    artifactRefs: ["lib/workflow.mjs", "tests/workflow.test.mjs", "tests/post-launch-observation.test.mjs"]
  }),
  unplaced({
    id: "9.10", title: "当前 14 节点三店地图草稿", status: "awaiting_placement",
    identityState: "candidate", wiringStatus: "partial", mainlineQualification: "engineering_support",
    verificationStatus: "source_changed_revalidation_required",
    plainDescription: "主源码已有一张 14 节点只读静态地图，但它没有读取本注册表，4317 运行副本也没有对应 API。",
    reason: "这是现有 UI 草稿，不是已经冻结的能力真相；继续并存会形成两套地图事实。",
    candidateTargets: ["以后由三店地图 UI 读取本注册表的只读投影"],
    missingEvidence: ["单一注册表迁移验收", "4317 或未来运行环境的部署验收"],
    evidenceRefs: [capabilityRef("lib/three-store-map.mjs", "THREE_STORE_MAP_REGISTRY", "旧静态地图定义"), capabilityRef("src/components/ThreeStoreMap.jsx", "ThreeStoreMap", "地图 UI 草稿")],
    artifactRefs: ["lib/three-store-map.mjs", "src/components/ThreeStoreMap.jsx", "src/components/WorkflowMap.jsx", "tests/three-store-map.test.mjs", "tests/three-store-map-api.test.mjs", "tests/three-store-map-ui-contract.test.mjs"]
  }),
  unplaced({
    id: "9.11", title: "未集成的历史重复服务文件", status: "retirement_candidate", resolutionStatus: "historical_only",
    plainDescription: "历史工作树有 server 2.mjs；当前集成线明确不包含这份重复服务。",
    reason: "保留编号和历史来源，不把不存在的文件登记为当前源码。",
    candidateTargets: ["历史档案"],
    missingEvidence: ["历史文件的外部手工调用方未核查"],
    evidenceRefs: [], artifactRefs: [], historicalArtifactRefs: ["server 2.mjs"],
    calledBy: [], calls: [], wiringStatus: "not_implemented", sideEffects: ["none"]
  }),
  unplaced({
    id: "9.12", title: "历史一次性数据变更脚本", status: "retirement_candidate", resolutionStatus: "historical_only",
    plainDescription: "历史脚本用于迁移、回填或标记旧候选数据，本轮未集成。",
    reason: "它们没有业务调用方且可能改共享数据；本轮只登记，绝不执行。",
    candidateTargets: ["历史迁移档案", "确认退役"],
    missingEvidence: ["每个脚本最后使用时间", "是否已有等价迁移记录", "主人确认退役"],
    evidenceRefs: [], artifactRefs: [], calledBy: [], calls: [],
    historicalArtifactRefs: [
      "scripts/accept-dd-h1-wb-test-risk.mjs", "scripts/apply-2026-08-04-needs-audit.mjs", "scripts/apply-2026-08-04-triage.mjs",
      "scripts/apply-immediate-dispatch.mjs", "scripts/backfill-direction-ceilings.mjs", "scripts/mark-dd-h1-ozon-only.mjs",
      "scripts/migrate-electrical-rule.mjs", "scripts/migrate-processing-source-gaps.mjs", "scripts/migrate-v2.mjs",
      "scripts/normalize-processing-states.mjs", "scripts/pause-dd-h1-listing-tests.mjs", "scripts/update-dd-h1-wb-evidence-gap.mjs"
    ]
  }),
  unplaced({
    id: "9.13", title: "Ozon D/E 只读能力探针", status: "awaiting_placement",
    identityState: "experimental", wiringStatus: "isolated",
    plainDescription: "探测候选 Ozon D/E 适配器具备哪些只读能力，目前只被测试使用。",
    reason: "没有 server 或 UI 调用，不能把探针结果当作正式 E 回读。",
    candidateTargets: ["7.2 正式只读 provider 的验收工具", "隔离工程诊断"],
    missingEvidence: ["真实调用范围", "与正式 provider 的合同关系", "主人决定是否保留"],
    evidenceRefs: [capabilityRef("lib/ozon-de-readonly-capability-probe.mjs", "probeOzonDEReadOnlyCapabilities", "只读能力探针")],
    artifactRefs: ["lib/ozon-de-readonly-capability-probe.mjs", "tests/ozon-de-readonly-capability-probe.test.mjs"]
  }),
  unplaced({
    id: "9.14", title: "已收敛的旧 B 利润流程", status: "retirement_candidate", resolutionStatus: "consolidated",
    plainDescription: "旧测试专用B模块已移除，五条回归迁入正式利润模型测试。",
    reason: "正式利润复用单一未舍入计算；自动C1由现有A/B组合层负责。",
    candidateTargets: ["3.5 正式利润", "3.6 B通过后的原子C1交接"],
    missingEvidence: [], ownerDecisionRequired: false, calledBy: [], calls: [], sideEffects: ["none"],
    evidenceRefs: [capabilityRef("tests/profit-model.test.mjs", "corrected B quote", "0.21kg费用与未舍入利润回归")],
    artifactRefs: [], historicalArtifactRefs: ["lib/product-lifecycle-b-flow.mjs", "tests/single-sku-b-flow.test.mjs"]
  })
]);

export const CAPABILITY_ARTIFACT_ASSIGNMENTS = Object.freeze([
  artifactAssignment(
    "11.1",
    "本机启动、依赖锁定和入口文件",
    ["9.6"],
    "这些文件只负责本机安装、启动、浏览器入口和依赖版本，不推进 SKU，也不代表中央运行。",
    [
      "scripts/ci-api-boundary.mjs",
      "scripts/ci-test-policy.mjs",
      "scripts/ci-test-suites.mjs",
      "scripts/run-ci-api-tests.mjs",
      "scripts/run-ci-tests.mjs",
      "scripts/run-local-api-tests.mjs",
      "com.shuaizhang.selection-review-open-chrome.plist",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "scripts/open-review-in-chrome.sh",
      "启动今日选品评审台.command"
    ]
  ),
  artifactAssignment(
    "11.2",
    "评审台通用展示层",
    ["1.5"],
    "这些文件把服务端状态整理成主人可见的列表、状态、规则和进度，不是独立业务处理模块。",
    [
      "lib/candidate-initialization.mjs",
      "src/formState.js",
      "src/finiteDisplay.js",
      "src/commentInput.js",
      "src/components/FormRevisionNotice.jsx",
      "src/components/useDialogFocus.js",
      "tests/frontend-review-behavior.test.mjs",
      "tests/candidate-navigation.test.mjs",
      "lib/candidate-comment-boundary.mjs",
      "lib/candidate-user-fields.mjs",
      "tests/candidate-comment-boundary.test.mjs",
      "tests/candidate-user-fields.test.mjs",
      "src/candidateViews.js",
      "src/components/DailyProgress.jsx",
      "src/components/Icons.jsx",
      "src/components/LifecycleStatusCard.jsx",
      "src/components/OperatingRules.jsx",
      "src/components/ProcessingBreakdown.jsx",
      "src/components/QueueTabs.jsx",
      "src/components/StatusBadge.jsx",
      "src/constants.js",
      "src/lifecycleStatusView.js"
    ]
  ),
  artifactAssignment(
    "11.3",
    "A/B 采集、证据和展示支持",
    ["1.1", "2.2", "2.3", "2.4", "3.2", "3.3", "3.4", "9.9", "9.12"],
    "外部GUOO资费表本轮未集成，需按适用范围取得当前资料。这些文件为 A/B 节点提供采集选择、证据读写、物流证据引用、旧 WB 展示和相关测试，不单独构成业务闭环。",
    [
      "lib/a-discovery-contract.mjs",
      "lib/seerfar-discovery-contract.mjs",
      "lib/seerfar-web-discovery-contract.mjs",
      "lib/a-discovery-estimate.mjs",
      "lib/a-discovery-estimate-store.mjs",
      "lib/discovery-market-snapshot.mjs",
      "lib/supplier-draft.mjs",
      "lib/sku-choice-estimate.mjs",
      "lib/sibling-sku-name.mjs",
      "lib/sibling-sku-candidate.mjs",
      "lib/sibling-sku-card-guard.mjs",
      "lib/sibling-batch-a-b-c1.mjs",
      "lib/profit-step-review.mjs",
      "src/selectionDeskView.js",
      "lib/discovery-title-translation.mjs",
      "lib/discovery-title-translation-store.mjs",
      "lib/seerfar-discovery-software-runner.mjs",
      "lib/a-discovery-software-runner.mjs",
      "lib/a-product-detail-contract.mjs",
      "lib/a-product-detail-runner.mjs",
      "lib/linkfox-read-job-runner.mjs",
      "lib/linkfox-discovery-api.mjs",
      "lib/linkfox-discovery-connector.mjs",
      "lib/linkfox-discovery-credentials.mjs",
      "lib/linkfox-gateway-transport.mjs",
      "lib/linkfox-product-detail-api.mjs",
      "lib/linkfox-product-detail-connector.mjs",
      "schema/a-discovery-v1.schema.json",
      "schema/a-discovery-v2.schema.json",
      "schema/a-product-detail-v1.schema.json",
      "schema/software-job-v3.schema.json",
      "tests/a-discovery-api-boundary.test.mjs",
      "tests/a-discovery-candidate-import.test.mjs",
      "tests/a-discovery-contract.test.mjs",
      "tests/seerfar-discovery-contract.test.mjs",
      "tests/seerfar-web-discovery-contract.test.mjs",
      "tests/a-discovery-estimate.test.mjs",
      "tests/a-discovery-estimate-store.test.mjs",
      "tests/discovery-market-snapshot.test.mjs",
      "tests/supplier-draft.test.mjs",
      "tests/supplier-draft-api.test.mjs",
      "tests/sku-choice-estimate.test.mjs",
      "tests/profit-step-review.test.mjs",
      "tests/product-page-ui.test.mjs",
      "tests/selection-desk-view.test.mjs",
      "tests/selection-desk-ui.test.mjs",
      "tests/owner-inbox-board-ui.test.mjs",
      "tests/discovery-title-translation.test.mjs",
      "tests/seerfar-discovery-integration.test.mjs",
      "tests/a-discovery-runtime-configuration.test.mjs",
      "tests/a-discovery-runtime-services.test.mjs",
      "tests/a-discovery-software-job-store.test.mjs",
      "tests/a-discovery-software-runner.test.mjs",
      "tests/a-discovery-ui.test.mjs",
      "tests/a-product-detail-api-boundary.test.mjs",
      "tests/a-product-detail-application.test.mjs",
      "tests/a-product-detail-contract.test.mjs",
      "tests/a-product-detail-evidence.test.mjs",
      "tests/a-product-detail-runner.test.mjs",
      "tests/a-product-detail-runtime-services.test.mjs",
      "tests/a-product-detail-software-job-store.test.mjs",
      "tests/a-product-detail-ui.test.mjs",
      "tests/a-read-restart-filter.test.mjs",
      "tests/fixtures/a-discovery-contract-fixture.mjs",
      "tests/fixtures/a-discovery-runtime-fixture.mjs",
      "tests/fixtures/seerfar-market-entry-replay.mjs",
      "tests/fixtures/seerfar-discovery-runtime-fixture.mjs",
      "tests/fixtures/a-product-detail-contract-fixture.mjs",
      "tests/fixtures/a-product-detail-evidence-fixture.mjs",
      "tests/fixtures/a-product-detail-runtime-fixture.mjs",
      "tests/linkfox-discovery-api.test.mjs",
      "tests/linkfox-discovery-connector.test.mjs",
      "tests/linkfox-product-detail-api.test.mjs",
      "tests/linkfox-product-detail-connector.test.mjs",
      "lib/store-binding.mjs",
      "lib/lifecycle-evidence-scope.mjs",
      "lib/capture-evidence-sanitization.mjs",
      "lib/profit-model-calculation.mjs",
      "lib/profit-threshold-policy.mjs",
      "src/aConfirmationInput.js",
      "src/captureStart.js",
      "tests/store-binding.test.mjs",
      "tests/store-binding-api.test.mjs",
      "tests/lifecycle-evidence-scope.test.mjs",
      "src/aSupplierCaptureSelection.js",
      "src/extensionStatus.js",
      "src/wbPresentation.js",
      "tests/atomic-json-persistence.test.mjs",
      "tests/extension-capture-request.test.mjs",
      "tests/extension-heartbeat-api.test.mjs",
      "tests/extension-status.test.mjs",
      "tests/lifecycle-b-evidence-context.test.mjs",
      "tests/lifecycle-b-evidence-providers.test.mjs",
      "tests/market-sample-policy.test.mjs",
      "tests/ozon-extension-collector.test.mjs",
      "tests/real-a-b-c1-api.test.mjs",
      "tests/real-a-b-evidence-orchestration.test.mjs",
      "tests/real-ozon-sales-snapshot.test.mjs",
      "tests/sales-snapshot.test.mjs",
      "tests/source-capture-api.test.mjs",
      "tests/source-capture-restart-reconciliation.test.mjs",
      "tests/source-capture.test.mjs",
      "tests/sibling-sku-api.test.mjs",
      "tests/sibling-sku-candidate.test.mjs",
      "tests/sibling-batch-a-b-c1.test.mjs",
      "tests/wb-presentation.test.mjs",
      "lib/lifecycle-evidence-validity.mjs",
      "tests/lifecycle-evidence-validity.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.4",
    "C1 事实、关键词和 SEO 支持产物",
    ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"],
    "这些实现、Schema、视图和测试分别支撑 C1 的各个小步骤；文件存在不表示付费关键词主线已接通。",
    [
      "lib/c1-ai-draft-request-source.mjs",
      "lib/c1-draft-runtime-services.mjs",
      "lib/c1-facts-verification-use-case.mjs",
      "lib/c1-color-dictionary-read-use-case.mjs",
      "lib/c1-sibling-color-revision-use-case.mjs",
      "lib/c1-sibling-formal-draft-reuse.mjs",
      "lib/c1-sibling-neutral-copy.mjs",
      "lib/sibling-batch-c1-preparation.mjs",
      "lib/c1-frozen-schema-refresh.mjs",
      "lib/c1-frozen-supply-attribute-backfill-use-case.mjs",
      "lib/c1-ozon-attribute-mapping-use-case.mjs",
      "lib/c1-ozon-attribute-proposal.mjs",
      "lib/ozon-dictionary-value-reader.mjs",
      "lib/c1-zero-point-keyword-metrics.mjs",
      "lib/c1-draft-runtime-view.mjs",
      "lib/c1-review-presentation.mjs",
      "lib/c1-sku-rights-review-submission.mjs",
      "lib/c1-sku-rights-review.mjs",
      "schema/c1-ai-draft-payment-authorization-v1.schema.json",
      "schema/c1-sku-rights-review-record-v1.schema.json",
      "schema/c1-sku-rights-review-v1.schema.json",
      "schema/c1-sibling-formal-reuse-v1.schema.json",
      "src/c1PaidDraftInput.js",
      "src/c1RightsReviewInput.js",
      "src/components/C1PaidDraftPanel.jsx",
      "src/components/C1OzonAttributePanel.jsx",
      "src/components/C1RightsReviewPanel.jsx",
      "tests/c1-draft-paid-flow.test.mjs",
      "tests/c1-frozen-schema-refresh.test.mjs",
      "tests/c1-frozen-supply-attribute-backfill-use-case.test.mjs",
      "tests/c1-attribute-routes-source-contract.test.mjs",
      "tests/c1-ozon-attribute-mapping-use-case.test.mjs",
      "tests/c1-ozon-attribute-proposal.test.mjs",
      "tests/ozon-dictionary-value-reader.test.mjs",
      "tests/c1-draft-runtime-services.test.mjs",
      "tests/c1-keyword-handoff-retry-http.test.mjs",
      "tests/fixtures/c1-keyword-handoff-retry-fixture.mjs",
      "tests/c1-draft-runtime-view.test.mjs",
      "tests/c1-draft-service-configuration.test.mjs",
      "tests/c1-gateway-acceptance.test.mjs",
      "tests/c1-gateway-source-binding.test.mjs",
      "tests/c1-paid-draft-owner-api.test.mjs",
      "tests/c1-rights-review-input.test.mjs",
      "tests/c1-rights-security-boundary.test.mjs",
      "tests/c1-facts-verification-use-case.test.mjs",
      "tests/c1-sku-rights-review-submission.test.mjs",
      "tests/c1-sku-rights-review.test.mjs",
      "tests/fixtures/c1-draft-source-fixture.mjs",
      "tests/fixtures/c1-sku-rights-review-fixture.mjs",
      "tests/fixtures/sibling-color-state.mjs",
      "tests/fixtures/start-sibling-color-preview.mjs",
      "tests/sibling-c1-color-api.test.mjs",
      "tests/sibling-c1-color-transition.test.mjs",
      "tests/c1-sibling-formal-draft-reuse.test.mjs",
      "tests/c1-sibling-neutral-copy.test.mjs",
      "tests/sibling-batch-c1-preparation.test.mjs",
      "tests/sibling-batch-c1-preview-api.test.mjs",
      "lib/listing-preparation-review-boundary.mjs",
      "lib/c1-draft-software-use-case.mjs",
      "lib/c1-draft-software-runtime.mjs",
      "schema/c1-ai-authorized-execution-v1.schema.json",
      "schema/c1-ai-settled-execution-v1.schema.json",
      "tests/c1-ai-software-job-contract.test.mjs",
      "tests/c1-draft-software-use-case.test.mjs",
      "tests/c1-draft-software-runtime.test.mjs",
      "tests/listing-preparation-review-boundary.test.mjs",
      "lib/c1-keyword-planning-evidence-persistence.mjs",
      "lib/c1-keyword-planning-evidence-producer.mjs",
      "lib/c1-keyword-planning-software-use-case.mjs",
      "schema/c1-fact-keyword-pipeline-v1.schema.json",
      "schema/c1-fact-keyword-runtime-input-v1.schema.json",
      "schema/c1-k3-keyword-adapter-v1.schema.json",
      "schema/c1-keyword-planning-evidence-v1.schema.json",
      "schema/c1-keyword-planning-local-material-production-v1.schema.json",
      "schema/c1-keyword-planning-production-v1.schema.json",
      "schema/c1-keyword-planning-source-evidence-v1.schema.json",
      "schema/c1-keyword-planning-source-record-v1.schema.json",
      "schema/c1-software-evidence-stage-v1.schema.json",
      "schema/c1-software-input-preparation-v1.schema.json",
      "schema/keyword-evidence-preparation-v1.schema.json",
      "src/keywordSoftwareRuntimeView.js",
      "tests/c1-fact-keyword-pipeline.test.mjs",
      "tests/c1-fact-keyword-runtime.test.mjs",
      "tests/c1-fact-keyword-server-integration.test.mjs",
      "tests/c1-k3-keyword-adapter.test.mjs",
      "tests/c1-k3-runtime-bridge.test.mjs",
      "tests/c1-keyword-evidence-auto-trigger.test.mjs",
      "tests/c1-keyword-planning-evidence-persistence.test.mjs",
      "tests/c1-keyword-planning-evidence-producer.test.mjs",
      "tests/c1-keyword-planning-local-material.test.mjs",
      "tests/c1-keyword-planning-software-use-case.test.mjs",
      "tests/c1-keyword-software-use-case.test.mjs",
      "tests/c1-software-evidence-stage.test.mjs",
      "tests/c1-software-input-preparation.test.mjs",
      "tests/keyword-evidence-orchestrator.test.mjs",
      "tests/keyword-evidence-provider-adapter.test.mjs",
      "tests/keyword-evidence-ready-event-producer.test.mjs",
      "tests/keyword-evidence-snapshot.test.mjs",
      "tests/keyword-evidence-software-job-state.test.mjs",
      "tests/keyword-evidence-software-runner.test.mjs",
      "tests/keyword-software-runtime-view.test.mjs",
      "tests/seerfar-open-api-transport.test.mjs",
      "tests/seerfar-runtime-connector.test.mjs",
      "tests/seerfar-software-api-guard.test.mjs",
      "lib/c1-content-review-use-case.mjs",
      "lib/c1-description-content.mjs",
      "lib/c1-draft-recovery-assessment.mjs",
      "lib/c1-editorial-review-contract.mjs",
      "lib/c1-editorial-review-use-case.mjs",
      "lib/c1-final-plan-revision-preparation.mjs",
      "lib/c1-final-plan-revision-use-case.mjs",
      "lib/c1-gateway-input-encoding.mjs",
      "lib/c1-image-text-evidence.mjs",
      "lib/c1-image-text-use-case.mjs",
      "lib/c1-local-draft-source.mjs",
      "lib/c1-seo-reference-context.mjs",
      "lib/c1-seo-review-contract.mjs",
      "lib/confirmed-supplier-inputs.mjs",
      "lib/local-image-text-adapter.mjs",
      "lib/owner-product-facts-use-case.mjs",
      "lib/owner-product-facts.mjs",
      "schema/c1-editorial-source-v1.schema.json",
      "schema/c1-editorial-source-v2.schema.json",
      "schema/c1-local-draft-source-v1.schema.json",
      "schema/c1-local-draft-source-v2.schema.json",
      "schema/c1-local-preparation-v2.schema.json",
      "schema/keyword-scoring-v2.schema.json",
      "scripts/assess-c1-draft-recovery.mjs",
      "src/components/C1ContentReviewPanel.jsx",
      "src/components/C1EditorialReviewPanel.jsx",
      "src/components/C1LocalPreparationPanel.jsx",
      "tests/c1-ai-contract-unification.test.mjs",
      "tests/c1-ai-fact-definitions.test.mjs",
      "tests/c1-ai-gateway-saved-read.test.mjs",
      "tests/c1-completed-editorial-adoption.test.mjs",
      "tests/c1-completed-editorial-api.test.mjs",
      "tests/c1-completed-editorial-contract.test.mjs",
      "tests/c1-completed-editorial-preview.test.mjs",
      "tests/c1-content-review-use-case.test.mjs",
      "tests/c1-description-content.test.mjs",
      "tests/c1-draft-gateway-capacity.test.mjs",
      "tests/c1-draft-recovery-assessment.test.mjs",
      "tests/c1-draft-result-read-api.test.mjs",
      "tests/c1-draft-result-reconciliation.test.mjs",
      "tests/c1-editorial-bilingual-contract.test.mjs",
      "tests/c1-editorial-preview-panel.test.mjs",
      "tests/c1-editorial-review-api.test.mjs",
      "tests/c1-editorial-review-use-case.test.mjs",
      "tests/c1-final-plan-history-transaction.test.mjs",
      "tests/c1-final-plan-revision-preparation.test.mjs",
      "tests/c1-final-plan-revision-use-case.test.mjs",
      "tests/c1-gateway-input-encoding.test.mjs",
      "tests/c1-gateway-input-version.test.mjs",
      "tests/c1-gateway-writing-projection.test.mjs",
      "tests/c1-image-text-evidence.test.mjs",
      "tests/c1-image-text-use-case.test.mjs",
      "tests/c1-local-content-flow-api.test.mjs",
      "tests/c1-local-draft-source.test.mjs",
      "tests/c1-local-preparation-api.test.mjs",
      "tests/c1-local-preparation.test.mjs",
      "tests/c1-owner-facts-revision.test.mjs",
      "tests/c1-prepared-ozon-attribute-mapping.test.mjs",
      "tests/c1-seo-reference-context.test.mjs",
      "tests/c1-seo-review-contract.test.mjs",
      "tests/c1-seo-semantic-input-review.test.mjs",
      "tests/c1-supplier-reference-context.test.mjs",
      "tests/c1-supplier-text-references.test.mjs",
      "tests/confirmed-supplier-inputs.test.mjs",
      "tests/final-plan-history-runtime-safety.test.mjs",
      "tests/owner-product-facts.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.5",
    "D/E 素材、执行与回读支持产物",
    ["5.4", "5.5", "6.1", "6.4", "6.5", "6.6", "6.7", "7.1", "7.2", "7.3", "9.7", "10.1", "10.5"],
    "这些文件支撑 D/E 合同、只读状态和候选适配器；当前没有正式 Seller API 写入与独立回读闭环。",
    [
      "lib/d-asset-transport-software-use-case.mjs",
      "lib/d-e-runtime-services.mjs",
      "lib/d-e-runtime-view.mjs",
      "lib/d-platform-observation-policy.mjs",
      "lib/d-platform-observation-contract.mjs",
      "lib/d-platform-observation-use-case.mjs",
      "lib/d-initial-import-recovery-use-case.mjs",
      "lib/d-unknown-outcome-reobservation-use-case.mjs",
      "lib/d-execution-request-codec.mjs",
      "lib/d-executable-request-contract.mjs",
      "lib/production-authorization-snapshot.mjs",
      "schema/d-platform-observation-v1.schema.json",
      "schema/d-platform-observation-admission-v1.schema.json",
      "tests/d-platform-observation-runtime.test.mjs",
      "tests/d-platform-observation-job-store.test.mjs",
      "tests/d-remaining-inventory-admission.test.mjs",
      "tests/d-owner-stock-registration.test.mjs",
      "tests/d-initial-import-stop-contract.test.mjs",
      "tests/fixtures/d-platform-observation-runtime-fixture.mjs",
      "tests/helpers/d-synthetic-completion-adapter.mjs",
      "lib/aliyun-oss-runtime-configuration.mjs",
      "lib/aliyun-oss-runtime-provider.mjs",
      "lib/ozon-de-http-configuration.mjs",
      "lib/ozon-inventory-prerequisite-policy.mjs",
      "lib/ozon-de-http-transport.mjs",
      "lib/ozon-de-preflight-provider.mjs",
      "lib/ozon-de-preflight-evidence-reader.mjs",
      "lib/ozon-account-read-api.mjs",
      "lib/ozon-account-read-contract.mjs",
      "lib/ozon-account-read-runtime.mjs",
      "lib/ozon-account-read-preparation.mjs",
      "lib/ozon-account-read-evidence.mjs",
      "lib/ozon-account-read-services.mjs",
      "lib/ozon-account-discovery-services.mjs",
      "lib/ozon-account-discovery-runtime.mjs",
      "schema/ozon-account-read-v1.schema.json",
      "schema/ozon-account-read-v2.schema.json",
      "src/components/OzonAccountReadCard.jsx",
      "src/components/OzonAccountPreparationCard.jsx",
      "tests/ozon-account-discovery.test.mjs",
      "tests/ozon-account-discovery-configuration.test.mjs",
      "tests/ozon-account-preparation-ui.test.mjs",
      "tests/ozon-account-preparation-api-boundary.test.mjs",
      "tests/ozon-account-read-api.test.mjs",
      "tests/ozon-account-read-runtime.test.mjs",
      "tests/ozon-account-read-integration.test.mjs",
      "tests/ozon-account-read-api-boundary.test.mjs",
      "tests/ozon-account-read-ui.test.mjs",
      "lib/d-e-software-job-admission.mjs",
      "lib/d-e-software-job-handoff.mjs",
      "lib/d-e-software-job-results.mjs",
      "lib/d-production-preparation-contract.mjs",
      "lib/d-production-round-use-case.mjs",
      "lib/production-authorization-rollback.mjs",
      "lib/production-authorization-rollback-use-case.mjs",
      "tests/production-authorization-rollback.test.mjs",
      "tests/production-authorization-rollback-acceptance.test.mjs",
      "tests/production-authorization-rollback-continue.test.mjs",
      "lib/ozon-de-protocol-catalog.mjs",
      "tests/d-e-restart-filter.test.mjs",
      "tests/d-observation-authorization-reference.test.mjs",
      "tests/ozon-de-protocol-catalog.test.mjs",
      "lib/e-readback-attempt.mjs",
      "lib/platform-write-preflight-contract.mjs",
      "lib/production-execution-failure.mjs",
      "tests/d-asset-transport-saved-job.test.mjs",
      "tests/d-e-runtime-configuration.test.mjs",
      "tests/d-e-runtime-services.test.mjs",
      "tests/d-e-runtime-view.test.mjs",
      "tests/aliyun-oss-runtime-provider.test.mjs",
      "tests/ozon-de-http-transport.test.mjs",
      "tests/ozon-de-preflight-provider.test.mjs",
      "tests/ozon-de-preflight-evidence-reader.test.mjs",
      "tests/fixtures/ozon-de-preflight-evidence-fixture.mjs",
      "tests/ozon-de-transport-integration.test.mjs",
      "tests/d-e-saved-continuation-api.test.mjs",
      "tests/d-e-software-job-admission.test.mjs",
      "tests/d-e-software-job-repository.test.mjs",
      "tests/d-e-software-job-schema.test.mjs",
      "tests/d-e-software-job-terminal-schema.test.mjs",
      "tests/d-production-job-terminal-guards.test.mjs",
      "tests/d-inventory-continuation-settlement.test.mjs",
      "tests/d-production-preparation.test.mjs",
      "tests/d-production-saved-job.test.mjs",
      "tests/e-readback-job-terminal-guards.test.mjs",
      "tests/e-readback-saved-job.test.mjs",
      "tests/fixtures/d-production-saved-job-fixture.mjs",
      "tests/fixtures/production-owner-decision-fixture.mjs",
      "tests/helpers/d-e-saved-api-fixture.mjs",
      "tests/production-owner-decision-api.test.mjs",
      "lib/d-e-software-job-scope.mjs",
      "lib/d-production-job-cursor.mjs",
      "lib/production-record-contract.mjs",
      "tests/d-e-software-job-scope.test.mjs",
      "tests/d-production-job-cursor.test.mjs",
      "tests/fixtures/d-e-software-job-scope-fixture.mjs",
      "tests/fixtures/d-production-job-cursor-fixture.mjs",
      "tests/helpers/e-readback-fixture.mjs",
      "lib/c2-local-asset-store.mjs",
      "lib/c2-upload-draft.mjs",
      "lib/c2-stable-asset-transport-use-case.mjs",
      "src/c2FinalAssetInput.js",
      "tests/c2-upload-draft.test.mjs",
      "tests/c2-upload-api.test.mjs",
      "tests/owner-media-authorization.test.mjs",
      "tests/c2-stable-asset-transport-use-case.test.mjs",
      "tests/d-e-software-persistence.test.mjs",
      "lib/production-authorization-preparation.mjs",
      "lib/production-owner-preparation.mjs",
      "lib/d-batch-production-authorization.mjs",
      "lib/d-batch-import-state.mjs",
      "lib/d-batch-stock-state.mjs",
      "lib/d-batch-import-runtime.mjs",
      "lib/d-batch-import-software-service.mjs",
      "lib/d-batch-execution-view.mjs",
      "lib/d-batch-offer-readback.mjs",
      "lib/ozon-product-import-batch-limit.mjs",
      "src/siblingBatchAuthorizationInput.js",
      "schema/production-authorization-v1.2.schema.json",
      "tests/production-owner-preparation.test.mjs",
      "tests/d-batch-production-authorization.test.mjs",
      "tests/d-batch-import-state.test.mjs",
      "tests/d-batch-stock-state.test.mjs",
      "tests/d-batch-import-runtime.test.mjs",
      "tests/d-batch-import-software-service.test.mjs",
      "tests/ozon-product-import-batch-limit.test.mjs",
      "tests/sibling-batch-authorization-input.test.mjs",
      "tests/d-batch-import-api.test.mjs",
      "tests/ozon-de-batch-preflight.test.mjs",
      "lib/production-contract-primitives.mjs",
      "scripts/generate-c2-reference-schema.mjs",
      "tests/cross-stage-contract-schema.test.mjs",
      "schema/production-record-v1.1.schema.json",
      "src/dESoftwareRuntimeView.js",
      "tests/aliyun-oss-runtime-deployment-boundary.test.mjs",
      "tests/d-e-software-runtime-view.test.mjs",
      "tests/draft-production-execution.test.mjs",
      "tests/ozon-production-strategy.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.6",
    "运行状态、身份和生命周期展示支持",
    ["1.1", "1.2", "1.3", "1.4", "1.5", "8.1", "8.2", "8.6", "9.8"],
    "这些视图和测试验证本地运行边界、身份、状态分类与只读生命周期预览，不证明中央运行已经实现。",
    [
      "lib/runtime-health.mjs",
      "lib/runtime-health-worker.mjs",
      "tests/runtime-health.test.mjs",
      "tests/runtime-health-api.test.mjs",
      "lib/http-api-boundary.mjs",
      "lib/software-job-admission.mjs",
      "schema/software-job-admission-v1.schema.json",
      "tests/http-api-boundary.test.mjs",
      "tests/software-job-admission.test.mjs",
      "schema/runtime-identity-v1.schema.json",
      "src/components/LifecycleEntryPreview.jsx",
      "src/executionRuntimeView.js",
      "tests/execution-runtime-view.test.mjs",
      "tests/lifecycle-status-view.test.mjs",
      "tests/product-lifecycle-schema.test.mjs",
      "tests/real-lifecycle-entry-preview.test.mjs",
      "tests/runtime-architecture-view.test.mjs",
      "tests/runtime-configuration.test.mjs",
      "tests/runtime-identity-provider.test.mjs",
      "tests/local-owner-identity.test.mjs",
      "tests/local-owner-access-ui.test.mjs",
      "tests/local-owner-access-api.test.mjs",
      "tests/worker-registry.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.7",
    "分阶段构建边界测试",
    ["9.5", "9.6", "10.6"],
    "这些测试只核对各阶段发布包和本机部署边界，不是 A→E 的业务执行证据。",
    [
      "scripts/prepare-local-runtime.mjs",
      "scripts/runtime-package.mjs",
      "tests/runtime-package-api.test.mjs",
      "tests/api-process-lifecycle.test.mjs",
      "tests/ci-api-boundary.test.mjs",
      "tests/ci-test-policy.test.mjs",
      "tests/launch-command-script.test.mjs",
      "tests/phase3-ab-deployment-boundary.test.mjs",
      "tests/phase4-c1-deployment-boundary.test.mjs",
      "tests/phase4-c1-fact-keyword-deployment-boundary.test.mjs",
      "tests/phase4-c1-keyword-auto-trigger-deployment-boundary.test.mjs",
      "tests/phase4-c1-software-boundary.test.mjs",
      "tests/phase4-k3-c1-deployment-boundary.test.mjs",
      "tests/phase5-c2-deployment-boundary.test.mjs",
      "tests/phase5b-c2-ui-deployment-boundary.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.8",
    "测试固定材料",
    ["1.1", "2.4", "4.2", "4.5", "5.4", "6.1", "6.4", "7.1"],
    "这些 fixture/helper 只为测试提供固定输入，不能作为当前平台证据或真实执行回执。",
    [
      "tests/fixtures/c1-paid-keyword-settlement-fixture.mjs",
      "tests/fixtures/c1-ai-draft-fixture.mjs",
      "tests/fixtures/c1-ai-software-job-fixture.mjs",
      "tests/fixtures/formal-c1-flow-fixture.mjs",
      "tests/fixtures/legacy-candidate-input-fixture.mjs",
      "tests/fixtures/c2-source-package-fixture.mjs",
      "tests/fixtures/prepare-sibling-batch-browser.mjs",
      "tests/fixtures/sibling-batch-browser.html",
      "tests/fixtures/sibling-batch-browser.jsx",
      "tests/fixtures/sibling-batch-c1-browser.html",
      "tests/fixtures/sibling-batch-c1-browser.jsx",
      "tests/fixtures/sibling-batch-c1-vite.config.mjs",
      "tests/fixtures/start-sibling-batch-c1-browser.mjs",
      "tests/fixtures/sibling-batch-final-family-fixture.mjs",
      "tests/fixtures/sibling-batch-final-fixture.mjs",
      "tests/fixtures/store-binding-fixture.mjs",
      "tests/helpers/api-process-lifecycle.mjs",
      "tests/helpers/c2-software-fixture.mjs",
      "tests/helpers/d-software-fixture.mjs",
      "tests/helpers/extension-runtime-fixture.mjs",
      "tests/helpers/legacy-candidate-fixture.mjs",
      "tests/helpers/published-schema-validator.mjs",
      "tests/legacy-candidate-fixture.test.mjs",
      "tests/fixtures/c1-keyword-planning-fixture.mjs",
      "tests/helpers/market-assessment-fixture.mjs",
      "tests/fixtures/c1-completed-editorial-fixture.mjs",
      "tests/fixtures/c1-editorial-review-fixture.mjs",
      "tests/fixtures/c1-image-text-fixture.mjs",
      "tests/fixtures/c1-local-draft-source-fixture.mjs",
      "tests/fixtures/c1-seo-review-fixture.mjs",
      "tests/fixtures/production-profit-evidence-fixture.mjs"
    ]
  ),
  artifactAssignment(
    "11.9",
    "历史地图兼容测试",
    ["9.1", "10.2"],
    "该测试验证旧 workflow-map 的历史行为，只能作为兼容证据。",
    ["tests/workflow-map.test.mjs"]
  ),
  artifactAssignment(
    "11.11",
    "C2 最终素材、方案卡与商业草案支持产物",
    ["4.7", "5.1", "5.4", "5.5", "6.1", "6.2"],
    "这些文件支撑最终素材输入、既有确认引用、只读方案卡和待确认商业草案；不代表主人已确认文案、已授予生产授权或平台已写入。",
    [
      "lib/ozon-final-product-preview.mjs",
      "lib/ozon-hashtag-attribute.mjs",
      "lib/ozon-import-error-level.mjs",
      "lib/ozon-submission-attributes.mjs",
      "lib/production-commercial-draft-use-case.mjs",
      "lib/production-commercial-draft.mjs",
      "tests/fixtures/sibling-preparation-catalog-fixture.mjs",
      "lib/sibling-preparation-catalog.mjs",
      "lib/sibling-preparation-consistency.mjs",
      "lib/sibling-preparation-draft.mjs",
      "lib/sibling-supply-preparation.mjs",
      "src/components/SiblingPreparationWorkspace.jsx",
      "src/components/SiblingPreparationWorkspace.css",
      "src/siblingPreparationState.js",
      "tests/sibling-preparation.test.mjs",
      "tests/sibling-supply-preparation.test.mjs",
      "tests/sibling-preparation-api.test.mjs",
      "tests/sibling-preparation-save-state.test.mjs",
      "tests/fixtures/s1-workspace-browser.html",
      "tests/fixtures/s1-workspace-browser.jsx",
      "tests/fixtures/start-s1-workspace-browser.mjs",
      "tests/fixtures/s1-workspace-fault-proxy.mjs",
      "lib/sibling-batch-c2-final.mjs",
      "lib/sibling-batch-commercial-drafts.mjs",
      "src/c2UploadInput.js",
      "src/components/C2FinalAssetsPanel.jsx",
      "src/components/FinalProductPlanCard.jsx",
      "src/components/SiblingBatchPreparation.jsx",
      "src/siblingBatchFormDefaults.js",
      "src/siblingBatchReview.js",
      "tests/c2-competitor-reference.test.mjs",
      "tests/c2-editorial-source.test.mjs",
      "tests/c2-upload-input.test.mjs",
      "tests/final-product-plan-card-ui.test.mjs",
      "tests/ozon-final-product-preview.test.mjs",
      "tests/ozon-submission-attributes.test.mjs",
      "tests/production-commercial-draft.test.mjs",
      "tests/sibling-batch-c2-final.test.mjs",
      "tests/sibling-batch-commercial-api.test.mjs",
      "tests/sibling-batch-review.test.mjs",
      "tests/sibling-batch-form-defaults.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.12",
    "生产前冻结证据与正式利润复用门禁",
    ["3.2", "3.3", "3.4", "3.5", "4.1", "6.1"],
    "这些文件只检查已有冻结证据和正式利润是否仍适用，不重新研究价格、不发起外部查询，也不证明已取得生产授权。",
    [
      "lib/production-evidence-readiness.mjs",
      "tests/production-evidence-readiness.test.mjs",
      "tests/production-profit-reuse.test.mjs"
    ]
  ),
  artifactAssignment(
    "11.10",
    "能力注册表与快照完整性门禁",
    ["9.10"],
    "该测试只核对能力登记、关系门禁、源码覆盖和冻结摘要，不运行业务、外部采集或平台写入。",
    [
      "lib/capability-registry.mjs",
      "tests/capability-registry.test.mjs",
      "tests/capability-source-snapshot.test.mjs",
      "scripts/capability-source-snapshot.mjs",
      "scripts/generate-capability-snapshot.mjs"
    ]
  )
]);

export const CAPABILITY_OVERLAP_GROUPS = Object.freeze([
  overlapGroup({
    id: "10.1", legacyIds: ["overlap-ozon-d-e"],
    title: "Ozon D/E 候选实现比较组",
    overlapLevel: "高：多份代码都覆盖 D 请求、回执、回读或能力判断的一部分",
    note: "没有唯一正式生产主用实现；OSS 素材传输已单独登记为 6.5，不能与销售平台写入混成一件事。",
    possibleMainlinePositions: ["6.4—6.7 Ozon D", "7.1—7.3 Ozon E"],
    missingEvidence: ["正式 Seller API 店铺身份和协议验收", "逐导出调用图", "真实写入与独立回读回执"],
    ownerDecision: "证据齐全后决定接入哪套、暂时保留哪套；本轮不选择胜者。",
    members: [
      { path: "lib/d-e-software-closure.mjs", role: "领域执行与回读合同", overlapLevel: "核心合同",
        inputs: ["计划、授权、前检、适配器能力"], outputs: ["执行意图、ProductionRecord、EVerificationRecord"],
        calledBy: ["server 导入领域函数；部分功能仍无正式路由"], testRefs: ["tests/d-e-software-closure.test.mjs"], uiStatus: "只读准备度卡" },
      { path: "lib/ozon-seller-api-production-adapter.mjs", role: "待接生产适配器", overlapLevel: "与 D 执行高重叠",
        inputs: ["Ozon 写入请求和客户端"], outputs: ["归一化 Seller API 回执"],
        calledBy: ["测试和候选组合代码；未发现 server 正式调用"], testRefs: ["tests/ozon-seller-api-production-adapter.test.mjs"] },
      { path: "lib/ozon-seller-api-de-adapter.mjs", role: "待比较 D/E 组合适配器", overlapLevel: "同时覆盖写入和回读",
        inputs: ["D 请求、E 读取身份和客户端"], outputs: ["写入/回读能力与归一化结果"],
        calledBy: ["测试和只读探针；未发现 server 正式调用"], testRefs: ["tests/ozon-seller-api-de-adapter.test.mjs"] },
      { path: "lib/ozon-production-strategy.mjs", role: "历史生产策略", overlapLevel: "与计划/执行规则部分重叠",
        inputs: ["平台、模式和商品范围"], outputs: ["生产策略选择"],
        calledBy: ["production-plan.mjs"], testRefs: ["tests/ozon-production-strategy.test.mjs"] },
      { path: "lib/draft-production-execution.mjs", role: "草稿执行器", overlapLevel: "与正式 D 执行高重叠",
        inputs: ["草稿生产计划和 adapter"], outputs: ["草稿执行结果"],
        calledBy: ["d-e-software-closure.mjs"], testRefs: ["tests/draft-production-execution.test.mjs"] },
      { path: "lib/aliyun-oss-d-asset-integration.mjs", role: "已分离的 OSS 素材传输", overlapLevel: "只与素材准备重叠，不是 Ozon 商品写入",
        inputs: ["授权、finalUploads、一次性意图"], outputs: ["稳定素材地址或 unknown_outcome"],
        calledBy: ["server 的 /lifecycle/d/asset-transport"], testRefs: ["tests/aliyun-oss-d-asset-integration.test.mjs"], uiStatus: "通过 D/E 准备度卡间接展示" },
      { path: "lib/e-stage-readback.mjs", role: "E 比对与持久化合同", overlapLevel: "与回读适配器部分重叠",
        inputs: ["ProductionRecord 或 ExternalListingRecord、已验证观察"], outputs: ["EVerificationRecord"],
        calledBy: ["server E 路由；观察值仍由调用方提交"], testRefs: ["tests/e-stage-readback.test.mjs"], uiStatus: "旧人工回读表面存在" }
    ]
  }),
  overlapGroup({
    id: "10.2", title: "旧 Workflow Map 与 Codex 分派比较组",
    overlapLevel: "高：地图节点、负责人和派发状态互相依赖",
    note: "两者仍被历史 server 路由调用，但都不具备正常 A→E 主线资格。",
    possibleMainlinePositions: ["8.3—8.5 真正异常维护", "历史只读审计"],
    missingEvidence: ["正常路径不可达证明", "全部历史数据调用方", "替代后的迁移验收"],
    ownerDecision: "决定暂时保留或确认退役；不得自动删除。",
    members: [
      { path: "lib/workflow-map.mjs", role: "旧 M01—M12 地图和路由", overlapLevel: "历史流程核心",
        inputs: ["旧地图 JSON、候选状态"], outputs: ["节点、负责人、留言和恢复目标"],
        calledBy: ["server 旧 workflow-map/留言/恢复接口"], testRefs: ["tests/workflow-map.test.mjs"], uiStatus: "旧地图 UI 已被新入口替代，后端仍在" },
      { path: "lib/codex-dispatcher.mjs", role: "旧 Codex 任务派发", overlapLevel: "与旧地图负责人路由高耦合",
        inputs: ["dispatch、route、node、candidate"], outputs: ["任务轮次或派发失败"],
        calledBy: ["server 历史派发和恢复"], testRefs: ["tests/codex-dispatcher.test.mjs"], uiStatus: "旧 dispatch 状态仍可见" }
    ]
  }),
  overlapGroup({
    id: "10.3", title: "旧 C1、FireTrain 与特殊 SKU 路径比较组",
    overlapLevel: "高：都能准备部分 C1/C2，但输入合同和适用范围不同",
    note: "旧 FireTrain 路由默认关闭；特殊 DD-H1 脚本不能提升成通用能力。",
    possibleMainlinePositions: ["4.1—4.7 正式 C1", "5.1—5.5 正式 C2", "历史兼容"],
    missingEvidence: ["每个导出与正式 C1 的差异", "历史数据引用", "领域验收"],
    ownerDecision: "证据齐全后决定保留兼容期或退役；本轮不迁移。",
    members: [
      { path: "lib/real-c1-preparation.mjs", role: "旧 FireTrain C1 准备", overlapLevel: "与 4.1/5.4 高重叠",
        inputs: ["旧候选和主人事实"], outputs: ["旧 C1 与最终素材准备"],
        calledBy: ["server legacy fire-train 路由，默认关闭"], testRefs: ["tests/real-c1-preparation.test.mjs"], uiStatus: "正式入口退役，兼容路由关闭" },
      { path: "lib/lifecycle-c-stage.mjs", role: "旧 C 阶段组合", overlapLevel: "与 C1/C2/授权部分重叠",
        inputs: ["旧 C 阶段对象"], outputs: ["C1/C2/授权兼容结果"],
        calledBy: ["server 历史路由和测试"], testRefs: ["tests/lifecycle-c-stage-generic-api.test.mjs"] },
      { path: "lib/c1-fact-keyword-runtime.mjs", role: "新版 C1 运行时组合", overlapLevel: "目标上替代旧 C1，但尚未完整接通",
        inputs: ["C1 事实与关键词运行输入"], outputs: ["C1 运行结果或明确阻塞"],
        calledBy: ["server 新 C1 路由"], testRefs: ["tests/c1-fact-keyword-runtime.test.mjs"], uiStatus: "关键词运行卡可见" },
      { path: "lib/c1-product-plan.mjs", role: "C1商品方案合同", overlapLevel: "上游事实与Schema合同",
        inputs: ["冻结SKU和C1核验事实"], outputs: ["C1方案"],
        calledBy: ["C1领域流程"], testRefs: ["tests/c1-product-plan.test.mjs"], uiStatus: "通过商品详情展示" }
    ]
  }),
  overlapGroup({
    id: "10.4", title: "模拟验收与真实生命周期比较组",
    overlapLevel: "外观相似、证据等级完全不同",
    note: "模拟输出只能用于讲解和单元测试，不能证明真实候选已走通。",
    possibleMainlinePositions: ["9.3 隔离模拟", "2→3→4 正常生命周期"],
    missingEvidence: ["模拟入口持续隔离测试", "真实链路独立验收"],
    ownerDecision: "决定模拟入口长期保留或退役；不得接主线。",
    members: [
      { path: "lib/phase-2a-simulation.mjs", role: "固定数据模拟", overlapLevel: "行为演示",
        inputs: ["固定 fixture"], outputs: ["模拟 A/B/C1"], calledBy: ["模拟 UI/API"], testRefs: ["tests/phase-2a-simulation.test.mjs"], uiStatus: "独立模拟页面" },
      { path: "lib/real-a-b-c1-flow.mjs", role: "真实 A/B/C1 领域组合", overlapLevel: "真实数据合同",
        inputs: ["A 冻结证据与真实 B 输入"], outputs: ["ProfitModel 和 C1 交接"], calledBy: ["server 正式生命周期路由"], testRefs: ["tests/real-a-b-c1-flow.test.mjs"], uiStatus: "通过评审台候选状态展示" }
    ]
  }),
  overlapGroup({
    id: "10.5", title: "手工回读与正式独立回读比较组",
    overlapLevel: "高：都会生成看似完成的状态，但证据来源不同",
    note: "caller-supplied verifiedObservation 和人工标记不能冒充平台 provider 独立读取。",
    possibleMainlinePositions: ["7.1—7.3 正式 E", "9.9 历史人工支路"],
    missingEvidence: ["正式平台只读 provider", "平台身份和独立回执", "人工记录迁移边界"],
    ownerDecision: "以后决定人工支路只读保留或退役；本轮不得升级为 E。",
    members: [
      { path: "lib/workflow.mjs", role: "旧人工记录与回读校验", overlapLevel: "历史人工",
        inputs: ["主人填写的 listing/readback"], outputs: ["本地验证记录"], calledBy: ["server 旧 API"], testRefs: ["tests/workflow.test.mjs"], uiStatus: "旧按钮/API 表面存在" },
      { path: "lib/post-launch-observation.mjs", role: "上架后观察记录", overlapLevel: "历史观察",
        inputs: ["人工或外部观察"], outputs: ["观察结论"], calledBy: ["历史 D/E 代码和测试"], testRefs: ["tests/post-launch-observation.test.mjs"] },
      { path: "lib/e-stage-readback.mjs", role: "正式 E 比对合同", overlapLevel: "目标正式能力",
        inputs: ["平台身份和 verifiedObservation"], outputs: ["EVerificationRecord"], calledBy: ["server E 路由"], testRefs: ["tests/e-stage-readback.test.mjs"], uiStatus: "未接真实 provider" },
      { path: "lib/ozon-seller-api-de-adapter.mjs", role: "候选正式 provider", overlapLevel: "待接外部只读",
        inputs: ["Ozon 店铺和商品身份"], outputs: ["平台观察"], calledBy: ["测试和探针"], testRefs: ["tests/ozon-seller-api-de-adapter.test.mjs"] }
    ]
  }),
  overlapGroup({
    id: "10.6", title: "多套阶段构建与部署边界比较组",
    overlapLevel: "高：phase3/4/5 脚本重复维护文件清单和打包规则",
    note: "它们服务工程发布，不推进 SKU；当前部署脚本还会覆盖并重启 4317。",
    possibleMainlinePositions: ["9.5 工程构建", "9.6 本机运行副本部署"],
    missingEvidence: ["统一发布入口", "当前每套包的真实消费者", "脏工作树保护"],
    ownerDecision: "决定保留哪些阶段包或统一发布方式；本轮不执行部署。",
    members: [
      { path: "lib/phase3-ab-deployment-boundary.mjs", role: "A/B 发布边界", overlapLevel: "阶段文件清单",
        inputs: ["A/B 源码"], outputs: ["A/B 部署清单"], calledBy: ["build-phase3 脚本"], testRefs: ["tests/phase3-ab-deployment-boundary.test.mjs"] },
      { path: "lib/phase4-c1-deployment-boundary.mjs", role: "C1 发布边界", overlapLevel: "阶段文件清单",
        inputs: ["C1 源码"], outputs: ["C1 部署清单"], calledBy: ["build-phase4 脚本"], testRefs: ["tests/phase4-c1-deployment-boundary.test.mjs"] },
      { path: "lib/phase5-c2-deployment-boundary.mjs", role: "C2 发布边界", overlapLevel: "阶段文件清单",
        inputs: ["C2 源码"], outputs: ["C2 部署清单"], calledBy: ["build-phase5 脚本"], testRefs: ["tests/phase5-c2-deployment-boundary.test.mjs"] },
      { path: "scripts/deploy-local-runtime.sh", role: "4317 本机覆盖部署", overlapLevel: "最终复制和重启",
        inputs: ["主工作树构建产物"], outputs: ["Application Support 运行副本"], calledBy: ["人工部署"], testRefs: ["tests/aliyun-oss-runtime-deployment-boundary.test.mjs"], uiStatus: "影响当前运行副本，但本轮未执行" }
    ]
  }),
  overlapGroup({
    id: "10.7", title: "历史候选适配与新版生命周期入口比较组",
    overlapLevel: "中：都能产生可展示生命周期对象，但历史适配只读",
    note: "旧候选 unknown 必须保持 unknown，不能通过适配器获得新版通过结论。",
    possibleMainlinePositions: ["1.1 历史只读投影", "2.1 新版候选入口"],
    missingEvidence: ["历史候选迁移策略", "新版入口全量验收", "兼容结束条件"],
    ownerDecision: "决定兼容保留周期；本轮不自动迁移旧候选。",
    members: [
      { path: "lib/legacy-candidate-adapter.mjs", role: "历史只读适配", overlapLevel: "只读兼容",
        inputs: ["旧候选"], outputs: ["OpportunityPackage 预览"], calledBy: ["real-lifecycle-entry-preview"], testRefs: ["tests/legacy-candidate-adapter.test.mjs"], uiStatus: "生命周期预览可见" },
      { path: "lib/real-lifecycle-entry-preview.mjs", role: "入口只读预览", overlapLevel: "新旧共同展示",
        inputs: ["候选和适配结果"], outputs: ["入口缺口视图"], calledBy: ["server 候选投影"], testRefs: ["tests/real-lifecycle-entry-preview.test.mjs"], uiStatus: "已接评审台" },
      { path: "lib/product-lifecycle-schema.mjs", role: "新版生命周期合同", overlapLevel: "目标正式身份",
        inputs: ["规范对象链"], outputs: ["严格生命周期对象"], calledBy: ["A→E 领域模块"], testRefs: ["tests/product-lifecycle-schema.test.mjs"], uiStatus: "经派生视图展示" }
    ]
  }),
  overlapGroup({
    id: "10.8", title: "B 利润流程收敛记录", resolutionStatus: "consolidated",
    overlapLevel: "已收敛：利润计算与自动C1分别由现有领域模块承担",
    note: "旧测试专用B模块已移除；0.21kg和23.87元回归迁入profit-model，利润率按未舍入值计算。",
    possibleMainlinePositions: ["3.5 正式利润", "3.6 B通过后的原子C1交接"],
    missingEvidence: [], ownerDecisionRequired: false,
    ownerDecision: "本轮工程合并已保留五条真实回归；编号继续保留，不复用。",
    members: [
      { path: "lib/real-a-b-c1-flow.mjs", role: "A/B与唯一C1交接组合", overlapLevel: "职责清晰",
        inputs: ["A冻结输入和费用证据"], outputs: ["ProfitModel、C1交接"], calledBy: ["server生命周期API"], testRefs: ["tests/real-a-b-c1-flow.test.mjs"] },
      { path: "lib/profit-model.mjs", role: "唯一正式B利润计算", overlapLevel: "职责清晰",
        inputs: ["确认供应方案和五类证据"], outputs: ["未舍入判定与展示利润"], calledBy: ["real-a-b-c1-flow"], testRefs: ["tests/profit-model.test.mjs"] }
    ]
  })
]);

export const LEGACY_MAP_NODE_ALIASES = Object.freeze({
  "old:1.1": "1.1",
  "old:2.1": "2.6",
  "old:2.2": "2.3",
  "old:3.1": "3.5",
  "old:4.1": "4.1",
  "old:4.2": "4.4",
  "old:5.1": "5.5",
  "old:6.1": "6.1",
  "old:6.2": "6.6",
  "old:6.3": "6.8",
  "old:7.1": "7.2",
  "old:7.2": "7.4",
  "old:8.1": "8.3",
  "old:8.2": "8.6"
});

export const PRE_FREEZE_NUMBER_MIGRATIONS = Object.freeze({
  "registry-v2:6.5:oss-part": "6.5",
  "registry-v2:6.5:ozon-write-part": "6.6",
  "registry-v2:6.6": "6.7",
  "registry-v2:6.7": "6.8",
  "overlap-ozon-d-e": "10.1"
});

export const CAPABILITY_ARTIFACT_SCAN_POLICY = Object.freeze({
  scope: "selection-review-app first-party executable and test artifacts",
  rootFiles: Object.freeze([
    "server.mjs", "index.html", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "vite.config.js", "com.shuaizhang.selection-review-open-chrome.plist", "启动今日选品评审台.command"
  ]),
  includedDirectories: Object.freeze(["lib", "schema", "src", "extension", "scripts", "tests"]),
  exclusions: Object.freeze([
    Object.freeze({ path: ".git/**", reason: "版本库内部数据，不是项目能力。" }),
    Object.freeze({ path: "node_modules/**", reason: "第三方依赖。" }),
    Object.freeze({ path: "dist/**", reason: "构建产物；源码能力由 src 登记。" }),
    Object.freeze({ path: "coverage|output|cache|.vite*/**", reason: "测试、构建或工具缓存。" }),
    Object.freeze({ path: "logs/**", reason: "运行日志，可能含动态或敏感信息，不读取也不哈希。" }),
    Object.freeze({ path: "evidence/**", reason: "业务证据与历史回执，不是代码能力；本轮不读取内容。" }),
    Object.freeze({ path: "data/**", reason: "候选、授权、作业和历史业务状态；本轮不读取也不哈希。" }),
    Object.freeze({ path: "data/workflow-map.json", reason: "旧 workflow-map 的动态历史数据，仅登记存在，不纳入源码摘要。" }),
    Object.freeze({ path: "docs/** and *.md", reason: "文档、规则和老板意图线；本轮不吸收为代码能力事实。" }),
    Object.freeze({ path: "*.png|*.jpg|*.jpeg|*.webp", reason: "商品素材或界面截图，不是可执行能力。" }),
    Object.freeze({ path: ".env* and credential files", reason: "凭据或本机秘密，禁止扫描和输出。" }),
    Object.freeze({ path: "capability-snapshots/**", reason: "冻结结果本身，排除以避免摘要自引用。" }),
    Object.freeze({ path: ".DS_Store", reason: "操作系统元数据。" })
  ])
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(`CAPABILITY_REGISTRY_INVALID: ${message}`);
}

export function assertCapabilityRegistryIntegrity() {
  const numericId = /^\d+\.\d+$/;
  const areaIds = new Set(CAPABILITY_AREAS.map((item) => item.id));
  const nodeIds = new Set();
  const visibleIds = new Set();
  const identityStates = new Set(Object.keys(REGISTRATION_STATES));
  const wiringStates = new Set(Object.keys(INTEGRATION_STATES));
  const verificationStates = new Set(Object.keys(VERIFICATION_STATES));
  const runtimeScopes = new Set(Object.keys(RUNTIME_SCOPES));
  const mainlineQualifications = new Set(Object.keys(MAINLINE_QUALIFICATIONS));
  const sideEffectTypes = new Set(Object.keys(SIDE_EFFECT_TYPES));
  const relationKinds = new Set(Object.keys(CAPABILITY_RELATION_KINDS));

  for (const node of CAPABILITY_NODES) {
    requireCondition(numericId.test(node.id), `能力编号必须是纯数字分层编号：${node.id}`);
    requireCondition(!nodeIds.has(node.id), `能力编号重复：${node.id}`);
    nodeIds.add(node.id);
    visibleIds.add(node.id);
    requireCondition(areaIds.has(node.areaId), `${node.id} 所属区域不存在：${node.areaId}`);
    requireCondition(identityStates.has(node.identityState), `${node.id} 身份状态无效：${node.identityState}`);
    requireCondition(wiringStates.has(node.wiringStatus), `${node.id} 接线状态无效：${node.wiringStatus}`);
    requireCondition(verificationStates.has(node.verificationStatus), `${node.id} 验证状态无效：${node.verificationStatus}`);
    requireCondition(mainlineQualifications.has(node.mainlineQualification), `${node.id} 主线资格无效：${node.mainlineQualification}`);
    requireCondition(node.runtimeScopes.length > 0 && node.runtimeScopes.every((item) => runtimeScopes.has(item)), `${node.id} 运行范围无效`);
    requireCondition(node.sideEffects.length > 0 && node.sideEffects.every((item) => sideEffectTypes.has(item)), `${node.id} 副作用分类无效`);
    requireCondition(node.title && node.plainDescription && node.serves, `${node.id} 缺少大白话名称、用途或服务对象`);
    requireCondition(node.inputs.length > 0 && node.outputs.length > 0, `${node.id} 缺少输入或输出`);
    requireCondition(node.stopConditions && node.ownerAction && node.breakpoint && node.nextStep, `${node.id} 缺少停止条件、主人动作、断点或下一步`);
    requireCondition(node.baselineHealth?.reason, `${node.id} 缺少健康原因`);
    if (node.normalPathAllowed) {
      requireCondition(node.identityState === "official", `${node.id} 非正式身份不得进入正常主线`);
      requireCondition(["connected", "partial"].includes(node.wiringStatus), `${node.id} 未接通能力不得进入正常主线`);
      requireCondition(node.mainlineQualification === "normal_mainline", `${node.id} 非正常主线能力不得进入正常主线`);
      requireCondition(node.verificationStatus !== "blocked", `${node.id} 当前阻塞不得进入正常主线`);
    }
  }

  const relationIds = new Set();
  for (const edge of CAPABILITY_RELATIONS) {
    requireCondition(!relationIds.has(edge.id), `关系编号重复：${edge.id}`);
    relationIds.add(edge.id);
    requireCondition(nodeIds.has(edge.from) && nodeIds.has(edge.to), `${edge.id} 关系端点不存在`);
    requireCondition(relationKinds.has(edge.kind), `${edge.id} 关系类型无效：${edge.kind}`);
    requireCondition(verificationStates.has(edge.verificationStatus), `${edge.id} 验证状态无效`);
    requireCondition(edge.condition && edge.health?.reason, `${edge.id} 缺少条件或线路健康原因`);
    if (["planned", "reference_only", "exception", "recovery", "loop"].includes(edge.kind)) {
      requireCondition(edge.normalPathAllowed === false, `${edge.id} ${edge.kind} 关系不得冒充正常主线`);
    }
    if (edge.normalPathAllowed) {
      const from = CAPABILITY_NODES.find((item) => item.id === edge.from);
      const to = CAPABILITY_NODES.find((item) => item.id === edge.to);
      requireCondition(from.normalPathAllowed && to.normalPathAllowed, `${edge.id} 正常线路经过无主线资格节点`);
      requireCondition(edge.verificationStatus !== "blocked", `${edge.id} 阻塞线路不得进入正常主线`);
    }
  }

  for (const item of UNPLACED_CAPABILITIES) {
    requireCondition(numericId.test(item.id), `待归位编号必须是纯数字分层编号：${item.id}`);
    requireCondition(!visibleIds.has(item.id), `面向主人编号重复：${item.id}`);
    visibleIds.add(item.id);
    requireCondition(identityStates.has(item.identityState), `${item.id} 身份状态无效`);
    requireCondition(wiringStates.has(item.wiringStatus), `${item.id} 接线状态无效`);
    requireCondition(verificationStates.has(item.verificationStatus), `${item.id} 验证状态无效`);
    requireCondition(mainlineQualifications.has(item.mainlineQualification), `${item.id} 主线资格无效`);
    requireCondition(item.runtimeScopes.length > 0 && item.runtimeScopes.every((entry) => runtimeScopes.has(entry)), `${item.id} 运行范围无效`);
    requireCondition(item.sideEffects.length > 0 && item.sideEffects.every((entry) => sideEffectTypes.has(entry)), `${item.id} 副作用分类无效`);
    requireCondition(["unresolved", "historical_only", "consolidated"].includes(item.resolutionStatus), `${item.id} 归位结果无效`);
    requireCondition(item.inputs.length > 0 && item.outputs.length > 0, `${item.id} 缺少输入或输出说明`);
    if (item.resolutionStatus === "unresolved") {
      requireCondition(item.calledBy.length > 0 && item.calls.length > 0 && item.missingEvidence.length > 0, `${item.id} 缺少当前调用关系或待补证据`);
    } else {
      requireCondition(item.historicalArtifactRefs?.length > 0, `${item.id} 必须保留历史文件来源`);
      requireCondition(item.calledBy.length === 0 && item.calls.length === 0, `${item.id} 已移除文件不得声称当前调用关系`);
      if (item.resolutionStatus === "historical_only") requireCondition(item.artifactRefs.length === 0 && item.evidenceRefs.length === 0, `${item.id} 历史记录不得冒充当前文件证据`);
      if (item.resolutionStatus === "consolidated") requireCondition(item.ownerDecisionRequired === false && item.evidenceRefs.length > 0, `${item.id} 收敛必须有当前替代验证`);
    }
    requireCondition(item.plainDescription && item.reason && item.candidateTargets.length > 0, `${item.id} 缺少待归位说明`);
    requireCondition(item.mainlineQualification !== "normal_mainline", `${item.id} 待归位能力不得进入正常主线`);
  }

  for (const group of CAPABILITY_OVERLAP_GROUPS) {
    requireCondition(numericId.test(group.id), `重复比较组必须使用纯数字分层编号：${group.id}`);
    requireCondition(!visibleIds.has(group.id), `面向主人编号重复：${group.id}`);
    visibleIds.add(group.id);
    requireCondition(group.currentPrimary === null, `${group.id} 本轮不得自动选择主实现`);
    requireCondition(group.members.length >= 2 && group.possibleMainlinePositions.length > 0, `${group.id} 比较资料不完整`);
    requireCondition(["unresolved", "consolidated"].includes(group.resolutionStatus), `${group.id} 比较结果无效`);
    if (group.resolutionStatus === "consolidated") {
      requireCondition(group.ownerDecisionRequired === false && group.missingEvidence.length === 0 && group.ownerDecision, `${group.id} 收敛记录必须明确完成依据`);
    } else {
      requireCondition(group.ownerDecisionRequired === true && group.missingEvidence.length > 0 && group.ownerDecision, `${group.id} 必须保留待补证据和主人最终决定`);
    }
    for (const member of group.members) {
      requireCondition(member.path && member.role && member.inputs.length > 0 && member.outputs.length > 0 && member.calledBy.length > 0, `${group.id} 成员比较资料不完整`);
    }
  }

  const ownerIds = new Set([...visibleIds]);
  for (const assignment of CAPABILITY_ARTIFACT_ASSIGNMENTS) {
    requireCondition(numericId.test(assignment.id), `产物归属组必须使用纯数字分层编号：${assignment.id}`);
    requireCondition(!visibleIds.has(assignment.id), `面向主人编号重复：${assignment.id}`);
    visibleIds.add(assignment.id);
    requireCondition(assignment.ownerIds.length > 0 && assignment.ownerIds.every((id) => ownerIds.has(id)), `${assignment.id} 指向不存在的能力编号`);
    requireCondition(assignment.paths.length > 0 && assignment.reason, `${assignment.id} 缺少路径或归属原因`);
  }

  for (const [legacyId, currentId] of Object.entries(LEGACY_MAP_NODE_ALIASES)) {
    requireCondition(legacyId && nodeIds.has(currentId), `旧编号映射目标不存在：${legacyId} -> ${currentId}`);
  }
  return true;
}

export function registeredArtifactPaths() {
  const paths = new Set();
  for (const node of CAPABILITY_NODES) {
    for (const reference of [...node.codeRefs, ...node.uiRefs, ...node.testRefs]) paths.add(reference.path);
    for (const path of node.artifactRefs) paths.add(path);
  }
  for (const item of UNPLACED_CAPABILITIES) {
    for (const reference of item.evidenceRefs) paths.add(reference.path);
    for (const path of item.artifactRefs) paths.add(path);
  }
  for (const group of CAPABILITY_OVERLAP_GROUPS) {
    for (const member of group.members) {
      paths.add(member.path);
      for (const path of member.testRefs) paths.add(path);
    }
  }
  for (const assignment of CAPABILITY_ARTIFACT_ASSIGNMENTS) {
    for (const path of assignment.paths) paths.add(path);
  }
  return Object.freeze([...paths].sort());
}
