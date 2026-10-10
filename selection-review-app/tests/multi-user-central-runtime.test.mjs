import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CENTRAL_TRUTH_ERROR,
  LOCAL_RUNTIME_LOCK_IN_AUDIT,
  MULTI_USER_MIGRATION_STAGES,
  MULTI_USER_CENTRAL_RUNTIME_INVARIANTS,
  MULTI_USER_RUNTIME_ERROR,
  RUNTIME_SECRET_BOUNDARIES,
  assertNoUnreviewedLocalMachineDependency,
  assertProductionStateRepository,
  assertProductionStatePersistence,
  assertRuntimeBoundaries,
  findLocalMachineDependencies
} from "../lib/multi-user-central-runtime.mjs";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// These exact literals reject local references; they are not local service dependencies.
// Only the declared fragments are removed. The rest of each domain file is still scanned.
const reviewedRejectionRules = new Map([
  ["lib/aliyun-oss-runtime-configuration.mjs", [
    { text: String.raw`/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)`, count: 1 }
  ]],
  ["lib/c2-asset-lifecycle.mjs", [
    { text: 'return ["localhost", "local", "localdomain", "lan", "home", "internal"].some((suffix) =>', count: 1 }
  ]],
  ["lib/production-contract-primitives.mjs", [
    { text: String.raw`"(?!localhost(?:/|$))"`, count: 2 },
    { text: String.raw`"(?![^/]*\\.(?:localhost|local)(?:/|$))"`, count: 2 },
    { text: String.raw`"^https://(?:localhost|[^/]*\\.(?:localhost|local|localdomain|lan|home|internal))(?:/|$)"`, count: 1 }
  ]],
  ["lib/runtime-identity.mjs", [
    { text: String.raw`/^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(projection)`, count: 1 }
  ]],
  ["lib/software-job-contract.mjs", [{ text: '  "localhost",', count: 1 }]]
  ,["lib/linkfox-product-detail-api.mjs", [{text:String.raw`!/^(localhost|[0-9.]+)$/i.test(url.hostname)`,count:1}]]
]);

function withoutReviewedRejectionRules(file, sourceText) {
  let remaining = sourceText;
  for (const rule of reviewedRejectionRules.get(file) || []) {
    assert.equal(remaining.split(rule.text).length - 1, rule.count, `拒绝规则必须重新审查: ${file}`);
    remaining = remaining.split(rule.text).join("");
  }
  return remaining;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (/\.(?:mjs|js|jsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

test("Multi-user Central Runtime正式不变量与Codex Independence同时成立", () => {
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.centralServiceIsBusinessAuthority, true);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.browserIsBusinessAuthority, false);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.localWorkerIsBusinessAuthority, false);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.codexIsBusinessAuthority, false);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.revisionRequiredForBusinessMutation, true);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.workerLeaseRequiredForLocalCapability, true);
});

test("现状审计覆盖开发期合理、迁移前抽象和当前最小修正三类", () => {
  const classifications = new Set(LOCAL_RUNTIME_LOCK_IN_AUDIT.map((item) => item.classification));
  assert.deepEqual([...classifications].sort(), [
    "development_local_reasonable", "minimum_fix_now", "must_abstract_before_multi_user"
  ]);
  for (const assumption of [
    "localhost_and_fixed_ports", "macos_keychain", "json_state_file", "whole_json_rewrite",
    "in_memory_job_maps", "single_extension_heartbeat", "global_single_job_gate", "missing_user_identity",
    "missing_worker_identity", "hardcoded_ai_gateway_scope", "fixed_local_paths", "local_clock_as_authority",
    "file_hash_as_concurrency", "service_restart_recovery", "central_and_local_secrets"
  ]) assert.ok(LOCAL_RUNTIME_LOCK_IN_AUDIT.some((item) => item.assumption === assumption), assumption);
});

