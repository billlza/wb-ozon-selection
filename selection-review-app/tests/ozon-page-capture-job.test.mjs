// All long supplier, merchant, task and candidate identities in this test are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalOzonCapturePageUrl,
  ozonCapturePageAddresses,
  ozonCapturePageJobPayload,
  ozonCapturePageJobPublic,
  ozonCapturePageProductId,
  ozonCapturePageTarget,
  ozonPageReadStopMessage,
  shouldRebuildOpportunityFromLegacy
} from "../lib/ozon-page-capture-job.mjs";
import {
  canonicalOzonCaptureSource,
  isOzonCaptureJob,
  validateOzonCaptureRequest,
  validateSupplierCaptureRequest
} from "../extension/1688-capture/capture-request.js";

const PRODUCT_ID = "9999000001";
const CANONICAL = `https://www.ozon.ru/product/${PRODUCT_ID}/`;

function snapshot(extra = {}) {
  return {
    schemaVersion: "sales-snapshot-v1.1",
    snapshotId: extra.snapshotId ?? "sales-snapshot:test",
    platform: "ozon",
    marketScope: "unknown",
    sellerType: "unknown",
    sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "test-evidence" },
    productUrl: CANONICAL,
    title: "Тестовый дождевик",
    imageRefs: [],
    currentPrice: 1457,
    currency: "RUB",
    categoryPath: "Товары для животных > Одежда для собак",
    attributes: {},
    collectedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "test-evidence",
    collectorMode: "provider_category_result_read_only",
    collectorVersion: "seerfar-category-detail-v1",
    readOnly: true,
    ...extra
  };
}

function session(extra = {}) {
  return {
    captureId: "OPR-00000000-0000-4000-8000-000000000001",
    token: "one-time-token",
    candidateId: "candidate:00000000-0000-4000-8000-000000000002",
    requestRevision: 11,
    dataRevision: 12,
    expectedProductId: PRODUCT_ID,
    productUrl: CANONICAL,
    createdAt: Date.parse("2026-09-14T00:00:00.000Z"),
    expiresAt: Date.parse("2026-09-14T00:02:00.000Z"),
    claimedAt: null,
    jobStatus: "queued",
    attempt: 1,
    requiredExtensionVersion: "1.2.9",
    ...extra
  };
}

// 服务端不能 import 插件那一份（本机运行包只带 lib/schema/dist），所以两份实现必须逐条对得上：
// 服务端判得比插件宽一点，插件领取时就会当场退回 source_url_invalid，主人只会看到一次莫名其妙的失败。
test("服务端的 Ozon 地址规范化与插件那一份逐条一致", () => {
  const cases = [
    [CANONICAL, PRODUCT_ID],
    [`https://www.ozon.ru/product/${PRODUCT_ID}`, PRODUCT_ID],
    [`https://www.ozon.ru/product/dozhdevik-dlya-sobak-${PRODUCT_ID}/`, PRODUCT_ID],
    [`https://www.ozon.ru/product/${PRODUCT_ID}/?from=search`, PRODUCT_ID],
    [`http://www.ozon.ru/product/${PRODUCT_ID}/`, PRODUCT_ID],
    [`https://ozon.ru/product/${PRODUCT_ID}/`, PRODUCT_ID],
    [`https://www.ozon.ru:8443/product/${PRODUCT_ID}/`, PRODUCT_ID],
    [`https://user:pass@www.ozon.ru/product/${PRODUCT_ID}/`, PRODUCT_ID],
    [`https://www.ozon.ru/product/${PRODUCT_ID}/reviews`, PRODUCT_ID],
    [`https://www.ozon.ru/category/${PRODUCT_ID}/`, PRODUCT_ID],
    [CANONICAL, "9999000002"],
    [CANONICAL, "12345"],
    [CANONICAL, ""],
    ["not a url", PRODUCT_ID],
    ["", PRODUCT_ID]
  ];
  for (const [value, expectedProductId] of cases) {
    assert.equal(canonicalOzonCapturePageUrl(value, expectedProductId),
      canonicalOzonCaptureSource(value, expectedProductId), `${value} / ${expectedProductId}`);
  }
  assert.equal(canonicalOzonCapturePageUrl(CANONICAL, PRODUCT_ID), CANONICAL);
  assert.equal(canonicalOzonCapturePageUrl(`https://ozon.ru/product/${PRODUCT_ID}/`, PRODUCT_ID), null,
    "只认 www.ozon.ru；放宽一点插件就会退回这次作业");
  assert.equal(ozonCapturePageProductId(`https://www.ozon.ru/product/slug-${PRODUCT_ID}`), PRODUCT_ID);
  assert.equal(ozonCapturePageProductId(`http://www.ozon.ru/product/${PRODUCT_ID}/`), "");
});

