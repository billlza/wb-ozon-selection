import { createSyntheticBCostPolicy } from "./fixtures/b-cost-policy-fixture.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createLifecycleBInputBundle,
  normalizeCurrentCommissionCatalogs,
  isLifecycleEvidenceTraceValid,
  inspectCommissionCatalogValidity,
  inspectLifecycleBInputReadiness,
  resolveLifecycleEvidenceContext,
  validateLifecycleBInputBundle,
  validateLifecycleEvidenceData,
  validateLifecycleBOtherCosts
} from "../lib/lifecycle-b-input-bundle.mjs";
import { GLOBAL_PRICING_POLICY_VERSION } from "../lib/global-pricing-policy.mjs";
import { GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS } from "../lib/guoo-tariff-reader.mjs";

const createdAt = "2026-08-18T02:00:00.000Z";

test("历史GUOO默认计费证据保留但不能复用于新正式利润", () => {
  const evidence = packs();
  const logistics = evidence.find(pack => pack.kind === "logistics_tariff");
  logistics.sourceType = "guoo_current_tariff_xlsx";
  const before = structuredClone(evidence);
  const readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: evidence, asOf: createdAt });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.fields.find(field => field.key === "logistics_tariff").status, "legacy_unverified");
  assert.throws(() => createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(), evidencePacks: evidence,
    normalizedSubmission: normalizedSubmission(), createdAt }), /SYSTEM_EVIDENCE_GAP/);
  assert.deepEqual(evidence, before);
  assert.equal(validateLifecycleEvidenceData("logistics_tariff", { ...logistics.evidenceData,
    calculationRuleStatus: "legacy_unverified" }).valid, false);
});

test("只有逐格核对过报价公式的那一次国欧读取能进正式计算，存下来的旧读取结果照旧被拒", () => {
  // 三份证据包只差 calculationRuleStatus 一个字段：核对过的可用，写着 legacy_unverified 的和
  // 根本没有这个字段的（更早的读取器留下的）都不可用，而且理由要说得出是哪一种。
  const cases = [
    [GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS, true, "current"],
    ["legacy_unverified", false, "legacy_unverified"],
    [undefined, false, "legacy_unverified"],
  ];
  for (const [calculationRuleStatus, usable, status] of cases) {
    const evidence = packs();
    const logistics = evidence.find(pack => pack.kind === "logistics_tariff");
    logistics.sourceType = "guoo_current_tariff_xlsx";
    if (calculationRuleStatus !== undefined) logistics.evidenceData.calculationRuleStatus = calculationRuleStatus;
    const readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: evidence, asOf: createdAt });
    assert.equal(readiness.fields.find(field => field.key === "logistics_tariff").status, status, String(calculationRuleStatus));
    assert.equal(readiness.ready, usable, String(calculationRuleStatus));
    if (usable) {
      const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(), evidencePacks: evidence,
        normalizedSubmission: normalizedSubmission(), createdAt });
      assert.equal(bundle.logisticsEvidence.evidenceId, "EP-LOGISTICS");
      assert.equal(bundle.logisticsEvidence.tariff.calculationRuleStatus, GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS);
    } else {
      assert.throws(() => createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(), evidencePacks: evidence,
        normalizedSubmission: normalizedSubmission(), createdAt }), /SYSTEM_EVIDENCE_GAP/);
    }
  }
});

function candidate() {
  return {
    id: "TEST-A-ONE-CARD",
    dataRevision: 7,
    packagingCostRmb: 1.5,
    targetStore: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    lifecycleEvidenceContextV11: {
      platform: "ozon",
      store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
      category: "music-box",
      salesScheme: "rfbs",
      route: "guoo-economy-small",
      logisticsRuleVersion: "guoo-2026-07-20",
      exchangePair: "RUB/CNY",
      schemaRuleVersion: "ozon-music-box-2026-08-18"
    }
  };
}

function normalizedSubmission() {
  return {
    supplierConfirmation: {
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 }
    }
  };
}

function currentCosts(source = candidate()) {
  const context = source.lifecycleEvidenceContextV11;
  const costPolicySnapshot = createSyntheticBCostPolicy({ scope: Object.fromEntries(["platform", "store", "storeRef", "salesScheme"].map(key => [key, context[key]])) });
  return { costPolicySnapshot, acquiringRate: 0, taxRate: 0, otherRate: 0, packagingRmb: 1.5, labelRmb: 1.5, fixedOtherRmb: 0, advertisingRate: 0,
    returnReserveRate: 0, damageReserveRate: 0.05, withdrawalFeeRate: 0.02,
    targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceIncrementCny: 1,
    thresholdLogic: "any", pricingPolicyVersion: costPolicySnapshot.policyVersion };
}

