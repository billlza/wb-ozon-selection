import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalOwnerIdentityProvider, createPrivateOwnerCredentialRepository, OwnerIdentityError } from "../lib/local-owner-identity.mjs";
import { createPasswordVerifier, isPasswordVerifier, passwordMatches } from "../lib/scrypt-verifier.mjs";
import { createConfiguredIdentityProvider } from "../lib/runtime-identity-provider.mjs";
import { authorizeOperation, createActorContext, teamOperationRoles } from "../lib/runtime-identity.mjs";
import { createSelectionReviewRuntimeConfiguration } from "../lib/runtime-configuration.mjs";
import { runTeamAccountCommand, TeamAccountCommandError } from "../lib/team-account-admin.mjs";
import { createTeamAccountIdentityProvider, TEAM_ACCOUNT_ROLE_GRANTS } from "../lib/team-account-identity.mjs";
import { createMemoryTeamAccountStore, isTeamUserId, normalizeDisplayName, normalizeLoginName, publicTeamAccount,
  TeamAccountStoreError } from "../lib/team-account-store.mjs";

// Synthetic people and passwords only.
const BOSS = { userId: "team-user:00000000-0000-4000-8000-000000000001", loginName: "boss-a", displayName: "老板甲", role: "boss" };
const OTHER_BOSS = { userId: "team-user:00000000-0000-4000-8000-000000000002", loginName: "boss-b", displayName: "老板乙", role: "boss" };
const TESTER = { userId: "team-user:00000000-0000-4000-8000-000000000003", loginName: "tester", displayName: "测试丙", role: "tester" };
const PASSWORDS = { "boss-a": "synthetic boss a 2026", "boss-b": "synthetic boss b 2026", tester: "synthetic tester 2026" };

const requestWith = setCookie => ({ headers: setCookie ? { cookie: setCookie.split(";", 1)[0] } : {} });
const code = expected => error => error instanceof OwnerIdentityError && error.code === expected;

async function team({ accounts = [BOSS, OTHER_BOSS, TESTER], secureCookies = false } = {}) {
  let at = Date.parse("2026-10-16T08:00:00.000Z");
  const clock = () => new Date(at).toISOString();
  const store = createMemoryTeamAccountStore({ clock });
  for (const account of accounts) await store.create({ ...account, verifier: await createPasswordVerifier(PASSWORDS[account.loginName]) });
  const provider = createTeamAccountIdentityProvider({ accountStore: store, secureCookies, clock });
  await provider.initialize();
  // Each call is a new request, as the server sees it: the account behind the cookie is read once.
  async function as(setCookie) {
    const request = requestWith(setCookie);
    await provider.authenticateRequest(request);
    return request;
  }
  const login = account => provider.login({ loginName: account.loginName, password: PASSWORDS[account.loginName] });
  return { store, provider, as, login, advance: ms => { at += ms; } };
}

test("login names, display names and user ids are checked the same way everywhere", () => {
  assert.equal(normalizeLoginName("  Boss-A "), "boss-a");
  for (const value of ["a", "-boss", "boss a", "老板", "x".repeat(33), 7, null]) assert.equal(normalizeLoginName(value), null);
  assert.equal(normalizeDisplayName(" 老板甲 "), "老板甲");
  for (const value of ["", "   ", "x".repeat(41), "a\nb", null]) assert.equal(normalizeDisplayName(value), null);
  assert.ok(isTeamUserId(BOSS.userId));
  assert.ok(isTeamUserId("local-owner:00000000-0000-4000-8000-000000000009"));
  for (const value of ["team-user:1", "someone:00000000-0000-4000-8000-000000000001", "", null]) assert.equal(isTeamUserId(value), false);
});

