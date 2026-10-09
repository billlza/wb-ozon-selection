import assert from "node:assert/strict";
import test from "node:test";

import {
  createSelectionReviewRuntimeConfiguration,
  normalizeKeywordEvidenceServiceBindings,
  normalizeOzonCommissionReferenceConfiguration,
  normalizeServiceOrigin
} from "../lib/runtime-configuration.mjs";

const APP_DIR = "/tmp/selection-review-runtime-test";

test("editorial proposal files are explicitly configured local paths, never implicit recovery jobs", () => {
  const build = env => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
  assert.equal(build({}).c1EditorialProposalFile, null);
  assert.equal(build({ SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE: "/tmp/review/proposal.json" }).c1EditorialProposalFile,
    "/tmp/review/proposal.json");
  for (const value of ["", "proposal.json", " /tmp/proposal.json", "/tmp/proposal.json\0"]) {
    assert.throws(() => build({ SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE: value }), /RUNTIME_CONFIGURATION_INVALID/);
  }
});

test("GUOO新测算统一采用项目8月19版，路径可配置但旧版本不得悄然启用", () => {
  const build = env => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
  const defaults = build({});
  assert.equal(defaults.guooTariffRuleVersion, "guoo-2026-08-19");
  assert.equal(defaults.guooTariffFile, `${APP_DIR}/data/logistics/GUOO产品资费测算表【2026.8.19更新】.xlsx`);
  const mounted = "/mnt/tariffs/GUOO-2026.8.19.xlsx";
  assert.equal(build({ SELECTION_REVIEW_GUOO_TARIFF_FILE: mounted }).guooTariffFile, mounted);
  assert.throws(() => build({ SELECTION_REVIEW_GUOO_TARIFF_FILE: "/mnt/tariffs/GUOO-2026.7.20.xlsx" }), /GUOO_TARIFF_PROJECT_VERSION_MISMATCH/);
  assert.throws(() => build({ SELECTION_REVIEW_GUOO_TARIFF_FILE: "" }), /INVALID/);
});

const keywordBinding = {
  schemaVersion: "c1-keyword-service-binding-v1", serviceId: "keyword-service:test",
  configurationVersion: "test-v1", provider: "seerfar_open_api", workerId: "keyword-worker:test",
  workerVersion: "test-v1", leaseDurationMs: 90_000, pumpIntervalMs: 1_000, requestTimeoutMs: 20_000
};

test("关键词执行器默认未配置，显式配置不检查凭据且不可放宽字段或时间边界", () => {
  assert.deepEqual(createSelectionReviewRuntimeConfiguration({ env: {}, appDir: APP_DIR, argv: [] }).keywordEvidenceServiceBindings, []);
  const valid = normalizeKeywordEvidenceServiceBindings([keywordBinding]);
  assert.deepEqual(valid, [keywordBinding]);
  assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid[0]));
  for (const input of [null, {}, [keywordBinding, keywordBinding], [{ ...keywordBinding, provider: "seerfar_api" }],
    [{ ...keywordBinding, token: "must-not-appear" }], [{ ...keywordBinding, pumpIntervalMs: 0 }],
    [{ ...keywordBinding, pumpIntervalMs: 2_147_483_648 }], [{ ...keywordBinding, leaseDurationMs: 0 }],
    [{ ...keywordBinding, requestTimeoutMs: Infinity }], [{ ...keywordBinding, requestTimeoutMs: "20000" }]]) {
    assert.throws(() => normalizeKeywordEvidenceServiceBindings(input), error =>
      /C1_KEYWORD_SERVICE_CONFIGURATION_INVALID/.test(error.message) && !error.message.includes("must-not-appear"));
  }
});

test("关键词配置必须是有效JSON且不能借用草稿服务Worker", () => {
  const key = "SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON";
  const config = env => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
  assert.deepEqual(config({ [key]: JSON.stringify([keywordBinding]) }).keywordEvidenceServiceBindings, [keywordBinding]);
  for (const value of ["", "{broken", "null", "{}"]) {
    assert.throws(() => config({ [key]: value }), /C1_KEYWORD_SERVICE_CONFIGURATION_INVALID/);
  }
  const draft = { schemaVersion: "c1-draft-service-binding-v1", provider: "terra", modelVersion: "gpt-5.6-terra",
    credentialAlias: "draft-credential:test", workerId: keywordBinding.workerId, workerVersion: "test-v1",
    gatewayOrigin: "http://127.0.0.1:34318", configurationVersion: "test-v1", leaseDurationMs: 90_000 };
  assert.throws(() => config({ [key]: JSON.stringify([keywordBinding]),
    SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([draft]) }), /关键词服务必须使用独立Worker/);
});

