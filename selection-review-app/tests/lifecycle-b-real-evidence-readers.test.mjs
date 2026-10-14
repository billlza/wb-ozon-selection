import { inspectLifecycleEvidenceValidity } from "../lib/lifecycle-evidence-validity.mjs";
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { exactCommissionUnavailable, officialCommissionTableGaps } from "../lib/commission-estimate-authorization.mjs";
import { readCurrentGuooTariff, selectGuooTariffRow } from "../lib/guoo-tariff-reader.mjs";
import { validateLifecycleEvidenceData } from "../lib/lifecycle-b-input-bundle.mjs";
import { createLifecycleBRealEvidenceProviderRegistry, createLifecycleBRealEvidenceReaders } from "../lib/lifecycle-b-real-evidence-readers.mjs";
import { readCurrentCbrExchangeRate } from "../lib/official-fx-reader.mjs";

const fixedNow = () => new Date("2026-08-18T08:00:00.000Z");

test("上游未证明完整店铺身份时拒绝；Schema缓存隔离映射和规则版本", async () => {
  const originalScope = { platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF, category: "shelf", ruleVersion: "v1" };
  for (const mutate of [
    value => { delete value.storeRef; },
    value => { value.storeRef.platformStoreId = "another"; },
    value => { value.storeRef.mappingVersion = "another"; }
  ]) {
    let calls = 0;
    const observed = structuredClone(originalScope); mutate(observed);
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173",
      fetchImpl: async () => { calls += 1; return httpJson({ ok: true, evidence: { current: true, scope: observed } }); } });
    await assert.rejects(() => registry.schema(request("schema", originalScope)), /STORE_SCOPE_UNPROVEN/);
    assert.equal(calls, 1);
  }
  const requests = [];
  const expected = [originalScope, { ...originalScope, storeRef: { ...SYNTHETIC_STORE_REF, mappingVersion: "v2" } }, { ...originalScope, ruleVersion: "v2" }];
  const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async (_url, options) => {
      const scope = expected[requests.length]; requests.push(JSON.parse(options.body));
      return httpJson({ ok: true, evidence: { current: true, scope, sourceType: "synthetic", sourceRef: `schema:synthetic:${requests.length}`,
        checkedAt: fixedNow().toISOString(), expiresAt: "2026-08-19T08:00:00.000Z", evidenceData: { schemaRevision: scope.ruleVersion, requiredFields: [] } } });
    } });
  for (const scope of expected) await registry.schema(request("schema", scope));
  await registry.schema(request("schema", originalScope));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(value => value.storeRef), expected.map(value => value.storeRef));
  assert.deepEqual(requests.map(value => value.ruleVersion), ["v1", "v1", "v2"]);
});

function request(kind, scope) {
  return {
    requestVersion: "lifecycle-b-evidence-preparation-v1.1",
    candidateId: "TEST-001",
    candidateRevision: 1,
    kind,
    scope,
    relatedSchemaScope: kind === "commission" ? { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: scope.category, ruleVersion: "ozon-current" } : null,
    maximumAttempts: 1,
    readOnly: true,
    platformWritesAllowed: false,
    requestedAt: "2026-08-18T08:00:00.000Z",
  };
}

function httpJson(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(String(body)),
  };
}

test("GUOO row selection matches one exact route and keeps the tariff cells", () => {
  const rows = [];
  rows[15] = { 2: "Small\n(小件)", 3: "GUOO Express Small PUDO\nGUOO Express Small Courier", 4: "空运", 6: "50.5元/千克+17.97元/票", 7: "0.001-2KG", 8: "1501-7000₽", 9: "三边之和不超150CM，单边不超60CM", 11: 50.5, 12: 17.97 };
  rows[17] = { 2: "Small\n(小件)", 7: "0.001-2KG", 8: "1501-7000₽", 9: "三边之和不超150CM，单边不超60CM", 3: "GUOO Economy Small PUDO\nGUOO Economy Small Courier", 4: "陆运", 6: "28.1元/千克+17.97元/票", 11: 28.1, 12: 17.97 };
  const selected = selectGuooTariffRow(rows, "GUOO Economy Small");
  assert.equal(selected.rowNumber, 17);
  assert.equal(selected.productType, "Small\n(小件)");
  assert.equal(selected.weightLimit, "0.001-2KG");
  assert.equal(selected.declaredValueLimit, "1501-7000₽");
  assert.equal(selected.sizeLimit, "三边之和不超150CM，单边不超60CM");
  assert.equal(selected.row[11], 28.1);
});

const formulaXml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const WEIGHT_FORMULA = "IF(OR(AND(D5>=2.001,D5<=30,D7>1501,D7<7000,SUM(H5:H7)<=310,H5<=150,H6<=80,H7<=80),AND(D5>=5.001,D5<=30,D7>7001,D7<250000,SUM(H5:H7)<=310,H5<=150,H6<=80,H7<=80)),MAX(H5*H6*H7/12000,D5),D5)";
const QUOTE_FORMULA_17 = 'IF(OR(D5>2,D7<1501,D7>7000,AND(SUM(H5:H7)>150),H5>60,H6>60,H7>60),"",IF(OR($D$5=0,$D$7=0,$H$5=0,$H$6=0,$H$7=0),"",F5*K17+L17))';

