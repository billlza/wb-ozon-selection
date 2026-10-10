import { IMAGE_MATCH_CHANNEL, OZON_IMAGE_MATCH_CHANNEL, SUPPLIER_CAPTURE_CHANNEL, requestSupplierCaptureStart } from "./captureStart.js";

/**
 * 录入流水线的开始信号。
 *
 * 插件从不自己去服务端找活干：它只领取工作台页面递过来的那一个作业编号（开始信号），这是插件那一侧的安全规矩，不改。
 * 录入泵在服务端排好一步以后，就靠开着的工作台页面把编号递给插件——和主人在商品页上点「找同款」时页面做的是同一件事，
 * 同一条通道、同一套回执码。页面每隔几秒看一眼「找货中」，有刚排好、还没领取的就递一次；同一个编号只递一次，
 * 插件没领的不会再递（作业到期后停下，等主人点「接着找」），软件不自动重试。
 */
export const INTAKE_BRIDGE_ACTIVE_POLL_MS = 3000;
export const INTAKE_BRIDGE_IDLE_POLL_MS = 15000;
const CHANNELS = Object.freeze({
  supplier_capture: SUPPLIER_CAPTURE_CHANNEL,
  supplier_image_match: IMAGE_MATCH_CHANNEL,
  ozon_image_match: OZON_IMAGE_MATCH_CHANNEL
});

export function intakeStartChannel(kind) {
  return CHANNELS[kind] ?? null;
}

const openWork = (queue) => Array.isArray(queue?.items) && queue.items.some((item) => !["ready", "blocked"].includes(item?.stage));

export function createIntakeJobBridge({ readQueue, onAck = () => {}, signal = requestSupplierCaptureStart,
  setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = (timer) => clearTimeout(timer) }) {
  if (typeof readQueue !== "function") throw new TypeError("INTAKE_BRIDGE_QUEUE_READER_REQUIRED");
  const signalled = new Set();
  let timer = null;
  let running = false;
  let stopped = true;

  async function tick() {
    timer = null;
    if (running || stopped) return;
    running = true;
    let queue = null;
    try {
      queue = await readQueue();
      const pending = queue?.pendingStart;
      const channel = intakeStartChannel(pending?.kind);
      if (channel && typeof pending.captureId === "string" && !signalled.has(pending.captureId)) {
        signalled.add(pending.captureId);
        const ack = await signal(pending.captureId, undefined, channel);
        await onAck({ captureId: pending.captureId, kind: pending.kind, accepted: ack?.accepted === true,
          code: typeof ack?.code === "string" ? ack.code : "" });
      }
    } catch {
      // 读不到「找货中」只说明这一眼没看成，下一眼再看；没有递出去的编号不算递过。
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimer(tick, openWork(queue) ? INTAKE_BRIDGE_ACTIVE_POLL_MS : INTAKE_BRIDGE_IDLE_POLL_MS);
  }

  return Object.freeze({
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  });
}
