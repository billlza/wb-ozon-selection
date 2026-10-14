import test from "node:test";
import assert from "node:assert/strict";
import { createFinalPricingRevalidationFixture as fixture } from "./fixtures/final-pricing-revalidation-fixture.mjs";
import { evaluateFinalMarketPricing } from "../lib/market-sample-policy.mjs";
import { prepareFinalPricingRevision } from "../lib/final-pricing-revalidation.mjs";

test("same price reuses current B only after current evidence and cost validation", () => {
  const input = fixture(), before = structuredClone(input);
  const result = prepareFinalPricingRevision(input);
  assert.equal(result.status, "price_unchanged");
  assert.deepEqual(result.candidate, input.candidate);
  assert.deepEqual(input, before);
  input.evidencePacks[0].expiresAt = input.observedAt;
  assert.throws(() => prepareFinalPricingRevision(input), /EVIDENCE_GAP/);
});

test("changed final price appends B, archives old C2 and creates only C1 inputs", () => {
  const input = fixture(); input.assessmentInput.selectedPriceRub = 2400;
  input.assessment = evaluateFinalMarketPricing(input.assessmentInput);
  const before = structuredClone(input.candidate);
  const result = prepareFinalPricingRevision(input), next = result.candidate.lifecycleV11;
  assert.equal(result.status, "price_revalidated");
  assert.equal(next.skuPackage.profitModels.length, before.lifecycleV11.skuPackage.profitModels.length + 1);
  assert.deepEqual(next.skuPackage.profitModels.slice(0, -1), before.lifecycleV11.skuPackage.profitModels);
  assert.equal(next.skuPackage.profitModels.at(-1).recommendedSalePriceRub, 2400);
  assert.equal(next.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(next.skuPackage.c2FinalAssets, null);
  assert.deepEqual(next.finalPricingRevisionHistory[0].previousSkuPackage, before.lifecycleV11.skuPackage);
  assert.deepEqual(input.candidate, before);
  assert.equal(result.taskDispatches, 0);
});

test("pending or forged assessment and existing authorization cannot reprice", () => {
  const input = fixture();
  input.assessmentInput.salesSnapshots = input.assessmentInput.salesSnapshots.slice(0, 1);
  input.assessmentInput.reviews = input.assessmentInput.reviews.slice(0, 1);
  input.assessment = evaluateFinalMarketPricing(input.assessmentInput);
  assert.throws(() => prepareFinalPricingRevision(input), /ASSESSMENT_PENDING/);
  input.assessment = { ...input.assessment, status: "ready" };
  assert.throws(() => prepareFinalPricingRevision(input), /ASSESSMENT_CONFLICT/);
  const blocked = fixture(); blocked.candidate.lifecycleV11.skuPackage.productionAuthorization = {};
  assert.throws(() => prepareFinalPricingRevision(blocked), /NOT_AVAILABLE/);
});

test("same price with changed costs recalculates and unprofitable price cannot rebuild C1", () => {
  const input = fixture(); input.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 1000;
  const result = prepareFinalPricingRevision(input);
  assert.equal(result.status, "profit_rejected");
  assert.equal(result.candidate.lifecycleV11.skuPackage.c1ProductPlan, null);
  assert.equal(result.candidate.lifecycleV11.skuPackage.businessPhase, "B");
  assert.equal(result.candidate.lifecycleV11.skuPackage.profitModels.at(-1).result, "rejected");
});


test("a later C2 review retains the original supply revision through explicit history", () => {
  const input = fixture();
  input.assessmentInput.selectedPriceRub = 2400; input.assessment = evaluateFinalMarketPricing(input.assessmentInput);
  const first = prepareFinalPricingRevision(input);
  const candidate = structuredClone(first.candidate);
  // Only stage availability is advanced here; no external draft, asset or authorization is simulated.
  candidate.lifecycleV11.skuPackage.businessPhase = "C2";
  candidate.dataRevision += 1;
  const secondInput = structuredClone(input.assessmentInput);
  secondInput.assessmentId = "final-pricing:synthetic-2";
  secondInput.target.sourceRevision = candidate.dataRevision;
  secondInput.selectedPriceRub = 2500;
  const observedAt = "2026-08-18T06:00:01.000Z";
  secondInput.assessedAt = observedAt;
  const second = prepareFinalPricingRevision({ ...input, candidate, observedAt, assessmentInput: secondInput, assessment: evaluateFinalMarketPricing(secondInput) });
  assert.equal(second.status, "price_revalidated");
  assert.equal(second.candidate.lifecycleV11.finalPricingRevisionHistory.length, 2);
  assert.deepEqual(second.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot, input.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot);
  assert.equal(second.candidate.lifecycleV11.opportunityPackage.dataRevision, input.candidate.lifecycleV11.opportunityPackage.dataRevision + 2);
  const broken = structuredClone(candidate); broken.lifecycleV11.finalPricingRevisionHistory = [];
  assert.throws(() => prepareFinalPricingRevision({ ...input, candidate: broken, observedAt, assessmentInput: secondInput, assessment: evaluateFinalMarketPricing(secondInput) }), /SUPPLY_SOURCE_CONFLICT/);
});

function followUp(input, result, sequence, selectedPriceRub) {
  const candidate = structuredClone(result.candidate);
  candidate.dataRevision += 1;
  const observedAt = `2026-08-18T06:00:0${sequence}.000Z`;
  const assessmentInput = { ...structuredClone(input.assessmentInput),
    assessmentId: `final-pricing:recovery-${sequence}`, assessedAt: observedAt, selectedPriceRub,
    target: { ...input.assessmentInput.target, sourceRevision: candidate.dataRevision } };
  return { ...input, candidate, observedAt, assessmentInput, assessment: evaluateFinalMarketPricing(assessmentInput) };
}

test("rejected final pricing may retry twice through original supply history and rebuild C1 only after passing", () => {
  const input = fixture();
  input.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 1000;
  const first = prepareFinalPricingRevision(input);
  const secondInput = followUp(input, first, 1, input.assessment.selectedPriceRub);
  const second = prepareFinalPricingRevision(secondInput);
  assert.equal(second.status, "profit_rejected");
  assert.notEqual(second.profitModelVersion, first.profitModelVersion);
  assert.equal(second.candidate.lifecycleV11.skuPackage.c1ProductPlan, null);
  const thirdInput = followUp(secondInput, second, 2, 250000);
  const before = structuredClone(thirdInput);
  const third = prepareFinalPricingRevision(thirdInput);
  assert.equal(third.status, "price_revalidated");
  assert.equal(third.candidate.lifecycleV11.finalPricingRevisionHistory.length, 3);
  assert.equal(third.candidate.lifecycleV11.skuPackage.profitModels.length, input.candidate.lifecycleV11.skuPackage.profitModels.length + 3);
  assert.equal(third.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(third.candidate.lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.deepEqual(third.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot, input.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot);
  assert.deepEqual(third.candidate.lifecycleV11.skuPackage.profitModels.slice(0, -1), second.candidate.lifecycleV11.skuPackage.profitModels);
  assert.deepEqual(thirdInput, before);
  assert.equal(third.taskDispatches, 0);
  const missing = structuredClone(thirdInput);
  missing.candidate.lifecycleV11.finalPricingRevisionHistory.shift();
  assert.throws(() => prepareFinalPricingRevision(missing), /SUPPLY_SOURCE_CONFLICT/);
});

test("ordinary B and unbound rejection history cannot open final pricing recovery", () => {
  const input = fixture();
  input.candidate.lifecycleV11.skuPackage.businessPhase = "B";
  assert.throws(() => prepareFinalPricingRevision(input), /NOT_AVAILABLE/);
  input.candidate.lifecycleV11.finalPricingReviewStatus = "profit_rejected";
  input.candidate.lifecycleV11.finalPricingRevisionHistory = [];
  assert.throws(() => prepareFinalPricingRevision(input), /NOT_AVAILABLE/);
  const valid = fixture(); valid.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 1000;
  const retry = followUp(valid, prepareFinalPricingRevision(valid), 1, 250000);
  retry.candidate.lifecycleV11.finalPricingRevisionHistory[0].resultOpportunityRevision += 1;
  assert.throws(() => prepareFinalPricingRevision(retry), /NOT_AVAILABLE/);
});

test("owner supply SKU tampering fails as B input gap on reuse and rejection recovery", () => {
  const unchanged = fixture();
  unchanged.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot.ownerSupplyConfirmation.supplierSkuId = "other-sku";
  assert.throws(() => prepareFinalPricingRevision(unchanged), /B_INPUT_GAP/);
  const input = fixture(); input.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 1000;
  const retry = followUp(input, prepareFinalPricingRevision(input), 1, 250000);
  retry.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot.ownerSupplyConfirmation.supplierSkuId = "other-sku";
  assert.throws(() => prepareFinalPricingRevision(retry), /B_INPUT_GAP/);
});

/**
 * 上架前这道闸门只认 `exact`。2026-09-15 撤掉「合规」「媒体槽位」那几道没人批准过的门时，
 * 这一道一并复核过：没有松。`official_reference`（主人保存的官方费表版本命中的费率）能形成正式 B，
 * 但过不了最终定价复核——这就是那条分界线，钉在这里。
 */
test("final pricing still refuses an official_reference commission at the listing gate", () => {
  const input = fixture();
  const commission = input.evidencePacks.find(pack => pack.kind === "commission");
  commission.evidenceData = {
    ...commission.evidenceData,
    commissionEvidenceMode: "official_reference",
    officialCommissionBinding: { schemaVersion: "ozon-official-commission-binding-v1",
      candidateId: input.candidate.id, candidateRevision: input.candidate.dataRevision, priceRub: 1831 },
    estimateAuthorized: false,
    exactCommissionRequiredAtC: true
  };
  assert.throws(() => prepareFinalPricingRevision(input), /FINAL_PRICING_EXACT_COMMISSION_REQUIRED/);

  // 同一份输入换回 exact 就通得过，证明红的确实是佣金来源这一条，不是夹具本身坏了。
  const exact = fixture();
  assert.equal(prepareFinalPricingRevision(exact).status, "price_unchanged");
});
