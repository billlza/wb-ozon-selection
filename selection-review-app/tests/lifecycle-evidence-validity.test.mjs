import assert from "node:assert/strict";
import test from "node:test";
import { createInternalEvidenceValidity, createSourceDeclaredEvidenceValidity, inspectLifecycleEvidenceValidity,
  isLifecycleEvidenceValidityMetadataValid } from "../lib/lifecycle-evidence-validity.mjs";
import { isLifecycleEvidenceTraceValid } from "../lib/lifecycle-b-input-bundle.mjs";
import { commitLifecycleBEvidencePacks } from "../lib/lifecycle-b-evidence-runtime.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";

const checkedAt = "2026-08-18T08:00:00.000Z";
const expiresAt = "2026-08-19T08:00:00.000Z";
const asOf = "2026-09-21T08:00:00.000Z";
function legacy(kind) {
  const common = { id: `b-evidence:${kind}:${"a".repeat(20)}`, kind, status: "active", checkedAt, expiresAt,
    providerVersion: "lifecycle-b-evidence-provider-v1.1" };
  if (kind === "exchange_rate") return { ...common, scope: { pair: "rub/cny" },
    sourceType: "bank_of_russia_official_daily_xml", sourceRef: "cbr-xml-daily:R01375:2026-08-18",
    evidenceData: { rubPerCny: 12.3, rateDate: "2026-08-18", nominal: 1, officialValueRub: 12.3 } };
  const scope = { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon:17030000:90000" };
  if (kind === "schema") return { ...common, scope: { ...scope, ruleVersion: "ozon-current" },
    sourceType: "ozon_seller_api_current_schema", sourceRef: "ozon-seller-api:/v1/description-category/attribute:17030000:90000",
    evidenceData: { schemaRevision: `ozon-schema-${"b".repeat(20)}`, requiredFields: [], attributes: [], descriptionCategoryId: 17030000, typeId: 90000 } };
  return { ...common, scope: { ...scope, salesScheme: "rfbs" }, sourceType: "ozon_official_commission_table",
    sourceRef: `ozon-official-commission:2026-08-01:sha256:${"c".repeat(64)}:1500_5000`,
    commissionCatalogRef: { effectiveFrom: "2026-08-01", fileSha256: "c".repeat(64), sourceUrl: "https://docs.ozon.ru/common/pravila-raboty/komissii/",
      priceTier: "1500_5000", matchedRow: { typeRu: "Лежанки", typeZh: "宠物躺床", mpCategoryZh: "宠物用品" } },
    evidenceData: { commissionRate: 0.155, commissionEvidenceMode: "official_reference", estimateAuthorized: false,
      exactCommissionRequiredAtC: true, officialCommissionBinding: { schemaVersion: "ozon-official-commission-binding-v1",
        candidateId: "TEST-001", candidateRevision: 1, priceRub: 2490 }, descriptionCategoryId: 17030000, typeId: 90000 } };
}

function legacyGuoo() {
  return { id: `b-evidence:logistics_tariff:${"d".repeat(20)}`, kind: "logistics_tariff", status: "active",
    providerVersion: "lifecycle-b-evidence-provider-v1.1", checkedAt: "2026-09-14T09:47:11.227Z", expiresAt: "2026-09-21T09:47:11.227Z",
    scope: { route: "guoo economy extra small", ruleVersion: "guoo-2026-08-19" }, ruleVersion: "guoo-2026-08-19",
    sourceType: "guoo_current_tariff_xlsx",
    sourceRef: `guoo-xlsx:GUOO产品资费测算表【2026.8.19更新】.xlsx:sha256:${"e".repeat(64)}:row-12`,
    evidenceData: { calculationRuleStatus: "main_sheet_quote_verified", chargeableWeightRule: "actual_weight",
      perKgRmb: 10, perParcelRmb: 5, minimumChargeableWeightKg: 0, weightRoundingRule: "none", weightRoundingKg: null } };
}

test("已核对GUOO工作簿生成器的固定七天仅是复查提示，读取不改保存时间或来源", () => {
  const pack = legacyGuoo(), before = structuredClone(pack), later = "2026-09-21T13:00:00.000Z";
  assert.equal(isLifecycleEvidenceTraceValid(pack), true);
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: pack.checkedAt }).status, "current");
  const result = inspectLifecycleEvidenceValidity(pack, { asOf: later });
  assert.equal(result.status, "refresh_due"); assert.equal(result.usable, true);
  assert.equal(result.expiryBasis, "internal_refresh_hint");
  assert.equal(result.provenance, "recognized_legacy_generator");
  assert.deepEqual(inspectLifecycleEvidenceValidity(JSON.parse(JSON.stringify(pack)), { asOf: pack.expiresAt }), result);
  assert.deepEqual(pack, before);
});

