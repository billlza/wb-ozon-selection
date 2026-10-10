import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  OZON_PAGE_READ_SCOPE_LINE,
  buildOzonCategoryReadStep,
  ozonPageReadInFlight,
  ozonPageReadRecord,
  realPageCategorySnapshot,
  savedCategorySnapshot
} from "../lib/ozon-category-read-step.mjs";

const PRODUCT_ID = "3605840795";
const CANONICAL = `https://www.ozon.ru/product/${PRODUCT_ID}/`;
const SEERFAR_CATEGORY = "宠物用品 > 宠物服装和靴子 > 宠物服装";
const PAGE_CATEGORY = "Товары для животных > Одежда и обувь для животных > Одежда для собак";

const source = name => readFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

function snapshot(extra = {}) {
  return {
    schemaVersion: "sales-snapshot-v1.1",
    snapshotId: "sales-snapshot:seerfar",
    platform: "ozon",
    marketScope: "unknown",
    sellerType: "unknown",
    sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "test-evidence" },
    productUrl: CANONICAL,
    title: "Тестовый дождевик",
    imageRefs: [],
    currentPrice: 1457,
    currency: "RUB",
    categoryPath: SEERFAR_CATEGORY,
    attributes: {},
    collectedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "test-evidence",
    collectorMode: "provider_category_result_read_only",
    collectorVersion: "seerfar-category-detail-v1",
    readOnly: true,
    ...extra
  };
}

const pageSnapshot = (extra = {}) => snapshot({
  snapshotId: "sales-snapshot:real-page",
  categoryPath: PAGE_CATEGORY,
  collectedAt: "2026-09-14T01:00:00.000Z",
  collectorMode: "real_page_read_only",
  collectorVersion: "real-ozon-sales-snapshot-v1",
  ...extra
});

const candidate = (extra = {}) => ({
  id: "candidate:f2e447df-0d83-467b-b6b7-f60aa9ddf1b5",
  dataRevision: 11,
  productUrl: CANONICAL,
  salesSnapshotsV11: [snapshot()],
  ...extra
});

// 线上那一条：类目有，但来自 Seerfar 接口。算利润的服务端只认真实读过的页面，于是主人点了确认才吃到
// B_EVIDENCE_CONTEXT_INCOMPLETE: 当前类目（2026-09-14）。判断必须提前到按钮之前。
test("Seerfar 接口给的类目不算数：算利润不放行，并说清楚为什么和出路", () => {
  const step = buildOzonCategoryReadStep(candidate());
  assert.equal(step.ready, false);
  assert.equal(step.readySource, null);
  assert.equal(step.category, SEERFAR_CATEGORY);
  assert.equal(step.categoryCollectorMode, "provider_category_result_read_only");
  assert.match(step.why, /必须来自真实打开过的 Ozon 商品页/u);
  assert.match(step.why, new RegExp(SEERFAR_CATEGORY, "u"));
  assert.match(step.why, /Seerfar 的接口结果/u);
  assert.deepEqual(step.target, { productId: PRODUCT_ID, productUrl: CANONICAL, from: "sales_snapshot:sales-snapshot:seerfar" });
  assert.equal(step.blocked, null);
  assert.equal(step.action.available, true);
  assert.equal(step.action.label, "读一次这个 Ozon 页面");
  assert.equal(step.lastRead, null);
  assert.equal(step.inFlight, false);
  assert.equal(step.scopeLine, OZON_PAGE_READ_SCOPE_LINE);
  // 这一步做什么、不做什么，每次都说一遍，包括遇到验证码和登录墙时会如实停下。
  assert.match(step.scopeLine, /不下单、不联系任何人，也不向 Ozon 写任何东西/u);
  assert.match(step.scopeLine, /要登录或者要你过验证/u);
  assert.match(step.scopeLine, /不会自己绕过去，也不会编一份结果/u);
});

