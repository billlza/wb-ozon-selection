import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess, allocatedTestPorts } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { api: port } = allocatedTestPorts();
const baseUrl = `http://127.0.0.1:${port}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

test("extension heartbeat stays in memory and is exposed through health and state", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "extension-heartbeat-"));
  const dataFile = path.join(directory, "candidates.json");
  const original = JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-17T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [],
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  });
  await writeFile(dataFile, original);

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await waitForHealth(child, stderr);

  const before = await readFile(dataFile, "utf8");
  const preflight = await fetch(`${baseUrl}/api/extension/heartbeat`, {
    method: "OPTIONS",
    headers: { Origin: extensionOrigin }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

  const rejected = await fetch(`${baseUrl}/api/extension/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: "1.2.2", backgroundReady: true })
  });
  assert.equal(rejected.status, 403);

  const accepted = await fetch(`${baseUrl}/api/extension/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: extensionOrigin },
    body: JSON.stringify({
      version: "1.2.2",
      backgroundReady: true,
      observedAt: "2026-08-17T12:00:00.000Z"
    })
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.heartbeat.status, "connected");
  assert.equal(acceptedBody.heartbeat.version, "1.2.2");
  assert.equal(acceptedBody.heartbeat.fresh, true);

  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.extensionHeartbeat.status, "connected");
  assert.equal(health.extensionHeartbeat.backgroundReady, true);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.extensionHeartbeat.status, "connected");
  assert.equal(state.extensionHeartbeat.version, "1.2.2");
  assert.equal(await readFile(dataFile, "utf8"), before);
});
