import test from "node:test";
import assert from "node:assert/strict";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createFinalPricingRevalidationFixture } from "./fixtures/final-pricing-revalidation-fixture.mjs";
import { authorizedExecution, settledExecution } from "./fixtures/c1-ai-draft-fixture.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";
import { mergeC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { prepareFinalPricingRevision } from "../lib/final-pricing-revalidation.mjs";
import { evaluateFinalMarketPricing } from "../lib/market-sample-policy.mjs";
import { reuseC1PricingResult, assertC1PricingResultReuse } from "../lib/c1-pricing-result-reuse.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { createC2SoftwareContainer } from "../lib/c2-software-orchestrator.mjs";
import { normalizeC1CanonicalHandoffContract } from "../lib/c2-asset-lifecycle.mjs";

function fixture({ keywordExpiresAt = "2026-08-19T00:00:00.000Z" } = {}) {
  const source = createFormalC1C2Fixture({ salesSnapshotVersion: "sales-snapshot-v1.1" });
  // Explicit synthetic validity is part of the original request before its synthetic completion.
  const request = structuredClone(source.request);
  if (keywordExpiresAt !== null) request.keywordEvidence.expiresAt = keywordExpiresAt;
  delete request.requestId; delete request.requestFingerprint;
  request.requestFingerprint = fingerprintCanonicalRecord(request);
  request.requestId = `c1-ai-request:${request.identity.c1PlanId}:${request.requestFingerprint.slice(0,16)}`;
  const receipt = { ...structuredClone(source.receipt), requestId: request.requestId, requestFingerprint: request.requestFingerprint };
  const admitted = authorizedExecution(request, 27, { softwareJobId: receipt.softwareJobId, authorizationId: "authorization:c1-ai-draft:REUSE-FIXTURE" });
  const settled = settledExecution(request, receipt, admitted);
  const previousSkuPackage = mergeC1AiDraftReceipt({ skuPackage: source.checked.skuPackage, request, receipt, settledExecution: settled, mergedAt: source.at }).skuPackage;
  const input = structuredClone(createFinalPricingRevalidationFixture());
  input.assessmentInput.selectedPriceRub = 2400;
  for (const snapshot of input.assessmentInput.salesSnapshots) snapshot.categoryPath = previousSkuPackage.c1ProductPlan.inputSnapshots.salesSnapshot.categoryPath;
  input.assessment = evaluateFinalMarketPricing(input.assessmentInput);
  const pricingCandidate = prepareFinalPricingRevision(input).candidate;
  const revisedSkuPackage = pricingCandidate.lifecycleV11.skuPackage;
  return structuredClone({ previousSkuPackage, revisedSkuPackage, previousRequest: request, previousReceipt: receipt, previousSettledExecution: settled, observedAt: input.observedAt, pricingCandidate, pricingInput: input });
}

test("local pricing reuse preserves original completion and admits C2 without new calls", () => {
  const input = fixture(), before = structuredClone(input);
  const result = reuseC1PricingResult(input), plan = result.skuPackage.c1ProductPlan;
  assert.equal(plan.status, "seo_draft_ready");
  assert.equal(result.providerCalls, 0);
  assert.equal(result.skuPackage.c2FinalAssets, null);
  assert.deepEqual(plan.draftOnlySeo.providerJobRef, input.previousSkuPackage.c1ProductPlan.draftOnlySeo.providerJobRef);
  assert.deepEqual(plan.inputSnapshots.skuRightsReview, input.previousSkuPackage.c1ProductPlan.inputSnapshots.skuRightsReview);
  assert.equal(plan.draftOnlySeo.pricingReuseRecord.schemaVersion, "c1-pricing-result-reuse-v1");
  const handoffReuse = normalizeC1CanonicalHandoffContract(result.skuPackage).draftOnlySeo.pricingReuseRecord;
  assert.equal(handoffReuse.schemaVersion, "c1-pricing-result-reuse-reference-v1");
  assert.equal(handoffReuse.recordFingerprint, fingerprintCanonicalRecord(plan.draftOnlySeo.pricingReuseRecord));
  assert.deepEqual(input, before);
});

test("missing or expired keyword evidence and changed facts fail explicitly", () => {
  assert.throws(() => reuseC1PricingResult(fixture({ keywordExpiresAt: null })), /KEYWORDS_VALIDITY_MISSING/);
  const missing = fixture(); delete missing.previousRequest;
  assert.throws(() => reuseC1PricingResult(missing), /SOURCE_MISSING/);
  const expired = fixture(); expired.observedAt = "2026-08-20T00:00:00.000Z";
  assert.throws(() => reuseC1PricingResult(expired), /KEYWORDS_EXPIRED/);
  const market = fixture(); market.revisedSkuPackage.c1ProductPlan.inputSnapshots.salesSnapshot.categoryPath = "different category";
  assert.throws(() => reuseC1PricingResult(market), /MARKET_FACT_CHANGED/);
  const schema = fixture(); schema.revisedSkuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.categoryName = "different category";
  assert.throws(() => reuseC1PricingResult(schema), /SCHEMA_CHANGED/);
});

test("saved reuse cannot change output, target binding or original provider identity", () => {
  const input = fixture(); const result = reuseC1PricingResult(input);
  for (const mutate of [
    plan => { plan.seoTitleDraft.text = "unverified claim"; },
    plan => { plan.draftOnlySeo.pricingReuseRecord.targetProfitModelVersion = "other-profit"; },
    plan => { plan.draftOnlySeo.providerJobRef.sourceRevision += 1; }
  ]) {
    const plan = structuredClone(result.skuPackage.c1ProductPlan); mutate(plan);
    assert.throws(() => assertC1PricingResultReuse({ plan, resultSkuRevision: result.skuPackage.dataRevision }), /C1_PRICING_REUSE_/);
  }
});


test("published C1 and C2 schemas preserve a closed historical reuse record", async () => {
  const input = fixture(), result = reuseC1PricingResult(input);
  const validator = await loadPublishedSchemaValidator();
  const validateC1 = validator.getSchema("c1-product-plan-v1.1");
  assert.equal(validateC1(result.skuPackage.c1ProductPlan), true, JSON.stringify(validateC1.errors));
  const bad = structuredClone(result.skuPackage.c1ProductPlan);
  bad.draftOnlySeo.pricingReuseRecord.unknownField = true;
  assert.equal(validateC1(bad), false);
  const c2 = createC2SoftwareContainer({ skuPackage: result.skuPackage, expectedDataRevision: result.skuPackage.dataRevision, assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: input.observedAt });
  const validateC2 = validator.getSchema("c2-asset-lifecycle-v1.1");
  assert.equal(validateC2(c2.c2AssetLifecycle), true, JSON.stringify(validateC2.errors));
});


test("a second price revision reuses the original receipt without nesting historical records", () => {
  const input = fixture(), first = reuseC1PricingResult(input);
  const c2 = createC2SoftwareContainer({ skuPackage: first.skuPackage, expectedDataRevision: first.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: input.observedAt });
  const secondInput = structuredClone(input.pricingInput);
  secondInput.candidate = structuredClone(input.pricingCandidate);
  secondInput.candidate.lifecycleV11.skuPackage = structuredClone(c2.skuPackage);
  secondInput.candidate.dataRevision += 1;
  secondInput.observedAt = "2026-08-18T06:00:01.000Z";
  secondInput.assessmentInput.assessmentId = "final-pricing:reuse-second";
  secondInput.assessmentInput.assessedAt = secondInput.observedAt;
  secondInput.assessmentInput.target.sourceRevision = secondInput.candidate.dataRevision;
  secondInput.assessmentInput.selectedPriceRub = 2500;
  secondInput.assessment = evaluateFinalMarketPricing(secondInput.assessmentInput);
  const revised = prepareFinalPricingRevision(secondInput).candidate.lifecycleV11.skuPackage;
  const second = reuseC1PricingResult({ previousSkuPackage: c2.skuPackage, revisedSkuPackage: revised, observedAt: secondInput.observedAt });
  assert.equal(second.reuseRecord.sourcePlan.draftOnlySeo.pricingReuseRecord, undefined);
  assert.deepEqual(second.reuseRecord.request, input.previousRequest);
  assert.deepEqual(second.reuseRecord.receipt, input.previousReceipt);
  assert.equal(second.providerCalls, 0);
  assert.equal(normalizeC1CanonicalHandoffContract(second.skuPackage).draftOnlySeo.providerJobRef.sourceRevision, input.previousRequest.sourceSkuRevision);
});

test("expired source rights become an explicit reuse gap without changing the original review", () => {
  const input = fixture({ keywordExpiresAt: "2100-01-01T00:00:00.000Z" });
  input.observedAt = "2099-01-01T00:00:00.000Z";
  const before = structuredClone(input);
  assert.throws(() => reuseC1PricingResult(input), error => error.code === "C1_PRICING_REUSE_RIGHTS_EXPIRED");
  assert.deepEqual(input, before);
  const unexpected = fixture();
  const sentinel = new Error("synthetic internal source failure");
  Object.defineProperty(unexpected.previousSkuPackage.c1ProductPlan, "draftOnlySeo", { get() { throw sentinel; } });
  assert.throws(() => reuseC1PricingResult(unexpected), error => error === sentinel);
});