/** One synthetic GUOO workbook; `mutate` rewrites the sheet so a changed quote rule can be tried. */
function guooReadOptions(mutate = value => value) {
  const workbook = `<workbook xmlns:r="x"><sheets><sheet name="GUOO realFBS资费试算表" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relations = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const strings = `<sst><si><t>Small&#10;(小件)</t></si><si><t>GUOO Express Small PUDO&#10;(特快轻小件到点)&#10;GUOO Express Small Courier&#10;(特快轻小件到门)</t></si><si><t>空运</t></si><si><t>0.001-2KG</t></si><si><t>GUOO Standard Small PUDO&#10;(标准轻小件到点)&#10;GUOO Standard Small Courier&#10;(标准轻小件到门)</t></si><si><t>GUOO Economy Small PUDO&#10;(经济轻小件到点)&#10;GUOO Economy Small Courier&#10;(经济轻小件到门)</t></si><si><t>陆运</t></si><si><t>可以运输内部装有电池的物品</t></si></sst>`;
  const sheet = mutate(`<worksheet><sheetData>
    <row r="5"><c r="F5"><f>${formulaXml(WEIGHT_FORMULA)}</f></c></row>
    <row r="15"><c r="A15"/><c r="B15" t="s"><v>0</v></c><c r="C15" t="s"><v>1</v></c><c r="D15" t="s"><v>2</v></c><c r="G15" t="s"><v>3</v></c></row>
    <row r="16"><c r="A16"/><c r="B16"/><c r="C16" t="s"><v>4</v></c><c r="G16"/></row>
    <row r="17"><c r="A17"/><c r="B17"/><c r="C17" t="s"><v>5</v></c><c r="D17" t="s"><v>6</v></c><c r="G17"/><c r="J17" t="s"><v>7</v></c><c r="K17"><v>28.1</v></c><c r="L17"><v>17.97</v></c><c r="E17"><f>${formulaXml(QUOTE_FORMULA_17)}</f><v>0</v></c></row>
  </sheetData><mergeCells><mergeCell ref="B15:B17"/><mergeCell ref="G15:G17"/></mergeCells></worksheet>`);
  const execFileImpl = async (_command, args) => {
    if (args[0] === "-Z1") return { stdout: "xl/workbook.xml\nxl/_rels/workbook.xml.rels\nxl/sharedStrings.xml\nxl/worksheets/sheet1.xml\n" };
    const entry = args.at(-1);
    if (entry === "xl/workbook.xml") return { stdout: workbook };
    if (entry === "xl/_rels/workbook.xml.rels") return { stdout: relations };
    if (entry === "xl/sharedStrings.xml") return { stdout: strings };
    if (entry === "xl/worksheets/sheet1.xml") return { stdout: sheet };
    throw new Error(`unexpected ${entry}`);
  };
  return {
    scope: { route: "GUOO Economy Small", ruleVersion: "guoo-2026-07-20" },
    filePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx",
    execFileImpl,
    readFileImpl: async () => Buffer.from("fixture-xlsx"),
    now: fixedNow,
  };
}

test("GUOO reader parses the exact current xlsx row without inventing a rounding step", async () => {
  const result = await readCurrentGuooTariff(guooReadOptions());
  assert.equal(result.evidenceData.perKgRmb, 28.1);
  assert.equal(result.current, true);
  assert.equal(Object.hasOwn(result, "reasonCode"), false);
  assert.equal(result.evidenceData.calculationRuleStatus, "main_sheet_quote_verified");
  // 主表报价里没有最低计费重量，也不取整：这两项只能是 0 和 none，不是从重量档文字推出来的。
  assert.equal(result.evidenceData.minimumChargeableWeightKg, 0);
  assert.equal(result.evidenceData.perParcelRmb, 17.97);
  assert.equal(result.evidenceData.weightRoundingRule, "none");
  assert.equal(result.evidenceData.weightRoundingKg, null);
  assert.equal(result.evidenceData.batteryTransportRule, "可以运输内部装有电池的物品");
  assert.equal(validateLifecycleEvidenceData("logistics_tariff", result.evidenceData).valid, true);
});

test("一份报价公式对不上的资费表仍然读不出可用证据，没有核对过的旧证据包也仍然进不了正式计算", async () => {
  // 「已核验」必须名副其实：换掉重量表达式、换掉本行报价表达式、或者整格缺失，三种都要停下。
  for (const mutate of [
    sheet => sheet.replace("/12000", "/6000"),
    sheet => sheet.replace("F5*K17+L17", "ROUND(F5*K17+L17,0)"),
    sheet => sheet.replace(/<c r="E17">[\s\S]*?<\/c>/u, ""),
    sheet => sheet.replace(/<row r="5">[\s\S]*?<\/row>/u, ""),
  ]) {
    await assert.rejects(readCurrentGuooTariff(guooReadOptions(mutate)), /GUOO_TARIFF_MAIN_QUOTE_FORMULA_UNSUPPORTED/);
  }
  // 已经存下来的旧读取结果带着推定的最低计费重量和 legacy_unverified，照旧不能用。
  const current = await readCurrentGuooTariff(guooReadOptions());
  const stored = { ...structuredClone(current.evidenceData), minimumChargeableWeightKg: 0.001, calculationRuleStatus: "legacy_unverified" };
  assert.equal(validateLifecycleEvidenceData("logistics_tariff", stored).valid, false);
  assert.deepEqual(validateLifecycleEvidenceData("logistics_tariff", stored).errors.map(item => item.path), ["calculationRuleStatus"]);
});

test("CBR reader returns current official RUB/CNY and stops on another pair", async () => {
  const xml = `<?xml version="1.0"?><ValCurs Date="18.08.2026"><Valute ID="R01375"><Nominal>1</Nominal><Value>12,3456</Value></Valute></ValCurs>`;
  const result = await readCurrentCbrExchangeRate({
    scope: { pair: "RUB/CNY" },
    fetchImpl: async () => httpJson(xml),
    now: fixedNow,
  });
  assert.equal(result.evidenceData.rubPerCny, 12.3456);
  assert.equal(result.evidenceData.rateDate, "2026-08-18");
  assert.equal(result.validity.expiryBasis, "internal_refresh_hint");
  await assert.rejects(() => readCurrentCbrExchangeRate({
    scope: { pair: "USD/CNY" },
    fetchImpl: async () => { throw new Error("must not call"); },
  }), /CBR_FX_PAIR_UNSUPPORTED/);
});

