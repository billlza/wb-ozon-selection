import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertADiscoveryPlan, assertADiscoveryBatch, assertADiscoveryScope, assertADiscoveryBatchSource,
  assertADiscoveryAuthorization, assertADiscoveryCredential, assertADiscoveryReceipt, readADiscoveryMarketResult,
  readADiscoveryTerminal, interruptADiscoveryReceipt, getADiscoveryCapability, getADiscoveryProviderCapability,
  getADiscoveryHttpRequestLimit, nextADiscoveryRequest } from '../lib/a-discovery-contract.mjs';
import { assertSeerfarDiscoveryBinding, SEERFAR_DISCOVERY_CAPABILITY, SeerfarDiscoveryContractError,
  SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES, assertSeerfarDiscoveryRequest, describeSeerfarFilters,
  assertSeerfarDiscoveryEvidence, normalizeSeerfarDiscoveryEvidenceRecords, resolveSeerfarDiscoveryEvidence } from '../lib/seerfar-discovery-contract.mjs';
import { createADiscoveryContractFixture, discoveryAt } from './fixtures/a-discovery-contract-fixture.mjs';

// All category IDs, points and sources below are synthetic contract inputs only.
function fixture() {
  const f=createADiscoveryContractFixture(),request={requestId:'request:synthetic-category',method:'category_detail',platform:'ozon',
    categoryId:'100_200',fulfillment:'rfbs',pageNumber:1,pageSize:20,categoryEvidenceRef:'evidence:synthetic-category',contractEvidenceRef:'evidence:synthetic-contract'};
  const budget={unit:'seerfar_points',maxRequests:3,maxCredits:15,policyRef:'budget:synthetic',policyVersion:'version:synthetic',
    costEvidenceRef:'evidence:synthetic-cost',estimatedPointsByStep:{quota_before:0,category_detail:15,quota_after:0}};
  f.batch.schemaVersion='a-discovery-batch-v2';f.batch.credentialAlias='seerfar-synthetic';
  f.batch.plan={...f.batch.plan,schemaVersion:'a-discovery-plan-v2',provider:'seerfar',contractVersion:'seerfar-category-discovery-v1',
    requests:[request],budget,selection:{schemaVersion:'a-discovery-selection-v2',marketOrder:'provider_order',supplierOrder:'not_requested',maxCandidates:1}};
  f.scope={...f.scope,schemaVersion:'a-discovery-scope-v2',provider:'seerfar',contractVersion:f.batch.plan.contractVersion,request,budget,
    credentialAlias:f.batch.credentialAlias};
  f.authorization={...f.authorization,authorizationType:'a_seerfar_discovery_once',scopeBinding:f.scope};
  f.credential={...f.credential,provider:'seerfar',scopeBinding:f.scope,credentialAlias:f.scope.credentialAlias};f.job.scopeBinding=f.scope;
  f.binding={schemaVersion:'seerfar-discovery-binding-v1',provider:'seerfar',bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion,
    credentialAlias:f.batch.credentialAlias,contractVersion:f.batch.plan.contractVersion,allowedMethods:['category_detail'],timeoutMs:1000,budgetPolicyRef:budget.policyRef};
  const evidenceRef='seerfar:synthetic-category';
  const market={schemaVersion:'seerfar-discovery-market-result-v1',provider:'seerfar',contractVersion:f.scope.contractVersion,
    requestId:request.requestId,platform:'ozon',categoryId:request.categoryId,fulfillment:request.fulfillment,observedAt:discoveryAt,evidenceRef,
    status:'candidates_found',products:[{productId:'123',platform:'ozon',productUrl:'https://www.ozon.ru/product/123',title:'Synthetic item',
      imageUrl:'https://images.example.test/synthetic.png',price:100,currency:null,salesCount:null,revenue:null,categoryPath:null,
      sellerIdentity:'unknown',providerRecordRef:`${evidenceRef}#product-0`}],collection:{pageNumber:1,pageSize:20,hasNextPage:false}};
  f.receipt={schemaVersion:'a-discovery-receipt-v2',receiptId:`a-discovery-receipt:${f.job.jobId}`,jobId:f.job.jobId,scope:f.scope,
    workerId:f.job.workerId,leaseId:f.job.leaseId,startedAt:discoveryAt,completedAt:discoveryAt,status:'completed',failureClass:null,
    steps:['quota_before','category_detail','quota_after'].map((method,index)=>({method,intentAt:discoveryAt,sentAt:discoveryAt,
      completedAt:discoveryAt,externalRequestState:'succeeded',requestTransmission:'response_received',errorCode:null,
      result:index===1?market:{schemaVersion:'seerfar-discovery-quota-result-v1',provider:'seerfar',requestId:`request:synthetic-${method}`,
        observedAt:discoveryAt,remainingPoints:index===0?100:85,evidenceRef:`seerfar:synthetic-${method}`}}))};
  return structuredClone(f);
}

