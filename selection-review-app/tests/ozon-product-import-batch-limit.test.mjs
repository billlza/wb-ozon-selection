import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertOzonProductImportBatchLimitCurrent, assertOzonProductImportBatchLimitEvidence,
  loadOzonProductImportBatchLimitEvidence, ozonProductImportBatchLimitCurrent } from '../lib/ozon-product-import-batch-limit.mjs';

test('versioned official import limit is one request of 100 items, not an account quota',async()=>{
  const evidence=await loadOzonProductImportBatchLimitEvidence();
  assert.equal(evidence.sourceUrl,'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3');
  assert.equal(evidence.maxItemsPerRequest,100);
  assert.equal(evidence.endpoint,'/v3/product/import');
  assert.equal(evidence.evidenceRef,`official:ozon-product-import-batch-limit:${evidence.observedAt.slice(0,10).replaceAll('-','')}`);
  assert.ok(Date.parse(evidence.observedAt)<Date.parse(evidence.validUntil));
  assert.equal(Object.hasOwn(evidence,'dailyRemaining'),false);
  assert.equal(Object.isFrozen(evidence),true);
  assert.deepEqual(assertOzonProductImportBatchLimitEvidence(evidence),evidence);
  for(const patch of [
    {maxItemsPerRequest:101}, {maxItemsPerRequest:99},
    {sourceUrl:'https://example.test/claim'}, {operationId:'OtherOperation'},
    {sourceStatement:'up to 1000'}, {itemsConstraint:'items <= 1000'},
    {evidenceRef:'official:ozon-product-import-batch-limit:other'},
    // The check day in the reference is the day of observedAt, so a record cannot move its check without saying so.
    {observedAt:'2026-09-29T00:40:19.000Z'},
    {validUntil:evidence.observedAt}, {validUntil:'2026-09-27T00:00:00.000Z'}, {validUntil:'next week'},
    {dailyRemaining:100}
  ]){
    assert.throws(()=>assertOzonProductImportBatchLimitEvidence({...evidence,...patch}),
      /OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  }
});

test('how long a check holds is the record\'s own, so a fresh check of the official page is data, not a code release',()=>{
  const checked={schemaVersion:'ozon-product-import-batch-limit-evidence-v1',
    evidenceRef:'official:ozon-product-import-batch-limit:20261012',
    sourceUrl:'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3',operationId:'ProductAPI_ImportProductsV3',
    endpoint:'/v3/product/import',sourceStatement:'В одном запросе можно передать до 100 товаров.',
    itemsConstraint:'items Array of objects <= 100 items',maxItemsPerRequest:100,
    observedAt:'2026-10-12T08:00:00.000Z',validUntil:'2026-11-12T08:00:00.000Z'};
  const evidence=assertOzonProductImportBatchLimitEvidence(checked);
  assert.equal(ozonProductImportBatchLimitCurrent(evidence,'2026-10-12T07:59:59.999Z'),false);
  assert.equal(ozonProductImportBatchLimitCurrent(evidence,'2026-10-12T08:00:00.000Z'),true);
  assert.equal(ozonProductImportBatchLimitCurrent(evidence,'2026-11-12T07:59:59.999Z'),true);
  assert.equal(ozonProductImportBatchLimitCurrent(evidence,'2026-11-12T08:00:00.000Z'),false);
  assert.equal(ozonProductImportBatchLimitCurrent(evidence,'not a time'),false);
  assert.doesNotThrow(()=>assertOzonProductImportBatchLimitCurrent(evidence,'2026-10-20T00:00:00.000Z'));
  const stop=(value,at)=>{
    try{assertOzonProductImportBatchLimitCurrent(value,at);}catch(error){return error;}
    assert.fail('the gate must stop');
  };
  const expired=stop(evidence,'2026-11-13T00:00:00.000Z');
  assert.equal(expired.code,'D_BATCH_IMPORT_LIMIT_NOT_CURRENT');
  assert.match(expired.ownerMessage,/没有保存，也没有发给 Ozon，这些规格都没有被占用/u);
  assert.match(expired.ownerMessage,/已经在 2026-11-12 到期（2026-10-12 核对的）/u);
  assert.match(expired.ownerMessage,/技术维护重新核对 Ozon 官方文档/u);
  assert.match(stop(evidence,'2026-10-01T00:00:00.000Z').ownerMessage,/要到 2026-10-12 才生效/u);
  assert.match(stop(null,'2026-10-20T00:00:00.000Z').ownerMessage,/读不出来或格式不对/u);
  assert.doesNotMatch(expired.ownerMessage,/Codex/u);
});

test('the newest dated record is the current one; a broken newest record stops instead of falling back',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'batch-limit-evidence-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const old=await loadOzonProductImportBatchLimitEvidence();
  const write=(name,value)=>writeFile(path.join(directory,name),JSON.stringify(value));
  await assert.rejects(loadOzonProductImportBatchLimitEvidence({directory}),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  await write('ozon-product-import-batch-limit-20260928.json',old);
  await write('notes.json',{unrelated:true});
  assert.deepEqual(await loadOzonProductImportBatchLimitEvidence({directory}),old);
  const fresh={...old,evidenceRef:'official:ozon-product-import-batch-limit:20261012',
    observedAt:'2026-10-12T08:00:00.000Z',validUntil:'2026-11-12T08:00:00.000Z'};
  await write('ozon-product-import-batch-limit-20261012.json',fresh);
  assert.deepEqual(await loadOzonProductImportBatchLimitEvidence({directory}),fresh);
  // An old record copied under a newer name is not a new check.
  await write('ozon-product-import-batch-limit-20261013.json',old);
  await assert.rejects(loadOzonProductImportBatchLimitEvidence({directory}),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  await write('ozon-product-import-batch-limit-20261013.json',{...fresh,maxItemsPerRequest:1000});
  await assert.rejects(loadOzonProductImportBatchLimitEvidence({directory}),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
});
