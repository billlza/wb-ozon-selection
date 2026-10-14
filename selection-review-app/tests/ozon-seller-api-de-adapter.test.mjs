import assert from "node:assert/strict";
import test from "node:test";
import { preparedFixture, capabilities as formalCapabilities } from "./helpers/d-software-fixture.mjs";
import { OzonDEHttpTransportError } from '../lib/ozon-de-http-configuration.mjs';
import { finalAssets as syntheticFinalAssets } from './helpers/c2-software-fixture.mjs';
import { assertOzonInventoryPrerequisitePolicy, isCurrentInventoryPrerequisitePolicy,
  OZON_STOCK_QUANT_SIZE_REMOVAL_REF } from "../lib/ozon-inventory-prerequisite-policy.mjs";
import {
  createStoreIsolatedOzonSellerApiDEAdapter,
  inspectAdapterCapabilities,
  OZON_DE_READBACK_ENDPOINTS,
  OZON_DE_LEGACY_READBACK_ENDPOINTS,
  resolveFinalUploads
} from "../lib/ozon-seller-api-de-adapter.mjs";

function executionBinding(store = "dandanshu") {
  return { storeRef: { stableStoreId: store, platformStoreId: `seller-${store}-001`, mappingVersion: "stores-v1" },
    warehouseRef: `warehouse:synthetic:${store}`, credentialAlias: `credential-alias:synthetic:${store}` };
}

function finalUploads(host = "media.example") {
  return [1, 2].map((order) => ({
    assetId: `asset-${order}`,
    assetRef: `/local/asset-${order}.png`,
    sha256: String(order).repeat(64),
    order,
    role: order === 1 ? "main" : "detail",
    lifecycleArea: "finalUploads",
    ownerConfirmed: true,
    productionEligible: true,
    platformAcceptedUrl: `https://${host}/asset-${order}.png`
  }));
}

// Explicitly synthetic policy. No production source verifier emits this policy.
const prerequisitePolicy = { schemaVersion: "ozon-inventory-prerequisite-policy-v1", policyId: "policy:synthetic:stocks",
  version: "synthetic-v1", officialEvidenceRef: "evidence:synthetic:stock-contract", priceSent: {
    endpoint: "/v3/product/info/list", field: "statuses.status", acceptedValues: ["synthetic_price_sent"] },
  reserved: { endpoint: "/v2/product/info/stocks-by-warehouse/fbs", sourceProtocol: "ozon-product-stocks-by-warehouse-fbs-v2" },
  stockRequest: { identityField: "offer_id", quantSize: null } };

function capabilityInput({ store = "dandanshu", warehouseId = "70001", host = "media.example", assets = finalUploads(host) } = {}) {
  return {
    store, ...executionBinding(store),
    warehouseId,
    inspectedAt: "2026-08-22T03:00:00.000Z",
    storeIdentity: {
      status: "verified", expectedStore: store, observedStore: store, observedStoreRef: executionBinding(store).storeRef, credentialAlias: executionBinding(store).credentialAlias,
      evidenceRef: `evidence:store:${store}`
    },
    productImport: {
      status: "verified", protocolVersion: "ozon-product-import-v3",
      endpoint: "/v3/product/import", statusEndpoint: "/v1/product/import/info",
      evidenceRef: "evidence:protocol:product-import"
    },
    assetTransport: {
      status: "verified", protocolVersion: "approved-https-assets-v1", mode: "preapproved_stable_https",
      approvedHosts: [host], evidenceRef: "evidence:protocol:assets",
      resolvedAssets: assets.map((asset) => ({
        assetId: asset.assetId,
        platformAcceptedUrl: asset.platformAcceptedUrl,
        sha256: asset.sha256,
        order: asset.order,
        authorizationStatus: "approved",
        stable: true,
        evidenceRef: `evidence:resolved:${asset.assetId}`
      }))
    },
    inventoryWrite: {
      status: "verified", protocolVersion: "ozon-products-stocks-v2",
      endpoint: "/v2/products/stocks", warehouseId, ...executionBinding(store), prerequisitePolicy: structuredClone(prerequisitePolicy),
      evidenceRef: "evidence:protocol:inventory"
    },
    independentReadback: {
      status: "verified", protocolVersion: "ozon-independent-readback-v2",
      endpoints: structuredClone(OZON_DE_READBACK_ENDPOINTS),
      evidenceRef: "evidence:protocol:readback"
    }
  };
}

function readyCapabilities(options = {}) {
  return inspectAdapterCapabilities(capabilityInput(options));
}

const formalExecution = await preparedFixture({ merchantSku: "SUP-MUSIC-001",
  warehouseRef: executionBinding().warehouseRef, credentialAlias: executionBinding().credentialAlias });
const executionContext = formalExecution.executionContext;
const writeCapabilities = readyCapabilities({ assets: formalExecution.prepared.executableRequest.finalUploads,
  host: new URL(formalExecution.prepared.executableRequest.finalUploads[0].platformAcceptedUrl).hostname });

test('batch adapter sends one multi-item task and classifies each offer without replaying failed members', async () => {
  const assets = syntheticFinalAssets().map((asset, index) => ({ ...asset,
    assetId: `${asset.assetId}:black`, assetRef: index === 0 ? 'https://assets.example.com/owner/black-main.jpg' : asset.assetRef,
    sha256: index === 0 ? 'c'.repeat(64) : asset.sha256 }));
  const second = await preparedFixture({ candidateId: 'candidate:batch-second', supplierSkuId: 'SHELF-BLACK',
    merchantSku: 'MERCHANT-BLACK', assets, warehouseRef: executionBinding().warehouseRef,
    credentialAlias: executionBinding().credentialAlias });
  const member = source => ({ request: source.prepared.executableRequest, executionContext: source.executionContext,
    colorKey: source === formalExecution ? 'white' : 'black', modelKey: 'same-product',
    sourceTechnicalStatus: 'not_started' });
  const members = [member(formalExecution), member(second)];
  const capability = formalCapabilities('dandanshu', members.flatMap(value => value.request.finalUploads),
    members[0].request);
  capability.warehouseId = '70001';
  capability.assetTransport.resolvedAssets = members.flatMap(value => value.request.finalUploads.map(asset => ({
    assetId: asset.assetId, platformAcceptedUrl: asset.platformAcceptedUrl, sha256: asset.sha256,
    order: asset.order, authorizationStatus: 'approved', stable: true, evidenceRef: `synthetic:${asset.assetId}`
  })));
  capability.productImport.endpoint = '/v3/product/import';
  capability.productImport.maxItemsPerRequest = 2;
  capability.productImport.limitEvidenceRef = 'synthetic:batch-limit';
  capability.productImport.limitObservedAt = '2026-08-22T07:00:00.000Z';
  capability.productImport.validUntil = '2026-09-01T00:00:00.000Z';
  const calls = [], checkpoints = [];
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: capability,
    requestJson: async request => {
      calls.push(request);
      if (request.endpoint === '/v3/product/import') return { result: { task_id: 501 } };
      return { result: { items: [
        { offer_id: members[0].request.merchantSku, product_id: 910001, status: 'imported', errors: [] },
        { offer_id: members[1].request.merchantSku, product_id: 0, status: 'failed', errors: [] }
      ] } };
    } });
  const scope = { batchId: 'd-batch:synthetic', members, excludedOfferIds: ['MERCHANT-FIRST'], chunkIndex: 0 };
  const receipt = await adapter.executeBatchImport(scope, { persistCheckpoint: async event => checkpoints.push(event) });
  assert.equal(receipt.status, 'waiting_platform');
  assert.deepEqual(checkpoints.map(event => event.kind), ['batch_import_intent', 'batch_import_task_received']);
  assert.equal(calls[0].body.items.length, 2);
  const observed = await adapter.observeBatchImportTask({ batchId: scope.batchId, chunkIndex: 0,
    taskId: receipt.taskId, offerIds: receipt.offerIds });
  assert.deepEqual(observed.results.map(result => result.classification), ['imported', 'platform_failed']);
  assert.deepEqual(calls.map(call => call.write), [true, false]);
  for (const resultItems of [
    [{ offer_id: scope.members[0].request.merchantSku, product_id: 910001, status: 'imported', errors: [] }],
    [{ offer_id: scope.members[0].request.merchantSku, product_id: 910001, status: 'imported', errors: [] },
      { offer_id: scope.members[0].request.merchantSku, product_id: 910001, status: 'imported', errors: [] }],
    [{ offer_id: scope.members[0].request.merchantSku, product_id: 910001, status: 'imported', errors: [] },
      { offer_id: 'UNEXPECTED', product_id: 910003, status: 'imported', errors: [] }]
  ]) {
    const unsafe = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: capability,
      requestJson: async () => ({ result: { items: resultItems } }) });
    const observation = await unsafe.observeBatchImportTask({ batchId: scope.batchId, chunkIndex: 0,
      taskId: receipt.taskId, offerIds: receipt.offerIds });
    assert.equal(observation.results.some(result => result.classification !== 'unknown_outcome'),
      resultItems.every(item => item.offer_id !== 'UNEXPECTED') && resultItems.length === 1);
    assert.equal(observation.results.some(result => result.classification === 'unknown_outcome'), true);
  }
  let currentTime = '2026-08-22T07:25:00.000Z';
  const expiringMembers = members.map(value => ({ ...value,
    executionContext: { ...value.executionContext, serverClock: () => currentTime } }));
  const expiringCalls = [];
  const expiringCapability = structuredClone(capability);
  expiringCapability.productImport.validUntil = '2026-08-22T07:25:30.000Z';
  const expiringAdapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: expiringCapability,
    requestJson: async request => { expiringCalls.push(request); return { result: { task_id: 502 } }; } });
  const rejected = await expiringAdapter.executeBatchImport({ ...scope, members: expiringMembers },
    { persistCheckpoint: async event => {
      if (event.kind === 'batch_import_intent') currentTime = expiringCapability.productImport.validUntil;
    } });
  assert.deepEqual(rejected, {status:'rejected_before_write',writeOccurred:false,
    requestTransmission:'not_attempted',reasonCode:'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED',retryAllowed:false});
  assert.equal(expiringCalls.length, 0);
  for (const [failure, expectedStatus] of [
    [new OzonDEHttpTransportError('OZON_DE_CREDENTIAL_READ_FAILED'), 'rejected_before_write'],
    [new OzonDEHttpTransportError('OZON_DE_HTTP_CONNECTION_FAILED',
      {externalRequestState:'unknown_outcome',requestTransmission:'attempted'}), 'unknown_outcome'],
    [Object.assign(new Error('untrusted transport'),{code:'OZON_DE_CREDENTIAL_READ_FAILED',
      externalRequestState:'not_sent',requestTransmission:'not_attempted'}), 'unknown_outcome']
  ]) {
    const transport = createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:capability,
      requestJson:async()=>{throw failure;}});
    const events=[];
    const outcome=await transport.executeBatchImport(scope,{persistCheckpoint:async event=>events.push(event)});
    assert.equal(outcome.status,expectedStatus);
    assert.deepEqual(events.map(event=>event.kind),['batch_import_intent']);
    if(expectedStatus==='rejected_before_write')
      assert.deepEqual([outcome.writeOccurred,outcome.requestTransmission,outcome.reasonCode],
        [false,'not_attempted','OZON_DE_CREDENTIAL_READ_FAILED']);
  }
});