function evidenceFixture() {
  const { request, budget } = fixture().scope;
  const record = { schemaVersion: 'seerfar-discovery-evidence-v1', evidenceId: 'evidence:synthetic-declaration', version: 'v1',
    status: 'active', verifiedAt: discoveryAt, effectiveFrom: null, expiresAt: null, supersededBy: null,
    category: { evidenceRef: request.categoryEvidenceRef, sourceRef: 'source:synthetic-category-only', platform: request.platform,
      categoryId: request.categoryId, fulfillment: request.fulfillment },
    protocol: { evidenceRef: request.contractEvidenceRef, sourceRef: 'source:synthetic-protocol-only',
      contractVersion: 'seerfar-category-discovery-v1', method: request.method, pageNumber: 1, pageSize: 20 },
    billing: { evidenceRef: budget.costEvidenceRef, sourceRef: 'source:synthetic-billing-only', policyRef: budget.policyRef,
      policyVersion: budget.policyVersion, unit: budget.unit, estimatedPointsByStep: structuredClone(budget.estimatedPointsByStep) } };
  return { records: [record], request, budget, now: discoveryAt };
}

test('synthetic current evidence resolves exact sources without inventing an expiry or changing inputs', () => {
  const f = evidenceFixture(), original = structuredClone(f);
  const result = resolveSeerfarDiscoveryEvidence(f);
  assert.equal(result.expiresAt, null); assert.equal(result.effectiveFrom, null);
  assert.deepEqual(f, original);
  result.category.sourceRef = 'source:changed-copy';
  assert.deepEqual(f, original);
  f.budget.maxCredits += 10;
  assert.equal(resolveSeerfarDiscoveryEvidence(f).billing.estimatedPointsByStep.category_detail, 15);
});

test('current evidence separates unavailable, unverified, revoked, superseded and time boundaries', () => {
  const cases = [
    [f => { f.records = []; }, 'EVIDENCE_UNAVAILABLE'],
    [f => { f.records[0].status = 'unverified'; f.records[0].verifiedAt = null; }, 'EVIDENCE_UNVERIFIED'],
    [f => { f.records[0].status = 'revoked'; }, 'EVIDENCE_REVOKED'],
    [f => { f.records[0].status = 'superseded'; f.records[0].supersededBy = 'evidence:synthetic-next'; }, 'EVIDENCE_SUPERSEDED'],
    [f => { f.records[0].effectiveFrom = new Date(Date.parse(f.now) + 1).toISOString(); }, 'EVIDENCE_NOT_EFFECTIVE'],
    [f => { f.records[0].verifiedAt = new Date(Date.parse(f.now) + 1).toISOString(); }, 'EVIDENCE_NOT_EFFECTIVE'],
    [f => { f.records[0].expiresAt = f.now; }, 'EVIDENCE_EXPIRED']
  ];
  for (const [mutate, code] of cases) {
    const f = evidenceFixture(); mutate(f);
    assert.throws(() => resolveSeerfarDiscoveryEvidence(f), error => error instanceof SeerfarDiscoveryContractError && error.code === code);
  }
});

