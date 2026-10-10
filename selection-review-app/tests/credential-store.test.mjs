import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_STORE_BACKENDS, CredentialStoreError, createFakeCredentialStore, createOsCredentialStore,
  credentialStoreBackendFor, isCredentialStorePlatformSupported, windowsCredentialTarget
} from "../lib/credential-store.mjs";
import { ALIYUN_OSS_KEYCHAIN_SERVICE, ALIYUN_OSS_PUBLIC_CONFIG, readAliyunOssKeychainSecret } from "../lib/aliyun-oss-asset-transport.mjs";
import { createLinkfoxDiscoverySecretReader } from "../lib/linkfox-discovery-credentials.mjs";
import { OzonDEHttpTransportError, readOzonDEKeychainSecret } from "../lib/ozon-de-http-transport.mjs";
import {
  SEERFAR_KEYCHAIN_ACCOUNT, SEERFAR_KEYCHAIN_SERVICE, inspectSeerfarKeychainEntry, inspectSeerfarRuntimeConfiguration,
  readSeerfarKeychainSecret
} from "../lib/seerfar-runtime-connector.mjs";

// Every value below is synthetic. No test touches a real OS credential store.
const entry = { service: "synthetic.credential.service", account: "synthetic-account" };
const recorder = (result = { stdout: "synthetic-value\n", stderr: "" }) => {
  const calls = [];
  return { calls, execFileImpl: async (...args) => { calls.push(args); if (result instanceof Error || result?.code !== undefined) throw result; return result; } };
};
const processFailure = (code, stderr = "SYNTHETIC_PRIVATE_STDERR") =>
  Object.assign(new Error(`Command failed: ${stderr}`), { code, stderr, stdout: "SYNTHETIC_PRIVATE_STDOUT" });
const leaks = error => /SYNTHETIC_PRIVATE/.test(`${error.message}${error.stack}${JSON.stringify(error)}`);

test("each supported operating system has exactly one backend and others are unavailable without a process", async () => {
  assert.deepEqual(CREDENTIAL_STORE_BACKENDS, { darwin: "macos_keychain", win32: "windows_credential_manager", linux: "linux_secret_service" });
  assert.equal(credentialStoreBackendFor("darwin"), "macos_keychain");
  assert.equal(credentialStoreBackendFor("constructor"), null);
  for (const platform of ["aix", "freebsd", "sunos"]) {
    assert.equal(isCredentialStorePlatformSupported(platform), false);
    const { calls, execFileImpl } = recorder();
    await assert.rejects(createOsCredentialStore({ platform, execFileImpl }).readSecret(entry),
      error => error instanceof CredentialStoreError && error.code === "credential_store_unavailable");
    assert.equal(calls.length, 0);
  }
});

test("macOS keeps the exact security command, with and without -w", async () => {
  const controller = new AbortController();
  const { calls, execFileImpl } = recorder();
  const store = createOsCredentialStore({ platform: "darwin", execFileImpl });
  assert.equal(await store.readSecret(entry, { signal: controller.signal, timeout: 5000, maxBuffer: 8192 }), "synthetic-value\n");
  assert.deepEqual(calls[0].slice(0, 2), ["/usr/bin/security", ["find-generic-password", "-w", "-s", entry.service, "-a", entry.account]]);
  assert.deepEqual(calls[0][2], { encoding: "utf8", maxBuffer: 8192, timeout: 5000, signal: controller.signal });
  assert.equal(await store.hasSecret(entry), true);
  assert.deepEqual(calls[1][1], ["find-generic-password", "-s", entry.service, "-a", entry.account]);
  assert.equal("timeout" in calls[1][2] || "signal" in calls[1][2], false);
});

