import { collect1688Page } from "./collector.js";
import { collectOzonPage } from "./collector-ozon.js";
import { collectPinduoduoPage } from "./collector-pinduoduo.js";
import { collect1688ImageSearchPage } from "./collector-1688-image-search.js";
import { collectOzonSearchPage } from "./collector-ozon-search.js";
import {
  classify1688ImageSearchNavigation,
  classify1688NavigationOutcome,
  classifyOzonSearchNavigation,
  classifyPinduoduoNavigation,
  classifySupplierSource,
  imageSearchResultPage,
  observed1688TabAddress,
  ozonSearchResultPage,
  shouldWaitFor1688Destination,
  validateResolved1688Source,
  validateResolvedPinduoduoSource
} from "./source-routing.js";
import {
  canonicalOzonCaptureSource,
  IMAGE_MATCH_REQUEST_TYPE,
  isImageMatchJob,
  isReviewSender,
  isOzonCaptureJob,
  isOzonImageMatchJob,
  OZON_IMAGE_MATCH_REQUEST_TYPE,
  validateCaptureStartSignal,
  validateImageMatchRequest,
  validateOzonImageMatchRequest,
  validateOzonCaptureRequest,
  validateSupplierCaptureRequest
} from "./capture-request.js";

export const HEARTBEAT_ALARM = "selection-review-extension-heartbeat";
const API_ORIGIN = "http://127.0.0.1:4317"; // Explicit local-development adapter, not central identity.
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const START_TYPES = new Set(["SELECTION_REVIEW_1688_CAPTURE_REQUEST", "SELECTION_REVIEW_OZON_CAPTURE_REQUEST", IMAGE_MATCH_REQUEST_TYPE,
  OZON_IMAGE_MATCH_REQUEST_TYPE]);
const FAILURE_CODES = new Set([
  "wrong_offer", "wrong_product", "structured_data_unavailable", "site_login_required",
  "site_verification_required", "short_link_resolution_failed", "timeout", "sku_limit_exceeded",
  "precise_price_missing", "exact_price_unavailable", "invalid_capture", "system_error",
  "results_unverifiable", "results_empty", "wrong_query", "navigation_rejected"
]);
const safeFailureCode = (code) => FAILURE_CODES.has(code) ? code : "system_error";
const failure = (code) => Object.assign(new Error(code), { code });

// A 1688 image search passes through its s.1688.com entry address to the air.1688.com result page and is read there only.
function inspectImageSearchTab(tab) {
  const address = observed1688TabAddress(tab).value;
  if (!address) return null;
  const outcome = classify1688ImageSearchNavigation(address);
  if (outcome === "results") return tab.pendingUrl ? null : { sourceUrl: imageSearchResultPage(address) };
  if (outcome === "entry") return null;
  if (outcome === "login_required") throw failure("site_login_required");
  if (outcome === "verification_required") throw failure("site_verification_required");
  throw failure("navigation_rejected");
}

// An Ozon search is read on the search page, or on the category page Ozon may move it to, while the words stay the same.
function inspectOzonSearchTab(tab, payload) {
  const address = observed1688TabAddress(tab).value;
  if (!address) return null;
  const outcome = classifyOzonSearchNavigation(address, payload.query);
  if (outcome === "results") return tab.pendingUrl ? null : { sourceUrl: ozonSearchResultPage(address, payload.query) };
  if (outcome === "verification_required") throw failure("site_verification_required");
  if (outcome === "other_search") throw failure("wrong_query");
  throw failure("navigation_rejected");
}

