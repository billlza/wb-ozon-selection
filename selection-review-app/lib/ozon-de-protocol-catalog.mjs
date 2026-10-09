import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT, OZON_INVENTORY_WRITE_ENDPOINT,
  OZON_DE_READBACK_ENDPOINTS } from './ozon-seller-api-de-adapter.mjs';
import { assertOzonInventoryPrerequisitePolicy, OZON_STOCK_QUANT_SIZE_REMOVAL_REF } from './ozon-inventory-prerequisite-policy.mjs';

const SOURCE_ROOT = new URL('../docs/contracts/ozon-de-20260908/', import.meta.url);
const SOURCE_FILES = ['acquisition-manifest.json', 'official-de-structural-openapi.json',
  'official-auth-import-semantics.json', 'official-field-semantics.json', 'official-exact-warehouse-openapi.json'];
const SOURCE_URL = 'https://docs.ozon.ru/api/seller/swagger.json?1788843872856';
const VERSION = 'ozon-de-call-rules-20260922-v1';
function requireSource(value, field) {
  if (!value) throw new Error(`OZON_DE_PROTOCOL_CATALOG_SOURCE_INVALID:${field}`);
}
function freeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function assertOperation(document, endpoint, operationId) {
  const operation = document.paths?.[endpoint]?.post;
  requireSource(operation?.operationId === operationId &&
    typeof operation.requestBody?.content?.['application/json']?.schema?.$ref === 'string' &&
    typeof operation.responses?.['200']?.content?.['application/json']?.schema?.$ref === 'string', endpoint);
}
function validateSources([manifest, structure, semantics, fields, warehouse], changes) {
  requireSource(manifest.sourceUrl === SOURCE_URL && manifest.originalAcquiredAt === '2026-09-08T05:04:32.856Z' &&
    manifest.originalHttpStatus === 200 && SOURCE_FILES.slice(1).every(file => typeof manifest.artifacts[file] === 'string'), 'provenance');
  const operations = {
    [OZON_PRODUCT_IMPORT_ENDPOINT]: 'ProductAPI_ImportProductsV3', [OZON_PRODUCT_IMPORT_INFO_ENDPOINT]: 'ProductAPI_GetImportProductsInfo',
    [OZON_INVENTORY_WRITE_ENDPOINT]: 'ProductAPI_ProductsStocksV2',
    [OZON_DE_READBACK_ENDPOINTS.attributes]: 'ProductAPI_GetProductAttributesV4',
    [OZON_DE_READBACK_ENDPOINTS.info]: 'ProductAPI_GetProductInfoList',
    [OZON_DE_READBACK_ENDPOINTS.prices]: 'ProductAPI_GetProductInfoPrices'
  };
  for (const [endpoint, operationId] of Object.entries(operations)) assertOperation(structure, endpoint, operationId);
  assertOperation(warehouse, OZON_DE_READBACK_ENDPOINTS.stocks, 'ProductAPI_GetProductInfoStocksByWarehouseFbsV2');
  const schemas = structure.components.schemas, item = schemas.v3ImportProductsRequestItem;
  requireSource(item.required.includes('offer_id') && item.required.includes('price') &&
    isDeepStrictEqual(item.properties.images, { type: 'array', items: { type: 'string' } }) &&
    item.properties.primary_image.type === 'string' && item.properties.currency_code.type === 'string', 'import_images_currency');
  const importStatus = semantics.importSchemas?.GetImportProductsInfoResponseResultItem?.properties?.status;
  requireSource(semantics.importInfo.operationId === operations[OZON_PRODUCT_IMPORT_INFO_ENDPOINT] &&
    importStatus?.type === 'string' && ['pending', 'imported', 'failed', 'skipped'].every(value => importStatus.description.includes(`\`${value}\``)), 'import_result');
  requireSource(typeof fields.stockUpdate === 'string' && fields.stockUpdate.includes('price_sent') &&
    fields.stockUpdate.includes(OZON_DE_READBACK_ENDPOINTS.stocks) && fields.stockUpdate.includes('offer_id') &&
    fields.stockUpdate.includes('product_id'), 'stock_prerequisites');
  requireSource(fields.currency?.description?.includes('CNY') && fields.currency.description.includes('RUB'), 'currency');
  const status = schemas.GetProductInfoListResponseStatuses.properties, info = schemas.v3GetProductInfoListResponseItem.properties;
  requireSource(status.status.type === 'string' && status.moderate_status.type === 'string' && status.validation_status.type === 'string' &&
    info.statuses.$ref === '#/components/schemas/GetProductInfoListResponseStatuses' && info.is_archived.type === 'boolean' &&
    info.errors.type === 'array' && ['images', 'primary_image'].every(field =>
      isDeepStrictEqual(info[field], { type: 'array', items: { type: 'string' } })), 'product_observation');
  requireSource(schemas.ItemPricev5.properties.price.type === 'number' && schemas.ItemPricev5.properties.currency_code.type === 'string', 'price_observation');
  const stock = semantics.stockRequestSchemas.productv2ProductsStocksRequestStock.properties;
  requireSource(stock.offer_id.type === 'string' && stock.stock.type === 'integer' && stock.warehouse_id.type === 'integer', 'stock_request');
  const exact = warehouse.components.schemas.v2GetProductInfoStocksByWarehouseFbsResponseV2Product.properties;
  requireSource(['free_stock', 'reserved', 'product_id', 'warehouse_id'].every(field => exact[field]?.type === 'integer') &&
    exact.offer_id.type === 'string', 'warehouse_observation');
  const removal = changes.sources?.find(source => source.evidenceRef === OZON_STOCK_QUANT_SIZE_REMOVAL_REF);
  requireSource(changes.endpoint === OZON_INVENTORY_WRITE_ENDPOINT && removal?.sourceUrl === 'https://t.me/OzonEnSellerAPI/220' &&
    removal.publishedAt === '2025-06-26' && removal.claims.includes('stocks.quant_size was removed from the request') &&
    changes.implementationRule.sendQuantSize === false, 'quant_size_removal');
}

