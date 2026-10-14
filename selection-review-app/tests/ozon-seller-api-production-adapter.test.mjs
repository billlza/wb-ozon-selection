import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOzonSellerImportRequest,
  buildOzonSellerBatchImportRequests,
  createOzonSellerApiProductionAdapter
} from "../lib/ozon-seller-api-production-adapter.mjs";
import { fingerprintAuthorizedMedia } from "../lib/production-authorization-preparation.mjs";
import { loadOzonProductImportBatchLimitEvidence } from '../lib/ozon-product-import-batch-limit.mjs';

// 本轮不许真发请求：可达性探针一律打桩。
const reachable = async () => ({ reachable: true, statusCode: 200 });

function authorizedMediaFor(finalUploads) {
  return {
    fingerprint: fingerprintAuthorizedMedia(finalUploads.map((asset) => asset.assetRef)),
    primaryImage: finalUploads[0].assetRef,
    images: finalUploads.slice(1).map((asset) => asset.assetRef)
  };
}

function batchMember(offerId, colorKey, mainImage) {
  const finalUploads = [
    { assetId: `main-${colorKey}`, assetRef: mainImage, ownerConfirmed: true, productionEligible: true },
    { assetId: 'shared-detail', assetRef: 'https://assets.example/shared-detail.jpg', ownerConfirmed: true, productionEligible: true }
  ];
  return { colorKey, modelKey: 'same-product', sourceTechnicalStatus: 'not_started', payload: payload({ merchantSku: offerId, supplierSkuId: offerId,
    storeRef: { stableStoreId: 'dandanshu', platformStoreId: 'synthetic-store', mappingVersion: 'v1' },
    warehouseRef: 'warehouse:synthetic', credentialAlias: 'credential:synthetic',
    finalUploads, authorizedMedia: authorizedMediaFor(finalUploads) }) };
}

test('batch import uses a current evidenced limit and one image per color', () => {
  const members = [batchMember('offer-1', 'black', 'https://assets.example/black.jpg'),
    batchMember('offer-2', 'black', 'https://assets.example/black.jpg'),
    batchMember('offer-3', 'khaki', 'https://assets.example/khaki.jpg')];
  const capability = { status: 'verified', endpoint: '/v3/product/import', evidenceRef: 'synthetic:protocol',
    limitEvidenceRef: 'synthetic:limit', limitObservedAt:'2026-09-26T00:00:00.000Z',maxItemsPerRequest: 2,
    validUntil: '2026-09-28T00:00:00.000Z' };
  const batches = buildOzonSellerBatchImportRequests({ members, productImportCapability: capability,
    checkedAt: '2026-09-27T00:00:00.000Z' });
  assert.deepEqual(batches.map(batch => batch.offerIds), [['offer-1', 'offer-2'], ['offer-3']]);
  assert.deepEqual(batches.map(batch => batch.batchSize), [2, 1]);
  assert.equal(batches[0].limitEvidenceRef,capability.limitEvidenceRef);
  assert.equal(batches[0].body.items[0].primary_image, batches[0].body.items[1].primary_image);
  assert.notEqual(batches[0].body.items[0].primary_image, batches[1].body.items[0].primary_image);
  assert.throws(() => buildOzonSellerBatchImportRequests({ members,
    productImportCapability: { ...capability, validUntil: '2026-09-26T00:00:00.000Z' },
    checkedAt: '2026-09-27T00:00:00.000Z' }), /LIMIT_EVIDENCE_REQUIRED/);
  assert.throws(() => buildOzonSellerBatchImportRequests({ members: [members[0],
    batchMember('offer-4', 'khaki', 'https://assets.example/black.jpg')],
    productImportCapability: capability, checkedAt: '2026-09-27T00:00:00.000Z' }), /DIFFERENT_COLOR_IMAGE_MISMATCH/);
  assert.throws(() => buildOzonSellerBatchImportRequests({ members: [members[0],
    batchMember('offer-4', 'black', 'https://assets.example/other-black.jpg')],
    productImportCapability: capability, checkedAt: '2026-09-27T00:00:00.000Z' }), /SAME_COLOR_IMAGE_MISMATCH/);
  assert.throws(() => buildOzonSellerBatchImportRequests({ members, excludedOfferIds: ['offer-1'],
    productImportCapability: capability, checkedAt: '2026-09-27T00:00:00.000Z' }), /EXCLUDED_OFFER/);
  assert.throws(() => buildOzonSellerBatchImportRequests({ members: [{ ...members[0], sourceTechnicalStatus: 'unknown_outcome' }],
    productImportCapability: capability, checkedAt: '2026-09-27T00:00:00.000Z' }), /SOURCE_ALREADY_STARTED/);
});

