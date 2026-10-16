import assert from "node:assert/strict";
import test from "node:test";

import { CredentialStoreError, createFakeCredentialStore } from "../lib/credential-store.mjs";
import { readAliyunOssKeychainSecret } from "../lib/aliyun-oss-asset-transport.mjs";
import { createLinkfoxDiscoverySecretReader } from "../lib/linkfox-discovery-credentials.mjs";
import { readOzonDEKeychainSecret } from "../lib/ozon-de-http-transport.mjs";
import { readSeerfarKeychainSecret } from "../lib/seerfar-runtime-connector.mjs";
import {
  SERVER_SECRET_BACKEND, configuredServerSecrets, createServerSecretStore, credentialStoreUsableIn, serverSecretVariableName
} from "../lib/server-secret-store.mjs";

// Every value below is synthetic. The "environment" is a plain object; nothing reads the real one.
const ozonBinding = { credentialAlias: "credential-alias:ozon:1", clientId: "123456", keychainService: "egg-ozon-operations-center",
  keychainAccount: "ozon-store-b-seller-api" };
const ozonVariable = "SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__OZON_STORE_B_SELLER_API";

test("a secret's setting name comes from the same service and account names the computer's own store uses", () => {
  assert.equal(serverSecretVariableName({ service: ozonBinding.keychainService, account: ozonBinding.keychainAccount }), ozonVariable);
  assert.equal(serverSecretVariableName({ service: "com.shuaizhang.wb-ozon-selection.aliyun-oss", account: "access-key-id" }),
    "SELECTION_REVIEW_SECRET__COM_SHUAIZHANG_WB_OZON_SELECTION_ALIYUN_OSS__ACCESS_KEY_ID");
  for (const entry of [null, {}, { service: "x" }, { service: " x", account: "y" }, { service: "---", account: "y" }]) {
    assert.throws(() => serverSecretVariableName(entry), /CREDENTIAL_STORE_ENTRY_INVALID/);
  }
});

test("the server store reads its settings, says which are missing, and never writes", async () => {
  const env = { [ozonVariable]: "synthetic-api-key\n", SELECTION_REVIEW_SECRET__EMPTY__ONE: "  " };
  const store = createServerSecretStore({ env });
  assert.equal(store.backend, SERVER_SECRET_BACKEND);
  const entry = { service: ozonBinding.keychainService, account: ozonBinding.keychainAccount };
  assert.equal(await store.readSecret(entry), "synthetic-api-key\n");
  assert.equal(await store.hasSecret(entry), true);
  for (const missing of [{ service: "empty", account: "one" }, { service: "absent", account: "one" }]) {
    assert.equal(await store.hasSecret(missing), false);
    await assert.rejects(store.readSecret(missing), error => error instanceof CredentialStoreError && error.code === "credential_missing" &&
      error.backend === SERVER_SECRET_BACKEND);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.readSecret(entry, { signal: controller.signal }), error => error.code === "credential_read_cancelled");
  await assert.rejects(store.writeSecret(entry, "anything"), error => error.code === "credential_write_failed");
  assert.equal(env[ozonVariable], "synthetic-api-key\n");
  assert.throws(() => createServerSecretStore({ env: null }), /CREDENTIAL_STORE_CONFIGURATION_INVALID/);
});

