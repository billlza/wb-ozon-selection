import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  assertTrustedApiRequest,
  isExtensionEndpoint,
  isTrustedInternalApiRequest,
  normalizeAllowedChromeExtensionOrigins,
  normalizeHttpErrorResponse,
  parseHttpRequestTarget,
  readJsonRequestBody
} from "../lib/http-api-boundary.mjs";

function reqFromChunks(chunks, headers = {}) {
  const stream = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

function encodeUtf8(value) {
  return Buffer.from(value, "utf8");
}

test("JSON请求体先按字节收集再完整UTF-8解码，中文和emoji跨chunk不损坏", async () => {
  const text = JSON.stringify({ message: "中文😀测试" });
  const body = encodeUtf8(text);
  for (let split = 1; split < body.length; split += 1) {
    const parsed = await readJsonRequestBody(reqFromChunks([
      body.subarray(0, split),
      body.subarray(split)
    ], { "content-type": "application/json; charset=utf-8" }));
    assert.deepEqual(parsed, { message: "中文😀测试" }, `split=${split}`);
  }
});

test("JSON请求体按UTF-8字节上限拒绝，不能用UTF-16字符数绕过2MB", async () => {
  const body = encodeUtf8(JSON.stringify({ message: "中".repeat(700_000) }));
  assert.ok(body.byteLength > 2_000_000);
  await assert.rejects(
    readJsonRequestBody(reqFromChunks([body], {
      "content-type": "application/json",
      "content-length": String(body.byteLength)
    })),
    /请求内容过大/
  );
});

test("JSON写请求拒绝text/plain；服务端写路由即使空正文也先检查媒体类型", async () => {
  await assert.rejects(
    readJsonRequestBody(reqFromChunks([encodeUtf8(JSON.stringify({ ok: true }))], { "content-type": "text/plain" })),
    /application\/json/
  );
  await assert.rejects(
    readJsonRequestBody(reqFromChunks([], { "content-type": "text/plain" }), { requireJsonContentType: true }),
    /application\/json/
  );
  assert.deepEqual(await readJsonRequestBody(reqFromChunks([], { "content-type": "application/json" }), { requireJsonContentType: true }), {});
});

test("请求路径解析把畸形percent编码收口为400而不是泄漏URIError栈", () => {
  assert.equal(parseHttpRequestTarget("/api/%E4%B8%AD%E6%96%87", "127.0.0.1:4317").pathname, "/api/中文");
  assert.throws(() => parseHttpRequestTarget("/api/%E0%A4%A", "127.0.0.1:4317"), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.extra.code, "request_path_encoding_invalid");
    assert.match(error.message, /请求路径编码无效/);
    return true;
  });
  assert.throws(() => parseHttpRequestTarget("http://[bad-host/", "127.0.0.1:4317"), /请求路径无效/);
});

test("HTTP错误响应只对预期4xx返回安全消息，未知500不回显底层细节", () => {
  const notFound = normalizeHttpErrorResponse(Object.assign(
    new Error("文件不存在"),
    { status: 404, extra: { code: "static_file_not_found" } }
  ));
  assert.deepEqual(notFound, {
    status: 404,
    body: { message: "文件不存在", code: "static_file_not_found" },
    shouldLogStack: false
  });
  const unknown = normalizeHttpErrorResponse(new Error("ENOENT: no such file, open '/Users/name/secret.png'"));
  assert.deepEqual(unknown, {
    status: 500,
    body: { message: "服务器错误" },
    shouldLogStack: true
  });
});

