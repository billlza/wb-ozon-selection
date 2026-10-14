import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { currentProductionBindingFixture } from "./helpers/d-software-fixture.mjs";
import { authorizedProductionFixture, packageFixture } from "./helpers/c2-software-fixture.mjs";
import {
  executeSingleSkuDraftCreation,
  PRODUCTION_RECORD_VERSION,
  validateProductionRecord
} from "../lib/draft-production-execution.mjs";
import {
  createProductionPlan, projectProductionPlanInputs,
  fingerprintProductionPlan
} from "../lib/production-plan.mjs";
import { ozonProductionConnectionRequirements } from "../lib/ozon-production-strategy.mjs";

function planAndPreflight(options = {}) {
  const fixture = authorizedProductionFixture({ publishScope: "create_draft_only", ...options });
  const authorization = fixture.productionAuthorization;
  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  const preflight = {
    schemaVersion: "platform-write-preflight-v1.1",
    preflightId: "platform-preflight:TEST-SKU-001",
    sourceProductionPlanId: plan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(plan),
    targetPlatform: "ozon",
    storeIdentity: {
      expectedStore: "dandanshu",
      observedStore: "dandanshu",
      expectedStoreRef: structuredClone(inputs.storeRef), observedStoreRef: structuredClone(inputs.storeRef),
      status: "matched",
      evidenceRef: "test:store-identity"
    },
    permission: { status: "verified", evidenceRef: "test:permission" },
    connectionStatus: {
      api: { status: "connected", checkedVia: "test_read_only", evidenceRef: "test:api" },
      sellerBackend: { status: "connected", checkedVia: "test_read_only", evidenceRef: "test:backend" }
    },
    authorizedWriteFields: [...inputs.allowedWriteFields],
    platformWritableFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
    effectiveWritableFields: inputs.allowedWriteFields.filter(field => field !== "description"),
    imagePermission: { status: "verified", evidenceRef: "test:image-permission" },
    priceCurrency: { expected: "CNY", observed: "CNY", status: "matched", evidenceRef: "test:currency" },
    risks: [],
    technicalStatus: "completed",
    businessStateEffect: "none",
    checkedAt: "2026-08-22T07:06:00.000Z",
    readyForPlatformWrite: false,
    productCreated: false,
    imagesUploaded: 0,
    inventoryModified: false,
    storeDataModified: false,
    productionRecordCreated: false,
    platformWrites: 0
  };
  return { authorization, plan, inputs, preflight };
}

test("13B-2 creates exactly one draft and saves the returned platform product ID", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight();
  let callCount = 0;
  let payload;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    platformWritePreflight: preflight,
    executedAt: "2026-08-22T07:10:00.000Z",
    createPlatformDraft: async (value) => {
      callCount += 1;
      payload = value;
      assert.equal(payload.schemaWriteBindings.schemaRevision, "ozon-schema:17028665:92935:2026-08-12");
      return {
        status: "draft",
        productId: "OZON-DRAFT-1001",
        offerId: "TEST-SKU-001",
        writeEvidenceRef: "ozon:draft-create:task-1001",
        published: false,
        activated: false,
        advertisingOpened: false,
        inventoryModified: true,
        imagesUploaded: 2
      };
    },
    readbackPlatformDraft: async () => ({
      status: "draft",
      productId: "OZON-DRAFT-1001",
      title: inputs.title,
      price: inputs.platformWritePrice,
      stock: 100,
      finalUploadAssetIds: inputs.finalUploads.map(asset => asset.assetId),
      mainImageAssetId: inputs.finalUploads[0].assetId,
      evidenceRef: "ozon:draft-readback:OZON-DRAFT-1001",
      published: false,
      activated: false,
      moderationSubmitted: false
    })
  });
  assert.equal(callCount, 1);
  assert.equal(payload.batchSize, 1);
  assert.equal(payload.supplierSkuId, "SHELF-WHITE");
  assert.equal(payload.title, inputs.title);
  assert.deepEqual(payload.content, inputs.content);
  assert.deepEqual(payload.packing, inputs.packing);
  assert.deepEqual(payload.attributes, inputs.attributes);
  assert.deepEqual(payload.buyerTargetPrice, inputs.buyerTargetPrice);
  assert.deepEqual(payload.platformWritePrice, inputs.platformWritePrice);
  assert.equal(payload.publishScope, "create_draft_only");
  assert.equal(payload.publish, false);
  assert.equal(payload.activate, false);
  assert.equal(payload.openAdvertising, false);
  assert.equal(payload.writeInventory, true);
  assert.equal(payload.uploadImages, true);
  assert.equal(payload.stock, 100);
  assert.deepEqual(payload.finalUploads, inputs.finalUploads);

  const record = result.productionRecord;
  assert.equal(record.schemaVersion, PRODUCTION_RECORD_VERSION);
  assert.equal(record.status, "draft");
  assert.equal(record.platformProductId, "OZON-DRAFT-1001");
  assert.equal(record.batchSize, 1);
  assert.deepEqual(validateProductionRecord(record), { valid: true, errors: [] });
});

