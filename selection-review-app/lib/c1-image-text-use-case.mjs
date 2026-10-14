import { randomUUID } from 'node:crypto';
import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { readC1ImageTextManifest, extractC1ImageTextEvidence, assertC1ImageTextEvidenceMatches } from './c1-image-text-evidence.mjs';
const fail = code => { const error = new Error(code); error.code = code; throw error; };
export function createC1ImageTextUseCase({ repository, runtimeMode, assetStore, extractor, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (["central_test", "central_production"].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  const processRunId = randomUUID();
  let running = false, activeController = null, activeCompletion = null;
  return Object.freeze({ async extract({ actor, input }) {
    authorizeOperation({ actor, requiredRoles: ['owner'] });
    if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') fail('C1_IMAGE_TEXT_OWNER_REQUIRED');
    if (!input || Object.keys(input).sort().join(',') !== 'candidateId,expectedRevision' || typeof input.candidateId !== 'string' || !Number.isSafeInteger(input.expectedRevision)) fail('C1_IMAGE_TEXT_INPUT_INVALID');
    if (!extractor) fail('C1_IMAGE_TEXT_SERVICE_UNAVAILABLE');
    if (running) fail('C1_IMAGE_TEXT_BUSY');
    running = true;
    activeController = new AbortController();
    let settled;
    activeCompletion = new Promise(resolve => { settled = resolve; });
    try {
      const snapshot = await repository.readSnapshot();
      const candidate = snapshot.candidates.find(item => item.id === input.candidateId);
      if (!candidate || candidate.dataRevision !== input.expectedRevision) fail('C1_IMAGE_TEXT_REVISION_CONFLICT');
      const manifest = readC1ImageTextManifest(candidate);
      const previous = candidate.lifecycleV11.c1ImageTextExtractionV1;
      if (previous?.sourceFinalManifestSha256 === manifest.sourceFinalManifestSha256) {
        if (previous.status === 'completed') {
          const receipt = assertC1ImageTextEvidenceMatches(candidate.lifecycleV11.c1ImageTextEvidenceV1, manifest);
          if (receipt.receiptId !== previous.receiptId || receipt.sourceFinalManifestSha256 !== manifest.sourceFinalManifestSha256) fail('C1_IMAGE_TEXT_RECEIPT_MISMATCH');
          return { status: 'already_current', candidate, result: previous };
        }
        fail(previous.status === 'running' && previous.processRunId !== processRunId ? 'C1_IMAGE_TEXT_INTERRUPTED_REVIEW_REQUIRED' : 'C1_IMAGE_TEXT_EXISTING_JOB_REVIEW_REQUIRED');
      }
      const jobId = `image-text:${candidate.id}:${input.expectedRevision}`;
      const receiptId = `${jobId}:receipt`;
      const source = { jobId, processRunId, inputCandidateRevision: input.expectedRevision, sourceCandidateRevision: manifest.sourceCandidateRevision, sourceSkuRevision: manifest.sourceSkuRevision,
        sourceFinalManifestSha256: manifest.sourceFinalManifestSha256, receiptId, status: 'running' };
      const started = await executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'], action: 'prepare_c1_image_text',
        candidateId: candidate.id, skuPackageId: manifest.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: `${jobId}:intent`, inputFingerprint: fingerprintCanonicalRecord(manifest), auditEventId: `${jobId}:intent-audit`, serverClock,
        mutate: ({ candidate: latest, observedAt }) => {
          const next = structuredClone(latest);
          if (fingerprintCanonicalRecord(readC1ImageTextManifest(latest)) !== fingerprintCanonicalRecord(manifest)) fail('C1_IMAGE_TEXT_MANIFEST_CHANGED');
          next.lifecycleV11.c1ImageTextExtractionV1 = { ...source, startedAt: observedAt };
          return { candidate: next, result: { status: 'running', jobId, externalCalls: 0, paidCalls: 0 } };
        } });
      const receipt = await extractC1ImageTextEvidence({ candidate, assetStore, extractor,
        observedAt: new Date(serverClock()).toISOString(), receiptId, signal: activeController.signal });
      const latest = (await repository.readSnapshot()).candidates.find(item => item.id === candidate.id);
      if (!latest || latest.lifecycleV11.c1ImageTextExtractionV1?.jobId !== jobId) fail('C1_IMAGE_TEXT_JOB_CHANGED');
      const latestManifest = readC1ImageTextManifest(latest);
      if (latestManifest.sourceFinalManifestSha256 !== manifest.sourceFinalManifestSha256) fail('C1_IMAGE_TEXT_MANIFEST_CHANGED');
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'], action: 'settle_c1_image_text',
        candidateId: candidate.id, skuPackageId: manifest.skuPackageId, expectedRevision: latest.dataRevision,
        idempotencyKey: `${jobId}:receipt`, inputFingerprint: fingerprintCanonicalRecord(receipt), auditEventId: `${jobId}:receipt-audit`, serverClock,
        mutate: ({ candidate: current, observedAt }) => {
          if (current.lifecycleV11.c1ImageTextExtractionV1?.jobId !== jobId || readC1ImageTextManifest(current).sourceFinalManifestSha256 !== manifest.sourceFinalManifestSha256) fail('C1_IMAGE_TEXT_JOB_CHANGED');
          const next = structuredClone(current);
          const existing = next.lifecycleV11.c1ImageTextEvidenceV1;
          if (existing) next.lifecycleV11.c1ImageTextEvidenceHistoryV1 = [...(next.lifecycleV11.c1ImageTextEvidenceHistoryV1 ?? []), existing];
          next.lifecycleV11.c1ImageTextEvidenceV1 = receipt;
          next.lifecycleV11.c1ImageTextExtractionV1 = { ...next.lifecycleV11.c1ImageTextExtractionV1, status: receipt.status, settledAt: observedAt,
            resultCandidateRevision: current.dataRevision + 1, intentCandidateRevision: started.candidate.dataRevision };
          return { candidate: next, result: { status: receipt.status, jobId, receiptId, externalCalls: 0, paidCalls: 0 } };
        } });
    } finally { running = false; activeController = null; settled(); activeCompletion = null; }
  }, async stop() { activeController?.abort(); if (activeCompletion) await activeCompletion; } });
}
