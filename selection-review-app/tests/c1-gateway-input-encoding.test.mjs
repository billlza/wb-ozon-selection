import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeC1GatewayInput, decodeC1GatewayInput, C1_GATEWAY_COMPACT_ENCODING_VERSION,
  C1_GATEWAY_INPUT_ENCODING_INSTRUCTION } from '../lib/c1-gateway-input-encoding.mjs';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './fixtures/c1-local-draft-source-fixture.mjs';
import { prepareC1LocalDraftSource } from '../lib/c1-local-draft-source.mjs';
import { prepareCurrentC1AiDraftRequest } from '../lib/c1-ai-draft-request-source.mjs';
import { createC1PaidFormalFixture } from './fixtures/c1-draft-source-fixture.mjs';
import { buildC1GatewayJob } from '../lib/c1-ai-gateway.mjs';

function requestPayload() {
  const candidate = createSavedLocalPreparationCandidate();
  const source = prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT });
  candidate.lifecycleV11.skuPackage = structuredClone(source.skuPackage);
  candidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(source.sourceEvidence);
  const request = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT);
  return { verifiedFacts: request.verifiedFacts, factDefinitionsVersion: request.factDefinitionsVersion,
    factDefinitions: request.factDefinitions, competitorTextEvidence: request.competitorTextEvidence,
    keywordEvidence: request.keywordEvidence, referenceContext: request.referenceContext, seoRules: request.seoRules };
}

test('real prepared request roundtrips every input field through persisted compact JSON without mutating its source', () => {
  const payload = requestPayload();
  const before = structuredClone(payload);
  const encoded = encodeC1GatewayInput(payload);
  assert.equal(encoded.encodingVersion, C1_GATEWAY_COMPACT_ENCODING_VERSION);
  assert.deepEqual(decodeC1GatewayInput(JSON.parse(JSON.stringify(encoded))), payload);
  assert.deepEqual(payload, before);
  assert.deepEqual(encodeC1GatewayInput(payload), encoded);
  assert.ok(JSON.stringify(encoded).length < JSON.stringify(payload).length);
  assert.match(C1_GATEWAY_INPUT_ENCODING_INSTRUCTION, /完整原值/u);
});

test('all fifteen OCR texts, failed/empty distinction, hashes, order and source identity survive unchanged', () => {
  const payload = structuredClone(requestPayload());
  // Synthetic receipt shape only; no claim that these strings were extracted from real images.
  payload.referenceContext.imageTextEvidence = {
    schemaVersion: 'c1-image-text-evidence-v1', receiptId: 'synthetic-ocr-receipt',
    role: 'reference_only_not_product_fact', candidateId: 'synthetic-candidate', skuPackageId: 'synthetic-package',
    supplierSkuId: 'synthetic-sku', variantKey: 'synthetic-variant', sourceCandidateRevision: 61,
    sourceSkuRevision: 6, sourceFinalManifestVersion: 'synthetic-manifest', sourceFinalManifestSha256: 'a'.repeat(64),
    sourceConfirmationId: 'synthetic-confirmation', observedAt: LOCAL_DRAFT_AT, extractorVersion: 'synthetic-extractor',
    status: 'completed', assets: Array.from({ length: 15 }, (_, index) => ({ assetId: `synthetic-asset-${index}`,
      sha256: index.toString(16).padStart(64, '0'), order: index + 1, mediaType: 'image',
      status: index === 13 ? 'failed' : index === 14 ? 'empty' : 'completed',
      text: index > 12 ? '' : `Синтетическая строка ${index + 1}\n原样保留中文与俄文。`, language: 'ru',
      failureCode: index === 13 ? 'OCR_FAILED' : null }))
  };
  const decoded = decodeC1GatewayInput(JSON.parse(JSON.stringify(encodeC1GatewayInput(payload))));
  assert.deepEqual(decoded, payload);
  assert.equal(decoded.referenceContext.imageTextEvidence.assets.length, 15);
  assert.equal(decoded.referenceContext.imageTextEvidence.assets[13].status, 'failed');
  assert.equal(decoded.referenceContext.imageTextEvidence.assets[14].status, 'empty');
});

test('literal marker keys, mixed array shapes, nulls and prototype-like keys cannot be interpreted as references', () => {
  const payload = JSON.parse('{"$s":"literal","$p":[1,"literal"],"$map":{"literal":true},"$table":{"$object":3},"__proto__":{"polluted":true},"rows":[{"$s":1},{"$s":2}],"mixed":[null,{"a":1},{"b":2}],"empty":[],"bool":false}');
  const encoded = encodeC1GatewayInput(payload);
  assert.deepEqual(decodeC1GatewayInput(JSON.parse(JSON.stringify(encoded))), payload);
  assert.equal(Object.prototype.polluted, undefined);
});

