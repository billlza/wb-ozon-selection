import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "../src/api.js";
import { assertOwnerAccessDto, ownerAccessPasswordInput, teamNewPasswordInput } from "../src/ownerAccess.js";
import { createLatestRead } from "../src/formState.js";

const access = status => ({ providerType: status === "development_only" ? "development_default" : "local_owner_password", status,
  user: status === "authenticated" ? { userId: "synthetic-owner" } : null });

test("owner access DTO accepts only explicit provider/status/user contracts and never derives setup from missing data", () => {
  for (const status of ["development_only", "setup_required", "login_required", "authenticated"]) {
    const value = access(status); assert.strictEqual(assertOwnerAccessDto(value), value);
  }
  for (const value of [null, {}, [], { status: "setup_required" }, { ...access("authenticated"), user: null },
    { ...access("login_required"), user: { userId: "owner" } }, { ...access("development_only"), status: "authenticated" },
    { ...access("authenticated"), providerType: "unverified" }, { ...access("authenticated"), user: { userId: "" } },
    { ...access("authenticated"), user: { userId: "owner", roles: ["owner"] } }, { ...access("authenticated"), sessionToken: "synthetic-private" }]) {
    const before = structuredClone(value); assert.throws(() => assertOwnerAccessDto(value), /状态格式无效/); assert.deepEqual(value, before);
  }
});

const teamAccess = (status, user = { userId: "team-user:synthetic-boss", displayName: "老板甲", role: "boss" }) =>
  ({ providerType: "team_accounts", status, user: status === "authenticated" ? user : null });

test("team sign-in DTO names who is signed in and their role, and never offers first-time setup", () => {
  for (const value of [teamAccess("login_required"), teamAccess("authenticated"),
    teamAccess("authenticated", { userId: "team-user:synthetic-tester", displayName: "测试丙", role: "tester" })]) {
    assert.strictEqual(assertOwnerAccessDto(value), value);
  }
  for (const value of [{ ...teamAccess("login_required"), status: "setup_required" }, { ...teamAccess("login_required"), status: "development_only" },
    teamAccess("authenticated", { userId: "team-user:synthetic-boss" }), teamAccess("authenticated", { userId: "team-user:x", displayName: "", role: "boss" }),
    teamAccess("authenticated", { userId: "team-user:x", displayName: "老板甲", role: "owner" }),
    teamAccess("authenticated", { userId: "team-user:x", displayName: "老板甲", role: "boss", roles: ["owner"] }),
    { ...access("authenticated"), user: { userId: "owner", displayName: "老板甲", role: "boss" } }]) {
    assert.throws(() => assertOwnerAccessDto(value), /状态格式无效/);
  }
});

test("team sign-in sends the login name with the password; a new password is typed twice and has at least eight characters", () => {
  const password = " synthetic team password ";
  assert.deepEqual(ownerAccessPasswordInput({ access: teamAccess("login_required"), password, loginName: "  Boss-A " }), { loginName: "Boss-A", password });
  assert.throws(() => ownerAccessPasswordInput({ access: teamAccess("login_required"), password, loginName: " " }), /请填写登录名/);
  assert.throws(() => ownerAccessPasswordInput({ access: teamAccess("login_required"), password: "", loginName: "boss-a" }), /请填写密码/);
  assert.throws(() => ownerAccessPasswordInput({ access: teamAccess("authenticated"), password, loginName: "boss-a" }), /不能提交/);
  // The local owner's request is unchanged: a login name typed by mistake is not sent.
  assert.deepEqual(ownerAccessPasswordInput({ access: access("login_required"), password, loginName: "boss-a" }), { password });
  assert.equal(teamNewPasswordInput({ newPassword: "八个字符的新密码", repeatedPassword: "八个字符的新密码" }), "八个字符的新密码");
  assert.throws(() => teamNewPasswordInput({ newPassword: "七个字符的密码", repeatedPassword: "七个字符的密码" }), /至少8个字符/);
  assert.throws(() => teamNewPasswordInput({ newPassword: "synthetic new 2026", repeatedPassword: "synthetic new 2027" }), /不一致/);
  assert.throws(() => teamNewPasswordInput({ newPassword: "", repeatedPassword: "" }), /请填写新密码/);
});

