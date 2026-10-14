import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("C阶段运行展示只认本次执行证明，历史派发不补位", async () => {
  const inspector = await readFile(path.join(appDir, "src", "components", "UserInspector.jsx"), "utf8");
  const panel = inspector.slice(inspector.indexOf("function ListingPreparationPanel("), inspector.indexOf("function ReadyPanel("));
  assert.match(panel, /const dispatch = candidate\.activeDispatch;/);
  assert.doesNotMatch(panel, /candidate\.latestDispatch/);
  assert.match(panel, /candidate\.executionRuntimeView\?\.currentExecutionConfirmed === true/);
  assert.match(panel, /历史C阶段记录 · 当前运行未确认/);
  assert.match(panel, /历史待上架准备记录/);
  assert.match(panel, /const waitingPermission = dispatch\?\.status === "permission_required"/);
  assert.match(panel, /!currentExecution && !waitingPermission/);
  assert.match(panel, /C阶段技术维护 · 等待权限决定/);
  assert.match(panel, /旧领取、排队或运行状态仅供追溯/);
  assert.match(panel, /currentCapture \? "正在读取1688商品" : "采集记录 · 当前执行未确认"/);
  assert.match(panel, /captureExecutionConfirmed\(candidate, sourceCapture, candidate\.currentSourceCapture\)/);
  assert.match(panel, /\["waiting_extension", "capturing"\]\.includes\(sourceCapture\.status\)/);
  assert.match(inspector, /proof\?\.currentExecutionConfirmed === true/);
  assert.match(inspector, /proof\.candidateId === candidate\.id && proof\.candidateRevision === candidate\.dataRevision/);
  assert.match(inspector, /proof\.captureId === capture\.captureId/);
  assert.match(inspector, /历史Ozon采集记录 · 当前执行未确认/);
  assert.match(inspector, /当前销售采集领取协议尚未接通/);
  assert.doesNotMatch(inspector, /currentSalesCapture/);
  assert.match(inspector, /currentCapture \? "正在补采1688只读证据" : "历史1688采集记录 · 当前执行未确认"/);
});

test("C2界面只在新版等待态提供本地素材排序与一次主人确认", async () => {
  const inspector = await readFile(path.join(appDir, "src", "components", "UserInspector.jsx"), "utf8");
  assert.match(inspector, /c2Assets\.softwareState/);
  const assets = await readFile(path.join(appDir, "src", "components", "C2FinalAssetsPanel.jsx"), "utf8");
  assert.match(assets, /type="file" multiple/);
  assert.match(assets, /本规格需要自己的首图/);
  assert.match(assets, /candidate\.siblingSourceV1/);
  assert.match(assets, /\.jpg,\.jpeg,\.png,\.webp/);
  assert.match(assets, /视频内容校验尚未配置/);
  assert.match(assets, /上移/);
  assert.match(assets, /下移/);
  assert.match(assets, /我确认以上文件属于当前SKU，并确认所选用途、唯一首图、顺序/);
  assert.match(assets, /确认最终素材并生成方案卡/);
  assert.match(assets, /不创建生产授权、不派发任务、不访问或写入店铺/);
  assert.match(assets, /selectedC2DraftAssets\(draft\)/);
  assert.match(assets, /draftRevision/);
  assert.match(assets, /onSave\(\{ dataRevision, draftRevision, selection \}\)/);
  assert.doesNotMatch(assets, /assets\.length\}\/30/);
});

test("C2素材上传和最终确认使用分离接口，选择文件不会直接确认", async () => {
  const api = await readFile(path.join(appDir, "src", "api.js"), "utf8");
  const app = await readFile(path.join(appDir, "src", "App.jsx"), "utf8");
  assert.match(api, /lifecycle\/c2\/final-assets\/upload\?dataRevision=/);
  assert.match(api, /confirmLifecycleFinalAssets/);
  assert.match(app, /uploadLifecycleFinalAsset/);
  assert.match(app, /confirmLifecycleFinalAssets/);
  assert.match(app, /尚未生产授权，也没有店铺写入/);
});

// 对标样本面板。2026-09-17 主人第一次用就卡住：采集排队等插件那两分钟里，连输入框都被禁了，
// 下一个地址贴不进去。贴一个地址不伤害任何东西——该禁的只有「读」这个动作本身。
test("对标面板：排队时只禁按钮不禁输入，地址必须是 Ozon 商品页，且由主人自己贴", async () => {
  const inspector = await readFile(path.join(appDir, "src", "components", "UserInspector.jsx"), "utf8");
  const panel = inspector.slice(inspector.indexOf("function ComparableCapturePanel("),
    inspector.indexOf("function ListingPreparationPanel("));
  assert.ok(panel.length > 0, "对标面板必须在");

  assert.match(panel, /<input type="url"[^>]*disabled=\{saving\}/,
    "输入框只在请求发送中禁用，不能因为有作业在排队就禁掉");
  assert.doesNotMatch(panel, /<input type="url"[^>]*disabled=\{saving \|\| busy\}/,
    "排队中禁输入正是 2026-09-17 卡住主人的那一下");

  assert.match(panel, /<button[^>]*disabled=\{!valid \|\| saving \|\| busy\}/,
    "「读」这个动作一次只能一个，排队中必须禁按钮");

  assert.match(panel, /ozon\\\.ru\\\/product\\\//, "只接受 Ozon 商品页地址");
  assert.match(panel, /不替你从类目里挑/, "对标由主人自己贴，软件不替他挑「像的」商品");
  assert.match(panel, /snapshot\?\.comparable === true/, "列出的是已打对标标记的快照");
  assert.match(panel, /if \(!candidate\.lifecycleV11\?\.skuPackage\) return null;/,
    "只在已经进入C阶段的商品上出现");
});
