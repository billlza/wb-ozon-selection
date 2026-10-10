import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import {
  C1_AI_DRAFT_REQUEST_VERSION,
  mergeC1AiDraftReceipt as mergeFormalReceipt,
  assertAuthorizedC1Execution,
  assertCurrentC1AiDraftRequest,
  projectC1ProviderJobReference,
  createC1AiAccounting,
  validateC1AiAccounting,
  validateC1AiDraftRequest,
  validateC1AiDraftReceipt
} from "../lib/c1-ai-draft-contract.mjs";
import {
  C1AiGatewayError,
  C1_GATEWAY_SOURCE_BINDING_VERSION,
  buildC1GatewayJob,
  runC1AiDraftThroughGateway,
  runC1SavedDraftRequestThroughGateway
} from "../lib/c1-ai-gateway.mjs";
import { runC1SoftwareOrchestration } from "../lib/c1-software-orchestrator.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";

import { CREATED_AT, nonTrainSkuPackage, competitorTextSnapshot, keywordEvidence, seoRules, standardClassification, buildRequest, receipt, authorizedExecution, settledExecution } from "./fixtures/c1-ai-draft-fixture.mjs";
function gatewayRuntimeInput() { return { onGatewayJobAccepted: async () => {} }; }

function gatewayBinding(request) {
  return { sourceBinding: { schemaVersion: C1_GATEWAY_SOURCE_BINDING_VERSION,
    softwareJobId: authorizedExecution(request).jobId, requestFingerprint: request.requestFingerprint,
    sourceSkuRevision: request.sourceSkuRevision, c1PlanId: request.identity.c1PlanId,
    platform: request.sourceIdentity.platform, storeRef: structuredClone(request.sourceIdentity.storeRef),
    supplierSkuId: request.sourceIdentity.supplierSkuId, variantKey: request.identity.variantKey } };
}

function mergeC1AiDraftReceipt(input) {
  return mergeFormalReceipt({ ...input, settledExecution: settledExecution(input.request, input.receipt) });
}

test("普通非火车SKU构造Terra单次请求，只携带四类冻结输入与已确认事实", () => {
  const request = buildRequest();
  assert.equal(request.schemaVersion, C1_AI_DRAFT_REQUEST_VERSION);
  assert.equal(request.provider, "terra");
  assert.equal(request.identity.supplierSkuId, "SINK-BLUE");
  assert.equal(request.executionPolicy.attemptLimit, 1);
  assert.equal(request.executionPolicy.automaticRetry, false);
  assert.equal(request.executionPolicy.fallbackProvider, null);
  assert.equal(request.executionPolicy.codexDispatch, false);
  assert.equal(request.executionPolicy.platformAccessAllowed, false);
  assert.equal(request.verifiedFacts.some((item) => item.factPath === "productAttributes.material"), true);
  assert.equal(request.verifiedFacts.some((item) => item.factPath === "productAttributes.brand"), false);
  assert.deepEqual(request.keywordEvidence.keywords.map((item) => item.query), ["органайзер для раковины"]);
});

test("Sol只接受调用前已标记并批准的复杂任务，Terra失败策略不自动切换", () => {
  const terraRequest = buildRequest();
  const failedTerraReceipt = receipt(terraRequest, { status: "failed" });
  assert.equal(validateC1AiDraftReceipt({ request: terraRequest, receipt: failedTerraReceipt }).valid, false);
  assert.equal(terraRequest.provider, "terra");
  assert.equal(terraRequest.executionPolicy.fallbackProvider, null);
  const complex = standardClassification();
  complex.complexity = "complex";
  assert.throws(() => buildRequest({ taskClassification: complex }), /SOL_PREAPPROVAL_REQUIRED/);
  complex.preapprovedForSol = true;
  complex.reason = "预先识别的复杂多属性俄语表达任务";
  const request = buildRequest({ taskClassification: complex });
  assert.equal(request.provider, "sol");
  assert.equal(request.executionPolicy.solFallbackAfterTerraFailure, false);
  const ordinary = standardClassification();
  ordinary.preapprovedForSol = true;
  assert.throws(() => buildRequest({ taskClassification: ordinary }), /ROUTE_SCOPE_REJECTED/);
});