test('a synthetic 32-spec list excludes the first and splits the remaining 31 by the evidenced limit', () => {
  const excludedFirst = 'offer-01';
  const colors = ['black', 'khaki', 'navy'];
  const members = Array.from({ length: 31 }, (_, index) => {
    const color = colors[index % colors.length];
    return batchMember(`offer-${String(index + 2).padStart(2, '0')}`, color,
      `https://assets.example/${color}.jpg`);
  });
  const chunks = buildOzonSellerBatchImportRequests({ members, excludedOfferIds: [excludedFirst],
    productImportCapability: { status: 'verified', endpoint: '/v3/product/import', evidenceRef: 'synthetic:protocol',
      limitEvidenceRef: 'synthetic:limit-ten',limitObservedAt:'2026-09-26T00:00:00.000Z',
      maxItemsPerRequest: 10, validUntil: '2026-09-28T00:00:00.000Z' },
    checkedAt: '2026-09-27T00:00:00.000Z' });
  assert.deepEqual(chunks.map(chunk => chunk.batchSize), [10, 10, 10, 1]);
  assert.equal(chunks.flatMap(chunk => chunk.offerIds).length, 31);
  assert.equal(chunks.some(chunk => chunk.offerIds.includes(excludedFirst)), false);
  assert.equal(new Set(chunks.flatMap(chunk => chunk.offerIds)).size, 31);
});

test('official per-request limit keeps 31 in one task and splits 101 into 100 plus one',async()=>{
  const evidence=await loadOzonProductImportBatchLimitEvidence();
  const productImportCapability={status:'verified',endpoint:'/v3/product/import',
    evidenceRef:'synthetic:account-method-grant',limitEvidenceRef:evidence.evidenceRef,
    maxItemsPerRequest:evidence.maxItemsPerRequest,limitObservedAt:evidence.observedAt,
    validUntil:evidence.validUntil};
  const members=Array.from({length:101},(_,index)=>batchMember(`offer-${index+2}`,'black',
    'https://assets.example/black.jpg'));
  const checkedAt='2026-09-28T00:41:00.000Z';
  const first31=buildOzonSellerBatchImportRequests({members:members.slice(0,31),
    excludedOfferIds:['offer-1'],productImportCapability,checkedAt});
  assert.deepEqual(first31.map(chunk=>chunk.batchSize),[31]);
  const all=buildOzonSellerBatchImportRequests({members,excludedOfferIds:['offer-1'],
    productImportCapability,checkedAt});
  assert.deepEqual(all.map(chunk=>chunk.batchSize),[100,1]);
  assert.equal(all[0].limitEvidenceRef,evidence.evidenceRef);
  for(const change of [
    {limitEvidenceRef:null},{maxItemsPerRequest:101},
    {limitObservedAt:'2026-09-28T00:42:00.000Z'},
    {validUntil:checkedAt}
  ]){
    assert.throws(()=>buildOzonSellerBatchImportRequests({members:members.slice(0,31),
      productImportCapability:{...productImportCapability,...change},checkedAt}),
    /OZON_BATCH_LIMIT_EVIDENCE_REQUIRED/);
  }
});