function packs() {
  const common = {
    status: "active",
    sourceType: "isolated_test",
    sourceRef: "fixture:lifecycle-b-evidence",
    checkedAt: createdAt,
    expiresAt: "2026-08-19T02:00:00.000Z"
  };
  return [{
    ...common,
    id: "EP-COMMISSION",
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", salesScheme: "rfbs" },
    evidenceData: {
      commissionRate: 0.14,
      commissionEvidenceMode: "exact",
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: GLOBAL_PRICING_POLICY_VERSION
      }
    }
  }, {
    ...common,
    id: "EP-LOGISTICS",
    kind: "logistics_tariff",
    scope: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
    evidenceData: {
      chargeableWeightRule: "max_actual_volume",
      perKgRmb: 20,
      perParcelRmb: 10,
      volumeDivisorCm3PerKg: 6000,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1
    }
  }, {
    ...common,
    id: "EP-FX",
    kind: "exchange_rate",
    scope: { pair: "RUB/CNY" },
    evidenceData: { rubPerCny: 12 }
  }, {
    ...common,
    id: "EP-SCHEMA",
    kind: "schema",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "music-box", ruleVersion: "ozon-music-box-2026-08-18" },
    evidenceData: { schemaRevision: "ozon-music-box-2026-08-18", requiredFields: [] }
  }];
}

test("四类精确证据包可冻结为B输入并按SKU重量尺寸计算运费", () => {
  const source = candidate();
  const before = JSON.stringify(source);
  const readiness = inspectLifecycleBInputReadiness({ candidate: source, evidencePacks: packs(), asOf: createdAt });
  assert.equal(readiness.ready, true);
  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(),
    candidate: source,
    evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(),
    createdAt
  });
  assert.equal(bundle.browserSupplied, false);
  assert.deepEqual(bundle.sourcePackIds, ["EP-COMMISSION", "EP-LOGISTICS", "EP-FX", "EP-SCHEMA"]);
  assert.equal(bundle.logisticsEvidence.actualWeightKg, 0.4);
  assert.equal(bundle.logisticsEvidence.volumeWeightKg, 0.168);
  assert.equal(bundle.logisticsEvidence.chargeableWeightKg, 0.4);
  assert.equal(bundle.logisticsEvidence.amountRmb, 18);
  assert.equal(bundle.platformSchemaEvidence.store, "dandanshu");
  assert.equal(JSON.stringify(source), before);
});

test("B preserves actual C1 Schema content without importing payload identity or execution controls", () => {
  const evidencePacks = packs();
  const actualContent = {
    categoryId: "category:synthetic:music-box", categoryName: "Music box", descriptionCategoryId: "17001", typeId: "93001",
    writeBindings: { schemaRevision: "ozon-music-box-2026-08-18", evidenceRef: "EP-SCHEMA", content: {} },
    categoryRestrictions: { status: "confirmed", restrictions: [] }, platformCompliance: { status: "confirmed", assessment: "allowed" }
  };
  Object.assign(evidencePacks[3].evidenceData, actualContent, {
    evidenceId: "payload-cannot-replace-pack", platform: "wb", store: "miska", storeRef: {},
    collectedAt: "1900-01-01T00:00:00.000Z", productionAuthorized: true, confirmedBy: "pretend-owner"
  });
  const before = structuredClone(evidencePacks);
  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(), evidencePacks,
    normalizedSubmission: normalizedSubmission(), createdAt });
  for (const [field, value] of Object.entries(actualContent)) assert.deepEqual(bundle.platformSchemaEvidence[field], value);
  assert.equal(bundle.platformSchemaEvidence.evidenceId, "EP-SCHEMA");
  assert.equal(bundle.platformSchemaEvidence.platform, "ozon");
  assert.equal(bundle.platformSchemaEvidence.store, "dandanshu");
  assert.deepEqual(bundle.platformSchemaEvidence.storeRef, SYNTHETIC_STORE_REF);
  assert.equal(bundle.platformSchemaEvidence.ruleVersion, evidencePacks[3].scope.ruleVersion);
  assert.equal(bundle.platformSchemaEvidence.collectedAt, createdAt);
  assert.equal(Object.hasOwn(bundle.platformSchemaEvidence, "productionAuthorized"), false);
  assert.equal(Object.hasOwn(bundle.platformSchemaEvidence, "confirmedBy"), false);
  assert.equal(Object.hasOwn(bundle.platformSchemaEvidence, "mediaRequirements"), false);
  assert.deepEqual(evidencePacks, before);
  const absent = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(), evidencePacks: packs(), normalizedSubmission: normalizedSubmission(), createdAt });
  for (const field of Object.keys(actualContent)) assert.equal(Object.hasOwn(absent.platformSchemaEvidence, field), false);
});

