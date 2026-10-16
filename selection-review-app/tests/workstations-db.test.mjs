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
import { createPasswordVerifier } from "../lib/scrypt-verifier.mjs";
import { createPostgresBusinessStateStore } from "../lib/postgres-business-state-store.mjs";
import { createPostgresTeamAccountStore } from "../lib/team-account-store.mjs";
import { workstationKeyDigest } from "../lib/workstation-access.mjs";
import { createPostgresWorkstationStore, WORKSTATION_TABLE } from "../lib/workstation-store.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

// Runs against a real, disposable Postgres (scripts/run-ci-database-tests.mjs). Each test works in its own schema and drops
// it afterwards. Synthetic people, computers and keys only.
const DATABASE_URL = process.env.SELECTION_REVIEW_TEST_DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//u.test(DATABASE_URL ?? "")) {
  throw new Error("TEST_REQUIRES_DATABASE: set SELECTION_REVIEW_TEST_DATABASE_URL to a disposable Postgres");
}
const appDir = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function isolatedSchema(t) {
  const schema = `workstation_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const connectionString = `${DATABASE_URL}${DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  // A separate store stands for a separate process.
  const workstations = () => {
    const created = createPostgresWorkstationStore({ connectionString });
    closers.push(() => created.close());
    return created;
  };
  return { schema, admin, connectionString, workstations, closers };
}

const digest = letter => workstationKeyDigest(`srw_${letter.repeat(43)}`);
const id = n => `workstation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("computers live in their own table: a digest per key, a cap on how many, and removal that ends the key", async t => {
  const { schema, admin, workstations } = await isolatedSchema(t);
  const [first, second] = [workstations(), workstations()];
  await Promise.all([first.ensureSchema(), second.ensureSchema()]);
  const added = await first.create({ workstationId: id(1), name: " 老板甲的 MacBook ", keyDigest: digest("a"), addedBy: "team-user:boss" }, { maxActive: 2 });
  assert.deepEqual([added.name, added.status, added.addedBy], ["老板甲的 MacBook", "active", "team-user:boss"]);
  assert.equal((await second.findActiveByKeyDigest(digest("a"))).workstationId, id(1));
  assert.equal(await second.findActiveByKeyDigest(digest("b")), null);
  assert.equal(await second.findActiveByKeyDigest("not-a-digest"), null);
  await assert.rejects(second.create({ workstationId: id(1), name: "重复", keyDigest: digest("c"), addedBy: "team-user:boss" }, { maxActive: 2 }),
    error => error.code === "WORKSTATION_ALREADY_EXISTS");
  await assert.rejects(second.create({ workstationId: id(2), name: "同一把钥匙", keyDigest: digest("a"), addedBy: "team-user:boss" }, { maxActive: 2 }),
    error => error.code === "WORKSTATION_ALREADY_EXISTS");
  await second.create({ workstationId: id(2), name: "测试丙的电脑", keyDigest: digest("b"), addedBy: "team-user:tester" }, { maxActive: 2 });
  await assert.rejects(first.create({ workstationId: id(3), name: "第三台", keyDigest: digest("c"), addedBy: "team-user:boss" }, { maxActive: 2 }),
    error => error.code === "WORKSTATION_LIMIT_REACHED");
  assert.deepEqual((await first.list()).map(workstation => workstation.name), ["老板甲的 MacBook", "测试丙的电脑"]);

  const removed = await second.remove(id(1));
  assert.equal(removed.status, "removed");
  assert.equal(await first.findActiveByKeyDigest(digest("a")), null);
  await assert.rejects(first.remove(id(1)), error => error.code === "WORKSTATION_NOT_FOUND");
  assert.deepEqual((await first.list()).map(workstation => workstation.workstationId), [id(2)]);
  // Room again after a removal; the removed row stays, so its id is never given out again.
  await first.create({ workstationId: id(3), name: "第三台", keyDigest: digest("c"), addedBy: "team-user:boss" }, { maxActive: 2 });
  const { rows } = await admin.query(`SELECT workstation_id, status FROM ${schema}.${WORKSTATION_TABLE} ORDER BY workstation_id`);
  assert.deepEqual(rows.map(row => [row.workstation_id, row.status]), [[id(1), "removed"], [id(2), "active"], [id(3), "active"]]);
});

const BOSS = { userId: "team-user:00000000-0000-4000-8000-000000000001", loginName: "boss-a", displayName: "老板甲", role: "boss" };
const TESTER = { userId: "team-user:00000000-0000-4000-8000-000000000003", loginName: "tester", displayName: "测试丙", role: "tester" };
const PASSWORDS = { "boss-a": "synthetic boss a 2026", tester: "synthetic tester 2026" };

// A product whose supply has not been read yet: confirming it queues one 1688 read for a plugin to claim.
function unreadProduct(productId) {
  return { id: productId, source: "user", group: "userAdded", targetStore: "dandanshu", targetPlatform: "ozon",
    storeRef: structuredClone(SYNTHETIC_STORE_REF), productName: `测试音乐盒 ${productId}`,
    productUrl: "https://www.ozon.ru/product/test-4403916892/", sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    purchasePriceRmb: 17.3, packedWeightKg: 0.4, dimensionsCm: { length: 12, width: 12, height: 7 }, workflowStatus: "codex_processing",
    dataRevision: 1, processing: { state: "idle", manualHold: true },
    lifecycleV11: { schemaVersion: "product-lifecycle-v1.1", status: "opportunity_sales_snapshot_captured",
      opportunityPackage: { schemaVersion: "product-lifecycle-v1.1", entityType: "OpportunityPackage" }, platformWrites: 0 },
    comments: [], history: [], createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" };
}

test("with team accounts a plugin call needs its computer's key, and a job claimed by one computer is finished only by it", async t => {
  const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173, 4319].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
  const base = `http://127.0.0.1:${port}`;
  const { schema, admin, connectionString, closers } = await isolatedSchema(t);
  const accounts = createPostgresTeamAccountStore({ connectionString });
  closers.push(() => accounts.close());
  for (const account of [BOSS, TESTER]) await accounts.create({ ...account, verifier: await createPasswordVerifier(PASSWORDS[account.loginName]) });
  const directory = await mkdtemp(path.join(tmpdir(), "workstations-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = path.join(directory, "seed.json");
  await writeFile(seed, JSON.stringify({ ...initialBusinessStateDocument(), candidates: [unreadProduct("WS-1")] }));
  const businessStore = createPostgresBusinessStateStore({ connectionString });
  try {
    assert.equal((await importBusinessStateToPostgres({ sourceFile: seed, store: businessStore, write: true })).status, "imported");
  } finally { await businessStore.close(); }

  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: path.join(directory, "unused.json"),
      SELECTION_REVIEW_STATE_ADAPTER: "postgres", SELECTION_REVIEW_DATABASE_URL: connectionString, SELECTION_REVIEW_INITIALIZE_DATA_FILE: "1",
      SELECTION_REVIEW_IDENTITY_PROVIDER: "team_accounts", SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: EXTENSION_ORIGIN,
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: "dandanshu", platform: "ozon", storeRef: SYNTHETIC_STORE_REF }]),
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

  async function call(route, { cookie = null, body = undefined, headers = {} } = {}) {
    const sent = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
    if (body !== undefined) Object.assign(sent, { "Content-Type": "application/json" }, cookie ? { Origin: base, "Sec-Fetch-Site": "same-origin" } : {});
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: sent,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  }
  const login = async (loginName) => {
    const result = await call("/api/owner-access/login", { body: { loginName, password: PASSWORDS[loginName] }, headers: { Origin: base, "Sec-Fetch-Site": "same-origin" } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.headers.get("set-cookie").split(";", 1)[0];
  };
  // A plugin call from one computer: the plugin's origin, and that computer's key when it has one.
  const plugin = (route, body, key = null) => call(route, { body, headers: { Origin: EXTENSION_ORIGIN, ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  const heartbeat = key => plugin("/api/extension/heartbeat", { version: "1.5.0", backgroundReady: true, observedAt: new Date().toISOString() }, key);

  // Nobody signed in sees or adds a computer.
  assert.equal((await call("/api/workstations")).status, 401);
  assert.equal((await call("/api/workstations/add", { body: { name: "外人的电脑" }, headers: { Origin: base, "Sec-Fetch-Site": "same-origin" } })).status, 401);
  const boss = await login("boss-a");
  const tester = await login("tester");
  assert.deepEqual((await call("/api/workstations", { cookie: boss })).body, { workstations: [], maxActive: 20 });
  for (const body of [{}, { name: "" }, { name: "一号", extra: true }, { name: 7 }]) {
    assert.equal((await call("/api/workstations/add", { cookie: boss, body })).status, 400, JSON.stringify(body));
  }
  // The page's own origin only: another site cannot add a computer with the boss's cookie.
  const crossSite = await call("/api/workstations/add", { body: { name: "别处" }, headers: { Cookie: boss, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
  assert.equal(crossSite.status, 403);

  // Each signed-in person adds the computer they sit at; the key comes back once.
  const addedA = await call("/api/workstations/add", { cookie: boss, body: { name: "老板甲的 MacBook" } });
  assert.equal(addedA.status, 201, JSON.stringify(addedA.body));
  assert.equal(addedA.headers.get("cache-control"), "no-store");
  const addedB = await call("/api/workstations/add", { cookie: tester, body: { name: "测试丙的电脑" } });
  assert.equal(addedB.status, 201, JSON.stringify(addedB.body));
  const [keyA, keyB] = [addedA.body.key, addedB.body.key];
  const [computerA, computerB] = [addedA.body.workstation.workstationId, addedB.body.workstation.workstationId];
  let listed = await call("/api/workstations", { cookie: tester });
  assert.deepEqual(listed.body.workstations.map(workstation => [workstation.name, workstation.online]), [["老板甲的 MacBook", false], ["测试丙的电脑", false]]);
  assert.equal(JSON.stringify(listed.body).includes(keyA) || JSON.stringify(listed.body).includes(keyB), false);
  const { rows } = await admin.query(`SELECT * FROM ${schema}.${WORKSTATION_TABLE}`);
  assert.equal(JSON.stringify(rows).includes(keyA) || JSON.stringify(rows).includes(keyB), false, "only digests are kept");

  // The plugin's preflight may carry the key; a heartbeat counts only with one, and marks that computer online.
  const preflight = await fetch(`${base}/api/extension/heartbeat`, { method: "OPTIONS", headers: { Origin: EXTENSION_ORIGIN } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/u);
  for (const [key, code] of [[null, "WORKSTATION_KEY_REQUIRED"], [`srw_${"z".repeat(43)}`, "WORKSTATION_KEY_REJECTED"]]) {
    const refused = await heartbeat(key);
    assert.deepEqual([refused.status, refused.body.code], [401, code]);
    assert.equal(refused.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN, "the plugin can read why it was refused");
  }
  assert.equal((await heartbeat(keyA)).status, 200);
  listed = await call("/api/workstations", { cookie: boss });
  assert.deepEqual(listed.body.workstations.map(workstation => [workstation.name, workstation.online, workstation.extensionVersion]),
    [["老板甲的 MacBook", true, "1.5.0"], ["测试丙的电脑", false, null]]);

  // The boss confirms the product's supply: one 1688 read is queued. Computer A claims it; only A can hand it back.
  const queued = await call("/api/candidates/WS-1/lifecycle/a-confirm", { cookie: boss, body: { dataRevision: 1, sourceCandidateId: "WS-1",
    sourceDataRevision: 1, targetPlatform: "ozon", storeRef: structuredClone(SYNTHETIC_STORE_REF), decision: "confirm", salesReview: {},
    supplierConfirmation: { productUrl: "https://qr.1688.com/s/7OnLCakq", ownerSupplyConfirmed: false } } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const jobId = queued.body.captureJob.jobId;
  assert.equal((await plugin(`/api/extension/capture-jobs/${jobId}/claim`, { version: "1.5.0" })).status, 401, "no key, no claim");
  const claimed = await plugin(`/api/extension/capture-jobs/${jobId}/claim`, { version: "1.5.0" }, keyA);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const job = claimed.body.captureJob;
  const failedRead = { captureId: job.captureId, token: job.token, dataRevision: job.dataRevision, status: "failed",
    failureCode: "site_login_required", observedAt: new Date().toISOString() };
  const fromB = await plugin("/api/candidates/WS-1/source-capture/result", failedRead, keyB);
  assert.deepEqual([fromB.status, fromB.body.code], [409, "capture_extension_origin_mismatch"], JSON.stringify(fromB.body));
  assert.equal((await call("/api/state", { cookie: boss })).body.candidates.find(item => item.id === "WS-1").sourceCapture.status, "capturing",
    "the other computer's answer changed nothing");
  const fromA = await plugin("/api/candidates/WS-1/source-capture/result", failedRead, keyA);
  assert.equal(fromA.status, 200, JSON.stringify(fromA.body));
  assert.equal(fromA.body.candidate.sourceCapture.status, "failed");

  // Removed (here by the tester): its key stops at once; the other computer goes on.
  const removed = await call("/api/workstations/remove", { cookie: tester, body: { workstationId: computerA } });
  assert.deepEqual([removed.status, removed.body.workstation.name], [200, "老板甲的 MacBook"]);
  assert.deepEqual([(await heartbeat(keyA)).status, (await heartbeat(keyA)).body.code], [401, "WORKSTATION_KEY_REJECTED"]);
  assert.equal((await heartbeat(keyB)).status, 200);
  assert.equal((await call("/api/workstations/remove", { cookie: boss, body: { workstationId: computerA } })).status, 404);
  assert.deepEqual((await call("/api/workstations", { cookie: boss })).body.workstations.map(workstation => workstation.workstationId), [computerB]);
  assert.equal(stderr.join("").includes(connectionString), false);
  assert.equal(stderr.join("").includes(keyA) || stderr.join("").includes(keyB), false);
});
