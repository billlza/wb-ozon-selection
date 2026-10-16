import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { initialBusinessStateDocument } from "../lib/business-state-repository.mjs";
import { importBusinessStateToPostgres } from "../lib/business-state-import.mjs";
import { createPostgresBusinessStateStore } from "../lib/postgres-business-state-store.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

// Runs against a real, disposable Postgres (scripts/run-ci-database-tests.mjs), in its own schema dropped afterwards.
// Two service processes on the same data, as during a zero-downtime deploy. Synthetic data only.
const DATABASE_URL = process.env.SELECTION_REVIEW_TEST_DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//u.test(DATABASE_URL ?? "")) {
  throw new Error("TEST_REQUIRES_DATABASE: set SELECTION_REVIEW_TEST_DATABASE_URL to a disposable Postgres");
}
const appDir = fileURLToPath(new URL("..", import.meta.url));
const ports = ["SELECTION_REVIEW_TEST_PORT", "SELECTION_REVIEW_TEST_SECOND_PORT"].map(key => Number(process.env[key]));
if (ports.some(port => !Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173, 4319].includes(port)) || ports[0] === ports[1]) {
  throw new Error("TEST_REQUIRES_ISOLATED_PORT");
}

const product = { id: "HANDOFF-1", source: "user", group: "userAdded", targetStore: "dandanshu", targetPlatform: "ozon",
  storeRef: structuredClone(SYNTHETIC_STORE_REF), productName: "测试音乐盒 HANDOFF-1", productUrl: "https://www.ozon.ru/product/test-4403916892/",
  workflowStatus: "codex_processing", dataRevision: 1, processing: { state: "idle", manualHold: true }, comments: [], history: [],
  createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" };

function startService(t, { port, connectionString, directory }) {
  const base = `http://127.0.0.1:${port}`;
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_PUBLIC_PORT: String(port),
      SELECTION_REVIEW_DATA_FILE: path.join(directory, "unused.json"), SELECTION_REVIEW_STATE_ADAPTER: "postgres",
      SELECTION_REVIEW_DATABASE_URL: connectionString, SELECTION_REVIEW_INITIALIZE_DATA_FILE: "1",
      SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: "dandanshu", platform: "ozon", storeRef: SYNTHETIC_STORE_REF }]),
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => { output.stdout += chunk; });
  child.stderr.on("data", chunk => { output.stderr += chunk; });
  let stopped = false;
  t.after(() => (stopped ? undefined : stopApiProcess(child)));
  // Resolves once `pattern` shows in the process's output; fails if the process exits first.
  const shows = (stream, pattern, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const check = () => { if (pattern.test(output[stream])) { done(); resolve(); } };
    const onExit = (code, signal) => { done(); reject(new Error(`API_EXITED:${code}:${signal}: ${output.stderr.slice(-2000)}`)); };
    const timer = setTimeout(() => { done(); reject(new Error(`API_OUTPUT_TIMEOUT:${pattern}: ${output.stderr.slice(-2000)}`)); }, timeoutMs);
    function done() { clearTimeout(timer); child.stdout.off("data", check); child.stderr.off("data", check); child.off("exit", onExit); }
    child.stdout.on("data", check); child.stderr.on("data", check); child.once("exit", onExit);
    check();
  });
  return { base, output, child, shows, stop: async () => { stopped = true; await stopApiProcess(child); } };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

test("a second service process stands by on its port while the first holds the data, and takes over once the first stops", async t => {
  const schema = `handoff_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const connectionString = `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const directory = await mkdtemp(path.join(tmpdir(), "process-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = path.join(directory, "seed.json");
  await writeFile(seed, JSON.stringify({ ...initialBusinessStateDocument(), candidates: [product] }));
  const store = createPostgresBusinessStateStore({ connectionString });
  try {
    assert.equal((await importBusinessStateToPostgres({ sourceFile: seed, store, write: true })).status, "imported");
  } finally { await store.close(); }

  const first = startService(t, { port: ports[0], connectionString, directory });
  await first.shows("stdout", new RegExp(`http://127\\.0\\.0\\.1:${ports[0]}`, "u"));
  const second = startService(t, { port: ports[1], connectionString, directory });
  await second.shows("stderr", /另一个服务进程还在用这份数据/u);
  assert.doesNotMatch(second.output.stdout, new RegExp(`http://127\\.0\\.0\\.1:${ports[1]}`, "u"), "it has not started serving");

  // Standing by: alive for the platform's check, and anything else waits.
  const standing = await getJson(`${second.base}/api/live`);
  assert.deepEqual([standing.status, standing.body.standby, standing.body.live], [200, true, true]);
  assert.equal((await getJson(`${first.base}/api/live`)).body.standby, undefined);
  let settled = false;
  const held = getJson(`${second.base}/api/state`).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(settled, false, "the second process serves nothing while the first holds the data");

  // The first stops (as the platform stops the old process): the second takes the data over and serves the held request.
  await first.stop();
  await second.shows("stderr", /接手了/u);
  await second.shows("stdout", new RegExp(`http://127\\.0\\.0\\.1:${ports[1]}`, "u"));
  const answered = await held;
  assert.equal(answered.status, 200, JSON.stringify(answered.body).slice(0, 500));
  assert.deepEqual(answered.body.candidates.map(item => item.id), ["HANDOFF-1"]);
  const working = await getJson(`${second.base}/api/live`);
  assert.deepEqual([working.status, working.body.live, working.body.standby], [200, true, undefined]);
  assert.equal(second.output.stderr.includes(connectionString), false);
});
