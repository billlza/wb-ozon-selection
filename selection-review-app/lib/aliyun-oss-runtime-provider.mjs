import { createAliyunOssClient, readAliyunOssKeychainSecret, uploadAliyunOssFinalAssets } from "./aliyun-oss-asset-transport.mjs";
import { resolveRegisteredC2FinalAsset } from "./c2-upload-draft.mjs";
import { CredentialStoreError } from "./credential-store.mjs";

import { normalizeAliyunOssRuntimeConfiguration } from "./aliyun-oss-runtime-configuration.mjs";
import { AliyunOssLocalPreparationError } from "./production-execution-failure.mjs";
export { normalizeAliyunOssRuntimeConfiguration } from "./aliyun-oss-runtime-configuration.mjs";

export function createAliyunOssRuntimeProvider({ config = null, localAssetStore = null,
  secretReader = readAliyunOssKeychainSecret, Client, request = fetch, now = () => new Date().toISOString() } = {}) {
  const normalized = normalizeAliyunOssRuntimeConfiguration(config);
  if (typeof secretReader !== "function" || typeof request !== "function" || typeof now !== "function" ||
      (Client !== undefined && typeof Client !== "function") ||
      (localAssetStore !== null && typeof localAssetStore.read !== "function")) throw new Error("OSS_RUNTIME_DEPENDENCY_INVALID");
  const blockReason = normalized === null ? "OSS_RUNTIME_CONFIGURATION_REQUIRED"
    : localAssetStore === null ? "OSS_LOCAL_ASSET_STORE_REQUIRED" : null;
  if (blockReason) return Object.freeze({ available: false, status: "not_configured", health: "not_checked",
    blockReason, upload: null, resolveLocalAsset: null });

  async function resolveLocalAsset(asset, { candidate } = {}) {
    const registered = resolveRegisteredC2FinalAsset(candidate, asset);
    try { return await localAssetStore.read(registered, { verifyContent: true }); }
    catch (error) {
      if (["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR"].includes(error?.code) && error?.constructor === Error) {
        throw new AliyunOssLocalPreparationError("OSS_LOCAL_ASSET_UNAVAILABLE");
      }
      // c2_final_registration_mismatch 也属于本地准备失败：登记对不上就一张都不会传。
      // 漏了它会让错误落进通用 unknown_outcome，把「其实一个请求都没发出去」这个事实丢掉。
      if (error?.constructor === Error && ["c2_upload_path_changed", "c2_upload_file_changed", "c2_upload_content_invalid",
        "c2_upload_dimensions_unverified", "c2_upload_decoder_busy", "c2_final_registration_mismatch"].includes(error.extra?.code)) {
        throw new AliyunOssLocalPreparationError("OSS_LOCAL_ASSET_INVALID");
      }
      throw error;
    }
  }
  async function readConfiguredSecret(account, options) {
    try { return await secretReader(account, options); }
    catch (error) {
      if (error instanceof CredentialStoreError && error.code !== "credential_read_cancelled" ||
          error?.constructor === Error && (Number.isInteger(error.code) || ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT"].includes(error.code))) {
        throw new AliyunOssLocalPreparationError("OSS_CREDENTIAL_UNAVAILABLE");
      }
      throw error;
    }
  }
  async function upload({ candidateId, skuPackageId, dataRevision, finalUploads,
    resolveLocalAsset: resolveForRequest, beforePublicWrite, now: requestClock = now }) {
    let writeGateEntered = false;
    try {
      return await uploadAliyunOssFinalAssets({ candidateId, skuPackageId, dataRevision, finalUploads,
        resolveLocalAsset: resolveForRequest, now: requestClock,
        beforePublicWrite: typeof beforePublicWrite !== "function" ? beforePublicWrite : async scope => {
          writeGateEntered = true;
          await beforePublicWrite(scope);
        }, config: normalized, fetchImpl: request,
        createClient: () => createAliyunOssClient({ config: normalized, readSecret: readConfiguredSecret, Client }) });
    } catch (error) {
      if (!writeGateEntered && error?.constructor === Error) {
        const code = error.message.split(":", 1)[0];
        if (code === "OSS_KEYCHAIN_MISSING") throw new AliyunOssLocalPreparationError("OSS_CREDENTIAL_UNAVAILABLE");
        if (["OSS_ASSET_SHA256_MISMATCH", "OSS_ASSET_CONTENT_TYPE_MISMATCH", "OSS_LOCAL_BATCH_TOO_LARGE"].includes(code)) {
          throw new AliyunOssLocalPreparationError("OSS_LOCAL_ASSET_INVALID");
        }
      }
      throw error;
    }
  }
  return Object.freeze({ available: true, status: "configured_unverified", health: "not_checked",
    blockReason: null, upload, resolveLocalAsset });
}
