const ROUTES = Object.freeze({
  SELECTION_REVIEW_1688_CAPTURE_REQUEST: "SELECTION_REVIEW_1688_CAPTURE_ACK",
  SELECTION_REVIEW_OZON_CAPTURE_REQUEST: "SELECTION_REVIEW_OZON_CAPTURE_ACK"
});
const STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
const STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const version = chrome.runtime.getManifest().version;

async function readBackgroundStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: BACKGROUND_PING });
    return {
      backgroundReady: response?.accepted === true,
      serviceConnected: response?.serviceConnected === true,
      // What the last capture ended as, in the worker's own words. Without it the page can only report the server-side
      // timeout and never the extension's own reason — exactly how a whole afternoon went into guessing (2026-09-11).
      lastCaptureCode: typeof response?.lastCaptureCode === "string" ? response.lastCaptureCode : "",
      captureActive: response?.captureActive === true,
      backgroundError: response?.accepted === true ? "" : response?.code === "extension_identity_rejected" ? "插件身份未获服务端允许，禁止领取作业" : "插件后台或评审台连接尚未确认"
    };
  } catch {
    return { backgroundReady: false, serviceConnected: false, lastCaptureCode: "", captureActive: false, backgroundError: "插件后台没有响应" };
  }
}

async function publishStatus(nonce = "") {
  const background = await readBackgroundStatus();
  window.postMessage({ type: STATUS_RESPONSE, version, nonce, ...background }, window.location.origin);
}

void publishStatus();
const statusInterval = window.setInterval(() => void publishStatus(), 10000);
window.addEventListener("pagehide", () => window.clearInterval(statusInterval), { once: true });

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== "http://127.0.0.1:4317") return;
  const message = event.data;
  if (message?.type === STATUS_PING) {
    await publishStatus(typeof message.nonce === "string" ? message.nonce.slice(0, 128) : "");
    return;
  }
  const ackType = message && ROUTES[message.type];
  if (!ackType) return;
  const validSignal = Object.keys(message).length === 2 &&
    typeof message.captureId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(message.captureId);
  if (!validSignal) {
    // Correlate a rejection for an older page without forwarding any of its payload to the worker.
    const rejectedId = [message.captureId, message.payload?.captureId].find((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)) || "";
    window.postMessage({ type: ackType, captureId: rejectedId, accepted: false, code: "start_signal_invalid", error: "仅接受无凭据的开始提示" }, window.location.origin);
    return;
  }

  let response = { accepted: false, error: "扩展后台没有响应" };
  try {
    response = await chrome.runtime.sendMessage({
      type: message.type,
      captureId: message.captureId
    });
  } catch {
    response = { accepted: false, code: "background_unavailable" };
  }

  window.postMessage({
    type: ackType,
    captureId: message.captureId,
    accepted: response?.accepted === true,
    code: ["request_origin_invalid", "start_signal_invalid", "capture_busy", "capture_job_invalid", "capture_job_not_claimed", "heartbeat_unavailable", "extension_identity_rejected", "background_unavailable"].includes(response?.code) ? response.code : "",
    error: response?.accepted === true ? "" : "插件未确认领取作业，请查看当前技术状态"
  }, window.location.origin);
});