function executableRequest({ store, warehouseId, offerId } = {}) {
  const request = structuredClone(formalExecution.prepared.executableRequest);
  if (store) { request.store = store; Object.assign(request, executionBinding(store)); }
  if (warehouseId) request.inventoryWrite.warehouseId = warehouseId;
  if (offerId) { request.merchantSku = offerId; request.productImport.body.items[0].offer_id = offerId; }
  return request;
}

function checkpointAdapterFixture() {
  const calls = [];
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities, executionContext, requestJson: async request => {
    calls.push(request.endpoint);
    if (request.endpoint === "/v3/product/import") return { result: { task_id: 501 } };
    if (request.endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, status: "imported", errors: [] }] } };
    if (request.endpoint === "/v2/products/stocks") return { result: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, warehouse_id: 70001, updated: true, errors: [] }] };
    throw new Error("unexpected platform request");
  } });
  return { calls, adapter };
}

test("missing persistence and each failed checkpoint prevent every subsequent platform call", async () => {
  const missing = checkpointAdapterFixture();
  assert.equal((await missing.adapter.executeSellerApi(executableRequest())).status, "rejected_before_write");
  assert.equal(missing.calls.length, 0);
  for (const [failureAt, count] of [["import_intent", 0], ["import_task_received", 1]]) {
    const { calls, adapter } = checkpointAdapterFixture();
    const saved = [];
    await assert.rejects(() => adapter.executeSellerApi(executableRequest(), { persistCheckpoint: async event => {
      if (event.kind === failureAt) throw new Error("disk unavailable");
      saved.push(structuredClone(event));
    } }), error => {
      assert.equal(error.code, "D_CHECKPOINT_PERSISTENCE_FAILED");
      assert.equal(error.checkpoint.kind, failureAt);
      return true;
    });
    assert.equal(calls.length, count, failureAt);
    assert.equal(saved.some(event => event.kind === failureAt), false);
    if (count >= 2) assert.equal(saved.find(event => event.kind === "import_task_received").taskId, "501");
  }
});

test("a pending task checkpoint holds the next platform read and inventory write", async () => {
  const { calls, adapter } = checkpointAdapterFixture();
  const reached = Promise.withResolvers();
  const persisted = Promise.withResolvers();
  const result = adapter.executeSellerApi(executableRequest(), { persistCheckpoint: async event => {
    if (event.kind === "import_task_received") { reached.resolve(); await persisted.promise; }
  } });
  await reached.promise;
  assert.deepEqual(calls, ["/v3/product/import"]);
  persisted.resolve();
  assert.equal((await result).status, "waiting_platform");
  assert.equal(calls.length, 1);
});

test("caller mutation during a checkpoint cannot change the frozen import payload", async () => {
  const request = executableRequest(); const originalImport = structuredClone(request.productImport.body); const imports = [];
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities, executionContext,
    requestJson: async ({ endpoint, body }) => {
      if (endpoint === "/v3/product/import") { imports.push(body); return { result: { task_id: 501 } }; }
      if (endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, status: "imported", errors: [] }] } };
      if (endpoint === "/v2/products/stocks") return { result: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, warehouse_id: 70001, updated: true, errors: [] }] };
      throw new Error("unexpected call");
    } });
  const result = await adapter.executeSellerApi(request, { persistCheckpoint: async event => {
    if (event.kind === "import_intent") request.productImport.body.items[0].name = "Caller edited title";
  } });
  assert.equal(result.status, "waiting_platform"); assert.deepEqual(imports, [originalImport]);
});

function readbackResponses({ offerId = "SUP-MUSIC-001", productId = "910001", saleStatus = "Продается", infoErrors = [], primaryInImages = false } = {}) {
  const primaryImage = "https://cdn.ozon/main.jpg";
  return {
    "/v4/product/info/attributes": {
      result: [{
        offer_id: offerId,
        id: Number(productId),
        sku: 810001,
        primary_image: primaryImage,
        images: primaryInImages ? [primaryImage, "https://cdn.ozon/detail.jpg"] : ["https://cdn.ozon/detail.jpg"]
      }]
    },
    "/v3/product/info/list": {
      items: [{
        offer_id: offerId, id: Number(productId), sku: 810001, name: "Музыкальная шкатулка", is_archived: false,
        primary_image: [primaryImage],
        images: primaryInImages ? [primaryImage, "https://cdn.ozon/detail.jpg"] : ["https://cdn.ozon/detail.jpg"],
        statuses: { moderate_status: "approved", validation_status: "success", status_name: saleStatus, status_description: "" },
        errors: structuredClone(infoErrors)
      }]
    },
    "/v5/product/info/prices": {
      items: [{ offer_id: offerId, product_id: Number(productId), price: { price: 117.85, currency_code: "CNY" } }]
    },
    "/v2/product/info/stocks-by-warehouse/fbs": {
      has_next: false, cursor: "", products: [{ offer_id: offerId, product_id: Number(productId), sku: 810001, warehouse_id: 70001, free_stock: 100, present: 103, reserved: 3 }]
    }
  };
}

