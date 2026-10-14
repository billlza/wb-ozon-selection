import test from 'node:test';
import assert from 'node:assert/strict';
import { createC1ImageTextUseCase } from '../lib/c1-image-text-use-case.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { imageTextFixture, replaceCandidate, deferred } from './fixtures/c1-image-text-fixture.mjs';

const service = f => createC1ImageTextUseCase({ ...f, runtimeMode: 'local_development' });
const run = (api, f, input = f.input) => api.extract({ actor: f.owner, input });
const current = async f => (await f.repository.readSnapshot()).candidates[0];

test('intent is persisted before extraction and JSON-reloaded completed receipt is reusable with zero further work', async () => {
  const f = imageTextFixture(), original = structuredClone(f.candidate);
  let attempts = 0;
  f.extractor.extract = async () => {
    const persisted = await current(f);
    assert.equal(persisted.lifecycleV11.c1ImageTextExtractionV1.status, 'running');
    assert.equal(persisted.dataRevision, original.dataRevision + 1);
    assert.equal(persisted.lifecycleV11.c1ImageTextEvidenceV1, undefined);
    attempts++;
    return { text: `Текст ${attempts}`, language: 'ru-RU' };
  };
  const result = await run(service(f), f), saved = await current(f);
  assert.equal(result.result.status, 'completed');
  assert.equal(saved.dataRevision, original.dataRevision + 2);
  assert.equal(saved.lifecycleV11.c1ImageTextEvidenceV1.sourceCandidateRevision, original.dataRevision);
  assert.equal(attempts, 2);
  assert.deepEqual(saved.lifecycleV11.skuPackage, original.lifecycleV11.skuPackage);
  const json = JSON.stringify(await f.repository.readSnapshot());
  f.repository = createMemoryBusinessStateRepository(JSON.parse(json));
  const reused = await run(service(f), f, { candidateId: saved.id, expectedRevision: saved.dataRevision });
  assert.equal(reused.status, 'already_current');
  assert.equal(attempts, 2); assert.equal(f.reads.length, 2);
  assert.equal(JSON.stringify(await f.repository.readSnapshot()), json);
});

