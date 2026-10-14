import assert from "node:assert/strict";
import test from "node:test";
import { C1AiGatewayError, C1_GATEWAY_SOURCE_BINDING_VERSION, buildC1GatewayJob,
  readC1SavedDraftResultFromGateway } from "../lib/c1-ai-gateway.mjs";
import { validateC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { buildRequest, receipt, authorizedExecution } from "./fixtures/c1-ai-draft-fixture.mjs";

function fixture() {
  const request = buildRequest();
  const execution = authorizedExecution(request);
  const jobId = "gateway:saved-draft:1";
  const job = {
    ...buildC1GatewayJob({ candidateId: execution.identity.candidateId, dataRevision: execution.candidateRevision, request }),
    sourceBinding: { schemaVersion: C1_GATEWAY_SOURCE_BINDING_VERSION,
      softwareJobId: execution.jobId, requestFingerprint: request.requestFingerprint,
      sourceSkuRevision: request.sourceSkuRevision, c1PlanId: request.identity.c1PlanId,
      platform: request.sourceIdentity.platform, storeRef: structuredClone(request.sourceIdentity.storeRef),
      supplierSkuId: request.sourceIdentity.supplierSkuId, variantKey: request.identity.variantKey },
    jobId, status: "completed", attempt: 1,
    startedAt: "2026-08-22T02:01:00.000Z", completedAt: "2026-08-22T02:01:01.000Z",
    receipt: { receiptVersion: "inference-receipt-v1", providerRequestId: "provider:saved-draft:1", requestHash: "a".repeat(64),
      validation: { schemaValid: true }, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      output: receipt(request).output }
  };
  const calls = [];
  const input = { request, authorizedExecution: execution, gatewayJobId: jobId,
    gatewayUrl: "http://127.0.0.1:4318", fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, redirect: options.redirect, body: options.body });
      return Response.json(job);
    } };
  return { request, execution, jobId, job, calls, input };
}

function assertOneRead(f) {
  assert.deepEqual(f.calls, [{ url: `http://127.0.0.1:4318/v1/inference-jobs/${encodeURIComponent(f.jobId)}`,
    method: "GET", redirect: "error", body: undefined }]);
}

test("saved completed job is read once with its original scope and produces the existing validated receipt", async () => {
  const f = fixture(), before = structuredClone({ request: f.request, execution: f.execution });
  const result = await readC1SavedDraftResultFromGateway(f.input);
  assertOneRead(f);
  assert.equal(result.status, "receipt_ready");
  assert.equal(result.jobId, f.jobId);
  assert.deepEqual(result.request, f.request);
  assert.equal(result.receipt.softwareJobId, f.execution.jobId);
  assert.equal(result.receipt.gatewayJobId, f.jobId);
  assert.equal(result.receipt.requestFingerprint, f.request.requestFingerprint);
  assert.equal(result.receipt.completedAt, f.job.completedAt);
  assert.equal(result.receipt.accounting.usage.total_tokens, 10);
  assert.equal(result.receipt.accounting.charge.status, "unknown");
  assert.equal(validateC1AiDraftReceipt({ request: f.request, receipt: result.receipt }).valid, true);
  assert.equal(result.codexWakeups, 0);
  assert.equal(result.platformWrites, 0);
  assert.deepEqual({ request: f.request, execution: f.execution }, before);
});

test("queued and running return pending after one read without inventing accounting or polling", async () => {
  for (const status of ["queued", "running"]) {
    const f = fixture(); f.job.status = status; delete f.job.receipt;
    const result = await readC1SavedDraftResultFromGateway(f.input);
    assertOneRead(f);
    assert.equal(result.status, "pending");
    assert.equal(result.gatewayStatus, status);
    assert.equal(result.jobId, f.jobId);
    assert.deepEqual(result.request, f.request);
    assert.equal(Object.hasOwn(result, "receipt"), false);
    assert.equal(Object.hasOwn(result, "accounting"), false);
  }
});

test("every returned status must match the accepted job, exact source binding and full execution identity", async () => {
  const changes = [
    job => { job.jobId = "gateway:other"; },
    job => { delete job.sourceBinding; },
    job => { job.sourceBinding.softwareJobId = "software-job:other"; },
    job => { job.sourceBinding.requestFingerprint = "b".repeat(64); },
    job => { job.sourceBinding.sourceSkuRevision += 1; },
    job => { job.sourceBinding.c1PlanId = "c1-plan:other"; },
    job => { job.sourceBinding.storeRef.mappingVersion = "other"; },
    job => { job.sourceBinding.supplierSkuId = "OTHER-SKU"; },
    job => { job.sourceBinding.variantKey = "colour:other"; },
    job => { job.candidateId = "OTHER-CANDIDATE"; },
    job => { job.skuPackageId = "OTHER-SKU-PACKAGE"; },
    job => { job.dataRevision = "999"; },
    job => { job.businessPhase = "C2"; },
    job => { job.taskType = "other"; },
    job => { job.model = "other"; },
    // The gateway assigns attempt 1 when queued, before provider transmission starts.
    job => { job.attempt = 0; },
    job => { job.attempt = 2; }
  ];
  for (const status of ["queued", "running", "failed", "completed"]) {
    for (const change of changes) {
      const f = fixture(); f.job.status = status; change(f.job);
      await assert.rejects(readC1SavedDraftResultFromGateway(f.input), error => error instanceof C1AiGatewayError &&
        ["C1_AI_GATEWAY_SOURCE_BINDING_MISMATCH", "C1_AI_GATEWAY_RECEIPT_MISMATCH"].includes(error.code) &&
        error.jobId === f.jobId && error.externalRequestState === "unknown_outcome");
      assertOneRead(f);
    }
  }
});