test("the account store keeps one name per person, never shows the verifier, and changes only the revision it was shown", async () => {
  const store = createMemoryTeamAccountStore({ clock: () => "2026-10-16T08:00:00.000Z" });
  const verifier = await createPasswordVerifier(PASSWORDS["boss-a"]);
  assert.ok(isPasswordVerifier(verifier));
  assert.ok(await passwordMatches(PASSWORDS["boss-a"], verifier));
  assert.equal(await passwordMatches(PASSWORDS.tester, verifier), false);
  const created = await store.create({ ...BOSS, loginName: "Boss-A", verifier });
  assert.equal(created.loginName, "boss-a");
  assert.equal(created.status, "active");
  assert.equal(created.credentialRevision, 1);
  assert.deepEqual(Object.keys(publicTeamAccount(created)).sort(), ["createdAt", "displayName", "loginName", "role", "status", "updatedAt", "userId"]);
  await assert.rejects(store.create({ ...OTHER_BOSS, loginName: "BOSS-A", verifier }), error => error instanceof TeamAccountStoreError && error.code === "TEAM_ACCOUNT_ALREADY_EXISTS");
  await assert.rejects(store.create({ ...TESTER, role: "owner", verifier }), error => error.code === "TEAM_ACCOUNT_INPUT_INVALID");
  await assert.rejects(store.create({ ...TESTER, verifier: { ...verifier, cost: 2 } }), error => error.code === "TEAM_ACCOUNT_INPUT_INVALID");
  assert.equal((await store.findByLoginName(" BOSS-A ")).userId, BOSS.userId);
  const changed = await store.setPassword({ userId: BOSS.userId, verifier: await createPasswordVerifier("synthetic new password"), expectedRevision: 1 });
  assert.equal(changed.credentialRevision, 2);
  await assert.rejects(store.setStatus({ userId: BOSS.userId, status: "disabled", expectedRevision: 1 }), error => error.code === "TEAM_ACCOUNT_CHANGED");
  assert.equal((await store.findByUserId(BOSS.userId)).status, "active");
});

test("each person signs in with their own name and password; a boss acts as owner, the tester as operator", async () => {
  const { provider, as, login } = await team();
  assert.equal(provider.multiUserReady, true);
  const anonymous = await as(null);
  assert.deepEqual(provider.publicAccessState({ request: anonymous }), { providerType: "team_accounts", status: "login_required", user: null });
  assert.throws(() => provider.resolveActor({ request: anonymous }), code("OWNER_LOGIN_REQUIRED"));
  await assert.rejects(provider.setup({ password: "synthetic" }), code("TEAM_ACCOUNT_SETUP_DISABLED"));

  const boss = await login(BOSS);
  assert.match(boss.setCookie, /^selection_review_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/u);
  assert.deepEqual(boss.access, { providerType: "team_accounts", status: "authenticated", user: { userId: BOSS.userId, displayName: "老板甲", role: "boss" } });
  const bossRequest = await as(boss.setCookie);
  assert.deepEqual(provider.publicAccessState({ request: bossRequest }), boss.access);
  const bossActor = provider.resolveActor({ request: bossRequest });
  assert.deepEqual([bossActor.userId, bossActor.roles, bossActor.source, bossActor.actorType],
    [BOSS.userId, ["owner"], "authenticated_identity_provider", "human"]);

  const tester = await login(TESTER);
  const testerActor = provider.resolveActor({ request: await as(tester.setCookie) });
  assert.deepEqual([testerActor.userId, testerActor.roles], [TESTER.userId, ["operator"]]);
  assert.deepEqual(TEAM_ACCOUNT_ROLE_GRANTS, { boss: ["owner"], tester: ["operator"] });

  // Login names are not case sensitive; passwords are exact.
  assert.equal((await provider.login({ loginName: " BOSS-A ", password: PASSWORDS["boss-a"] })).access.user.userId, BOSS.userId);
  await assert.rejects(provider.login({ loginName: "boss-a", password: PASSWORDS["boss-a"].toUpperCase() }), code("TEAM_LOGIN_REJECTED"));
  await assert.rejects(provider.login({ loginName: "boss-a", password: PASSWORDS["boss-a"], roles: ["owner"] }), code("TEAM_LOGIN_INPUT_INVALID"));

  const logout = provider.logout({ request: await as(boss.setCookie) });
  assert.match(logout.setCookie, /^selection_review_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/u);
  assert.equal(provider.publicAccessState({ request: await as(boss.setCookie) }).status, "login_required");

  const secure = await team({ accounts: [BOSS], secureCookies: true });
  assert.match((await secure.login(BOSS)).setCookie, /; Secure$/u);
});

