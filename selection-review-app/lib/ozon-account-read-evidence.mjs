import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { assertOzonAccountReadAuthorization, assertOzonAccountReadCredential, assertOzonAccountReadReceipt,
  readOzonAccountReadTerminal, OzonAccountReadError } from './ozon-account-read-contract.mjs';
import { assertOzonDEPreflightEvidence, assertOzonDEPreflightEvidenceScope, OzonDEPreflightEvidenceError } from './ozon-de-preflight-provider.mjs';
import { sameAccountReadRouting, currentOzonAccountReadJobs, validOzonAccountReadRevisions } from './ozon-account-read-preparation.mjs';
import { createSoftwareJobResultEnvelope } from './software-job-contract.mjs';
import { OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT, OZON_INVENTORY_WRITE_ENDPOINT,
  OZON_DE_READBACK_ENDPOINTS } from './ozon-seller-api-de-adapter.mjs';
import { isOzonDEProtocolCatalog } from './ozon-de-protocol-catalog.mjs';
import { PRODUCTION_WRITE_FIELDS } from './production-authorization-preparation.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(value, code) { if (!value) throw new OzonDEPreflightEvidenceError(code); }

// Frozen historical source contracts: newer adapters cannot expand old granted method evidence.
const HISTORICAL_ACCOUNT_SOURCE_METHODS=Object.freeze({
  'ozon-de-preflight-evidence-v1':Object.freeze(['/v3/product/import','/v1/product/import/info','/v2/products/stocks',
    '/v4/product/info/attributes','/v3/product/info/list','/v5/product/info/prices','/v4/product/info/stocks','/v3/product/list']),
  'ozon-de-preflight-evidence-v2':Object.freeze(['/v3/product/import','/v1/product/import/info','/v2/products/stocks',
    '/v4/product/info/attributes','/v3/product/info/list','/v5/product/info/prices','/v2/product/info/stocks-by-warehouse/fbs'])
});

// Each production write field is unlocked by exactly the granted method that performs it. A field with no declared
// method stays absent: an unmapped write field is never claimed writable without a granted method behind it.
const WRITE_FIELD_METHODS = Object.freeze({
  create_product: OZON_PRODUCT_IMPORT_ENDPOINT, title: OZON_PRODUCT_IMPORT_ENDPOINT, description: OZON_PRODUCT_IMPORT_ENDPOINT,
  attributes: OZON_PRODUCT_IMPORT_ENDPOINT, price: OZON_PRODUCT_IMPORT_ENDPOINT, 'assets.finalUploads': OZON_PRODUCT_IMPORT_ENDPOINT,
  publish_scope: OZON_PRODUCT_IMPORT_ENDPOINT, stock: OZON_INVENTORY_WRITE_ENDPOINT
});
// Owner decision 2026-09-15: the company currency read from the account is taken as the backend price field currency;
// no second independent currency evidence is required. Currencies outside the writable set stay 'unknown' with a risk.
const WRITABLE_PRICE_CURRENCIES = Object.freeze(['CNY', 'RUB']);

// Owner decision 2026-09-16: store identity is inferred from the warehouse, never from a store number.
// The official account contract (docs/contracts/ozon-account-read-20260908.json) returns no store or seller id at all,
// so observedStoreRef stays null forever — claiming an observed store number here would be a fabricated observation.
// Fact (1), independent of this software: the scoped warehouse belongs to this store. Established by the owner's own
//   seller-backend browser session (2026-09-15) and frozen in the production binding's verification.evidenceRef, which
//   scope.bindingId + scope.configurationVersion + scope.warehouseId pin to exactly one binding row.
// Fact (2), observed here: this key reads that warehouse back (receipt step 3, id already pinned by the receipt contract).
// (1) + (2) => this key belongs to that store. Not circular: (1) comes from the owner's login, not from configuration.
const STORE_IDENTITY_VIA_WAREHOUSE = 'scoped_warehouse';