test("严格回执校验后合并draft_only，保留B和SKU且不进入C2/D/E", () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const aiReceipt = receipt(request);
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: aiReceipt }), { valid: true, errors: [] });
  const result = mergeC1AiDraftReceipt({ skuPackage, request, receipt: aiReceipt, mergedAt: "2026-08-22T02:02:00.000Z" });
  assert.equal(result.c1ProductPlan.status, "seo_draft_ready");
  assert.equal(result.c1ProductPlan.seoTitleDraft.status, "draft_only");
  assert.equal(result.c1ProductPlan.seoEvidenceLayer.provider, "terra");
  assert.equal(result.c1ProductPlan.seoEvidenceLayer.modelVersion, "terra-test-1");
  assert.equal(result.c1ProductPlan.seoEvidenceLayer.executionPolicy.codexDispatch, false);
  assert.deepEqual(result.skuPackage.profitModels, skuPackage.profitModels);
  assert.equal(result.skuPackage.supplierSkuId, "SINK-BLUE");
  assert.equal(result.skuPackage.c2FinalAssets, null);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
});

test("模型新增材质、品牌、尺寸或认证事实时拒绝且不改变B结果", () => {
  const skuPackage = nonTrainSkuPackage();
  const before = JSON.stringify(skuPackage);
  const request = buildRequest({ skuPackage });
  for (const [factPath, value] of [
    ["productAttributes.material", "wood"],
    ["productAttributes.brand", "ImaginaryBrand"],
    ["productAttributes.dimensions", { length: 99, width: 99, height: 99, unit: "cm" }],
    ["platformCompliance.certification", "EAC"]
  ]) {
    const hallucination = receipt(request);
    hallucination.output.description.assertions = [{ factPath, value }];
    const validation = validateC1AiDraftReceipt({ request, receipt: hallucination });
    assert.equal(validation.valid, false, factPath);
    assert.match(validation.errors.join(" "), /新增或篡改/);
  }
  assert.equal(JSON.stringify(skuPackage), before);
  assert.equal(skuPackage.profitModels[0].result, "passed");
});

test("缺事实引用、关键词引用或完整宣称覆盖的回执全部拒绝", () => {
  const request = buildRequest();
  const missingFact = receipt(request);
  missingFact.output.title.factRefs = [];
  assert.equal(validateC1AiDraftReceipt({ request, receipt: missingFact }).valid, false);
  const missingKeyword = receipt(request);
  missingKeyword.output.title.keywordRefs = [];
  assert.equal(validateC1AiDraftReceipt({ request, receipt: missingKeyword }).valid, false);
  const incomplete = receipt(request);
  incomplete.output.claimCoverage = "partial";
  assert.equal(validateC1AiDraftReceipt({ request, receipt: incomplete }).valid, false);
});

test("事实漂移阻止合并，同一成功回执重复合并保持幂等", () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const aiReceipt = receipt(request);
  const changed = structuredClone(skuPackage);
  changed.c1ProductPlan.productAttributes.material.value = "rubber";
  assert.throws(() => mergeC1AiDraftReceipt({
    skuPackage: changed,
    request,
    receipt: aiReceipt,
    mergedAt: "2026-08-22T02:02:00.000Z"
  }), /FACT_DRIFT_DETECTED/);

  const first = mergeC1AiDraftReceipt({ skuPackage, request, receipt: aiReceipt, mergedAt: "2026-08-22T02:02:00.000Z" });
  const second = mergeC1AiDraftReceipt({ skuPackage: first.skuPackage, request, receipt: aiReceipt, mergedAt: "2026-08-22T02:03:00.000Z" });
  assert.equal(second.idempotent, true);
  assert.equal(second.skuPackage.dataRevision, first.skuPackage.dataRevision);
  assert.deepEqual(second.skuPackage.audit.history, first.skuPackage.audit.history);
});