test("legacy draft entry cannot bypass the current owner-frozen production configuration", async () => {
  const { authorization, plan, preflight } = planAndPreflight();
  const binding = currentProductionBindingFixture(authorization); let writes = 0; let readbacks = 0;
  for (const currentProductionBinding of [null, { ...binding, configurationVersion: "config-v2" }, { ...binding, warehouseId: "70002" }]) {
    await assert.rejects(() => executeSingleSkuDraftCreation({ productionPlan: plan, productionAuthorization: authorization,
      platformWritePreflight: preflight, currentProductionBinding, executedAt: "2026-08-22T07:10:00.000Z",
      createPlatformDraft: async () => { writes += 1; throw new Error("must not write"); },
      readbackPlatformDraft: async () => { readbacks += 1; throw new Error("must not read"); } }), /PRODUCTION_EXECUTION_BINDING_/);
  }
  assert.equal(writes, 0); assert.equal(readbacks, 0);
});

test("13B-2 reads only ProductionPlan fields and cannot expand into A/B/C, images, inventory, publish, activate or advertising", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight();
  let keys;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    platformWritePreflight: preflight,
    executedAt: "2026-08-22T07:10:00.000Z",
    createPlatformDraft: async (payload) => {
      keys = Object.keys(payload);
      return { status: "draft", productId: "1002", writeEvidenceRef: "test:draft:1002" };
    },
    readbackPlatformDraft: async () => ({
      status: "draft", productId: "1002", title: inputs.title, price: inputs.platformWritePrice, stock: 100,
      finalUploadAssetIds: inputs.finalUploads.map(asset => asset.assetId), mainImageAssetId: inputs.finalUploads[0].assetId, evidenceRef: "test:readback:1002"
    })
  });
  for (const forbidden of ["salesSnapshot", "profitModel", "c1ProductPlan", "c2FinalAssets"]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(result.productionRecord.writtenFields, ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"]);
  assert.equal(result.productionRecord.published, false);
  assert.equal(result.productionRecord.activated, false);
  assert.equal(result.productionRecord.advertisingOpened, false);
  assert.equal(result.productionRecord.inventoryModified, true);
  assert.equal(result.productionRecord.stockWritten, 100);
  assert.equal(result.productionRecord.imagesUploaded, 2);
  assert.deepEqual(result.productionRecord.finalUploadAssetIds, inputs.finalUploads.map(asset => asset.assetId));
  assert.equal(result.productionRecord.independentReadbackVerified, true);
  assert.equal(result.otherSkuExecuted, false);
});

test("13B-2 creates one product for validation/moderation without inventory or activation", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight({
    publishScope: "create_and_allow_validation_moderation",
    exclusions: ["no_publish_or_activation", "no_inventory_write", "no_warehouse_or_logistics_change", "no_promotion_change", "no_advertising_change", "no_other_sku_write"],
    allowedWriteFields: ["create_product", "title", "attributes", "price", "assets.finalUploads", "publish_scope"]
  });
  let payload;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    platformWritePreflight: preflight,
    executedAt: "2026-08-22T08:05:00.000Z",
    createPlatformDraft: async (value) => {
      payload = value;
      return { status: "validation_or_moderation", productId: "OZON-2001", offerId: "TEST-SKU-001", writeEvidenceRef: "test:write:2001", moderationSubmitted: true, published: false, activated: false };
    },
    readbackPlatformDraft: async () => ({
      status: "validation_or_moderation", productId: "OZON-2001", title: inputs.title, price: inputs.platformWritePrice,
      inventoryModified: false, finalUploadAssetIds: inputs.finalUploads.map(asset => asset.assetId), mainImageAssetId: inputs.finalUploads[0].assetId,
      evidenceRef: "test:readback:2001", moderationSubmitted: true, published: false, activated: false
    })
  });
  assert.equal(payload.mode, "single_sku_create_and_moderate");
  assert.equal(payload.writeInventory, false);
  assert.equal(payload.publish, false);
  assert.equal(payload.activate, false);
  assert.equal(result.productionRecord.status, "validation_or_moderation");
  assert.equal(result.productionRecord.inventoryModified, false);
  assert.equal(result.productionRecord.stockWritten, null);
  assert.deepEqual(result.productionRecord.writtenFields, ["create_product", "title", "attributes", "price", "assets.finalUploads", "publish_scope"]);
  assert.deepEqual(validateProductionRecord(result.productionRecord), { valid: true, errors: [] });
});

