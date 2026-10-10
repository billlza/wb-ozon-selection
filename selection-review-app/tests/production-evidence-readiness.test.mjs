import test from "node:test";
import assert from "node:assert/strict";
import { inspectProductionEvidenceReadiness } from "../lib/production-evidence-readiness.mjs";
import { createFinalPricingRevalidationFixture as createBaseFixture } from "./fixtures/final-pricing-revalidation-fixture.mjs";
import { buildProductionOwnerPreparationView } from "../lib/production-owner-preparation.mjs";
import { createC1ProductPlan, verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS } from "./fixtures/c1-sku-rights-review-fixture.mjs";

function createFinalPricingRevalidationFixture() {
  const input = structuredClone(createBaseFixture());
  input.evidencePacks = structuredClone(input.evidencePacks);
  const schema = input.evidencePacks.find(pack => pack.kind === "schema");
  schema.checkedAt = schema.evidenceData.collectedAt;
  return input;
}

const kinds = ["commission", "logistics_tariff", "exchange_rate", "schema"];
const inspect = input => inspectProductionEvidenceReadiness({ candidate: input.candidate,
  evidencePacks: input.evidencePacks, observedAt: input.observedAt });
const entryFor = (result, kind) => result.entries.find(entry => entry.kind === kind);

test("four frozen evidence references are current without requiring the old B revision to equal the current candidate", () => {
  const input = createFinalPricingRevalidationFixture();
  input.candidate.dataRevision += 3;
  const before = structuredClone(input);
  const result = inspect(input);
  assert.equal(result.status, "current", JSON.stringify(result));
  assert.equal(result.entries.length, 4);
  assert.deepEqual(result.entries.map(entry => entry.kind).sort(), [...kinds].sort());
  for (const pack of input.evidencePacks) {
    const entry = entryFor(result, pack.kind);
    assert.equal(entry.status, "current");
    assert.equal(entry.evidenceId, pack.id);
    assert.equal(entry.checkedAt, pack.checkedAt);
    assert.equal(entry.expiresAt, pack.expiresAt);
    assert.ok(entry.label.length > 0);
    assert.ok(entry.message.length > 0);
  }
  assert.ok(result.message.length > 0);
  assert.deepEqual(input, before, "readiness is a read-only diagnostic, including existing authorization state");
});

test("expiration is exclusive: the instant before expiry is current and exact expiry requires refresh", () => {
  const input = createFinalPricingRevalidationFixture();
  const expiration = input.evidencePacks[0].expiresAt;
  input.observedAt = new Date(Date.parse(expiration) - 1).toISOString();
  assert.equal(inspect(input).status, "current");
  input.observedAt = expiration;
  const before = structuredClone(input), result = inspect(input);
  assert.equal(result.status, "requires_refresh");
  assert.equal(result.entries.length, 4);
  assert.ok(result.entries.every(entry => entry.status === "expired"));
  assert.deepEqual(input, before);
});

test("future, invalid and non-active evidence are blocked rather than treated as current", () => {
  for (const change of [
    pack => { pack.checkedAt = "2026-08-18T07:00:00.000Z"; },
    pack => { pack.checkedAt = "not-a-date"; },
    pack => { pack.expiresAt = "not-a-date"; },
    pack => { pack.expiresAt = pack.checkedAt; },
    pack => { pack.status = "superseded"; },
    pack => { pack.sourceRef = ""; },
    pack => { pack.evidenceData.commissionRate = -1; }
  ]) {
    const input = createFinalPricingRevalidationFixture();
    change(input.evidencePacks[0]);
    const before = structuredClone(input), result = inspect(input);
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(entryFor(result, "commission").status, "invalid");
    assert.deepEqual(input, before);
  }
});

test("missing B bundle is explicitly blocked with four missing entries", () => {
  const input = createFinalPricingRevalidationFixture();
  delete input.candidate.lifecycleV11.bSystemEvidenceBundle;
  const before = structuredClone(input), result = inspect(input);
  assert.equal(result.status, "blocked");
  assert.equal(result.entries.length, 4);
  assert.deepEqual(result.entries.map(entry => entry.kind).sort(), [...kinds].sort());
  assert.ok(result.entries.every(entry => entry.status === "missing"));
  assert.deepEqual(input, before);
});

