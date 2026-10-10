import { CredentialStoreError, createOsCredentialStore, isCredentialStorePlatformSupported } from "./credential-store.mjs";
import { sameStoreRef, isCompleteStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets, isCanonicalFrozenRef, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { OzonDEHttpTransportError, normalizeOzonDECredentialBindings, assertOzonDECredentialBinding,
  assertOzonDEProductionBindings, assertOzonAccountDiscoveryBindings, isOzonDEHttpClosedObject } from "./ozon-de-http-configuration.mjs";
export { OzonDEHttpTransportError, normalizeOzonDECredentialBindings } from "./ozon-de-http-configuration.mjs";

const officialOrigin = "https://api-seller.ozon.ru";
const requestFields = ["platform", "store", "storeRef", "warehouseRef", "credentialAlias", "method", "endpoint", "body", "write", "executionKey"];
const bodylessEndpoints = new Set(["/v1/roles", "/v1/seller/info"]);
const accountReadEndpoints = new Set([...bodylessEndpoints, "/v2/warehouse/list"]);
const beforeSendEndpoints = new Set([...accountReadEndpoints, "/v3/product/import", "/v1/product/import/info",
  "/v2/products/stocks", "/v4/product/info/attributes", "/v3/product/info/list", "/v5/product/info/prices",
  "/v2/product/info/stocks-by-warehouse/fbs"]);
const endpoints = new Map([
  ["/v3/product/import", true], ["/v1/product/import/info", false], ["/v2/products/stocks", true],
  ["/v4/product/info/attributes", false], ["/v3/product/info/list", false], ["/v5/product/info/prices", false],
  ["/v4/product/info/stocks", false], ["/v3/product/list", false], ["/v1/roles", false],
  ["/v2/product/info/stocks-by-warehouse/fbs", false],
  ["/v2/warehouse/list", false], ["/v1/seller/info", false]
]);
const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED"]);
const programError = error => [TypeError, ReferenceError, SyntaxError, RangeError, EvalError, URIError, AggregateError].some(Type => error instanceof Type);
const transportError = (code, facts = {}) => new OzonDEHttpTransportError(code, facts);

function apiKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(value.trim())) {
    throw transportError("OZON_DE_CREDENTIAL_VALUE_INVALID", { layer: "credential" });
  }
  return value.trim();
}

/** Local development adapter only. Explicit injection replaces this boundary in a central runtime. */
export async function readOzonDEKeychainSecret(binding, { signal, runtimeMode = "local_development", execFileImpl, platform = process.platform,
  credentialStore } = {}) {
  assertOzonDECredentialBinding(binding);
  if (runtimeMode !== "local_development" || credentialStore === undefined && !isCredentialStorePlatformSupported(platform)) {
    throw transportError("OZON_DE_CREDENTIAL_READER_UNAVAILABLE", { layer: "credential" });
  }
  if (execFileImpl !== undefined && typeof execFileImpl !== "function" || signal !== undefined && !(signal instanceof AbortSignal)) throw transportError("OZON_DE_HTTP_CONFIGURATION_INVALID");
  if (signal?.aborted) throw transportError("OZON_DE_HTTP_CANCELLED", { layer: "credential" });
  const store = credentialStore ?? createOsCredentialStore({ platform, ...(execFileImpl ? { execFileImpl } : {}) });
  let stdout;
  try {
    stdout = await store.readSecret({ service: binding.keychainService, account: binding.keychainAccount }, { maxBuffer: 8 * 1024, timeout: 5000, signal });
  } catch (error) {
    if (programError(error)) throw error;
    if (error instanceof CredentialStoreError && error.code === "credential_store_unavailable") {
      throw transportError("OZON_DE_CREDENTIAL_READER_UNAVAILABLE", { layer: "credential" });
    }
    // This process boundary deliberately excludes stdout, stderr, command arguments and the original error object.
    throw transportError(signal?.aborted ? "OZON_DE_HTTP_CANCELLED" : "OZON_DE_CREDENTIAL_READ_FAILED", { layer: "credential" });
  }
  return apiKey(stdout);
}