test("real provider registry preserves commission source without embedding SKU costs", async () => {
  const calls = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173",
    now: fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options?.body || null });
      if (url.startsWith("http://127.0.0.1:4173")) return httpJson({
        ok: true,
        evidence: {
          current: true,
          scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon:17028665:92935", salesScheme: "rfbs" },
          sourceType: "ozon_seller_api_same_type_commission",
          sourceRef: "ozon-seller-api:/v5/product/info/prices:17028665:92935:rfbs",
          checkedAt: "2026-08-18T08:00:00.000Z",
          expiresAt: "2026-08-19T08:00:00.000Z",
          evidenceData: { commissionRate: 0.14 },
        },
      });
      throw new Error(`unexpected ${url}`);
    },
  });
  const pack = await registry.commission(request("commission", {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "ozon:17028665:92935",
    salesScheme: "rfbs",
  }));
  assert.equal(pack.evidenceData.commissionRate, 0.14);
  assert.equal(Object.hasOwn(pack.evidenceData, "otherCosts"), false);
  assert.equal(pack.sourceType, "ozon_seller_api_same_type_commission");
  assert.equal(pack.sourceRef, "ozon-seller-api:/v5/product/info/prices:17028665:92935:rfbs");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).match(/Api-Key|token|cookie/i), null);
});

test("owner-authorized estimate resolves the exact category once after explicit exact unavailability", async () => {
  const calls = [];
  const estimateScope = { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon-competitor:4403916892", salesScheme: "rfbs" };
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173",
    commissionEstimate: {
      authorized: true,
      confirmedBy: "owner",
      commissionRate: 0.2,
      authorizationRef: "owner-a-confirmation:commission-estimate:TEST-001",
      candidateId: "TEST-001", candidateRevision: 1, scope: estimateScope,
    },
    now: fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (calls.at(-1).body.kind === "commission") return httpJson({ ok: true, evidence: {
        status: "data_unavailable", current: false, reasonCode: "exact_commission_unavailable", scope: estimateScope,
        sourceType: "synthetic", sourceRef: "source:commission-unavailable", checkedAt: fixedNow().toISOString(), evidenceData: {}
      } });
      return httpJson({
        ok: true,
        evidence: {
          current: true,
          scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon-competitor:4403916892", ruleVersion: "ozon-current" },
          sourceType: "ozon_seller_api_current_schema",
          sourceRef: "ozon-seller-api:/v1/description-category/attribute:17030000:90000",
          checkedAt: "2026-08-18T08:00:00.000Z",
          expiresAt: "2026-08-19T08:00:00.000Z",
          evidenceData: {
            schemaRevision: "ozon-schema-test",
            requiredFields: [],
            descriptionCategoryId: 17030000,
            typeId: 90000,
          },
        },
      });
    },
  });
  const commission = await registry.commission(request("commission", {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "ozon-competitor:4403916892",
    salesScheme: "rfbs",
  }));
  const schema = await registry.schema(request("schema", {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "ozon-competitor:4403916892",
    ruleVersion: "ozon-current",
  }));
  assert.equal(commission.evidenceData.commissionRate, 0.2);
  assert.equal(commission.evidenceData.commissionEvidenceMode, "estimated");
  assert.equal(Object.hasOwn(commission.evidenceData, "otherCosts"), false);
  assert.equal(commission.evidenceData.estimateAuthorized, true);
  assert.deepEqual(commission.evidenceData.commissionEstimateAuthorization, {
    schemaVersion: "commission-estimate-authorization-v1", candidateId: "TEST-001", candidateRevision: 1,
    authorizationRef: "owner-a-confirmation:commission-estimate:TEST-001", commissionRate: 0.2,
  });
  assert.equal(commission.evidenceData.exactCommissionRequiredAtC, true);
  assert.equal(commission.evidenceData.descriptionCategoryId, 17030000);
  assert.equal(schema.evidenceData.typeId, 90000);
  assert.equal(calls.length, 2, "one exact query and one cached schema query");
  assert.deepEqual(calls.map(value => value.body.kind), ["commission", "schema"]);
});

test("commission estimate is rejected without an exact owner authorization", () => {
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({
    commissionEstimate: { authorized: false, commissionRate: 0.2 },
  }), /B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED/);
});

test("real provider registry rejects misplaced legacy SKU costs", () => {
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({ otherCosts: {} }), /B_EVIDENCE_COST_POLICY_MISPLACED/);
});

test("估算佣金关联的Schema必须同平台、完整店铺与类目，读取前拒绝错绑", async () => {
  const scope = { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "shelf", salesScheme: "rfbs" };
  for (const change of [
    value => { value.platform = "wb"; }, value => { value.store = "miska"; value.storeRef.stableStoreId = "miska"; },
    value => { value.storeRef.platformStoreId = "another"; }, value => { value.storeRef.mappingVersion = "another"; },
    value => { value.category = "another"; }, value => { value.kind = "commission"; }
  ]) {
    let calls = 0;
    const input = request("commission", structuredClone(scope)); change(input.relatedSchemaScope);
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173",
      commissionEstimate: { authorized: true, confirmedBy: "owner", commissionRate: 0.2, authorizationRef: "owner-estimate:synthetic" },
      fetchImpl: async () => { calls += 1; throw new Error("must not read"); } });
    await assert.rejects(() => registry.commission(input), /SCOPE_INVALID/);
    assert.equal(calls, 0);
  }
});