test("an unknown name, a wrong password and a disabled account get the same answer, and repeated failures are slowed down", async () => {
  const { store, provider, login } = await team({ accounts: [BOSS, TESTER] });
  const rejected = [];
  for (const input of [{ loginName: "nobody", password: "synthetic guess" }, { loginName: "boss-a", password: "synthetic guess" }]) {
    await assert.rejects(provider.login(input), error => { rejected.push([error.code, error.statusCode, error.message]); return true; });
  }
  const tester = await store.findByUserId(TESTER.userId);
  await store.setStatus({ userId: TESTER.userId, status: "disabled", expectedRevision: tester.credentialRevision });
  await assert.rejects(login(TESTER), error => { rejected.push([error.code, error.statusCode, error.message]); return true; });
  assert.deepEqual(rejected, Array(3).fill(["TEAM_LOGIN_REJECTED", 401, "登录名或密码不正确"]));
  // Five wrong passwords for one name: even the right one waits.
  for (let attempt = 1; attempt < 5; attempt += 1) await assert.rejects(provider.login({ loginName: "boss-a", password: "synthetic guess" }), code("TEAM_LOGIN_REJECTED"));
  await assert.rejects(login(BOSS), code("TEAM_LOGIN_RATE_LIMITED"));
});

test("the limit lifts after fifteen minutes, and a right password clears the count", async () => {
  const { provider, login, advance } = await team({ accounts: [BOSS] });
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(provider.login({ loginName: "boss-a", password: "synthetic guess" }), code("TEAM_LOGIN_REJECTED"));
  await assert.rejects(login(BOSS), code("TEAM_LOGIN_RATE_LIMITED"));
  advance(15 * 60 * 1000);
  assert.equal((await login(BOSS)).access.status, "authenticated");
  await assert.rejects(provider.login({ loginName: "boss-a", password: "synthetic guess" }), code("TEAM_LOGIN_REJECTED"));
  assert.equal((await login(BOSS)).access.status, "authenticated");
});

test("a session ends after thirty idle minutes or eight hours; writing keeps it awake", async () => {
  const { provider, as, login, advance } = await team({ accounts: [BOSS] });
  const idle = await login(BOSS);
  const busy = await login(BOSS);
  advance(29 * 60 * 1000);
  provider.resolveActor({ request: await as(busy.setCookie), touch: true });
  // Reading does not count as activity.
  provider.resolveActor({ request: await as(idle.setCookie) });
  advance(2 * 60 * 1000);
  assert.equal(provider.publicAccessState({ request: await as(idle.setCookie) }).status, "login_required");
  assert.equal(provider.publicAccessState({ request: await as(busy.setCookie) }).status, "authenticated");
  for (let minutes = 31; minutes < 8 * 60; minutes += 25) {
    provider.resolveActor({ request: await as(busy.setCookie), touch: true });
    advance(25 * 60 * 1000);
  }
  assert.equal(provider.publicAccessState({ request: await as(busy.setCookie) }).status, "login_required");
});

test("one account may be signed in on six devices at most", async () => {
  const { login } = await team({ accounts: [BOSS] });
  for (let device = 0; device < 6; device += 1) await login(BOSS);
  await assert.rejects(login(BOSS), code("TEAM_SESSION_CAPACITY"));
});