function originFor(baseUrl, runtimeMode) {
  let url;
  try { url = new URL(baseUrl); }
  catch (error) { if (error instanceof TypeError) throw transportError("OZON_DE_HTTP_CONFIGURATION_INVALID"); throw error; }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.origin !== officialOrigin && !(runtimeMode === "local_development" && url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) && url.port)) throw transportError("OZON_DE_HTTP_CONFIGURATION_INVALID");
  return url.origin;
}

function jsonBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
  }
  const active = new Set(); let nodes = 0, textBytes = 0;
  function visit(value, depth) {
    if (++nodes > 10_000 || depth > 32) throw transportError("OZON_DE_HTTP_REQUEST_TOO_LARGE", { layer: "request" });
    if (typeof value === "string") {
      textBytes += Buffer.byteLength(value);
      if (textBytes > 2 * 1024 * 1024) throw transportError("OZON_DE_HTTP_REQUEST_TOO_LARGE", { layer: "request" });
    }
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || active.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
    }
    active.add(value);
    if (Array.isArray(value) && (value.length > 10_000 || Reflect.ownKeys(value).length !== value.length + 1)) {
      throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
    }
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !Object.hasOwn(descriptor, "value")) throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
      visit(descriptor.value, depth + 1);
    }
    active.delete(value);
  }
  visit(body, 0);
  try { assertNoProductionSecrets(body, "ozonDERequest.body"); }
  catch (error) {
    if (error?.constructor === Error && /^(?:PRODUCTION_AUTHORIZATION_SECRET_REJECTED|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED):/.test(error.message)) {
      throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
    }
    throw error;
  }
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw transportError("OZON_DE_HTTP_REQUEST_TOO_LARGE", { layer: "request" });
  return serialized;
}

function requestScope(request, productions, credentials) {
  if (!isOzonDEHttpClosedObject(request, requestFields) || request.platform !== "ozon" || request.method !== "POST" ||
      !isCompleteStoreRef(request.storeRef, request.store) || !isCanonicalFrozenRef(request.warehouseRef) || !isCanonicalFrozenRef(request.credentialAlias) ||
      !endpoints.has(request.endpoint) || endpoints.get(request.endpoint) !== request.write ||
      !(request.executionKey === null && !request.write || isCanonicalFrozenRef(request.executionKey))) {
    throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
  }
  const matches = productions.filter(binding => binding.platform === request.platform && sameStoreRef(binding.storeRef, request.storeRef) &&
    binding.warehouseRef === request.warehouseRef && binding.credentialAlias === request.credentialAlias);
  const credential = credentials.find(binding => binding.credentialAlias === request.credentialAlias);
  if (matches.length !== 1 || !credential) throw transportError("OZON_DE_HTTP_REQUEST_SCOPE_REJECTED", { layer: "request" });
  if (bodylessEndpoints.has(request.endpoint) && request.body !== null) throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
  return { credential, body: bodylessEndpoints.has(request.endpoint) ? null : jsonBody(request.body), endpoint: request.endpoint };
}