test('explicit connector failure cannot be relabelled as exact commission evidence', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  for (const status of ['system_error', 'permission_required', 'unknown', 'success']) {
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      fetchImpl: async () => httpJson({ ok: true, evidence: { status, current: true, scope, sourceType: 'synthetic', sourceRef: 'source:synthetic',
        checkedAt: fixedNow().toISOString(), expiresAt: '2026-08-19T08:00:00.000Z', evidenceData: { commissionRate: 0.14 } } }) });
    await assert.rejects(registry.commission(request('commission', scope)), /OZON_LOCAL_EVIDENCE_STATUS_INVALID/);
  }
});

test('valid exact commission wins over an optional estimate without a schema call', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  const calls = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    commissionEstimate: { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic', effectiveFrom: '2026-08-16T08:00:00.000Z', effectiveTo: '2026-08-17T08:00:00.000Z' },
    fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body).kind);return httpJson({ ok: true, evidence: {
      current: true, scope, sourceType: 'synthetic', sourceRef: 'source:synthetic', checkedAt: fixedNow().toISOString(),
      expiresAt: '2026-08-19T08:00:00.000Z', evidenceData: { commissionRate: 0.14 } } }); } });
  const pack = await registry.commission(request('commission', scope));
  assert.equal(pack.evidenceData.commissionRate, 0.14); assert.equal(pack.evidenceData.commissionEvidenceMode, 'exact');
  assert.deepEqual(calls, ['commission']);
});


test('only an exact unavailable receipt and matching estimate scope permit conditional evidence', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  const unavailable = { status: 'data_unavailable', current: false, reasonCode: 'exact_commission_unavailable', scope,
    sourceType: 'synthetic', sourceRef: 'source:unavailable', checkedAt: fixedNow().toISOString(), evidenceData: {} };
  const estimate = { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic',
    candidateId: 'TEST-001', candidateRevision: 1, scope };
  for (const mutate of [
    value => { value.evidence.current = true; },
    value => { value.evidence.reasonCode = 'system_error'; },
    value => { value.evidence.evidenceData.commissionRate = 0.1; },
    value => { value.evidence.checkedAt = '2026-08-17T08:00:00.000Z'; },
    value => { value.evidence.scope.category = 'other'; },
    value => { value.estimate.candidateId = 'OTHER'; },
    value => { value.estimate.candidateRevision = 2; },
    value => { value.estimate.scope.category = 'other'; },
    value => { delete value.estimate.scope; },
    value => { value.estimate.effectiveFrom = '2026-08-16T08:00:00.000Z'; value.estimate.effectiveTo = '2026-08-17T08:00:00.000Z'; }
  ]) {
    const values = { evidence: structuredClone(unavailable), estimate: structuredClone(estimate) }; mutate(values); const calls = [];
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      commissionEstimate: values.estimate, fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body).kind); return httpJson({ ok: true, evidence: values.evidence }); } });
    await assert.rejects(registry.commission(request('commission', scope)), /UNAVAILABLE_INVALID|STORE_SCOPE_UNPROVEN|ESTIMATE_NOT_AUTHORIZED|ESTIMATE_EXPIRED/);
    assert.deepEqual(calls, ['commission']);
  }
});

test('bad JSON network failure and missing permission never trigger the estimate path', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  for (const response of [async () => { throw new Error('synthetic network failure'); }, async () => ({ ok: true, text: async () => '{' }),
    async () => httpJson({ ok: false }, 403)]) {
    const calls = [];
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      commissionEstimate: { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic', candidateId: 'TEST-001', candidateRevision: 1, scope },
      fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body).kind); return response(); } });
    await assert.rejects(registry.commission(request('commission', scope)), /synthetic network failure|INVALID_JSON|EVIDENCE_FAILED/);
    assert.deepEqual(calls, ['commission']);
  }
});


test('residual estimate fields and stale exact receipts are rejected, never cleared into exact', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  for (const mutate of [value => { value.evidenceData.estimateAuthorized = true; },
    value => { value.evidenceData.commissionEvidenceMode = 'estimated'; },
    value => { value.evidenceData.exactCommissionRequiredAtC = true; },
    value => { value.expiresAt = '2026-08-17T08:00:00.000Z'; }]) {
    const evidence = { current: true, scope, sourceType: 'synthetic', sourceRef: 'source:synthetic', checkedAt: fixedNow().toISOString(),
      expiresAt: '2026-08-19T08:00:00.000Z', evidenceData: { commissionRate: 0.14 } }; mutate(evidence);
    let calls = 0;
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      fetchImpl: async () => { calls++; return httpJson({ ok: true, evidence }); } });
    await assert.rejects(registry.commission(request('commission', scope)), /B_EVIDENCE_COMMISSION_INVALID/);
    assert.equal(calls, 1);
  }
});


