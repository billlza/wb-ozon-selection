import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createLocalProcessSandboxProfile } from "../scripts/local-process-sandbox-profile.mjs";

const input = {
  writableRoot: "/private/tmp/isolated-fixture",
  readOnlyDirectories: ["/opt/sandbox-runtime", "/opt/dependencies/node_modules"],
  ports: [42001]
};

test("the shared profile preserves the complete filesystem, network, execution and Keychain policy", () => {
  assert.equal(createLocalProcessSandboxProfile(input), `(version 1)
(allow default)
(deny network-outbound (require-not (require-any (remote tcp "localhost:42001"))))
(deny network-inbound (require-not (require-any (local tcp "localhost:42001"))))
(deny file-write* (require-not (require-any (subpath "/private/tmp/isolated-fixture") (literal "/dev/null"))))
(deny file-read-data (require-not (require-any
  (subpath "/private/tmp/isolated-fixture") (subpath "/opt/sandbox-runtime") (subpath "/opt/dependencies/node_modules") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/private/var/db/timezone")
  (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))))
(deny file-read-metadata (require-not (require-any
  (subpath "/private/tmp/isolated-fixture") (subpath "/opt/sandbox-runtime") (subpath "/opt/dependencies/node_modules") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/private/var/db/timezone")
  (literal "/private/tmp") (literal "/private") (literal "/opt") (literal "/opt/dependencies") (literal "/usr") (literal "/Library") (literal "/private/var/db") (literal "/private/var")
  (literal "/") (literal "/dev") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))))
(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/db/SystemKey"))
(deny process-exec (literal "/usr/bin/security") (literal "/bin/launchctl")
  (literal "/usr/bin/open") (literal "/usr/bin/osascript"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd"))`);
});

test("only one to three explicit distinct test ports can be permitted", () => {
  assert.doesNotThrow(() => createLocalProcessSandboxProfile({ ...input, ports: [1, 65535] }));
  const profile = createLocalProcessSandboxProfile({ ...input, ports: [42001, 42002, 42003] });
  assert.match(profile, /^\(deny network-outbound \(require-not \(require-any \(remote tcp "localhost:42001"\) \(remote tcp "localhost:42002"\) \(remote tcp "localhost:42003"\)\)\)\)$/m);
  assert.match(profile, /^\(deny network-inbound \(require-not \(require-any \(local tcp "localhost:42001"\) \(local tcp "localhost:42002"\) \(local tcp "localhost:42003"\)\)\)\)$/m);
  for (const ports of [undefined, null, 42001, [], Array(1), [42001, 42001], [42001, 42002, 42003, 42004],
    [0], [-1], [65536], [1.5], [NaN], [Infinity], ["42001"], [4317], [4318], [4173], [4319]]) {
    assert.throws(() => createLocalProcessSandboxProfile({ ...input, ports }), /LOCAL_PROCESS_SANDBOX_PORTS_INVALID/);
  }
});

test("malformed, broad and protected directory inputs fail before producing a profile", () => {
  const home = path.resolve(os.homedir());
  for (const writableRoot of [undefined, null, 1, "", "relative", "/", home, path.dirname(home), "/private",
    "/private/tmp/isolated-fixture/..", "/private/tmp/fixture\u0000name", "/private/tmp/fixture\nname",
    "/private/tmp/fixture/data", "/private/var/db/SystemKey"]) {
    assert.throws(() => createLocalProcessSandboxProfile({ ...input, writableRoot }), /LOCAL_PROCESS_SANDBOX_WRITABLE_ROOT_INVALID/);
  }
  for (const readOnlyDirectories of [undefined, null, "/opt/runtime", Array(1), ["relative"], [1], ["/opt/runtime/../live"], ["/opt/runtime\nname"]]) {
    assert.throws(() => createLocalProcessSandboxProfile({ ...input, readOnlyDirectories }), /LOCAL_PROCESS_SANDBOX_READ_ONLY_DIRECTORIES_INVALID/);
  }
  for (const directory of ["/", home, path.dirname(home), "/Users", "/home", "/usr", "/Library", "/private/tmp",
    "/opt/frozen-code/data", "/opt/frozen-code/config", "/Library/Keychains", path.join(home, "Library"),
    path.join(home, "Library", "Keychains"), path.join(home, "Library", "Application Support", "今日选品评审台"), "/private/var/db/SystemKey"]) {
    assert.throws(() => createLocalProcessSandboxProfile({ ...input, readOnlyDirectories: [directory] }), /LOCAL_PROCESS_SANDBOX_READ_ONLY_DIRECTORY_FORBIDDEN/);
  }
});

test("precise runtime and frozen package subtrees below home remain usable without exposing home", () => {
  const home = path.resolve(os.homedir());
  const runtime = path.join(home, "local-runtime", "bin");
  const frozenPackage = path.join(home, "frozen-runtime", "app");
  const profile = createLocalProcessSandboxProfile({ ...input, readOnlyDirectories: [runtime, frozenPackage] });
  const dataRules = profile.slice(profile.indexOf("(deny file-read-data"), profile.indexOf("(deny file-read-metadata"));
  assert.ok(dataRules.includes(`(subpath ${JSON.stringify(runtime)})`));
  assert.ok(dataRules.includes(`(subpath ${JSON.stringify(frozenPackage)})`));
  assert.ok(!dataRules.includes(`(subpath ${JSON.stringify(home)})`));
  assert.ok(profile.includes(`(literal ${JSON.stringify(home)})`));
});

test("paths are quoted as Seatbelt string literals and input arrays are not mutated", () => {
  const quotedRoot = '/private/tmp/fixture "quoted"';
  const directories = Object.freeze(['/opt/runtime "quoted"']);
  const ports = Object.freeze([42001]);
  const profile = createLocalProcessSandboxProfile({ writableRoot: quotedRoot, readOnlyDirectories: directories, ports });
  assert.ok(profile.includes(`(subpath ${JSON.stringify(quotedRoot)})`));
  assert.ok(profile.includes(`(subpath ${JSON.stringify(directories[0])})`));
  assert.deepEqual(directories, ['/opt/runtime "quoted"']);
  assert.deepEqual(ports, [42001]);
});