test("领域函数不访问4318或平台、不派发Codex，并且活动契约无火车商品默认值", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("C1领域契约禁止联网");
  };
  try {
    const skuPackage = nonTrainSkuPackage();
    const request = buildRequest({ skuPackage });
    mergeC1AiDraftReceipt({ skuPackage, request, receipt: receipt(request), mergedAt: "2026-08-22T02:02:00.000Z" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const source = await readFile(new URL("../lib/c1-ai-draft-contract.mjs", import.meta.url), "utf8");
  for (const forbidden of ["CX-20260803-010", "4993364145574", "282件", "Паровоз", "1831", "151.78"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("发布的请求和回执Schema冻结单次路由、零派发与draft_only边界", async () => {
  const requestSchema = JSON.parse(await readFile(new URL("../schema/c1-ai-draft-request-v1.schema.json", import.meta.url), "utf8"));
  const receiptSchema = JSON.parse(await readFile(new URL("../schema/c1-ai-draft-receipt-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(requestSchema.properties.executionPolicy.properties.attemptLimit.const, 1);
  assert.equal(requestSchema.properties.executionPolicy.properties.automaticRetry.const, false);
  assert.equal(requestSchema.properties.executionPolicy.properties.codexDispatch.const, false);
  assert.equal(receiptSchema.properties.output.oneOf.length, 3);
  for (const outputSchema of receiptSchema.properties.output.oneOf) {
    assert.equal(outputSchema.properties.status.const, "draft_only");
    assert.equal(outputSchema.properties.locale.const, "ru-RU");
    assert.equal(outputSchema.additionalProperties, false);
  }
  assert.equal(receiptSchema.properties.codexDispatches.const, 0);
  assert.equal(receiptSchema.properties.productionWrites.const, 0);
});

test("总控把普通C1请求锁定为4318 Terra SEO任务，不发送店铺凭证或生产授权", () => {
  const request = buildRequest();
  const job = buildC1GatewayJob({ candidateId: "GENERIC-SINK-001", dataRevision: 12, request });
  assert.equal(job.businessPhase, "C1");
  assert.equal(job.taskType, "seo_draft");
  assert.equal(job.model, "gpt-5.6-terra");
  assert.equal(job.dataRevision, "12");
  assert.equal(job.input.images.length, 0);
  assert.equal(job.evidenceRefs.length, 3);
  assert.doesNotMatch(job.input.text, /cookie|password|api[_-]?key|productionAuthorization/i);
  assert.doesNotMatch(job.input.text, /dandanshu/i);
});

test("C1网关只创建一次供应商任务并返回receipt_ready，保存前不合并或派发", async () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const gatewayOutput = receipt(request).output;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    assert.equal(options.redirect, "error");
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, "gpt-5.6-terra");
      return new Response(JSON.stringify({ ...gatewayBinding(request), jobId: "job-c1-1", status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ...gatewayBinding(request),
      jobId: "job-c1-1",
      candidateId: "GENERIC-SINK-001",
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: "12",
      businessPhase: "C1",
      taskType: "seo_draft",
      model: "gpt-5.6-terra",
      status: "completed",
      attempt: 1,
      startedAt: "2026-08-22T02:01:00.000Z",
      completedAt: "2026-08-22T02:01:01.000Z",
      receipt: {
        receiptVersion: "inference-receipt-v1",
        providerRequestId: "linlongs-c1-1",
        requestHash: "a".repeat(64),
        requestedAt: "2026-08-22T02:01:00.000Z",
        completedAt: "2026-08-22T02:01:01.000Z",
        validation: { schemaValid: true, strictJson: true },
        output: gatewayOutput
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runC1AiDraftThroughGateway({
    candidateId: "GENERIC-SINK-001",
    dataRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    requestedAt: CREATED_AT,
    authorizedExecution: authorizedExecution(request),
    ...gatewayRuntimeInput(request),
    mergedAt: "2026-08-22T02:02:00.000Z",
    gatewayUrl: "http://127.0.0.1:4318",
    fetchImpl,
    wait: async () => {},
    maxStatusReads: 2
  });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(result.supplierAttempts, 1);
  assert.equal(result.codexWakeups, 0);
  assert.equal(result.platformWrites, 0);
  assert.equal(result.status, "receipt_ready");
  assert.equal(result.skuPackage, undefined);
  assert.equal(skuPackage.c1ProductPlan.status, "facts_checked");
  assert.equal(result.receipt.softwareJobId, "software-job:c1-sink:1");
  assert.equal(result.receipt.gatewayJobId, "job-c1-1");
});

test("C1网关失败立即停止，不重复POST、不切Sol、不改变输入SKU", async () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const before = JSON.stringify(skuPackage);
  let posts = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") posts += 1;
    return new Response(JSON.stringify({
      ...gatewayBinding(request),
      jobId: "job-c1-failed",
      candidateId: "GENERIC-SINK-001",
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: "12",
      businessPhase: "C1",
      taskType: "seo_draft",
      model: "gpt-5.6-terra",
      status: "failed",
      externalRequestState: "succeeded",
      requestTransmission: "response_received",
      attempt: 1,
      failure: { code: "MODEL_OUTPUT_SCHEMA_MISMATCH", layer: "output_schema", message: "输出不符合Schema" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => runC1AiDraftThroughGateway({
    candidateId: "GENERIC-SINK-001",
    dataRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    requestedAt: CREATED_AT,
    authorizedExecution: authorizedExecution(request),
    ...gatewayRuntimeInput(request),
    gatewayUrl: "http://127.0.0.1:4318",
    fetchImpl,
    wait: async () => {}
  }), (error) => error instanceof C1AiGatewayError && error.layer === "output_schema" && error.externalRequestState === "succeeded");
  assert.equal(posts, 1);
  assert.equal(JSON.stringify(skuPackage), before);
});

test("Sol复杂任务必须在调用前锁定允许的复杂任务类型", () => {
  const complex = { ...standardClassification(), complexity: "complex", preapprovedForSol: true, reason: "类目存在实质争议" };
  const request = buildRequest({ taskClassification: complex });
  assert.throws(() => buildC1GatewayJob({ candidateId: "GENERIC-SINK-001", dataRevision: 12, request }), /COMPLEX_TASK_TYPE_REQUIRED/);
  complex.gatewayTaskType = "category_dispute_analysis";
  const accepted = buildC1GatewayJob({ candidateId: "GENERIC-SINK-001", dataRevision: 12, request: buildRequest({ taskClassification: complex }) });
  assert.equal(accepted.model, "gpt-5.6-sol");
  assert.equal(accepted.taskType, "category_dispute_analysis");
});

test("C1软件编排返回receipt_ready并保持源SKU，正常路径不生成ExceptionCase或Codex派发", async () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") {
      return new Response(JSON.stringify({ ...gatewayBinding(request), jobId: "job-c1-orchestrator", status: "running" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ...gatewayBinding(request),
      jobId: "job-c1-orchestrator",
      candidateId: "GENERIC-SINK-001",
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: "12",
      businessPhase: "C1",
      taskType: "seo_draft",
      model: "gpt-5.6-terra",
      status: "completed",
      attempt: 1,
      startedAt: "2026-08-22T02:01:00.000Z",
      completedAt: "2026-08-22T02:01:01.000Z",
      receipt: {
        receiptVersion: "inference-receipt-v1",
        providerRequestId: "linlongs-c1-orchestrator",
        requestHash: "b".repeat(64),
        requestedAt: "2026-08-22T02:01:00.000Z",
        completedAt: "2026-08-22T02:01:01.000Z",
        validation: { schemaValid: true, strictJson: true },
        output: receipt(request).output
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runC1SoftwareOrchestration({
    candidateId: "GENERIC-SINK-001",
    candidateRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    startedAt: CREATED_AT,
    authorizedExecution: authorizedExecution(buildRequest({ skuPackage })),
    gatewayOptions: { ...gatewayRuntimeInput(request), gatewayUrl: "http://127.0.0.1:4318", fetchImpl, wait: async () => {}, maxStatusReads: 2 }
  });
  assert.equal(result.status, "receipt_ready");
  assert.equal(result.exceptionCase, null);
  assert.equal(result.codexDispatches, 0);
  assert.equal(result.skuPackage.supplierSkuId, skuPackage.supplierSkuId);
  assert.deepEqual(result.skuPackage.profitModels, skuPackage.profitModels);
  assert.equal(result.c1ProductPlan.status, "facts_checked");
  assert.deepEqual(result.skuPackage, skuPackage);
  assert.equal(result.receipt.gatewayJobId, "job-c1-orchestrator");
});

test("C1网关配置错误的HTTP响应不冒充已保存失败终态，不生成ExceptionCase或Codex派发", async () => {
  const skuPackage = nonTrainSkuPackage();
  const result = await runC1SoftwareOrchestration({
    candidateId: "GENERIC-SINK-001",
    candidateRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    startedAt: CREATED_AT,
    authorizedExecution: authorizedExecution(buildRequest({ skuPackage })),
    gatewayOptions: {
      gatewayUrl: "http://127.0.0.1:4318",
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "KEY_NOT_CONFIGURED", message: "网关Key未配置" } }), { status: 503, headers: { "content-type": "application/json" } })
    }
  });
  assert.equal(result.status, "technical_failure");
  assert.equal(result.exceptionCase, null);
  assert.equal(result.technicalFailure.status, "stopped");
  assert.equal(result.technicalFailure.kind, "unknown_outcome");
  assert.equal(result.technicalFailure.automaticRetryAllowed, false);
  assert.equal(result.technicalFailure.businessStateChanged, false);
  assert.equal(result.codexDispatches, 0);
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.profitModels[0].result, "passed");
  assert.deepEqual(result.skuPackage, skuPackage);
});

test("没有精确已登记准入或作用域漂移时网关零请求，普通编排停在not_ready", async () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected external request"); };
  const input = { candidateId: "GENERIC-SINK-001", dataRevision: 12, skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(), keywordEvidence: keywordEvidence(), seoRules: seoRules(),
    taskClassification: standardClassification(), requestedAt: CREATED_AT, gatewayUrl: "http://127.0.0.1:4318", fetchImpl };
  for (const change of [null,
    entry => { entry.identity.storeRef.platformStoreId = "other-platform-store"; },
    entry => { entry.identity.storeRef.mappingVersion = "mapping-v2"; },
    entry => { entry.sourceSkuRevision += 1; },
    entry => { entry.candidateRevision += 1; },
    entry => { entry.externalRequestState = "not_sent"; },
    entry => { entry.status = "completed"; },
    entry => { entry.authorizationRef.scope.sourceRevision = 12; },
    entry => { entry.extra = "unexpected"; }
  ]) {
    const admitted = change === null ? undefined : authorizedExecution(request);
    if (change) change(admitted);
    await assert.rejects(runC1AiDraftThroughGateway({ ...input, authorizedExecution: admitted }), error =>
      /C1_AI_|C1_G1_/.test(error.code ?? error.message));
  }
  const orchestration = await runC1SoftwareOrchestration({ candidateId: "GENERIC-SINK-001", candidateRevision: 12,
    skuPackage, startedAt: CREATED_AT, gatewayOptions: { gatewayUrl: input.gatewayUrl, fetchImpl } });
  assert.equal(orchestration.status, "not_ready");
  assert.equal(orchestration.gaps[0].code, "paid_job_admission_required");
  assert.deepEqual(orchestration.skuPackage, skuPackage);
  assert.equal(calls, 0);
});

test("正式canonical只接受已保存终态与同一完整G1，区分本地和网关作业", () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const result = receipt(request);
  assert.throws(() => mergeFormalReceipt({ skuPackage, request, receipt: result, mergedAt: "2026-08-22T02:02:00.000Z" }), /SETTLED_EXECUTION_REQUIRED/);
  for (const change of [
    entry => { entry.status = "waiting_platform"; },
    entry => { entry.externalRequestState = "unknown_outcome"; },
    entry => { entry.gatewayJobId = entry.softwareJobId; },
    entry => { entry.receiptRef = "receipt:another-result"; },
    entry => { entry.authorizedExecution.identity.storeRef.mappingVersion = "stores-v2"; }
  ]) {
    const settled = settledExecution(request, result); change(settled);
    assert.throws(() => mergeFormalReceipt({ skuPackage, request, receipt: result, settledExecution: settled, mergedAt: "2026-08-22T02:02:00.000Z" }), /C1_AI_/);
  }
  const saved = settledExecution(request, result);
  const provider = projectC1ProviderJobReference({ request, receipt: result, settledExecution: saved });
  assert.equal(provider.jobId, result.gatewayJobId);
  assert.notEqual(provider.jobId, result.softwareJobId);
  assert.equal(provider.sourceRevision, skuPackage.dataRevision);
  const merged = mergeFormalReceipt({ skuPackage, request, receipt: result, settledExecution: saved, mergedAt: "2026-08-22T02:02:00.000Z" });
  assert.deepEqual(merged.c1ProductPlan.draftOnlySeo.providerJobRef, provider);
  assert.deepEqual(merged.c1ProductPlan.seoEvidenceLayer.providerJobRef, provider);
  assert.deepEqual(merged.c1ProductPlan.keywordEvidenceRefs, ["keyword:fixture:sink-organizer"]);
  assert.equal(merged.skuPackage.dataRevision, request.sourceSkuRevision + 1);
});

test("冻结Schema与搜索词回执漂移均拒绝幂等短路", () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const result = receipt(request);
  const changedInput = structuredClone(skuPackage);
  changedInput.c1ProductPlan.inputSnapshots.platformSchemaRules.requiredFields.push({ fieldKey: "new_field", label: "新字段", required: true });
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage: changedInput, request, receipt: result, mergedAt: "2026-08-22T02:02:00.000Z" }), /FACT_DRIFT_DETECTED/);
  const merged = mergeC1AiDraftReceipt({ skuPackage, request, receipt: result, mergedAt: "2026-08-22T02:02:00.000Z" });
  const changed = structuredClone(merged.skuPackage);
  changed.c1ProductPlan.searchKeywordsDraft.keywords[0].query = "changed query";
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage: changed, request, receipt: result, mergedAt: "2026-08-22T02:02:00.000Z" }), /REPLAY_DRIFT_DETECTED/);
  const invalidReceipt = structuredClone(result); invalidReceipt.outputFingerprint = "f".repeat(64);
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage: merged.skuPackage, request, receipt: invalidReceipt, mergedAt: "2026-08-22T02:02:00.000Z" }), /PROVIDER_RECEIPT_REJECTED/);
});

