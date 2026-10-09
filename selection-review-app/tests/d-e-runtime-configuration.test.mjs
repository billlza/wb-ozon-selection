import assert from "node:assert/strict";
import test from "node:test";
import { createSelectionReviewRuntimeConfiguration, normalizeDEServiceBindings, normalizeProductionBindings,
  normalizeStoreBindings } from "../lib/runtime-configuration.mjs";

const APP_DIR = "/synthetic-unavailable-directory/de-runtime-configuration";
const clone = value => structuredClone(value);
const storeBindings = normalizeStoreBindings(["dandanshu", "miska", "wb"].map(targetStore => ({
  targetStore, platform: targetStore === "wb" ? "wb" : "ozon",
  storeRef: { stableStoreId: targetStore, platformStoreId: `synthetic-${targetStore}`, mappingVersion: "stores-v1" }
})));

function production(index = 0, store = storeBindings[0]) {
  return { bindingId: `binding:synthetic:${index}`, configurationVersion: "production-config-v3", platform: store.platform,
    storeRef: clone(store.storeRef), storeName: `合成${store.targetStore}店铺`, warehouseName: "合成仓库",
    warehouseRef: `warehouse:synthetic:${index}`, warehouseId: String(70001 + index), credentialAlias: `alias:synthetic:${index}`,
    verification: { evidenceRef: `evidence:synthetic:config:${index}`, checkedAt: "2026-08-22T07:00:00.000Z", expiresAt: "2026-08-22T08:00:00.000Z" } };
}

function service(index = 0) {
  return { schemaVersion: "d-e-service-binding-v1", serviceId: `service:synthetic:${index}`, configurationVersion: "service-config-v5",
    productionBindingId: `binding:synthetic:${index}`, productionConfigurationVersion: "production-config-v3",
    workerId: `worker:synthetic:${index}`, workerVersion: "worker-version-v2", leaseDurationMs: 60_000 };
}

const productionBindings = normalizeProductionBindings([production(0), production(1, storeBindings[1])], storeBindings);
const baseEnv = { SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify(storeBindings),
  SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify(productionBindings) };
const configuration = (env = {}) => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
const invalid = error => /DE_SERVICE_CONFIGURATION_INVALID/.test(error.message) && !error.message.includes("synthetic-private-value");

test("D/E默认空接线，配置加载不读取不存在的业务目录、不调用网络或证明凭据健康", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected configuration network request"); });
  const result = configuration();
  assert.deepEqual(result.deServiceBindings, []); assert.ok(Object.isFrozen(result.deServiceBindings));
  assert.deepEqual(result.ozonDECredentialBindings, []);
  assert.equal(result.ossRuntimeConfiguration, null);
  const configured = configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([service()]) });
  assert.deepEqual(configured.deServiceBindings, [service()]);
  assert.equal(fetch.mock.callCount(), 0);
  for (const field of ["health", "credentialVerified", "authorizationRecord", "paymentAuthorization", "transport"]) {
    assert.equal(Object.hasOwn(configured.deServiceBindings[0], field), false);
  }
  // Loading preserves a declaration even after its evidence expires. Current admission owns freshness.
  assert.equal(configured.productionBindings[0].verification.expiresAt, productionBindings[0].verification.expiresAt);
});

test("正式提供器的非秘密配置显式加载，未知JSON不静默回落", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected provider configuration request"); });
  const credentials = [{ credentialAlias: productionBindings[0].credentialAlias, clientId: "700123",
    keychainService: "synthetic-service", keychainAccount: "synthetic-seller-api" }];
  const oss = { region: "oss-cn-beijing", endpoint: "https://oss-cn-beijing.aliyuncs.com",
    bucket: "synthetic-review-assets", publicBaseUrl: "https://synthetic-review-assets.oss-cn-beijing.aliyuncs.com",
    objectPrefix: "final-assets/", keychainService: "synthetic-oss",
    keychainAccounts: { accessKeyId: "synthetic-key-id-account", accessKeySecret: "synthetic-key-secret-account" } };
  const configured = configuration({ ...baseEnv,
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify(credentials),
    SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON: JSON.stringify(oss) });
  assert.deepEqual(configured.ozonDECredentialBindings, credentials);
  assert.deepEqual(configured.ossRuntimeConfiguration, oss);
  assert.ok(Object.isFrozen(configured.ozonDECredentialBindings));
  assert.ok(Object.isFrozen(configured.ossRuntimeConfiguration));
  assert.equal(fetch.mock.callCount(), 0);
  for (const name of ["SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON", "SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON"]) {
    assert.throws(() => configuration({ ...baseEnv, [name]: "{synthetic-private-invalid-json" }),
      error => error.message.startsWith("RUNTIME_CONFIGURATION_INVALID:") && !error.message.includes("synthetic-private"));
  }
});

