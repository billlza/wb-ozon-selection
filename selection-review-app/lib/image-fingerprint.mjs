import sharp from "sharp";

// 首图比对：只回答「两张图看起来是不是同一张」，不回答「是不是同款」——同款永远由主人确认。
// 指纹是 64 位的差值哈希（dHash）：缩成 9×8 灰度，逐行比较左右相邻像素的明暗。同一张图被重新压缩、缩放、
// 换格式时几乎不变；换了拍法、角度或构图的图会差很远。所以它只适合判断「首图一致 / 很像 / 不像」这三档。
export const IMAGE_FINGERPRINT_VERSION = "dhash-64-v1";
export const IMAGE_SIMILARITY_LEVELS = Object.freeze(["identical", "similar", "different"]);
export const IMAGE_SIMILARITY_LABELS = Object.freeze({ identical: "首图一致", similar: "很像", different: "不像" });
// 64 位里最多差几位算哪一档。同一张图重新压缩或缩放通常差 0–4 位，加了水印、边框或轻微裁切的同一张图多在 12 位以内。
const IDENTICAL_MAX_DISTANCE = 5;
const SIMILAR_MAX_DISTANCE = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
// 只去平台自己的图片服务器取图：拼多多、1688 和 Ozon 的商品图都在这几个域名下，别的地址一律不取。
const IMAGE_HOSTS = [/(^|\.)pddpic\.com$/, /(^|\.)yangkeduo\.com$/, /(^|\.)alicdn\.com$/, /^ir\.ozone\.ru$/];

export class ImageFingerprintError extends Error {
  constructor(code) { super(`IMAGE_FINGERPRINT_${code}`); this.name = "ImageFingerprintError"; this.code = code; }
}

export function imageFingerprintUrlAllowed(value) {
  if (typeof value !== "string" || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && IMAGE_HOSTS.some(host => host.test(url.hostname));
  } catch { return false; }
}

export function isImageFingerprint(value) {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/** The 64-bit difference hash of one decoded image, as 16 lowercase hex digits. Transparent areas count as white. */
export async function imageFingerprintFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new ImageFingerprintError("IMAGE_INVALID");
  let pixels;
  try {
    pixels = await sharp(buffer, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).timeout({ seconds: 10 })
      .flatten({ background: "#ffffff" }).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  } catch { throw new ImageFingerprintError("IMAGE_INVALID"); }
  if (pixels.length !== 72) throw new ImageFingerprintError("IMAGE_INVALID");
  let bits = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      bits = (bits << 1n) | (pixels[row * 9 + column] > pixels[row * 9 + column + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function imageFingerprintDistance(left, right) {
  if (!isImageFingerprint(left) || !isImageFingerprint(right)) throw new ImageFingerprintError("FINGERPRINT_INVALID");
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (difference) { distance += Number(difference & 1n); difference >>= 1n; }
  return distance;
}

export function classifyImageSimilarity(distance) {
  if (!Number.isSafeInteger(distance) || distance < 0 || distance > 64) throw new ImageFingerprintError("DISTANCE_INVALID");
  return distance <= IDENTICAL_MAX_DISTANCE ? "identical" : distance <= SIMILAR_MAX_DISTANCE ? "similar" : "different";
}

async function readBoundedBody(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new ImageFingerprintError("IMAGE_TOO_LARGE");
  if (!response.body || typeof response.body.getReader !== "function") throw new ImageFingerprintError("IMAGE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMAGE_BYTES) { await reader.cancel(); throw new ImageFingerprintError("IMAGE_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes);
}

/**
 * Fetch one public product image from a platform image host. No cookie, credential or referer is sent, redirects are
 * refused (a redirect could leave the allowed hosts), and the body is read to a fixed limit.
 */
export async function fetchPublicProductImage(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!imageFingerprintUrlAllowed(url)) throw new ImageFingerprintError("URL_NOT_ALLOWED");
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError("IMAGE_FINGERPRINT_DEPENDENCY_INVALID");
  }
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new ImageFingerprintError("FETCH_FAILED"); }
  if (!response?.ok) throw new ImageFingerprintError("FETCH_FAILED");
  const type = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!type.startsWith("image/")) throw new ImageFingerprintError("IMAGE_INVALID");
  return readBoundedBody(response);
}

/** Fetch one public product image (as fetchPublicProductImage) and fingerprint it. */
export async function fetchImageFingerprint(url, options = {}) {
  return imageFingerprintFromBuffer(await fetchPublicProductImage(url, options));
}

// 交给 Ozon 以图搜上传的图：只要一张普通的 JPEG。长边最多 1600 像素，去掉图片里带的拍摄信息，大小远在 Ozon 的上传限制以内。
const SEARCH_UPLOAD_MAX_EDGE = 1600;
const SEARCH_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/** The picture a search uploads: the same image re-encoded as a plain JPEG, metadata dropped, at most 1600 px a side. */
export async function searchUploadImageFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new ImageFingerprintError("IMAGE_INVALID");
  let output;
  try {
    output = await sharp(buffer, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).timeout({ seconds: 10 }).rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: SEARCH_UPLOAD_MAX_EDGE, height: SEARCH_UPLOAD_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer();
  } catch { throw new ImageFingerprintError("IMAGE_INVALID"); }
  if (output.length === 0 || output.length > SEARCH_UPLOAD_MAX_BYTES) throw new ImageFingerprintError("IMAGE_TOO_LARGE");
  return { contentType: "image/jpeg", buffer: output };
}
