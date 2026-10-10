import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Local development credential boundary: one OS credential store per machine, chosen by platform.
// Entries keep the historical keychain names (service + account) on every backend, so moving to
// another OS means storing the same names there; a central runtime injects its own store instead.
// Nothing here logs, caches or returns subprocess text other than the secret itself on a read.

const execFileAsync = promisify(execFile);

export const CREDENTIAL_STORE_BACKENDS = Object.freeze({
  darwin: "macos_keychain",
  win32: "windows_credential_manager",
  linux: "linux_secret_service"
});

const ERROR_CODES = new Set([
  "credential_missing", "credential_access_denied", "credential_store_unavailable",
  "credential_read_failed", "credential_read_cancelled"
]);

export class CredentialStoreError extends Error {
  constructor(code, { backend = null } = {}) {
    if (!ERROR_CODES.has(code)) throw new TypeError("CREDENTIAL_STORE_ERROR_CODE_INVALID");
    super(code);
    this.name = "CredentialStoreError";
    this.code = code;
    this.backend = backend;
  }
}

export function credentialStoreBackendFor(platform = process.platform) {
  return Object.hasOwn(CREDENTIAL_STORE_BACKENDS, platform) ? CREDENTIAL_STORE_BACKENDS[platform] : null;
}

export function isCredentialStorePlatformSupported(platform = process.platform) {
  return credentialStoreBackendFor(platform) !== null;
}

const label = value => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

function assertEntry(entry) {
  if (!entry || typeof entry !== "object" || !label(entry.service) || !label(entry.account)) {
    throw new TypeError("CREDENTIAL_STORE_ENTRY_INVALID");
  }
}

function assertCallOptions({ signal, timeout, maxBuffer } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal) ||
      timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0) ||
      maxBuffer !== undefined && !(Number.isInteger(maxBuffer) && maxBuffer > 0 && maxBuffer <= 1024 * 1024)) {
    throw new TypeError("CREDENTIAL_STORE_OPTIONS_INVALID");
  }
}

/** Windows target name, compatible with `cmdkey /generic:<service>/<account>`. */
export function windowsCredentialTarget({ service, account }) {
  assertEntry({ service, account });
  return `${service}/${account}`;
}

