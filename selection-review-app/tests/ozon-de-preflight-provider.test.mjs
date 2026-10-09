import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlatformWritePreflight } from '../lib/platform-write-preflight.mjs';
import { assertOzonDEPreflightEvidence,createOzonDEPreflightProvider,OzonDEPreflightEvidenceError,OzonDEPreflightEvidenceUnavailableError } from '../lib/ozon-de-preflight-provider.mjs';
import { ozonDEPreflightEvidenceFixture as legacyFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
const now='2026-08-22T07:25:00.000Z', clone=value=>structuredClone(value);

function fixture() {
 const f=legacyFixture();
 f.record.schemaVersion='ozon-de-preflight-evidence-v3';
 f.record.protocols.inventoryWrite.prerequisitePolicy={schemaVersion:'ozon-inventory-prerequisite-policy-v1',policyId:'policy:synthetic:inventory',
  version:'synthetic-v1',officialEvidenceRef:'evidence:synthetic:official-inventory',priceSent:{endpoint:'/v3/product/info/list',field:'statuses.status',acceptedValues:['synthetic_price_sent']},
  reserved:{endpoint:'/v2/product/info/stocks-by-warehouse/fbs',sourceProtocol:'ozon-product-stocks-by-warehouse-fbs-v2'},stockRequest:{identityField:'offer_id',quantSize:null}};
 return f;
}

function provider(readEvidence) { return createOzonDEPreflightProvider({readEvidence,serverClock:()=>now}); }
test('construction performs no reads; missing evidence remains not_ready and produces saved preparation-linked unknown',async()=>{
 const f=fixture();let reads=0;const p=provider(async scope=>{reads++;assert.deepEqual(scope,f.scope);return null;});assert.equal(reads,0);
 const capabilities=await p.loadAdapterCapabilities(f.context);assert.equal(capabilities.status,'not_ready');assert.equal(capabilities.evidenceRef,null);assert.ok(capabilities.gaps.some(g=>g.code==='account_evidence_missing'));
 const preflight=await runPlatformWritePreflight({productionPlan:f.context.productionPlan,checkedAt:now,inspectPlatform:q=>p.inspectPlatform(q,f.context)});
 assert.equal(preflight.technicalStatus,'data_unavailable');assert.equal(preflight.priceCurrency.observed,'unknown');assert.equal(preflight.connectionStatus.sellerBackend.status,'unknown');
 assert.ok(preflight.permission.evidenceRef.startsWith(f.context.preparationEvidence.preparationId));assert.equal(reads,2);
});
test('synthetic trusted persisted record composes existing capabilities and inspector without mutating inputs',async()=>{
 const f=fixture(),before=clone(f.record),p=provider(async()=>f.record);
 assert.deepEqual(assertOzonDEPreflightEvidence(f.record),f.record);assert.equal((await p.loadAdapterCapabilities(f.context)).status,'ready');
 assert.deepEqual(await p.inspectPlatform(f.query,f.context),f.record.inspection);assert.deepEqual(f.record,before);
});
test('source refusal is explicit; unrelated storage exceptions propagate unchanged',async()=>{
 const f=fixture(),p=provider(async()=>{throw new OzonDEPreflightEvidenceUnavailableError('evidence_source_unverified');});
 assert.equal((await p.inspectPlatform(f.query,f.context)).risks[0].code,'evidence_source_unverified');
 assert.ok((await p.loadAdapterCapabilities(f.context)).gaps.some(g=>g.code==='evidence_source_unverified'));
 const error=new Error('storage failed');await assert.rejects(()=>provider(async()=>{throw error;}).loadAdapterCapabilities(f.context),value=>value===error);
 assert.throws(()=>new OzonDEPreflightEvidenceUnavailableError('anything'),TypeError);
});
test('expired or future evidence never verifies a store',async()=>{
 for(const change of [record=>record.expiresAt=now,record=>{record.collectedAt='2026-08-22T07:30:00.000Z';}]){
  const f=fixture();change(f.record);const p=provider(async()=>f.record);
  assert.equal((await p.inspectPlatform(f.query,f.context)).risks[0].code,'account_evidence_not_current');assert.equal((await p.loadAdapterCapabilities(f.context)).status,'not_ready');
 }
});
test('all persisted scope fields are bound; crossing store, revision, SKU, authorization or binding rejects',async()=>{
 for(const field of ['candidateId','skuPackageId','supplierSkuId','authorizationId','sourceCandidateRevision','storeRef','warehouseRef','warehouseId','credentialAlias','bindingId','configurationVersion']){
  const f=fixture();if(field==='storeRef')f.record.scope.storeRef.mappingVersion='mapping:other';else if(field==='sourceCandidateRevision')f.record.scope[field]++;else if(field==='warehouseId')f.record.scope[field]='9999';else f.record.scope[field]+=':other';
  const result=await provider(async()=>f.record).loadAdapterCapabilities(f.context);assert.equal(result.status,'not_ready');assert.ok(result.gaps.some(g=>g.code.endsWith('SCOPE_MISMATCH')));
 }
});
test('closed DTO rejects raw secrets, extra fields, missing provenance and invented protocol',()=>{
 for(const change of [r=>r.apiKey='forbidden',r=>r.inspection.extra=true,r=>delete r.provenance.readAuthorizationRef,r=>r.provenance.sourceKind='configuration',r=>r.protocols.productImport.endpoint='/v1/product/info',r=>r.inspection.priceFieldCurrency=123,r=>r.provenance.officialContractRefs=Array(21).fill('evidence:many')]){
  const f=fixture();change(f.record);assert.throws(()=>assertOzonDEPreflightEvidence(f.record));
 }
});
test('店铺身份必须说明它站在哪条锚上，两条锚不能混着说',()=>{
 // Ozon returns no store number, so 'scoped_warehouse' asserts there is none to observe: a record carrying one
 // alongside it is a contradiction, in any status. A 'matched' on neither anchor is a bare claim.
 for(const change of [r=>{r.inspection.storeIdentityVia='scoped_warehouse';},
   r=>{r.inspection.storeIdentityVia='scoped_warehouse';r.inspection.storeIdentityStatus='mismatched';},
   r=>{r.inspection.storeIdentityVia='owner_says_so';r.inspection.observedStoreRef=null;},
   r=>{r.inspection.observedStoreRef=null;},
   r=>{r.inspection.storeIdentityVia='none';r.inspection.observedStoreRef=null;},
   // 'none' 就是"没有锚点"，认不出的名字也不是锚。旁边挂着一个真实可对上的 observedStoreRef 仍然不算锚住——
   // Ozon 从不返回店铺编号，那个引用只可能是人手填进去的。这一刀必须落在最早这道门，不能留到下一步。
   r=>{r.inspection.storeIdentityVia='none';},
   r=>{r.inspection.storeIdentityVia='owner_says_so';}]){
  const f=fixture();change(f.record);assert.throws(()=>assertOzonDEPreflightEvidence(f.record),/INSPECTION_INVALID/);
 }
 // 真实生产者写出来的"什么都没查到"仍然合法：'none' + 未核验 + 空引用。
 const blind=fixture();blind.record.inspection.storeIdentityVia='none';blind.record.inspection.storeIdentityStatus='unverified';blind.record.inspection.observedStoreRef=null;
 assert.equal(assertOzonDEPreflightEvidence(blind.record).inspection.storeIdentityVia,'none');
 // Both anchors are accepted on their own terms, and an inspection that names no path keeps the original rule.
 const warehouse=fixture();warehouse.record.inspection.storeIdentityVia='scoped_warehouse';warehouse.record.inspection.observedStoreRef=null;
 assert.equal(assertOzonDEPreflightEvidence(warehouse.record).inspection.storeIdentityVia,'scoped_warehouse');
 const classic=fixture();assert.equal(assertOzonDEPreflightEvidence(classic.record).inspection.storeIdentityStatus,'matched');
 const unverified=fixture();unverified.record.inspection.storeIdentityStatus='unverified';unverified.record.inspection.observedStoreRef=null;
 assert.equal(assertOzonDEPreflightEvidence(unverified.record).inspection.observedStoreRef,null);
});
test('身份锚点跟着身份一起交给适配器：仓库反推放行，非仓库锚点仍按原规则拦',async()=>{
 // 仓库反推：Ozon 不发店铺编号，observedStoreRef 恒为 null 是正确状态，能力检查必须放行。
 const warehouse=fixture();warehouse.record.inspection.storeIdentityVia='scoped_warehouse';warehouse.record.inspection.observedStoreRef=null;
 const anchored=await provider(async()=>warehouse.record).loadAdapterCapabilities(warehouse.context);
 assert.equal(anchored.status,'ready');assert.equal(anchored.storeIdentity.verifiedVia,'scoped_warehouse');
 assert.equal(anchored.storeIdentity.observedStoreRef,null);
 // 未声明路径的历史证据按原规则读，锚点原样记成 platform_store_id。
 const classic=fixture();const classicResult=await provider(async()=>classic.record).loadAdapterCapabilities(classic.context);
 assert.equal(classicResult.status,'ready');assert.equal(classicResult.storeIdentity.verifiedVia,'platform_store_id');
 // 非仓库锚点下引用对不上仍然拦：换掉 platformStoreId，证据本身合法，能力检查必须报身份未验证。
 const drifted=fixture();drifted.record.inspection.observedStoreRef.platformStoreId+=':other';
 assert.deepEqual(assertOzonDEPreflightEvidence(drifted.record).inspection.observedStoreRef,drifted.record.inspection.observedStoreRef);
 const blocked=await provider(async()=>drifted.record).loadAdapterCapabilities(drifted.context);
 assert.equal(blocked.status,'not_ready');assert.ok(blocked.gaps.some(g=>g.code==='store_identity_not_verified'));
});
test('query/context disagreement and expired leases are rejected before evidence reads',async()=>{
 for(const change of [f=>f.query.expectedStore='miska',f=>f.query.platformWriteRequested=true,f=>f.context.candidateRevision++,f=>f.context.sourceRevision++,f=>f.context.leaseId='lease:wrong',f=>f.context.job.leaseExpiresAt=now]){
  const f=fixture();change(f);let reads=0;await assert.rejects(()=>provider(async()=>{reads++;return f.record;}).inspectPlatform(f.query,f.context));assert.equal(reads,0);
 }
});
test('missing backend, denied permission and RUB observation are preserved exactly',async()=>{
 const f=fixture();f.record.inspection.connections.sellerBackend.status='unknown';f.record.inspection.permissionStatus='denied';f.record.inspection.priceFieldCurrency='RUB';
 const result=await provider(async()=>f.record).inspectPlatform(f.query,f.context);assert.equal(result.connections.sellerBackend.status,'unknown');assert.equal(result.permissionStatus,'denied');assert.equal(result.priceFieldCurrency,'RUB');const capabilities=await provider(async()=>f.record).loadAdapterCapabilities(f.context);assert.equal(capabilities.status,'not_ready');assert.equal(capabilities.evidenceRef,null);assert.ok(capabilities.gaps.some(g=>g.code==='account_inspection_not_ready'));
});
test('asset proof must belong to same PA and ordered assets; final URLs alone never create asset capability',async()=>{
 for(const change of [s=>s.intent.status='in_flight',s=>s.assetTransport.resolvedAssets.push(clone(s.assetTransport.resolvedAssets[0])),s=>s.intent.authorizationId='pa:other',s=>s.intent.skuPackageId='sku:other',s=>s.assetTransport.resolvedAssets[0].sha256='0'.repeat(64),s=>s.intent.finalUploadAssetIds.reverse()]){
  const f=fixture();change(f.context.candidate.lifecycleV11.skuPackage.dAssetTransport);await assert.rejects(()=>provider(async()=>f.record).loadAdapterCapabilities(f.context),/ASSET_/);
 }
 const f=fixture();delete f.context.candidate.lifecycleV11.skuPackage.dAssetTransport;
 const result=await provider(async()=>f.record).loadAdapterCapabilities(f.context);assert.equal(result.status,'not_ready');assert.ok(result.gaps.some(g=>g.code==='asset_transport_not_verified'));
});
test('cancellation during evidence read cannot return verified inspection',async()=>{
 const f=fixture(),controller=new AbortController();f.context.signal=controller.signal;
 await assert.rejects(()=>provider(async()=>{controller.abort();return f.record;}).inspectPlatform(f.query,f.context),/CANCELLED/);
});

test('known damaged evidence persists system_error, not missing or unknown',async()=>{const f=fixture();f.record.inspection.extra=true;const result=await provider(async()=>f.record).inspectPlatform(f.query,f.context);assert.equal(result.connections.api.status,'system_error');assert.equal(result.risks[0].code,'OZON_DE_PREFLIGHT_EVIDENCE_INSPECTION_INVALID');});

test('real saved D asset producer result is accepted by provider and stays bound to its PA',async()=>{
 const {savedDProductionJobFixture}=await import('./fixtures/d-production-saved-job-fixture.mjs');
 const {createDAssetTransportSoftwareRuntime}=await import('../lib/d-asset-transport-software-use-case.mjs');
 const f=await savedDProductionJobFixture(),uploads=[];
 const runtime=createDAssetTransportSoftwareRuntime({repository:f.repository,runtimeMode:'local_development',serverClock:f.input.serverClock,
  loadCurrentProductionBinding:()=>clone(f.currentProductionBinding),resolveLocalAsset:async()=>{throw new Error('Synthetic upload must not read local files');},
  upload:async({finalUploads,beforePublicWrite})=>{
   for(const asset of finalUploads){await beforePublicWrite({assetId:asset.assetId,sha256:asset.sha256,order:asset.order});uploads.push(asset.assetId);}
   return {...clone(f.input.adapterCapabilities.assetTransport),mode:'preapproved_stable_https',protocolVersion:'aliyun-oss-final-assets-v1'};
  }});
 const result=await runtime.run({actor:f.input.actor,input:{candidateId:f.candidate.id,expectedCandidateRevision:f.candidate.dataRevision},softwareJobContext:f.input.softwareJobContext});
 assert.equal(result.assetTransportState.status,'verified');
 const document=await f.repository.readSnapshot(),candidate=document.candidates[0],state=candidate.lifecycleV11.skuPackage.dAssetTransport;
 assert.deepEqual(state,result.assetTransportState);assert.equal(state.intent.status,'completed');assert.ok(state.intent.persistedAt);assert.ok(state.intent.completedAt);
 assert.deepEqual(uploads,state.intent.finalUploadAssetIds);
 const pa=candidate.lifecycleV11.skuPackage.productionAuthorization,locked=pa.lockedScope,b=f.currentProductionBinding,at=f.input.serverClock();
 const record=fixture().record;
 record.scope={candidateId:candidate.id,skuPackageId:locked.skuPackageId,supplierSkuId:locked.supplierSkuId,authorizationId:pa.authorizationId,sourceCandidateRevision:pa.sourceCandidateRevision,
  storeRef:clone(locked.storeRef),warehouseRef:locked.warehouseRef,warehouseId:b.warehouseId,credentialAlias:locked.credentialAlias,bindingId:b.bindingId,configurationVersion:b.configurationVersion};
 record.collectedAt=at;record.expiresAt=new Date(Date.parse(at)+60000).toISOString();
 record.inspection.observedStore=locked.storeRef.stableStoreId;record.inspection.observedStoreRef=clone(locked.storeRef);record.inspection.platformWritableFields=clone(locked.allowedWriteFields);
 Object.assign(record.protocols.inventoryWrite,{warehouseId:b.warehouseId,storeRef:clone(locked.storeRef),warehouseRef:locked.warehouseRef,credentialAlias:locked.credentialAlias});
 const p=createOzonDEPreflightProvider({readEvidence:async scope=>{assert.deepEqual(scope,record.scope);return clone(record);},serverClock:f.input.serverClock});
 const input={candidate,productionBinding:b,job:document.runtime.softwareJobs.find(job=>job.jobId===f.job.jobId)};
 const accepted=await p.loadAdapterCapabilities(input);assert.equal(accepted.status,'ready',JSON.stringify(accepted.gaps));assert.deepEqual(accepted.assetTransport.resolvedAssets,state.assetTransport.resolvedAssets);
 const crossed=clone(input);crossed.candidate.lifecycleV11.skuPackage.dAssetTransport.intent.authorizationId+=':other';
 await assert.rejects(()=>p.loadAdapterCapabilities(crossed),/ASSET_SCOPE_MISMATCH/);
 assert.equal(f.calls.length,0);assert.deepEqual((await f.repository.readSnapshot()).candidates[0],candidate);
});

test('v3 API capability ignores unobserved backend while retaining all other scope gates', async () => {
 const f=fixture(); f.record.inspection.connections.sellerBackend.status='unknown';
 const p=provider(async()=>f.record);
 assert.equal((await p.loadAdapterCapabilities(f.context)).status,'ready');
 assert.equal((await p.inspectPlatform(f.query,f.context)).connections.sellerBackend.status,'unknown');
 f.record.inspection.connections.api.status='unknown';
 assert.ok((await p.loadAdapterCapabilities(f.context)).gaps.some(g=>g.field==='apiConnection'));
});

test('legacy protocol evidence remains exactly readable and cannot supply current capabilities or inspection', async () => {
 const {OZON_DE_LEGACY_READBACK_ENDPOINTS,OZON_DE_READBACK_ENDPOINTS}=await import('../lib/ozon-seller-api-de-adapter.mjs');
 const f=fixture(); f.record.schemaVersion='ozon-de-preflight-evidence-v1'; delete f.record.protocols.inventoryWrite.prerequisitePolicy;
 f.record.protocols.independentReadback.endpoints=clone(OZON_DE_LEGACY_READBACK_ENDPOINTS);
 f.record.protocols.independentReadback.protocolVersion='ozon-independent-readback-v1';
 const before=clone(f.record); assert.deepEqual(assertOzonDEPreflightEvidence(f.record),before);
 const p=provider(async()=>f.record),caps=await p.loadAdapterCapabilities(f.context);
 assert.equal(caps.status,'not_ready');assert.ok(caps.gaps.some(g=>g.code==='evidence_protocol_version_outdated'));
 const inspection=await p.inspectPlatform(f.query,f.context);assert.equal(inspection.storeIdentityStatus,'unverified');assert.equal(inspection.risks[0].code,'evidence_protocol_version_outdated');
 assert.deepEqual(f.record,before);
 f.record.schemaVersion='ozon-de-preflight-evidence-v2';assert.throws(()=>assertOzonDEPreflightEvidence(f.record),/PROTOCOL_INVALID/);
 f.record.protocols.independentReadback.endpoints=clone(OZON_DE_READBACK_ENDPOINTS);assert.throws(()=>assertOzonDEPreflightEvidence(f.record),/PROTOCOL_INVALID/);
 f.record.protocols.independentReadback.protocolVersion='ozon-independent-readback-v2';assert.doesNotThrow(()=>assertOzonDEPreflightEvidence(f.record));
 assert.equal((await p.inspectPlatform(f.query,f.context)).risks[0].code,'evidence_protocol_version_outdated');
 assert.equal((await p.loadAdapterCapabilities(f.context)).status,'not_ready');
 f.record.schemaVersion='ozon-de-preflight-evidence-v1';assert.throws(()=>assertOzonDEPreflightEvidence(f.record),/PROTOCOL_INVALID/);
});

async function waitingSourceFixture() {
 const {savedDProductionJobFixture}=await import('./fixtures/d-production-saved-job-fixture.mjs');
 const {runPersistedDExecution}=await import('../lib/d-e-software-integration.mjs');
 const {fingerprintProductionAuthorization}=await import('../lib/production-plan.mjs');
 const d=await savedDProductionJobFixture(),at=d.input.serverClock();
 const policy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:observation',version:'v1',maxQueries:4,intervalMs:0,
  requestTimeoutMs:1000,expiresAt:new Date(Date.parse(at)+60000).toISOString()};
 const result=await runPersistedDExecution({...d.input,platformObservationPolicy:policy,createAdapter:d.createAdapter()});
 assert.equal(result.status,'waiting_platform');
 const document=await d.repository.readSnapshot(),candidate=document.candidates[0],sku=candidate.lifecycleV11.skuPackage,pa=sku.productionAuthorization,locked=pa.lockedScope,b=d.currentProductionBinding;
 const record=fixture().record;
 record.scope={candidateId:candidate.id,skuPackageId:locked.skuPackageId,supplierSkuId:locked.supplierSkuId,authorizationId:pa.authorizationId,sourceCandidateRevision:pa.sourceCandidateRevision,
  storeRef:clone(locked.storeRef),warehouseRef:locked.warehouseRef,warehouseId:b.warehouseId,credentialAlias:locked.credentialAlias,bindingId:b.bindingId,configurationVersion:b.configurationVersion};
 record.collectedAt=at;record.expiresAt=new Date(Date.parse(at)+60000).toISOString();
 record.inspection.observedStore=locked.storeRef.stableStoreId;record.inspection.observedStoreRef=clone(locked.storeRef);record.inspection.platformWritableFields=clone(locked.allowedWriteFields);
 Object.assign(record.protocols.inventoryWrite,{warehouseId:b.warehouseId,storeRef:clone(locked.storeRef),warehouseRef:locked.warehouseRef,credentialAlias:locked.credentialAlias});
 // Synthetic saved media receipt, independently bound to this fixture's real PA/plan.
 sku.dAssetTransport={status:'verified',continuationBlocked:false,intent:{status:'completed',persistedAt:at,completedAt:at,candidateId:candidate.id,
  skuPackageId:locked.skuPackageId,authorizationId:pa.authorizationId,authorizationFingerprint:fingerprintProductionAuthorization(pa),
  productionPlan:clone(d.input.productionPlan),finalUploadAssetIds:locked.finalUploads.map(asset=>asset.assetId)},
  assetTransport:{...clone(d.input.adapterCapabilities.assetTransport),mode:'preapproved_stable_https',protocolVersion:'synthetic-assets-v1'}};
 document.runtime.ozonDEPreflightEvidence={[pa.authorizationId]:record};
 const job=document.runtime.softwareJobs.find(value=>value.jobType==='d_production_execution');
 const observationJob=document.runtime.softwareJobs.find(value=>value.jobType==='e_d_platform_observation');
 return {document,candidate,job,observationJob,record,productionBinding:b,at};
}
let waitingSource;
async function sourceFixture() { waitingSource ??= waitingSourceFixture(); return clone(await waitingSource); }