test("店铺映射必须显式配置，缺省未绑定，非法JSON不静默回退", () => {
  const binding = { targetStore: "dandanshu", platform: "ozon", storeRef: { stableStoreId: "dandanshu", platformStoreId: "synthetic-001", mappingVersion: "synthetic-v1" } };
  const config = createSelectionReviewRuntimeConfiguration({ env: { SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([binding]) }, appDir: APP_DIR, argv: [] });
  assert.deepEqual(config.storeBindings, [binding]);
  assert.ok(Object.isFrozen(config.storeBindings[0].storeRef));
  assert.deepEqual(createSelectionReviewRuntimeConfiguration({ env: {}, appDir: APP_DIR, argv: [] }).storeBindings, []);
  for (const value of ["", "broken-json", "null", "{}", JSON.stringify([{ ...binding, token: "must-not-appear" }])]) {
    assert.throws(() => createSelectionReviewRuntimeConfiguration({ env: { SELECTION_REVIEW_STORE_BINDINGS_JSON: value }, appDir: APP_DIR, argv: [] }), error => /INVALID/.test(error.message) && !error.message.includes("must-not-appear"));
  }
});

test("本地开发保留4317、JSON和显式开发身份，但所有值都经过运行配置", () => {
  const config = createSelectionReviewRuntimeConfiguration({ env: {}, appDir: APP_DIR, argv: [] });
  assert.equal(config.deploymentMode, "local_development");
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.port, 4317);
  assert.equal(config.publicOrigin, "http://127.0.0.1:4317");
  assert.deepEqual(config.allowedExtensionOrigins, []);
  assert.equal(config.stateAdapter, "json");
  assert.equal(config.initializeDataFile, false);
  assert.equal(config.defaultUserId, "local-development-owner");
  assert.equal(config.aiGatewayUrl, "http://127.0.0.1:4318");
  assert.equal(config.ozonEvidenceServiceUrl, "http://127.0.0.1:4173");
  assert.match(config.dataFile, /selection-review-runtime-test\/data\/candidates\.json$/);
});

test("本地主人口令仅显式启用，私有文件与源码、业务状态、流程图和素材目录隔离", () => {
  const base = { SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: "/tmp/owner-private-test/owner.json" };
  const config = createSelectionReviewRuntimeConfiguration({ env: base, appDir: APP_DIR, argv: [] });
  assert.equal(config.localOwnerIdentity.credentialFile, base.SELECTION_REVIEW_OWNER_IDENTITY_FILE);
  assert.ok(Object.isFrozen(config.localOwnerIdentity));
  for (const env of [
    { ...base, SELECTION_REVIEW_OWNER_IDENTITY_FILE: undefined }, { ...base, SELECTION_REVIEW_OWNER_IDENTITY_FILE: "relative.json" },
    { ...base, SELECTION_REVIEW_OWNER_IDENTITY_FILE: `${APP_DIR}/private/owner.json` },
    { ...base, SELECTION_REVIEW_DATA_FILE: "/tmp/owner-private-test/data.json" },
    { ...base, SELECTION_REVIEW_DATA_FILE: "/tmp/business-test/data.json", SELECTION_REVIEW_OWNER_IDENTITY_FILE: "/tmp/business-test/private/owner.json" },
    { ...base, SELECTION_REVIEW_WORKFLOW_MAP_FILE: "/tmp/owner-private-test/map.json" },
    { ...base, SELECTION_REVIEW_C2_UPLOAD_DIR: "/tmp/owner-private-test" },
    { ...base, SELECTION_REVIEW_BIND_HOST: "0.0.0.0" }
  ]) assert.throws(() => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] }), /RUNTIME_CONFIGURATION_INVALID/);
});