test("过期、适用键不一致或只有摘要的证据包均不能作为B输入", () => {
  const expired = packs();
  expired[0].expiresAt = "2026-08-18T02:30:00.000Z";
  let readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: expired, asOf: "2026-08-18T03:00:00.000Z" });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["当前平台佣金与其他成本证据"]);
  assert.equal(readiness.fields[0].status, "expired");

  const wrongStore = packs();
  wrongStore[3].scope.store = "miska";
  readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: wrongStore, asOf: createdAt });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["当前平台Schema证据"]);
  assert.equal(readiness.fields[3].status, "scope_mismatch");

  const metadataOnly = packs();
  delete metadataOnly[1].evidenceData;
  readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: metadataOnly, asOf: createdAt });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["当前国际物流资费规则"]);
  assert.equal(readiness.fields[1].status, "metadata_only");
});

test("适用范围缺失或与目标店铺冲突时不猜测并阻止证据匹配", () => {
  const missingContext = candidate();
  delete missingContext.lifecycleEvidenceContextV11.salesScheme;
  const missing = resolveLifecycleEvidenceContext(missingContext);
  assert.equal(missing.ready, false);
  assert.match(missing.missing.join("、"), /销售模式/);
  const readiness = inspectLifecycleBInputReadiness({ candidate: missingContext, evidencePacks: packs(), asOf: createdAt });
  assert.equal(readiness.contextReady, false);
  assert.ok(readiness.fields.every((field) => field.status === "waiting_context"));

  const conflict = candidate();
  conflict.lifecycleEvidenceContextV11.store = "miska";
  const resolved = resolveLifecycleEvidenceContext(conflict);
  assert.equal(resolved.ready, false);
  assert.match(resolved.missing.join("、"), /店铺.*冲突/);
});

test("同一适用范围的系统证据可跨SKU复用，但运费仍按各SKU包装独立计算", () => {
  const first = candidate();
  const second = { ...candidate(), id: "TEST-A-SECOND-SKU", dataRevision: 3 };
  const firstBundle = createLifecycleBInputBundle({ otherCosts: currentCosts(),
    candidate: first,
    evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(),
    createdAt
  });
  const secondBundle = createLifecycleBInputBundle({ otherCosts: currentCosts(),
    candidate: second,
    evidencePacks: packs(),
    normalizedSubmission: {
      supplierConfirmation: {
        weightKg: 0.8,
        dimensionsCm: { length: 30, width: 20, height: 10 }
      }
    },
    createdAt
  });
  assert.deepEqual(firstBundle.sourcePackIds, secondBundle.sourcePackIds);
  assert.notEqual(firstBundle.logisticsEvidence.chargeableWeightKg, secondBundle.logisticsEvidence.chargeableWeightKg);
  assert.notEqual(firstBundle.logisticsEvidence.amountRmb, secondBundle.logisticsEvidence.amountRmb);
  assert.equal(firstBundle.sourceCandidateId, "TEST-A-ONE-CARD");
  assert.equal(secondBundle.sourceCandidateId, "TEST-A-SECOND-SKU");
});

test("运费规则缺公式或证据包与主人确认包装不一致时明确拒绝", () => {
  const invalid = validateLifecycleEvidenceData("logistics_tariff", {
    chargeableWeightRule: "max_actual_volume",
    perKgRmb: 20,
    perParcelRmb: 10,
    minimumChargeableWeightKg: 0,
    weightRoundingKg: 0.1
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.map((item) => item.path).join(","), /volumeDivisorCm3PerKg/);

  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(),
    candidate: candidate(),
    evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(),
    createdAt
  });
  const validation = validateLifecycleBInputBundle(structuredClone(bundle), {
    candidate: candidate(),
    normalizedSubmission: { supplierConfirmation: { weightKg: 0.5, dimensionsCm: { length: 12, width: 12, height: 7 } } }
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.map((item) => item.path).join(","), /packagingSnapshot/);
});

test("冻结投影不冻结输入；无外部上下文仍拒绝旧绑定和空证据", () => {
  const source = candidate();
  resolveLifecycleEvidenceContext(source);
  assert.equal(Object.isFrozen(source.storeRef), false);
  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: source, evidencePacks: packs(), normalizedSubmission: normalizedSubmission(), createdAt });
  assert.equal(validateLifecycleBInputBundle(bundle).valid, true);
  for (const mutate of [
    value => { delete value.context.storeRef; delete value.platformSchemaEvidence.storeRef; },
    value => { value.platformSchemaEvidence.storeRef.mappingVersion = "another"; },
    value => { value.platformFeeEvidence = {}; }, value => { value.logisticsEvidence = {}; },
    value => { value.sourcePackIds[0] = "another"; }, value => { value.sourceCandidateRevision = null; }
  ]) {
    const old = structuredClone(bundle); mutate(old);
    assert.equal(validateLifecycleBInputBundle(old).valid, false);
  }
  assert.equal(Object.isFrozen(source.storeRef), false);
});

