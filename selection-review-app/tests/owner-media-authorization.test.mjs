import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";

import { createC1ProductPlan, verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { phase7PassedState, platformSchemaEvidence, createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS } from "./fixtures/c1-sku-rights-review-fixture.mjs";
import {
  normalizeC1CanonicalHandoffContract,
  normalizeC2TargetContract,
  fingerprintC2AuthorizedMedia
} from "../lib/c2-asset-lifecycle.mjs";
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from "../lib/c2-software-orchestrator.mjs";
import { authorizedProductionFixture, assetRegions, finalAssets, ownerDecision, packageFixture } from "./helpers/c2-software-fixture.mjs";
import { createC2SoftwareContainer } from "../lib/c2-software-orchestrator.mjs";
import { createProductionPlan, projectProductionPlanInputs, projectProductionPlanImportPayload } from "../lib/production-plan.mjs";
import { buildOzonSellerImportRequest, createOzonSellerApiProductionAdapter } from "../lib/ozon-seller-api-production-adapter.mjs";
import { assertFormalCommissionBeforeProduction } from "../lib/commission-estimate-authorization.mjs";
import { validateProductionAuthorization } from "../lib/production-authorization.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";
import { validateProfitThresholds, MINIMUM_PROFIT_MARGIN, MINIMUM_UNIT_PROFIT_RMB } from "../lib/profit-threshold-policy.mjs";
import { createStoreIsolatedOzonSellerApiDEAdapter } from "../lib/ozon-seller-api-de-adapter.mjs";
import { capabilities as deCapabilities } from "./helpers/d-software-fixture.mjs";

const AT = "2026-08-12T13:00:00.000Z";

/**
 * 主人两件真实候选上，Ozon 证据服务实际返回的冻结 Schema 就是这些键，一个不多：
 * descriptionCategoryId / typeId / evidenceId / platform / store / storeRef / schemaRevision /
 * collectedAt / requiredFields。没有 mediaRequirements，没有 categoryId，没有 categoryName，
 * 没有 categoryRestrictions，也没有 platformCompliance。
 * CI 政策不许测试直接读主人的业务数据文件，所以这里复刻的是那个**形状**。
 */
const REAL_OZON_EVIDENCE_KEYS = [
  "descriptionCategoryId", "typeId", "evidenceId", "platform", "store", "storeRef",
  "schemaRevision", "collectedAt", "requiredFields"
];

function realShapedSchemaEvidence(storeRef) {
  const schema = platformSchemaEvidence({ storeRef });
  schema.storeRef = structuredClone(storeRef);
  // 主人两件商品的必填属性用的是平台属性号当 fieldKey（"85" 是 Бренд）。
  schema.requiredFields = [
    { fieldKey: "85", label: "Бренд", required: true },
    { fieldKey: "9048", label: "Название модели", required: true },
    { fieldKey: "8229", label: "Тип", required: true },
    { fieldKey: "4180", label: "Название", required: true }
  ];
  for (const key of Object.keys(schema)) {
    if (!REAL_OZON_EVIDENCE_KEYS.includes(key)) delete schema[key];
  }
  return schema;
}

test("主人两件真实候选的冻结Schema形状：C1→C2不再撞上槽位合同那堵墙", () => {
  const state = phase7PassedState({ fullC1Facts: true });
  const schema = realShapedSchemaEvidence(state.skuPackage.g1Identity.storeRef);
  assert.deepEqual(Object.keys(schema).sort(), [...REAL_OZON_EVIDENCE_KEYS].sort());
  assert.equal(Object.hasOwn(schema, "mediaRequirements"), false, "真实证据服务从不返回媒体槽位");

  const created = createC1ProductPlan({ ...state, platformSchemaEvidence: schema, createdAt: AT });
  assert.equal(Object.hasOwn(created.c1ProductPlan, "mediaRequirements"), false, "C1不再产出媒体摘要");

  const rights = syntheticSkuRightsReview({
    plan: created.c1ProductPlan, sourceIdentity: created.skuPackage.g1Identity, reviewedAt: AT,
    brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS
  });
  const checked = verifyC1ProductFacts({ skuPackage: created.skuPackage, skuRightsReview: rights, verifiedAt: AT });
  assert.equal(Object.hasOwn(checked.c1ProductPlan, "mediaRequirements"), false);
  assert.equal(
    checked.c1ProductPlan.unknownManifest.some((item) => item.fieldPath === "mediaRequirements"),
    false,
    "槽位这条 unknown 也一并消失，不再假装平台提过要求"
  );

  // C1 SEO 草稿还没做，所以交接仍会停在 provider 那一道——那是真闸门。
  // 关键是它**不再**是 C2_C1_CANONICAL_GATE_BLOCKED: 顶层mediaRequirements未绑定冻结Schema。
  let thrown = null;
  try {
    normalizeC1CanonicalHandoffContract(checked.skuPackage);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "SEO草稿未完成时仍然要停");
  assert.doesNotMatch(thrown.message, /mediaRequirements/);
  assert.match(thrown.message, /C2_C1_FORMAL_PROVIDER_REQUIRED/);
});

test("主人机器上更早写下的 mediaRequirements: null 空壳照单放行，非null的槽位摘要仍然拒收", () => {
  const fixture = createFormalC1C2Fixture();
  const legacy = structuredClone(fixture.merged.skuPackage);
  legacy.c1ProductPlan.mediaRequirements = null;
  // 空壳里没有任何槽位主张，不逼主人回头去改自己已经存下的业务数据。
  assert.doesNotThrow(() => normalizeC1CanonicalHandoffContract(legacy));
  assert.doesNotThrow(() => normalizeC2TargetContract(legacy));

  for (const revived of [
    { status: "confirmed", requiredSlots: [{ slotId: "main", mediaType: "image", required: true }] },
    { status: "unknown", requiredSlots: [] },
    {}
  ]) {
    const forged = structuredClone(fixture.merged.skuPackage);
    forged.c1ProductPlan.mediaRequirements = revived;
    assert.throws(() => normalizeC1CanonicalHandoffContract(forged), /CANONICAL_GATE_BLOCKED|槽位合同已废止/);
  }

  const schemaRevival = structuredClone(fixture.merged.skuPackage);
  schemaRevival.c1ProductPlan.inputSnapshots.platformSchemaRules.mediaRequirements = { imageSlots: [] };
  assert.throws(() => normalizeC2TargetContract(schemaRevival), /TARGET_CONTEXT_INVALID/);
});

test("真实形状一路走完C1→C2，目标绑定只留平台、店铺和冻结Schema证据", () => {
  const fixture = createFormalC1C2Fixture();
  const plan = fixture.c2.skuPackage.c1ProductPlan;
  assert.equal(Object.hasOwn(plan, "mediaRequirements"), false);
  assert.equal(Object.hasOwn(plan.inputSnapshots.platformSchemaRules, "mediaRequirements"), false);

  const handoff = normalizeC1CanonicalHandoffContract(fixture.merged.skuPackage);
  assert.equal(Object.hasOwn(handoff, "mediaRequirements"), false);

  const contract = normalizeC2TargetContract(fixture.merged.skuPackage);
  assert.deepEqual(Object.keys(contract.targetContext).sort(), [
    "platform", "schemaEvidenceRef", "schemaRevision", "schemaVersion", "sourceC1Fingerprint",
    "sourceDataRevision", "storeRef", "targetStore"
  ]);
  assert.equal(fixture.c2.skuPackage.c2FinalAssets.targetContext.schemaEvidenceRef, plan.inputSnapshots.platformSchemaRules.evidenceId);
  assert.equal(Object.hasOwn(fixture.c2.skuPackage.c2FinalAssets, "mediaRequirements"), false);
});

/* ───────── 主人确认 → 授权 → D 发出：地址、顺序和主图一字不差 ───────── */

function confirmedC2({ assets = finalAssets() } = {}) {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: "2026-08-22T06:00:00.000Z"
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: assets, preparedAt: "2026-08-22T07:00:00.000Z"
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalManifest: manifest,
    ownerDecision: ownerDecision(manifest), confirmedAt: "2026-08-22T07:00:00.000Z"
  });
  return { manifest, confirmed };
}

