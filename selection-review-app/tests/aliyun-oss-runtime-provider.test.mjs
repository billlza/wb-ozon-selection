import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAliyunOssRuntimeProvider, normalizeAliyunOssRuntimeConfiguration } from "../lib/aliyun-oss-runtime-provider.mjs";
import { readAliyunOssKeychainSecret } from "../lib/aliyun-oss-asset-transport.mjs";
import { AliyunOssLocalPreparationError } from "../lib/production-execution-failure.mjs";
import { CredentialStoreError } from "../lib/credential-store.mjs";
import { createC2LocalAssetStore } from "../lib/c2-local-asset-store.mjs";
import { authorizedProductionFixture, localFinalAssets } from "./helpers/c2-software-fixture.mjs";

const NOW = "2026-08-22T07:00:00.000Z";
const config = () => ({ region: "oss-cn-shanghai", endpoint: "https://oss-cn-shanghai.aliyuncs.com",
  bucket: "synthetic-runtime-assets", publicBaseUrl: "https://synthetic-runtime-assets.oss-cn-shanghai.aliyuncs.com",
  objectPrefix: "synthetic-runtime/final/", keychainService: "synthetic.oss.runtime",
  keychainAccounts: { accessKeyId: "runtime-id", accessKeySecret: "runtime-secret" } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "oss-runtime-synthetic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createC2LocalAssetStore({ directory });
  const registrations = [];
  for (const asset of localFinalAssets()) {
    const body = await sharp({ create: { width: 1200, height: 1600, channels: 3,
      background: asset.order === 1 ? "white" : "gray" } }).jpeg().toBuffer();
    registrations.push({ ...asset, ...await store.write({
      assetId: asset.assetId, fileName: asset.fileName, contentType: "image/jpeg", stagedAt: NOW
    }, body) });
  }
  const source = authorizedProductionFixture({ assets: registrations });
  const authorization = source.productionAuthorization;
  const candidate = { id: source.candidateId, dataRevision: source.candidateRevision, lifecycleV11: {
    skuPackage: source.skuPackage,
    c2UploadDraft: { schemaVersion: "c2-upload-draft-v1", candidateId: source.candidateId,
      skuPackageId: source.skuPackage.skuPackageId, sourceC1Fingerprint: authorization.sourceC1Fingerprint,
      schemaEvidenceRef: authorization.lockedScope.schemaEvidenceRef,
      uploads: registrations.map(asset => ({ ...asset, status: "ready" })),
      selection: registrations.map(({ assetId, order }) => ({ assetId, order })) }
  } };
  return { store, candidate, assets: authorization.lockedScope.finalUploads };
}

function syntheticDependencies(f, overrides = {}) {
  const events = [], objects = new Map();
  class Client {
    constructor(options) {
      events.push("client");
      assert.equal(options.bucket, config().bucket); assert.equal(options.endpoint, config().endpoint);
      assert.equal(options.region, config().region); assert.equal(options.secure, true);
      assert.equal(options.authorizationV4, true); assert.equal(options.retryMax, 0);
      assert.equal(options.accessKeyId, "synthetic-secret-runtime-id");
      assert.equal(options.accessKeySecret, "synthetic-secret-runtime-secret");
    }
    async put(key, body, options) {
      events.push("put"); assert.ok(key.startsWith(config().objectPrefix));
      assert.equal(options.headers["x-oss-forbid-overwrite"], "true");
      assert.equal(options.timeout, 30_000);
      objects.set(`${config().publicBaseUrl}/${key}`, body);
    }
  }
  return { events, options: { config: config(), localAssetStore: {
    async read(asset, options) { events.push("read"); assert.equal(options.verifyContent, true); return f.store.read(asset, options); }
  }, secretReader: async (account, { service }) => {
    events.push(`secret:${account}`); assert.equal(service, config().keychainService); return `synthetic-secret-${account}`;
  }, Client, request: async (url, options) => {
    events.push("get"); assert.equal(options.method, "GET"); assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal); assert.ok(objects.has(url));
    return new Response(objects.get(url), { headers: { "Content-Type": "image/jpeg" } });
  }, now: () => NOW, ...overrides } };
}

function uploadInput(f, provider, gate = async () => {}) {
  return { candidateId: f.candidate.id, skuPackageId: f.candidate.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: f.candidate.dataRevision, finalUploads: f.assets, beforePublicWrite: gate,
    resolveLocalAsset: asset => provider.resolveLocalAsset(asset, { candidate: f.candidate }) };
}