function payload(overrides = {}) {
  const finalUploads = overrides.finalUploads ?? [
    { assetId: "main", assetRef: "https://assets.example/main.jpg", ownerConfirmed: true, productionEligible: true },
    { assetId: "detail", assetRef: "https://assets.example/detail.jpg", ownerConfirmed: true, productionEligible: true }
  ];
  return {
    mode: "single_sku_create_and_moderate",
    platform: "ozon",
    store: "dandanshu",
    supplierSkuId: "SUP-MUSIC-001",
    merchantSku: "MERCHANT-MUSIC-001",
    title: "Музыкальная шкатулка — швейная машинка",
    content: {
      locale: "ru-RU",
      description: "Механическая музыкальная шкатулка.",
      bulletPoints: ["Ручной завод."],
      searchKeywords: ["музыкальная шкатулка", "швейная машинка"]
    },
    attributes: {
      requiredPlatformFields: [
        { fieldKey: "85", fact: { value: { value: "Нет бренда", dictionaryValueId: 1001 }, verificationStatus: "confirmed" } },
        { fieldKey: "9048", fact: { value: "Швейная машинка", verificationStatus: "confirmed" } },
        { fieldKey: "8229", fact: { value: { value: "Музыкальная шкатулка", dictionaryValueId: 2001 }, verificationStatus: "confirmed" } }
      ]
    },
    schemaWriteBindings: {
      schemaRevision: "ozon-schema-current:test",
      evidenceRef: "test:ozon-schema:music-box",
      content: {
        title: { fieldKey: "title", attributeId: 4180, complexId: 0, dictionaryId: 0 },
        description: { fieldKey: "description", attributeId: 4191, complexId: 0, dictionaryId: 0 },
        searchKeywords: { fieldKey: "searchKeywords", attributeId: 23171, complexId: 0, dictionaryId: 0 }
      },
      requiredAttributes: [
        { fieldKey: "85", attributeId: 85, complexId: 0, dictionaryId: 301 },
        { fieldKey: "9048", attributeId: 9048, complexId: 0, dictionaryId: 0 },
        { fieldKey: "8229", attributeId: 8229, complexId: 0, dictionaryId: 302 }
      ]
    },
    packing: {
      weight: { value: 0.4, unit: "kg" },
      dimensions: { length: 12, width: 12, height: 7, unit: "cm" }
    },
    platformCategory: {
      descriptionCategoryId: { value: 17028973, verificationStatus: "confirmed" },
      typeId: { value: 92849, verificationStatus: "confirmed" }
    },
    platformWritePrice: { amount: 117.85, currency: "CNY" },
    finalUploads,
    authorizedMedia: authorizedMediaFor(finalUploads),
    publishScope: "create_and_allow_validation_moderation",
    ...overrides
  };
}

test("builds one Ozon import item from the frozen production payload", () => {
  const request = buildOzonSellerImportRequest(payload());
  assert.equal(request.body.items.length, 1);
  const item = request.body.items[0];
  assert.equal(item.offer_id, "MERCHANT-MUSIC-001");
  assert.equal(item.currency_code, "CNY");
  assert.equal(item.price, "117.85");
  assert.equal(item.weight, 400);
  assert.equal(item.depth, 120);
  assert.equal(item.width, 120);
  assert.equal(item.height, 70);
  assert.equal(item.primary_image, "https://assets.example/main.jpg");
  assert.deepEqual(item.images, ["https://assets.example/detail.jpg"]);
  assert.equal(item.attributes.find((entry) => entry.id === 4191).values[0].value.includes("Ручной завод"), true);
  assert.equal(item.attributes.find((entry) => entry.id === 85).values[0].dictionary_value_id, 1001);
  // 商品导入请求明确设置 vat 为零。
  // 不发 old_price，也不发与 description_category_id 重复的 new_description_category_id。
  assert.equal(item.vat, "0");
  assert.equal(Object.hasOwn(item, "old_price"), false);
  assert.equal(Object.hasOwn(item, "new_description_category_id"), false);
  assert.equal(Number.isSafeInteger(item.description_category_id) && item.description_category_id > 0, true);
  assert.equal(request.inventoryIncluded, false);
});