test("team password requests use fixed paths and closed bodies", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, method: options?.method ?? "GET", body: options?.body === undefined ? undefined : JSON.parse(options.body) });
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await api.loginOwnerAccess({ loginName: "boss-a", password: "synthetic-login-password", userId: "not-sent" });
  await api.changeOwnPassword({ currentPassword: "synthetic-current", newPassword: "synthetic-new-password", roles: ["owner"] });
  await api.listTeamAccounts(new AbortController().signal);
  await api.resetTeamPassword({ userId: "team-user:synthetic-tester", newPassword: "synthetic-reset-password", role: "boss" });
  assert.deepEqual(requests, [
    { url: "/api/owner-access/login", method: "POST", body: { loginName: "boss-a", password: "synthetic-login-password" } },
    { url: "/api/owner-access/password", method: "POST", body: { currentPassword: "synthetic-current", newPassword: "synthetic-new-password" } },
    { url: "/api/team-accounts", method: "GET", body: undefined },
    { url: "/api/team-accounts/reset-password", method: "POST", body: { userId: "team-user:synthetic-tester", newPassword: "synthetic-reset-password" } }
  ]);
});

test("password input stays opaque and repeat confirmation cannot create identity or commercial scope", () => {
  const password = " synthetic-password-with-spaces ";
  assert.deepEqual(ownerAccessPasswordInput({ access: access("setup_required"), password, repeatedPassword: password }), { password });
  assert.deepEqual(ownerAccessPasswordInput({ access: access("login_required"), password }), { password });
  assert.throws(() => ownerAccessPasswordInput({ access: access("setup_required"), password, repeatedPassword: "different" }), /不一致/);
  assert.throws(() => ownerAccessPasswordInput({ access: access("login_required"), password: "" }), /填写/);
  for (const password of ["abc", "中文字", "😀".repeat(3), "😀".repeat(2)]) {
    assert.throws(() => ownerAccessPasswordInput({ access: access("setup_required"), password, repeatedPassword: password }), /至少4/);
  }
  for (const password of ["aB4!", "中文口令", "😀🙂🙃😄", " x y", "😀".repeat(15), "a".repeat(1024), "中".repeat(341) + "a"]) {
    assert.deepEqual(ownerAccessPasswordInput({ access: access("setup_required"), password, repeatedPassword: password }), { password });
  }
  for (const password of ["a".repeat(1025), "中".repeat(342), "synthetic\0invalid-password"]) {
    for (const status of ["setup_required", "login_required"]) assert.throws(() => ownerAccessPasswordInput({ access: access(status), password, repeatedPassword: password }), /最多1024字节/);
  }
  for (const status of ["authenticated", "development_only"]) assert.throws(() => ownerAccessPasswordInput({ access: access(status), password }), /不能提交/);
});

test("four owner API requests use fixed paths, closed bodies and preserve explicit server failure without a business request", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(access(url.endsWith("logout") ? "login_required" : "authenticated")), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const controller = new AbortController();
  await api.getOwnerAccess(controller.signal);
  await api.setupOwnerAccess({ password: "synthetic-setup-password", roles: ["owner"], candidateId: "not-sent" });
  await api.loginOwnerAccess({ password: "synthetic-login-password", userId: "not-sent" });
  await api.logoutOwnerAccess();
  assert.deepEqual(requests.map(request => request.url), ["/api/owner-access", "/api/owner-access/setup", "/api/owner-access/login", "/api/owner-access/logout"]);
  assert.equal(requests[0].options.signal, controller.signal); assert.equal(requests[0].options.body, undefined);
  assert.deepEqual(requests.slice(1).map(request => JSON.parse(request.options.body)), [{ password: "synthetic-setup-password" }, { password: "synthetic-login-password" }, {}]);
  assert.ok(requests.slice(1).every(request => request.options.method === "POST"));
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "OWNER_AUTH_INVALID_CREDENTIALS", message: "密码不正确" }), { status: 401 });
  await assert.rejects(api.loginOwnerAccess({ password: "synthetic-wrong-password" }), error => error.status === 401 && error.body.code === "OWNER_AUTH_INVALID_CREDENTIALS" && error.message === "密码不正确");
  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  await assert.rejects(api.getOwnerAccess(), /无效JSON/);
});