test("capability inspection requires exact store, warehouse, protocols, and four evidence groups", () => {
  const ready = readyCapabilities();
  assert.equal(ready.status, "ready");
  assert.equal(ready.store, "dandanshu");
  assert.equal(ready.warehouseId, "70001");
  assert.match(ready.evidenceRef, /^ozon-adapter-capabilities:/);

  const missingAssets = capabilityInput();
  missingAssets.assetTransport.status = "unknown";
  missingAssets.assetTransport.evidenceRef = "";
  const blocked = inspectAdapterCapabilities(missingAssets);
  assert.equal(blocked.status, "not_ready");
  assert.ok(blocked.gaps.some((item) => item.code === "asset_transport_not_verified"));

  const crossStore = capabilityInput();
  crossStore.storeIdentity.observedStore = "miska";
  assert.equal(inspectAdapterCapabilities(crossStore).status, "not_ready");
});

test("能力检查认两条身份锚：仓库反推要求观察引用为空，其余路径仍比对店铺引用", () => {
  const identityBlocked = (input) => inspectAdapterCapabilities(input).gaps.some((item) => item.code === "store_identity_not_verified");

  // 仓库反推（主人2026-09-16决定）：Ozon 不发店铺编号，observedStoreRef 恒为 null 才是正确状态，放行。
  const warehouse = capabilityInput();
  Object.assign(warehouse.storeIdentity, { verifiedVia: "scoped_warehouse", observedStoreRef: null });
  assert.equal(inspectAdapterCapabilities(warehouse).status, "ready");
  assert.equal(inspectAdapterCapabilities(warehouse).storeIdentity.verifiedVia, "scoped_warehouse");

  // 锁：声称仓库反推、同时又带着店铺引用，是矛盾不是更强的证据，必须仍然拦住。
  const contradictory = capabilityInput();
  contradictory.storeIdentity.verifiedVia = "scoped_warehouse";
  assert.ok(identityBlocked(contradictory), "仓库反推不得同时声称观测到店铺引用");

  // 非仓库锚点维持原规则：没有观察引用就是没锚住（未声明、明写原路径、none、未知值都一样）。
  for (const via of [undefined, "platform_store_id", "none", "owner_says_so"]) {
    const bare = capabilityInput();
    bare.storeIdentity.observedStoreRef = null;
    if (via !== undefined) bare.storeIdentity.verifiedVia = via;
    assert.ok(identityBlocked(bare), `非仓库锚点下空引用必须拦住：${String(via)}`);
  }
  const otherStoreRef = capabilityInput();
  otherStoreRef.storeIdentity.observedStoreRef = { ...otherStoreRef.storeIdentity.observedStoreRef, platformStoreId: "seller-miska-001" };
  assert.ok(identityBlocked(otherStoreRef), "非仓库锚点下引用不一致必须拦住");

  // 锁：'none' 就是没有锚点。旁边挂一个真实可对上的 observedStoreRef 也不放行——Ozon 从不返回店铺
  // 编号，那个引用只可能是人手填的。认不出来的锚点名同样不放行（这道门自己不查取值合法性）。
  for (const via of ["none", "owner_says_so"]) {
    const refWithoutAnchor = capabilityInput();
    refWithoutAnchor.storeIdentity.verifiedVia = via;
    assert.deepEqual(refWithoutAnchor.storeIdentity.observedStoreRef, executionBinding("dandanshu").storeRef);
    assert.ok(identityBlocked(refWithoutAnchor), `${via} 配一个对得上的店铺引用仍然不算锚住`);
  }

  // 仓库反推只替换"店铺引用比对"这一项，其余身份条件一个都不放过。
  for (const patch of [{ status: "unknown" }, { observedStore: "miska" }, { expectedStore: "miska" },
    { credentialAlias: "credential-alias:another" }, { evidenceRef: "" }]) {
    const partial = capabilityInput();
    Object.assign(partial.storeIdentity, { verifiedVia: "scoped_warehouse", observedStoreRef: null }, patch);
    assert.ok(identityBlocked(partial), JSON.stringify(patch));
  }
});

test("final upload resolution accepts only capability-approved stable HTTPS URLs", () => {
  const assets = finalUploads();
  const ready = readyCapabilities({ assets });
  const resolved = resolveFinalUploads({ finalUploads: assets, adapterCapabilities: ready });
  assert.equal(resolved.status, "ready");
  assert.deepEqual(resolved.resolvedAssets.map((asset) => asset.platformAcceptedUrl), [
    "https://media.example/asset-1.png", "https://media.example/asset-2.png"
  ]);

  const localOnlyInput = capabilityInput({ assets });
  localOnlyInput.assetTransport.resolvedAssets = [];
  const localOnly = resolveFinalUploads({
    finalUploads: assets,
    adapterCapabilities: inspectAdapterCapabilities(localOnlyInput)
  });
  assert.equal(localOnly.status, "not_ready");

  const tmpAssets = finalUploads("tmpfiles.org");
  const tmpCapabilities = inspectAdapterCapabilities(capabilityInput({ host: "tmpfiles.org", assets: tmpAssets }));
  assert.equal(tmpCapabilities.status, "not_ready");
  assert.equal(resolveFinalUploads({ finalUploads: tmpAssets, adapterCapabilities: tmpCapabilities }).status, "not_ready");

  const unapproved = structuredClone(capabilityInput({ assets }));
  unapproved.assetTransport.approvedHosts = ["another.example"];
  const unapprovedCapabilities = inspectAdapterCapabilities(unapproved);
  assert.equal(resolveFinalUploads({ finalUploads: assets, adapterCapabilities: unapprovedCapabilities }).status, "not_ready");
});

test("cross-store and cross-SKU requests are rejected before any platform call", async () => {
  let calls = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: writeCapabilities, executionContext,
    requestJson: async () => { calls += 1; return {}; }
  });
  const wrongStore = await adapter.executeSellerApi(executableRequest({ store: "miska" }));
  assert.equal(wrongStore.status, "rejected_before_write");
  const wrongSkuRequest = executableRequest();
  wrongSkuRequest.productImport.body.items[0].offer_id = "OTHER-SKU";
  const wrongSku = await adapter.executeSellerApi(wrongSkuRequest);
  assert.equal(wrongSku.status, "rejected_before_write");
  assert.equal(calls, 0);
});

test("old or missing authorization contract provenance cannot execute through the Seller API adapter", async () => {
  let writes = 0; let checkpoints = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities, executionContext,
    requestJson: async () => { writes += 1; throw new Error("must not send"); } });
  for (const version of [undefined, "production-authorization-v1.1"]) {
    const request = executableRequest();
    if (version === undefined) delete request.sourceAuthorizationVersion;
    else request.sourceAuthorizationVersion = version;
    const result = await adapter.executeSellerApi(request, { persistCheckpoint: async () => { checkpoints += 1; } });
    assert.equal(result.status, "rejected_before_write");
    assert.equal(result.message, "PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
  }
  assert.equal(writes, 0); assert.equal(checkpoints, 0);
});

test("a version label or old prepared request cannot replace the saved authorization and current service clock", async () => {
  let writes = 0; let checkpoints = 0;
  const request = executableRequest(); const original = structuredClone(request);
  const expiredAt = executionContext.productionPlan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview.expiresAt;
  for (const [context, code] of [[null, "D_EXECUTION_CONTEXT_REQUIRED"],
    [{ ...executionContext, serverClock: null }, "D_EXECUTION_CONTEXT_REQUIRED"],
    [{ ...executionContext, serverClock: () => expiredAt }, "C1_SKU_RIGHTS_REVIEW_EXPIRED"]]) {
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities, executionContext: context,
      requestJson: async () => { writes += 1; throw new Error("must not write"); } });
    const result = await adapter.executeSellerApi(request, { persistCheckpoint: async () => { checkpoints += 1; } });
    assert.equal(result.status, "rejected_before_write"); assert.equal(result.writeOccurred, false); assert.equal(result.message, code);
  }
  const missingRightsPlan = structuredClone(executionContext.productionPlan);
  delete missingRightsPlan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview;
  assert.equal(missingRightsPlan.sourceAuthorization.schemaVersion, "production-authorization-v1.2");
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities,
    executionContext: { ...executionContext, productionPlan: missingRightsPlan }, requestJson: async () => { writes += 1; } });
  assert.equal((await adapter.executeSellerApi(request, { persistCheckpoint: async () => { checkpoints += 1; } })).status, "rejected_before_write");
  assert.equal(writes, 0); assert.equal(checkpoints, 0); assert.deepEqual(request, original);
});

