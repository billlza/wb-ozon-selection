import path from "node:path";
import { DEFAULT_GUOO_TARIFF_PATH, guooTariffRuleVersionFromPath } from "./guoo-tariff-reader.mjs";
import { STORE_PLATFORMS, isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets, isCanonicalFrozenRef, isOpaqueProductionSourceRef } from "./production-contract-primitives.mjs";
import { isProductionExecutionBinding } from "./production-authorization-preparation.mjs";
import { normalizeOzonDECredentialBindings, assertOzonAccountDiscoveryBindings } from "./ozon-de-http-configuration.mjs";
import { normalizeAliyunOssRuntimeConfiguration } from "./aliyun-oss-runtime-configuration.mjs";
import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { assertLinkfoxDiscoveryBinding } from './linkfox-discovery-connector.mjs';
import { assertLinkfoxProductDetailBinding } from './linkfox-product-detail-connector.mjs';
import { assertSeerfarDiscoveryBinding, normalizeSeerfarDiscoveryEvidenceRecords } from './seerfar-discovery-contract.mjs';
import { assertADiscoveryPlan } from './a-discovery-contract.mjs';
import { normalizeLinkfoxDiscoveryCredentialBindings } from './linkfox-discovery-credentials.mjs';

export function normalizeDPlatformObservationConfiguration(input,productionBindings) {
  // defaults 是 r70 新增的**可选**键：没有它的旧配置照常加载，不判无效。
  if(!exactConfigurationKeys(input,['policies','pumpIntervalMs'])&&
     !exactConfigurationKeys(input,['policies','pumpIntervalMs','defaults']))throw new Error('D_OBSERVATION_CONFIGURATION_INVALID');
  const {policies,pumpIntervalMs}=input;
  const defaultsInput=Object.hasOwn(input,'defaults')?input.defaults:[];
  if(!Array.isArray(policies)||policies.length>100||pumpIntervalMs!==null&&
    (!Number.isSafeInteger(pumpIntervalMs)||pumpIntervalMs<1||pumpIntervalMs>2147483647))throw new Error('D_OBSERVATION_CONFIGURATION_INVALID');
  if(policies.length>0&&pumpIntervalMs===null)throw new Error('D_OBSERVATION_PUMP_CONFIGURATION_REQUIRED');
  const keys=new Set();
  const normalized=policies.map(entry=>{
    const refs=['candidateId','skuPackageId','authorizationRef','productionBindingId','productionConfigurationVersion'];
    if(!exactConfigurationKeys(entry,[...refs,'revision','policy'])||!refs.every(field=>field==='authorizationRef'?isOpaqueProductionSourceRef(entry[field]):isCanonicalFrozenRef(entry[field]))||
      !Number.isSafeInteger(entry.revision)||entry.revision<0)throw new Error('D_OBSERVATION_CONFIGURATION_INVALID');
    assertDPlatformObservationPolicy(entry.policy);
    if(!productionBindings.some(binding=>binding.bindingId===entry.productionBindingId&&binding.configurationVersion===entry.productionConfigurationVersion&&binding.platform==='ozon'))throw new Error('D_OBSERVATION_CONFIGURATION_BINDING_CONFLICT');
    const key=JSON.stringify(refs.map(field=>entry[field]).concat(entry.revision));
    if(keys.has(key))throw new Error('D_OBSERVATION_CONFIGURATION_AMBIGUOUS');
    keys.add(key);
    return Object.freeze({...structuredClone(entry),policy:Object.freeze(structuredClone(entry.policy))});
  });
  // 店铺级默认策略：按「生产绑定 + 配置版本」匹配，不钉候选与 SKU。
  // 这样上一个新品不必先改 plist、重启服务才能上架（r69 严格门的代价，见 r69 卡 3.3）。
  // 逐条仍要求绑定存在且为 ozon；同一绑定下只允许一条默认，多条按歧义失败停。
  if(!Array.isArray(defaultsInput)||defaultsInput.length>20)throw new Error('D_OBSERVATION_CONFIGURATION_INVALID');
  if(defaultsInput.length>0&&pumpIntervalMs===null)throw new Error('D_OBSERVATION_PUMP_CONFIGURATION_REQUIRED');
  const defaultKeys=new Set();
  const normalizedDefaults=defaultsInput.map(entry=>{
    const refs=['productionBindingId','productionConfigurationVersion'];
    if(!exactConfigurationKeys(entry,[...refs,'policy'])||!refs.every(field=>isCanonicalFrozenRef(entry[field])))
      throw new Error('D_OBSERVATION_CONFIGURATION_INVALID');
    assertDPlatformObservationPolicy(entry.policy);
    if(!productionBindings.some(binding=>binding.bindingId===entry.productionBindingId&&
      binding.configurationVersion===entry.productionConfigurationVersion&&binding.platform==='ozon'))
      throw new Error('D_OBSERVATION_CONFIGURATION_BINDING_CONFLICT');
    const key=JSON.stringify(refs.map(field=>entry[field]));
    if(defaultKeys.has(key))throw new Error('D_OBSERVATION_CONFIGURATION_AMBIGUOUS');
    defaultKeys.add(key);
    return Object.freeze({...structuredClone(entry),policy:Object.freeze(structuredClone(entry.policy))});
  });
  return Object.freeze({policies:Object.freeze(normalized),pumpIntervalMs,
    defaults:Object.freeze(normalizedDefaults)});
}

