import { isDeepStrictEqual } from "node:util";
import { validateC1AiDraftRequest, validateC1AiDraftReceipt } from "./c1-ai-draft-contract.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { projectC1AiSoftwareJobAuthorizedExecution, readCompletedC1AiSoftwareJobResult } from "./software-job-contract.mjs";

import { assessC1DraftEditorialContent, editorialSourceScopeIssue } from "./c1-editorial-review-contract.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function sourceScopeIssue(sourceJob, request, receipt) {
  const issue = editorialSourceScopeIssue(sourceJob, request, receipt);
  if (issue) return issue;
  try {
    projectC1AiSoftwareJobAuthorizedExecution({ ...sourceJob, status: "waiting_platform", externalRequestState: "in_flight" }, request);
  } catch (error) {
    if (error instanceof Error && /^(?:SOFTWARE_JOB_|C1_AI_|RUNTIME_IDENTITY_INVALID)/.test(error.message)) return "SOURCE_EXECUTION_BINDING_INVALID";
    throw error;
  }
  return null;
}

/** Pure, conservative assessment of a normalized historical receipt and its
 * persisted rejected source job. A repair version is a local proposal,
 * never a replacement provider receipt, authorization, or permission to apply. */
export function assessC1DraftRecovery({ request, receipt, sourceJob }) {
  const requestValidation = validateC1AiDraftRequest(request);
  if (!requestValidation.valid) return { schemaVersion: "c1-draft-recovery-assessment-v1", status: "blocked",
    reasons: [{ code: "REQUEST_INVALID", errors: requestValidation.errors }], proposedChanges: [],
    originalValidation: requestValidation, repairedValidation: null, repairedVersion: null };
  const originalValidation = validateC1AiDraftReceipt({ request, receipt });
  const base = { schemaVersion: "c1-draft-recovery-assessment-v1", requestId: request.requestId,
    requestFingerprint: request.requestFingerprint, sourceReceiptId: receipt?.receiptId ?? null,
    sourceOutputFingerprint: receipt?.outputFingerprint ?? null,
    outputContractVersion: request.outputContractVersion ?? null, originalValidation,
    proposedChanges: [], reasons: [], repairedValidation: null, repairedVersion: null };
  const scopeIssue = sourceScopeIssue(sourceJob, request, receipt);
  if (scopeIssue) return { ...base, status: "blocked", reasons: [{ code: scopeIssue }] };
  if (originalValidation.valid) return { ...base, status: "not_required", repairedValidation: originalValidation };
  // Metadata, source identity, accounting and original output checksum are never
  // reconstructed. Only the two explicitly recognized output defects qualify.
  const otherErrors = originalValidation.errors.filter(error =>
    !/^output\.(?:title|description|bulletPoints\[\d+\]|searchKeywords\[\d+\])\.(?:factRefs:|assertions\[\d+\]:)/.test(error));
  if (otherErrors.length || !object(receipt.output)) return { ...base, status: "blocked",
    reasons: [{ code: "UNSUPPORTED_OR_UNTRUSTED_RECEIPT_DEFECT", errors: otherErrors.length ? otherErrors : originalValidation.errors }] };

  const facts = new Map();
  const evidence = new Map();
  for (const fact of request.verifiedFacts) {
    if (facts.has(fact.factPath)) return { ...base, status: "blocked", reasons: [{ code: "DUPLICATE_FACT_PATH", factPath: fact.factPath }] };
    facts.set(fact.factPath, fact);
    for (const ref of new Set(fact.evidenceRefs)) {
      if (!evidence.has(ref)) evidence.set(ref, []);
      evidence.get(ref).push(fact.factPath);
    }
  }
  const draft = structuredClone(receipt);
  const changes = base.proposedChanges, reasons = base.reasons;
  function change(path, oldValue, newValue, basis, oldValuePresent = true) {
    changes.push({ path, oldValuePresent, oldValue: oldValuePresent ? structuredClone(oldValue) : null,
      newValue: structuredClone(newValue), basis });
  }
  const items = [["output.title", draft.output.title], ["output.description", draft.output.description],
    ...["bulletPoints", "searchKeywords"].flatMap(field => Array.isArray(draft.output[field])
      ? draft.output[field].map((item, index) => [`output.${field}[${index}]`, item]) : [])];
  for (const [path, item] of items) {
    if (!object(item)) { reasons.push({ code: "INVALID_CITED_ITEM", path }); continue; }
    if (Array.isArray(item.factRefs)) item.factRefs.forEach((ref, index) => {
      if (facts.has(ref)) return;
      const candidates = evidence.get(ref) ?? [];
      if (candidates.length !== 1) {
        reasons.push({ code: candidates.length ? "AMBIGUOUS_EVIDENCE_REFERENCE" : "UNKNOWN_FACT_REFERENCE",
          path: `${path}.factRefs[${index}]`, originalReference: ref, candidateFactPaths: [...candidates] });
        return;
      }
      const factPath = candidates[0];
      change(`${path}.factRefs[${index}]`, ref, factPath,
        { rule: "unique_evidence_to_fact_path", evidenceRef: ref, factPath });
      item.factRefs[index] = factPath;
    });
    if (Array.isArray(item.assertions)) item.assertions.forEach((assertion, index) => {
      const fact = facts.get(assertion?.factPath);
      if (!fact || !object(assertion.value) || !object(fact.value) ||
          own(assertion.value, "evidenceRef") || !own(fact.value, "evidenceRef")) return;
      const restored = { ...assertion.value, evidenceRef: fact.value.evidenceRef };
      if (!isDeepStrictEqual(restored, fact.value)) return;
      change(`${path}.assertions[${index}].value.evidenceRef`, null, fact.value.evidenceRef,
        { rule: "exact_frozen_value_missing_evidence_ref_only", factPath: fact.factPath,
          frozenValue: structuredClone(fact.value) }, false);
      assertion.value = restored;
    });
  }
  // Recalculate only the proposed local content fingerprint. The original model
  // receipt remains unchanged and is not returned as a supposedly repaired one.
  draft.outputFingerprint = fingerprintCanonicalRecord(draft.output);
  const repairedValidation = validateC1AiDraftReceipt({ request, receipt: draft });
  if (!repairedValidation.valid) reasons.push({ code: "FULL_RECEIPT_VALIDATION_FAILED", errors: repairedValidation.errors });
  if (reasons.length) return { ...base, status: "blocked", repairedValidation };
  const version = { schemaVersion: "c1-draft-repair-version-v1", requestId: request.requestId,
    sourceSoftwareJobId: sourceJob.jobId, sourceGatewayJobId: receipt.gatewayJobId,
    sourceCandidateId: sourceJob.candidateId, sourceSkuPackageId: sourceJob.skuPackageId, sourceCandidateRevision: sourceJob.revision,
    sourceIdentity: structuredClone(request.sourceIdentity), sourceVariantKey: request.identity.variantKey,
    requestFingerprint: request.requestFingerprint, sourceReceiptId: receipt.receiptId,
    sourceOutputFingerprint: receipt.outputFingerprint, outputContractVersion: request.outputContractVersion ?? null,
    output: draft.output, outputFingerprint: draft.outputFingerprint, changes: structuredClone(changes),
    validation: repairedValidation, status: "proposal_only", providerReceiptReplaced: false, productionApproved: false };
  return { ...base, status: "repair_proposed", repairedValidation,
    repairedVersion: { ...version, repairVersionId: `c1-draft-repair:${fingerprintCanonicalRecord(version)}` } };
}

/** Full historical job validation stays at the software boundary; content replay is shared with C2. */
export function assessC1DraftEditorialCorrection(input) {
  const result = assessC1DraftEditorialContent(input);
  if (result.status !== "editorial_proposed") return result;
  let issue;
  if (input.correctionPlan.schemaVersion === "c1-draft-editorial-plan-v2") {
    try {
      const saved = readCompletedC1AiSoftwareJobResult(input.sourceJob, { allowApplied: true });
      if (!isDeepStrictEqual(saved.request, input.request) || !isDeepStrictEqual(saved.receipt, input.receipt)) {
        issue = "SOURCE_RECEIPT_BINDING_MISMATCH";
      }
    } catch (error) {
      if (!(error instanceof Error) || !/^(?:SOFTWARE_JOB_|C1_AI_|RUNTIME_IDENTITY_INVALID)/.test(error.message)) throw error;
      issue = "SOURCE_EXECUTION_BINDING_INVALID";
    }
  } else issue = sourceScopeIssue(input.sourceJob, input.request, input.receipt);
  return issue ? { ...result, status: "blocked", reasons: [{ code: issue }], editedVersion: null } : result;
}
