import { createSeerfarDiscoveryRuntimeFixture } from './fixtures/seerfar-discovery-runtime-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionReviewRuntimeConfiguration, normalizeADiscoveryServiceBindings, normalizeAProductDetailServiceBindings } from '../lib/runtime-configuration.mjs';
import { createLinkfoxDiscoverySecretReader, createSeerfarDiscoverySecretReader } from '../lib/linkfox-discovery-credentials.mjs';
import { createADiscoveryContractFixture } from './fixtures/a-discovery-contract-fixture.mjs';

const fixture = createADiscoveryContractFixture();
const connector = { provider: 'linkfox', bindingId: fixture.batch.bindingId, configurationVersion: fixture.batch.configurationVersion,
  gatewayOrigin: 'https://tool-gateway.linkfox.com', credentialAlias: fixture.batch.credentialAlias,
  contractVersion: fixture.batch.plan.contractVersion, allowedMethods: ['ozon_market_search', 'supplier_search'],
  timeoutMs: 1000, budgetPolicyRef: fixture.batch.budgetPolicyRef };
const service = { schemaVersion: 'a-discovery-service-binding-v1', serviceId: 'service:synthetic', configurationVersion: 'service-version:1',
  connectorBindingId: connector.bindingId, connectorConfigurationVersion: connector.configurationVersion,
  workerId: 'worker:discovery-synthetic', workerVersion: 'worker-version:1', leaseDurationMs: 10000, pumpIntervalMs: 1000 };
const credential = { credentialAlias: connector.credentialAlias, keychainService: 'synthetic-linkfox', keychainAccount: 'synthetic-account' };
const configure = env => createSelectionReviewRuntimeConfiguration({env, appDir:'/synthetic/discovery-configuration', argv:[]});
const env = {
  SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: JSON.stringify([connector]),
  SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: JSON.stringify([service]),
  SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: JSON.stringify([credential]),
  SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: JSON.stringify([fixture.batch.plan])
};

test('discovery configuration is disabled by default and performs no credential or network work', t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {throw new Error('UNEXPECTED_EXTERNAL_REQUEST');});
  const disabled = configure({});
  for (const field of ['aDiscoveryConnectorBindings','aDiscoveryServiceBindings','aDiscoveryCredentialBindings','aDiscoveryPlans','aDiscoveryEvidenceRecords',
    'aProductDetailConnectorBindings','aProductDetailServiceBindings','aProductDetailCredentialBindings']) assert.deepEqual(disabled[field], []);
  const configured = configure(env);
  assert.deepEqual(configured.aDiscoveryConnectorBindings,[connector]);
  assert.deepEqual(configured.aDiscoveryServiceBindings,[service]);
  assert.deepEqual(configured.aDiscoveryPlans,[fixture.batch.plan]);
  assert.deepEqual(configured.keywordEvidenceServiceBindings,[]);
  assert.equal(Object.hasOwn(configured,'softwareJobAuthorizationRecords'),false);
  assert.equal(fetchMock.mock.callCount(),0);
});

test('detail configuration has its own route, credential declaration and worker identity',()=>{
  const detailConnector={...connector,bindingId:'detail:binding',configurationVersion:'detail:version',
    contractVersion:'linkfox-detail-93a1dbf-v1',allowedMethods:['ozon_detail','supplier_detail']};
  const detailService={...service,schemaVersion:'a-product-detail-service-binding-v1',serviceId:'service:detail',workerId:'worker:detail',
    connectorBindingId:detailConnector.bindingId,connectorConfigurationVersion:detailConnector.configurationVersion};
  const detailEnv={SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON:JSON.stringify([detailConnector]),
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON:JSON.stringify([detailService]),
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON:JSON.stringify([credential])};
  const result=configure({...env,...detailEnv});
  assert.deepEqual(result.aProductDetailConnectorBindings,[detailConnector]);assert.deepEqual(result.aProductDetailServiceBindings,[detailService]);
  assert.throws(()=>configure({...env,...detailEnv,SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON:'[]'}),/CREDENTIAL/);
  assert.throws(()=>configure({...env,...detailEnv,SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON:JSON.stringify([{...detailService,workerId:service.workerId}])}),/WORKER/);
  assert.throws(()=>normalizeAProductDetailServiceBindings([{...detailService,leaseDurationMs:1000}],[detailConnector]));
  assert.throws(()=>normalizeAProductDetailServiceBindings([detailService],[connector]));
});

test('discovery configuration rejects ambiguous routes, unsafe duration, changed provider and duplicate plans', () => {
  for (const patch of [
    {SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:JSON.stringify([connector,connector])},
    {SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:'[]'},
    {SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:JSON.stringify([{...credential,secret:'forbidden'}])},
    {SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:JSON.stringify([{...connector,gatewayOrigin:'https://example.com'}])},
    {SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:JSON.stringify([fixture.batch.plan,fixture.batch.plan])},
    {SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON:'null'},
    {SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:'{'}
  ]) assert.throws(()=>configure({...env,...patch}));
  for(const patch of [{leaseDurationMs:1000},{leaseDurationMs:1800001},{pumpIntervalMs:999},{pumpIntervalMs:2147483648},
    {pumpIntervalMs:'1000'},{connectorConfigurationVersion:'changed:version'},{fallback:true}]) {
    assert.throws(()=>normalizeADiscoveryServiceBindings([{...service,...patch}],[connector]));
  }
});

