const ROUTES = Object.freeze({
  SELECTION_REVIEW_1688_CAPTURE_REQUEST: "SELECTION_REVIEW_1688_CAPTURE_ACK",
  SELECTION_REVIEW_OZON_CAPTURE_REQUEST: "SELECTION_REVIEW_OZON_CAPTURE_ACK",
  SELECTION_REVIEW_1688_IMAGE_MATCH_REQUEST: "SELECTION_REVIEW_1688_IMAGE_MATCH_ACK",
  SELECTION_REVIEW_OZON_IMAGE_MATCH_REQUEST: "SELECTION_REVIEW_OZON_IMAGE_MATCH_ACK",
  SELECTION_REVIEW_SEERFAR_WEB_REQUEST: "SELECTION_REVIEW_SEERFAR_WEB_ACK"
});
const STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
const STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
// The key a team's central service made for this computer: the page hands it over once, the background keeps it.
const WORKSTATION_KEY = "SELECTION_REVIEW_WORKSTATION_KEY";
const WORKSTATION_KEY_ACK = "SELECTION_REVIEW_WORKSTATION_KEY_ACK";
const WORKSTATION_KEY_CODES = new Set(["workstation_key_invalid", "workstation_storage_unavailable", "request_origin_invalid", "background_unavailable"]);
const workstationView = (value) => value && typeof value.workstationId === "string" && /^workstation:[0-9a-f-]{36}$/.test(value.workstationId) &&
  typeof value.name === "string" && value.name.length <= 40 ? { workstationId: value.workstationId, name: value.name } : null;
// A tab the worker opened and could not yet account for. Passing the reason on lets the page tell the owner to close that
// tab (or reload the plugin), instead of saying the background is not answering.
const TAB_HOLDS = ["tab_cleanup_failed", "tab_creation_unconfirmed"];
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
      heldBy: TAB_HOLDS.includes(response?.code) ? response.code : "",
      // Which computer this is for the team's service, and whether that service wants this computer added first.
      workstation: workstationView(response?.workstation),
      workstationNotAdded: response?.code === "workstation_not_added",
      // The plugin works for another service (this computer's workbench, or a team's central one) than this page.
      otherService: response?.code === "request_origin_invalid",
      backgroundError: response?.accepted === true ? "" : response?.code === "extension_identity_rejected" ? "插件身份未获服务端允许，禁止领取作业"
        : response?.code === "workstation_not_added" ? "这台电脑还没加进来，插件领不了作业"
        : response?.code === "request_origin_invalid" ? "插件连的不是这个网址，点浏览器右上角的插件图标看看连的是哪个" : "插件后台或评审台连接尚未确认"
    };
  } catch {
    return { backgroundReady: false, serviceConnected: false, lastCaptureCode: "", captureActive: false, heldBy: "", workstation: null,
      workstationNotAdded: false, otherService: false, backgroundError: "插件后台没有响应" };
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
  // The bridge runs only on the pages of the service the plugin was set up for (the manifest, or the plugin's settings page).
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (message?.type === STATUS_PING) {
    await publishStatus(typeof message.nonce === "string" ? message.nonce.slice(0, 128) : "");
    return;
  }
  if (message?.type === WORKSTATION_KEY) {
    // Only the four fields go on to the background, which checks them again; the key is never posted back to the page.
    let response = { accepted: false, code: "background_unavailable" };
    try {
      response = await chrome.runtime.sendMessage({ type: WORKSTATION_KEY, workstationId: message.workstationId, name: message.name, key: message.key });
    } catch {}
    window.postMessage({ type: WORKSTATION_KEY_ACK, workstationId: typeof message.workstationId === "string" ? message.workstationId.slice(0, 64) : "",
      accepted: response?.accepted === true, serviceConnected: response?.serviceConnected === true, workstation: workstationView(response?.workstation),
      code: WORKSTATION_KEY_CODES.has(response?.code) ? response.code : "" }, window.location.origin);
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
    code: ["request_origin_invalid", "start_signal_invalid", "capture_busy", "capture_job_invalid", "capture_job_not_claimed", "heartbeat_unavailable",
      "extension_identity_rejected", "workstation_not_added", "background_unavailable", "tab_cleanup_failed", "tab_creation_unconfirmed"].includes(response?.code)
      ? response.code : "",
    error: response?.accepted === true ? "" : "插件未确认领取作业，请查看当前技术状态"
  }, window.location.origin);
});
