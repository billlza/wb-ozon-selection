import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOzonProductImportBatchLimitEvidence,
  loadOzonProductImportBatchLimitEvidence } from '../lib/ozon-product-import-batch-limit.mjs';

test('versioned official import limit is one request of 100 items, not an account quota',async()=>{
  const evidence=await loadOzonProductImportBatchLimitEvidence();
  assert.equal(evidence.sourceUrl,'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3');
  assert.equal(evidence.maxItemsPerRequest,100);
  assert.equal(evidence.endpoint,'/v3/product/import');
  assert.equal(evidence.validUntil,'2026-10-05T00:40:19.000Z');
  assert.equal(Object.hasOwn(evidence,'dailyRemaining'),false);
  assert.equal(Object.isFrozen(evidence),true);
  assert.deepEqual(assertOzonProductImportBatchLimitEvidence(evidence),evidence);
  for(const patch of [
    {maxItemsPerRequest:101}, {maxItemsPerRequest:99},
    {sourceUrl:'https://example.test/claim'}, {operationId:'OtherOperation'},
    {sourceStatement:'up to 1000'}, {itemsConstraint:'items <= 1000'},
    {evidenceRef:'official:ozon-product-import-batch-limit:other'},
    {validUntil:'2026-10-06T00:40:19.000Z'},
    {observedAt:'2026-09-29T00:40:19.000Z'},
    {dailyRemaining:100}
  ]){
    assert.throws(()=>assertOzonProductImportBatchLimitEvidence({...evidence,...patch}),
      /OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  }
});