test("其他物流、未知工作簿版本、未核对公式或不符七天形状不能借GUOO标签放行", () => {
  for (const mutate of [
    p => { p.sourceType = "other_tariff"; }, p => { p.sourceRef = p.sourceRef.replace("2026.8.19", "2026.9.19"); },
    p => { p.sourceRef = p.sourceRef.replace("GUOO产品资费测算表", "other-file"); },
    p => { p.sourceRef = p.sourceRef.replace(/sha256:[a-f0-9]+/, "sha256:missing"); },
    p => { p.sourceRef += "?query=1"; }, p => { p.sourceRef = p.sourceRef.replace("row-12", "row-0"); },
    p => { p.scope.ruleVersion = "guoo-2026-09-19"; }, p => { p.ruleVersion = "unknown"; },
    p => { p.scope.route = "other carrier"; }, p => { p.providerVersion = "unknown"; },
    p => { p.id = "arbitrary"; }, p => { p.expiresAt = "2026-09-20T09:47:11.227Z"; },
    p => { p.evidenceData.calculationRuleStatus = "legacy_unverified"; },
    p => { delete p.evidenceData.calculationRuleStatus; }, p => { p.evidenceData.perKgRmb = -1; },
    p => { p.evidenceData.minimumChargeableWeightKg = 1; }, p => { p.evidenceData.weightRoundingKg = 1; }
  ]) {
    const pack = legacyGuoo(); mutate(pack);
    const result = inspectLifecycleEvidenceValidity(pack, { asOf: "2026-09-22T00:00:00.000Z" });
    assert.equal(result.status, "expired", String(mutate)); assert.equal(result.usable, false);
  }
});

test("GUOO真实来源期限与明确变化仍优先阻断，不因命中旧生成器而延期", () => {
  const pack = legacyGuoo(), later = "2026-09-22T00:00:00.000Z";
  pack.validity = createSourceDeclaredEvidenceValidity("logistics_tariff", pack.expiresAt);
  assert.equal(isLifecycleEvidenceValidityMetadataValid(pack), true);
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: later }).status, "expired");
  pack.expiresAt = "2026-09-15T09:47:11.227Z";
  pack.validity = createSourceDeclaredEvidenceValidity("logistics_tariff", pack.expiresAt);
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: later }).status, "expired");
  for (const mutate of [p => { p.current = false; }, p => { p.status = "superseded"; },
    p => { p.changedAt = p.checkedAt; }, p => { p.invalidatedAt = p.checkedAt; }]) {
    const changed = legacyGuoo(); mutate(changed);
    assert.equal(inspectLifecycleEvidenceValidity(changed, { asOf: later }).usable, false);
  }
});

test("仅三种已核实旧生产器的24小时期限降为复查提示，重复检查不改历史", () => {
  for (const kind of ["exchange_rate", "commission", "schema"]) {
    const pack = legacy(kind), before = structuredClone(pack);
    assert.equal(isLifecycleEvidenceTraceValid(pack), true);
    const result = inspectLifecycleEvidenceValidity(pack, { asOf });
    assert.equal(result.usable, true, kind);
    assert.equal(result.status, "refresh_due");
    assert.equal(result.provenance, "recognized_legacy_generator");
    assert.deepEqual(inspectLifecycleEvidenceValidity(pack, { asOf }), result);
    assert.deepEqual(pack, before);
    assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: checkedAt }).status, "current");
  }
});

test("旧来源身份、内容或原期限形状无法验证时仍按原期限停止", () => {
  for (const kind of ["exchange_rate", "commission", "schema"]) for (const mutate of [
    pack => { delete pack.providerVersion; }, pack => { pack.providerVersion = "unknown"; },
    pack => { pack.id = "arbitrary"; }, pack => { pack.sourceRef += ":changed"; },
    pack => { pack.sourceType = "unknown"; }, pack => { pack.expiresAt = "2026-08-19T07:59:59.000Z"; },
    pack => { pack.evidenceData = {}; }
  ]) {
    const pack = legacy(kind); mutate(pack);
    const result = inspectLifecycleEvidenceValidity(pack, { asOf });
    assert.equal(result.usable, false, `${kind}:${mutate}`);
    assert.equal(result.status, "expired");
  }
  const pack = legacy("schema"); pack.scope.category = "ozon:other";
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).usable, false);
});

