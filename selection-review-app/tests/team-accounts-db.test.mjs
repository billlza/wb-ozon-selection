import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createPasswordVerifier, passwordMatches } from "../lib/scrypt-verifier.mjs";
import { createPostgresTeamAccountStore, TEAM_ACCOUNT_TABLE } from "../lib/team-account-store.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

// Runs against a real, disposable Postgres (CI starts one; see scripts/run-ci-database-tests.mjs, which also hands out the
// loopback port). Each test works in its own schema and drops it afterwards. Synthetic people and passwords only.
const DATABASE_URL = process.env.SELECTION_REVIEW_TEST_DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//u.test(DATABASE_URL ?? "")) {
  throw new Error("TEST_REQUIRES_DATABASE: set SELECTION_REVIEW_TEST_DATABASE_URL to a disposable Postgres");
}
const appDir = fileURLToPath(new URL("..", import.meta.url));

async function isolatedSchema(t) {
  const schema = `team_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const connectionString = `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  // A separate store stands for a separate process (the server, or the command line).
  const store = () => {
    const created = createPostgresTeamAccountStore({ connectionString });
    stores.push(created);
    return created;
  };
  return { schema, admin, connectionString, store };
}

const BOSS = { userId: "team-user:00000000-0000-4000-8000-000000000001", loginName: "boss-a", displayName: "老板甲", role: "boss" };
const TESTER = { userId: "team-user:00000000-0000-4000-8000-000000000003", loginName: "tester", displayName: "测试丙", role: "tester" };
const PASSWORDS = { "boss-a": "synthetic boss a 2026", tester: "synthetic tester 2026" };

test("accounts live in their own table: unique names, a verifier that reads back, changes only at the revision shown", async t => {
  const { schema, admin, store } = await isolatedSchema(t);
  const [first, second] = [store(), store()];
  // Two processes opening the table at once both go on.
  await Promise.all([first.ensureSchema(), second.ensureSchema()]);
  const verifier = await createPasswordVerifier(PASSWORDS["boss-a"]);
  const created = await first.create({ ...BOSS, loginName: "Boss-A", verifier });
  assert.deepEqual([created.loginName, created.status, created.credentialRevision], ["boss-a", "active", 1]);
  const read = await second.findByLoginName("BOSS-A");
  assert.deepEqual(read.verifier, verifier);
  assert.ok(await passwordMatches(PASSWORDS["boss-a"], read.verifier));
  await assert.rejects(second.create({ ...TESTER, loginName: "boss-a", verifier }), error => error.code === "TEAM_ACCOUNT_ALREADY_EXISTS");
  await assert.rejects(second.create({ ...BOSS, loginName: "boss-other", verifier }), error => error.code === "TEAM_ACCOUNT_ALREADY_EXISTS");
  await second.create({ ...TESTER, verifier: await createPasswordVerifier(PASSWORDS.tester) });
  assert.deepEqual((await first.list()).map(account => account.loginName), ["boss-a", "tester"]);

  const changed = await first.setPassword({ userId: BOSS.userId, verifier: await createPasswordVerifier("synthetic changed 2026"), expectedRevision: 1 });
  assert.equal(changed.credentialRevision, 2);
  await assert.rejects(second.setStatus({ userId: BOSS.userId, status: "disabled", expectedRevision: 1 }), error => error.code === "TEAM_ACCOUNT_CHANGED");
  const stored = await second.findByUserId(BOSS.userId);
  assert.deepEqual([stored.status, stored.credentialRevision], ["active", 2]);
  assert.ok(await passwordMatches("synthetic changed 2026", stored.verifier));
  assert.equal(await first.findByUserId("team-user:not-an-id"), null);
  const { rows } = await admin.query(`SELECT count(*)::int AS count FROM ${schema}.${TEAM_ACCOUNT_TABLE}`);
  assert.equal(rows[0].count, 2);
});

