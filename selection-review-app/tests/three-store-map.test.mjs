import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  THREE_STORE_MAP_AREAS,
  THREE_STORE_MAP_EXECUTION_STATES,
  THREE_STORE_MAP_REGISTRY,
  assertThreeStoreMapIntegrity,
  buildThreeStoreMapView
} from "../lib/three-store-map.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function allRefs(module) {
  return [...module.codeRefs, ...module.uiRefs, ...module.testEvidence.refs];
}

test("全店能力地图使用稳定编号、完整分区和四种诚实的执行状态", () => {
  assert.equal(assertThreeStoreMapIntegrity(), true);
  assert.deepEqual(Object.keys(THREE_STORE_MAP_EXECUTION_STATES).sort(), [
    "code_not_connected",
    "connected",
    "manual_or_codex_experiment",
    "not_implemented"
  ]);
  assert.equal(new Set(THREE_STORE_MAP_AREAS.map((item) => item.id)).size, THREE_STORE_MAP_AREAS.length);
  assert.equal(new Set(THREE_STORE_MAP_REGISTRY.map((item) => item.id)).size, THREE_STORE_MAP_REGISTRY.length);
  assert.deepEqual(
    Object.fromEntries(THREE_STORE_MAP_REGISTRY.map((item) => [item.id, [item.areaId, item.title]])),
    {
      "1.1": ["1", "保存候选、修订号和本地状态"],
      "1.2": ["1", "主人每天打开的选品台入口"],
      "2.1": ["2", "确认一个可计算的供应方案"],
      "2.2": ["2", "从登录态页面补采外部证据"],
      "2.3": ["2", "按一次授权向正式接口查一轮市场"],
      "2.4": ["2", "把本轮标题翻成中文，只用于展示"],
      "2.5": ["2", "算 A 阶段采购上限，排除预估负利润"],
      "2.6": ["2", "用 1688 图搜找同款供应"],
      "2.7": ["2", "Seerfar 会员网页发现路线"],
      "2.8": ["2", "AI 选品判断层"],
      "3.1": ["3", "算具体 SKU 的利润，并自动交给 C1"],
      "3.2": ["3", "读官方佣金参考表"],
      "4.1": ["4", "整理商品事实、属性和 SEO 草稿"],
      "4.2": ["4", "取得正式关键词与市场证据"],
      "5.1": ["5", "锁定最终素材和最终商品方案"],
      "6.1": ["6", "锁定精确生产授权，不执行写店"],
      "6.2": ["6", "把 Ozon 素材和商品真正写进店铺"],
      "6.3": ["6", "把商品正式写进 WB 店铺"],
      "7.1": ["7", "独立读取 Ozon，确认真实结果"],
      "7.2": ["7", "独立读取 WB，确认真实结果"],
      "8.1": ["8", "异常停机与 Codex 维护支路"],
      "8.2": ["8", "多人中央运行与受控 Worker"],
      "8.3": ["8", "旧 Codex 派发通道（退役候选）"]
    }
  );

  const statuses = new Set(THREE_STORE_MAP_REGISTRY.map((item) => item.executionStatus));
  for (const status of Object.keys(THREE_STORE_MAP_EXECUTION_STATES)) assert.equal(statuses.has(status), true);

  for (const item of THREE_STORE_MAP_REGISTRY) {
    assert.match(item.id, /^\d+\.\d+$/);
    assert.ok(item.plainDescription.length > 12, `${item.id} must have a plain-language purpose`);
    assert.ok(item.inputs.length > 0, `${item.id} must name inputs`);
    assert.ok(item.outputs.length > 0, `${item.id} must name outputs`);
    assert.ok(item.breakpoint.length > 0, `${item.id} must name its current breakpoint`);
    assert.ok(item.nextStep.length > 0, `${item.id} must name its next step`);
    if (item.executionStatus === "connected") {
      assert.equal(item.connection.codePresent, true, `${item.id} connected requires code`);
      assert.equal(item.connection.uiConnected, true, `${item.id} connected requires a UI connection`);
      assert.equal(item.connection.executionConnected, true, `${item.id} connected requires an execution connection`);
      assert.ok(item.testEvidence.refs.length > 0, `${item.id} connected requires test evidence`);
    }
    if (item.executionStatus === "not_implemented") {
      assert.equal(item.connection.codePresent, false, `${item.id} must not call absent code implemented`);
      assert.equal(item.connection.executionConnected, false, `${item.id} must not call absent code connected`);
    }
  }
});

