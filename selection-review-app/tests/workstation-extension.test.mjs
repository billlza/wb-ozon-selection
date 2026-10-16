import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateWorkstationKeyMessage, WORKSTATION_KEY_MESSAGE_TYPE } from "../extension/1688-capture/capture-request.js";
import { harness, idle, message, PING, SENDER, startCapture, supplierJob } from "./helpers/extension-runtime-fixture.mjs";

// The key a team's central service made for one computer (central plan step 3). Synthetic values only.
const KEY = `srw_${"k".repeat(43)}`;
const OTHER_KEY = `srw_${"m".repeat(43)}`;
const WORKSTATION_ID = "workstation:00000000-0000-4000-8000-000000000011";
const keyMessage = (extra = {}) => ({ type: WORKSTATION_KEY_MESSAGE_TYPE, workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", key: KEY, ...extra });
const kept = (extra = {}) => ({ serviceOrigin: "http://127.0.0.1:4317", workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", key: KEY, ...extra });
const sendKey = (runtime, input = keyMessage(), sender = SENDER) => new Promise((resolve) => {
  const keepOpen = runtime.handleMessage(input, sender, resolve);
  if (!keepOpen) throw new Error("the key message must be answered asynchronously");
});

test("without a key (the owner's own Mac) plugin calls go out exactly as before", async () => {
  const h = harness({ job: supplierJob() });
  await h.runtime.heartbeat();
  assert.equal((await startCapture(h.runtime, "job-1")).accepted, true);
  await idle(h.runtime);
  assert.deepEqual(h.calls.requests.map((request) => request.url.split("/").at(-1)), ["heartbeat", "claim", "result"]);
  for (const request of h.calls.requests) assert.deepEqual(request.headers, { "Content-Type": "application/json" });
  assert.equal(h.runtime.status().workstation, null);
});

test("a kept key goes with every call to the service, and the status names the computer but never shows the key", async () => {
  const h = harness({ job: supplierJob(), workstation: kept() });
  await h.runtime.heartbeat();
  assert.equal((await startCapture(h.runtime, "job-1")).accepted, true);
  await idle(h.runtime);
  assert.deepEqual(h.calls.requests.map((request) => request.url.split("/").at(-1)), ["heartbeat", "claim", "result"]);
  for (const request of h.calls.requests) assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
  const status = h.runtime.status();
  assert.deepEqual(status.workstation, { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook" });
  assert.equal(JSON.stringify(status).includes(KEY), false);
  assert.equal(JSON.stringify(message(h.runtime, { type: PING }).response).includes(KEY), false);
  // A key kept for another service, or in a shape this plugin does not know, is not sent anywhere.
  for (const workstation of [kept({ serviceOrigin: "https://other.example" }), kept({ key: "srw_short" }), { key: KEY }]) {
    const other = harness({ workstation });
    await other.runtime.heartbeat();
    assert.equal(other.calls.requests[0].headers.Authorization, undefined);
    assert.equal(other.runtime.status().workstation, null);
  }
});

test("the review page hands a key over once; the plugin keeps it, says which computer it is and sends it from then on", async () => {
  const h = harness();
  await h.runtime.heartbeat();
  assert.equal(h.calls.requests[0].headers.Authorization, undefined);
  const answer = await sendKey(h.runtime);
  assert.deepEqual(answer, { accepted: true, workstation: { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook" }, serviceConnected: true });
  assert.deepEqual(h.calls.stored, [{ selectionReviewWorkstation: kept() }]);
  assert.equal(h.calls.requests.at(-1).headers.Authorization, `Bearer ${KEY}`, "a heartbeat with the new key answers at once");
  // A newer key replaces the one kept.
  await sendKey(h.runtime, keyMessage({ key: OTHER_KEY, name: "改了名字" }));
  assert.equal(h.calls.requests.at(-1).headers.Authorization, `Bearer ${OTHER_KEY}`);
  assert.deepEqual(h.runtime.status().workstation, { workstationId: WORKSTATION_ID, name: "改了名字" });
});

test("a key comes only from the review page, in exactly its shape, and a plugin that cannot keep it says so", async () => {
  const h = harness();
  for (const input of [keyMessage({ key: "srw_short" }), keyMessage({ workstationId: "workstation:x" }), keyMessage({ name: "" }),
    keyMessage({ name: "x".repeat(41) }), keyMessage({ extra: true }), { type: WORKSTATION_KEY_MESSAGE_TYPE, key: KEY }]) {
    assert.equal(validateWorkstationKeyMessage(input), false);
    assert.deepEqual(message(h.runtime, input).response, { accepted: false, code: "workstation_key_invalid" });
  }
  assert.deepEqual(message(h.runtime, keyMessage(), { url: "https://evil.example/" }).response, { accepted: false, code: "request_origin_invalid" });
  assert.deepEqual(h.calls.stored, []);
  assert.equal(h.calls.requests.length, 0);
  const failing = harness({ storageFails: true });
  assert.deepEqual(await sendKey(failing.runtime), { accepted: false, code: "workstation_storage_unavailable" });
  assert.equal(failing.runtime.status().workstation, null);
});

test("a service that wants this computer's key (401) is told apart from one that refuses the plugin (403)", async () => {
  const notAdded = harness({ heartbeat: async () => ({ ok: false, status: 401 }), claim: async () => ({ ok: false, status: 401 }) });
  assert.equal((await notAdded.runtime.heartbeat()).code, "workstation_not_added");
  assert.equal(message(notAdded.runtime, { type: PING }).response.code, "workstation_not_added");
  assert.deepEqual(await startCapture(notAdded.runtime, "job-1"), { accepted: false, code: "workstation_not_added" });
  assert.equal(notAdded.calls.created.length, 0);
  const refused = harness({ heartbeat: async () => ({ ok: false, status: 403 }) });
  assert.equal((await refused.runtime.heartbeat()).code, "extension_identity_rejected");
  // A result the service turns away for the key ends with that reason, and the next status says so.
  const removed = harness({ job: supplierJob(), workstation: kept(), reportStatus: 401 });
  await removed.runtime.heartbeat();
  assert.equal((await startCapture(removed.runtime, "job-1")).accepted, true);
  await idle(removed.runtime);
  assert.equal(removed.runtime.status().lastCaptureCode, "workstation_not_added");
  assert.equal(removed.runtime.status().code, "workstation_not_added");
});

test("the page bridge passes the key on without echoing it, and reports which computer the plugin holds a key for", async () => {
  const bridge = await readFile(new URL("../extension/1688-capture/bridge.js", import.meta.url), "utf8");
  const forwarded = bridge.match(/chrome\.runtime\.sendMessage\(\{ type: WORKSTATION_KEY, ([^}]*) \}\)/u);
  assert.ok(forwarded, "the bridge forwards the key message field by field");
  assert.deepEqual(forwarded[1].split(",").map((field) => field.trim().split(":")[0]), ["workstationId", "name", "key"]);
  const acknowledged = bridge.match(/window\.postMessage\(\{ type: WORKSTATION_KEY_ACK,([\s\S]*?)\}, window\.location\.origin\)/u);
  assert.ok(acknowledged);
  assert.doesNotMatch(acknowledged[1], /\bkey\b/u, "the acknowledgement never carries the key back to the page");
  assert.match(bridge, /workstation: workstationView\(response\?\.workstation\)/u);
});
