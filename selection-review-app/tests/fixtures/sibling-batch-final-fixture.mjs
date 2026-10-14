import assert from 'node:assert/strict';
import { productionOwnerDecisionFixture } from './production-owner-decision-fixture.mjs';
import { buildProductionOwnerPreparationView } from '../../lib/production-owner-preparation.mjs';
import { prepareProductionCommercialDraft } from '../../lib/production-commercial-draft.mjs';
import { createMemoryBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { createFormalC1C2Fixture } from './formal-c1-flow-fixture.mjs';
import { localFinalAssets, ownerDecision } from '../helpers/c2-software-fixture.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../../lib/c2-software-orchestrator.mjs';
import { createFinalProductPlanConfirmationCard } from '../../lib/final-product-plan-confirmation-card.mjs';
import { attachSyntheticFinalPricingReview } from './final-pricing-review-fixture.mjs';

export function readyAuthorizationFamily() {
  const source = productionOwnerDecisionFixture();
  const prepared = prepareProductionCommercialDraft({ candidate: source.candidate,
    merchantSku: 'MERCHANT-CHILD', stock: 37, savedByUserId: 'synthetic-owner',
    savedAt: source.args.serverClock(), merchantSkuClaims: [] });
  const child = prepared.candidate;
  child.productionOwnerPreparation = buildProductionOwnerPreparationView({ candidate: child,
    configuration: source.configuration, evidencePacks: source.evidencePacks,
    currentCommissionCatalogs: source.currentCommissionCatalogs, observedAt: source.args.serverClock() });
  assert.equal(child.productionOwnerPreparation.ready, true);
  child.siblingSourceV1 = { parentCandidateId: 'candidate:synthetic-parent', supplierSkuId: child.lifecycleV11.skuPackage.supplierSkuId };
  const parent = { id: 'candidate:synthetic-parent', dataRevision: 10,
    targetPlatform: child.targetPlatform, targetStore: child.targetStore,
    storeRef: structuredClone(child.storeRef), sourceUrl: child.sourceUrl,
    sourceCapture: { offerId: child.sourceCapture.offerId,
      selectedSkuIds: ['PARENT-SKU', child.lifecycleV11.skuPackage.supplierSkuId],
      skuChoices: [{ sourceSkuId: child.lifecycleV11.skuPackage.supplierSkuId,
        attributes: { 颜色: '黑色' } }] },
    lifecycleV11: { skuPackage: { supplierSkuId: 'PARENT-SKU', technicalStatus: 'unknown_outcome',
      productionAuthorization: { lockedScope: { merchantSku: 'MERCHANT-PREVIOUS' } } } } };
  return { source, parent, child };
}

export function secondReadyMember(parent, { candidateId = 'candidate:synthetic-second',
  supplierSkuId = 'SHELF-SECOND', color = '白色', merchantSku = 'MERCHANT-SECOND' } = {}) {
  const formal = createFormalC1C2Fixture({ candidateId,
    supplierSkuId, variantKey: `规格:${color}置物架`, productName: '合成置物架', categoryPath: 'Дом / Полки' });
  const source = formal.c2.skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: source,
    expectedDataRevision: source.dataRevision, finalUploadAssets: localFinalAssets(), preparedAt: formal.at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source,
    expectedDataRevision: source.dataRevision, finalManifest: manifest,
    ownerDecision: ownerDecision(manifest), confirmedAt: formal.at });
  const priced = attachSyntheticFinalPricingReview(confirmed.skuPackage,
    { at: formal.at, candidateRevision: formal.candidate.dataRevision });
  const card = createFinalProductPlanConfirmationCard({ skuPackage: priced, createdAt: formal.at });
  const candidate = { ...formal.candidate, lifecycleV11: { ...formal.candidate.lifecycleV11,
    skuPackage: card.skuPackage } };
  const fixture = productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    { sourceCandidate: candidate, sourceAt: formal.at });
  const saved = prepareProductionCommercialDraft({ candidate: fixture.candidate,
    merchantSku, stock: 42, savedByUserId: 'synthetic-owner',
    savedAt: formal.at, merchantSkuClaims: [] }).candidate;
  saved.productionOwnerPreparation = buildProductionOwnerPreparationView({ candidate: saved,
    configuration: fixture.configuration, evidencePacks: fixture.evidencePacks,
    currentCommissionCatalogs: fixture.currentCommissionCatalogs, observedAt: formal.at });
  saved.siblingSourceV1 = { parentCandidateId: parent.id, supplierSkuId: saved.lifecycleV11.skuPackage.supplierSkuId };
  parent.sourceCapture.selectedSkuIds.push(saved.lifecycleV11.skuPackage.supplierSkuId);
  parent.sourceCapture.skuChoices.push({ sourceSkuId: saved.lifecycleV11.skuPackage.supplierSkuId,
    attributes: { 颜色: color } });
  return saved;
}