test('current observation jobs load exactly their original D evidence scope; crossed task and revision never read evidence',async()=>{
 const f=await sourceFixture();let reads=0;
 const p=createOzonDEPreflightProvider({serverClock:()=>f.at,readEvidence:async scope=>{reads++;assert.deepEqual(scope,f.record.scope);return clone(f.record);}});
 assert.equal((await p.loadAdapterCapabilities({candidate:f.candidate,job:f.observationJob,productionBinding:f.productionBinding})).status,'ready');
 const {fingerprintCanonicalRecord}=await import('../lib/production-contract-primitives.mjs');
 for(const field of ['sourceDJobId','taskId','sourceExecutionKey','authorizationFingerprint','warehouseId','requestReceiptRef','revision']) {
  const job=clone(f.observationJob);job.scopeBinding[field]=field==='revision'?job.scopeBinding[field]+1:field==='taskId'||field==='warehouseId'?'999999':`${job.scopeBinding[field]}:other`;
  const {inputFingerprint,...core}=job.scopeBinding;job.scopeBinding.inputFingerprint=fingerprintCanonicalRecord(core);
  await assert.rejects(()=>p.loadAdapterCapabilities({candidate:f.candidate,job,productionBinding:f.productionBinding}));
 }
 assert.equal(reads,1);
});