function discoveryRequestScope(request, discoveries, credentials) {
  if (!isOzonDEHttpClosedObject(request, ["schemaVersion", "subject", "accountRoute", "platform", "method", "endpoint", "body", "write", "executionKey"]) ||
      request.schemaVersion !== "ozon-account-discovery-request-v1" || request.platform !== "ozon" || request.method !== "POST" || request.write !== false ||
      !isCanonicalFrozenRef(request.executionKey) || !accountReadEndpoints.has(request.endpoint) ||
      !isOzonDEHttpClosedObject(request.subject, ["kind", "preparationId", "revision"]) || request.subject.kind !== "account_preparation" ||
      !isCanonicalFrozenRef(request.subject.preparationId) || !Number.isSafeInteger(request.subject.revision) || request.subject.revision < 0 ||
      !isOzonDEHttpClosedObject(request.accountRoute, ["bindingId", "configurationVersion", "targetStore", "credentialAlias", "clientIdRef"]) ||
      !Object.values(request.accountRoute).every(isCanonicalFrozenRef) ||
      (request.endpoint === "/v2/warehouse/list" ? !isOzonDEHttpClosedObject(request.body, ["limit"]) || request.body.limit !== 20 : request.body !== null)) {
    throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
  }
  assertNoProductionSecrets(request);
  const route = request.accountRoute;
  const matches = discoveries.filter(binding => ["bindingId", "configurationVersion", "targetStore", "credentialAlias"]
    .every(key => binding[key] === route[key]));
  const credential = credentials.find(binding => binding.credentialAlias === route.credentialAlias);
  if (matches.length !== 1 || !credential || route.clientIdRef !== `ozon-client-configuration:${fingerprintCanonicalRecord(credential)}`) {
    throw transportError("OZON_DE_HTTP_REQUEST_SCOPE_REJECTED", { layer: "request" });
  }
  return { credential, body: request.body === null ? null : jsonBody(request.body), endpoint: request.endpoint };
}