test("saved authorization binding rejects changed price, import content, assets and source identity before persistence or I/O", async () => {
  let writes = 0; let checkpoints = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities, executionContext,
    requestJson: async () => { writes += 1; } });
  for (const mutate of [value => { value.candidateId = "candidate:another"; },
    value => { value.sourceAuthorizationFingerprint = "0".repeat(64); },
    value => { value.platformWritePrice.amount += 1; }, value => { value.productImport.body.items[0].name = "Other title"; },
    value => { value.finalUploads[0].sha256 = "0".repeat(64); },
    value => { value.finalUploads.reverse(); }]) {
    const request = executableRequest(); mutate(request);
    const result = await adapter.executeSellerApi(request, { persistCheckpoint: async () => { checkpoints += 1; } });
    assert.equal(result.status, "rejected_before_write"); assert.equal(result.message, "D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH");
  }
  assert.equal(writes, 0); assert.equal(checkpoints, 0);
});

function independentReadbackQuery() {
  return { mode: "independent_read_only", platform: "ozon", store: "dandanshu", ...executionBinding(),
    skuPackageId: "sku-lifecycle:GENERIC:SUP-MUSIC-001", platformProductId: "910001",
    merchantSku: "SUP-MUSIC-001", supplierSkuId: "SUP-MUSIC-001", warehouseId: "70001", writeAllowed: false };
}

test("independent readback forwards the same signal to all four reads without persisting it in the request DTO", async () => {
  const controller = new AbortController();
  const responses = readbackResponses();
  const calls = [];
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
    requestJson: async (request, options) => {
      assert.equal(options.signal, controller.signal);
      assert.equal(Object.hasOwn(request, "signal"), false);
      assert.equal(Object.isFrozen(controller.signal), false);
      assert.equal(request.write, false);
      calls.push(request.endpoint);
      return structuredClone(responses[request.endpoint]);
    } });
  const observation = await adapter.readbackSellerApi(independentReadbackQuery(), { signal: controller.signal });
  assert.deepEqual(calls, Object.values(OZON_DE_READBACK_ENDPOINTS));
  assert.equal(observation.currentStock, 100);
  assert.equal(Object.hasOwn(observation, "signal"), false);
});

test("independent readback rejects pre-aborted and invalid signals before any transport request", async () => {
  let calls = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
    requestJson: async () => { calls += 1; throw new Error("unexpected request"); } });
  for (const reason of [new DOMException("Cancelled", "AbortError"), new DOMException("Deadline", "TimeoutError")]) {
    const signal = AbortSignal.abort(reason);
    await assert.rejects(() => adapter.readbackSellerApi(independentReadbackQuery(), { signal }), error => error === reason);
  }
  for (const signal of [null, {}, { aborted: false, throwIfAborted() {} }]) {
    await assert.rejects(() => adapter.readbackSellerApi(independentReadbackQuery(), { signal }),
      error => error instanceof TypeError && error.message.startsWith("OZON_DE_READBACK_SIGNAL_INVALID:"));
  }
  assert.equal(calls, 0);
});

test("independent readback stops after cancellation even when transport returns a late successful response", async () => {
  for (const cancelAt of [1, 3, 4]) {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled during read", "AbortError");
    const responses = readbackResponses();
    let calls = 0;
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
      requestJson: async (request, { signal }) => {
        assert.equal(signal, controller.signal);
        calls += 1;
        if (calls === cancelAt) controller.abort(reason);
        return structuredClone(responses[request.endpoint]);
      } });
    await assert.rejects(() => adapter.readbackSellerApi(independentReadbackQuery(), { signal: controller.signal }), error => error === reason);
    assert.equal(calls, cancelAt);
  }
});

test("independent readback delivers cancellation to a pending transport and preserves its error category", async () => {
  for (const name of ["AbortError", "TimeoutError"]) {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic bounded cancellation", name);
    let calls = 0;
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
      requestJson: async (_request, { signal }) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          requestStarted();
        });
      } });
    const pending = adapter.readbackSellerApi(independentReadbackQuery(), { signal: controller.signal });
    await started;
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason && error.name === name);
    assert.equal(calls, 1);
  }
});

test("independent readback propagates transport failure unchanged without a follow-up query", async () => {
  const failure = Object.assign(new Error("Synthetic transport unavailable"), { code: "ECONNRESET" });
  const controller = new AbortController();
  let calls = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
    requestJson: async () => { calls += 1; throw failure; } });
  await assert.rejects(() => adapter.readbackSellerApi(independentReadbackQuery(), { signal: controller.signal }), error => error === failure);
  assert.equal(calls, 1);
});

test("independent readback works in a fresh adapter without process-local submission state", async () => {
  const calls = [];
  const responses = readbackResponses();
  const restartedAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async (request) => {
      calls.push(request);
      return structuredClone(responses[request.endpoint]);
    }
  });
  const result = await restartedAdapter.readbackSellerApi({
    mode: "independent_read_only",
    platform: "ozon",
    store: "dandanshu", ...executionBinding(),
    skuPackageId: "sku-lifecycle:GENERIC:SUP-MUSIC-001",
    platformProductId: "910001",
    merchantSku: "SUP-MUSIC-001",
    supplierSkuId: "SUP-MUSIC-001",
    warehouseId: "70001", writeAllowed: false
  });
  assert.deepEqual(calls.map((call) => [call.endpoint, call.write]), [
    ["/v4/product/info/attributes", false],
    ["/v3/product/info/list", false],
    ["/v5/product/info/prices", false],
    ["/v2/product/info/stocks-by-warehouse/fbs", false]
  ]);
  assert.deepEqual(result.currentPrice, { amount: 117.85, currency: "CNY" });
  assert.equal(result.currentStock, 100);
  assert.equal(result.imageCount, 2);
  assert.deepEqual(result.mediaObservation, { sourceProtocol: "ozon-product-info-v3", primaryImageUrl: "https://cdn.ozon/main.jpg", images: ["https://cdn.ozon/detail.jpg"] });
  assert.deepEqual(result.inventoryObservation, { sourceProtocol: "ozon-product-stocks-by-warehouse-fbs-v2", hasNext: false, rows: [{ warehouseId: "70001", productId: "910001", sku: "810001", offerId: "SUP-MUSIC-001", freeStock: 100, present: 103, reserved: 3 }] });
  assert.equal(result.moderationStatus, "approved");
  assert.equal(result.validationStatus, "success");
  assert.equal(result.saleStatus, "unknown");
  assert.deepEqual(result.errors, []);
  assert.match(result.platformEvidenceRef, /^ozon-independent-readback:/);
});

test("exact warehouse readback uses free_stock and never derives it from aggregate or reserved quantities", async () => {
  const target = { warehouse_id: 70001, product_id: 910001, offer_id: "SUP-MUSIC-001", sku: 810001, free_stock: 80, present: 103, reserved: 3 };
  const foreign = { ...target, warehouse_id: 70002, free_stock: 100 };
  const cases = [
    [[{ ...target, free_stock: 0 }, foreign], 0], [[target, foreign], 80], [[foreign], "unknown"],
    [[{ ...target, warehouse_id: undefined }], "unknown"], [[target, target], "unknown"],
    ...[Number.MAX_SAFE_INTEGER + 1, "70001", "7.0001e4", true].map(warehouse_id => [[{ ...target, warehouse_id }], "unknown"]),
    ...[null, undefined, "80", false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(free_stock => [[{ ...target, free_stock }], "unknown"]),
    [[{ ...target, present: "103" }], "unknown"], [[{ ...target, reserved: null }], "unknown"],
    [[{ ...target, sku: undefined }], "unknown"], [[{ ...target, product_id: 999999 }], "unknown"],
    [[{ ...target, offer_id: "OTHER" }], "unknown"], [[], "unknown"]
  ];
  for (const [rows, expectedStock] of cases) {
    const responses = readbackResponses(); responses["/v2/product/info/stocks-by-warehouse/fbs"].products = rows;
    const calls=[];
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
      requestJson: async request => { calls.push(request); return structuredClone(responses[request.endpoint]); } });
    const result = await adapter.readbackSellerApi(independentReadbackQuery());
    assert.equal(result.currentStock, expectedStock, JSON.stringify(rows));
    assert.equal(result.inventoryObservation.rows.length, rows.length);
    assert.deepEqual(calls.at(-1).body,{offer_id:["SUP-MUSIC-001"],limit:10,cursor:""});
  }
  for(const has_next of [true,undefined,"false",null]) {
    const responses=readbackResponses();responses["/v2/product/info/stocks-by-warehouse/fbs"].has_next=has_next;let calls=0;
    const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async request=>{calls++;return responses[request.endpoint];}});
    const result=await adapter.readbackSellerApi(independentReadbackQuery());assert.equal(result.currentStock,"unknown");assert.equal(calls,4);
    assert.equal(result.inventoryObservation.hasNext,typeof has_next==='boolean'?has_next:'unknown');assert.equal(Object.hasOwn(result.inventoryObservation,'cursor'),false);
  }
});