test("两个店铺服务独立绑定，服务版本与生产版本分开并返回不可变副本", () => {
  const bindings = [service(), service(1)], before = clone(bindings);
  const result = normalizeDEServiceBindings(bindings, productionBindings);
  assert.deepEqual(result, bindings); assert.deepEqual(bindings, before); assert.notEqual(result, bindings);
  assert.ok(Object.isFrozen(result)); assert.ok(result.every(Object.isFrozen));
  assert.notEqual(result[0].configurationVersion, result[0].productionConfigurationVersion);
  assert.notEqual(result[0].workerId, result[1].workerId);
  assert.notEqual(productionBindings[0].storeRef.platformStoreId, productionBindings[1].storeRef.platformStoreId);
  assert.deepEqual(configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify(bindings) }).deServiceBindings, result);
});

test("新增D/E配置不改变已配置C1网关及其余运行配置", () => {
  const c1 = { schemaVersion: "c1-draft-service-binding-v1", provider: "terra", modelVersion: "gpt-5.6-terra",
    credentialAlias: "alias:synthetic:c1", workerId: "worker:synthetic:c1", workerVersion: "worker-v1",
    gatewayOrigin: "http://127.0.0.1:4318", configurationVersion: "gateway-v1", leaseDurationMs: 90_000 };
  const env = { ...baseEnv, SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([c1]) };
  const { deServiceBindings: absent, ...baseline } = configuration(env);
  const { deServiceBindings: present, ...withDE } = configuration({ ...env, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([service()]) });
  assert.deepEqual(absent, []); assert.deepEqual(present, [service()]);
  assert.deepEqual(withDE, baseline); assert.deepEqual(withDE.c1DraftServiceBindings, [c1]);
});

test("服务、Worker与生产绑定引用分别唯一，未知或失配生产版本及WB拒绝", () => {
  for (const field of ["serviceId", "workerId", "productionBindingId"]) {
    const other = service(1); other[field] = service()[field];
    assert.throws(() => normalizeDEServiceBindings([service(), other], productionBindings), invalid);
  }
  for (const change of [b => { b.productionBindingId = "binding:unknown"; }, b => { b.productionConfigurationVersion += "-other"; }]) {
    const binding = service(); change(binding); assert.throws(() => normalizeDEServiceBindings([binding], productionBindings), invalid);
  }
  assert.throws(() => normalizeDEServiceBindings([service()], [productionBindings[0], productionBindings[0]]), invalid);
  assert.throws(() => normalizeDEServiceBindings([service()], []), invalid);
  const wb = normalizeProductionBindings([production(0, storeBindings[2])], storeBindings);
  assert.throws(() => normalizeDEServiceBindings([service()], wb), invalid);
});

test("闭集必填字段、schema、引用与秘密输入严格拒绝且错误不回显输入", () => {
  for (const field of Object.keys(service())) {
    const binding = service(); delete binding[field]; assert.throws(() => normalizeDEServiceBindings([binding], productionBindings), invalid);
  }
  for (const field of ["serviceId", "configurationVersion", "productionBindingId", "productionConfigurationVersion", "workerId", "workerVersion"]) {
    for (const value of [null, "", "unknown", "not_applicable", "x".repeat(257), " leading-space", "https://example.com/reference",
      "token=synthetic-private-value", "Bearer synthetic-private-value", "ref%0asecret"]) {
      assert.throws(() => normalizeDEServiceBindings([{ ...service(), [field]: value }], productionBindings), invalid);
    }
  }
  for (const binding of [{ ...service(), schemaVersion: "d-e-service-binding-v2" }, { ...service(), token: "synthetic-private-value" },
    { ...service(), rawResponse: {} }, { ...service(), health: "ready" }, { ...service(), amount: 1 }]) {
    assert.throws(() => normalizeDEServiceBindings([binding], productionBindings), invalid);
  }
  for (const value of [null, {}, false, "[]"]) assert.throws(() => normalizeDEServiceBindings(value, productionBindings), invalid);
  for (const value of [null, {}, false]) assert.throws(() => normalizeDEServiceBindings([], value), invalid);
});

