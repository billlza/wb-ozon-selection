import test from "node:test";
import assert from "node:assert/strict";
import { createFormalC1DraftFixture, createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { executeBusinessMutation } from "../lib/business-mutation-transaction.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { createC1SiblingColorRevisionUseCase, prepareC1SiblingColorRevision } from "../lib/c1-sibling-color-revision-use-case.mjs";
import { createC1OzonAttributeMappingUseCase } from "../lib/c1-ozon-attribute-mapping-use-case.mjs";
import { assertSiblingSkuColorProjection } from "../lib/sibling-sku-card-guard.mjs";
import { createC1ColorDictionaryReadUseCase } from '../lib/c1-color-dictionary-read-use-case.mjs';
import { siblingColorSchemaPack, siblingColorState } from './fixtures/sibling-color-state.mjs';
import { createInternalEvidenceValidity, inspectLifecycleEvidenceValidity } from '../lib/lifecycle-evidence-validity.mjs';

const AT = "2026-08-12T13:00:00.000Z";

function siblingInput() {
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  const candidate = structuredClone(fixture.candidate);
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.created.skuPackage);
  candidate.sourceCapture = { skuChoices: [{ sourceSkuId: candidate.lifecycleV11.skuPackage.supplierSkuId,
    attributes: { 颜色: "黑cp" } }] };
  candidate.siblingSourceV1 = { supplierSkuId: candidate.lifecycleV11.skuPackage.supplierSkuId,
    parentCandidateId: "candidate:synthetic-parent", parentCardBinding: {
      descriptionCategoryId: 17028665, typeId: 92935, model: "synthetic-model", brand: "synthetic-brand",
      parentImageSha256s: ["a".repeat(64)] } };
  return { candidate, rights: fixture.checked.c1ProductPlan.inputSnapshots.skuRightsReview };
}

test("missing sibling colors cannot durably freeze C1 facts while mapping remains editable", async () => {
  const { candidate, rights } = siblingInput();
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-c1-color", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const original = await repository.readSnapshot();
  await assert.rejects(() => executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "c1_verify_facts_from_owner_declaration",
    candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, idempotencyKey: "synthetic:sibling-freeze",
    inputFingerprint: "synthetic:sibling-freeze", auditEventId: "synthetic:sibling-freeze-audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage = verifyC1ProductFacts({ skuPackage: staged.lifecycleV11.skuPackage,
        skuRightsReview: rights, verifiedAt: AT }).skuPackage;
      return { candidate: staged, result: { status: "facts_checked" } };
    } }), /SIBLING_COLOR_BINDING_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), original);
  assert.equal((await repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
});

test("ordinary SKU fact freeze remains available without sibling color mappings", async () => {
  const { candidate, rights } = siblingInput();
  delete candidate.siblingSourceV1;
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "ordinary-c1", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const frozen = await executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "c1_verify_ordinary_facts",
    candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, idempotencyKey: "synthetic:ordinary-freeze",
    inputFingerprint: "synthetic:ordinary-freeze", auditEventId: "synthetic:ordinary-freeze-audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage = verifyC1ProductFacts({ skuPackage: staged.lifecycleV11.skuPackage,
        skuRightsReview: rights, verifiedAt: AT }).skuPackage;
      return { candidate: staged, result: { status: "facts_checked" } };
    } });
  assert.equal(frozen.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "facts_checked");
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, candidate.dataRevision + 1);
});

test("frozen sibling color gap creates a new editable C1 revision with an immutable predecessor", async () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.checked.skuPackage);
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-revision", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const useCase = createC1SiblingColorRevisionUseCase({ repository, runtimeMode: "local_development", serverClock: () => AT });
  const input = { candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision };
  const first = await useCase.prepare({ actor, input });
  assert.equal(first.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.notEqual(first.candidate.lifecycleV11.skuPackage.c1ProductPlan.c1PlanId,
    candidate.lifecycleV11.skuPackage.c1ProductPlan.c1PlanId);
  assert.equal(first.candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1, undefined);
  const document = await repository.readSnapshot();
  assert.deepEqual(document.c1SiblingColorRevisionHistoryRecords[0].previousSkuPackage,
    candidate.lifecycleV11.skuPackage);
  assert.equal((await useCase.prepare({ actor, input })).status, "idempotent_replay");
  assert.equal((await repository.readSnapshot()).c1SiblingColorRevisionHistoryRecords.length, 1);
});

