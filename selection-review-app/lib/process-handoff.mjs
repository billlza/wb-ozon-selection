// With Postgres only one service process works on the stored data at a time (server.mjs holds a process lease). A new
// process started while the old one still runs — a zero-downtime deploy does exactly that — no longer fails. It opens its
// port at once and stands by: it answers /api/live, so the platform sees it is up, sends traffic to it and stops the old
// process; any other request waits a short while and is then served by this process once it has the lease, or is told to
// try again in a few seconds. Meanwhile it keeps asking for the lease, and gives up after a while if it never comes.

export const PROCESS_LEASE_HELD = "BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_HELD";
export const STANDBY_REQUEST_WAIT_MS = 20_000;
export const PROCESS_LEASE_RETRY_MS = 1_000;
export const PROCESS_LEASE_MAX_WAIT_MS = 5 * 60_000;

function pathOf(request) {
  try { return new URL(request.url ?? "/", "http://standby.invalid").pathname; } catch { return ""; }
}

function respond(response, status, body, headers = {}) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

/**
 * The one request handler the server is created with. Until `open(handler)` it stands by; from then on every request,
 * including the ones still waiting, goes to `handler`.
 */
export function createStandbyGate({ waitMs = STANDBY_REQUEST_WAIT_MS, clock = () => new Date().toISOString(),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1) throw new Error("STANDBY_GATE_CONFIGURATION_INVALID");
  let handler = null;
  const waiting = new Set();
  function standBy(request, response) {
    if (request.method === "GET" && pathOf(request) === "/api/live") {
      return respond(response, 200, { ok: true, live: true, standby: true, service: "selection-review-app", version: 2, checkedAt: clock() });
    }
    const entry = { request, response, timer: null };
    entry.timer = setTimer(() => {
      waiting.delete(entry);
      respond(response, 503, { code: "service_switching", message: "服务正在换新版本，过几秒刷新再试；刚才这一下没有做任何事" },
        { "Retry-After": "5" });
    }, waitMs);
    entry.timer?.unref?.();
    waiting.add(entry);
    response.once?.("close", () => {
      if (!waiting.delete(entry)) return;
      clearTimer(entry.timer);
    });
  }
  return Object.freeze({
    handle(request, response) {
      return handler ? handler(request, response) : standBy(request, response);
    },
    open(next) {
      if (typeof next !== "function") throw new Error("STANDBY_GATE_HANDLER_REQUIRED");
      if (handler) throw new Error("STANDBY_GATE_ALREADY_OPEN");
      handler = next;
      const held = [...waiting];
      waiting.clear();
      for (const entry of held) {
        clearTimer(entry.timer);
        handler(entry.request, entry.response);
      }
    },
    get opened() { return handler !== null; },
    get waiting() { return waiting.size; }
  });
}

/**
 * Takes the lease. While another process holds it, opens the port once (`listen`) and asks again every `retryMs`; after
 * `maxWaitMs` the lease error is thrown as before. Any other error is thrown at once.
 */
export async function holdLeaseOrStandBy({ hold, listen, retryMs = PROCESS_LEASE_RETRY_MS, maxWaitMs = PROCESS_LEASE_MAX_WAIT_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), nowMs = () => Date.now(), log = () => {} }) {
  if (typeof hold !== "function" || typeof listen !== "function") throw new Error("PROCESS_HANDOFF_DEPENDENCY_INVALID");
  const startedAt = nowMs();
  let standingBy = false;
  for (;;) {
    try {
      const lease = await hold();
      if (standingBy) log("接手了：另一个服务进程已经停下，这个进程开始干活。");
      return { lease, stoodBy: standingBy };
    } catch (error) {
      if (!String(error?.message ?? "").includes(PROCESS_LEASE_HELD)) throw error;
      if (nowMs() - startedAt >= maxWaitMs) throw error;
      if (!standingBy) {
        await listen();
        standingBy = true;
        log("另一个服务进程还在用这份数据：这个进程先开着门等（只回答 /api/live），它停下就接手。");
      }
    }
    await sleep(retryMs);
  }
}

/** Opens the port for standing by; the same server later serves, without opening it again. */
export function listenOnce(server, { port, host }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

