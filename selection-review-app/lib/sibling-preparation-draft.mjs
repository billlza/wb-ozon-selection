import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { fingerprintCanonicalRecord, assertNoProductionSecrets } from './production-contract-primitives.mjs';
import { siblingPlatform } from './sibling-supply-preparation.mjs';

const text = x => typeof x === 'string' && x.length <= 1500;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function preparationFamily(document, parentId, catalog) {
  const parent = document.candidates.find(x => x.id === parentId);
  if (!parent || !catalog || parent.sourceCapture?.offerId !== catalog.offerId || parent.targetPlatform !== catalog.platform) fail('SIBLING_PREPARATION_CATALOG_SCOPE');
  const selected = parent.sourceCapture?.selectedSkuIds;
  if (!Array.isArray(selected) || catalog.supplierSkuIds.some(id => !selected.includes(id)) ||
      selected.filter(id => id !== parent.lifecycleV11?.skuPackage?.supplierSkuId).length !== catalog.supplierSkuIds.length) fail('SIBLING_PREPARATION_MEMBERS_CHANGED');
  const members = catalog.supplierSkuIds.map(sourceSkuId => {
    const matches = document.candidates.filter(x => x.siblingSourceV1?.parentCandidateId === parent.id && x.siblingSourceV1?.supplierSkuId === sourceSkuId);
    const child = matches[0];
    if (matches.length !== 1 || !sameStoreRef(child.storeRef, parent.storeRef) ||
        child.sourceCapture?.captureId !== parent.sourceCapture?.captureId || child.sourceCapture?.offerId !== catalog.offerId || catalog.excludedSupplierSkuIds.includes(sourceSkuId)) fail('SIBLING_PREPARATION_MEMBERS_CHANGED');
    try { siblingPlatform(parent, child); }
    catch (error) { if(error.message!=='SIBLING_PLATFORM_IDENTITY_CONFLICT')throw error;fail('SIBLING_PREPARATION_MEMBERS_CHANGED'); }
    return child;
  });
  return { parent, members };
}

export function validatePreparationValues(values, family, catalog) {
  const sharedKeys = Object.keys(catalog.defaults).sort();
  if (!values || Object.keys(values).sort().join() !== 'members,page,shared,supplyReviewed' ||
      !Number.isInteger(values.page) || values.page < 0 || values.page > 3 || typeof values.supplyReviewed !== 'boolean' ||
      !values.shared || Object.keys(values.shared).sort().join() !== sharedKeys.join() || !sharedKeys.every(k => text(values.shared[k])) ||
      !Array.isArray(values.members) || values.members.length !== family.members.length) fail('SIBLING_PREPARATION_DRAFT_INVALID');
  const assets = new Map(catalog.assets.map(a => [a.assetId, a]));
  values.members.forEach((m, i) => {
    const child = family.members[i];
    if (!m || Object.keys(m).sort().join() !== 'candidateId,colorRu,hero,merchantSku,order,overrides,platformColors,sourceSkuId' ||
        m.candidateId !== child.id || m.sourceSkuId !== child.siblingSourceV1.supplierSkuId || !text(m.colorRu) || !text(m.merchantSku) ||
        !m.overrides || Object.keys(m.overrides).some(k => !sharedKeys.includes(k)) || !Object.values(m.overrides).every(text) ||
        !Array.isArray(m.platformColors) || m.platformColors.length > 6 || new Set(m.platformColors).size !== m.platformColors.length || !m.platformColors.every(text) ||
        !Array.isArray(m.order) || m.order.length > 20 || new Set(m.order).size !== m.order.length ||
        m.order.some(id => !assets.has(id) || assets.get(id).onlySourceSkuId && assets.get(id).onlySourceSkuId !== m.sourceSkuId) ||
        m.hero !== null && (typeof m.hero !== 'string' || m.hero !== m.order[0])) fail('SIBLING_PREPARATION_DRAFT_INVALID');
  });
  assertNoProductionSecrets(values, 'sibling_preparation_values');
}

