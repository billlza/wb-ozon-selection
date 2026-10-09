import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  captureRequestErrorMessage,
  validateSupplierCaptureRequest
} from "../extension/1688-capture/capture-request.js";
import { waitForCaptureTab } from "../extension/1688-capture/background.js";
import {
  CAPTURE_START_ACCEPTED_MESSAGE,
  CAPTURE_START_REJECTION_MESSAGES,
  CAPTURE_START_TIMEOUT_MS,
  captureStartMessage,
  needsCaptureStartSignal,
  requestSupplierCaptureStart,
  startQueuedSupplierCapture
} from "../src/captureStart.js";

/** A stand-in for the review page's own window: no DOM, no timers, nothing beyond what the start signal touches. */
function capturePage(origin = "http://127.0.0.1:4317") {
  const listeners = new Set();
  const timers = new Map();
  let nextTimerId = 1;
  const page = {
    location: { origin },
    posted: [],
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
    setTimeout(callback, delayMs) { const id = nextTimerId += 1; timers.set(id, { callback, delayMs }); return id; },
    clearTimeout(id) { timers.delete(id); },
    postMessage(message, targetOrigin) { page.posted.push({ message, targetOrigin }); },
    deliver(data, { source = page, origin: eventOrigin = origin } = {}) {
      for (const listener of [...listeners]) listener({ source, origin: eventOrigin, data });
    },
    runTimers() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
    get pendingTimers() { return [...timers.values()]; },
    get listenerCount() { return listeners.size; }
  };
  return page;
}

const ACK = "SELECTION_REVIEW_1688_CAPTURE_ACK";

test("开始信号把插件的拒绝码原样带回，超时按没有内容脚本收口，并只清理自己的监听器", async () => {
  const page = capturePage();
  const accepted = requestSupplierCaptureStart("SCJ-1", page);
  assert.deepEqual(page.posted, [{ message: { type: "SELECTION_REVIEW_1688_CAPTURE_REQUEST", captureId: "SCJ-1" },
    targetOrigin: "http://127.0.0.1:4317" }], "开始提示不得带凭据，且只发给本页来源");
  assert.equal(page.pendingTimers[0].delayMs, CAPTURE_START_TIMEOUT_MS);
  // Anything that is not this page's own ACK for this exact job is ignored and leaves the wait running.
  page.deliver({ type: ACK, captureId: "SCJ-1", accepted: true }, { origin: "https://evil.invalid" });
  page.deliver({ type: ACK, captureId: "SCJ-1", accepted: true }, { source: { other: true } });
  page.deliver({ type: ACK, captureId: "SCJ-OTHER", accepted: false, code: "capture_busy" });
  page.deliver({ type: "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE", captureId: "SCJ-1", accepted: true });
  assert.equal(page.listenerCount, 1);
  page.deliver({ type: ACK, captureId: "SCJ-1", accepted: true, code: "" });
  assert.deepEqual(await accepted, { accepted: true, code: "" });
  assert.equal(page.listenerCount, 0);
  assert.deepEqual(page.pendingTimers, []);

  const busyPage = capturePage();
  const busy = requestSupplierCaptureStart("SCJ-2", busyPage);
  busyPage.deliver({ type: ACK, captureId: "SCJ-2", accepted: false, code: "capture_busy", error: "插件未确认领取作业" });
  assert.deepEqual(await busy, { accepted: false, code: "capture_busy" }, "拒绝码必须保留，否则界面只能说一句未收到确认");

  const codelessPage = capturePage();
  const codeless = requestSupplierCaptureStart("SCJ-3", codelessPage);
  codelessPage.deliver({ type: ACK, captureId: "SCJ-3", accepted: false, code: 17 });
  assert.deepEqual(await codeless, { accepted: false, code: "" });

  const silentPage = capturePage();
  const silent = requestSupplierCaptureStart("SCJ-4", silentPage);
  silentPage.runTimers();
  assert.deepEqual(await silent, { accepted: false, code: "no_bridge" }, "12秒无人应答只能说明这个标签页没有内容脚本");
  assert.equal(silentPage.listenerCount, 0);

  assert.throws(() => requestSupplierCaptureStart("SCJ 5", capturePage()), /作业编号无效/);
  assert.throws(() => requestSupplierCaptureStart(null, capturePage()), /作业编号无效/);
});

