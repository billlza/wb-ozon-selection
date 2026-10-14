import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { c2DraftError, LOCAL_UPLOAD_MAX_BYTES } from "./c2-upload-draft.mjs";
import { assertFinalAssetLocation } from "./production-contract-primitives.mjs";

// These are local storage capabilities. Platform acceptance comes from the frozen media contract.
const FORMATS = Object.freeze({
  ".jpg": { mediaType: "image", contentType: "image/jpeg" },
  ".jpeg": { mediaType: "image", contentType: "image/jpeg" },
  ".png": { mediaType: "image", contentType: "image/png" },
  ".webp": { mediaType: "image", contentType: "image/webp" },
  ".mp4": { mediaType: "video", contentType: "video/mp4" }
});

export function normalizeC2LocalUpload(fileName, contentType) {
  if (typeof fileName !== "string" || !fileName || fileName.length > 180 ||
      fileName !== path.basename(fileName) || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
    throw c2DraftError("c2_upload_name_invalid", "素材文件名无效", 400);
  }
  const format = FORMATS[path.extname(fileName).toLowerCase()];
  if (!format || contentType?.split(";")[0].trim().toLowerCase() !== format.contentType) {
    throw c2DraftError("c2_upload_format_unsupported", "本地上传支持JPG、PNG、WEBP、MP4，文件类型必须与扩展名一致", 415);
  }
  return { fileName, ...format };
}

function matchesFormat(body, contentType) {
  if (!Buffer.isBuffer(body) || body.length < 12) return false;
  if (contentType === "image/jpeg") return body[0] === 0xff && body[1] === 0xd8 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9;
  if (contentType === "image/png") return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/webp") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  if (contentType === "video/mp4") return body.subarray(4, 8).toString("ascii") === "ftyp";
  return false;
}

// This limit bounds local decoder memory. It is not a marketplace media rule.
const MAX_LOCAL_IMAGE_PIXELS = 20_000_000;
async function decodeImage(body, format) {
  if (format.mediaType === "video") {
    throw c2DraftError("c2_video_validation_unavailable", "本机尚未配置视频内容校验，视频不能进入最终素材清单", 503);
  }
  const decoder = sharp(body, { failOn: "warning", limitInputPixels: MAX_LOCAL_IMAGE_PIXELS }).timeout({ seconds: 10 });
  const warnings = [];
  decoder.on("warning", warning => warnings.push(warning));
  try {
    const metadata = await decoder.metadata();
    if (`image/${metadata.format}` !== format.contentType) {
      throw c2DraftError("c2_upload_content_invalid", "实际图片格式与文件声明不一致", 415);
    }
    if (metadata.pages !== undefined && metadata.pages !== 1) {
      throw c2DraftError("c2_upload_animation_unsupported", "当前最终图片只支持静态单帧，请提供静态图片", 415);
    }
    // metadata alone never proves that all compressed pixels can be decoded.
    const { info } = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (warnings.length || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) {
      throw c2DraftError("c2_upload_content_invalid", "图片未能通过完整像素校验", 415);
    }
    return { width: info.width, height: info.height };
  } catch (error) {
    if (error.extra?.code?.startsWith("c2_upload_")) throw error;
    throw Object.assign(c2DraftError("c2_upload_content_invalid", "图片无法完整解码、超过本地像素限制或处理超时", 415), { cause: error });
  } finally {
    decoder.destroy();
  }
}

function storageKey(assetId) {
  const match = /^c2-local:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(assetId);
  if (!match) throw c2DraftError("c2_upload_id_invalid", "本地素材编号无效", 422);
  return match[1];
}