test('WB commission lookup uses only explicit subject identity and current local version, never the Ozon connector', async () => {
  let network = 0, versions = 0;
  let versionStatus = 'active';
  const readers = createLifecycleBRealEvidenceReaders({ozonServiceUrl:'http://127.0.0.1:4173',
    now:()=>new Date('2026-09-09T06:00:00.000Z'),fetchImpl:async()=>{network++;throw new Error('NO_NETWORK_ALLOWED');},
    wbCommissionReference:{catalogPath:fileURLToPath(new URL('../data/commissions/wb-china-2026-09-09.json',import.meta.url)),
      sourcePath:fileURLToPath(new URL('../data/commissions/wb-china-2026-09-09.source.json',import.meta.url)),sellerRegion:'CN',
      readVersionState:async()=>{versions++;return {catalogId:'wb-china-commission',catalogVersion:'2026-09-09T05:02:34.628109Z',status:versionStatus};}}});
  const scope={platform:'wb',store:'wb',storeRef:{stableStoreId:'wb',platformStoreId:'platform:wb-synthetic',mappingVersion:'mapping:synthetic'},category:'wb:subject:5267',salesScheme:'synthetic-wb-scheme'};
  for(const category of ['镜子','5267','ozon:17030000:5267','wb:subject:9007199254740992']) {
    await assert.rejects(readers.commission({scope:{...scope,category}}),/B_EVIDENCE_WB_SUBJECT_ID_REQUIRED/);
  }
  assert.equal(versions,0);
  await assert.rejects(readers.commission({scope}),error=>{
    assert.equal(error.code,'B_EVIDENCE_WB_COMMISSION_NOT_FORMAL');
    assert.equal(error.reference.status,'matched_with_gaps');assert.equal(error.reference.commissionRate,0.2);
    assert.equal(error.reference.formalApplicability,false);assert.equal(error.reference.source.effectiveTo,null);return true;
  });
  versionStatus='invalidated';
  await assert.rejects(readers.commission({scope}),error=>{
    assert.equal(error.reference.status,'invalidated');assert.equal(error.reference.commissionRate,null);return true;
  });
  await assert.rejects(readers.commission({scope:{...scope,platform:'WB'}}), /B_EVIDENCE_WB_COMMISSION_NOT_FORMAL/);
  await assert.rejects(readers.commission({scope:{...scope,platform:'other'}}), /B_EVIDENCE_COMMISSION_PLATFORM_UNSUPPORTED/);
  assert.equal(versions,3);assert.equal(network,0);
});


test('current exact source cannot smuggle SKU costs into a reusable commission pack', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  let calls = 0;
  const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    fetchImpl: async () => { calls++; return httpJson({ ok: true, evidence: {
      current: true, scope, sourceType: 'ozon_seller_api_same_type_commission', sourceRef: 'source:synthetic-official',
      checkedAt: fixedNow().toISOString(), expiresAt: '2026-08-19T08:00:00.000Z',
      evidenceData: { commissionRate: 0.14, otherCosts: { packagingRmb: 1 } }
    } }); }
  });
  await assert.rejects(registry.commission(request('commission', scope)), /B_EVIDENCE_COMMISSION_COSTS_UNEXPECTED/);
  assert.equal(calls, 1);
});

const OFFICIAL_SCOPE = { platform: 'ozon', store: 'dandanshu', storeRef: SYNTHETIC_STORE_REF, category: 'ozon:17030000:90000', salesScheme: 'rfbs' };
const OFFICIAL_SHA = 'a'.repeat(64);

function officialCommissionScope() {
  return { ...structuredClone(OFFICIAL_SCOPE), storeRef: structuredClone(SYNTHETIC_STORE_REF) };
}

function officialReferenceConfiguration() {
  return { catalogPath: '/owner/ozon-official-commission.json', sellerRegion: 'CN',
    versionState: { fileSha256: OFFICIAL_SHA, effectiveFrom: '2026-08-01', status: 'active' } };
}

function officialReferenceRead(overrides = {}) {
  return {
    schemaVersion: 'ozon-commission-reference-read-v1', platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs',
    priceRub: 2490, priceTier: '1500_5000', commissionRate: 0.155,
    matchedRows: [{ row: 4210, typeRu: 'Лежанки для животных', typeZh: '宠物躺床', typeEn: 'Pet beds',
      category3Zh: '猫咪用品', mpCategoryZh: '宠物用品', brand: 'All' }],
    source: { sourceUrl: 'https://docs.ozon.ru/common/pravila-raboty/komissii/', sourcePage: 'Full ChinaHK',
      effectiveFrom: '2026-08-01', fileSha256: OFFICIAL_SHA, fileLastModified: '2026-07-30T10:00:00.000Z',
      downloadedAt: '2026-08-02T09:00:00.000Z', catalogSchemaVersion: 'ozon-official-commission-reference-v1' },
    versionState: { fileSha256: OFFICIAL_SHA, effectiveFrom: '2026-08-01', status: 'active' },
    checkedAt: fixedNow().toISOString(), gaps: [], ...overrides
  };
}

function officialEvidenceService(scope, calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.kind);
    if (body.kind === 'commission') {
      return httpJson({ ok: true, evidence: { status: 'data_unavailable', current: false, reasonCode: 'exact_commission_unavailable',
        scope, sourceType: 'ozon_seller_api_current_products', sourceRef: 'ozon-seller-api:/v3/product/info/list:no-listed-product',
        checkedAt: fixedNow().toISOString(), evidenceData: {} } });
    }
    return httpJson({ ok: true, evidence: { current: true,
      scope: { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: scope.category, ruleVersion: 'ozon-current' },
      sourceType: 'ozon_seller_api_current_schema', sourceRef: 'ozon-seller-api:/v1/description-category/attribute:17030000:90000',
      checkedAt: fixedNow().toISOString(), expiresAt: '2026-08-19T08:00:00.000Z',
      evidenceData: { schemaRevision: 'ozon-schema-test', requiredFields: [], descriptionCategoryId: 17030000, typeId: 90000 } } });
  };
}

function officialCommissionRequest(scope, commissionReferenceScope) {
  return { ...request('commission', scope), commissionReferenceScope };
}