test("duplicate exact IDs and mismatched store scope cannot be selected as usable evidence", () => {
  const duplicate = createFinalPricingRevalidationFixture();
  duplicate.evidencePacks.push(structuredClone(duplicate.evidencePacks[0]));
  const duplicateResult = inspect(duplicate);
  assert.equal(duplicateResult.status, "blocked");
  assert.equal(entryFor(duplicateResult, "commission").status, "invalid");
  for (const kind of ["commission", "schema"]) {
    const input = createFinalPricingRevalidationFixture();
    const pack = input.evidencePacks.find(pack => pack.kind === kind);
    pack.scope.storeRef.platformStoreId = "synthetic-other-store";
    const result = inspect(input);
    assert.equal(result.status, "blocked");
    assert.equal(entryFor(result, kind).status, "scope_mismatch");
  }
});

test("a newer pack never substitutes for an expired or missing exact frozen reference", () => {
  const input = createFinalPricingRevalidationFixture();
  const original = input.evidencePacks[2], replacement = structuredClone(original);
  replacement.id = "exchange-rate:new-unfrozen-pack";
  input.evidencePacks.push(replacement);
  original.expiresAt = input.observedAt;
  const expired = inspect(input);
  assert.equal(expired.status, "requires_refresh");
  assert.equal(entryFor(expired, "exchange_rate").status, "expired");
  assert.equal(entryFor(expired, "exchange_rate").evidenceId, original.id);
  input.evidencePacks = input.evidencePacks.filter(pack => pack.id !== original.id);
  const missing = inspect(input);
  assert.equal(missing.status, "blocked");
  assert.equal(entryFor(missing, "exchange_rate").status, "missing");
  assert.equal(entryFor(missing, "exchange_rate").evidenceId, original.id);
});

test("a schema pack and matching current context cannot jointly move evidence into another store", () => {
  const input = createFinalPricingRevalidationFixture();
  const context = input.candidate.lifecycleEvidenceContextV11;
  const pack = input.evidencePacks.find(pack => pack.kind === "schema");
  context.store = "synthetic-other-store";
  context.storeRef = { ...context.storeRef, stableStoreId: context.store, platformStoreId: "synthetic-other-platform-store" };
  pack.scope.store = context.store;
  pack.scope.storeRef = structuredClone(context.storeRef);
  const before = structuredClone(input), result = inspect(input);
  assert.equal(result.status, "blocked");
  assert.equal(entryFor(result, "schema").status, "scope_mismatch");
  assert.equal(entryFor(result, "commission").status, "current");
  assert.deepEqual(input, before);
});

test("schema readiness follows current C1 evidence instead of the superseded historical B schema", () => {
  const input = createFinalPricingRevalidationFixture();
  const oldSchema = input.evidencePacks.find(pack => pack.kind === "schema");
  const currentSchema = structuredClone(oldSchema);
  currentSchema.id = "schema:current-c1-revision";
  currentSchema.evidenceData.evidenceId = currentSchema.id;
  currentSchema.checkedAt = input.observedAt;
  currentSchema.evidenceData.collectedAt = input.observedAt;
  currentSchema.evidenceData.schemaRevision = "ozon-schema:current-content-v2";
  currentSchema.evidenceData.writeBindings.schemaRevision = currentSchema.evidenceData.schemaRevision;
  currentSchema.evidenceData.writeBindings.evidenceRef = currentSchema.id;
  currentSchema.scope.ruleVersion = "ozon-current-v2";
  input.candidate.lifecycleEvidenceContextV11.schemaRuleVersion = currentSchema.scope.ruleVersion;
  const created = createC1ProductPlan({ ...input.formal.state, platformSchemaEvidence: currentSchema.evidenceData,
    createdAt: input.observedAt });
  const checked = verifyC1ProductFacts({ skuPackage: created.skuPackage, verifiedAt: input.observedAt,
    skuRightsReview: syntheticSkuRightsReview({ brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS,
      plan: created.c1ProductPlan, sourceIdentity: created.skuPackage.g1Identity, reviewedAt: input.observedAt }) });
  input.candidate.lifecycleV11.skuPackage.c1ProductPlan = structuredClone(checked.c1ProductPlan);
  oldSchema.status = "superseded";
  oldSchema.expiresAt = input.observedAt;
  input.evidencePacks.push(currentSchema);
  const before = structuredClone(input), result = inspect(input);
  assert.equal(result.status, "current", JSON.stringify(result));
  assert.equal(entryFor(result, "schema").evidenceId, currentSchema.id);
  assert.equal(created.c1ProductPlan.schemaSnapshotRef, currentSchema.id);
  assert.equal(created.c1ProductPlan.frozenInputRefs.schemaSnapshotRef, currentSchema.id);
  assert.equal(checked.c1ProductPlan.schemaSnapshot.evidenceId.value, currentSchema.id);
  assert.deepEqual(checked.c1ProductPlan.inputSnapshots.platformSchemaRules, currentSchema.evidenceData);
  assert.equal(input.candidate.lifecycleV11.bSystemEvidenceBundle.platformSchemaEvidence.evidenceId, oldSchema.id);
  assert.deepEqual(input, before);
});

