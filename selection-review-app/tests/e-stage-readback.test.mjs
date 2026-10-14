import test from "node:test";
import assert from "node:assert/strict";
import { successfulExecution, exactObservation } from "./helpers/d-software-fixture.mjs";
import { executeDSoftwareAttempt, runSystemCreatedEReadback } from "../lib/d-e-software-closure.mjs";
import { validateProductionRecord, validateProductionReadbackExpectation } from "../lib/draft-production-execution.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import {
  observedWarehouseAvailableStock,
  productionReadbackContentGaps,
  createExternalListingRecord,
  validateEVerificationRecord,
  validateExternalListingRecord,
  systemCreatedReadbackGaps,
  validateSystemCreatedVerificationRecord,
  verifyExternalListing,
  verifySystemCreatedListing
} from "../lib/e-stage-readback.mjs";

const observed = {
  platform: "ozon",
  store: "dandanshu",
  skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
  supplierSkuId: "4993364145574",
  platformProductId: "5453271207",
  merchantSku: "4993364145574",
  currentPrice: { amount: 153, currency: "CNY" },
  currentStock: 100,
  imageCount: 10,
  moderationStatus: "approved",
  validationStatus: "success",
  saleStatus: "on_sale",
  errors: [],
  platformEvidenceRef: "ozon-seller-api:store-a:4993364145574:2026-08-13T09:31:31.666Z"
};

const decision = {
  decision: "keep_current_live_price",
  confirmedBy: "owner",
  confirmedAt: "2026-08-13T09:20:00.000Z",
  price: { amount: 153, currency: "CNY" }
};

test("external discovery creates ExternalListingRecord and E ends externally_verified", () => {
  const external = createExternalListingRecord({
    observation: { ...observed, discoverySource: "seller_portal", platformEvidenceRef: "ozon-seller-portal:product-row:5453271207" },
    ownerPriceDecision: decision,
    discoveredAt: "2026-08-13T09:25:00.000Z"
  });
  assert.equal(validateExternalListingRecord(external).valid, true);
  assert.equal(external.createdByCurrentRun, false);
  const verified = verifyExternalListing({ externalListingRecord: external, verifiedObservation: observed, verifiedAt: "2026-08-13T09:31:31.666Z" });
  assert.equal(validateEVerificationRecord(verified).valid, true);
  assert.equal(verified.sourceRecordType, "ExternalListingRecord");
  assert.equal(verified.outcome, "externally_verified");
  assert.equal(verified.createdByCurrentRun, false);
  assert.equal(verified.imageCount, 10);
});