test("全店能力地图的关键断点不把 C1、D/E、WB 或 Codex 维护冒充正常闭环", () => {
  const map = buildThreeStoreMapView({
    runtimeArchitecture: { deploymentMode: "local_development", status: "local_development_ready", multiUserReady: false },
    seerfarSoftwareExecutionEnabled: false
  });
  const moduleById = new Map(map.modules.map((item) => [item.id, item]));

  assert.equal(map.title, "全店能力地图");
  assert.equal(map.readOnly, true);
  assert.match(map.evidenceScope, /不证明/);
  assert.equal(moduleById.get("4.2").executionStatus, "code_not_connected");
  assert.match(moduleById.get("4.2").runtimeNote, /未开启/);
  assert.equal(moduleById.get("6.2").connection.executionConnected, false);
  assert.match(moduleById.get("6.2").breakpoint, /canExecutePlatformWrite=false/);
  assert.equal(moduleById.get("7.1").connection.executionConnected, false);
  assert.match(moduleById.get("7.1").breakpoint, /可信独立读取未接线/);
  assert.equal(moduleById.get("6.3").executionStatus, "not_implemented");
  assert.equal(moduleById.get("7.2").executionStatus, "not_implemented");
  assert.equal(moduleById.get("8.1").executionStatus, "manual_or_codex_experiment");
  assert.match(moduleById.get("8.1").codexRule, /(?:不能|绝不)/);
  assert.match(map.exceptionRoute.returnRule, /不能/);
});

test("全店能力地图记录 A 市场发现到选品台这条已接通的链，并保持稳定的状态计数", () => {
  const map = buildThreeStoreMapView();
  const moduleById = new Map(map.modules.map((item) => [item.id, item]));
  const codePaths = (id) => moduleById.get(id).codeRefs.map((item) => item.path);

  assert.equal(THREE_STORE_MAP_REGISTRY.length, 23);
  const counts = {};
  for (const item of THREE_STORE_MAP_REGISTRY) counts[item.executionStatus] = (counts[item.executionStatus] ?? 0) + 1;
  assert.deepEqual(counts, { connected: 8, code_not_connected: 9, manual_or_codex_experiment: 2, not_implemented: 4 });
  assert.deepEqual(map.mainFlow, ["1.1", "1.2", "2.3", "2.5", "2.1", "2.2", "3.1", "4.1", "4.2", "5.1", "6.1", "6.2", "7.1"]);
  assert.deepEqual(map.exceptionRoute.from, ["2.2", "2.3", "4.2", "6.2", "7.1"]);

  for (const id of ["1.2", "2.3", "2.4", "2.5"]) {
    const item = moduleById.get(id);
    assert.equal(item.executionStatus, "connected", `${id} 必须记为已接通`);
    assert.equal(item.connection.executionConnected, true, `${id} 必须有真实执行链`);
    assert.ok(item.testEvidence.refs.length > 0, `${id} 必须列出定向测试`);
  }

  assert.deepEqual(codePaths("2.3"), [
    "lib/a-discovery-runtime-services.mjs",
    "lib/seerfar-discovery-software-runner.mjs",
    "lib/a-discovery-candidate-import.mjs",
    "lib/seerfar-discovery-contract.mjs",
    "lib/seerfar-open-api-transport.mjs",
    "server.mjs"
  ]);
  assert.deepEqual(codePaths("2.4"), [
    "lib/discovery-title-translation.mjs",
    "lib/discovery-title-translation-store.mjs",
    "server.mjs"
  ]);
  assert.deepEqual(codePaths("2.5"), [
    "lib/a-discovery-estimate.mjs",
    "lib/a-discovery-estimate-store.mjs",
    "lib/ozon-commission-reference-reader.mjs",
    "lib/official-fx-reader.mjs",
    "lib/guoo-tariff-reader.mjs",
    "server.mjs"
  ]);
  assert.deepEqual(moduleById.get("1.2").uiRefs.map((item) => item.path), [
    "src/components/SelectionDesk.jsx",
    "src/components/PipelineBoard.jsx",
    "src/components/OwnerInbox.jsx",
    "src/App.jsx"
  ]);
  assert.match(moduleById.get("2.5").statusReason, /ESTIMATE_EXCLUDED/);
  assert.match(moduleById.get("2.4").plainDescription, /只在原标题旁边展示|并排显示在原标题旁边/);
  assert.equal(moduleById.get("2.3").codeRefs.at(-1).anchor, "/api/product-discovery");
});

