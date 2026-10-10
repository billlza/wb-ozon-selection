import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation, assertSafeBusinessMutationCandidate } from './runtime-identity.mjs';
import { applyLifecycleBEvidenceContext } from './lifecycle-b-evidence-context.mjs';
import { buildLifecycleBExplicitOtherCosts, resolveLifecycleBProfitRule } from './lifecycle-b-evidence-runtime.mjs';
import { buildRealAConfirmationCard } from './real-a-confirmation-card.mjs';
import { runRealAConfirmationToBAndC1, assertCurrentBCommissionEvidence } from './real-a-b-c1-flow.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { createSoftwareExecutionRuntime, startSoftwareStep, completeExecutionStep } from './software-execution-state.mjs';
import { isCommercialMerchantSku, prepareProductionCommercialDraft } from './production-commercial-draft.mjs';
import { merchantSkuClaimsForStore } from './business-mutation-transaction.mjs';
import { siblingPlatform, siblingSupplyPreparation } from './sibling-supply-preparation.mjs';

const CENTRAL_MODES = new Set(['central_test', 'central_production']);
const text = value => typeof value === 'string' && value.trim() !== '';
const positive = value => Number.isFinite(value) && value > 0;
const nonNegative = value => Number.isFinite(value) && value >= 0;
const fail = code => { throw new Error(code); };

function assertInput(input) {
  if (!input || Object.keys(input).sort().join() !== 'members,parentCandidateId,parentRevision,shared' ||
      !text(input.parentCandidateId) || !Number.isSafeInteger(input.parentRevision) || input.parentRevision < 0 ||
      !input.shared || typeof input.shared !== 'object' || Array.isArray(input.shared) ||
      !Array.isArray(input.members) || input.members.length === 0 || input.members.length > 100 ||
      input.members.some(member => !member || Object.keys(member).sort().join() !==
        'candidateId,candidateRevision,merchantSku,sourceSkuId,stock,targetSalePriceRub,unitProductPrice,weightKg' ||
        !text(member.candidateId) ||
        !Number.isSafeInteger(member.candidateRevision) || member.candidateRevision < 0 ||
        !text(member.sourceSkuId) || !positive(member.unitProductPrice) || !positive(member.weightKg) ||
        !isCommercialMerchantSku(member.merchantSku) || !Number.isSafeInteger(member.stock) || member.stock < 0 ||
        (member.targetSalePriceRub !== null && !positive(member.targetSalePriceRub))) ||
      new Set(input.members.map(member => member.candidateId)).size !== input.members.length ||
      new Set(input.members.map(member => member.sourceSkuId)).size !== input.members.length ||
      new Set(input.members.map(member => member.merchantSku)).size !== input.members.length) fail('SIBLING_BATCH_A_INPUT_INVALID');
  const common = input.shared;
  if (Object.keys(common).filter(k => k !== 'reusePriorSupply').sort().join() !==
      'confirmExactSkuSupply,confirmSalesReview,dimensionsCm,minimumOrderQuantity,otherPurchaseCosts,packagingCostRmb,quantityOneEvidenceSourceNote,route,salesReview,targetSalePriceRub,unitDomesticFreight' ||
      (Object.hasOwn(common, 'reusePriorSupply') && typeof common.reusePriorSupply !== 'boolean') ||
      !positive(common.targetSalePriceRub) || !nonNegative(common.unitDomesticFreight) ||
      !nonNegative(common.otherPurchaseCosts) || !nonNegative(common.packagingCostRmb) ||
      common.minimumOrderQuantity !== 1 ||
      common.confirmExactSkuSupply !== true || common.confirmSalesReview !== true || !text(common.route) ||
      !text(common.quantityOneEvidenceSourceNote) || common.quantityOneEvidenceSourceNote.length > 1000 ||
      !common.salesReview || typeof common.salesReview !== 'object' ||
      !['length', 'width', 'height'].every(key => positive(common.dimensionsCm?.[key]))) {
    fail('SIBLING_BATCH_A_SHARED_INPUT_INVALID');
  }
}