test("same-ID schema content drift is invalid even when its reference and time window still match", () => {
  for (const change of [
    pack => { pack.evidenceData.schemaRevision = "ozon-schema:unfrozen-version"; },
    pack => { pack.evidenceData.requiredFields = []; },
    pack => { pack.evidenceData.writeBindings.content.title.attributeId += 1; },
    pack => { pack.checkedAt = "2026-08-18T05:00:00.000Z"; }
  ]) {
    const input = createFinalPricingRevalidationFixture();
    const pack = input.evidencePacks.find(pack => pack.kind === "schema");
    change(pack);
    const before = structuredClone(input), result = inspect(input);
    assert.equal(result.status, "blocked");
    assert.equal(entryFor(result, "schema").status, "invalid");
    assert.deepEqual(input, before);
  }
});

test("complete official-reference commission evidence is diagnosed without upgrading it to an exact commission or an authorization", () => {
  const input = structuredClone(createFinalPricingRevalidationFixture());
  const bundle = input.candidate.lifecycleV11.bSystemEvidenceBundle, pack = input.evidencePacks[0];
  const binding = { schemaVersion: "ozon-official-commission-binding-v1", candidateId: input.candidate.id,
    candidateRevision: bundle.sourceCandidateRevision, priceRub: 1831 };
  const catalog = { effectiveFrom: "2026-08-01", fileSha256: "a".repeat(64),
    sourceUrl: "https://docs.ozon.ru/common/pravila-raboty/komissii/", priceTier: "1500_5000",
    matchedRow: { typeRu: "3D-пазл", typeZh: "立体拼图", mpCategoryZh: "爱好与创意" } };
  pack.sourceType = "ozon_official_commission_table";
  pack.commissionCatalogRef = structuredClone(catalog);
  Object.assign(pack.evidenceData, { commissionEvidenceMode: "official_reference", officialCommissionBinding: binding, estimateAuthorized: false });
  Object.assign(bundle.platformFeeEvidence, { commissionEvidenceMode: "official_reference", officialCommissionBinding: structuredClone(binding),
    commissionCatalogRef: structuredClone(catalog), estimateAuthorized: false });
  input.candidate.dataRevision += 2;
  const before = structuredClone(input), result = inspect(input);
  assert.equal(result.status, "current", JSON.stringify(result));
  assert.equal(entryFor(result, "commission").status, "current");
  assert.deepEqual(input, before);
});

test("production preparation exposes evidence diagnosis without converting current evidence into production readiness", () => {
  const input = createFinalPricingRevalidationFixture();
  const configuration = { storeBindings: [{ targetStore: input.candidate.targetStore, platform: input.candidate.targetPlatform,
    storeRef: structuredClone(input.candidate.storeRef) }], productionBindings: [] };
  const before = structuredClone(input);
  const view = buildProductionOwnerPreparationView({ ...input, configuration });
  assert.deepEqual(view.evidenceReadiness, inspect(input));
  assert.equal(view.evidenceReadiness.status, "current");
  assert.equal(view.ready, false);
  assert.equal(view.scope, null);
  assert.deepEqual(view.executionBindings, []);
  assert.ok(view.gaps.some(gap => gap.code === "PRODUCTION_BINDING_NOT_CONFIGURED"));
  assert.ok(view.gaps.some(gap => gap.code === "PRODUCTION_FINAL_CARD_REQUIRED"));
  assert.deepEqual(JSON.parse(JSON.stringify(view)).evidenceReadiness, view.evidenceReadiness);
  assert.equal(input.candidate.lifecycleV11.skuPackage.productionAuthorization, null);
  assert.equal(input.candidate.lifecycleV11.skuPackage.productionRecord, null);
  assert.deepEqual(input, before);
});
