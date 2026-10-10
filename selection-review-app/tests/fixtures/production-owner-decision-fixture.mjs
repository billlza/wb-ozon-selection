import { attachProductionProfitEvidence } from "./production-profit-evidence-fixture.mjs";
import { attachSyntheticFinalPricingReview } from './final-pricing-review-fixture.mjs';
import assert from "node:assert/strict";
import { createFormalC1C2Fixture } from "./formal-c1-flow-fixture.mjs";
import { localFinalAssets, ownerDecision } from "../helpers/c2-software-fixture.mjs";
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from "../../lib/c2-software-orchestrator.mjs";
import { createFinalProductPlanConfirmationCard } from "../../lib/final-product-plan-confirmation-card.mjs";
import { PRODUCTION_WRITE_FIELDS } from "../../lib/production-authorization.mjs";
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from "../../lib/business-state-repository.mjs";
import { createActorContext } from "../../lib/runtime-identity.mjs";
import { createSelectionReviewRuntimeConfiguration } from "../../lib/runtime-configuration.mjs";
import { buildProductionOwnerPreparationView, resolveProductionOwnerPreparation } from "../../lib/production-owner-preparation.mjs";

/** Complete synthetic owner decision input; callers use the real commit to create authorization and D work. */
export function productionOwnerDecisionFixture(createRepository = createMemoryBusinessStateRepository, { finalUploadAssets = localFinalAssets(), commissionMode = "exact", includePricingReview = true, formalOptions = {}, sourceCandidate = null, sourceDocument = null, sourceAt = null } = {}) {
  const formal = sourceCandidate ? {candidate:structuredClone(sourceCandidate),at:sourceAt} : createFormalC1C2Fixture({ ...formalOptions, candidateId: "candidate:single-owner", supplierSkuId: "SHELF-OWNER",
    commissionMode, variantKey: "规格:白色置物架", productName: "测试置物架", categoryPath: "Дом / Полки" });
  let candidate;
  if (sourceCandidate) candidate = structuredClone(sourceCandidate);
  else {
    const source = formal.c2.skuPackage;
    const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision, finalUploadAssets, preparedAt: formal.at });
    const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: formal.at });
    const skuPackage = createFinalProductPlanConfirmationCard({ skuPackage: includePricingReview ? attachSyntheticFinalPricingReview(confirmed.skuPackage, { at: formal.at, candidateRevision: formal.candidate.dataRevision }) : confirmed.skuPackage, createdAt: formal.at }).skuPackage;
    candidate = { ...formal.candidate, lifecycleV11: { ...formal.candidate.lifecycleV11, skuPackage: structuredClone(skuPackage) } };
  }
  const skuPackage = candidate.lifecycleV11.skuPackage;
  const document = sourceDocument ? structuredClone(sourceDocument) : initialBusinessStateDocument({ now: formal.at }); document.candidates = [candidate];

  const card = skuPackage.productionConfirmationCard;
  const preparation = skuPackage.c2FinalAssets.productionAuthorizationPreparation;
  const profit = preparation.finalCardInputSnapshot.activeProfitModel;
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "synthetic-owner-session", actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: formal.at });
  const commercialDecision = { executionBinding: { bindingId: "binding:synthetic:ozon", configurationVersion: "configuration:synthetic:1", warehouseId: "10001" }, selectedOption: "approve_for_production_authorization", merchantSku: "MERCHANT-OWNER", warehouseRef: "warehouse:synthetic:ozon", credentialAlias: "credential-alias:synthetic:ozon", stock: 100,
    buyerTargetPrice: { amount: profit.recommendedSalePriceRub, currency: "RUB" }, platformWritePrice: { amount: profit.recommendedSalePriceCny, currency: "CNY" },
    priceConversion: structuredClone(profit.priceConversion), publishScope: "create_and_allow_validation_moderation", allowedWriteFields: [...PRODUCTION_WRITE_FIELDS], exclusions: ["no_activation", "no_advertising", "no_other_sku_write"] };
  const input = { contractVersion: "production-authorization-v1.2", dataRevision: candidate.dataRevision, skuRevision: skuPackage.dataRevision,
    cardId: card.cardId, cardRevision: card.cardRevision, sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint, bindingId: "binding:synthetic:ozon", configurationVersion: "configuration:synthetic:1", merchantSku: commercialDecision.merchantSku, confirmExactScope: true };
  const binding = { bindingId: input.bindingId, configurationVersion: input.configurationVersion, platform: "ozon", storeRef: structuredClone(candidate.storeRef),
    storeName: "合成测试店铺", warehouseName: "合成测试仓库", warehouseRef: commercialDecision.warehouseRef, warehouseId: "10001", credentialAlias: commercialDecision.credentialAlias,
    verification: { evidenceRef: "configuration-evidence:synthetic:1", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" } };
  const configuration = createSelectionReviewRuntimeConfiguration({ env: {
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([binding]) }, appDir: "/tmp/synthetic-owner-configuration", argv: [] });
  const { evidencePacks, currentCommissionCatalogs } = attachProductionProfitEvidence(candidate);
  document.evidencePacks = evidencePacks; document.currentCommissionCatalogs = currentCommissionCatalogs;
  const repository = createRepository(document);
  const preparedView = buildProductionOwnerPreparationView({ candidate, configuration, evidencePacks: document.evidencePacks, observedAt: formal.at });
  assert.equal(preparedView.ready, true, JSON.stringify(preparedView.gaps));
  const args = { repository, runtimeMode: "local_development", actor, candidateId: candidate.id, input, serverClock: () => formal.at,
    resolveProductionAuthorizationDecision: value => resolveProductionOwnerPreparation({ ...value, configuration }) };
  return { formal, candidate, configuration, evidencePacks, currentCommissionCatalogs, repository, commercialDecision, args, preparedView };
}
