import test from "node:test";
import assert from "node:assert/strict";
import { assessC1DraftRecovery, assessC1DraftEditorialCorrection } from "../lib/c1-draft-recovery-assessment.mjs";
import { validateC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";
import { buildRequest, receipt, nonTrainSkuPackage } from "./fixtures/c1-ai-draft-fixture.mjs";
import { prepareC1DraftSoftwareExecution } from "../lib/c1-draft-software-use-case.mjs";
import { createSoftwareJobEnvelope, claimSoftwareJobLease, bindSoftwareJobAdmissionDecision,
  markSoftwareJobExternalRequestStarted, recordC1GatewayAcceptance, createSoftwareJobResultEnvelope,
  settleSoftwareJob } from "../lib/software-job-contract.mjs";

function rejectedSourceJob(request, receipt, skuPackage) {
  const at = request.requestedAt, workerId = "worker:repair-test", leaseId = "lease:repair-test";
  const { jobInput } = prepareC1DraftSoftwareExecution({ candidate: { id: request.sourceIdentity.candidateId, dataRevision: 12,
    lifecycleV11: { skuPackage } }, request, expectedRevision: 12, authorizationRef: "authorization:c1-ai-draft:REPAIR",
    credentialAlias: "gateway:repair-test", jobId: receipt.softwareJobId, ownerUserId: "owner:repair-test",
    requestedByUserId: "owner:repair-test", idempotencyKey: "enqueue:repair-test" });
  let job = createSoftwareJobEnvelope({ ...jobInput, createdAt: at });
  job = claimSoftwareJobLease({ job, worker: { workerId, version: "1", status: "online", capabilities: ["ai-draft-gateway"] },
    leaseId, serverTime: at, leaseDurationMs: 120000 });
  job = bindSoftwareJobAdmissionDecision(job, { schemaVersion: "software-job-admission-v1", jobId: job.jobId,
    candidateId: job.candidateId, skuPackageId: job.skuPackageId, revision: job.revision, jobType: job.jobType,
    authorizationRef: job.scopeBinding.authorizationRef, credentialAlias: job.scopeBinding.credentialAlias,
    authorizationFingerprint: "a".repeat(64), credentialBindingFingerprint: "b".repeat(64) });
  job = markSoftwareJobExternalRequestStarted({ job, workerId, leaseId, externalRequestRef: "external:repair-test", serverTime: at });
  job = recordC1GatewayAcceptance({ job, workerId, leaseId, requestFingerprint: request.requestFingerprint,
    gatewayJobId: receipt.gatewayJobId, serverTime: at }).job;
  const resultEnvelope = createSoftwareJobResultEnvelope({ job, resultRef: receipt.gatewayJobId, payloadKind: "c1_ai_draft",
    recordedAt: receipt.completedAt, payload: { schemaVersion: "c1-ai-draft-software-failure-v1", request,
      accounting: receipt.accounting, errorCode: "C1_AI_GATEWAY_RECEIPT_REJECTED" } });
  return settleSoftwareJob({ job, workerId, leaseId, status: "failed", externalRequestState: "succeeded",
    failureClass: "C1_AI_GATEWAY_RECEIPT_REJECTED", resultRef: receipt.gatewayJobId, resultEnvelope, serverTime: receipt.completedAt });
}

function fixture({ ambiguous = false } = {}) {
  const skuPackage = nonTrainSkuPackage();
  const plan = skuPackage.c1ProductPlan;
  plan.platformCategory.categoryName.sourceRefs = ["evidence:category:unique"];
  if (ambiguous) plan.productAttributes.color.sourceRefs = ["evidence:category:unique"];
  plan.productAttributes.dimensions.value.evidenceRef = "evidence:dimensions:original";
  const request = buildRequest({ skuPackage, outputContractVersion: null });
  const result = receipt(request);
  assert.equal(validateC1AiDraftReceipt({ request, receipt: result }).valid, true);
  return structuredClone({ request, receipt: result, sourceJob: rejectedSourceJob(request, result, skuPackage) });
}
function refError(f) { f.receipt.output.title.factRefs = ["evidence:category:unique"]; checksum(f); }
function checksum(f) { f.receipt.outputFingerprint = fingerprintCanonicalRecord(f.receipt.output); }

test("a unique evidence reference creates an independent proposal and never mutates the original receipt or request", () => {
  const f = fixture(); refError(f); const before = structuredClone(f);
  const assessment = assessC1DraftRecovery(f);
  assert.equal(assessment.status, "repair_proposed");
  assert.equal(assessment.repairedValidation.valid, true);
  assert.equal(assessment.proposedChanges.length, 1);
  assert.deepEqual(assessment.proposedChanges[0], { path: "output.title.factRefs[0]", oldValuePresent: true,
    oldValue: "evidence:category:unique", newValue: "platformCategory.categoryName",
    basis: { rule: "unique_evidence_to_fact_path", evidenceRef: "evidence:category:unique", factPath: "platformCategory.categoryName" } });
  assert.equal(assessment.repairedVersion.status, "proposal_only");
  assert.equal(assessment.repairedVersion.outputContractVersion, null);
  assert.equal(assessment.repairedVersion.providerReceiptReplaced, false);
  assert.equal(assessment.repairedVersion.productionApproved, false);
  assert.equal(Object.hasOwn(assessment.repairedVersion, "receiptId"), false);
  assert.equal(assessment.repairedVersion.sourceSoftwareJobId, f.sourceJob.jobId);
  assert.equal(assessment.repairedVersion.sourceGatewayJobId, f.receipt.gatewayJobId);
  assert.equal(assessment.repairedVersion.sourceCandidateRevision, f.sourceJob.revision);
  assert.deepEqual(assessment.repairedVersion.sourceIdentity, f.request.sourceIdentity);
  assert.equal(assessment.repairedVersion.sourceVariantKey, f.request.identity.variantKey);
  assert.equal(assessment.repairedVersion.sourceOutputFingerprint, f.receipt.outputFingerprint);
  const expectedOutput = structuredClone(f.receipt.output);
  expectedOutput.title.factRefs = ["platformCategory.categoryName"];
  assert.deepEqual(assessment.repairedVersion.output, expectedOutput);
  assert.deepEqual(assessment.repairedVersion.changes, assessment.proposedChanges);
  assert.deepEqual(f, before);
  assert.deepEqual(assessC1DraftRecovery(f), assessment);
});

test("shared evidence blocks the whole version even when an assertion appears to select one fact", () => {
  const f = fixture({ ambiguous: true }); refError(f);
  const assessment = assessC1DraftRecovery(f);
  assert.equal(assessment.status, "blocked"); assert.equal(assessment.repairedVersion, null);
  const reason = assessment.reasons.find(value => value.code === "AMBIGUOUS_EVIDENCE_REFERENCE");
  assert.deepEqual(new Set(reason.candidateFactPaths), new Set(["platformCategory.categoryName", "productAttributes.color"]));
});

test("only a missing evidenceRef in an otherwise identical frozen value is proposed; ambiguity still blocks all application", () => {
  const f = fixture({ ambiguous: true }); refError(f);
  const fact = f.request.verifiedFacts.find(value => value.factPath === "productAttributes.dimensions");
  f.receipt.output.description.assertions = [{ factPath: fact.factPath, value: { length: 22, width: 11, height: 4, unit: "cm" } }];
  checksum(f);
  const assessment = assessC1DraftRecovery(f);
  assert.equal(assessment.status, "blocked"); assert.equal(assessment.repairedVersion, null);
  assert.deepEqual(assessment.proposedChanges, [{ path: "output.description.assertions[0].value.evidenceRef", oldValuePresent: false,
    oldValue: null, newValue: "evidence:dimensions:original", basis: { rule: "exact_frozen_value_missing_evidence_ref_only",
      factPath: fact.factPath, frozenValue: fact.value } }]);
  f.receipt.output.description.assertions[0].value.length = 23; checksum(f);
  assert.equal(assessC1DraftRecovery(f).proposedChanges.length, 0);
});

test("unrecognized references, changed claims, keyword misuse and metadata defects are never repaired", () => {
  const cases = [
    f => { f.receipt.output.title.factRefs = ["evidence:unknown"]; checksum(f); },
    f => { f.receipt.output.title.assertions[0].value = "invented"; checksum(f); },
    f => { f.receipt.output.title.keywordRefs = ["keyword:foreign"]; checksum(f); },
    f => { f.receipt.requestFingerprint = "a".repeat(64); },
    f => { f.receipt.outputFingerprint = "a".repeat(64); },
    f => { f.receipt.accounting.gatewayJobId = "gateway:foreign"; },
    f => { f.receipt.output.title.text = "x".repeat(f.request.seoRules.titleMaxLength + 1); checksum(f); }
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f); const before = structuredClone(f);
    const assessment = assessC1DraftRecovery(f);
    assert.equal(assessment.status, "blocked"); assert.equal(assessment.repairedVersion, null); assert.deepEqual(f, before);
  }
});