test("估算佣金仅匹配当前候选修订，旧包历史可读且精确证据优先复用", () => {
  const current = candidate();
  const evidence = packs();
  const estimate = evidence[0];
  estimate.evidenceData.commissionEvidenceMode = "estimated";
  estimate.evidenceData.estimateAuthorized = true;
  estimate.evidenceData.exactCommissionRequiredAtC = true;
  const binding = { schemaVersion: "commission-estimate-authorization-v1", candidateId: current.id,
    candidateRevision: current.dataRevision, authorizationRef: "owner-estimate:synthetic:7", commissionRate: estimate.evidenceData.commissionRate };
  assert.equal(validateLifecycleEvidenceData("commission", estimate.evidenceData).valid, true);
  assert.equal(inspectLifecycleBInputReadiness({ candidate: current, evidencePacks: evidence, asOf: createdAt }).ready, false);
  for (const invalid of [undefined, { ...binding, candidateId: "another-sku" }, { ...binding, candidateRevision: 6 },
    { ...binding, commissionRate: 0.3 }, { ...binding, extra: true }, { ...binding, candidateRevision: "7" }]) {
    const scoped = structuredClone(evidence);
    if (invalid !== undefined) scoped[0].evidenceData.commissionEstimateAuthorization = invalid;
    assert.equal(inspectLifecycleBInputReadiness({ candidate: current, evidencePacks: scoped, asOf: createdAt }).ready, false);
    assert.throws(() => createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: current, evidencePacks: scoped, normalizedSubmission: normalizedSubmission(), createdAt }), /REAL_A_SYSTEM_EVIDENCE_GAP/);
  }
  estimate.evidenceData.commissionEstimateAuthorization = binding;
  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: current, evidencePacks: evidence, normalizedSubmission: normalizedSubmission(), createdAt });
  assert.deepEqual(bundle.platformFeeEvidence.commissionEstimateAuthorization, binding);
  assert.equal(validateLifecycleBInputBundle(bundle).valid, true);
  const changed = structuredClone(bundle); changed.platformFeeEvidence.commissionEstimateAuthorization.candidateId = "another-sku";
  assert.equal(validateLifecycleBInputBundle(changed).valid, false);
  const exact = packs()[0]; exact.id = "EP-EXACT-OLDER"; exact.checkedAt = "2026-08-17T02:00:00.000Z";
  for (const target of [current, { ...current, id: "another-sku", dataRevision: 12 }]) {
    const selected = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: target, evidencePacks: [...evidence, exact], normalizedSubmission: normalizedSubmission(), createdAt });
    assert.equal(selected.platformFeeEvidence.evidenceId, exact.id);
    assert.equal(selected.platformFeeEvidence.commissionEvidenceMode, "exact");
    assert.equal(Object.hasOwn(selected.platformFeeEvidence, "commissionEstimateAuthorization"), false);
  }
});


function wbCatalogFixture() {
  const value = candidate();
  value.targetStore = "wb";
  value.storeRef.stableStoreId = "wb";
  Object.assign(value.lifecycleEvidenceContextV11, { platform: "wb", store: "wb", storeRef: structuredClone(value.storeRef),
    category: "wb:subject:5267", salesScheme: "fbs" });
  const evidence = packs();
  for (const pack of evidence.filter(pack => ["commission", "schema"].includes(pack.kind))) {
    Object.assign(pack.scope, { platform: "wb", store: "wb", storeRef: structuredClone(value.storeRef), category: "wb:subject:5267" });
    if (pack.kind === "commission") pack.scope.salesScheme = "fbs";
  }
  const commission = evidence[0];
  commission.sourceType = "wb_official_commission_reference";
  commission.expiresAt = null;
  commission.commissionCatalogRef = { catalogId: "synthetic-wb-catalog", catalogVersion: "synthetic-version-1", sellerRegion: "CN",
    subjectId: 5267, sourceField: "kgvpChina", sourceReceiptRef: "synthetic-official-receipt", effectiveFrom: null };
  const catalogs = [{ platform: "wb", sellerRegion: "CN", catalogId: "synthetic-wb-catalog", catalogVersion: "synthetic-version-1", status: "active" }];
  return { value, evidence, commission, catalogs };
}