export function createC2LocalAssetStore({ directory }) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("C2_LOCAL_STORAGE_DIRECTORY_REQUIRED");
  const root = path.resolve(directory);
  let decoding = false;
  async function validateContent(body, format) {
    if (decoding) throw c2DraftError("c2_upload_decoder_busy", "本地正在校验另一份素材，请在其结束后重新上传", 409);
    decoding = true;
    try { return await decodeImage(body, format); }
    finally { decoding = false; }
  }
  return Object.freeze({
    async write(upload, body) {
      const format = normalizeC2LocalUpload(upload.fileName, upload.contentType);
      if (!Buffer.isBuffer(body) || body.length > LOCAL_UPLOAD_MAX_BYTES || !matchesFormat(body, format.contentType)) {
        throw c2DraftError("c2_upload_content_invalid", "素材大小或文件内容与声明格式不一致", 415);
      }
      const dimensions = await validateContent(body, format);
      const key = storageKey(upload.assetId);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = path.join(root, `${key}.uploading`);
      const target = path.join(root, key);
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(body);
        await file.sync();
      } finally { await file.close(); }
      // Link publishes the finished file without overwriting an existing immutable object.
      await fs.link(temporary, target);
      await fs.unlink(temporary);
      const folder = await fs.open(root, "r");
      try { await folder.sync(); } finally { await folder.close(); }
      const sha256 = createHash("sha256").update(body).digest("hex");
      return {
        assetId: upload.assetId,
        assetRef: `local-asset:${upload.assetId}`,
        ...format,
        ...dimensions,
        assetVersion: `sha256:${sha256}`,
        sha256,
        byteSize: body.length,
        sourceEvidenceRef: `c2-upload:${key}`,
        stableUrlEvidenceRef: "not_applicable",
        sourceType: "owner_provided_final_upload",
        stagedAt: upload.stagedAt
      };
    },
    async read(asset, { verifyContent = false } = {}) {
      if (assertFinalAssetLocation(asset) !== "local") throw c2DraftError("c2_upload_not_local", "该素材不是本地登记文件", 422);
      const realRoot = await fs.realpath(root);
      const expected = path.join(realRoot, storageKey(asset.assetId));
      if (await fs.realpath(expected) !== expected) throw c2DraftError("c2_upload_path_changed", "本地素材存储位置已变化", 409);
      const stat = await fs.stat(expected);
      if (!stat.isFile() || stat.size !== asset.byteSize || stat.size > LOCAL_UPLOAD_MAX_BYTES) throw c2DraftError("c2_upload_file_changed", "本地素材大小已变化", 409);
      const body = await fs.readFile(expected);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const format = normalizeC2LocalUpload(asset.fileName, asset.contentType);
      if (sha256 !== asset.sha256 || asset.assetVersion !== `sha256:${sha256}` || body.length !== asset.byteSize || !matchesFormat(body, format.contentType)) {
        throw c2DraftError("c2_upload_file_changed", "本地素材内容已变化，请核对该文件", 409);
      }
      if (verifyContent) {
        const dimensions = await validateContent(body, format);
        if (asset.width !== dimensions.width || asset.height !== dimensions.height) throw c2DraftError("c2_upload_dimensions_unverified", "已保存尺寸与实际文件不一致，请重新登记素材", 409);
      }
      return { body, contentType: format.contentType };
    },
    async linkExisting(source, target) {
      if (source.assetId === target.assetId || source.fileName !== target.fileName ||
          source.mediaType !== target.mediaType || source.contentType !== target.contentType) {
        throw c2DraftError("c2_link_identity_invalid", "共享素材来源与目标身份不一致", 409);
      }
      // Recheck the immutable source before creating a second candidate-owned registration.
      await this.read(source, { verifyContent: true });
      const realRoot = await fs.realpath(root);
      const sourcePath = path.join(realRoot, storageKey(source.assetId));
      const targetPath = path.join(realRoot, storageKey(target.assetId));
      await fs.link(sourcePath, targetPath);
      const folder = await fs.open(realRoot, "r");
      try { await folder.sync(); } finally { await folder.close(); }
      return {
        assetId: target.assetId,
        assetRef: `local-asset:${target.assetId}`,
        fileName: source.fileName,
        mediaType: source.mediaType,
        contentType: source.contentType,
        width: source.width,
        height: source.height,
        assetVersion: source.assetVersion,
        sha256: source.sha256,
        byteSize: source.byteSize,
        sourceEvidenceRef: `c2-upload:${storageKey(target.assetId)}`,
        stableUrlEvidenceRef: "not_applicable",
        sourceType: "owner_provided_final_upload",
        stagedAt: target.stagedAt
      };
    }
  });
}