test("新来源声明优先于旧24小时识别，并使用真正平台期限而非缓存提示", () => {
  const pack = legacy("commission");
  pack.validity = createSourceDeclaredEvidenceValidity("commission", expiresAt);
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).status, "expired");
  pack.validity = createSourceDeclaredEvidenceValidity("commission", "2026-10-01T08:00:00.000Z");
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).usable, true);
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: "2026-10-01T08:00:00.000Z" }).status, "expired");
  pack.expiresAt = "2026-08-18T12:00:00.000Z";
  pack.validity = createSourceDeclaredEvidenceValidity("commission", pack.expiresAt);
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).status, "expired");
});

test("明确失效、被替代、变化、未来时间与无效元数据优先于任何复查提示", () => {
  for (const mutate of [
    pack => { pack.status = "invalidated"; }, pack => { pack.status = "superseded"; },
    pack => { pack.current = false; }, pack => { pack.invalidatedAt = checkedAt; }, pack => { pack.changedAt = checkedAt; },
    pack => { pack.validity.generator = "unknown"; }, pack => { pack.validity.extra = true; },
    pack => { pack.validity.expiryBasis = "forever"; }, pack => { pack.validity = null; },
    pack => { pack.expiresAt = null; }
  ]) {
    const pack = legacy("exchange_rate"); pack.validity = createInternalEvidenceValidity("exchange_rate"); mutate(pack);
    assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).usable, false, String(mutate));
  }
  assert.equal(inspectLifecycleEvidenceValidity(legacy("exchange_rate"), { asOf: "2026-08-17T00:00:00Z" }).usable, false);
  assert.equal(inspectLifecycleEvidenceValidity(legacy("exchange_rate"), { asOf: "invalid" }).usable, false);
  const pack = legacy("exchange_rate"); pack.validity = { ...createInternalEvidenceValidity("exchange_rate"), extra: true };
  assert.equal(isLifecycleEvidenceValidityMetadataValid(pack), false);
  assert.equal(isLifecycleEvidenceTraceValid(pack), false);
});

test("期限解释变更不能覆盖同ID旧记录，提交冲突保持原集合完整", () => {
  const pack = legacy("exchange_rate"), data = { evidencePacks: [] };
  commitLifecycleBEvidencePacks(data, [pack], { createdAt: checkedAt });
  const before = structuredClone(data);
  const declared = { ...pack, validity: createInternalEvidenceValidity("exchange_rate") };
  assert.throws(() => commitLifecycleBEvidencePacks(data, [declared], { createdAt: checkedAt }), /B_EVIDENCE_COMMIT_ID_CONFLICT/);
  assert.deepEqual(data, before);
});


test("官方CDN费表附件按生产器来源识别，其他主机与路径不得借相同24小时绕过", () => {
  const pack = legacy("commission");
  pack.commissionCatalogRef.sourceUrl = "https://cdn.ozone.ru/s3/ozon-disk-api/global-education/ru/commissions/ozon-fees/comissions/Tarifs_CN_01_12_2025_1761720496.xlsx";
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).status, "refresh_due");
  for (const sourceUrl of ["https://cdn.ozone.ru.attacker.invalid/table.xlsx", "https://cdn.ozone.ru/other/table.xlsx", "https://docs.ozon.ru/fees?token=secret"]) {
    pack.commissionCatalogRef.sourceUrl = sourceUrl;
    assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).status, "expired");
  }
});


test("不存在的日历日期不能被Date.parse归一化为有效证据时间", () => {
  for (const field of ["checkedAt", "expiresAt"]) {
    const pack = legacy("exchange_rate"); pack[field] = "2026-02-30T00:00:00.000Z";
    assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf }).usable, false);
  }
  assert.equal(inspectLifecycleEvidenceValidity(legacy("exchange_rate"), { asOf: "2026-02-30T00:00:00.000Z" }).usable, false);
  assert.throws(() => createSourceDeclaredEvidenceValidity("commission", "2026-02-30T00:00:00.000Z"), /EVIDENCE_SOURCE_EXPIRY_INVALID/);
});