test('async inventory source proof performs one verified read then only compares the current transaction record',async()=>{
 const f=await sourceFixture();let reads=0;
 const p=createOzonDEPreflightProvider({serverClock:()=>f.at,verifySourceSnapshot:(document,record)=>document.runtime.syntheticSourceUnchanged===false?null:record,
  readEvidence:async scope=>{reads++;assert.deepEqual(scope,f.record.scope);return clone(f.record);}});
 const proof=await p.verifyInventoryPrerequisiteSource(f);assert.equal(typeof proof.assertCurrent,'function');assert.equal(reads,1);
 const state=f.candidate.lifecycleV11.skuPackage.dSoftwareExecution,r=state.attempt.request,c=state.platformContinuation;
 const scope={platform:r.platform,store:r.store,storeRef:clone(r.storeRef),warehouseRef:r.warehouseRef,credentialAlias:r.credentialAlias,warehouseId:r.inventoryWrite.warehouseId,
  taskId:c.taskId,productId:c.productId,merchantSku:r.merchantSku,supplierSkuId:r.supplierSkuId,executionKey:r.executionKey,requestReceiptRef:c.requestReceiptRef};
 const prerequisites={priceSentObservation:{scope:clone(scope),policy:clone(f.record.protocols.inventoryWrite.prerequisitePolicy)},
  inventoryPrerequisiteObservation:{scope:clone(scope),policy:clone(f.record.protocols.inventoryWrite.prerequisitePolicy)}};
 const args={document:f.document,candidate:f.candidate,job:f.job,prerequisites,checkedAt:f.at};
 assert.equal(proof.assertCurrent(args),true);assert.equal(reads,1);
 for(const change of [a=>a.document.runtime.ozonDEPreflightEvidence[f.record.scope.authorizationId].provenance.softwareJobRef='job:other',
  a=>a.prerequisites.priceSentObservation.policy.version='changed',a=>a.prerequisites.inventoryPrerequisiteObservation.scope.taskId='999',
  a=>delete a.document.runtime.ozonDEPreflightEvidence,a=>a.document.runtime.syntheticSourceUnchanged=false,a=>a.checkedAt='2000-01-01T00:00:00.000Z']) {
  const changed=clone(args);change(changed);assert.equal(proof.assertCurrent(changed),false);
 }
 assert.equal(reads,1);
 for(const error of [new OzonDEPreflightEvidenceError('ACCOUNT_SOURCE_INVALID'),new OzonDEPreflightEvidenceUnavailableError('evidence_source_unverified')]) {
  const refused=await createOzonDEPreflightProvider({serverClock:()=>f.at,readEvidence:async()=>clone(f.record),verifySourceSnapshot:()=>{throw error;}}).verifyInventoryPrerequisiteSource(f);
  assert.equal(refused.assertCurrent(args),false);
 }
 const unexpected=new Error('source reconstruction defect');
 const broken=await createOzonDEPreflightProvider({serverClock:()=>f.at,readEvidence:async()=>clone(f.record),verifySourceSnapshot:()=>{throw unexpected;}}).verifyInventoryPrerequisiteSource(f);
 assert.throws(()=>broken.assertCurrent(args),error=>error===unexpected);
 const booleanOnly=await createOzonDEPreflightProvider({serverClock:()=>f.at,readEvidence:async()=>clone(f.record),verifySourceSnapshot:()=>true}).verifyInventoryPrerequisiteSource(f);
 assert.equal(booleanOnly.assertCurrent(args),false);
 f.at=f.record.expiresAt;assert.equal(proof.assertCurrent({...args,checkedAt:f.at}),false);
});

