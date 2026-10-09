import { assertOzonInventoryPrerequisitePolicy } from './ozon-inventory-prerequisite-policy.mjs';
import { isDeepStrictEqual } from 'node:util';
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { isCompleteStoreRef, sameStoreRef } from './store-binding.mjs';
import { isRuntimeConfigurationTimestamp, normalizeProductionBindings } from './runtime-configuration.mjs';
import { assertValidProductionAuthorization, PRODUCTION_WRITE_FIELDS } from './production-authorization.mjs';
import { assertCurrentProductionExecutionBinding } from './platform-write-preflight.mjs';
import { assertDProductionPreparation } from './d-production-preparation-contract.mjs';
import { fingerprintProductionAuthorization, fingerprintProductionPlan, validateProductionPlanAuthorizationBinding } from './production-plan.mjs';
import { inspectAdapterCapabilities, resolveFinalUploads, OZON_DE_READBACK_ENDPOINTS, OZON_DE_LEGACY_READBACK_ENDPOINTS, OZON_SELLER_API_DE_ADAPTER_VERSION } from './ozon-seller-api-de-adapter.mjs';
import { assertDPlatformObservationScope } from './d-platform-observation-contract.mjs';
import { decodeAttempt } from './d-execution-request-codec.mjs';
import { ozonProductionConnectionRequirements } from './ozon-production-strategy.mjs';
import { STORE_IDENTITY_PATHS, canStoreIdentityPathAnchor } from './platform-write-preflight-contract.mjs';
import { assertOzonProductImportBatchLimitEvidence } from './ozon-product-import-batch-limit.mjs';

