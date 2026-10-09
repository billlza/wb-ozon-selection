import { attachProductionProfitEvidence } from "./fixtures/production-profit-evidence-fixture.mjs";
import { attachSyntheticFinalPricingReview } from './fixtures/final-pricing-review-fixture.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { createProductionAuthorization, commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { collectC1UnknownManifest } from '../lib/c1-product-plan.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { createSelectionReviewRuntimeConfiguration, normalizeProductionBindings } from "../lib/runtime-configuration.mjs";
import { buildProductionOwnerPreparationView, resolveProductionOwnerPreparation } from "../lib/production-owner-preparation.mjs";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { finalAssets, ownerDecision } from "./helpers/c2-software-fixture.mjs";
import { createC2SoftwareContainer, prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from "../lib/c2-software-orchestrator.mjs";
import { createFinalProductPlanConfirmationCard } from "../lib/final-product-plan-confirmation-card.mjs";

function fixture({ optionalMaterial = false } = {}) {
  const formal = createFormalC1C2Fixture({ candidateId: "SYNTHETIC-PRODUCTION-PREPARATION", categoryPath: "Дом / Модели" });
  const observedAt = "2026-08-22T07:00:00.000Z";
  let source = structuredClone(optionalMaterial ? formal.merged.skuPackage : formal.c2.skuPackage);
  if (optionalMaterial) {
    const plan = source.c1ProductPlan;
    plan.productAttributes.material = { value: 'unknown', verificationStatus: 'unknown', sourceRefs: [...plan.productAttributes.material.sourceRefs], reason: 'Synthetic material not supplied' };
    plan.productAttributes.requiredPlatformFields = [];
    plan.inputSnapshots.platformSchemaRules.requiredFields = [];
    plan.inputSnapshots.platformSchemaRules.writeBindings.requiredAttributes = [];
    plan.schemaSnapshot.writeBindings.value.requiredAttributes = [];
    plan.unknownManifest = collectC1UnknownManifest(plan);
    source = createC2SoftwareContainer({ skuPackage: source, expectedDataRevision: source.dataRevision,
      assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: formal.at }).skuPackage;
  }
  const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision, finalUploadAssets: finalAssets(), preparedAt: observedAt });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: observedAt });
  const card = createFinalProductPlanConfirmationCard({ skuPackage: attachSyntheticFinalPricingReview(confirmed.skuPackage, { at: observedAt, candidateRevision: formal.candidate.dataRevision }), createdAt: observedAt });
  const candidate = { ...structuredClone(formal.candidate), lifecycleV11: { skuPackage: structuredClone(card.skuPackage) } };
  const store = { targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: structuredClone(candidate.storeRef) };
  const binding = { bindingId: "binding:synthetic:ozon", configurationVersion: "config-v1", platform: "ozon", storeRef: structuredClone(candidate.storeRef),
    storeName: "合成测试店铺", warehouseName: "合成测试仓库", warehouseRef: "warehouse:synthetic:1", warehouseId: "10001", credentialAlias: "credential-alias:synthetic:1",
    verification: { evidenceRef: "configuration-evidence:synthetic:1", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" } };
  const configuration = createSelectionReviewRuntimeConfiguration({ env: { SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([store]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([binding]) }, appDir: "/tmp/synthetic-production-preparation", argv: [] });
  const { evidencePacks } = attachProductionProfitEvidence(candidate);
  const args = { candidate, configuration, evidencePacks, observedAt };
  const view = buildProductionOwnerPreparationView(args);
  const input = { contractVersion: view.contractVersion, ...view.source, bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
    merchantSku: "MERCHANT-SYNTHETIC-001", confirmExactScope: true };
  return { ...args, binding, store, input, view };
}

test("生产绑定只从显式配置读取，字段闭合、完整店铺、仓库和时间不隐式修补", () => {
  const f = fixture();
  assert.deepEqual(createSelectionReviewRuntimeConfiguration({ env: {}, appDir: "/tmp/synthetic-production-preparation", argv: [] }).productionBindings, []);
  assert.ok(Object.isFrozen(f.configuration.productionBindings[0].verification));
  for (const mutate of [
    b => { b.storeRef.mappingVersion = "other-version"; }, b => { b.warehouseId = "001"; }, b => { b.warehouseId = "9007199254740993"; },
    b => { b.verification.checkedAt = "2026-02-30T00:00:00.000Z"; }, b => { b.verification.expiresAt = b.verification.checkedAt; },
    b => { b.apiKey = "private-value"; }, b => { b.credentialAlias = "unknown"; }, b => { b.warehouseName = "internal-only"; },
    b => { b.bindingId = "binding:part/child"; }, b => { b.configurationVersion = "version#fragment"; }, b => { b.bindingId = "b".repeat(162); }
  ]) { const bad = structuredClone(f.binding); mutate(bad); assert.throws(() => normalizeProductionBindings([bad], [f.store]), /INVALID/); }
  assert.throws(() => normalizeProductionBindings([f.binding, { ...f.binding, bindingId: "other" }], [f.store]), /INVALID/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({ env: { SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: "broken-json" }, appDir: "/tmp/synthetic-production-preparation", argv: [] }), /有效JSON/);
});

test("正式冻结 B→C1→C2 生成安全准备视图，提交解析内部配置且不写入", () => {
  const f = fixture(); const before = JSON.stringify(f.candidate);
  assert.equal(f.view.ready, true, JSON.stringify(f.view.gaps));
  assert.equal(f.view.scope.buyerTargetPrice.amount, 1831);
  assert.equal(f.view.scope.platformWritePrice.amount, 151.78);
  assert.equal(f.view.scope.priceConversion.rubPerCny, 12.0637);
  assert.deepEqual(f.view.executionBindings, [{ bindingId: f.binding.bindingId, configurationVersion: "config-v1", warehouseName: "合成测试仓库" }]);
  for (const privateValue of [f.binding.credentialAlias, f.binding.warehouseRef, f.binding.warehouseId]) assert.equal(JSON.stringify(f.view).includes(privateValue), false);
  const decision = resolveProductionOwnerPreparation(f);
  assert.equal(decision.merchantSku, f.input.merchantSku);
  assert.equal(decision.warehouseRef, f.binding.warehouseRef);
  assert.equal(decision.credentialAlias, f.binding.credentialAlias);
  assert.deepEqual(decision.executionBinding, { bindingId: f.binding.bindingId, configurationVersion: f.binding.configurationVersion, warehouseId: f.binding.warehouseId });
  assert.equal(decision.stock, 100);
  assert.equal(decision.publishScope, "create_and_allow_validation_moderation");
  assert.equal(JSON.stringify(f.candidate), before);
});

test("未配置、过期或跨完整店铺的仓库不会变成可用选择", () => {
  const f = fixture();
  for (const args of [{ ...f, configuration: { ...f.configuration, productionBindings: [] } },
    { ...f, observedAt: f.binding.verification.expiresAt },
    { ...f, candidate: { ...f.candidate, storeRef: { ...f.candidate.storeRef, platformStoreId: "other-store" } } }]) {
    const view = buildProductionOwnerPreparationView(args);
    assert.equal(view.ready, false); assert.deepEqual(view.executionBindings, []);
    assert.throws(() => resolveProductionOwnerPreparation(args), /店铺|过期|身份/);
  }
});

test("只接受冻结 B 同一份有效汇率包，不用新包、倒置币种或同ID改价", () => {
  const f = fixture();
  const missing = buildProductionOwnerPreparationView({ ...f, evidencePacks: undefined });
  assert.equal(missing.ready, false); assert.equal(missing.gaps.at(-1).code, "PRODUCTION_FROZEN_FX_REQUIRED");
  const cases = [[], [...f.evidencePacks, ...f.evidencePacks]];
  for (const mutate of [p => { p.id = "fx:new"; }, p => { p.status = "superseded"; }, p => { p.scope.pair = "CNY/RUB"; },
    p => { p.evidenceData.rubPerCny = 11; }, p => { p.expiresAt = f.observedAt; }, p => { p.checkedAt = f.observedAt; },
    p => { p.checkedAt = "2026-02-30T00:00:00.000Z"; }, p => { p.sourceType = "unknown"; }, p => { p.sourceRef = "not_applicable"; }]) {
    const packs = structuredClone(f.evidencePacks); mutate(packs[0]); cases.push(packs);
  }
  for (const evidencePacks of cases) {
    const view = buildProductionOwnerPreparationView({ ...f, evidencePacks });
    assert.equal(view.ready, false); assert.equal(view.scope, null); assert.match(view.gaps.at(-1).code, /FROZEN_FX/);
  }
});

test("提交时再校验候选、SKU、卡片、源指纹及配置版本，拒绝浏览器提交自由scope", () => {
  const f = fixture();
  for (const key of ["dataRevision", "skuRevision", "cardRevision", "cardId", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "configurationVersion", "bindingId"]) {
    const input = { ...f.input, [key]: typeof f.input[key] === "number" ? f.input[key] + 1 : `${f.input[key]}-stale` };
    assert.throws(() => resolveProductionOwnerPreparation({ ...f, input }), /已更新|已变化/);
  }
  for (const extra of [{ stock: 0 }, { credentialAlias: "injected" }, { warehouseRef: "other" }, { priceConversion: {} }, { publishScope: "activate" }]) {
    assert.throws(() => resolveProductionOwnerPreparation({ ...f, input: { ...f.input, ...extra } }), /提交字段/);
  }
  const changed = structuredClone(f.configuration); changed.productionBindings[0].configurationVersion = "config-v2";
  assert.throws(() => resolveProductionOwnerPreparation({ ...f, configuration: changed }), /已变化/);
  assert.throws(() => resolveProductionOwnerPreparation({ ...f, input: { ...f.input, merchantSku: "not_applicable" } }), /提交字段/);
});

 test('owner preparation accepts schema-optional unknown material without changing its factual value', () => {
  const f = fixture({ optionalMaterial: true }), before = JSON.stringify(f.candidate);
  assert.equal(f.view.ready, true, JSON.stringify(f.view.gaps));
  const card = f.candidate.lifecycleV11.skuPackage.productionConfirmationCard;
  assert.ok(card.riskAndUnknowns.unknownFields.some(item => item.path.endsWith('productAttributes.material') && item.blocksProductionAuthorization === false));
  assert.equal(card.riskAndUnknowns.blockingUnknownCount, 0);
  assert.equal(resolveProductionOwnerPreparation(f).merchantSku, f.input.merchantSku);
  assert.equal(f.candidate.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.material.value, 'unknown');
  assert.equal(JSON.stringify(f.candidate), before);
});

test('owner preparation rejects legacy classifications and fabricated nonblocking classifications', () => {
  for (const mutate of [
    card => { delete card.riskAndUnknowns.classificationVersion; },
    card => { card.riskAndUnknowns.unknownFields.push({ path: 'c1Facts.productAttributes.requiredPlatformFields[0].fact', fieldKey: 'material', label: '材质', value: 'unknown', reason: 'Synthetic required gap', sourceRefs: [], blockingScope: 'informational', blocksProductionAuthorization: false }); },
    card => { card.riskAndUnknowns.blockingUnknownCount = 1; }
  ]) {
    const f = fixture(); mutate(f.candidate.lifecycleV11.skuPackage.productionConfirmationCard);
    assert.equal(buildProductionOwnerPreparationView(f).ready, false);
    assert.throws(() => resolveProductionOwnerPreparation(f));
  }
});

 test('owner preparation rejects schema-required material drift even when saved card calls it nonblocking', () => {
  const f = fixture({ optionalMaterial: true });
  const sku = f.candidate.lifecycleV11.skuPackage;
  sku.c1ProductPlan.inputSnapshots.platformSchemaRules.requiredFields = [{ fieldKey: 'material', label: '材质', required: true, sourceAttributeKeys: ['material'] }];
  assert.equal(sku.productionConfirmationCard.riskAndUnknowns.blockingUnknownCount, 0);
  const view = buildProductionOwnerPreparationView(f);
  assert.equal(view.ready, false);
  assert.throws(() => resolveProductionOwnerPreparation(f));
});


test('two comparable final-pricing samples remain explicitly insufficient for three while ready for owner preparation', () => {
  const f = fixture(), record = f.candidate.lifecycleV11.skuPackage.finalPricingReview;
  assert.equal(record.assessment.status, 'ready');
  assert.equal(record.assessment.coreSampleIds.length, 2);
  assert.equal(record.assessment.insufficientSamples, true);
  assert.equal(f.view.ready, true);
});

test('altered saved final comparison blocks preparation and direct authorization without modifying history', async () => {
  for (const mutate of [
    sku => { sku.finalPricingReview.assessment.selectedPriceRub += 1; },
    sku => { sku.finalPricingReview.profitModelVersion = 'synthetic:other-profit'; },
    sku => { sku.finalPricingReview.assessment.target.storeRef.platformStoreId = 'synthetic:other-store'; },
    sku => { sku.finalPricingReview.reviews[0].exactSpecification.value = false; },
    sku => { sku.finalPricingReview.salesSnapshots[0].evidenceRef = 'synthetic:changed-source'; }
  ]) {
    const f = fixture(); mutate(f.candidate.lifecycleV11.skuPackage);
    const before = structuredClone(f.candidate);
    const view = buildProductionOwnerPreparationView(f);
    assert.equal(view.ready, false); assert.ok(['FINAL_PRICING_REVIEW_REQUIRED', 'FINAL_PRICING_REVIEW_SOURCE_CHANGED', 'FINAL_PRICING_REVIEW_INVALID', 'PRODUCTION_FINAL_CARD_CHANGED'].includes(view.gaps.at(-1).code), view.gaps.at(-1).code);
    assert.deepEqual(f.candidate, before);
    const formal = productionOwnerDecisionFixture(), sku = structuredClone(formal.candidate.lifecycleV11.skuPackage);
    mutate(sku); const frozen = structuredClone(sku);
    assert.throws(() => createProductionAuthorization({ candidate: { ...formal.candidate, lifecycleV11: { ...formal.candidate.lifecycleV11, skuPackage: sku } }, evidencePacks: formal.evidencePacks, currentCommissionCatalogs: formal.currentCommissionCatalogs, candidateId: formal.candidate.id, sourceCandidateRevision: formal.candidate.dataRevision,
      currentCandidateRevision: formal.candidate.dataRevision, skuPackage: sku, commercialDecision: formal.commercialDecision,
      ownerActor: formal.args.actor, authorizedAt: formal.formal.at }), /FINAL_PRICING|最终/);
    assert.deepEqual(sku, frozen); assert.equal(sku.productionAuthorization, null); assert.equal(sku.dHandoff, undefined);
    await formal.repository.transact(document => { mutate(document.candidates[0].lifecycleV11.skuPackage); return { changed: true, document, result: null }; });
    const doc = await formal.repository.readSnapshot();
    await assert.rejects(() => commitSingleOwnerProductionAuthorization(formal.args), /FINAL_PRICING|最终/);
    assert.deepEqual(await formal.repository.readSnapshot(), doc);
    assert.equal(Object.hasOwn(doc.runtime, 'softwareJobs'), false, 'no software job collection is created by rejected authorization');
  }
});
