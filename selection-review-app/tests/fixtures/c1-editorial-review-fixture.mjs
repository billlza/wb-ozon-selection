import assert from "node:assert/strict";
import { createSavedLocalPreparationCandidate } from "./c1-local-draft-source-fixture.mjs";
import { c1DraftPaidReceipt } from "./c1-draft-source-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../../lib/business-state-repository.mjs";
import { createC1DraftSoftwareUseCase } from "../../lib/c1-draft-software-use-case.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../../lib/worker-registry.mjs";
import { createActorContext } from "../../lib/runtime-identity.mjs";
import { C1AiGatewayError } from "../../lib/c1-ai-gateway.mjs";
import { createC1AiAccounting, validateC1AiDraftReceipt } from "../../lib/c1-ai-draft-contract.mjs";
import { fingerprintCanonicalRecord } from "../../lib/production-contract-primitives.mjs";

/** Real local preparation, admission and rejected-result persistence, with a
 * synthetic in-process gateway. No network requests or production files. */
export async function createC1EditorialReviewFixture({ at = new Date().toISOString(), ownerUserId = "owner:synthetic:editorial", sourceCandidate = null, historyRecord = null } = {}) {
  const candidate = sourceCandidate === null ? createSavedLocalPreparationCandidate({ at }) : structuredClone(sourceCandidate);
  if (sourceCandidate !== null) {
    const { produceC1LocalPreparation } = await import('../../lib/c1-keyword-planning-local-material.mjs');
    const prepared = produceC1LocalPreparation({ candidate, expectedRevision: candidate.dataRevision, producedAt: at });
    assert.equal(prepared.status, 'ready');
    candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1 = structuredClone(prepared.material);
    candidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1 = structuredClone(prepared.production);
    candidate.dataRevision += 1;
  }
  const repository = createMemoryBusinessStateRepository({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [candidate], c1FinalPlanRevisionHistoryRecords: historyRecord ? [historyRecord] : [], evidencePacks: [], dispatches: [],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } });
  const owner = createActorContext({ userId: ownerUserId, sessionId: "session:synthetic:editorial-owner",
    actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: at });
  const workerId = "worker:synthetic:editorial";
  const worker = createActorContext({ userId: workerId, sessionId: "session:synthetic:editorial-worker",
    actorType: "worker", roles: ["operator"], source: "local_worker", authenticatedAt: at });
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  workerRegistry.register({ workerId, capabilities: ["ai-draft-gateway"], version: "1", observedAt: at });
  let receipt;
  const useCase = createC1DraftSoftwareUseCase({ repository, runtimeMode: "local_development", serverClock: () => at,
    workerRegistry, executionBinding: { provider: "terra", modelVersion: "gpt-5.6-terra",
      credentialAlias: "gateway-alias:synthetic:editorial", allowedWorkerIds: [workerId] },
    requestGateway: async ({ request, authorizedExecution, onGatewayJobAccepted }) => {
      receipt = c1DraftPaidReceipt({ request, authorizedExecution }, at);
      if (!request.factDefinitionsVersion) receipt.output.bulletPoints = Array.from({ length: 3 }, () => structuredClone(receipt.output.bulletPoints[0]));
      receipt.output.searchKeywords.push(structuredClone(receipt.output.searchKeywords[0]));
      receipt.accounting = createC1AiAccounting({ gatewayJobId: receipt.gatewayJobId,
        providerRequestId: receipt.providerRequestId, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
      receipt.outputFingerprint = fingerprintCanonicalRecord(receipt.output);
      assert.equal(validateC1AiDraftReceipt({ request, receipt }).valid, true);
      // Only the reference syntax is wrong; wording and complete assertions are
      // preserved so this fixture never invents semantic proof of revised text.
      for (const item of [receipt.output.title, receipt.output.description, ...receipt.output.bulletPoints, ...receipt.output.searchKeywords]) {
        item.factRefs = [...new Set(item.assertions.flatMap(assertion => request.verifiedFacts
          .find(fact => fact.factPath === assertion.factPath).evidenceRefs))];
      }
      receipt.outputFingerprint = fingerprintCanonicalRecord(receipt.output);
      assert.equal(validateC1AiDraftReceipt({ request, receipt }).valid, false);
      await onGatewayJobAccepted({ gatewayJobId: receipt.gatewayJobId });
      throw new C1AiGatewayError("C1_AI_GATEWAY_RECEIPT_REJECTED", "receipt", "Synthetic rejected citation format", {
        jobId: receipt.gatewayJobId, externalRequestState: "succeeded", accounting: receipt.accounting });
    } });
  const prepared = await useCase.prepareLocal({ actor: owner, input: { candidateId: candidate.id,
    expectedRevision: candidate.dataRevision, idempotencyKey: "editorial:prepare", auditEventId: "editorial:prepare-audit" } });
  const request = prepared.candidate.lifecycleV11.c1AiDraftRequestV1;
  const enqueued = await useCase.authorizeAndEnqueue({ actor: owner, input: { candidateId: candidate.id,
    expectedRevision: prepared.candidate.dataRevision, requestRef: request.requestId, requestFingerprint: request.requestFingerprint,
    confirmPaidCall: true, expiresAt: null, idempotencyKey: "editorial:authorize", auditEventId: "editorial:authorize-audit" } });
  const jobId = enqueued.result.softwareJobRef.jobId;
  const run = await useCase.run({ actor: worker, input: { jobId, leaseId: "lease:synthetic:editorial-original", leaseDurationMs: 90000 } });
  assert.equal(run.status, "failed");
  const document = await repository.readSnapshot();
  const sourceJob = document.runtime.softwareJobs.find(job => job.jobId === jobId);
  const items = [["output.title", receipt.output.title], ["output.description", receipt.output.description],
    ...["bulletPoints", "searchKeywords"].flatMap(field => receipt.output[field].map((item, index) => [`output.${field}[${index}]`, item]))];
  const correctionPlan = { schemaVersion: "c1-draft-editorial-plan-v1", requestFingerprint: request.requestFingerprint,
    sourceOutputFingerprint: receipt.outputFingerprint, sourceSoftwareJobId: jobId,
    items: items.map(([path, item]) => ({ path, originalText: item.text, originalFactRefs: structuredClone(item.factRefs),
      originalAssertions: structuredClone(item.assertions), correctedText: item.text,
      factPaths: [...new Set(item.assertions.map(assertion => assertion.factPath))],
      explanation: "Synthetic reviewed wording is unchanged; map the original complete assertions to their frozen fact paths.",
      sourceRefs: [...new Set(item.assertions.flatMap(assertion => request.verifiedFacts.find(fact => fact.factPath === assertion.factPath).evidenceRefs))] })) };
  return { candidate: document.candidates[0], document, bundle: { request: structuredClone(request), receipt: structuredClone(receipt),
    sourceJob: structuredClone(sourceJob), correctionPlan }, at, owner, repository };
}
