import { collect1688Page } from "./collector.js";
import { collectOzonPage } from "./collector-ozon.js";
import { collectPinduoduoPage } from "./collector-pinduoduo.js";
import { collect1688ImageSearchPage } from "./collector-1688-image-search.js";
import { collectOzonSearchPage } from "./collector-ozon-search.js";
import { uploadOzonSearchImage } from "./uploader-ozon-image-search.js";
import {
  classify1688ImageSearchNavigation,
  classify1688NavigationOutcome,
  classifyOzonImageSearchNavigation,
  classifyOzonSearchNavigation,
  classifyPinduoduoNavigation,
  classifySupplierSource,
  imageSearchResultPage,
  observed1688TabAddress,
  ozonImageSearchResultPage,
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
  isOzonImageSearchJob,
  LOCAL_SERVICE_ORIGIN,
  normalizeServiceAddress,
  OZON_IMAGE_MATCH_REQUEST_TYPE,
  SERVICE_ADDRESS_MESSAGE_TYPE,
  SERVICE_STATUS_MESSAGE_TYPE,
  servicePagePattern,
  validateCaptureStartSignal,
  validateImageMatchRequest,
  validateOzonImageMatchRequest,
  validateOzonCaptureRequest,
  validateSupplierCaptureRequest,
  validateWorkstationKeyMessage,
  WORKSTATION_KEY_MESSAGE_TYPE
} from "./capture-request.js";
import { SEERFAR_WEB_REQUEST_TYPE, isSeerfarWebJob, runSeerfarWebCapture, validateSeerfarWebRequest } from "./seerfar-web-capture.js";

export const HEARTBEAT_ALARM = "selection-review-extension-heartbeat";
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const WORKSTATION_STORAGE_KEY = "selectionReviewWorkstation";
const SERVICE_STORAGE_KEY = "selectionReviewService";
export const SERVICE_BRIDGE_SCRIPT_ID = "selection-review-service-bridge";
export const SETTINGS_PAGE = "options.html";
const START_TYPES = new Set(["SELECTION_REVIEW_1688_CAPTURE_REQUEST", "SELECTION_REVIEW_OZON_CAPTURE_REQUEST", IMAGE_MATCH_REQUEST_TYPE,
  OZON_IMAGE_MATCH_REQUEST_TYPE, SEERFAR_WEB_REQUEST_TYPE]);
const FAILURE_CODES = new Set([
  "wrong_offer", "wrong_product", "structured_data_unavailable", "site_login_required",
  "site_verification_required", "short_link_resolution_failed", "timeout", "sku_limit_exceeded",
  "precise_price_missing", "exact_price_unavailable", "invalid_capture", "system_error",
  "results_unverifiable", "results_empty", "wrong_query", "navigation_rejected", "image_upload_unavailable", "search_image_unavailable",
  "no_matching_search"
]);
const safeFailureCode = (code) => FAILURE_CODES.has(code) ? code : "system_error";
const failure = (code) => Object.assign(new Error(code), { code });
// 401: the team's service wants this computer's key (none, wrong or removed); 403: it does not accept this plugin at all.
const refusal = (status, otherwise) => failure(status === 401 ? "workstation_not_added" : status === 403 ? "extension_identity_rejected" : otherwise);
const SERVICE_REFUSALS = ["workstation_not_added", "extension_identity_rejected"];
// A key is kept together with the service that made it, and goes only to that service.
const validWorkstation = (value) => value !== null && typeof value === "object" &&
  normalizeServiceAddress(value.serviceOrigin) === value.serviceOrigin &&
  validateWorkstationKeyMessage({ type: WORKSTATION_KEY_MESSAGE_TYPE, workstationId: value.workstationId, name: value.name, key: value.key });

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

