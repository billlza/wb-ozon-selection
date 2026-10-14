import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createC1SkuRightsReviewUseCase } from "../lib/c1-sku-rights-review-submission.mjs";
import { C1_SKU_RIGHTS_REVIEW_RECORD_SCHEMA, C1SkuRightsReviewError, createC1SkuRightsReviewRecord,
  validateC1SkuRightsReviewRecord, resolveC1SkuRightsReviewForFacts } from "../lib/c1-sku-rights-review.mjs";
import { verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { assertCurrentC1AiDraftRequest } from "../lib/c1-ai-draft-contract.mjs";
import { produceC1KeywordPlanningEvidence } from "../lib/c1-keyword-planning-evidence-producer.mjs";
import { prepareC1FactKeywordPipeline } from "../lib/c1-fact-keyword-pipeline.mjs";
import { runC1SoftwareOrchestration } from "../lib/c1-software-orchestrator.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { c1AiSoftwareJobFixture } from "./fixtures/c1-ai-software-job-fixture.mjs";

const AT = "2026-08-12T13:00:00.000Z";
const EXPIRES = "2026-08-20T13:00:00.000Z";
const owner = createActorContext({ userId: "owner:synthetic-rights", sessionId: "session:synthetic-rights", actorType: "human",
  roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });

function fixture({ checked = false, skuAttributes = {} } = {}) {
  const formal = createFormalC1DraftFixture({ rightsReviewOptions: null, skuAttributes });
  const candidate = structuredClone(formal.candidate);
  candidate.targetPlatform = formal.created.skuPackage.targetPlatform;
  candidate.storeRef = structuredClone(formal.created.skuPackage.g1Identity.storeRef);
  candidate.lifecycleV11.skuPackage = structuredClone(checked ? formal.checked.skuPackage : formal.created.skuPackage);
  const sku = candidate.lifecycleV11.skuPackage;
  const input = { candidateId: candidate.id, skuPackageId: sku.skuPackageId, expectedRevision: candidate.dataRevision,
    idempotencyKey: `rights:synthetic:${candidate.dataRevision}`, expectedC1PlanId: sku.c1ProductPlan.c1PlanId,
    replacesC1PlanId: checked ? sku.c1ProductPlan.c1PlanId : null,
    brand: { status: "branded", name: "Synthetic declared brand" }, rights: { status: "verified", basis: "licensed" },
    reviewedAt: AT, expiresAt: EXPIRES };
  const document = { candidates: [candidate], runtime: { softwareJobs: [] } };
  return { formal, candidate, input, document };
}

function useCase(repository, serverClock = () => AT) {
  return createC1SkuRightsReviewUseCase({ repository, runtimeMode: "local_development", serverClock });
}
function hasCode(code) { return error => error instanceof C1SkuRightsReviewError && error.code === code; }

test("authenticated owner declaration saves exact sources before one fact freeze, without files or paid permission", async () => {
  const f = fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  const saved = await useCase(repository).submit({ actor: owner, input: f.input });
  const sku = saved.candidate.lifecycleV11.skuPackage;
  const record = sku.c1RightsReviewRecord;
  assert.equal(saved.status, "committed");
  assert.equal(saved.candidate.dataRevision, f.candidate.dataRevision + 1);
  assert.equal(sku.dataRevision, f.candidate.lifecycleV11.skuPackage.dataRevision);
  assert.deepEqual(sku.c1ProductPlan, f.candidate.lifecycleV11.skuPackage.c1ProductPlan);
  assert.deepEqual(saved.result.rightsView, { status: "verified", code: null });
  assert.deepEqual(record.review.rights.evidenceRefs, [sku.selectedSupplySnapshot.snapshotId, `${record.recordId}#/ownerDeclaration/rights`]);
  assert.equal(record.declaredByUserId, owner.userId);
  assert.equal(record.declaredAt, AT);
  assert.equal(record.review.sourceSkuRevision, sku.dataRevision);
  assert.equal(saved.result.paidCalls, 0);
  const resolved = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt: AT });
  assert.equal(resolved.status, "verified");
  const checked = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: resolved.review, verifiedAt: AT });
  assert.deepEqual(checked.c1ProductPlan.inputSnapshots.skuRightsReview, record.review);
  assert.equal(checked.skuPackage.dataRevision, sku.dataRevision + 1);
  const document = await repository.readSnapshot();
  assert.equal(document.runtime.softwareJobs.length, 0);
  assert.equal(Object.hasOwn(document.runtime, "softwareJobAuthorizationRecords"), false);
  assert.deepEqual(document.runtime.idempotencyRecords[0].result.rightsReviewRecord, record);
  const changedReview = structuredClone(resolved.review);
  changedReview.rights.basis = "owned";
  assert.throws(() => verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: changedReview, verifiedAt: AT }), hasCode("C1_RIGHTS_RECORD_DECLARATION_MISMATCH"));
});