function readAccountSource(document, jobId, scope, loadCurrentReadBinding, requireLatestJob = true) {
  assertOzonDEPreflightEvidenceScope(scope);
  const candidate = document.candidates.find(value => value.id === scope.candidateId);
  const sku = candidate?.lifecycleV11?.skuPackage, authorization = sku?.productionAuthorization;
  requireValue(authorization?.authorizationId === scope.authorizationId && sku.skuPackageId === scope.skuPackageId &&
    sku.supplierSkuId === scope.supplierSkuId && authorization.sourceCandidateRevision === scope.sourceCandidateRevision, 'ACCOUNT_SOURCE_SCOPE_MISMATCH');
  requireValue(Array.isArray(document.runtime.softwareJobs) && Array.isArray(document.runtime.softwareJobAuthorizationRecords) &&
    Array.isArray(document.runtime.softwareJobCredentialBindings), 'ACCOUNT_SOURCE_REPOSITORY_INVALID');
  const matches = document.runtime.softwareJobs.filter(value => value.jobId === jobId);
  requireValue(matches.length === 1 && matches[0].jobType === 'ozon_account_read', 'ACCOUNT_SOURCE_JOB_INVALID');
  const job = matches[0], receipt = document.runtime.ozonAccountReadReceipts?.[jobId];
  assertOzonAccountReadReceipt(receipt, job);
  const terminal = readOzonAccountReadTerminal(receipt, job), source = receipt.scope;
  requireValue(terminal.status === 'completed' && job.status === 'completed', 'ACCOUNT_SOURCE_NOT_COMPLETED');
  const expectedResult = createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId, payloadKind: 'ozon_account_read',
    payload: { schemaVersion: 'ozon-account-read-job-result-v1', receiptRef: receipt.receiptId, scopeFingerprint: source.inputFingerprint },
    recordedAt: receipt.completedAt });
  requireValue(terminal.status === 'completed' && terminal.externalRequestState === 'succeeded' && job.status === 'completed' &&
    job.externalRequestState === 'succeeded' && job.resultRef === receipt.receiptId && isDeepStrictEqual(job.resultEnvelope, expectedResult) &&
    source.candidateId === scope.candidateId && source.skuPackageId === scope.skuPackageId &&
    source.supplierSkuId === scope.supplierSkuId && validOzonAccountReadRevisions({ document, candidate }).includes(source.sourceRevision) &&
    ['storeRef', 'warehouseRef', 'warehouseId', 'credentialAlias', 'bindingId', 'configurationVersion'].every(field => isDeepStrictEqual(source[field], scope[field])), 'ACCOUNT_SOURCE_SCOPE_MISMATCH');
  const permissions = document.runtime.softwareJobAuthorizationRecords.filter(value => value.authorizationId === source.authorizationRef);
  requireValue(permissions.length === 1, 'ACCOUNT_SOURCE_AUTHORIZATION_INVALID');
  const permission = assertOzonAccountReadAuthorization(permissions[0]);
  requireValue(permission.useCount === 1 && permission.consumedByJobId === job.jobId && isDeepStrictEqual(permission.scopeBinding, source) &&
    permission.authorizedByUserId === job.ownerUserId && permission.authorizedByUserId === job.requestedByUserId &&
    Date.parse(permission.authorizedAt) <= Date.parse(receipt.startedAt) && Date.parse(receipt.completedAt) < Date.parse(permission.expiresAt), 'ACCOUNT_SOURCE_AUTHORIZATION_INVALID');
  const credentials = document.runtime.softwareJobCredentialBindings.filter(value => value.sideEffectScope === 'ozon_account_read' &&
    value.scopeBinding?.authorizationRef === source.authorizationRef);
  requireValue(credentials.length === 1, 'ACCOUNT_SOURCE_CREDENTIAL_INVALID');
  const credential = assertOzonAccountReadCredential(credentials[0]);
  requireValue(isDeepStrictEqual(credential.scopeBinding, source) && credential.allowedWorkerIds.includes(job.workerId) &&
    Date.parse(credential.boundAt) <= Date.parse(receipt.startedAt) && Date.parse(receipt.completedAt) < Date.parse(credential.expiresAt), 'ACCOUNT_SOURCE_CREDENTIAL_INVALID');
  const currentBinding = loadCurrentReadBinding({ document, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    bindingId: source.bindingId, configurationVersion: source.configurationVersion, checkedAt: receipt.completedAt });
  requireValue(currentBinding !== null && sameAccountReadRouting(source, currentBinding), 'ACCOUNT_SOURCE_CONFIGURATION_CHANGED');
  const currentJobs = currentOzonAccountReadJobs({ document, candidate, binding: currentBinding });
  requireValue(!requireLatestJob || currentJobs[0]?.jobId === job.jobId, 'ACCOUNT_SOURCE_SUPERSEDED');
  return { receipt, authorization };
}

