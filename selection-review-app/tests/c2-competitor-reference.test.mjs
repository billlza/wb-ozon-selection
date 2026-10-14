import test from 'node:test';
import assert from 'node:assert/strict';
import { C2_REFERENCE_SEMANTICS, collectCanonicalC2ReferenceErrors, assertNoProductionSecrets } from '../lib/production-contract-primitives.mjs';

const evidenceRef = 'evidence:competitor:1';
const reference = `${evidenceRef}#/attributes/Вес товара, г`;
function documentAt(segments, value, rootRef = evidenceRef) {
  const root = {};
  let node = root;
  segments.forEach((segment, index) => {
    const key = segment === '[array]' ? 0 : segment;
    if (index === segments.length - 1) { node[key] = value; return; }
    node[key] = segments[index + 1] === '[array]' ? [] : {};
    node = node[key];
    if (segment === 'competitorTextEvidence') node.evidenceRef = rootRef;
  });
  return root;
}
const paths = C2_REFERENCE_SEMANTICS.c1CompetitorTextReferencePaths;

test('frozen competitor pointers preserve multilingual JSON Pointer segments at every declared C1 container', () => {
  for (const path of paths) for (const suffix of ['Вес товара, г', 'Ozon bank price', '颜色~1型号~0名', '尺寸/0/宽度', '']) {
    const doc = documentAt(path, `${evidenceRef}#/attributes/${suffix}`);
    assert.deepEqual(collectCanonicalC2ReferenceErrors(doc), [], JSON.stringify(path));
    assert.doesNotThrow(() => assertNoProductionSecrets(doc));
  }
});

test('pointer semantics do not expand ordinary refs, unknown containers, fake arrays or asset locations', () => {
  for (const doc of [{ sourceRef: reference }, { assetRef: reference },
    { unknown: documentAt(paths[0], reference) },
    { draftOnlySeo: { editorialSource: { bundle: { request: { competitorTextEvidence: {
      evidenceRef, texts: { '[array]': { sourceRef: reference } }
    } } } } } }]) assert.ok(collectCanonicalC2ReferenceErrors(doc).length > 0);
});

test('extended pointers remain bound to their evidence root and reject malformed, control and secret input', () => {
  const path = paths.find(p => p[0] === 'frozenC1Handoff');
  for (const value of [
    'other:root#/attributes/Вес товара, г', `${evidenceRef}#/other/Вес товара, г`,
    `${evidenceRef}#/attributes/Вес~2`, `${evidenceRef}#/attributes/Вес\nтовара`,
    `${evidenceRef}#/attributes/${'/'.repeat(170)}~2`, `${evidenceRef}#/attributes/${'图'.repeat(300)}`
  ]) assert.ok(collectCanonicalC2ReferenceErrors(documentAt(path, value)).length > 0);
  for (const value of [`${evidenceRef}#/attributes/password=private-value`,
    `${evidenceRef}#/attributes/Cookie: sid=private-value`, `${evidenceRef}#/attributes/Bearer secret-value`]) {
    assert.throws(() => assertNoProductionSecrets(documentAt(path, value)), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  }
});