test('owner, exact input, current revision and available service are required before any mutation or OCR', async () => {
  const cases = [
    f => ({ api: service(f), actor: { ...f.owner, roles: ['reviewer'] }, input: f.input }),
    f => ({ api: service(f), actor: { ...f.owner, source: 'maintenance_script' }, input: f.input }),
    f => ({ api: service(f), actor: f.owner, input: { ...f.input, expectedRevision: f.input.expectedRevision - 1 } }),
    f => ({ api: service(f), actor: f.owner, input: { ...f.input, extra: true } }),
    f => ({ api: service(f), actor: f.owner, input: { ...f.input, candidateId: 'another-candidate' } }),
    f => ({ api: createC1ImageTextUseCase({ ...f, extractor: null, runtimeMode: 'local_development' }), actor: f.owner, input: f.input })
  ];
  for (const make of cases) {
    const f = imageTextFixture(), before = await f.repository.readSnapshot(), value = make(f);
    await assert.rejects(value.api.extract(value), /RUNTIME_|C1_IMAGE_TEXT_/);
    assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('failed extraction is persisted as failed, survives JSON reload and never automatically retries', async () => {
  const f = imageTextFixture(); let attempts = 0;
  f.extractor.extract = async () => { attempts++; throw Object.assign(new Error('private provider details'), { code: 'IMAGE_TEXT_RECOGNITION_FAILED' }); };
  const first = await run(service(f), f), saved = await current(f);
  assert.equal(first.result.status, 'failed');
  assert.equal(saved.lifecycleV11.c1ImageTextExtractionV1.status, 'failed');
  assert.equal(saved.lifecycleV11.c1ImageTextEvidenceV1.status, 'failed');
  assert.equal(saved.lifecycleV11.c1ImageTextEvidenceV1.assets[0].failureCode, 'IMAGE_TEXT_RECOGNITION_FAILED');
  const serialized = JSON.stringify(await f.repository.readSnapshot());
  assert.doesNotMatch(serialized, /private provider details/);
  f.repository = createMemoryBusinessStateRepository(JSON.parse(serialized));
  await assert.rejects(run(service(f), f, { candidateId: saved.id, expectedRevision: saved.dataRevision }), /C1_IMAGE_TEXT_EXISTING_JOB_REVIEW_REQUIRED/);
  assert.equal(attempts, 1); assert.equal(f.reads.length, 1);
  assert.equal(JSON.stringify(await f.repository.readSnapshot()), serialized);
});

test('single service capacity and cross-instance transaction revision prevent duplicate extraction', async () => {
  const f = imageTextFixture(), entered = deferred(), release = deferred(); let attempts = 0;
  f.extractor.extract = async () => { attempts++; if (attempts === 1) { entered.resolve(); await release.promise; } return { text: 'Текст', language: 'ru-RU' }; };
  const api = service(f), first = run(api, f); await entered.promise;
  await assert.rejects(run(api, f), /C1_IMAGE_TEXT_BUSY/);
  await assert.rejects(run(service(f), f), /C1_IMAGE_TEXT_REVISION_CONFLICT/);
  const inProgress = await current(f);
  await assert.rejects(run(service(f), f, { candidateId: inProgress.id, expectedRevision: inProgress.dataRevision }), /C1_IMAGE_TEXT_INTERRUPTED_REVIEW_REQUIRED/);
  release.resolve(); await first;
  assert.equal(attempts, 2);
  assert.equal((await current(f)).lifecycleV11.c1ImageTextExtractionV1.status, 'completed');
});

test('completed receipt cannot be reused after cross-candidate, cross-SKU, wrong image or confirmation identity corruption', async () => {
  const f = imageTextFixture(); await run(service(f), f);
  const document = await f.repository.readSnapshot();
  const mutations = [
    r => { r.candidateId = 'other-candidate'; }, r => { r.skuPackageId = 'other-sku-package'; },
    r => { r.supplierSkuId = 'other-supplier'; }, r => { r.variantKey = 'other-variant'; },
    r => { r.assets[0].sha256 = 'f'.repeat(64); }, r => { r.assets[0].assetId = 'other-image'; },
    r => { r.sourceConfirmationId = 'other-owner-confirmation'; }, r => { r.sourceFinalManifestVersion = 'other-version'; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(document); mutate(changed.candidates[0].lifecycleV11.c1ImageTextEvidenceV1);
    const repository = createMemoryBusinessStateRepository(changed), before = await repository.readSnapshot();
    const isolated = { ...f, repository };
    await assert.rejects(run(service(isolated), isolated, { candidateId: changed.candidates[0].id, expectedRevision: changed.candidates[0].dataRevision }), /C1_IMAGE_TEXT_(RECEIPT|EVIDENCE|MANIFEST).*INVALID|C1_IMAGE_TEXT_.*MISMATCH/);
    assert.deepEqual(await repository.readSnapshot(), before);
  }
  assert.equal(f.calls.length, 2);
});

test('identity drift during an in-flight extraction prevents success settlement', async () => {
  const f = imageTextFixture(), entered = deferred(), release = deferred(); let attempts = 0;
  f.extractor.extract = async () => { attempts++; if (attempts === 1) { entered.resolve(); await release.promise; } return { text: 'Текст', language: 'ru-RU' }; };
  const pending = run(service(f), f); await entered.promise;
  await replaceCandidate(f.repository, c => { c.lifecycleV11.skuPackage.variantKey = 'other-variant'; });
  release.resolve();
  await assert.rejects(pending, /C1_IMAGE_TEXT_|PRODUCTION_AUTHORIZATION_/);
  const saved = await current(f);
  assert.notEqual(saved.lifecycleV11.c1ImageTextExtractionV1.status, 'completed');
  assert.equal(saved.lifecycleV11.c1ImageTextEvidenceV1, undefined);
});

test('memory repository remains a local test adapter and is rejected as central production persistence', () => {
  const f = imageTextFixture();
  assert.throws(() => createC1ImageTextUseCase({ ...f, runtimeMode: 'central_production' }), /Production state has no central persistence boundary/);
  assert.throws(() => createC1ImageTextUseCase({ ...f, runtimeMode: 'central_test' }), /Production state has no central persistence boundary/);
});

test('service shutdown cancels active extraction and persists its classified failure before returning', async () => {
  const f = imageTextFixture(), entered = deferred();
  f.extractor.extract = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'IMAGE_TEXT_CANCELLED' })), { once: true });
    entered.resolve();
  });
  const api = service(f), pending = run(api, f);
  await entered.promise;
  await api.stop();
  const completed = await pending;
  assert.equal(completed.result.status, 'failed');
  const saved = await current(f);
  assert.equal(saved.lifecycleV11.c1ImageTextExtractionV1.status, 'failed');
  assert.equal(saved.lifecycleV11.c1ImageTextEvidenceV1.assets[0].failureCode, 'IMAGE_TEXT_CANCELLED');
});