test('店铺没有同类目在售商品时，按已保存的官方佣金表版本成交并留下版本引用', async () => {
  const scope = officialCommissionScope();
  const calls = [];
  const observed = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    ozonCommissionReference: officialReferenceConfiguration(),
    readOzonCommissionReferenceImpl: async (input) => { observed.push(structuredClone(input)); return officialReferenceRead(); },
    fetchImpl: officialEvidenceService(scope, calls)
  });
  const pack = await registry.commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  assert.deepEqual(calls, ['commission', 'schema']);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].catalogPath, '/owner/ozon-official-commission.json');
  assert.equal(observed[0].asOf, '2026-08-18T08:00:00.000Z');
  assert.deepEqual(observed[0].versionState, { fileSha256: OFFICIAL_SHA, effectiveFrom: '2026-08-01', status: 'active' });
  assert.deepEqual(observed[0].scope, { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', priceRub: 2490, typeIdentity: { typeZh: '宠物躺床' } });
  assert.equal(pack.sourceType, 'ozon_official_commission_table');
  assert.equal(pack.sourceRef, `ozon-official-commission:2026-08-01:sha256:${OFFICIAL_SHA}:1500_5000`);
  assert.equal(pack.checkedAt, '2026-08-18T08:00:00.000Z');
  assert.equal(pack.expiresAt, '2026-08-19T08:00:00.000Z');
  assert.equal(pack.validity.expiryBasis, 'internal_refresh_hint');
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: '2026-09-21T00:00:00.000Z' }).status, 'refresh_due');
  assert.deepEqual(pack.commissionCatalogRef, { effectiveFrom: '2026-08-01', fileSha256: OFFICIAL_SHA,
    sourceUrl: 'https://docs.ozon.ru/common/pravila-raboty/komissii/', priceTier: '1500_5000',
    matchedRow: { typeRu: 'Лежанки для животных', typeZh: '宠物躺床', mpCategoryZh: '宠物用品' } });
  assert.deepEqual(pack.evidenceData, { commissionRate: 0.155, commissionEvidenceMode: 'official_reference',
    officialCommissionBinding: { schemaVersion: 'ozon-official-commission-binding-v1', candidateId: 'TEST-001', candidateRevision: 1, priceRub: 2490 },
    estimateAuthorized: false, exactCommissionRequiredAtC: true, descriptionCategoryId: 17030000, typeId: 90000 });
});

test('官方费表按俄语类型名称和成交价档查询，缺少价格或类型名称时只记缺口不猜测', async () => {
  const scope = officialCommissionScope();
  const cases = [
    { inputs: { priceRub: 990, typeName: 'Лежанки для животных' }, expected: { priceRub: 990, typeIdentity: { typeRu: 'Лежанки для животных' } } },
    { inputs: { priceRub: 6100, typeName: 'Pet beds' }, expected: { priceRub: 6100, typeIdentity: { typeEn: 'Pet beds' } } }
  ];
  for (const item of cases) {
    const observed = [];
    const registry = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(),
      readOzonCommissionReferenceImpl: async (input) => { observed.push(structuredClone(input)); return officialReferenceRead(); },
      fetchImpl: officialEvidenceService(scope, [])
    });
    await registry.commission(officialCommissionRequest(scope, item.inputs));
    assert.equal(observed[0].scope.priceRub, item.expected.priceRub);
    assert.deepEqual(observed[0].scope.typeIdentity, item.expected.typeIdentity);
  }
  for (const inputs of [null, { priceRub: 2490, typeName: '  ' }, { priceRub: 0, typeName: '宠物躺床' }, { typeName: '宠物躺床' }]) {
    let called = 0;
    const registry = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(),
      readOzonCommissionReferenceImpl: async () => { called += 1; return officialReferenceRead(); },
      fetchImpl: officialEvidenceService(scope, [])
    });
    await assert.rejects(registry.commission(officialCommissionRequest(scope, inputs)),
      /OFFICIAL_TABLE_PRICE_MISSING|OFFICIAL_TABLE_TYPE_IDENTITY_MISSING/);
    assert.equal(called, 0, '缺少每SKU输入时不读本地费表');
  }
});

test('官方费表有阻断缺口或读取失败时，原样回到主人授权估算路径并说明缺口', async () => {
  const scope = officialCommissionScope();
  const estimate = { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic',
    candidateId: 'TEST-001', candidateRevision: 1, scope: officialCommissionScope() };
  const readers = [
    async () => officialReferenceRead({ commissionRate: null, matchedRows: [], gaps: [{ code: 'TYPE_NOT_FOUND', field: 'scope.typeIdentity', blocking: true }] }),
    async () => officialReferenceRead({ commissionRate: null, gaps: [{ code: 'CATALOG_VERSION_MISMATCH', field: 'versionState', blocking: true }] }),
    async () => { throw Object.assign(new Error('OZON_COMMISSION_REFERENCE_CATALOG_UNREADABLE'), { code: 'CATALOG_UNREADABLE' }); }
  ];
  const withoutReference = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    commissionEstimate: estimate, fetchImpl: officialEvidenceService(scope, []) })
    .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  for (const readOzonCommissionReferenceImpl of readers) {
    const fallback = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(), readOzonCommissionReferenceImpl, commissionEstimate: estimate,
      fetchImpl: officialEvidenceService(scope, []) })
      .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
    assert.deepEqual(fallback, withoutReference, '有缺口时估算证据必须与未配置费表时完全一致');
    assert.equal(fallback.evidenceData.commissionEvidenceMode, 'estimated');
  }
  for (const [readOzonCommissionReferenceImpl, expected] of [[readers[0], /TYPE_NOT_FOUND/], [readers[2], /OFFICIAL_TABLE_CATALOG_UNREADABLE/]]) {
    await assert.rejects(createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(), readOzonCommissionReferenceImpl,
      fetchImpl: officialEvidenceService(scope, []) })
      .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' })), expected);
  }
});