test("要读哪个页面只从候选已保存的地址里取，判不出来就停下来说明", () => {
  const newest = snapshot({ snapshotId: "sales-snapshot:new", collectedAt: "2026-09-13T00:00:00.000Z" });
  const older = snapshot({ snapshotId: "sales-snapshot:old", collectedAt: "2026-09-01T00:00:00.000Z" });
  const candidate = { id: "candidate:x", productUrl: CANONICAL, salesSnapshotsV11: [older, newest] };
  assert.deepEqual(ozonCapturePageAddresses(candidate).map(entry => entry.from),
    ["sales_snapshot:sales-snapshot:new", "sales_snapshot:sales-snapshot:old", "candidate_product_url"],
    "最新的快照排在前面，候选自身字段垫底");
  const target = ozonCapturePageTarget(candidate);
  assert.equal(target.ok, true);
  assert.equal(target.productId, PRODUCT_ID);
  assert.equal(target.productUrl, CANONICAL);
  assert.equal(target.from, "sales_snapshot:sales-snapshot:new");

  // 快照坏掉时它不参与：剩下候选自身那个地址仍然能用。
  const broken = { ...newest, currentPrice: -1 };
  const fallback = ozonCapturePageTarget({ id: "candidate:x", productUrl: CANONICAL, salesSnapshotsV11: [broken] });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.from, "candidate_product_url");

  const missing = ozonCapturePageTarget({ id: "candidate:x", productUrl: "unknown", salesSnapshotsV11: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "ozon_product_url_missing");
  assert.match(missing.reason, /没有页面可读/u);

  // 读错商品比读不到更糟：读回来的快照会被当成这件商品的真实证据存档。
  const conflicted = ozonCapturePageTarget({
    id: "candidate:x",
    productUrl: "https://www.ozon.ru/product/9999000002/",
    salesSnapshotsV11: [newest]
  });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, "ozon_product_identity_conflict");
  assert.match(conflicted.reason, /不替你挑一个/u);
  assert.match(conflicted.reason, new RegExp(PRODUCT_ID, "u"));

  assert.equal(ozonCapturePageTarget(null).ok, false);
  assert.equal(ozonCapturePageTarget({}).code, "ozon_product_url_missing");
});

test("插件领取时拿到的作业形状通过 validateOzonCaptureRequest，且绝不带 mode 或 sourceUrl", () => {
  const payload = ozonCapturePageJobPayload(session());
  assert.equal(isOzonCaptureJob(payload), true);
  assert.equal(Object.hasOwn(payload, "mode"), false, "带 mode 会被插件判成 capture_mode_invalid");
  assert.equal(Object.hasOwn(payload, "sourceUrl"), false, "带 sourceUrl 会被插件判成 capture_mode_invalid");
  const validation = validateOzonCaptureRequest({ payload, manifestVersion: "1.2.9" });
  assert.deepEqual(validation, { ok: true, sourceUrl: CANONICAL });
  assert.equal(validateOzonCaptureRequest({ payload, manifestVersion: "1.2.6" }).code, "extension_version_mismatch");
  assert.equal(validateOzonCaptureRequest({ payload: { ...payload, mode: "a_supplier_capture" }, manifestVersion: "1.2.9" }).code, "capture_mode_invalid");
  assert.equal(validateOzonCaptureRequest({ payload: { ...payload, attempt: 2 }, manifestVersion: "1.2.9" }).code, "attempt_invalid");
  assert.equal(validateOzonCaptureRequest({ payload: { ...payload, productUrl: "https://ozon.ru/product/9999000001/" }, manifestVersion: "1.2.9" }).code, "source_url_invalid");

  // 两种作业不会互相认领：1688 的那一份在插件眼里根本不是 Ozon 作业，反过来也一样。
  const supplier = { captureId: "SCJ-1", jobId: "SCJ-1", candidateId: payload.candidateId, dataRevision: 12,
    expectedOfferId: "", sourceUrl: "https://qr.1688.com/s/7OnLCakq", mode: "a_supplier_capture",
    allowShortLinkResolution: true, requiredExtensionVersion: "1.2.9", attempt: 1, token: "t" };
  assert.equal(isOzonCaptureJob(supplier), false);
  assert.equal(validateSupplierCaptureRequest({ payload: supplier, manifestVersion: "1.2.9" }).ok, true);
  assert.equal(validateSupplierCaptureRequest({ payload, manifestVersion: "1.2.9" }).ok, false);
});

test("页面拿到的回执不含一次性令牌", () => {
  const publicJob = ozonCapturePageJobPublic(session({ claimedAt: Date.parse("2026-09-14T00:00:30.000Z") }));
  assert.equal(Object.hasOwn(publicJob, "token"), false);
  assert.equal(publicJob.jobId, "OPR-00000000-0000-4000-8000-000000000001");
  assert.equal(publicJob.expectedProductId, PRODUCT_ID);
  assert.equal(publicJob.productUrl, CANONICAL);
  assert.equal(publicJob.createdAt, "2026-09-14T00:00:00.000Z");
  assert.equal(publicJob.claimedAt, "2026-09-14T00:00:30.000Z");
  assert.equal(publicJob.expiresAt, "2026-09-14T00:02:00.000Z");
  assert.equal(ozonCapturePageJobPublic(session()).claimedAt, null);
});

