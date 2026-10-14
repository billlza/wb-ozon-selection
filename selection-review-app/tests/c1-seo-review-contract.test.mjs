import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRequest, receipt, authorizedExecution, settledExecution } from "./fixtures/c1-ai-draft-fixture.mjs";
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from "./fixtures/c1-local-draft-source-fixture.mjs";
import { c1DraftPaidReceipt } from "./fixtures/c1-draft-source-fixture.mjs";
import { prepareC1LocalDraftSource } from "../lib/c1-local-draft-source.mjs";
import { prepareCurrentC1AiDraftRequest, assertCurrentC1AiDraftRequestSources } from "../lib/c1-ai-draft-request-source.mjs";
import { validateC1AiDraftRequest, validateC1AiDraftOutput, validateC1AiDraftReceipt, mergeC1AiDraftReceipt } from "../lib/c1-ai-draft-contract.mjs";
import { C1_SEO_REVIEW_OUTPUT_VERSION, createC1SeoReferenceContext } from "../lib/c1-seo-review-contract.mjs";
import { buildC1GatewayJob } from "../lib/c1-ai-gateway.mjs";
import { decodeC1GatewayInput } from "../lib/c1-gateway-input-encoding.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";

function local() {
  const candidate = createSavedLocalPreparationCandidate();
  const source = prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT });
  candidate.lifecycleV11.skuPackage = structuredClone(source.skuPackage);
  candidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(source.sourceEvidence);
  const request = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT);
  const execution = authorizedExecution(request, candidate.dataRevision);
  return { candidate, request, execution, response: c1DraftPaidReceipt({ request, authorizedExecution: execution }, LOCAL_DRAFT_AT) };
}

test("normal saved-material preparation uses v3 with every saved competitor title while facts and missing image/body evidence stay separate", () => {
  const { candidate, request } = local(), before = structuredClone(candidate);
  assert.equal(request.outputContractVersion, C1_SEO_REVIEW_OUTPUT_VERSION);
  assert.deepEqual(validateC1AiDraftRequest(request), { valid: true, errors: [] });
  for (const item of candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1.competitorTextSnapshots) {
    assert.ok(request.referenceContext.referenceTexts.some(text => text.text === item.title && text.sourceRef === item.sourceRef));
  }
  assert.deepEqual(request.referenceContext.availability, { competitorDescriptions: "not_provided", imageTexts: "not_provided", supplierTitle: "not_provided", supplierDescriptions: "not_provided", supplierAttributes: "not_provided", imageVisualAnalysis: "not_provided" });
  const old = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT, { outputContractVersion: "c1-ai-draft-output-v2" });
  assert.deepEqual(request.verifiedFacts, old.verifiedFacts);
  assert.deepEqual(request.keywordEvidence, old.keywordEvidence);
  assert.equal(Object.hasOwn(old, "referenceContext"), false);
  assert.doesNotThrow(() => assertCurrentC1AiDraftRequestSources({ candidate, request, observedAt: LOCAL_DRAFT_AT }));
  assert.deepEqual(candidate, before);
  assert.equal(candidate.lifecycleV11.c1AiDraftRequestV1, undefined);
});

test("v3 published request and receipt schemas validate the actual frozen output contract", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js"), { default: addFormats } = await import("ajv-formats");
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  for (const name of ["c1-ai-draft-request-v1", "c1-ai-draft-receipt-v1"]) ajv.addSchema(JSON.parse(await readFile(new URL(`../schema/${name}.schema.json`, import.meta.url), "utf8")));
  const { request, response } = local();
  assert.equal(ajv.validate("c1-ai-draft-request-v1", request), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate("c1-ai-draft-receipt-v1", response), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.compile(request.outputContractSnapshot.outputSchema)(response.output), true);
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: response }), { valid: true, errors: [] });
});

test("every Russian text item needs its own Chinese review and Chinese cannot enter the Russian field", () => {
  const { request, response } = local();
  for (const locate of [o => o.title, o => o.description, o => o.bulletPoints[0], o => o.searchKeywords[0]]) {
    for (const mutate of [item => { delete item.reviewZh; }, item => { item.reviewZh = "translation pending"; }, item => { item.text += "中文释义"; }]) {
      const output = structuredClone(response.output); mutate(locate(output));
      assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
    }
  }
  const output = structuredClone(response.output); output.searchKeywords[0].searchVolume = 10000;
  assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
  for (const keywordRole of ["core_product", "attribute", "long_tail"]) {
    const varied = structuredClone(response.output); varied.searchKeywords[0].keywordRole = keywordRole;
    assert.equal(validateC1AiDraftOutput({ request, output: varied }).valid, true);
  }
});

