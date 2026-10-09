import { isDeepStrictEqual } from "node:util";
import { C1_SCHEMA_CONTENT_FIELDS, isLifecycleEvidenceTraceValid, validateLifecycleBInputBundle, validateLifecycleEvidenceData } from "./lifecycle-b-input-bundle.mjs";
import { buildExpectedEvidenceScope, evidenceScopeMatches } from "./lifecycle-evidence-scope.mjs";
import { isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { inspectLifecycleEvidenceValidity } from "./lifecycle-evidence-validity.mjs";

const SOURCES = [
  { kind: "commission", label: "佣金资料", field: "platformFeeEvidence" },
  { kind: "logistics_tariff", label: "运费资料", field: "logisticsEvidence" },
  { kind: "exchange_rate", label: "汇率资料", field: "exchangeRateEvidence" },
  { kind: "schema", label: "类目与属性资料", field: "platformSchemaEvidence" }
];
const MESSAGES = {
  current: "来源期限检查通过；仍须核对内容、适用范围及最终生产条件。",
  refresh_due: "软件自设复查时间不构成失效依据；现有记录未显示来源失效或规则变更。",
  expired: "资料超过来源明确期限或未能识别期限来源，由软件核对后处理。",
  missing: "缺少冻结引用或其对应资料，需要补齐后核验。",
  invalid: "资料内容、来源、状态或时间无效，需要修复后核验。",
  scope_mismatch: "资料的商品、店铺或适用范围与当前方案不一致。"
};

function snapshotMatches(kind, pack, frozen) {
  if (kind === "commission") return ["commissionRate", "commissionEvidenceMode", "officialCommissionBinding"]
    .every(field => isDeepStrictEqual(pack.evidenceData[field], frozen[field])) &&
    isDeepStrictEqual(pack.commissionCatalogRef, frozen.commissionCatalogRef);
  if (kind === "logistics_tariff") return isDeepStrictEqual(pack.evidenceData, frozen.tariff);
  if (kind === "exchange_rate") return pack.evidenceData.rubPerCny === frozen.rubPerCny;
  return [...C1_SCHEMA_CONTENT_FIELDS, "schemaRevision", "requiredFields"]
    .every(field => isDeepStrictEqual(pack.evidenceData[field], frozen[field])) && pack.checkedAt === frozen.collectedAt;
}

function schemaMatchesCurrentPlan(c1, snapshot, candidate) {
  return snapshot && snapshot.evidenceId === c1.inputRefs.platformSchemaEvidenceId &&
    c1.schemaSnapshotRef === snapshot.evidenceId && c1.frozenInputRefs?.schemaSnapshotRef === snapshot.evidenceId &&
    snapshot.platform === candidate.targetPlatform && snapshot.store === candidate.targetStore && sameStoreRef(snapshot.storeRef, candidate.storeRef);
}

function scopeMatches(kind, pack, context) {
  if (!context) return false;
  try { return evidenceScopeMatches(kind, pack.scope, buildExpectedEvidenceScope(kind, context)); }
  catch (error) {
    if (error.code !== "EVIDENCE_SCOPE_INVALID") throw error;
    return false;
  }
}

function summarize(entries) {
  const status = entries.some(entry => !["current", "refresh_due", "expired"].includes(entry.status)) ? "blocked"
    : entries.some(entry => entry.status === "expired") ? "requires_refresh" : "current";
  return { status, entries, message: status === "current" ? "未发现来源期限阻断；软件自设复查时间不会阻止上架。这项检查不代表生产授权。"
    : status === "requires_refresh" ? "部分引用资料已过期，请完成核验后再确认生产。" : "引用资料存在缺失或不一致，请先处理下列问题。" };
}

/** Read-only explanation of frozen evidence; never selects replacements or grants authorization. */
export function inspectProductionEvidenceReadiness({ candidate, evidencePacks, observedAt }) {
  if (!candidate || !Array.isArray(evidencePacks) || !isRuntimeConfigurationTimestamp(observedAt)) {
    throw Object.assign(new Error("生产证据诊断输入或服务端时间无效"), { code: "PRODUCTION_EVIDENCE_INPUT_INVALID" });
  }
  const bundle = candidate.lifecycleV11?.bSystemEvidenceBundle;
  const c1 = candidate.lifecycleV11?.skuPackage?.c1ProductPlan;
  const bundleValid = bundle ? validateLifecycleBInputBundle(bundle).valid : false;
  const entries = SOURCES.map(({ kind, label, field }) => {
    const evidenceId = (kind === "schema" ? c1?.inputRefs?.platformSchemaEvidenceId : bundle?.[field]?.evidenceId) ?? null;
    const matches = evidenceId ? evidencePacks.filter(pack => pack.id === evidenceId) : [];
    const pack = matches.length === 1 ? matches[0] : null;
    const finish = status => ({ kind, label, evidenceId, status,
      checkedAt: pack && isRuntimeConfigurationTimestamp(pack.checkedAt) ? pack.checkedAt : null,
      expiresAt: pack && isRuntimeConfigurationTimestamp(pack.expiresAt) ? pack.expiresAt : null, message: MESSAGES[status] });
    if (!bundle || !evidenceId || !matches.length) return finish("missing");
    if (!bundleValid || matches.length !== 1) return finish("invalid");
    const snapshot = kind === "schema" ? c1?.inputSnapshots?.platformSchemaRules : bundle[field];
    if (kind === "schema" && !schemaMatchesCurrentPlan(c1, snapshot, candidate)) return finish("invalid");
    const context = kind === "schema" ? candidate.lifecycleEvidenceContextV11 : bundle.context;
    if (kind === "schema" && (!context || context.platform !== candidate.targetPlatform || context.store !== candidate.targetStore ||
        !sameStoreRef(context.storeRef, candidate.storeRef))) return finish("scope_mismatch");
    if (bundle.sourceCandidateId !== candidate.id || bundle.context.platform !== candidate.targetPlatform ||
        bundle.context.store !== candidate.targetStore || !sameStoreRef(bundle.context.storeRef, candidate.storeRef) ||
        !scopeMatches(kind, pack, context)) return finish("scope_mismatch");
    if (pack.kind !== kind || pack.status !== "active" || !isLifecycleEvidenceTraceValid(pack) ||
        Date.parse(pack.checkedAt) > Date.parse(observedAt) || !validateLifecycleEvidenceData(kind, pack.evidenceData).valid ||
        !snapshotMatches(kind, pack, snapshot)) return finish("invalid");
    const validity = inspectLifecycleEvidenceValidity(pack, { asOf: observedAt });
    return finish(validity.status === "invalidated" ? "invalid" : validity.status);
  });
  return summarize(entries);
}