test("租约使用既有generic作业1000至1800000毫秒边界，拒绝小数和隐式转换", () => {
  for (const leaseDurationMs of [1000, 1_800_000]) {
    assert.equal(normalizeDEServiceBindings([{ ...service(), leaseDurationMs }], productionBindings)[0].leaseDurationMs, leaseDurationMs);
  }
  for (const leaseDurationMs of [999, 1_800_001, 0, -1, 1000.5, "1000", null, NaN, Infinity]) {
    assert.throws(() => normalizeDEServiceBindings([{ ...service(), leaseDurationMs }], productionBindings), invalid);
  }
});

test("最多100项接线与生产配置上限一致", () => {
  const productions = normalizeProductionBindings(Array.from({ length: 100 }, (_, index) => production(index)), storeBindings);
  const services = Array.from({ length: 100 }, (_, index) => service(index));
  assert.equal(normalizeDEServiceBindings(services, productions).length, 100);
  assert.throws(() => normalizeDEServiceBindings([...services, service(100)], productions), invalid);
  assert.throws(() => normalizeDEServiceBindings([], [...productions, production(100)]), invalid);
});

test("环境变量无效JSON或非数组显式失败，不回落空配置，不吞未知解析异常", () => {
  for (const value of ["", "broken-json", "null", "{}", "false", "1", JSON.stringify([{ ...service(), secret: "synthetic-private-value" }])]) {
    assert.throws(() => configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: value }), invalid);
  }
  assert.throws(() => configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "broken-json" }),
    /SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON必须是有效JSON数组/);
  const unexpected = new TypeError("synthetic conversion error");
  assert.throws(() => configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: { toString() { throw unexpected; } } }), error => error === unexpected);
});

// r70 ④：店铺级默认观察策略。
// 由来：r69 那道严格门（没有可用策略就拒绝上架）的代价是——**每上架一个新品，
// 都要先在 plist 里给它加一条策略并重启服务**（见 r69 卡 3.3）。
// 加一层按「生产绑定 + 配置版本」匹配的默认值，新品就不必逐个配；
// 想给某个品特殊窗口，配一条逐品策略即可盖过默认。
test("④ 店铺级默认策略：新品无逐品配置时可用，逐品配置优先，旧配置照常加载", async () => {
  const { normalizeDPlatformObservationConfiguration, createDPlatformObservationPolicyResolver } =
    await import("../lib/runtime-configuration.mjs");
  const policy = (ref, maxQueries) => ({ schemaVersion: "d-platform-observation-policy-v1",
    policyRef: ref, version: "version:1", maxQueries, intervalMs: 30_000,
    requestTimeoutMs: 30_000, expiresAt: "2099-01-01T00:00:00.000Z" });
  const job = { skuPackageId: "sku:synthetic:new", scopeBinding: { productionBinding:
    { bindingId: "binding:synthetic:0", configurationVersion: "production-config-v3" } } };
  const candidate = { id: "candidate:synthetic:new" };

  // a) 旧配置（没有 defaults 键）照常加载——不能因为新增可选键就判旧配置无效
  const legacy = normalizeDPlatformObservationConfiguration({ policies: [], pumpIntervalMs: 1000 }, productionBindings);
  assert.deepEqual(legacy.defaults, []);
  assert.equal(createDPlatformObservationPolicyResolver({ dPlatformObservation: legacy })({ candidate, job }), null);

  // b) 只有店铺级默认：新品直接可用，不必逐个配
  const withDefault = normalizeDPlatformObservationConfiguration({ policies: [], pumpIntervalMs: 1000,
    defaults: [{ productionBindingId: "binding:synthetic:0", productionConfigurationVersion: "production-config-v3",
      policy: policy("policy:store-default", 50) }] }, productionBindings);
  const resolved = createDPlatformObservationPolicyResolver({ dPlatformObservation: withDefault })({ candidate, job });
  assert.equal(resolved.policyRef, "policy:store-default");
  assert.equal(resolved.maxQueries, 50);

  // c) 逐品配置优先于默认
  const both = normalizeDPlatformObservationConfiguration({ pumpIntervalMs: 1000,
    policies: [{ candidateId: candidate.id, skuPackageId: job.skuPackageId,
      authorizationRef: "production-auth:synthetic:one", productionBindingId: "binding:synthetic:0",
      productionConfigurationVersion: "production-config-v3", revision: 3, policy: policy("policy:per-sku", 7) }],
    defaults: [{ productionBindingId: "binding:synthetic:0", productionConfigurationVersion: "production-config-v3",
      policy: policy("policy:store-default", 50) }] }, productionBindings);
  assert.equal(createDPlatformObservationPolicyResolver({ dPlatformObservation: both })({ candidate, job }).policyRef,
    "policy:per-sku");

  // d) 另一个绑定的默认不会被错用
  const otherJob = { ...job, scopeBinding: { productionBinding:
    { bindingId: "binding:synthetic:1", configurationVersion: "production-config-v3" } } };
  assert.equal(createDPlatformObservationPolicyResolver({ dPlatformObservation: withDefault })({ candidate, job: otherJob }), null);

  // e) 同一绑定两条默认：按歧义失败停，不随便挑一条
  assert.throws(() => normalizeDPlatformObservationConfiguration({ policies: [], pumpIntervalMs: 1000,
    defaults: [
      { productionBindingId: "binding:synthetic:0", productionConfigurationVersion: "production-config-v3", policy: policy("a", 5) },
      { productionBindingId: "binding:synthetic:0", productionConfigurationVersion: "production-config-v3", policy: policy("b", 5) }
    ] }, productionBindings), /AMBIGUOUS/);

  // f) 默认也要求绑定真实存在
  assert.throws(() => normalizeDPlatformObservationConfiguration({ policies: [], pumpIntervalMs: 1000,
    defaults: [{ productionBindingId: "binding:synthetic:missing",
      productionConfigurationVersion: "production-config-v3", policy: policy("c", 5) }] }, productionBindings),
    /BINDING_CONFLICT/);

  // g) 有默认却没配泵节拍：照旧拒绝
  assert.throws(() => normalizeDPlatformObservationConfiguration({ policies: [], pumpIntervalMs: null,
    defaults: [{ productionBindingId: "binding:synthetic:0",
      productionConfigurationVersion: "production-config-v3", policy: policy("d", 5) }] }, productionBindings),
    /PUMP_CONFIGURATION_REQUIRED/);
});

