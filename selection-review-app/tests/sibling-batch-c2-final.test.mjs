import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';

const at = '2026-09-27T00:00:00.000Z';
function fixture() {
  const parent = { id: 'candidate:synthetic-parent', dataRevision: 9,
    sourceCapture: { selectedSkuIds: ['first-unknown', 'black', 'green'] },
    lifecycleV11: { skuPackage: { supplierSkuId: 'first-unknown', technicalStatus: 'unknown_outcome' } } };
  const children = ['black', 'green'].map((supplierSkuId, index) => ({
    id: `candidate:synthetic-${index}`, dataRevision: 4,
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId },
    lifecycleV11: { skuPackage: { businessPhase: 'C2', supplierSkuId,
      c2FinalAssets: { status: 'awaiting_final_uploads' } } }
  }));
  const document = initialBusinessStateDocument({ now: at });
  document.candidates = [parent, ...children];
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'synthetic-session',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: at });
  const input = { parentCandidateId: parent.id, parentRevision: 9, confirmed: true,
    members: children.map(child => ({ candidateId: child.id, candidateRevision: 4,
      draftRevision: 0, approvedAssetIds: ['synthetic-asset'] })) };
  return { repository, actor, input };
}

test('batch C2 rejects stale, duplicate and incomplete material without saving any member', async () => {
  for (const change of [
    input => { input.parentRevision += 1; },
    input => { input.members[1].candidateId = input.members[0].candidateId; },
    input => { input.members[1].candidateRevision += 1; },
    input => { input.members[1].approvedAssetIds = []; }
  ]) {
    const { repository, actor, input } = fixture();
    change(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development', actor,
      input, verifiedAssets: new Map(), serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});