test("readback preserves duplicate media and refuses ambiguous or contradictory product identity", async () => {
  for (const images of [["https://cdn.ozon/detail.jpg", "https://cdn.ozon/detail.jpg"], ["https://cdn.ozon/detail.jpg", "https://cdn.ozon/main.jpg"]]) {
    const responses = readbackResponses(); responses["/v3/product/info/list"].items[0].images = images;
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(), requestJson: async ({ endpoint }) => structuredClone(responses[endpoint]) });
    const result = await adapter.readbackSellerApi(independentReadbackQuery());
    assert.deepEqual(result.mediaObservation.images, images); assert.equal(result.imageCount, 3);
  }
  for (const endpoint of ["/v4/product/info/attributes", "/v3/product/info/list", "/v5/product/info/prices"]) {
    const responses = readbackResponses();
    const rows = endpoint === "/v4/product/info/attributes" ? responses[endpoint].result : responses[endpoint].items;
    rows.push(structuredClone(rows[0]));
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(), requestJson: async ({ endpoint }) => structuredClone(responses[endpoint]) });
    await assert.rejects(() => adapter.readbackSellerApi(independentReadbackQuery()), /IDENTITY_MISMATCH/);
  }
  const conflicting = readbackResponses(); conflicting["/v4/product/info/attributes"].result[0].product_id = 999999;
  const conflictingAdapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(), requestJson: async ({ endpoint }) => structuredClone(conflicting[endpoint]) });
  await assert.rejects(() => conflictingAdapter.readbackSellerApi(independentReadbackQuery()), /IDENTITY_MISMATCH: attributes/);
});

test('media reads the documented info arrays without relying on contradictory attribute image types', async () => {
  const responses = readbackResponses();
  responses['/v4/product/info/attributes'].result[0].images = [{ default: false, file_name: 'ambiguous.png', index: 1 }];
  responses['/v4/product/info/attributes'].result[0].primary_image = 'https://other.example/attribute-main.png';
  const calls = [], adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
    requestJson: async request => { calls.push(request); return structuredClone(responses[request.endpoint]); } });
  const result = await adapter.readbackSellerApi(independentReadbackQuery());
  assert.deepEqual(result.mediaObservation, { sourceProtocol: 'ozon-product-info-v3', primaryImageUrl: 'https://cdn.ozon/main.jpg', images: ['https://cdn.ozon/detail.jpg'] });
  assert.equal(result.imageCount, 2);
  assert.deepEqual(calls.map(call => call.endpoint), Object.values(OZON_DE_READBACK_ENDPOINTS));
  assert.ok(calls.every(call => call.write === false));
});

test('info media with missing, multiple or malformed primary images stays unknown without an attribute fallback', async () => {
  for (const primary of [undefined, null, [], ['https://cdn.ozon/main.jpg', 'https://cdn.ozon/other.jpg'],
    'https://cdn.ozon/main.jpg', [123], ['http://cdn.ozon/main.jpg']]) {
    const responses = readbackResponses(); responses['/v3/product/info/list'].items[0].primary_image = primary;
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: readyCapabilities(),
      requestJson: async request => structuredClone(responses[request.endpoint]) });
    const result = await adapter.readbackSellerApi(independentReadbackQuery());
    assert.equal(result.mediaObservation.primaryImageUrl, 'unknown'); assert.equal(result.imageCount, 'unknown');
    assert.deepEqual(result.mediaObservation.images, ['https://cdn.ozon/detail.jpg']);
  }
});

test("independent readback retains primary and ordered images with only the leading primary repetition normalized", async () => {
  for (const primaryInImages of [true, false]) {
    const responses = readbackResponses({ primaryInImages });
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({
      adapterCapabilities: readyCapabilities(),
      requestJson: async ({ endpoint }) => structuredClone(responses[endpoint])
    });
    const result = await adapter.readbackSellerApi({
      platform: "ozon",
      store: "dandanshu", ...executionBinding(),
      platformProductId: "910001",
      merchantSku: "SUP-MUSIC-001",
      supplierSkuId: "SUP-MUSIC-001",
      warehouseId: "70001", writeAllowed: false
    });
    assert.equal(result.imageCount, 2, `primaryInImages=${primaryInImages}`);
  }
});

test("independent readback uses actual info errors and never queries a fabricated failed-state filter", async () => {
  const driftResponses = readbackResponses();driftResponses["/v5/product/info/prices"].items[0].product_id = 999999;
  const driftAdapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async({endpoint})=>structuredClone(driftResponses[endpoint])});
  await assert.rejects(()=>driftAdapter.readbackSellerApi(independentReadbackQuery()),/IDENTITY_MISMATCH: prices/);
  const errors=[{code:'failed_update',level:'ERROR',message:'private user@example.com'}],responses=readbackResponses({infoErrors:errors}),calls=[];
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async({endpoint})=>{calls.push(endpoint);return structuredClone(responses[endpoint]);}});
  const observed=await adapter.readbackSellerApi(independentReadbackQuery());
  assert.deepEqual(observed.errors,[{code:'failed_update',level:'ERROR'}]);
  assert.equal(JSON.stringify(observed).includes('user@example.com'),false);
  assert.equal(calls.includes('/v3/product/list'),false);
});

test("missing or malformed info error lists stay unknown in independent readback", async () => {
  for (const value of [undefined, null, {}, ""]) {
    const responses = readbackResponses(),item=responses["/v3/product/info/list"].items[0];
    if(value===undefined)delete item.errors;else item.errors=value;
    const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async({endpoint})=>structuredClone(responses[endpoint])});
    assert.equal((await adapter.readbackSellerApi(independentReadbackQuery())).errors,'unknown');
  }
});

test("完整店铺映射、仓库和凭据漂移在任何请求前拒绝", async () => {
  const capabilities = readyCapabilities();
  let calls = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: capabilities, requestJson: async () => { calls += 1; throw new Error("must not run"); } });
  for (const change of [
    value => { value.storeRef.platformStoreId = "another"; }, value => { value.storeRef.mappingVersion = "another"; },
    value => { value.warehouseRef = "warehouse:another"; }, value => { value.credentialAlias = "credential:another"; }
  ]) {
    const request = executableRequest(); change(request);
    assert.equal((await adapter.executeSellerApi(request)).status, "rejected_before_write");
    await assert.rejects(() => adapter.readbackSellerApi({ ...request, platformProductId: "910001", warehouseId: "70001", writeAllowed: false }), /SCOPE_REJECTED/);
  }
  const wrongCredentialProof = capabilityInput(); wrongCredentialProof.storeIdentity.credentialAlias = "credential:another";
  assert.equal(inspectAdapterCapabilities(wrongCredentialProof).status, "not_ready");
  const wrongWarehouseProof = capabilityInput(); wrongWarehouseProof.inventoryWrite.storeRef.mappingVersion = "another";
  assert.equal(inspectAdapterCapabilities(wrongWarehouseProof).status, "not_ready");
  assert.equal(calls, 0);
});

test('invalid raw import task IDs remain unknown after exactly one write, with no fabricated task checkpoint',async()=>{
 for(const taskId of [Number.MAX_SAFE_INTEGER+1,'501','5.01e2','0x1f5',' 501 ','0501',true,false,0,-1,1.5,null]){
  const calls=[],checkpoints=[];
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:writeCapabilities,executionContext,requestJson:async request=>{calls.push(request);return {result:{task_id:taskId}};}});
  const result=await adapter.executeSellerApi(executableRequest(),{persistCheckpoint:async value=>checkpoints.push(value)});
  assert.equal(result.status,'unknown_outcome');assert.equal(result.writeOccurred,'unknown');assert.equal(result.layer,'product_import_receipt');assert.equal(result.retryAllowed,false);
  assert.deepEqual(calls.map(call=>call.endpoint),['/v3/product/import']);assert.deepEqual(checkpoints.map(value=>value.kind),['import_intent']);assert.equal(Object.hasOwn(result,'taskId'),false);
 }
});