test("a central mode reads only the server's settings; local development reads any store", async () => {
  const server = createServerSecretStore({ env: { [ozonVariable]: "synthetic-api-key" } });
  const fake = createFakeCredentialStore([{ service: ozonBinding.keychainService, account: ozonBinding.keychainAccount, value: "synthetic-api-key" }]);
  assert.equal(credentialStoreUsableIn("central_test", server), true);
  assert.equal(credentialStoreUsableIn("central_production", fake), false);
  assert.equal(credentialStoreUsableIn("central_production", undefined), false);
  assert.equal(credentialStoreUsableIn("local_development", undefined), true);

  for (const runtimeMode of ["central_test", "central_production"]) {
    assert.equal(await readOzonDEKeychainSecret(ozonBinding, { runtimeMode, credentialStore: server }), "synthetic-api-key");
    await assert.rejects(readOzonDEKeychainSecret(ozonBinding, { runtimeMode, credentialStore: fake }),
      error => error.code === "OZON_DE_CREDENTIAL_READER_UNAVAILABLE");
  }
  await assert.rejects(readOzonDEKeychainSecret(ozonBinding, { runtimeMode: "central_test", credentialStore: createServerSecretStore({ env: {} }) }),
    error => error.code === "OZON_DE_CREDENTIAL_READ_FAILED");

  const discovery = { credentialAlias: "credential-alias:linkfox:1", keychainService: "egg-ozon-operations-center", keychainAccount: "linkfox-api" };
  const discoveryEnv = { SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__LINKFOX_API: "synthetic-linkfox" };
  const read = createLinkfoxDiscoverySecretReader({ bindings: [discovery], runtimeMode: "central_production",
    credentialStore: createServerSecretStore({ env: discoveryEnv }) });
  assert.equal(await read({ credentialAlias: discovery.credentialAlias, provider: "linkfox" }), "synthetic-linkfox");
  const refused = createLinkfoxDiscoverySecretReader({ bindings: [discovery], runtimeMode: "central_production",
    credentialStore: createFakeCredentialStore([{ service: discovery.keychainService, account: discovery.keychainAccount, value: "x" }]) });
  await assert.rejects(refused({ credentialAlias: discovery.credentialAlias, provider: "linkfox" }), /CREDENTIAL_UNAVAILABLE/);

  const seerfar = createServerSecretStore({ env: { SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__SEERFAR_OPEN_API: " synthetic-seerfar " } });
  assert.equal(await readSeerfarKeychainSecret({ credentialStore: seerfar }), "synthetic-seerfar");
  const oss = createServerSecretStore({ env: { SELECTION_REVIEW_SECRET__SYNTHETIC_OSS__ACCESS_KEY_ID: "synthetic-id" } });
  assert.equal(await readAliyunOssKeychainSecret("access-key-id", { service: "synthetic-oss", credentialStore: oss }), "synthetic-id");
});

test("the configuration lists every secret it needs with what it is for, and two that would share a name are refused", () => {
  const configuration = {
    ozonDECredentialBindings: [ozonBinding],
    aDiscoveryCredentialBindings: [{ credentialAlias: "credential-alias:linkfox:1", keychainService: "egg-ozon-operations-center", keychainAccount: "linkfox-api" }],
    aProductDetailCredentialBindings: [{ credentialAlias: "credential-alias:linkfox:1", keychainService: "egg-ozon-operations-center", keychainAccount: "linkfox-api" }],
    keywordEvidenceServiceBindings: [{ workerId: "keyword-worker:test" }],
    ossRuntimeConfiguration: { keychainService: "synthetic-oss", keychainAccounts: { accessKeyId: "access-key-id", accessKeySecret: "access-key-secret" } }
  };
  const secrets = configuredServerSecrets(configuration);
  assert.deepEqual(secrets.map(secret => secret.variable), [
    ozonVariable,
    "SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__LINKFOX_API",
    "SELECTION_REVIEW_SECRET__EGG_OZON_OPERATIONS_CENTER__SEERFAR_OPEN_API",
    "SELECTION_REVIEW_SECRET__SYNTHETIC_OSS__ACCESS_KEY_ID",
    "SELECTION_REVIEW_SECRET__SYNTHETIC_OSS__ACCESS_KEY_SECRET"
  ]);
  assert.match(secrets[0].purpose, /Ozon 店铺接口密钥.*Client ID 123456/u);
  assert.equal(JSON.stringify(secrets).includes("synthetic-api-key"), false);
  assert.deepEqual(configuredServerSecrets({ ozonDECredentialBindings: [], aDiscoveryCredentialBindings: [], aProductDetailCredentialBindings: [],
    keywordEvidenceServiceBindings: [], ossRuntimeConfiguration: null }), []);
  assert.throws(() => configuredServerSecrets({ ...configuration,
    aProductDetailCredentialBindings: [{ credentialAlias: "credential-alias:linkfox:2", keychainService: "egg.ozon.operations.center", keychainAccount: "linkfox-api" }] }),
  /同一个服务器密钥名/u);
});