test("already valid receipts need no repair, and invalid historical requests cannot gain a new version", () => {
  const f = fixture(); assert.equal(assessC1DraftRecovery(f).status, "not_required");
  f.request.outputContractVersion = "c1-ai-draft-output-v2";
  const assessment = assessC1DraftRecovery(f);
  assert.equal(assessment.status, "blocked"); assert.equal(assessment.reasons[0].code, "REQUEST_INVALID");
  assert.equal(assessment.repairedVersion, null);
});

test("cross candidate, SKU, variant, job, receipt or request version rejects before proposing any edit", () => {
  const cases = [
    f => { f.sourceJob.candidateId = "candidate:other"; },
    f => { f.sourceJob.skuPackageId = "sku:other"; },
    f => { f.sourceJob.scopeBinding.variantKey = "variant:other"; },
    f => { f.sourceJob.revision += 1; },
    f => { f.receipt.softwareJobId = "job:other"; },
    f => { f.receipt.gatewayJobId = "gateway:other"; },
    f => { f.sourceJob.resultEnvelope.payload.request = buildRequest({ outputContractVersion: null }); },
    f => { f.request.outputContractVersion = "c1-ai-draft-output-v2"; },
    f => { f.sourceJob.status = "completed"; },
    f => { delete f.sourceJob; }
  ];
  for (const mutate of cases) {
    const f = fixture(); refError(f); mutate(f);
    const assessment = assessC1DraftRecovery(f);
    assert.equal(assessment.status, "blocked"); assert.deepEqual(assessment.proposedChanges, []);
    assert.equal(assessment.repairedVersion, null);
  }
});