test("changing one's own password needs the current one, keeps this device signed in and signs out the others", async () => {
  const { provider, as, login } = await team({ accounts: [BOSS, TESTER] });
  const here = await login(TESTER);
  const elsewhere = await login(TESTER);
  const change = async (setCookie, input) => provider.changePassword({ request: await as(setCookie), input });
  await assert.rejects(change(here.setCookie, { currentPassword: "synthetic wrong", newPassword: "synthetic changed 2026" }), code("TEAM_CURRENT_PASSWORD_REJECTED"));
  await assert.rejects(change(here.setCookie, { currentPassword: PASSWORDS.tester, newPassword: "short" }), code("TEAM_PASSWORD_INPUT_INVALID"));
  await assert.rejects(change(here.setCookie, { currentPassword: PASSWORDS.tester }), code("TEAM_PASSWORD_INPUT_INVALID"));
  await assert.rejects(change(null, { currentPassword: PASSWORDS.tester, newPassword: "synthetic changed 2026" }), code("OWNER_LOGIN_REQUIRED"));
  const changed = await change(here.setCookie, { currentPassword: PASSWORDS.tester, newPassword: "synthetic changed 2026" });
  assert.deepEqual(changed.access.user, { userId: TESTER.userId, displayName: "测试丙", role: "tester" });
  assert.notEqual(changed.setCookie, here.setCookie);
  for (const old of [here, elsewhere]) assert.equal(provider.publicAccessState({ request: await as(old.setCookie) }).status, "login_required");
  assert.equal(provider.publicAccessState({ request: await as(changed.setCookie) }).status, "authenticated");
  await assert.rejects(login(TESTER), code("TEAM_LOGIN_REJECTED"));
  assert.equal((await provider.login({ loginName: "tester", password: "synthetic changed 2026" })).access.status, "authenticated");
});

test("a boss resets another account's password and its sessions end; the tester cannot, and nobody resets their own here", async () => {
  const { provider, as, login } = await team();
  const boss = await login(BOSS);
  const otherBoss = await login(OTHER_BOSS);
  const tester = await login(TESTER);
  const reset = async (setCookie, input) => provider.resetPassword({ request: await as(setCookie), input });
  await assert.rejects(reset(tester.setCookie, { userId: BOSS.userId, newPassword: "synthetic reset 2026" }), code("TEAM_ACCOUNT_MANAGER_REQUIRED"));
  await assert.rejects(reset(boss.setCookie, { userId: BOSS.userId, newPassword: "synthetic reset 2026" }), code("TEAM_PASSWORD_INPUT_INVALID"));
  await assert.rejects(reset(boss.setCookie, { userId: "team-user:00000000-0000-4000-8000-00000000000f", newPassword: "synthetic reset 2026" }), code("TEAM_ACCOUNT_NOT_FOUND"));
  await assert.rejects(reset(boss.setCookie, { userId: TESTER.userId, newPassword: "short" }), code("TEAM_PASSWORD_INPUT_INVALID"));

  const result = await reset(boss.setCookie, { userId: TESTER.userId, newPassword: "synthetic reset 2026" });
  assert.equal(result.account.userId, TESTER.userId);
  assert.equal(Object.hasOwn(result.account, "verifier"), false);
  assert.equal(provider.publicAccessState({ request: await as(tester.setCookie) }).status, "login_required");
  assert.equal((await provider.login({ loginName: "tester", password: "synthetic reset 2026" })).access.user.role, "tester");
  // Both bosses manage passwords the same way.
  await reset(otherBoss.setCookie, { userId: BOSS.userId, newPassword: "synthetic reset boss 2026" });
  assert.equal(provider.publicAccessState({ request: await as(boss.setCookie) }).status, "login_required");
  assert.equal(provider.publicAccessState({ request: await as(otherBoss.setCookie) }).status, "authenticated");

  const accounts = await provider.listAccounts({ request: await as(otherBoss.setCookie) });
  assert.deepEqual(accounts.map(account => [account.loginName, account.role]), [["boss-a", "boss"], ["boss-b", "boss"], ["tester", "tester"]]);
  assert.ok(accounts.every(account => !Object.hasOwn(account, "verifier")));
  const testerAgain = await provider.login({ loginName: "tester", password: "synthetic reset 2026" });
  await assert.rejects(provider.listAccounts({ request: await as(testerAgain.setCookie) }), code("TEAM_ACCOUNT_MANAGER_REQUIRED"));
});