test("WB目录声明闭字段有界唯一，缺声明不自动启用", () => {
  const f = wbCatalogFixture();
  assert.deepEqual(normalizeCurrentCommissionCatalogs(f.catalogs), f.catalogs);
  for (const records of [null, Array(101).fill(f.catalogs[0]), [{ ...f.catalogs[0], extra: true }],
    [{ ...f.catalogs[0], platform: "ozon" }], [{ ...f.catalogs[0], catalogId: " padded " }], [{ ...f.catalogs[0], sellerRegion: "RU" }], [{ ...f.catalogs[0], status: "unknown" }]]) {
    assert.throws(() => normalizeCurrentCommissionCatalogs(records), /CURRENT_COMMISSION_CATALOGS_INVALID/);
  }
  assert.throws(() => normalizeCurrentCommissionCatalogs([...f.catalogs, { ...f.catalogs[0], catalogVersion: "another" }]), /AMBIGUOUS/);
  const result = inspectLifecycleBInputReadiness({ candidate: f.value, evidencePacks: f.evidence, asOf: createdAt });
  assert.equal(result.ready, false); assert.equal(result.fields.find(value => value.key === "commission").status, "missing");
});

test("仅完整正式WB目录证据允许未知期限，bundle冻结引用但历史读取不依赖当前声明", () => {
  const f = wbCatalogFixture(), original = structuredClone(f.evidence);
  assert.equal(isLifecycleEvidenceTraceValid(f.commission), true);
  assert.equal(inspectLifecycleBInputReadiness({ candidate: f.value, evidencePacks: f.evidence, asOf: createdAt, currentCommissionCatalogs: f.catalogs }).ready, true);
  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(f.value), candidate: f.value, evidencePacks: f.evidence, normalizedSubmission: normalizedSubmission(), createdAt, currentCommissionCatalogs: f.catalogs });
  assert.deepEqual(bundle.platformFeeEvidence.commissionCatalogRef, f.commission.commissionCatalogRef);
  assert.equal(validateLifecycleBInputBundle(bundle).valid, true);
  const changed = [{ ...f.catalogs[0], status: "invalidated" }];
  assert.throws(() => createLifecycleBInputBundle({ otherCosts: currentCosts(f.value), candidate: f.value, evidencePacks: f.evidence, normalizedSubmission: normalizedSubmission(), createdAt, currentCommissionCatalogs: changed }), /SYSTEM_EVIDENCE_GAP/);
  assert.equal(validateLifecycleBInputBundle(bundle).valid, true); assert.deepEqual(f.evidence, original);
  const legacy = structuredClone(bundle); delete legacy.platformFeeEvidence.commissionCatalogRef;
  assert.equal(validateLifecycleBInputBundle(legacy).valid, true);
  const corrupt = structuredClone(bundle); corrupt.platformFeeEvidence.commissionCatalogRef.subjectId++;
  assert.equal(validateLifecycleBInputBundle(corrupt).valid, false);
});

test("WB统一目录检查区分缺引用、失效、版本变化、结构错误和生效边界", () => {
  const f = wbCatalogFixture();
  const inspect = (pack, records = f.catalogs) => inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs: records, asOf: createdAt });
  const missingRef = structuredClone(f.commission); delete missingRef.commissionCatalogRef;
  assert.equal(inspect(missingRef).status, "missing_ref");
  assert.equal(inspect(f.commission, []).status, "missing");
  assert.equal(inspect(f.commission, [{ ...f.catalogs[0], status: "invalidated" }]).status, "invalidated");
  assert.equal(inspect(f.commission, [{ ...f.catalogs[0], catalogVersion: "new" }]).status, "version_mismatch");
  assert.equal(inspect({ ...f.commission, commissionCatalogRef: { ...f.commission.commissionCatalogRef, extra: true } }).status, "invalid");
  assert.equal(inspect({ ...f.commission, commissionCatalogRef: { ...f.commission.commissionCatalogRef, effectiveFrom: "2026-08-19T02:00:00.000Z" } }).status, "not_effective");
  assert.equal(inspect({ ...f.commission, checkedAt: "2026-08-17T02:00:00.000Z", expiresAt: createdAt }).status, "expired");
  assert.equal(inspect(packs()[0]).status, "not_applicable");
  for (const records of [[], [{ ...f.catalogs[0], status: "invalidated" }], [{ ...f.catalogs[0], catalogVersion: "new" }]]) {
    assert.equal(inspectLifecycleBInputReadiness({ candidate: f.value, evidencePacks: f.evidence, asOf: createdAt, currentCommissionCatalogs: records }).ready, false);
    assert.throws(() => createLifecycleBInputBundle({ otherCosts: currentCosts(f.value), candidate: f.value, evidencePacks: f.evidence, normalizedSubmission: normalizedSubmission(), createdAt, currentCommissionCatalogs: records }), /SYSTEM_EVIDENCE_GAP/);
  }
});

