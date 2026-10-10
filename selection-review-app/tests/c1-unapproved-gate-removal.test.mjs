import test from "node:test";
import assert from "node:assert/strict";

import { createC1ProductPlan, verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { createInitialCandidate } from "../lib/candidate-initialization.mjs";
import { extraHandlingFeeAssumptions, extraHandlingFeesConsistency } from "../lib/extra-handling-fees.mjs";
import { purchaseCeilingSummary, PROFIT_POLICY_VERSION } from "../lib/workflow.mjs";
import { phase7PassedState, platformSchemaEvidence } from "./fixtures/formal-c1-flow-fixture.mjs";
import {
  SYNTHETIC_NO_THIRD_PARTY_RIGHTS,
  SYNTHETIC_UNBRANDED,
  syntheticSkuRightsReview
} from "./fixtures/c1-sku-rights-review-fixture.mjs";

/**
 * 2026-09-09 的一个提交（7723cba，一次性 633 文件）把 C1→E 的整排门禁塞了进来，没有一道门追得到主人批准的
 * 证据。主人 2026-09-15 要求把「没人批准过的门」系统性删掉。这份回归钉住的就是删掉之后还剩什么在挡。
 *
 * 下面这个夹具照主人那两件真实商品（candidate:f2e447df… rev 36、candidate:2e417eaf… rev 56）的形状拼出来：
 *   · 冻结 Schema 只带 descriptionCategoryId / typeId / schemaRevision / requiredFields，
 *     没有 categoryId、categoryName、writeBindings、mediaRequirements、categoryRestrictions、platformCompliance；
 *   · requiredFields 是 Ozon 用属性号当 fieldKey 的四条，品牌是 85 Бренд；
 *   · 冻结供应 SKU 的 attributes 只有 quantityOneEvidence 和 purchaseCostComponents，powerProfile 整个是 "unknown"；
 *   · 主人已经签过权利声明，品牌 unbranded。
 * 真实数据上跑出来的结果和这里一模一样：改动前 20 条 unknown / 19 条阻断，改动后 19 条 unknown / 4 条阻断。
 */
const AT = "2026-09-15T10:00:00.000Z";

const OWNER_REQUIRED_FIELDS = Object.freeze([
  { fieldKey: "8229", label: "Тип", required: true, sourceAttributeKeys: ["8229"] },
  { fieldKey: "4958", label: "Предназначено для", required: true, sourceAttributeKeys: ["4958"] },
  { fieldKey: "85", label: "Бренд", required: true, sourceAttributeKeys: ["85"] },
  { fieldKey: "9048", label: "Название модели (для объединения в одну карточку)", required: true, sourceAttributeKeys: ["9048"] }
]);

/** 撤掉的每一道门，删掉之后必须仍然如实留在清单里——只是不再阻断。少一条就说明它被藏起来了。 */
const RETIRED_GATES = Object.freeze([
  "platformCategory.categoryId",
  "platformCategory.categoryName",
  "batteryAssessment.status",
  "batteryAssessment.assessment",
  "batteryAssessment.powered",
  "batteryAssessment.containsBattery",
  "batteryAssessment.batteryType",
  "batteryAssessment.batteryCount",
  "batteryAssessment.batteryCapacity",
  "categoryRestrictions.status",
  "categoryRestrictions.restrictions",
  "platformCompliance.status",
  "platformCompliance.assessment",
]);

/** 删完之后还该挡着的四条：三个字典属性取不到值，加上真实 import 非要不可的写入绑定。 */
const STILL_BLOCKING = Object.freeze([
  "productAttributes.requiredPlatformFields[0].fact",
  "productAttributes.requiredPlatformFields[1].fact",
  "productAttributes.requiredPlatformFields[3].fact",
  "schemaSnapshot.writeBindings"
]);

function ownerShapedInputs() {
  const state = structuredClone(phase7PassedState({ material: "unknown" }));
  const supplierSku = state.skuPackage.selectedSupplySnapshot.supplierSku;
  supplierSku.powerProfile = "unknown";
  supplierSku.attributes = {
    quantityOneEvidence: { source: "owner_quantity_one_confirmation", minimumOrderQuantity: 1, currency: "CNY" },
    purchaseCostComponents: { unitProductPrice: 40, unitDomesticFreight: 1, otherPurchaseCosts: 0, actualPurchaseCost: 41, currency: "CNY" }
  };
  const schema = platformSchemaEvidence({ storeRef: state.skuPackage.g1Identity.storeRef });
  schema.storeRef = structuredClone(state.skuPackage.g1Identity.storeRef);
  delete schema.categoryName;
  schema.requiredFields = structuredClone(OWNER_REQUIRED_FIELDS);
  return { state, schema };
}

function ownerShapedFacts({ signedRightsReview = true } = {}) {
  const { state, schema } = ownerShapedInputs();
  const created = createC1ProductPlan({ ...state, platformSchemaEvidence: schema, createdAt: AT });
  const skuRightsReview = signedRightsReview
    ? syntheticSkuRightsReview({ plan: created.c1ProductPlan, sourceIdentity: created.skuPackage.g1Identity,
      reviewedAt: AT, brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS })
    : null;
  return verifyC1ProductFacts({ skuPackage: created.skuPackage, skuRightsReview, verifiedAt: AT });
}

test("主人两件真实候选的形状上，19 条阻断只剩 4 条，而且每一条都指名道姓", () => {
  const { c1ProductPlan: plan } = ownerShapedFacts();
  const manifest = plan.unknownManifest;

  assert.deepEqual(manifest.filter(item => item.blocksC2Handoff).map(item => item.fieldPath).sort(), [...STILL_BLOCKING].sort());

  // 还挡着的那三条必填属性，正是取不到字典值的 8229 / 4958 / 9048；85 品牌不在其中。
  const fields = plan.productAttributes.requiredPlatformFields;
  assert.deepEqual(
    STILL_BLOCKING.filter(path => path.startsWith("productAttributes.requiredPlatformFields"))
      .map(path => fields[Number(path.match(/\[(\d+)\]/u)[1])].fieldKey),
    ["8229", "4958", "9048"]
  );

  // 撤掉的门一条都没有被藏起来：仍然逐条记着，只是 informational。
  for (const fieldPath of RETIRED_GATES) {
    const entry = manifest.find(item => item.fieldPath === fieldPath);
    assert.ok(entry, `${fieldPath} 应该仍然如实留在清单里`);
    assert.equal(entry.blockingScope, "informational", fieldPath);
    assert.equal(entry.blocksC2Handoff, false, fieldPath);
  }
  assert.equal(manifest.length, RETIRED_GATES.length + STILL_BLOCKING.length + 1); // + productAttributes.material
});

test("品牌接到主人已签的权利声明，不用他再输一次；没签过就还是阻断", () => {
  const brandOf = result => result.c1ProductPlan.productAttributes.requiredPlatformFields.find(field => field.fieldKey === "85");

  const signed = brandOf(ownerShapedFacts());
  assert.equal(signed.fact.verificationStatus, "confirmed");
  // 字典属性要的 dictionaryValueId 冻结 Schema 读不出来，就留 null——不编一个数上去。
  assert.deepEqual(signed.fact.value, { value: "Нет бренда", brandStatus: "unbranded", dictionaryValueId: null });
  assert.deepEqual(signed.fact.sourceRefs, [...SYNTHETIC_UNBRANDED.evidenceRefs]);

  const unsigned = ownerShapedFacts({ signedRightsReview: false });
  assert.equal(brandOf(unsigned).fact.verificationStatus, "unknown");
  assert.ok(unsigned.c1ProductPlan.unknownManifest.some(
    item => item.fieldPath === "productAttributes.requiredPlatformFields[2].fact" && item.blocksC2Handoff));

  // 撤掉的是平台合规那一档，不是主人自己签的那份声明：没签就照旧阻断。
  assert.deepEqual(
    unsigned.c1ProductPlan.unknownManifest
      .filter(item => item.fieldPath.startsWith("platformCompliance.skuRightsReview"))
      .map(item => [item.fieldPath, item.blockingScope, item.blocksC2Handoff]),
    [["platformCompliance.skuRightsReview.brand", "required_field", true],
      ["platformCompliance.skuRightsReview.rights", "required_field", true]]
  );
});

test("C1 事实核验一分钱都不碰已经存下来的利润", () => {
  const { state, schema } = ownerShapedInputs();
  const before = structuredClone(state.skuPackage.profitModels);
  const active = before.find(model => model.profitModelVersion === state.skuPackage.activeProfitModelVersion);
  // 逐分钉死：这份夹具自己算出来的钱是 ¥41.92 / 27.62%，漂一分都会在这里红。
  assert.equal(active.unitProfitRmb, 41.92);
  assert.equal(active.profitMargin, 0.2762);
  assert.equal(active.result, "passed");

  const created = createC1ProductPlan({ ...state, platformSchemaEvidence: schema, createdAt: AT });
  const review = syntheticSkuRightsReview({ plan: created.c1ProductPlan, sourceIdentity: created.skuPackage.g1Identity,
    reviewedAt: AT, brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS });
  const result = verifyC1ProductFacts({ skuPackage: created.skuPackage, skuRightsReview: review, verifiedAt: AT });

  assert.deepEqual(result.skuPackage.profitModels, before);
  assert.equal(result.skuPackage.activeProfitModelVersion, state.skuPackage.activeProfitModelVersion);
  assert.deepEqual(result.c1ProductPlan.inputSnapshots.profitModel, active);
  assert.equal(result.c1ProductPlan.platformCompliance.profitGate.value, "passed");
});

const STORE_BINDINGS = Object.freeze([{ targetStore: "dandanshu",
  storeRef: { stableStoreId: "dandanshu", platformStoreId: "fixture-seller-001", mappingVersion: "fixture-stores-v1" } }]);

function newCandidate(source) {
  return createInitialCandidate({ input: { targetStore: "dandanshu" }, source,
    id: `candidate:${source}-1`, timestamp: AT, storeBindings: STORE_BINDINGS });
}

test("新建候选不带任何主人没声明过的金额", () => {
  for (const source of ["user", "software"]) {
    const candidate = newCandidate(source);
    assert.equal(candidate.packagingCostRmb, null, source);
    // 「算利润」那一步认得出这是「还没说」，不是 ¥0 也不是 ¥1.50。
    assert.equal(extraHandlingFeesConsistency(candidate).status, "absent", source);
    assert.deepEqual(extraHandlingFeeAssumptions(candidate),
      { packagingRmbDefault: 0, extraHandlingDeclared: false, extraHandlingStatus: "absent" });
    // 采购上限里也不会冒出一个没人签过的 ¥1.50。
    const ceiling = purchaseCeilingSummary(candidate);
    assert.equal(ceiling.status, "unavailable", source);
    assert.equal(Object.hasOwn(ceiling, "packagingRmb"), false, source);
  }
});

test("历史候选的钱逐分不变：46 件 ¥1.50 的照旧，主人两件已声明的 ¥0 仍然算已声明", () => {
  const legacy = { ...newCandidate("user"), id: "candidate:legacy-1", packagingCostRmb: 1.5, purchasePriceRmb: 30,
    purchaseCeiling: { status: "estimated", scope: "purchase_plus_domestic_shipping", sellerRevenueRmb: 100,
      commissionRate: 0.14, internationalLogisticsRmb: 12, packagingRmb: 1.5, labelRmb: 0.5,
      checkedAt: "2026-09-01T00:00:00.000Z", pricingPolicyVersion: PROFIT_POLICY_VERSION } };
  assert.deepEqual(extraHandlingFeesConsistency(legacy),
    { status: "total_only", items: null, totalRmb: 1.5, packagingCostRmb: 1.5, reason: "" });
  const ceiling = purchaseCeilingSummary(legacy);
  assert.equal(ceiling.status, "estimated");
  assert.equal(ceiling.packagingRmb, 1.5);
  assert.equal(ceiling.nonPurchaseFixedRmb, 14);
  assert.equal(ceiling.maximumAllInPurchaseRmb, 45);
  assert.equal(ceiling.unitProfitRmb, 30);
  assert.equal(ceiling.marginRate, 0.3);

  // 主人那两件已经在「算利润」里签过 ¥0：¥0 是一个声明，不能被当成「还没说」。
  const declaredZero = { ...newCandidate("user"), id: "candidate:declared-zero", packagingCostRmb: 0 };
  assert.equal(extraHandlingFeesConsistency(declaredZero).status, "total_only");
  assert.equal(extraHandlingFeesConsistency(declaredZero).totalRmb, 0);
  assert.deepEqual(extraHandlingFeeAssumptions(declaredZero),
    { packagingRmbDefault: 0, extraHandlingDeclared: true, extraHandlingStatus: "total_only" });
});
