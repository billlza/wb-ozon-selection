import test from "node:test";
import assert from "node:assert/strict";
import { IMAGE_MATCH_CHANNEL, OZON_IMAGE_MATCH_CHANNEL, SUPPLIER_CAPTURE_CHANNEL } from "../src/captureStart.js";
import { INTAKE_BRIDGE_ACTIVE_POLL_MS, INTAKE_BRIDGE_IDLE_POLL_MS, createIntakeJobBridge, intakeStartChannel } from "../src/intakeJobBridge.js";

test("开始信号桥：每个排好的作业编号只递一次，走它自己那一种的通道，回执原样交回；读不到队列下一眼再看", async () => {
  assert.equal(intakeStartChannel("supplier_capture"), SUPPLIER_CAPTURE_CHANNEL);
  assert.equal(intakeStartChannel("supplier_image_match"), IMAGE_MATCH_CHANNEL);
  assert.equal(intakeStartChannel("ozon_image_match"), OZON_IMAGE_MATCH_CHANNEL);
  assert.equal(intakeStartChannel("ozon_page_read"), null, "录入流水线不会递别的作业");

  const queues = [
    new Error("network"),
    { items: [{ stage: "reading_source" }], pendingStart: { captureId: "SCJ-1", kind: "supplier_capture" } },
    { items: [{ stage: "reading_source" }], pendingStart: { captureId: "SCJ-1", kind: "supplier_capture" } },
    { items: [{ stage: "searching_ozon" }], pendingStart: { captureId: "OMJ-2", kind: "ozon_image_match" } },
    { items: [{ stage: "ready" }], pendingStart: { captureId: "X-3", kind: "ozon_page_read" } }
  ];
  const signals = [];
  const acks = [];
  const delays = [];
  let scheduled = null;
  const bridge = createIntakeJobBridge({
    readQueue: async () => { const next = queues.shift(); if (next instanceof Error) throw next; return next; },
    signal: async (captureId, page, channel) => { signals.push([captureId, page, channel.request]); return { accepted: captureId === "SCJ-1", code: captureId === "SCJ-1" ? "" : "capture_busy" }; },
    onAck: ack => { acks.push(ack); },
    setTimer: (callback, ms) => { delays.push(ms); scheduled = callback; return delays.length; },
    clearTimer: () => { scheduled = null; }
  });
  bridge.start();
  for (let round = 0; round < 4; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
    const next = scheduled;
    scheduled = null;
    await next?.();
  }
  assert.deepEqual(signals, [["SCJ-1", undefined, SUPPLIER_CAPTURE_CHANNEL.request], ["OMJ-2", undefined, OZON_IMAGE_MATCH_CHANNEL.request]]);
  assert.deepEqual(acks, [{ captureId: "SCJ-1", kind: "supplier_capture", accepted: true, code: "" },
    { captureId: "OMJ-2", kind: "ozon_image_match", accepted: false, code: "capture_busy" }]);
  assert.deepEqual(delays, [INTAKE_BRIDGE_IDLE_POLL_MS, INTAKE_BRIDGE_ACTIVE_POLL_MS, INTAKE_BRIDGE_ACTIVE_POLL_MS, INTAKE_BRIDGE_ACTIVE_POLL_MS,
    INTAKE_BRIDGE_IDLE_POLL_MS]);
  bridge.stop();
  assert.equal(scheduled, null);
  assert.throws(() => createIntakeJobBridge({}), /INTAKE_BRIDGE_QUEUE_READER_REQUIRED/);
});