function editorialFixture({ ambiguous = false, packaging = false } = {}) {
  const f = fixture({ ambiguous });
  f.receipt.output.bulletPoints = Array.from({ length: 4 }, () => structuredClone(f.receipt.output.bulletPoints[0]));
  if (packaging) {
    const fact = f.request.verifiedFacts.find(value => value.factPath === "productAttributes.dimensions");
    f.receipt.output.description = { ...f.receipt.output.description, text: "Размеры изделия: 22 × 11 × 4 см.",
      factRefs: [fact.factPath], assertions: [{ factPath: fact.factPath, value: structuredClone(fact.value) }] };
  }
  checksum(f);
  return f;
}
function editorialPlan(f) {
  const items = [["output.title", f.receipt.output.title], ["output.description", f.receipt.output.description],
    ...["bulletPoints", "searchKeywords"].flatMap(field => f.receipt.output[field].map((value, index) => [`output.${field}[${index}]`, value]))];
  return { schemaVersion: "c1-draft-editorial-plan-v1", requestFingerprint: f.request.requestFingerprint,
    sourceOutputFingerprint: f.receipt.outputFingerprint, sourceSoftwareJobId: f.sourceJob.jobId,
    items: items.map(([path, item]) => {
      const factPaths = [...new Set(item.assertions.map(value => value.factPath))];
      return { path, originalText: item.text, originalFactRefs: structuredClone(item.factRefs), originalAssertions: structuredClone(item.assertions),
        correctedText: item.text, factPaths, explanation: "已逐项维护核对文字含义和原声明事实，此记录不代表程序完成语义证明或主人已审稿。",
        sourceRefs: [...new Set(factPaths.flatMap(factPath => f.request.verifiedFacts.find(fact => fact.factPath === factPath).evidenceRefs))] };
    }) };
}
function assessed(f, correctionPlan = editorialPlan(f)) { return assessC1DraftEditorialCorrection({ ...f, correctionPlan }); }

