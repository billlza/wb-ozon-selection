import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, receipt, authorizedExecution, settledExecution, nonTrainSkuPackage } from './fixtures/c1-ai-draft-fixture.mjs';
import { C1_GATEWAY_INPUT_ENCODING_VERSION, validateC1AiDraftRequest, validateC1AiDraftReceipt,
  assertAuthorizedC1Execution, mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { prepareCurrentC1AiDraftRequest, assertCurrentC1AiDraftRequestSources } from '../lib/c1-ai-draft-request-source.mjs';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './fixtures/c1-local-draft-source-fixture.mjs';
import { prepareC1LocalDraftSource } from '../lib/c1-local-draft-source.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
function rehash(request) {
  const { requestId, requestFingerprint, ...core } = request;
  const digest = fingerprintCanonicalRecord(core);
  return { ...request, requestId: `c1-ai-request:${request.identity.c1PlanId}:${digest.slice(0, 16)}`, requestFingerprint: digest };
}
function candidate() {
  const current = createSavedLocalPreparationCandidate();
  const prepared = prepareC1LocalDraftSource({ candidate: current, preparedAt: LOCAL_DRAFT_AT });
  current.lifecycleV11.skuPackage = structuredClone(prepared.skuPackage);
  current.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(prepared.sourceEvidence);
  return current;
}
test('explicit encoding version changes only request transport identity, retaining every semantic input and output contract', async () => {
  const legacy = buildRequest(), compact = buildRequest({ gatewayInputEncodingVersion: C1_GATEWAY_INPUT_ENCODING_VERSION });
  const { requestId, requestFingerprint, gatewayInputEncodingVersion, ...compactBody } = compact;
  const { requestId: oldId, requestFingerprint: oldFingerprint, ...legacyBody } = legacy;
  assert.deepEqual(compactBody, legacyBody);
  assert.equal(gatewayInputEncodingVersion, 'c1-gateway-input-compact-v1');
  assert.notEqual(requestId, oldId); assert.notEqual(requestFingerprint, oldFingerprint);
  assert.deepEqual(compact.outputContractSnapshot, legacy.outputContractSnapshot);
  assert.equal(validateC1AiDraftRequest(compact).valid, true);
  const ajv = await loadPublishedSchemaValidator();
  assert.equal(ajv.validate('c1-ai-draft-request-v1', compact), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate('c1-ai-draft-request-v1', legacy), true, JSON.stringify(ajv.errors));
});
test('absence preserves frozen legacy fingerprint and old successful receipt replay', () => {
  const request = buildRequest();
  assert.equal(Object.hasOwn(request, 'gatewayInputEncodingVersion'), false);
  assert.equal(request.requestFingerprint, '402add5d29beaba53c778efc72062dad4d25d3b964e50621574746eb30649f3b');
  assert.deepEqual(buildRequest({ gatewayInputEncodingVersion: null }), request);
  const result = receipt(request), execution = settledExecution(request, result);
  const merged = mergeC1AiDraftReceipt({ skuPackage: nonTrainSkuPackage(), request, receipt: result, settledExecution: execution, mergedAt: result.completedAt });
  assert.equal(mergeC1AiDraftReceipt({ skuPackage: merged.skuPackage, request, receipt: result, settledExecution: execution, mergedAt: result.completedAt }).idempotent, true);
});
test('current preparation defaults to compact; admission rebuilds saved legacy and explicit versions exactly', () => {
  const current = candidate();
  const compact = prepareCurrentC1AiDraftRequest(current, LOCAL_DRAFT_AT);
  const legacy = prepareCurrentC1AiDraftRequest(current, LOCAL_DRAFT_AT, { gatewayInputEncodingVersion: null });
  assert.equal(compact.gatewayInputEncodingVersion, C1_GATEWAY_INPUT_ENCODING_VERSION);
  assert.equal(Object.hasOwn(legacy, 'gatewayInputEncodingVersion'), false);
  assert.notEqual(compact.requestFingerprint, legacy.requestFingerprint);
  for (const request of [compact, legacy]) {
    const before = structuredClone(request);
    assert.deepEqual(assertCurrentC1AiDraftRequestSources({ candidate: current, request, observedAt: LOCAL_DRAFT_AT }), before);
    assert.deepEqual(request, before);
  }
});
test('unknown, null and altered versions never silently downgrade or retain old authorization', async () => {
  const legacy = buildRequest(), compact = buildRequest({ gatewayInputEncodingVersion: C1_GATEWAY_INPUT_ENCODING_VERSION });
  const ajv = await loadPublishedSchemaValidator();
  for (const version of ['unknown', 'c1-gateway-input-compact-v2', null, '', 1]) {
    const bad = rehash({ ...compact, gatewayInputEncodingVersion: version });
    assert.equal(validateC1AiDraftRequest(bad).valid, false);
    assert.equal(ajv.validate('c1-ai-draft-request-v1', bad), false);
    if (version !== null) assert.throws(() => buildRequest({ gatewayInputEncodingVersion: version }), /ENCODING_VERSION_INVALID/);
  }
  assert.equal(validateC1AiDraftRequest({ ...legacy, gatewayInputEncodingVersion: C1_GATEWAY_INPUT_ENCODING_VERSION }).valid, false);
  const removed = structuredClone(compact); delete removed.gatewayInputEncodingVersion;
  assert.equal(validateC1AiDraftRequest(removed).valid, false);
  assert.throws(() => assertAuthorizedC1Execution({ request: compact, authorizedExecution: authorizedExecution(legacy) }), /EXECUTION|AUTHORIZ/);
  assert.equal(validateC1AiDraftReceipt({ request: compact, receipt: receipt(legacy) }).valid, false);
});