test("owner maps both schema typed colors before a sibling C1 freeze", async () => {
  const { candidate, rights } = siblingInput();
  candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.ruleVersion = 'ozon-current';
  candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes = [
    { fieldKey: "10096", label: "Цвет товара", labelZh: "商品颜色", required: false, complexId: 0, dictionaryId: 1494 },
    { fieldKey: "10097", label: "Название цвета", labelZh: "颜色名称", required: false, complexId: 0, dictionaryId: 0 }
  ];
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate],
    evidencePacks: [siblingColorSchemaPack(candidate)] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-map", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => AT, readDictionaryValues: async request => {
      externalReads += 1;
      assert.equal(request.attributeId, '10096');
      return { sourceRef: 'synthetic:dictionary:10096', checkedAt: AT,
        expiresAt: '2099-01-01T00:00:00.000Z', evidenceData: { complete: true,
          values: [{ value: 'synthetic-broad-color', dictionaryValueId: 910096 }] } };
    } });
  const authorization = await reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } });
  const read = await reader.continueSaved({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: authorization.candidate.dataRevision, attributeId: '10096',
    authorizationId: authorization.result.authorizationId } });
  assert.equal(read.result.status, 'succeeded');
  assert.equal(externalReads, 1);
  const useCase = createC1OzonAttributeMappingUseCase({ repository, runtimeMode: "local_development",
    serverClock: () => AT, readDictionaryValue: async () => {
      throw new Error('SIBLING_MAPPING_MUST_NOT_READ_DICTIONARY_AGAIN');
    } });
  const preview = await useCase.propose({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: read.candidate.dataRevision } });
  const source = preview.confirmedFacts.filter(fact => fact.value === "黑cp" &&
    fact.factPath.startsWith("productAttributes.supplierAttributes."));
  assert.equal(source.length, 1);
  const mapped = await useCase.map({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: read.candidate.dataRevision,
    mappings: [
      { attributeId: "10096", value: "synthetic-broad-color", sourceFactPath: source[0].factPath },
      { attributeId: "10097", value: "synthetic-exact-color", sourceFactPath: source[0].factPath }
    ], idempotencyKey: "synthetic:map-both", auditEventId: "synthetic:map-both:audit" } });
  assert.deepEqual(mapped.result.mappedAttributeIds, ["10096", "10097"]);
  assert.equal(mapped.result.externalCalls, 0);
  assert.equal(externalReads, 1);
  const frozen = await executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "synthetic_freeze_both_colors", candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: mapped.candidate.dataRevision,
    idempotencyKey: "synthetic:freeze-both", inputFingerprint: "synthetic:freeze-both",
    auditEventId: "synthetic:freeze-both:audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage = verifyC1ProductFacts({ skuPackage: staged.lifecycleV11.skuPackage,
        skuRightsReview: rights, verifiedAt: AT }).skuPackage;
      return { candidate: staged, result: { status: "facts_checked" } };
    } });
  assert.equal(frozen.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "facts_checked");
  assert.doesNotThrow(() => assertSiblingSkuColorProjection(frozen.candidate));
});

test('expired frozen schema stops color read authorization before any external request', async () => {
  const document = siblingColorState();
  document.evidencePacks[0].expiresAt = '2026-09-19T00:00:00.000Z';
  const candidate = document.candidates[1];
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'expired-schema', actorType: 'human',
    roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: '2026-09-27T00:00:00.000Z' });
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => '2026-09-27T00:00:00.000Z', readDictionaryValues: async () => { externalReads += 1; } });
  const before = await repository.readSnapshot();
  await assert.rejects(() => reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } }),
  /C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT/);
  assert.deepEqual(await repository.readSnapshot(), before);
  assert.equal(externalReads, 0);
});

