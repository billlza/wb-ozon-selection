import test from 'node:test';
import assert from 'node:assert/strict';
import {createDPlatformObservationRuntimeFixture} from './fixtures/d-platform-observation-runtime-fixture.mjs';
import {loadPublishedSchemaValidator} from './helpers/published-schema-validator.mjs';
import {normalizeDPlatformObservationConfiguration} from '../lib/runtime-configuration.mjs';
import {assertDPlatformObservationScope} from '../lib/d-platform-observation-contract.mjs';
import {normalizeDESoftwareJobScope} from '../lib/d-e-software-job-scope.mjs';
import {fingerprintCanonicalRecord,isCanonicalFrozenRef,isOpaqueProductionSourceRef} from '../lib/production-contract-primitives.mjs';

const longAuthorization=`production-auth:${'synthetic-current-source:'.repeat(18)}owner-decision:1`;
function resign(scope){const {inputFingerprint,...core}=scope;return {...core,inputFingerprint:fingerprintCanonicalRecord(core)};}
test('observation configuration, scope and published schema share the existing bounded opaque PA ID contract',async()=>{
 const f=await createDPlatformObservationRuntimeFixture(),job=await f.job(),base=job.scopeBinding;
 const schema=(await loadPublishedSchemaValidator()).getSchema('d-platform-observation-v1.schema.json');
 const entry={candidateId:base.candidateId,skuPackageId:base.skuPackageId,authorizationRef:longAuthorization,
  revision:f.d.job.revision,productionBindingId:base.productionBinding.bindingId,
  productionConfigurationVersion:base.productionBinding.configurationVersion,policy:base.policy};
 const configure=authorizationRef=>normalizeDPlatformObservationConfiguration({policies:[{...entry,authorizationRef}],pumpIntervalMs:1000},[f.d.currentProductionBinding]);
 assert.ok(longAuthorization.length>256);assert.equal(isCanonicalFrozenRef(longAuthorization),false);
 for(const authorizationRef of [longAuthorization,'x'.repeat(1024)]){
  assert.equal(isOpaqueProductionSourceRef(authorizationRef),true);
  assert.equal(configure(authorizationRef).policies[0].authorizationRef,authorizationRef);
  const scope=resign({...base,authorizationRef});assert.equal(assertDPlatformObservationScope(scope),scope);
  assert.equal(schema(scope),true,JSON.stringify(schema.errors));
  const dScope={...f.d.job.scopeBinding,authorizationRef};
  assert.equal(normalizeDESoftwareJobScope(dScope,f.d.job).authorizationRef,authorizationRef);
 }
 for(const authorizationRef of ['',null,'Unknown','null','undefined','not_applicable','missing',' value','value ','x\ny','x\u007fy','x'.repeat(1025)]){
  assert.equal(isOpaqueProductionSourceRef(authorizationRef),false);
  assert.throws(()=>configure(authorizationRef),/CONFIGURATION_INVALID/);
  const scope=resign({...base,authorizationRef});assert.throws(()=>assertDPlatformObservationScope(scope),/SCOPE_INVALID/);
  assert.equal(schema(scope),false,`schema accepted ${JSON.stringify(authorizationRef)}`);
  assert.throws(()=>normalizeDESoftwareJobScope({...f.d.job.scopeBinding,authorizationRef},f.d.job),/REFERENCE_INVALID/);
 }
 // Only the composite PA ID is opaque. All leaf references retain their existing canonical limits.
 for(const field of ['candidateId','skuPackageId','productionBindingId','productionConfigurationVersion']){
  assert.throws(()=>normalizeDPlatformObservationConfiguration({policies:[{...entry,[field]:'x'.repeat(257)}],pumpIntervalMs:1000},[f.d.currentProductionBinding]),/CONFIGURATION_INVALID/);
 }
 for(const field of ['candidateId','skuPackageId','sourceDJobId','sourceExecutionKey','warehouseRef','credentialAlias']){
  assert.throws(()=>assertDPlatformObservationScope(resign({...base,authorizationRef:longAuthorization,[field]:'x'.repeat(257)})),/SCOPE_INVALID/);
 }
 assert.deepEqual(f.d.calls,['/v3/product/import']);assert.equal(f.calls.length,0);
});