test("WB旧包、估算、错类目及非WB null期限均不能借目录声明放行", () => {
  const f = wbCatalogFixture();
  for (const mutate of [pack => { pack.sourceType = "legacy-wb"; }, pack => { pack.evidenceData.commissionEvidenceMode = "estimated"; },
    pack => { pack.scope.category = "wb:subject:5268"; }, pack => { pack.evidenceData.otherCosts = {}; },
    pack => { pack.commissionCatalogRef.sellerRegion = "RU"; }]) {
    const pack = structuredClone(f.commission); mutate(pack);
    assert.equal(isLifecycleEvidenceTraceValid(pack), false);
    assert.equal(inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs: f.catalogs, asOf: createdAt }).available, false);
  }
  for (const pack of packs()) assert.equal(isLifecycleEvidenceTraceValid({ ...pack, expiresAt: null }), false);
});


test("目录元数据不能附着在其他来源或非WB证据上借旧TTL通过", () => {
  const f = wbCatalogFixture();
  for (const pack of packs()) {
    const attached = { ...pack, commissionCatalogRef: structuredClone(f.commission.commissionCatalogRef) };
    assert.equal(isLifecycleEvidenceTraceValid(attached), false);
  }
  const wrongPlatform = { ...f.commission, scope: { ...f.commission.scope, platform: "ozon" }, expiresAt: "2026-08-19T02:00:00.000Z" };
  assert.equal(isLifecycleEvidenceTraceValid(wrongPlatform), false);
});

test("复用佣金时逐SKU冻结当前成本，旧包夹带成本不污染且不改历史", () => {
  const evidencePacks = packs();
  evidencePacks[0].evidenceData.otherCosts.packagingRmb = 999;
  const original = JSON.stringify(evidencePacks);
  const first = candidate(), second = { ...candidate(), id: "SECOND-SKU", packagingCostRmb: 7 };
  const freeze = (source, otherCosts) => createLifecycleBInputBundle({ candidate: source, evidencePacks,
    normalizedSubmission: normalizedSubmission(), otherCosts, createdAt });
  const firstBundle = freeze(first, currentCosts());
  const secondBundle = freeze(second, { ...currentCosts(), packagingRmb: 7 });
  assert.equal(firstBundle.platformFeeEvidence.otherCosts.packagingRmb, 1.5);
  assert.equal(secondBundle.platformFeeEvidence.otherCosts.packagingRmb, 7);
  assert.equal(firstBundle.platformFeeEvidence.evidenceId, secondBundle.platformFeeEvidence.evidenceId);
  const history = JSON.stringify(firstBundle);
  first.packagingCostRmb = 80;
  assert.equal(validateLifecycleBInputBundle(firstBundle, { candidate: first }).valid, true);
  assert.equal(JSON.stringify(firstBundle), history);
  assert.equal(JSON.stringify(evidencePacks), original);
  const missingFrozenCosts = structuredClone(firstBundle);
  delete missingFrozenCosts.platformFeeEvidence.otherCosts;
  assert.equal(validateLifecycleBInputBundle(missingFrozenCosts).valid, false);
  missingFrozenCosts.platformFeeEvidence.otherCosts = { ...currentCosts(), packagingRmb: null };
  assert.equal(validateLifecycleBInputBundle(missingFrozenCosts).valid, false);
});

test("当前成本缺失、无效或错SKU明确拒绝，显式零成本合法", () => {
  const source = candidate();
  const input = { candidate: source, evidencePacks: packs(), normalizedSubmission: normalizedSubmission(), createdAt };
  for (const costs of [undefined, null, {}, { ...currentCosts(), packagingRmb: null },
    { ...currentCosts(), packagingRmb: 7 }, { ...currentCosts(), labelRmb: NaN },
    { ...currentCosts(), withdrawalFeeRate: 1 }]) {
    assert.throws(() => createLifecycleBInputBundle({ ...input, otherCosts: costs }), /REAL_A_SYSTEM_EVIDENCE_GAP/);
  }
  const zero = { ...currentCosts(), packagingRmb: 0, labelRmb: 0, fixedOtherRmb: 0,
    advertisingRate: 0, returnReserveRate: 0, damageReserveRate: 0, withdrawalFeeRate: 0,
    minimumUnitProfitRmb: 0, targetMarginRate: 0 };
  for (const item of Object.values(zero.costPolicySnapshot.items)) { item.status = "not_applicable"; item.value = null; }
  assert.equal(validateLifecycleBOtherCosts(zero).valid, true);
  const result = createLifecycleBInputBundle({ ...input, candidate: { ...source, packagingCostRmb: 0 }, otherCosts: zero });
  const { costPolicySnapshot, ...numericZero } = zero;
  assert.deepEqual(result.platformFeeEvidence.otherCosts, numericZero);
  assert.deepEqual(result.platformFeeEvidence.costPolicySnapshot, costPolicySnapshot);
  assert.equal(Object.isFrozen(zero), false);
  assert.equal(Object.isFrozen(result.platformFeeEvidence.otherCosts), true);
});

