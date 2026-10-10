import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  IMAGE_FINGERPRINT_VERSION,
  ImageFingerprintError,
  classifyImageSimilarity,
  fetchImageFingerprint,
  imageFingerprintDistance,
  imageFingerprintFromBuffer,
  imageFingerprintUrlAllowed
} from "../lib/image-fingerprint.mjs";

// Every picture here is drawn in memory from synthetic pixels; no product image or network is used.
function drawn(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x / width, y / height);
      pixels.set([r, g, b], (y * width + x) * 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}
// A "product photo": a dark garment-like blob on a light background with a diagonal stripe.
const product = (u, v) => {
  const inside = (u - 0.5) ** 2 / 0.09 + (v - 0.55) ** 2 / 0.12 < 1;
  const stripe = Math.abs(u - v) < 0.08;
  return inside ? (stripe ? [200, 180, 60] : [70, 60, 50]) : [235, 235, 230];
};
// A different picture: horizontal bands.
const other = (u, v) => (Math.floor(v * 6) % 2 ? [30, 30, 30] : [220, 220, 220]).map((value, index) => (index === 0 ? value : value * (1 - u * 0.5)));

test("the same picture re-encoded, resized or turned into another format keeps its fingerprint", async () => {
  assert.equal(IMAGE_FINGERPRINT_VERSION, "dhash-64-v1");
  const original = await imageFingerprintFromBuffer(await drawn(800, 800, product).jpeg({ quality: 92 }).toBuffer());
  assert.match(original, /^[0-9a-f]{16}$/);
  const variants = [
    await drawn(800, 800, product).jpeg({ quality: 40 }).toBuffer(),
    await drawn(800, 800, product).resize(220, 220).jpeg({ quality: 80 }).toBuffer(),
    await drawn(800, 800, product).png().toBuffer(),
    await drawn(800, 800, product).webp({ quality: 70 }).toBuffer()
  ];
  for (const variant of variants) {
    const distance = imageFingerprintDistance(original, await imageFingerprintFromBuffer(variant));
    assert.ok(distance <= 5, `distance ${distance}`);
    assert.equal(classifyImageSimilarity(distance), "identical");
  }
});

test("a different picture is far away, and the three levels are fixed by distance", async () => {
  const left = await imageFingerprintFromBuffer(await drawn(600, 600, product).jpeg().toBuffer());
  const right = await imageFingerprintFromBuffer(await drawn(600, 600, other).jpeg().toBuffer());
  const distance = imageFingerprintDistance(left, right);
  assert.ok(distance > 12, `distance ${distance}`);
  assert.equal(classifyImageSimilarity(distance), "different");
  assert.deepEqual([0, 5, 6, 12, 13, 64].map(classifyImageSimilarity), ["identical", "identical", "similar", "similar", "different", "different"]);
  assert.equal(imageFingerprintDistance("ffffffffffffffff", "0000000000000000"), 64);
  for (const bad of [-1, 65, 1.5, "3", null]) assert.throws(() => classifyImageSimilarity(bad), ImageFingerprintError);
  for (const bad of ["fff", "FFFFFFFFFFFFFFFF", null]) assert.throws(() => imageFingerprintDistance(bad, "0000000000000000"), ImageFingerprintError);
});

test("transparent areas count as white, and anything that is not an image is refused", async () => {
  const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const white = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toBuffer();
  assert.equal(await imageFingerprintFromBuffer(transparent), await imageFingerprintFromBuffer(white));
  for (const bad of [Buffer.from("<html>not an image</html>"), Buffer.alloc(0), "a string", null]) {
    await assert.rejects(imageFingerprintFromBuffer(bad), (error) => error instanceof ImageFingerprintError && error.code === "IMAGE_INVALID");
  }
});

test("only platform image hosts are fetched, without cookies, referer or redirects, and within a size limit", async () => {
  for (const allowed of ["https://img.pddpic.com/garner-api-new/a.jpeg", "https://cbu01.alicdn.com/img/ibank/a.jpg", "https://t00img.yangkeduo.com/a.jpeg",
    "https://ir.ozone.ru/s3/multimedia-1-d/wc300/10133108869.jpg"]) {
    assert.equal(imageFingerprintUrlAllowed(allowed), true, allowed);
  }
  for (const refused of ["http://img.pddpic.com/a.jpeg", "https://img.pddpic.com.evil.example/a.jpeg", "https://user:pw@img.pddpic.com/a.jpeg",
    "https://img.pddpic.com:8443/a.jpeg", "https://example.com/a.jpeg", "https://cdn.ir.ozone.ru.evil.example/a.jpg",
    "https://evil-ir.ozone.ru/a.jpg", "file:///etc/passwd", 42]) {
    assert.equal(imageFingerprintUrlAllowed(refused), false, String(refused));
    await assert.rejects(fetchImageFingerprint(refused, { fetchImpl: () => assert.fail("must not fetch") }), /URL_NOT_ALLOWED/);
  }

  const jpeg = await drawn(300, 300, product).jpeg().toBuffer();
  const calls = [];
  const respond = (body, type = "image/jpeg", ok = true, length = null) => async (url, init) => {
    calls.push({ url, init });
    return new Response(ok ? body : null, { status: ok ? 200 : 404, headers: { "content-type": type, ...(length ? { "content-length": String(length) } : {}) } });
  };
  const url = "https://img.pddpic.com/garner-api-new/synthetic.jpeg";
  assert.equal(await fetchImageFingerprint(url, { fetchImpl: respond(jpeg) }), await imageFingerprintFromBuffer(jpeg));
  assert.deepEqual([calls[0].init.redirect, calls[0].init.credentials, calls[0].init.referrerPolicy, calls[0].init.method], ["error", "omit", "no-referrer", "GET"]);
  await assert.rejects(fetchImageFingerprint(url, { fetchImpl: respond(jpeg, "text/html") }), /IMAGE_INVALID/);
  await assert.rejects(fetchImageFingerprint(url, { fetchImpl: respond(jpeg, "image/jpeg", false) }), /FETCH_FAILED/);
  await assert.rejects(fetchImageFingerprint(url, { fetchImpl: async () => { throw new TypeError("redirect"); } }), /FETCH_FAILED/);
  await assert.rejects(fetchImageFingerprint(url, { fetchImpl: respond(jpeg, "image/jpeg", true, 9 * 1024 * 1024) }), /IMAGE_TOO_LARGE/);
  await assert.rejects(fetchImageFingerprint(url, { fetchImpl: respond(Buffer.alloc(9 * 1024 * 1024)) }), /IMAGE_TOO_LARGE/);
});
