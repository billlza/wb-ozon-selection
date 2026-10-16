import { createHash } from "node:crypto";
import { attachTerraAuxiliaryDraft, assertValidSalesSnapshot } from "./sales-snapshot.mjs";
import { normalizeServiceOrigin } from "./runtime-configuration.mjs";

export const A_STAGE_TERRA_GATEWAY_VERSION = "a-stage-terra-gateway-v1";

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "comparabilitySignals", "attributeHints"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 1200 },
    comparabilitySignals: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 300 }
    },
    attributeHints: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "evidenceRef"],
        properties: {
          field: { type: "string", minLength: 1, maxLength: 120 },
          value: { type: "string", minLength: 1, maxLength: 500 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 300 }
        }
      }
    }
  }
});

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`A_TERRA_INPUT_INVALID: ${label}不能为空`);
  return normalized;
}

function safeGatewayUrl(value, deploymentMode) {
  try {
    return normalizeServiceOrigin(value, {
      deploymentMode,
      label: "aStageAiGatewayUrl",
      privateNetwork: true
    });
  } catch (error) {
    throw new Error(`A_TERRA_GATEWAY_SCOPE_REJECTED: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function publicSnapshotText(snapshot) {
  const attributes = Object.entries(snapshot.attributes || {})
    .slice(0, 80)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 500)}`);
  return [
    `商品标题: ${snapshot.title}`,
    `当前价格: ${snapshot.currentPrice} ${snapshot.currency}`,
    `市场范围: ${snapshot.marketScope}`,
    `卖家类型: ${snapshot.sellerType}`,
    `类目: ${snapshot.categoryPath}`,
    ...attributes
  ].join("\n");
}

export class AStageTerraGatewayError extends Error {
  constructor(code, layer, message, details = {}) {
    super(message);
    this.name = "AStageTerraGatewayError";
    this.code = code;
    this.layer = layer;
    this.jobId = details.jobId || null;
    this.providerFailure = details.providerFailure || null;
  }
}

export function buildAStageTerraRequest({ candidate, snapshot }) {
  if (!candidate || !candidate.id || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("A_TERRA_INPUT_INVALID: 候选身份或修订号无效");
  }
  assertValidSalesSnapshot(snapshot);
  const evidenceText = publicSnapshotText(snapshot);
  return {
    projectId: "three-store-selection",
    candidateId: candidate.id,
    skuPackageId: `a-pending-sku:${candidate.id}`,
    dataRevision: String(candidate.dataRevision),
    businessPhase: "A",
    taskType: "sales_comparability_assist",
    model: "gpt-5.6-terra",
    evidenceRefs: [{
      id: snapshot.evidenceRef,
      kind: "public_sales_snapshot_text",
      contentSha256: sha256(evidenceText),
      authorizedForAi: true
    }],
    input: {
      text: [
        "只整理以下公开商品页面快照。输出是A阶段辅助草稿，不得创造或改写商品事实，也不得替主人作商业决定。",
        evidenceText
      ].join("\n\n"),
      images: []
    },
    outputSchema: structuredClone(OUTPUT_SCHEMA)
  };
}

async function jsonResponse(response, layer, jobId = null) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(body?.error?.code || `HTTP_${response.status}`);
    const message = String(body?.error?.message || "AI网关请求失败");
    throw new AStageTerraGatewayError(code, layer, message, { jobId });
  }
  return body;
}

export async function runAStageTerraAssist({
  candidate,
  snapshot,
  gatewayUrl,
  gatewayDeploymentMode = "local_development",
  fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxStatusReads = 120,
  statusIntervalMs = 500
}) {
  const baseUrl = safeGatewayUrl(gatewayUrl, gatewayDeploymentMode);
  const request = buildAStageTerraRequest({ candidate, snapshot });
  let created;
  try {
    const response = await fetchImpl(`${baseUrl}/v1/inference-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    created = await jsonResponse(response, "gateway_create");
  } catch (error) {
    if (error instanceof AStageTerraGatewayError) throw error;
    throw new AStageTerraGatewayError("GATEWAY_UNREACHABLE", "gateway_create", String(error?.message || error));
  }
  const jobId = text(created.jobId, "jobId");
  let job = created;
  for (let index = 0; index < maxStatusReads && ["queued", "running"].includes(job.status); index += 1) {
    await wait(statusIntervalMs);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/inference-jobs/${encodeURIComponent(jobId)}`);
      job = await jsonResponse(response, "gateway_status", jobId);
    } catch (error) {
      if (error instanceof AStageTerraGatewayError) throw error;
      throw new AStageTerraGatewayError("GATEWAY_STATUS_UNAVAILABLE", "gateway_status", String(error?.message || error), { jobId });
    }
  }
  if (["queued", "running"].includes(job.status)) {
    throw new AStageTerraGatewayError("GATEWAY_STATUS_TIMEOUT", "gateway_status", "Terra任务状态读取超时；未重试供应商请求", { jobId });
  }
  if (job.status !== "completed" || !job.receipt) {
    throw new AStageTerraGatewayError(
      String(job.failure?.code || "INFERENCE_FAILED"),
      String(job.failure?.layer || "inference"),
      String(job.failure?.message || "Terra任务失败并已停止"),
      { jobId, providerFailure: job.failure || null }
    );
  }
  if (job.attempt !== 1 || job.model !== "gpt-5.6-terra" || job.taskType !== "sales_comparability_assist") {
    throw new AStageTerraGatewayError("INFERENCE_RECEIPT_MISMATCH", "receipt", "Terra回执与锁定任务不一致", { jobId });
  }
  if (job.candidateId !== candidate.id || String(job.dataRevision) !== String(candidate.dataRevision)) {
    throw new AStageTerraGatewayError("INFERENCE_SCOPE_MISMATCH", "receipt", "Terra回执候选或修订号不一致", { jobId });
  }
  if (job.receipt.validation?.schemaValid !== true || !job.receipt.output) {
    throw new AStageTerraGatewayError("MODEL_OUTPUT_SCHEMA_MISMATCH", "output_schema", "Terra输出未通过严格Schema校验", { jobId });
  }
  const updatedSnapshot = attachTerraAuxiliaryDraft(snapshot, {
    draftId: `terra:${snapshot.snapshotId}:${job.receipt.requestHash}`,
    provider: "terra",
    modelVersion: job.model,
    generatedAt: job.receipt.completedAt,
    status: "draft",
    authoritative: false,
    mayOverrideObservedFields: false,
    publicTextEvidenceRefs: [snapshot.evidenceRef],
    authorizedImageRefs: [],
    output: job.receipt.output
  });
  return {
    orchestrationVersion: A_STAGE_TERRA_GATEWAY_VERSION,
    jobId,
    receiptId: `${jobId}:${job.receipt.requestHash}`,
    receipt: structuredClone(job.receipt),
    snapshot: updatedSnapshot,
    supplierAttempts: 1,
    codexWakeups: 0,
    platformWrites: 0
  };
}