test('LinkFox credential reader resolves only its explicitly configured route after invocation', async () => {
  const calls=[];
  const read = createLinkfoxDiscoverySecretReader({bindings:[credential],runtimeMode:'local_development',platform:'darwin',
    execFileImpl:async(...args)=>{calls.push(args);return {stdout:'synthetic-value\n'};}});
  assert.equal(calls.length,0);
  await assert.rejects(read({credentialAlias:'different:alias',provider:'linkfox'}),/CREDENTIAL_MISSING/);
  await assert.rejects(read({credentialAlias:credential.credentialAlias,provider:'seerfar_open_api'}),/REQUEST_INVALID/);
  assert.equal(calls.length,0);
  assert.equal(await read({credentialAlias:credential.credentialAlias,provider:'linkfox'}),'synthetic-value');
  assert.deepEqual(calls[0].slice(0,2),['/usr/bin/security',['find-generic-password','-w','-s',credential.keychainService,'-a',credential.keychainAccount]]);
  assert.equal(calls[0][2].timeout,5000);
});

test('LinkFox credential failures redact subprocess output and preserve unknown errors and cancellation', async () => {
  const input={credentialAlias:credential.credentialAlias,provider:'linkfox'};
  for(const [code,expected] of [[44,'CREDENTIAL_MISSING'],[1,'CREDENTIAL_READ_FAILED'],['EACCES','CREDENTIAL_READ_FAILED'],['ENOENT','CREDENTIAL_UNAVAILABLE']]) {
    const read=createLinkfoxDiscoverySecretReader({bindings:[credential],runtimeMode:'local_development',platform:'darwin',
      execFileImpl:async()=>{throw Object.assign(new Error('synthetic-sensitive-stderr'),{code,stdout:'synthetic-sensitive-stdout'});}});
    await assert.rejects(read(input),error=>{assert.match(error.message,new RegExp(expected));assert.doesNotMatch(JSON.stringify(error),/synthetic-sensitive/);return true;});
  }
  const unknown=new TypeError('synthetic programming failure');
  const read=createLinkfoxDiscoverySecretReader({bindings:[credential],runtimeMode:'local_development',platform:'darwin',execFileImpl:async()=>{throw unknown;}});
  await assert.rejects(read(input),error=>error===unknown);
  const controller=new AbortController(),reason=new Error('synthetic cancellation');controller.abort(reason);
  await assert.rejects(read({...input,signal:controller.signal}),error=>error===reason);
  for(const patch of [{runtimeMode:'central_production',platform:'darwin'},{runtimeMode:'local_development',platform:'aix'}]) {
    const unavailable=createLinkfoxDiscoverySecretReader({bindings:[credential],...patch,execFileImpl:async()=>{throw new Error('must not run');}});
    await assert.rejects(unavailable(input),/CREDENTIAL_UNAVAILABLE/);
  }
});


test('Seerfar credential reader keeps provider identity and redacts known local failures', async () => {
  const calls=[];
  const read=createSeerfarDiscoverySecretReader({bindings:[credential],runtimeMode:'local_development',platform:'darwin',
    execFileImpl:async(...args)=>{calls.push(args);return {stdout:'synthetic-seerfar-value'};}});
  await assert.rejects(read({credentialAlias:credential.credentialAlias,provider:'linkfox'}),/REQUEST_INVALID/);
  assert.equal(calls.length,0);
  assert.equal(await read({credentialAlias:credential.credentialAlias,provider:'seerfar'}),'synthetic-seerfar-value');
  assert.equal(calls.length,1);
  const denied=createSeerfarDiscoverySecretReader({bindings:[credential],runtimeMode:'local_development',platform:'darwin',
    execFileImpl:async()=>{throw Object.assign(new Error('sensitive-subprocess-text'),{code:44});}});
  await assert.rejects(denied({credentialAlias:credential.credentialAlias,provider:'seerfar'}),error=>{
    assert.equal(error.code,'CREDENTIAL_MISSING');assert.doesNotMatch(error.message,/sensitive/);return true;
  });
});


test('explicit Seerfar configuration retains its contract and rejects mismatched source plans', async t => {
  const f=await createSeerfarDiscoveryRuntimeFixture(t);
  const values={
    SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:JSON.stringify([f.connectorBinding]),
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON:JSON.stringify([f.serviceBinding]),
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:JSON.stringify([{...credential,credentialAlias:f.connectorBinding.credentialAlias}]),
    SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:JSON.stringify([f.plan])
  };
  const configured=configure(values);
  assert.deepEqual(configured.aDiscoveryPlans,[f.plan]);
  assert.equal(configured.aDiscoveryConnectorBindings[0].provider,'seerfar');
  const {service}=f.create({plans:[fixture.batch.plan]});
  const view=service.view({document:await f.repository.readSnapshot(),actor:f.owner});
  assert.equal(view.canPrepare,false);
  assert.ok(view.configurationBlockers.includes('PLAN_NOT_SUPPORTED'));
  assert.equal(f.calls.length,0);
});


test('Seerfar current evidence declarations are explicit, bounded and never create authorization', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const result = configure({SELECTION_REVIEW_A_DISCOVERY_EVIDENCE_RECORDS_JSON:JSON.stringify([f.evidence])});
  assert.deepEqual(result.aDiscoveryEvidenceRecords,[f.evidence]);
  assert.deepEqual(result.aDiscoveryServiceBindings,[]);assert.deepEqual(result.aDiscoveryPlans,[]);
  for(const records of [null,[f.evidence,f.evidence],[{...f.evidence,status:'active',verifiedAt:null}]]) {
    assert.throws(()=>configure({SELECTION_REVIEW_A_DISCOVERY_EVIDENCE_RECORDS_JSON:JSON.stringify(records)}),/EVIDENCE_/);
  }
  assert.deepEqual(f.counts(),{secretReads:0,requests:0});
});
