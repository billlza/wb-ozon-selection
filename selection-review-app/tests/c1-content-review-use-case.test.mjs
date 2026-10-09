import test from "node:test";
import assert from "node:assert/strict";
import { createC1PaidFormalFixture, c1DraftPaidReceipt } from "./fixtures/c1-draft-source-fixture.mjs";
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from "./fixtures/c1-local-draft-source-fixture.mjs";
import { prepareC1LocalDraftSource } from "../lib/c1-local-draft-source.mjs";
import { prepareCurrentC1AiDraftRequest } from "../lib/c1-ai-draft-request-source.mjs";
import { authorizedExecution } from "./fixtures/c1-ai-draft-fixture.mjs";
import { createC1DraftSoftwareUseCase, prepareC1DraftSoftwareExecution } from "../lib/c1-draft-software-use-case.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { mergeC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { readCompletedC1AiSoftwareJobResult } from "../lib/software-job-contract.mjs";
import { createC1ContentReviewUseCase, buildC1ContentReviewView, fingerprintC1ReviewContent } from "../lib/c1-content-review-use-case.mjs";

async function fixture({ sourceCandidate = null, historyRecord = null } = {}) {
  const preparedCandidate = sourceCandidate === null ? createSavedLocalPreparationCandidate() : structuredClone(sourceCandidate);
  if (sourceCandidate !== null) {
    const { produceC1LocalPreparation } = await import('../lib/c1-keyword-planning-local-material.mjs');
    const production = produceC1LocalPreparation({ candidate: preparedCandidate, expectedRevision: preparedCandidate.dataRevision, producedAt: LOCAL_DRAFT_AT });
    assert.equal(production.status, 'ready');
    preparedCandidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1 = structuredClone(production.material);
    preparedCandidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1 = structuredClone(production.production);
    preparedCandidate.dataRevision += 1;
  }
  const prepared = prepareC1LocalDraftSource({ candidate: preparedCandidate, preparedAt: LOCAL_DRAFT_AT });
  preparedCandidate.lifecycleV11.skuPackage = structuredClone(prepared.skuPackage);
  preparedCandidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(prepared.sourceEvidence);
  const request = prepareCurrentC1AiDraftRequest(preparedCandidate, LOCAL_DRAFT_AT);
  preparedCandidate.lifecycleV11.c1AiDraftRequestV1 = structuredClone(request);
  preparedCandidate.dataRevision += 1;
  const execution = authorizedExecution(request, preparedCandidate.dataRevision + 1);
  const formal = { candidate: preparedCandidate, request, at: LOCAL_DRAFT_AT, authorizedExecution: execution,
    receipt: c1DraftPaidReceipt({ request, authorizedExecution: execution }, LOCAL_DRAFT_AT),
    executionBinding: { provider: request.provider, modelVersion: `gpt-5.6-${request.provider}`, credentialAlias: "gateway-alias:formal", allowedWorkerIds: ["worker-c1-draft"] } };
  const at = formal.at;
  const owner = createActorContext({ userId: "owner-content", sessionId: "session-content", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: at });
  const worker = createActorContext({ userId: "worker-c1-draft", sessionId: "session-worker", actorType: "worker",
    roles: ["operator"], source: "local_worker", authenticatedAt: at });
  const enqueue = { request: formal.request, expectedRevision: formal.candidate.dataRevision,
    authorizationRef: formal.authorizedExecution.authorizationRef.authorizationId, credentialAlias: "gateway-alias:formal",
    jobId: formal.receipt.softwareJobId, idempotencyKey: "content-fixture-enqueue", auditEventId: "content-fixture-enqueue-audit" };
  const { scopeBinding } = prepareC1DraftSoftwareExecution({ candidate: formal.candidate, ...enqueue,
    ownerUserId: owner.userId, requestedByUserId: owner.userId }).jobInput;
  const repository = createMemoryBusinessStateRepository({ candidates: [formal.candidate], c1FinalPlanRevisionHistoryRecords: historyRecord ? [historyRecord] : [], runtime: { softwareJobs: [],
    softwareJobAuthorizationRecords: [{ schemaVersion: "software-job-authorization-record-v1",
      authorizationId: enqueue.authorizationRef, authorizationType: "paid_ai_draft", action: "c1_ai_draft", status: "active",
      scopeBinding, authorizedByUserId: owner.userId, authorizedAt: at, expiresAt: null,
      maxUses: 1, useCount: 0, consumedByJobId: null, consumedAt: null }],
    softwareJobCredentialBindings: [{ schemaVersion: "software-job-credential-binding-v1", bindingId: "content-fixture-binding",
      credentialAlias: enqueue.credentialAlias, status: "active", provider: formal.request.provider, sideEffectScope: "c1_ai_draft",
      scopeBinding, allowedWorkerIds: [worker.userId], redaction: "credential_alias_only", boundAt: at, expiresAt: null }] } });
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  workerRegistry.register({ workerId: worker.userId, capabilities: ["ai-draft-gateway"], version: "1", observedAt: at });
  const draft = createC1DraftSoftwareUseCase({ repository, runtimeMode: "local_development", serverClock: () => at,
    workerRegistry, executionBinding: formal.executionBinding,
    requestGateway: async ({ request }) => ({ status: "receipt_ready", jobId: formal.receipt.gatewayJobId, request, receipt: formal.receipt }) });
  await draft.enqueue({ actor: owner, input: enqueue });
  await draft.run({ actor: worker, input: { jobId: enqueue.jobId, leaseId: "content-fixture-lease", leaseDurationMs: 1000 } });
  // Unit fixture: actual admitted/settled receipt, applied through the domain merger, awaiting human review.
  await repository.transact(document => {
    const candidate = document.candidates[0];
    const job = document.runtime.softwareJobs[0];
    const saved = readCompletedC1AiSoftwareJobResult(job);
    candidate.lifecycleV11.skuPackage = structuredClone(mergeC1AiDraftReceipt({ skuPackage: candidate.lifecycleV11.skuPackage,
      ...saved, mergedAt: at }).skuPackage);
    candidate.dataRevision += 1;
    job.resultEnvelope.applicationDisposition = "applied";
    return { changed: true, document, result: null };
  });
  const candidate = (await repository.readSnapshot()).candidates[0];
  const input = { candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    contentFingerprint: fingerprintC1ReviewContent(candidate.lifecycleV11.skuPackage), confirmed: true,
    idempotencyKey: "confirm-content:1", auditEventId: "confirm-content:audit:1" };
  const useCase = createC1ContentReviewUseCase({ repository, runtimeMode: "local_development", serverClock: () => at });
  return { repository, owner, candidate, input, useCase };
}