test("OSS provider configuration is explicit, closed, bounded and detached from historical defaults", () => {
  assert.equal(normalizeAliyunOssRuntimeConfiguration(null), null);
  const input = config(), normalized = normalizeAliyunOssRuntimeConfiguration(input);
  input.keychainAccounts.accessKeyId = "changed";
  assert.equal(normalized.keychainAccounts.accessKeyId, "runtime-id");
  assert.ok(Object.isFrozen(normalized)); assert.ok(Object.isFrozen(normalized.keychainAccounts));
  for (const mutate of [
    value => { delete value.bucket; }, value => { value.accessKeySecret = "secret"; },
    value => { value.keychainAccounts.password = "secret"; }, value => { value.keychainAccounts.accessKeyId = ""; },
    value => { value.keychainAccounts.accessKeySecret = value.keychainAccounts.accessKeyId; },
    value => { value.keychainService = "x".repeat(129); }, value => { value.region = "personal-region"; },
    value => { value.bucket = "../escape"; }, value => { value.objectPrefix = "../escape/"; },
    value => { value.objectPrefix = "x/".repeat(129); }, value => { value.endpoint = "https://api.example.com"; },
    ...["http://assets.example.com", "https://user:secret@assets.example.com", "https://127.0.0.1", "https://assets.local",
      "https://assets.example.com?token=secret", "https://assets.example.com/#secret"].map(url => value => { value.publicBaseUrl = url; })
  ]) {
    const value = config(); mutate(value);
    assert.throws(() => normalizeAliyunOssRuntimeConfiguration(value), /OSS_RUNTIME_CONFIGURATION_INVALID/);
  }
});

test("construction has zero credential, filesystem and network IO; configuration never means health", () => {
  const fail = () => { throw new Error("constructor performed IO"); };
  const options = { localAssetStore: { read: fail }, secretReader: fail, request: fail, Client: fail, now: fail };
  const absent = createAliyunOssRuntimeProvider(options);
  assert.equal(absent.available, false); assert.equal(absent.upload, null); assert.equal(absent.resolveLocalAsset, null);
  assert.equal(absent.blockReason, "OSS_RUNTIME_CONFIGURATION_REQUIRED");
  const noStore = createAliyunOssRuntimeProvider({ config: config() });
  assert.equal(noStore.blockReason, "OSS_LOCAL_ASSET_STORE_REQUIRED");
  const configured = createAliyunOssRuntimeProvider({ ...options, config: config() });
  assert.equal(configured.available, true); assert.equal(configured.status, "configured_unverified");
  assert.equal(configured.health, "not_checked"); assert.doesNotMatch(JSON.stringify(configured), /synthetic\.oss|runtime-secret/);
});

test("keychain reader uses the explicitly configured service and account without a real keychain call", async () => {
  let commands = 0;
  const secret = await readAliyunOssKeychainSecret("runtime-id", { service: "synthetic.oss.runtime", platform: "darwin", execFileImpl: async (file, args) => {
    commands++; assert.equal(file, "/usr/bin/security");
    assert.deepEqual(args, ["find-generic-password", "-w", "-s", "synthetic.oss.runtime", "-a", "runtime-id"]);
    return { stdout: "synthetic-value\n" };
  } });
  assert.equal(secret, "synthetic-value"); assert.equal(commands, 1);
});

test("real registered local files use existing upload, per-image gate and independent byte readback", async t => {
  const f = await fixture(t), dependency = syntheticDependencies(f);
  const provider = createAliyunOssRuntimeProvider(dependency.options);
  const result = await provider.upload(uploadInput(f, provider, async ({ order }) => { dependency.events.push(`gate:${order}`); }));
  assert.deepEqual(dependency.events, ["read", "read", "secret:runtime-id", "secret:runtime-secret", "client", "gate:1", "put", "get", "gate:2", "put", "get"]);
  assert.equal(result.status, "verified"); assert.equal(result.resolvedAssets.length, 2);
  assert.deepEqual(result.approvedHosts, [new URL(config().publicBaseUrl).hostname]);
  assert.ok(result.resolvedAssets.every(asset => asset.platformAcceptedUrl.startsWith(`${config().publicBaseUrl}/${config().objectPrefix}`)));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|keychain|ozon-img-staging|com\.shuaizhang/);
});

test("wrong candidate, changed registrations and opaque path forgery fail before any local read or credential", async t => {
  const f = await fixture(t), dependency = syntheticDependencies(f), provider = createAliyunOssRuntimeProvider(dependency.options);
  await assert.rejects(provider.resolveLocalAsset(f.assets[0]), /最终素材登记/);
  for (const mutate of [
    value => { value.id = "foreign"; },
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].sha256 = "changed"; },
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].status = "failed"; }
  ]) {
    const candidate = structuredClone(f.candidate); mutate(candidate);
    await assert.rejects(provider.resolveLocalAsset(f.assets[0], { candidate }), /最终素材|未完成的文件/);
  }
  await assert.rejects(provider.resolveLocalAsset({ ...f.assets[0], assetRef: "/etc/passwd" }, { candidate: f.candidate }), /最终素材/);
  assert.deepEqual(dependency.events, []);
});