test('evidence rejects mismatched category, protocol, fee policy and same-reference version ambiguity', () => {
  for (const mutate of [r => { r.category.categoryId = '100_201'; }, r => { r.category.fulfillment = 'fbs'; },
    r => { r.billing.policyVersion = 'v2'; }, r => { r.billing.estimatedPointsByStep.category_detail = 14; }]) {
    const f = evidenceFixture(); mutate(f.records[0]);
    assert.throws(() => resolveSeerfarDiscoveryEvidence(f), error => error.code === 'EVIDENCE_INVALID');
  }
  const f = evidenceFixture(); f.records[0].protocol.evidenceRef = 'evidence:other';
  assert.throws(() => resolveSeerfarDiscoveryEvidence(f), error => error.code === 'EVIDENCE_UNAVAILABLE');
  for (const mutate of [r => {}, r => { r.version = 'v2'; }, r => { r.evidenceId = 'evidence:other'; }]) {
    const records = evidenceFixture().records, second = structuredClone(records[0]); mutate(second); records.push(second);
    assert.throws(() => normalizeSeerfarDiscoveryEvidenceRecords(records), error => error.code === 'EVIDENCE_AMBIGUOUS');
  }
});

test('evidence is closed, bounded and cannot infer missing source, dates or fee values', () => {
  for (const mutate of [r => { r.unexpected = true; }, r => { delete r.category.sourceRef; },
    r => { r.protocol.method = 'product_detail'; }, r => { r.category.platform = 'wb'; },
    r => { r.billing.estimatedPointsByStep.quota_before = null; }, r => { r.verifiedAt = null; },
    r => { r.expiresAt = '2026-02-30T00:00:00Z'; }, r => { r.category.rawSellerType = 1; },
    r => { r.protocol.dateRange = 'past_30_days'; }, r => { r.supersededBy = 'evidence:other'; }]) {
    const r = evidenceFixture().records[0]; mutate(r);
    assert.throws(() => assertSeerfarDiscoveryEvidence(r), error => error.code === 'EVIDENCE_INVALID');
  }
  assert.throws(() => normalizeSeerfarDiscoveryEvidenceRecords(Array(21).fill(evidenceFixture().records[0])), error => error.code === 'EVIDENCE_INVALID');
  assert.deepEqual(normalizeSeerfarDiscoveryEvidenceRecords([]), []);
});

test('evidence invalidation preserves three successful step results while preventing import', async () => {
  const { loadPublishedSchemaValidator } = await import('./helpers/published-schema-validator.mjs');
  const validate = (await loadPublishedSchemaValidator()).getSchema('a-discovery-v2.schema.json#/$defs/receipt');
  for (const failureClass of SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES) {
    const f = fixture(), r = f.receipt, steps = structuredClone(r.steps);
    r.status = 'in_flight'; r.completedAt = null;
    const stopped = interruptADiscoveryReceipt(r, f.job, discoveryAt, failureClass);
    assert.equal(stopped.status, 'failed'); assert.equal(stopped.failureClass, failureClass);
    assert.deepEqual(stopped.steps, steps);
    assert.equal(readADiscoveryTerminal(stopped, f.job).externalRequestState, 'failed');
    assert.throws(() => readADiscoveryMarketResult(stopped));
    assert.equal(validate(stopped), true, JSON.stringify(validate.errors));
  }
});

test('Seerfar v2 locks one category, all three HTTP steps and a separate capability and permission',()=>{
  const f=fixture();assert.deepEqual(assertADiscoveryBatch(f.batch),f.batch);assertADiscoveryScope(f.scope,f.job);
  assertADiscoveryAuthorization(f.authorization);assertADiscoveryCredential(f.credential);assertSeerfarDiscoveryBinding(f.binding);
  assert.equal(getADiscoveryCapability(f.scope),SEERFAR_DISCOVERY_CAPABILITY);assert.equal(getADiscoveryCapability(f.batch.plan),SEERFAR_DISCOVERY_CAPABILITY);
  assert.equal(getADiscoveryProviderCapability(f.binding.provider,f.binding.contractVersion),SEERFAR_DISCOVERY_CAPABILITY);
  assert.equal(getADiscoveryHttpRequestLimit(f.scope),3);
  assert.equal(readADiscoveryMarketResult(f.receipt).products[0].currency,null);
  assert.equal(nextADiscoveryRequest({batch:f.batch,receipts:[f.receipt]}),null);
  f.authorization.authorizationType='a_discovery_once';assert.throws(()=>assertADiscoveryAuthorization(f.authorization),/AUTHORIZATION_INVALID/);
  f.credential.provider='linkfox';assert.throws(()=>assertADiscoveryCredential(f.credential),/CREDENTIAL_BINDING_INVALID/);
});

