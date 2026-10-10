import test from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_MAX_LINKS_PER_PASTE, intakeBlocker, intakeDuplicateOf, intakeLogin1688State, intakePause, intakeProgress, intakeQueue,
  intakeResumePlan, intakeRetryPlan, intakeStageUpdate, newIntakeRecord, nextIntakeWork, parseIntakeLinks
} from "../lib/intake-pipeline.mjs";

// Every link, offer number and record below is synthetic.
const PDD = "https://mobile.yangkeduo.com/goods.html?goods_id=600000000001";
const OFFER = "https://detail.1688.com/offer/712345678901.html";
const IMAGE = "https://img.pddpic.com/garner-api-new/synthetic-main.jpeg";

function intakeCandidate(id, { submittedAt = "2026-10-10T05:00:00.000Z", index = 0, size = 1, sourceKind = "pinduoduo", sourceUrl = PDD, ...extra } = {}) {
  const [link] = parseIntakeLinks([sourceUrl]).links;
  return { id, workflowStatus: "awaiting_user_direction", dataRevision: 1, productName: "录入中的商品",
    intake: newIntakeRecord({ link: { ...link, sourceKind }, submittedAt, submittedBy: "owner-1", batchId: "INB-1", batchIndex: index, batchSize: size }),
    ...extra };
}
const captured = (captureId, extra = {}) => ({ captureId, status: "captured_waiting_owner_selection", mode: "a_supplier_capture", jobStatus: "completed",
  sourceUrl: PDD, offerId: "600000000001", offerStatus: "on_sale", mainImageUrl: IMAGE, title: "合成宠物背心", priceRanges: [],
  skuChoices: [{ sourceSkuId: "a", priceCny: 15.08, inStock: true }, { sourceSkuId: "b", priceCny: 16.5, inStock: true }], ...extra });
const withJobs = (candidate, jobs, records = {}) => ({ ...candidate, ...records, intake: { ...candidate.intake, jobs: { ...candidate.intake.jobs, ...jobs } } });

test("贴链接：一行一条，分享文案里只取地址，两家可以混着贴，重复和认不出的分开说", () => {
  const parsed = parseIntakeLinks([
    `【拼多多】宠物背心 ${PDD}&refer=share 快来看`,
    `${OFFER}?spm=a26352`,
    "https://mobile.yangkeduo.com/goods.html?ps=QSHLQtI1zu",
    PDD,
    "  ",
    "https://www.ozon.ru/product/x-123456/",
    "随便一句话"
  ].join("\n"));
  assert.equal(parsed.tooMany, false);
  assert.deepEqual(parsed.links.map(link => [link.sourceKind, link.sourceUrl, link.offerId, link.identity]), [
    ["pinduoduo", PDD, "600000000001", "pinduoduo:600000000001"],
    ["1688", OFFER, "712345678901", "1688:712345678901"],
    ["pinduoduo", "https://mobile.yangkeduo.com/goods.html?ps=QSHLQtI1zu", "", "url:https://mobile.yangkeduo.com/goods.html?ps=QSHLQtI1zu"]
  ]);
  assert.deepEqual(parsed.rejected.map(entry => entry.code), ["link_unrecognized", "link_unrecognized"]);
  const tooMany = parseIntakeLinks(Array.from({ length: INTAKE_MAX_LINKS_PER_PASTE + 1 }, (_, index) => `${OFFER.replace("901", String(100 + index))}`));
  assert.deepEqual([tooMany.tooMany, tooMany.links.length], [true, 0]);
});

