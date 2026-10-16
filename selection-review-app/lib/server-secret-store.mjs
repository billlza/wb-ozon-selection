import { CredentialStoreError } from "./credential-store.mjs";
import { SEERFAR_KEYCHAIN_ACCOUNT, SEERFAR_KEYCHAIN_SERVICE } from "./seerfar-runtime-connector.mjs";

// Central runtime credential boundary: the secrets typed into the server's own secret settings (on Render, the service's
// Environment page). Entries keep the names the local OS store uses (service + account), so the code that needs a secret
// is the same in both places; only where the value comes from changes. Each entry is one environment variable named by
// serverSecretVariableName. Read-only: nothing on a page can write a server secret. Values never leave readSecret.

export const SERVER_SECRET_BACKEND = "server_secret_settings";
export const SERVER_SECRET_VARIABLE_PREFIX = "SELECTION_REVIEW_SECRET__";

const label = value => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

function assertEntry(entry) {
  if (!entry || typeof entry !== "object" || !label(entry.service) || !label(entry.account)) {
    throw new TypeError("CREDENTIAL_STORE_ENTRY_INVALID");
  }
}

const part = value => value.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");

/** `egg-ozon-operations-center` + `seerfar-open-api` → `SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__SEERFAR_OPEN_API`. */
export function serverSecretVariableName(entry) {
  assertEntry(entry);
  const service = part(entry.service), account = part(entry.account);
  if (!service || !account) throw new TypeError("CREDENTIAL_STORE_ENTRY_INVALID");
  return `${SERVER_SECRET_VARIABLE_PREFIX}${service}__${account}`;
}

/** A central runtime reads only the server's secret settings, never a personal computer's store; local development reads either. */
export function credentialStoreUsableIn(runtimeMode, credentialStore) {
  return runtimeMode === "local_development" || credentialStore?.backend === SERVER_SECRET_BACKEND;
}

/** Every entry the configuration reads, with what it is for; two entries that would share one variable are refused. */
export function configuredServerSecrets(configuration) {
  const entries = [];
  const add = (purpose, service, account) => entries.push({ purpose, service, account });
  for (const binding of configuration?.ozonDECredentialBindings ?? []) {
    add(`Ozon 店铺接口密钥，${binding.credentialAlias}，Client ID ${binding.clientId}`, binding.keychainService, binding.keychainAccount);
  }
  for (const binding of configuration?.aDiscoveryCredentialBindings ?? []) {
    add(`找新品数据源密钥，${binding.credentialAlias}`, binding.keychainService, binding.keychainAccount);
  }
  for (const binding of configuration?.aProductDetailCredentialBindings ?? []) {
    add(`商品详情数据源密钥，${binding.credentialAlias}`, binding.keychainService, binding.keychainAccount);
  }
  if ((configuration?.keywordEvidenceServiceBindings ?? []).length) {
    add("Seerfar 开放接口密钥，查关键词用", SEERFAR_KEYCHAIN_SERVICE, SEERFAR_KEYCHAIN_ACCOUNT);
  }
  const oss = configuration?.ossRuntimeConfiguration;
  if (oss) {
    add("阿里云 OSS AccessKey ID", oss.keychainService, oss.keychainAccounts.accessKeyId);
    add("阿里云 OSS AccessKey Secret", oss.keychainService, oss.keychainAccounts.accessKeySecret);
  }
  const byVariable = new Map();
  for (const entry of entries) {
    const variable = serverSecretVariableName(entry);
    const held = byVariable.get(variable);
    if (held && (held.service !== entry.service || held.account !== entry.account)) {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 两条密钥会落到同一个服务器密钥名上，请改其中一条的名字");
    }
    if (!held) byVariable.set(variable, { ...entry, variable });
  }
  return Object.freeze([...byVariable.values()].map(entry => Object.freeze(entry)));
}

export function createServerSecretStore({ env = process.env } = {}) {
  if (!env || typeof env !== "object") throw new TypeError("CREDENTIAL_STORE_CONFIGURATION_INVALID");
  const backend = SERVER_SECRET_BACKEND;
  function lookup(entry, options = {}) {
    const variable = serverSecretVariableName(entry);
    if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError("CREDENTIAL_STORE_OPTIONS_INVALID");
    if (options?.signal?.aborted) throw new CredentialStoreError("credential_read_cancelled", { backend });
    const value = Object.hasOwn(env, variable) ? env[variable] : undefined;
    if (typeof value !== "string" || !value.trim()) throw new CredentialStoreError("credential_missing", { backend });
    return value;
  }
  return Object.freeze({
    backend,
    async readSecret(entry, options) { return lookup(entry, options); },
    async hasSecret(entry, options) {
      try { lookup(entry, options); return true; }
      catch (error) {
        if (error instanceof CredentialStoreError && error.code === "credential_missing") return false;
        throw error;
      }
    },
    async writeSecret(entry) {
      assertEntry(entry);
      throw new CredentialStoreError("credential_write_failed", { backend });
    }
  });
}