test("editorial packaging wording is a separate maintenance-reviewed proposal even when original receipt passes", () => {
  const f = editorialFixture({ packaging: true });
  assert.equal(assessC1DraftRecovery(f).status, "not_required");
  const correctionPlan = editorialPlan(f), before = structuredClone({ ...f, correctionPlan });
  correctionPlan.items[1].correctedText = "Размеры упаковки: 22 × 11 × 4 см.";
  correctionPlan.items[1].explanation = "维护核对该来源的尺寸口径为包装；修订文字限定为包装尺寸，未改变数值，待主人审稿。";
  const submitted = structuredClone({ ...f, correctionPlan });
  const result = assessed(f, correctionPlan), version = result.editedVersion;
  assert.equal(result.status, "editorial_proposed");
  assert.equal(result.originalValidation.valid, true); assert.equal(result.editedValidation.valid, true);
  assert.equal(version.schemaVersion, "c1-draft-editorial-version-v1"); assert.equal(version.status, "proposal_only");
  assert.equal(version.changes.length, 7); assert.equal(version.changes.filter(change => change.changed).length, 1);
  assert.deepEqual(version.changes[1].before, before.receipt.output.description);
  assert.equal(version.changes[1].after.text, correctionPlan.items[1].correctedText);
  assert.deepEqual(version.correctionPlan, correctionPlan);
  assert.deepEqual(version.semanticValidation, { status: "maintenance_review_recorded", automatedSemanticProof: false });
  assert.equal(version.automaticApplicationAllowed, false); assert.equal(version.providerReceiptReplaced, false); assert.equal(version.productionApproved, false);
  assert.equal(Object.hasOwn(version, "receiptId"), false);
  assert.equal(validateC1AiDraftReceipt({ request: f.request, receipt: version }).valid, false,
    "a maintenance proposal must not be accepted as a formal model receipt");
  assert.equal(version.sourceSoftwareJobId, f.sourceJob.jobId); assert.equal(version.sourceOutputFingerprint, f.receipt.outputFingerprint);
  assert.deepEqual({ ...f, correctionPlan }, submitted); assert.deepEqual(assessed(f, correctionPlan), result);
});

test("explicit original assertions can disambiguate shared evidence without inventing a new fact", () => {
  const f = editorialFixture({ ambiguous: true }); refError(f);
  assert.equal(assessC1DraftRecovery(f).status, "blocked");
  const result = assessed(f);
  assert.equal(result.status, "editorial_proposed");
  assert.deepEqual(result.editedVersion.output.title.factRefs, ["platformCategory.categoryName"]);
  assert.equal(result.editedVersion.semanticValidation.automatedSemanticProof, false);
});

test("all actual items including unchanged text are mandatory; duplicate or unknown entries are blocked", () => {
  for (const change of [p => p.items.pop(), p => p.items.push(structuredClone(p.items[0])),
    p => { p.items[6].path = "output.bulletPoints[100]"; }, p => { p.items[1] = structuredClone(p.items[0]); }]) {
    const f = editorialFixture(), plan = editorialPlan(f); change(plan);
    const result = assessed(f, plan);
    assert.equal(result.status, "blocked"); assert.equal(result.editedVersion, null);
    assert.match(result.reasons[0].code, /EDITORIAL_(ITEM_COVERAGE_REQUIRED|DUPLICATE_ITEM)/);
  }
});

