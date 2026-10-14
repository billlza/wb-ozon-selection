import test from "node:test";
import assert from "node:assert/strict";
import { INTAKE_OZON_WORDS_MODEL, INTAKE_OZON_WORDS_TASK_TYPE, IntakeOzonWordsError, buildIntakeOzonWordsRequest,
  completedIntakeOzonWords, createIntakeOzonWordsTranslator, failedIntakeOzonWords, interruptedIntakeOzonWords, intakeOzonWordsTitle,
  parseIntakeOzonWords, requestedIntakeOzonWords, skippedIntakeOzonWords } from "../lib/intake-ozon-words.mjs";

// The title and every id below are synthetic.
const TITLE = "合成宠物背心 狗狗衣服 冬季加厚";
const gatewayUrl = "http://127.0.0.1:47999";

function fakeGateway(steps) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return { ok: (step.status ?? 200) < 400, status: step.status ?? 200, json: async () => step.body };
  };
  return { calls, fetchImpl };
}
const completed = (output, extra = {}) => ({ body: { jobId: "GW-synthetic-1", status: "completed", model: INTAKE_OZON_WORDS_MODEL,
  taskType: INTAKE_OZON_WORDS_TASK_TYPE, receipt: { output, usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 },
    completedAt: "2026-10-11T10:00:00.000Z" }, ...extra } });

test("要翻的只有这一轮读到的货源标题；请求锁定商品、修订号、任务、模型和输出格式，只带公开标题", () => {
  const candidate = { intake: { jobs: { sourceCaptureId: "SCJ-1" } }, sourceCapture: { captureId: "SCJ-1", title: `  ${TITLE}\n` } };
  assert.equal(intakeOzonWordsTitle(candidate), TITLE);
  assert.equal(intakeOzonWordsTitle({ ...candidate, sourceCapture: { captureId: "SCJ-old", title: TITLE } }), null);
  assert.equal(intakeOzonWordsTitle({ ...candidate, sourceCapture: { captureId: "SCJ-1", title: "" } }), null);

  const request = buildIntakeOzonWordsRequest({ candidateId: "USR-1", dataRevision: 7, title: TITLE });
  assert.deepEqual([request.candidateId, request.dataRevision, request.businessPhase, request.taskType, request.model, request.input.images],
    ["USR-1", "7", "A", "russian_translation", "gpt-5.6-terra", []]);
  assert.ok(request.input.text.includes(JSON.stringify(TITLE)));
  assert.deepEqual(request.outputSchema, { type: "object", additionalProperties: false, required: ["query"],
    properties: { query: { type: "string", minLength: 2, maxLength: 60 } } });
  assert.equal(request.evidenceRefs[0].kind, "source_capture_title");
  assert.throws(() => buildIntakeOzonWordsRequest({ candidateId: "USR-1", dataRevision: 7, title: "" }), IntakeOzonWordsError);
});

test("读回来的词只认能在 Ozon 搜的俄文：夹中文、只有拉丁字母、多了别的键、太长的都不算", () => {
  assert.equal(parseIntakeOzonWords({ query: "  жилет  для собак " }), "жилет для собак");
  assert.equal(parseIntakeOzonWords('{"query":"шлейка для собак"}'), "шлейка для собак");
  for (const bad of [{ query: "宠物 жилет" }, { query: "dog vest" }, { query: "жилет", note: "x" }, { query: "ж".repeat(61) }, "не json", []]) {
    assert.throws(() => parseIntakeOzonWords(bad), (error) => error instanceof IntakeOzonWordsError && error.layer === "validation");
  }
});