export async function saveSiblingPreparationDraft({ repository, runtimeMode, actor, input, catalog, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (['central_test', 'central_production'].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' || typeof serverClock !== 'function' ||
      !input || Object.keys(input).sort().join() !== 'expectedDraftRevision,idempotencyKey,memberRevisions,parentCandidateId,parentRevision,values' ||
      !Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 0 || !Number.isSafeInteger(input.parentRevision) || input.parentRevision < 0 || !text(input.parentCandidateId) || !input.parentCandidateId ||
      typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:-]{1,160}$/.test(input.idempotencyKey) || !Array.isArray(input.memberRevisions) || input.memberRevisions.some(m => !m || Object.keys(m).sort().join() !== 'candidateId,revision' || !text(m.candidateId) || !m.candidateId || !Number.isSafeInteger(m.revision) || m.revision < 0)) fail('SIBLING_PREPARATION_INPUT_INVALID');
  assertNoProductionSecrets(input, 'sibling_preparation_input');
  return repository.transact(document => {
    const family = preparationFamily(document, input.parentCandidateId, catalog);
    validatePreparationValues(input.values, family, catalog);
    document.runtime ??= {};
    const history = document.runtime.siblingPreparationDrafts ?? [];
    const versions = history.filter(r => r.parentCandidateId === family.parent.id);
    const current = versions.at(-1);
    const fingerprint = fingerprintCanonicalRecord({ actorId: actor.userId, input, catalogId: catalog.catalogId, catalogVersion: catalog.version });
    const replay = versions.find(r => r.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (replay.inputFingerprint !== fingerprint) fail('SIBLING_PREPARATION_REPLAY_CONFLICT');
      return { changed: false, document, result: { draft: structuredClone(replay), externalRequests: 0, platformWrites: 0 } };
    }
    if (family.parent.dataRevision !== input.parentRevision || input.memberRevisions.length !== family.members.length ||
        family.members.some((m,i) => input.memberRevisions[i]?.candidateId !== m.id || input.memberRevisions[i]?.revision !== m.dataRevision)) fail('SIBLING_PREPARATION_SOURCE_CHANGED');
    if ((current?.draftRevision ?? 0) !== input.expectedDraftRevision) fail('SIBLING_PREPARATION_DRAFT_CONFLICT');
    if (family.members.some(m => m.lifecycleV11?.skuPackage?.productionAuthorization || m.lifecycleV11?.skuPackage?.productionRecord || m.lifecycleV11?.skuPackage?.technicalStatus === 'unknown_outcome')) fail('SIBLING_PREPARATION_FROZEN');
    if (versions.length >= 1000) fail('SIBLING_PREPARATION_VERSION_LIMIT');
    const draft = { schemaVersion: 'sibling-preparation-draft-v1', parentCandidateId: family.parent.id,
      sourceRevision: input.parentRevision, memberRevisions: structuredClone(input.memberRevisions),
      draftRevision: (current?.draftRevision ?? 0) + 1, catalogId: catalog.catalogId, catalogVersion: catalog.version,
      assetBindings: catalog.assets.map(a=>({assetId:a.assetId,sha256:a.sha256,onlySourceSkuId:a.onlySourceSkuId})),
      values: structuredClone(input.values), savedBy: actor.userId, savedAt: serverClock(), idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprint,
      productionAuthorizationGranted: false };
    document.runtime.siblingPreparationDrafts = [...history, draft];
    for (const member of family.members) member.siblingPreparationDraftRefV1={parentCandidateId:family.parent.id,draftRevision:draft.draftRevision,inputFingerprint:fingerprint};
    document.runtime.operationAudit ??= [];
    document.runtime.operationAudit.push({ eventId: `audit:sibling-preparation:${family.parent.id}:${draft.draftRevision}`,
      action: 'save_sibling_preparation_draft', actorId: actor.userId, candidateId: family.parent.id,
      sourceRevision: input.parentRevision, draftRevision: draft.draftRevision, at: draft.savedAt, platformWrites: 0 });
    return { changed: true, document, result: { draft: structuredClone(draft), externalRequests: 0, platformWrites: 0 } };
  });
}