test('schema pack rule version must match the frozen context before any dictionary request', async () => {
  for (const drift of ['pack', 'frozen']) {
    const document = siblingColorState();
    const candidate = document.candidates[1];
    if (drift === 'pack') document.evidencePacks[0].scope.ruleVersion = 'different-schema-policy';
    else delete candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.ruleVersion;
    const repository = createMemoryBusinessStateRepository(document);
    const actor = createActorContext({ userId: 'synthetic-owner', sessionId: `rule-version-${drift}`,
      actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });
    let externalReads = 0;
    const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
      serverClock: () => AT, readDictionaryValues: async () => { externalReads += 1; } });
    const before = await repository.readSnapshot();
    await assert.rejects(() => reader.authorize({ actor, input: { candidateId: candidate.id,
      skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
      expectedRevision: candidate.dataRevision, attributeId: '10096' } }),
    /C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT/);
    assert.deepEqual(await repository.readSnapshot(), before);
    assert.equal(externalReads, 0);
  }
});

test('recognized internal schema refresh hint remains usable after its hint deadline', async () => {
  const document = siblingColorState();
  const candidate = document.candidates[1];
  const schema = candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
  const pack = document.evidencePacks[0];
  schema.schemaRevision = 'ozon-schema-1234567890abcdef1234';
  schema.descriptionCategoryId = 17028665;
  schema.typeId = 92935;
  schema.writeBindings.schemaRevision = schema.schemaRevision;
  pack.evidenceData.schemaRevision = schema.schemaRevision;
  pack.evidenceData.descriptionCategoryId = schema.descriptionCategoryId;
  pack.evidenceData.typeId = schema.typeId;
  pack.evidenceData.writeBindings = structuredClone(schema.writeBindings);
  pack.sourceType = 'ozon_seller_api_current_schema';
  pack.sourceRef = `ozon-seller-api:/v1/description-category/attribute:${schema.descriptionCategoryId}:${schema.typeId}`;
  pack.expiresAt = new Date(Date.parse(pack.checkedAt) + 24 * 60 * 60_000).toISOString();
  pack.validity = createInternalEvidenceValidity('schema');
  const observedAt = new Date(Date.parse(pack.expiresAt) + 60_000).toISOString();
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: observedAt }).status, 'refresh_due');
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'schema-refresh-hint',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: observedAt });
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => observedAt, readDictionaryValues: async () => { externalReads += 1; } });
  const authorization = await reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } });
  assert.equal(authorization.result.status, 'authorized');
  assert.equal(externalReads, 0);
});

test('schema expiry after owner authorization still stops the claimed external read', async () => {
  const document = siblingColorState();
  document.evidencePacks[0].expiresAt = new Date(Date.parse(AT) + 60_000).toISOString();
  const candidate = document.candidates[1];
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'schema-expired-before-read',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });
  let currentTime = AT;
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => currentTime, readDictionaryValues: async () => { externalReads += 1; } });
  const authorized = await reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } });
  const before = await repository.readSnapshot();
  currentTime = new Date(Date.parse(AT) + 120_000).toISOString();
  await assert.rejects(() => reader.continueSaved({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: authorized.candidate.dataRevision, attributeId: '10096',
    authorizationId: authorized.result.authorizationId } }),
  /C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT/);
  assert.deepEqual(await repository.readSnapshot(), before);
  assert.equal(externalReads, 0);
});