test("真实读过的页面给的类目才放行；两种来源同时在场时按算利润认的那一份判", () => {
  const both = candidate({ salesSnapshotsV11: [snapshot(), pageSnapshot()] });
  assert.equal(realPageCategorySnapshot(both).snapshotId, "sales-snapshot:real-page");
  assert.equal(savedCategorySnapshot(both).snapshotId, "sales-snapshot:real-page");
  const step = buildOzonCategoryReadStep(both);
  assert.equal(step.ready, true);
  assert.equal(step.readySource, "real_page_snapshot");
  assert.equal(step.category, PAGE_CATEGORY);
  assert.match(step.why, /真实打开 Ozon 商品页读到的/u);
  assert.equal(step.action.available, false);
  assert.match(step.action.reason, /不用再读一次/u);

  // 页面读到了，但页面上没有类目：这仍然不算数。
  const noCategory = candidate({ salesSnapshotsV11: [snapshot(), pageSnapshot({ categoryPath: "unknown" })] });
  assert.equal(realPageCategorySnapshot(noCategory), null);
  assert.equal(buildOzonCategoryReadStep(noCategory).ready, false);

  // 已经存进技术范围的类目同样算数，这时不必再读一次。
  const explicit = buildOzonCategoryReadStep(candidate({ lifecycleEvidenceContextV11: { category: "ozon:17029535:97056" } }));
  assert.equal(explicit.ready, true);
  assert.equal(explicit.readySource, "explicit_context");
  assert.equal(explicit.category, "ozon:17029535:97056");
});

test("一件从来没有类目的商品也说实话，不说成「来自某处」", () => {
  const step = buildOzonCategoryReadStep(candidate({ salesSnapshotsV11: [snapshot({ categoryPath: "unknown" })] }));
  assert.equal(step.ready, false);
  assert.equal(step.category, null);
  assert.equal(step.categoryFrom, null);
  assert.match(step.why, /还没有读到过类目/u);
  assert.equal(step.action.available, true, "读一次仍然是出路");
});

test("读不到页面地址时按钮不给点，理由是保存的地址本身", () => {
  const none = buildOzonCategoryReadStep(candidate({ productUrl: "unknown", salesSnapshotsV11: [snapshot({ productUrl: "https://example.test/x" })] }));
  assert.equal(none.target, null);
  assert.equal(none.blocked.code, "ozon_product_url_missing");
  assert.equal(none.action.available, false);
  assert.equal(none.action.reason, none.blocked.reason);

  const conflict = buildOzonCategoryReadStep(candidate({ productUrl: "https://www.ozon.ru/product/4403916892/" }));
  assert.equal(conflict.blocked.code, "ozon_product_identity_conflict");
  assert.equal(conflict.action.available, false);
});

test("上一次读页面的结局原样带出来，等插件的时候不能再发起第二次", () => {
  const waiting = candidate({ salesCapture: { captureId: "OPR-1", status: "waiting_extension", jobStatus: "queued", productId: PRODUCT_ID, writeOccurred: false } });
  const waitingStep = buildOzonCategoryReadStep(waiting);
  assert.equal(ozonPageReadInFlight(ozonPageReadRecord(waiting)), true);
  assert.equal(waitingStep.inFlight, true);
  assert.equal(waitingStep.action.available, false);
  assert.match(waitingStep.action.reason, /还没有结束/u);

  const claimed = candidate({ salesCapture: { captureId: "OPR-1", status: "capturing", jobStatus: "claimed", productId: PRODUCT_ID, writeOccurred: false } });
  assert.equal(buildOzonCategoryReadStep(claimed).inFlight, true);

  const verification = candidate({ salesCapture: { captureId: "OPR-2", status: "failed", jobStatus: "failed",
    failureCode: "site_verification_required", reason: "Ozon页面要求人工完成验证", observedAt: "2026-09-14T02:00:00.000Z", writeOccurred: false } });
  const failedStep = buildOzonCategoryReadStep(verification);
  assert.equal(failedStep.inFlight, false);
  assert.equal(failedStep.lastRead.failureCode, "site_verification_required");
  assert.equal(failedStep.lastRead.reason, "Ozon页面要求人工完成验证");
  assert.equal(failedStep.lastRead.writeOccurred, false);
  assert.equal(failedStep.action.available, true, "如实停下之后主人可以自己再读一次，软件不自动重试");

  assert.equal(ozonPageReadRecord({}), null);
  assert.equal(ozonPageReadInFlight(null), false);
});

