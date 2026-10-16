import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SERVICE_BRIDGE_SCRIPT_ID } from "../extension/1688-capture/background.js";
import { isReviewSender, LOCAL_SERVICE_ORIGIN, normalizeServiceAddress, SERVICE_ADDRESS_MESSAGE_TYPE, SERVICE_STATUS_MESSAGE_TYPE,
  WORKSTATION_KEY_MESSAGE_TYPE } from "../extension/1688-capture/capture-request.js";
import { connectMessage, connectService, describeService, readServiceStatus } from "../extension/1688-capture/options.js";
import { EXTENSION_ID, harness, idle, message, PING, SENDER, SETTINGS_SENDER, START, supplierJob } from "./helpers/extension-runtime-fixture.mjs";

// Central plan step 3b: the plugin can be told the address of the team's central service. Synthetic addresses and keys only.
const TEAM = "https://ozon.example.com";
const OTHER_TEAM = "https://ozon-two.example.com";
const TEAM_SENDER = { url: `${TEAM}/` };
const KEY = `srw_${"k".repeat(43)}`;
const WORKSTATION_ID = "workstation:00000000-0000-4000-8000-000000000011";
const ask = (runtime, input, sender = SETTINGS_SENDER) => new Promise((resolve) => {
  const keepOpen = runtime.handleMessage(input, sender, resolve);
  if (!keepOpen) throw new Error("expected an asynchronous answer");
});
const moveTo = (runtime, serviceOrigin) => ask(runtime, { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin });
const lastUrl = (h) => h.calls.requests.at(-1).url;

test("the plugin takes this computer's workbench or a team's https address, and nothing else", () => {
  for (const [typed, origin] of [[LOCAL_SERVICE_ORIGIN, LOCAL_SERVICE_ORIGIN], [`${LOCAL_SERVICE_ORIGIN}/`, LOCAL_SERVICE_ORIGIN],
    [" ozon.example.com ", TEAM], [`${TEAM}/`, TEAM], ["HTTPS://Ozon.Example.com", TEAM], ["https://ozon.example.com:8443", "https://ozon.example.com:8443"]]) {
    assert.equal(normalizeServiceAddress(typed), origin, typed);
  }
  for (const typed of ["", "http://ozon.example.com", `${TEAM}/app`, `${TEAM}?x=1`, `${TEAM}#x`, "https://a:b@ozon.example.com", "https://1.2.3.4",
    "https://[::1]", "http://localhost:4317", "ftp://ozon.example.com", "javascript:alert(1)", "ozon example.com", `https://${"a".repeat(200)}.com`, null, 7]) {
    assert.equal(normalizeServiceAddress(typed), null, String(typed));
  }
  assert.equal(isReviewSender(`${LOCAL_SERVICE_ORIGIN}/maint`), true);
  assert.equal(isReviewSender(`${TEAM}/maint`), false);
  assert.equal(isReviewSender(`${TEAM}/maint`, TEAM), true);
  assert.equal(isReviewSender(`${LOCAL_SERVICE_ORIGIN}/`, TEAM), false);
});