test('incomplete or uncertain dictionary results stay unusable and cannot be resent', async () => {
  for (const outcome of ['incomplete', 'unknown_outcome']) {
    const document = siblingColorState();
    const candidate = document.candidates[1];
    const repository = createMemoryBusinessStateRepository(document);
    const actor = createActorContext({ userId: 'synthetic-owner', sessionId: `dictionary-${outcome}`,
      actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });
    let externalReads = 0;
    const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
      serverClock: () => AT, readDictionaryValues: async () => {
        externalReads += 1;
        if (outcome === 'unknown_outcome') throw new Error('synthetic service lost response');
        return { sourceRef: 'synthetic:dictionary:incomplete', checkedAt: AT,
          expiresAt: '2099-01-01T00:00:00.000Z', evidenceData: { complete: false,
            values: [{ value: 'synthetic-broad-color', dictionaryValueId: 910096 }] } };
      } });
    const authorized = await reader.authorize({ actor, input: { candidateId: candidate.id,
      skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
      expectedRevision: candidate.dataRevision, attributeId: '10096' } });
    const input = { candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
      expectedRevision: authorized.candidate.dataRevision, attributeId: '10096',
      authorizationId: authorized.result.authorizationId };
    const read = await reader.continueSaved({ actor, input });
    assert.equal(read.result.status, outcome);
    assert.equal(read.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].evidence, null);
    assert.equal((await reader.continueSaved({ actor, input })).status, 'idempotent_replay');
    assert.equal(externalReads, 1);
    const nextInput = { candidateId: candidate.id,
      skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
      expectedRevision: read.candidate.dataRevision, attributeId: '10096' };
    if (outcome === 'incomplete') {
      const renewed = await reader.authorize({ actor, input: nextInput });
      assert.notEqual(renewed.result.authorizationId, authorized.result.authorizationId);
      assert.equal(renewed.candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1.length, 1);
      assert.equal(renewed.candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1[0].status, 'incomplete');
      assert.equal(externalReads, 1, 'owner authorization alone cannot read the account');
    } else {
      const before = await repository.readSnapshot();
      await assert.rejects(() => reader.authorize({ actor, input: nextInput }),
        /C1_COLOR_DICTIONARY_ALREADY_AUTHORIZED/);
      assert.deepEqual(await repository.readSnapshot(), before);
      assert.equal(externalReads, 1);
    }
  }
});

test('expired complete list requires a new owner authorization and preserves the old result', async () => {
  const document = siblingColorState();
  const candidate = document.candidates[1];
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'dictionary-renewal',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });
  let currentTime = AT;
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => currentTime, readDictionaryValues: async () => {
      externalReads += 1;
      return { sourceRef: `synthetic:dictionary:${externalReads}`, checkedAt: currentTime,
        expiresAt: new Date(Date.parse(currentTime) + 60_000).toISOString(),
        evidenceData: { complete: true,
          values: [{ value: 'synthetic-broad-color', dictionaryValueId: 910096 }] } };
    } });
  const first = await reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } });
  const firstRead = await reader.continueSaved({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: first.candidate.dataRevision, attributeId: '10096',
    authorizationId: first.result.authorizationId } });
  const nextInput = { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: firstRead.candidate.dataRevision, attributeId: '10096' };
  await assert.rejects(() => reader.authorize({ actor, input: nextInput }),
    /C1_COLOR_DICTIONARY_ALREADY_AUTHORIZED/);
  currentTime = new Date(Date.parse(AT) + 120_000).toISOString();
  const renewed = await reader.authorize({ actor, input: nextInput });
  assert.equal(renewed.candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1.length, 1);
  assert.deepEqual(renewed.candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1[0].evidence,
    firstRead.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].evidence);
  assert.equal(renewed.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].status, 'authorized');
  assert.equal(externalReads, 1);
});

test('retained color read history reaches a bounded stop without deleting an older result', async () => {
  const document = siblingColorState();
  const candidate = document.candidates[1];
  candidate.lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': {
    status: 'incomplete', useCount: 1, settledAt: AT, authorizationId: 'synthetic:current'
  } };
  candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1 = Array.from({ length: 16 }, (_, index) => ({
    authorizationId: `synthetic:history:${index}`, status: 'incomplete', useCount: 1, settledAt: AT
  }));
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'dictionary-history-cap',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => AT, readDictionaryValues: async () => { externalReads += 1; } });
  const before = await repository.readSnapshot();
  await assert.rejects(() => reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } }),
  /C1_COLOR_DICTIONARY_HISTORY_CAPACITY_REACHED/);
  assert.deepEqual(await repository.readSnapshot(), before);
  assert.equal(externalReads, 0);
});

