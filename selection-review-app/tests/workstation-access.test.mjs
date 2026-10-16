import assert from "node:assert/strict";
import test from "node:test";

import { createConfiguredWorkstationAccess, createWorkstationAccess, isWorkstationKey, MAX_ACTIVE_WORKSTATIONS,
  presentedWorkstationKey, workstationKeyDigest } from "../lib/workstation-access.mjs";
import { createMemoryWorkstationStore, isWorkstationId, normalizeWorkstationName } from "../lib/workstation-store.mjs";

// Synthetic computers and people only; nothing here reaches a network or a database.
const BOSS = { userId: "team-user:00000000-0000-4000-8000-000000000001" };
const TESTER = { userId: "team-user:00000000-0000-4000-8000-000000000003" };
const bearer = key => ({ headers: { authorization: `Bearer ${key}` } });

function fixture({ maxActive } = {}) {
  let at = Date.parse("2026-10-16T18:00:00.000Z");
  const clock = () => new Date(at).toISOString();
  const store = createMemoryWorkstationStore({ clock });
  const access = createWorkstationAccess({ store, clock, ...(maxActive ? { maxActive } : {}) });
  return { store, access, advance: ms => { at += ms; } };
}

test("adding a computer hands its key out once; the service keeps only the key's digest and shows no key in the list", async () => {
  const { store, access } = fixture();
  await access.initialize();
  const added = await access.add({ actor: BOSS, name: "  老板甲的 MacBook  " });
  assert.ok(isWorkstationKey(added.key));
  assert.ok(isWorkstationId(added.workstation.workstationId));
  assert.deepEqual(added.workstation, { workstationId: added.workstation.workstationId, name: "老板甲的 MacBook",
    addedAt: "2026-10-16T18:00:00.000Z", online: false, lastSeenAt: null, extensionVersion: null });
  const [kept] = await store.list();
  assert.equal(kept.keyDigest, workstationKeyDigest(added.key));
  assert.equal(kept.addedBy, BOSS.userId);
  assert.equal(JSON.stringify(kept).includes(added.key), false);
  const listed = await access.list();
  assert.deepEqual(listed, [added.workstation]);
  assert.equal(JSON.stringify(listed).includes(added.key), false);
  // A second computer gets a different key.
  const second = await access.add({ actor: TESTER, name: "测试丙的电脑" });
  assert.notEqual(second.key, added.key);
  assert.deepEqual((await access.list()).map(workstation => workstation.name), ["老板甲的 MacBook", "测试丙的电脑"]);
});

test("a plugin call counts only with an active computer's key; a removed computer's key stops at once", async () => {
  const { access } = fixture();
  const first = await access.add({ actor: BOSS, name: "老板甲的 MacBook" });
  const second = await access.add({ actor: TESTER, name: "测试丙的电脑" });
  assert.deepEqual(await access.authenticate(bearer(first.key)), { workstationId: first.workstation.workstationId, name: "老板甲的 MacBook" });
  assert.equal((await access.authenticate(bearer(second.key))).workstationId, second.workstation.workstationId);
  for (const request of [{ headers: {} }, { headers: { authorization: first.key } }, { headers: { authorization: `Basic ${first.key}` } },
    { headers: { authorization: "Bearer srw_short" } }, {}]) {
    await assert.rejects(access.authenticate(request), error => error.status === 401 && error.code === "WORKSTATION_KEY_REQUIRED");
  }
  const forged = `srw_${"A".repeat(43)}`;
  await assert.rejects(access.authenticate(bearer(forged)), error => error.status === 401 && error.code === "WORKSTATION_KEY_REJECTED");
  const removed = await access.remove({ workstationId: first.workstation.workstationId });
  assert.equal(removed.name, "老板甲的 MacBook");
  await assert.rejects(access.authenticate(bearer(first.key)), error => error.status === 401 && error.code === "WORKSTATION_KEY_REJECTED");
  assert.equal((await access.authenticate(bearer(second.key))).workstationId, second.workstation.workstationId);
  assert.deepEqual((await access.list()).map(workstation => workstation.name), ["测试丙的电脑"]);
  await assert.rejects(access.remove({ workstationId: first.workstation.workstationId }), error => error.status === 404);
  await assert.rejects(access.remove({ workstationId: "workstation:not-an-id" }), error => error.status === 400);
});

test("the list shows who is online from heartbeats kept in this process; they lapse after the heartbeat time", async () => {
  const { access, advance } = fixture();
  const added = await access.add({ actor: BOSS, name: "老板甲的 MacBook" });
  access.recordHeartbeat(added.workstation.workstationId, { version: "1.5.0" });
  let [shown] = await access.list();
  assert.deepEqual([shown.online, shown.lastSeenAt, shown.extensionVersion], [true, "2026-10-16T18:00:00.000Z", "1.5.0"]);
  advance(75_001);
  [shown] = await access.list();
  assert.deepEqual([shown.online, shown.lastSeenAt], [false, "2026-10-16T18:00:00.000Z"]);
  assert.throws(() => access.recordHeartbeat("workstation:not-an-id", { version: "1.5.0" }), /WORKSTATION_INPUT_INVALID/);
});

test("a computer needs a name of 1 to 40 characters, and at most the set number of computers are in use", async () => {
  const { access } = fixture({ maxActive: 2 });
  for (const name of ["", "   ", "x".repeat(41), "带\n换行", 7, null]) {
    await assert.rejects(access.add({ actor: BOSS, name }), error => error.status === 400 && error.code === "WORKSTATION_NAME_INVALID");
  }
  assert.equal(normalizeWorkstationName("😀".repeat(40)), "😀".repeat(40));
  await assert.rejects(access.add({ actor: {}, name: "老板甲的 MacBook" }), error => error.status === 401);
  const first = await access.add({ actor: BOSS, name: "一号" });
  await access.add({ actor: BOSS, name: "二号" });
  await assert.rejects(access.add({ actor: BOSS, name: "三号" }), error => error.status === 409 && error.code === "WORKSTATION_LIMIT_REACHED");
  await access.remove({ workstationId: first.workstation.workstationId });
  await access.add({ actor: BOSS, name: "三号" });
  assert.equal(MAX_ACTIVE_WORKSTATIONS, 20);
});

test("only the bearer form of a well-formed key is read, and the keys exist only with team accounts kept in Postgres", () => {
  const key = `srw_${"a".repeat(43)}`;
  assert.equal(presentedWorkstationKey(bearer(key)), key);
  assert.equal(presentedWorkstationKey({ headers: { authorization: `  Bearer ${key}  ` } }), key);
  for (const header of [`bearer ${key}`, `Bearer ${key} extra`, `Bearer srw_${"a".repeat(42)}`, `Bearer srw_${"a".repeat(43)}=`, undefined]) {
    assert.equal(presentedWorkstationKey({ headers: { authorization: header } }), null, String(header));
  }
  const store = createMemoryWorkstationStore();
  assert.equal(createConfiguredWorkstationAccess({ configuration: { identityProvider: "local_owner_password", stateAdapter: "json" }, store }), null);
  assert.equal(createConfiguredWorkstationAccess({ configuration: { identityProvider: "development_default", stateAdapter: "postgres" }, store }), null);
  assert.equal(createConfiguredWorkstationAccess({ configuration: { identityProvider: "team_accounts", stateAdapter: "postgres" }, store }).boundaryType,
    "workstation_access");
  assert.throws(() => createWorkstationAccess({ store: {} }), /WORKSTATION_STORE_REQUIRED/);
});
