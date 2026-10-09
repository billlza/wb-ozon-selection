export const EXPECTED_EXTENSION_VERSION = "1.2.7";
export const EXTENSION_STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
export const EXTENSION_STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
export const EXTENSION_LAST_SEEN_KEY = "selection-review-extension-last-seen";
export const EXTENSION_CAPTURE_ACK_TIMEOUT_MS = 8000;
export const EXTENSION_STATUS_RESPONSE_TIMEOUT_MS = 5000;

export function extensionConnectionStatus({ liveVersion = "", cachedVersion = "", backgroundReady = false, serverHeartbeat = null } = {}) {
  const live = String(liveVersion || "").trim();
  const heartbeatVersion = serverHeartbeat?.fresh === true
    ? String(serverHeartbeat.version || "").trim()
    : "";
  const activeVersion = live || heartbeatVersion;
  const activeBackgroundReady = live
    ? backgroundReady === true
    : serverHeartbeat?.backgroundReady === true;
  const cached = String(cachedVersion || serverHeartbeat?.version || "").trim();
  if (activeVersion) {
    if (activeVersion !== EXPECTED_EXTENSION_VERSION) {
      return { code: "reload_required", label: `插件代码已更新 · 请重新加载（当前v${activeVersion}，需要v${EXPECTED_EXTENSION_VERSION}）` };
    }
    // A background that answers the handshake is connected and waiting for work; only a silent background is a problem.
    // Whether one capture then succeeds is reported by that capture's own result, never by this status line.
    return activeBackgroundReady
      ? { code: "connected", label: "插件已连接 · 等待采集任务" }
      : { code: "background_unavailable", label: `插件已安装 · 后台暂未响应 · 请核对后台连接（v${activeVersion}）` };
  }
  if (cached === EXPECTED_EXTENSION_VERSION) {
    return { code: "page_refresh_required", label: "插件已安装 · 当前页面需要刷新" };
  }
  if (cached) {
    return { code: "reload_required", label: `插件代码已更新 · 请重新加载（当前v${cached}，需要v${EXPECTED_EXTENSION_VERSION}）` };
  }
  return { code: "disconnected", label: "插件未安装或未连接" };
}

export function salesCaptureFailurePresentation(capture = {}, currentExtensionStatus = {}) {
  const reason = String(capture.reason || "未取得结构化销售快照").trim();
  const observedAt = String(capture.observedAt || capture.stoppedAt || "").trim();
  const currentExtensionLabel = String(currentExtensionStatus.label || "当前插件状态未取得").trim();
  return {
    heading: "上一次Ozon采集已停止",
    reason: `上次失败原因：${reason}`,
    observedAt,
    currentExtension: `当前插件状态：${currentExtensionLabel}`,
    explanation: "这是该商品上一次采集的历史结果，不代表插件当前仍未连接。"
  };
}

export function readCachedExtensionVersion(storage = window.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(EXTENSION_LAST_SEEN_KEY) || "null");
    return String(value?.version || "").trim();
  } catch {
    return "";
  }
}