/**
 * 有限只读查询策略是技术容量配置（查几次、隔多久、单次多久超时、整体多久过期），不是授权。
 * 因此它按「哪个商品的哪个 SKU、发到哪个仓库绑定」匹配，不跟着授权版本和候选 revision 走：
 * 原来钉死 revision 和 authorizationRef，只要重签一版授权就再也匹配不上，
 * 而策略取不到时导入被接受后不会排观察作业 —— 商品发出去了、没人查审核、库存永远不写。
 * 条目里仍保留 revision 与 authorizationRef 作为配置时的上下文记录，只是不参与匹配；
 * 时间边界仍由 policy.expiresAt 兜住，同一绑定下出现多条仍然按歧义失败停。
 */
export function createDPlatformObservationPolicyResolver(configuration) {
  return function loadDPlatformObservationPolicy({candidate,job}) {
    const matches=configuration.dPlatformObservation.policies.filter(entry=>entry.candidateId===candidate.id&&
      entry.skuPackageId===job.skuPackageId&&
      entry.productionBindingId===job.scopeBinding.productionBinding.bindingId&&entry.productionConfigurationVersion===job.scopeBinding.productionBinding.configurationVersion);
    if(matches.length>1)throw new Error('D_OBSERVATION_CONFIGURATION_AMBIGUOUS');
    if(matches.length===1)return structuredClone(matches[0].policy);
    // 没有按品配置时退到店铺级默认。**逐品配置优先**——想给某个品特殊窗口，配一条就能盖过默认。
    const fallback=(configuration.dPlatformObservation.defaults??[]).filter(entry=>
      entry.productionBindingId===job.scopeBinding.productionBinding.bindingId&&
      entry.productionConfigurationVersion===job.scopeBinding.productionBinding.configurationVersion);
    if(fallback.length>1)throw new Error('D_OBSERVATION_CONFIGURATION_AMBIGUOUS');
    return fallback.length===0?null:structuredClone(fallback[0].policy);
  };
}

export function isRuntimeConfigurationTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Both lexical configuration and resolved filesystem paths use this isolation rule. */
export function isOwnerCredentialPathIsolated(credentialFile, protectedPaths) {
  const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
  const privateDirectory = path.dirname(credentialFile);
  return !protectedPaths.some(protectedPath => contains(protectedPath, credentialFile) || contains(privateDirectory, protectedPath));
}

export function isConfiguredProductionReference(value) {
  return isCanonicalFrozenRef(value) && !["unknown", "null", "undefined", "not_applicable"].includes(value.toLowerCase());
}

