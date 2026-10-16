import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

import { api, PAGE_WORKSTATION_HEADER, setPageWorkstation } from "../src/api.js";
import { CAPTURE_START_REJECTION_MESSAGES } from "../src/captureStart.js";
import { EXPECTED_EXTENSION_VERSION, extensionConnectionStatus } from "../src/extensionStatus.js";
import { handWorkstationKeyToPlugin, WORKSTATION_KEY_ACK, WORKSTATION_KEY_MESSAGE, WORKSTATION_KEY_TIMEOUT_MS,
  workstationKeyMessage } from "../src/workstationKey.js";

// Synthetic computers only. The page is a small fake window: messages are delivered by hand.
const WORKSTATION_ID = "workstation:00000000-0000-4000-8000-000000000011";
const KEY = `srw_${"k".repeat(43)}`;

function fakePage() {
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 1;
  const page = {
    location: { origin: "http://127.0.0.1:4317" }, posted: [],
    addEventListener: (type, listener) => { if (type === "message") listeners.add(listener); },
    removeEventListener: (type, listener) => { if (type === "message") listeners.delete(listener); },
    setTimeout: (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    postMessage: (data, origin) => { page.posted.push({ data, origin }); },
    deliver: (data, { source = page, origin = page.location.origin } = {}) => { for (const listener of [...listeners]) listener({ source, origin, data }); },
    expire: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
    listeners, timers
  };
  return page;
}

test("the page hands the key to the plugin next to it and waits only for that computer's answer", async () => {
  const page = fakePage();
  const answer = handWorkstationKeyToPlugin({ workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", key: KEY }, page);
  assert.deepEqual(page.posted, [{ data: { type: WORKSTATION_KEY_MESSAGE, workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", key: KEY },
    origin: "http://127.0.0.1:4317" }]);
  // Other windows, other origins and other computers' answers are not this one.
  page.deliver({ type: WORKSTATION_KEY_ACK, workstationId: WORKSTATION_ID, accepted: true }, { source: {} });
  page.deliver({ type: WORKSTATION_KEY_ACK, workstationId: WORKSTATION_ID, accepted: true }, { origin: "https://evil.example" });
  page.deliver({ type: WORKSTATION_KEY_ACK, workstationId: "workstation:00000000-0000-4000-8000-000000000012", accepted: true });
  page.deliver({ type: WORKSTATION_KEY_ACK, workstationId: WORKSTATION_ID, accepted: true, serviceConnected: true, code: "" });
  assert.deepEqual(await answer, { accepted: true, serviceConnected: true, code: "" });
  assert.equal(page.listeners.size, 0);
  assert.equal(page.timers.size, 0);
  // Nobody answers: the tab has no plugin.
  const silent = fakePage();
  const unanswered = handWorkstationKeyToPlugin({ workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", key: KEY }, silent);
  assert.equal([...silent.timers.values()][0].ms, WORKSTATION_KEY_TIMEOUT_MS);
  silent.expire();
  assert.deepEqual(await unanswered, { accepted: false, serviceConnected: false, code: "no_bridge" });
});

test("each outcome of handing the key over gets one plain sentence, and a not-added computer gets its own status line", () => {
  assert.match(workstationKeyMessage({ accepted: true, serviceConnected: true }, "老板甲的 MacBook"), /「老板甲的 MacBook」加进来了，插件已经连上/u);
  assert.match(workstationKeyMessage({ accepted: true, serviceConnected: false }, "一号"), /还没和服务连上/u);
  assert.match(workstationKeyMessage({ accepted: false, code: "no_bridge" }, "一号", { withdrawn: true }), /没有找到插件.*已经撤掉/u);
  assert.match(workstationKeyMessage({ accepted: false, code: "workstation_storage_unavailable" }, "一号", { withdrawn: true }), /重新加载插件/u);
  assert.match(workstationKeyMessage({ accepted: false, code: "something_new" }, "一号", { withdrawn: false }), /没能撤掉.*移除/u);
  assert.deepEqual(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false, workstationNotAdded: true }),
    { code: "workstation_not_added", label: "这台电脑还没加进来 · 到「维护」里的「干活的电脑」加一下才能领作业" });
  // A plugin of the wrong version still hears first that it must be reloaded.
  assert.equal(extensionConnectionStatus({ liveVersion: "1.4.2", backgroundReady: false, workstationNotAdded: true }).code, "reload_required");
  assert.match(CAPTURE_START_REJECTION_MESSAGES.workstation_not_added, /把这台电脑加进来.*不会自动重试/u);
});

test("the page asks the service for the computers with the fields it expects and nothing more", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ?? null });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await api.listWorkstations();
    await api.addWorkstation({ name: "老板甲的 MacBook" });
    await api.removeWorkstation({ workstationId: WORKSTATION_ID });
  } finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(calls, [
    { url: "/api/workstations", method: "GET", body: null },
    { url: "/api/workstations/add", method: "POST", body: JSON.stringify({ name: "老板甲的 MacBook" }) },
    { url: "/api/workstations/remove", method: "POST", body: JSON.stringify({ workstationId: WORKSTATION_ID }) }
  ]);
});