test("七阶段迁移路线与中央秘密/本机登录秘密边界已正式冻结", () => {
  assert.deepEqual(MULTI_USER_MIGRATION_STAGES.map((stage) => stage.order), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(MULTI_USER_MIGRATION_STAGES.map((stage) => stage.code), [
    "single_machine_single_user", "single_machine_multi_identity", "central_test_service",
    "two_user_pilot", "postgres_migration", "multi_worker", "internal_team_launch"
  ]);
  assert.ok(RUNTIME_SECRET_BOUNDARIES.centralService.includes("ai_model_api_key"));
  assert.ok(RUNTIME_SECRET_BOUNDARIES.localWorker.includes("browser_cookie"));
  assert.ok(!RUNTIME_SECRET_BOUNDARIES.businessRecordMayContain.some((value) => /token|cookie|password|credential/.test(value)));
});

test("生产状态只能通过中央Repository边界，页面/插件/Worker/Codex临时状态全部拒绝", () => {
  assert.equal(assertProductionStatePersistence({
    stateType: "sku_lifecycle", persistenceBoundary: "central_repository"
  }).status, "centrally_persisted");
  for (const boundary of ["react_memory", "browser_local_storage", "plugin_storage", "worker_temp_file", "codex_conversation"]) {
    assert.throws(() => assertProductionStatePersistence({ stateType: "sku_lifecycle", persistenceBoundary: boundary }), new RegExp(CENTRAL_TRUTH_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("本机依赖门禁拒绝领域代码写死地址、个人目录和固定Worker，仅允许明确本地适配器", () => {
  const source = "fetch('http://127.0.0.1:4317'); const root='/Users/fixture-user/data'; const worker='fixed-worker';";
  assert.deepEqual(findLocalMachineDependencies(source).map((item) => item.rule), [
    "loopback_address", "personal_home_path", "fixed_worker_identity"
  ]);
  assert.throws(() => assertNoUnreviewedLocalMachineDependency({ filePath: "lib/domain.mjs", sourceText: source }), new RegExp(MULTI_USER_RUNTIME_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(() => assertNoUnreviewedLocalMachineDependency({
    filePath: "lib/runtime-configuration.mjs", sourceText: source, allowedInfrastructureFile: true
  }), /broad infrastructure allowlist is forbidden/);
  assert.equal(assertNoUnreviewedLocalMachineDependency({
    filePath: "lib/runtime-configuration.mjs",
    sourceText: source,
    boundary: "local_adapter",
    reviewedFindingCounts: { loopback_address: 1, personal_home_path: 1, fixed_worker_identity: 1 }
  }).status, "reviewed_local_adapter");
  assert.throws(() => assertNoUnreviewedLocalMachineDependency({
    filePath: "lib/runtime-configuration.mjs",
    sourceText: `${source} fetch('http://localhost:9999')`,
    boundary: "local_adapter",
    reviewedFindingCounts: { loopback_address: 1, personal_home_path: 1, fixed_worker_identity: 1 }
  }), /Local machine dependency entered production domain/);
});

test("本机依赖扫描覆盖IPv6回环、其他用户目录和动态HOME", () => {
  const source = "fetch('http://[::1]:4317'); const a='file:///Users/alice/private'; os.homedir(); process.env.HOME;";
  assert.deepEqual(findLocalMachineDependencies(source).map((item) => item.rule), [
    "loopback_address", "personal_home_path", "dynamic_home_dependency", "dynamic_home_dependency"
  ]);
});

test("精确拒绝规则声明不豁免新增本机依赖，规则本身变化也必须重新审查", () => {
  for (const [file, rules] of reviewedRejectionRules) {
    const sourceText = rules.flatMap(rule => Array(rule.count).fill(rule.text)).join("\n");
    assert.equal(assertNoUnreviewedLocalMachineDependency({ filePath: file,
      sourceText: withoutReviewedRejectionRules(file, sourceText) }).status, "portable");
    for (const extra of ["fetch('http://localhost:7001')", "const privateFile = '/Users/example/data'", "process.env.HOME"]) {
      assert.throws(() => assertNoUnreviewedLocalMachineDependency({ filePath: file,
        sourceText: withoutReviewedRejectionRules(file, `${sourceText}\n${extra}`) }), /Local machine dependency entered production domain/);
    }
    assert.throws(() => withoutReviewedRejectionRules(file, sourceText.replace("localhost", "changed-localhost")), /拒绝规则必须重新审查/);
  }
});

test("生产源码新增本机假设必须进入明确审计文件，不能静默扩散", async () => {
  const roots = [path.join(appDir, "lib"), path.join(appDir, "src"), path.join(appDir, "extension", "1688-capture")];
  const files = [path.join(appDir, "server.mjs")];
  for (const root of roots) files.push(...await sourceFiles(root));
  const reviewedAdapters = new Map([
    ["extension/1688-capture/background.js", ["worker_adapter", { loopback_address: 1 }]],
    ["extension/1688-capture/bridge.js", ["worker_adapter", { loopback_address: 1 }]],
    ["extension/1688-capture/capture-request.js", ["worker_adapter", { loopback_address: 1 }]],
    ["lib/c1-seo-draft.mjs", ["local_adapter", { personal_home_path: 2 }]],
    ["lib/codex-dispatcher.mjs", ["local_adapter", { loopback_address: 1, dynamic_home_dependency: 1 }]],
    ["lib/http-api-boundary.mjs", ["local_adapter", { loopback_address: 1 }]],
    ["lib/lifecycle-b-real-evidence-readers.mjs", ["local_adapter", { loopback_address: 2 }]],
    ["lib/multi-user-central-runtime.mjs", ["local_adapter", { loopback_address: 3, fixed_worker_identity: 3 }]],
    ["lib/ozon-de-http-transport.mjs", ["local_adapter", { loopback_address: 2 }]],
    // 当前本地开发凭据适配器：URL由配置注入，但只允许本机Ozon凭据服务；不宣称可直接部署到中央服务。
    ["lib/ozon-dictionary-value-reader.mjs", ["local_adapter", { loopback_address: 2 }]],
    ["lib/runtime-configuration.mjs", ["local_adapter", { loopback_address: 8 }]],
    ["lib/runtime-identity-provider.mjs", ["local_adapter", { loopback_address: 4 }]],
    // 采集开始信号只被内容脚本在 http://127.0.0.1:4317 这一个来源上接受，所以给主人的那两句话必须写出这个地址。
    ["src/captureStart.js", ["local_adapter", { loopback_address: 3 }]],
    ["lib/workflow-map.mjs", ["local_adapter", { personal_home_path: 3 }]]
  ]);
  const checked = [];
  for (const file of files) {
    const relative = path.relative(appDir, file);
    const sourceText = await readFile(file, "utf8");
    const findings = findLocalMachineDependencies(sourceText);
    if (findings.length === 0) continue;
    if (reviewedRejectionRules.has(relative)) {
      assert.equal(assertNoUnreviewedLocalMachineDependency({ filePath: relative,
        sourceText: withoutReviewedRejectionRules(relative, sourceText) }).status, "portable");
      checked.push(relative);
      continue;
    }
    const review = reviewedAdapters.get(relative);
    assert.ok(review, `未审计本机依赖: ${relative}`);
    assert.doesNotThrow(() => assertNoUnreviewedLocalMachineDependency({
      filePath: relative,
      sourceText,
      boundary: review[0],
      reviewedFindingCounts: review[1]
    }));
    checked.push(relative);
  }
  assert.deepEqual(checked.sort(), [...reviewedAdapters.keys(), ...reviewedRejectionRules.keys()].sort());
});

test("当前本地运行明确标记为不具备多人并发，中央模式缺任一边界就fail-fast", () => {
  const localRepository = {
    boundaryType: "business_state_repository", authoritative: true, adapter: "json",
    concurrencyScope: "single_process", multiUserReady: false,
    readSnapshot() {}, transact() {}
  };
  const localIdentity = {
    boundaryType: "runtime_identity_provider", providerType: "development_default", multiUserReady: false,
    resolveActor() {}
  };
  const localJobs = { boundaryType: "software_job_store", persistenceClass: "business_state_repository", multiUserReady: false };
  const localWorkers = {
    boundaryType: "worker_registry", persistenceClass: "local_development_ephemeral", multiUserReady: false,
    findEligible() {}
  };
  const localConfiguration = { schemaVersion: "selection-review-runtime-configuration-v1", deploymentMode: "local_development" };
  const status = assertRuntimeBoundaries({
    configuration: localConfiguration,
    businessStateRepository: localRepository,
    identityProvider: localIdentity,
    softwareJobStore: localJobs,
    workerRegistry: localWorkers,
    legacyBusinessMutationPathsPresent: true
  });
  assert.deepEqual([status.status, status.multiUserReady, status.concurrencyScope], ["local_development_ready", false, "single_process"]);
  assert.match(status.limitations.join("\n"), /旧业务写路由/);
  assert.equal(assertProductionStateRepository({ runtimeMode: "local_development", repository: localRepository }).adapter, "json");

  const centralConfiguration = { schemaVersion: "selection-review-runtime-configuration-v1", deploymentMode: "central_test" };
  assert.throws(() => assertRuntimeBoundaries({
    configuration: centralConfiguration,
    businessStateRepository: localRepository,
    identityProvider: localIdentity,
    softwareJobStore: localJobs,
    workerRegistry: localWorkers,
    legacyBusinessMutationPathsPresent: false
  }), /Production state has no central persistence boundary/);
});

test("服务先初始化身份和闭集新A中断对账，仅显式配置可启动消费者且不恢复旧作业", async () => {
  const serverSource = await readFile(path.join(appDir, "server.mjs"), "utf8");
  const identityIndex = serverSource.indexOf("await runtimeIdentityProvider.initialize()");
  const listenIndex = serverSource.indexOf("server.listen(port, host");
  assert.ok(identityIndex >= 0, "身份提供器必须先验证私有存储");
  assert.ok(listenIndex > identityIndex, "身份初始化完成之前不能监听请求");
  // D/E 三类作业是上一轮明确加进重启对账的（见 tests/d-e-restart-filter.test.mjs），这里跟着当前源码断言。
  const reconciliation = "await softwareJobStore.reconcileAfterRestart({jobTypes:['a_product_discovery','a_product_detail_read',\n  'd_production_execution','e_d_platform_observation','e_independent_readback']});";
  const reconciliationIndex=serverSource.indexOf(reconciliation);
  assert.ok(reconciliationIndex>identityIndex&&reconciliationIndex<listenIndex);
  assert.equal([...serverSource.matchAll(/(?:softwareJobStore\.)?reconcileAfterRestart\s*\(/g)].length,1);
  const shutdownIndex = serverSource.indexOf("function closeServer()", listenIndex);
  assert.ok(shutdownIndex > listenIndex);
  const startup = serverSource.slice(listenIndex, shutdownIndex);
  assert.match(startup, /if\s*\(runtimeConfiguration\.dPlatformObservation\.pumpIntervalMs\s*!==\s*null\s*\|\|\s*\(runtimeConfiguration\.eReadbackPumpIntervalMs\s*!==\s*null\s*&&\s*runtimeConfiguration\.deServiceBindings\.length\s*>\s*0\)\)\s*deRuntimeServices\.start\(\)/);
  for(const [configuration,service]of [['keywordEvidenceServiceBindings','keywordEvidenceRuntimeServices'],['aDiscoveryServiceBindings','aDiscoveryRuntime'],['aProductDetailServiceBindings','aProductDetailRuntime']]) {
    assert.ok(startup.includes(`if (runtimeConfiguration.${configuration}.length > 0) ${service}.start();`));
  }
  assert.equal([...startup.matchAll(/\.start\s*\(/g)].length, 4);
  assert.doesNotMatch(startup, /mutateData\(|\.transact\(|\.(?:continueCurrent|continueSavedCurrent|prepareCurrent|authorizeAndEnqueue)\(|deliverDispatch\(|createCandidateDispatch\(/);
});