function exactConfigurationKeys(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

/** Saved configuration declarations only; loading them never probes a store or resolves a secret. */
export function normalizeProductionBindings(bindings, storeBindings) {
  const invalid = () => new Error("PRODUCTION_BINDINGS_INVALID: 生产绑定必须明确店铺、仓库、凭据别名、版本及核验声明");
  if (!Array.isArray(bindings) || bindings.length > 100 || !Array.isArray(storeBindings)) throw invalid();
  const currentStoreBindings = normalizeStoreBindings(storeBindings);
  const fields = ["bindingId", "configurationVersion", "platform", "storeRef", "storeName", "warehouseName", "warehouseRef", "warehouseId", "credentialAlias", "verification"];
  const ids = new Set();
  const warehouseRefs = new Set();
  const warehouseIds = new Set();
  const storeNames = new Map();
  return Object.freeze(bindings.map(binding => {
    if (!exactConfigurationKeys(binding, fields) ||
        !["bindingId", "configurationVersion", "warehouseRef", "credentialAlias"].every(field => isConfiguredProductionReference(binding[field])) ||
        !["storeName", "warehouseName"].every(field => typeof binding[field] === "string" && binding[field] === binding[field].trim() &&
          binding[field].length <= 100 && /\p{Script=Han}/u.test(binding[field]) && !/[\x00-\x1f\x7f]/.test(binding[field])) ||
        !isProductionExecutionBinding({ bindingId: binding.bindingId, configurationVersion: binding.configurationVersion, warehouseId: binding.warehouseId }) ||
        !exactConfigurationKeys(binding.verification, ["evidenceRef", "checkedAt", "expiresAt"]) ||
        !isConfiguredProductionReference(binding.verification.evidenceRef) ||
        !isRuntimeConfigurationTimestamp(binding.verification.checkedAt) || !isRuntimeConfigurationTimestamp(binding.verification.expiresAt) ||
        Date.parse(binding.verification.checkedAt) >= Date.parse(binding.verification.expiresAt) ||
        !currentStoreBindings.some(store => store.platform === binding.platform && sameStoreRef(store.storeRef, binding.storeRef))) throw invalid();
    assertNoProductionSecrets(binding, "productionBinding");
    const storeKey = JSON.stringify([binding.platform, binding.storeRef.platformStoreId]);
    const warehouseKey = JSON.stringify([storeKey, binding.warehouseRef]);
    const warehouseIdKey = JSON.stringify([storeKey, binding.warehouseId]);
    if (ids.has(binding.bindingId) || warehouseRefs.has(warehouseKey) || warehouseIds.has(warehouseIdKey) ||
        (storeNames.has(storeKey) && storeNames.get(storeKey) !== binding.storeName)) throw invalid();
    ids.add(binding.bindingId); warehouseRefs.add(warehouseKey); warehouseIds.add(warehouseIdKey); storeNames.set(storeKey, binding.storeName);
    return Object.freeze({ ...binding, storeRef: Object.freeze({ ...binding.storeRef }), verification: Object.freeze({ ...binding.verification }) });
  }));
}

/** Routing declarations against normalized production bindings; no credential or service-health probe. */
export function normalizeDEServiceBindings(bindings, productionBindings) {
  return normalizeStoreServiceBindings(bindings, productionBindings, "d-e-service-binding-v1", "DE_SERVICE_CONFIGURATION_INVALID");
}

export function normalizeOzonAccountReadServiceBindings(bindings, productionBindings) {
  return normalizeStoreServiceBindings(bindings, productionBindings, "ozon-account-read-service-binding-v1", "OZON_ACCOUNT_READ_SERVICE_CONFIGURATION_INVALID");
}

function normalizeStoreServiceBindings(bindings, productionBindings, schemaVersion, errorCode) {
  const invalid = () => new Error(`${errorCode}: 服务必须明确唯一服务、生产绑定及版本、Worker及版本和有效租约时长`);
  if (!Array.isArray(bindings) || bindings.length > 100 || !Array.isArray(productionBindings) || productionBindings.length > 100) throw invalid();
  const fields = ["schemaVersion", "serviceId", "configurationVersion", "productionBindingId", "productionConfigurationVersion", "workerId", "workerVersion", "leaseDurationMs"];
  const services = new Set(), workers = new Set(), productionIds = new Set();
  return Object.freeze(bindings.map(binding => {
    if (!exactConfigurationKeys(binding, fields) || binding.schemaVersion !== schemaVersion ||
        !["serviceId", "configurationVersion", "productionBindingId", "productionConfigurationVersion", "workerId", "workerVersion"]
          .every(field => isConfiguredProductionReference(binding[field])) ||
        !Number.isInteger(binding.leaseDurationMs) || binding.leaseDurationMs < 1_000 || binding.leaseDurationMs > 1_800_000 ||
        services.has(binding.serviceId) || workers.has(binding.workerId) || productionIds.has(binding.productionBindingId)) throw invalid();
    const matches = productionBindings.filter(production => production?.bindingId === binding.productionBindingId);
    if (matches.length !== 1 || matches[0].platform !== "ozon" || matches[0].configurationVersion !== binding.productionConfigurationVersion) throw invalid();
    services.add(binding.serviceId); workers.add(binding.workerId); productionIds.add(binding.productionBindingId);
    return Object.freeze({ ...binding });
  }));
}

export function normalizeStoreBindings(bindings) {
  if (!Array.isArray(bindings)) throw new Error("STORE_BINDINGS_INVALID: 店铺映射必须是数组");
  const stores = new Set();
  const platformStores = new Set();
  const result = bindings.map(binding => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
        Object.keys(binding).length !== 3 || ["targetStore", "platform", "storeRef"].some(field => !Object.hasOwn(binding, field)) ||
        !Object.hasOwn(STORE_PLATFORMS, binding.targetStore) || STORE_PLATFORMS[binding.targetStore] !== binding.platform ||
        !isCompleteStoreRef(binding.storeRef, binding.targetStore) ||
        Object.values(binding.storeRef).some(value => !isCanonicalFrozenRef(value))) {
      throw new Error("STORE_BINDINGS_INVALID: 必须显式配置准确的平台、内部店铺键和完整店铺引用");
    }
    const platformKey = `${binding.platform}:${binding.storeRef.platformStoreId}`;
    if (stores.has(binding.targetStore) || platformStores.has(platformKey)) {
      throw new Error("STORE_BINDINGS_INVALID: 内部店铺或同平台店铺ID重复绑定");
    }
    stores.add(binding.targetStore);
    platformStores.add(platformKey);
    return Object.freeze({ ...binding, storeRef: Object.freeze({ ...binding.storeRef }) });
  });
  return Object.freeze(result);
}

/** Technical gateway routing only; this neither grants a paid permission nor probes credentials. */
export function normalizeC1DraftServiceBindings(bindings, deploymentMode) {
  const invalid = () => new Error("C1_DRAFT_SERVICE_CONFIGURATION_INVALID: 必须显式配置模型、网关、凭据别名和执行Worker");
  if (!RUNTIME_MODES.includes(deploymentMode) || !Array.isArray(bindings) || bindings.length > 2) throw invalid();
  const fields = ["schemaVersion", "provider", "modelVersion", "credentialAlias", "workerId", "workerVersion", "gatewayOrigin", "configurationVersion", "leaseDurationMs"];
  const providers = new Set(), workers = new Set();
  return Object.freeze(bindings.map(binding => {
    if (!exactConfigurationKeys(binding, fields) || binding.schemaVersion !== "c1-draft-service-binding-v1" ||
        !["terra", "sol"].includes(binding.provider) || binding.modelVersion !== `gpt-5.6-${binding.provider}` ||
        !["credentialAlias", "workerId", "workerVersion", "configurationVersion"].every(field => isConfiguredProductionReference(binding[field])) ||
        !Number.isInteger(binding.leaseDurationMs) || binding.leaseDurationMs < 90_000 || binding.leaseDurationMs > 1_800_000 ||
        providers.has(binding.provider) || workers.has(binding.workerId)) throw invalid();
    const gatewayOrigin = normalizeServiceOrigin(binding.gatewayOrigin, { deploymentMode, label: "c1DraftGatewayOrigin" });
    if (binding.gatewayOrigin !== gatewayOrigin && binding.gatewayOrigin !== `${gatewayOrigin}/`) throw invalid();
    providers.add(binding.provider); workers.add(binding.workerId);
    return Object.freeze({ ...binding, gatewayOrigin });
  }));
}