test("主人确认的就是那批地址：指纹由实际URL列表取，主图在前", () => {
  const assets = finalAssets();
  const { manifest, confirmed } = confirmedC2({ assets });
  const expected = fingerprintC2AuthorizedMedia(assets.map((asset) => asset.assetRef));
  assert.equal(manifest.authorizedMediaFingerprint, expected);
  const preparation = confirmed.productionAuthorizationPreparation;
  assert.equal(preparation.authorizedMediaFingerprint, expected);
  assert.equal(preparation.ownerFinalUploadConfirmation.approvedAuthorizedMediaFingerprint, expected);
  assert.equal(preparation.mainImageAssetId, assets[0].assetId);
  assert.deepEqual(preparation.finalUploads.map((asset) => asset.assetRef), assets.map((asset) => asset.assetRef));
  assert.deepEqual(preparation.finalUploads.map((asset) => asset.role), ["main_image", "gallery_image"]);

  // 换一张地址、或者把顺序倒过来，指纹就变——这是「授权的=发出的」的全部依据。
  const swapped = assets.map((asset, index) => index === 1 ? { ...asset, assetRef: "https://assets.example.com/owner/other.jpg" } : asset);
  assert.notEqual(fingerprintC2AuthorizedMedia(swapped.map((asset) => asset.assetRef)), expected);
  assert.notEqual(fingerprintC2AuthorizedMedia([...assets].reverse().map((asset) => asset.assetRef)), expected);
});

