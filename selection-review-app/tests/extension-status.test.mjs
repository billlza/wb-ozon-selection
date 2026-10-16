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
    label: "插件代码已更新 · 请重新加载（当前v1.2.6，需要v1.6.0）"
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

test("a plugin that answers but holds new jobs for a page it opened says which, not that its background is silent", () => {
  const leftOpen = extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false, heldBy: "tab_cleanup_failed" });
  assert.equal(leftOpen.code, "tab_left_open");
  assert.match(leftOpen.label, /没关上.*关掉它就能接着采集/u);
  const unconfirmed = extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false, heldBy: "tab_creation_unconfirmed" });
  assert.equal(unconfirmed.code, "tab_unconfirmed");
  assert.match(unconfirmed.label, /重新加载插件/u);
  // Only this tab's live answer can name a held page; a ready plugin, an old one, an unknown reason or the heartbeat cannot.
  assert.equal(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: true, heldBy: "tab_cleanup_failed" }).code, "connected");
  assert.equal(extensionConnectionStatus({ liveVersion: "1.2.6", backgroundReady: false, heldBy: "tab_cleanup_failed" }).code, "reload_required");
  assert.equal(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false, heldBy: "something_else" }).code,
    "background_unavailable");
  assert.equal(extensionConnectionStatus({ heldBy: "tab_cleanup_failed",
    serverHeartbeat: { fresh: true, version: EXPECTED_EXTENSION_VERSION, backgroundReady: false } }).code, "background_unavailable");
});

test("a plugin that works for another address says so, and one that does not answer says where to look", () => {
  assert.deepEqual(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false, otherService: true }),
    { code: "other_service", label: "插件连的是别的服务地址 · 点浏览器右上角的插件图标，改成这个网址" });
  // A plugin of the wrong version hears first that it must be reloaded; the heartbeat alone cannot say which address the plugin is on.
  assert.equal(extensionConnectionStatus({ liveVersion: "1.5.0", backgroundReady: false, otherService: true }).code, "reload_required");
  assert.equal(extensionConnectionStatus({ otherService: true,
    serverHeartbeat: { fresh: true, version: EXPECTED_EXTENSION_VERSION, backgroundReady: true } }).code, "connected");
  assert.match(extensionConnectionStatus({}).label, /点浏览器右上角的插件图标，看连的是不是这个网址/u);
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
