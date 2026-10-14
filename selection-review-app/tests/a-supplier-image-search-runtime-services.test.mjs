import test from 'node:test';
import assert from 'node:assert/strict';
import { readSupplierImageSearchPreparation, requireSupplierImageSearchPreparation } from '../lib/a-supplier-image-search-runtime-services.mjs';

function fixture() {
  return {
    actor: { schemaVersion: 'actor-context-v1', userId: 'owner:test', actorType: 'human', source: 'authenticated_identity_provider', roles: ['owner'] },
    document: { candidates: [{ id: 'candidate:test', dataRevision: 2 }], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [] } },
    candidateId: 'candidate:test', expectedRevision: 2
  };
}

test('default readiness and a direct authorization attempt never create work or mutate revision', () => {
  const input = fixture(), before = structuredClone(input);
  const view = readSupplierImageSearchPreparation(input);
  assert.equal(view.canAuthorize, false);
  assert.equal(view.pageContractStatus, 'unverified');
  assert.equal(view.browserWorkerStatus, 'unverified');
  assert.throws(() => requireSupplierImageSearchPreparation(input), /PAGE_CONTRACT_UNCONFIGURED/);
  assert.deepEqual(input, before);
});

test('a stale or absent candidate cannot receive preparation for a different revision', () => {
  assert.throws(() => readSupplierImageSearchPreparation({ ...fixture(), expectedRevision: 1 }), /CANDIDATE_CHANGED/);
  assert.throws(() => readSupplierImageSearchPreparation({ ...fixture(), candidateId: 'candidate:missing' }), /CANDIDATE_REQUIRED/);
  for (const expectedRevision of [null, '2', -1, 2.5]) {
    assert.throws(() => readSupplierImageSearchPreparation({ ...fixture(), expectedRevision }), /INPUT_INVALID/);
  }
});

test('browser readiness cannot be inferred from an old extension heartbeat or a supplied ready flag', () => {
  const input = fixture();
  input.document.runtime.extensionHeartbeat = { backgroundReady: true, version: '1.2.8' };
  input.pageContractVerified = true;
  assert.equal(readSupplierImageSearchPreparation(input).canAuthorize, false);
  assert.throws(() => requireSupplierImageSearchPreparation(input), /PAGE_CONTRACT_UNCONFIGURED/);
});

test('only an authenticated human owner can access preparation', () => {
  const input = fixture();
  for (const actor of [{ ...input.actor, source: 'local' }, { ...input.actor, actorType: 'worker' }, { ...input.actor, roles: [] }]) {
    assert.throws(() => readSupplierImageSearchPreparation({ ...input, actor }));
  }
});