test('noncanonical internal IDs and unsafe ready capabilities are rejected before platform reads',async()=>{
 const invalid=['9007199254740993','9007199254740992','9e5','0x10',' 910001 ','0910001',true,910001];
 for(const id of invalid){
  let calls=0;const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async()=>{calls++;throw new Error('must not request');}});
  await assert.rejects(()=>adapter.readbackSellerApi({platform:'ozon',store:'dandanshu',...executionBinding(),platformProductId:id,merchantSku:'SUP-MUSIC-001',supplierSkuId:'SUP-MUSIC-001',warehouseId:'70001',writeAllowed:false}),/READBACK_SCOPE_REJECTED/);assert.equal(calls,0);
  const input=capabilityInput();input.warehouseId=id;input.inventoryWrite.warehouseId=id;assert.equal(inspectAdapterCapabilities(input).status,'not_ready');
  const ready=structuredClone(readyCapabilities());ready.warehouseId=id;ready.inventoryWrite.warehouseId=id;
  assert.throws(()=>createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:ready,requestJson:async()=>{calls++;}}),/CAPABILITIES_NOT_READY/);assert.equal(calls,0);
 }
});

test('each E endpoint validates raw numeric product identity before requesting the next endpoint',async()=>{
 const ordered=Object.values(OZON_DE_READBACK_ENDPOINTS).filter(endpoint=>endpoint!==OZON_DE_READBACK_ENDPOINTS.stocks);
 for(let index=0;index<ordered.length;index++)for(const bad of [Number.MAX_SAFE_INTEGER+1,'910001',true]){
  const responses=readbackResponses(),endpoint=ordered[index];
  const rows=endpoint==='/v4/product/info/attributes'?responses[endpoint].result:responses[endpoint].items;
  rows[0].id=bad;rows[0].product_id=bad;const calls=[];
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async request=>{calls.push(request);return structuredClone(responses[request.endpoint]);}});
  await assert.rejects(()=>adapter.readbackSellerApi({platform:'ozon',store:'dandanshu',...executionBinding(),platformProductId:'910001',merchantSku:'SUP-MUSIC-001',supplierSkuId:'SUP-MUSIC-001',warehouseId:'70001',writeAllowed:false}),/READBACK_IDENTITY_MISMATCH/);
  assert.equal(calls.length,index+1);
 }
});

test('v3 capabilities exclude legacy stock aggregation and failed-state methods without relabeling old evidence',()=>{
 assert.ok(Object.isFrozen(OZON_DE_LEGACY_READBACK_ENDPOINTS));assert.equal(OZON_DE_LEGACY_READBACK_ENDPOINTS.stocks,'/v4/product/info/stocks');assert.equal(OZON_DE_LEGACY_READBACK_ENDPOINTS.stateFailed,'/v3/product/list');
 assert.equal(OZON_DE_READBACK_ENDPOINTS.stocks,'/v2/product/info/stocks-by-warehouse/fbs');assert.equal(Object.hasOwn(OZON_DE_READBACK_ENDPOINTS,'stateFailed'),false);
 const legacy=capabilityInput();legacy.independentReadback.protocolVersion='ozon-independent-readback-v1';legacy.independentReadback.endpoints=structuredClone(OZON_DE_LEGACY_READBACK_ENDPOINTS);
 assert.equal(inspectAdapterCapabilities(legacy).status,'not_ready');
 const ready=structuredClone(readyCapabilities());assert.equal(ready.adapterVersion,'ozon-seller-api-de-adapter-v3');assert.equal(ready.protocolVersion,'ozon-single-sku-d-e-v3');
 ready.adapterVersion='ozon-seller-api-de-adapter-v1';let calls=0;
 assert.throws(()=>createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:ready,requestJson:async()=>{calls++;}}),/CAPABILITIES_NOT_READY/);assert.equal(calls,0);
});

test('v5 price requires its documented numeric nested amount and exact currency without fallback',async()=>{
 for(const price of [true,'117.85',null,0,-1,Infinity,NaN]){
  const responses=readbackResponses();responses['/v5/product/info/prices'].items[0].price.price=price;
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async({endpoint})=>responses[endpoint]});
  await assert.rejects(()=>adapter.readbackSellerApi(independentReadbackQuery()),/PRICE_INVALID/);
 }
 for(const patch of [{price:117.85,currency_code:'CNY'},{price:{price:117.85},currency_code:'CNY'},{price:{price:117.85,currency_code:'RUB'}}]){
  const responses=readbackResponses();Object.assign(responses['/v5/product/info/prices'].items[0],patch);
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async({endpoint})=>responses[endpoint]});
  await assert.rejects(()=>adapter.readbackSellerApi(independentReadbackQuery()),/PRICE_INVALID/);
 }
});

test('human sale labels and contradictory media representations do not create an on-sale or media identity claim',async()=>{
 for(const saleStatus of ['Продается','selling','on_sale','active','не продается']){
  const responses=readbackResponses({saleStatus});responses['/v3/product/info/list'].items[0].statuses.moderate_status=true;responses['/v3/product/info/list'].items[0].statuses.validation_status=123;responses['/v3/product/info/list'].items[0].images=[{file_name:'https://cdn.ozon/detail.jpg'}];
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async({endpoint})=>responses[endpoint]});
  const result=await adapter.readbackSellerApi(independentReadbackQuery());assert.equal(result.saleStatus,'unknown');assert.equal(result.moderationStatus,'unknown');assert.equal(result.validationStatus,'unknown');assert.equal(result.mediaObservation.images,'unknown');assert.equal(result.imageCount,'unknown');
 }
});

test('exact warehouse responses above the requested ten-row limit stay unknown without paging or selecting the lone target',async()=>{
 const responses=readbackResponses(),target=responses[OZON_DE_READBACK_ENDPOINTS.stocks].products[0];
 responses[OZON_DE_READBACK_ENDPOINTS.stocks].products=[target,...Array.from({length:10},(_,index)=>({...target,warehouse_id:80000+index}))];
 const calls=[];
 const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:readyCapabilities(),requestJson:async call=>{calls.push(call);return structuredClone(responses[call.endpoint]);}});
 const observed=await adapter.readbackSellerApi(independentReadbackQuery());
 assert.equal(calls.length,4);assert.equal(calls.at(-1).body.limit,10);assert.equal(calls.at(-1).body.cursor,'');
 assert.equal(observed.currentStock,'unknown');assert.equal(observed.inventoryObservation.hasNext,'unknown');assert.deepEqual(observed.inventoryObservation.rows,[]);
});

function taskQuery(overrides = {}) {
  return { platform: 'ozon', store: 'dandanshu', ...executionBinding(), warehouseId: '70001', writeAllowed: false,
    taskId: '501', merchantSku: 'SUP-MUSIC-001', supplierSkuId: executableRequest().supplierSkuId,
    executionKey: executableRequest().executionKey, requestReceiptRef: 'ozon-import-receipt:synthetic', ...overrides };
}
function phasedAdapter(responses = {}, options = {}) {
  const calls = [], checkpoints = [];
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: writeCapabilities, executionContext,
    requestJson: async (request, controls = {}) => {
      if (controls.beforeRequestSend) await controls.beforeRequestSend();
      calls.push(request);
      if (Object.hasOwn(responses, request.endpoint)) return structuredClone(responses[request.endpoint]);
      if (request.endpoint === '/v3/product/import') return { result: { task_id: 501 } };
      if (request.endpoint === '/v1/product/import/info') return { result: { items: [{ offer_id: 'SUP-MUSIC-001', product_id: 910001, status: 'imported', errors: [] }] } };
      if (request.endpoint === '/v3/product/info/list') return { items: [{ offer_id: 'SUP-MUSIC-001', id: 910001, is_archived: false, is_autoarchived: false, statuses: { status: 'synthetic_price_sent' }, errors: [] }] };
      if (request.endpoint === OZON_DE_READBACK_ENDPOINTS.stocks) return readbackResponses()[request.endpoint];
      if (request.endpoint === '/v2/products/stocks') return { result: [{ offer_id: 'SUP-MUSIC-001', product_id: 910001, warehouse_id: 70001, updated: true, errors: [] }] };
      throw new Error('unexpected request');
    }, ...options });
  return { adapter, calls, checkpoints, persistCheckpoint: async event => checkpoints.push(event) };
}
async function prerequisiteObservations(fixture) {
  const query = taskQuery({ productId: '910001' });
  return { priceSentObservation: await fixture.adapter.observePriceSent(query),
    inventoryPrerequisiteObservation: await fixture.adapter.observeInventoryPrerequisites(query) };
}

