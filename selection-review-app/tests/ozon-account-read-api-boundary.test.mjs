import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

const { api: port } = allocatedTestPorts();
test('real account HTTP boundary rejects anonymous, cross-origin, stale and unconfirmed requests before credentials or business changes', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'account-read-boundary-http-'));
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding,
    accountReadServices: [{ ...fixture.service, schemaVersion: 'ozon-account-read-service-binding-v1',
      serviceId: 'service:synthetic:account-read', workerId: 'worker:synthetic:account-read' }],
    credentialBindings: [{ credentialAlias: fixture.binding.credentialAlias, clientId: '700123',
      keychainService: 'synthetic-account-boundary', keychainAccount: 'synthetic-account' }] });
  const bytes = await api.readBytes();
  const state = await api.get('/api/state'); assert.equal(state.status, 200);
  const preparation = state.body.candidates.find(candidate => candidate.id === fixture.candidate.id).ozonAccountReadPreparation;
  assert.equal(preparation.options.length, 1); assert.equal(preparation.options[0].clientId, '700123');
  assert.deepEqual(preparation.runtime, []); assert.equal(preparation.maxRequests, 3); assert.equal(preparation.platformWrites, 0);
  assert.equal(Object.hasOwn(preparation, 'selectedBindingId'), false);
  const option = preparation.options[0], route = `/api/candidates/${fixture.candidate.id}/lifecycle/account-read/authorize`;
  const input = { candidateId: fixture.candidate.id, skuPackageId: preparation.skuPackageId, expectedRevision: preparation.expectedRevision,
    bindingId: option.bindingId, configurationVersion: option.configurationVersion, scopeRef: option.scopeRef,
    confirmReadOnce: true, expiresAt: '2099-01-01T00:00:00.000Z', idempotencyKey: 'owner-read:http-boundary' };
  assert.ok([401, 403].includes((await api.post(route, input, { authenticated: false })).status));
  await api.authenticate();
  assert.equal((await api.post(route, input, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403);
  const stale = await api.post(route, { ...input, expectedRevision: input.expectedRevision - 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'OZON_ACCOUNT_READ_CANDIDATE_CHANGED');
  const unconfirmed = await api.post(route, { ...input, confirmReadOnce: false });
  assert.equal(unconfirmed.status, 422); assert.equal(unconfirmed.body.code, 'OZON_ACCOUNT_READ_INPUT_INVALID');
  assert.equal((await api.post(route, { ...input, candidateId: 'candidate:wrong' })).status, 400);
  assert.equal((await api.post(route, input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.deepEqual(await api.readBytes(), bytes);
  await api.restart(); await api.authenticate('login');
  assert.deepEqual((await api.get('/api/state')).body.candidates.find(candidate => candidate.id === fixture.candidate.id).ozonAccountReadPreparation, preparation);
  assert.deepEqual(await api.readBytes(), bytes); await api.assertClean();
});