test("13B-2 rejects changed authorization before the platform adapter is called", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight();
  const changed = authorizedProductionFixture({ publishScope: "create_draft_only", merchantSku: "MERCHANT-CHANGED" }).productionAuthorization;
  let calls = 0;
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: changed,
    platformWritePreflight: preflight,
    executedAt: "2026-08-22T07:10:00.000Z",
    createPlatformDraft: async () => { calls += 1; },
    readbackPlatformDraft: async () => { calls += 1; }
  }), /AUTHORIZATION_VERSION_CHANGED/);
  assert.equal(calls, 0);
});

test("13B-2 rejects unknown required attributes and stale preflight without calling the platform", async () => {
  const first = planAndPreflight();
  const sourceSkuPackage = packageFixture({ stableStoreId: "dandanshu", executableOzon: true });
  sourceSkuPackage.c1ProductPlan.productAttributes.requiredPlatformFields[0].fact = { value: "unknown", verificationStatus: "unknown", sourceRefs: [] };
  let calls = 0;
  assert.throws(() => {
    const invalid = planAndPreflight({ sourceSkuPackage });
    calls += 1;
    return invalid;
  }, /C2素材包校验失败|ProductionAuthorization|INPUT_GAP/);
  assert.equal(calls, 0);

  const stalePreflight = structuredClone(first.preflight);
  stalePreflight.sourceProductionPlanFingerprint = "b".repeat(64);
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: first.plan,
    productionAuthorization: first.authorization,
    platformWritePreflight: stalePreflight,
    executedAt: "2026-08-22T07:10:00.000Z",
    createPlatformDraft: async () => { calls += 1; },
    readbackPlatformDraft: async () => { calls += 1; }
  }), /DRAFT_PREFLIGHT_STALE/);
  assert.equal(calls, 0);
});