test("only the plugin's own settings page asks which service it works for or moves it", async () => {
  const h = harness();
  assert.deepEqual(await ask(h.runtime, { type: SERVICE_STATUS_MESSAGE_TYPE }), { status: { ...h.runtime.status(), serviceOrigin: LOCAL_SERVICE_ORIGIN } });
  for (const sender of [SENDER, TEAM_SENDER, { id: EXTENSION_ID, url: `${LOCAL_SERVICE_ORIGIN}/` }, { id: "x".repeat(32), url: SETTINGS_SENDER.url },
    { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/other.html` }, { id: EXTENSION_ID }]) {
    assert.deepEqual(message(h.runtime, { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: TEAM }, sender).response,
      { saved: false, code: "request_origin_invalid" }, JSON.stringify(sender));
  }
  for (const input of [{ type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: `${TEAM}/` }, { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: "http://ozon.example.com" },
    { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: TEAM, extra: true }, { type: SERVICE_ADDRESS_MESSAGE_TYPE }]) {
    assert.deepEqual(message(h.runtime, input, SETTINGS_SENDER).response, { saved: false, code: "service_address_invalid" }, JSON.stringify(input));
  }
  assert.deepEqual(h.calls.stored, []);
  assert.equal(h.calls.requests.length, 0);
});

test("moving to a team's service needs the person's permission for that address; then the bridge, the calls and the pages follow it", async () => {
  const h = harness({ job: supplierJob() });
  assert.deepEqual(await moveTo(h.runtime, TEAM), { saved: false, code: "service_access_missing" });
  assert.deepEqual(h.calls.stored, []);
  assert.equal(h.calls.bridges.size, 0);

  h.calls.granted.add(`${TEAM}/*`);
  const moved = await moveTo(h.runtime, TEAM);
  assert.equal(moved.saved, true);
  assert.equal(moved.bridgeReady, true);
  assert.equal(moved.status.serviceOrigin, TEAM);
  assert.equal(moved.status.serviceConnected, true, "one heartbeat to the new service answers at once");
  assert.deepEqual(h.calls.stored, [{ selectionReviewService: { origin: TEAM } }]);
  assert.deepEqual([...h.calls.bridges.values()], [{ id: SERVICE_BRIDGE_SCRIPT_ID, matches: [`${TEAM}/*`], js: ["bridge.js"], runAt: "document_start",
    persistAcrossSessions: true }]);
  assert.equal(lastUrl(h), `${TEAM}/api/extension/heartbeat`);
  // The team's page is now the one the plugin listens to; this computer's workbench page is told it works elsewhere.
  assert.equal(message(h.runtime, { type: PING }, TEAM_SENDER).response.serviceOrigin, TEAM);
  assert.deepEqual(message(h.runtime, { type: PING }, SENDER).response, { accepted: false, code: "request_origin_invalid" });
  assert.deepEqual(message(h.runtime, { type: START, captureId: "job-1" }, SENDER).response, { accepted: false, code: "request_origin_invalid" });
  assert.equal(await new Promise((resolve) => h.runtime.handleMessage({ type: START, captureId: "job-1" }, TEAM_SENDER, (answer) => resolve(answer.accepted))), true);
  await idle(h.runtime);
  assert.deepEqual(h.calls.requests.slice(-2).map((request) => request.url),
    [`${TEAM}/api/extension/capture-jobs/job-1/claim`, `${TEAM}/api/candidates/candidate-1/source-capture/result`]);

  // Another team address: the first one's permission goes back; back home: the bridge goes too.
  h.calls.granted.add(`${OTHER_TEAM}/*`);
  assert.equal((await moveTo(h.runtime, OTHER_TEAM)).saved, true);
  assert.deepEqual(h.calls.permissionRemovals, [`${TEAM}/*`]);
  assert.deepEqual([...h.calls.bridges.values()].map((bridge) => bridge.matches), [[`${OTHER_TEAM}/*`]]);
  const home = await moveTo(h.runtime, LOCAL_SERVICE_ORIGIN);
  assert.equal(home.status.serviceOrigin, LOCAL_SERVICE_ORIGIN);
  assert.equal(h.calls.bridges.size, 0);
  assert.deepEqual(h.calls.permissionRemovals, [`${TEAM}/*`, `${OTHER_TEAM}/*`]);
  assert.equal(lastUrl(h), `${LOCAL_SERVICE_ORIGIN}/api/extension/heartbeat`);
  assert.equal(message(h.runtime, { type: PING }, SENDER).response.serviceOrigin, LOCAL_SERVICE_ORIGIN);
});

test("a key goes only to the service that made it, and is kept for when the plugin comes back to that service", async () => {
  const h = harness({ granted: [`${TEAM}/*`] });
  await moveTo(h.runtime, TEAM);
  const handed = await new Promise((resolve) => h.runtime.handleMessage({ type: WORKSTATION_KEY_MESSAGE_TYPE, workstationId: WORKSTATION_ID,
    name: "老板甲的 MacBook", key: KEY }, TEAM_SENDER, resolve));
  assert.equal(handed.accepted, true);
  assert.deepEqual(h.calls.stored.at(-1), { selectionReviewWorkstation: { serviceOrigin: TEAM, workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", key: KEY } });
  assert.equal(h.calls.requests.at(-1).headers.Authorization, `Bearer ${KEY}`);
  await moveTo(h.runtime, LOCAL_SERVICE_ORIGIN);
  assert.equal(h.calls.requests.at(-1).headers.Authorization, undefined, "this computer's workbench never sees the team's key");
  assert.equal(h.runtime.status().workstation, null);
  h.calls.granted.add(`${TEAM}/*`);
  await moveTo(h.runtime, TEAM);
  assert.equal(h.calls.requests.at(-1).headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(h.runtime.status().workstation, { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook" });
});

test("no move while a job runs, and a failed save or bridge says so", async () => {
  const pending = harness({ granted: [`${TEAM}/*`], claim: () => new Promise(() => {}) });
  await pending.runtime.ready();
  assert.equal(message(pending.runtime, { type: START, captureId: "job-1" }).keepOpen, true);
  assert.deepEqual(await moveTo(pending.runtime, TEAM), { saved: false, code: "capture_busy" });
  assert.deepEqual(pending.calls.stored, []);

  const unsaved = harness({ granted: [`${TEAM}/*`], storageFails: true });
  assert.deepEqual(await moveTo(unsaved.runtime, TEAM), { saved: false, code: "settings_storage_unavailable" });
  assert.equal(unsaved.runtime.status().serviceOrigin, LOCAL_SERVICE_ORIGIN);

  const unbridged = harness({ granted: [`${TEAM}/*`], bridgeFails: true });
  const moved = await moveTo(unbridged.runtime, TEAM);
  assert.deepEqual([moved.saved, moved.bridgeReady, moved.status.serviceOrigin], [true, false, TEAM]);
  assert.match(connectMessage(moved), /没能挂到这个网址的页面上/u);
});

test("a worker Chrome has just woken reads which service it works for before it answers a page", async () => {
  const h = harness({ service: { origin: TEAM }, granted: [`${TEAM}/*`], job: supplierJob() });
  const answer = new Promise((resolve) => assert.equal(h.runtime.handleMessage({ type: START, captureId: "job-1" }, TEAM_SENDER, resolve), true));
  assert.equal((await answer).accepted, true);
  await idle(h.runtime);
  assert.equal(h.calls.requests[0].url, `${TEAM}/api/extension/capture-jobs/job-1/claim`);
  const cold = harness({ service: { origin: TEAM } });
  assert.deepEqual(await new Promise((resolve) => cold.runtime.handleMessage({ type: PING }, SENDER, resolve)), { accepted: false, code: "request_origin_invalid" });
  // Storage that cannot be read, or holds no usable address, leaves the plugin on this computer's workbench.
  for (const options of [{ service: { origin: TEAM }, storageReadFails: true }, { service: { origin: "http://ozon.example.com" } }, { service: "x" }]) {
    const fallback = harness(options);
    await fallback.runtime.heartbeat();
    assert.equal(fallback.calls.requests[0].url, `${LOCAL_SERVICE_ORIGIN}/api/extension/heartbeat`, JSON.stringify(options));
  }
});

test("starting the worker puts the bridge back on the team's pages, and the plugin icon opens the settings page", async () => {
  const h = harness({ service: { origin: TEAM }, granted: [`${TEAM}/*`] });
  h.runtime.install();
  await h.runtime.ready();
  for (let i = 0; i < 10 && h.calls.bridges.size === 0; i += 1) await new Promise(setImmediate);
  assert.deepEqual([...h.calls.bridges.values()].map((bridge) => bridge.matches), [[`${TEAM}/*`]]);
  h.chromeApi.action.onClicked.emit();
  await new Promise(setImmediate);
  assert.equal(h.calls.optionsOpened, 1);
  // The workbench on this computer needs no registered bridge: the manifest puts it there.
  const local = harness();
  local.runtime.install();
  await local.runtime.ready();
  await new Promise(setImmediate);
  assert.equal(local.calls.bridges.size, 0);
});

test("the settings page asks Chrome for exactly that address before it tells the background, and says what came of it", async () => {
  const calls = [];
  const chromeApi = (granted = true, answer = { saved: true, bridgeReady: true, status: { serviceOrigin: TEAM } }) => ({
    permissions: { request: async (input) => { calls.push(["request", input]); return granted; } },
    runtime: { sendMessage: async (input) => { calls.push(["send", input]); return answer; } }
  });
  const result = await connectService(chromeApi(), " ozon.example.com/ ");
  assert.deepEqual(calls, [["request", { origins: [`${TEAM}/*`] }], ["send", { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: TEAM }]]);
  assert.match(connectMessage(result), /改好了：插件以后替 https:\/\/ozon\.example\.com 干活.*「维护」→「干活的电脑」/u);
  calls.length = 0;
  assert.deepEqual(await connectService(chromeApi(false), TEAM), { saved: false, code: "service_access_declined" });
  assert.deepEqual(calls, [["request", { origins: [`${TEAM}/*`] }]], "a refused permission sends nothing on");
  calls.length = 0;
  assert.deepEqual(await connectService(chromeApi(), "http://ozon.example.com"), { saved: false, code: "service_address_invalid" });
  assert.deepEqual(calls, []);
  await connectService(chromeApi(true, { saved: true, status: { serviceOrigin: LOCAL_SERVICE_ORIGIN } }), LOCAL_SERVICE_ORIGIN);
  assert.deepEqual(calls, [["send", { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: LOCAL_SERVICE_ORIGIN }]], "home needs no permission");
  const silent = { runtime: { sendMessage: async () => { throw new Error("no background"); } } };
  assert.deepEqual(await readServiceStatus(silent), { saved: false, code: "background_unavailable" });
  for (const code of ["service_address_invalid", "service_access_declined", "service_access_missing", "capture_busy", "settings_storage_unavailable",
    "background_unavailable", "something_new"]) {
    assert.match(connectMessage({ saved: false, code }), /。$/u, code);
  }
  assert.match(connectMessage({ saved: true, status: { serviceOrigin: LOCAL_SERVICE_ORIGIN } }), /回到这台电脑上的工作台/u);
  assert.deepEqual(describeService({ serviceOrigin: TEAM, serviceConnected: true, workstation: { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook" } }),
    { address: `现在连的是团队服务：${TEAM}`, connection: "已经连上。", computer: "这台电脑在团队里叫「老板甲的 MacBook」。" });
  assert.match(describeService({ serviceOrigin: TEAM, serviceConnected: false, code: "workstation_not_added", workstation: null }).computer, /还没加进来/u);
  assert.equal(describeService({ serviceOrigin: LOCAL_SERVICE_ORIGIN, serviceConnected: false }).computer, "");
  assert.match(describeService(undefined).address, /重新加载插件/u);
});

test("the settings page and the bridge are wired to the service the plugin was set up for", async () => {
  const page = await readFile(new URL("../extension/1688-capture/options.html", import.meta.url), "utf8");
  assert.match(page, /<script type="module" src="options\.js"><\/script>/u);
  assert.doesNotMatch(page, /<script>(?!<)/u, "no inline script: Chrome refuses it on extension pages");
  for (const id of ["address", "connection", "computer", "central", "service-address", "connect", "local", "message"]) assert.match(page, new RegExp(`id="${id}"`, "u"), id);
  const bridge = await readFile(new URL("../extension/1688-capture/bridge.js", import.meta.url), "utf8");
  assert.match(bridge, /event\.origin !== window\.location\.origin/u);
  assert.match(bridge, /otherService: response\?\.code === "request_origin_invalid"/u);
});