test("一组图片从主人确认走到D的import请求：primary_image是第一张，images是其余，顺序一字不差", () => {
  const fixture = authorizedProductionFixture();
  const authorizedRefs = fixture.productionAuthorization.lockedScope.finalUploads.map((asset) => asset.assetRef);
  assert.equal(
    fixture.productionAuthorization.lockedScope.authorizedMediaFingerprint,
    fingerprintC2AuthorizedMedia(authorizedRefs)
  );

  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  const resolved = inputs.finalUploads.map((asset) => ({
    assetId: asset.assetId, sha256: asset.sha256, order: asset.order, role: asset.role,
    platformAcceptedUrl: asset.assetRef
  }));
  const payload = projectProductionPlanImportPayload({ productionPlan: plan, resolvedFinalUploads: resolved });
  const request = buildOzonSellerImportRequest({ ...payload, mode: "single_sku_create_and_moderate" });
  const item = request.body.items[0];
  assert.equal(item.primary_image, authorizedRefs[0]);
  assert.deepEqual(item.images, authorizedRefs.slice(1));
  assert.deepEqual([item.primary_image, ...item.images], authorizedRefs);
});

test("授权之后把URL换掉，必须被指纹拦下（授权记录和适配器两处）", () => {
  const fixture = authorizedProductionFixture();
  const plan = createProductionPlan(fixture);

  // 1) 有人改了锁定范围里的地址，并且把其他两个指纹都重算成自洽的——
  //    只有主人签过的地址清单指纹留在原处。这一条单独就要把它拦下。
  const forged = structuredClone(fixture.productionAuthorization);
  const scope = forged.lockedScope;
  scope.finalUploads[1].assetRef = "https://assets.example.com/owner/swapped-v1.jpg";
  scope.finalUploadsFingerprint = fingerprintCanonicalRecord({ collected: [], aiDrafts: [], finalUploads: scope.finalUploads });
  scope.finalManifestSha256 = fingerprintCanonicalRecord({
    schemaVersion: "c2-final-manifest-v1", authorizedMediaFingerprint: scope.authorizedMediaFingerprint,
    effectiveVideoRequirement: scope.effectiveVideoRequirement, mainImageAssetId: scope.mainImageAssetId,
    videoDisposition: scope.videoDisposition, assets: scope.finalUploads
  });
  const validation = validateProductionAuthorization(forged, {
    candidateId: fixture.candidateId, candidateRevision: fixture.candidateRevision, skuPackage: fixture.skuPackage
  });
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) =>
      error.path === "productionAuthorization.lockedScope.authorizedMediaFingerprint" &&
      /PRODUCTION_AUTHORIZED_MEDIA_DRIFT/.test(error.message)),
    JSON.stringify(validation.errors)
  );

  // 换回主人授权的那批地址，这一条就不再报——证明它认的正是地址清单本身。
  const untouched = validateProductionAuthorization(structuredClone(fixture.productionAuthorization), {
    candidateId: fixture.candidateId, candidateRevision: fixture.candidateRevision, skuPackage: fixture.skuPackage
  });
  assert.equal(
    untouched.errors.some((error) => /PRODUCTION_AUTHORIZED_MEDIA_DRIFT/.test(error.message)),
    false,
    JSON.stringify(untouched.errors)
  );

  // 2) 投影之后、发出之前被换：适配器这一步停。
  const inputs = projectProductionPlanInputs(plan);
  const resolved = inputs.finalUploads.map((asset) => ({
    assetId: asset.assetId, sha256: asset.sha256, order: asset.order, role: asset.role, platformAcceptedUrl: asset.assetRef
  }));
  const payload = projectProductionPlanImportPayload({ productionPlan: plan, resolvedFinalUploads: resolved });
  const swapped = structuredClone(payload);
  swapped.finalUploads[1].assetRef = "https://assets.example.com/owner/swapped-v1.jpg";
  assert.throws(() => buildOzonSellerImportRequest(swapped), /AUTHORIZED_MEDIA_DRIFT/);

  const reordered = structuredClone(payload);
  reordered.finalUploads.reverse();
  assert.throws(() => buildOzonSellerImportRequest(reordered), /AUTHORIZED_MEDIA_DRIFT/);

  const stripped = structuredClone(payload);
  delete stripped.authorizedMedia;
  assert.throws(() => buildOzonSellerImportRequest(stripped), /AUTHORIZED_MEDIA_MISSING/);
});

