import assert from "node:assert/strict";
import { createCaptureRuntime } from "../../extension/1688-capture/background.js";

// All browser calls and transport are in-memory fixtures. No real browser or server is imported.
export const NOW = "2026-09-03T00:00:00.000Z";
export const SUPPLIER_URL = "https://detail.1688.com/offer/876240928352.html";
export const OZON_URL = "https://www.ozon.ru/product/123456789/";
export const PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
export const START = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
export const SENDER = { url: "http://127.0.0.1:4317/" };
export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const SETTINGS_SENDER = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/options.html` };
export const supplierJob = (extra = {}) => ({
  captureId: "job-1", candidateId: "candidate-1", token: "synthetic-fixture-token", dataRevision: 2,
  mode: "a_supplier_capture", sourceUrl: SUPPLIER_URL, expectedOfferId: "876240928352",
  requiredExtensionVersion: "1.6.0", attempt: 1, ...extra
});
export const ozonJob = (extra = {}) => ({
  captureId: "ozon-1", candidateId: "candidate-2", token: "synthetic-fixture-token", dataRevision: 4,
  productUrl: OZON_URL, expectedProductId: "123456789", ...extra
});
export function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); }, listeners };
}
export function harness(options = {}) {
  const calls = { requests: [], created: [], removed: [], executions: [], alarmCreates: [], stored: [], permissionRemovals: [], optionsOpened: 0 };
  // The plugin's own storage: the service it works for (unless it is this computer's workbench) and that service's key.
  const stored = { ...(options.workstation ? { selectionReviewWorkstation: options.workstation } : {}),
    ...(options.service ? { selectionReviewService: options.service } : {}) };
  // Addresses the person let the plugin onto, and the page bridge registered for a team's service.
  const granted = new Set(options.granted || []);
  const bridges = new Map();
  let tab = null;
  let alarm = options.alarm || null;
  const chromeApi = {
    runtime: { id: EXTENSION_ID, getManifest: () => ({ version: "1.6.0" }), getURL: (file) => `chrome-extension://${EXTENSION_ID}/${file}`,
      openOptionsPage: async () => { calls.optionsOpened += 1; }, onMessage: event(), onInstalled: event(), onStartup: event() },
    action: { onClicked: event() },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => granted.has(origin)),
      remove: async ({ origins }) => { calls.permissionRemovals.push(...origins); for (const origin of origins) granted.delete(origin); return true; }
    },
    alarms: { onAlarm: event(), get: async () => alarm, create: async (name, config) => { calls.alarmCreates.push({ name, config }); alarm = { name, ...config }; } },
    storage: { local: {
      get: async (keys) => {
        if (options.storageReadFails) throw new Error("synthetic storage read failure");
        return Object.fromEntries([keys].flat().filter((key) => Object.hasOwn(stored, key)).map((key) => [key, structuredClone(stored[key])]));
      },
      set: async (values) => {
        if (options.storageFails) throw new Error("synthetic storage failure");
        calls.stored.push(structuredClone(values));
        Object.assign(stored, structuredClone(values));
      }
    } },
    tabs: {
      onUpdated: event(),
      create: async (input) => {
        calls.created.push(input);
        tab = { id: 7, url: options.destination || input.url, status: "complete" };
        return tab;
      },
      get: async () => tab,
      remove: async (id) => { calls.removed.push(id); if (options.removeFails) throw new Error("private query secret"); }
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((id) => bridges.has(id)).map((id) => structuredClone(bridges.get(id))),
      registerContentScripts: async (scripts) => {
        if (options.bridgeFails) throw new Error("synthetic registration failure");
        for (const script of scripts) { if (bridges.has(script.id)) throw new Error("duplicate script id"); bridges.set(script.id, structuredClone(script)); }
      },
      unregisterContentScripts: async ({ ids }) => { for (const id of ids) bridges.delete(id); },
      executeScript: async (input) => {
        calls.executions.push(input);
        if (options.execute) return options.execute({ tab, input });
        const isOzon = input.args[0] === "123456789";
        return [{ result: { status: "captured", evidence: isOzon
          ? { productId: "123456789", productUrl: OZON_URL }
          : { offerId: "876240928352", sourceUrl: SUPPLIER_URL } } }];
      }
    }
  };
  calls.granted = granted;
  calls.bridges = bridges;
  calls.storedNow = stored;
  const fetchImpl = async (url, input) => {
    calls.requests.push({ url, body: JSON.parse(input.body), headers: input.headers });
    if (url.endsWith("/heartbeat")) {
      if (options.heartbeat) return options.heartbeat();
      return { ok: true, json: async () => ({ accepted: true, captureJob: options.job || null }) };
    }
    if (url.endsWith("/claim")) {
      if (options.claim) return options.claim();
      return { ok: true, json: async () => ({ accepted: true, captureJob: options.job || null }) };
    }
    if (url.endsWith("/search-image")) {
      if (options.searchImage) return options.searchImage();
      return { ok: true, json: async () => ({ contentType: "image/jpeg", byteLength: 3, base64: "AAEC" }) };
    }
    if (options.reportFails) throw new Error("https://secret.example/?token=fixture-secret");
    if (options.reportStatus) return { ok: false, status: options.reportStatus };
    return { ok: true };
  };
  const runtime = createCaptureRuntime({ chromeApi, fetchImpl, clock: options.clock || (() => NOW), waitOptions: options.waitOptions, jobTimerOptions: options.jobTimerOptions });
  return { runtime, chromeApi, calls };
}
export async function idle(runtime) {
  for (let i = 0; i < 30 && runtime.status().captureActive; i += 1) await new Promise(setImmediate);
  assert.equal(runtime.status().captureActive, false, "fixture capture must terminate");
}
export function message(runtime, input, sender = SENDER) {
  let response;
  const keepOpen = runtime.handleMessage(input, sender, (value) => { response = value; });
  return { response, keepOpen };
}
export function startCapture(runtime, captureId, type = START) {
  return new Promise((resolve) => runtime.handleMessage({ type, captureId }, SENDER, resolve));
}