test("disabling an account from the command line ends its sessions on the next request", async () => {
  const { store, provider, as, login } = await team({ accounts: [BOSS, TESTER] });
  const tester = await login(TESTER);
  const lines = [];
  await runTeamAccountCommand({ args: ["disable", "--login", "tester"], store, readPassword: async () => assert.fail("no password"), print: line => lines.push(line) });
  assert.equal(provider.publicAccessState({ request: await as(tester.setCookie) }).status, "login_required");
  await assert.rejects(login(TESTER), code("TEAM_LOGIN_REJECTED"));
  await runTeamAccountCommand({ args: ["enable", "--login", "tester"], store, readPassword: async () => assert.fail("no password"), print: line => lines.push(line) });
  assert.equal((await login(TESTER)).access.status, "authenticated");
  await runTeamAccountCommand({ args: ["enable", "--login", "tester"], store, readPassword: async () => assert.fail("no password"), print: line => lines.push(line) });
  assert.deepEqual(lines.map(line => typeof line === "string" ? line : line.updated.status), ["disabled", "active", "tester 本来就是可用的，没有改"]);
});

test("the command line adds accounts with a typed password and prints no password or verifier", async () => {
  const store = createMemoryTeamAccountStore();
  const printed = [];
  const typed = values => { const queue = [...values]; return async () => queue.shift(); };
  const run = (args, passwords = []) => runTeamAccountCommand({ args, store, readPassword: typed(passwords), print: value => printed.push(value) });
  await run(["add", "--login", "Boss-A", "--name", "老板甲", "--role", "boss"], [PASSWORDS["boss-a"], PASSWORDS["boss-a"]]);
  // Piped in, there is no second line to compare.
  await run(["add", "--login", "tester", "--name", "测试丙", "--role", "tester"], [PASSWORDS.tester, null]);
  const refused = async (args, passwords, pattern) => {
    await assert.rejects(run(args, passwords), error => error instanceof TeamAccountCommandError && pattern.test(error.message));
  };
  await refused(["add", "--login", "boss-a", "--name", "重名", "--role", "boss"], [], /已经有人用了/u);
  await refused(["add", "--login", "boss-b", "--name", "老板乙", "--role", "owner"], [], /boss（老板）或 tester（测试）/u);
  await refused(["add", "--login", "boss-b", "--name", "老板乙", "--role", "boss"], ["short", "short"], /至少8个字符/u);
  await refused(["add", "--login", "boss-b", "--name", "老板乙", "--role", "boss"], ["synthetic boss b 2026", "synthetic other"], /不一样/u);
  await refused(["add", "--login", "boss-b", "--name", "老板乙"], [], /参数不全/u);
  await refused(["add", "--login", "boss-b", "--name", "老板乙", "--role", "boss", "--password", "x"], [], /参数不对/u);
  await refused(["remove", "--login", "boss-a"], [], /没有这个命令/u);
  await refused(["reset-password", "--login", "nobody"], [], /没有这个登录名/u);
  assert.equal((await store.findByLoginName("boss-b")), null);

  await run(["reset-password", "--login", "tester"], ["synthetic tester changed", "synthetic tester changed"]);
  const tester = await store.findByLoginName("tester");
  assert.equal(tester.credentialRevision, 2);
  assert.ok(await passwordMatches("synthetic tester changed", tester.verifier));
  await run(["list"]);
  const listed = printed.at(-1).accounts;
  assert.deepEqual(listed.map(account => [account.loginName, account.displayName, account.role, account.status]),
    [["boss-a", "老板甲", "boss", "active"], ["tester", "测试丙", "tester", "active"]]);
  assert.ok(listed.every(account => /^team-user:/u.test(account.userId)));
  const output = JSON.stringify(printed);
  for (const secret of [PASSWORDS["boss-a"], PASSWORDS.tester, "synthetic tester changed", "derivedKey", "salt"]) assert.equal(output.includes(secret), false);
});