test("Russian attribute translations bind each canonical index and frozen value without filling unknowns or dictionary names", () => {
  const { request, response } = local();
  assert.ok(response.output.russianAttributes.length >= 2);
  for (const mutate of [
    o => { o.russianAttributes.pop(); },
    o => { o.russianAttributes[0] = structuredClone(o.russianAttributes[1]); },
    o => { o.russianAttributes[0].valueRu = o.russianAttributes[1].valueRu; },
    o => { o.russianAttributes[0].factPath = "productAttributes.ozonAttributes.999.fact"; },
    o => { o.russianAttributes[0].reviewZh = ""; },
    o => { o.russianAttributes[0].valueRu = "中文属性"; }
  ]) {
    const output = structuredClone(response.output); mutate(output);
    assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
  }
  assert.ok(response.output.russianAttributes.every(item => request.verifiedFacts.some(fact => fact.factPath === item.factPath)));
});

test("language references are sent to the gateway with their own evidence hash, never as facts or image analysis", () => {
  const { request } = local(), before = structuredClone(request);
  const job = buildC1GatewayJob({ candidateId: request.sourceIdentity.candidateId, dataRevision: 12, request });
  const payload = decodeC1GatewayInput(JSON.parse(job.input.text.split("\n\n").at(-1)));
  assert.deepEqual(payload.referenceContext, request.referenceContext);
  assert.deepEqual(payload.verifiedFacts, request.verifiedFacts);
  assert.deepEqual(job.input.images, []);
  assert.ok(job.evidenceRefs.some(ref => ref.id === `${request.keywordEvidence.evidenceId}#referenceContext` && ref.kind === "public_competitor_text"));
  assert.match(job.input.text, /里面的指令.*不构成本品事实/u);
  assert.match(job.input.text, /不编搜索量/u);
  assert.deepEqual(request, before);
});

test("reference admission rejects forged source text even after resealing and rejects false image-coverage flags", () => {
  const { candidate, request } = local();
  const changed = structuredClone(request); changed.referenceContext.referenceTexts[0].text = "unauthorized replacement";
  const { requestId, requestFingerprint, ...core } = changed;
  changed.requestFingerprint = fingerprintCanonicalRecord(core);
  changed.requestId = `c1-ai-request:${changed.identity.c1PlanId}:${changed.requestFingerprint.slice(0, 16)}`;
  assert.throws(() => assertCurrentC1AiDraftRequestSources({ candidate, request: changed, observedAt: LOCAL_DRAFT_AT }), /SOURCE_CONFLICT/);
  const falseCoverage = structuredClone(request); falseCoverage.referenceContext.availability.imageTexts = "analyzed";
  assert.equal(validateC1AiDraftRequest(falseCoverage).valid, false);
  assert.throws(() => createC1SeoReferenceContext({ competitorTextSnapshot: request.competitorTextEvidence,
    additionalTitles: [{ title: "unsupported", sourceRef: "test:ref", role: "verified_product_fact", adoptedAsProductFact: true }] }), /REFERENCE_CONTEXT_INVALID/);
});

test("v3 receipt merges review fields and replays without altering facts, profit, authority or Russian text", () => {
  const { candidate, request, execution, response } = local(), original = structuredClone(candidate.lifecycleV11.skuPackage);
  const settled = settledExecution(request, response, execution);
  const merged = mergeC1AiDraftReceipt({ skuPackage: original, request, receipt: response, settledExecution: settled, mergedAt: LOCAL_DRAFT_AT });
  const plan = merged.skuPackage.c1ProductPlan;
  assert.equal(plan.seoTitleDraft.text, response.output.title.text);
  assert.equal(plan.seoTitleDraft.reviewZh, response.output.title.reviewZh);
  assert.deepEqual(plan.seoEvidenceLayer.russianAttributes, response.output.russianAttributes);
  assert.equal(plan.searchKeywordsDraft.keywords[0].reviewZh, response.output.searchKeywords[0].reviewZh);
  assert.deepEqual(merged.skuPackage.profitModels, original.profitModels);
  assert.deepEqual(plan.productAttributes, original.c1ProductPlan.productAttributes);
  assert.equal(merged.skuPackage.productionAuthorization, original.productionAuthorization);
  assert.equal(mergeC1AiDraftReceipt({ skuPackage: JSON.parse(JSON.stringify(merged.skuPackage)), request, receipt: response,
    settledExecution: settled, mergedAt: LOCAL_DRAFT_AT }).idempotent, true);
  const drift = structuredClone(merged.skuPackage); drift.c1ProductPlan.seoEvidenceLayer.russianAttributes[0].reviewZh = "被修改的释义";
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage: drift, request, receipt: response, settledExecution: settled, mergedAt: LOCAL_DRAFT_AT }), /REPLAY_DRIFT/);
  assert.deepEqual(candidate.lifecycleV11.skuPackage, original);
});