test("13B-2 店铺身份认两条锚：仓库反推放行，非仓库锚点仍要求观察到的店铺引用", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight();
  const warehouseAnchored = structuredClone(preflight);
  // 仓库反推只出现在当前版本的前检记录上；v1.1 是历史结果，不追认锚点。
  warehouseAnchored.schemaVersion = "platform-write-preflight-v1.2";
  warehouseAnchored.connectionRequirements = ozonProductionConnectionRequirements("seller_api");
  Object.assign(warehouseAnchored.storeIdentity, { verifiedVia: "scoped_warehouse", observedStoreRef: null });

  let writes = 0;
  const run = (platformWritePreflight) => executeSingleSkuDraftCreation({
    productionPlan: plan, productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    platformWritePreflight, executedAt: "2026-08-22T07:10:00.000Z",
    createPlatformDraft: async () => { writes += 1; return { status: "draft", productId: "OZON-DRAFT-3001", offerId: "TEST-SKU-001",
      writeEvidenceRef: "test:write:3001", published: false, activated: false, advertisingOpened: false, inventoryModified: true, imagesUploaded: 2 }; },
    readbackPlatformDraft: async () => ({ status: "draft", productId: "OZON-DRAFT-3001", title: inputs.title, price: inputs.platformWritePrice,
      stock: 100, finalUploadAssetIds: inputs.finalUploads.map(asset => asset.assetId), mainImageAssetId: inputs.finalUploads[0].assetId,
      evidenceRef: "test:readback:3001", published: false, activated: false, moderationSubmitted: false })
  });

  // 放行方向：Ozon 不发店铺编号，observedStoreRef 为 null 是正确状态，不该再挡写入。
  assert.equal((await run(warehouseAnchored)).productionRecord.platformProductId, "OZON-DRAFT-3001");
  assert.equal(writes, 1);

  // 拦截方向：非仓库锚点下（未声明、明写原路径、none）少了观察引用，或引用对不上，都必须在调用平台前拦住。
  for (const via of [undefined, "platform_store_id", "none"]) {
    const bare = structuredClone(warehouseAnchored);
    bare.storeIdentity.observedStoreRef = null;
    if (via === undefined) delete bare.storeIdentity.verifiedVia; else bare.storeIdentity.verifiedVia = via;
    await assert.rejects(() => run(bare), /DRAFT_PREFLIGHT_NOT_READY|PlatformWritePreflight校验失败/, String(via));
  }
  const otherStore = structuredClone(preflight);
  otherStore.storeIdentity.observedStoreRef = { ...structuredClone(inputs.storeRef), platformStoreId: "seller-miska-001" };
  await assert.rejects(() => run(otherStore), /DRAFT_PREFLIGHT_NOT_READY|PlatformWritePreflight校验失败/);

  // 锁：声称仓库反推、同时又带着店铺引用，不得因为这次改动变成合法。
  const contradictory = structuredClone(warehouseAnchored);
  contradictory.storeIdentity.observedStoreRef = structuredClone(inputs.storeRef);
  await assert.rejects(() => run(contradictory), /PlatformWritePreflight校验失败/);

  // 锁：'none' 就是没有锚点。后人顺手把 observedStoreRef 补成一个真实可对上的引用（Ozon 从不返回
  // 店铺编号，只可能是人手填的），也不得走到真实写入那一步。
  const noneWithRef = structuredClone(warehouseAnchored);
  Object.assign(noneWithRef.storeIdentity, { verifiedVia: "none", observedStoreRef: structuredClone(inputs.storeRef) });
  assert.equal(noneWithRef.storeIdentity.status, "matched");
  await assert.rejects(() => run(noneWithRef), /DRAFT_PREFLIGHT_NOT_READY|PlatformWritePreflight校验失败/);
  assert.equal(writes, 1, "被拦住的每一次都不许碰平台");
});

test("13B-2 saves no ProductionRecord when platform result is not a draft with product ID", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight();
  for (const result of [
    { status: "published", productId: "1003", writeEvidenceRef: "test:published" },
    { status: "draft", productId: "", writeEvidenceRef: "test:no-id" },
    { status: "draft", productId: "1004", writeEvidenceRef: "test:activated", activated: true }
  ]) {
    await assert.rejects(() => executeSingleSkuDraftCreation({
      productionPlan: plan,
      productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
      platformWritePreflight: preflight,
      executedAt: "2026-08-22T07:10:00.000Z",
      createPlatformDraft: async () => result,
      readbackPlatformDraft: async () => ({})
    }), /DRAFT_PLATFORM/);
  }
});

test("13B-2 refuses completion when independent readback does not match stock or final images", async () => {
  const { authorization, plan, inputs, preflight } = planAndPreflight();
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    platformWritePreflight: preflight,
    executedAt: "2026-08-22T07:10:00.000Z",
    createPlatformDraft: async () => ({ status: "draft", productId: "1005", writeEvidenceRef: "test:draft:1005" }),
    readbackPlatformDraft: async () => ({
      status: "draft", productId: "1005", title: inputs.title, price: inputs.platformWritePrice, stock: 0,
      finalUploadAssetIds: [], mainImageAssetId: null, evidenceRef: "test:readback:1005"
    })
  }), /DRAFT_READBACK_MISMATCH/);
});

test("published ProductionRecord schema locks draft-only single-SKU execution", async () => {
  const url = new URL("../schema/production-record-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.deepEqual(schema.properties.status.enum, ["draft", "validation_or_moderation"]);
  assert.deepEqual(schema.properties.executionMode.enum, ["single_sku_draft_only", "single_sku_create_and_moderate", "single_sku_seller_api"]);
  assert.equal(schema.properties.batchSize.const, 1);
  assert.equal(schema.properties.published.const, false);
  assert.equal(schema.properties.activated.const, false);
  assert.equal(schema.properties.advertisingOpened.const, false);
  assert.equal(schema.properties.inventoryModified.type, "boolean");
  assert.deepEqual(schema.properties.stockWritten.type, ["integer", "null"]);
  assert.equal(schema.properties.imagesUploaded.minimum, 1);
  assert.equal(schema.properties.independentReadbackVerified.const, true);
  assert.equal(schema.properties.writtenFields.minItems, 6);
});