const scopeFields = ['candidateId','skuPackageId','supplierSkuId','authorizationId','sourceCandidateRevision','storeRef','warehouseRef','warehouseId','credentialAlias','bindingId','configurationVersion'];
const inspectionFields = ['observedStore','observedStoreRef','storeIdentityStatus','storeIdentityEvidenceRef','permissionStatus','permissionEvidenceRef','connections','platformWritableFields','imagePermissionStatus','imagePermissionEvidenceRef','priceFieldCurrency','priceCurrencyEvidenceRef','risks'];
// Which anchor established the store identity. The list of names and which of them can anchor at all both come from
// the preflight contract, so this gate and the ones downstream cannot drift apart. 'platform_store_id' requires an
// observed store ref; 'scoped_warehouse' (owner decision 2026-09-16) requires the absence of one, because Ozon returns
// no store number to observe. Optional: an inspection without the field reads as the original 'platform_store_id' rule.
const writeFields = PRODUCTION_WRITE_FIELDS;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const ref = value => isCanonicalFrozenRef(value) && !['unknown','null','undefined','missing'].includes(value.toLowerCase());
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const permission = value => ['verified','denied','permission_required','unknown'].includes(value);
export class OzonDEPreflightEvidenceError extends Error {
  constructor(code) { super(`OZON_DE_PREFLIGHT_EVIDENCE_${code}`); this.name = 'OzonDEPreflightEvidenceError'; this.code = this.message; }
}
export class OzonDEPreflightEvidenceUnavailableError extends Error {
  constructor(code) {
    if (code !== 'evidence_source_unverified') throw new TypeError('OZON_DE_PREFLIGHT_EVIDENCE_UNAVAILABLE_CODE_INVALID');
    super(code); this.name = 'OzonDEPreflightEvidenceUnavailableError'; this.code = code;
  }
}
function requireValue(value, code) { if (!value) throw new OzonDEPreflightEvidenceError(code); }
function safe(value) {
  try { assertNoRawPersistenceKeys(value, 'ozonDEPreflightEvidence'); assertNoProductionSecrets(value, 'ozonDEPreflightEvidence'); }
  catch (error) {
    if (error?.constructor === Error && /^(?:PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C2_SENSITIVE_INPUT_REJECTED|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED):/.test(error.message)) throw new OzonDEPreflightEvidenceError('UNSAFE_RECORD');
    throw error;
  }
}
export function assertOzonDEPreflightEvidenceScope(scope) {
  safe(scope);
  requireValue(closed(scope, scopeFields) && scopeFields.filter(field => !['sourceCandidateRevision','storeRef','warehouseId','authorizationId'].includes(field)).every(field => ref(scope[field])) && text(scope.authorizationId) &&
    integer(scope.sourceCandidateRevision) && isCompleteStoreRef(scope.storeRef, scope.storeRef?.stableStoreId) && /^[1-9][0-9]*$/.test(scope.warehouseId) && typeof scope.warehouseId === 'string', 'SCOPE_INVALID');
  return structuredClone(scope);
}
function assertInspection(value) {
  requireValue((closed(value, inspectionFields) || closed(value, [...inspectionFields, 'storeIdentityVia'])) && text(value.observedStore) && (value.observedStoreRef === null || isCompleteStoreRef(value.observedStoreRef, value.observedStore)) &&
    ['matched','mismatched','unverified'].includes(value.storeIdentityStatus) && permission(value.permissionStatus) && permission(value.imagePermissionStatus) &&
    inspectionFields.filter(field => field.endsWith('EvidenceRef')).every(field => ref(value[field])) &&
    ['CNY','RUB','unknown'].includes(value.priceFieldCurrency) && closed(value.connections, ['api','sellerBackend']) &&
    Array.isArray(value.platformWritableFields) && value.platformWritableFields.length <= writeFields.length &&
    new Set(value.platformWritableFields).size === value.platformWritableFields.length && value.platformWritableFields.every(field => writeFields.includes(field)) &&
    Array.isArray(value.risks) && value.risks.length <= 100 && value.risks.every(risk => closed(risk,['code','message']) && ref(risk.code) && text(risk.message)), 'INSPECTION_INVALID');
  for (const connection of Object.values(value.connections)) requireValue(closed(connection,['status','checkedVia','evidenceRef']) &&
    ['connected','unavailable','system_error','permission_required','unknown'].includes(connection.status) && ref(connection.checkedVia) && ref(connection.evidenceRef), 'INSPECTION_INVALID');
  const via = value.storeIdentityVia ?? 'platform_store_id';
  requireValue(STORE_IDENTITY_PATHS.has(via), 'INSPECTION_INVALID');
  // 'scoped_warehouse' asserts that no store number exists to observe, so carrying one alongside it is a
  // contradiction, not stronger evidence — in any status.
  requireValue(via !== 'scoped_warehouse' || value.observedStoreRef === null, 'INSPECTION_INVALID');
  // 'matched' 必须站在一条真能锚住的路径上，而且那条路径的锚点材料在场。'none' 的字面意思就是没有锚点，
  // 旁边再挂一个 observedStoreRef 也不算——Ozon 从不返回店铺编号，那个引用只可能是人手填进去的。
  // 这道门只判"锚在不在"，不判"锚上的引用对不对得上"：后者要预期引用，由持有它的能力检查判（见 drifted 用例）。
  requireValue(value.storeIdentityStatus !== 'matched' ||
    (canStoreIdentityPathAnchor(via) && (via === 'scoped_warehouse' || value.observedStoreRef !== null)), 'INSPECTION_INVALID');
}
function assertProtocols(protocols, schemaVersion) {
  requireValue(closed(protocols,['productImport','inventoryWrite','independentReadback']), 'PROTOCOL_INVALID');
  const fields = { productImport:['status','protocolVersion','evidenceRef','endpoint','statusEndpoint'], inventoryWrite:['status','protocolVersion','evidenceRef','endpoint','warehouseId','storeRef','warehouseRef','credentialAlias'], independentReadback:['status','protocolVersion','evidenceRef','endpoints'] };
  if (['ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(schemaVersion)) fields.inventoryWrite.push('prerequisitePolicy');
  for (const [name, value] of Object.entries(protocols)) {
    if (value === null) continue;
    requireValue(closed(value,fields[name]) && permission(value.status) && ref(value.protocolVersion) && ref(value.evidenceRef), 'PROTOCOL_INVALID');
    if (name === 'productImport') requireValue(value.endpoint === '/v3/product/import' && value.statusEndpoint === '/v1/product/import/info', 'PROTOCOL_INVALID');
    if (name === 'inventoryWrite') requireValue(value.endpoint === '/v2/products/stocks' && typeof value.warehouseId === 'string' && /^[1-9][0-9]*$/.test(value.warehouseId) &&
      isCompleteStoreRef(value.storeRef,value.storeRef?.stableStoreId) && ref(value.warehouseRef) && ref(value.credentialAlias), 'PROTOCOL_INVALID');
    if (name === 'inventoryWrite' && ['ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(schemaVersion)) {
      requireValue(value.status !== 'verified' || value.prerequisitePolicy !== null, 'PROTOCOL_INVALID');
      if (value.prerequisitePolicy !== null) {
        try { assertOzonInventoryPrerequisitePolicy(value.prerequisitePolicy); }
        catch (error) {
          if (error?.constructor === Error && error.message === 'OZON_DE_INVENTORY_POLICY_INVALID') throw new OzonDEPreflightEvidenceError('PROTOCOL_INVALID');
          throw error;
        }
      }
    }
    if (name === 'independentReadback') requireValue(isDeepStrictEqual(value.endpoints,
      schemaVersion === 'ozon-de-preflight-evidence-v1' ? OZON_DE_LEGACY_READBACK_ENDPOINTS : OZON_DE_READBACK_ENDPOINTS) &&
      (schemaVersion === 'ozon-de-preflight-evidence-v1' || value.protocolVersion === 'ozon-independent-readback-v2'), 'PROTOCOL_INVALID');
  }
}
/** Validates normalized persisted evidence, never raw account responses or configuration assertions.
 * Authenticity is owned by the controlled repository producer; this consumer is not an evidence import API. */
export function assertOzonDEPreflightEvidence(record) {
  safe(record);
  requireValue(closed(record,['schemaVersion','evidenceId','scope','collectedAt','expiresAt','provenance','inspection','protocols']) &&
    ['ozon-de-preflight-evidence-v1','ozon-de-preflight-evidence-v2','ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(record.schemaVersion) && ref(record.evidenceId), 'RECORD_INVALID');
  assertOzonDEPreflightEvidenceScope(record.scope);
  requireValue(isRuntimeConfigurationTimestamp(record.collectedAt) && isRuntimeConfigurationTimestamp(record.expiresAt) && Date.parse(record.collectedAt) < Date.parse(record.expiresAt), 'TIME_INVALID');
  const source = record.provenance;
  requireValue(closed(source,['sourceKind','readAuthorizationRef','softwareJobRef','officialContractRefs']) && source.sourceKind === 'controlled_platform_verification' &&
    ref(source.readAuthorizationRef) && ref(source.softwareJobRef) && Array.isArray(source.officialContractRefs) && source.officialContractRefs.length > 0 &&
    source.officialContractRefs.length <= 20 && source.officialContractRefs.every(ref), 'PROVENANCE_INVALID');
  assertInspection(record.inspection); assertProtocols(record.protocols,record.schemaVersion);
  const inventory = record.protocols.inventoryWrite;
  requireValue(inventory === null || ['storeRef','warehouseId','warehouseRef','credentialAlias'].every(field => isDeepStrictEqual(inventory[field],record.scope[field])), 'SCOPE_MISMATCH');
  return structuredClone(record);
}
function inputScope({candidate,productionBinding,job,batch=null}, checkedAt) {
  const authorization = candidate?.lifecycleV11?.skuPackage?.productionAuthorization;
  assertValidProductionAuthorization(authorization);
  assertCurrentProductionExecutionBinding({productionAuthorization:authorization,currentProductionBinding:productionBinding,checkedAt});
  const locked = authorization.lockedScope;
  const batchMember = batch?.members?.filter(member => member.candidateId === candidate.id);
  const batchContext = job?.jobType === 'd_batch_import' && job.batchId === batch?.batchId &&
    batchMember?.length === 1 && batchMember[0].skuPackageId === locked.skuPackageId &&
    batchMember[0].authorizationId === authorization.authorizationId &&
    batchMember[0].authorizationFingerprint === fingerprintProductionAuthorization(authorization) &&
    batchMember[0].resultRevision === candidate.dataRevision &&
    ['authorized', 'import_admitted', 'claimed', 'waiting_platform', 'partial_failure', 'unknown_outcome',
      'imported_awaiting_inventory'].includes(batch.status);
  const singleContext = job?.candidateId === candidate.id && job.skuPackageId === locked.skuPackageId &&
    ['d_production_execution','e_independent_readback','e_d_platform_observation'].includes(job.jobType);
  requireValue(candidate.id === locked.candidateId && candidate.lifecycleV11.skuPackage.skuPackageId === locked.skuPackageId && integer(candidate.dataRevision) &&
    (batchContext || singleContext), 'CONTEXT_INVALID');
  const scope = {candidateId:candidate.id,skuPackageId:locked.skuPackageId,supplierSkuId:locked.supplierSkuId,authorizationId:authorization.authorizationId,
    sourceCandidateRevision:authorization.sourceCandidateRevision,storeRef:structuredClone(locked.storeRef),warehouseRef:locked.warehouseRef,
    warehouseId:productionBinding.warehouseId,credentialAlias:locked.credentialAlias,bindingId:productionBinding.bindingId,configurationVersion:productionBinding.configurationVersion};
  assertOzonDEPreflightEvidenceScope(scope);
  if (job.jobType === 'e_d_platform_observation') assertObservationSource(candidate,job,authorization,productionBinding);
  return {scope,authorization};
}
/** Batch E observes an already sent import. Its current routing must still match the frozen PA,
 * but an expired write verification cannot revoke a separately authorized account read. */
function batchEReadScope({candidate,productionBinding,batch,offerId}) {
  const authorization = candidate?.lifecycleV11?.skuPackage?.productionAuthorization;
  assertValidProductionAuthorization(authorization);
  const locked = authorization.lockedScope;
  const members = batch?.members?.filter(member => member.candidateId === candidate.id);
  requireValue(batch?.schemaVersion === 'd-batch-production-authorization-v2' &&
    Array.isArray(batch.postImportScope?.eReadbackOfferIds) &&
    batch.postImportScope.eReadbackOfferIds.includes(offerId) &&
    members?.length === 1 && members[0].offerId === offerId &&
    members[0].skuPackageId === locked.skuPackageId && members[0].authorizationId === authorization.authorizationId &&
    members[0].authorizationFingerprint === fingerprintProductionAuthorization(authorization) &&
    members[0].resultRevision === candidate.dataRevision &&
    candidate.id === locked.candidateId && candidate.lifecycleV11.skuPackage.skuPackageId === locked.skuPackageId &&
    candidate.lifecycleV11.skuPackage.supplierSkuId === locked.supplierSkuId &&
    locked.merchantSku === offerId &&
    ['waiting_platform','partial_failure','unknown_outcome','imported_awaiting_inventory'].includes(batch.status), 'CONTEXT_INVALID');
  const [binding] = normalizeProductionBindings([productionBinding], [{
    targetStore:locked.storeRef.stableStoreId,platform:locked.platform,storeRef:locked.storeRef
  }]);
  requireValue(binding.bindingId === authorization.executionBinding.bindingId &&
    binding.configurationVersion === authorization.executionBinding.configurationVersion &&
    binding.warehouseId === authorization.executionBinding.warehouseId &&
    binding.platform === locked.platform && sameStoreRef(binding.storeRef,locked.storeRef) &&
    binding.warehouseRef === locked.warehouseRef && binding.credentialAlias === locked.credentialAlias, 'READ_ROUTING_CHANGED');
  const scope={candidateId:candidate.id,skuPackageId:locked.skuPackageId,supplierSkuId:locked.supplierSkuId,
    authorizationId:authorization.authorizationId,sourceCandidateRevision:authorization.sourceCandidateRevision,
    storeRef:structuredClone(locked.storeRef),warehouseRef:locked.warehouseRef,warehouseId:binding.warehouseId,
    credentialAlias:locked.credentialAlias,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion};
  return assertOzonDEPreflightEvidenceScope(scope);
}
function originalDState(candidate, job, authorization) {
  const state = candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  requireValue(state?.schemaVersion === 'd-software-execution-state-v2' && state.attempt?.schemaVersion === 'd-software-execution-v2' &&
    ['waiting_platform','in_flight'].includes(state.status) && state.attempt.status === state.status && state.continuationBlocked === false &&
    isDeepStrictEqual(state.productionPlan.sourceAuthorization,authorization) &&
    isDeepStrictEqual(state.platformContinuation,state.attempt.platformContinuation), 'OBSERVATION_SOURCE_INVALID');
  const sourceJobId = job.jobType === 'e_d_platform_observation' ? job.scopeBinding.sourceDJobId : job.jobId;
  requireValue(state.softwareJobRef?.jobId === sourceJobId, 'OBSERVATION_SOURCE_INVALID');
  const request = decodeAttempt(state.attempt).request, continuation = state.platformContinuation;
  requireValue(request.executionProtocolVersion === 'ozon-single-sku-d-e-v3' && state.executionKey === request.executionKey &&
    request.candidateId === candidate.id && request.skuPackageId === authorization.lockedScope.skuPackageId &&
    request.supplierSkuId === authorization.lockedScope.supplierSkuId && request.sourceAuthorizationId === authorization.authorizationId &&
    request.sourceAuthorizationFingerprint === fingerprintProductionAuthorization(authorization) &&
    continuation?.schemaVersion === 'd-platform-continuation-v1' && ref(continuation.requestReceiptRef) &&
    typeof continuation.taskId === 'string' && /^[1-9][0-9]*$/.test(continuation.taskId) && Number.isSafeInteger(Number(continuation.taskId)) &&
    isDeepStrictEqual(request.storeRef,authorization.lockedScope.storeRef) && request.warehouseRef === authorization.lockedScope.warehouseRef &&
    request.credentialAlias === authorization.lockedScope.credentialAlias, 'OBSERVATION_SOURCE_INVALID');
  return {request,continuation,state};
}
function assertObservationSource(candidate, job, authorization, binding) {
  const scope = assertDPlatformObservationScope(job.scopeBinding), {request,continuation} = originalDState(candidate,job,authorization);
  requireValue(job.revision === scope.revision && candidate.dataRevision === scope.revision &&
    scope.candidateId === candidate.id && scope.skuPackageId === request.skuPackageId && scope.supplierSkuId === request.supplierSkuId &&
    scope.sourceExecutionKey === request.executionKey && scope.authorizationRef === request.sourceAuthorizationId &&
    scope.authorizationFingerprint === request.sourceAuthorizationFingerprint && scope.taskId === continuation.taskId &&
    scope.requestReceiptRef === continuation.requestReceiptRef && scope.platform === request.platform && scope.store === request.store &&
    sameStoreRef(scope.storeRef,request.storeRef) && scope.warehouseId === binding.warehouseId && scope.warehouseRef === request.warehouseRef &&
    scope.credentialAlias === request.credentialAlias && isDeepStrictEqual(scope.productionBinding,authorization.executionBinding), 'OBSERVATION_SOURCE_INVALID');
}
function prerequisiteScope(request, continuation) {
  return {platform:request.platform,store:request.store,storeRef:structuredClone(request.storeRef),warehouseRef:request.warehouseRef,
    credentialAlias:request.credentialAlias,warehouseId:request.inventoryWrite.warehouseId,taskId:continuation.taskId,productId:continuation.productId,
    merchantSku:request.merchantSku,supplierSkuId:request.supplierSkuId,executionKey:request.executionKey,requestReceiptRef:continuation.requestReceiptRef};
}
function unknownInspection(scope, preparationId, reason, systemError) {
  const evidenceRef = `${preparationId}:${reason}`;
  return {observedStore:scope.storeRef.stableStoreId,observedStoreRef:null,storeIdentityStatus:'unverified',storeIdentityVia:'none',storeIdentityEvidenceRef:evidenceRef,
    permissionStatus:'unknown',permissionEvidenceRef:evidenceRef,connections:{api:{status:systemError ? 'system_error' : 'unknown',checkedVia:'persisted_evidence',evidenceRef},sellerBackend:{status:'unknown',checkedVia:'persisted_evidence',evidenceRef}},
    platformWritableFields:[],imagePermissionStatus:'unknown',imagePermissionEvidenceRef:evidenceRef,priceFieldCurrency:'unknown',priceCurrencyEvidenceRef:evidenceRef,
    risks:[{code:reason,message:systemError ? '持久账户证据校验失败，本轮停止' : '账户、权限或协议的当前持久证据不完整，本轮停止'}]};
}
function assetEvidence(candidate, authorization) {
  const state = candidate.lifecycleV11.skuPackage.dAssetTransport;
  if (state === null || state === undefined || state.status !== 'verified' || state.continuationBlocked) return null;
  const intent = state.intent;
  requireValue(intent?.status === 'completed' && isRuntimeConfigurationTimestamp(intent.persistedAt) && isRuntimeConfigurationTimestamp(intent.completedAt) &&
    Date.parse(intent.persistedAt) <= Date.parse(intent.completedAt) && intent.candidateId === candidate.id && intent.skuPackageId === authorization.lockedScope.skuPackageId && intent.authorizationId === authorization.authorizationId &&
    intent.authorizationFingerprint === fingerprintProductionAuthorization(authorization) && validateProductionPlanAuthorizationBinding(intent.productionPlan,authorization).valid &&
    isDeepStrictEqual(intent.finalUploadAssetIds,authorization.lockedScope.finalUploads.map(asset=>asset.assetId)), 'ASSET_SCOPE_MISMATCH');
  safe(state.assetTransport);
  requireValue(state.assetTransport?.status === 'verified' && state.assetTransport.mode === 'preapproved_stable_https' && ref(state.assetTransport.evidenceRef) &&
    Array.isArray(state.assetTransport.resolvedAssets) && state.assetTransport.resolvedAssets.length === authorization.lockedScope.finalUploads.length &&
    state.assetTransport.resolvedAssets.every((asset,index)=>asset.assetId === authorization.lockedScope.finalUploads[index].assetId) &&
    resolveFinalUploads({finalUploads:authorization.lockedScope.finalUploads,adapterCapabilities:{status:'ready',assetTransport:state.assetTransport}}).status === 'ready', 'ASSET_RECEIPT_INVALID');
  return structuredClone(state.assetTransport);
}
/** Shared pure capability projection; callers must verify the persisted source before using a record. */
export function inspectOzonDEPreflightCapabilities({candidate,authorization,scope,record,reason,now}) {
  const inspection = record?.inspection;
  const result = inspectAdapterCapabilities({store:scope.storeRef.stableStoreId,storeRef:scope.storeRef,warehouseRef:scope.warehouseRef,credentialAlias:scope.credentialAlias,warehouseId:scope.warehouseId,
    // verifiedVia 必须跟着身份一起往下走：丢了它，下游只能看见一个恒为 null 的 observedStoreRef，
    // 无从分辨"仓库反推成立"和"什么都没查到"。命名沿用前检记录里 storeIdentity.verifiedVia（扁平的
    // inspection 才需要 storeIdentity 前缀去和 permissionStatus 之类区分）。
    inspectedAt:now,storeIdentity:inspection === undefined ? null : {status:inspection.storeIdentityStatus === 'matched' ? 'verified' : 'unknown',expectedStore:scope.storeRef.stableStoreId,
      observedStore:inspection.observedStore,observedStoreRef:inspection.observedStoreRef,verifiedVia:inspection.storeIdentityVia ?? 'platform_store_id',
      credentialAlias:scope.credentialAlias,evidenceRef:inspection.storeIdentityEvidenceRef},
    productImport:record?.protocols.productImport ?? null,inventoryWrite:record?.protocols.inventoryWrite ?? null,independentReadback:record?.protocols.independentReadback ?? null,
    assetTransport:assetEvidence(candidate,authorization)});
  const gaps = [...structuredClone(result.gaps)];
  if (record && !['ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(record.schemaVersion)) gaps.push({code:'evidence_protocol_version_outdated',field:'accountEvidence',message:'旧版协议证据仅供历史读取，当前执行需要新版核验'});
  if (reason !== null) gaps.push({code:reason,field:'accountEvidence',message:'当前账户实证不可用'});
  if (inspection !== undefined) {
    const checks = {permission:inspection.permissionStatus === 'verified',imagePermission:inspection.imagePermissionStatus === 'verified',
      priceCurrency:inspection.priceFieldCurrency === authorization.lockedScope.platformWritePrice.currency,
      writeScope:authorization.lockedScope.allowedWriteFields.every(field=>inspection.platformWritableFields.includes(field))};
    for (const name of ozonProductionConnectionRequirements('seller_api').requiredConnections) checks[`${name}Connection`] = inspection.connections[name].status === 'connected';
    for (const [field, ready] of Object.entries(checks)) if (!ready) gaps.push({code:'account_inspection_not_ready',field,message:'当前账户实证不满足生产范围'});
}
return gaps.length === 0 ? result : {...structuredClone(result),status:'not_ready',evidenceRef:null,gaps};
}
/** No network, credential reader, retry or write dependency exists in this provider. */
export function createOzonDEPreflightProvider({readEvidence,serverClock,verifySourceSnapshot=null,loadBatchLimitEvidence=null}) {
  requireValue(typeof readEvidence === 'function' && typeof serverClock === 'function' &&
    (verifySourceSnapshot === null || typeof verifySourceSnapshot === 'function') &&
    (loadBatchLimitEvidence === null || typeof loadBatchLimitEvidence === 'function'), 'DEPENDENCY_INVALID');
  async function read(scope, now) {
    try {
      const value = await readEvidence(structuredClone(scope));
      if (value === null) return {record:null,reason:'account_evidence_missing',systemError:false};
      const record = assertOzonDEPreflightEvidence(value);
      requireValue(isDeepStrictEqual(record.scope,scope), 'SCOPE_MISMATCH');
      if (Date.parse(now) < Date.parse(record.collectedAt) || Date.parse(now) >= Date.parse(record.expiresAt)) return {record:null,reason:'account_evidence_not_current',systemError:false};
      return {record,reason:null,systemError:false};
    } catch (error) {
      if (error instanceof OzonDEPreflightEvidenceUnavailableError) return {record:null,reason:error.code,systemError:false};
      if (error instanceof OzonDEPreflightEvidenceError) return {record:null,reason:error.code,systemError:true};
      throw error;
    }
  }
  return Object.freeze({
    async loadBatchEReadEvidence(input) {
      const checkedAt=serverClock(),scope=batchEReadScope(input);
      const {record}=await read(scope,checkedAt);
      const inspection=record?.inspection,protocol=record?.protocols.independentReadback;
      // permissionStatus aggregates write methods too. The receipt-backed protocol status
      // is the exact role grant for all four independent read endpoints.
      requireValue(record !== null && ['ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(record.schemaVersion) &&
        inspection.storeIdentityStatus === 'matched' && canStoreIdentityPathAnchor(inspection.storeIdentityVia ?? 'platform_store_id') &&
        inspection.observedStore === scope.storeRef.stableStoreId &&
        (inspection.storeIdentityVia === 'scoped_warehouse' || sameStoreRef(inspection.observedStoreRef,scope.storeRef)) &&
        inspection.connections.api.status === 'connected' && protocol?.status === 'verified' &&
        protocol.protocolVersion === 'ozon-independent-readback-v2' &&
        isDeepStrictEqual(protocol.endpoints,OZON_DE_READBACK_ENDPOINTS), 'BATCH_E_READ_NOT_AUTHORIZED');
      // The adapter validates a common transport envelope. These fields are read routing only;
      // no product import or stock write capability is asserted by this projection.
      return Object.freeze({checkedAt,capabilities:{status:'read_ready',platform:'ozon',
        store:scope.storeRef.stableStoreId,storeRef:structuredClone(scope.storeRef),
        warehouseRef:scope.warehouseRef,credentialAlias:scope.credentialAlias,warehouseId:scope.warehouseId,
        adapterVersion:OZON_SELLER_API_DE_ADAPTER_VERSION,protocolVersion:'ozon-single-sku-d-e-v3',
        evidenceRef:record.evidenceId,independentReadback:structuredClone(protocol)}});
    },
    async loadBatchMemberEvidence({candidate,productionBinding,batch,purpose='new_import'}) {
      requireValue(['new_import','import_observation','stock_write'].includes(purpose), 'BATCH_EVIDENCE_PURPOSE_INVALID');
      const checkedAt = serverClock();
      const {scope,authorization} = inputScope({candidate,productionBinding,batch,
        job:{jobType:'d_batch_import',batchId:batch?.batchId}},checkedAt);
      const {record,reason,systemError} = await read(scope,checkedAt);
      let capabilities = inspectOzonDEPreflightCapabilities({candidate,authorization,scope,record,reason,now:checkedAt});
      if (purpose === 'new_import') {
        requireValue(loadBatchLimitEvidence !== null, 'BATCH_LIMIT_SOURCE_REQUIRED');
        const limit = assertOzonProductImportBatchLimitEvidence(await loadBatchLimitEvidence());
        requireValue(Date.parse(checkedAt) >= Date.parse(limit.observedAt) &&
          Date.parse(checkedAt) < Date.parse(limit.validUntil), 'BATCH_LIMIT_NOT_CURRENT');
        capabilities = Object.freeze({...capabilities,productImport:Object.freeze({...capabilities.productImport,
          maxItemsPerRequest:limit.maxItemsPerRequest,limitEvidenceRef:limit.evidenceRef,
          limitObservedAt:limit.observedAt,validUntil:limit.validUntil})});
      }
      const inspection = record === null ? unknownInspection(scope,batch.batchId,reason,systemError) : structuredClone(record.inspection);
      return Object.freeze({capabilities,inspection,checkedAt});
    },
    async loadAdapterCapabilities(input) {
      const now = serverClock(), {scope,authorization} = inputScope(input,now), {record,reason} = await read(scope,now);
      return inspectOzonDEPreflightCapabilities({candidate:input.candidate,authorization,scope,record,reason,now});
    },
    async verifyInventoryPrerequisiteSource(input) {
      const now = serverClock(), {scope,authorization} = inputScope(input,now);
      requireValue(input.job.jobType === 'd_production_execution', 'CONTEXT_INVALID');
      originalDState(input.candidate,input.job,authorization);
      if (verifySourceSnapshot === null) return null;
      const {record,reason} = await read(scope,now);
      if (record === null || !['ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(record.schemaVersion) ||
          inspectOzonDEPreflightCapabilities({candidate:input.candidate,authorization,scope,record,reason,now}).status !== 'ready') return null;
      const verifiedRecord = structuredClone(record), verifiedAuthorization = structuredClone(authorization);
      const candidateId = input.candidate.id, jobId = input.job.jobId, binding = structuredClone(input.productionBinding);
      return Object.freeze({ assertCurrent({document,candidate,job,prerequisites,checkedAt}) {
        const currentTime = serverClock();
        if (!isRuntimeConfigurationTimestamp(checkedAt) || !isRuntimeConfigurationTimestamp(currentTime) ||
            Date.parse(checkedAt) < Date.parse(now) || Date.parse(checkedAt) > Date.parse(currentTime) ||
            Date.parse(currentTime) >= Date.parse(verifiedRecord.expiresAt) || Date.parse(currentTime) < Date.parse(verifiedRecord.collectedAt) ||
            candidate?.id !== candidateId || job?.jobId !== jobId || job.jobType !== 'd_production_execution' ||
            !isDeepStrictEqual(document?.candidates?.find(value=>value.id===candidateId),candidate) ||
            !isDeepStrictEqual(document?.runtime?.softwareJobs?.find(value=>value.jobId===jobId),job) ||
            !isDeepStrictEqual(document?.runtime?.ozonDEPreflightEvidence?.[scope.authorizationId],verifiedRecord) ||
            !isDeepStrictEqual(candidate.lifecycleV11.skuPackage.productionAuthorization,verifiedAuthorization)) return false;
        let rebuilt;
        try { rebuilt = verifySourceSnapshot(document,structuredClone(verifiedRecord),structuredClone(scope)); }
        catch (error) {
          if (error instanceof OzonDEPreflightEvidenceError || error instanceof OzonDEPreflightEvidenceUnavailableError) return false;
          throw error;
        }
        if (!isDeepStrictEqual(rebuilt,verifiedRecord)) return false;
        const current = inputScope({candidate,job,productionBinding:binding},currentTime);
        if (!isDeepStrictEqual(current.scope,scope)) return false;
        const {request,continuation} = originalDState(candidate,job,current.authorization);
        const expectedScope = prerequisiteScope(request,continuation), policy = verifiedRecord.protocols.inventoryWrite.prerequisitePolicy;
        return closed(prerequisites,['priceSentObservation','inventoryPrerequisiteObservation']) &&
          isDeepStrictEqual(prerequisites.priceSentObservation?.scope,expectedScope) &&
          isDeepStrictEqual(prerequisites.inventoryPrerequisiteObservation?.scope,expectedScope) &&
          isDeepStrictEqual(prerequisites.priceSentObservation?.policy,policy) &&
          isDeepStrictEqual(prerequisites.inventoryPrerequisiteObservation?.policy,policy);
      } });
    },
    async inspectPlatform(query,context) {
      const now = serverClock(), {scope,authorization} = inputScope(context,now);
      const preparation = assertDProductionPreparation(context.preparationEvidence,{job:context.job});
      requireValue(context.job.jobType === 'd_production_execution' && preparation.status === 'in_flight' && !context.signal?.aborted &&
        context.candidateRevision === context.candidate.dataRevision && context.sourceRevision === context.job.revision && context.workerId === context.job.workerId && context.leaseId === context.job.leaseId &&
        Date.parse(now) < Date.parse(context.job.leaseExpiresAt) && isDeepStrictEqual(context.productionAuthorization,authorization) &&
        preparation.sourceCandidateRevision === context.candidateRevision && preparation.sourceProductionPlanFingerprint === fingerprintProductionPlan(context.productionPlan) &&
        validateProductionPlanAuthorizationBinding(context.productionPlan,authorization).valid, 'CONTEXT_INVALID');
      requireValue(query?.mode === 'read_only_preflight' && query.targetPlatform === 'ozon' && query.expectedStore === scope.storeRef.stableStoreId &&
        sameStoreRef(query.expectedStoreRef,scope.storeRef) && query.platformWriteRequested === false &&
        isDeepStrictEqual(query.requestedWriteFields,authorization.lockedScope.allowedWriteFields) && query.expectedPlatformWriteCurrency === authorization.lockedScope.platformWritePrice.currency, 'QUERY_MISMATCH');
      const {record,reason,systemError} = await read(scope,now);
      requireValue(!context.signal?.aborted, 'CANCELLED');
      if (record && !['ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(record.schemaVersion)) return unknownInspection(scope,preparation.preparationId,'evidence_protocol_version_outdated',false);
      return record === null ? unknownInspection(scope,preparation.preparationId,reason,systemError) : structuredClone(record.inspection);
    }
  });
}
