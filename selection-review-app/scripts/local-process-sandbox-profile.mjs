import os from "node:os";
import path from "node:path";

const systemReadDirectories = ["/System", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/Library/Apple", "/private/etc", "/private/var/db/timezone"];
const broadDirectories = new Set(["/", "/Users", "/home", "/usr", "/Library", "/private", "/private/var", "/private/var/folders", "/var", "/tmp", "/private/tmp"]);
const productionPorts = new Set([4317, 4318, 4173, 4319]);
const protectedDirectoryNames = new Set(["data", "config", "keychains", "systemkey"]);
const failure = code => Object.assign(new Error(code), { code });

function isCanonicalDirectory(directory) {
  return typeof directory === "string" && path.isAbsolute(directory) &&
    !/[\u0000-\u001f\u007f]/.test(directory) && path.resolve(directory) === directory;
}

function containsDirectory(parent, directory) {
  return parent === directory || directory.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function isForbiddenDirectory(directory, home) {
  const protectedRoots = ["/Library/Keychains", "/private/var/db/SystemKey",
    path.join(home, "Library", "Keychains"), path.join(home, "Library", "Application Support", "今日选品评审台", "data")];
  return broadDirectories.has(directory) || containsDirectory(directory, home) ||
    /^\/(?:Users|home)\/[^/]+$/.test(directory) || /^\/(?:private\/)?var\/root$/.test(directory) ||
    /^\/(?:Users|home)\/[^/]+\/(?:Documents|Downloads|Desktop|Library)$/.test(directory) ||
    directory.split("/").some(part => protectedDirectoryNames.has(part.toLowerCase())) ||
    protectedRoots.some(root => containsDirectory(directory, root) || containsDirectory(root, directory));
}

/** Callers provide real paths to isolated storage and frozen code/runtime trees, then enforce this profile with sandbox-exec. */
export function createLocalProcessSandboxProfile({ writableRoot, readOnlyDirectories, ports } = {}) {
  const home = path.resolve(os.homedir());
  if (!isCanonicalDirectory(writableRoot) || isForbiddenDirectory(writableRoot, home)) {
    throw failure("LOCAL_PROCESS_SANDBOX_WRITABLE_ROOT_INVALID");
  }
  if (!Array.isArray(readOnlyDirectories) || [...readOnlyDirectories].some(directory => !isCanonicalDirectory(directory))) {
    throw failure("LOCAL_PROCESS_SANDBOX_READ_ONLY_DIRECTORIES_INVALID");
  }
  if (readOnlyDirectories.some(directory => isForbiddenDirectory(directory, home) ||
      directory !== writableRoot && containsDirectory(directory, writableRoot))) {
    throw failure("LOCAL_PROCESS_SANDBOX_READ_ONLY_DIRECTORY_FORBIDDEN");
  }
  if (!Array.isArray(ports) || ports.length < 1 || ports.length > 3 || new Set(ports).size !== ports.length ||
      [...ports].some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535 || productionPorts.has(port))) {
    throw failure("LOCAL_PROCESS_SANDBOX_PORTS_INVALID");
  }

  const quoted = value => JSON.stringify(value);
  const ancestors = new Set();
  const readDirectories = [writableRoot, ...readOnlyDirectories, ...systemReadDirectories];
  for (const directory of readDirectories) {
    for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  }
  return `(version 1)
(allow default)
(deny network-outbound (require-not (require-any ${ports.map(port => `(remote tcp "localhost:${port}")`).join(" ")})))
(deny network-inbound (require-not (require-any ${ports.map(port => `(local tcp "localhost:${port}")`).join(" ")})))
(deny file-write* (require-not (require-any (subpath ${quoted(writableRoot)}) (literal "/dev/null"))))
(deny file-read-data (require-not (require-any
  ${readDirectories.map(directory => `(subpath ${quoted(directory)})`).join(" ")}
  (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))))
(deny file-read-metadata (require-not (require-any
  ${readDirectories.map(directory => `(subpath ${quoted(directory)})`).join(" ")}
  ${[...ancestors].map(directory => `(literal ${quoted(directory)})`).join(" ")}
  (literal "/") (literal "/dev") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))))
(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/db/SystemKey"))
(deny process-exec (literal "/usr/bin/security") (literal "/bin/launchctl")
  (literal "/usr/bin/open") (literal "/usr/bin/osascript"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd"))`;
}