test("known provider failure retains the exact terminal outcome and accounting without repeating the request", async () => {
  for (const [externalRequestState, requestTransmission, expected] of [
    ["not_sent", "not_attempted", "failed"], ["failed", "response_received", "failed"], ["unknown_outcome", "unknown", "unknown_outcome"]
  ]) {
    const f = fixture();
    Object.assign(f.job, { status: "failed", externalRequestState, requestTransmission,
      failure: { code: "PROVIDER_FAILURE", layer: "inference" } });
    await assert.rejects(readC1SavedDraftResultFromGateway(f.input), error => error instanceof C1AiGatewayError &&
      error.code === "PROVIDER_FAILURE" && error.jobId === f.jobId && error.externalRequestState === expected &&
      error.accounting.gatewayJobId === f.jobId && error.accounting.usage.total_tokens === 10 &&
      error.providerOutcome.externalRequestState === externalRequestState && error.providerOutcome.requestTransmission === requestTransmission);
    assertOneRead(f);
  }
});

test("completed output still passes schema and domain checks and rejected content retains paid accounting", async () => {
  for (const [change, code] of [
    [job => { job.receipt.validation.schemaValid = false; }, "C1_AI_GATEWAY_OUTPUT_INVALID"],
    [job => { job.receipt.output.title.assertions[0].value = "invented value"; }, "C1_AI_GATEWAY_RECEIPT_REJECTED"]
  ]) {
    const f = fixture(); change(f.job);
    await assert.rejects(readC1SavedDraftResultFromGateway(f.input), error => error instanceof C1AiGatewayError &&
      error.code === code && error.externalRequestState === "succeeded" && error.jobId === f.jobId &&
      error.accounting.gatewayJobId === f.jobId && error.accounting.usage.total_tokens === 10);
    assertOneRead(f);
  }
});

test("network, HTTP, malformed JSON and unknown statuses preserve uncertainty without retry or raw diagnostics", async () => {
  const cases = [
    [async () => { throw new Error("private upstream diagnostic"); }, "C1_AI_GATEWAY_STATUS_UNAVAILABLE"],
    [async () => Response.json({ error: { code: "READ_UNAVAILABLE" } }, { status: 503 }), "READ_UNAVAILABLE"],
    [async () => new Response("private upstream diagnostic"), "C1_AI_GATEWAY_INVALID_JSON"],
    [async () => Response.json(null), "C1_AI_GATEWAY_STATUS_INVALID"],
    [async () => Response.json({ status: "cancelled" }), "C1_AI_GATEWAY_STATUS_INVALID"]
  ];
  for (const [read, code] of cases) {
    const f = fixture(); let calls = 0;
    await assert.rejects(readC1SavedDraftResultFromGateway({ ...f.input, fetchImpl: async (_url, options) => {
      calls += 1; assert.equal(options.method, "GET"); return read();
    } }), error => error instanceof C1AiGatewayError && error.code === code && error.jobId === f.jobId &&
      error.externalRequestState === "unknown_outcome" && error.accounting.gatewayJobId === f.jobId &&
      !error.message.includes("private upstream") && error.cause === undefined);
    assert.equal(calls, 1);
  }
});

test("a stalled read or body is bounded and aborted after one GET", async () => {
  for (const stalledBody of [false, true]) {
    const f = fixture(); let calls = 0, signal;
    await assert.rejects(readC1SavedDraftResultFromGateway({ ...f.input, totalTimeoutMs: 20,
      fetchImpl: async (_url, options) => {
        calls += 1; signal = options.signal;
        return stalledBody ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
      }
    }), error => error.code === "C1_AI_GATEWAY_DEADLINE_EXCEEDED" && error.jobId === f.jobId && error.externalRequestState === "unknown_outcome");
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});

test("invalid saved request, admission, job reference or deadline causes zero reads", async () => {
  for (const change of [
    input => { input.request.requestedAt = "2026-08-22T03:00:00.000Z"; },
    input => { input.authorizedExecution.requestFingerprint = "b".repeat(64); },
    input => { input.gatewayJobId = ""; },
    input => { input.gatewayJobId = "https://example.invalid/?token=secret"; },
    input => { input.totalTimeoutMs = 60001; }
  ]) {
    const f = fixture();
    f.input.request = structuredClone(f.input.request);
    f.input.authorizedExecution = structuredClone(f.input.authorizedExecution);
    change(f.input);
    await assert.rejects(readC1SavedDraftResultFromGateway(f.input));
    assert.equal(f.calls.length, 0);
  }
});