/** A configured worker consumes saved, separately authorized keyword jobs; configuration grants no paid access. */
export function normalizeKeywordEvidenceServiceBindings(bindings) {
  const invalid = () => new Error("C1_KEYWORD_SERVICE_CONFIGURATION_INVALID: 关键词服务必须显式配置唯一Worker、版本、租约和查询时间边界");
  if (!Array.isArray(bindings) || bindings.length > 1) throw invalid();
  const fields = ["schemaVersion", "serviceId", "configurationVersion", "provider", "workerId", "workerVersion", "leaseDurationMs", "pumpIntervalMs", "requestTimeoutMs"];
  return Object.freeze(bindings.map(binding => {
    if (!exactConfigurationKeys(binding, fields) || binding.schemaVersion !== "c1-keyword-service-binding-v1" ||
        binding.provider !== "seerfar_open_api" ||
        !["serviceId", "configurationVersion", "workerId", "workerVersion"].every(field => isConfiguredProductionReference(binding[field])) ||
        !Number.isSafeInteger(binding.leaseDurationMs) || binding.leaseDurationMs < 1_000 || binding.leaseDurationMs > 1_800_000 ||
        !Number.isSafeInteger(binding.pumpIntervalMs) || binding.pumpIntervalMs < 1 || binding.pumpIntervalMs > 2_147_483_647 ||
        !Number.isSafeInteger(binding.requestTimeoutMs) || binding.requestTimeoutMs < 1 || binding.requestTimeoutMs > 600_000) throw invalid();
    return Object.freeze({ ...binding });
  }));
}

export function assertADiscoveryConnectorBinding(binding) {
  if (binding?.provider === 'seerfar') return assertSeerfarDiscoveryBinding(binding);
  return assertLinkfoxDiscoveryBinding(binding);
}

/** Explicit provider selection and bounded workers. Configuration never grants paid access. */
export function normalizeADiscoveryServiceBindings(bindings, connectorBindings) {
  return normalizeLinkfoxReadServiceBindings(bindings, connectorBindings, {
    validateConnector:assertADiscoveryConnectorBinding,schemaVersion:'a-discovery-service-binding-v1',errorPrefix:'A_DISCOVERY'
  });
}

export function normalizeAProductDetailServiceBindings(bindings, connectorBindings) {
  return normalizeLinkfoxReadServiceBindings(bindings, connectorBindings, {
    validateConnector:assertLinkfoxProductDetailBinding,schemaVersion:'a-product-detail-service-binding-v1',errorPrefix:'A_PRODUCT_DETAIL'
  });
}

function normalizeLinkfoxReadServiceBindings(bindings, connectorBindings, {validateConnector,schemaVersion,errorPrefix}) {
  if (!Array.isArray(bindings) || bindings.length > 1 || !Array.isArray(connectorBindings)) {
    throw new Error(`${errorPrefix}_SERVICE_CONFIGURATION_INVALID`);
  }
  const connectors = connectorBindings.map(validateConnector);
  const fields = ['schemaVersion', 'serviceId', 'configurationVersion', 'connectorBindingId',
    'connectorConfigurationVersion', 'workerId', 'workerVersion', 'leaseDurationMs', 'pumpIntervalMs'];
  return Object.freeze(bindings.map(binding => {
    if (!exactConfigurationKeys(binding, fields) || binding.schemaVersion !== schemaVersion ||
        !fields.slice(1, 7).every(field => isConfiguredProductionReference(binding[field])) ||
        !Number.isSafeInteger(binding.leaseDurationMs) || binding.leaseDurationMs < 1000 || binding.leaseDurationMs > 1800000 ||
        !Number.isSafeInteger(binding.pumpIntervalMs) || binding.pumpIntervalMs < 1000 || binding.pumpIntervalMs > 2147483647) {
      throw new Error(`${errorPrefix}_SERVICE_CONFIGURATION_INVALID`);
    }
    const matches = connectors.filter(value => value.bindingId === binding.connectorBindingId &&
      value.configurationVersion === binding.connectorConfigurationVersion);
    if (matches.length !== 1 || binding.leaseDurationMs <= matches[0].timeoutMs) {
      throw new Error(`${errorPrefix}_SERVICE_CONFIGURATION_BINDING_CONFLICT`);
    }
    return Object.freeze({ ...binding });
  }));
}

