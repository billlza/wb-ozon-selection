import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './fixtures/c1-local-draft-source-fixture.mjs';
import { authorizedExecution } from './fixtures/c1-ai-draft-fixture.mjs';
import { c1DraftPaidReceipt } from './fixtures/c1-draft-source-fixture.mjs';
import { prepareC1LocalDraftSource } from '../lib/c1-local-draft-source.mjs';
import { prepareCurrentC1AiDraftRequest } from '../lib/c1-ai-draft-request-source.mjs';
import { validateC1AiDraftRequest, validateC1AiDraftOutput, validateC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { buildC1GatewayJob } from '../lib/c1-ai-gateway.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

// These deliberately synthetic sentences exercise the deterministic contract.
// Passing the checks is not evidence of a real product claim or a good translation.
function prepared(contractOptions = {}) {
  const candidate = createSavedLocalPreparationCandidate();
  const source = prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT });
  candidate.lifecycleV11.skuPackage = structuredClone(source.skuPackage);
  candidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(source.sourceEvidence);
  const request = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT, contractOptions);
  const execution = authorizedExecution(request, candidate.dataRevision);
  const response = c1DraftPaidReceipt({ request, authorizedExecution: execution }, LOCAL_DRAFT_AT);
  return { candidate, request, response };
}
function item(response, text, reviewZh = '合成测试中文释义') {
  return { ...structuredClone(response.output.description), text, reviewZh };
}
function outputWith(response, description, bullets) {
  const output = structuredClone(response.output);
  output.description = item(response, description);
  output.bulletPoints = bullets.map(text => item(response, text));
  return output;
}
function receiptWith(response, output) {
  return { ...structuredClone(response), output, outputFingerprint: fingerprintCanonicalRecord(output) };
}

test('current preparation freezes semantic guidance and sends it through the real gateway builder without calling a service', () => {
  const { candidate, request } = prepared();
  assert.equal(request.factDefinitionsVersion, 'c1-fact-definitions-v1');
  assert.deepEqual(validateC1AiDraftRequest(request), { valid: true, errors: [] });
  assert.equal(request.outputContractSnapshot.outputSchema.properties.bulletPoints.minItems, 0);
  const instructions = request.outputContractSnapshot.instructions.join('\n');
  assert.match(instructions, /factDefinitions.*字段含义/u);
  assert.match(instructions, /材质写成材质/u);
  assert.match(instructions, /不得将材质值写成款式、型号或规格名/u);
  assert.match(instructions, /core_product必须表达.*产品形态/u);
  assert.match(instructions, /适用对象、颜色或材质.*attribute/u);
  assert.match(instructions, /描述面向买家/u);
  assert.match(instructions, /换句式表达同一主张仍算重复/u);
  assert.match(instructions, /没有补充信息时bulletPoints必须为空数组/u);
  assert.match(instructions, /reviewZh只直接翻译/u);
  assert.match(instructions, /不写事实来源、采用理由或引用依据/u);
  const before = structuredClone(request);
  const job = buildC1GatewayJob({ candidateId: candidate.id, dataRevision: candidate.dataRevision, request });
  for (const instruction of request.outputContractSnapshot.instructions) assert.ok(job.input.text.includes(instruction));
  assert.deepEqual(request, before);
});

test('new semantic contract allows zero supplementary bullets and accepts the correctly fingerprinted receipt', async () => {
  const { request, response } = prepared();
  const output = outputWith(response, 'Синтетическое описание.', []);
  assert.deepEqual(validateC1AiDraftOutput({ request, output }), { valid: true, errors: [] });
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: receiptWith(response, output) }), { valid: true, errors: [] });
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  const published = JSON.parse(await readFile(new URL('../schema/c1-ai-draft-receipt-v1.schema.json', import.meta.url), 'utf8'));
  const validateReceipt = ajv.compile(published);
  assert.equal(validateReceipt(receiptWith(response, output)), true, JSON.stringify(validateReceipt.errors));
  const validateOutput = ajv.compile(request.outputContractSnapshot.outputSchema);
  assert.equal(validateOutput(output), true, JSON.stringify(validateOutput.errors));
  assert.equal(response.output.bulletPoints.length, 1, 'the shared fixture must not be mutated');
});