function submissionFor(candidate, member, common) {
  const card = buildRealAConfirmationCard(candidate);
  const choices = card.supplierCapture?.skuChoices?.filter(choice => choice.sourceSkuId === member.sourceSkuId) ?? [];
  if (choices.length !== 1) fail('SIBLING_BATCH_A_SKU_CAPTURE_MISSING');
  const choice = choices[0];
  const supply = {
    productUrl: card.supplierCapture.sourceUrl, captureId: card.supplierCapture.captureId,
    supplierSkuId: member.sourceSkuId, variantKey: choice.variantKey,
    unitProductPrice: member.unitProductPrice, unitDomesticFreight: common.unitDomesticFreight,
    otherPurchaseCosts: common.otherPurchaseCosts,
    actualPurchaseCost: member.unitProductPrice + common.unitDomesticFreight + common.otherPurchaseCosts,
    weightKg: member.weightKg, dimensionsCm: structuredClone(common.dimensionsCm),
    minimumOrderQuantity: common.minimumOrderQuantity, matchType: 'exact_match',
    quantityOneEvidenceSourceNote: common.quantityOneEvidenceSourceNote, ownerSupplyConfirmed: true
  };
  return { sourceCandidateId: candidate.id, sourceDataRevision: candidate.dataRevision,
    dataRevision: candidate.dataRevision, targetPlatform: card.targetPlatform, storeRef: structuredClone(card.storeRef),
    decision: 'confirm', targetSalePriceRub: member.targetSalePriceRub ?? common.targetSalePriceRub,
    salesReview: structuredClone(common.salesReview), supplierConfirmation: supply };
}