/** Only facts established by these three official methods are promoted: granted methods from roles, the company currency
 * from seller_info, and the single scoped warehouse from warehouse_list. Other evidence remains explicitly absent.
 * The store identity is the one inferred conclusion: no store number is observed (none exists to observe), so it is
 * derived from the warehouse check — see STORE_IDENTITY_VIA_WAREHOUSE above for the two facts it rests on. */
export function composeOzonAccountPreflightEvidence({ scope, receipt, authorization, schemaVersion = 'ozon-de-preflight-evidence-v3', protocolCatalog = null }) {
  requireValue(['ozon-de-preflight-evidence-v1','ozon-de-preflight-evidence-v2','ozon-de-preflight-evidence-v3','ozon-de-preflight-evidence-v4'].includes(schemaVersion), 'RECORD_INVALID');
  const connectedProtocol = schemaVersion === 'ozon-de-preflight-evidence-v4';
  requireValue(!connectedProtocol || isOzonDEProtocolCatalog(protocolCatalog), 'PROTOCOL_CATALOG_UNAVAILABLE');
  const historical = schemaVersion === 'ozon-de-preflight-evidence-v1';
  requireValue(receipt.steps.length === 3, 'RECORD_INVALID');
  const roles = receipt.steps[0].result.facts, seller = receipt.steps[1].result.facts, warehouse = receipt.steps[2].result.facts;
  const availableMethods = new Set(roles.roles.flatMap(role => role.methods));
  const platformWritableFields = PRODUCTION_WRITE_FIELDS.filter(field => availableMethods.has(WRITE_FIELD_METHODS[field]));
  const companyCurrency = seller.companyCurrency;
  const priceFieldCurrency = WRITABLE_PRICE_CURRENCIES.includes(companyCurrency) ? companyCurrency : 'unknown';
  // Three-way: usable facts that match the scope establish identity, usable facts that disagree refute it,
  // and absent facts establish nothing. Only the middle case is reachable through a completed receipt today —
  // the receipt contract already pins the scoped id — so the other two branches are deliberately defensive.
  const warehouseFactsAvailable = Array.isArray(warehouse?.warehouses) && typeof warehouse?.hasNext === 'boolean';
  const observedWarehouses = warehouseFactsAvailable ? warehouse.warehouses : [];
  const observed = observedWarehouses.length === 1 ? observedWarehouses[0] : null;
  const warehouseVerified = warehouseFactsAvailable && warehouse.hasNext === false && observed !== null &&
    observed.warehouseId === scope.warehouseId;
  const warehouseMismatch = !warehouseVerified;
  const storeIdentityStatus = !warehouseFactsAvailable ? 'unverified' : warehouseVerified ? 'matched' : 'mismatched';
  const neededMethods = Object.hasOwn(HISTORICAL_ACCOUNT_SOURCE_METHODS,schemaVersion) ? HISTORICAL_ACCOUNT_SOURCE_METHODS[schemaVersion]
    : [...new Set([OZON_PRODUCT_IMPORT_ENDPOINT,OZON_PRODUCT_IMPORT_INFO_ENDPOINT,OZON_INVENTORY_WRITE_ENDPOINT,...Object.values(OZON_DE_READBACK_ENDPOINTS)])];
  const missingMethod = neededMethods.some(method => !availableMethods.has(method));
  const evidenceRef = receipt.receiptId;
  const expiresAt = Date.parse(roles.expiresAt) < Date.parse(receipt.scope.expiresAt) ? roles.expiresAt : receipt.scope.expiresAt;
  const body = {
    schemaVersion,
    scope: structuredClone(scope), collectedAt: receipt.steps.at(-1).result.observedAt, expiresAt,
    provenance: { sourceKind: 'controlled_platform_verification', readAuthorizationRef: receipt.scope.authorizationRef,
      softwareJobRef: receipt.jobId, officialContractRefs: Object.values(receipt.scope.officialContractRefs) },
    inspection: {
      // Never observed: the account contract has no store number to observe. The conclusion below is inferred.
      observedStore: scope.storeRef.stableStoreId, observedStoreRef: null, storeIdentityStatus,
      storeIdentityVia: warehouseFactsAvailable ? STORE_IDENTITY_VIA_WAREHOUSE : 'none',
      storeIdentityEvidenceRef: warehouseFactsAvailable ? `${evidenceRef}:warehouse-list:${scope.warehouseId}`
        : `${evidenceRef}:store-identity-not-provided`,
      permissionStatus: missingMethod ? 'denied' : 'verified', permissionEvidenceRef: `${evidenceRef}:roles`,
      connections: {
        api: { status: 'connected', checkedVia: 'controlled_account_read', evidenceRef },
        sellerBackend: { status: 'unknown', checkedVia: 'not_checked', evidenceRef: `${evidenceRef}:backend-not-checked` }
      },
      platformWritableFields, imagePermissionStatus: 'unknown', imagePermissionEvidenceRef: `${evidenceRef}:image-protocol-missing`,
      priceFieldCurrency, priceCurrencyEvidenceRef: `${evidenceRef}:seller-info`,
      risks: [
        ...(missingMethod ? [{ code: 'account_method_permissions_incomplete', message: '当前方法权限未完整覆盖生产与独立回读所需接口。' }] : []),
        // Stays on every record, matched included: the platform never returned a store number, and the record must
        // never read as if one had been observed.
        { code: 'account_store_identity_not_provided', message: '账户接口未返回店铺编号，本记录的店铺身份不是观测到的编号。' },
        ...(storeIdentityStatus === 'matched'
          ? [{ code: 'account_store_identity_from_scoped_warehouse', message: '主人2026-09-16决定：店铺身份由仓库反推——本密钥读回了本生产范围的仓库，该仓库属于本店由主人2026-09-15卖家后台会话核验，见本范围生产绑定的verification.evidenceRef。' }] : []),
        { code: 'account_price_currency_from_company_currency', message: '主人2026-09-15决定：账户读取的公司币种即后台价格字段币种，不再要求另一份独立证据。' },
        ...(priceFieldCurrency === 'unknown'
          ? [{ code: 'account_price_currency_unsupported', message: `账户公司币种${companyCurrency ?? '缺失'}不在当前可写入币种范围内，价格字段币种按未知保存。` }] : []),
        ...(!warehouseFactsAvailable ? [{ code: 'account_warehouse_facts_unavailable', message: '账户读取未取得可用的仓库事实，店铺身份无法反推，按未核验保存。' }] : []),
        ...(warehouseFactsAvailable && warehouseMismatch ? [{ code: 'account_warehouse_scope_mismatch', message: '账户读取观测到的仓库与当前生产范围的仓库编号不一致。' }] : []),
        ...(!warehouseMismatch && observed.isRfbs !== true
          ? [{ code: 'account_warehouse_not_rfbs', message: '观测仓库未标记为realFBS，当前库存写入路线以该仓库为准。' }] : []),
        ...(!warehouseMismatch && observed.pauseAt !== null
          ? [{ code: 'account_warehouse_paused', message: '观测仓库带有暂停时间，库存写入可能不被接受。' }] : []),
        ...(historical ? [{ code: 'account_seller_backend_not_checked', message: '卖家后台连接尚未经过获准的独立核验。' }] : []),
        { code: 'account_write_protocols_missing', message: '商品导入、图片、库存与独立回读协议仍需适用证据。' }
      ]
    },
    protocols: { productImport: null, inventoryWrite: null, independentReadback: null }
  };
  if (connectedProtocol) {
    const rules = protocolCatalog.compose({ scope, availableMethods });
    body.provenance.officialContractRefs.push(...rules.officialContractRefs);
    body.inspection.imagePermissionStatus = rules.imagePermissionStatus;
    body.inspection.imagePermissionEvidenceRef = rules.imageProtocolRef;
    body.inspection.risks = body.inspection.risks.filter(risk => risk.code !== 'account_write_protocols_missing').concat(rules.risks);
    body.protocols = rules.protocols;
  }
  // The id covers the content, not just the coordinates. Without this, editing this composer would leave the id
  // unchanged while the content moved: verifySnapshot would report ACCOUNT_SOURCE_CONTENT_MISMATCH on old records
  // and republishing the same receipt would hit EVIDENCE_VERSION_CONFLICT, blocking both ways out.
  const record = { evidenceId: `ozon-account-preflight:${fingerprintCanonicalRecord({ authorizationId: authorization.authorizationId,
    receiptId: receipt.receiptId, schemaVersion, contentFingerprint: fingerprintCanonicalRecord(body) })}`, ...body };
  return assertOzonDEPreflightEvidence(record);
}