test('unverified source and missing real protocol cannot yield an inventory source proof',async()=>{
 const f=await sourceFixture();
 const unavailable=createOzonDEPreflightProvider({serverClock:()=>f.at,verifySourceSnapshot:()=>{throw new Error('must not verify unavailable source');},readEvidence:async()=>{throw new OzonDEPreflightEvidenceUnavailableError('evidence_source_unverified');}});
 assert.equal(await unavailable.verifyInventoryPrerequisiteSource(f),null);
 f.record.protocols={productImport:null,inventoryWrite:null,independentReadback:null};
 const p=createOzonDEPreflightProvider({serverClock:()=>f.at,verifySourceSnapshot:(_document,record)=>record,readEvidence:async()=>f.record});
 assert.equal(await p.verifyInventoryPrerequisiteSource(f),null);
 assert.equal(await createOzonDEPreflightProvider({serverClock:()=>f.at,readEvidence:async()=>{throw new Error('missing sync verifier must stop before read');}}).verifyInventoryPrerequisiteSource(f),null);
 const error=new Error('repository unavailable');
 await assert.rejects(()=>createOzonDEPreflightProvider({serverClock:()=>f.at,verifySourceSnapshot:(_document,record)=>record,readEvidence:async()=>{throw error;}}).verifyInventoryPrerequisiteSource(f),value=>value===error);
});