function aDiscoveryConfiguration(env) {
  const read = key => {
    if (!Object.hasOwn(env, key)) return [];
    try { return JSON.parse(env[key]); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('A_DISCOVERY_CONFIGURATION_JSON_INVALID');
    }
  };
  const declared = read('SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON');
  if (!Array.isArray(declared) || declared.length > 1) throw new Error('A_DISCOVERY_CONNECTOR_CONFIGURATION_INVALID');
  const aDiscoveryConnectorBindings = Object.freeze(declared.map(value => Object.freeze(assertADiscoveryConnectorBinding(value))));
  const aDiscoveryServiceBindings = normalizeADiscoveryServiceBindings(
    read('SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON'), aDiscoveryConnectorBindings);
  const aDiscoveryCredentialBindings = normalizeLinkfoxDiscoveryCredentialBindings(
    read('SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON'));
  if (aDiscoveryConnectorBindings.some(binding => !aDiscoveryCredentialBindings.some(value => value.credentialAlias === binding.credentialAlias))) {
    throw new Error('A_DISCOVERY_CREDENTIAL_CONFIGURATION_REQUIRED');
  }
  const declaredPlans = read('SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON');
  if (!Array.isArray(declaredPlans) || declaredPlans.length > 10) throw new Error('A_DISCOVERY_PLAN_CONFIGURATION_INVALID');
  const seen = new Set();
  const aDiscoveryPlans = Object.freeze(declaredPlans.map(value => {
    const plan = assertADiscoveryPlan(value), key = JSON.stringify([plan.planId, plan.version]);
    if (seen.has(key)) throw new Error('A_DISCOVERY_PLAN_CONFIGURATION_AMBIGUOUS');
    seen.add(key);
    return Object.freeze(plan);
  }));
  const aDiscoveryEvidenceRecords = normalizeSeerfarDiscoveryEvidenceRecords(read('SELECTION_REVIEW_A_DISCOVERY_EVIDENCE_RECORDS_JSON'));
  const declaredDetails = read('SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON');
  if (!Array.isArray(declaredDetails) || declaredDetails.length > 1) throw new Error('A_PRODUCT_DETAIL_CONNECTOR_CONFIGURATION_INVALID');
  const aProductDetailConnectorBindings = Object.freeze(declaredDetails.map(value=>Object.freeze(assertLinkfoxProductDetailBinding(value))));
  const aProductDetailServiceBindings = normalizeAProductDetailServiceBindings(
    read('SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON'),aProductDetailConnectorBindings);
  const aProductDetailCredentialBindings = normalizeLinkfoxDiscoveryCredentialBindings(read('SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON'));
  if (aProductDetailConnectorBindings.some(binding=>!aProductDetailCredentialBindings.some(value=>value.credentialAlias===binding.credentialAlias))) {
    throw new Error('A_PRODUCT_DETAIL_CREDENTIAL_CONFIGURATION_REQUIRED');
  }
  return { aDiscoveryConnectorBindings, aDiscoveryServiceBindings, aDiscoveryCredentialBindings, aDiscoveryPlans, aDiscoveryEvidenceRecords,
    aProductDetailConnectorBindings,aProductDetailServiceBindings,aProductDetailCredentialBindings };
}

/** Optional local pointer to the saved Ozon official commission workbook JSON; absent means not configured. */
export function normalizeOzonCommissionReferenceConfiguration(config) {
  const invalid = () => new Error("OZON_COMMISSION_REFERENCE_CONFIGURATION_INVALID: Ozon官方佣金参考表配置必须提供绝对路径和CN卖家范围");
  if (config === null || config === undefined) return null;
  const withVersion = exactConfigurationKeys(config, ["catalogPath", "sellerRegion", "versionState"]);
  if (!(withVersion || exactConfigurationKeys(config, ["catalogPath", "sellerRegion"])) ||
      typeof config.catalogPath !== "string" || config.catalogPath !== config.catalogPath.trim() ||
      config.catalogPath === "" || config.catalogPath.includes("\0") || !path.isAbsolute(config.catalogPath) ||
      config.sellerRegion !== "CN") {
    throw invalid();
  }
  // The saved official version the reader must bind to (owner policy 2026-09-09: saved official commission version).
  let versionState = null;
  if (withVersion) {
    const state = config.versionState;
    if (!exactConfigurationKeys(state, ["fileSha256", "effectiveFrom", "status"]) || !/^[0-9a-f]{64}$/.test(String(state.fileSha256)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(state.effectiveFrom)) || !Number.isFinite(Date.parse(`${state.effectiveFrom}T00:00:00Z`)) ||
        state.status !== "active") {
      throw invalid();
    }
    versionState = Object.freeze({ fileSha256: state.fileSha256, effectiveFrom: state.effectiveFrom, status: "active" });
  }
  return Object.freeze({ catalogPath: path.resolve(config.catalogPath), sellerRegion: config.sellerRegion, versionState });
}

export const RUNTIME_MODES = Object.freeze(["local_development", "central_test", "central_production"]);
export const STATE_ADAPTERS = Object.freeze(["json", "memory", "postgres"]);

function nonEmpty(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}不能为空`);
  return normalized;
}

function port(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}无效`);
  }
  return parsed;
}

function url(value, label) {
  let parsed;
  try {
    parsed = new URL(nonEmpty(value, label));
  } catch {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}无效`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}不得包含凭据`);
  }
  return parsed;
}

