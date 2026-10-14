import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from "./helpers/d-e-saved-api-fixture.mjs";

const { api: port } = allocatedTestPorts();

function localPreparationCandidate() {
  const candidate = structuredClone(createFormalC1DraftFixture({ at: "2026-08-25T08:00:00.000Z" }).candidate);
  const sku = candidate.lifecycleV11.skuPackage;
  const definitions = [
    ["8229", "Тип", "3D-пазл", "platformCategory.categoryName"],
    ["4967", "Материал", "Дерево", "productAttributes.material"],
    ["10096", "Цвет", "разноцветный", "productAttributes.supplierAttributes.0.fact"],
    ["9048", "Модель", "AL-123", "productAttributes.supplierAttributes.1.fact"]
  ];
  sku.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes = definitions.map(([id, label]) => ({
    fieldKey: id, label, dictionaryId: 1, required: id === "8229"
  }));
  sku.ozonAttributeMappingsV1 = {
    schemaRevision: sku.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision,
    confirmationRef: "owner:mapping:synthetic-local-api",
    mappings: definitions.map(([id, label, value, sourceFactPath]) => ({
      attributeId: id, attributeLabel: label, value, sourceFactValue: id === "10096" ? "红,蓝" : value,
      sourceFactPath, dictionaryEvidenceRef: `dictionary:${id}`
    }))
  };
  sku.c1ProductPlan.productAttributes.ozonAttributes = sku.ozonAttributeMappingsV1.mappings.map(mapping => ({
    fieldKey: mapping.attributeId,
    fact: { value: { value: mapping.value, dictionaryValueId: 12 }, verificationStatus: "confirmed", sourceRefs: [mapping.dictionaryEvidenceRef] }
  }));
  candidate.sourceCapture = {
    selectedSkuIds: [sku.supplierSkuId, "OTHER-COLOUR"],
    skuChoices: [{ sourceSkuId: sku.supplierSkuId, attributes: { 颜色: "红", 规格: "红>均码" } }]
  };
  candidate.lifecycleV11.opportunityPackage.salesSnapshots = [];
  candidate.salesSnapshotsV11 = [];
  return candidate;
}

test("saved material preparation enforces owner and revision boundaries and persists without downstream work", async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const candidate = localPreparationCandidate();
  const document = { ...fixture.document, candidates: [candidate], runtime: {}, evidencePacks: [], dispatches: [] };
  const directory = await mkdtemp(path.join(tmpdir(), "c1-local-preparation-api-"));
  const api = await startSavedDEApi(t, {
    directory, port, document, binding: { storeRef: candidate.storeRef, platform: candidate.targetPlatform }, productionBindings: []
  });
  const route = `/api/candidates/${candidate.id}/lifecycle/c1/continue-preparation`;
  const input = { candidateId: candidate.id, dataRevision: candidate.dataRevision, mode: "saved_material_only" };
  const originalBytes = await api.readBytes();

  await t.test("unauthenticated requests cannot prepare or mutate", async () => {
    const response = await api.post(route, input, { authenticated: false });
    assert.equal(response.status, 401, JSON.stringify(response.body));
    assert.equal(response.body.code, "OWNER_LOGIN_REQUIRED");
    assert.deepEqual(await api.readBytes(), originalBytes);
    assert.equal(api.dependencyRequests(), 0);
  });

  await api.authenticate();
  await t.test("stale revisions and unknown modes cannot mutate", async () => {
    for (const [request, expectedStatus] of [
      [{ ...input, dataRevision: input.dataRevision - 1 }, 409],
      [{ ...input, mode: "unsupported_preparation" }, 400],
      [{ ...input, extra: "unexpected" }, 400]
    ]) {
      const response = await api.post(route, request);
      assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
      assert.deepEqual(await api.readBytes(), originalBytes);
    }
  });

  let savedBytes;
  let savedCandidate;
  await t.test("local material is durable and leaves the entire SKU and external queues unchanged", async () => {
    const concurrent = await Promise.all([api.post(route, input), api.post(route, input)]);
    assert.equal(concurrent.filter(response => response.body.status === "committed").length, 1);
    const response = concurrent.find(response => response.body.status === "committed");
    const duplicate = concurrent.find(result => result !== response);
    if (duplicate.status === 200) {
      assert.equal(duplicate.body.status, "idempotent_replay");
      assert.equal(duplicate.body.candidate.dataRevision, response.body.candidate.dataRevision);
      assert.deepEqual(duplicate.body.result, response.body.result);
    } else {
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    }
    assert.equal(response.body.status, "committed");
    assert.equal(response.body.result.status, "ready");
    assert.equal(response.body.externalRequests, 0);
    assert.equal(response.body.platformWrites, 0);
    assert.equal(response.body.paidCalls, 0);
    assert.deepEqual(response.body.result.sideEffects, {
      externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0
    });
    const saved = await api.readDocument();
    savedCandidate = saved.candidates[0];
    assert.equal(savedCandidate.dataRevision, candidate.dataRevision + 1);
    assert.deepEqual(savedCandidate.lifecycleV11.skuPackage, candidate.lifecycleV11.skuPackage,
      "preparation must preserve B, C1 draft, C2, production authorization, D and E");
    assert.deepEqual(savedCandidate.lifecycleV11.opportunityPackage, candidate.lifecycleV11.opportunityPackage);
    assert.deepEqual(savedCandidate.sourceCapture, candidate.sourceCapture);
    assert.equal(savedCandidate.lifecycleV11.c1AiDraftRequestV1, undefined);
    assert.equal(saved.runtime.softwareJobs?.length ?? 0, 0);
    assert.deepEqual(saved.dispatches, []);
    const material = savedCandidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1;
    assert.equal(material.schemaVersion, "c1-local-preparation-v2");
    assert.equal(material.mode, "saved_material_only");
    assert.equal(material.preparationOnly, true);
    assert.equal(material.reusableKeywordSnapshot, null);
    assert.deepEqual(material.keywords.map(keyword => keyword.term), ["3D-пазл", "Дерево"]);
    assert.ok(material.keywords.every(keyword => keyword.searchVolume === null && keyword.conversion === null && keyword.sourceRefs.length > 0));
    assert.equal(material.attributes.find(attribute => attribute.fieldKey === "10096").status, "scope_unresolved");
    assert.equal(material.sourceCandidateRevision, input.dataRevision);
    assert.equal(material.resultCandidateRevision, savedCandidate.dataRevision);
    assert.deepEqual(response.body.candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1, material);
    savedBytes = await api.readBytes();
  });

  await t.test("replay and service restart retain one result without new jobs or revisions", async () => {
    const currentInput = { ...input, dataRevision: savedCandidate.dataRevision };
    for (const response of await Promise.all([api.post(route, currentInput), api.post(route, currentInput)])) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.status, "already_current");
      assert.equal(response.body.candidate.dataRevision, savedCandidate.dataRevision);
    }
    assert.deepEqual(await api.readBytes(), savedBytes);
    const stale = await api.post(route, input);
    assert.equal(stale.status, 409);
    assert.deepEqual(await api.readBytes(), savedBytes);
    await api.restart();
    await api.authenticate("login");
    const state = await api.get("/api/state");
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.candidates[0].lifecycleV11.c1KeywordPlanningLocalMaterialV1,
      savedCandidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1);
    const replay = await api.post(route, currentInput);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.status, "already_current");
    assert.deepEqual(await api.readBytes(), savedBytes);
  });
  await api.assertClean();
});