test('budget evidence, exact request, store revision and source cannot be relabeled or defaulted',()=>{
  for(const mutate of [f=>delete f.batch.plan.budget.costEvidenceRef,f=>f.batch.plan.budget.maxRequests=1,
    f=>f.batch.plan.budget.maxCredits=14,f=>f.batch.plan.requests[0].platform='wb',f=>f.batch.plan.requests[0].pageNumber=2,
    f=>f.batch.plan.requests.push(structuredClone(f.batch.plan.requests[0])),f=>f.batch.plan.selection.supplierOrder='provider_order']) {
    const f=fixture();mutate(f);assert.throws(()=>assertADiscoveryPlan(f.batch.plan));
  }
  for(const mutate of [f=>f.scope.budget.maxCredits=20,f=>f.scope.request.categoryId='100_201',f=>f.scope.sourceRevision=1,
    f=>f.scope.targetStore='dandanshu']) {const f=fixture();f.scope=structuredClone(f.scope);mutate(f);assert.throws(()=>assertADiscoveryBatchSource(f.batch,f.scope));}
  const f=fixture();f.receipt.schemaVersion='a-discovery-receipt-v1';assert.throws(()=>assertADiscoveryReceipt(f.receipt));
  assert.throws(()=>getADiscoveryProviderCapability('seerfar','unknown-version'),/BINDING_INVALID/);
});

test('receipts reject skipped requests, forged source, inferred facts and false zero',()=>{
  for(const mutate of [r=>r.steps.splice(0,1),r=>r.steps.pop(),r=>r.steps[1].result.categoryId='100_201',
    r=>r.steps[1].result.requestId='request:other',r=>r.steps[1].result.products[0].currency='RUB',
    r=>r.steps[1].result.products[0].productUrl='https://www.ozon.ru/product/124',
    r=>r.steps[1].result.products[0].sellerIdentity='confirmed',r=>r.steps[0].result.remainingPoints=null,
    r=>r.steps[1].result.products[0].providerRecordRef='evidence:other',
    r=>{r.steps[1].result.products=[];r.steps[1].result.status='true_empty';r.steps[1].result.collection.hasNextPage=true;}]) {
    const f=fixture();mutate(f.receipt);assert.throws(()=>assertADiscoveryReceipt(f.receipt,f.job));
  }
  const f=fixture();f.receipt.steps[1].result.products=[];f.receipt.steps[1].result.status='true_empty';assertADiscoveryReceipt(f.receipt,f.job);
  assert.equal(readADiscoveryMarketResult(f.receipt).status,'true_empty');
});

test('partial success survives interruption and unknown cannot be imported or replayed',()=>{
  for(const length of [0,1,2,3]) {
    const f=fixture(),r=f.receipt;r.status='in_flight';r.completedAt=null;r.steps=r.steps.slice(0,length);
    const stopped=interruptADiscoveryReceipt(r,f.job,discoveryAt,'CANCELLED');assert.equal(stopped.status,'failed');
    assert.equal(stopped.steps.filter(step=>step.externalRequestState==='succeeded').length,length);
    assert.equal(readADiscoveryTerminal(stopped,f.job).externalRequestState,length?'failed':'not_sent');
    assert.throws(()=>readADiscoveryMarketResult(stopped));
  }
  const f=fixture(),r=f.receipt;r.status='in_flight';r.completedAt=null;
  const last=r.steps[2],late=structuredClone(last.result);last.result=null;last.completedAt=null;last.externalRequestState='in_flight';last.requestTransmission='attempted';
  const stopped=interruptADiscoveryReceipt(r,f.job,discoveryAt,'TIMEOUT');assert.equal(stopped.status,'unknown_outcome');
  assert.equal(stopped.steps[1].result.products.length,1);assert.equal(nextADiscoveryRequest({batch:f.batch,receipts:[stopped]}),null);
  stopped.lateResult={recordedAt:discoveryAt,stepIndex:2,result:late};assertADiscoveryReceipt(stopped,f.job);
  stopped.lateResult.stepIndex=1;assert.throws(()=>assertADiscoveryReceipt(stopped,f.job),/LATE_RESULT_INVALID/);
});

