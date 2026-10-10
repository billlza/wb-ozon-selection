import { authorizedProductionFixture, historicalAuthorizedProductionFixture } from "./c2-software-fixture.mjs";
import { createProductionPlan, projectProductionPlanInputs, fingerprintProductionAuthorization, assertValidProductionPlan } from "../../lib/production-plan.mjs";
import { runPlatformWritePreflight } from "../../lib/platform-write-preflight.mjs";
import { beginDSoftwareExecution, executeDSoftwareAttempt, prepareSingleSkuDExecution } from "../../lib/d-e-software-closure.mjs";

export const ALL_WRITE_FIELDS = [
  "create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"
];

/** Synthetic current configuration, derived from the authorization created by the formal fixture. */
export function currentProductionBindingFixture(authorization) {
  const scope = authorization.lockedScope;
  return { ...structuredClone(authorization.executionBinding), platform: scope.platform, storeRef: structuredClone(scope.storeRef),
    storeName: "合成测试店铺", warehouseName: "合成测试仓库", warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias,
    verification: { evidenceRef: "evidence:synthetic:production-binding", checkedAt: "2026-08-22T00:00:00.000Z", expiresAt: "2026-08-23T00:00:00.000Z" } };
}

/** Synthetic historical DTO: readable old contract, never admitted by the current constructor. */
export function historicalPlanFixture(options = {}) {
  const fixture = historicalAuthorizedProductionFixture(options);
  const authorization = fixture.productionAuthorization;
  const plan = { schemaVersion: "production-plan-v1.1",
    planId: `production-plan:${authorization.authorizationId}:${fingerprintProductionAuthorization(authorization).slice(0, 12)}`,
    mode: "simulation", status: "prepared", createdAt: fixture.createdAt, sourceAuthorization: structuredClone(authorization),
    sourceReadPolicy: "authorization_snapshot_only", sourceDataAccess: "production_authorization_only",
    productResearchPerformed: false, platformWrites: 0, productCreated: false, assetsUploaded: 0, readbackPerformed: false };
  assertValidProductionPlan(plan);
  return { fixture, authorization, plan };
}

/**
 * identityVia 复刻两个真实生产者：null 是原路径（观测到店铺引用）；'scoped_warehouse' 是主人2026-09-16定的
 * 仓库反推（Ozon 不发店铺编号，观察引用恒为 null）；'none' 复刻 ozon-de-preflight-provider 的兜底检查
 * （什么都没查到，引用为 null 且状态 unverified）。
 */
export async function preflightFixture(plan, { store = projectProductionPlanInputs(plan).store, writableFields = ALL_WRITE_FIELDS, identityVia = null } = {}) {
  const inputs = projectProductionPlanInputs(plan);
  const refless = identityVia === "scoped_warehouse" || identityVia === "none";
  return runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-22T07:10:00.000Z",
    inspectPlatform: async () => ({
      observedStore: store,
      observedStoreRef: refless ? null : { ...structuredClone(inputs.storeRef), stableStoreId: store },
      ...(identityVia === null ? {} : { storeIdentityVia: identityVia }),
      storeIdentityStatus: identityVia === "none" ? "unverified" : store === inputs.store ? "matched" : "mismatched",
      storeIdentityEvidenceRef: `evidence:seller-api:store:${store}`,
      permissionStatus: "verified",
      permissionEvidenceRef: "evidence:seller-api:permission",
      connections: {
        api: { status: "connected", checkedVia: "seller_api_read_only", evidenceRef: "evidence:seller-api:connection" },
        sellerBackend: { status: "connected", checkedVia: "seller_backend_read_only", evidenceRef: "evidence:seller-backend:connection" }
      },
      platformWritableFields: writableFields,
      imagePermissionStatus: "verified",
      imagePermissionEvidenceRef: "evidence:seller-api:image-permission",
      priceFieldCurrency: "CNY",
      priceCurrencyEvidenceRef: "evidence:seller-api:currency:CNY",
      risks: []
    })
  });
}

