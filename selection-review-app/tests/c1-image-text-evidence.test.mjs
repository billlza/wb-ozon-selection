import test from 'node:test';
import assert from 'node:assert/strict';
import { readC1ImageTextManifest, assertC1ImageTextEvidence, extractC1ImageTextEvidence } from '../lib/c1-image-text-evidence.mjs';
import { createLocalImageTextAdapter } from '../lib/local-image-text-adapter.mjs';
import { imageTextFixture, OCR_AT, archiveImageManifestForC1Fixture } from './fixtures/c1-image-text-fixture.mjs';

const extract = fixture => extractC1ImageTextEvidence({ ...fixture, observedAt: OCR_AT, receiptId: 'synthetic:ocr-receipt' });

test('confirmed manifest preserves exact SKU, approved image hash/order and content-verified store reads', async () => {
  const f = imageTextFixture(), before = structuredClone(f.candidate);
  const manifest = readC1ImageTextManifest(f.candidate), sku = f.candidate.lifecycleV11.skuPackage;
  assert.equal(manifest.supplierSkuId, sku.supplierSkuId);
  assert.equal(manifest.variantKey, sku.variantKey);
  assert.deepEqual(manifest.assets.map(a => [a.assetId, a.sha256, a.order]), sku.c2FinalAssets.assets.finalUploads.map(a => [a.assetId, a.sha256, a.order]));
  const receipt = await extract(f);
  assert.equal(receipt.role, 'unverified_language_reference');
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.assets.map(a => a.status), ['extracted', 'extracted']);
  assert.deepEqual(f.reads.map(a => a.assetId), manifest.assets.map(a => a.assetId));
  assert.equal(f.calls.length, 2);
  assert.equal(assertC1ImageTextEvidence(JSON.parse(JSON.stringify(receipt))).receiptId, receipt.receiptId);
  assert.deepEqual(f.candidate, before);
});