test("租约结局各有一句实话，不会被说成采集器出了系统错误", () => {
  const sentences = ["extension_job_unclaimed", "unknown_outcome", "capture_job_lost"].map(code => ozonPageReadStopMessage(code));
  assert.equal(new Set(sentences).size, 3);
  for (const sentence of sentences) assert.doesNotMatch(sentence, /系统错误/u);
  assert.match(ozonPageReadStopMessage("extension_job_unclaimed"), /不会自动重试/u);
  assert.match(ozonPageReadStopMessage("unknown_outcome"), /结果未知/u);
  assert.match(ozonPageReadStopMessage("capture_job_lost"), /重新读一次/u);
  assert.match(ozonPageReadStopMessage("something_new"), /已经停下/u);
  assert.equal(ozonPageReadStopMessage("capture_job_lost", "补充说明"), `${ozonPageReadStopMessage("capture_job_lost")}：补充说明`);
});

// 一个候选身上要挂好几个可比商品：最终定价要「多个有效样本比较」，关键词本地素材要 3–5 个已审查竞品，
// 两处读的都是 candidate.salesSnapshotsV11。2026-09-17 之前没有入口能往里加第二个商品。
const OTHER_ID = "9999000003";
const OTHER_URL = `https://www.ozon.ru/product/${OTHER_ID}/`;

test("主人指名要读哪个页面时就读那一个，不再从已存地址反推", () => {
  const candidate = { id: "candidate:x", productUrl: CANONICAL, salesSnapshotsV11: [snapshot()] };
  const target = ozonCapturePageTarget(candidate, OTHER_URL);
  assert.equal(target.ok, true);
  assert.equal(target.productId, OTHER_ID, "读的是主人给的那个商品，不是候选自己的");
  assert.equal(target.productUrl, OTHER_URL);
  assert.equal(target.from, "owner_requested_url", "来源要说明是主人指名的，落盘时据此打对标标记");
});

test("指名的地址不是 Ozon 商品页时当场拒绝，不改写它去凑一个", () => {
  const candidate = { id: "candidate:x", productUrl: CANONICAL, salesSnapshotsV11: [snapshot()] };
  for (const bad of ["https://www.ozon.ru/category/odezhda-33306/", "https://example.com/product/123/",
    "https://www.ozon.ru/product/", "  ", "не ссылка"]) {
    const target = ozonCapturePageTarget(candidate, bad);
    assert.equal(target.ok, false, `${bad} 必须拒绝`);
    assert.equal(target.code, "ozon_product_url_invalid");
  }
});

test("挂了对标之后，这件商品仍然读得了自己的页面：反推时跳过对标", () => {
  const comparable = { ...snapshot({ snapshotId: "sales-snapshot:comparable" }), productUrl: OTHER_URL, comparable: true };
  const candidate = { id: "candidate:x", productUrl: CANONICAL, salesSnapshotsV11: [snapshot(), comparable] };
  assert.equal(ozonCapturePageAddresses(candidate).some(entry => entry.value === OTHER_URL), false,
    "对标不参与「这件商品自己的页面是哪一个」");
  const target = ozonCapturePageTarget(candidate);
  assert.equal(target.ok, true, "挂了对标不该把这件商品自己的页面读成身份冲突");
  assert.equal(target.productId, PRODUCT_ID);

  // 而没打标记的异商品快照仍然照旧判冲突：读错商品比读不到更糟，这一条不能被对标顺带松掉。
  const unmarked = { ...snapshot({ snapshotId: "sales-snapshot:unmarked" }), productUrl: OTHER_URL };
  const conflicted = ozonCapturePageTarget({ id: "candidate:x", productUrl: CANONICAL, salesSnapshotsV11: [snapshot(), unmarked] });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, "ozon_product_identity_conflict");
});

// 2026-09-17 的真实事故：对标采集让「读页面」第一次发生在 C 阶段，而结果处理里那段遗留适配
// 每次都把 A 确认冻下来的机会包覆盖掉——marketAssessment 丢失、parentOpportunityId 退回遗留形态、
// lifecycleV11.status 被退回 opportunity_sales_snapshot_captured。主人的数据实际被损坏过一次。
test("已经有 skuPackage 就绝不用遗留适配器重建机会包：A 确认冻下来的东西不能被读页面覆盖", () => {
  assert.equal(shouldRebuildOpportunityFromLegacy({ id: "c", lifecycleV11: { skuPackage: { skuPackageId: "sku:1" } } }), false,
    "生命周期已经开始了，读一次页面不该重建机会包");

  for (const [why, candidate] of [
    ["还没有生命周期", { id: "c" }],
    ["有 lifecycleV11 但没有 skuPackage", { id: "c", lifecycleV11: {} }],
    ["skuPackage 是 null", { id: "c", lifecycleV11: { skuPackage: null } }],
    ["skuPackage 是数组（坏数据）", { id: "c", lifecycleV11: { skuPackage: [] } }],
    ["候选本身是 null", null]
  ]) {
    assert.equal(shouldRebuildOpportunityFromLegacy(candidate), true, `${why}：这时候才该现造一个机会包`);
  }
});