test("缺失数据文件只能通过显式初始化开关创建，不能默认为空业务状态", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_INITIALIZE_DATA_FILE: "true" },
    appDir: APP_DIR,
    argv: []
  });
  assert.equal(config.initializeDataFile, true);
});

test("Chrome扩展来源必须由显式配置固定，默认不信任任意扩展", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: {
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    appDir: APP_DIR,
    argv: []
  });
  assert.deepEqual(config.allowedExtensionOrigins, ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/path" },
    appDir: APP_DIR,
    argv: []
  }), /固定Chrome扩展origin/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "https://extension.example" },
    appDir: APP_DIR,
    argv: []
  }), /固定Chrome扩展origin/);
});

test("本地开发身份没有认证边界，因此只能监听回环地址", () => {
  for (const bindHost of ["0.0.0.0", "::", "192.168.1.20"]) {
    assert.throws(() => createSelectionReviewRuntimeConfiguration({
      env: { SELECTION_REVIEW_BIND_HOST: bindHost }, appDir: APP_DIR, argv: []
    }), /本地开发模式只能绑定回环地址/);
  }
  assert.equal(createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_BIND_HOST: "::1" }, appDir: APP_DIR, argv: []
  }).bindHost, "::1");
});

test("API测试监听端口不会悄悄改写评审台页面来源", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_API_PORT: "31338" },
    appDir: APP_DIR,
    argv: ["node", "server.mjs", "--api-only"]
  });
  assert.equal(config.port, 31338);
  assert.equal(config.publicOrigin, "http://127.0.0.1:4317");
  assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:4317"]);
});

test("API-only开发端口不再占用正式AI网关4318", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: {}, appDir: APP_DIR, argv: ["node", "server.mjs", "--api-only"]
  });
  assert.equal(config.port, 4319);
  assert.equal(config.aiGatewayUrl, "http://127.0.0.1:4318");
});

test("中央模式拒绝回环地址、单进程JSON和开发默认身份", () => {
  const base = {
    SELECTION_REVIEW_RUNTIME_MODE: "central_test",
    SELECTION_REVIEW_BIND_HOST: "0.0.0.0",
    SELECTION_REVIEW_PUBLIC_ORIGIN: "https://review.internal.example",
    SELECTION_REVIEW_AI_GATEWAY_URL: "https://ai.internal.example",
    SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: "https://ozon-evidence.internal.example",
    SELECTION_REVIEW_IDENTITY_PROVIDER: "company_sso",
    SELECTION_REVIEW_DEFAULT_USER_ID: "team-user",
    SELECTION_REVIEW_STATE_ADAPTER: "postgres"
  };
  const config = createSelectionReviewRuntimeConfiguration({ env: base, appDir: APP_DIR, argv: [] });
  assert.equal(config.deploymentMode, "central_test");
  assert.equal(config.stateAdapter, "postgres");
  assert.equal(config.publicOrigin, "https://review.internal.example");

  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { ...base, SELECTION_REVIEW_STATE_ADAPTER: "json" }, appDir: APP_DIR, argv: []
  }), /中央模式必须使用并发安全的中央存储/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { ...base, SELECTION_REVIEW_BIND_HOST: "127.0.0.1" }, appDir: APP_DIR, argv: []
  }), /不得隐式绑定本机回环地址/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { ...base, SELECTION_REVIEW_IDENTITY_PROVIDER: "development_default" }, appDir: APP_DIR, argv: []
  }), /正式身份提供器/);
});

test("AI网关远程地址只能由运行配置显式提供，中央模式必须HTTPS且URL不得带凭据", () => {
  assert.equal(normalizeServiceOrigin("http://localhost:4318/path?ignored=yes", {
    deploymentMode: "local_development"
  }), "http://localhost:4318");
  assert.equal(normalizeServiceOrigin("https://ai.internal.example/v1", {
    deploymentMode: "central_test"
  }), "https://ai.internal.example");
  assert.throws(() => normalizeServiceOrigin("http://ai.internal.example", {
    deploymentMode: "central_test"
  }), /中央模式必须使用非本机HTTPS/);
  assert.throws(() => normalizeServiceOrigin("https://user:secret@ai.internal.example", {
    deploymentMode: "central_test"
  }), /不得包含凭据/);
});
test("独立E消费者仅接受显式受限间隔，不借用D观察配置", () => {
  const create = env => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
  assert.equal(create({}).eReadbackPumpIntervalMs, null);
  for (const value of ["1000", "5000", "2147483647"]) {
    assert.equal(create({ SELECTION_REVIEW_E_READBACK_PUMP_INTERVAL_MS: value }).eReadbackPumpIntervalMs, Number(value));
  }
  for (const value of ["", "null", "0", "999", "-1", "1000.0", "1e3", "2147483648", " 1000", 1000, undefined]) {
    assert.throws(() => create({ SELECTION_REVIEW_E_READBACK_PUMP_INTERVAL_MS: value }), /E_READBACK_RUNTIME_CONFIGURATION_INVALID/);
  }
});