test("开始信号按消息类型参数化，没有第二份实现", async () => {
  const captureStart = await source("captureStart.js");
  assert.match(captureStart, /export const SUPPLIER_CAPTURE_CHANNEL = Object\.freeze\(\{/u);
  assert.match(captureStart, /export const OZON_PAGE_READ_CHANNEL = Object\.freeze\(\{/u);
  assert.match(captureStart, /request: "SELECTION_REVIEW_OZON_CAPTURE_REQUEST"/u);
  assert.match(captureStart, /ack: "SELECTION_REVIEW_OZON_CAPTURE_ACK"/u);
  assert.match(captureStart, /queuedStatus: "ozon_page_read_job_queued"/u);
  // 一条实现、一套回执码：复制出来的第二份迟早会和插件那侧的白名单与拒绝码走散。
  assert.equal(captureStart.match(/page\.postMessage\(\{ type:/gu).length, 1);
  assert.equal(captureStart.match(/export async function startQueuedSupplierCapture/gu).length, 1);
  assert.match(captureStart, /const ack = await signal\(result\.captureJob\.jobId, undefined, channel\);/u);
  assert.match(captureStart, /captureStartMessage\(ack, channel\)/u);
});

test("商品页读页面走自己的处理函数：写操作不经读取守卫，排队回执后必须发 Ozon 那条开始信号", async () => {
  const app = await source("App.jsx");
  assert.match(app, /onReadOzonPage=\{payload => readOzonProductPage\(payload\)\}/u);
  const handler = app.match(/async function readOzonProductPage\(payload\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, "读页面必须有自己的处理函数");
  assert.match(handler[0], /runMutation\(\(\)=>api\.startOzonSalesCapture\(candidateId,payload\)/u);
  assert.doesNotMatch(handler[0], /productDraftReads\.current\.run\(/u,
    "写操作经过“只保留最新读取”的守卫会把服务端的真实回答丢成 null");
  assert.match(handler[0], /startQueuedSupplierCapture\(result,\{channel:OZON_PAGE_READ_CHANNEL\}\)/u);
  assert.match(handler[0], /await load\(true\);setProductDraftRefresh\(value=>value\+1\);/u);
  // 旧版 A 卡上的那个入口也必须发同一条开始信号，否则它建出来的作业只能等到过期。
  assert.match(app, /const captureStart = await startQueuedSupplierCapture\(result, \{ channel: OZON_PAGE_READ_CHANNEL \}\);/u);
  // 1688 那条仍旧调用不带 channel 的同一个 helper，没有被改成另一条路径。
  assert.match(app, /const captureStart = await startQueuedSupplierCapture\(result\);/u);
  assert.match(app, /const start=await startQueuedSupplierCapture\(result\);/u);
});

test("确认按钮之前的那一小块由服务端那份记录说话，页面不自己判", async () => {
  const page = await source("components/ProductPage.jsx");
  assert.match(page, /export function ozonCategoryStepGaps\(step\) \{/u);
  assert.match(page, /view\?\.ozonCategoryReadStepV1 \?\? null/u);
  assert.match(page, /\.\.\.ozonCategoryStepGaps\(categoryStep\)/u,
    "缺项必须并进算利润那张缺项单，按钮才会真的不可点");
  assert.match(page, /<OzonCategoryReadBlock step=\{categoryStep\} saving=\{saving\} onRead=\{onReadOzonPage\} \/>/u);
  // 读完之后这一小块会随商品修订号重建，所以结果只能记在页面那一个提示位上。
  assert.match(page, /const readOzonPage = \(\) => run\(onReadOzonPage, \{ dataRevision: candidate\.dataRevision \}/u);
  assert.doesNotMatch(page, /onReadOzonPage\(\{ *productUrl/u, "目标地址永远不从页面传，只由服务端从已保存的记录里取");
});