test("一次请求读到完成：等的时候只读不重发；词、作业号、真实用量记进回执", async () => {
  const gateway = fakeGateway([{ body: { jobId: "GW-synthetic-1", status: "queued" } }, completed({ query: "жилет для собак" })]);
  const translator = createIntakeOzonWordsTranslator({ gatewayUrl, fetchImpl: gateway.fetchImpl, wait: async () => {} });
  const request = buildIntakeOzonWordsRequest({ candidateId: "USR-1", dataRevision: 3, title: TITLE });
  const result = await translator.translate(request);
  assert.deepEqual([result.query, result.jobId, result.completedAt], ["жилет для собак", "GW-synthetic-1", "2026-10-11T10:00:00.000Z"]);
  assert.deepEqual(gateway.calls.map((call) => [call.method, call.url]),
    [["POST", `${gatewayUrl}/v1/inference-jobs`], ["GET", `${gatewayUrl}/v1/inference-jobs/GW-synthetic-1`]]);
  assert.deepEqual(gateway.calls[0].body, request);

  const requested = requestedIntakeOzonWords({ imageCaptureId: "OMJ-1", title: TITLE, request, requestedAt: "2026-10-11T09:59:00.000Z" });
  assert.deepEqual([requested.status, requested.attempt, requested.authorization.kind, requested.input.title, requested.requestFingerprint.length],
    ["requested", 1, "owner_standing_decision", TITLE, 64]);
  const done = completedIntakeOzonWords(requested, result);
  assert.deepEqual([done.status, done.query, done.gatewayJobId, done.validation, done.usage],
    ["completed", "жилет для собак", "GW-synthetic-1", "passed", { inputTokens: 120, outputTokens: 9, totalTokens: 129 }]);
});

test("没翻成的说清在哪一层：网关拒绝、模型不对、输出不合格、超时都只发一次", async () => {
  const request = buildIntakeOzonWordsRequest({ candidateId: "USR-1", dataRevision: 3, title: TITLE });
  const requested = requestedIntakeOzonWords({ imageCaptureId: "OMJ-1", title: TITLE, request, requestedAt: "2026-10-11T09:59:00.000Z" });
  const run = async (steps, options = {}) => {
    const gateway = fakeGateway(steps);
    const translator = createIntakeOzonWordsTranslator({ gatewayUrl, fetchImpl: gateway.fetchImpl, wait: async () => {}, ...options });
    const error = await translator.translate(request).then(() => null, (caught) => caught);
    assert.ok(error instanceof IntakeOzonWordsError, String(error));
    return { error, posts: gateway.calls.filter((call) => call.method === "POST").length,
      record: failedIntakeOzonWords(requested, error, "2026-10-11T10:01:00.000Z") };
  };
  const refused = await run([{ status: 422, body: { error: { code: "EVIDENCE_REQUIRED", message: "synthetic" } } }]);
  assert.deepEqual([refused.posts, refused.record.status, refused.record.failure.layer, refused.record.usage], [1, "failed", "gateway", "unknown"]);
  assert.match(refused.record.failure.detail, /EVIDENCE_REQUIRED/);
  const swapped = await run([completed({ query: "жилет" }, { model: "another-model" })]);
  assert.deepEqual([swapped.posts, swapped.record.failure.layer, swapped.record.gatewayJobId], [1, "gateway", "GW-synthetic-1"]);
  const chinese = await run([completed({ query: "狗狗背心" })]);
  assert.deepEqual([chinese.record.status, chinese.record.validation, chinese.record.usage.totalTokens], ["failed", "failed", 129]);
  let clock = 0;
  const slow = await run([{ body: { jobId: "GW-slow", status: "running" } }, { body: { jobId: "GW-slow", status: "running" } }],
    { now: () => (clock += 40_000), timeoutMs: 60_000 });
  assert.deepEqual([slow.posts, slow.record.status, slow.record.gatewayJobId], [1, "unknown_outcome", "GW-slow"]);
  const offline = await run([new Error("connect ECONNREFUSED")]);
  assert.deepEqual([offline.record.status, offline.record.failure.code], ["failed", "GATEWAY_FAILED"]);
});

test("没发请求的、服务重启没等到的，都只记下来，不重发", () => {
  const skipped = skippedIntakeOzonWords({ imageCaptureId: "OMJ-1", title: null, layer: "input", code: "SOURCE_TITLE_MISSING",
    detail: "synthetic", at: "2026-10-11T10:00:00.000Z" });
  assert.deepEqual([skipped.status, skipped.attempt, skipped.requestFingerprint, skipped.gatewayJobId, skipped.input], ["failed", 0, null, null, null]);
  const request = buildIntakeOzonWordsRequest({ candidateId: "USR-1", dataRevision: 3, title: TITLE });
  const requested = requestedIntakeOzonWords({ imageCaptureId: "OMJ-1", title: TITLE, request, requestedAt: "2026-10-11T09:59:00.000Z" });
  const interrupted = interruptedIntakeOzonWords(requested, "2026-10-11T10:05:00.000Z");
  assert.deepEqual([interrupted.status, interrupted.failure.code, interrupted.attempt], ["unknown_outcome", "SERVICE_RESTARTED", 1]);
});