test('price-sent evidence requires explicit non-archived flags before any stock write', async () => {
  for (const patch of [{ is_archived: true }, { is_autoarchived: true }, { is_archived: undefined },
    { is_autoarchived: undefined }, { is_archived: null }, { is_autoarchived: 'false' }]) {
    const item = { offer_id: 'SUP-MUSIC-001', id: 910001, is_archived: false, is_autoarchived: false,
      statuses: { status: 'synthetic_price_sent' }, errors: [], ...patch };
    const f = phasedAdapter({ '/v3/product/info/list': { items: [item] } });
    const observed = await f.adapter.observePriceSent(taskQuery({ productId: '910001' }));
    assert.equal(observed.priceSent, 'unknown');
    assert.deepEqual(f.calls.map(call => [call.endpoint, call.write]), [['/v3/product/info/list', false]]);
    assert.deepEqual(f.checkpoints, []);
  }
  const current = phasedAdapter();
  assert.equal((await current.adapter.observePriceSent(taskQuery({ productId: '910001' }))).priceSent, 'verified');
});

test('v2 inventory policy documents the removed field and preserves all other prerequisite requirements', () => {
  const policy = { ...structuredClone(prerequisitePolicy), schemaVersion: 'ozon-inventory-prerequisite-policy-v2',
    stockRequest: { identityField: 'offer_id', quantSize: 'not_applicable', officialEvidenceRef: OZON_STOCK_QUANT_SIZE_REMOVAL_REF } };
  assert.deepEqual(assertOzonInventoryPrerequisitePolicy(policy), policy);
  assert.equal(isCurrentInventoryPrerequisitePolicy(policy), true);
  for (const change of [
    value => { value.stockRequest.quantSize = null; }, value => { value.stockRequest.quantSize = 1; },
    value => { delete value.stockRequest.officialEvidenceRef; },
    value => { value.stockRequest.officialEvidenceRef = 'evidence:unverified:removal'; },
    value => { value.priceSent.acceptedValues = []; }, value => { value.reserved.endpoint = '/v4/product/info/stocks'; }
  ]) {
    const changed = structuredClone(policy); change(changed);
    assert.throws(() => assertOzonInventoryPrerequisitePolicy(changed), /OZON_DE_INVENTORY_POLICY_INVALID/);
  }
});

test('v2 stock requests omit quant_size for either supported identity field', async () => {
  for (const identityField of ['offer_id', 'product_id']) {
    const capabilities = structuredClone(writeCapabilities);
    capabilities.inventoryWrite.prerequisitePolicy = { ...structuredClone(prerequisitePolicy),
      schemaVersion: 'ozon-inventory-prerequisite-policy-v2', stockRequest: {
        identityField, quantSize: 'not_applicable', officialEvidenceRef: OZON_STOCK_QUANT_SIZE_REMOVAL_REF } };
    const f = phasedAdapter({}, { adapterCapabilities: capabilities }), observation = await prerequisiteObservations(f);
    f.calls.length = 0;
    const result = await f.adapter.executeRemainingInventory(executableRequest(), { observation,
      persistCheckpoint: f.persistCheckpoint, assertRemainingInventoryAuthorization: async () => {} });
    assert.equal(result.status, 'accepted');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].endpoint, '/v2/products/stocks');
    assert.deepEqual(f.calls[0].body, { stocks: [{ [identityField]: identityField === 'offer_id' ? 'SUP-MUSIC-001' : 910001,
      stock: executableRequest().stock, warehouse_id: 70001 }] });
    assert.equal(Object.hasOwn(f.calls[0].body.stocks[0], 'quant_size'), false);
    assert.deepEqual(f.checkpoints.map(value => value.kind), ['stock_intent', 'stock_receipt_observed']);
  }
});

test('historical v1 quant policy stays readable but cannot issue a current stock request or intent', async () => {
  for (const quantSize of [1, 2]) {
    const capabilities = structuredClone(writeCapabilities);
    const policy = capabilities.inventoryWrite.prerequisitePolicy;
    policy.stockRequest.quantSize = quantSize;
    assert.deepEqual(assertOzonInventoryPrerequisitePolicy(policy), policy);
    assert.equal(isCurrentInventoryPrerequisitePolicy(policy), false);
    const f = phasedAdapter({}, { adapterCapabilities: capabilities });
    await assert.rejects(() => f.adapter.observePriceSent(taskQuery({ productId: '910001' })), /OZON_DE_INVENTORY_POLICY_OUTDATED/);
    const result = await f.adapter.executeRemainingInventory(executableRequest(), { observation: null,
      persistCheckpoint: f.persistCheckpoint, assertRemainingInventoryAuthorization: async () => { throw new Error('must stop before authorization'); } });
    assert.equal(result.status, 'blocked'); assert.equal(result.code, 'inventory_prerequisite_policy_outdated');
    assert.equal(result.inventoryWriteState, 'not_sent'); assert.deepEqual(f.calls, []); assert.deepEqual(f.checkpoints, []);
  }
  assert.equal(isCurrentInventoryPrerequisitePolicy(prerequisitePolicy), true, 'a v1 policy that already omits quant_size retains its explicit behavior');
});

test('v3 import saves only the task receipt and waits without issuing a read or inventory write', async () => {
  for (const taskId of [501, Number.MAX_SAFE_INTEGER]) {
    const f = phasedAdapter({ '/v3/product/import': { result: { task_id: taskId } } });
    const result = await f.adapter.executeSellerApi(executableRequest(), { persistCheckpoint: f.persistCheckpoint });
    assert.equal(result.status, 'waiting_platform'); assert.equal(result.taskId, String(taskId)); assert.equal(result.productId, null);
    assert.equal(result.inventoryWriteState, 'not_sent'); assert.equal(Object.hasOwn(result, 'inventoryReceiptRef'), false);
    assert.deepEqual(f.checkpoints.map(value => value.kind), ['import_intent', 'import_task_received']);
    assert.deepEqual(f.calls.map(value => value.endpoint), ['/v3/product/import']);
    await f.adapter.observeImportTask(taskQuery({ taskId: result.taskId, requestReceiptRef: result.requestReceiptRef }));
    assert.deepEqual(f.calls[1].body, { task_id: taskId }); assert.equal(f.calls[1].write, false);
  }
});

test('official task states remain distinct and task observations never query inventory', async () => {
  for (const [status, product_id, errors, classification, gapCode] of [
    ['pending', 0, [], 'waiting_platform', null], ['pending', undefined, [], 'waiting_platform', null],
    ['imported', 910001, [], 'imported', null], ['failed', 0, [{ code: 'platform-failure' }], 'platform_failed', null],
    ['skipped', 910001, [], 'platform_skipped', null], ['invented secret status', 910001, [], 'unknown_outcome', 'import_task_status_unknown'],
    ['pending', 0, [{}], 'unknown_outcome', 'import_task_errors_present'], ['imported', 910001, [{}], 'unknown_outcome', 'import_task_errors_present']
  ]) {
    const item = { offer_id: 'SUP-MUSIC-001', status, errors, ...(product_id === undefined ? {} : { product_id }) };
    const f = phasedAdapter({ '/v1/product/import/info': { result: { items: [item] } } });
    const result = await f.adapter.observeImportTask(taskQuery());
    assert.equal(result.classification, classification); assert.equal(result.gapCode, gapCode);
    assert.deepEqual(result.inventoryPrerequisites, { priceSent: 'unknown', reservedObservation: 'not_queried' });
    assert.deepEqual(f.calls.map(value => value.endpoint), ['/v1/product/import/info']);
    assert.equal(JSON.stringify(result).includes('invented secret status'), false);
  }
});