test("准入的当前请求校验复用冻结事实与输入比对，不把合法旧请求当作当前SKU", () => {
  const skuPackage = nonTrainSkuPackage(), request = buildRequest({ skuPackage });
  assert.deepEqual(assertCurrentC1AiDraftRequest({ skuPackage, request }), request);
  for (const change of [
    value => { value.dataRevision += 1; },
    value => { value.c1ProductPlan.productAttributes.material.value = "wood"; },
    value => { value.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision = "schema-next"; },
    value => { value.c1ProductPlan.status = "seo_draft_ready"; },
    value => { value.g1Identity.storeRef.platformStoreId = "store-other"; }
  ]) {
    const changed = structuredClone(skuPackage); change(changed);
    assert.throws(() => assertCurrentC1AiDraftRequest({ skuPackage: changed, request }), /C1_|C1ProductPlan校验失败/);
  }
  for (const original of [request, buildRequest({ skuPackage, outputContractVersion: null })]) {
    const forged = structuredClone(original);
    forged.verifiedFacts[0].value = "forged source fact";
    const core = structuredClone(forged); delete core.requestId; delete core.requestFingerprint;
    forged.requestFingerprint = fingerprintCanonicalRecord(core);
    forged.requestId = `c1-ai-request:${forged.identity.c1PlanId}:${forged.requestFingerprint.slice(0, 16)}`;
    // V2 catches frozen-schema drift before admission; legacy still checks current facts.
    const versioned = Object.hasOwn(original, "outputContractVersion");
    assert.equal(validateC1AiDraftRequest(forged).valid, !versioned);
    assert.throws(() => assertCurrentC1AiDraftRequest({ skuPackage, request: forged }),
      versioned ? /C1_AI_REQUEST_INVALID/ : /FACT_DRIFT_DETECTED/);
  }
});