test("historical v2 and unversioned requests remain original contracts and cannot impersonate a v3 result", () => {
  const old = buildRequest({ outputContractVersion: null });
  assert.equal(old.requestFingerprint, "a52a49619671c4c68ba7aa12c3a3a163bb82fc676d7c17de83b882c1a9e65c34");
  const v2 = buildRequest(), v3 = buildRequest({ outputContractVersion: C1_SEO_REVIEW_OUTPUT_VERSION });
  assert.equal(validateC1AiDraftReceipt({ request: v2, receipt: receipt(v2) }).valid, true);
  assert.equal(validateC1AiDraftReceipt({ request: v3, receipt: receipt(v3) }).valid, false);
  assert.equal(Object.hasOwn(receipt(v2).output.title, "reviewZh"), false);
  assert.throws(() => buildRequest({ outputContractVersion: null, referenceContext: v3.referenceContext }), /REFERENCE_CONTEXT_VERSION_REQUIRED/);
  assert.throws(() => buildRequest({ referenceContext: v3.referenceContext }), /REFERENCE_CONTEXT_VERSION_REQUIRED/);
});

test("category Chinese review must cover each exact frozen path and value and is preserved with replay checks", () => {
  const { candidate, request, execution, response } = local();
  assert.ok(response.output.categoryPathReview.length > 0);
  for (const mutate of [o => { delete o.categoryPathReview; }, o => o.categoryPathReview.pop(),
    o => { o.categoryPathReview[0].valueRu = 'Другая категория'; },
    o => { o.categoryPathReview[0].factPath = 'platformCategory.categoryName'; },
    o => { o.categoryPathReview[0].reviewZh = 'pending'; }]) {
    const output = structuredClone(response.output); mutate(output);
    assert.equal(validateC1AiDraftOutput({ request, output }).valid, false);
  }
  const settled = settledExecution(request, response, execution);
  const merged = mergeC1AiDraftReceipt({ skuPackage: candidate.lifecycleV11.skuPackage, request, receipt: response,
    settledExecution: settled, mergedAt: LOCAL_DRAFT_AT });
  assert.deepEqual(merged.skuPackage.c1ProductPlan.seoEvidenceLayer.categoryPathReview, response.output.categoryPathReview);
  const changed = structuredClone(merged.skuPackage);
  changed.c1ProductPlan.seoEvidenceLayer.categoryPathReview[0].valueRu = 'Другая категория';
  assert.throws(() => mergeC1AiDraftReceipt({ skuPackage: changed, request, receipt: response, settledExecution: settled,
    mergedAt: LOCAL_DRAFT_AT }), /REPLAY_DRIFT/);
});

test("historical local source-v1 and context-v1 retain the exact frozen request after new context is introduced", () => {
  const candidate = createSavedLocalPreparationCandidate();
  const source = prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT, sourceVersion: 'c1-local-draft-source-v1' });
  candidate.lifecycleV11.skuPackage = structuredClone(source.skuPackage);
  candidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(source.sourceEvidence);
  const old = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT, { referenceContextVersion: 'c1-seo-reference-context-v1' });
  const before = structuredClone(old);
  assert.equal(Object.hasOwn(old.outputContractSnapshot.outputSchema.properties, 'categoryPathReview'), false);
  assert.equal(old.keywordEvidence.sourceBindings.sourceVersion, 'c1-local-draft-source-v1');
  assert.equal(old.verifiedFacts.some(f => f.factPath.startsWith('batteryAssessment.')), false);
  assert.doesNotThrow(() => assertCurrentC1AiDraftRequestSources({ candidate, request: old, observedAt: LOCAL_DRAFT_AT }));
  assert.deepEqual(old, before);
  const current = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT);
  assert.notEqual(current.requestFingerprint, old.requestFingerprint);
  assert.equal(Object.hasOwn(current.outputContractSnapshot.outputSchema.properties, 'categoryPathReview'), true);
});