test('malformed task identity and errors stay unknown without any subsequent request', async () => {
  for (const patch of [
    ...[Number.MAX_SAFE_INTEGER + 1, '910001', true, -1, 1.5, null].map(product_id => ({ product_id })),
    { product_id: Number('9007199254740993'), id: Number('9007199254740993') },
    { offer_id: 12345 }, { offer_id: 'other' }, { errors: null }
  ]) {
    const f = phasedAdapter({ '/v1/product/import/info': { result: { items: [{ offer_id: 'SUP-MUSIC-001', product_id: 910001, status: 'imported', errors: [], ...patch }] } } });
    const result = await f.adapter.observeImportTask(taskQuery());
    assert.equal(result.classification, 'unknown_outcome'); assert.ok(result.gapCode); assert.equal(f.calls.length, 1);
  }
});

test('observation scope, cancellation, and hook failures stop before subsequent requests', async () => {
  const f = phasedAdapter();
  for (const patch of [{ taskId: '9e5' }, { taskId: '9007199254740993' }, { taskId: true }, { warehouseId: 'other' },
    { credentialAlias: 'credential:other' }, { writeAllowed: true }, { requestReceiptRef: '' }]) {
    await assert.rejects(() => f.adapter.observeImportTask(taskQuery(patch)), /SCOPE_REJECTED/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => f.adapter.observeImportTask(taskQuery(), { signal: controller.signal }));
  const failure = new Error('saved intent rejected');
  await assert.rejects(() => f.adapter.observeImportTask(taskQuery(), { beforeRequestSend: async () => { throw failure; } }), error => error === failure);
  assert.equal(f.calls.length, 0);
});

test('separate observed prerequisites allow exactly the remaining stock write under synthetic sourced policy', async () => {
  const f = phasedAdapter(), observation = await prerequisiteObservations(f); let guards = 0;
  const result = await f.adapter.executeRemainingInventory(executableRequest(), { observation, persistCheckpoint: f.persistCheckpoint,
    assertRemainingInventoryAuthorization: async () => { guards += 1; } });
  assert.equal(result.status, 'accepted'); assert.equal(guards, 2);
  assert.deepEqual(f.calls.map(value => value.endpoint), ['/v3/product/info/list', OZON_DE_READBACK_ENDPOINTS.stocks, '/v2/products/stocks']);
  assert.deepEqual(f.calls.at(-1).body, { stocks: [{ offer_id: 'SUP-MUSIC-001', stock: 100, warehouse_id: 70001 }] });
  assert.deepEqual(f.checkpoints.map(value => value.kind), ['stock_intent', 'stock_receipt_observed']);
});

test('missing policy, forged success, policy drift, and incomplete reserved facts never create stock intent', async () => {
  const f = phasedAdapter(), base = await prerequisiteObservations(f); f.calls.length = 0;
  const variants = [structuredClone(base), structuredClone(base), structuredClone(base), structuredClone(base)];
  variants[0].priceSentObservation.priceSent = 'unknown'; variants[1].priceSentObservation.policy.version = 'other-version';
  variants[2].inventoryPrerequisiteObservation.inventoryObservation.hasNext = true;
  variants[3].inventoryPrerequisiteObservation.inventoryObservation.rows[0].reserved = 'unknown';
  for (const observation of variants) {
    const result = await f.adapter.executeRemainingInventory(executableRequest(), { observation, persistCheckpoint: f.persistCheckpoint,
      assertRemainingInventoryAuthorization: async () => {} });
    assert.equal(result.status, 'blocked'); assert.equal(result.inventoryWriteState, 'not_sent');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.length, 0);
});

/**
 * 库存前提（priceSent.acceptedValues 至今没有官方来源）只在发库存那一步才用得上。
 * 它以前被算进「能力就绪」，于是把商品导入本身也一起挡住了；现在导入放行，发库存照旧挡死。
 * 这条测试就是那道搬家的闸门：任何一头松了都会红。
 */
test('inventory prerequisite policy no longer blocks product import, and still blocks the stock write', async () => {
  const input = capabilityInput(); delete input.inventoryWrite.prerequisitePolicy;
  const capabilities = inspectAdapterCapabilities(input);
  assert.equal(capabilities.status, 'ready');
  assert.equal(capabilities.gaps.length, 0);
  assert.equal(capabilities.inventoryWrite.prerequisitePolicy, null);

  const withPolicy = phasedAdapter(), observation = await prerequisiteObservations(withPolicy);
  const policyless = phasedAdapter({}, { adapterCapabilities: inspectAdapterCapabilities({
    ...capabilityInput({ assets: formalExecution.prepared.executableRequest.finalUploads,
      host: new URL(formalExecution.prepared.executableRequest.finalUploads[0].platformAcceptedUrl).hostname }),
    inventoryWrite: { ...writeCapabilities.inventoryWrite, status: 'verified', protocolVersion: 'ozon-products-stocks-v2',
      evidenceRef: 'evidence:protocol:inventory', prerequisitePolicy: undefined } }) });
  policyless.calls.length = 0;

  // 导入这一步照常走完：证明挡住主人的确实只是那条搬走的检查。
  const imported = await policyless.adapter.executeSellerApi(executableRequest(), { persistCheckpoint: policyless.persistCheckpoint });
  assert.equal(imported.status, 'waiting_platform');

  // 发库存这一步一步都不让过，而且没有产生任何库存意图。
  await assert.rejects(() => policyless.adapter.observePriceSent(taskQuery({ productId: '910001' })), /OZON_DE_INVENTORY_POLICY_NOT_VERIFIED/);
  const blocked = await policyless.adapter.executeRemainingInventory(executableRequest(), { observation,
    persistCheckpoint: policyless.persistCheckpoint, assertRemainingInventoryAuthorization: async () => {} });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'inventory_prerequisite_policy_not_verified');
  assert.equal(blocked.inventoryWriteState, 'not_sent');
  assert.equal(policyless.checkpoints.some(event => event.kind === 'stock_intent'), false);
  assert.equal(policyless.calls.some(call => call.endpoint === '/v2/products/stocks'), false);
});

test('continuation authorization is required and checked again after stock intent', async () => {
  for (const failAt of [1, 2]) {
    const f = phasedAdapter(), observation = await prerequisiteObservations(f); f.calls.length = 0; let guards = 0;
    const failure = new Error('D_EXECUTION_CONTINUATION_BLOCKED');
    await assert.rejects(() => f.adapter.executeRemainingInventory(executableRequest(), { observation, persistCheckpoint: f.persistCheckpoint,
      assertRemainingInventoryAuthorization: async () => { if (++guards === failAt) throw failure; } }), error => error === failure);
    assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.length, failAt - 1);
  }
});

test('stock response identity corruption remains unknown after one sent stock request', async () => {
  for (const patch of [...[Number.MAX_SAFE_INTEGER + 1, '910001', true, 0].map(product_id => ({ product_id })),
    ...[Number.MAX_SAFE_INTEGER + 1, '70001', true, 0].map(warehouse_id => ({ warehouse_id })), { offer_id: 12345 }]) {
    const f = phasedAdapter({ '/v2/products/stocks': { result: [{ offer_id: 'SUP-MUSIC-001', product_id: 910001, warehouse_id: 70001, updated: true, errors: [], ...patch }] } });
    const observation = await prerequisiteObservations(f); f.calls.length = 0;
    const result = await f.adapter.executeRemainingInventory(executableRequest(), { observation, persistCheckpoint: f.persistCheckpoint,
      assertRemainingInventoryAuthorization: async () => {} });
    assert.equal(result.status, 'unknown_outcome'); assert.equal(result.writeOccurred, 'unknown');
    assert.equal(result.layer, 'inventory_write_receipt'); assert.equal(f.calls.length, 1);
  }
});

test('legacy v2 requests cannot import and expiration is rechecked after the import intent', async () => {
  const f = phasedAdapter(), legacy = executableRequest(); delete legacy.executionProtocolVersion;
  assert.equal((await f.adapter.executeSellerApi(legacy, { persistCheckpoint: f.persistCheckpoint })).status, 'rejected_before_write');
  assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.length, 0);
  let now = executionContext.serverClock();
  const g = phasedAdapter({}, { executionContext: { ...executionContext, serverClock: () => now } });
  const result = await g.adapter.executeSellerApi(executableRequest(), { persistCheckpoint: async event => {
    if (event.kind === 'import_intent') now = executionContext.productionPlan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview.expiresAt;
  } });
  assert.equal(result.status, 'rejected_before_write'); assert.equal(g.calls.length, 0);
});