test("E rejects wrong images, order, duplicates, extra assets and unknown CDN equivalence using the frozen expectation", async () => {
  const { attempt, result } = await successfulExecution();
  const productionRecord = result.productionRecord;
  const urls = productionRecord.readbackExpectation.media.map(asset => asset.submittedUrl);
  const normal = exactObservation(productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const media = (primaryImageUrl, images) => ({ sourceProtocol: "ozon-product-attributes-v4", primaryImageUrl, images });
  const cases = [
    ["same count different media", media("https://other.example/unrelated-main.png", ["https://other.example/unrelated-detail.png"]), 2, "media_identity_unverified"],
    ["main image exchanged", media(urls[1], [urls[0]]), 2, "main_image_mismatch"],
    ["duplicated detail", media(urls[0], [urls[1], urls[1]]), 3, "media_duplicate"],
    ["primary repeated after detail", media(urls[0], [urls[1], urls[0]]), 3, "media_duplicate"],
    ["extra image", media(urls[0], [urls[1], "https://other.example/extra.png"]), 3, "media_manifest_mismatch"],
    ["CDN has no identity mapping", media("https://cdn.ozon/main.png", ["https://cdn.ozon/detail.png"]), 2, "media_identity_unverified"],
    ["primary missing", media("unknown", [urls[1]]), "unknown", "media_identity_unverified"]
  ];
  for (const [label, mediaObservation, imageCount, gap] of cases) {
    const observation = { ...normal, mediaObservation, imageCount };
    assert.ok(systemCreatedReadbackGaps(productionRecord, observation).includes(gap), label);
    let eReads = 0;
    const e = await runSystemCreatedEReadback({ productionRecord, verifiedAt: "2026-08-22T08:00:00.000Z",
      readPlatform: async () => { eReads += 1; return observation; } });
    assert.equal(eReads, 1, label); assert.equal(e.status, "not_verified", label);
    assert.equal(e.eVerificationRecord, null); assert.ok(e.gaps.includes(gap));
  }
  assert.deepEqual(productionRecord.readbackExpectation.media, attempt.request.finalUploads.map(asset => ({
    assetId: asset.assetId, order: asset.order, sha256: asset.sha256, submittedUrl: asset.platformAcceptedUrl
  })));
  const primaryRepeatedStructurally = { ...normal, mediaObservation: media(urls[0], urls) };
  assert.deepEqual(systemCreatedReadbackGaps(productionRecord, primaryRepeatedStructurally), []);
});

test("unmapped CDN media stays unverified without inventing a main-image or order mismatch", async () => {
  const { result } = await successfulExecution(), record = result.productionRecord;
  const normal = exactObservation(record, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const observation = { ...normal, mediaObservation: { sourceProtocol: "ozon-product-info-v3",
    primaryImageUrl: "https://cdn.ozon/main.png", images: ["https://cdn.ozon/detail.png"] } };
  assert.deepEqual(productionReadbackContentGaps(record.readbackExpectation, observation), ["media_identity_unverified"]);
  const e = await runSystemCreatedEReadback({ productionRecord: record, readPlatform: async () => observation, verifiedAt: "2026-08-22T08:00:00.000Z" });
  assert.equal(e.status, "not_verified"); assert.equal(e.eVerificationRecord, null);
  assert.deepEqual(e.gaps, ["media_identity_unverified"]);
  assert.throws(() => verifySystemCreatedListing({ productionRecord: record, verifiedObservation: observation,
    verifiedAt: "2026-08-22T08:00:00.000Z" }), /E_SYSTEM_READBACK_INCOMPLETE/);
});

test("media placement is compared only for a proven complete asset set while duplicate and count evidence is retained", async () => {
  const { result } = await successfulExecution(), record = result.productionRecord;
  const normal = exactObservation(record, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const [main, detail] = record.readbackExpectation.media.map(asset => asset.submittedUrl);
  const gaps = (primaryImageUrl, images, imageCount) => productionReadbackContentGaps(record.readbackExpectation,
    { ...normal, imageCount, mediaObservation: { sourceProtocol: "ozon-product-attributes-v4", primaryImageUrl, images } });
  assert.deepEqual(gaps(detail, [main], 2), ["main_image_mismatch", "media_order_or_set_mismatch"]);
  assert.deepEqual(gaps(main, [detail], 2), []);
  assert.deepEqual(gaps(main, [], 1), ["media_manifest_mismatch"]);
  assert.deepEqual(gaps(main, [detail, detail], 3), ["media_duplicate", "media_manifest_mismatch"]);
  assert.deepEqual(gaps("https://cdn.ozon/main.png", ["https://cdn.ozon/detail.png", "https://cdn.ozon/detail.png"], 2),
    ["media_duplicate", "media_manifest_mismatch", "media_identity_unverified", "imageCount"]);
  assert.deepEqual(gaps(main, ["https://cdn.ozon/detail.png"], 2), ["media_identity_unverified"]);
  const third = "https://assets.example.com/third.png", expectation = structuredClone(record.readbackExpectation);
  expectation.media.push({ assetId: "asset:third", order: 3, sha256: "f".repeat(64), submittedUrl: third });
  assert.deepEqual(productionReadbackContentGaps(expectation, { ...normal, imageCount: 3,
    mediaObservation: { sourceProtocol: "ozon-product-attributes-v4", primaryImageUrl: main, images: [third, detail] } }),
    ["media_order_or_set_mismatch"]);
});

test("only the authorized warehouse can prove stock; another warehouse, ambiguous rows and absent quantities cannot", async () => {
  const { attempt, result, executionContext } = await successfulExecution();
  const productionRecord = result.productionRecord;
  const normal = exactObservation(productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const target = productionRecord.readbackExpectation.warehouseId;
  const row = (warehouseId, freeStock, reserved = 0) => ({ warehouseId, productId: productionRecord.platformProductId, sku: "810001", offerId: productionRecord.merchantSku, freeStock, present: freeStock, reserved });
  const cases = [
    [[row(target, 0), row("70002", 100)], 0, "currentStock"],
    [[row(target, 0), row("70002", 100)], 100, "warehouse_stock_mismatch"],
    [[row("70002", 100)], 100, "warehouse_identity_or_quantity_unverified"],
    [[row("unknown", 100)], 100, "warehouse_identity_or_quantity_unverified"],
    [[row(target, 100), row(target, 100)], 100, "warehouse_identity_or_quantity_unverified"],
    [[row(target, "unknown")], 100, "warehouse_identity_or_quantity_unverified"],
    [[row(target, 100, "unknown")], 100, "warehouse_identity_or_quantity_unverified"],
    [[], 100, "warehouse_identity_or_quantity_unverified"]
  ];
  for (const [rows, currentStock, gap] of cases) {
    const observation = { ...normal, currentStock, inventoryObservation: { sourceProtocol: "ozon-product-stocks-by-warehouse-fbs-v2", hasNext: false, rows } };
    assert.ok(systemCreatedReadbackGaps(productionRecord, observation).includes(gap), JSON.stringify(rows));
    const e = await runSystemCreatedEReadback({ productionRecord, readPlatform: async () => observation, verifiedAt: "2026-08-22T08:00:00.000Z" });
    assert.equal(e.status, "not_verified"); assert.equal(e.eVerificationRecord, null);
    const d = await executeDSoftwareAttempt({ executionAttempt: attempt, executionContext,
      executeSellerApi: async () => result.platformResult, readbackSellerApi: async () => observation,
      completedAt: "2026-08-22T07:25:00.000Z" });
    assert.equal(d.status, "unknown_outcome"); assert.equal(d.productionRecord, null);
  }
});

test("historical ProductionRecord remains readable but cannot acquire exact verification or start E without frozen targets", async () => {
  const { result } = await successfulExecution();
  const observation = exactObservation(result.productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const verified = await runSystemCreatedEReadback({ productionRecord: result.productionRecord, readPlatform: async () => observation, verifiedAt: "2026-08-22T08:00:00.000Z" });
  const historical = structuredClone(result.productionRecord); delete historical.readbackExpectation;
  assert.equal(validateProductionRecord(historical).valid, true);
  const original = structuredClone(historical);
  const e = await runSystemCreatedEReadback({ productionRecord: historical, readPlatform: async () => { throw new Error("historical record must not trigger platform access"); }, verifiedAt: "2026-08-22T08:00:00.000Z" });
  assert.equal(e.status, "not_verified"); assert.equal(e.platformWrites, 0);
  assert.deepEqual(e.gaps, ["readback_expectation_missing_or_invalid"]);
  assert.equal(validateSystemCreatedVerificationRecord(verified.eVerificationRecord, historical).valid, false);
  assert.deepEqual(historical, original);
});

test("published D and E schemas validate real projections and reject malformed precise expectations and observation shapes", async () => {
  const validator = await loadPublishedSchemaValidator();
  const validateD = validator.getSchema("d-software-execution-v2");
  const validateProduction = validator.getSchema("production-record-v1.1");
  const validateE = validator.getSchema("e-verification-record-v1.1");
  const { attempt, result } = await successfulExecution();
  const observation = exactObservation(result.productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const verified = await runSystemCreatedEReadback({ productionRecord: result.productionRecord, readPlatform: async () => observation, verifiedAt: "2026-08-22T08:00:00.000Z" });
  assert.equal(validateD(attempt), true, JSON.stringify(validateD.errors));
  assert.equal(validateProduction(result.productionRecord), true, JSON.stringify(validateProduction.errors));
  assert.equal(validateE(verified.eVerificationRecord), true, JSON.stringify(validateE.errors));
  const infoObservation = structuredClone(verified.eVerificationRecord);
  infoObservation.mediaObservation.sourceProtocol = "ozon-product-info-v3";
  assert.equal(validateEVerificationRecord(infoObservation).valid, true);
  assert.equal(validateE(infoObservation), true, JSON.stringify(validateE.errors));
  assert.deepEqual(systemCreatedReadbackGaps(result.productionRecord, infoObservation), []);
  infoObservation.mediaObservation.sourceProtocol = "invented-image-protocol";
  assert.equal(validateEVerificationRecord(infoObservation).valid, false);
  assert.equal(validateE(infoObservation), false);
  for (const edit of [value => { delete value.warehouseId; }, value => { value.warehouseId = ""; },
    value => { value.stockBasis = "all_warehouses"; }, value => { value.media[0].sha256 = "missing"; },
    value => { value.media[0].submittedUrl = "http://assets.example.com/image.png"; }, value => { value.media[0].other = true; }]) {
    const malformed = structuredClone(result.productionRecord); edit(malformed.readbackExpectation);
    assert.equal(validateProductionReadbackExpectation(malformed.readbackExpectation), false);
    assert.equal(validateProductionRecord(malformed).valid, false);
    assert.equal(validateProduction(malformed), false);
    const malformedAttempt = structuredClone(attempt); malformedAttempt.request.independentReadback.expectation = malformed.readbackExpectation;
    assert.equal(validateD(malformedAttempt), false);
  }
  for (const edit of [value => { delete value.mediaObservation; }, value => { delete value.inventoryObservation; },
    value => { value.mediaObservation.primaryImageUrl = "unknown"; }, value => { value.mediaObservation.expectedAssetIds = ["invented"]; },
    value => { value.inventoryObservation.rows[0].present = -1; }]) {
    const malformed = structuredClone(verified.eVerificationRecord); edit(malformed);
    assert.equal(validateEVerificationRecord(malformed).valid, false);
    assert.equal(validateE(malformed), false);
  }
  const historical = structuredClone(result.productionRecord); delete historical.readbackExpectation;
  assert.equal(validateProduction(historical), true, JSON.stringify(validateProduction.errors));
});

test("system-created E path requires a complete ProductionRecord and independent matching state", async () => {
  const { result } = await successfulExecution();
  const productionRecord = result.productionRecord;
  const observation = exactObservation(productionRecord, { currentPrice: { amount: 151.78, currency: "CNY" }, imageCount: 2,
    moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  const input = { productionRecord, verifiedObservation: observation, verifiedAt: "2026-08-22T08:00:00.000Z",
    ownerPriceDecision: { decision: "authorized_platform_write_price", confirmedBy: "owner", authorizationId: productionRecord.sourceAuthorizationId, price: { amount: 151.78, currency: "CNY" } } };
  const verified = verifySystemCreatedListing(input);
  assert.equal(verified.sourceRecordType, "ProductionRecord");
  assert.equal(verified.outcome, "listed_verified");
  assert.equal(verified.createdByCurrentRun, true);
  assert.notEqual(verified.merchantSku, verified.supplierSkuId);
  for (const patch of [{ confirmedBy: undefined }, { confirmedBy: "nobody" }, { authorizationId: "another" }]) {
    assert.throws(() => verifySystemCreatedListing({ ...input, ownerPriceDecision: { ...input.ownerPriceDecision, ...patch } }), /EVerificationRecord/);
  }
  for (const field of ["currentStock", "imageCount", "moderationStatus", "validationStatus", "errors", "saleStatus"]) {
    const incomplete = structuredClone(observation); delete incomplete[field];
    assert.throws(() => verifySystemCreatedListing({ ...input, verifiedObservation: incomplete }), /E_SYSTEM_READBACK_INCOMPLETE/);
    const corruptRecord = structuredClone(verified); delete corruptRecord[field];
    assert.equal(validateEVerificationRecord(corruptRecord).valid, false, field);
  }
  for (const patch of [
    { store: "miska" }, { merchantSku: "SHELF-WHITE" }, { platformProductId: "910002" },
    { currentPrice: { amount: 1500, currency: "RUB" } }, { currentStock: 99 }, { imageCount: 3 },
    { errors: [{ code: "STATE_FAILED" }] }, { moderationStatus: "unknown", validationStatus: "unknown", saleStatus: "unknown" }
  ]) assert.throws(() => verifySystemCreatedListing({ ...input, verifiedObservation: { ...observation, ...patch } }), /E_SYSTEM_READBACK_INCOMPLETE/);
  assert.throws(() => verifySystemCreatedListing({ ...input, productionRecord: { productionRecordId: "unproven" } }), /ProductionRecord/);
});

test("external path rejects identity or retained-price drift", () => {
  const external = createExternalListingRecord({
    observation: { ...observed, discoverySource: "seller_portal" },
    ownerPriceDecision: decision,
    discoveredAt: "2026-08-13T09:25:00.000Z"
  });
  assert.throws(() => verifyExternalListing({
    externalListingRecord: external,
    verifiedObservation: { ...observed, platformProductId: "OTHER" },
    verifiedAt: "2026-08-13T09:31:31.666Z"
  }), /IDENTITY_MISMATCH/);
  assert.throws(() => verifyExternalListing({
    externalListingRecord: external,
    verifiedObservation: { ...observed, currentPrice: { amount: 151.78, currency: "CNY" } },
    verifiedAt: "2026-08-13T09:31:31.666Z"
  }), /PRICE_MISMATCH/);
});

test("unknown image, stock, moderation or errors remain explicit instead of inferred", () => {
  const external = createExternalListingRecord({
    observation: {
      ...observed,
      discoverySource: "seller_portal",
      currentStock: "unknown",
      imageCount: "unknown",
      moderationStatus: "unknown",
      validationStatus: "unknown",
      errors: "unknown"
    },
    ownerPriceDecision: decision,
    discoveredAt: "2026-08-13T09:25:00.000Z"
  });
  assert.equal(validateExternalListingRecord(external).valid, true);
  assert.equal(external.imageCount, "unknown");
  assert.equal(external.errors, "unknown");
});


test("v2 stock is direct free_stock with complete pagination and exact product, offer, and warehouse identity",()=>{
 const row={warehouseId:"70001",productId:"910001",sku:"810001",offerId:"offer:1",freeStock:0,present:103,reserved:3};
 const observation={sourceProtocol:"ozon-product-stocks-by-warehouse-fbs-v2",hasNext:false,rows:[row]};
 const identity={productId:"910001",offerId:"offer:1"};
 assert.equal(observedWarehouseAvailableStock(observation,"70001",identity),0);
 assert.equal(observedWarehouseAvailableStock({...observation,rows:[{...row,freeStock:17}]},"70001",identity),17);
 for(const edit of [value=>{value.hasNext=true;},value=>{value.hasNext="unknown";},value=>{delete value.hasNext;},
   value=>{value.rows[0].productId="910002";},value=>{value.rows[0].offerId="wrong";},value=>{value.rows[0].warehouseId="70002";},
   value=>{value.rows.push(structuredClone(row));},value=>{delete value.rows[0].freeStock;},value=>{value.rows[0].freeStock="unknown";},
   value=>{value.rows[0].freeStock="0";},value=>{value.rows[0].sku="unknown";},value=>{value.rows=[];}]){
  const changed=structuredClone(observation);edit(changed);assert.equal(observedWarehouseAvailableStock(changed,"70001",identity),"unknown");
 }
 assert.equal(observedWarehouseAvailableStock(observation,"70001"),"unknown");
 assert.equal(observedWarehouseAvailableStock({sourceProtocol:"ozon-product-stocks-v4",rows:[{warehouseId:"70001",type:"rfbs",present:103,reserved:3}]},"70001",identity),"unknown");
});

test("legacy v1 expectations and E inventory remain readable history but cannot be relabeled or execute new E",async()=>{
 const {result}=await successfulExecution();const historical=structuredClone(result.productionRecord);
 historical.readbackExpectation.schemaVersion="production-readback-expectation-v1";historical.readbackExpectation.stockBasis="present_minus_reserved";
 assert.equal(validateProductionRecord(historical).valid,true);assert.equal(validateProductionReadbackExpectation(historical.readbackExpectation),false);
 const before=structuredClone(historical);let reads=0;
 const e=await runSystemCreatedEReadback({productionRecord:historical,verifiedAt:"2026-08-22T08:00:00.000Z",readPlatform:async()=>{reads++;throw new Error("must not read");}});
 assert.equal(reads,0);assert.equal(e.status,"not_verified");assert.deepEqual(historical,before);
 const relabeled=structuredClone(historical);relabeled.readbackExpectation.schemaVersion="production-readback-expectation-v2";
 assert.equal(validateProductionRecord(relabeled).valid,false);
 const normal=exactObservation(result.productionRecord,{moderationStatus:"approved",validationStatus:"success",saleStatus:"on_sale"});
 const verified=await runSystemCreatedEReadback({productionRecord:result.productionRecord,verifiedAt:"2026-08-22T08:00:00.000Z",readPlatform:async()=>normal});
 const oldE=structuredClone(verified.eVerificationRecord);oldE.inventoryObservation={sourceProtocol:"ozon-product-stocks-v4",rows:[{warehouseId:historical.readbackExpectation.warehouseId,type:"rfbs",present:103,reserved:3}]};
 assert.equal(validateEVerificationRecord(oldE).valid,true);
 assert.ok(systemCreatedReadbackGaps(result.productionRecord,oldE).includes("warehouse_identity_or_quantity_unverified"));
 oldE.inventoryObservation.sourceProtocol="ozon-product-stocks-by-warehouse-fbs-v2";assert.equal(validateEVerificationRecord(oldE).valid,false);
 const validator=await loadPublishedSchemaValidator();assert.equal(validator.getSchema("production-record-v1.1")(historical),true);
});