/** Local repository adapter. No account requests, imported verified claims, or new business permissions. */
export function createOzonAccountReadEvidenceSource({ repository, loadCurrentReadBinding, protocolCatalog = null }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof loadCurrentReadBinding !== 'function' || (protocolCatalog !== null && !isOzonDEProtocolCatalog(protocolCatalog))) throw new OzonAccountReadError('DEPENDENCY_INVALID');
  const reconstruct = (document, record, scope, requireLatestJob = true) => {
    const source = readAccountSource(document, record.provenance.softwareJobRef, scope, loadCurrentReadBinding, requireLatestJob);
    return composeOzonAccountPreflightEvidence({ scope, ...source, schemaVersion: record.schemaVersion, protocolCatalog });
  };
  function verifyRecord(document, record, scope, requireLatestJob) {
    let rebuilt;
    try { rebuilt = reconstruct(document, record, scope, requireLatestJob); }
    catch (error) {
      if (error instanceof OzonAccountReadError) throw new OzonDEPreflightEvidenceError('ACCOUNT_SOURCE_INVALID');
      throw error;
    }
    requireValue(isDeepStrictEqual(record, rebuilt), 'ACCOUNT_SOURCE_CONTENT_MISMATCH');
    return rebuilt;
  }
  function prospective({ document, scope, jobId }) {
    try {
      const source = readAccountSource(document, jobId, scope, loadCurrentReadBinding);
      return composeOzonAccountPreflightEvidence({ scope, ...source, protocolCatalog,
        schemaVersion: protocolCatalog === null ? 'ozon-de-preflight-evidence-v3' : 'ozon-de-preflight-evidence-v4' });
    } catch (error) {
      if (error instanceof OzonAccountReadError) throw new OzonDEPreflightEvidenceError('ACCOUNT_SOURCE_INVALID');
      throw error;
    }
  }
  return Object.freeze({
    prospective,
    verifySnapshot(document, record, scope) { return verifyRecord(document, record, scope, true); },
    verifyHistoricalSnapshot(document, record, scope) { return verifyRecord(document, record, scope, false); },
    async verifySourceReceipt(record, scope) {
      const document = await repository.readSnapshot();
      const rebuilt = verifyRecord(document, record, scope, true);
      return { status: 'verified', evidenceId: rebuilt.evidenceId, scope: structuredClone(scope), collectedAt: rebuilt.collectedAt,
        expiresAt: rebuilt.expiresAt, readAuthorizationRef: rebuilt.provenance.readAuthorizationRef,
        softwareJobRef: rebuilt.provenance.softwareJobRef, officialContractRefs: rebuilt.provenance.officialContractRefs };
    },
    async publish({ scope, jobId }) {
      return repository.transact(document => {
        const record = prospective({ document, scope, jobId });
        const runtime = document.runtime;
        if (!Object.hasOwn(runtime, 'ozonDEPreflightEvidence')) runtime.ozonDEPreflightEvidence = {};
        if (!Object.hasOwn(runtime, 'ozonDEPreflightEvidenceVersions')) runtime.ozonDEPreflightEvidenceVersions = {};
        requireValue(object(runtime.ozonDEPreflightEvidence) && object(runtime.ozonDEPreflightEvidenceVersions), 'REPOSITORY_INVALID');
        const old = runtime.ozonDEPreflightEvidence[scope.authorizationId];
        if (old) verifyRecord(document, old, scope, false);
        if (old && isDeepStrictEqual(old, record)) return { changed: false, result: { status: 'unchanged', evidenceId: record.evidenceId } };
        const history = runtime.ozonDEPreflightEvidenceVersions[scope.authorizationId];
        requireValue(history === undefined || Array.isArray(history), 'REPOSITORY_INVALID');
        const versions = history === undefined ? (old ? [assertOzonDEPreflightEvidence(old)] : []) : history;
        requireValue(!versions.some(value => value.evidenceId === record.evidenceId), 'EVIDENCE_VERSION_CONFLICT');
        runtime.ozonDEPreflightEvidenceVersions[scope.authorizationId] = [...versions, record];
        runtime.ozonDEPreflightEvidence[scope.authorizationId] = record;
        return { changed: true, document, result: { status: 'published', evidenceId: record.evidenceId } };
      });
    }
  });
}