test("每个插件回执码都有一句给主人的话，且覆盖桥接脚本能发出的全部码", async () => {
  assert.equal(captureStartMessage({ accepted: true, code: "" }), CAPTURE_START_ACCEPTED_MESSAGE);
  assert.match(captureStartMessage({ accepted: false, code: "no_bridge" }), /127\.0\.0\.1:4317/);
  assert.match(captureStartMessage({ accepted: false, code: "capture_busy" }), /另一件商品/);
  assert.match(captureStartMessage({ accepted: false, code: "extension_identity_rejected" }), /白名单/);
  assert.match(captureStartMessage({ accepted: false, code: "background_unavailable" }), /重新加载插件/);
  for (const code of ["request_origin_invalid", "start_signal_invalid", "capture_job_invalid", "capture_job_not_claimed"]) {
    assert.match(captureStartMessage({ accepted: false, code }), /不会自动重试/, `${code} 必须说明软件不会自动重试`);
  }
  const unknown = captureStartMessage({ accepted: false, code: "something_new" });
  assert.equal(unknown, captureStartMessage({ accepted: false }));
  assert.equal(unknown, captureStartMessage(null));
  assert.match(unknown, /没有说明原因/, "未知码只能说观察到的事实");
  const sentences = Object.values(CAPTURE_START_REJECTION_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length);
  for (const sentence of sentences) assert.equal(sentence.trim().length > 10, true);

  const bridge = await readFile(fileURLToPath(new URL("../extension/1688-capture/bridge.js", import.meta.url)), "utf8");
  const allowList = bridge.match(/\[([^[\]]*)\]\.includes\(response\?\.code\)/);
  assert.ok(allowList, "桥接脚本的回执码白名单形状已变化，这条契约需要重新对齐");
  const bridgeCodes = [...allowList[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]);
  assert.equal(bridgeCodes.length > 0, true);
  for (const code of bridgeCodes) {
    assert.equal(Object.hasOwn(CAPTURE_START_REJECTION_MESSAGES, code), true, `插件可能回 ${code}，但界面没有对应的话`);
  }
});

test("只有新建的采集作业才发开始信号，重复回执和其他状态都不发", async () => {
  const calls = [];
  const signal = async jobId => { calls.push(jobId); return { accepted: true, code: "" }; };
  const queued = { status: "supplier_capture_job_queued", duplicate: false, captureJob: { jobId: "SCJ-new" } };
  assert.equal(needsCaptureStartSignal(queued), true);
  assert.deepEqual(await startQueuedSupplierCapture(queued, { signal }),
    { accepted: true, code: "", message: CAPTURE_START_ACCEPTED_MESSAGE });
  assert.deepEqual(calls, ["SCJ-new"]);

  const duplicate = { status: "supplier_capture_job_queued", duplicate: true, captureJob: { jobId: "SCJ-old" } };
  assert.equal(needsCaptureStartSignal(duplicate), false);
  assert.equal(await startQueuedSupplierCapture(duplicate, { signal }), null);
  assert.equal(await startQueuedSupplierCapture({ status: "a_confirmed" }, { signal }), null);
  assert.equal(await startQueuedSupplierCapture(null, { signal }), null);
  assert.deepEqual(calls, ["SCJ-new"], "重复回执或非排队回执都不得再次触发插件");

  const rejected = await startQueuedSupplierCapture(queued, { signal: async () => ({ accepted: false, code: "no_bridge" }) });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.code, "no_bridge");
  assert.equal(rejected.message, CAPTURE_START_REJECTION_MESSAGES.no_bridge);
});

function validPayload(overrides = {}) {
  return {
    captureId: "SCJ-test",
    token: "one-time-token",
    // The real shape the service sends, colon and all; a synthetic id without it hid this contract for weeks.
    candidateId: "candidate:2e417eaf-7207-4e89-b0d3-5f2c4d9eade3",
    dataRevision: 3,
    mode: "a_supplier_capture",
    sourceUrl: "https://qr.1688.com/s/Abc_123",
    expectedOfferId: "",
    allowShortLinkResolution: true,
    requiredExtensionVersion: "1.2.7",
    attempt: 1,
    ...overrides
  };
}

const captureTab = overrides => ({ id: 7, url: "https://detail.1688.com/offer/943009939489.html", status: "complete", ...overrides });
const captureJob = () => ({ captureId: "SCJ-t", candidateId: "candidate:x", token: "t", dataRevision: 1, attempt: 1,
  mode: "a_supplier_capture", sourceUrl: "https://detail.1688.com/offer/943009939489.html", expectedOfferId: "943009939489",
  requiredExtensionVersion: "1.2.7" });
const fakeChrome = tab => ({ tabs: { onUpdated: { addListener() {}, removeListener() {} }, get: async () => tab } });

test("目标页面一落地就可以开始采集，不必等整页加载完", async () => {
  // 2026-09-12：前三次真实采集都停在「等待1688页面加载超时」。1688 详情页在被 Chrome 限速的后台标签里，15 秒、
  // 25 秒都等不到 load 事件；而采集脚本本来就是在页面里边等边读的，所以只要这个商品页已经落地就该让它进去。
  const loading = await waitForCaptureTab(fakeChrome(captureTab({ status: "loading" })), 7, captureJob(), { timeoutMs: 50 });
  assert.equal(loading.sourceUrl, "https://detail.1688.com/offer/943009939489.html");
  assert.equal(loading.offerId, "943009939489");
  // 还在跳转途中（地址未定）时不能进去，那时候的文档还不是这个商品页。
  await assert.rejects(
    waitForCaptureTab(fakeChrome(captureTab({ status: "loading", pendingUrl: "https://detail.1688.com/offer/943009939489.html" })),
      7, captureJob(), { timeoutMs: 50 }),
    error => error?.code === "timeout");
});