test("正式C1请求、回执、入场、终态与合并plan全部通过发布Schema的strict校验", async () => {
  const ajv = await loadPublishedSchemaValidator();
  const skuPackage = nonTrainSkuPackage(), request = buildRequest({ skuPackage }), result = receipt(request);
  const admitted = authorizedExecution(request), saved = settledExecution(request, result);
  const merged = mergeC1AiDraftReceipt({ skuPackage, request, receipt: result, mergedAt: "2026-08-22T02:02:00.000Z" });
  for (const [name, value] of [["c1-ai-draft-request-v1", request], ["c1-ai-draft-receipt-v1", result],
    ["c1-ai-authorized-execution-v1", admitted], ["c1-ai-settled-execution-v1", saved], ["c1-product-plan-v1.1", merged.c1ProductPlan]]) {
    const validate = ajv.getSchema(name);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  const validate = ajv.getSchema("c1-ai-authorized-execution-v1");
  const missingMapping = structuredClone(admitted); delete missingMapping.identity.storeRef.mappingVersion;
  assert.equal(validate(missingMapping), false);
  assert.throws(() => assertAuthorizedC1Execution({ request, authorizedExecution: missingMapping }), /G1_IDENTITY_REQUIRED/);
  const secret = structuredClone(admitted); secret.authorizationRef.authorizationId = "authorization:c1-ai-draft:token-private-value";
  assert.equal(validate(secret), false);
  assert.throws(() => assertAuthorizedC1Execution({ request, authorizedExecution: secret }), /NONCANONICAL/);
});

test("回执额外控制字段、倒序或不存在的时间和提前合并均明确拒绝", () => {
  const skuPackage = nonTrainSkuPackage(), request = buildRequest({ skuPackage });
  for (const change of [
    result => { result.unexpectedControl = { productionApproved: true }; },
    result => { result.startedAt = "2026-08-22T02:02:00.000Z"; },
    result => { result.startedAt = "2026-08-22T01:59:00.000Z"; },
    result => { result.completedAt = "2026-02-30T02:02:00.000Z"; },
    result => { result.output.title.extra = "unexpected"; },
    result => { result.output.title.assertions[0].extra = "unexpected"; }
  ]) {
    const result = receipt(request); change(result);
    assert.equal(validateC1AiDraftReceipt({ request, receipt: result }).valid, false);
  }
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage, request, receipt: receipt(request), mergedAt: CREATED_AT }), /MERGE_TIME_INVALID/);
});