function inspectCaptureTab(tab, payload) {
  if (isImageMatchJob(payload)) return inspectImageSearchTab(tab);
  if (isOzonImageMatchJob(payload)) return inspectOzonSearchTab(tab, payload);
  if (isOzonCaptureJob(payload)) {
    const address = observed1688TabAddress(tab).value;
    if (!address) return null;
    const sourceUrl = canonicalOzonCaptureSource(address, payload.expectedProductId);
    if (!sourceUrl) throw failure("wrong_product");
    // Same relaxation as the supplier branch below, for the same measured reason: the Ozon product document has
    // committed, and the collector waits in the page for the components it needs rather than for the load event that a
    // throttled background tab may never report (owner, 2026-09-14, timed out at 25s).
    return tab.pendingUrl ? null : { sourceUrl, productId: payload.expectedProductId };
  }
  const address = observed1688TabAddress(tab).value;
  if (!address) return null;
  if (classifySupplierSource(payload.sourceUrl)?.platform === "pinduoduo") return inspectPinduoduoTab(tab, address, payload);
  const resolved = validateResolved1688Source(payload.sourceUrl, address, payload.expectedOfferId);
  // The offer document has committed — tab.url is this offer and nothing else is pending — so the collector can start.
  // Waiting for the whole page to reach complete is what actually stopped the first real captures: a 1688 detail page
  // loads in a background tab that Chrome throttles, and its load event did not arrive inside 15s or 25s. The collector
  // polls the page for its own data and carries its own deadline, so an early start costs nothing, and the identity of
  // what was read is re-checked against the browser's own address after extraction (2026-09-12).
  if (resolved && !tab.pendingUrl) return resolved;
  const diagnostics = classify1688NavigationOutcome(address, {
    expectedOfferId: payload.expectedOfferId,
    navigationStage: tab.status === "complete" ? "page_complete" : "redirect_observed"
  });
  if (diagnostics.redirectClassification === "different_offer") throw failure("wrong_offer");
  if (shouldWaitFor1688Destination(diagnostics, tab.status)) return null;
  if (diagnostics.redirectClassification === "login_required") throw failure("site_login_required");
  if (diagnostics.redirectClassification === "verification_required") throw failure("site_verification_required");
  throw failure("short_link_resolution_failed");
}

// A Pinduoduo share link is followed only to its goods page; a stop anywhere else ends the job with its reason.
function inspectPinduoduoTab(tab, address, payload) {
  const resolved = validateResolvedPinduoduoSource(payload.sourceUrl, address, payload.expectedOfferId);
  if (resolved && !tab.pendingUrl) return resolved;
  const outcome = classifyPinduoduoNavigation(address, payload.expectedOfferId);
  if (outcome === "different_offer") throw failure("wrong_offer");
  if (outcome === "login_required") throw failure("site_login_required");
  if (outcome === "verification_required") throw failure("site_verification_required");
  if (outcome === "allowed_detail" || (outcome === "intermediate_page" && tab.status !== "complete")) return null;
  throw failure("short_link_resolution_failed");
}

// Listen before reading the tab: a completion event between those steps must not be lost.
export function waitForCaptureTab(chromeApi, tabId, payload, { timeoutMs = 25000, setTimer = setTimeout, clearTimer = clearTimeout, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      chromeApi.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const inspect = (tab) => {
      if (settled) return;
      try {
        const result = inspectCaptureTab(tab, payload);
        if (result) finish(null, result);
      } catch (error) {
        finish(error);
      }
    };
    const listener = (updatedId, _changeInfo, tab) => { if (updatedId === tabId) inspect(tab); };
    const abort = () => finish(failure("timeout"));
    if (signal?.aborted) { reject(failure("timeout")); return; }
    chromeApi.tabs.onUpdated.addListener(listener);
    signal?.addEventListener("abort", abort, { once: true });
    // The 15s navigation budget leaves time inside the server's 60s execution lease.
    timer = setTimer(() => finish(failure("timeout")), timeoutMs);
    chromeApi.tabs.get(tabId).then(inspect, () => finish(failure("system_error")));
  });
}

function validatedCollectedResult(collected, resolved, payload) {
  if (!collected || typeof collected !== "object") throw failure("structured_data_unavailable");
  if (collected.status !== "captured") throw failure(safeFailureCode(collected.failureCode));
  const evidence = collected.evidence;
  if (isImageMatchJob(payload)) {
    // The page must have searched the one picture this job was created for; the service checks the same again.
    if (evidence?.searchImageUrl !== payload.imageUrl) throw failure("wrong_query");
    return { status: "captured", evidence };
  }
  if (isOzonImageMatchJob(payload)) {
    // The page must have searched the very words this job was created for; the service checks the same again.
    if (evidence?.query !== payload.query) throw failure("wrong_query");
    return { status: "captured", evidence };
  }
  if (isOzonCaptureJob(payload)) {
    if (evidence?.productId !== payload.expectedProductId ||
        canonicalOzonCaptureSource(evidence?.productUrl, payload.expectedProductId) !== resolved.sourceUrl) {
      throw failure("wrong_product");
    }
    return { status: "captured", evidence: { ...evidence, productUrl: resolved.sourceUrl } };
  }
  const source = classifySupplierSource(evidence?.sourceUrl);
  if (evidence?.offerId !== resolved.offerId || source?.type !== "detail" || source.sourceUrl !== resolved.sourceUrl ||
      source.platform !== classifySupplierSource(payload.sourceUrl)?.platform) {
    throw failure("wrong_offer");
  }
  return { status: "captured", resolvedSourceUrl: resolved.sourceUrl, evidence: { ...evidence, sourceUrl: resolved.sourceUrl } };
}