test('malformed compact references and tables are explicitly rejected without exposing input contents', () => {
  const envelope = data => ({ encodingVersion: C1_GATEWAY_COMPACT_ENCODING_VERSION, prefixes: ['literal-prefix:'], strings: ['original'], data });
  const invalid = [
    { ...envelope({}), encodingVersion: 'unknown' }, { ...envelope({}), extra: true }, envelope([]),
    envelope({ $s: -1 }), envelope({ $s: 1 }), envelope({ $s: 0.5 }), envelope({ $s: '0' }),
    envelope({ $s: 0, extra: true }), envelope({ $object: [] }),
    envelope({ $p: [1, 'suffix'] }), envelope({ $p: [0, { $s: 0 }] }), envelope({ $p: [0] }),
    { ...envelope({}), strings: [{ $s: 0 }] }, { ...envelope({}), prefixes: [{ $p: [0, 'cycle'] }] },
    envelope({ $table: [[], [[], []]] }), envelope({ $table: [['a', 'a'], [[1, 2], [3, 4]]] }),
    envelope({ $table: [['a'], [[1], []]] }), envelope({ $table: [['a'], [[1]]] }),
    envelope({ $table: [['a'], [[{ $s: 99 }], [2]]] }),
    envelope({ $map: [['a', 'a'], ['value'], [[1], [2]]] }),
    envelope({ $map: [['a'], ['value'], [[1], [2]]] }),
    envelope({ $map: [[0, 1], ['value'], [[1], [2]]] }),
    envelope({ $map: [['a', 'b'], ['value'], [[1], []]] })
  ];
  for (const value of invalid) assert.throws(() => decodeC1GatewayInput(value), /^Error: C1_GATEWAY_INPUT_ENCODING_INVALID:/u);
});

test('shared source prefixes and metric maps retain every literal source and metric value', () => {
  const prefix = 'synthetic-evidence:one-specific-candidate:one-specific-sku:source:';
  const metrics = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`metric-${index}`, {
    value: index, rawValue: null, normalizationRule: 'synthetic-rule', sourceRef: `${prefix}${index}`,
    observedAt: LOCAL_DRAFT_AT, period: null
  }]));
  const payload = { metrics, sources: Object.values(metrics).map(value => value.sourceRef) };
  const encoded = encodeC1GatewayInput(payload);
  assert.ok(encoded.prefixes.length > 0);
  assert.ok(Object.hasOwn(encoded.data.metrics, '$map'));
  assert.deepEqual(decodeC1GatewayInput(JSON.parse(JSON.stringify(encoded))), payload);
});

test('the formal writing view fits admission while the codec also preserves the complete scoring audit losslessly', () => {
  const { candidate, request } = createC1PaidFormalFixture();
  const job = buildC1GatewayJob({ candidateId: candidate.id, dataRevision: candidate.dataRevision, request });
  assert.ok(job.input.text.length <= 24000, `actual prompt chars: ${job.input.text.length}`);
  const encoded = JSON.parse(job.input.text.split('\n\n').at(-1));
  const decoded = decodeC1GatewayInput(encoded);
  assert.deepEqual(decoded.verifiedFacts, request.verifiedFacts);
  assert.deepEqual(decoded.factDefinitions, request.factDefinitions);
  assert.deepEqual(decoded.competitorTextEvidence, request.competitorTextEvidence);
  const writingEvidence = structuredClone(request.keywordEvidence);
  for (const keyword of writingEvidence.keywords) delete keyword.components;
  assert.deepEqual(decoded.keywordEvidence, writingEvidence);
  assert.deepEqual(decodeC1GatewayInput(encodeC1GatewayInput(request.keywordEvidence)), request.keywordEvidence);
  assert.deepEqual(decoded.referenceContext, request.referenceContext);
  assert.deepEqual(decoded.seoRules, request.seoRules);
});

test('non-JSON values and cycles fail before encoding, while bounded nested JSON remains reversible', () => {
  const cycle = {}; cycle.self = cycle;
  for (const payload of [{ value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n },
    { value: new Date() }, { value: () => {} }, { value: Array(2) }, cycle]) {
    assert.throws(() => encodeC1GatewayInput(payload), /^Error: C1_GATEWAY_INPUT_ENCODING_INVALID:/u);
  }
  let nested = { text: 'long repeated string for a source that must remain exactly unchanged', copy: 'long repeated string for a source that must remain exactly unchanged' };
  for (let index = 0; index < 62; index += 1) nested = { next: nested };
  const restored = decodeC1GatewayInput(JSON.parse(JSON.stringify(encodeC1GatewayInput(nested))));
  assert.deepEqual(restored, nested);
  for (let index = 0; index < 3; index += 1) nested = { next: nested };
  assert.throws(() => encodeC1GatewayInput(nested), /nesting depth/u);
});