test("已保存请求入口保留原始时间和指纹，任何漂移或非法边界在HTTP前拒绝", async () => {
  const request = buildRequest(), admitted = authorizedExecution(request);
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.method || "GET");
    assert.equal(options.redirect, "error");
    const payload = JSON.parse(options.body);
    assert.equal(payload.candidateId, admitted.identity.candidateId);
    assert.equal(payload.dataRevision, String(admitted.candidateRevision));
    return Response.json({ ...payload, jobId: "job-c1-1", status: "completed", attempt: 1,
      startedAt: "2026-08-22T02:01:00.000Z", completedAt: "2026-08-22T02:01:01.000Z",
      receipt: { receiptVersion: "inference-receipt-v1", providerRequestId: "provider-request:1",
        requestHash: "a".repeat(64), validation: { schemaValid: true }, usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }, output: receipt(request).output } });
  };
  const result = await runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: admitted, ...gatewayRuntimeInput(request),
    gatewayUrl: "http://127.0.0.1:4318", fetchImpl });
  assert.deepEqual(calls, ["POST"]);
  assert.deepEqual(result.request, request);
  assert.equal(result.request.requestedAt, CREATED_AT);
  assert.equal(result.receipt.requestFingerprint, request.requestFingerprint);
  assert.deepEqual(result.receipt.accounting.usage, { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
  assert.deepEqual(result.receipt.accounting.charge, { status: "unknown", reason: "provider_charge_not_reported" });
  assert.equal(result.receipt.accounting.providerRequestId, result.receipt.providerRequestId);
  assert.equal(result.status, "receipt_ready");
  assert.equal(result.skuPackage, undefined);
  for (const change of [
    value => { value.requestedAt = "2026-08-22T02:02:00.000Z"; },
    value => { value.executionPolicy.automaticRetry = true; },
    value => { value.sourceIdentity.storeRef.mappingVersion = "mapping-changed"; },
    value => { value.unexpected = { productionApproved: true }; }
  ]) {
    const changed = structuredClone(request); change(changed);
    assert.equal(validateC1AiDraftRequest(changed).valid, false);
    await assert.rejects(runC1SavedDraftRequestThroughGateway({ request: changed, authorizedExecution: admitted, ...gatewayRuntimeInput(request),
      gatewayUrl: "http://127.0.0.1:4318", fetchImpl }), /AUTHORIZED_EXECUTION_REQUIRED/);
  }
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: admitted, ...gatewayRuntimeInput(request),
    gatewayUrl: "http://127.0.0.1:4318", fetchImpl, totalTimeoutMs: 60_001 }), error => error.code === "C1_AI_GATEWAY_OPTIONS_INVALID");
  assert.deepEqual(calls, ["POST"]);
});

