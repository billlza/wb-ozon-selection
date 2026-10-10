import { selectedC2DraftAssets } from './c2-upload-draft.mjs';
import { fingerprintFinalManifest, fingerprintAuthorizedMedia } from './production-authorization-preparation.mjs';
import { sameStoreRef } from './store-binding.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const FIELDS = ['assetId', 'assetRef', 'fileName', 'mediaType', 'assetVersion', 'sha256', 'byteSize', 'width', 'height', 'order'];
export function readC1ImageTextManifest(candidate) {
  const current = candidate?.lifecycleV11?.skuPackage;
  if (!current || !Number.isSafeInteger(candidate.dataRevision)) fail('C1_IMAGE_TEXT_CANDIDATE_INVALID');
  let sourceCandidateRevision = candidate.dataRevision, sourceSkuRevision = current.dataRevision;
  let c2 = current.c2FinalAssets;
  let identity = c2?.productionAuthorizationPreparation?.finalCardInputSnapshot?.identity;
  let variantKey = c2?.productionAuthorizationPreparation?.finalCardInputSnapshot?.variantKey;
  let sourceC1Fingerprint = c2?.productionAuthorizationPreparation?.sourceC1Fingerprint;
  let expectedManifestSha256 = c2?.productionAuthorizationPreparation?.finalManifestSha256;
  const preparation = candidate.lifecycleV11.c1FinalPlanRevisionPreparation;
  if (!c2 && preparation) {
    const history = candidate.lifecycleV11.c1FinalPlanRevisionHistory;
    const entries = Array.isArray(history) ? history.filter(item => item?.preparationId === preparation.historyRef) : [];
    if (entries.length !== 1 || preparation.candidateId !== candidate.id || preparation.skuPackageId !== current.skuPackageId ||
        preparation.supplierSkuId !== current.supplierSkuId || preparation.variantKey !== current.variantKey ||
        preparation.targetC1PlanId !== current.c1ProductPlan?.c1PlanId || preparation.preparationId !== preparation.historyRef) fail('C1_IMAGE_TEXT_LINEAGE_INVALID');
    const entry = entries[0];
    const keys = ['schemaVersion', 'preparationId', 'sourceCandidateRevision', 'sourceSkuRevision', 'sourceIdentity', 'variantKey', 'sourceC1PlanId', 'sourceFinalAssets'];
    const assetKeys = ['assets', 'ownerFinalUploadConfirmation', 'effectiveVideoRequirement', 'sourceC1Fingerprint'];
    if (!object(entry) || Object.keys(entry).length !== keys.length || keys.some(key => !Object.hasOwn(entry, key)) ||
        entry.schemaVersion !== 'c1-final-plan-revision-history-ref-v1' || entry.sourceC1PlanId !== preparation.sourceC1PlanId ||
        !text(entry.sourceC1PlanId) || entry.sourceCandidateRevision !== preparation.sourceCandidateRevision ||
        entry.sourceSkuRevision !== preparation.sourceSkuRevision || !Number.isSafeInteger(entry.sourceCandidateRevision) ||
        entry.sourceCandidateRevision < 0 || entry.sourceCandidateRevision >= candidate.dataRevision ||
        !Number.isSafeInteger(entry.sourceSkuRevision) || entry.sourceSkuRevision < 0 || entry.sourceSkuRevision >= current.dataRevision ||
        !object(entry.sourceFinalAssets) || Object.keys(entry.sourceFinalAssets).length !== assetKeys.length ||
        assetKeys.some(key => !Object.hasOwn(entry.sourceFinalAssets, key)) || !object(entry.sourceFinalAssets.assets) ||
        Object.keys(entry.sourceFinalAssets.assets).length !== 1 || !Object.hasOwn(entry.sourceFinalAssets.assets, 'finalUploads')) fail('C1_IMAGE_TEXT_LINEAGE_INVALID');
    c2 = entry.sourceFinalAssets; identity = entry.sourceIdentity; variantKey = entry.variantKey;
    sourceC1Fingerprint = c2.sourceC1Fingerprint;
    expectedManifestSha256 = preparation.sourceFinalManifestSha256;
    sourceCandidateRevision = entry.sourceCandidateRevision; sourceSkuRevision = entry.sourceSkuRevision;
  }
  const draft = candidate.lifecycleV11.c2UploadDraft, confirmation = c2?.ownerFinalUploadConfirmation;
  if (!identity || identity.candidateId !== candidate.id || identity.skuPackageId !== current.skuPackageId ||
      identity.supplierSkuId !== current.supplierSkuId || identity.platform !== current.g1Identity?.platform ||
      !sameStoreRef(identity.storeRef, current.g1Identity?.storeRef) || !sameStoreRef(identity.storeRef, candidate.storeRef) ||
      variantKey !== current.variantKey) fail('C1_IMAGE_TEXT_SOURCE_IDENTITY_MISMATCH');
  if (confirmation?.status !== 'confirmed' || confirmation.confirmedBy !== 'owner' ||
      !digest(confirmation.approvedManifestSha256) || !text(confirmation.approvedManifestVersion) ||
      !text(confirmation.confirmedAt) || !Array.isArray(confirmation.approvedAssetIds) || !digest(sourceC1Fingerprint) ||
      draft?.candidateId !== candidate.id || draft.skuPackageId !== current.skuPackageId || draft.sourceC1Fingerprint !== sourceC1Fingerprint ||
      confirmation.approvedManifestSha256 !== expectedManifestSha256) fail('C1_IMAGE_TEXT_MANIFEST_UNCONFIRMED');
  const assets = c2.assets.finalUploads, registered = selectedC2DraftAssets(draft);
  if (!Array.isArray(assets) || !assets.length || assets.length > 30 || registered.length !== assets.length ||
      confirmation.approvedAssetIds.length !== assets.length || confirmation.approvedMainImageAssetId !== assets[0].assetId) fail('C1_IMAGE_TEXT_MANIFEST_INVALID');
  const mediaFingerprint = fingerprintAuthorizedMedia(assets.map(asset => asset.assetRef));
  if (mediaFingerprint !== confirmation.approvedAuthorizedMediaFingerprint || fingerprintFinalManifest({
    authorizedMediaFingerprint: mediaFingerprint, effectiveVideoRequirement: c2.effectiveVideoRequirement,
    mainImageAssetId: confirmation.approvedMainImageAssetId, videoDisposition: confirmation.approvedVideoDisposition, assets
  }) !== confirmation.approvedManifestSha256) fail('C1_IMAGE_TEXT_MANIFEST_CHANGED');
  const result = assets.map((asset, index) => {
    const saved = registered[index];
    if (asset.assetId !== confirmation.approvedAssetIds[index] || asset.order !== index + 1 || asset.mediaType !== 'image' ||
        asset.ownerConfirmed !== true || asset.productionEligible !== true || asset.usageAuthorization?.status !== 'owner_authorized_for_listing' ||
        !digest(asset.sha256) || !saved || FIELDS.some(key => saved[key] !== asset[key])) fail('C1_IMAGE_TEXT_ASSET_IDENTITY_INVALID');
    return structuredClone(saved);
  });
  const job = candidate.lifecycleV11.c1ImageTextExtractionV1;
  if (job?.status === 'completed' && job.sourceFinalManifestSha256 === confirmation.approvedManifestSha256) {
    const receipt = assertC1ImageTextEvidence(candidate.lifecycleV11.c1ImageTextEvidenceV1);
    if (job.receiptId !== receipt.receiptId || job.sourceCandidateRevision !== receipt.sourceCandidateRevision ||
        job.sourceSkuRevision !== receipt.sourceSkuRevision || job.sourceSkuRevision !== sourceSkuRevision ||
        !Number.isSafeInteger(job.sourceCandidateRevision) || job.sourceCandidateRevision > sourceCandidateRevision ||
        !Number.isSafeInteger(job.inputCandidateRevision) || job.inputCandidateRevision < job.sourceCandidateRevision ||
        job.intentCandidateRevision !== job.inputCandidateRevision + 1 || !Number.isSafeInteger(job.resultCandidateRevision) ||
        job.resultCandidateRevision <= job.intentCandidateRevision || job.resultCandidateRevision > candidate.dataRevision) fail('C1_IMAGE_TEXT_RECEIPT_MISMATCH');
    sourceCandidateRevision = job.sourceCandidateRevision;
  }
  return { candidateId: candidate.id, skuPackageId: current.skuPackageId, supplierSkuId: current.supplierSkuId, variantKey: current.variantKey,
    sourceCandidateRevision, sourceSkuRevision, sourceFinalManifestVersion: confirmation.approvedManifestVersion,
    sourceFinalManifestSha256: confirmation.approvedManifestSha256,
    sourceConfirmationId: `owner-final-upload:${confirmation.approvedManifestSha256}:${confirmation.confirmedAt}`, assets: result };
}
export function assertC1ImageTextEvidenceMatches(record, manifest) {
  assertC1ImageTextEvidence(record);
  for (const key of ['candidateId', 'skuPackageId', 'supplierSkuId', 'variantKey', 'sourceCandidateRevision', 'sourceSkuRevision',
    'sourceFinalManifestVersion', 'sourceFinalManifestSha256', 'sourceConfirmationId']) {
    if (record[key] !== manifest[key]) fail('C1_IMAGE_TEXT_RECEIPT_MISMATCH');
  }
  if (record.assets.length !== manifest.assets.length || record.assets.some((asset, index) =>
    ['assetId', 'sha256', 'order', 'mediaType'].some(key => asset[key] !== manifest.assets[index][key]))) fail('C1_IMAGE_TEXT_RECEIPT_MISMATCH');
  return record;
}
export function assertC1ImageTextEvidence(record) {
  const keys = ['schemaVersion', 'receiptId', 'role', 'candidateId', 'sourceCandidateRevision', 'skuPackageId', 'supplierSkuId', 'variantKey',
    'sourceSkuRevision', 'observedAt', 'extractorVersion', 'sourceConfirmationId', 'sourceFinalManifestVersion', 'sourceFinalManifestSha256', 'assets', 'status'];
  if (!object(record) || Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(record, key)) ||
      record.schemaVersion !== 'c1-image-text-evidence-v1' || record.role !== 'unverified_language_reference' ||
      !keys.filter(key => !['assets', 'sourceCandidateRevision', 'sourceSkuRevision'].includes(key)).every(key => text(record[key])) ||
      !Number.isSafeInteger(record.sourceCandidateRevision) || record.sourceCandidateRevision < 0 || !Number.isSafeInteger(record.sourceSkuRevision) || record.sourceSkuRevision < 0 ||
      !digest(record.sourceFinalManifestSha256) || !Number.isFinite(Date.parse(record.observedAt)) ||
      !['completed', 'failed'].includes(record.status) || !Array.isArray(record.assets) || record.assets.length < 1 || record.assets.length > 30 || !record.assets.every(object) ||
      new Set(record.assets.map(asset => asset.assetId)).size !== record.assets.length) fail('C1_IMAGE_TEXT_EVIDENCE_INVALID');
  let size = 0;
  record.assets.forEach((asset, index) => {
    const fields = ['assetId', 'sha256', 'order', 'mediaType', 'status', 'text', 'language', 'failureCode'];
    if (!object(asset) || Object.keys(asset).length !== fields.length || fields.some(key => !Object.hasOwn(asset, key)) ||
        !text(asset.assetId) || !digest(asset.sha256) || asset.order !== index + 1 || asset.mediaType !== 'image' ||
        !['extracted', 'no_text', 'failed'].includes(asset.status) || typeof asset.text !== 'string' || asset.text.length > 30000 ||
        asset.language !== 'ru-RU' || (asset.status === 'extracted' ? !text(asset.text) || asset.failureCode !== null :
          asset.status === 'no_text' ? asset.text !== '' || asset.failureCode !== null : asset.text !== '' || !text(asset.failureCode))) fail('C1_IMAGE_TEXT_EVIDENCE_INVALID');
    size += asset.text.length;
  });
  if (size > 150000 || (record.status === 'completed') !== record.assets.every(asset => asset.status !== 'failed')) fail('C1_IMAGE_TEXT_EVIDENCE_INVALID');
  return record;
}
export async function extractC1ImageTextEvidence({ candidate, assetStore, extractor, observedAt, receiptId, signal }) {
  const manifest = readC1ImageTextManifest(candidate);
  const record = { schemaVersion: 'c1-image-text-evidence-v1', receiptId, role: 'unverified_language_reference', ...manifest,
    observedAt, extractorVersion: extractor.version, assets: [], status: 'completed' };
  let failure = null, size = 0;
  for (const asset of manifest.assets) {
    const result = { assetId: asset.assetId, sha256: asset.sha256, order: asset.order, mediaType: 'image', status: 'failed', text: '', language: 'ru-RU', failureCode: failure ? 'NOT_ATTEMPTED_AFTER_FAILURE' : null };
    if (!failure) {
      try {
        const { body } = await assetStore.read(asset, { verifyContent: true });
        const extracted = await extractor.extract({ body, signal });
        if (typeof extracted.text !== 'string' || extracted.text.length > 30000 || extracted.language !== 'ru-RU') fail('C1_IMAGE_TEXT_EXTRACTOR_RESULT_INVALID');
        size += extracted.text.length;
        if (size > 150000) fail('C1_IMAGE_TEXT_CAPACITY_EXCEEDED');
        Object.assign(result, { status: extracted.text.trim() ? 'extracted' : 'no_text', text: extracted.text.trim() ? extracted.text : '', failureCode: null });
      } catch (error) {
        const known = error.code ?? error.extra?.code;
        failure = typeof known === 'string' && /^[A-Za-z0-9_]+$/.test(known) ? known : 'C1_IMAGE_TEXT_INTERNAL_ERROR';
        result.failureCode = failure; record.status = 'failed';
      }
    }
    record.assets.push(result);
  }
  return assertC1ImageTextEvidence(record);
}