// Constructed only by the fixed-file loader below. A saved record cannot supply this capability.
class OzonDEProtocolCatalog {
  constructor(documents, changes) {
    validateSources(documents, changes);
    this.version = VERSION;
    // Content identity detects accidental source changes; this is not a signature or an authorization.
    this.evidenceRef = `ozon-de-call-rules:${fingerprintCanonicalRecord({ version: VERSION, documents, changes })}`;
    this.officialContractRefs = freeze([this.evidenceRef, 'official:ozon-openapi:de-structure:20260908',
      'official:ozon-openapi:auth-import-semantics:20260908', 'official:ozon-openapi:field-semantics:20260908',
      'official:ozon-openapi:exact-warehouse:20260908', OZON_STOCK_QUANT_SIZE_REMOVAL_REF]);
    Object.freeze(this);
  }
  compose({ scope, availableMethods }) {
    const statusFor = methods => methods.every(method => availableMethods.has(method)) ? 'verified' : 'denied';
    const policy = assertOzonInventoryPrerequisitePolicy({ schemaVersion: 'ozon-inventory-prerequisite-policy-v2',
      policyId: `${this.evidenceRef}:inventory`, version: VERSION, officialEvidenceRef: 'official:ozon-openapi:field-semantics:20260908',
      priceSent: { endpoint: OZON_DE_READBACK_ENDPOINTS.info, field: 'statuses.status', acceptedValues: ['price_sent'] },
      reserved: { endpoint: OZON_DE_READBACK_ENDPOINTS.stocks, sourceProtocol: 'ozon-product-stocks-by-warehouse-fbs-v2' },
      stockRequest: { identityField: 'offer_id', quantSize: 'not_applicable', officialEvidenceRef: OZON_STOCK_QUANT_SIZE_REMOVAL_REF } });
    return { officialContractRefs: [...this.officialContractRefs], imagePermissionStatus: statusFor([OZON_PRODUCT_IMPORT_ENDPOINT]),
      imageProtocolRef: `${this.evidenceRef}:import-images`,
      protocols: {
        productImport: { status: statusFor([OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT]),
          protocolVersion: 'ozon-product-import-v3', evidenceRef: `${this.evidenceRef}:import`,
          endpoint: OZON_PRODUCT_IMPORT_ENDPOINT, statusEndpoint: OZON_PRODUCT_IMPORT_INFO_ENDPOINT },
        inventoryWrite: { status: statusFor([OZON_INVENTORY_WRITE_ENDPOINT]), protocolVersion: 'ozon-products-stocks-v2',
          evidenceRef: `${this.evidenceRef}:stocks`, endpoint: OZON_INVENTORY_WRITE_ENDPOINT,
          warehouseId: scope.warehouseId, storeRef: structuredClone(scope.storeRef), warehouseRef: scope.warehouseRef,
          credentialAlias: scope.credentialAlias, prerequisitePolicy: policy },
        independentReadback: { status: statusFor(Object.values(OZON_DE_READBACK_ENDPOINTS)), protocolVersion: 'ozon-independent-readback-v2',
          evidenceRef: `${this.evidenceRef}:readback`, endpoints: structuredClone(OZON_DE_READBACK_ENDPOINTS) }
      }, risks: [
        { code: 'inventory_price_state_engineering_mapping', message: '库存正文要求price_sent；将商品statuses.status精确匹配该值是保守工程映射，不是官方枚举声明。其他值、归档或状态缺失均不放行。' },
        { code: 'method_contract_not_product_result', message: '调用规则和账户方法权限不代表本商品已创建、图片已对应、库存已写入或已可售；各步执行前后仍分别核验。' }
      ] };
  }
}
export function isOzonDEProtocolCatalog(value) { return value instanceof OzonDEProtocolCatalog; }

/** Local immutable technical evidence only: no credentials, platform access, business writes or supplied verified claims. */
export async function loadOzonDEProtocolCatalog() {
  const documents = await Promise.all(SOURCE_FILES.map(async file => JSON.parse(await readFile(new URL(file, SOURCE_ROOT), 'utf8'))));
  const changes = JSON.parse(await readFile(new URL('../docs/contracts/ozon-stock-changes-20260922.json', import.meta.url), 'utf8'));
  return new OzonDEProtocolCatalog(documents, changes);
}