// CredReadW over P/Invoke. The target arrives through the environment, never the command line;
// exit 44 mirrors macOS errSecItemNotFound and 51 an access denial so all backends classify alike.
// Blobs are read as UTF-16, which is what cmdkey and the Credential Manager UI store.
const WINDOWS_READ_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -Namespace WbOzonCredentialStore -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr credential);
'@
$pointer = [IntPtr]::Zero
if (-not [WbOzonCredentialStore.Native]::CredReadW($env:WB_OZON_CREDENTIAL_TARGET, 1, 0, [ref]$pointer)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -eq 1168) { exit 44 }
  if ($code -eq 5) { exit 51 }
  exit 1
}
try {
  if ($env:WB_OZON_CREDENTIAL_MODE -eq 'read') {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][WbOzonCredentialStore.Native+CREDENTIAL])
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2)))
  }
} finally { [WbOzonCredentialStore.Native]::CredFree($pointer) }
exit 0`;

function windowsPowerShell(env) {
  const root = typeof env.SystemRoot === "string" && /^[A-Za-z]:\\[^\u0000-\u001f"]*$/u.test(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function commandFor(backend, entry, mode, env) {
  if (backend === "macos_keychain") {
    const args = mode === "read"
      ? ["find-generic-password", "-w", "-s", entry.service, "-a", entry.account]
      : ["find-generic-password", "-s", entry.service, "-a", entry.account];
    return { file: "/usr/bin/security", args, extra: {} };
  }
  if (backend === "linux_secret_service") {
    // libsecret has no metadata-only lookup; an existence check reads and discards the value in memory.
    return { file: "secret-tool", args: ["lookup", "service", entry.service, "account", entry.account], extra: {} };
  }
  return {
    file: windowsPowerShell(env),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_READ_SCRIPT],
    extra: { windowsHide: true, env: { ...env, WB_OZON_CREDENTIAL_TARGET: windowsCredentialTarget(entry), WB_OZON_CREDENTIAL_MODE: mode } }
  };
}

const isProcessFailure = error => Number.isInteger(error?.code) || ["ENOENT", "EACCES", "ABORT_ERR"].includes(error?.code) ||
  error?.killed === true || error?.name === "AbortError";

// Only the exit code, the error code and whether stderr was empty are inspected; the text never leaves here.
function classifyFailure(error, backend, signal) {
  if (signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") return new CredentialStoreError("credential_read_cancelled", { backend });
  if (error?.code === "ENOENT") return new CredentialStoreError("credential_store_unavailable", { backend });
  if (backend === "macos_keychain" || backend === "windows_credential_manager") {
    // security exit 44 is errSecItemNotFound; 51/128 are denied interaction/authentication.
    if (error?.code === 44) return new CredentialStoreError("credential_missing", { backend });
    if ([51, 128].includes(error?.code)) return new CredentialStoreError("credential_access_denied", { backend });
  }
  if (backend === "linux_secret_service" && error?.code === 1 && !String(error?.stderr ?? "").trim()) {
    // secret-tool exits 1 silently when nothing matches and prints a D-Bus error otherwise.
    return new CredentialStoreError("credential_missing", { backend });
  }
  return new CredentialStoreError("credential_read_failed", { backend });
}

/**
 * The operating system's credential store for this machine.
 * readSecret resolves to the process stdout untouched (callers keep their own value validation);
 * hasSecret resolves to true/false. Unrecognized failures (programming errors) are rethrown as is.
 */
export function createOsCredentialStore({ platform = process.platform, execFileImpl = execFileAsync, env = process.env } = {}) {
  if (typeof execFileImpl !== "function" || !env || typeof env !== "object") throw new TypeError("CREDENTIAL_STORE_CONFIGURATION_INVALID");
  const backend = credentialStoreBackendFor(platform);

  async function run(entry, mode, options = {}) {
    assertEntry(entry);
    assertCallOptions(options);
    if (!backend) throw new CredentialStoreError("credential_store_unavailable");
    const { signal, timeout, maxBuffer = 16 * 1024 } = options;
    if (signal?.aborted) throw new CredentialStoreError("credential_read_cancelled", { backend });
    const command = commandFor(backend, entry, mode, env);
    const execOptions = { encoding: "utf8", maxBuffer, ...command.extra };
    if (timeout !== undefined) execOptions.timeout = timeout;
    if (signal !== undefined) execOptions.signal = signal;
    try {
      return await execFileImpl(command.file, command.args, execOptions);
    } catch (error) {
      if (!isProcessFailure(error)) throw error;
      throw classifyFailure(error, backend, signal);
    }
  }

  return Object.freeze({
    backend,
    async readSecret(entry, options) {
      const result = await run(entry, "read", options);
      return typeof result === "string" ? result : result?.stdout;
    },
    async hasSecret(entry, options) {
      try {
        await run(entry, "inspect", options);
        return true;
      } catch (error) {
        if (error instanceof CredentialStoreError && error.code === "credential_missing") return false;
        throw error;
      }
    }
  });
}

/**
 * In-memory store for tests and synthetic fixtures. Entries are { service, account, value } or
 * { service, account, failure } where failure is a CredentialStoreError code. Calls record names only.
 */
export function createFakeCredentialStore(entries = [], { backend = "fake_credential_store" } = {}) {
  if (!Array.isArray(entries)) throw new TypeError("CREDENTIAL_STORE_FAKE_ENTRIES_INVALID");
  const table = new Map();
  for (const entry of entries) {
    assertEntry(entry);
    if (entry.failure !== undefined && !ERROR_CODES.has(entry.failure)) throw new TypeError("CREDENTIAL_STORE_FAKE_ENTRIES_INVALID");
    table.set(`${entry.service}\u0000${entry.account}`, Object.freeze({ value: entry.value, failure: entry.failure }));
  }
  const calls = [];
  function lookup(entry, mode, options = {}) {
    assertEntry(entry);
    assertCallOptions(options);
    calls.push(Object.freeze({ mode, service: entry.service, account: entry.account }));
    if (options.signal?.aborted) throw new CredentialStoreError("credential_read_cancelled", { backend });
    const found = table.get(`${entry.service}\u0000${entry.account}`);
    if (!found) throw new CredentialStoreError("credential_missing", { backend });
    if (found.failure) throw new CredentialStoreError(found.failure, { backend });
    return found.value;
  }
  return Object.freeze({
    backend,
    calls,
    async readSecret(entry, options) { return lookup(entry, "read", options); },
    async hasSecret(entry, options) {
      try { lookup(entry, "inspect", options); return true; }
      catch (error) { if (error.code === "credential_missing") return false; throw error; }
    }
  });
}