test("创建、等待与状态读取共用总deadline，耗尽后不再请求且不重复创建", async () => {
  const request = buildRequest();
  let elapsed = 0;
  const calls = [], waits = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.method || "GET");
    elapsed += options.method === "POST" ? 8_000 : 1_000;
    return Response.json({ ...gatewayBinding(request), jobId: "job-deadline:1", status: "queued" });
  };
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: authorizedExecution(request), ...gatewayRuntimeInput(request),
    gatewayUrl: "http://127.0.0.1:4318", fetchImpl, totalTimeoutMs: 10_000, statusIntervalMs: 700,
    clock: () => elapsed, wait: async ms => { waits.push(ms); elapsed += ms; }
  }), error => error.code === "C1_AI_GATEWAY_DEADLINE_EXCEEDED" && error.jobId === "job-deadline:1");
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.deepEqual(waits, [700, 300]);
  assert.equal(elapsed, 10_000);
});

test("网关忽略信号或JSON读取不结束时仍在整轮时限终止并中止请求", async () => {
  const request = buildRequest();
  for (const stalledBody of [false, true]) {
    let calls = 0, signal;
    await assert.rejects(runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: authorizedExecution(request), ...gatewayRuntimeInput(request),
      gatewayUrl: "http://127.0.0.1:4318", totalTimeoutMs: 20,
      fetchImpl: async (_url, options) => {
        calls += 1; signal = options.signal;
        return stalledBody ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
      }
    }), error => error.code === "C1_AI_GATEWAY_DEADLINE_EXCEEDED" && error.externalRequestState === "unknown_outcome" && error.cause === undefined);
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  }
});