test("owner access plus protected state read completes despite a concurrent ordinary poll", async t => {
  const stateGate = Promise.withResolvers(), stateStarted = Promise.withResolvers();
  const stateReader = createLatestRead(), accessReader = createLatestRead(), published = [], requests = [];
  let stateSignal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url);
    if (url === "/api/owner-access") return new Response(JSON.stringify(access("authenticated")), { status: 200 });
    assert.equal(url, "/api/state");
    stateSignal = options.signal; stateStarted.resolve();
    return stateGate.promise;
  });
  const refresh = accessReader.run(async signal => {
    const identity = assertOwnerAccessDto(await api.getOwnerAccess(signal));
    signal.throwIfAborted();
    const state = await stateReader.run(api.getState, value => published.push(value), { protect: true, signal });
    signal.throwIfAborted();
    assert.ok(state);
    return identity;
  }, identity => published.push(identity.status));
  await stateStarted.promise;
  assert.deepEqual(published, []);
  const pollController = new AbortController();
  const poll = stateReader.run(api.getState, () => assert.fail("coalesced poll must not publish twice"), { signal: pollController.signal });
  pollController.abort();
  assert.equal(stateSignal.aborted, false);
  stateGate.resolve(new Response(JSON.stringify({ runtimeArchitecture: { currentUser: { canAuthorizeProduction: true } } }), { status: 200 }));
  await Promise.all([refresh, poll]);
  assert.deepEqual(requests, ["/api/owner-access", "/api/state"]);
  assert.deepEqual(published, [{ runtimeArchitecture: { currentUser: { canAuthorizeProduction: true } } }, "authenticated"]);
});

test("permission HTTP failure and unmounted access refresh never publish an authenticated state", async t => {
  for (const cancelled of [false, true]) {
    const stateGate = Promise.withResolvers(), stateStarted = Promise.withResolvers();
    const stateReader = createLatestRead(), accessReader = createLatestRead(), published = [];
    let stateSignal;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (url === "/api/owner-access") return new Response(JSON.stringify(access("authenticated")), { status: 200 });
      assert.equal(url, "/api/state"); stateSignal = options.signal; stateStarted.resolve(); return stateGate.promise;
    });
    const refresh = accessReader.run(async signal => {
      const identity = assertOwnerAccessDto(await api.getOwnerAccess(signal));
      signal.throwIfAborted();
      await stateReader.run(api.getState, value => published.push(value), { protect: true, signal });
      signal.throwIfAborted();
      return identity;
    }, identity => published.push(identity.status));
    await stateStarted.promise;
    if (cancelled) accessReader.cancel();
    assert.equal(stateSignal.aborted, cancelled);
    const outcome = cancelled ? refresh : assert.rejects(refresh, error => error.status === 503 && /权限读取不可用/.test(error.message));
    stateGate.resolve(new Response(JSON.stringify({ message: "权限读取不可用" }), { status: 503 }));
    if (cancelled) assert.equal(await outcome, null); else await outcome;
    assert.deepEqual(published, []);
  }
});

