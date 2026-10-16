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
import { PAGE_WORKSTATION_HEADER } from "../lib/capture-assignment.mjs";
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
// Each computer loads the plugin with its own id, so their origins differ.
const EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_EXTENSION_ORIGIN = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

// The A card's "confirm" for a product not read yet: it asks for one 1688 read first.
const confirmSupply = (productId, revision) => ({ dataRevision: revision, sourceCandidateId: productId, sourceDataRevision: revision,
  targetPlatform: "ozon", storeRef: structuredClone(SYNTHETIC_STORE_REF), decision: "confirm", salesReview: {},
  supplierConfirmation: { productUrl: "https://qr.1688.com/s/7OnLCakq", ownerSupplyConfirmed: false } });

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

// One service process with team accounts over its own schema, seeded with these products; the calls a page and a plugin make.
async function startTeamService(t, candidates) {
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
  await writeFile(seed, JSON.stringify({ ...initialBusinessStateDocument(), candidates }));
  const businessStore = createPostgresBusinessStateStore({ connectionString });
  try {
    assert.equal((await importBusinessStateToPostgres({ sourceFile: seed, store: businessStore, write: true })).status, "imported");
  } finally { await businessStore.close(); }

  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: path.join(directory, "unused.json"),
      SELECTION_REVIEW_STATE_ADAPTER: "postgres", SELECTION_REVIEW_DATABASE_URL: connectionString, SELECTION_REVIEW_INITIALIZE_DATA_FILE: "1",
      // No plugin id is configured: under team accounts the computer's key says which computer a plugin call is from.
      SELECTION_REVIEW_IDENTITY_PROVIDER: "team_accounts", SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
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
  // A plugin call from one computer: that computer's plugin origin, and its key when it has one.
  const plugin = (route, body, key = null, origin = EXTENSION_ORIGIN) => call(route, { body,
    headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  const heartbeat = (key, origin) => plugin("/api/extension/heartbeat", { version: "1.6.0", backgroundReady: true, observedAt: new Date().toISOString() },
    key, origin);

  return { base, admin, schema, connectionString, stderr, call, login, plugin, heartbeat };
}

test("with team accounts a plugin call needs its computer's key, and a job claimed by one computer is finished only by it", async t => {
  const { base, admin, schema, connectionString, stderr, call, login, plugin, heartbeat } = await startTeamService(t, [unreadProduct("WS-1")]);
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
  // A key is no use from anything but a plugin: not from the page's own origin, nor from an origin Chrome would not write.
  for (const origin of [base, "chrome-extension://not-an-id", "https://evil.example"]) {
    const refused = await heartbeat(keyA, origin);
    assert.equal(refused.status, 403, origin);
  }
  listed = await call("/api/workstations", { cookie: boss });
  assert.deepEqual(listed.body.workstations.map(workstation => [workstation.name, workstation.online, workstation.extensionVersion]),
    [["老板甲的 MacBook", true, "1.6.0"], ["测试丙的电脑", false, null]]);

  // The boss confirms the product's supply on computer A: one 1688 read is queued for A. A claims it; only A can hand it back.
  const queued = await call("/api/candidates/WS-1/lifecycle/a-confirm", { cookie: boss, body: confirmSupply("WS-1", 1),
    headers: { [PAGE_WORKSTATION_HEADER]: computerA } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const jobId = queued.body.captureJob.jobId;
  assert.equal((await plugin(`/api/extension/capture-jobs/${jobId}/claim`, { version: "1.6.0" })).status, 401, "no key, no claim");
  const claimed = await plugin(`/api/extension/capture-jobs/${jobId}/claim`, { version: "1.6.0" }, keyA);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const job = claimed.body.captureJob;
  const failedRead = { captureId: job.captureId, token: job.token, dataRevision: job.dataRevision, status: "failed",
    failureCode: "site_login_required", observedAt: new Date().toISOString() };
  const fromB = await plugin("/api/candidates/WS-1/source-capture/result", failedRead, keyB, OTHER_EXTENSION_ORIGIN);
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
  assert.equal((await heartbeat(keyB, OTHER_EXTENSION_ORIGIN)).status, 200);
  assert.equal((await call("/api/workstations/remove", { cookie: boss, body: { workstationId: computerA } })).status, 404);
  assert.deepEqual((await call("/api/workstations", { cookie: boss })).body.workstations.map(workstation => workstation.workstationId), [computerB]);
  assert.equal(stderr.join("").includes(connectionString), false);
  assert.equal(stderr.join("").includes(keyA) || stderr.join("").includes(keyB), false);
});

test("with team accounts each computer runs its own job at the same time; a product and a computer each hold one job", async t => {
  const { call, login, plugin, heartbeat } = await startTeamService(t, [unreadProduct("WS-1"), unreadProduct("WS-2")]);
  const boss = await login("boss-a");
  const tester = await login("tester");
  const add = async (cookie, name) => (await call("/api/workstations/add", { cookie, body: { name } })).body;
  const [a, b, c] = [await add(boss, "老板甲的 MacBook"), await add(tester, "测试丙的电脑"), await add(boss, "老板乙的电脑")];
  const [computerA, computerB, computerC] = [a, b, c].map(added => added.workstation.workstationId);
  assert.equal((await heartbeat(a.key)).status, 200);
  assert.equal((await heartbeat(b.key, OTHER_EXTENSION_ORIGIN)).status, 200);
  const from = computer => (computer ? { [PAGE_WORKSTATION_HEADER]: computer } : {});
  const confirm = (cookie, productId, revision, computer) => call(`/api/candidates/${productId}/lifecycle/a-confirm`,
    { cookie, body: confirmSupply(productId, revision), headers: from(computer) });
  const product = async productId => (await call("/api/state", { cookie: boss })).body.candidates.find(item => item.id === productId);

  // A page that has not said which computer it is on, or names one whose plugin is not online, starts nothing.
  const unnamed = await confirm(boss, "WS-1", 1, null);
  assert.deepEqual([unnamed.status, unnamed.body.code], [409, "workstation_not_added"], JSON.stringify(unnamed.body));
  const offline = await confirm(boss, "WS-1", 1, computerC);
  assert.deepEqual([offline.status, offline.body.code], [409, "workstation_offline"], JSON.stringify(offline.body));
  assert.equal((await product("WS-1")).sourceCapture ?? null, null, "nothing was queued or written");

  // A and B each start a read on their own product; both are open at once.
  const onA = await confirm(boss, "WS-1", 1, computerA);
  assert.equal(onA.status, 202, JSON.stringify(onA.body));
  const busyA = await confirm(boss, "WS-2", 1, computerA);
  assert.deepEqual([busyA.status, busyA.body.code], [409, "workstation_busy"], JSON.stringify(busyA.body));
  assert.match(busyA.body.message, /这台电脑的插件正在采集 WS-1/u);
  const onB = await confirm(tester, "WS-2", 1, computerB);
  assert.equal(onB.status, 202, JSON.stringify(onB.body));
  // B asking for the product A already has is told whose it is, not handed A's job.
  const taken = await confirm(tester, "WS-1", 2, computerB);
  assert.deepEqual([taken.status, taken.body.code], [409, "capture_candidate_busy"], JSON.stringify(taken.body));
  assert.match(taken.body.message, /「老板甲的 MacBook」采集/u);

  // Each page sees its own computer's job; the other computer's product is listed with its name.
  const pageA = (await call("/api/state", { cookie: boss, headers: from(computerA) })).body.captureControl;
  assert.deepEqual([pageA.status, pageA.scope, pageA.candidateId], ["busy", "this_computer", "WS-1"]);
  assert.deepEqual(pageA.elsewhere, [{ candidateId: "WS-2", platform: "1688", captureKind: "supplier", computer: "测试丙的电脑" }]);
  const pageB = (await call("/api/state", { cookie: tester, headers: from(computerB) })).body.captureControl;
  assert.deepEqual([pageB.status, pageB.candidateId], ["busy", "WS-2"]);

  // A job is claimed only by the computer it is for.
  const [jobA, jobB] = [onA.body.captureJob.jobId, onB.body.captureJob.jobId];
  const wrong = await plugin(`/api/extension/capture-jobs/${jobA}/claim`, { version: "1.6.0" }, b.key, OTHER_EXTENSION_ORIGIN);
  assert.deepEqual([wrong.status, wrong.body.code], [409, "capture_job_for_other_computer"], JSON.stringify(wrong.body));
  const claimedA = await plugin(`/api/extension/capture-jobs/${jobA}/claim`, { version: "1.6.0" }, a.key);
  assert.equal(claimedA.status, 200, JSON.stringify(claimedA.body));
  const claimedB = await plugin(`/api/extension/capture-jobs/${jobB}/claim`, { version: "1.6.0" }, b.key, OTHER_EXTENSION_ORIGIN);
  assert.equal(claimedB.status, 200, JSON.stringify(claimedB.body));
  assert.equal((await product("WS-1")).sourceCapture.status, "capturing");
  assert.equal((await product("WS-2")).sourceCapture.status, "capturing");

  // A finishes; A is free again while B keeps going.
  const job = claimedA.body.captureJob;
  const done = await plugin("/api/candidates/WS-1/source-capture/result", { captureId: job.captureId, token: job.token,
    dataRevision: job.dataRevision, status: "failed", failureCode: "site_login_required", observedAt: new Date().toISOString() }, a.key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const freeA = (await call("/api/state", { cookie: boss, headers: from(computerA) })).body.captureControl;
  assert.deepEqual([freeA.status, freeA.elsewhere.map(item => item.candidateId)], ["idle", ["WS-2"]]);
  assert.equal((await call("/api/state", { cookie: tester, headers: from(computerB) })).body.captureControl.status, "busy");
});