test("owner confirmation atomically binds saved content and creates C2; concurrent identical retries replay", async () => {
  const f = await fixture();
  assert.equal(buildC1ContentReviewView(f.candidate).status, "awaiting_confirmation");
  const results = await Promise.all([f.useCase.confirm({ actor: f.owner, input: f.input }), f.useCase.confirm({ actor: f.owner, input: f.input })]);
  assert.equal(results.filter(result => result.status === "idempotent_replay").length, 1);
  const document = await f.repository.readSnapshot();
  const saved = document.candidates[0];
  const sku = saved.lifecycleV11.skuPackage;
  assert.equal(saved.dataRevision, f.candidate.dataRevision + 1);
  assert.equal(sku.businessPhase, "C2");
  assert.equal(sku.ownerAction, "provide_final_assets");
  assert.equal(saved.lifecycleV11.c1ContentReviewV1.confirmedByUserId, f.owner.userId);
  assert.equal(saved.lifecycleV11.c1ContentReviewV1.contentFingerprint, f.input.contentFingerprint);
  assert.equal(buildC1ContentReviewView(saved).status, "confirmed");
  assert.deepEqual(sku.c1ProductPlan, f.candidate.lifecycleV11.skuPackage.c1ProductPlan);
  assert.deepEqual(sku.profitModels, f.candidate.lifecycleV11.skuPackage.profitModels);
  assert.deepEqual(sku.selectedSupplySnapshot, f.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot);
  assert.equal(sku.productionAuthorization, null);
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads, []);
  assert.equal(document.runtime.softwareJobs.length, 1);
  assert.equal(document.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(document.runtime.operationAudit.filter(event => event.action === "c1_confirm_saved_content").length, 1);
});