// 2026-09-23 主人决定：C1 改版后复用原素材确认是正常路径（审计事件 c2_final_uploads_confirmation_reused），
// 上传登记仍指向旧 C1，不再据此拒绝；文件身份由 sha256、上传状态、商品身份三条继续兜底。
test("C1改版后复用的素材确认仍可读出，文件身份三条兜底不受影响", async t => {
  const f = await fixture(t), dependency = syntheticDependencies(f), provider = createAliyunOssRuntimeProvider(dependency.options);
  const reused = structuredClone(f.candidate);
  reused.lifecycleV11.c2UploadDraft.sourceC1Fingerprint = "changed-after-c1-revision";
  const resolved = await provider.resolveLocalAsset(f.assets[0], { candidate: reused });
  assert.equal(Buffer.isBuffer(resolved.body), true);
  for (const mutate of [
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].sha256 = "changed"; },
    value => { value.lifecycleV11.c2UploadDraft.uploads[0].status = "failed"; },
    value => { value.id = "foreign"; }
  ]) {
    const candidate = structuredClone(reused); mutate(candidate);
    await assert.rejects(provider.resolveLocalAsset(f.assets[0], { candidate }), /最终素材|未完成的文件/);
  }
});

test("missing gate, local-file errors and missing secrets produce no writes and preserve error identity", async t => {
  const f = await fixture(t);
  for (const stage of ["gate_missing", "local", "secret", "empty_secret"]) {
    const failure = new Error(`SYNTHETIC_${stage.toUpperCase()}`);
    const overrides = stage === "local" ? { localAssetStore: { read: async () => { throw failure; } } }
      : stage === "secret" ? { secretReader: async () => { throw failure; } }
      : stage === "empty_secret" ? { secretReader: async () => "" } : {};
    const dependency = syntheticDependencies(f, overrides), provider = createAliyunOssRuntimeProvider(dependency.options);
    const input = uploadInput(f, provider);
    if (stage === "gate_missing") delete input.beforePublicWrite;
    await assert.rejects(provider.upload(input), error => stage === "gate_missing" ? /OSS_PUBLIC_WRITE_GATE_REQUIRED/.test(error.message)
      : stage === "empty_secret" ? error instanceof AliyunOssLocalPreparationError && error.code === "OSS_CREDENTIAL_UNAVAILABLE" : error === failure);
    assert.ok(!dependency.events.includes("put")); assert.ok(!dependency.events.includes("client"));
    if (stage === "gate_missing") assert.deepEqual(dependency.events, []);
  }
});

test("known local file and keychain failures have safe prewrite types; programming errors remain unchanged", async t => {
  const f = await fixture(t);
  for (const stage of ["local", "secret", "store_secret", "program"]) {
    const failure = stage === "program" ? new TypeError("synthetic programmer failure") :
      stage === "store_secret" ? new CredentialStoreError("credential_access_denied") :
      Object.assign(new Error("synthetic private source must not escape"), { code: stage === "local" ? "ENOENT" : 44 });
    const dependency = syntheticDependencies(f, stage !== "local" && stage !== "program" ? { secretReader: async () => { throw failure; } } :
      { localAssetStore: { read: async () => { throw failure; } } });
    const provider = createAliyunOssRuntimeProvider(dependency.options);
    await assert.rejects(provider.upload(uploadInput(f, provider)), error => stage === "program" ? error === failure :
      error instanceof AliyunOssLocalPreparationError && error.code === (stage === "local" ? "OSS_LOCAL_ASSET_UNAVAILABLE" : "OSS_CREDENTIAL_UNAVAILABLE") &&
      !error.message.includes("private") && !Object.hasOwn(error, "cause"));
    assert.ok(!dependency.events.includes("put")); assert.ok(!dependency.events.includes("get"));
  }
});

test("late gate refusal and failed public byte readback stop remaining files without automatic retry", async t => {
  const f = await fixture(t);
  for (const stage of ["gate", "readback"]) {
    const dependency = syntheticDependencies(f, stage === "readback" ? {
      request: async () => new Response("wrong-public-bytes", { headers: { "Content-Type": "image/jpeg" } })
    } : {});
    const provider = createAliyunOssRuntimeProvider(dependency.options);
    const failure = new Error("SYNTHETIC_GATE_EXPIRED");
    await assert.rejects(provider.upload(uploadInput(f, provider, async ({ order }) => {
      if (stage === "gate" && order === 2) throw failure;
    })), error => stage === "gate" ? error === failure : /OSS_PUBLIC_READBACK_MISMATCH/.test(error.message));
    assert.equal(dependency.events.filter(event => event === "put").length, 1);
  }
});
