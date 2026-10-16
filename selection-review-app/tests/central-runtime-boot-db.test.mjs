import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createPasswordVerifier } from "../lib/scrypt-verifier.mjs";
import { createPostgresTeamAccountStore } from "../lib/team-account-store.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

// The whole service in a central mode, the way a host such as Render starts it: Postgres, team accounts, the port the host
// gives in PORT, the AI gateway and the Ozon evidence service as private-network neighbours, its secrets in the server's
// own settings, and its picture folders on a disk outside the code folder. Runs against a real, disposable Postgres (scripts/run-ci-database-tests.mjs), in its own schema.
const DATABASE_URL = process.env.SELECTION_REVIEW_TEST_DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//u.test(DATABASE_URL ?? "")) {
  throw new Error("TEST_REQUIRES_DATABASE: set SELECTION_REVIEW_TEST_DATABASE_URL to a disposable Postgres");
}
const appDir = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_HOST = "team.example.test";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const BOSS = { userId: "team-user:00000000-0000-4000-8000-000000000001", loginName: "boss-a", displayName: "老板甲", role: "boss" };
const PASSWORD = "synthetic boss a 2026";
const KEYWORD_SERVICE = { schemaVersion: "c1-keyword-service-binding-v1", serviceId: "keyword-service:central-test",
  configurationVersion: "test-v1", provider: "seerfar_open_api", workerId: "keyword-worker:central-test", workerVersion: "test-v1",
  leaseDurationMs: 90_000, pumpIntervalMs: 60_000, requestTimeoutMs: 20_000 };
const SEERFAR_SECRET_SETTING = "SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__SEERFAR_OPEN_API";

async function startCentralService(t, extraEnv = {}) {
  const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173, 4319].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
  const schema = `central_boot_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connectionString = `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const accounts = createPostgresTeamAccountStore({ connectionString });
  await accounts.create({ ...BOSS, verifier: await createPasswordVerifier(PASSWORD) });
  await accounts.close();
  const directory = await mkdtemp(path.join(tmpdir(), "central-boot-"));
  const environment = { ...process.env };
  // Nothing of the developer's own configuration leaks in: only what this test sets.
  for (const key of Object.keys(environment)) if (key.startsWith("SELECTION_REVIEW_") && key !== "SELECTION_REVIEW_TEST_PORT") delete environment[key];
  delete environment.PORT;
  const stderr = [], stdout = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: { ...environment, PORT: String(port),
      SELECTION_REVIEW_RUNTIME_MODE: "central_test", SELECTION_REVIEW_BIND_HOST: "0.0.0.0",
      SELECTION_REVIEW_STATE_ADAPTER: "postgres", SELECTION_REVIEW_DATABASE_URL: connectionString, SELECTION_REVIEW_INITIALIZE_DATA_FILE: "1",
      SELECTION_REVIEW_DATA_FILE: path.join(directory, "unused.json"),
      SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(directory, "disk", "c2-final-uploads"),
      SELECTION_REVIEW_PRODUCT_IMAGES_DIR: path.join(directory, "disk", "product-images"),
      SELECTION_REVIEW_IDENTITY_PROVIDER: "team_accounts", SELECTION_REVIEW_DEFAULT_USER_ID: "central-test",
      SELECTION_REVIEW_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      SELECTION_REVIEW_AI_GATEWAY_URL: "http://ai-gateway:10000", SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: "http://ozon-evidence:10000",
      SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON: JSON.stringify([KEYWORD_SERVICE]),
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(async () => {
    await stopApiProcess(child);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`API_START_TIMEOUT: ${stderr.join("").slice(-2000)}`)), 20000);
    const onData = chunk => { stdout.push(String(chunk)); if (stdout.join("").includes(`:${port}`)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}: ${stderr.join("").slice(-2000)}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("exit", onExit);
  });

  // A request as it arrives through the host's proxy: to this process, under the Host the caller used.
  function call(route, { host = PUBLIC_HOST, method = "GET", body = undefined, headers = {} } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: route, method,
        headers: { Host: host, ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }), ...headers } },
      response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => {
          let parsed = text;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: response.statusCode, body: parsed, headers: response.headers });
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
  }
  return { call, stderr, port, directory };
}

