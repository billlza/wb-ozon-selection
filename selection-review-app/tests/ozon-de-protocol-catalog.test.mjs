import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOzonDEProtocolCatalog, isOzonDEProtocolCatalog } from '../lib/ozon-de-protocol-catalog.mjs';
import { OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT, OZON_INVENTORY_WRITE_ENDPOINT,
  OZON_DE_READBACK_ENDPOINTS } from '../lib/ozon-seller-api-de-adapter.mjs';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';

const allMethods = [OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT, OZON_INVENTORY_WRITE_ENDPOINT,
  ...Object.values(OZON_DE_READBACK_ENDPOINTS)];
test('fixed official archive catalog is deterministic and emits current method contracts with explicit stock inference', async () => {
  const catalog = await loadOzonDEProtocolCatalog(), again = await loadOzonDEProtocolCatalog();
  assert.equal(isOzonDEProtocolCatalog(catalog), true);
  assert.equal(isOzonDEProtocolCatalog(structuredClone(catalog)), false);
  assert.equal(catalog.evidenceRef, again.evidenceRef);
  assert.equal(Object.isFrozen(catalog), true);
  const result = catalog.compose({ scope: ozonDEPreflightEvidenceFixture().scope, availableMethods: new Set(allMethods) });
  assert.deepEqual(Object.values(result.protocols).map(value => value.status), ['verified', 'verified', 'verified']);
  assert.equal(result.imagePermissionStatus, 'verified');
  const policy = result.protocols.inventoryWrite.prerequisitePolicy;
  assert.equal(policy.schemaVersion, 'ozon-inventory-prerequisite-policy-v2');
  assert.deepEqual(policy.priceSent, { endpoint: '/v3/product/info/list', field: 'statuses.status', acceptedValues: ['price_sent'] });
  assert.equal(policy.stockRequest.quantSize, 'not_applicable');
  assert.ok(result.officialContractRefs.includes(policy.stockRequest.officialEvidenceRef));
  assert.match(result.risks.find(value => value.code === 'inventory_price_state_engineering_mapping').message, /不是官方枚举/);
  assert.match(result.risks.find(value => value.code === 'method_contract_not_product_result').message, /不代表/);
});
test('official rules never manufacture a missing account method grant', async () => {
  const catalog = await loadOzonDEProtocolCatalog(), scope = ozonDEPreflightEvidenceFixture().scope;
  for (const method of allMethods) {
    const result = catalog.compose({ scope, availableMethods: new Set(allMethods.filter(value => value !== method)) });
    if ([OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT].includes(method)) assert.equal(result.protocols.productImport.status, 'denied');
    if (method === OZON_PRODUCT_IMPORT_ENDPOINT) assert.equal(result.imagePermissionStatus, 'denied');
    if (method === OZON_INVENTORY_WRITE_ENDPOINT) assert.equal(result.protocols.inventoryWrite.status, 'denied');
    if (Object.values(OZON_DE_READBACK_ENDPOINTS).includes(method)) assert.equal(result.protocols.independentReadback.status, 'denied');
  }
});