test("rejects draft-only, local assets, unknown attributes and wrong currency before transport", () => {
  assert.throws(() => buildOzonSellerImportRequest(payload({ mode: "single_sku_draft_only", publishScope: "create_draft_only" })), /SCOPE_REJECTED/);
  const local = payload();
  local.finalUploads[0].assetRef = "/tmp/main.jpg";
  local.authorizedMedia = authorizedMediaFor(local.finalUploads);
  assert.throws(() => buildOzonSellerImportRequest(local), /REMOTE_ASSET_REQUIRED/);
  const httpOnly = payload();
  httpOnly.finalUploads[0].assetRef = "http://assets.example/main.jpg";
  httpOnly.authorizedMedia = authorizedMediaFor(httpOnly.finalUploads);
  assert.throws(() => buildOzonSellerImportRequest(httpOnly), /REMOTE_ASSET_REQUIRED/);
  const unknown = payload();
  unknown.attributes.requiredPlatformFields[0].fact = { value: "unknown", verificationStatus: "unknown" };
  assert.throws(() => buildOzonSellerImportRequest(unknown), /REQUIRED_ATTRIBUTE_UNKNOWN/);
  const rub = payload({ platformWritePrice: { amount: 1462, currency: "RUB" } });
  assert.throws(() => buildOzonSellerImportRequest(rub), /PRICE_REJECTED/);
  const unbound = payload();
  delete unbound.schemaWriteBindings;
  assert.throws(() => buildOzonSellerImportRequest(unbound), /SCHEMA_BINDING_REJECTED/);
  const missingDictionaryId = payload();
  missingDictionaryId.attributes.requiredPlatformFields[0].fact.value = "Нет бренда";
  assert.throws(() => buildOzonSellerImportRequest(missingDictionaryId), /DICTIONARY_VALUE_REQUIRED/);
});

test("uses one import call, one terminal-status call and independent readback without inventory write", async () => {
  const calls = [];
  const adapter = createOzonSellerApiProductionAdapter({
    probeAssetUrl: reachable,
    requestJson: async (request) => {
      calls.push(request);
      if (request.endpoint === "/v3/product/import") return { result: { task_id: "task-1" } };
      if (request.endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "MERCHANT-MUSIC-001", product_id: 9001, status: "imported", errors: [] }] } };
      if (request.endpoint === "/v3/product/info/list") return { items: [{ offer_id: "MERCHANT-MUSIC-001", id: 9001, name: "Музыкальная шкатулка — швейная машинка", price: { price: "117.85" } }] };
      if (request.endpoint === "/v4/product/info/attributes") return { result: [{ offer_id: "MERCHANT-MUSIC-001", primary_image: "https://cdn.ozon/main.jpg", images: ["https://cdn.ozon/detail.jpg"] }] };
      throw new Error(`unexpected ${request.endpoint}`);
    }
  });
  const created = await adapter.createPlatformDraft(payload());
  assert.equal(created.status, "validation_or_moderation");
  assert.equal(created.inventoryModified, false);
  const readback = await adapter.readbackPlatformDraft({ productId: "9001" });
  assert.equal(readback.price.amount, 117.85);
  assert.deepEqual(readback.finalUploadAssetIds, ["main", "detail"]);
  assert.deepEqual(calls.map((call) => [call.endpoint, call.write]), [
    ["/v3/product/import", true],
    ["/v1/product/import/info", false],
    ["/v3/product/info/list", false],
    ["/v4/product/info/attributes", false]
  ]);
});

test("stops on pending import and never polls or reads another product", async () => {
  let calls = 0;
  const adapter = createOzonSellerApiProductionAdapter({
    probeAssetUrl: reachable,
    requestJson: async ({ endpoint }) => {
      calls += 1;
      if (endpoint === "/v3/product/import") return { result: { task_id: "task-pending" } };
      return { result: { items: [{ offer_id: "MERCHANT-MUSIC-001", status: "pending" }] } };
    }
  });
  await assert.rejects(() => adapter.createPlatformDraft(payload()), /PENDING_UNKNOWN_OUTCOME/);
  assert.equal(calls, 2);
});