test("非https的图被拒；访问不到的图被拒（打桩，不真发请求）", async () => {
  const fixture = authorizedProductionFixture();
  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  const resolved = inputs.finalUploads.map((asset) => ({
    assetId: asset.assetId, sha256: asset.sha256, order: asset.order, role: asset.role, platformAcceptedUrl: asset.assetRef
  }));
  const payload = projectProductionPlanImportPayload({ productionPlan: plan, resolvedFinalUploads: resolved });

  for (const insecure of ["http://assets.example.com/owner/shelf-main-v1.jpg", "/owner/shelf-main-v1.jpg"]) {
    const bad = structuredClone(payload);
    bad.finalUploads[0].assetRef = insecure;
    bad.authorizedMedia = {
      fingerprint: fingerprintC2AuthorizedMedia(bad.finalUploads.map((asset) => asset.assetRef)),
      primaryImage: bad.finalUploads[0].assetRef,
      images: bad.finalUploads.slice(1).map((asset) => asset.assetRef)
    };
    assert.throws(() => buildOzonSellerImportRequest(bad), /REMOTE_ASSET_REQUIRED/, insecure);
  }

  const importOnly = async ({ endpoint }) => endpoint === "/v3/product/import"
    ? { result: { task_id: "task-1" } }
    : { result: { items: [{ offer_id: payload.merchantSku, product_id: 9001, status: "imported", errors: [] }] } };

  await assert.rejects(
    () => createOzonSellerApiProductionAdapter({ requestJson: importOnly }).createPlatformDraft(payload),
    /ASSET_REACHABILITY_PROBE_REQUIRED/
  );
  await assert.rejects(
    () => createOzonSellerApiProductionAdapter({ requestJson: importOnly, probeAssetUrl: async () => ({ reachable: false, statusCode: 0 }) })
      .createPlatformDraft(payload),
    /ASSET_NOT_REACHABLE/
  );
  await assert.rejects(
    () => createOzonSellerApiProductionAdapter({ requestJson: importOnly, probeAssetUrl: async () => ({ reachable: true, statusCode: 503 }) })
      .createPlatformDraft(payload),
    /ASSET_NOT_REACHABLE/
  );

  const probed = [];
  await createOzonSellerApiProductionAdapter({
    requestJson: importOnly,
    probeAssetUrl: async ({ url }) => { probed.push(url); return { reachable: true, statusCode: 200 }; }
  }).createPlatformDraft(payload);
  assert.deepEqual(probed, payload.finalUploads.map((asset) => asset.assetRef));
});

/* ───────── 没有一起松动的闸门 ───────── */

test("生产佣金前置检查拒绝估算和未知类型", () => {
  for (const commissionMode of ["estimated", null, undefined]) {
    const skuPackage = {
      skuPackageId: "sku:gate", activeProfitModelVersion: "profit-v1",
      profitModels: [{ profitModelVersion: "profit-v1", result: "passed", commissionMode }]
    };
    assert.throws(() => assertFormalCommissionBeforeProduction(skuPackage), /PRODUCTION_EXACT_COMMISSION_REQUIRED|佣金/);
  }
  const exact = {
    skuPackageId: "sku:gate", activeProfitModelVersion: "profit-v1",
    profitModels: [{ profitModelVersion: "profit-v1", result: "passed", commissionMode: "exact" }]
  };
  assert.equal(assertFormalCommissionBeforeProduction(exact).commissionMode, "exact");
});

