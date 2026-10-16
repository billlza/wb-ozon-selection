import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createStandbyGate, holdLeaseOrStandBy, PROCESS_LEASE_HELD, STANDBY_REQUEST_WAIT_MS } from "../lib/process-handoff.mjs";

// No network: requests and responses are small fakes, timers are fired by hand.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (callback, ms) => { const id = next++; pending.set(id, { callback, ms }); return id; },
    clearTimer: id => { pending.delete(id); },
    fireAll: () => { for (const [id, timer] of [...pending]) { pending.delete(id); timer.callback(); } },
    pending
  };
}

function exchange(method, url) {
  const response = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body === undefined ? null : JSON.parse(body); this.writableEnded = true; } });
  return { request: { method, url }, response };
}

test("standing by, only /api/live answers; other requests wait and are served once the process works", () => {
  const timers = fakeTimers();
  const gate = createStandbyGate({ clock: () => "2026-10-16T20:00:00.000Z", ...timers });
  const live = exchange("GET", "/api/live?x=1");
  gate.handle(live.request, live.response);
  assert.equal(live.response.status, 200);
  assert.deepEqual(live.response.body, { ok: true, live: true, standby: true, service: "selection-review-app", version: 2,
    checkedAt: "2026-10-16T20:00:00.000Z" });
  assert.equal(live.response.headers["Cache-Control"], "no-store");

  const state = exchange("GET", "/api/state");
  const write = exchange("POST", "/api/live");
  const page = exchange("GET", "/");
  for (const held of [state, write, page]) gate.handle(held.request, held.response);
  assert.equal(gate.waiting, 3);
  assert.equal([...timers.pending.values()][0].ms, STANDBY_REQUEST_WAIT_MS);
  assert.equal(state.response.status, null, "nothing is answered while standing by");

  const served = [];
  gate.open((request, response) => { served.push(`${request.method} ${request.url}`); response.writeHead(200, {}); response.end("{}"); });
  assert.deepEqual(served, ["GET /api/state", "POST /api/live", "GET /"]);
  assert.equal(gate.waiting, 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(gate.opened, true);
  // From now on every request goes straight to the service, /api/live included.
  const after = exchange("GET", "/api/live");
  gate.handle(after.request, after.response);
  assert.deepEqual(served.at(-1), "GET /api/live");
  assert.throws(() => gate.open(() => {}), /STANDBY_GATE_ALREADY_OPEN/);
});

test("a request that waited too long is told to try again; one whose caller left is dropped", () => {
  const timers = fakeTimers();
  const gate = createStandbyGate({ waitMs: 50, ...timers });
  const late = exchange("GET", "/api/state");
  const gone = exchange("GET", "/api/intake/queue");
  gate.handle(late.request, late.response);
  gate.handle(gone.request, gone.response);
  gone.response.emit("close");
  assert.equal(gate.waiting, 1);
  timers.fireAll();
  assert.equal(late.response.status, 503);
  assert.equal(late.response.headers["Retry-After"], "5");
  assert.deepEqual(late.response.body, { code: "service_switching", message: "服务正在换新版本，过几秒刷新再试；刚才这一下没有做任何事" });
  const served = [];
  gate.open(request => served.push(request.url));
  assert.deepEqual(served, [], "neither the answered request nor the abandoned one is served again");
  assert.throws(() => createStandbyGate({ waitMs: 0 }), /STANDBY_GATE_CONFIGURATION_INVALID/);
});

test("the lease is taken at once when free; while another process has it the port opens once and the lease is asked again", async () => {
  const held = Object.assign(new Error(PROCESS_LEASE_HELD), {});
  const log = [];
  let listens = 0;
  // Free at once: no standing by, the port is opened later by the server itself.
  const first = await holdLeaseOrStandBy({ hold: async () => "lease", listen: async () => { listens += 1; }, sleep: async () => {},
    log: message => log.push(message) });
  assert.deepEqual([first, listens, log], [{ lease: "lease", stoodBy: false }, 0, []]);

  let attempts = 0;
  let at = 0;
  const slept = [];
  const taken = await holdLeaseOrStandBy({
    hold: async () => { attempts += 1; if (attempts < 4) throw held; return "lease"; },
    listen: async () => { listens += 1; }, sleep: async ms => { slept.push(ms); at += ms; }, nowMs: () => at,
    log: message => log.push(message) });
  assert.deepEqual(taken, { lease: "lease", stoodBy: true });
  assert.deepEqual([attempts, listens, slept], [4, 1, [1000, 1000, 1000]]);
  assert.match(log[0], /另一个服务进程还在用这份数据.*只回答 \/api\/live/u);
  assert.match(log[1], /接手了/u);
});

test("standing by ends after the longest wait with the lease error, and any other error stops at once", async () => {
  let at = 0;
  const held = new Error(`${PROCESS_LEASE_HELD}`);
  await assert.rejects(holdLeaseOrStandBy({ hold: async () => { throw held; }, listen: async () => {}, maxWaitMs: 3000,
    sleep: async ms => { at += ms; }, nowMs: () => at }), error => error === held);
  assert.equal(at, 3000);
  const broken = new Error("POSTGRES_UNREACHABLE");
  let listened = false;
  await assert.rejects(holdLeaseOrStandBy({ hold: async () => { throw broken; }, listen: async () => { listened = true; } }),
    error => error === broken);
  assert.equal(listened, false, "a database that cannot be reached is not a reason to stand by");
  const portTaken = new Error("EADDRINUSE");
  await assert.rejects(holdLeaseOrStandBy({ hold: async () => { throw held; }, listen: async () => { throw portTaken; },
    sleep: async () => {} }), error => error === portTaken);
  await assert.rejects(holdLeaseOrStandBy({ hold: null, listen: async () => {} }), /PROCESS_HANDOFF_DEPENDENCY_INVALID/);
});