// An Ozon image search starts on the home page ("entry": wait there until the document has committed, then upload) and is
// read only on the search-by-image page Ozon moves the tab to; the home page is still "waiting" while the upload runs.
function inspectOzonImageSearchTab(tab, stage) {
  const address = observed1688TabAddress(tab).value;
  if (!address) return null;
  const outcome = classifyOzonImageSearchNavigation(address);
  if (outcome === "verification_required") throw failure("site_verification_required");
  if (outcome === "entry") return stage === "entry" ? (tab.pendingUrl ? null : { entryUrl: address }) : null;
  if (outcome === "results" && stage === "results") {
    if (tab.pendingUrl) return null;
    const sourceUrl = ozonImageSearchResultPage(address);
    return { sourceUrl, imageId: new URL(sourceUrl).searchParams.get("image_id") };
  }
  throw failure("navigation_rejected");
}

function inspectCaptureTab(tab, payload) {
  if (isImageMatchJob(payload)) return inspectImageSearchTab(tab);
  if (isOzonImageSearchJob(payload)) return inspectOzonImageSearchTab(tab, "results");
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
export function waitForCaptureTab(chromeApi, tabId, payload, { timeoutMs = 25000, setTimer = setTimeout, clearTimer = clearTimeout, signal,
  inspectTab = (tab) => inspectCaptureTab(tab, payload) } = {}) {
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
        const result = inspectTab(tab);
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
  if (isOzonImageSearchJob(payload)) {
    // The page read must be the one this upload landed on; the service checks the shape again.
    if (evidence?.searchBy !== "image" || evidence?.imageId !== resolved.imageId || evidence?.query !== undefined) throw failure("wrong_query");
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
  // A tab this worker opened and cannot yet account for: one Chrome would not close ("tab_cleanup_failed", with its id),
  // or one Chrome was still creating when its job ran out of time ("tab_creation_unconfirmed"). While it is set no new
  // job starts — one Chrome profile, one controlling job at a time — and it clears itself the moment the tab is gone.
  let strayTab = null;
  let lastHeartbeat = { ok: false, code: "heartbeat_not_observed", observedAt: null };
  let lastCaptureCode = "";
  // Which service this plugin works for: the workbench on this computer, unless a team's central service was filled in on
  // the plugin's settings page. And this computer's key from a team's service, sent with every call to that service only.
  // Both are kept in the plugin's own storage; without them (the owner's own Mac) calls go out as before.
  let serviceOrigin = LOCAL_SERVICE_ORIGIN;
  let workstation = null;
  let settingsLoad = null;
  let settingsLoaded = false;
  // While the settings page moves the plugin to another service, no job starts: its result would go to the wrong one.
  let switchingService = false;
  const version = chromeApi.runtime.getManifest().version;
  function loadSettings() {
    // A storage that cannot be read leaves the plugin on this computer's workbench; the next start of the worker reads again.
    settingsLoad ??= Promise.resolve().then(() => chromeApi.storage.local.get([SERVICE_STORAGE_KEY, WORKSTATION_STORAGE_KEY])).then((stored) => {
      serviceOrigin = normalizeServiceAddress(stored?.[SERVICE_STORAGE_KEY]?.origin) ?? LOCAL_SERVICE_ORIGIN;
      const value = stored?.[WORKSTATION_STORAGE_KEY];
      workstation = validWorkstation(value) ? value : null;
    }, () => { serviceOrigin = LOCAL_SERVICE_ORIGIN; workstation = null; }).finally(() => { settingsLoaded = true; });
    return settingsLoad;
  }
  const serviceKey = () => workstation?.serviceOrigin === serviceOrigin ? workstation : null;
  // Every call to the service goes to the address this plugin works for, with this computer's key when that service gave one.
  async function postToService(path, body, timeoutMs = 10000) {
    await loadSettings();
    const key = serviceKey();
    return fetchImpl(`${serviceOrigin}${path}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key.key}` } : {}) }, body: JSON.stringify(body) });
  }
  const status = () => {
    // Transport health TTL matches the existing local heartbeat contract, not product evidence age.
    const fresh = lastHeartbeat.ok && Date.parse(clock()) - Date.parse(lastHeartbeat.observedAt) <= 75000;
    return {
      accepted: fresh && !strayTab,
      backgroundReady: !strayTab,
      serviceConnected: fresh,
      code: strayTab?.code || (lastHeartbeat.ok && !fresh ? "heartbeat_stale" : lastHeartbeat.code),
      observedAt: lastHeartbeat.observedAt,
      captureActive: Boolean(activeCapture),
      lastCaptureCode,
      workstation: serviceKey() ? { workstationId: workstation.workstationId, name: workstation.name } : null,
      serviceOrigin,
      version
    };
  };

  // Chrome rejects tabs.get for a tab that no longer exists, and answers it for a tab that is still open. No answer
  // within 3s proves nothing, so that counts as still open.
  async function tabGone(id) {
    let timer;
    const gone = await Promise.race([
      Promise.resolve().then(() => chromeApi.tabs.get(id)).then(() => false, () => true),
      new Promise((resolve) => { timer = jobTimerOptions.setTimer(() => resolve(false), 3000); })
    ]);
    jobTimerOptions.clearTimer(timer);
    return gone;
  }

  // Every tab a job opened is closed when the job ends. One that is already gone counts as closed: the owner closes the
  // Seerfar tab after searching in it, or a capture tab by hand, and Chrome then refuses to remove it. Treating that
  // refusal as a stuck tab turned every later job away as "busy" until the plugin was reloaded (review P0-9, 2026-10-12).
  async function closeOwnedTab(id) {
    let timer;
    const closed = await Promise.race([
      Promise.resolve().then(() => chromeApi.tabs.remove(id)).then(() => true, () => false),
      new Promise((resolve) => { timer = jobTimerOptions.setTimer(() => resolve(false), 3000); })
    ]);
    jobTimerOptions.clearTimer(timer);
    if (closed || await tabGone(id)) return;
    strayTab = { code: "tab_cleanup_failed", tabId: id };
    lastCaptureCode = "tab_cleanup_failed";
  }

  // Looks again at the one tab that could not be closed. Only Chrome's own tab list is read: no page, no network.
  async function settleStrayTab() {
    const stray = strayTab;
    if (!Number.isInteger(stray?.tabId)) return;
    if (await tabGone(stray.tabId) && strayTab === stray) strayTab = null;
  }

  async function sendResult(payload, result) {
    if (isSeerfarWebJob(payload)) {
      const response = await postToService(`/api/seerfar-selection/rounds/${encodeURIComponent(payload.roundId)}/result`,
        { captureId: payload.captureId, token: payload.token, ...result });
      if (!response.ok) throw refusal(response.status, "result_rejected");
      return;
    }
    const route = isImageMatchJob(payload) ? "image-match" : isOzonImageMatchJob(payload) ? "ozon-match"
      : isOzonCaptureJob(payload) ? "sales-capture" : "source-capture";
    const response = await postToService(`/api/candidates/${encodeURIComponent(payload.candidateId)}/${route}/result`,
      { captureId: payload.captureId, token: payload.token, dataRevision: payload.dataRevision, ...result });
    if (!response.ok) throw refusal(response.status, "result_rejected");
  }

  // The one picture an Ozon image search uploads, handed out by the review app for this claimed job only.
  async function fetchSearchImage(payload) {
    let response;
    try {
      response = await postToService(`/api/extension/capture-jobs/${encodeURIComponent(payload.captureId)}/search-image`,
        { token: payload.token, dataRevision: payload.dataRevision }, 15000);
    } catch { throw failure("search_image_unavailable"); }
    if (!response?.ok) throw failure("search_image_unavailable");
    const body = await response.json().catch(() => null);
    if (body?.contentType !== "image/jpeg" || typeof body.base64 !== "string" || !body.base64 || body.base64.length > 6 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64)) throw failure("search_image_unavailable");
    return { contentType: body.contentType, base64: body.base64 };
  }

  /**
   * Seerfar 榜单：主人要在打开的页面里自己搜一次，所以等得比别的作业久（作业里写明，最多 3 分钟），每 2 秒看一次。
   * 标签页是插件开的，结束时照样关掉；回传只发一次。
   */
  async function executeSeerfarWebCapture(payload) {
    let tabId = null;
    let result;
    const cancellation = new AbortController();
    let deadlineTimer;
    const deadline = new Promise((_resolve, reject) => {
      deadlineTimer = jobTimerOptions.setTimer(() => { cancellation.abort(); reject(failure("timeout")); }, payload.waitMs + 20000);
    });
    try {
      result = await Promise.race([runSeerfarWebCapture({ chromeApi, payload, signal: cancellation.signal, clock,
        onTab: (id) => { tabId = id; } }), deadline]);
    } catch (error) {
      result = { status: "failed", failureCode: safeFailureCode(error?.code), observedAt: clock() };
    } finally {
      jobTimerOptions.clearTimer(deadlineTimer);
      cancellation.abort();
      if (tabId !== null) await closeOwnedTab(tabId);
    }
    try {
      await sendResult(payload, result);
      lastCaptureCode = result.status === "failed" ? result.failureCode : "capture_reported";
    } catch (error) {
      lastCaptureCode = [...SERVICE_REFUSALS, "result_rejected"].includes(error?.code) ? error.code : "result_delivery_unconfirmed";
    } finally {
      activeCapture = null;
    }
  }

  async function executeCapture(payload) {
    if (isSeerfarWebJob(payload)) return executeSeerfarWebCapture(payload);
    let tabId = null;
    let result;
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const assertNotCancelled = () => { if (signal.aborted) throw failure("timeout"); };
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
      const ozonImage = isOzonImageSearchJob(payload);
      // The picture is fetched before any tab opens: without it there is nothing to search with.
      const picture = ozonImage ? await fetchSearchImage(payload) : null;
      assertNotCancelled();
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
      if (ozonImage) {
        // Home page first; the upload is the only thing done there. The tab then has to arrive at the result page itself.
        await waitForCaptureTab(chromeApi, tabId, payload, { ...waitOptions, signal, inspectTab: (current) => inspectOzonImageSearchTab(current, "entry") });
        assertNotCancelled();
        const upload = await chromeApi.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: uploadOzonSearchImage,
          args: [picture.base64, picture.contentType] });
        assertNotCancelled();
        const uploaded = upload?.[0]?.result;
        if (uploaded?.status !== "uploaded") throw failure(safeFailureCode(uploaded?.failureCode ?? "image_upload_unavailable"));
      }
      const resolved = await waitForCaptureTab(chromeApi, tabId, payload, { ...waitOptions, signal });
      assertNotCancelled();
      const isOzon = isOzonCaptureJob(payload);
      const pinduoduo = !imageMatch && !ozonMatch && !isOzon && classifySupplierSource(payload.sourceUrl)?.platform === "pinduoduo";
      const execution = await chromeApi.scripting.executeScript({
        target: { tabId }, world: "ISOLATED",
        func: imageMatch ? collect1688ImageSearchPage : ozonMatch ? collectOzonSearchPage : isOzon ? collectOzonPage
          : pinduoduo ? collectPinduoduoPage : collect1688Page,
        args: imageMatch ? [payload.imageUrl, payload.maxResults]
          : ozonImage ? [{ imageId: resolved.imageId }, payload.maxResults] : ozonMatch ? [payload.query, payload.maxResults]
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
    const running = capture();
    try {
      result = await Promise.race([running, deadline]);
    } catch (error) {
      result = { status: "failed", failureCode: safeFailureCode(error?.code), observedAt: clock() };
      if (signal.aborted && tabId === null) {
        // Out of time before Chrome said whether the tab was made. capture() still closes a tab that turns up late, so
        // no new job starts until that call has finished; a late tab that will not close then holds it by its own id.
        const hold = { code: "tab_creation_unconfirmed", tabId: null };
        strayTab = hold;
        const release = () => { if (strayTab === hold) strayTab = null; };
        running.then(release, release);
      }
    } finally {
      jobTimerOptions.clearTimer(deadlineTimer);
      if (tabId !== null) await closeOwnedTab(tabId);
    }
    try {
      // A transport failure has unknown delivery outcome: never send a second/fallback result.
      await sendResult(payload, result);
      lastCaptureCode = result.status === "failed" ? result.failureCode : "capture_reported";
    } catch (error) {
      lastCaptureCode = [...SERVICE_REFUSALS, "result_rejected"].includes(error?.code) ? error.code : "result_delivery_unconfirmed";
      if (SERVICE_REFUSALS.includes(error?.code)) lastHeartbeat = { ok: false, code: error.code, observedAt: clock() };
    } finally {
      activeCapture = null;
    }
  }

  function heartbeat() {
    if (heartbeatPending) return heartbeatPending;
    heartbeatPending = (async () => {
      try {
        await settleStrayTab();
        const response = await postToService("/api/extension/heartbeat", { version, backgroundReady: !strayTab, observedAt: clock() });
        if (!response.ok) throw refusal(response.status, "heartbeat_unavailable");
        const body = await response.json();
        if (body?.accepted !== true) throw failure("heartbeat_rejected");
        lastHeartbeat = { ok: true, code: "", observedAt: clock() };
        // Even an older service returning a job cannot start work from a heartbeat.
        return status();
      } catch (error) {
        lastHeartbeat = { ok: false, code: SERVICE_REFUSALS.includes(error?.code) ? error.code : "heartbeat_unavailable", observedAt: clock() };
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
      const response = await postToService(`/api/extension/capture-jobs/${encodeURIComponent(message.captureId)}/claim`, { version });
      if (!response.ok) throw refusal(response.status, "capture_job_not_claimed");
      const body = await response.json();
      const payload = body?.captureJob;
      const validation = isSeerfarWebJob(payload) ? validateSeerfarWebRequest({ payload, manifestVersion: version })
        : isImageMatchJob(payload) ? validateImageMatchRequest({ payload, manifestVersion: version })
        : isOzonImageMatchJob(payload) ? validateOzonImageMatchRequest({ payload, manifestVersion: version })
        : isOzonCaptureJob(payload) ? validateOzonCaptureRequest({ payload, manifestVersion: version })
        : validateSupplierCaptureRequest({ payload, manifestVersion: version });
      const expectedOzon = message.type === "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";
      const expectedImageMatch = message.type === IMAGE_MATCH_REQUEST_TYPE;
      const expectedOzonMatch = message.type === OZON_IMAGE_MATCH_REQUEST_TYPE;
      const expectedSeerfar = message.type === SEERFAR_WEB_REQUEST_TYPE;
      // Each start signal may only start its own kind of job: a page asking for a supplier capture never gets a search.
      if (body?.accepted !== true || !validation.ok || payload.captureId !== message.captureId ||
          isOzonCaptureJob(payload) !== expectedOzon || isImageMatchJob(payload) !== expectedImageMatch ||
          isOzonImageMatchJob(payload) !== expectedOzonMatch || isSeerfarWebJob(payload) !== expectedSeerfar) throw failure("capture_job_invalid");
      void executeCapture(payload);
      return { accepted: true, claimedCaptureId: message.captureId };
    } catch (error) {
      activeCapture = null;
      lastCaptureCode = [...SERVICE_REFUSALS, "capture_job_not_claimed", "capture_job_invalid"].includes(error?.code)
        ? error.code : "capture_claim_unconfirmed";
      return { accepted: false, code: lastCaptureCode };
    }
  }

  // The review page on this computer hands over the key the team's service made for it. A newer key replaces the one kept.
  async function keepWorkstation(message, senderUrl) {
    const record = { serviceOrigin: new URL(senderUrl).origin, workstationId: message.workstationId, name: message.name, key: message.key };
    if (!validWorkstation(record)) return { accepted: false, code: "workstation_key_invalid" };
    try {
      await loadSettings();
      await chromeApi.storage.local.set({ [WORKSTATION_STORAGE_KEY]: record });
    } catch {
      return { accepted: false, code: "workstation_storage_unavailable" };
    }
    workstation = record;
    // One heartbeat that carries the new key, so the page can say at once whether the service took it.
    if (heartbeatPending) await heartbeatPending;
    const current = await heartbeat();
    return { accepted: true, workstation: current.workstation, serviceConnected: current.serviceConnected };
  }

  // The page bridge runs on the service's own pages. On this computer's workbench the manifest puts it there; for a team's
  // central service it is registered here, for that address only, and taken off again when the plugin goes back.
  async function syncServiceBridge() {
    const wanted = serviceOrigin === LOCAL_SERVICE_ORIGIN ? null : servicePagePattern(serviceOrigin);
    const [registered] = await chromeApi.scripting.getRegisteredContentScripts({ ids: [SERVICE_BRIDGE_SCRIPT_ID] });
    if (registered && wanted && registered.matches?.length === 1 && registered.matches[0] === wanted) return;
    if (registered) await chromeApi.scripting.unregisterContentScripts({ ids: [SERVICE_BRIDGE_SCRIPT_ID] });
    if (wanted) {
      await chromeApi.scripting.registerContentScripts([{ id: SERVICE_BRIDGE_SCRIPT_ID, matches: [wanted], js: ["bridge.js"],
        runAt: "document_start", persistAcrossSessions: true }]);
    }
  }

  // The settings page moves the plugin to another service. Not while a job runs: its result belongs to the service that
  // handed it out. A team's service needs the plugin let onto its pages first (the settings page asks the person).
  async function switchService(origin) {
    await loadSettings();
    if (activeCapture || switchingService) return { saved: false, code: "capture_busy" };
    switchingService = true;
    try {
      if (origin !== LOCAL_SERVICE_ORIGIN) {
        const granted = await Promise.resolve().then(() => chromeApi.permissions.contains({ origins: [servicePagePattern(origin)] }))
          .catch(() => false);
        if (granted !== true) return { saved: false, code: "service_access_missing" };
      }
      try {
        await chromeApi.storage.local.set({ [SERVICE_STORAGE_KEY]: { origin } });
      } catch {
        return { saved: false, code: "settings_storage_unavailable" };
      }
      while (heartbeatPending) await heartbeatPending;
      const previous = serviceOrigin;
      serviceOrigin = origin;
      if (previous !== origin) lastHeartbeat = { ok: false, code: "heartbeat_not_observed", observedAt: null };
      let bridgeReady = true;
      try { await syncServiceBridge(); } catch { bridgeReady = false; }
      // The address left behind no longer needs this plugin on its pages.
      if (previous !== origin && previous !== LOCAL_SERVICE_ORIGIN) {
        await Promise.resolve().then(() => chromeApi.permissions.remove({ origins: [servicePagePattern(previous)] })).catch(() => {});
      }
      await heartbeat();
      return { saved: true, bridgeReady, status: status() };
    } finally {
      switchingService = false;
    }
  }

  // Only the plugin's own settings page may ask which service it works for, or move it to another one.
  function fromSettingsPage(sender) {
    return sender?.id === chromeApi.runtime.id && typeof sender?.url === "string" &&
      sender.url.split(/[?#]/u, 1)[0] === chromeApi.runtime.getURL(SETTINGS_PAGE);
  }

  function handleSettingsMessage(message, sender, sendResponse) {
    if (!fromSettingsPage(sender)) {
      sendResponse({ saved: false, code: "request_origin_invalid" });
      return false;
    }
    if (message.type === SERVICE_STATUS_MESSAGE_TYPE) {
      void loadSettings().then(() => sendResponse({ status: status() }));
      return true;
    }
    if (Object.keys(message).sort().join() !== "serviceOrigin,type" || normalizeServiceAddress(message.serviceOrigin) !== message.serviceOrigin) {
      sendResponse({ saved: false, code: "service_address_invalid" });
      return false;
    }
    void switchService(message.serviceOrigin).then(sendResponse);
    return true;
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
    if (message?.type === SERVICE_STATUS_MESSAGE_TYPE || message?.type === SERVICE_ADDRESS_MESSAGE_TYPE) {
      return handleSettingsMessage(message, sender, sendResponse);
    }
    if (message?.type !== BACKGROUND_PING && message?.type !== WORKSTATION_KEY_MESSAGE_TYPE && !START_TYPES.has(message?.type)) return false;
    // A worker Chrome has just woken does not know yet which service it works for: it reads that first, then answers.
    if (!settingsLoaded) {
      void loadSettings().then(() => { handleMessage(message, sender, sendResponse); });
      return true;
    }
    if (!isReviewSender(sender?.url, serviceOrigin)) {
      sendResponse({ accepted: false, code: "request_origin_invalid" });
      return false;
    }
    if (message.type === WORKSTATION_KEY_MESSAGE_TYPE) {
      if (!validateWorkstationKeyMessage(message)) {
        sendResponse({ accepted: false, code: "workstation_key_invalid" });
        return false;
      }
      void keepWorkstation(message, sender.url).then(sendResponse);
      return true;
    }
    if (message.type === BACKGROUND_PING) {
      // No network, no lease claim, no capture from a health inquiry. A tab that would not close is looked up again in
      // Chrome's tab list, so the next inquiry already sees it gone once the owner has closed it.
      if (strayTab) void settleStrayTab();
      sendResponse(status());
      return false;
    }
    if (!validateCaptureStartSignal(message).ok) {
      sendResponse({ accepted: false, code: "start_signal_invalid" });
      return false;
    }
    if (activeCapture || switchingService) {
      sendResponse({ accepted: false, code: "capture_busy" });
      return false;
    }
    if (strayTab) {
      // The owner may have closed that tab a moment ago: look once, and turn the job away with the real reason, not "busy".
      void settleStrayTab().then(() => {
        if (activeCapture || switchingService) return { accepted: false, code: "capture_busy" };
        if (strayTab) return { accepted: false, code: strayTab.code };
        return claimCapture(message);
      }).then(sendResponse);
      return true;
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
    // The settings page opens from the plugin's icon; the page bridge is put back on the team's service pages if Chrome lost it.
    chromeApi.action.onClicked.addListener(() => { void Promise.resolve().then(() => chromeApi.runtime.openOptionsPage()).catch(() => {}); });
    void loadSettings().then(syncServiceBridge).catch(() => {});
    chromeApi.alarms.onAlarm.addListener((alarm) => { if (alarm.name === HEARTBEAT_ALARM) void heartbeat(); });
    chromeApi.runtime.onInstalled.addListener(start);
    chromeApi.runtime.onStartup.addListener(start);
    // A cold worker can be woken by a status PING. Module loading must never claim work.
    void ensureHeartbeatAlarm().catch(() => {
      lastHeartbeat = { ok: false, code: "alarm_unavailable", observedAt: clock() };
    });
  }
  return { status, heartbeat, handleMessage, ensureHeartbeatAlarm, install, ready: loadSettings };
}

if (globalThis.chrome?.runtime?.id) {
  createCaptureRuntime({ chromeApi: globalThis.chrome, fetchImpl: globalThis.fetch.bind(globalThis) }).install();
}