test('a concurrent revision after the dictionary request reports an unsettled sent request', async () => {
  const document = siblingColorState();
  const candidate = document.candidates[1];
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'dictionary-settlement-conflict',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });
  let externalReads = 0;
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => AT, readDictionaryValues: async () => {
      externalReads += 1;
      await repository.transact(document => {
        document.candidates.find(item => item.id === candidate.id).dataRevision += 1;
        return { changed: true, document, result: null };
      });
      return { sourceRef: 'synthetic:dictionary:concurrent', checkedAt: AT,
        expiresAt: '2099-01-01T00:00:00.000Z', evidenceData: { complete: true,
          values: [{ value: 'synthetic-broad-color', dictionaryValueId: 910096 }] } };
    } });
  const authorized = await reader.authorize({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, attributeId: '10096' } });
  const input = { candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: authorized.candidate.dataRevision, attributeId: '10096',
    authorizationId: authorized.result.authorizationId };
  await assert.rejects(() => reader.continueSaved({ actor, input }), error =>
    error.code === 'C1_COLOR_DICTIONARY_SETTLEMENT_UNCONFIRMED' && error.requestSent === true);
  const after = (await repository.readSnapshot()).candidates.find(item => item.id === candidate.id);
  assert.equal(after.lifecycleV11.c1ColorDictionaryReadsV1['10096'].status, 'request_sent');
  assert.equal(after.lifecycleV11.c1ColorDictionaryReadsV1['10096'].useCount, 1);
  assert.equal(externalReads, 1);
  assert.equal((await reader.continueSaved({ actor, input })).status, 'idempotent_replay');
  assert.equal(externalReads, 1);
});

test("C2 transition still rejects a frozen sibling without the two color bindings", async () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.checked.skuPackage);
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-c2", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const original = await repository.readSnapshot();
  await assert.rejects(() => executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "synthetic_c2_transition", candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: candidate.dataRevision,
    idempotencyKey: "synthetic:c2-gap", inputFingerprint: "synthetic:c2-gap",
    auditEventId: "synthetic:c2-gap:audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage.businessPhase = "C2";
      return { candidate: staged, result: { status: "C2" } };
    } }), /SIBLING_COLOR_BINDING_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), original);
});

test("color revision refuses in-flight, unknown, sent and authorized predecessor states", () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.checked.skuPackage);
  const prepare = relatedSoftwareJobs => prepareC1SiblingColorRevision({ candidate,
    expectedRevision: candidate.dataRevision, relatedSoftwareJobs, preparedAt: AT });
  for (const job of [
    { status: "queued", externalRequestState: "not_sent" },
    { status: "claimed", externalRequestState: "not_sent" },
    { status: "unknown_outcome", externalRequestState: "unknown_outcome" },
    { status: "failed", externalRequestState: "sent" }
  ]) assert.throws(() => prepare([job]), /C1_SIBLING_COLOR_REVISION_JOB_UNSETTLED/);
  candidate.lifecycleV11.skuPackage.productionAuthorization = { synthetic: true };
  assert.throws(() => prepare([]), /C1_SIBLING_COLOR_REVISION_PRODUCTION_STARTED/);
});

test("C2 color repair returns to fresh C1 without carrying prior C2 assets or job references", () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1C2Fixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.c2.skuPackage);
  candidate.lifecycleV11.c1AiDraftJobRefV1 = { jobId: "synthetic:old-job" };
  candidate.lifecycleV11.c2UploadDraft = { revision: 1, uploads: [{ assetId: "synthetic:old-image" }] };
  const result = prepareC1SiblingColorRevision({ candidate, expectedRevision: candidate.dataRevision,
    relatedSoftwareJobs: [{ status: "completed", externalRequestState: "succeeded" }], preparedAt: AT });
  const current = result.candidate.lifecycleV11;
  assert.equal(current.skuPackage.businessPhase, "C1");
  assert.equal(current.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(current.skuPackage.c2FinalAssets, null);
  assert.equal(current.c1AiDraftJobRefV1, undefined);
  assert.equal(current.c2UploadDraft, undefined);
  assert.deepEqual(result.historyRecord.previousSkuPackage, candidate.lifecycleV11.skuPackage);
  assert.deepEqual(result.historyRecord.previousC1References.c2UploadDraft, candidate.lifecycleV11.c2UploadDraft);
});