test('new semantic contract rejects a repeated whole description, complete sentence or paragraph including normalized whitespace', () => {
  const { request, response } = prepared();
  for (const [description, bullet] of [
    ['Синтетическое описание.', 'Синтетическое описание.'],
    ['Первое предложение. Второе предложение.', 'Второе предложение.'],
    ['Первый абзац.\n\nВторой абзац.', 'Второй абзац.'],
    ['Первый абзац.\n\nВторой   абзац.', '  Второй\nабзац.  ']
  ]) {
    const output = outputWith(response, description, [bullet]);
    const validation = validateC1AiDraftOutput({ request, output });
    assert.equal(validation.valid, false, description);
    assert.ok(validation.errors.some(error => /output\.bulletPoints\[0\].*重复/u.test(error)), validation.errors.join('\n'));
    assert.equal(validateC1AiDraftReceipt({ request, receipt: receiptWith(response, output) }).valid, false);
  }
});

test('new semantic contract rejects repeated bullets while preserving both original input and the first distinct item', () => {
  const { request, response } = prepared();
  const output = outputWith(response, 'Синтетическое описание.', ['Дополнительный пункт.', 'Дополнительный   пункт.']);
  const before = structuredClone(output);
  const validation = validateC1AiDraftOutput({ request, output });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => /output\.bulletPoints\[1\].*重复/u.test(error)));
  assert.equal(validation.errors.some(error => /output\.bulletPoints\[0\].*重复/u.test(error)), false);
  assert.deepEqual(output, before);
});

test('different complete statements survive; deterministic validation does not invent semantic equivalence or certify translations', () => {
  const { request, response } = prepared();
  const output = outputWith(response, 'Первый синтетический факт.', ['Второй синтетический факт.', 'Третий синтетический факт.']);
  assert.deepEqual(validateC1AiDraftOutput({ request, output }), { valid: true, errors: [] });
  // The text rule recognizes exact normalized repetition only, not paraphrases.
  const paraphrase = outputWith(response, 'Пример для проверки.', ['Проверочный пример.']);
  assert.deepEqual(validateC1AiDraftOutput({ request, output: paraphrase }), { valid: true, errors: [] });
  const missingReview = structuredClone(output); delete missingReview.bulletPoints[0].reviewZh;
  assert.equal(validateC1AiDraftOutput({ request, output: missingReview }).valid, false);
  const chineseInRussian = structuredClone(output); chineseInRussian.bulletPoints[0].text += '中文';
  assert.equal(validateC1AiDraftOutput({ request, output: chineseInRussian }).valid, false);
});

test('explicit historical contract preserves repeated valid receipts and its original minimum rather than silently adopting new rules', () => {
  const { candidate, request, response } = prepared({ factDefinitionsVersion: null });
  assert.equal(Object.hasOwn(request, 'factDefinitionsVersion'), false);
  assert.equal(request.outputContractSnapshot.outputSchema.properties.bulletPoints.minItems, 1);
  assert.equal(request.outputContractSnapshot.instructions.some(text => text.includes('factDefinitions')), false);
  assert.deepEqual(validateC1AiDraftRequest(request), { valid: true, errors: [] });
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: response }), { valid: true, errors: [] });
  const repeated = outputWith(response, 'Синтетический повтор.', ['Синтетический повтор.', 'Синтетический повтор.']);
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: receiptWith(response, repeated) }), { valid: true, errors: [] });
  assert.equal(validateC1AiDraftOutput({ request, output: outputWith(response, 'Синтетический повтор.', []) }).valid, false);
  assert.deepEqual(prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT, { factDefinitionsVersion: null }), request);
  const current = prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT);
  assert.notEqual(current.requestFingerprint, request.requestFingerprint);
  assert.equal(validateC1AiDraftReceipt({ request: current, receipt: response }).valid, false);
});