/** One owner submission; every child passes the existing A/B/C1 rules before one atomic save. */
export async function commitSiblingBatchABAndC1({ repository, runtimeMode, actor, input, serverClock, guooFilePath }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (CENTRAL_MODES.has(runtimeMode)) assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' ||
      typeof serverClock !== 'function') fail('SIBLING_BATCH_A_OWNER_REQUIRED');
  assertInput(input);
  return repository.transact(document => {
    const parents = document.candidates.filter(candidate => candidate.id === input.parentCandidateId);
    if (parents.length !== 1 || parents[0].dataRevision !== input.parentRevision) fail('SIBLING_BATCH_A_PARENT_CHANGED');
    const parent = parents[0];
    const selected = parent.sourceCapture?.selectedSkuIds;
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length) fail('SIBLING_BATCH_A_PARENT_SELECTION_INVALID');
    const excluded = parent.lifecycleV11?.skuPackage?.supplierSkuId;
    const requested = input.members.map(member => member.sourceSkuId);
    if (requested.length !== selected.filter(id => id !== excluded).length ||
        requested.some(id => id === excluded || !selected.includes(id))) fail('SIBLING_BATCH_A_SCOPE_MISMATCH');
    const at = serverClock();
    const prepared = input.members.map(member => {
      const matches = document.candidates.filter(candidate => candidate.id === member.candidateId);
      if (matches.length !== 1) fail('SIBLING_BATCH_A_MEMBER_NOT_UNIQUE');
      const child = matches[0];
      if (child.dataRevision !== member.candidateRevision ||
          child.siblingSourceV1?.parentCandidateId !== parent.id ||
          child.siblingSourceV1?.supplierSkuId !== member.sourceSkuId || child.lifecycleV11?.skuPackage ||
          child.sourceCapture?.captureId !== parent.sourceCapture?.captureId ||
          child.sourceCapture?.offerId !== parent.sourceCapture?.offerId ||
          !sameStoreRef(child.storeRef, parent.storeRef)) {
        fail('SIBLING_BATCH_A_MEMBER_CONFLICT');
      }
      let platform;
      try { platform = siblingPlatform(parent, child); }
      catch (error) { if(error.message!=='SIBLING_PLATFORM_IDENTITY_CONFLICT')throw error;fail('SIBLING_BATCH_A_MEMBER_CONFLICT'); }
      const reuse = input.shared.reusePriorSupply ? siblingSupplyPreparation(parent, [child]) : null;
      if (reuse && (reuse.gaps.length || reuse.rows[0].unitProductPrice !== member.unitProductPrice)) fail('SIBLING_BATCH_A_QUANTITY_ONE_EVIDENCE_MISSING');
      const common = reuse ? { ...input.shared, quantityOneEvidenceSourceNote: reuse.rows[0].quantityOneEvidenceSourceNote } : input.shared;
      const projected = { ...child, targetPlatform: platform };
      const submission = submissionFor(projected, member, common);
      const withCost = { ...projected, packagingCostRmb: input.shared.packagingCostRmb };
      const contextual = applyLifecycleBEvidenceContext(withCost, { submission, guooFilePath,
        route: input.shared.route }).candidate;
      const profitRule = resolveLifecycleBProfitRule(contextual, document.rules);
      const otherCosts = buildLifecycleBExplicitOtherCosts(contextual, profitRule, { asOf: at });
      const result = runRealAConfirmationToBAndC1({ candidate: contextual, submission,
        evidencePacks: document.evidencePacks ?? [], currentCommissionCatalogs: document.currentCommissionCatalogs ?? [],
        otherCosts, confirmedAt: at });
      if (result.profitModel.result !== 'passed' || result.c1Handoff === null) fail('SIBLING_BATCH_A_B_NOT_PASSED');
      assertCurrentBCommissionEvidence({ bundle: result.systemEvidenceBundle,
        evidencePacks: document.evidencePacks ?? [], currentCommissionCatalogs: document.currentCommissionCatalogs ?? [], asOf: at });
      return { child, result, platform, reuse, context: contextual.lifecycleEvidenceContextV11 };
    });
    for (const { child, result, context, platform, reuse } of prepared) {
      child.targetPlatform = platform;
      child.packagingCostRmb = input.shared.packagingCostRmb;
      child.lifecycleEvidenceContextV11 = structuredClone(context);
      child.lifecycleV11 = { schemaVersion: 'product-lifecycle-v1.1', status: 'b_passed_auto_c1',
        aConfirmationReceipt: { receiptId: result.confirmationReceiptId, decision: 'confirm',
          sourceCandidateRevision: result.sourceCandidateRevision, confirmedAt: at },
        opportunityPackage: structuredClone(result.opportunityPackage),
        ownerSupplyConfirmation: structuredClone(result.ownerSupplyConfirmation),
        bSystemEvidenceBundle: structuredClone(result.systemEvidenceBundle),
        skuPackage: structuredClone(result.skuPackage), c1Handoffs: [structuredClone(result.c1Handoff)],
        externalAccesses: [], platformWrites: 0 };
      if (reuse) child.lifecycleV11.aSiblingSupplyReuseV1 = { ...reuse,
        confirmedAt: at, confirmedBy: actor.userId, otherPurchaseCosts: input.shared.otherPurchaseCosts,
        costDecision: reuse.otherPurchaseCosts === input.shared.otherPurchaseCosts ? 'reuse_confirmed_cost_no_additions' : 'owner_explicit_cost_revision' };
      child.workflowStatus = 'listing_preparation';
      child.listingPreparation = { status: 'c1_inputs_ready', reason: '本规格 A 与正式 B 已在整批事务中通过；C1 输入已建立。',
        decisionItems: [], writeOccurred: false, platformWrites: 0 };
      child.listingHandoff = { state: 'created', owner: 'listing_task', runId: null,
        currentStep: 'B利润通过，C1输入已自动创建', blockReason: null,
        userAction: '无需再次点击开始上架准备', inheritedInputRevision: result.c1Handoff.inheritedSkuRevision,
        handoffId: result.c1Handoff.handoffId, realTaskDispatched: false };
      child.bPassedAt = at;
      const runtime = child.executionRuntime ?? createSoftwareExecutionRuntime({
        candidateId: child.id, dataRevision: child.dataRevision, businessPhase: 'A',
        stepId: 'A_CONFIRMATION', at });
      const bRuntime = startSoftwareStep(runtime, { stepId: 'B_DETERMINISTIC_PROFIT',
        inputRevision: child.dataRevision, at });
      child.executionRuntime = completeExecutionStep(bRuntime, { outputRevision: child.dataRevision + 1, at });
      child.executionRuntime.businessPhase = 'C1';
      child.updatedAt = at;
      child.lastModifiedBy = actor.userId;
      const member = input.members.find(item => item.candidateId === child.id);
      const commercial = prepareProductionCommercialDraft({ candidate: child,
        merchantSku: member.merchantSku, stock: member.stock, savedByUserId: actor.userId,
        savedAt: at, merchantSkuClaims: merchantSkuClaimsForStore(document, child) });
      Object.assign(child, commercial.candidate);
      assertSafeBusinessMutationCandidate(child);
    }
    return { changed: true, document, result: { status: 'c1_inputs_ready',
      members: prepared.map(({ child, result }) => ({ candidateId: child.id,
        supplierSkuId: result.skuPackage.supplierSkuId, sourceRevision: result.sourceCandidateRevision,
        resultRevision: child.dataRevision, profitModelVersion: result.profitModel.profitModelVersion,
        c1HandoffId: result.c1Handoff.handoffId })), platformWrites: 0, externalRequests: 0 } };
  });
}