test("查重按商品号认：之前贴过的、Seerfar 挑到同一个 1688 货源的、读过页面才知道商品号的分享短链，淘汰过的也算", () => {
  const [pdd, offer, share] = parseIntakeLinks([PDD, OFFER, "https://mobile.yangkeduo.com/goods.html?ps=QSHLQtI1zu"]).links;
  const otherPdd = { id: "OTHER", sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=600000000999" };
  assert.equal(intakeDuplicateOf([otherPdd], pdd), null, "两个不同 goods_id 的拼多多链接不是同一件");
  const seerfar = { id: "SEERFAR", productUrl: "https://www.ozon.ru/product/x-123456/", sourceUrl: `${OFFER}?offerId=1` };
  assert.equal(intakeDuplicateOf([otherPdd, seerfar], offer)?.id, "SEERFAR");
  const resolvedShare = { id: "SHARE", intake: { sourceUrl: "https://mobile.yangkeduo.com/goods.html?ps=QSHLQtI1zu" },
    sourceCapture: { sourceUrl: PDD, originalSourceUrl: "https://mobile.yangkeduo.com/goods.html?ps=QSHLQtI1zu", offerId: "600000000001" } };
  assert.equal(intakeDuplicateOf([resolvedShare], pdd)?.id, "SHARE", "短链读完以后，贴商品页链接也认得出来");
  assert.equal(intakeDuplicateOf([resolvedShare], share)?.id, "SHARE");
  assert.equal(intakeDuplicateOf([{ ...otherPdd, id: "OLD", sourceUrl: PDD, workflowStatus: "eliminated" }], pdd)?.id, "OLD");
});

test("一件商品走到哪一步：排队 → 读货源页 → 1688 → Ozon → 粗算；作业在等插件时不排下一步", () => {
  const fresh = intakeCandidate("A");
  assert.deepEqual(pick(intakeProgress(fresh)), ["queued", null, "capture_source", false]);
  const reading = withJobs(fresh, { sourceCaptureId: "SCJ-1" }, { sourceCapture: { captureId: "SCJ-1", status: "waiting_extension", jobStatus: "queued" } });
  assert.deepEqual(pick(intakeProgress(reading)), ["reading_source", null, null, true]);
  const read = withJobs(fresh, { sourceCaptureId: "SCJ-1" }, { sourceCapture: captured("SCJ-1") });
  assert.deepEqual(pick(intakeProgress(read)), ["searching_1688", null, "search_1688", false]);
  assert.equal(intakeProgress(read, { login1688Expired: true }).next, "skip_1688");
  const searching = withJobs(read, { supplierMatchId: "IMJ-1" }, { supplierImageMatch: { captureId: "IMJ-1", status: "searching", jobStatus: "claimed" } });
  assert.deepEqual(pick(intakeProgress(searching)), ["searching_1688", null, null, true]);
  const found = withJobs(read, { supplierMatchId: "IMJ-1" }, { supplierImageMatch: { captureId: "IMJ-1", status: "compared", jobStatus: "completed" } });
  assert.deepEqual(pick(intakeProgress(found)), ["searching_ozon", null, "search_ozon", false]);
  const ozon = withJobs(found, { ozonMatchId: "OMJ-1" }, { ozonImageMatch: { captureId: "OMJ-1", status: "compared", jobStatus: "completed" } });
  assert.deepEqual(pick(intakeProgress(ozon)), ["estimating", null, "estimate", false]);
  assert.deepEqual(pick(intakeProgress({ ...ozon, intake: { ...ozon.intake, stage: "ready" } })), ["ready", null, null, false]);
});

test("货源页停下：滑块、登录、插件没领是整页的事；分享链接没打开、下架、没货、没价、没首图只拦这一件；结果未知等主人重跑", () => {
  const base = intakeCandidate("B");
  const failed = (failureCode, extra = {}) => withJobs(base, { sourceCaptureId: "SCJ-2" },
    { sourceCapture: { captureId: "SCJ-2", status: "failed", jobStatus: "failed", failureCode, ...extra } });
  const blocker = candidate => intakeProgress(candidate).blocker;
  assert.deepEqual(pickBlocker(blocker(failed("site_verification_required"))), ["slider_required", "page", true, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("site_login_required"))), ["login_pinduoduo_required", "page", true, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("extension_job_unclaimed"))), ["plugin_offline", "page", true, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("capture_job_lost"))), ["plugin_offline", "page", true, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("short_link_resolution_failed"))), ["share_link_unresolved", "item", false, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("exact_price_unavailable"))), ["no_source_price", "item", false, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("unknown_outcome", { jobStatus: "unknown_outcome" }))), ["unknown_outcome", "item", true, "capture_source"]);
  assert.deepEqual(pickBlocker(blocker(failed("timeout"))), ["source_unreadable", "item", true, "capture_source"]);
  const read = extra => withJobs(base, { sourceCaptureId: "SCJ-2" }, { sourceCapture: captured("SCJ-2", extra) });
  assert.equal(blocker(read({ offerStatus: "off_sale" })).code, "source_delisted");
  assert.equal(blocker(read({ skuChoices: [{ sourceSkuId: "a", priceCny: 9, inStock: false }] })).code, "source_out_of_stock");
  assert.equal(blocker(read({ skuChoices: [{ sourceSkuId: "a", priceCny: null, inStock: true }] })).code, "no_source_price");
  assert.equal(blocker(read({ mainImageUrl: null })).code, "source_image_missing");
  assert.equal(blocker(read({ skuChoices: [{ sourceSkuId: "a", priceCny: null, inStock: true }], priceRanges: [{ minimumQuantity: 1, priceCny: 9 }] })), null);
  assert.equal(blocker(withJobs(base, { sourceCaptureId: "SCJ-2" }, { sourceCapture: captured("SCJ-OTHER") })).code, "source_unreadable",
    "货源记录被另一次采集换掉了，这一轮不认");
});