test("C1耗用只保留实际提供的整数项，费用缺失保持unknown且旧无账务回执不成为新正式凭据", () => {
  const request = buildRequest(), result = receipt(request);
  assert.deepEqual(result.accounting.usage, "unknown");
  assert.equal(Object.hasOwn(result.accounting.charge, "amount"), false);
  const missing = structuredClone(result); delete missing.accounting;
  assert.equal(validateC1AiDraftReceipt({ request, receipt: missing }).valid, false);
  for (const usage of [{ prompt_tokens: -1 }, { total_tokens: 1.5 }, { cost: 0 }, {}, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => createC1AiAccounting({ usage }), /ACCOUNTING_INVALID/);
  }
  const partial = createC1AiAccounting({ usage: { prompt_tokens: 25 } });
  assert.deepEqual(partial.usage, { prompt_tokens: 25 });
  for (const change of [
    value => { value.charge = { status: "verified", amount: 0, currency: "CNY" }; },
    value => { value.unexpectedControl = true; },
    value => { value.providerRequestId = "Bearer private-value"; }
  ]) {
    const accounting = structuredClone(result.accounting); change(accounting);
    assert.equal(validateC1AiAccounting(accounting).valid, false);
  }
  const wrong = structuredClone(result); wrong.accounting.gatewayJobId = "gateway-job:other";
  assert.equal(validateC1AiDraftReceipt({ request, receipt: wrong }).valid, false);
});

test("已返回token耗用但本地拒绝输出时保留对账证据，不宣称成功或零收费", async () => {
  const request = buildRequest(), admitted = authorizedExecution(request);
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: admitted, ...gatewayRuntimeInput(request),
    gatewayUrl: "http://127.0.0.1:4318", fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body), output = receipt(request).output;
      output.title.assertions[0].value = "unsupported claim";
      return Response.json({ ...payload, jobId: "job-cost:1", status: "completed", attempt: 1,
        startedAt: "2026-08-22T02:01:00.000Z", completedAt: "2026-08-22T02:01:01.000Z",
        receipt: { receiptVersion: "inference-receipt-v1", providerRequestId: "provider-cost:1",
          requestHash: "a".repeat(64), validation: { schemaValid: true }, usage: { prompt_tokens: 200, completion_tokens: 60 }, output } });
    }
  }), error => {
    assert.equal(error.code, "C1_AI_GATEWAY_RECEIPT_REJECTED");
    assert.equal(error.externalRequestState, "succeeded");
    assert.equal(error.accounting.gatewayJobId, "job-cost:1");
    assert.equal(error.accounting.providerRequestId, "provider-cost:1");
    assert.deepEqual(error.accounting.usage, { prompt_tokens: 200, completion_tokens: 60 });
    assert.equal(error.accounting.charge.status, "unknown");
    return true;
  });
});