/** One authorized transport invocation. The calling D/E use case owns permission, saved intent and endpoint-specific domain validation. */
export function createOzonDEHttpTransport({ productionBindings, credentialBindings, discoveryBindings = [], runtimeMode = "local_development", baseUrl = officialOrigin,
  timeoutMs = 15_000, maxResponseBytes = 2 * 1024 * 1024, fetchImpl = globalThis.fetch, readSecret = readOzonDEKeychainSecret } = {}) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof fetchImpl !== "function" || typeof readSecret !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 ||
      maxResponseBytes > 16 * 1024 * 1024 || runtimeMode !== "local_development" && readSecret === readOzonDEKeychainSecret) throw transportError("OZON_DE_HTTP_CONFIGURATION_INVALID");
  const origin = originFor(baseUrl, runtimeMode);
  assertOzonDEProductionBindings(productionBindings);
  assertOzonAccountDiscoveryBindings(discoveryBindings);
  const credentials = normalizeOzonDECredentialBindings(credentialBindings, productionBindings, discoveryBindings), productions = structuredClone(productionBindings);
  const discoveries = structuredClone(discoveryBindings);
  return Object.freeze({ async requestJson(request, options = {}) {
    const requestVersion = request && typeof request === "object" ? Object.getOwnPropertyDescriptor(request, "schemaVersion")?.value : undefined;
    const scoped = requestVersion === "ozon-account-discovery-request-v1"
      ? discoveryRequestScope(request, discoveries, credentials) : requestScope(request, productions, credentials);
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["signal", "beforeRequestSend"].includes(key)) ||
        options.signal !== undefined && !(options.signal instanceof AbortSignal) || options.beforeRequestSend !== undefined &&
        (typeof options.beforeRequestSend !== "function" || !beforeSendEndpoints.has(scoped.endpoint))) throw transportError("OZON_DE_HTTP_REQUEST_INVALID", { layer: "request" });
    const signal = options.signal, controller = new AbortController(), deadlineAt = performance.now() + timeoutMs;
    let requestTransmission = "not_attempted", httpStatus = null, reader, runningBeforeSend = false;
    const errorFor = (code, layer) => transportError(code, { layer, requestTransmission, httpStatus,
      externalRequestState: requestTransmission === "not_attempted" ? "not_sent" : "unknown_outcome" });
    if (signal?.aborted) throw errorFor("OZON_DE_HTTP_CANCELLED", "transport");
    let rejectInterruption;
    const interrupted = new Promise((_resolve, reject) => { rejectInterruption = reject; });
    const stop = code => {
      if (controller.signal.aborted) return;
      const error = errorFor(code, "transport"); controller.abort(error); rejectInterruption(error);
    };
    const cancel = () => stop("OZON_DE_HTTP_CANCELLED");
    const timer = setTimeout(() => stop("OZON_DE_HTTP_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    const assertWithinDeadline = () => {
      if (!controller.signal.aborted && performance.now() >= deadlineAt) controller.abort(errorFor("OZON_DE_HTTP_TIMEOUT", "transport"));
      controller.signal.throwIfAborted();
    };
    const bounded = operation => Promise.race([Promise.resolve().then(() => { assertWithinDeadline(); return operation(); }), interrupted]);
    try {
      let secret;
      try { secret = await bounded(() => readSecret(scoped.credential, { signal: controller.signal, runtimeMode })); }
      catch (error) {
        if (error instanceof OzonDEHttpTransportError || programError(error)) throw error;
        throw errorFor("OZON_DE_CREDENTIAL_READ_FAILED", "credential");
      }
      const key = apiKey(secret);
      if (options.beforeRequestSend !== undefined) {
        runningBeforeSend = true;
        await bounded(() => options.beforeRequestSend());
        runningBeforeSend = false;
      }
      const response = await bounded(() => {
        controller.signal.throwIfAborted();
        requestTransmission = "attempted";
        return fetchImpl(`${origin}${scoped.endpoint}`, { method: "POST", redirect: "manual", signal: controller.signal,
          headers: { "Client-Id": scoped.credential.clientId, "Api-Key": key, "Content-Type": "application/json", Accept: "application/json" },
          ...(scoped.body === null ? {} : { body: scoped.body }) });
      });
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599 || typeof response.headers?.get !== "function") {
        throw errorFor("OZON_DE_HTTP_RESPONSE_STRUCTURE_INVALID", "response");
      }
      requestTransmission = "response_received"; httpStatus = response.status;
      if (httpStatus < 200 || httpStatus >= 300) throw transportError(httpStatus < 400 ? "OZON_DE_HTTP_REDIRECT_REJECTED" : "OZON_DE_HTTP_STATUS_FAILED",
        { layer: "http", requestTransmission, httpStatus, externalRequestState: "failed" });
      const length = response.headers.get("content-length");
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxResponseBytes)) throw errorFor("OZON_DE_HTTP_RESPONSE_TOO_LARGE", "response");
      if (!response.body || typeof response.body.getReader !== "function") throw errorFor("OZON_DE_HTTP_RESPONSE_JSON_INVALID", "response");
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const next = await bounded(() => reader.read());
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw errorFor("OZON_DE_HTTP_RESPONSE_STRUCTURE_INVALID", "response");
        bytes += next.value.byteLength;
        if (bytes > maxResponseBytes) throw errorFor("OZON_DE_HTTP_RESPONSE_TOO_LARGE", "response");
        if (next.value.byteLength > 0) chunks.push(next.value);
      }
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
      catch (error) { if (error instanceof TypeError) throw errorFor("OZON_DE_HTTP_RESPONSE_ENCODING_INVALID", "response"); throw error; }
      let result;
      try { result = JSON.parse(text); }
      catch (error) { if (error instanceof SyntaxError) throw errorFor("OZON_DE_HTTP_RESPONSE_JSON_INVALID", "response"); throw error; }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw errorFor("OZON_DE_HTTP_RESPONSE_STRUCTURE_INVALID", "response");
      assertWithinDeadline();
      return result;
    } catch (error) {
      if (error instanceof OzonDEHttpTransportError) throw error;
      if (runningBeforeSend) throw error;
      if (!programError(error) && (networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code)) ||
          error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated" && networkCodes.has(error.cause?.code))) {
        throw errorFor("OZON_DE_HTTP_CONNECTION_FAILED", "transport");
      }
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      // Aborting fetch also releases a response whose body could not be consumed. No retry or second request is scheduled.
      if (!controller.signal.aborted) controller.abort();
      if (reader) reader.releaseLock();
    }
  } });
}