test("找同款没找到、上传框没找到、结果未知都照样往下走；1688 没登录不拦这件；滑块和插件没领要停", () => {
  const read = withJobs(intakeCandidate("C"), { sourceCaptureId: "SCJ-3" }, { sourceCapture: captured("SCJ-3") });
  const supplier = (failureCode, jobStatus = "failed") => withJobs(read, { supplierMatchId: "IMJ-3" },
    { supplierImageMatch: { captureId: "IMJ-3", status: "failed", jobStatus, failureCode } });
  assert.equal(intakeProgress(supplier("results_unverifiable")).next, "search_ozon");
  assert.equal(intakeProgress(supplier("site_login_required")).next, "search_ozon");
  assert.equal(intakeProgress(supplier("unknown_outcome", "unknown_outcome")).next, "search_ozon");
  assert.deepEqual(pickBlocker(intakeProgress(supplier("site_verification_required")).blocker), ["slider_required", "page", true, "search_1688"]);
  assert.deepEqual(pickBlocker(intakeProgress(supplier("extension_job_unclaimed")).blocker), ["plugin_offline", "page", true, "search_1688"]);
  const ozon = (failureCode) => withJobs(supplier("results_unverifiable"), { ozonMatchId: "OMJ-3" },
    { ozonImageMatch: { captureId: "OMJ-3", status: "failed", jobStatus: "failed", failureCode } });
  assert.equal(intakeProgress(ozon("image_upload_unavailable")).next, "estimate");
  assert.equal(intakeProgress(ozon("site_verification_required")).blocker.step, "search_ozon");
  const manual = withJobs(read, { supplierMatchId: "IMJ-3" }, { supplierImageMatch: { captureId: "IMJ-MANUAL", status: "searching", jobStatus: "claimed" } });
  assert.equal(intakeProgress(manual).next, "search_ozon", "主人在商品页上自己搜的那次不算这一轮的作业");
});

