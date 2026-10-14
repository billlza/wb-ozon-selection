import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOzonOptionalAttributes } from '../lib/ozon-submission-attributes.mjs';
function input() { return { attributes: { requiredPlatformFields: [{ fieldKey: '85' }], ozonAttributes: [
  { fieldKey: '85' }, { fieldKey: '5953', fact: { verificationStatus: 'confirmed', sourceRefs: ['mapping:1'], value: { value: 'Унисекс', dictionaryValueId: 1884 } } },
  { fieldKey: '10096', fact: { verificationStatus: 'unknown' } }
] }, platformSchemaAttributes: [{ fieldKey: '5953', required: false, complexId: 0, dictionaryId: 1 }] }; }
test('only confirmed applicable optional fields are added; unknowns are explicitly omitted', () => {
  assert.deepEqual(buildOzonOptionalAttributes(input()), { attributes: [{ id: 5953, complex_id: 0, values: [{ dictionary_value_id: 1884, value: 'Унисекс' }] }], omissions: [{ fieldKey: '10096', reason: 'fact_unconfirmed' }] });
});
test('optional mapping rejects absent schema, duplicate fields, missing provenance and guessed dictionary values', () => {
  for (const mutate of [i => i.platformSchemaAttributes = null, i => i.platformSchemaAttributes[0].required = true, i => i.attributes.ozonAttributes.push(structuredClone(i.attributes.ozonAttributes[1])), i => i.attributes.ozonAttributes[1].fact.sourceRefs = [], i => delete i.attributes.ozonAttributes[1].fact.value.dictionaryValueId]) {
    const i = input(); mutate(i); assert.throws(() => buildOzonOptionalAttributes(i), /OZON_OPTIONAL_/);
  }
});
test('schema free text is sent without fabricated dictionary ID; legacy absence preserves existing payload', () => {
  const i = input(); i.platformSchemaAttributes[0].dictionaryId = 0; i.attributes.ozonAttributes[1].fact.value = 150;
  assert.deepEqual(buildOzonOptionalAttributes(i).attributes[0].values, [{ dictionary_value_id: 0, value: '150' }]);
  assert.deepEqual(buildOzonOptionalAttributes({ attributes: { requiredPlatformFields: [] }, platformSchemaAttributes: null }), { attributes: [], omissions: [] });
});