test("once its plugin says which computer it is on, the page names that computer on every request, and only a well-formed one", async () => {
  const sent = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push(init.headers?.[PAGE_WORKSTATION_HEADER] ?? null);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await api.listWorkstations();
    setPageWorkstation(WORKSTATION_ID);
    await api.listWorkstations();
    await api.addWorkstation({ name: "老板甲的 MacBook" });
    for (const value of ["workstation:not-an-id", 7, null, undefined]) {
      setPageWorkstation(value);
      await api.listWorkstations();
    }
  } finally { globalThis.fetch = previousFetch; setPageWorkstation(""); }
  assert.equal(PAGE_WORKSTATION_HEADER.toLowerCase(), "x-selection-review-workstation");
  assert.deepEqual(sent, [null, WORKSTATION_ID, WORKSTATION_ID, null, null, null, null]);
});

test("the computers panel shows this computer, who is online, and adds or removes one", async () => {
  const entry = fileURLToPath(new URL("./workstation-render.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/WorkstationPanel.jsx", import.meta.url));
  const result = await build({ configFile: false, logLevel: "warn", plugins: [react(), { name: "workstation-render",
    resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{WorkstationView}from ${JSON.stringify(component)};
      const noop=()=>{};
      export const render=(props)=>renderToStaticMarkup(<WorkstationView name='' saving={false} message={null} confirmingId='' onNameChange={noop}
        onAdd={noop} onConfirmRemove={noop} onCancelRemove={noop} onRemove={noop} {...props}/>);` : null }], ssr: { noExternal: true },
    build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const chunk = result.output.find(item => item.type === "chunk" && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  const online = { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook", addedAt: "2026-10-16T18:00:00.000Z", online: true,
    lastSeenAt: "2026-10-16T18:00:00.000Z", extensionVersion: "1.6.0" };
  const offline = { workstationId: "workstation:00000000-0000-4000-8000-000000000012", name: "测试丙的电脑", addedAt: "2026-10-16T18:00:00.000Z",
    online: false, lastSeenAt: null, extensionVersion: null };
  const loaded = workstations => ({ status: "loaded", workstations, error: "" });

  const noPlugin = render({ thisComputer: { answered: false, workstation: null }, list: loaded([online]) });
  assert.match(noPlugin, /干活的电脑/u); assert.match(noPlugin, /没有找到插件/u); assert.doesNotMatch(noPlugin, /把这台电脑加进来/u);
  // The plugin here works for another address: it would not take this service's key, so the page says where to change it.
  const elsewhere = render({ thisComputer: { answered: true, otherService: true, workstation: null }, list: loaded([online]) });
  assert.match(elsewhere, /插件连的是别的服务地址.*插件图标，改成这个网址/u); assert.doesNotMatch(elsewhere, /把这台电脑加进来/u);
  const notYet = render({ thisComputer: { answered: true, workstation: null }, list: loaded([online, offline]) });
  assert.match(notYet, /把这台电脑加进来/u); assert.match(notYet, /maxLength="40"/u);
  assert.match(notYet, /老板甲的 MacBook.*在线 · 插件 v1\.6\.0/u); assert.match(notYet, /测试丙的电脑.*不在线/u);
  assert.equal((notYet.match(/>移除</gu) || []).length, 2);
  const here = render({ thisComputer: { answered: true, workstation: { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook" } }, list: loaded([online, offline]) });
  assert.match(here, /这台电脑是「老板甲的 MacBook」，已经加进来了/u); assert.match(here, /老板甲的 MacBook（这台）/u);
  assert.doesNotMatch(here, /把这台电脑加进来/u);
  // A key this plugin still holds for a computer someone removed: the computer can be added again.
  const removed = render({ thisComputer: { answered: true, workstation: { workstationId: WORKSTATION_ID, name: "老板甲的 MacBook" } }, list: loaded([offline]) });
  assert.match(removed, /把这台电脑加进来/u);
  const confirming = render({ thisComputer: { answered: true, workstation: null }, list: loaded([offline]), confirmingId: offline.workstationId });
  assert.match(confirming, /钥匙马上作废/u); assert.match(confirming, /确定移除/u); assert.match(confirming, /不移除/u);
  assert.match(render({ thisComputer: { answered: true, workstation: null }, list: loaded([]) }), /还没有加进来的电脑/u);
  assert.match(render({ thisComputer: { answered: true, workstation: null }, list: { status: "failed", workstations: null, error: "读不到电脑名单" } }),
    /role="alert">读不到电脑名单/u);
});