test("排队：按贴进来的先后和行序；插件一次一个，在等插件时不排别的要插件的步骤，但粗算照常做；整页停下时整条队停着", () => {
  const first = intakeCandidate("Q1", { index: 0, size: 3 });
  const second = intakeCandidate("Q2", { index: 1, size: 3 });
  const third = intakeCandidate("Q3", { index: 2, size: 3 });
  const queue = intakeQueue([third, first, second]);
  assert.deepEqual(queue.map(entry => [entry.candidate.id, entry.queue, entry.batch]), [
    ["Q1", { position: 1, total: 3 }, { position: 1, total: 3 }], ["Q2", { position: 2, total: 3 }, { position: 2, total: 3 }],
    ["Q3", { position: 3, total: 3 }, { position: 3, total: 3 }]]);
  assert.deepEqual(pickWork(nextIntakeWork([third, first, second])), ["Q1", "capture_source"]);
  assert.equal(nextIntakeWork([first], { extensionReady: false }), null, "插件没连上时排着的根本不开始");

  const waiting = withJobs(first, { sourceCaptureId: "SCJ-Q1" }, { sourceCapture: { captureId: "SCJ-Q1", status: "capturing", jobStatus: "claimed" } });
  assert.equal(nextIntakeWork([waiting, second]), null);
  const estimating = withJobs(second, { sourceCaptureId: "S", supplierMatchId: "I", ozonMatchId: "O" },
    { sourceCapture: captured("S"), supplierImageMatch: { captureId: "I", status: "compared" }, ozonImageMatch: { captureId: "O", status: "compared" } });
  assert.deepEqual(pickWork(nextIntakeWork([waiting, estimating])), ["Q2", "estimate"]);

  const slider = withJobs(first, { sourceCaptureId: "SCJ-Q1" },
    { sourceCapture: { captureId: "SCJ-Q1", status: "failed", jobStatus: "failed", failureCode: "site_verification_required" } });
  assert.equal(nextIntakeWork([slider, third]), null);
  assert.deepEqual(intakePause([slider, third]), { code: "slider_required", message: `${intakeBlocker("slider_required").message}（拼多多）`,
    candidateId: "Q1" });
  const itemOnly = withJobs(first, { sourceCaptureId: "SCJ-Q1" },
    { sourceCapture: { captureId: "SCJ-Q1", status: "failed", jobStatus: "failed", failureCode: "short_link_resolution_failed" } });
  assert.deepEqual(pickWork(nextIntakeWork([itemOnly, third])), ["Q3", "capture_source"], "只拦一件的不挡后面的");
});

test("1688 登录状态：最近一次 1688 找同款说要登录就是过期；主人点「接着找」之后不算", () => {
  const read = withJobs(intakeCandidate("L1"), { sourceCaptureId: "S" }, { sourceCapture: captured("S") });
  const login = withJobs(read, { supplierMatchId: "I1" },
    { supplierImageMatch: { captureId: "I1", status: "failed", failureCode: "site_login_required", completedAt: "2026-10-10T05:10:00.000Z" } });
  assert.equal(intakeLogin1688State([read]), "unknown");
  assert.equal(intakeLogin1688State([login]), "expired");
  const later = withJobs(intakeCandidate("L2", { index: 1 }), { sourceCaptureId: "S2", supplierMatchId: "I2" },
    { sourceCapture: captured("S2"), supplierImageMatch: { captureId: "I2", status: "compared", completedAt: "2026-10-10T05:20:00.000Z" } });
  assert.equal(intakeLogin1688State([login, later]), "ok");
  const resumed = { ...login, intake: { ...login.intake, resumedAt: "2026-10-10T05:15:00.000Z" } };
  assert.equal(intakeLogin1688State([resumed]), "unknown");
});

test("写回 stage：变了才写；停下的一直停着，直到主人重跑", () => {
  const read = withJobs(intakeCandidate("W"), { sourceCaptureId: "S" }, { sourceCapture: captured("S") });
  assert.deepEqual(intakeStageUpdate(read), { stage: "searching_1688", blocker: null });
  assert.equal(intakeStageUpdate({ ...read, intake: { ...read.intake, stage: "searching_1688" } }), null);
  const unknown = withJobs(intakeCandidate("W"), { sourceCaptureId: "S" },
    { sourceCapture: { captureId: "S", status: "failed", jobStatus: "unknown_outcome", failureCode: "unknown_outcome" } });
  const update = intakeStageUpdate(unknown);
  assert.equal(update.blocker.code, "unknown_outcome");
  const stuck = { ...unknown, intake: { ...unknown.intake, ...update } };
  assert.equal(intakeStageUpdate(stuck), null);
  assert.equal(intakeStageUpdate({ ...stuck, workflowStatus: "eliminated" }), null);
});