test("known missing, blocked, permission-required and expired declarations persist without freezing or external calls", async () => {
  const pipelineSchema = JSON.parse(await readFile(new URL("../schema/c1-fact-keyword-pipeline-v1.schema.json", import.meta.url), "utf8"));
  const validatePipeline = new Ajv2020({ strict: true, allErrors: true }).compile(pipelineSchema);
  for (const [rights, dates, expected] of [
    [{ status: "unknown", basis: null }, {}, "unknown"],
    [{ status: "blocked", basis: null }, {}, "blocked"],
    [{ status: "requires_authorization", basis: null }, {}, "requires_authorization"],
    [{ status: "verified", basis: "licensed" }, { reviewedAt: "2026-08-10T13:00:00.000Z", expiresAt: AT }, "expired"]
  ]) {
    const f = fixture();
    Object.assign(f.input, { rights }, dates);
    const repository = createMemoryBusinessStateRepository(f.document);
    const saved = await useCase(repository).submit({ actor: owner, input: f.input });
    const skuPackage = saved.candidate.lifecycleV11.skuPackage;
    assert.equal(saved.result.rightsView.status, expected);
    assert.equal(skuPackage.c1ProductPlan.status, "inputs_ready");
    assert.equal(Object.hasOwn(skuPackage.c1ProductPlan.inputSnapshots, "skuRightsReview"), false);
    assert.equal(skuPackage.ownerAction, "review_compliance_risk");
    const producer = produceC1KeywordPlanningEvidence({ candidate: saved.candidate, expectedRevision: saved.candidate.dataRevision, serverEvidence: {}, producedAt: AT });
    assert.equal(producer.status, "not_ready");
    assert.equal(producer.production.execution.externalCallsPerformed, 0);
    assert.equal(producer.production.factsVerifiedFromFrozenInputs, false);
    const calls = [];
    const pipeline = await prepareC1FactKeywordPipeline({ candidateId: f.candidate.id, candidateRevision: saved.candidate.dataRevision,
      skuPackage, preparedAt: AT, keywordExpiresAt: EXPIRES }, {
      seerfarApi: async () => { calls.push("unexpected"); throw new Error("Unexpected external call"); }
    });
    assert.equal(pipeline.status, "not_ready");
    assert.equal(validatePipeline(pipeline), true, JSON.stringify(validatePipeline.errors));
    assert.equal(validatePipeline({ ...pipeline, status: "ready_for_atomic_persist" }), false);
    const orchestration = await runC1SoftwareOrchestration({ skuPackage, authorizedExecution: {}, startedAt: AT });
    assert.equal(orchestration.status, "not_ready");
    assert.equal(orchestration.exceptionCase, null);
    assert.deepEqual(calls, []);
  }
});

