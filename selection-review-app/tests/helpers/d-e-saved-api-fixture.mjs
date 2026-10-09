import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess, allocatedTestPorts } from "./api-process-lifecycle.mjs";
import { createJsonBusinessStateRepository } from "../../lib/business-state-repository.mjs";
import { productionOwnerDecisionFixture } from "../fixtures/production-owner-decision-fixture.mjs";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const clone = value => structuredClone(value);

/** Uses the real owner preparation producer. Only isolated synthetic current configuration/evidence is supplied. */
export async function productionOwnerDecisionHttpFixture() {
  const owner = productionOwnerDecisionFixture();
  const document = await owner.repository.readSnapshot();
  document.meta.automationStarted = false;
  document.dispatches = [];
  const decision = owner.commercialDecision, candidate = document.candidates[0];
  const binding = { ...clone(decision.executionBinding), platform: candidate.targetPlatform, storeRef: clone(candidate.storeRef),
    storeName: "合成 HTTP 店铺", warehouseName: "合成 HTTP 仓库", warehouseRef: decision.warehouseRef,
    credentialAlias: decision.credentialAlias, verification: { evidenceRef: "configuration-evidence:synthetic:http",
      checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } };
  // The server uses its actual clock. This is an explicit synthetic declaration, not renewed real evidence.
  document.evidencePacks = document.evidencePacks.map(pack => ({ ...pack, expiresAt: "2099-01-01T00:00:00.000Z" }));
  const service = { schemaVersion: "d-e-service-binding-v1", serviceId: "service:synthetic:http:de", configurationVersion: "service-config:synthetic:1",
    productionBindingId: binding.bindingId, productionConfigurationVersion: binding.configurationVersion,
    workerId: "worker:synthetic:http:de", workerVersion: "worker-version:synthetic:1", leaseDurationMs: 60_000 };
  return { owner, document, candidate, binding, service };
}

/** Real server subprocess with password identity and a loopback dependency tripwire. No transport is injected into production. */
export async function startSavedDEApi(t, { directory, port, document, binding, productionBindings=[binding], services = [], accountReadServices = [], discoveryBindings=[], credentialBindings = [], ossConfiguration = null, dictionaryResponder = null, browserOrigin = null,
  identityProvider = "local_owner_password", catalogDirectory = null }) {
  const allocated = allocatedTestPorts();
  const dependencyPort = allocated.gateway;
  if (port !== allocated.api && port !== allocated.second) {
    throw new Error("TEST_REQUIRES_ISOLATED_PORT");
  }
  const base = `http://127.0.0.1:${port}`, businessDirectory = path.join(directory, "business"), privateDirectory = path.join(directory, "private");
  const dataFile = path.join(businessDirectory, "state.json");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(businessDirectory);
  await writeFile(dataFile, JSON.stringify(document));
  let dependencyRequests = 0, dictionaryRequests = 0;
  const tripwire = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let query = null;
    if (dictionaryResponder && request.url === '/api/read-only/evidence/ozon') {
      try { query = JSON.parse(body); }
      catch {
        dependencyRequests += 1;
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_dictionary_query' }));
        return;
      }
    }
    const allowed = dictionaryResponder?.(request, query) ?? null;
    if (allowed !== null) {
      dictionaryRequests += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(allowed));
      return;
    }
    dependencyRequests += 1;
    response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "unexpected_test_dependency_request" }));
  });
  await new Promise((resolve, reject) => { tripwire.once("error", reject); tripwire.listen(dependencyPort, "127.0.0.1", resolve); });
  const stderr = []; let child = null, cookie = "";
  t.after(async () => {
    try { if (child) await stopApiProcess(child); }
    finally {
      tripwire.closeAllConnections();
      await new Promise((resolve, reject) => tripwire.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const env = { ...process.env, ...(catalogDirectory?{SELECTION_REVIEW_BATCH_CATALOG_DIRECTORY:catalogDirectory}:{}), SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
    SELECTION_REVIEW_PUBLIC_ORIGIN:base,SELECTION_REVIEW_ALLOWED_ORIGINS:browserOrigin ? `${base},${browserOrigin}` : base,
    SELECTION_REVIEW_IDENTITY_PROVIDER: identityProvider, SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateDirectory, "owner.json"),
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: binding.storeRef.stableStoreId, platform: binding.platform, storeRef: binding.storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify(productionBindings), SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify(services),
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify(credentialBindings),
    SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: JSON.stringify(accountReadServices),
    SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON: JSON.stringify(discoveryBindings),
    SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: JSON.stringify({policies:[],pumpIntervalMs:null}),
    SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON: JSON.stringify(ossConfiguration),
    ...(dictionaryResponder ? { SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: `http://127.0.0.1:${dependencyPort}` } : {}),
    SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" };
  async function start() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 10000);
      let output = "";
      const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
      const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("").slice(-2000)}`));
      function done(error) {
        clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
        if (error) reject(error); else resolve();
      }
      child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
    });
  }
  async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: response.status, body: await response.json() };
  }
  async function post(route, body, { authenticated = true, headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { Origin: base, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  const password = "synthetic password for bounded saved DE HTTP tests";
  async function authenticate(action = "setup") {
    const response = await post(`/api/owner-access/${action}`, { password }, { authenticated: false });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.cookie, /HttpOnly/); cookie = response.cookie.split(";")[0];
    return response.body.user;
  }
  await start();
  return { base, dataFile, get, post, authenticate, readBytes: () => readFile(dataFile),
    readDocument: () => createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot(),
    readStoredDocument: async () => JSON.parse(await readFile(dataFile, "utf8")),
    dependencyRequests: () => dependencyRequests, dictionaryRequests: () => dictionaryRequests, stderr,
    restart: async () => { await stopApiProcess(child); cookie = ""; await start(); },
    async assertClean() { assert.equal(dependencyRequests, 0); assert.equal(stderr.join(""), "");
      assert.equal((await readFile(dataFile, "utf8")).includes(password), false); }
  };
}

export async function confirmCurrentProduction(api, fixture) {
  const preparation = await api.get(`/api/candidates/${fixture.candidate.id}/lifecycle/production-owner-preparation`);
  assert.equal(preparation.status, 200); assert.equal(preparation.body.ready, true, JSON.stringify(preparation.body.gaps));
  const input = { contractVersion: preparation.body.contractVersion, ...preparation.body.source,
    bindingId: fixture.binding.bindingId, configurationVersion: fixture.binding.configurationVersion,
    merchantSku: fixture.owner.commercialDecision.merchantSku, confirmExactScope: true };
  const route = `/api/candidates/${fixture.candidate.id}/lifecycle/production-owner-decision`;
  const response = await api.post(route, input);
  return { input, route, response };
}
