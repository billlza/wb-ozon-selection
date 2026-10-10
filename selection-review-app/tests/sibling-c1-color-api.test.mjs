import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { siblingColorState } from './fixtures/sibling-color-state.mjs';
import { startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

const { api: port } = allocatedTestPorts();

test('unsettled color reads cannot be cleared through the frozen sibling revision API', async t => {
  for (const status of ['request_sent', 'unknown_outcome']) {
    await t.test(status, async child => {
      const document = siblingColorState();
      const frozen = document.candidates[0];
      frozen.lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': {
        schemaVersion: 'c1-color-dictionary-read-v1', status,
        authorizationId: `synthetic:${status}`, externalRequestRef: `synthetic:${status}:request`
      } };
      const api = await startSavedDEApi(child, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-color-unsettled-')),
        port, document, binding: { storeRef: frozen.storeRef, platform: frozen.targetPlatform },
        productionBindings: [] });
      await api.authenticate();
      const before = await api.readBytes();
      const response = await api.post(`/api/candidates/${frozen.id}/lifecycle/c1/revise-sibling-color`, {
        candidateId: frozen.id, skuPackageId: frozen.lifecycleV11.skuPackage.skuPackageId,
        dataRevision: frozen.dataRevision });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, 'C1_SIBLING_COLOR_REVISION_DICTIONARY_READ_UNSETTLED');
      assert.deepEqual(await api.readBytes(), before);
      assert.equal(api.dictionaryRequests(), 0);
      assert.equal(api.dependencyRequests(), 0);
      await api.assertClean();
    });
  }
});