test("strict declaration record rejects arbitrary or changed source references and closed-schema pollution", () => {
  const f = fixture();
  const sku = f.candidate.lifecycleV11.skuPackage;
  const record = createC1SkuRightsReviewRecord({ plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity,
    sourceCandidateRevision: f.candidate.dataRevision, declaredByUserId: owner.userId, declaredAt: AT,
    ownerDeclaration: { brand: f.input.brand, rights: f.input.rights, reviewedAt: AT, expiresAt: EXPIRES } });
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(C1_SKU_RIGHTS_REVIEW_RECORD_SCHEMA);
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  for (const mutate of [
    r => r.review.rights.evidenceRefs[1] = "nonexistent:licence",
    r => r.ownerDeclaration.rights.basis = "owned",
    r => r.review.sourceIdentity.candidateId = "candidate:other",
    r => r.resultCandidateRevision += 1,
    r => r.ownerDeclaration.extra = true
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.equal(validateC1SkuRightsReviewRecord(changed).valid, false);
  }
  const polluted = { ...record, permission: "granted" };
  assert.equal(validate(polluted), false);
});

test("development/worker identity, unknown input fields, false scope and stale plan cannot save declarations", async () => {
  const f = fixture();
  for (const [actor, input, code] of [
    [{ ...owner, source: "development_default" }, f.input, "C1_RIGHTS_OWNER_REQUIRED"],
    [{ ...owner, actorType: "worker", roles: ["operator"] }, f.input, "C1_RIGHTS_OWNER_REQUIRED"],
    [owner, { ...f.input, evidenceRefs: ["unrecorded:licence"] }, "C1_RIGHTS_INPUT_INVALID"],
    [owner, { ...f.input, skuPackageId: "sku:other" }, "C1_RIGHTS_SCOPE_MISMATCH"],
    [owner, { ...f.input, expectedC1PlanId: "c1:other" }, "C1_RIGHTS_PLAN_CONFLICT"]
  ]) {
    const repository = createMemoryBusinessStateRepository(f.document);
    await assert.rejects(useCase(repository).submit({ actor, input }), hasCode(code));
    assert.deepEqual(await repository.readSnapshot(), f.document);
  }
});

test("same request is atomic and idempotent, differing decisions cannot reuse its key", async () => {
  const f = fixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  const service = useCase(repository);
  const results = await Promise.all([service.submit({ actor: owner, input: f.input }), service.submit({ actor: owner, input: f.input })]);
  assert.deepEqual(results.map(result => result.status).sort(), ["committed", "idempotent_replay"]);
  const saved = await repository.readSnapshot();
  assert.equal(saved.runtime.idempotencyRecords.length, 1);
  assert.equal(saved.runtime.operationAudit.length, 1);
  await assert.rejects(service.submit({ actor: owner, input: { ...f.input, rights: { status: "blocked", basis: null } } }), /BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test("a controlled replacement gets a new plan/revision, archives old null facts and requests, and preserves B", async () => {
  const f = fixture({ checked: true });
  f.candidate.lifecycleV11.c1AiDraftRequestV1 = structuredClone(f.formal.request);
  f.candidate.lifecycleV11.c1SoftwareEvidenceV1 = { evidenceId: "synthetic:c1-evidence" };
  f.candidate.lifecycleV11.status = "c1_evidence_ready";
  f.candidate.listingPreparation = { status: "c1_evidence_ready", decisionItems: [{ field: "old_seo" }] };
  const repository = createMemoryBusinessStateRepository(f.document);
  const saved = await useCase(repository).submit({ actor: owner, input: f.input });
  const before = f.candidate.lifecycleV11.skuPackage;
  const after = saved.candidate.lifecycleV11.skuPackage;
  assert.notEqual(after.c1ProductPlan.c1PlanId, before.c1ProductPlan.c1PlanId);
  assert.equal(after.dataRevision, before.dataRevision + 1);
  assert.equal(after.c1ProductPlan.status, "inputs_ready");
  assert.equal(after.c1ProductPlan.revisionRefs.sourceRevision, before.dataRevision);
  assert.equal(after.c1ProductPlan.revisionRefs.resultRevision, after.dataRevision);
  assert.equal(after.c1RightsReviewRecord.review.sourceSkuRevision, after.dataRevision);
  assert.deepEqual(after.profitModels, before.profitModels);
  assert.deepEqual(after.selectedSupplySnapshot, before.selectedSupplySnapshot);
  assert.equal(after.activeProfitModelVersion, before.activeProfitModelVersion);
  assert.deepEqual(saved.result.supersededC1.c1ProductPlan, before.c1ProductPlan);
  assert.deepEqual(saved.result.supersededC1.c1Artifacts.c1AiDraftRequestV1, f.formal.request);
  assert.equal(Object.hasOwn(saved.candidate.lifecycleV11, "c1AiDraftRequestV1"), false);
  assert.equal(Object.hasOwn(saved.candidate.lifecycleV11, "c1SoftwareEvidenceV1"), false);
  assert.equal(saved.candidate.lifecycleV11.status, "c1_inputs_ready");
  assert.equal(saved.candidate.listingPreparation.status, "c1_inputs_ready");
  assert.deepEqual(saved.candidate.listingPreparation.decisionItems, []);
  assert.deepEqual(saved.result.supersededC1.listingPreparation, f.candidate.listingPreparation);
  assert.throws(() => assertCurrentC1AiDraftRequest({ skuPackage: after, request: f.formal.request }), /C1_AI_REQUEST_GATE_REJECTED/);
  const state = await repository.readSnapshot();
  assert.deepEqual(state.runtime.idempotencyRecords[0].result.supersededC1, saved.result.supersededC1);
  assert.equal(after.c1ProductPlan.supersedes.historyRef, `business-idempotency:${f.input.idempotencyKey}#/result/supersededC1`);
});

test("frozen plans require an explicit matching replacement and active/unknown jobs prevent replacement", async () => {
  const f = fixture({ checked: true });
  const repository = createMemoryBusinessStateRepository(f.document);
  await assert.rejects(useCase(repository).submit({ actor: owner, input: { ...f.input, replacesC1PlanId: null } }), hasCode("C1_RIGHTS_REPLACEMENT_REQUIRED"));
  for (const [status, externalRequestState] of [["queued", "not_sent"], ["claimed", "in_flight"], ["waiting_platform", "in_flight"], ["unknown_outcome", "unknown_outcome"]]) {
    const document = structuredClone(f.document);
    document.runtime.softwareJobs.push({ ...c1AiSoftwareJobFixture({ formalDraftFixture: f.formal }).job, status, externalRequestState });
    const guarded = createMemoryBusinessStateRepository(document);
    await assert.rejects(useCase(guarded).submit({ actor: owner, input: f.input }), hasCode("C1_RIGHTS_ACTIVE_JOB_BLOCKED"));
    assert.deepEqual(await guarded.readSnapshot(), document);
  }
});

test("JSON restart retains the owner record and replay; failed persistence leaves the old document intact", async t => {
  const f = fixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "c1-rights-submission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, "state.json");
  await writeFile(dataFile, JSON.stringify(f.document));
  const repository = createJsonBusinessStateRepository({ filePath: dataFile });
  const saved = await useCase(repository).submit({ actor: owner, input: f.input });
  const restarted = createJsonBusinessStateRepository({ filePath: dataFile });
  const replay = await useCase(restarted).submit({ actor: owner, input: f.input });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(replay.result.rightsReviewRecord, saved.result.rightsReviewRecord);
  const bytes = await readFile(dataFile, "utf8");
  const failing = createJsonBusinessStateRepository({ filePath: dataFile, atomicWriter: async () => { throw new Error("synthetic persistence failure"); } });
  const nextInput = { ...f.input, expectedRevision: f.input.expectedRevision + 1, idempotencyKey: "rights:synthetic:next" };
  await assert.rejects(useCase(failing).submit({ actor: owner, input: nextInput }), /synthetic persistence failure/);
  assert.equal(await readFile(dataFile, "utf8"), bytes);
});

test("job admission is read under the transaction lock, not from a pre-transaction snapshot", async () => {
  const f = fixture({ checked: true });
  const repository = createMemoryBusinessStateRepository(f.document);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const priorWriter = repository.transact(async document => {
    await blocked;
    document.runtime.softwareJobs.push(c1AiSoftwareJobFixture({ formalDraftFixture: f.formal }).job);
    return { changed: true, document, result: null };
  });
  const submission = useCase(repository).submit({ actor: owner, input: f.input });
  release();
  await priorWriter;
  await assert.rejects(submission, hasCode("C1_RIGHTS_ACTIVE_JOB_BLOCKED"));
  const current = await repository.readSnapshot();
  assert.deepEqual(current.candidates[0], f.candidate);
  assert.equal(Object.hasOwn(current.runtime, "idempotencyRecords"), false);
});

test("replacement does not rewrite terminal receipts and preserves other candidates", async () => {
  const f = fixture({ checked: true });
  const job = { ...c1AiSoftwareJobFixture({ formalDraftFixture: f.formal }).job, status: "failed", externalRequestState: "succeeded",
    resultEnvelope: { resultRef: "receipt:synthetic:completed", payload: { receipt: f.formal.receipt } } };
  f.document.runtime.softwareJobs.push(job);
  f.candidate.lifecycleV11.c1AiDraftJobRefV1 = { jobId: job.jobId };
  f.candidate.lifecycleV11.c1AiDraftRequestV1 = structuredClone(f.formal.request);
  const other = { id: "candidate:unrelated", dataRevision: 12, workflowStatus: "unrelated" };
  f.document.candidates.push(other);
  const repository = createMemoryBusinessStateRepository(f.document);
  const result = await useCase(repository).submit({ actor: owner, input: f.input });
  const current = await repository.readSnapshot();
  assert.deepEqual(current.runtime.softwareJobs, [job]);
  assert.deepEqual(current.candidates[1], other);
  assert.deepEqual(result.result.supersededC1.c1Artifacts.c1AiDraftJobRefV1, { jobId: job.jobId });
});

test("old v1.1 plans are replaced without mutating their historical version or frozen B inputs", async () => {
  const f = fixture({ checked: true });
  const plan = f.candidate.lifecycleV11.skuPackage.c1ProductPlan;
  plan.factVerificationVersion = "c1-fact-verification-v1.1";
  delete plan.inputSnapshots.skuRightsReview;
  delete plan.platformCompliance.skuRightsReview;
  const repository = createMemoryBusinessStateRepository(f.document);
  const result = await useCase(repository).submit({ actor: owner, input: f.input });
  assert.deepEqual(result.result.supersededC1.c1ProductPlan, plan);
  assert.equal(result.result.supersededC1.c1ProductPlan.factVerificationVersion, "c1-fact-verification-v1.1");
  assert.equal(result.candidate.lifecycleV11.skuPackage.c1ProductPlan.factVerificationVersion, null);
  assert.deepEqual(result.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots, plan.inputSnapshots);
});

test("a conflicting brand declaration is saved as a blocked business result, not converted into platform clearance", async () => {
  const f = fixture({ skuAttributes: { brand: "Synthetic source brand" } });
  const repository = createMemoryBusinessStateRepository(f.document);
  const result = await useCase(repository).submit({ actor: owner, input: f.input });
  assert.deepEqual(result.result.rightsView, { status: "blocked", code: "C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT" });
  assert.equal(result.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(result.result.rightsReviewRecord.ownerDeclaration.brand.name, f.input.brand.name);
  assert.deepEqual(result.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot, f.candidate.lifecycleV11.skuPackage.selectedSupplySnapshot);
});

test("「做这件」卡上的声明：C1 计划生成后由软件原样记下，声明人仍是主人；没有许可、老许可、过期、已冻结或已声明都不记", async () => {
  const { GATE1_AUTOPILOT_ACTOR_SOURCE, GATE1_AUTOPILOT_ACTOR_USER_ID, buildGate1AutopilotGrant } = await import("../lib/gate1-autopilot.mjs");
  const { buildGate1RightsDeclaration } = await import("../lib/gate1-rights-declaration.mjs");
  const DECLARED = "2026-08-12T12:00:00.000Z";
  const software = createActorContext({ userId: GATE1_AUTOPILOT_ACTOR_USER_ID, sessionId: "gate1-autopilot:rights", actorType: "software",
    roles: ["operator"], source: GATE1_AUTOPILOT_ACTOR_SOURCE, authenticatedAt: AT });
  const decision = { decision: "accept", decidedAt: DECLARED, roundIndex: 0 };
  function prepared({ checked = false, grant = "v3" } = {}) {
    const f = fixture({ checked });
    f.candidate.gate1DecisionV1 = decision;
    if (grant) {
      const built = buildGate1AutopilotGrant({ candidateId: f.candidate.id, sourceRevision: 1, decision, via: "gate1_accept",
        grantedAt: DECLARED, grantedBy: owner.userId });
      f.candidate.gate1AutopilotGrantV1 = grant === "v2" ? { ...built, scopeVersion: "gate1-autopilot-scope-v2",
        scope: built.scope.filter(step => step !== "c1_apply_rights") } : structuredClone(built);
    }
    f.candidate.gate1RightsDeclarationV1 = structuredClone(buildGate1RightsDeclaration({ candidateId: f.candidate.id, sourceRevision: 1,
      input: { brandStatus: "unbranded", brandName: null, rights: "no_third_party_rights_identified", validMonths: 3 }, decision,
      declaredByUserId: owner.userId, declaredAt: DECLARED }));
    const sku = f.candidate.lifecycleV11.skuPackage;
    const input = { candidateId: f.candidate.id, skuPackageId: sku.skuPackageId, expectedRevision: f.candidate.dataRevision,
      expectedC1PlanId: sku.c1ProductPlan.c1PlanId, idempotencyKey: `gate1-autopilot:c1_apply_rights:${f.candidate.dataRevision}`,
      auditEventId: `gate1-autopilot-audit:c1_apply_rights:${f.candidate.dataRevision}` };
    return { ...f, applyInput: input, repository: createMemoryBusinessStateRepository(f.document) };
  }
  const none = prepared({ grant: null });
  await assert.rejects(useCase(none.repository).applyGate1Declaration({ actor: software, input: none.applyInput }), hasCode("C1_RIGHTS_GATE1_GRANT_REQUIRED"));
  const old = prepared({ grant: "v2" });
  await assert.rejects(useCase(old.repository).applyGate1Declaration({ actor: software, input: old.applyInput }), hasCode("C1_RIGHTS_GATE1_GRANT_REQUIRED"));
  const f = prepared();
  await assert.rejects(useCase(f.repository).applyGate1Declaration({ actor: owner, input: f.applyInput }), hasCode("C1_RIGHTS_GATE1_SOFTWARE_ONLY"));
  await assert.rejects(useCase(f.repository).applyGate1Declaration({ actor: software, input: { ...f.applyInput, brand: f.input.brand } }),
    hasCode("C1_RIGHTS_INPUT_INVALID"));
  await assert.rejects(useCase(f.repository, () => "2026-11-12T12:00:00.000Z").applyGate1Declaration({ actor: software, input: f.applyInput }),
    hasCode("C1_RIGHTS_GATE1_DECLARATION_UNAVAILABLE"), "三个月过了就不记");
  assert.equal((await f.repository.readSnapshot()).candidates[0].dataRevision, f.candidate.dataRevision, "被拒的什么都没改");

  const saved = await useCase(f.repository).applyGate1Declaration({ actor: software, input: f.applyInput });
  assert.equal(saved.status, "committed");
  const sku = saved.candidate.lifecycleV11.skuPackage;
  const record = sku.c1RightsReviewRecord;
  assert.equal(saved.candidate.dataRevision, f.candidate.dataRevision + 1);
  assert.equal(saved.candidate.lastModifiedBy, "software");
  assert.equal(record.declaredByUserId, owner.userId, "声明人仍是主人");
  assert.equal(record.declaredAt, AT);
  assert.deepEqual(record.ownerDeclaration, { brand: { status: "unbranded", name: null },
    rights: { status: "verified", basis: "no_third_party_rights_identified" }, reviewedAt: DECLARED, expiresAt: "2026-11-12T12:00:00.000Z" });
  assert.deepEqual(saved.result.rightsView, { status: "verified", code: null });
  assert.equal(saved.result.gate1DeclarationId, f.candidate.gate1RightsDeclarationV1.declarationId);
  assert.deepEqual(sku.c1ProductPlan, f.candidate.lifecycleV11.skuPackage.c1ProductPlan, "不替换计划");
  assert.equal(resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt: AT }).status, "verified");
  const again = { ...f.applyInput, expectedRevision: saved.candidate.dataRevision, idempotencyKey: "gate1-autopilot:again", auditEventId: "gate1-autopilot-audit:again" };
  await assert.rejects(useCase(f.repository).applyGate1Declaration({ actor: software, input: again }), hasCode("C1_RIGHTS_GATE1_ALREADY_DECLARED"));

  const frozen = prepared({ checked: true });
  await assert.rejects(useCase(frozen.repository).applyGate1Declaration({ actor: software, input: frozen.applyInput }), hasCode("C1_RIGHTS_GATE1_PLAN_FROZEN"));
});