test("Windows reads Credential Manager through a fixed script with the target only in the environment", async () => {
  const { calls, execFileImpl } = recorder({ stdout: "synthetic-value", stderr: "" });
  const store = createOsCredentialStore({ platform: "win32", execFileImpl, env: { SystemRoot: "D:\\Win", PATH: "synthetic" } });
  assert.equal(store.backend, "windows_credential_manager");
  assert.equal(await store.readSecret(entry), "synthetic-value");
  const [file, args, options] = calls[0];
  assert.equal(file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
  assert.match(args[6], /CredReadW/);
  assert.equal(args.some(arg => arg.includes(entry.service) || arg.includes(entry.account)), false);
  assert.equal(options.env.WB_OZON_CREDENTIAL_TARGET, "synthetic.credential.service/synthetic-account");
  assert.equal(options.env.WB_OZON_CREDENTIAL_MODE, "read");
  assert.equal(options.env.PATH, "synthetic");
  assert.equal(options.windowsHide, true);
  await store.hasSecret(entry);
  assert.equal(calls[1][2].env.WB_OZON_CREDENTIAL_MODE, "inspect");
  assert.equal(windowsCredentialTarget({ service: SEERFAR_KEYCHAIN_SERVICE, account: SEERFAR_KEYCHAIN_ACCOUNT }), "egg-ozon-operations-center/seerfar-open-api");
  const fallback = recorder();
  await createOsCredentialStore({ platform: "win32", execFileImpl: fallback.execFileImpl, env: { SystemRoot: "bad\"root" } }).readSecret(entry);
  assert.equal(fallback.calls[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  for (const [code, expected] of [[44, "credential_missing"], [51, "credential_access_denied"], [1, "credential_read_failed"]]) {
    const failing = recorder(processFailure(code));
    await assert.rejects(createOsCredentialStore({ platform: "win32", execFileImpl: failing.execFileImpl, env: {} }).readSecret(entry),
      error => error.code === expected && !leaks(error));
  }
});

test("Linux uses secret-tool and only a silent exit 1 counts as missing", async () => {
  const { calls, execFileImpl } = recorder();
  const store = createOsCredentialStore({ platform: "linux", execFileImpl });
  await store.readSecret(entry);
  assert.deepEqual(calls[0].slice(0, 2), ["secret-tool", ["lookup", "service", entry.service, "account", entry.account]]);
  const missing = recorder(processFailure(1, ""));
  assert.equal(await createOsCredentialStore({ platform: "linux", execFileImpl: missing.execFileImpl }).hasSecret(entry), false);
  const dbus = recorder(processFailure(1));
  await assert.rejects(createOsCredentialStore({ platform: "linux", execFileImpl: dbus.execFileImpl }).readSecret(entry),
    error => error.code === "credential_read_failed" && !leaks(error));
  const absent = recorder(Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" }));
  await assert.rejects(createOsCredentialStore({ platform: "linux", execFileImpl: absent.execFileImpl }).readSecret(entry),
    error => error.code === "credential_store_unavailable");
});

test("failures carry only a code, cancellation is distinct and programming errors keep their identity", async () => {
  for (const [code, expected] of [[44, "credential_missing"], [51, "credential_access_denied"], [128, "credential_access_denied"],
    [1, "credential_read_failed"], ["EACCES", "credential_read_failed"], ["ENOENT", "credential_store_unavailable"]]) {
    const { execFileImpl } = recorder(processFailure(code));
    await assert.rejects(createOsCredentialStore({ platform: "darwin", execFileImpl }).readSecret(entry), error => {
      assert.ok(error instanceof CredentialStoreError); assert.equal(error.code, expected); assert.equal(error.backend, "macos_keychain");
      assert.equal(error.cause, undefined); assert.equal(leaks(error), false); return true;
    });
  }
  const controller = new AbortController(); controller.abort();
  const idle = recorder();
  await assert.rejects(createOsCredentialStore({ platform: "darwin", execFileImpl: idle.execFileImpl }).readSecret(entry, { signal: controller.signal }),
    error => error.code === "credential_read_cancelled");
  assert.equal(idle.calls.length, 0);
  const aborted = recorder(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
  await assert.rejects(createOsCredentialStore({ platform: "darwin", execFileImpl: aborted.execFileImpl }).readSecret(entry),
    error => error.code === "credential_read_cancelled");
  const defect = new TypeError("synthetic defect");
  await assert.rejects(createOsCredentialStore({ platform: "darwin", execFileImpl: async () => { throw defect; } }).readSecret(entry), error => error === defect);
  const store = createOsCredentialStore({ platform: "darwin", execFileImpl: async () => { throw new Error("must not run"); } });
  for (const bad of [null, {}, { service: "x" }, { service: " x", account: "y" }, { service: "x", account: "y\n" }]) {
    await assert.rejects(store.readSecret(bad), /CREDENTIAL_STORE_ENTRY_INVALID/);
  }
  await assert.rejects(store.readSecret(entry, { timeout: -1 }), /CREDENTIAL_STORE_OPTIONS_INVALID/);
  assert.throws(() => createOsCredentialStore({ execFileImpl: "no" }), /CREDENTIAL_STORE_CONFIGURATION_INVALID/);
});

test("the fake store serves synthetic entries and records names only", async () => {
  const fake = createFakeCredentialStore([{ ...entry, value: "synthetic-value" }, { service: entry.service, account: "denied", failure: "credential_access_denied" }]);
  assert.equal(await fake.readSecret(entry), "synthetic-value");
  assert.equal(await fake.hasSecret(entry), true);
  assert.equal(await fake.hasSecret({ ...entry, account: "absent" }), false);
  await assert.rejects(fake.readSecret({ ...entry, account: "denied" }), error => error.code === "credential_access_denied");
  assert.equal(JSON.stringify(fake.calls).includes("synthetic-value"), false);
  assert.deepEqual(fake.calls[0], { mode: "read", ...entry });
  assert.throws(() => createFakeCredentialStore([{ ...entry, failure: "nope" }]), /FAKE_ENTRIES_INVALID/);
});

test("historical service and account names are unchanged", () => {
  assert.equal(SEERFAR_KEYCHAIN_SERVICE, "egg-ozon-operations-center");
  assert.equal(SEERFAR_KEYCHAIN_ACCOUNT, "seerfar-open-api");
  assert.equal(ALIYUN_OSS_KEYCHAIN_SERVICE, "com.shuaizhang.wb-ozon-selection.aliyun-oss");
  assert.deepEqual({ ...ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts }, { accessKeyId: "access-key-id", accessKeySecret: "access-key-secret" });
});

test("every caller reads through the store on Windows and Linux with unchanged names", async () => {
  const ozonBinding = { credentialAlias: "credential-alias:ozon:1", clientId: "123456", keychainService: "egg-ozon-operations-center", keychainAccount: "ozon-store-b-seller-api" };
  const ozonStore = createFakeCredentialStore([{ service: ozonBinding.keychainService, account: ozonBinding.keychainAccount, value: "synthetic-api-key\n" }]);
  assert.equal(await readOzonDEKeychainSecret(ozonBinding, { credentialStore: ozonStore }), "synthetic-api-key");
  const ozonLinux = recorder({ stdout: "synthetic-api-key", stderr: "" });
  assert.equal(await readOzonDEKeychainSecret(ozonBinding, { platform: "linux", execFileImpl: ozonLinux.execFileImpl }), "synthetic-api-key");
  assert.deepEqual(ozonLinux.calls[0][1], ["lookup", "service", "egg-ozon-operations-center", "account", "ozon-store-b-seller-api"]);
  await assert.rejects(readOzonDEKeychainSecret(ozonBinding, { credentialStore: createFakeCredentialStore([]) }),
    error => error instanceof OzonDEHttpTransportError && error.code === "OZON_DE_CREDENTIAL_READ_FAILED");
  await assert.rejects(readOzonDEKeychainSecret(ozonBinding, { credentialStore: ozonStore, runtimeMode: "central_test" }),
    error => error.code === "OZON_DE_CREDENTIAL_READER_UNAVAILABLE");

  const discovery = { credentialAlias: "credential-alias:linkfox:1", keychainService: "egg-ozon-operations-center", keychainAccount: "linkfox-api" };
  const win = recorder({ stdout: "synthetic-linkfox", stderr: "" });
  const readLinkfox = createLinkfoxDiscoverySecretReader({ bindings: [discovery], runtimeMode: "local_development", platform: "win32", execFileImpl: win.execFileImpl });
  assert.equal(await readLinkfox({ credentialAlias: discovery.credentialAlias, provider: "linkfox" }), "synthetic-linkfox");
  assert.equal(win.calls[0][2].env.WB_OZON_CREDENTIAL_TARGET, "egg-ozon-operations-center/linkfox-api");
  const fakeLinkfox = createLinkfoxDiscoverySecretReader({ bindings: [discovery], runtimeMode: "local_development", credentialStore: createFakeCredentialStore([]) });
  await assert.rejects(fakeLinkfox({ credentialAlias: discovery.credentialAlias, provider: "linkfox" }), /CREDENTIAL_MISSING/);

  const seerfarStore = createFakeCredentialStore([{ service: SEERFAR_KEYCHAIN_SERVICE, account: SEERFAR_KEYCHAIN_ACCOUNT, value: "synthetic-seerfar\n" }]);
  assert.equal(await readSeerfarKeychainSecret({ credentialStore: seerfarStore }), "synthetic-seerfar");
  assert.equal(await inspectSeerfarKeychainEntry({ credentialStore: seerfarStore }), true);
  assert.equal(await inspectSeerfarKeychainEntry({ credentialStore: createFakeCredentialStore([]) }), false);
  await assert.rejects(readSeerfarKeychainSecret({ credentialStore: createFakeCredentialStore([]) }), error => error.code === "credential_missing");
  for (const [platform, location] of [["win32", "windows_credential_manager"], ["linux", "linux_secret_service"], ["aix", "unsupported_platform"]]) {
    assert.equal((await inspectSeerfarRuntimeConfiguration({ keychainEntryReader: async () => true, platform })).credentialLocation, location);
  }

  const ossStore = createFakeCredentialStore([{ service: ALIYUN_OSS_KEYCHAIN_SERVICE, account: "access-key-id", value: "synthetic-oss-id" }]);
  assert.equal(await readAliyunOssKeychainSecret("access-key-id", { credentialStore: ossStore }), "synthetic-oss-id");
  await assert.rejects(readAliyunOssKeychainSecret("access-key-secret", { credentialStore: ossStore }), error => error.code === "credential_missing");
});