test('synthetic sibling color recovery API preserves the predecessor and requires owner identity', async t => {
  const document = siblingColorState();
  const frozen = document.candidates[0];
  const directory = await mkdtemp(path.join(tmpdir(), 'sibling-color-api-'));
  const api = await startSavedDEApi(t, { directory, port, document,
    binding: { storeRef: frozen.storeRef, platform: frozen.targetPlatform }, productionBindings: [] });
  const route = `/api/candidates/${frozen.id}/lifecycle/c1/revise-sibling-color`;
  const input = { candidateId: frozen.id, skuPackageId: frozen.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: frozen.dataRevision };
  const original = await api.readBytes();
  const guest = await api.post(route, input, { authenticated: false });
  assert.equal(guest.status, 401, JSON.stringify(guest.body));
  assert.deepEqual(await api.readBytes(), original);

  await api.authenticate();
  const editable = document.candidates[1];
  const freezeRoute = `/api/candidates/${editable.id}/lifecycle/c1/continue-preparation`;
  const beforeFreeze = await api.readBytes();
  const freeze = await api.post(freezeRoute, { candidateId: editable.id, dataRevision: editable.dataRevision });
  assert.equal(freeze.status, 409, JSON.stringify(freeze.body));
  assert.equal(freeze.body.code, 'SIBLING_COLOR_BINDING_INVALID');
  assert.deepEqual(freeze.body.requiredAttributeIds, ['10096', '10097']);
  assert.deepEqual(await api.readBytes(), beforeFreeze);

  const stale = await api.post(route, { ...input, dataRevision: input.dataRevision - 1 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'BUSINESS_MUTATION_REVISION_CONFLICT');
  assert.deepEqual(await api.readBytes(), beforeFreeze);
  const responses = await Promise.all([api.post(route, input), api.post(route, input)]);
  assert.ok(responses.every(response => response.status === 200), JSON.stringify(responses));
  assert.deepEqual(new Set(responses.map(response => response.body.status)), new Set(['committed', 'idempotent_replay']));
  const saved = await api.readDocument();
  const current = saved.candidates.find(candidate => candidate.id === frozen.id);
  assert.equal(current.dataRevision, frozen.dataRevision + 1);
  assert.equal(current.lifecycleV11.skuPackage.businessPhase, 'C1');
  assert.equal(current.lifecycleV11.skuPackage.c1ProductPlan.status, 'inputs_ready');
  assert.equal(current.lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.equal(current.lifecycleV11.skuPackage.productionConfirmationCard, null);
  assert.equal(saved.c1SiblingColorRevisionHistoryRecords.length, 1);
  assert.deepEqual(saved.c1SiblingColorRevisionHistoryRecords[0].previousSkuPackage,
    frozen.lifecycleV11.skuPackage);
  const committedBytes = await api.readBytes();
  const conflicting = await api.post(route, { ...input, skuPackageId: 'synthetic:other-sku' });
  assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
  assert.equal(conflicting.body.code, 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await api.readBytes(), committedBytes);
  assert.equal(saved.candidates.find(candidate => candidate.id === 'SYNTHETIC-COLOR-EDITABLE').dataRevision,
    document.candidates[1].dataRevision);
  assert.equal(saved.runtime.softwareJobs?.length ?? 0, 0);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('owner-authorized complete color choices are read once, saved and mapped without another account read', async t => {
  const document = siblingColorState();
  const editable = document.candidates[1];
  const schema = editable.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
  const api = await startSavedDEApi(t, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-color-choices-')),
    port, document, binding: { storeRef: editable.storeRef, platform: editable.targetPlatform },
    productionBindings: [], dictionaryResponder: (request, query) => {
      if (request.method !== 'POST' || query?.kind !== 'schema_dictionary_values' ||
          query.store !== schema.store || query.category !== `ozon:${schema.descriptionCategoryId}:${schema.typeId}` ||
          query.attributeId !== '10096' || query.limit !== 200) return null;
      const checkedAt = new Date();
      return { ok: true, evidence: { current: true,
        scope: { platform: 'ozon', store: query.store, category: query.category, attributeId: query.attributeId },
        sourceRef: 'synthetic:dictionary:10096', checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 24 * 60 * 60_000).toISOString(), evidenceData: { complete: true,
          values: [{ value: 'synthetic-broad-color', valueZh: '合成广义颜色', dictionaryValueId: 910096 }] } } };
    } });
  const route = `/api/candidates/${editable.id}/lifecycle/c1`;
  await api.authenticate();
  const facts = await api.get(`${route}/ozon-attributes`);
  assert.equal(facts.status, 200);
  const sourceFacts = facts.body.proposal.confirmedFacts.filter(fact => fact.value === '黑cp' &&
    fact.factPath.startsWith('productAttributes.supplierAttributes.'));
  assert.equal(sourceFacts.length, 1);
  const before = await api.readBytes();
  const premature = await api.post(`${route}/ozon-attribute-mapping`, { candidateId: editable.id,
    dataRevision: editable.dataRevision, mappings: [{ attributeId: '10096', value: 'synthetic-broad-color',
      sourceFactPath: sourceFacts[0].factPath }] });
  assert.equal(premature.status, 409, JSON.stringify(premature.body));
  assert.equal(premature.body.code, 'C1_COLOR_DICTIONARY_AUTHORIZATION_MISSING');
  assert.deepEqual(await api.readBytes(), before);
  assert.equal(api.dictionaryRequests(), 0);

  const authorizationInput = { candidateId: editable.id, skuPackageId: editable.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: editable.dataRevision, attributeId: '10096' };
  const unauthorized = await api.post(`${route}/color-dictionary/authorize`, authorizationInput, { authenticated: false });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await api.readBytes(), before);
  const staleAuthorization = await api.post(`${route}/color-dictionary/authorize`,
    { ...authorizationInput, dataRevision: authorizationInput.dataRevision - 1 });
  assert.equal(staleAuthorization.status, 409, JSON.stringify(staleAuthorization.body));
  assert.equal(staleAuthorization.body.code, 'BUSINESS_MUTATION_REVISION_CONFLICT');
  assert.deepEqual(await api.readBytes(), before);
  assert.equal(api.dictionaryRequests(), 0);
  const authorized = await api.post(`${route}/color-dictionary/authorize`, authorizationInput);
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  assert.equal(authorized.body.result.status, 'authorized');
  assert.equal(authorized.body.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].status, 'authorized');
  assert.equal(api.dictionaryRequests(), 0);
  const afterAuthorization = await api.readBytes();
  const conflictingAuthorization = await api.post(`${route}/color-dictionary/authorize`,
    { ...authorizationInput, skuPackageId: 'synthetic:other-sku' });
  assert.equal(conflictingAuthorization.status, 409, JSON.stringify(conflictingAuthorization.body));
  assert.equal(conflictingAuthorization.body.code, 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await api.readBytes(), afterAuthorization);
  assert.equal(api.dictionaryRequests(), 0);
  const claimInput = { ...authorizationInput, dataRevision: authorized.body.candidate.dataRevision,
    authorizationId: authorized.body.result.authorizationId };
  const reads = await Promise.all([api.post(`${route}/color-dictionary/continue`, claimInput),
    api.post(`${route}/color-dictionary/continue`, claimInput)]);
  assert.ok(reads.every(response => response.status === 200), JSON.stringify(reads));
  assert.deepEqual(new Set(reads.map(response => response.body.status)), new Set(['committed', 'idempotent_replay']));
  const completedRead = reads.find(response => response.body.result?.status === 'succeeded');
  assert.deepEqual(completedRead.body.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].evidence.values
    .map(value => value.value), ['synthetic-broad-color']);
  assert.equal(api.dictionaryRequests(), 1);
  const saved = await api.readDocument();
  const current = saved.candidates.find(candidate => candidate.id === editable.id);
  const record = current.lifecycleV11.c1ColorDictionaryReadsV1['10096'];
  assert.equal(record.status, 'succeeded');
  assert.equal(record.useCount, 1);
  assert.equal(record.evidence.complete, true);
  assert.deepEqual(record.evidence.values.map(item => item.value), ['synthetic-broad-color']);
  const mapping = await api.post(`${route}/ozon-attribute-mapping`, { candidateId: editable.id,
    dataRevision: current.dataRevision, mappings: [
      { attributeId: '10096', value: 'synthetic-broad-color', sourceFactPath: sourceFacts[0].factPath },
      { attributeId: '10097', value: 'synthetic-exact-color', sourceFactPath: sourceFacts[0].factPath }
    ] });
  assert.equal(mapping.status, 200, JSON.stringify(mapping.body));
  assert.deepEqual(mapping.body.result.mappedAttributeIds, ['10096', '10097']);
  assert.equal(mapping.body.result.externalCalls, 0);
  assert.equal(api.dictionaryRequests(), 1);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
