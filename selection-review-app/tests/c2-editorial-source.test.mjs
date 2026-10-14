import test from "node:test";
import assert from "node:assert/strict";
import { createFormalC1DraftFixture, createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { assessC1DraftEditorialCorrection } from "../lib/c1-draft-recovery-assessment.mjs";
import { applyC1EditorialReview, assertC1EditorialSource, createC1EditorialDraftReference } from "../lib/c1-editorial-review-contract.mjs";
import { prepareC1DraftSoftwareExecution } from "../lib/c1-draft-software-use-case.mjs";
import { createSoftwareJobEnvelope, claimSoftwareJobLease, bindSoftwareJobAdmissionDecision,
  markSoftwareJobExternalRequestStarted, recordC1GatewayAcceptance, createSoftwareJobResultEnvelope,
  settleSoftwareJob } from "../lib/software-job-contract.mjs";
import { fingerprintCanonicalRecord, assertNoProductionSecrets } from "../lib/production-contract-primitives.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { normalizeC1CanonicalHandoffContract, validateC2AssetLifecycle, fingerprintC2FinalCardInputSnapshot,
  fingerprintC2AuthorizationPreparation } from "../lib/c2-asset-lifecycle.mjs";
import { createC2SoftwareContainer, prepareC2SoftwareInput, prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from "../lib/c2-software-orchestrator.mjs";
import { finalAssets, ownerDecision } from "./helpers/c2-software-fixture.mjs";
import { validateC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { createFinalProductPlanConfirmationCard, validateFinalProductPlanConfirmationCard } from "../lib/final-product-plan-confirmation-card.mjs";

function fixture(options = {}) {
  const formal = createFormalC1DraftFixture({ candidateId: "candidate:editorial:c2", supplierSkuId: "EDITORIAL-BLUE",
    variantKey: "颜色:蓝色", productName: "水槽收纳架", categoryName: "Органайзер для раковины", material: "silicone", ...options });
  const request = structuredClone(formal.request), receipt = structuredClone(formal.receipt), at = formal.at;
  const skuPackage = structuredClone(formal.checked.skuPackage);
  const workerId = "worker:editorial", leaseId = "lease:editorial";
  const { jobInput } = prepareC1DraftSoftwareExecution({ candidate: formal.candidate, request,
    expectedRevision: formal.candidate.dataRevision, authorizationRef: "authorization:c1-ai-draft:EDITORIAL",
    credentialAlias: "gateway:editorial", jobId: receipt.softwareJobId, ownerUserId: "owner:editorial",
    requestedByUserId: "owner:editorial", idempotencyKey: "enqueue:editorial" });
  let sourceJob = createSoftwareJobEnvelope({ ...jobInput, createdAt: at });
  sourceJob = claimSoftwareJobLease({ job: sourceJob, worker: { workerId, version: "1", status: "online", capabilities: ["ai-draft-gateway"] },
    leaseId, serverTime: at, leaseDurationMs: 1000 });
  sourceJob = bindSoftwareJobAdmissionDecision(sourceJob, { schemaVersion: "software-job-admission-v1", jobId: sourceJob.jobId,
    candidateId: sourceJob.candidateId, skuPackageId: sourceJob.skuPackageId, revision: sourceJob.revision, jobType: sourceJob.jobType,
    authorizationRef: sourceJob.scopeBinding.authorizationRef, credentialAlias: sourceJob.scopeBinding.credentialAlias,
    authorizationFingerprint: "a".repeat(64), credentialBindingFingerprint: "b".repeat(64) });
  sourceJob = markSoftwareJobExternalRequestStarted({ job: sourceJob, workerId, leaseId, externalRequestRef: "external:editorial", serverTime: at });
  sourceJob = recordC1GatewayAcceptance({ job: sourceJob, workerId, leaseId, requestFingerprint: request.requestFingerprint,
    gatewayJobId: receipt.gatewayJobId, serverTime: at }).job;
  receipt.output.title.factRefs = request.verifiedFacts.find(fact => fact.factPath === "platformCategory.categoryName").evidenceRefs;
  receipt.outputFingerprint = fingerprintCanonicalRecord(receipt.output);
  const resultEnvelope = createSoftwareJobResultEnvelope({ job: sourceJob, resultRef: receipt.gatewayJobId, payloadKind: "c1_ai_draft",
    recordedAt: at, payload: { schemaVersion: "c1-ai-draft-software-failure-v1", request,
      accounting: receipt.accounting, errorCode: "C1_AI_GATEWAY_RECEIPT_REJECTED" } });
  sourceJob = settleSoftwareJob({ job: sourceJob, workerId, leaseId, status: "failed", externalRequestState: "succeeded",
    failureClass: "C1_AI_GATEWAY_RECEIPT_REJECTED", resultRef: receipt.gatewayJobId, resultEnvelope, serverTime: at });
  const correctionPlan = { schemaVersion: "c1-draft-editorial-plan-v1", requestFingerprint: request.requestFingerprint,
    sourceOutputFingerprint: receipt.outputFingerprint, sourceSoftwareJobId: sourceJob.jobId,
    items: [["output.title", receipt.output.title], ["output.description", receipt.output.description],
      ...["bulletPoints", "searchKeywords"].flatMap(field => receipt.output[field].map((item, i) => [`output.${field}[${i}]`, item]))]
      .map(([path, item]) => ({ path, originalText: item.text, originalFactRefs: structuredClone(item.factRefs),
        originalAssertions: structuredClone(item.assertions), correctedText: item.text,
        factPaths: item.assertions.map(assertion => assertion.factPath), explanation: "逐句核验原有商品事实和引用。",
        sourceRefs: [...new Set(item.assertions.flatMap(assertion => request.verifiedFacts.find(fact => fact.factPath === assertion.factPath).evidenceRefs))] })) };
  const bundle = { request, receipt, sourceJob, correctionPlan };
  const result = assessC1DraftEditorialCorrection(bundle);
  assert.equal(result.status, "editorial_proposed", JSON.stringify(result.reasons));
  const editedVersion = result.editedVersion;
  const ownerConfirmation = { schemaVersion: "c1-editorial-owner-confirmation-v1", candidateId: sourceJob.candidateId,
    skuPackageId: sourceJob.skuPackageId, sourceCandidateRevision: sourceJob.revision, resultCandidateRevision: sourceJob.revision + 1,
    sourceSkuRevision: skuPackage.dataRevision, resultSkuRevision: skuPackage.dataRevision + 1,
    editorialVersionId: editedVersion.editorialVersionId, outputFingerprint: editedVersion.outputFingerprint,
    confirmedByUserId: "owner:editorial", actorType: "human", role: "owner", source: "authenticated_identity_provider",
    confirmedAt: at, productionAuthorizationGranted: false };
  return structuredClone({ skuPackage, bundle, editedVersion, ownerConfirmation, at });
}
const apply = f => applyC1EditorialReview(f).skuPackage;
const start = skuPackage => createC2SoftwareContainer({ skuPackage, expectedDataRevision: skuPackage.dataRevision,
  assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: "2026-08-12T13:00:00.000Z" });

test("owner-confirmed editorial content enters the existing C2 container without replacing the rejected receipt or authorizing production", () => {
  const f = fixture(), before = structuredClone(f), sku = apply(f);
  assert.deepEqual(f, before);
  assert.equal(sku.dataRevision, f.skuPackage.dataRevision + 1);
  assert.equal(sku.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted, false);
  assert.equal(Object.hasOwn(sku.c1ProductPlan.draftOnlySeo, "providerJobRef"), false);
  assert.equal(Object.hasOwn(sku.c1ProductPlan.seoEvidenceLayer, "aiReceiptId"), false);
  assert.equal(Object.hasOwn(sku.c1ProductPlan.draftOnlySeo.editorialSource, "editedVersion"), false);
  assert.equal(validateC1AiDraftReceipt({ request: f.bundle.request, receipt: f.editedVersion }).valid, false);
  const c2 = start(sku);
  assert.equal(c2.skuPackage.businessPhase, "C2");
  assert.equal(c2.skuPackage.productionAuthorization, null);
  assert.deepEqual(c2.c2AssetLifecycle.assets, { collected: [], aiDrafts: [], finalUploads: [] });
  assert.deepEqual(c2.skuPackage.profitModels, f.skuPackage.profitModels);
  assert.equal(c2.skuPackage.c1ProductPlan.draftOnlySeo.editorialSource.bundle.sourceJob.status, "failed");
  assert.equal(validateC2AssetLifecycle(c2.c2AssetLifecycle).valid, true);
});

test("a proposal alone, non-owner confirmation, wrong revision or mismatched approval can never enter C2", () => {
  for (const mutate of [f => { f.ownerConfirmation = null; }, f => { f.ownerConfirmation.role = "employee"; },
    f => { f.ownerConfirmation.actorType = "software"; }, f => { f.ownerConfirmation.source = "client"; },
    f => { f.ownerConfirmation.outputFingerprint = "f".repeat(64); }, f => { f.ownerConfirmation.editorialVersionId = "editorial:other"; },
    f => { f.ownerConfirmation.resultSkuRevision += 1; }, f => { f.ownerConfirmation.sourceCandidateRevision -= 1; },
    f => { f.ownerConfirmation.productionAuthorizationGranted = true; }, f => { f.ownerConfirmation.confirmedAt = "2026-08-10T00:00:00.000Z"; }]) {
    const f = fixture(); mutate(f); assert.throws(() => apply(f), /C1_EDITORIAL_/);
  }
});

test("frozen source rejects identity, failed-job provenance, receipt, plan and edited-version tampering", () => {
  for (const mutate of [f => { f.bundle.sourceJob.status = "completed"; }, f => { f.bundle.sourceJob.attempt = 2; },
    f => { f.bundle.sourceJob.scopeBinding.identity.storeRef.stableStoreId = "other"; },
    f => { f.bundle.sourceJob.admissionDecision.authorizationRef = "authorization:c1-ai-draft:OTHER"; },
    f => { f.bundle.receipt.softwareJobId = "job:other"; }, f => { f.bundle.receipt.output.title.text = "changed"; },
    f => { f.bundle.correctionPlan.items[0].originalText = "stale"; }, f => { f.editedVersion.output.title.text = "changed"; },
    f => { f.skuPackage.dataRevision += 1; }, f => { f.skuPackage.variantKey = "other"; }]) {
    const f = fixture(); mutate(f); assert.throws(() => apply(f), /C1_(EDITORIAL|AI)_/);
  }
});

test("C2 revalidates the displayed content and frozen facts, rather than accepting a sourceType flag", () => {
  for (const mutate of [s => { s.c1ProductPlan.seoTitleDraft.text = "another product"; },
    s => { s.c1ProductPlan.descriptionDraft.assertions = []; }, s => { s.c1ProductPlan.seoEvidenceLayer.outputFingerprint = "a".repeat(64); },
    s => { s.c1ProductPlan.productAttributes.material.value = "invented"; },
    s => { s.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted = true; },
    s => { s.c1ProductPlan.draftOnlySeo.providerJobRef = { terminalStatus: "completed" }; },
    s => { s.c1ProductPlan.draftOnlySeo.editorialSource.bundle.sourceJob.status = "completed"; },
    s => { s.c1ProductPlan.draftOnlySeo.editorialSource.ownerConfirmation = true; }]) {
    const sku = apply(fixture()); mutate(sku); assert.throws(() => normalizeC1CanonicalHandoffContract(sku), /C1_(EDITORIAL|AI)_/);
  }
  const f = fixture(), sku = apply(f);
  assert.throws(() => assertC1EditorialSource({ draftOnlySeo: sku.c1ProductPlan.draftOnlySeo,
    identity: { ...sku.g1Identity, candidateId: "other" }, resultSkuRevision: sku.dataRevision }), /SOURCE_SCOPE_CONFLICT/);
});

test("the provider branch retains its completed-receipt gate", () => {
  const formal = createFormalC1C2Fixture();
  assert.doesNotThrow(() => normalizeC1CanonicalHandoffContract(formal.merged.skuPackage));
  const rejected = structuredClone(formal.merged.skuPackage);
  rejected.c1ProductPlan.draftOnlySeo.providerJobRef.terminalStatus = "failed";
  assert.throws(() => normalizeC1CanonicalHandoffContract(rejected), /C2_C1_FORMAL_PROVIDER_REQUIRED/);
});

test("final-asset confirmation freezes the editorial source and revalidates it after readback", () => {
  const f = fixture(), initialized = start(apply(f)), at = "2026-08-12T13:01:00.000Z";
  const manifest = prepareC2FinalUploadManifest({ skuPackage: initialized.skuPackage, expectedDataRevision: initialized.skuPackage.dataRevision,
    finalUploadAssets: finalAssets(), preparedAt: at });
  const completed = confirmC2SoftwareFinalUploads({ skuPackage: initialized.skuPackage, expectedDataRevision: initialized.skuPackage.dataRevision,
    finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: at });
  assert.equal(validateC2AssetLifecycle(completed.c2AssetLifecycle).valid, true);
  const tampered = structuredClone(completed.c2AssetLifecycle), p = tampered.productionAuthorizationPreparation;
  for (const draft of [p.frozenC1Handoff.draftOnlySeo, p.finalCardInputSnapshot.canonicalC1.draftOnlySeo,
    p.finalCardInputSnapshot.c1Snapshot.draftOnlySeo]) draft.editorialSource.ownerConfirmation.role = "employee";
  p.finalCardInputFingerprint = fingerprintC2FinalCardInputSnapshot(p.finalCardInputSnapshot);
  p.preparationFingerprint = fingerprintC2AuthorizationPreparation(p);
  assert.equal(validateC2AssetLifecycle(tampered).valid, false);
});

test("projected multilingual sales attribute references survive editorial confirmation, final assets and final-card readback", () => {
  const f = fixture({ projectCompetitorTexts: true, salesSnapshotVersion: "sales-snapshot-v1.1",
    salesAttributes: { "Цвет товара": "синий", "中文 属性": "蓝色", "Размер/вес~": { "упаковка 箱": ["20 см", "200 г"] } } });
  const original = structuredClone(f);
  const projected = f.bundle.request.competitorTextEvidence;
  assert.deepEqual(projected.texts.map(item => item.sourceRef), [
    `${projected.evidenceRef}#/title`,
    `${projected.evidenceRef}#/attributes/Цвет товара`,
    `${projected.evidenceRef}#/attributes/中文 属性`,
    `${projected.evidenceRef}#/attributes/Размер~1вес~0/упаковка 箱/0`,
    `${projected.evidenceRef}#/attributes/Размер~1вес~0/упаковка 箱/1`
  ]);
  const initialized = start(apply(f)), at = "2026-08-12T13:01:00.000Z";
  const manifest = prepareC2FinalUploadManifest({ skuPackage: initialized.skuPackage,
    expectedDataRevision: initialized.skuPackage.dataRevision, finalUploadAssets: finalAssets(), preparedAt: at });
  const completed = confirmC2SoftwareFinalUploads({ skuPackage: initialized.skuPackage,
    expectedDataRevision: initialized.skuPackage.dataRevision, finalManifest: manifest,
    ownerDecision: ownerDecision(manifest), confirmedAt: at });
  const result = createFinalProductPlanConfirmationCard({ skuPackage: completed.skuPackage, createdAt: at });
  const reloaded = JSON.parse(JSON.stringify(result.skuPackage));
  assert.deepEqual(f, original);
  assert.deepEqual(reloaded.profitModels, original.skuPackage.profitModels);
  assert.deepEqual(reloaded.c1ProductPlan, initialized.skuPackage.c1ProductPlan);
  const preparation = reloaded.c2FinalAssets.productionAuthorizationPreparation;
  const storedBundle = initialized.skuPackage.c1ProductPlan.draftOnlySeo.editorialSource.bundle;
  for (const draft of [reloaded.c1ProductPlan.draftOnlySeo, preparation.frozenC1Handoff.draftOnlySeo,
    preparation.finalCardInputSnapshot.canonicalC1.draftOnlySeo, preparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo]) {
    assert.deepEqual(draft.editorialSource.bundle, storedBundle);
    assert.deepEqual(draft.editorialSource.bundle.request, original.bundle.request);
    assert.deepEqual(draft.editorialSource.bundle.receipt, original.bundle.receipt);
    assert.deepEqual(draft.editorialSource.bundle.correctionPlan, original.bundle.correctionPlan);
    assert.deepEqual(draft.editorialSource.bundle.sourceJob.resultEnvelope.payload.accounting,
      original.bundle.sourceJob.resultEnvelope.payload.accounting);
    assert.equal(draft.editorialSource.bundle.sourceJob.status, "failed");
    assert.equal(draft.editorialSource.bundle.sourceJob.attempt, 1);
    assert.equal(draft.formalProviderResultAccepted, false);
  }
  assert.deepEqual(reloaded.c2FinalAssets.assets.finalUploads.map(asset => asset.assetId),
    completed.c2AssetLifecycle.assets.finalUploads.map(asset => asset.assetId));
  assert.equal(validateC2AssetLifecycle(reloaded.c2FinalAssets).valid, true);
  assert.equal(validateFinalProductPlanConfirmationCard(reloaded.productionConfirmationCard).valid, true);
  assert.deepEqual(reloaded.productionConfirmationCard, result.confirmationCard);
  assert.equal(reloaded.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
  assert.equal(reloaded.productionConfirmationCard.ownerDecision, null);
  assert.equal(reloaded.productionConfirmationCard.productionBoundary.platformWrites, 0);
  assert.equal(reloaded.productionConfirmationCard.productionBoundary.productionAuthorized, false);
  assert.equal(reloaded.productionConfirmationCard.productionBoundary.dStarted, false);
  assert.equal(reloaded.productionAuthorization, null);
  assert.equal(reloaded.productionRecord, null);
  assert.equal(reloaded.businessPhase, "C2");
  assert.equal(preparation.productionAuthorizationCreated, false);
  assert.equal(preparation.dHandoffCreated, false);
});

test("only the two exact editorial authorization paths accept an opaque ID; secrets and arbitrary refs remain rejected", () => {
  const sku = apply(fixture());
  const canonical = { frozenC1Handoff: { draftOnlySeo: sku.c1ProductPlan.draftOnlySeo } };
  assert.doesNotThrow(() => assertNoProductionSecrets(canonical));
  for (const section of ["scopeBinding", "admissionDecision"]) {
    const changed = structuredClone(canonical);
    changed.frozenC1Handoff.draftOnlySeo.editorialSource.bundle.sourceJob[section].authorizationRef = "Bearer private-token";
    assert.throws(() => assertNoProductionSecrets(changed), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  }
  for (const mutate of [value => { value.frozenC1Handoff.draftOnlySeo.editorialSource.bundle.sourceJob.token = "private-token"; },
    value => { value.frozenC1Handoff.draftOnlySeo.editorialSource.bundle.sourceJob.note = "authorization:c1-ai-draft:OTHER"; },
    value => { value.frozenC1Handoff.draftOnlySeo.editorialSource.bundle.correctionPlan.items[0].correctedText = "password=private-value"; }]) {
    const value = structuredClone(canonical); mutate(value);
    assert.throws(() => assertNoProductionSecrets(value), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  }
});

test("published schemas accept the explicit editorial union and retain the provider branch constraints", async () => {
  const validator = await loadPublishedSchemaValidator(), sku = apply(fixture());
  const validateSource = validator.getSchema("c1-editorial-source-v1");
  assert.equal(validateSource(sku.c1ProductPlan.draftOnlySeo.editorialSource), true, JSON.stringify(validateSource.errors));
  const validatePlan = validator.getSchema("c1-product-plan-v1.1");
  assert.equal(validatePlan(sku.c1ProductPlan), true, JSON.stringify(validatePlan.errors));
  const input = prepareC2SoftwareInput({ skuPackage: sku, expectedDataRevision: sku.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, preparedAt: "2026-08-12T13:00:00.000Z" });
  const validateInput = validator.getSchema("c2-software-input-v1");
  assert.equal(validateInput(input), true, JSON.stringify(validateInput.errors));
  const originalProvider = createFormalC1C2Fixture().merged.skuPackage;
  const providerInput = prepareC2SoftwareInput({ skuPackage: originalProvider, expectedDataRevision: originalProvider.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, preparedAt: "2026-08-12T13:00:00.000Z" });
  assert.equal(validateInput(providerInput), true, JSON.stringify(validateInput.errors));
  const hybrid = structuredClone(sku.c1ProductPlan);
  hybrid.draftOnlySeo.formalProviderResultAccepted = true;
  assert.equal(validatePlan(hybrid), false);
  const unknown = structuredClone(sku.c1ProductPlan);
  unknown.draftOnlySeo.editorialSource.ownerConfirmation.role = "employee";
  assert.equal(validatePlan(unknown), false);
  const c2 = start(sku), at = "2026-08-12T13:01:00.000Z";
  const manifest = prepareC2FinalUploadManifest({ skuPackage: c2.skuPackage, expectedDataRevision: c2.skuPackage.dataRevision,
    finalUploadAssets: finalAssets(), preparedAt: at });
  const completed = confirmC2SoftwareFinalUploads({ skuPackage: c2.skuPackage, expectedDataRevision: c2.skuPackage.dataRevision,
    finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: at });
  const preparation = completed.c2AssetLifecycle.productionAuthorizationPreparation;
  assert.equal(preparation.status, "awaiting_final_card_approval");
  assert.equal(preparation.pendingAuthorizationInputs.warehouseRef, null);
  assert.equal(preparation.pendingAuthorizationInputs.sourceConfirmationCardId, null);
  assert.equal(preparation.productionAuthorizationCreated, false);
  assert.equal(preparation.dHandoffCreated, false);
  assert.equal(completed.skuPackage.productionAuthorization, null);
  const validateC2 = validator.getSchema("c2-asset-lifecycle-v1.1");
  assert.equal(validateC2(completed.c2AssetLifecycle), true, JSON.stringify(validateC2.errors));
});


test("rejected-source v1 remains full and cannot be relabeled as a completed-source reference", () => {
  const sku = apply(fixture()), before = structuredClone(sku);
  assert.throws(() => createC1EditorialDraftReference({ draftOnlySeo: sku.c1ProductPlan.draftOnlySeo,
    identity: sku.g1Identity, resultSkuRevision: sku.dataRevision }), { code: "C1_EDITORIAL_REFERENCE_COMPLETED_SOURCE_REQUIRED" });
  const canonical = normalizeC1CanonicalHandoffContract(sku);
  assert.equal(canonical.draftOnlySeo.editorialSource.schemaVersion, "c1-editorial-source-v1");
  assert.deepEqual(canonical.draftOnlySeo.editorialSource.bundle, sku.c1ProductPlan.draftOnlySeo.editorialSource.bundle);
  assert.deepEqual(sku, before);
});