export function capabilities(store = "dandanshu", finalUploads = [], binding = {
  storeRef: { stableStoreId: store, platformStoreId: `seller-${store}-001`, mappingVersion: "stores-v1" },
  warehouseRef: "warehouse:synthetic:ozon", credentialAlias: "credential-alias:synthetic:ozon"
}) {
  const resolvedAssets = finalUploads.map((asset) => ({
    assetId: asset.assetId,
    platformAcceptedUrl: asset.assetRef,
    sha256: asset.sha256,
    order: asset.order,
    authorizationStatus: "approved",
    stable: true,
    evidenceRef: `evidence:asset:${asset.assetId}`
  }));
  return {
    status: "ready",
    platform: "ozon",
    store,
    storeRef: structuredClone(binding.storeRef), warehouseRef: binding.warehouseRef, credentialAlias: binding.credentialAlias,
    adapterVersion: "ozon-seller-api-de-adapter-v3",
    protocolVersion: "ozon-single-sku-d-e-v3",
    evidenceRef: "evidence:adapter:contract-test",
    productImport: { status: "verified", evidenceRef: "evidence:protocol:product-import" },
    assetTransport: {
      status: "verified",
      evidenceRef: "evidence:protocol:asset-transport",
      approvedHosts: ["assets.example.com"],
      resolvedAssets
    },
    inventoryWrite: {
      status: "verified",
      endpoint: "/v2/products/stocks",
      warehouseId: "70001", storeRef: structuredClone(binding.storeRef), warehouseRef: binding.warehouseRef, credentialAlias: binding.credentialAlias,
      protocolVersion: "fixture-inventory-v1",
      evidenceRef: "evidence:protocol:inventory",
      prerequisitePolicy: {
        schemaVersion: 'ozon-inventory-prerequisite-policy-v1', policyId: 'fixture:inventory-policy',
        version: 'fixture-v1', officialEvidenceRef: 'fixture:inventory-contract',
        priceSent: { endpoint: '/v3/product/info/list', field: 'statuses.status', acceptedValues: ['price_sent'] },
        reserved: { endpoint: '/v2/product/info/stocks-by-warehouse/fbs', sourceProtocol: 'ozon-product-stocks-by-warehouse-fbs-v2' },
        stockRequest: { identityField: 'offer_id', quantSize: null }
      }
    },
    independentReadback: { status: "verified", evidenceRef: "evidence:protocol:readback" }
  };
}

export async function preparedFixture(options = {}) {
  const fixture = authorizedProductionFixture(options);
  const authorization = fixture.productionAuthorization;
  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  const preflight = await preflightFixture(plan, options.preflight || {});
  const currentProductionBinding = currentProductionBindingFixture(authorization);
  const prepared = prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    adapterCapabilities: options.adapterCapabilities || capabilities(inputs.store, inputs.finalUploads, inputs),
    currentProductionBinding,
    preparedAt: "2026-08-22T07:15:00.000Z"
  });
  const executionContext = { productionPlan: plan, currentProductionBinding, serverClock: () => "2026-08-22T07:25:00.000Z" };
  return { fixture, authorization, plan, preflight, prepared, currentProductionBinding, executionContext };
}

export function exactObservation(request, overrides = {}) {
  const expectation = request.executionMode === "single_sku_seller_api" ? request.readbackExpectation : request.independentReadback.expectation;
  const urls = expectation.media.map(asset => asset.submittedUrl);
  return {
    platform: request.platform,
    store: request.store,
    storeRef: structuredClone(request.storeRef), warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias,
    skuPackageId: request.skuPackageId,
    supplierSkuId: request.supplierSkuId,
    merchantSku: request.merchantSku,
    platformProductId: "910001",
    currentPrice: structuredClone(request.platformWritePrice || request.expectedPrice),
    currentStock: 100,
    imageCount: request.finalUploads?.length ?? request.expectedImageCount,
    mediaObservation: { sourceProtocol: "ozon-product-attributes-v4", primaryImageUrl: urls[0], images: urls.slice(1) },
    inventoryObservation: { sourceProtocol: "ozon-product-stocks-by-warehouse-fbs-v2", hasNext: false,
      rows: [{ warehouseId: expectation.warehouseId, productId: overrides.platformProductId ?? "910001", sku: "1910001",
        offerId: request.merchantSku, freeStock: 100, present: 100, reserved: 0 }] },
    moderationStatus: "in_moderation",
    validationStatus: "processing",
    saleStatus: "not_for_sale",
    errors: [],
    platformEvidenceRef: "evidence:seller-api:readback:910001",
    ...overrides
  };
}

export async function successfulExecution() {
  const { prepared, executionContext } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T07:20:00.000Z" });
  const result = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executionContext,
    executeSellerApi: async (request) => ({
      status: "accepted",
      productId: "910001",
      offerId: request.merchantSku,
      requestReceiptRef: "receipt:product-import:910001",
      inventoryReceiptRef: "receipt:inventory:910001"
    }),
    readbackSellerApi: async (request) => exactObservation(attempt.request, { platformProductId: request.platformProductId }),
    completedAt: "2026-08-22T07:25:00.000Z"
  });
  return { attempt, result, executionContext };
}
