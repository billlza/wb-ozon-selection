import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "../src/api.js";
import { assertOwnerAccessDto, ownerAccessPasswordInput } from "../src/ownerAccess.js";
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
  // App reads only the extension-version cache during its browser initializer; SSR runs no effects or requests.
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => null } } });
  try { assert.match(renderApp(), /正在打开全店经营工作台/); }
  finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  }
});