test("新佣金证据完整性只取佣金自身，WB无商品成本仍可追溯", () => {
  const f = wbCatalogFixture();
  const commission = f.evidence.find(pack => pack.kind === "commission");
  delete commission.evidenceData.otherCosts;
  assert.equal(validateLifecycleEvidenceData("commission", commission.evidenceData).valid, true);
  assert.equal(isLifecycleEvidenceTraceValid(commission), true);
  assert.equal(inspectCommissionCatalogValidity({ pack: commission, currentCommissionCatalogs: f.catalogs, asOf: createdAt }).status, "current");
  const bundle = createLifecycleBInputBundle({ candidate: f.value, evidencePacks: f.evidence,
    currentCommissionCatalogs: f.catalogs, otherCosts: currentCosts(f.value), normalizedSubmission: normalizedSubmission(), createdAt });
  const { costPolicySnapshot, ...expectedCosts } = currentCosts(f.value);
  assert.deepEqual(bundle.platformFeeEvidence.otherCosts, expectedCosts);
  assert.deepEqual(bundle.platformFeeEvidence.costPolicySnapshot, costPolicySnapshot);
});

test("新冻结拒绝缺政策、未知与跨范围政策，政策和数值不可各自篡改", () => {
  const freeze = otherCosts => createLifecycleBInputBundle({ candidate: candidate(), evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(), otherCosts, createdAt });
  const missing = currentCosts(); delete missing.costPolicySnapshot;
  assert.throws(() => freeze(missing), error => error.code === 'B_COST_POLICY_INVALID');
  const unknown = currentCosts(); Object.assign(unknown.costPolicySnapshot.items.taxRate, { status: 'unknown', value: null });
  assert.throws(() => freeze(unknown), error => error.code === 'B_COST_POLICY_UNKNOWN');
  const wrong = currentCosts(); wrong.costPolicySnapshot.scope.salesScheme = 'fbs';
  assert.throws(() => freeze(wrong), error => error.code === 'B_COST_POLICY_SCOPE_MISMATCH');
  const bundle = freeze(currentCosts());
  for (const mutate of [value => { delete value.platformFeeEvidence.costPolicySnapshot; },
    value => { value.platformFeeEvidence.costPolicySnapshot.items.labelRmb.value = 5; },
    value => { value.platformFeeEvidence.costPolicyContext.salesScheme = 'fbs'; },
    value => { value.platformFeeEvidence.otherCosts.taxRate = 0.1; }]) {
    const changed = structuredClone(bundle); mutate(changed);
    assert.equal(validateLifecycleBInputBundle(changed).valid, false);
  }
});

test("旧v1.1无政策冻结包仍按历史数字严格只读验证", () => {
  const legacy = structuredClone(createLifecycleBInputBundle({ candidate: candidate(), evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(), otherCosts: currentCosts(), createdAt }));
  legacy.bundleVersion = 'lifecycle-b-input-bundle-v1.1';
  delete legacy.platformFeeEvidence.costPolicySnapshot;
  delete legacy.platformFeeEvidence.costPolicyContext;
  legacy.platformFeeEvidence.otherCosts = structuredClone(packs()[0].evidenceData.otherCosts);
  const bytes = JSON.stringify(legacy);
  assert.equal(validateLifecycleBInputBundle(legacy).valid, true);
  assert.equal(JSON.stringify(legacy), bytes);
  const broken = structuredClone(legacy); delete broken.platformFeeEvidence.otherCosts;
  assert.equal(validateLifecycleBInputBundle(broken).valid, false);
});

const OZON_OFFICIAL_SHA = "b".repeat(64);

function ozonOfficialCommissionPack() {
  const base = packs()[0];
  return {
    ...base,
    id: "EP-COMMISSION-OFFICIAL",
    sourceType: "ozon_official_commission_table",
    sourceRef: `ozon-official-commission:2026-08-01:sha256:${OZON_OFFICIAL_SHA}:1500_5000`,
    commissionCatalogRef: {
      effectiveFrom: "2026-08-01",
      fileSha256: OZON_OFFICIAL_SHA,
      sourceUrl: "https://docs.ozon.ru/common/pravila-raboty/komissii/",
      priceTier: "1500_5000",
      matchedRow: { typeRu: "Лежанки для животных", typeZh: "宠物躺床", mpCategoryZh: "宠物用品" }
    },
    evidenceData: {
      ...structuredClone(base.evidenceData),
      commissionRate: 0.155,
      commissionEvidenceMode: "official_reference",
      officialCommissionBinding: { schemaVersion: "ozon-official-commission-binding-v1", candidateId: "TEST-A-ONE-CARD", candidateRevision: 7, priceRub: 2490 },
      estimateAuthorized: false,
      exactCommissionRequiredAtC: true
    }
  };
}