test("actual access views distinguish loading, first setup, login, authenticated, development and unreadable state", async () => {
  const entry = fileURLToPath(new URL("./owner-access-render.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/LocalOwnerAccessPanel.jsx", import.meta.url));
  const app = fileURLToPath(new URL("../src/App.jsx", import.meta.url));
  const result = await build({ configFile: false, logLevel: "warn", plugins: [react(), { name: "owner-access-render",
    resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{LocalOwnerAccessView}from ${JSON.stringify(component)};import App from ${JSON.stringify(app)};
      export const render=(state,showAuthenticated=false)=>renderToStaticMarkup(<LocalOwnerAccessView state={state} saving={false} password='' repeatedPassword='' inputError='' showAuthenticated={showAuthenticated}/>);
      export const renderApp=()=>renderToStaticMarkup(<App/>);` : null }], ssr: { noExternal: true },
    build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const chunk = result.output.find(item => item.type === "chunk" && item.isEntry);
  const { render, renderApp } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  const loading = render({ status: "loading", access: null, error: "" });
  assert.match(loading, /正在读取登录状态/); assert.doesNotMatch(loading, /首次设置|type="password"/);
  const failed = render({ status: "failed", access: null, error: "当前服务连接失败" });
  assert.match(failed, /当前服务连接失败/); assert.match(failed, /重新读取登录状态/); assert.doesNotMatch(failed, /首次设置|type="password"/);
  const setup = render({ status: "loaded", access: access("setup_required") });
  assert.match(setup, /首次设置主人密码/); assert.equal((setup.match(/type="password"/g) || []).length, 2); assert.match(setup, /autoComplete="new-password"/);
  assert.match(setup, /不确认商品、不创建作业，也不执行生产/);
  assert.match(setup, /至少4个字符、最多1024字节/);
  const login = render({ status: "loaded", access: access("login_required") });
  assert.equal((login.match(/type="password"/g) || []).length, 1); assert.match(login, /autoComplete="current-password"/); assert.doesNotMatch(login, /首次设置/);
  // 已登录是常态，不必每一页头上都声明一遍：默认整条不显示，只有「维护」把它显示出来（退出登录就在那里）。
  assert.equal(render({ status: "loaded", access: access("authenticated") }), "");
  const authenticated = render({ status: "loaded", access: access("authenticated") }, true);
  assert.match(authenticated, /主人已登录/); assert.match(authenticated, /退出登录/); assert.doesNotMatch(authenticated, /type="password"/);
  const development = render({ status: "loaded", access: access("development_only") });
  assert.match(development, /预览身份/); assert.match(development, /不能保存正式生产授权/); assert.doesNotMatch(development, /type="password"|设置密码并登录/);
  // Team accounts: the login form asks for a login name; signed in, 「维护」 says who and offers the password forms.
  const teamLogin = render({ status: "loaded", access: teamAccess("login_required") });
  assert.match(teamLogin, /登录名/); assert.match(teamLogin, /autoComplete="username"/);
  assert.equal((teamLogin.match(/type="password"/g) || []).length, 1); assert.doesNotMatch(teamLogin, /主人密码|首次设置/);
  assert.equal(render({ status: "loaded", access: teamAccess("authenticated") }), "");
  const boss = render({ status: "loaded", access: teamAccess("authenticated") }, true);
  assert.match(boss, /已登录：老板甲（老板）/); assert.match(boss, /退出登录/); assert.match(boss, /改我的密码/); assert.match(boss, /给别人重设密码/);
  const tester = render({ status: "loaded", access: teamAccess("authenticated", { userId: "team-user:synthetic-tester", displayName: "测试丙", role: "tester" }) }, true);
  assert.match(tester, /已登录：测试丙（测试）/); assert.match(tester, /要老板来做/); assert.match(tester, /改我的密码/); assert.doesNotMatch(tester, /给别人重设密码/);
  // Both see the computers whose plugin works for the team (central plan step 3).
  for (const view of [boss, tester]) assert.match(view, /干活的电脑/);
  assert.doesNotMatch(authenticated, /干活的电脑/);
  // App reads only the extension-version cache during its browser initializer; SSR runs no effects or requests.
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => null } } });
  try { assert.match(renderApp(), /正在打开全店经营工作台/); }
  finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  }
});