test("stale revision, stale content, replacement text and false confirmation leave all state unchanged", async () => {
  const f = await fixture();
  const before = await f.repository.readSnapshot();
  for (const [input, code] of [
    [{ ...f.input, expectedRevision: f.input.expectedRevision - 1 }, "BUSINESS_MUTATION_REVISION_CONFLICT"],
    [{ ...f.input, contentFingerprint: "0".repeat(64) }, "C1_CONTENT_REVIEW_CONTENT_CONFLICT"],
    [{ ...f.input, title: "replacement" }, "C1_CONTENT_REVIEW_INPUT_INVALID"],
    [{ ...f.input, confirmed: false }, "C1_CONTENT_REVIEW_INPUT_INVALID"]
  ]) await assert.rejects(f.useCase.confirm({ actor: f.owner, input }), error => error.code === code);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test("authenticated human owner is required and an idempotency key cannot transfer confirmation to another owner", async () => {
  const f = await fixture();
  for (const [changes, code] of [
    [{ roles: ["operator"] }, "RUNTIME_OPERATION_FORBIDDEN"],
    [{ source: "selection_review_state_machine" }, "C1_CONTENT_REVIEW_AUTHENTICATED_OWNER_REQUIRED"],
    [{ actorType: "worker" }, "C1_CONTENT_REVIEW_AUTHENTICATED_OWNER_REQUIRED"]
  ]) await assert.rejects(f.useCase.confirm({ actor: { ...f.owner, ...changes }, input: f.input }), error => error.code === code);
  await f.useCase.confirm({ actor: f.owner, input: f.input });
  await assert.rejects(f.useCase.confirm({ actor: { ...f.owner, userId: "another-owner" }, input: f.input }),
    error => error.code === "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT");
});

test("missing applied receipt and tampered saved draft cannot create C2 even with a refreshed display fingerprint", async () => {
  for (const drift of ["receipt", "content"]) {
    const f = await fixture();
    await f.repository.transact(document => {
      if (drift === "receipt") document.runtime.softwareJobs = [];
      else document.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.seoTitleDraft.text += " changed";
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    const input = { ...f.input, contentFingerprint: fingerprintC1ReviewContent(before.candidates[0].lifecycleV11.skuPackage) };
    await assert.rejects(f.useCase.confirm({ actor: f.owner, input }), drift === "receipt"
      ? /C1_CONTENT_REVIEW_APPLIED_RECEIPT_REQUIRED/ : /C1_AI_REPLAY_DRIFT_DETECTED/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test("reading applied receipts requires explicit option; option retains result integrity validation", async () => {
  const f = await fixture();
  const job = (await f.repository.readSnapshot()).runtime.softwareJobs[0];
  assert.throws(() => readCompletedC1AiSoftwareJobResult(job), /SOFTWARE_JOB_C1_AI_SAVED_RESULT_REQUIRED/);
  assert.equal(readCompletedC1AiSoftwareJobResult(job, { allowApplied: true }).receipt.receiptId,
    f.candidate.lifecycleV11.skuPackage.c1ProductPlan.seoEvidenceLayer.aiReceiptId);
  const changed = structuredClone(job);
  changed.resultEnvelope.payload.receipt.output.title.text += " changed";
  assert.throws(() => readCompletedC1AiSoftwareJobResult(changed, { allowApplied: true }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => readCompletedC1AiSoftwareJobResult(job, { allowApplied: "yes" }), /SOFTWARE_JOB_C1_AI_READ_OPTIONS_INVALID/);
});

test("view distinguishes missing content and missing historical confirmation without inventing approval", async () => {
  assert.equal(buildC1ContentReviewView(null).status, "invalid");
  assert.equal(buildC1ContentReviewView({}).status, "not_ready");
  const f = await fixture();
  const old = structuredClone(f.candidate);
  old.lifecycleV11.skuPackage.businessPhase = "C2";
  assert.equal(buildC1ContentReviewView(old).status, "confirmation_missing");
  assert.equal(buildC1ContentReviewView(old).canConfirm, false);
});

test("historical SEO without local review enrollment is explicit non-applicable even when G1 is absent", async () => {
  const formal = createC1PaidFormalFixture();
  const historical = structuredClone(formal.candidate);
  historical.lifecycleV11.skuPackage = structuredClone(mergeC1AiDraftReceipt({ skuPackage: historical.lifecycleV11.skuPackage,
    request: formal.request, receipt: formal.receipt, settledExecution: formal.settledExecution, mergedAt: formal.at }).skuPackage);
  const expected = { status: "not_ready", reason: "C1_CONTENT_REVIEW_WORKFLOW_NOT_APPLICABLE", canConfirm: false };
  assert.deepEqual(buildC1ContentReviewView(historical), expected);
  delete historical.lifecycleV11.skuPackage.g1Identity;
  delete historical.lifecycleV11.c1AiDraftRequestV1;
  const before = structuredClone(historical);
  assert.deepEqual(buildC1ContentReviewView(historical), expected);
  assert.deepEqual(historical, before);
  const repository = createMemoryBusinessStateRepository({ candidates: [historical] });
  const useCase = createC1ContentReviewUseCase({ repository, runtimeMode: "local_development", serverClock: () => formal.at });
  const owner = createActorContext({ userId: "owner-legacy", sessionId: "session-legacy", actorType: "human", roles: ["owner"],
    source: "authenticated_identity_provider", authenticatedAt: formal.at });
  const stateBefore = await repository.readSnapshot();
  await assert.rejects(useCase.confirm({ actor: owner, input: { candidateId: historical.id, expectedRevision: historical.dataRevision,
    contentFingerprint: "0".repeat(64), confirmed: true, idempotencyKey: "legacy-review", auditEventId: "legacy-review-audit" } }),
    error => error.code === "C1_CONTENT_REVIEW_WORKFLOW_NOT_APPLICABLE");
  assert.deepEqual(await repository.readSnapshot(), stateBefore);
});

test("damaged new enrollment and canonical identity remain explicit errors, never historical defaults", async () => {
  const f = await fixture();
  for (const change of [
    c => { delete c.lifecycleV11.c1LocalDraftSourceV1; },
    c => { delete c.lifecycleV11.c1AiDraftRequestV1; },
    c => { c.lifecycleV11.c1LocalDraftSourceV1 = null; },
    c => { c.lifecycleV11.c1LocalDraftSourceV1.materialFingerprint = "0".repeat(64); },
    c => { c.lifecycleV11.c1ContentReviewV1 = null; },
    c => { delete c.lifecycleV11.skuPackage.g1Identity; }
  ]) {
    const damaged = structuredClone(f.candidate); change(damaged);
    const before = structuredClone(damaged);
    assert.throws(() => buildC1ContentReviewView(damaged), /C1_CONTENT_REVIEW_(SOURCE|RECORD)_INVALID|C1_G1_IDENTITY_REQUIRED/);
    assert.deepEqual(damaged, before);
  }
  const isolatedReviewMarker = { id: "historical", lifecycleV11: { c1ContentReviewV1: null } };
  assert.throws(() => buildC1ContentReviewView(isolatedReviewMarker), /C1_CONTENT_REVIEW_SOURCE_INVALID/);
});


test("new-version content confirmation reuses saved assets through the normal atomic use case", async () => {
  const { finalAssets, ownerDecision } = await import('./helpers/c2-software-fixture.mjs');
  const { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } = await import('../lib/c2-software-orchestrator.mjs');
  const { createFinalProductPlanConfirmationCard } = await import('../lib/final-product-plan-confirmation-card.mjs');
  const { prepareC1FinalPlanRevision } = await import('../lib/c1-final-plan-revision-preparation.mjs');
  const first = await fixture();
  await first.useCase.confirm({ actor: first.owner, input: first.input });
  const original = (await first.repository.readSnapshot()).candidates[0];
  const oldSku = original.lifecycleV11.skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: oldSku, expectedDataRevision: oldSku.dataRevision,
    finalUploadAssets: finalAssets(), preparedAt: LOCAL_DRAFT_AT });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: oldSku, expectedDataRevision: oldSku.dataRevision,
    finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: LOCAL_DRAFT_AT });
  original.lifecycleV11.skuPackage = structuredClone(createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: LOCAL_DRAFT_AT }).skuPackage);
  original.targetPlatform = 'ozon';
  delete original.sourceCapture;
  const revision = prepareC1FinalPlanRevision({ candidate: original, expectedRevision: original.dataRevision, preparedAt: LOCAL_DRAFT_AT });
  const f = await fixture({ sourceCandidate: revision.candidate, historyRecord: revision.historyRecord });
  const before = await f.repository.readSnapshot();
  for (const records of [[], [revision.historyRecord, revision.historyRecord]]) {
    const invalidDocument = { ...structuredClone(before), c1FinalPlanRevisionHistoryRecords: structuredClone(records) };
    const isolated = createMemoryBusinessStateRepository(invalidDocument);
    const invalidUseCase = createC1ContentReviewUseCase({ repository: isolated, runtimeMode: 'local_development', serverClock: () => LOCAL_DRAFT_AT });
    await assert.rejects(invalidUseCase.confirm({ actor: f.owner, input: f.input }), /HISTORY/);
    assert.deepEqual(await isolated.readSnapshot(), invalidDocument);
  }
  const result = await f.useCase.confirm({ actor: f.owner, input: f.input });
  assert.equal(result.result.finalCardCreated, true);
  const saved = (await f.repository.readSnapshot()).candidates[0];
  assert.equal(saved.dataRevision, before.candidates[0].dataRevision + 1);
  assert.equal(saved.lifecycleV11.skuPackage.c2FinalAssets.status, 'completed');
  assert.equal(saved.lifecycleV11.skuPackage.productionConfirmationCard.status, 'awaiting_owner_business_confirmation');
  assert.deepEqual(saved.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation,
    original.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation);
  assert.deepEqual((await f.repository.readSnapshot()).c1FinalPlanRevisionHistoryRecords, before.c1FinalPlanRevisionHistoryRecords);
  assert.equal(saved.lifecycleV11.skuPackage.productionAuthorization, null);
  const retry = await f.useCase.confirm({ actor: f.owner, input: f.input });
  assert.equal(retry.status, 'idempotent_replay');
});