test("采集用的定时器必须绑在全局上：Chrome 不允许把 setTimeout 当成对象方法调用", async () => {
  // 2026-09-12 主人的 Service Worker 控制台：Uncaught (in promise) TypeError: Illegal invocation at executeCapture。
  // 默认值写成 { setTimer: setTimeout } 后，jobTimerOptions.setTimer(…) 的 this 是那个对象，Chrome 直接抛错：
  // 超时没建起来、打开的 1688 标签没人关、结果从未回传、插件永远停在"采集中"。Node 不受这条限制，所以只能盯源码。
  const source = await readFile(fileURLToPath(new URL("../extension/1688-capture/background.js", import.meta.url)), "utf8");
  const defaults = source.match(/jobTimerOptions\s*=\s*\{[^}]*\}/);
  assert.ok(defaults, "默认定时器选项的形状变了，这条契约需要重新对齐");
  assert.doesNotMatch(defaults[0], /setTimer:\s*setTimeout\b/, "setTimer 不能直接持有全局 setTimeout");
  assert.doesNotMatch(defaults[0], /clearTimer:\s*clearTimeout\b/, "clearTimer 不能直接持有全局 clearTimeout");
  assert.match(defaults[0], /setTimer:\s*\(/, "setTimer 必须是包一层的函数，调用时留在全局上");
  assert.match(defaults[0], /clearTimer:\s*(\(|\w+\s*=>)/, "clearTimer 必须是包一层的函数");
});

test("服务端真实作业里的候选编号带冒号，插件必须接受它，不能因此丢弃作业", () => {
  // 2026-09-12：主人连续四次申请采集全部失败，插件的结论码是 capture_job_invalid，插件一次页面都没打开。
  // 根因就是这条身份校验：候选编号是 `candidate:<uuid>`，而当时的正则不许冒号，于是每一份真实作业都无效。
  const real = validPayload({ candidateId: "candidate:2e417eaf-7207-4e89-b0d3-5f2c4d9eade3" });
  assert.deepEqual(validateSupplierCaptureRequest({ payload: real, manifestVersion: "1.2.7" }).ok, true);
  // 采集作业编号自己仍然是严格的那一套，冒号不属于它。
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ captureId: "SCJ:test" }), manifestVersion: "1.2.7" }).code, "request_payload_missing");
  // 放宽只加了冒号和点：空格、斜杠、问号这些能改变请求含义的字符仍然被拒。
  for (const bad of ["candidate:2e417 eaf", "candidate:../other", "candidate:2e417eaf?x=1", ""]) {
    assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ candidateId: bad }), manifestVersion: "1.2.7" }).code,
      "request_payload_missing", `候选编号「${bad}」必须被拒`);
  }
});

test("页面桥接请求按来源、字段、模式、revision和版本返回精确错误码", () => {
  assert.deepEqual(validateSupplierCaptureRequest({
    payload: validPayload(),
    senderUrl: "https://example.com/",
    manifestVersion: "1.2.7"
  }), { ok: false, code: "request_origin_invalid" });
  assert.equal(validateSupplierCaptureRequest({ payload: null, manifestVersion: "1.2.7" }).code, "request_payload_missing");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ token: "" }), manifestVersion: "1.2.7" }).code, "request_payload_missing");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ mode: "listing_preparation" }), manifestVersion: "1.2.7" }).code, "capture_mode_invalid");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ dataRevision: "3" }), manifestVersion: "1.2.7" }).code, "revision_invalid");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload(), manifestVersion: "1.2.6" }).code, "extension_version_mismatch");
  assert.match(captureRequestErrorMessage("extension_version_mismatch"), /插件版本/);
});

test("短链和精确detail链接只接受锁定模式与offer", () => {
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload(), manifestVersion: "1.2.7" }).ok, true);
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({ allowShortLinkResolution: false }),
    manifestVersion: "1.2.7"
  }).code, "short_link_resolution_not_allowed");
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({ sourceUrl: "https://example.com/s/Abc_123" }),
    manifestVersion: "1.2.7"
  }).code, "source_url_invalid");
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({
      sourceUrl: "https://detail.1688.com/offer/876240928352.html",
      expectedOfferId: "876240928352",
      allowShortLinkResolution: false
    }),
    manifestVersion: "1.2.7"
  }).ok, true);
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({
      sourceUrl: "https://detail.1688.com/offer/876240928352.html",
      expectedOfferId: "999",
      allowShortLinkResolution: false
    }),
    manifestVersion: "1.2.7"
  }).code, "expected_offer_invalid");
});