test("官方费表佣金证据可以冻结进B输入包，并原样保留命中行的版本引用", () => {
  const official = ozonOfficialCommissionPack();
  const evidencePacks = [official, ...packs().slice(1)];
  assert.equal(isLifecycleEvidenceTraceValid(official), true);
  assert.equal(validateLifecycleEvidenceData("commission", official.evidenceData).valid, true);
  assert.equal(inspectCommissionCatalogValidity({ pack: official, currentCommissionCatalogs: [], asOf: createdAt }).status, "not_applicable");
  assert.equal(inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks, asOf: createdAt }).ready, true);
  const bundle = createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(), evidencePacks, normalizedSubmission: normalizedSubmission(), createdAt });
  assert.equal(bundle.platformFeeEvidence.evidenceId, "EP-COMMISSION-OFFICIAL");
  assert.equal(bundle.platformFeeEvidence.commissionEvidenceMode, "official_reference");
  assert.equal(bundle.platformFeeEvidence.commissionRate, 0.155);
  assert.equal(bundle.platformFeeEvidence.estimateAuthorized, false);
  assert.equal(Object.hasOwn(bundle.platformFeeEvidence, "commissionEstimateAuthorization"), false);
  assert.deepEqual(bundle.platformFeeEvidence.commissionCatalogRef, official.commissionCatalogRef);
  assert.deepEqual(bundle.platformFeeEvidence.officialCommissionBinding, official.evidenceData.officialCommissionBinding);
  assert.equal(validateLifecycleBInputBundle(bundle).valid, true);
  const rebound = structuredClone(bundle); rebound.platformFeeEvidence.officialCommissionBinding.candidateId = "another-sku";
  assert.equal(validateLifecycleBInputBundle(rebound).valid, false);
  const retiered = structuredClone(bundle); retiered.platformFeeEvidence.commissionCatalogRef.priceTier = "le2000";
  assert.equal(validateLifecycleBInputBundle(retiered).valid, false);
});

test("官方费表证据缺版本引用、价格档、命中行或绑定都不能进入正式计算", () => {
  const freeze = (pack) => createLifecycleBInputBundle({ otherCosts: currentCosts(), candidate: candidate(),
    evidencePacks: [pack, ...packs().slice(1)], normalizedSubmission: normalizedSubmission(), createdAt });
  for (const mutate of [
    pack => { delete pack.commissionCatalogRef; },
    pack => { pack.commissionCatalogRef.priceTier = "le2000"; },
    pack => { pack.commissionCatalogRef.fileSha256 = "b".repeat(63); },
    pack => { pack.commissionCatalogRef.effectiveFrom = "2026-08-01T00:00:00.000Z"; },
    pack => { pack.commissionCatalogRef.sourceUrl = " "; },
    pack => { pack.commissionCatalogRef.matchedRow = { typeRu: "Лежанки", typeZh: "宠物躺床" }; },
    pack => { pack.commissionCatalogRef.matchedRow.mpCategoryZh = ""; },
    pack => { pack.commissionCatalogRef.extra = true; },
    pack => { pack.scope.platform = "wb"; },
    pack => { pack.evidenceData.commissionEvidenceMode = "exact"; },
    pack => { pack.evidenceData.commissionRate = 0; },
    pack => { pack.evidenceData.commissionRate = 1; },
    pack => { pack.evidenceData.estimateAuthorized = true; },
    pack => { delete pack.evidenceData.officialCommissionBinding; },
    pack => { pack.evidenceData.officialCommissionBinding.priceRub = 0; },
    pack => { pack.expiresAt = null; }
  ]) {
    const pack = ozonOfficialCommissionPack(); mutate(pack);
    assert.equal(isLifecycleEvidenceTraceValid(pack), false);
    assert.throws(() => freeze(pack), /SYSTEM_EVIDENCE_GAP/);
  }
  // 绑定本身完好，但属于别的SKU或改价后的修订：证据保留，只是不能再复用。
  for (const mutate of [
    pack => { pack.evidenceData.officialCommissionBinding.candidateId = "another-sku"; },
    pack => { pack.evidenceData.officialCommissionBinding.candidateRevision = 6; }
  ]) {
    const pack = ozonOfficialCommissionPack(); mutate(pack);
    assert.equal(isLifecycleEvidenceTraceValid(pack), true);
    assert.equal(inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: [pack, ...packs().slice(1)], asOf: createdAt }).ready, false);
    assert.throws(() => freeze(pack), /SYSTEM_EVIDENCE_GAP/);
  }
  const strayBinding = packs()[0];
  strayBinding.evidenceData.officialCommissionBinding = ozonOfficialCommissionPack().evidenceData.officialCommissionBinding;
  assert.equal(validateLifecycleEvidenceData("commission", strayBinding.evidenceData).valid, false);
});
