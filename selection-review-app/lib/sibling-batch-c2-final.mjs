import {assertSiblingPreparationImageSelection} from './sibling-preparation-consistency.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { assertCurrentC2UploadDraft } from './c2-upload-draft.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from './c2-software-orchestrator.mjs';
import { createFinalProductPlanConfirmationCard } from './final-product-plan-confirmation-card.mjs';
import { assertSiblingSkuFinalCard } from './sibling-sku-card-guard.mjs';
import { createSoftwareExecutionRuntime, waitForOwner } from './software-execution-state.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';

const fail = code => { throw new Error(code); };

export function isSiblingBatchC2Replay(document, input, actor) {
  const fingerprint = fingerprintCanonicalRecord({ input, confirmedBy: actor.userId });
  return input.members.length > 0 && input.members.every(member => {
    if (!member || typeof member.candidateId !== 'string') return false;
    const matches = document.candidates.filter(item => item.id === member.candidateId);
    const child = matches.length === 1 ? matches[0] : null;
    const receipt = child?.lifecycleV11?.siblingBatchC2ReceiptV1;
    return receipt?.inputFingerprint === fingerprint && receipt.resultRevision === child.dataRevision &&
      receipt.parentCandidateId === input.parentCandidateId;
  });
}

/** All selected siblings receive independent C2 cards in one owner-confirmed transaction. */
export async function commitSiblingBatchC2Final({ repository, runtimeMode, actor, input, verifiedAssets, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (runtimeMode === 'central_test' || runtimeMode === 'central_production') assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' ||
      !input || input.confirmed !== true || !Number.isSafeInteger(input.parentRevision) ||
      typeof input.parentCandidateId !== 'string' || !Array.isArray(input.members) ||
      input.members.length === 0 || input.members.length > 100 ||
      input.members.some(member => !member || typeof member.candidateId !== 'string') ||
      typeof serverClock !== 'function') {
    fail('SIBLING_BATCH_C2_INPUT_INVALID');
  }
  if (new Set(input.members.map(item => item.candidateId)).size !== input.members.length ||
      input.members.some(item => !Number.isSafeInteger(item.candidateRevision) ||
        !Number.isSafeInteger(item.draftRevision) || !Array.isArray(item.approvedAssetIds) ||
        item.approvedAssetIds.length === 0 || new Set(item.approvedAssetIds).size !== item.approvedAssetIds.length)) {
    fail('SIBLING_BATCH_C2_INPUT_INVALID');
  }
  return repository.transact(document => {
    const parents = document.candidates.filter(item => item.id === input.parentCandidateId);
    if (parents.length !== 1 || parents[0].dataRevision !== input.parentRevision) fail('SIBLING_BATCH_C2_PARENT_CHANGED');
    const parent = parents[0];
    const selected = parent.sourceCapture?.selectedSkuIds?.filter(id => id !== parent.lifecycleV11?.skuPackage?.supplierSkuId);
    if (!Array.isArray(selected) || selected.length !== input.members.length ||
        new Set(selected).size !== selected.length) fail('SIBLING_BATCH_C2_SCOPE_MISMATCH');
    const inputFingerprint = fingerprintCanonicalRecord({ input, confirmedBy: actor.userId });
    const replay = input.members.map(member => document.candidates.find(item => item.id === member.candidateId));
    const memberSkuIds = replay.map(child => child?.siblingSourceV1?.supplierSkuId);
    if (new Set(memberSkuIds).size !== selected.length ||
        memberSkuIds.some(id => !selected.includes(id))) fail('SIBLING_BATCH_C2_SCOPE_MISMATCH');
    if (isSiblingBatchC2Replay(document, input, actor)) {
      return { changed: false, document, result: { status: 'idempotent_replay',
        members: replay.map(child => ({ candidateId: child.id, resultRevision: child.dataRevision })),
        externalRequests: 0, platformWrites: 0 } };
    }
    if (replay.some(child => child?.lifecycleV11?.siblingBatchC2ReceiptV1)) fail('SIBLING_BATCH_C2_REPLAY_CONFLICT');
    const at = serverClock();
    const prepared = input.members.map(member => {
      const matches = document.candidates.filter(item => item.id === member.candidateId);
      if (matches.length !== 1) fail('SIBLING_BATCH_C2_MEMBER_CONFLICT');
      const child = matches[0];
      if (child.dataRevision !== member.candidateRevision ||
          child.siblingSourceV1?.parentCandidateId !== parent.id ||
          !selected.includes(child.siblingSourceV1.supplierSkuId)) fail('SIBLING_BATCH_C2_MEMBER_CONFLICT');
      const { draft } = assertCurrentC2UploadDraft(child, { dataRevision: member.candidateRevision,
        draftRevision: member.draftRevision });
      if (!draft || JSON.stringify(draft.selection.map(item => item.assetId)) !== JSON.stringify(member.approvedAssetIds)) {
        fail('SIBLING_BATCH_C2_SELECTION_CHANGED');
      }
      const assets = verifiedAssets.get(child.id);
      if (!Array.isArray(assets) || assets.length !== member.approvedAssetIds.length ||
          assets.some((asset, index) => asset.assetId !== member.approvedAssetIds[index] ||
            asset.sha256 !== draft.uploads.find(item => item.assetId === asset.assetId)?.sha256)) {
        fail('SIBLING_BATCH_C2_ASSET_CHANGED');
      }
      const preparationDraft=(document.runtime?.siblingPreparationDrafts??[]).filter(r=>r.parentCandidateId===parent.id).at(-1);
      assertSiblingPreparationImageSelection({parent,candidate:child,draft:preparationDraft,assets});
      const sku = child.lifecycleV11.skuPackage;
      const manifest = prepareC2FinalUploadManifest({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
        finalUploadAssets: assets, preparedAt: at });
      const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
        finalManifest: manifest, ownerDecision: { status: 'confirmed', confirmedBy: 'owner',
          approvedManifestVersion: manifest.schemaVersion, approvedManifestSha256: manifest.manifestSha256,
          approvedAssetIds: manifest.approvedAssetIds,
          approvedAuthorizedMediaFingerprint: manifest.authorizedMediaFingerprint,
          approvedMainImageAssetId: manifest.mainImageAssetId,
          approvedVideoDisposition: manifest.videoDisposition, confirmationNote: null }, confirmedAt: at });
      const card = createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: at });
      assertSiblingSkuFinalCard({ ...child, lifecycleV11: { ...child.lifecycleV11, skuPackage: card.skuPackage } });
      return { child, skuPackage: card.skuPackage, mainHash: assets[0].sha256,
        color: child.sourceCapture?.skuChoices?.[0]?.attributes?.颜色 };
    });
    for (const [index, current] of prepared.entries()) {
      if (!current.color || prepared.slice(0, index).some(other => other.color !== current.color && other.mainHash === current.mainHash)) {
        fail('SIBLING_BATCH_C2_COLOR_MAIN_CONFLICT');
      }
    }
    for (const { child, skuPackage } of prepared) {
      child.lifecycleV11 = { ...child.lifecycleV11, skuPackage: structuredClone(skuPackage),
        siblingBatchC2ReceiptV1: { schemaVersion: 'sibling-batch-c2-receipt-v1',
          parentCandidateId: parent.id, sourceRevision: child.dataRevision,
          resultRevision: child.dataRevision + 1, inputFingerprint, confirmedBy: actor.userId,
          confirmedAt: at },
        status: 'awaiting_owner_business_confirmation', platformWrites: 0 };
      child.listingPreparation = { ...(child.listingPreparation ?? {}), status: 'awaiting_owner_business_confirmation',
        reason: '整批最终素材已逐规格确认，等待一次最终商业授权。', decisionItems: [], writeOccurred: false, platformWrites: 0 };
      child.dataRevision += 1;
      child.updatedAt = at;
      child.lastModifiedBy = actor.userId;
      const runtime = child.executionRuntime ?? createSoftwareExecutionRuntime({ candidateId: child.id,
        dataRevision: child.dataRevision - 1, businessPhase: 'C2', at });
      child.executionRuntime = waitForOwner({ ...runtime, businessPhase: 'C2', dataRevision: child.dataRevision },
        { stepId: 'C2_OWNER_BUSINESS_CONFIRMATION', inputRevision: child.dataRevision,
          at, detail: '整批最终素材已保存，等待最终商品确认' });
      child.history = [...(child.history ?? []), { at, actor: 'user', event: 'siblingBatchC2FinalAssetsConfirmed',
        summary: '本规格最终素材和方案卡已在整批事务中确认；零平台写入' }];
    }
    return { changed: true, document, result: { status: 'awaiting_owner_business_confirmation',
      members: prepared.map(({ child }) => ({ candidateId: child.id, resultRevision: child.dataRevision })),
      externalRequests: 0, platformWrites: 0 } };
  });
}