test("a central service starts on the host's port, answers the host's health check, and signs people in", async t => {
  const { call, stderr, directory } = await startCentralService(t);
  // The host's health check may use a name other than the team's address.
  const live = await call("/api/live", { host: "10.0.0.7:10000" });
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.live, true);
  // Everything else still answers only under the service's own address.
  assert.equal((await call("/api/health", { host: "10.0.0.7:10000" })).status, 403);
  assert.equal((await call("/api/health")).status, 200);
  assert.equal((await call("/api/state")).status, 401);

  const login = await call("/api/owner-access/login", { method: "POST", body: { loginName: BOSS.loginName, password: PASSWORD },
    headers: { Origin: PUBLIC_ORIGIN, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const state = await call("/api/state", { headers: { Cookie: cookie } });
  assert.equal(state.status, 200, JSON.stringify(state.body).slice(0, 500));
  assert.equal(state.body.runtimeArchitecture.status, "central_runtime_ready");
  assert.equal(state.body.runtimeArchitecture.deploymentMode, "central_test");
  assert.equal(state.body.runtimeArchitecture.multiUserReady, true);
  assert.deepEqual(state.body.runtimeArchitecture.limitations, []);

  // Product pictures come from the folder on the disk, and only for someone signed in.
  const picture = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b20000000049454e44ae426082", "hex");
  await mkdir(path.join(directory, "disk", "product-images"), { recursive: true });
  await writeFile(path.join(directory, "disk", "product-images", "synthetic.png"), picture);
  assert.equal((await call("/product-images/synthetic.png")).status, 401);
  const served = await call("/product-images/synthetic.png", { headers: { Cookie: cookie } });
  assert.equal(served.status, 200);
  assert.equal(served.headers["content-type"], "image/png");

  // The keyword service needs the Seerfar key; the setting is empty, so the log names it once, without any value.
  const log = stderr.join("");
  assert.match(log, /SERVER_SECRETS_MISSING/u);
  assert.ok(log.includes(SEERFAR_SECRET_SETTING), log);
});

test("a secret filled in the server's settings is not reported missing and its value never reaches the log", async t => {
  const value = "synthetic-seerfar-value-not-for-logs";
  const { call, stderr } = await startCentralService(t, { [SEERFAR_SECRET_SETTING]: value });
  assert.equal((await call("/api/live")).status, 200);
  const log = stderr.join("");
  assert.equal(log.includes("SERVER_SECRETS_MISSING"), false, log);
  assert.equal(log.includes(value), false);
});

test("a central service refuses to start with the Ozon evidence service on an internet address", async () => {
  const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith("SELECTION_REVIEW_")) delete environment[key];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: { ...environment, PORT: String(port), SELECTION_REVIEW_RUNTIME_MODE: "central_test", SELECTION_REVIEW_BIND_HOST: "0.0.0.0",
      SELECTION_REVIEW_STATE_ADAPTER: "postgres", SELECTION_REVIEW_DATABASE_URL: DATABASE_URL,
      SELECTION_REVIEW_IDENTITY_PROVIDER: "team_accounts", SELECTION_REVIEW_DEFAULT_USER_ID: "central-test",
      SELECTION_REVIEW_PUBLIC_ORIGIN: PUBLIC_ORIGIN, SELECTION_REVIEW_AI_GATEWAY_URL: "http://ai-gateway:10000",
      SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: "https://ozon-evidence.example.test",
      SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(tmpdir(), "central-boot-unused", "c2"),
      SELECTION_REVIEW_PRODUCT_IMAGES_DIR: path.join(tmpdir(), "central-boot-unused", "images") },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /不能开在公网上/u);
});