test('wrong registration, approval, order and image identity are rejected before store or extractor calls', async () => {
  const mutations = [
    c => { c.lifecycleV11.c2UploadDraft.candidateId = 'other-candidate'; },
    c => { c.lifecycleV11.c2UploadDraft.skuPackageId = 'other-sku'; },
    c => { c.lifecycleV11.c2UploadDraft.sourceC1Fingerprint = 'different'; },
    c => { c.lifecycleV11.c2UploadDraft.uploads[0].sha256 = 'f'.repeat(64); },
    c => { c.lifecycleV11.c2UploadDraft.selection.reverse(); },
    c => { c.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation.status = 'not_confirmed'; },
    c => { c.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads[0].productionEligible = false; },
    c => { c.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads[0].mediaType = 'video'; }
  ];
  for (const mutate of mutations) {
    const f = imageTextFixture(); mutate(f.candidate);
    await assert.rejects(extract(f), /C1_IMAGE_TEXT_|PRODUCTION_AUTHORIZATION_/);
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('matching edited upload records cannot borrow the old owner-approved hash', () => {
  const f = imageTextFixture(), life = f.candidate.lifecycleV11;
  life.c2UploadDraft.uploads[0].sha256 = 'f'.repeat(64);
  life.skuPackage.c2FinalAssets.assets.finalUploads[0].sha256 = 'f'.repeat(64);
  assert.throws(() => readC1ImageTextManifest(f.candidate), /C1_IMAGE_TEXT_|PRODUCTION_AUTHORIZATION_/);
});

test('explicit no-text differs from failure and failure stops later images without retries or raw errors', async () => {
  const f = imageTextFixture({ count: 3 }); let attempts = 0;
  f.extractor.extract = async () => {
    attempts++;
    if (attempts === 1) return { text: ' \n ', language: 'ru-RU' };
    throw Object.assign(new Error('raw credential-like process details must not persist'), { code: 'IMAGE_TEXT_RECOGNITION_FAILED' });
  };
  const receipt = await extract(f);
  assert.equal(attempts, 2); assert.equal(f.reads.length, 2);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.assets.map(a => a.status), ['no_text', 'failed', 'failed']);
  assert.deepEqual(receipt.assets.map(a => a.failureCode), [null, 'IMAGE_TEXT_RECOGNITION_FAILED', 'NOT_ATTEMPTED_AFTER_FAILURE']);
  assert.ok(receipt.assets.every(a => a.text === ''));
  assert.doesNotMatch(JSON.stringify(receipt), /raw credential|process details/);
});

test('per-image and aggregate text capacity stop extraction with explicit failed receipts', async () => {
  const perImage = imageTextFixture();
  perImage.extractor.extract = async () => ({ text: 'я'.repeat(30001), language: 'ru-RU' });
  const first = await extract(perImage);
  assert.equal(first.status, 'failed');
  assert.equal(first.assets[0].failureCode, 'C1_IMAGE_TEXT_EXTRACTOR_RESULT_INVALID');
  assert.equal(first.assets[1].failureCode, 'NOT_ATTEMPTED_AFTER_FAILURE');
  const aggregate = imageTextFixture({ count: 7 }); let calls = 0;
  aggregate.extractor.extract = async () => { calls++; return { text: 'я'.repeat(30000), language: 'ru-RU' }; };
  const second = await extract(aggregate);
  assert.equal(calls, 6); assert.equal(second.status, 'failed');
  assert.equal(second.assets[5].failureCode, 'C1_IMAGE_TEXT_CAPACITY_EXCEEDED');
  assert.equal(second.assets[6].failureCode, 'NOT_ATTEMPTED_AFTER_FAILURE');
  assert.equal(second.assets.reduce((n, a) => n + a.text.length, 0), 150000);
});

test('strict persisted receipt rejects extra data, inconsistent status, duplicate identities and oversized text', async () => {
  const base = await extract(imageTextFixture());
  const mutations = [
    r => { r.rawProviderResponse = 'forbidden'; }, r => { r.status = 'failed'; },
    r => { r.assets[1].assetId = r.assets[0].assetId; }, r => { r.assets[0].order = 2; },
    r => { r.assets[0].text = 'я'.repeat(30001); }, r => { r.assets[0].status = 'no_text'; },
    r => { r.assets[0].language = 'en-US'; }, r => { r.assets[0].failureCode = 'unexpected'; }
  ];
  for (const mutate of mutations) { const record = structuredClone(base); mutate(record); assert.throws(() => assertC1ImageTextEvidence(record), /C1_IMAGE_TEXT_EVIDENCE_INVALID/); }
});

test('current SKU identity cannot relabel images approved for a different supplier SKU or variant', () => {
  for (const key of ['supplierSkuId', 'variantKey']) {
    const f = imageTextFixture();
    f.candidate.lifecycleV11.skuPackage[key] = 'other-sku-identity';
    assert.throws(() => readC1ImageTextManifest(f.candidate), /C1_IMAGE_TEXT_|PRODUCTION_AUTHORIZATION_/);
  }
});

test('new C1 revision reads the unique approved image lineage and rejects cross-SKU or ambiguous history', () => {
  const f = imageTextFixture(), candidate = structuredClone(f.candidate);
  const old = archiveImageManifestForC1Fixture(candidate);
  const before = structuredClone(candidate), manifest = readC1ImageTextManifest(candidate);
  assert.equal(manifest.sourceCandidateRevision, f.candidate.dataRevision);
  assert.equal(manifest.sourceSkuRevision, old.dataRevision);
  assert.deepEqual(manifest.assets.map(a => a.assetId), old.c2FinalAssets.assets.finalUploads.map(a => a.assetId));
  assert.deepEqual(candidate, before);
  const wrongSku = structuredClone(candidate);
  wrongSku.lifecycleV11.c1FinalPlanRevisionHistory[0].sourceIdentity.supplierSkuId = 'other-supplier';
  assert.throws(() => readC1ImageTextManifest(wrongSku), /C1_IMAGE_TEXT_SOURCE_IDENTITY_MISMATCH/);
  candidate.lifecycleV11.c1FinalPlanRevisionHistory.push(structuredClone(candidate.lifecycleV11.c1FinalPlanRevisionHistory[0]));
  assert.throws(() => readC1ImageTextManifest(candidate), /C1_IMAGE_TEXT_LINEAGE_INVALID/);
});

test('a content-verification failure becomes a failed receipt without invoking OCR or reading later images', async () => {
  const f = imageTextFixture(); let reads = 0;
  f.assetStore.read = async (_asset, options) => {
    assert.equal(options.verifyContent, true); reads++;
    throw Object.assign(new Error('sensitive local path must not persist'), { extra: { code: 'c2_local_asset_checksum_mismatch' } });
  };
  const receipt = await extract(f);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.assets[0].failureCode, 'c2_local_asset_checksum_mismatch');
  assert.equal(receipt.assets[1].failureCode, 'NOT_ATTEMPTED_AFTER_FAILURE');
  assert.equal(reads, 1); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /sensitive local path/);
});

