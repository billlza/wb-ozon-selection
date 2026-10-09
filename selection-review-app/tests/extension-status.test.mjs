import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_EXTENSION_VERSION,
  EXTENSION_CAPTURE_ACK_TIMEOUT_MS,
  extensionConnectionStatus,
  salesCaptureFailurePresentation
} from "../src/extensionStatus.js";

test("extension handshake exposes bridge and background state separately", () => {
  // Owner rule 2026-09-11: a background that answers is connected and waiting for work, not "unverified, unusable".
  assert.deepEqual(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: true }), {
    code: "connected",
    label: "插件已连接 · 等待采集任务"
  });
  const silent = extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false });
  assert.equal(silent.code, "background_unavailable");
  assert.match(silent.label, /后台暂未响应/);
  assert.equal(extensionConnectionStatus({ cachedVersion: EXPECTED_EXTENSION_VERSION }).code, "page_refresh_required");
  assert.deepEqual(extensionConnectionStatus({ liveVersion: "1.2.6", backgroundReady: true }), {
    code: "reload_required",
    label: "插件代码已更新 · 请重新加载（当前v1.2.6，需要v1.2.7）"
  });
  assert.deepEqual(extensionConnectionStatus({
    serverHeartbeat: {
      fresh: true,
      version: EXPECTED_EXTENSION_VERSION,
      backgroundReady: true
    }
  }), {
    code: "connected",
    label: "插件已连接 · 等待采集任务"
  });
  assert.equal(extensionConnectionStatus({
    serverHeartbeat: {
      fresh: false,
      version: EXPECTED_EXTENSION_VERSION,
      backgroundReady: true
    }
  }).code, "page_refresh_required");
  assert.equal(extensionConnectionStatus({}).code, "disconnected");
  assert.equal(EXTENSION_CAPTURE_ACK_TIMEOUT_MS, 8000);
});

test("historical sales capture failure is separated from the current extension status", () => {
  const presentation = salesCaptureFailurePresentation({
    reason: "未检测到本机商品采集扩展或扩展尚未重载",
    observedAt: "2026-08-16T01:00:00.000Z"
  }, {
    code: "connected",
    label: `插件已连接 · 后台可用 · v${EXPECTED_EXTENSION_VERSION}`
  });

  assert.equal(presentation.heading, "上一次Ozon采集已停止");
  assert.match(presentation.reason, /^上次失败原因：/);
  assert.equal(presentation.observedAt, "2026-08-16T01:00:00.000Z");
  assert.equal(presentation.currentExtension, `当前插件状态：插件已连接 · 后台可用 · v${EXPECTED_EXTENSION_VERSION}`);
  assert.match(presentation.explanation, /历史结果/);
});