function chromeExtensionOrigin(value, label) {
  const parsed = url(value, label);
  const pathSegment = parsed.pathname || "/";
  if (parsed.protocol !== "chrome-extension:" || parsed.username || parsed.password ||
      pathSegment !== "/" || parsed.search || parsed.hash ||
      !/^[a-p]{32}$/.test(parsed.hostname)) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}必须是固定Chrome扩展origin`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function booleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isLoopback(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

export function normalizeServiceOrigin(value, { deploymentMode, label = "serviceOrigin" } = {}) {
  const parsed = url(value, label);
  const mode = nonEmpty(deploymentMode, "deploymentMode");
  if (!RUNTIME_MODES.includes(mode)) throw new Error("RUNTIME_CONFIGURATION_INVALID: deploymentMode无效");
  if (mode === "local_development") {
    if (!(parsed.protocol === "http:" && isLoopback(parsed.hostname)) && parsed.protocol !== "https:") {
      throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}在本地模式只能使用回环HTTP或显式HTTPS`);
    }
  } else if (parsed.protocol !== "https:" || isLoopback(parsed.hostname)) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}在中央模式必须使用非本机HTTPS`);
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function createSelectionReviewRuntimeConfiguration({ env = process.env, appDir, argv = process.argv } = {}) {
  const resolvedAppDir = path.resolve(nonEmpty(appDir, "appDir"));
  const guooTariffFile = env.SELECTION_REVIEW_GUOO_TARIFF_FILE === undefined
    ? path.join(resolvedAppDir, "data", "logistics", path.basename(DEFAULT_GUOO_TARIFF_PATH))
    : path.resolve(nonEmpty(env.SELECTION_REVIEW_GUOO_TARIFF_FILE, "guooTariffFile"));
  const guooTariffRuleVersion = guooTariffRuleVersionFromPath(guooTariffFile);
  if (guooTariffRuleVersion !== "guoo-2026-08-19") {
    throw new Error("GUOO_TARIFF_PROJECT_VERSION_MISMATCH: 本项目新GUOO测算采用2026-08-19版，历史记录保持原版本");
  }
  let storeBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_STORE_BINDINGS_JSON")) {
    try {
      storeBindings = JSON.parse(env.SELECTION_REVIEW_STORE_BINDINGS_JSON);
    } catch {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 店铺映射必须是有效JSON，未加载配置");
    }
  }
  storeBindings = normalizeStoreBindings(storeBindings);
  let productionBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON")) {
    try {
      productionBindings = JSON.parse(env.SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON);
    } catch {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 生产绑定必须是有效JSON，未加载配置");
    }
  }
  productionBindings = normalizeProductionBindings(productionBindings, storeBindings);
  let deServiceBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON")) {
    try { deServiceBindings = JSON.parse(env.SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("DE_SERVICE_CONFIGURATION_INVALID: SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON必须是有效JSON数组，未加载配置");
    }
  }
  deServiceBindings = normalizeDEServiceBindings(deServiceBindings, productionBindings);
  let observationInput={policies:[],pumpIntervalMs:null};
  if(Object.hasOwn(env,'SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON')) {
    try { observationInput=JSON.parse(env.SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON); }
    catch(error) {if(!(error instanceof SyntaxError))throw error;throw new Error('D_OBSERVATION_CONFIGURATION_INVALID');}
    // 键集合由下一行的 normalizeDPlatformObservationConfiguration 统一校验，这里**不再重复一份**。
    // 2026-09-24 r70 部署失败就栽在这：只放宽了 normalize 里那处、漏了这里重复的一份，
    // 服务带着 defaults 启动即抛 D_OBSERVATION_CONFIGURATION_INVALID，反复重启。
    // 同一条规则不许有两份——这一轮已经是第二次上这一课。
  }
  const dPlatformObservation=normalizeDPlatformObservationConfiguration(observationInput,productionBindings);
  let eReadbackPumpIntervalMs = null;
  if (Object.hasOwn(env, "SELECTION_REVIEW_E_READBACK_PUMP_INTERVAL_MS")) {
    const value = env.SELECTION_REVIEW_E_READBACK_PUMP_INTERVAL_MS;
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
      throw new Error("E_READBACK_RUNTIME_CONFIGURATION_INVALID: E作业检查间隔必须为明确毫秒整数");
    }
    eReadbackPumpIntervalMs = Number(value);
    if (!Number.isSafeInteger(eReadbackPumpIntervalMs) || eReadbackPumpIntervalMs < 1000 || eReadbackPumpIntervalMs > 2_147_483_647) {
      throw new Error("E_READBACK_RUNTIME_CONFIGURATION_INVALID: E作业检查间隔超出支持范围");
    }
  }
  let ozonAccountReadServiceBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON")) {
    try { ozonAccountReadServiceBindings = JSON.parse(env.SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("OZON_ACCOUNT_READ_SERVICE_CONFIGURATION_INVALID: 账户读取服务必须是有效JSON数组，未加载配置");
    }
  }
  ozonAccountReadServiceBindings = normalizeOzonAccountReadServiceBindings(ozonAccountReadServiceBindings, productionBindings);
  if (ozonAccountReadServiceBindings.some(binding => deServiceBindings.some(de => de.workerId === binding.workerId))) {
    throw new Error("OZON_ACCOUNT_READ_SERVICE_CONFIGURATION_INVALID: 账户读取与生产执行必须使用各自明确的Worker身份");
  }
  let ozonAccountDiscoveryBindings = [];
  if (Object.hasOwn(env, 'SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON')) {
    try { ozonAccountDiscoveryBindings = JSON.parse(env.SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('OZON_ACCOUNT_DISCOVERY_CONFIGURATION_INVALID: 账户准备配置必须是有效JSON');
    }
  }
  assertOzonAccountDiscoveryBindings(ozonAccountDiscoveryBindings);
  ozonAccountDiscoveryBindings = Object.freeze(ozonAccountDiscoveryBindings.map(binding => Object.freeze(structuredClone(binding))));
  const occupiedWorkers = new Set([...deServiceBindings, ...ozonAccountReadServiceBindings].map(binding => binding.workerId));
  if (ozonAccountDiscoveryBindings.some(binding => occupiedWorkers.has(binding.workerId))) {
    throw new Error('OZON_ACCOUNT_DISCOVERY_CONFIGURATION_INVALID: 账户准备必须使用独立Worker');
  }
  let ozonDECredentialBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON")) {
    try { ozonDECredentialBindings = JSON.parse(env.SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("RUNTIME_CONFIGURATION_INVALID: Ozon凭据别名映射必须是有效JSON，未加载配置");
    }
  }
  ozonDECredentialBindings = normalizeOzonDECredentialBindings(ozonDECredentialBindings, productionBindings, ozonAccountDiscoveryBindings);
  if (ozonAccountDiscoveryBindings.some(binding => !ozonDECredentialBindings.some(credential => credential.credentialAlias === binding.credentialAlias))) {
    throw new Error('OZON_ACCOUNT_DISCOVERY_CONFIGURATION_INVALID: 账户准备缺少明确凭据别名路由');
  }
  let ossRuntimeConfiguration = null;
  if (Object.hasOwn(env, "SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON")) {
    try { ossRuntimeConfiguration = JSON.parse(env.SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("RUNTIME_CONFIGURATION_INVALID: OSS运行配置必须是有效JSON，未加载配置");
    }
  }
  ossRuntimeConfiguration = normalizeAliyunOssRuntimeConfiguration(ossRuntimeConfiguration);
  let ozonCommissionReferenceInput = null;
  if (Object.hasOwn(env, "SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON")) {
    try { ozonCommissionReferenceInput = JSON.parse(env.SELECTION_REVIEW_OZON_COMMISSION_REFERENCE_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("OZON_COMMISSION_REFERENCE_CONFIGURATION_INVALID: Ozon官方佣金参考表配置必须是有效JSON，未加载配置");
    }
  }
  const ozonCommissionReference = normalizeOzonCommissionReferenceConfiguration(ozonCommissionReferenceInput);
  const deploymentMode = String(env.SELECTION_REVIEW_RUNTIME_MODE || "local_development").trim();
  if (!RUNTIME_MODES.includes(deploymentMode)) throw new Error("RUNTIME_CONFIGURATION_INVALID: deploymentMode无效");
  let c1DraftServiceBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON")) {
    try { c1DraftServiceBindings = JSON.parse(env.SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("C1_DRAFT_SERVICE_CONFIGURATION_INVALID: 网关执行配置必须是有效JSON");
    }
  }
  c1DraftServiceBindings = normalizeC1DraftServiceBindings(c1DraftServiceBindings, deploymentMode);
  let keywordEvidenceServiceBindings = [];
  if (Object.hasOwn(env, "SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON")) {
    try { keywordEvidenceServiceBindings = JSON.parse(env.SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("C1_KEYWORD_SERVICE_CONFIGURATION_INVALID: 关键词服务配置必须是有效JSON数组");
    }
  }
  keywordEvidenceServiceBindings = normalizeKeywordEvidenceServiceBindings(keywordEvidenceServiceBindings);
  const discoveryConfiguration = aDiscoveryConfiguration(env);
  const otherServiceWorkers = new Set([...deServiceBindings, ...ozonAccountReadServiceBindings,
    ...ozonAccountDiscoveryBindings, ...c1DraftServiceBindings].map(binding => binding.workerId));
  if (keywordEvidenceServiceBindings.some(binding => otherServiceWorkers.has(binding.workerId))) {
    throw new Error("C1_KEYWORD_SERVICE_CONFIGURATION_INVALID: 关键词服务必须使用独立Worker");
  }
  if (discoveryConfiguration.aDiscoveryServiceBindings.some(binding => otherServiceWorkers.has(binding.workerId) ||
      keywordEvidenceServiceBindings.some(value => value.workerId === binding.workerId))) {
    throw new Error('A_DISCOVERY_SERVICE_WORKER_CONFLICT');
  }
  if (discoveryConfiguration.aProductDetailServiceBindings.some(binding=>otherServiceWorkers.has(binding.workerId) ||
      [...keywordEvidenceServiceBindings,...discoveryConfiguration.aDiscoveryServiceBindings].some(value=>value.workerId===binding.workerId))) {
    throw new Error('A_PRODUCT_DETAIL_SERVICE_WORKER_CONFLICT');
  }
  if (ozonAccountDiscoveryBindings.some(binding => c1DraftServiceBindings.some(c1 => c1.workerId === binding.workerId))) {
    throw new Error('OZON_ACCOUNT_DISCOVERY_CONFIGURATION_INVALID: 账户准备与草稿服务不能共享Worker');
  }
  if (ozonAccountReadServiceBindings.some(binding => c1DraftServiceBindings.some(c1 => c1.workerId === binding.workerId))) {
    throw new Error("OZON_ACCOUNT_READ_SERVICE_CONFIGURATION_INVALID: 账户读取与草稿生成必须使用各自明确的Worker身份");
  }

  const apiOnly = argv.includes("--api-only");
  const bindHost = String(env.SELECTION_REVIEW_BIND_HOST || "127.0.0.1").trim();
  if (deploymentMode === "local_development" && !isLoopback(bindHost)) {
    throw new Error("RUNTIME_CONFIGURATION_INVALID: 本地开发模式只能绑定回环地址");
  }
  const listenPort = port(
    apiOnly ? env.SELECTION_REVIEW_API_PORT || 4319 : env.SELECTION_REVIEW_PORT || 4317,
    "port"
  );
  const stateAdapter = String(env.SELECTION_REVIEW_STATE_ADAPTER || "json").trim();
  if (!STATE_ADAPTERS.includes(stateAdapter)) throw new Error("RUNTIME_CONFIGURATION_INVALID: stateAdapter无效");
  const initializeDataFile = booleanFlag(env.SELECTION_REVIEW_INITIALIZE_DATA_FILE);

  const defaultUserId = String(env.SELECTION_REVIEW_DEFAULT_USER_ID || "local-development-owner").trim();
  const identityProvider = String(env.SELECTION_REVIEW_IDENTITY_PROVIDER || "development_default").trim();
  if (deploymentMode !== "local_development") {
    if (isLoopback(bindHost)) throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式不得隐式绑定本机回环地址");
    if (["json", "memory"].includes(stateAdapter)) throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式必须使用并发安全的中央存储适配器");
    if (identityProvider === "development_default" || defaultUserId === "local-development-owner") {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式必须配置正式身份提供器");
    }
  }

  const publicOriginDefault = deploymentMode === "local_development"
    ? `http://127.0.0.1:${port(env.SELECTION_REVIEW_PUBLIC_PORT || 4317, "publicPort")}`
    : "";
  const publicOrigin = normalizeServiceOrigin(env.SELECTION_REVIEW_PUBLIC_ORIGIN || publicOriginDefault, {
    deploymentMode,
    label: "publicOrigin"
  });
  const aiGatewayUrl = normalizeServiceOrigin(env.SELECTION_REVIEW_AI_GATEWAY_URL || "http://127.0.0.1:4318", {
    deploymentMode,
    label: "aiGatewayUrl"
  });
  const ozonEvidenceServiceUrl = normalizeServiceOrigin(env.SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL || "http://127.0.0.1:4173", {
    deploymentMode,
    label: "ozonEvidenceServiceUrl"
  });
  const legacyFireTrainAssetRoot = String(env.SELECTION_REVIEW_LEGACY_FIRE_TRAIN_ASSET_ROOT || "").trim();
  if (deploymentMode !== "local_development" && legacyFireTrainAssetRoot) {
    throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式不得启用本机火车历史素材目录");
  }
  const allowedOrigins = String(env.SELECTION_REVIEW_ALLOWED_ORIGINS || publicOrigin)
    .split(",")
    .map((item) => normalizeServiceOrigin(item.trim(), { deploymentMode, label: "allowedOrigin" }));
  const allowedExtensionOrigins = String(env.SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => chromeExtensionOrigin(item, "allowedExtensionOrigin"));

  const dataFile = path.resolve(env.SELECTION_REVIEW_DATA_FILE || path.join(resolvedAppDir, "data", "candidates.json"));
  const workflowMapFile = path.resolve(env.SELECTION_REVIEW_WORKFLOW_MAP_FILE || path.join(resolvedAppDir, "data", "workflow-map.json"));
  const c2FinalUploadsDir = path.resolve(env.SELECTION_REVIEW_C2_UPLOAD_DIR || path.join(resolvedAppDir, "data", "c2-final-uploads"));
  const c1ImageTextExecutable = env.SELECTION_REVIEW_C1_IMAGE_TEXT_EXECUTABLE || null;
  if (c1ImageTextExecutable !== null && (deploymentMode !== "local_development" || typeof c1ImageTextExecutable !== "string" || !path.isAbsolute(c1ImageTextExecutable))) {
    throw new Error("C1_IMAGE_TEXT_LOCAL_EXECUTABLE_CONFIGURATION_INVALID");
  }
  let c1EditorialProposalFile = null;
  if (Object.hasOwn(env, "SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE")) {
    const configured = env.SELECTION_REVIEW_C1_EDITORIAL_PROPOSAL_FILE;
    if (deploymentMode !== "local_development" || typeof configured !== "string" || !configured ||
        configured !== configured.trim() || !path.isAbsolute(configured) || configured.includes("\0")) {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 文案修订文件必须通过本地开发适配器显式配置绝对路径");
    }
    c1EditorialProposalFile = path.resolve(configured);
  }
  let localOwnerIdentity = null;
  if (identityProvider === "local_owner_password") {
    const credentialFile = env.SELECTION_REVIEW_OWNER_IDENTITY_FILE;
    if (deploymentMode !== "local_development" || !isLoopback(bindHost) || typeof credentialFile !== "string" ||
        credentialFile !== credentialFile.trim() || !path.isAbsolute(credentialFile) || credentialFile.includes("\0")) {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 本地主人认证必须显式使用回环服务与私有身份文件");
    }
    const resolved = path.resolve(credentialFile);
    const protectedPaths = Object.freeze([...new Set([resolvedAppDir, dataFile, path.dirname(dataFile), workflowMapFile, path.dirname(workflowMapFile), c2FinalUploadsDir])]);
    if (!isOwnerCredentialPathIsolated(resolved, protectedPaths)) {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 身份私有目录不得与源码、业务数据或素材位置交叠");
    }
    localOwnerIdentity = Object.freeze({ credentialFile: resolved, protectedPaths });
  }

  return Object.freeze({
    schemaVersion: "selection-review-runtime-configuration-v1",
    deploymentMode,
    apiOnly,
    storeBindings,
    productionBindings,
    deServiceBindings,
    dPlatformObservation,
    eReadbackPumpIntervalMs,
    ozonAccountReadServiceBindings,
    ozonAccountDiscoveryBindings,
    ozonDECredentialBindings,
    ossRuntimeConfiguration,
    ozonCommissionReference,
    c1DraftServiceBindings,
    c1ImageTextExecutable,
    c1EditorialProposalFile,
    keywordEvidenceServiceBindings,
    ...discoveryConfiguration,
    bindHost,
    port: listenPort,
    publicOrigin,
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    allowedExtensionOrigins: Object.freeze([...new Set(allowedExtensionOrigins)]),
    aiGatewayUrl,
    ozonEvidenceServiceUrl,
    stateAdapter,
    initializeDataFile,
    dataFile,
    workflowMapFile,
    guooTariffFile,
    guooTariffRuleVersion,
    c2FinalUploadsDir,
    legacyFireTrainAssetRoot: legacyFireTrainAssetRoot ? path.resolve(legacyFireTrainAssetRoot) : null,
    identityProvider,
    localOwnerIdentity,
    defaultUserId: nonEmpty(defaultUserId, "defaultUserId")
  });
}