test("closed plan fields, bounded text, source locks and stale original values fail explicitly", () => {
  const mutations = [p => { p.extra = true; }, p => { p.items[0].extra = true; }, p => { delete p.items[0].explanation; },
    p => { p.items[0].explanation = " "; }, p => { p.items[0].correctedText = "x".repeat(6001); },
    p => { p.requestFingerprint = "a".repeat(64); }, p => { p.sourceOutputFingerprint = "a".repeat(64); }, p => { p.sourceSoftwareJobId = "job:other"; },
    p => { p.items[0].originalText = "stale"; }, p => { p.items[0].originalFactRefs = ["stale"]; }, p => { p.items[0].originalAssertions[0].value = "stale"; }];
  for (const change of mutations) {
    const f = editorialFixture(), plan = editorialPlan(f); change(plan);
    assert.equal(assessed(f, plan).status, "blocked");
  }
  const f = editorialFixture();
  assert.equal(assessC1DraftEditorialCorrection({ ...f, correctionPlan: editorialPlan(f), extra: true }).reasons[0].code, "EDITORIAL_INPUT_INVALID");
  const plan = editorialPlan(f); plan.items[0].originalAssertions = Array.from({ length: 11000 }, () => ({}));
  assert.equal(assessed(f, plan).reasons[0].code, "EDITORIAL_PLAN_UNSAFE_OR_OVERSIZED");
});

test("original assertion tampering, unknown refs and facts absent from the original item cannot be editorially legalized", () => {
  for (const defect of ["assertion", "unknown-ref", "new-fact"]) {
    const f = editorialFixture();
    if (defect === "assertion") f.receipt.output.title.assertions[0].value = "changed";
    if (defect === "unknown-ref") f.receipt.output.title.factRefs = ["evidence:missing"];
    checksum(f); const plan = editorialPlan(f);
    if (defect === "new-fact") { plan.items[0].factPaths = ["productAttributes.material"]; plan.items[0].sourceRefs = f.request.verifiedFacts.find(fact => fact.factPath === "productAttributes.material").evidenceRefs; }
    const result = assessed(f, plan);
    assert.equal(result.status, "blocked");
    assert.equal(result.reasons[0].code, defect === "assertion" ? "EDITORIAL_ORIGINAL_ASSERTION_INVALID" : defect === "unknown-ref" ? "EDITORIAL_ORIGINAL_REFERENCE_UNCOVERED" : "EDITORIAL_UNDECLARED_FACT");
  }
});

test("selected facts need their own source evidence; unrelated request evidence alone does not suffice", () => {
  for (const refs of [[], ["evidence:invented"], ["competitor:unrelated"]]) {
    const f = editorialFixture(), plan = editorialPlan(f); plan.items[0].sourceRefs = refs;
    assert.equal(assessed(f, plan).status, "blocked");
  }
  const f = editorialFixture(), plan = editorialPlan(f);
  plan.items[0].sourceRefs = [f.request.keywordEvidence.evidenceId];
  assert.equal(assessed(f, plan).reasons[0].code, "EDITORIAL_EVIDENCE_INSUFFICIENT");
  plan.items[0].sourceRefs = [...f.request.verifiedFacts.find(fact => fact.factPath === plan.items[0].factPaths[0]).evidenceRefs, f.request.keywordEvidence.evidenceId];
  assert.equal(assessed(f, plan).status, "editorial_proposed");
});