test('v3 policy uses fixed protocol paths and observation codec removes only those paths without widening safe persistence',async()=>{
 const {encodeDPlatformObservationResult,decodeDPlatformObservationResult}=await import('../lib/d-platform-observation-contract.mjs');
 const {assertSafeRuntimeRecord}=await import('../lib/runtime-identity.mjs');
 const f=fixture(),value={policy:clone(f.record.protocols.inventoryWrite.prerequisitePolicy)};
 assert.doesNotThrow(()=>assertOzonDEPreflightEvidence(f.record));
 const encoded=encodeDPlatformObservationResult(value);assertSafeRuntimeRecord(encoded,'syntheticPolicy');
 assert.equal(JSON.stringify(encoded).includes('/v3/'),false);assert.equal(JSON.stringify(encoded).includes('/v2/'),false);
 assert.deepEqual(decodeDPlatformObservationResult(encoded),value);
 const bad=fixture();bad.record.protocols.inventoryWrite.prerequisitePolicy.priceSent.endpoint='/Users/private';
 assert.throws(()=>assertOzonDEPreflightEvidence(bad.record));
 const p=provider(async()=>bad.record);const result=await p.loadAdapterCapabilities(bad.context);
 assert.equal(result.status,'not_ready');assert.ok(result.gaps.some(gap=>gap.code==='OZON_DE_PREFLIGHT_EVIDENCE_PROTOCOL_INVALID'||gap.code==='OZON_DE_PREFLIGHT_EVIDENCE_UNSAFE_RECORD'));
});