test("全店能力地图不把图搜、网页发现、官方费表回退、AI 选品和旧派发说成已完成", () => {
  const map = buildThreeStoreMapView();
  const moduleById = new Map(map.modules.map((item) => [item.id, item]));

  for (const [id, status] of [["2.6", "code_not_connected"], ["2.7", "code_not_connected"], ["2.8", "not_implemented"],
    ["3.2", "code_not_connected"], ["8.3", "code_not_connected"]]) {
    assert.equal(moduleById.get(id).executionStatus, status, `${id} 状态必须保持 ${status}`);
    assert.equal(moduleById.get(id).connection.executionConnected, false, `${id} 不能声称执行已接通`);
  }

  assert.match(moduleById.get("2.6").breakpoint, /PAGE_CONTRACT_UNCONFIGURED/);
  assert.equal(moduleById.get("2.7").connection.uiConnected, false);
  assert.equal(moduleById.get("2.7").codeRefs.length, 1);
  assert.equal(moduleById.get("2.8").codeRefs.length, 0);
  assert.equal(moduleById.get("2.8").testEvidence.refs.length, 0);
  assert.match(moduleById.get("3.2").breakpoint, /OFFICIAL_TABLE_PRICE_MISSING/);
  assert.match(moduleById.get("6.2").breakpoint, /d_production_execution/);
  assert.match(moduleById.get("6.3").statusReason, /跨平台铺货/);
  assert.match(moduleById.get("7.1").breakpoint, /readPlatform: null/);
  assert.match(moduleById.get("8.3").statusReason, /投递开关/);
  assert.match(moduleById.get("8.3").breakpoint, /退役候选/);
});

test("全店能力地图的代码和测试定位均为可检索的项目相对引用", async () => {
  for (const item of THREE_STORE_MAP_REGISTRY) {
    for (const reference of allRefs(item)) {
      assert.equal(path.isAbsolute(reference.path), false, `${item.id} must not expose an absolute path`);
      assert.equal(reference.path.includes(".."), false, `${item.id} must not traverse outside the app`);
      const filePath = path.join(appDir, reference.path);
      await access(filePath);
      const source = await readFile(filePath, "utf8");
      assert.equal(source.includes(reference.anchor), true, `${item.id} reference ${reference.path} must keep its anchor`);
    }
  }
});

test("全店能力地图是只读代码事实，不暴露绝对路径或敏感字段名称", () => {
  const serialized = JSON.stringify(buildThreeStoreMapView());
  assert.doesNotMatch(serialized, /(?:\/Users\/|\\\\Users\\\\|dataFile|runtimeConfiguration)/);
  assert.doesNotMatch(serialized, /(?:api[_-]?key|password|bearer\s|session[_-]?token)/i);
});