/**
 * Browser APIs and transport are injectable only to exercise the worker with offline fixtures.
 * ISOLATED protects JS built-ins from page overrides; the shared DOM is still untrusted evidence.
 * Server authentication, durable lease/revision validation and no-replay remain mandatory.
 */
export function createCaptureRuntime({ chromeApi, fetchImpl, clock = () => new Date().toISOString(), waitOptions,
  // Chrome's global timer functions refuse to run with anything but the global as their receiver: held as plain
  // properties and then called as jobTimerOptions.setTimer(…), they throw TypeError: Illegal invocation. That threw
  // where the capture deadline was created and again in the finally that cleared it, so the deadline never existed,
  // the opened 1688 tab was never closed, no result was ever sent, and the worker stayed "capturing" for good — four
  // captures the owner watched time out on 2026-09-11/12. The wrappers keep the calls on the global.
  jobTimerOptions = { setTimer: (handler, delay) => setTimeout(handler, delay), clearTimer: timer => clearTimeout(timer) } } = {}) {
  let heartbeatPending = null;
  let alarmPending = null;
  let activeCapture = null;
  const seenCaptureIds = new Set();
  let cleanupBlocked = "";
  let lastHeartbeat = { ok: false, code: "heartbeat_not_observed", observedAt: null };
  let lastCaptureCode = "";
  const version = chromeApi.runtime.getManifest().version;
  const status = () => {
    // Transport health TTL matches the existing local heartbeat contract, not product evidence age.
    const fresh = lastHeartbeat.ok && Date.parse(clock()) - Date.parse(lastHeartbeat.observedAt) <= 75000;
    return {
      accepted: fresh && !cleanupBlocked,
      backgroundReady: !cleanupBlocked,
      serviceConnected: fresh,
      code: cleanupBlocked || (lastHeartbeat.ok && !fresh ? "heartbeat_stale" : lastHeartbeat.code),
      observedAt: lastHeartbeat.observedAt,
      captureActive: Boolean(activeCapture),
      lastCaptureCode,
      version
    };
  };

  async function sendResult(payload, result) {
    const route = isImageMatchJob(payload) ? "image-match" : isOzonImageMatchJob(payload) ? "ozon-match"
      : isOzonCaptureJob(payload) ? "sales-capture" : "source-capture";
    const response = await fetchImpl(`${API_ORIGIN}/api/candidates/${encodeURIComponent(payload.candidateId)}/${route}/result`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captureId: payload.captureId, token: payload.token, dataRevision: payload.dataRevision, ...result })
    });
    if (!response.ok) throw failure([401, 403].includes(response.status) ? "extension_identity_rejected" : "result_rejected");
  }

  async function executeCapture(payload) {
    let tabId = null;
    let result;
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const assertNotCancelled = () => { if (signal.aborted) throw failure("timeout"); };
    const closeOwnedTab = async (id) => {
      let closeTimer;
      try {
        await Promise.race([
          chromeApi.tabs.remove(id),
          new Promise((_resolve, reject) => {
            closeTimer = jobTimerOptions.setTimer(() => reject(failure("tab_cleanup_failed")), 3000);
          })
        ]);
      } catch { cleanupBlocked = "tab_cleanup_failed"; lastCaptureCode = "tab_cleanup_failed"; }
      finally { jobTimerOptions.clearTimer(closeTimer); }
    };
    // 40s includes tab creation, navigation, extraction and final browser identity readback. A 1688 detail page is
    // heavy and Chrome throttles the background tab it loads in, so the first real capture (2026-09-12) ran out of the
    // earlier 30s budget with the page still loading. With a 3s tab close and one 10s result POST this still finishes
    // inside the server's 60s execution lease.
    let deadlineTimer;
    const deadline = new Promise((_resolve, reject) => {
      deadlineTimer = jobTimerOptions.setTimer(() => {
        cancellation.abort();
        reject(failure("timeout"));
      }, 40000);
    });
    const capture = async () => {
      const imageMatch = isImageMatchJob(payload);
      const ozonMatch = isOzonImageMatchJob(payload);
      const url = imageMatch ? validateImageMatchRequest({ payload, manifestVersion: version }).searchUrl
        : ozonMatch ? validateOzonImageMatchRequest({ payload, manifestVersion: version }).searchUrl
        : isOzonCaptureJob(payload) ? canonicalOzonCaptureSource(payload.productUrl, payload.expectedProductId)
        : classifySupplierSource(payload.sourceUrl).sourceUrl;
      if (!url) throw failure("system_error");
      const tab = await chromeApi.tabs.create({ url, active: false });
      if (!Number.isInteger(tab.id)) throw failure("system_error");
      if (signal.aborted) {
        // Creation may resolve after the deadline. Its only allowed effect is closing this tab.
        await closeOwnedTab(tab.id);
        throw failure("timeout");
      }
      tabId = tab.id;
      const resolved = await waitForCaptureTab(chromeApi, tabId, payload, { ...waitOptions, signal });
      assertNotCancelled();
      const isOzon = isOzonCaptureJob(payload);
      const pinduoduo = !imageMatch && !ozonMatch && !isOzon && classifySupplierSource(payload.sourceUrl)?.platform === "pinduoduo";
      const execution = await chromeApi.scripting.executeScript({
        target: { tabId }, world: "ISOLATED",
        func: imageMatch ? collect1688ImageSearchPage : ozonMatch ? collectOzonSearchPage : isOzon ? collectOzonPage
          : pinduoduo ? collectPinduoduoPage : collect1688Page,
        args: imageMatch ? [payload.imageUrl, payload.maxResults] : ozonMatch ? [payload.query, payload.maxResults]
          : [isOzon ? payload.expectedProductId : resolved.offerId]
      });
      assertNotCancelled();
      // Re-read the browser identity after extraction, not the page's self-reported location.
      const current = inspectCaptureTab(await chromeApi.tabs.get(tabId), payload);
      assertNotCancelled();
      if (!current || current.sourceUrl !== resolved.sourceUrl) {
        throw failure(imageMatch || ozonMatch ? "navigation_rejected" : isOzon ? "wrong_product" : "wrong_offer");
      }
      return validatedCollectedResult(execution?.[0]?.result, resolved, payload);
    };
    try {
      result = await Promise.race([capture(), deadline]);
    } catch (error) {
      result = { status: "failed", failureCode: safeFailureCode(error?.code), observedAt: clock() };
      if (signal.aborted && tabId === null) cleanupBlocked = "tab_creation_unconfirmed";
    } finally {
      jobTimerOptions.clearTimer(deadlineTimer);
      if (tabId !== null) await closeOwnedTab(tabId);
    }
    try {
      // A transport failure has unknown delivery outcome: never send a second/fallback result.
      await sendResult(payload, result);
      lastCaptureCode = result.status === "failed" ? result.failureCode : "capture_reported";
    } catch (error) {
      lastCaptureCode = ["extension_identity_rejected", "result_rejected"].includes(error?.code) ? error.code : "result_delivery_unconfirmed";
      if (error?.code === "extension_identity_rejected") lastHeartbeat = { ok: false, code: "extension_identity_rejected", observedAt: clock() };
    } finally {
      activeCapture = null;
    }
  }

  function heartbeat() {
    if (heartbeatPending) return heartbeatPending;
    heartbeatPending = (async () => {
      try {
        const response = await fetchImpl(`${API_ORIGIN}/api/extension/heartbeat`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ version, backgroundReady: !cleanupBlocked, observedAt: clock() })
        });
        if (!response.ok) throw failure([401, 403].includes(response.status) ? "extension_identity_rejected" : "heartbeat_unavailable");
        const body = await response.json();
        if (body?.accepted !== true) throw failure("heartbeat_rejected");
        lastHeartbeat = { ok: true, code: "", observedAt: clock() };
        // Even an older service returning a job cannot start work from a heartbeat.
        return status();
      } catch (error) {
        lastHeartbeat = { ok: false, code: error?.code === "extension_identity_rejected" ? "extension_identity_rejected" : "heartbeat_unavailable", observedAt: clock() };
        return status();
      } finally { heartbeatPending = null; }
    })();
    return heartbeatPending;
  }

  async function claimCapture(message) {
    if (seenCaptureIds.has(message.captureId)) return { accepted: false, code: "capture_replay_rejected" };
    if (seenCaptureIds.size >= 256) return { accepted: false, code: "capture_session_limit_reached" };
    seenCaptureIds.add(message.captureId);
    activeCapture = message.captureId;
    try {
      const response = await fetchImpl(`${API_ORIGIN}/api/extension/capture-jobs/${encodeURIComponent(message.captureId)}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ version })
      });
      if (!response.ok) throw failure([401, 403].includes(response.status) ? "extension_identity_rejected" : "capture_job_not_claimed");
      const body = await response.json();
      const payload = body?.captureJob;
      const validation = isImageMatchJob(payload) ? validateImageMatchRequest({ payload, manifestVersion: version })
        : isOzonImageMatchJob(payload) ? validateOzonImageMatchRequest({ payload, manifestVersion: version })
        : isOzonCaptureJob(payload) ? validateOzonCaptureRequest({ payload, manifestVersion: version })
        : validateSupplierCaptureRequest({ payload, manifestVersion: version });
      const expectedOzon = message.type === "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";
      const expectedImageMatch = message.type === IMAGE_MATCH_REQUEST_TYPE;
      const expectedOzonMatch = message.type === OZON_IMAGE_MATCH_REQUEST_TYPE;
      // Each start signal may only start its own kind of job: a page asking for a supplier capture never gets a search.
      if (body?.accepted !== true || !validation.ok || payload.captureId !== message.captureId ||
          isOzonCaptureJob(payload) !== expectedOzon || isImageMatchJob(payload) !== expectedImageMatch ||
          isOzonImageMatchJob(payload) !== expectedOzonMatch) throw failure("capture_job_invalid");
      void executeCapture(payload);
      return { accepted: true, claimedCaptureId: message.captureId };
    } catch (error) {
      activeCapture = null;
      lastCaptureCode = ["extension_identity_rejected", "capture_job_not_claimed", "capture_job_invalid"].includes(error?.code)
        ? error.code : "capture_claim_unconfirmed";
      return { accepted: false, code: lastCaptureCode };
    }
  }

  function ensureHeartbeatAlarm() {
    if (alarmPending) return alarmPending;
    alarmPending = (async () => {
      try {
        const existing = await chromeApi.alarms.get(HEARTBEAT_ALARM);
        if (!existing) await chromeApi.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
      } finally { alarmPending = null; }
    })();
    return alarmPending;
  }

  function handleMessage(message, sender, sendResponse) {
    if (message?.type !== BACKGROUND_PING && !START_TYPES.has(message?.type)) return false;
    if (!isReviewSender(sender?.url)) {
      sendResponse({ accepted: false, code: "request_origin_invalid" });
      return false;
    }
    if (message.type === BACKGROUND_PING) {
      sendResponse(status()); // No network, no lease claim, no capture from a health inquiry.
      return false;
    }
    if (!validateCaptureStartSignal(message).ok) {
      sendResponse({ accepted: false, code: "start_signal_invalid" });
      return false;
    }
    if (activeCapture || cleanupBlocked) {
      sendResponse({ accepted: false, code: "capture_busy" });
      return false;
    }
    void claimCapture(message).then(sendResponse);
    return true;
  }

  function install() {
    const start = () => {
      void ensureHeartbeatAlarm().then(heartbeat, () => {
        lastHeartbeat = { ok: false, code: "alarm_unavailable", observedAt: clock() };
      });
    };
    chromeApi.runtime.onMessage.addListener(handleMessage);
    chromeApi.alarms.onAlarm.addListener((alarm) => { if (alarm.name === HEARTBEAT_ALARM) void heartbeat(); });
    chromeApi.runtime.onInstalled.addListener(start);
    chromeApi.runtime.onStartup.addListener(start);
    // A cold worker can be woken by a status PING. Module loading must never claim work.
    void ensureHeartbeatAlarm().catch(() => {
      lastHeartbeat = { ok: false, code: "alarm_unavailable", observedAt: clock() };
    });
  }
  return { status, heartbeat, handleMessage, ensureHeartbeatAlarm, install };
}

if (globalThis.chrome?.runtime?.id) {
  createCaptureRuntime({ chromeApi: globalThis.chrome, fetchImpl: globalThis.fetch.bind(globalThis) }).install();
}
