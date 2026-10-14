import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { prepareRuntimePackage } from "../scripts/runtime-package.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
for (const value of [port, gatewayPort]) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535 || [4317, 4318, 4173].includes(value)) {
    throw new Error("TEST_REQUIRES_ISOLATED_PORT");
  }
}
if (port === gatewayPort) throw new Error("TEST_REQUIRES_DISTINCT_PORTS");
const base = `http://127.0.0.1:${port}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function started(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => finish(new Error("PACKAGED_SERVER_START_TIMEOUT")), 10000);
    const onData = chunk => { stdout += chunk; if (stdout.includes(base)) finish(); };
    const onExit = (code, signal) => finish(new Error(`PACKAGED_SERVER_START_FAILED:${code}:${signal}`));
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off("data", onData); child.off("error", finish); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("error", finish); child.once("exit", onExit);
  });
}

test("the prepared package serves built UI and preserves both historical runtime shapes across restarts", async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "runtime-package-api-"));
  let child = null;
  let observer = null;
  t.after(async () => {
    try { if (child) await stopApiProcess(child); }
    finally {
      try {
        if (observer?.listening) {
          observer.closeAllConnections();
          await new Promise((resolve, reject) => observer.close(error => error ? reject(error) : resolve()));
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  });
  const output = path.join(root, "runtime-copy");
  const dataFile = path.join(root, "data", "state.json");
  await fs.mkdir(path.dirname(dataFile));
  const source = {
    meta: { version: 2, automationStarted: false }, rules: {}, evidencePacks: [],
    candidates: [{ id: "HISTORICAL-PACKAGE-ITEM", dataRevision: 7, productName: "Historical item", targetStore: "dandanshu",
      workflowStatus: "codex_processing", processing: { state: "running", runId: "old-run", startedAt: "2026-08-01T00:00:00.000Z",
        lastProgressAt: "2026-08-01T00:00:00.000Z", currentStep: "Old step", claimRevision: 7 } }],
    dispatches: [{ id: "old-dispatch", candidateId: "HISTORICAL-PACKAGE-ITEM", dataRevision: 7,
      workflowStatusAtDispatch: "codex_processing", status: "running", runId: "old-run", turnId: "old-run" }],
    runtime: { softwareJobs: [{ schemaVersion: "software-job-v1", jobId: "old-software-job", candidateId: "HISTORICAL-PACKAGE-ITEM",
      skuPackageId: "old-package", revision: 7, jobType: "c1_paid_keyword_evidence", status: "claimed", externalRequestState: "not_sent" }] }
  };
  await fs.writeFile(dataFile, JSON.stringify(source));
  let bytes = await fs.readFile(dataFile);
  const receipt = await prepareRuntimePackage({ sourceDirectory: appDir, outputDirectory: output, nodeExecutable: process.execPath });
  assert.equal(receipt.installed, false);
  assert.equal(receipt.activated, false);
  assert.equal(receipt.persistentContentIncluded, false);
  const packageEntries = await fs.readdir(output);
  for (const excluded of ["data", "logs", "evidence", "product-images", ".env"]) assert.equal(packageEntries.includes(excluded), false);
  let externalRequests = 0;
  observer = http.createServer((_request, response) => {
    externalRequests += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"error":"unexpected external dependency request"}');
  });
  await new Promise((resolve, reject) => { observer.once("error", reject); observer.listen(gatewayPort, "127.0.0.1", resolve); });
  for (let start = 0; start < 4; start++) {
    if (start === 2) {
      delete source.runtime;
      await fs.writeFile(dataFile, JSON.stringify(source));
      bytes = await fs.readFile(dataFile);
    }
    const stderr = [];
    child = spawn("/bin/bash", [path.join(output, "scripts/launch-server.sh")], {
      cwd: root, env: {
        ...process.env, SELECTION_REVIEW_DATA_FILE: dataFile, SELECTION_REVIEW_PORT: String(port),
        SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
        SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
        SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: `http://127.0.0.1:${gatewayPort}`,
        SELECTION_REVIEW_STORE_BINDINGS_JSON: "[]", SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(root, "uploads"),
        SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password",
        SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(root, "owner-identity", "owner.json"),
        SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off"
      }, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    await started(child);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.dataVersion, 2);
    assert.equal(health.ready, true);
    assert.equal(health.readiness.fresh, true);
    const live = await (await fetch(`${base}/api/live`)).json();
    assert.equal(live.live, true);
    const ready = await (await fetch(`${base}/api/ready`)).json();
    assert.equal(ready.ready, true);
    const ownerAccess = await (await fetch(`${base}/api/owner-access`)).json();
    assert.equal(ownerAccess.status, "setup_required");
    assert.equal(ownerAccess.user, null);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.equal(html, await fs.readFile(path.join(output, "dist/index.html"), "utf8"));
    const asset = html.match(/src="(\/assets\/[^"<>]+\.js)"/);
    assert.ok(asset, "built UI JavaScript must be served by the package");
    const script = await fetch(`${base}${asset[1]}`);
    assert.equal(script.status, 200);
    assert.deepEqual(Buffer.from(await script.arrayBuffer()), await fs.readFile(path.join(output, "dist", asset[1])));
    const stateResponse = await fetch(`${base}/api/state`);
    assert.equal(stateResponse.status, 200, "historical state must remain readable with or without runtime collections");
    const state = await stateResponse.json();
    assert.equal(state.runtimeArchitecture.currentUser.authenticated, false);
    assert.equal(state.runtimeArchitecture.currentUser.canAuthorizeProduction, false);
    assert.equal(state.candidates[0].activeDispatch, null);
    assert.equal(state.candidates[0].latestDispatch.id, "old-dispatch");
    assert.equal(state.candidates[0].processingStatus.actualRunning, false);
    assert.equal(state.summary.dispatch.processingCounts.actualRunning, 0);
    const heartbeat = await fetch(`${base}/api/extension/heartbeat`, { method: "POST",
      headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ version: "1.4.1", backgroundReady: true, observedAt: new Date().toISOString() }) });
    assert.equal(heartbeat.status, 200);
    assert.equal((await heartbeat.json()).captureJob, null);
    assert.deepEqual(await fs.readFile(dataFile), bytes);
    assert.equal(externalRequests, 0);
    await stopApiProcess(child); child = null;
    assert.equal(stderr.join(""), "");
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(output, "runtime-package.json"), "utf8")).startupVerified, false,
    "test execution must not rewrite the preparation receipt as deployment evidence");
});
