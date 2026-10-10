import { assertDProductionJobReference, currentDProductionRound } from './d-e-software-job-handoff.mjs';
import { isDeepStrictEqual } from 'node:util';
import { sameStoreRef, isCompleteStoreRef } from './store-binding.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { assertOzonAccountReadBinding, OzonAccountReadError } from './ozon-account-read-contract.mjs';

export const OZON_ACCOUNT_OFFICIAL_CONTRACT_REFS = Object.freeze({
  roles: 'ozon-account-contract:20260908:roles',
  seller_info: 'ozon-account-contract:20260908:seller-info',
  warehouse_list: 'ozon-account-contract:20260908:warehouse-list'
});

/** Routing only. Fingerprints detect configuration drift; they do not authenticate platform evidence. */
export function accountReadBindingForProduction(configuration, production) {
  if (production.platform !== 'ozon') return null;
  const credentials = configuration.ozonDECredentialBindings.filter(value => value.credentialAlias === production.credentialAlias);
  if (credentials.length === 0) return null;
  if (credentials.length !== 1) throw new OzonAccountReadError('CREDENTIAL_CONFIGURATION_AMBIGUOUS');
  const clientIdRef = `ozon-client-configuration:${fingerprintCanonicalRecord(credentials[0])}`;
  const fields = {
    bindingId: production.bindingId, configurationVersion: production.configurationVersion,
    platform: 'ozon', storeRef: structuredClone(production.storeRef), warehouseRef: production.warehouseRef,
    warehouseId: production.warehouseId, credentialAlias: production.credentialAlias, clientIdRef,
    officialContractRefs: { ...OZON_ACCOUNT_OFFICIAL_CONTRACT_REFS }
  };
  return assertOzonAccountReadBinding({ ...fields, scopeRef: `ozon-account-read-scope:${fingerprintCanonicalRecord(fields)}` });
}

function candidateBindings(candidate, configuration) {
  const sku = candidate.lifecycleV11?.skuPackage;
  if (!sku || candidate.targetPlatform !== 'ozon' || sku.targetPlatform !== 'ozon' ||
      sku.targetStore !== candidate.targetStore || !isCompleteStoreRef(candidate.storeRef, candidate.targetStore)) return [];
  const authorization = sku.productionAuthorization;
  return configuration.productionBindings.filter(binding => binding.platform === 'ozon' && sameStoreRef(binding.storeRef, candidate.storeRef) &&
    (!authorization || binding.bindingId === authorization.executionBinding.bindingId &&
      binding.configurationVersion === authorization.executionBinding.configurationVersion &&
      binding.warehouseRef === authorization.lockedScope.warehouseRef && binding.warehouseId === authorization.executionBinding.warehouseId &&
      binding.credentialAlias === authorization.lockedScope.credentialAlias));
}

export function createOzonAccountReadBindingResolver(configuration) {
  return function loadCurrentReadBinding({ document, candidateId, skuPackageId, bindingId, configurationVersion }) {
    const candidate = document.candidates.find(value => value.id === candidateId);
    if (!candidate || candidate.lifecycleV11?.skuPackage?.skuPackageId !== skuPackageId) throw new OzonAccountReadError('CANDIDATE_CHANGED');
    const matches = candidateBindings(candidate, configuration).filter(binding =>
      binding.bindingId === bindingId && binding.configurationVersion === configurationVersion);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new OzonAccountReadError('BINDING_AMBIGUOUS');
    return accountReadBindingForProduction(configuration, matches[0]);
  };
}

/** The owner sees account routing and the bounded action before any permission is saved. */
export function buildOzonAccountReadPreparation({ candidate, configuration, runtimeView }) {
  if (!candidate.lifecycleV11?.skuPackage || candidate.targetPlatform !== 'ozon') return null;
  const options = candidateBindings(candidate, configuration).map(production => {
    const binding = accountReadBindingForProduction(configuration, production);
    if (binding === null) return null;
    const service = configuration.ozonAccountReadServiceBindings.find(value => value.productionBindingId === binding.bindingId &&
      value.productionConfigurationVersion === binding.configurationVersion);
    if (!service) return null;
    const credential = configuration.ozonDECredentialBindings.find(value => value.credentialAlias === binding.credentialAlias);
    return { bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, scopeRef: binding.scopeRef,
      storeName: production.storeName, warehouseName: production.warehouseName, warehouseId: binding.warehouseId,
      clientId: credential.clientId, credentialAlias: binding.credentialAlias };
  }).filter(value => value !== null);
  return { schemaVersion: 'ozon-account-read-preparation-v1', candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: candidate.dataRevision,
    options, runtime: runtimeView, maxRequests: 3, platformWrites: 0,
    message: options.length ? '核验本件商品的账户权限、公司币种和指定仓库，每项读取一次。'
      : '尚未配置本件商品的准确账户、仓库及读取服务。配置齐备后才能显示读取确认。' };
}

export function sameAccountReadRouting(left, right) {
  return ['storeRef', 'warehouseRef', 'warehouseId', 'credentialAlias', 'clientIdRef', 'bindingId', 'configurationVersion', 'officialContractRefs', 'scopeRef']
    .every(field => isDeepStrictEqual(left[field], right[field]));
}

/** Technical progress must not discard the account read made for this immutable production handoff. */
export function validOzonAccountReadRevisions({ document, candidate }) {
  const sku = candidate.lifecycleV11.skuPackage, authorization = sku.productionAuthorization;
  const revisions = [candidate.dataRevision, authorization?.sourceCandidateRevision];
  if (!authorization || !sku.dHandoff?.softwareJobRef) return revisions;
  const job = currentDProductionRound(document, { authorizationRef: authorization.authorizationId,
    authorizationFingerprint: fingerprintCanonicalRecord(authorization) });
  try { assertDProductionJobReference({ document, candidate, job }); }
  catch (error) {
    if (error?.constructor === Error && error.message === 'D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT') throw new OzonAccountReadError('PRODUCTION_HANDOFF_INVALID');
    throw error;
  }
  if (job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId ||
      job.revision !== authorization.resultCandidateRevision || job.scopeBinding.sourceRevision !== authorization.sourceCandidateRevision ||
      job.scopeBinding.resultRevision !== job.revision || !isDeepStrictEqual(job.scopeBinding.identity, authorization.sourceIdentity) ||
      !isDeepStrictEqual(job.scopeBinding.productionBinding, authorization.executionBinding)) throw new OzonAccountReadError('PRODUCTION_HANDOFF_INVALID');
  return [...new Set([...revisions, job.revision])];
}

/** A later attempt supersedes earlier evidence even when the later attempt failed. */
export function currentOzonAccountReadJobs({ document, candidate, binding }) {
  const jobs = document.runtime.softwareJobs === undefined ? [] : document.runtime.softwareJobs;
  if (!Array.isArray(jobs)) throw new OzonAccountReadError('REPOSITORY_INVALID');
  const sku = candidate.lifecycleV11.skuPackage;
  const revisions = validOzonAccountReadRevisions({ document, candidate });
  const matches = jobs.filter(job => job.jobType === 'ozon_account_read' && job.candidateId === candidate.id &&
    job.skuPackageId === sku.skuPackageId && job.scopeBinding.supplierSkuId === sku.supplierSkuId &&
    revisions.includes(job.revision) && sameAccountReadRouting(job.scopeBinding, binding))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (matches.length > 1 && matches[0].createdAt === matches[1].createdAt) throw new OzonAccountReadError('SOURCE_AMBIGUOUS');
  return matches;
}