test("Ozon官方佣金参考表配置默认未启用，显式配置要求绝对路径和CN卖家范围", () => {
  const create = env => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
  assert.equal(create({}).ozonCommissionReference, null);

  const catalogPath = "/private/tmp/ozon-commission-reference-test/ozon-china-2026-09-10.json";
  const config = create({ SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON: JSON.stringify({ catalogPath, sellerRegion: "CN" }) });
  assert.deepEqual(config.ozonCommissionReference, { catalogPath, sellerRegion: "CN", versionState: null });
  assert.ok(Object.isFrozen(config.ozonCommissionReference));

  // Explicit JSON null mirrors the OSS runtime configuration convention: still "not configured", not an error.
  assert.equal(create({ SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON: "null" }).ozonCommissionReference, null);
  for (const value of ["", "broken-json"]) {
    assert.throws(() => create({ SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON: value }),
      /OZON_COMMISSION_REFERENCE_CONFIGURATION_INVALID/);
  }
  for (const bad of [
    { catalogPath, sellerRegion: "CN", extra: "must-not-appear" },
    { catalogPath: "relative/ozon-china.json", sellerRegion: "CN" },
    { catalogPath, sellerRegion: "RU" },
    { catalogPath: "", sellerRegion: "CN" },
    { catalogPath: `${catalogPath} `, sellerRegion: "CN" },
    { sellerRegion: "CN" }
  ]) {
    assert.throws(() => create({ SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON: JSON.stringify(bad) }),
      error => /OZON_COMMISSION_REFERENCE_CONFIGURATION_INVALID/.test(error.message) && !error.message.includes("must-not-appear"));
  }
});

test("normalizeOzonCommissionReferenceConfiguration resolves a clean absolute path and rejects a non-absolute one directly", () => {
  assert.equal(normalizeOzonCommissionReferenceConfiguration(null), null);
  assert.equal(normalizeOzonCommissionReferenceConfiguration(undefined), null);
  const normalized = normalizeOzonCommissionReferenceConfiguration({ catalogPath: "/tmp/a/../a/ozon.json", sellerRegion: "CN" });
  assert.equal(normalized.catalogPath, "/tmp/a/ozon.json");
  assert.throws(() => normalizeOzonCommissionReferenceConfiguration({ catalogPath: "ozon.json", sellerRegion: "CN" }),
    /OZON_COMMISSION_REFERENCE_CONFIGURATION_INVALID/);
});

test("Ozon commission reference configuration binds an optional saved official version state", () => {
  const base = { catalogPath: "/tmp/synthetic/ozon-official-commission.json", sellerRegion: "CN" };
  assert.equal(normalizeOzonCommissionReferenceConfiguration(base).versionState, null);
  const state = { fileSha256: "a".repeat(64), effectiveFrom: "2025-12-01", status: "active" };
  const bound = normalizeOzonCommissionReferenceConfiguration({ ...base, versionState: state });
  assert.deepEqual(bound.versionState, state); assert.ok(Object.isFrozen(bound.versionState));
  for (const bad of [{ ...state, status: "revoked" }, { ...state, fileSha256: "xyz" }, { ...state, effectiveFrom: "2025-13-01" }, { ...state, extra: 1 }, "active"]) {
    assert.throws(() => normalizeOzonCommissionReferenceConfiguration({ ...base, versionState: bad }), /OZON_COMMISSION_REFERENCE_CONFIGURATION_INVALID/);
  }
});