test("missing nested evidenceRef alone can be restored but changed numbers cannot", () => {
  const f = editorialFixture({ packaging: true });
  delete f.receipt.output.description.assertions[0].value.evidenceRef; checksum(f);
  const result = assessed(f); assert.equal(result.status, "editorial_proposed");
  assert.equal(result.editedVersion.output.description.assertions[0].value.evidenceRef, "evidence:dimensions:original");
  f.receipt.output.description.assertions[0].value.length = 23; checksum(f);
  assert.equal(assessed(f).reasons[0].code, "EDITORIAL_ORIGINAL_ASSERTION_INVALID");
});

test("cross-scope source, metadata corruption and full receipt validation remain blocking", () => {
  for (const change of [f => { f.sourceJob.candidateId = "other"; }, f => { f.sourceJob.revision += 1; },
    f => { f.sourceJob.scopeBinding.variantKey = "other"; }, f => { f.receipt.gatewayJobId = "other"; },
    f => { f.receipt.completedAt = "invalid"; }, f => { f.receipt.output.title.keywordRefs = ["unknown"]; checksum(f); }]) {
    const f = editorialFixture(); change(f);
    const result = assessed(f); assert.equal(result.status, "blocked"); assert.equal(result.editedVersion, null);
  }
  const f = editorialFixture(), plan = editorialPlan(f); plan.items[0].correctedText = "x".repeat(f.request.seoRules.titleMaxLength + 1);
  const result = assessed(f, plan); assert.equal(result.reasons[0].code, "FULL_RECEIPT_VALIDATION_FAILED");
  assert.equal(result.editedValidation.valid, false);
});

test("null, primitive, non-JSON plans and malformed assertions are explicit blocked results", () => {
  for (const input of [null, undefined, true, 3, "invalid", []]) assert.equal(assessC1DraftEditorialCorrection(input).status, "blocked");
  const f = editorialFixture();
  for (const value of [null, true, 3, "invalid", []]) {
    assert.equal(assessed(f, value).status, "blocked");
    for (const field of ["request", "receipt", "sourceJob"]) {
      assert.equal(assessC1DraftEditorialCorrection({ ...f, correctionPlan: editorialPlan(f), [field]: value }).status, "blocked");
    }
  }
  for (const value of [1n, undefined, () => {}, new Date(), NaN]) {
    const plan = editorialPlan(f); plan.items[0].originalAssertions[0].value = value;
    assert.equal(assessed(f, plan).status, "blocked");
  }
  for (const assertion of [null, true, 3, "invalid", []]) {
    const changed = structuredClone(f), plan = editorialPlan(changed);
    changed.receipt.output.title.assertions = [assertion]; checksum(changed);
    plan.sourceOutputFingerprint = changed.receipt.outputFingerprint; plan.items[0].originalAssertions = [assertion];
    assert.equal(assessed(changed, plan).reasons[0].code, "EDITORIAL_ORIGINAL_ASSERTION_INVALID");
  }
});

test("a failed source-scope check never yields an editable version despite a complete valid plan", () => {
  const mutations = [f => { f.sourceJob.status = "completed"; }, f => { f.sourceJob.externalRequestState = "unknown_outcome"; },
    f => { f.sourceJob.failureClass = "different_failure"; }, f => { f.sourceJob.attempt = 2; },
    f => { f.sourceJob.resultEnvelope.payloadFingerprint = "0".repeat(64); }, f => { f.sourceJob.progressRef = "gateway:other"; },
    f => { f.sourceJob.resultEnvelope.payload.accounting.providerRequestId = "provider:other"; },
    f => { f.sourceJob.scopeBinding.identity.storeRef.stableStoreId = "store:other"; }];
  for (const mutate of mutations) {
    const f = editorialFixture(), correctionPlan = editorialPlan(f); mutate(f);
    const before = structuredClone({ ...f, correctionPlan }), result = assessed(f, correctionPlan);
    assert.equal(result.status, "blocked"); assert.equal(result.editedVersion, null); assert.equal(result.editedValidation, null);
    assert.match(result.reasons[0].code, /^SOURCE_/);
    assert.deepEqual({ ...f, correctionPlan }, before);
  }
});