test("the owner's account on the Mac is imported once, keeping their user id and the password they already use", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "team-import-owner-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "private", "owner.json");
  const owner = createLocalOwnerIdentityProvider({ credentialRepository: createPrivateOwnerCredentialRepository({ filePath }) });
  await owner.initialize();
  // The local owner password may be as short as four characters; it is kept as it is.
  const local = await owner.setup({ password: "四个字符" });
  const store = createMemoryTeamAccountStore();
  const printed = [];
  const run = args => runTeamAccountCommand({ args, store, readPassword: async () => assert.fail("no password is typed"), print: value => printed.push(value) });
  await assert.rejects(run(["import-owner", "--from", "private/owner.json", "--login", "owner", "--name", "老板甲"]), /绝对路径/u);
  await assert.rejects(run(["import-owner", "--from", path.join(directory, "missing", "owner.json"), "--login", "owner", "--name", "老板甲"]), /没有主人密码文件/u);
  await run(["import-owner", "--from", filePath, "--login", "owner", "--name", "老板甲"]);
  assert.deepEqual([printed[0].imported.userId, printed[0].imported.role, printed[0].imported.loginName], [local.actor.userId, "boss", "owner"]);
  await assert.rejects(run(["import-owner", "--from", filePath, "--login", "owner-2", "--name", "老板甲"]), /已经导入过了/u);
  const provider = createTeamAccountIdentityProvider({ accountStore: store });
  await provider.initialize();
  const signedIn = await provider.login({ loginName: "owner", password: "四个字符" });
  assert.deepEqual(signedIn.access.user, { userId: local.actor.userId, displayName: "老板甲", role: "boss" });
  assert.equal(JSON.stringify(printed).includes("derivedKey"), false);
});

test("team sign-in needs the Postgres store and follows the public address for secure cookies", async () => {
  const base = { SELECTION_REVIEW_IDENTITY_PROVIDER: "team_accounts" };
  for (const adapter of [undefined, "json", "memory"]) {
    assert.throws(() => createSelectionReviewRuntimeConfiguration({ env: { ...base, ...(adapter ? { SELECTION_REVIEW_STATE_ADAPTER: adapter } : {}) },
      appDir: os.tmpdir(), argv: [] }), /团队账号登录必须使用 Postgres 存储/u);
  }
  const configuration = createSelectionReviewRuntimeConfiguration({ env: { ...base, SELECTION_REVIEW_STATE_ADAPTER: "postgres" }, appDir: os.tmpdir(), argv: [] });
  assert.equal(configuration.identityProvider, "team_accounts");
  const accountStore = createMemoryTeamAccountStore();
  await accountStore.create({ ...BOSS, verifier: await createPasswordVerifier(PASSWORDS["boss-a"]) });
  const local = createConfiguredIdentityProvider({ configuration, accountStore });
  assert.equal(local.providerType, "team_accounts");
  await local.initialize();
  assert.doesNotMatch((await local.login({ loginName: "boss-a", password: PASSWORDS["boss-a"] })).setCookie, /Secure/u);
  const secure = createConfiguredIdentityProvider({ configuration: { ...configuration, publicOrigin: "https://review.example" }, accountStore });
  await secure.initialize();
  assert.match((await secure.login({ loginName: "boss-a", password: PASSWORDS["boss-a"] })).setCookie, /; Secure$/u);
  // Without a store of its own it opens the database named in the environment, and only that.
  assert.throws(() => createConfiguredIdentityProvider({ configuration, env: {} }), error => error instanceof TeamAccountStoreError && error.code === "TEAM_ACCOUNT_DATABASE_URL_REQUIRED");
});

test("the tester's signed-in account works with the operator role; software, workers and unsigned people with it stay refused", () => {
  const actor = (actorType, roles, source = "authenticated_identity_provider") => createActorContext({ userId: `${actorType}:synthetic`,
    sessionId: "session:synthetic", actorType, roles, source, authenticatedAt: "2026-10-16T08:00:00.000Z" });
  const allowed = value => { try { authorizeOperation({ actor: value, requiredRoles: teamOperationRoles(value) }); return true; } catch { return false; } };
  assert.deepEqual(TEAM_ACCOUNT_ROLE_GRANTS, { boss: ["owner"], tester: ["operator"] });
  assert.deepEqual(teamOperationRoles(actor("human", ["operator"])), ["owner", "operator"]);
  assert.equal(allowed(actor("human", ["owner"])), true);
  assert.equal(allowed(actor("human", ["operator"])), true);
  assert.equal(allowed(actor("human", ["reviewer"])), false);
  assert.equal(allowed(actor("human", ["operator"], "development_default")), false);
  assert.equal(allowed(actor("software", ["operator"], "selection_review_state_machine")), false);
  assert.equal(allowed(actor("worker", ["operator"], "registered_runtime_worker")), false);
});
