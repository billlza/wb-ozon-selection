import OSS from "ali-oss";
import { createHash } from "node:crypto";
import { createOsCredentialStore } from "./credential-store.mjs";
import { assertFinalAssetLocation } from "./production-contract-primitives.mjs";

export const ALIYUN_OSS_ASSET_TRANSPORT_VERSION = "aliyun-oss-final-assets-v1";
export const ALIYUN_OSS_KEYCHAIN_SERVICE = "com.shuaizhang.wb-ozon-selection.aliyun-oss";
export const ALIYUN_OSS_PUBLIC_CONFIG = Object.freeze({
  label: "三店选品上架 OSS 素材中转",
  region: "oss-cn-beijing",
  endpoint: "https://oss-accelerate.aliyuncs.com",
  bucket: "ozon-img-staging-cn-20260630-a7k3",
  publicBaseUrl: "https://ozon-img-staging-cn-20260630-a7k3.oss-accelerate.aliyuncs.com",
  objectPrefix: "wb-ozon-selection/final-assets/",
  accelerateEnabled: true,
  keychainService: ALIYUN_OSS_KEYCHAIN_SERVICE,
  keychainAccounts: Object.freeze({
    accessKeyId: "access-key-id",
    accessKeySecret: "access-key-secret"
  })
});

const MAX_SIMPLE_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_UPLOAD_BYTES = 256 * 1024 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeSegment(value, label) {
  const segment = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  if (!segment) throw new Error(`OSS_SCOPE_INVALID: ${label}不能为空`);
  return segment;
}

