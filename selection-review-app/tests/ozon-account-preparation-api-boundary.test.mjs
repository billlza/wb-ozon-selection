import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture,startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

test('real server account preparation has no candidate dependency and rejects unauthorized reads before account access',async t=>{
  const fixture=await productionOwnerDecisionHttpFixture();fixture.document.candidates=[];
  const directory=await mkdtemp(path.join(tmpdir(),'account-preparation-boundary-'));
  const route={bindingId:'binding:discovery:http',configurationVersion:'config:1',platform:'ozon',targetStore:'miska',storeName:'合成账户',credentialAlias:'alias:discovery:http',workerId:'worker:discovery:http',workerVersion:'worker:1',leaseDurationMs:10000};
  const api=await startSavedDEApi(t,{directory,port:allocatedTestPorts().api,document:fixture.document,binding:fixture.binding,productionBindings:[],
    discoveryBindings:[route],credentialBindings:[{credentialAlias:route.credentialAlias,clientId:'700123',keychainService:'synthetic-discovery-http',keychainAccount:'synthetic-only'}]});
  const url='/api/account-preparations';
  assert.ok([401,403].includes((await api.get(url)).status));
  await api.authenticate();const before=await api.readBytes();
  const view=await api.get(url);assert.equal(view.status,200);assert.deepEqual(view.body.preparations,[]);assert.equal(view.body.bindings.length,1);
  const binding=view.body.bindings[0];assert.equal(Object.hasOwn(binding,'warehouseId'),false);assert.equal(Object.hasOwn(binding,'storeRef'),false);
  const input={bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,idempotencyKey:'create:synthetic:http'};
  assert.equal((await api.post(`${url}/create`,input,{headers:{Origin:'https://unrelated.invalid'}})).status,403);
  assert.equal((await api.post(`${url}/create`,input,{headers:{'Content-Type':'text/plain'}})).status,415);
  assert.deepEqual(await api.readBytes(),before);
  const created=await api.post(`${url}/create`,input);assert.equal(created.status,200);assert.equal(created.body.preparations.length,1);
  const preparation=created.body.preparations[0].preparation;
  assert.equal(preparation.revision,0);assert.equal(preparation.binding.storeIdentityStatus,'unverified');
  const saved=await api.readBytes(),document=await api.readDocument();assert.deepEqual(document.candidates,[]);assert.deepEqual(document.runtime.softwareJobs??[],[]);
  assert.deepEqual((await api.post(`${url}/create`,input)).body,created.body);
  const permission={preparationId:preparation.preparationId,expectedRevision:0,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,
    expiresAt:'2099-01-01T00:00:00.000Z',confirmReadOnce:false,idempotencyKey:'read:synthetic:http'};
  assert.equal((await api.post(`${url}/authorize`,permission)).status,422);
  assert.equal((await api.post(`${url}/authorize`,{...permission,confirmReadOnce:true,expectedRevision:1})).status,409);
  assert.equal((await api.post(`${url}/authorize`,{...permission,candidateId:'fake:candidate'})).status,422);
  assert.deepEqual(await api.readBytes(),saved);
  await api.restart();await api.authenticate('login');
  assert.deepEqual((await api.get(url)).body,created.body);assert.deepEqual(await api.readBytes(),saved);await api.assertClean();
});
