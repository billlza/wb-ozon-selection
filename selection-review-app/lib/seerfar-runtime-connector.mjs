import { createHash } from "node:crypto";
import { CredentialStoreError, createOsCredentialStore, credentialStoreBackendFor } from "./credential-store.mjs";

import { createSeerfarOpenApiTransport, SeerfarTransportError, SEERFAR_OPEN_API_BASE } from "./seerfar-open-api-transport.mjs";

export const SEERFAR_KEYCHAIN_SERVICE = "egg-ozon-operations-center";
export const SEERFAR_KEYCHAIN_ACCOUNT = "seerfar-open-api";
export const SEERFAR_RUNTIME_CONNECTOR_VERSION = "seerfar-runtime-connector-v1";

const ALLOWED_PATHS = new Set([
  "/open-api/quota",
  "/open-api/product/detail/search/ozon",
  "/open-api/product/detail/search/wb",
  "/open-api/category/detail/search/ozon",
  "/open-api/category/detail/search/wb",
  "/open-api/keyword/backSearch/ozon",
  "/open-api/keyword/backSearch/wb"
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRequestId(value) {
  if (nonEmpty(value) && /^[a-zA-Z0-9._:-]{1,160}$/.test(value)) return value;
  return `seerfar-http:${createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 20)}`;
}

const SEERFAR_CREDENTIAL_ENTRY = Object.freeze({ service: SEERFAR_KEYCHAIN_SERVICE, account: SEERFAR_KEYCHAIN_ACCOUNT });

function keychainFailure(error) {
  if (error instanceof CredentialStoreError) {
    if (error.code === "credential_missing") return new SeerfarTransportError("credential_missing");
    if (error.code === "credential_access_denied") return new SeerfarTransportError("credential_access_denied");
  }
  return error;
}

function credentialStoreFor({ credentialStore, execFileImpl, platform }) {
  return credentialStore ?? createOsCredentialStore({ ...(platform ? { platform } : {}), ...(execFileImpl ? { execFileImpl } : {}) });
}

function networkFailure(error, controller, signal) {
  if (signal?.aborted) return signal.reason;
  if (controller.signal.aborted) return new SeerfarTransportError('network_timeout');
  const code=error?.cause?.code ?? error?.code;
  if (['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code)) return new SeerfarTransportError('network_error');
  return error;
}

export async function readSeerfarKeychainSecret({ execFileImpl, platform, credentialStore } = {}) {
  try {
    const output = await credentialStoreFor({ credentialStore, execFileImpl, platform }).readSecret(SEERFAR_CREDENTIAL_ENTRY, { maxBuffer: 64 * 1024 });
    if(typeof output !== "string") throw new TypeError("SEERFAR_KEYCHAIN_RESULT_INVALID");
    const secret = output.trim();
    if (!secret) throw new SeerfarTransportError("credential_missing");
    return secret;
  } catch (error) { throw keychainFailure(error); }
}

export async function inspectSeerfarKeychainEntry({ execFileImpl, platform, credentialStore } = {}) {
  try {
    return await credentialStoreFor({ credentialStore, execFileImpl, platform }).hasSecret(SEERFAR_CREDENTIAL_ENTRY, { maxBuffer: 64 * 1024 });
  } catch (error) {
    throw keychainFailure(error);
  }
}

export async function inspectSeerfarRuntimeConfiguration({ keychainEntryReader = inspectSeerfarKeychainEntry, platform = process.platform } = {}) {
  const value=await keychainEntryReader();
  if (typeof value !== 'boolean') throw new TypeError('SEERFAR_CONFIGURATION_RESULT_INVALID');
  const configured=value;
  return Object.freeze({
    connectorVersion: SEERFAR_RUNTIME_CONNECTOR_VERSION,
    configured,
    credentialLocation: configured ? credentialStoreBackendFor(platform) ?? "unsupported_platform" : "not_configured",
    service: SEERFAR_KEYCHAIN_SERVICE,
    account: SEERFAR_KEYCHAIN_ACCOUNT,
    secretExposed: false
  });
}

export function createSeerfarFetchTransport({ fetchImpl = globalThis.fetch, timeoutMs = 20_000, now = () => new Date().toISOString(), beforeRequestSend = null, signal } = {}) {
  if (typeof fetchImpl !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof now !== "function" || (beforeRequestSend !== null && typeof beforeRequestSend !== "function") || (signal !== undefined && !(signal instanceof AbortSignal))) {
    throw new Error("SEERFAR_HTTP_RUNTIME_DEPENDENCY_INVALID");
  }
  let calls = 0;
  return async function seerfarFetchTransport(request) {
    calls += 1;
    if (!request || request.attempt !== 1 || calls > 3) throw new Error("SEERFAR_HTTP_RUNTIME_ATTEMPT_INVALID");
    const url = new URL(request.url);
    const base = new URL(SEERFAR_OPEN_API_BASE);
    if (url.protocol !== "https:" || url.origin !== base.origin || url.search || url.hash || !ALLOWED_PATHS.has(url.pathname)) {
      throw new Error("SEERFAR_HTTP_RUNTIME_ENDPOINT_REJECTED");
    }
    if (!['GET', 'POST'].includes(request.method) || request.redirect !== "error") {
      throw new Error("SEERFAR_HTTP_RUNTIME_REQUEST_REJECTED");
    }
    signal?.throwIfAborted();
    if(beforeRequestSend!==null) await beforeRequestSend({stage:request.step === 'reverse_keywords' ? 'target' : request.step});
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort=()=>controller.abort(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let deadlineReject;
    const deadline=new Promise((_resolve,reject)=>{deadlineReject=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',deadlineReject,{once:true});});
    let response, json;
    try {
      response = await Promise.race([fetchImpl(url, {
        method: request.method, headers: request.headers,
        body: request.method === "POST" ? JSON.stringify(request.body ?? {}) : undefined,
        redirect: "error", signal: controller.signal
      }),deadline]);
      if([401,403,429].includes(response.status)||response.status>=500) throw new SeerfarTransportError([401,403].includes(response.status)?'login_required':response.status===429?'quota_or_rate_limit':'provider_server_error',{httpStatus:response.status});
      const declaredLength=Number(response.headers?.get?.('content-length') || 0);
      if(Number.isFinite(declaredLength)&&declaredLength>4*1024*1024) throw new SeerfarTransportError('schema_error');
      const text=await Promise.race([response.text(),deadline]);
      controller.signal.throwIfAborted();
      if(text.length>4*1024*1024) throw new SeerfarTransportError('schema_error');
      try { json=JSON.parse(text); }
      catch(error) { if(!(error instanceof SyntaxError))throw error; throw new SeerfarTransportError('schema_error',{httpStatus:response.status}); }
    } catch(error) { throw networkFailure(error,controller,signal); }
    finally { clearTimeout(timer);controller.signal.removeEventListener('abort',deadlineReject);signal?.removeEventListener('abort',abort); }

    return {
      status: response.status,
      json,
      requestId: safeRequestId(response.headers?.get?.("x-request-id") || response.headers?.get?.("request-id")),
      completedAt: now()
    };
  };
}

export function createSeerfarRuntimeTransport({
  secretReader = readSeerfarKeychainSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  clock,
  sleep,
  beforeRequestSend = null,
  onStepResult = null,
  signal
} = {}) {
  return createSeerfarOpenApiTransport({
    secretProvider: async () => { signal?.throwIfAborted(); return secretReader(); },
    onStepResult,
    httpTransport: createSeerfarFetchTransport({ fetchImpl, timeoutMs, beforeRequestSend, signal, now: () => new Date(clock?.now?.() ?? Date.now()).toISOString() }),
    ...(clock ? { clock } : {}),
    ...(sleep ? { sleep } : {})
  });
}