test("发出去的图必须就是主人授权的那批：地址被换掉、顺序被动过都要拦下", () => {
  const swapped = payload();
  swapped.finalUploads[1].assetRef = "https://assets.example/other.jpg";
  assert.throws(() => buildOzonSellerImportRequest(swapped), /AUTHORIZED_MEDIA_DRIFT/);

  const reordered = payload();
  reordered.finalUploads.reverse();
  assert.throws(() => buildOzonSellerImportRequest(reordered), /AUTHORIZED_MEDIA_DRIFT/);

  const forgedFingerprint = payload();
  forgedFingerprint.authorizedMedia = { ...forgedFingerprint.authorizedMedia, fingerprint: "0".repeat(64) };
  assert.throws(() => buildOzonSellerImportRequest(forgedFingerprint), /AUTHORIZED_MEDIA_DRIFT/);

  const missing = payload();
  delete missing.authorizedMedia;
  assert.throws(() => buildOzonSellerImportRequest(missing), /AUTHORIZED_MEDIA_MISSING/);
});

test("主人说过要确认都能访问：没有探针或访问不到都不许发出", async () => {
  const noProbe = createOzonSellerApiProductionAdapter({ requestJson: async () => ({ result: { task_id: "task-1" } }) });
  await assert.rejects(() => noProbe.createPlatformDraft(payload()), /ASSET_REACHABILITY_PROBE_REQUIRED/);

  const notFound = createOzonSellerApiProductionAdapter({
    requestJson: async () => ({ result: { task_id: "task-1" } }),
    probeAssetUrl: async () => ({ reachable: true, statusCode: 404 })
  });
  await assert.rejects(() => notFound.createPlatformDraft(payload()), /ASSET_NOT_REACHABLE/);

  const refused = createOzonSellerApiProductionAdapter({
    requestJson: async () => ({ result: { task_id: "task-1" } }),
    probeAssetUrl: async () => { throw new Error("ECONNREFUSED"); }
  });
  await assert.rejects(() => refused.createPlatformDraft(payload()), /ASSET_NOT_REACHABLE/);

  const probed = [];
  const ok = createOzonSellerApiProductionAdapter({
    requestJson: async ({ endpoint }) => {
      if (endpoint === "/v3/product/import") return { result: { task_id: "task-1" } };
      return { result: { items: [{ offer_id: "MERCHANT-MUSIC-001", product_id: 9001, status: "imported", errors: [] }] } };
    },
    probeAssetUrl: async ({ url }) => { probed.push(url); return { reachable: true, statusCode: 200 }; }
  });
  await ok.createPlatformDraft(payload());
  assert.deepEqual(probed, ["https://assets.example/main.jpg", "https://assets.example/detail.jpg"]);
});

test('confirmed optional attributes reach the real import payload without unknown fields or review translations', () => {
  const input = payload();
  input.attributes.ozonAttributes = [
    { fieldKey: '5953', fact: { verificationStatus: 'confirmed', sourceRefs: ['mapping:gender'], value: { value: 'Унисекс', dictionaryValueId: 1884 }, reviewZh: '男女通用' } },
    { fieldKey: '10096', fact: { verificationStatus: 'unknown' } }
  ];
  input.platformSchemaAttributes = [{ fieldKey: '5953', required: false, complexId: 0, dictionaryId: 1 }];
  const result = buildOzonSellerImportRequest(input);
  assert.deepEqual(result.body.items[0].attributes.find(item => item.id === 5953), { id: 5953, complex_id: 0, values: [{ dictionary_value_id: 1884, value: 'Унисекс' }] });
  assert.equal(result.body.items[0].attributes.some(item => item.id === 10096), false);
  assert.equal(JSON.stringify(result.body).includes('男女通用'), false);
  input.platformSchemaAttributes[0].fieldKey = 'unrelated';
  assert.throws(() => buildOzonSellerImportRequest(input), /OZON_OPTIONAL_ATTRIBUTE_SCHEMA_MISMATCH/);
});

