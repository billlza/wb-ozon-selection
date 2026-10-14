import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { threeColorFixture } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

const { api: port } = allocatedTestPorts();

test('three-color C1 preview is read-only and one bound owner confirmation reaches C2', async t => {
  const fixture = await threeColorFixture();
  const document = await fixture.repository.readSnapshot();
  const parent = document.candidates[0];
  const api = await startSavedDEApi(t, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-c1-preview-')),
    port, document, binding: { storeRef: parent.storeRef, platform: parent.targetPlatform }, productionBindings: [] });
  await api.authenticate();
  const previewRoute = `/api/candidates/${parent.id}/sibling-batch-c1-preview`;
  const commitRoute = `/api/candidates/${parent.id}/sibling-batch-c1-confirm`;
  const before = await api.readBytes();
  for (const [attributeId, expectedCode] of [
    ['10096', 'SIBLING_BATCH_C1_OFFICIAL_COLOR_REQUIRED'],
    ['10097', 'SIBLING_BATCH_C1_COLOR_NAME_REQUIRED']
  ]) {
    const incomplete = structuredClone(fixture.input);
    incomplete.members[0].colorMappings[attributeId] = '';
    const blocked = await api.post(previewRoute, incomplete);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.code, expectedCode);
    assert.deepEqual(await api.readBytes(), before);
  }
  const preview = await api.post(previewRoute, fixture.input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.members.length, 3);
  assert.equal(preview.body.members.every(member => member.content.seoTitleDraft.text.length > 0), true);
  assert.deepEqual(await api.readBytes(), before);
  const stale = await api.post(commitRoute, { ...fixture.input, previewFingerprint: '0'.repeat(64) });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.deepEqual(await api.readBytes(), before);
  const decision = { ...fixture.input, previewFingerprint: preview.body.previewFingerprint };
  const [first, repeat] = await Promise.all([api.post(commitRoute, decision), api.post(commitRoute, decision)]);
  assert.deepEqual(new Set([first.status, repeat.status]), new Set([200]));
  assert.deepEqual(new Set([first.body.status, repeat.body.status]), new Set(['c2_waiting_final_uploads', 'idempotent_replay']));
  const saved = await api.readDocument();
  assert.deepEqual(saved.candidates[0], parent);
  assert.equal(saved.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.businessPhase === 'C2'), true);
  assert.equal(saved.runtime.softwareJobs.length, document.runtime.softwareJobs.length);
  assert.equal(api.dependencyRequests(), 0);
  assert.equal(api.dictionaryRequests(), 0);
  await api.assertClean();
});