test("重跑：只对停下而且能重跑的；读货源页重跑时后面几步一起重来，结果未知的算主人知道了；不能重跑的说清楚", () => {
  const unknown = withJobs(intakeCandidate("R"), { sourceCaptureId: "S", supplierMatchId: "OLD" },
    { sourceCapture: { captureId: "S", status: "failed", jobStatus: "unknown_outcome", failureCode: "unknown_outcome" } });
  const plan = intakeRetryPlan(unknown, { requestedAt: "2026-10-10T06:00:00.000Z", requestedBy: "owner-1" });
  assert.equal(plan.ok, true);
  assert.equal(plan.acknowledgeSourceUnknown, true);
  assert.deepEqual([plan.intake.stage, plan.intake.jobs, plan.intake.lastRetry.step],
    ["queued", { sourceCaptureId: null, supplierMatchId: null, ozonMatchId: null }, "capture_source"]);
  assert.equal(intakeProgress({ ...unknown, intake: plan.intake }).next, "capture_source");

  const read = withJobs(intakeCandidate("R2"), { sourceCaptureId: "S", supplierMatchId: "I" },
    { sourceCapture: captured("S"), supplierImageMatch: { captureId: "I", status: "failed", jobStatus: "failed", failureCode: "site_verification_required" } });
  const matchPlan = intakeRetryPlan(read, { requestedAt: "t", requestedBy: "owner-1" });
  assert.deepEqual([matchPlan.step, matchPlan.intake.jobs.sourceCaptureId, matchPlan.intake.jobs.supplierMatchId, matchPlan.acknowledgeSourceUnknown],
    ["search_1688", "S", null, false]);

  const delisted = withJobs(intakeCandidate("R3"), { sourceCaptureId: "S" }, { sourceCapture: captured("S", { offerStatus: "off_sale" }) });
  assert.deepEqual(intakeRetryPlan(delisted), { ok: false, code: "intake_not_retryable" });
  assert.deepEqual(intakeRetryPlan(intakeCandidate("R4")), { ok: false, code: "intake_not_blocked" });
});

test("接着找：整页停下的每一件重跑那一步；因为没登录 1688 跳过的，还没过「做这件」的补搜一次", () => {
  const slider = withJobs(intakeCandidate("P1"), { sourceCaptureId: "S1" },
    { sourceCapture: { captureId: "S1", status: "failed", jobStatus: "failed", failureCode: "site_verification_required" } });
  const delisted = withJobs(intakeCandidate("P2", { index: 1 }), { sourceCaptureId: "S2" }, { sourceCapture: captured("S2", { offerStatus: "off_sale" }) });
  const skipped = { ...withJobs(intakeCandidate("P3", { index: 2 }), { sourceCaptureId: "S3", ozonMatchId: "O3" },
    { sourceCapture: captured("S3"), ozonImageMatch: { captureId: "O3", status: "compared" } }) };
  skipped.intake = { ...skipped.intake, stage: "ready", skips: { supplierMatch: "login_1688_required" } };
  const accepted = { ...skipped, id: "P4", gate1: { accepted: true } };
  const plans = intakeResumePlan([slider, delisted, skipped, accepted], { requestedAt: "2026-10-10T06:00:00.000Z", requestedBy: "owner-1",
    stillOpen: candidate => !candidate.gate1 });
  assert.deepEqual(plans.map(plan => [plan.candidateId, plan.intake.stage, plan.intake.lastRetry.step, plan.intake.resumedAt]), [
    ["P1", "queued", "capture_source", "2026-10-10T06:00:00.000Z"],
    ["P3", "searching_1688", "search_1688", "2026-10-10T06:00:00.000Z"]]);
  const p3 = { ...skipped, intake: plans[1].intake };
  assert.equal(intakeProgress(p3).next, "search_1688");
});

function pick(progress) {
  return [progress.stage, progress.blocker, progress.next, progress.waiting];
}
function pickBlocker(blocker) {
  return [blocker.code, blocker.scope, blocker.retryable, blocker.step];
}
function pickWork(work) {
  return work ? [work.candidate.id, work.step] : null;
}