test('observed over-budget points keep successful responses but cannot form a completed job',()=>{
  const f=fixture();f.receipt.steps[2].result.remainingPoints=84;assert.throws(()=>assertADiscoveryReceipt(f.receipt,f.job),/BUDGET_EXCEEDED/);
  f.receipt.status='failed';f.receipt.failureClass='BUDGET_EXCEEDED';assertADiscoveryReceipt(f.receipt,f.job);
  assert.equal(readADiscoveryTerminal(f.receipt,f.job).externalRequestState,'failed');
});

test('v2 published schema accepts every closed DTO and rejects extra fields',async()=>{
  const {default:Ajv2020}=await import('ajv/dist/2020.js'),{default:addFormats}=await import('ajv-formats');
  const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);
  ajv.addSchema(JSON.parse(await readFile(new URL('../schema/a-discovery-v2.schema.json',import.meta.url),'utf8')));
  const f=fixture();
  for(const [name,value] of Object.entries({plan:f.batch.plan,batch:f.batch,scope:f.scope,authorization:f.authorization,
    credential:f.credential,binding:f.binding,receipt:f.receipt,result:f.receipt.steps[1].result,quotaResult:f.receipt.steps[0].result})) {
    const validate=ajv.getSchema(`a-discovery-v2.schema.json#/$defs/${name}`);
    assert.equal(validate(value),true,`${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({...value,unexpected:true}),false,name);
  }
  const pending=structuredClone(f.receipt),late=structuredClone(pending.steps[2].result);
  pending.status='in_flight';pending.completedAt=null;Object.assign(pending.steps[2],{result:null,completedAt:null,externalRequestState:'in_flight',requestTransmission:'attempted'});
  const stopped=interruptADiscoveryReceipt(pending,f.job,discoveryAt,'TIMEOUT');
  stopped.lateResult={recordedAt:discoveryAt,stepIndex:2,result:late};
  const validate=ajv.getSchema('a-discovery-v2.schema.json#/$defs/receipt');
  assert.equal(validate(stopped),true,JSON.stringify(validate.errors));
});

 test('market result v2 is closed while legacy v1 reads preserve missing facts without rewriting', async () => {
  const old = fixture(), original = JSON.stringify(old.receipt);
  const legacy = readADiscoveryMarketResult(old.receipt);
  assert.equal(legacy.schemaVersion, 'seerfar-discovery-market-result-v1');
  assert.equal(legacy.dateRange, undefined); assert.equal(legacy.products[0].reviewCount, undefined);
  assert.equal(JSON.stringify(old.receipt), original);
  const f = fixture(), result = f.receipt.steps[1].result;
  result.schemaVersion = 'seerfar-discovery-market-result-v2';
  result.dateRange = { startDate: '2026-07-01', endDate: '2026-07-27' };
  Object.assign(result.products[0], { reviewCount: 0, reviewRating: 7.25, rawSellerType: 1 });
  assertADiscoveryReceipt(f.receipt, f.job);
  const { loadPublishedSchemaValidator } = await import('./helpers/published-schema-validator.mjs');
  const validate = (await loadPublishedSchemaValidator()).getSchema('a-discovery-v2.schema.json#/$defs/result');
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
  for (const mutate of [r => r.products[0].reviewCount = -1, r => r.products[0].rawSellerType = '1', r => r.products[0].reviewRating = -1,
    r => r.products[0].sellerIdentity = 'cross_border_cn', r => r.products[0].productId = '999',
    r => r.dateRange.startDate = '2026-02-30', r => r.dateRange.endDate = '2026-06-30',
    r => r.products[0].unexpected = true, r => delete r.products[0].reviewCount]) {
    const copy = structuredClone(f.receipt); mutate(copy.steps[1].result);
    assert.throws(() => assertADiscoveryReceipt(copy, f.job));
  }
  const enrichedLegacy = structuredClone(legacy); enrichedLegacy.products[0].reviewCount = 0;
  assert.equal(validate(enrichedLegacy), false);
});

test('market result v3 carries the provider package facts and stays closed; v2 stays readable without them', async () => {
  const f = fixture(), result = f.receipt.steps[1].result;
  result.schemaVersion = 'seerfar-discovery-market-result-v3';
  result.dateRange = { startDate: '2026-08-10', endDate: '2026-09-09' };
  Object.assign(result.products[0], { reviewCount: 41, reviewRating: 4.8, rawSellerType: 1, weightGrams: 850, volumeLitres: 12.4, dimensionMm: '600x450x150' });
  assertADiscoveryReceipt(f.receipt, f.job);
  const read = readADiscoveryMarketResult(f.receipt);
  assert.equal(read.products[0].weightGrams, 850); assert.equal(read.products[0].dimensionMm, '600x450x150');
  const nulls = structuredClone(f.receipt); Object.assign(nulls.steps[1].result.products[0], { weightGrams: null, volumeLitres: null, dimensionMm: null });
  assertADiscoveryReceipt(nulls, f.job);
  for (const mutate of [r => r.products[0].dimensionMm = '60x45', r => r.products[0].dimensionMm = '600x450x150mm', r => r.products[0].weightGrams = -1,
    r => r.products[0].volumeLitres = '12', r => delete r.products[0].weightGrams, r => r.products[0].extra = 1]) {
    const copy = structuredClone(f.receipt); mutate(copy.steps[1].result);
    assert.throws(() => assertADiscoveryReceipt(copy, f.job));
  }
  const v2 = structuredClone(f.receipt); v2.steps[1].result.schemaVersion = 'seerfar-discovery-market-result-v2';
  for (const key of ['weightGrams', 'volumeLitres', 'dimensionMm']) delete v2.steps[1].result.products[0][key];
  assertADiscoveryReceipt(v2, f.job);
  const v2WithDims = structuredClone(f.receipt); v2WithDims.steps[1].result.schemaVersion = 'seerfar-discovery-market-result-v2';
  assert.throws(() => assertADiscoveryReceipt(v2WithDims, f.job));
});

// Owner-declared conditions in the provider's own units: RUB, grams, litres and units sold.
const SYNTHETIC_FILTERS = { priceRub: { min: 800, max: null }, weightGrams: { min: null, max: 1000 } };
function filteredFixture(filters, echo) {
  const f = fixture();
  for (const request of [f.batch.plan.requests[0], f.scope.request, f.receipt.scope.request]) {
    if (filters === null) delete request.filters; else request.filters = structuredClone(filters);
  }
  const result = f.receipt.steps[1].result;
  result.schemaVersion = 'seerfar-discovery-market-result-v3';
  result.dateRange = { startDate: '2026-08-10', endDate: '2026-09-09' };
  Object.assign(result.products[0], { reviewCount: 41, reviewRating: 4.8, rawSellerType: 1,
    weightGrams: 850, volumeLitres: 12.4, dimensionMm: '600x450x150' });
  if (echo !== undefined) result.appliedFilters = structuredClone(echo);
  return f;
}

test('optional owner filters ride the plan, scope and receipt and are rejected when malformed', () => {
  const plain = fixture();
  assert.equal(Object.hasOwn(plain.scope.request, 'filters'), false);
  assert.equal(Object.hasOwn(assertSeerfarDiscoveryRequest(plain.scope.request), 'filters'), false);
  assertADiscoveryScope(plain.scope, plain.job);

  const f = filteredFixture(SYNTHETIC_FILTERS, SYNTHETIC_FILTERS);
  assert.deepEqual(assertADiscoveryPlan(f.batch.plan).requests[0].filters, SYNTHETIC_FILTERS);
  assert.deepEqual(assertADiscoveryScope(f.scope, f.job).request.filters, SYNTHETIC_FILTERS);
  assertADiscoveryBatch(f.batch); assertADiscoveryBatchSource(f.batch, f.scope);
  assertADiscoveryAuthorization(f.authorization); assertADiscoveryCredential(f.credential);
  assertADiscoveryReceipt(f.receipt, f.job);
  assert.deepEqual(readADiscoveryMarketResult(f.receipt).appliedFilters, SYNTHETIC_FILTERS);

  for (const invalid of [{}, null, [{ priceRub: { min: 1, max: null } }], { priceRub: { min: -1, max: null } },
    { priceRub: { min: 900, max: 800 } }, { priceRub: { min: null, max: null } }, { priceRub: { min: 800 } },
    { priceRub: { min: 800, max: null, extra: 1 } }, { priceRub: { min: '800', max: null } },
    { priceRub: { min: Infinity, max: null } }, { priceRub: null }, { unknownFilter: { min: 1, max: null } },
    { monthlySales: { min: 1, max: null } }]) {
    const bad = fixture(); bad.scope.request.filters = invalid;
    assert.throws(() => assertSeerfarDiscoveryRequest(bad.scope.request),
      error => error instanceof SeerfarDiscoveryContractError && error.code === 'INPUT_INVALID', JSON.stringify(invalid));
    assert.throws(() => assertADiscoveryScope(bad.scope, bad.job), /INPUT_INVALID/, JSON.stringify(invalid));
    assert.throws(() => assertADiscoveryPlan(bad.batch.plan), /INPUT_INVALID/, JSON.stringify(invalid));
  }
});

test('a v3 result states its own conditions and cannot echo conditions the request never declared', () => {
  const unfiltered = filteredFixture(null, null);
  assertADiscoveryReceipt(unfiltered.receipt, unfiltered.job);
  assert.equal(readADiscoveryMarketResult(unfiltered.receipt).appliedFilters, null);

  // A v3 result saved before this echo existed stays readable; silence is never read as "no conditions".
  const silent = filteredFixture(SYNTHETIC_FILTERS);
  assertADiscoveryReceipt(silent.receipt, silent.job);
  assert.equal(readADiscoveryMarketResult(silent.receipt).appliedFilters, undefined);

  for (const [filters, echo] of [[SYNTHETIC_FILTERS, null], [null, SYNTHETIC_FILTERS], [SYNTHETIC_FILTERS, {}], [null, {}],
    [SYNTHETIC_FILTERS, { priceRub: { min: 800, max: null } }],
    [SYNTHETIC_FILTERS, { priceRub: { min: 900, max: null }, weightGrams: { min: null, max: 1000 } }],
    [SYNTHETIC_FILTERS, { ...SYNTHETIC_FILTERS, salesCount: { min: 1, max: null } }],
    [SYNTHETIC_FILTERS, { priceRub: { min: 800, max: null }, weightGrams: { min: null, max: 1000, extra: 1 } }]]) {
    const bad = filteredFixture(filters, echo);
    assert.throws(() => assertADiscoveryReceipt(bad.receipt, bad.job), /RESPONSE_INVALID/, JSON.stringify([filters, echo]));
  }

  const v2 = filteredFixture(null, null), result = v2.receipt.steps[1].result;
  result.schemaVersion = 'seerfar-discovery-market-result-v2';
  for (const key of ['weightGrams', 'volumeLitres', 'dimensionMm']) delete result.products[0][key];
  assert.throws(() => assertADiscoveryReceipt(v2.receipt, v2.job), /RESPONSE_INVALID/);
  delete result.appliedFilters;
  assertADiscoveryReceipt(v2.receipt, v2.job);
});

test('the desk label states every declared bound with its provider unit and never invents one', () => {
  assert.equal(describeSeerfarFilters(null), '无筛选条件');
  assert.equal(describeSeerfarFilters(undefined), '无筛选条件');
  assert.equal(describeSeerfarFilters(SYNTHETIC_FILTERS), '售价 ≥800 卢布 · 重量 ≤1000 克');
  assert.equal(describeSeerfarFilters({ salesCount: { min: 30, max: 300 }, volumeLitres: { min: null, max: 12.5 } }),
    '体积 ≤12.5 升 · 销量 30-300 件');
  assert.equal(describeSeerfarFilters({ priceRub: { min: 0, max: 0 } }), '售价 0-0 卢布');
  assert.throws(() => describeSeerfarFilters({}), /INPUT_INVALID/);
  assert.throws(() => describeSeerfarFilters({ priceRub: { min: 900, max: 800 } }), /INPUT_INVALID/);
});

test('published v2 schema keeps filters optional, closed and bounded on the request and the v3 result', async () => {
  const { loadPublishedSchemaValidator } = await import('./helpers/published-schema-validator.mjs');
  const validator = await loadPublishedSchemaValidator(), f = filteredFixture(SYNTHETIC_FILTERS, SYNTHETIC_FILTERS);
  for (const [name, value] of [['plan', f.batch.plan], ['batch', f.batch], ['scope', f.scope], ['receipt', f.receipt],
    ['result', f.receipt.steps[1].result], ['authorization', f.authorization], ['credential', f.credential]]) {
    const validate = validator.getSchema(`a-discovery-v2.schema.json#/$defs/${name}`);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  const validateScope = validator.getSchema('a-discovery-v2.schema.json#/$defs/scope');
  assert.equal(validateScope(fixture().scope), true);
  for (const invalid of [{}, { priceRub: { min: null, max: null } }, { priceRub: { min: -1, max: null } },
    { priceRub: { min: 800 } }, { priceRub: { min: 800, max: null, extra: 1 } }, { unknownFilter: { min: 1, max: null } }, null]) {
    const copy = structuredClone(f.scope); copy.request.filters = invalid;
    assert.equal(validateScope(copy), false, JSON.stringify(invalid));
  }
  const validateResult = validator.getSchema('a-discovery-v2.schema.json#/$defs/result');
  const silent = filteredFixture(SYNTHETIC_FILTERS).receipt.steps[1].result;
  assert.equal(validateResult(silent), true, JSON.stringify(validateResult.errors));
  assert.equal(validateResult({ ...silent, appliedFilters: null }), true);
  assert.equal(validateResult({ ...silent, appliedFilters: {} }), false);
  const v2Echo = filteredFixture(null, null).receipt.steps[1].result;
  v2Echo.schemaVersion = 'seerfar-discovery-market-result-v2';
  for (const key of ['weightGrams', 'volumeLitres', 'dimensionMm']) delete v2Echo.products[0][key];
  assert.equal(validateResult(v2Echo), false);
});

test('v3 dimension text accepts the provider multiplication sign and keeps it literal (2026-07-27 real capture; 2026-09-11 RESPONSE_INVALID root cause)', async () => {
  const f = fixture(), result = f.receipt.steps[1].result;
  result.schemaVersion = 'seerfar-discovery-market-result-v3';
  result.dateRange = { startDate: '2026-08-10', endDate: '2026-09-09' };
  Object.assign(result.products[0], { reviewCount: 41, reviewRating: 4.8, rawSellerType: 1, weightGrams: 23400, volumeLitres: 162.685, dimensionMm: '487×223×1498' });
  assertADiscoveryReceipt(f.receipt, f.job);
  assert.equal(readADiscoveryMarketResult(f.receipt).products[0].dimensionMm, '487×223×1498');
  for (const bad of ['487×223', '487*223*1498', '487××223×1498']) {
    const copy = structuredClone(f.receipt); copy.steps[1].result.products[0].dimensionMm = bad;
    assert.throws(() => assertADiscoveryReceipt(copy, f.job));
  }
});