// r70 部署失败的那一条：④ 只放宽了 normalizeDPlatformObservationConfiguration 里的键校验，
// 却漏了 createSelectionReviewRuntimeConfiguration 里**重复的一份**——
// 服务带着 defaults 启动即抛 D_OBSERVATION_CONFIGURATION_INVALID，反复重启、端口不监听。
//
// 当时的用例只直接调 normalize，**根本走不到那道重复校验**。
// 这一条必须从**真正的配置入口**（读环境变量那条路）进，否则同样的漏改还会发生。
test("④ 带 defaults 的环境变量必须能从真正的配置入口加载（r70 部署失败的那一条）", () => {
  const storeRef = { stableStoreId: "miska", platformStoreId: "p-miska", mappingVersion: "stores-v1" };
  const policy = { schemaVersion: "d-platform-observation-policy-v1", policyRef: "policy:store-default",
    version: "version:1", maxQueries: 100, intervalMs: 30_000, requestTimeoutMs: 30_000,
    expiresAt: "2099-01-01T00:00:00.000Z" };
  const env = {
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: "miska", platform: "ozon", storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([{ bindingId: "binding:x", configurationVersion: "config:x",
      platform: "ozon", storeRef, storeName: "店", warehouseName: "仓", warehouseRef: "warehouse:x",
      warehouseId: "70001", credentialAlias: "alias:x",
      verification: { evidenceRef: "evidence:x", checkedAt: "2026-08-22T07:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } }]),
    SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: JSON.stringify({ policies: [], pumpIntervalMs: 1000,
      defaults: [{ productionBindingId: "binding:x", productionConfigurationVersion: "config:x", policy }] })
  };
  const configuration = createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
  assert.equal(configuration.dPlatformObservation.defaults.length, 1);
  assert.equal(configuration.dPlatformObservation.defaults[0].policy.policyRef, "policy:store-default");

  // 没有 defaults 的旧形状同样要能从这条入口加载
  const legacyEnv = { ...env,
    SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: JSON.stringify({ policies: [], pumpIntervalMs: 1000 }) };
  assert.deepEqual(createSelectionReviewRuntimeConfiguration({ env: legacyEnv, appDir: APP_DIR, argv: [] })
    .dPlatformObservation.defaults, []);

  // 表外的键仍须拒绝——删掉重复校验不等于放行任意键
  const badEnv = { ...env,
    SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: JSON.stringify({ policies: [], pumpIntervalMs: 1000, whatever: 1 }) };
  assert.throws(() => createSelectionReviewRuntimeConfiguration({ env: badEnv, appDir: APP_DIR, argv: [] }),
    /D_OBSERVATION_CONFIGURATION_INVALID/);
});