test('未配置官方费表时佣金路径完全不变，也不读本地费表', async () => {
  const scope = officialCommissionScope();
  let called = 0;
  const calls = [];
  const estimate = { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic',
    candidateId: 'TEST-001', candidateRevision: 1, scope: officialCommissionScope() };
  const pack = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    commissionEstimate: estimate, readOzonCommissionReferenceImpl: async () => { called += 1; return officialReferenceRead(); },
    fetchImpl: officialEvidenceService(scope, calls) })
    .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  assert.equal(called, 0);
  assert.deepEqual(calls, ['commission', 'schema']);
  assert.equal(pack.sourceType, 'owner_authorized_commission_estimate');
  assert.equal(pack.evidenceData.commissionEvidenceMode, 'estimated');
  assert.equal(Object.hasOwn(pack, 'commissionCatalogRef'), false);
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173',
    ozonCommissionReference: { catalogPath: '/owner/ozon.json', sellerRegion: 'RU' } }),
    /B_EVIDENCE_OZON_COMMISSION_REFERENCE_INVALID/);
});

test('证据服务失败时那句已脱敏的原话原样上来，并带上机器可读的那一份', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: SYNTHETIC_STORE_REF, category: 'shelf', ruleVersion: 'v1' };
  const readersFor = body => createLifecycleBRealEvidenceReaders({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    fetchImpl: async () => httpJson(body, 500) });

  // 2026-09-14 现场那一次：Miska 店在这条类目的第一件商品，读不到同类商品的真实佣金。
  const remote = 'OZON_EVIDENCE_COMMISSION_UNAVAILABLE: 店铺当前没有同 description category 和 type 的商品可读取 RFBS 佣金';
  const failure = await readersFor({ ok: false, error: remote }).schema(request('schema', scope)).then(
    () => { throw new Error('MUST_REJECT'); }, error => error);
  // 状态码还在，原话也在：只说 HTTP 500 会让主人一直重试一件重试多少次都一样的事。
  assert.equal(failure.message, `OZON_LOCAL_EVIDENCE_FAILED: HTTP 500: ${remote}`);
  assert.equal(failure.code, 'OZON_LOCAL_EVIDENCE_FAILED');
  assert.equal(failure.httpStatus, 500);
  assert.equal(failure.remoteError, remote);
  assert.equal(failure.remoteCode, 'OZON_EVIDENCE_COMMISSION_UNAVAILABLE');
  assert.equal(failure.exactCommissionUnavailable, true);
  // 上层认的是这个标记，不是那句中文：中文换了，判断照旧。
  const chinese = await readersFor({ ok: false, error: 'OZON_EVIDENCE_COMMISSION_UNAVAILABLE: 完全换一句说法' })
    .schema(request('schema', scope)).then(() => { throw new Error('MUST_REJECT'); }, error => error);
  assert.equal(chinese.exactCommissionUnavailable, true);

  // 别的失败不能被认成这一类。
  const other = await readersFor({ ok: false, error: 'OZON_EVIDENCE_STORE_UNAUTHORIZED: 本机凭据已过期' })
    .schema(request('schema', scope)).then(() => { throw new Error('MUST_REJECT'); }, error => error);
  assert.equal(other.message, 'OZON_LOCAL_EVIDENCE_FAILED: HTTP 500: OZON_EVIDENCE_STORE_UNAUTHORIZED: 本机凭据已过期');
  assert.equal(other.remoteCode, 'OZON_EVIDENCE_STORE_UNAUTHORIZED');
  assert.equal(other.exactCommissionUnavailable, false);

  // error 缺失、不是字符串、或者空白：只报状态码，不在这里抛第二个异常。
  for (const body of [{ ok: false }, { ok: false, error: null }, { ok: false, error: { code: 'X' } },
    { ok: false, error: ['X'] }, { ok: false, error: 7 }, { ok: false, error: '   ' }]) {
    const bare = await readersFor(body).schema(request('schema', scope))
      .then(() => { throw new Error('MUST_REJECT'); }, error => error);
    assert.equal(bare.message, 'OZON_LOCAL_EVIDENCE_FAILED: HTTP 500', JSON.stringify(body));
    assert.equal(bare.remoteError, null);
    assert.equal(bare.remoteCode, null);
    assert.equal(bare.exactCommissionUnavailable, false);
  }

  // 超长的一句也不会把整份错误撑爆；带着的还是那个机器可读的码。
  const long = await readersFor({ ok: false, error: `OZON_EVIDENCE_COMMISSION_UNAVAILABLE: ${'长'.repeat(4000)}` })
    .schema(request('schema', scope)).then(() => { throw new Error('MUST_REJECT'); }, error => error);
  assert.equal(long.remoteError.length, 500);
  assert.equal(long.exactCommissionUnavailable, true);

  // 回体里没有 evidence、或者 ok 不是 true，也走同一条路：状态码 200 也照样是失败。
  const notOk = await createLifecycleBRealEvidenceReaders({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    fetchImpl: async () => httpJson({ ok: false, error: 'OZON_EVIDENCE_SCHEMA_UNREADABLE: 读不到类目字段' }, 200) })
    .schema(request('schema', scope)).then(() => { throw new Error('MUST_REJECT'); }, error => error);
  assert.equal(notOk.message, 'OZON_LOCAL_EVIDENCE_FAILED: HTTP 200: OZON_EVIDENCE_SCHEMA_UNREADABLE: 读不到类目字段');
});