test("API写请求校验可信Host、页面Origin和Fetch-Site", () => {
  const base = {
    trustedServiceOrigins: ["http://127.0.0.1:4317"],
    allowedReviewOrigins: ["http://127.0.0.1:4317"],
    allowedExtensionOrigins: []
  };
  assert.equal(assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates",
    headers: {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    }
  }), true);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates",
    headers: { host: "127.0.0.1:4317", origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }
  }), /非评审台页面来源/);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates",
    headers: { host: "evil.example", origin: "http://127.0.0.1:4317" }
  }), /Host不在评审台可信来源/);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates",
    headers: { host: "127.0.0.1:4317", "sec-fetch-site": "same-origin", "content-type": "application/json" }
  }), /必须来自评审台页面来源/);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates",
    headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "content-type": "application/json" }
  }), /跨站浏览器来源/);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates",
    headers: {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain"
    }
  }), /application\/json/);
  assert.equal(assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/dispatches/D-1/complete",
    headers: {
      host: "127.0.0.1:4317",
      "content-type": "application/json",
      "x-selection-review-internal-token": "internal-test-token"
    },
    internalRequestToken: "internal-test-token"
  }), true);
  assert.equal(isTrustedInternalApiRequest({
    "x-selection-review-internal-token": "internal-test-token"
  }, "internal-test-token"), true);
  assert.equal(isTrustedInternalApiRequest({
    "x-selection-review-internal-token": "wrong-token"
  }, "internal-test-token"), false);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/dispatches/D-1/complete",
    headers: {
      host: "127.0.0.1:4317",
      "content-type": "application/json",
      "x-selection-review-internal-token": "wrong-token"
    },
    internalRequestToken: "internal-test-token"
  }), /必须来自评审台页面来源/);
  assert.equal(assertTrustedApiRequest({
    ...base,
    method: "POST",
    pathname: "/api/candidates/C-1/lifecycle/c2/final-assets/upload",
    headers: {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "sec-fetch-site": "same-origin",
      "content-type": "image/jpeg"
    }
  }), true);
  assert.equal(assertTrustedApiRequest({
    trustedServiceOrigins: ["http://[::1]:4317"],
    allowedReviewOrigins: ["http://[::1]:4317"],
    allowedExtensionOrigins: [],
    method: "POST",
    pathname: "/api/candidates",
    headers: {
      host: "[::1]:4317",
      origin: "http://[::1]:4317",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    }
  }), true);
});

test("扩展API默认不信任任意chrome-extension来源，只接受显式白名单", () => {
  const allowedExtensionOrigins = normalizeAllowedChromeExtensionOrigins([
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ]);
  const base = {
    method: "POST",
    pathname: "/api/extension/heartbeat",
    trustedServiceOrigins: ["http://127.0.0.1:4317"],
    allowedReviewOrigins: ["http://127.0.0.1:4317"]
  };
  assert.equal(assertTrustedApiRequest({
    ...base,
    allowedExtensionOrigins,
    headers: {
      host: "127.0.0.1:4317",
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "content-type": "application/json"
    }
  }), true);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    allowedExtensionOrigins: [],
    headers: {
      host: "127.0.0.1:4317",
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "content-type": "application/json"
    }
  }), /已配置的本机Chrome扩展来源/);
  assert.throws(() => assertTrustedApiRequest({
    ...base,
    allowedExtensionOrigins,
    headers: {
      host: "127.0.0.1:4317",
      origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "content-type": "application/json"
    }
  }), /已配置的本机Chrome扩展来源/);
});

test("插件回传的每条路由都按插件来源核对，Seerfar 一轮的结果也在里面", () => {
  const extension = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const request = (pathname, origin) => assertTrustedApiRequest({
    method: "POST",
    pathname,
    trustedServiceOrigins: ["http://127.0.0.1:4317"],
    allowedReviewOrigins: ["http://127.0.0.1:4317"],
    allowedExtensionOrigins: [extension],
    headers: { host: "127.0.0.1:4317", origin, "content-type": "application/json", "sec-fetch-site": "same-origin" }
  });
  const pluginRoutes = ["/api/extension/heartbeat", "/api/extension/capture-jobs/job-1/claim", "/api/extension/capture-jobs/job-1/search-image",
    "/api/candidates/C-1/source-capture/result", "/api/candidates/C-1/sales-capture/result", "/api/candidates/C-1/image-match/result",
    "/api/candidates/C-1/ozon-match/result", "/api/seerfar-selection/rounds/round-1/result"];
  for (const pathname of pluginRoutes) {
    assert.equal(isExtensionEndpoint(pathname), true, pathname);
    assert.equal(request(pathname, extension), true, pathname);
    assert.throws(() => request(pathname, "http://127.0.0.1:4317"), /已配置的本机Chrome扩展来源/u, pathname);
  }
  // Starting a round stays the review page's.
  assert.equal(isExtensionEndpoint("/api/seerfar-selection/rounds"), false);
  assert.equal(request("/api/seerfar-selection/rounds", "http://127.0.0.1:4317"), true);
});
