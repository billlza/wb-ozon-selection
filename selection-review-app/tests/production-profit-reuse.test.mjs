import assert from "node:assert/strict";
import test from "node:test";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { assertProductionProfitPriceCurrent } from "../lib/final-pricing-review.mjs";
import { buildProductionOwnerPreparationView } from "../lib/production-owner-preparation.mjs";
import { createProductionAuthorization, commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";

function fixture(mode = "official_reference") {
  return productionOwnerDecisionFixture(createMemoryBusinessStateRepository, { commissionMode: mode, includePricingReview: false });
}
function directInput(f) {
  return { candidate: f.candidate, candidateId: f.candidate.id, sourceCandidateRevision: f.candidate.dataRevision,
    currentCandidateRevision: f.candidate.dataRevision, skuPackage: f.candidate.lifecycleV11.skuPackage,
    evidencePacks: f.evidencePacks, currentCommissionCatalogs: f.currentCommissionCatalogs,
    commercialDecision: f.commercialDecision, ownerActor: f.args.actor, authorizedAt: f.formal.at };
}
function inspect(f) { return buildProductionOwnerPreparationView({ ...f, observedAt: f.formal.at }); }

for (const mode of ["exact", "official_reference"]) {
  test(`${mode}: current formal B reuses the unchanged price without a new sample review at view, direct and transactional boundaries`, async () => {
    const f = fixture(mode), before = structuredClone(await f.repository.readSnapshot());
    const sku = f.candidate.lifecycleV11.skuPackage, model = sku.profitModels.at(-1);
    assert.equal(Object.hasOwn(sku, "finalPricingReview"), false);
    assert.equal(inspect(f).ready, true);
    const direct = createProductionAuthorization(directInput(f));
    assert.equal(direct.productionAuthorization.lockedScope.buyerTargetPrice.amount, model.recommendedSalePriceRub);
    assert.equal(direct.productionAuthorization.lockedScope.platformWritePrice.amount, model.recommendedSalePriceCny);
    assert.deepEqual(await f.repository.readSnapshot(), before, "read-only preparation and direct domain construction do not write");
    const outcomes = await Promise.all([commitSingleOwnerProductionAuthorization(f.args), commitSingleOwnerProductionAuthorization(f.args)]);
    assert.deepEqual(outcomes.map(row => row.status).sort(), ["committed", "idempotent_replay"]);
    const after = await f.repository.readSnapshot(), saved = after.candidates[0].lifecycleV11.skuPackage;
    assert.deepEqual(saved.profitModels, sku.profitModels);
    assert.deepEqual(saved.selectedSupplySnapshot, sku.selectedSupplySnapshot);
    assert.deepEqual(after.candidates[0].lifecycleV11.bSystemEvidenceBundle, f.candidate.lifecycleV11.bSystemEvidenceBundle);
    assert.equal(after.runtime.softwareJobs.length, 1);
    assert.equal(saved.productionAuthorization.lockedScope.platformWritePrice.amount, model.recommendedSalePriceCny);
    assert.equal(outcomes[0].result.externalRequests, 0);
    assert.equal(outcomes[0].result.platformWrites, 0);
  });
}

test("official price binding, source identity, frozen costs and exact evidence IDs cannot be substituted at any production boundary", async () => {
  const changes = [
    f => { delete f.candidate.lifecycleV11.bSystemEvidenceBundle; },
    f => { f.candidate.lifecycleV11.bSystemEvidenceBundle.sourceCandidateId = "other-candidate"; },
    f => { f.candidate.lifecycleV11.bSystemEvidenceBundle.sourceCandidateRevision = f.candidate.dataRevision + 1; },
    f => { f.candidate.lifecycleV11.bSystemEvidenceBundle.packagingSnapshot.weightKg += 1; },
    f => { f.candidate.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence.amountRmb += 1; },
    f => { f.candidate.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence.otherCosts.labelRmb += 1; },
    f => { f.evidencePacks.push(structuredClone(f.evidencePacks[1])); },
    f => { f.evidencePacks[1].id = "commission:newer-but-not-frozen"; },
    f => { f.evidencePacks[1].sourceType = "isolated_test"; },
    f => { f.evidencePacks[1].scope.storeRef.platformStoreId = "other-store"; },
    f => { f.evidencePacks[1].expiresAt = f.formal.at; },
    f => { f.evidencePacks[1].checkedAt = "2026-08-30T00:00:00.000Z"; },
    f => { f.evidencePacks[1].status = "superseded"; },
    f => { f.evidencePacks[0].checkedAt = f.formal.at; },
    f => { f.evidencePacks[3].evidenceData.requiredFields = []; },
    f => { const b = f.candidate.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence; b.officialCommissionBinding.priceRub = 801;
      f.evidencePacks[1].evidenceData.officialCommissionBinding.priceRub = 801; },
    f => { const b = f.candidate.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence; b.commissionCatalogRef.priceTier = "gt5000";
      f.evidencePacks[1].commissionCatalogRef.priceTier = "gt5000"; },
    f => { const b = f.candidate.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence; b.commissionCatalogRef.effectiveFrom = "2026-08-30";
      f.evidencePacks[1].commissionCatalogRef.effectiveFrom = "2026-08-30"; }
  ];
  for (const change of changes) {
    const f = fixture(); f.candidate = structuredClone(f.candidate); change(f);
    const original = await f.repository.readSnapshot(); original.candidates = [f.candidate]; original.evidencePacks = f.evidencePacks;
    f.repository = createMemoryBusinessStateRepository(original); f.args.repository = f.repository;
    const before = await f.repository.readSnapshot();
    const view = inspect(f); assert.equal(view.ready, false, change.toString()); assert.equal(view.scope, null);
    assert.throws(() => createProductionAuthorization(directInput(f)), error => /^PRODUCTION_AUTHORIZATION_/.test(error.code), change.toString());
    await assert.rejects(() => commitSingleOwnerProductionAuthorization(f.args));
    assert.deepEqual(await f.repository.readSnapshot(), before, `zero partial write: ${change}`);
  }
});

test("direct create cannot bypass evidence; old B revision may remain valid but invalid timestamps and estimated models fail", () => {
  const f = fixture(), input = directInput(f), before = structuredClone(f.candidate);
  for (const changed of [{ ...input, evidencePacks: undefined }, { ...input, candidate: undefined }]) {
    assert.throws(() => createProductionAuthorization(changed), { code: "PRODUCTION_AUTHORIZATION_PROFIT_SOURCE_REQUIRED" });
  }
  const candidate = structuredClone(f.candidate); candidate.dataRevision += 10;
  assert.equal(assertProductionProfitPriceCurrent({ candidate, skuPackage: candidate.lifecycleV11.skuPackage,
    evidencePacks: f.evidencePacks, observedAt: f.formal.at }).commissionMode, "official_reference");
  assert.throws(() => assertProductionProfitPriceCurrent({ candidate, skuPackage: candidate.lifecycleV11.skuPackage,
    evidencePacks: f.evidencePacks, observedAt: "2026-02-30T00:00:00.000Z" }), { code: "PRODUCTION_AUTHORIZATION_PROFIT_SOURCE_REQUIRED" });
  candidate.lifecycleV11.skuPackage.profitModels.at(-1).commissionMode = "estimated";
  assert.throws(() => assertProductionProfitPriceCurrent({ candidate, skuPackage: candidate.lifecycleV11.skuPackage,
    evidencePacks: f.evidencePacks, observedAt: f.formal.at }), { code: "PRODUCTION_AUTHORIZATION_FORMAL_PROFIT_REQUIRED" });
  assert.deepEqual(f.candidate, before);
});


test("848 RUB official query supports 801 RUB within le1500, but crossing the tier requires new evidence", () => {
  const f = productionOwnerDecisionFixture(createMemoryBusinessStateRepository, { commissionMode: "official_reference", includePricingReview: false,
    formalOptions: { expectedPriceRub: 801, actualPurchaseCost: 2, unitProductPrice: 1, unitDomesticFreight: 1, internationalFreightRmb: 1 } });
  const candidate = structuredClone(f.candidate), evidencePacks = structuredClone(f.evidencePacks);
  const binding = candidate.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence.officialCommissionBinding;
  binding.priceRub = 848; evidencePacks[1].evidenceData.officialCommissionBinding.priceRub = 848;
  const before = structuredClone({ candidate, evidencePacks });
  const model = assertProductionProfitPriceCurrent({ candidate, skuPackage: candidate.lifecycleV11.skuPackage, evidencePacks, observedAt: f.formal.at });
  assert.equal(model.recommendedSalePriceRub, 801);
  assert.deepEqual({ candidate, evidencePacks }, before);
  for (const priceRub of [1500.01, 5001]) {
    binding.priceRub = priceRub; evidencePacks[1].evidenceData.officialCommissionBinding.priceRub = priceRub;
    assert.throws(() => assertProductionProfitPriceCurrent({ candidate, skuPackage: candidate.lifecycleV11.skuPackage, evidencePacks, observedAt: f.formal.at }),
      { code: "PRODUCTION_AUTHORIZATION_OFFICIAL_COMMISSION_BINDING_INVALID" });
  }
});
