import { buildLifecycleBExplicitOtherCosts, resolveLifecycleBProfitRule } from "./lifecycle-b-evidence-runtime.mjs";
import { BExactCommissionRecalculationError, prepareSavedConditionalBExactInputs } from "./real-a-b-c1-flow.mjs";

/**
 * 这次复算会用哪一种费用证据，说清楚，别让主人以为拿到了平台实收。
 *
 * 复算接受两种比估算更好的证据（lib/real-a-b-c1-flow.mjs 里那道闸门），两种算出来的都是正式B，
 * 但它们不是一回事：一个是这个店自己被扣过的钱，一个是公开费率表上写着的数。哪一种都要摆出原话。
 */
export const B_BETTER_COMMISSION_EVIDENCE_LABELS = Object.freeze({
  exact: "店里同类目在售商品的实收费率",
  official_reference: "Ozon 官方费率表上这条类目的公开费率"
});

function percent(rate) {
  return Number.isFinite(rate) ? `${Number((rate * 100).toFixed(2))}%` : "费率未知";
}

/** Read-only availability for the saved B result; never computes profit or advances a phase. */
export function buildBExactCommissionRuntimeView({ candidate, evidencePacks, currentCommissionCatalogs = [], rules, observedAt }) {
  if (candidate.lifecycleV11?.status !== "b_conditional_awaiting_exact_commission") return null;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) throw new TypeError("B_RECALCULATION_VIEW_TIME_INVALID");
  const base = {
    schemaVersion: "b-exact-commission-runtime-view-v1", candidateId: candidate.id,
    expectedRevision: candidate.dataRevision, skuPackageId: candidate.lifecycleV11.skuPackage?.skuPackageId ?? null,
    failureId: candidate.executionRuntime?.technicalFailure?.failureId ?? null,
    canRecalculate: false, automaticRetryAllowed: false, externalRequests: 0,
    commissionEvidenceMode: null, commissionEvidenceLabel: null, commissionRate: null
  };
  try {
    const otherCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules), { asOf: observedAt });
    const prepared = prepareSavedConditionalBExactInputs({ candidate, evidencePacks, currentCommissionCatalogs, otherCosts, processedAt: observedAt });
    const fee = prepared.evidence.platformFeeEvidence;
    const label = B_BETTER_COMMISSION_EVIDENCE_LABELS[fee.commissionEvidenceMode] ?? "来路不明的费用证据";
    return { ...base, status: "ready", canRecalculate: true, evidencePackIds: prepared.evidence.sourcePackIds,
      commissionEvidenceMode: fee.commissionEvidenceMode, commissionEvidenceLabel: label,
      commissionRate: fee.commissionRate, blockReason: null,
      message: `已经有比估算更好的费用证据：${label} ${percent(fee.commissionRate)}。` +
        "用它把这一次利润重算一次，沿用已确认的供货方案，不会访问平台或产生费用。" +
        (fee.commissionEvidenceMode === "official_reference"
          ? "这一次用的是公开费率表上的数，不是这个店被扣过的钱；上架之前仍然要读到店里的实收费率。"
          : "")
    };
  } catch (error) {
    if (error.code === "B_EVIDENCE_COST_POLICY_INCOMPLETE" || error.code?.startsWith("B_COST_POLICY_")) return { ...base, status: "evidence_required", evidencePackIds: [],
      blockReason: error.code, message: "当前商品成本或店铺规则不完整，不能复算正式利润。" };
    if (!(error instanceof BExactCommissionRecalculationError)) throw error;
    const evidenceMissing = ["B_EXACT_RECALCULATION_EXACT_EVIDENCE_REQUIRED", "B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE"].includes(error.code);
    return { ...base, status: evidenceMissing ? "evidence_required" : "source_conflict", evidencePackIds: [],
      blockReason: error.code, message: evidenceMissing
        ? "还没有比估算更好的费用证据可用：店里的实收费率和官方费率表这条类目的费率，现在一样也读不到，或者已经失效。" +
          "供货确认和条件测算已保留，不会自动重试。"
        : "已保存的供货、利润或停止记录需要核对，当前不能继续复算。" };
  }
}
