import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { buildFinalPricingReviewInput, newFinalPricingReview } from '../src/finalPricingReviewInput.js';
import { candidate as sourceCandidate } from './fixtures/real-a-b-flow-fixture.mjs';
import { evaluateFinalMarketPricing } from '../lib/market-sample-policy.mjs';

async function fixture() {
  const candidate = await sourceCandidate();
  const snapshot = candidate.salesSnapshotsV11[0];
  candidate.salesSnapshotsV11 = [0, 1].map(index => ({ ...structuredClone(snapshot), snapshotId: `synthetic-pricing:${index}`, productUrl: `https://www.ozon.ru/product/${900000000 + index}/`, evidenceRef: `synthetic:product:${index}` }));
  candidate.lifecycleV11 = { skuPackage: { skuPackageId: 'sku:synthetic-final-pricing', businessPhase: 'C2', productionAuthorization: null,
    activeProfitModelVersion: 'profit:synthetic', profitModels: [{ profitModelVersion: 'profit:synthetic', recommendedSalePriceRub: 1800 }] } };
  const reviews = candidate.salesSnapshotsV11.map(item => ({ snapshotId: item.snapshotId,
    ...Object.fromEntries(['exactProduct', 'exactSpecification', 'sameMarket', 'currentlyForSale'].map(key => [key, { value: 'true', evidenceRef: `synthetic:review:${key}` }])),
    salesWindow: { count: '12', startDate: '2026-08-01', endDate: '2026-08-30', dayCount: '30', provenance: 'third_party_estimate', evidenceRef: 'synthetic:sales', validityStatus: 'current', validityEvidenceRef: 'synthetic:validity' }, anomaly: null }));
  return { candidate, sourceRevision: candidate.dataRevision, selectedPriceRub: '1800', reviews };
}
test('final pricing input uses saved identities and explicit facts, stable retry IDs and no actor or computed profit', async () => {
  const f = await fixture(), before = structuredClone(f), input = buildFinalPricingReviewInput(f);
  assert.deepEqual(buildFinalPricingReviewInput(f), input);
  assert.equal(input.selectedPriceRub, 1800); assert.equal(input.reviews[0].salesWindow.count, 12);
  assert.deepEqual(Object.keys(input).sort(), ['candidateId', 'expectedRevision', 'skuPackageId', 'selectedPriceRub', 'reviews', 'idempotencyKey', 'auditEventId'].sort());
  assert.deepEqual(f, before);
  const result = evaluateFinalMarketPricing({ assessmentId: 'synthetic:assessment', assessedAt: '2026-09-09T00:00:00.000Z',
    target: { candidateId: f.candidate.id, sourceRevision: f.sourceRevision, skuPackageId: input.skuPackageId, platform: 'ozon', store: f.candidate.targetStore, storeRef: f.candidate.storeRef, market: f.candidate.salesSnapshotsV11[0].marketScope },
    salesSnapshots: f.candidate.salesSnapshotsV11, reviews: input.reviews, selectedPriceRub: input.selectedPriceRub });
  assert.equal(result.status, 'ready'); assert.equal(result.insufficientSamples, true); assert.equal(result.coreSampleIds.length, 2);
});
test('unknown fact is never checked by default; one reviewed sample and missing window remain diagnostic input', async () => {
  const fresh = newFinalPricingReview('synthetic:sample');
  assert.equal(fresh.exactProduct.value, ''); assert.equal(fresh.salesWindow, null);
  const f = await fixture(); f.reviews = [f.reviews[0]]; f.reviews[0].salesWindow = null;
  assert.equal(buildFinalPricingReviewInput(f).reviews[0].salesWindow, null);
  f.reviews[0].exactProduct.value = '';
  assert.throws(() => buildFinalPricingReviewInput(f), /不能默认确认/);
});
test('revision, source membership, duplicates, required provenance and locked lifecycle fail closed', async () => {
  for (const mutate of [
    f => f.sourceRevision++, f => f.reviews[0].snapshotId = 'foreign', f => f.reviews.push(structuredClone(f.reviews[0])),
    f => f.reviews[0].exactProduct.evidenceRef = '', f => f.reviews[0].salesWindow.count = '',
    f => f.reviews[0].salesWindow.dayCount = '', f => f.reviews[0].salesWindow.startDate = '2026-02-30',
    f => f.selectedPriceRub = '', f => f.selectedPriceRub = 0,
    f => f.candidate.lifecycleV11.skuPackage.productionAuthorization = { authorizationId: 'saved' },
    f => f.candidate.lifecycleV11.skuPackage.businessPhase = 'A'
  ]) { const f = await fixture(); mutate(f); assert.throws(() => buildFinalPricingReviewInput(f)); }
});
test('component renders reference price and missing samples without submitting history or claiming final approval', async () => {
  const entry = fileURLToPath(new URL('./final-pricing-render-entry.jsx', import.meta.url));
  const component = fileURLToPath(new URL('../src/components/FinalPricingReviewForm.jsx', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'warn', plugins: [react(), {
    name: 'final-pricing-render', resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Form from ${JSON.stringify(component)}; export const render = candidate => renderToStaticMarkup(<Form candidate={candidate} onSave={() => {throw new Error('UNEXPECTED_SAVE')}}/>);` : null
  }], ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
  const chunk = bundle.output.find(item => item.type === 'chunk' && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  const f = await fixture(), before = structuredClone(f.candidate), html = render(f.candidate);
  assert.match(html, /已保存成交价：1800 RUB/); assert.match(html, /当前选择不足3条/);
  assert.match(html, /主人主动复核或调整售价/); assert.match(html, /有效且达到批准门槛的正式方案优先沿用/);
  assert.match(html, /不要求为价格差异重复研究/); assert.match(html, /浏览器不计算利润/);
  assert.match(html, /保存比较不等于生产授权/);
  assert.doesNotMatch(html, /checked=""/); assert.match(html, /<button[^>]*disabled[^>]*>保存最终定价比较/);
  assert.deepEqual(f.candidate, before);
});