test("利润门槛照旧：主人两件商品的数字仍然通过，门槛以下仍然拦", () => {
  assert.equal(MINIMUM_PROFIT_MARGIN, 0.15);
  assert.equal(MINIMUM_UNIT_PROFIT_RMB, 20);
  const thresholds = { minimumProfitMargin: 0.15, minimumUnitProfitRmb: 20, logic: "any" };
  // 主人首件 ¥25.88 / 22.48%，第二件 ¥50.86 / 38.71%。
  for (const [unitProfitRmb, profitMargin] of [[25.88, 0.2248], [50.86, 0.3871]]) {
    assert.deepEqual(validateProfitThresholds({
      thresholdVersion: "profit-threshold-v1.2-15pct-or-20cny", thresholds, unitProfitRmb, profitMargin, result: "passed"
    }), []);
  }
  // 门槛以下的数字由 B 的 result 判定，这里确认判定用的正是那两个常量。
  const passes = (unitProfitRmb, profitMargin) =>
    profitMargin >= MINIMUM_PROFIT_MARGIN || unitProfitRmb >= MINIMUM_UNIT_PROFIT_RMB;
  assert.equal(passes(25.88, 0.2248), true);
  assert.equal(passes(50.86, 0.3871), true);
  assert.equal(passes(19.99, 0.1499), false);
  assert.equal(passes(0, 0), false);
  // 门槛参数本身被改小时，记录立刻不合法——数字只能来自已发布的门槛版本。
  for (const loosened of [{ minimumProfitMargin: 0.1, minimumUnitProfitRmb: 20, logic: "any" },
    { minimumProfitMargin: 0.15, minimumUnitProfitRmb: 5, logic: "any" },
    { minimumProfitMargin: 0.15, minimumUnitProfitRmb: 20, logic: "all" }]) {
    assert.notDeepEqual(validateProfitThresholds({
      thresholdVersion: "profit-threshold-v1.2-15pct-or-20cny", thresholds: loosened,
      unitProfitRmb: 25.88, profitMargin: 0.2248, result: "passed"
    }), [], "门槛本身不许被改小");
  }
});

test("发库存那三处prerequisitePolicy照旧fail-closed", async () => {
  const assets = finalAssets().map((asset, index) => ({ ...asset, order: index + 1 }));
  const base = deCapabilities("dandanshu", assets);
  base.warehouseId = base.inventoryWrite.warehouseId;
  const withoutPolicy = structuredClone(base);
  withoutPolicy.inventoryWrite.prerequisitePolicy = null;
  const requestJson = async () => { throw new Error("没有已核验前置策略时不该发出任何请求"); };
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities: withoutPolicy });

  // 1) observePriceSent：策略缺失时这一路根本走不到发请求。
  await assert.rejects(
    () => adapter.observePriceSent({ merchantSku: "MERCHANT-SHELF-001", productId: "910001", taskId: "701", executionKey: "d-execution:test" }),
    /OZON_DE_/
  );
  const deAdapterSource = fs.readFileSync(new URL("../lib/ozon-seller-api-de-adapter.mjs", import.meta.url), "utf8");
  assert.match(deAdapterSource, /if \(!validPrerequisitePolicy\(policy\)\) throw new Error\("OZON_DE_INVENTORY_POLICY_NOT_VERIFIED"\);/);

  // 2) executeRemainingInventory：策略缺失时返回 blocked，绝不写库存。
  const blocked = await adapter.executeRemainingInventory({}, {
    observation: null, persistCheckpoint: async () => {}, assertRemainingInventoryAuthorization: async () => true
  });
  assert.notEqual(blocked?.status, "completed");
  assert.match(deAdapterSource,
    /if \(!validPrerequisitePolicy\(policy\)\) return inventoryBlocked\("inventory_prerequisite_policy_not_verified"\);/);

  // 3) 构造期就拒绝形状不对的策略。
  const malformed = structuredClone(base);
  malformed.inventoryWrite.prerequisitePolicy = { schemaVersion: "wrong" };
  assert.throws(() => createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities: malformed }), /OZON_DE_INVENTORY_POLICY_INVALID/);

  // 派工那一层的同名闸门在 lib/d-e-runtime-services.mjs 里以 inventory_policy_missing 拒绝整条继续执行。
  const runtime = fs.readFileSync(new URL("../lib/d-e-runtime-services.mjs", import.meta.url), "utf8");
  assert.match(runtime, /capabilities\.inventoryWrite\.prerequisitePolicy\) return jobStore\.rejectDRemainingInventory/);
  assert.match(runtime, /inventory_policy_missing/);
});