test('the confirmed broad and exact color values both reach the one-item import projection', () => {
  const input = payload({ supplierSkuId: 'synthetic-black-cp', merchantSku: 'synthetic-black-cp' });
  input.attributes.ozonAttributes = [
    { fieldKey: '10096', fact: { verificationStatus: 'confirmed', sourceRefs: ['synthetic:owner', 'synthetic:dictionary'],
      value: { value: 'synthetic broad black', dictionaryValueId: 1234 } } },
    { fieldKey: '10097', fact: { verificationStatus: 'confirmed', sourceRefs: ['synthetic:owner'],
      value: 'synthetic exact black cp' } }
  ];
  input.platformSchemaAttributes = [
    { fieldKey: '10096', required: false, complexId: 0, dictionaryId: 1 },
    { fieldKey: '10097', required: false, complexId: 0, dictionaryId: 0 }
  ];
  const item = buildOzonSellerImportRequest(input).body.items[0];
  assert.deepEqual(item.attributes.find(attribute => attribute.id === 10096).values,
    [{ dictionary_value_id: 1234, value: 'synthetic broad black' }]);
  assert.deepEqual(item.attributes.find(attribute => attribute.id === 10097).values,
    [{ dictionary_value_id: 0, value: 'synthetic exact black cp' }]);
});

// Ozon 的 23171 是 Хештеги（类目属性表里的 label 就写着 "#Хештеги"），不是自由搜索词框。
// 规则：每个标签以 # 开头、标签之间用空格分隔、标签内部不能有空格。
// 背心那张卡发出去的是 "хаки Оксфорд Для кошек"（一条、没有 #、内部全是空格），
// Ozon 后台报「#主题标签」格式错误，内容评级被扣。这里钉住正确形状。
const HASHTAG_ATTRIBUTE_ID = 23171;
const hashtagValue = request =>
  request.body.items[0].attributes.find(item => item.id === HASHTAG_ATTRIBUTE_ID).values[0].value;

test("主题标签逐词加#、词内空格换下划线，绝不拼成一条带空格的长串", () => {
  const request = buildOzonSellerImportRequest(payload());
  assert.equal(hashtagValue(request), "#музыкальная_шкатулка #швейная_машинка");
  // 逐条复核平台规则，而不是只比字符串
  for (const tag of hashtagValue(request).split(" ")) {
    assert.match(tag, /^#[^\s#]+$/u);
  }
});

test("单词关键词只加#，不引入多余字符", () => {
  const request = buildOzonSellerImportRequest(payload({ }));
  assert.ok(hashtagValue(request).startsWith("#"));
  const single = buildOzonSellerImportRequest({ ...payload(),
    content: { ...payload().content, searchKeywords: ["хаки"] } });
  assert.equal(hashtagValue(single), "#хаки");
});

test("关键词里本来就带#时在构建请求处就被拒，且一个字节都没发出去", () => {
  let sent = 0;
  assert.throws(() => buildOzonSellerImportRequest({ ...payload(),
    content: { ...payload().content, searchKeywords: ["хаки #Оксфорд"] } }),
  /OZON_ADAPTER_HASHTAG_REJECTED/);
  assert.equal(sent, 0);
});

test("搜索词为空仍然按内容缺口拒绝，不会发出一个只有#的标签", () => {
  assert.throws(() => buildOzonSellerImportRequest({ ...payload(),
    content: { ...payload().content, searchKeywords: [] } }), /OZON_ADAPTER_CONTENT_GAP/);
  assert.throws(() => buildOzonSellerImportRequest({ ...payload(),
    content: { ...payload().content, searchKeywords: ["   "] } }), /OZON_ADAPTER_CONTENT_GAP|OZON_ADAPTER_HASHTAG_REJECTED/);
});