test('证据服务修好之后（200 + data_unavailable），缺授权时抛的那一句页面认得出来，官方费表的缺口也带得上来', async () => {
  // 证据服务改好之后，「店里没有同类目商品」不再是 HTTP 500，OZON_EVIDENCE_COMMISSION_UNAVAILABLE 这个码在这条
  // 路径上再也不出现。页面从此只能靠这里抛的这一句判断「现在就差主人授权」——这个测试把那一句和页面的判断钉在一起，
  // 谁改了这边的码，这里立刻红。
  const scope = officialCommissionScope();
  const calls = [];
  const fail = async (extra) => createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173',
    now: fixedNow, fetchImpl: officialEvidenceService(scope, calls), ...extra })
    .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }))
    .then(() => { throw new Error('MUST_REJECT'); }, (error) => error);

  // 一、这台机器上没配官方费表：只有「缺授权」那一句，没有缺口可说，页面也就不说那一句。
  const bare = await fail({});
  assert.match(bare.message, /B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED: 缺少当前候选、revision和精确范围的单次估算授权/u);
  assert.doesNotMatch(bare.message, /OZON_EVIDENCE_COMMISSION_UNAVAILABLE/u, '修好之后旧码确实不在这条路上了');
  assert.equal(exactCommissionUnavailable(bare), true, '页面靠这个判断决定摆不摆出授权块');
  assert.deepEqual(officialCommissionTableGaps(bare), []);

  // 二、配了官方费表但它有阻断缺口：同一句话后面接上缺口，页面把那几处逐字显示给主人。
  const gapped = await fail({ ozonCommissionReference: officialReferenceConfiguration(),
    readOzonCommissionReferenceImpl: async () => officialReferenceRead({ commissionRate: null, matchedRows: [],
      gaps: [{ code: 'TYPE_NOT_FOUND', field: 'scope.typeIdentity', blocking: true },
        { code: 'CATALOG_VERSION_MISMATCH', field: 'versionState', blocking: true }] }) });
  assert.equal(exactCommissionUnavailable(gapped), true);
  assert.deepEqual(officialCommissionTableGaps(gapped), ['TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH']);

  // 三、官方费表读取本身抛了异常：缺口是 OFFICIAL_TABLE_ 前缀那一个，也照样带上来。
  const unreadable = await fail({ ozonCommissionReference: officialReferenceConfiguration(),
    readOzonCommissionReferenceImpl: async () => { throw Object.assign(new Error('x'), { code: 'CATALOG_UNREADABLE' }); } });
  assert.deepEqual(officialCommissionTableGaps(unreadable), ['OFFICIAL_TABLE_CATALOG_UNREADABLE']);

  // 四、官方费表自己成交了：直接返回真证据，主人根本不需要授权，那一块也就没有机会出现。
  const pack = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    fetchImpl: officialEvidenceService(scope, calls), ozonCommissionReference: officialReferenceConfiguration(),
    readOzonCommissionReferenceImpl: async () => officialReferenceRead() })
    .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  assert.equal(pack.evidenceData.commissionEvidenceMode, 'official_reference');
  assert.equal(pack.evidenceData.estimateAuthorized, false);
});


test("Schema连接器的已核实缓存形状由本地适配器声明，远端不能自授有效期", async () => {
  const scope = { ...officialCommissionScope(), ruleVersion: "ozon-current" }; delete scope.salesScheme;
  const response = { current: true, scope, sourceType: "ozon_seller_api_current_schema",
    sourceRef: "ozon-seller-api:/v1/description-category/attribute:17030000:90000",
    checkedAt: fixedNow().toISOString(), expiresAt: "2026-08-19T08:00:00.000Z",
    evidenceData: { descriptionCategoryId: 17030000, typeId: 90000, schemaRevision: `ozon-schema-${"a".repeat(20)}`, requiredFields: [], attributes: [] } };
  const read = async (value) => {
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173", now: fixedNow,
      fetchImpl: async () => httpJson({ ok: true, evidence: value }) });
    return registry.schema(request("schema", scope));
  };
  const pack = await read(response);
  assert.equal(pack.validity.expiryBasis, "internal_refresh_hint");
  assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: "2026-09-21T00:00:00.000Z" }).status, "refresh_due");
  await assert.rejects(() => read({ ...response, validity: pack.validity }), /REMOTE_VALIDITY_UNSUPPORTED/);
  const unknown = await read({ ...response, sourceType: "another_source" });
  assert.equal(Object.hasOwn(unknown, "validity"), false);
  assert.equal(inspectLifecycleEvidenceValidity(unknown, { asOf: "2026-09-21T00:00:00.000Z" }).status, "expired");
});

test("官方费表明确来源期限不被24小时缓存解释覆盖", async () => {
  const scope = officialCommissionScope();
  for (const sourceExpiresAt of ["2026-08-18T12:00:00.000Z", "2026-08-19T08:00:00.000Z", "2026-10-01T00:00:00.000Z"]) {
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173", now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(),
      readOzonCommissionReferenceImpl: async () => officialReferenceRead({ expiresAt: sourceExpiresAt }),
      fetchImpl: officialEvidenceService(scope, []) });
    const pack = await registry.commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: "宠物躺床" }));
    assert.equal(pack.validity.expiryBasis, "source_declared_limit");
    assert.equal(pack.validity.sourceExpiresAt, sourceExpiresAt);
    assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: sourceExpiresAt }).status, "expired");
    assert.equal(inspectLifecycleEvidenceValidity(pack, { asOf: "2026-09-21T00:00:00.000Z" }).usable, sourceExpiresAt.startsWith("2026-10"));
  }
});
