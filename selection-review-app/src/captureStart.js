export const CAPTURE_START_ACCEPTED_MESSAGE = "插件已领取本次采集，正在读取这个1688页面";

/**
 * 开始信号有两种页面要读：1688 的供应页，和这件商品自己的 Ozon 商品页。
 *
 * 两边的机制完全一样 —— 同一条页面→内容脚本的提示、同一套回执码、同一句「软件不会自动重试」——，不一样的只有
 * 消息类型和「已经开始」那一句话。所以这里把类型参数化，而不是复制一份：复制出来的第二份迟早会和插件那侧的白
 * 名单、超时和拒绝码走散，而那正是 2026-09-11 花掉一个下午去猜的那一类问题。
 */
export const SUPPLIER_CAPTURE_CHANNEL = Object.freeze({
  queuedStatus: "supplier_capture_job_queued",
  request: "SELECTION_REVIEW_1688_CAPTURE_REQUEST",
  ack: "SELECTION_REVIEW_1688_CAPTURE_ACK",
  acceptedMessage: CAPTURE_START_ACCEPTED_MESSAGE
});

export const OZON_PAGE_READ_CHANNEL = Object.freeze({
  queuedStatus: "ozon_page_read_job_queued",
  request: "SELECTION_REVIEW_OZON_CAPTURE_REQUEST",
  ack: "SELECTION_REVIEW_OZON_CAPTURE_ACK",
  acceptedMessage: "插件已领取这次读页面，正在打开并读取这个 Ozon 商品页"
});

export const CAPTURE_START_TIMEOUT_MS = 12000;

// Called only after this page receives the receipt for a newly created, explicit job.
// The extension's rejection code is carried back untouched: without it the page can only say "no confirmation",
// which cost the owner over an hour of diagnosis on 2026-09-11.
export function requestSupplierCaptureStart(captureId, page = window, channel = SUPPLIER_CAPTURE_CHANNEL) {
  if (typeof captureId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(captureId)) {
    throw new Error("本次采集作业编号无效");
  }
  return new Promise((resolve) => {
    const finish = (result) => {
      page.clearTimeout(timer);
      page.removeEventListener("message", receive);
      resolve(result);
    };
    const receive = (event) => {
      if (event.source !== page || event.origin !== page.location.origin ||
          event.data?.type !== channel.ack || event.data.captureId !== captureId) return;
      finish({
        accepted: event.data.accepted === true,
        code: typeof event.data.code === "string" ? event.data.code : ""
      });
    };
    page.addEventListener("message", receive);
    // Nothing answered at all: this tab carries no content script, so no request ever reached the extension.
    const timer = page.setTimeout(() => finish({ accepted: false, code: "no_bridge" }), CAPTURE_START_TIMEOUT_MS);
    page.postMessage({ type: channel.request, captureId }, page.location.origin);
  });
}

/**
 * One sentence per rejection code: what was observed, and the next thing the owner can do. No sentence here claims a
 * technical conclusion the page did not observe, and none of them promises a retry — the software never retries by itself.
 */
export const CAPTURE_START_REJECTION_MESSAGES = Object.freeze({
  no_bridge: "这个标签页里没有采集插件：请用 http://127.0.0.1:4317 打开页面（不是 localhost），按 Cmd+Shift+R 强制刷新后再试；仍然不行就到 chrome://extensions 确认插件已启用",
  capture_busy: "插件正在采另一件商品，等它结束再试",
  extension_identity_rejected: "服务端没有允许这个插件（白名单里没有它的 ID），需要改配置后重启",
  background_unavailable: "插件后台没有响应，请在 chrome://extensions 重新加载插件",
  heartbeat_unavailable: "插件后台还没有和评审台连上，这次没有领取；请确认评审台正在运行，然后重新申请一次采集，软件不会自动重试",
  request_origin_invalid: "插件认为这条开始提示不是来自本机评审台页面，因此拒绝领取；请用 http://127.0.0.1:4317 打开页面后重新申请一次采集，软件不会自动重试",
  start_signal_invalid: "插件认为这条开始提示的格式不对，因此拒绝领取；请按 Cmd+Shift+R 强制刷新页面后重新申请一次采集，软件不会自动重试",
  capture_job_invalid: "插件去服务端领取时，服务端判定这个采集作业已经不能领取，这次没有开始；请重新申请一次采集，软件不会自动重试",
  capture_job_not_claimed: "插件收到了开始提示，但没有完成领取，这次采集没有开始；请重新申请一次采集，软件不会自动重试"
});

const CAPTURE_START_UNKNOWN_MESSAGE = "插件没有确认领取这次采集，也没有说明原因；请查看上面的插件状态后重新申请一次采集，软件不会自动重试";

/**
 * The single ACK-code → owner-sentence mapping. The product page, the older A card and the Ozon page read all read
 * their words from here; only the accepted sentence differs, because only that one names the page being read.
 */
export function captureStartMessage(ack, channel = SUPPLIER_CAPTURE_CHANNEL) {
  if (ack?.accepted === true) return channel.acceptedMessage;
  const code = typeof ack?.code === "string" ? ack.code : "";
  return CAPTURE_START_REJECTION_MESSAGES[code] ?? CAPTURE_START_UNKNOWN_MESSAGE;
}

/** A start signal belongs to a newly created job only; a duplicate receipt describes a job that was already signalled. */
export function needsCaptureStartSignal(result, channel = SUPPLIER_CAPTURE_CHANNEL) {
  return result?.status === channel.queuedStatus && result.duplicate !== true;
}

/**
 * The queued receipt → the start signal → one sentence for the owner. The signal is what actually reaches the extension:
 * the background never polls for jobs, so a confirmation route that skips it leaves the owner waiting for a timeout that
 * can only ever expire (owner, four attempts, 2026-09-11).
 */
export async function startQueuedSupplierCapture(result, { signal = requestSupplierCaptureStart, channel = SUPPLIER_CAPTURE_CHANNEL } = {}) {
  if (!needsCaptureStartSignal(result, channel)) return null;
  const ack = await signal(result.captureJob.jobId, undefined, channel);
  return {
    accepted: ack?.accepted === true,
    code: typeof ack?.code === "string" ? ack.code : "",
    message: captureStartMessage(ack, channel)
  };
}