test("with team accounts the server shows nothing before sign-in, lets the tester only read, and changes passwords as decided", async t => {
  const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173, 4319].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
  const base = `http://127.0.0.1:${port}`;
  const { connectionString, store } = await isolatedSchema(t);
  const accounts = store();
  for (const account of [BOSS, TESTER]) await accounts.create({ ...account, verifier: await createPasswordVerifier(PASSWORDS[account.loginName]) });
  const directory = await mkdtemp(path.join(tmpdir(), "team-accounts-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: path.join(directory, "unused.json"),
      SELECTION_REVIEW_STATE_ADAPTER: "postgres", SELECTION_REVIEW_DATABASE_URL: connectionString, SELECTION_REVIEW_INITIALIZE_DATA_FILE: "1",
      SELECTION_REVIEW_IDENTITY_PROVIDER: "team_accounts", SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 20000);
    let output = "";
    const onData = chunk => { output += chunk; if (output.includes(`http://127.0.0.1:${port}`)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}: ${stderr.join("").slice(-2000)}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("exit", onExit);
  });

  const cookieOf = setCookie => setCookie.split(";", 1)[0];
  async function call(route, { cookie = null, body = undefined } = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}) };
    if (body !== undefined) Object.assign(headers, { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" });
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed, setCookie: response.headers.get("set-cookie") };
  }
  const login = async (loginName, password) => {
    const result = await call("/api/owner-access/login", { body: { loginName, password } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { ...result, cookie: cookieOf(result.setCookie) };
  };

  // Before signing in: the health check and the sign-in state, nothing else.
  assert.equal((await call("/api/live")).status, 200);
  assert.deepEqual((await call("/api/owner-access")).body, { providerType: "team_accounts", status: "login_required", user: null });
  for (const route of ["/api/state", "/api/stores", "/api/team-accounts", "/product-images/synthetic.png"]) {
    const result = await call(route);
    assert.equal(result.status, 401, route);
    assert.equal(result.body.code, "OWNER_LOGIN_REQUIRED", route);
  }
  assert.equal((await call("/api/owner-access/setup", { body: { password: "synthetic setup" } })).body.code, "TEAM_ACCOUNT_SETUP_DISABLED");
  const wrong = await call("/api/owner-access/login", { body: { loginName: "boss-a", password: "synthetic guess" } });
  assert.deepEqual([wrong.status, wrong.body.code, wrong.setCookie], [401, "TEAM_LOGIN_REJECTED", null]);
  assert.equal((await call("/api/owner-access/login", { body: { password: PASSWORDS["boss-a"] } })).status, 400);

  const boss = await login("Boss-A", PASSWORDS["boss-a"]);
  assert.deepEqual(boss.body, { providerType: "team_accounts", status: "authenticated", user: { userId: BOSS.userId, displayName: "老板甲", role: "boss" } });
  assert.match(boss.setCookie, /HttpOnly; SameSite=Strict/u);
  const bossState = await call("/api/state", { cookie: boss.cookie });
  assert.equal(bossState.status, 200);
  assert.deepEqual([bossState.body.runtimeArchitecture.currentUser.userId, bossState.body.runtimeArchitecture.currentUser.roles,
    bossState.body.runtimeArchitecture.currentUser.canAuthorizeProduction], [BOSS.userId, ["owner"], true]);
  assert.equal((await call("/product-images/synthetic.png", { cookie: boss.cookie })).status, 404);

  // The tester reads everything a boss reads, and for now writes nothing.
  let tester = await login("tester", PASSWORDS.tester);
  const testerState = await call("/api/state", { cookie: tester.cookie });
  assert.equal(testerState.status, 200);
  assert.deepEqual([testerState.body.runtimeArchitecture.currentUser.roles, testerState.body.runtimeArchitecture.currentUser.canAuthorizeProduction],
    [["operator"], false]);
  const write = await call("/api/node-comments", { cookie: tester.cookie, body: { text: "synthetic" } });
  assert.deepEqual([write.status, write.body.code], [403, "team_tester_read_only"]);
  assert.equal((await call("/api/team-accounts", { cookie: tester.cookie })).body.code, "TEAM_ACCOUNT_MANAGER_REQUIRED");

  // The tester changes their own password: this device stays signed in, the old session ends.
  const changed = await call("/api/owner-access/password", { cookie: tester.cookie,
    body: { currentPassword: PASSWORDS.tester, newPassword: "synthetic tester changed" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.user.role, "tester");
  assert.equal((await call("/api/state", { cookie: tester.cookie })).status, 401);
  tester = { cookie: cookieOf(changed.setCookie) };
  assert.equal((await call("/api/state", { cookie: tester.cookie })).status, 200);
  const short = await call("/api/owner-access/password", { cookie: tester.cookie, body: { currentPassword: "synthetic tester changed", newPassword: "short" } });
  assert.deepEqual([short.status, short.body.code], [400, "TEAM_PASSWORD_INPUT_INVALID"]);

  // A boss sees the accounts (never a verifier) and resets the tester's password; the tester is signed out everywhere.
  const listed = await call("/api/team-accounts", { cookie: boss.cookie });
  assert.deepEqual(listed.body.accounts.map(account => [account.loginName, account.role, account.status]), [["boss-a", "boss", "active"], ["tester", "tester", "active"]]);
  assert.equal(JSON.stringify(listed.body).includes("derivedKey"), false);
  const reset = await call("/api/team-accounts/reset-password", { cookie: boss.cookie, body: { userId: TESTER.userId, newPassword: "synthetic tester reset" } });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await call("/api/state", { cookie: tester.cookie })).status, 401);
  await login("tester", "synthetic tester reset");

  // Disabled from the command line (another process): the boss's next request is turned away.
  const current = await accounts.findByUserId(BOSS.userId);
  await accounts.setStatus({ userId: BOSS.userId, status: "disabled", expectedRevision: current.credentialRevision });
  assert.equal((await call("/api/state", { cookie: boss.cookie })).status, 401);

  const logout = await call("/api/owner-access/logout", { cookie: boss.cookie, body: {} });
  assert.deepEqual([logout.status, logout.body.status], [200, "login_required"]);
  assert.match(logout.setCookie, /Max-Age=0/u);
  assert.equal(stderr.join("").includes(connectionString), false);
});
