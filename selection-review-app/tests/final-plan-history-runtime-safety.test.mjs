import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeBusinessMutationCandidate } from '../lib/runtime-identity.mjs';
function candidate() { return { schemaVersion: 'c1-final-plan-revision-history-v1', previousSkuPackage: {
  entityType: 'SkuLifecyclePackage', g1Identity: { schemaVersion: 'g1-identity-v1' },
  c1ProductPlan: { schemaVersion: 'c1-product-plan-v1.1', draftOnlySeo: { editorialSource: { bundle: { sourceJob: {
    scopeBinding: { authorizationRef: 'authorization:c1-ai-draft:SYNTHETIC' }, admissionDecision: { authorizationRef: 'authorization:c1-ai-draft:SYNTHETIC' }
  } } } } }
} }; }
test('declared final-plan history preserves canonical old authorization identifiers without changing the candidate', () => {
  const value = candidate(), before = structuredClone(value);
  assert.doesNotThrow(() => assertSafeBusinessMutationCandidate(value));
  assert.deepEqual(value, before);
});
test('history never exempts credentials or unrelated paths from the secret boundary', () => {
  const value = candidate();
  value.previousSkuPackage.c1ProductPlan.draftOnlySeo.editorialSource.bundle.sourceJob.scopeBinding.authorizationRef = 'authorization:Bearer secret';
  assert.throws(() => assertSafeBusinessMutationCandidate(value), error => error.message.startsWith("RUNTIME_IDENTITY_INVALID:") && error.cause.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"));
  const foreign = candidate(); foreign.unrelated = { authorizationRef: 'authorization:c1-ai-draft:SYNTHETIC' };
  assert.throws(() => assertSafeBusinessMutationCandidate(foreign), error => error.message.startsWith("RUNTIME_IDENTITY_INVALID:") && error.cause.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"));
});