function extensionFromPath(path) {
  const match = String(path || "").match(/\.([a-zA-Z0-9]{1,8})$/u);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function contentTypeFromPath(path) {
  const extension = extensionFromPath(path);
  const contentType = ({
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4"
  })[extension];
  if (!contentType) throw new Error("OSS_ASSET_FORMAT_UNSUPPORTED: 素材文件格式未明确");
  return contentType;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function evidenceRef(value) {
  return `aliyun-oss-asset:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function readAliyunOssKeychainSecret(account, { service = ALIYUN_OSS_KEYCHAIN_SERVICE, execFileImpl, platform, credentialStore } = {}) {
  const store = credentialStore ?? createOsCredentialStore({ ...(platform ? { platform } : {}), ...(execFileImpl ? { execFileImpl } : {}) });
  // Store failures arrive as CredentialStoreError codes without subprocess text.
  const stdout = await store.readSecret({ service, account }, { maxBuffer: 16 * 1024 });
  const value = String(stdout || "").trim();
  if (!value) throw new Error(`OSS_KEYCHAIN_MISSING: ${account}`);
  return value;
}

export async function inspectAliyunOssAssetTransportConfiguration({ readSecret = readAliyunOssKeychainSecret } = {}) {
  let accessKeyIdConfigured = false;
  let accessKeySecretConfigured = false;
  try {
    accessKeyIdConfigured = nonEmpty(await readSecret(ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts.accessKeyId));
    accessKeySecretConfigured = nonEmpty(await readSecret(ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts.accessKeySecret));
  } catch {
    // 配置状态只返回布尔值，不返回钥匙串内容或底层错误文本。
  }
  return Object.freeze({
    status: accessKeyIdConfigured && accessKeySecretConfigured ? "configured_unverified" : "not_configured",
    transportVersion: ALIYUN_OSS_ASSET_TRANSPORT_VERSION,
    label: ALIYUN_OSS_PUBLIC_CONFIG.label,
    region: ALIYUN_OSS_PUBLIC_CONFIG.region,
    bucket: ALIYUN_OSS_PUBLIC_CONFIG.bucket,
    publicHost: new URL(ALIYUN_OSS_PUBLIC_CONFIG.publicBaseUrl).hostname,
    objectPrefix: ALIYUN_OSS_PUBLIC_CONFIG.objectPrefix,
    accelerateEnabled: ALIYUN_OSS_PUBLIC_CONFIG.accelerateEnabled,
    keychainService: ALIYUN_OSS_KEYCHAIN_SERVICE,
    accessKeyIdConfigured,
    accessKeySecretConfigured,
    realUploadVerified: false
  });
}

export async function createAliyunOssClient({
  readSecret = readAliyunOssKeychainSecret,
  Client = OSS,
  config = ALIYUN_OSS_PUBLIC_CONFIG
} = {}) {
  const accessKeyId = await readSecret(config.keychainAccounts.accessKeyId, { service: config.keychainService });
  const accessKeySecret = await readSecret(config.keychainAccounts.accessKeySecret, { service: config.keychainService });
  if (!nonEmpty(accessKeyId) || !nonEmpty(accessKeySecret)) throw new Error("OSS_KEYCHAIN_MISSING");
  return new Client({
    region: config.region,
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId,
    accessKeySecret,
    secure: true,
    authorizationV4: true,
    retryMax: 0
  });
}

export function buildAliyunOssFinalAssetObjectKey({ candidateId, skuPackageId, dataRevision, asset, config = ALIYUN_OSS_PUBLIC_CONFIG }) {
  if (!asset || asset.ownerConfirmed !== true || asset.productionEligible !== true || asset.lifecycleArea !== "finalUploads") {
    throw new Error("OSS_ASSET_NOT_AUTHORIZED: 只能上传主人确认的finalUploads");
  }
  if (!nonEmpty(asset.assetId) || !nonEmpty(asset.sha256) || !Number.isInteger(asset.order) || asset.order < 1) {
    throw new Error("OSS_ASSET_BINDING_INVALID: 素材ID、SHA256或顺序无效");
  }
  if (!nonEmpty(asset.fileName) || /[\\/\u0000-\u001f]/u.test(asset.fileName)) throw new Error("OSS_ASSET_FILENAME_INVALID");
  contentTypeFromPath(asset.fileName);
  const extension = extensionFromPath(asset.fileName);
  return [
    config.objectPrefix.replace(/\/$/u, ""),
    safeSegment(candidateId, "candidateId"),
    safeSegment(skuPackageId, "skuPackageId"),
    `revision-${safeSegment(dataRevision, "dataRevision")}`,
    `${String(asset.order).padStart(2, "0")}-${safeSegment(asset.assetId, "assetId")}-${asset.sha256.slice(0, 16)}${extension}`
  ].join("/");
}

export async function uploadAliyunOssFinalAssets({
  candidateId,
  skuPackageId,
  dataRevision,
  finalUploads,
  client,
  createClient = createAliyunOssClient,
  resolveLocalAsset,
  beforePublicWrite,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  config = ALIYUN_OSS_PUBLIC_CONFIG
}) {
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    throw new Error("OSS_FINAL_UPLOADS_MISSING: 没有主人确认的最终素材");
  }
  const orders = finalUploads.map((asset) => asset.order);
  if (orders.some((order, index) => order !== index + 1)) {
    throw new Error("OSS_ASSET_ORDER_INVALID: 最终素材顺序必须从1连续排列");
  }
  if (typeof resolveLocalAsset !== "function") throw new Error("OSS_LOCAL_ASSET_RESOLVER_REQUIRED");
  if (typeof beforePublicWrite !== "function") throw new Error("OSS_PUBLIC_WRITE_GATE_REQUIRED");
  let totalBytes = 0;
  const prepared = [];
  // Validate every authorized file before reading credentials or creating a public object.
  for (const asset of finalUploads) {
    if (assertFinalAssetLocation(asset) !== "local") throw new Error("OSS_LOCAL_ASSET_REQUIRED");
    if (asset.byteSize > MAX_SIMPLE_UPLOAD_BYTES || totalBytes + asset.byteSize > MAX_BATCH_UPLOAD_BYTES) throw new Error("OSS_LOCAL_BATCH_TOO_LARGE");
    const objectKey = buildAliyunOssFinalAssetObjectKey({ candidateId, skuPackageId, dataRevision, asset, config });
    const { body, contentType } = await resolveLocalAsset(asset);
    if (!Buffer.isBuffer(body) || body.length !== asset.byteSize || sha256(body) !== asset.sha256) throw new Error("OSS_ASSET_SHA256_MISMATCH: 素材内容与确认清单不一致");
    if (contentType !== contentTypeFromPath(asset.fileName)) throw new Error("OSS_ASSET_CONTENT_TYPE_MISMATCH");
    totalBytes += body.length;
    prepared.push({ asset, objectKey, body, contentType });
  }
  const ossClient = client || await createClient({ config });
  const resolvedAssets = [];
  for (const { asset, objectKey, body, contentType } of prepared) {
    const headers = {
      "Content-Type": contentType,
      "x-oss-object-acl": "public-read",
      "x-oss-forbid-overwrite": "true"
    };
    // The service owns the saved authorization and current clock; transport never infers permission from file metadata.
    await beforePublicWrite(Object.freeze({ assetId: asset.assetId, order: asset.order, sha256: asset.sha256 }));
    await ossClient.put(objectKey, body, { headers, timeout: 30_000 });
    const platformAcceptedUrl = `${config.publicBaseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetchImpl(platformAcceptedUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await verifyPublicAssetBody(response, asset, contentType);
    const uploadedAt = now();
    resolvedAssets.push(Object.freeze({
      assetId: asset.assetId,
      sha256: asset.sha256,
      order: asset.order,
      role: asset.role,
      platformAcceptedUrl,
      stable: true,
      authorizationStatus: "approved",
      transportVersion: ALIYUN_OSS_ASSET_TRANSPORT_VERSION,
      uploadedAt,
      evidenceRef: evidenceRef({ objectKey, sha256: asset.sha256, order: asset.order, uploadedAt })
    }));
  }

  return Object.freeze({
    status: "verified",
    mode: "preapproved_stable_https",
    protocolVersion: ALIYUN_OSS_ASSET_TRANSPORT_VERSION,
    approvedHosts: Object.freeze([new URL(config.publicBaseUrl).hostname]),
    resolvedAssets: Object.freeze(resolvedAssets),
    evidenceRef: evidenceRef({ candidateId, skuPackageId, dataRevision, assets: resolvedAssets.map(({ assetId, sha256, order, platformAcceptedUrl }) => ({ assetId, sha256, order, platformAcceptedUrl })) })
  });
}

async function verifyPublicAssetBody(response, asset, contentType) {
  if (response.status !== 200 || !response.body || response.headers.get("content-type")?.split(";")[0].trim() !== contentType) {
    await response.body?.cancel();
    throw new Error("OSS_PUBLIC_READBACK_FAILED: 素材公开回读状态或类型不一致");
  }
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let size = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      size += value.byteLength;
      if (size > asset.byteSize) throw new Error("OSS_PUBLIC_READBACK_MISMATCH: 公开素材大小不一致");
      digest.update(value);
    }
    if (size !== asset.byteSize || digest.digest("hex") !== asset.sha256) throw new Error("OSS_PUBLIC_READBACK_MISMATCH: 公开素材内容不一致");
  } finally {
    try { if (!completed) await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}