test('unclassified extraction errors retain failure rather than becoming an empty success or leaking details', async () => {
  const f = imageTextFixture();
  f.extractor.extract = async () => { throw Object.assign(new Error('private raw response'), { code: 'secret=private-value' }); };
  const receipt = await extract(f);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.assets[0].failureCode, 'C1_IMAGE_TEXT_INTERNAL_ERROR');
  assert.equal(receipt.assets[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(receipt), /private-value|private raw response/);
});

// A synthetic Node child emits protocol fixtures; no Vision/OCR or filesystem reads occur.
test('local adapter rejects null/malformed child results and recovers its single-call lock', async () => {
  const adapter = createLocalImageTextAdapter({ executablePath: process.execPath, timeoutMs: 5000 });
  for (const body of ["process.stdout.write('null')", "process.stdout.write('not-json')", "process.stdout.write(JSON.stringify({version:'wrong',lines:[],languages:['ru-RU']}))"]) {
    await assert.rejects(adapter.extract({ body: Buffer.from(body) }), /IMAGE_TEXT_RESULT_INVALID/);
  }
  await assert.rejects(adapter.extract({ body: Buffer.from("process.stderr.write('private synthetic diagnostic');process.exit(1)") }), error => {
    assert.equal(error.code, 'IMAGE_TEXT_RECOGNITION_FAILED'); assert.doesNotMatch(error.message, /private synthetic/); return true;
  });
  const body = Buffer.from("process.stdout.write(JSON.stringify({version:'apple-vision-text-v1',revision:3,lines:['Синтетический текст'],languages:['ru-RU']}))");
  const result = await adapter.extract({ body });
  assert.equal(result.text, 'Синтетический текст'); assert.equal(result.language, 'ru-RU');
  assert.equal(result.extractorVersion, 'apple-vision-text-v1:revision-3');
});

test('local adapter bounds concurrent work, cancels children and clears timeout resources', async () => {
  const body = Buffer.from('setInterval(()=>{},1000)');
  const adapter = createLocalImageTextAdapter({ executablePath: process.execPath, timeoutMs: 5000 });
  const controller = new AbortController(), pending = adapter.extract({ body, signal: controller.signal });
  await assert.rejects(adapter.extract({ body }), /IMAGE_TEXT_BUSY/);
  controller.abort();
  await assert.rejects(pending, /IMAGE_TEXT_CANCELLED/);
  const timeoutAdapter = createLocalImageTextAdapter({ executablePath: process.execPath, timeoutMs: 20 });
  await assert.rejects(timeoutAdapter.extract({ body }), /IMAGE_TEXT_TIMEOUT/);
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(adapter.extract({ body, signal: alreadyCancelled.signal }), /IMAGE_TEXT_CANCELLED/);
});

test('compact image history rejects half migrations, changed scope, versions and manifest contents', () => {
  const source = imageTextFixture().candidate;
  archiveImageManifestForC1Fixture(source);
  for (const mutate of [
    (entry) => { delete entry.schemaVersion; },
    (entry) => { entry.previousSkuPackage = {}; },
    (entry) => { entry.sourceCandidateRevision -= 1; },
    (entry) => { entry.sourceSkuRevision -= 1; },
    (entry) => { entry.sourceC1PlanId = 'other-plan'; },
    (entry) => { entry.sourceIdentity.storeRef.stableStoreId = 'other-store'; },
    (entry) => { entry.variantKey = 'other-variant'; },
    (entry) => { entry.sourceFinalAssets.sourceC1Fingerprint = 'f'.repeat(64); },
    (entry) => { entry.sourceFinalAssets.assets.finalUploads[0].sha256 = 'f'.repeat(64); },
    (_entry, candidate) => { candidate.lifecycleV11.c1FinalPlanRevisionPreparation.preparationId = 'other-preparation'; }
  ]) {
    const candidate = structuredClone(source);
    mutate(candidate.lifecycleV11.c1FinalPlanRevisionHistory[0], candidate);
    assert.throws(() => readC1ImageTextManifest(candidate), /C1_IMAGE_TEXT_/);
  }
});
